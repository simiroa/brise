// repo: screenshot — 트레이(=펫 우클릭, 같은 메뉴) "화면 저장"의 활성 창 캡처 + 폴더 저장
// (docs/PLAN-2026-08-09-pet-capture.md Phase 1, Q8: 캡처 범위는 전체 화면이 아니라 **활성 창**).
//
// **함정**: 우클릭한 순간의 포그라운드 창은 펫 자신이다(always_on_top 인 데다 방금 클릭했다).
// 그래서 "포커스된 창"을 잡으면 언제나 펫 스프라이트만 찍힌다 — 자기 프로세스 창(펫·말풍선·
// 메인)을 전부 빼고 **z-order 최상위 일반 창**을 고른다. 그 판정은 OS 없이도 검증할 수 있게
// 순수 함수(pick_capture_target)로 떼어 두고, xcap 호출은 그 함수에 넣을 값만 긁어 온다.
//
// 플랫폼: Windows 전용(Cargo.toml 의 cfg(windows) 주석 참고). 다른 OS 에서는 아래 스텁이
// VALIDATION 으로 거절한다 — 조용히 빈 이미지를 돌려주지 않는다.
use crate::error::{AppError, AppResult};

/// 캡처 후보 한 줄 — 판정에 필요한 값만 xcap::Window 에서 뽑아 온 것.
#[derive(Debug, Clone)]
pub struct CandidateWindow {
    pub pid: u32,
    /// z-order. 값이 클수록 위(xcap::Window::z).
    pub z: i32,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub minimized: bool,
}

/// 이보다 작은 창은 후보에서 뺀다 — 툴팁·IME 후보창·투명 헬퍼 창이 z-order 꼭대기에 얹혀
/// 있는 경우가 흔하고, 그걸 찍으면 "화면 저장"이 8×8 픽셀 조각을 저장한다.
const MIN_CAPTURE_PX: u32 = 120;

/// 자기 프로세스 창을 뺀 뒤 z-order 최상위 일반 창의 인덱스. 후보가 없으면 None
/// (호출부가 AppError 로 올린다 — 조용히 죽지 않는다).
pub fn pick_capture_target(candidates: &[CandidateWindow], own_pid: u32) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .filter(|(_, w)| {
            w.pid != own_pid
                && !w.minimized
                && !w.title.trim().is_empty()
                && w.width >= MIN_CAPTURE_PX
                && w.height >= MIN_CAPTURE_PX
        })
        // max_by_key 는 동점일 때 **마지막** 것을 준다. xcap::Window::all() 이 z 오름차순으로
        // 주므로 동점이면 목록에서 나중에 온 쪽(= 더 위)을 고르는 셈이라 의도와 맞는다.
        .max_by_key(|(_, w)| w.z)
        .map(|(i, _)| i)
}

/// 캡처 결과 — PNG 원본(첨부용)과 창 제목(카드 문구·본문 메타).
pub struct Capture {
    pub png: Vec<u8>,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

/// 비전 요약에 실어 보낼 이미지의 긴 변 상한. 원본 PNG(4K 창이면 수 MB)를 그대로 보내면
/// 토큰·지연·업로드가 전부 낭비다 — 스크린샷의 글자는 이 정도면 충분히 읽힌다.
const VISION_MAX_EDGE: u32 = 1024;
/// 비전 요청 이미지 형식. 첨부(무손실 PNG)와 달리 여기선 크기가 전부라 JPEG.
pub const VISION_MIME: &str = "image/jpeg";

/// PNG 원본 → 비전 요청용 축소 JPEG. 실패(디코드 불가 등)는 Err — 호출부가 "요약 없음"으로
/// 강등한다.
pub fn vision_image(png: &[u8]) -> AppResult<Vec<u8>> {
    let img = image::load_from_memory(png).map_err(|e| AppError::Io(e.to_string()))?;
    let scaled = if img.width().max(img.height()) > VISION_MAX_EDGE {
        img.resize(VISION_MAX_EDGE, VISION_MAX_EDGE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    scaled
        .to_rgb8()
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(out.into_inner())
}

/// `screenshot-20260809-142530.png` — 첨부 파일명. 창 제목은 넣지 않는다(경로 안전 문자
/// 필터를 또 만들 이유가 없고, 제목은 노트 본문에 그대로 남는다).
pub fn capture_file_name(now: chrono::DateTime<chrono::Local>) -> String {
    format!("screenshot-{}.png", now.format("%Y%m%d-%H%M%S"))
}

/// 기본 저장 폴더 = `<사진>/Brise`. 설정 > 일반의 "저장 폴더" 행이 같은 규칙으로 기본 경로를
/// 보여 준다(GeneralSection.tsx `pictureDir()` + 이 이름) — 바꾸면 둘 다.
pub const DEFAULT_CAPTURE_SUBDIR: &str = "Brise";

/// 화면 저장 폴더. `capture_screenshot_dir` 가 비어 있으면 `<사진>/Brise`, 사진 폴더를 못 찾는
/// OS 면 `<data_dir>/screenshots`.
pub fn capture_dir(
    configured: Option<&str>,
    pictures: Option<std::path::PathBuf>,
    data_dir: &std::path::Path,
) -> std::path::PathBuf {
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => pictures
            .map(|p| p.join(DEFAULT_CAPTURE_SUBDIR))
            .unwrap_or_else(|| data_dir.join("screenshots")),
    }
}

/// PNG 를 폴더에 쓴다(폴더가 없으면 만든다). 이름은 capture_file_name — 초 단위라 같은 초 두 번이면
/// 덮어쓴다. ponytail: 진행 중 재요청은 호출부가 막으므로 충돌 접미사는 두지 않는다.
pub fn save_png(dir: &std::path::Path, name: &str, png: &[u8]) -> std::io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    std::fs::write(&path, png)?;
    Ok(path)
}

#[cfg(windows)]
pub fn capture_active_window() -> AppResult<Capture> {
    use image::ImageEncoder;

    let own_pid = std::process::id();
    let windows = xcap::Window::all().map_err(|e| AppError::Io(format!("window list failed: {e}")))?;
    // 접근자 하나하나가 Result 다(창이 그 사이 닫히면 실패) — 못 읽는 창은 후보에서 조용히
    // 빠지는 게 맞다. 그래서 여기서 실패를 올리지 않고 filter_map 으로 흘린다.
    let candidates: Vec<(usize, CandidateWindow)> = windows
        .iter()
        .enumerate()
        .filter_map(|(i, w)| {
            Some((
                i,
                CandidateWindow {
                    pid: w.pid().ok()?,
                    z: w.z().ok()?,
                    title: w.title().ok()?,
                    width: w.width().ok()?,
                    height: w.height().ok()?,
                    minimized: w.is_minimized().ok()?,
                },
            ))
        })
        .collect();
    let rows: Vec<CandidateWindow> = candidates.iter().map(|(_, c)| c.clone()).collect();
    let picked = pick_capture_target(&rows, own_pid).ok_or_else(|| {
        AppError::Validation(
            "저장할 창을 찾지 못했어요 — 저장하려는 창을 먼저 띄워 주세요.".to_string(),
        )
    })?;
    let (window_index, target) = &candidates[picked];

    let rgba = windows[*window_index]
        .capture_image()
        .map_err(|e| AppError::Io(format!("window capture failed: {e}")))?;
    let (width, height) = (rgba.width(), rgba.height());
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(rgba.as_raw(), width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| AppError::Io(e.to_string()))?;

    Ok(Capture { png, title: target.title.clone(), width, height })
}

/// ponytail: Windows 외에는 캡처 백엔드를 빌드하지 않는다(Cargo.toml cfg(windows) 주석 —
/// CI 의 리눅스 시스템 라이브러리와 macOS 화면 기록 권한이 각각 별개 과제다). 조용한 no-op
/// 대신 명시적 거절이라 UI 가 "안 됐다"를 그대로 말할 수 있다.
#[cfg(not(windows))]
pub fn capture_active_window() -> AppResult<Capture> {
    Err(AppError::Validation(
        "screen capture is only available on Windows".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(pid: u32, z: i32, title: &str) -> CandidateWindow {
        CandidateWindow {
            pid,
            z,
            title: title.to_string(),
            width: 800,
            height: 600,
            minimized: false,
        }
    }

    /// 이 기능의 핵심 함정 — 우클릭 순간 최상위는 펫(우리 프로세스)이다.
    #[test]
    fn skips_our_own_windows_even_when_they_are_on_top() {
        let rows = vec![
            win(100, 1, "메모장"),
            win(42, 9, "Brise Pet"),
            win(42, 8, "Brise Pet Bubble"),
        ];
        let i = pick_capture_target(&rows, 42).unwrap();
        assert_eq!(rows[i].title, "메모장");
    }

    #[test]
    fn picks_the_topmost_of_the_remaining_windows() {
        let rows = vec![win(1, 3, "아래"), win(2, 7, "위"), win(3, 5, "가운데")];
        let i = pick_capture_target(&rows, 42).unwrap();
        assert_eq!(rows[i].title, "위");
    }

    #[test]
    fn ignores_minimized_untitled_and_tiny_windows() {
        let mut minimized = win(1, 50, "최소화됨");
        minimized.minimized = true;
        let mut tiny = win(2, 60, "툴팁");
        tiny.width = 20;
        tiny.height = 12;
        let rows = vec![minimized, tiny, win(3, 40, "빈 제목 아님"), win(4, 30, "   ")];
        let i = pick_capture_target(&rows, 42).unwrap();
        assert_eq!(rows[i].title, "빈 제목 아님");
    }

    /// 후보가 하나도 없으면 None → 호출부가 AppError 로 올린다(조용한 실패 금지).
    #[test]
    fn returns_none_when_only_our_own_windows_are_open() {
        let rows = vec![win(42, 9, "Brise"), win(42, 3, "Brise Pet")];
        assert!(pick_capture_target(&rows, 42).is_none());
        assert!(pick_capture_target(&[], 42).is_none());
    }

    #[test]
    fn file_name_is_sortable_and_has_no_path_characters() {
        use chrono::TimeZone;
        let at = chrono::Local.with_ymd_and_hms(2026, 8, 9, 14, 25, 30).unwrap();
        let name = capture_file_name(at);
        assert_eq!(name, "screenshot-20260809-142530.png");
        assert!(!name.contains('/') && !name.contains('\\') && !name.contains(':'));
    }

    #[test]
    fn vision_image_downscales_the_long_edge_and_reencodes_as_jpeg() {
        let big = image::RgbaImage::from_pixel(2400, 1200, image::Rgba([10, 20, 30, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(big)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let jpeg = vision_image(&png).unwrap();
        let decoded = image::load_from_memory(&jpeg).unwrap();
        assert_eq!(decoded.width(), VISION_MAX_EDGE);
        assert!(decoded.height() < 1200);
        assert!(jpeg.len() < png.len(), "축소 JPEG 가 원본 PNG 보다 커지면 의미가 없다");
    }

    #[test]
    fn capture_dir_prefers_setting_then_pictures_then_data_dir() {
        use std::path::{Path, PathBuf};
        let data = Path::new("D:/data");
        assert_eq!(capture_dir(Some("E:/shots"), Some(PathBuf::from("C:/Pics")), data), PathBuf::from("E:/shots"));
        assert_eq!(capture_dir(Some("  "), Some(PathBuf::from("C:/Pics")), data), PathBuf::from("C:/Pics").join("Brise"));
        assert_eq!(capture_dir(None, None, data), data.join("screenshots"));
    }

    #[test]
    fn save_png_creates_the_folder_and_writes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("Brise");
        let path = save_png(&target, "screenshot-1.png", b"png").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"png");
        assert_eq!(path, target.join("screenshot-1.png"));
    }

    #[test]
    fn vision_image_rejects_bytes_that_are_not_an_image() {
        assert!(vision_image(b"not an image").is_err());
    }
}
