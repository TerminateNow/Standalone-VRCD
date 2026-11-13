/* eslint-disable @typescript-eslint/explicit-function-return-type -- dev-only browser mock */
/**
 * Browser fallback for VrcdNative so the Android UI can be previewed with
 * `npx vite -c vite.android.config.ts` on a desktop browser. It fakes one
 * connected headset and an empty library; nothing touches a real device.
 */
import { WebPlugin } from '@capacitor/core'
import type { FsEntry, VrcdNativePlugin } from './native'

export class VrcdNativeWeb extends WebPlugin implements Partial<VrcdNativePlugin> {
  private connected = new Set<string>()

  async getPaths() {
    return { filesDir: '/mock/files', cacheDir: '/mock/cache', downloadsDir: '/mock/downloads' }
  }
  async getAppInfo() {
    return { version: '0.0.0-web', locale: navigator.language, deviceName: 'browser' }
  }
  async adbConnect({ host, port }: { host: string; port: number }) {
    const serial = `${host}:${port}`
    this.connected.add(serial)
    return { serial }
  }
  async adbDisconnect({ serial }: { serial: string }) {
    this.connected.delete(serial)
  }
  async adbListConnected() {
    return { serials: [...this.connected] }
  }
  async adbShell({ command }: { serial: string; command: string }) {
    const canned: Record<string, string> = {
      'getprop ro.product.manufacturer': 'Oculus\n',
      'getprop ro.product.device': 'eureka\n',
      'getprop ro.product.model': 'Quest 3\n',
      'dumpsys battery | grep level': '  level: 87\n',
      'df -h /data': 'Filesystem Size Used Avail Use% Mounted\n/dev/block 107G 53G 54G 50% /data\n'
    }
    return { output: canned[command] ?? '', exitCode: 0 }
  }
  async fsList(): Promise<{ entries: FsEntry[] }> {
    return { entries: [] }
  }
  async fsExists() {
    return { exists: false, isDir: false }
  }
  async fsMkdir() {
    // no-op in the browser mock
  }
  async fsDelete() {
    // no-op in the browser mock
  }
  async fsReadText(): Promise<{ text: string }> {
    throw new Error('not found')
  }
  async ping() {
    return { reachable: true, responseTime: 5 }
  }
  async toast({ text }: { text: string }) {
    console.info('[toast]', text)
  }
  async httpGetText() {
    return { status: 404, body: '' }
  }
  async pickFile() {
    return { path: null }
  }
  async openUrl({ url }: { url: string }) {
    window.open(url, '_blank')
  }
}
