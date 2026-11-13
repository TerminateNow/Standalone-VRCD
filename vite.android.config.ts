/**
 * Web bundle for the Android (Capacitor) app.
 *
 * Reuses the desktop renderer and preload unchanged; Electron-only modules are
 * aliased to small shims under src/android/shims, and the Electron main
 * process is replaced by the in-page backend in src/android/backend.
 *
 *   npm run android:web      # builds into out/android-web
 *   npx cap sync android     # copies it into the Android project
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { encodeApiKey } from './src/shared/keyObfuscation'

export default defineConfig(({ command }) => {
  const apiKey = process.env.VRSRC_API_KEY ?? ''
  if (command === 'build' && !apiKey) {
    console.warn(
      '[vite.android.config] VRSRC_API_KEY is unset — requests to the bundled server will 403. ' +
        'Rclone-free JSON server configs that need the key will not work in this build.'
    )
  }

  return {
    root: resolve(__dirname, 'src/android'),
    base: './',
    publicDir: false,
    plugins: [react()],
    define: {
      'process.contextIsolated': 'false',
      'import.meta.env.VITE_VRSRC_API_KEY_ENC': JSON.stringify(encodeApiKey(apiKey))
    },
    resolve: {
      alias: [
        { find: /^electron$/, replacement: resolve(__dirname, 'src/android/shims/electron.ts') },
        {
          find: /^electron-log\/renderer$/,
          replacement: resolve(__dirname, 'src/android/shims/electron-log-renderer.ts')
        },
        {
          find: /^@electron-toolkit\/preload$/,
          replacement: resolve(__dirname, 'src/android/shims/electron-toolkit-preload.ts')
        },
        { find: '@renderer', replacement: resolve(__dirname, 'src/renderer/src') },
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') }
      ]
    },
    build: {
      outDir: resolve(__dirname, 'out/android-web'),
      emptyOutDir: true,
      target: 'chrome100',
      chunkSizeWarningLimit: 4000
    }
  }
})
