package com.vrcyberdeck.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native half of the Android port. The web layer (src/android/backend) owns
 * all app logic; this plugin only exposes the primitives Node/adb/rclone/7-Zip
 * provided on desktop. Every method runs on a worker thread and resolves
 * asynchronously; long tasks report through the "progress" event.
 */
@CapacitorPlugin(name = "VrcdNative")
class VrcdNativePlugin : Plugin() {

    private val executor = Executors.newCachedThreadPool()
    private val cancelled = ConcurrentHashMap<String, AtomicBoolean>()
    private val lastProgress = ConcurrentHashMap<String, Long>()
    private val activeTasks = AtomicInteger(0)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val adb by lazy { AdbManager(File(context.filesDir, "adb")) }

    // ------------------------------------------------------------------ helpers

    private fun bg(call: PluginCall, block: () -> JSObject?) {
        executor.execute {
            try {
                val result = block()
                if (result == null) call.resolve() else call.resolve(result)
            } catch (t: Throwable) {
                call.reject(t.message ?: t.javaClass.simpleName, null, Exception(t))
            }
        }
    }

    /** Runs a cancellable, progress-reporting task, holding wake/wifi locks meanwhile. */
    private fun task(call: PluginCall, block: (cancel: () -> Boolean, progress: (Long, Long, String?) -> Unit) -> JSObject?) {
        val taskId = call.getString("taskId") ?: "anon-${System.nanoTime()}"
        val flag = AtomicBoolean(false)
        cancelled[taskId] = flag
        bg(call) {
            acquireLocks()
            try {
                block({ flag.get() }) { done, total, file -> emitProgress(taskId, done, total, file) }
            } finally {
                cancelled.remove(taskId)
                lastProgress.remove(taskId)
                releaseLocks()
            }
        }
    }

    private fun emitProgress(
        taskId: String,
        done: Long,
        total: Long,
        file: String?,
        force: Boolean = false
    ) {
        val now = System.currentTimeMillis()
        val last = lastProgress[taskId] ?: 0L
        if (!force && now - last < 200 && done != total) return
        lastProgress[taskId] = now
        val ev = JSObject()
        ev.put("taskId", taskId)
        ev.put("transferred", done)
        ev.put("total", total)
        if (file != null) ev.put("file", file)
        notifyListeners("progress", ev)
    }

    @SuppressLint("WakelockTimeout")
    @Synchronized
    private fun acquireLocks() {
        if (activeTasks.incrementAndGet() != 1) return
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vrcd:transfer").apply {
                setReferenceCounted(false)
                acquire()
            }
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "vrcd:transfer").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Throwable) {
            // Locks are best-effort.
        }
    }

    @Synchronized
    private fun releaseLocks() {
        if (activeTasks.decrementAndGet() > 0) return
        runCatching { wakeLock?.release() }
        runCatching { wifiLock?.release() }
        wakeLock = null
        wifiLock = null
    }

    private fun headers(call: PluginCall): Map<String, String> {
        val obj = call.getObject("headers") ?: return emptyMap()
        val out = mutableMapOf<String, String>()
        obj.keys().forEach { k -> out[k] = obj.getString(k) ?: "" }
        return out
    }

    private fun req(call: PluginCall, key: String): String =
        call.getString(key) ?: throw IllegalArgumentException("Missing \"$key\"")

    // --------------------------------------------------------------------- info

    @PluginMethod
    fun getPaths(call: PluginCall) = bg(call) {
        val downloads = File(context.getExternalFilesDir(null) ?: context.filesDir, "downloads")
        downloads.mkdirs()
        JSObject().apply {
            put("filesDir", context.filesDir.absolutePath)
            put("cacheDir", context.cacheDir.absolutePath)
            put("downloadsDir", downloads.absolutePath)
        }
    }

    @PluginMethod
    fun getAppInfo(call: PluginCall) = bg(call) {
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        JSObject().apply {
            put("version", pkg.versionName ?: "0")
            put("locale", Locale.getDefault().toLanguageTag())
            put("deviceName", Build.MODEL ?: "android")
        }
    }

    // ---------------------------------------------------------------------- adb

    @PluginMethod
    fun adbConnect(call: PluginCall) = bg(call) {
        val serial = adb.connect(
            req(call, "host"),
            call.getInt("port") ?: 5555,
            (call.getInt("timeoutMs") ?: 30000).toLong()
        )
        JSObject().put("serial", serial)
    }

    @PluginMethod
    fun adbDisconnect(call: PluginCall) = bg(call) {
        adb.disconnect(req(call, "serial"))
        null
    }

    @PluginMethod
    fun adbListConnected(call: PluginCall) = bg(call) {
        JSObject().put("serials", JSArray(adb.connected()))
    }

    @PluginMethod
    fun adbPublicKey(call: PluginCall) = bg(call) {
        JSObject().put("key", adb.publicKey())
    }

    @PluginMethod
    fun adbShell(call: PluginCall) = bg(call) {
        val (output, exit) = adb.shell(req(call, "serial"), req(call, "command"))
        JSObject().apply {
            put("output", output)
            put("exitCode", exit)
        }
    }

    @PluginMethod
    fun adbPush(call: PluginCall) = task(call) { cancel, progress ->
        val local = File(req(call, "localPath"))
        if (!local.exists()) throw IOException("Local file/folder not found: ${local.path}")
        val (files, bytes) = adb.push(req(call, "serial"), local, req(call, "remotePath"), cancel) { d, t ->
            progress(d, t, null)
        }
        JSObject().apply {
            put("files", files)
            put("bytes", bytes)
        }
    }

    @PluginMethod
    fun adbInstall(call: PluginCall) = task(call) { cancel, progress ->
        val apk = File(req(call, "apkPath"))
        if (!apk.exists()) throw IOException("APK not found: ${apk.path}")
        val options = call.getArray("options")?.toList<String>() ?: listOf("-r", "-g")
        val (ok, message) = adb.install(req(call, "serial"), apk, options, cancel) { d, t ->
            progress(d, t, apk.name)
        }
        JSObject().apply {
            put("success", ok)
            put("message", message)
        }
    }

    // ------------------------------------------------------------------ network

    @PluginMethod
    fun httpGetText(call: PluginCall) = bg(call) {
        val (status, body) = Transfers.getText(req(call, "url"), headers(call))
        JSObject().apply {
            put("status", status)
            put("body", body)
        }
    }

    @PluginMethod
    fun httpHead(call: PluginCall) = bg(call) {
        val (status, length) = Transfers.head(req(call, "url"), headers(call))
        JSObject().apply {
            put("status", status)
            put("contentLength", length)
        }
    }

    @PluginMethod
    fun httpDownload(call: PluginCall) = task(call) { cancel, progress ->
        val (status, bytes) = Transfers.download(
            req(call, "url"),
            File(req(call, "dest")),
            headers(call),
            cancel
        ) { d, t -> progress(d, t, null) }
        JSObject().apply {
            put("status", status)
            put("bytes", bytes)
        }
    }

    @PluginMethod
    fun ping(call: PluginCall) = bg(call) {
        val host = req(call, "host")
        val port = call.getInt("port") ?: 5555
        val timeout = call.getInt("timeoutMs") ?: 2000
        val start = System.currentTimeMillis()
        val ok = try {
            Socket().use { it.connect(InetSocketAddress(host, port), timeout) }
            true
        } catch (_: IOException) {
            false
        }
        JSObject().apply {
            put("reachable", ok)
            if (ok) put("responseTime", System.currentTimeMillis() - start)
        }
    }

    // ----------------------------------------------------------------- archives

    @PluginMethod
    fun extract7z(call: PluginCall) = task(call) { cancel, progress ->
        val files = Transfers.extract7z(
            File(req(call, "archive")),
            File(req(call, "destDir")),
            call.getString("password"),
            call.getString("stripPrefix"),
            cancel
        ) { d, t -> progress(d, t, null) }
        JSObject().put("files", files)
    }

    @PluginMethod
    fun cancelTask(call: PluginCall) {
        call.getString("taskId")?.let { cancelled[it]?.set(true) }
        call.resolve()
    }

    // -------------------------------------------------------------------- files

    @PluginMethod
    fun fsList(call: PluginCall) = bg(call) {
        val root = File(req(call, "path"))
        val recursive = call.getBoolean("recursive") ?: false
        val entries = JSArray()
        if (root.isDirectory) {
            val seq = if (recursive) root.walkTopDown().drop(1) else (root.listFiles()?.asSequence() ?: emptySequence())
            seq.forEach { f ->
                entries.put(JSObject().apply {
                    put("path", f.absolutePath)
                    put("relativePath", f.relativeTo(root).invariantSeparatorsPath)
                    put("name", f.name)
                    put("isDir", f.isDirectory)
                    put("size", if (f.isFile) f.length() else 0L)
                    put("modified", f.lastModified())
                })
            }
        } else if (!root.exists()) {
            throw IOException("Not found: ${root.path}")
        }
        JSObject().put("entries", entries)
    }

    @PluginMethod
    fun fsExists(call: PluginCall) = bg(call) {
        val f = File(req(call, "path"))
        JSObject().apply {
            put("exists", f.exists())
            put("isDir", f.isDirectory)
        }
    }

    @PluginMethod
    fun fsDelete(call: PluginCall) = bg(call) {
        File(req(call, "path")).deleteRecursively()
        null
    }

    @PluginMethod
    fun fsMkdir(call: PluginCall) = bg(call) {
        File(req(call, "path")).mkdirs()
        null
    }

    @PluginMethod
    fun fsReadText(call: PluginCall) = bg(call) {
        val f = File(req(call, "path"))
        if (!f.isFile) throw IOException("Not found: ${f.path}")
        JSObject().put("text", f.readText())
    }

    @PluginMethod
    fun fsWriteText(call: PluginCall) = bg(call) {
        val f = File(req(call, "path"))
        f.parentFile?.mkdirs()
        f.writeText(call.getString("text") ?: "")
        null
    }

    @PluginMethod
    fun fsFreeSpace(call: PluginCall) = bg(call) {
        var dir = File(req(call, "path"))
        while (!dir.exists() && dir.parentFile != null) dir = dir.parentFile!!
        val stat = StatFs(dir.path)
        JSObject().apply {
            put("free", stat.availableBytes)
            put("total", stat.totalBytes)
        }
    }

    @PluginMethod
    fun md5(call: PluginCall) = bg(call) {
        val digest = MessageDigest.getInstance("MD5").digest(req(call, "text").toByteArray(Charsets.UTF_8))
        JSObject().put("hex", digest.joinToString("") { "%02x".format(it) })
    }

    // ----------------------------------------------------------------------- ui

    @PluginMethod
    fun pickFile(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            val types = call.getArray("mimeTypes")?.toList<String>() ?: emptyList()
            type = "*/*"
            if (types.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        }
        startActivityForResult(call, intent, "onFilePicked")
    }

    @ActivityCallback
    private fun onFilePicked(call: PluginCall, result: ActivityResult) {
        val uri: Uri? = result.data?.data
        if (uri == null) {
            call.resolve(JSObject().put("path", null as String?))
            return
        }
        bg(call) {
            val name = displayName(uri) ?: "picked-${System.currentTimeMillis()}"
            val dir = File(context.cacheDir, "picked").apply { mkdirs() }
            val out = File(dir, name.replace('/', '_'))
            context.contentResolver.openInputStream(uri)?.use { input ->
                out.outputStream().use { input.copyTo(it, 256 * 1024) }
            } ?: throw IOException("Could not read the selected file")
            JSObject().apply {
                put("path", out.absolutePath)
                put("name", name)
            }
        }
    }

    private fun displayName(uri: Uri): String? =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    @PluginMethod
    fun openUrl(call: PluginCall) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(req(call, "url")))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (t: Throwable) {
            call.reject(t.message ?: "Could not open link")
        }
    }

    @PluginMethod
    fun toast(call: PluginCall) {
        val text = call.getString("text") ?: ""
        Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_LONG).show() }
        call.resolve()
    }
}
