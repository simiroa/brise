package com.brise.shell

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream

// HTTP/1.1 와이어 포맷 헬퍼 — 정책(Host·쿠키 검사, 업스트림 중계)은 [ProxyServer] 에 있고, 여기는 바이트 ↔ 줄/청크 변환만 한다.

/** CRLF/LF 로 끝나는 한 줄(종결 문자 제외, ISO-8859-1). 입력이 바로 끝나면 null. 16KB 를 넘는 줄은 예외. */
internal fun readHttpLine(inp: InputStream): String? {
    val b = ByteArrayOutputStream()
    while (true) {
        val x = inp.read()
        if (x < 0) return if (b.size() == 0) null else b.toString("ISO-8859-1")
        if (x == '\n'.code) break
        if (x != '\r'.code) b.write(x)
        if (b.size() > 16384) throw IllegalStateException("line too long")
    }
    return b.toString("ISO-8859-1")
}

/** 본문이 메시지 한 줄인 오류 응답을 쓰고 연결을 닫도록 알린다. */
internal fun writeHttpError(out: OutputStream, code: Int, msg: String) {
    val body = msg.toByteArray()
    out.write("HTTP/1.1 $code $msg\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
    out.write(body); out.flush()
}

/** 요청 본문이 chunked 일 때 디코딩(드묾 — fetch/XHR 는 보통 Content-Length). */
internal class ChunkedInput(private val inp: InputStream) : InputStream() {
    private var left = 0L; private var done = false
    override fun read(): Int { val b = ByteArray(1); return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xff }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (done) return -1
        if (left == 0L) {
            val sb = StringBuilder()
            while (true) { val x = inp.read(); if (x < 0) return -1; if (x == '\n'.code) break; if (x != '\r'.code) sb.append(x.toChar()) }
            left = sb.toString().substringBefore(';').trim().toLong(16)
            if (left == 0L) { done = true; return -1 }
        }
        val n = inp.read(b, off, minOf(len.toLong(), left).toInt())
        if (n > 0) { left -= n; if (left == 0L) { inp.read(); inp.read() } }
        return n
    }
}
