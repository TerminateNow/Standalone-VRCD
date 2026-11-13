import { busRenderer } from '../backend/bus'

export const electronAPI = {
  ipcRenderer: busRenderer,
  process: { platform: 'android', versions: {}, env: {} }
}
