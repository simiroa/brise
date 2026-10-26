//! 채팅 질문 검색 속도 측정(보고만) — `repo::question_search::question_hits` 대 예전 경로(`repo::search::search` 에 문장 그대로).
//!
//! 2자 핵심어는 2글자 색인(notes_bigram, V94) 조회다 — 예전엔 notes_fts 네 열 LIKE 전체 스캔이라 노트 수 × 본문
//! 길이에 비례했다. 시드 시간(쓰기 경로가 색인까지 쓰는 비용)과 DB·색인 크기도 함께 찍는다. 사용자 DB 는 쓰지
//! 않는다 — 합성 노트를 만들어 잰다(`BRISE_BENCH_NOTES`, 기본 10000).
//!
//! 사람용 표와 함께 러너(`npm run bench` = scripts/bench/run.mjs → suites/rust.mjs)가 읽는 `BENCH-JSON` 줄을 낸다
//! (docs/PLAN-2026-10-23-perf-baselines.md §2.3·§4.1). 지표 id 는 scripts/bench/metrics.mjs 의 rust 그룹과 한 글자도
//! 다르면 안 된다. 표본은 한 번 시드한 DB 위에서 워밍업 1회 뒤 `BRISE_BENCH_SAMPLES`(기본 5)회 — 통계는 러너가 낸다.
//!
//! 실행: `cargo test --test bench_question_search -- --ignored --nocapture` (release 수치는 `--release`)
mod common;

use brise_lib::repo::{folders, notes, question_search, search, sections};
use rusqlite::Connection;
use serde_json::json;
use std::time::Instant;

const QUESTIONS: &[&str] = &[
    "커피는 몇 시 이후로 안 마시기로 했지?",
    "낮잠에 대해 내 생각이 바뀐 적 있어?",
    "부산 여행 준비할 거 뭐 있었지?",
    "동기화 방식으로 뭘 고민했었지?",
    "목요일에 무슨 일정 있어?",
    "9월에 커피값 얼마 나왔어?",
    "러닝 기록 중에 제일 길게 뛴 거리는?",
];
const ROUNDS: u32 = 5;
/// `fts_upsert` 한 번은 1ms 안팎이라 표본 하나 = 이만큼 반복의 평균(계획 §2.3 — 타이머 해상도·fsync 잡음).
const FTS_ITERS: usize = 50;

/// 생활 메모 어휘 — 질문 핵심어가 적당히 흩어져 들어가게 섞는다.
const WORDS: &[&str] = &[
    "오늘", "회의", "커피", "여행", "부산", "동기화", "일정", "러닝", "거리", "생각", "낮잠", "수면", "점심", "저녁",
    "프로젝트", "마감", "디자인", "리뷰", "코드", "버그", "테스트", "배포", "가족", "친구", "약속", "운동", "산책",
    "독서", "영화", "음악", "카페", "지출", "커피값", "예산", "월급", "카드", "목요일", "금요일", "주말", "9월", "10월",
    "준비", "방식", "고민", "결정", "아이디어", "메모", "정리", "계획", "목표", "습관", "건강", "병원", "치과", "보험",
    "서류", "기차", "숙소", "맛집", "바다", "해운대", "광안리", "서울", "제주", "날씨", "비", "바람", "기분", "피곤",
    "집중", "업무", "메일", "전화", "문서", "자료", "검색", "노트", "앱", "에디터", "데이터", "서버", "로컬", "충돌",
    "그리고", "그래서", "하지만", "정말", "조금", "많이", "다시", "아직", "벌써", "이번", "다음", "지난",
];

fn synth_body(seed: u64, words: usize) -> String {
    // 결정적 LCG — 실행마다 같은 코퍼스.
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut out = String::new();
    for i in 0..words {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        // 앞쪽 단어가 더 자주 나오게(대략 Zipf).
        let r = ((x >> 33) % 10_000) as f64 / 10_000.0;
        let idx = ((r * r) * WORDS.len() as f64) as usize % WORDS.len();
        out.push_str(WORDS[idx]);
        out.push(if i % 12 == 11 { '\n' } else { ' ' });
    }
    out
}

fn ms(f: &mut dyn FnMut()) -> f64 {
    f(); // 첫 실행은 캐시 데우기
    let t = Instant::now();
    for _ in 0..ROUNDS {
        f();
    }
    t.elapsed().as_secs_f64() * 1000.0 / ROUNDS as f64
}

// ── 러너용 기계 출력(계획 §2.3) ──────────────────────────────────────────────

/// 표본 수 — 러너의 `--samples N` 이 넘긴다. 기본 5(계획 §4.1).
fn bench_samples() -> usize {
    std::env::var("BRISE_BENCH_SAMPLES").ok().and_then(|v| v.parse().ok()).filter(|&n: &usize| n >= 1).unwrap_or(5)
}

/// 워밍업 1회(= `iters` 회 한 묶음, 버림) 뒤 `n` 개의 표본(ms). 표본 하나 = `iters` 회 반복의 평균.
/// `iters` 가 1 이면 호출 하나하나가 표본이다.
fn samples_ms(n: usize, iters: usize, f: &mut dyn FnMut()) -> Vec<f64> {
    for _ in 0..iters {
        f();
    }
    (0..n)
        .map(|_| {
            let t = Instant::now();
            for _ in 0..iters {
                f();
            }
            t.elapsed().as_secs_f64() * 1000.0 / iters as f64
        })
        .collect()
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}

fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let m = s.len() / 2;
    if s.len() % 2 == 0 {
        (s[m - 1] + s[m]) / 2.0
    } else {
        s[m]
    }
}

/// 중앙값이 가장 큰 쿼리의 표본 — "최악" 지표. 예전 사람용 정의(쿼리별 평균 중 최대)를 따른다.
/// 회차마다 쿼리 최대를 뽑으면 잡음이 큰 쪽으로만 치우쳐서(최대의 기댓값 > 기댓값의 최대) 쓰지 않는다.
fn worst_samples(per_query: &[Vec<f64>]) -> Vec<f64> {
    per_query
        .iter()
        .max_by(|a, b| median(a).total_cmp(&median(b)))
        .expect("쿼리가 하나 이상")
        .clone()
}

/// `BENCH-JSON {…}` 한 줄 = 한 지표. 한 번의 `println!` 으로 낸다(줄이 쪼개지면 러너가 측정기 버그로 거부한다).
/// workload 에는 **입력 매개변수만** 적는다 — 러너가 기준선과 글자 그대로 비교해 다르면 UNCOMPARABLE 로 본다.
fn bench_json(metric: &str, unit: &str, samples: &[f64], workload: serde_json::Value) {
    let line = json!({ "metric": metric, "unit": unit, "samples": samples, "workload": workload });
    println!("BENCH-JSON {line}");
}

#[test]
#[ignore = "bench — cargo test --test bench_question_search -- --ignored --nocapture"]
fn question_search_vs_sentence_search_timing() {
    let n: usize = std::env::var("BRISE_BENCH_NOTES").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000);
    // 본문 길이 배수 — 실제 노트는 합성(평균 ~250자)보다 길다. 4 면 ~1000자.
    let scale: usize = std::env::var("BRISE_BENCH_BODY_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let n_samples = bench_samples();
    let ctx = common::setup();
    let mut conn: Connection = ctx.conn;
    let t_seed = Instant::now();
    for i in 0..n {
        let d = notes::create(&mut conn, &ctx.folder_id, Some(format!("메모 {i}")), Some(2026)).unwrap();
        let body = synth_body(i as u64, (40 + (i % 80)) * scale);
        sections::update(&mut conn, &d.sections[0].id, None, Some(body), None).unwrap();
    }
    let seed_secs = t_seed.elapsed().as_secs_f64();
    // V94 백필과 같은 일(notes_fts 전체에서 2글자 색인 재구축) — 기존 DB 업그레이드 첫 부팅이 기다리는 시간.
    let t_backfill = Instant::now();
    {
        let tx = conn.transaction().unwrap();
        brise_lib::repo::fts::bigram_rebuild_all(&tx).unwrap();
        tx.commit().unwrap();
    }
    let backfill_secs = t_backfill.elapsed().as_secs_f64();
    let ws = folders::active_workspace_id(&conn).unwrap();
    let avg_len: f64 = conn
        .query_row("SELECT AVG(LENGTH(body)) FROM notes_fts", [], |r| r.get(0))
        .unwrap();
    println!(
        "\n합성 노트 {n}개(본문 평균 {avg_len:.0}자, 시드 {seed_secs:.1}s, V94 백필 재구축 {backfill_secs:.1}s), 워밍업 1회 뒤 각 {ROUNDS}회 평균(ms, 질문검색 열은 표본 {n_samples}개 평균) — {}",
        if cfg!(debug_assertions) { "debug 빌드" } else { "release 빌드" }
    );
    {
        let q = |sql: &str| -> Option<i64> { conn.query_row(sql, [], |r| r.get(0)).ok().flatten() };
        let mb = |b: Option<i64>| b.map(|b| format!("{:.1}MB", b as f64 / 1e6)).unwrap_or_else(|| "?".into());
        let total = q("SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size())");
        // dbstat 은 bundled SQLite 에 켜져 있다(없으면 "?").
        let fts = q("SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'notes_fts%'");
        let bigram = q("SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'notes_bigram%' OR name LIKE 'sqlite_autoindex_notes_bigram%'");
        let pct = match (fts, bigram) {
            (Some(f), Some(b)) if f > 0 => format!("{:.0}%", b as f64 * 100.0 / f as f64),
            _ => "?".into(),
        };
        println!("크기: DB {} · notes_fts {} · 2글자 색인 {} (notes_fts 대비 {pct})", mb(total), mb(fts), mb(bigram));
        // 크기는 결정적이라 표본 1개. MB = 1e6 B — 위 사람용 줄·계획 §1.3 과 같은 단위.
        // gate 지표가 조용히 빠지지 않게 못 읽으면 실패한다(러너도 빠진 지표를 오류로 본다).
        let size_workload = json!({ "notes": n, "body_scale": scale });
        let bigram = bigram.expect("dbstat 으로 2글자 색인 크기를 못 읽었다 — index.bigram_mb_10k 를 낼 수 없다");
        let total = total.expect("page_count × page_size 를 못 읽었다 — index.db_mb_10k 를 낼 수 없다");
        bench_json("index.bigram_mb_10k", "MB", &[bigram as f64 / 1e6], size_workload.clone());
        bench_json("index.db_mb_10k", "MB", &[total as f64 / 1e6], size_workload);
    }
    println!("{:<34} {:>10} {:>10}  {}", "질문", "예전(AND)", "질문검색", "핵심어");
    let (mut old_sum, mut new_sum, mut worst) = (0.0f64, 0.0f64, 0.0f64);
    // 질문별 표본 — per_q[질문][회차]. 워밍업 1회 뒤 호출 하나 = 표본 하나.
    let mut per_q: Vec<Vec<f64>> = Vec::with_capacity(QUESTIONS.len());
    for q in QUESTIONS {
        let old = ms(&mut || {
            let _ = search::search(&conn, q, None, None, Some(ws.clone()), Some(4)).unwrap();
        });
        let new_samples = samples_ms(n_samples, 1, &mut || {
            let _ = question_search::question_hits(&conn, &ws, q, 4).unwrap();
        });
        let new = mean(&new_samples);
        per_q.push(new_samples);
        old_sum += old;
        new_sum += new;
        worst = worst.max(new);
        let terms = question_search::question_terms(q);
        let short = terms.iter().filter(|t| t.chars().count() < 3).count();
        println!("{:<34} {:>10.1} {:>10.1}  {:?} (2자 {short}개)", q, old, new, terms);
    }
    let k = QUESTIONS.len() as f64;
    println!("평균: 예전 {:.1}ms · 질문검색 {:.1}ms · 질문검색 최악 {:.1}ms", old_sum / k, new_sum / k, worst);
    // 회차 r 의 평균 = 그 회차 질문 7개 시간의 평균. 최악 = 중앙값이 가장 큰 질문의 표본.
    let search_workload = json!({ "notes": n, "body_scale": scale, "iters": 1, "queries": QUESTIONS.len() });
    let avg_samples: Vec<f64> = (0..n_samples).map(|r| per_q.iter().map(|s| s[r]).sum::<f64>() / k).collect();
    bench_json("search.question_avg_ms", "ms", &avg_samples, search_workload.clone());
    bench_json("search.question_worst_ms", "ms", &worst_samples(&per_q), search_workload);

    // 비용 분해 — 최적화 후보마다 무엇을 줄이는지(2026-10-08 제안 근거).
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    let full_like = ms(&mut || {
        count("SELECT COUNT(*) FROM notes_fts f WHERE f.title LIKE '%커피%' OR f.body LIKE '%커피%' OR f.source_body LIKE '%커피%' OR f.tag_names LIKE '%커피%'");
    });
    let three_terms = ms(&mut || {
        count("SELECT COUNT(*) FROM notes_fts f WHERE (f.title LIKE '%커피%' OR f.body LIKE '%커피%' OR f.source_body LIKE '%커피%' OR f.tag_names LIKE '%커피%') \
               OR (f.title LIKE '%여행%' OR f.body LIKE '%여행%' OR f.source_body LIKE '%여행%' OR f.tag_names LIKE '%여행%') \
               OR (f.title LIKE '%일정%' OR f.body LIKE '%일정%' OR f.source_body LIKE '%일정%' OR f.tag_names LIKE '%일정%')");
    });
    let short_cols = ms(&mut || {
        count("SELECT COUNT(*) FROM notes_fts f WHERE f.title LIKE '%커피%' OR f.tag_names LIKE '%커피%'");
    });
    let fts_set = ms(&mut || {
        count("SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '\"동기화\"'");
    });
    let bigram_one = ms(&mut || {
        count("SELECT COUNT(*) FROM notes_bigram WHERE notes_bigram MATCH '\"커피\"'");
    });
    // 질문 검색이 실제로 쓰는 모양(작업 공간·검색 제외·휴지통 필터 + 상한 5000) — 위의 COUNT 만으로는 안 보이는
    // 행마다의 note_id 읽기·notes 조인 비용까지.
    let filter = "n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1 AND search_excluded = 0) AND n.deleted_at IS NULL";
    let ids_len = |sql: &str| -> usize {
        let mut st = conn.prepare(sql).unwrap();
        st.query_map([&ws], |r| r.get::<_, String>(0)).unwrap().count()
    };
    // 3자 이상은 V95 부터 rowid → 매핑 표(note_id 열을 읽으면 FTS5 가 행마다 본문까지 가져와 5000건 ~19ms 였다).
    let fts_term_sql = format!(
        "SELECT n.id FROM notes_fts f JOIN notes_bigram_map m ON m.id = f.rowid JOIN notes n ON n.id = m.note_id          WHERE notes_fts MATCH '\"목요일\"' AND {filter} LIMIT 5000"
    );
    let fts_old_sql = format!(
        "SELECT n.id FROM notes n WHERE n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH '\"목요일\"') AND {filter} LIMIT 5000"
    );
    let bigram_term_sql = format!(
        "SELECT n.id FROM notes_bigram b JOIN notes_bigram_map m ON m.id = b.rowid JOIN notes n ON n.id = m.note_id \
         WHERE notes_bigram MATCH '\"일정\"' AND {filter} LIMIT 5000"
    );
    let (mut fts_n, mut big_n) = (0, 0);
    let fts_term = ms(&mut || fts_n = ids_len(&fts_term_sql));
    let fts_old = ms(&mut || {
        ids_len(&fts_old_sql);
    });
    let bigram_term = ms(&mut || big_n = ids_len(&bigram_term_sql));
    println!(
        "질문 검색 경로(필터 포함): 3자+ fts_term_ids(\"목요일\", {fts_n}건) {fts_term:.1}ms (note_id 직접 읽기였을 때 {fts_old:.1}ms) · 2글자 색인(\"일정\", {big_n}건) {bigram_term:.1}ms"
    );
    println!(
        "분해: 2자 LIKE 4열 스캔 1낱말 {full_like:.1}ms · 3낱말 한 번에 {three_terms:.1}ms · 제목·태그만 {short_cols:.1}ms · 3자+ FTS 집합 {fts_set:.1}ms · 2글자 색인 1낱말 {bigram_one:.1}ms"
    );
}

// ── 검색창(search::search) — HANDOFF-2026-10-09 Wave D ──────────────────────
//
// UI 와 같은 호출(기본 limit 500, 연도 필터 없음). 쿼리마다 전체 시간과, 돌려받은 id 로 따로 잰
// 요약 조립(note_summaries_for_ids)·스니펫용 본문 읽기(sheet::note_body_texts — populate_snippets 의 주 비용)를
// 찍는다. "id" 열 = 전체 − 요약 − 본문 = 후보 id 를 고르는 SQL(+스니펫 문자열 처리) 의 근사치.
// 이 절은 공개 API 만 쓴다 — 5d8f54bd(변경 전) 워크트리에 그대로 붙여 "before" 를 잰다.
// 실행: `BRISE_BENCH_BODY_SCALE=4 cargo test --release --test bench_question_search search_box -- --ignored --nocapture`
const SEARCH_BOX_QUERIES: &[&str] = &["프로젝트", "해운대", "커피", "부산 여행", "부산여헹", "비", "동기화 방식 고민"];

#[test]
#[ignore = "bench — cargo test --release --test bench_question_search search_box -- --ignored --nocapture"]
fn search_box_timing() {
    let n: usize = std::env::var("BRISE_BENCH_NOTES").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000);
    let scale: usize = std::env::var("BRISE_BENCH_BODY_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let n_samples = bench_samples();
    let ctx = common::setup();
    let mut conn: Connection = ctx.conn;
    let t_seed = Instant::now();
    for i in 0..n {
        let d = notes::create(&mut conn, &ctx.folder_id, Some(format!("메모 {i}")), Some(2026)).unwrap();
        let body = synth_body(i as u64, (40 + (i % 80)) * scale);
        sections::update(&mut conn, &d.sections[0].id, None, Some(body), None).unwrap();
    }
    let seed_secs = t_seed.elapsed().as_secs_f64();
    let ws = folders::active_workspace_id(&conn).unwrap();
    let avg_len: f64 = conn.query_row("SELECT AVG(LENGTH(body)) FROM notes_fts", [], |r| r.get(0)).unwrap();
    println!(
        "\n검색창 search::search — 합성 노트 {n}개(본문 평균 {avg_len:.0}자, 시드 {seed_secs:.1}s), limit 500, 워밍업 1회 뒤 각 {ROUNDS}회 평균(ms, 전체 열은 표본 {n_samples}개 평균) — {}",
        if cfg!(debug_assertions) { "debug 빌드" } else { "release 빌드" }
    );
    println!("{:<20} {:>9} {:>7} {:>7} {:>9} {:>9} {:>9}", "쿼리", "전체", "결과", "total", "요약", "본문", "id(근사)");
    let mut worst = 0.0f64;
    // 쿼리별 표본 — per_q[쿼리][회차]. 워밍업 1회 뒤 호출 하나 = 표본 하나.
    let mut per_q: Vec<Vec<f64>> = Vec::with_capacity(SEARCH_BOX_QUERIES.len());
    for q in SEARCH_BOX_QUERIES {
        let mut res = None;
        let total_samples = samples_ms(n_samples, 1, &mut || {
            res = Some(search::search(&conn, q, None, None, Some(ws.clone()), None).unwrap());
        });
        let total_ms = mean(&total_samples);
        per_q.push(total_samples);
        let r = res.unwrap();
        let ids: Vec<String> = r.results.iter().map(|s| s.id.clone()).collect();
        let summ_ms = ms(&mut || {
            let _ = notes::note_summaries_for_ids(&conn, &ids).unwrap();
        });
        let body_ms = ms(&mut || {
            let _ = brise_lib::repo::sheet::note_body_texts(&conn, &ids, None).unwrap();
        });
        worst = worst.max(total_ms);
        println!(
            "{:<20} {:>9.1} {:>7} {:>7} {:>9.1} {:>9.1} {:>9.1}",
            q,
            total_ms,
            r.results.len(),
            r.total,
            summ_ms,
            body_ms,
            (total_ms - summ_ms - body_ms).max(0.0)
        );
    }
    println!("최악 {worst:.1}ms");
    bench_json(
        "search.box_worst_ms",
        "ms",
        &worst_samples(&per_q),
        json!({ "notes": n, "body_scale": scale, "iters": 1, "queries": SEARCH_BOX_QUERIES.len() }),
    );
}

// ── 단일 노트 fts_upsert 시간 — Wave PERF (L-6) ────────────────────────────
//
// 자동 저장(update_checked 등) 시 한 노트에 대해 fts_upsert 를 부를 때 걸리는 시간.
// 이전: notes_fts 를 note_id(UNINDEXED)로 전체 스캔.
// 변경: notes_bigram_map 에서 rowid 를 찾아 rowid 로 삭제·조회.
// 표본 하나 = 트랜잭션+커밋 `FTS_ITERS` 회의 평균(1ms 안팎이라 한 번은 타이머·fsync 잡음에 묻힌다).
// 실행: `BRISE_BENCH_BODY_SCALE=4 cargo test --release --test bench_question_search fts_upsert -- --ignored --nocapture`
#[test]
#[ignore = "bench — BRISE_BENCH_BODY_SCALE=4 cargo test --release --test bench_question_search fts_upsert -- --ignored --nocapture"]
fn fts_upsert_timing() {
    let scale: usize = std::env::var("BRISE_BENCH_BODY_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let n_samples = bench_samples();
    let ctx = common::setup();
    let mut conn: Connection = ctx.conn;
    let mut note_ids = Vec::with_capacity(10_000);

    let t_seed_start = Instant::now();
    for i in 0..1_000 {
        let d = notes::create(&mut conn, &ctx.folder_id, Some(format!("메모 {i}")), Some(2026)).unwrap();
        let body = synth_body(i as u64, (40 + (i % 80)) * scale);
        sections::update(&mut conn, &d.sections[0].id, None, Some(body), None).unwrap();
        note_ids.push(d.note.id);
    }
    let target_1k = note_ids[500].clone();
    let s_1k = samples_ms(n_samples, FTS_ITERS, &mut || {
        let tx = conn.transaction().unwrap();
        brise_lib::repo::fts::fts_upsert(&tx, &target_1k).unwrap();
        tx.commit().unwrap();
    });

    for i in 1_000..10_000 {
        let d = notes::create(&mut conn, &ctx.folder_id, Some(format!("메모 {i}")), Some(2026)).unwrap();
        let body = synth_body(i as u64, (40 + (i % 80)) * scale);
        sections::update(&mut conn, &d.sections[0].id, None, Some(body), None).unwrap();
        note_ids.push(d.note.id);
    }
    let seed_total = t_seed_start.elapsed().as_secs_f64();
    let target_10k = note_ids[5000].clone();
    let s_10k = samples_ms(n_samples, FTS_ITERS, &mut || {
        let tx = conn.transaction().unwrap();
        brise_lib::repo::fts::fts_upsert(&tx, &target_10k).unwrap();
        tx.commit().unwrap();
    });

    println!(
        "\nfts_upsert 단일 노트 갱신 (scale={scale}, 시드 {seed_total:.1}s, 워밍업 {FTS_ITERS}회 뒤 {FTS_ITERS}회 평균 × 표본 {n_samples}개의 중앙값) — {}:",
        if cfg!(debug_assertions) { "debug 빌드" } else { "release 빌드" }
    );
    println!("  1,000개 노트: {:.3}ms", median(&s_1k));
    println!(" 10,000개 노트: {:.3}ms", median(&s_10k));
    bench_json("write.fts_upsert_1k_ms", "ms", &s_1k, json!({ "notes": 1_000, "body_scale": scale, "iters": FTS_ITERS }));
    bench_json("write.fts_upsert_10k_ms", "ms", &s_10k, json!({ "notes": 10_000, "body_scale": scale, "iters": FTS_ITERS }));
}
