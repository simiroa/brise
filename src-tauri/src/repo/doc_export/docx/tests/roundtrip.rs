// 왕복 — 내보낸 docx 를 가져오기(`doc_import::docx`)로 다시 읽어 내용이 남는지.
// 두 형식의 왕복 결과는 같은 Brise HTML 계약을 지난다 — 아래 단언은 HWPX 왕복 테스트(`hwpx::tests`)와 같은 조각이다.
use super::*;
use crate::repo::doc_import::{docx::parse_file, SavedImage};

fn reimport(bytes: &[u8]) -> String {
    let mut f = tempfile::Builder::new().suffix(".docx").tempfile().unwrap();
    std::io::Write::write_all(&mut f, bytes).unwrap();
    let parsed = parse_file(f.path()).unwrap();
    let atts: Vec<SavedImage> = parsed.images.iter().enumerate().map(|(i, im)| SavedImage { rel_path: format!("n/{i}-{}", im.name), name: im.name.clone() }).collect();
    parsed.render(&atts)
}

#[test]
fn headings_alignment_indent_marks_and_links_round_trip() {
    let html = reimport(&real_build().bytes);
    assert!(html.starts_with("<h1>제목 1</h1>\n<h2 data-brise-align=\"center\" style=\"text-align: center;\">가운데 제목</h2>"), "{html}");
    // 양쪽 정렬 + 들여쓰기 2단 + 마크들.
    assert!(
        html.contains(r#"<p data-brise-align="justify" data-brise-indent="2" style="text-align: justify; margin-left: 4em;">양쪽 <strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소</s> <mark>형광</mark> "#),
        "{html}"
    );
    assert!(html.contains(r#"<span style="color: #ff0000">빨강</span> <span style="color: #008000">초록</span> "#), "{html}");
    assert!(html.contains(r#"<a href="https://example.com/a?b=1&amp;c=2">링크</a> code<br>다음줄</p>"#), "{html}");
}

#[test]
fn heading_levels_come_back() {
    let h = |lvl: u32, t: &str| json!({ "type": "heading", "attrs": { "level": lvl, "textAlign": "left", "indent": 0 }, "content": [{ "type": "text", "text": t }] });
    let b = build_doc(vec![h(1, "하나"), h(2, "둘"), h(3, "셋"), h(5, "다섯"), p("본문")]);
    let html = reimport(&b.bytes);
    assert!(html.starts_with("<h1>하나</h1>\n<h2>둘</h2>\n<h3>셋</h3>\n<h3>다섯</h3>\n<p>본문</p>"), "{html}");
}

#[test]
fn lists_tasks_code_and_quotes_survive() {
    let html = reimport(&real_build().bytes);
    assert!(html.contains("<ul><li><p>가</p><ul><li><p>가1</p></li></ul></li><li><p>나</p></li></ul>"), "{html}");
    // 시작 번호 3 인 번호 목록은 `start` 로 돌아온다(예전에는 1 로 다시 세는 거짓말이었다).
    assert!(html.contains(r#"<ol start="3"><li><p>하나</p><ol><li><p>중첩</p></li></ol></li></ol>"#), "{html}");
    // 할 일은 글자 접두, 코드는 줄마다 문단, 인용·접기는 들여쓴 문단.
    assert!(html.contains("☑ done</p>") && html.contains("☐ todo</p>"), "{html}");
    assert!(html.contains("<p>const a = 1;</p>") && html.contains("<p>  if (a) {}</p>"), "{html}");
    assert!(html.contains(r#"<p data-brise-indent="1" style="margin-left: 2em;">인용</p>"#), "{html}");
    assert!(html.contains("<p><strong>요약</strong></p>") && html.contains(r#"<p data-brise-indent="1" style="margin-left: 2em;">내용</p>"#), "{html}");
}

#[test]
fn a_numbered_list_with_paragraphs_inside_its_items_keeps_counting_after_a_round_trip() {
    // 항목마다 보충 문단이 붙은 "1. 첫째 / 2. 둘째 / 3. 셋째" — 보충 문단이 목록을 끊어도 번호가 1 로 되돌아가지 않는다.
    let item = |t: &str| json!({ "type": "listItem", "content": [p(t), p("보충")] });
    let list = json!({ "type": "orderedList", "attrs": { "start": 1 }, "content": [item("첫째"), item("둘째"), item("셋째")] });
    let tail = json!({ "type": "orderedList", "attrs": { "start": 9 }, "content": [item("아홉")] });
    let html = reimport(&build_doc(vec![list, p("사이"), tail]).bytes);
    assert!(html.starts_with("<ol><li><p>첫째</p></li></ol>"), "{html}");
    assert!(html.contains(r#"<ol start="2"><li><p>둘째</p></li></ol>"#), "{html}");
    assert!(html.contains(r#"<ol start="3"><li><p>셋째</p></li></ol>"#), "{html}");
    // 다음 번호 목록은 자기 시작 번호(9)에서.
    assert!(html.contains(r#"<ol start="9"><li><p>아홉</p></li></ol>"#), "{html}");
}

#[test]
fn a_nested_numbered_list_with_its_own_start_does_not_reset_the_parent_count() {
    // 안쪽 번호 목록이 시작 번호 5 라서 새 `w:num`(모든 단을 덮어쓴다)이 되고, 그 뒤 문단이 목록을 끊은 다음 바깥 항목 B 가 이어진다.
    // 안쪽 인스턴스가 바깥 목록의 0 단 번호까지 되돌리면 B 가 2 가 아니라 1 로 돌아온다.
    let nested = json!({ "type": "orderedList", "attrs": { "start": 5 }, "content": [{ "type": "listItem", "content": [p("안쪽")] }] });
    let a = json!({ "type": "listItem", "content": [p("에이"), nested, p("에이 보충")] });
    let b = json!({ "type": "listItem", "content": [p("비")] });
    let list = json!({ "type": "orderedList", "attrs": { "start": 1 }, "content": [a, b] });
    let html = reimport(&build_doc(vec![list]).bytes);
    assert!(html.starts_with(r#"<ol><li><p>에이</p><ol start="5"><li><p>안쪽</p></li></ol></li></ol>"#), "{html}");
    assert!(html.contains(r#"<ol start="2"><li><p>비</p></li></ol>"#), "{html}");
}

#[test]
fn merged_table_background_colwidth_and_nested_table_round_trip() {
    let html = reimport(&real_build().bytes);
    // 머리글 칸은 굵게(Brise 가 그리는 모양), 병합·배경·열 너비(100px = 1500 twips)·중첩 표가 그대로.
    assert!(
        html.contains(r#"<th colspan="2" colwidth="100,100" style="background-color: #ffe699"><p><strong>AB</strong></p></th><th colwidth="100" style="background-color: #f2f2f2"><p><strong>C</strong></p></th>"#),
        "{html}"
    );
    assert!(html.contains(r#"<td rowspan="2" colwidth="100"><p>1</p></td><td colwidth="100"><p>2</p></td><td colwidth="100"><p>3</p></td>"#), "{html}");
    assert!(html.contains(r#"<td colwidth="100"><table><tr><th colwidth="86"><p>중첩표</p></th></tr></table></td>"#), "nested table: {html}");
    // 그림: 너비 70%.
    assert!(html.contains("width: 70%"), "{html}");
}

#[test]
fn resume_style_table_round_trips_cell_by_cell() {
    let html = reimport(&build("t", &[sample_main("DOCX")], Paper::A4Portrait, &no_images).unwrap().bytes);
    // 병합(colspan 4 · rowspan 3 · rowspan 2) · 셀 배경 · 정렬 · 열 너비.
    assert!(html.contains(r#"<th colspan="4" colwidth="90,140,90,140" style="background-color: #ddebf7">"#), "{html}");
    assert!(html.contains(r#"<td rowspan="3" colwidth="90" style="background-color: #f2f2f2"><p data-brise-align="center" style="text-align: center;">사진</p></td>"#), "{html}");
    assert!(html.contains(r#"<td colspan="3" colwidth="140,90,140" style="background-color: #fff2cc">"#), "{html}");
    for text in ["성명", "홍길동", "생년월일", "010-0000-0000", "hong@example.com", "경력", "2019 – 2024  Brise 개발"] {
        assert!(html.contains(text), "{text} in {html}");
    }
    assert_eq!(html.matches("<tr>").count(), 6, "{html}");
}

#[test]
fn rows_covered_by_a_merge_do_not_shift_cells_after_a_round_trip() {
    let covered = table_of(vec![
        trow(vec![tcell("x", 1, 3, Value::Null), tcell("y", 1, 2, Value::Null)]),
        trow(vec![]),
        trow(vec![tcell("z", 1, 1, Value::Null)]),
    ]);
    let html = reimport(&build_doc(vec![covered]).bytes);
    assert_eq!(html.matches("<tr>").count(), 2, "{html}");
    for ch in ["x", "y", "z"] {
        assert!(html.contains(&format!(">{ch}<")), "{ch} in {html}");
    }
    assert!(html.contains(r#"rowspan="2""#), "{html}");
}

#[test]
fn cell_alignment_round_trips() {
    let cell = |nodes: Vec<Value>| json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null, "align": "right", "backgroundColor": null }, "content": nodes });
    let centered = json!({ "type": "paragraph", "attrs": { "textAlign": "center", "indent": 0 }, "content": [{ "type": "text", "text": "중" }] });
    let t = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [cell(vec![p("우")]), cell(vec![centered])] }] });
    let html = reimport(&build_doc(vec![t]).bytes);
    assert!(html.contains(r#"data-brise-align="right""#) && html.contains(r#"data-brise-align="center""#), "{html}");
}

#[test]
fn images_round_trip_with_their_percentage_width() {
    let para = json!({ "type": "paragraph", "content": [image_node(Some("n1/ok.png"), "좋은", "50%"), image_node(Some("n1/ok.png"), "", "100%")] });
    let resolver = |rel: &str| (rel == "n1/ok.png").then(png_bytes);
    let b = build("t", &[sec("s", vec![para])], Paper::A4Portrait, &resolver).unwrap();
    let html = reimport(&b.bytes);
    assert!(html.contains("width: 50%") && html.contains("width: 100%"), "{html}");
    assert_eq!(html.matches("<img").count(), 2, "{html}");
}

#[test]
fn hostile_text_round_trips_as_literal_text() {
    let nasty = "a\u{1}b &amp; <b>x</b> \"q\" 'r' ]]> &#1;";
    let para = json!({ "type": "paragraph", "content": [{ "type": "text", "text": nasty }] });
    let html = reimport(&build_doc(vec![para]).bytes);
    assert!(html.contains("ab &amp;amp; &lt;b&gt;x&lt;/b&gt;"), "{html}");
}

#[test]
fn several_sections_get_their_names_as_headings_and_a_single_one_does_not() {
    let one = build("t", &[sec("이름", vec![p("본문")])], Paper::A4Portrait, &no_images).unwrap();
    assert_eq!(reimport(&one.bytes), "<p>본문</p>");
    let two = build("t", &[sec("첫째", vec![p("가")]), sec("", vec![p("나")]), sec("셋째", vec![])], Paper::A4Portrait, &no_images).unwrap();
    let html = reimport(&two.bytes);
    assert!(html.starts_with("<h1>첫째</h1>\n<p>가</p>\n<p>나</p>\n<h1>셋째</h1>"), "{html}");
}

#[test]
fn mail_and_web_links_round_trip() {
    let link = |href: &str, t: &str| json!({ "type": "text", "marks": [{ "type": "link", "attrs": { "href": href } }], "text": t });
    let para = json!({ "type": "paragraph", "content": [link("mailto:me@example.com", "메일"), { "type": "text", "text": " " }, link("https://a.example/x", "웹")] });
    let html = reimport(&build_doc(vec![para]).bytes);
    assert_eq!(html, r#"<p><a href="mailto:me@example.com">메일</a> <a href="https://a.example/x">웹</a></p>"#);
}
