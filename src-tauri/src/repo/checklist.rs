// repo: checklist — mobile web client feed cards (GET /api/v1/notes excerpt+checklist,
// POST /api/v1/notes/{id}/checklist toggle). Pure string helpers over section body_md, no HTML
// parser: the exact markup tiptap's TaskList/TaskItem extensions emit is fixed and tested
// (src/lib/mdSerialize.test.ts) —
//   <li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>text</p></div></li>
//   <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>text</p></div></li>
// A full HTML parse+reserialize (scraper) risks reformatting bytes the frontend didn't ask us to
// touch (attribute order, self-closing style, whitespace) — surgical string splicing on the one
// fixed marker pair (`data-checked="..."` + `<input type="checkbox" ...>`) keeps everything else
// byte-identical, which matters because this string round-trips straight back through
// repo::sections::update into the same body_md column the desktop editor reads.
use std::borrow::Cow;

const LI_OPEN: &str = "<li data-type=\"taskItem\" data-checked=\"";
const INPUT_MARKER: &str = "<input type=\"checkbox\"";

/// 이 태그를 지나면 글자가 이어붙으면 안 되는 블록·줄 경계인가(`name` 은 `<` 와 `>` 사이 글자 — 여는/닫는 둘 다).
/// 표 조각(`<td><p>성명</p></td><td><p>정보</p></td>`)을 태그만 떼면 "성명정보" 로 붙어 피드 발췌가 읽을 수 없게
/// 된다(W0 검증). 인라인 태그(`strong`·`em`·`span`…)는 단어 한가운데에 있을 수 있어 공백을 넣지 않는다.
fn is_block_boundary_tag(name: &str) -> bool {
    let name = name.trim_start_matches('/');
    let end = name
        .find(|c: char| c.is_ascii_whitespace() || c == '/')
        .unwrap_or(name.len());
    let tag = &name[..end];
    matches!(
        tag.to_ascii_lowercase().as_str(),
        "p" | "div"
            | "br"
            | "li"
            | "ul"
            | "ol"
            | "td"
            | "th"
            | "tr"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
            | "caption"
            | "blockquote"
            | "pre"
            | "details"
            | "summary"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    )
}

/// Strip HTML tags + a handful of common entities, collapse whitespace, cap to `max_chars`
/// (char-counted, not bytes). Shared by the excerpt (first section body_md, 160 chars) and
/// checklist item text (first `<p>...</p>` of a task item, 60 chars) — same shape of problem,
/// one function. 블록·줄 경계 태그는 공백으로 바꾼다(is_block_boundary_tag) — 아니면 표 셀·문단이 붙는다.
pub fn strip_tags_and_collapse(html: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                if in_tag && is_block_boundary_tag(&tag) {
                    out.push(' ');
                }
                in_tag = false;
            }
            _ if !in_tag => out.push(c),
            // 태그 이름만 필요하다 — 속성이 긴 태그(`<table style="…">`)로 버퍼가 불어나지 않게 자른다.
            _ if tag.len() < 16 => tag.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max_chars).collect()
}

/// `<table` / `</table` 로 시작하고 바로 뒤가 공백·`/`·`>` 인 태그인가(대소문자 무시) — `<tablet` 같은 다른 태그는 아니다.
fn table_tag_at(bytes: &[u8], i: usize, closing: bool) -> bool {
    let name: &[u8] = if closing { b"</table" } else { b"<table" };
    let end = i + name.len();
    bytes.len() > end
        && bytes[i..end].eq_ignore_ascii_case(name)
        && matches!(bytes[end], b' ' | b'\t' | b'\r' | b'\n' | 0x0c | b'/' | b'>')
}

/// `<table …>…</table>` HTML 조각(병합·셀 배경·셀 안 여러 블록이 있는 표 — 프런트 tableColwidth.ts)을 **같은 바이트
/// 길이의 공백**으로 가린다(`\r`·`\n` 은 그대로). 표 셀 안 체크리스트는 최상위 체크리스트가 아니다 — 가리지 않으면 셀 안
/// `<li data-checked=… data-type="taskItem">` 한 개 때문에 호출부(dashboard::board::parse_checkboxes 등)가 "HTML 전용
/// 모드"로 넘어가 같은 섹션의 정상 GFM 할 일(`- [ ] …`)까지 못 찾았다(일정·보드·토글에서 조용히 사라진다).
/// 길이가 같으므로 가린 사본에서 찾은 위치를 원본에 그대로 쓸 수 있다(toggle_at).
///
/// 규칙은 프런트와 한 벌이다(src/lib/inlineSchedule.ts::maskHtmlTables): 깊이를 세어 **바깥 표가 닫힐 때만** 가리고,
/// 안 닫힌 표·짝 없는 닫는 태그는 그대로 둔다. 표가 없으면 빌려 쓴다(복사 없음).
pub fn mask_html_tables(body: &str) -> Cow<'_, str> {
    let bytes = body.as_bytes();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut i = 0usize;
    while let Some(rel) = body[i..].find('<') {
        i += rel;
        if table_tag_at(bytes, i, false) {
            if depth == 0 {
                start = i;
            }
            depth += 1;
            i += "<table".len();
        } else if depth > 0 && table_tag_at(bytes, i, true) {
            depth -= 1;
            let Some(gt) = body[i..].find('>') else { break };
            i += gt + 1;
            if depth == 0 {
                ranges.push((start, i));
            }
        } else {
            i += 1;
        }
    }
    if ranges.is_empty() {
        return Cow::Borrowed(body);
    }
    let mut out = String::with_capacity(body.len());
    let mut last = 0usize;
    for (s, e) in ranges {
        out.push_str(&body[last..s]);
        for c in body[s..e].chars() {
            if c == '\n' || c == '\r' {
                out.push(c);
            } else {
                out.extend(std::iter::repeat(' ').take(c.len_utf8()));
            }
        }
        last = e;
    }
    out.push_str(&body[last..]);
    Cow::Owned(out)
}

/// 본문(표 조각을 가린 것)에 tiptap TaskItem HTML 마크업이 있는가 — 있으면 호출부는 HTML 경로, 없으면 GFM 경로.
pub fn has_task_item_markup(masked_body: &str) -> bool {
    masked_body.contains("data-type=\"taskItem\"") || masked_body.contains("data-type='taskItem'")
}

fn find_nth_li_open(html: &str, n: usize) -> Option<usize> {
    let mut start = 0;
    for i in 0..=n {
        let pos = start + html[start..].find(LI_OPEN)?;
        if i == n {
            return Some(pos);
        }
        start = pos + LI_OPEN.len();
    }
    None
}

/// Number of task-list checkboxes in this section body (bounded scan, no allocation of item text).
pub fn count_checkboxes(html: &str) -> usize {
    // 표 조각 안 항목은 세지 않는다 — mask_html_tables.
    mask_html_tables(html).matches(LI_OPEN).count()
}

/// All checkboxes in document order: (checked, text ≤60 chars tag-stripped). Nested task lists
/// (a taskItem's own `<div>` containing a further `<ul data-type="taskList">`) fall out for free —
/// `find(LI_OPEN)` just keeps walking forward and hits the nested `<li>` next, and each item's text
/// extraction only looks at the *first* `<p>...</p>` after its own `data-checked="..."`, which is
/// always that item's own paragraph (the nested list, if any, comes after it) — see
/// mdSerialize.test.ts's "nested task list" fixture for the exact shape this relies on.
pub fn scan_checkboxes(html: &str) -> Vec<(bool, String)> {
    // 표 조각 안 항목은 보지 않는다 — mask_html_tables.
    let masked = mask_html_tables(html);
    let html = masked.as_ref();
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(rel) = html[start..].find(LI_OPEN) {
        let pos = start + rel;
        let value_start = pos + LI_OPEN.len();
        let checked = html[value_start..].starts_with("true");
        let text = html[value_start..]
            .find("<p>")
            .and_then(|p_rel| {
                let p_start = value_start + p_rel + 3;
                html[p_start..]
                    .find("</p>")
                    .map(|end_rel| strip_tags_and_collapse(&html[p_start..p_start + end_rel], 60))
            })
            .unwrap_or_default();
        out.push((checked, text));
        start = value_start;
    }
    out
}

/// Flip the `local_index`-th checkbox (0-based, within this one section body) to `checked`.
/// Rewrites both the `data-checked="..."` attribute and the `<input type="checkbox" ...>` tag in
/// lockstep (same pair the desktop editor's TaskItem node attrs read on load) — `None` if
/// `local_index` is out of range for this body.
pub fn toggle_at(html: &str, local_index: usize, checked: bool) -> Option<String> {
    // 찾기는 표 조각을 가린 사본에서, 고치기는 원본에서 — 길이가 같아 위치가 그대로 맞는다(mask_html_tables).
    let pos = find_nth_li_open(&mask_html_tables(html), local_index)?;
    let value_start = pos + LI_OPEN.len();
    let value_end = value_start + html[value_start..].find('"')?;
    let new_value = if checked { "true" } else { "false" };

    let input_start = value_end + html[value_end..].find(INPUT_MARKER)?;
    let after_marker = input_start + INPUT_MARKER.len();
    let input_tag_end = after_marker + html[after_marker..].find('>')?;
    let checked_suffix = if checked { " checked=\"checked\"" } else { "" };

    let mut out = String::with_capacity(html.len() + checked_suffix.len());
    out.push_str(&html[..value_start]);
    out.push_str(new_value);
    out.push_str(&html[value_end..after_marker]);
    out.push_str(checked_suffix);
    out.push_str(&html[input_tag_end..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHECKED: &str = "<li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Checked Task</p></div></li>";
    const UNCHECKED: &str = "<li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Unchecked Task</p></div></li>";
    // Same text as CHECKED/UNCHECKED above but under a distinct name — toggle_at must only flip
    // the checked markup and leave the item's own text untouched, so the round-trip tests below
    // need a checked/unchecked pair that agree on text (CHECKED/UNCHECKED intentionally don't,
    // to make scan_checkboxes_reads_checked_and_unchecked_items below also assert text extraction).
    const UNCHECKED_SAME_TEXT: &str = "<li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Checked Task</p></div></li>";
    const CHECKED_SAME_TEXT: &str = "<li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Unchecked Task</p></div></li>";

    #[test]
    fn strip_tags_and_collapse_caps_length_and_decodes_entities() {
        let html = "<p>Hello &amp; <strong>world</strong>   with   \n  extra   space</p>";
        assert_eq!(strip_tags_and_collapse(html, 160), "Hello & world with extra space");
        assert_eq!(strip_tags_and_collapse("abcdefgh", 3), "abc");
    }

    #[test]
    fn scan_checkboxes_reads_checked_and_unchecked_items() {
        let html = format!("<ul data-type=\"taskList\">{CHECKED}{UNCHECKED}</ul>");
        let items = scan_checkboxes(&html);
        assert_eq!(items, vec![(true, "Checked Task".to_string()), (false, "Unchecked Task".to_string())]);
        assert_eq!(count_checkboxes(&html), 2);
    }

    /// mdSerialize.test.ts's nested fixture: a taskItem's own paragraph must not swallow the
    /// nested list's item text, and the nested item must still be found (in document order).
    #[test]
    fn scan_checkboxes_handles_nested_task_lists() {
        let html = "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"><span></span></label><div><p>Parent</p><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Child</p></div></li></ul></div></li></ul>";
        let items = scan_checkboxes(html);
        assert_eq!(items, vec![(false, "Parent".to_string()), (true, "Child".to_string())]);
    }

    #[test]
    fn scan_checkboxes_empty_body_yields_no_items() {
        assert_eq!(scan_checkboxes("<p>just a normal paragraph</p>"), Vec::new());
        assert_eq!(count_checkboxes(""), 0);
    }

    #[test]
    fn toggle_at_flips_unchecked_to_checked_matching_tiptap_markup_exactly() {
        let html = format!("<ul data-type=\"taskList\">{UNCHECKED_SAME_TEXT}</ul>");
        let out = toggle_at(&html, 0, true).unwrap();
        assert_eq!(out, format!("<ul data-type=\"taskList\">{CHECKED}</ul>"));
    }

    #[test]
    fn toggle_at_flips_checked_to_unchecked_matching_tiptap_markup_exactly() {
        let html = format!("<ul data-type=\"taskList\">{CHECKED_SAME_TEXT}</ul>");
        let out = toggle_at(&html, 0, false).unwrap();
        assert_eq!(out, format!("<ul data-type=\"taskList\">{UNCHECKED}</ul>"));
    }

    #[test]
    fn toggle_at_targets_the_right_ordinal_among_several() {
        let html = format!("<ul data-type=\"taskList\">{UNCHECKED}{UNCHECKED}{UNCHECKED}</ul>");
        let out = toggle_at(&html, 1, true).unwrap();
        let items = scan_checkboxes(&out);
        assert_eq!(items.iter().map(|(c, _)| *c).collect::<Vec<_>>(), vec![false, true, false]);
    }

    #[test]
    fn toggle_at_out_of_range_is_none() {
        let html = format!("<ul data-type=\"taskList\">{UNCHECKED}</ul>");
        assert!(toggle_at(&html, 1, true).is_none());
        assert!(toggle_at("<p>no checkboxes here</p>", 0, true).is_none());
    }

    // ── W0 검증 결함: 표 조각 ─────────────────────────────────────────────────

    /// 프런트 generateHTML 이 실제로 내는 모양(속성 순서 data-checked → data-type)의 표 조각 — 셀 안 체크리스트 포함.
    const FRAGMENT_TABLE_WITH_CELL_CHECKLIST: &str = "<table style=\"min-width: 50px;\"><colgroup><col style=\"min-width: 25px;\"><col style=\"min-width: 25px;\"></colgroup><tbody><tr><th colspan=\"2\" rowspan=\"1\"><p>제목</p></th></tr><tr><td colspan=\"1\" rowspan=\"1\"><ul data-type=\"taskList\"><li data-checked=\"false\" data-type=\"taskItem\"><label><input type=\"checkbox\"><span></span></label><div><p>마감</p></div></li></ul></td><td colspan=\"1\" rowspan=\"1\"><p>x</p></td></tr></tbody></table>";

    #[test]
    fn mask_html_tables_keeps_length_and_newlines() {
        let src = "a\n<table>\n<tr><td>한글</td></tr>\r\n</table>\nb";
        let out = mask_html_tables(src);
        assert_eq!(out.len(), src.len());
        assert_eq!(
            out,
            format!(
                "a\n{}\n{}\r\n{}\nb",
                " ".repeat("<table>".len()),
                " ".repeat("<tr><td>한글</td></tr>".len()),
                " ".repeat("</table>".len())
            )
        );
    }

    #[test]
    fn mask_html_tables_handles_nesting_case_and_non_tables() {
        let nested = "x<table><tr><td><table><tr><td>in</td></tr></table>tail</td></tr></table>y";
        assert_eq!(mask_html_tables(nested), format!("x{}y", " ".repeat(nested.len() - 2)));
        // 안 닫힌 표·짝 없는 닫는 태그·`<tablet` 은 그대로, 대소문자는 가리지 않는다.
        assert_eq!(mask_html_tables("a <table><tr> b"), "a <table><tr> b");
        assert_eq!(mask_html_tables("a </table> b"), "a </table> b");
        assert_eq!(mask_html_tables("a <tablet>x</tablet> b"), "a <tablet>x</tablet> b");
        let upper = "대소문자 <TABLE class=a>x</TABLE>!";
        assert_eq!(
            mask_html_tables(upper),
            format!("대소문자 {}!", " ".repeat("<TABLE class=a>x</TABLE>".len()))
        );
        // 표가 없으면 복사 없이 빌려 쓴다.
        assert!(matches!(mask_html_tables("- [ ] a\n- [x] b"), Cow::Borrowed(_)));
    }

    #[test]
    fn has_task_item_markup_ignores_items_inside_table_fragments() {
        let body = format!("- [ ] 2026-10-08 보고서\n\n{FRAGMENT_TABLE_WITH_CELL_CHECKLIST}\n");
        assert!(body.contains("data-type=\"taskItem\""), "전제: 날것 본문에는 표 안 taskItem 이 있다");
        assert!(!has_task_item_markup(&mask_html_tables(&body)));
        let top_level = format!("{FRAGMENT_TABLE_WITH_CELL_CHECKLIST}{UNCHECKED}");
        assert!(has_task_item_markup(&mask_html_tables(&top_level)));
    }

    #[test]
    fn scan_count_and_toggle_skip_checkboxes_inside_tables() {
        // 옛 순서(data-type 먼저)로 쓰인 표 셀 안 항목도 세지 않는다 — 표 앞뒤 최상위 항목만 순서대로 센다.
        let legacy_cell = "<table><tr><td><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Cell</p></div></li></ul></td></tr></table>";
        let html = format!("{UNCHECKED_SAME_TEXT}{legacy_cell}{CHECKED_SAME_TEXT}");
        assert_eq!(count_checkboxes(&html), 2);
        assert_eq!(
            scan_checkboxes(&html),
            vec![(false, "Checked Task".to_string()), (true, "Unchecked Task".to_string())]
        );
        // 둘째(표 뒤) 항목을 토글하면 표 셀 안 항목이 아니라 그 항목이 바뀌고, 나머지 바이트는 그대로다.
        let out = toggle_at(&html, 1, false).unwrap();
        assert_eq!(out, format!("{UNCHECKED_SAME_TEXT}{legacy_cell}{UNCHECKED}"));
        assert!(toggle_at(&html, 2, true).is_none());
    }

    #[test]
    fn strip_tags_and_collapse_keeps_table_cells_and_blocks_apart() {
        // 병합 표 — 태그만 떼면 "성명정보점수김하늘…" 로 붙었다.
        let table = "<table><tbody><tr><th colspan=\"2\"><p>성명 정보</p></th><th><p>점수</p></th></tr><tr><td><p>김하늘</p></td><td><p>이름</p></td><td><p>90</p></td></tr></tbody></table>";
        assert_eq!(strip_tags_and_collapse(table, 160), "성명 정보 점수 김하늘 이름 90");
        assert_eq!(strip_tags_and_collapse("<p>a</p><p>b</p><ul><li>c</li><li>d</li></ul>", 160), "a b c d");
        assert_eq!(strip_tags_and_collapse("a<br>b<br/>c", 160), "a b c");
        // 인라인 태그는 단어 한가운데에 있어도 공백을 넣지 않는다.
        assert_eq!(strip_tags_and_collapse("<p>wor<em>ld</em><strong>!</strong></p>", 160), "world!");
        // 속성이 긴 여는 태그도 이름으로 판정된다.
        assert_eq!(strip_tags_and_collapse("x<td style=\"background-color: rgb(255, 255, 0)\">y</td>z", 160), "x y z");
    }
}
