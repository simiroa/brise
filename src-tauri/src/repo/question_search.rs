//! 채팅 질문 검색 — 자연어 질문을 핵심어로 풀어 **OR** 로 찾고 점수순으로 돌려준다.
//!
//! 왜 따로 있나: `repo::search::search` 는 검색창용이라 여러 낱말을 **전부(AND)** 요구한다.
//! 채팅은 "커피는 몇 시 이후로 안 마시기로 했지?" 같은 문장을 그대로 넣는데, 그 문장의 모든 어절을
//! 담은 노트는 없다 → 2026-10-08 코퍼스 실측 재현율 0/31(docs/PLAN-2026-10-08-automation.md F22).
//! 검색창의 AND 의미는 그대로 두고, 채팅 경로(`repo::pet::rag_hits` — 펫·사이드바 챗 모두
//! `pet_chat` 을 지난다)만 여기로 온다.
//!
//! 방식(토큰 0, 의존성 0): 문장부호 제거 → 어절 → 조사·어미 떼기(남는 줄기가 2자 이상일 때만) →
//! 의문사·군더더기 제거 → 2자 이상 핵심어만. 핵심어마다 노트 집합을 구해(3자 이상 = trigram FTS,
//! 2자 = 2글자 색인 notes_bigram) 드문 말일수록 큰 가중치(idf)를 더하고,
//! 제목에 있으면 한 번 더 더한다.
//!
//! ponytail: 형태소 분석기 없이 접미사 목록으로 줄기를 뗀다. "고양이"→"고양" 같은 과잉 절단이
//! 생길 수 있지만 2글자 색인·trigram 이 부분 일치라 재현율은 거의 잃지 않는다. 동의어(수면↔잠)와
//! 오타(커퓌)는 못 잡는다 — 그건 자동화의 태그·지식 노트(PLAN W11·W12)나 LLM 확장의 몫이다.
use crate::error::{db as dberr, AppResult};
use crate::models::NoteSummary;
use crate::repo::search;
use crate::repo::{notes, sheet};
use rusqlite::Connection;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// 한 질문에서 쓰는 핵심어 상한 — 긴 문단이 들어와도 조회 수가 폭주하지 않게.
const MAX_TERMS: usize = 10;
/// 핵심어 하나가 돌려주는 노트 상한(idf 의 df 도 여기 묶인다 — 이보다 흔한 말은 어차피 가중치가 작다).
const PER_TERM_CAP: usize = 5000;
/// 점수 상위 후보를 이 배수만큼 요약 조회한 뒤 제목 가산으로 다시 줄 세운다.
const RERANK_FACTOR: usize = 3;
/// 핵심어가 본문에 없을 때 주는 본문 첫머리 길이(채팅 쪽 `RAG_SNIPPET_CHARS` 240 안쪽).
const LEAD_SNIPPET_CHARS: usize = 200;

/// 의문사·대명사·조동사·시간 군더더기 — 줄기를 뗀 **뒤** 정확히 같으면 버린다.
const STOPWORDS: &[&str] = &[
    "뭐", "뭘", "무엇", "언제", "어디", "어디서", "누구", "누가", "어떻게", "어떤", "어땠", "왜", "몇", "무슨",
    "얼마", "얼마나", "거", "것", "게", "건", "걸", "것들", "내", "나", "저", "제", "우리", "너", "그", "이",
    "이것", "그것", "저것", "좀", "혹시", "관련", "관련해", "관련해서", "관련된", "대해", "대해서", "대한", "관해",
    "관해서", "적어둔", "적어놓은", "적은", "적었", "적어", "써둔", "메모", "노트", "기록", "있어", "있나",
    "있었", "있었지", "있었나", "있는", "있던", "없어", "없을", "없는", "했지", "했어", "했나", "했던", "했었",
    "하는", "하던", "해서", "때", "중", "제일", "가장", "정말", "그냥", "다시", "또", "잘", "안", "못", "아주",
    "너무", "나서", "하고", "어제", "오늘", "내일", "지난", "지난번", "지난달", "지난주", "이번", "이번주",
    "이번달", "다음", "다음주", "요즘", "최근", "예전", "전에", "나한테", "내가", "거야", "건가", "인가", "일까",
    "알려줘", "알려", "말해줘", "찾아줘", "찾아", "보여줘", "나왔어", "나왔", "나와", "중에", "what", "when", "where", "who", "how", "why",
    "the", "and", "for", "did", "about", "my",
];

/// 서술 어미 — 먼저 뗀다(긴 것부터).
const ENDINGS: &[&str] = &[
    "했었지", "였었지", "었었지", "했었나", "이었지", "였더라", "었더라", "았더라", "했더라", "하려고", "하기로",
    "입니다", "합니다", "이에요", "더라", "였지", "었지", "았지", "했지", "했나", "였나", "었나", "았나", "기로",
    "려고", "했어", "였어", "었어", "았어", "왔어", "해서", "하고", "하는", "하던", "했던", "었던", "았던", "였던",
    "이었", "는지", "은지", "인지", "할까", "일까", "인가", "하기", "기는", "기를", "기가", "해요", "에요", "예요",
    "할", "였", "었", "았",
];

/// 조사 — 어미 다음에 뗀다(긴 것부터).
const PARTICLES: &[&str] = &[
    "에서는", "에게서", "으로는", "으로도", "이라도", "에서도", "까지는", "부터는", "에서", "에게", "한테", "께서",
    "으로", "이랑", "처럼", "보다", "까지", "부터", "마다", "이나", "에는", "에도", "로는", "로도", "과는", "와는",
    "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "도", "만", "의", "랑", "요",
];

fn is_hangul(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c)
}

/// 접미사 하나를 떼되, 남는 줄기가 2자 미만이면 떼지 않는다("역할"→"역" 같은 파괴 방지).
fn strip_one(token: &str, suffixes: &[&str]) -> Option<String> {
    let len = token.chars().count();
    for suf in suffixes {
        let sl = suf.chars().count();
        if len >= sl + 2 && token.ends_with(suf) {
            return Some(token[..token.len() - suf.len()].to_string());
        }
    }
    None
}

fn stem(token: &str) -> String {
    if !token.chars().any(is_hangul) {
        return token.to_string();
    }
    let mut t = token.to_string();
    if let Some(s) = strip_one(&t, ENDINGS) {
        t = s;
    }
    if let Some(s) = strip_one(&t, PARTICLES) {
        t = s;
    }
    t
}

/// 질문 → 핵심어(순서 유지, 중복 제거, 최대 [`MAX_TERMS`]개). 2자 미만은 버린다 — 1자 LIKE 는
/// 노트 전체를 긁어 근거가 아니라 잡음을 돌려준다(기존 `rag_hits` 의 "1글자는 조회하지 않는다" 와 같은 선).
pub fn question_terms(question: &str) -> Vec<String> {
    // 영문자와 한글이 붙은 어절("km야", "CRDT는")은 경계에서 가른다 — 안 그러면 "km야" 통째로 찾다 놓친다
    // (2026-10-08 답변 평가 c22). 숫자-한글("9월")은 한 낱말이라 가르지 않는다.
    let mut normalized = String::with_capacity(question.len());
    let mut prev: Option<char> = None;
    for c in question.chars() {
        let c = if c.is_alphanumeric() || is_hangul(c) { c.to_ascii_lowercase() } else { ' ' };
        if let Some(p) = prev {
            if (p.is_ascii_alphabetic() && is_hangul(c)) || (is_hangul(p) && c.is_ascii_alphabetic()) {
                normalized.push(' ');
            }
        }
        normalized.push(c);
        prev = Some(c);
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for raw in normalized.split_whitespace() {
        if STOPWORDS.contains(&raw) {
            continue;
        }
        let t = stem(raw);
        if t.chars().count() < 2 || STOPWORDS.contains(&t.as_str()) {
            continue;
        }
        if seen.insert(t.clone()) {
            out.push(t);
            if out.len() >= MAX_TERMS {
                break;
            }
        }
    }
    out
}

fn searchable_note_count(conn: &Connection, ws: &str) -> AppResult<f64> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes n
             WHERE n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1 AND search_excluded = 0)
               AND n.deleted_at IS NULL",
            [ws],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    Ok(n.max(1) as f64)
}

/// 3자 이상 핵심어 — trigram FTS 로 **집합만** 구한다. 검색창의 `search::fts_ids` 는 쓰지 않는다: 그건 bm25 로
/// 정렬하려고 후보마다 MATCH 를 다시 도는 상관 서브쿼리라, 흔한 낱말이면 매치 수의 제곱으로 느려진다
/// (2026-10-08 합성 1만 노트 release 실측 11~33초 — 채팅은 전역 DB 잠금을 쥔 채 돈다). 점수는 여기서 idf 로 따로 매긴다.
/// note_id 는 notes_fts 열이 아니라 매핑 표(notes_bigram_map, id = notes_fts rowid, V95)에서 읽는다 — note_id 열을
/// 읽으면 FTS5 가 맞은 행마다 본문까지 통째로 가져와 5000건에 ~19ms 였다(MATCH 자체는 0.5ms).
/// ponytail: `PER_TERM_CAP` 을 넘는 흔한 낱말은 어느 노트 5000개가 잡히는지가 예전(notes 순회)과 다를 수 있다
/// (지금은 notes_fts rowid 내림차순 = 최근 저장 노트 먼저, R-7). 상한 아래에선 집합이 같다(테스트 `fts_term_lookup_equals_note_id_read`).
fn fts_term_ids(conn: &Connection, ws: &str, term: &str) -> AppResult<Vec<String>> {
    let Some(mq) = search::build_match_query(term) else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "SELECT n.id FROM notes_fts f
         JOIN notes_bigram_map m ON m.id = f.rowid
         JOIN notes n ON n.id = m.note_id
         WHERE notes_fts MATCH ?1
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?2 AND search_excluded = 0)
           AND n.deleted_at IS NULL
         ORDER BY f.rowid DESC
         LIMIT {PER_TERM_CAP}"
    );
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let rows = stmt.query_map(rusqlite::params![mq, ws], |r| r.get::<_, String>(0)).map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

/// 2자 핵심어 — trigram 이 못 잡으므로 2글자 색인(notes_bigram, specs/db/schemas/fts_bigram.sql)에서 찾는다.
/// 의미는 예전 notes_fts 네 열 `LIKE '%핵심어%'` 와 같다(테스트 `bigram_lookup_equals_like_scan` 이 LIKE 를
/// 오라클로 대조). 예전 LIKE 는 노트 수 × 본문 길이만큼 훑어 1만 노트·본문 1천 자에서 낱말 3개에 120ms 였다.
/// ponytail: `PER_TERM_CAP` 을 넘는 흔한 낱말은 어느 노트 5000개가 잡히는지가 LIKE(notes_fts 순서)와 다를 수 있다
/// (지금은 색인 rowid 내림차순 = 최근 저장 노트 먼저). 상한 아래에선 집합이 같다. idf 는 어차피 df=상한으로 묶인다.
fn bigram_terms_ids(conn: &Connection, ws: &str, terms: &[String]) -> AppResult<HashMap<String, Vec<String>>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    if terms.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT n.id FROM notes_bigram b
         JOIN notes_bigram_map m ON m.id = b.rowid
         JOIN notes n ON n.id = m.note_id
         WHERE notes_bigram MATCH ?1
           AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?2 AND search_excluded = 0)
           AND n.deleted_at IS NULL
         ORDER BY b.rowid DESC
         LIMIT {PER_TERM_CAP}"
    );
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    for term in terms {
        // 핵심어는 글자·숫자뿐이라 따옴표가 들어올 일이 없지만, MATCH 문법이 깨지지 않게 구(phrase)로 감싼다.
        let mq = format!("\"{}\"", term.replace('"', "\"\""));
        let rows = stmt.query_map(rusqlite::params![mq, ws], |r| r.get::<_, String>(0)).map_err(dberr)?;
        let ids: Vec<String> = rows.collect::<Result<_, _>>().map_err(dberr)?;
        if !ids.is_empty() {
            out.insert(term.clone(), ids);
        }
    }
    Ok(out)
}

/// 채팅 질문으로 노트를 찾는다 — 핵심어 OR, idf 가중, 제목 가산. 스니펫은 그 노트에서 가장 드문
/// 핵심어 주변(검색창과 같은 \u0002/\u0003 표시 — 호출부가 벗긴다).
pub fn question_hits(
    conn: &Connection,
    workspace_id: &str,
    question: &str,
    limit: usize,
) -> AppResult<Vec<NoteSummary>> {
    let terms = question_terms(question);
    if terms.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let total = searchable_note_count(conn, workspace_id)?;

    // note_id → (점수, 맞은 핵심어 수)
    let mut scores: HashMap<String, (f64, usize)> = HashMap::new();
    let mut weighted: Vec<(String, f64)> = Vec::new();
    let short: Vec<String> = terms.iter().filter(|t| t.chars().count() < 3).cloned().collect();
    let mut ids_by_term = bigram_terms_ids(conn, workspace_id, &short)?;
    for term in terms.iter().filter(|t| t.chars().count() >= 3) {
        ids_by_term.insert(term.clone(), fts_term_ids(conn, workspace_id, term)?);
    }
    for term in &terms {
        let ids = ids_by_term.remove(term).unwrap_or_default();
        if ids.is_empty() {
            continue;
        }
        let idf = (1.0 + total / ids.len() as f64).ln();
        for id in ids {
            let e = scores.entry(id).or_insert((0.0, 0));
            e.0 += idf;
            e.1 += 1;
        }
        weighted.push((term.clone(), idf));
    }
    if scores.is_empty() {
        return Ok(Vec::new());
    }

    let mut ranked: Vec<(String, f64, usize)> = scores.into_iter().map(|(id, (s, m))| (id, s, m)).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    ranked.truncate(limit.saturating_mul(RERANK_FACTOR));

    let ids: Vec<String> = ranked.iter().map(|r| r.0.clone()).collect();
    let mut summaries = notes::note_summaries_for_ids(conn, &ids)?;
    let base: HashMap<&str, (f64, usize)> = ranked.iter().map(|r| (r.0.as_str(), (r.1, r.2))).collect();
    let mut scored: Vec<(f64, usize, NoteSummary)> = summaries
        .drain(..)
        .map(|s| {
            let (mut score, matched) = base.get(s.id.as_str()).copied().unwrap_or((0.0, 0));
            let title = s.title.to_lowercase();
            for (term, idf) in &weighted {
                if title.contains(term.as_str()) {
                    score += idf;
                }
            }
            (score, matched, s)
        })
        .collect();
    // 동점은 맞은 핵심어 수 → 최근 수정 → id 로 깬다(같은 질문이 실행마다 다른 근거를 내지 않게).
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(Ordering::Equal)
            .then(b.1.cmp(&a.1))
            .then(b.2.updated_at.cmp(&a.2.updated_at))
            .then(a.2.id.cmp(&b.2.id))
    });
    scored.truncate(limit);
    let mut results: Vec<NoteSummary> = scored.into_iter().map(|(_, _, s)| s).collect();

    // 스니펫: 그 노트 본문에 들어 있는 가장 드문 핵심어 주변.
    let mut by_rarity = weighted.clone();
    by_rarity.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    let note_ids: Vec<String> = results.iter().map(|s| s.id.clone()).collect();
    let bodies = sheet::note_body_texts(conn, &note_ids, None)?;
    for item in results.iter_mut() {
        item.snippet = bodies.get(&item.id).and_then(|body| {
            by_rarity
                .iter()
                .find_map(|(term, _)| search::extract_plain_snippet(body, term))
                // 핵심어가 제목에만 있으면 본문 첫머리를 준다 — 안 그러면 채팅 모델은 제목만 보고 "목록은 기록되어
                // 있지 않다"고 답한다(2026-10-08 답변 평가 c08·c12: "읽을 책" 노트의 본문 목록이 전달되지 않았다).
                .or_else(|| lead_snippet(body))
        });
    }
    Ok(results)
}

/// 본문 첫머리 발췌(표시 없음) — 핵심어가 본문에 없을 때.
fn lead_snippet(body: &str) -> Option<String> {
    let text = body.trim();
    if text.is_empty() {
        return None;
    }
    let head: String = text.chars().take(LEAD_SNIPPET_CHARS).collect();
    Some(if text.chars().count() > LEAD_SNIPPET_CHARS { format!("{head}…") } else { head })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::{folders, sections};

    #[test]
    fn question_terms_strip_particles_endings_and_question_words() {
        // 코퍼스 질문(src-tauri/tests/fixtures/automation/corpus.json qa) 그대로.
        assert_eq!(question_terms("커피는 몇 시 이후로 안 마시기로 했지?"), vec!["커피", "이후", "마시"]);
        assert_eq!(question_terms("낮잠에 대해 내 생각이 바뀐 적 있어?"), vec!["낮잠", "생각", "바뀐"]);
        assert_eq!(question_terms("부산 여행 준비할 거 뭐 있었지?"), vec!["부산", "여행", "준비"]);
        assert_eq!(question_terms("동기화 방식으로 뭘 고민했었지?"), vec!["동기화", "방식", "고민"]);
        assert_eq!(question_terms("동기부여 관련해서 적어둔 거 있어?"), vec!["동기부여"]);
        assert_eq!(question_terms("목요일에 무슨 일정 있어?"), vec!["목요일", "일정"]);
        assert_eq!(question_terms("9월에 커피값 얼마 나왔어?"), vec!["9월", "커피값"]);
        // 부사형("길게")은 떼지 않고 남는다 — 드문 말이라 점수엔 거의 영향이 없다(알고 남기는 잡음).
        assert_eq!(question_terms("러닝 기록 중에 제일 길게 뛴 거리는?"), vec!["러닝", "길게", "거리"]);
    }

    #[test]
    fn question_terms_keep_short_safe_and_drop_one_char() {
        // 남는 줄기가 2자 미만이면 떼지 않는다 — "역할"·"회의"·"결과" 는 그대로.
        assert_eq!(question_terms("역할 회의 결과"), vec!["역할", "회의", "결과"]);
        // 1자는 버린다.
        assert!(question_terms("부").is_empty());
        assert!(question_terms("뭐 했지?").is_empty());
        // 영문·숫자는 줄기를 떼지 않는다.
        assert_eq!(question_terms("CRDT vs LWW 10km"), vec!["crdt", "vs", "lww", "10km"]);
    }

    #[test]
    fn question_terms_split_latin_hangul_boundary_but_keep_number_hangul() {
        assert_eq!(question_terms("가장 길게 달린 게 몇 km야?"), vec!["길게", "달린", "km"]);
        assert_eq!(question_terms("CRDT는 언제 썼지"), vec!["crdt", "썼지"]);
        assert_eq!(question_terms("9월에 쓴 거"), vec!["9월"]);
    }

    #[test]
    fn question_hits_gives_body_lead_when_terms_match_only_the_title() {
        let (mut conn, ws, folder) = setup();
        let id = note(&mut conn, &folder, "읽을 책", "- 도둑맞은 집중력\n- 아주 작은 습관의 힘");
        let hits = question_hits(&conn, &ws, "읽을 책 목록 알려줘", 5).unwrap();
        let hit = hits.iter().find(|n| n.id == id).expect("제목 일치 노트");
        let snip = hit.snippet.clone().unwrap_or_default();
        assert!(snip.contains("도둑맞은 집중력"), "본문이 모델에게 가야 한다: {snip:?}");
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

    fn note(conn: &mut Connection, folder: &str, title: &str, body: &str) -> String {
        let d = notes::create(conn, folder, Some(title.to_string()), Some(2026)).unwrap();
        let sec = d.sections[0].id.clone();
        sections::update(conn, &sec, None, Some(body.to_string()), None).unwrap();
        d.note.id
    }

    #[test]
    fn question_hits_finds_notes_a_whole_sentence_search_misses() {
        let (mut conn, ws, folder) = setup();
        let a = note(&mut conn, &folder, "커피 끊는 시간", "오후 2시 이후로 커피 안 마시니까 잠이 빨라짐");
        let _other = note(&mut conn, &folder, "장보기", "우유 계란 두부");
        let q = "커피는 몇 시 이후로 안 마시기로 했지?";
        // 검색창 경로(AND)는 이 문장으로 아무것도 못 찾는다 — 그래서 이 모듈이 있다.
        let and_hits = search::search(&conn, q, None, None, Some(ws.clone()), Some(5)).unwrap();
        assert!(and_hits.results.iter().all(|n| n.id != a), "AND 검색은 문장 질문에서 못 찾는 게 기존 동작");
        let hits = question_hits(&conn, &ws, q, 5).unwrap();
        assert_eq!(hits.first().map(|n| n.id.as_str()), Some(a.as_str()));
        let snip = hits[0].snippet.clone().unwrap_or_default();
        assert!(snip.contains('\u{2}'), "스니펫은 맞은 핵심어를 표시한다: {snip}");
    }

    #[test]
    fn question_hits_ranks_more_and_rarer_terms_higher_and_respects_exclusions() {
        let (mut conn, ws, folder) = setup();
        let both = note(&mut conn, &folder, "메모", "부산 여행 준비물 정리");
        let one = note(&mut conn, &folder, "메모2", "여행 가고 싶다");
        let hits = question_hits(&conn, &ws, "부산 여행 준비할 거 뭐 있었지?", 5).unwrap();
        let pos = |id: &str| hits.iter().position(|n| n.id == id);
        assert!(pos(&both).unwrap() < pos(&one).unwrap(), "핵심어를 더 많이 담은 노트가 앞");

        // 검색 제외 폴더의 노트는 채팅 근거로도 나오지 않는다(검색창과 같은 선).
        let hidden_folder = folders::create(&mut conn, "숨김", Some(ws.clone()), None, None, None).unwrap().id;
        conn.execute("UPDATE folders SET search_excluded = 1 WHERE id = ?1", [&hidden_folder]).unwrap();
        let hidden = note(&mut conn, &hidden_folder, "부산 여행", "부산 여행 준비");
        let hits = question_hits(&conn, &ws, "부산 여행", 10).unwrap();
        assert!(hits.iter().all(|n| n.id != hidden));
    }

    #[test]
    fn question_hits_title_match_breaks_ties_toward_the_title() {
        let (mut conn, ws, folder) = setup();
        let in_body = note(&mut conn, &folder, "일기", "오늘 동기부여 영상을 봤다");
        let in_title = note(&mut conn, &folder, "동기부여는 기다리면 안 옴", "일단 5분 시작");
        let hits = question_hits(&conn, &ws, "동기부여 관련해서 적어둔 거 있어?", 5).unwrap();
        assert_eq!(hits.first().map(|n| n.id.as_str()), Some(in_title.as_str()));
        assert!(hits.iter().any(|n| n.id == in_body));
    }
    // ── 2글자 색인 ⇔ 예전 LIKE 스캔(오라클) — HANDOFF-2026-10-08 Wave B ──

    /// 예전 구현 그대로(이름만 바꿈) — 색인 조회가 이것과 **같은 노트 집합**을 내야 한다.
    /// 2자 핵심어 — trigram 이 못 잡으므로 LIKE 인데, 핵심어마다 따로 훑지 않고 **한 번의 스캔**으로 전부 판정한다
    /// (질문 하나에 2자 명사가 3~6개인 게 보통이라, 따로 돌면 잠금 시간이 그만큼 곱해진다).
    fn like_terms_ids_oracle(conn: &Connection, ws: &str, terms: &[String]) -> AppResult<HashMap<String, Vec<String>>> {
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        if terms.is_empty() {
            return Ok(out);
        }
        let flags: Vec<String> = (1..=terms.len())
            .map(|k| {
                format!(
                    "(f.title LIKE ?{k} ESCAPE '\\' OR f.body LIKE ?{k} ESCAPE '\\' \
                     OR f.source_body LIKE ?{k} ESCAPE '\\' OR f.tag_names LIKE ?{k} ESCAPE '\\') AS m{k}"
                )
            })
            .collect();
        let any = (1..=terms.len()).map(|k| format!("m{k}")).collect::<Vec<_>>().join(" OR ");
        let ws_idx = terms.len() + 1;
        let sql = format!(
            "SELECT * FROM (
               SELECT f.note_id AS id, {flags} FROM notes_fts f
               WHERE f.note_id IN (SELECT n.id FROM notes n
                                    WHERE n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?{ws_idx} AND search_excluded = 0)
                                      AND n.deleted_at IS NULL)
             ) WHERE {any}",
            flags = flags.join(", ")
        );
        let mut binds: Vec<String> = terms.iter().map(|t| format!("%{}%", search::escape_like(t))).collect();
        binds.push(ws.to_string());
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let mut rows = stmt.query(rusqlite::params_from_iter(binds.iter())).map_err(dberr)?;
        while let Some(row) = rows.next().map_err(dberr)? {
            let id: String = row.get(0).map_err(dberr)?;
            for (k, term) in terms.iter().enumerate() {
                let hit: i64 = row.get(k + 1).map_err(dberr)?;
                if hit != 0 {
                    let v = out.entry(term.clone()).or_default();
                    if v.len() < PER_TERM_CAP {
                        v.push(id.clone());
                    }
                }
            }
        }
        Ok(out)
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    /// 코퍼스의 모든 2글자 창(+ 없는 낱말 몇 개)에 대해 색인 조회 == LIKE 스캔.
    fn assert_bigram_equals_like(conn: &Connection, ws: &str) {
        let mut terms: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut stmt = conn.prepare("SELECT title, body, source_body, tag_names FROM notes_fts").unwrap();
        let rows = stmt
            .query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?]))
            .unwrap();
        for cols in rows {
            for c in cols.unwrap() {
                crate::repo::fts::bigrams_into(&c, &mut terms);
            }
        }
        for extra in ["없음", "zz", "q9", "가a"] {
            terms.insert(extra.to_string());
        }
        assert!(terms.len() > 20, "대조할 창이 충분해야: {}", terms.len());
        let terms: Vec<String> = terms.into_iter().collect();
        let like = like_terms_ids_oracle(conn, ws, &terms).unwrap();
        let idx = bigram_terms_ids(conn, ws, &terms).unwrap();
        for t in &terms {
            let a = sorted(like.get(t).cloned().unwrap_or_default());
            let b = sorted(idx.get(t).cloned().unwrap_or_default());
            assert_eq!(a, b, "2글자 {t:?}: LIKE 와 색인이 다르다");
        }
    }

    #[test]
    fn bigram_lookup_equals_like_scan_on_edge_cases() {
        let (mut conn, ws, folder) = setup();
        note(&mut conn, &folder, "커피값만 9월에", "10km 달림. CRDT는 Lww보다?\n줄바꿈\t탭·가운뎃점,쉼표(괄호)[대괄호]");
        note(&mut conn, &folder, "ÉCOLE École", "대소문자 ABC abc AbC — 비ASCII 는 안 접힌다: Ünïcode ünïcode e\u{301}clair");
        note(&mut conn, &folder, "underscore_and%percent", "a_b c%d e\\f 한_글 x'y \"따옴표\"");
        note(&mut conn, &folder, "숫자 2026년 10월 08일", "3.14 1,000원 v2 iPhone15 第一 日本語");
        let tagged = note(&mut conn, &folder, "태그 노트", "본문");
        notes::set_tags(&mut conn, &tagged, vec!["여행".into(), "Busan".into()]).unwrap();
        let sourced = note(&mut conn, &folder, "출처 노트", "본문");
        crate::repo::sources::add_text(&mut conn, &sourced, "src.txt", "해운대 광안리\n\nSOURCE text").unwrap();
        // 검색 제외 폴더·휴지통은 두 쪽 다 빠져야 한다.
        let hidden_folder = folders::create(&mut conn, "숨김", Some(ws.clone()), None, None, None).unwrap().id;
        conn.execute("UPDATE folders SET search_excluded = 1 WHERE id = ?1", [&hidden_folder]).unwrap();
        note(&mut conn, &hidden_folder, "숨김 커피", "커피 여행");
        let gone = note(&mut conn, &folder, "지운 커피", "커피 여행");
        notes::delete(&mut conn, &gone).unwrap();
        // 시트 섹션(JSON 이 아니라 셀 값 TSV 가 notes_fts 본문에 들어간다).
        let sheet_note = note(&mut conn, &folder, "시트", "");
        let sheet_json = r#"{"v":1,"rows":10,"cols":[{"w":96},{"w":96}],"cells":{"A1":{"raw":"항목"},"B1":{"raw":"금액"},"A2":{"raw":"커피값"},"B2":{"raw":"4500"},"A3":{"raw":"Taxi"},"B3":{"raw":"=SUM(B2:B2)"}},"charts":[]}"#;
        crate::repo::sections::create_with_body_and_kind(
            &mut conn,
            &sheet_note,
            None,
            sheet_json.to_string(),
            Some(crate::repo::sheet::KIND.to_string()),
        )
        .unwrap();
        assert_bigram_equals_like(&conn, &ws);
        assert_fts_term_equals_note_id_read(&conn, &ws);
    }

    /// 예전 `fts_term_ids` 그대로(notes_fts.note_id 를 읽는다) — 매핑 표 경유가 같은 노트 집합을 내야 한다.
    fn fts_term_ids_oracle(conn: &Connection, ws: &str, term: &str) -> Vec<String> {
        let Some(mq) = search::build_match_query(term) else {
            return Vec::new();
        };
        let mut stmt = conn
            .prepare(
                "SELECT n.id FROM notes n
                 WHERE n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?1)
                   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?2 AND search_excluded = 0)
                   AND n.deleted_at IS NULL",
            )
            .unwrap();
        let rows = stmt.query_map(rusqlite::params![mq, ws], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    }

    /// 코퍼스의 모든 3글자 창(대소문자 바꾼 것·없는 낱말 포함)에 대해 매핑 표 경유 == note_id 직접 읽기.
    fn assert_fts_term_equals_note_id_read(conn: &Connection, ws: &str) {
        let mut terms: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut stmt = conn.prepare("SELECT title, body, source_body, tag_names FROM notes_fts").unwrap();
        let rows = stmt
            .query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?]))
            .unwrap();
        for cols in rows {
            for c in cols.unwrap() {
                for run in c.split(|ch: char| !ch.is_alphanumeric()) {
                    let chars: Vec<char> = run.chars().collect();
                    for w in chars.windows(3) {
                        let t: String = w.iter().collect();
                        terms.insert(t.to_uppercase());
                        terms.insert(t);
                    }
                }
            }
        }
        for extra in ["없는말", "zzz", "커피값만아"] {
            terms.insert(extra.to_string());
        }
        assert!(terms.len() > 50, "대조할 창이 충분해야: {}", terms.len());
        let mut nonempty = 0;
        for t in &terms {
            let a = sorted(fts_term_ids_oracle(conn, ws, t));
            let b = sorted(fts_term_ids(conn, ws, t).unwrap());
            nonempty += usize::from(!a.is_empty());
            assert_eq!(a, b, "3글자 {t:?}: note_id 직접 읽기와 매핑 표 경유가 다르다");
        }
        assert!(nonempty > 20, "실제로 맞는 창이 있어야: {nonempty}");
    }

    #[test]
    fn bigram_lookup_finds_two_char_terms_like_before() {
        let (mut conn, ws, folder) = setup();
        let a = note(&mut conn, &folder, "메모", "커피값만 아꼈다");
        let hits = bigram_terms_ids(&conn, &ws, &["피값".to_string(), "값만".to_string(), "커피".to_string()]).unwrap();
        for t in ["피값", "값만", "커피"] {
            assert_eq!(hits.get(t), Some(&vec![a.clone()]), "{t}");
        }
        // 구분자를 넘는 창은 없다(LIKE 에서도 "다 " 뒤로 이어지지 않는다).
        assert!(bigram_terms_ids(&conn, &ws, &["다커".to_string()]).unwrap().is_empty());
    }
}
