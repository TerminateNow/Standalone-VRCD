package com.vrcyberdeck.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(VrcdNativePlugin::class.java)
        super.onCreate(savedInstanceState)
        // The desktop UI needs ~900 CSS px of width; let the page's meta
        // viewport (set in src/android/shims/electron.ts) widen the layout and
        // scale it to the screen.
        bridge.webView.settings.apply {
            useWideViewPort = true
            loadWithOverviewMode = true
        }
    }
}
