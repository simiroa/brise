// repo: doc_import::docx 테스트 ① — 픽스처 + 서식 · 스타일 · 정렬 · 목록 · 링크/필드 · 변경 추적
//
// 픽스처는 워드가 저장한 docx 의 모양을 흉내 낸다: `[Content_Types].xml` · `_rels/.rels`(officeDocument) · `word/document.xml` ·
// `word/_rels/document.xml.rels`(styles · numbering · footnotes · image · hyperlink) · 본문 끝 `w:sectPr`.
// 요소·속성 이름의 근거는 `docx.rs` 머리 주석(ECMA-376 + 실제 워드 저장본).
use super::super::hwpx::tests::png_bytes;
use super::super::SavedImage;
use super::*;
use crate::repo::extraction::test_support::build_zip;

pub(super) const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math""#;
pub(super) const SECT: &str = r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>"#;
pub(super) const RT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/// A4 본문 폭(9026 twips)의 EMU — 폭 % 계산의 기준.
pub(super) const BODY_EMU: i64 = 9026 * 635;

pub(super) fn p(inner: &str) -> String {
    format!("<w:p>{inner}</w:p>")
}

/// 글 한 조각(앞뒤 공백 보존).
pub(super) fn r(text: &str) -> String {
    format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

pub(super) fn rp(rpr: &str, text: &str) -> String {
    format!(r#"<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

pub(super) fn pp(ppr: &str, inner: &str) -> String {
    format!("<w:p><w:pPr>{ppr}</w:pPr>{inner}</w:p>")
}

pub(super) fn rel(id: &str, ty: &str, target: &str) -> String {
    format!(r#"<Relationship Id="{id}" Type="{RT}/{ty}" Target="{target}"/>"#)
}

pub(super) fn rel_ext(id: &str, ty: &str, target: &str) -> String {
    format!(r#"<Relationship Id="{id}" Type="{RT}/{ty}" Target="{target}" TargetMode="External"/>"#)
}

pub(super) fn rels_xml(rels: &[String]) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#,
        rels.concat()
    )
}

pub(super) fn wrap(root: &str, inner: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:{root} {NS}>{inner}</w:{root}>"#)
}

/// `wp:inline` 그림 한 장(관계 `rid`, 가로 `cx` EMU).
pub(super) fn drawing_inline(rid: &str, cx: i64) -> String {
    format!(
        r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="95250"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="95250"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
    )
}

/// 만들 docx 의 설계도.
#[derive(Clone)]
pub(super) struct D {
    pub(super) document: String,
    pub(super) rels: Vec<String>,
    pub(super) parts: Vec<(String, Vec<u8>)>,
}

pub(super) fn d(body: &str) -> D {
    D { document: wrap("document", &format!("<w:body>{body}{SECT}</w:body>")), rels: Vec::new(), parts: Vec::new() }
}

impl D {
    pub(super) fn rel(mut self, r: String) -> D {
        self.rels.push(r);
        self
    }

    pub(super) fn part(mut self, name: &str, bytes: Vec<u8>) -> D {
        self.parts.push((name.to_string(), bytes));
        self
    }

    pub(super) fn styles(self, inner: &str) -> D {
        self.rel(rel("rIdSt", "styles", "styles.xml")).part("word/styles.xml", wrap("styles", inner).into_bytes())
    }

    pub(super) fn numbering(self, inner: &str) -> D {
        self.rel(rel("rIdNu", "numbering", "numbering.xml"))
            .part("word/numbering.xml", wrap("numbering", inner).into_bytes())
    }

    /// 각주 파트(+ 그 파트 자신의 관계).
    pub(super) fn footnotes(self, inner: &str, own_rels: &[String]) -> D {
        let mut d = self
            .rel(rel("rIdFn", "footnotes", "footnotes.xml"))
            .part("word/footnotes.xml", wrap("footnotes", inner).into_bytes());
        if !own_rels.is_empty() {
            d = d.part("word/_rels/footnotes.xml.rels", rels_xml(own_rels).into_bytes());
        }
        d
    }

    pub(super) fn endnotes(self, inner: &str) -> D {
        self.rel(rel("rIdEn", "endnotes", "endnotes.xml")).part("word/endnotes.xml", wrap("endnotes", inner).into_bytes())
    }

    /// 그림 한 장: 관계 `rid` → `word/media/{name}`.
    pub(super) fn image(self, rid: &str, name: &str, bytes: Vec<u8>) -> D {
        self.rel(rel(rid, "image", &format!("media/{name}"))).part(&format!("word/media/{name}"), bytes)
    }

    pub(super) fn file(&self) -> tempfile::NamedTempFile {
        let mut owned: Vec<(String, Vec<u8>)> = vec![
            (
                "[Content_Types].xml".to_string(),
                br#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#.to_vec(),
            ),
            ("_rels/.rels".to_string(), rels_xml(&[rel("rId1", "officeDocument", "word/document.xml")]).into_bytes()),
            ("word/document.xml".to_string(), self.document.clone().into_bytes()),
            ("word/_rels/document.xml.rels".to_string(), rels_xml(&self.rels).into_bytes()),
        ];
        owned.extend(self.parts.iter().cloned());
        let refs: Vec<(&str, &[u8])> = owned.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        build_zip(".docx", &refs)
    }

    pub(super) fn html(&self) -> String {
        parse_render(&self.file()).unwrap().0
    }

    pub(super) fn parsed(&self) -> (String, Parsed) {
        parse_render(&self.file()).unwrap()
    }
}

/// 다른 파일의 테스트(`import()` 흐름)가 쓰는 입구 — 그림 한 장(본문 폭의 절반)이 든 docx.
pub(crate) fn picture_docx() -> tempfile::NamedTempFile {
    d(&p(&format!("{}{}", r("본문"), drawing_inline("rIdPic", BODY_EMU / 2))))
        .image("rIdPic", "image1.png", png_bytes())
        .file()
}

/// 파일 이름 안의 `?` · `#` · `%` · 공백은 관계 Target 에서 퍼센트 인코딩으로 온다(OPC 파트 이름은 URI).
fn pct_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '%' => "%25".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            ' ' => "%20".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// 같은 모양인데 그림 엔트리(`word/media/{name}`) 이름만 다른 docx — 위험한 파일명이 첨부로 새지 않는지 본다.
pub(crate) fn picture_docx_named(name: &str) -> tempfile::NamedTempFile {
    // 관계 Target 은 XML 속성이라 인코딩한 뒤 이스케이프하고, 엔트리 이름(zip)은 그대로 둔다.
    let target = pct_encode(name).replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    d(&p(&drawing_inline("rIdPic", BODY_EMU / 2)))
        .rel(rel("rIdPic", "image", &format!("media/{target}")))
        .part(&format!("word/media/{name}"), png_bytes())
        .file()
}

/// 글 한 문단짜리 docx.
pub(crate) fn text_docx(text: &str) -> tempfile::NamedTempFile {
    d(&p(&r(text))).file()
}

/// 본문(document.xml)이 깨져 거절되는, 그림이 든 docx — 거절 때 첨부가 남지 않는지 본다.
pub(crate) fn broken_docx_with_picture() -> tempfile::NamedTempFile {
    let mut dd = d("").image("rIdPic", "image1.png", png_bytes());
    dd.document = "<w:document".to_string();
    dd.file()
}

pub(super) fn docx(body: &str) -> tempfile::NamedTempFile {
    d(body).file()
}

pub(super) fn parse_render(f: &tempfile::NamedTempFile) -> AppResult<(String, Parsed)> {
    let parsed = parse_file(f.path())?;
    let atts: Vec<SavedImage> = parsed
        .images
        .iter()
        .enumerate()
        .map(|(i, im)| SavedImage { rel_path: format!("n/{i}-{}", im.name), name: im.name.clone() })
        .collect();
    Ok((parsed.render(&atts), parsed))
}

pub(super) fn html_of(body: &str) -> String {
    d(body).html()
}

pub(super) fn kinds(parsed: &Parsed) -> Vec<(String, u32)> {
    parsed.dropped.iter().map(|x| (x.kind.clone(), x.count)).collect()
}

pub(super) fn validation_message(f: &tempfile::NamedTempFile) -> String {
    match parse_file(f.path()) {
        Err(AppError::Validation(m)) => m,
        Err(e) => panic!("VALIDATION 이어야 한다: {e:?}"),
        Ok(_) => panic!("거절돼야 한다"),
    }
}

// ── 인라인 서식 ───────────────────────────────────────────────────────────────

#[test]
fn inline_marks_follow_on_off_values_and_ignore_the_paragraph_mark() {
    // `w:pPr/w:rPr` 의 굵게는 문단 표지의 서식이다(워드가 밑줄 문서에서 실제로 이렇게 쓴다) — 런에는 쓰지 않는다.
    let body = pp(
        "<w:rPr><w:b/></w:rPr>",
        &[
            r("plain "),
            rp("<w:b/>", "bold "),
            rp(r#"<w:b w:val="0"/>"#, "notbold "),
            rp("<w:i/>", "ital "),
            rp(r#"<w:u w:val="single"/>"#, "under "),
            rp(r#"<w:u w:val="none"/>"#, "nou "),
            rp("<w:strike/>", "strike "),
            rp("<w:dstrike/>", "dstrike "),
            rp(r#"<w:color w:val="FF0000"/>"#, "red "),
            rp(r#"<w:color w:val="auto"/>"#, "auto "),
            rp(r#"<w:color w:val="000000"/>"#, "black "),
            rp(r#"<w:highlight w:val="yellow"/>"#, "hl "),
            rp(r#"<w:highlight w:val="none"/>"#, "nohl "),
            rp(r#"<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>"#, "shd "),
            rp(r#"<w:shd w:val="clear" w:color="auto" w:fill="auto"/>"#, "shdauto"),
        ]
        .concat(),
    );
    assert_eq!(
        html_of(&body),
        "<p>plain <strong>bold </strong>notbold <em>ital </em><u>under </u>nou <s>strike dstrike </s>\
         <span style=\"color: #ff0000\">red </span>auto black <mark>hl </mark>nohl <mark>shd </mark>shdauto</p>"
    );
}

#[test]
fn bad_colors_never_reach_the_html() {
    // 6자리 16진이 아니면(색 이름 · 주입 시도) 색을 박지 않는다.
    for bad in ["red", "12345", "1234567", "GGGGGG", "ff0000&quot; onclick=&quot;x", "themeColor"] {
        let body = p(&rp(&format!(r#"<w:color w:val="{bad}"/>"#), "x"));
        assert_eq!(html_of(&body), "<p>x</p>", "{bad:?}");
    }
}

#[test]
fn text_is_escaped_and_entities_resolved() {
    assert_eq!(html_of(&p(&r("a &amp; b &lt;i&gt; &#xAC00;"))), "<p>a &amp; b &lt;i&gt; 가</p>");
}

#[test]
fn tabs_breaks_symbols_and_hidden_text() {
    let body = p(&[
        r("a"),
        "<w:r><w:tab/></w:r>".to_string(),
        r("b"),
        "<w:r><w:br/></w:r>".to_string(),
        r("c"),
        r#"<w:r><w:br w:type="page"/></w:r>"#.to_string(),
        r("d"),
        "<w:r><w:cr/></w:r>".to_string(),
        r("e"),
        "<w:r><w:noBreakHyphen/></w:r>".to_string(),
        r#"<w:r><w:sym w:font="Symbol" w:char="F0B7"/></w:r>"#.to_string(),
        r#"<w:r><w:sym w:font="Wingdings" w:char="F0FF"/></w:r>"#.to_string(),
        rp("<w:vanish/>", "SECRET"),
        r("f"),
        r#"<w:r><w:sym w:font="Wingdings" w:char="F0A8"/></w:r>"#.to_string(),
        r#"<w:r><w:sym w:font="Wingdings" w:char="F0FE"/></w:r>"#.to_string(),
        // Symbol 글꼴의 F0A8 은 체크 상자가 아니다(♦) — 버리고 센다.
        r#"<w:r><w:sym w:font="Symbol" w:char="F0A8"/></w:r>"#.to_string(),
        r#"<w:r><w:br w:type="column"/></w:r>"#.to_string(),
        r("g"),
    ]
    .concat());
    // 탭은 공백, 쪽·단 나누기는 공백 하나, 알 수 없는 심볼 코드(세고)와 숨김 글자는 가져오지 않는다. Wingdings 체크 상자는 ☐/☑.
    let (html, parsed) = d(&body).parsed();
    assert_eq!(html, "<p>a b<br>c d<br>e-•f☐☑ g</p>");
    assert_eq!(kinds(&parsed), vec![("symbol".to_string(), 2)]);
}

#[test]
fn nested_field_result_inside_an_outer_instruction_is_not_text() {
    // IF { REF x } = "1" "yes" "no" — 안쪽 REF 의 결과("VAL")는 바깥 IF 명령의 일부라 보이지 않는다.
    let body = p(&[
        fld("begin"),
        instr("IF"),
        fld("begin"),
        instr("REF x"),
        fld("separate"),
        r("VAL"),
        fld("end"),
        instr(r#"= "1" "yes" "no""#),
        fld("separate"),
        r("yes"),
        fld("end"),
    ]
    .concat());
    assert_eq!(html_of(&body), "<p>yes</p>");
}

#[test]
fn equation_text_is_kept_as_code_and_counted() {
    let body = p(&format!(
        "{}<m:oMath><m:r><m:t>x</m:t></m:r><m:r><m:t>+1</m:t></m:r></m:oMath>{}",
        r("값 "),
        r(" 끝")
    ));
    let (html, parsed) = d(&body).parsed();
    assert_eq!(html, "<p>값 <code>x+1</code> 끝</p>");
    assert_eq!(kinds(&parsed), vec![("equation".to_string(), 1)]);
    // 수식 문단(oMathPara)은 안의 수식마다 센다.
    let (html, parsed) = d(&p("<m:oMathPara><m:oMath><m:r><m:t>a</m:t></m:r></m:oMath><m:oMath><m:r><m:t>b</m:t></m:r></m:oMath></m:oMathPara>")).parsed();
    assert_eq!(html, "<p><code>a</code> <code>b</code></p>");
    assert_eq!(kinds(&parsed), vec![("equation".to_string(), 2)]);
}

// ── 스타일 상속 ───────────────────────────────────────────────────────────────

pub(super) const STYLES: &str = r#"
    <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
      <w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="365F91"/><w:sz w:val="32"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="MyHead"><w:name w:val="My Head"/><w:basedOn w:val="Heading1"/><w:rPr><w:i/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="H2"><w:name w:val="제목 2"/><w:basedOn w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="Strong1"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="Emph"><w:name w:val="Emph"/><w:basedOn w:val="Strong1"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="LoopA"><w:name w:val="A"/><w:basedOn w:val="LoopB"/><w:rPr><w:b/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="LoopB"><w:name w:val="B"/><w:basedOn w:val="LoopA"/><w:rPr><w:strike/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>"#;

#[test]
fn run_properties_inherit_paragraph_style_then_char_style_chain_then_direct() {
    let quote = r#"<w:pStyle w:val="Quote"/>"#;
    let body = [
        pp(quote, &r("q")),
        // 글자 스타일 사슬: Emph(밑줄) → Strong1(굵게). 문단 스타일의 기울임도 그대로 이어진다.
        pp(quote, &rp(r#"<w:rStyle w:val="Emph"/>"#, "chain")),
        // 직접 지정이 문단 스타일(기울임)을 이긴다.
        pp(quote, &rp(r#"<w:i w:val="0"/>"#, "direct")),
        // basedOn 이 서로를 가리켜도(순환) 멈춘다.
        p(&rp(r#"<w:rStyle w:val="LoopA"/>"#, "loop")),
    ]
    .concat();
    let html = d(&body).styles(STYLES).html();
    let lines: Vec<&str> = html.lines().collect();
    assert_eq!(lines[0], "<p><em>q</em></p>", "{html}");
    assert_eq!(lines[1], "<p><strong><em><u>chain</u></em></strong></p>", "{html}");
    assert_eq!(lines[2], "<p>direct</p>", "{html}");
    assert!(lines[3].contains("loop"), "{html}");
    // styles 파트가 없으면 스타일은 아무 서식도 만들지 않는다.
    assert_eq!(html_of(&pp(quote, &r("q"))), "<p>q</p>");
}

#[test]
fn headings_come_from_style_id_name_outline_level_and_drop_style_color() {
    let body = [
        pp(r#"<w:pStyle w:val="Heading1"/>"#, &r("One")),
        // 상속한 개요 수준(Heading1 → MyHead).
        pp(r#"<w:pStyle w:val="MyHead"/>"#, &r("Inherited")),
        // 한글 이름 "제목 2".
        pp(r#"<w:pStyle w:val="H2"/>"#, &r("Two")),
        // 이름만 "Heading 3" 인 스타일(개요 수준 없음).
        pp(r#"<w:pStyle w:val="Heading3"/>"#, &r("Three")),
        // 직접 개요 수준: 3(= 4번째 단계) → h3, 9 = 본문(제목 스타일의 굵게 · 색은 본문 문단이 그대로 물려받는다).
        pp(r#"<w:outlineLvl w:val="3"/>"#, &r("Deep")),
        pp(r#"<w:pStyle w:val="Heading1"/><w:outlineLvl w:val="9"/>"#, &r("Body")),
        // 제목 안의 직접 색은 남는다(스타일이 준 색만 버린다).
        pp(r#"<w:pStyle w:val="Heading1"/>"#, &rp(r#"<w:color w:val="FF0000"/>"#, "Red")),
    ]
    .concat();
    assert_eq!(
        d(&body).styles(STYLES).html(),
        "<h1>One</h1>\n<h1><em>Inherited</em></h1>\n<h2>Two</h2>\n<h3>Three</h3>\n<h3>Deep</h3>\n\
         <p><span style=\"color: #365f91\"><strong>Body</strong></span></p>\n\
         <h1><span style=\"color: #ff0000\">Red</span></h1>"
    );
}

#[test]
fn headings_are_inferred_from_size_only_when_conservative() {
    let sized = |sz: u32, t: &str| p(&rp(&format!(r#"<w:sz w:val="{sz}"/>"#), t));
    let long = "긴".repeat(61); // 60자를 넘으면 제목이 아니다
    let body = [
        sized(20, &"본".repeat(80)),
        sized(20, &"문".repeat(80)),
        sized(44, "큰 제목"),   // 2.2배 → h1
        sized(32, "중간 제목"), // 1.6배 → h2
        sized(24, "조금 큼"),   // 1.2배 → 그대로
        sized(44, &long),
    ]
    .concat();
    let html = html_of(&body);
    assert!(html.contains("<h1>큰 제목</h1>"), "{html}");
    assert!(html.contains("<h2>중간 제목</h2>"), "{html}");
    assert!(html.contains("<p>조금 큼</p>"), "{html}");
    assert!(html.contains(&format!("<p>{long}</p>")), "{html}");
}

// ── 정렬 · 들여쓰기 ───────────────────────────────────────────────────────────

#[test]
fn alignments_map_and_left_has_no_attributes() {
    let al = |v: &str| pp(&format!(r#"<w:jc w:val="{v}"/>"#), &r("t"));
    let html = html_of(&[al("left"), al("center"), al("right"), al("both"), al("distribute"), al("start"), al("end")].concat());
    let attr = |a: &str| format!("<p data-brise-align=\"{a}\" style=\"text-align: {a};\">t</p>");
    assert_eq!(
        html,
        [
            "<p>t</p>".to_string(),
            attr("center"),
            attr("right"),
            attr("justify"),
            attr("justify"),
            "<p>t</p>".to_string(),
            attr("right"),
        ]
        .join("\n")
    );
}

#[test]
fn indent_rounds_left_twips_to_levels_and_clamps() {
    let ind = |left: &str| pp(&format!(r#"<w:ind w:left="{left}"/>"#), &r("t"));
    let html = html_of(&[ind("0"), ind("100"), ind("800"), ind("1200"), ind("99999")].concat());
    let lv = |n: u32| format!("<p data-brise-indent=\"{n}\" style=\"margin-left: {}em;\">t</p>", n * 2);
    // 100 → 0.25단 → 0(속성 없음), 800 → 2, 1200 → 3, 아주 큰 값 → 6.
    assert_eq!(html, ["<p>t</p>".to_string(), "<p>t</p>".to_string(), lv(2), lv(3), lv(6)].join("\n"));
}

// ── 목록 ──────────────────────────────────────────────────────────────────────

pub(super) const NUMBERING: &str = r#"
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="none"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="3"><w:numStyleLink w:val="LinkedList"/></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
    <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
    <w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>
    <w:num w:numId="5"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:lvlOverride></w:num>"#;

const LIST_STYLES: &str = r#"
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
    <w:style w:type="numbering" w:styleId="LinkedList"><w:name w:val="LinkedList"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>"#;

pub(super) fn li(num_id: &str, ilvl: u32, text: &str) -> String {
    pp(&format!(r#"<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num_id}"/></w:numPr>"#), &r(text))
}

#[test]
fn list_paragraphs_group_nest_and_switch_kind() {
    let body = [li("1", 0, "a"), li("1", 1, "b"), li("1", 0, "c"), li("2", 0, "bullet"), p(&r("end"))].concat();
    let html = d(&body).numbering(NUMBERING).html();
    assert_eq!(
        html,
        "<ol><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ol><ul><li><p>bullet</p></li></ul>\n<p>end</p>"
    );
}

#[test]
fn numbering_from_style_num_id_zero_none_format_link_and_override() {
    let body = [
        // 스타일에서 오는 번호(python-docx 의 List Bullet).
        pp(r#"<w:pStyle w:val="ListBullet"/>"#, &r("styled")),
        // numId 0 = 번호 없음을 명시.
        pp(r#"<w:pStyle w:val="ListBullet"/><w:numPr><w:numId w:val="0"/></w:numPr>"#, &r("opted out")),
        // numFmt none → 번호 없는 문단.
        li("3", 0, "none"),
        // numStyleLink → 번호 스타일의 numId(1 = decimal).
        li("4", 0, "linked"),
        // lvlOverride 가 정의를 덮는다(bullet → decimal).
        li("5", 0, "overridden"),
        // 정의가 없는 numId → 번호 없는 문단.
        li("99", 0, "unknown"),
    ]
    .concat();
    let html = d(&body).styles(LIST_STYLES).numbering(NUMBERING).html();
    assert_eq!(
        html,
        "<ul><li><p>styled</p></li></ul>\n<p>opted out</p>\n<p>none</p>\n\
         <ol><li><p>linked</p></li><li><p>overridden</p></li></ol>\n<p>unknown</p>"
    );
}

/// 번호 이어 세기 시험용: 정의 0(10진 두 단) · 정의 1(시작 5) · 정의 2(글머리표). 인스턴스 1·2 는 정의 0 을 그대로(덮어쓰기 없음),
/// 3 은 1 로 다시 시작, 4 는 7 로 다시 시작.
const RESUME_NUMBERING: &str = r#"
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>
    <w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
    <w:num w:numId="4"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>
    <w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num>
    <w:num w:numId="6"><w:abstractNumId w:val="2"/></w:num>"#;

fn plain(text: &str) -> String {
    p(&r(text))
}

#[test]
fn a_numbered_list_interrupted_by_paragraphs_resumes_its_numbers_with_ol_start() {
    // "1. 첫째 / 보충 / 2. 둘째 / 보충 / 3. 셋째" — 같은 numId 가 문단에 끊겨도 워드는 1, 2, 3 으로 센다. 다시 열리는 `<ol>` 이 1 부터면 거짓말이 된다.
    let body = [li("1", 0, "첫째"), plain("보충"), li("1", 0, "둘째"), plain("보충"), li("1", 0, "셋째")].concat();
    let html = d(&body).numbering(RESUME_NUMBERING).html();
    assert_eq!(
        html,
        "<ol><li><p>첫째</p></li></ol>\n<p>보충</p>\n<ol start=\"2\"><li><p>둘째</p></li></ol>\n<p>보충</p>\n<ol start=\"3\"><li><p>셋째</p></li></ol>"
    );
    // 끊기지 않은 목록은 `start` 가 없다.
    let html = d(&[li("1", 0, "a"), li("1", 0, "b")].concat()).numbering(RESUME_NUMBERING).html();
    assert_eq!(html, "<ol><li><p>a</p></li><li><p>b</p></li></ol>");
}

#[test]
fn numbering_follows_word_across_instances_restarts_and_start_values() {
    let numbering = |body: String| d(&body).numbering(RESUME_NUMBERING).html();
    // 같은 정의를 쓰는 다른 인스턴스(덮어쓰기 없음)는 앞 목록의 번호를 이어 센다.
    assert_eq!(
        numbering([li("1", 0, "a"), li("1", 0, "b"), plain("끊김"), li("2", 0, "c")].concat()),
        "<ol><li><p>a</p></li><li><p>b</p></li></ol>\n<p>끊김</p>\n<ol start=\"3\"><li><p>c</p></li></ol>"
    );
    // startOverride 는 인스턴스를 처음 쓰는 순간 그 값에서 다시 시작한다(Brise 가 내보낸 파일이 목록마다 이렇게 쓴다).
    assert_eq!(
        numbering([li("1", 0, "a"), li("1", 0, "b"), plain("끊김"), li("3", 0, "c"), li("3", 0, "d")].concat()),
        "<ol><li><p>a</p></li><li><p>b</p></li></ol>\n<p>끊김</p>\n<ol><li><p>c</p></li><li><p>d</p></li></ol>"
    );
    // 덮어쓰기는 처음 쓸 때 한 번만 듣는다 — 인스턴스 4 가 문단에 끊겨 다시 열려도 7 로 되돌아가지 않고 이어 센다(z = 9).
    assert_eq!(
        numbering([li("4", 0, "x"), li("4", 0, "y"), plain("끊김"), li("4", 0, "z")].concat()),
        "<ol start=\"7\"><li><p>x</p></li><li><p>y</p></li></ol>\n<p>끊김</p>\n<ol start=\"9\"><li><p>z</p></li></ol>"
    );
    // `w:start` — 정의가 시작 번호를 정한다.
    assert_eq!(
        numbering([li("5", 0, "x"), li("5", 0, "y")].concat()),
        "<ol start=\"5\"><li><p>x</p></li><li><p>y</p></li></ol>"
    );
    // 글머리표는 끊겨도 `start` 를 달지 않는다.
    assert_eq!(
        numbering([li("6", 0, "a"), plain("끊김"), li("6", 0, "b")].concat()),
        "<ul><li><p>a</p></li></ul>\n<p>끊김</p>\n<ul><li><p>b</p></li></ul>"
    );
}

#[test]
fn deeper_levels_restart_after_a_shallower_item_and_the_start_is_clamped() {
    let body = [
        li("1", 0, "a"),
        li("1", 1, "b"),
        li("1", 1, "c"),
        li("1", 0, "d"),
        li("1", 1, "e"),
        plain("x"),
        li("1", 1, "f"),
    ]
    .concat();
    let html = d(&body).numbering(RESUME_NUMBERING).html();
    // e 는 d 아래에서 다시 1 로, f 는 e 를 이어 2 로.
    assert_eq!(
        html,
        "<ol><li><p>a</p><ol><li><p>b</p></li><li><p>c</p></li></ol></li><li><p>d</p><ol><li><p>e</p></li></ol></li></ol>\n\
         <p>x</p>\n<ol start=\"2\"><li><p>f</p></li></ol>"
    );
    // 천문학적인 `w:start` 는 막는다.
    let huge = r#"<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="99999999999"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>"#;
    assert_eq!(d(&li("1", 0, "a")).numbering(huge).html(), "<ol start=\"1000000\"><li><p>a</p></li></ol>");
}

// ── 링크 · 필드 ───────────────────────────────────────────────────────────────

fn hl(inner: &str) -> String {
    format!(r#"<w:hyperlink r:id="rIdL" w:history="1">{inner}</w:hyperlink>"#)
}

#[test]
fn hyperlinks_use_external_relationships_and_anchors_keep_plain_text() {
    let body = p(&[
        hl(&rp(r#"<w:rStyle w:val="Hyperlink"/>"#, "Example")),
        r(" | "),
        format!(r#"<w:hyperlink w:anchor="_Toc1">{}</w:hyperlink>"#, r("anchor")),
        r(" | "),
        format!(r#"<w:hyperlink r:id="rIdBad">{}</w:hyperlink>"#, r("evil")),
    ]
    .concat());
    let html = d(&body)
        .styles(STYLES)
        .rel(rel_ext("rIdL", "hyperlink", "http://www.example.com/a(b)"))
        .rel(rel_ext("rIdBad", "hyperlink", "javascript:alert(1)"))
        .html();
    // 워드의 링크 모양(파랑 + 밑줄)은 벗기고, 주소의 괄호는 퍼센트 인코딩한다. 책갈피·위험한 스킴은 글자만.
    assert_eq!(html, "<p><a href=\"http://www.example.com/a%28b%29\">Example</a> | anchor | evil</p>");
}

fn fld(ty: &str) -> String {
    format!(r#"<w:r><w:fldChar w:fldCharType="{ty}"/></w:r>"#)
}

fn instr(t: &str) -> String {
    format!(r#"<w:r><w:instrText xml:space="preserve"> {t} </w:instrText></w:r>"#)
}

#[test]
fn simple_and_complex_fields_become_links_or_just_their_result() {
    let body = [
        p(&format!(r#"<w:fldSimple w:instr=" HYPERLINK &quot;https://simple.example/x&quot; ">{}</w:fldSimple>"#, r("simple"))),
        // 복합 필드: 명령 구간의 글자는 보이지 않고, 결과 구간만 링크가 된다.
        p(&[
            fld("begin"),
            instr(r#"HYPERLINK "https://complex.example/y" \o "tip""#),
            r("HIDDEN"), // 명령 구간의 w:t 는 글자가 아니다
            fld("separate"),
            rp("<w:b/>", "complex"),
            fld("end"),
            r(" after"),
        ]
        .concat()),
        // 책갈피(\l)만 있으면 갈 곳이 없다 → 글자만.
        p(&[fld("begin"), instr(r#"HYPERLINK \l "_Toc5""#), fld("separate"), r("internal"), fld("end")].concat()),
        // 링크가 아닌 필드는 결과 글자만 남기고 센다.
        p(&[fld("begin"), instr("DATE \\@ \"yyyy\""), fld("separate"), r("2026"), fld("end")].concat()),
        p(&format!(r#"<w:fldSimple w:instr=" PAGE ">{}</w:fldSimple>"#, r("7"))),
    ]
    .concat();
    let (html, parsed) = d(&body).parsed();
    assert_eq!(
        html,
        "<p><a href=\"https://simple.example/x\">simple</a></p>\n\
         <p><a href=\"https://complex.example/y\"><strong>complex</strong></a> after</p>\n\
         <p>internal</p>\n<p>2026</p>\n<p>7</p>"
    );
    assert_eq!(kinds(&parsed), vec![("field".to_string(), 2)]);
}

#[test]
fn nested_fields_count_once_across_paragraphs() {
    // 목차(TOC) 안에 HYPERLINK \l 과 PAGEREF 가 중첩된다 — 가장 바깥 TOC 하나만 센다. 필드는 문단을 가로지른다.
    let body = [
        p(&[fld("begin"), instr(r#"TOC \o "1-3""#), fld("separate")].concat()),
        p(&[
            fld("begin"),
            instr(r#"HYPERLINK \l "_Toc1""#),
            fld("separate"),
            r("Entry"),
            fld("begin"),
            instr("PAGEREF _Toc1 \\h"),
            fld("separate"),
            r("3"),
            fld("end"),
            fld("end"),
        ]
        .concat()),
        p(&fld("end")),
        p(&r("after")),
    ]
    .concat();
    let (html, parsed) = d(&body).parsed();
    // 필드 끝만 든 문단은 (워드에서도 그렇듯) 빈 문단으로 남는다.
    assert_eq!(html, "<p>Entry3</p>\n<p></p>\n<p>after</p>");
    assert_eq!(kinds(&parsed), vec![("field".to_string(), 1)]);
}

// ── 변경 추적 · 투명 컨테이너 ─────────────────────────────────────────────────

#[test]
fn tracked_insertions_are_kept_and_deletions_dropped() {
    let body = [
        p(&[
            r("keep "),
            format!(r#"<w:ins w:id="1" w:author="a">{}</w:ins>"#, r("inserted ")),
            r#"<w:del w:id="2" w:author="a"><w:r><w:delText xml:space="preserve">deleted </w:delText></w:r></w:del>"#.to_string(),
            r#"<w:moveFrom w:id="3"><w:r><w:t>moved away </w:t></w:r></w:moveFrom>"#.to_string(),
            format!(r#"<w:moveTo w:id="4">{}</w:moveTo>"#, r("moved in")),
        ]
        .concat()),
        // 삭제된 표 행은 수락한 모양에 없다.
        r#"<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
           <w:tr><w:tc><w:p><w:r><w:t>row1</w:t></w:r></w:p></w:tc></w:tr>
           <w:tr><w:trPr><w:del w:id="9" w:author="a"/></w:trPr><w:tc><w:p><w:r><w:t>row2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#
            .to_string(),
    ]
    .concat();
    let html = html_of(&body);
    assert!(html.starts_with("<p>keep inserted moved in</p>\n<table>"), "{html}");
    assert!(html.contains("row1") && !html.contains("row2") && !html.contains("deleted"), "{html}");
}

#[test]
fn content_controls_smart_tags_and_alternate_content_are_transparent() {
    let body = [
        // 블록 수준 콘텐츠 컨트롤 안의 문단.
        format!("<w:sdt><w:sdtPr/><w:sdtContent>{}</w:sdtContent></w:sdt>", p(&r("in sdt"))),
        // 문단 안: 스마트 태그 · 사용자 XML · 인라인 sdt.
        p(&[
            format!(r#"<w:smartTag w:uri="x" w:element="y">{}</w:smartTag>"#, r("tag ")),
            format!(r#"<w:customXml w:element="z">{}</w:customXml>"#, r("xml ")),
            format!("<w:sdt><w:sdtContent>{}</w:sdtContent></w:sdt>", r("inline")),
        ]
        .concat()),
        // mc:AlternateContent 는 Choice 한 가지만(Fallback 에 같은 글이 있어도 한 번).
        p("<w:r><mc:AlternateContent><mc:Choice Requires=\"x\"><w:t>choice</w:t></mc:Choice><mc:Fallback><w:t>fallback</w:t></mc:Fallback></mc:AlternateContent></w:r>"),
        p("<w:r><mc:AlternateContent><mc:Fallback><w:t>only fallback</w:t></mc:Fallback></mc:AlternateContent></w:r>"),
    ]
    .concat();
    assert_eq!(html_of(&body), "<p>in sdt</p>\n<p>tag xml inline</p>\n<p>choice</p>\n<p>only fallback</p>");
}

#[test]
fn local_names_make_prefix_and_namespace_irrelevant() {
    // transitional → strict 네임스페이스, w: → x: 접두사.
    let body = [
        pp(r#"<w:jc w:val="center"/>"#, &rp("<w:b/>", "bold")),
        li("1", 0, "item"),
        r#"<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#.to_string(),
    ]
    .concat();
    let original = d(&body).numbering(NUMBERING);
    let a = original.html();
    assert!(a.contains("<strong>bold</strong>") && a.contains("<ol>") && a.contains("colspan=\"2\""), "{a}");

    let reprefix = |xml: &str| {
        xml.replace("<w:", "<x:")
            .replace("</w:", "</x:")
            .replace(" w:", " x:")
            .replace(
                "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"",
                "xmlns:x=\"http://purl.oclc.org/ooxml/wordprocessingml/main\"",
            )
    };
    let other = D {
        document: reprefix(&original.document),
        rels: original.rels.clone(),
        parts: original.parts.iter().map(|(n, b)| (n.clone(), reprefix(&String::from_utf8_lossy(b)).into_bytes())).collect(),
    };
    assert_eq!(a, other.html());
}
