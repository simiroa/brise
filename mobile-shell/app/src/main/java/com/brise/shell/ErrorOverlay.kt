package com.brise.shell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

private const val TAILSCALE_PKG = "com.tailscale.ipn"

/**
 * "PC 에 연결할 수 없습니다" 오버레이(WebView 위에 겹친다). 처음엔 숨겨져 있다.
 * 표시 여부는 호출자가 정한다 — 연결 설정 화면이 떠 있을 땐 상태만 갱신하고 가린 채로 둔다([showFailure]).
 *
 * @param onRetry "다시 시도" — 버튼을 잠그고 안내문을 "다시 연결하는 중"으로 바꾼 뒤 호출된다.
 * @param onOpenSettings "연결 설정".
 */
class ErrorOverlay(
    private val act: Activity,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
) : LinearLayout(act) {
    private val status: TextView
    private val retryBtn: Button
    private val tailscaleBtn: Button

    init {
        visibility = View.GONE
        orientation = VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(act.themeBackground())
        setPadding(dp(28), dp(24), dp(28), dp(24))
        isClickable = true // 뒤의 WebView 로 터치가 새지 않게

        addView(TextView(act).apply {
            setText(R.string.error_title); setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f); gravity = Gravity.CENTER
        })
        status = TextView(act).apply { setText(R.string.error_body); gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(20)) }
        addView(status)
        retryBtn = Button(act).apply {
            setText(R.string.error_retry)
            setOnClickListener {
                isEnabled = false
                status.setText(R.string.error_retrying)
                onRetry()
            }
        }
        addView(retryBtn)
        tailscaleBtn = Button(act).apply {
            setText(R.string.error_open_tailscale)
            isAllCaps = false // 영문 라벨이 혼자 대문자로 뜨지 않게(다른 버튼은 한글이라 영향 없음)
            visibility = View.GONE
            // 앱을 열어 줄 뿐 켜 주지는 못한다 — 켠 뒤 돌아오면 MainActivity.onResume 이 자동 재시도한다.
            setOnClickListener { tailscaleIntent()?.let { try { act.startActivity(it) } catch (e: ActivityNotFoundException) { ShellDiag.warn("shell", "tailscale_launch_failed", e.javaClass.simpleName) } } }
        }
        addView(tailscaleBtn)
        addView(Button(act).apply { setText(R.string.error_settings); setOnClickListener { onOpenSettings() } })
    }

    /** 재시도 시작 — 안내문만 바꾼다(표시 상태는 그대로). */
    fun markRetrying() = status.setText(R.string.error_retrying)

    /** 실패 안내를 갱신하고, [visible] 이면 보여 준다. VPN 이 꺼져 있으면 안내가 바뀌고 Tailscale 이 설치돼 있으면 열기 버튼도 나온다. */
    fun showFailure(visible: Boolean) {
        val vpnOff = !vpnActive()
        status.setText(if (vpnOff) R.string.error_body_vpn else R.string.error_body)
        tailscaleBtn.visibility = if (vpnOff && tailscaleIntent() != null) View.VISIBLE else View.GONE
        retryBtn.isEnabled = true
        if (visible) visibility = View.VISIBLE
    }

    /** VPN 전송이 활성인가 — Tailscale 이 꺼져 있으면 100.x 로 못 가는 가장 흔한 원인이라 안내를 바꾼다. */
    private fun vpnActive(): Boolean {
        val cm = act.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    private fun tailscaleIntent(): Intent? = act.packageManager.getLaunchIntentForPackage(TAILSCALE_PKG)
}
