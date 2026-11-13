/**
 * Smaller IPC surfaces for the Android build: app info, dependency status,
 * Wi-Fi bookmarks, dialogs, and graceful stubs for desktop-only features
 * (uploads, save backups, rclone mirrors, self-update, log folders).
 */
import type { DependencyStatus, WiFiBookmark } from '@shared/types'
import clickSound from '../../../resources/sounds/click.mp3?url'
import matrixSound from '../../../resources/sounds/matrix.mp3?url'
import typeSound from '../../../resources/sounds/type.mp3?url'
import { emit, handle, on } from './bus'
import { VrcdNative } from './native'
import { clearAll, load, save } from './store'

const SOUNDS: Record<string, string> = { click: clickSound, matrix: matrixSound, type: typeSound }

export const READY_STATUS: DependencyStatus = {
  sevenZip: { ready: true, path: 'built-in', error: null },
  rclone: { ready: true, path: 'built-in', error: null, downloading: false },
  adb: { ready: true, path: 'built-in', error: null, downloading: false },
  services: 'INITIALIZED'
}

let bookmarks: WiFiBookmark[] = load<WiFiBookmark[]>('wifiBookmarks', [])
const persistBookmarks = (): void => save('wifiBookmarks', bookmarks)

export function registerMiscHandlers(appVersion: string, locale: string, deviceName: string): void {
  // --- app ------------------------------------------------------------------
  handle('app:get-version', () => appVersion)
  handle('app:get-locale', () => locale)
  handle('app:get-system-username', () => deviceName)
  handle('app:get-sound', (name) => SOUNDS[name] ?? null)
  handle('app:reset-app-data', () => {
    clearAll()
    setTimeout(() => location.reload(), 300)
    return { success: true }
  })
  handle('app:show-notification', async (title, body) => {
    await VrcdNative.toast({ text: body ? `${title}: ${body}` : title })
  })
  on('app:confirm-close', () => undefined)

  // --- dependencies (all bundled natively) ----------------------------------
  handle('dependency:get-status', () => READY_STATUS)
  setTimeout(() => emit('dependency-setup-complete', READY_STATUS), 0)

  // --- Wi-Fi bookmarks ------------------------------------------------------
  handle('wifi-bookmarks:get-all', () => bookmarks)
  handle('wifi-bookmarks:add', (name, ipAddress, port) => {
    if (bookmarks.some((b) => b.ipAddress === ipAddress && b.port === port)) return false
    bookmarks.push({
      id: `${ipAddress}:${port}:${Date.now().toString(36)}`,
      name,
      ipAddress,
      port,
      dateAdded: new Date()
    })
    persistBookmarks()
    return true
  })
  handle('wifi-bookmarks:remove', (id) => {
    const before = bookmarks.length
    bookmarks = bookmarks.filter((b) => b.id !== id)
    persistBookmarks()
    return bookmarks.length !== before
  })
  handle('wifi-bookmarks:update-last-connected', (id) => {
    const b = bookmarks.find((x) => x.id === id)
    if (b) {
      b.lastConnected = new Date()
      persistBookmarks()
    }
  })

  // --- dialogs --------------------------------------------------------------
  const pickApk = async (): Promise<string | null> =>
    (await VrcdNative.pickFile({ mimeTypes: ['application/vnd.android.package-archive'] })).path
  handle('dialog:show-apk-file-picker', pickApk)
  handle('dialog:show-manual-install-picker', pickApk)
  handle('dialog:show-file-picker', async () => (await VrcdNative.pickFile({})).path)
  // Android's storage model gives us content URIs, not folder paths; the
  // download folder is fixed to app storage.
  handle('dialog:show-directory-picker', () => null)
  handle('dialog:show-folder-picker', () => null)
  handle('dialog:show-local-folder-picker', () => null)
  handle('dialog:show-local-zip-picker', () => null)

  // --- updates --------------------------------------------------------------
  handle('update:check-for-updates', () => undefined)
  const openReleases = (): void =>
    void VrcdNative.openUrl({ url: 'https://github.com/TerminateNow/Standalone-VRCD/releases' })
  on('update:download', (url) => void VrcdNative.openUrl({ url }))
  on('update:open-releases', openReleases)
  on(
    'update:open-repository',
    () => void VrcdNative.openUrl({ url: 'https://github.com/TerminateNow/Standalone-VRCD' })
  )
  on('update:start-download', openReleases)
  on('update:install', openReleases)

  // --- logs -----------------------------------------------------------------
  handle('logs:upload-current', () => null)
  handle('logs:open-log-folder', () => undefined)
  handle('logs:open-log-file', () => undefined)

  // --- rclone mirrors (desktop only for now) --------------------------------
  handle('mirrors:get-mirrors', () => [])
  handle('mirrors:add-mirror', () => false)
  handle('mirrors:remove-mirror', () => false)
  handle('mirrors:set-active-mirror', () => false)
  handle('mirrors:clear-active-mirror', () => true)
  handle('mirrors:test-mirror', (id) => ({
    id,
    success: false,
    error: 'rclone mirrors are not supported on Android; use a JSON server config.',
    timestamp: new Date()
  }))
  handle('mirrors:test-all-mirrors', () => [])
  handle('mirrors:get-active-mirror', () => null)
  handle('mirrors:import-from-file', () => null)

  // --- uploads (desktop only for now) ---------------------------------------
  handle('upload:prepare', () => null)
  handle('upload:get-queue', () => [])
  handle('upload:add-to-queue', () => false)
  handle('upload:add-local-items', (paths) => ({
    errors: paths.map((path) => ({ path, error: 'Uploads are not available on Android yet.' }))
  }))
  on('upload:remove', () => undefined)
  on('upload:cancel', () => undefined)

  // --- save backups (desktop only for now) ----------------------------------
  handle('backup:list', () => [])
  handle('backup:create', () => ({
    ok: false,
    error: 'Save backups are not available on Android yet.'
  }))
  handle('backup:restore', () => ({
    ok: false,
    error: 'Save backups are not available on Android yet.'
  }))
  handle('backup:delete', () => false)
  handle('backup:set-verification', () => null)
  handle('backup:report-failure', () => null)
  handle('backup:get-profile', () => null)
}
