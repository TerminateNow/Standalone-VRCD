package com.vrcyberdeck.app

import org.apache.commons.compress.archivers.sevenz.SevenZFile
import org.apache.commons.compress.utils.MultiReadOnlySeekableByteChannel
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

/** HTTP transfers and 7z extraction, replacing rclone and 7-Zip on Android. */
object Transfers {

    private const val CONNECT_TIMEOUT = 20_000
    private const val READ_TIMEOUT = 60_000

    private fun open(url: String, method: String, headers: Map<String, String>): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = CONNECT_TIMEOUT
        conn.readTimeout = READ_TIMEOUT
        conn.instanceFollowRedirects = true
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return conn
    }

    fun getText(url: String, headers: Map<String, String>): Pair<Int, String> {
        val conn = open(url, "GET", headers)
        try {
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return status to body
        } finally {
            conn.disconnect()
        }
    }

    fun head(url: String, headers: Map<String, String>): Pair<Int, Long> {
        val conn = open(url, "HEAD", headers)
        try {
            return conn.responseCode to conn.contentLengthLong
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Downloads [url] to [dest], resuming from `<dest>.partial` when the server
     * honours Range requests. Returns the HTTP status and final size.
     */
    fun download(
        url: String,
        dest: File,
        headers: Map<String, String>,
        cancel: () -> Boolean,
        progress: (Long, Long) -> Unit
    ): Pair<Int, Long> {
        dest.parentFile?.mkdirs()
        val partial = File(dest.path + ".partial")
        var offset = if (partial.exists()) partial.length() else 0L
        val reqHeaders = if (offset > 0) headers + ("Range" to "bytes=$offset-") else headers
        val conn = open(url, "GET", reqHeaders)
        try {
            val status = conn.responseCode
            if (status == 416 && offset > 0) {
                // Partial already complete.
                partial.renameTo(dest)
                return 200 to dest.length()
            }
            if (status >= 400) return status to 0L
            val append = status == 206 && offset > 0
            if (!append) offset = 0
            val length = conn.contentLengthLong
            val total = if (length >= 0) offset + length else -1L
            conn.inputStream.use { input ->
                FileOutputStream(partial, append).use { output ->
                    val buf = ByteArray(256 * 1024)
                    var done = offset
                    while (true) {
                        if (cancel()) throw IOException("Cancelled")
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        done += n
                        progress(done, total)
                    }
                }
            }
            if (dest.exists()) dest.delete()
            if (!partial.renameTo(dest)) throw IOException("Could not finalize ${dest.name}")
            return status to dest.length()
        } finally {
            conn.disconnect()
        }
    }

    /** All volumes of a split archive (`name.7z.001`, `.002`, …) in order. */
    private fun volumes(archive: File): List<File> {
        val m = Regex("^(.*\\.7z)\\.(\\d+)$", RegexOption.IGNORE_CASE).find(archive.name)
            ?: return listOf(archive)
        val stem = m.groupValues[1]
        val width = m.groupValues[2].length
        val parts = mutableListOf<File>()
        var i = 1
        while (true) {
            val f = File(archive.parentFile, "$stem.${i.toString().padStart(width, '0')}")
            if (!f.exists()) break
            parts.add(f)
            i++
        }
        return if (parts.isEmpty()) listOf(archive) else parts
    }

    fun extract7z(
        archive: File,
        destDir: File,
        password: String?,
        stripPrefix: String?,
        cancel: () -> Boolean,
        progress: (Long, Long) -> Unit
    ): Int {
        val parts = volumes(archive)
        val channel = if (parts.size == 1) {
            FileChannel.open(parts[0].toPath(), StandardOpenOption.READ)
        } else {
            MultiReadOnlySeekableByteChannel.forFiles(*parts.toTypedArray())
        }
        val builder = SevenZFile.builder().setSeekableByteChannel(channel)
        if (!password.isNullOrEmpty()) builder.setPassword(password)
        val canonicalDest = destDir.canonicalFile
        canonicalDest.mkdirs()
        var count = 0
        builder.get().use { sevenZ ->
            val total = sevenZ.entries.sumOf { if (it.isDirectory) 0L else it.size }
            var done = 0L
            val buf = ByteArray(256 * 1024)
            while (true) {
                val entry = sevenZ.nextEntry ?: break
                var name = entry.name.replace('\\', '/')
                if (!stripPrefix.isNullOrEmpty() && name.startsWith(stripPrefix)) {
                    name = name.substring(stripPrefix.length)
                } else if (!stripPrefix.isNullOrEmpty() && name == stripPrefix.trimEnd('/')) {
                    continue
                }
                if (name.isEmpty()) continue
                val out = File(canonicalDest, name).canonicalFile
                if (!out.path.startsWith(canonicalDest.path + File.separator)) {
                    throw IOException("Archive entry escapes target folder: ${entry.name}")
                }
                if (entry.isDirectory) {
                    out.mkdirs()
                    continue
                }
                out.parentFile?.mkdirs()
                FileOutputStream(out).use { os ->
                    while (true) {
                        if (cancel()) throw IOException("Cancelled")
                        val n = sevenZ.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        done += n
                        progress(done, total)
                    }
                }
                count++
            }
        }
        return count
    }
}
