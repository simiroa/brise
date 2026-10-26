// repo::ai::history — ai_history 테이블 영속(기록/조회) + generate-from-prompt 입력 요약
// (프롬프트 원문을 그대로 저장하지 않기 위한 스크러빙). AiHistoryItem/record_history/get_history/
// summarize_prompt_for_history는 ai/mod.rs가 그대로 재수출한다.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiHistoryItem {
    pub id: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    pub action_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_or_input: Option<String>,
    pub result_text: String,
    pub created_at: String,
}

/// Max chars of scrubbed prompt kept in `ai_history.prompt_or_input` for generate-from-prompt
/// (agent plans embed full note bodies — never store them plaintext).
const HISTORY_PROMPT_SUMMARY_CAP: usize = 200;
const HISTORY_ERROR_SUMMARY_CAP: usize = 200;

/// Stable `action_type` contract for AI audit entries. Each outbound operation writes exactly
/// one terminal event: `*.proposed` for a successful read-only metadata proposal,
/// `*.succeeded` / `*.failed` for text operations, and `*.applied` only after a user-approved
/// database mutation commits. The UI may split the value at `.` to render operation and status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiAuditEvent {
    OrganizeProposed,
    OrganizeFailed,
    TranslateSucceeded,
    TranslateFailed,
    CleanupSucceeded,
    CleanupFailed,
    GenerateSucceeded,
    GenerateFailed,
    OrganizeApplied,
    PlanApplied,
    /// `ai_organize_note(origin: "collect_post_process")` — the collect post-process card's
    /// "accept" action re-uses the ordinary organize call, but must be counted separately in
    /// commands::collect::COLLECT_ACTION_TYPES/collect_get_stats and labeled distinctly in
    /// AiHistoryPanel. Unlike Organize{Proposed,Failed} this one flat action_type covers BOTH
    /// outcomes — the stats card and the label map key already assume the exact literal
    /// "collect_post_process" with no `.succeeded`/`.failed` suffix; success/failure remains
    /// distinguishable via result_text alone (same split as organize.proposed/failed's input).
    CollectPostProcess,
}

impl AiAuditEvent {
    pub const fn action_type(self) -> &'static str {
        match self {
            Self::OrganizeProposed => "organize.proposed",
            Self::OrganizeFailed => "organize.failed",
            Self::TranslateSucceeded => "translate.succeeded",
            Self::TranslateFailed => "translate.failed",
            Self::CleanupSucceeded => "cleanup.succeeded",
            Self::CleanupFailed => "cleanup.failed",
            Self::GenerateSucceeded => "generate.succeeded",
            Self::GenerateFailed => "generate.failed",
            Self::OrganizeApplied => "organize.applied",
            Self::PlanApplied => "plan.applied",
            Self::CollectPostProcess => "collect_post_process",
        }
    }
}

/// Audit entries intentionally retain only completion metadata, never AI output or note bodies.
pub fn summarize_completion_for_history(operation: &str, output: &str) -> String {
    format!("[{operation} completed · {} chars]", output.chars().count())
}

/// Keep a safe, short failure diagnostic without allowing a provider response to persist a key.
pub fn summarize_error_for_history(error: &AppError) -> String {
    let scrubbed = super::transport::mask_secrets_keep_key(&error.to_string());
    let message: String = scrubbed.chars().take(HISTORY_ERROR_SUMMARY_CAP).collect();
    let suffix = (scrubbed.chars().count() > HISTORY_ERROR_SUMMARY_CAP).then_some("…").unwrap_or("");
    format!("[failed · {}] {message}{suffix}", audit_error_code(error))
}

fn audit_error_code(error: &AppError) -> &'static str {
    error.code()
}

/// Summarize a generate-from-prompt input for `ai_history`: strip `<untrusted_data>` note bodies,
/// keep only a short head of remaining guidance/schema contract + total length metadata.
pub fn summarize_prompt_for_history(prompt: &str) -> String {
    let total_chars = prompt.chars().count();
    // Drop every untrusted note-data block (open…close). If a close tag is missing, drop from
    // open to end — better to lose guidance than store note bodies.
    let mut scrubbed = String::with_capacity(prompt.len().min(HISTORY_PROMPT_SUMMARY_CAP * 2));
    let mut rest = prompt;
    loop {
        if let Some(open_at) = rest.find("<untrusted_data>") {
            scrubbed.push_str(&rest[..open_at]);
            let after_open = &rest[open_at + "<untrusted_data>".len()..];
            if let Some(close_at) = after_open.find("</untrusted_data>") {
                rest = &after_open[close_at + "</untrusted_data>".len()..];
            } else {
                // Missing close tag: drop remainder (prefer losing guidance over storing bodies).
                break;
            }
        } else {
            scrubbed.push_str(rest);
            break;
        }
    }
    let scrubbed = super::transport::mask_secrets_keep_key(&scrubbed.split_whitespace().collect::<Vec<_>>().join(" "));
    let head: String = scrubbed.chars().take(HISTORY_PROMPT_SUMMARY_CAP).collect();
    if scrubbed.chars().count() > HISTORY_PROMPT_SUMMARY_CAP {
        format!("[prompt summary · {total_chars} chars] {head}…")
    } else if head.is_empty() {
        format!("[prompt summary · {total_chars} chars]")
    } else {
        format!("[prompt summary · {total_chars} chars] {head}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiUsageRow {
    pub workspace_id: String,
    pub day: String,
    pub action_type: String,
    pub provider: String,
    pub calls: i64,
}

fn resolve_active_provider(conn: &rusqlite::Connection) -> String {
    use rusqlite::OptionalExtension;
    let json_val: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'ai_provider'",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    json_val
        .and_then(|json| serde_json::from_str::<String>(&json).ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "ollama".to_string())
}

pub fn record_usage(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    action_type: &str,
    provider: &str,
) -> AppResult<()> {
    let (ty, tm, td) = crate::util::today_ymd_local();
    let day = format!("{ty:04}-{tm:02}-{td:02}");
    conn.execute(
        "INSERT INTO ai_usage (workspace_id, day, action_type, provider, calls)
         VALUES (?1, ?2, ?3, ?4, 1)
         ON CONFLICT (workspace_id, day, action_type, provider)
         DO UPDATE SET calls = calls + 1",
        rusqlite::params![workspace_id, day, action_type, provider],
    )
    .map_err(crate::error::db)?;
    Ok(())
}

pub fn get_usage(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    since: Option<&str>,
) -> AppResult<Vec<AiUsageRow>> {
    let mut sql = "SELECT workspace_id, day, action_type, provider, calls FROM ai_usage WHERE workspace_id = ?1".to_string();
    if since.is_some() {
        sql.push_str(" AND day >= ?2");
    }
    sql.push_str(" ORDER BY day DESC, calls DESC");
    let mut stmt = conn.prepare(&sql).map_err(crate::error::db)?;
    let map_row = |r: &rusqlite::Row<'_>| {
        Ok(AiUsageRow {
            workspace_id: r.get(0)?,
            day: r.get(1)?,
            action_type: r.get(2)?,
            provider: r.get(3)?,
            calls: r.get(4)?,
        })
    };
    let mut items = Vec::new();
    if let Some(since_day) = since {
        let rows = stmt.query_map(rusqlite::params![workspace_id, since_day], map_row).map_err(crate::error::db)?;
        for r in rows {
            items.push(r.map_err(crate::error::db)?);
        }
    } else {
        let rows = stmt.query_map(rusqlite::params![workspace_id], map_row).map_err(crate::error::db)?;
        for r in rows {
            items.push(r.map_err(crate::error::db)?);
        }
    }
    Ok(items)
}

pub fn record_history(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    note_id: Option<&str>,
    action_type: &str,
    prompt_or_input: Option<&str>,
    result_text: &str,
) -> AppResult<AiHistoryItem> {
    let id = crate::util::new_id();
    let now = crate::util::now_iso();
    conn.execute(
        "INSERT INTO ai_history (id, workspace_id, note_id, action_type, prompt_or_input, result_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![id, workspace_id, note_id, action_type, prompt_or_input, result_text, now],
    ).map_err(crate::error::db)?;

    // Bounded retention: keep max 50 items per workspace
    conn.execute(
        "DELETE FROM ai_history WHERE workspace_id = ?1 AND id NOT IN (
           SELECT id FROM ai_history WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 50
         )",
        rusqlite::params![workspace_id],
    ).map_err(crate::error::db)?;

    // UPSERT cumulative ai_usage count alongside history
    let provider = resolve_active_provider(conn);
    let _ = record_usage(conn, workspace_id, action_type, &provider);

    Ok(AiHistoryItem {
        id,
        workspace_id: workspace_id.to_string(),
        note_id: note_id.map(|s| s.to_string()),
        action_type: action_type.to_string(),
        prompt_or_input: prompt_or_input.map(|s| s.to_string()),
        result_text: result_text.to_string(),
        created_at: now,
    })
}

pub fn get_history(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    limit: Option<usize>,
) -> AppResult<Vec<AiHistoryItem>> {
    let lim = limit.unwrap_or(50).min(100) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, note_id, action_type, prompt_or_input, result_text, created_at
             FROM ai_history WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )
        .map_err(crate::error::db)?;

    let rows = stmt
        .query_map(rusqlite::params![workspace_id, lim], |r| {
            Ok(AiHistoryItem {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                note_id: r.get(2)?,
                action_type: r.get(3)?,
                prompt_or_input: r.get(4)?,
                result_text: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(crate::error::db)?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(crate::error::db)?);
    }
    Ok(items)
}

#[cfg(test)]
mod history_retention_tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_ai_history_bounded_retention() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&mut conn, &crate::db::migrations::migrations()).unwrap();
        crate::db::migrations::seed(&mut conn).unwrap();

        let ws_id: String = conn.query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0)).unwrap();

        // Insert 60 history items
        for i in 1..=60 {
            record_history(
                &conn,
                &ws_id,
                None,
                "prompt",
                Some(&format!("prompt {}", i)),
                &format!("result {}", i),
            ).unwrap();
        }

        let history = get_history(&conn, &ws_id, Some(100)).unwrap();
        // Bounded retention enforces max 50 items
        assert_eq!(history.len(), 50);
        // The most recent item (item 60) should be at the front
        assert_eq!(history[0].result_text, "result 60");
        // Item 1 to 10 should have been pruned
        assert_eq!(history[49].result_text, "result 11");
    }

    #[test]
    fn summarize_prompt_for_history_strips_untrusted_note_bodies() {
        let secret = "TOP_SECRET_NOTE_BODY_DO_NOT_STORE";
        let prompt = format!(
            "guidance line\n[데이터 경계]\n<untrusted_data>\n{secret}\n</untrusted_data>\n\n[출력 계약] skeleton"
        );
        let summary = summarize_prompt_for_history(&prompt);
        assert!(!summary.contains(secret), "note body must not appear in history summary: {summary}");
        assert!(summary.contains("[prompt summary"));
        assert!(summary.contains("guidance"));
        assert!(summary.contains("출력 계약") || summary.contains("skeleton"));
    }

    #[test]
    fn summarize_prompt_for_history_caps_long_guidance() {
        let long = "a".repeat(500);
        let summary = summarize_prompt_for_history(&long);
        assert!(summary.starts_with("[prompt summary · 500 chars]"));
        assert!(summary.ends_with('…'));
        // Cap is 200 chars of head + metadata — whole string stays well under full prompt size.
        assert!(summary.len() < 280);
    }

    #[test]
    fn test_ai_usage_recording_and_aggregation() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::apply(&mut conn, &crate::db::migrations::migrations()).unwrap();
        crate::db::migrations::seed(&mut conn).unwrap();

        let ws_id: String = conn.query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0)).unwrap();

        record_usage(&conn, &ws_id, "organize", "ollama").unwrap();
        record_usage(&conn, &ws_id, "organize", "ollama").unwrap();
        record_usage(&conn, &ws_id, "translate", "openai").unwrap();

        let usage = get_usage(&conn, &ws_id, None).unwrap();
        assert_eq!(usage.len(), 2);
        let organize_row = usage.iter().find(|r| r.action_type == "organize").unwrap();
        assert_eq!(organize_row.calls, 2);
        assert_eq!(organize_row.provider, "ollama");

        let translate_row = usage.iter().find(|r| r.action_type == "translate").unwrap();
        assert_eq!(translate_row.calls, 1);
        assert_eq!(translate_row.provider, "openai");
    }
}
