/**
 * Library sync for the Android build: downloads meta.7z from the configured
 * server, extracts it with the server password and parses the game list —
 * the same protocol as src/main/services/gameService.ts, minus rclone.
 */
import type { BlacklistEntry, GameDescriptionResult, GameInfo } from '@shared/types'
import bundledNotes from '../../../resources/custom-notes.json'
import { emit, handle } from './bus'
import { newTaskId, onTaskProgress, joinPath, VrcdNative } from './native'
import { getSettings } from './settings'
import { load, save } from './store'
import { decodeApiKey } from './apiKey'

const REMOTE_CUSTOM_NOTES_URL =
  'https://raw.githubusercontent.com/DeliciousMeatPop/VRCD/main/resources/custom-notes.json'
const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000
const INTERNAL_BLACKLIST_GAMES: string[] = []

let dataPath = ''
let games: GameInfo[] = []
let blacklistGames: string[] = []
let customBlacklist: BlacklistEntry[] = load<BlacklistEntry[]>('customBlacklist', [])
let remoteNotes: Record<string, string> = load<Record<string, string>>('remoteNotes', {})
let syncing: Promise<GameInfo[]> | null = null

interface Snapshot {
  packages: Record<string, { firstSeenAt: number; version: string; versionChangedAt: number }>
}

export function serverHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'rclone/v1.72.1' }
  const key = decodeApiKey(import.meta.env.VITE_VRSRC_API_KEY_ENC ?? '')
  if (key) headers['X-API-Key'] = key
  return headers
}

export function getServer(): { baseUri: string; password: string } | null {
  const { baseUri, password } = getSettings().serverConfig
  if (!baseUri || !password) return null
  return { baseUri: baseUri.endsWith('/') ? baseUri : `${baseUri}/`, password }
}

/** The archive password is stored base64-encoded in the server config. */
export function archivePassword(): string {
  const server = getServer()
  if (!server) return ''
  try {
    const bin = atob(server.password)
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return server.password
  }
}

export function getGameByRelease(releaseName: string): GameInfo | undefined {
  return games.find((g) => g.releaseName === releaseName)
}

async function findGameListFile(): Promise<string | null> {
  try {
    const { entries } = await VrcdNative.fsList({ path: dataPath })
    const match = entries.find((e) => !e.isDir && /amelist\.txt$/i.test(e.name))
    return match ? match.path : null
  } catch {
    return null
  }
}

async function loadBlacklist(): Promise<void> {
  try {
    const { text } = await VrcdNative.fsReadText({
      path: joinPath(dataPath, '.meta', 'nouns', 'blacklist.txt')
    })
    blacklistGames = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    blacklistGames = []
  }
}

async function loadGameList(): Promise<void> {
  const file = await findGameListFile()
  if (!file) {
    games = []
    return
  }
  const { text } = await VrcdNative.fsReadText({ path: file })
  let thumbs = new Set<string>()
  try {
    const { entries } = await VrcdNative.fsList({ path: joinPath(dataPath, '.meta', 'thumbnails') })
    thumbs = new Set(entries.map((e) => e.name))
  } catch {
    // no thumbnails yet
  }
  games = parseGameList(text, thumbs)
  decorate(games)
  await loadBlacklist()
}

function parseGameList(data: string, thumbs: Set<string>): GameInfo[] {
  const lines = data.split('\n')
  const header = lines[0]
  if (!header || !header.includes(';')) return []
  const cols = header.split(';').map((c) => c.trim())
  const idx = (name: string): number => cols.indexOf(name)
  const iName = idx('Game Name')
  const iPkg = idx('Package Name')
  const iVer = idx('Version Code')
  const iSize = idx('Size (MB)')
  const iUpdated = idx('Last Updated')
  const iRelease = idx('Release Name')
  const iDownloads = idx('Downloads')
  const iDesc = idx('Description')
  const iDescLabel = idx('Description Source')
  const iDescUrl = idx('Description Source URL')
  const iDescLang = idx('Description Language')

  const out: GameInfo[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const parts = line.split(';')
    if (parts.length < cols.length) continue
    const get = (j: number): string => (j >= 0 ? (parts[j] ?? '').trim() : '')
    const name = iName >= 0 ? get(iName) : 'Unknown'
    const packageName = get(iPkg)
    if (!name || !packageName) continue
    const releaseName = get(iRelease)
    const thumbFile = `${packageName}.jpg`
    const desc = get(iDesc)
    const descLabel = get(iDescLabel)
    const descUrl = get(iDescUrl)
    const descLang = get(iDescLang)
    out.push({
      id: packageName,
      name,
      packageName,
      version: get(iVer),
      size: iSize >= 0 ? `${get(iSize)} MB` : '',
      lastUpdated: get(iUpdated),
      releaseName,
      downloads: parseFloat(get(iDownloads)) || 0,
      thumbnailPath: thumbs.has(thumbFile)
        ? joinPath(dataPath, '.meta', 'thumbnails', thumbFile)
        : '',
      notePath: releaseName ? joinPath(dataPath, '.meta', 'notes', `${releaseName}.txt`) : '',
      isInstalled: false,
      ...(desc ? { libraryDescription: desc } : {}),
      ...(descLabel ? { libraryDescriptionSourceLabel: descLabel } : {}),
      ...(descUrl ? { libraryDescriptionSourceUrl: descUrl } : {}),
      ...(descLang === 'en' || descLang === 'es' ? { libraryDescriptionLanguage: descLang } : {})
    })
  }
  return out
}

/** NEW / UPDATED badge bookkeeping (see GameService.decorateAndUpdateSnapshot). */
function decorate(list: GameInfo[]): void {
  const existing = load<Snapshot | null>('librarySnapshot', null)
  const isFirstRun = !existing
  const snap: Snapshot = existing ?? { packages: {} }
  const now = Date.now()
  for (const g of list) {
    const prev = snap.packages[g.packageName]
    if (!prev) {
      const firstSeenAt = isFirstRun ? 0 : now
      snap.packages[g.packageName] = { firstSeenAt, version: g.version, versionChangedAt: 0 }
      g.firstSeenAt = firstSeenAt
      g.versionChangedAt = 0
    } else {
      if (prev.version !== g.version) {
        prev.version = g.version
        prev.versionChangedAt = now
      }
      g.firstSeenAt = prev.firstSeenAt
      g.versionChangedAt = prev.versionChangedAt
    }
  }
  save('librarySnapshot', snap)
}

function progress(stage: 'download' | 'extract', value: number): void {
  emit('games:download-progress', { packageName: 'meta', stage, progress: Math.round(value) })
}

async function syncGameData(): Promise<GameInfo[]> {
  const server = getServer()
  if (!server) throw new Error('No server configured. Add one in Settings → Server config.')
  if (!serverHeaders()['X-API-Key']) {
    // Same check as the desktop GameService: the public server rejects every
    // request without the key, so say so instead of failing with a bare 403.
    throw new Error(
      'This APK was built without an API key (VRSRC_API_KEY), so the server will refuse the library ' +
        'download (403). Add the VRSRC_API_KEY secret to the repository and rebuild the APK.'
    )
  }

  const archive = joinPath(dataPath, 'meta.7z')
  const dlTask = newTaskId('meta-dl')
  const offDl = onTaskProgress(dlTask, (e) => {
    if (e.total > 0) progress('download', (e.transferred / e.total) * 100)
  })
  try {
    progress('download', 0)
    const res = await VrcdNative.httpDownload({
      taskId: dlTask,
      url: `${server.baseUri}meta.7z`,
      dest: archive,
      headers: serverHeaders()
    })
    if (res.status === 403) {
      throw new Error(
        'The server refused the request (403). The API key in this build was rejected, or the phone clock is wrong.'
      )
    }
    if (res.status >= 400) throw new Error(`Server returned HTTP ${res.status} for meta.7z`)
  } finally {
    offDl()
  }
  progress('download', 100)

  const exTask = newTaskId('meta-x')
  const offEx = onTaskProgress(exTask, (e) => {
    if (e.total > 0) progress('extract', (e.transferred / e.total) * 100)
  })
  try {
    progress('extract', 0)
    await VrcdNative.fsDelete({ path: joinPath(dataPath, '.meta') }).catch(() => undefined)
    await VrcdNative.extract7z({
      taskId: exTask,
      archive,
      destDir: dataPath,
      password: archivePassword()
    })
  } finally {
    offEx()
  }
  progress('extract', 100)
  await VrcdNative.fsDelete({ path: archive }).catch(() => undefined)

  await loadGameList()
  if (games.length === 0) throw new Error('meta archive did not contain a game list')
  save('lastSync', Date.now())
  return games
}

async function refreshRemoteNotes(): Promise<void> {
  try {
    const res = await VrcdNative.httpGetText({ url: REMOTE_CUSTOM_NOTES_URL })
    if (res.status !== 200) return
    const parsed = JSON.parse(res.body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      remoteNotes = parsed
      save('remoteNotes', parsed)
    }
  } catch {
    // keep cached notes
  }
}

function sync(): Promise<GameInfo[]> {
  if (!syncing) {
    syncing = Promise.all([syncGameData(), refreshRemoteNotes()])
      .then(([list]) => list)
      .finally(() => {
        syncing = null
      })
  }
  return syncing
}

function backgroundSync(): void {
  sync()
    .then((list) => emit('games:background-sync-complete', list))
    .catch((err) =>
      emit('games:background-sync-error', err instanceof Error ? err.message : String(err))
    )
}

export async function initGames(filesDir: string): Promise<void> {
  dataPath = joinPath(filesDir, 'library')
  await VrcdNative.fsMkdir({ path: dataPath })
  try {
    await loadGameList()
  } catch (err) {
    console.warn('[games] failed to load cached game list', err)
  }
  const last = load<number>('lastSync', 0)
  if (getServer() && (games.length === 0 || Date.now() - last > SYNC_MAX_AGE_MS)) backgroundSync()
}

function isBlacklisted(packageName: string, version?: number): boolean {
  if (INTERNAL_BLACKLIST_GAMES.includes(packageName) || blacklistGames.includes(packageName)) {
    return true
  }
  const entry = customBlacklist.find((e) => e.packageName === packageName)
  if (!entry) return false
  if (entry.version === 'any' || version === undefined) return true
  return version <= entry.version
}

export function registerGameHandlers(): void {
  handle('games:get-games', () => games)
  handle('games:force-sync-games', () => sync())
  handle('games:get-last-sync-time', () => {
    const t = load<number>('lastSync', 0)
    return t ? new Date(t) : null
  })
  handle('games:get-note', async (releaseName) => {
    if (!releaseName || releaseName.startsWith('_')) return ''
    const custom = remoteNotes[releaseName] || (bundledNotes as Record<string, string>)[releaseName]
    if (typeof custom === 'string' && custom.trim()) return custom
    try {
      return (
        await VrcdNative.fsReadText({
          path: joinPath(dataPath, '.meta', 'notes', `${releaseName}.txt`)
        })
      ).text
    } catch {
      return ''
    }
  })
  // Trailers rely on Electron's <webview>; not available in the Android build.
  handle('games:get-trailer-url', () => null)
  handle('games:get-description', (req): GameDescriptionResult => {
    if (req.libraryDescription) {
      return {
        status: 'found',
        text: req.libraryDescription,
        source: {
          label: req.libraryDescriptionSourceLabel || 'Library',
          url: req.libraryDescriptionSourceUrl
        },
        language: req.libraryDescriptionLanguage ?? req.language,
        fetchedAt: Date.now()
      }
    }
    return { status: 'not-found', language: req.language, fetchedAt: Date.now() }
  })
  handle('games:prime-descriptions', () => ({}))
  handle('games:get-blacklist-games', () => customBlacklist)
  handle('games:add-to-blacklist', (packageName, version = 'any') => {
    if (blacklistGames.includes(packageName)) return false
    const existing = customBlacklist.find((e) => e.packageName === packageName)
    if (existing) {
      if (existing.version === 'any') return false
      if (version !== 'any' && version <= existing.version) return false
      existing.version = version
    } else {
      customBlacklist.push({ packageName, version })
    }
    save('customBlacklist', customBlacklist)
    return true
  })
  handle('games:remove-from-blacklist', (packageName) => {
    const before = customBlacklist.length
    customBlacklist = customBlacklist.filter((e) => e.packageName !== packageName)
    save('customBlacklist', customBlacklist)
    return customBlacklist.length !== before
  })
  handle('games:is-game-blacklisted', (packageName, version) => isBlacklisted(packageName, version))
}
