// repo: doc_export::hwpx — ProseMirror JSON → .hwpx (PLAN-2026-10-07-doc-import-export W3, W4-0 에서 doc_export 로 이동)
//
// 본 제품은 한글과컴퓨터의 글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
// (OWPML/KS X 6101 구조를 참고했다 — 정확한 고지 문구·위치는 조사 §6.7 대로 W3 전에 스펙 PDF 와 대조해 확정한다.)
//
// 왜 JSON 인가: body_md → 문서 구조 변환은 프런트의 헤드리스 TipTap(`createMarkdownEditor`)이 SSOT 다. 마크다운 규칙을 Rust 에
// 두 번째로 두지 않으려고(가져오기 `doc_import_html` 과 같은 이유) 프런트가 섹션마다 `getJSON()` 을 보내고, 여기는 그 JSON 을
// OWPML 로 옮기기만 한다. 그래서 Rust 만 도는 일괄 경로(export_folder·CLI·MCP)는 HWPX 를 만들지 않는다.
//
// 세 겹으로 나눈다 — ① `Writer`: JSON → section0.xml 문자열(서식은 charPr/paraPr/borderFill 레지스트리에 내용으로 중복 제거해
// 쌓는다). ② 레지스트리 → header.xml, 그 밖의 정적 부품(version·container·manifest·settings·content.hpf). ③ `package`: zip.
// 파일 입출력은 그림을 읽는 `attachment_resolver` 와 `export()` 의 마지막 쓰기뿐이고, ①②③ 은 순수하다(테스트가 한 줄로 부른다).
//
// 모양의 근거: 한컴이 저장한 hwpx 9개(hwpxlib 공개 테스트 파일) — header.xml 의 기본 항목(글꼴 7언어·기본 글자 모양 7·문단 모양 16·
// 스타일 18·번호 정의 1·테두리 2)을 그대로 심어 두고 그 뒤에 우리 항목을 이어 붙인다(스타일이 가리키는 id 가 항상 존재).
// 하이퍼링크 필드는 python-hwpx `hyperlink_form.py` 와 같은 6-param 모양, 글머리표 정의는 hwpxlib BulletWriter 와 같은 속성.
// 한컴 오타 속성(`tagetApplication`·`isEmbeded`·`trackchageConfig`·`hc:intent`)은 그대로 쓴다.
//
// 쓰지 않는 것: `hp:linesegarray`(줄 배치 캐시 — 안 쓰면 한글이 열 때 다시 배치한다) · 머리말/꼬리말/쪽 번호 · 각주 · PrvImage.png.
//
// ponytail: 글자 크기·글꼴은 우리가 정한다(본문 10pt 함초롬바탕, 제목 16/14/12pt 함초롬돋움). 표는 일괄 실선·열 너비 근사, 접기는
// 펼친 문단, 할 일은 ☐/☑ 글자, 각주·날짜 표지는 글자만. 번호 목록은 목록마다 번호 정의를 따로 둔다(한/글은 번호 정의마다 번호를
// 센다 — python-hwpx known-traps). 천장 = "원본과 비슷하게"(계획 §0-2).
use super::pm::{
    attr, attr_f64, attr_str, bold_all, column_widths, css_color, fit_image, image_pct, kids, link_target, mark_attr, marks, place_grid,
    plain_text, ty, Align, LinkTarget,
};
use super::xmlw::{esc_attr, esc_into, is_xml_char};
use super::{section_heading, Budget, Built, DocExportSection, ImageStore, ImgEntry, Margin, Paper, PaperSize, ZipOut};
use crate::error::AppResult;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::hash::Hash;

/// 미리보기 텍스트(Preview/PrvText.txt) 상한(글자 수).
const MAX_PREVIEW_CHARS: usize = 1000;

// ── 쪽 · 단위 ─────────────────────────────────────────────────────────────────

/// 1 HWPUNIT = 1/7200 인치, 96dpi 화면 1px = 75 HWPUNIT(가져오기의 `/75` 와 대칭).
const HU_PER_PX: f64 = 75.0;
/// 들여쓰기 한 단 = 글자 2개 = 2000 HWPUNIT(10pt 기준) — 가져오기의 `/2000` 과 대칭.
const INDENT_UNIT: i64 = 2000;
const MAX_INDENT: i64 = 6;
const MARGIN_LR: i64 = 8504;
const MARGIN_TOP: i64 = 5668;
const MARGIN_BOTTOM: i64 = 4252;
const MARGIN_HEADER_FOOTER: i64 = 4252;
/// 표 칸 안쪽 여백(실제 한컴 저장본) · 표 한 줄의 최소 높이(한글이 내용에 맞춰 늘린다).
const CELL_MARGIN_LR: i64 = 510;
const CELL_MARGIN_TB: i64 = 141;
const MIN_ROW_HEIGHT: i64 = 1900;
const MIN_COL_WIDTH: i64 = 600;
/// 한컴 하이퍼링크 필드 공통 fieldid.
const HYPERLINK_FIELD_ID: &str = "627600491";

/// (가로, 세로) HWPUNIT. 가로 방향은 폭·높이를 맞바꾸고 `landscape="NARROWLY"`(hwpxlib PageDirection: WIDELY=세로, NARROWLY=가로).
fn page_size(paper: Paper) -> (i64, i64) {
    paper.orient(match paper.size {
        PaperSize::A4 => (59528, 84188),
        PaperSize::B5 => (51591, 72850),
        PaperSize::Letter => (61200, 79200),
    })
}

fn landscape_attr(paper: Paper) -> &'static str {
    if paper.landscape { "NARROWLY" } else { "WIDELY" }
}

/// 쪽 여백 HWPUNIT — (위, 좌우, 아래, 머리말, 꼬리말). 한글은 본문을 위+머리말 · 아래+꼬리말 안쪽에 둔다.
/// 보통 = 한글 기본 용지(위 20 · 좌우 30 · 아래 15 · 머리말/꼬리말 15mm), 좁게 = 본문이 사방 12.7mm(머리말·꼬리말 0),
/// 넓게 = 보통에서 좌우만 50.8mm.
fn margins(paper: Paper) -> (i64, i64, i64, i64, i64) {
    match paper.margin {
        Margin::Normal => (MARGIN_TOP, MARGIN_LR, MARGIN_BOTTOM, MARGIN_HEADER_FOOTER, MARGIN_HEADER_FOOTER),
        Margin::Narrow => (3600, 3600, 3600, 0, 0),
        Margin::Wide => (MARGIN_TOP, 14400, MARGIN_BOTTOM, MARGIN_HEADER_FOOTER, MARGIN_HEADER_FOOTER),
    }
}

fn body_width(paper: Paper) -> i64 {
    page_size(paper).0 - 2 * margins(paper).1
}

fn body_height(paper: Paper) -> i64 {
    let (top, _, bottom, _, _) = margins(paper);
    page_size(paper).1 - top - bottom
}

/// 정렬 → OWPML `horizontal` 토큰.
fn owpml_align(a: Align) -> &'static str {
    match a {
        Align::Left => "LEFT",
        Align::Center => "CENTER",
        Align::Right => "RIGHT",
        Align::Justify => "JUSTIFY",
    }
}

fn align_of(s: Option<&str>) -> Option<&'static str> {
    super::pm::align_of(s).map(owpml_align)
}

// ── 문자열 도우미 ─────────────────────────────────────────────────────────────

/// `hp:t` 안의 글자. 탭 → `hp:tab`, 개행 → `hp:lineBreak`(코드 블록은 줄마다 문단이라 여기엔 거의 오지 않는다).
fn t_text(s: &str, out: &mut String) {
    let mut run = String::new();
    for c in s.chars() {
        match c {
            '\t' => {
                esc_into(&run, out, false);
                run.clear();
                out.push_str(r#"<hp:tab width="4000" leader="0" type="1"/>"#);
            }
            '\n' => {
                esc_into(&run, out, false);
                run.clear();
                out.push_str("<hp:lineBreak/>");
            }
            '\r' => {}
            c => run.push(c),
        }
    }
    esc_into(&run, out, false);
}

// ── 서식 레지스트리 ───────────────────────────────────────────────────────────

/// 내용으로 중복 제거하는 id 표. `seed` 는 header.xml 기본 항목 — 위치 = id 라서 중복이어도 건너뛰지 않고 그대로 쌓는다.
struct Registry<T> {
    items: Vec<T>,
    index: HashMap<T, u32>,
    base: u32,
}

impl<T: Clone + Eq + Hash> Registry<T> {
    fn new(base: u32, seed: Vec<T>) -> Self {
        let mut index = HashMap::new();
        for (i, t) in seed.iter().enumerate() {
            index.entry(t.clone()).or_insert(base + i as u32);
        }
        Registry { items: seed, index, base }
    }

    fn intern(&mut self, t: T) -> u32 {
        if let Some(i) = self.index.get(&t) {
            return *i;
        }
        let id = self.base + self.items.len() as u32;
        self.index.insert(t.clone(), id);
        self.items.push(t);
        id
    }
}

/// 글자 모양. `hangul_font`/`latin_font` 는 fontfaces 안의 id(0 함초롬돋움 · 1 함초롬바탕 · 2 고정폭).
#[derive(Clone, PartialEq, Eq, Hash)]
struct CharPr {
    height: u32,
    hangul_font: u8,
    latin_font: u8,
    color: String,
    shade: Option<String>,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    spacing: i32,
}

const FONT_DOTUM: u8 = 0;
const FONT_BATANG: u8 = 1;
const FONT_MONO: u8 = 2;
/// 고정폭 글꼴 이름. 한글 글자는 `hangul` 슬롯(함초롬바탕)으로 그려지므로 라틴·숫자·기호에만 쓰인다.
const MONO_FACE: &str = "Consolas";

impl CharPr {
    fn body() -> CharPr {
        CharPr {
            height: 1000,
            hangul_font: FONT_BATANG,
            latin_font: FONT_BATANG,
            color: "#000000".to_string(),
            shade: None,
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            spacing: 0,
        }
    }

    fn simple(height: u32, font: u8, spacing: i32, color: &str) -> CharPr {
        CharPr { height, hangul_font: font, latin_font: font, color: color.to_string(), spacing, ..CharPr::body() }
    }

    fn xml(&self, id: u32, out: &mut String) {
        let all = |v: i32| format!(r#"hangul="{v}" latin="{v}" hanja="{v}" japanese="{v}" other="{v}" symbol="{v}" user="{v}""#);
        let (hf, lf) = (self.hangul_font, self.latin_font);
        let _ = write!(
            out,
            r#"<hh:charPr id="{id}" height="{}" textColor="{}" shadeColor="{}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">"#,
            self.height,
            self.color,
            self.shade.as_deref().unwrap_or("none")
        );
        let _ = write!(
            out,
            r#"<hh:fontRef hangul="{hf}" latin="{lf}" hanja="{hf}" japanese="{hf}" other="{lf}" symbol="{hf}" user="{hf}"/>"#
        );
        let _ = write!(out, "<hh:ratio {}/>", all(100));
        let _ = write!(out, "<hh:spacing {}/>", all(self.spacing));
        let _ = write!(out, "<hh:relSz {}/>", all(100));
        let _ = write!(out, "<hh:offset {}/>", all(0));
        if self.italic {
            out.push_str("<hh:italic/>");
        }
        if self.bold {
            out.push_str("<hh:bold/>");
        }
        if self.underline {
            let _ = write!(out, r#"<hh:underline type="BOTTOM" shape="SOLID" color="{}"/>"#, self.color);
        } else {
            out.push_str(r##"<hh:underline type="NONE" shape="SOLID" color="#000000"/>"##);
        }
        if self.strike {
            out.push_str(r##"<hh:strikeout shape="SOLID" color="#000000"/>"##);
        } else {
            out.push_str(r##"<hh:strikeout shape="NONE" color="#000000"/>"##);
        }
        out.push_str(r#"<hh:outline type="NONE"/>"#);
        out.push_str(r##"<hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>"##);
        out.push_str("</hh:charPr>");
    }
}

/// header.xml 의 기본 글자 모양 0..=6(바탕글·쪽 번호·머리말·각주·메모·차례 제목·차례) — 스타일이 가리킨다.
fn base_char_prs() -> Vec<CharPr> {
    vec![
        CharPr::simple(1000, FONT_BATANG, 0, "#000000"),
        CharPr::simple(1000, FONT_DOTUM, 0, "#000000"),
        CharPr::simple(900, FONT_DOTUM, 0, "#000000"),
        CharPr::simple(900, FONT_BATANG, 0, "#000000"),
        CharPr::simple(900, FONT_DOTUM, -5, "#000000"),
        CharPr::simple(1600, FONT_DOTUM, 0, "#2E74B5"),
        CharPr::simple(1100, FONT_DOTUM, 0, "#000000"),
    ]
}

/// 문단 모양. 여백 숫자는 `hp:case`(HwpUnitChar) 값이고 `hp:default` 는 그 2배(실제 한컴 저장본: intent -1310/-2620, left 7000/14000,
/// prev 1200/2400 — 줄 간격만 두 가지가 같다).
#[derive(Clone, PartialEq, Eq, Hash)]
struct ParaPr {
    tab_pr: u8,
    condense: u8,
    align: &'static str,
    head: (&'static str, u32, u8),
    break_non_latin: &'static str,
    widow_orphan: u8,
    auto_spacing: u8,
    intent: i64,
    left: i64,
    prev: i64,
    next: i64,
    line: u32,
    border_fill: u32,
}

const NO_HEAD: (&str, u32, u8) = ("NONE", 0, 0);

impl ParaPr {
    fn body(align: &'static str, left: i64, line: u32) -> ParaPr {
        ParaPr {
            tab_pr: 0,
            condense: 0,
            align,
            head: NO_HEAD,
            break_non_latin: "KEEP_WORD",
            widow_orphan: 0,
            auto_spacing: 0,
            intent: 0,
            left,
            prev: 0,
            next: 0,
            line,
            border_fill: 2,
        }
    }

    fn xml(&self, id: u32, out: &mut String) {
        let _ = write!(
            out,
            r#"<hh:paraPr id="{id}" tabPrIDRef="{}" condense="{}" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">"#,
            self.tab_pr, self.condense
        );
        let _ = write!(out, r#"<hh:align horizontal="{}" vertical="BASELINE"/>"#, self.align);
        let _ = write!(out, r#"<hh:heading type="{}" idRef="{}" level="{}"/>"#, self.head.0, self.head.1, self.head.2);
        let _ = write!(
            out,
            r#"<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="{}" widowOrphan="{}" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>"#,
            self.break_non_latin, self.widow_orphan
        );
        let _ = write!(out, r#"<hh:autoSpacing eAsianEng="{0}" eAsianNum="{0}"/>"#, self.auto_spacing);
        out.push_str(r#"<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">"#);
        self.margin_xml(1, out);
        out.push_str("</hp:case><hp:default>");
        self.margin_xml(2, out);
        out.push_str("</hp:default></hp:switch>");
        let _ = write!(
            out,
            r#"<hh:border borderFillIDRef="{}" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>"#,
            self.border_fill
        );
    }

    fn margin_xml(&self, k: i64, out: &mut String) {
        let _ = write!(
            out,
            r#"<hh:margin><hc:intent value="{}" unit="HWPUNIT"/><hc:left value="{}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="{}" unit="HWPUNIT"/><hc:next value="{}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="{}" unit="HWPUNIT"/>"#,
            self.intent * k,
            self.left * k,
            self.prev * k,
            self.next * k,
            self.line
        );
    }
}

/// header.xml 의 기본 문단 모양 0..=15(스타일 18개가 가리킨다). 개요 1..7 은 4..=10(수준 6..0), 본문 11, 차례 12..=15.
fn base_para_prs() -> Vec<ParaPr> {
    let mk = |tab: u8, cond: u8, align: &'static str, head: (&'static str, u32, u8), nl: &'static str, wo: u8, auto: u8, intent: i64, left: i64, prev: i64, next: i64, line: u32| ParaPr {
        tab_pr: tab,
        condense: cond,
        align,
        head,
        break_non_latin: nl,
        widow_orphan: wo,
        auto_spacing: auto,
        intent,
        left,
        prev,
        next,
        line,
        border_fill: 2,
    };
    let mut v = vec![
        mk(0, 0, "LEFT", NO_HEAD, "BREAK_WORD", 0, 0, 0, 0, 0, 0, 130),
        mk(0, 0, "JUSTIFY", NO_HEAD, "KEEP_WORD", 0, 0, -1310, 0, 0, 0, 130),
        mk(0, 0, "JUSTIFY", NO_HEAD, "BREAK_WORD", 0, 0, 0, 0, 0, 0, 150),
        mk(0, 0, "JUSTIFY", NO_HEAD, "KEEP_WORD", 0, 0, 0, 0, 0, 0, 160),
    ];
    for level in (0..=6u8).rev() {
        v.push(mk(1, 20, "JUSTIFY", ("OUTLINE", 0, level), "KEEP_WORD", 0, 0, 0, 1000 * (i64::from(level) + 1), 0, 0, 160));
    }
    v.push(mk(0, 0, "JUSTIFY", NO_HEAD, "KEEP_WORD", 0, 0, 0, 1500, 0, 0, 160));
    v.push(mk(1, 20, "LEFT", NO_HEAD, "BREAK_WORD", 1, 1, 0, 0, 1200, 300, 160));
    v.push(mk(0, 0, "LEFT", NO_HEAD, "BREAK_WORD", 1, 1, 0, 0, 0, 700, 160));
    v.push(mk(0, 0, "LEFT", NO_HEAD, "BREAK_WORD", 1, 1, 0, 1100, 0, 700, 160));
    v.push(mk(0, 0, "LEFT", NO_HEAD, "BREAK_WORD", 1, 1, 0, 2200, 0, 700, 160));
    v
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Borders {
    None,
    Solid,
    BottomOnly,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Fill {
    /// `hc:fillBrush` 자체가 없다(기본 테두리 항목 1 · 표 테두리).
    Absent,
    /// `faceColor="none"`(기본 항목 2 — 글자 모양·문단 모양이 가리킨다).
    NoFace,
    Color(String),
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct FillSpec {
    borders: Borders,
    fill: Fill,
}

impl FillSpec {
    fn xml(&self, id: u32, out: &mut String) {
        let _ = write!(
            out,
            r#"<hh:borderFill id="{id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>"#
        );
        let side = |name: &str, on: bool, out: &mut String| {
            if on {
                let _ = write!(out, r##"<hh:{name} type="SOLID" width="0.12 mm" color="#000000"/>"##);
            } else {
                let _ = write!(out, r##"<hh:{name} type="NONE" width="0.1 mm" color="#000000"/>"##);
            }
        };
        let all = self.borders == Borders::Solid;
        side("leftBorder", all, out);
        side("rightBorder", all, out);
        side("topBorder", all, out);
        side("bottomBorder", all || self.borders == Borders::BottomOnly, out);
        out.push_str(r##"<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>"##);
        match &self.fill {
            Fill::Absent => {}
            Fill::NoFace => out.push_str(r##"<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#FF000000" alpha="0"/></hc:fillBrush>"##),
            Fill::Color(c) => {
                let _ = write!(out, r##"<hc:fillBrush><hc:winBrush faceColor="{c}" hatchColor="#FF000000" alpha="0"/></hc:fillBrush>"##);
            }
        }
        out.push_str("</hh:borderFill>");
    }
}

/// 테두리/배경 id 는 1 부터(글자 모양·문단 모양은 0 부터) — 실제 저장본이 그렇다.
fn base_fills() -> Vec<FillSpec> {
    vec![
        FillSpec { borders: Borders::None, fill: Fill::Absent },
        FillSpec { borders: Borders::None, fill: Fill::NoFace },
    ]
}

/// 번호 목록 하나 = 번호 정의 하나(id 2..; 1 은 개요). `start` 는 1 수준의 시작 번호.
struct NumberingDef {
    start: i64,
}

// ── 본문 작성기 ───────────────────────────────────────────────────────────────

/// 블록 하나를 쓰는 문맥. `quote` = 인용·접기·목록 이어 문단이 받는 들여쓰기 단 수, `avail_w` = 그림 폭 기준(본문 폭 또는 칸 폭).
#[derive(Clone, Copy)]
struct Cx {
    quote: i64,
    avail_w: i64,
    cell: bool,
    cell_align: Option<&'static str>,
}

struct Writer<'a> {
    paper: Paper,
    chars: Registry<CharPr>,
    paras: Registry<ParaPr>,
    fills: Registry<FillSpec>,
    numberings: Vec<NumberingDef>,
    bullets_used: bool,
    imgs: ImageStore<'a>,
    image_count: usize,
    skipped: usize,
    next_id: u64,
    sec_pending: bool,
    sec_xml: String,
    budget: Budget,
    paragraphs: usize,
    preview: String,
}

impl<'a> Writer<'a> {
    fn new(paper: Paper, resolve: &'a super::Resolver<'a>) -> Self {
        Writer {
            paper,
            chars: Registry::new(0, base_char_prs()),
            paras: Registry::new(0, base_para_prs()),
            fills: Registry::new(1, base_fills()),
            numberings: Vec::new(),
            bullets_used: false,
            imgs: ImageStore::new(resolve),
            image_count: 0,
            skipped: 0,
            next_id: 1_000_000_000,
            sec_pending: true,
            sec_xml: sec_pr_xml(paper),
            budget: Budget::default(),
            paragraphs: 0,
            preview: String::new(),
        }
    }

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn tick(&mut self) -> AppResult<()> {
        self.budget.tick()
    }

    /// 미리보기 글자(개행 제외)를 상한까지 덧붙인다.
    fn preview_push(&mut self, s: &str) {
        let have = self.preview.chars().count();
        if have >= MAX_PREVIEW_CHARS {
            return;
        }
        for c in s.chars().take(MAX_PREVIEW_CHARS - have) {
            if is_xml_char(c) && c != '\r' && c != '\n' {
                self.preview.push(c);
            }
        }
    }

    /// 미리보기의 줄 끝(CRLF — 실제 저장본이 그렇다). 상한을 넘으면 더 쓰지 않는다.
    fn preview_line_end(&mut self) {
        if self.preview.chars().count() < MAX_PREVIEW_CHARS {
            self.preview.push_str("\r\n");
        }
    }

    // ── 문단 · 런의 뼈대 ──────────────────────────────────────────────────

    fn p_open(&self, out: &mut String, pr: u32, style: u32) {
        let _ = write!(out, r#"<hp:p id="0" paraPrIDRef="{pr}" styleIDRef="{style}" pageBreak="0" columnBreak="0" merged="0">"#);
    }

    /// 런을 연다. 문서의 **첫** 런이면 쪽 설정(secPr)과 단 정의가 그 안에 먼저 들어간다(실제 저장본과 같은 자리).
    fn run_open(&mut self, out: &mut String, cp: u32) {
        let _ = write!(out, r#"<hp:run charPrIDRef="{cp}">"#);
        if self.sec_pending {
            self.sec_pending = false;
            out.push_str(&self.sec_xml);
        }
    }

    fn empty_run(&mut self, out: &mut String) {
        if self.sec_pending {
            self.run_open(out, 0);
            out.push_str("</hp:run>");
        } else {
            out.push_str(r#"<hp:run charPrIDRef="0"/>"#);
        }
    }

    // ── 서식 id ───────────────────────────────────────────────────────────

    /// 베이스 글자 모양에 마크를 얹은 글자 모양 id. 링크 글자는 한컴 관례대로 파랑 + 밑줄(글자색 마크가 있으면 그 색).
    fn char_id(&mut self, base: &CharPr, mark_list: &[Value], linked: bool) -> u32 {
        let mut c = base.clone();
        if linked {
            c.color = "#0000FF".to_string();
            c.underline = true;
        }
        for m in mark_list {
            match ty(m) {
                "bold" => c.bold = true,
                "italic" => c.italic = true,
                "underline" => c.underline = true,
                "strike" => c.strike = true,
                "code" => c.latin_font = FONT_MONO,
                "highlight" => {
                    c.shade = Some(mark_attr(m, "color").and_then(css_color).unwrap_or_else(|| "#FFFF00".to_string()));
                }
                "textStyle" => {
                    if let Some(col) = mark_attr(m, "color").and_then(css_color) {
                        c.color = col;
                    }
                }
                _ => {} // footnote · date · 그 밖의 표지 — 글자만 남긴다
            }
        }
        self.chars.intern(c)
    }

    fn fill_id(&mut self, borders: Borders, fill: Fill) -> u32 {
        self.fills.intern(FillSpec { borders, fill })
    }

    fn para_pr_id(&mut self, pr: ParaPr) -> u32 {
        self.paras.intern(pr)
    }

    fn line_for(cx: &Cx) -> u32 {
        if cx.cell {
            130
        } else {
            160
        }
    }

    // ── 인라인 → 런 ───────────────────────────────────────────────────────

    /// 문단 내용(글자·줄바꿈·그림)을 런들로 쓴다. 같은 글자 모양이 이어지면 한 런, 같은 링크가 이어지면 필드 한 쌍.
    /// `prefix` 는 본문 글자 모양으로 맨 앞에 붙는 글자(할 일 "☐ "). 반환 = 글자를 하나라도 쓴 문단인가가 아니라 런을 하나라도 썼는가.
    fn inline_runs(&mut self, out: &mut String, content: &[Value], prefix: &str, base: &CharPr, cx: &Cx, plain: &mut String) -> AppResult<bool> {
        let mut pending: Option<(u32, String)> = None;
        let mut field: Option<(u64, String)> = None;
        let mut any = false;
        if !prefix.is_empty() {
            let cp = self.char_id(base, &[], false);
            let mut s = String::new();
            t_text(prefix, &mut s);
            pending = Some((cp, s));
            plain.push_str(prefix);
        }
        for n in content {
            self.tick()?;
            match ty(n) {
                "text" => {
                    let text = n.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.is_empty() {
                        continue;
                    }
                    let link = marks(n).iter().find(|m| ty(m) == "link").and_then(link_target);
                    let want = link.as_ref().map(|l| l.href.as_str());
                    if want != field.as_ref().map(|(_, h)| h.as_str()) {
                        self.flush_run(out, &mut pending, &mut any);
                        if let Some((id, _)) = field.take() {
                            self.field_end(out, id);
                        }
                        if let Some(l) = &link {
                            let id = self.id();
                            self.field_begin(out, id, l);
                            field = Some((id, l.href.clone()));
                        }
                    }
                    let cp = self.char_id(base, marks(n), link.is_some());
                    match &mut pending {
                        Some((c, s)) if *c == cp => t_text(text, s),
                        _ => {
                            self.flush_run(out, &mut pending, &mut any);
                            let mut s = String::new();
                            t_text(text, &mut s);
                            pending = Some((cp, s));
                        }
                    }
                    plain.push_str(text);
                }
                "hardBreak" => {
                    if pending.is_none() {
                        let cp = self.char_id(base, &[], false);
                        pending = Some((cp, String::new()));
                    }
                    if let Some((_, s)) = &mut pending {
                        s.push_str("<hp:lineBreak/>");
                    }
                    plain.push(' ');
                }
                "image" => {
                    self.flush_run(out, &mut pending, &mut any);
                    self.pic_run(out, n, cx, plain);
                    any = true;
                }
                _ => {
                    // 알 수 없는 인라인 노드 — 글자만 남긴다(내용이 사라지는 쪽이 더 나쁘다).
                    let mut t = String::new();
                    plain_text(n, &mut t);
                    if !t.is_empty() {
                        let cp = self.char_id(base, &[], false);
                        match &mut pending {
                            Some((c, s)) if *c == cp => t_text(&t, s),
                            _ => {
                                self.flush_run(out, &mut pending, &mut any);
                                let mut s = String::new();
                                t_text(&t, &mut s);
                                pending = Some((cp, s));
                            }
                        }
                        plain.push_str(&t);
                    }
                }
            }
        }
        self.flush_run(out, &mut pending, &mut any);
        if let Some((id, _)) = field.take() {
            self.field_end(out, id);
            any = true;
        }
        Ok(any)
    }

    fn flush_run(&mut self, out: &mut String, pending: &mut Option<(u32, String)>, any: &mut bool) {
        if let Some((cp, inner)) = pending.take() {
            self.run_open(out, cp);
            out.push_str("<hp:t>");
            out.push_str(&inner);
            out.push_str("</hp:t></hp:run>");
            *any = true;
        }
    }

    /// 하이퍼링크 필드 시작. 서식은 **표시 글자 런에만** 준다 — 컨트롤 런(charPr 0)에 주면 링크 서식이 번진다(python-hwpx DEV-030).
    fn field_begin(&mut self, out: &mut String, id: u64, l: &LinkTarget) {
        // Command: 웹은 `:?;#` 앞에 역슬래시 + `;1;0;0;`, 메일은 그대로 + `;2;0;0`(python-hwpx hyperlink_form).
        let (command, category) = if l.mail {
            (format!("{};2;0;0", l.href), "HWPHYPERLINK_TYPE_EMAIL")
        } else {
            let mut e = String::with_capacity(l.href.len() + 8);
            for c in l.href.chars() {
                if matches!(c, ':' | '?' | ';' | '#') {
                    e.push('\\');
                }
                e.push(c);
            }
            (format!("{e};1;0;0;"), "HWPHYPERLINK_TYPE_URL")
        };
        self.run_open(out, 0);
        let _ = write!(
            out,
            r#"<hp:ctrl><hp:fieldBegin id="{id}" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="{HYPERLINK_FIELD_ID}"><hp:parameters cnt="6" name=""><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">{}</hp:stringParam><hp:stringParam name="Path">{}</hp:stringParam><hp:stringParam name="Category">{category}</hp:stringParam><hp:stringParam name="TargetType">HWPHYPERLINK_TARGET_BOOKMARK</hp:stringParam><hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_CURRENTTAB</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>"#,
            esc_attr(&command),
            esc_attr(&l.href)
        );
    }

    fn field_end(&mut self, out: &mut String, id: u64) {
        self.run_open(out, 0);
        let _ = write!(out, r#"<hp:ctrl><hp:fieldEnd beginIDRef="{id}" fieldid="{HYPERLINK_FIELD_ID}"/></hp:ctrl></hp:run>"#);
    }

    // ── 문단 ──────────────────────────────────────────────────────────────

    /// 문단 하나 — 내용 런들 + 문단 모양. 런이 없으면 빈 런(실제 저장본의 빈 문단과 같은 모양).
    fn para(&mut self, out: &mut String, pr: ParaPr, style: u32, content: &[Value], prefix: &str, base: &CharPr, cx: &Cx) -> AppResult<()> {
        let pr_id = self.para_pr_id(pr);
        let mut plain = String::new();
        let mut body = String::new();
        self.p_open(&mut body, pr_id, style);
        let any = self.inline_runs(&mut body, content, prefix, base, cx, &mut plain)?;
        if !any {
            self.empty_run(&mut body);
        }
        body.push_str("</hp:p>");
        out.push_str(&body);
        self.paragraphs += 1;
        self.preview_text(&plain, cx);
        Ok(())
    }

    fn preview_text(&mut self, plain: &str, cx: &Cx) {
        if cx.cell {
            self.preview_push(&format!("<{plain}>"));
        } else {
            self.preview_push(plain);
            self.preview_line_end();
        }
    }

    /// 줄 하나짜리 글(코드 한 줄·섹션 이름)을 문단으로.
    fn text_para(&mut self, out: &mut String, pr: ParaPr, style: u32, text: &str, base: &CharPr, cx: &Cx) -> AppResult<()> {
        if text.is_empty() {
            return self.para(out, pr, style, &[], "", base, cx);
        }
        let node = serde_json::json!({ "type": "text", "text": text });
        self.para(out, pr, style, std::slice::from_ref(&node), "", base, cx)
    }

    fn body_pr(&self, align: &'static str, left_units: i64, cx: &Cx) -> ParaPr {
        ParaPr::body(align, left_units * INDENT_UNIT, Self::line_for(cx))
    }

    /// 문단의 정렬: 문단 자신의 속성 → 표 칸 정렬 → 왼쪽.
    fn align_for(&self, n: &Value, cx: &Cx) -> &'static str {
        match align_of(attr_str(n, "textAlign")) {
            Some("LEFT") | None => cx.cell_align.unwrap_or("LEFT"),
            Some(a) => a,
        }
    }

    // ── 블록 ──────────────────────────────────────────────────────────────

    fn blocks(&mut self, out: &mut String, nodes: &[Value], cx: &Cx) -> AppResult<()> {
        for n in nodes {
            self.block(out, n, cx)?;
        }
        Ok(())
    }

    fn block(&mut self, out: &mut String, n: &Value, cx: &Cx) -> AppResult<()> {
        self.tick()?;
        self.budget.enter()?;
        let r = self.block_inner(out, n, cx);
        self.budget.leave();
        r
    }

    fn block_inner(&mut self, out: &mut String, n: &Value, cx: &Cx) -> AppResult<()> {
        match ty(n) {
            "paragraph" => {
                let indent = (attr_f64(n, "indent").unwrap_or(0.0) as i64).clamp(0, MAX_INDENT);
                let pr = self.body_pr(self.align_for(n, cx), indent + cx.quote, cx);
                self.para(out, pr, 0, kids(n), "", &CharPr::body(), cx)
            }
            "heading" => self.heading(out, n, cx),
            "bulletList" | "orderedList" | "taskList" => self.list(out, n, cx, 0, None),
            "codeBlock" => {
                let mut text = String::new();
                plain_text(n, &mut text);
                let fill = self.fill_id(Borders::None, Fill::Color("#F2F2F2".to_string()));
                let mut base = CharPr::body();
                base.latin_font = FONT_MONO;
                base.height = 900;
                for line in text.split('\n') {
                    let mut pr = self.body_pr("LEFT", cx.quote, cx);
                    pr.line = 130;
                    pr.border_fill = fill;
                    self.text_para(out, pr, 0, line.trim_end_matches('\r'), &base, cx)?;
                }
                Ok(())
            }
            "blockquote" => {
                let inner = Cx { quote: cx.quote + 1, ..*cx };
                self.blocks(out, kids(n), &inner)
            }
            "details" => {
                let inner = Cx { quote: cx.quote + 1, ..*cx };
                for k in kids(n) {
                    match ty(k) {
                        "detailsSummary" => {
                            let mut base = CharPr::body();
                            base.bold = true;
                            let pr = self.body_pr("LEFT", cx.quote, cx);
                            self.para(out, pr, 0, kids(k), "", &base, cx)?;
                        }
                        "detailsContent" => self.blocks(out, kids(k), &inner)?,
                        _ => self.block(out, k, &inner)?,
                    }
                }
                Ok(())
            }
            "horizontalRule" => {
                let fill = self.fill_id(Borders::BottomOnly, Fill::Absent);
                let mut pr = self.body_pr("LEFT", cx.quote, cx);
                pr.border_fill = fill;
                self.para(out, pr, 0, &[], "", &CharPr::body(), cx)
            }
            "table" => self.table(out, n, cx),
            "image" => {
                let pr = self.body_pr(cx.cell_align.unwrap_or("LEFT"), cx.quote, cx);
                self.para(out, pr, 0, std::slice::from_ref(n), "", &CharPr::body(), cx)
            }
            "hardBreak" => Ok(()),
            _ => {
                // 알 수 없는 블록 — 내용이 있으면 펼치고, 글자만 있으면 문단 하나로.
                if !kids(n).is_empty() && kids(n).iter().any(|k| !ty(k).is_empty() && ty(k) != "text") {
                    return self.blocks(out, kids(n), cx);
                }
                let mut t = String::new();
                plain_text(n, &mut t);
                if t.trim().is_empty() {
                    return Ok(());
                }
                let pr = self.body_pr("LEFT", cx.quote, cx);
                self.text_para(out, pr, 0, &t, &CharPr::body(), cx)
            }
        }
    }

    /// 제목 1..3 → 개요 1..3(스타일 2..4 · 문단 머리 OUTLINE 수준 0..2) + 함초롬돋움 굵게 16/14/12pt. 4..6 은 3 으로 접는다.
    ///
    /// 한/글은 개요 문단에 번호("1." · "가." …)를 자동으로 붙일 수 있다 — 실제 한글로 확인 못 한 사항이라 계획서 §5 에 위험으로 남긴다.
    /// 번호가 싫으면 이 함수의 `head` 만 `NO_HEAD` 로 바꾸면 된다(가져오기는 글자 크기로도 제목을 추정하지만 16pt 는 H2 까지만 잡힌다).
    fn heading(&mut self, out: &mut String, n: &Value, cx: &Cx) -> AppResult<()> {
        let level = (attr_f64(n, "level").unwrap_or(1.0) as i64).clamp(1, 3) as u8;
        let mut base = CharPr::body();
        base.hangul_font = FONT_DOTUM;
        base.latin_font = FONT_DOTUM;
        base.bold = true;
        base.height = match level {
            1 => 1600,
            2 => 1400,
            _ => 1200,
        };
        let mut pr = self.body_pr(self.align_for(n, cx), cx.quote, cx);
        pr.tab_pr = 1;
        pr.condense = 20;
        pr.head = ("OUTLINE", 0, level - 1);
        pr.prev = match level {
            1 => 1000,
            2 => 800,
            _ => 600,
        };
        pr.next = 300;
        self.para(out, pr, u32::from(level) + 1, kids(n), "", &base, cx)
    }

    /// 목록 하나. `depth` = 이 목록의 중첩 깊이(0 부터), `parent_num` = 바로 위 목록이 번호 목록이면 그 번호 정의 id.
    ///
    /// 항목의 **첫 문단**이 목록 문단(글머리표/번호 머리 + 깊이에 따른 왼쪽 여백)이고, 이어지는 블록은 같은 들여쓰기의 일반 블록,
    /// 안쪽 목록은 깊이 + 1 이다. 할 일은 머리 없이 "☐ "/"☑ " 글자 접두.
    fn list(&mut self, out: &mut String, n: &Value, cx: &Cx, depth: usize, parent_num: Option<u32>) -> AppResult<()> {
        // 목록 안 목록은 `block` 을 거치지 않고 곧장 재귀하므로 여기서도 깊이 예산을 먹는다(안 그러면 ~1000단 중첩에서 스택이 터진다).
        self.budget.enter()?;
        let r = self.list_inner(out, n, cx, depth, parent_num);
        self.budget.leave();
        r
    }

    fn list_inner(&mut self, out: &mut String, n: &Value, cx: &Cx, depth: usize, parent_num: Option<u32>) -> AppResult<()> {
        let kind = ty(n);
        let level = depth.min(6) as u8;
        let head: (&'static str, u32, u8) = match kind {
            "orderedList" => {
                let num = match parent_num {
                    Some(id) => id,
                    None => {
                        let start = attr_f64(n, "start").map_or(1, |s| s as i64).clamp(1, 9999);
                        self.numberings.push(NumberingDef { start });
                        // 개요가 1 번이라 목록 번호 정의는 2 부터.
                        self.numberings.len() as u32 + 1
                    }
                };
                ("NUMBER", num, level)
            }
            "bulletList" => {
                self.bullets_used = true;
                ("BULLET", 1 + depth.min(2) as u32, level)
            }
            _ => NO_HEAD,
        };
        let num_for_children = if head.0 == "NUMBER" { Some(head.1) } else { None };
        let left = cx.quote + depth as i64 + 1;
        for item in kids(n) {
            self.tick()?;
            let mut first = true;
            for child in kids(item) {
                let is_list = matches!(ty(child), "bulletList" | "orderedList" | "taskList");
                if is_list {
                    self.list(out, child, cx, depth + 1, num_for_children)?;
                } else if first && ty(child) == "paragraph" {
                    let mut pr = self.body_pr(self.align_for(child, cx), left, cx);
                    pr.head = head;
                    let prefix = if kind == "taskList" {
                        if attr(item, "checked").and_then(Value::as_bool).unwrap_or(false) {
                            "\u{2611} "
                        } else {
                            "\u{2610} "
                        }
                    } else {
                        ""
                    };
                    self.para(out, pr, 0, kids(child), prefix, &CharPr::body(), cx)?;
                } else {
                    let inner = Cx { quote: left, ..*cx };
                    self.block(out, child, &inner)?;
                }
                first = false;
            }
        }
        Ok(())
    }

    // ── 표 ────────────────────────────────────────────────────────────────

    fn table(&mut self, out: &mut String, n: &Value, cx: &Cx) -> AppResult<()> {
        // 격자 배치(점유 계산 · 구멍 메우기)는 형식 무관이라 pm.rs 에 있다. 문서 전체 노드 예산은 이 작성기의 것을 그대로 넘긴다.
        let Some(grid) = place_grid(n, &mut || self.tick())? else {
            return Ok(());
        };
        let (nrows, ncols) = (grid.nrows, grid.ncols);
        // 열 너비: colwidth(px) → HWPUNIT, 모르는 열은 평균, 넘치면 비례 축소(계산은 형식 무관이라 pm.rs).
        let avail = (cx.avail_w - cx.quote * INDENT_UNIT).max(MIN_COL_WIDTH * ncols as i64);
        let widths = column_widths(&grid, avail, HU_PER_PX, MIN_COL_WIDTH);
        let rows = grid.rows;
        let table_w: i64 = widths.iter().sum();
        let table_h = nrows as i64 * MIN_ROW_HEIGHT;
        let has_header_row = rows.first().is_some_and(|r| r.iter().any(|c| c.header));
        let solid = self.fill_id(Borders::Solid, Fill::Absent);
        let tbl_id = self.id();

        // 표는 문단 하나에 앵커한다(실제 저장본). 최상위 표는 글자처럼 취급하지 않아 쪽을 넘어 나뉜다(글자처럼 취급한 표는 쪽에서
        // 안 나뉜다 — python-hwpx known-traps). 칸 안의 표는 글자처럼 취급.
        let host = self.body_pr("LEFT", cx.quote, cx);
        let host_id = self.para_pr_id(host);
        self.p_open(out, host_id, 0);
        self.run_open(out, 0);
        let _ = write!(
            out,
            r#"<hp:tbl id="{tbl_id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="{}" rowCnt="{nrows}" colCnt="{ncols}" cellSpacing="0" borderFillIDRef="{solid}" noAdjust="0"><hp:sz width="{table_w}" widthRelTo="ABSOLUTE" height="{table_h}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="{}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="{CELL_MARGIN_LR}" right="{CELL_MARGIN_LR}" top="{CELL_MARGIN_TB}" bottom="{CELL_MARGIN_TB}"/>"#,
            u8::from(has_header_row),
            u8::from(cx.cell)
        );
        for (r, row) in rows.iter().enumerate() {
            out.push_str("<hp:tr>");
            for cell in row {
                let cell_w: i64 = widths[cell.col..cell.col + cell.colspan].iter().sum();
                let cell_h = MIN_ROW_HEIGHT * cell.rowspan as i64;
                let bg = cell.node.and_then(|n| attr_str(n, "backgroundColor")).and_then(css_color);
                // 머리글 칸은 Brise 가 굵게·옅은 회색으로 그린다 — 한글에서도 머리글 행이 구분되게 같은 모양으로(칸이 직접 정한 배경이 우선).
                let fill = match (&bg, cell.header) {
                    (Some(c), _) => Fill::Color(c.clone()),
                    (None, true) => Fill::Color("#F2F2F2".to_string()),
                    (None, false) => Fill::Absent,
                };
                let bf = self.fill_id(Borders::Solid, fill);
                let _ = write!(
                    out,
                    r#"<hp:tc name="" header="{}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="{bf}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">"#,
                    u8::from(cell.header)
                );
                let inner = Cx {
                    quote: 0,
                    avail_w: (cell_w - 2 * CELL_MARGIN_LR).max(MIN_COL_WIDTH),
                    cell: true,
                    cell_align: align_of(cell.node.and_then(|n| attr_str(n, "align"))).filter(|a| *a != "LEFT"),
                };
                let before = self.paragraphs;
                let content: &[Value] = cell.node.map_or(&[], kids);
                if cell.header {
                    // 머리글 칸의 글자는 굵게 — 굵게 마크를 얹는 대신 문단 베이스를 굵게 하는 경로가 없어 마크 목록을 합성한다.
                    let bolded = bold_all(content);
                    self.blocks(out, &bolded, &inner)?;
                } else {
                    self.blocks(out, content, &inner)?;
                }
                if self.paragraphs == before {
                    // 셀은 문단이 하나는 있어야 한다.
                    let pr = self.body_pr("LEFT", 0, &inner);
                    self.para(out, pr, 0, &[], "", &CharPr::body(), &inner)?;
                }
                let _ = write!(
                    out,
                    r#"</hp:subList><hp:cellAddr colAddr="{}" rowAddr="{r}"/><hp:cellSpan colSpan="{}" rowSpan="{}"/><hp:cellSz width="{cell_w}" height="{cell_h}"/><hp:cellMargin left="{CELL_MARGIN_LR}" right="{CELL_MARGIN_LR}" top="{CELL_MARGIN_TB}" bottom="{CELL_MARGIN_TB}"/></hp:tc>"#,
                    cell.col, cell.colspan, cell.rowspan
                );
            }
            out.push_str("</hp:tr>");
            self.preview_line_end();
        }
        out.push_str("</hp:tbl><hp:t/></hp:run></hp:p>");
        self.paragraphs += 1;
        Ok(())
    }

    // ── 그림 ──────────────────────────────────────────────────────────────

    /// 그림 한 장을 글자처럼 취급하는 개체(`hp:pic`)로. 못 넣는 그림(경로 밖·없음·상한·형식)은 `[그림: 설명]` 글자로 남기고 센다.
    ///
    /// ponytail: 대체 글자는 한국어로 고정(파일에 저장되는 데이터라 UI 로케일을 따르지 않는다 — 가져오기의 "각주" 제목과 같은 이유).
    fn pic_run(&mut self, out: &mut String, n: &Value, cx: &Cx, plain: &mut String) {
        let alt = attr_str(n, "alt").unwrap_or("").trim().to_string();
        let loaded = attr_str(n, "relPath").filter(|r| !r.is_empty()).and_then(|rel| self.imgs.load(rel));
        let Some(img) = loaded else {
            self.skipped += 1;
            let label = if alt.is_empty() { "[그림]".to_string() } else { format!("[그림: {alt}]") };
            let cp = self.chars.intern(CharPr::body());
            self.run_open(out, cp);
            out.push_str("<hp:t>");
            t_text(&label, out);
            out.push_str("</hp:t></hp:run>");
            plain.push_str(&label);
            return;
        };
        self.image_count += 1;
        // 원본 크기(HWPUNIT = px × 75) → 본문(칸) 폭의 pct% 에 원본 비율, 쪽 높이를 넘으면 줄인다.
        let (ow, oh) = ((f64::from(img.w_px) * HU_PER_PX) as i64, (f64::from(img.h_px) * HU_PER_PX) as i64);
        let (cw, ch) = fit_image(cx.avail_w, body_height(self.paper), image_pct(n), ow, oh);
        let entry_id = img_id(img.idx);
        let (pic_id, inst_id) = (self.id(), self.id());
        self.run_open(out, 0);
        let _ = write!(
            out,
            r#"<hp:pic id="{pic_id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="{inst_id}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="{ow}" height="{oh}"/><hp:curSz width="{cw}" height="{ch}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="{}" centerY="{}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="{:.6}" e2="0" e3="0" e4="0" e5="{:.6}" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="{ow}" y="0"/><hc:pt2 x="{ow}" y="{oh}"/><hc:pt3 x="0" y="{oh}"/></hp:imgRect><hp:imgClip left="0" right="{ow}" top="0" bottom="{oh}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="{ow}" dimheight="{oh}"/><hc:img binaryItemIDRef="{entry_id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/><hp:sz width="{cw}" widthRelTo="ABSOLUTE" height="{ch}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>"#,
            cw / 2,
            ch / 2,
            cw as f64 / ow as f64,
            ch as f64 / oh as f64
        );
        if !alt.is_empty() {
            // 한글의 "개체 설명" — 대체 글.
            let _ = write!(out, "<hp:shapeComment>{}</hp:shapeComment>", esc_attr(&alt));
        }
        out.push_str("</hp:pic><hp:t/></hp:run>");
    }
}

// ── 정적 부품 ─────────────────────────────────────────────────────────────────

/// 모든 XML 부품의 루트가 공유하는 네임스페이스 선언(실제 한컴 저장본).
const NS: &str = r##"xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0""##;

const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>"#;

/// 첫 문단의 첫 런에 들어가는 쪽 설정(secPr)과 단 정의 — 실제 한컴 저장본 모양 그대로, 용지 크기·방향만 다르다.
fn sec_pr_xml(paper: Paper) -> String {
    let (w, h) = page_size(paper);
    let (top, lr, bottom, header, footer) = margins(paper);
    format!(
        r##"<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="{}" width="{w}" height="{h}" gutterType="LEFT_ONLY"><hp:margin header="{header}" footer="{footer}" gutter="0" left="{lr}" right="{lr}" top="{top}" bottom="{bottom}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>"##,
        landscape_attr(paper)
    )
}

fn para_head(level: u8, start: i64, text: &str, format: &str, checkable: u8, out: &mut String) {
    let _ = write!(
        out,
        r#"<hh:paraHead start="{start}" level="{level}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="{format}" charPrIDRef="4294967295" checkable="{checkable}">{text}</hh:paraHead>"#
    );
}

/// 번호 정의 하나 — 일곱 수준(1. 가. 1) 가) (1) (가) ①)은 실제 저장본의 기본 개요 번호 모양이다.
fn numbering_xml(id: u32, first_start: i64, out: &mut String) {
    let _ = write!(out, r#"<hh:numbering id="{id}" start="0">"#);
    let levels: [(&str, &str, u8); 7] = [
        ("^1.", "DIGIT", 0),
        ("^2.", "HANGUL_SYLLABLE", 0),
        ("^3)", "DIGIT", 0),
        ("^4)", "HANGUL_SYLLABLE", 0),
        ("(^5)", "DIGIT", 0),
        ("(^6)", "HANGUL_SYLLABLE", 0),
        ("^7", "CIRCLED_DIGIT", 1),
    ];
    for (i, (text, format, checkable)) in levels.iter().enumerate() {
        para_head(i as u8 + 1, if i == 0 { first_start } else { 1 }, text, format, *checkable, out);
    }
    out.push_str("</hh:numbering>");
}

fn fontfaces_xml(out: &mut String) {
    // 면 id: 0 함초롬돋움 · 1 함초롬바탕 · 2 고정폭. 글꼴은 이름만 적는다(파일에 글꼴을 싣지 않는다).
    let font = |id: u8, face: &str, out: &mut String| {
        let _ = write!(
            out,
            r#"<hh:font id="{id}" face="{face}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="8" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>"#
        );
    };
    out.push_str(r#"<hh:fontfaces itemCnt="7">"#);
    for lang in ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"] {
        let _ = write!(out, r#"<hh:fontface lang="{lang}" fontCnt="3">"#);
        font(FONT_DOTUM, "함초롬돋움", out);
        font(FONT_BATANG, "함초롬바탕", out);
        font(FONT_MONO, MONO_FACE, out);
        out.push_str("</hh:fontface>");
    }
    out.push_str("</hh:fontfaces>");
}

/// 스타일 18개 — 실제 한컴 저장본 그대로. 글자 스타일("쪽 번호")의 `paraPrIDRef` 만 저장본마다 쓰레기 값(0 · 7864436 · 3509634932 — 읽히지
/// 않는다)이라 존재하는 id 0 으로 둔다.
const STYLES_XML: &str = r#"<hh:styles itemCnt="18"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="3" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/><hh:style id="1" type="PARA" name="본문" engName="Body" paraPrIDRef="11" charPrIDRef="0" nextStyleIDRef="1" langID="1042" lockForm="0"/><hh:style id="2" type="PARA" name="개요 1" engName="Outline 1" paraPrIDRef="10" charPrIDRef="0" nextStyleIDRef="2" langID="1042" lockForm="0"/><hh:style id="3" type="PARA" name="개요 2" engName="Outline 2" paraPrIDRef="9" charPrIDRef="0" nextStyleIDRef="3" langID="1042" lockForm="0"/><hh:style id="4" type="PARA" name="개요 3" engName="Outline 3" paraPrIDRef="8" charPrIDRef="0" nextStyleIDRef="4" langID="1042" lockForm="0"/><hh:style id="5" type="PARA" name="개요 4" engName="Outline 4" paraPrIDRef="7" charPrIDRef="0" nextStyleIDRef="5" langID="1042" lockForm="0"/><hh:style id="6" type="PARA" name="개요 5" engName="Outline 5" paraPrIDRef="6" charPrIDRef="0" nextStyleIDRef="6" langID="1042" lockForm="0"/><hh:style id="7" type="PARA" name="개요 6" engName="Outline 6" paraPrIDRef="5" charPrIDRef="0" nextStyleIDRef="7" langID="1042" lockForm="0"/><hh:style id="8" type="PARA" name="개요 7" engName="Outline 7" paraPrIDRef="4" charPrIDRef="0" nextStyleIDRef="8" langID="1042" lockForm="0"/><hh:style id="9" type="CHAR" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="1" nextStyleIDRef="0" langID="1042" lockForm="0"/><hh:style id="10" type="PARA" name="머리말" engName="Header" paraPrIDRef="2" charPrIDRef="2" nextStyleIDRef="10" langID="1042" lockForm="0"/><hh:style id="11" type="PARA" name="각주" engName="Footnote" paraPrIDRef="1" charPrIDRef="3" nextStyleIDRef="11" langID="1042" lockForm="0"/><hh:style id="12" type="PARA" name="미주" engName="Endnote" paraPrIDRef="1" charPrIDRef="3" nextStyleIDRef="12" langID="1042" lockForm="0"/><hh:style id="13" type="PARA" name="메모" engName="Memo" paraPrIDRef="0" charPrIDRef="4" nextStyleIDRef="13" langID="1042" lockForm="0"/><hh:style id="14" type="PARA" name="차례 제목" engName="TOC Heading" paraPrIDRef="12" charPrIDRef="5" nextStyleIDRef="14" langID="1042" lockForm="0"/><hh:style id="15" type="PARA" name="차례 1" engName="TOC 1" paraPrIDRef="13" charPrIDRef="6" nextStyleIDRef="15" langID="1042" lockForm="0"/><hh:style id="16" type="PARA" name="차례 2" engName="TOC 2" paraPrIDRef="14" charPrIDRef="6" nextStyleIDRef="16" langID="1042" lockForm="0"/><hh:style id="17" type="PARA" name="차례 3" engName="TOC 3" paraPrIDRef="15" charPrIDRef="6" nextStyleIDRef="17" langID="1042" lockForm="0"/></hh:styles>"#;

/// 글머리표 정의 3개(● ○ ■ — 목록 깊이 0 · 1 · 2+). 속성은 hwpxlib BulletWriter / 한컴 저장본의 `hh:bullet`.
fn bullets_xml(out: &mut String) {
    out.push_str(r#"<hh:bullets itemCnt="3">"#);
    for (i, ch) in ["\u{25CF}", "\u{25CB}", "\u{25A0}"].iter().enumerate() {
        let _ = write!(
            out,
            r#"<hh:bullet id="{}" char="{ch}" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/></hh:bullet>"#,
            i + 1
        );
    }
    out.push_str("</hh:bullets>");
}

impl Writer<'_> {
    /// 레지스트리 → header.xml. refList 순서는 글꼴 → 테두리 → 글자 모양 → 탭 → 번호 → 글머리표 → 문단 모양 → 스타일.
    fn header_xml(&self) -> String {
        let mut o = String::with_capacity(48 * 1024);
        o.push_str(XML_DECL);
        let _ = write!(o, r#"<hh:head {NS} version="1.4" secCnt="1">"#);
        o.push_str(r#"<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>"#);
        fontfaces_xml(&mut o);
        let _ = write!(o, r#"<hh:borderFills itemCnt="{}">"#, self.fills.items.len());
        for (i, f) in self.fills.items.iter().enumerate() {
            f.xml(self.fills.base + i as u32, &mut o);
        }
        o.push_str("</hh:borderFills>");
        let _ = write!(o, r#"<hh:charProperties itemCnt="{}">"#, self.chars.items.len());
        for (i, c) in self.chars.items.iter().enumerate() {
            c.xml(i as u32, &mut o);
        }
        o.push_str("</hh:charProperties>");
        o.push_str(r#"<hh:tabProperties itemCnt="2"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/></hh:tabProperties>"#);
        let _ = write!(o, r#"<hh:numberings itemCnt="{}">"#, 1 + self.numberings.len());
        numbering_xml(1, 1, &mut o);
        for (i, d) in self.numberings.iter().enumerate() {
            numbering_xml(i as u32 + 2, d.start, &mut o);
        }
        o.push_str("</hh:numberings>");
        if self.bullets_used {
            bullets_xml(&mut o);
        }
        let _ = write!(o, r#"<hh:paraProperties itemCnt="{}">"#, self.paras.items.len());
        for (i, p) in self.paras.items.iter().enumerate() {
            p.xml(i as u32, &mut o);
        }
        o.push_str("</hh:paraProperties>");
        o.push_str(STYLES_XML);
        o.push_str("</hh:refList>");
        o.push_str(r#"<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>"#);
        o
    }
}

/// 한국어 날짜 문자열("2023년 2월 14일 화요일 오후 1:40:00") — content.hpf 의 `date` 메타.
fn korean_date(now: chrono::DateTime<chrono::Local>) -> String {
    use chrono::{Datelike, Timelike};
    const DAYS: [&str; 7] = ["월", "화", "수", "목", "금", "토", "일"];
    let h = now.hour();
    let (ampm, h12) = (if h < 12 { "오전" } else { "오후" }, if h % 12 == 0 { 12 } else { h % 12 });
    format!(
        "{}년 {}월 {}일 {}요일 {ampm} {h12}:{:02}:{:02}",
        now.year(),
        now.month(),
        now.day(),
        DAYS[now.weekday().num_days_from_monday() as usize],
        now.minute(),
        now.second()
    )
}

/// manifest id / `binaryItemIDRef` ("image1") · zip 안 경로("BinData/image1.png") · media-type — 그림 적재(`ImageStore`)는 확장자만 들고 있다.
fn img_id(idx: usize) -> String {
    format!("image{}", idx + 1)
}

fn img_file(idx: usize, img: &ImgEntry) -> String {
    format!("BinData/image{}.{}", idx + 1, img.ext)
}

/// media-type 은 실제 한컴 저장본의 표기를 따른다(jpg 는 `image/jpg`).
fn media_of(ext: &str) -> &'static str {
    match ext {
        "jpg" => "image/jpg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

fn content_hpf(title: &str, images: &[ImgEntry]) -> String {
    let now = super::export_now().with_timezone(&chrono::Local);
    let iso = now.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut o = String::new();
    o.push_str(XML_DECL);
    let _ = write!(o, r#"<opf:package {NS} version="" unique-identifier="" id="">"#);
    o.push_str("<opf:metadata>");
    if title.trim().is_empty() {
        o.push_str("<opf:title/>");
    } else {
        let _ = write!(o, "<opf:title>{}</opf:title>", {
            let mut t = String::new();
            esc_into(title.trim(), &mut t, false);
            t
        });
    }
    let _ = write!(
        o,
        r#"<opf:language>ko</opf:language><opf:meta name="creator" content="text"/><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text"/><opf:meta name="CreatedDate" content="text">{iso}</opf:meta><opf:meta name="ModifiedDate" content="text">{iso}</opf:meta><opf:meta name="date" content="text">{}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata>"#,
        korean_date(now)
    );
    o.push_str(r#"<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>"#);
    for (i, img) in images.iter().enumerate() {
        let _ = write!(o, r#"<opf:item id="{}" href="{}" media-type="{}" isEmbeded="1"/>"#, img_id(i), img_file(i, img), media_of(img.ext));
    }
    o.push_str(r#"<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>"#);
    o
}

/// version.xml — 형식 버전(major/minor/micro, xmlVersion)은 실제 저장본 값 그대로, 만든 앱(`application`·`appVersion`)은 우리 이름이다
/// (이 두 속성은 정보용 문자열이다 — hwpjs 의 version 리더도 "없을 수 있는 문자열"로만 다룬다).
fn version_xml() -> String {
    format!(
        r#"{XML_DECL}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="0" micro="5" buildNumber="0" os="1" xmlVersion="1.4" application="Brise" appVersion="{}"/>"#,
        env!("CARGO_PKG_VERSION")
    )
}
const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>"#;
const MANIFEST_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>"#;
const SETTINGS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>"#;

/// zip 으로 묶는다. **`mimetype` 이 첫 엔트리 · 무압축 · 값 `application/hwp+zip`**(확장 필드 없음). 엔트리 시각은 1980-01-01 로
/// 고정하고(실제 저장본도 그렇다) 엔트리 순서는 실제 저장본 순서다. 문서 메타(content.hpf 의 날짜)에는 현재 시각이 들어간다.
fn package<W: std::io::Write + std::io::Seek>(w: &Writer, title: &str, section_xml: &str, sink: W) -> AppResult<W> {
    let mut zw = ZipOut::new(sink);
    zw.put("mimetype", true, b"application/hwp+zip")?;
    // 실제 한컴 저장본 9/9 가 version.xml 도 mimetype 처럼 무압축(stored)이다 — 공짜로 맞춘다(W3 검증).
    zw.put("version.xml", true, version_xml().as_bytes())?;
    zw.put("Contents/header.xml", false, w.header_xml().as_bytes())?;
    for (i, img) in w.imgs.entries.iter().enumerate() {
        // 이미 압축된 형식(png·jpg·gif)은 다시 압축하지 않는다.
        zw.put(&img_file(i, img), img.ext != "bmp", &img.bytes)?;
    }
    zw.put("Contents/section0.xml", false, section_xml.as_bytes())?;
    zw.put("Preview/PrvText.txt", false, w.preview.as_bytes())?;
    zw.put("settings.xml", false, SETTINGS_XML.as_bytes())?;
    zw.put("META-INF/container.xml", false, CONTAINER_XML.as_bytes())?;
    zw.put("Contents/content.hpf", false, content_hpf(title, &w.imgs.entries).as_bytes())?;
    zw.put("META-INF/manifest.xml", false, MANIFEST_XML.as_bytes())?;
    zw.finish()
}

// ── 진입점 ────────────────────────────────────────────────────────────────────

/// 섹션들 → .hwpx 바이트. **순수** — 파일·DB 를 건드리지 않는다(그림은 `resolve` 가 relPath → 바이트로 읽는다; 못 읽으면 None).
///
/// 섹션이 둘 이상이면 섹션 이름을 제목 1 문단으로 앞에 둔다. 노트 제목(`title`)은 본문에 넣지 않고 문서 정보(opf:title)에만 쓴다.
pub fn build(title: &str, sections: &[DocExportSection], paper: Paper, resolve: &super::Resolver<'_>) -> AppResult<Built> {
    let (sink, image_count, skipped_images) = build_into(title, sections, paper, resolve, std::io::Cursor::new(Vec::new()))?;
    Ok(Built { bytes: sink.into_inner(), image_count, skipped_images })
}

/// `build` 와 같은 조립을 `sink`(예: tmp 파일)로 바로 쓴다 — zip 을 메모리에 모으지 않는다(E-2). `(sink, 그림 수, 건너뛴 그림 수)`.
/// 그림은 조립 전에 병렬로 미리 읽는다(E-3).
pub fn build_into<W: std::io::Write + std::io::Seek>(
    title: &str,
    sections: &[DocExportSection],
    paper: Paper,
    resolve: &super::Resolver<'_>,
    sink: W,
) -> AppResult<(W, usize, usize)> {
    super::validate_sections(sections)?;
    let mut w = Writer::new(paper, resolve);
    w.imgs.prefill(super::prefetch_images(sections, resolve));
    let cx = Cx { quote: 0, avail_w: body_width(paper), cell: false, cell_align: None };
    let mut body = String::new();
    for s in sections {
        if let Some(name) = section_heading(sections, s) {
            w.block(&mut body, &name, &cx)?;
        }
        w.blocks(&mut body, kids(&s.doc), &cx)?;
    }
    if w.paragraphs == 0 {
        // 내용이 하나도 없어도 쪽 설정을 실을 문단은 있어야 한다.
        let pr = w.body_pr("LEFT", 0, &cx);
        w.para(&mut body, pr, 0, &[], "", &CharPr::body(), &cx)?;
    }
    let mut section_xml = String::with_capacity(body.len() + 2048);
    section_xml.push_str(XML_DECL);
    let _ = write!(section_xml, "<hs:sec {NS}>");
    section_xml.push_str(&body);
    section_xml.push_str("</hs:sec>");
    let sink = package(&w, title, &section_xml, sink)?;
    Ok((sink, w.image_count, w.skipped))
}

// ── 테스트 ────────────────────────────────────────────────────────────────────
//
// 세 가지를 본다 — ① 구조: 만든 zip 이 한컴 저장본의 약속(mimetype 첫 엔트리·무압축, manifest ↔ 엔트리, 개수 속성, 모든 *IDRef 가
// 가리키는 곳에 항목이 있음, XML 이 끝까지 읽힘). ② 왕복: W1 의 `doc_import::hwpx::parse_file` 로 다시 읽어 내용·병합·정렬·목록이
// 같은지. ③ 안전: 이스케이프·불법 글자·링크 범위·그림 경로 탈출·상한.
// 한글이 없는 환경이라 "한글이 열린다"는 여기서 보증하지 못한다 — `HWPX_EXPORT_SAMPLE_OUT` 샘플을 한컴 뷰어로 열어 확인한다.
#[cfg(test)]
pub(crate) mod tests {
    use super::super::testutil::{
        attr_vals, count, entries, image_node, mark, mutate, nested_lists, no_images, p, part, png_bytes, real_resolver, real_section, sample_main,
        sample_picture, sample_png, sec, table_of, tcell, trow, walk, REAL_PM,
    };
    use super::super::MAX_SECTIONS;
    use super::*;
    use crate::error::AppError;
    use crate::repo::doc_import::{hwpx::parse_file, SavedImage};
    use serde_json::json;
    use std::io::Cursor;

    fn build_doc(content: Vec<Value>) -> Built {
        build("제목", &[sec("s", content)], Paper::A4Portrait, &no_images).unwrap()
    }

    fn real_build() -> Built {
        build("제목", &[real_section()], Paper::A4Portrait, &real_resolver).unwrap()
    }

    fn reimport(bytes: &[u8]) -> String {
        let mut f = tempfile::Builder::new().suffix(".hwpx").tempfile().unwrap();
        std::io::Write::write_all(&mut f, bytes).unwrap();
        let parsed = parse_file(f.path()).unwrap();
        let atts: Vec<SavedImage> =
            parsed.images.iter().enumerate().map(|(i, im)| SavedImage { rel_path: format!("n/{i}-{}", im.name), name: im.name.clone() }).collect();
        parsed.render(&atts)
    }

    // ── ① 구조 ────────────────────────────────────────────────────────────

    #[test]
    fn mimetype_is_the_first_stored_entry_with_no_extra_field() {
        let b = build_doc(vec![p("x")]).bytes;
        // 로컬 파일 헤더: 오프셋 8 = 압축 방식(0 = Stored), 26..28 = 이름 길이, 28..30 = 확장 필드 길이, 30.. = 이름, 그 뒤 = 데이터.
        assert_eq!(&b[0..4], b"PK\x03\x04");
        assert_eq!(u16::from_le_bytes([b[8], b[9]]), 0, "mimetype must be stored");
        assert_eq!(u16::from_le_bytes([b[26], b[27]]), 8);
        assert_eq!(u16::from_le_bytes([b[28], b[29]]), 0, "no extra field");
        assert_eq!(&b[30..38], b"mimetype");
        assert_eq!(&b[38..57], b"application/hwp+zip");
        let names: Vec<String> = entries(&b).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names[0], "mimetype");
        for need in ["version.xml", "Contents/header.xml", "Contents/section0.xml", "Contents/content.hpf", "settings.xml", "Preview/PrvText.txt", "META-INF/container.xml", "META-INF/manifest.xml"] {
            assert!(names.iter().any(|n| n == need), "{need} missing from {names:?}");
        }
    }

    /// 한컴 저장본의 약속을 확인하는 구조 검사 — 개수 속성, id 연속성, 헤더 안 참조, 본문 → 헤더 참조, manifest ↔ zip, 필드 짝.
    pub(crate) fn assert_package_consistent(bytes: &[u8]) {
        let ents = entries(bytes);
        let names: Vec<&str> = ents.iter().map(|(n, _)| n.as_str()).collect();
        // 모든 XML 부품이 끝까지 읽힌다.
        for (n, v) in &ents {
            if n.ends_with(".xml") || n.ends_with(".hpf") {
                walk(std::str::from_utf8(v).unwrap(), |_, _| {});
            }
        }
        let hpf = part(bytes, "Contents/content.hpf");
        let header = part(bytes, "Contents/header.xml");
        let section = part(bytes, "Contents/section0.xml");
        // manifest 의 모든 item 이 zip 에 있다.
        let hrefs = attr_vals(&hpf, "item", "href");
        assert!(!hrefs.is_empty());
        for h in &hrefs {
            assert!(names.contains(&h.as_str()), "manifest item {h} has no zip entry ({names:?})");
        }
        let manifest_ids = attr_vals(&hpf, "item", "id");
        // 개수 속성 = 실제 항목 수.
        for (container, child) in [
            ("fontfaces", "fontface"),
            ("borderFills", "borderFill"),
            ("charProperties", "charPr"),
            ("tabProperties", "tabPr"),
            ("numberings", "numbering"),
            ("bullets", "bullet"),
            ("paraProperties", "paraPr"),
            ("styles", "style"),
        ] {
            let cnt = attr_vals(&header, container, "itemCnt");
            if cnt.is_empty() {
                continue;
            }
            assert_eq!(cnt[0].parse::<usize>().unwrap(), count(&header, child), "{container} itemCnt");
        }
        for c in attr_vals(&header, "fontface", "fontCnt") {
            assert_eq!(c, "3");
        }
        let n_font = 3usize;
        let n_char = count(&header, "charPr");
        let n_para = count(&header, "paraPr");
        let n_style = count(&header, "style");
        // id 는 연속이다: 글자/문단 모양 0.. · 테두리/번호 1..
        assert_eq!(attr_vals(&header, "charPr", "id"), (0..n_char).map(|i| i.to_string()).collect::<Vec<_>>());
        assert_eq!(attr_vals(&header, "paraPr", "id"), (0..n_para).map(|i| i.to_string()).collect::<Vec<_>>());
        let fills = attr_vals(&header, "borderFill", "id");
        assert_eq!(fills, (1..=fills.len()).map(|i| i.to_string()).collect::<Vec<_>>());
        let numbering_ids = attr_vals(&header, "numbering", "id");
        assert_eq!(numbering_ids, (1..=numbering_ids.len()).map(|i| i.to_string()).collect::<Vec<_>>());
        let bullet_ids = attr_vals(&header, "bullet", "id");
        // 헤더 안 참조.
        for v in attr_vals(&header, "charPr", "borderFillIDRef").into_iter().chain(attr_vals(&header, "border", "borderFillIDRef")) {
            assert!(fills.contains(&v), "header borderFillIDRef {v}");
        }
        for k in ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"] {
            for v in attr_vals(&header, "fontRef", k) {
                assert!(v.parse::<usize>().unwrap() < n_font, "fontRef {k}={v}");
            }
        }
        walk(&header, |n, a| {
            let get = |k: &str| a.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
            match n {
                "style" => {
                    assert!(get("charPrIDRef").unwrap().parse::<usize>().unwrap() < n_char, "style charPrIDRef");
                    assert!(get("paraPrIDRef").unwrap().parse::<usize>().unwrap() < n_para, "style paraPrIDRef");
                    assert!(get("nextStyleIDRef").unwrap().parse::<usize>().unwrap() < n_style);
                }
                "heading" => {
                    let id = get("idRef").unwrap();
                    match get("type").unwrap() {
                        "NUMBER" => assert!(numbering_ids.iter().any(|x| x == id), "heading NUMBER idRef {id}"),
                        "BULLET" => assert!(bullet_ids.iter().any(|x| x == id), "heading BULLET idRef {id}"),
                        _ => assert_eq!(id, "0"),
                    }
                }
                // 4294967295 = "문단 글자 모양을 따른다"(한컴 값).
                "paraHead" => assert_eq!(get("charPrIDRef"), Some("4294967295")),
                _ => {}
            }
        });
        for v in attr_vals(&header, "paraPr", "tabPrIDRef") {
            assert!(v == "0" || v == "1");
        }
        // 본문 → 헤더 참조.
        for v in attr_vals(&section, "run", "charPrIDRef") {
            assert!(v.parse::<usize>().unwrap() < n_char, "run charPrIDRef {v}");
        }
        for v in attr_vals(&section, "p", "paraPrIDRef") {
            assert!(v.parse::<usize>().unwrap() < n_para, "p paraPrIDRef {v}");
        }
        for v in attr_vals(&section, "p", "styleIDRef") {
            assert!(v.parse::<usize>().unwrap() < n_style, "p styleIDRef {v}");
        }
        for k in ["tbl", "tc", "pageBorderFill"] {
            for v in attr_vals(&section, k, "borderFillIDRef") {
                assert!(fills.contains(&v), "{k} borderFillIDRef {v}");
            }
        }
        for v in attr_vals(&section, "secPr", "outlineShapeIDRef") {
            assert!(numbering_ids.contains(&v));
        }
        for v in attr_vals(&section, "img", "binaryItemIDRef") {
            assert!(manifest_ids.contains(&v), "binaryItemIDRef {v} not in manifest");
        }
        // 필드는 짝이 맞는다.
        assert_eq!(attr_vals(&section, "fieldBegin", "id"), attr_vals(&section, "fieldEnd", "beginIDRef"));
        // 쪽 설정(secPr)은 정확히 한 번, 문서 맨 앞 문단에.
        assert_eq!(count(&section, "secPr"), 1);
        let first_p = section.find("<hp:p ").unwrap();
        assert!(section[first_p..].find("<hp:secPr").unwrap() < section[first_p..].find("</hp:p>").unwrap());
        // 표: 선언한 행 수 = 실제 tr 수.
        let rows: usize = attr_vals(&section, "tbl", "rowCnt").iter().map(|v| v.parse::<usize>().unwrap()).sum();
        assert_eq!(rows, count(&section, "tr"));
    }

    #[test]
    fn real_prosemirror_dump_produces_a_consistent_package() {
        let b = real_build();
        assert_eq!((b.image_count, b.skipped_images), (1, 0));
        assert_package_consistent(&b.bytes);
        let hpf = part(&b.bytes, "Contents/content.hpf");
        assert!(hpf.contains(r#"<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/>"#), "{hpf}");
        assert!(hpf.contains("<opf:title>제목</opf:title>"));
        // version.xml · header.xml 은 한컴 오타 속성명 그대로.
        assert!(part(&b.bytes, "version.xml").contains("tagetApplication=\"WORDPROCESSOR\""));
        assert!(part(&b.bytes, "Contents/header.xml").contains("<hh:trackchageConfig flags=\"56\"/>"));
        // BinData 는 PNG 바이트 그대로.
        let png = entries(&b.bytes).into_iter().find(|(n, _)| n == "BinData/image1.png").unwrap().1;
        assert_eq!(png, png_bytes());
    }

    #[test]
    fn preview_text_has_the_body_start_in_utf8_with_crlf_and_is_capped() {
        let long = "가".repeat(3000);
        let b = build_doc(vec![p("첫 문단"), p(&long)]);
        let t = part(&b.bytes, "Preview/PrvText.txt");
        assert!(t.starts_with("첫 문단\r\n"), "{t:?}");
        assert!(t.chars().count() <= MAX_PREVIEW_CHARS + 2, "{}", t.chars().count());
        // 표는 칸마다 `<글>` 이고 행이 끝날 때 줄바꿈(실제 저장본: `<1><2><3>CRLF<5><4>CRLF`), 빈 문단은 빈 줄.
        let cell = |t: &str| json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [p(t)] });
        let table = json!({ "type": "table", "content": [
            { "type": "tableRow", "content": [cell("이름"), cell("값")] }, { "type": "tableRow", "content": [cell("a"), cell("b")] }] });
        let empty = json!({ "type": "paragraph" });
        let t = part(&build_doc(vec![p("앞"), table, empty, p("뒤")]).bytes, "Preview/PrvText.txt");
        assert_eq!(t, "앞\r\n<이름><값>\r\n<a><b>\r\n\r\n뒤\r\n");
    }

    #[test]
    fn landscape_swaps_the_page_size_and_uses_narrowly() {
        let portrait = part(&build_doc(vec![p("x")]).bytes, "Contents/section0.xml");
        assert!(portrait.contains(r#"<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/>"#), "{portrait}");
        let l = build("t", &[sec("s", vec![p("x")])], Paper::A4Landscape, &no_images).unwrap();
        let landscape = part(&l.bytes, "Contents/section0.xml");
        assert!(landscape.contains(r#"landscape="NARROWLY" width="84188" height="59528""#), "{landscape}");
        assert_package_consistent(&l.bytes);
        assert!(matches!(Paper::parse("a5", "normal"), Err(AppError::Validation(_))));
        assert!(matches!(Paper::parse("a4-portrait", "tight"), Err(AppError::Validation(_))));
    }

    #[test]
    fn paper_size_and_margin_presets_reach_the_page_setup() {
        let setup = |paper: &str, margin: &str| {
            let b = build("t", &[sec("s", vec![p("x")])], Paper::parse(paper, margin).unwrap(), &no_images).unwrap();
            assert_package_consistent(&b.bytes);
            part(&b.bytes, "Contents/section0.xml")
        };
        let letter = setup("letter-portrait", "narrow");
        assert!(letter.contains(r#"<hp:pagePr landscape="WIDELY" width="61200" height="79200" gutterType="LEFT_ONLY"><hp:margin header="0" footer="0" gutter="0" left="3600" right="3600" top="3600" bottom="3600"/>"#), "{letter}");
        let b5 = setup("b5-landscape", "wide");
        assert!(b5.contains(r#"<hp:pagePr landscape="NARROWLY" width="72850" height="51591" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="14400" right="14400" top="5668" bottom="4252"/>"#), "{b5}");
        // 좁은 여백이면 본문 폭이 넓어진다 — 표·그림 맞춤이 같은 값을 쓴다.
        assert!(body_width(Paper::parse("a4-portrait", "narrow").unwrap()) > body_width(Paper::A4Portrait));
        assert!(body_width(Paper::parse("a4-portrait", "wide").unwrap()) < body_width(Paper::A4Portrait));
    }

    #[test]
    fn empty_document_still_carries_the_page_setup() {
        let b = build("t", &[sec("s", vec![])], Paper::A4Portrait, &no_images).unwrap();
        assert_package_consistent(&b.bytes);
        assert_eq!(count(&part(&b.bytes, "Contents/section0.xml"), "p"), 1);
    }

    // ── 서식 매핑 · 왕복 ──────────────────────────────────────────────────

    #[test]
    fn headings_map_to_outline_styles_with_larger_bold_dotum() {
        let h = |lvl: u32, t: &str| json!({ "type": "heading", "attrs": { "level": lvl, "textAlign": "left", "indent": 0 }, "content": [{ "type": "text", "text": t }] });
        let b = build_doc(vec![h(1, "하나"), h(2, "둘"), h(3, "셋"), h(5, "다섯"), p("본문")]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(attr_vals(&s, "p", "styleIDRef"), vec!["2", "3", "4", "4", "0"]);
        let header = part(&b.bytes, "Contents/header.xml");
        for lvl in ["0", "1", "2"] {
            assert!(header.contains(&format!(r#"<hh:heading type="OUTLINE" idRef="0" level="{lvl}"/>"#)));
        }
        for height in ["1600", "1400", "1200"] {
            assert!(header.contains(&format!(r##"height="{height}" textColor="#000000""##)), "{height}");
        }
        assert!(header.contains("<hh:bold/>"));
        assert_package_consistent(&b.bytes);
        // 왕복: 제목 수준이 돌아온다(다섯째는 3 으로 접힌다).
        let html = reimport(&b.bytes);
        assert!(html.starts_with("<h1>하나</h1>\n<h2>둘</h2>\n<h3>셋</h3>\n<h3>다섯</h3>\n<p>본문</p>"), "{html}");
    }

    #[test]
    fn marks_alignment_indent_and_links_round_trip() {
        let html = reimport(&real_build().bytes);
        assert!(html.contains("<h1>제목 1</h1>"), "{html}");
        assert!(html.contains(r#"<h2 data-brise-align="center" style="text-align: center;">가운데 제목</h2>"#), "{html}");
        // 양쪽 정렬 + 들여쓰기 2단 + 마크들.
        assert!(
            html.contains(r#"<p data-brise-align="justify" data-brise-indent="2" style="text-align: justify; margin-left: 4em;">양쪽 <strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소</s> <mark>형광</mark> "#),
            "{html}"
        );
        assert!(html.contains(r#"<span style="color: #ff0000">빨강</span> <span style="color: #008000">초록</span> "#), "{html}");
        assert!(html.contains(r#"<a href="https://example.com/a?b=1&amp;c=2">링크</a> code<br>다음줄</p>"#), "{html}");
    }

    #[test]
    fn lists_nest_and_tasks_and_code_survive() {
        let html = reimport(&real_build().bytes);
        assert!(html.contains("<ul><li><p>가</p><ul><li><p>가1</p></li></ul></li><li><p>나</p></li></ul>"), "{html}");
        assert!(html.contains("<ol><li><p>하나</p><ol><li><p>중첩</p></li></ol></li></ol>"), "{html}");
        // 할 일은 글자 접두, 코드는 줄마다 문단, 인용·접기는 들여쓴 문단.
        assert!(html.contains("☑ done</p>") && html.contains("☐ todo</p>"), "{html}");
        assert!(html.contains("<p>const a = 1;</p>") && html.contains("<p>  if (a) {}</p>"), "{html}");
        assert!(html.contains(r#"<p data-brise-indent="1" style="margin-left: 2em;">인용</p>"#), "{html}");
        assert!(html.contains("<p><strong>요약</strong></p>") && html.contains(r#"<p data-brise-indent="1" style="margin-left: 2em;">내용</p>"#), "{html}");
    }

    #[test]
    fn merged_table_background_colwidth_and_nested_table_round_trip() {
        let html = reimport(&real_build().bytes);
        // 머리글 칸은 굵게(Brise 가 그리는 모양), 병합·배경·열 너비(100px = 7500 HWPUNIT)·중첩 표가 그대로.
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
    fn table_cell_addresses_follow_the_occupancy_grid() {
        let s = part(&real_build().bytes, "Contents/section0.xml");
        // 바깥 표 3행×3열 + 안쪽 표 1×1. 병합에 가려진 칸은 파일에 없다.
        assert_eq!(attr_vals(&s, "tbl", "rowCnt"), vec!["3", "1"]);
        assert_eq!(attr_vals(&s, "tbl", "colCnt"), vec!["3", "1"]);
        let mut addrs = Vec::new();
        let mut spans = Vec::new();
        walk(&s, |n, a| {
            if n == "cellAddr" {
                addrs.push(format!("{},{}", a[0].1, a[1].1));
            }
            if n == "cellSpan" {
                spans.push((a[0].1.clone(), a[1].1.clone()));
            }
        });
        // 문서 순서: AB(0,0) C(2,0) / 1(0,1) 2(1,1) 3(2,1) / 5(1,2) 중첩표 칸(2,2) — 안쪽 표의 칸(0,0)은 중첩표 칸 안에서 먼저 끝난다.
        assert_eq!(addrs, vec!["0,0", "2,0", "0,1", "1,1", "2,1", "1,2", "0,0", "2,2"]);
        assert_eq!(spans[0], ("2".to_string(), "1".to_string()));
        assert!(spans.contains(&("1".to_string(), "2".to_string())));
        // 표 폭은 본문 폭을 넘지 않는다.
        for w in attr_vals(&s, "sz", "width") {
            assert!(w.parse::<i64>().unwrap() <= body_width(Paper::A4Portrait), "{w}");
        }
    }

    // ── 표 격자 불변식 — raw HTML 표 / 큰 colwidth ────────────────────────

    /// 표마다 rowCnt×colCnt 격자를 칸 주소·병합으로 칠해 (구멍, 겹침, 넘침) 칸 수를 센다. 중첩 표가 없는 문서용(`tbl` 시작마다 새 격자).
    fn grid_faults(section_xml: &str) -> Vec<(usize, usize, usize)> {
        struct T {
            rows: usize,
            cols: usize,
            spans: Vec<(usize, usize, usize, usize)>,
        }
        let mut tables: Vec<T> = Vec::new();
        let mut addr = (0usize, 0usize);
        walk(section_xml, |n, a| {
            let get = |k: &str| a.iter().find(|(key, _)| key == k).map(|(_, v)| v.parse::<usize>().unwrap()).unwrap();
            match n {
                "tbl" => tables.push(T { rows: get("rowCnt"), cols: get("colCnt"), spans: Vec::new() }),
                "cellAddr" => addr = (get("colAddr"), get("rowAddr")),
                "cellSpan" => tables.last_mut().unwrap().spans.push((addr.0, addr.1, get("colSpan"), get("rowSpan"))),
                _ => {}
            }
        });
        tables
            .iter()
            .map(|t| {
                let mut grid = vec![0u32; t.rows * t.cols];
                let mut exceed = 0;
                for &(c, r, cs, rs) in &t.spans {
                    for rr in r..r + rs {
                        for cc in c..c + cs {
                            if rr >= t.rows || cc >= t.cols {
                                exceed += 1;
                            } else {
                                grid[rr * t.cols + cc] += 1;
                            }
                        }
                    }
                }
                (grid.iter().filter(|n| **n == 0).count(), grid.iter().filter(|n| **n > 1).count(), exceed)
            })
            .collect()
    }

    #[test]
    fn ragged_raw_html_tables_get_their_grid_holes_filled() {
        // `<table><tr><td>a<td>b<td>c</tr><tr><td>d</tr>` — 마크다운 파이프 표는 파서가 채우지만 raw HTML 표는 짧은 행을 그대로 둔다.
        let ragged = table_of(vec![
            trow(vec![tcell("a", 1, 1, Value::Null), tcell("b", 1, 1, Value::Null), tcell("c", 1, 1, Value::Null)]),
            trow(vec![tcell("d", 1, 1, Value::Null)]),
        ]);
        let b = build_doc(vec![ragged]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(attr_vals(&s, "tbl", "rowCnt"), vec!["2"]);
        assert_eq!(attr_vals(&s, "tbl", "colCnt"), vec!["3"]);
        assert_eq!(grid_faults(&s), vec![(0, 0, 0)]);
        // 모든 격자 자리에 칸이 하나씩 — 합성한 빈 칸 둘이 둘째 행 끝에 열 순서대로.
        assert_eq!(count(&s, "tc"), 6);
        assert_eq!(attr_vals(&s, "cellAddr", "colAddr"), vec!["0", "1", "2", "0", "1", "2"]);
        assert_eq!(attr_vals(&s, "cellAddr", "rowAddr"), vec!["0", "0", "0", "1", "1", "1"]);
        assert_package_consistent(&b.bytes);
        // 합성한 칸에도 문단이 하나는 있다(문단 없는 칸 금지) — 칸 6개 = 문단 6개 + 표를 앵커한 문단 1개.
        assert_eq!(count(&s, "p"), 7);
        let html = reimport(&b.bytes);
        assert!(html.contains(">d<") && html.matches("<td").count() + html.matches("<th").count() == 6, "{html}");
    }

    #[test]
    fn short_rowspans_empty_rows_and_huge_colspans_leave_no_grid_holes() {
        // 첫 행이 빈 `<tr>`, 둘째 행은 한 칸.
        let empty_first = table_of(vec![trow(vec![]), trow(vec![tcell("x", 1, 1, Value::Null)])]);
        // rowspan 이 다음 행 한 칸만 가리고 그 행이 짧다.
        let short_rowspan = table_of(vec![
            trow(vec![tcell("a", 1, 1, Value::Null), tcell("b", 1, 1, Value::Null), tcell("c", 1, 2, Value::Null)]),
            trow(vec![tcell("d", 1, 1, Value::Null)]),
        ]);
        // 열이 50 개인 행 하나와 한 칸짜리 행.
        let wide = table_of(vec![trow(vec![tcell("w", 50, 1, Value::Null)]), trow(vec![tcell("n", 1, 1, Value::Null)])]);
        // 둘째 행이 위 행의 rowspan 에 다 가려져 자기 칸이 없는 행.
        let covered_row = table_of(vec![trow(vec![tcell("a", 2, 2, Value::Null)]), trow(vec![])]);
        let b = build_doc(vec![empty_first, short_rowspan, wide, covered_row]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(grid_faults(&s), vec![(0, 0, 0); 4]);
        assert_eq!(attr_vals(&s, "tbl", "colCnt"), vec!["1", "3", "50", "2"]);
        // 병합에 완전히 가려진 행(`covered_row` 의 둘째 행)은 빈 `<hp:tr>` 로 나가지 않고 걷힌다 — rowCnt 에서 빠지고 걸친 칸의 rowSpan 이 준다(W4-RE).
        assert_eq!(attr_vals(&s, "tbl", "rowCnt"), vec!["2", "2", "2", "1"]);
        assert_eq!(count(&s, "tr"), 7);
        assert_eq!(attr_vals(&s, "cellSpan", "rowSpan").last().map(String::as_str), Some("1"), "{s}");
        assert_package_consistent(&b.bytes);
    }

    #[test]
    fn rows_fully_covered_by_a_merge_are_dropped_and_the_spanning_cells_shrink() {
        // 빈 `<tr>` 이어도 병합에 덮이지 않은 자리가 있으면 행은 남는다(빈 칸으로 메워진다) — 걷는 건 **전 열이 가려진** 행뿐이다.
        let kept = table_of(vec![
            trow(vec![tcell("a", 1, 3, Value::Null), tcell("b", 1, 1, Value::Null)]),
            trow(vec![]),
            trow(vec![tcell("c", 1, 1, Value::Null)]),
        ]);
        // x 가 열 0 을 3행, y 가 열 1 을 2행 덮어 둘째 행은 전 열이 가려졌다 — 걷히고 x 는 2행, y 는 1행으로 준다.
        let covered = table_of(vec![
            trow(vec![tcell("x", 1, 3, Value::Null), tcell("y", 1, 2, Value::Null)]),
            trow(vec![]),
            trow(vec![tcell("z", 1, 1, Value::Null)]),
        ]);
        let b = build_doc(vec![kept, covered]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(attr_vals(&s, "tbl", "rowCnt"), vec!["3", "2"]);
        assert_eq!(grid_faults(&s), vec![(0, 0, 0); 2]);
        assert_package_consistent(&b.bytes);
        // 왕복: 데이터가 한 칸씩 밀리지 않는다 — 가져오면 셀 문자가 같은 순서로 남는다.
        let html = reimport(&b.bytes);
        for ch in ["a", "b", "c", "x", "y", "z"] {
            assert!(html.contains(&format!(">{ch}<")), "{ch} in {html}");
        }
    }

    #[test]
    fn colspan_over_a_vertically_merged_column_is_cut_so_cells_never_overlap() {
        // 둘째 행의 가로 병합(2칸)이 첫 행에서 내려온 세로 병합 칸(열 1)을 덮는다 — 겹치지 않게 끊고 남는 자리는 빈 칸으로.
        let overlap = table_of(vec![
            trow(vec![tcell("x", 1, 1, Value::Null), tcell("y", 1, 2, Value::Null)]),
            trow(vec![tcell("z", 2, 1, Value::Null)]),
        ]);
        let b = build_doc(vec![overlap]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(grid_faults(&s), vec![(0, 0, 0)]);
        assert_package_consistent(&b.bytes);
    }

    #[test]
    fn random_ragged_and_overlapping_tables_always_fill_a_complete_grid() {
        // 결정적 난수(xorshift) — 길이가 들쭉날쭉하고 병합이 서로 겹치는 표를 많이 만들어 격자 불변식(구멍·겹침·넘침 없음)을 본다.
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
            let s = part(&b.bytes, "Contents/section0.xml");
            // 칸이 하나도 없는 표는 파일에 표가 없다(faults 가 빈 목록).
            let faults = grid_faults(&s);
            assert!(faults.iter().all(|f| *f == (0, 0, 0)), "case {case}: {faults:?} for {}", serde_json::to_string(&rows).unwrap());
        }
    }

    #[test]
    fn absurd_colwidths_do_not_overflow_the_column_sum() {
        // 노트 본문의 `{colwidth=1e300,1e300}` 이 getJSON 에 그대로 실려 온다 — 합이 i64 를 넘어 debug 에선 panic, release 에선 음수 폭 파일.
        for big in [6.2e16, 1e17, 1e18, 9.3e18, 1e19, 1e300, f64::MAX] {
            let t = table_of(vec![trow(vec![tcell("a", 1, 1, json!([big])), tcell("b", 1, 1, json!([big])), tcell("c", 1, 1, json!([100]))])]);
            let b = build("t", &[sec("s", vec![t])], Paper::A4Portrait, &no_images).unwrap_or_else(|e| panic!("colwidth {big}: {e:?}"));
            let s = part(&b.bytes, "Contents/section0.xml");
            let cells: Vec<i64> = attr_vals(&s, "cellSz", "width").iter().map(|w| w.parse().unwrap()).collect();
            let table: Vec<i64> = attr_vals(&s, "sz", "width").iter().map(|w| w.parse().unwrap()).collect();
            assert_eq!(cells.len(), 3);
            assert!(cells.iter().all(|w| *w >= MIN_COL_WIDTH), "colwidth {big}: {cells:?}");
            assert!(table[0] > 0 && table[0] <= body_width(Paper::A4Portrait), "colwidth {big}: {table:?}");
            assert_eq!(cells.iter().sum::<i64>(), table[0], "colwidth {big}");
            assert_package_consistent(&b.bytes);
        }
        // 음수·0 은 모르는 열과 같이 취급(균등 분할에 합류).
        let t = table_of(vec![trow(vec![tcell("a", 1, 1, json!([-5])), tcell("b", 1, 1, json!([0]))])]);
        assert!(build("t", &[sec("s", vec![t])], Paper::A4Portrait, &no_images).is_ok());
    }

    #[test]
    fn wide_columns_are_scaled_to_the_body_and_unknown_columns_share_the_rest() {
        let cell = |w: Value| json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": w, "backgroundColor": null }, "content": [p("c")] });
        let t = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [cell(json!([800])), cell(json!([800])), cell(Value::Null)] }] });
        let s = part(&build_doc(vec![t]).bytes, "Contents/section0.xml");
        let widths: Vec<i64> = attr_vals(&s, "cellSz", "width").iter().map(|w| w.parse().unwrap()).collect();
        assert_eq!(widths.len(), 3);
        assert!(widths.iter().sum::<i64>() <= body_width(Paper::A4Portrait), "{widths:?}");
        assert!(widths.iter().all(|w| *w >= MIN_COL_WIDTH), "{widths:?}");
        // 같은 비율로 줄어든다 — 아는 두 열은 같은 폭.
        assert_eq!(widths[0], widths[1]);
    }

    #[test]
    fn plain_table_without_widths_is_split_evenly_and_header_flag_is_kept() {
        let cell = |ty: &str, t: &str| json!({ "type": ty, "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null, "backgroundColor": null }, "content": [p(t)] });
        let t = json!({ "type": "table", "content": [
            { "type": "tableRow", "content": [cell("tableHeader", "이름"), cell("tableHeader", "값")] },
            { "type": "tableRow", "content": [cell("tableCell", "a"), cell("tableCell", "b")] },
        ] });
        let b = build_doc(vec![t]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(attr_vals(&s, "tc", "header"), vec!["1", "1", "0", "0"]);
        assert_eq!(attr_vals(&s, "tbl", "repeatHeader"), vec!["1"]);
        let widths = attr_vals(&s, "cellSz", "width");
        assert_eq!(widths[0], widths[1]);
        // 최상위 표는 글자처럼 취급하지 않는다(쪽을 넘어 나뉘게).
        assert_eq!(attr_vals(&s, "pos", "treatAsChar"), vec!["0"]);
        let html = reimport(&b.bytes);
        assert!(html.contains("<th") && html.contains("이름") && html.contains("<td") && html.contains(">b<"), "{html}");
    }

    #[test]
    fn cell_alignment_applies_to_default_aligned_paragraphs_only() {
        let cell = |nodes: Vec<Value>| json!({ "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null, "align": "right", "backgroundColor": null }, "content": nodes });
        let centered = json!({ "type": "paragraph", "attrs": { "textAlign": "center", "indent": 0 }, "content": [{ "type": "text", "text": "중" }] });
        let t = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [cell(vec![p("우")]), cell(vec![centered])] }] });
        let html = reimport(&build_doc(vec![t]).bytes);
        assert!(html.contains(r#"data-brise-align="right""#) && html.contains(r#"data-brise-align="center""#), "{html}");
    }

    #[test]
    fn each_ordered_list_gets_its_own_numbering_and_start() {
        let ol = |start: u32, items: &[&str]| {
            json!({ "type": "orderedList", "attrs": { "start": start, "type": null }, "content": items.iter().map(|t| json!({ "type": "listItem", "content": [p(t)] })).collect::<Vec<_>>() })
        };
        let b = build_doc(vec![ol(1, &["a", "b"]), p("끊김"), ol(5, &["c"])]);
        let header = part(&b.bytes, "Contents/header.xml");
        assert_eq!(attr_vals(&header, "numbering", "id"), vec!["1", "2", "3"]);
        assert!(header.contains(r#"<hh:numbering id="3" start="0"><hh:paraHead start="5" level="1""#), "{header}");
        assert!(header.contains(r#"<hh:numbering id="2" start="0"><hh:paraHead start="1" level="1""#));
        assert!(header.contains(r#"<hh:heading type="NUMBER" idRef="2" level="0"/>"#));
        assert!(header.contains(r#"<hh:heading type="NUMBER" idRef="3" level="0"/>"#));
        assert!(!header.contains("<hh:bullets"), "no bullet list, no bullet definitions");
        assert_package_consistent(&b.bytes);
    }

    #[test]
    fn bullet_lists_define_three_bullets_and_deeper_levels_use_other_glyphs() {
        let item = |t: &str, inner: Vec<Value>| {
            let content = [vec![p(t)], inner].concat();
            json!({ "type": "listItem", "content": content })
        };
        let l3 = json!({ "type": "bulletList", "content": [item("c", vec![])] });
        let l2 = json!({ "type": "bulletList", "content": [item("b", vec![l3])] });
        let l1 = json!({ "type": "bulletList", "content": [item("a", vec![l2])] });
        let b = build_doc(vec![l1]);
        let header = part(&b.bytes, "Contents/header.xml");
        assert!(header.contains(r#"<hh:bullets itemCnt="3"><hh:bullet id="1" char="●""#), "{header}");
        for (id, lvl) in [("1", "0"), ("2", "1"), ("3", "2")] {
            assert!(header.contains(&format!(r#"<hh:heading type="BULLET" idRef="{id}" level="{lvl}"/>"#)), "{id}");
        }
        assert_package_consistent(&b.bytes);
        assert_eq!(reimport(&b.bytes), "<ul><li><p>a</p><ul><li><p>b</p><ul><li><p>c</p></li></ul></li></ul></li></ul>");
    }

    #[test]
    fn code_marks_use_the_mono_font_and_code_blocks_are_shaded() {
        let para = json!({ "type": "paragraph", "attrs": { "textAlign": "left", "indent": 0 }, "content": [{ "type": "text", "marks": [mark("code")], "text": "x=1" }] });
        let cb = json!({ "type": "codeBlock", "attrs": { "language": null }, "content": [{ "type": "text", "text": "a\n\nb" }] });
        let b = build_doc(vec![para, cb]);
        let header = part(&b.bytes, "Contents/header.xml");
        assert_eq!(header.matches(r#"face="Consolas""#).count(), 7);
        assert!(header.contains(r#"<hh:fontRef hangul="1" latin="2" hanja="1" japanese="1" other="2" symbol="1" user="1"/>"#), "{header}");
        assert!(header.contains(r##"faceColor="#F2F2F2""##));
        // 줄마다 문단 — 빈 줄도 문단 하나.
        assert_eq!(count(&part(&b.bytes, "Contents/section0.xml"), "p"), 4);
        assert_package_consistent(&b.bytes);
    }

    #[test]
    fn horizontal_rule_is_a_bottom_bordered_empty_paragraph() {
        let b = build_doc(vec![p("위"), json!({ "type": "horizontalRule" }), p("아래")]);
        let header = part(&b.bytes, "Contents/header.xml");
        assert!(header.contains(r##"<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>"##), "{header}");
        assert_package_consistent(&b.bytes);
        assert_eq!(reimport(&b.bytes), "<p>위</p>\n<p></p>\n<p>아래</p>");
    }

    #[test]
    fn identical_formats_are_deduplicated() {
        let bold = |t: &str| json!({ "type": "paragraph", "attrs": { "textAlign": "left", "indent": 0 }, "content": [{ "type": "text", "marks": [mark("bold")], "text": t }] });
        let b = build_doc(vec![bold("a"), bold("b"), bold("c"), p("d"), p("e")]);
        let header = part(&b.bytes, "Contents/header.xml");
        // 기본 7개 + 굵은 본문 1개, 문단 모양은 기본 16 + 왼쪽 본문 1개.
        assert_eq!(attr_vals(&header, "charProperties", "itemCnt"), vec!["8"]);
        assert_eq!(attr_vals(&header, "paraProperties", "itemCnt"), vec!["17"]);
        assert_eq!(count(&part(&b.bytes, "Contents/section0.xml"), "run"), 5);
    }

    #[test]
    fn adjacent_links_group_into_one_field_and_the_control_runs_carry_no_format() {
        let link = |t: &str| json!({ "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://a.example/x" } }], "text": t });
        let para = json!({ "type": "paragraph", "attrs": { "textAlign": "left", "indent": 0 }, "content": [
            { "type": "text", "text": "앞 " }, link("링"), link("크"), { "type": "text", "text": " 뒤" }] });
        let b = build_doc(vec![para]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(count(&s, "fieldBegin"), 1);
        assert_eq!(count(&s, "fieldEnd"), 1);
        assert!(s.contains("<hp:t>링크</hp:t>"), "{s}");
        // 필드를 여닫는 컨트롤 런은 서식 0 — 표시 글자 런만 링크 서식(파랑 밑줄)을 가진다.
        assert!(s.contains(r#"<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin"#));
        assert!(part(&b.bytes, "Contents/header.xml").contains(r##"textColor="#0000FF""##));
        assert_package_consistent(&b.bytes);
        assert_eq!(reimport(&b.bytes), r#"<p>앞 <a href="https://a.example/x">링크</a> 뒤</p>"#);
    }

    // ── ③ 안전 ────────────────────────────────────────────────────────────

    #[test]
    fn links_only_web_and_mail_and_commands_are_escaped_like_hancom() {
        let link = |href: &str| json!({ "type": "paragraph", "content": [{ "type": "text", "marks": [{ "type": "link", "attrs": { "href": href } }], "text": "L" }] });
        let b = build_doc(vec![
            link("https://a.example/p?q=1;r#s"),
            link("mailto:me@example.com"),
            link("HTTP://UPPER.example/"),
            link("javascript:alert(1)"),
            link("note://abc"),
            link("file:///C:/x"),
            link("https://a b.example/"),
            link(""),
        ]);
        let s = part(&b.bytes, "Contents/section0.xml");
        assert_eq!(count(&s, "fieldBegin"), 3, "{s}");
        assert!(!s.contains("javascript"), "{s}");
        assert!(!s.contains("file:"), "{s}");
        // 웹: `:?;#` 앞에 역슬래시 + `;1;0;0;`, 메일: 그대로 + `;2;0;0`.
        assert!(s.contains(r#"<hp:stringParam name="Command">https\://a.example/p\?q=1\;r\#s;1;0;0;</hp:stringParam>"#), "{s}");
        assert!(s.contains(r#"<hp:stringParam name="Path">https://a.example/p?q=1;r#s</hp:stringParam>"#));
        assert!(s.contains(r#"<hp:stringParam name="Command">mailto:me@example.com;2;0;0</hp:stringParam>"#));
        assert!(s.contains("HWPHYPERLINK_TYPE_EMAIL") && s.contains("HWPHYPERLINK_TYPE_URL"));
        assert!(s.contains(r#"<hp:parameters cnt="6" name="">"#));
        // 허용되지 않은 링크의 글자는 남는다 — 글자 "L" 이 여덟 번.
        assert_eq!(s.matches("<hp:t>L</hp:t>").count(), 8);
        assert_package_consistent(&b.bytes);
    }

    #[test]
    fn hostile_text_is_escaped_and_xml_illegal_characters_are_dropped() {
        let nasty = "a\u{1}b\u{8}c\u{b}\u{c}\u{fffe}\u{ffff}d &amp; <b>x</b> \"q\" 'r' ]]> &#1;";
        let para = json!({ "type": "paragraph", "content": [{ "type": "text", "text": nasty }, { "type": "text", "marks": [{ "type": "textStyle", "attrs": { "color": "red\" onclick=\"x" } }], "text": "색" }] });
        let img = json!({ "type": "paragraph", "content": [{ "type": "image", "attrs": { "relPath": "n1/a.png", "alt": "a\"b<c>&\u{2}d", "width": "50%" } }] });
        let b = build("제<목>&\u{1}", &[sec("s\u{1}\"", vec![para, img])], Paper::A4Portrait, &|_| Some(png_bytes())).unwrap();
        for (n, v) in entries(&b.bytes) {
            if n.ends_with(".xml") || n.ends_with(".hpf") {
                let s = String::from_utf8(v).unwrap();
                assert!(s.chars().all(is_xml_char), "{n} has XML-illegal chars");
                walk(&s, |_, _| {});
            }
        }
        let s = part(&b.bytes, "Contents/section0.xml");
        assert!(s.contains("abcd &amp;amp; &lt;b&gt;x&lt;/b&gt; \"q\" 'r' ]]&gt; &amp;#1;"), "{s}");
        assert!(s.contains("<hp:shapeComment>a&quot;b&lt;c&gt;&amp;d</hp:shapeComment>"), "{s}");
        // 글자색은 CSS 색 파서를 통과한 것만 — 속성 주입이 안 된다.
        assert!(!part(&b.bytes, "Contents/header.xml").contains("onclick"));
        assert!(part(&b.bytes, "Contents/content.hpf").contains("<opf:title>제&lt;목&gt;&amp;</opf:title>"));
        // 왕복: 글자 그대로(리터럴 `&amp;` 는 `&amp;amp;`).
        let html = reimport(&b.bytes);
        assert!(html.contains("abcd &amp;amp; &lt;b&gt;x&lt;/b&gt;"), "{html}");
    }

    #[test]
    fn tabs_become_hp_tab_and_hard_breaks_become_line_breaks() {
        let para = json!({ "type": "paragraph", "content": [{ "type": "text", "text": "a\tb" }, { "type": "hardBreak" }, { "type": "text", "text": "c" }] });
        let s = part(&build_doc(vec![para]).bytes, "Contents/section0.xml");
        assert!(s.contains(r#"<hp:t>a<hp:tab width="4000" leader="0" type="1"/>b<hp:lineBreak/>c</hp:t>"#), "{s}");
    }

    // ── 그림 ──────────────────────────────────────────────────────────────

    #[test]
    fn images_are_embedded_once_sized_from_the_percentage_and_failures_leave_a_label() {
        let para = json!({ "type": "paragraph", "content": [
            image_node(Some("n1/ok.png"), "좋은", "50%"), image_node(Some("n1/ok.png"), "", "100%"),
            image_node(Some("n1/missing.png"), "없는", "50%"), image_node(None, "원격", "50%"),
        ] });
        let resolver = |rel: &str| (rel == "n1/ok.png").then(png_bytes);
        let b = build("t", &[sec("s", vec![para])], Paper::A4Portrait, &resolver).unwrap();
        assert_eq!((b.image_count, b.skipped_images), (2, 2));
        let names: Vec<String> = entries(&b.bytes).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names.iter().filter(|n| n.starts_with("BinData/")).count(), 1, "same file is stored once");
        let s = part(&b.bytes, "Contents/section0.xml");
        // 8×6px → 600×450 HWPUNIT 원본, 본문 폭 42520 의 50% = 21260 폭, 비례 높이 15945.
        assert!(s.contains(r#"<hp:orgSz width="600" height="450"/><hp:curSz width="21260" height="15945"/>"#), "{s}");
        assert!(s.contains(r#"<hp:imgDim dimwidth="600" dimheight="450"/>"#));
        assert!(s.contains(r#"<hp:pos treatAsChar="1""#));
        assert!(s.contains("[그림: 없는]") && s.contains("[그림: 원격]"), "{s}");
        assert!(s.contains("<hp:shapeComment>좋은</hp:shapeComment>"));
        assert_package_consistent(&b.bytes);
        // 왕복: 그림 둘(너비 비율은 본문 폭 기준 50% / 100%).
        let html = reimport(&b.bytes);
        assert!(html.contains("width: 50%") && html.contains("width: 100%"), "{html}");
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
        let s = part(&b.bytes, "Contents/section0.xml");
        let h: i64 = attr_vals(&s, "curSz", "height")[0].parse().unwrap();
        assert!(h as f64 <= body_height(Paper::A4Portrait) as f64 * super::super::pm::IMAGE_MAX_PAGE_FRACTION + 1.0, "{h}");
    }

    #[test]
    fn image_formats_jpeg_is_kept_tiff_is_converted_and_garbage_is_skipped() {
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
        let hpf = part(&b.bytes, "Contents/content.hpf");
        assert!(hpf.contains(r#"href="BinData/image1.jpg" media-type="image/jpg""#), "{hpf}");
        assert!(hpf.contains(r#"href="BinData/image2.png" media-type="image/png""#), "{hpf}");
        assert_package_consistent(&b.bytes);
    }

    // ── 상한 · 검증 ───────────────────────────────────────────────────────

    #[test]
    fn deeply_nested_documents_fail_validation_instead_of_overflowing_the_stack() {
        let mut node = p("깊다");
        for _ in 0..200 {
            node = json!({ "type": "blockquote", "content": [node] });
        }
        let err = build("t", &[sec("s", vec![node])], Paper::A4Portrait, &no_images).err().unwrap();
        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
        // 얕은 중첩은 된다.
        let mut ok = p("얕다");
        for _ in 0..10 {
            ok = json!({ "type": "blockquote", "content": [ok] });
        }
        assert!(build("t", &[sec("s", vec![ok])], Paper::A4Portrait, &no_images).is_ok());
    }

    #[test]
    fn deeply_nested_lists_fail_validation_instead_of_overflowing_the_stack() {
        // 목록 안 목록은 `block` 을 거치지 않고 재귀한다 — 깊이 예산이 없으면 ~1000단에서 스택 오버플로로 프로세스가 죽는다.
        // 깊은 `Value` 를 만들고 버리는 것도 재귀라 넉넉한 스택의 스레드에서 돌린다.
        std::thread::Builder::new()
            .stack_size(256 * 1024 * 1024)
            .spawn(|| {
                for kind in ["bulletList", "orderedList", "taskList"] {
                    let err = build("t", &[sec("s", vec![nested_lists(kind, 1500)])], Paper::A4Portrait, &no_images).err().unwrap();
                    assert!(matches!(err, AppError::Validation(_)), "{kind}: {err:?}");
                }
                // 얕은 중첩은 된다.
                assert!(build("t", &[sec("s", vec![nested_lists("bulletList", 10)])], Paper::A4Portrait, &no_images).is_ok());
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn a_pathological_table_grid_is_rejected() {
        let cell = json!({ "type": "tableCell", "attrs": { "colspan": 200, "rowspan": 1000 }, "content": [p("x")] });
        let rows: Vec<Value> = (0..1000).map(|_| json!({ "type": "tableRow", "content": [cell.clone()] })).collect();
        let t = json!({ "type": "table", "content": rows });
        let err = build("t", &[sec("s", vec![t])], Paper::A4Portrait, &no_images).err().unwrap();
        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    }

    #[test]
    fn rows_without_cells_and_empty_tables_do_not_crash() {
        let t = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [] }] });
        let t2 = json!({ "type": "table" });
        assert!(build("t", &[sec("s", vec![t, t2, p("뒤")])], Paper::A4Portrait, &no_images).is_ok());
    }

    #[test]
    fn invalid_inputs_are_validation_errors() {
        let ok = sec("s", vec![p("x")]);
        assert!(matches!(build("t", &[], Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
        let not_doc = DocExportSection { name: "n".into(), doc: json!({ "type": "paragraph" }) };
        assert!(matches!(build("t", &[ok.clone(), not_doc], Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
        let null_doc = DocExportSection { name: "n".into(), doc: Value::Null };
        assert!(matches!(build("t", &[null_doc], Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
        let many: Vec<DocExportSection> = (0..=MAX_SECTIONS).map(|_| ok.clone()).collect();
        assert!(matches!(build("t", &many, Paper::A4Portrait, &no_images), Err(AppError::Validation(_))));
    }

    #[test]
    fn unknown_nodes_keep_their_text_and_missing_attributes_are_tolerated() {
        let weird = json!({ "type": "somethingNew", "content": [p("펼쳐진 문단")] });
        let weird_leaf = json!({ "type": "mystery", "text": "글자" });
        let bare = json!({ "type": "paragraph" });
        let nulls = json!({ "type": "heading", "attrs": { "level": null, "textAlign": null, "indent": null }, "content": [{ "type": "text", "text": "널" }] });
        let inline_unknown = json!({ "type": "paragraph", "content": [{ "type": "emoji", "text": "😀" }, { "type": "text", "text": "끝" }] });
        let b = build_doc(vec![weird, weird_leaf, bare, nulls, inline_unknown]);
        let html = reimport(&b.bytes);
        assert!(html.contains("펼쳐진 문단") && html.contains("글자") && html.contains("<h1>널</h1>") && html.contains("😀끝"), "{html}");
        assert_package_consistent(&b.bytes);
    }

    /// 실제 덤프의 값을 결정적으로 무작위 변형(null · 숫자 · 문자열 · 빈 배열 · 키 삭제)해도 panic 하지 않는다 — Ok 든 VALIDATION 이든 좋다.
    #[test]
    fn mutated_documents_never_panic() {
        let base: Value = serde_json::from_str(REAL_PM).unwrap();
        let mut rng = 0x9E37_79B9_7F4A_7C15u64;
        let (mut ok, mut rejected) = (0, 0);
        for _ in 0..250 {
            let mut doc = base.clone();
            mutate(&mut doc, &mut rng, 0);
            let sections = [DocExportSection { name: "n".into(), doc }];
            match build("t", &sections, Paper::A4Portrait, &real_resolver) {
                Ok(b) => {
                    ok += 1;
                    // 구조 검사는 무겁다(헤더를 수십 번 다시 읽는다) — 마흔 번에 한 번만.
                    if ok % 40 == 1 {
                        assert_package_consistent(&b.bytes);
                    }
                }
                Err(AppError::Validation(_)) => rejected += 1,
                Err(e) => panic!("unexpected error: {e:?}"),
            }
        }
        assert!(ok > 50, "ok={ok} rejected={rejected}");
    }

    #[test]
    fn several_sections_get_their_names_as_headings_and_a_single_one_does_not() {
        let one = build("t", &[sec("이름", vec![p("본문")])], Paper::A4Portrait, &no_images).unwrap();
        assert_eq!(reimport(&one.bytes), "<p>본문</p>");
        let two = build("t", &[sec("첫째", vec![p("가")]), sec("", vec![p("나")]), sec("셋째", vec![])], Paper::A4Portrait, &no_images).unwrap();
        assert_package_consistent(&two.bytes);
        let html = reimport(&two.bytes);
        assert!(html.starts_with("<h1>첫째</h1>\n<p>가</p>\n<p>나</p>\n<h1>셋째</h1>"), "{html}");
    }

    // ── 샘플 ──────────────────────────────────────────────────────────────

    /// 오너가 한컴오피스 뷰어로 열어 보는 샘플을 쓴다 —
    /// `HWPX_EXPORT_SAMPLE_OUT=<경로>.hwpx cargo test --lib doc_export::hwpx::tests::write_sample -- --ignored`.
    /// 경로 파일(세로, 이력서식 병합 표 + 제목 + 본문 + 목록, 그림 없음) 외에 옆에 `-landscape`(가로), `-picture`(그림 포함) 변형도 쓴다.
    /// 문서는 DOCX 샘플과 같은 것(`testutil::sample_main`) — 두 형식을 나란히 열어 비교한다.
    #[test]
    #[ignore = "writes sample files for manual inspection in a viewer; set HWPX_EXPORT_SAMPLE_OUT"]
    fn write_sample() {
        let Ok(out) = std::env::var("HWPX_EXPORT_SAMPLE_OUT") else {
            panic!("set HWPX_EXPORT_SAMPLE_OUT to the .hwpx path to write");
        };
        let out = std::path::PathBuf::from(out);
        let main = sample_main("HWPX");
        let write = |path: &std::path::Path, secs: &[DocExportSection], paper: Paper, resolve: &crate::repo::doc_export::Resolver<'_>| {
            let built = build("Brise 내보내기 샘플", secs, paper, resolve).unwrap();
            std::fs::write(path, &built.bytes).unwrap();
            println!("wrote {} ({} bytes, {} images)", path.display(), built.bytes.len(), built.image_count);
        };
        write(&out, std::slice::from_ref(&main), Paper::A4Portrait, &no_images);
        let stem = out.file_stem().unwrap().to_string_lossy().into_owned();
        write(&out.with_file_name(format!("{stem}-landscape.hwpx")), std::slice::from_ref(&main), Paper::A4Landscape, &no_images);
        write(&out.with_file_name(format!("{stem}-picture.hwpx")), &[sample_picture()], Paper::A4Portrait, &|_| Some(sample_png()));
    }
}
