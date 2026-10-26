// 원격(HTTP POST /api/v1/invoke) 호출자가 하면 안 되는 것의 판정 — invoke.rs 가 디스패치 앞뒤에서
// 부르는 순수 함수들. 데스크톱 로컬 Tauri IPC 는 invoke.rs 자체를 타지 않으므로 이 정책의 대상이
// 아니다. 생성 코드(dispatch.gen.rs)의 arm 에는 커맨드별 예외를 둘 자리가 없어서 여기서 막는다.
//
// 설정 키 차단 목록은 TS 쪽 미러(src/lib/remoteSettingsPolicy.ts)와 짝이다 — 갈라지면
// remoteSettingsPolicy.test.ts 가 이 파일을 직접 읽어 잡는다.

/// settings_set 원격 차단 목록 — sync_* 접두사(서버 lifecycle 전체) + AI 프로바이더 설정 5종
/// (repo::transfer::export::is_secret_setting_key 의 ai_api_key 항목과 취지는 같지만 그건 "번들에
/// 못 싣는다"는 별개의 경계라 재사용하지 않는다 — 여기는 "원격 API로 못 바꾼다"이고, ai_provider/
/// ai_endpoint/ai_enabled 는 그 자체로는 비밀이 아니어도 exfil 채널을 여는 데 충분하다).
/// capture_clip_enabled/capture_ingest_* 도 sync_* 와 같은 클래스다(Phase 2): 이 기기 loopback
/// ingest 리스너의 lifecycle 이고, 그 제어 커맨드(commands/capture.rs)는 전부 http:false 다.
/// capture_screenshot_enabled 는 여기 넣지 않는다 — 서버 lifecycle 이 아니라 순수한 UI 게이트다.
pub(super) fn is_remote_blocked_settings_key(k: &str) -> bool {
    k.starts_with("sync_")
        || matches!(
            k,
            "ai_provider"
                | "ai_endpoint"
                | "ai_api_key"
                // 비활성 프로바이더 키 보관함 — 전환 한 번이면 ai_api_key/ai_endpoint 로 올라온다.
                | "ai_provider_creds"
                | "ai_enabled"
                | "capture_clip_enabled"
                | "capture_ingest_port"
                | "capture_ingest_token"
                // 이 기기 파일시스템 쓰기 위치 — 원격이 화면 저장 폴더를 임의 경로로 돌리면 안 된다.
                | "capture_screenshot_dir"
                // 이 기기에서 **실행되는 프로그램 경로** — slide_preview_render 가 pptx/odp 미리보기 때
                // 이 경로를 그대로 spawn 한다(repo/slide_render.rs::soffice_path, override 가 우선).
                // 첨부 업로드는 확장자를 거르지 않으므로 토큰 하나로 exe 를 올리고 여기를 그 경로로
                // 돌리면 오너가 노트를 여는 순간 오너 세션에서 실행된다(AUDIT-2026-10-23 R1).
                | "soffice_path"
        )
}

/// P1 security: settings_get_all is the one http:true command whose response carries secrets in
/// plaintext (sync_token, ai_api_key) — desktop invoke() never leaves the machine, but this
/// response travels over the LAN/tailnet. Strip the same secret-typed keys export/backup already
/// refuse to persist off-device (is_secret_setting_key), symmetric with the settings_set denylist
/// above. Split out as its own fn (rather than inlined in invoke()) so it's unit-testable on a
/// plain JSON value without needing a live AppHandle/dispatch round trip.
pub(super) fn strip_secret_settings_from_response(cmd: &str, v: &mut serde_json::Value) {
    if cmd == "settings_get_all" {
        if let Some(settings) = v.get_mut("settings").and_then(|s| s.as_object_mut()) {
            settings.retain(|k, _| !crate::repo::transfer::export::is_secret_setting_key(k));
        }
    }
}

/// 외부 AI 서비스를 부르는 원격 커맨드 — rate limit·키 오버라이드 제거가 이 한 판정을 공유한다.
/// audio_transcribe 는 `ai_` 접두가 아니지만(계약상 이름 고정) 요청마다 유료 호출이다.
/// `ai_cancel_call` 은 유료 호출이 아니라 **이미 나간 호출을 끊는** 제어 커맨드라 제외한다 — 폰의 [중단]이
/// rate limit 에 막히면 45초짜리 호출이 계속 돈다(AUDIT-2026-10-10 X-6). 취소 대상은 호출자가 넘기는
/// id / request_id 로만 좁혀진다(커맨드 본문이 둘 다 없으면 VALIDATION).
pub(super) fn is_ai_command(cmd: &str) -> bool {
    cmd != "ai_cancel_call" && (cmd.starts_with("ai_") || cmd == "audio_transcribe")
}

/// 요청 헤더 `X-Brise-Client` — 폰이 자기 쓰기의 메아리를 알아보는 식별자(인증 아님). 형식이 어긋나면 None.
/// invoke.rs 와 attachments.rs(업로드)가 같은 검증을 쓴다.
pub(super) fn client_id(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-brise-client")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 64 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .map(str::to_owned)
}

/// P2 보안(SECURITY-REVIEW-2026-08-04.md #2/#3): settings_set 차단(is_remote_blocked_settings_key)만으로는 부족하다 — ai_* 커맨드
/// 자체가 `endpoint`/`api_key` 를 인자로 받게 설계돼 있어서(dispatch.gen.rs의 ai_cleanup_text 등),
/// 원격 호출자가 settings 를 바꾸지 않고도 그 요청 하나에서만 임의 엔드포인트/키를 실어 보낼 수
/// 있었다. repo 층은 이 값이 없으면 저장된 설정으로 자동 폴백하므로, invoke() 디스패치 직전에
/// 이 두 키를 지우기만 하면 나머지는 이미 있는 폴백 경로가 처리한다. 로컬 Tauri IPC는 이 함수를
/// 거치지 않는다(desktop webview 는 invoke() 자체를 타지 않는다).
pub(super) fn strip_remote_ai_overrides(cmd: &str, args: &mut serde_json::Value) {
    if !is_ai_command(cmd) {
        return;
    }
    if let Some(obj) = args.as_object_mut() {
        obj.remove("endpoint");
        obj.remove("api_key");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // is_remote_blocked_settings_key · strip_secret_settings_from_response 의 정상 경로 테스트는
    // 기능 카탈로그(specs/features/sync.yaml)가 handlers.rs 를 verify 경로로 이름 인용하므로
    // handlers.rs 의 tests 에 남아 있다 — 아래는 그 짝(반대 방향·경계) 테스트.

    /// X-6: 취소 커맨드는 rate limit 대상이 아니다(다른 ai_* 와 audio_transcribe 는 그대로 유료 호출).
    #[test]
    fn ai_cancel_call_is_exempt_from_the_ai_rate_limit() {
        assert!(!is_ai_command("ai_cancel_call"));
        assert!(is_ai_command("ai_organize_note"));
        assert!(is_ai_command("audio_transcribe"));
    }

    #[test]
    fn client_id_accepts_only_short_safe_tokens() {
        let mut h = axum::http::HeaderMap::new();
        assert_eq!(client_id(&h), None);
        h.insert("x-brise-client", "phone-1_A".parse().unwrap());
        assert_eq!(client_id(&h).as_deref(), Some("phone-1_A"));
        h.insert("x-brise-client", "bad id!".parse().unwrap());
        assert_eq!(client_id(&h), None);
    }

    /// Stripping is scoped to settings_get_all only — an unrelated command's response (which
    /// might coincidentally contain a field named "sync_token" for some other reason) must not be
    /// touched, and a response body cmd match must be exact.
    #[test]
    fn strip_secret_settings_is_a_noop_for_other_commands() {
        let mut v = serde_json::json!({ "settings": { "sync_token": "should-survive" } });
        strip_secret_settings_from_response("settings_set", &mut v);
        assert_eq!(v["settings"]["sync_token"], "should-survive");
    }

    /// A remote ai_test_connection call with a caller-supplied endpoint/api_key must
    /// have both keys stripped before the args ever reach dispatch — repo falls back to the
    /// stored settings when they're absent.
    #[test]
    fn strip_remote_ai_overrides_removes_endpoint_and_api_key_for_ai_commands() {
        let mut args = serde_json::json!({
            "provider": "openai",
            "endpoint": "https://attacker.example/v1",
            "api_key": "sk-attacker",
        });
        strip_remote_ai_overrides("ai_test_connection", &mut args);
        let obj = args.as_object().unwrap();
        assert!(!obj.contains_key("endpoint"), "endpoint must be stripped from ai_* args");
        assert!(!obj.contains_key("api_key"), "api_key must be stripped from ai_* args");
        assert_eq!(obj["provider"], "openai", "unrelated fields must survive untouched");
    }

    /// A non-ai command's args must pass through completely unmodified, even if they
    /// happen to carry fields named endpoint/api_key for unrelated reasons.
    #[test]
    fn strip_remote_ai_overrides_is_a_noop_for_non_ai_commands() {
        let mut args = serde_json::json!({ "endpoint": "should-survive", "api_key": "should-survive-too" });
        strip_remote_ai_overrides("settings_set", &mut args);
        assert_eq!(args["endpoint"], "should-survive");
        assert_eq!(args["api_key"], "should-survive-too");
    }
}
