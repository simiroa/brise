// 원격 invoke 경로의 ai_* 커맨드 토큰 버킷 — invoke.rs 가 remote_policy::is_ai_command 판정 뒤에
// try_acquire() 를 부른다.

/// 원격(HTTP POST /api/v1/invoke) 경로로 들어오는 ai_* 커맨드 전용 토큰 버킷 — burst 15, 시간당
/// 60개 리필(SECURITY-REVIEW-2026-08-04.md #2/#3: 이상 패턴 감지용 보수적 상한, 정상적인 사람
/// 사용으로는 도달 불가). 데스크톱 로컬 IPC는 이 버킷을 전혀 거치지 않는다.
///
/// governor 크레이트를 들일 만큼의 코드가 아니라 직접 구현 — Instant::now 를 그대로
/// 박아두는 대신 주입 가능한 now_fn 을 들고 있어 테스트가 시간 흐름을 직접 재현할 수 있다.
pub(crate) struct AiRateLimiter {
    inner: parking_lot::Mutex<AiRateLimiterState>,
    now_fn: Box<dyn Fn() -> std::time::Instant + Send + Sync>,
}

struct AiRateLimiterState {
    tokens: f64,
    last_refill: std::time::Instant,
}

const AI_RATE_LIMIT_BURST: f64 = 15.0;
const AI_RATE_LIMIT_REFILL_PER_HOUR: f64 = 60.0;

impl AiRateLimiter {
    pub(crate) fn new() -> Self {
        Self::with_clock(Box::new(std::time::Instant::now))
    }

    fn with_clock(now_fn: Box<dyn Fn() -> std::time::Instant + Send + Sync>) -> Self {
        let now = now_fn();
        Self {
            inner: parking_lot::Mutex::new(AiRateLimiterState { tokens: AI_RATE_LIMIT_BURST, last_refill: now }),
            now_fn,
        }
    }

    /// 토큰이 있으면 하나 소비하고 true, 없으면 false(429 사유). 호출할 때마다 경과 시간만큼
    /// 먼저 리필한다 — 별도 백그라운드 타이머 없이 lazy refill.
    pub(super) fn try_acquire(&self) -> bool {
        let now = (self.now_fn)();
        let mut state = self.inner.lock();
        let elapsed_hours = now.saturating_duration_since(state.last_refill).as_secs_f64() / 3600.0;
        state.tokens = (state.tokens + elapsed_hours * AI_RATE_LIMIT_REFILL_PER_HOUR).min(AI_RATE_LIMIT_BURST);
        state.last_refill = now;
        if state.tokens >= 1.0 {
            state.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Burst of AI_RATE_LIMIT_BURST (15) requests must all pass, the 16th must be refused,
    /// and after simulating enough elapsed time for a refill, a request must succeed again. Drives
    /// a fake clock via a shared cell so the test doesn't need to sleep in wall-clock time.
    #[test]
    fn ai_rate_limiter_allows_burst_then_refuses_then_refills_after_simulated_time() {
        let clock = std::sync::Arc::new(parking_lot::Mutex::new(std::time::Instant::now()));
        let limiter = {
            let clock = clock.clone();
            AiRateLimiter::with_clock(Box::new(move || *clock.lock()))
        };

        for i in 0..15 {
            assert!(limiter.try_acquire(), "request {i} within the burst of 15 must be allowed");
        }
        assert!(!limiter.try_acquire(), "the 16th request must be refused — burst exhausted");

        // Refill is 60/hour == 1 token/minute — advance the fake clock 90 seconds for one token.
        *clock.lock() += std::time::Duration::from_secs(90);
        assert!(limiter.try_acquire(), "after ~1.5 minutes, at least one token must have refilled");
        assert!(!limiter.try_acquire(), "only one token refilled — the next request must be refused again");
    }
}
