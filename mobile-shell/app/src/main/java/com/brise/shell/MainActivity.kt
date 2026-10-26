package com.brise.shell

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.security.SecureRandom

private const val ACTION_OPEN_SETTINGS = "com.brise.shell.OPEN_SETTINGS"

/**
 * 단일 Activity. FrameLayout 에 WebView · 연결 실패 오버레이 · 연결 설정 화면을 겹쳐 둔다.
 * WebView 는 항상 PC 가 아니라 앱 안 프록시(http://localhost:<port>)를 연다 — [ProxyServer] 참조.
 *
 * 이 클래스는 조립 · 생명주기 · 연결(프록시+쿠키+URL) 흐름만 맡는다. 나머지는 관심사별 파일:
 * 권한 [PermissionGate] · 위치 [ShellLocation] · JS 브리지 [ShellBridge] ·
 * WebView 정책 [ShellWebViewClient]/[ShellChromeClient] · 실패 화면 [ErrorOverlay] · 연결 설정 [SetupView].
 */
class MainActivity : ComponentActivity() {
    private lateinit var store: ConnStore
    private lateinit var web: WebView
    private lateinit var errorView: ErrorOverlay
    private lateinit var setup: SetupView
    private lateinit var bridge: ShellBridge
    private val ui = Handler(Looper.getMainLooper())

    private var conn: Conn? = null
    private var proxy: ProxyServer? = null
    private var proxyBase: String? = null
    /** 프로세스(액티비티)마다 새로 만든다. 프록시 접근 제한용 쿠키 값. */
    private val shellSecret: String = ByteArray(24).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }
    private var loadFailed = false
    private var lastBackAt = 0L
    private val debuggable by lazy { (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 }

    private val proxyPort get() = proxy?.port ?: 0
    private fun isOwnOrigin(u: Uri) = u.scheme == "http" && u.host == "localhost" && u.port == proxyPort

    // registerForActivityResult 를 쓰는 협력자는 액티비티가 STARTED 가 되기 전(= 여기, 프로퍼티 초기화)에 한 번만 만든다.
    private val perms = PermissionGate(this)
    private val chrome = ShellChromeClient(this, perms, ::isOwnOrigin)
    private val location = ShellLocation(this, perms)
    // 다른 앱에서 "가져오기"로 온 내용을 받아 두는 곳 — 페이지가 브리지로 당겨 간다([ShellBridge]).
    private val imports by lazy { ShellImport.shared(this) }

    // ---- 화면 구성 ----
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ShellDiag.init(this)
        ShellDiag.info("shell", "start", "v" + (try { packageManager.getPackageInfo(packageName, 0).versionName } catch (_: Exception) { "?" }) + " sdk" + android.os.Build.VERSION.SDK_INT)
        store = ConnStore(this)
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true)

        val root = FrameLayout(this)
        setContentView(root)
        // targetSdk 35 는 edge-to-edge 강제 — 시스템 바·키보드 높이만큼 안쪽으로 민다.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        web.applyShellSettings()
        web.webViewClient = ShellWebViewClient(
            act = this,
            isOwnOrigin = ::isOwnOrigin,
            loadFailed = { loadFailed },
            onOwnPageLoaded = { errorView.visibility = View.GONE },
            onConnectionFailure = ::showConnectionError,
            imports = imports,
        )
        web.webChromeClient = chrome
        bridge = ShellBridge(this, web, location, imports) { proxyPort }

        errorView = ErrorOverlay(
            this,
            onRetry = { conn?.let { openConnection(it) } ?: showSetup() },
            onOpenSettings = ::showSetup,
        )
        root.addView(errorView, FrameLayout.LayoutParams(-1, -1))

        setup = SetupView(this, onSave = { c -> store.save(c); setup.hide(); openConnection(c) }, onCancel = { closeSetup() })
        setup.visibility = View.GONE
        root.addView(setup, FrameLayout.LayoutParams(-1, -1))

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBack()
        })

        // 가져오기로 시작됐다면 내용을 받아 둔다. 프로세스가 죽었다 복원된 경우(savedInstanceState != null)에는 시스템이 원래
        // 인텐트를 다시 주는데, 그걸 또 받으면 이미 처리한 가져오기가 되살아난다.
        if (savedInstanceState == null) acceptImport(intent)
        conn = store.load()
        if (intent?.action == ACTION_OPEN_SETTINGS || conn == null) showSetup() else openConnection(conn!!)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == ACTION_OPEN_SETTINGS) showSetup() else acceptImport(intent)
    }

    /** 가져오기 인텐트면 받아 두고, 받는 대로 떠 있는 페이지에 알린다(아직 로드 전이면 페이지가 부팅 때 당겨 간다). */
    private fun acceptImport(intent: Intent?) {
        if (intent == null) return
        if (imports.accept(intent) { ui.post(::notifyImportReady) }) {
            // 같은 인텐트가 설정 변경·재생성으로 다시 처리되지 않게 평범한 실행 인텐트로 바꿔 둔다.
            setIntent(Intent(Intent.ACTION_MAIN))
        }
    }

    /** 페이지에 "새 가져오기가 있다"는 신호만 보낸다(데이터 없음 — 내용은 페이지가 브리지로 당겨 간다). 우리 origin 일 때만. */
    private fun notifyImportReady() {
        val url = web.url ?: return
        if (!isOwnOrigin(Uri.parse(url))) return
        web.evaluateJavascript("window.dispatchEvent(new Event('brise-import-ready'))", null)
    }

    override fun onResume() {
        super.onResume()
        val c = conn ?: return
        if (setup.visibility == View.VISIBLE) return
        // 연결 실패 상태였다면 앱이 앞으로 돌아올 때 자동 재시도. 프록시 소켓이 죽었어도 다시 연다.
        if (loadFailed || proxy?.alive == false) {
            Log.i(LOG_TAG, "onResume: retry (failed=$loadFailed alive=${proxy?.alive})")
            openConnection(c)
        }
    }

    override fun onDestroy() {
        proxy?.stop()
        web.destroy()
        super.onDestroy()
    }

    private fun showSetup() {
        errorView.visibility = View.GONE
        setup.show(store.load(), canCancel = store.load() != null)
    }

    private fun closeSetup() {
        setup.hide()
        // 취소: 이전 화면(웹 또는 실패 오버레이)로 복귀.
        if (loadFailed) errorView.visibility = View.VISIBLE
    }

    private fun onBack() {
        when {
            setup.visibility == View.VISIBLE -> if (store.load() != null) closeSetup() else finish()
            errorView.visibility == View.VISIBLE -> finish()
            web.canGoBack() -> web.goBack() // MobileApp.goBack() = history.back() 과 같은 스택
            else -> {
                val now = System.currentTimeMillis()
                if (now - lastBackAt < 1500) finish()
                else { lastBackAt = now; Toast.makeText(this, R.string.back_again, Toast.LENGTH_SHORT).show() }
            }
        }
    }

    // ---- 연결 ----
    private fun ensureProxy(c: Conn): ProxyServer {
        val p = proxy
        if (p != null && p.alive && proxyBase == c.origin) return p
        p?.stop()
        val np = ProxyServer(c.origin, store.proxyPort, shellSecret) { store.proxyPort = it }
        proxy = np; proxyBase = c.origin
        bridge.install(np.port)
        return np
    }

    /** 프록시를 준비하고, 시크릿 쿠키를 심은 뒤, 토큰 포함 URL 을 연다. 매 실행·재시도마다 호출. */
    private fun openConnection(c: Conn) {
        conn = c
        loadFailed = false
        errorView.markRetrying()
        val p = try { ensureProxy(c) } catch (e: Exception) {
            ShellDiag.error("proxy", "start_failed", e.javaClass.simpleName + ": " + (e.message ?: "")); showConnectionError(); return
        }
        val url = c.localUrl(p.port)
        Log.i(LOG_TAG, "loading ${redact(url)} (target ${c.origin})")
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        // HttpOnly: 페이지 JS 가 읽지 못하게. 쿠키는 포트와 무관하게 호스트(localhost)에 붙는다 — 그래서 WebView 가
        // 우리 origin 밖의 localhost 포트로 가지 못하게 shouldInterceptRequest 에서 막는다.
        cm.setCookie("http://localhost:${p.port}/", "$SHELL_COOKIE=$shellSecret; Path=/; HttpOnly") {
            cm.flush()
            ui.post { web.loadUrl(url) }
        }
    }

    private fun showConnectionError() {
        loadFailed = true
        errorView.showFailure(visible = setup.visibility != View.VISIBLE)
    }
}
