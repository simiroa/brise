// repo: doc_import::hwpx — HWPX → 서식 있는 HTML (PLAN-2026-10-07-doc-import-export W1, W4-0 에서 doc_import 로 이동)
//
// 본 제품은 한글과컴퓨터의 글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
// (OWPML/KS X 6101 구조를 참고했다 — 정확한 고지 문구·위치는 조사 §6.7 대로 W3 전에 스펙 PDF 와 대조해 확정한다.)
//
// 왜 HTML 인가: 프런트가 이 HTML 을 붙여넣기와 같은 관문(`mdSerializeHtml`)에 태워 `body_md` 를 만든다. 마크다운
// 직렬화 규칙을 Rust 에 두 번째로 두지 않으려는 것이라, 이 모듈이 내보내는 HTML 은 **Brise 스키마가
// parseHTML 로 아는 부분집합**만 쓴다(specs/commands/sections.yaml doc_import_html). 섹션은 만들지 않는다.
//
// 세 겹으로 나눈다 — ① 파싱(DB 없음): zip → XML 트리 → 중간 표현(`Block`) + 그림 바이트 + 못 옮긴 요소 개수.
// ② 후처리: 빈 문단 접기, 제목 추정(문서 전체의 본문 글자 높이가 있어야 하므로 한 번에 못 한다).
// ③ 렌더: HTML 을 쓰는 **유일한** 자리 — 이스케이프와 `#rrggbb` 검증이 한 곳에 모인다.
// 그림 저장만 DB 를 건드리므로 `import()` 가 ① 뒤에 짧게 락을 잡는다.
//
// 태그·속성은 전부 **로컬 이름**으로 맞춘다(접두사 hp/hh/hc/hs 가 달라도, 2011/2016/2024 네임스페이스 모두).
// 요소·속성 이름의 근거는 hwpxlib(`reader/section_xml`, `reader/header_xml`)의 리더 클래스와 python-hwpx 의
// `hyperlink_form.py` 다 — 추측한 이름은 없다.
//
// 못 옮기는 것(조용히 버리는 것 말고 `dropped` 로 세는 것): 머리말·꼬리말(header_footer) · 수식 스크립트 외 모양(equation) ·
// 도형(shape, 글상자 안 글은 문단으로 꺼낸다) · OLE(ole) · 차트(chart) · 지원 안 하는 그림 형식(image_format) ·
// 없는 그림(image_missing) · 상한을 넘는 그림(image_limit) · 하이퍼링크 아닌 필드(field).
//
// ponytail: 번호 목록의 시작 번호·번호 서식, 글머리표 모양, 글꼴·글자 크기·줄간격, 자간, 쪽·단 나누기, 그림 자르기·회전,
// 변경 추적은 버린다(내용은 남김). 천장 = "원본과 비슷하게"(계획 §0-2). 목록 시작 번호는 `<ol start>` 로 올릴 수 있다.
use super::html::{norm_color, safe_href};
use super::ir::{
    build_table, clean_text, finish_blocks, infer_headings, Align, Block, Cell, ImgBlock, Inline, Kind, Para, ParaAcc, Parsed,
    Piece, Style, Table, MAX_COLSPAN, MAX_ROWSPAN,
};
use super::xml::{eff_child, effective, find_all, find_first, num, parse_xml, pick_switch, Kid, Node};
use super::images::ImagePool;
use super::{DocImportDropped, MAX_DOC_FILE_BYTES, MAX_IMAGE_LOOKUPS};
use crate::error::{io as io_err, AppError, AppResult};
use crate::repo::extraction::{numbered_zip_entries, read_entry_capped, MAX_DECOMPRESSED_BYTES};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::path::Path;
use zip::ZipArchive;

/// 파일이 마음대로 줄 수 있는 숫자 속성의 상한 — 읽는 자리에서 한 번 막아 두면 뒤의 곱셈·뺄셈이 넘칠 길이 없다.
/// 길이(폭·여백·셀 너비)는 ±10억 HWPUNIT(≈ 3.5km, A4 폭의 1.7만 배), 글자 높이는 100000(= 1000pt, 기본 10pt 의 100배).
/// 릴리즈 빌드는 정수 오버플로를 조용히 감싸고 debug(`tauri dev`·`cargo test`)는 panic 한다.
const MAX_HWPUNIT: i64 = 1_000_000_000;
const MAX_CHAR_HEIGHT: u32 = 100_000;

/// 길이(HWPUNIT) 속성 — `MAX_HWPUNIT` 로 막는다. 폭·여백·셀 너비·그림 크기는 전부 이걸로 읽는다.
fn hwpunit(s: Option<&str>) -> Option<i64> {
    num::<i64>(s).map(|v| v.clamp(-MAX_HWPUNIT, MAX_HWPUNIT))
}

// ── 스타일 표(header.xml) ─────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct CharPr {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    color: Option<String>,
    /// 글자 배경(shadeColor) 이 있는가 → `<mark>`.
    shade: bool,
    height: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HeadKind {
    Outline,
    Number,
    Bullet,
}

#[derive(Clone, Default)]
struct ParaPr {
    align: Align,
    head: Option<(HeadKind, u8)>,
    /// 왼쪽 여백, `hp:case` 단위(= `hp:default` 값의 절반으로 환산한 것).
    left_hu: i64,
}

#[derive(Default)]
struct Styles {
    chars: HashMap<String, CharPr>,
    paras: HashMap<String, ParaPr>,
    /// borderFill id → 배경색(흰색·없음은 None).
    fills: HashMap<String, Option<String>>,
}

fn read_char_pr(n: &Node) -> CharPr {
    let mut c = CharPr {
        height: num::<u32>(n.attr("height")).filter(|h| *h > 0).map_or(1000, |h| h.min(MAX_CHAR_HEIGHT)),
        // #000000 은 글자 기본색이라 색을 따로 박지 않는다.
        color: n.attr("textColor").and_then(norm_color).filter(|c| c != "#000000"),
        shade: n.attr("shadeColor").and_then(norm_color).is_some_and(|c| c != "#ffffff"),
        ..Default::default()
    };
    for (k, _) in effective(n) {
        match k.name.as_str() {
            "bold" => c.bold = true,
            "italic" => c.italic = true,
            // 기본 글자 모양에도 `<hh:underline type="NONE"/>`·`<hh:strikeout shape="NONE"/>` 가 들어 있다 — 요소 유무가 아니라 값을 본다.
            "underline" => c.underline = k.attr("type").is_some_and(|t| !t.eq_ignore_ascii_case("NONE")),
            "strikeout" => c.strike = k.attr("shape").is_some_and(|s| !s.eq_ignore_ascii_case("NONE")),
            _ => {}
        }
    }
    c
}

fn read_para_pr(n: &Node) -> ParaPr {
    let mut p = ParaPr::default();
    for (k, from_default) in effective(n) {
        match k.name.as_str() {
            "align" => {
                let h = k.attr("horizontal").unwrap_or("").to_ascii_uppercase();
                p.align = if h == "JUSTIFY" || h.starts_with("DISTRIBUTE") {
                    Align::Justify
                } else if h == "CENTER" {
                    Align::Center
                } else if h == "RIGHT" {
                    Align::Right
                } else {
                    Align::Left
                };
            }
            "heading" => {
                let level = num::<u8>(k.attr("level")).unwrap_or(0);
                p.head = match k.attr("type").unwrap_or("").to_ascii_uppercase().as_str() {
                    "OUTLINE" => Some((HeadKind::Outline, level)),
                    "NUMBER" => Some((HeadKind::Number, level)),
                    "BULLET" => Some((HeadKind::Bullet, level)),
                    _ => None,
                };
            }
            "margin" => {
                for (m, m_default) in effective(k) {
                    if m.name == "left" {
                        let v = hwpunit(m.attr("value")).unwrap_or(0);
                        // 여백·탭은 switch 안에 두 벌이고 default 가 case 의 2배라고 알려져 있다(조사 §6.2).
                        // UNVERIFIED: 이 /2 규칙은 조사 문서의 서술일 뿐 실제 한컴 저장본으로 확인하지 않았다 —
                        // 확인되면 이 줄과 테스트 `indent_uses_case_value_and_halves_default` 의 숫자를 같이 본다.
                        p.left_hu = if from_default || m_default { v / 2 } else { v };
                    }
                }
            }
            _ => {}
        }
    }
    p
}

fn read_styles(header: &Node) -> Styles {
    let mut s = Styles::default();
    let mut found = Vec::new();
    find_all(header, "charPr", &mut found);
    for n in found.drain(..) {
        if let Some(id) = n.attr("id") {
            s.chars.insert(id.to_string(), read_char_pr(n));
        }
    }
    find_all(header, "paraPr", &mut found);
    for n in found.drain(..) {
        if let Some(id) = n.attr("id") {
            s.paras.insert(id.to_string(), read_para_pr(n));
        }
    }
    find_all(header, "borderFill", &mut found);
    for n in found.drain(..) {
        if let Some(id) = n.attr("id") {
            let fill = find_first(n, "winBrush")
                .and_then(|b| b.attr("faceColor"))
                .and_then(norm_color)
                .filter(|c| c != "#ffffff");
            s.fills.insert(id.to_string(), fill);
        }
    }
    s
}

/// `Command` 끝의 종류 꼬리(`;1;0;0;` 웹 · `;2;0;0` 메일 · `;0;0;0;` 책갈피)를 뗀다(python-hwpx `_COMMAND_TAIL`).
fn strip_link_tail(cmd: &str) -> &str {
    let mut s = cmd.strip_suffix(';').unwrap_or(cmd);
    for _ in 0..3 {
        let Some(pos) = s.rfind(';') else { return cmd };
        let digits = &s[pos + 1..];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return cmd;
        }
        s = &s[..pos];
    }
    s
}

/// 한컴은 링크 대상을 `fieldBegin > parameters` 에 두고 `:?;#` 앞에 역슬래시를 붙인다(python-hwpx `hyperlink_target`).
/// `Path`(평문 주소)가 있으면 그것, 없으면 `Command` 에서 꼬리·툴팁(`|`)을 떼고 역슬래시를 푼다.
fn hyperlink_target(field: &Node) -> Option<String> {
    let mut command: Option<String> = None;
    for params in field.elements().filter(|n| n.name == "parameters") {
        for p in params.elements() {
            match p.attr("name") {
                Some("Path") => {
                    let t = p.text();
                    if !t.trim().is_empty() {
                        return safe_href(&t);
                    }
                }
                Some("Command") => command = Some(p.text()),
                _ => {}
            }
        }
    }
    let target = match command {
        Some(cmd) if !cmd.trim().is_empty() => {
            let head = strip_link_tail(cmd.trim()).split('|').next().unwrap_or("").to_string();
            let mut unescaped = String::with_capacity(head.len());
            let mut chars = head.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(n) = chars.next() {
                        unescaped.push(n);
                    }
                } else {
                    unescaped.push(c);
                }
            }
            unescaped
        }
        // 예전 python-hwpx 는 대상을 `@name` 에만 적었다.
        _ => field.attr("name").unwrap_or("").to_string(),
    };
    // `?이름` 은 책갈피 링크 — 노트 안에는 갈 곳이 없다.
    if target.starts_with('?') {
        return None;
    }
    safe_href(&target)
}

// ── 파서 ──────────────────────────────────────────────────────────────────────

/// 컨테이너 문맥: 그림 너비 %의 기준 너비(HWPUNIT) — 본문에서는 본문 폭, 셀 안에서는 그 셀의 너비.
#[derive(Clone, Copy)]
struct Cx {
    cw: i64,
}

struct LinkState {
    id: String,
    href: Option<String>,
}

/// 문단 하나를 짓는 중의 상태 — 형식 무관 부분(`ParaAcc`: 표·그림을 만나면 그 앞까지를 문단으로 내보낸다)에 링크·형광펜 상태를 더한다.
struct ParaBuilder {
    acc: ParaAcc,
    link: Option<LinkState>,
    mark: bool,
}

impl std::ops::Deref for ParaBuilder {
    type Target = ParaAcc;
    fn deref(&self) -> &ParaAcc {
        &self.acc
    }
}

impl std::ops::DerefMut for ParaBuilder {
    fn deref_mut(&mut self) -> &mut ParaAcc {
        &mut self.acc
    }
}

impl ParaBuilder {
    fn finish(self, out: &mut Vec<Block>) {
        self.acc.finish(out);
    }
}

struct Parser<'a> {
    styles: &'a Styles,
    /// manifest item id → href.
    manifest: HashMap<String, String>,
    zip: &'a mut ZipArchive<File>,
    /// 소문자 엔트리 이름 → 실제 이름(BTreeMap = 폴백 탐색이 결정적).
    entries: BTreeMap<String, String>,
    /// 그림 저장소(상한 · 같은 엔트리 한 번만 풀기) — 형식 무관 부분(`images.rs`).
    pool: ImagePool,
    img_by_id: HashMap<String, Option<usize>>,
    dropped: BTreeMap<&'static str, u32>,
    footnotes: Vec<Vec<Block>>,
    body_w: i64,
    /// 글자 높이별 글자 수(공백 제외) — 본문 기준 높이(최빈값)를 구해 제목을 추정한다.
    height_chars: HashMap<u32, usize>,
}

fn normalize_href(href: &str) -> String {
    let mut s = href.trim().replace('\\', "/");
    loop {
        if let Some(rest) = s.strip_prefix("./") {
            s = rest.to_string();
        } else if let Some(rest) = s.strip_prefix("../") {
            s = rest.to_string();
        } else if let Some(rest) = s.strip_prefix('/') {
            s = rest.to_string();
        } else {
            break;
        }
    }
    s
}

impl<'a> Parser<'a> {
    fn drop_kind(&mut self, kind: &'static str) {
        let c = self.dropped.entry(kind).or_insert(0);
        *c = c.saturating_add(1);
    }

    fn char_pr(&self, id: &str) -> CharPr {
        self.styles.chars.get(id).cloned().unwrap_or(CharPr { height: 1000, ..Default::default() })
    }

    // ── 문단 ───────────────────────────────────────────────────────────────

    /// 컨테이너(`hs:sec`·`hp:subList`)의 문단들을 블록으로. 정리(`finish_blocks`)는 호출자가 한다.
    fn blocks_of(&mut self, list: &Node, cx: Cx) -> AppResult<Vec<Block>> {
        let mut out = Vec::new();
        for (p, _) in effective(list) {
            if p.name == "p" {
                self.para(p, cx, &mut out)?;
            }
        }
        Ok(out)
    }

    fn para(&mut self, p: &Node, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        let pr = self.styles.paras.get(p.attr("paraPrIDRef").unwrap_or("")).cloned().unwrap_or_default();
        let (kind, level) = match pr.head {
            // 개요 0 → h1, 1 → h2, 2 이상 → h3.
            Some((HeadKind::Outline, l)) => (Kind::Heading(l.min(2) + 1), 0),
            Some((HeadKind::Number, l)) => (Kind::Ol, l.min(5)),
            Some((HeadKind::Bullet, l)) => (Kind::Ul, l.min(5)),
            None => (Kind::Normal, 0),
        };
        // 들여쓰기 한 단 = 2em = 글자 2개 = 2000 HWPUNIT(10pt 기준).
        let indent = ((pr.left_hu as f64 / 2000.0).round() as i64).clamp(0, 6) as u8;
        let mut b = ParaBuilder { acc: ParaAcc::new(kind, level, pr.align, indent), link: None, mark: false };
        for (r, _) in effective(p) {
            if r.name == "run" {
                self.run(r, &mut b, cx, out)?;
            }
        }
        b.finish(out);
        Ok(())
    }

    fn run(&mut self, run: &Node, b: &mut ParaBuilder, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        let run_cp = run.attr("charPrIDRef").unwrap_or("").to_string();
        for (c, _) in effective(run) {
            match c.name.as_str() {
                "t" => {
                    // `hp:t` 가 자기 charPrIDRef 를 가지면 run 의 것을 덮는다.
                    let cp = self.char_pr(c.attr("charPrIDRef").unwrap_or(&run_cp));
                    self.t_kids(c, &cp, b);
                }
                "ctrl" => self.ctrl(c, b)?,
                // 형광펜은 `hp:t` 안에도, run 의 직계에도 온다(hwpxlib TReader/RunReader).
                "markpenBegin" => b.mark = true,
                "markpenEnd" => b.mark = false,
                "secPr" => {}
                _ => self.object(c, &run_cp, b, cx, out)?,
            }
        }
        Ok(())
    }

    /// `hp:t` 의 자식을 순서대로 — 글자와 `tab`·`lineBreak`·`nbSpace`·형광펜 표지가 섞여 있다.
    fn t_kids(&mut self, n: &Node, cp: &CharPr, b: &mut ParaBuilder) {
        for k in &n.kids {
            match k {
                Kid::Text(s) => self.push_text(b, s, cp),
                Kid::El(e) => match e.name.as_str() {
                    "tab" => self.push_text(b, " ", cp),
                    "lineBreak" => b.inl.push(Inline::Br),
                    "nbSpace" => self.push_text(b, "\u{a0}", cp),
                    "fwSpace" => self.push_text(b, "\u{3000}", cp),
                    // hwpxlib 의 상수명은 `hypen`(오타) — 파일에는 `hyphen` 이지만 둘 다 받는다.
                    "hyphen" | "hypen" => self.push_text(b, "-", cp),
                    "markpenBegin" => b.mark = true,
                    "markpenEnd" => b.mark = false,
                    "switch" => {
                        if let Some(chosen) = pick_switch(e) {
                            self.t_kids(chosen, cp, b);
                        }
                    }
                    _ => {} // titleMark · 변경 추적 표지 · unknownch — 글자는 그대로 둔다
                },
            }
        }
    }

    fn push_text(&mut self, b: &mut ParaBuilder, raw: &str, cp: &CharPr) {
        let text = clean_text(raw);
        if text.is_empty() {
            return;
        }
        let n = text.chars().filter(|c| !c.is_whitespace()).count();
        if n > 0 {
            *self.height_chars.entry(cp.height).or_default() += n;
        }
        let st = Style {
            bold: cp.bold,
            italic: cp.italic,
            underline: cp.underline,
            strike: cp.strike,
            mark: cp.shade || b.mark,
            code: false,
            color: cp.color.clone(),
            height: cp.height,
        };
        self.push_piece(b, text, st);
    }

    /// 한컴은 링크 글자를 파랑 + 밑줄로 칠한다 — 링크 표시는 Brise 가 알아서 하므로 그 장식은 벗긴다.
    fn push_piece(&mut self, b: &mut ParaBuilder, text: String, mut st: Style) {
        let link = b.link.as_ref().and_then(|l| l.href.clone());
        if link.is_some() {
            st.underline = false;
            if st.color.as_deref() == Some("#0000ff") {
                st.color = None;
            }
        }
        if let Some(Inline::Text(last)) = b.inl.last_mut() {
            if last.st == st && last.link == link {
                last.text.push_str(&text);
                return;
            }
        }
        b.inl.push(Inline::Text(Piece { text, st, link }));
    }

    /// 직전 글자와 같은 모양으로 덧붙인다(각주 표지·자동 번호처럼 자기 글자 모양이 없는 것).
    fn push_plain(&mut self, b: &mut ParaBuilder, text: String) {
        let st = b
            .inl
            .iter()
            .rev()
            .find_map(|i| match i {
                Inline::Text(p) => Some(Style { height: p.st.height, ..Default::default() }),
                Inline::Br => None,
            })
            .unwrap_or_default();
        self.push_piece(b, text, st);
    }

    // ── 컨트롤(링크 · 머리말 · 각주 · 자동 번호) ───────────────────────────────

    fn ctrl(&mut self, c: &Node, b: &mut ParaBuilder) -> AppResult<()> {
        for (k, _) in effective(c) {
            match k.name.as_str() {
                "fieldBegin" => {
                    let ty = k.attr("type").unwrap_or("").to_ascii_uppercase();
                    if ty == "HYPERLINK" {
                        b.link = Some(LinkState {
                            id: k.attr("id").unwrap_or("").to_string(),
                            href: hyperlink_target(k),
                        });
                    } else if ty != "BOOKMARK" {
                        // 누름틀·날짜·상호참조 … 표시 글자는 남지만 필드로서의 동작은 잃는다.
                        self.drop_kind("field");
                    }
                }
                "fieldEnd" => {
                    if let Some(l) = &b.link {
                        let r = k.attr("beginIDRef").unwrap_or("");
                        if r.is_empty() || r == l.id {
                            b.link = None;
                        }
                    }
                }
                "header" | "footer" => {
                    self.drop_kind("header_footer");
                    b.had_object = true;
                }
                "footNote" | "endNote" => self.footnote(k, b)?,
                "autoNum" => {
                    // 그림·표·수식 번호("그림 1")는 글자가 아니라 번호 값(`num`)으로만 저장돼 있다.
                    // 쪽 번호·각주 번호는 넣지 않는다(각주는 우리가 표지를 직접 붙인다).
                    let ty = k.attr("numType").unwrap_or("").to_ascii_uppercase();
                    if matches!(ty.as_str(), "PICTURE" | "TABLE" | "EQUATION") {
                        if let Some(n) = k.attr("num").filter(|n| !n.trim().is_empty()) {
                            self.push_plain(b, clean_text(n));
                        }
                    }
                }
                _ => {} // 쪽번호·책갈피·단 정의·찾아보기 표지 등 레이아웃 컨트롤 — 조용히 무시
            }
        }
        Ok(())
    }

    /// 각주·미주 — 본문엔 `[n]`, 내용은 본문 끝 "각주" 목록으로(내용 보존, 위치 손실).
    fn footnote(&mut self, n: &Node, b: &mut ParaBuilder) -> AppResult<()> {
        let num = self.footnotes.len() + 1;
        self.push_plain(b, format!("[{num}]"));
        let cx = Cx { cw: self.body_w };
        let mut blocks = match eff_child(n, "subList") {
            Some(sub) => self.blocks_of(sub, cx)?,
            None => Vec::new(),
        };
        finish_blocks(&mut blocks, false);
        let marker = Inline::Text(Piece { text: format!("[{num}] "), st: Style::default(), link: None });
        match blocks.first_mut() {
            Some(Block::Para(p)) => p.inl.insert(0, marker),
            _ => blocks.insert(
                0,
                Block::Para(Para { kind: Kind::Normal, level: 0, align: Align::Left, indent: 0, ord: None, inl: vec![marker] }),
            ),
        }
        self.footnotes.push(blocks);
        Ok(())
    }

    // ── 개체(표 · 그림 · 도형 · 수식) ─────────────────────────────────────────

    fn object(&mut self, c: &Node, run_cp: &str, b: &mut ParaBuilder, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        match c.name.as_str() {
            "tbl" => {
                b.flush_before_object(out);
                let caption = self.caption(c, cx)?;
                let table = self.table(c, cx)?;
                match caption {
                    Some((mut blocks, false)) => {
                        out.append(&mut blocks);
                        out.extend(table.map(Block::Table));
                    }
                    Some((mut blocks, true)) => {
                        out.extend(table.map(Block::Table));
                        out.append(&mut blocks);
                    }
                    None => out.extend(table.map(Block::Table)),
                }
            }
            "pic" => {
                b.flush_before_object(out);
                let caption = self.caption(c, cx)?;
                let image = self.pic_block(c, cx)?;
                match caption {
                    Some((mut blocks, false)) => {
                        out.append(&mut blocks);
                        out.extend(image.map(Block::Image));
                    }
                    Some((mut blocks, true)) => {
                        out.extend(image.map(Block::Image));
                        out.append(&mut blocks);
                    }
                    None => out.extend(image.map(Block::Image)),
                }
            }
            "equation" => {
                self.drop_kind("equation");
                b.had_object = true;
                if let Some(script) = c.elements().find(|k| k.name == "script") {
                    let text = clean_text(&script.text()).split_whitespace().collect::<Vec<_>>().join(" ");
                    if !text.is_empty() {
                        let height = self.char_pr(run_cp).height;
                        self.push_piece(b, text, Style { code: true, height, ..Default::default() });
                    }
                }
            }
            "ole" => {
                self.drop_kind("ole");
                b.had_object = true;
            }
            "chart" => {
                self.drop_kind("chart");
                b.had_object = true;
            }
            // 묶음 개체: 컨테이너 자신은 세지 않고 안의 그림·도형·글상자를 같은 규칙으로 꺼낸다.
            "container" => {
                for (k, _) in effective(c) {
                    self.object(k, run_cp, b, cx, out)?;
                }
            }
            "rect" | "ellipse" | "arc" | "polygon" | "curve" | "line" | "connectLine" | "textart" | "compose"
            | "dutmal" => self.shape(c, b, cx, out)?,
            "btn" | "radioBtn" | "checkBtn" | "comboBox" | "edit" | "listBox" | "scrollBar" | "video" => {
                self.drop_kind("shape");
                b.had_object = true;
            }
            _ => {}
        }
        Ok(())
    }

    /// 도형: 모양·위치는 버리고(`shape` 로 센다), 글상자(`drawText > subList`) 안 글은 그 자리에 일반 문단으로 꺼낸다.
    fn shape(&mut self, s: &Node, b: &mut ParaBuilder, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        self.drop_kind("shape");
        b.had_object = true; // 도형만 앵커한 문단은 빈 문단을 남기지 않는다
        if let Some(sub) = eff_child(s, "drawText").and_then(|d| eff_child(d, "subList")) {
            b.flush_before_object(out);
            let mut blocks = self.blocks_of(sub, cx)?;
            finish_blocks(&mut blocks, false);
            out.append(&mut blocks);
        }
        Ok(())
    }

    /// 표·그림 캡션(`hp:caption > subList`) — (블록들, 표·그림 뒤에 놓는가). `side` 가 BOTTOM 이면 뒤.
    fn caption(&mut self, n: &Node, cx: Cx) -> AppResult<Option<(Vec<Block>, bool)>> {
        let Some(cap) = eff_child(n, "caption") else { return Ok(None) };
        let Some(sub) = eff_child(cap, "subList") else { return Ok(None) };
        let mut blocks = self.blocks_of(sub, cx)?;
        finish_blocks(&mut blocks, false);
        if blocks.is_empty() {
            return Ok(None);
        }
        let after = cap.attr("side").is_some_and(|s| s.eq_ignore_ascii_case("BOTTOM"));
        Ok(Some((blocks, after)))
    }

    // ── 표 ─────────────────────────────────────────────────────────────────

    fn table(&mut self, tbl: &Node, cx: Cx) -> AppResult<Option<Table>> {
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        for (tr, _) in effective(tbl) {
            if tr.name != "tr" {
                continue;
            }
            let mut cells = Vec::new();
            // 병합에 가려진 셀은 파일에 아예 없다 — 있는 셀을 문서 순서대로 읽는다.
            for (tc, _) in effective(tr) {
                if tc.name == "tc" {
                    cells.push(self.cell(tc, cx)?);
                }
            }
            // 셀이 하나도 없는 행(전부 병합에 가려진 행)도 **행 번호는 센다** — 건너뛰면 그 아래 행의 셀이 위 행의 병합 셀
            // 오른쪽 칸으로 밀려 들어간다. 빈 행은 점유 격자를 그린 뒤(`drop_empty_rows`) 걷는다.
            rows.push(cells);
        }
        build_table(rows)
    }

    fn cell(&mut self, tc: &Node, cx: Cx) -> AppResult<Cell> {
        // cellSpan/cellSz 는 subList 뒤에 올 수 있다 — 트리를 다 읽은 뒤라 순서에 안 기댄다.
        let span = eff_child(tc, "cellSpan");
        let colspan = num::<usize>(span.and_then(|s| s.attr("colSpan"))).unwrap_or(1).clamp(1, MAX_COLSPAN);
        let rowspan = num::<usize>(span.and_then(|s| s.attr("rowSpan"))).unwrap_or(1).clamp(1, MAX_ROWSPAN);
        let width = hwpunit(eff_child(tc, "cellSz").and_then(|s| s.attr("width"))).unwrap_or(0);
        let bg = tc.attr("borderFillIDRef").and_then(|id| self.styles.fills.get(id)).cloned().flatten();
        let inner = Cx { cw: if width > 0 { width } else { cx.cw } };
        let mut blocks = match eff_child(tc, "subList") {
            Some(sub) => self.blocks_of(sub, inner)?,
            None => Vec::new(),
        };
        finish_blocks(&mut blocks, true);
        Ok(Cell {
            header: tc.attr("header").is_some_and(|h| h == "1" || h.eq_ignore_ascii_case("true")),
            colspan,
            rowspan,
            // HWPUNIT 7200/인치 ÷ 96px/인치 = 75.
            width_px: (width > 0).then(|| ((width as f64) / 75.0).round() as u32).filter(|w| *w > 0),
            colwidth: None,
            bg,
            blocks,
        })
    }

    // ── 그림 ───────────────────────────────────────────────────────────────

    fn pic_block(&mut self, pic: &Node, cx: Cx) -> AppResult<Option<ImgBlock>> {
        let Some(id) = eff_child(pic, "img").and_then(|i| i.attr("binaryItemIDRef")).map(str::to_string) else {
            return Ok(None);
        };
        let Some(idx) = self.load_image(&id)? else { return Ok(None) };
        // 현재 크기(curSz) → 개체 크기(sz, 절대값일 때) → 원본 크기(orgSz). 기준 너비 대비 %(10~100).
        let width = |name: &str| hwpunit(eff_child(pic, name).and_then(|n| n.attr("width"))).filter(|w| *w > 0);
        let abs_sz = || {
            eff_child(pic, "sz")
                .filter(|n| n.attr("widthRelTo").is_none_or(|r| r.eq_ignore_ascii_case("ABSOLUTE")))
                .and_then(|n| hwpunit(n.attr("width")))
                .filter(|w| *w > 0)
        };
        let w = width("curSz").or_else(abs_sz).or_else(|| width("orgSz"));
        let width_pct = match (w, cx.cw) {
            (Some(w), cw) if cw > 0 => Some((((w * 100) + cw / 2) / cw).clamp(10, 100) as u32),
            _ => None,
        };
        Ok(Some(ImgBlock { idx, width_pct }))
    }

    fn find_bindata(&self, id: &str) -> Option<String> {
        if let Some(href) = self.manifest.get(id) {
            if let Some(real) = self.entries.get(&normalize_href(href).to_lowercase()) {
                return Some(real.clone());
            }
        }
        // manifest 에 없거나 href 가 어긋난 파일 — `BinData/{id}.*` 로 찾는다.
        let prefix = format!("bindata/{}.", id.to_lowercase());
        self.entries.iter().find(|(lower, _)| lower.starts_with(&prefix)).map(|(_, real)| real.clone())
    }

    fn load_image(&mut self, id: &str) -> AppResult<Option<usize>> {
        if let Some(r) = self.img_by_id.get(id) {
            return Ok(*r);
        }
        let r = self.load_image_uncached(id)?;
        self.img_by_id.insert(id.to_string(), r);
        Ok(r)
    }

    fn load_image_uncached(&mut self, id: &str) -> AppResult<Option<usize>> {
        if self.img_by_id.len() >= MAX_IMAGE_LOOKUPS {
            self.drop_kind("image_limit");
            return Ok(None);
        }
        let Some(entry) = self.find_bindata(id) else {
            self.drop_kind("image_missing");
            return Ok(None);
        };
        match self.pool.load(self.zip, &entry, "hwpx_import")? {
            Ok(idx) => Ok(Some(idx)),
            // emf·wmf·ole·tif … 웹뷰가 못 그리거나(image_format), 상한에 걸렸다(image_limit).
            Err(kind) => {
                self.drop_kind(kind);
                Ok(None)
            }
        }
    }
}

// ── 패키지 읽기 ───────────────────────────────────────────────────────────────

fn zip_err(e: zip::result::ZipError) -> AppError {
    AppError::Validation(format!("hwpx entry is unreadable: {e}"))
}

fn read_xml_entry(
    archive: &mut ZipArchive<File>,
    entries: &BTreeMap<String, String>,
    name: &str,
    budget: &mut u64,
) -> AppResult<Option<Node>> {
    let Some(real) = entries.get(&name.to_lowercase()) else { return Ok(None) };
    let mut f = archive.by_name(real).map_err(zip_err)?;
    let xml = read_entry_capped(&mut f, budget)?;
    drop(f);
    parse_xml(&xml).map(Some)
}

/// 본문 폭(HWPUNIT) = 용지 폭 − 좌우 여백. 못 찾으면 A4 기본(59528 − 2×8504 = 42520).
fn body_width(section: &Node) -> i64 {
    const DEFAULT: i64 = 42520;
    let Some(page) = find_first(section, "pagePr") else { return DEFAULT };
    let width = hwpunit(page.attr("width")).unwrap_or(0);
    let margin = eff_child(page, "margin");
    let side = |k: &str| hwpunit(margin.and_then(|m| m.attr(k))).unwrap_or(0);
    let w = width - side("left") - side("right");
    if w > 0 {
        w
    } else {
        DEFAULT
    }
}

/// hwpx 를 열어 중간 표현으로 만든다. DB 를 쓰지 않는다.
pub fn parse_file(path: &Path) -> AppResult<Parsed> {
    let meta = std::fs::metadata(path).map_err(io_err)?;
    if meta.len() > MAX_DOC_FILE_BYTES {
        return Err(AppError::Validation(format!("hwpx exceeds {}MB limit", MAX_DOC_FILE_BYTES / (1024 * 1024))));
    }
    let file = File::open(path).map_err(io_err)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::Validation(format!("not a valid hwpx (zip): {e}")))?;
    let entries: BTreeMap<String, String> = archive.file_names().map(|n| (n.to_lowercase(), n.to_string())).collect();
    // XML 은 한 문서가 예산을 공유한다(zip bomb). 그림은 각자 따로 잰다.
    let mut budget = MAX_DECOMPRESSED_BYTES;

    // 암호화(배포용 포함): META-INF/manifest.xml 의 encryption-data, 또는 content.hpf item 의 encryption 표시.
    if let Some(m) = read_xml_entry(&mut archive, &entries, "META-INF/manifest.xml", &mut budget)? {
        if find_first(&m, "encryption-data").is_some() {
            return Err(AppError::Validation("encrypted hwpx is not supported".to_string()));
        }
    }

    let section_names = numbered_zip_entries(&mut archive, "Contents/section", ".xml")?;
    if section_names.is_empty() {
        return Err(AppError::Validation("hwpx missing Contents/section*.xml".to_string()));
    }

    let styles = match read_xml_entry(&mut archive, &entries, "Contents/header.xml", &mut budget)? {
        Some(h) => read_styles(&h),
        None => Styles::default(),
    };

    let mut manifest: HashMap<String, String> = HashMap::new();
    if let Some(hpf) = read_xml_entry(&mut archive, &entries, "Contents/content.hpf", &mut budget)? {
        let mut items = Vec::new();
        find_all(&hpf, "item", &mut items);
        for it in items {
            if it.attr("encryption").is_some_and(|e| e == "1" || e.eq_ignore_ascii_case("true")) {
                return Err(AppError::Validation("encrypted hwpx is not supported".to_string()));
            }
            if let (Some(id), Some(href)) = (it.attr("id"), it.attr("href")) {
                manifest.insert(id.to_string(), href.to_string());
            }
        }
    }

    let mut p = Parser {
        styles: &styles,
        manifest,
        zip: &mut archive,
        entries: entries.clone(),
        pool: ImagePool::new(),
        img_by_id: HashMap::new(),
        dropped: BTreeMap::new(),
        footnotes: Vec::new(),
        body_w: 42520,
        height_chars: HashMap::new(),
    };

    let mut blocks: Vec<Block> = Vec::new();
    for (_, name) in section_names {
        // 구역(section) 파일은 하나씩 읽고 하나씩 버린다 — 트리를 전부 쥐고 있지 않는다.
        let xml = {
            let mut f = p.zip.by_name(&name).map_err(zip_err)?;
            read_entry_capped(&mut f, &mut budget)?
        };
        let root = parse_xml(&xml)?;
        drop(xml);
        p.body_w = body_width(&root);
        let cx = Cx { cw: p.body_w };
        let mut part = p.blocks_of(&root, cx)?;
        // 구역마다 첫 문단이 쪽 설정(secPr)만 든 빈 문단인 경우가 많다 — 이어 붙이기 전에 구역별로 앞뒤 빈 문단을 걷는다.
        finish_blocks(&mut part, false);
        blocks.append(&mut part);
    }
    finish_blocks(&mut blocks, false);

    // 본문 기준 글자 높이 = 글자 수가 가장 많은 높이(동률이면 작은 쪽).
    let base = p
        .height_chars
        .iter()
        .max_by_key(|(h, n)| (**n, std::cmp::Reverse(**h)))
        .map(|(h, _)| *h)
        .unwrap_or(0);
    infer_headings(&mut blocks, base);

    if blocks.is_empty() && p.footnotes.is_empty() {
        return Err(AppError::Validation("hwpx has no importable content".to_string()));
    }

    Ok(Parsed {
        blocks,
        footnotes: p.footnotes,
        images: p.pool.images,
        dropped: p
            .dropped
            .into_iter()
            .map(|(kind, count)| DocImportDropped { kind: kind.to_string(), count })
            .collect(),
    })
}


// ── 테스트 ────────────────────────────────────────────────────────────────────
//
// 픽스처는 한컴이 저장한 hwpx 의 모양을 흉내 낸다: 기본 글자 모양에 `underline type="NONE"`·`strikeout shape="NONE"`,
// 문단 모양의 여백은 `hp:switch`(case/default 두 벌), 본문 첫 문단에 secPr(쪽 설정)·빈 `hp:t`, 표 셀은 `hp:subList` 뒤에
// `cellSpan`·`cellSz`, 그림은 `hc:img binaryItemIDRef` → content.hpf 의 item. 요소·속성 이름의 근거는 모듈 머리 주석.
#[cfg(test)]
pub(crate) mod tests {
    use super::super::ir::{MAX_INFERRED_HEADING_CHARS, MAX_OUTLINE_HEADING_CHARS};
    use super::super::xml::MAX_XML_DEPTH;
    use super::super::{SavedImage, MAX_IMAGE_BYTES};
    use super::*;
    use crate::repo::extraction::test_support::build_zip;
    use std::io::Write;

    const HEAD_NS: &str = r##"xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph""##;
    const SEC_NS: &str = r##"xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core""##;

    #[allow(clippy::too_many_arguments)]
    fn char_pr(id: u32, height: u32, text_color: &str, shade: &str, bold: bool, italic: bool, underline: &str, strike: &str) -> String {
        format!(
            r##"<hh:charPr id="{id}" height="{height}" textColor="{text_color}" shadeColor="{shade}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>{}{}<hh:underline type="{underline}" shape="SOLID" color="#000000"/><hh:strikeout shape="{strike}" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>"##,
            if bold { "<hh:bold/>" } else { "" },
            if italic { "<hh:italic/>" } else { "" },
        )
    }

    fn margin_xml(left: i64) -> String {
        format!(
            r##"<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="{left}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>"##
        )
    }

    /// 한컴 2016+ 저장본처럼 여백을 switch(case/default 두 벌)로 둔다. `margin` = (case 값, default 값), None 이면 switch 없음.
    fn para_pr(id: u32, align: &str, head: (&str, u32), margin: Option<(i64, i64)>) -> String {
        let sw = match margin {
            Some((c, d)) => format!(
                r##"<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">{}<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hp:case><hp:default>{}<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/></hp:default></hp:switch>"##,
                margin_xml(c),
                margin_xml(d)
            ),
            None => String::new(),
        };
        format!(
            r##"<hh:paraPr id="{id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="{align}" vertical="BASELINE"/><hh:heading type="{}" idRef="0" level="{}"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>{sw}</hh:paraPr>"##,
            head.0, head.1
        )
    }

    fn border_fill(id: u32, fill: Option<&str>) -> String {
        let brush = match fill {
            Some(f) => format!(r##"<hc:fillBrush><hc:winBrush faceColor="{f}" hatchColor="#FF000000" alpha="0"/></hc:fillBrush>"##),
            None => String::new(),
        };
        format!(
            r##"<hh:borderFill id="{id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>{brush}</hh:borderFill>"##
        )
    }

    /// charPr: 0 기본 · 1 굵게 · 2 기울임 · 3 밑줄 · 4 취소선 · 5 빨강 · 6 형광(노랑) · 7 20pt · 8 15pt · 9 링크 모양(파랑+밑줄) ·
    /// 10 흰 글자 배경 · 11 나쁜 색 · 12 굵게+20pt.
    /// paraPr: 0 양쪽 · 1 가운데 · 2 오른쪽 · 3 왼쪽 · 4 배분 · 5 양쪽+들여쓰기(case 4000/default 8000) · 6~8 개요 0~2(왼쪽) ·
    /// 9 번호 0 · 10 글머리 0 · 11 번호 1 · 12 왼쪽+default 만 4000 · 13 글머리 1 · 14 왼쪽+case 100000.
    /// borderFill: 1 배경 없음 · 2 faceColor none · 3 #FFE699 · 4 흰색.
    pub(crate) fn header_xml() -> String {
        let chars = [
            char_pr(0, 1000, "#000000", "none", false, false, "NONE", "NONE"),
            char_pr(1, 1000, "#000000", "none", true, false, "NONE", "NONE"),
            char_pr(2, 1000, "#000000", "none", false, true, "NONE", "NONE"),
            char_pr(3, 1000, "#000000", "none", false, false, "BOTTOM", "NONE"),
            char_pr(4, 1000, "#000000", "none", false, false, "NONE", "SOLID"),
            char_pr(5, 1000, "#FF0000", "none", false, false, "NONE", "NONE"),
            char_pr(6, 1000, "#000000", "#FFFF00", false, false, "NONE", "NONE"),
            char_pr(7, 2000, "#000000", "none", false, false, "NONE", "NONE"),
            char_pr(8, 1500, "#000000", "none", false, false, "NONE", "NONE"),
            char_pr(9, 1000, "#0000FF", "none", false, false, "BOTTOM", "NONE"),
            char_pr(10, 1000, "#000000", "#FFFFFF", false, false, "NONE", "NONE"),
            char_pr(11, 1000, "#12345", "none", false, false, "NONE", "NONE"),
            char_pr(12, 2000, "#000000", "none", true, false, "NONE", "NONE"),
        ]
        .concat();
        let paras = [
            para_pr(0, "JUSTIFY", ("NONE", 0), Some((0, 0))),
            para_pr(1, "CENTER", ("NONE", 0), Some((0, 0))),
            para_pr(2, "RIGHT", ("NONE", 0), Some((0, 0))),
            para_pr(3, "LEFT", ("NONE", 0), Some((0, 0))),
            para_pr(4, "DISTRIBUTE", ("NONE", 0), Some((0, 0))),
            para_pr(5, "JUSTIFY", ("NONE", 0), Some((4000, 8000))),
            para_pr(6, "LEFT", ("OUTLINE", 0), None),
            para_pr(7, "LEFT", ("OUTLINE", 1), None),
            para_pr(8, "LEFT", ("OUTLINE", 2), None),
            para_pr(9, "JUSTIFY", ("NUMBER", 0), None),
            para_pr(10, "JUSTIFY", ("BULLET", 0), None),
            para_pr(11, "JUSTIFY", ("NUMBER", 1), None),
            // default 만 있는 switch — case 가 없으면 default/2.
            format!(
                r##"<hh:paraPr id="12"><hh:align horizontal="LEFT" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hp:switch><hp:default>{}</hp:default></hp:switch></hh:paraPr>"##,
                margin_xml(4000)
            ),
            para_pr(13, "JUSTIFY", ("BULLET", 1), None),
            para_pr(14, "LEFT", ("NONE", 0), Some((100000, 200000))),
        ]
        .concat();
        let fills = [border_fill(1, None), border_fill(2, Some("none")), border_fill(3, Some("#FFE699")), border_fill(4, Some("#FFFFFF"))].concat();
        format!(
            r##"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head {HEAD_NS} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:borderFills itemCnt="4">{fills}</hh:borderFills><hh:charProperties itemCnt="13">{chars}</hh:charProperties><hh:paraProperties itemCnt="15">{paras}</hh:paraProperties></hh:refList></hh:head>"##
        )
    }

    pub(crate) fn hpf(items: &[(&str, &str)]) -> String {
        let items: String = items
            .iter()
            .map(|(id, href)| format!(r##"<opf:item id="{id}" href="{href}" media-type="application/octet-stream" isEmbeded="1"/>"##))
            .collect();
        format!(
            r##"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version="" unique-identifier="" id=""><opf:metadata><opf:title>t</opf:title></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>{items}</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>"##
        )
    }

    const SECPR_P: &str = r##"<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>"##;

    fn sec(body: &str) -> String {
        format!(r##"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec {SEC_NS}>{SECPR_P}{body}</hs:sec>"##)
    }

    fn p(pr: u32, runs: &str) -> String {
        format!(
            r##"<hp:p id="1" paraPrIDRef="{pr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">{runs}<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray></hp:p>"##
        )
    }

    fn run(cp: u32, inner: &str) -> String {
        format!(r##"<hp:run charPrIDRef="{cp}">{inner}</hp:run>"##)
    }

    /// `text` 는 XML 로 이미 이스케이프된 글자.
    fn t(cp: u32, text: &str) -> String {
        run(cp, &format!("<hp:t>{text}</hp:t>"))
    }

    pub(crate) fn tp(pr: u32, cp: u32, text: &str) -> String {
        p(pr, &t(cp, text))
    }

    fn sublist(inner: &str) -> String {
        format!(
            r##"<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">{inner}</hp:subList>"##
        )
    }

    /// 셀: subList 뒤에 cellAddr·cellSpan·cellSz 가 온다(한컴 저장 순서). cellAddr 은 일부러 틀린 값 — 읽지 않는다.
    fn tc(header: bool, bf: u32, w: i64, cs: u32, rs: u32, inner: &str) -> String {
        format!(
            r##"<hp:tc name="" header="{}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="{bf}">{}<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="{cs}" rowSpan="{rs}"/><hp:cellSz width="{w}" height="1000"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>"##,
            u8::from(header),
            sublist(inner)
        )
    }

    fn tr(cells: &[String]) -> String {
        format!("<hp:tr>{}</hp:tr>", cells.concat())
    }

    fn tbl(rows: &[String]) -> String {
        format!(
            r##"<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="{}" colCnt="3" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:sz width="42520" widthRelTo="ABSOLUTE" height="3000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="141" bottom="141"/>{}</hp:tbl>"##,
            rows.len(),
            rows.concat()
        )
    }

    fn tbl_p(rows: &[String]) -> String {
        p(3, &run(0, &tbl(rows)))
    }

    fn pic(id: &str, cur_w: i64) -> String {
        format!(
            r##"<hp:pic id="1" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="1" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="43000" height="20000"/><hp:curSz width="{cur_w}" height="10000"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/><hp:imgClip left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="100" dimheight="50"/><hc:img binaryItemIDRef="{id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/><hp:sz width="{cur_w}" widthRelTo="ABSOLUTE" height="10000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>"##
        )
    }

    pub(crate) fn png_bytes() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(8, 6, image::Rgb([200, 30, 30]));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    /// 구역들 + 선택 엔트리로 .hwpx 를 만든다. `sections` = (번호, XML).
    pub(crate) fn hwpx_with(sections: &[(usize, String)], header: &str, hpf_xml: &str, extra: &[(&str, Vec<u8>)]) -> tempfile::NamedTempFile {
        let mut owned: Vec<(String, Vec<u8>)> = vec![
            ("mimetype".to_string(), b"application/hwp+zip".to_vec()),
            ("version.xml".to_string(), b"<hv:HCFVersion xmlns:hv=\"x\"/>".to_vec()),
            ("Contents/content.hpf".to_string(), hpf_xml.as_bytes().to_vec()),
            ("Contents/header.xml".to_string(), header.as_bytes().to_vec()),
        ];
        for (n, xml) in sections {
            owned.push((format!("Contents/section{n}.xml"), xml.as_bytes().to_vec()));
        }
        for (name, bytes) in extra {
            owned.push((name.to_string(), bytes.clone()));
        }
        let refs: Vec<(&str, &[u8])> = owned.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        build_zip(".hwpx", &refs)
    }

    pub(crate) fn hwpx(body: &str) -> tempfile::NamedTempFile {
        hwpx_with(&[(0, sec(body))], &header_xml(), &hpf(&[]), &[])
    }

    fn parse_render(f: &tempfile::NamedTempFile) -> AppResult<(String, Parsed)> {
        let parsed = parse_file(f.path())?;
        let atts: Vec<SavedImage> = parsed
            .images
            .iter()
            .enumerate()
            .map(|(i, im)| SavedImage { rel_path: format!("n/{i}-{}", im.name), name: im.name.clone() })
            .collect();
        Ok((parsed.render(&atts), parsed))
    }

    fn html_of(body: &str) -> String {
        parse_render(&hwpx(body)).unwrap().0
    }

    fn kinds(parsed: &Parsed) -> Vec<(String, u32)> {
        parsed.dropped.iter().map(|d| (d.kind.clone(), d.count)).collect()
    }

    // ── 인라인 서식 ───────────────────────────────────────────────────────────

    #[test]
    fn inline_marks_without_false_positives_from_none_defaults() {
        let body = format!(
            "{}{}",
            tp(3, 0, "plain"),
            p(
                3,
                &[t(1, "bold"), t(2, "ital"), t(3, "under"), t(4, "strike"), t(5, "red"), t(6, "hl"), t(10, "white")].concat()
            )
        );
        // 기본 글자 모양(`underline type="NONE"`·`strikeout shape="NONE"`·`shadeColor="none"`·`#000000`)은 아무 표시도 안 만든다.
        // 흰 글자 배경(#FFFFFF)도 형광펜이 아니다.
        assert_eq!(
            html_of(&body),
            "<p>plain</p>\n<p><strong>bold</strong><em>ital</em><u>under</u><s>strike</s>\
             <span style=\"color: #ff0000\">red</span><mark>hl</mark>white</p>"
        );
    }

    #[test]
    fn bad_colors_never_reach_the_html() {
        // "#12345" 는 6자리가 아니다 — style 주입 경로가 되면 안 된다.
        assert_eq!(html_of(&tp(3, 11, "x")), "<p>x</p>");
        assert_eq!(norm_color("#FFAA00").as_deref(), Some("#ffaa00"));
        for bad in ["red", "#12345", "#1234567", "#GGGGGG", "#ff0000\" onclick=\"x", "url(x)", "", "none"] {
            assert_eq!(norm_color(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn markpen_becomes_mark_inside_t_and_as_run_child() {
        let inside = run(0, "<hp:t>before <hp:markpenBegin color=\"#FFFF00\"/>hi<hp:markpenEnd/> after</hp:t>");
        let as_run_child = format!(
            r##"<hp:run charPrIDRef="0"><hp:markpenBegin color="#FFFF00"/><hp:t>run</hp:t><hp:markpenEnd/></hp:run>{}"##,
            t(0, "z")
        );
        let html = html_of(&format!("{}{}", p(3, &inside), p(3, &as_run_child)));
        assert_eq!(html, "<p>before <mark>hi</mark> after</p>\n<p><mark>run</mark>z</p>");
    }

    #[test]
    fn tab_linebreak_nbsp_and_own_char_pr() {
        let inner = run(
            0,
            "<hp:t>a<hp:tab width=\"4000\" leader=\"0\" type=\"1\"/>b<hp:lineBreak/>c<hp:nbSpace/>d</hp:t><hp:t charPrIDRef=\"1\">own</hp:t>",
        );
        assert_eq!(html_of(&p(3, &inner)), "<p>a b<br>c\u{a0}d<strong>own</strong></p>");
    }

    #[test]
    fn switch_picks_case_and_works_around_runs() {
        let body = p(
            3,
            r##"<hp:switch><hp:case hp:required-namespace="x"><hp:run charPrIDRef="1"><hp:t>case</hp:t></hp:run></hp:case><hp:default><hp:run charPrIDRef="0"><hp:t>default</hp:t></hp:run></hp:default></hp:switch>"##,
        );
        assert_eq!(html_of(&body), "<p><strong>case</strong></p>");
    }

    #[test]
    fn text_and_attributes_are_escaped_and_entities_resolved() {
        // quick-xml 0.41 은 `&amp;` 를 텍스트와 따로(GeneralRef) 준다 — 그걸 안 받으면 `AB` 가 된다.
        let body = tp(3, 0, "A&amp;B &lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &#xAC00;&#44032;");
        assert_eq!(html_of(&body), "<p>A&amp;B &lt;script&gt;alert(1)&lt;/script&gt; \"q\" 가가</p>");
    }

    // ── 문단 모양 ─────────────────────────────────────────────────────────────

    #[test]
    fn alignments_map_and_left_has_no_attributes() {
        let body = [tp(0, 0, "J"), tp(1, 0, "C"), tp(2, 0, "R"), tp(3, 0, "L"), tp(4, 0, "D")].concat();
        let j = r#"data-brise-align="justify" style="text-align: justify;""#;
        assert_eq!(
            html_of(&body),
            format!(
                "<p {j}>J</p>\n<p data-brise-align=\"center\" style=\"text-align: center;\">C</p>\n\
                 <p data-brise-align=\"right\" style=\"text-align: right;\">R</p>\n<p>L</p>\n<p {j}>D</p>"
            )
        );
    }

    #[test]
    fn indent_uses_case_value_and_halves_default() {
        // case 4000 → 2 단. default 만 있는 switch 의 4000 → /2 = 2000 → 1 단. 큰 값은 6 단으로 막힌다.
        // UNVERIFIED: /2 규칙은 조사 §6.2 의 서술이다 — 실제 저장본으로 확인되면 이 숫자를 같이 본다.
        let html = html_of(&[tp(5, 0, "a"), tp(12, 0, "b"), tp(14, 0, "c")].concat());
        assert_eq!(
            html,
            "<p data-brise-align=\"justify\" data-brise-indent=\"2\" style=\"text-align: justify; margin-left: 4em;\">a</p>\n\
             <p data-brise-indent=\"1\" style=\"margin-left: 2em;\">b</p>\n\
             <p data-brise-indent=\"6\" style=\"margin-left: 12em;\">c</p>"
        );
    }

    #[test]
    fn outline_levels_become_headings_and_bold_is_not_doubled() {
        let long = "가".repeat(MAX_OUTLINE_HEADING_CHARS + 1);
        let body = [tp(6, 1, "H1"), tp(7, 0, "H2"), tp(8, 0, "H3"), tp(6, 0, &long)].concat();
        assert_eq!(html_of(&body), format!("<h1>H1</h1>\n<h2>H2</h2>\n<h3>H3</h3>\n<p>{long}</p>"));
    }

    #[test]
    fn headings_are_inferred_from_size_only_when_conservative() {
        let cell = |inner: &str| tbl_p(&[tr(&[tc(false, 1, 7500, 1, 1, inner)])]);
        let sixty = "나".repeat(MAX_INFERRED_HEADING_CHARS);
        let sixty_one = "나".repeat(MAX_INFERRED_HEADING_CHARS + 1);
        let body = [
            tp(3, 0, &"본문 글자가 가장 많습니다. ".repeat(20)),
            tp(3, 7, "큰 제목"),
            tp(3, 8, "중간 제목"),
            tp(3, 7, &sixty),
            tp(3, 7, &sixty_one),
            // 한 문단 안에 본문 크기 글자가 섞이면 "문단 전체"가 크지 않다.
            p(3, &[t(7, "큰"), t(0, " 작은")].concat()),
            // 표 안은 추정하지 않는다.
            cell(&tp(3, 7, "셀 큰 글씨")),
            // 굵은 20pt 는 제목이 되며 굵게는 사라진다.
            tp(3, 12, "굵은 제목"),
        ]
        .concat();
        let html = html_of(&body);
        assert!(html.contains("<h1>큰 제목</h1>"), "{html}");
        assert!(html.contains("<h2>중간 제목</h2>"), "{html}");
        // 60자는 제목, 61자는 아니다 — 바이트가 아니라 chars().count() 로 센다(한글 60자 = 180바이트).
        assert!(html.contains(&format!("<h1>{sixty}</h1>")), "{html}");
        assert!(html.contains(&format!("<p>{sixty_one}</p>")), "{html}");
        assert!(html.contains("<p>큰 작은</p>"), "{html}");
        assert!(html.contains("<th colwidth=\"100\"><p>셀 큰 글씨</p></th>"), "{html}");
        assert!(html.contains("<h1>굵은 제목</h1>"), "{html}");
    }

    // ── 목록 ──────────────────────────────────────────────────────────────────

    #[test]
    fn consecutive_list_paragraphs_group_and_nest() {
        let body = [
            tp(9, 0, "a"),
            tp(9, 0, "b"),
            tp(3, 0, "mid"),
            tp(10, 0, "x"),
            tp(10, 0, "y"),
            tp(13, 0, "y1"),
            tp(10, 0, "z"),
            tp(9, 0, "n1"),
            tp(11, 0, "n1a"),
        ]
        .concat();
        assert_eq!(
            html_of(&body),
            "<ol><li><p>a</p></li><li><p>b</p></li></ol>\n<p>mid</p>\n\
             <ul><li><p>x</p></li><li><p>y</p><ul><li><p>y1</p></li></ul></li><li><p>z</p></li></ul>\
             <ol><li><p>n1</p><ol><li><p>n1a</p></li></ol></li></ol>"
        );
        // 목록 항목의 정렬(양쪽)은 속성으로 나오지 않는다.
        assert!(!html_of(&tp(9, 0, "a")).contains("data-brise-align"));
    }

    #[test]
    fn switching_list_kind_at_the_same_level_starts_a_new_list() {
        let html = html_of(&[tp(9, 0, "a"), tp(10, 0, "b")].concat());
        assert_eq!(html, "<ol><li><p>a</p></li></ol><ul><li><p>b</p></li></ul>");
    }

    // ── 표 ────────────────────────────────────────────────────────────────────

    fn merged_table() -> String {
        // AB(colspan 2, 머리글, 배경) | C  /  1(rowspan 2) | 2 | 3  /  (가려진 칸은 파일에 없다) 5 | 6
        tbl_p(&[
            tr(&[tc(true, 3, 15000, 2, 1, &tp(3, 0, "AB")), tc(true, 4, 7500, 1, 1, &tp(3, 0, "C"))]),
            tr(&[
                tc(false, 2, 7500, 1, 2, &tp(3, 0, "1")),
                tc(false, 1, 7500, 1, 1, &tp(3, 0, "2")),
                tc(false, 1, 7500, 1, 1, &tp(3, 0, "3")),
            ]),
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "5")), tc(false, 1, 7500, 1, 1, &tp(3, 0, "6"))]),
        ])
    }

    #[test]
    fn merged_table_with_background_and_colwidths() {
        // 문단에 표뿐이면 앞뒤로 빈 <p> 가 안 생긴다 — html 이 <table> 하나뿐이다. 7500 HWPUNIT ÷ 75 = 100px.
        assert_eq!(
            html_of(&merged_table()),
            "<table><tr><th colspan=\"2\" colwidth=\"100,100\" style=\"background-color: #ffe699\"><p>AB</p></th>\
             <th colwidth=\"100\"><p>C</p></th></tr>\
             <tr><td rowspan=\"2\" colwidth=\"100\"><p>1</p></td><td colwidth=\"100\"><p>2</p></td><td colwidth=\"100\"><p>3</p></td></tr>\
             <tr><td colwidth=\"100\"><p>5</p></td><td colwidth=\"100\"><p>6</p></td></tr></table>"
        );
    }

    #[test]
    fn first_row_becomes_the_header_only_for_plain_tables_without_header_flags() {
        // 머리글 표시가 없고 병합·배경도 없는 표 → GFM 로 갈 표라 첫 행을 머리글로 올린다(안 올리면 직렬화가 빈 머리글 행을 끼운다).
        let plain = tbl_p(&[
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "a")), tc(false, 1, 7500, 1, 1, &tp(3, 0, "b"))]),
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "c")), tc(false, 1, 7500, 1, 1, &tp(3, 0, "d"))]),
        ]);
        assert_eq!(
            html_of(&plain),
            "<table><tr><th colwidth=\"100\"><p>a</p></th><th colwidth=\"100\"><p>b</p></th></tr>\
             <tr><td colwidth=\"100\"><p>c</p></td><td colwidth=\"100\"><p>d</p></td></tr></table>"
        );
        // 병합이 있으면(조각 표) td/th 구분이 그대로 저장되므로 건드리지 않는다. 배경이 있어도 마찬가지.
        let merged = tbl_p(&[
            tr(&[tc(false, 1, 15000, 2, 1, &tp(3, 0, "ab"))]),
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "c")), tc(false, 1, 7500, 1, 1, &tp(3, 0, "d"))]),
        ]);
        assert!(!html_of(&merged).contains("<th"), "{}", html_of(&merged));
        let shaded = tbl_p(&[tr(&[tc(false, 3, 7500, 1, 1, &tp(3, 0, "a"))]), tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "b"))])]);
        assert!(!html_of(&shaded).contains("<th"), "{}", html_of(&shaded));
        // 머리글 표시가 하나라도 있으면 그 표시를 존중한다(두 번째 행이 머리글이어도 첫 행을 올리지 않는다).
        let flagged = tbl_p(&[
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "a"))]),
            tr(&[tc(true, 1, 7500, 1, 1, &tp(3, 0, "h"))]),
        ]);
        assert_eq!(
            html_of(&flagged),
            "<table><tr><td colwidth=\"100\"><p>a</p></td></tr><tr><th colwidth=\"100\"><p>h</p></th></tr></table>"
        );
    }

    #[test]
    fn table_inside_a_paragraph_splits_it_without_empty_neighbours() {
        let inner = format!(
            "{}{}{}",
            t(0, "before"),
            run(0, &tbl(&[tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "c"))])])),
            t(0, "after")
        );
        assert_eq!(
            html_of(&p(3, &inner)),
            "<p>before</p>\n<table><tr><th colwidth=\"100\"><p>c</p></th></tr></table>\n<p>after</p>"
        );
    }

    #[test]
    fn empty_cells_keep_one_paragraph_and_nested_tables_recurse() {
        let nested = tbl_p(&[tr(&[tc(false, 1, 3750, 1, 1, &tp(3, 0, "in"))])]);
        let outer = tbl_p(&[tr(&[
            tc(false, 1, 7500, 1, 1, &p(3, "")),
            tc(false, 1, 7500, 1, 1, &format!("{}{}{}", p(3, ""), p(3, ""), nested)),
        ])]);
        assert_eq!(
            html_of(&outer),
            "<table><tr><th colwidth=\"100\"><p></p></th><th colwidth=\"100\">\
             <table><tr><th colwidth=\"50\"><p>in</p></th></tr></table></th></tr></table>"
        );
        // subList 자체가 없는 셀도 문단 하나.
        let bare = r##"<hp:tc header="0" borderFillIDRef="1"><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>"##;
        assert_eq!(html_of(&tbl_p(&[format!("<hp:tr>{bare}</hp:tr>")])), "<table><tr><th><p></p></th></tr></table>");
    }

    #[test]
    fn spanning_cell_alone_distributes_its_width_over_unknown_columns() {
        assert_eq!(
            html_of(&tbl_p(&[tr(&[tc(false, 1, 15000, 2, 1, &tp(3, 0, "x"))])])),
            "<table><tr><td colspan=\"2\" colwidth=\"100,100\"><p>x</p></td></tr></table>"
        );
    }

    #[test]
    fn captions_go_before_or_after_by_side() {
        let caption = |side: &str, text: &str| {
            format!(r##"<hp:caption side="{side}" fullSz="0" width="8504" gap="850" lastWidth="42520">{}</hp:caption>"##, sublist(&tp(3, 0, text)))
        };
        let cell_table = |cap: &str| tbl(&[tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "c"))])]).replacen("<hp:tr>", &format!("{cap}<hp:tr>"), 1);
        assert_eq!(
            html_of(&p(3, &run(0, &cell_table(&caption("TOP", "위"))))),
            "<p>위</p>\n<table><tr><th colwidth=\"100\"><p>c</p></th></tr></table>"
        );
        assert_eq!(
            html_of(&p(3, &run(0, &cell_table(&caption("BOTTOM", "아래"))))),
            "<table><tr><th colwidth=\"100\"><p>c</p></th></tr></table>\n<p>아래</p>"
        );
    }

    // ── 하이퍼링크 ────────────────────────────────────────────────────────────

    fn link_open(id: &str, params: &str) -> String {
        run(
            0,
            &format!(
                r##"<hp:ctrl><hp:fieldBegin id="{id}" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="627600491"><hp:parameters cnt="3" name="">{params}</hp:parameters></hp:fieldBegin></hp:ctrl>"##
            ),
        )
    }

    fn link_close(id: &str) -> String {
        run(0, &format!(r##"<hp:ctrl><hp:fieldEnd beginIDRef="{id}" fieldid="627600491"/></hp:ctrl>"##))
    }

    fn cmd(s: &str) -> String {
        format!(r##"<hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">{s}</hp:stringParam>"##)
    }

    fn linked(params: &str, text_runs: &str) -> String {
        p(3, &format!("{}{}{}{}", link_open("7", params), text_runs, link_close("7"), t(0, "after")))
    }

    #[test]
    fn hyperlink_targets_follow_hancom_storage() {
        // Path 우선(`&amp;` 도 풀려서 속성에서 다시 이스케이프된다).
        let both = format!(
            "{}{}",
            cmd(r"https\://example.com/a\?b=1;1;0;0;"),
            r##"<hp:stringParam name="Path">https://example.com/a?b=1&amp;c=2</hp:stringParam>"##
        );
        assert_eq!(
            html_of(&linked(&both, &t(0, "L"))),
            "<p><a href=\"https://example.com/a?b=1&amp;c=2\">L</a>after</p>"
        );
        // Command 만: 꼬리 `;1;0;0;` 와 툴팁(`|`)을 떼고 역슬래시를 푼다.
        assert_eq!(
            html_of(&linked(&cmd(r"https\://ex.com/p\?q=1\#frag|tip text;1;0;0;"), &t(0, "L"))),
            "<p><a href=\"https://ex.com/p?q=1#frag\">L</a>after</p>"
        );
        // mailto 의 꼬리는 `;2;0;0`(끝 세미콜론 없음).
        assert_eq!(
            html_of(&linked(&cmd(r"mailto\:a@b.com;2;0;0"), &t(0, "M"))),
            "<p><a href=\"mailto:a@b.com\">M</a>after</p>"
        );
    }

    #[test]
    fn unsafe_and_bookmark_links_keep_the_text_without_a_link() {
        for command in [r"javascript\:alert(1);1;0;0;", r"file\:///C\:/x;1;0;0;", r"?mark;0;0;0;", "", r"data\:text/html,x;1;0;0;"] {
            let html = html_of(&linked(&cmd(command), &t(0, "T")));
            assert_eq!(html, "<p>Tafter</p>", "{command:?}");
        }
    }

    #[test]
    fn link_spans_runs_drops_hancom_link_look_and_ends_at_field_end() {
        let params = cmd(r"https\://example.com;1;0;0;");
        let html = html_of(&linked(&params, &format!("{}{}", t(9, "blue"), t(1, "bold"))));
        // 파랑+밑줄(링크 모양)은 벗기고, 굵게는 남는다. 링크 밖 글자는 링크가 아니다.
        assert_eq!(
            html,
            "<p><a href=\"https://example.com\">blue</a><a href=\"https://example.com\"><strong>bold</strong></a>after</p>"
        );
        // fieldEnd 의 beginIDRef 가 다른 필드면 링크가 안 끝난다.
        let open_only = p(3, &format!("{}{}{}", link_open("7", &params), t(0, "x"), link_close("99")));
        assert_eq!(html_of(&open_only), "<p><a href=\"https://example.com\">x</a></p>");
    }

    // ── 그림 ──────────────────────────────────────────────────────────────────

    pub(crate) fn picture_doc() -> tempfile::NamedTempFile {
        let cell = tc(false, 1, 15000, 1, 1, &p(3, &run(0, &pic("image1", 7500))));
        let body = [
            p(3, &run(0, &pic("image1", 21260))), // 본문 폭 42520 의 절반
            p(3, &format!("{}{}{}", t(0, "앞"), run(0, &pic("image1", 100)), t(0, "뒤"))),
            p(3, &run(0, &pic("vec1", 21260))),
            p(3, &run(0, &pic("nope", 21260))),
            tbl_p(&[tr(&[cell])]),
        ]
        .concat();
        hwpx_with(
            &[(0, sec(&body))],
            &header_xml(),
            &hpf(&[("image1", "BinData/image1.png"), ("vec1", "BinData/vec1.emf")]),
            &[("BinData/image1.png", png_bytes()), ("BinData/vec1.emf", vec![1, 2, 3])],
        )
    }

    #[test]
    fn pictures_become_blocks_with_width_percent_and_are_deduplicated() {
        let (html, parsed) = parse_render(&picture_doc()).unwrap();
        assert_eq!(parsed.images.len(), 1, "같은 그림을 세 번 써도 한 번만 꺼낸다");
        assert_eq!(parsed.images[0].name, "image1.png");
        let img = |w: u32| {
            format!("<img src=\"n/0-image1.png\" data-rel-path=\"n/0-image1.png\" alt=\"image1.png\" style=\"width: {w}%\">")
        };
        assert_eq!(
            html,
            format!(
                "{}\n<p>앞</p>\n{}\n<p>뒤</p>\n<table><tr><th colwidth=\"200\">{}</th></tr></table>",
                img(50),
                img(10), // 100/42520 → 하한 10%
                img(50), // 셀 너비 15000 기준 7500 → 50%
            )
        );
        // emf 는 형식 때문에, 없는 id 는 따로 센다.
        assert_eq!(kinds(&parsed), vec![("image_format".to_string(), 1), ("image_missing".to_string(), 1)]);
    }

    #[test]
    fn bindata_is_found_without_a_manifest_entry() {
        let body = p(3, &run(0, &pic("image7", 21260)));
        let f = hwpx_with(&[(0, sec(&body))], &header_xml(), &hpf(&[]), &[("BinData/image7.PNG", png_bytes())]);
        let (html, parsed) = parse_render(&f).unwrap();
        assert_eq!(parsed.images.len(), 1);
        assert!(html.contains("<img src=\"n/0-image7.PNG\""), "{html}");
    }

    // ── 도형 · 수식 · 머리말 · 각주 ───────────────────────────────────────────

    fn header_footer(kind: &str, text: &str) -> String {
        run(
            0,
            &format!(
                r##"<hp:ctrl><hp:{kind} id="0" applyPageType="BOTH">{}</hp:{kind}></hp:ctrl>"##,
                sublist(&tp(3, 0, text))
            ),
        )
    }

    /// run 으로 감싸지 않은 도형 요소(컨테이너 안에 놓을 때).
    fn textbox_el(tag: &str, text: &str) -> String {
        format!(
            r##"<hp:{tag} id="1" zOrder="0" numberingType="NONE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None"><hp:sz width="9000" widthRelTo="ABSOLUTE" height="3000" heightRelTo="ABSOLUTE" protect="0"/><hp:drawText lastWidth="9000" name="" editable="0">{}<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText></hp:{tag}>"##,
            sublist(&tp(3, 0, text))
        )
    }

    fn textbox(tag: &str, text: &str) -> String {
        run(0, &textbox_el(tag, text))
    }

    /// 각주 안 첫 문단은 자기 번호(autoNum FOOTNOTE)로 시작한다 — 가져오기가 그 번호를 또 넣으면 안 된다.
    fn footnote(tag: &str, text: &str) -> String {
        let para = p(
            3,
            &run(0, &format!(r##"<hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE"/></hp:ctrl><hp:t>{text}</hp:t>"##)),
        );
        run(0, &format!(r##"<hp:ctrl><hp:{tag} number="1" suffixChar=")" instId="1">{}</hp:{tag}></hp:ctrl>"##, sublist(&para)))
    }

    #[test]
    fn unsupported_objects_are_counted_not_silently_lost() {
        let eq = run(
            0,
            "<hp:equation id=\"1\" version=\"Equation Version 60\" baseLine=\"85\" textColor=\"#000000\" baseUnit=\"1000\" lineMode=\"CHAR\" font=\"HYhwpEQ\">\
             <hp:sz width=\"2000\" height=\"1000\"/><hp:script>x^2 + y &lt; z\n over 2</hp:script></hp:equation>",
        );
        let body = [
            p(3, &format!("{}{}", header_footer("header", "HEAD"), header_footer("footer", "FOOT"))),
            p(3, &format!("{}{}", t(0, "수식 "), eq)),
            p(3, &format!("{}{}", t(0, "앞"), textbox("rect", "BOXED"))),
            p(3, &run(0, r##"<hp:ole id="1"/>"##)),
            p(3, &run(0, r##"<hp:ole id="2"/><hp:chart id="3" chartIDRef="Chart/chart1.xml"/>"##)),
            p(3, &run(0, r##"<hp:btn id="4" caption="b"/><hp:line id="5"/>"##)),
            // 컨테이너는 세지 않고 안의 글상자·도형만 센다.
            p(3, &run(0, &format!(r##"<hp:container id="6"><hp:sz width="1" height="1"/>{}</hp:container>"##, textbox_el("ellipse", "IN GROUP")))),
        ]
        .concat();
        let (html, parsed) = parse_render(&hwpx(&body)).unwrap();
        assert!(!html.contains("HEAD") && !html.contains("FOOT"), "{html}");
        assert_eq!(
            html,
            "<p>수식 <code>x^2 + y &lt; z over 2</code></p>\n<p>앞</p>\n<p>BOXED</p>\n<p>IN GROUP</p>"
        );
        // 결정적 순서(종류 이름순) — 화면 문구·테스트가 흔들리지 않는다.
        assert_eq!(
            kinds(&parsed),
            vec![
                ("chart".to_string(), 1),
                ("equation".to_string(), 1),
                ("header_footer".to_string(), 2),
                ("ole".to_string(), 2),
                ("shape".to_string(), 4), // rect · btn · line · ellipse
            ]
        );
    }

    #[test]
    fn footnotes_and_endnotes_are_collected_at_the_end() {
        let body = [
            p(3, &format!("{}{}", t(0, "본문"), footnote("footNote", "각주 내용"))),
            p(3, &format!("{}{}", t(0, "둘째"), footnote("endNote", "미주 내용"))),
        ]
        .concat();
        assert_eq!(
            html_of(&body),
            "<p>본문[1]</p>\n<p>둘째[2]</p>\n<h3>각주</h3>\n<p>[1] 각주 내용</p>\n<p>[2] 미주 내용</p>"
        );
    }

    #[test]
    fn auto_numbers_for_pictures_and_tables_keep_their_value_but_page_and_footnote_do_not() {
        let num = |ty: &str| run(0, &format!(r##"<hp:ctrl><hp:autoNum num="3" numType="{ty}"/></hp:ctrl>"##));
        let body = p(3, &format!("{}{}{}{}{}", t(0, "표 "), num("TABLE"), t(0, " / 쪽 "), num("PAGE"), num("FOOTNOTE")));
        assert_eq!(html_of(&body), "<p>표 3 / 쪽 </p>");
    }

    #[test]
    fn non_hyperlink_fields_are_counted() {
        let field = run(
            0,
            r##"<hp:ctrl><hp:fieldBegin id="9" type="CLICK_HERE" name="이름"><hp:parameters cnt="0" name=""/></hp:fieldBegin></hp:ctrl>"##,
        );
        let end = run(0, r##"<hp:ctrl><hp:fieldEnd beginIDRef="9" fieldid="1"/></hp:ctrl>"##);
        let (html, parsed) = parse_render(&hwpx(&p(3, &format!("{field}{}{end}", t(0, "홍길동"))))).unwrap();
        assert_eq!(html, "<p>홍길동</p>");
        assert_eq!(kinds(&parsed), vec![("field".to_string(), 1)]);
    }

    // ── 구조 · 접두사 · 순서 ──────────────────────────────────────────────────

    #[test]
    fn blank_paragraphs_collapse_to_one_and_edges_are_trimmed() {
        let body = [p(3, ""), tp(3, 0, "a"), p(3, ""), p(3, ""), p(3, &t(0, "  ")), tp(3, 0, "b"), p(3, "")].concat();
        assert_eq!(html_of(&body), "<p>a</p>\n<p></p>\n<p>b</p>");
    }

    #[test]
    fn sections_are_joined_in_numeric_order_not_zip_order() {
        // zip 에는 section10 · section2 · section0 순으로 들어 있다.
        let f = hwpx_with(
            &[(10, sec(&tp(3, 0, "S10"))), (2, sec(&tp(3, 0, "S2"))), (0, sec(&tp(3, 0, "S0")))],
            &header_xml(),
            &hpf(&[]),
            &[],
        );
        assert_eq!(parse_render(&f).unwrap().0, "<p>S0</p>\n<p>S2</p>\n<p>S10</p>");
    }

    /// 접두사(hp/hh/hc/hs)와 네임스페이스(2011 → 2024)가 달라도 같은 결과여야 한다.
    fn reprefix(xml: &str) -> String {
        xml.replace("hp:", "pa:")
            .replace("hh:", "he:")
            .replace("hc:", "co:")
            .replace("hs:", "se:")
            .replace("xmlns:hp=", "xmlns:pa=")
            .replace("xmlns:hh=", "xmlns:he=")
            .replace("xmlns:hc=", "xmlns:co=")
            .replace("xmlns:hs=", "xmlns:se=")
            .replace("http://www.hancom.co.kr/hwpml/2011/", "http://www.owpml.org/owpml/2024/")
    }

    #[test]
    fn local_names_make_prefix_and_namespace_irrelevant() {
        let body = [
            p(5, &format!("{}{}", t(1, "bold"), t(5, "red"))),
            tp(9, 0, "n"),
            tp(7, 0, "H2"),
            merged_table(),
            p(3, &run(0, &pic("image1", 21260))),
        ]
        .concat();
        let items = hpf(&[("image1", "BinData/image1.png")]);
        let original = hwpx_with(&[(0, sec(&body))], &header_xml(), &items, &[("BinData/image1.png", png_bytes())]);
        let other = hwpx_with(
            &[(0, reprefix(&sec(&body)))],
            &reprefix(&header_xml()),
            &items,
            &[("BinData/image1.png", png_bytes())],
        );
        let (a, _) = parse_render(&original).unwrap();
        let (b, _) = parse_render(&other).unwrap();
        assert!(a.contains("<strong>bold</strong>") && a.contains("colspan=\"2\"") && a.contains("<img "), "{a}");
        assert_eq!(a, b);
    }

    // ── 거절 ──────────────────────────────────────────────────────────────────

    fn validation_message(f: &tempfile::NamedTempFile) -> String {
        match parse_file(f.path()) {
            Err(AppError::Validation(m)) => m,
            Err(e) => panic!("VALIDATION 이어야 한다: {e:?}"),
            Ok(_) => panic!("거절돼야 한다"),
        }
    }

    #[test]
    fn encrypted_packages_are_rejected() {
        let manifest = br##"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="Contents/section0.xml" manifest:media-type="application/xml"><manifest:encryption-data manifest:checksum-type="SHA1"/></manifest:file-entry></manifest:manifest>"##.to_vec();
        let f = hwpx_with(&[(0, sec(&tp(3, 0, "x")))], &header_xml(), &hpf(&[]), &[("META-INF/manifest.xml", manifest)]);
        assert!(validation_message(&f).contains("encrypted"));
        // 평문 manifest 는 통과한다.
        let plain = br##"<manifest:manifest xmlns:manifest="urn:x"><manifest:file-entry manifest:full-path="/"/></manifest:manifest>"##.to_vec();
        let ok = hwpx_with(&[(0, sec(&tp(3, 0, "x")))], &header_xml(), &hpf(&[]), &[("META-INF/manifest.xml", plain)]);
        assert!(parse_file(ok.path()).is_ok());
        // content.hpf item 의 encryption 표시도 본다.
        let enc_hpf = hpf(&[]).replace(r#"id="section0""#, r#"id="section0" encryption="1""#);
        let g = hwpx_with(&[(0, sec(&tp(3, 0, "x")))], &header_xml(), &enc_hpf, &[]);
        assert!(validation_message(&g).contains("encrypted"));
    }

    #[test]
    fn missing_sections_and_non_zip_are_validation() {
        let no_sections = build_zip(".hwpx", &[("Contents/header.xml", header_xml().as_bytes())]);
        assert!(validation_message(&no_sections).contains("section"));
        let mut junk = tempfile::NamedTempFile::with_suffix(".hwpx").unwrap();
        junk.write_all(b"this is not a zip archive at all").unwrap();
        assert!(validation_message(&junk).contains("zip"));
    }

    #[test]
    fn broken_xml_is_validation_not_a_panic() {
        for bad in [
            r##"<hs:sec xmlns:hs="x"><hp:p></hs:sec>"##.to_string(), // 닫는 태그 불일치
            r##"<hs:sec xmlns:hs="x"><hp:p>"##.to_string(),           // 닫히지 않음
            "not xml at all <<<".to_string(),
            String::new(),
            r##"<hs:sec xmlns:hs="x"><hp:t a="1" a="2"/></hs:sec>"##.to_string(), // 중복 속성
        ] {
            let f = hwpx_with(&[(0, bad.clone())], &header_xml(), &hpf(&[]), &[]);
            assert!(matches!(parse_file(f.path()), Err(AppError::Validation(_))), "{bad:?}");
        }
        // header.xml 이 깨진 것도 마찬가지.
        let f = hwpx_with(&[(0, sec(&tp(3, 0, "x")))], "<hh:head><oops", &hpf(&[]), &[]);
        assert!(matches!(parse_file(f.path()), Err(AppError::Validation(_))));
    }

    #[test]
    fn empty_documents_and_dropped_only_documents_are_validation() {
        assert!(validation_message(&hwpx(&[p(3, ""), p(3, "")].concat())).contains("no importable content"));
        assert!(validation_message(&hwpx(&p(3, &run(0, r##"<hp:ole id="1"/>"##)))).contains("no importable content"));
    }

    #[test]
    fn nesting_beyond_the_depth_cap_is_validation() {
        let deep = format!(
            r##"<hs:sec xmlns:hs="x">{}{}</hs:sec>"##,
            "<hp:x>".repeat(MAX_XML_DEPTH + 10),
            "</hp:x>".repeat(MAX_XML_DEPTH + 10)
        );
        let f = hwpx_with(&[(0, deep)], &header_xml(), &hpf(&[]), &[]);
        assert!(validation_message(&f).contains("too deep"));
    }

    #[test]
    fn decompression_budget_is_enforced() {
        // 압축이 잘 되는 반복 바이트라 아카이브는 작지만 풀면 예산을 넘는다(zip bomb).
        let mut huge = Vec::with_capacity(MAX_DECOMPRESSED_BYTES as usize + 1024);
        huge.extend_from_slice(br#"<hs:sec xmlns:hs="x"><hp:t>"#);
        huge.resize(MAX_DECOMPRESSED_BYTES as usize + 512, b'A');
        huge.extend_from_slice(br#"</hp:t></hs:sec>"#);
        let f = build_zip(".hwpx", &[("Contents/section0.xml", &huge)]);
        assert!(validation_message(&f).contains("exceeds"));
    }

    #[test]
    fn oversized_pictures_are_dropped_alone_not_the_document() {
        let mut big = png_bytes();
        big.resize(MAX_IMAGE_BYTES as usize + 16, 0);
        let body = [tp(3, 0, "본문"), p(3, &run(0, &pic("big", 21260)))].concat();
        let f = hwpx_with(&[(0, sec(&body))], &header_xml(), &hpf(&[("big", "BinData/big.png")]), &[("BinData/big.png", big)]);
        let (html, parsed) = parse_render(&f).unwrap();
        assert_eq!(html, "<p>본문</p>");
        assert_eq!(kinds(&parsed), vec![("image_limit".to_string(), 1)]);
    }

    // ── 검증에서 나온 결함의 회귀 ──────────────────────────────────────────────

    fn xml_attr(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }

    /// 그림 하나(`img1`)가 `entry` 라는 이름의 BinData 를 가리키는 문서. href 는 XML 로 이스케이프한다(안 하면 content.hpf 가 깨져
    /// 엉뚱한 이유로 VALIDATION 이 난다).
    pub(crate) fn picture_doc_named(entry: &str) -> tempfile::NamedTempFile {
        let body = p(3, &run(0, &pic("img1", 21260)));
        let href = xml_attr(entry);
        hwpx_with(&[(0, sec(&body))], &header_xml(), &hpf(&[("img1", href.as_str())]), &[(entry, png_bytes())])
    }

    #[test]
    fn link_addresses_never_carry_markdown_delimiters() {
        // 프런트 직렬화기는 링크 주소의 괄호를 이스케이프하지 않는다 — 주소의 `)` 가 링크를 닫고 `[x](javascript:…)` 나
        // `![i](http://evil/…)` 가 **파일 안의 글자만으로** 새 링크·이미지가 된다. 같은 주소를 퍼센트 인코딩으로 낸다.
        let html = |command: &str| html_of(&linked(&cmd(command), &t(0, "L")));
        assert_eq!(
            html(r"http\://x.com/)[x](javascript\:alert(1);1;0;0;"),
            "<p><a href=\"http://x.com/%29%5Bx%5D%28javascript:alert%281%29\">L</a>after</p>"
        );
        assert_eq!(
            html(r"http\://a.com/)![i](http\://evil.example/p.png)"),
            "<p><a href=\"http://a.com/%29!%5Bi%5D%28http://evil.example/p.png%29\">L</a>after</p>"
        );
        // 평범한 주소의 괄호도 같은 주소로 인코딩된다(서버는 %28 을 (로 읽는다).
        assert_eq!(
            html(r"https\://en.wikipedia.org/wiki/Foo_(bar);1;0;0;"),
            "<p><a href=\"https://en.wikipedia.org/wiki/Foo_%28bar%29\">L</a>after</p>"
        );
        assert_eq!(safe_href("https://x.com/a`b\\c").as_deref(), Some("https://x.com/a%60b%5Cc"));
        // 막는 규칙은 그대로: 스킴과 공백·꺾쇠·따옴표.
        assert_eq!(safe_href("javascript:alert(1)"), None);
        assert_eq!(safe_href("https://x.com/a b"), None);
    }

    fn header_with_char_height(height: &str) -> String {
        header_xml().replacen(r##"<hh:charPr id="0" height="1000""##, &format!(r##"<hh:charPr id="0" height="{height}""##), 1)
    }

    fn sec_with_page(width: &str, left: &str, right: &str, body: &str) -> String {
        let secpr = SECPR_P
            .replace(r##"width="59528""##, &format!(r##"width="{width}""##))
            .replace(r##"left="8504" right="8504""##, &format!(r##"left="{left}" right="{right}""##));
        assert_ne!(secpr, SECPR_P);
        format!(r##"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec {SEC_NS}>{secpr}{body}</hs:sec>"##)
    }

    #[test]
    fn absurd_numbers_never_overflow() {
        // debug(`cargo test`·`tauri dev`) 에서는 정수 오버플로가 panic 이라 spawn_blocking 의 JoinError → IO 로 샜다.
        // 1) 글자 높이 u32::MAX — `height * 10`.
        let f = hwpx_with(&[(0, sec(&tp(3, 0, "본문 본문")))], &header_with_char_height("4294967295"), &hpf(&[]), &[]);
        assert_eq!(parse_render(&f).unwrap().0, "<p>본문 본문</p>");

        // 2) 그림 크기 i64::MAX — `width * 100`. 본문에서도 폭이 i64::MAX 인 셀 안에서도.
        let huge = i64::MAX;
        let cell = tc(false, 1, huge, 1, 1, &p(3, &run(0, &pic("image1", huge))));
        let body = [p(3, &run(0, &pic("image1", huge))), tbl_p(&[tr(&[cell])])].concat();
        let f = hwpx_with(
            &[(0, sec(&body))],
            &header_xml(),
            &hpf(&[("image1", "BinData/image1.png")]),
            &[("BinData/image1.png", png_bytes())],
        );
        let (html, _) = parse_render(&f).unwrap();
        assert!(html.contains("width: 100%"), "{html}");

        // 3) 용지 폭·여백 — `width - left - right`.
        let min = "-9223372036854775808";
        let max = "9223372036854775807";
        for (w, l, r) in [(max, min, "0"), ("0", min, min), (min, "0", "0"), (max, max, max)] {
            let body = tp(3, 0, "본문");
            let f = hwpx_with(&[(0, sec_with_page(w, l, r, &body))], &header_xml(), &hpf(&[]), &[]);
            assert_eq!(parse_render(&f).unwrap().0, "<p>본문</p>", "{w} {l} {r}");
        }

        // 4) 셀 너비가 상한에 붙은 홑 셀 둘 위를 colSpan=2 셀이 덮는다 — 열 너비 합이 u32 를 넘던 자리.
        let w = 400_000_000_000;
        let body = tbl_p(&[
            tr(&[tc(false, 1, w, 1, 1, &tp(3, 0, "a")), tc(false, 1, w, 1, 1, &tp(3, 0, "b"))]),
            tr(&[tc(false, 1, w, 2, 1, &tp(3, 0, "c"))]),
        ]);
        let html = html_of(&body);
        assert!(html.contains("colspan=\"2\""), "{html}");
    }

    #[test]
    fn rows_fully_covered_by_merges_do_not_shift_the_rows_below() {
        // 행 구성 R0=[A rowSpan=2, B rowSpan=2], R1=<hp:tr/>(셀 없음), R2=[C, D]. 빈 행을 건너뛰면 C, D 가 A, B 오른쪽 칸으로 밀렸다
        // (2열×3행 표가 4열×2행으로). 빈 행은 점유 격자에서는 한 행으로 세고, 걷은 뒤 그 행을 가로지르던 rowspan 을 줄인다.
        let a_b = |bf: u32| [tc(false, bf, 7500, 1, 2, &tp(3, 0, "A")), tc(false, bf, 7500, 1, 2, &tp(3, 0, "B"))];
        let empty_tr = "<hp:tr></hp:tr>".to_string();
        let middle = tbl_p(&[
            tr(&a_b(1)),
            empty_tr.clone(),
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "C")), tc(false, 1, 7500, 1, 1, &tp(3, 0, "D"))]),
        ]);
        assert_eq!(
            html_of(&middle),
            "<table><tr><th colwidth=\"100\"><p>A</p></th><th colwidth=\"100\"><p>B</p></th></tr>\
             <tr><td colwidth=\"100\"><p>C</p></td><td colwidth=\"100\"><p>D</p></td></tr></table>"
        );
        // 마지막 행이 전부 가려진 경우: rowspan 이 표 끝을 넘으면 안 된다.
        let last = tbl_p(&[tr(&a_b(1)), empty_tr.clone()]);
        assert_eq!(
            html_of(&last),
            "<table><tr><th colwidth=\"100\"><p>A</p></th><th colwidth=\"100\"><p>B</p></th></tr></table>"
        );
        // 배경이 있으면(조각 표) 머리글 승격 없이 그대로, rowspan 만 줄어 있다.
        let shaded = tbl_p(&[tr(&a_b(3)), empty_tr, tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "C"))])]);
        let html = html_of(&shaded);
        assert!(!html.contains("rowspan"), "{html}");
        assert!(html.contains("<td colwidth=\"100\" style=\"background-color: #ffe699\"><p>A</p></td>"), "{html}");
        // 행이 전부 비면 표가 없다.
        assert_eq!(html_of(&format!("{}{}", tp(3, 0, "앞"), tbl_p(&["<hp:tr></hp:tr>".to_string()]))), "<p>앞</p>");
    }

    #[test]
    fn spans_are_clamped_to_the_table_so_a_tiny_file_cannot_buy_a_huge_grid() {
        // rowSpan 이 표의 남은 행 수를 넘으면 남은 행 수로 — 2행 표의 rowspan=5 는 2.
        let two_rows = tbl_p(&[
            tr(&[tc(false, 1, 7500, 1, 5, &tp(3, 0, "A"))]),
            tr(&[tc(false, 1, 7500, 1, 1, &tp(3, 0, "B"))]),
        ]);
        assert_eq!(
            html_of(&two_rows),
            "<table><tr><td rowspan=\"2\" colwidth=\"100\"><p>A</p></td></tr><tr><td colwidth=\"100\"><p>B</p></td></tr></table>"
        );
        // colSpan=200 rowSpan=1000 셀 하나짜리 표는 한 행뿐이니 면적이 200 이다(예전엔 200,000 을 칸마다 집합에 넣었다).
        let one = tbl_p(&[tr(&[tc(false, 1, 15000, 200, 1000, &tp(3, 0, "x"))])]);
        let html = html_of(&one);
        assert!(html.contains("colspan=\"200\"") && !html.contains("rowspan"), "{}", &html[..120.min(html.len())]);
        // 그런 표 수백 개를 이어도 표마다 비용이 셀 폭에 비례할 뿐이다 — 끝나고 어떤 표도 rowspan 을 안 얻는다.
        let many: String = (0..300).map(|_| one.clone()).collect();
        let started = std::time::Instant::now();
        let html = html_of(&many);
        assert!(!html.contains("rowspan"));
        assert_eq!(html.matches("<table>").count(), 300);
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "{:?}", started.elapsed());
    }

    #[test]
    fn a_paragraph_of_thousands_of_leading_line_breaks_is_linear() {
        // 앞쪽 `<br>` 를 `remove(0)` 으로 하나씩 지우면 O(n²) — 6만 개에서 십수 초(debug).
        let inner = run(0, &format!("<hp:t>{}x</hp:t>", "<hp:lineBreak/>".repeat(60_000)));
        let started = std::time::Instant::now();
        assert_eq!(html_of(&p(3, &inner)), "<p>x</p>");
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    }

    #[test]
    fn several_ids_for_one_file_read_it_once() {
        // 캐시 키가 id 뿐이면 같은 BinData 를 id 수만큼 풀었다(큰 파일이면 풀고 버리기를 반복).
        let body = ["a", "b", "c"].iter().map(|id| p(3, &run(0, &pic(id, 21260)))).collect::<String>();
        let f = hwpx_with(
            &[(0, sec(&body))],
            &header_xml(),
            &hpf(&[("a", "BinData/image1.png"), ("b", "BinData/image1.png"), ("c", "bindata/IMAGE1.png")]),
            &[("BinData/image1.png", png_bytes())],
        );
        let (html, parsed) = parse_render(&f).unwrap();
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(html.matches("<img src=\"n/0-image1.png\"").count(), 3, "{html}");
        assert!(parsed.dropped.is_empty());
    }

    #[test]
    fn an_oversized_file_shared_by_ids_is_dropped_alone_and_counted_per_id() {
        // 결과(그림 없음·id 마다 image_limit)만 지킨다 — 풀기 전에 선언 크기로 거른다는 사실 자체(디코딩을 안 한다)는 관찰할 수 없어서
        // 이 테스트가 그 사전 검사의 회귀를 잡아 주지는 않는다.
        let mut big = png_bytes();
        big.resize(MAX_IMAGE_BYTES as usize + 16, 0);
        let body = ["a", "b", "c"].iter().map(|id| p(3, &run(0, &pic(id, 21260)))).collect::<String>();
        let f = hwpx_with(
            &[(0, sec(&format!("{}{body}", tp(3, 0, "본문"))))],
            &header_xml(),
            &hpf(&[("a", "BinData/big.png"), ("b", "BinData/big.png"), ("c", "BinData/big.png")]),
            &[("BinData/big.png", big)],
        );
        let (html, parsed) = parse_render(&f).unwrap();
        assert_eq!(html, "<p>본문</p>");
        assert_eq!(kinds(&parsed), vec![("image_limit".to_string(), 3)]);
    }

    #[test]
    fn whitespace_only_styled_pieces_lose_their_marks() {
        // 마크다운은 공백만 감싼 `**`·`++` 를 표지로 읽지 않아 기호가 글자로 남았다(`앞**** 뒤`).
        assert_eq!(html_of(&p(3, &[t(0, "앞"), t(1, " "), t(0, "뒤")].concat())), "<p>앞 뒤</p>");
        // 밑줄 친 빈칸 — 글자 모양이 다른 공백뿐인 조각.
        let blank = html_of(&p(3, &[t(0, "이름 : "), t(3, "      ")].concat()));
        assert_eq!(blank, format!("<p>이름 :{}</p>", " ".repeat(7)));
        // nbSpace·전각 공백도 공백이다.
        assert_eq!(html_of(&p(3, &[t(0, "앞"), run(2, "<hp:t><hp:nbSpace/><hp:fwSpace/></hp:t>"), t(0, "뒤")].concat())), "<p>앞\u{a0}\u{3000}뒤</p>");
        // 같은 서식끼리면 공백이 끼어도 한 조각으로 남고, 글자 곁의 공백은 건드리지 않는다(직렬화기가 마크 밖으로 뺀다).
        assert_eq!(html_of(&p(3, &[t(1, "A"), t(1, " "), t(1, "B")].concat())), "<p><strong>A B</strong></p>");
        assert_eq!(html_of(&p(3, &[t(1, "굵게 "), t(0, "뒤")].concat())), "<p><strong>굵게 </strong>뒤</p>");
        // 링크 안의 공백뿐인 조각도 링크를 달지 않는다.
        let linked_blank = p(
            3,
            &format!("{}{}{}{}", link_open("7", &cmd(r"https\://example.com;1;0;0;")), t(0, "a"), t(1, " "), link_close("7")),
        );
        assert_eq!(html_of(&linked_blank), "<p><a href=\"https://example.com\">a</a> </p>");
    }
}
