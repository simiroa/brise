// 브리핑 "최근 수집 노트" — notes.origin_source_id / collected_at (migration v90, PLAN-2026-09-30-briefing W7).
// 쓰기는 collect::ingest_item_with_note_id 가 stamp_collected 로 한 곳에서만 한다. NoteSummary 는 건드리지 않고
// 브리핑 전용 행(CollectedNote)을 따로 돌려준다.
//
// PLAN-2026-10-19-briefing-rewrite.md W2: 시간축에서 일정 만들기(block_create, §4.1)와 문구 팩 '내 노트 인용'
// (note_quote, §6)도 여기 둔다 — 둘 다 브리핑 창 전용이고 specs/commands/briefing.yaml 과 1:1.
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::{CollectHistoryNote, CollectedNote, RecentCollected};
use crate::repo::{activity, checklist, folders, notes, schedule};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const EXCERPT_CHARS: usize = 120;

/// 수집으로 들어온 살아있는 노트의 뼈대(`FROM notes n` 뒤에 붙는 JOIN + 공통 WHERE, `?1` = workspace_id) — 브리핑 카드(`recent_collected`)와 설정의
/// 수집 이력 표(`collect_history`)가 같은 뼈대를 쓴다. 브리핑은 여기에 `show_in_briefing` 조건을 더하고, 이력은 더하지 않는다
/// (브리핑에서 끈 소스의 노트도 "이 소스가 만든 노트" 이력엔 남아야 한다). 소스가 삭제됐으면 `cs` 가 NULL 이다.
const COLLECTED_NOTES_BASE: &str = "JOIN folders f ON f.id = n.folder_id
             LEFT JOIN collect_sources cs ON cs.id = n.origin_source_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL AND n.collected_at IS NOT NULL";

/// 브리핑에서 꺼진 소스의 노트를 뺀다 — 단 소스가 삭제된(조인 NULL) 노트는 더 끌 수 없으니 계속 보인다(E3).
const BRIEFING_SHOWN: &str = "(cs.id IS NULL OR cs.show_in_briefing = 1)";

/// 수집이 이 노트를 썼다(새로 만들었거나 기존 하루 노트에 줄을 붙였다)고 표시한다. 소스가 사라져도 남는다(FK 없음).
pub fn stamp_collected(conn: &Connection, note_id: &str, source_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE notes SET origin_source_id=?1, collected_at=?2 WHERE id=?3",
        params![source_id, crate::util::now_iso(), note_id],
    )
    .map_err(dberr)?;
    Ok(())
}

/// `since`(RFC3339, 없으면 now-24h) 이후 수집된 수(new_count)와 최근 수집 노트 `limit` 개. 삭제된 노트·다른 노트북 제외.
/// 소스가 show_in_briefing=0 이면 그 노트도 제외 — 단 원본 소스가 삭제된(조인 NULL) 노트는 더 끌 수 없으니 계속 보인다(E3).
pub fn recent_collected(
    conn: &Connection,
    workspace_id: &str,
    since: Option<&str>,
    limit: i64,
    now: DateTime<Utc>,
) -> AppResult<RecentCollected> {
    let since = match since {
        Some(s) if !s.is_empty() => DateTime::parse_from_rfc3339(s)
            .map_err(|_| AppError::Validation(format!("briefing_recent_collected: bad since '{s}'")))?
            .with_timezone(&Utc),
        _ => now - Duration::hours(24),
    }
    // now_iso() 와 같은 형식(UTC, 밀리초, Z)으로 맞춰야 문자열 비교가 시간 비교가 된다.
    .to_rfc3339_opts(SecondsFormat::Millis, true);
    let limit = limit.clamp(1, 50);

    // 별칭은 notes 컬럼명과 겹치지 않게(src_name/src_kind) — HANDOFF §2.3.
    let mut stmt = conn
        .prepare(&format!(
            "SELECT n.id, n.title, n.origin_source_id, cs.name AS src_name, cs.kind AS src_kind, n.collected_at,
                    (SELECT substr(s.body_md, 1, 400) FROM sections s WHERE s.note_id = n.id ORDER BY s.position LIMIT 1) AS excerpt_raw
             FROM notes n {COLLECTED_NOTES_BASE}
               AND {BRIEFING_SHOWN}
             ORDER BY n.collected_at DESC LIMIT ?2"
        ))
        .map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, limit], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;

    let mut tag_stmt = conn
        .prepare("SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ?1 ORDER BY t.name COLLATE NOCASE")
        .map_err(dberr)?;
    let mut items = Vec::with_capacity(rows.len());
    for (note_id, title, source_id, source_name, source_kind, collected_at, excerpt_raw) in rows {
        let tags = tag_stmt
            .query_map([&note_id], |r| r.get::<_, String>(0))
            .map_err(dberr)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(dberr)?;
        let excerpt = excerpt_raw
            .map(|b| b.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(EXCERPT_CHARS).collect::<String>())
            .filter(|e| !e.is_empty());
        items.push(CollectedNote { note_id, title, excerpt, source_id, source_name, source_kind, collected_at, tags });
    }

    let new_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM notes n {COLLECTED_NOTES_BASE} AND n.collected_at > ?2 AND {BRIEFING_SHOWN}"),
            params![workspace_id, since],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    Ok(RecentCollected { items, new_count })
}

/// 설정 > 수집 > 수집 이력 표 — 수집 소스가 만든 노트를 최근 수집순으로 `limit`(1..=100) 개. 표가 쓰는 필드(노트·제목·소스 이름·
/// 수집 시각)만 돌려준다: 브리핑 카드용 발췌 서브쿼리·행마다 태그 조회(N+1)·`new_count` 집계를 하지 않는다.
/// `recent_collected` 와 뼈대(`COLLECTED_NOTES_BASE`)는 같지만 **`show_in_briefing` 조건이 없다** — 브리핑에서 끈 소스의 노트도
/// 이력엔 나온다("이 소스가 뭘 가져왔나"를 보는 표다). 삭제된 노트·다른 노트북은 제외, 원본 소스가 삭제된 노트는 이름 null 로 남는다.
/// 정렬은 부분 인덱스 idx_notes_collected_alive(collected_at)를 따른다 — `INDEXED BY` 로 고정한다: 통계가 없는 부팅 직후의 플래너는
/// 폴더 → notes(folder_id) 로 내려가 그 노트북의 수집 노트 전부를 임시 B-tree 로 정렬했다(EXPLAIN 으로 확인). 고정하면 최근 것부터
/// 읽다가 LIMIT 에서 끊는다(부분 인덱스 술어 `collected_at IS NOT NULL AND deleted_at IS NULL` 은 공통 WHERE 가 충족한다).
fn collect_history_sql() -> String {
    format!(
        "SELECT n.id, n.title, cs.name, n.collected_at
         FROM notes n INDEXED BY idx_notes_collected_alive {COLLECTED_NOTES_BASE}
         ORDER BY n.collected_at DESC LIMIT ?2"
    )
}

pub fn collect_history(conn: &Connection, workspace_id: &str, limit: i64) -> AppResult<Vec<CollectHistoryNote>> {
    let limit = limit.clamp(1, 100);
    let mut stmt = conn.prepare(&collect_history_sql()).map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, limit], |r| {
            Ok(CollectHistoryNote { note_id: r.get(0)?, title: r.get(1)?, source_name: r.get(2)?, collected_at: r.get(3)? })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

// ── 최근 작업 노트 (briefing_recent_notes) ───────────────────────────────────────────────────

/// 브리핑 "최근 작업 노트" 한 줄 — 노트별 마지막 생성/편집 활동 시각.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentWorkNote {
    pub note_id: String,
    pub title: String,
    pub folder_name: Option<String>,
    pub last_at: String,
}

/// 활동 기록(create/edit)을 노트별로 묶어 마지막 활동 시각 내림차순 `limit`(1..20) 개.
/// `notes.updated_at` 을 쓰지 않는다 — 브리핑 축 끌기·수집·AI 쓰기로도 바뀌어 "내가 작업한 노트"가 아니다.
/// 활동 기록은 생성과 실제 본문 변경만 남고 7일 보관(activity::ACTIVITY_RETENTION_DAYS) — 그 창이 곧 카드의 창이다.
/// 삭제·보관 노트, 지금 다른 노트북 폴더에 있는 노트(옮겨 간 노트 포함), 제목·본문 모두 빈 노트(activity_list 와 같은
/// `activity::EMPTY_NOTE_SQL`)는 뺀다.
pub fn recent_notes(conn: &Connection, workspace_id: &str, limit: i64) -> AppResult<Vec<RecentWorkNote>> {
    let limit = limit.clamp(1, 20);
    let sql = format!(
        "SELECT a.note_id, n.title, f.name, MAX(a.created_at) AS last_at
         FROM activity_log a
         JOIN notes n ON n.id = a.note_id
         JOIN folders f ON f.id = n.folder_id
         WHERE a.workspace_id = ?1 AND f.workspace_id = ?1
           AND a.kind IN ('{create}', '{edit}') AND a.note_id IS NOT NULL
           AND n.deleted_at IS NULL AND n.archived_at IS NULL
           AND NOT {empty}
         GROUP BY a.note_id
         ORDER BY last_at DESC, a.note_id ASC
         LIMIT ?2",
        create = activity::KIND_CREATE,
        edit = activity::KIND_EDIT,
        empty = activity::EMPTY_NOTE_SQL,
    );
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let rows = stmt
        .query_map(params![workspace_id, limit], |r| {
            Ok(RecentWorkNote { note_id: r.get(0)?, title: r.get(1)?, folder_name: r.get(2)?, last_at: r.get(3)? })
        })
        .map_err(dberr)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(dberr)
}

// ── 일정 만들기 (briefing_block_create, PLAN §4.1) ─────────────────────────────────────────────

/// `briefing_block_create` 의 결과 — 만든 노트와 그 대표(position 0) 날짜 행.
#[derive(Debug, Clone, Serialize)]
pub struct BlockCreated {
    pub note_id: String,
    pub date_id: String,
}

/// 브리핑 시간축에서 끌어 만든 일정 하나 = 받은편지함 노트 하나(대표 날짜 행에 시각). 달력 축의 빈 곳 생성과
/// 같은 데이터지만 한 커맨드·한 트랜잭션이다 — 프런트 두 단계(note_create → patchDateRow)는 둘째가 실패하면
/// 시각 없는 노트를 남기고, 프런트 `ensureInboxId` 는 트리를 싣지 않은 브리핑 창에서 받은편지함을 하나 더
/// 만든다(PLAN §2.4 ①②).
///
/// 순서가 계약이다:
/// ① 검증 전부 — 실패면 쓰기 0. `ensure_inbox_folder_id` 는 폴더와 `inbox_<노트북>` 설정 키를 **쓰므로** 그보다 앞.
///    시각은 `schedule::parse_hhmm_min`(validate_schedule_fields 가 쓰는 바로 그 형식 관문)으로 보고, 끝은 시작보다
///    **엄격히** 뒤여야 한다 — 행 검증(I3)은 같은 시각을 허용하지만 길이 0 인 일정은 축에서 만들 수 없는 값이다.
/// ② 받은편지함 = 서버측 규약(수집·펫·모바일과 같은 함수, 멱등).
/// ③ `create_today_default_with_hook` — note_create 와 같은 첫 섹션 이름·날짜 해석. hook(같은 트랜잭션)에서 대표 행
///    start/end_time + project_primary. 연·월·일을 명시로 넘기므로 노트북의 new_note_date_precision 은 끼어들지 않는다
///    (시각은 일 정밀도가 필요하다, I1). 활동 기록 create 1행은 그 함수가 커밋 뒤에 남긴다.
pub fn block_create(
    conn: &mut Connection,
    workspace_id: &str,
    day: &str,
    start_time: &str,
    end_time: &str,
    title: &str,
) -> AppResult<BlockCreated> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("briefing_block_create: title must not be empty".into()));
    }
    let ymd = notes::dates::parse_date(day)
        .ok_or_else(|| AppError::Validation(format!("briefing_block_create: bad day '{day}' (YYYY-MM-DD)")))?;
    let start = schedule::parse_hhmm_min(start_time).ok_or_else(|| {
        AppError::Validation(format!("briefing_block_create: invalid start_time (HH:MM 00:00..23:59): {start_time}"))
    })?;
    let end = schedule::parse_hhmm_min(end_time).ok_or_else(|| {
        AppError::Validation(format!("briefing_block_create: invalid end_time (HH:MM 00:00..23:59): {end_time}"))
    })?;
    if end <= start {
        return Err(AppError::Validation("briefing_block_create: end_time must be after start_time".into()));
    }

    let folder_id = folders::ensure_inbox_folder_id(conn, workspace_id)?;

    let mut date_id: Option<String> = None;
    let detail = notes::create_today_default_with_hook(
        conn,
        &folder_id,
        Some(title.to_string()),
        Some(ymd.y),
        Some(i64::from(ymd.m)),
        Some(i64::from(ymd.d)),
        |tx, note_id| {
            let id: String = tx
                .query_row("SELECT id FROM note_dates WHERE note_id=?1 AND position=0", [note_id], |r| r.get(0))
                .map_err(dberr)?;
            tx.execute(
                "UPDATE note_dates SET start_time=?1, end_time=?2 WHERE id=?3",
                params![start_time, end_time, id],
            )
            .map_err(dberr)?;
            notes::dates::project_primary(tx, note_id)?;
            date_id = Some(id);
            Ok(())
        },
    )?;
    let date_id = date_id.ok_or_else(|| AppError::Db("briefing_block_create: primary date row hook did not run".into()))?;
    Ok(BlockCreated { note_id: detail.note.id, date_id })
}

// ── 내 노트 인용 (briefing_note_quote, PLAN §6) ───────────────────────────────────────────────

/// 인용 한 줄 — 출처 노트와 그 본문의 읽을 수 있는 첫 문단.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteQuote {
    pub note_id: String,
    pub title: String,
    pub text: String,
}

/// 후보 풀 — 최근 수정 순 상위 N 개.
/// ponytail: 10만 노트에서 `ORDER BY random()` 을 통째로 돌리면 전 행 정렬이 된다 — 그래서 `idx_notes_updated_alive`
/// 로 최근 2000개만 자른 뒤 그 안에서 섞는다. 천장: 오래된 노트는 인용되지 않고, 최근 2000개가 전부 빈 노트(브리핑
/// 일정 등)면 null. 넓히려면 `rowid` 범위 무작위 표본(최대 rowid 안에서 난수 → `rowid >= ?` 한 행)으로 바꾼다.
const QUOTE_POOL: i64 = 2000;
/// ?1 = workspace_id, ?2 = QUOTE_POOL. 노트북 스코프는 조인이 아니라 semi-join, 인덱스는 `INDEXED BY` 로 못 박는다 —
/// dashboard/calendar.rs SPAN_SQL 주석과 같은 이유(통계 없는 플래너가 다른 인덱스 전량 스캔 + 정렬을 고른다, 아래
/// quote_pool_rides_the_updated_index 가 지킨다). 부분 인덱스라 `deleted_at IS NULL` 은 뺄 수 없다.
const QUOTE_POOL_SQL: &str = "SELECT id, title FROM (
     SELECT n.id, n.title FROM notes n INDEXED BY idx_notes_updated_alive
     WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
       AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1 AND search_excluded = 0)
     ORDER BY n.updated_at DESC LIMIT ?2
 ) ORDER BY random()";
/// 이보다 짧으면 인용으로 읽히지 않는다(옛 PhraseRow `text.length > 5` 와 같은 문턱, 글자 수 기준).
const QUOTE_MIN_CHARS: usize = 6;
/// 인용 상한 — question_search::lead_snippet 과 같은 200자 + "…"(그 함수는 비공개이고 마크다운을 걷지 않는다).
const QUOTE_MAX_CHARS: usize = 200;

/// 그 노트북의 노트 중 하나를 무작위로 골라 본문 첫 문단을 인용으로 준다. 없으면 None — 호출부가 정직한 빈 상태와
/// reportFallback 을 맡는다(지식 팩으로 몰래 바꾸지 않는다, PLAN §6).
///
/// 제외: 삭제·보관된 노트, 검색 제외 폴더(수집 소음 폴더 — 사용자가 "검색에 안 보이게" 한 것을 문구로 다시 꺼내지 않는다).
/// `exclude_note_id` 는 순서만 맨 뒤로 민다 — 인용할 수 있는 노트가 그것뿐이면 그대로 준다(그때 null 을 주면 노트가
/// 하나뿐인 노트북에서 새로고침마다 거짓 빈 상태와 거짓 폴백 기록이 생긴다).
pub fn note_quote(conn: &Connection, workspace_id: &str, exclude_note_id: Option<&str>) -> AppResult<Option<NoteQuote>> {
    let mut stmt = conn.prepare(QUOTE_POOL_SQL).map_err(dberr)?;
    let pool = stmt
        .query_map(params![workspace_id, QUOTE_POOL], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    let (excluded, mut ordered): (Vec<_>, Vec<_>) =
        pool.into_iter().partition(|(id, _)| Some(id.as_str()) == exclude_note_id);
    ordered.extend(excluded);

    // 첫 text 섹션만 — diagram·sheet 본문은 JSON 이라 인용이 아니다.
    let mut body_stmt = conn
        .prepare(
            "SELECT body_md FROM sections WHERE note_id = ?1 AND (kind = 'text' OR kind IS NULL)
             ORDER BY position LIMIT 1",
        )
        .map_err(dberr)?;
    for (note_id, title) in ordered {
        let body: Option<String> = body_stmt.query_row([&note_id], |r| r.get(0)).optional().map_err(dberr)?;
        if let Some(text) = body.as_deref().and_then(readable_excerpt) {
            return Ok(Some(NoteQuote { note_id, title, text }));
        }
    }
    Ok(None)
}

/// body_md(마크다운 + HTML 섬)에서 인용으로 읽히는 첫 문단. 건너뛰는 줄: 빈 줄 · 코드 펜스 안 · 제목(`# `) · 표
/// (`|` 줄, HTML 표는 checklist::mask_html_tables 로 가림) · 그림만 있는 줄 · 가로줄. 남은 줄은 줄머리 표식(인용 `>`,
/// 목록·할 일)과 인라인 표식(굵게·기울임·취소선·형광·코드·링크 주소·그림)을 걷고 HTML 태그·엔티티를 푼다
/// (checklist::strip_tags_and_collapse — 폰 피드 발췌와 같은 함수). 그 결과가 QUOTE_MIN_CHARS 이상인 첫 줄.
fn readable_excerpt(body_md: &str) -> Option<String> {
    let masked = checklist::mask_html_tables(body_md);
    let mut in_fence = false;
    for raw in masked.lines() {
        let line = raw.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || line.is_empty() || is_heading(line) || line.starts_with('|') || is_rule(line) {
            continue;
        }
        let inline = strip_inline_md(strip_line_markers(line));
        let text = checklist::strip_tags_and_collapse(&inline, usize::MAX);
        let count = text.chars().count();
        if count >= QUOTE_MIN_CHARS {
            return Some(if count > QUOTE_MAX_CHARS {
                format!("{}…", text.chars().take(QUOTE_MAX_CHARS).collect::<String>())
            } else {
                text
            });
        }
    }
    None
}

/// ATX 제목 — `#` 1~6개 뒤 공백(또는 줄 끝). `#태그` 로 시작하는 본문 줄은 제목이 아니다.
fn is_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    (1..=6).contains(&hashes) && line[hashes..].chars().next().is_none_or(|c| c == ' ' || c == '\t')
}

/// 가로줄 — `-`·`*`·`_` 한 종류만 3개 이상(사이 공백 허용).
fn is_rule(line: &str) -> bool {
    let compact: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3 && ['-', '*', '_'].iter().any(|&m| compact.iter().all(|&c| c == m))
}

/// 줄머리 표식 — 인용(`>` 여러 겹)·할 일(`- [ ]`·`- [x]`)·글머리(`-`·`*`·`+`)·번호(`1.`·`1)`).
fn strip_line_markers(line: &str) -> &str {
    let mut s = line.trim_start();
    while let Some(rest) = s.strip_prefix('>') {
        s = rest.trim_start();
    }
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = s.strip_prefix(bullet) {
            s = rest.trim_start();
            break;
        }
    }
    for task in ["[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = s.strip_prefix(task) {
            s = rest.trim_start();
            break;
        }
    }
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        let rest = &s[digits..];
        if let Some(rest) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            s = rest.trim_start();
        }
    }
    s
}

/// 인라인 마크다운 표식을 걷는다 — 그림 `![..](..)` 은 통째로, 링크 `[글](주소)` 는 글만, `**`·`__`·`~~`·`==`·`` ` ``·`*`
/// 는 지운다(`_` 하나는 낱말 안에 흔해 남긴다). `\X` 이스케이프는 글자로 — 단 `<`·`>`·`&` 는 엔티티로 바꿔 뒤의
/// strip_tags_and_collapse 가 태그로 오인하지 않고 원래 글자로 되돌리게 한다. 끝의 `\`(줄바꿈 표식)는 버린다.
fn strip_inline_md(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\\' => {
                match next {
                    Some('<') => out.push_str("&lt;"),
                    Some('>') => out.push_str("&gt;"),
                    Some('&') => out.push_str("&amp;"),
                    Some(n) if n.is_ascii_punctuation() => out.push(n),
                    Some(n) => {
                        out.push('\\');
                        out.push(n);
                    }
                    None => {}
                }
                i += 2;
            }
            '!' if next == Some('[') => match link_end(&chars, i + 1) {
                Some((_, end)) => i = end,
                None => {
                    out.push(c);
                    i += 1;
                }
            },
            '[' => match link_end(&chars, i) {
                Some((label_end, end)) => {
                    let label: String = chars[i + 1..label_end].iter().collect();
                    out.push_str(&strip_inline_md(&label));
                    i = end;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            },
            '*' | '`' => i += 1,
            '_' | '~' | '=' if next == Some(c) => i += 2,
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `chars[open] == '['` 에서 시작하는 `[글](주소)` 의 (글 끝 `]` 위치, 전체 끝 다음 위치). 모양이 아니면 None.
fn link_end(chars: &[char], open: usize) -> Option<(usize, usize)> {
    if chars.get(open) != Some(&'[') {
        return None;
    }
    let close = open + 1 + chars[open + 1..].iter().position(|&c| c == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let paren = close + 2 + chars[close + 2..].iter().position(|&c| c == ')')?;
    Some((close, paren + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup() -> (Connection, String, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let ws: String = conn.query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0)).unwrap();
        let folder = crate::repo::folders::ensure_inbox_folder_id(&mut conn, &ws).unwrap();
        (conn, ws, folder)
    }

    fn note(conn: &Connection, folder: &str, id: &str, collected_at: Option<&str>) {
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at, origin_source_id, collected_at)
             VALUES (?1, ?2, ?1, 2026, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'src1', ?3)",
            params![id, folder, collected_at],
        )
        .unwrap();
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-01T12:00:00.000Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn since_boundary_is_exclusive_and_default_is_24h() {
        let (conn, ws, f) = setup();
        note(&conn, &f, "old", Some("2026-09-30T12:00:00.000Z")); // 정확히 24h 전 = 새 항목 아님
        note(&conn, &f, "new", Some("2026-09-30T12:00:00.001Z"));
        note(&conn, &f, "plain", None); // 수집 아님
        let r = recent_collected(&conn, &ws, None, 10, now()).unwrap();
        assert_eq!(r.new_count, 1);
        assert_eq!(r.items.iter().map(|i| i.note_id.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        let r = recent_collected(&conn, &ws, Some("2026-09-30T12:00:00.001Z"), 10, now()).unwrap();
        assert_eq!(r.new_count, 0);
        // 소스 행이 없어도(삭제됨) 항목은 나오고 이름만 null.
        assert!(r.items[0].source_name.is_none() && r.items[0].source_id.as_deref() == Some("src1"));
        assert!(matches!(recent_collected(&conn, &ws, Some("garbage"), 10, now()), Err(AppError::Validation(_))));
    }

    #[test]
    fn excludes_deleted_and_other_notebooks() {
        let (conn, ws, f) = setup();
        note(&conn, &f, "alive", Some("2026-10-01T11:00:00.000Z"));
        note(&conn, &f, "trashed", Some("2026-10-01T11:00:00.000Z"));
        conn.execute("UPDATE notes SET deleted_at='2026-10-01T11:30:00.000Z' WHERE id='trashed'", []).unwrap();
        // 다른 노트북의 수집 노트 — FK 를 잠깐 끄고 폴더만 심는다.
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute("INSERT INTO folders(id, workspace_id, name, position, created_at) VALUES ('f2','ws2','x',0,'2026-01-01T00:00:00.000Z')", []).unwrap();
        note(&conn, "f2", "foreign", Some("2026-10-01T11:00:00.000Z"));
        let r = recent_collected(&conn, &ws, None, 10, now()).unwrap();
        assert_eq!((r.new_count, r.items.len()), (1, 1));
        assert_eq!(r.items[0].note_id, "alive");
        assert_eq!(recent_collected(&conn, "other-ws", None, 10, now()).unwrap().items.len(), 0);
    }

    fn source(conn: &Connection, ws: &str, id: &str, show: Option<i64>) {
        match show {
            Some(s) => conn.execute(
                "INSERT INTO collect_sources(id, workspace_id, kind, name, config, created_at, updated_at, show_in_briefing)
                 VALUES (?1, ?2, 'rss', ?1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?3)",
                params![id, ws, s],
            ),
            // show_in_briefing 생략 = 컬럼 기본값(1) 경로.
            None => conn.execute(
                "INSERT INTO collect_sources(id, workspace_id, kind, name, config, created_at, updated_at)
                 VALUES (?1, ?2, 'rss', ?1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                params![id, ws],
            ),
        }
        .unwrap();
    }

    #[test]
    fn hidden_source_notes_are_excluded_from_items_and_new_count() {
        let (conn, ws, f) = setup();
        source(&conn, &ws, "src1", Some(0));
        note(&conn, &f, "hidden", Some("2026-10-01T11:00:00.000Z")); // origin = src1 (꺼짐)
        let r = recent_collected(&conn, &ws, None, 10, now()).unwrap();
        assert_eq!((r.new_count, r.items.len()), (0, 0));
        source(&conn, &ws, "src2", Some(1));
        conn.execute("UPDATE notes SET origin_source_id='src2' WHERE id='hidden'", []).unwrap();
        let r = recent_collected(&conn, &ws, None, 10, now()).unwrap();
        assert_eq!((r.new_count, r.items.len()), (1, 1));
    }

    /// B7: 수집 이력은 브리핑에서 끈 소스의 노트도 보여 준다(브리핑 카드와 달리).
    #[test]
    fn collect_history_includes_notes_of_sources_hidden_from_the_briefing() {
        let (conn, ws, f) = setup();
        source(&conn, &ws, "src1", Some(0)); // 브리핑에서 꺼진 소스
        note(&conn, &f, "hidden", Some("2026-10-01T11:00:00.000Z"));
        assert_eq!(recent_collected(&conn, &ws, None, 10, now()).unwrap().items.len(), 0, "브리핑 카드에선 빠진다");
        let h = collect_history(&conn, &ws, 10).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].note_id, "hidden");
        assert_eq!(h[0].source_name.as_deref(), Some("src1"));
        assert_eq!(h[0].collected_at, "2026-10-01T11:00:00.000Z");
    }

    /// 최근 수집순 · limit(1..=100 클램프) · 삭제된 노트/다른 노트북/수집 아닌 노트 제외 · 소스가 삭제됐으면 이름만 null.
    #[test]
    fn collect_history_orders_newest_first_limits_and_excludes_trash_other_notebooks_and_non_collected() {
        let (conn, ws, f) = setup();
        note(&conn, &f, "a", Some("2026-10-01T09:00:00.000Z"));
        note(&conn, &f, "b", Some("2026-10-01T10:00:00.000Z"));
        note(&conn, &f, "c", Some("2026-10-01T11:00:00.000Z"));
        note(&conn, &f, "plain", None);
        note(&conn, &f, "trashed", Some("2026-10-01T12:00:00.000Z"));
        conn.execute("UPDATE notes SET deleted_at='2026-10-01T12:30:00.000Z' WHERE id='trashed'", []).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute("INSERT INTO folders(id, workspace_id, name, position, created_at) VALUES ('f2','ws2','x',0,'2026-01-01T00:00:00.000Z')", []).unwrap();
        note(&conn, "f2", "foreign", Some("2026-10-01T13:00:00.000Z"));

        let ids = |limit| collect_history(&conn, &ws, limit).unwrap().into_iter().map(|n| n.note_id).collect::<Vec<_>>();
        assert_eq!(ids(10), ["c", "b", "a"]);
        assert_eq!(ids(2), ["c", "b"]);
        assert_eq!(ids(0), ["c"], "limit 은 1 로 클램프");
        // 원본 소스 행이 없어도(삭제됨) 이력엔 남고 이름만 null.
        assert!(collect_history(&conn, &ws, 10).unwrap().iter().all(|n| n.source_name.is_none()));
        // 다른 노트북의 이력엔 그 노트북 것만.
        let other = collect_history(&conn, "ws2", 10).unwrap();
        assert_eq!(other.iter().map(|n| n.note_id.as_str()).collect::<Vec<_>>(), ["foreign"]);
    }

    /// 이력 정렬은 collected_at 부분 인덱스를 탄다 — 임시 B-tree 정렬 없이 LIMIT 이 일찍 끊긴다(플랜은 보고용으로 남긴다).
    #[test]
    fn collect_history_order_by_follows_the_collected_at_index() {
        let (conn, _ws, _f) = setup();
        let sql = format!("EXPLAIN QUERY PLAN {}", collect_history_sql());
        let mut st = conn.prepare(&sql).unwrap();
        let plan: Vec<String> = st
            .query_map(params!["ws", 30], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        eprintln!("[plan collect_history] {plan:?}");
        assert!(plan.iter().any(|d| d.contains("idx_notes_collected_alive")), "must read the collected_at index: {plan:?}");
        assert!(!plan.iter().any(|d| d.contains("TEMP B-TREE")), "no sort step expected: {plan:?}");
    }

    #[test]
    fn deleted_source_notes_stay_visible_and_default_is_on() {
        let (conn, ws, f) = setup();
        // src1 행이 아예 없다(삭제된 소스) — 조인 NULL 이므로 계속 보인다.
        note(&conn, &f, "orphan", Some("2026-10-01T11:00:00.000Z"));
        let r = recent_collected(&conn, &ws, None, 10, now()).unwrap();
        assert_eq!((r.new_count, r.items.len()), (1, 1));
        // 기본값(컬럼 생략)으로 만든 소스는 켜짐.
        source(&conn, &ws, "src3", None);
        let shown: i64 = conn.query_row("SELECT show_in_briefing FROM collect_sources WHERE id='src3'", [], |r| r.get(0)).unwrap();
        assert_eq!(shown, 1);
        conn.execute("UPDATE notes SET origin_source_id='src3' WHERE id='orphan'", []).unwrap();
        assert_eq!(recent_collected(&conn, &ws, None, 10, now()).unwrap().items.len(), 1);
    }

    fn act(conn: &Connection, ws: &str, note_id: Option<&str>, kind: &str, at: &str) {
        conn.execute(
            "INSERT INTO activity_log(id, workspace_id, note_id, kind, summary, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, 's', NULL, ?5)",
            params![crate::util::new_id(), ws, note_id, kind, at],
        )
        .unwrap();
    }

    fn ids(v: &[RecentWorkNote]) -> Vec<&str> {
        v.iter().map(|i| i.note_id.as_str()).collect()
    }

    #[test]
    fn recent_notes_groups_by_note_and_orders_by_last_activity() {
        let (conn, ws, f) = setup();
        for id in ["a", "b", "c"] {
            note(&conn, &f, id, None);
        }
        act(&conn, &ws, Some("a"), "create", "2026-10-01T09:00:00.000Z");
        act(&conn, &ws, Some("b"), "create", "2026-10-01T10:00:00.000Z");
        act(&conn, &ws, Some("a"), "edit", "2026-10-01T11:00:00.000Z"); // a 가 다시 맨 위로
        act(&conn, &ws, Some("c"), "delete", "2026-10-01T12:00:00.000Z"); // create/edit 만 센다
        act(&conn, &ws, Some("c"), "restore", "2026-10-01T12:00:00.000Z");
        act(&conn, &ws, None, "collect", "2026-10-01T12:30:00.000Z"); // note_id 없음
        let r = recent_notes(&conn, &ws, 10).unwrap();
        assert_eq!(ids(&r), ["a", "b"]);
        assert_eq!(r[0].last_at, "2026-10-01T11:00:00.000Z");
        assert_eq!(r[0].title, "a");
        let folder_name: String = conn.query_row("SELECT name FROM folders WHERE id=?1", [&f], |r| r.get(0)).unwrap();
        assert_eq!(r[0].folder_name.as_deref(), Some(folder_name.as_str()));
        // limit 클램프: 0 → 1, 상한 20.
        assert_eq!(ids(&recent_notes(&conn, &ws, 0).unwrap()), ["a"]);
        assert_eq!(recent_notes(&conn, &ws, 1000).unwrap().len(), 2);
    }

    #[test]
    fn recent_notes_limit_caps_at_20() {
        let (conn, ws, f) = setup();
        for i in 0..25 {
            let id = format!("n{i:02}");
            note(&conn, &f, &id, None);
            act(&conn, &ws, Some(&id), "edit", &format!("2026-10-01T10:{i:02}:00.000Z"));
        }
        let r = recent_notes(&conn, &ws, 50).unwrap();
        assert_eq!(r.len(), 20);
        assert_eq!(r[0].note_id, "n24");
        assert_eq!(ids(&recent_notes(&conn, &ws, 3).unwrap()), ["n24", "n23", "n22"]);
    }

    #[test]
    fn recent_notes_excludes_deleted_archived_empty_and_foreign() {
        let (conn, ws, f) = setup();
        for id in ["alive", "trashed", "archived", "empty", "untitled_with_body", "moved"] {
            note(&conn, &f, id, None);
            act(&conn, &ws, Some(id), "edit", "2026-10-01T10:00:00.000Z");
        }
        conn.execute("UPDATE notes SET deleted_at='2026-10-01T11:00:00.000Z' WHERE id='trashed'", []).unwrap();
        conn.execute("UPDATE notes SET archived_at='2026-10-01T11:00:00.000Z' WHERE id='archived'", []).unwrap();
        // 제목·본문 모두 빈 노트는 숨김, 제목이 비어도 본문이 있으면 보인다(activity_list 와 같은 판정).
        conn.execute("UPDATE notes SET title='Untitled Note' WHERE id IN ('empty','untitled_with_body')", []).unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position)
             VALUES ('s1','empty','x','<p></p>',0), ('s2','untitled_with_body','x','본문',0)",
            [],
        )
        .unwrap();
        // 다른 노트북: 그쪽 폴더로 옮겨 간 노트(활동 행은 이 노트북) + 그 노트북 자체의 활동.
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute("INSERT INTO folders(id, workspace_id, name, position, created_at) VALUES ('f2','ws2','x',0,'2026-01-01T00:00:00.000Z')", []).unwrap();
        conn.execute("UPDATE notes SET folder_id='f2' WHERE id='moved'", []).unwrap();
        note(&conn, "f2", "foreign", None);
        act(&conn, "ws2", Some("foreign"), "edit", "2026-10-01T12:00:00.000Z");
        let mut got = ids(&recent_notes(&conn, &ws, 20).unwrap()).into_iter().map(String::from).collect::<Vec<_>>();
        got.sort();
        assert_eq!(got, ["alive", "untitled_with_body"]);
        assert_eq!(ids(&recent_notes(&conn, "ws2", 20).unwrap()), ["foreign"]);
    }

    #[test]
    fn stamp_sets_origin_and_time() {
        let (conn, _ws, f) = setup();
        note(&conn, &f, "n1", None);
        stamp_collected(&conn, "n1", "srcX").unwrap();
        let (s, c): (String, String) = conn
            .query_row("SELECT origin_source_id, collected_at FROM notes WHERE id='n1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(s, "srcX");
        assert!(c.ends_with('Z'));
    }

    // ── block_create / note_quote (PLAN-2026-10-19-briefing-rewrite W2) ──────────────────────

    /// 받은편지함을 미리 만들지 않은 새 DB — "받은편지함 0개에서 시작"이 첫 생성 테스트의 전제다.
    fn fresh() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        (conn, ws)
    }

    fn count(conn: &Connection, sql: &str, p: &str) -> i64 {
        conn.query_row(sql, [p], |r| r.get(0)).unwrap()
    }

    fn notes_in(conn: &Connection, ws: &str) -> i64 {
        count(conn, "SELECT COUNT(*) FROM notes n JOIN folders f ON f.id = n.folder_id WHERE f.workspace_id = ?1", ws)
    }

    fn inboxes_in(conn: &Connection, ws: &str) -> i64 {
        count(conn, "SELECT COUNT(*) FROM folders WHERE workspace_id = ?1 AND name = 'Inbox'", ws)
    }

    fn inbox_key(conn: &Connection, ws: &str) -> Option<String> {
        crate::repo::settings::get_all(conn)
            .unwrap()
            .get(&format!("inbox_{ws}"))
            .and_then(|v| v.as_str().map(str::to_string))
    }

    fn first_section_name(conn: &Connection, note_id: &str) -> String {
        conn.query_row("SELECT name FROM sections WHERE note_id = ?1 ORDER BY position LIMIT 1", [note_id], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn block_create_writes_titled_note_with_primary_time_and_one_create_activity() {
        let (mut conn, ws) = fresh();
        let c = block_create(&mut conn, &ws, "2026-10-19", "09:00", "10:30", "  주간 계획  ").unwrap();

        // notes.* 투영(project_primary) — 달력·벨·알림이 읽는 쪽.
        #[allow(clippy::type_complexity)]
        let row: (String, i64, Option<i64>, Option<i64>, Option<String>, Option<String>, String) = conn
            .query_row(
                "SELECT title, year, month, day, start_time, end_time, folder_id FROM notes WHERE id = ?1",
                [&c.note_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .unwrap();
        assert_eq!(
            (&row.0[..], row.1, row.2, row.3, row.4.as_deref(), row.5.as_deref()),
            ("주간 계획", 2026, Some(10), Some(19), Some("09:00"), Some("10:30"))
        );
        // date_id = 그 노트의 대표 행(진실 쪽)이고 같은 시각을 갖는다 — 옮기기·늘리기는 이 행을 고친다.
        let (owner, pos, st, et): (String, i64, Option<String>, Option<String>) = conn
            .query_row("SELECT note_id, position, start_time, end_time FROM note_dates WHERE id = ?1", [&c.date_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!((owner.as_str(), pos, st.as_deref(), et.as_deref()), (c.note_id.as_str(), 0, Some("09:00"), Some("10:30")));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM note_dates WHERE note_id = ?1", &c.note_id), 1);
        // 받은편지함에 들어갔고, 활동 기록은 note_create 와 같이 create 한 줄.
        assert_eq!(inbox_key(&conn, &ws).as_deref(), Some(row.6.as_str()));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM activity_log WHERE note_id = ?1", &c.note_id), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM activity_log WHERE note_id = ?1 AND kind = 'create'", &c.note_id), 1);
        // 제목·본문 색인(FTS)도 같은 트랜잭션에서 들어갔다.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM notes_fts WHERE note_id = ?1", &c.note_id), 1);
    }

    #[test]
    fn block_create_never_makes_a_second_inbox() {
        let (mut conn, ws) = fresh();
        assert_eq!(inboxes_in(&conn, &ws), 0);
        let a = block_create(&mut conn, &ws, "2026-10-19", "09:00", "10:00", "하나").unwrap();
        let b = block_create(&mut conn, &ws, "2026-10-20", "14:00", "15:00", "둘").unwrap();
        let folder_of = |id: &str| -> String {
            conn.query_row("SELECT folder_id FROM notes WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        let inbox = folder_of(&a.note_id);
        assert_eq!(folder_of(&b.note_id), inbox);
        assert_eq!(inboxes_in(&conn, &ws), 1);
        assert_eq!(inbox_key(&conn, &ws), Some(inbox.clone()));
        // 수집·펫·모바일이 쓰는 서버측 규약과 같은 받은편지함이다.
        assert_eq!(folders::ensure_inbox_folder_id(&mut conn, &ws).unwrap(), inbox);
        assert_eq!(inboxes_in(&conn, &ws), 1);
    }

    #[test]
    fn block_create_invalid_input_writes_nothing() {
        let (mut conn, ws) = fresh();
        let notes_before = notes_in(&conn, &ws);
        let folders_before = count(&conn, "SELECT COUNT(*) FROM folders WHERE workspace_id = ?1", &ws);
        let activity_before = count(&conn, "SELECT COUNT(*) FROM activity_log WHERE workspace_id = ?1", &ws);
        for (day, s, e, title) in [
            ("2026-10-19", "09:00", "09:00", "길이 0"),
            ("2026-10-19", "10:00", "09:00", "거꾸로"),
            ("2026-10-19", "9:00", "10:00", "한 자리 시"),
            ("2026-10-19", "09:00", "24:00", "자정은 23:59 로"),
            ("2026-10-19", "09:60", "10:00", "60분"),
            ("2026-02-30", "09:00", "10:00", "없는 날"),
            ("2026/10/19", "09:00", "10:00", "형식"),
            ("2026-10-19", "09:00", "10:00", "   "),
            ("2026-10-19", "09:00", "10:00", ""),
        ] {
            let r = block_create(&mut conn, &ws, day, s, e, title);
            assert!(matches!(r, Err(AppError::Validation(_))), "{day} {s}-{e} {title:?} → {r:?}");
        }
        assert_eq!(notes_in(&conn, &ws), notes_before);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM folders WHERE workspace_id = ?1", &ws), folders_before);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM activity_log WHERE workspace_id = ?1", &ws), activity_before);
        assert_eq!(inbox_key(&conn, &ws), None, "검증 실패는 받은편지함도 만들지 않는다");
    }

    #[test]
    fn hook_failure_rolls_back_note_sections_dates_and_fts() {
        let (mut conn, ws) = fresh();
        let folder = folders::ensure_inbox_folder_id(&mut conn, &ws).unwrap();
        let before = notes_in(&conn, &ws);
        let activity_before = count(&conn, "SELECT COUNT(*) FROM activity_log WHERE workspace_id = ?1", &ws);
        let r = notes::create_today_default_with_hook(&mut conn, &folder, Some("반쪽".into()), Some(2026), Some(10), Some(19), |tx, id| {
            tx.execute("UPDATE note_dates SET start_time = '09:00' WHERE note_id = ?1 AND position = 0", [id]).map_err(dberr)?;
            Err(AppError::Validation("boom".into()))
        });
        assert!(matches!(r, Err(AppError::Validation(_))));
        assert_eq!(notes_in(&conn, &ws), before);
        let orphans: i64 = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM sections WHERE note_id NOT IN (SELECT id FROM notes))
                      + (SELECT COUNT(*) FROM note_dates WHERE note_id NOT IN (SELECT id FROM notes))
                      + (SELECT COUNT(*) FROM notes_fts WHERE note_id NOT IN (SELECT id FROM notes))",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM activity_log WHERE workspace_id = ?1", &ws), activity_before);
    }

    #[test]
    fn block_create_first_section_name_follows_ui_lang() {
        let (mut conn, ws) = fresh();
        let ko = block_create(&mut conn, &ws, "2026-10-19", "09:00", "10:00", "기본").unwrap();
        assert_eq!(first_section_name(&conn, &ko.note_id), "개요");
        // 실제 저장 경로(settings::set → 활성 노트북의 workspace_settings)로 바꾼다 — 목이 아니라 왕복.
        for (lang, expected) in [("en", "Overview"), ("fr", "Aperçu"), ("ko", "개요")] {
            let mut entries = std::collections::BTreeMap::new();
            entries.insert("ui_lang".to_string(), serde_json::Value::String(lang.into()));
            crate::repo::settings::set(&mut conn, &entries).unwrap();
            let c = block_create(&mut conn, &ws, "2026-10-19", "11:00", "12:00", lang).unwrap();
            assert_eq!(first_section_name(&conn, &c.note_id), expected, "ui_lang={lang}");
        }
    }

    /// 인용 테스트는 시드 노트와 섞이지 않게 빈 노트북 하나를 따로 만든다.
    fn quote_notebook(conn: &mut Connection) -> (String, String) {
        conn.execute("INSERT INTO workspaces(id, name, created_at) VALUES ('wsq', 'q', '2026-01-01T00:00:00.000Z')", [])
            .unwrap();
        let folder = folders::ensure_inbox_folder_id(conn, "wsq").unwrap();
        ("wsq".to_string(), folder)
    }

    fn put_note(conn: &mut Connection, folder: &str, title: &str, body: &str) -> String {
        let d = notes::create(conn, folder, Some(title.into()), Some(2026)).unwrap();
        conn.execute("UPDATE sections SET body_md = ?1 WHERE note_id = ?2", params![body, d.note.id]).unwrap();
        d.note.id
    }

    #[test]
    fn note_quote_is_none_when_nothing_is_quotable() {
        let (mut conn, _) = fresh();
        let (ws, f) = quote_notebook(&mut conn);
        assert_eq!(note_quote(&conn, &ws, None).unwrap(), None, "노트 0");

        put_note(&mut conn, &f, "빈", "");
        put_note(&mut conn, &f, "제목만", "# 회의 메모\n\n## 안건\n");
        put_note(&mut conn, &f, "짧음", "짧은 말");
        put_note(&mut conn, &f, "그림·코드", "![사진](attachments/a.png)\n\n```\nlet readable = 'not a quote';\n```\n---");
        let trashed = put_note(&mut conn, &f, "휴지통", "읽을 수 있는 문장이지만 지워졌다");
        conn.execute("UPDATE notes SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?1", [&trashed]).unwrap();
        let archived = put_note(&mut conn, &f, "보관", "읽을 수 있는 문장이지만 보관됐다");
        conn.execute("UPDATE notes SET archived_at = '2026-10-01T00:00:00.000Z' WHERE id = ?1", [&archived]).unwrap();
        let diagram = put_note(&mut conn, &f, "도식", "{\"nodes\":[{\"label\":\"읽을 수 있는 긴 라벨\"}]}");
        conn.execute("UPDATE sections SET kind = 'diagram' WHERE note_id = ?1", [&diagram]).unwrap();
        let noisy = folders::create(&mut conn, "수집", Some(ws.clone()), None, None, None).unwrap();
        conn.execute("UPDATE folders SET search_excluded = 1 WHERE id = ?1", [&noisy.id]).unwrap();
        put_note(&mut conn, &noisy.id, "소음", "검색 제외 폴더의 읽을 수 있는 문장");

        assert_eq!(note_quote(&conn, &ws, None).unwrap(), None);
    }

    #[test]
    fn note_quote_returns_readable_first_paragraph_and_honours_exclude() {
        let (mut conn, seed_ws) = fresh();
        let (ws, f) = quote_notebook(&mut conn);
        let a = put_note(&mut conn, &f, "일기", "# 10월 19일\n\n- [ ] **오늘은** 산책을 [길게](https://example.com) 했다.\n");
        let q = note_quote(&conn, &ws, None).unwrap().unwrap();
        assert_eq!(q, NoteQuote { note_id: a.clone(), title: "일기".into(), text: "오늘은 산책을 길게 했다.".into() });
        // 인용할 수 있는 노트가 그것뿐이면 exclude 여도 그것을 준다(거짓 빈 상태 금지).
        assert_eq!(note_quote(&conn, &ws, Some(&a)).unwrap().unwrap().note_id, a);

        let b = put_note(&mut conn, &f, "메모", "<p>색 <span style=\"color: red\">글자</span> 문장 &amp; 기호</p>");
        for _ in 0..12 {
            let q = note_quote(&conn, &ws, Some(&a)).unwrap().unwrap();
            assert_eq!((q.note_id.as_str(), q.text.as_str()), (b.as_str(), "색 글자 문장 & 기호"));
        }
        // exclude 가 없으면 둘 다 나올 수 있다(무작위) — 다른 노트북의 노트는 절대 안 나온다.
        for _ in 0..12 {
            let id = note_quote(&conn, &ws, None).unwrap().unwrap().note_id;
            assert!(id == a || id == b, "{id}");
        }
        if let Some(q) = note_quote(&conn, &seed_ws, None).unwrap() {
            assert!(q.note_id != a && q.note_id != b);
        }
    }

    /// 후보 풀이 `idx_notes_updated_alive` 를 거꾸로 훑고 LIMIT 에서 멈춘다 — 통계 없는 부팅 직후 플래너는 조인 형태면
    /// `idx_notes_year_alive` 전량 스캔 + 정렬을 골랐다(이 쿼리를 처음 쓴 날 실측). 정렬 B-트리는 바깥 random() 하나뿐이어야 한다.
    #[test]
    fn quote_pool_rides_the_updated_index() {
        let (conn, ws) = fresh();
        let mut st = conn.prepare(&format!("EXPLAIN QUERY PLAN {QUOTE_POOL_SQL}")).unwrap();
        let plan: Vec<String> =
            st.query_map(params![ws, QUOTE_POOL], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect();
        assert!(plan.iter().any(|l| l.contains("idx_notes_updated_alive")), "{plan:#?}");
        assert_eq!(plan.iter().filter(|l| l.contains("TEMP B-TREE")).count(), 1, "{plan:#?}");
    }

    #[test]
    fn readable_excerpt_strips_markup_and_caps_length() {
        let ex = |s: &str| readable_excerpt(s);
        assert_eq!(ex("> > 인용된 *강조* 문장이다").as_deref(), Some("인용된 강조 문장이다"));
        assert_eq!(ex("1. 첫째 항목입니다").as_deref(), Some("첫째 항목입니다"));
        assert_eq!(ex("* [x] 끝낸 할 일 하나").as_deref(), Some("끝낸 할 일 하나"));
        // `#태그` 로 시작하는 본문 줄은 제목이 아니다.
        assert_eq!(ex("#태그 로 시작하는 본문").as_deref(), Some("#태그 로 시작하는 본문"));
        assert_eq!(ex("---\n| a | b |\n|---|---|\n본문 줄입니다").as_deref(), Some("본문 줄입니다"));
        assert_eq!(ex("a \\<b\\> 그리고 \\*별\\*").as_deref(), Some("a <b> 그리고 *별*"));
        assert_eq!(ex("~~취소~~ ==형광== `코드` 끝 snake_case").as_deref(), Some("취소 형광 코드 끝 snake_case"));
        assert_eq!(ex("![그림](a.png) 그림 뒤의 설명 문장").as_deref(), Some("그림 뒤의 설명 문장"));
        assert_eq!(ex("<table><tr><td><p>성명</p></td><td><p>정보</p></td></tr></table>\n실제 문장입니다").as_deref(), Some("실제 문장입니다"));
        assert_eq!(ex("```\n코드 블록 안의 긴 줄\n```\n바깥 문장입니다").as_deref(), Some("바깥 문장입니다"));
        // 6자 문턱은 글자 수(바이트 아님).
        assert_eq!(ex("다섯글자다"), None);
        assert_eq!(ex("여섯글자이다").as_deref(), Some("여섯글자이다"));
        let long = "가".repeat(250);
        let capped = ex(&long).unwrap();
        assert_eq!(capped.chars().count(), QUOTE_MAX_CHARS + 1);
        assert!(capped.ends_with('…'));
        assert_eq!(ex("[링크만 있는 줄](https://example.com)").as_deref(), Some("링크만 있는 줄"));
    }
}
