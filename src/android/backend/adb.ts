/**
 * Wireless-ADB device management for the Android build.
 *
 * The phone talks to the headset directly over TCP using the ADB wire protocol
 * (dadb on the Kotlin side). A Quest must first have ADB-over-TCP enabled
 * (`adb tcpip 5555` once from a PC, or Meta Quest Developer Hub / SideQuest's
 * wireless toggle); after that, the device is reachable at <headset-ip>:5555
 * until it reboots.
 */
import type { DeviceInfo, PackageInfo } from '@shared/types'
import { emit, handle, on } from './bus'
import { VrcdNative } from './native'

const QUEST_MODEL_NAMES: Record<string, string> = {
  monterey: 'Oculus Quest',
  hollywood: 'Meta Quest 2',
  seacliff: 'Meta Quest Pro',
  eureka: 'Meta Quest 3',
  panther: 'Meta Quest 3S / Lite',
  sekiu: 'Meta XR Simulator'
}

const devices = new Map<string, DeviceInfo>()
let tracking = false
let healthTimer: ReturnType<typeof setInterval> | null = null

export async function shell(serial: string, command: string): Promise<string> {
  const res = await VrcdNative.adbShell({ serial, command })
  return res.output
}

async function describe(serial: string): Promise<DeviceInfo> {
  const [host] = serial.split(':')
  const safe = async (cmd: string): Promise<string> => {
    try {
      return (await shell(serial, cmd)).trim()
    } catch {
      return ''
    }
  }
  const manufacturer = (await safe('getprop ro.product.manufacturer')).toLowerCase()
  const codename = (await safe('getprop ro.product.device')).toLowerCase()
  const model = (await safe('getprop ro.product.model')) || codename || null
  const isQuestDevice = manufacturer === 'oculus' && codename in QUEST_MODEL_NAMES

  let batteryLevel: number | null = null
  const battery = await safe('dumpsys battery | grep level')
  const bm = battery.match(/level:\s*(\d+)/)
  if (bm) batteryLevel = parseInt(bm[1], 10)

  let storageTotal: string | null = null
  let storageFree: string | null = null
  const df = (await safe('df -h /data')).split('\n')
  if (df.length > 1) {
    const cols = df[1].trim().split(/\s+/)
    if (cols.length >= 4) {
      storageTotal = cols[1]
      storageFree = cols[3]
    }
  }

  return {
    id: serial,
    type: 'device',
    model,
    isQuestDevice,
    batteryLevel,
    storageTotal,
    storageFree,
    friendlyModelName: isQuestDevice ? QUEST_MODEL_NAMES[codename] : model,
    ipAddress: host
  }
}

async function connect(host: string, port: number): Promise<boolean> {
  try {
    const { serial } = await VrcdNative.adbConnect({ host, port, timeoutMs: 15000 })
    const info = await describe(serial)
    const existed = devices.has(serial)
    devices.set(serial, info)
    emit(existed ? 'adb:device-changed' : 'adb:device-added', info)
    startHealthCheck()
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[adb] connect ${host}:${port} failed: ${msg}`)
    emit('adb:device-tracker-error', `Could not connect to ${host}:${port}: ${msg}`)
    return false
  }
}

async function disconnect(serial: string): Promise<void> {
  try {
    await VrcdNative.adbDisconnect({ serial })
  } catch {
    // already gone
  }
  const info = devices.get(serial)
  devices.delete(serial)
  if (info) emit('adb:device-removed', info)
}

function startHealthCheck(): void {
  if (healthTimer) return
  healthTimer = setInterval(async () => {
    for (const serial of [...devices.keys()]) {
      try {
        await VrcdNative.adbShell({ serial, command: 'echo ok' })
      } catch {
        console.warn(`[adb] ${serial} stopped responding; marking disconnected`)
        await disconnect(serial)
      }
    }
    if (devices.size === 0 && healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
  }, 10000)
}

export function getConnectedSerials(): string[] {
  return [...devices.keys()]
}

export function parseInstalledPackages(output: string): PackageInfo[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => {
      const name = l.replace(/^package:/, '').split(/\s+/)[0]
      const vm = l.match(/versionCode:(\d+)/)
      return { packageName: name, versionCode: vm ? parseInt(vm[1], 10) : 0 }
    })
}

function splitHostPort(target: string): { host: string; port: number } {
  const [host, portStr] = target.split(':')
  return { host, port: parseInt(portStr || '5555', 10) || 5555 }
}

export function registerAdbHandlers(): void {
  handle('adb:list-devices', async () => [...devices.values()])
  handle('adb:connect-device', async (serial) => {
    if (devices.has(serial)) return true
    if (!serial.includes(':')) return false
    const { host, port } = splitHostPort(serial)
    return connect(host, port)
  })
  handle('adb:connect-tcp-device', (ip, port) => connect(ip, port ?? 5555))
  handle('adb:disconnect-tcp-device', async (ip, port) => {
    await disconnect(`${ip}:${port ?? 5555}`)
    return true
  })
  handle('adb:get-device-ip', (serial) => devices.get(serial)?.ipAddress ?? null)
  handle('adb:get-installed-packages', async (serial) => {
    try {
      return parseInstalledPackages(await shell(serial, 'pm list packages --show-versioncode -3'))
    } catch (err) {
      console.error('[adb] list packages failed', err)
      return []
    }
  })
  handle('adb:uninstallPackage', async (serial, packageName) => {
    const out = await shell(serial, `pm uninstall ${packageName}`)
    // Clean up leftover OBB/data folders like the desktop build does.
    await shell(
      serial,
      `rm -rf /sdcard/Android/obb/${packageName} /sdcard/Android/data/${packageName}`
    ).catch(() => '')
    return out.includes('Success')
  })
  handle('adb:get-application-label', () => null)
  handle('adb:get-user-name', async (serial) =>
    (await shell(serial, 'settings get global username')).trim().replace(/^null$/, '')
  )
  handle('adb:set-user-name', async (serial, name) => {
    await shell(serial, `settings put global username "${name.trim().replace(/"/g, '')}"`)
  })
  handle('adb:ping-device', (ip) => VrcdNative.ping({ host: ip, port: 5555, timeoutMs: 2000 }))
  handle('adb:run-shell-command', async (serial, command) => {
    try {
      return await shell(serial, command)
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  })
  handle('adb:run-local-adb-command', async (args) => {
    const parts = args.trim().split(/\s+/)
    const cmd = parts[0]
    if (cmd === 'devices') {
      return ['List of devices attached', ...[...devices.keys()].map((s) => `${s}\tdevice`)].join(
        '\n'
      )
    }
    if (cmd === 'connect' && parts[1]) {
      const { host, port } = splitHostPort(parts[1])
      return (await connect(host, port))
        ? `connected to ${host}:${port}`
        : `failed to connect to ${host}:${port}`
    }
    if (cmd === 'disconnect' && parts[1]) {
      const { host, port } = splitHostPort(parts[1])
      await disconnect(`${host}:${port}`)
      return `disconnected ${host}:${port}`
    }
    if (cmd === 'tcpip') {
      const serial = [...devices.keys()][0]
      if (!serial) return 'error: no devices'
      return shell(serial, `setprop service.adb.tcp.port ${parts[1] || '5555'}`)
    }
    return `"adb ${args}" is not supported on Android. Use the device shell instead.`
  })
  handle('adb:fix-linux-usb-access', () => ({
    success: false,
    message: 'Not applicable on Android.'
  }))

  on('adb:start-tracking-devices', () => {
    tracking = true
    // Re-announce known devices so a freshly mounted UI picks them up.
    devices.forEach((d) => emit('adb:device-added', d))
  })
  on('adb:stop-tracking-devices', () => {
    tracking = false
  })
  void tracking
}
