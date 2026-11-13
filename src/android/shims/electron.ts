/**
 * Minimal stand-in for the `electron` module, used only by the Android
 * (Capacitor) bundle. See vite.android.config.ts for the alias.
 */
import { busRenderer } from '../backend/bus'

export type IpcRendererEvent = { sender: null }
export type IpcRenderer = typeof busRenderer
export type BrowserWindow = never

export const ipcRenderer = busRenderer

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    ;(window as unknown as Record<string, unknown>)[key] = api
  }
}

/**
 * The desktop layout assumes a window of at least ~900x600 CSS px. On a phone
 * we widen the layout viewport (meta viewport; MainActivity enables
 * useWideViewPort) so the page always gets that much room and is scaled down
 * to fit, then apply the user's own zoom setting on top.
 */
const DESKTOP_MIN_WIDTH = 900
const DESKTOP_MIN_HEIGHT = 600
let userZoom = 1

function applyViewport(): void {
  const sw = Math.max(1, window.screen.width)
  const sh = Math.max(1, window.screen.height)
  const landscape = window.matchMedia('(orientation: landscape)').matches
  const w = landscape ? Math.max(sw, sh) : Math.min(sw, sh)
  const h = landscape ? Math.min(sw, sh) : Math.max(sw, sh)
  const layoutWidth = Math.round(
    Math.max(w, DESKTOP_MIN_WIDTH, DESKTOP_MIN_HEIGHT * (w / h)) / userZoom
  )
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'viewport'
    document.head.appendChild(meta)
  }
  meta.content = `width=${layoutWidth}, viewport-fit=cover`
}

window.addEventListener('orientationchange', () => setTimeout(applyViewport, 200))
window.matchMedia('(orientation: landscape)').addEventListener('change', applyViewport)
applyViewport()

export const webFrame = {
  setZoomFactor(factor: number): void {
    userZoom = factor > 0 ? factor : 1
    applyViewport()
  }
}

export const webUtils = {
  getPathForFile(): string {
    // Drag-and-drop of local files has no filesystem path on Android.
    return ''
  }
}

// Only referenced by the main-process half of src/shared/ipc-utils.ts, which
// never runs on Android.
export const ipcMain = {
  handle(): void {
    // no-op
  },
  on(): void {
    // no-op
  }
}

export default { ipcRenderer, contextBridge, webFrame, webUtils, ipcMain }
