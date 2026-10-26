// 구조 검사기 — ECMA-376 의 자식 요소 순서(`xsd:sequence`)와 OPC 패키지 정합성. Word 는 순서가 어긋나거나 참조가 끊기면 "읽을 수 없는 내용"으로 본다.
use super::*;

const PPR: &[&str] = &[
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs",
    "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
    "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment",
    "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange",
];
const RPR: &[&str] = &[
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
    "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath",
];
const TCPR: &[&str] = &["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark"];
const TBLPR: &[&str] = &[
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd",
    "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook",
];
const SECTPR: &[&str] = &[
    "headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType",
    "cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings",
];
const PBDR: &[&str] = &["top", "left", "bottom", "right", "between", "bar"];
const BORDERS: &[&str] = &["top", "left", "bottom", "right", "insideH", "insideV"];
const CELL_MAR: &[&str] = &["top", "left", "bottom", "right"];
const LVL: &[&str] = &["start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr"];
const STYLE: &[&str] = &[
    "name", "aliases", "basedOn", "next", "link", "autoRedefine", "hidden", "uiPriority", "semiHidden", "unhideWhenUsed", "qFormat", "locked",
    "personal", "personalCompose", "personalReply", "rsid", "pPr", "rPr", "tblPr", "trPr", "tcPr", "tblStylePr",
];
const ABSTRACT_NUM: &[&str] = &["nsid", "multiLevelType", "tmpl", "name", "styleLink", "numStyleLink", "lvl"];
const TBL: &[&str] = &["tblPr", "tblGrid", "tr"];
const INLINE: &[&str] = &["extent", "effectExtent", "docPr", "cNvGraphicFramePr", "graphic"];

fn order_of(parent: &str) -> Option<&'static [&'static str]> {
    Some(match parent {
        "pPr" => PPR,
        "rPr" => RPR,
        "tcPr" => TCPR,
        "tblPr" => TBLPR,
        "sectPr" => SECTPR,
        "pBdr" => PBDR,
        "tblBorders" => BORDERS,
        "tblCellMar" => CELL_MAR,
        "lvl" => LVL,
        "style" => STYLE,
        "abstractNum" => ABSTRACT_NUM,
        "tbl" => TBL,
        "inline" => INLINE,
        _ => return None,
    })
}

#[derive(Default)]
struct Frame {
    name: String,
    children: usize,
    last_idx: usize,
    last_child: String,
    prev_child: String,
}

#[derive(Default)]
struct Tbl {
    grid_cols: usize,
    row_sum: usize,
    col: usize,
    tc_span: usize,
    /// None = 병합 없음 · Some(true) = 시작 · Some(false) = 이어짐.
    tc_merge: Option<bool>,
    merging: Vec<bool>,
    rows: usize,
}

/// `word/document.xml` 같은 XML 의 구조를 검사한다 — 위 순서 표 + 표 격자(모든 행이 모든 열을 덮음) + 칸이 문단으로 끝남 + 본문이 문단 →
/// sectPr 로 끝남 + 세로 병합 이어짐이 같은 열의 시작 칸 아래에 있음.
pub(super) fn check_structure(xml: &str) {
    let mut stack: Vec<Frame> = Vec::new();
    let mut tables: Vec<Tbl> = Vec::new();
    scan(xml, |ev| match ev {
        Ev::Start(name, attrs) => {
            let val = attrs.iter().find(|(k, _)| k == "val").map(|(_, v)| v.as_str());
            if let Some(parent) = stack.last_mut() {
                if let Some(order) = order_of(&parent.name) {
                    let idx = order.iter().position(|x| *x == name).unwrap_or_else(|| panic!("<{name}> is not allowed in <{}>", parent.name));
                    assert!(idx >= parent.last_idx, "<{name}> is out of order in <{}> (after <{}>)", parent.name, parent.last_child);
                    parent.last_idx = idx;
                }
                // pPr/rPr/tcPr/trPr 는 첫 자식이어야 한다.
                let first_only = matches!((parent.name.as_str(), name), ("p", "pPr") | ("r", "rPr") | ("tc", "tcPr") | ("tr", "trPr"));
                assert!(!first_only || parent.children == 0, "<{name}> must be the first child of <{}>", parent.name);
                parent.children += 1;
                parent.prev_child = std::mem::replace(&mut parent.last_child, name.to_string());
            }
            match name {
                "tbl" => tables.push(Tbl::default()),
                "gridCol" => tables.last_mut().unwrap().grid_cols += 1,
                "tr" => {
                    let t = tables.last_mut().unwrap();
                    t.row_sum = 0;
                    t.col = 0;
                    t.rows += 1;
                }
                "tc" => {
                    let t = tables.last_mut().unwrap();
                    t.tc_span = 1;
                    t.tc_merge = None;
                }
                "gridSpan" => tables.last_mut().unwrap().tc_span = val.unwrap().parse().unwrap(),
                "vMerge" => tables.last_mut().unwrap().tc_merge = Some(val == Some("restart")),
                _ => {}
            }
            stack.push(Frame { name: name.to_string(), ..Frame::default() });
        }
        Ev::End(name) => {
            let f = stack.pop().unwrap();
            match name {
                "tc" => {
                    assert_eq!(f.last_child, "p", "a cell must end with a paragraph");
                    let t = tables.last_mut().unwrap();
                    let (start, span) = (t.col, t.tc_span);
                    if t.merging.len() < start + span {
                        t.merging.resize(start + span, false);
                    }
                    match t.tc_merge {
                        Some(false) => assert!(t.merging[start..start + span].iter().all(|m| *m), "vMerge continue at column {start} has no restart above"),
                        Some(true) => t.merging[start..start + span].fill(true),
                        None => t.merging[start..start + span].fill(false),
                    }
                    t.col += span;
                    t.row_sum += span;
                }
                "tr" => {
                    let t = tables.last().unwrap();
                    assert_eq!(t.row_sum, t.grid_cols, "every row must cover the whole grid");
                }
                "tbl" => {
                    let t = tables.pop().unwrap();
                    assert!(t.rows > 0 && t.grid_cols > 0);
                }
                "body" => {
                    assert_eq!(f.last_child, "sectPr", "sectPr must be the last child of body");
                    assert_eq!(f.prev_child, "p", "the body must end with a paragraph before sectPr");
                }
                _ => {}
            }
        }
    });
}

/// 패키지 전체의 정합성 — 콘텐츠 타입 · 관계 · 참조 · id 유일 · 번호 · 스타일 · 본문 구조.
pub(super) fn assert_docx_consistent(bytes: &[u8]) {
    let ents = entries(bytes);
    let names: Vec<&str> = ents.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names[0], "[Content_Types].xml");
    // 모든 XML 부품이 끝까지 읽히고 불법 글자가 없다.
    for (n, v) in &ents {
        if n.ends_with(".xml") || n.ends_with(".rels") {
            let s = std::str::from_utf8(v).unwrap();
            assert!(s.chars().all(is_xml_char), "{n} has XML-illegal chars");
            scan(s, |_| {});
        }
    }
    // 콘텐츠 타입: 모든 파트가 Default(확장자) 나 Override 로 덮이고, 모든 Override 는 실제 파트다.
    let (mut defaults, mut overrides) = (Vec::new(), Vec::new());
    walk(&part(bytes, "[Content_Types].xml"), |n, a| {
        let get = |k: &str| a.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
        match n {
            "Default" => defaults.push(get("Extension").unwrap().to_ascii_lowercase()),
            "Override" => overrides.push(get("PartName").unwrap()),
            _ => {}
        }
    });
    for n in names.iter().skip(1) {
        let ext = n.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        assert!(overrides.contains(&format!("/{n}")) || defaults.contains(&ext), "{n} has no content type");
    }
    for o in &overrides {
        assert!(names.contains(&o.trim_start_matches('/')), "override {o} has no part");
    }
    // 관계: 모든 내부 대상이 있다. 문서 관계의 id 를 모은다.
    let mut doc_rel_ids: Vec<String> = Vec::new();
    for (n, v) in &ents {
        if !n.ends_with(".rels") {
            continue;
        }
        let base = n.rsplit_once("_rels/").map_or("", |(dir, _)| dir).to_string();
        walk(std::str::from_utf8(v).unwrap(), |name, a| {
            if name != "Relationship" {
                return;
            }
            let get = |k: &str| a.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
            if n == "word/_rels/document.xml.rels" {
                doc_rel_ids.push(get("Id").unwrap());
            }
            if get("TargetMode").as_deref() == Some("External") {
                return;
            }
            let target = get("Target").unwrap();
            let full = target.strip_prefix('/').map_or_else(|| format!("{base}{target}"), str::to_string);
            assert!(names.contains(&full.as_str()), "relationship target {full} (from {n}) is missing");
        });
    }
    let doc = part(bytes, "word/document.xml");
    // r:id(하이퍼링크) · r:embed(그림) 이 문서 관계에 있다.
    for v in attr_vals(&doc, "hyperlink", "id").into_iter().chain(attr_vals(&doc, "blip", "embed")) {
        assert!(doc_rel_ids.contains(&v), "{v} is not a document relationship");
    }
    // docPr id 는 유일하고 1 이상.
    let ids: Vec<u32> = attr_vals(&doc, "docPr", "id").iter().map(|v| v.parse().unwrap()).collect();
    let mut uniq = ids.clone();
    uniq.sort_unstable();
    uniq.dedup();
    assert_eq!(uniq.len(), ids.len(), "docPr ids must be unique: {ids:?}");
    assert!(ids.iter().all(|i| *i >= 1));
    // 스타일 참조.
    let styles = part(bytes, "word/styles.xml");
    let style_ids = attr_vals(&styles, "style", "styleId");
    for k in ["pStyle", "rStyle", "tblStyle"] {
        for v in attr_vals(&doc, k, "val") {
            assert!(style_ids.contains(&v), "{k} {v} is not defined in styles.xml");
        }
    }
    // 번호: numId 참조가 w:num 에 있고(0 = 번호 없음이라 쓰지 않는다), 각 w:num 이 abstractNum 을 가리키며, abstractNum 이 모든 w:num 앞에 온다.
    let numbering = part(bytes, "word/numbering.xml");
    let num_ids = attr_vals(&numbering, "num", "numId");
    let abstract_ids = attr_vals(&numbering, "abstractNum", "abstractNumId");
    for v in attr_vals(&doc, "numId", "val") {
        assert!(v != "0" && num_ids.contains(&v), "numId {v} is not defined in numbering.xml");
    }
    for v in attr_vals(&numbering, "abstractNumId", "val") {
        assert!(abstract_ids.contains(&v), "abstractNumId {v}");
    }
    let (mut last_abstract, mut first_num, mut seq) = (0usize, usize::MAX, 0usize);
    walk(&numbering, |n, _| {
        seq += 1;
        if n == "abstractNum" {
            last_abstract = seq;
        }
        if n == "num" && first_num == usize::MAX {
            first_num = seq;
        }
    });
    assert!(first_num == usize::MAX || last_abstract < first_num, "every abstractNum must precede every num");
    // 구조(순서 · 표 · 칸 끝 · 본문 끝). 스타일·번호 정의도 같은 순서 표를 지난다.
    check_structure(&doc);
    check_structure(&styles);
    check_structure(&numbering);
    // 설정: 호환 모드 15 (없으면 Word 가 호환 모드 배너를 띄운다).
    let settings = part(bytes, "word/settings.xml");
    assert!(settings.contains(r#"w:name="compatibilityMode""#) && settings.contains(r#"w:val="15""#));
}

// ── 테스트 ────────────────────────────────────────────────────────────────────

#[test]
fn real_prosemirror_dump_produces_a_consistent_package() {
    let b = real_build();
    assert_eq!((b.image_count, b.skipped_images), (1, 0));
    assert_docx_consistent(&b.bytes);
    let names: Vec<String> = entries(&b.bytes).into_iter().map(|(n, _)| n).collect();
    for need in [
        "[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "word/numbering.xml",
        "word/settings.xml", "word/media/image1.png", "docProps/core.xml", "docProps/app.xml",
    ] {
        assert!(names.iter().any(|n| n == need), "{need} missing from {names:?}");
    }
    // 그림 바이트는 그대로.
    let png = entries(&b.bytes).into_iter().find(|(n, _)| n == "word/media/image1.png").unwrap().1;
    assert_eq!(png, png_bytes());
    let rels = part(&b.bytes, "word/_rels/document.xml.rels");
    assert!(rels.contains(r#"Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png""#), "{rels}");
    let core = part(&b.bytes, "docProps/core.xml");
    assert!(core.contains("<dc:title>제목</dc:title>") && core.contains(r#"xsi:type="dcterms:W3CDTF""#), "{core}");
    assert!(part(&b.bytes, "_rels/.rels").contains(r#"Target="word/document.xml""#));
}

#[test]
fn checker_rejects_out_of_order_children_and_broken_tables() {
    let ns = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;
    let ok = format!(r#"<w:body {ns}><w:p><w:pPr><w:ind w:left="1"/><w:jc w:val="left"/></w:pPr></w:p><w:sectPr/></w:body>"#);
    check_structure(&ok);
    // 검사기가 비어 있지 않은지: 순서 위반 · 문단으로 안 끝나는 칸 · 격자를 못 덮는 행 · 시작 없는 이어짐 칸 · 본문이 표로 끝남.
    for bad in [
        format!(r#"<w:body {ns}><w:p><w:pPr><w:jc w:val="left"/><w:ind w:left="1"/></w:pPr></w:p><w:sectPr/></w:body>"#),
        format!(r#"<w:body {ns}><w:p><w:r><w:rPr><w:b/><w:rFonts/></w:rPr></w:r></w:p><w:sectPr/></w:body>"#),
        format!(r#"<w:tbl {ns}><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>"#),
        format!(r#"<w:tbl {ns}><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>"#),
        format!(r#"<w:tbl {ns}><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>"#),
        format!(r#"<w:body {ns}><w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr/></w:body>"#),
    ] {
        assert!(std::panic::catch_unwind(|| check_structure(&bad)).is_err(), "must reject: {bad}");
    }
}

#[test]
fn landscape_swaps_the_page_size_and_sets_the_orientation() {
    let portrait = document(&build_doc(vec![p("x")]));
    assert!(portrait.contains(r#"<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440""#), "{portrait}");
    assert!(!portrait.contains("orient"));
    let l = build("t", &[sec("s", vec![p("x")])], Paper::A4Landscape, &no_images).unwrap();
    let landscape = document(&l);
    assert!(landscape.contains(r#"<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>"#), "{landscape}");
    assert_docx_consistent(&l.bytes);
    assert!(landscape.ends_with("</w:sectPr></w:body></w:document>"));
}

#[test]
fn paper_size_and_margin_presets_reach_the_sectpr() {
    let setup = |paper: &str, margin: &str| {
        let b = build("t", &[sec("s", vec![p("x")])], Paper::parse(paper, margin).unwrap(), &no_images).unwrap();
        assert_docx_consistent(&b.bytes);
        document(&b)
    };
    let letter = setup("letter-portrait", "narrow");
    assert!(letter.contains(r#"<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720""#), "{letter}");
    let b5 = setup("b5-landscape", "wide");
    assert!(b5.contains(r#"<w:pgSz w:w="14570" w:h="10318" w:orient="landscape"/><w:pgMar w:top="1440" w:right="2880" w:bottom="1440" w:left="2880""#), "{b5}");
}

#[test]
fn empty_document_still_has_a_paragraph_before_sectpr() {
    let b = build("t", &[sec("s", vec![])], Paper::A4Portrait, &no_images).unwrap();
    assert_docx_consistent(&b.bytes);
    assert_eq!(count(&document(&b), "p"), 1);
    // 표만 있는 문서(그 표가 비어 아무것도 안 나와도)도 마찬가지.
    let only_empty_table = build_doc(vec![json!({ "type": "table", "content": [{ "type": "tableRow", "content": [] }] })]);
    assert_docx_consistent(&only_empty_table.bytes);
}
