// repo: doc_import — 문서 파일 → 서식 있는 HTML (PLAN-2026-10-07-doc-import-export W1, W4-0 에서 모듈로 분리)
//
// 본 제품은 한글과컴퓨터의 글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
// (OWPML/KS X 6101 구조를 참고했다 — 정확한 고지 문구·위치는 조사 §6.7 대로 W3 전에 스펙 PDF 와 대조해 확정한다.)
//
// 형식 무관 부분과 형식 전용 부분을 가른다(DOCX 는 형식 무관 부분을 HWPX 와 같이 쓰고 `docx.rs` 만 더했다):
//   mod.rs    출력 형 · 그림 상한 · `import()` — 확장자로 파서를 고르고, 그림을 첨부로 저장하고(실패하면 되돌리고), HTML 을 만든다.
//   xml.rs    XML 트리 유틸(`parse_xml` · `effective` · `find_*`)
//   ir.rs     중간 표현(`Block` …)과 후처리(빈 문단 접기 · 제목 추정 · 표 열 배치 · 표 머리글)
//   images.rs 문서 안 그림 저장소(압축 해제 상한 안에서 zip 엔트리를 그림으로)
//   html.rs   Brise 계약 HTML 렌더 · 색/링크 안전
//   hwpx.rs   HWPX(OWPML) 전용 — 스타일 표 · 구역 파서 · 패키지 읽기
//   docx.rs   DOCX(WordprocessingML) 전용 — 스타일 상속 · 번호 매기기 · 필드 · 관계(rels) · 패키지 읽기
// 파서의 계약: 파일 → `ir::Parsed`(DB 를 건드리지 않는다). 렌더는 `Parsed::render`, 그림 저장만 `import()` 가 DB 를 쓴다.
pub mod docx;
mod html;
pub mod hwpx;
mod images;
mod ir;
mod xml;

use crate::error::{io as io_err, AppError, AppResult};
use crate::models::Attachment;
use crate::repo::attachments::{self, post_add};
use ir::Parsed;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

/// 그림 한 장 · 전체 · 장수 상한 — 넘는 그림은 문서 전체를 버리지 않고 그 그림만 `image_limit` 로 센다.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGES: usize = 400;
/// 서로 다른 그림 참조(binaryItemIDRef) 를 몇 개까지 찾아 볼지 — 상한 밖 그림을 읽고 버리는 일에도 한도를 둔다.
const MAX_IMAGE_LOOKUPS: usize = 2000;
/// 문서 파일 크기 상한 — 압축 해제 상한(`MAX_DECOMPRESSED_BYTES`)과 별개로, 터무니없는 입력을 열기 전에 거른다.
const MAX_DOC_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// 그림을 읽느라 푼 바이트(버린 것 포함)의 상한 — 헤더의 크기를 속인 엔트리가 많아도 풀기 일을 이 안에서 끝낸다.
const MAX_IMAGE_READ_BYTES: u64 = 2 * MAX_IMAGES_TOTAL_BYTES;
const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];

// ── 출력 형 ───────────────────────────────────────────────────────────────────

/// 옮기지 못한 요소 한 종류와 개수(본문은 담지 않는다 — specs `DocImportDropped`).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct DocImportDropped {
    pub kind: String,
    pub count: u32,
}

/// `doc_import_html` 출력(specs/commands/sections.yaml).
#[derive(Serialize, Debug)]
pub struct DocImportHtmlOutput {
    pub name: String,
    pub html: String,
    pub image_count: usize,
    pub dropped: Vec<DocImportDropped>,
    pub attachment_ids: Vec<String>,
}

/// 문서 안 그림 한 장(zip 에서 꺼낸 바이트) — 저장은 `import()` 가 한다.
pub struct ImageData {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 렌더에 필요한, 저장된 그림의 두 필드(rel_path = `data-rel-path`).
pub struct SavedImage {
    pub rel_path: String,
    pub name: String,
}

// ── 가져오기 진입점(DB) ───────────────────────────────────────────────────────

/// 그림을 첨부로 저장한다 — 사진 한 장씩 DB 락을 잡았다 놓는다(큰 문서가 다른 명령을 오래 막지 않게).
/// 한 장이라도 실패하면 이미 넣은 첨부를 되돌린다(`attachments::remove`).
fn save_images(
    db: &Mutex<Connection>,
    data_dir: &Path,
    note_id: &str,
    images: &[ImageData],
) -> AppResult<Vec<Attachment>> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    // 그림마다 하위 폴더 — 같은 이름(image1.png)이 겹쳐도 원래 이름 그대로 첨부 이름이 된다.
    let tmp = post_add::staging_dir("brise-doc");
    let mut saved: Vec<Attachment> = Vec::with_capacity(images.len());
    let result: AppResult<()> = (|| {
        for (i, img) in images.iter().enumerate() {
            let staged = post_add::stage_bytes(&tmp.join(i.to_string()), &img.name, &img.bytes).map_err(io_err)?;
            let mut conn = db.lock();
            saved.push(attachments::add_file(&mut conn, data_dir, note_id, &staged.to_string_lossy())?);
        }
        Ok(())
    })();
    if let Err(e) = std::fs::remove_dir_all(&tmp) {
        crate::diag::warn("doc_import", "staging_cleanup_failed", e.to_string());
    }
    if let Err(e) = result {
        for att in &saved {
            let mut conn = db.lock();
            if attachments::remove(&mut conn, data_dir, &att.id).is_err() {
                crate::diag::warn("doc_import", "rollback_failed", "could not remove a partially imported attachment");
            }
        }
        return Err(e);
    }
    Ok(saved)
}

/// 문서 파일 → 서식 있는 HTML. 섹션은 만들지 않는다(프런트가 `mdSerializeHtml` → `section_create_with_body`).
/// 부작용은 본문 그림의 첨부 저장뿐이다.
///
/// 썸네일은 만들지만 `spawn_auto_meta`(EXIF → 노트 날짜·경유지)는 부르지 않는다 — 문서에 박힌 로고·스캔 이미지의
/// EXIF 가 노트의 날짜와 지역을 덮어쓰면 안 된다(사진을 직접 붙인 것과 다르다).
///
/// **블로킹**이다 — 호출자가 spawn_blocking 으로 감싼다(파싱·파일 쓰기가 커맨드 스레드를 막지 않게).
pub fn import(db: &Mutex<Connection>, data_dir: &Path, note_id: &str, file_path: &str) -> AppResult<DocImportHtmlOutput> {
    let path = Path::new(file_path);
    if path.is_dir() {
        return Err(AppError::Validation(format!("cannot import a directory as a document: {file_path}")));
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    // 확장자 → 파서 선택. 새 형식은 여기에 한 줄을 더한다. 파서의 계약은 `fn(&Path) -> 중간 표현`(DB 를 건드리지 않는다).
    let parse_file: fn(&Path) -> AppResult<Parsed> = match ext.as_str() {
        "hwpx" => hwpx::parse_file,
        "docx" => docx::parse_file,
        _ => return Err(AppError::Validation(format!("unsupported import extension: .{ext}"))),
    };
    // 그림이 없으면 add_file 이 노트를 확인할 일이 없다 — 여기서 먼저 확인해 NOT_FOUND 를 일정하게 낸다.
    attachments::require_note(&db.lock(), note_id)?;

    let parsed = parse_file(path)?;
    let saved = save_images(db, data_dir, note_id, &parsed.images)?;
    for att in &saved {
        post_add::ensure_thumb(data_dir, att);
    }
    let infos: Vec<SavedImage> = saved
        .iter()
        .map(|a| SavedImage { rel_path: a.rel_path.clone().unwrap_or_default(), name: a.name.clone() })
        .collect();
    let html = parsed.render(&infos);
    let attachment_ids: Vec<String> = saved.iter().map(|a| a.id.clone()).collect();
    Ok(DocImportHtmlOutput {
        name: path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string(),
        html,
        image_count: saved.len(),
        dropped: parsed.dropped,
        attachment_ids,
    })
}

// ── 테스트 ────────────────────────────────────────────────────────────────────
//
// `import()` 흐름(확장자 거절 · 그림 → 첨부 저장 · 거절 시 되돌리기)을 본다. 픽스처(.hwpx 만들기)는 `hwpx::tests`, (.docx 만들기)는
// `docx::tests` 가 가진다.
#[cfg(test)]
mod tests {
    use super::docx::tests::{broken_docx_with_picture, picture_docx, picture_docx_named, text_docx};
    use super::hwpx::tests::{header_xml, hpf, hwpx, hwpx_with, picture_doc, picture_doc_named, png_bytes, tp};
    use super::*;
    use std::io::Write;

    // ── 가져오기 진입점(DB · 첨부) ────────────────────────────────────────────

    struct Env {
        _dir: tempfile::TempDir,
        db: Mutex<Connection>,
        data_dir: std::path::PathBuf,
        note_id: String,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(dir.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let note_id = crate::repo::notes::create(&mut conn, &folder_id, None, None).unwrap().note.id;
        let data_dir = dir.path().to_path_buf();
        Env { _dir: dir, db: Mutex::new(conn), data_dir, note_id }
    }

    #[test]
    fn import_saves_pictures_as_attachments_and_links_them_by_rel_path() {
        let env = env();
        let f = picture_doc();
        let out = import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy()).unwrap();
        assert_eq!(out.image_count, 1);

        let atts = attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap();
        assert_eq!(atts.len(), 1);
        let att = &atts[0];
        assert_eq!(out.attachment_ids, vec![att.id.clone()]);
        assert_eq!(att.name, "image1.png");
        assert_eq!(att.kind, "image");
        let rel = att.rel_path.clone().expect("복사 첨부는 rel_path 가 있다");
        assert!(rel.starts_with(&format!("{}/", env.note_id)), "{rel}");
        // 디스크에 실제 파일, 썸네일, 그리고 html 이 그 rel_path 를 가리킨다.
        let on_disk = crate::db::attachments_dir(&env.data_dir).join(&rel);
        assert_eq!(std::fs::read(&on_disk).unwrap(), png_bytes());
        assert!(crate::db::attachments_dir(&env.data_dir).join(attachments::thumb_rel_for(&rel)).is_file());
        assert!(out.html.contains(&format!("data-rel-path=\"{rel}\"")), "{}", out.html);
        assert!(out.html.contains(&format!("src=\"{rel}\"")), "{}", out.html);
        assert!(!out.html.contains("n/0-"), "{}", out.html);
        assert_eq!(out.name, f.path().file_stem().unwrap().to_string_lossy());
        assert_eq!(
            out.dropped.iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(),
            vec!["image_format", "image_missing"]
        );
    }

    #[test]
    fn import_without_pictures_touches_no_attachments() {
        let env = env();
        let f = hwpx(&tp(3, 0, "글"));
        let out = import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy()).unwrap();
        assert_eq!(out.html, "<p>글</p>");
        assert_eq!(out.image_count, 0);
        assert!(attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap().is_empty());
    }

    #[test]
    fn import_rejects_wrong_extension_directory_and_missing_note() {
        let env = env();
        let f = hwpx(&tp(3, 0, "글"));
        let path = f.path().to_string_lossy().into_owned();

        assert!(matches!(import(&env.db, &env.data_dir, "no-such-note", &path), Err(AppError::NotFound(_))));

        let mut txt = tempfile::NamedTempFile::with_suffix(".txt").unwrap();
        txt.write_all(b"x").unwrap();
        assert!(matches!(
            import(&env.db, &env.data_dir, &env.note_id, &txt.path().to_string_lossy()),
            Err(AppError::Validation(_))
        ));
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            import(&env.db, &env.data_dir, &env.note_id, &dir.path().to_string_lossy()),
            Err(AppError::Validation(_))
        ));
        // 확장자 비교는 대소문자를 가리지 않는다.
        let upper = tempfile::Builder::new().suffix(".HWPX").tempfile().unwrap();
        std::fs::copy(f.path(), upper.path()).unwrap();
        assert!(import(&env.db, &env.data_dir, &env.note_id, &upper.path().to_string_lossy()).is_ok());
    }

    #[test]
    fn import_leaves_no_attachments_when_the_document_is_rejected() {
        let env = env();
        // 그림은 있지만 본문이 깨져 파싱 단계에서 거절 — 첨부가 만들어지기 전이라 아무것도 남지 않는다.
        let f = hwpx_with(&[(0, "<hs:sec".to_string())], &header_xml(), &hpf(&[]), &[("BinData/image1.png", png_bytes())]);
        assert!(import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy()).is_err());
        assert!(attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap().is_empty());
    }

    #[test]
    fn hostile_bindata_names_neither_escape_the_staging_folder_nor_kill_the_import() {
        // `C:x.png` 는 드라이브 접두사 상대 경로라 `dir.join` 이 기준 폴더를 통째로 대체했다 — 스테이징 폴더(%TEMP%\brise-hwpx-*)가
        // 아니라 프로세스 현재 폴더에 쓰고, 이미 있던 같은 이름 파일은 덮어썼다. 파일명으로 못 쓰는 이름(`?*<>`)과 300자 이름은
        // `stage_bytes` 를 os error 123 으로 죽여 문서 전체를 IO 로 실패시켰다.
        let cwd = std::env::current_dir().unwrap();
        let leak_name = format!("zzprobe_{}.png", crate::util::new_id());
        let leak_path = cwd.join(&leak_name);
        let victim = b"ORIGINAL-USER-FILE";
        std::fs::write(&leak_path, victim).unwrap();
        // 단언이 실패해 일찍 끝나도 현재 폴더(src-tauri)에 미끼 파일이 남지 않게 한다.
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(leak_path.clone());

        let cases: Vec<(String, String)> = vec![
            (format!("BinData/C:{leak_name}"), format!("C-{leak_name}")),
            ("BinData/a?b.png".to_string(), "a-b.png".to_string()),
            ("BinData/<img onerror=x>.png".to_string(), "-img onerror=x-.png".to_string()),
            ("BinData/한글 이름?*.png".to_string(), "한글 이름--.png".to_string()),
        ];
        for (entry, expected) in cases {
            let env = env();
            let f = picture_doc_named(&entry);
            let out = import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy());
            // 단언 전에 지킨다 — 실패해도 사용자 파일을 흉내 낸 미끼가 덮어써진 채 남지 않게 먼저 읽어 둔다.
            let after = std::fs::read(&leak_path).unwrap_or_default();
            let out = out.unwrap_or_else(|e| panic!("{entry:?} 때문에 문서 전체가 실패했다: {e:?}"));
            assert_eq!(after, victim, "{entry:?}: 현재 폴더의 파일이 덮어써졌다");
            assert_eq!(out.image_count, 1, "{entry:?}");
            let atts = attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap();
            assert_eq!(atts.len(), 1, "{entry:?}");
            assert_eq!(atts[0].name, expected, "{entry:?}");
            assert!(out.html.contains("<img src="), "{entry:?}: {}", out.html);
        }

        // 300자 이름은 확장자를 지킨 채 줄어 가져와진다.
        let env = env();
        let long = format!("BinData/{}.png", "a".repeat(300));
        let out = import(&env.db, &env.data_dir, &env.note_id, &picture_doc_named(&long).path().to_string_lossy()).unwrap();
        assert_eq!(out.image_count, 1);
        let atts = attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap();
        assert!(atts[0].name.ends_with(".png") && atts[0].name.len() <= 120, "{}", atts[0].name);
    }

    // ── DOCX 도 같은 흐름을 탄다(파서만 다르다) ──────────────────────────────────

    #[test]
    fn docx_import_saves_pictures_as_attachments_and_links_them_by_rel_path() {
        let env = env();
        let f = picture_docx();
        let out = import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy()).unwrap();
        assert_eq!(out.image_count, 1);
        assert_eq!(out.name, f.path().file_stem().unwrap().to_string_lossy());

        let atts = attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap();
        assert_eq!(atts.len(), 1);
        let att = &atts[0];
        assert_eq!((att.name.as_str(), att.kind.as_str()), ("image1.png", "image"));
        let rel = att.rel_path.clone().expect("복사 첨부는 rel_path 가 있다");
        assert_eq!(std::fs::read(crate::db::attachments_dir(&env.data_dir).join(&rel)).unwrap(), png_bytes());
        assert!(crate::db::attachments_dir(&env.data_dir).join(attachments::thumb_rel_for(&rel)).is_file());
        assert!(out.html.contains(&format!("data-rel-path=\"{rel}\"")), "{}", out.html);
        assert!(out.html.contains("style=\"width: 50%\""), "{}", out.html);
        assert!(out.dropped.is_empty());
    }

    #[test]
    fn docx_without_pictures_touches_no_attachments_and_the_extension_is_case_insensitive() {
        let env = env();
        let f = text_docx("글");
        let out = import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy()).unwrap();
        assert_eq!(out.html, "<p>글</p>");
        assert_eq!(out.image_count, 0);
        assert!(attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap().is_empty());

        let upper = tempfile::Builder::new().suffix(".DOCX").tempfile().unwrap();
        std::fs::copy(f.path(), upper.path()).unwrap();
        assert!(import(&env.db, &env.data_dir, &env.note_id, &upper.path().to_string_lossy()).is_ok());
        assert!(matches!(
            import(&env.db, &env.data_dir, "no-such-note", &f.path().to_string_lossy()),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn docx_import_leaves_no_attachments_when_the_document_is_rejected() {
        let env = env();
        // 그림은 있지만 본문이 깨져 파싱 단계에서 거절 — 첨부가 만들어지기 전이라 아무것도 남지 않는다.
        let f = broken_docx_with_picture();
        assert!(matches!(
            import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy()),
            Err(AppError::Validation(_))
        ));
        assert!(attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap().is_empty());
    }

    #[test]
    fn hostile_docx_entry_names_neither_escape_the_staging_folder_nor_kill_the_import() {
        // hwpx 와 같은 방어(`stage_bytes`)를 docx 그림 이름도 탄다: 드라이브 접두사 · 파일명으로 못 쓰는 글자 · 긴 이름.
        let cwd = std::env::current_dir().unwrap();
        let leak_name = format!("zzprobe_{}.png", crate::util::new_id());
        let leak_path = cwd.join(&leak_name);
        let victim = b"ORIGINAL-USER-FILE";
        std::fs::write(&leak_path, victim).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(leak_path.clone());

        let cases: Vec<(String, String)> = vec![
            (format!("C:{leak_name}"), format!("C-{leak_name}")),
            ("a?b.png".to_string(), "a-b.png".to_string()),
            ("<img onerror=x>.png".to_string(), "-img onerror=x-.png".to_string()),
            ("한글 이름?*.png".to_string(), "한글 이름--.png".to_string()),
        ];
        for (entry, expected) in cases {
            let env = env();
            let f = picture_docx_named(&entry);
            let out = import(&env.db, &env.data_dir, &env.note_id, &f.path().to_string_lossy());
            let after = std::fs::read(&leak_path).unwrap_or_default();
            let out = out.unwrap_or_else(|e| panic!("{entry:?} 때문에 문서 전체가 실패했다: {e:?}"));
            assert_eq!(after, victim, "{entry:?}: 현재 폴더의 파일이 덮어써졌다");
            assert_eq!(out.image_count, 1, "{entry:?}");
            let atts = attachments::load_for_note(&env.db.lock(), &env.note_id).unwrap();
            assert_eq!(atts.len(), 1, "{entry:?}");
            assert_eq!(atts[0].name, expected, "{entry:?}");
            assert!(out.html.contains("<img src="), "{entry:?}: {}", out.html);
        }
    }
}
