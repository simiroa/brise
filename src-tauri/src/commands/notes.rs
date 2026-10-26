// 커맨드: notes + folders (commands/notes.yaml)
use super::{
    AppState, ContentLockState, Deleted, FavoriteState, NoteQueryOutput, NoteTagsIndex, Okay,
    RelatedResult, TagAffected, TagColors, TagCounts, TagsResult, TrashCount,
};
use crate::error::AppError;
use crate::models::{Folder, NoteDetail, NoteSummary};
use crate::repo::{folders, notes};
use crate::repo::notes::{
    CoordsFilterSpec, NoteQuery, NoteQuerySort, RecordAxis, RegionFilterSpec, TagMode,
};
use serde::Deserialize;
use std::collections::HashMap;
use tauri::State;

/// year/month/day 는 각각 독립적으로 미지정 시 오늘(로컬 타임존)로 기본값이 채워진다 —
/// notes::create_today_default 참조. 명시적으로 준 값은 그대로 존중된다.
#[tauri::command(rename_all = "snake_case")]
pub fn note_create(
    state: State<AppState>,
    folder_id: String,
    title: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
) -> Result<NoteDetail, AppError> {
    let mut conn = state.db.lock();
    let detail = notes::create_today_default(&mut conn, &folder_id, title, year, month, day)?;
    crate::events::publish(Some(&detail.note.id), true);
    Ok(detail)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_get(state: State<AppState>, id: String) -> Result<NoteDetail, AppError> {
    let conn = state.db.lock();
    notes::note_detail(&conn, &id)
}

/// 배치 note_get — 대시보드 달력 날짜 패널이 노트마다 note_get 을 부르던 N+1(합성 1만 노트에서 첫 열기마다
/// IPC ~420회)을 한 번으로. 순서·생략 규칙은 repo::notes::note_details_for_ids.
/// async + 읽기 연결: 동기 커맨드는 메인 스레드에서 돈다(check:sync-commands) — 노트 수백 개의 본문을 읽는
/// 일이라 search_notes 처럼 `with_read` 로 돌려 자동 저장 등 쓰기 커맨드가 `db` 잠금을 기다리지 않게 한다.
#[tauri::command(rename_all = "snake_case")]
pub async fn note_get_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<NoteGetManyOutput, AppError> {
    let notes = state.with_read(|conn| notes::note_details_for_ids(conn, &ids))?;
    Ok(NoteGetManyOutput { notes })
}

#[derive(Debug, serde::Serialize)]
pub struct NoteGetManyOutput {
    pub notes: Vec<NoteDetail>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_update(
    state: State<AppState>,
    id: String,
    title: Option<String>,
    year: Option<i64>,
    folder_id: Option<String>,
    remind: Option<bool>,
) -> Result<NoteSummary, AppError> {
    let mut conn = state.db.lock();
    let summary = notes::update(&mut conn, &id, title, year, folder_id, remind)?;
    crate::events::publish(Some(&id), false);
    Ok(summary)
}

/// 소프트 삭제(휴지통으로 이동) — 기본 삭제 경로. 완전 삭제는 note_purge 참조.
#[tauri::command(rename_all = "snake_case")]
pub fn note_delete(state: State<AppState>, id: String) -> Result<Deleted, AppError> {
    let mut conn = state.db.lock();
    let deleted = notes::delete(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(Deleted { deleted })
}

/// 휴지통에서 복구 — deleted_at 해제 + FTS 재색인.
#[tauri::command(rename_all = "snake_case")]
pub fn note_restore(state: State<AppState>, id: String) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = notes::restore(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(Okay { ok })
}

/// 완전 삭제(휴지통 비우기) — 구 note_delete 의 하드 삭제 로직(CASCADE + FTS + internal-link
/// 정리 + 첨부 디렉토리 삭제)을 그대로 수행한다.
#[tauri::command(rename_all = "snake_case")]
pub fn note_purge(state: State<AppState>, id: String) -> Result<Deleted, AppError> {
    let mut conn = state.db.lock();
    let deleted = notes::purge(&mut conn, &state.data_dir, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(Deleted { deleted })
}

/// 휴지통 목록 — 워크스페이스(생략 시 active) 소속 소프트 삭제 노트를 deleted_at desc 로.
#[tauri::command(rename_all = "snake_case")]
pub fn note_trash_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<Vec<NoteSummary>, AppError> {
    let conn = state.db.lock();
    notes::trash_list(&conn, workspace_id)
}

/// 휴지통 배지용 COUNT — 목록 조립 없이 건수만. 부팅 창 밖(첫 페인트 후)에서 호출.
#[tauri::command(rename_all = "snake_case")]
pub fn note_trash_count(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<TrashCount, AppError> {
    let conn = state.db.lock();
    let count = notes::trash_count(&conn, workspace_id)?;
    Ok(TrashCount { count })
}

/// W7-f 아카이브 — 트리/대시보드에서 숨기되 FTS는 유지(delete()와 달리 fts_delete 미호출).
#[tauri::command(rename_all = "snake_case")]
pub fn note_archive(state: State<AppState>, id: String) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = notes::archive(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(Okay { ok })
}

/// W7-f 아카이브 해제 — archived_at 해제.
#[tauri::command(rename_all = "snake_case")]
pub fn note_unarchive(state: State<AppState>, id: String) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = notes::unarchive(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(Okay { ok })
}

/// W7-f 아카이브 목록 — 워크스페이스(생략 시 active) 소속 아카이브 노트를 archived_at desc 로.
#[tauri::command(rename_all = "snake_case")]
pub fn note_archived_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<Vec<NoteSummary>, AppError> {
    let conn = state.db.lock();
    notes::archived_list(&conn, workspace_id)
}

/// W7-f 아카이브 배지용 COUNT — 목록 조립 없이 건수만.
#[tauri::command(rename_all = "snake_case")]
pub fn note_archived_count(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<TrashCount, AppError> {
    let conn = state.db.lock();
    let count = notes::archived_count(&conn, workspace_id)?;
    Ok(TrashCount { count })
}

/// Sidebar note window — single read endpoint for view state
/// (year/fav/tags/region/statuses/coords). Text search still reserved.
/// See `specs/commands/notes.yaml` `note_query`.
#[tauri::command(rename_all = "snake_case")]
pub fn note_query(
    state: State<AppState>,
    workspace_id: Option<String>,
    folder_ids: Option<Vec<String>>,
    year_from: Option<i64>,
    year_to: Option<i64>,
    updated_from: Option<String>,
    updated_to: Option<String>,
    created_from: Option<String>,
    created_to: Option<String>,
    favorites_only: Option<bool>,
    include_archived: Option<bool>,
    tags: Option<Vec<String>>,
    tag_mode: Option<String>,
    region: Option<NoteQueryRegionArg>,
    statuses: Option<Vec<String>>,
    // Coordinate axis: omit = Any. {kind:"has"} | {kind:"none"} | {kind:"bbox", ...}
    coords: Option<NoteQueryCoordsArg>,
    query: Option<String>,
    sort: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<NoteQueryOutput, AppError> {
    let tag_mode = match tag_mode.as_deref() {
        None | Some("or") => TagMode::Or,
        Some("and") => TagMode::And,
        Some(other) => {
            return Err(AppError::Validation(format!(
                "note_query: unknown tag_mode '{other}' (or|and)"
            )));
        }
    };
    let region = match region {
        None => RegionFilterSpec::Any,
        Some(NoteQueryRegionArg::None) => RegionFilterSpec::None,
        Some(NoteQueryRegionArg::Region { name }) => RegionFilterSpec::Eq(name),
    };
    let coords = match coords {
        None => CoordsFilterSpec::Any,
        Some(NoteQueryCoordsArg::Has) => CoordsFilterSpec::HasCoords,
        Some(NoteQueryCoordsArg::None) => CoordsFilterSpec::NoCoords,
        Some(NoteQueryCoordsArg::Bbox {
            min_lat,
            max_lat,
            min_lng,
            max_lng,
        }) => CoordsFilterSpec::Bbox {
            min_lat,
            max_lat,
            min_lng,
            max_lng,
        },
    };
    let sort = match sort.as_deref() {
        None | Some("year_asc") => NoteQuerySort::YearAsc,
        Some("year_desc") => NoteQuerySort::YearDesc,
        Some("updated_desc") => NoteQuerySort::UpdatedDesc,
        Some("created_desc") => NoteQuerySort::CreatedDesc,
        Some("title_asc") => NoteQuerySort::TitleAsc,
        Some(other) => {
            return Err(AppError::Validation(format!(
                "note_query: unknown sort '{other}' (year_asc|year_desc|updated_desc|created_desc|title_asc)"
            )));
        }
    };
    let q = NoteQuery {
        workspace_id,
        folder_ids,
        year_from,
        year_to,
        updated_from,
        updated_to,
        created_from,
        created_to,
        favorites_only: favorites_only.unwrap_or(false),
        include_archived: include_archived.unwrap_or(false),
        tags: tags.unwrap_or_default(),
        tag_mode,
        region,
        statuses: statuses.unwrap_or_default(),
        coords,
        query,
        sort,
        offset: offset.unwrap_or(0),
        limit,
    };
    let conn = state.db.lock();
    let r = notes::query(&conn, q)?;
    Ok(NoteQueryOutput {
        notes: r.notes,
        total: r.total,
    })
}

/// Year density histogram for the timeline slider strip — not derived by pulling every note.
#[tauri::command(rename_all = "snake_case")]
pub fn note_year_histogram(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<YearHistogramOutput, AppError> {
    let conn = state.db.lock();
    let counts = notes::year_histogram(&conn, workspace_id)?;
    Ok(YearHistogramOutput {
        counts: counts
            .into_iter()
            .map(|(year, count)| YearCount { year, count })
            .collect(),
    })
}

#[derive(Debug, serde::Serialize)]
pub struct YearCount {
    pub year: i64,
    pub count: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct YearHistogramOutput {
    pub counts: Vec<YearCount>,
}

/// Calendar record-axis day histogram (updated_at or created_at) — groundwork for the calendar
/// filter (backend only, no UI in this wave). Modeled on note_year_histogram but the record axis
/// instead of the event axis, and bounded (from/to required) since day cardinality over a note's
/// full history is unbounded in a way year is not. See repo::note_query::record_histogram for the
/// UTC-vs-local caveat.
#[tauri::command(rename_all = "snake_case")]
pub fn note_record_histogram(
    state: State<AppState>,
    workspace_id: Option<String>,
    axis: Option<String>,
    from: String,
    to: String,
) -> Result<RecordHistogramOutput, AppError> {
    let axis = match axis.as_deref() {
        None | Some("updated") => RecordAxis::Updated,
        Some("created") => RecordAxis::Created,
        Some("union") => RecordAxis::Union,
        Some(other) => {
            return Err(AppError::Validation(format!(
                "note_record_histogram: unknown axis '{other}' (updated|created|union)"
            )));
        }
    };
    let conn = state.db.lock();
    let counts = notes::record_histogram(&conn, workspace_id, axis, &from, &to)?;
    Ok(RecordHistogramOutput {
        counts: counts
            .into_iter()
            .map(|(day, count)| DayCount { day, count })
            .collect(),
    })
}

#[derive(Debug, serde::Serialize)]
pub struct DayCount {
    pub day: String,
    pub count: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct RecordHistogramOutput {
    pub counts: Vec<DayCount>,
}

/// IPC shape for the region axis — omit the whole arg for "no region filter".
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteQueryRegionArg {
    None,
    Region { name: String },
}

/// IPC shape for the coordinate axis — omit for no filter.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteQueryCoordsArg {
    Has,
    None,
    Bbox {
        min_lat: f64,
        max_lat: f64,
        min_lng: f64,
        max_lng: f64,
    },
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_toggle_favorite(
    state: State<AppState>,
    id: String,
) -> Result<FavoriteState, AppError> {
    let mut conn = state.db.lock();
    let is_favorite = notes::toggle_favorite(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(FavoriteState { is_favorite })
}

/// 더보기 메뉴 "내용잠금" — note_toggle_favorite 와 동일한 구조. "content_lock" 이라는 이름은
/// App.tsx 의 완전히 별개인 "UI 잠금"(uiLock, IconLock) 과 겹치지 않도록 의도적으로 고른 것.
#[tauri::command(rename_all = "snake_case")]
pub fn note_toggle_content_lock(
    state: State<AppState>,
    id: String,
) -> Result<ContentLockState, AppError> {
    let mut conn = state.db.lock();
    let content_locked = notes::toggle_content_lock(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(ContentLockState { content_locked })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_set_tags(
    state: State<AppState>,
    id: String,
    tag_names: Vec<String>,
) -> Result<TagsResult, AppError> {
    let mut conn = state.db.lock();
    let tag_names = notes::set_tags(&mut conn, &id, tag_names)?;
    crate::events::publish(Some(&id), false);
    Ok(TagsResult { tag_names })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_set_region(
    state: State<AppState>,
    id: String,
    region: Option<String>,
) -> Result<NoteSummary, AppError> {
    let mut conn = state.db.lock();
    let summary = notes::set_region(&mut conn, &id, region)?;
    crate::events::publish(Some(&id), false);
    Ok(summary)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_set_status(
    state: State<AppState>,
    id: String,
    status: Option<String>,
) -> Result<NoteSummary, AppError> {
    let mut conn = state.db.lock();
    let summary = notes::set_status(&mut conn, &id, status)?;
    crate::events::publish(Some(&id), false);
    Ok(summary)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_set_icon(
    state: State<AppState>,
    id: String,
    icon: Option<String>,
) -> Result<NoteSummary, AppError> {
    let mut conn = state.db.lock();
    let summary = notes::set_icon(&mut conn, &id, icon)?;
    crate::events::publish(Some(&id), false);
    Ok(summary)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_set_location(
    state: State<AppState>,
    id: String,
    lat: Option<f64>,
    lng: Option<f64>,
) -> Result<NoteSummary, AppError> {
    let mut conn = state.db.lock();
    let summary = notes::set_location(&mut conn, &id, lat, lng)?;
    crate::events::publish(Some(&id), false);
    Ok(summary)
}

// PLAN-2026-09-08-dates-rebuild.md W3: note_set_event_precision/note_set_event_end/note_set_schedule
// 커맨드는 삭제됐다 — note_date_update(행 하나의 정밀도·기간·시각·알림·반복을 한 번에)가 흡수한다.
// 밑에 남은 repo::notes::set_event_precision/set_event_end/set_schedule 함수 자체는 이 세 커맨드
// 말고도 board.rs/calendar.rs/schedule/mod.rs/timeline.rs/pet/mod.rs 의 테스트 픽스처가 여전히
// 호출하므로(대표 행을 빠르게 세팅하는 내부 헬퍼) 그대로 남아 있다 — W3 보고서 참고.

#[tauri::command(rename_all = "snake_case")]
pub fn note_related(
    state: State<AppState>,
    id: String,
    limit: Option<i64>,
) -> Result<RelatedResult, AppError> {
    let conn = state.db.lock();
    let notes = notes::related(&conn, &id, limit.unwrap_or(5))?;
    Ok(RelatedResult { notes })
}

/// By-id batch lookup — Wave A-4 replacement for resident-corpus `noteIndex.get`.
/// Missing / soft-deleted ids are omitted from the map (never invent blank rows).
#[tauri::command(rename_all = "snake_case")]
pub fn note_summaries_map(
    state: State<AppState>,
    ids: Vec<String>,
) -> Result<NoteSummariesMapOutput, AppError> {
    let conn = state.db.lock();
    let notes = notes::note_summaries_map(&conn, &ids)?;
    Ok(NoteSummariesMapOutput { notes })
}

#[derive(Debug, serde::Serialize)]
pub struct NoteSummariesMapOutput {
    pub notes: HashMap<String, NoteSummary>,
}

/// Scale: 기동 첫 페인트용 — 폴더와 개수만. 노트 목록은 첫 페인트 뒤 folder_list 로 받는다.
#[tauri::command(rename_all = "snake_case")]
pub fn folder_list_meta(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<folders::FolderList, AppError> {
    let conn = state.db.lock();
    folders::list_meta(&conn, workspace_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_list(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<folders::FolderList, AppError> {
    let conn = state.db.lock();
    folders::list(&conn, workspace_id)
}

/// folder_list 경량 요약 이후 태그 필터/칩용으로 호출. 휴지통 제외 note_id → 태그명[].
#[tauri::command(rename_all = "snake_case")]
pub fn note_tags_index(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<NoteTagsIndex, AppError> {
    let conn = state.db.lock();
    let tags_by_note = folders::note_tags_index(&conn, workspace_id)?;
    Ok(NoteTagsIndex { tags_by_note })
}

/// 워크스페이스 태그별 노트 수 — TagsFilter/TitleBar 가 클라 O(N) 평탄화 대신 사용.
/// soft-delete 제외. workspace_id 생략 시 활성 워크스페이스.
#[tauri::command(rename_all = "snake_case")]
pub fn tag_counts(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<TagCounts, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let rows = notes::tag_counts(&conn, &ws)?;
    let counts: HashMap<String, i64> = rows.into_iter().collect();
    Ok(TagCounts { counts })
}

#[tauri::command(rename_all = "snake_case")]
pub fn tag_colors(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<TagColors, AppError> {
    let conn = state.db.lock();
    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(&conn)?,
    };
    let rows = notes::tag_colors(&conn, &ws)?;
    let colors: HashMap<String, i64> = rows.into_iter().collect();
    Ok(TagColors { colors })
}

#[tauri::command(rename_all = "snake_case")]
pub fn tag_set_color(
    state: State<AppState>,
    name: String,
    color_hue: Option<i64>,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = notes::tag_set_color(&mut conn, &name, color_hue)?;
    crate::events::publish(None, false); // 워크스페이스 전역 변경 — 노트 하나로 좁힐 수 없다.
    Ok(Okay { ok })
}

// ponytail: undo for tag CRUD is a follow-up; confirm dialog is the guard.
#[tauri::command(rename_all = "snake_case")]
pub fn tag_rename(
    state: State<AppState>,
    from: String,
    to: String,
) -> Result<TagAffected, AppError> {
    let mut conn = state.db.lock();
    let affected = notes::tag_rename(&mut conn, &from, &to)?;
    crate::events::publish(None, false);
    Ok(TagAffected { ok: true, affected })
}

#[tauri::command(rename_all = "snake_case")]
pub fn tag_merge(
    state: State<AppState>,
    from: Vec<String>,
    to: String,
) -> Result<TagAffected, AppError> {
    let mut conn = state.db.lock();
    let affected = notes::tag_merge(&mut conn, from, &to)?;
    crate::events::publish(None, false);
    Ok(TagAffected { ok: true, affected })
}

#[tauri::command(rename_all = "snake_case")]
pub fn tag_delete(state: State<AppState>, name: String) -> Result<TagAffected, AppError> {
    let mut conn = state.db.lock();
    let affected = notes::tag_delete(&mut conn, &name)?;
    crate::events::publish(None, false);
    Ok(TagAffected { ok: true, affected })
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_create(
    state: State<AppState>,
    name: String,
    workspace_id: Option<String>,
    color_hue: Option<i64>,
    icon: Option<String>,
    rules: Option<String>,
) -> Result<Folder, AppError> {
    let mut conn = state.db.lock();
    let folder = folders::create(&mut conn, &name, workspace_id, color_hue, icon, rules)?;
    crate::events::publish(None, false);
    Ok(folder)
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_rename(state: State<AppState>, id: String, name: String) -> Result<Folder, AppError> {
    let mut conn = state.db.lock();
    let folder = folders::rename(&mut conn, &id, &name)?;
    crate::events::publish(None, false);
    Ok(folder)
}

/// 일부러 crate::events::publish 를 부르지 않는다 — 트리 펼침/접힘은 기기 로컬 UI 상태다
/// (settings_set 의 창 크기/패널 폭과 같은 부류). 클릭마다 다른 기기를 재조회시킬 이유가 없다.
#[tauri::command(rename_all = "snake_case")]
pub fn folder_set_open(
    state: State<AppState>,
    id: String,
    is_open: bool,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = folders::set_open(&mut conn, &id, is_open)?;
    Ok(Okay { ok })
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_set_color(
    state: State<AppState>,
    id: String,
    color_hue: Option<i64>,
) -> Result<Folder, AppError> {
    let mut conn = state.db.lock();
    let folder = folders::set_color(&mut conn, &id, color_hue)?;
    crate::events::publish(None, false);
    Ok(folder)
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_set_icon(
    state: State<AppState>,
    id: String,
    icon: Option<String>,
) -> Result<Folder, AppError> {
    let mut conn = state.db.lock();
    let folder = folders::set_icon(&mut conn, &id, icon)?;
    crate::events::publish(None, false);
    Ok(folder)
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_set_rules(
    state: State<AppState>,
    id: String,
    rules: Option<String>,
) -> Result<Folder, AppError> {
    let mut conn = state.db.lock();
    let folder = folders::set_rules(&mut conn, &id, rules)?;
    crate::events::publish(None, false);
    Ok(folder)
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_set_exclusions(
    state: State<AppState>,
    id: String,
    search_excluded: bool,
    ai_excluded: bool,
) -> Result<Folder, AppError> {
    let mut conn = state.db.lock();
    let folder = folders::set_exclusions(&mut conn, &id, search_excluded, ai_excluded)?;
    crate::events::publish(None, false);
    Ok(folder)
}

#[tauri::command(rename_all = "snake_case")]
pub fn folder_files(
    state: State<AppState>,
    id: String,
) -> Result<folders::FolderFilesResult, AppError> {
    let conn = state.db.lock();
    folders::files(&conn, &id)
}

#[derive(Debug, serde::Serialize)]
pub struct RestoreCount {
    pub count: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct RegionAddResult {
    pub id: String,
}

#[derive(Debug, serde::Serialize)]
pub struct RegionListResult {
    pub regions: Vec<crate::models::NoteRegion>,
}

#[derive(Debug, serde::Serialize)]
pub struct RegionRegistryResult {
    pub entries: Vec<notes::RegionRegistryEntry>,
}

#[derive(Debug, serde::Serialize)]
pub struct DateAddResult {
    pub id: String,
}

#[derive(Debug, serde::Serialize)]
pub struct DateListResult {
    pub dates: Vec<crate::models::NoteDate>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_related_exclude(
    state: State<AppState>,
    id_1: String,
    id_2: String,
) -> Result<Okay, AppError> {
    let conn = state.db.lock();
    notes::related_exclude(&conn, &id_1, &id_2)?;
    crate::events::publish(Some(&id_1), false);
    crate::events::publish(Some(&id_2), false);
    Ok(Okay { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_related_restore(
    state: State<AppState>,
    id: String,
) -> Result<RestoreCount, AppError> {
    let mut conn = state.db.lock();
    let count = notes::related_restore(&mut conn, &id)?;
    crate::events::publish(Some(&id), false);
    Ok(RestoreCount { count })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_related_hidden_count(
    state: State<AppState>,
    id: String,
) -> Result<RestoreCount, AppError> {
    let conn = state.db.lock();
    let count = notes::related_hidden_count(&conn, &id)?;
    Ok(RestoreCount { count })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_region_add(
    state: State<AppState>,
    note_id: String,
    name: String,
    // f64 이어야 한다. i64 로 받아 `as f64` 하면 위경도 소수부가 잘려 37.5665 가 37 이 된다 —
    // 위도 1도는 약 111km 다. 스펙(notes.yaml)도 number 로 맞춰 두었고, 생성기는 lat/lng 필드를
    // 항상 f64 로 내보내므로(gen-commands.mjs) i64 로 두면 dispatch.gen.rs 가 컴파일되지 않는다.
    lat: f64,
    lng: f64,
    position: i64,
) -> Result<RegionAddResult, AppError> {
    let mut conn = state.db.lock();
    let id = notes::region_add(&mut conn, &note_id, &name, lat, lng, position)?;
    crate::events::publish(Some(&note_id), false);
    Ok(RegionAddResult { id })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_region_remove(
    state: State<AppState>,
    id: String,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    // repo 가 소속 note_id 를 돌려주므로 그 노트만 갱신 이벤트를 낸다(전체 갱신 아님).
    let note_id = notes::region_remove(&mut conn, &id)?;
    drop(conn);
    crate::events::publish(note_id.as_deref(), false);
    Ok(Okay { ok: true })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_regions_list(
    state: State<AppState>,
    note_id: String,
) -> Result<RegionListResult, AppError> {
    let conn = state.db.lock();
    let regions = notes::regions_list(&conn, &note_id)?;
    Ok(RegionListResult { regions })
}

/// §P3 Phase A (PLAN-2026-09-19-date-region-ui.md, D7) — 워크스페이스 전체 지역명 레지스트리.
/// 입력 생략 시 활성 워크스페이스(repo::folders::active_workspace_id) — workspace_region_list 와
/// 동일한 omit=active 계약.
#[tauri::command(rename_all = "snake_case")]
pub fn region_registry(
    state: State<AppState>,
    workspace_id: Option<String>,
) -> Result<RegionRegistryResult, AppError> {
    let conn = state.db.lock();
    let entries = notes::region_registry(&conn, workspace_id)?;
    Ok(RegionRegistryResult { entries })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_region_reorder(
    state: State<AppState>,
    note_id: String,
    ordered_ids: Vec<String>,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = notes::region_reorder(&mut conn, &note_id, &ordered_ids)?;
    crate::events::publish(Some(&note_id), false);
    Ok(Okay { ok })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_region_move(
    state: State<AppState>,
    id: String,
    lat: f64,
    lng: f64,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    // repo 가 소속 note_id 를 돌려주므로 그 노트만 갱신 이벤트를 낸다(note_region_remove 와 동일).
    let note_id = notes::region_move(&mut conn, &id, lat, lng)?;
    drop(conn);
    crate::events::publish(Some(&note_id), false);
    Ok(Okay { ok: true })
}

// ── 날짜 행 (note_dates) — PLAN-2026-09-08-dates-rebuild.md W3: 행 하나를 다루는 커맨드 한 벌 ──

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub fn note_date_add(
    state: State<AppState>,
    note_id: String,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: Option<String>,
    end_time: Option<String>,
    remind: Option<bool>,
    remind_offset_min: Option<i64>,
    rrule: Option<String>,
    // D1 부활(V85, PLAN-2026-09-18-nl-dates.md): 관련 날짜 라벨 — dispatch.gen.rs 가 notes.yaml
    // 필드 순서대로 마지막 인자로 넘긴다(npm run gen 재생성 확인).
    label: Option<String>,
) -> Result<DateAddResult, AppError> {
    let mut conn = state.db.lock();
    let id = notes::date_add(
        &mut conn, &note_id, year, month, day, end_year, end_month, end_day,
        start_time, end_time, remind.unwrap_or(false), remind_offset_min, rrule, label,
    )?;
    crate::events::publish(Some(&note_id), false);
    Ok(DateAddResult { id })
}

/// **행 하나의 모든 것을 한 번에** 고친다(정밀도·기간·시각·알림·반복) — 옛
/// note_date_set_remind/note_date_set_schedule/note_set_schedule/note_set_event_precision/
/// note_set_event_end 다섯 커맨드를 흡수한다. 전량 교체 계약(notes.yaml::note_date_update 참고)이라
/// 호출자는 매번 이 행의 전체 상태를 보낸다.
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub fn note_date_update(
    state: State<AppState>,
    id: String,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: Option<String>,
    end_time: Option<String>,
    remind: bool,
    remind_offset_min: Option<i64>,
    rrule: Option<String>,
    // D1 부활(V85)/D2: 대표(position=0) 행이면 repo::notes::dates::date_update 가 이 값을 무시하고
    // 항상 NULL로 쓴다 — 커맨드 계층은 그냥 그대로 전달한다.
    label: Option<String>,
) -> Result<crate::models::NoteDate, AppError> {
    let mut conn = state.db.lock();
    let date = notes::date_update(
        &mut conn, &id, year, month, day, end_year, end_month, end_day,
        start_time, end_time, remind, remind_offset_min, rrule, label,
    )?;
    drop(conn);
    crate::events::publish(Some(&date.note_id), false);
    Ok(date)
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_date_remove(
    state: State<AppState>,
    id: String,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    // repo 가 소속 note_id 를 돌려주므로 그 노트만 갱신 이벤트를 낸다(note_region_remove 와 동일).
    let note_id = notes::date_remove(&mut conn, &id)?;
    drop(conn);
    crate::events::publish(note_id.as_deref(), false);
    Ok(Okay { ok: true })
}

/// 관련 날짜(position != 0) 순서 재배치 — note_region_reorder 와 동일 계약. 대표(position=0)는
/// 대상에서 제외된다(dates.rs::date_reorder 문서 참조).
#[tauri::command(rename_all = "snake_case")]
pub fn note_date_reorder(
    state: State<AppState>,
    note_id: String,
    ordered_ids: Vec<String>,
) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let ok = notes::date_reorder(&mut conn, &note_id, &ordered_ids)?;
    crate::events::publish(Some(&note_id), false);
    Ok(Okay { ok })
}

#[tauri::command(rename_all = "snake_case")]
pub fn note_dates_list(
    state: State<AppState>,
    note_id: String,
) -> Result<DateListResult, AppError> {
    let conn = state.db.lock();
    let dates = notes::dates_list(&conn, &note_id)?;
    Ok(DateListResult { dates })
}

// 목록의 대표를 이 행으로 교체(note_region 의 "대표로"와 같은 역할). W3: note_date_reorder 의
// 특수한 경우로 흡수하지 않고 별도 커맨드로 남긴다 — 이 승격만이 갖는 검증(대상 행의 트리플
// 방어적 재검증)이 있고, reorder 가 position=0 자리를 쓸 수 있게 하면 그 검증을 우회하는 두 번째
// 경로가 열린다(dates.rs::date_reorder 문서 참조).
#[tauri::command(rename_all = "snake_case")]
pub fn note_date_make_primary(state: State<AppState>, id: String) -> Result<Okay, AppError> {
    let mut conn = state.db.lock();
    let note_id = notes::date_make_primary(&mut conn, &id)?;
    drop(conn);
    crate::events::publish(Some(&note_id), false);
    Ok(Okay { ok: true })
}
