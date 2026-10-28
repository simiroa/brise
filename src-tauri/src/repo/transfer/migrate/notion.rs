// repo: transfer::migrate::notion — 2번째 마이그레이션 슬라이스: Notion "Export as Markdown &
// CSV" zip. §2.5 HANDOFF-calendar-onboarding.md. markdown.rs 가 참조 구현: 이 파일도 StagedNote
// 로 수렴해 commit_staged() 를 그대로 쓴다.
use super::{commit_staged, MigrationResult, StagedNote};
use crate::error::{AppError, AppResult};
use crate::util::now_iso;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// Notion Zip 엔트리 수 상한: 20,000개 (압축 폭탄 방어)
const MAX_ZIP_ENTRIES: usize = 20_000;

/// Notion Zip 총 비압축 바이트 상한: 500MB (메모리 폭탄 방어)
const MAX_ZIP_UNCOMPRESSED_BYTES: u64 = 500 * 1024 * 1024;

/// 임포트 단일 파일 상한: 50MB (메모리 폭탄 / DoS 방지)
const MAX_SINGLE_FILE_BYTES: u64 = 50 * 1024 * 1024;

pub fn import_notion_zip(
    conn: &mut Connection,
    folder_id: &str,
    zip_path: &Path,
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

    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::Validation(format!("zip_path not readable: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Validation(format!("not a valid zip: {e}")))?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(AppError::Validation(format!(
            "notion zip contains too many entries ({} > max {})",
            archive.len(),
            MAX_ZIP_ENTRIES
        )));
    }

    let mut total_uncompressed_bytes: u64 = 0;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            total_uncompressed_bytes = total_uncompressed_bytes.saturating_add(entry.size());
        }
    }
    if total_uncompressed_bytes > MAX_ZIP_UNCOMPRESSED_BYTES {
        return Err(AppError::Validation(format!(
            "notion zip uncompressed size exceeds limit of {} MB",
            MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024
        )));
    }

    let mut staged = Vec::new();
    let mut parse_skipped: i64 = 0;

    // ponytail (not just a shortcut — this is the deliberate design): read every entry's bytes
    // straight from the `Read` impl on `ZipFile` into memory, never through `ZipArchive::extract`
    // or any write to disk. That sidesteps zip-slip path-traversal entirely — there is no
    // extraction path to sanitize (leading "../", absolute paths, symlink targets) when nothing
    // is ever written back to the filesystem. `by_index` walks every entry regardless of nesting
    // depth, so Notion's "Parent <id>/Child <id>.md" sub-page folders are covered without any
    // recursion of our own.
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => {
                parse_skipped += 1;
                continue;
            }
        };
        if entry.is_dir() || entry.size() > MAX_SINGLE_FILE_BYTES {
            if entry.size() > MAX_SINGLE_FILE_BYTES {
                parse_skipped += 1;
            }
            continue;
        }
        let name = match entry.name() {
            Ok(n) => n.to_string(),
            Err(_) => {
                parse_skipped += 1;
                continue;
            }
        };
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();

        if ext == "csv" {
            // ponytail (deliberate scope cut, documented — not an oversight): each CSV is a
            // Notion database *view* export. Turning it into notes means one row -> one note,
            // deciding which column is the title/date/tags per-database — that's real scope for
            // its own slice, not a few lines here. Count it as skipped (not silently dropped) so
            // `skipped` in the result honestly reflects what got left on the table.
            parse_skipped += 1;
            continue;
        }
        if ext != "md" {
            // Notion zips also bundle page images/attachments alongside the .md files; those
            // don't map to a note at all, so — same as markdown.rs ignoring non-.md files — they
            // are skipped silently, not counted (nothing was "left out" of the import scope).
            continue;
        }

        let mut body = String::new();
        if std::io::Read::read_to_string(&mut entry, &mut body).is_err() {
            parse_skipped += 1;
            continue;
        }

        let title = notion_title(&name);
        let created_at = resolve_created_at(entry.last_modified());
        staged.push(StagedNote {
            title,
            body_md: body,
            tag_names: Vec::new(), // Notion markdown export carries no tag data for this slice.
            // Same reasoning as markdown.rs: notes.year is the EVENT axis (what the note is
            // ABOUT); this format has no signal for that at all (not even a record-axis date to
            // (mis)use), so it stays None -> create()'s honest "unknown" default (1900).
            year: None,
            created_at,
        });
    }

    let mut result = commit_staged(conn, folder_id, staged)?;
    result.skipped += parse_skipped;
    Ok(result)
}

/// Notion appends a space + a 32-hex-char id to every exported filename/folder name, e.g.
/// `My Page Title a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.md`. Only the final path component matters —
/// this is called on the entry's own file stem, so nested `Parent <id>/Child <id>.md` paths work
/// without any special-casing (the parent segment is simply never looked at).
fn notion_title(entry_name: &str) -> String {
    let stem = Path::new(entry_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| entry_name.to_string());
    let title = strip_notion_id_suffix(&stem);
    if title.trim().is_empty() {
        "Untitled Note".to_string()
    } else {
        title
    }
}

// ponytail: heuristic ceiling — a real title that happens to end in " " + 32 hex-looking chars
// (e.g. "Hash abcdef0123456789abcdef0123456789") gets stripped too. Notion's format gives no way
// to tell that apart from its own id suffix; false-positive rate is negligible in practice. Not
// worth guarding — upgrade path only if a future Notion export ever exposes an unambiguous marker.
fn strip_notion_id_suffix(stem: &str) -> String {
    let chars: Vec<char> = stem.chars().collect();
    if chars.len() <= 32 {
        return stem.to_string();
    }
    let split_at = chars.len() - 32;
    let is_hex_id = chars[split_at..].iter().all(|c| c.is_ascii_hexdigit());
    if is_hex_id && chars[split_at - 1] == ' ' {
        chars[..split_at - 1].iter().collect()
    } else {
        stem.to_string()
    }
}

/// Original-timestamp preservation, weaker signal than markdown.rs's frontmatter chain: Notion's
/// markdown export has no reliable in-body creation-date line and typically no YAML frontmatter
/// at all across Notion versions, so there is no "real" created-at to parse here. The zip entry's
/// own `last_modified()` (export time, not creation time — say so, don't pretend otherwise) is
/// the best available fallback; `now_iso()` covers the (rare) case where even that is absent or
/// out of the DOS-timestamp's valid range.
fn resolve_created_at(entry_dt: Option<zip::DateTime>) -> String {
    entry_dt
        .and_then(zip_datetime_to_iso)
        .unwrap_or_else(now_iso)
}

fn zip_datetime_to_iso(dt: zip::DateTime) -> Option<String> {
    let date =
        chrono::NaiveDate::from_ymd_opt(dt.year() as i32, dt.month() as u32, dt.day() as u32)?;
    let time =
        chrono::NaiveTime::from_hms_opt(dt.hour() as u32, dt.minute() as u32, dt.second() as u32)?;
    let naive = chrono::NaiveDateTime::new(date, time);
    let utc = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc);
    Some(utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    /// Builds a zip in memory (per the brief: no committed binary fixtures) and writes its bytes
    /// to a real temp file, since `import_notion_zip` takes a path — round-tripping through a
    /// path is also what exercises `std::fs::File::open` + `ZipArchive::new` for real.
    fn build_zip(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(content).unwrap();
        }
        let cursor = writer.finish().unwrap();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(cursor.get_ref()).unwrap();
        tmp
    }

    #[test]
    fn strips_id_suffix_with_and_without_id() {
        assert_eq!(
            strip_notion_id_suffix("My Page Title a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
            "My Page Title"
        );
        // no id suffix at all -> unchanged.
        assert_eq!(strip_notion_id_suffix("Plain Title"), "Plain Title");
        // punctuation in the title, id present.
        assert_eq!(
            strip_notion_id_suffix("Q&A: What now? a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
            "Q&A: What now?"
        );
        // 32 hex-looking chars but no preceding space -> not treated as an id suffix.
        assert_eq!(
            strip_notion_id_suffix("titlea1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
            "titlea1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
        );
        // trailing segment isn't valid hex -> unchanged.
        assert_eq!(
            strip_notion_id_suffix("Title with words at the end"),
            "Title with words at the end"
        );
    }

    #[test]
    fn notion_title_handles_nested_path() {
        // only the final path component (the child page) should feed the title.
        assert_eq!(
            notion_title("Parent Page a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/Child Page b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1.md"),
            "Child Page"
        );
    }

    #[test]
    fn csv_entries_are_skipped_not_attempted() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let zip = build_zip(&[
            ("Page.md", b"# Page\n\nBody"),
            ("Database view.csv", b"Name,Date\nRow 1,2020-01-01\n"),
        ]);

        let result = import_notion_zip(&mut conn, &folder_id, zip.path()).unwrap();
        assert_eq!(result.imported, 1, "only the .md entry becomes a note");
        assert_eq!(result.skipped, 1, "the .csv entry is counted as skipped, not attempted");
    }

    #[test]
    fn nested_folder_entries_are_imported_and_body_reaches_the_note() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let zip = build_zip(&[
            ("Top a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.md", b"Top level body"),
            (
                "Parent b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1/Child c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2.md",
                b"Nested child body",
            ),
        ]);

        let result = import_notion_zip(&mut conn, &folder_id, zip.path()).unwrap();
        assert_eq!(result.imported, 2);
        assert_eq!(result.skipped, 0);

        // The exact bug slice 1's own review caught: assert the body text actually landed, not
        // just that some note got created.
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
        assert!(bodies.iter().any(|b| b.contains("Top level body")));
        assert!(bodies.iter().any(|b| b.contains("Nested child body")));

        let titles: Vec<String> = result
            .note_ids
            .iter()
            .map(|id| crate::repo::notes::note_summary(&conn, id).unwrap().title)
            .collect();
        assert!(titles.contains(&"Top".to_string()));
        assert!(titles.contains(&"Child".to_string()));
    }

    #[test]
    fn zip_entry_timestamp_becomes_created_at() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // SimpleFileOptions::default() stamps the *current* wall-clock time (DateTime::default_
        // for_write()), so — same reason as markdown.rs's mtime test — we don't pin that. Here we
        // set an explicit last_modified_time fixture instead: that lets us assert the exact
        // converted instant without depending on the real clock at all.
        let dt = zip::DateTime::from_date_and_time(2019, 3, 4, 12, 30, 0).unwrap();
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "Dated Page a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.md",
                SimpleFileOptions::default().last_modified_time(dt),
            )
            .unwrap();
        writer.write_all(b"Body").unwrap();
        let cursor = writer.finish().unwrap();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(cursor.get_ref()).unwrap();

        let result = import_notion_zip(&mut conn, &folder_id, tmp.path()).unwrap();
        assert_eq!(result.imported, 1);
        let note = crate::repo::notes::note_summary(&conn, &result.note_ids[0]).unwrap();
        chrono::DateTime::parse_from_rfc3339(&note.created_at)
            .expect("zip-entry timestamp fallback must be valid RFC3339");
        assert_eq!(note.created_at, "2019-03-04T12:30:00.000Z");
    }

    #[test]
    fn unreadable_entry_content_is_skipped_not_aborted() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let zip = build_zip(&[
            ("Good Page.md", b"Good body"),
            // invalid UTF-8 bytes -> read_to_string fails, mirrors markdown.rs's
            // invalid-utf8 file test but at the zip-entry level.
            ("Bad Page.md", &[0xFFu8, 0xFE, 0x00, 0xC0]),
        ]);

        let result = import_notion_zip(&mut conn, &folder_id, zip.path()).unwrap();
        assert_eq!(result.imported, 1, "Good Page still imports");
        assert_eq!(result.skipped, 1, "Bad Page is skipped, batch is not aborted");
    }

    #[test]
    fn unknown_folder_id_is_not_found() {
        let mut conn = setup_db();
        let zip = build_zip(&[("Page.md", b"Body")]);
        let err = import_notion_zip(&mut conn, "no-such-folder", zip.path()).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn non_zip_file_is_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(b"not a zip file at all").unwrap();
        let err = import_notion_zip(&mut conn, &folder_id, tmp.path()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn missing_zip_path_is_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ghost = std::env::temp_dir().join("does-not-exist-brise-notion-test.zip");
        let err = import_notion_zip(&mut conn, &folder_id, &ghost).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn normal_notion_import_respects_limits() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let zip = build_zip(&[("Page.md", b"Body content")]);
        let result = import_notion_zip(&mut conn, &folder_id, zip.path()).unwrap();
        assert_eq!(result.imported, 1);
    }
}
