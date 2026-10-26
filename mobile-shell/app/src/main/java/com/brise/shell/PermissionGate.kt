package com.brise.shell

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** 셸이 런타임에 요청하는 권한 묶음. [anyOf] 면 하나만 허용돼도 충족(위치: 정밀·대략). */
enum class PermKind(val perms: List<String>, val labelRes: Int, val anyOf: Boolean) {
    CAMERA(listOf(Manifest.permission.CAMERA), R.string.perm_camera, false),
    MIC(listOf(Manifest.permission.RECORD_AUDIO), R.string.perm_mic, false),
    LOCATION(listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), R.string.perm_location, true),
}

/**
 * 런타임 권한 흐름 — 요청은 한 번에 하나씩 직렬화한다(권한 대화상자는 겹쳐 뜰 수 없다).
 * 생성은 액티비티가 STARTED 가 되기 전이어야 한다([ComponentActivity.registerForActivityResult] 제약) —
 * MainActivity 의 프로퍼티 초기화 시점에 한 번만 만든다.
 */
class PermissionGate(private val act: ComponentActivity) {
    private var current: ((Map<String, Boolean>) -> Unit)? = null
    private val queue = ArrayDeque<Pair<List<String>, (Map<String, Boolean>) -> Unit>>()
    private val launcher = act.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        Log.i(LOG_TAG, "perm result ${res.entries.joinToString { "${it.key.substringAfterLast('.')}=${it.value}" }}")
        res.filterValues { !it }.keys.forEach { ShellDiag.info("permission", "denied", it.substringAfterLast('.')) }
        val cb = current; current = null
        cb?.invoke(res)
        pump()
    }

    private fun granted(p: String) = act.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun ask(perms: List<String>, cb: (Map<String, Boolean>) -> Unit) {
        if (perms.all { granted(it) }) { cb(perms.associateWith { true }); return }
        queue.addLast(perms to cb)
        pump()
    }

    private fun pump() {
        if (current != null) return
        val (perms, cb) = queue.removeFirstOrNull() ?: return
        if (perms.all { granted(it) }) { cb(perms.associateWith { true }); pump(); return }
        current = cb
        launcher.launch(perms.toTypedArray())
    }

    /**
     * 카메라·마이크·위치 공통 흐름. 허용 → [onResult](true). 거부 → [onResult](false) 하고,
     * "다시 묻지 않음"(거부 뒤에도 rationale 이 false)이면 설정 앱으로 안내하는 다이얼로그를 띄운다.
     */
    fun ensure(kinds: List<PermKind>, onResult: (Boolean) -> Unit) {
        fun ok(k: PermKind, m: Map<String, Boolean>) = if (k.anyOf) k.perms.any { m[it] == true } else k.perms.all { m[it] == true }
        ask(kinds.flatMap { it.perms }.distinct()) { res ->
            val missing = kinds.filter { !ok(it, res) }
            if (missing.isEmpty()) { onResult(true); return@ask }
            val permanent = missing.filter { k -> k.perms.none { act.shouldShowRequestPermissionRationale(it) } }
            if (permanent.isNotEmpty()) showSettingsDialog(permanent)
            onResult(false)
        }
    }

    private fun showSettingsDialog(kinds: List<PermKind>) {
        val names = kinds.joinToString(", ") { act.getString(it.labelRes) }
        AlertDialog.Builder(act)
            .setTitle(act.getString(R.string.perm_blocked_title, names))
            .setMessage(act.getString(R.string.perm_blocked_body, names))
            .setPositiveButton(R.string.perm_open_settings) { _, _ ->
                act.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", act.packageName, null)))
            }
            .setNegativeButton(R.string.perm_not_now, null)
            .show()
    }
}
