package com.brise.shell

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import java.io.ByteArrayInputStream

// WebView 가 무엇을 열고·무엇에 접근할 수 있는지(origin 정책)를 한 파일에 모은다.
// "우리 origin" = 앱 안 프록시 http://localhost:<port> 하나뿐 — [ProxyServer] 참조.

/** WebView 기본 설정 — 아래 [ShellWebViewClient] 의 origin 정책과 한 쌍(혼합 콘텐츠는 막고, cleartext 는 클라이언트가 우리 origin 으로만 보낸다). */
@SuppressLint("SetJavaScriptEnabled")
fun WebView.applyShellSettings() {
    settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        setGeolocationEnabled(true)
    }
}

/**
 * 내비게이션·요청 필터와 연결 실패 감지.
 * 호출자 쪽 상태는 값이 아니라 람다로 받는다(포트·실패 여부는 매번 바뀐다).
 *
 * @param act 외부 링크(http(s)/mailto/tel)를 시스템에 넘길 때 쓴다.
 * @param loadFailed 지금 연결 실패 상태인가.
 * @param onOwnPageLoaded 우리 origin 의 페이지가 실패 없이 로드 완료됐다 → 실패 오버레이를 걷는다.
 * @param onConnectionFailure 메인 프레임 로드 실패 또는 프록시의 업스트림 실패(502/504).
 * @param imports 가져오기 이미지 바이트를 내주는 `/__shell/import/...` 경로의 출처 — [ShellImport.serve].
 */
class ShellWebViewClient(
    private val act: Activity,
    private val isOwnOrigin: (Uri) -> Boolean,
    private val loadFailed: () -> Boolean,
    private val onOwnPageLoaded: () -> Unit,
    private val onConnectionFailure: () -> Unit,
    private val imports: ShellImport,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
        val u = r.url
        if (isOwnOrigin(u)) return false
        // 외부 링크는 WebView 안에서 열지 않는다(브리지·프록시 쿠키가 따라가지 않게). 사용자가 누른 http(s)/mailto/tel 만 시스템에 넘긴다.
        Log.w(LOG_TAG, "blocked in-app navigation ${redact(u.toString())}")
        if (r.hasGesture() && u.scheme in setOf("http", "https", "mailto", "tel")) {
            try { act.startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: ActivityNotFoundException) {}
        }
        return true
    }

    /**
     * cleartext(http) 는 우리 프록시 origin 으로만 나갈 수 있다. NSC 가 이걸 못 해 주는 이유는 res/xml/network_security_config.xml 참조.
     * https/data/blob 은 통과(노트에 걸린 외부 이미지 등).
     */
    override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
        val u = r.url
        // 가져오기 이미지 — 프록시 소켓을 거치지 않고 여기서 바로 내준다(같은 폰의 다른 앱이 닿지 못한다). 우리 origin·GET 만.
        // 아래 cleartext 차단·통과 판정보다 먼저 본다: 이 경로는 업스트림(PC)으로 가지 않는다.
        if (isOwnOrigin(u) && u.path?.startsWith(ShellImport.ROUTE_PREFIX) == true) {
            return if (r.method == "GET") imports.serve(u.path!!)
            else WebResourceResponse("text/plain", "utf-8", 405, "Method Not Allowed", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        if (u.scheme == "http" && !isOwnOrigin(u)) {
            ShellDiag.warn("webview", "blocked_cleartext", u.host ?: "")
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        return null
    }

    // loadFailed 는 onPageStarted 에서 되돌리지 않는다: 502 같은 HTTP 오류는 onReceivedHttpError 가 먼저 오고
    // onPageStarted 는 그 응답이 커밋될 때 뒤늦게 온다(실측). 재시도 때 MainActivity.openConnection 이 직접 false 로 둔다.
    override fun onPageFinished(v: WebView, url: String) {
        Log.i(LOG_TAG, "page finished ${redact(url)} failed=${loadFailed()}")
        if (!loadFailed()) ShellDiag.flush() // 연결이 살아 있으니 쌓인 진단 기록을 보낸다
        if (!loadFailed() && isOwnOrigin(Uri.parse(url))) onOwnPageLoaded()
    }

    override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
        if (!r.isForMainFrame) return
        val desc = e.description?.toString() ?: ""
        if (desc.contains("ERR_ABORTED")) return // 새 loadUrl 이 이전 로드를 취소한 것
        ShellDiag.warn("webview", "main_frame_error", "${e.errorCode} $desc")
        onConnectionFailure()
    }

    // 프록시의 업스트림 연결 실패(502/504). 하위 요청의 5xx 는 웹 UI(MobileOfflineBanner)가 처리하므로 메인 프레임만 본다.
    override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, e: WebResourceResponse) {
        if (!r.isForMainFrame) return
        if (e.statusCode == 502 || e.statusCode == 504) {
            ShellDiag.warn("webview", "upstream_failure", "${e.statusCode}")
            onConnectionFailure()
        }
    }
}

/**
 * 콘솔 로그 · 카메라/마이크/위치 권한 요청 · 파일 선택기. 권한은 우리 origin 에만 열어 준다.
 * 생성은 액티비티가 STARTED 가 되기 전이어야 한다(파일 선택기 런처를 여기서 등록한다 — [PermissionGate] 와 같은 제약).
 */
class ShellChromeClient(
    private val act: ComponentActivity,
    private val perms: PermissionGate,
    private val isOwnOrigin: (Uri) -> Boolean,
) : WebChromeClient() {
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private val fileLauncher = act.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCb?.onReceiveValue(FileChooserParams.parseResult(r.resultCode, r.data))
        fileCb = null
    }

    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
        Log.i(LOG_TAG, redact("${m.message()} [${m.sourceId()}:${m.lineNumber()}]"))
        return true
    }

    override fun onPermissionRequest(req: PermissionRequest) {
        act.runOnUiThread {
            Log.i(LOG_TAG, "onPermissionRequest origin=${req.origin} res=${req.resources.joinToString()}")
            if (!isOwnOrigin(req.origin)) { req.deny(); return@runOnUiThread }
            val supported = req.resources.filter {
                it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
            }
            if (supported.isEmpty()) { req.deny(); return@runOnUiThread }
            val kinds = supported.map { if (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE) PermKind.MIC else PermKind.CAMERA }
            perms.ensure(kinds) { ok -> if (ok) req.grant(supported.toTypedArray()) else req.deny() }
        }
    }

    override fun onGeolocationPermissionsShowPrompt(origin: String, cb: GeolocationPermissions.Callback) {
        act.runOnUiThread {
            Log.i(LOG_TAG, "onGeolocationPermissionsShowPrompt origin=$origin")
            if (!isOwnOrigin(Uri.parse(origin))) { cb.invoke(origin, false, false); return@runOnUiThread }
            perms.ensure(listOf(PermKind.LOCATION)) { ok -> cb.invoke(origin, ok, false) }
        }
    }

    override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
        fileCb?.onReceiveValue(null)
        fileCb = cb
        Log.i(LOG_TAG, "onShowFileChooser accept=${p.acceptTypes.joinToString()} capture=${p.isCaptureEnabled}")
        return try {
            fileLauncher.launch(p.createIntent()); true
        } catch (e: Exception) {
            ShellDiag.error("file_chooser", "failed", e.javaClass.simpleName); fileCb = null; false
        }
    }
}
