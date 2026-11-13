/**
 * Download → extract → install pipeline for the Android build.
 *
 * Mirrors the desktop flow (src/main/services/download/*) using plain HTTP
 * instead of rclone: a release lives at <baseUri>/<md5(releaseName + "\n")>/
 * as split, password-protected 7z volumes.
 */
import type { AddToQueueResult, DownloadItem, DownloadStorageStatus, GameInfo } from '@shared/types'
import { emit, handle, on, onRaw } from './bus'
import { installRelease, installSingleApk } from './installer'
import { archivePassword, getGameByRelease, getServer, serverHeaders } from './games'
import { basename, joinPath, newTaskId, onTaskProgress, VrcdNative } from './native'
import { getSettings } from './settings'
import { load, save } from './store'

let queue: DownloadItem[] = load<DownloadItem[]>('downloadQueue', [])
const running = new Map<string, { taskIds: Set<string>; stop: 'pause' | 'cancel' | null }>()
let selectedDevice: string | null = null
let deviceConnected = false
let sideloadingDisabled = false

// ---------------------------------------------------------------------------
// Queue bookkeeping
// ---------------------------------------------------------------------------

let emitTimer: ReturnType<typeof setTimeout> | null = null
function emitUpdate(immediate = false): void {
  const flush = (): void => {
    emitTimer = null
    save('downloadQueue', queue)
    emit('download:queue-updated', queue)
  }
  if (immediate) {
    if (emitTimer) clearTimeout(emitTimer)
    flush()
  } else if (!emitTimer) {
    emitTimer = setTimeout(flush, 250)
  }
}

function find(releaseName: string): DownloadItem | undefined {
  return queue.find((i) => i.releaseName === releaseName)
}

function update(releaseName: string, patch: Partial<DownloadItem>, immediate = true): void {
  const item = find(releaseName)
  if (!item) return
  Object.assign(item, patch)
  emitUpdate(immediate)
}

function storageStatus(): DownloadStorageStatus {
  return { path: getSettings().downloadPath, state: 'available', error: null, code: null }
}

function itemPath(releaseName: string): string {
  return joinPath(getSettings().downloadPath, releaseName)
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function pump(): void {
  const max = getSettings().maxConcurrentDownloads || 1
  while (running.size < max) {
    const next = queue.find((i) => i.status === 'Queued' && !running.has(i.releaseName))
    if (!next) return
    void runPipeline(next.releaseName)
  }
}

class Stopped extends Error {}

function checkStop(releaseName: string): void {
  const ctl = running.get(releaseName)
  if (ctl?.stop) throw new Stopped(ctl.stop)
}

async function trackTask<T>(
  releaseName: string,
  prefix: string,
  run: (taskId: string) => Promise<T>,
  onProgress?: (transferred: number, total: number) => void
): Promise<T> {
  const ctl = running.get(releaseName)
  const taskId = newTaskId(prefix)
  ctl?.taskIds.add(taskId)
  const off = onTaskProgress(taskId, (e) => onProgress?.(e.transferred, e.total))
  try {
    return await run(taskId)
  } finally {
    off()
    ctl?.taskIds.delete(taskId)
  }
}

function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

function parseListing(html: string): string[] {
  const files = new Set<string>()
  const re = /href\s*=\s*"([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1]
    if (
      href.startsWith('?') ||
      href.startsWith('/') ||
      href.startsWith('..') ||
      href.includes('://')
    )
      continue
    if (href.endsWith('/')) continue
    files.add(decodeURIComponent(href.split('?')[0]))
  }
  return [...files]
}

async function downloadRelease(item: DownloadItem): Promise<void> {
  const server = getServer()
  if (!server) throw new Error('Missing server configuration')
  const dir = itemPath(item.releaseName)
  await VrcdNative.fsMkdir({ path: dir })

  const { hex } = await VrcdNative.md5({ text: `${item.releaseName}\n` })
  const base = `${server.baseUri}${hex}/`
  const headers = serverHeaders()
  const listing = await VrcdNative.httpGetText({ url: base, headers })
  if (listing.status === 403) throw new Error('Server refused the request (403)')
  if (listing.status >= 400) throw new Error(`Server returned HTTP ${listing.status}`)
  const files = parseListing(listing.body)
  if (files.length === 0) throw new Error('Server returned no files for this release')

  // Sizes up front so progress covers the whole release.
  const sizes = await Promise.all(
    files.map(async (f) => {
      try {
        return (await VrcdNative.httpHead({ url: base + encodeURIComponent(f), headers }))
          .contentLength
      } catch {
        return -1
      }
    })
  )
  const total = sizes.reduce((a, b) => a + Math.max(0, b), 0)

  const existing = new Map<string, number>()
  try {
    const { entries } = await VrcdNative.fsList({ path: dir })
    entries.forEach((e) => existing.set(e.name, e.size))
  } catch {
    // empty dir
  }

  let doneBytes = 0
  let windowStart = Date.now()
  let windowBytes = 0
  let speed = 0
  for (let i = 0; i < files.length; i++) {
    checkStop(item.releaseName)
    const name = files[i]
    if (sizes[i] > 0 && existing.get(name) === sizes[i]) {
      doneBytes += sizes[i]
      continue
    }
    let lastFileBytes = 0
    await trackTask(
      item.releaseName,
      'dl',
      (taskId) =>
        VrcdNative.httpDownload({
          taskId,
          url: base + encodeURIComponent(name),
          dest: joinPath(dir, name),
          headers
        }).then((r) => {
          if (r.status >= 400) throw new Error(`HTTP ${r.status} downloading ${name}`)
          return r
        }),
      (transferred) => {
        windowBytes += Math.max(0, transferred - lastFileBytes)
        lastFileBytes = transferred
        const now = Date.now()
        if (now - windowStart >= 1000) {
          speed = (windowBytes * 1000) / (now - windowStart)
          windowStart = now
          windowBytes = 0
        }
        const got = doneBytes + transferred
        const pct = total > 0 ? Math.min(99.9, (got / total) * 100) : 0
        update(
          item.releaseName,
          {
            progress: Math.round(pct * 10) / 10,
            speed: formatSpeed(speed),
            eta: speed > 0 && total > 0 ? formatEta((total - got) / speed) : ''
          },
          false
        )
      }
    )
    doneBytes += sizes[i] > 0 ? sizes[i] : lastFileBytes
  }
  update(item.releaseName, { progress: 100, speed: '', eta: '', downloadComplete: true })
}

async function extractRelease(item: DownloadItem): Promise<void> {
  const dir = itemPath(item.releaseName)
  const password = archivePassword()
  const { entries } = await VrcdNative.fsList({ path: dir })
  const first =
    entries.find((e) => /\.7z\.0*1$/i.test(e.name)) ?? entries.find((e) => /\.7z$/i.test(e.name))
  if (!first) throw new Error('No usable .7z.001 archive was found.')

  update(item.releaseName, { status: 'Extracting', extractProgress: 0 })
  await trackTask(
    item.releaseName,
    'x',
    (taskId) =>
      VrcdNative.extract7z({
        taskId,
        archive: first.path,
        destDir: dir,
        password,
        stripPrefix: `${item.releaseName}/`
      }),
    (done, total) => {
      if (total > 0)
        update(item.releaseName, { extractProgress: Math.round((done / total) * 100) }, false)
    }
  )

  // Remove the archive volumes now that the payload is out.
  const stem = first.name.replace(/\.7z(\.\d+)?$/i, '')
  for (const e of entries) {
    if (e.name.startsWith(stem) && /\.7z(\.\d+)?$/i.test(e.name)) {
      await VrcdNative.fsDelete({ path: e.path }).catch(() => undefined)
    }
  }

  // Some releases ship nested archives (e.g. _data.7z) next to the APK.
  const after = await VrcdNative.fsList({ path: dir })
  for (const nested of after.entries.filter((e) => !e.isDir && /\.7z$/i.test(e.name))) {
    try {
      await trackTask(item.releaseName, 'xn', (taskId) =>
        VrcdNative.extract7z({ taskId, archive: nested.path, destDir: dir, password })
      )
    } catch {
      await trackTask(item.releaseName, 'xn', (taskId) =>
        VrcdNative.extract7z({ taskId, archive: nested.path, destDir: dir })
      )
    }
    await VrcdNative.fsDelete({ path: nested.path }).catch(() => undefined)
  }
  update(item.releaseName, { extractProgress: 100 })
}

async function install(releaseName: string, deviceId: string): Promise<boolean> {
  const item = find(releaseName)
  if (!item) return false
  update(releaseName, { status: 'Installing', progress: 0, error: undefined })
  const result = await installRelease(
    itemPath(releaseName),
    item.packageName,
    deviceId,
    (step, pct) => {
      emit('manual-install:progress', { step, percent: pct })
      if (pct !== undefined) update(releaseName, { progress: pct }, false)
    }
  )
  if (result.ok) {
    update(releaseName, { status: 'Completed', progress: 100, error: undefined })
    emit('adb:installation-completed', deviceId)
    return true
  }
  update(releaseName, { status: 'InstallError', progress: 100, error: result.error })
  return false
}

async function runPipeline(releaseName: string): Promise<void> {
  const item = find(releaseName)
  if (!item) return
  running.set(releaseName, { taskIds: new Set(), stop: null })
  try {
    if (!item.downloadComplete) {
      update(releaseName, { status: 'Downloading', error: undefined })
      await downloadRelease(item)
    }
    checkStop(releaseName)
    await extractRelease(item)
    checkStop(releaseName)
    update(releaseName, { status: 'Completed', progress: 100 })
    running.delete(releaseName)
    pump()
    if (deviceConnected && selectedDevice && !sideloadingDisabled) {
      await install(releaseName, selectedDevice)
    }
  } catch (err) {
    if (err instanceof Stopped) {
      const paused = err.message === 'pause'
      update(releaseName, { status: paused ? 'Paused' : 'Cancelled', speed: '', eta: '' })
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[downloads] ${releaseName} failed: ${msg}`)
      const extracting = find(releaseName)?.status === 'Extracting'
      update(releaseName, {
        status: 'Error',
        error: msg.slice(0, 500),
        speed: '',
        eta: '',
        // A failed extraction should re-download on retry.
        ...(extracting ? { downloadComplete: false } : {})
      })
    }
  } finally {
    running.delete(releaseName)
    pump()
  }
}

function stop(releaseName: string, mode: 'pause' | 'cancel'): void {
  const ctl = running.get(releaseName)
  if (!ctl) return
  ctl.stop = mode
  ctl.taskIds.forEach((taskId) => void VrcdNative.cancelTask({ taskId }))
}

async function deleteFiles(releaseName: string): Promise<boolean> {
  try {
    await VrcdNative.fsDelete({ path: itemPath(releaseName) })
    return true
  } catch {
    return false
  }
}

function makeItem(game: GameInfo): DownloadItem {
  return {
    gameId: game.id,
    releaseName: game.releaseName,
    gameName: game.name,
    packageName: game.packageName,
    status: 'Queued',
    progress: 0,
    downloadPath: itemPath(game.releaseName),
    addedDate: Date.now(),
    thumbnailPath: game.thumbnailPath,
    size: game.size
  }
}

async function hasApk(releaseName: string): Promise<boolean> {
  try {
    const { entries } = await VrcdNative.fsList({ path: itemPath(releaseName) })
    return entries.some((e) => e.name.toLowerCase().endsWith('.apk'))
  } catch {
    return false
  }
}

async function addToQueue(
  game: GameInfo,
  resolve?: 'reinstall' | 'redownload'
): Promise<AddToQueueResult> {
  const existing = find(game.releaseName)
  if (existing && !resolve) {
    if (['Error', 'Cancelled', 'InstallError'].includes(existing.status)) {
      existing.status = 'Queued'
      existing.error = undefined
      emitUpdate(true)
      pump()
      return 'added'
    }
    return 'duplicate'
  }

  if (!resolve && (await hasApk(game.releaseName))) {
    const action = getSettings().existingDownloadAction ?? 'ask'
    if (action === 'ask') return 'needs-prompt'
    resolve = action
  }

  queue = queue.filter((i) => i.releaseName !== game.releaseName)
  const item = makeItem(game)
  if (resolve === 'reinstall') {
    item.status = 'Completed'
    item.progress = 100
    item.downloadComplete = true
    queue.push(item)
    emitUpdate(true)
    if (deviceConnected && selectedDevice && !sideloadingDisabled) {
      void install(game.releaseName, selectedDevice)
    }
    return 'imported'
  }
  if (resolve === 'redownload') await deleteFiles(game.releaseName)
  queue.push(item)
  emitUpdate(true)
  pump()
  return 'added'
}

function move(releaseName: string, fn: (idx: number, queued: number[]) => number | null): boolean {
  const queuedIdx = queue.map((it, i) => (it.status === 'Queued' ? i : -1)).filter((i) => i >= 0)
  const idx = queue.findIndex((i) => i.releaseName === releaseName)
  if (idx < 0) return false
  const target = fn(idx, queuedIdx)
  if (target === null || target === idx) return false
  const [it] = queue.splice(idx, 1)
  queue.splice(target, 0, it)
  emitUpdate(true)
  return true
}

export function initDownloads(): void {
  // Anything that was mid-flight when the app was killed resumes as paused.
  for (const item of queue) {
    if (['Downloading', 'Extracting', 'Queued'].includes(item.status)) {
      item.status = 'Paused'
      item.speed = ''
      item.eta = ''
    }
    if (item.status === 'Installing') item.status = 'Completed'
  }
  emitUpdate(true)
}

export function registerDownloadHandlers(): void {
  handle('download:get-queue', () => queue)
  handle('download:get-storage-status', () => storageStatus())
  handle('download:retry-storage', () => storageStatus())
  handle('download:add', (game) => addToQueue(game))
  handle('download:add-resolve-existing', (game, action) => addToQueue(game, action))
  handle('download:remove', async (releaseName) => {
    stop(releaseName, 'cancel')
    await deleteFiles(releaseName)
    queue = queue.filter((i) => i.releaseName !== releaseName)
    emitUpdate(true)
  })
  handle('download:remove-only', (releaseName) => {
    stop(releaseName, 'cancel')
    queue = queue.filter((i) => i.releaseName !== releaseName)
    emitUpdate(true)
  })
  handle('download:move-to-front', (r) => move(r, (_i, q) => (q.length ? q[0] : null)))
  handle('download:move-up', (r) =>
    move(r, (i, q) => {
      const p = q.indexOf(i)
      return p > 0 ? q[p - 1] : null
    })
  )
  handle('download:move-down', (r) =>
    move(r, (i, q) => {
      const p = q.indexOf(i)
      return p >= 0 && p < q.length - 1 ? q[p + 1] : null
    })
  )
  handle('download:scan', async () => {
    let added = 0
    let pruned = 0
    try {
      const { entries } = await VrcdNative.fsList({ path: getSettings().downloadPath })
      for (const dir of entries.filter((e) => e.isDir)) {
        if (find(dir.name)) continue
        const game = getGameByRelease(dir.name)
        if (game && (await hasApk(dir.name))) {
          const item = makeItem(game)
          item.status = 'Completed'
          item.progress = 100
          item.downloadComplete = true
          queue.push(item)
          added++
        }
      }
    } catch {
      // folder missing
    }
    const before = queue.length
    const keep: DownloadItem[] = []
    for (const it of queue) {
      if (it.status === 'Completed' && !(await hasApk(it.releaseName))) continue
      keep.push(it)
    }
    pruned = before - keep.length
    queue = keep
    emitUpdate(true)
    return { added, pruned }
  })
  handle('download:delete-files', async (releaseName) => {
    const ok = await deleteFiles(releaseName)
    queue = queue.filter((i) => i.releaseName !== releaseName)
    emitUpdate(true)
    return ok
  })
  handle('download:install-from-completed', async (releaseName, deviceId) => {
    await install(releaseName, deviceId)
  })

  handle('downloads:install-manual', async (filePath, deviceId) => {
    const result = await installSingleApk(filePath, deviceId, (step, percent) =>
      emit('manual-install:progress', { step, percent })
    )
    if (result.ok) emit('adb:installation-completed', deviceId)
    return result.ok
  })
  handle('downloads:copy-obb-folder', () => false)
  handle('manual:classify-path', (path) => {
    const name = basename(path)
    const lower = name.toLowerCase()
    return {
      kind: lower.endsWith('.apk') ? 'apk' : lower.endsWith('.zip') ? 'zip' : 'unknown',
      name
    }
  })

  on('download:cancel', (releaseName) => {
    const item = find(releaseName)
    if (!item) return
    if (running.has(releaseName)) stop(releaseName, 'cancel')
    else update(releaseName, { status: 'Cancelled' })
  })
  on('download:pause', (releaseName) => stop(releaseName, 'pause'))
  const requeue = (releaseName: string): void => {
    const item = find(releaseName)
    if (!item || running.has(releaseName)) return
    if (item.status === 'InstallError' && selectedDevice) {
      void install(releaseName, selectedDevice)
      return
    }
    update(releaseName, { status: 'Queued', error: undefined })
    pump()
  }
  on('download:resume', requeue)
  on('download:retry', requeue)
  on('download:set-download-path', () => undefined)
  on('download:set-sideloading-disabled', (disabled) => {
    sideloadingDisabled = disabled
  })
  onRaw('download:set-app-connection-state', (device, connected) => {
    selectedDevice = (device as string | null) ?? null
    deviceConnected = !!connected
  })
}
