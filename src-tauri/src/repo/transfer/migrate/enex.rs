// repo: transfer::migrate::enex — 3번째(마지막) 마이그레이션 슬라이스: Evernote ENEX export
// (XML, note당 ENML 콘텐츠 + base64 리소스). §2.5 HANDOFF-calendar-onboarding.md — 셋 중
// "가장 무겁다"고 문서가 미리 경고한 슬라이스. markdown.rs/notion.rs 가 참조 구현: 이 파일도
// StagedNote 로 수렴해 commit_staged() 를 그대로 쓴다.
use super::{commit_staged, MigrationResult, StagedNote};
use crate::error::{AppError, AppResult};
use crate::util::now_iso;
use quick_xml::events::Event;
use rusqlite::{Connection, OptionalExtension};
use scraper::{Html, Selector};
use std::path::Path;

/// 임포트 단일 파일 상한: 50MB (메모리 폭탄 / DoS 방지)
const MAX_SINGLE_FILE_BYTES: u64 = 50 * 1024 * 1024;

pub fn import_enex_file(
    conn: &mut Connection,
    folder_id: &str,
    enex_path: &Path,
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

    let meta = std::fs::metadata(enex_path)
        .map_err(|e| AppError::Validation(format!("enex_path not readable: {e}")))?;
    if meta.len() > MAX_SINGLE_FILE_BYTES {
        return Err(AppError::Validation(format!(
            "ENEX file size exceeds maximum limit of {} MB",
            MAX_SINGLE_FILE_BYTES / 1024 / 1024
        )));
    }

    let xml = std::fs::read_to_string(enex_path)
        .map_err(|e| AppError::Validation(format!("enex_path not readable: {e}")))?;

    // Whole-file gate lives in split_notes() — a fully malformed/truncated top-level document is
    // a VALIDATION error for the entire command (see its doc comment). Once past that gate, each
    // chunk is parsed independently: one bad note inside an otherwise-good file only costs that
    // note (counted in skipped), same "partial failure doesn't abort the batch" contract as
    // markdown.rs/notion.rs.
    let chunks = split_notes(&xml)?;

    let mut staged = Vec::new();
    let mut parse_skipped: i64 = 0;
    for chunk in chunks {
        match parse_note_chunk(chunk) {
            Some(raw) => staged.push(stage_one(raw)),
            None => parse_skipped += 1,
        }
    }

    let mut result = commit_staged(conn, folder_id, staged)?;
    result.skipped += parse_skipped;
    Ok(result)
}

/// Splits the raw ENEX text into per-`<note>` slices, and gates the WHOLE command on whether this
/// even looks like an ENEX export at all. This is the same tier as notion.rs's "not a valid zip"
/// case: garbage or truncated top-level input is a VALIDATION error for the whole call, not a
/// per-item skip — a single malformed note *inside* an otherwise-good file is a different,
/// recoverable case handled by parse_note_chunk() returning `None` for just that one chunk.
///
/// ponytail: boundary-finding here is a raw substring scan (`<note>` ... `</note>`), not a real
/// XML parse — cheap and correct for every real Evernote export. Known ceiling: a note whose own
/// body text happens to literally contain the substring "<note>"/"</note>" (e.g. a note ABOUT the
/// ENEX format itself) would throw the scan off. That's caught below (chunks.len() vs open_count)
/// and turned into a whole-file VALIDATION error rather than silently importing a truncated subset
/// — the alternative (a stray "</note>" inside a CDATA body ending a chunk early, silently
/// dropping every note after it with `imported` reporting success) would be a much worse failure
/// mode than a loud rejection. Upgrade path is a real streaming split (track note depth via
/// quick_xml Start/End events instead of text search) if this ever proves too strict in practice.
fn split_notes(xml: &str) -> AppResult<Vec<&str>> {
    if !xml.contains("<en-export") {
        return Err(AppError::Validation(
            "not a valid ENEX file: missing <en-export> root".to_string(),
        ));
    }
    let open_count = xml.matches("<note>").count() + xml.matches("<note ").count();
    let close_count = xml.matches("</note>").count();
    if open_count == 0 {
        return Err(AppError::Validation(
            "not a valid ENEX file: no <note> elements found".to_string(),
        ));
    }
    if open_count != close_count {
        return Err(AppError::Validation(format!(
            "not a valid ENEX file: {open_count} <note> open tag(s) but {close_count} closing tag(s) (truncated?)"
        )));
    }

    let mut chunks = Vec::new();
    let mut rest = xml;
    while let Some(start) = find_note_open(rest) {
        let Some(end_rel) = rest[start..].find("</note>") else {
            break;
        };
        let end = start + end_rel + "</note>".len();
        chunks.push(&rest[start..end]);
        rest = &rest[end..];
    }
    // The substring scan can end early if a note's own body text contains a literal "</note>"
    // (closing a chunk before the note's real end) — every note after that point would then be
    // silently invisible to the rest of this function, with the batch quietly reporting success
    // on a truncated subset. Reconciling against open_count turns that into a loud whole-file
    // VALIDATION error instead of silent data loss.
    if chunks.len() != open_count {
        return Err(AppError::Validation(format!(
            "not a valid ENEX file: expected {open_count} <note> element(s) but only recovered \
             {} note boundaries — a note body may contain a literal \"</note>\" (or the file is \
             corrupted)",
            chunks.len()
        )));
    }
    Ok(chunks)
}

fn find_note_open(s: &str) -> Option<usize> {
    match (s.find("<note>"), s.find("<note ")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

#[derive(Default)]
struct NoteRaw {
    title: String,
    content: String,
    created: Option<String>,
    updated: Option<String>,
    tags: Vec<String>,
}

#[derive(PartialEq, Clone, Copy)]
enum Field {
    None,
    Title,
    Content,
    Created,
    Updated,
    Tag,
}

/// Streams one already-isolated `<note>...</note>` chunk through quick_xml. Returns `None` if the
/// chunk's own inner XML is malformed (mismatched/unclosed tags) — the "one bad item inside a good
/// file" case: the caller counts it toward `skipped` and moves on, it does not abort the batch
/// (see split_notes' doc comment for the whole-file case).
///
/// Security note: quick_xml is a low-level pull/streaming parser — unlike a validating parser
/// (libxml2-style), it never resolves DOCTYPE/external entities at all, so classic XXE (billion
/// laughs, external entity file/URL disclosure) isn't representable here; there is no code path
/// that would fetch or expand an external reference even for a maliciously crafted .enex file.
/// (The ENML payload's own `<!DOCTYPE en-note SYSTEM "...enml2.dtd">` is parsed separately, by
/// `scraper`/html5ever in enml_to_markdown() below, which likewise has no network I/O — it only
/// uses the DOCTYPE to pick quirks-mode, never fetches it.)
fn parse_note_chunk(chunk: &str) -> Option<NoteRaw> {
    let mut reader = quick_xml::Reader::from_str(chunk);
    let mut note = NoteRaw::default();
    let mut field = Field::None;
    let mut resource_depth: u32 = 0;

    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Err(_) => return None,
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if resource_depth > 0 {
                    if name == b"resource" {
                        resource_depth += 1;
                    }
                    continue;
                }
                match name {
                    // Resources (attached files, base64-encoded) are OUT OF SCOPE for this slice —
                    // decoding the base64 payload and wiring it into Brise's own attachments table
                    // (kind/rel_path/thumbnail generation/etc.) is real, separate scope. We don't
                    // even count encountered resources anywhere (unlike a failed note, this isn't
                    // a failure — the note's TEXT still imports fine without its attachments), we
                    // just skip the subtree so its <data>/<mime>/etc. children can't be mistaken
                    // for note-level fields of the same name.
                    b"resource" => resource_depth = 1,
                    b"title" => field = Field::Title,
                    b"content" => field = Field::Content,
                    b"created" => field = Field::Created,
                    b"updated" => field = Field::Updated,
                    b"tag" => {
                        note.tags.push(String::new());
                        field = Field::Tag;
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if resource_depth > 0 {
                    if name == b"resource" {
                        resource_depth -= 1;
                    }
                    continue;
                }
                if matches!(name, b"title" | b"content" | b"created" | b"updated" | b"tag") {
                    field = Field::None;
                }
            }
            Ok(Event::Text(t)) if resource_depth == 0 => {
                if let Ok(s) = std::str::from_utf8(t.as_ref()) {
                    match field {
                        Field::Title => note.title.push_str(s),
                        Field::Created => note.created.get_or_insert_with(String::new).push_str(s),
                        Field::Updated => note.updated.get_or_insert_with(String::new).push_str(s),
                        Field::Tag => {
                            if let Some(last) = note.tags.last_mut() {
                                last.push_str(s);
                            }
                        }
                        Field::Content | Field::None => {}
                    }
                }
            }
            Ok(Event::CData(t)) if resource_depth == 0 && field == Field::Content => {
                if let Ok(s) = std::str::from_utf8(&t) {
                    note.content.push_str(s);
                }
            }
            _ => {}
        }
    }
    Some(note)
}

fn stage_one(raw: NoteRaw) -> StagedNote {
    let title = raw.title.trim();
    let title = if title.is_empty() {
        "Untitled Note".to_string()
    } else {
        title.to_string()
    };
    let body_md = enml_to_markdown(&raw.content);
    let created_at = resolve_created_at(raw.created.as_deref(), raw.updated.as_deref());
    let tag_names = raw
        .tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    StagedNote {
        title,
        body_md,
        tag_names,
        // Same reasoning as markdown.rs/notion.rs, restated for this format: notes.year is the
        // EVENT axis (what the note is ABOUT), not when it was recorded. ENEX's <created>/
        // <updated> are exactly record-axis timestamps — mapping them into `year` would assert a
        // confident but frequently wrong event date (an Evernote clip made in 2015 about an 1820s
        // photograph is not "about" 2015). None here means create()'s honest "unknown" default
        // (1900), same as the other two slices.
        year: None,
        created_at,
    }
}

/// ENEX's `<created>`/`<updated>` are always `YYYYMMDDTHHMMSSZ` — UTC, unambiguous, no fallback
/// chain needed at the *format* level (a stronger signal than either prior slice had). Per-note
/// fallback stays for the rare case one specific note is missing or has an unparseable value for
/// one of the two: created -> updated -> import time.
fn resolve_created_at(created: Option<&str>, updated: Option<&str>) -> String {
    created
        .and_then(parse_enex_timestamp)
        .or_else(|| updated.and_then(parse_enex_timestamp))
        .unwrap_or_else(now_iso)
}

fn parse_enex_timestamp(raw: &str) -> Option<String> {
    let naive = chrono::NaiveDateTime::parse_from_str(raw.trim(), "%Y%m%dT%H%M%SZ").ok()?;
    let utc = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc);
    Some(utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Converts ENML (the CDATA payload of `<content>`, itself an `<en-note>...</en-note>` XHTML-ish
/// document) to reasonable-fidelity Markdown. Parsed with `scraper` (html5ever) — same crate/
/// pattern repo::web_reader.rs already uses for its DOM walk — rather than a real XML parse, since
/// html5ever tolerates the non-standard `<en-note>`/`<en-media>`/`<en-todo>` tags and the DOCTYPE
/// reference to Evernote's DTD without ever fetching it (html5ever has no network I/O at all).
///
/// ponytail: only the common ENML tag set gets real Markdown treatment (div/p paragraphs, br,
/// b/strong, i/em, ul/ol/li, a[href], en-media, en-todo). Everything else (tables, nested oddities,
/// unknown tags) falls through to render_children — its own text content still flows through,
/// just unstyled — the same "fall back to visible text" ceiling web_reader.rs draws for a whole
/// page. Full-fidelity HTML→Markdown (tables, nested lists, arbitrary tags) is explicitly out of
/// scope for this slice.
fn enml_to_markdown(content: &str) -> String {
    let doc = Html::parse_document(content);
    let root_sel = Selector::parse("en-note").expect("static selector");
    let root = doc.select(&root_sel).next().unwrap_or_else(|| doc.root_element());
    let mut out = String::new();
    render_children(root, &mut out);
    normalize_markdown(&out)
}

// Note: these walk scraper::ElementRef (a public re-export) rather than the underlying
// ego_tree::NodeRef the tree is actually built from — ego_tree is only a *transitive* dependency
// here (pulled in by scraper, not listed in Cargo.toml directly) and this slice's brief is explicit
// about adding no new dependency, so its type name isn't nameable in a fn signature. Text-node
// children are handled inline via `Node::as_text()` instead of recursing into them, since text
// nodes are always leaves anyway.
fn render_children(parent: scraper::ElementRef, out: &mut String) {
    for child in parent.children() {
        if let Some(text) = child.value().as_text() {
            out.push_str(text);
        } else if let Some(el) = scraper::ElementRef::wrap(child) {
            render_node(el, out);
        }
    }
}

fn render_node(el: scraper::ElementRef, out: &mut String) {
    match el.value().name() {
        "div" | "p" => {
            render_children(el, out);
            out.push_str("\n\n");
        }
        "br" => out.push('\n'),
        "b" | "strong" => {
            out.push_str("**");
            render_children(el, out);
            out.push_str("**");
        }
        "i" | "em" => {
            out.push('*');
            render_children(el, out);
            out.push('*');
        }
        "ul" => {
            render_list(el, out, None);
            out.push_str("\n\n");
        }
        "ol" => {
            render_list(el, out, Some(1));
            out.push_str("\n\n");
        }
        "li" => {
            // Standalone <li> outside a list container we recognize — still emit a bullet
            // rather than silently dropping the marker.
            out.push_str("- ");
            render_children(el, out);
            out.push('\n');
        }
        "a" => {
            let href = el.value().attr("href").unwrap_or("");
            out.push('[');
            render_children(el, out);
            out.push_str("](");
            out.push_str(href);
            out.push(')');
        }
        "en-media" => {
            // Attachment reference by hash — resources are out of scope (see parse_note_chunk),
            // so render a plain-text placeholder rather than silently vanishing the reference.
            // render_children() afterwards is defensive: en-media is normally a self-closing/
            // empty tag, but html5ever's HTML parser — unlike an XML parser — does not honor
            // XML-style self-closing syntax on unknown/custom elements, so any content a
            // corrupted/unusual export nested after it would otherwise land as this element's
            // child and get silently dropped instead of rendered right after the placeholder.
            out.push_str("[attachment]");
            render_children(el, out);
        }
        "en-todo" => {
            // Checkbox marker. Same self-closing defensiveness as en-media above.
            let checked = el.value().attr("checked") == Some("true");
            out.push_str(if checked { "[x] " } else { "[ ] " });
            render_children(el, out);
        }
        // span/u and everything else unrecognized (tables, fonts, arbitrary future tags): no
        // useful Markdown syntax worth adding (u has no common Markdown equivalent) — just
        // recurse into children so the text itself is never lost, same plain-text fallback
        // web_reader.rs uses for a whole page.
        _ => render_children(el, out),
    }
}

fn render_list(parent: scraper::ElementRef, out: &mut String, mut ordinal: Option<u32>) {
    for child in parent.children() {
        if let Some(el) = scraper::ElementRef::wrap(child) {
            if el.value().name() == "li" {
                match &mut ordinal {
                    Some(n) => {
                        out.push_str(&format!("{n}. "));
                        *n += 1;
                    }
                    None => out.push_str("- "),
                }
                render_children(el, out);
                out.push('\n');
                continue;
            }
            render_node(el, out);
        } else if let Some(text) = child.value().as_text() {
            out.push_str(text);
        }
    }
}

/// Collapses runs of 3+ newlines (from stacked block-level `\n\n` pushes) down to a single blank
/// line, and trims the ends — keeps output tidy without trying to be a full Markdown formatter.
fn normalize_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0u32;
    for ch in s.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                out.push(ch);
            }
        } else {
            run = 0;
            out.push(ch);
        }
    }
    out.trim().to_string()
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

    fn write_enex(dir: &Path, name: &str, contents: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn note_xml(title: &str, content_enml: &str, created: &str, tags: &str) -> String {
        format!(
            r#"<note><title>{title}</title><content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>{content_enml}</en-note>]]></content><created>{created}</created>{tags}</note>"#
        )
    }

    #[test]
    fn multiple_notes_in_one_file_all_import() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let xml = format!(
            "<en-export>{}{}{}</en-export>",
            note_xml("First", "<div>Body one</div>", "20120814T183914Z", ""),
            note_xml("Second", "<div>Body two</div>", "20130101T000000Z", ""),
            note_xml("Third", "<div>Body three</div>", "20140202T000000Z", ""),
        );
        let path = write_enex(dir.path(), "multi.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 3);
        assert_eq!(result.skipped, 0);

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
        assert!(bodies.iter().any(|b| b.contains("Body one")));
        assert!(bodies.iter().any(|b| b.contains("Body two")));
        assert!(bodies.iter().any(|b| b.contains("Body three")));
    }

    #[test]
    fn title_tags_created_extracted() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let xml = format!(
            "<en-export>{}</en-export>",
            note_xml(
                "Sejong the Great",
                "<div>King Sejong.</div>",
                "20120814T183914Z",
                "<tag>history</tag><tag>korea</tag>"
            )
        );
        let path = write_enex(dir.path(), "one.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 1);
        let note = crate::repo::notes::note_summary(&conn, &result.note_ids[0]).unwrap();
        assert_eq!(note.title, "Sejong the Great");
        assert_eq!(note.created_at, "2012-08-14T18:39:14.000Z");
        // updated_at is written from the same resolved timestamp commit_staged passes in — a
        // single original-instant value seeds both columns (same contract as markdown.rs/notion.rs).
        assert_eq!(note.updated_at, "2012-08-14T18:39:14.000Z");
        let mut tags = crate::repo::notes::tag_names(&conn, &result.note_ids[0]).unwrap();
        tags.sort();
        assert_eq!(tags, vec!["history".to_string(), "korea".to_string()]);
    }

    #[test]
    fn created_wins_over_updated_when_both_present() {
        // The common real-world shape: both <created> and <updated> present. <created> must win —
        // this is the case a Field-flag bug (e.g. Updated silently overwriting Created) would show
        // that the "missing created" fallback test alone doesn't exercise.
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let xml = format!(
            r#"<en-export><note><title>Both Timestamps</title><content><![CDATA[<en-note><div>b</div></en-note>]]></content><created>20120814T183914Z</created><updated>20190101T000000Z</updated></note></en-export>"#
        );
        let path = write_enex(dir.path(), "both.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 1);
        let note = crate::repo::notes::note_summary(&conn, &result.note_ids[0]).unwrap();
        assert_eq!(note.created_at, "2012-08-14T18:39:14.000Z", "created must win over updated");
    }

    #[test]
    fn enml_common_tags_convert_to_sensible_markdown() {
        let content = "<div>Intro <b>bold</b> and <i>italic</i>.</div>\
            <div>Second paragraph with <a href=\"https://example.com\">a link</a>.</div>\
            <ul><li>First item</li><li>Second item</li></ul>";
        let md = enml_to_markdown(content);
        assert!(md.contains("**bold**"));
        assert!(md.contains("*italic*"));
        assert!(md.contains("[a link](https://example.com)"));
        assert!(md.contains("- First item"));
        assert!(md.contains("- Second item"));
        // paragraphs land as blank-line-separated blocks, not run together.
        assert!(md.contains("Intro"));
        assert!(md.contains("Second paragraph"));
        let intro_pos = md.find("Intro").unwrap();
        let second_pos = md.find("Second paragraph").unwrap();
        assert!(md[intro_pos..second_pos].contains("\n\n"));
    }

    #[test]
    fn en_todo_checkbox_and_self_closing_text_is_not_swallowed() {
        // en-todo is normally self-closing XML syntax (<en-todo checked="false"/>Buy milk) —
        // html5ever's HTML parser doesn't honor XML self-closing on unknown tags, so this
        // exercises that the following text still survives either interpretation of the tree.
        let content = "<div><en-todo checked=\"false\"/>Buy milk</div><div><en-todo checked=\"true\"/>Done thing</div>";
        let md = enml_to_markdown(content);
        assert!(md.contains("[ ] Buy milk"));
        assert!(md.contains("[x] Done thing"));
    }

    #[test]
    fn en_media_becomes_placeholder_not_missing_note() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let xml = format!(
            "<en-export>{}</en-export>",
            note_xml(
                "Has Attachment",
                "<div>Photo below:</div><div><en-media hash=\"abc123\" type=\"image/png\"/></div>",
                "20120814T183914Z",
                ""
            )
        );
        let path = write_enex(dir.path(), "media.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 1, "note still imports without its attachment");
        assert_eq!(result.skipped, 0);
        let detail = crate::repo::notes::note_detail(&conn, &result.note_ids[0]).unwrap();
        assert!(detail.sections[0].body_md.contains("Photo below"));
        assert!(detail.sections[0].body_md.contains("[attachment]"));
    }

    #[test]
    fn resource_present_is_not_counted_in_skipped() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let xml = format!(
            r#"<en-export><note><title>With Resource</title><content><![CDATA[<en-note><div>Body text here</div></en-note>]]></content><created>20120814T183914Z</created><resource><data encoding="base64">aGVsbG8=</data><mime>image/png</mime></resource></note></en-export>"#
        );
        let path = write_enex(dir.path(), "res.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 0, "the resource itself is not a failure — not counted");
        let detail = crate::repo::notes::note_detail(&conn, &result.note_ids[0]).unwrap();
        assert!(detail.sections[0].body_md.contains("Body text here"));
        // the resource's own <data>/<mime> text must never leak into the note body/title.
        assert!(!detail.sections[0].body_md.contains("aGVsbG8"));
    }

    #[test]
    fn missing_created_falls_back_to_updated_then_import_time() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        // note 1: no <created>, has <updated> — must fall back to it.
        // note 2: neither <created> nor <updated> — must fall back to import time (~now).
        let xml = format!(
            r#"<en-export>
                <note><title>No Created</title><content><![CDATA[<en-note><div>b</div></en-note>]]></content><updated>20150606T120000Z</updated></note>
                <note><title>No Timestamps At All</title><content><![CDATA[<en-note><div>b</div></en-note>]]></content></note>
            </en-export>"#
        );
        let path = write_enex(dir.path(), "fallback.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 2);
        let notes: Vec<_> = result
            .note_ids
            .iter()
            .map(|id| crate::repo::notes::note_summary(&conn, id).unwrap())
            .collect();
        let no_created = notes.iter().find(|n| n.title == "No Created").unwrap();
        assert_eq!(no_created.created_at, "2015-06-06T12:00:00.000Z");

        let no_timestamps = notes.iter().find(|n| n.title == "No Timestamps At All").unwrap();
        let parsed = chrono::DateTime::parse_from_rfc3339(&no_timestamps.created_at)
            .expect("import-time fallback must be a valid RFC3339 instant");
        let age = chrono::Utc::now().signed_duration_since(parsed);
        assert!(age.num_minutes() < 5, "import-time fallback should be ~now");
    }

    #[test]
    fn one_malformed_note_is_skipped_others_still_import() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        // The middle note has an unclosed <title> tag — malformed *inside* an otherwise
        // well-formed top-level document. Must be skipped, not abort the batch.
        let xml = format!(
            "<en-export>{}<note><title>Bad Note</note>{}</en-export>",
            note_xml("Good 1", "<div>b1</div>", "20120814T183914Z", ""),
            note_xml("Good 2", "<div>b2</div>", "20130101T000000Z", ""),
        );
        let path = write_enex(dir.path(), "onebad.enex", &xml);

        let result = import_enex_file(&mut conn, &folder_id, &path).unwrap();
        assert_eq!(result.imported, 2, "Good 1 and Good 2 still import");
        assert_eq!(result.skipped, 1, "the malformed middle note is skipped, not aborting");
    }

    #[test]
    fn embedded_literal_close_note_tag_in_body_errors_instead_of_silently_dropping_notes() {
        // A note's own CDATA body containing a literal, balanced "<note>fake</note>" (e.g. a note
        // ABOUT the ENEX format itself, quoting an example) makes the raw substring scan slice the
        // chunk boundary too early — the exact ceiling named in split_notes' ponytail comment.
        // Before the chunks.len()-vs-open_count reconciliation, this could silently drop "Good 1"
        // entirely while still returning Ok (a corrupted/partial slice counted as a normal
        // per-note parse failure, indistinguishable from an intentional skip). It must now surface
        // as a whole-file VALIDATION error instead of a quietly-wrong partial import.
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let xml = format!(
            "<en-export>{}{}</en-export>",
            note_xml(
                "Good 1",
                "<div>Body one with literal text: <note>fake</note> embedded</div>",
                "20120814T183914Z",
                ""
            ),
            note_xml("Good 2", "<div>Body two</div>", "20130101T000000Z", ""),
        );
        let path = write_enex(dir.path(), "embedded.enex", &xml);

        let err = import_enex_file(&mut conn, &folder_id, &path).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "must reject the whole file rather than silently importing a subset of its notes"
        );
    }

    #[test]
    fn fully_malformed_top_level_xml_is_a_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = write_enex(dir.path(), "garbage.enex", "this is not xml or an enex file at all");

        let err = import_enex_file(&mut conn, &folder_id, &path).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn truncated_note_tags_is_a_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        // an open <note> tag with no matching closing tag anywhere — truncated export.
        let path = write_enex(
            dir.path(),
            "truncated.enex",
            "<en-export><note><title>Cut off mid",
        );

        let err = import_enex_file(&mut conn, &folder_id, &path).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn unknown_folder_id_is_not_found() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();
        let path = write_enex(dir.path(), "any.enex", "<en-export><note></note></en-export>");
        let err = import_enex_file(&mut conn, "no-such-folder", &path).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn missing_enex_path_is_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ghost = std::env::temp_dir().join("does-not-exist-brise-enex-test.enex");
        let err = import_enex_file(&mut conn, &folder_id, &ghost).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn enex_file_exceeding_max_size_is_validation_error() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.enex");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_SINGLE_FILE_BYTES + 1).unwrap();

        let err = import_enex_file(&mut conn, &folder_id, &path).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
