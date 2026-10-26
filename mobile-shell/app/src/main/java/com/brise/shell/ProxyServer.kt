package com.brise.shell

import android.util.Log
import java.io.BufferedInputStream
import java.io.EOFException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

const val SHELL_COOKIE = "brise_shell"

/**
 * 최소 localhost 리버스 프록시. 목적: WebView 의 페이지 origin 을 http://localhost:<port> 로 만들어
 * 보안 컨텍스트(마이크·카메라 API)를 얻는 것.
 *
 * 선택 이유: 외부 의존성 0 — ServerSocket 최소 HTTP/1.1 파서 + HttpURLConnection(스트리밍 모드 지원).
 * NanoHTTPD 는 응답 flush/청크가 버전마다 달라 SSE 검증이 번거롭고, OkHttp 는 의존성만 늘린다.
 *
 * 보안 불변식:
 *  - 127.0.0.1 에만 바인딩(0.0.0.0 금지).
 *  - 타깃은 생성 시점에 고정된 단일 scheme://host:port. 요청 URL/Host 로 다른 곳에 중계하지 않는다
 *    (요청 라인은 path+query 만 사용, 절대 URL 이면 거부). 오픈 프록시 아님.
 *  - Host 헤더가 localhost:<port>/127.0.0.1:<port> 가 아니면 403 (DNS 리바인딩 방지).
 *  - 셸 시크릿 쿠키([SHELL_COOKIE]=<secret>)가 없는 요청은 403. 같은 폰의 다른 앱은 이 값을 알 수 없다
 *    (WebView 쿠키 저장소는 앱 비공개). 쿠키는 업스트림으로 넘기기 전에 제거한다.
 *  ponytail: 천장 — 같은 UID 의 코드·루팅·WebView 원격 디버깅(디버그 빌드)은 시크릿을 볼 수 있다.
 *
 * Brise sync_server 는 쿠키를 쓰지 않는다(인증은 Bearer/?token=, `cookie` 검색 결과 0건). 그래서 다른 쿠키는
 * 그대로 전달만 하고, Set-Cookie 도 건드리지 않는다.
 */
class ProxyServer(
    private val targetBase: String,
    preferredPort: Int,
    private val secret: String,
    private val onPort: (Int) -> Unit,
) {
    // 형식이 틀린 origin 은 포트를 잡기 전에 여기서 던진다(값은 쓰지 않는다 — 중계 대상은 문자열 [targetBase] 로 이어 붙인다).
    init { URL(targetBase) }

    private val pool = Executors.newCachedThreadPool()
    private val server: ServerSocket
    val port: Int

    init {
        var s: ServerSocket? = null
        var p = preferredPort
        // 포트가 고정이어야 하는 이유: origin(포트 포함)이 바뀌면 localStorage/sessionStorage 가 통째로 사라진다.
        // 저장된 포트가 점유 중일 때만 다음 포트로 넘어가고, 호출자가 그 결과를 prefs 에 저장한다.
        for (i in 0 until 20) {
            try {
                s = ServerSocket()
                s.reuseAddress = true
                s.bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 64)
                break
            } catch (e: Exception) {
                Log.w(LOG_TAG, "proxy bind $p failed: ${e.message}")
                try { s?.close() } catch (_: Exception) {}
                s = null; p++
            }
        }
        server = s ?: throw IllegalStateException("no free port")
        port = p
        onPort(p)
        Log.i(LOG_TAG, "proxy listening 127.0.0.1:$port -> $targetBase")
        if (port != preferredPort) ShellDiag.warn("proxy", "port_moved", "$preferredPort -> $port (origin changed; token is re-delivered via URL each launch so login survives)")
        Thread({ acceptLoop() }, "proxy-accept").apply { isDaemon = true }.start()
    }

    val alive: Boolean get() = !server.isClosed

    fun stop() { try { server.close() } catch (_: Exception) {}; pool.shutdownNow() }

    private fun acceptLoop() {
        while (!server.isClosed) {
            val c = try { server.accept() } catch (e: Exception) { break }
            pool.execute { try { handle(c) } catch (e: Exception) { Log.w(LOG_TAG, "proxy conn: $e") } finally { try { c.close() } catch (_: Exception) {} } }
        }
    }

    // 요청마다 연결을 닫는다(Connection: close). 단순함 우선 — 프로토타입.
    private fun handle(sock: Socket) {
        var upstream: HttpURLConnection? = null
        try { handleInner(sock) { upstream = it } } finally {
            // 클라이언트가 끊거나 어디서 던져도 업스트림 연결을 닫는다 — 안 그러면 SSE 슬롯(서버 최대 8)이 새고 스레드가 남는다.
            try { upstream?.disconnect() } catch (_: Exception) {}
        }
    }

    private fun handleInner(sock: Socket, onConn: (HttpURLConnection) -> Unit) {
        sock.tcpNoDelay = true
        val inp = BufferedInputStream(sock.getInputStream(), 16384)
        val out = sock.getOutputStream()
        val reqLine = readHttpLine(inp) ?: return
        val parts = reqLine.split(" ")
        if (parts.size < 3) return writeHttpError(out, 400, "Bad Request")
        val method = parts[0]
        val path = parts[1]
        if (!path.startsWith("/")) return writeHttpError(out, 400, "Bad Request") // 절대 URL/authority-form 거부
        if (method !in setOf("GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH")) return writeHttpError(out, 405, "Method Not Allowed")

        val headers = ArrayList<Pair<String, String>>()
        while (true) {
            val l = readHttpLine(inp) ?: throw EOFException()
            if (l.isEmpty()) break
            val i = l.indexOf(':'); if (i <= 0) continue
            headers += l.substring(0, i).trim() to l.substring(i + 1).trim()
        }
        fun h(n: String) = headers.firstOrNull { it.first.equals(n, true) }?.second
        val host = h("Host")
        if (host != "localhost:$port" && host != "127.0.0.1:$port") return writeHttpError(out, 403, "Forbidden")

        // 같은 폰의 다른 앱 차단: 시크릿 쿠키 확인(상수 시간 비교) 후 업스트림에는 실리지 않게 뺀다.
        val cookies = headers.filter { it.first.equals("Cookie", true) }
            .flatMap { it.second.split(';') }.map { it.trim() }.filter { it.isNotEmpty() }
        val mine = cookies.firstOrNull { it.startsWith("$SHELL_COOKIE=") }?.substringAfter('=')
        if (mine == null || !MessageDigest.isEqual(mine.toByteArray(), secret.toByteArray())) {
            ShellDiag.warn("proxy", "rejected_no_cookie", "$method ${path.substringBefore('?')}")
            return writeHttpError(out, 403, "Forbidden")
        }
        val otherCookies = cookies.filterNot { it.startsWith("$SHELL_COOKIE=") }

        val clen = h("Content-Length")?.toLongOrNull()
        val chunkedReq = h("Transfer-Encoding")?.contains("chunked", true) == true
        val hasBody = (clen != null && clen > 0) || chunkedReq

        val conn = URL(targetBase + path).openConnection() as HttpURLConnection
        onConn(conn)
        conn.requestMethod = method
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 6_000
        // SSE(/api/v1/events)만 무기한. 그 밖은 150초 — 서버의 음성 전사 상한(120초)보다 길고, PC 가 멈췄을 때 요청·스레드가 영영 안 남는다.
        conn.readTimeout = if (path.substringBefore('?') == "/api/v1/events") 0 else 150_000
        conn.useCaches = false
        val skip = setOf("cookie", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection", "upgrade", "expect")
        for ((k, v) in headers) {
            if (k.lowercase() in skip) continue
            if (k.equals("Origin", true) || k.equals("Referer", true)) {
                conn.addRequestProperty(k, v.replace("http://localhost:$port", targetBase).replace("http://127.0.0.1:$port", targetBase))
            } else conn.addRequestProperty(k, v)
        }
        if (otherCookies.isNotEmpty()) conn.addRequestProperty("Cookie", otherCookies.joinToString("; "))
        // 업스트림 연결 실패/타임아웃은 502/504 로 돌려준다 — 셸이 "PC 에 연결할 수 없음" 안내를 띄우는 신호.
        val code = try {
            if (hasBody) {
                conn.doOutput = true
                if (clen != null) conn.setFixedLengthStreamingMode(clen) else conn.setChunkedStreamingMode(16384)
                val os = conn.outputStream
                val src: InputStream = if (chunkedReq) ChunkedInput(inp) else inp
                val buf = ByteArray(16384)
                var left = clen ?: Long.MAX_VALUE
                while (left > 0) {
                    val n = src.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n < 0) break
                    os.write(buf, 0, n); left -= n
                }
                os.close()
            }

            conn.responseCode
        } catch (e: Exception) {
            Log.w(LOG_TAG, "upstream fail $method ${path.substringBefore('?')}: $e")
            return if (e is SocketTimeoutException) writeHttpError(out, 504, "Gateway Timeout") else writeHttpError(out, 502, "Bad Gateway")
        }
        val sb = StringBuilder("HTTP/1.1 $code ${conn.responseMessage ?: ""}\r\n")
        var ctype = ""
        var i = 0
        while (true) {
            val k = conn.getHeaderFieldKey(i); val v = conn.getHeaderField(i)
            if (v == null && k == null) break
            i++
            if (k == null) continue
            val kl = k.lowercase()
            if (kl in setOf("connection", "transfer-encoding", "keep-alive")) continue
            var vv = v ?: ""
            if (kl == "content-type") ctype = vv
            if (kl == "location" && vv.startsWith(targetBase)) vv = "http://localhost:$port" + vv.substring(targetBase.length)
            sb.append(k).append(": ").append(vv).append("\r\n")
        }
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1)); out.flush()
        if (method == "HEAD" || code == 204 || code == 304) return
        val rin = (if (code >= 400) conn.errorStream else conn.inputStream) ?: return
        val buf = ByteArray(8192)
        val sse = ctype.startsWith("text/event-stream")
        // Content-Length 없는 응답은 EOF 로 끝을 알린다(Connection: close). 청크 단위로 즉시 flush.
        while (true) {
            val n = rin.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            out.flush() // SSE 이벤트가 버퍼에 머물지 않도록 매 읽기마다 flush
        }
        rin.close()
        if (sse) Log.i(LOG_TAG, "sse stream ended $path")
    }
}
