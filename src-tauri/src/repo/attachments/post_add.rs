// repo::attachments::post_add — 첨부를 추가한 **뒤**의 후속 단계와, 디스크 경로가 없는 바이트의
// 임시 스테이징.
//
// 진입 경로 세 곳(commands::attachments::attachment_add_file / attachment_add_bytes,
// sync_server::handlers::attachment_upload)이 add_file 뒤에 문자 그대로 같은 후속 단계를 돌리고
// 있었다 — 썸네일 판정·생성, EXIF/업로드 메타 → 날짜·경유지 자동 반영, 그리고 둘은 스테이징까지. 사본이
// 셋이라 실제로 표류했다: ddf4d50c(큰 원본 참조 모드)가 add_file_from_disk 를 만들며 한 곳만
// 갈라졌다.
//
// 이벤트 발행(events::publish vs sync_server::emit_remote_write)은 표면마다 달라 호출부에 남긴다.
use crate::models::Attachment;
use std::path::{Path, PathBuf};

/// 썸네일 후속 단계 — **동기·블로킹**이다. 호출자가 spawn_blocking 으로 감싸야 한다.
///
/// 썸네일은 (1) DB 락 밖에서, (2) 커맨드 스레드 밖에서 만든다. 실측: 4000x3000 한 장
/// 디코드+인코드가 ~300ms 이고, 그 동안 DB 를 전혀 안 쓰는 attachments_base_dir 조차
/// 1,837ms 대기했다(평소 2ms) — Tauri 는 동기 커맨드를 직렬로 돌리므로 락만 놓는 걸로는
/// 부족하고 spawn_blocking 이 필요하다. 실패해도 첨부는 유효하다(타일은 플레이스홀더,
/// attachment_thumbs 가 나중에 재시도).
///
/// rel_path 가 없으면 저절로 건너뛴다 — 참조 첨부(ext_path)·링크에는 앱이 만들 파일이 없다.
/// 반환값은 만들어진 썸네일의 rel_path(현재 호출부 셋은 모두 무시한다).
pub fn ensure_thumb(data_dir: &Path, att: &Attachment) -> Option<String> {
    let rel = att.rel_path.as_deref()?;
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !super::wants_thumbnail(&att.kind, ext) {
        return None;
    }
    super::ensure_thumb_for_attachment(data_dir, rel)
}

/// 사진 EXIF·음성 업로드 메타 → 노트 날짜/경유지 자동 반영(`photo_meta_mode`) — 썸네일과 같은 커밋 후
/// 후속 단계지만 네트워크(지오코딩)가 끼므로 fire-and-forget spawn. 실패해도 첨부는 유효하다
/// (exif_region 내부에서 전부 삼킨다).
/// `remote` 는 발행할 이벤트 표면(데스크톱 false / 원격 업로드 true). `hint` = 업로드 쿼리
/// (recorded_at/lat/lng) — 데스크톱 커맨드 둘은 None. 오디오는 hint 가 있을 때만 의미가 있다.
///
/// sync_server 자체가 tauri::async_runtime 위에서 뜨므로(sync_server::start) 데스크톱 커맨드와
/// 원격 핸들러가 같은 런타임에 얹힌다.
pub fn spawn_auto_meta(
    data_dir: &Path,
    note_id: &str,
    att: &Attachment,
    remote: bool,
    hint: Option<super::PhotoMeta>,
) {
    spawn_auto_meta_inner(data_dir, note_id, att, remote.then_some(None), hint);
}

/// 원격 업로드용 — 요청의 `X-Brise-Client` 를 뒤늦게 나가는 통지에도 씌운다(M-21: 폰이 자기 업로드를
/// "다른 기기의 변경"으로 오인하지 않게).
pub fn spawn_auto_meta_remote(
    data_dir: &Path,
    note_id: &str,
    att: &Attachment,
    client: Option<String>,
    hint: Option<super::PhotoMeta>,
) {
    spawn_auto_meta_inner(data_dir, note_id, att, Some(client), hint);
}

/// `remote`: None = 데스크톱, Some(client) = 원격(client 는 없을 수 있다).
fn spawn_auto_meta_inner(
    data_dir: &Path,
    note_id: &str,
    att: &Attachment,
    remote: Option<Option<String>>,
    hint: Option<super::PhotoMeta>,
) {
    if att.kind != "image" && att.kind != "audio" {
        return;
    }
    if att.kind == "audio" && hint.is_none() {
        return;
    }
    let Some(rel) = att.rel_path.clone() else {
        return;
    };
    let (data_dir, note_id, kind) = (data_dir.to_path_buf(), note_id.to_string(), att.kind.clone());
    tauri::async_runtime::spawn(async move {
        let run = super::auto_meta(&data_dir, &note_id, &rel, &kind, hint);
        // spawn 된 태스크에는 scope_remote 의 task_local 이 전파되지 않으므로 origin 을 다시 씌운다.
        match remote {
            Some(client) => crate::events::scope_remote(client, run).await,
            None => run.await,
        }
    });
}

/// 스테이징용 임시 디렉터리 경로(만들지는 않는다 — stage_bytes 가 만든다).
///
/// 경로를 호출부가 **먼저** 쥐고 있어야 스테이징이 실패하거나 타임아웃으로 끊겨도 지울 수 있다.
/// `prefix` 는 남은 찌꺼기를 찾을 때 쓰는 표식이다 — "brise-paste"(클립보드) / "brise-upload"(원격).
pub fn staging_dir(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{prefix}-{}", crate::util::new_id()))
}

/// 디스크 경로가 없는 raw 바이트(클립보드 paste·원격 업로드)를 add_file 이 받을 수 있는 경로로
/// 만든다 — **동기·블로킹**, 호출자가 spawn_blocking 으로 감싼다. `dir` 정리도 호출자 몫이다
/// (성공 후에만 지울지, 실패·타임아웃에도 지울지가 호출부마다 다르다).
///
/// 파일명을 새니타이즈해 **원본 이름 그대로** 쓰는 게 핵심이다: 임시 파일명이 uuid.tmp 식이면
/// add_file 이 확장자로 파생하는 kind 가 전부 "doc" 으로 오분류된다. 최종 저장 경로는 add_file 이
/// 자체적으로 다시 정한다(short-id 접두사).
pub fn stage_bytes(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let safe_name = crate::repo::transfer::render::safe_attachment_basename(name);
    let path = dir.join(safe_name);
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, bytes)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn att(kind: &str, rel_path: Option<&str>, ext_path: Option<&str>) -> Attachment {
        Attachment {
            id: "a1".to_string(),
            name: "n".to_string(),
            kind: kind.to_string(),
            rel_path: rel_path.map(str::to_string),
            ext_path: ext_path.map(str::to_string),
            url: None,
            size_bytes: None,
            position: 0,
            transcript: None,
            transcript_inserted: false,
        }
    }

    /// 첨부 저장소 안에 실제 PNG 를 하나 놓고 rel_path 를 돌려준다.
    fn put_png(data_dir: &Path, rel: &str, w: u32, h: u32) {
        let full = db::attachments_dir(data_dir).join(crate::repo::paths::safe_rel(rel).unwrap());
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        })
        .save(&full)
        .unwrap();
    }

    fn thumb_exists(data_dir: &Path, rel: &str) -> bool {
        db::attachments_dir(data_dir)
            .join(crate::repo::paths::safe_rel(&super::super::thumb_rel_for(rel)).unwrap())
            .is_file()
    }

    #[test]
    fn ensure_thumb_generates_for_image() {
        let temp = tempfile::tempdir().unwrap();
        put_png(temp.path(), "note1/shot.png", 400, 300);
        let a = att("image", Some("note1/shot.png"), None);
        assert_eq!(
            ensure_thumb(temp.path(), &a).as_deref(),
            Some("note1/shot.png.thumb.jpg")
        );
        assert!(thumb_exists(temp.path(), "note1/shot.png"));
    }

    #[test]
    fn ensure_thumb_skips_svg_and_non_image_kinds() {
        let temp = tempfile::tempdir().unwrap();
        // SVG 는 decode 대상이 아니다(thumbs::wants_thumbnail 이 제외).
        let svg_rel = "note1/logo.svg";
        let full = db::attachments_dir(temp.path()).join(svg_rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, b"<svg/>").unwrap();
        assert_eq!(ensure_thumb(temp.path(), &att("image", Some(svg_rel), None)), None);
        assert!(!thumb_exists(temp.path(), svg_rel));

        // kind 가 image 가 아니면 확장자가 png 여도 만들지 않는다.
        put_png(temp.path(), "note1/doc.png", 40, 30);
        assert_eq!(
            ensure_thumb(temp.path(), &att("doc", Some("note1/doc.png"), None)),
            None
        );
        assert!(!thumb_exists(temp.path(), "note1/doc.png"));
    }

    #[test]
    fn ensure_thumb_skips_reference_attachment() {
        let temp = tempfile::tempdir().unwrap();
        // 참조 모드(ext_path)는 rel_path 가 없다 — 앱 폴더에 만들 파일이 없으니 조용히 건너뛴다.
        let a = att("image", None, Some("C:/photos/raw.png"));
        assert_eq!(ensure_thumb(temp.path(), &a), None);
    }

    #[test]
    fn stage_bytes_writes_sanitized_name_and_dir_is_removable() {
        let dir = staging_dir("brise-test");
        assert!(!dir.exists(), "staging_dir 은 경로만 만든다");
        // 경로 조각은 벗겨져 반드시 dir 안에 떨어지고, 확장자는 살아 있어야 한다
        // (임시 파일명이 확장자를 잃으면 add_file 의 kind 판별이 전부 "doc" 이 된다).
        let path = stage_bytes(&dir, "../../evil photo.PNG", b"bytes").unwrap();
        assert_eq!(path.parent().unwrap(), dir);
        assert_eq!(path.file_name().unwrap(), "evil photo.PNG");
        assert_eq!(std::fs::read(&path).unwrap(), b"bytes");

        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    /// 회귀: 신뢰할 수 없는 이름(hwpx 의 zip 엔트리 이름, 원격 업로드 이름)이 무엇이든 스테이징 파일은 `dir` 의 **직계**여야 한다.
    /// `C:x.png` 는 `Path::join` 이 기준 경로를 통째로 대체하는 드라이브 접두사 상대 경로라 `dir` 밖(현재 작업 폴더)에 쓰였다.
    /// 호스트 OS 와 무관하게 "결과 경로의 부모 == dir" 로 단언한다 — Windows 가 아닌 곳에서는 탈출이 안 일어나 조용히 통과할 뿐이다.
    #[test]
    fn stage_bytes_stays_inside_dir_for_hostile_names() {
        let dir = staging_dir("brise-test-hostile");
        let leaked = std::env::current_dir().unwrap().join("zzprobe_stage.png");
        // 단언이 실패해 일찍 끝나도(탈출이 실제로 일어난 경우) 현재 작업 폴더에 파일이 남지 않게 한다.
        struct Cleanup(PathBuf, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let _cleanup = Cleanup(leaked.clone(), dir.clone());
        let long = format!("{}.png", "x".repeat(300));
        for name in ["C:zzprobe_stage.png", "C:\\zzprobe_stage.png", "a?b.png", "<img onerror=x>.png", "한글 이름?*.png", long.as_str()] {
            let path = stage_bytes(&dir, name, b"bytes").unwrap_or_else(|e| panic!("{name:?}: {e}"));
            assert_eq!(path.parent().unwrap(), dir, "{name:?}");
            assert!(path.is_file(), "{name:?}");
        }
        // 탈출했다면 현재 작업 폴더에 남는다.
        assert!(!leaked.exists(), "스테이징 폴더 밖(현재 작업 폴더)에 파일이 쓰였다");
    }

    #[test]
    fn spawn_auto_meta_ignores_non_media_reference_and_hintless_audio() {
        // 전부 즉시 반환이라 런타임을 건드리지 않는다(spawn 까지 가면 이 테스트가 패닉한다).
        let temp = tempfile::tempdir().unwrap();
        spawn_auto_meta(temp.path(), "note1", &att("doc", Some("note1/a.pdf"), None), false, None);
        spawn_auto_meta(temp.path(), "note1", &att("image", None, Some("C:/a.png")), true, None);
        spawn_auto_meta(temp.path(), "note1", &att("audio", Some("note1/a.webm"), None), true, None);
    }
}
