// 서식 매핑 — 제목·정렬·들여쓰기·마크·링크·목록·인용·코드·표·그림이 WordprocessingML 로 어떻게 나가는가.
use super::structure::assert_docx_consistent;
use super::*;

// ── 문단 · 마크 ───────────────────────────────────────────────────────────────

#[test]
fn headings_use_heading_styles_and_alignment_and_indent_map_to_paragraph_properties() {
    let h = |lvl: u32, t: &str, align: &str| json!({ "type": "heading", "attrs": { "level": lvl, "textAlign": align, "indent": 0 }, "content": [{ "type": "text", "text": t }] });
    let para = |align: &str, indent: u32| json!({ "type": "paragraph", "attrs": { "textAlign": align, "indent": indent }, "content": [{ "type": "text", "text": "문단" }] });
    let b = build_doc(vec![h(1, "하나", "left"), h(2, "둘", "center"), h(3, "셋", "left"), h(5, "다섯", "left"), para("justify", 2), para("right", 0), para("left", 99)]);
    let d = document(&b);
    assert_eq!(attr_vals(&d, "pStyle", "val"), vec!["Heading1", "Heading2", "Heading3", "Heading3"]);
    assert_eq!(attr_vals(&d, "jc", "val"), vec!["center", "both", "right"]);
    // 들여쓰기 한 단 = 400 twips, 6단에서 멈춘다.
    assert_eq!(attr_vals(&d, "ind", "left"), vec!["800", "2400"]);
    let styles = part(&b.bytes, "word/styles.xml");
    for (n, sz) in [(1, "32"), (2, "28"), (3, "24")] {
        assert!(styles.contains(&format!(r#"w:styleId="Heading{n}"><w:name w:val="heading {n}"/>"#)), "{styles}");
        assert!(styles.contains(&format!(r#"<w:sz w:val="{sz}"/>"#)));
    }
    assert!(styles.contains(r#"w:ascii="맑은 고딕" w:eastAsia="맑은 고딕""#) && styles.contains(r#"<w:sz w:val="20"/>"#));
    assert_docx_consistent(&b.bytes);
}

#[test]
fn marks_map_to_run_properties_in_schema_order() {
    let run = |t: &str, marks: Vec<Value>| json!({ "type": "text", "marks": marks, "text": t });
    let hl = |color: Option<&str>| json!({ "type": "highlight", "attrs": { "color": color } });
    let color = |c: &str| json!({ "type": "textStyle", "attrs": { "color": c } });
    // 같은 서식이 이어지면 한 런으로 합쳐지므로 서식 없는 공백 글자로 사이를 가른다.
    let runs = vec![
        run("굵게", vec![mark("bold")]),
        run("기울임", vec![mark("italic")]),
        run("밑줄", vec![mark("underline")]),
        run("취소", vec![mark("strike")]),
        run("노랑", vec![hl(None)]),
        run("노랑2", vec![hl(Some("#ffff00"))]),
        run("분홍", vec![hl(Some("rgb(255, 192, 203)"))]),
        run("빨강", vec![color("#ff0000")]),
        run("나쁜색", vec![color("red\" onclick=\"x")]),
        run("코드", vec![mark("code")]),
        run("전부", vec![mark("bold"), mark("italic"), mark("underline"), mark("strike"), color("rgb(0, 128, 0)"), hl(Some("#abcdef")), mark("code")]),
    ];
    let content: Vec<Value> = runs.into_iter().flat_map(|r| [r, json!({ "type": "text", "text": " " })]).collect();
    let para = json!({ "type": "paragraph", "content": content });
    let b = build_doc(vec![para]);
    let d = document(&b);
    assert!(d.contains(r#"<w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">굵게</w:t>"#), "{d}");
    assert!(d.contains(r#"<w:rPr><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">기울임</w:t>"#));
    assert!(d.contains(r#"<w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">밑줄</w:t>"#));
    assert!(d.contains(r#"<w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">취소</w:t>"#));
    // 형광펜: 기본·노란색은 `w:highlight`, 그 밖의 색은 런 음영 — 색 값에 `#` 이 없다.
    assert!(d.contains(r#"<w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">노랑</w:t>"#));
    assert!(d.contains(r#"<w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">노랑2</w:t>"#));
    assert!(d.contains(r#"<w:rPr><w:shd w:val="clear" w:color="auto" w:fill="FFC0CB"/></w:rPr><w:t xml:space="preserve">분홍</w:t>"#));
    assert!(d.contains(r#"<w:rPr><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">빨강</w:t>"#));
    // CSS 색 파서를 통과하지 못한 글자색은 버려진다 — 속성 주입이 안 된다.
    assert!(!d.contains("onclick") && d.contains("나쁜색 </w:t>"), "{d}");
    assert!(d.contains(r#"<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/></w:rPr><w:t xml:space="preserve">코드</w:t>"#));
    // 전부: rFonts → b → i → strike → color → u → shd 순서(highlight 가 아니라 음영이라 u 뒤).
    assert!(
        d.contains(r#"<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:b/><w:bCs/><w:i/><w:iCs/><w:strike/><w:color w:val="008000"/><w:u w:val="single"/><w:shd w:val="clear" w:color="auto" w:fill="ABCDEF"/></w:rPr>"#),
        "{d}"
    );
    assert_docx_consistent(&b.bytes);
}

#[test]
fn identical_adjacent_formats_merge_into_one_run() {
    let b = |t: &str| json!({ "type": "text", "marks": [mark("bold")], "text": t });
    let para = json!({ "type": "paragraph", "content": [b("가"), b("나"), { "type": "text", "text": "다" }, b("라")] });
    assert_eq!(count(&document(&build_doc(vec![para])), "r"), 3);
}

#[test]
fn tabs_and_hard_breaks_become_tab_and_br_elements() {
    let para = json!({ "type": "paragraph", "content": [{ "type": "text", "text": " a\tb " }, { "type": "hardBreak" }, { "type": "text", "text": "c" }] });
    let d = document(&build_doc(vec![para]));
    assert!(d.contains(r#"<w:t xml:space="preserve"> a</w:t><w:tab/><w:t xml:space="preserve">b </w:t><w:br/><w:t xml:space="preserve">c</w:t>"#), "{d}");
}

// ── 링크 ──────────────────────────────────────────────────────────────────────

#[test]
fn links_only_web_and_mail_become_external_relationships() {
    let link = |href: &str| json!({ "type": "paragraph", "content": [{ "type": "text", "marks": [{ "type": "link", "attrs": { "href": href } }], "text": "L" }] });
    let b = build_doc(vec![
        link("https://a.example/p?q=1&r=2"),
        link("mailto:me@example.com"),
        link("HTTP://UPPER.example/"),
        link("https://a.example/p?q=1&r=2"),
        link("javascript:alert(1)"),
        link("note://abc"),
        link("file:///C:/x"),
        link("https://a b.example/"),
        link(""),
    ]);
    let d = document(&b);
    assert_eq!(count(&d, "hyperlink"), 4, "{d}");
    assert!(!d.contains("javascript") && !d.contains("file:"), "{d}");
    let rels = part(&b.bytes, "word/_rels/document.xml.rels");
    // 같은 주소는 관계 하나를 같이 쓴다. `&` 는 이스케이프된다.
    assert_eq!(rels.matches(r#"TargetMode="External""#).count(), 3, "{rels}");
    assert!(rels.contains(r#"Target="https://a.example/p?q=1&amp;r=2" TargetMode="External""#), "{rels}");
    assert!(rels.contains(r#"Target="mailto:me@example.com" TargetMode="External""#) && rels.contains(r#"Target="HTTP://UPPER.example/""#));
    assert_eq!(attr_vals(&d, "hyperlink", "id"), vec!["rId4", "rId5", "rId6", "rId4"]);
    // 허용되지 않은 링크의 글자는 남는다 — 글자 "L" 이 아홉 번.
    assert_eq!(d.matches(r#"<w:t xml:space="preserve">L</w:t>"#).count(), 9);
    // 링크 글자는 Hyperlink 글자 스타일.
    assert_eq!(d.matches(r#"<w:rStyle w:val="Hyperlink"/>"#).count(), 4);
    assert_docx_consistent(&b.bytes);
}

#[test]
fn adjacent_links_group_into_one_hyperlink_element() {
    let link = |t: &str, marks: Vec<Value>| {
        let mut m = vec![json!({ "type": "link", "attrs": { "href": "https://a.example/x" } })];
        m.extend(marks);
        json!({ "type": "text", "marks": m, "text": t })
    };
    let para = json!({ "type": "paragraph", "content": [
        { "type": "text", "text": "앞 " }, link("링", vec![]), link("크", vec![mark("bold")]), { "type": "text", "text": " 뒤" }] });
    let b = build_doc(vec![para]);
    let d = document(&b);
    assert_eq!(count(&d, "hyperlink"), 1);
    assert!(d.contains(r#"<w:hyperlink r:id="rId4" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">링</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">크</w:t></w:r></w:hyperlink>"#), "{d}");
    assert_docx_consistent(&b.bytes);
}

// ── 목록 ──────────────────────────────────────────────────────────────────────

fn item(t: &str, inner: Vec<Value>) -> Value {
    let content = [vec![p(t)], inner].concat();
    json!({ "type": "listItem", "content": content })
}

fn ol(start: u32, items: Vec<Value>) -> Value {
    json!({ "type": "orderedList", "attrs": { "start": start, "type": null }, "content": items })
}

fn ul(items: Vec<Value>) -> Value {
    json!({ "type": "bulletList", "content": items })
}

#[test]
fn bullet_lists_share_one_definition_and_deeper_lists_use_deeper_levels() {
    let b = build_doc(vec![ul(vec![item("a", vec![ul(vec![item("b", vec![ul(vec![item("c", vec![])])])])]), item("d", vec![])])]);
    let d = document(&b);
    assert_eq!(attr_vals(&d, "numId", "val"), vec!["1", "1", "1", "1"]);
    assert_eq!(attr_vals(&d, "ilvl", "val"), vec!["0", "1", "2", "0"]);
    assert_eq!(attr_vals(&d, "pStyle", "val"), vec!["ListParagraph"; 4]);
    // 바깥 들여쓰기가 없으면 직접 들여쓰기를 쓰지 않는다(번호 정의의 들여쓰기가 적용된다).
    assert!(!d.contains("<w:ind"), "{d}");
    let n = part(&b.bytes, "word/numbering.xml");
    assert!(n.contains(r#"<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>"#), "{n}");
    assert!(n.contains(r#"w:val="◦""#) && n.contains(r#"w:val="▪""#) && !n.contains('\u{F0B7}'));
    assert_docx_consistent(&b.bytes);
}

#[test]
fn each_ordered_list_gets_its_own_num_with_a_start_override() {
    let b = build_doc(vec![ol(1, vec![item("a", vec![]), item("b", vec![])]), p("끊김"), ol(5, vec![item("c", vec![])])]);
    let d = document(&b);
    assert_eq!(attr_vals(&d, "numId", "val"), vec!["2", "2", "3"]);
    let n = part(&b.bytes, "word/numbering.xml");
    assert_eq!(attr_vals(&n, "num", "numId"), vec!["1", "2", "3"]);
    // numId 3 은 0 수준을 5 에서 시작, 나머지 수준은 1.
    assert!(n.contains(r#"<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride><w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"/>"#), "{n}");
    assert!(n.contains(r#"<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>"#) && n.contains(r#"<w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/>"#));
    assert_docx_consistent(&b.bytes);
}

#[test]
fn nested_ordered_lists_reuse_the_parent_num_and_mixed_kinds_use_their_own() {
    // 번호 → 번호(같은 num, 한 수준 아래) · 번호 → 글머리표(글머리표 num) · 글머리표 → 번호(새 num, 자기 수준에서 시작).
    let b = build_doc(vec![
        ol(1, vec![item("a", vec![ol(1, vec![item("a1", vec![])]), ul(vec![item("ab", vec![])])]), item("b", vec![])]),
        ul(vec![item("x", vec![ol(3, vec![item("x1", vec![])])])]),
    ]);
    let d = document(&b);
    assert_eq!(attr_vals(&d, "numId", "val"), vec!["2", "2", "1", "2", "1", "3"]);
    assert_eq!(attr_vals(&d, "ilvl", "val"), vec!["0", "1", "1", "0", "0", "1"]);
    let n = part(&b.bytes, "word/numbering.xml");
    assert!(n.contains(r#"<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride><w:lvlOverride w:ilvl="1"><w:startOverride w:val="3"/>"#), "{n}");
    assert_docx_consistent(&b.bytes);
}

#[test]
fn task_items_get_checkbox_glyphs_and_list_continuations_are_indented_to_the_text() {
    let task = |checked: bool, t: &str| json!({ "type": "taskItem", "attrs": { "checked": checked }, "content": [p(t)] });
    let list = json!({ "type": "taskList", "content": [task(true, "끝"), task(false, "할 일")] });
    // 항목의 둘째 블록(코드)은 글자 시작 위치(720)로 들여쓴다.
    let code = json!({ "type": "codeBlock", "content": [{ "type": "text", "text": "x" }] });
    let with_code = ul(vec![json!({ "type": "listItem", "content": [p("a"), code] })]);
    let b = build_doc(vec![list, with_code]);
    let d = document(&b);
    assert!(d.contains("☑ </w:t>") || d.contains("☑ 끝"), "{d}");
    assert!(d.contains("☐ "), "{d}");
    // 할 일은 번호가 없다 — numPr 는 글머리표 목록의 첫 문단 하나뿐.
    assert_eq!(count(&d, "numPr"), 1, "{d}");
    assert_eq!(attr_vals(&d, "ind", "left"), vec!["360", "360", "720"]);
    assert_docx_consistent(&b.bytes);
}

#[test]
fn lists_inside_quotes_add_the_outer_indent_and_carry_the_bar() {
    let quote = json!({ "type": "blockquote", "content": [ul(vec![item("a", vec![])])] });
    let b = build_doc(vec![quote]);
    let d = document(&b);
    // 인용 안 목록: 바깥 400 + 수준 0 의 720, 걸이 360. 인용 막대(왼쪽 테두리)도 목록 문단에 붙는다.
    assert!(d.contains(r#"<w:ind w:left="1120" w:hanging="360"/>"#), "{d}");
    assert!(d.contains(r#"<w:pBdr><w:left w:val="single""#), "{d}");
    assert_docx_consistent(&b.bytes);
}

// ── 블록 · 인용 · 코드 ────────────────────────────────────────────────────────

#[test]
fn quotes_code_rules_and_details_map_to_paragraph_formatting() {
    let content = vec![
        json!({ "type": "blockquote", "content": [p("인용"), json!({ "type": "blockquote", "content": [p("안쪽")] })] }),
        json!({ "type": "codeBlock", "attrs": { "language": null }, "content": [{ "type": "text", "text": "a\n\nb" }] }),
        json!({ "type": "horizontalRule" }),
        json!({ "type": "details", "content": [
            { "type": "detailsSummary", "content": [{ "type": "text", "text": "요약" }] },
            { "type": "detailsContent", "content": [p("내용")] }] }),
    ];
    let b = build_doc(content);
    let d = document(&b);
    // 인용 안 일반 문단은 Quote 스타일(접기 내용은 아니다).
    assert_eq!(attr_vals(&d, "pStyle", "val"), vec!["Quote", "Quote"]);
    // 인용은 400 씩 들여쓰고 왼쪽 막대. 접기 내용도 한 단.
    assert_eq!(attr_vals(&d, "ind", "left"), vec!["400", "800", "400"]);
    assert_eq!(d.matches(r#"<w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/>"#).count(), 2);
    // 코드는 줄마다 문단(빈 줄도) · 음영 · 고정폭 · 문단 사이 간격 없음.
    assert_eq!(d.matches(r#"<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>"#).count(), 3, "{d}");
    assert!(d.contains(r#"<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>"#));
    assert!(d.contains(r#"<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:pPr></w:p>"#), "{d}");
    // 가로줄은 아래 테두리가 있는 빈 문단.
    assert!(d.contains(r#"<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr></w:pPr></w:p>"#), "{d}");
    // 접기 요약은 굵게.
    assert!(d.contains(r#"<w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">요약</w:t>"#));
    assert_docx_consistent(&b.bytes);
}

#[test]
fn several_sections_get_their_names_as_headings_and_a_single_one_does_not() {
    let one = build("t", &[sec("이름", vec![p("본문")])], Paper::A4Portrait, &no_images).unwrap();
    assert!(!document(&one).contains("이름"));
    let two = build("t", &[sec("첫째", vec![p("가")]), sec("", vec![p("나")]), sec("셋째", vec![])], Paper::A4Portrait, &no_images).unwrap();
    assert_docx_consistent(&two.bytes);
    let d = document(&two);
    assert_eq!(attr_vals(&d, "pStyle", "val"), vec!["Heading1", "Heading1"]);
    assert!(d.find("첫째").unwrap() < d.find("가").unwrap() && d.find("나").unwrap() < d.find("셋째").unwrap());
}

// ── 표 ────────────────────────────────────────────────────────────────────────

#[test]
fn merged_table_uses_gridspan_vmerge_shading_header_row_and_widths() {
    let b = real_build();
    let d = document(&b);
    // real_section 의 바깥 표: 3열 3행(머리글 행 · rowspan 칸 · 중첩 표 칸) + 안쪽 표 1×1.
    assert_eq!(count(&d, "tbl"), 2);
    assert_eq!(attr_vals(&d, "gridSpan", "val"), vec!["2"]);
    assert_eq!(attr_vals(&d, "vMerge", "val"), vec!["restart"]);
    // 시작 칸 하나 + 이어짐 칸 하나(`val` 없음).
    assert_eq!(count(&d, "vMerge"), 2);
    // 머리글 행 반복 · 머리글 칸 음영(칸이 정한 배경이 우선) · 머리글 글자는 굵게.
    assert_eq!(count(&d, "tblHeader"), 1);
    assert!(d.contains(r#"<w:shd w:val="clear" w:color="auto" w:fill="FFE699"/>"#) && d.contains(r#"w:fill="F2F2F2""#), "{d}");
    assert!(d.contains(r#"<w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">AB</w:t>"#), "{d}");
    // 열 너비: colwidth 100px = 1500 twips 세 열. 안쪽 표는 칸 폭에서 칸 안쪽 여백을 뺀 한 열.
    assert_eq!(attr_vals(&d, "gridCol", "w"), vec!["1500", "1500", "1500", "1284"]);
    for w in attr_vals(&d, "tblW", "w") {
        assert!(w.parse::<i64>().unwrap() <= body_width(Paper::A4Portrait), "{w}");
    }
    assert!(d.contains(r#"<w:tblStyle w:val="TableGrid"/>"#) && d.contains(r#"<w:tblLayout w:type="fixed"/>"#));
    assert_docx_consistent(&b.bytes);
}

#[test]
fn vertical_merges_emit_continuation_cells_with_the_same_span() {
    // 가로 2칸 × 세로 3행 병합 하나 + 옆 칸들.
    let t = table_of(vec![
        trow(vec![tcell("a", 2, 3, Value::Null), tcell("b", 1, 1, Value::Null)]),
        trow(vec![tcell("c", 1, 1, Value::Null)]),
        trow(vec![tcell("d", 1, 1, Value::Null)]),
    ]);
    let b = build_doc(vec![t]);
    let d = document(&b);
    assert_eq!(attr_vals(&d, "vMerge", "val"), vec!["restart"]);
    assert_eq!(count(&d, "vMerge"), 3);
    // 시작 칸과 이어짐 칸 둘 모두 gridSpan 2.
    assert_eq!(attr_vals(&d, "gridSpan", "val"), vec!["2", "2", "2"]);
    assert_eq!(attr_vals(&d, "tcW", "w").len(), 6);
    assert_docx_consistent(&b.bytes);
}

#[test]
fn rows_fully_covered_by_a_merge_are_dropped_and_the_spanning_cells_shrink() {
    // x 가 열 0 을 3행, y 가 열 1 을 2행 덮어 둘째 행은 전 열이 가려졌다 — 걷히고 x 는 2행, y 는 1행으로 준다.
    let covered = table_of(vec![
        trow(vec![tcell("x", 1, 3, Value::Null), tcell("y", 1, 2, Value::Null)]),
        trow(vec![]),
        trow(vec![tcell("z", 1, 1, Value::Null)]),
    ]);
    let b = build_doc(vec![covered]);
    let d = document(&b);
    assert_eq!(count(&d, "tr"), 2);
    // x 만 세로 병합(2행)이라 이어짐 칸은 하나.
    assert_eq!(attr_vals(&d, "vMerge", "val"), vec!["restart"]);
    assert_eq!(count(&d, "vMerge"), 2);
    assert_docx_consistent(&b.bytes);
}

#[test]
fn nested_table_cells_and_adjacent_tables_end_with_paragraphs() {
    let inner = table_of(vec![trow(vec![tcell("안", 1, 1, Value::Null)])]);
    let outer_cell = json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [inner.clone()] });
    let outer = table_of(vec![trow(vec![outer_cell])]);
    // 표 바로 뒤에 표가 오면 Word 가 한 표로 합친다 — 사이에 문단. 본문이 표로 끝나도 문단 하나.
    let b = build_doc(vec![outer, inner.clone(), inner]);
    let d = document(&b);
    assert_docx_consistent(&b.bytes);
    assert_eq!(count(&d, "tbl"), 4);
    assert!(d.contains("</w:tbl><w:p/><w:tbl>"), "{d}");
    assert!(d.contains("</w:tbl><w:p/><w:sectPr>"), "{d}");
}

#[test]
fn ragged_raw_html_tables_get_their_grid_holes_filled() {
    let ragged = table_of(vec![
        trow(vec![tcell("a", 1, 1, Value::Null), tcell("b", 1, 1, Value::Null), tcell("c", 1, 1, Value::Null)]),
        trow(vec![tcell("d", 1, 1, Value::Null)]),
    ]);
    let b = build_doc(vec![ragged]);
    let d = document(&b);
    assert_eq!(count(&d, "gridCol"), 3);
    assert_eq!(count(&d, "tc"), 6);
    assert_docx_consistent(&b.bytes);
}

#[test]
fn random_ragged_and_overlapping_tables_always_cover_a_complete_grid() {
    // 결정적 난수(xorshift) — 길이가 들쭉날쭉하고 병합이 서로 겹치는 표를 많이 만들어 격자 불변식(모든 행이 모든 열을 덮음 · 이어짐 칸은
    // 같은 열의 시작 칸 아래)을 본다.
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move |m: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % m
    };
    for case in 0..300 {
        let nrows = 1 + next(6) as usize;
        let rows: Vec<Value> = (0..nrows)
            .map(|_| {
                let ncells = next(7);
                trow((0..ncells).map(|_| tcell("c", 1 + next(4) as u32, 1 + next(4) as u32, Value::Null)).collect())
            })
            .collect();
        let b = build("t", &[sec("s", vec![table_of(rows.clone())])], Paper::A4Portrait, &no_images);
        let b = b.unwrap_or_else(|e| panic!("case {case}: {e:?} for {rows:?}"));
        let d = document(&b);
        // 구조 검사기가 case 번호와 함께 실패하도록 감싼다.
        if let Err(e) = std::panic::catch_unwind(|| super::structure::check_structure(&d)) {
            panic!("case {case}: {} for {}", e.downcast_ref::<String>().cloned().unwrap_or_default(), serde_json::to_string(&rows).unwrap());
        }
    }
}

#[test]
fn absurd_colwidths_do_not_overflow_the_column_sum() {
    for big in [6.2e16, 1e17, 1e18, 9.3e18, 1e19, 1e300, f64::MAX] {
        let t = table_of(vec![trow(vec![tcell("a", 1, 1, json!([big])), tcell("b", 1, 1, json!([big])), tcell("c", 1, 1, json!([100]))])]);
        let b = build("t", &[sec("s", vec![t])], Paper::A4Portrait, &no_images).unwrap_or_else(|e| panic!("colwidth {big}: {e:?}"));
        let d = document(&b);
        let cols: Vec<i64> = attr_vals(&d, "gridCol", "w").iter().map(|w| w.parse().unwrap()).collect();
        let table: Vec<i64> = attr_vals(&d, "tblW", "w").iter().map(|w| w.parse().unwrap()).collect();
        assert_eq!(cols.len(), 3);
        assert!(cols.iter().all(|w| *w >= MIN_COL_WIDTH), "colwidth {big}: {cols:?}");
        assert!(table[0] > 0 && table[0] <= body_width(Paper::A4Portrait), "colwidth {big}: {table:?}");
        assert_eq!(cols.iter().sum::<i64>(), table[0], "colwidth {big}");
        assert_docx_consistent(&b.bytes);
    }
    // 음수·0 은 모르는 열과 같이 취급(균등 분할에 합류).
    let t = table_of(vec![trow(vec![tcell("a", 1, 1, json!([-5])), tcell("b", 1, 1, json!([0]))])]);
    assert!(build("t", &[sec("s", vec![t])], Paper::A4Portrait, &no_images).is_ok());
}

#[test]
fn cell_alignment_applies_to_default_aligned_paragraphs_only() {
    let cell = |nodes: Vec<Value>| json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null, "align": "right", "backgroundColor": null }, "content": nodes });
    let centered = json!({ "type": "paragraph", "attrs": { "textAlign": "center", "indent": 0 }, "content": [{ "type": "text", "text": "중" }] });
    let t = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [cell(vec![p("우")]), cell(vec![centered])] }] });
    let d = document(&build_doc(vec![t]));
    assert_eq!(attr_vals(&d, "jc", "val"), vec!["right", "center"]);
}

// ── 그림 ──────────────────────────────────────────────────────────────────────

#[test]
fn images_are_embedded_once_sized_from_the_percentage_and_failures_leave_a_label() {
    let para = json!({ "type": "paragraph", "content": [
        image_node(Some("n1/ok.png"), "좋은 \"그림\" <1>", "50%"), image_node(Some("n1/ok.png"), "", "100%"),
        image_node(Some("n1/missing.png"), "없는", "50%"), image_node(None, "원격", "50%"),
    ] });
    let resolver = |rel: &str| (rel == "n1/ok.png").then(png_bytes);
    let b = build("t", &[sec("s", vec![para])], Paper::A4Portrait, &resolver).unwrap();
    assert_eq!((b.image_count, b.skipped_images), (2, 2));
    let names: Vec<String> = entries(&b.bytes).into_iter().map(|(n, _)| n).collect();
    assert_eq!(names.iter().filter(|n| n.starts_with("word/media/")).count(), 1, "same file is stored once");
    let d = document(&b);
    // 본문 폭 9026 twips = 5731510 EMU 의 50% = 2865755, 8×6px 비율의 높이 2149316.
    assert!(d.contains(r#"<wp:extent cx="2865755" cy="2149316"/>"#), "{d}");
    assert!(d.contains(r#"<wp:extent cx="5731510" cy="4298633"/>"#), "{d}");
    // 둘 다 같은 관계를 가리키고 docPr id 는 1, 2 로 유일, 대체 글은 이스케이프된다.
    assert_eq!(attr_vals(&d, "blip", "embed"), vec!["rId4", "rId4"]);
    assert_eq!(attr_vals(&d, "docPr", "id"), vec!["1", "2"]);
    assert_eq!(attr_vals(&d, "docPr", "descr"), vec!["좋은 \"그림\" <1>".to_string(), String::new()]);
    assert!(d.contains(r#"descr="좋은 &quot;그림&quot; &lt;1&gt;""#), "{d}");
    assert!(d.contains("[그림: 없는]") && d.contains("[그림: 원격]"), "{d}");
    assert!(d.contains(r#"<a:graphicFrameLocks noChangeAspect="1"/>"#) && d.contains(r#"<pic:cNvPr id="0" name="image1.png"/>"#));
    assert_docx_consistent(&b.bytes);
}

#[test]
fn tall_images_are_shrunk_to_fit_the_page_body() {
    // 1×4000px 의 가느다란 그림을 100% 폭으로 — 비례 높이가 쪽을 넘으므로 줄어든다.
    let img = image::RgbImage::from_pixel(1, 4000, image::Rgb([1, 2, 3]));
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    let png = buf.into_inner();
    let para = json!({ "type": "paragraph", "content": [image_node(Some("n/x.png"), "", "100%")] });
    let b = build("t", &[sec("s", vec![para])], Paper::A4Portrait, &|_| Some(png.clone())).unwrap();
    let d = document(&b);
    let cy: i64 = attr_vals(&d, "extent", "cy")[0].parse().unwrap();
    let cx: i64 = attr_vals(&d, "extent", "cx")[0].parse().unwrap();
    assert!(cy as f64 <= body_height(Paper::A4Portrait) as f64 * EMU_PER_TWIP as f64 * 0.95 + 1.0, "{cy}");
    assert!(cx >= 1 && cx < 5_731_510, "{cx}");
}

#[test]
fn image_formats_jpeg_becomes_jpeg_tiff_is_converted_and_garbage_is_skipped() {
    let rgb = image::RgbImage::from_pixel(4, 4, image::Rgb([9, 9, 9]));
    let mut jpg = Cursor::new(Vec::new());
    rgb.write_to(&mut jpg, image::ImageFormat::Jpeg).unwrap();
    let mut tif = Cursor::new(Vec::new());
    rgb.write_to(&mut tif, image::ImageFormat::Tiff).unwrap();
    let (jpg, tif) = (jpg.into_inner(), tif.into_inner());
    let para = json!({ "type": "paragraph", "content": [image_node(Some("a"), "", "10%"), image_node(Some("b"), "", "10%"), image_node(Some("c"), "", "10%"), image_node(Some("d"), "", "10%")] });
    let resolver = |rel: &str| match rel {
        "a" => Some(jpg.clone()),
        "b" => Some(tif.clone()),
        "c" => Some(b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()),
        _ => Some(vec![0u8; 10]),
    };
    let b = build("t", &[sec("s", vec![para])], Paper::A4Portrait, &resolver).unwrap();
    assert_eq!((b.image_count, b.skipped_images), (2, 2));
    let names: Vec<String> = entries(&b.bytes).into_iter().map(|(n, _)| n).filter(|n| n.starts_with("word/media/")).collect();
    // OOXML 의 JPEG 는 `image/jpeg` · 확장자 `jpeg`(Hancom 의 `image/jpg` 표기를 쓰지 않는다).
    assert_eq!(names, vec!["word/media/image1.jpeg", "word/media/image2.png"]);
    let ct = part(&b.bytes, "[Content_Types].xml");
    assert!(ct.contains(r#"<Default Extension="jpeg" ContentType="image/jpeg"/>"#) && !ct.contains("image/jpg"), "{ct}");
    assert_docx_consistent(&b.bytes);
}
