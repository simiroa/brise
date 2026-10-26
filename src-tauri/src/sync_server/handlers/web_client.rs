// 웹 클라이언트(React `/app`, 폰이면 자동 모바일 레이아웃) 정적 서빙 + 구형 진입점 리다이렉트.
//
// `/m`, `/` 는 구형 모바일 뷰어 셸(vanilla HTML)이 있던 자리 — `/app` 로 완전히 대체되어 삭제되었다.
// 구형 QR/북마크가 /m?token=X 를 열면 쿼리스트링을 보존한 채 /app?token=X 로 307 리다이렉트한다
// (redirect_to_app) — 인증 없음(과거 셸과 동일한 규칙, 리다이렉트 자체는 데이터를 담지 않는다).
use crate::repo;
use axum::extract::Path as AxPath;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};

/// `/` · `/m` → `/app` 307. 쿼리스트링(특히 `?token=`, 구형 QR이 여전히 이 모양으로 찍혀 있다)을
/// 그대로 옮겨 붙인다.
pub(super) async fn redirect_to_app(uri: axum::http::Uri) -> Response {
    let location = match uri.query() {
        Some(q) => format!("/app?{q}"),
        None => "/app".to_string(),
    };
    (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, location)]).into_response()
}

// ── /app static serving (web client) ───────────────────────────────────────────────────────
// Release builds embed the built frontend (../dist) into the binary at compile time so the
// server has no separate deploy step. Debug builds read ../dist off disk at runtime instead —
// embedding would force every `cargo build` (no `npm run build` run) to fail, and dev normally
// runs vite on its own port anyway (this path only matters if someone points a browser straight
// at the Tauri app's sync server while iterating).
#[cfg(not(debug_assertions))]
static APP_DIST: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../dist");

// `/app` is deliberately unauthenticated (see app_serve doc comment below), which makes this
// traversal guard the ONLY thing standing between a request and the filesystem in debug builds —
// not defense-in-depth. Same guard (repo::paths::safe_rel — the zip-slip/../ check already used
// by attachments.rs::attachment_file and backup import) on both cfg arms so they can't drift apart; the
// release arm doesn't strictly need it (include_dir does an exact virtual-tree lookup, it can't
// walk outside its embedded set), but a rejected "../" falling through to the same
// None -> index.html SPA fallback either way is one code path instead of two.
#[cfg(not(debug_assertions))]
fn read_app_file(rel: &str) -> Option<Vec<u8>> {
    let safe = repo::paths::safe_rel(rel).ok()?;
    APP_DIST.get_file(safe.to_string_lossy().as_ref()).map(|f| f.contents().to_vec())
}

#[cfg(debug_assertions)]
fn dist_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist")
}

#[cfg(debug_assertions)]
fn read_app_file(rel: &str) -> Option<Vec<u8>> {
    let safe = repo::paths::safe_rel(rel).ok()?;
    std::fs::read(dist_dir().join(safe)).ok()
}

fn guess_static_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/// Unauthenticated by design — the bundle's own asset requests (`/app/assets/*.js`) carry no
/// query string, so gating this on `?token=` would 401 the page's own scripts/styles right after
/// the first navigation. Auth stays where the actual data is: `/api/v1/*`. The token the page
/// needs for its own API calls travels in the URL (`?token=`) and the page reads it client-side.
async fn app_serve(path: &str) -> Response {
    // SPA fallback: any /app/* path not found in the built bundle serves
    // index.html instead of 404 so client-side routes (e.g. /app/notes/123) resolve on refresh.
    let (bytes, served_path, is_fallback) = match read_app_file(path) {
        Some(b) => (Some(b), path, false),
        None => (read_app_file("index.html"), "index.html", true),
    };
    match bytes {
        Some(b) => {
            // Cache-Control: vite fingerprints everything under assets/ (content hash in the
            // filename), so a hit there is safe to cache for a year as immutable. Anything else
            // (index.html, and — critically — the SPA fallback case above where a *requested*
            // assets/foo.js that doesn't exist falls back to index.html's bytes) must stay
            // no-cache, or a stale/missing asset URL would get an HTML body cached as if it were
            // that asset, permanently (a redeploy can't fix a client that already cached it).
            let cacheable = !is_fallback && served_path == path && path.starts_with("assets/");
            let cache_control = if cacheable { "public, max-age=31536000, immutable" } else { "no-cache" };
            (
                [(header::CONTENT_TYPE, guess_static_mime(served_path)), (header::CACHE_CONTROL, cache_control)],
                b,
            )
                .into_response()
        }
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Html("<!doctype html><meta charset=utf-8><body style=\"font-family:sans-serif;padding:2rem\">npm run build 필요 — dist/ 를 찾을 수 없습니다.</body>"),
        )
            .into_response(),
    }
}

pub(super) async fn app_index() -> Response {
    app_serve("index.html").await
}

pub(super) async fn app_asset(AxPath(path): AxPath<String>) -> Response {
    app_serve(&path).await
}
