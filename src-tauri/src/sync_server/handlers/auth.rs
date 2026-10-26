// 토큰 인증 판정 — sync 서버(handlers/*)와 ingest 서버(ingest.rs)가 같은 규칙(fail-closed +
// 상수시간 비교 + Bearer/쿼리 두 경로)을 쓰도록 한 곳에만 둔다. 덧붙여 로그·에러 문구에서
// 토큰 값을 가리는 redact_token_in_text, 그리고 모든 핸들러가 공유하는 `?token=` 쿼리 추출자.
use super::ServerState;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

/// 상수시간 바이트 비교 — `==` (조기 이탈, 첫 불일치 바이트에서 즉시 반환)는 응답 시간으로 토큰의
/// 앞부분이 맞았는지를 흘릴 수 있는 타이밍 사이드채널이다(길이가 다르면 애초에 비교할 게 없으므로
/// 그 자체로 "다르다"는 정보 유출이 아니다 — 길이는 비밀이 아니다, new_id() 가 항상 같은 길이).
/// subtle 크레이트를 들일 만큼의 코드가 아니라 XOR-fold 로 직접 구현.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 토큰 하나만 놓고 보는 인증 판정 — `authorized()`(sync 서버)와 ingest 서버(ingest.rs)가 같은
/// 규칙(fail-closed + 상수시간 비교 + Bearer/쿼리 두 경로)을 쓰도록 여기 한 곳에만 둔다.
pub(crate) fn token_authorized(token: &str, headers: &HeaderMap, token_param: Option<&str>) -> bool {
    // fail closed: 빈 저장 토큰은 "인증 꺼짐"이 아니라 "누구도 통과 못함" 이어야 한다.
    if token.is_empty() {
        return false;
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    bearer.is_some_and(|b| constant_time_eq(b, token))
        || token_param.is_some_and(|t| constant_time_eq(t, token))
}

pub(super) fn authorized(state: &ServerState, headers: &HeaderMap, token_param: Option<&str>) -> bool {
    token_authorized(&state.token, headers, token_param)
}

/// 401 은 JSON 이 아니라 평문 "unauthorized" 다 — 클라이언트(lib/httpBridge.ts)가 이 모양을 알고
/// 있다. invoke 계열의 `{"error"}` JSON(responses.rs)과 합치지 말 것.
pub(super) fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

/// Redact `token` query parameter values from URIs / free-form error text so diag records and
/// error messages never echo the sync bearer (QR screenshots already leak; logs must not add a
/// second channel). Case-insensitive on the key; leaves other query params intact.
///
/// Byte-indexed rewrite here previously (pre-regex) cast each raw byte to `char`
/// (`bytes[i] as char`), which mangled any non-ASCII byte in the input (multi-byte UTF-8
/// sequences got split into garbage code points). Matching/replacing with `regex` on the `&str`
/// directly is UTF-8 safe by construction.
pub(crate) fn redact_token_in_text(s: &str) -> String {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    // Group 1: boundary (start of string, or one of ?/&/space/tab/newline/quote — same set the
    // old scanner checked via `bytes[i-1]`). Group 2: "=" or "%3d/%3D" (case-insensitive), so the
    // replacement can pick the matching literal marker below. Value runs until the next
    // separator: '&', whitespace, '\r'/'\n', or a quote — note '\t' is deliberately NOT a
    // separator (matches prior behavior: a tab inside a value did not terminate it).
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"(?i)(^|[?& \t\n"'])token(=|%3d)[^&\r\n "']*"#).unwrap()
    });
    re.replace_all(s, |caps: &regex::Captures| {
        let boundary = &caps[1];
        if caps[2].starts_with('=') {
            format!("{boundary}token=REDACTED")
        } else {
            format!("{boundary}token%3DREDACTED")
        }
    })
    .into_owned()
}

/// 인증이 필요한 모든 GET/POST 가 공유하는 `?token=` 쿼리. 이 외의 쿼리 파라미터가 필요한
/// 핸들러(notes 목록, 첨부 업로드)는 자기 구조체에 `token` 을 따로 들고 있다.
#[derive(Deserialize)]
pub(super) struct TokenQuery {
    pub(super) token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // query_param_token_must_match_exactly / redact_token_in_text_masks_query_values 는 기능 카탈로그
    // (specs/features/sync.yaml)가 handlers.rs 를 verify 경로로 이름 인용하므로 handlers.rs 의
    // tests 에 남아 있다 — 같은 규칙의 나머지 단위 테스트는 여기.

    #[test]
    fn empty_stored_token_never_authorizes_even_a_matching_empty_param() {
        assert!(!token_authorized("", &HeaderMap::new(), None));
        assert!(!token_authorized("", &HeaderMap::new(), Some("")));
    }

    #[test]
    fn bearer_header_token_must_match_exactly() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer secret123".parse().unwrap());
        assert!(token_authorized("secret123", &headers, None));

        let mut wrong = HeaderMap::new();
        wrong.insert(header::AUTHORIZATION, "Bearer nope".parse().unwrap());
        assert!(!token_authorized("secret123", &wrong, None));
    }

    /// Regression: the old byte-indexed scanner cast every raw byte to `char`
    /// (`bytes[i] as char`), which corrupted multi-byte UTF-8 sequences anywhere in the string —
    /// not just inside the token value. A non-ASCII URI must survive untouched aside from the
    /// redacted token.
    #[test]
    fn redact_token_in_text_preserves_non_ascii() {
        let raw = "GET /app/노트?token=super-secret-uuid&region=프랑스&label=café";
        let red = redact_token_in_text(raw);
        assert!(!red.contains("super-secret-uuid"));
        assert!(red.contains("token=REDACTED"));
        assert!(red.contains("/app/노트"), "non-ASCII path segment must survive intact: {red}");
        assert!(red.contains("region=프랑스"), "non-ASCII query value must survive intact: {red}");
        assert!(red.contains("label=café"), "non-ASCII query value must survive intact: {red}");
    }

    #[test]
    fn constant_time_eq_matches_exact_and_rejects_length_or_content_mismatch() {
        assert!(constant_time_eq("secret123", "secret123"));
        assert!(!constant_time_eq("secret123", "secret124"));
        assert!(!constant_time_eq("secret123", "secret12"));
        assert!(!constant_time_eq("secret123", "secret1234"));
        assert!(constant_time_eq("", ""));
    }
}
