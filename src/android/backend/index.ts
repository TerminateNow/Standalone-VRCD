/**
 * Boots the in-page Android backend. Must finish before the desktop preload
 * and React app are evaluated (see ../main.ts).
 */
import { registerAdbHandlers } from './adb'
import { initDownloads, registerDownloadHandlers } from './downloads'
import { initGames, registerGameHandlers } from './games'
import { registerMiscHandlers } from './misc'
import { joinPath, VrcdNative } from './native'
import { initSettings, registerSettingsHandlers } from './settings'

export async function startBackend(): Promise<void> {
  const [paths, info] = await Promise.all([VrcdNative.getPaths(), VrcdNative.getAppInfo()])

  registerSettingsHandlers()
  registerAdbHandlers()
  registerGameHandlers()
  registerDownloadHandlers()
  registerMiscHandlers(info.version, info.locale, info.deviceName)

  initSettings(paths.downloadsDir || joinPath(paths.filesDir, 'downloads'))
  initDownloads()
  await initGames(paths.filesDir)
}
