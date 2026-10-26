// repo: doc_export::docx — ProseMirror JSON → .docx (PLAN-2026-10-07-doc-import-export W4)
//
// HWPX 작성기(`hwpx.rs`)와 같은 입력(프런트의 헤드리스 TipTap `getJSON()`)·같은 계약(순수 빌더: 파일·DB 를 건드리지 않는다)이다.
// 형식 무관 부분은 `mod.rs`(그림 적재 · 예산 · zip)·`pm.rs`(JSON 접근자 · 색 · 링크 · 표 격자 · 열 너비 · 그림 크기)·`xmlw.rs`(이스케이프)를 쓰고,
// 여기는 WordprocessingML 로 옮기는 일만 한다.
//
// 모양의 근거: 실제 Word 가 저장한 docx 16개(mammoth.js 테스트 13개·python-docx 3개)의 `[Content_Types].xml` · `_rels` · `document.xml` ·
// `styles.xml`(기본 서식·표 스타일·ListParagraph·Hyperlink) · `numbering.xml`(abstractNum/num) · `settings.xml`. Word 는 자식 요소의 **순서**에
// 엄격하다(`xsd:sequence`) — 아래 `PPr::xml`·`RunFmt::rpr`·표 조립은 ECMA-376 의 순서를 그대로 따르고, 테스트가 순서를 검사한다.
//
// 구조: ① `Writer`: JSON → word/document.xml 본문 문자열(관계 id · 번호 인스턴스 · 그림 id 를 쌓는다). ② 정적 부품(styles · numbering ·
// settings · core/app · 콘텐츠 타입 · 관계). ③ `package`: zip. DOCX 는 Word 가 열 때마다 줄·쪽을 다시 배치하므로 HWPX 의 줄 배치 캐시 같은
// 함정이 없다 — 대신 순서·참조 정합성이 "열리느냐"를 가른다.
//
// 쓰지 않는 것: 머리말/꼬리말/쪽 번호 · 각주(글자만) · 글꼴 임베드 · theme/fontTable(글꼴 이름을 직접 적는다) · 변경 추적.
//
// ponytail: 글꼴은 우리가 정한다(본문 맑은 고딕 10pt, 제목 16/14/12pt 굵게, 코드 Consolas). 표는 일괄 실선·열 너비 근사, 접기는 펼친 문단,
// 할 일은 ☐/☑ 글자, 각주·날짜 표지는 글자만, 형광펜은 노란색이면 `w:highlight` 아니면 `w:shd`. 번호 목록은 목록마다 `w:num` 을 따로 둔다
// (같은 abstractNum 을 공유하는 `w:num` 은 시작 번호를 덮어쓰지 않으면 앞 목록의 번호를 이어 센다). 천장 = "원본과 비슷하게"(계획 §0-2).
// 실제 Word 로 열어 본 적은 없다(가장 큰 미확인) — `DOCX_EXPORT_SAMPLE_OUT` 샘플을 Word/LibreOffice 로 열어 확인한다.
use super::pm::{
    attr, attr_f64, attr_str, bold_all, column_widths, css_color, fit_image, image_pct, kids, link_target, mark_attr, marks, place_grid,
    plain_text, ty, Align, CellRef,
};
use super::xmlw::{esc_attr, esc_into};
use super::{section_heading, Budget, Built, DocExportSection, ImageStore, Margin, Paper, PaperSize, ZipOut};
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write as _;

// ── 쪽 · 단위 ─────────────────────────────────────────────────────────────────

/// 96dpi 화면 1px = 15 twips(1440 twips/inch ÷ 96) · 1 twip = 635 EMU(914400 EMU/inch ÷ 1440).
const TWIPS_PER_PX: f64 = 15.0;
const EMU_PER_TWIP: i64 = 635;
/// 들여쓰기 한 단 = 글자 2개(10pt) = 400 twips — HWPX 의 `INDENT_UNIT`(2000 HWPUNIT)과 같은 길이.
const INDENT_UNIT: i64 = 400;
const MAX_INDENT: i64 = 6;
/// 목록 한 수준의 들여쓰기와 글머리/번호가 튀어나오는 길이(Word 기본값).
const LIST_INDENT: i64 = 720;
const LIST_HANGING: i64 = 360;
/// 쪽 여백(Word 기본 25.4mm) · 표 칸 안쪽 좌우 여백(TableGrid 기본) · 표 열의 최소 너비.
const MARGIN: i64 = 1440;
const CELL_MARGIN_LR: i64 = 108;
const MIN_COL_WIDTH: i64 = 360;
/// Word 표 한 행의 칸 수 상한(Word 자신의 한계 — 열 63개). 넘으면 Word 가 파일을 못 읽는다고 보고된다(Aspose 포럼 제보: 한 행 64칸↑ 의 docx 가
/// 열리지 않음; 직접 Word 로 재현하지는 못했다). 열 하나가 `MIN_COL_WIDTH` 아래로 줄지 않으므로 표 폭은 63 × 360 = 22680 twips 로 막힌다 —
/// Word 의 표 폭 한계(22인치 = 31680 twips) 안이다. 상한은 DOCX 만의 것이라 공용 `pm.rs`(HWPX 포함)의 `MAX_COLS` 는 건드리지 않는다.
const MAX_TABLE_COLS: usize = 63;
/// 번호 정의가 가진 수준 수(Word 의 abstractNum 은 0..=8).
const NUM_LEVELS: usize = 9;
/// 번호 목록 인스턴스(`w:num`)의 상한 — 인스턴스마다 수준별 시작 번호 덮어쓰기 아홉 줄(~800바이트)이 numbering.xml 에 들어간다.
const MAX_NUMS: usize = 4000;

/// (가로, 세로) twips. 가로 방향은 폭·높이를 맞바꾸고 `w:orient="landscape"`.
fn page_size(paper: Paper) -> (i64, i64) {
    paper.orient(match paper.size {
        PaperSize::A4 => (11906, 16838),
        PaperSize::B5 => (10318, 14570),
        PaperSize::Letter => (12240, 15840),
    })
}

/// 쪽 여백 twips — (위, 좌우, 아래). Word 의 여백 사전 설정 그대로: 보통 25.4mm · 좁게 12.7mm · 넓게 위아래 25.4 / 좌우 50.8mm.
fn margins(paper: Paper) -> (i64, i64, i64) {
    match paper.margin {
        Margin::Normal => (MARGIN, MARGIN, MARGIN),
        Margin::Narrow => (720, 720, 720),
        Margin::Wide => (MARGIN, 2880, MARGIN),
    }
}

fn body_width(paper: Paper) -> i64 {
    page_size(paper).0 - 2 * margins(paper).1
}

fn body_height(paper: Paper) -> i64 {
    let (top, _, bottom) = margins(paper);
    page_size(paper).1 - top - bottom
}

fn jc_of(a: Align) -> &'static str {
    match a {
        Align::Left => "left",
        Align::Center => "center",
        Align::Right => "right",
        Align::Justify => "both",
    }
}

// ── 서식 ──────────────────────────────────────────────────────────────────────

const MONO_FACE: &str = "Consolas";

#[derive(Clone, PartialEq, Eq, Default)]
enum Highlight {
    #[default]
    None,
    /// `w:highlight` 는 이름 있는 색만 받는다 — 노란색(마크 기본값)만 이걸 쓴다.
    Yellow,
    /// 그 밖의 색은 런 음영(`w:shd`).
    Fill(String),
}

/// 런 하나의 글자 서식. 같은 서식이 이어지면 한 런으로 합친다(`PartialEq`).
#[derive(Clone, PartialEq, Eq, Default)]
struct RunFmt {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    /// `RRGGBB`(# 없이).
    color: Option<String>,
    highlight: Highlight,
    mono: bool,
    /// 반 포인트 단위(`w:sz`).
    size: Option<u32>,
    /// 하이퍼링크 글자 스타일(`Hyperlink`).
    link: bool,
}

/// `#RRGGBB` → `RRGGBB`. WordprocessingML 의 색 속성은 `#` 이 없다.
fn hex(c: &str) -> String {
    c.trim_start_matches('#').to_string()
}

impl RunFmt {
    /// `w:rPr` — 자식 순서: rStyle, rFonts, b, bCs, i, iCs, strike, color, sz, szCs, highlight, u, shd (ECMA-376 CT_RPr). 빈 서식이면 빈 문자열.
    fn rpr(&self) -> String {
        let mut s = String::new();
        if self.link {
            s.push_str(r#"<w:rStyle w:val="Hyperlink"/>"#);
        }
        if self.mono {
            let _ = write!(s, r#"<w:rFonts w:ascii="{MONO_FACE}" w:hAnsi="{MONO_FACE}" w:cs="{MONO_FACE}"/>"#);
        }
        if self.bold {
            s.push_str("<w:b/><w:bCs/>");
        }
        if self.italic {
            s.push_str("<w:i/><w:iCs/>");
        }
        if self.strike {
            s.push_str("<w:strike/>");
        }
        if let Some(c) = &self.color {
            let _ = write!(s, r#"<w:color w:val="{c}"/>"#);
        }
        if let Some(sz) = self.size {
            let _ = write!(s, r#"<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>"#);
        }
        if self.highlight == Highlight::Yellow {
            s.push_str(r#"<w:highlight w:val="yellow"/>"#);
        }
        if self.underline {
            s.push_str(r#"<w:u w:val="single"/>"#);
        }
        if let Highlight::Fill(c) = &self.highlight {
            let _ = write!(s, r#"<w:shd w:val="clear" w:color="auto" w:fill="{c}"/>"#);
        }
        if s.is_empty() {
            return s;
        }
        format!("<w:rPr>{s}</w:rPr>")
    }

    fn code() -> RunFmt {
        RunFmt { mono: true, size: Some(18), ..RunFmt::default() }
    }
}

/// 문단 서식. 자식 순서: pStyle, numPr, pBdr, shd, spacing, ind, jc, rPr (ECMA-376 CT_PPr).
#[derive(Clone, Default)]
struct PPr {
    style: Option<&'static str>,
    /// (numId, ilvl)
    num: Option<(u32, usize)>,
    /// 인용 막대(왼쪽 테두리) · 가로줄(아래 테두리).
    bar: bool,
    rule: bool,
    shade: Option<&'static str>,
    /// 줄 사이 · 문단 사이를 붙인다(코드 블록 — 줄마다 문단이라 음영이 이어져 보여야 한다).
    tight: bool,
    /// (left, hanging) twips.
    ind: Option<(i64, i64)>,
    jc: Option<Align>,
    /// 문단 부호의 글자 서식(빈 코드 줄의 높이를 정한다).
    mark: Option<RunFmt>,
}

impl PPr {
    fn xml(&self, out: &mut String) {
        let mut s = String::new();
        if let Some(st) = self.style {
            let _ = write!(s, r#"<w:pStyle w:val="{st}"/>"#);
        }
        if let Some((id, lvl)) = self.num {
            let _ = write!(s, r#"<w:numPr><w:ilvl w:val="{lvl}"/><w:numId w:val="{id}"/></w:numPr>"#);
        }
        if self.bar || self.rule {
            s.push_str("<w:pBdr>");
            if self.bar {
                s.push_str(r#"<w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/>"#);
            }
            if self.rule {
                s.push_str(r#"<w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/>"#);
            }
            s.push_str("</w:pBdr>");
        }
        if let Some(fill) = self.shade {
            let _ = write!(s, r#"<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>"#);
        }
        if self.tight {
            s.push_str(r#"<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>"#);
        }
        if let Some((left, hanging)) = self.ind {
            if hanging > 0 {
                let _ = write!(s, r#"<w:ind w:left="{left}" w:hanging="{hanging}"/>"#);
            } else {
                let _ = write!(s, r#"<w:ind w:left="{left}"/>"#);
            }
        }
        if let Some(a) = self.jc {
            let _ = write!(s, r#"<w:jc w:val="{}"/>"#, jc_of(a));
        }
        if let Some(m) = &self.mark {
            s.push_str(&m.rpr());
        }
        if !s.is_empty() {
            out.push_str("<w:pPr>");
            out.push_str(&s);
            out.push_str("</w:pPr>");
        }
    }
}

// ── 본문 작성기 ───────────────────────────────────────────────────────────────

/// 블록 하나를 쓰는 문맥. `ind` = 인용·접기·목록 이어 문단이 받는 왼쪽 들여쓰기(twips), `bar` = 인용 막대를 그리는가,
/// `avail_w` = 그림·표 폭 기준(본문 폭 또는 칸 폭, twips).
#[derive(Clone, Copy)]
struct Cx {
    ind: i64,
    bar: bool,
    avail_w: i64,
    cell_align: Option<Align>,
}

/// `word/_rels/document.xml.rels` 의 동적 항목(정적 항목 rId1..3 뒤).
struct Rel {
    id: String,
    kind: &'static str,
    target: String,
    external: bool,
}

const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/// 정적 관계의 id — 동적 관계는 rId4 부터.
const STATIC_RELS: usize = 3;

/// 번호 목록 인스턴스(`w:num`) 하나 — 어느 수준에서 시작 번호가 몇인가.
struct NumDef {
    level: usize,
    start: i64,
}

struct Writer<'a> {
    paper: Paper,
    imgs: ImageStore<'a>,
    budget: Budget,
    rels: Vec<Rel>,
    link_rids: HashMap<String, String>,
    image_rids: HashMap<usize, String>,
    /// 번호 목록 인스턴스들. numId = 2 + 위치(1 은 글머리표 하나가 쓴다).
    nums: Vec<NumDef>,
    docpr: u32,
    image_count: usize,
    skipped: usize,
    paragraphs: usize,
    /// 바로 앞에 쓴 것이 표인가 — 표 바로 뒤에는 표가 올 수 없고(Word 가 합친다) 칸·본문은 문단으로 끝나야 한다.
    last_tbl: bool,
}

/// 글머리표 목록이 쓰는 `w:num` 의 id. 번호 목록은 2 부터.
const BULLET_NUM: u32 = 1;

impl<'a> Writer<'a> {
    fn new(paper: Paper, resolve: &'a super::Resolver<'a>) -> Self {
        Writer {
            paper,
            imgs: ImageStore::new(resolve),
            budget: Budget::default(),
            rels: Vec::new(),
            link_rids: HashMap::new(),
            image_rids: HashMap::new(),
            nums: Vec::new(),
            docpr: 0,
            image_count: 0,
            skipped: 0,
            paragraphs: 0,
            last_tbl: false,
        }
    }

    fn next_rid(&self) -> String {
        format!("rId{}", STATIC_RELS + self.rels.len() + 1)
    }

    fn link_rid(&mut self, href: &str) -> String {
        if let Some(id) = self.link_rids.get(href) {
            return id.clone();
        }
        let id = self.next_rid();
        self.rels.push(Rel { id: id.clone(), kind: "hyperlink", target: href.to_string(), external: true });
        self.link_rids.insert(href.to_string(), id.clone());
        id
    }

    fn image_rid(&mut self, idx: usize, ext: &str) -> String {
        if let Some(id) = self.image_rids.get(&idx) {
            return id.clone();
        }
        let id = self.next_rid();
        self.rels.push(Rel { id: id.clone(), kind: "image", target: format!("media/{}", media_name(idx, ext)), external: false });
        self.image_rids.insert(idx, id.clone());
        id
    }

    // ── 문단 · 런 ─────────────────────────────────────────────────────────

    /// 문단 하나를 쓴다. 모든 문단 출력이 여기를 지난다 — 표 뒤 문단 규칙(`last_tbl`)과 문단 수를 한 곳에서 센다.
    fn push_p(&mut self, out: &mut String, ppr: &PPr, inner: &str) {
        let mut head = String::new();
        ppr.xml(&mut head);
        if head.is_empty() && inner.is_empty() {
            out.push_str("<w:p/>");
        } else {
            out.push_str("<w:p>");
            out.push_str(&head);
            out.push_str(inner);
            out.push_str("</w:p>");
        }
        self.paragraphs += 1;
        self.last_tbl = false;
    }

    fn empty_p(&mut self, out: &mut String) {
        self.push_p(out, &PPr::default(), "");
    }

    /// 마크 목록을 얹은 글자 서식. 링크 글자는 `Hyperlink` 글자 스타일(파랑 + 밑줄, 글자색 마크가 있으면 그 색).
    fn fmt_for(base: &RunFmt, mark_list: &[Value], linked: bool) -> RunFmt {
        let mut f = base.clone();
        f.link = linked;
        for m in mark_list {
            match ty(m) {
                "bold" => f.bold = true,
                "italic" => f.italic = true,
                "underline" => f.underline = true,
                "strike" => f.strike = true,
                "code" => f.mono = true,
                "highlight" => {
                    f.highlight = match mark_attr(m, "color").and_then(css_color) {
                        Some(c) if c != "#FFFF00" => Highlight::Fill(hex(&c)),
                        _ => Highlight::Yellow,
                    };
                }
                "textStyle" => {
                    if let Some(c) = mark_attr(m, "color").and_then(css_color) {
                        f.color = Some(hex(&c));
                    }
                }
                _ => {} // footnote · date · 그 밖의 표지 — 글자만 남긴다
            }
        }
        f
    }

    /// 문단 내용(글자·줄바꿈·그림)을 런들로 쓴다. 같은 글자 서식이 이어지면 한 런, 같은 링크가 이어지면 `w:hyperlink` 하나.
    /// `prefix` 는 본문 서식으로 맨 앞에 붙는 글자(할 일 "☐ ").
    fn inline_runs(&mut self, out: &mut String, content: &[Value], prefix: &str, base: &RunFmt, cx: &Cx) -> AppResult<()> {
        let mut pending: Option<(RunFmt, String)> = None;
        let mut href: Option<String> = None;
        if !prefix.is_empty() {
            pending = Some((base.clone(), prefix.to_string()));
        }
        for n in content {
            self.budget.tick()?;
            match ty(n) {
                "text" => {
                    let text = n.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.is_empty() {
                        continue;
                    }
                    let link = marks(n).iter().find(|m| ty(m) == "link").and_then(link_target);
                    if link.as_ref().map(|l| l.href.as_str()) != href.as_deref() {
                        flush_run(out, &mut pending);
                        if href.take().is_some() {
                            out.push_str("</w:hyperlink>");
                        }
                        if let Some(l) = &link {
                            let rid = self.link_rid(&l.href);
                            let _ = write!(out, r#"<w:hyperlink r:id="{rid}" w:history="1">"#);
                            href = Some(l.href.clone());
                        }
                    }
                    push_text(out, &mut pending, Self::fmt_for(base, marks(n), link.is_some()), text);
                }
                "hardBreak" => match &mut pending {
                    Some((_, s)) => s.push('\n'),
                    None => pending = Some((base.clone(), "\n".to_string())),
                },
                "image" => {
                    flush_run(out, &mut pending);
                    self.drawing_run(out, n, cx);
                }
                _ => {
                    // 알 수 없는 인라인 노드 — 글자만 남긴다(내용이 사라지는 쪽이 더 나쁘다).
                    let mut t = String::new();
                    plain_text(n, &mut t);
                    if !t.is_empty() {
                        push_text(out, &mut pending, base.clone(), &t);
                    }
                }
            }
        }
        flush_run(out, &mut pending);
        if href.is_some() {
            out.push_str("</w:hyperlink>");
        }
        Ok(())
    }

    fn para(&mut self, out: &mut String, ppr: &PPr, content: &[Value], prefix: &str, base: &RunFmt, cx: &Cx) -> AppResult<()> {
        let mut inner = String::new();
        self.inline_runs(&mut inner, content, prefix, base, cx)?;
        self.push_p(out, ppr, &inner);
        Ok(())
    }

    /// 줄 하나짜리 글(코드 한 줄·섹션 이름)을 문단으로.
    fn text_para(&mut self, out: &mut String, ppr: &PPr, text: &str, base: &RunFmt, cx: &Cx) -> AppResult<()> {
        if text.is_empty() {
            return self.para(out, ppr, &[], "", base, cx);
        }
        let node = serde_json::json!({ "type": "text", "text": text });
        self.para(out, ppr, std::slice::from_ref(&node), "", base, cx)
    }

    /// 문맥이 정하는 문단 서식 — 들여쓰기(`extra` 는 문단 자신의 몫)와 인용 막대.
    fn base_ppr(cx: &Cx, extra: i64) -> PPr {
        let left = cx.ind + extra;
        PPr { bar: cx.bar, ind: (left > 0).then_some((left, 0)), ..PPr::default() }
    }

    /// 문단의 정렬: 문단 자신의 속성 → 표 칸 정렬 → 왼쪽(= 쓰지 않는다).
    fn align_for(n: &Value, cx: &Cx) -> Option<Align> {
        match super::pm::align_of(attr_str(n, "textAlign")) {
            Some(Align::Left) | None => cx.cell_align,
            a => a,
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
        self.budget.tick()?;
        self.budget.enter()?;
        let r = self.block_inner(out, n, cx);
        self.budget.leave();
        r
    }

    fn block_inner(&mut self, out: &mut String, n: &Value, cx: &Cx) -> AppResult<()> {
        let body = RunFmt::default();
        match ty(n) {
            "paragraph" => {
                let indent = (attr_f64(n, "indent").unwrap_or(0.0) as i64).clamp(0, MAX_INDENT);
                // 인용 안의 일반 문단은 Quote 스타일(의미) — 들여쓰기·막대는 문단에 직접 줘서 중첩 깊이를 정확히 따른다.
                let ppr = PPr { style: cx.bar.then_some("Quote"), jc: Self::align_for(n, cx), ..Self::base_ppr(cx, indent * INDENT_UNIT) };
                self.para(out, &ppr, kids(n), "", &body, cx)
            }
            "heading" => {
                // 제목 1..3 → Heading1..3. 4..6 은 3 으로 접는다(HWPX 와 같다).
                let level = (attr_f64(n, "level").unwrap_or(1.0) as i64).clamp(1, 3);
                let style = ["Heading1", "Heading2", "Heading3"][level as usize - 1];
                let ppr = PPr { style: Some(style), jc: Self::align_for(n, cx), ..Self::base_ppr(cx, 0) };
                self.para(out, &ppr, kids(n), "", &body, cx)
            }
            "bulletList" | "orderedList" | "taskList" => self.list(out, n, cx, 0, None),
            "codeBlock" => {
                let mut text = String::new();
                plain_text(n, &mut text);
                let ppr = PPr { shade: Some("F2F2F2"), tight: true, mark: Some(RunFmt::code()), ..Self::base_ppr(cx, 0) };
                for line in text.split('\n') {
                    self.text_para(out, &ppr, line.trim_end_matches('\r'), &RunFmt::code(), cx)?;
                }
                Ok(())
            }
            "blockquote" => {
                let inner = Cx { ind: cx.ind + INDENT_UNIT, bar: true, ..*cx };
                self.blocks(out, kids(n), &inner)
            }
            "details" => {
                let inner = Cx { ind: cx.ind + INDENT_UNIT, ..*cx };
                for k in kids(n) {
                    match ty(k) {
                        "detailsSummary" => {
                            let base = RunFmt { bold: true, ..RunFmt::default() };
                            self.para(out, &Self::base_ppr(cx, 0), kids(k), "", &base, cx)?;
                        }
                        "detailsContent" => self.blocks(out, kids(k), &inner)?,
                        _ => self.block(out, k, &inner)?,
                    }
                }
                Ok(())
            }
            "horizontalRule" => {
                let ppr = PPr { rule: true, ..Self::base_ppr(cx, 0) };
                self.para(out, &ppr, &[], "", &body, cx)
            }
            "table" => self.table(out, n, cx),
            "image" => {
                let ppr = PPr { jc: cx.cell_align, ..Self::base_ppr(cx, 0) };
                self.para(out, &ppr, std::slice::from_ref(n), "", &body, cx)
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
                self.text_para(out, &Self::base_ppr(cx, 0), &t, &body, cx)
            }
        }
    }

    /// 목록 하나. `depth` = 이 목록의 중첩 깊이(0 부터 = 번호 정의의 수준 `ilvl`), `parent` = 바로 위 목록의 (numId, 번호 목록인가).
    ///
    /// 항목의 **첫 문단**이 목록 문단(`w:numPr` + 깊이에 따른 왼쪽 여백)이고, 이어지는 블록은 글자 시작 위치에 맞춰 들여쓴 일반 블록,
    /// 안쪽 목록은 깊이 + 1 이다. 할 일은 번호 없이 "☐ "/"☑ " 글자 접두.
    fn list(&mut self, out: &mut String, n: &Value, cx: &Cx, depth: usize, parent: Option<(u32, bool)>) -> AppResult<()> {
        // 목록 안 목록은 `block` 을 거치지 않고 곧장 재귀하므로 여기서도 깊이 예산을 먹는다(안 그러면 ~1000단 중첩에서 스택이 터진다).
        self.budget.enter()?;
        let r = self.list_inner(out, n, cx, depth, parent);
        self.budget.leave();
        r
    }

    fn list_inner(&mut self, out: &mut String, n: &Value, cx: &Cx, depth: usize, parent: Option<(u32, bool)>) -> AppResult<()> {
        let kind = ty(n);
        let ilvl = depth.min(NUM_LEVELS - 1);
        // 글자가 시작하는 위치(= 이 수준의 `w:ind w:left`).
        let text_left = LIST_INDENT * (ilvl as i64 + 1);
        let this: Option<(u32, bool)> = match kind {
            "bulletList" => Some((BULLET_NUM, false)),
            "orderedList" => {
                let start = attr_f64(n, "start").map_or(1, |s| s as i64).clamp(1, 9999);
                match parent {
                    // 번호 목록 안의 번호 목록은 부모의 번호 정의를 이어 쓴다(수준만 한 단 깊다 — Word 가 아래 수준 번호를 다시 센다).
                    Some((id, true)) if start == 1 => Some((id, true)),
                    // 그 밖에는 새 인스턴스 — 같은 abstractNum 을 쓰는 다른 목록의 번호를 이어 세지 않도록 시작 번호를 덮어쓴다.
                    _ => {
                        if self.nums.len() >= MAX_NUMS {
                            return Err(AppError::Validation("too many numbered lists to export".to_string()));
                        }
                        self.nums.push(NumDef { level: ilvl, start });
                        Some((self.nums.len() as u32 + 1, true))
                    }
                }
            }
            _ => None,
        };
        for item in kids(n) {
            self.budget.tick()?;
            let mut first = true;
            for child in kids(item) {
                if matches!(ty(child), "bulletList" | "orderedList" | "taskList") {
                    self.list(out, child, cx, depth + 1, this)?;
                } else if first && ty(child) == "paragraph" {
                    let mut ppr = PPr { style: Some("ListParagraph"), jc: Self::align_for(child, cx), bar: cx.bar, ..PPr::default() };
                    let mut prefix = "";
                    match this {
                        Some((id, _)) => {
                            ppr.num = Some((id, ilvl));
                            // 번호 정의의 들여쓰기에 바깥 들여쓰기(인용·바깥 목록 이어 문단)를 더한다. 바깥이 없으면 정의 그대로.
                            if cx.ind > 0 {
                                ppr.ind = Some((cx.ind + text_left, LIST_HANGING));
                            }
                        }
                        None => {
                            // 할 일 — 번호 대신 글자 접두. 글자가 글머리표가 있을 자리에서 시작한다.
                            ppr.ind = Some((cx.ind + text_left - LIST_HANGING, 0));
                            prefix = if attr(item, "checked").and_then(Value::as_bool).unwrap_or(false) { "\u{2611} " } else { "\u{2610} " };
                        }
                    }
                    self.para(out, &ppr, kids(child), prefix, &RunFmt::default(), cx)?;
                } else {
                    let inner = Cx { ind: cx.ind + text_left, ..*cx };
                    self.block(out, child, &inner)?;
                }
                first = false;
            }
        }
        Ok(())
    }

    // ── 표 ────────────────────────────────────────────────────────────────

    /// 표 한 칸. 병합으로 가려진 자리(`Cont`)는 `w:vMerge` 이어짐 칸으로 쓴다 — Word 의 격자는 **모든 행이 모든 열을 덮어야** 한다.
    fn table(&mut self, out: &mut String, n: &Value, cx: &Cx) -> AppResult<()> {
        // 격자 배치(점유 계산 · 구멍 메우기 · 완전히 가려진 행 걷기)는 형식 무관이라 pm.rs 에 있다. 문서 전체 노드 예산은 이 작성기의 것을 그대로 넘긴다.
        let Some(grid) = place_grid(n, &mut || self.budget.tick())? else {
            return Ok(());
        };
        let ncols = grid.ncols;
        if ncols > MAX_TABLE_COLS {
            return Err(AppError::Validation(format!("table has too many columns for DOCX (max {MAX_TABLE_COLS})")));
        }
        let avail = (cx.avail_w - cx.ind).max(MIN_COL_WIDTH * ncols as i64);
        let widths = column_widths(&grid, avail, TWIPS_PER_PX, MIN_COL_WIDTH);
        let table_w: i64 = widths.iter().sum();
        let has_header_row = grid.rows.first().is_some_and(|r| r.iter().any(|c| c.header));
        // 표 바로 뒤의 표는 Word 가 한 표로 합친다 — 사이에 빈 문단을 둔다.
        if self.last_tbl {
            self.empty_p(out);
        }
        let _ = write!(out, r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="{table_w}" w:type="dxa"/>"#);
        if cx.ind > 0 {
            let _ = write!(out, r#"<w:tblInd w:w="{}" w:type="dxa"/>"#, cx.ind);
        }
        out.push_str(r#"<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>"#);
        for w in &widths {
            let _ = write!(out, r#"<w:gridCol w:w="{w}"/>"#);
        }
        out.push_str("</w:tblGrid>");
        // 세로 병합이 아직 이어지는 칸: (열, 가로 폭, 끝 행 + 1).
        let mut active: Vec<(usize, usize, usize)> = Vec::new();
        for (r, row) in grid.rows.iter().enumerate() {
            out.push_str("<w:tr>");
            if r == 0 && has_header_row {
                out.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            // 이 행의 자리들 — 시작하는 칸과 위에서 이어지는 칸을 열 순서로.
            let mut slots: Vec<(usize, Slot)> = row.iter().map(|c| (c.col, Slot::Start(c))).collect();
            slots.extend(active.iter().filter(|a| a.2 > r).map(|a| (a.0, Slot::Cont(a.1))));
            slots.sort_by_key(|s| s.0);
            for (col, slot) in slots {
                match slot {
                    Slot::Cont(span) => {
                        let w: i64 = widths[col..col + span].iter().sum();
                        let _ = write!(out, r#"<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>"#);
                        if span > 1 {
                            let _ = write!(out, r#"<w:gridSpan w:val="{span}"/>"#);
                        }
                        out.push_str("<w:vMerge/></w:tcPr><w:p/></w:tc>");
                        self.paragraphs += 1;
                    }
                    Slot::Start(cell) => self.cell(out, cell, &widths)?,
                }
            }
            out.push_str("</w:tr>");
            active.extend(row.iter().filter(|c| c.rowspan > 1).map(|c| (c.col, c.colspan, r + c.rowspan)));
            active.retain(|a| a.2 > r + 1);
        }
        out.push_str("</w:tbl>");
        self.last_tbl = true;
        Ok(())
    }

    fn cell(&mut self, out: &mut String, cell: &CellRef, widths: &[i64]) -> AppResult<()> {
        let cell_w: i64 = widths[cell.col..cell.col + cell.colspan].iter().sum();
        let bg = cell.node.and_then(|n| attr_str(n, "backgroundColor")).and_then(css_color);
        // 머리글 칸은 Brise 가 굵게·옅은 회색으로 그린다 — Word 에서도 머리글 행이 구분되게 같은 모양으로(칸이 직접 정한 배경이 우선).
        let fill = match (&bg, cell.header) {
            (Some(c), _) => Some(hex(c)),
            (None, true) => Some("F2F2F2".to_string()),
            (None, false) => None,
        };
        // tcPr 자식 순서: tcW, gridSpan, vMerge, shd (ECMA-376 CT_TcPr).
        let _ = write!(out, r#"<w:tc><w:tcPr><w:tcW w:w="{cell_w}" w:type="dxa"/>"#);
        if cell.colspan > 1 {
            let _ = write!(out, r#"<w:gridSpan w:val="{}"/>"#, cell.colspan);
        }
        if cell.rowspan > 1 {
            out.push_str(r#"<w:vMerge w:val="restart"/>"#);
        }
        if let Some(f) = fill {
            let _ = write!(out, r#"<w:shd w:val="clear" w:color="auto" w:fill="{f}"/>"#);
        }
        out.push_str("</w:tcPr>");
        let inner = Cx {
            ind: 0,
            bar: false,
            avail_w: (cell_w - 2 * CELL_MARGIN_LR).max(MIN_COL_WIDTH),
            cell_align: super::pm::align_of(cell.node.and_then(|n| attr_str(n, "align"))).filter(|a| *a != Align::Left),
        };
        let before = self.paragraphs;
        let content: &[Value] = cell.node.map_or(&[], kids);
        self.last_tbl = false;
        if cell.header {
            // 머리글 칸의 글자는 굵게 — 문단 베이스를 굵게 하는 경로가 없어 굵게 마크를 얹은 사본을 쓴다.
            let bolded = bold_all(content);
            self.blocks(out, &bolded, &inner)?;
        } else {
            self.blocks(out, content, &inner)?;
        }
        // 칸은 문단 하나로 끝나야 한다(비어 있어도, 안쪽 표로 끝나도 — Word 가 "읽을 수 없는 내용"으로 본다).
        if self.paragraphs == before || self.last_tbl {
            self.empty_p(out);
        }
        out.push_str("</w:tc>");
        self.last_tbl = false;
        Ok(())
    }

    // ── 그림 ──────────────────────────────────────────────────────────────

    /// 그림 한 장을 글자처럼 취급하는 개체(`wp:inline`)로. 못 넣는 그림(경로 밖·없음·상한·형식)은 `[그림: 설명]` 글자로 남기고 센다.
    ///
    /// ponytail: 대체 글자는 한국어로 고정(파일에 저장되는 데이터라 UI 로케일을 따르지 않는다 — HWPX 와 같은 이유).
    fn drawing_run(&mut self, out: &mut String, n: &Value, cx: &Cx) {
        let alt = attr_str(n, "alt").unwrap_or("").trim().to_string();
        let loaded = attr_str(n, "relPath").filter(|r| !r.is_empty()).and_then(|rel| self.imgs.load(rel));
        let Some(img) = loaded else {
            self.skipped += 1;
            let label = if alt.is_empty() { "[그림]".to_string() } else { format!("[그림: {alt}]") };
            run_xml(out, &RunFmt::default(), &label);
            return;
        };
        self.image_count += 1;
        // 본문(칸) 폭의 pct% 에 원본 비율, 쪽 높이를 넘으면 줄인다. 길이는 EMU.
        let (cw, ch) = fit_image(
            cx.avail_w * EMU_PER_TWIP,
            body_height(self.paper) * EMU_PER_TWIP,
            image_pct(n),
            i64::from(img.w_px),
            i64::from(img.h_px),
        );
        let ext = self.imgs.entries[img.idx].ext;
        let rid = self.image_rid(img.idx, ext);
        self.docpr += 1;
        let id = self.docpr;
        let file = media_name(img.idx, ext);
        let _ = write!(
            out,
            r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cw}" cy="{ch}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture {id}" descr="{}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="{file}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cw}" cy="{ch}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
            esc_attr(&alt)
        );
    }
}

enum Slot<'a, 'v> {
    /// 이 행에서 시작하는 칸.
    Start(&'a CellRef<'v>),
    /// 위 행에서 이어지는 세로 병합 칸(가로 폭 = 열 수).
    Cont(usize),
}

// ── 런 출력 ───────────────────────────────────────────────────────────────────

/// 같은 서식이면 이어 붙이고, 다르면 앞 런을 내보내고 새 런을 연다.
fn push_text(out: &mut String, pending: &mut Option<(RunFmt, String)>, fmt: RunFmt, text: &str) {
    match pending {
        Some((f, s)) if *f == fmt => s.push_str(text),
        _ => {
            flush_run(out, pending);
            *pending = Some((fmt, text.to_string()));
        }
    }
}

fn flush_run(out: &mut String, pending: &mut Option<(RunFmt, String)>) {
    if let Some((fmt, text)) = pending.take() {
        run_xml(out, &fmt, &text);
    }
}

/// 런 하나. 탭 → `w:tab`, 개행 → `w:br`, 나머지는 `xml:space="preserve"` 인 `w:t`(앞뒤 공백을 지킨다). 불법 글자는 이스케이프에서 버려진다.
fn run_xml(out: &mut String, fmt: &RunFmt, text: &str) {
    out.push_str("<w:r>");
    out.push_str(&fmt.rpr());
    let mut seg = String::new();
    let flush_seg = |seg: &mut String, out: &mut String| {
        if !seg.is_empty() {
            out.push_str(r#"<w:t xml:space="preserve">"#);
            esc_into(seg, out, false);
            out.push_str("</w:t>");
            seg.clear();
        }
    };
    for c in text.chars() {
        match c {
            '\t' => {
                flush_seg(&mut seg, out);
                out.push_str("<w:tab/>");
            }
            '\n' => {
                flush_seg(&mut seg, out);
                out.push_str("<w:br/>");
            }
            '\r' => {}
            c => seg.push(c),
        }
    }
    flush_seg(&mut seg, out);
    out.push_str("</w:r>");
}

// ── 정적 부품 ─────────────────────────────────────────────────────────────────

const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/// 본문 루트의 네임스페이스 — 그림이 쓰는 wp·a·pic 과 관계 참조 r.
const DOC_NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

/// 글꼴 — 본문·제목은 맑은 고딕(영문·한글 모두), 코드는 Consolas. 이름만 적는다(파일에 글꼴을 싣지 않는다).
const BODY_FACE: &str = "맑은 고딕";

/// 압축 파일 안 그림 이름(`image1.png`). jpg 는 Word 표기대로 `jpeg`.
fn media_name(idx: usize, ext: &str) -> String {
    format!("image{}.{}", idx + 1, if ext == "jpg" { "jpeg" } else { ext })
}

fn content_types_xml() -> String {
    const WORD: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml";
    format!(
        r#"{XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="{WORD}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="{WORD}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="{WORD}.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="{WORD}.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"#
    )
}

const ROOT_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#;

fn document_rels_xml(rels: &[Rel]) -> String {
    let mut o = String::new();
    o.push_str(XML_DECL);
    o.push_str(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#);
    for (id, kind, target) in [("rId1", "styles", "styles.xml"), ("rId2", "numbering", "numbering.xml"), ("rId3", "settings", "settings.xml")] {
        let _ = write!(o, r#"<Relationship Id="{id}" Type="{REL_BASE}/{kind}" Target="{target}"/>"#);
    }
    for r in rels {
        let mode = if r.external { r#" TargetMode="External""# } else { "" };
        let _ = write!(o, r#"<Relationship Id="{}" Type="{REL_BASE}/{}" Target="{}"{mode}/>"#, r.id, r.kind, esc_attr(&r.target));
    }
    o.push_str("</Relationships>");
    o
}

fn core_xml(title: &str) -> String {
    let now = super::export_now().format("%Y-%m-%dT%H:%M:%SZ");
    let mut t = String::new();
    esc_into(title.trim(), &mut t, false);
    format!(
        r#"{XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{t}</dc:title><dc:creator>Brise</dc:creator><cp:lastModifiedBy>Brise</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>"#
    )
}

const APP_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Brise</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop></Properties>"#;

/// 설정 — `compatibilityMode` 15 가 없으면 Word 가 "호환 모드" 배너를 띄우고 옛 배치 규칙을 쓴다.
const SETTINGS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>"#;

/// 스타일. 기본 서식은 Word 저장본 모양(`docDefaults` → 기본 스타일 넷 → 제목 → 목록 문단 · 하이퍼링크 · 표 격자). 스타일 자식 순서는
/// name, basedOn, next, uiPriority, semiHidden, unhideWhenUsed, qFormat, pPr, rPr, tblPr (ECMA-376 CT_Style).
fn styles_xml() -> String {
    let heading = |n: u8, before: u32, size: u32| {
        format!(
            r#"<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{before}" w:after="100"/><w:outlineLvl w:val="{}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>"#,
            n - 1
        )
    };
    format!(
        r#"{XML_DECL}<w:styles xmlns:w="{NS_W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{BODY_FACE}" w:eastAsia="{BODY_FACE}" w:hAnsi="{BODY_FACE}" w:cs="{BODY_FACE}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="{CELL_MARGIN_LR}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="{CELL_MARGIN_LR}" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>{}{}{}<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="400"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="{CELL_MARGIN_LR}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="{CELL_MARGIN_LR}" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>"#,
        heading(1, 320, 32),
        heading(2, 240, 28),
        heading(3, 200, 24),
    )
}

/// 번호 정의: abstractNum 0 = 글머리표(• ◦ ▪ 를 돌려 쓴다), 1 = 번호(1. a. i. 를 돌려 쓴다), 이어서 `w:num` 들 — numId 1 = 글머리표,
/// 2.. = 번호 목록 인스턴스마다 하나(시작 번호를 모든 수준에서 덮어쓴다). abstractNum 이 모든 `w:num` 보다 **앞**이어야 한다.
///
/// 글머리표는 Symbol 글꼴의 사설 영역 문자 대신 일반 유니코드 문자다 — Word 가 아닌 뷰어(LibreOffice · Google Docs · 가져오기)에서도 그대로 읽힌다.
fn numbering_xml(nums: &[NumDef]) -> String {
    let mut o = String::new();
    o.push_str(XML_DECL);
    let _ = write!(o, r#"<w:numbering xmlns:w="{NS_W}">"#);
    for (abstract_id, bullet) in [(0, true), (1, false)] {
        let kind = if bullet { "hybridMultilevel" } else { "multilevel" };
        let _ = write!(o, r#"<w:abstractNum w:abstractNumId="{abstract_id}"><w:multiLevelType w:val="{kind}"/>"#);
        for lvl in 0..NUM_LEVELS {
            let (fmt, text) = if bullet {
                ("bullet", ["\u{2022}", "\u{25E6}", "\u{25AA}"][lvl % 3].to_string())
            } else {
                (["decimal", "lowerLetter", "lowerRoman"][lvl % 3], format!("%{}.", lvl + 1))
            };
            let left = LIST_INDENT * (lvl as i64 + 1);
            let _ = write!(
                o,
                r#"<w:lvl w:ilvl="{lvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{left}" w:hanging="{LIST_HANGING}"/></w:pPr></w:lvl>"#
            );
        }
        o.push_str("</w:abstractNum>");
    }
    let _ = write!(o, r#"<w:num w:numId="{BULLET_NUM}"><w:abstractNumId w:val="0"/></w:num>"#);
    for (i, def) in nums.iter().enumerate() {
        let _ = write!(o, r#"<w:num w:numId="{}"><w:abstractNumId w:val="1"/>"#, i + 2);
        for lvl in 0..NUM_LEVELS {
            let start = if lvl == def.level { def.start } else { 1 };
            let _ = write!(o, r#"<w:lvlOverride w:ilvl="{lvl}"><w:startOverride w:val="{start}"/></w:lvlOverride>"#);
        }
        o.push_str("</w:num>");
    }
    o.push_str("</w:numbering>");
    o
}

/// 마지막 `w:sectPr` — 용지 크기·여백(`margins`). 가로는 폭·높이를 맞바꾸고 `w:orient="landscape"`. 본문(`w:body`)의 **맨 마지막** 자식이다.
fn sect_pr_xml(paper: Paper) -> String {
    let (w, h) = page_size(paper);
    let (top, lr, bottom) = margins(paper);
    let orient = if paper.landscape { r#" w:orient="landscape""# } else { "" };
    format!(
        r#"<w:sectPr><w:pgSz w:w="{w}" w:h="{h}"{orient}/><w:pgMar w:top="{top}" w:right="{lr}" w:bottom="{bottom}" w:left="{lr}" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>"#
    )
}

/// zip 으로 묶는다. `[Content_Types].xml` 이 첫 엔트리(OPC 관례). 엔트리 시각은 1980-01-01 로 고정(실제 저장본도 그렇다).
fn package<W: std::io::Write + std::io::Seek>(w: &Writer, title: &str, document_xml: &str, sink: W) -> AppResult<W> {
    let mut zw = ZipOut::new(sink);
    zw.put("[Content_Types].xml", false, content_types_xml().as_bytes())?;
    zw.put("_rels/.rels", false, ROOT_RELS_XML.as_bytes())?;
    zw.put("word/document.xml", false, document_xml.as_bytes())?;
    zw.put("word/_rels/document.xml.rels", false, document_rels_xml(&w.rels).as_bytes())?;
    zw.put("word/styles.xml", false, styles_xml().as_bytes())?;
    zw.put("word/numbering.xml", false, numbering_xml(&w.nums).as_bytes())?;
    zw.put("word/settings.xml", false, SETTINGS_XML.as_bytes())?;
    for (i, img) in w.imgs.entries.iter().enumerate() {
        // 이미 압축된 형식(png·jpg·gif)은 다시 압축하지 않는다.
        zw.put(&format!("word/media/{}", media_name(i, img.ext)), img.ext != "bmp", &img.bytes)?;
    }
    zw.put("docProps/core.xml", false, core_xml(title).as_bytes())?;
    zw.put("docProps/app.xml", false, APP_XML.as_bytes())?;
    zw.finish()
}

// ── 진입점 ────────────────────────────────────────────────────────────────────

/// 섹션들 → .docx 바이트. **순수** — 파일·DB 를 건드리지 않는다(그림은 `resolve` 가 relPath → 바이트로 읽는다; 못 읽으면 None).
///
/// 섹션이 둘 이상이면 섹션 이름을 제목 1 문단으로 앞에 둔다. 노트 제목(`title`)은 본문에 넣지 않고 문서 정보(dc:title)에만 쓴다.
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
    let cx = Cx { ind: 0, bar: false, avail_w: body_width(paper), cell_align: None };
    let mut body = String::new();
    for s in sections {
        if let Some(name) = section_heading(sections, s) {
            w.block(&mut body, &name, &cx)?;
        }
        w.blocks(&mut body, kids(&s.doc), &cx)?;
    }
    // 본문은 문단으로 끝나야 한다 — 내용이 하나도 없어도, 표로 끝나도 문단 하나를 더한다.
    if w.paragraphs == 0 || w.last_tbl {
        w.empty_p(&mut body);
    }
    let mut document = String::with_capacity(body.len() + 1024);
    document.push_str(XML_DECL);
    let _ = write!(document, "<w:document {DOC_NS}><w:body>");
    document.push_str(&body);
    document.push_str(&sect_pr_xml(paper));
    document.push_str("</w:body></w:document>");
    let sink = package(&w, title, &document, sink)?;
    Ok((sink, w.image_count, w.skipped))
}

// 테스트는 `docx/tests.rs` — 세 가지를 본다. ① 구조: 만든 zip 이 OPC/WordprocessingML 의 약속을 지키는지(모든 파트가 콘텐츠 타입에 있음,
// 모든 관계 대상이 있음, r:id/r:embed/numId/스타일 참조가 가리키는 곳이 있음, docPr id 유일, 자식 요소 **순서**, 표의 모든 행이 격자를 덮음,
// 칸·본문이 문단으로 끝남, 세로 병합 이어짐이 시작 칸 아래에 있음). ② 왕복: 가져오기(`doc_import::docx`)로 다시 읽어 내용이 같은지.
// ③ 안전: 이스케이프·불법 글자·링크 범위·그림 경로 탈출·상한. Word 가 없는 환경이라 "Word 가 연다"는 보증하지 못한다 — `DOCX_EXPORT_SAMPLE_OUT` 샘플로 확인.
#[cfg(test)]
mod tests;
