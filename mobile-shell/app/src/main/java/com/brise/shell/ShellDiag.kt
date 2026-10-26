package com.brise.shell

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** 셸의 logcat 태그 — 모든 파일이 이걸 쓴다(파일마다 상수를 따로 두지 않는다). */
const val LOG_TAG = "BriseShell"

/**
 * 셸(네이티브) 쪽 진단 기록을 PC 의 진단 싱크(`diag_record`, source="android-shell")로 보낸다.
 *
 * 왜: 셸의 실패(프록시 바인드·업스트림 실패·권한 거부·파일 선택기 등)는 logcat 에만 남아 USB 를
 * 떼면 아무도 못 본다. 웹 쪽(`/app`)은 이미 `src/lib/diag.ts` 가 같은 싱크로 보내므로(AI 히스토리
 * 창 "진단" 탭, PC data_dir 의 `diag.jsonl`), 셸도 같은 곳에 남겨 한 화면에서 본다.
 *
 * - PC 에 못 닿으면 앱 비공개 저장소의 대기열(최대 [MAX_QUEUE]건, 오래된 것부터 버림)에 쌓았다가
 *   다음 기록·페이지 로드 성공 때 보낸다. 기록 자체가 실패해도 앱 동작에는 영향이 없다.
 * - 메시지는 [redact] 후 300자로 자른다(PC 도 300자로 자른다). 노트 본문·전체 경로 금지(CLAUDE.md 함정 11).
 * - 전송 실패는 이 모듈 안에서 logcat 으로만 남긴다 — 자기 자신을 다시 기록하면 무한 루프가 된다.
 *
 * ponytail: 대기열은 SharedPreferences 의 JSON 문자열 하나(최대 100건, 수 KB). 천장 = 장시간
 * 오프라인에서 오래된 기록 유실. 업그레이드 = 파일 기반 링버퍼.
 */
object ShellDiag {
    private const val PREFS = "shell_diag"
    private const val KEY = "queue"
    private const val MAX_QUEUE = 100
    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var appCtx: Context? = null

    fun init(ctx: Context) { appCtx = ctx.applicationContext }

    fun warn(feature: String, code: String, message: String = "") = record("warn", feature, code, message)
    fun error(feature: String, code: String, message: String = "") = record("error", feature, code, message)
    fun info(feature: String, code: String, message: String = "") = record("info", feature, code, message)

    private fun record(level: String, feature: String, code: String, message: String) {
        val msg = redact(message).take(300)
        val line = "[$feature/$code] $msg"
        when (level) { "error" -> Log.e(LOG_TAG, line); "warn" -> Log.w(LOG_TAG, line); else -> Log.i(LOG_TAG, line) }
        val ctx = appCtx ?: return
        io.execute {
            enqueue(ctx, JSONObject().put("level", level).put("feature", feature).put("code", code).put("message", msg).put("at", System.currentTimeMillis()))
            flushBlocking(ctx)
        }
    }

    /** 연결이 막 살아났을 때(페이지 로드 성공 등) 쌓인 기록을 보낸다. */
    fun flush() { val ctx = appCtx ?: return; io.execute { flushBlocking(ctx) } }

    private fun enqueue(ctx: Context, item: JSONObject) {
        val q = load(ctx)
        q.put(item)
        val trimmed = JSONArray()
        val start = maxOf(0, q.length() - MAX_QUEUE)
        for (i in start until q.length()) trimmed.put(q.get(i))
        save(ctx, trimmed)
    }

    private fun flushBlocking(ctx: Context) {
        val conn = ConnStore(ctx).load() ?: return
        val q = load(ctx)
        var sent = 0
        while (sent < q.length()) {
            val item = q.getJSONObject(sent)
            if (!post(conn, item)) break
            sent++
        }
        if (sent == 0) return
        val rest = JSONArray()
        for (i in sent until q.length()) rest.put(q.get(i))
        save(ctx, rest)
    }

    private fun post(c: Conn, item: JSONObject): Boolean = try {
        val args = JSONObject()
            .put("source", "android-shell")
            .put("feature", item.optString("feature"))
            .put("code", item.optString("code"))
            .put("level", item.optString("level"))
            // PC 는 받은 시각을 ts 로 찍는다 — 오프라인에 쌓였다 늦게 간 기록이 언제 일어났는지 남기려고
            // 폰의 발생 시각(로컬)을 앞에 붙인다.
            .put("message", "[phone " + java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date(item.optLong("at", System.currentTimeMillis()))) + "] " + item.optString("message"))
        val body = JSONObject().put("cmd", "diag_record").put("args", args).toString().toByteArray()
        val h = URL(c.origin + "/api/v1/invoke").openConnection() as HttpURLConnection
        h.connectTimeout = 3000
        h.readTimeout = 3000
        h.requestMethod = "POST"
        h.doOutput = true
        h.setRequestProperty("Content-Type", "application/json")
        h.setRequestProperty("Authorization", "Bearer ${c.token}")
        h.setFixedLengthStreamingMode(body.size)
        try {
            h.outputStream.use { it.write(body) }
            // 200 이면 기록됨(상한 초과로 버려진 ok:false 도 재시도할 이유가 없다).
            // 4xx 는 다시 보내도 같으므로 대기열에서 빼기 위해 true 로 취급한다.
            h.responseCode in 200..499
        } finally { h.disconnect() }
    } catch (e: Exception) {
        Log.d(LOG_TAG, "diag flush deferred: ${e.javaClass.simpleName}")
        false
    }

    private fun load(ctx: Context): JSONArray = try {
        JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]"))
    } catch (_: Exception) { JSONArray() }

    private fun save(ctx: Context, q: JSONArray) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, q.toString()).apply()
    }
}
