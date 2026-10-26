// 커맨드: settings (commands/settings.yaml)
use super::AppState;
use crate::error::AppError;
use crate::repo::settings;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
pub struct SettingsAll {
    pub settings: BTreeMap<String, Value>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn settings_get_all(state: State<AppState>) -> Result<SettingsAll, AppError> {
    let conn = state.db.lock();
    let settings = settings::get_all(&conn)?;
    Ok(SettingsAll { settings })
}

#[tauri::command(rename_all = "snake_case")]
pub fn settings_set(
    state: State<AppState>,
    entries: BTreeMap<String, Value>,
) -> Result<super::Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = settings::set(&mut conn, &entries)?;
    // PLAN-2026-09-05 §3 C-3: ai_debug_verbose 핫리로드. 이전엔 repo::ai::call_log 의 verbose
    // AtomicBool 이 lib.rs 부팅 시 스냅샷 한 번뿐이라, 설정에서 꺼도 재시작 전까지 노트 내용이
    // 로그 파일에 계속 기록됐다(프라이버시 결함). 저장이 성공한 뒤(위 `?`를 이미 통과)에만
    // 갱신 — 저장 실패 시엔 설정 화면에 보이는 값과 로그 동작이 어긋나지 않게 그대로 둔다.
    if let Some(v) = entries.get("ai_debug_verbose").and_then(|v| v.as_bool()) {
        crate::repo::ai::call_log::set_verbose(v);
    }
    // 설정 대부분은 기기 로컬 UI 상태(창 크기/패널 폭/스펠체크...)라 통지하지 않는다 — 드래그마다
    // 다른 기기를 재조회시키는 이벤트 폭풍이 될 뿐이다. 예외는 활성 워크스페이스: HTTP 피드가
    // active_workspace_id 로 스코프되므로(GET /api/v1/notes) 이게 바뀌면 폰이 다른 목록을 봐야 한다.
    if entries.contains_key("active_workspace_id") {
        crate::events::publish(None, false);
    }
    // W8-h(펫 대화창 스타일 상속): 펫 창은 settings_get_all 을 못 불러 pet_theme 로 부팅 시 한 번만
    // 읽는다 — Settings 에서 테마를 바꾸는 동안 펫이 계속 열려 있으면 이 브로드캐스트가 유일한
    // 갱신 경로다. settings_set 은 sync_server::dispatch(원격 HTTP, generate 되는 코드가 State만
    // 넘긴다)에서도 그대로 불리는 함수라 AppHandle 을 파라미터로 받을 수 없다(그러면 dispatch.gen.rs
    // 가 만드는 2-인자 호출과 시그니처가 어긋난다) — 그래서 AppHandle 파라미터 대신 이미 있는
    // events::emit_desktop(설정된 전역 AppHandle, remote-note-write 와 같은 OnceLock 패턴)을
    // 재사용한다. 세 키로 좁힌 이유는 pet_theme 가 노출하는 값과 정확히 맞추기 위해서(그 외 설정은
    // 펫과 무관 — 이벤트 폭풍 방지 원칙 유지).
    // capture_screenshot_enabled 가 여기 낀 이유: pet_theme 가 그 값도 함께 내려주기 때문이다
    // (펫 우클릭 "화면 저장" 항목의 노출 여부) — 설정에서 켠 직후 펫을 다시 켜지 않아도 메뉴에
    // 나타나야 한다. "pet_theme 가 노출하는 값과 정확히 맞춘다"는 위 규칙은 그대로다.
    // pet_dblclick_action 도 W18 B2 로 같은 이유로 추가 — settings_get_all 이 금지된 펫 창에서
    // 더블클릭 반응 설정이 재시작 없이 반영되려면 이 브로드캐스트가 유일한 경로다
    // (AUDIT-2026-08-22-debris.md §1.1).
    // chat_write_enabled 는 F-P01 쓰기 게이트 — 사이드바 토글이 펫 말풍선에도 즉시 먹어야 한다.
    if entries
        .keys()
        .any(|k| {
            matches!(
                k.as_str(),
                "theme"
                    | "accent"
                    | "font_scale"
                    | "capture_screenshot_enabled"
                    | "surface_style"
                    | "sheet_alpha"
                    | "ai_enabled"
                    // 트레이/펫 메뉴 "새 세션 열기"는 챗 게이트(chat_available = 프로바이더·엔드포인트·
                    // ai_enabled)를 따른다 — tray.rs 가 이 이벤트를 듣고 메뉴를 다시 짠다.
                    | "ai_provider"
                    | "ai_endpoint"
                    | "pet_dblclick_action"
                    | "chat_write_enabled"
                    // 노트북 전환 — 위 값 중 노트북 키(theme·accent·ai_enabled…)가 통째로 바뀐다
                    // (PLAN-2026-09-19-notebook-settings §4).
                    | "active_workspace_id"
            )
        })
    {
        crate::events::emit_desktop("pet-theme-changed");
    }
    // 2026-08-14 설정 창 분리: 설정을 쓰는 창과 그 결과를 그려야 하는 창이 이제 다른 웹뷰다
    // (각자 별도의 zustand 스토어를 갖는다). 어떤 키가 어느 창에 필요한지 여기서 알 수 없으므로
    // 쓰기마다 전부 알리되, 바뀐 키 목록을 실어 보낸다 — 거를지는 수신 측(lib/settingsChanged.ts)이
    // 정한다(탭 저장처럼 그 창만 쓰는 UI 상태의 메아리로 전체 재조회를 돌리지 않게).
    crate::events::emit_desktop_json("settings-changed", settings_changed_payload(&entries));
    Ok(super::Okay { ok })
}

/// "settings-changed" 페이로드 — `{ keys: [...] }`. 페이로드를 안 보는 옛 리스너는 그대로 동작한다.
fn settings_changed_payload(entries: &BTreeMap<String, Value>) -> Value {
    serde_json::json!({ "keys": entries.keys().collect::<Vec<_>>() })
}

#[cfg(test)]
mod settings_changed_payload_tests {
    use super::*;

    #[test]
    fn payload_lists_written_keys() {
        let mut entries = BTreeMap::new();
        entries.insert("open_tabs".to_string(), serde_json::json!([]));
        entries.insert("active_tab_id".to_string(), serde_json::json!("home"));
        assert_eq!(
            settings_changed_payload(&entries),
            serde_json::json!({ "keys": ["active_tab_id", "open_tabs"] })
        );
    }
}

/// db_stats 응답 — DB-only 통계(repo::settings::stats) + 파일시스템 walk(dir_sizes) 을 합친다.
/// 두 조각을 일부러 나눠서 부른다: dir_sizes 는 DB 락을 놓은 뒤 실행해야 다른 커맨드를 막지
/// 않는다(repo/settings.rs::dir_sizes 주석 참고).
#[derive(Serialize)]
pub struct DbStatsFull {
    pub note_count: i64,
    pub attachment_count: i64,
    pub distinct_note_days: i64,
    pub db_size_bytes: i64,
    pub attachments_size_bytes: i64,
    pub image_size_bytes: i64,
    pub disk_free_bytes: Option<i64>,
}

/// async + spawn_blocking: dir_sizes() walks data_dir/attachments/ with a stat() per file, which
/// at large corpora (docs/SCALABILITY.md) is thousands of syscalls — same reasoning as
/// commands::transfer::backup_auto_run (attachments.rs:174-178 measured a sync command stalling
/// every other IPC call for its full duration).
#[tauri::command(rename_all = "snake_case")]
pub async fn db_stats(state: State<'_, AppState>) -> Result<DbStatsFull, AppError> {
    let core = {
        let conn = state.db.lock();
        settings::stats(&conn)?
    };
    let data_dir = state.data_dir.clone();
    let (sizes, disk_free_bytes) = tauri::async_runtime::spawn_blocking(move || {
        (settings::dir_sizes(&data_dir), settings::disk_free_bytes(&data_dir))
    })
    .await
    .map_err(|e| AppError::Io(format!("dir size worker failed: {e}")))?;
    let (attachments_size_bytes, image_size_bytes) = sizes?;
    Ok(DbStatsFull {
        note_count: core.note_count,
        attachment_count: core.attachment_count,
        distinct_note_days: core.distinct_note_days,
        db_size_bytes: core.db_size_bytes,
        attachments_size_bytes,
        image_size_bytes,
        disk_free_bytes,
    })
}

// ── phrase_packs_list (Wave 8 header) ────────────────────────────────────────
// Scans `$APPDATA/phrase_packs/*.json` with the same schema as bundled packs:
//   { name: string, items: [{ text: string, source?: string }] }
// Parse failures are soft-skipped (warn to stderr) so a bad user file never
// blocks boot or settings.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhrasePackItemWire {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PhrasePackWire {
    /// "user:<filename>" — stable id for settings.phrase_pack_id
    pub id: String,
    pub name: String,
    pub items: Vec<PhrasePackItemWire>,
}

#[derive(Debug, Serialize)]
pub struct PhrasePacksList {
    pub packs: Vec<PhrasePackWire>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn phrase_packs_list(state: State<AppState>) -> Result<PhrasePacksList, AppError> {
    let dir = state.data_dir.join("phrase_packs");
    // Create the folder on first access so users have somewhere to drop JSON.
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
        return Ok(PhrasePacksList { packs: vec![] });
    }
    Ok(PhrasePacksList {
        packs: scan_phrase_packs_dir(&dir),
    })
}

fn scan_phrase_packs_dir(dir: &Path) -> Vec<PhrasePackWire> {
    let mut packs = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            crate::diag::warn("settings", "phrase_pack_dir_read_failed", format!("{e}"));
            return packs;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true) {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Block path tricks in the id even though we only use the basename.
        if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                crate::diag::warn("settings", "phrase_pack_read_failed", format!("{file_name}: {e}"));
                continue;
            }
        };
        let value: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                crate::diag::warn("settings", "phrase_pack_invalid_json", format!("{file_name}: {e}"));
                continue;
            }
        };
        match parse_user_phrase_pack(&value, &file_name) {
            Some(p) => packs.push(p),
            None => {
                crate::diag::warn("settings", "phrase_pack_schema_invalid", &file_name);
            }
        }
    }
    packs.sort_by(|a, b| a.name.cmp(&b.name));
    packs
}

fn parse_user_phrase_pack(value: &Value, file_name: &str) -> Option<PhrasePackWire> {
    let obj = value.as_object()?;
    let name = obj.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let items_val = obj.get("items")?.as_array()?;
    let mut items = Vec::new();
    for entry in items_val {
        let Some(e) = entry.as_object() else { continue };
        let Some(text) = e.get("text").and_then(|v| v.as_str()).map(|s| s.trim()) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let source = e
            .get("source")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        items.push(PhrasePackItemWire {
            text: text.to_string(),
            source,
        });
    }
    if items.is_empty() {
        return None;
    }
    Some(PhrasePackWire {
        id: format!("user:{file_name}"),
        name: name.to_string(),
        items,
    })
}

// ── phrase_pack_save (AI 생성 팩 저장) ────────────────────────────────────────
// Writes the same `{ name, items }` schema phrase_packs_list reads back, so an AI-generated
// pack is indistinguishable from a hand-dropped file afterwards.

const MAX_PACK_NAME_LEN: usize = 80;
const MAX_PACK_ITEMS: usize = 200;
const MAX_PACK_TEXT_LEN: usize = 300;
const MAX_PACK_SOURCE_LEN: usize = 120;
const MAX_PACK_STEM_LEN: usize = 40;

#[derive(Debug, Serialize)]
pub struct PhrasePackSaved {
    /// "user:<file_name>" — same id shape phrase_packs_list returns, drops straight into
    /// settings.phrase_pack_id.
    pub id: String,
    pub file_name: String,
}

/// Pack name → safe file stem. Whitelist, not blacklist: only alphanumerics (Hangul included)
/// and '_' survive, everything else collapses to a single '-'. '.', '/', '\' therefore cannot
/// appear at all, which makes "..", absolute paths and traversal structurally impossible rather
/// than merely rejected.
fn sanitize_pack_stem(name: &str) -> String {
    let mut out = String::new();
    let mut len = 0usize;
    let mut prev_dash = false;
    for c in name.chars() {
        if len >= MAX_PACK_STEM_LEN {
            break;
        }
        if c.is_alphanumeric() || c == '_' {
            out.push(c);
            prev_dash = false;
            len += 1;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
            len += 1;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "pack".to_string()
    } else {
        trimmed.to_string()
    }
}

/// First free `<stem>.json` / `<stem>-2.json` / … in `dir` — never overwrites an existing pack.
fn unique_pack_path(dir: &Path, stem: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.json"));
    let mut n = 2;
    while candidate.exists() && n < 1000 {
        candidate = dir.join(format!("{stem}-{n}.json"));
        n += 1;
    }
    candidate
}

fn save_phrase_pack_to_dir(
    dir: &Path,
    name: &str,
    items: &[PhrasePackItemWire],
) -> Result<PhrasePackSaved, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("pack name is empty".into()));
    }
    if name.chars().count() > MAX_PACK_NAME_LEN {
        return Err(AppError::Validation(format!(
            "pack name too long (max {MAX_PACK_NAME_LEN} chars)"
        )));
    }
    if items.len() > MAX_PACK_ITEMS {
        return Err(AppError::Validation(format!(
            "too many phrases (max {MAX_PACK_ITEMS})"
        )));
    }

    let mut clean: Vec<PhrasePackItemWire> = Vec::new();
    for item in items {
        let text = item.text.trim();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > MAX_PACK_TEXT_LEN {
            return Err(AppError::Validation(format!(
                "phrase too long (max {MAX_PACK_TEXT_LEN} chars)"
            )));
        }
        let source = item
            .source
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        if let Some(s) = source {
            if s.chars().count() > MAX_PACK_SOURCE_LEN {
                return Err(AppError::Validation(format!(
                    "source too long (max {MAX_PACK_SOURCE_LEN} chars)"
                )));
            }
        }
        clean.push(PhrasePackItemWire {
            text: text.to_string(),
            source: source.map(|s| s.to_string()),
        });
    }
    if clean.is_empty() {
        return Err(AppError::Validation("pack has no usable phrases".into()));
    }

    fs::create_dir_all(dir).map_err(crate::error::io)?;
    let path = unique_pack_path(dir, &sanitize_pack_stem(name));
    let body = serde_json::json!({ "name": name, "items": clean });
    let pretty = serde_json::to_string_pretty(&body)
        .map_err(|e| AppError::Io(format!("serialize pack failed: {e}")))?;
    fs::write(&path, pretty).map_err(crate::error::io)?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    Ok(PhrasePackSaved {
        id: format!("user:{file_name}"),
        file_name,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn phrase_pack_save(
    state: State<AppState>,
    name: String,
    items: Vec<PhrasePackItemWire>,
) -> Result<PhrasePackSaved, AppError> {
    save_phrase_pack_to_dir(&state.data_dir.join("phrase_packs"), &name, &items)
}

// PLAN-2026-09-05 §3 C-3: settings_set → call_log::set_verbose 핫리로드. tauri::test::mock_app()
// 패턴은 commands::sections::ai_origin_contract_tests 와 동일 — #[tauri::command] 함수를 IPC
// 없이 직접 호출해 실제 커맨드 경로(repo::settings::set 왕복 포함)를 왕복 테스트한다(CLAUDE.md
// 함정 #3: 프런트 목으로는 이 배선 누락을 못 잡는다).
#[cfg(test)]
mod settings_set_ai_debug_verbose_tests {
    use super::*;
    use crate::repo::ai::call_log;
    use tauri::Manager;

    fn mock_app_with_state() -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(conn, data_dir.path().to_path_buf()));
        (data_dir, app)
    }

    #[test]
    fn turning_ai_debug_verbose_off_stops_capture_head_immediately() {
        let (_dir, app) = mock_app_with_state();
        call_log::set_verbose(true); // 알려진 시작 상태(전역 AtomicBool — 테스트 간 격리 불가)

        let mut entries = BTreeMap::new();
        entries.insert("ai_debug_verbose".to_string(), Value::Bool(false));
        settings_set(app.state::<AppState>(), entries).unwrap();

        assert!(
            call_log::capture_head("hello").is_none(),
            "settings_set must flip the same AtomicBool set_verbose controls — no restart required"
        );
    }

    #[test]
    fn turning_ai_debug_verbose_on_starts_capturing_immediately() {
        let (_dir, app) = mock_app_with_state();
        call_log::set_verbose(false);

        let mut entries = BTreeMap::new();
        entries.insert("ai_debug_verbose".to_string(), Value::Bool(true));
        settings_set(app.state::<AppState>(), entries).unwrap();

        assert!(call_log::capture_head("hello").is_some());
        call_log::set_verbose(false); // 다음 테스트를 위한 복구(전역 상태)
    }

    #[test]
    fn unrelated_keys_do_not_touch_the_verbose_flag() {
        let (_dir, app) = mock_app_with_state();
        call_log::set_verbose(true);

        let mut entries = BTreeMap::new();
        entries.insert("theme".to_string(), Value::String("dark".to_string()));
        settings_set(app.state::<AppState>(), entries).unwrap();

        assert!(call_log::capture_head("hello").is_some(), "unrelated settings_set calls must not reset verbose");
        call_log::set_verbose(false); // 복구
    }

    /// validate_setting이 잘못된 값(문자열 "true" 등 boolean 아님)을 거부하면 repo::settings::set
    /// 자체가 에러로 끝난다 — set_verbose는 그 `?` 뒤에 있으므로 저장 실패 시 절대 불리지 않는다
    /// (실렸다면 verbose가 이전 값 그대로 남아야 한다 — 설정 화면과 실제 로그 동작이 어긋나지
    /// 않는다는 계약).
    #[test]
    fn validation_failure_leaves_verbose_flag_untouched() {
        let (_dir, app) = mock_app_with_state();
        call_log::set_verbose(false);

        let mut entries = BTreeMap::new();
        entries.insert("ai_debug_verbose".to_string(), Value::String("not-a-bool".to_string()));
        let result = settings_set(app.state::<AppState>(), entries);

        assert!(result.is_err(), "validate_setting must reject a non-boolean ai_debug_verbose");
        assert!(call_log::capture_head("hello").is_none(), "a rejected save must not flip verbose");
    }
}

#[cfg(test)]
mod phrase_pack_tests {
    use super::*;

    fn item(text: &str) -> PhrasePackItemWire {
        PhrasePackItemWire { text: text.to_string(), source: None }
    }

    #[test]
    fn sanitize_strips_path_tricks() {
        assert_eq!(sanitize_pack_stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_pack_stem("C:\\Windows\\system32"), "C-Windows-system32");
        assert_eq!(sanitize_pack_stem(".."), "pack");
        assert_eq!(sanitize_pack_stem("///"), "pack");
        assert_eq!(sanitize_pack_stem("역사 명언"), "역사-명언");
        assert!(sanitize_pack_stem(&"가".repeat(200)).chars().count() <= MAX_PACK_STEM_LEN);
        for tricky in ["..", "../x", "a/b", "a\\b", "a.json", "..\\..\\x"] {
            let stem = sanitize_pack_stem(tricky);
            assert!(!stem.contains('.') && !stem.contains('/') && !stem.contains('\\'), "{stem}");
        }
    }

    #[test]
    fn save_roundtrips_through_the_list_scanner() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("phrase_packs");
        let saved = save_phrase_pack_to_dir(
            &dir,
            "  역사 명언  ",
            &[
                PhrasePackItemWire { text: " 배움에는 끝이 없다 ".into(), source: Some(" 논어 ".into()) },
                item("   "),
                item("천 리 길도 한 걸음부터"),
            ],
        )
        .unwrap();
        assert_eq!(saved.id, format!("user:{}", saved.file_name));

        let packs = scan_phrase_packs_dir(&dir);
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].id, saved.id);
        assert_eq!(packs[0].name, "역사 명언");
        // blank phrase dropped, surrounding whitespace trimmed
        assert_eq!(packs[0].items.len(), 2);
        assert_eq!(packs[0].items[0].text, "배움에는 끝이 없다");
        assert_eq!(packs[0].items[0].source.as_deref(), Some("논어"));
    }

    #[test]
    fn second_save_of_same_name_does_not_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("phrase_packs");
        let a = save_phrase_pack_to_dir(&dir, "Quotes", &[item("one")]).unwrap();
        let b = save_phrase_pack_to_dir(&dir, "Quotes", &[item("two")]).unwrap();
        assert_ne!(a.file_name, b.file_name);
        assert_eq!(scan_phrase_packs_dir(&dir).len(), 2);
    }

    #[test]
    fn rejects_empty_and_oversized_input() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("phrase_packs");
        assert!(save_phrase_pack_to_dir(&dir, "  ", &[item("x")]).is_err());
        assert!(save_phrase_pack_to_dir(&dir, "ok", &[]).is_err());
        assert!(save_phrase_pack_to_dir(&dir, "ok", &[item("  ")]).is_err());
        let too_many: Vec<_> = (0..MAX_PACK_ITEMS + 1).map(|i| item(&i.to_string())).collect();
        assert!(save_phrase_pack_to_dir(&dir, "ok", &too_many).is_err());
        let long = "x".repeat(MAX_PACK_TEXT_LEN + 1);
        assert!(save_phrase_pack_to_dir(&dir, "ok", &[item(&long)]).is_err());
        assert!(save_phrase_pack_to_dir(&dir, &"n".repeat(MAX_PACK_NAME_LEN + 1), &[item("x")]).is_err());
    }
}

// ── 모양(테마) 초기화·내보내기·불러오기 — docs/PLAN-2026-09-19-theme-presets.md §3 ──
// 셋 다 **쓰지 않는다.** 읽어 온 값은 프런트가 settings_set 한 번으로 쓴다(검증·트랜잭션·
// settings-changed 방송의 초크포인트를 하나로 유지). 로컬 파일/데스크톱 전용이라 http:false.

#[derive(Serialize)]
pub struct ThemeEntries {
    pub entries: BTreeMap<String, Value>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn theme_defaults() -> ThemeEntries {
    ThemeEntries { entries: crate::repo::theme::defaults() }
}

#[tauri::command(rename_all = "snake_case")]
pub fn theme_read(path: String) -> Result<crate::repo::theme::ThemeRead, AppError> {
    crate::repo::theme::read(Path::new(&path))
}

#[tauri::command(rename_all = "snake_case")]
pub fn theme_export(state: State<AppState>, path: String) -> Result<super::Okay, AppError> {
    let conn = state.db.lock();
    crate::repo::theme::export(&conn, Path::new(&path))?;
    Ok(super::Okay { ok: true })
}
