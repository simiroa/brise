// repo: section_import_scan — 드롭/다중선택 경로를 section_import_file 이 먹을 수 있는 파일
// 경로 목록으로 펼친다 (specs/commands/sections.yaml section_import_scan 규칙).
use crate::error::AppResult;
use crate::repo::import_ext::is_supported_import_extension;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 200;

/// 확장자 판정은 section_import_file 과 같은 `import_ext` 테이블을 쓴다 — 두 벌로 갈리면 스캔은
/// 통과시키고 가져오기가 거부하는 상태가 생긴다.
pub fn scan_paths(paths: &[String]) -> AppResult<(Vec<String>, i64)> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut skipped: i64 = 0;
    for p in paths {
        walk(Path::new(p), 0, &mut files, &mut skipped);
    }
    files.sort();
    if files.len() > MAX_FILES {
        skipped += (files.len() - MAX_FILES) as i64;
        files.truncate(MAX_FILES);
    }
    let out = files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
    Ok((out, skipped))
}

fn is_hidden(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|s| s.starts_with('.'))
}

/// 재귀 최대 깊이 8, 심볼릭 링크 미추적(순환 방지), 숨김 파일/디렉터리 건너뜀.
/// 숨김 판정은 depth>0(탐색 중 발견한 항목)에만 적용한다 — 호출자가 명시적으로 준 최상위
/// 경로 자체는 검사하지 않는다(예: 임시 디렉터리 프리픽스가 우연히 "."로 시작하는 경우가 있다).
/// 개별 경로의 IO 실패(사라진 경로 · 권한 없는 디렉터리)는 **치명적이지 않다** — skipped 로 세고
/// 나머지 경로는 계속 훑는다. 폴더 하나가 안 읽힌다고 드롭한 파일 전부를 버리면, 실패해도 나머지는
/// 계속 진행하는 이 저장소의 배치 관례(lib/batchActions.ts::runBatch, repo 배치 경로들)와 어긋난다.
fn walk(path: &Path, depth: usize, files: &mut Vec<PathBuf>, skipped: &mut i64) {
    if depth > MAX_DEPTH || (depth > 0 && is_hidden(path)) {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        *skipped += 1;
        return;
    };
    if meta.file_type().is_symlink() {
        return; // 따라가지 않는다
    }
    if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(path) else {
            *skipped += 1;
            return;
        };
        for entry in entries {
            match entry {
                Ok(entry) => walk(&entry.path(), depth + 1, files, skipped),
                Err(_) => *skipped += 1,
            }
        }
        return;
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
    if is_supported_import_extension(&ext) {
        files.push(path.to_path_buf());
    } else {
        *skipped += 1;
    }
}

#[cfg(test)]
mod tests {
    /// 사라진/못 읽는 경로 하나가 배치 전체를 죽이지 않는다 — skipped 로 세고 나머지는 계속.
    #[test]
    fn test_scan_unreadable_path_is_skipped_not_fatal() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("a.md");
        std::fs::write(&good, "hello").unwrap();
        let missing = dir.path().join("nope-does-not-exist.md");

        let (files, skipped) = scan_paths(&[
            missing.to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(files.len(), 1, "the readable file must still be imported");
        assert!(files[0].ends_with("a.md"));
        assert_eq!(skipped, 1, "the unreadable path is counted, not fatal");
    }

    use super::*;

    #[test]
    fn test_scan_expands_directory_and_counts_unsupported_as_skipped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.md"), "b").unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("ignore.exe"), "x").unwrap();
        std::fs::write(dir.path().join(".hidden.md"), "h").unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("c.csv"), "c").unwrap();

        let (files, skipped) = scan_paths(&[dir.path().to_string_lossy().into_owned()]).unwrap();

        assert_eq!(skipped, 1); // ignore.exe 만 — 숨김 파일은 세지 않는다
        assert_eq!(files.len(), 3);
        // 경로 오름차순 정렬 — 매번 같은 순서.
        let mut sorted = files.clone();
        sorted.sort();
        assert_eq!(files, sorted);
        assert!(files.iter().any(|f| f.ends_with("a.txt")));
        assert!(files.iter().any(|f| f.ends_with("b.md")));
        assert!(files.iter().any(|f| f.ends_with("c.csv")));
    }

    #[test]
    fn test_scan_caps_at_200_and_counts_overflow_as_skipped() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..205 {
            std::fs::write(dir.path().join(format!("f{i:03}.txt")), "x").unwrap();
        }
        let (files, skipped) = scan_paths(&[dir.path().to_string_lossy().into_owned()]).unwrap();
        assert_eq!(files.len(), 200);
        assert_eq!(skipped, 5);
    }
}
