// 커맨드: sections (commands/sections.yaml)
use super::{AppState, Deleted, Okay, SectionUpdated};
use crate::error::AppError;
use crate::models::Section;
use crate::repo::sections;
use serde::Serialize;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn section_create(
    state: State<AppState>,
    note_id: String,
    name: Option<String>,
) -> Result<Section, AppError> {
    let mut conn = state.db.lock();
    let section = sections::create(&mut conn, &note_id, name)?;
    crate::events::publish(Some(&note_id), false);
    Ok(section)
}

#[tauri::command(rename_all = "snake_case")]
pub fn section_create_with_body(
    state: State<AppState>,
    note_id: String,
    name: Option<String>,
    body_md: String,
    kind: Option<String>,
    ai_origin: Option<String>,
) -> Result<Section, AppError> {
    let mut conn = state.db.lock();
    let section =
        sections::create_with_body_and_kind_and_origin(&mut conn, &note_id, name, body_md, kind, ai_origin)?;
    crate::events::publish(Some(&note_id), false);
    Ok(section)
}

/// ai_origin 세 갈래 계약 (specs/commands/sections.yaml section_update notes — SSOT,
/// docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W5): **본문을 쓰는 사람이 누구인지**를
/// 이 한 지점이 판정한다. body_md 유무로만 분기한다 — ai_origin 인자 자체의 값은 branch 1에서는
/// 아예 보지 않는다(탭 rename은 저작이 아니다).
///   1. body_md 없음            → repo::sections::update에 ai_origin=None(보존)을 넘긴다.
///   2. body_md 있음 + ai_origin 없음 → Some(None)을 넘긴다 → NULL로 지운다(사용자 편집).
///   3. body_md 있음 + ai_origin 있음 → Some(Some(value))를 넘긴다 → 그 값으로 세팅한다
///      (diagram_edit 등 AI가 기존 섹션을 다시 쓰는 경로).
#[tauri::command(rename_all = "snake_case")]
pub fn section_update(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    body_md: Option<String>,
    ai_origin: Option<String>,
    expected_updated_at: Option<String>,
) -> Result<SectionUpdated, AppError> {
    observe_untokened_body_write(&id, body_md.is_some(), expected_updated_at.is_some());
    let mut conn = state.db.lock();
    let ai_origin_patch = if body_md.is_some() { Some(ai_origin) } else { None };
    let written = sections::update_checked(
        &mut conn,
        &id,
        name,
        body_md,
        ai_origin_patch,
        expected_updated_at.as_deref(),
    )?;
    // 에디터의 디바운스 저장이 지나가는 자리 — 데스크톱→폰 실시간 반영의 주 경로다.
    // 무변경 쓰기(written.changed=false)는 알리지 않는다 — 바뀐 게 없는데 상대 화면을 다시 읽게 하지 않는다.
    if written.changed {
        if let Ok(note_id) = sections::note_id_of(&conn, &id) {
            crate::events::publish(Some(&note_id), false);
        }
    }
    Ok(written.into())
}

/// D2② 단계 1 관찰(docs/PLAN-2026-10-06-d2-expected-updated-at.md §3 점진 도입) — 본문을 쓰는
/// `section_update` 가 `expected_updated_at` 없이 왔다는 기록. 토큰 필수화(단계 2, 오너 결정) 전에
/// "자동 저장·AI 교체 경로의 생략이 0 인가"를 보려는 것이라 **어떤 섹션이** 생략으로 오는지만 알면 된다.
///
/// 폭주 방지: 데스크톱 자동 저장은 700ms 마다 같은 섹션으로 온다. diag 의 60초 디듀프는
/// (feature, code) 키라 섹션 수와 무관하게 분당 한 줄로 접히지만, 그러면 "몇 개 섹션이 생략으로
/// 오는가"가 count 에 섞여 사라진다. 그래서 **프로세스당 섹션 id 마다 한 번**만 기록한다(같은 섹션의
/// 다음 생략 저장은 아무것도 안 한다). 기억 집합은 상한 `UNTOKENED_SEEN_CAP` — 오래 켜 둔 앱이 손댄
/// 모든 섹션 id 를 끝없이 쥐지 않게, 차면 그 사실을 한 번 남기고 이후는 세지 않는다.
/// 메시지는 섹션 id 뿐(본문·경로 없음 — CLAUDE.md 함정 11). 알려진 생략 호출자(면제): 데스크톱 초안
/// materialize(새 노트마다 1회)·휴지통 노트 재전송(stores/notesActive.ts) — 이 둘은 0 이 되지 않는다.
/// 기록하면 true(테스트용).
const UNTOKENED_SEEN_CAP: usize = 512;

fn observe_untokened_body_write(section_id: &str, has_body: bool, has_expected: bool) -> bool {
    use std::collections::HashSet;
    use std::sync::OnceLock;
    static SEEN: OnceLock<parking_lot::Mutex<HashSet<String>>> = OnceLock::new();
    if !has_body || has_expected {
        return false;
    }
    let full = {
        let mut seen = SEEN.get_or_init(|| parking_lot::Mutex::new(HashSet::new())).lock();
        if seen.len() >= UNTOKENED_SEEN_CAP || !seen.insert(section_id.to_string()) {
            return false;
        }
        seen.len() == UNTOKENED_SEEN_CAP
    };
    crate::diag::warn("section_update", "no_expected", format!("body write without expected_updated_at: section {section_id}"));
    if full {
        crate::diag::warn("section_update", "no_expected_cap", format!("stopped recording after {UNTOKENED_SEEN_CAP} sections"));
    }
    true
}

/// 시트 셀 패치 (specs/features/sheet.md). section_update 와 같은 repo 경로를 타므로
/// updated_at 전파·FTS·이벤트가 동일하게 한 번씩 일어난다. ai_origin은 repo::sheet::set_cells가
/// 내부적으로 항상 보존(None)한다 — 시트에는 AI 산출물 표식을 붙이지 않는다(이번 웨이브 범위 밖,
/// specs/commands/sections.yaml section_update notes).
#[tauri::command(rename_all = "snake_case")]
pub fn sheet_set_cells(
    state: State<AppState>,
    section_id: String,
    cells: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<SectionUpdated, AppError> {
    let mut conn = state.db.lock();
    let written = crate::repo::sheet::set_cells(&mut conn, &section_id, &cells)?;
    if written.changed {
        if let Ok(note_id) = sections::note_id_of(&conn, &section_id) {
            crate::events::publish(Some(&note_id), false);
        }
    }
    Ok(written.into())
}

#[derive(Serialize, Debug)]
pub struct SectionImportFileOutput {
    pub sections: Vec<Section>,
    pub truncated: bool,
}

/// 파일 하나 → 새 섹션 (BREAKING: sections — xlsx 한 파일이 워크시트 여러 장 = 섹션 여러 개를
/// 만들 수 있어서 배열이다. 나머지 형식은 항상 길이 1.)
/// (specs/commands/sections.yaml section_import_file, extraction.yaml, import_ext.rs 매트릭스).
/// 확장자로 파서를 고르고 결과를 section_create_with_body 와 같은 repo 함수
/// (create_with_body_and_kind_and_origin, ai_origin=None)에 넘긴다 — 새 섹션 생성 경로를
/// 두 벌로 만들지 않는다. 이름은 파일 stem, 빈/없으면 create_internal 의 기본 이름 규칙에 맡긴다.
#[tauri::command(rename_all = "snake_case")]
pub fn section_import_file(
    state: State<AppState>,
    note_id: String,
    file_path: String,
) -> Result<SectionImportFileOutput, AppError> {
    use crate::repo::import_ext::{import_kind_for_ext, ImportKind};

    let path = std::path::Path::new(&file_path);
    if path.is_dir() {
        return Err(AppError::Validation(format!(
            "cannot import a directory as a section: {file_path} (use section_import_scan to expand it first)"
        )));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // (name, body_md, kind, truncated) 하나 이상 — xlsx 만 워크시트 개수만큼.
    let mut parts: Vec<(Option<String>, String, &str, bool)> = Vec::new();
    match import_kind_for_ext(&ext) {
        Some(ImportKind::PlainText) => {
            parts.push((stem, std::fs::read_to_string(path).map_err(crate::error::io)?, "text", false));
        }
        Some(ImportKind::ExtractedText) => {
            // 절단 플래그를 그대로 흘려보낸다. 출력 계약의 `truncated` 는 원래 csv/xlsx 시트
            // 상한용이었는데, 같은 앱에서 csv 200열은 알리고 pptx 2000장은 안 알릴 이유가 없다.
            let (body, truncated) = crate::repo::extraction::extract_markdown(&file_path)?;
            parts.push((stem, body, "text", truncated));
        }
        Some(ImportKind::Csv) => {
            let (json, truncated) = crate::repo::csv_import::import_csv(path, ',')?;
            parts.push((stem, json, "sheet", truncated));
        }
        Some(ImportKind::Tsv) => {
            let (json, truncated) = crate::repo::csv_import::import_csv(path, '\t')?;
            parts.push((stem, json, "sheet", truncated));
        }
        Some(ImportKind::Xlsx) => {
            let fallback = stem.clone().unwrap_or_default();
            let sheets = crate::repo::xlsx_import::import_xlsx(path, &fallback)?;
            for sheet in sheets {
                parts.push((Some(sheet.name), sheet.json, "sheet", sheet.truncated));
            }
        }
        None => return Err(AppError::Validation(format!("unsupported import extension: .{ext}"))),
    };

    let truncated = parts.iter().any(|(_, _, _, t)| *t);
    let mut conn = state.db.lock();
    let mut sections = Vec::with_capacity(parts.len());
    for (name, body_md, kind, _) in parts {
        let section = sections::create_with_body_and_kind_and_origin(
            &mut conn,
            &note_id,
            name,
            body_md,
            Some(kind.to_string()),
            None,
        )?;
        sections.push(section);
    }
    crate::events::publish(Some(&note_id), false);
    Ok(SectionImportFileOutput { sections, truncated })
}

/// 문서 파일 → 서식 있는 HTML (specs/commands/sections.yaml doc_import_html, PLAN-2026-10-07 W1 hwpx · W4 docx).
/// 섹션을 만들지 않는다 — 프런트가 html 을 `mdSerializeHtml` 로 body_md 로 바꿔 section_create_with_body 로 넣고,
/// 실패하면 section_import_file(텍스트 추출)로 물러난다. 부작용은 본문 그림의 첨부 저장뿐.
///
/// async + spawn_blocking 인 이유: 파싱과 그림 쓰기가 오래 걸릴 수 있고, 동기 커맨드는 Tauri 가 직렬로 돌려서 다른
/// IPC 전부가 기다린다(attachment_thumbs 주석 — 실측 1,837ms 스톨). AppState.db 가 Arc 인 것도 이 용도다.
#[tauri::command(rename_all = "snake_case")]
pub async fn doc_import_html(
    state: State<'_, AppState>,
    note_id: String,
    file_path: String,
) -> Result<crate::repo::doc_import::DocImportHtmlOutput, AppError> {
    let db = std::sync::Arc::clone(&state.db);
    let data_dir = state.data_dir.clone();
    let nid = note_id.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::repo::doc_import::import(&db, &data_dir, &nid, &file_path)
    })
    .await
    .map_err(|e| AppError::Io(format!("doc import worker failed: {e}")))??;
    // 첨부가 생겼을 때만 — 그림 없는 문서는 데이터가 바뀌지 않았다.
    if out.image_count > 0 {
        crate::events::publish(Some(&note_id), false);
    }
    Ok(out)
}

/// 드롭/다중선택 경로 펼치기 — 폴더를 section_import_file 이 바로 먹을 수 있는 파일 경로 목록으로
/// (specs/commands/sections.yaml section_import_scan). http:false — 로컬 경로 인자.
#[tauri::command(rename_all = "snake_case")]
pub fn section_import_scan(paths: Vec<String>) -> Result<SectionImportScanOutput, AppError> {
    let (files, skipped) = crate::repo::import_scan::scan_paths(&paths)?;
    Ok(SectionImportScanOutput { files, skipped })
}

#[derive(Serialize)]
pub struct SectionImportScanOutput {
    pub files: Vec<String>,
    pub skipped: i64,
}

#[tauri::command(rename_all = "snake_case")]
pub fn section_delete(state: State<AppState>, id: String) -> Result<Deleted, AppError> {
    let mut conn = state.db.lock();
    // 삭제 뒤엔 행이 없으므로 note_id 를 먼저 확보한다.
    let note_id = sections::note_id_of(&conn, &id).ok();
    let deleted = sections::delete(&mut conn, &id)?;
    crate::events::publish(note_id.as_deref(), false);
    Ok(Deleted { deleted })
}

#[tauri::command(rename_all = "snake_case")]
pub fn section_reorder(
    state: State<AppState>,
    note_id: String,
    ordered_ids: Vec<String>,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = sections::reorder(&mut conn, &note_id, &ordered_ids)?;
    crate::events::publish(Some(&note_id), false);
    Ok(Okay { ok })
}

/// 섹션을 다른 노트로 이동 (specs/commands/sections.yaml section_move).
/// 두 노트가 모두 바뀌므로 원 노트 id 를 먼저 확보해 양쪽에 변경 통지를 낸다 —
/// events::publish 는 note_id 하나만 받으므로 두 번 부른다.
#[tauri::command(rename_all = "snake_case")]
pub fn section_move(
    state: State<AppState>,
    id: String,
    target_note_id: String,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let source_note_id = sections::note_id_of(&conn, &id).ok();
    let ok = sections::move_to_note(&mut conn, &id, &target_note_id)?;
    if let Some(source) = source_note_id.filter(|s| s != &target_note_id) {
        crate::events::publish(Some(&source), false);
    }
    crate::events::publish(Some(&target_note_id), false);
    Ok(Okay { ok })
}

/// 휴지통에서 복구 (specs/commands/sections.yaml section_restore) — 원 노트 맨 뒤로 되돌아간다.
#[tauri::command(rename_all = "snake_case")]
pub fn section_restore(state: State<AppState>, id: String) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = sections::restore(&mut conn, &id)?;
    // 복구 뒤에야 행이 생기므로 note_id 는 나중에 묻는다.
    let note_id = sections::note_id_of(&conn, &id).ok();
    crate::events::publish(note_id.as_deref(), false);
    Ok(Okay { ok })
}

/// 휴지통 항목 완전 삭제 (specs/commands/sections.yaml section_purge) — 노트 본체는 그대로라
/// 변경 통지가 필요 없다(휴지통 목록은 프런트가 다시 부른다).
#[tauri::command(rename_all = "snake_case")]
pub fn section_purge(state: State<AppState>, id: String) -> Result<Deleted, AppError> {
    let conn = state.db.lock();
    let deleted = sections::purge(&conn, &id)?;
    Ok(Deleted { deleted })
}

/// 휴지통 목록 — 노트북(생략 시 활성) 소속 삭제 섹션을 deleted_at desc 로.
#[tauri::command(rename_all = "snake_case")]
pub fn section_trash_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<Vec<sections::SectionTrashEntry>, AppError> {
    let conn = state.db.lock();
    sections::trash_list(&conn, workspace_id)
}

/// W5 섹션 provenance — section_update의 세 갈래 ai_origin 계약
/// (specs/commands/sections.yaml section_update notes) 이 실제 커맨드 핸들러를 통해
/// 정확히 그 세 가지로 갈라지는지 검증한다. tauri::test::mock_app() 패턴은
/// sync_server/events_wiring_tests.rs 와 동일 — #[tauri::command] 함수를 IPC 없이 직접 호출한다.
#[cfg(test)]
mod untokened_observation_tests {
    use super::observe_untokened_body_write;

    // 집합은 프로세스 전역이라 테스트마다 고유 id 를 쓴다(병렬 테스트와 섞이지 않게). diag 링은 전역이라
    // 거기를 단언하지 않고 판정 결과(bool)만 본다.
    #[test]
    fn omitted_token_is_recorded_once_per_section() {
        assert!(observe_untokened_body_write("obs-once-a", true, false));
        assert!(!observe_untokened_body_write("obs-once-a", true, false), "같은 섹션의 두 번째 생략은 기록하지 않는다");
        assert!(!observe_untokened_body_write("obs-once-a", true, false));
        assert!(observe_untokened_body_write("obs-once-b", true, false), "다른 섹션은 따로 한 번");
    }

    #[test]
    fn token_bearing_or_rename_only_is_not_recorded() {
        assert!(!observe_untokened_body_write("obs-tok", true, true), "토큰을 보낸 본문 쓰기");
        assert!(!observe_untokened_body_write("obs-rename", false, false), "이름만 바꾸는 쓰기");
        // 위 둘이 집합에 들어가지 않았으므로 이후 생략 본문 쓰기는 처음으로 기록된다.
        assert!(observe_untokened_body_write("obs-tok", true, false));
    }
}

#[cfg(test)]
mod ai_origin_contract_tests {
    use super::*;
    use tauri::Manager;

    fn mock_app_with_state() -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(conn, data_dir.path().to_path_buf()));
        (data_dir, app)
    }

    /// 노트 하나 + 그 첫 섹션 id를 반환 — 매 테스트가 반복하는 셋업.
    fn seeded_section(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        let state = app.state::<AppState>();
        let mut conn = state.db.lock();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = crate::repo::notes::create(&mut conn, &folder_id, None, None).unwrap();
        detail.sections[0].id.clone()
    }

    fn ai_origin_of(app: &tauri::App<tauri::test::MockRuntime>, section_id: &str) -> Option<String> {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        conn.query_row(
            "SELECT ai_origin FROM sections WHERE id=?1",
            [section_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Branch 1: body_md 생략 → ai_origin을 건드리지 않는다 (탭 rename은 저작이 아니다).
    #[test]
    fn branch1_rename_only_preserves_ai_origin() {
        let (_dir, app) = mock_app_with_state();
        let id = seeded_section(&app);
        // 미리 AI 산출물로 표시해 둔다.
        {
            let state = app.state::<AppState>();
            let mut conn = state.db.lock();
            conn.execute("UPDATE sections SET ai_origin='summarize' WHERE id=?1", [&id])
                .unwrap();
        }

        section_update(
            app.state::<AppState>(),
            id.clone(),
            Some("New Tab Name".to_string()),
            None, // body_md 생략
            None,
            None,
        )
        .unwrap();

        assert_eq!(ai_origin_of(&app, &id).as_deref(), Some("summarize"));
    }

    /// Branch 2: body_md 있음 + ai_origin 생략 → NULL로 지운다 (사용자가 편집했다 = 이제 사용자
    /// 글이다). stores/notes.ts::updateSectionBody(자동 저장 디바운스)가 실제로 타는 갈래.
    #[test]
    fn branch2_user_edit_clears_ai_origin() {
        let (_dir, app) = mock_app_with_state();
        let id = seeded_section(&app);
        {
            let state = app.state::<AppState>();
            let mut conn = state.db.lock();
            conn.execute("UPDATE sections SET ai_origin='organize' WHERE id=?1", [&id])
                .unwrap();
        }

        section_update(
            app.state::<AppState>(),
            id.clone(),
            None,
            Some("사용자가 손으로 고친 본문".to_string()),
            None, // ai_origin 생략
            None,
        )
        .unwrap();

        assert_eq!(ai_origin_of(&app, &id), None);
    }

    /// Branch 3: body_md 있음 + ai_origin 있음 → 그 값으로 세팅한다 (diagram_edit 등 AI가 기존
    /// 섹션을 다시 쓰는 경로).
    #[test]
    fn branch3_ai_rewrite_sets_ai_origin() {
        let (_dir, app) = mock_app_with_state();
        let id = seeded_section(&app);

        section_update(
            app.state::<AppState>(),
            id.clone(),
            None,
            Some("flowchart TD\n  A --> B".to_string()),
            Some("diagram_edit".to_string()),
            None,
        )
        .unwrap();

        assert_eq!(ai_origin_of(&app, &id).as_deref(), Some("diagram_edit"));
    }

    /// section_create_with_body가 ai_origin을 그대로 새 섹션에 실어 보낸다 — insertAiSection의
    /// 유일한 새-섹션 경로가 provenance를 잃지 않는지 확인.
    #[test]
    fn create_with_body_forwards_ai_origin() {
        let (_dir, app) = mock_app_with_state();
        let state = app.state::<AppState>();
        let note_id = {
            let mut conn = state.db.lock();
            let folder_id: String = conn
                .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
                .unwrap();
            crate::repo::notes::create(&mut conn, &folder_id, None, None)
                .unwrap()
                .note
                .id
        };

        let section = section_create_with_body(
            app.state::<AppState>(),
            note_id,
            None,
            "정리된 본문".to_string(),
            None,
            Some("summarize".to_string()),
        )
        .unwrap();

        assert_eq!(section.ai_origin.as_deref(), Some("summarize"));
        assert_eq!(ai_origin_of(&app, &section.id).as_deref(), Some("summarize"));
    }

    /// sheet_set_cells는 section_update와 같은 repo::sections::update 경로를 타지만, 시트 셀
    /// 패치는 저작권 판정 지점이 아니므로 기존 ai_origin을 그대로 보존해야 한다.
    #[test]
    fn sheet_set_cells_preserves_ai_origin() {
        let (_dir, app) = mock_app_with_state();
        let state = app.state::<AppState>();
        let note_id = {
            let mut conn = state.db.lock();
            let folder_id: String = conn
                .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
                .unwrap();
            crate::repo::notes::create(&mut conn, &folder_id, None, None)
                .unwrap()
                .note
                .id
        };
        let sheet = section_create_with_body(
            app.state::<AppState>(),
            note_id,
            None,
            r#"{"v":1,"rows":10,"cols":[],"cells":{}}"#.to_string(),
            Some("sheet".to_string()),
            Some("sheet".to_string()), // AI가 시트를 만든 경우도 있다 — 보존 대상이 있어야 의미있는 테스트.
        )
        .unwrap();
        assert_eq!(ai_origin_of(&app, &sheet.id).as_deref(), Some("sheet"));

        let mut cells = std::collections::BTreeMap::new();
        cells.insert("A1".to_string(), serde_json::json!({ "raw": "5000" }));
        sheet_set_cells(app.state::<AppState>(), sheet.id.clone(), cells).unwrap();

        assert_eq!(
            ai_origin_of(&app, &sheet.id).as_deref(),
            Some("sheet"),
            "sheet_set_cells must not touch ai_origin"
        );
    }
}

/// section_import_file/scan 커맨드 레벨 계약 — 디렉터리 가드 · xlsx 다중 섹션 · scan 왕복.
#[cfg(test)]
mod import_command_tests {
    use super::*;
    use std::io::Write;
    use tauri::Manager;

    fn mock_app_with_state() -> (tempfile::TempDir, tauri::App<tauri::test::MockRuntime>) {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = crate::db::bootstrap(data_dir.path()).unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(conn, data_dir.path().to_path_buf()));
        (data_dir, app)
    }

    fn seeded_note_id(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        let state = app.state::<AppState>();
        let mut conn = state.db.lock();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        crate::repo::notes::create(&mut conn, &folder_id, None, None).unwrap().note.id
    }

    #[test]
    fn directory_path_is_rejected_as_validation() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let dir = tempfile::tempdir().unwrap();

        let err = section_import_file(
            app.state::<AppState>(),
            note_id,
            dir.path().to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn csv_import_produces_exactly_one_section() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let mut tmp = tempfile::NamedTempFile::with_suffix(".csv").unwrap();
        tmp.write_all(b"a,b\n1,2\n").unwrap();

        let out = section_import_file(
            app.state::<AppState>(),
            note_id,
            tmp.path().to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(out.sections.len(), 1);
        assert!(!out.truncated);
    }

    /// xlsx 워크시트 2장 → 섹션 2개, 이름은 워크시트 이름 — CSV/TSV/텍스트 형식은 항상 길이 1인
    /// 이유가 여기서 갈린다(specs/commands/sections.yaml section_import_file xlsx 규칙).
    #[test]
    fn xlsx_import_produces_one_section_per_worksheet() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let tmp = crate::repo::xlsx_import::test_support::two_sheet_fixture();

        let out = section_import_file(
            app.state::<AppState>(),
            note_id,
            tmp.path().to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(out.sections.len(), 2);
        assert_eq!(out.sections[0].name, "Revenue");
        assert_eq!(out.sections[1].name, "Costs");
        assert_eq!(out.sections[0].kind, "sheet");
    }

    #[test]
    fn unsupported_extension_is_validation() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let tmp = tempfile::NamedTempFile::with_suffix(".exe").unwrap();

        let err = section_import_file(
            app.state::<AppState>(),
            note_id,
            tmp.path().to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    /// doc_import_html 커맨드 배선: 확장자 검사 → 노트 확인 → 파싱 → 응답 모양. 서식 규칙 자체는
    /// repo/doc_import/ 테스트가 본다 — 여기서는 async 커맨드가 State 에서 db·data_dir 를 제대로 넘기는지만.
    #[test]
    fn doc_import_html_command_wires_validation_not_found_and_happy_path() {
        let (_data_dir, app) = mock_app_with_state();
        let note_id = seeded_note_id(&app);
        let call = |note: &str, path: &std::path::Path| {
            tauri::async_runtime::block_on(doc_import_html(
                app.state::<AppState>(),
                note.to_string(),
                path.to_string_lossy().into_owned(),
            ))
        };

        let txt = tempfile::NamedTempFile::with_suffix(".txt").unwrap();
        assert!(matches!(call(&note_id, txt.path()), Err(AppError::Validation(_))));

        let section = br#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>hi &amp; bye</hp:t></hp:run></hp:p></hs:sec>"#;
        let hwpx = crate::repo::extraction::test_support::build_zip(".hwpx", &[("Contents/section0.xml", section)]);
        assert!(matches!(call("no-such-note", hwpx.path()), Err(AppError::NotFound(_))));

        let out = call(&note_id, hwpx.path()).unwrap();
        assert_eq!(out.html, "<p>hi &amp; bye</p>");
        assert_eq!(out.image_count, 0);
        assert!(out.dropped.is_empty());
        // 섹션을 만들지 않는다 — 노트는 처음 그대로 섹션 하나.
        let state = app.state::<AppState>();
        let n: i64 = state
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM sections WHERE note_id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn scan_expands_folder_for_import_file_to_consume() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("skip.exe"), "x").unwrap();

        let out = section_import_scan(vec![dir.path().to_string_lossy().into_owned()]).unwrap();
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.skipped, 1);
        assert!(out.files[0].ends_with("a.txt"));
    }
}
