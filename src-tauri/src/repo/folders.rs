// repo: folders + folder_list 트리 데이터 — commands/notes.yaml 의 folder_* 커맨드
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::{Folder, NoteSummary};
use crate::repo::note_summary_row::{map_summary_base, summary_cols};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct FolderList {
    pub folders: Vec<Folder>,
    pub notes_by_folder: HashMap<String, Vec<NoteSummary>>,
}

/// 활성 워크스페이스 id — settings.active_workspace_id → 없으면 첫 워크스페이스.
pub fn active_workspace_id(conn: &Connection) -> AppResult<String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='active_workspace_id'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(dberr)?;
    if let Some(json) = stored {
        if let Ok(serde_json::Value::String(id)) = serde_json::from_str::<serde_json::Value>(&json) {
            if !id.is_empty() {
                // 존재 검증
                let exists: bool = conn
                    .query_row("SELECT 1 FROM workspaces WHERE id=?1", [&id], |_| Ok(true))
                    .optional()
                    .map_err(dberr)?
                    .unwrap_or(false);
                if exists {
                    return Ok(id);
                }
            }
        }
    }
    conn.query_row(
        "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(dberr)?
    .ok_or_else(|| AppError::NotFound("no workspace".to_string()))
}

fn load_folder(conn: &Connection, id: &str) -> AppResult<Folder> {
    conn.query_row(
        "SELECT f.id, f.workspace_id, f.name, f.position, f.is_open, f.color_hue, f.icon, f.rules,
                f.search_excluded, f.ai_excluded,
                (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id)
         FROM folders f WHERE f.id = ?1",
        [id],
        |r| {
            Ok(Folder {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                is_open: r.get::<_, i64>(4)? != 0,
                color_hue: r.get(5)?,
                icon: r.get(6)?,
                rules: r.get(7)?,
                search_excluded: r.get::<_, i64>(8)? != 0,
                ai_excluded: r.get::<_, i64>(9)? != 0,
                note_count: r.get(10)?,
            })
        },
    )
    .optional()
    .map_err(dberr)?
    .ok_or_else(|| AppError::NotFound(format!("folder not found: {id}")))
}

/// 트리용 경량 요약 (docs/SCALABILITY.md Phase 1 B안).
///
/// `tag_names` / `has_image` 는 **채우지 않는다** (`[]` / `false`). 태그 필터·칩 카운트는
/// [`note_tags_index`] 로, 단일 노트의 이미지 여부는 `attachments::has_image_for_note` 로,
/// 검색/related 처럼 무거운 필드가 진짜로 필요한 경로는 `notes::note_summaries_map` 배치로
/// 가져온다. 예전에 여기서 워크스페이스 전체 태그 조인 + attachments 스캔을 매 loadTree 마다
/// 지불해 100k 에서 ~1.8s 가 나왔다.
/// Scale: 기동 첫 페인트용 — 폴더 행과 노트 개수만. 노트 행은 한 건도 실어 보내지 않는다.
/// 10만 노트 실측에서 이 쿼리는 9.5ms (커버링 인덱스 idx_notes_folder 로 카운트) 인 반면,
/// list() 는 10만 요약을 만들어 내느라 727ms + 직렬화 324ms(25MB) 가 든다 — 그 비용은 반환
/// 행 수에 정비례하므로 첫 페인트가 코퍼스에 묶이지 않으려면 아예 보내지 않는 수밖에 없다.
/// 노트 본문 목록은 첫 페인트 이후 list() 로 이어서 받는다(프론트 loadTree 참고).
pub fn list_meta(conn: &Connection, workspace_id: Option<String>) -> AppResult<FolderList> {
    let ws = match workspace_id {
        Some(w) => w,
        None => active_workspace_id(conn)?,
    };
    let folders = folder_rows(conn, &ws)?;
    // 폴더별 빈 목록으로 채운다 — 프론트가 키 존재를 전제로 하는 자리를 그대로 유지하려는 것.
    let mut notes_by_folder: HashMap<String, Vec<NoteSummary>> = HashMap::new();
    for folder in &folders {
        notes_by_folder.insert(folder.id.clone(), Vec::new());
    }
    Ok(FolderList {
        folders,
        notes_by_folder,
    })
}

/// 폴더 행 + 노트 개수. list() 와 list_meta() 가 공유한다.
/// W7-f: 이 note_count 서브쿼리는 deleted_at 도 걸지 않는 기존 동작(휴지통 노트도 세는 것으로
/// 보임) — 그 기존 관례를 건드리지 않고 archived_at 도 나란히 안 건다. list()의 notes_by_folder
/// (트리에 실제로 그리는 목록)만 두 컬럼 모두 필터한다.
fn folder_rows(conn: &Connection, ws: &str) -> AppResult<Vec<Folder>> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.workspace_id, f.name, f.position, f.is_open, f.color_hue, f.icon, f.rules,
                    f.search_excluded, f.ai_excluded,
                    (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id)
             FROM folders f WHERE f.workspace_id = ?1
             ORDER BY f.position, f.created_at",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([ws], |r| {
            Ok(Folder {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                is_open: r.get::<_, i64>(4)? != 0,
                color_hue: r.get(5)?,
                icon: r.get(6)?,
                rules: r.get(7)?,
                search_excluded: r.get::<_, i64>(8)? != 0,
                ai_excluded: r.get::<_, i64>(9)? != 0,
                note_count: r.get(10)?,
            })
        })
        .map_err(dberr)?;
    let out: Vec<Folder> = rows.collect::<Result<_, _>>().map_err(dberr)?;
    Ok(out)
}

pub fn list(conn: &Connection, workspace_id: Option<String>) -> AppResult<FolderList> {
    let ws = match workspace_id {
        Some(w) => w,
        None => active_workspace_id(conn)?,
    };
    let folders = folder_rows(conn, &ws)?;

    // Trash: 휴지통 노트는 트리에서 숨긴다. 경량 필드만 SELECT — 태그/이미지 조인 없음.
    // W7-f: 아카이브 노트도 트리에서 숨긴다("보이지 않지만 찾으면 나온다" — search_notes는 계속
    // 반환).
    let cols = summary_cols("n");
    let mut notes_stmt = conn.prepare(&format!(
        "SELECT {cols}
         FROM notes n JOIN folders f ON f.id=n.folder_id
         WHERE f.workspace_id=?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
         ORDER BY n.folder_id, n.year, n.created_at"
    )).map_err(dberr)?;

    let mut notes_by_folder: HashMap<String, Vec<NoteSummary>> = HashMap::new();
    for folder in &folders {
        notes_by_folder.insert(folder.id.clone(), Vec::new());
    }

    let notes_rows = notes_stmt.query_map([&ws], map_summary_base).map_err(dberr)?;

    for row in notes_rows {
        // 경량 트리 경로 — 파생 필드(has_image/tag_names/region_names)는 map_summary_base 가
        // 비워 둔 그대로 둔다. models.rs 주석대로 note_query/note_summaries_map 만 채운다.
        let summary = row.map_err(dberr)?;
        notes_by_folder.entry(summary.folder_id.clone()).or_default().push(summary);
    }

    Ok(FolderList {
        folders,
        notes_by_folder,
    })
}

/// 워크스페이스 노트 → 태그명 목록. `folder_list` 경량 로드 후 태그 필터/칩용으로 별도 호출.
/// 휴지통 노트는 제외. 각 노트 내부 태그 순서는 `t.name COLLATE NOCASE` 오름차순
/// (`notes::note_summary` / `note_summaries_map` 과 동일).
/// W7-f: 아카이브 노트는 일부러 제외하지 않는다 — 유일한 소비처(folder_list 트리 하이드레이션)는
/// 애초에 아카이브 노트를 보여준 적이 없어 무해하다. 단, note_query.rs:134 주석대로 이 함수는
/// note_query 의 태그 하이드레이션에도 쓰이므로, 나중에 `include_archived=true` 축을 실제로
/// 소비하는 화면이 생기면 그 화면에서 아카이브 노트의 태그가 비어 보일 수 있다(휴지통 노트도
/// 이미 같은 제약).
pub fn note_tags_index(
    conn: &Connection,
    workspace_id: Option<String>,
) -> AppResult<HashMap<String, Vec<String>>> {
    let ws = match workspace_id {
        Some(w) => w,
        None => active_workspace_id(conn)?,
    };
    let mut tags_stmt = conn
        .prepare(
            "SELECT nt.note_id, t.name FROM note_tags nt
             JOIN tags t ON t.id = nt.tag_id
             JOIN notes n ON n.id = nt.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(dberr)?;
    let mut note_tags: HashMap<String, Vec<String>> = HashMap::new();
    let tags_rows = tags_stmt
        .query_map([&ws], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?;
    for row in tags_rows {
        let (note_id, tag_name) = row.map_err(dberr)?;
        note_tags.entry(note_id).or_default().push(tag_name);
    }
    Ok(note_tags)
}

pub fn create(
    conn: &mut Connection,
    name: &str,
    workspace_id: Option<String>,
    color_hue: Option<i64>,
    icon: Option<String>,
    rules: Option<String>,
) -> AppResult<Folder> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("folder name is empty".to_string()));
    }
    if let Some(h) = color_hue {
        if !(0..=359).contains(&h) {
            return Err(AppError::Validation(format!(
                "color_hue out of range (0..359): {h}"
            )));
        }
    }
    let icon = normalize_folder_icon(icon);
    let rules = normalize_folder_rules(rules)?;
    let ws = match workspace_id {
        Some(w) => w,
        None => active_workspace_id(conn)?,
    };
    let next_pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE workspace_id=?1",
            [&ws],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8)",
        params![id, ws, name, next_pos, now_iso(), color_hue, icon, rules],
    )
    .map_err(dberr)?;
    load_folder(conn, &id)
}

fn normalize_folder_icon(icon: Option<String>) -> Option<String> {
    icon.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

/// 동기화(beta) 모바일 POST /api/v1/notes 전용 — 데스크톱 stores/notes.ts::ensureInboxId 의 서버측
/// 대응(같은 규약: settings 키 `inbox_<workspace_id>`에 폴더 id 영속, 없거나 가리키는 폴더가 이미
/// 지워졌으면 "Inbox" 폴더를 새로 만들어 채운다). 데스크톱이 켜져 있는 동안 모바일에서 노트를
/// 만들 수 있어야 하므로 프론트 IPC 왕복 없이 같은 결과를 Rust 쪽에서 재현한다 — 새 코드 경로가
/// 아니라 같은 규약의 서버측 미러.
pub fn ensure_inbox_folder_id(conn: &mut Connection, workspace_id: &str) -> AppResult<String> {
    let settings = crate::repo::settings::get_all(conn)?;
    let key = format!("inbox_{workspace_id}");
    if let Some(id) = settings.get(&key).and_then(|v| v.as_str()) {
        let exists: bool = conn
            .query_row("SELECT 1 FROM folders WHERE id=?1", [id], |_| Ok(true))
            .optional()
            .map_err(dberr)?
            .unwrap_or(false);
        if exists {
            return Ok(id.to_string());
        }
    }
    let folder = create(conn, "Inbox", Some(workspace_id.to_string()), None, None, None)?;
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(key, serde_json::Value::String(folder.id.clone()));
    crate::repo::settings::set(conn, &entries)?;
    Ok(folder.id)
}

/// 이름으로 찾거나 없으면 만든다 — `ensure_inbox_folder_id`와 같은 자세지만 settings 키가 아니라
/// **정확한 이름 일치**로 찾는다(PLAN-2026-09-04-local-import §W7: 로컬 가져오기 1클릭 등록이
/// "수집 — AI 대화"/"수집 — 브라우징" 같은 평평한 고정 폴더를 재사용/생성하는 데 쓴다). 폴더에는
/// deleted_at이 없으므로(specs/db/schemas/folders.sql) 소프트 삭제 필터는 필요 없다 — 같은
/// 워크스페이스에 그 이름의 폴더가 있으면 그대로, 없으면 새로 만든다.
pub fn ensure_named_folder_id(conn: &mut Connection, workspace_id: &str, name: &str) -> AppResult<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM folders WHERE workspace_id=?1 AND name=?2 ORDER BY created_at LIMIT 1",
            params![workspace_id, name],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr)?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let folder = create(conn, name, Some(workspace_id.to_string()), None, None, None)?;
    // 새로 만드는 수집 폴더는 검색에서 기본 제외한다("수집 — AI 대화"/"수집 — 브라우징"이 하루치
    // 방문/프롬프트 노트를 계속 append하는 소음성 폴더라 일반 검색 결과를 채우면 소음이 된다) —
    // 기존 폴더(위 existing 분기)는 절대 건드리지 않는다: 사용자가 폴더 UI에서 직접 검색 포함으로
    // 되돌렸다면 이후 이 함수가 다시 찾아써도 그 선택을 존중해야 한다.
    set_exclusions(conn, &folder.id, true, false)?;
    Ok(folder.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', ?1)",
            params![now_iso()],
        )
        .unwrap();
        conn
    }

    #[test]
    fn ensure_named_folder_id_finds_by_exact_name_or_creates_it() {
        let mut conn = test_conn();
        let id1 = ensure_named_folder_id(&mut conn, "ws1", "수집 — AI 대화").unwrap();
        let (name, search_excluded): (String, i64) = conn
            .query_row("SELECT name, search_excluded FROM folders WHERE id=?1", [&id1], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(name, "수집 — AI 대화");
        assert_eq!(search_excluded, 1, "a newly created collect folder starts search-excluded");

        let id2 = ensure_named_folder_id(&mut conn, "ws1", "수집 — AI 대화").unwrap();
        assert_eq!(id1, id2, "an existing folder with the exact name must be reused, not duplicated");

        let id3 = ensure_named_folder_id(&mut conn, "ws1", "수집 — 브라우징").unwrap();
        assert_ne!(id1, id3, "a different name creates a different folder");
    }

    /// 사용자가 폴더 UI에서 검색 포함으로 되돌린 뒤(§search_excluded 기본값 결정), 같은 이름으로
    /// ensure_named_folder_id가 다시 호출돼도(예: 프리셋 재실행) 그 선택을 덮어쓰지 않는다.
    #[test]
    fn ensure_named_folder_id_does_not_re_exclude_a_folder_the_user_re_included_in_search() {
        let mut conn = test_conn();
        let id = ensure_named_folder_id(&mut conn, "ws1", "수집 — AI 대화").unwrap();
        set_exclusions(&mut conn, &id, false, false).unwrap();

        let id2 = ensure_named_folder_id(&mut conn, "ws1", "수집 — AI 대화").unwrap();
        assert_eq!(id, id2);
        let search_excluded: i64 =
            conn.query_row("SELECT search_excluded FROM folders WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(search_excluded, 0, "an existing folder found by name must not be re-excluded");
    }
}

pub fn rename(conn: &mut Connection, id: &str, name: &str) -> AppResult<Folder> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("folder name is empty".to_string()));
    }
    let n = conn
        .execute(
            "UPDATE folders SET name=?1, updated_at=?2 WHERE id=?3",
            params![name, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("folder not found: {id}")));
    }
    load_folder(conn, id)
}

pub fn set_open(conn: &mut Connection, id: &str, is_open: bool) -> AppResult<bool> {
    let n = conn
        .execute(
            "UPDATE folders SET is_open=?1, updated_at=?2 WHERE id=?3",
            params![is_open as i64, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("folder not found: {id}")));
    }
    Ok(true)
}

/// 폴더 아이콘 색상 설정 — `color_hue`가 `None`이면 리셋(커스텀 색상 제거).
/// `Some`이면 0..359 범위여야 한다(DB CHECK 와 동일 규칙을 커맨드 레이어에서도 검증해
/// DB 에러 대신 명확한 VALIDATION 을 반환).
pub fn set_color(conn: &mut Connection, id: &str, color_hue: Option<i64>) -> AppResult<Folder> {
    if let Some(h) = color_hue {
        if !(0..=359).contains(&h) {
            return Err(AppError::Validation(format!(
                "color_hue out of range (0..359): {h}"
            )));
        }
    }
    let n = conn
        .execute(
            "UPDATE folders SET color_hue=?1, updated_at=?2 WHERE id=?3",
            params![color_hue, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("folder not found: {id}")));
    }
    load_folder(conn, id)
}

pub const FOLDER_RULES_CAP: usize = 4096;

pub fn set_rules(conn: &mut Connection, id: &str, rules: Option<String>) -> AppResult<Folder> {
    let rules = normalize_folder_rules(rules)?;
    let n = conn
        .execute(
            "UPDATE folders SET rules=?1, updated_at=?2 WHERE id=?3",
            params![rules, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("folder not found: {id}")));
    }
    load_folder(conn, id)
}

pub fn set_exclusions(
    conn: &mut Connection,
    id: &str,
    search_excluded: bool,
    ai_excluded: bool,
) -> AppResult<Folder> {
    let n = conn
        .execute(
            "UPDATE folders SET search_excluded=?1, ai_excluded=?2, updated_at=?3 WHERE id=?4",
            params![search_excluded as i64, ai_excluded as i64, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("folder not found: {id}")));
    }
    load_folder(conn, id)
}

fn normalize_folder_rules(rules: Option<String>) -> AppResult<Option<String>> {
    let Some(raw) = rules else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > FOLDER_RULES_CAP {
        return Err(AppError::Validation(format!(
            "folder rules exceed {FOLDER_RULES_CAP} characters"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

pub fn set_icon(conn: &mut Connection, id: &str, icon: Option<String>) -> AppResult<Folder> {
    let icon = normalize_folder_icon(icon);
    let n = conn
        .execute(
            "UPDATE folders SET icon=?1, updated_at=?2 WHERE id=?3",
            params![icon, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("folder not found: {id}")));
    }
    load_folder(conn, id)
}

#[derive(Debug, Serialize)]
pub struct FolderFilesResult {
    pub notes: Vec<NoteFiles>,
    pub total_bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct NoteFiles {
    pub note_id: String,
    pub title: String,
    pub attachments: Vec<crate::models::Attachment>,
}

pub fn files(conn: &Connection, folder_id: &str) -> AppResult<FolderFilesResult> {
    // Trash: 휴지통 노트의 첨부는 폴더 파일 뷰(총 용량 집계 포함)에서 제외한다.
    let mut stmt = conn.prepare("SELECT id, title FROM notes WHERE folder_id=?1 AND deleted_at IS NULL ORDER BY year, created_at").map_err(dberr)?;
    let note_rows: Vec<(String, String)> = stmt
        .query_map([folder_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    // N+1 제거: 노트당 load_for_note 대신 폴더 전체 첨부를 한 번에 배치 로드한다.
    let note_ids: Vec<String> = note_rows.iter().map(|(id, _)| id.clone()).collect();
    let mut atts_map = crate::repo::attachments::load_for_ids(conn, &note_ids)?;

    let mut notes = Vec::new();
    let mut total_bytes = 0;
    for (note_id, title) in note_rows {
        let attachments = atts_map.remove(&note_id).unwrap_or_default();
        for a in &attachments {
            total_bytes += a.size_bytes.unwrap_or(0);
        }
        notes.push(NoteFiles {
            note_id,
            title,
            attachments,
        });
    }

    Ok(FolderFilesResult { notes, total_bytes })
}

pub fn delete(conn: &mut Connection, data_dir: &std::path::Path, folder_id: &str) -> AppResult<usize> {
    let mut stmt = conn.prepare("SELECT id FROM notes WHERE folder_id=?1").map_err(dberr)?;
    let note_ids: Vec<String> = stmt
        .query_map([folder_id], |r| r.get(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    let count = note_ids.len();
    for id in &note_ids {
        crate::repo::notes::purge(conn, data_dir, id)?;
    }
    conn.execute("DELETE FROM folders WHERE id=?1", [folder_id]).map_err(dberr)?;
    Ok(count)
}
