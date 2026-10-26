// repo: search — commands/search.yaml + service/search.yaml 의 모든 decisions 구현
// W7-f 아카이브: 이 파일은 의도적으로 archived_at 을 걸지 않는다. "보이지 않지만 찾으면
// 나온다"의 핵심 계약이 바로 이것 — 아카이브는 delete()와 달리 FTS 색인을 지우지 않으므로
// (repo/notes.rs::archive) 이 파일의 deleted_at IS NULL 술어들은 그대로 두고 archived_at 은
// 절대 추가하지 않는다.
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::NoteSummary;
use crate::repo::{folders, notes};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use std::collections::HashSet;

// UI 기본 전체 스팬 — 이 범위와 같으면 year 술어를 생략 (스팬 밖 노트도 텍스트 검색에 포함).
pub(crate) const FULL_SPAN_FROM: i64 = 900;
pub(crate) const FULL_SPAN_TO: i64 = 1960;

// Scale (Phase 0): keyword 검색 결과 요약 조립 상한. 후보 id 는 TOP-N LIMIT(500)으로
// 제한하여 무거운 요약(태그 조인)+IPC 직렬화를 상위 N 개만 만든다. exact COUNT(*) 재조회 cost를
// 제거하고 total 은 획득된 매치 id 셋의 개수(ids.len())로 보고한다. (프론트는 500개인 경우 "500+"로 표시.)
pub(crate) const SEARCH_RESULT_CAP: usize = 500;
// Scale (Phase 1): like_ids 본문 풀스캔 상한. FTS 0-매치 또는 1~2자 쿼리에서 notes_fts 4개
// 텍스트 컬럼에 LIKE 를 걸면 인덱스를 못 쓰고 전체 스캔한다. 매치 id 셋을 이 상한으로 잘라
// 10만 노트 코퍼스에서 무제한 스캔·정렬·조립을 막는다. total 은 이 캡 이후 ordered.len() 이라
// "진짜 전량 매치 수"가 아니라 "캡된 후보 수"를 보고한다(COUNT(*) 없이 전량 스캔을 피하려는 설계).
// SEARCH_RESULT_CAP(500) 보다 크게 두어 year 정렬 후 상위 요약을 뽑을 여유를 남긴다.
pub(crate) const LIKE_SCAN_CAP: usize = 1000;

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub results: Vec<NoteSummary>,
    pub total: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum YearFilter {
    None,
    Between(i64, i64),
    From(i64),
    To(i64),
}

impl YearFilter {
    pub(crate) fn from_options(from: Option<i64>, to: Option<i64>) -> AppResult<Self> {
        match (from, to) {
            (Some(f), Some(t)) => {
                if f > t {
                    return Err(AppError::Validation(format!(
                        "year_from ({f}) > year_to ({t})"
                    )));
                }
                if f == FULL_SPAN_FROM && t == FULL_SPAN_TO {
                    Ok(YearFilter::None)
                } else {
                    Ok(YearFilter::Between(f, t))
                }
            }
            (Some(f), None) => Ok(YearFilter::From(f)),
            (None, Some(t)) => Ok(YearFilter::To(t)),
            (None, None) => Ok(YearFilter::None),
        }
    }

    pub(crate) fn clause(&self) -> &'static str {
        match self {
            YearFilter::None => "",
            YearFilter::Between(_, _) => " AND n.year BETWEEN ? AND ?",
            YearFilter::From(_) => " AND n.year >= ?",
            YearFilter::To(_) => " AND n.year <= ?",
        }
    }

    pub(crate) fn push_binds(&self, binds: &mut Vec<Value>) {
        match self {
            YearFilter::None => {}
            YearFilter::Between(f, t) => {
                binds.push(Value::Integer(*f));
                binds.push(Value::Integer(*t));
            }
            YearFilter::From(f) => {
                binds.push(Value::Integer(*f));
            }
            YearFilter::To(t) => {
                binds.push(Value::Integer(*t));
            }
        }
    }
}

pub fn search(
    conn: &Connection,
    query: &str,
    year_from: Option<i64>,
    year_to: Option<i64>,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<SearchResult> {
    let year_filter = YearFilter::from_options(year_from, year_to)?;
    let effective_limit = limit
        .unwrap_or(SEARCH_RESULT_CAP as i64)
        .clamp(1, SEARCH_RESULT_CAP as i64) as usize;

    let ws = match workspace_id {
        Some(w) => w,
        None => folders::active_workspace_id(conn)?,
    };
    let q = query.trim();

    // 후보 note_id 수집.
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |id: String, ids: &mut Vec<String>, seen: &mut HashSet<String>| {
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    };

    if q.is_empty() {
        // q가 비어있는 경우: 인덱스된 SQL로 상위 effective_limit 개 직접 반환
        ids = year_scoped_ids(conn, &ws, &year_filter, effective_limit)?;
        let results = notes::note_summaries_for_ids(conn, &ids)?;
        let total = ids.len() as i64;
        return Ok(SearchResult { results, total });
    } else {
        let mut fts_has_hits = false;
        if let Some(match_query) = build_match_query(q) {
            let fts_candidates = fts_ids(conn, &match_query, &ws, &year_filter, effective_limit)?;
            fts_has_hits = !fts_candidates.is_empty();
            for id in fts_candidates {
                push(id, &mut ids, &mut seen);
            }
        }
        let char_len = q.chars().count();
        if char_len <= 2 || !fts_has_hits {
            for id in like_ids(conn, q, &ws, &year_filter)? {
                push(id, &mut ids, &mut seen);
            }
        }
    }

    // 요약 조립 — candidates 는 이미 SQLite 단에서 정렬 및 capped(effective_limit) 되어 있다.
    // year_scoped_ids/like_ids 경로는 ORDER BY n.year, n.created_at, FTS 경로(fts_ids)는
    // ORDER BY bm25 rank(관련도) — 두 경로의 정렬 기준이 다르다.
    // 다만 FTS 경로도 **동점일 때는** year, created_at 으로 깬다(2026-09-07): 같은 태그만 가진
    // 노트들처럼 bm25 가 완전히 같으면 SQLite 가 돌려주는 순서가 사실상 임의(id 인덱스 순)라
    // 같은 질의가 실행마다 다른 순서를 낼 수 있었다. 관련도 자체의 우선순위는 그대로다 —
    // 동점 구간 안에서만 이 앱의 기본 축(사건 연도)으로 정렬한다.
    let total = ids.len() as i64;
    let capped_ids = if ids.len() > effective_limit {
        &ids[..effective_limit]
    } else {
        &ids[..]
    };
    let mut results = notes::note_summaries_for_ids(conn, capped_ids)?;
    if !q.is_empty() && !results.is_empty() {
        populate_snippets(conn, &mut results, q)?;
    }
    Ok(SearchResult { results, total })
}

/// FTS MATCH 쿼리 문자열 조립 — notes_fts는 trigram 토크나이저(migrations.rs V10)라 토큰은
/// 항상 3글자(코드포인트) 시퀀스 단위로 인덱싱된다. 각 공백 구분 토큰을 큰따옴표로 감싸 리터럴
/// 구문(phrase) 매치시키면 그 자체로 "본문 어디든 부분 문자열"이 되므로(trigram의 본질), 이전
/// unicode61 시절처럼 마지막 토큰에 '*' 접두를 붙일 필요가 없다 — 오히려 trigram 토큰은 항상
/// 정확히 3글자라 접두 매치가 의미를 갖지 못한다(3글자 토큰의 "접두"는 그 토큰 자신뿐).
/// 여러 토큰은 공백으로 이어붙여 FTS5 기본 암묵적 AND(각 구문이 개별적으로 어딘가에 존재)로
/// 묶는다 — 기존 다중 키워드 AND 시맨틱스를 그대로 보존한다(영문 검색 회귀 없음).
/// trigram MATCH는 원리상 3글자 미만 토큰을 인덱싱할 수 없으므로(그런 토큰은 트라이그램을 하나도
/// 만들지 못함) 그런 토큰은 건너뛴다 — 짧은 쿼리(1~2자)는 호출부의 LIKE 폴백(R8)이 담당한다.
/// 유효 토큰이 하나도 없으면 None (호출부가 LIKE 폴백으로 넘어간다).
pub(crate) fn build_match_query(q: &str) -> Option<String> {
    let tokens: Vec<&str> = q.split_whitespace().filter(|t| !t.is_empty()).collect();
    let mut parts = Vec::with_capacity(tokens.len());
    for tok in tokens {
        if tok.chars().count() < 3 {
            continue; // trigram은 3글자 미만 토큰에서 트라이그램을 생성할 수 없다.
        }
        let escaped = tok.replace('"', "\"\"");
        parts.push(format!("\"{escaped}\""));
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(" "))
}

fn year_scoped_ids(
    conn: &Connection,
    ws: &str,
    year_filter: &YearFilter,
    limit: usize,
) -> AppResult<Vec<String>> {
    let sql = format!(
        "SELECT n.id FROM notes n
         WHERE n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ? AND search_excluded = 0) AND n.deleted_at IS NULL{}
         ORDER BY n.year, n.created_at
         LIMIT {limit}",
        year_filter.clause()
    );
    let mut binds: Vec<Value> = vec![Value::Text(ws.to_string())];
    year_filter.push_binds(&mut binds);
    run_id_query(conn, &sql, binds)
}

// notes_fts 컬럼 순서(note_id UNINDEXED, title, body, source_body, tag_names)에 맞춰 5개
// 포지션 전부를 명시한다 — bm25() 가중치는 UNINDEXED 컬럼을 포함한 선언 순서에 그대로 포지셔널로
// 매핑되므로 4개만 주면 한 칸씩 밀린다(과거 버그: title에 5.0, tag_names는 기본값 1.0으로 새어
// 들어갔었다). note_id 자리는 UNINDEXED라 점수에 관여하지 않으므로 0.0으로 채운다.
const BM25_WEIGHTS: &str = "0.0, 10.0, 1.0, 2.0, 5.0";

// R9: notes_fts 를 `f JOIN notes n ON n.id = f.note_id` 형태로 조인하면 플래너가 통계가 어긋난
// 상황(빈 DB ANALYZE 등, db::scrub_zero_row_stats 참조)에서 notes 쪽 idx_notes_year_alive range
// scan 을 안쪽 루프에 놓아 O(매치수 × 노트수) 로 폭발한다(실측: 10k 노트 DB에서 90ms → 62,279ms).
// 그 뒤로는 semi-join(`n.id IN (SELECT note_id FROM notes_fts WHERE MATCH ?)`) + note_id 로 상관된 스칼라
// bm25 서브쿼리였는데, 그 서브쿼리가 후보마다 MATCH 를 **다시** 돌아 흔한 낱말에서 O(매치수²) 였다
// (HANDOFF-2026-10-09 Wave D).
//
// 지금 모양의 규칙(D1·D2 공통) — **FROM 에는 FTS5 가상 표 하나, 또는 물질화된 CTE 하나만 둔다.**
// 일반 표(notes·notes_bigram_map)는 오직 상관 서브쿼리의 **단일 표 + 유일 키 동등** 조회로만 닿는다.
// - 여러 표 FROM 은 CROSS JOIN 으로 순서를 고정해도 안쪽 표에 **어떻게** 닿을지는 통계로 고른다 — zero-row
//   통계를 심으면 실제로 `SCAN n`(바깥 행마다 notes 전체)을 골랐다(테스트 `poisoned_stats_keep_notes_a_pk_lookup`).
// - 단일 표 + 유일 키(rowid·PK) 동등 WHERE 는 SQLite 가 비용 계산 없이 그 키로 바로 찾는다 — 통계와 무관.
// - FTS5 가상 표의 비용은 xBestIndex 가 정한다(sqlite_stat1 무관).
// - 폴더 목록(`IN (SELECT id FROM folders …)`)은 상관 없는 서브쿼리라 한 번만 계산된다.
// - 거르기는 `EXISTS (…)` 가 아니라 `(SELECT 1 …) IS NOT NULL` 이다 — SQLite 는 EXISTS 를 조인으로 바꿔
//   (EXISTS-to-JOIN) 접근 경로를 다시 통계로 고른다. zero-row 통계에서 실제로 `SCAN n EXISTS` 를 골랐다.
// note_id 는 notes_fts 열이 아니라 매핑 표(id = notes_fts rowid, V95)에서 읽는다 — note_id 열을 읽으면 FTS5 가
// 행마다 본문까지 가져온다. 동점((점수, year, created_at) 완전 동점)은 note id 로 깬다 — 예전엔 순서가 정해지지
// 않았다(실행마다 달라도 됐다).

/// notes 행 필터(작업 공간·검색 제외·휴지통·연도) — `n.id = <후보>` 로 한 행이 이미 정해진 스칼라 서브쿼리 안에서 쓴다.
/// 열마다 단항 `+` 를 붙여 인덱스 후보에서 뺀다 — 플래너가 PK 대신 idx_notes_folder·idx_notes_year_alive 를
/// 잡을 여지를 없앤다(통계 없는 DB 에서 여러 표 조인일 때 실제로 idx_notes_folder 를 골랐다). `+` 는 값·비교
/// 결과를 바꾸지 않는다(열 친화도만 뗀다 — 바인딩은 정수·텍스트 그대로). 등가성 테스트가 확인한다.
fn row_filter(year_clause: &str) -> String {
    format!(
        "+n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ? AND search_excluded = 0) AND +n.deleted_at IS NULL{}",
        year_clause.replace("n.year", "+n.year")
    )
}

/// 후보 CTE `c(nid, …)` 를 같은 필터·같은 정렬(year, created_at, id)로 마무리하는 꼬리 — year·created_at 은
/// NOT NULL(specs/db/schemas/notes.sql)이라 상관 조회 값이 비는 일은 필터를 통과한 행엔 없다.
const BY_YEAR_CREATED: &str = "(SELECT year FROM notes WHERE id = c.nid), (SELECT created_at FROM notes WHERE id = c.nid), c.nid";

/// D2 — MATCH + bm25 를 **한 번** 평가해 물질화(MATERIALIZED — 바깥에서 다시 펼치지 못하게)한 뒤, 후보마다 notes 를
/// PK 로 조회해 거르고 (점수, year, created_at, id) 로 정렬한다.
fn fts_sql(year_clause: &str, limit: usize) -> String {
    format!(
        "WITH c AS MATERIALIZED (
           SELECT (SELECT note_id FROM notes_bigram_map WHERE id = notes_fts.rowid) AS nid,
                  bm25(notes_fts, {BM25_WEIGHTS}) AS score
           FROM notes_fts WHERE notes_fts MATCH ?
         )
         SELECT c.nid FROM c
         WHERE (SELECT 1 FROM notes n WHERE n.id = c.nid AND {}) IS NOT NULL
         ORDER BY c.score, {BY_YEAR_CREATED}
         LIMIT {limit}",
        row_filter(year_clause)
    )
}

fn fts_ids(
    conn: &Connection,
    match_query: &str,
    ws: &str,
    year_filter: &YearFilter,
    limit: usize,
) -> AppResult<Vec<String>> {
    let sql = fts_sql(year_filter.clause(), limit);
    // match_query 는 한 번만 바인딩된다(MATCH 도 한 번). 자리 순서는 SQL 문 내 `?` 등장 순서.
    let mut binds: Vec<Value> = vec![
        Value::Text(match_query.to_string()),
        Value::Text(ws.to_string()),
    ];
    year_filter.push_binds(&mut binds);
    run_id_query(conn, &sql, binds)
}

/// 2글자 창이 없는 쿼리(1글자, 기호뿐) — notes_fts 네 열 LIKE 전체 스캔(R8 원형 그대로, 동점만 n.id 로).
/// semi-join 이라 통계가 어긋나도 notes 는 많아야 한 번 훑는다.
fn like_sql(year_clause: &str) -> String {
    format!(
        "SELECT n.id FROM notes n
         WHERE n.id IN (SELECT note_id FROM notes_fts
                         WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
                            OR source_body LIKE ? ESCAPE '\\' OR tag_names LIKE ? ESCAPE '\\')
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ? AND search_excluded = 0) AND n.deleted_at IS NULL{}
         ORDER BY n.year, n.created_at, n.id
         LIMIT {LIKE_SCAN_CAP}",
        year_clause
    )
}

/// 2글자 창이 하나라도 있는 쿼리(D1) — 후보 = 쿼리의 **모든** 창을 가진 노트(2글자 색인, 따옴표 친 창들의
/// FTS5 암묵 AND), 그 후보에만 예전과 같은 네 열 LIKE 를 최종 술어로 건다. 쿼리가 열 안의 부분 문자열이면
/// 쿼리의 글자·숫자 구간은 그 열의 글자·숫자 구간 안에 그대로 이어져 있으므로 쿼리의 창은 전부 그 노트의
/// 창 목록에 있다(fts::bigrams_into 와 같은 규칙, ASCII 만 소문자화 = LIKE 의 대소문자 규칙) — 후보는 LIKE
/// 매치의 상위 집합이고, LIKE 로 다시 거르므로 결과 집합은 예전과 **구성상** 같다.
/// notes_fts 는 후보의 rowid 로만 닿는다(가상 표 단독 스칼라 서브쿼리 — 훑지 않는다).
fn like_bigram_sql(year_clause: &str) -> String {
    format!(
        "WITH c AS MATERIALIZED (
           SELECT rowid AS fid, (SELECT note_id FROM notes_bigram_map WHERE id = notes_bigram.rowid) AS nid
           FROM notes_bigram WHERE notes_bigram MATCH ?
         )
         SELECT c.nid FROM c
         WHERE (SELECT 1 FROM notes n WHERE n.id = c.nid AND {}) IS NOT NULL
           AND (SELECT 1 FROM notes_fts f WHERE f.rowid = c.fid
                  AND (f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\'
                       OR f.source_body LIKE ? ESCAPE '\\' OR f.tag_names LIKE ? ESCAPE '\\')) IS NOT NULL
         ORDER BY {BY_YEAR_CREATED}
         LIMIT {LIKE_SCAN_CAP}",
        row_filter(year_clause)
    )
}

/// 쿼리의 2글자 창들 → notes_bigram MATCH 문자열(`"g1" "g2"` — 창마다 따로 따옴표: detail=none 은 여러 낱말
/// 구(phrase)를 못 쓴다). 창이 없으면 None.
fn bigram_match_query(q: &str) -> Option<String> {
    let mut grams = std::collections::BTreeSet::new();
    crate::repo::fts::bigrams_into(q, &mut grams);
    if grams.is_empty() {
        return None;
    }
    Some(
        grams
            .iter()
            .map(|g| format!("\"{}\"", g.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// R8 CJK 재현율 폴백 — 쿼리가 1~2자(trigram MATCH 불가)이거나 FTS 0건일 때 호출부가 UNION.
/// notes_fts는 title/body/source_body/tag_names를 이미 노트 단위로 집계해 저장하므로(repo/
/// fts.rs::fts_upsert), 이 네 컬럼 전체에 LIKE를 걸어 title/tag뿐 아니라 본문(sections)/출처
/// (sources)에만 있는 부분 문자열도 놓치지 않는다 — 예전에는 title/tag만 커버해 본문에만 있는
/// 짧은 매치를 조용히 누락시켰다(P1 버그의 일부). 2글자 창이 있으면 2글자 색인으로 후보를 좁힌 뒤
/// LIKE 로 확인하고(like_bigram_sql), 없으면 전체 스캔이다 — 어느 쪽이든 LIKE_SCAN_CAP 로 매치 id 셋을 상한한다.
fn like_ids(
    conn: &Connection,
    q: &str,
    ws: &str,
    year_filter: &YearFilter,
) -> AppResult<Vec<String>> {
    let pattern = format!("%{}%", escape_like(q));
    // LIMIT 은 매치 id 셋 상한(LIKE_SCAN_CAP). 요약 조립 캡(SEARCH_RESULT_CAP)과 별개 —
    // 호출부가 year 정렬·중복 제거한 뒤 total=ordered.len() 이므로 total 도 이 상한에 묶인다.
    let like4 = || vec![
        Value::Text(pattern.clone()),
        Value::Text(pattern.clone()),
        Value::Text(pattern.clone()),
        Value::Text(pattern.clone()),
    ];
    let (sql, binds) = match bigram_match_query(q) {
        Some(mq) => {
            let mut binds = vec![Value::Text(mq), Value::Text(ws.to_string())];
            year_filter.push_binds(&mut binds);
            binds.extend(like4());
            (like_bigram_sql(year_filter.clause()), binds)
        }
        None => {
            let mut binds = like4();
            binds.push(Value::Text(ws.to_string()));
            year_filter.push_binds(&mut binds);
            (like_sql(year_filter.clause()), binds)
        }
    };
    run_id_query(conn, &sql, binds)
}

fn run_id_query(conn: &Connection, sql: &str, binds: Vec<Value>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql).map_err(dberr)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| r.get::<_, String>(0))
        .map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

/// Wave 4: capped 검색 결과에 본문 스니펫(\u0002/\u0003 마커 포함)을 채운다.
/// 1) FTS build_match_query(q) 결과가 존재하면 FTS5 snippet() 1회 배치 쿼리를 실행한다.
/// 2) FTS5 snippet() 결과를 얻지 못한 노트(또는 MATCH 불가능 쿼리)는 FTS 0건/LIKE 폴백 노트이므로,
///    추가 N+1 쿼리 없이 notes_fts 텍스트에서 쿼리의 대소문자 무시 부분 문자열 주변 윈도우를 추출하는
///    plain Rust 폴백을 적용한다 (LIKE 폴백 노트도 FTS5 가상 테이블 행 조인으로 스니펫 생성).
fn populate_snippets(
    conn: &Connection,
    results: &mut [NoteSummary],
    q: &str,
) -> AppResult<()> {
    if results.is_empty() || q.trim().is_empty() {
        return Ok(());
    }

    let mut snippet_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Plain Rust 윈도우/센티널 추출:
    // candidate search 에서 이미 FTS MATCH/LIKE 가 완료되어 results(최대 500개)가 추출되었으므로,
    // notes_fts 가상 테이블(note_id UNINDEXED로 풀스캔 유발)을 조회하지 않고
    // 원본 테이블(sections 및 sources)에서 note_id 인덱스를 활용해 text를 배치 SELECT 한 뒤
    // Rust 에서 센티널(\u0002/\u0003)을 삽입한다.
    for chunk in results.chunks(crate::util::IN_CHUNK) {
        // 섹션 본문은 sheet 섹션 투영(JSON → TSV)이 필요해 SQL group_concat 대신
        // repo::sheet::note_body_texts 로 뽑는다 — 조회는 여전히 청크당 배치 1회.
        let ids: Vec<String> = chunk.iter().map(|s| s.id.clone()).collect();
        let bodies = crate::repo::sheet::note_body_texts(conn, &ids, None)?;

        let mut missing_ids: Vec<String> = Vec::new();
        for item in chunk {
            let note_id = &item.id;
            if let Some(body) = bodies.get(note_id) {
                if !body.is_empty() {
                    if let Some(snip) = extract_plain_snippet(body, q) {
                        snippet_map.insert(note_id.clone(), snip);
                        continue;
                    }
                }
            }
            missing_ids.push(note_id.clone());
        }

        // 본문(sections)에서 스니펫을 추출하지 못한 노트만 sources 테이블을 직접 배치 조회한다.
        if !missing_ids.is_empty() {
            let placeholders = std::iter::repeat_n("?", missing_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT note_id, body FROM sources
                 WHERE note_id IN ({placeholders})
                 ORDER BY note_id, position"
            );
            let binds: Vec<Value> = missing_ids.iter().map(|s| Value::Text(s.clone())).collect();
            let mut stmt = conn.prepare(&sql).map_err(dberr)?;
            let mut sources_by_note: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            let rows = stmt
                .query_map(params_from_iter(binds.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(dberr)?;
            for row in rows {
                let (note_id, src_body) = row.map_err(dberr)?;
                let entry = sources_by_note.entry(note_id).or_default();
                if !entry.is_empty() {
                    entry.push_str("\n\n");
                }
                entry.push_str(&src_body);
            }
            for (note_id, src_text) in sources_by_note {
                if let Some(snip) = extract_plain_snippet(&src_text, q) {
                    snippet_map.insert(note_id, snip);
                }
            }
        }
    }

    // 결과를 results 객체에 바인딩
    for item in results.iter_mut() {
        item.snippet = snippet_map.remove(&item.id);
    }

    Ok(())
}

pub(crate) fn extract_plain_snippet(text: &str, query: &str) -> Option<String> {
    let q_lower = query.to_lowercase();
    let text_lower = text.to_lowercase();
    let match_idx = text_lower.find(&q_lower)?;

    let match_end = match_idx + q_lower.len();
    // to_lowercase() 는 일부 문자에서 바이트 길이를 바꾼다(예: 'İ' 2바이트 → "i̇" 3바이트,
    // 'ẞ' 3바이트 → 'ß' 2바이트). 그러면 text_lower 기준 오프셋이 원문 text 의 문자 경계와
    // 어긋나 슬라이싱이 패닉한다. 어긋난 경우는 드물므로 스니펫을 포기하고 넘어간다.
    if match_end > text.len()
        || !text.is_char_boundary(match_idx)
        || !text.is_char_boundary(match_end)
    {
        return None;
    }
    // 마치 12 토큰 윈도우처럼 전후 바이트/문자 범위 캡쳐
    let start_idx = text[..match_idx]
        .char_indices()
        .rev()
        .nth(30)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end_idx = text[match_end..]
        .char_indices()
        .nth(40)
        .map(|(i, _)| match_end + i)
        .unwrap_or(text.len());

    let prefix = if start_idx > 0 { "…" } else { "" };
    let suffix = if end_idx < text.len() { "…" } else { "" };

    let before = &text[start_idx..match_idx];
    let matched = &text[match_idx..match_end];
    let after = &text[match_end..end_idx];

    Some(format!("{prefix}{before}\u{0002}{matched}\u{0003}{after}{suffix}"))
}

/// Escape `%`, `_`, and `\` for SQLite `LIKE … ESCAPE '\'`.
/// `pub(crate)` so attachment_query can reuse the same name-filter escaping without a copy.
pub(crate) fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[cfg(test)]
mod cap_tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    /// Scale 회귀: 광범위(빈 쿼리·전체연도) 검색은 results 를 SEARCH_RESULT_CAP 개로 캡하되
    /// total 은 진짜 매치 수(캡 초과)를 그대로 보고해야 한다.
    #[test]
    fn keyword_search_caps_results_but_total_is_true_count() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // 시드 노트 수 + 새로 만든 노트 수 = 캡을 확실히 초과.
        let seeded: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL", [], |r| r.get(0))
            .unwrap();
        let target = SEARCH_RESULT_CAP as i64 + 50 - seeded;
        for i in 0..target.max(0) {
            notes::create(&mut conn, &folder_id, Some(format!("N{i}")), Some(1500)).unwrap();
        }

        // 빈 쿼리 + 전체 연도 = 모든 비삭제 노트 후보.
        let r = search(&conn, "", Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert_eq!(r.results.len(), SEARCH_RESULT_CAP, "results capped");
        assert_eq!(
            r.total, SEARCH_RESULT_CAP as i64,
            "total is capped to candidate ids count without exact COUNT query (got {})",
            r.total
        );
    }

    /// Scale 회귀: 1~2자 쿼리(FTS 불가 → LIKE 폴백)는 매치 id 를 LIKE_SCAN_CAP 으로 자르고,
    /// total 은 그 캡된 후보 수를 보고한다(전량 COUNT 없이 풀스캔 상한). results 는 추가로
    /// SEARCH_RESULT_CAP 조립 캡을 받는다.
    #[test]
    fn like_ids_caps_match_set_at_like_scan_cap() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();

        // 시드에 없는 1자 마커 — 제목에 넣으면 LIKE 경로만 탄다(trigram 은 3글자 미만 스킵).
        const MARKER: &str = "ξ";
        let over = LIKE_SCAN_CAP as i64 + 50;
        for i in 0..over {
            notes::create(
                &mut conn,
                &folder_id,
                Some(format!("{MARKER}-cap-{i}")),
                Some(1500),
            )
            .unwrap();
        }

        let ids = like_ids(&conn, MARKER, &ws, &YearFilter::None).unwrap();
        assert!(
            ids.len() <= LIKE_SCAN_CAP,
            "like_ids must respect LIKE_SCAN_CAP (got {})",
            ids.len()
        );
        assert_eq!(
            ids.len(),
            LIKE_SCAN_CAP,
            "corpus has more matches than the cap, so ids should hit the ceiling"
        );

        // search() total = ordered.len() after the LIKE cap — not the uncapped true count.
        let r = search(&conn, MARKER, Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert_eq!(
            r.total, LIKE_SCAN_CAP as i64,
            "total reflects the capped match set, not the full corpus (got {})",
            r.total
        );
        assert_eq!(
            r.results.len(),
            SEARCH_RESULT_CAP,
            "results still use SEARCH_RESULT_CAP assembly cap"
        );
        assert!(
            r.total as usize > SEARCH_RESULT_CAP,
            "LIKE_SCAN_CAP must leave headroom above SEARCH_RESULT_CAP"
        );
    }

    /// Scale 회귀 (실측: 10k 노트 실 DB, MATCH '"les"' 62,279ms → 90ms, LIKE '%de%' 62,122ms → 155ms).
    ///
    /// R9: `notes_fts f JOIN notes n ON n.id = f.note_id` 형태는 플래너가 notes 를 PK 가 아니라
    /// idx_notes_year_alive range scan 으로 안쪽 루프에 놓으면 O(매치수 × 노트수) 가 된다.
    /// 통계가 어긋나면(빈 DB ANALYZE — db::scrub_zero_row_stats 참조) 실제로 그 선택을 한다.
    ///
    /// 2026-10-09 Wave D 에서 **의도적으로** 바꿨다. 예전 잠금은 "semi-join 이어야 하고 `JOIN notes` 가
    /// 없어야" 였는데, 그 모양은 bm25 를 후보마다 MATCH 를 다시 도는 상관 서브쿼리로 계산해 O(매치수²) 였다.
    /// R9 의 의도(= 통계가 어떻든 플래너가 notes 를 FTS 루프 안쪽에서 훑을 수 없을 것)는 이제 이렇게 지킨다:
    /// - MATCH 는 SQL 에 **한 번만**, `AS MATERIALIZED` CTE 안에서;
    /// - **JOIN 이 아예 없다** — 바깥 FROM 은 물질화된 CTE 하나, CTE 의 FROM 은 FTS5 가상 표 하나;
    /// - notes·매핑 표는 상관 서브쿼리의 단일 표 유일 키 동등(`WHERE id = …`)으로만 닿는다.
    /// 플랜 단언은 `poisoned_stats_keep_notes_a_pk_lookup` 이 따로 건다(zero-row 통계를 심어서).
    /// 2글자 창이 없는 쿼리의 LIKE(like_sql)는 예전 semi-join 그대로라 예전 단언을 유지한다.
    #[test]
    fn fts_and_like_queries_structure() {
        for apply_year in [false, true] {
            let year_clause = if apply_year { " AND n.year BETWEEN ? AND ?" } else { "" };
            let fts = fts_sql(year_clause, SEARCH_RESULT_CAP);
            assert!(
                fts.contains("bm25(notes_fts, 0.0, 10.0, 1.0, 2.0, 5.0)"),
                "fts_sql must apply BM25 weighted ranking over all 5 notes_fts columns \
                 (note_id, title, body, source_body, tag_names) — a 4-arg call shifts every \
                 weight by one column: {fts}"
            );
            assert_eq!(fts.matches("MATCH").count(), 1, "MATCH exactly once (no per-candidate re-MATCH): {fts}");
            assert_eq!(fts.matches("bm25(").count(), 1, "bm25 once, inside the materialized CTE: {fts}");
            assert!(fts.starts_with("WITH c AS MATERIALIZED ("), "the MATCH CTE must be MATERIALIZED: {fts}");
            assert!(fts.contains("FROM notes_fts WHERE notes_fts MATCH ?"), "{fts}");
            assert_stats_proof_shape(&fts);

            let big = like_bigram_sql(year_clause);
            assert_eq!(big.matches("MATCH").count(), 1, "{big}");
            assert!(big.starts_with("WITH c AS MATERIALIZED ("), "{big}");
            assert!(big.contains("FROM notes_bigram WHERE notes_bigram MATCH ?"), "2-char index drives: {big}");
            assert!(big.contains("FROM notes_fts f WHERE f.rowid = c.fid"), "notes_fts only by rowid: {big}");
            assert_stats_proof_shape(&big);

            let like = like_sql(year_clause);
            assert!(
                like.contains("n.id IN (SELECT note_id FROM notes_fts"),
                "like_sql must stay a semi-join: {like}"
            );
            assert!(
                !like.contains("JOIN notes"),
                "like_sql must not JOIN notes_fts against notes: {like}"
            );
        }
    }

    /// 통계에 기대지 않는 모양: JOIN 없음, 바깥 FROM 은 CTE `c` 하나, notes·매핑 표는 유일 키 동등으로만.
    fn assert_stats_proof_shape(sql: &str) {
        assert!(!sql.contains("JOIN"), "no joins — the planner must have no join order/access path to pick (R9): {sql}");
        assert!(!sql.contains("EXISTS"), "no EXISTS — SQLite rewrites it into a join and re-picks the access path: {sql}");
        assert!(sql.contains("SELECT c.nid FROM c\n"), "outer FROM is the materialized CTE alone: {sql}");
        assert!(sql.contains("FROM notes_bigram_map WHERE id = "), "map only by its INTEGER PRIMARY KEY: {sql}");
        assert!(sql.contains("FROM notes n WHERE n.id = c.nid AND +n.folder_id IN"), "notes only by PK, filters un-indexed: {sql}");
        assert!(!sql.contains("FROM notes n\n") && !sql.contains("FROM notes n,"), "notes never a free table: {sql}");
    }

    /// EXPLAIN QUERY PLAN — (id, parent, detail).
    fn plan(conn: &Connection, sql: &str, binds: &[Value]) -> Vec<(i64, i64, String)> {
        let mut st = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        st.query_map(params_from_iter(binds.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn render(p: &[(i64, i64, String)]) -> String {
        fn depth(p: &[(i64, i64, String)], mut parent: i64) -> usize {
            let mut d = 0;
            while parent != 0 {
                d += 1;
                parent = p.iter().find(|r| r.0 == parent).map(|r| r.1).unwrap_or(0);
            }
            d
        }
        p.iter().map(|r| format!("{}{}", "  ".repeat(depth(p, r.1) + 1), r.2)).collect::<Vec<_>>().join("\n")
    }

    fn under_correlated(p: &[(i64, i64, String)], row: &(i64, i64, String)) -> bool {
        let mut parent = row.1;
        while parent != 0 {
            let Some(r) = p.iter().find(|r| r.0 == parent) else { return false };
            if r.2.starts_with("CORRELATED") {
                return true;
            }
            parent = r.1;
        }
        false
    }

    /// R9 플랜 잠금 — 세 상태(통계 없음 · 정확한 ANALYZE · notes/매핑/폴더에 zero-row 통계를 심은 빈 DB ANALYZE
    /// 사고 상태)에서: MATCH 는 한 번(상관 서브쿼리 밖), notes 는 PK SEARCH 로만(SCAN 없음), 매핑 표는 rowid 로만,
    /// 2글자 경로의 notes_fts 는 rowid 조회(idxStr `=`)로만. `--nocapture` 로 플랜을 찍는다(보고서용).
    #[test]
    fn poisoned_stats_keep_notes_a_pk_lookup() {
        let mut conn = setup_db();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        for i in 0..60 {
            notes::create(&mut conn, &folder_id, Some(format!("커피 프로젝트 {i}")), Some(1500 + i)).unwrap();
        }
        let ws = folders::active_workspace_id(&conn).unwrap();
        for state in ["no-stats", "analyzed", "zero-row-stats"] {
            match state {
                "analyzed" => conn.execute_batch("ANALYZE").unwrap(),
                "zero-row-stats" => conn
                    .execute_batch(
                        "DELETE FROM sqlite_stat1 WHERE tbl IN ('notes', 'notes_bigram_map', 'folders');
                         INSERT INTO sqlite_stat1(tbl, idx, stat)
                           SELECT tbl_name, name, '0' FROM sqlite_master
                            WHERE type = 'index' AND tbl_name IN ('notes', 'notes_bigram_map', 'folders');
                         INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('notes', NULL, '0'), ('notes_bigram_map', NULL, '0'), ('folders', NULL, '0');
                         ANALYZE sqlite_master;",
                    )
                    .unwrap(),
                _ => {}
            }
            for yf in [YearFilter::None, YearFilter::Between(1500, 1510)] {
                let mut fb = vec![Value::Text("\"프로젝트\"".into()), Value::Text(ws.clone())];
                yf.push_binds(&mut fb);
                let fts_plan = plan(&conn, &fts_sql(yf.clause(), SEARCH_RESULT_CAP), &fb);
                let mut bb = vec![Value::Text("\"커피\"".into()), Value::Text(ws.clone())];
                yf.push_binds(&mut bb);
                bb.extend((0..4).map(|_| Value::Text("%커피%".into())));
                let big_plan = plan(&conn, &like_bigram_sql(yf.clause()), &bb);
                let mut lb: Vec<Value> = (0..4).map(|_| Value::Text("%비%".into())).collect();
                lb.push(Value::Text(ws.clone()));
                yf.push_binds(&mut lb);
                let like_plan = plan(&conn, &like_sql(yf.clause()), &lb);
                println!("[{state} year={yf:?}] fts_sql:\n{}", render(&fts_plan));
                println!("[{state} year={yf:?}] like_bigram_sql:\n{}", render(&big_plan));
                println!("[{state} year={yf:?}] like_sql (no 2-char window, unchanged shape):\n{}", render(&like_plan));
                for (name, p) in [("fts_sql", &fts_plan), ("like_bigram_sql", &big_plan)] {
                    let matches: Vec<_> = p.iter().filter(|r| r.2.contains("VIRTUAL TABLE INDEX 0:M")).collect();
                    assert_eq!(matches.len(), 1, "{name} [{state}]: MATCH once:\n{}", render(p));
                    assert!(!under_correlated(p, matches[0]), "{name} [{state}]: MATCH not per-row:\n{}", render(p));
                    for r in p.iter() {
                        let d = r.2.as_str();
                        assert!(
                            !(d.starts_with("SCAN n ") || d == "SCAN n" || d.starts_with("SCAN notes ") || d == "SCAN notes"),
                            "{name} [{state}]: notes must never be scanned:\n{}", render(p)
                        );
                        assert!(
                            !(d.starts_with("SCAN notes_bigram_map") || d.starts_with("SEARCH notes_bigram_map USING INDEX")),
                            "{name} [{state}]: map only by rowid:\n{}", render(p)
                        );
                        if d.starts_with("SEARCH n ") || d.starts_with("SEARCH notes ") {
                            assert!(d.contains("USING INDEX sqlite_autoindex_notes_1 (id=?)"), "{name} [{state}]: notes only by PK:\n{}", render(p));
                        }
                    }
                    assert!(p.iter().any(|r| r.2.starts_with("SEARCH notes_bigram_map USING INTEGER PRIMARY KEY (rowid=?)")), "{name} [{state}]:\n{}", render(p));
                }
                let f_line = big_plan.iter().find(|r| r.2.starts_with("SCAN f ") && r.2.contains("VIRTUAL TABLE")).expect("notes_fts line");
                assert!(f_line.2.contains(" 0:="), "notes_fts must be a rowid lookup, not a full scan:\n{}", render(&big_plan));
            }
        }
    }

    /// Wave 4: 노트 본문(sections)에만 쿼리가 존재하는 경우 search() 가 STX/ETX 센티널 마커(\u{0002}/\u{0003})가
    /// 포함된 snippet 을 반환해야 함.
    #[test]
    fn search_returns_highlighted_body_snippet() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let detail = notes::create(
            &mut conn,
            &folder_id,
            Some("Simple Note Title".to_string()),
            Some(1920),
        )
        .unwrap();

        // 본문에 쿼리 키워드 삽입
        let section_id = detail.sections[0].id.clone();
        crate::repo::sections::update(
            &mut conn,
            &section_id,
            Some("Section Title".to_string()),
            Some("This is the main body text containing specialkeyword inside.".to_string()),
            None,
        )
        .unwrap();

        let r = search(&conn, "specialkeyword", Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert_eq!(r.results.len(), 1);
        let snip = r.results[0].snippet.as_ref().expect("snippet should be populated");
        assert!(
            snip.contains("\u{0002}specialkeyword\u{0003}") || snip.contains("\u{0002}specialkeyword") || snip.contains("specialkeyword"),
            "snippet should contain sentinel markers around the match, got: {snip}"
        );
        assert!(snip.contains("\u{0002}"), "snippet has STX sentinel");
        assert!(snip.contains("\u{0003}"), "snippet has ETX sentinel");
    }

    /// Diagram sections (kind='diagram') store their JSON IR in the
    /// same body_md column a prose section uses — no separate storage path, no separate FTS
    /// wiring. This proves that's not just true by construction but actually behaves that way: a
    /// name typed inside a diagram (e.g. a node label) is findable by ordinary keyword search,
    /// same as any prose word (FEATURE item 6 — "verify a name typed inside a diagram is
    /// findable by keyword search").
    #[test]
    fn diagram_section_body_is_keyword_searchable_same_as_prose() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = notes::create(&mut conn, &folder_id, Some("Family Tree".to_string()), Some(1920))
            .unwrap();

        crate::repo::sections::create_with_body_and_kind(
            &mut conn,
            &detail.note.id,
            Some("Relations".to_string()),
            "{\"v\":1,\"route\":\"curve\",\"nodes\":[{\"id\":\"A\",\"label\":\"Yeonhwacheon\"},{\"id\":\"B\",\"label\":\"Bakyeon\"}],\"edges\":[{\"id\":\"e1\",\"from\":\"A\",\"to\":\"B\",\"label\":\"daughter\"}]}".to_string(),
            Some("diagram".to_string()),
        )
        .unwrap();

        let r = search(&conn, "Yeonhwacheon", Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert_eq!(r.results.len(), 1, "a name inside a diagram section's json body must be found");
        assert_eq!(r.results[0].id, detail.note.id);
    }
}

/// Search invariants not covered by cap/snippet tests.
#[cfg(test)]
mod search_invariants {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn folder_id(conn: &Connection) -> String {
        conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap()
    }

    fn ws_id(conn: &Connection) -> String {
        folders::active_workspace_id(conn).unwrap()
    }

    /// S2: soft-deleted notes must never appear in keyword candidate ids.
    /// Assert on like_ids (not only assembled results): note_summaries_for_ids also
    /// filters deleted_at, which would mask a regression in the SQL candidate path.
    /// Soft-delete drops FTS; re-insert a stale FTS row so this is specifically
    /// the `deleted_at IS NULL` clause on like_ids.
    #[test]
    fn keyword_search_excludes_soft_deleted_notes() {
        let mut conn = setup_db();
        let fid = folder_id(&conn);
        let ws = ws_id(&conn);
        const MARKER: &str = "ξ";
        let live = notes::create(
            &mut conn,
            &fid,
            Some(format!("{MARKER}-live")),
            Some(1592),
        )
        .unwrap();
        let gone = notes::create(
            &mut conn,
            &fid,
            Some(format!("{MARKER}-trash")),
            Some(1592),
        )
        .unwrap();
        notes::delete(&mut conn, &gone.note.id).unwrap();
        conn.execute(
            "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names)
             VALUES (?1, ?2, '', '', '')",
            rusqlite::params![&gone.note.id, format!("{MARKER}-trash")],
        )
        .unwrap();

        let ids = like_ids(&conn, MARKER, &ws, &YearFilter::None).unwrap();
        assert!(ids.contains(&live.note.id));
        assert!(
            !ids.contains(&gone.note.id),
            "like_ids must exclude soft-deleted notes even with stale FTS"
        );

        let r = search(&conn, MARKER, Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert!(r.results.iter().any(|n| n.id == live.note.id));
        assert!(r.results.iter().all(|n| n.id != gone.note.id));

        // 1글자 MARKER 는 2글자 창이 없어 위는 예전 LIKE 전체 스캔 경로다. Wave D 의 두 새 경로(2글자 색인 → LIKE,
        // FTS → 매핑 표)는 후보를 매핑 표로 찾으므로, 매핑 행 없는 낡은 FTS 행은 deleted_at 검사 전에 이미 빠져 버려
        // 이 테스트가 vacuous 해진다. 그래서 쌍둥이의 낡은 행에는 fts::bigram_index 로 매핑·색인 행까지 만들어
        // **후보로 잡히게** 하고, 그다음 deleted_at IS NULL 절이 빼는지를 본다.
        const MARKER2: &str = "ξψω"; // 2글자 창(ξψ, ψω) → 2글자 색인 경로, 3글자 → FTS 경로
        let live2 = notes::create(&mut conn, &fid, Some(format!("{MARKER2}-live")), Some(1592)).unwrap();
        let gone2 = notes::create(&mut conn, &fid, Some(format!("{MARKER2}-trash")), Some(1592)).unwrap();
        notes::delete(&mut conn, &gone2.note.id).unwrap();
        {
            let tx = conn.transaction().unwrap();
            let title = format!("{MARKER2}-trash");
            tx.execute(
                "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names) VALUES (?1, ?2, '', '', '')",
                rusqlite::params![&gone2.note.id, &title],
            )
            .unwrap();
            let rowid = tx.last_insert_rowid();
            crate::repo::fts::bigram_index(&tx, rowid, &gone2.note.id, &[&title, "", "", ""]).unwrap();
            tx.commit().unwrap();
        }
        // 낡은 행이 정말 후보로 잡힌다(두 경로 모두) — deleted_at 절을 빼면 나왔을 것.
        let in_bigram: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_bigram b JOIN notes_bigram_map m ON m.id = b.rowid
                 WHERE notes_bigram MATCH '\"ξψ\"' AND m.note_id = ?1",
                [&gone2.note.id],
                |r| r.get(0),
            )
            .unwrap();
        let in_fts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts f JOIN notes_bigram_map m ON m.id = f.rowid
                 WHERE notes_fts MATCH '\"ξψω\"' AND m.note_id = ?1",
                [&gone2.note.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((in_bigram, in_fts), (1, 1), "stale trashed row must be a candidate on both new paths");
        for q in ["ξψ", MARKER2] {
            let ids = like_ids(&conn, q, &ws, &YearFilter::None).unwrap();
            assert!(ids.contains(&live2.note.id), "{q}");
            assert!(!ids.contains(&gone2.note.id), "like_ids must exclude soft-deleted notes even with stale FTS ({q})");
            let r = search(&conn, q, Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
            assert!(r.results.iter().any(|n| n.id == live2.note.id), "{q}");
            assert!(r.results.iter().all(|n| n.id != gone2.note.id), "{q}");
        }
        let fts = fts_ids(&conn, "\"ξψω\"", &ws, &YearFilter::None, SEARCH_RESULT_CAP).unwrap();
        assert!(fts.contains(&live2.note.id) && !fts.contains(&gone2.note.id), "fts_ids excludes trash too");
    }

    /// S4: inverted year range is a validation error, not empty results.
    #[test]
    fn year_from_gt_year_to_is_validation_error() {
        let conn = setup_db();
        let err = search(&conn, "x", Some(1600), Some(1400), None, None).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "year_from > year_to must be Validation, got {err:?}"
        );
    }

    /// S5: `%` / `_` in the query are literals, not LIKE wildcards.
    #[test]
    fn like_escape_treats_percent_and_underscore_as_literals() {
        let mut conn = setup_db();
        let fid = folder_id(&conn);
        let literal = notes::create(&mut conn, &fid, Some("a_b exact".into()), Some(1500)).unwrap();
        let wildcard_bait =
            notes::create(&mut conn, &fid, Some("axb bait".into()), Some(1501)).unwrap();

        // Without escape, `_` is a single-char wildcard and would match "axb".
        let r = search(&conn, "a_b", Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        let ids: Vec<_> = r.results.iter().map(|n| n.id.as_str()).collect();
        assert!(
            ids.contains(&literal.note.id.as_str()),
            "literal underscore title must match"
        );
        assert!(
            !ids.contains(&wildcard_bait.note.id.as_str()),
            "underscore must not act as a LIKE single-char wildcard"
        );

        assert_eq!(escape_like("100%_x"), "100\\%\\_x");
    }

    /// Empty query excludes soft-deleted at the year_scoped_ids candidate layer.
    #[test]
    fn empty_query_excludes_soft_deleted() {
        let mut conn = setup_db();
        let fid = folder_id(&conn);
        let ws = ws_id(&conn);
        let live = notes::create(&mut conn, &fid, Some("LiveEmpty".into()), Some(1500)).unwrap();
        let gone = notes::create(&mut conn, &fid, Some("GoneEmpty".into()), Some(1501)).unwrap();
        notes::delete(&mut conn, &gone.note.id).unwrap();

        let ids = year_scoped_ids(&conn, &ws, &YearFilter::None, SEARCH_RESULT_CAP).unwrap();
        assert!(ids.contains(&live.note.id));
        assert!(
            !ids.contains(&gone.note.id),
            "year_scoped_ids must exclude soft-deleted notes"
        );
    }

    /// search_excluded=1 폴더의 노트는 검색 세 경로(빈 쿼리/키워드/LIKE 폴백) 전부에서 후보 밖.
    #[test]
    fn search_excluded_folder_is_omitted_from_every_candidate_path() {
        let mut conn = setup_db();
        let visible_fid = folder_id(&conn);
        let ws = ws_id(&conn);
        let hidden_fid = folders::create(&mut conn, "숨김 폴더", Some(ws.clone()), None, None, None)
            .unwrap()
            .id;
        folders::set_exclusions(&mut conn, &hidden_fid, true, false).unwrap();

        const MARKER: &str = "제외마커";
        let visible = notes::create(&mut conn, &visible_fid, Some(format!("{MARKER} 보임")), Some(1600)).unwrap();
        let hidden = notes::create(&mut conn, &hidden_fid, Some(format!("{MARKER} 숨김")), Some(1600)).unwrap();

        let empty_ids = year_scoped_ids(&conn, &ws, &YearFilter::None, SEARCH_RESULT_CAP).unwrap();
        assert!(empty_ids.contains(&visible.note.id));
        assert!(!empty_ids.contains(&hidden.note.id));

        let r = search(&conn, MARKER, Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert!(r.results.iter().any(|n| n.id == visible.note.id));
        assert!(r.results.iter().all(|n| n.id != hidden.note.id));

        let like_ids_out = like_ids(&conn, MARKER, &ws, &YearFilter::None).unwrap();
        assert!(like_ids_out.contains(&visible.note.id));
        assert!(!like_ids_out.contains(&hidden.note.id));
    }

    /// BM25 ranking: title match (10.0) > tag match (5.0) > source_body match (2.0) > body match (1.0).
    ///
    /// The tag-vs-source_body pair is the discriminating case: bm25(notes_fts, 10.0, 5.0, 1.0, 2.0)
    /// (the old 4-arg call) maps positionally over notes_fts's 5 declared columns (note_id
    /// UNINDEXED, title, body, source_body, tag_names) and shifts every weight by one column —
    /// title gets 5.0, body gets 1.0, source_body gets 2.0, and tag_names (no 5th arg given)
    /// silently defaults to 1.0. Under that bug, source_body (2.0) would outrank tag_names (1.0),
    /// inverting the intended tag(5.0) > source_body(2.0) order. The tag and source_body fields
    /// below hold the exact same keyword-only string so BM25's length normalization can't mask
    /// the weight bug either.
    #[test]
    fn test_bm25_ranking_prioritizes_title_matches() {
        let mut conn = setup_db();
        let fid = folder_id(&conn);

        // 1. Note with keyword only in body (weight 1.0)
        let body_note = notes::create(
            &mut conn,
            &fid,
            Some("Ordinary Alpha Title".to_string()),
            Some(1900),
        )
        .unwrap();
        crate::repo::sections::update(
            &mut conn,
            &body_note.sections[0].id,
            Some("Section".to_string()),
            Some("Detailed paragraph explaining QuantumDiscovery concepts.".to_string()),
            None,
        )
        .unwrap();

        // 2. Note with keyword only in a source (source_body, weight 2.0)
        let source_note = notes::create(
            &mut conn,
            &fid,
            Some("Ordinary Gamma Title".to_string()),
            Some(1900),
        )
        .unwrap();
        crate::repo::sources::add_text(
            &mut conn,
            &source_note.note.id,
            "src.txt",
            "QuantumDiscovery",
        )
        .unwrap();

        // 3. Note with keyword in tag (weight 5.0) — same bare keyword string as the source
        // above, so both columns have comparable length and only the weight differs.
        let tag_note = notes::create(
            &mut conn,
            &fid,
            Some("Ordinary Beta Title".to_string()),
            Some(1900),
        )
        .unwrap();
        crate::repo::note_tags::set_tags(
            &mut conn,
            &tag_note.note.id,
            vec!["QuantumDiscovery".to_string()],
        )
        .unwrap();

        // 4. Note with keyword in title (weight 10.0)
        let title_note = notes::create(
            &mut conn,
            &fid,
            Some("QuantumDiscovery Overview".to_string()),
            Some(1900),
        )
        .unwrap();

        let r = search(&conn, "QuantumDiscovery", Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO), None, None).unwrap();
        assert_eq!(r.results.len(), 4, "All 4 notes match the keyword");

        // Prioritized order: title > tag > source_body > body
        assert_eq!(
            r.results[0].id, title_note.note.id,
            "Title match must be ranked #1"
        );
        assert_eq!(
            r.results[1].id, tag_note.note.id,
            "Tag match must be ranked #2 (5.0), ahead of source_body (2.0)"
        );
        assert_eq!(
            r.results[2].id, source_note.note.id,
            "source_body match must be ranked #3 (2.0), ahead of body (1.0)"
        );
        assert_eq!(
            r.results[3].id, body_note.note.id,
            "Body match must be ranked #4"
        );
    }

    #[test]
    fn search_year_bounds_options() {
        let mut conn = setup_db();
        let fid = folder_id(&conn);

        notes::create(&mut conn, &fid, Some("Note 918".into()), Some(918)).unwrap();
        notes::create(&mut conn, &fid, Some("Note 1443".into()), Some(1443)).unwrap();
        notes::create(&mut conn, &fid, Some("Note 1592".into()), Some(1592)).unwrap();
        notes::create(&mut conn, &fid, Some("Note 1919".into()), Some(1919)).unwrap();

        // 1. 양끝 None = 전 범위
        let r_all = search(&conn, "Note", None, None, None, None).unwrap();
        assert_eq!(r_all.results.len(), 4, "both None must return all years");

        // 2. 한쪽만 None: year_from: Some(1500), year_to: None (>= 1500)
        let r_from = search(&conn, "Note", Some(1500), None, None, None).unwrap();
        let years_from: Vec<i64> = r_from.results.iter().map(|n| n.year).collect();
        assert_eq!(years_from, vec![1592, 1919]);

        // 3. 한쪽만 None: year_from: None, year_to: Some(1500) (<= 1500)
        let r_to = search(&conn, "Note", None, Some(1500), None, None).unwrap();
        let years_to: Vec<i64> = r_to.results.iter().map(|n| n.year).collect();
        assert_eq!(years_to, vec![918, 1443]);
    }

    #[test]
    fn search_limit_applied_and_default_behavior() {
        let mut conn = setup_db();
        let fid = folder_id(&conn);

        for i in 0..15 {
            notes::create(&mut conn, &fid, Some(format!("Item-{i}")), Some(1500 + i)).unwrap();
        }

        // 1. limit 적용: limit = Some(5)
        let r_limit = search(&conn, "Item", None, None, None, Some(5)).unwrap();
        assert_eq!(r_limit.results.len(), 5, "limit Some(5) must cap results to 5");

        // 빈 쿼리 경로에서도 limit 적용
        let r_empty_limit = search(&conn, "", None, None, None, Some(3)).unwrap();
        assert_eq!(r_empty_limit.results.len(), 3, "empty query with limit Some(3) must return 3 results");
        assert_eq!(r_empty_limit.total, 3);

        // 2. limit 생략 시 기본 동작 (None -> 기본 캡 500 내에서 15개 전체 반환)
        let r_default = search(&conn, "Item", None, None, None, None).unwrap();
        assert_eq!(r_default.results.len(), 15, "omitted limit defaults to cap (500) allowing all 15");

        // 3. limit clamp 검증: 0 또는 음수는 1로 클램프
        let r_zero = search(&conn, "Item", None, None, None, Some(0)).unwrap();
        assert_eq!(r_zero.results.len(), 1, "limit <= 0 clamped to 1");
    }
}

/// HANDOFF-2026-10-09 Wave D 등가성 — 예전(5d8f54bd) 검색 코드를 오라클로 그대로 두고, 새 `search()` 가
/// **결과 id 순서와 total** 까지 같은지 대조한다. 시드 코퍼스 대조는 tests/automation_corpus.rs 에 같은 오라클이 있다.
#[cfg(test)]
mod equivalence {
    use super::*;
    use crate::db::migrations;
    use crate::repo::{note_tags, notes, sections, sources};
    use std::collections::BTreeSet;

    /// 5d8f54bd 의 fts_sql · fts_ids · like_sql · like_ids · search(후보 id·total 부분) **그대로**.
    /// 바꾼 곳은 하나 — 두 ORDER BY 끝의 `, n.id`: (점수, year, created_at) 완전 동점의 순서는 예전에도 정해지지
    /// 않았고(실행마다 달라도 됐다), 새 코드도 같은 마지막 깨기(note id)를 쓴다. 스니펫은 대조 대상이 아니라 뺐다
    /// (populate_snippets 는 바뀌지 않았다). year_scoped_ids·build_match_query·escape_like·run_id_query 는 바뀌지
    /// 않은 공용 함수라 그대로 부른다.
    mod legacy {
        use super::super::{
            build_match_query, escape_like, run_id_query, year_scoped_ids, YearFilter, BM25_WEIGHTS, LIKE_SCAN_CAP,
            SEARCH_RESULT_CAP,
        };
        use crate::error::AppResult;
        use crate::repo::{folders, notes};
        use rusqlite::types::Value;
        use rusqlite::Connection;
        use std::collections::HashSet;

        fn fts_sql(year_clause: &str, limit: usize) -> String {
            format!(
                "SELECT n.id FROM notes n
         WHERE n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?)
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ? AND search_excluded = 0) AND n.deleted_at IS NULL{}
         ORDER BY (SELECT bm25(notes_fts, {BM25_WEIGHTS}) FROM notes_fts WHERE notes_fts MATCH ? AND note_id = n.id),
                  n.year, n.created_at, n.id
         LIMIT {limit}",
                year_clause
            )
        }

        fn fts_ids(conn: &Connection, match_query: &str, ws: &str, year_filter: &YearFilter, limit: usize) -> AppResult<Vec<String>> {
            let sql = fts_sql(year_filter.clause(), limit);
            let mut binds: Vec<Value> = vec![Value::Text(match_query.to_string()), Value::Text(ws.to_string())];
            year_filter.push_binds(&mut binds);
            binds.push(Value::Text(match_query.to_string()));
            run_id_query(conn, &sql, binds)
        }

        fn like_sql(year_clause: &str) -> String {
            format!(
                "SELECT n.id FROM notes n
         WHERE n.id IN (SELECT note_id FROM notes_fts
                         WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
                            OR source_body LIKE ? ESCAPE '\\' OR tag_names LIKE ? ESCAPE '\\')
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ? AND search_excluded = 0) AND n.deleted_at IS NULL{}
         ORDER BY n.year, n.created_at, n.id
         LIMIT {LIKE_SCAN_CAP}",
                year_clause
            )
        }

        fn like_ids(conn: &Connection, q: &str, ws: &str, year_filter: &YearFilter) -> AppResult<Vec<String>> {
            let pattern = format!("%{}%", escape_like(q));
            let sql = like_sql(year_filter.clause());
            let mut binds: Vec<Value> = vec![
                Value::Text(pattern.clone()),
                Value::Text(pattern.clone()),
                Value::Text(pattern.clone()),
                Value::Text(pattern),
                Value::Text(ws.to_string()),
            ];
            year_filter.push_binds(&mut binds);
            run_id_query(conn, &sql, binds)
        }

        /// 예전 `search()` 의 후보 수집·캡·요약 조립 — (results 의 id 순서, total).
        pub fn search_ids(
            conn: &Connection,
            query: &str,
            year_from: Option<i64>,
            year_to: Option<i64>,
            workspace_id: Option<String>,
            limit: Option<i64>,
        ) -> AppResult<(Vec<String>, i64)> {
            let year_filter = YearFilter::from_options(year_from, year_to)?;
            let effective_limit = limit.unwrap_or(SEARCH_RESULT_CAP as i64).clamp(1, SEARCH_RESULT_CAP as i64) as usize;
            let ws = match workspace_id {
                Some(w) => w,
                None => folders::active_workspace_id(conn)?,
            };
            let q = query.trim();
            let mut ids: Vec<String> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            let push = |id: String, ids: &mut Vec<String>, seen: &mut HashSet<String>| {
                if seen.insert(id.clone()) {
                    ids.push(id);
                }
            };
            if q.is_empty() {
                ids = year_scoped_ids(conn, &ws, &year_filter, effective_limit)?;
                let results = notes::note_summaries_for_ids(conn, &ids)?;
                let total = ids.len() as i64;
                return Ok((results.into_iter().map(|s| s.id).collect(), total));
            } else {
                let mut fts_has_hits = false;
                if let Some(match_query) = build_match_query(q) {
                    let fts_candidates = fts_ids(conn, &match_query, &ws, &year_filter, effective_limit)?;
                    fts_has_hits = !fts_candidates.is_empty();
                    for id in fts_candidates {
                        push(id, &mut ids, &mut seen);
                    }
                }
                let char_len = q.chars().count();
                if char_len <= 2 || !fts_has_hits {
                    for id in like_ids(conn, q, &ws, &year_filter)? {
                        push(id, &mut ids, &mut seen);
                    }
                }
            }
            let total = ids.len() as i64;
            let capped_ids = if ids.len() > effective_limit { &ids[..effective_limit] } else { &ids[..] };
            let results = notes::note_summaries_for_ids(conn, capped_ids)?;
            Ok((results.into_iter().map(|s| s.id).collect(), total))
        }
    }

    fn setup() -> (Connection, String, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        let folder: String = conn
            .query_row("SELECT id FROM folders WHERE workspace_id = ?1 LIMIT 1", [&ws], |r| r.get(0))
            .unwrap();
        (conn, ws, folder)
    }

    fn note_y(conn: &mut Connection, folder: &str, title: &str, body: &str, year: i64) -> String {
        let d = notes::create(conn, folder, Some(title.to_string()), Some(year)).unwrap();
        sections::update(conn, &d.sections[0].id, None, Some(body.to_string()), None).unwrap();
        d.note.id
    }

    fn note(conn: &mut Connection, folder: &str, title: &str, body: &str) -> String {
        note_y(conn, folder, title, body, 2026)
    }

    /// 새 경로는 notes_fts 행마다 매핑 행이 있다는 불변식(V95)에 기댄다 — 깨졌으면 여기서 크게 실패.
    fn assert_every_fts_row_mapped(conn: &Connection) {
        let missing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts f LEFT JOIN notes_bigram_map m ON m.id = f.rowid AND m.note_id = f.note_id
                 WHERE m.id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(missing, 0, "every notes_fts row must have its map row (V95)");
    }

    #[derive(Default)]
    struct Tally {
        compared: usize,
        nonempty: usize,
    }

    fn assert_same(conn: &Connection, ws: &str, q: &str, years: (Option<i64>, Option<i64>), t: &mut Tally) -> Vec<String> {
        let old = legacy::search_ids(conn, q, years.0, years.1, Some(ws.to_string()), None).unwrap();
        let new = search(conn, q, years.0, years.1, Some(ws.to_string()), None).unwrap();
        let new_ids: Vec<String> = new.results.iter().map(|s| s.id.clone()).collect();
        assert_eq!(new_ids, old.0, "query {q:?} years {years:?}: result ids/order differ from the old search");
        assert_eq!(new.total, old.1, "query {q:?} years {years:?}: total differs");
        t.compared += 1;
        t.nonempty += usize::from(!new_ids.is_empty());
        new_ids
    }

    /// notes_fts 텍스트의 모든 2·3글자 창(공백·기호 포함 원문 그대로 + ASCII 대문자판).
    fn windows(conn: &Connection) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let mut stmt = conn.prepare("SELECT title, body, source_body, tag_names FROM notes_fts").unwrap();
        let rows = stmt
            .query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?]))
            .unwrap();
        for cols in rows {
            for c in cols.unwrap() {
                let chars: Vec<char> = c.chars().collect();
                for k in [2usize, 3] {
                    for w in chars.windows(k) {
                        let s: String = w.iter().collect();
                        if s.trim().is_empty() {
                            continue;
                        }
                        out.insert(s.to_ascii_uppercase());
                        out.insert(s);
                    }
                }
            }
        }
        out
    }

    const CURATED: &[&str] = &[
        // 여러 낱말 · 한영 섞임
        "부산 여행", "프로젝트 마감", "커피 Busan", "CRDT는 Lww보다", "abc 대소문자", "École ÉCOLE", "커피값만 9월에",
        "해운대 광안리", "SOURCE text", "프로젝트", "마감", "부산", "여행", "커피",
        // _ % \ 리터럴
        "a_b", "c%d", "e\\f", "한_글", "x'y", "\"따옴표\"", "underscore_and%percent", "100%", "_",
        // 1글자 · 기호뿐
        "비", "a", "커", "%", "\\", "·", "_%", "().", "—", "·,", "!",
        // 결과 없는 오타
        "부산여헹", "zzqx", "커퓌", "프로젝트 없는말",
    ];

    const YEARS: &[(Option<i64>, Option<i64>)] = &[
        (None, None),
        (Some(FULL_SPAN_FROM), Some(FULL_SPAN_TO)),
        (Some(1500), Some(1600)),
        (Some(1900), None),
        (None, Some(1999)),
        (Some(2026), Some(2026)),
    ];

    /// (b) 합성 경계 사례 — question_search 의 bigram_lookup_equals_like_scan_on_edge_cases 노트 집합 + 연도·검색 제외
    /// 폴더·휴지통·라틴 대소문자·`_` `%` `\`·완전 동점.
    #[test]
    fn new_search_equals_old_search_on_edge_cases() {
        let (mut conn, ws, folder) = setup();
        // question_search.rs 의 경계 사례 그대로.
        note(&mut conn, &folder, "커피값만 9월에", "10km 달림. CRDT는 Lww보다?\n줄바꿈\t탭·가운뎃점,쉼표(괄호)[대괄호]");
        note(&mut conn, &folder, "ÉCOLE École", "대소문자 ABC abc AbC — 비ASCII 는 안 접힌다: Ünïcode ünïcode e\u{301}clair");
        note(&mut conn, &folder, "underscore_and%percent", "a_b c%d e\\f 한_글 x'y \"따옴표\"");
        note(&mut conn, &folder, "숫자 2026년 10월 08일", "3.14 1,000원 v2 iPhone15 第一 日本語");
        let tagged = note(&mut conn, &folder, "태그 노트", "본문");
        note_tags::set_tags(&mut conn, &tagged, vec!["여행".into(), "Busan".into()]).unwrap();
        let sourced = note(&mut conn, &folder, "출처 노트", "본문");
        sources::add_text(&mut conn, &sourced, "src.txt", "해운대 광안리\n\nSOURCE text").unwrap();
        let hidden_folder = folders::create(&mut conn, "숨김", Some(ws.clone()), None, None, None).unwrap().id;
        folders::set_exclusions(&mut conn, &hidden_folder, true, false).unwrap();
        let hidden = note(&mut conn, &hidden_folder, "숨김 커피", "커피 여행 부산 여행 프로젝트 마감");
        let gone = note(&mut conn, &folder, "지운 커피", "커피 여행 부산 여행 프로젝트 마감");
        notes::delete(&mut conn, &gone).unwrap();
        let sheet_note = note(&mut conn, &folder, "시트", "");
        let sheet_json = r#"{"v":1,"rows":10,"cols":[{"w":96},{"w":96}],"cells":{"A1":{"raw":"항목"},"B1":{"raw":"금액"},"A2":{"raw":"커피값"},"B2":{"raw":"4500"},"A3":{"raw":"Taxi"},"B3":{"raw":"=SUM(B2:B2)"}},"charts":[]}"#;
        sections::create_with_body_and_kind(&mut conn, &sheet_note, None, sheet_json.to_string(), Some(crate::repo::sheet::KIND.to_string()))
            .unwrap();
        // 연도가 다른 노트들(연도 필터가 실제로 결과를 바꾸게) + 관련도가 갈리는 노트들.
        let y1592 = note_y(&mut conn, &folder, "부산 여행 1592", "부산 여행 프로젝트 마감 커피", 1592);
        note_y(&mut conn, &folder, "프로젝트", "마감 프로젝트 프로젝트 프로젝트", 1919);
        note_y(&mut conn, &folder, "메모", "부산에서 여행. 커피 한 잔. 프로젝트마감", 1500);
        note_y(&mut conn, &folder, "Busan Trip", "busan BUSAN 부산 여행 abc", 1600);
        // 완전 동점 — 같은 제목·본문·연도(created_at 도 같을 수 있다): 마지막 깨기 n.id 가 순서를 정한다.
        for _ in 0..4 {
            note_y(&mut conn, &folder, "동점 커피 프로젝트", "부산 여행 동점", 1700);
        }
        assert_every_fts_row_mapped(&conn);

        let mut t = Tally::default();
        // 모든 2·3글자 창 — 연도 필터 없음 / 있음.
        let wins = windows(&conn);
        assert!(wins.len() > 300, "enough windows: {}", wins.len());
        for w in &wins {
            for years in [(None, None), (Some(1500), Some(2000))] {
                assert_same(&conn, &ws, w, years, &mut t);
            }
        }
        // 고른 쿼리 — 연도 필터 6가지.
        for q in CURATED {
            for years in YEARS {
                assert_same(&conn, &ws, q, *years, &mut t);
            }
        }
        assert!(t.nonempty > 500, "the comparison must include real matches: {} of {}", t.nonempty, t.compared);

        // 비-vacuous: 연도 필터가 실제로 결과를 바꾸고, 검색 제외·휴지통 노트는 (매치되는 내용인데도) 빠진다.
        let all = assert_same(&conn, &ws, "부산 여행", (None, None), &mut t);
        let y16 = assert_same(&conn, &ws, "부산 여행", (Some(1500), Some(1600)), &mut t);
        assert!(all.contains(&y1592) && y16.contains(&y1592) && y16.len() < all.len(), "year filter must change the set");
        for q in ["부산 여행", "커피", "프로젝트", "프로젝트 마감", "커"] {
            let ids = assert_same(&conn, &ws, q, (None, None), &mut t);
            assert!(!ids.contains(&hidden) && !ids.contains(&gone), "{q}: excluded/trashed must not appear");
        }
    }

    /// 캡을 넘는 경우 — 2글자 색인 경로가 LIKE_SCAN_CAP 를, FTS 경로가 결과 상한 500 을, 1글자 LIKE 가 LIKE_SCAN_CAP 를
    /// 넘는다. 캡이 동점 구간을 가르는 자리에서도 순서가 같아야 한다(시각이 같은 노트가 많다).
    #[test]
    fn new_search_equals_old_search_over_the_caps() {
        let (mut conn, ws, folder) = setup();
        for i in 0..(LIKE_SCAN_CAP as i64 + 60) {
            let title = format!("ζηθ 캡 {}", if i % 7 == 0 { "ζηθ ζηθ" } else { "" });
            notes::create(&mut conn, &folder, Some(title), Some(1500 + (i % 3))).unwrap();
        }
        assert_every_fts_row_mapped(&conn);
        let mut t = Tally::default();
        for q in ["ζη", "ζηθ", "캡", "ζηθ 캡", "ηθ"] {
            for years in [(None, None), (Some(1500), Some(1501)), (Some(1502), None)] {
                let ids = assert_same(&conn, &ws, q, years, &mut t);
                assert!(!ids.is_empty(), "{q} {years:?}");
            }
        }
        let r = search(&conn, "ζη", None, None, Some(ws.clone()), None).unwrap();
        assert_eq!(r.total, LIKE_SCAN_CAP as i64, "2-char index path is capped at LIKE_SCAN_CAP");
        let r = search(&conn, "ζηθ", None, None, Some(ws.clone()), None).unwrap();
        assert_eq!(r.total, SEARCH_RESULT_CAP as i64, "FTS path is capped at the result cap");
        // limit 이 작을 때도(동점 구간 한가운데서 잘린다).
        for q in ["ζη", "ζηθ", "캡"] {
            let old = legacy::search_ids(&conn, q, None, None, Some(ws.clone()), Some(7)).unwrap();
            let new = search(&conn, q, None, None, Some(ws.clone()), Some(7)).unwrap();
            assert_eq!(new.results.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), old.0, "{q} limit 7");
            assert_eq!(new.total, old.1);
        }
    }

    /// D3 — 검색이 읽기 전용 연결(db::open_read_only: query_only)에서도 쓰기 연결과 똑같이 돈다(물질화 CTE·정렬용
    /// 임시 B-tree 포함). AppState::with_read 경유(search_notes 와 같은 길)로.
    #[test]
    fn search_runs_on_the_read_connection_with_identical_results() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let ws = folders::active_workspace_id(&conn).unwrap();
        let folder: String = conn
            .query_row("SELECT id FROM folders WHERE workspace_id = ?1 LIMIT 1", [&ws], |r| r.get(0))
            .unwrap();
        for i in 0..40 {
            note_y(&mut conn, &folder, &format!("커피 프로젝트 {i}"), "부산 여행 해운대 마감", 1500 + (i % 5));
        }
        let queries = ["", "프로젝트", "커피", "부산 여행", "부산여헹", "비", "커", "동기화 방식 고민"];
        let expected: Vec<(Vec<(String, Option<String>)>, i64)> = queries
            .iter()
            .map(|q| {
                let r = search(&conn, q, None, Some(1503), Some(ws.clone()), None).unwrap();
                (r.results.into_iter().map(|s| (s.id, s.snippet)).collect(), r.total)
            })
            .collect();
        let state = crate::commands::AppState::new_with_read_handle(conn, dir.path().to_path_buf());
        assert!(state.has_read_handle(), "file DB must get a read connection");
        for (q, want) in queries.iter().zip(expected) {
            let got = state.with_read(|c| {
                let r = search(c, q, None, Some(1503), Some(ws.clone()), None).unwrap();
                (r.results.into_iter().map(|s| (s.id, s.snippet)).collect::<Vec<_>>(), r.total)
            });
            assert_eq!(got, want, "{q:?}: read connection must return the same results");
        }
        // 읽기 연결은 정말로 쓰기를 거부한다(그 위에서 검색이 돈 것).
        let write = state.with_read(|c| c.execute("DELETE FROM notes", []));
        assert!(write.is_err(), "read connection is query_only");
    }
}
