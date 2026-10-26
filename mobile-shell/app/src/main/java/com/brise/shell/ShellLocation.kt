package com.brise.shell

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * 네이티브 위치 조회(브리지의 `getLocation`이 쓴다 — [ShellBridge]). 결과 JSON:
 * 성공 `{"ok":true,"lat":..,"lng":..,"accuracy":..,"ts":..}`, 실패 `{"ok":false,"error":"no_permission|no_provider|timeout|security"}`.
 * `id` 는 호출한 쪽(브리지)이 붙인다.
 */
class ShellLocation(private val act: Activity, private val perms: PermissionGate) {
    private val ui = Handler(Looper.getMainLooper())

    /** 마지막 위치가 있으면 즉시, 없으면 1회 갱신(20초 제한). 결과는 항상 UI 스레드에서 한 번만 콜백. */
    fun locate(done: (JSONObject) -> Unit) {
        act.runOnUiThread {
            perms.ensure(listOf(PermKind.LOCATION)) { ok ->
                if (!ok) { done(err("no_permission")); return@ensure }
                val lm = act.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                var best: Location? = null
                try {
                    for (p in lm.getProviders(true)) {
                        val l = lm.getLastKnownLocation(p) ?: continue
                        if (best == null || l.time > best!!.time) best = l
                    }
                } catch (_: SecurityException) { done(err("security")); return@ensure }
                best?.let { done(toJson(it)); return@ensure }
                requestOnce(lm, done)
            }
        }
    }

    private fun err(code: String) = JSONObject().put("ok", false).put("error", code)

    private fun toJson(l: Location) = JSONObject().put("ok", true)
        .put("lat", l.latitude).put("lng", l.longitude).put("accuracy", l.accuracy.toDouble()).put("ts", l.time)

    @SuppressLint("MissingPermission")
    private fun requestOnce(lm: LocationManager, done: (JSONObject) -> Unit) {
        val provider = when {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> { done(err("no_provider")); return }
        }
        var finished = false
        lateinit var listener: LocationListener
        val timeout = Runnable {
            if (finished) return@Runnable
            finished = true; lm.removeUpdates(listener); done(err("timeout"))
        }
        listener = object : LocationListener {
            override fun onLocationChanged(l: Location) {
                if (finished) return
                finished = true; ui.removeCallbacks(timeout); done(toJson(l))
            }
            @Deprecated("x") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
            override fun onProviderEnabled(p: String) {}
            override fun onProviderDisabled(p: String) {}
        }
        lm.requestSingleUpdate(provider, listener, Looper.getMainLooper())
        ui.postDelayed(timeout, 20_000)
    }
}
