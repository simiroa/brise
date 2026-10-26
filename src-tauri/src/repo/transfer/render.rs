use crate::models::{Attachment, NoteDetail, Section};
use std::collections::{HashMap, HashSet};

/// export 본문에 넣을 섹션 텍스트 — sheet 섹션은 JSON 이 아니라 마크다운 표로 나간다
/// (specs/features/sheet.md: "마크다운 export 는 표(전체)"). 파싱 실패 시 raw body 폴백.
fn section_body(s: &Section) -> String {
    if s.kind == crate::repo::sheet::KIND {
        if let Some(table) = crate::repo::sheet::sheet_to_markdown_table(&s.body_md) {
            return table;
        }
    }
    s.body_md.clone()
}

/// 마크다운이 파일 첨부를 가리킬 곳 — **쓰는 쪽(export.rs `write_note_md`)이 정해서 넘긴다**: 실제로 만든 첨부 폴더 이름
/// (`{고른 파일 stem}_files`)과 실제로 복사한 첨부(id → 그 폴더 안 파일 이름). 예전엔 렌더러가 `slugify(title)` 로 폴더 이름을
/// 따로 계산해서, 저장 대화상자가 고른 파일 이름으로 쓰는 순간(W6) 링크가 다른 폴더를 가리켰다.
pub(crate) struct AttachmentLinks<'a> {
    pub dir: &'a str,
    pub names: &'a HashMap<String, String>,
}

/// Human-facing note export (Markdown). `footnote_bodies` is `(attachment_id, body_text)` for
/// `kind='footnote'` rows the caller already loaded from disk. Empty slice → no GFM rewrite
/// beyond stripping unknown islands to plain text when spans exist without matching bodies.
/// `files` 에 없는 파일 첨부(원본이 없어 복사하지 못한 것)는 링크 없이 이름만 적는다 — 없는 파일을 가리키는 링크를 만들지 않는다.
pub(crate) fn render_md(
    detail: &NoteDetail,
    now: &str,
    footnote_bodies: &[(String, String)],
    files: &AttachmentLinks,
) -> String {
    let n = &detail.note;
    let tags = n
        .tag_names
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("title: \"{}\"\n", n.title.replace('"', "\\\"")));
    out.push_str(&format!("year: {}\n", n.year));
    out.push_str(&format!("tags: [{tags}]\n"));
    out.push_str(&format!("exported: {now}\n"));
    out.push_str("---\n\n");

    // Join section bodies first so footnote numbering is document-order across sections and
    // definitions land once at the end of the body (before Sources/Attachments).
    let mut body = String::new();
    for (i, s) in detail.sections.iter().enumerate() {
        if i > 0 {
            body.push_str(&format!("## {}\n\n", s.name));
        }
        let text = section_body(s);
        body.push_str(&text);
        if !text.ends_with('\n') {
            body.push('\n');
        }
        body.push('\n');
    }
    out.push_str(&apply_footnotes_to_markdown(&body, footnote_bodies));

    if !detail.sources.is_empty() {
        out.push_str("## Sources (Original Text)\n\n");
        for src in &detail.sources {
            out.push_str(&format!("### {}\n\n", src.name));
            out.push_str("```\n");
            out.push_str(&src.body);
            if !src.body.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("```\n\n");
        }
    }
    if !detail.attachments.is_empty() {
        let mut att_body = String::new();
        for att in &detail.attachments {
            // Footnotes become GFM defs in the body — do not also list them as file links.
            if att.kind == "footnote" {
                continue;
            }
            match attachment_target(att, files) {
                Some(AttachmentTarget::File(link)) if att.kind == "image" => {
                    att_body.push_str(&format!("- ![{}]({})\n", att.name, link));
                }
                Some(AttachmentTarget::File(link)) => {
                    att_body.push_str(&format!("- [{}]({})\n", att.name, link));
                }
                Some(AttachmentTarget::Url(url)) => {
                    att_body.push_str(&format!("- [{}]({})\n", att.name, url));
                }
                Some(AttachmentTarget::NameOnly(name)) => {
                    att_body.push_str(&format!("- {name}\n"));
                }
                None => {}
            }
        }
        if !att_body.is_empty() {
            out.push_str("## Attachments\n\n");
            out.push_str(&att_body);
            out.push('\n');
        }
    }
    out
}

/// Port of `src/lib/exportFootnotes.ts::applyFootnotesToMarkdown` — keep rules in sync.
/// Numbering = document order of first `data-footnote` id; same id reuses `n`.
pub(crate) fn apply_footnotes_to_markdown(
    body_md: &str,
    footnotes: &[(String, String)],
) -> String {
    // Fast path: no anchors → byte-identical (even if footnotes is non-empty).
    if !body_md.contains("data-footnote") {
        return body_md.to_string();
    }

    let mut text_by_id: HashMap<&str, &str> = HashMap::new();
    for (id, text) in footnotes {
        if id.is_empty() {
            continue;
        }
        if text.trim().is_empty() {
            continue;
        }
        text_by_id.insert(id.as_str(), text.as_str());
    }

    let mut id_to_num: HashMap<String, usize> = HashMap::new();
    let mut ordered_defs: Vec<(usize, String)> = Vec::new();
    let mut next = 1usize;

    let mut rewritten = String::with_capacity(body_md.len());
    let mut rest = body_md;
    // Match <span ... data-footnote="id" ...>inner</span> (single-quoted attr too).
    while let Some(span_start) = find_footnote_span_start(rest) {
        rewritten.push_str(&rest[..span_start]);
        let after_start = &rest[span_start..];
        if let Some((full_len, id_raw, inner)) = parse_footnote_span(after_start) {
            let id = decode_html_attr(&id_raw);
            if let Some(text) = text_by_id.get(id.as_str()) {
                let n = match id_to_num.get(&id) {
                    Some(&n) => n,
                    None => {
                        let n = next;
                        next += 1;
                        id_to_num.insert(id.clone(), n);
                        ordered_defs.push((n, (*text).to_string()));
                        n
                    }
                };
                rewritten.push_str(&format!("{inner}[^{n}]"));
            } else {
                // Unknown / empty body: keep readable text, no orphan [^n].
                rewritten.push_str(&inner);
            }
            rest = &after_start[full_len..];
        } else {
            // Malformed candidate: emit one char and continue (avoid infinite loop).
            let ch = after_start.chars().next().unwrap_or('<');
            rewritten.push(ch);
            rest = &after_start[ch.len_utf8()..];
        }
    }
    rewritten.push_str(rest);

    if ordered_defs.is_empty() {
        return rewritten;
    }

    append_definitions(&rewritten, &ordered_defs)
}

fn find_footnote_span_start(s: &str) -> Option<usize> {
    // Wire format always uses lowercase "span" / "data-footnote".
    let mut from = 0;
    while let Some(rel) = s[from..].find("<span") {
        let i = from + rel;
        let tail = &s[i..];
        if let Some(gt) = tail.find('>') {
            let open = &tail[..=gt];
            if open.contains("data-footnote=") {
                return Some(i);
            }
        }
        from = i + 5;
    }
    None
}

/// Parse one footnote island starting at `"<span..."`. Returns (byte_len, id, inner).
fn parse_footnote_span(s: &str) -> Option<(usize, String, String)> {
    if !s.starts_with("<span") {
        return None;
    }
    let gt = s.find('>')?;
    let open = &s[..=gt];
    if !open.contains("data-footnote=") {
        return None;
    }
    let id = extract_data_footnote_attr(open)?;
    let after_open = &s[gt + 1..];
    // Non-greedy to first </span> (wire format has no nested spans).
    let close_rel = after_open.to_ascii_lowercase().find("</span>")?;
    let inner = after_open[..close_rel].to_string();
    let full_len = gt + 1 + close_rel + "</span>".len();
    Some((full_len, id, inner))
}

fn extract_data_footnote_attr(open_tag: &str) -> Option<String> {
    const KEY: &str = "data-footnote=";
    let idx = open_tag.find(KEY)?;
    let after = &open_tag[idx + KEY.len()..];
    let mut chars = after.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = chars.as_str();
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

fn decode_html_attr(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn format_definition(n: usize, text: &str) -> String {
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end_matches('\n')
        .to_string();
    let mut lines = normalized.split('\n');
    let first = lines.next().unwrap_or("");
    let mut out = format!("[^{n}]: {first}");
    for line in lines {
        out.push('\n');
        if line.is_empty() {
            // blank continuation line
        } else {
            out.push_str("    ");
            out.push_str(line);
        }
    }
    out
}

fn append_definitions(body: &str, defs: &[(usize, String)]) -> String {
    if defs.is_empty() {
        return body.to_string();
    }
    let mut out = body.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.ends_with("\n\n") {
        out.push('\n');
    }
    for (i, (n, text)) in defs.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format_definition(*n, text));
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Where an attachment entry in the exported document body should point.
enum AttachmentTarget {
    /// A file that `write_note_md` copied into the attachment folder — link is the relative path.
    File(String),
    /// A `link`-kind attachment: an external URL, not a local file.
    Url(String),
    /// Nothing to link to — an `internal`-kind attachment (note-to-note link), or a file attachment whose source was missing
    /// so nothing was copied. Listed by name only.
    NameOnly(String),
}

/// Resolve one attachment to the link/embed target the exported doc should use:
/// - `rel_path.is_some()` attachments (image/doc/audio/note/footnote) point at the name `write_note_md` actually copied them
///   under (`files.names`, decided once by `attachment_file_names`) — or are listed by name if nothing was copied.
/// - `footnote` has both rel_path (.md body) and optional url (anchor_text display hint only).
///   `rel_path.is_some()` wins first — never treat footnote url as a navigable link.
/// - `link`-kind attachments have no local file (`rel_path` is None) and point at `url` instead.
/// - `internal`-kind attachments (`url` holds a target *note id*, not a real URL, per
///   `repo/attachments.rs::add_internal`) have nothing exportable to link to — list by name only.
fn attachment_target(att: &Attachment, files: &AttachmentLinks) -> Option<AttachmentTarget> {
    // Footnote (and note/image/doc/audio): file on disk → File target. Checked before kind
    // branches so a footnote's url=anchor_text is never mistaken for a link URL.
    if att.rel_path.is_some() {
        return Some(match files.names.get(&att.id) {
            Some(name) => AttachmentTarget::File(format!("{}/{name}", files.dir)),
            None => AttachmentTarget::NameOnly(att.name.clone()),
        });
    }
    if att.kind == "link" {
        return att.url.clone().map(AttachmentTarget::Url);
    }
    if att.kind == "internal" {
        return Some(AttachmentTarget::NameOnly(att.name.clone()));
    }
    None
}

/// 파일 첨부(`rel_path` 있는 것 — 각주 포함)마다 첨부 폴더 안에서 쓸 파일 이름을 **한 번** 정한다: `safe_attachment_basename`
/// 으로 정리한 뒤 같은 이름은 목록 순서대로 ` (2)`·` (3)` 을 붙인다. 복사(export.rs `write_note_md`)와 링크(`render_md`)가 이 한
/// 목록을 같이 쓴다 — 예전엔 복사는 디스크에 이미 있는 파일과, 링크는 빈 집합과 따로 비교해서 같은 파일로 다시 내보내면
/// (첨부 폴더가 이미 있음) 복사본에만 ` (2)` 가 붙고 링크는 옛 파일을 가리켰다. 이름이 디스크 상태와 무관하므로 다시 내보내기는
/// 같은 이름을 덮어쓴다.
pub(crate) fn attachment_file_names(attachments: &[Attachment]) -> Vec<(&Attachment, String)> {
    let mut seen: HashSet<String> = HashSet::new();
    attachments
        .iter()
        .filter(|a| a.rel_path.is_some())
        .map(|a| {
            let name = unique_among(&mut seen, &safe_attachment_basename(&a.name));
            (a, name)
        })
        .collect()
}

/// Reduce an attachment's stored display `name` to a safe on-disk *basename*. `att.name` is
/// attacker-influenceable: `import_bundle` inserts it verbatim from an external JSON bundle without
/// validation, and `Path::join` lets an absolute path or a `..` component escape the target dir —
/// i.e. a peer could craft a bundle that writes to any path when the victim merely *exports* the
/// imported note. We keep only the final path component (splitting on BOTH `/` and `\` regardless of
/// host OS) and reject traversal/empty names. Shared by export.rs (the on-disk copy) and this file
/// (the link target) so the two can never drift out of sync.
///
/// 구분자(`/` `\`)를 자른 **뒤에도** 두 가지가 남는다. ① `:` — 구분자가 아니어서 위 분리를 통과하지만
/// `dir.join("C:x.png")` 는 드라이브 접두사가 붙은 상대 경로라 **기준 폴더를 통째로 대체한다**(스테이징 폴더를 벗어나
/// 현재 작업 폴더의 파일을 덮어쓴다). `hwpx_import` 가 신뢰할 수 없는 zip 엔트리 이름을 처음으로 여기에 흘려보냈고,
/// 내보내기 묶음의 첨부 이름도 같은 입구다. ② `* ? " < > |`·제어 문자 — Windows 에서 파일 생성이 실패해, 첨부 한 장의 이름이
/// 문서 전체 가져오기를 죽인다. 둘 다 `is_fs_unsafe_char` 한 곳에서 `-` 로 바꾼다(저장 이름 규칙
/// `normalize_stored_name` 이 이 글자들을 원래 `-` 로 바꾸므로 같은 글자로 맞춰 저장 이름이 그대로다). 길이는 120바이트로
/// 자르되 확장자를 지키고, 예약어 검사는 자른 뒤 마지막에 한다.
pub(crate) fn safe_attachment_basename(name: &str) -> String {
    let last = name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
    let cleaned: String = last.chars().map(|c| if is_fs_unsafe_char(c) { '-' } else { c }).collect();
    // 결합 trim: `.trim().trim_matches('.')` 는 "report.txt ." 같은 끼인 경우 후행 공백을 남겨
    // 온디스크 파일명(Windows 가 조용히 제거)과 링크 대상이 어긋난다. 공백+점을 한 번에 벗긴다.
    let base = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if base.is_empty() || base == ".." {
        return "attachment".to_string();
    }
    let base = clamp_name_len(base);
    // Windows 예약 장치명(CON/NUL/COM1…): stem 이 예약어면 파일 생성이 실패하거나 장치로 열린다.
    // slugify 와 동일하게 확장자 앞 stem 을 대소문자 무시 비교해 접미사로 무력화한다.
    let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(&base);
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return format!("{base}_");
    }
    base
}

/// 파일 이름에 쓸 수 없는 글자 — 경로 구분자·`:`(드라이브 접두사)·Windows 금지 문자·제어 문자. `slugify` 와 같은 표.
fn is_fs_unsafe_char(c: char) -> bool {
    matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20
}

/// 첨부 이름 상한(바이트). 저장 경로에 short-id 접두사와 노트 폴더가 붙으므로 Windows 의 260자 경로 한도에 여유를 둔다.
const MAX_ATTACHMENT_NAME_BYTES: usize = 120;

/// 너무 긴 이름은 stem 을 잘라 맞춘다 — 확장자(짧은 것만)는 지켜 kind 판정이 그대로다.
fn clamp_name_len(base: &str) -> String {
    if base.len() <= MAX_ATTACHMENT_NAME_BYTES {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 16 => (s, Some(e)),
        _ => (base, None),
    };
    let room = MAX_ATTACHMENT_NAME_BYTES - ext.map_or(0, |e| e.len() + 1);
    let cut = truncate_bytes(stem, room);
    let cut = cut.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let cut = if cut.is_empty() { "attachment" } else { cut };
    match ext {
        Some(e) => format!("{cut}.{e}"),
        None => cut.to_string(),
    }
}

/// `"{stem} (n).{ext}"` 로 이름을 가른다 — 이미 쓴 이름은 디스크가 아니라 `seen` 으로 본다(`attachment_file_names`).
/// Windows 파일 시스템은 대소문자를 가리지 않으므로(`Photo.png` 와 `photo.png` 는 같은 파일) 비교도 대소문자 무시다.
fn unique_among(seen: &mut HashSet<String>, filename: &str) -> String {
    if seen.insert(filename.to_lowercase()) {
        return filename.to_string();
    }
    let (stem, dot_ext) = match filename.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (filename.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let cand = format!("{stem} ({n}){dot_ext}");
        if seen.insert(cand.to_lowercase()) {
            return cand;
        }
        n += 1;
    }
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub(crate) fn slugify(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| if is_fs_unsafe_char(c) { '_' } else { c })
        .collect();
    s = s.trim().trim_matches('.').trim().to_string();
    if s.is_empty() {
        s = "note".to_string();
    }
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&s)) {
        s.push('_');
    }
    truncate_bytes(&s, 120)
}

fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut out = String::new();
    for c in s.chars() {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out
}

pub(crate) fn unique_filename(dir: &std::path::Path, base: &str, ext: &str) -> String {
    let first = format!("{base}.{ext}");
    if !dir.join(&first).exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let cand = format!("{base} ({n}).{ext}");
        if !dir.join(&cand).exists() {
            return cand;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NoteSummary, Section};

    fn detail_with(attachments: Vec<Attachment>) -> NoteDetail {
        NoteDetail {
            note: NoteSummary {
                id: "n1".to_string(),
                folder_id: "f1".to_string(),
                title: "My Note".to_string(),
                year: 1900,
                is_favorite: false,
                content_locked: false,
                exported_at: None,
                has_image: false,
                tag_names: vec![],
                region: None,
                region_names: vec![],
                status: None,
                icon: None,
                lat: None,
                lng: None,
                created_at: "2024-01-01T00:00:00.000Z".to_string(),
                updated_at: "2024-01-01T00:00:00.000Z".to_string(),
                month: None,
                day: None,
                end_year: None,
                end_month: None,
                end_day: None,
                remind: false,
                start_time: None,
                end_time: None,
                remind_offset_min: None,
                rrule: None,
                snippet: None,
            },
            sections: vec![Section {
                id: "s1".to_string(),
                name: "Body".to_string(),
                body_md: "hello".to_string(),
                position: 0,
                kind: "text".to_string(),
                ai_origin: None,
                updated_at: None,
            }],
            sources: vec![],
            attachments,
        }
    }

    fn att(name: &str, kind: &str, rel_path: Option<&str>, url: Option<&str>) -> Attachment {
        Attachment {
            id: format!("a-{name}"),
            name: name.to_string(),
            kind: kind.to_string(),
            rel_path: rel_path.map(|s| s.to_string()),
            ext_path: None,
            url: url.map(|s| s.to_string()),
            size_bytes: None,
            position: 0,
            transcript: None,
            transcript_inserted: false,
        }
    }

    /// 쓰는 쪽(`write_note_md`)과 같은 방식으로 링크를 만든다 — 파일 첨부가 전부 복사됐다고 본다.
    fn md(detail: &NoteDetail, bodies: &[(String, String)]) -> String {
        let names: HashMap<String, String> =
            attachment_file_names(&detail.attachments).into_iter().map(|(a, n)| (a.id.clone(), n)).collect();
        render_md(detail, "2026-07-21T00:00:00Z", bodies, &AttachmentLinks { dir: "My Note_files", names: &names })
    }

    #[test]
    fn render_md_lists_attachments_under_relative_slug_files_links() {
        let detail = detail_with(vec![
            att("photo.png", "image", Some("ab/cd/photo.png"), None),
            att("notes.pdf", "doc", Some("ef/gh/notes.pdf"), None),
        ]);
        let md = md(&detail, &[]);
        assert!(md.contains("## Attachments\n"));
        // Image kind embeds; other kinds link. Both point at <쓰는 쪽이 넘긴 폴더>/<sanitized name>.
        assert!(md.contains("![photo.png](My Note_files/photo.png)"));
        assert!(md.contains("[notes.pdf](My Note_files/notes.pdf)"));
    }

    #[test]
    fn render_md_omits_attachments_section_when_none() {
        let detail = detail_with(vec![]);
        let md = md(&detail, &[]);
        assert!(!md.contains("Attachments"));
    }

    #[test]
    fn render_md_handles_link_and_internal_kinds() {
        let detail = detail_with(vec![
            att("Some Site", "link", None, Some("https://example.com/x")),
            att("Related Note", "internal", None, Some("n2")),
        ]);
        let md = md(&detail, &[]);
        // link kind points at its URL, not a _files path.
        assert!(md.contains("[Some Site](https://example.com/x)"));
        // internal kind (url holds a note id, not a real link) is listed by name only, with no
        // broken _files link and no leaked "note id as URL".
        assert!(md.contains("- Related Note\n"));
        assert!(!md.contains("(n2)"));
        assert!(!md.contains("[Related Note]"));
    }

    #[test]
    fn render_md_footnote_becomes_gfm_not_file_or_link() {
        // footnote: body_md carries <span data-footnote=id>; attachment url is anchor_text only.
        // Export rewrites to GFM [^n] + def; does not list under Attachments; never treats url as href.
        let mut detail = detail_with(vec![Attachment {
            id: "abc-123".to_string(),
            name: "selected word".to_string(),
            kind: "footnote".to_string(),
            rel_path: Some("note1/abc-selected_word.md".to_string()),
            ext_path: None,
            url: Some("selected word".to_string()),
            size_bytes: None,
            position: 0,
            transcript: None,
            transcript_inserted: false,
        }]);
        detail.sections[0].body_md =
            "say <span data-footnote=\"abc-123\">hello</span> there".to_string();
        let bodies = vec![("abc-123".to_string(), "각주 본문".to_string())];
        let md = md(&detail, &bodies);
        assert!(md.contains("hello[^1]"));
        assert!(md.contains("[^1]: 각주 본문"));
        assert!(!md.contains("## Attachments"));
        assert!(!md.contains("My Note_files/"));
        // Must not produce a bare URL-style target from the anchor_text column.
        assert!(!md.contains("(selected word)"));
    }

    #[test]
    fn render_md_no_footnote_spans_byte_identical_body() {
        let detail = detail_with(vec![]);
        let md = md(&detail, &[]);
        // Section body "hello" preserved under frontmatter — no footnote noise.
        assert!(md.contains("hello\n"));
        assert!(!md.contains("[^"));
    }

    #[test]
    fn apply_footnotes_document_order_and_reuse() {
        let body = "a <span data-footnote=\"id-b\">B</span> c <span data-footnote=\"id-a\">A</span> d <span data-footnote=\"id-b\">B2</span>";
        let footnotes = [
            ("id-a".to_string(), "alpha".to_string()),
            ("id-b".to_string(), "beta".to_string()),
        ];
        let out = apply_footnotes_to_markdown(body, &footnotes);
        assert!(out.contains("B[^1]"));
        assert!(out.contains("A[^2]"));
        assert!(out.contains("B2[^1]"));
        assert!(out.contains("[^1]: beta"));
        assert!(out.contains("[^2]: alpha"));
    }

    #[test]
    fn render_md_disambiguates_colliding_basenames_like_export_does() {
        // Two attachments sanitize to the same basename ("photo.png") because their display
        // names collide even though their source rel_paths differ — `attachment_file_names` gives the
        // second "photo (2).png", and the writer copies under exactly that name, so the link isn't dangling.
        // 링크 이름표는 첨부 id 로 찾는다 — 실제 id 는 서로 다르다(`att` 도우미는 이름에서 id 를 만들므로 둘째를 바꾼다).
        let mut second = att("photo.png", "image", Some("cd/photo.png"), None);
        second.id = "a-photo-2".to_string();
        let detail = detail_with(vec![att("photo.png", "image", Some("ab/photo.png"), None), second]);
        let md = md(&detail, &[]);
        assert!(md.contains("![photo.png](My Note_files/photo.png)"));
        assert!(md.contains("![photo.png](My Note_files/photo (2).png)"));
    }

    /// 링크 폴더 이름은 렌더러가 제목으로 계산하지 않고 쓰는 쪽이 넘긴 그대로다(W6 — 고른 파일 `x.md` 옆 `x_files`).
    /// 복사하지 못한 첨부(names 에 없음)는 없는 파일을 가리키지 않게 이름만 적는다.
    #[test]
    fn render_md_links_into_the_folder_the_writer_chose_and_lists_uncopied_files_by_name() {
        let detail = detail_with(vec![
            att("photo.png", "image", Some("ab/photo.png"), None),
            att("gone.pdf", "doc", Some("ab/gone.pdf"), None),
        ]);
        let names: HashMap<String, String> = [("a-photo.png".to_string(), "photo.png".to_string())].into_iter().collect();
        let md = render_md(&detail, "t", &[], &AttachmentLinks { dir: "x_files", names: &names });
        assert!(md.contains("- ![photo.png](x_files/photo.png)
"), "{md}");
        assert!(md.contains("- gone.pdf
"), "{md}");
        assert!(!md.contains("My Note_files") && !md.contains("gone.pdf]("), "{md}");
    }

    /// 이름은 목록 순서대로 한 번 정한다 — 각주(파일 첨부)도 같은 폴더에 들어가므로 같이 센다, 대소문자만 다른 이름도 같은 파일이다.
    #[test]
    fn attachment_file_names_dedupes_in_list_order_case_insensitively_including_footnotes() {
        let atts = vec![
            att("Photo.png", "image", Some("a/1.png"), None),
            att("photo.png", "image", Some("a/2.png"), None),
            att("site", "link", None, Some("https://x")),
            att("photo.png", "footnote", Some("a/3.md"), Some("anchor")),
            att("../../evil.png", "image", Some("a/4.png"), None),
        ];
        let names: Vec<String> = attachment_file_names(&atts).into_iter().map(|(_, n)| n).collect();
        assert_eq!(names, vec!["Photo.png", "photo (2).png", "photo (3).png", "evil.png"]);
    }
}
