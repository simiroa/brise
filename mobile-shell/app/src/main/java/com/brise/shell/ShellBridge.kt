package com.brise.shell

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * 네이티브 브리지 `BriseNative` — 위치 "빠른 보조"와 "가져오기" 전달. 웹 geolocation 도 되므로 위치는 필수가 아니다
 * (웹 쪽 단일 관문은 `src/lib/nativeBridge.ts`, 위치는 `src/lib/currentPosition.ts`, 가져오기는 `src/mobile/mobileImportBridge.ts`).
 *
 * 프로토콜:
 *  - 페이지 → 셸: `BriseNative.postMessage('{"id":1,"type":"getLocation"}')`
 *  - 셸 → 페이지: `BriseNative.onmessage = e => JSON.parse(e.data)` = `{"id":1,"ok":true,...}` 또는
 *    `{"id":1,"ok":false,"error":"..."}`.
 *
 * type 별 응답:
 *  - `getLocation`     → `{ok:true,lat,lng,accuracy,ts}` | `{ok:false,error:"no_permission|no_provider|timeout|security"}` ([ShellLocation])
 *  - `getPendingImport` → `{ok:true,import:{importId,text?,subject?,textError,omitted,items:[...]}|null}` ([ShellImport.pending] — 읽기만, ack 전 가져오기 중 가장 최근 것)
 *  - `ackImport`       → `{ok:true}` (`importId` 의 임시 파일을 지운다 — 다른 가져오기는 그대로, 모르는 id 면 아무것도 안 한다)
 *  - 그 밖             → `{ok:false,error:"unknown_type"}`
 *
 * 페이지가 셸보다 새 버전일 수 있다(PC 가 서빙하는 `/app` 과 폰의 APK 는 따로 갱신된다) — 페이지는 `unknown_type` 을
 * "가져오기 없음"으로 읽는다. 반대로 구형 셸의 LegacyBridge 는 어떤 요청에도 위치로 답했다(이 버전은 type 으로 가른다).
 *
 * @param proxyPort 프록시가 지금 바인딩한 포트 — 메시지가 올 때마다 읽는다(값을 붙들어 두지 않는다).
 */
class ShellBridge(
    private val act: Activity,
    private val web: WebView,
    private val location: ShellLocation,
    private val imports: ShellImport,
    private val proxyPort: () -> Int,
) {
    private val ui = Handler(Looper.getMainLooper())
    private var bridgePort = -1

    /** 프록시 포트가 정해질 때마다(페이지 로드 전에) 호출. 같은 포트면 아무것도 안 한다. */
    fun install(port: Int) {
        if (bridgePort == port) return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // origin 허용목록: 프록시가 실제로 바인딩된 포트로 등록(페이지 로드 전에 호출됨). 포트가 바뀌면 다시 등록.
            // 하위 프레임·외부 origin 에는 `BriseNative` 객체 자체가 주입되지 않는다.
            val origin = "http://localhost:$port"
            if (bridgePort >= 0) WebViewCompat.removeWebMessageListener(web, "BriseNative")
            bridgePort = port
            WebViewCompat.addWebMessageListener(web, "BriseNative", setOf(origin)) { _, message, sourceOrigin, isMainFrame, reply ->
                if (!isMainFrame || sourceOrigin.toString() != "http://localhost:${proxyPort()}") return@addWebMessageListener
                val req = try { JSONObject(message.data ?: "{}") } catch (_: Exception) { JSONObject() }
                handle(req) { json -> try { reply.postMessage(json.toString()) } catch (_: Exception) {} }
            }
        } else if (bridgePort < 0) {
            bridgePort = port
            // ponytail: WebView 가 WEB_MESSAGE_LISTENER 를 지원하지 않는 구형 기기용 폴백(origin 제한 없음 — 외부 이동만 차단).
            // 최신 WebView(Android System WebView 업데이트)면 위 경로를 탄다. 폴백을 없애려면 이 else 와 LegacyBridge 를 지울 것.
            ShellDiag.warn("bridge", "legacy_fallback", "WEB_MESSAGE_LISTENER unsupported")
            web.addJavascriptInterface(LegacyBridge(), "BriseNative")
        }
    }

    /**
     * type 별로 일을 시키고, 결과 JSON(`id` 포함)을 UI 스레드에서 한 번 [respond] 한다.
     * 위치는 권한 창을 띄울 수 있어 UI 스레드에서 시작해야 한다([ShellLocation.locate] 가 스스로 runOnUiThread 한다).
     */
    private fun handle(req: JSONObject, respond: (JSONObject) -> Unit) {
        val id = req.optInt("id", 0)
        fun done(json: JSONObject) { ui.post { respond(json.put("id", id)) } }
        when (req.optString("type")) {
            "getLocation" -> location.locate { json -> done(json) }
            "getPendingImport" -> imports.pending { b ->
                done(JSONObject().put("ok", true).put("import", b ?: JSONObject.NULL))
            }
            "ackImport" -> imports.ack(req.optString("importId")) { done(JSONObject().put("ok", true)) }
            else -> done(JSONObject().put("ok", false).put("error", "unknown_type"))
        }
    }

    /** 구형 폴백: origin 제한이 없다 — 대신 type 으로 가른다(예전엔 어떤 메시지든 위치를 돌려줬다). */
    inner class LegacyBridge {
        @JavascriptInterface
        fun postMessage(msg: String) {
            val req = try { JSONObject(msg) } catch (_: Exception) { JSONObject() }
            act.runOnUiThread {
                // 이 경로는 프레임·origin 을 못 가린다 — 가져오기(공유받은 글·파일 이름)만큼은 최상위 문서가 우리 프록시
                // origin 일 때만 답한다. 하위 프레임 판별은 여전히 불가(ponytail: 최신 WebView 경로로만 완전히 막힌다).
                val type = req.optString("type")
                val own = web.url?.startsWith("http://localhost:${proxyPort()}/") == true
                if ((type == "getPendingImport" || type == "ackImport") && !own) {
                    val id = req.optInt("id", 0)
                    val data = JSONObject.quote(JSONObject().put("id", id).put("ok", false).put("error", "forbidden").toString())
                    web.evaluateJavascript("window.BriseNative && window.BriseNative.onmessage && window.BriseNative.onmessage({data:$data})", null)
                    return@runOnUiThread
                }
                handle(req) { json ->
                    val data = JSONObject.quote(json.toString())
                    web.evaluateJavascript("window.BriseNative && window.BriseNative.onmessage && window.BriseNative.onmessage({data:$data})", null)
                }
            }
        }
    }
}
