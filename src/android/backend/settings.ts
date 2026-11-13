import type { DownloadProxySettings, ExistingDownloadAction, ServerConfigInfo } from '@shared/types'
import { sanitizeBaseUri } from '@shared/serverConfig'
import { emit, handle } from './bus'
import { load, save } from './store'

export interface AndroidSettings {
  downloadPath: string
  extractionPath: string
  downloadSpeedLimit: number
  uploadSpeedLimit: number
  colorScheme: 'light' | 'dark'
  serverConfig: ServerConfigInfo
  maxConcurrentDownloads: number
  existingDownloadAction: ExistingDownloadAction
  downloadProxy: DownloadProxySettings
}

const DEFAULTS: AndroidSettings = {
  downloadPath: '',
  extractionPath: '',
  downloadSpeedLimit: 0,
  uploadSpeedLimit: 0,
  colorScheme: window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  serverConfig: { baseUri: '', password: '' },
  // Phones have far less bandwidth/storage headroom than a desktop.
  maxConcurrentDownloads: 1,
  existingDownloadAction: 'ask',
  downloadProxy: { enabled: false, protocol: 'http', host: '', port: 0 }
}

let current: AndroidSettings = { ...DEFAULTS, ...load<Partial<AndroidSettings>>('settings', {}) }

const changeListeners = new Set<(s: AndroidSettings) => void>()

export function getSettings(): AndroidSettings {
  return current
}

export function updateSettings(patch: Partial<AndroidSettings>): void {
  current = { ...current, ...patch }
  save('settings', current)
  changeListeners.forEach((l) => l(current))
}

export function onSettingsChanged(l: (s: AndroidSettings) => void): void {
  changeListeners.add(l)
}

/** Fills in the default download folder once the native paths are known. */
export function initSettings(defaultDownloadPath: string): void {
  if (!current.downloadPath) updateSettings({ downloadPath: defaultDownloadPath })
}

export function registerSettingsHandlers(): void {
  handle('settings:get-download-path', () => current.downloadPath)
  handle('settings:set-download-path', (path) => updateSettings({ downloadPath: path }))
  handle('settings:get-extraction-path', () => current.extractionPath)
  handle('settings:set-extraction-path', (path) => updateSettings({ extractionPath: path }))
  handle('settings:get-download-speed-limit', () => current.downloadSpeedLimit)
  handle('settings:set-download-speed-limit', (limit) => {
    updateSettings({ downloadSpeedLimit: limit })
    emit('settings:download-speed-limit-changed', limit)
  })
  handle('settings:get-upload-speed-limit', () => current.uploadSpeedLimit)
  handle('settings:set-upload-speed-limit', (limit) => {
    updateSettings({ uploadSpeedLimit: limit })
    emit('settings:upload-speed-limit-changed', limit)
  })
  handle('settings:get-color-scheme', () => current.colorScheme)
  handle('settings:set-color-scheme', (scheme) => updateSettings({ colorScheme: scheme }))
  handle('settings:get-server-config', () => current.serverConfig)
  handle('settings:set-server-config', (config) =>
    updateSettings({
      serverConfig: {
        baseUri: sanitizeBaseUri(config.baseUri),
        password: (config.password ?? '').trim()
      }
    })
  )
  handle('settings:get-max-concurrent-downloads', () => current.maxConcurrentDownloads)
  handle('settings:set-max-concurrent-downloads', (n) =>
    updateSettings({ maxConcurrentDownloads: Math.max(1, Math.min(5, Math.round(n))) })
  )
  handle('settings:get-existing-download-action', () => current.existingDownloadAction)
  handle('settings:set-existing-download-action', (v) =>
    updateSettings({ existingDownloadAction: v })
  )
  handle('settings:get-download-proxy', () => current.downloadProxy)
  handle('settings:set-download-proxy', (s) => {
    updateSettings({ downloadProxy: s })
    return s
  })
}
