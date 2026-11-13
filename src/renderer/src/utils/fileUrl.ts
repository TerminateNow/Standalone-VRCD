/**
 * Turns an absolute local path into a URL the renderer can load.
 *
 * Electron serves local files over file://. The Android (Capacitor) build
 * can't, so it installs `window.__vrcdFileSrc`, which maps the path onto
 * Capacitor's local file server.
 */
export function fileUrl(path: string): string {
  const androidSrc = (window as { __vrcdFileSrc?: (p: string) => string }).__vrcdFileSrc
  return androidSrc ? androidSrc(path) : `file://${path}`
}

/** True when running inside the Android (Capacitor) build. */
export function isAndroidApp(): boolean {
  return !!(window as { __vrcdFileSrc?: unknown }).__vrcdFileSrc
}
