/**
 * Installs an extracted release onto the headset over wireless ADB:
 * every top-level APK with `-r -g`, then the OBB folder to
 * /sdcard/Android/obb/<package>/. Releases that ship an install.txt have
 * their adb commands replayed instead (install / push / shell / uninstall).
 */
import { SIGNATURE_MISMATCH_ERROR_PREFIX } from '@shared/types'
import {
  basename,
  dirname,
  joinPath,
  newTaskId,
  onTaskProgress,
  VrcdNative,
  type FsEntry
} from './native'

export type InstallProgress = (step: string, percent?: number) => void
export type InstallResult = { ok: true } | { ok: false; error: string }

function friendlyInstallError(message: string, packageName: string): string {
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(message)) {
    return `${SIGNATURE_MISMATCH_ERROR_PREFIX}: ${packageName} is already installed and was signed with a different certificate than this build. Uninstalling it will erase its save data/settings before the update can be installed.`
  }
  return message.slice(0, 300)
}

async function installApk(
  serial: string,
  apkPath: string,
  onProgress: InstallProgress,
  label: string
): Promise<void> {
  const taskId = newTaskId('apk')
  const off = onTaskProgress(taskId, (e) => {
    if (e.total > 0) onProgress(label, Math.round((e.transferred / e.total) * 100))
  })
  try {
    const res = await VrcdNative.adbInstall({ serial, apkPath, options: ['-r', '-g'], taskId })
    if (!res.success) throw new Error(res.message || 'Install failed')
  } finally {
    off()
  }
}

async function push(
  serial: string,
  localPath: string,
  remotePath: string,
  onProgress: InstallProgress,
  label: string
): Promise<void> {
  const taskId = newTaskId('push')
  const off = onTaskProgress(taskId, (e) => {
    if (e.total > 0) onProgress(label, Math.round((e.transferred / e.total) * 100))
  })
  try {
    await VrcdNative.adbPush({ serial, localPath, remotePath, taskId })
  } finally {
    off()
  }
}

async function findObbDir(dir: string, packageName?: string): Promise<FsEntry | null> {
  const { entries } = await VrcdNative.fsList({ path: dir, recursive: true })
  const dirs = entries.filter((e) => e.isDir)
  if (packageName) {
    const exact = dirs.find((d) => d.name === packageName)
    if (exact) return exact
  }
  // Fall back to any folder that directly contains .obb files.
  const obbFile = entries.find((e) => !e.isDir && e.name.toLowerCase().endsWith('.obb'))
  if (!obbFile) return null
  const parent = dirname(obbFile.path)
  return dirs.find((d) => d.path === parent) ?? null
}

async function pushObb(serial: string, obb: FsEntry, onProgress: InstallProgress): Promise<void> {
  const remote = `/sdcard/Android/obb/${obb.name}`
  await VrcdNative.adbShell({ serial, command: `rm -rf "${remote}" && mkdir -p "${remote}"` })
  // Pushing a directory copies its contents into remotePath.
  await push(serial, obb.path, remote, onProgress, 'Pushing game data (OBB)…')
}

/** Splits a command line honouring double quotes. */
function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

async function runInstallScript(
  dir: string,
  scriptPath: string,
  serial: string,
  packageName: string,
  onProgress: InstallProgress
): Promise<InstallResult> {
  const { text } = await VrcdNative.fsReadText({ path: scriptPath })
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /^adb\b/i.test(l))
  for (let i = 0; i < lines.length; i++) {
    let args = tokenize(lines[i]).slice(1)
    // Drop device selectors; we always target the chosen headset.
    while (args[0] === '-s' || args[0] === '-d' || args[0] === '-e') {
      args = args.slice(args[0] === '-s' ? 2 : 1)
    }
    const [cmd, ...rest] = args
    const step = `Running install.txt · step ${i + 1}/${lines.length}`
    onProgress(step, Math.round((i / lines.length) * 100))
    const local = (p: string): string => (p.startsWith('/') ? p : joinPath(dir, p))
    try {
      if (cmd === 'install') {
        const apk = rest.filter((a) => !a.startsWith('-')).pop()
        if (!apk) throw new Error('install: missing APK path')
        await installApk(serial, local(apk), onProgress, step)
      } else if (cmd === 'push') {
        const paths = rest.filter((a) => !a.startsWith('-'))
        if (paths.length < 2) throw new Error('push: expected source and destination')
        await push(serial, local(paths[0]), paths[1], onProgress, step)
      } else if (cmd === 'shell') {
        await VrcdNative.adbShell({ serial, command: rest.join(' ') })
      } else if (cmd === 'uninstall') {
        await VrcdNative.adbShell({ serial, command: `pm uninstall ${rest.join(' ')}` })
      } else {
        console.warn(`[installer] skipping unsupported install.txt command: ${lines[i]}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (cmd === 'install' || cmd === 'push') {
        return { ok: false, error: friendlyInstallError(msg, packageName) }
      }
      console.warn(`[installer] non-critical step failed: ${lines[i]}: ${msg}`)
    }
  }
  return { ok: true }
}

export async function installRelease(
  dir: string,
  packageName: string,
  serial: string,
  onProgress: InstallProgress
): Promise<InstallResult> {
  try {
    onProgress('Preparing install…', 0)
    const { entries } = await VrcdNative.fsList({ path: dir })
    const script = entries.find((e) => !e.isDir && /^install\.txt$/i.test(e.name))
    if (script) return await runInstallScript(dir, script.path, serial, packageName, onProgress)

    const apks = entries.filter((e) => !e.isDir && e.name.toLowerCase().endsWith('.apk'))
    if (apks.length === 0) return { ok: false, error: 'No APK files found for standard install' }
    for (let i = 0; i < apks.length; i++) {
      const label =
        apks.length > 1
          ? `Installing ${apks[i].name} (${i + 1}/${apks.length})…`
          : `Installing ${apks[i].name}…`
      try {
        await installApk(serial, apks[i].path, onProgress, label)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          error: friendlyInstallError(`Failed to install ${apks[i].name}: ${msg}`, packageName)
        }
      }
    }
    const obb = await findObbDir(dir, packageName)
    if (obb) await pushObb(serial, obb, onProgress)
    onProgress('Finishing up…', 100)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: `Install error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export async function installSingleApk(
  apkPath: string,
  serial: string,
  onProgress: InstallProgress
): Promise<InstallResult> {
  try {
    await installApk(serial, apkPath, onProgress, `Installing ${basename(apkPath)}…`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // Picked files are copied into the cache; don't let them pile up.
    if (apkPath.includes('/cache/'))
      await VrcdNative.fsDelete({ path: apkPath }).catch(() => undefined)
  }
}
