package com.brise.shell

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.util.TypedValue
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlin.concurrent.thread

/**
 * 연결 설정 화면(네이티브 Views). 주소 붙여넣기 / QR 스캔 / 연결 테스트 / 저장.
 * 입력란은 마스킹(textPassword)한다 — 주소에 토큰이 들어 있어 어깨너머로 보이지 않게. 토큰은 어디에도 평문으로 그리지 않고
 * 파싱 결과는 "주소 · 토큰 있음" 요약만 보여 준다.
 */
class SetupView(
    private val act: Activity,
    private val onSave: (Conn) -> Unit,
    private val onCancel: () -> Unit,
) : ScrollView(act) {
    private val ui = Handler(Looper.getMainLooper())
    private val input: EditText
    private val parsed: TextView
    private val result: TextView
    private val scanBtn: Button
    private val cancelBtn: Button
    private var testSeq = 0

    init {
        isFillViewport = true
        setBackgroundColor(act.themeBackground())
        val col = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(24), dp(20), dp(24)) }
        addView(col, LayoutParams(-1, -2))

        col.addView(TextView(act).apply { setText(R.string.setup_title); setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f) })
        col.addView(TextView(act).apply { setText(R.string.setup_desc); setPadding(0, dp(8), 0, dp(16)) })

        input = EditText(act).apply {
            setHint(R.string.setup_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(true)
            // setSingleLine 이 변환 방식을 평문으로 되돌리므로 그 뒤에 마스킹을 건다(토큰이 화면에 보이면 안 됨).
            transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
            contentDescription = "connection address"
        }
        col.addView(input, LinearLayout.LayoutParams(-1, -2))
        parsed = TextView(act).apply { setPadding(0, dp(8), 0, 0); setTextColor(Color.parseColor("#80CBC4")) }
        col.addView(parsed)

        val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(16), 0, 0) }
        scanBtn = Button(act).apply { setText(R.string.setup_scan); setOnClickListener { scan() } }
        val testBtn = Button(act).apply { setText(R.string.setup_test); setOnClickListener { test() } }
        row.addView(scanBtn, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(testBtn, LinearLayout.LayoutParams(0, -2, 1f))
        col.addView(row)

        result = TextView(act).apply { setPadding(0, dp(8), 0, dp(8)) }
        col.addView(result)

        val row2 = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
        cancelBtn = Button(act).apply { setText(R.string.setup_cancel); setOnClickListener { onCancel() } }
        val saveBtn = Button(act).apply { setText(R.string.setup_save); setOnClickListener { save() } }
        row2.addView(cancelBtn, LinearLayout.LayoutParams(0, -2, 1f))
        row2.addView(saveBtn, LinearLayout.LayoutParams(0, -2, 1f))
        col.addView(row2)

        // QR 스캐너는 Google Play 서비스가 있는 기기에서만 — 없으면 버튼을 숨기고 붙여넣기만.
        val gms = try {
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(act) == ConnectionResult.SUCCESS
        } catch (_: Throwable) { false }
        scanBtn.visibility = if (gms) View.VISIBLE else View.GONE

        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) { refreshParsed(); testSeq++; result.text = "" }
        })
    }

    /** 화면을 열 때 호출. [prefill] 은 이미 저장된 연결(재설정)이면 그 주소. */
    fun show(prefill: Conn?, canCancel: Boolean) {
        visibility = View.VISIBLE
        input.setText(prefill?.let { it.origin + it.pathQuery + (if (it.pathQuery.contains('?')) "&" else "?") + "token=" + it.token } ?: "")
        cancelBtn.visibility = if (canCancel) View.VISIBLE else View.GONE
        result.text = ""
        refreshParsed()
    }

    fun hide() { visibility = View.GONE; input.setText("") }

    private fun refreshParsed() {
        val raw = input.text.toString()
        parsed.text = if (raw.isBlank()) "" else when (val r = ConnParser.parse(raw)) {
            is ParseResult.Ok -> act.getString(R.string.setup_parsed, r.conn.summary())
            is ParseResult.Fail -> ""
        }
    }

    private fun parseOrShowError(): Conn? = when (val r = ConnParser.parse(input.text.toString())) {
        is ParseResult.Ok -> r.conn
        is ParseResult.Fail -> { showResult(act.getString(r.reasonRes), false); null }
    }

    private fun showResult(msg: String, ok: Boolean) {
        result.text = msg
        result.setTextColor(if (ok) Color.parseColor("#80CBC4") else Color.parseColor("#EF9A9A"))
    }

    private fun test() {
        val c = parseOrShowError() ?: return
        val seq = ++testSeq
        showResult(act.getString(R.string.test_running), true)
        result.setTextColor(Color.GRAY)
        thread(name = "conn-test") {
            val r = Ping.run(c)
            Log.i(LOG_TAG, "connection test ${c.origin} -> $r")
            ui.post {
                if (seq != testSeq) return@post // 입력이 바뀌었으면 낡은 결과는 버린다
                when (r) {
                    is PingResult.Ok -> showResult(act.getString(R.string.test_ok), true)
                    is PingResult.AuthFail -> showResult(act.getString(R.string.test_auth), false)
                    is PingResult.Other -> showResult(act.getString(R.string.test_other, r.code), false)
                    is PingResult.Unreachable -> showResult(act.getString(R.string.test_unreachable), false)
                }
            }
        }
    }

    private fun save() {
        val c = parseOrShowError() ?: return
        if (ConnParser.isExpectedHost(c.host)) { onSave(c); return }
        // 경고만 하고 막지는 않는다 — 오너가 다른 대역(LAN 등)을 쓸 수도 있다.
        AlertDialog.Builder(act)
            .setTitle(R.string.warn_title)
            .setMessage(act.getString(R.string.warn_body, c.host))
            .setPositiveButton(R.string.warn_continue) { _, _ -> onSave(c) }
            .setNegativeButton(R.string.setup_cancel, null)
            .show()
    }

    private fun scan() {
        val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(act, opts).startScan()
            .addOnSuccessListener { b ->
                val raw = b.rawValue ?: ""
                if (ConnParser.parse(raw) is ParseResult.Ok) input.setText(raw)
                else Toast.makeText(act, R.string.qr_bad, Toast.LENGTH_LONG).show()
            }
            .addOnFailureListener { e ->
                ShellDiag.warn("setup", "qr_scan_failed", e.javaClass.simpleName)
                Toast.makeText(act, R.string.qr_unavailable, Toast.LENGTH_LONG).show()
            }
    }
}
