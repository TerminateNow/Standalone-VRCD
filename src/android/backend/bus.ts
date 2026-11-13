/**
 * In-page replacement for Electron's ipcMain / webContents.send.
 *
 * The desktop preload (src/preload/index.ts) is bundled unchanged on Android;
 * its `ipcRenderer` import is aliased to ../shims/electron.ts, which forwards
 * every invoke/send to the handlers registered here.
 */
import type { IPCChannels, IPCEvents, IPCSendChannels } from '@shared/types/ipc'

type AnyFn = (...args: unknown[]) => unknown
const invokeHandlers = new Map<string, AnyFn>()
const sendHandlers = new Map<string, AnyFn>()
type Listener = (event: unknown, ...args: unknown[]) => void
const listeners = new Map<string, Set<Listener>>()

export function handle<K extends keyof IPCChannels>(
  channel: K,
  fn: (
    ...args: IPCChannels[K]['params']
  ) => Promise<IPCChannels[K]['returns']> | IPCChannels[K]['returns']
): void {
  invokeHandlers.set(channel, fn as AnyFn)
}

/** Register a handler for a channel that isn't part of the typed map. */
export function handleRaw(channel: string, fn: AnyFn): void {
  invokeHandlers.set(channel, fn)
}

export function on<K extends keyof IPCSendChannels>(
  channel: K,
  fn: (...args: IPCSendChannels[K] extends void ? [] : [IPCSendChannels[K]]) => void
): void {
  sendHandlers.set(channel, fn as AnyFn)
}

export function onRaw(channel: string, fn: AnyFn): void {
  sendHandlers.set(channel, fn)
}

export function emit<K extends keyof IPCEvents>(channel: K, ...args: IPCEvents[K]): void {
  const set = listeners.get(channel)
  if (!set) return
  for (const l of [...set]) {
    try {
      l({ sender: null }, ...args)
    } catch (err) {
      console.error(`[bus] listener for ${channel} threw`, err)
    }
  }
}

// Structured-clone the payload like Electron IPC does, so the renderer can't
// mutate backend state by holding on to returned objects.
function clone<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== 'object') return v
  try {
    return structuredClone(v)
  } catch {
    return v
  }
}

export const busRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = invokeHandlers.get(channel)
    if (!fn) {
      console.warn(`[bus] no Android handler for "${channel}"`)
      throw new Error(`"${channel}" is not available in the Android version`)
    }
    return clone(await fn(...args))
  },
  send(channel: string, ...args: unknown[]): void {
    const fn = sendHandlers.get(channel)
    if (!fn) {
      console.warn(`[bus] no Android send handler for "${channel}"`)
      return
    }
    try {
      const r = fn(...args)
      if (r instanceof Promise) r.catch((e) => console.error(`[bus] ${channel} failed`, e))
    } catch (e) {
      console.error(`[bus] ${channel} failed`, e)
    }
  },
  on(channel: string, listener: Listener): void {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
  },
  removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener)
  },
  removeAllListeners(channel: string): void {
    listeners.delete(channel)
  }
}
