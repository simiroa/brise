// repo: transfer::migrate::markdown — 1번째 마이그레이션 슬라이스: Markdown 폴더 + YAML
// 프론트매터 (Obsidian / Bear / Logseq / Joplin). §2.5 HANDOFF-calendar-onboarding.md.
// 앱별 프론트매터 키 차이는 아래 *_KEYS 별칭 목록으로만 흡수한다 — 새 앱을 추가 지원할 땐
// 이 파일의 파싱 로직이 아니라 별칭 목록만 늘리면 된다.
use super::{commit_staged, MigrationResult, StagedNote};
use crate::error::{AppError, AppResult};
use crate::util::now_iso;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const TITLE_KEYS: &[&str] = &["title"];
const DATE_KEYS: &[&str] = &["created", "date", "created_at", "ctime", "date_created"];
const TAGS_KEYS: &[&str] = &["tags", "tag"];

pub fn import_markdown_folder(
    conn: &mut Connection,
    folder_id: &str,
    source_dir: &Path,
) -> AppResult<MigrationResult> {
    let folder_exists: bool = conn
        .query_row("SELECT 1 FROM folders WHERE id = ?1", [folder_id], |_| {
            Ok(true)
        })
        .optional()
        .map_err(crate::error::db)?
        .unwrap_or(false);
    if !folder_exists {
        return Err(AppError::NotFound(format!("folder not found: {folder_id}")));
    }
    if !source_dir.is_dir() {
        return Err(AppError::Validation(format!(
            "source_dir is not a directory: {}",
            source_dir.display()
        )));
    }

    let mut paths = Vec::new();
    collect_md_files(source_dir, &mut paths);

    let mut staged = Vec::new();
    let mut parse_skipped: i64 = 0;
    for path in &paths {
        match stage_one(path) {
            Some(note) => staged.push(note),
            None => parse_skipped += 1,
        }
    }

    let mut result = commit_staged(conn, folder_id, staged)?;
    result.skipped += parse_skipped;
    Ok(result)
}

// ponytail: hand-rolled recursion instead of the walkdir crate — walkdir is only a transitive
// dependency here (not in Cargo.toml directly), and the brief for this slice explicitly asks to
// avoid new dependencies. A source tree of markdown notes is small enough that this ~15-line
// recursion is cheaper than adding+auditing a crate for it. Upgrade path if this app ever needs
// symlink-loop safety or gitignore-style filtering: walkdir.
fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let canonical_root = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let mut visited = HashSet::new();
    collect_md_files_inner(dir, &canonical_root, &mut visited, out);
}

fn collect_md_files_inner(
    dir: &Path,
    canonical_root: &Path,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<PathBuf>,
) {
    let Ok(canonical_dir) = dir.canonicalize() else {
        return;
    };
    if !canonical_dir.starts_with(canonical_root) {
        return;
    }
    if !visited.insert(canonical_dir.clone()) {
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }

        if meta.is_dir() {
            collect_md_files_inner(&path, canonical_root, visited, out);
        } else if meta.is_file() {
            if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                if let Ok(canonical_path) = path.canonicalize() {
                    if canonical_path.starts_with(canonical_root) {
                        out.push(path);
                    }
                }
            }
        }
    }
}

/// 임포트 단일 파일 상한: 50MB (메모리 폭탄 / DoS 방지)
const MAX_SINGLE_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// 파일 한 건을 `StagedNote` 로 변환. 읽기 실패(존재하지 않음/권한 등)만 `None` — 그 외에는
/// 항상 뭔가를 만든다(프론트매터 없음/파싱 불가 필드는 전부 폴백이 있다).
fn stage_one(path: &Path) -> Option<StagedNote> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_SINGLE_FILE_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let fm = frontmatter
        .map(|s| parse_frontmatter(&s))
        .unwrap_or_default();

    let title = fm
        .get_first(TITLE_KEYS)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| filename_stem(path));

    let tag_names = fm.get_list(TAGS_KEYS);
    let created_at = resolve_created_at(&fm, path);

    Some(StagedNote {
        title,
        body_md: body,
        tag_names,
        // ponytail (judgment call, not a shortcut): year defaults to None (→ create()'s existing
        // 1900 default) instead of deriving it from resolved created_at. notes.year is documented
        // elsewhere as the EVENT axis (what the note is ABOUT); a file's frontmatter date / mtime
        // is a RECORD-axis proxy that would silently assert a false event year on every imported
        // note (e.g. a 2019 Obsidian export of a note about the 1800s). 1900 honestly encodes
        // "unknown" instead of a confident wrong guess. Upgrade path: only if a format exposes a
        // real event-date key distinct from created/date/ctime, map that (not this chain) to year.
        year: None,
        created_at,
    })
}

fn filename_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled Note".to_string())
}

/// `---\n` 로 시작하면 프론트매터로 취급 — 닫는 `---` 줄까지가 YAML, 그 다음부터 본문.
/// 닫는 구분자를 못 찾으면 프론트매터 없음으로 취급(원문 전체를 본문으로 되돌린다).
fn split_frontmatter(raw: &str) -> (Option<String>, String) {
    if !raw.starts_with("---\n") {
        return (None, raw.to_string());
    }
    let mut lines = raw.lines();
    lines.next(); // consume opening "---"
    let rest: Vec<&str> = lines.collect();
    match rest.iter().position(|l| l.trim_end() == "---") {
        Some(close_idx) => {
            let fm = rest[..close_idx].join("\n");
            let body = rest[close_idx + 1..].join("\n");
            (Some(fm), body)
        }
        None => (None, raw.to_string()),
    }
}

enum FmValue {
    Scalar(String),
    List(Vec<String>),
}

#[derive(Default)]
struct Frontmatter(HashMap<String, FmValue>);

impl Frontmatter {
    fn get_first(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|k| match self.0.get(*k) {
            Some(FmValue::Scalar(v)) if !v.is_empty() => Some(v.clone()),
            _ => None,
        })
    }

    fn get_list(&self, keys: &[&str]) -> Vec<String> {
        for k in keys {
            match self.0.get(*k) {
                Some(FmValue::List(v)) => return v.clone(),
                // a single non-list tag value ("tags: history") still counts as one tag.
                Some(FmValue::Scalar(v)) if !v.is_empty() => return vec![v.clone()],
                _ => {}
            }
        }
        Vec::new()
    }
}

/// 플랫 `key: value` 줄 + 한 단계 블록 리스트(`tags:\n  - foo\n  - bar`) + 인라인 리스트
/// (`tags: [foo, bar]`) 만 지원 — serde_yaml 은 이 슬라이스에 의도적으로 넣지 않는다(브리프).
fn parse_frontmatter(fm: &str) -> Frontmatter {
    let mut map: HashMap<String, FmValue> = HashMap::new();
    let lines: Vec<&str> = fm.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        // stray block-list item at top level (malformed / already-consumed) — skip.
        if trimmed.starts_with('-') {
            i += 1;
            continue;
        }
        let Some(colon) = line.find(':') else {
            i += 1;
            continue;
        };
        let key = line[..colon].trim().to_string();
        let rest = line[colon + 1..].trim();

        if rest.is_empty() {
            // possible block list on the following indented "- item" lines.
            let mut items = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                let lt = lines[j].trim_start();
                if let Some(item) = lt.strip_prefix("- ") {
                    items.push(unquote(item));
                    j += 1;
                } else if lt == "-" {
                    j += 1;
                } else {
                    break;
                }
            }
            if items.is_empty() {
                map.insert(key, FmValue::Scalar(String::new()));
                i += 1;
            } else {
                map.insert(key, FmValue::List(items));
                i = j;
            }
        } else if rest.starts_with('[') && rest.ends_with(']') {
            let inner = &rest[1..rest.len().saturating_sub(1)];
            let items: Vec<String> = inner
                .split(',')
                .map(unquote)
                .filter(|s| !s.is_empty())
                .collect();
            map.insert(key, FmValue::List(items));
            i += 1;
        } else {
            map.insert(key, FmValue::Scalar(unquote(rest)));
            i += 1;
        }
    }
    Frontmatter(map)
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 원본 시각 보존 폴백 체인: 프론트매터 날짜 → 파일 mtime → 임포트 시각(now_iso).
fn resolve_created_at(fm: &Frontmatter, path: &Path) -> String {
    if let Some(raw) = fm.get_first(DATE_KEYS) {
        if let Some(parsed) = parse_frontmatter_date(&raw) {
            return parsed;
        }
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(modified) = meta.modified() {
            return system_time_to_iso(modified);
        }
    }
    now_iso()
}

/// 관대한 프론트매터 날짜 파서: bare `YYYY-MM-DD`, 또는 `YYYY-MM-DD[T ]HH:MM:SS`, 또는 명시적
/// tz 오프셋(RFC3339)이 있는 문자열. 타임존 마커가 없는 값은 UTC로 간주(Z 부여) — 이 코드베이스
/// 다른 곳(`src/lib/dateRange.ts` 주석)과 동일한 근거: PKM 프론트매터에 타임존까지 적는 도구는
/// 거의 없고, 이 오차(로컬 자정 근처 최대 하루)를 감수하는 편이 파서를 포기해 mtime으로 떨어지는
/// 것보다 싸다 — mtime은 "원본 작성 시각"이라는 프론트매터의 의도를 아예 놓친다.
fn parse_frontmatter_date(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(
            dt.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(format!("{}.000Z", dt.format("%Y-%m-%dT%H:%M:%S")));
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(format!("{}.000Z", dt.format("%Y-%m-%dT%H:%M:%S")));
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(format!("{}T00:00:00.000Z", d.format("%Y-%m-%d")));
    }
    None
}

fn system_time_to_iso(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn frontmatter_with_block_list_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "note.md",
            "---\ntitle: Block Tags\ncreated: 2020-05-06\ntags:\n  - foo\n  - bar\n---\nBody text\n",
        );
        let note = stage_one(&path).unwrap();
        assert_eq!(note.title, "Block Tags");
        assert_eq!(note.tag_names, vec!["foo".to_string(), "bar".to_string()]);
        assert_eq!(note.created_at, "2020-05-06T00:00:00.000Z");
        assert!(note.body_md.contains("Body text"));
    }

    #[test]
    fn frontmatter_with_inline_list_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "note.md",
            "---\ntitle: Inline Tags\ntags: [foo, bar, \"baz qux\"]\n---\nBody\n",
        );
        let note = stage_one(&path).unwrap();
        assert_eq!(
            note.tag_names,
            vec!["foo".to_string(), "bar".to_string(), "baz qux".to_string()]
        );
    }

    #[test]
    fn frontmatter_absent_title_from_filename_and_created_from_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "My Cool Note.md", "Just a body, no frontmatter.\n");
        let note = stage_one(&path).unwrap();
        assert_eq!(note.title, "My Cool Note");
        assert!(note.body_md.contains("Just a body"));
        // mtime fallback → a valid RFC3339 UTC instant, parseable and not the sentinel "unknown"
        // value. We don't pin an exact timestamp (mtime granularity/clock skew across CI runners)
        // — only that the fallback chain actually produced something real and recent.
        let parsed = chrono::DateTime::parse_from_rfc3339(&note.created_at)
            .expect("mtime fallback must be valid RFC3339");
        let age = chrono::Utc::now().signed_duration_since(parsed);
        assert!(age.num_minutes() < 5, "mtime fallback should be ~now for a freshly written file");
    }

    #[test]
    fn frontmatter_date_unparseable_falls_through_to_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "note.md",
            "---\ntitle: Bad Date\ncreated: not-a-date\n---\nBody\n",
        );
        let note = stage_one(&path).unwrap();
        // must not be the literal garbage string, and must be a valid instant (mtime fallback).
        assert_ne!(note.created_at, "not-a-date");
        chrono::DateTime::parse_from_rfc3339(&note.created_at)
            .expect("unparseable frontmatter date must fall through to a valid mtime instant");
    }

    #[test]
    fn missing_file_is_skipped_not_none_panic() {
        let dir = tempfile::tempdir().unwrap();
        let ghost = dir.path().join("does-not-exist.md");
        assert!(stage_one(&ghost).is_none());
    }

    #[test]
    fn nested_subdirectories_are_walked_and_unreadable_file_only_skips_itself() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "top.md", "---\ntitle: Top\n---\nTop body\n");
        write(
            dir.path(),
            "sub/nested.md",
            "---\ntitle: Nested\n---\nNested body\n",
        );
        write(
            dir.path(),
            "sub/deeper/deep.md",
            "---\ntitle: Deep\n---\nDeep body\n",
        );
        // non-.md file must be ignored entirely, not counted as skipped.
        write(dir.path(), "notes.txt", "not markdown");
        // an unreadable .md file: invalid UTF-8 bytes make read_to_string() fail regardless of
        // OS/permission bits (unlike a directory named "*.md", which collect_md_files never even
        // treats as a file — is_dir() short-circuits it before the read attempt). Exercises the
        // "skip this one, keep going" path portably.
        std::fs::write(dir.path().join("invalid-utf8.md"), [0xFFu8, 0xFE, 0x00, 0xC0]).unwrap();

        let result = import_markdown_folder(&mut conn, &folder_id, dir.path()).unwrap();
        assert_eq!(result.imported, 3, "top + sub/nested + sub/deeper/deep");
        assert_eq!(result.skipped, 1, "the invalid-UTF-8 file failed to read");
        assert_eq!(result.note_ids.len(), 3);

        // End-to-end: the imported body text must actually reach the DB (not silently discarded).
        let bodies: Vec<String> = result
            .note_ids
            .iter()
            .map(|id| {
                crate::repo::notes::note_detail(&conn, id)
                    .unwrap()
                    .sections[0]
                    .body_md
                    .clone()
            })
            .collect();
        assert!(bodies.iter().any(|b| b.contains("Top body")));
        assert!(bodies.iter().any(|b| b.contains("Nested body")));
        assert!(bodies.iter().any(|b| b.contains("Deep body")));
    }

    #[test]
    fn unknown_folder_id_is_not_found() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();
        let err = import_markdown_folder(&mut conn, "no-such-folder", dir.path()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn non_directory_source_is_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file_path = write(dir.path(), "not-a-dir.md", "content");
        let err = import_markdown_folder(&mut conn, &folder_id, &file_path).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn collect_md_files_skips_symlinks_and_handles_loops() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "valid.md", "# Valid");

        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        write(&sub, "nested.md", "# Nested");

        // Try creating symlinks (may fail on Windows without admin/developer mode)
        #[cfg(windows)]
        let link_res = std::os::windows::fs::symlink_dir(root, sub.join("loop_link"));
        #[cfg(not(windows))]
        let link_res = std::os::unix::fs::symlink(root, sub.join("loop_link"));

        let mut collected = Vec::new();
        collect_md_files(root, &mut collected);

        // Even if link creation succeeded, it must not cause infinite loop or include files multiple times.
        let names: Vec<String> = collected
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"valid.md".to_string()));
        assert!(names.contains(&"nested.md".to_string()));

        if link_res.is_ok() {
            // Loop link was created, ensure valid.md is only found once (symlink skipped)
            let valid_count = names.iter().filter(|n| *n == "valid.md").count();
            assert_eq!(valid_count, 1, "symlink loop must be skipped");
        }
    }

    #[test]
    fn stage_one_skips_oversized_markdown_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.md");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_SINGLE_FILE_BYTES + 1).unwrap();

        assert!(stage_one(&path).is_none());
    }
}
