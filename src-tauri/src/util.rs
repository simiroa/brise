// 공용 헬퍼: UUIDv4 문자열, ISO8601 UTC 타임스탬프
use chrono::{Datelike, SecondsFormat};

/// `WHERE id IN (...)` 배치 로더의 청크 크기. SQLite 변수 상한(bundled=32766)에 여유를 둔 값 —
/// id 가 이보다 많으면 로더가 이 크기로 나눠 여러 쿼리로 조회하고 결과를 합친다. 상한을 넘겨
/// "too many SQL variables" 로 실패하는 것을 막는다(대규모 코퍼스). 추가 바인드(ws/year 등)가
/// 있는 쿼리도 이 여유 안에 든다.
pub const IN_CHUNK: usize = 16_000;

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 오늘 날짜(로컬 타임존, y/m/d) — note_create 의 "생성일로 자동 등록" 기본값이 UTC 자정 부근에
/// 하루 어긋나지 않도록 `now_iso()`(UTC)와 별도로 로컬 시각을 쓴다.
pub fn today_ymd_local() -> (i64, i64, i64) {
    let d = chrono::Local::now().date_naive();
    (d.year() as i64, d.month() as i64, d.day() as i64)
}
