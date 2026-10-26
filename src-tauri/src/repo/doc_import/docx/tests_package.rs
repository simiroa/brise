// repo: doc_import::docx 테스트 ② — 패키지 · 관계 · 표 · 그림 · 각주 · 개체 · 거절 · 상한 + 실제 파일
//
// 픽스처와 서식 테스트는 `tests.rs`. 여기는 "파일이 어떻게 생겼는가"가 결과를 가르는 것들이다.
use super::super::hwpx::tests::png_bytes;
use super::super::{SavedImage, MAX_IMAGE_BYTES};
use super::tests::*;
use super::*;
use crate::repo::extraction::test_support::build_zip;
use std::io::Write;

// ── 패키지 · 관계 ─────────────────────────────────────────────────────────────

#[test]
fn relationship_targets_resolve_inside_the_word_folder_only() {
    let ok = |base: &str, target: &str| resolve_target(base, target, "word/");
    assert_eq!(ok("word", "media/a.png").as_deref(), Some("word/media/a.png"));
    assert_eq!(ok("word", "./media/a.png").as_deref(), Some("word/media/a.png"));
    // `..` 는 접어서 풀되, 결과가 word/ 안이면 받는다.
    assert_eq!(ok("word", "../word/media/a.png").as_deref(), Some("word/media/a.png"));
    assert_eq!(ok("word/sub", "../media/a.png").as_deref(), Some("word/media/a.png"));
    // 밖으로 나가는 것은 버린다: 형제 폴더 · 뿌리를 넘는 `..` · 절대 경로.
    assert_eq!(ok("word", "../customXml/item1.xml"), None);
    assert_eq!(ok("word", "../../x.png"), None);
    assert_eq!(ok("word", "../../../../etc/passwd"), None);
    assert_eq!(ok("word", "/docProps/thumbnail.jpeg"), None);
    assert_eq!(ok("word", "/etc/passwd"), None);
    // 뿌리 기준 절대 경로가 word/ 안이면 받는다.
    assert_eq!(ok("word", "/word/media/a.png").as_deref(), Some("word/media/a.png"));
    // 퍼센트 인코딩 · 역슬래시 · 쪽지/질의 · 빈 값 · 대소문자.
    assert_eq!(ok("word", "media/my%20pic.png").as_deref(), Some("word/media/my pic.png"));
    assert_eq!(ok("word", r"media\a.png").as_deref(), Some("word/media/a.png"));
    assert_eq!(ok("word", "media/a%3Fb.png").as_deref(), Some("word/media/a?b.png"));
    assert_eq!(ok("word", "media/a.png#frag").as_deref(), Some("word/media/a.png"));
    assert_eq!(ok("word", ""), None);
    assert_eq!(ok("Word", "media/a.png").as_deref(), Some("Word/media/a.png"));
    // 샌드박스가 비어 있으면(패키지 관계) 뿌리 밖만 막는다.
    assert_eq!(resolve_target("", "docProps/core.xml", "").as_deref(), Some("docProps/core.xml"));
    assert_eq!(resolve_target("", "../x", ""), None);
    // 깨진 퍼센트 인코딩은 그대로 둔다.
    assert_eq!(percent_decode("a%zzb%2"), "a%zzb%2");
}

#[test]
fn units_are_twips_or_strict_values_and_never_overflow() {
    assert_eq!(measure(Some("720")), Some(720));
    assert_eq!(measure(Some("36pt")), Some(720));
    assert_eq!(measure(Some("595.30pt")), Some(11906));
    assert_eq!(measure(Some("1in")), Some(1440));
    assert_eq!(measure(Some("2.54cm")), Some(1440));
    assert_eq!(measure(Some("25.4mm")), Some(1440));
    assert_eq!(measure(Some("6pc")), Some(1440));
    assert_eq!(measure(Some("-10")), Some(-10));
    assert_eq!(measure(Some("abc")), None);
    assert_eq!(measure(Some("inf")), None);
    assert_eq!(measure(Some("NaN")), None);
    assert_eq!(measure(None), None);
    assert_eq!(measure(Some("99999999999999999999")), Some(MAX_TWIPS));
    assert_eq!(measure(Some("-99999999999999999999pt")), Some(-MAX_TWIPS));
}

fn raw_docx(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
    build_zip(".docx", entries)
}

#[test]
fn main_part_is_found_through_the_package_relationship_or_by_convention() {
    let doc = wrap("document", &format!("<w:body>{}{SECT}</w:body>", p(&r("본문"))));
    let root_rels = rels_xml(&[rel("rId1", "officeDocument", "word/main.xml")]);
    // 관계가 가리키는 곳(word/main.xml) — 관례 이름이 아니다.
    let f = raw_docx(&[("_rels/.rels", root_rels.as_bytes()), ("word/main.xml", doc.as_bytes())]);
    assert_eq!(parse_render(&f).unwrap().0, "<p>본문</p>");
    // 절대 Target(`/word/main.xml`) 도 받는다.
    let abs = rels_xml(&[rel("rId1", "officeDocument", "/word/main.xml")]);
    let f = raw_docx(&[("_rels/.rels", abs.as_bytes()), ("word/main.xml", doc.as_bytes())]);
    assert_eq!(parse_render(&f).unwrap().0, "<p>본문</p>");
    // 패키지 관계가 없으면 word/document.xml.
    let f = raw_docx(&[("word/document.xml", doc.as_bytes())]);
    assert_eq!(parse_render(&f).unwrap().0, "<p>본문</p>");
    // 엔트리 이름의 대소문자는 가리지 않는다(OPC 파트 이름 규칙).
    let f = raw_docx(&[("Word/Document.XML", doc.as_bytes())]);
    assert_eq!(parse_render(&f).unwrap().0, "<p>본문</p>");
}

#[test]
fn strict_namespaces_relationship_types_and_units_are_read() {
    // strict: 네임스페이스 purl.oclc.org · 관계 종류 purl.oclc.org · 쪽 크기를 `pt` 로. 본문 폭 = 400 − 100 = 300pt = 3,810,000 EMU.
    let strict_sect = r#"<w:sectPr><w:pgSz w:w="400pt" w:h="600pt"/><w:pgMar w:top="72pt" w:right="50pt" w:bottom="72pt" w:left="50pt" w:header="35pt" w:footer="35pt" w:gutter="0pt"/></w:sectPr>"#;
    let mut dd = d(&p(&drawing_inline("rIdPic", 1_905_000))).image("rIdPic", "image1.png", png_bytes());
    dd.document = dd.document.replace(SECT, strict_sect).replace(
        "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"",
        "xmlns:w=\"http://purl.oclc.org/ooxml/wordprocessingml/main\"",
    );
    dd.rels = dd.rels.iter().map(|x| x.replace(RT, "http://purl.oclc.org/ooxml/officeDocument/relationships")).collect();
    let html = dd.html();
    // 절반 폭 → 50%. 쪽 크기를 못 읽었다면 A4 기본 폭(9026 twips)으로 33% 가 나왔을 것이다.
    assert!(html.contains("style=\"width: 50%\""), "{html}");
}

#[test]
fn missing_or_empty_relationship_parts_do_not_break_the_import() {
    // word/_rels/document.xml.rels 가 아예 없어도 본문은 읽힌다(스타일 · 번호 · 각주 · 그림만 없다).
    let doc = wrap("document", &format!("<w:body>{}{SECT}</w:body>", p(&rp("<w:b/>", "x"))));
    let f = raw_docx(&[("word/document.xml", doc.as_bytes())]);
    assert_eq!(parse_render(&f).unwrap().0, "<p><strong>x</strong></p>");
}

// ── 그림 ──────────────────────────────────────────────────────────────────────

fn img_tag(i: usize, name: &str, width: Option<u32>) -> String {
    let style = width.map(|w| format!(" style=\"width: {w}%\"")).unwrap_or_default();
    format!("<img src=\"n/{i}-{name}\" data-rel-path=\"n/{i}-{name}\" alt=\"{name}\"{style}>")
}

#[test]
fn inline_pictures_become_blocks_with_width_percent_and_are_deduplicated() {
    let half = BODY_EMU / 2;
    let body = [
        p(&format!("{}{}", r("앞"), drawing_inline("rIdA", half))),
        // 같은 파일을 가리키는 다른 관계 + 같은 관계 한 번 더 → 저장은 한 장.
        p(&drawing_inline("rIdB", BODY_EMU * 3)), // 본문보다 넓다 → 100
        p(&drawing_inline("rIdA", 1000)),         // 아주 작다 → 10
    ]
    .concat();
    let dd = d(&body)
        .image("rIdA", "image1.png", png_bytes())
        .rel(rel("rIdB", "image", "media/image1.png"));
    let (html, parsed) = dd.parsed();
    assert_eq!(parsed.images.len(), 1);
    assert_eq!(
        html,
        [
            "<p>앞</p>".to_string(),
            img_tag(0, "image1.png", Some(50)),
            img_tag(0, "image1.png", Some(100)),
            img_tag(0, "image1.png", Some(10)),
        ]
        .join("\n")
    );
    assert!(parsed.dropped.is_empty());
}

#[test]
fn a_picture_without_extent_has_no_width_style() {
    let body = p(&drawing_inline("rIdA", 100).replace(r#"<wp:extent cx="100" cy="95250"/>"#, ""));
    let html = d(&body).image("rIdA", "image1.png", png_bytes()).html();
    assert_eq!(html, img_tag(0, "image1.png", None));
}

#[test]
fn external_pictures_are_never_read() {
    // 같은 이름의 엔트리가 패키지에 있어도 외부 관계(TargetMode External)와 r:link 는 읽지 않는다.
    let linked = |attr: &str| {
        p(&format!(
            r#"<w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip {attr}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
        ))
    };
    let body = [r("앞"), String::new()].concat();
    let body = [p(&body), linked(r#"r:link="rIdX""#), linked(r#"r:embed="rIdX""#), linked("")].concat();
    let dd = d(&body)
        .rel(rel_ext("rIdX", "image", "media/image1.png"))
        .part("word/media/image1.png", png_bytes());
    let (html, parsed) = dd.parsed();
    assert_eq!(html, "<p>앞</p>");
    assert!(parsed.images.is_empty());
    assert_eq!(kinds(&parsed), vec![("image_missing".to_string(), 3)]);
}

#[test]
fn pictures_that_cannot_be_used_are_counted_not_lost() {
    let body = [
        p(&drawing_inline("rIdWmf", 100_000)),   // 웹뷰가 못 그리는 형식
        p(&drawing_inline("rIdNone", 100_000)),  // 관계가 없다
        p(&drawing_inline("rIdGone", 100_000)),  // 관계는 있는데 엔트리가 없다
        p(&drawing_inline("rIdEsc", 100_000)),   // word/ 밖을 가리킨다
        p(&drawing_inline("rIdOk", 100_000)),
    ]
    .concat();
    let dd = d(&body)
        .image("rIdWmf", "pic.wmf", b"x".to_vec())
        .rel(rel("rIdGone", "image", "media/gone.png"))
        .rel(rel("rIdEsc", "image", "../customXml/evil.png"))
        .part("customXml/evil.png", png_bytes())
        .image("rIdOk", "ok.png", png_bytes());
    let (html, parsed) = dd.parsed();
    assert_eq!(parsed.images.len(), 1);
    assert_eq!(html.matches("<img ").count(), 1, "{html}");
    assert_eq!(
        kinds(&parsed),
        vec![("image_format".to_string(), 1), ("image_missing".to_string(), 3)]
    );
}

#[test]
fn percent_encoded_and_absolute_targets_find_their_entries() {
    let body = [p(&drawing_inline("rIdA", 100_000)), p(&drawing_inline("rIdB", 100_000))].concat();
    let dd = d(&body)
        .rel(rel("rIdA", "image", "media/my%20pic.png"))
        .part("word/media/my pic.png", png_bytes())
        .rel(rel("rIdB", "image", "/word/media/abs.png"))
        .part("word/media/abs.png", png_bytes());
    let (html, parsed) = dd.parsed();
    assert_eq!(parsed.images.len(), 2);
    assert!(html.contains("my pic.png") && html.contains("abs.png"), "{html}");
}

#[test]
fn vml_pictures_use_imagedata_and_the_shape_style_width() {
    let pict = |style: &str| {
        format!(
            r##"<w:r><w:pict><v:shapetype id="t75"/><v:shape id="s1" type="#t75" style="{style}"><v:imagedata r:id="rIdA" o:title=""/></v:shape></w:pict></w:r>"##
        )
    };
    let body = [p(&pict("position:static;width:100pt;height:50pt")), p(&pict("height:50pt"))].concat();
    let (html, parsed) = d(&body).image("rIdA", "image1.png", png_bytes()).parsed();
    // 100pt = 1,270,000 EMU → 본문 5,731,510 의 22%. 폭이 없으면 스타일도 없다. 그림이 있는 pict 는 도형으로 세지 않는다.
    assert_eq!(html, [img_tag(0, "image1.png", Some(22)), img_tag(0, "image1.png", None)].join("\n"));
    assert!(parsed.dropped.is_empty());
}

#[test]
fn pictures_in_table_cells_scale_to_the_cell_width() {
    // 셀 폭 3000 twips = 1,905,000 EMU 의 절반 = 952,500 → 50%(본문 폭 기준이면 16%).
    let cell = format!(
        r#"<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>{}</w:tc>"#,
        p(&drawing_inline("rIdA", 952_500))
    );
    let body = format!(r#"<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr>{cell}</w:tr></w:tbl>"#);
    let html = d(&body).image("rIdA", "image1.png", png_bytes()).html();
    assert!(html.contains("style=\"width: 50%\""), "{html}");
}

#[test]
fn oversized_pictures_are_dropped_alone_not_the_document() {
    let mut big = png_bytes();
    big.resize(MAX_IMAGE_BYTES as usize + 16, 0);
    let body = [p(&r("본문")), p(&drawing_inline("rIdBig", 100_000))].concat();
    let (html, parsed) = d(&body).image("rIdBig", "big.png", big).parsed();
    assert_eq!(html, "<p>본문</p>");
    assert_eq!(kinds(&parsed), vec![("image_limit".to_string(), 1)]);
}

#[test]
fn thousands_of_distinct_pictures_stop_at_the_caps_and_every_skipped_one_is_counted() {
    // 서로 다른 그림 2100 장: 장수 상한(400)까지만 담고, 찾아 보는 개수 상한(2000) 밖은 읽지도 않는다 — 나머지는 전부 image_limit 로 센다.
    let n = 2100;
    let mut dd = d(&(0..n).map(|i| p(&drawing_inline(&format!("rId{i}"), 100_000))).collect::<String>());
    for i in 0..n {
        dd = dd.image(&format!("rId{i}"), &format!("im{i}.png"), png_bytes());
    }
    let started = std::time::Instant::now();
    let (_, parsed) = dd.parsed();
    assert_eq!(parsed.images.len(), 400);
    assert_eq!(kinds(&parsed), vec![("image_limit".to_string(), n as u32 - 400)]);
    assert!(started.elapsed() < std::time::Duration::from_secs(30), "{:?}", started.elapsed());
}

// ── 표 ────────────────────────────────────────────────────────────────────────

fn tc(w: i64, props: &str, inner: &str) -> String {
    format!(r#"<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>{props}</w:tcPr>{inner}</w:tc>"#)
}

fn tcp(text: &str) -> String {
    p(&r(text))
}

fn tr(cells: &[String]) -> String {
    format!("<w:tr>{}</w:tr>", cells.concat())
}

fn tbl(grid: &[i64], rows: &[String]) -> String {
    let cols: String = grid.iter().map(|w| format!(r#"<w:gridCol w:w="{w}"/>"#)).collect();
    format!("<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/></w:tblPr><w:tblGrid>{cols}</w:tblGrid>{}</w:tbl>", rows.concat())
}

#[test]
fn plain_tables_promote_the_first_row_and_use_grid_widths_as_pixels() {
    // mammoth-tables.docx 와 같은 모양: gridCol 4621 twips ≈ 308px.
    let body = tbl(
        &[4621, 4621],
        &[tr(&[tc(4621, "", &tcp("Top left")), tc(4621, "", &tcp("Top right"))]), tr(&[tc(4621, "", &tcp("Bottom left")), tc(4621, "", &tcp("Bottom right"))])],
    );
    assert_eq!(
        html_of(&[tcp("Above"), body, tcp("Below")].concat()),
        "<p>Above</p>\n<table><tr><th colwidth=\"308\"><p>Top left</p></th><th colwidth=\"308\"><p>Top right</p></th></tr>\
         <tr><td colwidth=\"308\"><p>Bottom left</p></td><td colwidth=\"308\"><p>Bottom right</p></td></tr></table>\n<p>Below</p>"
    );
}

#[test]
fn merged_cells_span_columns_and_rows_and_keep_shading() {
    // 3열 격자. R0=[A gridSpan=2 + 배경, B] R1=[C vMerge restart, D, E] R2=[(vMerge 값 없음 = 이어짐), F, G]
    let body = tbl(
        &[2000, 2000, 2000],
        &[
            tr(&[tc(4000, r#"<w:gridSpan w:val="2"/><w:shd w:val="clear" w:color="auto" w:fill="FFE699"/>"#, &tcp("A")), tc(2000, "", &tcp("B"))]),
            tr(&[tc(2000, r#"<w:vMerge w:val="restart"/>"#, &tcp("C")), tc(2000, "", &tcp("D")), tc(2000, "", &tcp("E"))]),
            tr(&[tc(2000, "<w:vMerge/>", &p("")), tc(2000, "", &tcp("F")), tc(2000, "", &tcp("G"))]),
        ],
    );
    assert_eq!(
        html_of(&body),
        "<table>\
         <tr><td colspan=\"2\" colwidth=\"133,133\" style=\"background-color: #ffe699\"><p>A</p></td><td colwidth=\"133\"><p>B</p></td></tr>\
         <tr><td rowspan=\"2\" colwidth=\"133\"><p>C</p></td><td colwidth=\"133\"><p>D</p></td><td colwidth=\"133\"><p>E</p></td></tr>\
         <tr><td colwidth=\"133\"><p>F</p></td><td colwidth=\"133\"><p>G</p></td></tr></table>"
    );
}

#[test]
fn vertical_merge_continues_by_grid_column_not_by_cell_index() {
    // R0=[A (열0), B (열1)]  R1=[C gridSpan=1 (열0), D vMerge restart (열1)]... 대신: 병합 이음이 둘째 열일 때 그 열의 셀을 잇는다.
    let body = tbl(
        &[2000, 2000],
        &[
            tr(&[tc(2000, "", &tcp("A")), tc(2000, r#"<w:vMerge w:val="restart"/>"#, &tcp("B"))]),
            tr(&[tc(2000, "", &tcp("C")), tc(2000, r#"<w:vMerge w:val="continue"/>"#, &p(""))]),
            tr(&[tc(2000, "", &tcp("D")), tc(2000, "", &tcp("E"))]),
        ],
    );
    let html = html_of(&body);
    assert_eq!(html.matches("rowspan=\"2\"").count(), 1, "{html}");
    assert!(html.contains("<td rowspan=\"2\" colwidth=\"133\"><p>B</p></td>"), "{html}");
    // 두 번째 행에는 C 하나뿐, 세 번째 행에는 D, E 둘.
    let rows: Vec<&str> = html.split("<tr>").skip(1).collect();
    assert_eq!(rows.len(), 3, "{html}");
    assert_eq!(rows[1].matches("<td").count(), 1, "{html}");
    assert_eq!(rows[2].matches("<td").count(), 2, "{html}");
}

#[test]
fn a_continuation_without_an_opener_is_just_a_cell_and_legacy_hmerge_joins_the_left_cell() {
    let body = tbl(
        &[2000, 2000],
        &[tr(&[tc(2000, "<w:vMerge/>", &tcp("lonely")), tc(2000, "", &tcp("x"))]), tr(&[tc(2000, r#"<w:hMerge w:val="restart"/>"#, &tcp("L")), tc(2000, "<w:hMerge/>", &p(""))])],
    );
    let html = html_of(&body);
    assert!(html.contains("lonely"), "{html}");
    assert!(html.contains("<td colspan=\"2\""), "{html}");
    assert!(!html.contains("rowspan"), "{html}");
}

#[test]
fn header_rows_become_th_and_grid_before_pads_the_row() {
    let hdr = format!(r#"<w:tr><w:trPr><w:tblHeader/></w:trPr>{}{}</w:tr>"#, tc(2000, "", &tcp("H1")), tc(2000, r#"<w:gridSpan w:val="2"/>"#, &tcp("H2")));
    let padded = format!(
        r#"<w:tr><w:trPr><w:gridBefore w:val="2"/></w:trPr>{}</w:tr>"#,
        tc(2000, "", &tcp("late"))
    );
    let html = html_of(&tbl(&[2000, 2000, 2000], &[hdr, padded]));
    // 표시된 행의 셀은 th. 병합이 있어 첫 행 승격 규칙은 쓰이지 않는다.
    assert!(html.contains("<th colwidth=\"133\"><p>H1</p></th>"), "{html}");
    assert!(html.contains("<th colspan=\"2\""), "{html}");
    // 앞 두 칸은 빈 칸으로 채워 "late" 가 셋째 열에 선다.
    assert!(html.contains("<td colspan=\"2\" colwidth=\"133,134\"><p></p></td><td colwidth=\"133\"><p>late</p></td>"), "{html}");
}

#[test]
fn nested_tables_and_empty_cells_keep_one_paragraph() {
    let inner = tbl(&[1000], &[tr(&[tc(1000, "", &tcp("in"))])]);
    let body = tbl(&[3000, 3000], &[tr(&[tc(3000, "", &format!("{inner}{}", p(""))), tc(3000, "", "")])]);
    let html = html_of(&body);
    assert!(html.contains("<table><tr><th colwidth=\"67\"><p>in</p></th></tr></table>"), "{html}");
    // 비어 있는 셀도 문단 하나는 남는다(셀 내용은 block+).
    assert!(html.ends_with("<th colwidth=\"200\"><p></p></th></tr></table>"), "{html}");
}

#[test]
fn widths_fall_back_to_tcw_dxa_and_ignore_percent_widths() {
    let no_grid = "<w:tbl><w:tblGrid/>".to_string()
        + &tr(&[
            tc(3000, "", &tcp("a")),
            r#"<w:tc><w:tcPr><w:tcW w:w="2500" w:type="pct"/></w:tcPr>"#.to_string() + &tcp("b") + "</w:tc>",
        ])
        + "</w:tbl>";
    let html = html_of(&no_grid);
    assert!(html.contains("<th colwidth=\"200\"><p>a</p></th>"), "{html}");
    assert!(html.contains("<th><p>b</p></th>"), "{html}");
}

#[test]
fn spans_are_clamped_so_a_tiny_file_cannot_buy_a_huge_grid() {
    // 격자 열 수를 훨씬 넘는 gridSpan · 이음 행이 많아도 면적이 부풀지 않는다.
    let wide = tbl(&[2000], &[tr(&[tc(2000, r#"<w:gridSpan w:val="99999"/>"#, &tcp("x"))])]);
    let html = html_of(&wide);
    assert!(html.contains("colspan=\"200\""), "{}", &html[..120.min(html.len())]);
    let many: String = (0..300).map(|_| wide.clone()).collect();
    let started = std::time::Instant::now();
    let html = html_of(&many);
    assert_eq!(html.matches("<table>").count(), 300);
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "{:?}", started.elapsed());
    // 세로 이음이 끝없이 이어져도 rowspan 은 표 끝(= 행 수)을 넘지 않는다.
    let rows: Vec<String> = std::iter::once(tr(&[tc(2000, "", &tcp("a0")), tc(2000, r#"<w:vMerge w:val="restart"/>"#, &tcp("top"))]))
        .chain((1..=5).map(|i| tr(&[tc(2000, "", &tcp(&format!("a{i}"))), tc(2000, "<w:vMerge/>", &p(""))])))
        .collect();
    let html = html_of(&tbl(&[2000, 2000], &rows));
    assert!(html.contains("rowspan=\"6\""), "{html}");
    assert_eq!(html.matches("<tr>").count(), 6, "{html}");
    // 이을 칸이 남은 행 수를 넘어도(= 이음이 표 끝을 지나쳐도) 같다.
    let html = html_of(&tbl(&[2000, 2000], &rows[..2]));
    assert!(html.contains("rowspan=\"2\""), "{html}");
}

// ── 각주 · 미주 ───────────────────────────────────────────────────────────────

fn footnote_ref(id: u32) -> String {
    format!(r#"<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="{id}"/></w:r>"#)
}

fn note_body(tag: &str, id: i32, ty: Option<&str>, inner: &str) -> String {
    let ty = ty.map(|t| format!(r#" w:type="{t}""#)).unwrap_or_default();
    format!(r#"<w:{tag} w:id="{id}"{ty}>{inner}</w:{tag}>"#)
}

/// 각주 본문 문단: 번호 자리(`footnoteRef`) + 공백 + 글.
fn note_p(content: &str) -> String {
    p(&format!(
        r#"<w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>{content}"#
    ))
}

#[test]
fn footnotes_and_endnotes_share_one_numbering_in_reference_order() {
    let foots = [
        note_body("footnote", -1, Some("separator"), &p(r#"<w:r><w:separator/></w:r>"#)),
        note_body("footnote", 0, Some("continuationSeparator"), &p(r#"<w:r><w:continuationSeparator/></w:r>"#)),
        note_body("footnote", 1, None, &note_p(&r("first"))),
        note_body("footnote", 2, None, &note_p(&r("second"))),
        note_body("footnote", 3, None, &note_p(&r("never referenced"))),
    ]
    .concat();
    let ends = [
        note_body("endnote", 0, Some("separator"), &p(r#"<w:r><w:separator/></w:r>"#)),
        note_body("endnote", 2, None, &note_p(&r("end text"))),
    ]
    .concat();
    let body = p(&[
        r("a"),
        footnote_ref(2),
        r("b"),
        footnote_ref(1),
        r("c"),
        r#"<w:r><w:endnoteReference w:id="2"/></w:r>"#.to_string(),
    ]
    .concat());
    let html = d(&body).footnotes(&foots, &[]).endnotes(&ends).html();
    // 참조된 것만, 참조 순서대로, 각주와 미주가 한 줄 번호. 번호 자리(footnoteRef)와 앞 공백은 우리 표지로 대체된다.
    assert_eq!(
        html,
        "<p>a[1]b[2]c[3]</p>\n<h3>각주</h3>\n<p>[1] second</p>\n<p>[2] first</p>\n<p>[3] end text</p>"
    );
}

#[test]
fn links_in_notes_resolve_through_the_note_parts_own_relationships() {
    // 본문의 rId1 과 각주 파트의 rId1 은 서로 다른 주소다 — 각주 안 링크는 footnotes.xml.rels 로 푼다(mammoth-footnote-hyperlink).
    let foot = note_body(
        "footnote",
        1,
        None,
        &note_p(&format!(r#"<w:hyperlink r:id="rId1">{}</w:hyperlink>"#, r("Example"))),
    );
    let body = p(&[r("body "), format!(r#"<w:hyperlink r:id="rId1">{}</w:hyperlink>"#, r("link")), footnote_ref(1)].concat());
    let html = d(&body)
        .rel(rel_ext("rId1", "hyperlink", "https://body.example/"))
        .footnotes(&foot, &[rel_ext("rId1", "hyperlink", "http://www.example.com")])
        .html();
    assert_eq!(
        html,
        "<p>body <a href=\"https://body.example/\">link</a>[1]</p>\n<h3>각주</h3>\n<p>[1] <a href=\"http://www.example.com\">Example</a></p>"
    );
}

#[test]
fn pictures_in_notes_resolve_through_the_note_parts_relationships() {
    let foot = note_body("footnote", 1, None, &note_p(&drawing_inline("rIdN", 100_000)));
    let body = p(&[r("x"), footnote_ref(1)].concat());
    let dd = d(&body)
        .footnotes(&foot, &[rel("rIdN", "image", "media/note.png")])
        .part("word/media/note.png", png_bytes());
    let (html, parsed) = dd.parsed();
    assert_eq!(parsed.images.len(), 1);
    assert!(html.contains("<img "), "{html}");
}

#[test]
fn a_note_that_references_itself_does_not_recurse_and_unknown_ids_are_ignored() {
    let foot = note_body("footnote", 5, None, &note_p(&format!("{}{}", r("self "), footnote_ref(5))));
    let body = p(&[r("a"), footnote_ref(5), footnote_ref(99)].concat());
    let html = d(&body).footnotes(&foot, &[]).html();
    assert_eq!(html, "<p>a[1]</p>\n<h3>각주</h3>\n<p>[1] self </p>");
    // 각주 파트가 없으면 참조는 조용히 무시된다.
    assert_eq!(html_of(&p(&[r("a"), footnote_ref(1)].concat())), "<p>a</p>");
}

#[test]
fn a_note_referenced_many_times_is_read_once_and_keeps_one_number() {
    // 압축 폭탄형 증폭 방지: 참조마다 각주 본문을 새로 읽으면 각주 크기 × 참조 수만큼 HTML 이 불어난다. 같은 각주는 한 번만 읽고 같은 번호를 쓴다.
    let big = "가".repeat(200_000);
    let foots = note_body("footnote", 1, None, &note_p(&r(&big)));
    let body = p(&(0..60).map(|_| footnote_ref(1)).collect::<String>());
    let (html, parsed) = d(&body).footnotes(&foots, &[]).parsed();
    assert_eq!(parsed.footnotes.len(), 1);
    // 본문 참조 60 + 각주 목록의 머리표 1.
    assert_eq!(html.matches("[1]").count(), 61);
    assert!(!html.contains("[2]"));
    assert!(html.len() < big.len() * 3 + 1000, "html grew to {} bytes", html.len());
}

#[test]
fn footnote_and_endnote_ids_are_separate_and_each_is_numbered_once_in_reference_order() {
    // 각주 id 1 과 미주 id 1 은 서로 다른 노트다. 번호는 첫 참조 순서로 하나씩, 다시 참조하면 같은 번호.
    let foots = note_body("footnote", 1, None, &note_p(&r("foot")));
    let ends = note_body("endnote", 1, None, &note_p(&r("end")));
    let body = p(&[
        footnote_ref(1),
        r#"<w:r><w:endnoteReference w:id="1"/></w:r>"#.to_string(),
        footnote_ref(1),
        r#"<w:r><w:endnoteReference w:id="1"/></w:r>"#.to_string(),
    ]
    .concat());
    let html = d(&body).footnotes(&foots, &[]).endnotes(&ends).html();
    assert_eq!(html, "<p>[1][2][1][2]</p>\n<h3>각주</h3>\n<p>[1] foot</p>\n<p>[2] end</p>");
}

#[test]
fn a_document_with_only_footnote_content_is_not_empty_but_comments_are_dropped() {
    let body = p(&format!(
        r#"{}<w:commentRangeStart w:id="0"/>{}<w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r><w:r><w:commentReference w:id="2"/></w:r>"#,
        r("Ouch"),
        r(".")
    ));
    let (html, parsed) = d(&body).parsed();
    assert_eq!(html, "<p>Ouch.</p>");
    assert_eq!(kinds(&parsed), vec![("comment".to_string(), 2)]);
}

#[test]
fn note_paragraphs_lose_the_note_styles_indent() {
    // 각주 본문 스타일의 들여쓰기는 "각주" 목록에서 뜻이 없다(mammoth-endnotes.docx 가 이 모양이었다).
    let styles = r#"<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style>"#;
    let foot = note_body("footnote", 1, None, &note_p(&r("text")));
    let body = [pp(r#"<w:ind w:left="800"/>"#, &format!("{}{}", r("본문"), footnote_ref(1)))].concat();
    let html = d(&body).styles(styles).footnotes(&foot, &[]).html();
    // 본문 문단의 들여쓰기(2단)는 남고, 각주 문단의 것(360 → 1단)은 없다.
    assert_eq!(
        html,
        "<p data-brise-indent=\"2\" style=\"margin-left: 4em;\">본문[1]</p>
<h3>각주</h3>
<p>[1] text</p>"
    );
}

#[test]
fn structures_nested_to_the_xml_depth_cap_do_not_overflow_the_stack() {
    // 표 안의 표 40 겹(XML 깊이 상한 128 안쪽) · 글상자 안의 글상자 12 겹 — 재귀가 상한까지 내려가도 스택이 버틴다.
    let mut inner = tcp("깊은 곳");
    for _ in 0..40 {
        inner = tbl(&[3000], &[tr(&[tc(3000, "", &inner)])]);
    }
    let html = html_of(&inner);
    assert_eq!(html.matches("<table>").count(), 40);
    assert!(html.contains("깊은 곳"));

    let mut text = p(&r("상자 깊은 곳"));
    for _ in 0..12 {
        text = p(&format!(
            r#"<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="x/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>{text}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
        ));
    }
    let (html, parsed) = d(&text).parsed();
    assert_eq!(html, "<p>상자 깊은 곳</p>");
    assert_eq!(kinds(&parsed), vec![("shape".to_string(), 12)]);
}

// ── 개체: 글상자 · 도형 · 차트 · OLE · 머리말 ──────────────────────────────────

fn textbox_choice_fallback(text: &str) -> String {
    format!(
        r##"<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="2374265" cy="1403985"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>{0}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shapetype id="_x0000_t202"/><v:shape id="Text Box 2" type="#_x0000_t202" style="width:186.95pt"><v:textbox><w:txbxContent>{0}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>"##,
        p(&r(text))
    )
}

#[test]
fn a_text_box_is_listed_once_even_though_choice_and_fallback_both_hold_it() {
    // mammoth-text-box.docx: Choice(DrawingML) 와 Fallback(VML) 양쪽에 같은 글상자 — "Datum plane" 은 한 번, 도형도 한 번.
    let (html, parsed) = d(&p(&textbox_choice_fallback("Datum plane"))).parsed();
    assert_eq!(html, "<p>Datum plane</p>");
    assert_eq!(kinds(&parsed), vec![("shape".to_string(), 1)]);
}

#[test]
fn text_box_paragraphs_land_in_place_between_the_surrounding_text() {
    let body = p(&format!("{}{}{}", r("앞"), textbox_choice_fallback("상자"), r("뒤")));
    assert_eq!(html_of(&body), "<p>앞</p>\n<p>상자</p>\n<p>뒤</p>");
}

#[test]
fn a_vml_only_text_box_and_a_grouped_shape_give_up_the_shape_but_keep_text_and_pictures() {
    let vml = format!(
        r#"<w:r><w:pict><v:rect style="width:10pt"><v:textbox><w:txbxContent>{}</w:txbxContent></v:textbox></v:rect></w:pict></w:r>"#,
        p(&r("옛 글상자"))
    );
    let group = format!(
        r#"<w:r><w:drawing><wp:inline><wp:extent cx="100000" cy="100000"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wps:wsp><wps:txbx><w:txbxContent>{}</w:txbxContent></wps:txbx></wps:wsp><pic:pic><pic:blipFill><a:blip r:embed="rIdA"/></pic:blipFill></pic:pic></wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
        p(&r("묶음 글"))
    );
    let (html, parsed) = d(&[p(&vml), p(&group)].concat()).image("rIdA", "image1.png", png_bytes()).parsed();
    assert_eq!(html, ["<p>옛 글상자</p>".to_string(), img_tag(0, "image1.png", None), "<p>묶음 글</p>".to_string()].join("\n"));
    assert_eq!(kinds(&parsed), vec![("shape".to_string(), 2)]);
}

#[test]
fn charts_ole_objects_and_headers_are_counted_not_silently_lost() {
    let chart = r#"<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="x" r:id="rIdC"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#;
    let ole = r#"<w:r><w:object><v:shape><v:imagedata r:id="rIdA"/></v:shape><o:OLEObject r:id="rIdO"/></w:object></w:r>"#;
    let body = [p(&format!("{}{}", r("차트 "), chart)), p(&format!("{}{}", r("개체 "), ole)), p(chart)].concat();
    let mut dd = d(&body).image("rIdA", "image1.png", png_bytes());
    dd.document = dd.document.replace(
        "<w:sectPr>",
        r#"<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:headerReference w:type="first" r:id="rIdH2"/><w:footerReference w:type="default" r:id="rIdF"/>"#,
    );
    let (html, parsed) = dd.parsed();
    // 차트만 있는 문단은 빈 `<p>` 를 남기지 않는다. OLE 의 미리보기 그림은 가져오지 않는다.
    assert_eq!(html, "<p>차트 </p>\n<p>개체 </p>");
    assert_eq!(
        kinds(&parsed),
        vec![("chart".to_string(), 2), ("header_footer".to_string(), 3), ("ole".to_string(), 1)]
    );
}

// ── 거절 ──────────────────────────────────────────────────────────────────────

#[test]
fn encrypted_and_legacy_containers_are_rejected_before_unzipping() {
    // 암호화된 docx(와 옛 .doc)는 zip 이 아니라 OLE 복합 문서 — 머리 8바이트로 알아본다.
    let mut f = tempfile::NamedTempFile::with_suffix(".docx").unwrap();
    f.write_all(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).unwrap();
    f.write_all(&vec![0u8; 512]).unwrap();
    assert!(validation_message(&f).contains("encrypted"));
}

#[test]
fn non_zip_missing_main_part_and_foreign_roots_are_validation() {
    let mut junk = tempfile::NamedTempFile::with_suffix(".docx").unwrap();
    junk.write_all(b"this is not a zip archive at all").unwrap();
    assert!(validation_message(&junk).contains("zip"));
    let tiny = tempfile::NamedTempFile::with_suffix(".docx").unwrap();
    assert!(validation_message(&tiny).contains("zip"));

    let no_main = raw_docx(&[("word/styles.xml", wrap("styles", "").as_bytes())]);
    assert!(validation_message(&no_main).contains("main document"));
    // 확장자만 .docx 인 엑셀 파일 — 본문 파트의 뿌리가 document 가 아니다.
    let sheet = raw_docx(&[
        ("_rels/.rels", rels_xml(&[rel("rId1", "officeDocument", "xl/workbook.xml")]).as_bytes()),
        ("xl/workbook.xml", br#"<workbook xmlns="x"><sheets/></workbook>"#),
    ]);
    assert!(validation_message(&sheet).contains("wordprocessing"));
    let no_body = raw_docx(&[("word/document.xml", wrap("document", "").as_bytes())]);
    assert!(validation_message(&no_body).contains("no body"));
}

#[test]
fn broken_xml_and_doctype_are_validation_not_a_panic() {
    let ns = NS;
    for bad in [
        format!("<w:document {ns}><w:body><w:p></w:body></w:document>"), // 닫는 태그 불일치
        format!("<w:document {ns}><w:body><w:p>"),                       // 닫히지 않음
        "not xml at all <<<".to_string(),
        String::new(),
        format!(r#"<w:document {ns}><w:body><w:p w:a="1" w:a="2"/></w:body></w:document>"#), // 중복 속성
        // DOCTYPE 은 워드가 쓰지 않는다 — 엔티티 선언이 있든 없든 거절한다.
        format!(r#"<!DOCTYPE w:document [<!ENTITY x "y">]><w:document {ns}><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>"#),
        format!(r#"<!DOCTYPE w:document><w:document {ns}><w:body><w:p><w:r><w:t>a</w:t></w:r></w:p></w:body></w:document>"#),
    ] {
        let f = raw_docx(&[("word/document.xml", bad.as_bytes())]);
        assert!(matches!(parse_file(f.path()), Err(AppError::Validation(_))), "{bad:?}");
    }
    let f = raw_docx(&[("word/document.xml", b"<w:document><w:body><w:p/></w:body></w:document>")]);
    assert!(parse_file(f.path()).is_err(), "빈 문서는 가져올 내용이 없다");
    let doctype = format!(r#"<!DOCTYPE w:document><w:document {NS}><w:body/></w:document>"#);
    let f = raw_docx(&[("word/document.xml", doctype.as_bytes())]);
    assert!(validation_message(&f).contains("DOCTYPE"));
    // 스타일 파트가 깨진 것도 마찬가지.
    let f = d(&p(&r("x"))).part("word/styles.xml", b"<w:styles><oops".to_vec()).rel(rel("rIdSt", "styles", "styles.xml")).file();
    assert!(matches!(parse_file(f.path()), Err(AppError::Validation(_))));
}

#[test]
fn empty_documents_and_dropped_only_documents_are_validation() {
    assert!(validation_message(&docx("")).contains("no importable content"));
    assert!(validation_message(&docx(&[p(""), p("")].concat())).contains("no importable content"));
    let chart_only = r#"<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="x/chart"/></a:graphic></wp:inline></w:drawing></w:r>"#;
    assert!(validation_message(&docx(&p(chart_only))).contains("no importable content"));
}

#[test]
fn nesting_beyond_the_depth_cap_is_validation() {
    use super::super::xml::MAX_XML_DEPTH;
    let deep = format!("{}{}", "<w:x>".repeat(MAX_XML_DEPTH + 10), "</w:x>".repeat(MAX_XML_DEPTH + 10));
    let f = d(&deep).file();
    assert!(validation_message(&f).contains("too deep"));
}

#[test]
fn decompression_budget_is_enforced() {
    // 압축이 잘 되는 반복 바이트라 아카이브는 작지만 풀면 예산을 넘는다(zip bomb).
    let mut huge = Vec::with_capacity(MAX_DECOMPRESSED_BYTES as usize + 1024);
    huge.extend_from_slice(format!("<w:document {NS}><w:body><w:p><w:r><w:t>").as_bytes());
    huge.resize(MAX_DECOMPRESSED_BYTES as usize + 512, b'A');
    huge.extend_from_slice(b"</w:t></w:r></w:p></w:body></w:document>");
    let f = raw_docx(&[("word/document.xml", &huge)]);
    assert!(validation_message(&f).contains("exceeds"));
}

#[test]
fn absurd_numbers_never_overflow() {
    // 1) 글자 크기 u32::MAX · 음수. 2) 그림 크기 i64::MAX 가 본문에서도 폭 i64::MAX 인 셀 안에서도. 3) 쪽 폭·여백 극값.
    let huge = i64::MAX.to_string();
    let body = [
        p(&rp(r#"<w:sz w:val="4294967295"/>"#, "본문 본문")),
        p(&drawing_inline("rIdA", i64::MAX)),
        tbl(&[i64::MAX / 2], &[tr(&[tc(i64::MAX / 2, "", &p(&drawing_inline("rIdA", i64::MAX)))])]),
        tbl(&[400_000_000_000, 400_000_000_000], &[
            tr(&[tc(400_000_000_000, "", &tcp("a")), tc(400_000_000_000, "", &tcp("b"))]),
            tr(&[tc(800_000_000_000, r#"<w:gridSpan w:val="2"/>"#, &tcp("c"))]),
        ]),
    ]
    .concat();
    let html = d(&body).image("rIdA", "image1.png", png_bytes()).html();
    assert!(html.contains("width: 100%") && html.contains("colspan=\"2\""), "{html}");

    for (w, l, rr) in [(huge.as_str(), "-9223372036854775808", "0"), ("0", "-9223372036854775808", "-9223372036854775808"), ("-9223372036854775808", "0", "0"), (huge.as_str(), huge.as_str(), huge.as_str())] {
        let sect = format!(r#"<w:sectPr><w:pgSz w:w="{w}" w:h="1"/><w:pgMar w:left="{l}" w:right="{rr}"/></w:sectPr>"#);
        let mut dd = d(&p(&r("본문")));
        dd.document = dd.document.replace(SECT, &sect);
        assert_eq!(dd.html(), "<p>본문</p>", "{w} {l} {rr}");
    }
}

#[test]
fn a_paragraph_of_thousands_of_leading_line_breaks_is_linear() {
    let body = p(&format!("{}{}", "<w:r><w:br/></w:r>".repeat(60_000), r("끝")));
    let started = std::time::Instant::now();
    assert_eq!(html_of(&body), "<p>끝</p>");
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
}

// ── 실제 워드 저장본 ──────────────────────────────────────────────────────────

fn tally(blocks: &[Block]) -> (usize, usize, usize) {
    let (mut paras, mut tables, mut images) = (0, 0, 0);
    for b in blocks {
        match b {
            Block::Para(_) => paras += 1,
            Block::Image(_) => images += 1,
            Block::Table(t) => {
                tables += 1;
                for c in t.rows.iter().flatten() {
                    let (p, t2, i) = tally(&c.blocks);
                    paras += p;
                    tables += t2;
                    images += i;
                }
            }
        }
    }
    (paras, tables, images)
}

/// 실제 워드 저장본(mammoth.js 테스트 데이터 13개 · python-docx 테스트 파일 3개)을 폴더째 읽는다 —
/// `BRISE_DOCX_SAMPLES=<폴더> cargo test --lib real_word_files -- --ignored --nocapture`. 폴더가 없으면 건너뛴다.
#[test]
#[ignore = "실제 파일 16개가 든 폴더(BRISE_DOCX_SAMPLES)가 있어야 한다"]
fn real_word_files_parse_and_report() {
    let Ok(dir) = std::env::var("BRISE_DOCX_SAMPLES") else {
        eprintln!("BRISE_DOCX_SAMPLES 가 없어 건너뜀");
        return;
    };
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "docx"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "{dir} 에 docx 가 없다");
    let mut ok = 0;
    // 파일 이름 → (HTML, dropped, 저장된 그림 수). 아래에서 몇 가지 사실을 단언한다 — 출력만 하면 퇴행을 못 잡는다.
    let mut seen: std::collections::HashMap<String, Result<(String, Vec<(String, u32)>, usize), String>> =
        std::collections::HashMap::new();
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        match parse_file(path) {
            Ok(parsed) => {
                ok += 1;
                let (paras, tables, images) = tally(&parsed.blocks);
                let atts: Vec<SavedImage> = parsed
                    .images
                    .iter()
                    .enumerate()
                    .map(|(i, im)| SavedImage { rel_path: format!("n/{i}-{}", im.name), name: im.name.clone() })
                    .collect();
                let html = parsed.render(&atts);
                println!(
                    "{name}: paragraphs={paras} tables={tables} img_blocks={images} stored_images={} footnotes={} dropped={:?}\n    {}",
                    parsed.images.len(),
                    parsed.footnotes.len(),
                    kinds(&parsed),
                    html.replace('\n', " ⏎ ").chars().take(200).collect::<String>()
                );
                seen.insert(name, Ok((html, kinds(&parsed), parsed.images.len())));
            }
            Err(e) => {
                println!("{name}: ERR {e:?}");
                seen.insert(name, Err(format!("{e:?}")));
            }
        }
    }
    let ok_of = |n: &str| match seen.get(n) {
        Some(Ok(v)) => Some(v),
        _ => None,
    };
    // 이 파일들이 폴더에 있을 때만(일부만 있어도 있는 것만) 본다.
    if let Some((_, dropped, _)) = ok_of("mammoth-comments.docx") {
        assert_eq!(dropped, &vec![("comment".to_string(), 2)]);
    }
    if let Some((html, dropped, _)) = ok_of("mammoth-text-box.docx") {
        assert_eq!(html.matches("Datum plane").count(), 1, "{html}");
        assert_eq!(dropped, &vec![("shape".to_string(), 1)]);
    }
    if let Some((html, _, _)) = ok_of("mammoth-footnote-hyperlink.docx") {
        assert!(html.contains("<a href=\"http://www.example.com\">Example</a>"), "{html}");
    }
    if let Some((html, dropped, stored)) = ok_of("pydocx-having-images.docx") {
        assert_eq!(*stored, 3);
        assert_eq!(html.matches("<img ").count(), 5);
        assert_eq!(dropped, &vec![("header_footer".to_string(), 1)]);
    }
    if let Some((html, _, _)) = ok_of("mammoth-tables.docx") {
        assert_eq!(html.matches("<table>").count(), 1, "{html}");
        assert!(html.contains("<th colwidth=\"308\"><p>Top left</p></th>"), "{html}");
    }
    if let Some((html, _, _)) = ok_of("mammoth-strict-format.docx") {
        assert_eq!(html, "<p>Test</p>");
    }
    if let Some((html, _, _)) = ok_of("mammoth-simple-list.docx") {
        assert_eq!(html, "<ul><li><p>Apple</p></li><li><p>Banana</p></li></ul>");
    }
    if let Some((html, _, _)) = ok_of("pydocx-test.docx") {
        assert!(html.starts_with("<h1>python-docx was here!</h1>"), "{html}");
    }
    // 그림이 외부에만 있는 문서는 가져올 내용이 없다(VALIDATION).
    if let Some(r) = seen.get("mammoth-external-picture.docx") {
        assert!(r.as_ref().err().is_some_and(|e| e.contains("no importable content")), "{r:?}");
    }
    println!("{ok}/{} 파일이 가져와졌다", files.len());
}
