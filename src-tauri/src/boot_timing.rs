//! 부팅 구간 계측 — `run()` 진입부터 setup 끝까지의 경과(ms)를 모아 두었다가, 환경 변수
//! `BRISE_BOOT_TIMING` 이 있을 때만 진단 로그(diag.jsonl, feature "boot", code "timing")에 한 줄로 남긴다.
//! 콜드 스타트 측정 전용이라 평소엔 기록하지 않는다(비용은 Instant 몇 개).
//! 웹뷰 쪽 구간은 프런트 `src/lib/bootMark.ts`(performance.mark) 가 맡는다.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
/// run() 진입 시각(유닉스 ms) — 웹뷰의 performance.timeOrigin 과 같은 축에 놓기 위해 함께 남긴다.
static START_EPOCH_MS: OnceLock<u128> = OnceLock::new();
static MARKS: Mutex<Vec<(&'static str, u128)>> = Mutex::new(Vec::new());

pub fn mark(name: &'static str) {
    let start = START.get_or_init(Instant::now);
    START_EPOCH_MS.get_or_init(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    });
    if let Ok(mut m) = MARKS.lock() {
        m.push((name, start.elapsed().as_millis()));
    }
}

pub fn flush() {
    if std::env::var_os("BRISE_BOOT_TIMING").is_none() {
        return;
    }
    if let Ok(m) = MARKS.lock() {
        let mut line = m.iter().map(|(n, t)| format!("{n}={t}")).collect::<Vec<_>>().join(" ");
        line.push_str(&format!(" epoch={}", START_EPOCH_MS.get().copied().unwrap_or(0)));
        crate::diag::warn("boot", "timing", line);
    }
}
