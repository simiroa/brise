//! Web collector adapter (P3 수집 관문 v2, docs/PLAN-2026-08-23-collect-advanced.md W4).
//!
//! Feeds/RSS가 없는 일반 웹페이지/블로그를 repo::web_reader의 평문 추출, SSRF 가드,
//! 5MB wire cap을 그대로 재사용해 수집한다.
//! guid는 추출된 본문 텍스트의 SHA-256 해시값으로 결정된다(내용 변경 시 새 항목으로 취급).

use crate::collect::config::{self, SourceConfig};
use crate::collect::{CollectCtx, CollectedItem};
use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};

pub fn collect(config_json: &str, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let cfg = match config::parse("web", config_json)? {
        SourceConfig::Web(c) => c,
        _ => return Err(AppError::Validation("expected web config".to_string())),
    };
    let content = ctx
        .rt
        .block_on(crate::repo::web_reader::fetch_reader(&cfg.url))?;
    let body = content.text.trim();
    if body.is_empty() {
        return Ok(Vec::new());
    }

    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    let guid = format!("{:x}", hasher.finalize());

    let title = content
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| cfg.url.clone());

    Ok(vec![CollectedItem {
        guid,
        title,
        body_md: body.to_string(),
        source_url: Some(cfg.url),
        published_at: None,
        parts: Vec::new(),
    }])
}
