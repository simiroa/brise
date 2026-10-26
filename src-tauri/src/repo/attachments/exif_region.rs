// repo::attachments::exif_region — 사진(EXIF)·음성(업로드 쿼리)의 메타 → 노트 날짜·경유지 자동 반영.
//
// 데스크톱 attachment_add_file/attachment_add_bytes 커맨드와 모바일 업로드
// (sync_server::handlers::attachment_upload) 두 진입 경로가 모두 repo::attachments::add_file 로
// 수렴한 뒤, 썸네일과 같은 "커밋 후 후속 단계"로 이 훅을 fire-and-forget 호출한다.
// 어떤 실패(EXIF 파싱/지오코딩/네트워크/DB)도 첨부 추가 자체를 실패시키지 않는다 — 로그 후 삼킨다.
//
// 결정(docs/PLAN-2026-10-06-s2-input.md §1, docs/NOTES.md "첨부 메타 자동 반영"):
// - 정책은 설정 `photo_meta_mode`(off|ask|auto, 기본 auto) 한 개다. off 면 EXIF 읽기·지오코딩
//   (외부 요청) 전부 생략. ask 면 반영 대신 `attachment-meta-suggested` 이벤트만, auto 면 반영 뒤
//   `attachment-meta-applied`(되돌리기용 row id 포함). 오디오는 키를 따로 두지 않고 같은 키를 따른다.
// - 덮어쓰지 않는다: 대표 날짜는 **연 정밀도뿐일 때만**(= 사실상 비어 있을 때) 채우고, 아니면 관련
//   날짜(position>0)로 붙인다. 같은 날 행이 이미 있으면(연사) 추가하지 않는다. 지역은 비어 있으면
//   첫 지역(대표), 아니면 경유지이며 100m 안 기존 경유지가 있으면 건너뛴다.
use crate::db;
use crate::error::AppResult;
use chrono::{Datelike, Timelike};
use std::future::Future;
use std::path::Path;
use std::sync::Mutex;

/// 이미 ~이 반경 안에 경유지가 있으면 자동 등록을 건너뛴다(같은 장소 연사 사진 dedupe).
const DEDUPE_RADIUS_M: f64 = 100.0;

/// 같은 노트로 연사 N장이 동시에 훅을 돌 때 "확인 → 삽입" 사이에 끼어들어 중복 행을 만들지 않게
/// 반영(apply)을 직렬화한다. ponytail: 프로세스 전역 락 — 반영은 ms 단위 DB 쓰기뿐이라 충분하다.
static APPLY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MetaMode {
    Off,
    Ask,
    Auto,
}

impl MetaMode {
    /// 알 수 없는 값은 Auto — validate_setting 이 "off|ask|auto" 만 저장시키므로 손상 값에서만 탄다.
    fn parse(v: Option<&serde_json::Value>) -> Self {
        match v.and_then(|v| v.as_str()) {
            Some("off") => Self::Off,
            Some("ask") => Self::Ask,
            _ => Self::Auto,
        }
    }
}

/// 촬영/녹음 시각(로컬 벽시계) — 시간대 변환 없이 찍힌 그대로의 날짜·"HH:MM".
#[derive(Clone, Debug, PartialEq)]
pub struct Taken {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub time: Option<String>,
}

/// 첨부 한 개에서 얻은 메타 — EXIF 또는 업로드 쿼리(recorded_at/lat/lng).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PhotoMeta {
    pub gps: Option<(f64, f64)>,
    pub taken: Option<Taken>,
}

fn valid_coord(lat: f64, lng: f64) -> bool {
    // contains 는 NaN 에 false — denominator 0 / 비정상 입력이 여기서 걸러진다.
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng)
}

impl PhotoMeta {
    fn or(self, other: PhotoMeta) -> PhotoMeta {
        PhotoMeta {
            gps: self.gps.or(other.gps),
            taken: self.taken.or(other.taken),
        }
    }

    /// 업로드 쿼리(recorded_at RFC3339 · lat · lng)에서. 깨진 값은 None — 첨부는 그대로 유효하다.
    pub fn from_upload(recorded_at: Option<&str>, lat: Option<f64>, lng: Option<f64>) -> PhotoMeta {
        let gps = match (lat, lng) {
            (Some(a), Some(b)) if valid_coord(a, b) => Some((a, b)),
            _ => None,
        };
        let taken = recorded_at
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| {
                // 보낸 쪽 벽시계를 쓴다(오프셋이 붙은 로컬 시각). 'Z'(UTC) 로 오면 벽시계가 UTC 라 서버 로컬로 바꾼다.
                // ponytail: 진짜 UTC+0 사용자의 폰도 서버 로컬로 환산된다 — 폰과 PC 가 같은 지역이라는 가정.
                if dt.offset().local_minus_utc() == 0 {
                    dt.with_timezone(&chrono::Local).naive_local()
                } else {
                    dt.naive_local()
                }
            })
            .and_then(|dt| {
                taken_of(
                    dt.year() as i64,
                    dt.month() as i64,
                    dt.day() as i64,
                    Some((dt.hour(), dt.minute())),
                )
            });
        PhotoMeta { gps, taken }
    }

    fn is_empty(&self) -> bool {
        self.gps.is_none() && self.taken.is_none()
    }
}

/// 실재하는 날짜·1900년 이후만(카메라 시계 미설정 "0000:00:00" 류 쓰레기 값 거름).
fn taken_of(year: i64, month: i64, day: i64, hm: Option<(u32, u32)>) -> Option<Taken> {
    if year < 1900 {
        return None;
    }
    chrono::NaiveDate::from_ymd_opt(year as i32, u32::try_from(month).ok()?, u32::try_from(day).ok()?)?;
    Some(Taken {
        year,
        month,
        day,
        time: hm.map(|(h, m)| format!("{h:02}:{m:02}")),
    })
}

/// EXIF 에서 GPS + 촬영시각을 **한 번 열어서** 함께 뽑는다 — 없음/비이미지/파싱 실패는 전부 빈
/// 메타(호출부는 조용히 skip).
pub fn meta_from_file(path: &Path) -> PhotoMeta {
    let Ok(file) = std::fs::File::open(path) else {
        return PhotoMeta::default();
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return PhotoMeta::default();
    };
    PhotoMeta {
        gps: gps_of(&exif),
        taken: taken_from_exif(&exif),
    }
}

fn gps_of(exif: &exif::Exif) -> Option<(f64, f64)> {
    let lat = gps_coord(exif, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, b"S")?;
    let lng = gps_coord(exif, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, b"W")?;
    valid_coord(lat, lng).then_some((lat, lng))
}

fn taken_from_exif(exif: &exif::Exif) -> Option<Taken> {
    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    let exif::Value::Ascii(ref v) = field.value else {
        return None;
    };
    let dt = exif::DateTime::from_ascii(v.first()?).ok()?;
    let hm = (dt.hour < 24 && dt.minute < 60).then_some((dt.hour as u32, dt.minute as u32));
    taken_of(dt.year as i64, dt.month as i64, dt.day as i64, hm)
}

fn gps_coord(
    exif: &exif::Exif,
    tag: exif::Tag,
    ref_tag: exif::Tag,
    negative_ref: &[u8],
) -> Option<f64> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Rational(ref v) = field.value else {
        return None;
    };
    if v.len() < 3 {
        return None;
    }
    let deg = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
    let negative = matches!(
        exif.get_field(ref_tag, exif::In::PRIMARY),
        Some(f) if matches!(&f.value, exif::Value::Ascii(a) if a.first().map(Vec::as_slice) == Some(negative_ref))
    );
    Some(if negative { -deg } else { deg })
}

/// 등거리 근사(equirectangular) 거리(m) — 100m 스케일 dedupe 판정에는 충분한 정밀도.
fn distance_m(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    const R: f64 = 6_371_000.0;
    let x = (lng2 - lng1).to_radians() * ((lat1 + lat2) / 2.0).to_radians().cos();
    let y = (lat2 - lat1).to_radians();
    (x * x + y * y).sqrt() * R
}

/// 노트에 DEDUPE_RADIUS_M 안 기존 경유지가 있으면 true.
pub fn has_region_within(
    conn: &rusqlite::Connection,
    note_id: &str,
    lat: f64,
    lng: f64,
) -> AppResult<bool> {
    let regions = crate::repo::notes::regions_list(conn, note_id)?;
    Ok(regions
        .iter()
        .any(|r| distance_m(r.lat, r.lng, lat, lng) <= DEDUPE_RADIUS_M))
}

/// 이 날짜를 반영할지 — 대표 날짜는 절대 덮어쓰지 않고(연 정밀도 대표도 사용자가 정한 값이다) 항상 관련 날짜로
/// 붙인다. 이미 그날 행이 있으면(연사 dedupe) false.
fn date_wanted(conn: &rusqlite::Connection, note_id: &str, t: &Taken) -> AppResult<bool> {
    let rows = crate::repo::notes::dates_list(conn, note_id)?;
    Ok(!rows
        .iter()
        .any(|r| r.year == t.year && r.month == Some(t.month) && r.day == Some(t.day)))
}

/// 반영 결과 — 되돌리기에 필요한 행 id 를 싣는다.
#[derive(Debug, Default)]
pub struct Applied {
    /// 새로 만든 관련 날짜 행(되돌리기 = date_remove).
    pub date_row_id: Option<String>,
    pub region_row_id: Option<String>,
    pub summary: String,
}

impl Applied {
    fn is_empty(&self) -> bool {
        self.date_row_id.is_none() && self.region_row_id.is_none()
    }
}

/// 반영 본체(동기) — 확인과 삽입을 APPLY_LOCK 안에서 다시 한다. `label` = 관련 날짜 라벨("사진"/"음성").
pub fn apply(
    conn: &mut rusqlite::Connection,
    note_id: &str,
    meta: &PhotoMeta,
    region_name: Option<&str>,
    label: &str,
) -> AppResult<Applied> {
    let _g = APPLY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Applied::default();
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = &meta.taken {
        if date_wanted(conn, note_id, t)? {
            out.date_row_id = Some(crate::repo::notes::date_add(
                conn, note_id, t.year, Some(t.month), Some(t.day), None, None, None, t.time.clone(), None, false,
                None, None, Some(label.to_string()),
            )?);
            parts.push(format!("{:04}-{:02}-{:02}", t.year, t.month, t.day));
        }
    }
    if let (Some((lat, lng)), Some(name)) = (meta.gps, region_name) {
        // 지오코딩(수 초) 동안 다른 경로가 같은 장소를 넣었을 수 있으니 삽입 직전 재확인.
        if !has_region_within(conn, note_id, lat, lng)? {
            let pos = crate::repo::notes::regions_list(conn, note_id)?.len() as i64;
            out.region_row_id = Some(crate::repo::notes::region_add(conn, note_id, name, lat, lng, pos)?);
            parts.push(name.to_string());
        }
    }
    out.summary = parts.join(" · ");
    Ok(out)
}

fn read_mode(db_path: &Path) -> AppResult<MetaMode> {
    let conn = db::open(db_path)?;
    let all = crate::repo::settings::get_all(&conn)?;
    Ok(MetaMode::parse(all.get("photo_meta_mode")))
}

/// 실제 역지오코딩 — 실패/오프라인이면 좌표 문자열 폴백.
async fn geocode_label(lat: f64, lng: f64) -> String {
    match crate::repo::geocode::geocode_reverse(lat, lng, None).await {
        Ok(Some(label)) => label,
        Ok(None) => format!("{lat:.4}, {lng:.4}"),
        Err(e) => {
            crate::diag::warn("attachments", "geocode_fallback", format!("{e}"));
            format!("{lat:.4}, {lng:.4}")
        }
    }
}

/// 첨부 커밋 후 훅 본체. 호출자(post_add)가 원격 업로드면 events 의 origin 스코프를 씌운다.
/// `kind` = "image"(EXIF 를 읽는다) | "audio"(hint 만). `hint` = 업로드 쿼리 메타 — 이미지에선 EXIF 에
/// 없는 값만 채운다.
/// sync_server 와 같은 규약으로 요청별 db::open 을 쓴다(WAL + busy_timeout, 커맨드 락과 공존).
pub async fn auto_meta(
    data_dir: &Path,
    note_id: &str,
    rel_path: &str,
    kind: &str,
    hint: Option<PhotoMeta>,
) {
    auto_meta_with(data_dir, note_id, rel_path, kind, hint, geocode_label).await
}

async fn auto_meta_with<G, Fut>(
    data_dir: &Path,
    note_id: &str,
    rel_path: &str,
    kind: &str,
    hint: Option<PhotoMeta>,
    geocode: G,
) where
    G: Fn(f64, f64) -> Fut,
    Fut: Future<Output = String>,
{
    let db_path = db::db_path(data_dir);

    // 1) 정책 — off 면 EXIF 읽기·지오코딩 전부 생략(외부 요청 0).
    let mode = match tokio::task::spawn_blocking({
        let db_path = db_path.clone();
        move || read_mode(&db_path)
    })
    .await
    {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => {
            crate::diag::warn("attachments", "meta_mode_read_failed", format!("{e}"));
            return;
        }
        Err(e) => {
            crate::diag::warn("attachments", "exif_worker_join_failed", format!("{e}"));
            return;
        }
    };
    if mode == MetaMode::Off {
        return;
    }

    // 2) 메타 — EXIF 읽기는 파일 I/O 라 커맨드 스레드/런타임을 막지 않는다(썸네일과 같은 규약).
    let mut meta = hint.unwrap_or_default();
    if kind == "image" {
        let Ok(clean) = crate::repo::paths::safe_rel(rel_path) else {
            return;
        };
        let path = db::attachments_dir(data_dir).join(clean);
        let exif = tokio::task::spawn_blocking(move || meta_from_file(&path))
            .await
            .unwrap_or_default();
        meta = exif.or(meta);
    }
    if meta.is_empty() {
        return;
    }
    let label = if kind == "audio" { "음성" } else { "사진" };

    // 3) 지오코딩(네트워크, 최대 10s) 전에 싼 선확인 — 이미 반영된 날짜/장소면 요청을 낭비하지 않는다.
    let pre = tokio::task::spawn_blocking({
        let (db_path, note_id, meta) = (db_path.clone(), note_id.to_string(), meta.clone());
        move || -> AppResult<(bool, bool)> {
            let conn = db::open(&db_path)?;
            let want_date = match &meta.taken {
                Some(t) => date_wanted(&conn, &note_id, t)?,
                None => false,
            };
            let want_region = match meta.gps {
                Some((lat, lng)) => !has_region_within(&conn, &note_id, lat, lng)?,
                None => false,
            };
            Ok((want_date, want_region))
        }
    })
    .await;
    let (want_date, want_region) = match pre {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            crate::diag::warn("attachments", "exif_dedupe_check_failed", format!("{e}"));
            return;
        }
        Err(e) => {
            crate::diag::warn("attachments", "exif_worker_join_failed", format!("{e}"));
            return;
        }
    };
    if !want_date && !want_region {
        return;
    }
    // ask 는 동의 전이라 외부 요청을 하지 않는다 — 제안엔 좌표 문자열을 싣고, 이름은 auto 반영 때만 얻는다.
    let region_name = match meta.gps {
        Some((lat, lng)) if want_region && mode == MetaMode::Auto => Some(geocode(lat, lng).await),
        Some((lat, lng)) if want_region => Some(format!("{lat:.4}, {lng:.4}")),
        _ => None,
    };

    // 4) 정책별 처리.
    if mode == MetaMode::Ask {
        let mut payload = serde_json::json!({ "note_id": note_id });
        if let (true, Some(t)) = (want_date, &meta.taken) {
            payload["date"] =
                serde_json::json!({ "year": t.year, "month": t.month, "day": t.day, "time": t.time });
        }
        if let (Some(name), Some((lat, lng))) = (&region_name, meta.gps) {
            payload["region"] = serde_json::json!({ "name": name, "lat": lat, "lng": lng });
        }
        crate::events::publish_event("attachment-meta-suggested", payload);
        return;
    }
    let applied = tokio::task::spawn_blocking({
        let (db_path, note_id, meta) = (db_path.clone(), note_id.to_string(), meta.clone());
        move || -> AppResult<Applied> {
            let mut conn = db::open(&db_path)?;
            apply(&mut conn, &note_id, &meta, region_name.as_deref(), label)
        }
    })
    .await;
    match applied {
        Ok(Ok(a)) if !a.is_empty() => {
            // note_region_add/note_date_add 커맨드 래퍼와 같은 갱신 신호 + 토스트용 전용 이벤트.
            crate::events::publish(Some(note_id), false);
            crate::events::publish_event(
                "attachment-meta-applied",
                serde_json::json!({
                    "note_id": note_id,
                    "date_row_id": a.date_row_id,
                    "region_row_id": a.region_row_id,
                    "summary": a.summary,
                }),
            );
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => crate::diag::warn("attachments", "meta_apply_failed", format!("{e}")),
        Err(e) => crate::diag::warn("attachments", "exif_worker_join_failed", format!("{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::notes::{date_update, dates_list, region_add, regions_list};
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn rat(num: u32, denom: u32) -> exif::Rational {
        exif::Rational { num, denom }
    }

    /// 최소 JPEG(SOI + Exif APP1 + EOI)를 바이트로 조립 — EXIF 는 exif crate 의 experimental
    /// Writer 로 만든 TIFF 버퍼를 APP1 페이로드로 감싼다. `gps` = (lat_ref, lng_ref),
    /// `taken` = "YYYY:MM:DD HH:MM:SS".
    fn jpeg_with(gps: Option<(&[u8], &[u8])>, taken: Option<&str>) -> Vec<u8> {
        use exif::experimental::Writer;
        let mut fields: Vec<exif::Field> = Vec::new();
        let field = |tag, value| exif::Field { tag, ifd_num: exif::In::PRIMARY, value };
        if let Some((lat_ref, lng_ref)) = gps {
            // 37° 33' 59.4" / 126° 58' 40.8" ≈ 서울 시청 근방.
            fields.push(field(
                exif::Tag::GPSLatitude,
                exif::Value::Rational(vec![rat(37, 1), rat(33, 1), rat(594, 10)]),
            ));
            fields.push(field(exif::Tag::GPSLatitudeRef, exif::Value::Ascii(vec![lat_ref.to_vec()])));
            fields.push(field(
                exif::Tag::GPSLongitude,
                exif::Value::Rational(vec![rat(126, 1), rat(58, 1), rat(408, 10)]),
            ));
            fields.push(field(exif::Tag::GPSLongitudeRef, exif::Value::Ascii(vec![lng_ref.to_vec()])));
        }
        if let Some(t) = taken {
            fields.push(field(exif::Tag::DateTimeOriginal, exif::Value::Ascii(vec![t.as_bytes().to_vec()])));
        }
        if fields.is_empty() {
            // Writer 는 빈 IFD 를 못 쓴다 — "EXIF 는 있되 GPS·촬영시각은 없음" 은 방향 태그 하나로 만든다.
            fields.push(field(exif::Tag::Orientation, exif::Value::Short(vec![1])));
        }
        let mut writer = Writer::new();
        for f in &fields {
            writer.push_field(f);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        writer.write(&mut cursor, false).unwrap();
        let tiff = cursor.into_inner();

        let mut jpeg = vec![0xFF, 0xD8]; // SOI
        jpeg.extend_from_slice(&[0xFF, 0xE1]); // APP1
        // 세그먼트 길이 = 길이 필드(2) + "Exif\0\0"(6) + TIFF 본문.
        jpeg.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&tiff);
        jpeg.extend_from_slice(&[0xFF, 0xD9]); // EOI
        jpeg
    }

    fn meta_of(bytes: Vec<u8>) -> PhotoMeta {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.jpg");
        std::fs::write(&p, bytes).unwrap();
        meta_from_file(&p)
    }

    const SHOT: &str = "2026:10:03 14:32:05";

    fn shot() -> Taken {
        Taken { year: 2026, month: 10, day: 3, time: Some("14:32".into()) }
    }

    #[test]
    fn meta_from_file_fixture_matrix() {
        // 둘 다.
        let both = meta_of(jpeg_with(Some((b"N", b"E")), Some(SHOT)));
        let (lat, lng) = both.gps.expect("GPS present");
        assert!((lat - 37.5665).abs() < 0.001, "lat={lat}");
        assert!((lng - 126.9780).abs() < 0.001, "lng={lng}");
        assert_eq!(both.taken, Some(shot()));
        // 촬영시각만.
        let only_time = meta_of(jpeg_with(None, Some(SHOT)));
        assert_eq!((only_time.gps, only_time.taken), (None, Some(shot())));
        // GPS 만.
        let only_gps = meta_of(jpeg_with(Some((b"N", b"E")), None));
        assert!(only_gps.gps.is_some() && only_gps.taken.is_none());
        // 둘 다 없음(EXIF 는 있되 필드 없음 / EXIF 자체 없음).
        assert!(meta_of(jpeg_with(None, None)).is_empty());
        assert!(meta_of(b"not a jpeg".to_vec()).is_empty());
        // 카메라 시계 미설정 쓰레기 값은 날짜로 치지 않는다.
        assert_eq!(meta_of(jpeg_with(None, Some("0000:00:00 00:00:00"))).taken, None);
        assert_eq!(meta_of(jpeg_with(None, Some("2026:02:31 10:00:00"))).taken, None);
    }

    #[test]
    fn meta_from_file_reads_hemisphere_refs() {
        // 남·서반구 ref → 부호 반전.
        let m = meta_of(jpeg_with(Some((b"S", b"W")), None));
        let (lat, lng) = m.gps.expect("GPS present");
        assert!(lat < 0.0 && lng < 0.0, "{lat}, {lng}");
    }

    #[test]
    fn meta_from_file_empty_for_image_without_exif() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("plain.png");
        let img = image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]));
        img.save(&p).unwrap();
        assert!(meta_from_file(&p).is_empty());
    }

    #[test]
    fn from_upload_parses_rfc3339_local_wall_clock_and_rejects_garbage() {
        // 오프셋이 있어도 찍힌 곳의 벽시계 날짜/시각 그대로(UTC 로 밀지 않는다).
        let m = PhotoMeta::from_upload(Some("2026-10-03T23:50:00+09:00"), Some(37.5), Some(127.0));
        assert_eq!(m.gps, Some((37.5, 127.0)));
        assert_eq!(m.taken, Some(Taken { year: 2026, month: 10, day: 3, time: Some("23:50".into()) }));
        // 한쪽만/범위 밖 좌표/깨진 시각은 버린다.
        assert!(PhotoMeta::from_upload(Some("garbage"), Some(37.5), None).is_empty());
        assert!(PhotoMeta::from_upload(None, Some(91.0), Some(0.0)).is_empty());
        assert!(PhotoMeta::from_upload(None, Some(f64::NAN), Some(0.0)).is_empty());
    }

    fn setup_db() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // year 만 준 노트 = 대표 날짜가 연 정밀도뿐(비어 있음).
        let n = crate::repo::notes::create(&mut conn, &folder_id, Some("Trip".into()), Some(2026))
            .unwrap();
        (conn, n.note.id)
    }

    /// 대표를 일 정밀도 `y-m-d` 로 못 박는다(= 사용자가 정한 대표 날짜).
    fn pin_primary(conn: &mut Connection, note_id: &str, y: i64, m: i64, d: i64) -> String {
        let id = dates_list(conn, note_id).unwrap()[0].id.clone();
        date_update(conn, &id, y, Some(m), Some(d), None, None, None, None, None, false, None, None, None).unwrap();
        id
    }

    #[test]
    fn dedupe_within_100m_skips_but_farther_does_not() {
        let (mut conn, note_id) = setup_db();
        region_add(&mut conn, &note_id, "서울시청", 37.5665, 126.9780, 0).unwrap();
        // ~50m 북쪽 (위도 1도 ≈ 111km → 0.00045도 ≈ 50m) → dedupe.
        assert!(has_region_within(&conn, &note_id, 37.56695, 126.9780).unwrap());
        // ~500m → 새 장소로 취급.
        assert!(!has_region_within(&conn, &note_id, 37.5710, 126.9780).unwrap());
        // 경유지 없는 노트 좌표는 항상 false 가 아니라, 같은 노트 기준으로만 판정한다.
        assert!(!has_region_within(&conn, &note_id, 0.0, 0.0).unwrap());
    }

    /// 연 정밀도뿐인 대표도 사용자가 정한 값이다 — 덮어쓰지 않고 관련 날짜로 붙는다(리뷰 지적).
    #[test]
    fn apply_keeps_year_only_primary_and_adds_related_date_and_region() {
        let (mut conn, note_id) = setup_db();
        let meta = PhotoMeta { gps: Some((37.5665, 126.978)), taken: Some(shot()) };
        let a = apply(&mut conn, &note_id, &meta, Some("서울"), "사진").unwrap();
        assert!(a.date_row_id.is_some());
        assert!(a.region_row_id.is_some());
        assert_eq!(a.summary, "2026-10-03 · 서울");
        let rows = dates_list(&conn, &note_id).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().find(|r| r.position == 0).unwrap().month, None, "연 정밀도 대표 그대로");
        let rel = rows.iter().find(|r| r.position > 0).unwrap();
        assert_eq!((rel.year, rel.month, rel.day), (2026, Some(10), Some(3)));
        assert_eq!(rel.start_time.as_deref(), Some("14:32"));
        assert_eq!(regions_list(&conn, &note_id).unwrap().len(), 1);
    }

    /// 'Z'(UTC) 로 온 recorded_at 은 서버 로컬 벽시계로, 오프셋이 붙은 값은 그 벽시계 그대로.
    #[test]
    fn upload_hint_utc_is_converted_but_offset_wall_clock_is_kept() {
        let kept = PhotoMeta::from_upload(Some("2026-10-04T08:30:00+09:00"), None, None).taken.unwrap();
        assert_eq!((kept.day, kept.time.as_deref()), (4, Some("08:30")));
        let utc = PhotoMeta::from_upload(Some("2026-10-03T23:30:00Z"), None, None).taken.unwrap();
        let local = chrono::DateTime::parse_from_rfc3339("2026-10-03T23:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Local)
            .naive_local();
        assert_eq!(utc.day as u32, local.day());
        assert_eq!(utc.time, Some(format!("{:02}:{:02}", local.hour(), local.minute())));
    }

    /// 음성 테스트(핵심 가드): 이미 일 정밀도 대표가 있으면 덮어쓰지 않고 관련 날짜로 붙는다.
    /// date_wanted/apply 의 대표 처리를 "항상 비어 있음"으로 바꾸면 이 테스트가 실패해야 한다.
    #[test]
    fn apply_never_overwrites_an_existing_representative_date() {
        let (mut conn, note_id) = setup_db();
        let pid = pin_primary(&mut conn, &note_id, 2025, 1, 2);
        let meta = PhotoMeta { gps: None, taken: Some(shot()) };
        let a = apply(&mut conn, &note_id, &meta, None, "사진").unwrap();
                assert!(a.date_row_id.is_some());
        let rows = dates_list(&conn, &note_id).unwrap();
        assert_eq!(rows.len(), 2);
        let primary = rows.iter().find(|r| r.id == pid).unwrap();
        assert_eq!((primary.year, primary.month, primary.day), (2025, Some(1), Some(2)), "대표 보존");
        let rel = rows.iter().find(|r| r.position > 0).unwrap();
        assert_eq!((rel.year, rel.month, rel.day), (2026, Some(10), Some(3)));
        assert_eq!(rel.label.as_deref(), Some("사진"));
    }

    #[test]
    fn burst_of_five_same_day_makes_one_date_row() {
        let (mut conn, note_id) = setup_db();
        pin_primary(&mut conn, &note_id, 2025, 1, 2);
        for i in 0..5 {
            let mut t = shot();
            t.time = Some(format!("14:3{i}"));
            let meta = PhotoMeta { gps: Some((37.5665, 126.978)), taken: Some(t) };
            apply(&mut conn, &note_id, &meta, Some("서울"), "사진").unwrap();
        }
        let rows = dates_list(&conn, &note_id).unwrap();
        assert_eq!(rows.iter().filter(|r| r.position > 0).count(), 1, "연사 5장 → 관련 날짜 1행");
        assert_eq!(regions_list(&conn, &note_id).unwrap().len(), 1, "100m dedupe → 지역 1행");
    }

    #[test]
    fn same_day_as_primary_adds_nothing() {
        let (mut conn, note_id) = setup_db();
        pin_primary(&mut conn, &note_id, 2026, 10, 3);
        let meta = PhotoMeta { gps: None, taken: Some(shot()) };
        let a = apply(&mut conn, &note_id, &meta, None, "사진").unwrap();
        assert!(a.is_empty());
        assert_eq!(dates_list(&conn, &note_id).unwrap().len(), 1);
    }

    /// 파일 DB + 첨부 파일 한 장을 준비하고 (data_dir 홀더, note_id, rel) 을 돌려준다.
    fn file_fixture(mode: Option<&str>) -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        if let Some(m) = mode {
            let mut e = std::collections::BTreeMap::new();
            e.insert("photo_meta_mode".to_string(), serde_json::json!(m));
            crate::repo::settings::set(&mut conn, &e).unwrap();
        }
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = crate::repo::notes::create(&mut conn, &folder_id, None, Some(2026)).unwrap();
        let note_dir = db::attachments_dir(dir.path()).join(&n.note.id);
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(note_dir.join("p.jpg"), jpeg_with(Some((b"N", b"E")), Some(SHOT))).unwrap();
        let rel = format!("{}/p.jpg", n.note.id);
        (dir, n.note.id, rel)
    }

    async fn run_hook(dir: &Path, note_id: &str, rel: &str, calls: &AtomicUsize) {
        auto_meta_with(dir, note_id, rel, "image", None, |_, _| async {
            calls.fetch_add(1, Ordering::SeqCst);
            "서울".to_string()
        })
        .await;
    }

    #[tokio::test]
    async fn hook_off_skips_exif_and_geocoding_entirely() {
        let (dir, note_id, rel) = file_fixture(Some("off"));
        let calls = AtomicUsize::new(0);
        run_hook(dir.path(), &note_id, &rel, &calls).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "off 에서는 지오코딩(외부 요청) 0");
        let conn = db::open(&db::db_path(dir.path())).unwrap();
        assert!(regions_list(&conn, &note_id).unwrap().is_empty());
        assert_eq!(dates_list(&conn, &note_id).unwrap()[0].month, None, "대표 날짜도 그대로");
    }

    #[tokio::test]
    async fn hook_auto_applies_and_ask_only_suggests() {
        // 기본값(설정 미저장) = auto.
        let (dir, note_id, rel) = file_fixture(None);
        let calls = AtomicUsize::new(0);
        run_hook(dir.path(), &note_id, &rel, &calls).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let conn = db::open(&db::db_path(dir.path())).unwrap();
        assert_eq!(regions_list(&conn, &note_id).unwrap().len(), 1);
        assert!(dates_list(&conn, &note_id).unwrap().iter().any(|r| r.position > 0 && r.day == Some(3)));

        // ask: 동의 전이라 지오코딩도 하지 않고 DB 도 건드리지 않는다.
        let (dir, note_id, rel) = file_fixture(Some("ask"));
        let calls = AtomicUsize::new(0);
        run_hook(dir.path(), &note_id, &rel, &calls).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "ask 는 외부 요청 0");
        let conn = db::open(&db::db_path(dir.path())).unwrap();
        assert!(regions_list(&conn, &note_id).unwrap().is_empty());
        assert_eq!(dates_list(&conn, &note_id).unwrap().len(), 1);
    }

    /// 오디오: EXIF 를 읽지 않고 업로드 쿼리 메타만 같은 규칙으로 반영한다.
    #[tokio::test]
    async fn hook_audio_uses_upload_hint_only() {
        let (dir, note_id, _) = file_fixture(None);
        let calls = AtomicUsize::new(0);
        let hint = PhotoMeta::from_upload(Some("2026-10-03T14:32:05+09:00"), None, None);
        auto_meta_with(dir.path(), &note_id, "ignored.webm", "audio", Some(hint), |_, _| async {
            calls.fetch_add(1, Ordering::SeqCst);
            String::new()
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "좌표가 없으면 지오코딩 없음");
        let conn = db::open(&db::db_path(dir.path())).unwrap();
        assert!(dates_list(&conn, &note_id).unwrap().iter().any(|r| r.position > 0 && r.day == Some(3)));
    }

    /// GPS 없는 이미지는 전체 훅을 통과해도 아무것도 추가하지 않는다(네트워크 접근 전에 종료).
    #[tokio::test]
    async fn auto_meta_hook_adds_nothing_for_exifless_image() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let (note_id, rel) = {
            let mut conn = db::open(&db::db_path(data_dir)).unwrap();
            crate::db::migrations::run(&mut conn).unwrap();
            let folder_id: String = conn
                .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let n = crate::repo::notes::create(&mut conn, &folder_id, None, Some(2026)).unwrap();
            let note_dir = db::attachments_dir(data_dir).join(&n.note.id);
            std::fs::create_dir_all(&note_dir).unwrap();
            let img = image::RgbImage::from_pixel(4, 4, image::Rgb([9, 9, 9]));
            img.save(note_dir.join("nogps.png")).unwrap();
            (n.note.id.clone(), format!("{}/nogps.png", n.note.id))
        };

        auto_meta(data_dir, &note_id, &rel, "image", None).await;

        let conn = db::open(&db::db_path(data_dir)).unwrap();
        assert!(regions_list(&conn, &note_id).unwrap().is_empty());
        assert_eq!(dates_list(&conn, &note_id).unwrap()[0].month, None);
    }
}
