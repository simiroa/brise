package com.brise.shell

import android.content.Context
import android.net.Uri
import java.net.HttpURLConnection
import java.net.URL

/**
 * 저장되는 연결 정보. 사용자가 PC 설정 > 연결에서 복사한 주소(`http://<ip>:<port>/app?token=...`)를 분해한 것.
 * 토큰은 [pathQuery] 에 넣지 않고 따로 둔다 — 로그·화면에 URL 을 찍을 때 실수로 새지 않게.
 */
data class Conn(val scheme: String, val host: String, val port: Int, val pathQuery: String, val token: String) {
    /** PC 서버 origin (프록시 업스트림). */
    val origin: String get() = "$scheme://${if (host.contains(':')) "[$host]" else host}:$port"

    /** 프록시 origin 위에서 열 URL: 저장된 path/query + 토큰(웹 UI 가 sessionStorage 에 옮기고 주소창에서 지움). */
    fun localUrl(proxyPort: Int): String {
        val sep = if (pathQuery.contains('?')) "&" else "?"
        return "http://localhost:$proxyPort$pathQuery${sep}token=${Uri.encode(token)}"
    }

    /** 화면 표시용 요약: origin + 경로(쿼리·토큰 제외). "토큰 있음" 표시는 호출 쪽 문구(setup_parsed)가 맡는다. */
    fun summary(): String = "$origin${pathQuery.substringBefore('?')}"
}

sealed class ParseResult {
    data class Ok(val conn: Conn) : ParseResult()
    data class Fail(val reasonRes: Int) : ParseResult()
}

object ConnParser {
    fun parse(rawIn: String): ParseResult {
        val raw = rawIn.trim()
        if (raw.isEmpty()) return ParseResult.Fail(R.string.err_empty)
        val u = try { Uri.parse(raw) } catch (_: Exception) { return ParseResult.Fail(R.string.err_scheme) }
        val scheme = u.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return ParseResult.Fail(R.string.err_scheme)
        val host = u.host?.takeIf { it.isNotBlank() } ?: return ParseResult.Fail(R.string.err_no_host)
        val port = if (u.port > 0) u.port else if (scheme == "https") 443 else 80
        val token = u.getQueryParameter("token")?.takeIf { it.isNotBlank() } ?: return ParseResult.Fail(R.string.err_no_token)
        val path = u.encodedPath?.takeIf { it.isNotEmpty() && it != "/" } ?: "/app"
        val rest = (u.encodedQuery ?: "").split('&').filter { it.isNotEmpty() && !it.startsWith("token=") }
        val pathQuery = if (rest.isEmpty()) path else path + "?" + rest.joinToString("&")
        return ParseResult.Ok(Conn(scheme, host, port, pathQuery, token))
    }

    /** 100.64.0.0/10(Tailscale CGNAT) · localhost · *.ts.net(MagicDNS) 이면 true. 아니면 저장 전 경고(차단 아님). */
    fun isExpectedHost(host: String): Boolean {
        val h = host.lowercase()
        if (h == "localhost" || h == "127.0.0.1" || h == "::1" || h.endsWith(".ts.net")) return true
        val p = h.split('.')
        if (p.size != 4) return false
        val n = p.map { it.toIntOrNull() ?: return false }
        return n[0] == 100 && n[1] in 64..127
    }
}

/**
 * ponytail: 앱 비공개 SharedPreferences(다른 앱은 못 읽음, allowBackup=false). 루팅·디버그 빌드의 `run-as` 로는 읽힌다.
 * EncryptedSharedPreferences(androidx.security-crypto)는 deprecated 라 들이지 않았다 — 천장을 올리려면
 * AndroidKeyStore 로 AES-GCM 키를 만들어 토큰만 암호화해 저장하는 방식으로 교체(저장 형식은 이 클래스 안에 갇혀 있음).
 */
class ConnStore(ctx: Context) {
    private val p = ctx.getSharedPreferences("brise_conn", Context.MODE_PRIVATE)

    fun load(): Conn? {
        val token = p.getString("token", null) ?: return null
        return Conn(
            p.getString("scheme", null) ?: return null,
            p.getString("host", null) ?: return null,
            p.getInt("port", -1).takeIf { it > 0 } ?: return null,
            p.getString("pathQuery", "/app") ?: "/app",
            token,
        )
    }

    fun save(c: Conn) {
        p.edit().putString("scheme", c.scheme).putString("host", c.host).putInt("port", c.port)
            .putString("pathQuery", c.pathQuery).putString("token", c.token).apply()
    }

    /** 프록시가 마지막으로 바인딩한 포트(origin 고정용). */
    var proxyPort: Int
        get() = p.getInt("proxyPort", 17332)
        set(v) { p.edit().putInt("proxyPort", v).apply() }
}

sealed class PingResult {
    object Ok : PingResult()
    object AuthFail : PingResult()
    data class Other(val code: Int) : PingResult()
    data class Unreachable(val why: String) : PingResult()
}

object Ping {
    /** 블로킹 — 백그라운드 스레드에서 호출. Bearer 헤더로 `/api/v1/ping`(토큰은 URL 에 싣지 않음). */
    fun run(c: Conn): PingResult {
        return try {
            val conn = URL(c.origin + "/api/v1/ping").openConnection() as HttpURLConnection
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            conn.setRequestProperty("Authorization", "Bearer ${c.token}")
            conn.useCaches = false
            try {
                when (val code = conn.responseCode) {
                    200 -> PingResult.Ok
                    401, 403 -> PingResult.AuthFail
                    else -> PingResult.Other(code)
                }
            } finally { conn.disconnect() }
        } catch (e: Exception) {
            PingResult.Unreachable(e.javaClass.simpleName + ": " + (e.message ?: "").take(80))
        }
    }
}

/** 로그에 URL 이 들어갈 때는 항상 이걸 거친다. */
fun redact(s: String): String = Regex("(token=)[^&#\\s\"']+").replace(s, "\$1REDACTED")
