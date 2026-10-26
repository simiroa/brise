// repo: ai (R4 분리: repo/ai.rs → repo/ai/ 디렉터리 모듈) — commands/ai.yaml.
// mod.rs: provider 해석 + Provider enum + 커맨드가 직접 부르는 진입 함수(propose/translate_inner/
// cleanup_text_inner/generate_from_prompt_inner/test_connection). 하위 모듈:
// transport.rs(HTTP 왕복 + 재시도 + 상태 분류 + provider별 payload 테이블), prompts.rs(프롬프트
// 합성 + extract_json), history.rs(ai_history 영속). gemini_transcribe_audio(받아쓰기 전용)는
// 받아쓰기 기능째 제거됐다(PLAN-2026-08-21-settings-overhaul W9-a).
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub mod call_log;
mod history;
mod oauth;
mod prompts;
mod transport;

pub use history::{
    get_history, get_usage, record_history, record_usage, summarize_completion_for_history, summarize_error_for_history,
    summarize_prompt_for_history, AiAuditEvent, AiHistoryItem, AiUsageRow,
};
// OpenRouter 로그인 연결(OAuth PKCE) — commands::ai::ai_openrouter_connect 만 부른다.
pub use oauth::connect as openrouter_connect;
pub use prompts::{compose_organize_system_prompt, extract_json, merge_organize_guidance, resolve_folder_name, tag_vocabulary_top, AI_TAG_VOCAB_CAP};
// 시간 초과 판정 문자열 — commands::pet 이 스크린샷 요약 상태를 이걸로 가른다(리터럴 복제 금지).
// 취소 판정 문자열(W5, PLAN-2026-09-05 §3 C-5 2단계) — 같은 자세로 재수출.
pub use transport::{AUDIO_UNSUPPORTED_PROVIDER, CALL_CANCELLED, DEADLINE_EXCEEDED};

pub const DEFAULT_OLLAMA_MODEL: &str = "llama3.1";
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-4o-mini";
pub const DEFAULT_CLAUDE_MODEL: &str = "claude-haiku-4-5-20251001";
// 오너 고정(2026-08-05): 기본 gemini-3.1-flash-lite, 실패 시 gemma-4-31b 로 1회 폴백.
// 설정 화면의 모델 칸은 "고급"에 접혀 있고 비어 있는 게 정상이라(API 키만 넣으면 되게), 이
// 두 상수가 사실상의 기본 조합이다. ai_model_fallback 설정이 비어 있을 때만 아래 값이 쓰인다.
pub const DEFAULT_GEMINI_MODEL: &str = "gemini-3.1-flash-lite";
pub const DEFAULT_GEMINI_FALLBACK_MODEL: &str = "gemma-4-31b-it";
pub const DEFAULT_MINIMAX_MODEL: &str = "MiniMax-M2.5";
// OpenRouter 모델 id 는 네임스페이스가 붙는다(`openai/gpt-4o-mini`) — 다른 프로바이더의
// 맨 이름을 그대로 쓰면 404 다. 설정 화면의 모델 프리셋도 같은 규칙을 따른다.
pub const DEFAULT_OPENROUTER_MODEL: &str = "openai/gpt-4o-mini";


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    OpenAI,
    Claude,
    Gemini,
    Minimax, // Anthropic 호환 API (https://api.minimax.io/anthropic/v1) — claude 어댑터 재사용
    // OpenAI 호환 API — openai 어댑터를 그대로 재사용한다(Minimax↔Claude 와 같은 관계).
    // 별개 variant 인 이유는 전송 방식이 아니라 기본 엔드포인트·기본 모델·표시 이름이 달라서다.
    OpenRouter,
}

impl Provider {
    /// provider 별 기본 엔드포인트. endpoint 미지정(또는 공백)일 때 폴백값.
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            Provider::Ollama => "http://localhost:11434",
            Provider::OpenAI => "https://api.openai.com/v1",
            Provider::Claude => "https://api.anthropic.com/v1",
            Provider::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Provider::Minimax => "https://api.minimax.io/anthropic/v1",
            Provider::OpenRouter => "https://openrouter.ai/api/v1",
        }
    }
}

/// 엔드포인트가 이 기기(루프백)를 가리키는지. 호스트만 보고 판단한다.
/// translate_inner/privacy_gate_ok 의 프라이버시 게이트가 공유하는 단일 구현 — 원래 repo/vector.rs
/// (임베딩 프라이버시 게이트)에도 있었으나 vector 서브시스템 제거(semantic search 폐기)로 이곳이
/// 유일한 사용처가 됐다.
pub(crate) fn is_loopback_endpoint(endpoint: &str) -> bool {
    let rest = endpoint
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(endpoint);
    // userinfo@ 제거 후 host[:port]/path 에서 host 만 취한다.
    let host_port = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
    let host_port = host_port
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(host_port);
    let host = if let Some(end) = host_port.strip_prefix('[') {
        // IPv6 리터럴: [::1]:11434
        end.split_once(']').map(|(h, _)| h).unwrap_or(end)
    } else {
        host_port.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_port)
    };
    let host = host.trim().to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0"
}

#[cfg(test)]
mod loopback_tests {
    use super::*;

    #[test]
    fn detects_common_loopback_hosts() {
        assert!(is_loopback_endpoint("http://localhost:11434"));
        assert!(is_loopback_endpoint("http://127.0.0.1:11434"));
        assert!(is_loopback_endpoint("http://[::1]:11434"));
        assert!(is_loopback_endpoint("http://0.0.0.0:11434"));
        assert!(is_loopback_endpoint("LOCALHOST")); // 대소문자 무시
    }

    #[test]
    fn strips_userinfo_before_checking_host() {
        assert!(is_loopback_endpoint("http://user:pass@localhost:11434/v1"));
    }

    #[test]
    fn rejects_remote_hosts() {
        assert!(!is_loopback_endpoint("https://api.openai.com/v1"));
        assert!(!is_loopback_endpoint("http://192.168.1.10:11434"));
        assert!(!is_loopback_endpoint("http://example.com"));
    }
}

/// provider 문자열 → enum 변환 + endpoint 폴백을 한 곳에서 처리한다. 이전엔 이 ~16줄 블록이
/// ai_organize/test_connection/translate/cleanup/generate 5개 커맨드에 복붙돼 있었고, organize만
/// 공백 endpoint 필터(`filter(|e| !e.trim().is_empty())`)가 빠져 빈/공백 문자열을 그대로 전송하는
/// 드리프트 버그가 있었다. 이제 전부 공백을 "미지정"으로 취급한다(안전한 통일).
pub fn resolve_provider_and_endpoint(
    provider: &str,
    endpoint: Option<String>,
) -> AppResult<(Provider, String)> {
    let p = match provider {
        "ollama" => Provider::Ollama,
        "openai" => Provider::OpenAI,
        "claude" => Provider::Claude,
        "gemini" => Provider::Gemini,
        "minimax" => Provider::Minimax,
        "openrouter" => Provider::OpenRouter,
        _ => return Err(AppError::Validation(format!("Unknown provider: {provider}"))),
    };
    let ep = endpoint
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| p.default_endpoint().to_string());
    Ok((p, ep))
}

#[cfg(test)]
mod resolve_endpoint_tests {
    use super::*;

    #[test]
    fn unknown_provider_rejected() {
        assert!(resolve_provider_and_endpoint("bogus", None).is_err());
    }

    #[test]
    fn missing_endpoint_falls_back_to_default() {
        let (p, ep) = resolve_provider_and_endpoint("openai", None).unwrap();
        assert!(matches!(p, Provider::OpenAI));
        assert_eq!(ep, "https://api.openai.com/v1");
    }

    #[test]
    fn blank_endpoint_falls_back_to_default() {
        // 드리프트 회귀 가드: 이전엔 ai_organize_note 만 공백 endpoint 를 그대로 전송했다.
        // 이제 모든 커맨드가 공유하는 이 헬퍼가 공백/화이트스페이스를 "미지정"으로 취급한다.
        for blank in ["", "   ", "\t"] {
            let (_, ep) = resolve_provider_and_endpoint("ollama", Some(blank.to_string())).unwrap();
            assert_eq!(ep, "http://localhost:11434", "blank {blank:?} should fall back");
        }
    }

    #[test]
    fn explicit_endpoint_preserved() {
        let (_, ep) =
            resolve_provider_and_endpoint("claude", Some("https://proxy.local/v1".to_string()))
                .unwrap();
        assert_eq!(ep, "https://proxy.local/v1");
    }
}

/// settings 테이블에서 읽은 AI 자격증명 스냅샷 — provider 문자열은 아직
/// `resolve_provider_and_endpoint`를 거치지 않은 원시값(호출자가 필요할 때 해석한다).
/// 원래 `sync_server::ingest.rs::read_ledger_ai_creds`에 있던 튜플이었으나(가계부 AI 파싱
/// 전용), collect의 `summary` 후처리(PLAN-2026-09-04-local-import §2.4)도 같은 설정 키를
/// 같은 폴백(ollama 로컬 모델 우선)으로 읽어야 해서 여기로 옮겨 공유한다.
#[derive(Debug, Clone)]
pub struct AiCreds {
    pub provider: String,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub ai_enabled: bool,
}

/// settings에서 AI 자격증명을 읽는다. 키가 없으면 provider는 "ollama"로 폴백 — 문자 올 때마다
/// 도는 가계부 파싱이나 하루 한 번 도는 collect 요약처럼, 사용자 확인 없이 자동으로 도는
/// 백그라운드 호출은 로컬 모델이 기본이어야 한다는 원칙(§privacy_gate_ok와 동일 전제).
pub fn read_ai_creds(conn: &rusqlite::Connection) -> AiCreds {
    // 설정 조회 오류는 여기서 삼킨다(기본값 = provider "ollama", ai_enabled false). 오류를
    // 전파하고 싶은 호출자는 직접 get_all 한 뒤 read_ai_creds_from 을 부른다. U8(AUDIT-2026-09-26
    // -fallback-observability.md) — 이 폴백 자체는 그대로 두되(문자 올 때마다 도는 배경 호출이
    // 설정 조회 실패로 막히면 안 된다는 원칙은 유효), 조용히 삼키지만 말고 diag 에는 남긴다.
    let settings = crate::repo::settings::get_all(conn).unwrap_or_else(|e| {
        crate::diag::warn("ai", "creds_read_failed", format!("{e}"));
        Default::default()
    });
    read_ai_creds_from(&settings)
}

/// 이미 읽어 온 설정 맵에서 AI 자격증명을 뽑는다 — settings 접근이 없는 순수 함수.
/// `read_ai_creds`(오류를 삼키는 편의 진입점)와 `get_all(..)?` 로 오류를 전파해야 하는
/// 커맨드들(collect_source_add_nl · pet · suggestions)이 이 한 곳을 공유한다.
/// 공백뿐인 값은 전부 "미지정"으로 본다 — provider 도 마찬가지라 `"  "` 는 ollama 로 떨어진다.
pub fn read_ai_creds_from(settings: &std::collections::BTreeMap<String, serde_json::Value>) -> AiCreds {
    let str_of = |k: &str| {
        settings
            .get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    AiCreds {
        provider: str_of("ai_provider").unwrap_or_else(|| "ollama".to_string()),
        endpoint: str_of("ai_endpoint"),
        api_key: str_of("ai_api_key"),
        model: str_of("ai_model"),
        ai_enabled: settings.get("ai_enabled").and_then(|v| v.as_bool()).unwrap_or(false),
    }
}

#[cfg(test)]
mod read_ai_creds_tests {
    use super::*;

    fn conn_with_settings(pairs: &[(&str, serde_json::Value)]) -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        if !pairs.is_empty() {
            let entries: std::collections::BTreeMap<String, serde_json::Value> =
                pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
            crate::repo::settings::set(&mut conn, &entries).unwrap();
        }
        conn
    }

    #[test]
    fn falls_back_to_ollama_when_provider_unset() {
        let conn = conn_with_settings(&[]);
        let creds = read_ai_creds(&conn);
        assert_eq!(creds.provider, "ollama");
        assert!(!creds.ai_enabled);
        assert!(creds.endpoint.is_none());
    }

    #[test]
    fn falls_back_and_reports_diag_when_settings_read_fails() {
        // U8(AUDIT-2026-09-26-fallback-observability.md) 회귀 가드 — 마이그레이션을 안 돌린
        // 연결이라 "settings" 테이블 자체가 없다 → get_all 이 Err. 폴백 값(ollama/false)은
        // 그대로 유지하되, 이번엔 조용히 삼키지 말고 diag 에 남아야 한다.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let creds = read_ai_creds(&conn);
        assert_eq!(creds.provider, "ollama");
        assert!(!creds.ai_enabled);

        let found = crate::diag::recent(500)
            .into_iter()
            .find(|e| e.feature == "ai" && e.code == "creds_read_failed");
        assert!(found.is_some(), "settings get_all failure must reach diag");
    }

    #[test]
    fn reads_configured_provider_and_treats_blank_strings_as_unset() {
        let conn = conn_with_settings(&[
            ("ai_provider", serde_json::json!("openai")),
            ("ai_endpoint", serde_json::json!("   ")),
            ("ai_api_key", serde_json::json!("sk-test")),
            ("ai_model", serde_json::json!("gpt-4o-mini")),
            ("ai_enabled", serde_json::json!(true)),
        ]);
        let creds = read_ai_creds(&conn);
        assert_eq!(creds.provider, "openai");
        assert_eq!(creds.endpoint, None, "blank endpoint must be treated as unset");
        assert_eq!(creds.api_key.as_deref(), Some("sk-test"));
        assert_eq!(creds.model.as_deref(), Some("gpt-4o-mini"));
        assert!(creds.ai_enabled);
    }

    // --- read_ai_creds_from: 커맨드 3곳(collect·pet·suggestions)의 인라인 판을 이 함수로
    // 합치면서 고정하는 특성화 테스트. 맵을 직접 넘기므로 DB 를 타지 않는다.

    fn map_of(pairs: &[(&str, serde_json::Value)]) -> std::collections::BTreeMap<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn from_map_defaults_when_empty() {
        let creds = read_ai_creds_from(&map_of(&[]));
        assert_eq!(creds.provider, "ollama");
        assert_eq!(creds.endpoint, None);
        assert_eq!(creds.api_key, None);
        assert_eq!(creds.model, None);
        assert!(!creds.ai_enabled);
    }

    #[test]
    fn from_map_blank_provider_falls_back_to_ollama() {
        // 인라인 판(`p.is_empty()`)은 공백만 있는 provider 를 그대로 통과시켜
        // resolve_provider_and_endpoint 에서 알 수 없는 프로바이더로 터졌다. 공용 판은 trim 후
        // 비면 미지정으로 본다 — 통합 시 허용된 단 하나의 동작 차이.
        for blank in ["", "   ", "\t"] {
            let creds = read_ai_creds_from(&map_of(&[("ai_provider", serde_json::json!(blank))]));
            assert_eq!(creds.provider, "ollama", "blank {blank:?} should fall back");
        }
    }

    #[test]
    fn from_map_blank_strings_are_unset() {
        let creds = read_ai_creds_from(&map_of(&[
            ("ai_endpoint", serde_json::json!("  ")),
            ("ai_api_key", serde_json::json!("")),
            ("ai_model", serde_json::json!("\t")),
        ]));
        assert_eq!(creds.endpoint, None);
        assert_eq!(creds.api_key, None);
        assert_eq!(creds.model, None);
    }

    #[test]
    fn from_map_ai_enabled_only_true_for_bool_true() {
        // 문자열 "true" 는 불리언이 아니라 false — 설정 저장이 타입을 지키는 전제.
        for (v, want) in [
            (serde_json::json!(true), true),
            (serde_json::json!(false), false),
            (serde_json::json!("true"), false),
            (serde_json::json!(null), false),
        ] {
            let creds = read_ai_creds_from(&map_of(&[("ai_enabled", v.clone())]));
            assert_eq!(creds.ai_enabled, want, "ai_enabled={v}");
        }
    }

    #[test]
    fn from_map_keeps_configured_values_verbatim() {
        let creds = read_ai_creds_from(&map_of(&[
            ("ai_provider", serde_json::json!("openai")),
            ("ai_endpoint", serde_json::json!("https://proxy.local/v1")),
            ("ai_api_key", serde_json::json!("sk-test")),
            ("ai_model", serde_json::json!("gpt-4o-mini")),
            ("ai_enabled", serde_json::json!(true)),
        ]));
        assert_eq!(creds.provider, "openai");
        assert_eq!(creds.endpoint.as_deref(), Some("https://proxy.local/v1"));
        assert_eq!(creds.api_key.as_deref(), Some("sk-test"));
        assert_eq!(creds.model.as_deref(), Some("gpt-4o-mini"));
        assert!(creds.ai_enabled);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProposal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    // 모델이 고른 폴더 "이름"(raw) — 아직 워크스페이스 폴더 목록과 대조되지 않은 값. id로의
    // 해석은 commands::ai::ai_organize_note_inner가 resolve_folder_name으로 수행한다(이 구조체는
    // 프로바이더 응답 그대로를 담는 계층이라 여기서 검증하지 않음).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lng: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_urls: Option<Vec<String>>,
    #[serde(default)]
    pub confidence: f32,
}

/// ai_organize_note의 반환 타입 — propose-only(P0-2): 커밋된 필드가 없으므로 `applied`는
/// 없다. 실제 DB 반영은 사용자가 Apply를 눌렀을 때 별도 커맨드 ai_apply_organize가
/// notes::apply_ai_organize를 호출해 수행하고, 그 결과(실제 변경 필드)는
/// commands::ai::AiApplyOrganizeResult가 반환한다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiOrganizeResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    // 해석 완료된 폴더 제안 — 둘 다 Some이거나 둘 다 None(부분 상태 없음). folder_name은 모델이
    // 뱉은 원문이 아니라 resolve_folder_name이 후보 목록에서 찾아낸 정식 이름(대소문자/공백 정규화
    // 이전 원문과 다를 수 있음) — 모달이 사용자에게 보여줄 표시용, folder_id가 apply에 쓰이는 실값.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lng: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_urls: Option<Vec<String>>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub latency_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

/// `ai_model_fallback` 설정값(커맨드 계층이 commands::ai::fallback_model_setting 에서 읽어 넘긴다)을
/// 실어 실전송한다. None = 폴백 미설정(gemini 는 그래도 transport::resolve_fallback_model 이
pub async fn propose_with_transport<T: TextTransport>(
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model_opt: Option<String>,
    body_md: String,
    candidate_folders: Vec<String>,
    candidate_tags: Vec<String>,
    custom_guidance: Option<String>,
    transport: &T,
) -> AppResult<AiProposal> {
    let mut body = body_md;
    let char_count = body.chars().count();
    if char_count > 8192 {
        let mut new_body: String = body.chars().take(8192).collect();
        new_body.push_str("\n\n…[truncated]");
        body = new_body;
    }

    let system_prompt =
        compose_organize_system_prompt(&candidate_folders, &candidate_tags, custom_guidance.as_deref());
    let raw = transport.send_text(provider, endpoint, api_key, model_opt, system_prompt, body).await?;
    extract_json(&raw)
}

/// 결제문자/알림 원문 하나에서 뽑아낸 가계부 항목 — 필드 전부 Option: 모델이 못 뽑으면 null,
/// amount가 없으면 UI/ingest가 "파싱 실패"로 취급해 원문만 남긴다(추측해서 채우지 않는다).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LedgerExtraction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merchant: Option<String>,
    /// 방향(지출/입금) 부호 없이 항상 양수 — 방향은 is_expense가 별도로 나른다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    /// ISO 4217 통화 코드. 모델이 못 정하면 ingest 쪽이 "KRW"로 기본 처리(한국 카드/은행
    /// 알림이 압도적 다수일 사용 맥락 — settings에 통화 설정이 생기면 그때 대체).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// 짧은 한국어 카테고리(식비/교통/쇼핑/구독/기타 등) — 고정 enum이 아니라 자유 텍스트다:
    /// 카테고리 체계를 이 기능이 새로 발명하지 않는다(ponytail, 필요해지면 사용자 사전 도입).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// true=지출(결제/출금), false=입금/환불/취소. 모델이 방향을 못 읽으면 None — ingest는
    /// None을 "지출로 간주"가 아니라 "파싱 신뢰 낮음"으로 표시한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_expense: Option<bool>,
}

fn ledger_system_prompt() -> String {
    "You extract structured payment info from a single bank/card payment notification SMS or \
     push notification (Korean or English). Respond with ONLY a JSON object (no markdown fences, \
     no commentary, no extra keys) matching this shape:\n\
     {\"merchant\": string|null, \"amount\": number|null, \"currency\": string|null, \
     \"category\": string|null, \"is_expense\": boolean|null}\n\
     Rules:\n\
     - amount is always a positive number (no sign, no currency symbol, no thousands separators) \
     — the raw digits only. If you cannot find a clear amount, use null; do not guess.\n\
     - is_expense=true for a payment/charge/결제/출금/승인. is_expense=false for a \
     deposit/refund/cancellation/입금/환불/취소. If direction is unclear, use null.\n\
     - category is a short Korean word (식비, 교통, 쇼핑, 구독, 카페, 의료, 기타, …) guessed from \
     the merchant name; use null if you have no reasonable guess.\n\
     - currency is an ISO 4217 code (KRW, USD, …) if stated or obviously implied by a won/원/$ \
     sign; otherwise null.\n\
     - If the text is not a payment notification at all (e.g. an unrelated SMS), return all \
     fields null.".to_string()
}

/// 원문 한 건 → LedgerExtraction. propose_with_transport와 같은 자세(트랜스포트만 주입받아
/// 테스트 가능) — 다만 이쪽은 노트 본문이 아니라 SMS 한 통(대개 수백 자 이내)이라 8192자 절단
/// 로직은 없다.
pub async fn parse_ledger_text_with_transport<T: TextTransport>(
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model_opt: Option<String>,
    raw_text: String,
    transport: &T,
) -> AppResult<LedgerExtraction> {
    let raw = transport
        .send_text(provider, endpoint, api_key, model_opt, ledger_system_prompt(), raw_text)
        .await?;
    extract_json(&raw)
}

#[allow(clippy::too_many_arguments)]
pub async fn propose_inner(
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model_opt: Option<String>,
    body_md: String,
    candidate_folders: Vec<String>,
    candidate_tags: Vec<String>,
    custom_guidance: Option<String>,
    fallback_model: Option<String>,
) -> AppResult<AiProposal> {
    let transport = RealTextTransport::new(fallback_model);
    propose_with_transport(
        provider,
        endpoint,
        api_key,
        model_opt,
        body_md,
        candidate_folders,
        candidate_tags,
        custom_guidance,
        &transport,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn propose(
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model_opt: Option<String>,
    body_md: String,
    candidate_folders: Vec<String>,
    candidate_tags: Vec<String>,
    custom_guidance: Option<String>,
) -> AppResult<AiProposal> {
    // 이 얇은 래퍼는 설정을 읽지 않는다 — 폴백 모델을 실어 보내는 경로는
    // commands::ai(ai_organize_note)가 소유한다.
    propose_inner(
        provider,
        endpoint,
        api_key,
        model_opt,
        body_md,
        candidate_folders,
        candidate_tags,
        custom_guidance,
        None,
    )
    .await
}

// ── 번역 (에디터 툴바 토글, 마이크 아이콘 옆) ──────────────────────────────────────────
// ai_organize_note 와 같은 프로바이더 세트를 재사용하지만 응답을 JSON 이 아닌 평문으로
// 받는다는 점이 달라 별도 트레잇(TranslateTransport)으로 분리했다 — HttpTransport 를 억지로
// 재사용하면 AiProposal 반환 타입에 번역문을 욱여넣어야 해서 organize 쪽 테스트/목킹까지
// 오염시킨다.
pub const TRANSLATE_CHAR_CAP: usize = 8192; // ai_organize_note 와 동일한 본문 상한 — 비용/지연 일관성

#[allow(async_fn_in_trait)]
pub trait TranslateTransport: Send + Sync {
    async fn translate(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        text: String,
        target_lang: String,
    ) -> AppResult<String>;
}

pub struct RealTranslateTransport {
    fallback_model: Option<String>,
}

impl RealTranslateTransport {
    pub fn new(fallback_model: Option<String>) -> Self {
        Self { fallback_model }
    }
}

impl TranslateTransport for RealTranslateTransport {
    /// PLAN-2026-09-05 §3 C-4: 이전엔 이 함수가 call_log 를 전혀 지나지 않았다(재시도/폴백만
    /// 하고 곧장 반환) — send_text/send_vision 과 같은 단일 헬퍼(transport::logged_call)를
    /// 지나게 해 번역 호출도 로그·진행 표시·취소 대상이 되게 한다. op/caller 는 CALL_CTX
    /// (commands::ai::ai_translate_text 가 with_call_ctx 로 세팅)에서 채워진다.
    async fn translate(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        text: String,
        target_lang: String,
    ) -> AppResult<String> {
        let client = transport::build_client(30)?;
        let sys = prompts::translate_system_prompt(&target_lang);
        let (client, provider_ref, endpoint, key, sys, text) = (
            &client,
            &provider,
            endpoint.as_str(),
            api_key.as_deref().unwrap_or(""),
            sys.as_str(),
            text.as_str(),
        );

        transport::logged_call(
            None,
            &provider,
            model_opt,
            self.fallback_model.clone(),
            transport::TEXT_OPERATION_DEADLINE,
            text,
            move |model| async move {
                transport::provider_send_text(client, provider_ref, endpoint, key, &model, sys, text).await
            },
        )
        .await
    }
}

/// 번역 프라이버시 게이트 + 본문 상한 + 프로바이더 호출. `ai_enabled` 판정은 호출부(커맨드
/// 레이어)가 settings 에서 읽어 넘긴다 — repo 계층은 DB 접근 없이도 테스트 가능하게 유지.
/// 규칙(resolve_embed_config 의 R15-privacy 와 동일): provider=ollama AND 엔드포인트가
/// loopback 이면 ai_enabled 없이도 실행(추론이 기기를 벗어나지 않으므로 동의 대상이 아님).
/// 그 외(클라우드 프로바이더 또는 원격 ollama)는 ai_enabled 가 true 여야 한다 — 아니면 노트
/// 본문을 사용자 동의 없이 제3자에게 보내는 것이므로 VALIDATION 으로 거부한다.
pub async fn translate_inner<T: TranslateTransport>(
    text: String,
    target_lang: String,
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    ai_enabled: bool,
    transport: &T,
) -> AppResult<String> {
    let is_local = matches!(provider, Provider::Ollama) && is_loopback_endpoint(&endpoint);
    if !is_local && !ai_enabled {
        return Err(AppError::Validation(
            "cloud translation requires ai_enabled (Settings > AI)".to_string(),
        ));
    }

    let mut body = text;
    let char_count = body.chars().count();
    if char_count > TRANSLATE_CHAR_CAP {
        let mut new_body: String = body.chars().take(TRANSLATE_CHAR_CAP).collect();
        new_body.push_str("\n\n…[truncated]");
        body = new_body;
    }
    if body.trim().is_empty() {
        return Ok(String::new());
    }

    let translated = transport.translate(provider, endpoint, api_key, model, body, target_lang).await?;
    Ok(translated.trim().to_string())
}

// ── 정리 / 프롬프트 생성 (AI 드롭다운의 "에디터 내용 정리" · "프롬프트 박스") ──────────────────
// 두 기능 모두 "시스템 프롬프트 + 사용자 텍스트 → 평문 응답" 이라는 점에서 번역과 형태가
// 완전히 같다 — 그래서 프로바이더별 HTTP 호출은 위의 ollama_translate/openai_translate/
// claude_translate/gemini_translate를 그대로 재사용한다(이름은 "translate"지만 구현은 이미
// sys/text 두 문자열만 받는 범용 함수다). 새로 필요한 건 "시스템 프롬프트를 무엇으로 할지"를
// 고르는 이 얇은 트레잇뿐 — TranslateTransport를 억지로 재사용하면 target_lang을 받아야 해서
// 호출부가 의미 없는 값을 채워 넣어야 한다.
pub const AI_TEXT_CHAR_CAP: usize = TRANSLATE_CHAR_CAP; // 정리 본문은 짧은 편집 작업이므로 8192자 정책

/// 생성 요청의 prompt와 optional context를 합친 상한. 에이전트 병합 초안은 본문을 prompt에
/// 넣으므로 context만 제한하면 우회된다. 32K는 현재 병합 초안 입력량을 유지하면서, 한 요청이
/// 무한히 커지는 것을 막는 운영 상한이다. 생성 경로는 내용을 조용히 자르지 않고 초과를 명시적
/// VALIDATION으로 돌려준다 — 호출자가 축약/분할 여부를 사용자에게 보여 줄 수 있어야 한다.
pub const AI_GENERATE_INPUT_CHAR_CAP: usize = 32_000;

/// `send_json` 응답 파서 — 구조화 출력(Gemini `responseSchema`)은 대개 깨끗하지만, ```` ```json
/// {...} ``` ```` 펜스로 감싸거나 앞뒤에 짧은 인사말을 붙이는 모델도 있다(Gemma 실측,
/// 2026-09-05). 펜스를 벗긴 뒤 첫 `{`~마지막 `}` 구간만 잘라 파싱한다 — `extract_json`
/// (organize/ledger 경로)보다 한 단계 더 관대한 버전으로, 대상이 항상 JSON *객체* 하나뿐이라
/// (배열이나 스칼라 없음) `Value`만 반환한다.
fn parse_json_object_lenient(text: &str) -> AppResult<serde_json::Value> {
    let mut s = text.trim();
    if let Some(rest) = s.strip_prefix("```json") {
        s = rest;
    } else if let Some(rest) = s.strip_prefix("```") {
        s = rest;
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest;
    }
    s = s.trim();
    let (Some(start), Some(end)) = (s.find('{'), s.rfind('}')) else {
        return Err(AppError::Io(format!("no JSON object found in AI response: {s}")));
    };
    if end < start {
        return Err(AppError::Io(format!("no JSON object found in AI response: {s}")));
    }
    serde_json::from_str(&s[start..=end]).map_err(|e| AppError::Io(format!("failed to parse JSON object from AI response: {e}")))
}

#[allow(async_fn_in_trait)]
pub trait TextTransport: Send + Sync {
    async fn send_text(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
    ) -> AppResult<String>;

    /// 구조화(JSON) 응답이 필요한 호출자용 — 기본 구현은 `send_text`에 스키마 지시를 시스템
    /// 프롬프트에 덧붙여 위임하고 관대한 파서로 결과를 되읽는다. 네이티브 JSON 모드가 있는
    /// provider(Gemini/Ollama)는 `RealTextTransport`가 이 기본 구현을 오버라이드해 실제 스키마
    /// 파라미터를 싣는다 — 이 기본 구현은 "그런 오버라이드가 없어도 컴파일된다"는 계약만
    /// 보장하므로, 기존 가짜 트랜스포트(`send_text`만 구현한 것들)는 손대지 않아도 된다.
    async fn send_json(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
        schema: serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let sys_with_schema = format!(
            "{system_prompt}\n\nRespond with a single JSON object matching this schema and nothing else: {schema}"
        );
        let raw = self.send_text(provider, endpoint, api_key, model_opt, sys_with_schema, user_text).await?;
        parse_json_object_lenient(&raw)
    }
}

/// call_log 의 `provider` 필드용 표시 문자열. transport::provider_label 은 Minimax를 "claude"로
/// 접어버리는데(에러 메시지 하위호환 때문, transport.rs 주석 참고) 디버그 로그는 그럴 이유가
/// 없으므로 Provider 자체의 `#[serde(rename_all = "lowercase")]` 를 그대로 쓴다("ollama" ·
/// "openai" · "claude" · "gemini" · "minimax" · "openrouter").
fn provider_log_label(p: &Provider) -> String {
    serde_json::to_value(p).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "unknown".to_string())
}

pub struct RealTextTransport {
    fallback_model: Option<String>,
    // 명시 설정 없으면 send_text/send_json이 transport::TEXT_OPERATION_DEADLINE(45초, 사용자 대면
    // 예산)을 쓴다 — background()가 이걸 120초로 덮어써 백그라운드 후처리(summary)에 맞춘다.
    deadline: Option<Duration>,
}

impl RealTextTransport {
    pub fn new(fallback_model: Option<String>) -> Self {
        Self { fallback_model, deadline: None }
    }

    /// 이 인스턴스의 send_text/send_json 호출에 적용할 전체 예산(재시도+폴백 포함)을 덮어쓴다.
    pub fn with_deadline(mut self, d: Duration) -> Self {
        self.deadline = Some(d);
        self
    }

    /// 백그라운드 후처리(collect::summary) 전용 생성자 — 45초 사용자 대면 예산 대신 120초
    /// (Ollama 콜드 스타트·큰 Gemma 프롬프트가 45초를 넘기는 실측, PLAN-2026-09-04-local-import
    /// §2.4).
    pub fn background() -> Self {
        Self::new(None).with_deadline(transport::BACKGROUND_OPERATION_DEADLINE)
    }

    /// 실제로 적용될 예산 — with_deadline으로 설정 안 했으면 TEXT_OPERATION_DEADLINE.
    pub(crate) fn deadline(&self) -> Duration {
        self.deadline.unwrap_or(transport::TEXT_OPERATION_DEADLINE)
    }
}

impl TextTransport for RealTextTransport {
    /// PLAN-2026-09-05 §3 C-2/C-4: 실 프로바이더 호출의 단일 지점 중 하나 — 재시도/폴백(안쪽)이
    /// 아니라 이 함수 전체(바깥)를 감싸 기록해, 한 사용자 행동이 로그 한 줄이 되게 한다. begin→
    /// run_cancellable(with_model_fallback_until)→finish 뼈대는 transport::logged_call 로 접었다
    /// (send_json/send_vision/translate 와 공유). op/caller/note_id 는 이 트레잇 시그니처로는
    /// 알 수 없어 CALL_CTX(commands::ai 가 with_call_ctx 로 세팅)에서 채워진다.
    async fn send_text(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
    ) -> AppResult<String> {
        let client = transport::build_client(30)?;
        let (client, provider_ref, endpoint, key, sys, text) = (
            &client,
            &provider,
            endpoint.as_str(),
            api_key.as_deref().unwrap_or(""),
            system_prompt.as_str(),
            user_text.as_str(),
        );

        transport::logged_call(
            None,
            &provider,
            model_opt,
            self.fallback_model.clone(),
            self.deadline(),
            text,
            move |model| async move {
                transport::provider_send_text(client, provider_ref, endpoint, key, &model, sys, text).await
            },
        )
        .await
    }

    /// Gemini/Ollama는 네이티브 구조화 출력이 있으므로 스키마를 payload에 직접 싣는다
    /// (`transport::provider_json_payload`) — Claude/OpenRouter/Minimax는 그런 모드가 없어
    /// 기본 트레잇 구현과 같은 자세(스키마를 시스템 프롬프트에 덧붙임)로 떨어진다. §3 C-4:
    /// send_text 와 같은 transport::logged_call 을 지나므로 이 오버라이드도 이제 기록·취소
    /// 대상이다(이전엔 이 경로가 call_log 를 전혀 지나지 않았다).
    async fn send_json(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
        schema: serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let sys_with_schema = match provider {
            Provider::Gemini | Provider::Ollama => system_prompt,
            _ => format!(
                "{system_prompt}\n\nRespond with a single JSON object matching this schema and nothing else: {schema}"
            ),
        };
        let client = transport::build_client(30)?;
        let (client, provider_ref, endpoint, key, sys, text, schema_ref) = (
            &client,
            &provider,
            endpoint.as_str(),
            api_key.as_deref().unwrap_or(""),
            sys_with_schema.as_str(),
            user_text.as_str(),
            &schema,
        );

        // D7(AUDIT-2026-09-26-fallback-observability.md) — 예전엔 해석이 logged_call 밖(아래
        // 마지막 줄)에서만 돌아, 해석 실패도 call_log 엔 "ok" 로 남았다. logged_call_validated 가
        // 재시도/폴백이 끝난 뒤 한 번 검증해 실패를 "error" 로 기록한다 — 재시도 정책은 그대로
        // (클로저 안에서 Io 로 올리면 5초 재시도·폴백까지 붙는다, transport.rs 주석).
        let raw = transport::logged_call_validated(
            None,
            &provider,
            model_opt,
            self.fallback_model.clone(),
            self.deadline(),
            text,
            move |model| async move {
                transport::provider_send_json(client, provider_ref, endpoint, key, &model, sys, text, schema_ref).await
            },
            |raw| parse_json_object_lenient(raw).map(|_| ()),
        )
        .await?;
        // 위에서 검증을 통과한 문자열이라 여기서 실패하지 않는다 — 값을 뽑기 위한 두 번째 해석
        // (저비용, 기록 지점을 logged_call 하나로 모으는 편을 택했다).
        parse_json_object_lenient(&raw)
    }
}

/// 프라이버시 게이트: translate_inner와 완전히 동일한 판정(중복 아님 — 한 줄짜리 판정을 각
/// 커맨드가 반복하는 게 오히려 어디서 게이트가 걸리는지 추적하기 쉽다는 이 파일의 기존 관례를
/// 따른다). provider=ollama AND loopback이면 ai_enabled 없이도 허용, 그 외에는 필수.
/// pub(crate): commands::ai::ai_organize_note_inner(P0-1 회귀 가드)가 translate/cleanup과
/// 동일하게 이 판정을 직접 호출한다 — organize는 propose_inner에 ai_enabled를 흘려보내는
/// translate_inner류 래핑 대신, commands 계층에서 곧장 게이트를 검사한다(§P0-1).
pub(crate) fn privacy_gate_ok(provider: &Provider, endpoint: &str, ai_enabled: bool) -> bool {
    let is_local = matches!(provider, Provider::Ollama) && is_loopback_endpoint(endpoint);
    is_local || ai_enabled
}

pub async fn cleanup_text_inner<T: TextTransport>(
    text: String,
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    ai_enabled: bool,
    transport: &T,
) -> AppResult<String> {
    if !privacy_gate_ok(&provider, &endpoint, ai_enabled) {
        return Err(AppError::Validation(
            "cloud AI requires ai_enabled (Settings > AI)".to_string(),
        ));
    }

    let mut body = text;
    let char_count = body.chars().count();
    if char_count > AI_TEXT_CHAR_CAP {
        let mut new_body: String = body.chars().take(AI_TEXT_CHAR_CAP).collect();
        new_body.push_str("\n\n…[truncated]");
        body = new_body;
    }
    if body.trim().is_empty() {
        return Ok(String::new());
    }

    let cleaned = transport.send_text(provider, endpoint, api_key, model, prompts::cleanup_system_prompt(), body).await?;
    Ok(cleaned.trim().to_string())
}

pub async fn generate_from_prompt_inner<T: TextTransport>(
    prompt: String,
    context_text: Option<String>,
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    purpose: Option<String>,
    ai_enabled: bool,
    transport: &T,
) -> AppResult<String> {
    let prompt_trimmed = prompt.trim();
    if prompt_trimmed.is_empty() {
        return Err(AppError::Validation("prompt must not be empty".to_string()));
    }
    if !privacy_gate_ok(&provider, &endpoint, ai_enabled) {
        return Err(AppError::Validation(
            "cloud AI requires ai_enabled (Settings > AI)".to_string(),
        ));
    }

    let ctx = context_text.unwrap_or_default();
    let input_chars = prompt_trimmed.chars().count() + ctx.chars().count();
    if input_chars > AI_GENERATE_INPUT_CHAR_CAP {
        return Err(AppError::Validation(format!(
            "prompt and context exceed AI input limit of {AI_GENERATE_INPUT_CHAR_CAP} characters ({input_chars}); reduce or summarize the input"
        )));
    }
    let user_text = if ctx.trim().is_empty() {
        prompt_trimmed.to_string()
    } else {
        format!(
            "User request: {prompt_trimmed}\n\n---\nExisting note context (optional background, use only if relevant):\n{ctx}"
        )
    };

    let generated = transport.send_text(provider, endpoint, api_key, model, prompts::generate_system_prompt(purpose.as_deref()), user_text).await?;
    Ok(generated.trim().to_string())
}

// ── 비전 (펫 "화면 저장" 요약, docs/PLAN-2026-08-09-pet-capture.md Phase 1) ──────────────────
// TextTransport 와 형태가 같지만(시스템 프롬프트 + 사용자 텍스트 → 평문) 이미지 한 장이 더
// 붙는다 — TranslateTransport/TextTransport 를 가른 것과 같은 이유로 트레잇을 따로 둔다:
// TextTransport 시그니처에 이미지를 끼워 넣으면 번역·정리·생성의 모든 목/호출부가 의미 없는
// 인자를 채워야 한다. provider 별 payload 는 transport::provider_vision_payload 한 곳.

#[allow(async_fn_in_trait, clippy::too_many_arguments)]
pub trait VisionTransport: Send + Sync {
    async fn send_vision(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
        // image_base64: 접두사 없는 raw base64. mime: "image/jpeg" 등 미디어 타입.
        image_base64: String,
        mime: String,
    ) -> AppResult<String>;
}

pub struct RealVisionTransport {
    fallback_model: Option<String>,
}

impl RealVisionTransport {
    pub fn new(fallback_model: Option<String>) -> Self {
        Self { fallback_model }
    }
}

impl VisionTransport for RealVisionTransport {
    /// §3 C-4: send_text 와 같은 transport::logged_call 을 지난다. op="vision"은 명시 — 이 경로는
    /// 펫 "화면 저장"(commands::pet, 이 웨이브의 수정 범위 밖)에서만 불려 CALL_CTX 가 세팅되지
    /// 않으므로, 트레잇 시그니처만으로 알 수 있는 이 값을 인자로 준다(caller/note_id 는 여전히
    /// None — ponytail: commands::pet 이 with_call_ctx 로 caller="pet_screenshot" 정도를 세팅하게
    /// 확장할 수 있지만, 그 파일은 이 웨이브 범위 밖이라 손대지 않는다).
    async fn send_vision(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
        image_base64: String,
        mime: String,
    ) -> AppResult<String> {
        // 이미지 업로드가 붙으므로 텍스트 경로(30초)보다 넉넉하게.
        let client = transport::build_client(60)?;
        let (client, provider_ref, endpoint, key, sys, text, img, mime) = (
            &client,
            &provider,
            endpoint.as_str(),
            api_key.as_deref().unwrap_or(""),
            system_prompt.as_str(),
            user_text.as_str(),
            image_base64.as_str(),
            mime.as_str(),
        );

        transport::logged_call(
            Some("vision".to_string()),
            &provider,
            model_opt,
            self.fallback_model.clone(),
            transport::VISION_OPERATION_DEADLINE,
            text,
            move |model| async move {
                transport::provider_send_vision(client, provider_ref, endpoint, key, &model, sys, text, img, mime).await
            },
        )
        .await
    }
}

/// 이미지 한 장 요약. 게이트는 translate/cleanup 과 **동일한** privacy_gate_ok — 화면 캡처는
/// 노트 본문보다 민감할 수 있으므로 예외를 두지 않는다.
#[allow(clippy::too_many_arguments)]
pub async fn describe_image_inner<T: VisionTransport>(
    image_base64: String,
    mime: String,
    context: String,
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    ai_enabled: bool,
    transport: &T,
) -> AppResult<String> {
    if !privacy_gate_ok(&provider, &endpoint, ai_enabled) {
        return Err(AppError::Validation(
            "cloud AI requires ai_enabled (Settings > AI)".to_string(),
        ));
    }
    if image_base64.is_empty() {
        return Err(AppError::Validation("image must not be empty".to_string()));
    }
    let user_text = if context.trim().is_empty() {
        "Summarize this window.".to_string()
    } else {
        format!("Window title: {}\n\nSummarize this window.", context.trim())
    };
    let out = transport
        .send_vision(
            provider,
            endpoint,
            api_key,
            model,
            prompts::screenshot_system_prompt(),
            user_text,
            image_base64,
            mime,
        )
        .await?;
    Ok(out.trim().to_string())
}

// ── 오디오 전사 (PLAN-2026-10-06-s2-input.md §5.4, docs/AI.md "오디오 전사") ─────────────────────
// VisionTransport 와 같은 모양(시스템 프롬프트 + 사용자 텍스트 + 바이너리 1개 → 평문)이지만 payload 가
// Gemini 전용이라 트레잇을 따로 둔다(목 transport 로 게이트·멱등·실패를 외부 호출 0 으로 검증하려는 것).

/// 전사 지시문. 받아쓰기만 한다 — 요약·번역·덧붙임 금지, 못 들은 곳은 지어내지 않는다.
pub const AUDIO_TRANSCRIBE_PROMPT: &str = "Transcribe this audio recording exactly as spoken. Keep the language that is spoken (do not translate). Only add punctuation and paragraph breaks. Do not summarize, do not explain, do not add anything that was not said. If a part is inaudible or unclear, write [들리지 않음] instead of guessing. Output only the transcript text.";

/// 게이트가 닫혔을 때의 **안정 에러 코드**(메시지 접두). 프런트가 "AI 연결 필요" 로 바꾸려고 매칭한다 —
/// 리터럴이 갈라지면 판정이 조용히 죽으므로 생산 코드·테스트가 이 상수를 쓴다.
pub const AUDIO_AI_REQUIRED: &str = "ai_required: audio transcription requires ai_enabled (Settings > AI)";

#[allow(async_fn_in_trait, clippy::too_many_arguments)]
pub trait AudioTransport: Send + Sync {
    async fn send_audio(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
        // audio_base64: 접두사 없는 raw base64. mime: "audio/mp4" 등.
        audio_base64: String,
        mime: String,
    ) -> AppResult<String>;
}

pub struct RealAudioTransport;

impl AudioTransport for RealAudioTransport {
    /// send_vision 과 같은 transport::logged_call 을 지난다(재시도 1회·deadline·call_log·취소).
    /// 폴백 모델은 쓰지 않는다 — Gemma 계열 폴백은 오디오 입력을 받지 못해 같은 실패를 한 번 더 겪을 뿐이다
    /// (전체 오디오를 다시 보내기까지 한다). `fallback_model: None` 은 Gemini 에서 기본 폴백으로 풀리므로
    /// `no_fallback_arg` 로 기본 모델 자신을 넘겨 폴백을 없앤다.
    /// request_text 에는 지시문만 넘긴다(오디오 base64 가 call_log 머리글에 들어가면 안 된다).
    async fn send_audio(
        &self,
        provider: Provider,
        endpoint: String,
        api_key: Option<String>,
        model_opt: Option<String>,
        system_prompt: String,
        user_text: String,
        audio_base64: String,
        mime: String,
    ) -> AppResult<String> {
        let timeout_secs = transport::audio_client_timeout_secs(audio_base64.len());
        let client = transport::build_client(timeout_secs)?;
        let (client, provider_ref, endpoint, key, sys, text, audio, mime) = (
            &client,
            &provider,
            endpoint.as_str(),
            api_key.as_deref().unwrap_or(""),
            system_prompt.as_str(),
            user_text.as_str(),
            audio_base64.as_str(),
            mime.as_str(),
        );
        // `None` 은 Gemini 에서 기본 폴백(Gemma)으로 풀린다 — 그래서 "폴백 없음"을 명시적으로 만든다.
        let fallback = transport::no_fallback_arg(&provider, &model_opt);
        transport::logged_call(
            Some("audio_transcribe".to_string()),
            &provider,
            model_opt,
            fallback,
            transport::AUDIO_OPERATION_DEADLINE,
            text,
            move |model| async move {
                transport::provider_send_audio(client, provider_ref, endpoint, key, &model, sys, text, audio, mime).await
            },
        )
        .await
    }
}

/// 오디오 한 개 전사. 게이트는 translate/cleanup/vision 과 **동일한** privacy_gate_ok 에 `ai_enabled`
/// 를 더한다(오디오가 외부로 나가는 동의의 SSOT 가 ai_enabled — 새 동의 키 없음). 게이트가 닫히면
/// transport 는 한 번도 불리지 않는다.
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_audio_inner<T: AudioTransport>(
    audio_base64: String,
    mime: String,
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
    model: Option<String>,
    ai_enabled: bool,
    transport: &T,
) -> AppResult<String> {
    if !ai_enabled || !privacy_gate_ok(&provider, &endpoint, ai_enabled) {
        return Err(AppError::Validation(AUDIO_AI_REQUIRED.to_string()));
    }
    if !matches!(provider, Provider::Gemini) {
        return Err(AppError::Validation(AUDIO_UNSUPPORTED_PROVIDER.to_string()));
    }
    if audio_base64.is_empty() {
        return Err(AppError::Validation("audio must not be empty".to_string()));
    }
    let out = transport
        .send_audio(
            provider,
            endpoint,
            api_key,
            model,
            "You are a precise speech-to-text transcriber.".to_string(),
            AUDIO_TRANSCRIBE_PROMPT.to_string(),
            audio_base64,
            mime,
        )
        .await?;
    Ok(out.trim().to_string())
}

pub async fn test_connection(
    provider: Provider,
    endpoint: String,
    api_key: Option<String>,
) -> AppResult<ConnectionTest> {
    let client = transport::build_client(10)?;

    let start = std::time::Instant::now();
    let ping_model = match provider {
        Provider::Claude => DEFAULT_CLAUDE_MODEL,
        Provider::Minimax => DEFAULT_MINIMAX_MODEL,
        // ollama/openai ping은 GET이라 payload에 model이 안 들어가고, gemini ping은 DEFAULT_GEMINI_MODEL을
        // 고정으로 썼다(이전 gemini_ping과 동일 — 사용자가 고른 모델이 아니라 ping 전용 기본 모델).
        _ => DEFAULT_GEMINI_MODEL,
    };
    transport::provider_ping(&client, &provider, &endpoint, api_key.as_deref().unwrap_or(""), ping_model).await?;
    let latency_ms = start.elapsed().as_millis() as i64;

    let models = if let Provider::Ollama = provider {
        Some(transport::ollama_models(&client, &endpoint).await.unwrap_or_default())
    } else {
        None
    };

    Ok(ConnectionTest {
        ok: true,
        latency_ms,
        models,
    })
}

#[cfg(test)]
mod ai_path_invariants {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// with_deadline stores the override, and background() uses it — the actual value that
    /// with_model_fallback_until sees flows through logged_call's `deadline` argument, which
    /// isn't independently observable without a slow real HTTP call, so this checks the builder
    /// contract that send_text/send_json read via `self.deadline()`.
    #[test]
    fn real_text_transport_deadline_defaults_and_overrides() {
        assert_eq!(RealTextTransport::new(None).deadline(), transport::TEXT_OPERATION_DEADLINE);
        assert_eq!(RealTextTransport::background().deadline(), transport::BACKGROUND_OPERATION_DEADLINE);
        let custom = RealTextTransport::new(None).with_deadline(Duration::from_secs(7));
        assert_eq!(custom.deadline(), Duration::from_secs(7));
    }

    struct CountingText {
        calls: Arc<AtomicUsize>,
        last_user_chars: Arc<AtomicUsize>,
    }

    impl CountingText {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                last_user_chars: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl TextTransport for CountingText {
        async fn send_text(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            user_text: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.last_user_chars
                .store(user_text.chars().count(), Ordering::SeqCst);
            Ok(format!("out:{user_text}"))
        }
    }

    struct CountingTranslate {
        calls: Arc<AtomicUsize>,
        last_chars: Arc<AtomicUsize>,
    }

    impl CountingTranslate {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                last_chars: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl TranslateTransport for CountingTranslate {
        async fn translate(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            text: String,
            _target_lang: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.last_chars.store(text.chars().count(), Ordering::SeqCst);
            Ok(format!("tr:{text}"))
        }
    }

    /// A2: cloud AI without ai_enabled is rejected; local ollama loopback is allowed.
    #[test]
    fn privacy_gate_cloud_requires_enabled_local_ollama_does_not() {
        assert!(
            !privacy_gate_ok(&Provider::OpenAI, "https://api.openai.com/v1", false),
            "cloud without ai_enabled must fail the gate"
        );
        assert!(privacy_gate_ok(
            &Provider::OpenAI,
            "https://api.openai.com/v1",
            true
        ));
        assert!(
            privacy_gate_ok(&Provider::Ollama, "http://localhost:11434", false),
            "local ollama must not require ai_enabled"
        );
        assert!(
            !privacy_gate_ok(&Provider::Ollama, "https://ollama.example.com", false),
            "remote ollama endpoint must require ai_enabled"
        );
    }

    #[tokio::test]
    async fn translate_inner_rejects_cloud_without_ai_enabled() {
        let t = CountingTranslate::new();
        let err = translate_inner(
            "hello".into(),
            "fr".into(),
            Provider::OpenAI,
            "https://api.openai.com/v1".into(),
            Some("key".into()),
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(t.calls.load(Ordering::SeqCst), 0, "must not call transport");
    }

    #[tokio::test]
    async fn cleanup_inner_rejects_cloud_without_ai_enabled() {
        let t = CountingText::new();
        let err = cleanup_text_inner(
            "messy text".into(),
            Provider::OpenAI,
            "https://api.openai.com/v1".into(),
            Some("key".into()),
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    }

    /// A3: oversize input is truncated before the transport sees it.
    #[tokio::test]
    async fn translate_truncates_to_char_cap_before_transport() {
        let t = CountingTranslate::new();
        let over: String = "한".repeat(TRANSLATE_CHAR_CAP + 50);
        let out = translate_inner(
            over,
            "en".into(),
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap();
        assert_eq!(t.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            t.last_chars.load(Ordering::SeqCst),
            TRANSLATE_CHAR_CAP + "\n\n…[truncated]".chars().count(),
            "transport must receive at most TRANSLATE_CHAR_CAP plus truncation marker chars"
        );
        assert!(out.starts_with("tr:"));
    }

    #[tokio::test]
    async fn cleanup_truncates_to_char_cap_before_transport() {
        let t = CountingText::new();
        let over: String = "x".repeat(AI_TEXT_CHAR_CAP + 20);
        cleanup_text_inner(
            over,
            Provider::Ollama,
            "http://127.0.0.1:11434".into(),
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap();
        assert_eq!(
            t.last_user_chars.load(Ordering::SeqCst),
            AI_TEXT_CHAR_CAP + "\n\n…[truncated]".chars().count()
        );
    }

    /// A4: empty / whitespace-only body short-circuits without a provider call.
    #[tokio::test]
    async fn empty_translate_and_cleanup_skip_transport() {
        let tt = CountingTranslate::new();
        let out = translate_inner(
            "   \n".into(),
            "en".into(),
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            false,
            &tt,
        )
        .await
        .unwrap();
        assert_eq!(out, "");
        assert_eq!(tt.calls.load(Ordering::SeqCst), 0);

        let ct = CountingText::new();
        let out2 = cleanup_text_inner(
            "  ".into(),
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            false,
            &ct,
        )
        .await
        .unwrap();
        assert_eq!(out2, "");
        assert_eq!(ct.calls.load(Ordering::SeqCst), 0);
    }

    // ── 비전(펫 화면 저장) ─────────────────────────────────────────────────────────────
    struct FakeVision {
        calls: Arc<AtomicUsize>,
        reply: Result<String, ()>,
    }

    impl FakeVision {
        fn ok(reply: &str) -> Self {
            Self { calls: Arc::new(AtomicUsize::new(0)), reply: Ok(reply.to_string()) }
        }
        fn failing() -> Self {
            Self { calls: Arc::new(AtomicUsize::new(0)), reply: Err(()) }
        }
    }

    impl VisionTransport for FakeVision {
        async fn send_vision(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
            _image_base64: String,
            _mime: String,
        ) -> AppResult<String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.reply
                .clone()
                .map_err(|_| AppError::Io("provider does not support images".to_string()))
        }
    }

    #[tokio::test]
    async fn vision_cloud_without_ai_enabled_never_calls_the_transport() {
        let t = FakeVision::ok("요약");
        let err = describe_image_inner(
            "AAAA".into(),
            "image/jpeg".into(),
            "메모장".into(),
            Provider::OpenAI,
            "https://api.openai.com/v1".into(),
            Some("key".into()),
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    }

    /// 로컬 프로바이더는 ai_enabled 없이도 통과하고, 프로바이더 실패는 에러로 그대로 올라온다 —
    /// "요약 없음"으로의 강등 판단은 호출자(commands::pet::screenshot_ai_summary_outcome)가 한다.
    #[tokio::test]
    async fn vision_propagates_provider_failure_for_the_caller_to_classify() {
        let broken = FakeVision::failing();
        let err = describe_image_inner(
            "AAAA".into(), "image/jpeg".into(), "t".into(),
            Provider::Ollama, "http://localhost:11434".into(), None, None, false, &broken,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(broken.calls.load(Ordering::SeqCst), 1, "실패해도 호출은 한 번 갔다");
    }

    #[tokio::test]
    async fn vision_returns_the_trimmed_summary_when_it_works() {
        let t = FakeVision::ok("  훈민정음 반포 기사.  ");
        let out = describe_image_inner(
            "AAAA".into(), "image/jpeg".into(), "브라우저".into(),
            Provider::Ollama, "http://localhost:11434".into(), None, None, false, &t,
        )
        .await
        .unwrap();
        assert_eq!(out, "훈민정음 반포 기사.");
    }

    /// Agent callers put their corpus in `prompt`, so the generate boundary must cap prompt and
    /// optional context together rather than only clipping context.
    #[tokio::test]
    async fn generate_rejects_combined_input_over_its_explicit_budget() {
        let t = CountingText::new();
        let err = generate_from_prompt_inner(
            "p".repeat(AI_GENERATE_INPUT_CHAR_CAP - 10),
            Some("c".repeat(11)),
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::Validation(message) if message.contains("input limit")));
        assert_eq!(t.calls.load(Ordering::SeqCst), 0, "oversize input must not reach a provider");
    }

    #[tokio::test]
    async fn generate_accepts_a_full_32k_prompt_for_merge_drafting() {
        let t = CountingText::new();
        let out = generate_from_prompt_inner(
            "m".repeat(AI_GENERATE_INPUT_CHAR_CAP),
            None,
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap();

        assert_eq!(t.calls.load(Ordering::SeqCst), 1);
        assert_eq!(t.last_user_chars.load(Ordering::SeqCst), AI_GENERATE_INPUT_CHAR_CAP);
        assert!(out.starts_with("out:"));
    }

    /// A5: empty generate prompt is a validation error (not a silent empty response).
    #[tokio::test]
    async fn generate_empty_prompt_is_validation_error() {
        let t = CountingText::new();
        let err = generate_from_prompt_inner(
            "  ".into(),
            None,
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            None,
            false,
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    }

    struct FixedText(String);
    impl TextTransport for FixedText {
        async fn send_text(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            _system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn parse_ledger_text_extracts_a_well_formed_response() {
        let t = FixedText(
            r#"{"merchant":"스타벅스","amount":4500,"currency":"KRW","category":"카페","is_expense":true}"#
                .to_string(),
        );
        let out = parse_ledger_text_with_transport(
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            "[Web발신]\n스타벅스 4,500원 결제되었습니다".into(),
            &t,
        )
        .await
        .unwrap();
        assert_eq!(out.merchant.as_deref(), Some("스타벅스"));
        assert_eq!(out.amount, Some(4500.0));
        assert_eq!(out.is_expense, Some(true));
    }

    /// Text that isn't a payment notification at all — the model is told to null everything out
    /// rather than invent a plausible-looking transaction (system prompt's last rule).
    #[tokio::test]
    async fn parse_ledger_text_all_null_for_non_payment_text_is_not_an_error() {
        let t = FixedText(r#"{"merchant":null,"amount":null,"currency":null,"category":null,"is_expense":null}"#.to_string());
        let out = parse_ledger_text_with_transport(
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            "내일 회의 3시로 변경됐어".into(),
            &t,
        )
        .await
        .unwrap();
        assert_eq!(out.amount, None);
    }

    /// A malformed/non-JSON model reply is a validation error, not a silently-empty extraction —
    /// callers must be able to tell "no amount found" apart from "the model reply was garbage".
    // ── send_json (구조화 출력) ────────────────────────────────────────────────────────
    struct SchemaEchoText;
    impl TextTransport for SchemaEchoText {
        async fn send_text(
            &self,
            _provider: Provider,
            _endpoint: String,
            _api_key: Option<String>,
            _model_opt: Option<String>,
            system_prompt: String,
            _user_text: String,
        ) -> AppResult<String> {
            // 스키마 지시가 실제로 시스템 프롬프트에 실렸는지, 펜스로 감싼 응답도 파싱되는지
            // 한 번에 확인한다.
            let has_schema = system_prompt.contains("Respond with a single JSON object");
            Ok(format!("```json\n{{\"ok\":{has_schema}}}\n```"))
        }
    }

    #[tokio::test]
    async fn default_send_json_appends_schema_instruction_and_parses_fenced_reply() {
        let t = SchemaEchoText;
        let out = t
            .send_json(
                Provider::Ollama,
                "http://localhost:11434".into(),
                None,
                None,
                "SYS".into(),
                "TXT".into(),
                serde_json::json!({"type": "object"}),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
    }

    #[test]
    fn parse_json_object_lenient_accepts_a_clean_object() {
        let v = parse_json_object_lenient(r#"{"a":1}"#).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn parse_json_object_lenient_strips_fence_and_surrounding_prose() {
        let v = parse_json_object_lenient("here you go:\n```json\n{\"a\":1}\n```\nthanks").unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn parse_json_object_lenient_rejects_text_with_no_json_object() {
        assert!(matches!(parse_json_object_lenient("no json here"), Err(AppError::Io(_))));
    }

    #[tokio::test]
    async fn parse_ledger_text_rejects_non_json_reply() {
        let t = FixedText("sorry, I can't help with that".to_string());
        let err = parse_ledger_text_with_transport(
            Provider::Ollama,
            "http://localhost:11434".into(),
            None,
            None,
            "스타벅스 4,500원 결제".into(),
            &t,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
