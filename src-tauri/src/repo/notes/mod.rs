// repo: notes — commands/notes.yaml 의 note_* 커맨드와 1:1
// note_regions(경유지) 테이블은 별도 트랜잭션 규율·NoteRegion 모델이라 regions.rs 로 분리했다
// (리팩토링 웨이브 C, note_query.rs 의 Wave A-4 선례와 같은 취지) — `pub use` 로 재수출하므로
// 호출부는 그대로 `notes::*` 로 접근한다.
pub mod regions;
pub use regions::*;
// note_dates(추가 날짜, GRILL-2026-09-07 D2) — note_regions 의 형제, 같은 이유로 분리.
pub mod dates;
pub use dates::*;

use crate::db;
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::{NoteDetail, NoteSummary};
use crate::repo::note_summary_row::{map_summary_base, SUMMARY_COLS};
use crate::repo::{attachments, fts, sections, settings, sources};
use crate::util::{new_id, now_iso};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::Path;

const YEAR_MIN: i64 = -9999;
const YEAR_MAX: i64 = 9999;

/// 새 노트 첫 섹션의 기본 이름 — `create_with_sections`가 지금까지 항상 심어온 리터럴을 이름 있는
/// 상수로 승격(2026-09-20, 아래 실험적 `new_note_section_name` 설정이 이 기본값의 대체재로 쓰인다).
const DEFAULT_SECTION_NAME: &str = "Overview";


/// GET /api/v1/notes (모바일 웹 클라이언트 피드) 한 페이지 — base row.
pub struct FeedPageRow {
    pub id: String,
    pub title: String,
    pub year: i64,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub folder_id: String,
    pub folder_name: String,
    pub updated_at: String,
    pub has_attachments: bool,
}

/// feed_page() 반환값 — sync_server::handlers::notes_list 가 그대로 조립해 JSON으로 만든다
/// (배치 3종을 여기 한 곳에서 다 실어 온다: has_more 판정용 LIMIT+1, 섹션은 노트당 처음
/// `section_scan_limit`개만, 태그/첨부는 기존과 동일하게 노트 전체).
pub struct FeedPage {
    pub rows: Vec<FeedPageRow>,
    pub has_more: bool,
    pub sections_by_note: HashMap<String, Vec<crate::models::Section>>,
    pub tags_by_note: HashMap<String, Vec<(String, String)>>,
    pub attachments_by_note: HashMap<String, Vec<crate::models::Attachment>>,
}

/// 노트당 처음 `n`개 섹션(position 순)만 배치 로드 — sections::load_for_ids 의 "노트당 전체"와
/// 달리 feed_page 전용으로 여기 둔다(피드 카드가 실제로 읽는 건 excerpt용 첫 섹션 +
/// checklist용 앞쪽 몇 개뿐인데, 예전엔 노트마다 몇 십 개짜리 섹션 body_md 전체를 워크스페이스
/// 전체 노트 수만큼 읽어왔다 — 이 함수가 그 비효율의 핵심 수정 지점). SQLite 3.25+ 윈도우
/// 함수(ROW_NUMBER)는 rusqlite의 bundled SQLite가 이미 지원한다.
fn load_first_n_sections_for_ids(
    conn: &Connection,
    note_ids: &[String],
    n: i64,
) -> AppResult<HashMap<String, Vec<crate::models::Section>>> {
    let mut out: HashMap<String, Vec<crate::models::Section>> = HashMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    for chunk in note_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");
        // Plain "?" placeholders auto-number in source order (SQLite), so the trailing "?" for
        // `n` lines up with the last element of `binds` below without needing explicit "?N".
        let sql = format!(
            "SELECT id, note_id, name, body_md, position, kind, ai_origin, updated_at FROM (
                 SELECT id, note_id, name, body_md, position, kind, ai_origin, updated_at,
                        ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY position) AS rn
                 FROM sections WHERE note_id IN ({placeholders})
             ) WHERE rn <= ?"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let mut binds: Vec<Value> = chunk.iter().map(|s| Value::Text(s.clone())).collect();
        binds.push(Value::Integer(n));
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    crate::models::Section {
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

/// GET /api/v1/notes (모바일 웹 클라이언트 피드) 전용 배치 쿼리 — CLIENT-RULES §2 규칙4("핸들러가
/// SQL을 직접 들고 있으면 안 된다")를 지키기 위해 sync_server::handlers::notes_list 의 인라인 SQL을
/// 이리로 옮겼다. note_query.rs 의 범용 필터 엔진(폴더/연도/태그/좌표…)과는 목적이 겹치지 않아
/// 재사용하지 않는다 — 여기는 필터 축이 없고(워크스페이스 전체, updated_at DESC 고정) 대신
/// "LIMIT을 세 배치 조회보다 먼저 적용"과 "섹션은 노트당 앞쪽 몇 개만" 두 가지가 핵심(과제
/// 효율화 지시: 예전엔 LIMIT이 아예 없어 워크스페이스의 모든 노트에 대해 풀 섹션 배치를 매번
/// 읽었다). `limit`은 note_query.rs 와 동일한 상한(NOTE_QUERY_MAX_LIMIT)으로 clamp — 별도
/// 상수를 새로 만들지 않는다. `has_more`는 COUNT(*) 없이 LIMIT+1로 판정한다(별도 카운트 쿼리
/// 하나를 아끼는 흔한 페이지네이션 트릭).
pub fn feed_page(
    conn: &Connection,
    workspace_id: &str,
    limit: i64,
    section_scan_limit: i64,
) -> AppResult<FeedPage> {
    let capped_limit = limit.clamp(1, crate::repo::note_query::NOTE_QUERY_MAX_LIMIT);
    let fetch = capped_limit + 1;
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.year, n.month, n.day, n.folder_id, f.name, n.updated_at,
                    EXISTS(SELECT 1 FROM attachments a WHERE a.note_id = n.id)
             FROM notes n JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL
             ORDER BY n.updated_at DESC
             LIMIT ?2",
        )
        .map_err(dberr)?;
    let mapped = stmt
        .query_map(params![workspace_id, fetch], |r| {
            Ok(FeedPageRow {
                id: r.get(0)?,
                title: r.get(1)?,
                year: r.get(2)?,
                month: r.get(3)?,
                day: r.get(4)?,
                folder_id: r.get(5)?,
                folder_name: r.get(6)?,
                updated_at: r.get(7)?,
                has_attachments: r.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(dberr)?;
    let mut rows: Vec<FeedPageRow> = mapped.collect::<Result<Vec<_>, _>>().map_err(dberr)?;
    drop(stmt);
    let has_more = rows.len() as i64 > capped_limit;
    rows.truncate(capped_limit as usize);

    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let sections_by_note = load_first_n_sections_for_ids(conn, &ids, section_scan_limit)?;
    let tags_by_note = tag_refs_for_ids(conn, &ids)?;
    let attachments_by_note = attachments::load_for_ids(conn, &ids)?;

    Ok(FeedPage { rows, has_more, sections_by_note, tags_by_note, attachments_by_note })
}


fn has_image(conn: &Connection, note_id: &str) -> AppResult<bool> {
    // 단일 노트 경로는 attachments 모듈의 온디맨드 헬퍼와 동일 구현을 공유한다.
    crate::repo::attachments::has_image_for_note(conn, note_id)
}

/// note_id 로 NoteSummary 조립 (미존재 시 NOT_FOUND).
pub fn note_summary(conn: &Connection, note_id: &str) -> AppResult<NoteSummary> {
    let base = conn
        .query_row(
            &format!("SELECT {SUMMARY_COLS} FROM notes WHERE id = ?1"),
            [note_id],
            map_summary_base,
        )
        .optional()
        .map_err(dberr)?;
    // region_names 는 비워 둔다 — models.rs 주석대로 note_summaries_map 만 채운다.
    let mut summary = base.ok_or_else(|| AppError::NotFound(format!("note not found: {note_id}")))?;
    summary.tag_names = tag_names(conn, &summary.id)?;
    summary.has_image = has_image(conn, &summary.id)?;
    Ok(summary)
}

/// N+1 배치 헬퍼 (`repo/folders.rs::list` 과 동일한 3-쿼리 패턴): 여러 note_id 를
/// base rows 1회 + tag join 1회 + has_image EXISTS 1회로 조립해 HashMap(id -> NoteSummary)
/// 로 반환한다. `note_summary`(단수형)를 반복 호출하던 루프 사이트(search/related/vector)의
/// N×3 쿼리를 3쿼리 고정으로 줄이기 위한 용도. 존재하지 않는 id 는 맵에 키가 없다 —
/// 단수형 `note_summary` 와 달리 NotFound 를 발생시키지 않는다(호출부가 이미 notes 테이블
/// 조회로 얻은 id 목록을 넘기는 것을 전제로 하므로 존재는 사실상 보장된다).
pub fn note_summaries_map(conn: &Connection, ids: &[String]) -> AppResult<HashMap<String, NoteSummary>> {
    note_summaries_map_internal(conn, ids, false)
}

/// `include_deleted: true` 는 휴지통 화면 전용이다 — 정상 목록(search/related/vector)이 이 플래그를
/// 켜면 삭제된 노트가 그대로 새어나간다. 그래서 모듈 밖으로 노출하지 않는다: 크레이트의 다른 곳은
/// 필터가 항상 걸린 `note_summaries_map` 만 볼 수 있다.
fn note_summaries_map_internal(
    conn: &Connection,
    ids: &[String],
    include_deleted: bool,
) -> AppResult<HashMap<String, NoteSummary>> {
    let mut out: HashMap<String, NoteSummary> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    // Scale: SQLite 변수 상한(~32k)을 넘기지 않도록 id 를 청크로 나눠 조회한다. 청크는 노트를 서로
    // 겹치지 않게 분할하므로, 각 청크가 자기 노트의 base/tags/has_image 를 독립적으로 완성해 공유
    // out 에 합치면 된다(청크 간 상호작용 없음). 예전엔 전체 id 를 한 IN 절에 넣어 대규모 코퍼스
    // (search/vector 재색인)에서 "too many SQL variables" 로 실패했다.
    for chunk in ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let binds: Vec<Value> = chunk.iter().map(|s| Value::Text(s.clone())).collect();

        // 1) base rows. include_deleted 에 따라 deleted_at IS NULL 필터를 조건부 적용.
        let deleted_filter = if include_deleted { "" } else { " AND deleted_at IS NULL" };
        let sql = format!(
            "SELECT {SUMMARY_COLS} FROM notes WHERE id IN ({placeholders}){deleted_filter}"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_summary_base)
            .map_err(dberr)?;
        for row in rows {
            // map_summary_base 는 has_image=false / tag_names=[] 로 시작한다 — 아래 2)(name
            // COLLATE NOCASE 순서로 push) 와 3) 이 채운다.
            let mut summary = row.map_err(dberr)?;
            // region_names 시드: 대표 지역이 있으면 1개로 시작 — 아래 2.5) 가 경유지
            // 이름을 이어붙인다(models.rs 주석: 이 함수만 실제로 union 을 채운다).
            summary.region_names = summary.region.iter().cloned().collect();
            out.insert(summary.id.clone(), summary);
        }
        drop(stmt);

        // 2) tag join — 이름 오름차순으로 정렬된 결과를 note_id 별로 스티칭하면, 각 노트 내부의
        // push 순서는 여전히 t.name COLLATE NOCASE 오름차순이 된다 (단수형 tag_names() 와 동일).
        let tags_sql = format!(
            "SELECT nt.note_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
             WHERE nt.note_id IN ({placeholders}) ORDER BY t.name COLLATE NOCASE"
        );
        let mut tags_stmt = conn.prepare(&tags_sql).map_err(dberr)?;
        let tag_rows = tags_stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(dberr)?;
        for row in tag_rows {
            let (note_id, tag_name) = row.map_err(dberr)?;
            if let Some(summary) = out.get_mut(&note_id) {
                summary.tag_names.push(tag_name);
            }
        }
        drop(tags_stmt);

        // 2.5) N2-2: 경유지(note_regions) 이름을 region_names 에 이어붙인다 — note_query 의
        // RegionFilterSpec::Eq 가 쓰는 것과 동일한 union(대표 ∪ 경유지)을 이 배치 경로(검색/
        // related)의 클라 후처리 필터도 볼 수 있게 한다.
        let regions_sql = format!(
            "SELECT note_id, name FROM note_regions WHERE note_id IN ({placeholders}) ORDER BY position ASC"
        );
        let mut regions_stmt = conn.prepare(&regions_sql).map_err(dberr)?;
        let region_rows = regions_stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(dberr)?;
        for row in region_rows {
            let (note_id, region_name) = row.map_err(dberr)?;
            if let Some(summary) = out.get_mut(&note_id) {
                summary.region_names.push(region_name);
            }
        }
        drop(regions_stmt);

        // 3) has_image — DISTINCT note_id 배치, 단수형의 EXISTS 와 동치.
        let img_sql = format!(
            "SELECT DISTINCT note_id FROM attachments WHERE kind='image' AND note_id IN ({placeholders})"
        );
        let mut img_stmt = conn.prepare(&img_sql).map_err(dberr)?;
        let img_rows = img_stmt
            .query_map(params_from_iter(binds.iter()), |r| r.get::<_, String>(0))
            .map_err(dberr)?;
        for row in img_rows {
            let note_id = row.map_err(dberr)?;
            if let Some(summary) = out.get_mut(&note_id) {
                summary.has_image = true;
            }
        }
    }

    Ok(out)
}

/// `ids` 의 순서를 보존하며 `note_summaries_map` 을 조립한다 — search 결과(relevance/recency)나
/// `related` 처럼 순서 자체가 의미를 갖는 호출부용. 맵을 먼저 만든 뒤(배치 쿼리 3회) `ids` 를
/// 그대로 훑어 매핑한다 — 배치 쿼리 자체의 행 순서에는 의존하지 않는다. 존재하지 않는 id 는
/// 결과에서 생략된다.
pub fn note_summaries_for_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<NoteSummary>> {
    let map = note_summaries_map(conn, ids)?;
    Ok(ids.iter().filter_map(|id| map.get(id).cloned()).collect())
}

/// Wave 7 (P30) + 연관노트 신호 확장: 관련 노트 — 같은 워크스페이스 내에서 자기 자신을 제외하고
/// 4개 신호를 합산한 score desc(동점 시 updated_at desc)로 최대 limit개 반환:
///   score = backlink_count*100                     — 최상위: 다른 노트가 나를 internal 첨부로 언급
///         + (event_date_match ? 30 : 0)             — 중간: 사건 날짜(year/month/day) 완전 일치
///         + shared_attachment_count*15              — 중간: content_hash 가 같은 첨부 공유
///         + shared_tag_count*10                     — 하위(기존): 공유 태그 수
///         + max(0, 10 - abs(year_diff)/10)          — 하위(기존): 연도 근접
/// event_date_match 는 "공유된 정밀도까지" 비교한다 — 둘 다 day 정밀도면 y/m/d 전부, 한쪽이라도
/// month/day 가 NULL 이면 그 아래 정밀도(년, 또는 년+월)까지만 비교한다.
/// 점수 계산은 단일 SQL(다중 LEFT JOIN + GROUP BY n2.id)로 수행한다. COUNT(DISTINCT x.id) 는 다른
/// LEFT JOIN 이 만드는 카티전 곱과 무관하게 정확하다(각 조인의 고유 id 기준으로 세므로).
/// 컷오프 규칙(기존 유지): score > 0 인 것만 반환한다(HAVING) — "채워 넣기용"으로 무관한 노트를
/// 반환하지 않는다. limit보다 적게(혹은 0개) 반환되는 것은 정상 동작이다(호출부 UI는 빈 목록을
/// 이미 처리한다).
pub fn related(conn: &Connection, note_id: &str, limit: i64) -> AppResult<Vec<NoteSummary>> {
    // 존재 확인 + 기준 연도/월/일/워크스페이스 조회 (event_date_match·year_diff·workspace 격리에 사용).
    let (year, month, day, workspace_id): (i64, Option<i64>, Option<i64>, String) = conn
        .query_row(
            "SELECT n.year, n.month, n.day, f.workspace_id FROM notes n
             JOIN folders f ON f.id = n.folder_id
             WHERE n.id = ?1",
            [note_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("note not found: {note_id}")))?;

    // Cutoff rule (fix for "related notes look random"): a note only counts as genuinely
    // related if it earns a positive score across any of the 4 signals below. A note that
    // matches none of them (no backlink, no shared event date, no shared attachment, no shared
    // tag, and a year 100+ years apart) scores exactly 0 and is excluded by the HAVING clause,
    // rather than being padded in just to fill LIMIT. Returning fewer than `limit` rows — or
    // none at all — is a valid outcome.
    let mut stmt = conn
        .prepare(
            "SELECT n2.id,
                    (COUNT(DISTINCT backlink.id) * 100
                     + CASE WHEN n2.year = ?1
                             AND (n2.month IS NULL OR ?5 IS NULL OR (n2.month = ?5
                                   AND (n2.day IS NULL OR ?6 IS NULL OR n2.day = ?6)))
                            THEN 30 ELSE 0 END
                     + COUNT(DISTINCT shared_att.id) * 15
                     + COUNT(DISTINCT shared_tag.tag_id) * 10
                     + MAX(0, 10 - ABS(n2.year - ?1) / 10)) AS score
             FROM notes n2
             JOIN folders f2 ON f2.id = n2.folder_id
             -- 최상위 신호: n2 가 나(source note_id=?2)를 internal 첨부로 언급(백링크).
             LEFT JOIN attachments backlink
                    ON backlink.note_id = n2.id
                   AND backlink.kind = 'internal'
                   AND backlink.url = ?2
             -- 중간 신호: n2 와 내가 같은 content_hash 를 가진 첨부를 공유(hash NULL은 제외).
             LEFT JOIN attachments shared_att
                    ON shared_att.note_id = n2.id
                   AND shared_att.content_hash IS NOT NULL
                   AND shared_att.content_hash IN (
                         SELECT content_hash FROM attachments
                         WHERE note_id = ?2 AND content_hash IS NOT NULL)
             -- 하위(기존) 신호: 공유 태그 수.
             LEFT JOIN note_tags shared_tag
                    ON shared_tag.note_id = n2.id
                   AND shared_tag.tag_id IN (SELECT tag_id FROM note_tags WHERE note_id = ?2)
             WHERE f2.workspace_id = ?3 AND n2.id != ?2 AND n2.deleted_at IS NULL
               AND NOT EXISTS (
                     SELECT 1 FROM note_related_exclusions x
                     WHERE (x.id_1 = ?2 AND x.id_2 = n2.id)
                        OR (x.id_1 = n2.id AND x.id_2 = ?2)
                   )
             GROUP BY n2.id
             HAVING score > 0
             ORDER BY score DESC, n2.updated_at DESC
             LIMIT ?4",
        )
        .map_err(dberr)?;
    let ids: Vec<String> = stmt
        .query_map(
            params![year, note_id, workspace_id, limit, month, day],
            |r| r.get::<_, String>(0),
        )
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    // 배치 조립(3쿼리 고정) — ids 의 score/updated_at 정렬 순서를 그대로 보존한다.
    note_summaries_for_ids(conn, &ids)
}

/// NoteDetail 조립 (NoteSummary + 하위 콘텐츠 전체).
pub fn note_detail(conn: &Connection, note_id: &str) -> AppResult<NoteDetail> {
    let note = note_summary(conn, note_id)?;
    Ok(NoteDetail {
        sections: sections::load_for_note(conn, note_id)?,
        sources: sources::load_for_note(conn, note_id)?,
        attachments: attachments::load_for_note(conn, note_id)?,
        note,
    })
}

/// `note_get_many` 한 번에 받는 id 상한 — 응답 크기(노트마다 섹션 본문 전체)를 묶는다. 프런트
/// `components/home/calendar/useDayDetailData.ts::NOTE_GET_MANY_MAX` 와 같은 값이어야 한다(그쪽이
/// 이보다 많은 날을 청크로 나눠 보낸다).
pub const NOTE_GET_MANY_MAX: usize = 500;

/// 배치 `note_get` — 여러 노트의 NoteDetail 을 **한 연결에서** 읽어 `ids` 입력 순서대로 돌려준다
/// (대시보드 달력 날짜 패널이 노트마다 note_get 을 부르던 N+1 대체, specs/commands/notes.yaml).
/// 없는 id·휴지통(soft-delete) 노트는 빠진다(에러 아님) — 단수형 `note_detail` 은 휴지통 노트도
/// 돌려주지만(휴지통 화면이 열어야 하므로) 배치는 목록 경로라 `note_summaries_map` 과 같은 규칙이다.
/// 아카이브 노트는 단수형처럼 거르지 않는다. 같은 id 가 여러 번 오면 첫 자리에 한 번만.
/// 상한(`NOTE_GET_MANY_MAX`) 초과는 VALIDATION.
/// ponytail: 살아 있는 id 마다 `note_detail`(쿼리 6회)을 그대로 돈다 — 비용의 거의 전부가 IPC 왕복이었고,
/// 같은 함수를 타야 note_get 과 결과가 정확히 같다. 더 줄여야 하면 sections/attachments::load_for_ids
/// 배치로 바꾼다(sources 는 아직 배치 로더가 없다).
pub fn note_details_for_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<NoteDetail>> {
    if ids.len() > NOTE_GET_MANY_MAX {
        return Err(AppError::Validation(format!(
            "note_get_many: too many ids ({} > {NOTE_GET_MANY_MAX})",
            ids.len()
        )));
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // 상한이 IN_CHUNK 보다 훨씬 작아 청크 없이 한 IN 절로 충분하다.
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id FROM notes WHERE id IN ({placeholders}) AND deleted_at IS NULL"
        ))
        .map_err(dberr)?;
    let alive: std::collections::HashSet<String> = stmt
        .query_map(params_from_iter(ids.iter()), |r| r.get::<_, String>(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    let mut emitted: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(alive.len());
    for id in ids {
        if alive.contains(id) && emitted.insert(id.as_str()) {
            out.push(note_detail(conn, id)?);
        }
    }
    Ok(out)
}

pub fn create(
    conn: &mut Connection,
    folder_id: &str,
    title: Option<String>,
    year: Option<i64>,
) -> AppResult<NoteDetail> {
    create_with_timestamp(conn, folder_id, title, year, None, None, None, None)
}

// ── 실험적: 노트북별 새 노트 기본값 (오너 결정 2026-09-20, "넣어봐, 보고 이상하면 지울게") ──────
// 노트북 설정 두 개(`new_note_date_precision` / `new_note_section_name`)가 `create_today_default`
// (= note_create 커맨드의 단일 경유지)에서 "오늘" 기본값의 정밀도와 첫 섹션 이름을 바꾼다. 키
// 자체의 허용목록·기본값·NOTEBOOK_KEYS 등록은 다른 세션이 settings_schema.rs/db/migrations.rs/
// specs/db/schemas/settings.sql 에서 동시에 진행 중이라 이 웨이브는 그 파일들을 전혀 건드리지
// 않는다 — repo::settings::notebook_setting_raw 로 원시 JSON만 읽고, 기본값·shape 검증은 전부 이
// 블록에 자체 보관한다(그래서 저 허용목록에 아직 없어도, 나중에 등록된 뒤에도 동일하게 동작한다).
// 지우려면 이 블록 전체 + create_today_default 안의 관련 호출 두 줄 + 관련 테스트만 걷어내면 된다.
//
// 노트는 **폴더** 안에서 만들어지고, 그 폴더의 노트북이 활성 노트북과 다를 수 있다(AI 디스패치/
// 가져오기/동기화 HTTP 핸들러가 비활성 노트북의 폴더에 쓸 수 있음) — 그래서 항상 `folder_id` 로부터
// 노트북을 역산해서(`folder_workspace_id`) 그 노트북의 값을 읽는다(활성 노트북이 아니다).

/// 새 노트 "오늘" 기본값의 정밀도.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum NewNoteDatePrecision {
    Day,
    Month,
    Year,
}

/// `folders.workspace_id` — 폴더가 속한 노트북. 폴더가 없으면 None(호출부가 그대로 기본값 경로로
/// 진행하고, 그 뒤 실제 생성 시도에서 기존과 동일하게 NOT_FOUND 로 실패한다 — 이 조회 자체가 새
/// 에러 경로를 만들지 않는다).
fn folder_workspace_id(conn: &Connection, folder_id: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT workspace_id FROM folders WHERE id = ?1",
        [folder_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(dberr)
}

/// `new_note_date_precision` 파싱 — "day"(기본)/"month"/"year" 외의 값(누락, 구/손상 DB, 아직
/// 허용목록에 없는 값, 오탈자, 문자열이 아닌 JSON)은 전부 기본값(Day = 오늘까지의 동작)으로
/// 폴백한다. 저장 시점 검증이 아니라 **읽는 시점**에 다시 검증하는 이유: 이 값은 아직
/// `settings_schema::validate_setting` 의 보호를 받지 못할 수도 있다(등록 경합).
fn resolve_new_note_date_precision(conn: &Connection, workspace_id: &str) -> NewNoteDatePrecision {
    match settings::notebook_setting_raw(conn, workspace_id, "new_note_date_precision") {
        Ok(Some(JsonValue::String(s))) => match s.as_str() {
            "month" => NewNoteDatePrecision::Month,
            "year" => NewNoteDatePrecision::Year,
            _ => NewNoteDatePrecision::Day,
        },
        _ => NewNoteDatePrecision::Day,
    }
}

/// `new_note_section_name` 파싱 — trim 후 비어있지 않고 40자 이하, 개행 없는 문자열만 채택.
/// 그 외(누락, JSON 파싱 실패, 문자열이 아님, 검증 실패)는 None — 호출부가 언어별 기본값
/// (`default_section_name_for_lang`)으로 폴백한다.
fn resolve_new_note_section_name(conn: &Connection, workspace_id: &str) -> Option<String> {
    let raw = settings::notebook_setting_raw(conn, workspace_id, "new_note_section_name")
        .ok()??;
    let name = raw.as_str()?.trim().to_string();
    if name.is_empty() || name.chars().count() > 40 || name.contains('\n') || name.contains('\r') {
        return None;
    }
    Some(name)
}

/// 새 노트 첫 섹션의 언어별 기본 이름 (ko "개요", en "Overview", fr "Aperçu").
pub fn default_section_name_for_lang(lang: &str) -> &'static str {
    match lang {
        "en" => "Overview",
        "fr" => "Aperçu",
        _ => "개요",
    }
}

/// 새 노트 첫 섹션 기본 이름 결정용 `ui_lang` 조회 — 폴더가 속한 노트북(`workspace_settings`)에
/// 저장된 값이 있으면 우선 채택하고, 없으면 전역 `settings` 테이블에서 읽는다.
/// 둘 다 없거나 올바르지 않으면 "ko"(settings_schema 시드 기본값).
fn resolve_ui_lang(conn: &Connection, workspace_id: Option<&str>) -> String {
    if let Some(ws) = workspace_id {
        if let Ok(Some(JsonValue::String(s))) = settings::notebook_setting_raw(conn, ws, "ui_lang") {
            if matches!(s.as_str(), "ko" | "en" | "fr") {
                return s;
            }
        }
    }
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='ui_lang'",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let Some(raw) = stored {
        if let Ok(JsonValue::String(s)) = serde_json::from_str::<JsonValue>(&raw) {
            if matches!(s.as_str(), "ko" | "en" | "fr") {
                return s;
            }
        }
        let trimmed = raw.trim().trim_matches('"');
        if matches!(trimmed, "ko" | "en" | "fr") {
            return trimmed.to_string();
        }
    }
    "ko".to_string()
}

/// note_create 커맨드 전용 진입점 — life-recording 피벗(앱 컨셉이 "역사 노트 전용"에서 "인생 기록
/// 중심, 역사는 부차"로 전환) 이후 새 노트의 사건 날짜 기본값은 "모르면 1900"이 아니라 "말 안
/// 했으면 지금"이어야 자연스럽다. `create()`/`create_with_timestamp` 의 기존 1900 폴백은 그대로
/// 둔다 — migrate(가져오기)가 "원본 문서에 날짜가 없어 진짜로 모른다"는 뜻으로 명시적으로 기대는
/// 계약이고(transfer/migrate/mod.rs::commit_staged_creates_notes_with_tags_and_timestamp 로 고정),
/// 여기서 건드리면 그 계약이 깨진다. year/month/day 는 각각 독립적으로 "미지정 시 오늘"이
/// 적용된다 — 호출자가 준 값이 있으면 그대로 존중한다(예: 노트 복제는 원본의 연/월/일을 그대로
/// 넘긴다).
///
/// 2026-09-20 실험: 위 "미지정 시 오늘"은 **셋 다 미지정일 때만**(순수 오늘 기본값) 노트북의
/// `new_note_date_precision` 을 따른다 — 하나라도 명시됐으면(예: 노트 복제가 연도만 넘기는 경우)
/// 이 설정과 무관하게 기존의 "필드별 독립 오늘 폴백"을 그대로 쓴다(부분 입력 재해석 금지, 아래
/// else 분기가 옛 동작 그대로). 첫 섹션 이름은 날짜와 독립적으로 항상 `new_note_section_name`
/// (없으면 `ui_lang`별 기본 이름: ko "개요", en "Overview", fr "Aperçu")을 쓴다.
pub fn create_today_default(
    conn: &mut Connection,
    folder_id: &str,
    title: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
) -> AppResult<NoteDetail> {
    create_today_default_with_hook(conn, folder_id, title, year, month, day, |_, _| Ok(()))
}

/// `create_today_default` 의 커밋 직전 hook 판(`create_with_sections_with_hook` 와 같은 계약) — 날짜 해석과
/// 첫 섹션 이름을 note_create 와 **같은 코드**로 정하고, hook 은 노트·섹션·FTS 와 같은 트랜잭션에서 돈다
/// (hook 이 실패하면 노트도 남지 않는다). 브리핑 일정 만들기(repo::briefing::block_create)가 대표 행 시각을
/// 함께 심으려고 쓴다 — `notes::create`(내장 "Overview")를 직접 부르면 첫 섹션 이름이 그 경로에서만 되돌아간다.
pub(crate) fn create_today_default_with_hook<F>(
    conn: &mut Connection,
    folder_id: &str,
    title: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
    hook: F,
) -> AppResult<NoteDetail>
where
    F: FnOnce(&rusqlite::Transaction<'_>, &str) -> AppResult<()>,
{
    let (ty, tm, td) = crate::util::today_ymd_local();
    let workspace_id = folder_workspace_id(conn, folder_id)?;

    let (year, month, day) = if year.is_none() && month.is_none() && day.is_none() {
        let precision = workspace_id
            .as_deref()
            .map(|ws| resolve_new_note_date_precision(conn, ws))
            .unwrap_or(NewNoteDatePrecision::Day);
        match precision {
            NewNoteDatePrecision::Day => (Some(ty), Some(tm), Some(td)),
            NewNoteDatePrecision::Month => (Some(ty), Some(tm), None),
            NewNoteDatePrecision::Year => (Some(ty), None, None),
        }
    } else {
        (Some(year.unwrap_or(ty)), Some(month.unwrap_or(tm)), Some(day.unwrap_or(td)))
    };

    let section_name = workspace_id
        .as_deref()
        .and_then(|ws| resolve_new_note_section_name(conn, ws))
        .unwrap_or_else(|| {
            let lang = resolve_ui_lang(conn, workspace_id.as_deref());
            default_section_name_for_lang(&lang).to_string()
        });

    create_with_sections_with_hook(
        conn,
        folder_id,
        title,
        year,
        month,
        day,
        None,
        vec![(section_name, String::new())],
        hook,
    )
}

/// `create()` 의 timestamp/본문 오버라이드 버전 — Migration (§2.5 HANDOFF-calendar-onboarding.md)
/// 이 원본 파일의 생성/수정 시각과 본문을 그대로 심을 수 있게 한다. `created_at` 이 None 이면
/// `create()`와 완전히 동일(now_iso()). 두 컬럼을 같은 값으로 채우는 건 `create()`의 기존 규약
/// 그대로다 — 이 함수는 항상 신규 삽입이지 갱신이 아니므로 "마지막 수정" 시각도 최초 생성
/// 시각(주어진 created_at, 없으면 지금)과 같다. `create()`가 이 함수의 얇은 래퍼가 되면서 SQL 은
/// 여기 한 곳에만 존재한다.
/// `body_md` 는 Overview 섹션의 초기 본문 — None 이면 `create()`의 기존 동작(빈 문자열, 제목
/// 헤딩을 심지 않음)과 동일. 별도 `sections::update()` 호출로 본문을 나중에 채우지 않는 이유: 그 함수는
/// notes.updated_at 을 호출 시각(now)으로 다시 찍는다 — 마이그레이션이 막 심어 놓은 원본
/// created_at/updated_at 을 그 자리에서 덮어써 버려 이 슬라이스의 핵심 요구사항(원본 시각
/// 보존)을 스스로 어기게 된다. 같은 트랜잭션 안에서 INSERT 값 자체를 바꾸면 그 문제가 없다.
pub(crate) fn create_with_timestamp(
    conn: &mut Connection,
    folder_id: &str,
    title: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
    created_at: Option<String>,
    body_md: Option<String>,
) -> AppResult<NoteDetail> {
    create_with_sections(
        conn,
        folder_id,
        title,
        year,
        month,
        day,
        created_at,
        vec![(DEFAULT_SECTION_NAME.to_string(), body_md.unwrap_or_default())],
    )
}

/// 신규 노트를 지정한 섹션들과 함께 원자적으로 만든다.
///
/// 일반 `note_create`는 기존 계약대로 Overview 하나를 만들고, 대화 저장처럼 처음부터
/// 여러 섹션이 필요한 기능은 이 경로를 사용한다. 노트·섹션·FTS 색인을 하나의 트랜잭션에
/// 넣어 중간에 실패해 빈 노트가 남지 않게 한다.
pub(crate) fn create_with_sections(
    conn: &mut Connection,
    folder_id: &str,
    title: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
    created_at: Option<String>,
    section_contents: Vec<(String, String)>,
) -> AppResult<NoteDetail> {
    create_with_sections_with_hook(
        conn,
        folder_id,
        title,
        year,
        month,
        day,
        created_at,
        section_contents,
        |_, _| Ok(()),
    )
}

/// `create_with_sections`의 커밋 직전 hook 버전. 대화 저장처럼 노트 생성과 감사 로그를
/// 같은 트랜잭션에 넣어야 하는 호출부만 사용한다. hook이 실패하면 노트/섹션/FTS도 함께
/// rollback된다.
pub(crate) fn create_with_sections_with_hook<F>(
    conn: &mut Connection,
    folder_id: &str,
    title: Option<String>,
    year: Option<i64>,
    month: Option<i64>,
    day: Option<i64>,
    created_at: Option<String>,
    section_contents: Vec<(String, String)>,
    hook: F,
) -> AppResult<NoteDetail>
where
    F: FnOnce(&rusqlite::Transaction<'_>, &str) -> AppResult<()>,
{
    if section_contents.is_empty() {
        return Err(AppError::Validation("note requires at least one section".to_string()));
    }
    let folder_exists: bool = conn
        .query_row(
            "SELECT 1 FROM folders WHERE id = ?1",
            [folder_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !folder_exists {
        return Err(AppError::NotFound(format!("folder not found: {folder_id}")));
    }

    let title = title.unwrap_or_else(|| "Untitled Note".to_string());
    let year = year.unwrap_or(1900);
    if !(YEAR_MIN..=YEAR_MAX).contains(&year) {
        return Err(AppError::Validation(format!("year out of range: {year}")));
    }
    // month/day 는 여기서는 순수 전달(디폴트 없음, None=NULL) — set_event_precision 과 동일한
    // 정밀도 규약(day 는 month 없이 못 옴)만 지킨다. "미지정 시 오늘"은 create_today_default 의
    // 책임이다: migrate(가져오기)는 이 함수를 직접 호출하며 원본 문서에 날짜가 없으면 진짜로
    // month/day 없이(NULL) 남아야 한다.
    validate_month_day(month, day)?;
    let now = created_at.unwrap_or_else(now_iso);
    let note_id = new_id();

    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT INTO notes(id, folder_id, title, year, month, day, is_favorite, exported_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?7)",
        params![note_id, folder_id, title, year, month, day, now],
    )
    .map_err(dberr)?;
    // PLAN-2026-09-08-dates-rebuild.md W1: 노트 생성 경로 전부가 지나는 단일 지점 — position=0
    // 행을 함께 심는다(note_dates 가 진실, notes.* 는 그 투영). 새 노트는 아직 기간·시각·알림·
    // 반복이 없으므로 나머지는 전부 None/false.
    dates::insert_primary_row(&tx, &note_id, year, month, day, None, None, None, None, None, false, None, None, &now)?;
    for (position, (name, body_md)) in section_contents.into_iter().enumerate() {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::Validation("section name must not be empty".to_string()));
        }
        tx.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_id(), note_id, name, body_md, position as i64, now],
        )
        .map_err(dberr)?;
    }
    fts::fts_upsert(&tx, &note_id)?;
    hook(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;

    // QA8 Wave 4A — activity_log create event (immediate, independent of 60s snapshot cadence).
    // Best-effort: a log failure must never block note creation.
    crate::repo::activity::record_for_note(
        conn,
        &note_id,
        crate::repo::activity::KIND_CREATE,
        &title,
        None,
    );

    note_detail(conn, &note_id)
}

pub fn update(
    conn: &mut Connection,
    id: &str,
    title: Option<String>,
    year: Option<i64>,
    folder_id: Option<String>,
    // Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): "알려줘" opt-in 플래그. Plain bool 이라
    // region/status 와 달리 전용 커맨드가 필요 없다 — None=미변경, Some(bool)=새 값이 그 자체로
    // 명시적 해제(false)를 표현할 수 있어 그 두 필드가 겪던 "생략=미변경" 애매함이 없다.
    remind: Option<bool>,
) -> AppResult<NoteSummary> {
    // 존재 확인
    let current = note_summary(conn, id)?;
    if let Some(y) = year {
        if !(YEAR_MIN..=YEAR_MAX).contains(&y) {
            return Err(AppError::Validation(format!("year out of range: {y}")));
        }
        // Dashboard Wave 1: 시작 연도 변경이 end_* 와 역전되면 거부.
        if current.end_year.is_some() {
            assert_start_not_after_end(
                y,
                current.month,
                current.day,
                current.end_year,
                current.end_month,
                current.end_day,
            )?;
        }
    }
    if let Some(ref fid) = folder_id {
        let exists: bool = conn
            .query_row("SELECT 1 FROM folders WHERE id=?1", [fid], |_| Ok(true))
            .optional()
            .map_err(dberr)?
            .unwrap_or(false);
        if !exists {
            return Err(AppError::NotFound(format!("folder not found: {fid}")));
        }
    }
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    // 폴백 분기 평가용 — 이후 move 전에 title_only 플래그를 미리 결정
    let title_only_path =
        title.is_some() && year.is_none() && folder_id.is_none() && remind.is_none();

    if let Some(ref t) = title {
        tx.execute(
            "UPDATE notes SET title=?1 WHERE id=?2",
            params![t, id],
        )
        .map_err(dberr)?;
    }
    // PLAN-2026-09-08-dates-rebuild.md W1: year/remind 는 이제 position=0 note_dates 행이 진실이고
    // notes.year/notes.remind 는 그 투영이다 — 여기서 notes.* 를 직접 쓰면 project_primary 가 다음
    // 어떤 날짜 관련 mutation 에서든 그 값을 지워버린다(드리프트). 그래서 두 필드 모두 note_dates
    // 를 거쳐 project_primary 로 되비춘다.
    if let Some(y) = year {
        tx.execute(
            "UPDATE note_dates SET year=?1 WHERE note_id=?2 AND position=0",
            params![y, id],
        )
        .map_err(dberr)?;
    }
    if let Some(fid) = folder_id {
        tx.execute(
            "UPDATE notes SET folder_id=?1 WHERE id=?2",
            params![fid, id],
        )
        .map_err(dberr)?;
    }
    if let Some(r) = remind {
        tx.execute(
            "UPDATE note_dates SET remind=?1 WHERE note_id=?2 AND position=0",
            params![r, id],
        )
        .map_err(dberr)?;
    }
    if year.is_some() || remind.is_some() {
        dates::project_primary(&tx, id)?;
    }
    tx.execute("UPDATE notes SET updated_at=?1 WHERE id=?2", params![now, id])
        .map_err(dberr)?;
    // Finding 23: 제목만 바뀌면 경량 갱신. 폴백은 full upsert.
    if title_only_path {
        if let Some(ref t) = title {
            if fts::fts_update_title(&tx, id, t)? {
                tx.commit().map_err(dberr)?;
                return note_summary(conn, id);
            }
        }
    }
    fts::fts_upsert(&tx, id)?;
    tx.commit().map_err(dberr)?;

    note_summary(conn, id)
}

/// 노트 삭제(소프트, 기본 경로) — Trash: `deleted_at` 만 세팅하고 FTS 색인에서 제거한다.
/// 자식 행(sections/sources/attachments/note_tags)과 다른 노트가 이 노트를
/// 가리키는 internal 링크 첨부는 그대로 둔다 — 복구(restore) 시 원상태로 돌아가야 하기 때문이다.
/// 완전 삭제는 `purge` 참조.
pub fn delete(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let summary = note_summary(conn, id)?; // NOT_FOUND
    let title = summary.title.clone();
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "UPDATE notes SET deleted_at=?1 WHERE id=?2",
        params![now, id],
    )
    .map_err(dberr)?;
    fts::fts_delete(&tx, id)?;
    tx.commit().map_err(dberr)?;
    // QA8 Wave 4A — record delete BEFORE purge can wipe the note row. activity_log.note_id has
    // no FK, so this row survives soft-delete and later hard-purge (unlike note_snapshots).
    crate::repo::activity::record_for_note(
        conn,
        id,
        crate::repo::activity::KIND_DELETE,
        &title,
        None,
    );
    Ok(true)
}

/// 휴지통에서 복구 — `deleted_at` 을 해제하고 FTS 색인에 다시 넣는다(fts_upsert — delete()가
/// fts_delete로 지운 행을 되살린다). id 가 존재하지 않으면 NOT_FOUND(휴지통에 있든 없든 동일하게
/// 검증 — note_summary 는 deleted_at 을 필터하지 않는다).
pub fn restore(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let _ = note_summary(conn, id)?; // NOT_FOUND
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("UPDATE notes SET deleted_at=NULL WHERE id=?1", [id])
        .map_err(dberr)?;
    fts::fts_upsert(&tx, id)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

/// 완전 삭제(휴지통 비우기) — 구 `delete()`의 하드 삭제 로직을 그대로 이어받는다: 자식 행은
/// notes(id) ON DELETE CASCADE 로 정리되고(sections/sources/attachments/
/// note_tags), FTS 행 삭제, 이 노트를 가리키던 다른 노트 소유의 internal 링크 첨부(CASCADE
/// 대상이 아니므로 명시적 정리 — 안 하면 죽은 note id 를 든 dangling 링크가 남는다), 마지막으로
/// 첨부 디렉토리를 커밋 후 정리한다.
pub fn purge(conn: &mut Connection, data_dir: &Path, id: &str) -> AppResult<bool> {
    let _ = note_summary(conn, id)?; // NOT_FOUND
    let tx = conn.transaction().map_err(dberr)?;
    fts::fts_delete(&tx, id)?;
    // 이 노트를 internal 링크로 가리키던 다른 노트 소유의 첨부 행 — notes(id) CASCADE 대상이
    // 아니라(rel/url 텍스트 참조일 뿐 FK 아님) 명시적 삭제이므로, 각 행을 직접 삭제 대상으로
    // tombstone 한다(캐스케이드 규칙 밖).
    let dangling_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM attachments WHERE kind='internal' AND url=?1")
            .map_err(dberr)?;
        let rows = stmt
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(dberr)?;
        rows.collect::<Result<_, _>>().map_err(dberr)?
    };
    tx.execute("DELETE FROM notes WHERE id=?1", [id])
        .map_err(dberr)?;
    // G2: notes 만 직접 삭제 대상 — CASCADE 로 함께 사라지는 sections/sources/attachments/
    // note_tags 는 이 tombstone 하나로 암시된다(repo/tombstone.rs 캐스케이드 규칙).
    crate::repo::tombstone::record_tombstone(&tx, "notes", id)?;
    tx.execute(
        "DELETE FROM attachments WHERE kind='internal' AND url=?1",
        [id],
    )
    .map_err(dberr)?;
    for aid in &dangling_ids {
        crate::repo::tombstone::record_tombstone(&tx, "attachments", aid)?;
    }
    tx.commit().map_err(dberr)?;
    // 커밋 후 첨부 디렉토리 정리 (실패 무시 — 시작 시 청소가 수거).
    let dir = db::attachments_dir(data_dir).join(id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(true)
}

/// 휴지통 목록 — 워크스페이스(생략 시 active) 소속 소프트 삭제 노트를 deleted_at desc 로.
/// 휴지통 목록 — 워크스페이스(생략 시 active) 소속 삭제 노트를 deleted_at desc 로.
/// N+1 방지를 위해 note_summaries_map_internal(include_deleted: true) 배치 로더를 사용한다.
pub fn trash_list(conn: &Connection, workspace_id: Option<String>) -> AppResult<Vec<NoteSummary>> {
    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    let mut stmt = conn
        .prepare(
            "SELECT n.id FROM notes n JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NOT NULL
             ORDER BY n.deleted_at DESC",
        )
        .map_err(dberr)?;
    let ids: Vec<String> = stmt
        .query_map([&ws], |r| r.get::<_, String>(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    let map = note_summaries_map_internal(conn, &ids, true)?;
    // ponytail: LIMIT 추가는 이번에 하지 않는다 — 전량 반환이 의도인지 UX 결정이 필요.
    Ok(ids.iter().filter_map(|id| map.get(id).cloned()).collect())
}

/// 휴지통 배지용 카운트 — 행을 조립하지 않고 COUNT 만. v19 `idx_notes_deleted` 로
/// `deleted_at IS NOT NULL` 이 폴더-조인 풀스캔(~500ms/100k, 휴지통 0건이어도)을 피한다.
pub fn trash_count(conn: &Connection, workspace_id: Option<String>) -> AppResult<i64> {
    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    conn.query_row(
        "SELECT COUNT(*) FROM notes n
         WHERE n.deleted_at IS NOT NULL
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)",
        [&ws],
        |r| r.get(0),
    )
    .map_err(dberr)
}

/// 아카이브 — 트리/대시보드(보드·달력·타임라인)에서 숨기되 FTS 색인은 그대로 둔다("보이지
/// 않지만 찾으면 나온다" — delete()와의 핵심 차이는 fts_delete 를 호출하지 않는다는 것뿐이다).
/// 트랜잭션이 필요 없다 — FTS 부수효과가 없는 단일 UPDATE.
pub fn archive(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let _ = note_summary(conn, id)?; // NOT_FOUND
    conn.execute(
        "UPDATE notes SET archived_at=?1 WHERE id=?2",
        params![now_iso(), id],
    )
    .map_err(dberr)?;
    Ok(true)
}

/// 아카이브 해제 — archived_at 만 지운다. archive()가 FTS를 건드린 적이 없으므로 재색인도 불필요.
pub fn unarchive(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let _ = note_summary(conn, id)?; // NOT_FOUND
    conn.execute("UPDATE notes SET archived_at=NULL WHERE id=?1", [id])
        .map_err(dberr)?;
    Ok(true)
}

/// 아카이브 목록 — 워크스페이스(생략 시 active) 소속 아카이브 노트를 archived_at desc 로.
/// N+1 방지를 위해 note_summaries_map_internal 배치 로더를 사용한다.
pub fn archived_list(conn: &Connection, workspace_id: Option<String>) -> AppResult<Vec<NoteSummary>> {
    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    let mut stmt = conn
        .prepare(
            "SELECT n.id FROM notes n JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.archived_at IS NOT NULL AND n.deleted_at IS NULL
             ORDER BY n.archived_at DESC",
        )
        .map_err(dberr)?;
    let ids: Vec<String> = stmt
        .query_map([&ws], |r| r.get::<_, String>(0))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    let map = note_summaries_map_internal(conn, &ids, false)?;
    // ponytail: LIMIT 추가는 이번에 하지 않는다 — 전량 반환이 의도인지 UX 결정이 필요.
    Ok(ids.iter().filter_map(|id| map.get(id).cloned()).collect())
}

/// 아카이브 배지용 카운트 — 행을 조립하지 않고 COUNT 만. idx_notes_archived(v36)로
/// archived_at IS NOT NULL 카운트가 폴더-조인 풀스캔을 피한다(trash_count와 동일한 근거).
pub fn archived_count(conn: &Connection, workspace_id: Option<String>) -> AppResult<i64> {
    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    conn.query_row(
        "SELECT COUNT(*) FROM notes n
         WHERE n.archived_at IS NOT NULL AND n.deleted_at IS NULL
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)",
        [&ws],
        |r| r.get(0),
    )
    .map_err(dberr)
}

pub fn toggle_favorite(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let _ = note_summary(conn, id)?;
    conn.execute(
        "UPDATE notes SET is_favorite = 1 - is_favorite WHERE id=?1",
        [id],
    )
    .map_err(dberr)?;
    conn.query_row(
        "SELECT is_favorite FROM notes WHERE id=?1",
        [id],
        |r| r.get::<_, i64>(0),
    )
    .map_err(dberr)
    .map(|v| v != 0)
}

/// 더보기 메뉴 "내용잠금" — toggle_favorite 와 정확히 같은 구조(V84, content_locked 컬럼).
/// ON(true)이면 프런트가 섹션 추가/삭제 + 본문 편집을 막는다(에디터 read-only) — 이 함수
/// 자체는 플래그만 뒤집을 뿐 그 강제는 하지 않는다(강제는 커맨드 표면이 아니라 프런트 책임 —
/// SectionTabBar.tsx/EditorPanel.tsx). 메타데이터(제목/태그/상태/지역/날짜)·첨부는 범위 밖 —
/// 이 컬럼이 그 어느 것도 참조하지 않으므로 잠가도 계속 바뀔 수 있다.
pub fn toggle_content_lock(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let _ = note_summary(conn, id)?;
    conn.execute(
        "UPDATE notes SET content_locked = 1 - content_locked WHERE id=?1",
        [id],
    )
    .map_err(dberr)?;
    conn.query_row(
        "SELECT content_locked FROM notes WHERE id=?1",
        [id],
        |r| r.get::<_, i64>(0),
    )
    .map_err(dberr)
    .map(|v| v != 0)
}


/// 노트 지역(region) 설정/해제 — 전용 커맨드로 분리한 이유는 note_update 참조.
/// 빈 문자열/공백만 있는 입력은 해제(NULL)로 정규화한다(태그 정규화와 동일한 관례).
pub fn set_region(conn: &mut Connection, id: &str, region: Option<String>) -> AppResult<NoteSummary> {
    let _ = note_summary(conn, id)?;
    let region = region.and_then(|r| {
        let t = r.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let now = now_iso();
    conn.execute(
        "UPDATE notes SET region=?1, updated_at=?2 WHERE id=?3",
        params![region, now, id],
    )
    .map_err(dberr)?;
    note_summary(conn, id)
}

/// 노트 진행 상태(status) 설정/해제 — note_set_region 과 동일한 이유로 전용 커맨드로 분리
/// (note_update 의 "필드 생략 = 변경 없음" 관례로는 명시적 해제를 표현할 수 없다). status 는
/// 내장 키(repo::taxonomy::BUILT_IN_STATUSES) 또는 이 노트가 속한 워크스페이스의
/// workspace_statuses.id 여야 한다 — repo::taxonomy::validate_status_for_workspace 로 검증.
pub fn set_status(conn: &mut Connection, id: &str, status: Option<String>) -> AppResult<NoteSummary> {
    let _ = note_summary(conn, id)?;
    let workspace_id: String = conn
        .query_row(
            "SELECT f.workspace_id FROM notes n JOIN folders f ON f.id = n.folder_id WHERE n.id = ?1",
            [id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    crate::repo::taxonomy::validate_status_for_workspace(conn, &workspace_id, &status)?;
    let now = now_iso();
    conn.execute(
        "UPDATE notes SET status=?1, updated_at=?2 WHERE id=?3",
        params![status, now, id],
    )
    .map_err(dberr)?;
    note_summary(conn, id)
}

/// 노트 좌표(lat/lng) 설정/해제 — 전용 커맨드.
/// lat은 -90..90, lng은 -180..180 범위여야 하며, 둘 다 Some이거나 둘 다 None이어야 한다 (반좌표 금지).
pub fn set_location(
    conn: &mut Connection,
    id: &str,
    lat: Option<f64>,
    lng: Option<f64>,
) -> AppResult<NoteSummary> {
    let _ = note_summary(conn, id)?;
    match (lat, lng) {
        (Some(lat_val), Some(lng_val)) => {
            if !(-90.0..=90.0).contains(&lat_val) {
                return Err(AppError::Validation(format!(
                    "lat out of range (-90..90): {lat_val}"
                )));
            }
            if !(-180.0..=180.0).contains(&lng_val) {
                return Err(AppError::Validation(format!(
                    "lng out of range (-180..180): {lng_val}"
                )));
            }
        }
        (None, None) => {}
        _ => {
            return Err(AppError::Validation(
                "both lat and lng must be set or both must be null".to_string(),
            ));
        }
    }
    let now = now_iso();
    conn.execute(
        "UPDATE notes SET lat=?1, lng=?2, updated_at=?3 WHERE id=?4",
        params![lat, lng, now, id],
    )
    .map_err(dberr)?;
    note_summary(conn, id)
}

/// §2.3 HANDOFF-calendar-onboarding.md: 사건 축(year) 정밀도 — month/day 설정/해제. note_set_region
/// 과 동일한 이유로 전용 커맨드(생략 관례로는 명시적 해제를 표현할 수 없다). day가 Some인데 month가
/// None이면 거부 — null이 정밀도를 인코딩하는 3단계(연/연월/연월일) 밖의 상태를 만들지 않는다.
/// 범위 검증은 DB CHECK와 이중이다(다른 set_* 함수들과 같은 자세 — 앱 레벨에서 먼저 명확한
/// VALIDATION 에러로 걸러내고, CHECK는 이 경로를 우회한 쓰기에 대한 최후 방어선).
/// Dashboard Wave 1: 시작 정밀도 변경 시 기존 end_* 와 역전되면 VALIDATION (end 는 건드리지 않음).
/// docs/PLAN-schedule-system.md §1.3 함정: `start_time`/`rrule`(I1/I4)은 시작일이 연월일 풀
/// 정밀도(day 정밀도)일 때만 존재할 수 있다. 정밀도를 여기서 낮추면(day 미지정) 두 불변식이
/// 깨지므로 같은 UPDATE에서 함께 NULL로 지운다 — 호출자마다 가드를 다는 대신 모든 호출자가
/// 지나는 이 한 지점에서 처리한다(CLAUDE.md "코드 방침"). `end_time`도 함께 지운다: I2
/// (end_time⇒start_time)가 start_time 소거만으로 깨지는 것을 막기 위함 — 설계서 §1.3 예시 문구는
/// start_time/rrule만 들었지만, end_time을 남겨두면 그 자체로 I2 위반 행이 만들어지므로 여기서
/// 같이 지우는 것이 설계 의도(교차 불변식 전체 유지)에 맞다.
pub fn set_event_precision(
    conn: &mut Connection,
    id: &str,
    month: Option<i64>,
    day: Option<i64>,
) -> AppResult<NoteSummary> {
    let current = note_summary(conn, id)?;
    validate_month_day(month, day)?;
    if current.end_year.is_some() {
        assert_start_not_after_end(
            current.year,
            month,
            day,
            current.end_year,
            current.end_month,
            current.end_day,
        )?;
    }
    // PLAN-2026-09-08-dates-rebuild.md W1: notes.month/day 는 이제 position=0 note_dates 행의
    // 투영이다 — 그 행을 고치고 project_primary 로 되비춘다(직접 notes 를 쓰면 다음 project_primary
    // 호출이 되돌려 놓는다).
    let tx = conn.transaction().map_err(dberr)?;
    if day.is_some() {
        tx.execute(
            "UPDATE note_dates SET month=?1, day=?2 WHERE note_id=?3 AND position=0",
            params![month, day, id],
        )
        .map_err(dberr)?;
    } else {
        tx.execute(
            "UPDATE note_dates SET month=?1, day=?2, start_time=NULL, end_time=NULL, rrule=NULL WHERE note_id=?3 AND position=0",
            params![month, day, id],
        )
        .map_err(dberr)?;
    }
    dates::project_primary(&tx, id)?;
    tx.commit().map_err(dberr)?;
    note_summary(conn, id)
}

/// Dashboard Wave 1: 사건 축 기간 종료(end_year/end_month/end_day) 설정/해제.
/// 세 필드 모두 None = 기간 해제(단일 시점 노트). end_day ⇒ end_month ⇒ end_year.
/// 시작(year/month/day)보다 이전이면 VALIDATION. 기존 set_event_precision 시그니처를 깨지 않기
/// 위해 전용 커맨드(note_set_event_end)로 분리.
/// docs/PLAN-schedule-system.md §1.3 함정: `end_*` 트리플을 전부 비우면(기간 해제) `end_time`도
/// 같은 UPDATE에서 함께 지운다 — set_event_precision 이 start_time/rrule 을 지우는 것과 같은
/// 논리(호출자마다 가드 대신 이 한 지점에서 처리).
pub fn set_event_end(
    conn: &mut Connection,
    id: &str,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
) -> AppResult<NoteSummary> {
    let current = note_summary(conn, id)?;
    validate_end_triple(end_year, end_month, end_day)?;
    if end_year.is_some() {
        assert_start_not_after_end(
            current.year,
            current.month,
            current.day,
            end_year,
            end_month,
            end_day,
        )?;
    }
    // PLAN-2026-09-08-dates-rebuild.md W1: notes.end_* 는 이제 position=0 note_dates 행의 투영이다.
    let tx = conn.transaction().map_err(dberr)?;
    if end_year.is_some() {
        tx.execute(
            "UPDATE note_dates SET end_year=?1, end_month=?2, end_day=?3 WHERE note_id=?4 AND position=0",
            params![end_year, end_month, end_day, id],
        )
        .map_err(dberr)?;
    } else {
        tx.execute(
            "UPDATE note_dates SET end_year=?1, end_month=?2, end_day=?3, end_time=NULL WHERE note_id=?4 AND position=0",
            params![end_year, end_month, end_day, id],
        )
        .map_err(dberr)?;
    }
    dates::project_primary(&tx, id)?;
    tx.commit().map_err(dberr)?;
    note_summary(conn, id)
}

fn validate_month_day(month: Option<i64>, day: Option<i64>) -> AppResult<()> {
    if let Some(m) = month {
        if !(1..=12).contains(&m) {
            return Err(AppError::Validation(format!("month out of range (1..12): {m}")));
        }
    }
    if let Some(d) = day {
        if !(1..=31).contains(&d) {
            return Err(AppError::Validation(format!("day out of range (1..31): {d}")));
        }
        if month.is_none() {
            return Err(AppError::Validation(
                "day requires month to be set".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_end_triple(
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
) -> AppResult<()> {
    if let Some(y) = end_year {
        if !(YEAR_MIN..=YEAR_MAX).contains(&y) {
            return Err(AppError::Validation(format!("end_year out of range: {y}")));
        }
    }
    if let Some(m) = end_month {
        if !(1..=12).contains(&m) {
            return Err(AppError::Validation(format!(
                "end_month out of range (1..12): {m}"
            )));
        }
        if end_year.is_none() {
            return Err(AppError::Validation(
                "end_month requires end_year to be set".to_string(),
            ));
        }
    }
    if let Some(d) = end_day {
        if !(1..=31).contains(&d) {
            return Err(AppError::Validation(format!(
                "end_day out of range (1..31): {d}"
            )));
        }
        if end_month.is_none() {
            return Err(AppError::Validation(
                "end_day requires end_month to be set".to_string(),
            ));
        }
    }
    Ok(())
}

/// Start > end 역전 방지. 정밀도가 다른 쪽은 start 쪽 missing=earliest(0), end 쪽 missing=latest(99)
/// 로 채워 거친 정밀도 기간이 거짓 거부되지 않게 한다.
fn assert_start_not_after_end(
    start_year: i64,
    start_month: Option<i64>,
    start_day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
) -> AppResult<()> {
    let Some(ey) = end_year else {
        return Ok(());
    };
    let start = (
        start_year,
        start_month.unwrap_or(0),
        start_day.unwrap_or(0),
    );
    let end = (ey, end_month.unwrap_or(99), end_day.unwrap_or(99));
    if start > end {
        return Err(AppError::Validation(
            "event start must not be after event end".to_string(),
        ));
    }
    Ok(())
}

/// 빈/공백 문자열을 None(해제)으로 정규화 — set_icon 의 동일 관례.
fn normalize_blank(v: Option<String>) -> Option<String> {
    v.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    })
}

/// docs/PLAN-schedule-system.md §1 W5-1: 일정(start_time/end_time)·알림 오프셋
/// (remind_offset_min)·반복(rrule 원문) 저장. 교차 불변식 I1~I6(§1.3)은 여기서 강제한다(단일
/// 컬럼 CHECK만 붙은 ADD COLUMN 의 한계를 앱 레벨에서 메우는 V23/V28/set_event_end 관례 재사용).
///
/// I5(rrule 문법 검증)는 repo::schedule::rrule::parse_for_seed(W5-2)가 관문이다 — 여기서 한 번
/// 호출하고, DB 는 검증된 원문을 TEXT 그대로
/// 저장/왕복만 한다(빈 문자열은 §3.1 규칙대로 저장 전 None 으로 정규화 — 이건 파싱이 아니라
/// 순수 저장 정규화라 이 웨이브 범위 안).
///
/// I6(remind_offset_min 은 시각/풀정밀도 날짜가 있을 때만 유효)는 검증하지 않는다 — remind
/// 플래그와 같은 철학으로 저장은 항상 허용하고 무효과로 둔다(migrations.rs V30 주석 "날짜가
/// 없으면 플래그는 아무 효과가 없다"와 동일 자세).
pub fn set_schedule(
    conn: &mut Connection,
    id: &str,
    start_time: Option<String>,
    end_time: Option<String>,
    remind_offset_min: Option<i64>,
    rrule: Option<String>,
) -> AppResult<NoteSummary> {
    let current = note_summary(conn, id)?;

    let start_time = normalize_blank(start_time);
    let end_time = normalize_blank(end_time);
    let rrule = normalize_blank(rrule);

    // PLAN-2026-09-13-separation-of-concerns.md D4: 시각 형식·알림 오프셋 범위·교차 불변식
    // I1~I5 는 date_add/date_update 와 **같은 한 지점**(dates::validate_schedule_fields)이 본다 —
    // 예전에는 여기와 dates::validate_row 에 같은 문장이 두 벌로 있었다. 저장된 날짜 삼중은
    // 검증 대상이 아니라 문맥으로만 넘긴다(I1/I4 의 풀 정밀도, I3 의 "같은 날", I5 의 seed):
    // 여기서 기간까지 재검증하면 이미 저장된 손상 데이터에서만 새 오류가 난다.
    dates::validate_schedule_fields(
        current.year,
        current.month,
        current.day,
        current.end_year,
        current.end_month,
        current.end_day,
        &start_time,
        &end_time,
        remind_offset_min,
        &rrule,
    )?;

    // PLAN-2026-09-08-dates-rebuild.md W1: notes.{start_time,end_time,remind_offset_min,rrule} 은
    // 이제 position=0 note_dates 행의 투영이다.
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "UPDATE note_dates SET start_time=?1, end_time=?2, remind_offset_min=?3, rrule=?4 WHERE note_id=?5 AND position=0",
        params![start_time, end_time, remind_offset_min, rrule, id],
    )
    .map_err(dberr)?;
    dates::project_primary(&tx, id)?;
    tx.commit().map_err(dberr)?;
    note_summary(conn, id)
}

/// 노트 아이콘(icon key) 설정/해제 — note_set_region 과 동일하게 전용 커맨드로 분리(생략 관례로는
/// 명시적 해제를 표현할 수 없다). 빈/공백 입력은 해제(NULL=기본 아이콘)로 정규화한다. 아이콘 키의
/// 유효성(팔레트에 존재하는 키인지)은 프론트 팔레트가 보장하므로 서버는 자유 문자열로 저장한다
/// (folder color_hue 처럼 순수 표현 데이터).
pub fn set_icon(conn: &mut Connection, id: &str, icon: Option<String>) -> AppResult<NoteSummary> {
    let _ = note_summary(conn, id)?;
    let icon = icon.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let now = now_iso();
    conn.execute(
        "UPDATE notes SET icon=?1, updated_at=?2 WHERE id=?3",
        params![icon, now, id],
    )
    .map_err(dberr)?;
    note_summary(conn, id)
}

/// AI 정리 결과를 단일 트랜잭션으로 적용하고, 실제 변경된 항목("title", "year", "tags") 목록 반환.
pub fn apply_ai_organize(
    conn: &mut Connection,
    id: &str,
    title_opt: Option<String>,
    year_opt: Option<i64>,
    tags_opt: Option<Vec<String>>,
) -> AppResult<Vec<String>> {
    let summary = note_summary(conn, id)?;
    let tx = conn.transaction().map_err(dberr)?;
    let applied = apply_ai_organize_in_tx(&tx, &summary, title_opt, year_opt, tags_opt)?;
    tx.commit().map_err(dberr)?;

    Ok(applied)
}

/// I2(PLAN-2026-09-05 §5-8 업그레이드 경로) — `attachments::add_link_if_absent_tx`의 짝.
/// `ai_apply_organize`가 되돌릴 수 없다고 알렸던 "AI가 추가한 출처 링크"를 이제 정확한 URL
/// 일치로 지운다. attachments/mod.rs는 이번 웨이브 수정 범위 밖이라(다른 세션 WIP 없음, 단순히
/// 이 워크아이템의 파일 allowlist 밖) 여기서 직접 SQL로 처리한다 — kind='link'인 첨부는
/// rel_path가 항상 NULL이라 `attachments::remove`가 하는 파일/썸네일 삭제가 필요 없고, DELETE +
/// tombstone 두 줄이 전부다(같은 패턴을 이미 `note_purge`가 attachments에 대해 쓰고 있다,
/// 위 캐스케이드 tombstone 참고). 여러 개가 같은 URL로 중복 저장돼 있으면(정상 경로로는
/// `add_link_if_absent_tx`가 막지만) 방어적으로 전부 지운다. 반환값은 실제로 지운 게 있는지.
pub(crate) fn remove_link_by_url_tx(tx: &Transaction<'_>, note_id: &str, url: &str) -> AppResult<bool> {
    let url = url.trim();
    let ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM attachments WHERE note_id=?1 AND kind='link' AND url=?2")
            .map_err(dberr)?;
        let rows = stmt
            .query_map(params![note_id, url], |r| r.get::<_, String>(0))
            .map_err(dberr)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(dberr)?
    };
    if ids.is_empty() {
        return Ok(false);
    }
    for aid in &ids {
        tx.execute("DELETE FROM attachments WHERE id=?1", params![aid]).map_err(dberr)?;
        crate::repo::tombstone::record_tombstone(tx, "attachments", aid)?;
    }
    Ok(true)
}

/// `ai_apply_organize`와 AI 플랜 command가 같은 트랜잭션에 메타데이터를 넣을 수 있는 내부 seam.
/// 호출자가 이미 note/folder 등 나머지 입력을 검증한 뒤 사용하며, 이 함수는 절대 commit하지 않는다.
pub(crate) fn apply_ai_organize_in_tx(
    tx: &Transaction<'_>,
    summary: &NoteSummary,
    title_opt: Option<String>,
    year_opt: Option<i64>,
    tags_opt: Option<Vec<String>>,
) -> AppResult<Vec<String>> {
    let id = &summary.id;
    let mut applied = Vec::new();

    if let Some(y) = year_opt {
        if !(YEAR_MIN..=YEAR_MAX).contains(&y) {
            return Err(AppError::Validation(format!("year out of range: {y}")));
        }
    }

    let now = now_iso();
    let mut changed_core = false;

    if let Some(ref t) = title_opt {
        if summary.title != *t {
            tx.execute("UPDATE notes SET title=?1 WHERE id=?2", params![t, id]).map_err(dberr)?;
            applied.push("title".to_string());
            changed_core = true;
        }
    }
    if let Some(y) = year_opt {
        if summary.year != y {
            // W1 투영 규율(update() 와 같은 이유): 사건 축의 진실은 position=0 note_dates 행이다.
            // 여기서 notes.year 를 직접 쓰면 다음 날짜 mutation 의 project_primary 가 AI 가 적용한
            // 연도를 조용히 되돌린다.
            tx.execute(
                "UPDATE note_dates SET year=?1 WHERE note_id=?2 AND position=0",
                params![y, id],
            )
            .map_err(dberr)?;
            dates::project_primary(&tx, id)?;
            applied.push("year".to_string());
            changed_core = true;
        }
    }
    
    if changed_core {
        tx.execute("UPDATE notes SET updated_at=?1 WHERE id=?2", params![now, id]).map_err(dberr)?;
    }
    
    let mut changed_tags = false;
    if let Some(tag_names_in) = tags_opt {
        let mut old_tags = summary.tag_names.clone();
        old_tags.sort();

        let seen = normalize_tag_names(tag_names_in);

        let mut new_tags = seen.clone();
        new_tags.sort();

        if old_tags != new_tags {
            replace_note_tags(&tx, id, &seen)?;

            applied.push("tags".to_string());
            changed_tags = true;
        }
    }
    
    if changed_core || changed_tags {
        fts::fts_upsert(&tx, id)?;
    }

    Ok(applied)
}

// Wave 4: 연관 노트 제외/복원
//
// tombstone id 는 복합 PK 를 `"{id_1}:{id_2}"` 로 합성한다(docs/SYNC.md §8.2 결정 a —
// note_tags 와 동일 패턴). 저장 시 이미 min/max 정렬되므로 합성 문자열도 정규형이다.
fn related_exclusion_tombstone_id(id_1: &str, id_2: &str) -> String {
    format!("{id_1}:{id_2}")
}

pub fn related_exclude(conn: &Connection, id_1: &str, id_2: &str) -> AppResult<()> {
    // 순서 보장: (min_id, max_id)
    let (min_id, max_id) = if id_1 < id_2 { (id_1, id_2) } else { (id_2, id_1) };
    conn.execute(
        "INSERT OR IGNORE INTO note_related_exclusions(id_1, id_2, created_at) VALUES (?1, ?2, ?3)",
        params![min_id, max_id, now_iso()],
    )
    .map_err(dberr)?;
    Ok(())
}

pub fn related_restore(conn: &mut Connection, id: &str) -> AppResult<i64> {
    let pairs: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id_1, id_2 FROM note_related_exclusions WHERE id_1 = ?1 OR id_2 = ?1",
            )
            .map_err(dberr)?;
        let rows = stmt
            .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(dberr)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(dberr)?
    };
    if pairs.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction().map_err(dberr)?;
    for (a, b) in &pairs {
        tx.execute(
            "DELETE FROM note_related_exclusions WHERE id_1 = ?1 AND id_2 = ?2",
            params![a, b],
        )
        .map_err(dberr)?;
        // 삭제 전파 — 복합 PK 를 단일 tombstone id 로 합성(SYNC.md §8.2).
        crate::repo::tombstone::record_tombstone(
            &tx,
            "note_related_exclusions",
            &related_exclusion_tombstone_id(a, b),
        )?;
    }
    tx.commit().map_err(dberr)?;
    Ok(pairs.len() as i64)
}

pub fn related_hidden_count(conn: &Connection, id: &str) -> AppResult<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM note_related_exclusions WHERE id_1 = ?1 OR id_2 = ?1",
        [id],
        |r| r.get(0),
    )
    .map_err(dberr)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::{attachments, folders, search};

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        // purge() 의 자식 행 CASCADE(sections/sources/attachments/note_tags)는
        // foreign_keys pragma가 켜져 있어야 발동한다 — db::bootstrap은 켜지만, 이 테스트는 순수
        // in-memory Connection이라 직접 켠다 (db/migrations.rs::test_v8_* 와 동일 패턴).
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    /// 더보기 메뉴 "내용잠금" — toggle_favorite와 정확히 같은 왕복(뒤집기 + 영속 + 재조회로 확인)을
    /// content_locked에 대해서도 검증한다. 기본값(V84 DEFAULT 0)이 해제 상태인 것도 여기서 확인.
    #[test]
    fn test_toggle_content_lock_flips_and_persists() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = create(&mut conn, &folder_id, Some("Lockable Note".into()), None).unwrap();
        assert!(!detail.note.content_locked, "새 노트는 기본으로 잠겨 있지 않다");

        let locked = toggle_content_lock(&mut conn, &detail.note.id).unwrap();
        assert!(locked, "첫 토글은 잠금을 켠다");
        assert!(note_summary(&conn, &detail.note.id).unwrap().content_locked);

        let unlocked = toggle_content_lock(&mut conn, &detail.note.id).unwrap();
        assert!(!unlocked, "두 번째 토글은 다시 해제한다");
        assert!(!note_summary(&conn, &detail.note.id).unwrap().content_locked);
    }

    /// create() must still stamp now_iso() (both created_at/updated_at) now that it's a thin
    /// wrapper over create_with_timestamp(..., None, None) — a future edit to the wrapper (or to
    /// create_with_timestamp's None-handling) that silently starts leaving these blank/stale
    /// would otherwise sail through every other test here, since none of them assert on
    /// created_at/updated_at at all.
    #[test]
    fn test_create_still_stamps_now_iso() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let before = now_iso();
        let detail = create(&mut conn, &folder_id, Some("Fresh Note".into()), None).unwrap();
        let after = now_iso();
        assert!(detail.note.created_at >= before && detail.note.created_at <= after);
        assert_eq!(detail.note.created_at, detail.note.updated_at);
    }

    /// PLAN-2026-09-08-dates-rebuild.md §7-1(투영 드리프트) — AI 정리가 연도를 바꾸는 경로가
    /// `notes.year` 를 직접 쓰고 있었다. 그러면 진실(position=0 note_dates 행)은 옛 연도인 채라
    /// **다음 날짜 mutation 의 project_primary 가 AI 가 적용한 연도를 조용히 되돌린다.**
    /// 이 테스트는 "적용 직후 화면에 보이는가"가 아니라 **그 뒤 다른 날짜 작업을 해도 살아남는가**
    /// 를 본다 — 전자만 보면 드리프트를 못 잡는다(적용 직후엔 두 값이 우연히 같아 보인다).
    #[test]
    fn apply_ai_organize_year_survives_a_later_projection() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let d = create(&mut conn, &folder_id, Some("연도 바뀔 노트".into()), Some(2020)).unwrap();

        apply_ai_organize(&mut conn, &d.note.id, None, Some(2030), None).unwrap();

        // 진실이 옮겨갔는가.
        let truth: i64 = conn
            .query_row(
                "SELECT year FROM note_dates WHERE note_id=?1 AND position=0",
                [&d.note.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(truth, 2030, "position=0 행이 사건 축의 진실이다");

        // 아무 날짜 mutation 이나 하나 — project_primary 가 다시 돈다.
        // (`set_remind` 는 `pub use dates::*` 로 note_dates **행** 세터가 잡히므로 쓰지 않는다.)
        set_event_end(&mut conn, &d.note.id, Some(2031), None, None).unwrap();

        let after: i64 = conn
            .query_row("SELECT year FROM notes WHERE id=?1", [&d.note.id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 2030, "투영이 AI 가 적용한 연도를 되돌리면 안 된다");
    }

    /// life-recording 피벗: note_create 커맨드가 쓰는 create_today_default 는 year/month/day를
    /// 모두 생략하면 오늘(로컬)의 y/m/d를 채운다 — "말 안 했으면 지금"이 새 기본값.
    #[test]
    fn test_create_today_default_fills_full_precision_when_all_omitted() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let (ty, tm, td) = crate::util::today_ymd_local();
        let detail = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(detail.note.year, ty);
        assert_eq!(detail.note.month, Some(tm));
        assert_eq!(detail.note.day, Some(td));
    }

    /// An explicit value for any of year/month/day must win over the today-default — e.g.
    /// ContextMenu's "duplicate" note passes the source note's full date through unchanged.
    #[test]
    fn test_create_today_default_respects_explicit_values() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail =
            create_today_default(&mut conn, &folder_id, None, Some(1592), Some(5), Some(13))
                .unwrap();
        assert_eq!(detail.note.year, 1592);
        assert_eq!(detail.note.month, Some(5));
        assert_eq!(detail.note.day, Some(13));
    }

    /// 실험적 노트북 설정(2026-09-20, 오너 "넣어봐 보고 이상하면 지울게") — new_note_date_precision
    /// "year"면 순수 "오늘" 기본값 경로(연/월/일 전부 미지정)가 연도만 채우고 month/day 는 NULL 이어야
    /// 한다. 아직 settings_schema::NOTEBOOK_KEYS 에 등록되지 않았을 수 있어(다른 세션이 동시 작업 중)
    /// workspace_settings 에 직접 SQL 로 심는다(validate_setting 경유로는 미등록 키가 거부된다).
    /// **이 테스트는 프로덕션 코드 변경 전에 먼저 추가해 실패를 확인한 것이다(failing-first).**
    #[test]
    fn test_create_today_default_year_precision_setting_leaves_month_day_null() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, 'new_note_date_precision', '\"year\"')",
            [&ws],
        )
        .unwrap();

        let (ty, _, _) = crate::util::today_ymd_local();
        let detail = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(detail.note.year, ty);
        assert_eq!(detail.note.month, None);
        assert_eq!(detail.note.day, None);

        let row: (i64, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT year, month, day FROM note_dates WHERE note_id=?1 AND position=0",
                [&detail.note.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (ty, None, None), "position=0 note_dates row must agree with notes.* projection");
    }

    /// 실험적 노트북 설정 테스트 전용 헬퍼 — `new_note_date_precision`/`new_note_section_name` 은
    /// 아직 settings_schema::NOTEBOOK_KEYS 에 등록되지 않았을 수 있다(다른 세션이 동시에 그 파일을
    /// 작업 중, 2026-09-20). `settings::set()`(→ validate_setting)을 거치면 미등록 키가 VALIDATION
    /// 으로 거부되므로, 여기서는 그 관문을 우회해 workspace_settings 테이블에 직접 SQL 로 심는다 —
    /// 즉 이 파일의 테스트들은 아직 "설정 등록 절반"과 "이 읽기 로직 절반"을 함께 왕복 검증하지
    /// 않는다(오케스트레이터에게 보고할 사항).
    fn put_notebook_setting_raw(conn: &Connection, workspace_id: &str, key: &str, json_value: &str) {
        conn.execute(
            "INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value",
            params![workspace_id, key, json_value],
        )
        .unwrap();
    }

    /// month 정밀도 — 오늘의 연+월만 채우고 day 는 NULL. notes.* 투영과 note_dates position=0 행이
    /// 일치해야 한다(project_primary 경유 확인 — year precision 테스트와 짝).
    #[test]
    fn test_new_note_date_precision_month_sets_month_only() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        put_notebook_setting_raw(&conn, &ws, "new_note_date_precision", "\"month\"");

        let (ty, tm, _) = crate::util::today_ymd_local();
        let detail = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(detail.note.year, ty);
        assert_eq!(detail.note.month, Some(tm));
        assert_eq!(detail.note.day, None);

        let row: (i64, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT year, month, day FROM note_dates WHERE note_id=?1 AND position=0",
                [&detail.note.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (ty, Some(tm), None));
    }

    /// day 정밀도(기본값)를 **명시적으로** 저장해도 지금까지의 전체 정밀도 동작과 픽셀 동일해야
    /// 한다 — "설정이 없음"과 "설정이 day 로 켜져 있음"을 같은 결과로 수렴시킨다.
    #[test]
    fn test_new_note_date_precision_day_matches_full_precision() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        put_notebook_setting_raw(&conn, &ws, "new_note_date_precision", "\"day\"");

        let (ty, tm, td) = crate::util::today_ymd_local();
        let detail = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!((detail.note.year, detail.note.month, detail.note.day), (ty, Some(tm), Some(td)));
    }

    /// 구 DB(행 없음)와 손상/미지 값(구 문자열 · 41자 이름 · 개행 포함 이름 · 문자열이 아닌 JSON)
    /// 은 전부 기본값(day 정밀도 · 내장 섹션 이름)으로 폴백해야 한다 — 아직
    /// settings_schema::validate_setting 의 보호를 받지 않는 값도 **읽는 시점**에 방어해야 한다는
    /// 게 이 실험 기능의 핵심 요구사항(오너 지시서 "old DB" 케이스).
    #[test]
    fn test_new_note_settings_absent_or_invalid_fall_back_to_defaults() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        let (ty, tm, td) = crate::util::today_ymd_local();

        // 1) 설정 행이 아예 없음(구 DB).
        let absent = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!((absent.note.year, absent.note.month, absent.note.day), (ty, Some(tm), Some(td)));
        assert_eq!(absent.sections[0].name, "개요");

        // 2) 미지 문자열 정밀도 + 41자 섹션 이름.
        put_notebook_setting_raw(&conn, &ws, "new_note_date_precision", "\"weekly\"");
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", &format!("\"{}\"", "a".repeat(41)));
        let invalid1 = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(
            (invalid1.note.year, invalid1.note.month, invalid1.note.day),
            (ty, Some(tm), Some(td)),
            "unknown precision string falls back to day"
        );
        assert_eq!(invalid1.sections[0].name, "개요", "41-char name falls back to built-in");

        // 3) 개행이 섞인 이름.
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"line1\\nline2\"");
        let invalid2 = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(invalid2.sections[0].name, "개요", "name with a newline falls back to built-in");

        // 4) 문자열이 아닌 JSON 값(숫자).
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "5");
        let invalid3 = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(invalid3.sections[0].name, "개요", "non-string JSON value falls back to built-in");
    }

    /// year/month/day 중 하나라도 호출자가 명시하면(예: 노트 복제가 연도만/연+월만/전체를 넘기는
    /// 경우) `new_note_date_precision` 은 완전히 무시되고 기존의 "필드별 독립 오늘 폴백"이 그대로
    /// 적용된다 — 부분 입력을 이 설정으로 재해석하지 않는다.
    #[test]
    fn test_new_note_date_precision_setting_ignored_when_any_field_is_explicit() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        put_notebook_setting_raw(&conn, &ws, "new_note_date_precision", "\"year\"");
        let (_, tm, td) = crate::util::today_ymd_local();

        // year 만 명시 — month/day 는 설정과 무관하게 오늘 값으로 채워지는 기존 동작.
        let d1 = create_today_default(&mut conn, &folder_id, None, Some(1592), None, None).unwrap();
        assert_eq!((d1.note.year, d1.note.month, d1.note.day), (1592, Some(tm), Some(td)));

        // year+month 명시 — day 만 오늘 값.
        let d2 = create_today_default(&mut conn, &folder_id, None, Some(1592), Some(5), None).unwrap();
        assert_eq!((d2.note.year, d2.note.month, d2.note.day), (1592, Some(5), Some(td)));

        // 전체 명시 — 그대로.
        let d3 = create_today_default(&mut conn, &folder_id, None, Some(1592), Some(5), Some(13)).unwrap();
        assert_eq!((d3.note.year, d3.note.month, d3.note.day), (1592, Some(5), Some(13)));
    }

    /// 섹션 이름 — 적용 / trim / 공백만 있으면 내장 이름으로 폴백.
    #[test]
    fn test_new_note_section_name_applied_trimmed_or_falls_back_when_blank() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();

        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"  일지  \"");
        let d1 = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d1.sections[0].name, "일지", "surrounding whitespace is trimmed");

        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"   \"");
        let d2 = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d2.sections[0].name, "개요", "whitespace-only trims to empty -> built-in");
    }

    /// 노트는 **폴더**가 속한 노트북의 설정을 읽는다 — **활성** 노트북이 아니다. 두 노트북에 서로
    /// 다른 값을 넣고, 비활성 노트북(B) 소속 폴더에 노트를 만들어 B 의 값이 적용되는지, 활성(A)
    /// 소속 폴더에 만들면 여전히 A(기본값)가 적용되는지 함께 확인한다.
    #[test]
    fn test_new_note_settings_read_from_folders_notebook_not_active() {
        let mut conn = setup_db();
        let a = folders::active_workspace_id(&conn).unwrap();
        let b = crate::repo::workspaces::create(&mut conn, "B").unwrap().id;
        assert_eq!(folders::active_workspace_id(&conn).unwrap(), a, "creating B must not activate it");

        put_notebook_setting_raw(&conn, &b, "new_note_date_precision", "\"year\"");
        put_notebook_setting_raw(&conn, &b, "new_note_section_name", "\"Log\"");
        let folder_b = folders::create(&mut conn, "B의 폴더", Some(b.clone()), None, None, None)
            .unwrap()
            .id;

        let (ty, _, _) = crate::util::today_ymd_local();
        let detail_b = create_today_default(&mut conn, &folder_b, None, None, None, None).unwrap();
        assert_eq!(detail_b.note.year, ty);
        assert_eq!(detail_b.note.month, None, "폴더가 속한 노트북(B)의 정밀도 설정을 읽어야 한다");
        assert_eq!(detail_b.note.day, None);
        assert_eq!(detail_b.sections[0].name, "Log");

        // 대조군: 활성 노트북(A) 소속 폴더는 여전히 기본값(A 엔 이 설정이 없다) — 활성이었다면
        // 새지 않아야 할 B 값이 실제로 새지 않는지를 확인한다.
        let folder_a: String = conn
            .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&a], |r| r.get(0))
            .unwrap();
        let (ty2, tm2, td2) = crate::util::today_ymd_local();
        let detail_a = create_today_default(&mut conn, &folder_a, None, None, None, None).unwrap();
        assert_eq!(
            (detail_a.note.year, detail_a.note.month, detail_a.note.day),
            (ty2, Some(tm2), Some(td2))
        );
        assert_eq!(detail_a.sections[0].name, "개요");
    }

    /// 끝에서 끝까지 — **진짜 저장 경로**(repo::settings::set: allowlist 검증 → workspace_settings 에
    /// JSON 으로 저장)로 쓴 값을 생성 경로가 읽는다. 이 기능의 두 반쪽(키 등록 / 읽기)은 서로 다른
    /// 작업자가 병렬로 만들었고, 위 테스트들은 키가 아직 등록되기 전이라 값을 raw SQL 로 넣었다 —
    /// 저장 인코딩과 읽기 파싱이 어긋나면 조용히 기본값으로 떨어지는 버그라(설정을 바꿔도 아무 일도
    /// 안 일어난다) 이 테스트가 그 이음매를 고정한다. 키가 allowlist/NOTEBOOK_KEYS 에서 빠지면
    /// `set` 이 거부하거나 전역 테이블에 써서 여기서 드러난다.
    #[test]
    fn test_new_note_settings_saved_through_the_real_setter_reach_note_creation() {
        use std::collections::BTreeMap;
        let mut conn = setup_db();
        let ws = folders::active_workspace_id(&conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1", [&ws], |r| r.get(0))
            .unwrap();

        let mut entries: BTreeMap<String, JsonValue> = BTreeMap::new();
        entries.insert("new_note_date_precision".into(), JsonValue::String("month".into()));
        entries.insert("new_note_section_name".into(), JsonValue::String("  일지  ".into()));
        settings::set(&mut conn, &entries).expect("both keys must be on the allowlist");
        let landed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_settings WHERE workspace_id=?1
                 AND key IN ('new_note_date_precision','new_note_section_name')",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(landed, 2, "노트북별 키라 workspace_settings 에 저장돼야 생성 경로가 읽는다");

        let (ty, tm, _) = crate::util::today_ymd_local();
        let detail = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!((detail.note.year, detail.note.month, detail.note.day), (ty, Some(tm), None));
        assert_eq!(detail.sections[0].name, "일지");

        // 기본값으로 되돌리면 원래 동작으로 돌아온다(빈 이름 = 내장 이름).
        let mut back: BTreeMap<String, JsonValue> = BTreeMap::new();
        back.insert("new_note_date_precision".into(), JsonValue::String("day".into()));
        back.insert("new_note_section_name".into(), JsonValue::String(String::new()));
        settings::set(&mut conn, &back).unwrap();
        let (ty2, tm2, td2) = crate::util::today_ymd_local();
        let detail2 = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!((detail2.note.year, detail2.note.month, detail2.note.day), (ty2, Some(tm2), Some(td2)));
        assert_eq!(detail2.sections[0].name, "개요");
    }

    /// 언어별 새 노트 첫 섹션 기본 이름: ko "개요", en "Overview", fr "Aperçu".
    #[test]
    fn test_new_note_section_name_defaults_by_ui_lang() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();

        // 1) ko (기본) -> "개요"
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"ko\"");
        let d_ko = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_ko.sections[0].name, "개요");

        // 2) en -> "Overview"
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"en\"");
        let d_en = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_en.sections[0].name, "Overview");

        // 3) fr -> "Aperçu"
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"fr\"");
        let d_fr = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_fr.sections[0].name, "Aperçu");

        // 4) 알 수 없는 언어 -> "개요" 폴백
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"de\"");
        let d_de = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_de.sections[0].name, "개요");
    }

    /// `new_note_section_name` 설정이 있으면 UI 언어와 무관하게 항상 우선한다.
    #[test]
    fn test_new_note_section_name_override_wins_over_ui_lang() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();

        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"회의록\"");

        // ko 환경에서도 override 가 우선
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"ko\"");
        let d_ko = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_ko.sections[0].name, "회의록");

        // fr 환경에서도 override 가 우선
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"fr\"");
        let d_fr = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_fr.sections[0].name, "회의록");
    }

    /// 잘못된 `new_note_section_name` 설정은 UI 언어 기본값으로 폴백한다.
    #[test]
    fn test_new_note_section_name_invalid_override_falls_back_to_language_default() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();

        // 1) fr 환경에서 41자 초과 이름 -> "Aperçu" 폴백
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"fr\"");
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", &format!("\"{}\"", "a".repeat(41)));
        let d_fr = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_fr.sections[0].name, "Aperçu");

        // 2) en 환경에서 개행 포함 이름 -> "Overview" 폴백
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"en\"");
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"line1\\nline2\"");
        let d_en = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_en.sections[0].name, "Overview");

        // 3) ko 환경에서 공백만 있는 이름 -> "개요" 폴백
        put_notebook_setting_raw(&conn, &ws, "ui_lang", "\"ko\"");
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"   \"");
        let d_ko = create_today_default(&mut conn, &folder_id, None, None, None, None).unwrap();
        assert_eq!(d_ko.sections[0].name, "개요");
    }

    /// "today default" 경로를 거치지 않는 형제 생성 경로(migrate/import/board/calendar/timeline/
    /// pet/schedule 이 모두 이걸 직접 부른다)는 이 실험 기능과 완전히 무관해야 한다 — 폴더의
    /// 노트북에 두 설정이 모두 켜져 있어도 `create_with_timestamp` 는 여전히 Overview 섹션과
    /// 호출자가 넘긴 month/day 를 그대로(오늘로 채우지도, 건드리지도 않고) 쓴다.
    #[test]
    fn create_with_timestamp_is_unaffected_by_the_experimental_notebook_settings() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        put_notebook_setting_raw(&conn, &ws, "new_note_date_precision", "\"year\"");
        put_notebook_setting_raw(&conn, &ws, "new_note_section_name", "\"Custom\"");

        let detail = create_with_timestamp(
            &mut conn,
            &folder_id,
            Some("Sibling".into()),
            Some(1899),
            Some(3),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(detail.sections[0].name, DEFAULT_SECTION_NAME, "migrate/import 등 형제 경로는 Overview 그대로");
        assert_eq!(detail.note.year, 1899);
        assert_eq!(detail.note.month, Some(3), "explicit month passed through unchanged");
        assert_eq!(detail.note.day, None, "no today-fallback on this path");
    }

    /// create_with_timestamp itself must stay a dumb passthrough for month/day (no defaulting) —
    /// this is the contract migrate::commit_staged relies on (a note with no discoverable date in
    /// the source doc must land with month/day still NULL, not "today").
    #[test]
    fn test_create_with_timestamp_leaves_month_day_null_when_omitted() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = create_with_timestamp(
            &mut conn,
            &folder_id,
            None,
            Some(1592),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(detail.note.year, 1592);
        assert_eq!(detail.note.month, None);
        assert_eq!(detail.note.day, None);
    }


    #[test]
    fn test_note_set_location_persists_and_validates_range() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let n = create(&mut conn, &folder_id, Some("Location Note".into()), Some(2026)).unwrap();

        // 1. Initial location is None
        let summary = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!(summary.lat, None);
        assert_eq!(summary.lng, None);

        // 2. Set valid coordinates (Paris: ~48.8566, 2.3522)
        let updated = set_location(&mut conn, &n.note.id, Some(48.8566), Some(2.3522)).unwrap();
        assert_eq!(updated.lat, Some(48.8566));
        assert_eq!(updated.lng, Some(2.3522));

        let reloaded = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!(reloaded.lat, Some(48.8566));
        assert_eq!(reloaded.lng, Some(2.3522));

        // 3. Clear coordinates
        let cleared = set_location(&mut conn, &n.note.id, None, None).unwrap();
        assert_eq!(cleared.lat, None);
        assert_eq!(cleared.lng, None);

        // 4. Validate lat range (-90..90)
        let err_lat = set_location(&mut conn, &n.note.id, Some(95.0), Some(10.0)).unwrap_err();
        assert!(matches!(err_lat, AppError::Validation(_)));

        // 5. Validate lng range (-180..180)
        let err_lng = set_location(&mut conn, &n.note.id, Some(10.0), Some(-185.0)).unwrap_err();
        assert!(matches!(err_lng, AppError::Validation(_)));

        // 6. Validate half-coordinate rejected
        let err_half = set_location(&mut conn, &n.note.id, Some(10.0), None).unwrap_err();
        assert!(matches!(err_half, AppError::Validation(_)));
    }

    // ── I2: remove_link_by_url_tx (add_link_if_absent_tx의 짝) ─────────────────────────────────
    #[test]
    fn remove_link_by_url_tx_deletes_matching_link_and_tombstones_it() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Link Note".into()), Some(2026)).unwrap();
        attachments::add_link(&mut conn, &n.note.id, "source", "https://example.com/a").unwrap();

        let tx = conn.transaction().unwrap();
        let removed = remove_link_by_url_tx(&tx, &n.note.id, "https://example.com/a").unwrap();
        assert!(removed);
        tx.commit().unwrap();

        let remaining = attachments::load_for_note(&conn, &n.note.id).unwrap();
        assert!(remaining.is_empty(), "link must be gone after removal");
        let tombstoned: i64 = conn
            .query_row("SELECT COUNT(*) FROM deleted_rows WHERE tbl='attachments'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tombstoned, 1, "removal must propagate a tombstone like other attachment deletes");

        // Removing an already-absent URL is a no-op, not an error (retry-safety for AI apply's revert).
        let tx2 = conn.transaction().unwrap();
        let removed_again = remove_link_by_url_tx(&tx2, &n.note.id, "https://example.com/a").unwrap();
        assert!(!removed_again);
        tx2.commit().unwrap();
    }


    /// Phase 1 B안: folder_list 는 경량 요약만(tag_names=[], has_image=false).
    /// 태그는 note_tags_index, 이미지는 has_image_for_note / note_summaries_map.
    #[test]
    fn test_folder_list_is_lightweight_tags_via_index() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();

        let detail = create(&mut conn, &folder_id, Some("Light Note".into()), Some(1800)).unwrap();
        let note_id = detail.note.id.clone();
        set_tags(&mut conn, &note_id, vec!["alpha".into(), "beta".into()]).unwrap();
        // 이미지 첨부 한 건 — list 에는 반영되지 않아야 하고 has_image_for_note 에는 잡혀야 함.
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, position, created_at)
             VALUES ('att1', ?1, 'x.png', 'image', 'x.png', 0, '2020-01-01T00:00:00Z')",
            [&note_id],
        )
        .unwrap();

        let list = folders::list(&conn, Some(ws_id.clone())).unwrap();
        let n = list
            .notes_by_folder
            .get(&folder_id)
            .unwrap()
            .iter()
            .find(|n| n.id == note_id)
            .expect("note in folder_list");
        assert!(n.tag_names.is_empty(), "folder_list must not ship tags");
        assert!(!n.has_image, "folder_list must not ship has_image");
        assert_eq!(n.title, "Light Note");
        assert_eq!(n.year, 1800);

        let tags = folders::note_tags_index(&conn, Some(ws_id)).unwrap();
        let mut got = tags.get(&note_id).cloned().unwrap_or_default();
        got.sort();
        assert_eq!(got, vec!["alpha".to_string(), "beta".to_string()]);

        assert!(attachments::has_image_for_note(&conn, &note_id).unwrap());
        // 검색/related 배치 헬퍼는 여전히 무거운 필드를 채운다.
        let full = note_summaries_map(&conn, &[note_id.clone()]).unwrap();
        let full_n = full.get(&note_id).unwrap();
        assert!(full_n.has_image);
        assert!(full_n.tag_names.contains(&"alpha".to_string()));
    }

    // Trash 핵심 회귀 테스트 — 소프트 삭제가 folder_list/검색/related/note_summaries_map 전
    // "노출" 사이트에서 실제로 노트를 숨기는지, 휴지통 목록에는 나타나는지, 복구 시 전부
    // 원상복구되는지, 삭제 후 purge 시 완전히 사라지고 자식 행까지 CASCADE 정리되는지 검증한다.
    // 필터 사이트를 하나라도 빠뜨리면(=휴지통 노트 유출) 여기서 실패해야 하는 안전망이다.
    #[test]
    fn test_trash_lifecycle_soft_delete_restore_purge() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();

        // 검색 가능하도록 섹션 본문(기본 Overview 섹션에 제목이 들어감) + 태그가 있는 노트 생성.
        let detail = create(&mut conn, &folder_id, Some("Trash Test Note".into()), Some(1500)).unwrap();
        let note_id = detail.note.id.clone();
        set_tags(&mut conn, &note_id, vec!["archive".into()]).unwrap();

        // ── 삭제 전: folder_list / 검색 둘 다에 노출되어야 한다 ──
        let list_before = folders::list(&conn, Some(ws_id.clone())).unwrap();
        assert!(list_before
            .notes_by_folder
            .get(&folder_id)
            .unwrap()
            .iter()
            .any(|n| n.id == note_id));
        let search_before = search::search(&conn, "Trash Test", Some(900), Some(1960), Some(ws_id.clone()), None).unwrap();
        assert!(search_before.results.iter().any(|n| n.id == note_id));

        // ── 소프트 삭제 ──
        assert!(delete(&mut conn, &note_id).unwrap());

        // folder_list 에서 사라짐.
        let list_after_delete = folders::list(&conn, Some(ws_id.clone())).unwrap();
        assert!(!list_after_delete
            .notes_by_folder
            .get(&folder_id)
            .unwrap()
            .iter()
            .any(|n| n.id == note_id));
        // 검색에서 사라짐(FTS 색인 제거 + note_summaries_for_ids 필터 이중 방어).
        let search_after_delete = search::search(&conn, "Trash Test", Some(900), Some(1960), Some(ws_id.clone()), None).unwrap();
        assert!(!search_after_delete.results.iter().any(|n| n.id == note_id));
        // note_summaries_map 배치 로더(search/related/vector 공용)에서도 제외.
        let batch = note_summaries_map(&conn, &[note_id.clone()]).unwrap();
        assert!(!batch.contains_key(&note_id));
        // 하지만 휴지통 목록에는 나타난다.
        let trash = trash_list(&conn, Some(ws_id.clone())).unwrap();
        assert!(trash.iter().any(|n| n.id == note_id));
        // 자식 행은 아직 살아있다(복구를 위해) — 소프트 삭제는 CASCADE 하지 않는다.
        let section_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sections WHERE note_id=?1",
                [&note_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(section_count, 1, "soft delete must not cascade children");
        // notes 행 자체도 여전히 존재(하드 삭제 아님) — orphan_cleanup 이 첨부를 보존하는 전제.
        let row_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(row_exists, 1);

        // related() 도 삭제된 노트를 후보로 제안하지 않아야 한다 — 같은 태그를 가진 형제 노트를
        // 하나 더 만들고, 그 형제의 related() 결과에 삭제된 노트가 없는지 확인.
        let sibling = create(&mut conn, &folder_id, Some("Sibling Note".into()), Some(1501)).unwrap();
        set_tags(&mut conn, &sibling.note.id, vec!["archive".into()]).unwrap();
        let related_results = related(&conn, &sibling.note.id, 10).unwrap();
        assert!(!related_results.iter().any(|n| n.id == note_id));

        // ── 복구 ──
        assert!(restore(&mut conn, &note_id).unwrap());
        let list_after_restore = folders::list(&conn, Some(ws_id.clone())).unwrap();
        assert!(list_after_restore
            .notes_by_folder
            .get(&folder_id)
            .unwrap()
            .iter()
            .any(|n| n.id == note_id));
        let search_after_restore = search::search(&conn, "Trash Test", Some(900), Some(1960), Some(ws_id.clone()), None).unwrap();
        assert!(search_after_restore.results.iter().any(|n| n.id == note_id));
        let trash_after_restore = trash_list(&conn, Some(ws_id.clone())).unwrap();
        assert!(!trash_after_restore.iter().any(|n| n.id == note_id));

        // ── 소프트 삭제 후 완전 삭제(purge) ──
        assert!(delete(&mut conn, &note_id).unwrap());
        assert!(purge(&mut conn, data_dir, &note_id).unwrap());

        // 휴지통에서도 완전히 사라짐.
        let trash_after_purge = trash_list(&conn, Some(ws_id.clone())).unwrap();
        assert!(!trash_after_purge.iter().any(|n| n.id == note_id));
        // notes 행 자체가 사라짐 + 자식 행(CASCADE)도 사라짐.
        let row_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert_eq!(row_exists, 0);
        let section_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sections WHERE note_id=?1",
                [&note_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(section_count, 0, "purge must cascade-delete children");
    }

    /// W7-f 아카이브 round-trip: 트리(folders::list)/note_query 기본 경로/대시보드 보드에서는
    /// 숨기지만, FTS 색인은 그대로 남아 search::search 가 계속 찾는다는 계약 검증(휴지통과의
    /// 핵심 차이). include_archived opt-in 축과 unarchive 복구도 함께 확인.
    #[test]
    fn test_archive_lifecycle_hidden_but_fts_searchable_and_unarchive_restores() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();

        let detail = create(&mut conn, &folder_id, Some("Archive Test Note".into()), Some(1500)).unwrap();
        let note_id = detail.note.id.clone();

        // ── 아카이브 전: 트리/note_query 기본/검색/보드 전부에 노출 ──
        let list_before = folders::list(&conn, Some(ws_id.clone())).unwrap();
        assert!(list_before.notes_by_folder.get(&folder_id).unwrap().iter().any(|n| n.id == note_id));
        let q_before = query(&conn, NoteQuery { workspace_id: Some(ws_id.clone()), ..Default::default() }).unwrap();
        assert!(q_before.notes.iter().any(|n| n.id == note_id));
        let search_before = search::search(&conn, "Archive Test", Some(900), Some(1960), Some(ws_id.clone()), None).unwrap();
        assert!(search_before.results.iter().any(|n| n.id == note_id));
        let board_before = crate::repo::dashboard::board(&conn, &ws_id).unwrap();
        assert!(board_before.columns.iter().flat_map(|c| &c.notes).any(|n| n.id == note_id));

        // ── 아카이브 ──
        assert!(archive(&mut conn, &note_id).unwrap());

        // 트리에서 사라짐.
        let list_after = folders::list(&conn, Some(ws_id.clone())).unwrap();
        assert!(!list_after.notes_by_folder.get(&folder_id).unwrap().iter().any(|n| n.id == note_id));
        // note_query 기본(include_archived 생략=false)에서도 사라짐, total 도 그만큼 줄어야 한다.
        let q_after = query(&conn, NoteQuery { workspace_id: Some(ws_id.clone()), ..Default::default() }).unwrap();
        assert!(!q_after.notes.iter().any(|n| n.id == note_id));
        assert_eq!(q_after.total, q_before.total - 1);
        // opt-in 축: include_archived=true 면 다시 섞여 나온다.
        let q_included = query(
            &conn,
            NoteQuery { workspace_id: Some(ws_id.clone()), include_archived: true, ..Default::default() },
        )
        .unwrap();
        assert!(q_included.notes.iter().any(|n| n.id == note_id));
        // 대시보드 보드에서도 사라짐.
        let board_after = crate::repo::dashboard::board(&conn, &ws_id).unwrap();
        assert!(!board_after.columns.iter().flat_map(|c| &c.notes).any(|n| n.id == note_id));
        // ── FTS 유지 계약: 검색에는 계속 나와야 한다 (휴지통과의 핵심 차이) ──
        let search_after = search::search(&conn, "Archive Test", Some(900), Some(1960), Some(ws_id.clone()), None).unwrap();
        assert!(
            search_after.results.iter().any(|n| n.id == note_id),
            "archived notes must stay in FTS — archive() must not call fts_delete"
        );
        // 아카이브 목록/카운트에 나타난다.
        let archived = archived_list(&conn, Some(ws_id.clone())).unwrap();
        assert!(archived.iter().any(|n| n.id == note_id));
        assert_eq!(archived_count(&conn, Some(ws_id.clone())).unwrap(), 1);

        // ── 아카이브 해제 ──
        assert!(unarchive(&mut conn, &note_id).unwrap());
        let list_restored = folders::list(&conn, Some(ws_id.clone())).unwrap();
        assert!(list_restored.notes_by_folder.get(&folder_id).unwrap().iter().any(|n| n.id == note_id));
        assert_eq!(archived_count(&conn, Some(ws_id.clone())).unwrap(), 0);
        let search_restored = search::search(&conn, "Archive Test", Some(900), Some(1960), Some(ws_id.clone()), None).unwrap();
        assert!(search_restored.results.iter().any(|n| n.id == note_id));
    }

    #[test]
    fn test_trash_count_zero_and_after_delete() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trash_count(&conn, Some(ws.clone())).unwrap(), 0);
        let d = create(&mut conn, &folder_id, Some("t".into()), Some(1000)).unwrap();
        delete(&mut conn, &d.note.id).unwrap();
        assert_eq!(trash_count(&conn, Some(ws)).unwrap(), 1);
    }

    // G2(docs/SYNC.md): note_purge 는 notes 자체만 직접 삭제 대상으로 tombstone 한다 — CASCADE 로
    // 함께 사라지는 sections/sources/attachments/note_tags 는 별도로 기록되지 않는다(캐스케이드
    // 규칙, repo/tombstone.rs 참조).
    #[test]
    fn test_purge_tombstones_note_only_not_cascaded_children() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = create(&mut conn, &folder_id, Some("Tombstone Note".into()), Some(1500)).unwrap();
        let note_id = detail.note.id.clone();
        set_tags(&mut conn, &note_id, vec!["archive".into()]).unwrap();

        delete(&mut conn, &note_id).unwrap();
        purge(&mut conn, data_dir, &note_id).unwrap();

        let notes_tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='notes' AND id=?1",
                [&note_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(notes_tombstoned, 1, "purge must tombstone the note itself");

        // 캐스케이드로 함께 지워진 sections/note_tags 는 별도 tombstone 이 없어야 한다(부모
        // tombstone 하나로 암시).
        let cascaded_tombstones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl IN ('sections','note_tags')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            cascaded_tombstones, 0,
            "cascaded children must not get their own tombstones"
        );
    }


    // D4 / SYNC.md §8.2: related_restore must tombstone each exclusion pair with the synthetic
    // composite id "{id_1}:{id_2}" so deletions propagate (G2).
    #[test]
    fn test_related_restore_tombstones_exclusion_pairs() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let a = create(&mut conn, &folder_id, Some("A".into()), Some(1000)).unwrap();
        let b = create(&mut conn, &folder_id, Some("B".into()), Some(1001)).unwrap();
        related_exclude(&conn, &a.note.id, &b.note.id).unwrap();
        assert_eq!(related_hidden_count(&conn, &a.note.id).unwrap(), 1);

        let n = related_restore(&mut conn, &a.note.id).unwrap();
        assert_eq!(n, 1);
        assert_eq!(related_hidden_count(&conn, &a.note.id).unwrap(), 0);

        let (min_id, max_id) = if a.note.id < b.note.id {
            (a.note.id.clone(), b.note.id.clone())
        } else {
            (b.note.id.clone(), a.note.id.clone())
        };
        let synth = format!("{min_id}:{max_id}");
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_related_exclusions' AND id=?1",
                [&synth],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1, "exclusion restore must leave a synthetic-id tombstone");
    }

    /// Dashboard Wave 1: set_event_end invariants + start≤end + clear.
    #[test]
    fn test_set_event_end_invariants_and_range() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create_today_default(
            &mut conn,
            &folder_id,
            Some("Span".into()),
            Some(1794),
            Some(1),
            Some(1),
        )
        .unwrap();
        assert_eq!(n.note.end_year, None);

        let before = n.note.updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let s = set_event_end(&mut conn, &n.note.id, Some(1796), Some(12), Some(31)).unwrap();
        assert_eq!((s.end_year, s.end_month, s.end_day), (Some(1796), Some(12), Some(31)));
        assert!(s.updated_at > before, "set_event_end must bump updated_at");

        // end_day without end_month
        let err = set_event_end(&mut conn, &n.note.id, Some(1796), None, Some(1)).unwrap_err();
        match err {
            AppError::Validation(m) => assert!(m.contains("end_day requires end_month")),
            other => panic!("expected Validation, got {other:?}"),
        }

        // end_month without end_year
        let err = set_event_end(&mut conn, &n.note.id, None, Some(6), None).unwrap_err();
        match err {
            AppError::Validation(m) => assert!(m.contains("end_month requires end_year")),
            other => panic!("expected Validation, got {other:?}"),
        }

        // start after end
        let err = set_event_end(&mut conn, &n.note.id, Some(1790), None, None).unwrap_err();
        match err {
            AppError::Validation(m) => assert!(m.contains("start must not be after")),
            other => panic!("expected Validation for reverse range, got {other:?}"),
        }

        // clear range
        let cleared = set_event_end(&mut conn, &n.note.id, None, None, None).unwrap();
        assert_eq!(
            (cleared.end_year, cleared.end_month, cleared.end_day),
            (None, None, None)
        );

        // set_event_precision must not wipe end_*, but must reject if start moves past end
        set_event_end(&mut conn, &n.note.id, Some(1796), None, None).unwrap();
        let keep = set_event_precision(&mut conn, &n.note.id, Some(6), Some(1)).unwrap();
        assert_eq!(keep.end_year, Some(1796));
        // Move start past end via year update
        let err = update(&mut conn, &n.note.id, None, Some(1800), None, None).unwrap_err();
        match err {
            AppError::Validation(m) => assert!(m.contains("start must not be after")),
            other => panic!("expected Validation when year past end, got {other:?}"),
        }
    }

    /// NoteSummary exposes end_* on tree + query paths (not just note_summary).
    #[test]
    fn test_note_query_and_folder_list_expose_end() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create_today_default(
            &mut conn,
            &folder_id,
            Some("Exposed".into()),
            Some(1500),
            None,
            None,
        )
        .unwrap();
        set_event_end(&mut conn, &n.note.id, Some(1502), Some(3), None).unwrap();

        let list = folders::list(&conn, None).unwrap();
        let found = list
            .notes_by_folder
            .values()
            .flatten()
            .find(|s| s.id == n.note.id)
            .expect("note in folder list");
        assert_eq!((found.end_year, found.end_month, found.end_day), (Some(1502), Some(3), None));

        let q = query(
            &conn,
            NoteQuery {
                workspace_id: None,
                folder_ids: None,
                year_from: None,
                year_to: None,
                updated_from: None,
                updated_to: None,
                created_from: None,
                created_to: None,
                favorites_only: false,
                include_archived: false,
                tags: vec![],
                tag_mode: TagMode::Or,
                region: RegionFilterSpec::Any,
                statuses: vec![],
                coords: CoordsFilterSpec::Any,
                query: None,
                sort: NoteQuerySort::YearAsc,
                offset: 0,
                limit: Some(50),
            },
        )
        .unwrap();
        let found = q.notes.iter().find(|s| s.id == n.note.id).expect("note in query");
        assert_eq!((found.end_year, found.end_month, found.end_day), (Some(1502), Some(3), None));
    }

    // docs/PLAN-schedule-system.md §1.3/§1.5 W5-1: set_schedule 교차 불변식 I1~I5 + 정상 저장 왕복.
    // (I6은 검증하지 않음 — 저장 항상 허용.)

    #[test]
    fn test_set_schedule_i5_rejects_invalid_rrule_via_parser_gate() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);

        // 문법 오류와 seed 규칙(UNTIL < 시작일 2026-08-10) 둘 다 같은 관문에서 거절돼야 한다.
        for bad in ["FREQ=HOURLY", "freq=DAILY", "FREQ=DAILY;UNTIL=20260801"] {
            let err = set_schedule(&mut conn, &n.id, None, None, None, Some(bad.into()));
            assert!(err.is_err(), "rrule '{bad}' must be rejected by I5");
        }
        // 거절된 저장이 DB 를 더럽히지 않았는지.
        assert_eq!(note_summary(&conn, &n.id).unwrap().rrule, None);
        // 유효한 규칙은 통과.
        set_schedule(&mut conn, &n.id, None, None, None, Some("FREQ=DAILY;UNTIL=20261231".into()))
            .unwrap();
    }

    fn day_precision_note(conn: &mut Connection, folder_id: &str) -> NoteSummary {
        create_today_default(conn, folder_id, Some("Scheduled".into()), Some(2026), Some(8), Some(10))
            .unwrap()
            .note
    }

    #[test]
    fn test_set_schedule_persists_and_round_trips() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);

        let updated = set_schedule(
            &mut conn,
            &n.id,
            Some("09:00".into()),
            Some("10:30".into()),
            Some(15),
            Some("FREQ=WEEKLY;BYDAY=MO,WE".into()),
        )
        .unwrap();
        assert_eq!(updated.start_time.as_deref(), Some("09:00"));
        assert_eq!(updated.end_time.as_deref(), Some("10:30"));
        assert_eq!(updated.remind_offset_min, Some(15));
        assert_eq!(updated.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,WE"));

        // Re-fetch from DB (not just the returned value) to prove the UPDATE actually landed.
        let refetched = note_summary(&conn, &n.id).unwrap();
        assert_eq!(refetched.start_time.as_deref(), Some("09:00"));
        assert_eq!(refetched.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,WE"));

        // Clearing (all None) must clear the row too — not just "generate no error".
        let cleared = set_schedule(&mut conn, &n.id, None, None, None, None).unwrap();
        assert_eq!(cleared.start_time, None);
        assert_eq!(cleared.end_time, None);
        assert_eq!(cleared.remind_offset_min, None);
        assert_eq!(cleared.rrule, None);
    }

    #[test]
    fn test_set_schedule_i1_requires_day_precision() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // Year-only precision (no month/day) — create() (not create_today_default, which fills
        // omitted month/day with today's) leaves month/day None when omitted.
        let n = create(&mut conn, &folder_id, Some("Year Only".into()), Some(2026))
            .unwrap()
            .note;
        let err = set_schedule(&mut conn, &n.id, Some("09:00".into()), None, None, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn test_set_schedule_i2_end_time_requires_start_time() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);
        let err = set_schedule(&mut conn, &n.id, None, Some("10:00".into()), None, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn test_set_schedule_i3_end_before_start_same_day_rejected() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);
        // No end_* triple set (single-day note) — start/end compared directly.
        let err = set_schedule(
            &mut conn,
            &n.id,
            Some("10:00".into()),
            Some("09:00".into()),
            None,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // A multi-day event (end date differs from start date) is exempt from the same-day
        // start<=end comparison (§1.3 I3) — end_time belongs to the last day, not the start day.
        set_event_end(&mut conn, &n.id, Some(2026), Some(8), Some(12)).unwrap();
        let ok = set_schedule(
            &mut conn,
            &n.id,
            Some("18:00".into()),
            Some("09:00".into()),
            None,
            None,
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn test_set_schedule_i4_rrule_requires_day_precision() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // create_with_timestamp (unlike create_today_default) leaves day None when omitted, even
        // with month given.
        let n = create_with_timestamp(&mut conn, &folder_id, Some("Month Only".into()), Some(2026), Some(8), None, None, None)
            .unwrap()
            .note;
        let err = set_schedule(&mut conn, &n.id, None, None, None, Some("FREQ=DAILY".into())).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn test_set_schedule_rejects_malformed_time_and_offset_range() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);
        // Shape passes GLOB-equivalent length but hour/minute out of range — only Rust catches this.
        let err = set_schedule(&mut conn, &n.id, Some("25:00".into()), None, None, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err = set_schedule(&mut conn, &n.id, Some("7:00".into()), None, None, None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err = set_schedule(&mut conn, &n.id, None, None, Some(40321), None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err = set_schedule(&mut conn, &n.id, None, None, Some(-1), None).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    fn sched_err(
        conn: &mut Connection,
        id: &str,
        start_time: Option<&str>,
        end_time: Option<&str>,
        remind_offset_min: Option<i64>,
        rrule: Option<&str>,
    ) -> String {
        set_schedule(
            conn,
            id,
            start_time.map(Into::into),
            end_time.map(Into::into),
            remind_offset_min,
            rrule.map(Into::into),
        )
        .unwrap_err()
        .to_string()
    }

    /// PLAN-2026-09-13-separation-of-concerns.md D4 특성화: set_schedule 검증부의 **오류 문구와
    /// 발생 순서**를 못 박는다. 위의 I1~I5 테스트들은 `matches!(err, Validation(_))` 까지만 봐서
    /// 문구가 바뀌거나 순서가 뒤집혀도 전부 통과한다 — 이 검증부를 dates::validate_schedule_fields
    /// 한 벌로 합치는 리팩터가 그 둘을 건드리지 않았음을 여기서 고정한다.
    #[test]
    fn test_set_schedule_error_messages_and_precedence_are_pinned() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // 존재 확인(note_summary)이 인자 검증보다 **먼저**다 — 인자가 엉망이어도 NOT_FOUND 가 난다.
        let missing = set_schedule(&mut conn, "no-such-note", Some("25:00".into()), None, None, None)
            .unwrap_err();
        assert_eq!(missing.code(), "NOT_FOUND");

        let day = day_precision_note(&mut conn, &folder_id); // 2026-08-10, end_* 없음
        let month_only = create_with_timestamp(
            &mut conn,
            &folder_id,
            Some("Month Only".into()),
            Some(2026),
            Some(8),
            None,
            None,
            None,
        )
        .unwrap()
        .note;

        // 시각 형식이 맨 앞. start_time 이 end_time 보다 먼저.
        let fmt = "invalid time format (HH:MM 00:00..23:59)";
        assert_eq!(sched_err(&mut conn, &day.id, Some("25:00"), None, None, None), format!("{fmt}: 25:00"));
        assert_eq!(sched_err(&mut conn, &day.id, Some("7:00"), None, None, None), format!("{fmt}: 7:00"));
        assert_eq!(sched_err(&mut conn, &day.id, Some("25:00"), Some("99:99"), None, None), format!("{fmt}: 25:00"));
        assert_eq!(sched_err(&mut conn, &day.id, Some("09:00"), Some("99:99"), None, None), format!("{fmt}: 99:99"));

        // remind_offset_min 범위는 시각 형식 **뒤**, I1~I5 **앞**.
        let range = "remind_offset_min out of range (0..40320)";
        assert_eq!(sched_err(&mut conn, &day.id, None, None, Some(-1), None), format!("{range}: -1"));
        assert_eq!(sched_err(&mut conn, &day.id, None, None, Some(40321), None), format!("{range}: 40321"));
        assert_eq!(sched_err(&mut conn, &day.id, Some("99:99"), None, Some(-1), None), format!("{fmt}: 99:99"));
        assert_eq!(sched_err(&mut conn, &day.id, None, Some("10:00"), Some(-1), None), format!("{range}: -1"));

        // I1 → I2 → I3 → I4 → I5 순.
        assert_eq!(
            sched_err(&mut conn, &month_only.id, Some("09:00"), Some("08:00"), None, None),
            "time requires day precision"
        );
        assert_eq!(
            sched_err(&mut conn, &month_only.id, Some("09:00"), None, None, Some("FREQ=DAILY")),
            "time requires day precision"
        );
        assert_eq!(
            sched_err(&mut conn, &day.id, None, Some("10:00"), None, None),
            "end_time requires start_time"
        );
        assert_eq!(
            sched_err(&mut conn, &day.id, None, Some("10:00"), None, Some("FREQ=HOURLY")),
            "end_time requires start_time"
        );
        assert_eq!(
            sched_err(&mut conn, &day.id, Some("10:00"), Some("09:00"), None, None),
            "end_time must not be before start_time"
        );
        assert_eq!(
            sched_err(&mut conn, &day.id, Some("10:00"), Some("09:00"), None, Some("FREQ=HOURLY")),
            "end_time must not be before start_time"
        );
        assert_eq!(
            sched_err(&mut conn, &month_only.id, None, None, None, Some("FREQ=DAILY")),
            "rrule requires day precision"
        );
        // I5 는 마지막 — 파서(parse_for_seed) 문구가 그대로 올라온다.
        assert_eq!(
            sched_err(&mut conn, &day.id, None, None, None, Some("FREQ=HOURLY")),
            "rrule: unsupported FREQ 'HOURLY'"
        );

        // 전부 유효하면 통과.
        let ok = set_schedule(
            &mut conn,
            &day.id,
            Some("09:00".into()),
            Some("10:00".into()),
            Some(40320),
            Some("FREQ=DAILY".into()),
        )
        .unwrap();
        assert_eq!(ok.start_time.as_deref(), Some("09:00"));
    }

    /// D4 함정 고정: set_schedule 은 **기간(날짜) 삼중을 재검증하지 않는다**. 이미 저장된 행이
    /// 역전(start > end) 상태여도 시각만 바꾸는 호출은 통과해야 한다 — 여기에 날짜 검증까지
    /// 끌어들이면 "손상된 기존 데이터에서만 나는 새 오류"가 생긴다(= 동작 변경).
    #[test]
    fn test_set_schedule_does_not_revalidate_stored_date_triple() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id); // 2026-08-10
        // set_event_end 를 우회해 역전 상태를 직접 심는다(정상 경로로는 만들 수 없는 손상 데이터).
        conn.execute(
            "UPDATE note_dates SET end_year=2020, end_month=1, end_day=1 WHERE note_id=?1 AND position=0",
            [&n.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET end_year=2020, end_month=1, end_day=1 WHERE id=?1",
            [&n.id],
        )
        .unwrap();

        let updated = set_schedule(&mut conn, &n.id, Some("09:00".into()), Some("10:00".into()), Some(5), None)
            .unwrap();
        assert_eq!(updated.start_time.as_deref(), Some("09:00"));
        assert_eq!(updated.end_time.as_deref(), Some("10:00"));
    }

    // docs/PLAN-schedule-system.md §1.3 함정: precision/end 하향 시 연쇄 클리어.

    #[test]
    fn test_set_event_precision_below_day_clears_start_time_and_rrule() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);
        set_schedule(
            &mut conn,
            &n.id,
            Some("09:00".into()),
            Some("10:00".into()),
            Some(10),
            Some("FREQ=DAILY".into()),
        )
        .unwrap();

        // Dropping day precision (day=None) must clear start_time/end_time/rrule in the same UPDATE.
        let updated = set_event_precision(&mut conn, &n.id, Some(8), None).unwrap();
        assert_eq!(updated.start_time, None);
        assert_eq!(updated.end_time, None);
        assert_eq!(updated.rrule, None);
        // remind_offset_min is left alone (I6: storage always allowed, no-op without a time).
        assert_eq!(updated.remind_offset_min, Some(10));

        let refetched = note_summary(&conn, &n.id).unwrap();
        assert_eq!(refetched.start_time, None);
        assert_eq!(refetched.end_time, None);
        assert_eq!(refetched.rrule, None);
    }

    #[test]
    fn test_set_event_end_cleared_clears_end_time() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = day_precision_note(&mut conn, &folder_id);
        set_event_end(&mut conn, &n.id, Some(2026), Some(8), Some(12)).unwrap();
        set_schedule(
            &mut conn,
            &n.id,
            Some("18:00".into()),
            Some("09:00".into()),
            None,
            None,
        )
        .unwrap();

        // Clearing the end_* triple must clear end_time too (I2 would otherwise dangle).
        let updated = set_event_end(&mut conn, &n.id, None, None, None).unwrap();
        assert_eq!((updated.end_year, updated.end_month, updated.end_day), (None, None, None));
        assert_eq!(updated.end_time, None);
        assert_eq!(updated.start_time.as_deref(), Some("18:00"));
    }

    // ── note_get_many(배치 note_get) — 대시보드 달력 날짜 패널의 N+1 대체 ──────────────────────
    // 필터 하나(`note_get_many_`)로 넷을 함께 돌린다.

    fn three_notes(conn: &mut Connection) -> Vec<String> {
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        ["A", "B", "C"]
            .iter()
            .map(|t| create(conn, &folder_id, Some((*t).into()), Some(2026)).unwrap().note.id)
            .collect()
    }

    #[test]
    fn note_get_many_preserves_input_order_and_matches_note_get() {
        let mut conn = setup_db();
        let ids = three_notes(&mut conn);
        // 생성 순서와 다른 순서 + 중복 — 결과는 입력 순서, 중복은 첫 자리에 한 번만.
        let asked = vec![ids[2].clone(), ids[0].clone(), ids[2].clone(), ids[1].clone()];
        let got = note_details_for_ids(&conn, &asked).unwrap();
        let got_ids: Vec<&str> = got.iter().map(|d| d.note.id.as_str()).collect();
        assert_eq!(got_ids, vec![ids[2].as_str(), ids[0].as_str(), ids[1].as_str()]);
        // 단수형 note_get 과 같은 조립 — 섹션 본문까지 그대로.
        for d in &got {
            assert_eq!(d, &note_detail(&conn, &d.note.id).unwrap());
        }
        assert!(!got[0].sections.is_empty(), "기본 섹션이 실려 와야 한다");
    }

    #[test]
    fn note_get_many_omits_missing_ids() {
        let mut conn = setup_db();
        let ids = three_notes(&mut conn);
        let asked = vec!["no-such-note".to_string(), ids[1].clone(), "gone-too".to_string()];
        let got = note_details_for_ids(&conn, &asked).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].note.id, ids[1]);
        // 빈 ids → 빈 배열(에러 아님).
        assert!(note_details_for_ids(&conn, &[]).unwrap().is_empty());
    }

    #[test]
    fn note_get_many_omits_trashed_notes() {
        let mut conn = setup_db();
        let ids = three_notes(&mut conn);
        assert!(delete(&mut conn, &ids[0]).unwrap());
        // 아카이브는 단수형 note_get 처럼 거르지 않는다 — 휴지통만 빠진다.
        archive(&mut conn, &ids[2]).unwrap();
        let got = note_details_for_ids(&conn, &ids).unwrap();
        let got_ids: Vec<&str> = got.iter().map(|d| d.note.id.as_str()).collect();
        assert_eq!(got_ids, vec![ids[1].as_str(), ids[2].as_str()]);
        // 단수형은 여전히 휴지통 노트를 돌려준다(휴지통 화면) — 배치만 다르다.
        assert!(note_detail(&conn, &ids[0]).is_ok());
    }

    #[test]
    fn note_get_many_rejects_over_cap_with_validation() {
        let mut conn = setup_db();
        let ids = three_notes(&mut conn);
        let at_cap: Vec<String> = (0..NOTE_GET_MANY_MAX).map(|i| ids[i % 3].clone()).collect();
        assert_eq!(note_details_for_ids(&conn, &at_cap).unwrap().len(), 3, "상한 그대로는 통과");
        let over: Vec<String> = (0..=NOTE_GET_MANY_MAX).map(|i| format!("id-{i}")).collect();
        match note_details_for_ids(&conn, &over) {
            Err(AppError::Validation(_)) => {}
            other => panic!("expected VALIDATION, got {other:?}"),
        }
    }
}

pub use crate::repo::note_query::*;
pub use crate::repo::note_tags::*;
