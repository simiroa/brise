package com.brise.shell

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import androidx.core.content.IntentCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 다른 앱에서 `ACTION_SEND` / `ACTION_SEND_MULTIPLE`(MIME text/plain 과 image 계열)로 넘어온 내용 받기 — 사용자에게는 "가져오기".
 * 받은 것을 노트로 만들지는 않는다(오너 결정 Q-S3 (b)): 페이지가 입력 화면 **초안**을 채우고 사용자가 저장해야 노트가 된다.
 *
 * 흐름
 *  1. [accept] — 인텐트의 텍스트·제목·스트림 URI 를 읽고, 이미지를 앱 캐시(`cache/import/<id>/<idx>`)로 **즉시 복사**한다
 *     (URI 권한은 이 액티비티가 살아 있는 동안만 유효하고, 페이지가 저장하기를 누르기까지는 오래 걸릴 수 있다).
 *     복사는 단일 스레드 실행기에서 한다 — 같은 실행기가 [pending]·[ack] 도 처리하므로 복사가 끝나기 전에 온
 *     페이지의 당겨오기는 자연히 복사 뒤로 미뤄진다.
 *  2. 페이지가 브리지로 `getPendingImport` 를 보내면 [pending] 이 메타데이터 JSON 을 돌려준다(**읽기만** — ack 전에는 같은
 *     배치를 계속 준다). 이미지 바이트는 메시지에 싣지 않는다: 25MB 한 장이 base64 로 33MB 문자열이 되어 WebMessage·JSON.parse 를
 *     지나게 하지 않으려고, 페이지가 `/__shell/import/<id>/<idx>` 를 fetch 하면 [serve] 가 WebView 요청 가로채기로 스트림을 내준다
 *     (프록시 소켓을 거치지 않으므로 같은 폰의 다른 앱이 닿을 수 없다).
 *  3. 페이지가 `ackImport` 로 끝냄을 알리면 [ack] 가 그 가져오기의 임시 파일을 지운다. 새 가져오기가 와도 **이전 것을 지우지 않는다** —
 *     페이지가 이전 가져오기의 사진을 백그라운드로 올리는 중일 수 있다(노트가 이미 된 뒤 나가는 길). ack 전 가져오기는 최대
 *     [MAX_BATCHES] 개까지 쥐고, 넘으면 가장 오래된 것부터 지운다. [pending] 은 그중 가장 최근 것을 준다(이전 것은 페이지가 이미 채워
 *     쥐고 있거나, 최근 것이 ack 된 뒤에 다시 준다 — 페이지가 이미 채운 id 는 ack 만 다시 한다).
 *
 * 상한은 조용히 버리지 않고 항목의 `error` 로 알린다: 25MB 초과(`too_large`) · 이미지가 아님(`unsupported`) · 읽기 실패
 * (`read_failed`) · 개수/총량 초과. 상한 값은 페이지 mobileImport.ts 와 같다(서버 첨부 상한 25MB 를 따른다).
 *
 * 보안: `content://` 스트림만 받는다. 이 액티비티는 exported 라 아무 앱이나 인텐트를 보낼 수 있고, `file://` 을 읽어 주면
 * 우리 앱 비공개 저장소(프록시 시크릿·진단 큐)를 페이지로 빼내는 통로가 된다. 진단 로그에는 코드·개수만 남긴다(이름·URI·본문 금지).
 */
class ShellImport private constructor(private val ctx: Context) {
    companion object {
        @Volatile private var instance: ShellImport? = null

        /**
         * 프로세스당 하나(M-17). 액티비티마다 새로 만들면 init 의 `cache/import` 청소가 액티비티 재생성(밤 모드·글꼴 크기 변경 등)마다 돌아
         * ack 전 가져오기의 사진이 사라진다. 청소는 **프로세스가 시작될 때 한 번**이다. ctx 는 applicationContext 로 쥔다(액티비티를 붙들지 않는다).
         */
        fun shared(ctx: Context): ShellImport =
            instance ?: synchronized(this) { instance ?: ShellImport(ctx.applicationContext).also { instance = it } }

        const val ROUTE_PREFIX = "/__shell/import/"
        const val MAX_FILE_BYTES = 25L * 1024 * 1024
        const val MAX_TOTAL_BYTES = 100L * 1024 * 1024
        const val MAX_FILES = 20
        const val MAX_TEXT_CHARS = 1_000_000
        /** UTF-8 은 문자당 최대 4바이트 — 텍스트 파일 읽기의 바이트 상한(넘으면 통째로 거절). */
        private const val MAX_TEXT_BYTES = MAX_TEXT_CHARS * 4
        /** 한 인텐트에서 훑는 URI 수 방어선(악의적으로 큰 SEND_MULTIPLE). */
        private const val MAX_URIS = 500
        /**
         * ack 전에 쥐는 가져오기 수. 가져오기당 파일은 최대 [MAX_TOTAL_BYTES] 라 캐시 상한은 이 곱이다.
         * ponytail: 연달아 이 수를 넘게 공유하면서 가장 오래된 것의 사진이 아직 올라가는 중이면 그 사진은 404 로 버려진다.
         * 그럴 일은 사실상 없다고 보고 크기가 아니라 개수로만 막았다 — 실제로 겪으면 총량(바이트) 상한으로 바꾼다.
         */
        const val MAX_BATCHES = 3
    }

    private class Item(val idx: Int, val name: String, val mime: String, val size: Long, val file: File?, val error: String?)
    private class Batch(
        val id: String,
        val text: String?,
        val subject: String?,
        val textError: Boolean,
        val items: List<Item>,
        val omitted: Int,
        val dir: File,
    )

    private val root = File(ctx.cacheDir, "import")
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "shell-import").apply { isDaemon = true } }
    private val lock = Any()
    /** ack 전 가져오기 — 도착 순서(가장 오래된 것이 앞). [lock] 안에서만 읽고 쓴다. */
    private val batches = LinkedHashMap<String, Batch>()

    // 이전 프로세스가 남긴 임시 파일 — 같은 실행기라 아래 staging 보다 먼저 돈다. 싱글턴이라 프로세스당 한 번만 돈다.
    init { exec.execute { root.deleteRecursively() } }

    /**
     * 인텐트가 가져오기면 읽어서 복사를 시작한다. 복사가 끝나면(성공이든 일부 실패든) [onStaged] 를 부른다(UI 스레드 아님).
     * @return 우리가 처리한 인텐트인가 — 아니면 호출자가 평소대로 다룬다.
     */
    fun accept(intent: Intent, onStaged: () -> Unit): Boolean {
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
        // 최근 앱 목록에서 다시 열면 시스템이 원래 인텐트를 다시 준다 — 이미 처리한 가져오기를 또 받지 않는다.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
        val text: String?
        val subject: String?
        val uris = LinkedHashSet<Uri>()
        val declaredType: String?
        try {
            text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: clipText(intent.clipData)
            subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE)?.toString()
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
            intent.clipData?.let { clip ->
                for (i in 0 until minOf(clip.itemCount, MAX_URIS)) clip.getItemAt(i).uri?.let { uris.add(it) }
            }
            declaredType = intent.type
        } catch (e: Exception) {
            ShellDiag.warn("import", "intent_read_failed", e.javaClass.simpleName)
            return true
        }
        exec.execute {
            try {
                stage(text, subject, uris.toList().take(MAX_URIS), uris.size, declaredType)
            } catch (e: Throwable) {
                ShellDiag.error("import", "stage_failed", e.javaClass.simpleName)
            }
            onStaged()
        }
        return true
    }

    private fun clipText(clip: ClipData?): String? {
        if (clip == null || clip.itemCount == 0) return null
        return clip.getItemAt(0).text?.toString()
    }

    private fun stage(text: String?, subject: String?, uris: List<Uri>, totalUris: Int, declaredType: String?) {
        val id = UUID.randomUUID().toString().replace("-", "")
        val dir = File(root, id).apply { mkdirs() }
        var body = text?.takeIf { it.isNotBlank() }
        var textError = false
        if (body != null && body.length > MAX_TEXT_CHARS) { body = null; textError = true }
        val hadExtraText = body != null || textError
        val items = ArrayList<Item>()
        var total = 0L
        var omitted = maxOf(0, totalUris - uris.size)
        var fileCount = 0
        for ((i, uri) in uris.withIndex()) {
            if (fileCount >= MAX_FILES) { omitted += uris.size - i; break }
            val (displayName, declaredSize) = queryMeta(uri)
            val name = displayName ?: uri.lastPathSegment?.substringAfterLast('/') ?: "imported-$i"
            val mime = (try { ctx.contentResolver.getType(uri) } catch (_: Exception) { null })
                ?: declaredType?.takeIf { !it.endsWith("/*") }
                ?: guessMime(name)
            if (uri.scheme != "content") {
                items.add(Item(i, name, mime, declaredSize, null, "unsupported")); ShellDiag.warn("import", "non_content_uri"); continue
            }
            if (mime.equals("text/plain", true)) {
                // 텍스트 파일로 온 공유 — EXTRA_TEXT 가 따로 있으면 그쪽이 같은 내용이다(중복이라 버린다).
                if (!hadExtraText && body == null && !textError) {
                    when (val r = readText(uri)) {
                        is TextRead.Ok -> body = r.text.takeIf { it.isNotBlank() }
                        TextRead.TooLarge -> textError = true
                        TextRead.Failed -> items.add(Item(i, name, mime, declaredSize, null, "read_failed"))
                    }
                }
                continue
            }
            if (!mime.startsWith("image/", true)) { items.add(Item(i, name, mime, declaredSize, null, "unsupported")); continue }
            if (declaredSize > MAX_FILE_BYTES || (declaredSize >= 0 && total + declaredSize > MAX_TOTAL_BYTES)) {
                items.add(Item(i, name, mime, declaredSize, null, "too_large")); continue
            }
            val dest = File(dir, i.toString())
            val copied = try {
                copyCapped(uri, dest, minOf(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total))
            } catch (e: Exception) {
                ShellDiag.warn("import", "copy_failed", e.javaClass.simpleName)
                dest.delete()
                items.add(Item(i, name, mime, declaredSize, null, "read_failed")); continue
            }
            if (copied < 0) { dest.delete(); items.add(Item(i, name, mime, declaredSize, null, "too_large")); continue }
            total += copied
            fileCount++
            items.add(Item(i, name, mime, copied, dest, null))
        }
        val subjectClean = subject?.takeIf { it.isNotBlank() }
        if (body == null && subjectClean == null && !textError && items.isEmpty() && omitted == 0) {
            dir.deleteRecursively()
            ShellDiag.warn("import", "empty_intent")
            return
        }
        val batch = Batch(id, body, subjectClean, textError, items, omitted, dir)
        val evicted = ArrayList<Batch>()
        synchronized(lock) {
            batches[id] = batch
            // 이전 가져오기는 지우지 않는다(위 3번) — 개수 상한을 넘은 가장 오래된 것만 치운다.
            val it = batches.entries.iterator()
            while (batches.size > MAX_BATCHES && it.hasNext()) {
                evicted.add(it.next().value)
                it.remove()
            }
        }
        for (b in evicted) {
            b.dir.deleteRecursively()
            ShellDiag.warn("import", "batch_evicted", "kept=$MAX_BATCHES")
        }
        ShellDiag.info("import", "staged", "files=${items.count { it.file != null }} errors=${items.count { it.error != null }} text=${body != null}")
    }

    private fun queryMeta(uri: Uri): Pair<String?, Long> {
        try {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    val name = if (ni >= 0 && !c.isNull(ni)) c.getString(ni) else null
                    val size = if (si >= 0 && !c.isNull(si)) c.getLong(si) else -1L
                    return name to size
                }
            }
        } catch (_: Exception) { /* 메타를 못 읽어도 복사는 시도한다 */ }
        return null to -1L
    }

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    /** @return 복사한 바이트 수, 상한을 넘으면 -1(부분 파일은 호출자가 지운다). 읽기 실패는 던진다. */
    private fun copyCapped(uri: Uri, dest: File, cap: Long): Long {
        val input = ctx.contentResolver.openInputStream(uri) ?: throw java.io.FileNotFoundException("no stream")
        input.use { src ->
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var n = 0L
                while (true) {
                    val r = src.read(buf)
                    if (r < 0) break
                    n += r
                    if (n > cap) return -1
                    out.write(buf, 0, r)
                }
                return n
            }
        }
    }

    private sealed class TextRead {
        class Ok(val text: String) : TextRead()
        object TooLarge : TextRead()
        object Failed : TextRead()
    }

    private fun readText(uri: Uri): TextRead = try {
        val input = ctx.contentResolver.openInputStream(uri)
        if (input == null) TextRead.Failed else input.use { src ->
            // InputStream.readNBytes 는 API 33+ 라 minSdk 26 에서 못 쓴다 — 상한까지만 읽는 루프.
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            var tooLarge = false
            while (true) {
                val r = src.read(buf)
                if (r < 0) break
                out.write(buf, 0, r)
                if (out.size() > MAX_TEXT_BYTES) { tooLarge = true; break }
            }
            if (tooLarge) TextRead.TooLarge
            else {
                val s = String(out.toByteArray(), Charsets.UTF_8)
                if (s.length > MAX_TEXT_CHARS) TextRead.TooLarge else TextRead.Ok(s)
            }
        }
    } catch (e: Exception) {
        ShellDiag.warn("import", "text_read_failed", e.javaClass.simpleName)
        TextRead.Failed
    }

    /** ack 전 가져오기 중 가장 최근 것(없으면 null). 복사가 진행 중이면 끝난 뒤에 콜백한다. 임의 스레드에서 호출 가능, 콜백은 실행기 스레드. */
    fun pending(cb: (JSONObject?) -> Unit) {
        exec.execute {
            val latest = synchronized(lock) { batches.values.lastOrNull() }
            cb(latest?.let { toJson(it) })
        }
    }

    /** 페이지가 이 가져오기를 끝냈다(저장했거나 버렸다) — 그 가져오기의 임시 파일만 지운다. 모르는 id 면 아무것도 안 한다. */
    fun ack(importId: String, cb: () -> Unit) {
        exec.execute {
            val gone = synchronized(lock) { batches.remove(importId) }
            gone?.dir?.deleteRecursively()
            cb()
        }
    }

    private fun notFound() =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    /**
     * `/__shell/import/<id>/<idx>` 요청에 이미지 스트림으로 답한다. ack 전인 가져오기면 어느 것이든 준다(최근 것이 아니어도).
     * 모르는 id·idx 는 404. WebView 의 IO 스레드에서 불린다.
     */
    fun serve(path: String): WebResourceResponse {
        val parts = path.removePrefix(ROUTE_PREFIX).split('/')
        val b = if (parts.size == 2) synchronized(lock) { batches[parts[0]] } else null
        val idx = parts.getOrNull(1)?.toIntOrNull()
        val file = b?.items?.firstOrNull { it.idx == idx && it.file != null }
        val f = file?.file
        if (file == null || f == null || !f.isFile) return notFound()
        // 열기는 잠금 밖에서 — ack/축출이 그 사이 파일을 지웠으면(열린 스트림은 지운 뒤에도 읽힌다) 404.
        val stream = try { FileInputStream(f) } catch (_: java.io.FileNotFoundException) { return notFound() }
        return WebResourceResponse(
            file.mime, null, 200, "OK",
            mapOf("Cache-Control" to "no-store", "Content-Length" to f.length().toString()),
            stream,
        )
    }

    private fun toJson(b: Batch): JSONObject {
        val items = JSONArray()
        for (it in b.items) {
            items.put(
                JSONObject().put("idx", it.idx).put("name", it.name).put("mime", it.mime).put("size", it.size)
                    .also { o -> if (it.error != null) o.put("error", it.error) },
            )
        }
        return JSONObject().put("importId", b.id).put("items", items).put("omitted", b.omitted).put("textError", b.textError)
            .also { o ->
                if (b.text != null) o.put("text", b.text)
                if (b.subject != null) o.put("subject", b.subject)
            }
    }
}
