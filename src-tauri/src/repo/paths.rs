// 공용 경로 안전성 검증 (R5) — attachments::open / transfer::export_note / import_bundle 모두 이걸 통과시켜야 한다.
use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// rel_path를 정규화 후 attachments/ 하위에 머무는지 검증.
///
/// `:` 가 든 컴포넌트는 거부한다(W6 검증 V1). Windows 는 `n1/C:x` 의 `C:x` 를 `Normal` 로 파싱하지만 `PathBuf::push` 는 접두사가
/// 있는 경로를 받으면 **버퍼 전체를 갈아 치워** `C:x`(드라이브 상대 경로)가 남았다 — 루트에 join 해도 루트 밖(그 드라이브의 현재
/// 폴더, 다른 드라이브면 사실상 절대 경로)을 가리켜 내보내기 복사·각주 읽기·첨부 삭제·백업 복원이 모두 새었다. `:` 는 Windows
/// 파일 이름에 쓸 수 없는 글자이고(NTFS 대체 데이터 스트림 `a.png:zone` 도 이것으로 같이 막힌다) 앱이 만드는 저장 이름에는
/// 나오지 않는다(`normalize_stored_name` 이 `-` 로 바꾼다) — 어느 OS 에서든 같은 규칙으로 막는다.
pub fn safe_rel(rel: &str) -> AppResult<PathBuf> {
    let p = Path::new(rel);
    let mut clean = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) if s.to_string_lossy().contains(':') => {
                return Err(AppError::Validation(format!("path escapes attachments/: {rel}")));
            }
            Component::Normal(s) => clean.push(s),
            // 절대경로, 상위 디렉토리, 현재 디렉토리, prefix(Windows 드라이브 등) 거부
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir => {
                return Err(AppError::Validation(format!("path escapes attachments/: {rel}")));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(AppError::Validation("empty path".to_string()));
    }
    // 불변식: 결과는 일반 컴포넌트만으로 된 상대 경로다. 위 검사가 놓친 모양이 있어도 루트·접두사가 생긴 결과는 내보내지 않는다.
    if !clean.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(AppError::Validation(format!("path escapes attachments/: {rel}")));
    }
    Ok(clean)
}

/// `root` 아래 `rel` 이 가리키는 **일반 파일**의 경로 — 없거나 폴더·심볼릭 링크 자체이거나 루트 밖이면 None.
/// `safe_rel` 은 문자열 컴포넌트만 본다 — 디스크에서 실제로 루트 안인지(정션·심볼릭 링크 폴더로 새지 않는지)는 정규화 경로 포함
/// 검사로 한 번 더 본다(doc_export `attachment_resolver`·sync_server 첨부 핸들러와 같은 관문). 첨부 파일을 루트 밖으로 **내보내는**
/// 자리(Markdown 내보내기의 첨부 복사·각주 본문 읽기)가 쓴다.
pub fn file_inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let file = root.join(safe_rel(rel).ok()?);
    if !std::fs::symlink_metadata(&file).ok()?.is_file() {
        return None;
    }
    file.canonicalize().ok()?.starts_with(root.canonicalize().ok()?).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::{file_inside, safe_rel};

    /// 결함 재현(W6 검증 V1): 뒤쪽 컴포넌트의 드라이브 문자(`C:x`)는 `Normal` 로 파싱되지만, `PathBuf::push` 는 접두사가 있는
    /// 경로를 받으면 **버퍼 전체를 갈아 치운다** — `n1/C:x` 가 `C:x`(드라이브 상대 경로)가 되어 첨부 루트에 join 해도 루트 밖을 가리켰다.
    /// `:` 는 어느 OS 에서든 같은 검사라 cfg 없이 실패·통과한다(NTFS 대체 데이터 스트림 `a.png:zone` 도 같이 막는다).
    #[test]
    fn rejects_drive_letters_and_ads_in_any_component() {
        for rel in ["n1/C:x", "n1/C:x/y", "n1/D:dir/f", r"n1/\\?\C:\x", r"n1/\?\C:\x", "C:x", "n1/a.png:zone", "n1/C:"] {
            assert!(safe_rel(rel).is_err(), "{rel} must be rejected, got {:?}", safe_rel(rel));
        }
    }

    #[test]
    fn rejects_escapes_and_accepts_plain_relative_paths() {
        for rel in ["../x", "n1/../../x", "/abs", "", "./x"] {
            assert!(safe_rel(rel).is_err(), "{rel} must be rejected");
        }
        assert_eq!(safe_rel("n1/사진.png").unwrap(), std::path::Path::new("n1").join("사진.png"));
        assert_eq!(safe_rel("n1/a.png.thumb.jpg").unwrap(), std::path::Path::new("n1").join("a.png.thumb.jpg"));
    }

    #[test]
    fn file_inside_returns_only_regular_files_under_the_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("n1").join("sub")).unwrap();
        std::fs::write(root.path().join("n1").join("a.png"), b"x").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"s").unwrap();
        assert_eq!(file_inside(root.path(), "n1/a.png"), Some(root.path().join("n1").join("a.png")));
        for rel in ["n1/missing.png", "n1/sub", "n1", "../secret.txt", "n1/C:secret.txt"] {
            assert_eq!(file_inside(root.path(), rel), None, "{rel}");
        }
    }
}
