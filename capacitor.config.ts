import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor config for the Android build. The web bundle comes from
 * vite.android.config.ts (`npm run android:web`).
 */
const config: CapacitorConfig = {
  appId: 'com.vrcyberdeck.app',
  appName: 'VR CyberDeck',
  webDir: 'out/android-web',
  android: {
    // The headset is reached over plain TCP/HTTP on the LAN.
    allowMixedContent: true
  }
}

export default config
