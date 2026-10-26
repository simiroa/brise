//! 자동화 코퍼스 L2 — 정합성 · 시드 · "등록되면 보인다" · 채팅 검색 기준선.
//!
//! docs/PLAN-2026-10-08-automation.md §13 의 L2 층. 정답지는 `tests/fixtures/automation/corpus.json`
//! (스키마·규칙 SSOT 는 같은 폴더 README.md). 이 파일은 **기존 공개 repo API 만** 부른다 — 아직 없는
//! 자동화 API 를 부르는 테스트는 빌드를 깨므로 금지(§13). 공개 API 가 없는 곳만 직접 SQL 이고, 그 자리마다
//! 이유를 적었다.
//!
//! 오너의 세 질문 중 이 파일이 다루는 것:
//! - ② 인사이트 화면에 등록되나 — AI 품질과 분리해서, **정답 메타를 넣으면** 타임라인·달력·지역(지도)·
//!   관계 그래프에 나타나는지를 고정한다(`gold_metadata_registers_on_insight_surfaces`).
//! - ③ 채팅이 찾나 — 지금 채팅 검색(`pet::rag_hits`, 프로덕션은 `commands/pet.rs` 에서 질문 원문을
//!   그대로 넘긴다)이 `qa` 근거를 몇 개 찾는지의 기준선(`chat_retrieval_baseline_report`, ignore).
//! ① 분류 품질은 `scripts/automation-eval/` 의 몫이다.

mod common;

use brise_lib::repo::note_query::{self, CoordsFilterSpec, NoteQuery, RegionFilterSpec};
use brise_lib::repo::{attachments, dashboard, folders, notes, pet, search, sections};
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, SecondsFormat, TimeZone, Utc};
use regex::{Captures, Regex};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

// ── 코퍼스 로더 ──────────────────────────────────────────────────────────────

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/automation")
}

fn corpus_raw() -> String {
    std::fs::read_to_string(fixture_dir().join("corpus.json")).expect("read corpus.json")
}

fn load_corpus() -> Value {
    serde_json::from_str(&corpus_raw()).expect("corpus.json is valid JSON")
}

/// 고정 기준 시각 — corpus.reference_now(2026-10-08 12:00 +09:00) 를 UTC 로. 테스트 시계는 이것뿐이다.
fn reference_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 8, 3, 0, 0).unwrap()
}

fn kst() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).unwrap()
}

/// repo 의 `util::now_iso()` 와 같은 모양(RFC3339 UTC, 밀리초, `Z`).
fn iso(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn created_at_of(note: &Value) -> DateTime<Utc> {
    let days = note["created_offset_days"].as_f64().expect("created_offset_days");
    reference_now() + Duration::milliseconds((days * 86_400_000.0).round() as i64)
}

fn updated_at_of(note: &Value) -> DateTime<Utc> {
    let min = note["updated_offset_min"].as_f64().expect("updated_offset_min");
    reference_now() + Duration::milliseconds((min * 60_000.0).round() as i64)
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// 문자열 하나(`contradicts`, `merge_with`) 또는 배열(`links`, `not_merge_with`) 또는 null/없음.
fn str_list(v: &Value, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Value::String(x)) => vec![x.clone()],
        Some(Value::Array(xs)) => xs.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

fn notes_of(corpus: &Value) -> &[Value] {
    arr(corpus, "notes")
}

fn note_by_id<'a>(corpus: &'a Value, cid: &str) -> &'a Value {
    notes_of(corpus)
        .iter()
        .find(|n| s(n, "id") == Some(cid))
        .unwrap_or_else(|| panic!("corpus note {cid} missing"))
}

/// `{{SECRET:kind}}` — 실행 중에 조각을 이어 붙인다. 소스에 토큰 모양 리터럴을 두면 푸시 보호에 걸린다
/// (README "비밀값 리터럴 금지"). Node 하네스(scripts/automation-eval)와 **같은 조립식**이어야 한다.
fn secret(kind: &str) -> String {
    match kind {
        "openai" => ["sk", "proj", "EVALFAKE0123456789abcdefghijklmnopqrstuvwxyzAB"].join("-"),
        "github" => "gh".to_owned() + "p_" + "EVALFAKE" + "0123456789abcdefghijklmnopqr",
        "aws" => "AK".to_owned() + "IA" + "EVALFAKEABCDEFGH",
        other => panic!("unknown secret kind in corpus: {other}"),
    }
}

/// 토큰 모양 탐지 정규식 — 패턴 자체도 조각으로 조립한다(소스 스캐너가 패턴을 토큰으로 오인하지 않게).
fn token_shape_regexes() -> Vec<(&'static str, Regex)> {
    let openai = format!(r"\b{}{}-[A-Za-z0-9_-]{{20,}}", "s", "k");
    let github = format!(r"\b{}{}_[A-Za-z0-9]{{30,}}", "g", "h[pousr]");
    let aws = format!(r"\b{}{}[0-9A-Z]{{16}}\b", "AK", "IA");
    vec![
        ("openai", Regex::new(&openai).unwrap()),
        ("github", Regex::new(&github).unwrap()),
        ("aws", Regex::new(&aws).unwrap()),
    ]
}

fn secret_re() -> Regex {
    Regex::new(r"\{\{SECRET:([a-z]+)\}\}").unwrap()
}

fn repeat_re() -> Regex {
    // 문장 안에 ':' 가 있어도 되도록 비탐욕 + 끝의 ":숫자}}" 로 닫는다.
    Regex::new(r"(?s)\{\{REPEAT:(.*?):(\d+)\}\}").unwrap()
}

fn link_re() -> Regex {
    Regex::new(r"\[\[([a-z]\d+)\]\]").unwrap()
}

/// SECRET·REPEAT 만 펼친다(`[[nXX]]` 는 그대로) — 링크 라벨 계산용.
fn expand_text(raw: &str) -> String {
    let with_secrets = secret_re().replace_all(raw, |c: &Captures| secret(&c[1])).into_owned();
    repeat_re()
        .replace_all(&with_secrets, |c: &Captures| {
            let n: usize = c[2].parse().expect("REPEAT count");
            c[1].repeat(n)
        })
        .into_owned()
}

/// 내부 링크의 표시 이름 = 대상 노트 제목. 코퍼스에는 제목 없는 노트(n02·n05·n16·n20·n22…)가 많고
/// `attachments::add_internal` 은 빈 이름을 거부하므로, 제목이 비면 대상 첫 섹션 첫 줄의 앞 20자를 쓴다
/// (그것도 비면 코퍼스 id). 본문의 `[[nXX]]` 치환도 같은 라벨을 쓴다.
fn link_labels(corpus: &Value) -> HashMap<String, String> {
    notes_of(corpus)
        .iter()
        .map(|n| {
            let cid = s(n, "id").unwrap().to_string();
            let title = s(n, "title").unwrap_or("").trim().to_string();
            let label = if !title.is_empty() {
                title
            } else {
                let body = arr(n, "sections")
                    .first()
                    .and_then(|sec| s(sec, "body"))
                    .map(expand_text)
                    .unwrap_or_default();
                let head: String = body.lines().next().unwrap_or("").chars().take(20).collect();
                let head = head.trim().to_string();
                if head.is_empty() { cid.clone() } else { head }
            };
            (cid, label)
        })
        .collect()
}

fn expand_body(raw: &str, labels: &HashMap<String, String>) -> String {
    let text = expand_text(raw);
    link_re()
        .replace_all(&text, |c: &Captures| {
            labels.get(&c[1]).cloned().unwrap_or_else(|| panic!("[[{}]] target missing", &c[1]))
        })
        .into_owned()
}

/// HTML 원본 비교용 — 숫자 엔티티를 풀고 보이지 않는 문자(zero-width·bidi·BOM)를 지운다.
fn strip_invisible_html(html: &str) -> String {
    let ent = Regex::new(r"&#(x[0-9A-Fa-f]+|[0-9]+);").unwrap();
    let decoded = ent.replace_all(html, |c: &Captures| {
        let raw = &c[1];
        let code = if let Some(hex) = raw.strip_prefix('x') {
            u32::from_str_radix(hex, 16).ok()
        } else {
            raw.parse::<u32>().ok()
        };
        code.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    let named = decoded
        .replace("&zwj;", "")
        .replace("&zwnj;", "")
        .replace("&lrm;", "")
        .replace("&rlm;", "");
    named
        .chars()
        .filter(|ch| {
            let c = *ch as u32;
            !((0x200B..=0x200F).contains(&c)
                || (0x202A..=0x202E).contains(&c)
                || (0x2060..=0x2064).contains(&c)
                || c == 0xFEFF)
        })
        .collect()
}

// ── 시드 ─────────────────────────────────────────────────────────────────────

struct Seeded {
    ctx: common::Ctx,
    corpus: Value,
    ws: String,
    /// 코퍼스 폴더 key → DB folder id
    folder_ids: HashMap<String, String>,
    /// 코퍼스 노트 id → DB note id
    ids: HashMap<String, String>,
    /// DB note id → 코퍼스 노트 id
    rev: HashMap<String, String>,
    labels: HashMap<String, String>,
}

impl Seeded {
    fn id(&self, cid: &str) -> String {
        self.ids.get(cid).cloned().unwrap_or_else(|| panic!("corpus note {cid} was not seeded"))
    }
    fn cid(&self, db_id: &str) -> String {
        self.rev.get(db_id).cloned().unwrap_or_else(|| "?".to_string())
    }
}

/// 코퍼스 전체를 부트스트랩된 임시 DB 의 활성 노트북에 심는다(정답 메타는 **넣지 않는다** — 그건
/// test 3 의 일). 순서: 폴더 → 노트·섹션 → `[[nXX]]` 내부 링크 → 시각(맨 마지막: 섹션·링크 쓰기가
/// 모두 updated_at 을 벽시계로 올리므로).
fn seed() -> Seeded {
    let mut ctx = common::setup();
    let corpus = load_corpus();
    let labels = link_labels(&corpus);
    let conn: &mut Connection = &mut ctx.conn;
    let ws = folders::active_workspace_id(conn).unwrap();

    // 폴더. role·collect·user_locked 는 아직 저장할 칸이 없다(PLAN §4 의 미래 테이블) — 무시.
    let mut folder_ids = HashMap::new();
    for f in arr(&corpus, "folders") {
        let key = s(f, "key").unwrap();
        let name = s(f, "name").unwrap();
        let rules = s(f, "rules").map(str::to_string);
        let id = if key == "inbox" {
            // 노트북의 진짜 Inbox(settings `inbox_<ws>`)에 붙이고 이름만 코퍼스대로 바꾼다.
            let id = folders::ensure_inbox_folder_id(conn, &ws).unwrap();
            folders::rename(conn, &id, name).unwrap();
            folders::set_rules(conn, &id, rules).unwrap();
            id
        } else {
            folders::create(conn, name, Some(ws.clone()), None, None, rules).unwrap().id
        };
        let search_excluded = f.get("search_excluded").and_then(Value::as_bool).unwrap_or(false);
        let ai_excluded = f.get("ai_excluded_default").and_then(Value::as_bool).unwrap_or(false);
        if search_excluded || ai_excluded {
            folders::set_exclusions(conn, &id, search_excluded, ai_excluded).unwrap();
        }
        folder_ids.insert(key.to_string(), id);
    }

    // 노트·섹션. note_create 와 같은 단일 경유지(`create_today_default`)로 만들고, 사건 날짜 기본값은
    // 앱과 같은 규칙("말 안 했으면 만든 날")을 **코퍼스 시계로** 재현한다 — 생성 시각의 KST 날짜.
    // 섹션 role 은 아직 저장 칸이 없다(미래 테이블) — 무시. source_url 은 본문의 [출처] 링크로 이미
    // 들어 있어 첨부로 따로 심지 않는다.
    let mut ids = HashMap::new();
    let mut rev = HashMap::new();
    for n in notes_of(&corpus) {
        let cid = s(n, "id").unwrap();
        let folder_key = s(n, "folder").unwrap();
        let folder_id = &folder_ids[folder_key];
        let day: NaiveDate = created_at_of(n).with_timezone(&kst()).date_naive();
        let detail = notes::create_today_default(
            conn,
            folder_id,
            Some(s(n, "title").unwrap_or("").to_string()),
            Some(day.year() as i64),
            Some(day.month() as i64),
            Some(day.day() as i64),
        )
        .unwrap();
        let note_id = detail.note.id.clone();
        for (i, sec) in arr(n, "sections").iter().enumerate() {
            let name = s(sec, "name").unwrap().to_string();
            let body = expand_body(s(sec, "body").unwrap(), &labels);
            let ai_origin = s(sec, "ai_origin").map(str::to_string);
            if i == 0 {
                // 기본으로 생긴 첫 섹션을 코퍼스 첫 섹션으로 채운다(빈 섹션이 남지 않게).
                sections::update(conn, &detail.sections[0].id, Some(name), Some(body), Some(ai_origin)).unwrap();
            } else {
                sections::create_with_body_and_kind_and_origin(conn, &note_id, Some(name), body, None, ai_origin)
                    .unwrap();
            }
        }
        ids.insert(cid.to_string(), note_id.clone());
        rev.insert(note_id, cid.to_string());
    }

    // `[[nXX]]` → 내부 링크 첨부(관계 그래프의 연결선은 이것에서만 생긴다).
    for n in notes_of(&corpus) {
        let src = &ids[s(n, "id").unwrap()];
        let mut seen = HashSet::new();
        for sec in arr(n, "sections") {
            for c in link_re().captures_iter(s(sec, "body").unwrap()) {
                let tgt = c[1].to_string();
                if seen.insert(tgt.clone()) {
                    attachments::add_internal(conn, src, &ids[&tgt], &labels[&tgt]).unwrap();
                }
            }
        }
    }

    // 시각. 생성·수정 시각을 덮어쓰는 공개 API 가 없다(`create_with_timestamp` 는 pub(crate),
    // 모든 쓰기 경로는 now_iso 로 찍는다) — 그래서 직접 UPDATE. 섹션 updated_at 도 노트의 수정 시각에
    // 맞춘다(편집 중 판정 R5 가 섹션 시각을 볼 수 있으므로).
    for n in notes_of(&corpus) {
        let id = &ids[s(n, "id").unwrap()];
        let created = iso(created_at_of(n));
        let updated = iso(updated_at_of(n));
        conn.execute(
            "UPDATE notes SET created_at=?1, updated_at=?2 WHERE id=?3",
            params![created, updated, id],
        )
        .unwrap();
        conn.execute("UPDATE sections SET updated_at=?1 WHERE note_id=?2", params![updated, id])
            .unwrap();
    }

    Seeded { ctx, corpus, ws, folder_ids, ids, rev, labels }
}

/// 첫 섹션부터 이어 붙인 본문(테스트 검증용).
fn joined_body(conn: &Connection, note_id: &str) -> String {
    sections::load_for_note(conn, note_id)
        .unwrap()
        .into_iter()
        .map(|sec| sec.body_md)
        .collect::<Vec<_>>()
        .join("\n")
}

// ── 1. 정합성 ────────────────────────────────────────────────────────────────

#[test]
fn corpus_references_are_consistent() {
    let raw = corpus_raw();
    let corpus = load_corpus();

    assert_eq!(corpus["version"].as_i64(), Some(1), "corpus version");
    let reference = DateTime::parse_from_rfc3339(s(&corpus, "reference_now").unwrap()).unwrap();
    assert_eq!(reference.with_timezone(&Utc), reference_now(), "reference_now must equal the test clock");

    // 고유 id
    let mut folder_keys = HashSet::new();
    for f in arr(&corpus, "folders") {
        assert!(folder_keys.insert(s(f, "key").unwrap().to_string()), "duplicate folder key {:?}", f["key"]);
        assert!(!s(f, "name").unwrap().trim().is_empty(), "folder {:?} has an empty name", f["key"]);
    }
    let mut topic_ids = HashSet::new();
    for t in arr(&corpus, "topics") {
        assert!(topic_ids.insert(s(t, "id").unwrap().to_string()), "duplicate topic {:?}", t["id"]);
    }
    let mut note_ids = HashSet::new();
    let mut split_of = HashMap::new();
    for n in notes_of(&corpus) {
        let id = s(n, "id").unwrap().to_string();
        assert!(note_ids.insert(id.clone()), "duplicate note id {id}");
        split_of.insert(id, s(n, "split").unwrap_or("").to_string());
    }
    let mut qa_ids = HashSet::new();
    for q in arr(&corpus, "qa") {
        assert!(qa_ids.insert(s(q, "id").unwrap().to_string()), "duplicate qa id {:?}", q["id"]);
    }

    let splits = ["dev", "holdout"];
    let time_re = Regex::new(r"^\d{2}:\d{2}$").unwrap();
    let secret_kinds = ["openai", "github", "aws"];
    let html_dir = fixture_dir().join("html");
    let mut referenced_html = HashSet::new();

    for n in notes_of(&corpus) {
        let id = s(n, "id").unwrap();
        assert!(splits.contains(&s(n, "split").unwrap_or("")), "{id}: split must be dev|holdout");
        assert!(folder_keys.contains(s(n, "folder").unwrap_or("")), "{id}: unknown start folder");
        assert!(!arr(n, "sections").is_empty(), "{id}: needs at least one section");
        assert!(n["created_offset_days"].is_number() && n["updated_offset_min"].is_number(), "{id}: offsets");
        let gold = n.get("gold").unwrap_or_else(|| panic!("{id}: gold missing"));

        if let Some(gf) = s(gold, "folder") {
            assert!(folder_keys.contains(gf), "{id}: gold.folder {gf} unknown");
        }
        if let Some(t) = s(gold, "topic") {
            assert!(topic_ids.contains(t), "{id}: gold.topic {t} unknown");
        }
        for t in str_list(gold, "topic_any") {
            assert!(topic_ids.contains(&t), "{id}: gold.topic_any {t} unknown");
        }
        for key in ["links", "not_merge_with", "merge_with", "contradicts"] {
            for r in str_list(gold, key) {
                assert!(note_ids.contains(&r), "{id}: gold.{key} -> {r} does not exist");
                assert_ne!(r, id, "{id}: gold.{key} points at itself");
            }
        }
        for fam in arr(gold, "tags_any") {
            let fam = fam.as_array().unwrap_or_else(|| panic!("{id}: tags_any family must be an array"));
            assert!(!fam.is_empty(), "{id}: empty tags_any family");
        }
        if let Some(date) = gold.get("date").filter(|d| !d.is_null()) {
            assert!(date["year"].is_i64(), "{id}: gold.date.year");
            let month = date["month"].as_i64();
            let day = date["day"].as_i64();
            if let Some(m) = month {
                assert!((1..=12).contains(&m), "{id}: gold.date.month");
            }
            assert!(day.is_none() || month.is_some(), "{id}: gold.date.day without month");
            if let Some(t) = s(date, "time") {
                assert!(time_re.is_match(t), "{id}: gold.date.time must be HH:MM");
                assert!(day.is_some(), "{id}: gold.date.time requires day precision");
            }
            if let Some(end) = date.get("end").filter(|e| !e.is_null()) {
                assert!(end["year"].is_i64(), "{id}: gold.date.end.year");
            }
        }
        if let Some(canary) = s(gold, "canary") {
            assert_eq!(gold["suspicious"].as_bool(), Some(true), "{id}: canary implies suspicious");
            let body: String = arr(n, "sections").iter().filter_map(|sec| s(sec, "body")).collect();
            assert!(body.contains(canary), "{id}: worst-case body must carry its canary");
        }
        if let Some(rel) = s(n, "html") {
            referenced_html.insert(rel.trim_start_matches("html/").to_string());
            let path = fixture_dir().join(rel);
            let html = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{id}: html {rel} missing"));
            let canary = s(gold, "canary").unwrap_or_else(|| panic!("{id}: html source without gold.canary"));
            assert!(
                strip_invisible_html(&html).contains(canary),
                "{id}: {rel} must contain the canary once invisible chars/entities are stripped"
            );
        }

        // 본문 자리표시자
        let mut placeholder_secrets = 0;
        let mut emails = 0;
        let email_re = Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+").unwrap();
        for sec in arr(n, "sections") {
            let body = s(sec, "body").unwrap();
            for c in secret_re().captures_iter(body) {
                assert!(secret_kinds.contains(&&c[1]), "{id}: unknown SECRET kind");
                placeholder_secrets += 1;
            }
            for c in link_re().captures_iter(body) {
                assert!(note_ids.contains(&c[1]), "{id}: [[{}]] target missing", &c[1]);
            }
            emails += email_re.find_iter(body).count();
            let expanded = expand_text(body);
            assert!(!expanded.contains("{{"), "{id}: unexpanded placeholder remains");
        }
        if let Some(expected) = gold["secrets"].as_i64() {
            assert_eq!(
                (placeholder_secrets + emails) as i64,
                expected,
                "{id}: gold.secrets must equal SECRET placeholders + emails in the body"
            );
        }
        if n["long"].as_bool() == Some(true) {
            let body: String = arr(n, "sections").iter().filter_map(|sec| s(sec, "body")).collect();
            assert!(repeat_re().is_match(&body), "{id}: long note must use {{{{REPEAT:…}}}}");
        }
    }

    // 엇갈림은 양쪽 노트의 gold.contradicts 와 서로 맞물려야 한다.
    for c in arr(&corpus, "contradictions") {
        let cid = s(c, "id").unwrap();
        assert!(topic_ids.contains(s(c, "topic").unwrap()), "{cid}: unknown topic");
        let pair = str_list(c, "notes");
        assert_eq!(pair.len(), 2, "{cid}: exactly two notes");
        for r in &pair {
            assert!(note_ids.contains(r), "{cid}: note {r} missing");
        }
        let a = note_by_id(&corpus, &pair[0]);
        let b = note_by_id(&corpus, &pair[1]);
        assert_eq!(str_list(&a["gold"], "contradicts"), vec![pair[1].clone()], "{cid}: {} gold.contradicts", pair[0]);
        assert_eq!(str_list(&b["gold"], "contradicts"), vec![pair[0].clone()], "{cid}: {} gold.contradicts", pair[1]);
    }

    for q in arr(&corpus, "qa") {
        let qid = s(q, "id").unwrap();
        let split = s(q, "split").unwrap_or("");
        assert!(splits.contains(&split), "{qid}: split");
        assert!(!s(q, "question").unwrap_or("").trim().is_empty(), "{qid}: empty question");
        let gold_notes = str_list(q, "gold_notes");
        for r in gold_notes.iter().chain(str_list(q, "must_not_cite").iter()) {
            assert!(note_ids.contains(r), "{qid}: note {r} missing");
        }
        if q["answerable"].as_bool() == Some(false) {
            assert!(gold_notes.is_empty(), "{qid}: unanswerable question must have no gold notes");
        }
        if split == "dev" {
            // dev 로 프롬프트를 다듬으므로 dev 질문이 holdout 노트를 근거로 삼으면 holdout 이 샌다.
            for r in &gold_notes {
                assert_eq!(split_of[r], "dev", "{qid}: dev question cites holdout note {r}");
            }
        }
    }

    // html/ 의 모든 원본은 어떤 노트가 참조해야 한다(고아 원본 금지).
    for entry in std::fs::read_dir(&html_dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(referenced_html.contains(&name), "html/{name} is not referenced by any note");
    }

    // 원문 corpus.json 에 토큰 모양 리터럴이 없어야 한다. 탐지기가 헛돌지 않는지 조립한 가짜 토큰으로
    // 먼저 확인한다.
    for (kind, re) in token_shape_regexes() {
        assert!(re.is_match(&secret(kind)), "token detector {kind} must match the constructed fake");
        assert!(!re.is_match(&raw), "corpus.json contains a {kind}-shaped token literal");
    }
    let email_re = Regex::new(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)").unwrap();
    for c in email_re.captures_iter(&raw) {
        assert_eq!(&c[1], "example.com", "corpus emails must use example.com only");
    }
}

// ── 2. 시드 ──────────────────────────────────────────────────────────────────

#[test]
fn corpus_seeds_with_existing_repo_apis() {
    let sd = seed();
    let conn = &sd.ctx.conn;

    // 폴더별 노트 수
    let list = folders::list(conn, Some(sd.ws.clone())).unwrap();
    let mut expected: BTreeMap<String, usize> = BTreeMap::new();
    for n in notes_of(&sd.corpus) {
        *expected.entry(s(n, "folder").unwrap().to_string()).or_default() += 1;
    }
    for f in arr(&sd.corpus, "folders") {
        let key = s(f, "key").unwrap();
        let fid = &sd.folder_ids[key];
        let got = list.notes_by_folder.get(fid).map(Vec::len).unwrap_or(0);
        assert_eq!(got, expected.get(key).copied().unwrap_or(0), "note count in folder {key}");
        let row = list.folders.iter().find(|x| &x.id == fid).expect("folder listed");
        assert_eq!(row.name, s(f, "name").unwrap(), "folder {key} name");
        assert_eq!(
            row.search_excluded,
            f.get("search_excluded").and_then(Value::as_bool).unwrap_or(false),
            "folder {key} search_excluded"
        );
    }
    assert_eq!(sd.ids.len(), notes_of(&sd.corpus).len(), "every corpus note seeded");

    // ai_origin 보존 — n36 요약은 사람이 고쳐 None, 기록은 automation. n35 는 둘 다 automation.
    let n36 = sections::load_for_note(conn, &sd.id("n36")).unwrap();
    assert_eq!(n36.len(), 2, "n36 sections");
    assert_eq!(n36[0].name, "요약");
    assert_eq!(n36[0].ai_origin, None, "n36 summary was edited by a human");
    assert_eq!(n36[1].ai_origin.as_deref(), Some("automation"), "n36 log is AI-written");
    let n35 = sections::load_for_note(conn, &sd.id("n35")).unwrap();
    assert_eq!(n35.len(), 2, "n35 sections");
    assert!(n35.iter().all(|sec| sec.ai_origin.is_some()), "n35 sections keep ai_origin");

    // 시각 — n06 은 기준 3분 전에 고쳐졌다(R5 편집 중).
    let n06 = notes::note_summary(conn, &sd.id("n06")).unwrap();
    assert_eq!(n06.updated_at, "2026-10-08T02:57:00.000Z", "n06 updated_at");
    assert_eq!(n06.created_at, "2026-10-08T02:45:36.000Z", "n06 created_at (-0.01 day)");
    let updated_sections = sections::load_for_note(conn, &sd.id("n06")).unwrap();
    assert_eq!(updated_sections[0].updated_at.as_deref(), Some("2026-10-08T02:57:00.000Z"), "n06 section updated_at");
    // 사건 날짜 기본값 = 생성일(KST). n01 은 9일 전 = 09-29.
    let n01 = notes::note_summary(conn, &sd.id("n01")).unwrap();
    assert_eq!((n01.year, n01.month, n01.day), (2026, Some(9), Some(29)), "n01 default event date = creation day");

    // 비밀값·반복 펼침
    let n28 = joined_body(conn, &sd.id("n28"));
    assert!(n28.contains(&secret("github")), "n28 body carries the constructed github token");
    assert!(n28.contains(&secret("openai")), "n28 body carries the constructed openai key");
    let h09 = joined_body(conn, &sd.id("h09"));
    assert!(h09.contains(&secret("aws")), "h09 body carries the constructed aws key");
    let n34 = joined_body(conn, &sd.id("n34"));
    assert!(n34.chars().count() > 15_000, "n34 REPEAT expanded to a long body ({} chars)", n34.chars().count());
    for cid in sd.ids.keys() {
        let body = joined_body(conn, &sd.id(cid));
        assert!(!body.contains("{{") && !body.contains("[["), "{cid}: placeholder left in seeded body");
    }

    // [[nXX]] → 내부 링크 + 본문엔 라벨
    let internal_targets = |cid: &str| -> Vec<String> {
        attachments::load_for_note(conn, &sd.id(cid))
            .unwrap()
            .into_iter()
            .filter(|a| a.kind == "internal")
            .filter_map(|a| a.url)
            .map(|u| sd.cid(&u))
            .collect()
    };
    assert_eq!(internal_targets("n35"), vec!["n01", "n05"], "n35 internal links");
    assert_eq!(internal_targets("n36"), vec!["n07"], "n36 internal links");
    let n35_log = joined_body(conn, &sd.id("n35"));
    assert!(n35_log.contains(&sd.labels["n01"]) && n35_log.contains(&sd.labels["n05"]), "n35 log names its targets");
}

// ── 3. 등록되면 보인다 ───────────────────────────────────────────────────────

/// 지도는 좌표가 있어야 그린다(`note_query` 의 `HasCoords`/`Bbox`, `region_registry` 의 대표 지역도
/// lat/lng NOT NULL). 코퍼스는 지역 **이름**만 갖고, 앱에서 좌표는 지오코딩(네트워크, async) 또는 AI 의
/// lat/lng 제안에서 온다 — 테스트는 네트워크를 타지 않으므로 고정 좌표를 쓴다.
const REGION_COORDS: &[(&str, f64, f64)] = &[
    ("서울", 37.5665, 126.9780),
    ("부산", 35.1796, 129.0756),
    ("제주", 33.4996, 126.5312),
];

fn coords_for(region: &str) -> (f64, f64) {
    REGION_COORDS
        .iter()
        .find(|(name, _, _)| *name == region)
        .map(|(_, lat, lng)| (*lat, *lng))
        .unwrap_or_else(|| panic!("no test coordinate for gold region {region}"))
}

struct GoldDate {
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    time: Option<String>,
    end: Option<(i64, Option<i64>, Option<i64>)>,
}

fn gold_date(gold: &Value) -> Option<GoldDate> {
    let d = gold.get("date").filter(|d| !d.is_null())?;
    Some(GoldDate {
        year: d["year"].as_i64().unwrap(),
        month: d["month"].as_i64(),
        day: d["day"].as_i64(),
        time: s(d, "time").map(str::to_string),
        end: d.get("end").filter(|e| !e.is_null()).map(|e| {
            (e["year"].as_i64().unwrap(), e["month"].as_i64(), e["day"].as_i64())
        }),
    })
}

fn query_ids(conn: &Connection, q: NoteQuery) -> HashSet<String> {
    note_query::query(conn, q).unwrap().notes.into_iter().map(|n| n.id).collect()
}

#[test]
fn gold_metadata_registers_on_insight_surfaces() {
    let mut sd = seed();
    let ws = sd.ws.clone();
    let corpus = sd.corpus.clone();

    // ── 정답 메타 적용(기존 API 만) ──
    let mut tagged: Vec<(String, Vec<String>)> = Vec::new();
    let mut dated: Vec<(String, GoldDate)> = Vec::new();
    let mut regioned: Vec<(String, String)> = Vec::new();
    let mut linked: Vec<(String, String)> = Vec::new();
    let region_only_registry: Vec<String>;
    {
        let conn = &mut sd.ctx.conn;
        for n in notes_of(&corpus) {
            let cid = s(n, "id").unwrap().to_string();
            let id = sd.ids[&cid].clone();
            let gold = &n["gold"];

            // 태그: tags_any 묶음마다 첫 동의어.
            let tags: Vec<String> = arr(gold, "tags_any")
                .iter()
                .filter_map(|fam| fam.as_array()?.first()?.as_str().map(str::to_string))
                .collect();
            if !tags.is_empty() {
                notes::set_tags(conn, &id, tags.clone()).unwrap();
                tagged.push((cid.clone(), tags));
            }

            // 날짜: 대표(position 0) 행을 note_date_update 한 번으로 — 연·월·일·기간·시각을 함께 검증·저장.
            if let Some(g) = gold_date(gold) {
                let row0 = notes::dates_list(conn, &id)
                    .unwrap()
                    .into_iter()
                    .find(|d| d.position == 0)
                    .unwrap_or_else(|| panic!("{cid}: no representative date row"));
                let (ey, em, ed) = match g.end {
                    Some((y, m, d)) => (Some(y), m, d),
                    None => (None, None, None),
                };
                notes::date_update(
                    conn, &row0.id, g.year, g.month, g.day, ey, em, ed, g.time.clone(), None, false, None, None, None,
                )
                .unwrap_or_else(|e| panic!("{cid}: date_update failed: {e}"));
                dated.push((cid.clone(), g));
            }

            // 지역: 이름 → 좌표(지도에 그리려면 둘 다 필요).
            if let Some(region) = s(gold, "region") {
                notes::set_region(conn, &id, Some(region.to_string())).unwrap();
                regioned.push((cid.clone(), region.to_string()));
            }

            // 관계: gold.links → 내부 링크(이미 있으면 다시 만들지 않는다).
            for tgt in str_list(gold, "links") {
                let tgt_id = sd.ids[&tgt].clone();
                let exists = attachments::load_for_note(conn, &id)
                    .unwrap()
                    .iter()
                    .any(|a| a.kind == "internal" && a.url.as_deref() == Some(tgt_id.as_str()));
                if !exists {
                    attachments::add_internal(conn, &id, &tgt_id, &sd.labels[&tgt]).unwrap();
                }
                linked.push((cid.clone(), tgt));
            }
        }

        // 관찰(단정하지 않음): 이름만 넣은 상태에서 지역 레지스트리에 무엇이 보이나.
        region_only_registry = notes::region_registry(conn, Some(ws.clone()))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();

        for (cid, region) in &regioned {
            let (lat, lng) = coords_for(region);
            notes::set_location(conn, &sd.ids[cid], Some(lat), Some(lng)).unwrap();
        }
    }
    println!(
        "[관찰] 지역 이름만 넣었을 때 region_registry = {:?} (좌표 없는 대표 지역은 레지스트리·지도에 안 보인다)",
        region_only_registry
    );

    let conn = &sd.ctx.conn;
    assert!(!dated.is_empty() && !regioned.is_empty() && !linked.is_empty() && !tagged.is_empty());

    // ── 태그: 노트 요약 + 사이드바 태그 필터 ──
    for (cid, tags) in &tagged {
        let id = sd.id(cid);
        let summary = notes::note_summary(conn, &id).unwrap();
        for t in tags {
            assert!(summary.tag_names.contains(t), "{cid}: tag {t} not on the note");
            let hits = query_ids(
                conn,
                NoteQuery { workspace_id: Some(ws.clone()), tags: vec![t.clone()], limit: Some(1000), ..Default::default() },
            );
            assert!(hits.contains(&id), "{cid}: tag filter {t} does not return the note");
        }
    }

    // ── 날짜: 타임라인(연도) + 달력(월, 시각) ──
    for (cid, g) in &dated {
        let id = sd.id(cid);
        let tl = dashboard::timeline(conn, &ws, g.year, g.year).unwrap();
        assert!(!tl.capped, "timeline capped — corpus is far below the cap");
        let item = tl
            .items
            .iter()
            .find(|i| i.note_id == id)
            .unwrap_or_else(|| panic!("{cid}: missing from timeline {}", g.year));
        assert_eq!((item.year, item.month, item.day), (g.year, g.month, g.day), "{cid}: timeline date");
        match g.end {
            Some((ey, em, ed)) => {
                assert_eq!(item.kind, "bar", "{cid}: a ranged event is a timeline bar");
                assert_eq!((item.end_year, item.end_month, item.end_day), (Some(ey), em, ed), "{cid}: timeline end");
            }
            None => assert_eq!(item.kind, "point", "{cid}: a single date is a timeline point"),
        }

        // 연도만(h05 '내년 봄' = 2027, 월 미정): 달력은 연도 전체(1~12월)에 깐다 — 1월로 확인.
        let cal_month = g.month.unwrap_or(1);
        let cal = dashboard::calendar(conn, &ws, g.year, cal_month).unwrap();
        let items: Vec<_> = cal.items.iter().filter(|i| i.note_id == id).collect();
        assert_eq!(items.len(), 1, "{cid}: calendar {}-{cal_month:02} should list the note once", g.year);
        let it = items[0];
        assert_eq!((it.year, it.month, it.day), (g.year, g.month, g.day), "{cid}: calendar date");
        assert_eq!(it.start_time, g.time, "{cid}: calendar time");
        match (g.month, g.day, g.end) {
            (Some(m), Some(d), None) => {
                assert_eq!(it.kind, "event", "{cid}: single day is an event");
                assert_eq!(it.span_start, format!("{:04}-{:02}-{:02}", g.year, m, d), "{cid}: calendar day");
            }
            (Some(m), Some(d), Some((ey, Some(em), Some(ed)))) => {
                assert_eq!(it.kind, "span", "{cid}: ranged event is a span");
                assert_eq!(it.span_start, format!("{:04}-{:02}-{:02}", g.year, m, d), "{cid}: span start");
                assert_eq!(it.span_end, format!("{:04}-{:02}-{:02}", ey, em, ed), "{cid}: span end");
            }
            (None, None, None) => {
                assert_eq!(it.kind, "span", "{cid}: year-only date spans the month");
                assert_eq!(it.span_start, format!("{:04}-01-01", g.year), "{cid}: year-only span start");
            }
            other => panic!("{cid}: unhandled gold.date shape {other:?}"),
        }
    }

    // ── 지역: 노트 요약 + 지역 필터 + 지도(좌표) + 지역 레지스트리 ──
    let registry = notes::region_registry(conn, Some(ws.clone())).unwrap();
    let located = query_ids(
        conn,
        NoteQuery { workspace_id: Some(ws.clone()), coords: CoordsFilterSpec::HasCoords, limit: Some(1000), ..Default::default() },
    );
    for (cid, region) in &regioned {
        let id = sd.id(cid);
        let summary = notes::note_summary(conn, &id).unwrap();
        assert_eq!(summary.region.as_deref(), Some(region.as_str()), "{cid}: region on note");
        let by_region = query_ids(
            conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                region: RegionFilterSpec::Eq(region.clone()),
                limit: Some(1000),
                ..Default::default()
            },
        );
        assert!(by_region.contains(&id), "{cid}: region filter {region} does not return the note");
        assert!(located.contains(&id), "{cid}: not on the map (HasCoords)");
        let (lat, lng) = coords_for(region);
        let bbox = query_ids(
            conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                coords: CoordsFilterSpec::Bbox { min_lat: lat - 0.5, max_lat: lat + 0.5, min_lng: lng - 0.5, max_lng: lng + 0.5 },
                limit: Some(1000),
                ..Default::default()
            },
        );
        assert!(bbox.contains(&id), "{cid}: not inside the {region} map viewport");
        let entry = registry
            .iter()
            .find(|e| e.name == *region)
            .unwrap_or_else(|| panic!("{cid}: region {region} missing from region_registry"));
        assert_eq!((entry.lat, entry.lng), (lat, lng), "{cid}: registry coordinate for {region}");
    }

    // ── 관계: gold.links 는 그래프의 backlink 연결선 ──
    let graph = dashboard::graph(conn, &ws, None).unwrap();
    assert!(!graph.capped && !graph.edges_capped, "graph capped — corpus is far below the caps");
    let node_ids: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    let backlinks: HashSet<(String, String)> = graph
        .edges
        .iter()
        .filter(|e| e.kind == "backlink")
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    for (src, tgt) in &linked {
        let (a, b) = (sd.id(src), sd.id(tgt));
        assert!(node_ids.contains(a.as_str()) && node_ids.contains(b.as_str()), "{src}/{tgt}: graph nodes");
        assert!(backlinks.contains(&(a, b)), "{src} -> {tgt}: missing backlink edge in dashboard_graph");
    }
    println!(
        "[관찰] graph: nodes={} edges={} (backlink={}, related={})",
        graph.nodes.len(),
        graph.edges.len(),
        backlinks.len(),
        graph.edges.iter().filter(|e| e.kind == "related").count()
    );
}

// ── 4. 채팅 검색: 정확한 키워드 ──────────────────────────────────────────────

#[test]
fn chat_retrieval_finds_exact_keyword_note() {
    let sd = seed();
    let hits = pet::rag_hits(&sd.ctx.conn, &sd.ws, "치과", 5);
    let ids: Vec<String> = hits.iter().map(|h| sd.cid(&h.note_id)).collect();
    assert!(ids.iter().any(|c| c == "n22"), "rag_hits(\"치과\") should find n22, got {ids:?}");

    // 2글자는 2글자 색인(notes_bigram)이다. 3글자 이상 토큰의 FTS MATCH 경로도 시드된 행에서 살아 있는지 —
    // 기준선(test 5)의 0 이 색인 문제가 아니라 질문 모양 탓임을 가르기 위한 확인.
    let fts: Vec<String> =
        pet::rag_hits(&sd.ctx.conn, &sd.ws, "로컬퍼스트", 5).iter().map(|h| sd.cid(&h.note_id)).collect();
    assert!(
        fts.iter().any(|c| c == "n07") && fts.iter().any(|c| c == "n34"),
        "rag_hits(\"로컬퍼스트\") should find n07 and n34 via FTS, got {fts:?}"
    );
}

/// 2글자 색인(V94, specs/db/schemas/fts_bigram.sql) == 예전 LIKE 스캔 — 시드된 코퍼스의 모든 2글자 창에 대해
/// 같은 작업 공간·검색 제외·휴지통 필터로 같은 노트 집합을 내야 한다(HANDOFF-2026-10-08 Wave B 등가성).
#[test]
fn two_char_index_equals_like_scan_on_corpus() {
    let sd = seed();
    let conn = &sd.ctx.conn;
    let mut grams: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    {
        let mut stmt = conn.prepare("SELECT title, body, source_body, tag_names FROM notes_fts").unwrap();
        let rows = stmt
            .query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?]))
            .unwrap();
        for cols in rows {
            for c in cols.unwrap() {
                brise_lib::repo::fts::bigrams_into(&c, &mut grams);
            }
        }
    }
    assert!(grams.len() > 500, "코퍼스의 2글자 창이 너무 적다: {}", grams.len());
    let filter = "n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?2 AND search_excluded = 0)
                  AND n.deleted_at IS NULL";
    let mut like = conn
        .prepare(&format!(
            "SELECT f.note_id FROM notes_fts f JOIN notes n ON n.id = f.note_id
             WHERE (f.title LIKE ?1 OR f.body LIKE ?1 OR f.source_body LIKE ?1 OR f.tag_names LIKE ?1)
               AND {filter}"
        ))
        .unwrap();
    let mut idx = conn
        .prepare(&format!(
            "SELECT n.id FROM notes_bigram b JOIN notes_bigram_map m ON m.id = b.rowid
             JOIN notes n ON n.id = m.note_id WHERE notes_bigram MATCH ?1 AND {filter}"
        ))
        .unwrap();
    let mut nonempty = 0;
    for g in &grams {
        let a: std::collections::BTreeSet<String> = like
            .query_map(params![format!("%{g}%"), sd.ws], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let b: std::collections::BTreeSet<String> = idx
            .query_map(params![format!("\"{g}\""), sd.ws], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(a, b, "2글자 {g:?}: LIKE 와 색인이 다르다");
        nonempty += usize::from(!a.is_empty());
    }
    assert!(nonempty > 500, "대조가 실제 매치를 담아야 한다: {nonempty}");
}

/// 3글자 이상 경로(V95): trigram MATCH 의 rowid → 매핑 표로 찾은 노트 == notes_fts.note_id 를 직접 읽은 노트 —
/// 시드된 코퍼스의 모든 3글자 창에 대해, 같은 필터로.
#[test]
fn three_char_lookup_via_map_equals_note_id_read_on_corpus() {
    let sd = seed();
    let conn = &sd.ctx.conn;
    let mut terms: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    {
        let mut stmt = conn.prepare("SELECT title, body, source_body, tag_names FROM notes_fts").unwrap();
        let rows = stmt
            .query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?]))
            .unwrap();
        for cols in rows {
            for c in cols.unwrap() {
                for run in c.split(|ch: char| !ch.is_alphanumeric()) {
                    let chars: Vec<char> = run.chars().collect();
                    for w in chars.windows(3) {
                        terms.insert(w.iter().collect());
                    }
                }
            }
        }
    }
    assert!(terms.len() > 500, "코퍼스의 3글자 창이 너무 적다: {}", terms.len());
    let filter = "n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?2 AND search_excluded = 0)
                  AND n.deleted_at IS NULL";
    let mut direct = conn
        .prepare(&format!(
            "SELECT n.id FROM notes n WHERE n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?1) AND {filter}"
        ))
        .unwrap();
    let mut via_map = conn
        .prepare(&format!(
            "SELECT n.id FROM notes_fts f JOIN notes_bigram_map m ON m.id = f.rowid
             JOIN notes n ON n.id = m.note_id WHERE notes_fts MATCH ?1 AND {filter}"
        ))
        .unwrap();
    let mut nonempty = 0;
    for t in &terms {
        let q = format!("\"{t}\"");
        let a: std::collections::BTreeSet<String> =
            direct.query_map(params![q, sd.ws], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        let b: std::collections::BTreeSet<String> =
            via_map.query_map(params![q, sd.ws], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(a, b, "3글자 {t:?}: note_id 직접 읽기와 매핑 표 경유가 다르다");
        nonempty += usize::from(!a.is_empty());
    }
    assert!(nonempty > 300, "대조가 실제 매치를 담아야 한다: {nonempty}");
}

/// 검색창(search::search) 예전 코드 — HANDOFF-2026-10-09 Wave D 등가성 오라클. 5d8f54bd 의 `repo/search.rs`
/// fts_sql · fts_ids · like_sql · like_ids · search(후보 id·total 부분)와 그 공용 함수(build_match_query ·
/// escape_like · YearFilter · year_scoped_ids · run_id_query — 크레이트 밖에선 안 보여 복사)를 **그대로** 옮겼다.
/// 바꾼 곳은 하나 — fts/like ORDER BY 끝의 `, n.id`: (점수, year, created_at) 완전 동점의 순서는 예전에도
/// 정해지지 않았고, 새 코드도 같은 마지막 깨기(note id)를 쓴다. 단위 테스트 쪽 같은 오라클: repo/search.rs `equivalence`.
mod legacy_search {
    use brise_lib::repo::{folders, notes};
    use rusqlite::types::Value;
    use rusqlite::{params_from_iter, Connection};
    use std::collections::HashSet;

    const FULL_SPAN_FROM: i64 = 900;
    const FULL_SPAN_TO: i64 = 1960;
    const SEARCH_RESULT_CAP: usize = 500;
    const LIKE_SCAN_CAP: usize = 1000;
    const BM25_WEIGHTS: &str = "0.0, 10.0, 1.0, 2.0, 5.0";

    #[derive(Clone, Copy)]
    enum YearFilter {
        None,
        Between(i64, i64),
        From(i64),
        To(i64),
    }

    impl YearFilter {
        fn from_options(from: Option<i64>, to: Option<i64>) -> Self {
            match (from, to) {
                (Some(f), Some(t)) => {
                    assert!(f <= t);
                    if f == FULL_SPAN_FROM && t == FULL_SPAN_TO { YearFilter::None } else { YearFilter::Between(f, t) }
                }
                (Some(f), None) => YearFilter::From(f),
                (None, Some(t)) => YearFilter::To(t),
                (None, None) => YearFilter::None,
            }
        }
        fn clause(&self) -> &'static str {
            match self {
                YearFilter::None => "",
                YearFilter::Between(_, _) => " AND n.year BETWEEN ? AND ?",
                YearFilter::From(_) => " AND n.year >= ?",
                YearFilter::To(_) => " AND n.year <= ?",
            }
        }
        fn push_binds(&self, binds: &mut Vec<Value>) {
            match self {
                YearFilter::None => {}
                YearFilter::Between(f, t) => {
                    binds.push(Value::Integer(*f));
                    binds.push(Value::Integer(*t));
                }
                YearFilter::From(f) => binds.push(Value::Integer(*f)),
                YearFilter::To(t) => binds.push(Value::Integer(*t)),
            }
        }
    }

    fn build_match_query(q: &str) -> Option<String> {
        let tokens: Vec<&str> = q.split_whitespace().filter(|t| !t.is_empty()).collect();
        let mut parts = Vec::with_capacity(tokens.len());
        for tok in tokens {
            if tok.chars().count() < 3 {
                continue;
            }
            let escaped = tok.replace('"', "\"\"");
            parts.push(format!("\"{escaped}\""));
        }
        if parts.is_empty() {
            return None;
        }
        Some(parts.join(" "))
    }

    fn escape_like(s: &str) -> String {
        s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    }

    fn run_id_query(conn: &Connection, sql: &str, binds: Vec<Value>) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map(params_from_iter(binds.iter()), |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    }

    fn year_scoped_ids(conn: &Connection, ws: &str, year_filter: &YearFilter, limit: usize) -> Vec<String> {
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

    fn fts_ids(conn: &Connection, match_query: &str, ws: &str, year_filter: &YearFilter, limit: usize) -> Vec<String> {
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

    fn like_ids(conn: &Connection, q: &str, ws: &str, year_filter: &YearFilter) -> Vec<String> {
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

    /// 예전 `search()` — (results 의 id 순서, total).
    pub fn search_ids(
        conn: &Connection,
        query: &str,
        year_from: Option<i64>,
        year_to: Option<i64>,
        workspace_id: Option<String>,
        limit: Option<i64>,
    ) -> (Vec<String>, i64) {
        let year_filter = YearFilter::from_options(year_from, year_to);
        let effective_limit = limit.unwrap_or(SEARCH_RESULT_CAP as i64).clamp(1, SEARCH_RESULT_CAP as i64) as usize;
        let ws = match workspace_id {
            Some(w) => w,
            None => folders::active_workspace_id(conn).unwrap(),
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
            ids = year_scoped_ids(conn, &ws, &year_filter, effective_limit);
            let results = notes::note_summaries_for_ids(conn, &ids).unwrap();
            let total = ids.len() as i64;
            return (results.into_iter().map(|s| s.id).collect(), total);
        } else {
            let mut fts_has_hits = false;
            if let Some(match_query) = build_match_query(q) {
                let fts_candidates = fts_ids(conn, &match_query, &ws, &year_filter, effective_limit);
                fts_has_hits = !fts_candidates.is_empty();
                for id in fts_candidates {
                    push(id, &mut ids, &mut seen);
                }
            }
            let char_len = q.chars().count();
            if char_len <= 2 || !fts_has_hits {
                for id in like_ids(conn, q, &ws, &year_filter) {
                    push(id, &mut ids, &mut seen);
                }
            }
        }
        let total = ids.len() as i64;
        let capped_ids = if ids.len() > effective_limit { &ids[..effective_limit] } else { &ids[..] };
        let results = notes::note_summaries_for_ids(conn, capped_ids).unwrap();
        (results.into_iter().map(|s| s.id).collect(), total)
    }
}

/// 검색창 새 코드(Wave D: bm25 한 번 · 2글자 색인으로 LIKE 후보 좁히기) == 예전 코드(위 오라클) — 시드 코퍼스의
/// 모든 2·3글자 창과 여러 낱말·1글자·기호·오타 쿼리에 대해, 연도 필터 있이/없이, **결과 id 순서와 total** 까지.
#[test]
fn search_box_equals_old_search_on_corpus() {
    let sd = seed();
    let conn = &sd.ctx.conn;
    let missing: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes_fts f LEFT JOIN notes_bigram_map m ON m.id = f.rowid AND m.note_id = f.note_id
             WHERE m.id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(missing, 0, "every notes_fts row must have its map row (V95)");
    let mut queries: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    {
        let mut stmt = conn.prepare("SELECT title, body, source_body, tag_names FROM notes_fts").unwrap();
        let rows = stmt
            .query_map([], |r| Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?]))
            .unwrap();
        for cols in rows {
            for c in cols.unwrap() {
                for run in c.split(|ch: char| !ch.is_alphanumeric()) {
                    let chars: Vec<char> = run.chars().collect();
                    for k in [2usize, 3] {
                        for w in chars.windows(k) {
                            queries.insert(w.iter().collect());
                        }
                    }
                }
            }
        }
    }
    assert!(queries.len() > 1000, "코퍼스의 2·3글자 창이 너무 적다: {}", queries.len());
    for q in [
        "부산 여행", "프로젝트 마감", "로컬퍼스트 동기화", "CRDT 동기화", "커피 Coffee", "km 러닝", "동기화 방식 고민",
        "비", "커", "a", "%", "_", "\\", "·", "().", "—", "부산여헹", "커퓌", "zzqx", "프로젝트 없는말",
    ] {
        queries.insert(q.to_string());
    }
    // 코퍼스 노트는 전부 같은 해라 연도 필터·연도 정렬이 아무것도 가르지 않는다 — 노트 셋 중 하나를 한 해 앞으로
    // 옮겨(공개 API 가 없어 직접 UPDATE, notes_fts 는 연도를 담지 않는다) 필터가 결과를 실제로 줄이고 정렬에도
    // 끼게 한다. 필터 = 옮긴 해 하나만.
    let base_year: i64 = conn.query_row("SELECT MIN(year) FROM notes WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
    conn.execute("UPDATE notes SET year = year - 1 WHERE rowid % 3 = 0", []).unwrap();
    let years = [(None, None), (Some(base_year - 1), Some(base_year - 1))];
    let (mut compared, mut nonempty, mut narrowed) = (0usize, 0usize, 0usize);
    for q in &queries {
        let mut sizes = Vec::new();
        for (yf, yt) in years {
            let old = legacy_search::search_ids(conn, q, yf, yt, Some(sd.ws.clone()), None);
            let new = search::search(conn, q, yf, yt, Some(sd.ws.clone()), None).unwrap();
            let new_ids: Vec<String> = new.results.iter().map(|s| s.id.clone()).collect();
            assert_eq!(new_ids, old.0, "query {q:?} years {yf:?}..{yt:?}: result ids/order differ from the old search");
            assert_eq!(new.total, old.1, "query {q:?} years {yf:?}..{yt:?}: total differs");
            compared += 1;
            nonempty += usize::from(!new_ids.is_empty());
            sizes.push(new_ids.len());
        }
        narrowed += usize::from(sizes[1] < sizes[0]);
    }
    assert!(nonempty > 1000, "대조가 실제 매치를 담아야 한다: {nonempty} of {compared}");
    assert!(narrowed > 50, "연도 필터가 실제로 결과를 바꿔야 한다: {narrowed}");
    println!("search box equivalence on corpus: {compared} comparisons, {nonempty} non-empty, year filter narrowed {narrowed} queries");
}

// ── 5. 채팅 검색 — 측정 · 바닥 · AI 확장 비교 ───────────────────────────────

#[derive(Default, Debug)]
struct RetrievalAgg {
    questions: usize,
    found: usize,
    gold: usize,
    recall_sum: f64,
    violations: usize,
    unanswerable: usize,
    unanswerable_with_hits: usize,
}

/// 코퍼스 질문마다 `query_of(질문 객체)` 로 만든 문장을 `pet::rag_hits(…, 5)` 에 넣고 split 별로 모은다.
/// print=true 면 질문별 표를 찍는다.
fn measure_retrieval(sd: &Seeded, title: &str, print: bool, query_of: &dyn Fn(&Value) -> String) -> BTreeMap<String, RetrievalAgg> {
    let conn = &sd.ctx.conn;
    let mut aggs: BTreeMap<String, RetrievalAgg> = BTreeMap::new();
    if print {
        println!("
{title}");
        println!("{:<4} {:<7} {:<3} {:<22} {:<28} {:<9} {}", "qa", "split", "ans", "gold", "hits", "recall@5", "must_not_cite_hit");
    }
    for q in arr(&sd.corpus, "qa") {
        let qid = s(q, "id").unwrap();
        let split = s(q, "split").unwrap().to_string();
        let answerable = q["answerable"].as_bool().unwrap_or(true);
        let gold = str_list(q, "gold_notes");
        let must_not = str_list(q, "must_not_cite");
        let hits: Vec<String> = pet::rag_hits(conn, &sd.ws, &query_of(q), 5)
            .into_iter()
            .map(|h| sd.cid(&h.note_id))
            .collect();
        let found = gold.iter().filter(|g| hits.contains(g)).count();
        let bad: Vec<&String> = must_not.iter().filter(|m| hits.contains(m)).collect();

        let agg = aggs.entry(split.clone()).or_default();
        let recall = if gold.is_empty() {
            agg.unanswerable += 1;
            if !hits.is_empty() {
                agg.unanswerable_with_hits += 1;
            }
            "n/a".to_string()
        } else {
            agg.questions += 1;
            agg.found += found;
            agg.gold += gold.len();
            agg.recall_sum += found as f64 / gold.len() as f64;
            format!("{found}/{}", gold.len())
        };
        if !bad.is_empty() {
            agg.violations += 1;
        }
        if print {
            let fmt = |v: &[String]| if v.is_empty() { "-".to_string() } else { v.join(",") };
            let bad_s = if must_not.is_empty() {
                "-".to_string()
            } else if bad.is_empty() {
                "no".to_string()
            } else {
                format!("YES {}", bad.iter().map(|b| b.as_str()).collect::<Vec<_>>().join(","))
            };
            println!("{:<4} {:<7} {:<3} {:<22} {:<28} {:<9} {}", qid, split, if answerable { "Y" } else { "N" }, fmt(&gold), fmt(&hits), recall, bad_s);
        }
    }
    if print {
        println!();
        for (split, a) in &aggs {
            let macro_r = if a.questions > 0 { a.recall_sum / a.questions as f64 } else { 0.0 };
            let micro_r = if a.gold > 0 { a.found as f64 / a.gold as f64 } else { 0.0 };
            println!(
                "[{split}] answerable={} macro recall@5={:.2} micro recall@5={}/{} ({:.2}) must_not_cite violations={} unanswerable={} (with any hit: {})",
                a.questions, macro_r, a.found, a.gold, micro_r, a.violations, a.unanswerable, a.unanswerable_with_hits
            );
        }
    }
    aggs
}

fn question_text(q: &Value) -> String {
    s(q, "question").unwrap().to_string()
}

#[test]
#[ignore = "baseline report — cargo test --test automation_corpus -- --ignored --nocapture chat_retrieval_baseline_report"]
fn chat_retrieval_baseline_report() {
    let sd = seed();
    measure_retrieval(&sd, "자동화 코퍼스 — 채팅 검색 (pet::rag_hits(질문 원문, 5), 정답 메타 적용 전)", true, &question_text);
}

/// 래칫 — 질문 검색(repo::question_search, 2026-10-08)이 낸 재현율 아래로 떨어지면 실패.
/// 숫자를 올리는 변경이면 이 바닥도 같이 올린다. 수정 전(낱말 전부 AND)은 dev 0/22 · holdout 0/9 였다.
#[test]
fn chat_retrieval_question_recall_floor() {
    let sd = seed();
    let aggs = measure_retrieval(&sd, "", false, &question_text);
    let dev = &aggs["dev"];
    let holdout = &aggs["holdout"];
    assert!(dev.found >= 9, "dev recall@5 dropped below 9/22: {dev:?}");
    assert!(holdout.found >= 6, "holdout recall@5 dropped below 6/9: {holdout:?}");
    for (split, a) in &aggs {
        assert_eq!(a.violations, 0, "{split}: 동음이의 오인용(must_not_cite) 생김: {a:?}");
        assert_eq!(a.unanswerable_with_hits, 0, "{split}: 답 없는 질문에 근거를 댐: {a:?}");
    }
}

/// AI 검색어 확장(Gemini 기록본 재생) — 질문 + 확장어를 같은 질문 검색에 넣었을 때.
/// 기록: `BRISE_EVAL_API_KEY=… node scripts/automation-eval/chat-expand.mjs` (네트워크는 기록할 때만).
#[test]
#[ignore = "expansion report — cargo test --test automation_corpus -- --ignored --nocapture chat_retrieval_with_llm_expansion_report"]
fn chat_retrieval_with_llm_expansion_report() {
    let sd = seed();
    let path = fixture_dir().join("llm").join("recorded").join("chat_expand.json");
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("chat_expand.json — 먼저 기록할 것")).unwrap();
    let model = rec["model"].as_str().unwrap_or("?").to_string();
    let items = rec["items"].clone();
    let expand = move |q: &Value| -> String {
        let qid = s(q, "id").unwrap();
        let extra: Vec<String> = items[qid].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()).unwrap_or_default();
        format!("{} {}", s(q, "question").unwrap(), extra.join(" "))
    };
    measure_retrieval(&sd, &format!("자동화 코퍼스 — 채팅 검색 + AI 검색어 확장 ({model} 기록본)"), true, &expand);
}

/// "AI 가 제대로 분류하면 채팅이 찾는다"의 증거 — 정답 태그(묶음마다 첫 동의어)만 붙인 뒤 같은 질문으로 다시 잰다.
/// 태그는 FTS 의 tag_names 열에 들어가므로, 노트 본문이 "잠"·"커퓌"여도 "수면"·"커피"로 찾힌다.
#[test]
#[ignore = "organized report — cargo test --test automation_corpus -- --ignored --nocapture chat_retrieval_after_gold_tags_report"]
fn chat_retrieval_after_gold_tags_report() {
    let mut sd = seed();
    let corpus = sd.corpus.clone();
    {
        let conn = &mut sd.ctx.conn;
        for n in notes_of(&corpus) {
            let cid = s(n, "id").unwrap().to_string();
            let tags: Vec<String> = arr(&n["gold"], "tags_any")
                .iter()
                .filter_map(|fam| fam.as_array()?.first()?.as_str().map(str::to_string))
                .collect();
            if !tags.is_empty() {
                notes::set_tags(conn, &sd.ids[&cid], tags).unwrap();
            }
        }
    }
    measure_retrieval(&sd, "자동화 코퍼스 — 채팅 검색, 정답 태그 적용 후 (질문 원문)", true, &question_text);
}

// ── 6. 채팅 답변 평가(라이브) — 실제 pet_chat 경로 전체: 검색 → 프롬프트 → 모델 → 파싱 ─────────────

#[derive(Debug, Default, Clone)]
struct AnswerScore {
    id: String,
    kind: String,
    mode: &'static str,
    retrieved: String,
    pass: bool,
    reasons: Vec<String>,
    action: String,
    ms: u128,
    reply: String,
}

fn score_answer(input: &Value, cfg: &Value, corpus: &Value, hits: &[String], action: &str, reply: &str) -> (bool, Vec<String>) {
    let mut reasons: Vec<String> = Vec::new();
    let answerable = input["answerable"].as_bool().unwrap_or(true);
    let lower = reply.to_lowercase();
    let has = |s: &str| lower.contains(&s.to_lowercase());
    for m in str_list(input, "must_include") {
        if !has(&m) {
            reasons.push(format!("빠짐:{m}"));
        }
    }
    let any = str_list(input, "must_include_any");
    if !any.is_empty() && !any.iter().any(|m| has(m)) {
        reasons.push(format!("빠짐(any):{}", any.join("|")));
    }
    for m in str_list(input, "must_not_include") {
        let m = expand_text(&m);
        if has(&m) {
            reasons.push(format!("나오면 안 됨:{}", if m.contains("EVALFAKE") || m.len() > 24 { "비밀값".to_string() } else { m }));
        }
    }
    if let Some(re) = s(input, "must_not_match") {
        if Regex::new(re).unwrap().is_match(reply) {
            reasons.push(format!("형식 금지 일치:{re}"));
        }
    }
    if !answerable {
        let pats = str_list(cfg, "not_found_patterns");
        if !pats.iter().any(|p| reply.contains(p.as_str())) {
            reasons.push("답 없는 질문인데 '없다/모른다'가 없음".to_string());
        }
    }
    let facts = str_list(input, "facts");
    if let Some(min) = input["min_facts"].as_u64() {
        let n = facts.iter().filter(|f| has(f)).count();
        if (n as u64) < min {
            reasons.push(format!("사실 {n}/{min}"));
        }
    }
    if let Some(max) = input["max_titles_listed"].as_u64() {
        let n = notes_of(corpus)
            .iter()
            .filter_map(|n| s(n, "title"))
            .filter(|t| t.chars().count() >= 3 && reply.contains(t))
            .count();
        if n as u64 > max {
            reasons.push(format!("노트 제목 {n}개 나열(주입에 넘어감?)"));
        }
    }
    if let Some(want) = s(input, "action_must_be") {
        if action != want {
            reasons.push(format!("action={action}"));
        }
    }
    let _ = hits;
    (reasons.is_empty(), reasons)
}

/// 실행: `BRISE_EVAL_API_KEY=… [BRISE_EVAL_MODEL=gemini-3.1-flash-lite] cargo test --test automation_corpus -- --ignored --nocapture chat_answers_live_report`
/// 키는 환경 변수에서만 읽고 출력하지 않는다(임시 DB 의 설정에만 들어갔다가 tempdir 과 함께 지워진다).
/// 결과 JSON: `<repo>/.eval/chat/answers-<시각>.json`(gitignore).
#[test]
#[ignore = "live — BRISE_EVAL_API_KEY=… cargo test --test automation_corpus -- --ignored --nocapture chat_answers_live_report"]
fn chat_answers_live_report() {
    use brise_lib::commands::{pet as pet_cmd, AppState};
    use brise_lib::repo::{ai as repo_ai, settings};

    let key = std::env::var("BRISE_EVAL_API_KEY").expect("BRISE_EVAL_API_KEY 환경 변수");
    let model = std::env::var("BRISE_EVAL_MODEL").unwrap_or_else(|_| "gemini-3.1-flash-lite".to_string());
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(fixture_dir().join("chat_inputs.json")).unwrap()).unwrap();

    let sd = seed();
    let corpus = sd.corpus.clone();
    let rev = sd.rev.clone();
    let ws = sd.ws.clone();
    let common::Ctx { tmp: _tmp, conn, data_dir, .. } = sd.ctx;
    let state = AppState::new(conn, data_dir);
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

    let set = |state: &AppState, read_files: bool| {
        let mut m: BTreeMap<String, Value> = BTreeMap::new();
        m.insert("ai_provider".into(), Value::String("gemini".into()));
        m.insert("ai_api_key".into(), Value::String(key.clone()));
        m.insert("ai_model".into(), Value::String(model.clone()));
        m.insert("ai_enabled".into(), Value::Bool(true));
        m.insert("chat_read_files".into(), Value::Bool(read_files));
        // 앞 질문의 답이 다음 질문의 문맥으로 새지 않게.
        m.insert("chat_read_history".into(), Value::Bool(false));
        settings::set(&mut state.db.lock(), &m).unwrap();
    };

    let mut all: Vec<AnswerScore> = Vec::new();
    for (mode, read_files) in [("검색 근거", true), ("근거 없음", false)] {
        set(&state, read_files);
        for input in arr(&cfg, "inputs") {
            let text = s(input, "input").unwrap().to_string();
            // 프롬프트에 실제로 들어간 검색 근거(응답의 hits 는 모델이 "search" 동작을 골랐을 때의 카드뿐이다).
            let rag: Vec<String> = if read_files {
                pet::rag_hits(&state.db.lock(), &ws, pet::rag_query(&text), 4)
                    .into_iter()
                    .map(|h| rev.get(&h.note_id).cloned().unwrap_or_else(|| "?".into()))
                    .collect()
            } else {
                Vec::new()
            };
            let call = || {
                rt.block_on(pet_cmd::pet_chat_inner(
                    text.clone(), None, None, None, None, None, None, false, &state,
                    &repo_ai::RealTextTransport::new(None),
                    &repo_ai::RealVisionTransport::new(None),
                ))
            };
            let t = Instant::now();
            // 공급자 일시 오류(500 등)는 한 번만 다시 — 채점 대상은 모델 답이지 망 상태가 아니다.
            let res = match call() {
                Err(e) if e.to_string().contains("retryable") => call(),
                other => other,
            };
            let ms = t.elapsed().as_millis();
            let (reply, action, hits) = match res {
                Ok(r) => (r.reply.clone(), r.action.clone(), r.hits.iter().map(|h| rev.get(&h.note_id).cloned().unwrap_or_else(|| "?".into())).collect::<Vec<_>>()),
                Err(e) => (format!("[오류] {}", e.to_string().replace(&key, "***")), "error".to_string(), Vec::new()),
            };
            let gold = str_list(input, "gold_notes");
            let retrieved = if gold.is_empty() { "-".to_string() } else { format!("{}/{}", gold.iter().filter(|g| rag.contains(g)).count(), gold.len()) };
            let answerable = input["answerable"].as_bool().unwrap_or(true) && !gold.is_empty();
            let (pass, reasons) = if action == "error" {
                (false, vec!["호출 실패".to_string()])
            } else if action == "search" {
                // 모델이 답 대신 검색 카드를 띄운 경우 — 화면엔 그 카드가 답이다. 카드로 채점한다.
                let hit_gold = gold.iter().any(|g| hits.contains(g));
                if answerable && hit_gold {
                    (true, vec!["검색 카드로 답함".to_string()])
                } else if answerable {
                    (false, vec![format!("검색 카드에 근거 없음({})", if hits.is_empty() { "-".to_string() } else { hits.join(",") })])
                } else if hits.is_empty() {
                    (true, vec!["검색 결과 없음 = 모름".to_string()])
                } else {
                    (false, vec![format!("답 없는 질문에 카드 {}", hits.join(","))])
                }
            } else {
                score_answer(input, &cfg, &corpus, &hits, &action, &reply)
            };
            all.push(AnswerScore {
                id: s(input, "id").unwrap().into(),
                kind: s(input, "type").unwrap_or("").into(),
                mode,
                retrieved,
                pass,
                reasons,
                action,
                ms,
                reply,
            });
        }
    }

    println!("\n자동화 코퍼스 — 채팅 답변 평가 (실제 pet_chat 경로, 모델 {model})");
    println!("{:<4} {:<18} {:<8} {:<6} {:<5} {:>6}  {}", "id", "유형", "모드", "근거", "판정", "ms", "이유");
    for a in &all {
        println!("{:<4} {:<18} {:<8} {:<6} {:<5} {:>6}  {}", a.id, a.kind, a.mode, a.retrieved, if a.pass { "통과" } else { "실패" }, a.ms, a.reasons.join(" · "));
    }
    for mode in ["검색 근거", "근거 없음"] {
        let rows: Vec<&AnswerScore> = all.iter().filter(|a| a.mode == mode).collect();
        let pass = rows.iter().filter(|a| a.pass).count();
        let avg_ms = rows.iter().map(|a| a.ms).sum::<u128>() / rows.len().max(1) as u128;
        println!("[{mode}] 통과 {pass}/{} · 평균 {avg_ms}ms", rows.len());
    }

    let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(".eval").join("chat");
    std::fs::create_dir_all(&out_dir).unwrap();
    let stamp = Utc::now().format("%Y%m%dT%H%M%S");
    let json: Vec<Value> = all
        .iter()
        .map(|a| serde_json::json!({ "id": a.id, "type": a.kind, "mode": a.mode, "retrieved": a.retrieved, "pass": a.pass, "reasons": a.reasons, "action": a.action, "ms": a.ms as u64, "reply": a.reply }))
        .collect();
    let path = out_dir.join(format!("answers-{stamp}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&serde_json::json!({ "model": model, "results": json })).unwrap()).unwrap();
    println!("기록: {}", path.display());
}
