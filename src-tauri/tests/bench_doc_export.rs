//! HWPX/DOCX 내보내기 벤치 (E-2·E-3, HANDOFF-2026-10-12-export-perf Wave ZIP).
//!
//! 그림 300장(jpg 200 × ~400KB + webp 100 × ~300KB, 합 ~110MB)이 든 노트 하나를 `export()` 로 내보내며
//! 벽시계 시간과 **힙 최고점**(이 바이너리에만 심은 계수 할당자)을 잰다. 일반 CI 에서는 돌지 않는다:
//!
//! `cargo test --release --test bench_doc_export -- --ignored --nocapture`
//!
//! 같은 파일을 이전 커밋의 스크래치 워크트리에 복사해 돌리면 before 수치가 나온다(공개 API `export` 만 쓴다).
//!
//! 사람용 줄과 함께 러너(`npm run bench` = scripts/bench/run.mjs → suites/rust.mjs)가 읽는 `BENCH-JSON` 줄을 낸다
//! (docs/PLAN-2026-10-23-perf-baselines.md §2.3·§4.1): `export.{hwpx,docx}_ms_300img` · `export.{hwpx,docx}_peak_heap_mb`.
//! 형식마다 워밍업 1회 뒤 `BRISE_BENCH_SAMPLES`(기본 5)회 — 통계는 러너가 낸다. MB = 1e6 B(사람용 줄과 같다).

use brise_lib::repo::doc_export::{export, DocExportSection, DocFormat};
use brise_lib::repo::notes;
use image::{ImageFormat, RgbImage};
use parking_lot::Mutex;
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn bump(add: usize) {
    let now = CUR.fetch_add(add, Relaxed) + add;
    PEAK.fetch_max(now, Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            bump(l.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(l);
        if !p.is_null() {
            bump(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        CUR.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            if new >= l.size() {
                bump(new - l.size());
            } else {
                CUR.fetch_sub(l.size() - new, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

/// 결정적 의사난수(xorshift) — 기울기 + 낮은 비트 잡음이라 jpg·webp 모두 수백 KB 로 떨어진다.
fn noisy(w: u32, h: u32, seed: u64, noise_mask: u8) -> RgbImage {
    let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    RgbImage::from_fn(w, h, |x, y| {
        let mut ch = [0u8; 3];
        for (c, v) in ch.iter_mut().enumerate() {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let base = ((x * 255 / w) as u8).wrapping_add((y * (c as u32 + 1) * 255 / h) as u8);
            *v = base.wrapping_add((s as u8) & noise_mask);
        }
        image::Rgb(ch)
    })
}

fn encode(img: &RgbImage, fmt: ImageFormat) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img.clone()).write_to(&mut buf, fmt).unwrap();
    buf.into_inner()
}

#[test]
#[ignore]
fn bench_export_300_images() {
    let data = tempfile::tempdir().unwrap();
    let mut conn = brise_lib::db::bootstrap(data.path()).unwrap();
    let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
    let note_id = notes::create(&mut conn, &folder_id, None, None).unwrap().note.id;
    let db = Mutex::new(conn);

    let dir = brise_lib::db::attachments_dir(data.path()).join(&note_id);
    std::fs::create_dir_all(&dir).unwrap();
    let (mut jpg_total, mut webp_total) = (0usize, 0usize);
    // 실제로 만든 장 수 — BENCH_JPG_ONLY 가 섞임을 바꾸므로 workload 는 이 집계로 적는다.
    let (mut jpg_count, mut webp_count) = (0usize, 0usize);
    let mut content = Vec::new();
    for i in 0..300u64 {
        let (name, bytes) = if i % 3 == 2 && std::env::var_os("BENCH_JPG_ONLY").is_none() {
            let b = encode(&noisy(720, 520, i, 1), ImageFormat::WebP);
            webp_total += b.len();
            webp_count += 1;
            (format!("p{i}.webp"), b)
        } else {
            let b = encode(&noisy(840, 630, i, 0x3f), ImageFormat::Jpeg);
            jpg_total += b.len();
            jpg_count += 1;
            (format!("p{i}.jpg"), b)
        };
        std::fs::write(dir.join(&name), bytes).unwrap();
        let rel = format!("{note_id}/{name}");
        content.push(json!({ "type": "paragraph", "content": [{ "type": "image", "attrs": { "src": rel, "relPath": rel, "alt": "", "title": null, "width": "50%" } }] }));
    }
    println!("fixtures: 200 jpg = {:.1} MB (avg {} KB), 100 webp = {:.1} MB (avg {} KB), total {:.1} MB", jpg_total as f64 / 1e6, jpg_total / 200 / 1024, webp_total as f64 / 1e6, webp_total / 100 / 1024, (jpg_total + webp_total) as f64 / 1e6);
    let sections = [DocExportSection { name: "s".into(), doc: json!({ "type": "doc", "content": content }) }];

    let n_samples: usize = std::env::var("BRISE_BENCH_SAMPLES").ok().and_then(|v| v.parse().ok()).filter(|&n: &usize| n >= 1).unwrap_or(5);
    let workload = json!({ "images": jpg_count + webp_count, "jpg": jpg_count, "webp": webp_count });
    let out = tempfile::tempdir().unwrap();
    for (format, ext) in [(DocFormat::Hwpx, "hwpx"), (DocFormat::Docx, "docx")] {
        let (mut ms_samples, mut heap_samples) = (Vec::with_capacity(n_samples), Vec::with_capacity(n_samples));
        // round 0 = 워밍업(파일 캐시·할당자 데우기) — 표본에서 뺀다.
        for round in 0..=n_samples {
            let dest = out.path().join(format!("bench{round}.{ext}"));
            let base = CUR.load(Relaxed);
            PEAK.store(base, Relaxed);
            let t = Instant::now();
            let res = export(&db, data.path(), &note_id, &dest.to_string_lossy(), "bench", &sections, "a4-portrait", "normal", format).unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let peak = PEAK.load(Relaxed) - base;
            let size = std::fs::metadata(&dest).unwrap().len();
            // 회차마다 ~100MB 라 바로 지운다(표본 5회 × 2형식이 임시 폴더에 쌓이지 않게) — 측정 구간 밖.
            std::fs::remove_file(&dest).unwrap();
            let tag = if round == 0 { "warmup".to_string() } else { format!("round{round}") };
            println!("BENCH {ext} {tag}: {ms:.0} ms, peak heap +{:.1} MB, file {:.1} MB, images {} skipped {}", peak as f64 / 1e6, size as f64 / 1e6, res.image_count, res.skipped_images);
            if round > 0 {
                ms_samples.push(ms);
                heap_samples.push(peak as f64 / 1e6);
            }
        }
        bench_json(&format!("export.{ext}_ms_300img"), "ms", &ms_samples, workload.clone());
        bench_json(&format!("export.{ext}_peak_heap_mb"), "MB", &heap_samples, workload.clone());
    }
}

/// `BENCH-JSON {…}` 한 줄 = 한 지표(계획 §2.3). 한 번의 `println!` 으로 낸다. workload 는 입력 매개변수만.
fn bench_json(metric: &str, unit: &str, samples: &[f64], workload: serde_json::Value) {
    let line = json!({ "metric": metric, "unit": unit, "samples": samples, "workload": workload });
    println!("BENCH-JSON {line}");
}
