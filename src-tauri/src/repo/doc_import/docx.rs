// repo: doc_import::docx — DOCX(WordprocessingML) → 서식 있는 HTML (PLAN-2026-10-07-doc-import-export W4-RI)
//
// 형식 무관 부분(ir · html · images · xml · mod)은 HWPX 와 같이 쓰고, 이 파일은 DOCX 만의 것을 가진다: 패키지(OPC) ·
// 관계(rels) · 스타일 상속 · 번호 매기기 · 필드 · 본문 파서. 파서는 `ir::Parsed` 를 만든다(DB 없음) — HTML 은 `html.rs` 가 쓴다.
//
// 태그·속성은 전부 **로컬 이름**으로 맞춘다(w/a/wp/r/mc 접두사 변종 · transitional/strict 네임스페이스 모두). 관계의 종류(Type)는
// 마지막 마디(`/styles` · `/hyperlink` …)로 맞춘다 — strict 는 `purl.oclc.org` 주소를 쓴다. 길이는 정수 twips 이거나
// strict 의 단위 붙은 값(`595.30pt`)이라 `measure` 가 둘 다 읽는다.
// 요소·속성 이름의 근거는 ECMA-376 Part 1(§17 WordprocessingML · §20 DrawingML)과 실제 워드 저장본 16개(mammoth.js · python-docx
// 테스트 파일)다 — 추측한 이름은 없다.
//
// 변경 추적은 **수락한 모양**으로 읽는다: `w:ins` 는 포함, `w:del`·`w:moveFrom`·삭제된 표 행은 제외.
//
// 못 옮기는 것(조용히 버리는 것 말고 `dropped` 로 세는 것): 머리말·꼬리말(header_footer, 본문에 없다 — sectPr 의 참조 개수) ·
// 수식(equation, 글자만 남김) · 도형(shape, 글상자 안 글은 문단으로 꺼낸다) · OLE(ole) · 차트(chart) · 지원 안 하는 그림 형식
// (image_format) · 없거나 외부에 있는 그림(image_missing — **외부 그림은 절대 가져오지 않는다**) · 상한을 넘는 그림(image_limit) ·
// 하이퍼링크 아닌 필드(field) · 메모(comment).
//
// ponytail: 번호 목록의 시작 번호·번호 서식, 글머리표 모양, 제목에 붙은 번호("1.", "제1장"), 글꼴·글자 크기·줄간격·자간, 첨자,
// 쪽·단 나누기, 표 스타일이 주는 서식(첫 행 굵게 …), 그림 자르기·회전·배치는 버린다(내용은 남김). 천장 = "원본과 비슷하게"
// (계획 §0-2). 번호 서식은 `<ol>` 이 알아서 다시 매긴다. 숨김 글자(`w:vanish`)는 보이지 않는 글이라 가져오지 않는다.
// 표 머리글(th)은 `w:tblHeader` 로 표시된 행만 — `tblLook firstRow` 는 워드가 새 표마다 켜 두는 기본값이라 신호가 못 된다. 병합·배경이
// 없는 표는 공용 규칙(`ir::build_table`)이 첫 행을 머리글로 올린다. 표 스타일 조건부 서식을 읽으면 첫 행·첫 열 굵게를 살릴 수 있다.
use super::html::{norm_color, safe_href};
use super::images::ImagePool;
use super::ir::{
    build_table, clean_text, empty_para, finish_blocks, infer_headings, Align, Block, Cell, ImgBlock, Inline, Kind, Para, ParaAcc,
    Parsed, Piece, Style, Table, MAX_COLSPAN, MAX_ROWSPAN,
};
use super::xml::{find_all, find_first, num, parse_xml_with, Node, XmlOpts};
use super::{DocImportDropped, MAX_DOC_FILE_BYTES};
use crate::error::{io as io_err, AppError, AppResult};
use crate::repo::extraction::{read_entry_capped, MAX_DECOMPRESSED_BYTES};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use zip::ZipArchive;

/// 워드 XML 의 파싱 옵션: 필드 명령(`w:instrText`)의 글자를 남기고, DOCTYPE 은 거절한다.
const DOCX_XML: XmlOpts = XmlOpts { extra_text: &["instrText"], reject_doctype: true };
/// OLE 복합 문서 머리 8바이트 — 암호화된 docx 는 zip 이 아니라 이 컨테이너다(옛 `.doc` 도 같다).
const OLE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
/// 쪽 폭을 못 읽을 때의 본문 폭(twips) — A4 11906 − 좌우 여백 1440 × 2.
const DEFAULT_BODY_TWIPS: i64 = 9026;
const EMU_PER_TWIP: i64 = 635;
/// 파일이 마음대로 줄 수 있는 길이의 상한(twips) — 읽는 자리에서 한 번 막아 두면 뒤의 곱셈·뺄셈이 넘칠 길이 없다.
const MAX_TWIPS: i64 = 1_000_000_000;
/// 그림 크기(EMU)의 상한 — 폭 % 계산의 `× 100` 이 넘치지 않게.
const MAX_EMU: i64 = 1_000_000_000_000;
/// 글자 크기(반 포인트) 기본값 10pt 와 상한(= 1000pt, `Style.height` = 반 포인트 × 50 → 1/100 pt).
const DEFAULT_SZ: u32 = 20;
const MAX_SZ: u32 = 2000;
/// 스타일 `basedOn` 사슬 깊이 · 필드 중첩 깊이 상한 — 순환·병적 입력에서 멈춘다.
const MAX_STYLE_CHAIN: usize = 32;
const MAX_FIELD_DEPTH: usize = 64;
/// 필드 명령 글자 수 상한.
const MAX_INSTR_CHARS: usize = 4000;
/// 번호 목록의 시작 번호 상한 — 악의적인 `w:start` 가 `<ol start>` 에 천문학적 숫자를 싣지 못하게.
const MAX_LIST_START: u32 = 1_000_000;

// ── 단위 · 작은 도우미 ────────────────────────────────────────────────────────

/// 길이를 twips 로. 정수 twips(`720`) 와 strict 의 단위 붙은 값(`36pt` · `2.5cm` · `1in`)을 읽고 `MAX_TWIPS` 로 막는다.
fn measure(s: Option<&str>) -> Option<i64> {
    let s = s?.trim();
    let (digits, mul) = if let Some(n) = s.strip_suffix("pt") {
        (n, 20.0)
    } else if let Some(n) = s.strip_suffix("mm") {
        (n, 1440.0 / 25.4)
    } else if let Some(n) = s.strip_suffix("cm") {
        (n, 1440.0 / 2.54)
    } else if let Some(n) = s.strip_suffix("in") {
        (n, 1440.0)
    } else if let Some(n) = s.strip_suffix("pc").or_else(|| s.strip_suffix("pi")) {
        (n, 240.0)
    } else {
        (s, 1.0)
    };
    let v: f64 = digits.trim().parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(((v * mul).round() as i64).clamp(-MAX_TWIPS, MAX_TWIPS))
}

/// on/off 속성(`w:b` · `w:i` …) — 값이 없으면 켜짐, `0`·`false`·`off` 면 꺼짐.
fn on_off(n: &Node) -> bool {
    !matches!(n.attr("val").map(str::to_ascii_lowercase).as_deref(), Some("0" | "false" | "off"))
}

/// 자식 요소의 `val` 속성.
fn child_val<'n>(n: &'n Node, child: &str) -> Option<&'n str> {
    n.elements().find(|c| c.name == child).and_then(|c| c.attr("val"))
}

fn child<'n>(n: &'n Node, name: &str) -> Option<&'n Node> {
    n.elements().find(|c| c.name == name)
}

fn align_of(v: &str) -> Align {
    match v.to_ascii_lowercase().as_str() {
        "center" => Align::Center,
        "right" | "end" => Align::Right,
        "both" | "distribute" | "justify" | "thaidistribute" | "highkashida" | "lowkashida" | "mediumkashida" => {
            Align::Justify
        }
        _ => Align::Left,
    }
}

/// `%XX` 퍼센트 인코딩을 푼다(OPC 파트 이름은 URI 라서 공백이 `%20` 으로 온다). 깨진 인코딩은 그대로 둔다.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── 관계(rels) ────────────────────────────────────────────────────────────────

struct Rel {
    /// 관계 종류의 URL(끝 마디로 맞춘다: `/hyperlink` · `/image` …).
    ty: String,
    /// 원본 Target.
    target: String,
    external: bool,
    /// 패키지 안 경로(내부 관계만): 부분 디렉터리 기준으로 풀고 `..` 를 접은 것. 샌드박스(`word/`) 밖이면 `None`.
    path: Option<String>,
}

#[derive(Default)]
struct Rels {
    items: Vec<(String, Rel)>,
    index: HashMap<String, usize>,
}

impl Rels {
    fn get(&self, id: &str) -> Option<&Rel> {
        self.index.get(id).map(|i| &self.items[*i].1)
    }

    /// 종류가 `suffix` 로 끝나는 첫 관계(파일 안 순서) — `/styles` 가 `stylesWithEffects` 와 헷갈리지 않게 `/` 를 포함한다.
    fn first_of(&self, suffix: &str) -> Option<&Rel> {
        self.items.iter().map(|(_, r)| r).find(|r| r.ty.ends_with(suffix))
    }
}

/// 관계 Target 을 패키지 경로로. 절대 경로(`/word/…`)는 패키지 뿌리에서, 상대 경로는 `base_dir` 에서 풀고 `.`·`..` 를 접는다.
/// 뿌리를 넘는 `..` 나 `sandbox`(소문자, 끝 `/`) 밖의 결과는 버린다 — 파일이 `../../x` 로 엉뚱한 엔트리를 가리키게 두지 않는다.
fn resolve_target(base_dir: &str, target: &str, sandbox: &str) -> Option<String> {
    // 쪽지(`#`)·질의(`?`)는 퍼센트 풀기 **전에** 자른다 — 파일 이름 안의 `?` 는 `%3F` 로 오기 때문이다.
    let raw = target.trim().replace('\\', "/");
    let t = percent_decode(raw.split(['#', '?']).next().unwrap_or(""));
    if t.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> =
        if t.starts_with('/') { Vec::new() } else { base_dir.split('/').filter(|s| !s.is_empty()).collect() };
    for seg in t.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    let path = parts.join("/");
    if path.is_empty() || (!sandbox.is_empty() && !path.to_lowercase().starts_with(sandbox)) {
        return None;
    }
    Some(path)
}

// ── 스타일(styles.xml) ────────────────────────────────────────────────────────

/// 글자 속성 — 상속하며 합치므로 값이 없는 칸은 `None`(덮지 않음).
#[derive(Clone, Default)]
struct RPr {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strike: Option<bool>,
    /// `Some(None)` = 색 없음을 **명시**(auto · 검정 — 상속한 색을 지운다).
    color: Option<Option<String>>,
    mark: Option<bool>,
    /// 반 포인트.
    size: Option<u32>,
    vanish: Option<bool>,
    /// 글자 스타일 id — 런에서만 뜻이 있다.
    rstyle: Option<String>,
}

impl RPr {
    fn over(&mut self, top: &RPr) {
        macro_rules! take {
            ($($f:ident),*) => {$(
                if top.$f.is_some() {
                    self.$f = top.$f.clone();
                }
            )*};
        }
        take!(bold, italic, underline, strike, color, mark, size, vanish);
    }
}

/// 문단 속성(같은 이유로 부분).
#[derive(Clone, Default)]
struct PPr {
    align: Option<Align>,
    ind_left: Option<i64>,
    num_id: Option<String>,
    ilvl: Option<u8>,
    /// 개요 수준(0 = 제목 1 …, 9 = 본문).
    outline: Option<u8>,
}

impl PPr {
    fn over(&mut self, top: &PPr) {
        macro_rules! take {
            ($($f:ident),*) => {$(
                if top.$f.is_some() {
                    self.$f = top.$f.clone();
                }
            )*};
        }
        take!(align, ind_left, num_id, ilvl, outline);
    }
}

fn read_rpr(n: &Node) -> RPr {
    let mut r = RPr::default();
    for k in n.elements() {
        match k.name.as_str() {
            "b" => r.bold = Some(on_off(k)),
            "i" => r.italic = Some(on_off(k)),
            "strike" => r.strike = Some(on_off(k)),
            // 이중 취소선도 취소선이다. 꺼진 dstrike 가 켜진 strike 를 끄지 않게 켜졌을 때만 쓴다.
            "dstrike" if on_off(k) => r.strike = Some(true),
            "u" => r.underline = Some(!k.attr("val").is_some_and(|v| v.eq_ignore_ascii_case("none"))),
            "color" => {
                // auto · 검정은 글자 기본색이라 색을 따로 박지 않는다 — 상속한 색을 지우는 "색 없음"을 명시한다.
                // 테마 색만 있고 val 이 없으면(= 모양을 알 수 없다) 건드리지 않는다.
                let val = k.attr("val");
                match val.and_then(|v| norm_color(&format!("#{v}"))) {
                    Some(c) => r.color = Some(Some(c).filter(|c| c != "#000000")),
                    None if val.is_some_and(|v| v.eq_ignore_ascii_case("auto")) => r.color = Some(None),
                    None => {}
                }
            }
            "highlight" => r.mark = Some(!k.attr("val").is_some_and(|v| v.eq_ignore_ascii_case("none"))),
            "shd" => {
                // 글자 배경 — 흰색·auto 는 배경이 아니다.
                if k.attr("fill").and_then(|f| norm_color(&format!("#{f}"))).is_some_and(|c| c != "#ffffff") {
                    r.mark = Some(true);
                }
            }
            "sz" => r.size = num::<u32>(k.attr("val")).filter(|v| *v > 0).map(|v| v.min(MAX_SZ)),
            "vanish" => r.vanish = Some(on_off(k)),
            "rStyle" => r.rstyle = k.attr("val").map(str::to_string),
            _ => {}
        }
    }
    r
}

fn read_ppr(n: &Node) -> PPr {
    let mut p = PPr::default();
    for k in n.elements() {
        match k.name.as_str() {
            "jc" => p.align = k.attr("val").map(align_of),
            "ind" => p.ind_left = measure(k.attr("left").or_else(|| k.attr("start"))),
            "numPr" => {
                p.num_id = child_val(k, "numId").map(str::to_string);
                p.ilvl = num::<u8>(child_val(k, "ilvl"));
            }
            "outlineLvl" => p.outline = num::<u8>(k.attr("val")),
            _ => {}
        }
    }
    p
}

/// 스타일 이름이 "heading N" / "제목 N" 이면 개요 수준(N − 1). 한글 워드의 이름 변종도 받는다.
fn heading_level_of_name(name: &str) -> Option<u8> {
    let lower = name.trim().to_lowercase();
    let rest = lower.strip_prefix("heading").or_else(|| lower.strip_prefix("제목"))?.trim();
    let n: u8 = rest.parse().ok().filter(|n| (1..=9).contains(n))?;
    Some(n - 1)
}

struct StyleDef {
    based_on: Option<String>,
    ppr: PPr,
    rpr: RPr,
}

#[derive(Default)]
struct Styles {
    defaults_rpr: RPr,
    defaults_ppr: PPr,
    by_id: HashMap<String, StyleDef>,
    /// `w:default="1"` 인 문단 스타일(보통 Normal).
    default_para: Option<String>,
}

impl Styles {
    /// `basedOn` 사슬(기본 쪽이 앞) — 순환·`MAX_STYLE_CHAIN` 초과에서 멈춘다.
    fn chain(&self, id: &str) -> Vec<&StyleDef> {
        let mut out: Vec<&StyleDef> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut cur = Some(id);
        while let Some(c) = cur {
            if out.len() >= MAX_STYLE_CHAIN || !seen.insert(c) {
                break;
            }
            let Some(def) = self.by_id.get(c) else { break };
            out.push(def);
            cur = def.based_on.as_deref();
        }
        out.reverse();
        out
    }
}

fn read_styles(root: &Node) -> Styles {
    let mut s = Styles::default();
    for k in root.elements() {
        match k.name.as_str() {
            "docDefaults" => {
                if let Some(r) = child(k, "rPrDefault").and_then(|d| child(d, "rPr")) {
                    s.defaults_rpr = read_rpr(r);
                }
                if let Some(p) = child(k, "pPrDefault").and_then(|d| child(d, "pPr")) {
                    s.defaults_ppr = read_ppr(p);
                }
            }
            "style" => {
                let Some(id) = k.attr("styleId") else { continue };
                let mut ppr = child(k, "pPr").map(read_ppr).unwrap_or_default();
                // 개요 수준이 직접 없으면 이름("heading 1")·id("Heading1")이 알려 준다.
                if ppr.outline.is_none() {
                    ppr.outline = child_val(k, "name")
                        .and_then(heading_level_of_name)
                        .or_else(|| heading_level_of_name(id).filter(|_| k.attr("type") == Some("paragraph")));
                }
                let def = StyleDef {
                    based_on: child_val(k, "basedOn").map(str::to_string),
                    ppr,
                    rpr: child(k, "rPr").map(read_rpr).unwrap_or_default(),
                };
                if k.attr("type") == Some("paragraph")
                    && k.attr("default").is_some_and(|d| d == "1" || d.eq_ignore_ascii_case("true"))
                    && s.default_para.is_none()
                {
                    s.default_para = Some(id.to_string());
                }
                s.by_id.entry(id.to_string()).or_insert(def);
            }
            _ => {}
        }
    }
    s
}

// ── 번호 매기기(numbering.xml) ────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ListFmt {
    Bullet,
    Number,
    None,
}

#[derive(Default)]
struct Abstract {
    levels: HashMap<u8, ListFmt>,
    /// 단별 `w:start`(없으면 1).
    starts: HashMap<u8, u32>,
    /// `w:numStyleLink` — 이 목록 정의는 그 번호 스타일의 정의를 쓴다.
    style_link: Option<String>,
}

struct NumDef {
    abstract_id: String,
    overrides: HashMap<u8, ListFmt>,
    /// `lvlOverride/lvl/start` — 이 인스턴스에서 그 단의 정의가 가진 시작 번호.
    starts: HashMap<u8, u32>,
    /// `lvlOverride/startOverride` — 이 인스턴스를 **처음 쓰는 순간** 그 단의 번호를 이 값에서 다시 시작한다(워드의 "다시 시작").
    restarts: HashMap<u8, u32>,
}

#[derive(Default)]
struct Numbering {
    abstracts: HashMap<String, Abstract>,
    nums: HashMap<String, NumDef>,
}

fn list_fmt(lvl: &Node) -> ListFmt {
    match child_val(lvl, "numFmt").map(str::to_ascii_lowercase).as_deref() {
        Some("bullet") => ListFmt::Bullet,
        Some("none") => ListFmt::None,
        // numFmt 가 없으면 규격 기본값은 decimal 이다.
        _ => ListFmt::Number,
    }
}

/// `w:start`/`w:startOverride` 의 값 — 0 부터 `MAX_LIST_START` 로 막는다.
fn list_start(v: Option<&str>) -> Option<u32> {
    num::<i64>(v).map(|n| n.clamp(0, i64::from(MAX_LIST_START)) as u32)
}

fn read_numbering(root: &Node) -> Numbering {
    let mut n = Numbering::default();
    for k in root.elements() {
        match k.name.as_str() {
            "abstractNum" => {
                let Some(id) = k.attr("abstractNumId") else { continue };
                let mut a = Abstract { style_link: child_val(k, "numStyleLink").map(str::to_string), ..Default::default() };
                for lvl in k.elements().filter(|c| c.name == "lvl") {
                    if let Some(i) = num::<u8>(lvl.attr("ilvl")) {
                        a.levels.insert(i, list_fmt(lvl));
                        if let Some(s) = list_start(child_val(lvl, "start")) {
                            a.starts.insert(i, s);
                        }
                    }
                }
                n.abstracts.entry(id.to_string()).or_insert(a);
            }
            "num" => {
                let (Some(id), Some(abs)) = (k.attr("numId"), child_val(k, "abstractNumId")) else { continue };
                let (mut overrides, mut starts, mut restarts) = (HashMap::new(), HashMap::new(), HashMap::new());
                for o in k.elements().filter(|c| c.name == "lvlOverride") {
                    let Some(i) = num::<u8>(o.attr("ilvl")) else { continue };
                    if let Some(lvl) = child(o, "lvl") {
                        overrides.insert(i, list_fmt(lvl));
                        if let Some(s) = list_start(child_val(lvl, "start")) {
                            starts.insert(i, s);
                        }
                    }
                    if let Some(s) = list_start(child_val(o, "startOverride")) {
                        restarts.insert(i, s);
                    }
                }
                n.nums
                    .entry(id.to_string())
                    .or_insert(NumDef { abstract_id: abs.to_string(), overrides, starts, restarts });
            }
            _ => {}
        }
    }
    n
}

impl Numbering {
    /// 목록 `num_id` 의 `ilvl` 단 서식. 정의가 없으면 `None`(= 번호 없는 문단으로 둔다).
    fn fmt(&self, styles: &Styles, num_id: &str, ilvl: u8, depth: u8) -> Option<ListFmt> {
        let n = self.nums.get(num_id)?;
        if let Some(f) = n.overrides.get(&ilvl) {
            return Some(*f);
        }
        let a = self.abstracts.get(&n.abstract_id)?;
        if let Some(f) = a.levels.get(&ilvl) {
            return Some(*f);
        }
        if depth < 4 {
            if let Some(link) = &a.style_link {
                let target = styles.by_id.get(link)?.ppr.num_id.as_deref()?;
                return self.fmt(styles, target, ilvl, depth + 1);
            }
        }
        None
    }

    /// 목록 `num_id` 의 `ilvl` 단이 새로 시작할 때의 번호: 덮어쓴 시작 → 인스턴스의 단 정의 → 추상 정의 → 1.
    fn start_of(&self, num_id: &str, ilvl: u8) -> u32 {
        let Some(n) = self.nums.get(num_id) else { return 1 };
        n.restarts
            .get(&ilvl)
            .or_else(|| n.starts.get(&ilvl))
            .or_else(|| self.abstracts.get(&n.abstract_id).and_then(|a| a.starts.get(&ilvl)))
            .copied()
            .unwrap_or(1)
    }
}

// ── 패키지 읽기 ───────────────────────────────────────────────────────────────

fn zip_err(e: zip::result::ZipError) -> AppError {
    AppError::Validation(format!("docx entry is unreadable: {e}"))
}

struct Package {
    archive: ZipArchive<File>,
    /// 소문자 엔트리 이름 → 실제 이름(`\` 는 `/` 로 맞춘다).
    entries: BTreeMap<String, String>,
    /// XML 은 한 문서가 예산을 공유한다(zip bomb). 그림은 각자 따로 잰다.
    budget: u64,
}

impl Package {
    fn xml(&mut self, path: &str) -> AppResult<Option<Node>> {
        let Some(real) = self.entries.get(&path.to_lowercase()) else { return Ok(None) };
        let mut f = self.archive.by_name(real).map_err(zip_err)?;
        let xml = read_entry_capped(&mut f, &mut self.budget)?;
        drop(f);
        parse_xml_with(&xml, &DOCX_XML).map(Some)
    }

    /// 파트(`None` = 패키지 뿌리)의 관계. 없으면 빈 관계.
    fn rels(&mut self, part: Option<&str>, sandbox: &str) -> AppResult<Rels> {
        let (rels_path, base_dir) = match part {
            None => ("_rels/.rels".to_string(), String::new()),
            Some(p) => {
                let (dir, file) = p.rsplit_once('/').unwrap_or(("", p));
                let rp = if dir.is_empty() { format!("_rels/{file}.rels") } else { format!("{dir}/_rels/{file}.rels") };
                (rp, dir.to_string())
            }
        };
        let Some(root) = self.xml(&rels_path)? else { return Ok(Rels::default()) };
        let mut rels = Rels::default();
        for k in root.elements().filter(|k| k.name == "Relationship") {
            let (Some(id), Some(target)) = (k.attr("Id"), k.attr("Target")) else { continue };
            let external = k.attr("TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("External"));
            let path = if external { None } else { resolve_target(&base_dir, target, sandbox) };
            if rels.index.contains_key(id) {
                continue; // 같은 id 가 둘이면 앞의 것이 이긴다
            }
            rels.index.insert(id.to_string(), rels.items.len());
            rels.items.push((
                id.to_string(),
                Rel { ty: k.attr("Type").unwrap_or("").to_string(), target: target.to_string(), external, path },
            ));
        }
        Ok(rels)
    }
}

/// 각주·미주 파트 하나 — 트리와 그 파트의 관계(각주 안 하이퍼링크·그림은 `footnotes.xml.rels` 로 푼다).
struct NotePart {
    root: Node,
    rels: Rels,
}

fn read_note_part(pkg: &mut Package, main_rels: &Rels, suffix: &str, sandbox: &str) -> AppResult<Option<NotePart>> {
    let Some(path) = main_rels.first_of(suffix).and_then(|r| r.path.clone()) else { return Ok(None) };
    let Some(root) = pkg.xml(&path)? else { return Ok(None) };
    let rels = pkg.rels(Some(&path), sandbox)?;
    Ok(Some(NotePart { root, rels }))
}

struct NoteIndex<'a> {
    rels: Option<&'a Rels>,
    by_id: HashMap<&'a str, &'a Node>,
}

impl<'a> NoteIndex<'a> {
    fn new(part: &'a Option<NotePart>, tag: &str) -> Self {
        let Some(p) = part else { return NoteIndex { rels: None, by_id: HashMap::new() } };
        let by_id = p
            .root
            .elements()
            .filter(|n| n.name == tag)
            .filter_map(|n| n.attr("id").map(|id| (id, n)))
            .collect();
        NoteIndex { rels: Some(&p.rels), by_id }
    }
}

// ── 파서 ──────────────────────────────────────────────────────────────────────

/// 컨테이너 문맥: 그림 너비 %의 기준 너비(EMU) — 본문에서는 본문 폭, 셀 안에서는 그 셀의 너비.
#[derive(Clone, Copy)]
struct Cx {
    cw: i64,
}

/// 런에 내려가는 문맥: 문단(스타일 상속 후)의 글자 속성과 지금 걸린 링크.
#[derive(Clone)]
struct RunCtx {
    base: RPr,
    href: Option<String>,
}

#[derive(Default)]
struct FieldState {
    instr: String,
    /// `separate` 를 지났다 = 결과 글자 구간.
    result: bool,
    href: Option<String>,
}

struct ParaFmt {
    kind: Kind,
    level: u8,
    align: Align,
    indent: u8,
    base: RPr,
    /// 목록에 속하면 (numId, 클램프 전 ilvl) — 번호를 세는 데 쓴다(글머리표·번호 없음 단도 센다: 워드는 그 단도 번호 흐름에 넣는다).
    num: Option<(String, u8)>,
}

struct Parser<'a> {
    styles: &'a Styles,
    numbering: &'a Numbering,
    /// 지금 읽는 파트의 관계(본문 → 각주를 읽는 동안은 각주 파트의 것).
    rels: &'a Rels,
    foot: NoteIndex<'a>,
    end: NoteIndex<'a>,
    zip: &'a mut ZipArchive<File>,
    entries: &'a BTreeMap<String, String>,
    pool: ImagePool,
    dropped: BTreeMap<&'static str, u32>,
    footnotes: Vec<Vec<Block>>,
    /// (미주 여부, 원본 id) → 부여한 번호. 같은 각주를 다시 참조하면 본문을 다시 읽지 않고 같은 번호만 쓴다 — 참조마다 각주
    /// 본문을 새로 읽으면 작은 docx 하나가 각주 크기 × 참조 수만큼 HTML 로 불어난다(압축 폭탄형). 워드의 각주 참조는 원래 1:1 이다.
    note_nums: HashMap<(bool, String), usize>,
    /// 추상 정의 id → 단별 마지막 번호(`None` = 아직 안 셈/다시 시작). `next_ord` 가 쓴다.
    list_counters: HashMap<String, Vec<Option<u32>>>,
    /// 한 번이라도 쓴 `w:num` — 처음 쓰는 순간에만 `startOverride` 가 번호를 되돌린다.
    used_nums: HashSet<String>,
    /// 각주 본문을 읽는 중이면 > 0 — 각주 안의 각주 참조는 무시한다(자기 참조로 무한 재귀하지 않게).
    note_depth: u8,
    /// 열린 복합 필드(안쪽이 뒤). 단락·표를 가로질러 이어질 수 있다.
    fields: Vec<FieldState>,
    body_tw: i64,
    /// 글자 높이별 글자 수(공백 제외) — 본문 기준 높이(최빈값)를 구해 제목을 추정한다.
    height_chars: HashMap<u32, usize>,
}

/// 투명하게 펼친 자식들: 콘텐츠 컨트롤(`sdt`)·스마트 태그·사용자 XML·변경 추적 삽입(`ins`/`moveTo`)은 안의 내용을 부모의
/// 자식인 것처럼, `mc:AlternateContent` 는 `Choice`(없으면 `Fallback`) 한 가지만, 삭제(`del`/`moveFrom`)는 통째로 건너뛴다.
/// 블록 · 문단 · 런 어디서나 이 함수로 자식을 순회한다 — 자리마다 따로 다루면 한 곳을 빠뜨린다.
fn kids(n: &Node) -> Vec<&Node> {
    fn walk<'n>(n: &'n Node, out: &mut Vec<&'n Node>) {
        for k in n.elements() {
            match k.name.as_str() {
                "sdt" => {
                    if let Some(c) = child(k, "sdtContent") {
                        walk(c, out);
                    }
                }
                "smartTag" | "customXml" | "ins" | "moveTo" | "dir" | "bdo" => walk(k, out),
                "AlternateContent" => {
                    if let Some(c) = child(k, "Choice").or_else(|| child(k, "Fallback")) {
                        walk(c, out);
                    }
                }
                "del" | "moveFrom" => {}
                _ => out.push(k),
            }
        }
    }
    let mut out = Vec::new();
    walk(n, &mut out);
    out
}

/// 필드 명령의 종류.
enum FieldKind {
    /// `HYPERLINK` — 대상(허용된 주소일 때만).
    Hyperlink(Option<String>),
    Other,
    Empty,
}

/// 따옴표를 지키며 공백으로 가른 낱말들.
fn instr_tokens(instr: &str) -> Vec<String> {
    let mut toks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in instr.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    toks.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        toks.push(cur);
    }
    toks
}

fn parse_field(instr: &str) -> FieldKind {
    let toks = instr_tokens(instr);
    let Some(first) = toks.first() else { return FieldKind::Empty };
    if !first.eq_ignore_ascii_case("HYPERLINK") {
        return FieldKind::Other;
    }
    // 스위치: `\l 책갈피` · `\o 툴팁` · `\t 대상 창` 은 인자를 하나 먹는다(`\m` · `\n` 은 안 먹는다). 첫 낱말이 주소다.
    // 주소 없이 `\l` 만 있으면 문서 안 책갈피 링크라 갈 곳이 없다.
    let mut it = toks[1..].iter();
    let mut url: Option<&String> = None;
    while let Some(t) = it.next() {
        if let Some(sw) = t.strip_prefix('\\') {
            if matches!(sw.to_ascii_lowercase().as_str(), "l" | "o" | "t") {
                it.next();
            }
        } else if url.is_none() {
            url = Some(t);
        }
    }
    FieldKind::Hyperlink(url.and_then(|u| safe_href(u)))
}

/// 심볼 글자(`w:sym`) — 글꼴 사설 영역(F0xx)의 글머리 기호와 Wingdings 체크 상자(양식의 ☐/☑ 칸)만 알려진 모양으로 바꾸고,
/// 그 밖의 사설 영역 코드는 버린다(호출자가 `symbol` 로 센다). 체크 상자 코드는 Symbol 글꼴에선 다른 글자(♦·괄호 조각)라 글꼴을 본다.
fn sym_char(code: &str, font: Option<&str>) -> Option<char> {
    let v = u32::from_str_radix(code.trim(), 16).ok()?;
    if (0xF000..=0xF0FF).contains(&v) {
        let wingdings = font.is_some_and(|f| f.trim().eq_ignore_ascii_case("wingdings"));
        return match (v & 0xFF, wingdings) {
            (0xB7, _) => Some('•'),
            (0xA7, _) => Some('▪'),
            (0xFC, _) => Some('✓'),
            (0xD8, _) => Some('➢'),
            (0xA8, true) => Some('☐'),
            (0xFE, true) => Some('☑'),
            (0xFD, true) => Some('☒'),
            (0xFB, true) => Some('✗'),
            (0x6F, true) => Some('□'),
            (0x6E, true) => Some('■'),
            _ => None,
        };
    }
    char::from_u32(v).filter(|c| !c.is_control())
}

/// VML `style` 속성의 `width:` — EMU 로.
fn style_width_emu(style: &str) -> Option<i64> {
    let v = style.split(';').find_map(|decl| {
        let (k, v) = decl.split_once(':')?;
        k.trim().eq_ignore_ascii_case("width").then(|| v.trim().to_ascii_lowercase())
    })?;
    let (digits, mul) = if let Some(n) = v.strip_suffix("pt") {
        (n, 12700.0)
    } else if let Some(n) = v.strip_suffix("in") {
        (n, 914_400.0)
    } else if let Some(n) = v.strip_suffix("cm") {
        (n, 360_000.0)
    } else if let Some(n) = v.strip_suffix("mm") {
        (n, 36_000.0)
    } else if let Some(n) = v.strip_suffix("px") {
        (n, 9525.0)
    } else {
        return None;
    };
    let f: f64 = digits.trim().parse().ok()?;
    f.is_finite().then(|| ((f * mul).round() as i64).clamp(0, MAX_EMU))
}

/// 그림 틀(`graphicData`) 안에서 그림(`a:blip`)과 글상자 본문(`w:txbxContent`)을 모은다. 글상자 안은 더 내려가지 않는다 —
/// 안의 문단이 파싱될 때 거기서 다시 만난다.
fn collect_drawing<'n>(n: &'n Node, blips: &mut Vec<&'n Node>, boxes: &mut Vec<&'n Node>) {
    for k in n.elements() {
        match k.name.as_str() {
            "txbxContent" => boxes.push(k),
            "AlternateContent" => {
                if let Some(c) = child(k, "Choice").or_else(|| child(k, "Fallback")) {
                    collect_drawing(c, blips, boxes);
                }
            }
            "blip" => blips.push(k),
            _ => collect_drawing(k, blips, boxes),
        }
    }
}

/// VML(`w:pict`) 안에서 그림 자료(`v:imagedata`, 가장 가까운 도형의 `style` 과 함께)와 글상자 본문을 모은다.
fn collect_pict<'n>(
    n: &'n Node,
    style: Option<&'n str>,
    imgs: &mut Vec<(&'n Node, Option<&'n str>)>,
    boxes: &mut Vec<&'n Node>,
) {
    for k in n.elements() {
        let st = k.attr("style").or(style);
        match k.name.as_str() {
            "txbxContent" => boxes.push(k),
            "imagedata" => imgs.push((k, st)),
            _ => collect_pict(k, st, imgs, boxes),
        }
    }
}

impl<'a> Parser<'a> {
    fn drop_kind(&mut self, kind: &'static str) {
        let c = self.dropped.entry(kind).or_insert(0);
        *c = c.saturating_add(1);
    }

    fn body_emu(&self) -> i64 {
        self.body_tw.saturating_mul(EMU_PER_TWIP)
    }

    // ── 스타일 해석 ────────────────────────────────────────────────────────

    /// 문단 속성(`w:pPr`)을 문서 기본 → 문단 스타일 사슬 → 직접 지정 순으로 합쳐 문단의 모양을 정한다.
    fn resolve_para(&self, ppr_node: Option<&Node>) -> ParaFmt {
        let direct = ppr_node.map(read_ppr).unwrap_or_default();
        let style_id = ppr_node
            .and_then(|n| child_val(n, "pStyle"))
            .or(self.styles.default_para.as_deref());
        let mut ppr = self.styles.defaults_ppr.clone();
        let mut base = self.styles.defaults_rpr.clone();
        if let Some(id) = style_id {
            for def in self.styles.chain(id) {
                ppr.over(&def.ppr);
                base.over(&def.rpr);
            }
        }
        ppr.over(&direct);

        let heading = ppr.outline.filter(|l| *l < 9).map(|l| l.min(2) + 1);
        let ilvl = ppr.ilvl.unwrap_or(0);
        let mut num = None;
        let (kind, level) = if let Some(h) = heading {
            // 개요 1 → h1, 2 → h2, 3 이상 → h3. 제목은 Brise 가 제 모양으로 그리므로 스타일이 준 색은 버린다(굵게는 렌더가 뺀다).
            base.color = Some(None);
            (Kind::Heading(h), 0)
        } else {
            // numId 0 은 "번호 없음" 을 명시한 것이다.
            match ppr.num_id.as_deref().filter(|id| *id != "0") {
                Some(id) => match self.numbering.fmt(self.styles, id, ilvl, 0) {
                    Some(f) => {
                        num = Some((id.to_string(), ilvl));
                        match f {
                            ListFmt::Bullet => (Kind::Ul, ilvl.min(5)),
                            ListFmt::Number => (Kind::Ol, ilvl.min(5)),
                            ListFmt::None => (Kind::Normal, 0),
                        }
                    }
                    None => (Kind::Normal, 0),
                },
                None => (Kind::Normal, 0),
            }
        };
        // 들여쓰기 한 단 = 2em ≈ 400 twips(10pt 글자 두 개 = 400).
        let indent = ((ppr.ind_left.unwrap_or(0) as f64 / 400.0).round() as i64).clamp(0, 6) as u8;
        ParaFmt { kind, level, align: ppr.align.unwrap_or(Align::Left), indent, base, num }
    }

    /// 목록 문단 하나의 번호 — 워드가 세는 대로. 번호 흐름은 **추상 정의(abstractNum)** 마다 단별로 하나이고(같은 정의를 쓰는 다른 `w:num`
    /// 은 `startOverride` 가 없으면 앞 목록의 번호를 이어 센다), 한 단의 번호를 매기면 그보다 깊은 단은 다시 시작한다. `w:num` 인스턴스를
    /// **처음 쓸 때** 그 인스턴스의 `startOverride` 단 가운데 쓴 단 이하(깊은 쪽)가 새로 시작한다. 목록이 문단·표·그림에 끊겼다 이어져도 번호가 이어지게 하려는 것이다
    /// (렌더가 `<ol start>` 로 싣는다).
    fn next_ord(&mut self, num_id: &str, ilvl: u8) -> Option<u32> {
        let numbering = self.numbering;
        let def = numbering.nums.get(num_id)?;
        let l = usize::from(ilvl);
        if !self.list_counters.contains_key(&def.abstract_id) {
            self.list_counters.insert(def.abstract_id.clone(), Vec::new());
        }
        let counters = self.list_counters.get_mut(&def.abstract_id)?;
        if counters.len() <= l {
            counters.resize(l + 1, None);
        }
        if !self.used_nums.contains(num_id) {
            self.used_nums.insert(num_id.to_string());
            // 처음 쓴 단과 그 아래 단만 되돌린다 — 안쪽 단에서 시작한 인스턴스가 모든 단을 덮어쓰고 있어도(Brise 내보내기가 그렇게 쓴다)
            // 바깥 목록의 위쪽 단 번호까지 지우면 끊겼다 이어진 바깥 항목이 1 로 되돌아간다.
            for lvl in def.restarts.keys().filter(|lvl| **lvl >= ilvl) {
                if let Some(c) = counters.get_mut(usize::from(*lvl)) {
                    *c = None;
                }
            }
        }
        let n = match counters[l] {
            Some(prev) => prev.saturating_add(1),
            None => numbering.start_of(num_id, ilvl),
        };
        counters[l] = Some(n);
        counters.truncate(l + 1);
        Some(n)
    }

    // ── 블록 · 문단 ────────────────────────────────────────────────────────

    /// 컨테이너(본문 · 셀 · 각주 · 글상자)의 문단과 표를 블록으로. 정리(`finish_blocks`)는 호출자가 한다.
    fn blocks_of(&mut self, container: &Node, cx: Cx) -> AppResult<Vec<Block>> {
        let mut out = Vec::new();
        for c in kids(container) {
            match c.name.as_str() {
                "p" => self.para(c, cx, &mut out)?,
                "tbl" => {
                    if let Some(t) = self.table(c, cx)? {
                        out.push(Block::Table(t));
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }

    fn para(&mut self, p: &Node, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        let f = self.resolve_para(child(p, "pPr"));
        let mut b = ParaAcc::new(f.kind, f.level, f.align, f.indent);
        if let Some((id, ilvl)) = &f.num {
            let n = self.next_ord(id, *ilvl);
            b.ord = n.filter(|_| f.kind == Kind::Ol);
        }
        let ctx = RunCtx { base: f.base, href: None };
        self.inlines(p, &ctx, &mut b, cx, out)?;
        b.finish(out);
        Ok(())
    }

    /// 문단(또는 하이퍼링크·필드·루비 밑글자)의 자식을 순서대로.
    fn inlines(&mut self, parent: &Node, ctx: &RunCtx, b: &mut ParaAcc, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        for c in kids(parent) {
            match c.name.as_str() {
                "r" => self.run(c, ctx, b, cx, out)?,
                "hyperlink" => {
                    // 외부 주소(`r:id`)만 링크가 된다. `w:anchor`(문서 안 책갈피)는 글자만 남긴다.
                    let href = c
                        .attr("id")
                        .and_then(|id| self.rels.get(id))
                        .filter(|r| r.ty.ends_with("/hyperlink"))
                        .and_then(|r| safe_href(&r.target));
                    let inner = RunCtx { base: ctx.base.clone(), href: href.or_else(|| ctx.href.clone()) };
                    self.inlines(c, &inner, b, cx, out)?;
                }
                "fldSimple" => {
                    let mut inner = ctx.clone();
                    match parse_field(c.attr("instr").unwrap_or("")) {
                        FieldKind::Hyperlink(href) => inner.href = href.or_else(|| ctx.href.clone()),
                        FieldKind::Other => {
                            if self.fields.is_empty() {
                                self.drop_kind("field");
                            }
                        }
                        FieldKind::Empty => {}
                    }
                    self.inlines(c, &inner, b, cx, out)?;
                }
                "oMathPara" => {
                    for (i, m) in c.elements().filter(|m| m.name == "oMath").enumerate() {
                        if i > 0 {
                            self.push_plain(b, " ".to_string()); // 수식끼리 한 덩어리 코드로 붙지 않게
                        }
                        self.equation(m, ctx, b);
                    }
                }
                "oMath" => self.equation(c, ctx, b),
                _ => {} // pPr · 책갈피 · 메모 범위 · proofErr … 글자가 아니다
            }
        }
        Ok(())
    }

    fn run(&mut self, r: &Node, ctx: &RunCtx, b: &mut ParaAcc, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        // 상속 순서: 문서 기본 → 문단 스타일(ctx.base) → 글자 스타일 사슬 → 런의 직접 지정. `w:pPr/w:rPr` 는 문단 **표지**의
        // 서식이라 런에 쓰지 않는다.
        let mut rpr = ctx.base.clone();
        if let Some(n) = child(r, "rPr") {
            let direct = read_rpr(n);
            if let Some(sid) = &direct.rstyle {
                for def in self.styles.chain(sid) {
                    rpr.over(&def.rpr);
                }
            }
            rpr.over(&direct);
        }
        let hidden = rpr.vanish == Some(true);
        for c in kids(r) {
            match c.name.as_str() {
                "t" => {
                    if !hidden && !self.in_field_instr() {
                        self.push_text(b, &c.text(), &rpr, &ctx.href);
                    }
                }
                "tab" | "ptab" => {
                    if !hidden {
                        self.push_text(b, " ", &rpr, &ctx.href);
                    }
                }
                "br" => {
                    // 쪽·단 나누기는 노트에 없다 — 줄바꿈만 옮기고, 쪽·단 나누기는 앞뒤 낱말이 붙지 않게 공백 하나(문단 앞뒤 공백은 push_para 가 정리).
                    if !hidden {
                        if matches!(c.attr("type"), Some("page" | "column")) {
                            self.push_text(b, " ", &rpr, &ctx.href);
                        } else {
                            b.inl.push(Inline::Br);
                        }
                    }
                }
                "cr" => {
                    if !hidden {
                        b.inl.push(Inline::Br);
                    }
                }
                "noBreakHyphen" => {
                    if !hidden {
                        self.push_text(b, "-", &rpr, &ctx.href);
                    }
                }
                "sym" => {
                    if !hidden {
                        match c.attr("char").and_then(|code| sym_char(code, c.attr("font"))) {
                            Some(ch) => self.push_text(b, &ch.to_string(), &rpr, &ctx.href),
                            None => self.drop_kind("symbol"),
                        }
                    }
                }
                "fldChar" => self.fld_char(c),
                "instrText" => self.instr_text(&c.text()),
                "footnoteReference" => self.note_ref(c, false, b)?,
                "endnoteReference" => self.note_ref(c, true, b)?,
                // 메모 본문은 가져오지 않는다 — 참조마다 센다.
                "commentReference" => self.drop_kind("comment"),
                "drawing" => self.drawing(c, b, cx, out)?,
                "pict" => self.pict(c, b, cx, out)?,
                "object" => {
                    // OLE 개체(미리보기 그림 포함)는 옮기지 못한다.
                    self.drop_kind("ole");
                    b.had_object = true;
                }
                "ruby" => {
                    // 루비는 밑글자만 — 위 작은 글자(rt)는 읽는 법이라 본문 뜻에 필요 없다.
                    let inner = RunCtx { base: rpr.clone(), href: ctx.href.clone() };
                    for base in c.elements().filter(|e| e.name == "rubyBase") {
                        self.inlines(base, &inner, b, cx, out)?;
                    }
                }
                _ => {} // rPr · footnoteRef/endnoteRef(번호는 우리가 붙인다) · delText · 쪽 번호 … 글자가 아니다
            }
        }
        Ok(())
    }

    // ── 글자 ───────────────────────────────────────────────────────────────

    /// 필드 명령 구간(`begin`~`separate`)이면 `w:t` 는 글자가 아니다. 어느 한 겹이라도 명령 구간이면 그렇다 —
    /// `IF { REF x } = …` 처럼 바깥 필드의 명령 안에 든 안쪽 필드의 결과 글자도 바깥 명령의 일부다.
    fn in_field_instr(&self) -> bool {
        self.fields.iter().any(|f| !f.result)
    }

    /// 지금 글자에 걸 링크: 감싼 `w:hyperlink` 가 먼저, 없으면 결과 구간에 든 `HYPERLINK` 필드.
    fn current_href(&self, explicit: &Option<String>) -> Option<String> {
        explicit
            .clone()
            .or_else(|| self.fields.iter().rev().find(|f| f.result && f.href.is_some()).and_then(|f| f.href.clone()))
    }

    fn push_text(&mut self, b: &mut ParaAcc, raw: &str, rpr: &RPr, href: &Option<String>) {
        let text = clean_text(raw);
        if text.is_empty() {
            return;
        }
        let height = rpr.size.unwrap_or(DEFAULT_SZ) * 50;
        let n = text.chars().filter(|c| !c.is_whitespace()).count();
        if n > 0 {
            *self.height_chars.entry(height).or_default() += n;
        }
        let st = Style {
            bold: rpr.bold.unwrap_or(false),
            italic: rpr.italic.unwrap_or(false),
            underline: rpr.underline.unwrap_or(false),
            strike: rpr.strike.unwrap_or(false),
            mark: rpr.mark.unwrap_or(false),
            code: false,
            color: rpr.color.clone().flatten(),
            height,
        };
        let link = self.current_href(href);
        push_piece(b, text, st, link);
    }

    /// 직전 글자와 같은 크기로 덧붙인다(각주 표지처럼 자기 글자 모양이 없는 것).
    fn push_plain(&mut self, b: &mut ParaAcc, text: String) {
        let height = b.inl.iter().rev().find_map(|i| match i {
            Inline::Text(p) => Some(p.st.height),
            Inline::Br => None,
        });
        push_piece(b, text, Style { height: height.unwrap_or(DEFAULT_SZ * 50), ..Default::default() }, None);
    }

    fn equation(&mut self, m: &Node, ctx: &RunCtx, b: &mut ParaAcc) {
        self.drop_kind("equation");
        b.had_object = true;
        let mut parts = Vec::new();
        find_all(m, "t", &mut parts);
        let raw: String = parts.iter().map(|t| t.text()).collect();
        let text = clean_text(&raw).split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            let height = ctx.base.size.unwrap_or(DEFAULT_SZ) * 50;
            push_piece(b, text, Style { code: true, height, ..Default::default() }, None);
        }
    }

    // ── 필드 ───────────────────────────────────────────────────────────────

    fn fld_char(&mut self, c: &Node) {
        match c.attr("fldCharType") {
            Some("begin") => {
                if self.fields.len() < MAX_FIELD_DEPTH {
                    self.fields.push(FieldState::default());
                }
            }
            Some("separate") => {
                let outermost = self.fields.len() == 1;
                let Some(top) = self.fields.last_mut() else { return };
                if top.result {
                    return;
                }
                top.result = true;
                let instr = std::mem::take(&mut top.instr);
                self.classify_field(&instr, outermost);
            }
            Some("end") => {
                // 결과 구간이 없는 필드(`separate` 없음)는 여기서 한 번 분류한다.
                if let Some(f) = self.fields.pop() {
                    if !f.result {
                        let outermost = self.fields.is_empty();
                        self.classify_field(&f.instr, outermost);
                    }
                }
            }
            _ => {}
        }
    }

    /// 명령을 읽어 링크면 맨 위 필드에 대상을 달고, 그 밖이면 가장 바깥 필드일 때만 센다(목차 안의 쪽 번호 참조까지 세지 않게).
    fn classify_field(&mut self, instr: &str, outermost: bool) {
        match parse_field(instr) {
            FieldKind::Hyperlink(href) => {
                if let Some(top) = self.fields.last_mut() {
                    top.href = href;
                }
            }
            FieldKind::Other => {
                if outermost {
                    self.drop_kind("field");
                }
            }
            FieldKind::Empty => {}
        }
    }

    fn instr_text(&mut self, t: &str) {
        if let Some(top) = self.fields.last_mut().filter(|f| !f.result) {
            if top.instr.len() < MAX_INSTR_CHARS {
                top.instr.push_str(t);
            }
        }
    }

    // ── 각주 · 미주 ────────────────────────────────────────────────────────

    /// 각주·미주 — 본문엔 `[n]`, 내용은 본문 끝 "각주" 목록으로(내용 보존, 위치 손실). 각주와 미주는 한 번호 줄을 쓴다.
    fn note_ref(&mut self, n: &Node, endnote: bool, b: &mut ParaAcc) -> AppResult<()> {
        if self.note_depth > 0 {
            return Ok(());
        }
        let Some(id) = n.attr("id") else { return Ok(()) };
        let (note_rels, note) = {
            let idx = if endnote { &self.end } else { &self.foot };
            (idx.rels, idx.by_id.get(id).copied())
        };
        let (Some(note_rels), Some(note)) = (note_rels, note) else { return Ok(()) };

        if let Some(&num) = self.note_nums.get(&(endnote, id.to_string())) {
            self.push_plain(b, format!("[{num}]"));
            return Ok(());
        }
        let num = self.footnotes.len() + 1;
        self.push_plain(b, format!("[{num}]"));
        let saved_rels = std::mem::replace(&mut self.rels, note_rels);
        let saved_fields = std::mem::take(&mut self.fields);
        self.note_depth += 1;
        let cx = Cx { cw: self.body_emu() };
        let result = self.blocks_of(note, cx);
        self.note_depth -= 1;
        self.fields = saved_fields;
        self.rels = saved_rels;
        let mut blocks = result?;
        finish_blocks(&mut blocks, false);
        // 각주 본문 스타일의 들여쓰기(워드는 번호 자리를 내어 쓴다)는 "각주" 목록에서 뜻이 없다.
        for blk in &mut blocks {
            if let Block::Para(para) = blk {
                para.indent = 0;
            }
        }
        // 각주 본문은 보통 ` ` + 글자로 시작한다(번호 자리) — 우리 표지 뒤에서 공백이 겹치지 않게 앞 공백을 뗀다.
        if let Some(Block::Para(p)) = blocks.first_mut() {
            while let Some(Inline::Text(t)) = p.inl.first_mut() {
                let trimmed = t.text.trim_start();
                if trimmed.len() == t.text.len() {
                    break;
                }
                if trimmed.is_empty() {
                    p.inl.remove(0);
                } else {
                    t.text = trimmed.to_string();
                    break;
                }
            }
        }
        let marker = Inline::Text(Piece { text: format!("[{num}] "), st: Style::default(), link: None });
        match blocks.first_mut() {
            Some(Block::Para(p)) => p.inl.insert(0, marker),
            _ => blocks.insert(
                0,
                Block::Para(Para { kind: Kind::Normal, level: 0, align: Align::Left, indent: 0, ord: None, inl: vec![marker] }),
            ),
        }
        self.footnotes.push(blocks);
        self.note_nums.insert((endnote, id.to_string()), num);
        Ok(())
    }

    // ── 개체(그림 · 도형 · 글상자) ─────────────────────────────────────────

    /// `w:drawing` — 안의 `wp:inline`/`wp:anchor` 하나하나가 개체다. 그림이면 이미지 블록, 차트는 세고, 그 밖(도형 · 묶음 ·
    /// 캔버스 · 다이어그램 …)은 도형으로 세되 안의 글상자 글과 그림은 꺼낸다.
    fn drawing(&mut self, d: &Node, b: &mut ParaAcc, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        for obj in kids(d) {
            if !matches!(obj.name.as_str(), "inline" | "anchor") {
                continue;
            }
            let width = child(obj, "extent").and_then(|e| num::<i64>(e.attr("cx"))).map(|w| w.clamp(0, MAX_EMU));
            let Some(graphic) = find_first(obj, "graphicData") else { continue };
            let uri = graphic.attr("uri").unwrap_or("").to_ascii_lowercase();
            let mut blips = Vec::new();
            let mut boxes = Vec::new();
            collect_drawing(graphic, &mut blips, &mut boxes);
            if uri.contains("chart") {
                self.drop_kind("chart");
                b.had_object = true;
            } else if uri.ends_with("/picture") {
                b.flush_before_object(out);
                match blips.first() {
                    Some(blip) => {
                        let img = self.picture(blip.attr("embed"), width, cx)?;
                        out.extend(img.map(Block::Image));
                    }
                    None => self.drop_kind("image_missing"),
                }
            } else {
                self.drop_kind("shape");
                b.had_object = true;
                for blip in &blips {
                    b.flush_before_object(out);
                    let img = self.picture(blip.attr("embed"), None, cx)?;
                    out.extend(img.map(Block::Image));
                }
                self.textboxes(&boxes, b, cx, out)?;
            }
        }
        Ok(())
    }

    /// `w:pict`(VML) — 그림 자료가 있으면 그림, 없으면 도형(글상자 글은 꺼낸다).
    fn pict(&mut self, p: &Node, b: &mut ParaAcc, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        let mut imgs = Vec::new();
        let mut boxes = Vec::new();
        collect_pict(p, None, &mut imgs, &mut boxes);
        if imgs.is_empty() {
            self.drop_kind("shape");
            b.had_object = true;
        }
        for (img, style) in imgs {
            b.flush_before_object(out);
            let width = style.and_then(style_width_emu);
            let rid = img.attr("id").or_else(|| img.attr("relid"));
            let blk = self.picture(rid, width, cx)?;
            out.extend(blk.map(Block::Image));
        }
        self.textboxes(&boxes, b, cx, out)
    }

    /// 글상자 본문을 그 자리의 일반 문단으로. 열린 필드는 상자 안으로 새지 않게 비워 두고 돌아와서 되살린다.
    fn textboxes(&mut self, boxes: &[&Node], b: &mut ParaAcc, cx: Cx, out: &mut Vec<Block>) -> AppResult<()> {
        for tb in boxes {
            b.flush_before_object(out);
            let saved = std::mem::take(&mut self.fields);
            let result = self.blocks_of(tb, cx);
            self.fields = saved;
            let mut blocks = result?;
            finish_blocks(&mut blocks, false);
            out.append(&mut blocks);
        }
        Ok(())
    }

    // ── 그림 ───────────────────────────────────────────────────────────────

    /// 관계 id → 그림 블록. 외부 그림(`r:link` · TargetMode External)은 **절대 읽지 않는다**. 못 가져오면 이유를 세고 `None`.
    fn picture(&mut self, rid: Option<&str>, width_emu: Option<i64>, cx: Cx) -> AppResult<Option<ImgBlock>> {
        let rels = self.rels;
        let path = rid.and_then(|id| rels.get(id)).filter(|r| !r.external).and_then(|r| r.path.as_deref());
        let Some(real) = path.and_then(|p| self.entries.get(&p.to_lowercase())) else {
            self.drop_kind("image_missing");
            return Ok(None);
        };
        match self.pool.load(&mut *self.zip, real, "docx_import")? {
            Ok(idx) => {
                // 기준 너비 대비 %(10~100).
                let width_pct = match (width_emu.filter(|w| *w > 0), cx.cw) {
                    (Some(w), cw) if cw > 0 => Some((((w * 100) + cw / 2) / cw).clamp(10, 100) as u32),
                    _ => None,
                };
                Ok(Some(ImgBlock { idx, width_pct }))
            }
            // emf·wmf·tif … 웹뷰가 못 그리거나(image_format), 상한에 걸렸다(image_limit).
            Err(kind) => {
                self.drop_kind(kind);
                Ok(None)
            }
        }
    }

    // ── 표 ─────────────────────────────────────────────────────────────────

    fn table(&mut self, tbl: &Node, cx: Cx) -> AppResult<Option<Table>> {
        let grid: Vec<i64> = child(tbl, "tblGrid")
            .map(|g| {
                g.elements()
                    .filter(|c| c.name == "gridCol")
                    .map(|c| measure(c.attr("w")).unwrap_or(0).max(0))
                    .collect()
            })
            .unwrap_or_default();
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        // 세로 병합: 시작 열 → (시작 행, 그 행 안 셀 번호, 지금까지 이어진 마지막 행). `vMerge` 에 값이 없으면 **이어짐**이다.
        let mut open: HashMap<usize, (usize, usize, usize)> = HashMap::new();
        for tr in kids(tbl).into_iter().filter(|t| t.name == "tr") {
            let trpr = child(tr, "trPr");
            // 변경 추적으로 삭제된 행 — 수락한 모양에는 없다.
            if trpr.is_some_and(|t| child(t, "del").is_some()) {
                continue;
            }
            let header_row = trpr.and_then(|t| child(t, "tblHeader")).is_some_and(on_off);
            let r = rows.len();
            let mut cells: Vec<Cell> = Vec::new();
            let mut col = 0usize;
            // 앞 격자 칸을 비워 둔 행 — 빈 칸으로 채워 이 행의 셀들이 제 열에 서게 한다.
            let before = trpr
                .and_then(|t| child_val(t, "gridBefore"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0)
                .min(MAX_COLSPAN);
            if before > 0 {
                cells.push(Cell {
                    header: false,
                    colspan: before,
                    rowspan: 1,
                    width_px: None,
                    colwidth: None,
                    bg: None,
                    blocks: vec![empty_para()],
                });
                col += before;
            }
            for tc in kids(tr).into_iter().filter(|c| c.name == "tc") {
                let tcpr = child(tc, "tcPr");
                let span = tcpr
                    .and_then(|t| child_val(t, "gridSpan"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(1)
                    .clamp(1, MAX_COLSPAN);
                // 가로 병합(옛 방식): 이어짐 셀은 앞 셀에 합친다.
                if let Some(h) = tcpr.and_then(|t| child(t, "hMerge")) {
                    if !h.attr("val").is_some_and(|v| v.eq_ignore_ascii_case("restart")) {
                        if let Some(prev) = cells.last_mut() {
                            prev.colspan = (prev.colspan + span).min(MAX_COLSPAN);
                        }
                        col += span;
                        continue;
                    }
                }
                let vmerge = tcpr.and_then(|t| child(t, "vMerge")).map(|v| {
                    !v.attr("val").is_some_and(|x| x.eq_ignore_ascii_case("restart")) // true = 이어짐
                });
                if vmerge == Some(true) {
                    if let Some(&(r0, c0, last)) = open.get(&col) {
                        if last + 1 == r {
                            let owner = &mut rows[r0][c0];
                            owner.rowspan = (owner.rowspan + 1).min(MAX_ROWSPAN);
                            open.insert(col, (r0, c0, r));
                            col += span;
                            continue;
                        }
                    }
                    // 이을 셀이 없는 이음은 그냥 셀로 둔다.
                }
                // 너비: 격자 열 폭의 합이 우선, 없으면 셀 자신의 tcW(dxa).
                let from_grid: Option<i64> = grid
                    .get(col..col + span)
                    .map(|w| w.iter().sum::<i64>())
                    .filter(|w| *w > 0);
                let from_tcw = tcpr
                    .and_then(|t| child(t, "tcW"))
                    .filter(|w| w.attr("type").is_none_or(|t| t.eq_ignore_ascii_case("dxa")))
                    .and_then(|w| measure(w.attr("w")))
                    .filter(|w| *w > 0);
                let width_tw = from_grid.or(from_tcw).unwrap_or(0);
                let bg = tcpr
                    .and_then(|t| child(t, "shd"))
                    .and_then(|s| s.attr("fill"))
                    .and_then(|f| norm_color(&format!("#{f}")))
                    .filter(|c| c != "#ffffff");
                let inner = Cx { cw: if width_tw > 0 { width_tw.saturating_mul(EMU_PER_TWIP) } else { cx.cw } };
                let mut blocks = self.blocks_of(tc, inner)?;
                finish_blocks(&mut blocks, true);
                let ci = cells.len();
                cells.push(Cell {
                    header: header_row,
                    colspan: span,
                    rowspan: 1,
                    // 1px = 15 twips(96dpi).
                    width_px: (width_tw > 0).then(|| ((width_tw as f64) / 15.0).round() as u32).filter(|w| *w > 0),
                    colwidth: None,
                    bg,
                    blocks,
                });
                if vmerge == Some(false) {
                    open.insert(col, (r, ci, r));
                } else {
                    open.remove(&col);
                }
                col += span;
            }
            rows.push(cells);
        }
        build_table(rows)
    }
}

/// 조각 하나를 덧붙인다. 링크 글자는 워드가 파랑 + 밑줄로 칠한다 — 링크 표시는 Brise 가 알아서 하므로 그 장식은 벗긴다.
fn push_piece(b: &mut ParaAcc, text: String, mut st: Style, link: Option<String>) {
    if link.is_some() {
        st.underline = false;
        if matches!(st.color.as_deref(), Some("#0000ff" | "#0563c1")) {
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

/// 본문 폭(twips) = 쪽 폭 − 좌우 여백. 첫 구역부터 `pgSz` 를 가진 것을 찾고, 못 찾거나 폭이 안 나오면 A4 기본.
fn body_width(body: &Node) -> i64 {
    let mut sects = Vec::new();
    find_all(body, "sectPr", &mut sects);
    for s in sects {
        let Some(sz) = child(s, "pgSz") else { continue };
        let Some(width) = measure(sz.attr("w")) else { continue };
        let mar = child(s, "pgMar");
        let side = |a: &str, b: &str| measure(mar.and_then(|m| m.attr(a).or_else(|| m.attr(b)))).unwrap_or(0);
        let w = width - side("left", "start") - side("right", "end");
        if w > 0 {
            return w;
        }
    }
    DEFAULT_BODY_TWIPS
}

/// docx 를 열어 중간 표현으로 만든다. DB 를 쓰지 않는다.
pub fn parse_file(path: &Path) -> AppResult<Parsed> {
    let meta = std::fs::metadata(path).map_err(io_err)?;
    if meta.len() > MAX_DOC_FILE_BYTES {
        return Err(AppError::Validation(format!("docx exceeds {}MB limit", MAX_DOC_FILE_BYTES / (1024 * 1024))));
    }
    let mut file = File::open(path).map_err(io_err)?;
    // 암호화된 docx 는 zip 이 아니라 OLE 복합 문서다(옛 `.doc` 도 같은 머리) — zip 으로 열기 전에 알아본다.
    let mut head = [0u8; 8];
    if file.read_exact(&mut head).is_ok() && head == OLE_MAGIC {
        return Err(AppError::Validation("encrypted or legacy (OLE) docx is not supported".to_string()));
    }
    file.seek(SeekFrom::Start(0)).map_err(io_err)?;
    let archive = ZipArchive::new(file).map_err(|e| AppError::Validation(format!("not a valid docx (zip): {e}")))?;
    let entries: BTreeMap<String, String> =
        archive.file_names().map(|n| (n.replace('\\', "/").to_lowercase(), n.to_string())).collect();
    let mut pkg = Package { archive, entries, budget: MAX_DECOMPRESSED_BYTES };

    // 본문 파트는 패키지 관계(`_rels/.rels`)의 officeDocument 가 알려 준다 — 없으면 관례 경로.
    let root_rels = pkg.rels(None, "")?;
    let main_path = root_rels
        .first_of("/officeDocument")
        .and_then(|r| r.path.clone())
        .unwrap_or_else(|| "word/document.xml".to_string());
    let Some(doc) = pkg.xml(&main_path)? else {
        return Err(AppError::Validation("docx missing the main document part (word/document.xml)".to_string()));
    };
    if doc.name != "document" {
        return Err(AppError::Validation("not a wordprocessing document".to_string()));
    }
    let Some(body) = child(&doc, "body") else {
        return Err(AppError::Validation("docx has no body".to_string()));
    };
    // 관계가 가리킬 수 있는 곳은 본문 파트의 폴더(보통 `word/`) 안뿐이다.
    let sandbox = main_path.rsplit_once('/').map(|(d, _)| format!("{}/", d.to_lowercase())).unwrap_or_default();
    let main_rels = pkg.rels(Some(&main_path), &sandbox)?;

    let styles = match main_rels.first_of("/styles").and_then(|r| r.path.clone()) {
        Some(p) => pkg.xml(&p)?.map(|r| read_styles(&r)).unwrap_or_default(),
        None => Styles::default(),
    };
    let numbering = match main_rels.first_of("/numbering").and_then(|r| r.path.clone()) {
        Some(p) => pkg.xml(&p)?.map(|r| read_numbering(&r)).unwrap_or_default(),
        None => Numbering::default(),
    };
    let foot_part = read_note_part(&mut pkg, &main_rels, "/footnotes", &sandbox)?;
    let end_part = read_note_part(&mut pkg, &main_rels, "/endnotes", &sandbox)?;

    let Package { mut archive, entries, .. } = pkg;
    let mut p = Parser {
        styles: &styles,
        numbering: &numbering,
        rels: &main_rels,
        foot: NoteIndex::new(&foot_part, "footnote"),
        end: NoteIndex::new(&end_part, "endnote"),
        zip: &mut archive,
        entries: &entries,
        pool: ImagePool::new(),
        dropped: BTreeMap::new(),
        footnotes: Vec::new(),
        note_nums: HashMap::new(),
        list_counters: HashMap::new(),
        used_nums: HashSet::new(),
        note_depth: 0,
        fields: Vec::new(),
        body_tw: body_width(body),
        height_chars: HashMap::new(),
    };

    let cx = Cx { cw: p.body_emu() };
    let mut blocks = p.blocks_of(body, cx)?;
    finish_blocks(&mut blocks, false);

    // 머리말·꼬리말은 본문에 없다 — 구역 설정이 가리키는 참조 개수로 센다.
    let mut refs = Vec::new();
    find_all(body, "headerReference", &mut refs);
    find_all(body, "footerReference", &mut refs);
    for _ in &refs {
        p.drop_kind("header_footer");
    }

    // 본문 기준 글자 높이 = 글자 수가 가장 많은 높이(동률이면 작은 쪽).
    let base = p
        .height_chars
        .iter()
        .max_by_key(|(h, n)| (**n, std::cmp::Reverse(**h)))
        .map(|(h, _)| *h)
        .unwrap_or(0);
    infer_headings(&mut blocks, base);

    if blocks.is_empty() && p.footnotes.is_empty() {
        return Err(AppError::Validation("docx has no importable content".to_string()));
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
// 픽스처는 워드가 저장한 docx 의 모양을 흉내 낸다. 서식 · 스타일 · 목록 · 필드는 `docx/tests.rs`, 패키지 · 관계 · 표 · 그림 · 각주 ·
// 개체 · 거절은 `docx/tests_package.rs`. 실제 워드 저장본 16개를 읽는 `#[ignore]` 테스트가 하나 있다(환경변수 `BRISE_DOCX_SAMPLES`).
#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod tests_package;
