// 커맨드: diag — 앱 전역 진단 싱크 (specs/commands/diag.yaml, AUDIT-2026-09-26-fallback-observability.md §7.1)
use super::Okay;
use crate::diag::{self, DiagEntry, Level, Notice, WorkerStatus};
use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 원격/웹뷰 → 싱크 경로의 flood 방지. diag.rs 자체의 60초 dedupe(같은 source/feature/code/level)
/// 와는 별개 층이다 — 그건 "같은 실패가 반복"을 누르고, 이건 "한 창이 서로 다른 feature/code로
/// 마구 쏘는" 경우(예: 렌더 루프에서 매 프레임 다른 코드를 report하는 버그)를 막는다. source
/// (창 라벨)별 분당 상한 — 넘으면 에러 없이 그냥 버린다(플러딩 자체가 신호이지, 호출자 실수가
/// 아니라 방어적 상한이라 VALIDATION으로 올리지 않는다).
const PER_SOURCE_CAP_PER_MINUTE: u32 = 120;

struct SourceWindow {
    window_start: Instant,
    count: u32,
}

static SOURCE_RATE: OnceLock<std::sync::Mutex<HashMap<String, SourceWindow>>> = OnceLock::new();

fn source_rate() -> &'static std::sync::Mutex<HashMap<String, SourceWindow>> {
    SOURCE_RATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// true = 허용(기록해도 됨), false = 이번 분에 이미 상한(120) 도달 — 조용히 버림.
/// lock().unwrap(): 이 맵 안에서 패닉할 코드가 없어(단순 산술) poison 걱정이 diag.rs의
/// parking_lot 선택 이유만큼 절실하지 않다 — std::sync::Mutex 그대로 둔다.
fn allow_source(source: &str) -> bool {
    let mut map = source_rate().lock().unwrap();
    let now = Instant::now();
    // 원격 호출자가 source 를 마음대로 바꿔 보내면 키가 끝없이 늘어난다 — 키 길이를 자르고(diag.rs
    // 의 KEY_MAX_CHARS 와 같은 64자), 맵이 커지면 1분 지난 창을 걷어낸다.
    if map.len() >= 256 {
        map.retain(|_, w| now.duration_since(w.window_start) <= Duration::from_secs(60));
    }
    let key: String = source.chars().take(64).collect();
    let entry = map
        .entry(key)
        .or_insert(SourceWindow { window_start: now, count: 0 });
    if now.duration_since(entry.window_start) > Duration::from_secs(60) {
        entry.window_start = now;
        entry.count = 0;
    }
    entry.count += 1;
    entry.count <= PER_SOURCE_CAP_PER_MINUTE
}

#[tauri::command(rename_all = "snake_case")]
pub fn diag_record(source: String, feature: String, code: String, level: String, message: String) -> Result<Okay, AppError> {
    let Some(level) = Level::parse(&level) else {
        return Err(AppError::Validation(format!("diag_record: unknown level '{level}' (info|warn|error)")));
    };
    if !allow_source(&source) {
        return Ok(Okay { ok: false });
    }
    diag::record_from(&source, level, &feature, &code, &message);
    Ok(Okay { ok: true })
}

#[derive(Serialize)]
pub struct DiagRecentOutput {
    pub items: Vec<DiagEntry>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn diag_recent(limit: Option<i64>) -> Result<DiagRecentOutput, AppError> {
    let limit = limit.unwrap_or(200).clamp(1, 1000) as usize;
    Ok(DiagRecentOutput { items: diag::recent(limit) })
}

#[derive(Serialize)]
pub struct DiagStatusOutput {
    pub workers: Vec<WorkerStatus>,
    pub log_dir: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn diag_status() -> Result<DiagStatusOutput, AppError> {
    Ok(DiagStatusOutput { workers: diag::worker_statuses(), log_dir: diag::log_dir_display() })
}

#[derive(Serialize)]
pub struct DiagTakeNoticesOutput {
    pub items: Vec<Notice>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn diag_take_notices() -> Result<DiagTakeNoticesOutput, AppError> {
    Ok(DiagTakeNoticesOutput { items: diag::take_notices() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diag_record_rejects_unknown_level() {
        // commands::Okay(diag_record의 Ok 타입)는 Debug를 derive하지 않아 .unwrap_err()를 못
        // 쓴다(그 매크로는 Ok 분기 패닉 메시지에 T: Debug가 필요) — Okay는 다른 여러 커맨드가
        // 공유하는 타입이라 여기서 derive를 더할 수 없다(commands/mod.rs는 module line만 owned).
        match diag_record(
            "main".to_string(),
            "feat".to_string(),
            "code".to_string(),
            "critical".to_string(),
            "msg".to_string(),
        ) {
            Err(err) => assert_eq!(err.code(), "VALIDATION"),
            Ok(_) => panic!("unknown level must be rejected"),
        }
    }

    #[test]
    fn diag_record_accepts_known_levels_and_records() {
        let out = diag_record(
            "main".to_string(),
            "feat-cmd-test".to_string(),
            "code-cmd-test".to_string(),
            "warn".to_string(),
            "hello".to_string(),
        )
        .unwrap();
        assert!(out.ok);
        let found = diag::recent(500)
            .into_iter()
            .find(|e| e.feature == "feat-cmd-test" && e.code == "code-cmd-test")
            .expect("diag_record이 실제로 diag::record_from을 거쳐야 한다");
        assert_eq!(found.source, "main");
    }

    #[test]
    fn allow_source_caps_at_120_per_minute_then_drops() {
        // 이 테스트만의 고유 source 이름 — 전역 맵을 공유하므로(OnceLock) 다른 테스트/실행과
        // 안 섞이게.
        let source = format!("test-source-{}", crate::util::new_id());
        for _ in 0..PER_SOURCE_CAP_PER_MINUTE {
            assert!(allow_source(&source), "상한 안에서는 항상 허용");
        }
        assert!(!allow_source(&source), "상한을 넘으면 거부");
    }
}
