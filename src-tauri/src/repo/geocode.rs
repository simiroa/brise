// repo::geocode — Nominatim(OpenStreetMap) 검색/역지오코딩의 **유일한** 관문.
//
// W14: 호출처는 6곳(usePlaceName, MapContextMenu, RegionPickerDialog, useMapNoteActions x2,
// RegionPreview) + geocode_search 1곳(MapPlaceSearch)인데 각자 독립적으로 호출한다. Nominatim은
// 클라이언트 단위(엔드포인트 단위 아님) 초당 1회가 절대 상한이라, 호출처마다 디바운스를 다는 건
// 새 호출처가 생길 때마다 또 새는 대증요법이다. 모든 호출자가 지나가는 이 모듈 한 곳에서:
//   1) 프로세스 전역 스로틀(GeocodeGate::acquire_slot) — search/reverse가 하나의 간격을 공유.
//   2) 프로세스 메모리 캐시(반올림 좌표 / 정규화 쿼리 키, TTL + 크기 상한, 실패는 캐시 안 함).
//   3) 429 백오프(연속 429마다 간격을 배로 늘리고, 성공하면 즉시 원복. 재시도는 유한 상한).
// HTTP 실제 왕복은 GeocodeTransport 트레잇 뒤로 감춰(repo::ai::transport의 TextTransport 선례와
// 동일한 모양) 테스트가 네트워크 없이 스로틀/캐시/백오프 로직만 검증할 수 있게 한다.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeocodeResult {
    pub label: String,
    pub lat: f64,
    pub lng: f64,
}

#[derive(Debug, Deserialize)]
struct NominatimReverse {
    display_name: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NominatimItem {
    display_name: Option<String>,
    lat: Option<String>,
    lon: Option<String>,
}

const USER_AGENT: &str = "BriseNoteApp/1.0 (https://github.com/simiroa/brise)";

/// Nominatim 사용 정책의 절대 상한: "An absolute maximum of 1 request per second"
/// (https://operations.osmfoundation.org/policies/nominatim/). search/reverse가 이 하나의 간격을
/// 공유한다 — 정책은 엔드포인트가 아니라 클라이언트(User-Agent) 단위이기 때문.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(1);

/// 연속 429로 간격이 무한정 벌어지지 않도록 하는 상한. 이 값에 도달하면 더 늘리지 않는다.
const MAX_BACKOFF_INTERVAL: Duration = Duration::from_secs(30);

/// 호출 하나가 429를 만나면 (커진) 간격만큼 기다렸다가 다시 시도 — 그러나 무한 재시도는 금지.
/// 1회 시도 + 최대 2회 재시도까지만이고, 그래도 안 되면 에러를 반환한다.
const MAX_ATTEMPTS: u32 = 3;

/// zoom=10 응답은 이미 "도시" 단위라 건물/도로 정밀도가 없다(geocode_reverse 주석 참고). 좌표를
/// 소수 2자리(0.01°, 적도 기준 ≈1.11km, 위도가 올라갈수록 경도 방향은 더 좁아짐)로 반올림해
/// 캐시 키를 만든다 — 사람이 사는 지역에서 서로 다른 도시가 1km 안쪽으로 붙어 있는 경우는 사실상
/// 없으므로 도시가 섞일 위험은 없고, 반대로 "같은 지점을 다시 클릭"(위젯마다 살짝 다른 소수점
/// 오차, DB에 저장된 좌표 vs. 방금 드래그한 핀)처럼 사실상 동일한 지점을 가리키는 반복 호출은
/// 안정적으로 같은 키로 수렴한다. 이보다 세밀하게(예: 소수 3자리 ≈111m) 반올림하면 zoom=10이 어차피
/// 버리는 정밀도를 캐시 키에만 남겨 캐시 적중률만 떨어뜨린다.
const REVERSE_COORD_ROUND_DECIMALS: i32 = 2;

const REVERSE_CACHE_CAPACITY: usize = 500;
const SEARCH_CACHE_CAPACITY: usize = 200;
/// 지명/주소는 거의 바뀌지 않는다 — TTL은 "오래 켜둔 세션이 언젠가 바뀐 지명을 계속 캐시"하는
/// 것만 막으면 충분해서 넉넉하게 하루로 잡는다(짧게 잡아 캐시 효과를 스스로 깎을 이유가 없다).
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 재시도까지 소진한 뒤 사용자에게 보이는 문구 — "429"라는 숫자 대신 무슨 일이 있었는지를 말한다.
const RATE_LIMITED_MESSAGE: &str =
    "Geocoding is temporarily rate-limited after repeated failures from Nominatim; try again in a moment";

/// HTTP 왕복의 실제 구현을 트레잇 뒤로 감춘다 — repo::ai::transport의 TextTransport와 같은 모양.
/// 429는 다른 실패(네트워크 오류, 5xx, 파싱 실패)와 분리된 variant로 구분해야 GeocodeGate가
/// "이건 백오프 대상"과 "이건 그냥 실패"를 문자열 매칭 없이 가른다.
#[allow(async_fn_in_trait)]
trait GeocodeTransport: Send + Sync {
    async fn search(&self, query: &str, lang: &str) -> Result<Vec<GeocodeResult>, TransportError>;
    async fn reverse(&self, lat: f64, lng: f64, lang: &str) -> Result<Option<String>, TransportError>;
}

enum TransportError {
    RateLimited,
    Other(AppError),
}

impl From<AppError> for TransportError {
    fn from(e: AppError) -> Self {
        TransportError::Other(e)
    }
}

struct RealGeocodeTransport;

impl GeocodeTransport for RealGeocodeTransport {
    async fn search(&self, query: &str, lang: &str) -> Result<Vec<GeocodeResult>, TransportError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| AppError::Io(e.to_string()))?;

        let res = client
            .get("https://nominatim.openstreetmap.org/search")
            .query(&[("format", "jsonv2"), ("limit", "8"), ("q", query)])
            .header("User-Agent", USER_AGENT)
            .header("Accept-Language", lang)
            .send()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        let status = res.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(TransportError::RateLimited);
        }
        if !status.is_success() {
            return Err(AppError::Io(format!("Geocoding service HTTP {status}")).into());
        }

        let items: Vec<NominatimItem> = res
            .json()
            .await
            .map_err(|e| AppError::Io(format!("Failed to parse geocode response: {e}")))?;

        let mut results = Vec::new();
        for item in items {
            if let (Some(label), Some(lat_str), Some(lon_str)) = (item.display_name, item.lat, item.lon) {
                if let (Ok(lat), Ok(lng)) = (lat_str.parse::<f64>(), lon_str.parse::<f64>()) {
                    results.push(GeocodeResult { label, lat, lng });
                }
            }
        }

        Ok(results)
    }

    /// 좌표 → 지명. 지도에 핀을 꽂았을 때 노트의 region 라벨을 자동으로 채우는 용도라,
    /// 전체 주소(display_name)가 아니라 사람이 부르는 짧은 이름을 우선한다.
    /// 실패는 Io — 호출부는 라벨 없이 좌표만 남기고 조용히 넘어간다.
    async fn reverse(&self, lat: f64, lng: f64, lang: &str) -> Result<Option<String>, TransportError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| AppError::Io(e.to_string()))?;

        // zoom=10 ≈ 도시 단위 — 건물 번지까지 내려가면 역사 노트의 "지역"으로는 너무 좁다.
        let url = format!(
            "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat={lat}&lon={lng}"
        );

        let res = client
            .get(&url)
            .header("User-Agent", USER_AGENT)
            .header("Accept-Language", lang)
            .send()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;

        let status = res.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(TransportError::RateLimited);
        }
        if !status.is_success() {
            return Err(AppError::Io(format!("Reverse geocoding HTTP {status}")).into());
        }

        let item: NominatimReverse = res
            .json()
            .await
            .map_err(|e| AppError::Io(format!("Failed to parse reverse geocode response: {e}")))?;

        // name 이 비어 있는 지점(바다 한가운데 등)도 있으므로 display_name 의 첫 조각으로 폴백.
        let label = item.name.filter(|s| !s.trim().is_empty()).or_else(|| {
            item.display_name
                .and_then(|d| d.split(',').next().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
        });
        Ok(label)
    }
}

struct ThrottleState {
    /// 다음 호출이 허용되는 가장 이른 시각 — 예약할 때마다 이 값 + current_gap 으로 밀어낸다.
    next_allowed: Instant,
    /// 다음 예약에 쓰일 간격. 평상시 MIN_REQUEST_INTERVAL, 429를 겪을 때마다 두 배(상한
    /// MAX_BACKOFF_INTERVAL)로 커지고 성공하면 즉시 MIN_REQUEST_INTERVAL로 원복한다.
    current_gap: Duration,
}

/// 크기 상한 + TTL만 있는 단순 캐시. 진짜 LRU(접근 순서 추적)가 아니라 삽입 순서 FIFO 축출이지만,
/// "무한히 자라지 않는다"는 요구를 채우는 데는 이걸로 충분하고 새 크레이트(lru 등)가 필요 없다.
struct BoundedCache<K, V> {
    entries: HashMap<K, (V, Instant)>,
    insertion_order: VecDeque<K>,
    capacity: usize,
    ttl: Duration,
}

impl<K: Eq + Hash + Clone, V: Clone> BoundedCache<K, V> {
    fn new(capacity: usize, ttl: Duration) -> Self {
        Self { entries: HashMap::new(), insertion_order: VecDeque::new(), capacity, ttl }
    }

    fn get(&mut self, key: &K, now: Instant) -> Option<V> {
        let (value, inserted_at) = self.entries.get(key)?;
        if now.saturating_duration_since(*inserted_at) > self.ttl {
            self.entries.remove(key);
            return None;
        }
        Some(value.clone())
    }

    /// 실패는 절대 여기로 오면 안 된다 — 호출부(call_with_gate)가 Ok 인 경우에만 put 을 부른다.
    fn put(&mut self, key: K, value: V, now: Instant) {
        if self.entries.insert(key.clone(), (value, now)).is_none() {
            self.insertion_order.push_back(key);
        }
        while self.entries.len() > self.capacity {
            match self.insertion_order.pop_front() {
                Some(oldest) => {
                    self.entries.remove(&oldest);
                }
                None => break,
            }
        }
    }
}

/// search/reverse가 공유하는 프로세스 전역 스로틀 + 캐시. now_fn 은 AiRateLimiter(sync_server::
/// handlers)와 같은 선례를 따르는 주입 가능한 시계 — 테스트가 실제로 잠들지 않고 시간 흐름을
/// 재현할 수 있게 한다. 실제 대기(tokio::time::sleep)는 reserve_slot 이 계산한 Duration 값만
/// 받으므로, 그 계산 자체(테스트가 검증하려는 부분)는 async/sleep 없이 동기적으로 검증된다.
struct GeocodeGate {
    now_fn: Box<dyn Fn() -> Instant + Send + Sync>,
    throttle: parking_lot::Mutex<ThrottleState>,
    reverse_cache: parking_lot::Mutex<BoundedCache<(i64, i64, String), Option<String>>>,
    search_cache: parking_lot::Mutex<BoundedCache<(String, String), Vec<GeocodeResult>>>,
}

impl GeocodeGate {
    fn new() -> Self {
        Self::with_clock(Box::new(Instant::now))
    }

    fn with_clock(now_fn: Box<dyn Fn() -> Instant + Send + Sync>) -> Self {
        let now = now_fn();
        Self {
            now_fn,
            throttle: parking_lot::Mutex::new(ThrottleState {
                next_allowed: now,
                current_gap: MIN_REQUEST_INTERVAL,
            }),
            reverse_cache: parking_lot::Mutex::new(BoundedCache::new(REVERSE_CACHE_CAPACITY, CACHE_TTL)),
            search_cache: parking_lot::Mutex::new(BoundedCache::new(SEARCH_CACHE_CAPACITY, CACHE_TTL)),
        }
    }

    /// 이 호출의 차례를 예약하고 얼마나 기다려야 하는지 돌려준다 — 잠들지 않는 순수 계산이라
    /// 테스트가 대기 시간 자체를 실제로 기다리지 않고 검사할 수 있다. 락은 이 산술 동안만 잡히고
    /// 절대 await 구간까지 넘어가지 않는다(DB 락과 달리 여기엔 DB가 아예 없다).
    /// 동시 호출 N개가 겹쳐도: 각자 짧은 락 구간에서 순서대로 next_allowed 를 current_gap 씩
    /// 밀어내고 즉시 락을 놓으므로, 결과적으로 N개의 예약이 gap 간격으로 정렬된다 — 락을 쥔 채
    /// 잠드는 코드가 없으므로 데드락이 생길 지점이 없다.
    fn reserve_slot(&self) -> Duration {
        let mut state = self.throttle.lock();
        let now = (self.now_fn)();
        let start = state.next_allowed.max(now);
        state.next_allowed = start + state.current_gap;
        start.saturating_duration_since(now)
    }

    async fn acquire_slot(&self) {
        let wait = self.reserve_slot();
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    fn record_429(&self) {
        let mut state = self.throttle.lock();
        state.current_gap = (state.current_gap * 2).min(MAX_BACKOFF_INTERVAL);
    }

    fn record_success(&self) {
        let mut state = self.throttle.lock();
        state.current_gap = MIN_REQUEST_INTERVAL;
    }

    #[cfg(test)]
    fn current_gap_for_test(&self) -> Duration {
        self.throttle.lock().current_gap
    }

    fn search_cache_get(&self, key: &(String, String)) -> Option<Vec<GeocodeResult>> {
        let now = (self.now_fn)();
        self.search_cache.lock().get(key, now)
    }

    fn search_cache_put(&self, key: (String, String), value: Vec<GeocodeResult>) {
        let now = (self.now_fn)();
        self.search_cache.lock().put(key, value, now);
    }

    fn reverse_cache_get(&self, key: &(i64, i64, String)) -> Option<Option<String>> {
        let now = (self.now_fn)();
        self.reverse_cache.lock().get(key, now)
    }

    fn reverse_cache_put(&self, key: (i64, i64, String), value: Option<String>) {
        let now = (self.now_fn)();
        self.reverse_cache.lock().put(key, value, now);
    }
}

fn gate() -> &'static GeocodeGate {
    static GATE: OnceLock<GeocodeGate> = OnceLock::new();
    GATE.get_or_init(GeocodeGate::new)
}

fn reverse_cache_key(lat: f64, lng: f64, lang: &str) -> (i64, i64, String) {
    let scale = 10f64.powi(REVERSE_COORD_ROUND_DECIMALS);
    ((lat * scale).round() as i64, (lng * scale).round() as i64, lang.to_string())
}

/// 스로틀 슬롯을 기다렸다가 호출하고, 429면 (커진) 간격으로 최대 MAX_ATTEMPTS 번까지 재시도한다.
/// 성공/429 판정에 따라 gate 의 간격을 갱신하는 유일한 지점 — 캐시에 넣는 건 호출부(Ok 인
/// 경우만) 몫이다.
async fn call_with_gate<T, F, Fut>(gate: &GeocodeGate, op: F) -> AppResult<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, TransportError>>,
{
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        gate.acquire_slot().await;
        match op().await {
            Ok(v) => {
                gate.record_success();
                return Ok(v);
            }
            Err(TransportError::RateLimited) => {
                gate.record_429();
                if attempt >= MAX_ATTEMPTS {
                    return Err(AppError::Io(RATE_LIMITED_MESSAGE.to_string()));
                }
                // 루프 계속 — 다음 acquire_slot() 이 이제 커진 간격만큼 기다린 뒤 재시도한다.
            }
            Err(TransportError::Other(e)) => return Err(e),
        }
    }
}

async fn geocode_search_inner<T: GeocodeTransport>(
    gate: &GeocodeGate,
    transport: &T,
    query: &str,
    lang: Option<&str>,
) -> AppResult<Vec<GeocodeResult>> {
    let q = query.trim();
    if q.is_empty() {
        return Err(AppError::Validation("query must not be empty".to_string()));
    }
    let lang = lang.unwrap_or("ko");
    let key = (q.to_lowercase(), lang.to_string());

    if let Some(hit) = gate.search_cache_get(&key) {
        return Ok(hit);
    }

    let result = call_with_gate(gate, || transport.search(q, lang)).await?;
    gate.search_cache_put(key, result.clone());
    Ok(result)
}

async fn geocode_reverse_inner<T: GeocodeTransport>(
    gate: &GeocodeGate,
    transport: &T,
    lat: f64,
    lng: f64,
    lang: Option<&str>,
) -> AppResult<Option<String>> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return Err(AppError::Validation(format!("coordinate out of range: {lat}, {lng}")));
    }
    let lang = lang.unwrap_or("ko");
    let key = reverse_cache_key(lat, lng, lang);

    if let Some(hit) = gate.reverse_cache_get(&key) {
        return Ok(hit);
    }

    let result = call_with_gate(gate, || transport.reverse(lat, lng, lang)).await?;
    gate.reverse_cache_put(key, result.clone());
    Ok(result)
}

pub async fn geocode_search(query: &str, lang: Option<&str>) -> AppResult<Vec<GeocodeResult>> {
    geocode_search_inner(gate(), &RealGeocodeTransport, query, lang).await
}

pub async fn geocode_reverse(lat: f64, lng: f64, lang: Option<&str>) -> AppResult<Option<String>> {
    geocode_reverse_inner(gate(), &RealGeocodeTransport, lat, lng, lang).await
}

/// 좌표 → IANA 시간대(geo_timezone). geocode_search/geocode_reverse 와 달리 네트워크가 없다 —
/// tzf-rs 의 내장(bundled) 경계 데이터를 프로세스당 한 번만 파싱해 재사용한다(OnceLock, DefaultFinder::new()
/// 가 매번 데이터를 디코드하는 비용을 피함). 조회 자체는 순수 연산이라 스로틀/캐시(GeocodeGate)가 필요 없다.
fn tz_finder() -> &'static tzf_rs::DefaultFinder {
    static FINDER: OnceLock<tzf_rs::DefaultFinder> = OnceLock::new();
    FINDER.get_or_init(tzf_rs::DefaultFinder::new)
}

pub fn geo_timezone(lat: f64, lng: f64) -> AppResult<Option<String>> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return Err(AppError::Validation(format!("coordinate out of range: {lat}, {lng}")));
    }
    // get_tz_name 은 매칭되는 구역이 없으면 "" 를 돌려준다(대양 한가운데 등) — None 으로 정규화.
    let name = tz_finder().get_tz_name(lng, lat);
    Ok(if name.is_empty() { None } else { Some(name.to_string()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    fn fake_clock() -> (Arc<StdMutex<Instant>>, Box<dyn Fn() -> Instant + Send + Sync>) {
        let cell = Arc::new(StdMutex::new(Instant::now()));
        let for_gate = cell.clone();
        (cell, Box::new(move || *for_gate.lock().unwrap()))
    }

    // --- 스로틀: 연속 두 요청 사이 최소 간격 보장 (동기, sleep 없음) ---

    #[test]
    fn reserve_slot_spaces_back_to_back_reservations_by_min_interval() {
        let (clock, now_fn) = fake_clock();
        let gate = GeocodeGate::with_clock(now_fn);

        assert_eq!(gate.reserve_slot(), Duration::ZERO, "첫 예약은 기다릴 필요가 없다");
        assert_eq!(
            gate.reserve_slot(),
            MIN_REQUEST_INTERVAL,
            "같은 순간(clock 이 안 흐른) 두 번째 예약은 최소 간격만큼 대기해야 한다"
        );

        // 이미 두 번 예약해 next_allowed 가 t0+2×interval 까지 밀려 있으므로, 그만큼 시계를
        // 흘려보내야 세 번째 예약이 다시 즉시 통과한다.
        *clock.lock().unwrap() += MIN_REQUEST_INTERVAL * 2;
        assert_eq!(
            gate.reserve_slot(),
            Duration::ZERO,
            "밀린 예약만큼 시간이 지난 뒤에는 대기 없이 통과해야 한다"
        );
    }

    #[test]
    fn reserve_slot_serializes_a_burst_of_concurrent_callers_by_the_gap() {
        // 세 통이 "동시에"(시계가 안 흐른 채) 예약하면 0, 1x, 2x 간격으로 벌어져야 한다 —
        // 실제 동시 호출에서 각 태스크가 얻는 wait 값과 동일한 산술.
        let (_clock, now_fn) = fake_clock();
        let gate = GeocodeGate::with_clock(now_fn);

        let waits: Vec<Duration> = (0..3).map(|_| gate.reserve_slot()).collect();
        assert_eq!(waits, vec![Duration::ZERO, MIN_REQUEST_INTERVAL, MIN_REQUEST_INTERVAL * 2]);
    }

    // --- 캐시: 같은 좌표 두 번 → 네트워크 호출 1회 ---

    struct CountingTransport {
        calls: AtomicUsize,
        reverse_label: Option<String>,
        search_results: Vec<GeocodeResult>,
    }

    impl GeocodeTransport for CountingTransport {
        async fn search(&self, _query: &str, _lang: &str) -> Result<Vec<GeocodeResult>, TransportError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.search_results.clone())
        }

        async fn reverse(&self, _lat: f64, _lng: f64, _lang: &str) -> Result<Option<String>, TransportError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.reverse_label.clone())
        }
    }

    #[tokio::test]
    async fn same_coordinate_twice_hits_the_network_once() {
        let (_clock, now_fn) = fake_clock();
        let gate = GeocodeGate::with_clock(now_fn);
        let transport = CountingTransport {
            calls: AtomicUsize::new(0),
            reverse_label: Some("Seoul".to_string()),
            search_results: vec![],
        };

        let first = geocode_reverse_inner(&gate, &transport, 37.5665, 126.9780, Some("ko")).await.unwrap();
        let second = geocode_reverse_inner(&gate, &transport, 37.5665, 126.9780, Some("ko")).await.unwrap();

        assert_eq!(first, Some("Seoul".to_string()));
        assert_eq!(second, Some("Seoul".to_string()));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1, "두 번째 호출은 캐시에서 와야 한다");
    }

    #[tokio::test]
    async fn same_query_twice_hits_the_network_once() {
        let (_clock, now_fn) = fake_clock();
        let gate = GeocodeGate::with_clock(now_fn);
        let transport = CountingTransport {
            calls: AtomicUsize::new(0),
            reverse_label: None,
            search_results: vec![GeocodeResult { label: "Seoul, KR".to_string(), lat: 37.5, lng: 127.0 }],
        };

        geocode_search_inner(&gate, &transport, "Seoul", Some("ko")).await.unwrap();
        // 대소문자/공백만 다른 같은 질의 — 정규화된 키로 수렴해야 한다.
        geocode_search_inner(&gate, &transport, "  SEOUL  ", Some("ko")).await.unwrap();

        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    }

    // --- 캐시 키: 가까운 좌표는 수렴, 먼 좌표는 분리 ---

    #[test]
    fn reverse_cache_key_converges_nearby_coordinates_but_separates_distant_ones() {
        // 같은 지점을 살짝 다른 소수점으로 가리키는 두 좌표 — 같은 키여야 한다.
        let seoul_a = reverse_cache_key(37.5665, 126.9780, "ko");
        let seoul_b = reverse_cache_key(37.5669, 126.9784, "ko");
        assert_eq!(seoul_a, seoul_b, "같은 지점 근방의 미세한 오차는 같은 캐시 키로 수렴해야 한다");

        // 서울과 부산(수백km 거리) — 분명히 다른 키여야 한다.
        let busan = reverse_cache_key(35.1796, 129.0756, "ko");
        assert_ne!(seoul_a, busan, "멀리 떨어진 도시는 절대 같은 키로 섞이면 안 된다");

        // 언어가 다르면 같은 좌표라도 키가 달라야 한다(라벨 언어가 다르므로).
        let seoul_en = reverse_cache_key(37.5665, 126.9780, "en");
        assert_ne!(seoul_a, seoul_en);
    }

    // --- 실패는 캐시되지 않는다 ---

    struct FlakyThenOkTransport {
        calls: AtomicUsize,
        fail_first_n: usize,
    }

    impl GeocodeTransport for FlakyThenOkTransport {
        async fn search(&self, _query: &str, _lang: &str) -> Result<Vec<GeocodeResult>, TransportError> {
            unimplemented!("이 테스트는 reverse 만 쓴다")
        }

        async fn reverse(&self, _lat: f64, _lng: f64, _lang: &str) -> Result<Option<String>, TransportError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.fail_first_n {
                Err(AppError::Io("boom".to_string()).into())
            } else {
                Ok(Some("Recovered".to_string()))
            }
        }
    }

    #[tokio::test]
    async fn a_failed_call_is_not_cached_so_the_next_call_hits_the_network_again() {
        let (_clock, now_fn) = fake_clock();
        let gate = GeocodeGate::with_clock(now_fn);
        let transport = FlakyThenOkTransport { calls: AtomicUsize::new(0), fail_first_n: 1 };

        let first = geocode_reverse_inner(&gate, &transport, 1.0, 1.0, Some("ko")).await;
        assert!(first.is_err(), "네트워크/기타 실패는 그대로 에러여야 한다");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let second = geocode_reverse_inner(&gate, &transport, 1.0, 1.0, Some("ko")).await;
        assert_eq!(second.unwrap(), Some("Recovered".to_string()));
        assert_eq!(
            transport.calls.load(Ordering::SeqCst),
            2,
            "실패가 캐시됐다면 두 번째 호출도 네트워크를 안 탔을 것이다"
        );
    }

    // --- 429 백오프: 간격이 늘고, 성공하면 원복 ---

    #[test]
    fn backoff_doubles_on_429_and_caps_then_resets_on_success() {
        let (_clock, now_fn) = fake_clock();
        let gate = GeocodeGate::with_clock(now_fn);

        assert_eq!(gate.current_gap_for_test(), MIN_REQUEST_INTERVAL);
        gate.record_429();
        assert_eq!(gate.current_gap_for_test(), MIN_REQUEST_INTERVAL * 2);
        gate.record_429();
        assert_eq!(gate.current_gap_for_test(), MIN_REQUEST_INTERVAL * 4);

        // 상한을 넘지 않는지 — 여러 번 더 때려도 MAX_BACKOFF_INTERVAL 을 넘지 않는다.
        for _ in 0..10 {
            gate.record_429();
        }
        assert_eq!(gate.current_gap_for_test(), MAX_BACKOFF_INTERVAL);

        gate.record_success();
        assert_eq!(gate.current_gap_for_test(), MIN_REQUEST_INTERVAL, "성공하면 즉시 원복해야 한다");
    }

    struct RateLimitedTransport {
        calls: AtomicUsize,
        fail_first_n: usize,
    }

    impl GeocodeTransport for RateLimitedTransport {
        async fn search(&self, _query: &str, _lang: &str) -> Result<Vec<GeocodeResult>, TransportError> {
            unimplemented!("이 테스트는 reverse 만 쓴다")
        }

        async fn reverse(&self, _lat: f64, _lng: f64, _lang: &str) -> Result<Option<String>, TransportError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.fail_first_n {
                Err(TransportError::RateLimited)
            } else {
                Ok(Some("ok after backoff".to_string()))
            }
        }
    }

    /// start_paused: 실제 초 단위 대기 없이(가상 시계가 자동 전진) 재시도 경로 전체(스로틀 대기
    /// 포함)를 실제로 태워본다 — reserve_slot 단위 테스트가 계산만 검증하는 것과 달리, 여기는
    /// acquire_slot 의 tokio::time::sleep 까지 실제로 도는 통합 경로.
    #[tokio::test(start_paused = true)]
    async fn rate_limited_then_recovers_within_the_attempt_cap() {
        let gate = GeocodeGate::new();
        let transport = RateLimitedTransport { calls: AtomicUsize::new(0), fail_first_n: 1 };

        let result = geocode_reverse_inner(&gate, &transport, 1.0, 1.0, Some("ko")).await;

        assert_eq!(result.unwrap(), Some("ok after backoff".to_string()));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2, "1회 실패 + 1회 재시도로 성공해야 한다");
        assert_eq!(gate.current_gap_for_test(), MIN_REQUEST_INTERVAL, "성공했으니 간격은 원복돼 있어야 한다");
    }

    #[tokio::test(start_paused = true)]
    async fn rate_limited_beyond_the_attempt_cap_gives_up_with_a_readable_error() {
        let gate = GeocodeGate::new();
        // 항상 429 — MAX_ATTEMPTS 를 넘겨도 절대 회복하지 않는다.
        let transport = RateLimitedTransport { calls: AtomicUsize::new(0), fail_first_n: u32::MAX as usize };

        let result = geocode_reverse_inner(&gate, &transport, 1.0, 1.0, Some("ko")).await;

        let err = result.unwrap_err();
        match err {
            AppError::Io(msg) => {
                assert!(!msg.contains("429"), "사용자 문구는 상태 코드 숫자를 그대로 노출하면 안 된다: {msg}");
                assert!(msg.to_lowercase().contains("rate"), "무슨 일인지는 알 수 있어야 한다: {msg}");
            }
            other => panic!("429 소진은 AppError::Io 여야 한다, got {other:?}"),
        }
        assert_eq!(
            transport.calls.load(Ordering::SeqCst),
            MAX_ATTEMPTS as usize,
            "정확히 MAX_ATTEMPTS 번만 시도하고 포기해야 한다(무한 재시도 금지)"
        );
        assert_eq!(
            gate.current_gap_for_test(),
            MIN_REQUEST_INTERVAL * 2u32.pow(MAX_ATTEMPTS),
            "포기한 뒤에도 간격은 커진 채로 남아 다음 독립 호출을 늦춰야 한다(record_429 는 실패한 시도마다 불린다)"
        );
    }

    // --- geo_timezone: 오프라인 좌표 → IANA 시간대(bundled 데이터가 인접 구역을 구분하는지 포함) ---

    #[test]
    fn geo_timezone_resolves_known_capitals_to_their_exact_iana_zone() {
        assert_eq!(geo_timezone(37.5665, 126.9780).unwrap(), Some("Asia/Seoul".to_string()));
        assert_eq!(geo_timezone(48.8566, 2.3522).unwrap(), Some("Europe/Paris".to_string()));
        assert_eq!(geo_timezone(40.7128, -74.0060).unwrap(), Some("America/New_York".to_string()));
    }

    #[test]
    fn geo_timezone_rejects_out_of_range_coordinates() {
        assert!(matches!(geo_timezone(999.0, 0.0), Err(AppError::Validation(_))));
        assert!(matches!(geo_timezone(0.0, -999.0), Err(AppError::Validation(_))));
    }
}
