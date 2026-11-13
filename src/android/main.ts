/**
 * Android (Capacitor) entry point.
 *
 * 1. Start the in-page backend that replaces Electron's main process.
 * 2. Evaluate the unchanged desktop preload, which builds `window.api` on top
 *    of the aliased `electron` shim.
 * 3. Mount the unchanged desktop React renderer.
 */
import { Capacitor } from '@capacitor/core'
import { startBackend } from './backend'
import './android.css'

declare global {
  interface Window {
    __vrcdFileSrc?: (path: string) => string
  }
}

window.__vrcdFileSrc = (path: string): string => Capacitor.convertFileSrc(path)

async function boot(): Promise<void> {
  try {
    await startBackend()
  } catch (err) {
    console.error('[android] backend failed to start', err)
  }
  await import('../preload/index')
  await import('../renderer/src/main')
}

void boot()
