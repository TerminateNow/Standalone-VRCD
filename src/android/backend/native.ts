/**
 * Typed bridge to the Kotlin `VrcdNative` Capacitor plugin
 * (android/app/src/main/java/com/vrcyberdeck/app/VrcdNativePlugin.kt).
 *
 * Everything that the desktop build delegates to Node, adb, rclone or 7-Zip
 * lives behind this interface on Android: wireless ADB (dadb), HTTP transfers,
 * 7z extraction (commons-compress) and app-private file access.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface FsEntry {
  /** Absolute path on the phone. */
  path: string
  /** Path relative to the listed directory, '/'-separated. */
  relativePath: string
  name: string
  isDir: boolean
  size: number
  modified: number
}

export interface ProgressEvent {
  taskId: string
  /** Bytes (or entries for extraction) done so far. */
  transferred: number
  /** Total bytes, or -1 when unknown. */
  total: number
  /** Optional current file name. */
  file?: string
}

export interface VrcdNativePlugin {
  getPaths(): Promise<{ filesDir: string; cacheDir: string; downloadsDir: string }>
  getAppInfo(): Promise<{ version: string; locale: string; deviceName: string }>

  // --- ADB over TCP ---------------------------------------------------------
  adbConnect(opts: { host: string; port: number; timeoutMs?: number }): Promise<{ serial: string }>
  adbDisconnect(opts: { serial: string }): Promise<void>
  adbListConnected(): Promise<{ serials: string[] }>
  adbShell(opts: { serial: string; command: string }): Promise<{ output: string; exitCode: number }>
  adbPush(opts: {
    serial: string
    localPath: string
    remotePath: string
    taskId?: string
  }): Promise<{ files: number; bytes: number }>
  adbInstall(opts: {
    serial: string
    apkPath: string
    options?: string[]
    taskId?: string
  }): Promise<{ success: boolean; message: string }>
  adbPublicKey(): Promise<{ key: string }>

  // --- Network --------------------------------------------------------------
  httpGetText(opts: {
    url: string
    headers?: Record<string, string>
  }): Promise<{ status: number; body: string }>
  httpHead(opts: {
    url: string
    headers?: Record<string, string>
  }): Promise<{ status: number; contentLength: number }>
  httpDownload(opts: {
    taskId: string
    url: string
    dest: string
    headers?: Record<string, string>
  }): Promise<{ status: number; bytes: number }>
  ping(opts: { host: string; port?: number; timeoutMs?: number }): Promise<{
    reachable: boolean
    responseTime?: number
  }>

  // --- Archives -------------------------------------------------------------
  extract7z(opts: {
    taskId: string
    archive: string
    destDir: string
    password?: string
    /** Strip this leading folder (e.g. the release name) from entry paths. */
    stripPrefix?: string
  }): Promise<{ files: number }>

  cancelTask(opts: { taskId: string }): Promise<void>

  // --- Files ----------------------------------------------------------------
  fsList(opts: { path: string; recursive?: boolean }): Promise<{ entries: FsEntry[] }>
  fsExists(opts: { path: string }): Promise<{ exists: boolean; isDir: boolean }>
  fsDelete(opts: { path: string }): Promise<void>
  fsMkdir(opts: { path: string }): Promise<void>
  fsReadText(opts: { path: string }): Promise<{ text: string }>
  fsWriteText(opts: { path: string; text: string }): Promise<void>
  fsFreeSpace(opts: { path: string }): Promise<{ free: number; total: number }>
  md5(opts: { text: string }): Promise<{ hex: string }>

  // --- UI helpers -----------------------------------------------------------
  pickFile(opts: { mimeTypes?: string[] }): Promise<{ path: string | null; name?: string }>
  openUrl(opts: { url: string }): Promise<void>
  toast(opts: { text: string }): Promise<void>

  addListener(
    eventName: 'progress',
    listener: (event: ProgressEvent) => void
  ): Promise<PluginListenerHandle>
}

export const VrcdNative = registerPlugin<VrcdNativePlugin>('VrcdNative', {
  web: () => import('./webMock').then((m) => new m.VrcdNativeWeb())
})

type ProgressHandler = (e: ProgressEvent) => void
const progressHandlers = new Map<string, ProgressHandler>()
let listenerInstalled = false

/** Subscribe to progress events for a single native task id. */
export function onTaskProgress(taskId: string, handler: ProgressHandler): () => void {
  if (!listenerInstalled) {
    listenerInstalled = true
    void VrcdNative.addListener('progress', (e) => progressHandlers.get(e.taskId)?.(e))
  }
  progressHandlers.set(taskId, handler)
  return () => {
    if (progressHandlers.get(taskId) === handler) progressHandlers.delete(taskId)
  }
}

let taskCounter = 0
export function newTaskId(prefix: string): string {
  taskCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${taskCounter}`
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}
