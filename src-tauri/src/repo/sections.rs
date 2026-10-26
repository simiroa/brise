// repo: sections (에디터 탭) — commands/sections.yaml
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::Section;
use crate::repo::fts;
use crate::util::{new_id, now_iso};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::collections::HashMap;

pub fn load_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<Section>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, body_md, position, kind, ai_origin, updated_at FROM sections
             WHERE note_id = ?1 ORDER BY position",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([note_id], |r| {
            Ok(Section {
                id: r.get(0)?,
                name: r.get(1)?,
                body_md: r.get(2)?,
                position: r.get(3)?,
                kind: r.get(4)?,
                ai_origin: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

/// N+1 배치 헬퍼 — 여러 note_id 의 섹션을 단일 쿼리로 조회해 HashMap(note_id -> Vec<Section>)
/// 으로 반환한다(`repo/vector.rs::prepare_reindex`/`status` 가 노트마다 `load_for_note` 를
/// 반복 호출하던 것을 배치로 대체하기 위한 용도). ORDER BY position 은 전역 정렬 기준이지만,
/// 같은 note_id 로 그룹핑해 push 하면 각 노트 내부의 상대 순서는 여전히 position 오름차순이
/// 된다 — 단수형 `load_for_note` 의 ORDER BY 와 동일한 결과. note_id 가 없으면(섹션이 0개인
/// 노트) 맵에 키가 생기지 않는다 — 호출부는 `.unwrap_or_default()` 로 빈 Vec 을 취급한다.
pub fn load_for_ids(conn: &Connection, note_ids: &[String]) -> AppResult<HashMap<String, Vec<Section>>> {
    let mut out: HashMap<String, Vec<Section>> = HashMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    // Scale: SQLite 변수 상한을 넘기지 않도록 청크로 나눠 조회한다(note_summaries_map 과 동일 이유).
    // 각 노트는 한 청크 안에 온전히 들어가므로 note 별 position 순서가 그대로 보존된다.
    for chunk in note_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, note_id, name, body_md, position, kind, ai_origin, updated_at FROM sections
             WHERE note_id IN ({placeholders}) ORDER BY position"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let binds: Vec<Value> = chunk.iter().map(|s| Value::Text(s.clone())).collect();
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    Section {
                        id: r.get(0)?,
                        name: r.get(2)?,
                        body_md: r.get(3)?,
                        position: r.get(4)?,
                        kind: r.get(5)?,
                        ai_origin: r.get(6)?,
                        updated_at: r.get(7)?,
                    },
                ))
            })
            .map_err(dberr)?;
        for row in rows {
            let (note_id, section) = row.map_err(dberr)?;
            out.entry(note_id).or_default().push(section);
        }
    }
    Ok(out)
}

/// pub: 커맨드 계층이 변경 통지(crate::events)에 실을 note_id 를 알아내는 데도 쓴다 —
/// section_update/section_delete 는 섹션 id 만 받기 때문(인덱스 조회 1회, 무시할 비용).
pub fn note_id_of(conn: &Connection, section_id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT note_id FROM sections WHERE id=?1",
        [section_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(dberr)?
    .ok_or_else(|| AppError::NotFound(format!("section not found: {section_id}")))
}

/// 섹션 본문 쓰기의 **단일 지점** — 편집기 자동 저장(`update_checked`)뿐 아니라 수집 append·수집
/// 요약·동기화 수렴 병합(daynote)·AI UpdateNote·스냅샷 복원이 전부 여기를 지난다
/// (docs/PLAN-2026-10-06-d2-expected-updated-at.md §0 V1). 그래서 버전 토큰의 단조성과 휴지통
/// 노트 거부가 경로마다 흩어지지 않는다. 노트 `updated_at` 도 올린다. FTS 는 호출자 몫이다 —
/// 여러 섹션을 한 트랜잭션에 쓰는 호출자(스냅샷 복원)가 노트당 한 번만 색인하도록.
/// 반환값은 이 섹션에 새로 찍힌 버전 토큰(`sections.updated_at`).
pub(crate) fn write_body_tx(
    tx: &rusqlite::Transaction,
    note_id: &str,
    section_id: &str,
    body_md: &str,
    now: &str,
) -> AppResult<String> {
    let (_, token) = begin_section_write(tx, section_id, None, true, now)?;
    set_body_tx(tx, section_id, body_md, &token)?;
    touch_note_tx(tx, note_id, now)?;
    Ok(token)
}

/// 섹션 쓰기 직전 판정 — 섹션이 없으면 NOT_FOUND, `reject_trashed` 이고 노트가 휴지통이면
/// NOT_FOUND(쓴 쪽이 삭제 사실을 모른 채 지워진 노트에 쓰는 것 — 드릴 3 d), `expected` 가 현재
/// 토큰과 다르면 CONFLICT. 통과하면 (note_id, 새 토큰)을 준다.
fn begin_section_write(
    tx: &rusqlite::Transaction,
    section_id: &str,
    expected: Option<&str>,
    reject_trashed: bool,
    now: &str,
) -> AppResult<(String, String)> {
    // updated_at 은 NULL 일 수 있다(V24 이전에 만들어져 백필을 못 받은 행·raw INSERT) — 토큰이 없는
    // 섹션은 어떤 expected 와도 맞지 않고, 새 토큰은 now 가 된다.
    let (note_id, prev, trashed): (String, Option<String>, bool) = tx
        .query_row(
            "SELECT s.note_id, s.updated_at, n.deleted_at IS NOT NULL
             FROM sections s JOIN notes n ON n.id = s.note_id WHERE s.id=?1",
            [section_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("section not found: {section_id}")))?;
    if trashed && reject_trashed {
        return Err(AppError::NotFound(format!("note is in trash: {note_id}")));
    }
    if let Some(e) = expected {
        if Some(e) != prev.as_deref() {
            return Err(AppError::Conflict(format!(
                "section changed since read: {section_id} (expected {e}, current {})",
                prev.as_deref().unwrap_or("none")
            )));
        }
    }
    Ok((note_id, next_token(prev.as_deref().unwrap_or(""), now)))
}

/// 버전 토큰은 단조 증가한다 — `max(now, prev + 1ms)`. 같은 밀리초의 두 쓰기, 시계 역행, 동기화로
/// 들어온 미래 시각 모두에서 새 토큰이 이전과 달라야 낡은 `expected` 가 우연히 맞지 않는다.
/// prev 를 못 읽으면(구형 형식) now. ponytail: 정수 rev 가 필요해지면 계획서 §2 안 C.
fn next_token(prev: &str, now: &str) -> String {
    use chrono::{DateTime, Duration, SecondsFormat, Utc};
    let parse = |v: &str| DateTime::parse_from_rfc3339(v).ok().map(|d| d.with_timezone(&Utc));
    match (parse(prev), parse(now)) {
        (Some(p), Some(n)) if n <= p => {
            (p + Duration::milliseconds(1)).to_rfc3339_opts(SecondsFormat::Millis, true)
        }
        _ => now.to_string(),
    }
}

fn set_body_tx(tx: &rusqlite::Transaction, section_id: &str, body_md: &str, token: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE sections SET body_md=?1, updated_at=?2 WHERE id=?3",
        params![body_md, token, section_id],
    )
    .map_err(dberr)?;
    Ok(())
}

fn touch_note_tx(tx: &rusqlite::Transaction, note_id: &str, now: &str) -> AppResult<()> {
    tx.execute("UPDATE notes SET updated_at=?1 WHERE id=?2", params![now, note_id])
        .map_err(dberr)?;
    Ok(())
}

pub fn create(conn: &mut Connection, note_id: &str, name: Option<String>) -> AppResult<Section> {
    create_internal(conn, note_id, name, String::new(), None, None)
}

/// section_create와 동일한 절차이나 body_md를 빈 문자열이 아니라 주어진 값으로 채운다.
/// AI 드롭다운("에디터 내용 정리" · "프롬프트 박스")의 결과가 새 탭에 곧바로 채워진 채로
/// 만들어지도록 하는 용도 — 그 두 커맨드는 절대 기존 섹션을 덮어쓰지 않는다는 불변식을
/// 지키므로, 결과는 항상 이 경로로 새 섹션이 되어야 한다(commands/sections.yaml 참고).
/// ai_origin은 항상 None(호출부가 전부 AI 산출물이 아닌 테스트/시스템 경로이거나, 명시적으로
/// provenance를 남기고 싶으면 create_with_body_and_kind_and_origin을 쓴다).
pub fn create_with_body(
    conn: &mut Connection,
    note_id: &str,
    name: Option<String>,
    body_md: String,
) -> AppResult<Section> {
    create_internal(conn, note_id, name, body_md, None, None)
}

/// create_with_body + explicit `kind` — 다이어그램/시트 섹션 생성 경로. kind=None은
/// create_with_body와 완전히 동일(기본 'text'). ai_origin은 항상 None — 기존 호출부(시트/
/// 다이어그램 repo 테스트 등)를 건드리지 않기 위해 시그니처를 그대로 둔다. provenance가
/// 필요한 유일한 실사용 호출부(commands::sections::section_create_with_body)는
/// create_with_body_and_kind_and_origin을 쓴다.
pub fn create_with_body_and_kind(
    conn: &mut Connection,
    note_id: &str,
    name: Option<String>,
    body_md: String,
    kind: Option<String>,
) -> AppResult<Section> {
    create_internal(conn, note_id, name, body_md, kind, None)
}

/// create_with_body_and_kind + explicit `ai_origin` — W5 섹션 provenance
/// (docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W5, specs/commands/sections.yaml
/// section_create_with_body). commands::sections::section_create_with_body의 유일한 호출부:
/// lib/aiSectionBridge.ts::insertAiSection이 넘긴 액션 id가 여기로 흘러 INSERT에 실린다.
pub fn create_with_body_and_kind_and_origin(
    conn: &mut Connection,
    note_id: &str,
    name: Option<String>,
    body_md: String,
    kind: Option<String>,
    ai_origin: Option<String>,
) -> AppResult<Section> {
    create_internal(conn, note_id, name, body_md, kind, ai_origin)
}

/// 허용된 section kind인지 검증 — DB의 CHECK 제약(방어선)보다 먼저, AppError::Validation으로
/// 거부한다(db/migrations.rs V26_SQL/V57_SQL 주석 참고).
fn validate_kind(kind: &str) -> AppResult<()> {
    match kind {
        "text" | "diagram" | "sheet" => Ok(()),
        other => Err(AppError::Validation(format!(
            "invalid section kind: {other} (must be 'text', 'diagram' or 'sheet')"
        ))),
    }
}

fn create_internal(
    conn: &mut Connection,
    note_id: &str,
    name: Option<String>,
    body_md: String,
    kind: Option<String>,
    ai_origin: Option<String>,
) -> AppResult<Section> {
    let kind = kind.unwrap_or_else(|| "text".to_string());
    validate_kind(&kind)?;
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sections WHERE note_id=?1",
            [note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("Section {}", count + 1));
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM sections WHERE note_id=?1",
            [note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let id = new_id();
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT INTO sections(id, note_id, name, body_md, position, updated_at, kind, ai_origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, note_id, name, body_md, pos, now, kind, ai_origin],
    )
    .map_err(dberr)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now, note_id],
    )
    .map_err(dberr)?;
    fts::fts_upsert(&tx, note_id)?;
    tx.commit().map_err(dberr)?;

    Ok(Section {
        id,
        name,
        body_md,
        position: pos,
        kind,
        ai_origin,
        updated_at: Some(now),
    })
}

/// 본문/이름 부분 업데이트. notes.updated_at 전파 + FTS upsert. 반환: 갱신 시각.
///
/// `ai_origin` 은 **이중 Option**으로 "건드리지 않음"과 "NULL로 지움"을 구분한다
/// (specs/commands/sections.yaml section_update notes 의 세 갈래 계약 — SSOT):
///   - `None`             → ai_origin 컬럼을 아예 UPDATE하지 않는다(보존). sheet_set_cells와
///                          checklist/board todo_toggle 등 이 함수를 재사용하는 다른 모든
///                          호출부가 여기 해당 — 그 쓰기들은 "누가 이 섹션을 저작했는가"를
///                          판정하는 자리가 아니다.
///   - `Some(None)`        → NULL로 지운다 (사용자가 본문을 손댔다 = 이제 사용자 글이다).
///   - `Some(Some(id))`    → 그 액션 id로 세팅한다 (AI가 기존 섹션을 다시 쓰는 경로).
/// commands::sections::section_update만 이 세 갈래를 실제로 계산한다(body_md 유무로 분기) —
/// 다른 호출부는 전부 `None`을 넘겨 기존 동작(보존)을 유지한다.
pub fn update(
    conn: &mut Connection,
    id: &str,
    name: Option<String>,
    body_md: Option<String>,
    ai_origin: Option<Option<String>>,
) -> AppResult<String> {
    update_checked(conn, id, name, body_md, ai_origin, None).map(|w| w.updated_at)
}

/// `update` 의 결과 — `updated_at` 은 **노트** 시각(기존 계약), `section_updated_at` 은 이 섹션의
/// 새 버전 토큰(D2②). 둘을 섞지 않으려고 이름을 나눴다: 노트 시각은 태그·상태 쓰기에도 오르므로
/// 토큰으로 쓰면 거짓 충돌이 난다.
///
/// `changed` = 이 쓰기가 행을 실제로 바꿨는가. 무변경 쓰기(`update_checked` 의 무변경 판정)는 아무것도
/// 쓰지 않고 현재 시각·토큰을 그대로 돌려주며 false — 커맨드 계층은 이걸 보고 변경 이벤트를 내지 않는다.
#[derive(Debug, Clone)]
pub struct SectionWrite {
    pub updated_at: String,
    pub section_updated_at: String,
    pub changed: bool,
}

/// `section_update` 의 본체. `expected` 가 있으면 현재 섹션 토큰과 같을 때만 쓴다(낙관적 동시성,
/// docs/PLAN-2026-10-06-d2-expected-updated-at.md) — 판정과 쓰기가 한 트랜잭션이라 사이 틈이 없다.
/// `expected` 생략은 기존 동작(마지막 쓰기 승리). 생략 호출 관찰 기록은 커맨드 계층
/// (`commands::sections::observe_untokened_body_write`) — 이 함수는 토큰과 무관한 내부 호출자
/// (`update` 경유 시트 셀·할 일 토글)도 쓰므로 여기서 세면 그들까지 섞인다.
pub fn update_checked(
    conn: &mut Connection,
    id: &str,
    name: Option<String>,
    body_md: Option<String>,
    ai_origin: Option<Option<String>>,
    expected: Option<&str>,
) -> AppResult<SectionWrite> {
    let now = now_iso();
    // IMMEDIATE — 첫 문장이 판정용 SELECT 라, 지연 트랜잭션이면 그 사이 다른 연결(수집)이 커밋했을 때
    // 쓰기 승격이 SQLITE_BUSY_SNAPSHOT 으로 실패한다(busy_timeout 이 재시도하지 않음).
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(dberr)?;
    // 휴지통 거부는 토큰을 보낸 쓰기에만(단계 1) — 토큰 없는 구 클라이언트의 자동 저장은 예전처럼
    // 휴지통 안으로 들어간다(복구 시 살아남, 드릴 3 d). 충돌 UI(W3) 없이 거부하면 데스크톱은 700ms
    // 마다 토스트, 폰은 강제 나가기 때 본문 유실이 된다.
    //
    // 무변경 쓰기: 이 쓰기가 행의 어떤 값도 바꾸지 않으면(본문이 저장값과 같고, 이름·ai_origin 도 안 바뀌면)
    // 아무것도 쓰지 않고 현재 시각·토큰을 돌려준다 — 노트 수정 시각·활동 기록 '편집'·FTS·섹션 토큰이 그대로다.
    // 두 경우를 한 판정이 덮는다:
    //  - 감사 M-8 자기 충돌: 응답만 잃은 이전 저장이 이미 커밋돼 토큰이 어긋났더라도 같은 본문이면 이미 반영된
    //    쓰기다. 예전 판정은 ai_origin 패치가 None 일 때만이었는데, section_update 는 본문이 있으면 늘
    //    Some(..)(사용자 편집 = 출처 지움)을 넘기므로 편집기 저장에서는 한 번도 발동하지 않았다.
    //  - 2026-10-18 가짜 편집: 손대지 않은 섹션의 재저장이 편집으로 기록되고 노트를 목록 맨 위로 올렸다.
    //    토큰을 올리지도 않는다 — 내용 없이 오른 토큰은 다른 기기에 거짓 충돌을 만든다.
    // 토큰을 보낸 휴지통 노트 쓰기는 여기서 빠져 아래 begin_section_write 가 그대로 거부한다. 토큰이 없는 구형 행
    // (updated_at NULL)도 빠진다 — 돌려줄 토큰이 없으니 예전처럼 써서 토큰을 받는다.
    let mut stored_body: Option<String> = None;
    if let Some(b) = body_md.as_deref() {
        let row: Option<(Option<String>, String, String, Option<String>, String, bool)> = tx
            .query_row(
                "SELECT s.updated_at, s.body_md, s.name, s.ai_origin, n.updated_at, n.deleted_at IS NOT NULL
                 FROM sections s JOIN notes n ON n.id = s.note_id WHERE s.id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .map_err(dberr)?;
        if let Some((cur, stored, stored_name, stored_origin, note_updated, trashed)) = row {
            let unchanged = stored == b
                && name.as_ref().is_none_or(|n| *n == stored_name)
                && ai_origin.as_ref().is_none_or(|o| *o == stored_origin);
            if let (true, Some(cur), false) = (unchanged, cur, trashed && expected.is_some()) {
                return Ok(SectionWrite { updated_at: note_updated, section_updated_at: cur, changed: false });
            }
            stored_body = Some(stored);
        }
    }
    // 활동 단위는 본문이 실제로 바뀐 쓰기(디바운스된 section_update)다 — 같은 본문에 이름·출처만 바뀌면 편집이 아니다.
    let body_changed = body_md.is_some() && body_md != stored_body;
    let (note_id, token) = begin_section_write(&tx, id, expected, expected.is_some(), &now)?;
    if let Some(n) = name {
        tx.execute(
            "UPDATE sections SET name=?1, updated_at=?2 WHERE id=?3",
            params![n, token, id],
        )
        .map_err(dberr)?;
    }
    if let Some(b) = body_md {
        set_body_tx(&tx, id, &b, &token)?;
    }
    if let Some(origin) = ai_origin {
        tx.execute(
            "UPDATE sections SET ai_origin=?1 WHERE id=?2",
            params![origin, id],
        )
        .map_err(dberr)?;
    }
    touch_note_tx(&tx, &note_id, &now)?;
    fts::fts_upsert(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    // QA8 Wave 4A — body edit unit is the debounced section_update (frontend 700ms autosave),
    // not every keystroke. Title-only renames skip this arm. Best-effort.
    if body_changed {
        let title = crate::repo::activity::note_title(conn, &note_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| note_id.clone());
        crate::repo::activity::record_for_note(
            conn,
            &note_id,
            crate::repo::activity::KIND_EDIT,
            &title,
            None,
        );
    }
    Ok(SectionWrite { updated_at: now, section_updated_at: token, changed: true })
}

/// 섹션 삭제 — 노트의 유일한 섹션이면 CONFLICT. 하드 삭제가 아니라 **휴지통 경유**다
/// (docs/PLAN-2026-09-10-section-dnd-trash.md D4): 같은 트랜잭션에서 행을 `section_trash` 로
/// 옮긴 뒤 `sections` 에서 지운다. 계약(입력·출력·CONFLICT)은 그대로다.
///
/// tombstone 은 **그대로 찍는다** — 동기화 상대에게는 이 섹션이 사라진 게 맞다(복구는 상대편에
/// 재생성으로 보인다). `restore` 가 그 tombstone 을 지운다.
pub fn delete(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let note_id = note_id_of(conn, id)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sections WHERE note_id=?1",
            [&note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    if count <= 1 {
        return Err(AppError::Conflict(
            "cannot delete the only section of a note".to_string(),
        ));
    }
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT OR REPLACE INTO section_trash(id, note_id, name, body_md, kind, position, ai_origin, deleted_at)
         SELECT id, note_id, name, body_md, kind, position, ai_origin, ?1 FROM sections WHERE id=?2",
        params![now, id],
    )
    .map_err(dberr)?;
    tx.execute("DELETE FROM sections WHERE id=?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "sections", id)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now, note_id],
    )
    .map_err(dberr)?;
    fts::fts_upsert(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

/// 휴지통 섹션 하나 — `section_trash JOIN notes`. `note_deleted` 는 원 노트가 휴지통에 있는지
/// (그러면 복구가 CONFLICT 라 UI 가 버튼을 비활성화하고 이유를 보여준다).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SectionTrashEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub note_id: String,
    pub note_title: String,
    pub note_deleted: bool,
    pub deleted_at: String,
}

/// 휴지통에서 복구 — 같은 id 로 `sections` 에 되돌린다. position 은 그 노트 MAX+1(맨 뒤,
/// `create_internal`·`move_to_note` 와 같은 규칙), updated_at 은 지금.
///
/// 원 노트가 없거나 휴지통이면 CONFLICT — 노트를 먼저 복구해야 한다. (원 노트 완전 삭제는 FK
/// CASCADE 로 휴지통 행까지 지우므로 "노트가 없다"는 사실상 NOT_FOUND 와 같은 자리에 온다.)
///
/// tombstone 을 지우는 이유: `delete` 가 `deleted_rows(sections, id)` 를 찍어 두었는데 같은 id 로
/// 행이 되살아나므로, 그대로 두면 "살아 있는 행에 삭제 묘비가 붙어 있는" 상태가 남는다. 지금
/// 당장 이걸 읽는 코드는 없지만(§6 판정: `transfer/import/hash_merge.rs` 는 `deleted_rows` 를
/// 조회하지 않는다 — 노트 콘텐츠 해시로 섹션을 통째로 교체할 뿐이고, 저장소 전체에 deleted_rows
/// 를 SELECT 하는 곳이 없다. docs/SYNC.md Phase 0 G2 는 쓰기만 갖춰 둔 단계다), Phase 2 동기화가
/// 이 표를 읽기 시작하면 복구한 섹션을 상대가 다시 죽인다. 한 줄로 막는다.
pub fn restore(conn: &mut Connection, id: &str) -> AppResult<bool> {
    // 노트가 아예 없는 경우도 같은 컬럼으로 받는다 — LEFT JOIN 이라 `n.deleted_at IS NOT NULL`
    // 만 보면 없는 노트가 "살아 있음"(0)으로 읽힌다.
    let (note_id, note_unusable): (String, bool) = conn
        .query_row(
            "SELECT t.note_id, (n.id IS NULL OR n.deleted_at IS NOT NULL)
             FROM section_trash t LEFT JOIN notes n ON n.id = t.note_id WHERE t.id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("section not in trash: {id}")))?;
    if note_unusable {
        return Err(AppError::Conflict(
            "cannot restore a section whose note is in the trash".to_string(),
        ));
    }
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM sections WHERE note_id=?1",
            [&note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT INTO sections(id, note_id, name, body_md, position, updated_at, kind, ai_origin)
         SELECT id, note_id, name, body_md, ?1, ?2, kind, ai_origin FROM section_trash WHERE id=?3",
        params![pos, now, id],
    )
    .map_err(dberr)?;
    tx.execute("DELETE FROM section_trash WHERE id=?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::remove_tombstone(&tx, "sections", id)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now, note_id],
    )
    .map_err(dberr)?;
    fts::fts_upsert(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

/// 완전 삭제 — 휴지통 행만 지운다. 섹션엔 딸린 파일이 없다(본문 이미지 첨부는 `attachments`
/// 소유이고 노트에 매달려 있다 — move_to_note 의 ponytail 주석과 같은 이유).
pub fn purge(conn: &Connection, id: &str) -> AppResult<bool> {
    let n = conn
        .execute("DELETE FROM section_trash WHERE id=?1", [id])
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("section not in trash: {id}")));
    }
    Ok(true)
}

/// 휴지통 목록 — 노트북(workspace) 소속, deleted_at desc. notes::trash_list 와 같은 관문
/// (workspace_id 생략 시 활성 노트북).
pub fn trash_list(
    conn: &Connection,
    workspace_id: Option<String>,
) -> AppResult<Vec<SectionTrashEntry>> {
    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.kind, t.note_id, n.title, n.deleted_at IS NOT NULL, t.deleted_at
             FROM section_trash t
             JOIN notes n ON n.id = t.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1
             ORDER BY t.deleted_at DESC",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([&ws], |r| {
            Ok(SectionTrashEntry {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                note_id: r.get(3)?,
                note_title: r.get(4)?,
                note_deleted: r.get(5)?,
                deleted_at: r.get(6)?,
            })
        })
        .map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

/// 섹션을 다른 노트로 이동 — specs/commands/sections.yaml section_move,
/// docs/PLAN-2026-09-10-section-dnd-trash.md D2.
///
/// `delete` 와 **같은 규칙**으로 원 노트의 유일한 섹션은 거부한다(CONFLICT) — 빈 노트를 만들지
/// 않는다. 같은 노트로의 이동은 no-op ok(드래그가 제자리에 떨어진 경우).
///
/// tombstone 은 찍지 않는다: 삭제가 아니라 이동이라 행이 살아 있고, 동기화는 sections.updated_at
/// 갱신으로 전파된다.
///
/// 원 노트의 position 은 압축하지 않는다 — `reorder` 가 호출될 때마다 0..n-1 로 전부 다시 매기고
/// (id 집합만 검증한다), `load_for_note` 는 ORDER BY position, `create_internal` 은 MAX+1 이라
/// 구멍이 어디에도 영향을 주지 않는다.
///
/// ponytail: 본문 이미지 첨부는 옮기지 않는다. 첨부 파일은 `attachments/{note_id}/` 아래이고 본문
/// `src` 는 원 노트 id 를 포함한 attachments 기준 상대경로라 **이동 후에도 그대로 그려진다.**
/// 천장: 원 노트를 완전 삭제하면 그 폴더가 지워져 옮긴 섹션의 이미지가 깨진다. 업그레이드 경로:
/// 여기서 body_md 의 `attachments/{src}/` 참조를 긁어 해당 `attachments` 행과 파일을 대상 노트로
/// 옮긴다(repo/attachments 의 note dir 규약 그대로). 오너가 실기에서 이 경우를 만나면 그때.
pub fn move_to_note(conn: &mut Connection, id: &str, target_note_id: &str) -> AppResult<bool> {
    let source_note_id = note_id_of(conn, id)?;
    if source_note_id == target_note_id {
        return Ok(true); // 제자리 드롭 — no-op.
    }
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sections WHERE note_id=?1",
            [&source_note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    if count <= 1 {
        return Err(AppError::Conflict(
            "cannot move the only section of a note".to_string(),
        ));
    }
    let target_alive: bool = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL",
            [target_note_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !target_alive {
        return Err(AppError::NotFound(format!(
            "note not found: {target_note_id}"
        )));
    }
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM sections WHERE note_id=?1",
            [target_note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "UPDATE sections SET note_id=?1, position=?2, updated_at=?3 WHERE id=?4",
        params![target_note_id, pos, now, id],
    )
    .map_err(dberr)?;
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id IN (?2, ?3)",
        params![now, source_note_id, target_note_id],
    )
    .map_err(dberr)?;
    fts::fts_upsert(&tx, &source_note_id)?;
    fts::fts_upsert(&tx, target_note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

pub fn reorder(conn: &mut Connection, note_id: &str, ordered_ids: &[String]) -> AppResult<bool> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    // ordered_ids 가 해당 노트 섹션 집합과 정확히 일치하는지 검증.
    let current: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM sections WHERE note_id=?1")
            .map_err(dberr)?;
        let rows: Vec<String> = stmt
            .query_map([note_id], |r| r.get::<_, String>(0))
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        rows
    };
    let mut a = current.clone();
    a.sort();
    let mut b = ordered_ids.to_vec();
    b.sort();
    if a != b {
        return Err(AppError::Validation(
            "ordered_ids does not match note sections".to_string(),
        ));
    }
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    for (pos, sid) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE sections SET position=?1, updated_at=?2 WHERE id=?3 AND note_id=?4",
            params![pos as i64, now, sid, note_id],
        )
        .map_err(dberr)?;
    }
    tx.commit().map_err(dberr)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup_db() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('note1', ?1, 'title', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        (conn, "note1".to_string())
    }

    /// setup_db 와 같은 폴더에 노트를 하나 더 — section_move 는 노트 둘이 있어야 의미가 있다.
    fn insert_note(conn: &Connection, id: &str) -> String {
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES (?1, ?2, ?1, 1000, ?3, ?3)",
            params![id, folder_id, now_iso()],
        )
        .unwrap();
        id.to_string()
    }

    fn note_updated_at(conn: &Connection, note_id: &str) -> String {
        conn.query_row("SELECT updated_at FROM notes WHERE id=?1", [note_id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn fts_body(conn: &Connection, note_id: &str) -> String {
        conn.query_row(
            "SELECT body FROM notes_fts WHERE note_id=?1",
            [note_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn move_rejects_the_only_section_like_delete_does() {
        let (mut conn, note_id) = setup_db();
        let target = insert_note(&conn, "note2");
        let sec = create(&mut conn, &note_id, None).unwrap();

        let err = move_to_note(&mut conn, &sec.id, &target);
        assert!(matches!(err, Err(AppError::Conflict(_))), "got {err:?}");
        assert_eq!(note_id_of(&conn, &sec.id).unwrap(), note_id);
    }

    #[test]
    fn move_to_trashed_note_is_not_found() {
        let (mut conn, note_id) = setup_db();
        let target = insert_note(&conn, "note2");
        conn.execute(
            "UPDATE notes SET deleted_at=?1 WHERE id=?2",
            params![now_iso(), target],
        )
        .unwrap();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();

        let err = move_to_note(&mut conn, &sec.id, &target);
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
        assert_eq!(note_id_of(&conn, &sec.id).unwrap(), note_id);
    }

    #[test]
    fn move_to_missing_note_is_not_found() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();

        let err = move_to_note(&mut conn, &sec.id, "nope");
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn move_lands_at_target_max_position_plus_one() {
        let (mut conn, note_id) = setup_db();
        let target = insert_note(&conn, "note2");
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();
        // 대상 노트에 이미 두 개 — 옮긴 섹션은 그 뒤(position 2)여야 한다.
        create(&mut conn, &target, None).unwrap();
        let last = create(&mut conn, &target, None).unwrap();
        assert_eq!(last.position, 1);

        move_to_note(&mut conn, &sec.id, &target).unwrap();

        let moved = load_for_note(&conn, &target).unwrap();
        assert_eq!(moved.len(), 3);
        assert_eq!(moved.last().unwrap().id, sec.id);
        assert_eq!(moved.last().unwrap().position, 2);
        assert_eq!(load_for_note(&conn, &note_id).unwrap().len(), 1);
    }

    #[test]
    fn move_touches_updated_at_on_both_notes_and_reindexes_both() {
        let (mut conn, note_id) = setup_db();
        let target = insert_note(&conn, "note2");
        create(&mut conn, &note_id, None).unwrap();
        let sec = create_with_body(
            &mut conn,
            &note_id,
            None,
            "옮겨질본문마커".to_string(),
        )
        .unwrap();
        create(&mut conn, &target, None).unwrap();

        // 두 노트 모두 과거 시각으로 되돌려 놓고 이동이 실제로 갱신하는지 본다.
        conn.execute("UPDATE notes SET updated_at='2000-01-01T00:00:00Z'", [])
            .unwrap();
        assert!(fts_body(&conn, &note_id).contains("옮겨질본문마커"));

        move_to_note(&mut conn, &sec.id, &target).unwrap();

        assert_ne!(note_updated_at(&conn, &note_id), "2000-01-01T00:00:00Z");
        assert_ne!(note_updated_at(&conn, &target), "2000-01-01T00:00:00Z");
        // FTS: 원 노트에서 빠지고 대상 노트로 들어간다.
        assert!(!fts_body(&conn, &note_id).contains("옮겨질본문마커"));
        assert!(fts_body(&conn, &target).contains("옮겨질본문마커"));
    }

    #[test]
    fn move_to_same_note_is_a_no_op_ok() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();
        let before = load_for_note(&conn, &note_id).unwrap();

        assert!(move_to_note(&mut conn, &sec.id, &note_id).unwrap());
        assert_eq!(load_for_note(&conn, &note_id).unwrap(), before);
    }

    /// 유일 섹션 가드가 CONFLICT 를 내는 것은 `delete` 와 **같은 규칙**이라서다 — 두 경로가
    /// 같은 상황에 같은 답을 내는지 한 테스트로 못박는다(둘째 구현 방지).
    #[test]
    fn move_and_delete_agree_on_the_only_section_rule() {
        let (mut conn, note_id) = setup_db();
        let target = insert_note(&conn, "note2");
        let sec = create(&mut conn, &note_id, None).unwrap();

        assert!(matches!(
            delete(&mut conn, &sec.id),
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            move_to_note(&mut conn, &sec.id, &target),
            Err(AppError::Conflict(_))
        ));
    }

    // ── 섹션 휴지통 (D4) ──────────────────────────────────────────────────────

    fn workspace_of(conn: &Connection) -> String {
        conn.query_row("SELECT workspace_id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap()
    }

    fn tombstones(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM deleted_rows WHERE tbl='sections' AND id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 삭제 → 목록 → 복구 왕복. 이름·본문·kind 가 보존되고 복구 위치는 맨 뒤(MAX+1)다.
    #[test]
    fn delete_lists_in_trash_and_restore_puts_it_back_at_the_end() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create_with_body_and_kind(
            &mut conn,
            &note_id,
            Some("가계부".to_string()),
            r#"{"v":1,"rows":100,"cols":[],"cells":{}}"#.to_string(),
            Some("sheet".to_string()),
        )
        .unwrap();
        create(&mut conn, &note_id, None).unwrap(); // 뒤에 하나 더 — 복구가 정말 맨 뒤인지 보려고.

        delete(&mut conn, &sec.id).unwrap();
        assert!(load_for_note(&conn, &note_id)
            .unwrap()
            .iter()
            .all(|s| s.id != sec.id));

        let listed = trash_list(&conn, Some(workspace_of(&conn))).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, sec.id);
        assert_eq!(listed[0].name, "가계부");
        assert_eq!(listed[0].kind, "sheet");
        assert_eq!(listed[0].note_id, note_id);
        assert_eq!(listed[0].note_title, "title");
        assert!(!listed[0].note_deleted);

        restore(&mut conn, &sec.id).unwrap();
        let back = load_for_note(&conn, &note_id).unwrap();
        assert_eq!(back.len(), 3);
        let last = back.last().unwrap();
        assert_eq!(last.id, sec.id);
        // 남은 두 섹션은 0·2 다(삭제가 position 을 압축하지 않는다 — move_to_note 주석과 같은
        // 이유) 이므로 맨 뒤는 MAX+1 = 3.
        assert_eq!(last.position, 3, "맨 뒤(MAX+1)");
        assert_eq!(last.name, "가계부");
        assert_eq!(last.body_md, sec.body_md);
        assert_eq!(last.kind, "sheet");
        assert!(trash_list(&conn, Some(workspace_of(&conn))).unwrap().is_empty());
    }

    /// 원 노트가 휴지통이면 복구는 CONFLICT — 노트를 먼저 복구해야 한다.
    #[test]
    fn restore_conflicts_while_the_note_is_in_the_trash() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();
        delete(&mut conn, &sec.id).unwrap();
        conn.execute(
            "UPDATE notes SET deleted_at=?1 WHERE id=?2",
            params![now_iso(), note_id],
        )
        .unwrap();

        let err = restore(&mut conn, &sec.id);
        assert!(matches!(err, Err(AppError::Conflict(_))), "got {err:?}");
        // 목록에는 남아 있고 이유가 실려 온다.
        let listed = trash_list(&conn, Some(workspace_of(&conn))).unwrap();
        assert!(listed[0].note_deleted);

        // 노트를 복구하면 섹션도 복구된다.
        conn.execute("UPDATE notes SET deleted_at=NULL WHERE id=?1", [&note_id])
            .unwrap();
        restore(&mut conn, &sec.id).unwrap();
        assert_eq!(load_for_note(&conn, &note_id).unwrap().len(), 2);
    }

    /// 노트를 완전 삭제하면 그 노트의 휴지통 섹션도 FK CASCADE 로 사라진다.
    #[test]
    fn note_purge_cascades_into_section_trash() {
        let (mut conn, note_id) = setup_db();
        // CASCADE 는 foreign_keys pragma 가 켜져 있어야 발동한다(프로덕션은 db::bootstrap 이 켠다).
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();
        delete(&mut conn, &sec.id).unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        crate::repo::notes::purge(&mut conn, data_dir.path(), &note_id).unwrap();

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM section_trash", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    /// 완전 삭제한 항목은 목록에서 사라지고, 두 번 부르면 NOT_FOUND.
    #[test]
    fn purge_drops_the_trash_row() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();
        delete(&mut conn, &sec.id).unwrap();

        purge(&conn, &sec.id).unwrap();
        assert!(trash_list(&conn, Some(workspace_of(&conn))).unwrap().is_empty());
        assert!(matches!(purge(&conn, &sec.id), Err(AppError::NotFound(_))));
        // 복구도 더는 안 된다.
        assert!(matches!(restore(&mut conn, &sec.id), Err(AppError::NotFound(_))));
    }

    /// tombstone 판정(§6): 삭제는 계속 묘비를 찍고(동기화 상대에겐 삭제가 맞다), 복구는 같은
    /// id 로 행을 되살리므로 묘비를 지운다 — 살아 있는 행에 묘비가 남아 있지 않게.
    #[test]
    fn delete_records_a_tombstone_and_restore_removes_it() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec = create(&mut conn, &note_id, None).unwrap();

        delete(&mut conn, &sec.id).unwrap();
        assert_eq!(tombstones(&conn, &sec.id), 1);

        restore(&mut conn, &sec.id).unwrap();
        assert_eq!(tombstones(&conn, &sec.id), 0);
    }

    /// 유일 섹션 CONFLICT 는 휴지통 경유가 된 뒤에도 그대로다 — 거부되면 휴지통에도 안 들어간다.
    #[test]
    fn deleting_the_only_section_still_conflicts_and_leaves_no_trash_row() {
        let (mut conn, note_id) = setup_db();
        let sec = create(&mut conn, &note_id, None).unwrap();

        assert!(matches!(
            delete(&mut conn, &sec.id),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(load_for_note(&conn, &note_id).unwrap().len(), 1);
        assert!(trash_list(&conn, Some(workspace_of(&conn))).unwrap().is_empty());
        assert_eq!(tombstones(&conn, &sec.id), 0);
    }

    /// 지운 섹션 본문은 검색에서 사라지고 복구하면 다시 잡힌다 — 별도 테이블이라 기존 `FROM
    /// sections` 쿼리를 하나도 안 고쳐도 유령이 남지 않는다는 것이 D4 의 요지다.
    #[test]
    fn trashed_section_body_leaves_fts_and_comes_back_on_restore() {
        let (mut conn, note_id) = setup_db();
        create(&mut conn, &note_id, None).unwrap();
        let sec =
            create_with_body(&mut conn, &note_id, None, "휴지통본문마커".to_string()).unwrap();
        assert!(fts_body(&conn, &note_id).contains("휴지통본문마커"));

        delete(&mut conn, &sec.id).unwrap();
        assert!(!fts_body(&conn, &note_id).contains("휴지통본문마커"));

        restore(&mut conn, &sec.id).unwrap();
        assert!(fts_body(&conn, &note_id).contains("휴지통본문마커"));
    }

    #[test]
    fn create_defaults_to_text_kind() {
        let (mut conn, note_id) = setup_db();
        let sec = create(&mut conn, &note_id, None).unwrap();
        assert_eq!(sec.kind, "text");
    }

    /// W5: 일반 create()는 AI 산출물이 아니다 — ai_origin은 항상 None. updated_at은 "항상
    /// 채워 보낸다" 요구대로 생성 시각으로 채워진다(Rust 쪽에서 생략 금지).
    #[test]
    fn create_leaves_ai_origin_none_and_fills_updated_at() {
        let (mut conn, note_id) = setup_db();
        let sec = create(&mut conn, &note_id, None).unwrap();
        assert_eq!(sec.ai_origin, None);
        assert!(sec.updated_at.is_some());

        let loaded = load_for_note(&conn, &note_id).unwrap();
        let found = loaded.iter().find(|s| s.id == sec.id).unwrap();
        assert_eq!(found.ai_origin, None);
        assert!(found.updated_at.is_some());
    }

    /// create_with_body_and_kind_and_origin — insertAiSection의 새-섹션 경로가 액션 id를
    /// INSERT에 그대로 실을 수 있는지(specs/commands/sections.yaml section_create_with_body).
    #[test]
    fn create_with_body_and_kind_and_origin_sets_ai_origin() {
        let (mut conn, note_id) = setup_db();
        let sec = create_with_body_and_kind_and_origin(
            &mut conn,
            &note_id,
            None,
            "정리된 본문".to_string(),
            None,
            Some("summarize".to_string()),
        )
        .unwrap();
        assert_eq!(sec.ai_origin.as_deref(), Some("summarize"));

        let loaded = load_for_note(&conn, &note_id).unwrap();
        assert_eq!(
            loaded.iter().find(|s| s.id == sec.id).unwrap().ai_origin.as_deref(),
            Some("summarize")
        );
    }

    /// update()의 이중 Option 계약 그 자체 — None(보존)/Some(None)(지움)/Some(Some(v))(세팅)
    /// 세 가지를 커맨드 레이어(section_update) 우회 없이 repo 원시 함수 수준에서 검증한다.
    /// commands::sections::ai_origin_contract_tests가 세 갈래를 IPC 경로로 한 번 더 검증한다.
    #[test]
    fn update_ai_origin_double_option_preserves_clears_and_sets() {
        let (mut conn, note_id) = setup_db();
        let sec = create_with_body_and_kind_and_origin(
            &mut conn,
            &note_id,
            None,
            "본문".to_string(),
            None,
            Some("organize".to_string()),
        )
        .unwrap();

        // None → 보존 (rename만 해도 ai_origin은 그대로).
        update(&mut conn, &sec.id, Some("새 이름".to_string()), None, None).unwrap();
        let ai_origin: Option<String> = conn
            .query_row("SELECT ai_origin FROM sections WHERE id=?1", [&sec.id], |r| r.get(0))
            .unwrap();
        assert_eq!(ai_origin.as_deref(), Some("organize"));

        // Some(None) → 지움.
        update(&mut conn, &sec.id, None, Some("사용자 편집".to_string()), Some(None)).unwrap();
        let ai_origin: Option<String> = conn
            .query_row("SELECT ai_origin FROM sections WHERE id=?1", [&sec.id], |r| r.get(0))
            .unwrap();
        assert_eq!(ai_origin, None);

        // Some(Some(v)) → 세팅.
        update(
            &mut conn,
            &sec.id,
            None,
            Some("AI가 다시 씀".to_string()),
            Some(Some("diagram_edit".to_string())),
        )
        .unwrap();
        let ai_origin: Option<String> = conn
            .query_row("SELECT ai_origin FROM sections WHERE id=?1", [&sec.id], |r| r.get(0))
            .unwrap();
        assert_eq!(ai_origin.as_deref(), Some("diagram_edit"));
    }

    #[test]
    fn create_with_body_and_kind_makes_a_diagram_section() {
        let (mut conn, note_id) = setup_db();
        let sec = create_with_body_and_kind(
            &mut conn,
            &note_id,
            Some("Relations".to_string()),
            "flowchart TD\n  A --> B".to_string(),
            Some("diagram".to_string()),
        )
        .unwrap();
        assert_eq!(sec.kind, "diagram");
        assert_eq!(sec.body_md, "flowchart TD\n  A --> B");

        // load_for_note round-trips the kind column back out.
        let loaded = load_for_note(&conn, &note_id).unwrap();
        let found = loaded.iter().find(|s| s.id == sec.id).unwrap();
        assert_eq!(found.kind, "diagram");
    }

    #[test]
    fn create_with_body_and_kind_makes_a_sheet_section() {
        let (mut conn, note_id) = setup_db();
        let sec = create_with_body_and_kind(
            &mut conn,
            &note_id,
            Some("가계부".to_string()),
            r#"{"v":1,"rows":100,"cols":[],"cells":{}}"#.to_string(),
            Some("sheet".to_string()),
        )
        .unwrap();
        assert_eq!(sec.kind, "sheet");
        let loaded = load_for_note(&conn, &note_id).unwrap();
        assert_eq!(loaded.iter().find(|s| s.id == sec.id).unwrap().kind, "sheet");
    }

    #[test]
    fn create_with_body_and_kind_rejects_unknown_kind() {
        let (mut conn, note_id) = setup_db();
        let err = create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            "x".to_string(),
            Some("bogus".to_string()),
        );
        assert!(matches!(err, Err(AppError::Validation(_))), "got {err:?}");
    }

    #[test]
    /// A diagram section's `kind` survives serde_json round-trip unchanged — this is the same
    /// serialization repo::notes::note_detail uses for both native IPC (Section is returned
    /// as-is from Tauri commands) and the sync HTTP API (sync_server/handlers/notes.rs
    /// passes the same NoteDetail through serde_json/axum::Json), so proving `kind` survives here
    /// proves it reaches both surfaces without a separate integration harness for either.
    fn diagram_section_kind_survives_json_round_trip() {
        let (mut conn, note_id) = setup_db();
        let sec = create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            "flowchart TD\n  A --> B".to_string(),
            Some("diagram".to_string()),
        )
        .unwrap();
        let json = serde_json::to_value(&sec).unwrap();
        assert_eq!(json["kind"], "diagram");
        let back: Section = serde_json::from_value(json).unwrap();
        assert_eq!(back, sec);
    }

    // ── D2② 낙관적 동시성 (docs/PLAN-2026-10-06-d2-expected-updated-at.md, DRILLS-2026-10-06 드릴 3) ──

    fn token_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT updated_at FROM sections WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }

    fn body_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT body_md FROM sections WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn expected_match_writes_and_returns_new_token() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let t0 = token_of(&conn, &sec.id);
        let w = update_checked(&mut conn, &sec.id, None, Some("a".into()), None, Some(&t0)).unwrap();
        assert_ne!(w.section_updated_at, t0);
        assert_eq!(token_of(&conn, &sec.id), w.section_updated_at);
        assert_eq!(body_of(&conn, &sec.id), "a");
        // 직전 응답의 토큰으로 이어 쓰면 통과(자기 자신과 충돌하지 않음).
        update_checked(&mut conn, &sec.id, None, Some("b".into()), None, Some(&w.section_updated_at)).unwrap();
        assert_eq!(body_of(&conn, &sec.id), "b");
    }

    /// 드릴 3 (c): 읽은 뒤 다른 기기가 같은 섹션을 바꿨으면 낡은 토큰의 전체 재작성은 거부되고
    /// 다른 기기의 본문이 보존된다.
    #[test]
    fn stale_expected_is_conflict_and_body_untouched() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let read_token = token_of(&conn, &sec.id);
        update_checked(&mut conn, &sec.id, None, Some("phone-2 line".into()), None, Some(&read_token)).unwrap();
        let err = update_checked(&mut conn, &sec.id, None, Some("phone-1 rewrite".into()), None, Some(&read_token))
            .unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
        assert_eq!(body_of(&conn, &sec.id), "phone-2 line");
    }

    /// 감사 M-8: 응답만 잃은 저장 — 낡은 토큰 + 같은 본문은 무변경 성공, 현재 토큰 반환.
    #[test]
    fn stale_expected_with_same_body_is_noop_success() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let t0 = token_of(&conn, &sec.id);
        let w = update_checked(&mut conn, &sec.id, None, Some("lost reply".into()), None, Some(&t0)).unwrap();
        let note_at: String =
            conn.query_row("SELECT updated_at FROM notes WHERE id=?1", [&note], |r| r.get(0)).unwrap();
        let again = update_checked(&mut conn, &sec.id, None, Some("lost reply".into()), None, Some(&t0)).unwrap();
        assert_eq!(again.section_updated_at, w.section_updated_at);
        assert_eq!(token_of(&conn, &sec.id), w.section_updated_at);
        let note_after: String =
            conn.query_row("SELECT updated_at FROM notes WHERE id=?1", [&note], |r| r.get(0)).unwrap();
        assert_eq!(note_after, note_at);
        // 본문이 다르면 여전히 CONFLICT.
        let err = update_checked(&mut conn, &sec.id, None, Some("other".into()), None, Some(&t0)).unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
        assert_eq!(body_of(&conn, &sec.id), "lost reply");
    }

    fn edit_records(conn: &Connection, note_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM activity_log WHERE note_id=?1 AND kind=?2",
            params![note_id, crate::repo::activity::KIND_EDIT],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 2026-10-18 가짜 편집: 저장값과 같은 본문의 section_update 는 아무것도 쓰지 않는다 — 활동 기록 '편집' 없음,
    /// 노트 수정 시각·섹션 토큰 그대로, 변경 이벤트 없음(changed=false). 편집기 저장의 실제 인자 모양
    /// (ai_origin 패치 Some(None) = 사용자 편집)으로, 토큰을 보낸 경우와 안 보낸 경우 둘 다.
    #[test]
    fn same_body_write_is_noop_no_edit_record_no_touch() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let t0 = token_of(&conn, &sec.id);
        let w = update_checked(&mut conn, &sec.id, None, Some("body".into()), Some(None), Some(&t0)).unwrap();
        assert!(w.changed);
        assert_eq!(edit_records(&conn, &note), 1);
        conn.execute("UPDATE notes SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?1", [&note]).unwrap();
        let token = token_of(&conn, &sec.id);

        let again = update_checked(&mut conn, &sec.id, None, Some("body".into()), Some(None), Some(&token)).unwrap();
        assert!(!again.changed);
        assert_eq!(again.section_updated_at, token);
        assert_eq!(again.updated_at, "2000-01-01T00:00:00.000Z");
        let untokened = update_checked(&mut conn, &sec.id, None, Some("body".into()), Some(None), None).unwrap();
        assert!(!untokened.changed);
        update(&mut conn, &sec.id, None, Some("body".into()), None).unwrap();

        assert_eq!(edit_records(&conn, &note), 1);
        assert_eq!(note_updated_at(&conn, &note), "2000-01-01T00:00:00.000Z");
        assert_eq!(token_of(&conn, &sec.id), token);

        // 본문이 바뀌면 예전처럼 기록·갱신된다.
        let w2 = update_checked(&mut conn, &sec.id, None, Some("body 2".into()), Some(None), Some(&token)).unwrap();
        assert!(w2.changed);
        assert_ne!(w2.section_updated_at, token);
        assert_eq!(edit_records(&conn, &note), 2);
        assert_ne!(note_updated_at(&conn, &note), "2000-01-01T00:00:00.000Z");
    }

    /// 같은 본문이라도 이름·출처가 바뀌는 쓰기는 쓴다 — 단 본문 편집이 아니므로 '편집' 기록은 남기지 않는다.
    #[test]
    fn same_body_with_rename_or_origin_change_writes_without_edit_record() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        update(&mut conn, &sec.id, None, Some("body".into()), Some(Some("ai.organize".into()))).unwrap();
        assert_eq!(edit_records(&conn, &note), 1);

        let renamed = update_checked(&mut conn, &sec.id, Some("New name".into()), Some("body".into()), None, None).unwrap();
        assert!(renamed.changed);
        let name: String = conn.query_row("SELECT name FROM sections WHERE id=?1", [&sec.id], |r| r.get(0)).unwrap();
        assert_eq!(name, "New name");

        let cleared = update_checked(&mut conn, &sec.id, None, Some("body".into()), Some(None), None).unwrap();
        assert!(cleared.changed);
        let origin: Option<String> =
            conn.query_row("SELECT ai_origin FROM sections WHERE id=?1", [&sec.id], |r| r.get(0)).unwrap();
        assert_eq!(origin, None);

        assert_eq!(edit_records(&conn, &note), 1);
        assert_eq!(body_of(&conn, &sec.id), "body");
    }

    /// 무변경 판정은 휴지통 거부를 우회하지 않는다 — 토큰을 보낸 휴지통 노트 쓰기는 같은 본문이어도 NOT_FOUND.
    #[test]
    fn same_body_write_to_trashed_note_with_token_is_still_rejected() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let t = token_of(&conn, &sec.id);
        conn.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params![now_iso(), note]).unwrap();
        let err = update_checked(&mut conn, &sec.id, None, Some(String::new()), Some(None), Some(&t)).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    /// 감사 M-8 이 편집기 저장 모양(ai_origin 패치 Some(None))에서도 발동한다 — 예전 판정은 ai_origin None 만 받아
    /// section_update 경로에서는 응답을 잃은 저장 뒤 다음 저장이 늘 CONFLICT 였다.
    #[test]
    fn stale_expected_same_body_is_noop_on_editor_save_shape() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let t0 = token_of(&conn, &sec.id);
        let w = update_checked(&mut conn, &sec.id, None, Some("lost reply".into()), Some(None), Some(&t0)).unwrap();
        let again = update_checked(&mut conn, &sec.id, None, Some("lost reply".into()), Some(None), Some(&t0)).unwrap();
        assert!(!again.changed);
        assert_eq!(again.section_updated_at, w.section_updated_at);
        let err = update_checked(&mut conn, &sec.id, None, Some("other".into()), Some(None), Some(&t0)).unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
    }

    /// 드릴 3 (a): 같은 토큰으로 연달아 온 두 쓰기 — 같은 밀리초여도 두 번째만 CONFLICT.
    #[test]
    fn same_token_twice_second_conflicts_even_within_same_ms() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        // 미래 시각을 심어 now <= prev 를 강제 — 단조 규칙(prev+1ms)이 아니면 두 쓰기가 같은 토큰을 받는다.
        conn.execute("UPDATE sections SET updated_at='2999-01-01T00:00:00.000Z' WHERE id=?1", [&sec.id]).unwrap();
        let t0 = "2999-01-01T00:00:00.000Z";
        let w1 = update_checked(&mut conn, &sec.id, None, Some("one".into()), None, Some(t0)).unwrap();
        assert_eq!(w1.section_updated_at, "2999-01-01T00:00:00.001Z");
        let err = update_checked(&mut conn, &sec.id, None, Some("two".into()), None, Some(t0)).unwrap_err();
        assert_eq!(err.code(), "CONFLICT");
        assert_eq!(body_of(&conn, &sec.id), "one");
    }

    #[test]
    fn omitted_expected_keeps_last_write_wins() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        update(&mut conn, &sec.id, None, Some("x".into()), None).unwrap();
        update(&mut conn, &sec.id, None, Some("y".into()), None).unwrap();
        assert_eq!(body_of(&conn, &sec.id), "y");
    }

    /// 드릴 3 (d): 토큰을 보낸 휴지통 노트 쓰기는 NOT_FOUND — 내부 본문 쓰기(write_body_tx)는 항상.
    #[test]
    fn trashed_note_rejects_section_writes() {
        let (mut conn, note) = setup_db();
        let sec = create(&mut conn, &note, None).unwrap();
        let t = token_of(&conn, &sec.id);
        conn.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params![now_iso(), note]).unwrap();
        let err = update_checked(&mut conn, &sec.id, None, Some("ghost".into()), None, Some(&t)).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        let err = update_checked(&mut conn, &sec.id, Some("rename".into()), None, None, Some(&t)).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        let tx = conn.transaction().unwrap();
        let err = write_body_tx(&tx, &note, &sec.id, "ghost", &now_iso()).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        drop(tx);
        assert_eq!(body_of(&conn, &sec.id), "");
        // 단계 1: 토큰 없는 구 클라이언트 쓰기는 예전처럼 휴지통 안으로 들어간다(복구 시 살아남).
        update(&mut conn, &sec.id, None, Some("legacy".into()), None).unwrap();
        assert_eq!(body_of(&conn, &sec.id), "legacy");
    }

    /// 삭제된 섹션은 section_trash 로 옮겨지므로 토큰을 들고 와도 부활하지 않는다(NOT_FOUND).
    #[test]
    fn deleted_section_with_expected_is_not_found_no_resurrection() {
        let (mut conn, note) = setup_db();
        let keep = create(&mut conn, &note, None).unwrap();
        let gone = create(&mut conn, &note, None).unwrap();
        let _ = keep;
        let gone_token = token_of(&conn, &gone.id);
        delete(&mut conn, &gone.id).unwrap();
        let err = update_checked(&mut conn, &gone.id, None, Some("x".into()), None, Some(&gone_token))
            .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM sections WHERE id=?1", [&gone.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn next_token_is_monotonic() {
        assert_eq!(next_token("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.500Z"), "2026-01-01T00:00:00.500Z");
        assert_eq!(next_token("2026-01-01T00:00:00.500Z", "2026-01-01T00:00:00.500Z"), "2026-01-01T00:00:00.501Z");
        // 시계 역행
        assert_eq!(next_token("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:01.001Z");
        // 못 읽는 prev 는 now
        assert_eq!(next_token("garbage", "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
    }

}
