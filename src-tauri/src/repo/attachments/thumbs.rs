// repo::attachments::thumbs — 이미지 썸네일 파이프라인(SQL 없음, 순수 파일시스템/디코드 작업).
// R4에서 attachments.rs(현 attachments/mod.rs)로부터 분리. THUMB_MAX_SIDE/THUMB_JPEG_QUALITY/
// ext_of_rel은 부모 모듈(mod.rs)의 테스트도 참조하므로 그대로 두고 `super::`로 가져온다.
use crate::db;
use image::GenericImageView;
use std::path::Path;

/// Image kinds that we decode for tiles. SVG is skipped: `image` cannot decode it and vectors
/// do not blow up decode memory the way multi-megapixel rasters do.
pub fn wants_thumbnail(kind: &str, ext: &str) -> bool {
    kind == "image" && !thumb_undecodable(ext)
}

/// 이미지 kind 지만 썸네일 디코더가 없는 확장자 — SVG(벡터)와 HEIC/HEIF(`image` 크레이트에 디코더
/// 없음). 시도하면 갤러리를 열 때마다 실패·진단 로그가 반복되므로 처음부터 건너뛴다(타일은 플레이스홀더).
pub fn thumb_undecodable(ext: &str) -> bool {
    ["svg", "heic", "heif"].iter().any(|e| ext.eq_ignore_ascii_case(e))
}

/// Composite any alpha onto white, then return an 8-bit RGB buffer for JPEG encoding.
fn flatten_alpha_onto_white(img: image::DynamicImage) -> image::RgbImage {
    let rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let inv = 255 - a;
        let r = ((p[0] as u32 * a + 255 * inv) / 255) as u8;
        let g = ((p[1] as u32 * a + 255 * inv) / 255) as u8;
        let b = ((p[2] as u32 * a + 255 * inv) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([r, g, b]));
    }
    out
}

/// Decode `src`, downscale so the longest side is ≤ THUMB_MAX_SIDE, write JPEG to `dest`
/// via tmp → rename so a half-written file is never visible.
fn write_thumbnail(src: &Path, dest: &Path) -> Result<(), String> {
    // 디코드 상한 — 첨부 상한은 200MB 파일 크기이지 픽셀 수가 아니다. 20000x20000 PNG 은
    // 몇 MB 로 압축되지만 RGBA 로 펼치면 1.6GB 라 앱 프로세스가 그대로 죽는다. 상한을 넘으면
    // 썸네일만 포기하고(호출부가 None) 첨부는 그대로 남는다.
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(512 * 1024 * 1024);
    let reader = image::ImageReader::open(src)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut reader = reader;
    reader.limits(limits);
    let img = reader.decode().map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    let resized = if w > super::THUMB_MAX_SIDE || h > super::THUMB_MAX_SIDE {
        img.resize(super::THUMB_MAX_SIDE, super::THUMB_MAX_SIDE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let rgb = flatten_alpha_onto_white(resized);

    let parent = dest
        .parent()
        .ok_or_else(|| "thumbnail dest has no parent".to_string())?;
    let tmp_name = format!(
        ".tmp-thumb-{}",
        dest.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("thumb.jpg")
    );
    let tmp = parent.join(tmp_name);

    {
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(file, super::THUMB_JPEG_QUALITY);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

/// Ensure `{rel_path}.thumb.jpg` exists next to the original. No-op if already present.
/// Returns the thumbnail rel_path when a usable file is on disk; `None` on skip/failure.
/// Pure filesystem work — never touches the DB (callers must not hold AppState.db across this).
pub fn ensure_thumb_for_attachment(data_dir: &Path, rel_path: &str) -> Option<String> {
    let ext = super::ext_of_rel(rel_path);
    if thumb_undecodable(ext) {
        return None;
    }
    let thumb_rel = super::thumb_rel_for(rel_path);
    let att_root = db::attachments_dir(data_dir);
    let thumb_clean = crate::repo::paths::safe_rel(&thumb_rel).ok()?;
    let thumb_path = att_root.join(&thumb_clean);
    if thumb_path.is_file() {
        return Some(thumb_rel);
    }
    let src_clean = crate::repo::paths::safe_rel(rel_path).ok()?;
    let src = att_root.join(src_clean);
    if !src.is_file() {
        return None;
    }
    match write_thumbnail(&src, &thumb_path) {
        Ok(()) => Some(thumb_rel),
        Err(e) => {
            let name = std::path::Path::new(rel_path).file_name().and_then(|n| n.to_str()).unwrap_or(rel_path);
            crate::diag::warn("attachments", "thumbnail_generation_failed", format!("{name}: {e}"));
            None
        }
    }
}
