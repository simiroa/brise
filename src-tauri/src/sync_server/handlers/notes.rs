// 노트 단위 REST — GET /api/v1/notes (모바일 피드 목록) · POST /api/v1/notes/{id}/checklist (체크박스
// 토글). 노트 생성/수정/단건 조회 REST 는 없다(전부 POST /api/v1/invoke). 휴지통 가드
// (check_not_trashed)와 쓰기 통지(emit_remote_write)는 손으로 쓴 REST 쓰기 핸들러 공용이라
// attachments.rs 의 업로드도 여기 것을 쓴다.
use super::auth::{authorized, unauthorized, TokenQuery};
use super::responses::{app_error_response, join_error_response};
use super::ServerState;
use crate::db;
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo;
// GET /api/v1/notes 기본/상한 — repo::note_query 모듈의 상수를 그대로 재사용한다(별도
// 상수를 새로 만들지 않는다, 이 엔드포인트의 "페이지" 개념도 그 모듈의 것과 동일한 크기 예산).
use crate::repo::note_query::NOTE_QUERY_DEFAULT_LIMIT;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub(super) struct NotesQuery {
    token: Option<String>,
    /// = 노트북 id (쿼리 키 이름은 폰 클라이언트와의 계약이라 `workspace` 로 유지). 비면 활성 노트북.
    workspace: Option<String>,
    /// 예전엔 LIMIT이 아예 없어 노트북 전체 노트에 대해 세 배치 쿼리를
    /// 매번 다 돌렸다 — 유일한 소비자(모바일 웹 클라이언트)는 어차피 클라이언트단에서 100개로
    /// 자른다. NOTE_QUERY_DEFAULT_LIMIT(200)을 기본값으로, repo::notes::feed_page 안에서
    /// NOTE_QUERY_MAX_LIMIT(1000)으로 clamp.
    limit: Option<i64>,
}

#[derive(Serialize)]
struct TagRef {
    id: String,
    name: String,
}

#[derive(Serialize)]
struct ChecklistItemOut {
    text: String,
    checked: bool,
    index: usize,
}

#[derive(Serialize)]
struct ChecklistSummary {
    total: usize,
    done: usize,
    items: Vec<ChecklistItemOut>,
}

#[derive(Serialize)]
struct NoteListItem {
    id: String,
    title: String,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    folder_id: String,
    folder_name: String,
    updated_at: String,
    has_attachments: bool,
    excerpt: String,
    tags: Vec<TagRef>,
    checklist: Option<ChecklistSummary>,
    thumb: Option<String>,
}

/// Checklist scan bound (mobile feed cards, GET /api/v1/notes): checklists can technically live in
/// any section, but scanning every section's full body_md for every listed note doesn't pay for
/// itself at this endpoint's scale (hundreds of notes on a LAN, no pagination) — a checklist buried
/// past the 2nd section just won't surface a checklist card, same tradeoff has_attachments/excerpt
/// already make (excerpt: first section only). Bump this (or replace the whole batch with a
/// SQL ROW_NUMBER-bounded query) if that ever turns out to matter in practice.
const CHECKLIST_SECTION_SCAN_LIMIT: usize = 2;

/// Build the excerpt/tags/checklist/thumb fields for one note row out of the batch-loaded maps —
/// shared by notes_list below so the per-note assembly logic isn't duplicated inline.
fn build_list_extras(
    sections: &[crate::models::Section],
    tag_refs: Option<&Vec<(String, String)>>,
    attachments: Option<&Vec<crate::models::Attachment>>,
) -> (String, Vec<TagRef>, Option<ChecklistSummary>, Option<String>) {
    let excerpt = sections
        .first()
        .map(|s| repo::checklist::strip_tags_and_collapse(&s.body_md, 160))
        .unwrap_or_default();

    let tags = tag_refs
        .map(|v| v.iter().map(|(id, name)| TagRef { id: id.clone(), name: name.clone() }).collect())
        .unwrap_or_default();

    let mut all_items: Vec<(bool, String)> = Vec::new();
    for section in sections.iter().take(CHECKLIST_SECTION_SCAN_LIMIT) {
        all_items.extend(repo::checklist::scan_checkboxes(&section.body_md));
    }
    let checklist = if all_items.is_empty() {
        None
    } else {
        let total = all_items.len();
        let done = all_items.iter().filter(|(c, _)| *c).count();
        let items = all_items
            .into_iter()
            .take(3)
            .enumerate()
            .map(|(index, (checked, text))| ChecklistItemOut { text, checked, index })
            .collect();
        Some(ChecklistSummary { total, done, items })
    };

    let thumb = attachments
        .and_then(|v| v.iter().find(|a| a.kind == "image"))
        .and_then(|a| a.rel_path.clone());

    (excerpt, tags, checklist, thumb)
}

pub(super) async fn notes_list(State(state): State<ServerState>, headers: HeaderMap, Query(q): Query<NotesQuery>) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    let data_dir = state.data_dir.clone();
    let workspace_param = q.workspace.clone();
    let limit = q.limit.unwrap_or(NOTE_QUERY_DEFAULT_LIMIT);
    let result = tokio::task::spawn_blocking(move || -> AppResult<(Vec<NoteListItem>, bool)> {
        let conn = db::open(&db::db_path(&data_dir))?;
        let workspace = match workspace_param {
            Some(w) if !w.is_empty() => w,
            _ => repo::folders::active_workspace_id(&conn)?,
        };
        // CLIENT-RULES §2 규칙4: 핸들러는 SQL을 직접 들고 있지 않는다 — 배치 조립(LIMIT 적용 +
        // 노트당 앞쪽 섹션만 + 태그/첨부)은 repo::notes::feed_page 가 전담한다.
        // section_scan_limit: excerpt는 첫 섹션만, checklist는 CHECKLIST_SECTION_SCAN_LIMIT까지
        // 읽으므로 그 상한만큼만 요청 — build_list_extras가 실제로 읽는 것보다 많이 가져오지 않는다.
        let page = repo::notes::feed_page(&conn, &workspace, limit, CHECKLIST_SECTION_SCAN_LIMIT as i64)?;

        let items = page
            .rows
            .into_iter()
            .map(|r| {
                let sections = page.sections_by_note.get(&r.id).map(|v| v.as_slice()).unwrap_or(&[]);
                let (excerpt, tags, checklist, thumb) =
                    build_list_extras(sections, page.tags_by_note.get(&r.id), page.attachments_by_note.get(&r.id));
                NoteListItem {
                    id: r.id,
                    title: r.title,
                    year: r.year,
                    month: r.month,
                    day: r.day,
                    folder_id: r.folder_id,
                    folder_name: r.folder_name,
                    updated_at: r.updated_at,
                    has_attachments: r.has_attachments,
                    excerpt,
                    tags,
                    checklist,
                    thumb,
                }
            })
            .collect();
        Ok((items, page.has_more))
    })
    .await;
    match result {
        // has_more: additive field (docs/CLIENT-RULES.md §2 하위호환 규칙) — 구버전 클라이언트는
        // 그냥 이 필드를 모르는 채로 파싱한다.
        Ok(Ok((items, has_more))) => {
            Json(serde_json::json!({ "notes": items, "has_more": has_more })).into_response()
        }
        Ok(Err(e)) => app_error_response(e),
        Err(e) => join_error_response(e),
    }
}

/// note_summary()(note_detail 이 내부에서 쓰는 것)는 의도적으로 deleted_at 필터가 없다 —
/// 데스크톱 휴지통 화면이 개별 노트를 여전히 불러와야 하기 때문(repo/notes/mod.rs::note_summaries_map_internal
/// 주석 참고). 그래서 이 필터는 repo 층이 아니라 여기(HTTP 핸들러)에만 둔다 — 목록(notes_list)은
/// 이미 `deleted_at IS NULL` 로 걸러지는데, 휴지통 노트에 쓰기(checklist toggle, attachment
/// upload)가 새고 있던 비대칭을 여기서 맞춘다.
pub(super) fn check_not_trashed(conn: &Connection, id: &str) -> AppResult<()> {
    let trashed: Option<bool> = conn
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM notes WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr)?;
    match trashed {
        None | Some(true) => Err(AppError::NotFound(format!("note not found: {id}"))),
        Some(false) => Ok(()),
    }
}

/// 손으로 쓴 REST 쓰기 핸들러(checklist toggle, attachment upload — note CRUD 는 삭제됨, 이 파일
/// 헤더 참고)는 커맨드 계층을 거치지 않고 repo 를 직접 부르므로 여기서 직접 통지한다 — origin 은 항상
/// "remote"(정의상 폰이 낸 쓰기). 팬아웃(웹뷰 emit + SSE)은 crate::events 가 전담한다.
/// **POST /api/v1/invoke 는 이걸 부르면 안 된다** — 그 경로는 커맨드가 스스로 publish 하므로
/// 여기서 또 부르면 이중 emit 이다(crate::events 헤더 주석).
pub(super) fn emit_remote_write(note_id: &str, created: bool) {
    crate::events::publish_remote(Some(note_id), created);
}

#[derive(Deserialize)]
pub(super) struct ChecklistToggleBody {
    index: usize,
    checked: bool,
}

/// POST /api/v1/notes/{note_id}/checklist — toggles the `index`-th task-list checkbox across all
/// of the note's sections (position order), the same 0-based ordinal GET /api/v1/notes'
/// `checklist.items[].index` uses. Finds which section owns that ordinal via
/// repo::checklist::count_checkboxes per section (no CHECKLIST_SECTION_SCAN_LIMIT bound here —
/// that bound exists only for the list endpoint's "hundreds of notes at once" scale; a single
/// note's own sections are cheap regardless of how many there are), flips it with
/// repo::checklist::toggle_at, and saves through the same repo::sections::update the desktop
/// editor uses (updated_at bump + FTS upsert already inside that function — nothing extra to
/// do here). 404 unknown/trashed note, 400 index out of range.
pub(super) async fn note_checklist_toggle(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxPath(note_id): AxPath<String>,
    Query(q): Query<TokenQuery>,
    Json(body): Json<ChecklistToggleBody>,
) -> Response {
    if !authorized(&state, &headers, q.token.as_deref()) {
        return unauthorized();
    }
    let data_dir = state.data_dir.clone();
    let target_note_id = note_id.clone();
    let result = tokio::task::spawn_blocking(move || -> AppResult<crate::models::NoteDetail> {
        let mut conn = db::open(&db::db_path(&data_dir))?;
        check_not_trashed(&conn, &note_id)?;
        let sections = repo::sections::load_for_note(&conn, &note_id)?;
        let mut remaining = body.index;
        let mut target: Option<(&crate::models::Section, usize)> = None;
        for section in &sections {
            let count = repo::checklist::count_checkboxes(&section.body_md);
            if remaining < count {
                target = Some((section, remaining));
                break;
            }
            remaining -= count;
        }
        let (section, local_index) = target.ok_or_else(|| {
            AppError::Validation(format!("checklist index out of range: {}", body.index))
        })?;
        let new_body = repo::checklist::toggle_at(&section.body_md, local_index, body.checked)
            .ok_or_else(|| AppError::Validation(format!("checklist index out of range: {}", body.index)))?;
        // ai_origin: None (보존) — 체크리스트 토글은 저작권 판정 지점이 아니다.
        repo::sections::update(&mut conn, &section.id, None, Some(new_body), None)?;
        repo::notes::note_detail(&conn, &note_id)
    })
    .await;
    match result {
        Ok(Ok(detail)) => {
            emit_remote_write(&target_note_id, false);
            Json(detail).into_response()
        }
        Ok(Err(e)) => app_error_response(e),
        Err(e) => join_error_response(e),
    }
}
