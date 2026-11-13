package com.vrcyberdeck.app

import dadb.AdbKeyPair
import dadb.Dadb
import okio.Buffer
import okio.ForwardingSource
import okio.Source
import okio.source
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Wireless ADB connections to headsets, backed by dadb (pure-Kotlin ADB
 * protocol client). The phone acts as the ADB host, so the headset will show
 * the usual "Allow USB debugging?" prompt for this app's key the first time.
 */
class AdbManager(private val keyDir: File) {

    private val connections = ConcurrentHashMap<String, Dadb>()
    private val connectExecutor = Executors.newCachedThreadPool()

    private val keyPair: AdbKeyPair by lazy {
        val priv = File(keyDir, "adbkey")
        val pub = File(keyDir, "adbkey.pub")
        if (!priv.exists() || !pub.exists()) AdbKeyPair.generate(priv, pub)
        AdbKeyPair.read(priv, pub)
    }

    fun publicKey(): String {
        keyPair // ensure generated
        return File(keyDir, "adbkey.pub").readText()
    }

    fun connect(host: String, port: Int, timeoutMs: Long): String {
        val serial = "$host:$port"
        connections.remove(serial)?.let { runCatching { it.close() } }
        val dadb = Dadb.create(host, port, keyPair, 8000, 0, true)
        // dadb connects lazily; force the CNXN/AUTH handshake now, bounded so a
        // headset that never answers the auth prompt doesn't hang forever.
        val handshake = connectExecutor.submit<Boolean> { dadb.supportsFeature("shell_v2") }
        try {
            handshake.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            handshake.cancel(true)
            runCatching { dadb.close() }
            throw IOException(
                "Timed out waiting for $serial. Put the headset on and accept the " +
                    "\"Allow USB debugging\" prompt, then try again."
            )
        } catch (e: ExecutionException) {
            runCatching { dadb.close() }
            val cause = e.cause ?: e
            throw IOException(
                "Could not connect to $serial (${cause.message ?: cause.javaClass.simpleName}). " +
                    "Make sure ADB over Wi-Fi is enabled on the headset (adb tcpip 5555).",
                cause
            )
        }
        connections[serial] = dadb
        return serial
    }

    fun disconnect(serial: String) {
        connections.remove(serial)?.let { runCatching { it.close() } }
    }

    fun connected(): List<String> = connections.keys.toList()

    private fun get(serial: String): Dadb =
        connections[serial] ?: throw IOException("Device $serial is not connected")

    fun shell(serial: String, command: String): Pair<String, Int> {
        val res = get(serial).shell(command)
        return res.allOutput to res.exitCode
    }

    /** Pushes a file, or a directory's contents, to [remotePath]. */
    fun push(
        serial: String,
        local: File,
        remotePath: String,
        cancel: () -> Boolean,
        progress: (Long, Long) -> Unit
    ): Pair<Int, Long> {
        val dadb = get(serial)
        val files: List<Pair<File, String>> = if (local.isDirectory) {
            local.walkTopDown().filter { it.isFile }.map { f ->
                f to remotePath.trimEnd('/') + "/" + f.relativeTo(local).invariantSeparatorsPath
            }.toList()
        } else {
            listOf(local to remotePath)
        }
        val total = files.sumOf { it.first.length() }
        var done = 0L
        for ((file, remote) in files) {
            val base = done
            val source = CountingSource(file.source(), cancel) { n -> progress(base + n, total) }
            val result = dadb.push(source, remote, 420 /* 0644 */, file.lastModified())
            if (result is dadb.SyncResult.Failure) {
                throw IOException("Failed to push ${file.name}: ${result.reason}")
            }
            done += file.length()
            progress(done, total)
        }
        return files.size to total
    }

    /** Installs an APK, streaming it to the package manager with progress. */
    fun install(
        serial: String,
        apk: File,
        options: List<String>,
        cancel: () -> Boolean,
        progress: (Long, Long) -> Unit
    ): Pair<Boolean, String> {
        val dadb = get(serial)
        val size = apk.length()
        if (dadb.supportsFeature("cmd")) {
            dadb.execCmd("package", "install", "-S", size.toString(), *options.toTypedArray())
                .use { stream ->
                    val source = CountingSource(apk.source(), cancel) { n -> progress(n, size) }
                    stream.sink.writeAll(source)
                    stream.sink.flush()
                    val response = stream.source.readUtf8()
                    return response.trim().startsWith("Success") to response.trim()
                }
        }
        val remote = "/data/local/tmp/vrcd-install.apk"
        push(serial, apk, remote, cancel, progress)
        val (out, _) = shell(serial, "pm install ${options.joinToString(" ")} \"$remote\"; rm -f \"$remote\"")
        return out.trim().startsWith("Success") to out.trim()
    }

    private class CountingSource(
        delegate: Source,
        private val cancel: () -> Boolean,
        private val onCount: (Long) -> Unit
    ) : ForwardingSource(delegate) {
        private var count = 0L
        override fun read(sink: Buffer, byteCount: Long): Long {
            if (cancel()) throw IOException("Cancelled")
            val n = super.read(sink, byteCount)
            if (n > 0) {
                count += n
                onCount(count)
            }
            return n
        }
    }
}
