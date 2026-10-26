// repo: doc_import::html — Brise 계약 HTML 렌더 + 색·링크 안전 (HWPX 가져오기에서 떼어 낸 형식 무관 부분, W4-0)
//
// 중간 표현(`ir::Block`)에서 HTML 을 쓰는 **유일한** 자리 — 이스케이프와 `#rrggbb` 검증이 한 곳에 모인다.
// 이 HTML 은 Brise 스키마가 parseHTML 로 아는 부분집합만 쓴다(specs/commands/sections.yaml doc_import_html).
use super::ir::{Align, Block, Inline, Kind, Parsed, Piece};
use super::SavedImage;

/// 본문 끝에 모으는 각주 목록의 제목. ponytail: 로케일 고정(한글) — 이 문자열은 UI 가 아니라 DB 에 저장되는 데이터다.
/// pptx 슬라이드 제목(`## Slide n`)은 en 으로 굳혔지만, 이쪽은 hwpx(한글 문서) 전용이라 문서 언어를 따른다(계획 지시).
const FOOTNOTES_HEADING: &str = "각주";

/// `#rrggbb`(대소문자 무관) 만 통과시켜 소문자로 돌려준다 — 이 모듈의 **유일한** 색 검증 함수다.
pub(super) fn norm_color(s: &str) -> Option<String> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit()) {
        Some(s.to_ascii_lowercase())
    } else {
        None
    }
}

pub(super) fn is_hex6(s: &str) -> bool {
    norm_color(s).is_some_and(|c| c == s)
}

// ── 하이퍼링크 ────────────────────────────────────────────────────────────────

/// http/https/mailto 만 링크로 둔다 — 그 밖(javascript: · file: · 책갈피 …)은 링크 없이 글자만 남긴다.
///
/// 주소 안의 `( ) [ ] \` 와 백틱은 퍼센트 인코딩한다. 프런트 직렬화기는 링크 주소의 괄호를 이스케이프하지 않아
/// `[글](http://x/)[y](javascript:…)` 처럼 **파일 안의 글자가 마크다운 링크·이미지를 새로 만든다**(주소의 `)` 가 링크를
/// 닫기 때문). 같은 주소이고(서버가 `%28` 을 풀어 읽는다) 마크다운 경계는 못 건드린다. 직렬화기 쪽 수정은 기존 노트의
/// `Foo_(bar)` 주소 바이트를 바꾸므로 여기서는 하지 않았다(붙여넣은 HTML 링크는 여전히 같은 한계).
pub(super) fn safe_href(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '<' | '>' | '"')) {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return None;
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            '\\' => out.push_str("%5C"),
            '`' => out.push_str("%60"),
            c => out.push(c),
        }
    }
    Some(out)
}

// ── 렌더(HTML 을 쓰는 유일한 자리) ────────────────────────────────────────────

fn esc(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
}

fn esc_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
}

/// Brise 자신이 쓰는 모양(`paragraphFormat.ts::formatAttributes`)과 같게 — 정렬은 data 속성 + style, 들여쓰기는 data 속성.
fn format_attrs(align: Align, indent: u8) -> String {
    if align == Align::Left && indent == 0 {
        return String::new();
    }
    let mut attrs = String::new();
    let mut styles: Vec<String> = Vec::new();
    if align != Align::Left {
        attrs.push_str(&format!(" data-brise-align=\"{}\"", align.css()));
        styles.push(format!("text-align: {}", align.css()));
    }
    if indent > 0 {
        attrs.push_str(&format!(" data-brise-indent=\"{indent}\""));
        styles.push(format!("margin-left: {}em", u32::from(indent) * 2));
    }
    attrs.push_str(&format!(" style=\"{};\"", styles.join("; ")));
    attrs
}

fn render_piece(p: &Piece, out: &mut String, in_heading: bool) {
    // 공백뿐인 조각은 서식도 링크도 떼고 글자만 낸다. 마크다운은 `**` `++` `~~` `==` 가 공백만 감싸면 표지로 읽지 않아 기호가
    // 글자로 남는다(`앞**** 뒤` → 재열기 뒤에도 별표 네 개, 다음 저장에서 `\*\*\*\*`). 이웃 글자에 붙은 공백은 직렬화기가 알아서
    // 마크 밖으로 빼므로 공백**만**인 조각이 문제다. 밑줄 친 빈칸(`이름 : ______`)의 밑줄은 이 때문에 잃지만, 마크다운에는
    // 공백 밑줄을 담을 자리가 없다. 공백 개수(폭)는 HTML 이 접으므로 NBSP 로 바꾸지 않는다 — 일반 문단의 연속 공백과 같은 한계다.
    if p.text.chars().all(char::is_whitespace) {
        esc(&p.text, out);
        return;
    }
    let st = &p.st;
    let mut closers: Vec<&'static str> = Vec::new();
    if let Some(href) = &p.link {
        out.push_str("<a href=\"");
        esc_attr(href, out);
        out.push_str("\">");
        closers.push("</a>");
    }
    if let Some(c) = st.color.as_deref().filter(|c| is_hex6(c)) {
        out.push_str(&format!("<span style=\"color: {c}\">"));
        closers.push("</span>");
    }
    // 제목은 원래 굵게 그려진다 — 굵게를 또 박으면 `## **제목**` 이 된다.
    for (on, open, close) in [
        (st.bold && !in_heading, "<strong>", "</strong>"),
        (st.italic, "<em>", "</em>"),
        (st.underline, "<u>", "</u>"),
        (st.strike, "<s>", "</s>"),
        (st.mark, "<mark>", "</mark>"),
        (st.code, "<code>", "</code>"),
    ] {
        if on {
            out.push_str(open);
            closers.push(close);
        }
    }
    esc(&p.text, out);
    for c in closers.iter().rev() {
        out.push_str(c);
    }
}

fn render_inlines(inl: &[Inline], out: &mut String, in_heading: bool) {
    for i in inl {
        match i {
            Inline::Br => out.push_str("<br>"),
            Inline::Text(p) => render_piece(p, out, in_heading),
        }
    }
}

/// 목록 여는 태그. 번호 목록이 1 이 아닌 번호에서 시작하면 `start` 를 단다 — 사이에 문단·표·그림이 끼어 끊긴 목록이 이어질 때, 또는
/// 문서가 시작 번호를 정했을 때(없으면 "1. 둘째" 로 다시 세는 거짓말이 된다).
fn open_list(tag: &'static str, ord: Option<u32>, out: &mut String) {
    out.push('<');
    out.push_str(tag);
    if let Some(n) = ord.filter(|n| tag == "ol" && *n != 1) {
        out.push_str(&format!(" start=\"{n}\""));
    }
    out.push('>');
}

fn close_lists(lists: &mut Vec<&'static str>, out: &mut String, top: bool) {
    let any = !lists.is_empty();
    while let Some(tag) = lists.pop() {
        out.push_str("</li></");
        out.push_str(tag);
        out.push('>');
    }
    if any && top {
        out.push('\n');
    }
}

/// 블록들을 HTML 로. 연속된 목록 문단은 한 목록으로 묶고 `level` 로 중첩한다 — 열린 목록마다 열린 `<li>` 가
/// 하나씩 있다는 불변식으로 짠다(깊이를 건너뛰면 한 단만 연다).
fn render_blocks(blocks: &[Block], atts: &[SavedImage], out: &mut String, top: bool) {
    let mut lists: Vec<&'static str> = Vec::new();
    for b in blocks {
        if let Block::Para(p) = b {
            if matches!(p.kind, Kind::Ul | Kind::Ol) {
                let tag = if p.kind == Kind::Ol { "ol" } else { "ul" };
                let want = usize::from(p.level).min(lists.len());
                while lists.len() > want + 1 {
                    let t = lists.pop().unwrap_or("ul");
                    out.push_str("</li></");
                    out.push_str(t);
                    out.push('>');
                }
                if lists.len() == want + 1 {
                    out.push_str("</li>");
                    if lists[want] != tag {
                        out.push_str("</");
                        out.push_str(lists[want]);
                        out.push('>');
                        open_list(tag, p.ord, out);
                        lists[want] = tag;
                    }
                } else {
                    lists.push(tag);
                    open_list(tag, p.ord, out);
                }
                // 목록·인용 안 문단은 정렬·들여쓰기를 읽지 않는다(W0 와 같은 규칙) — 속성을 붙이지 않는다.
                out.push_str("<li><p>");
                render_inlines(&p.inl, out, false);
                out.push_str("</p>");
                continue;
            }
        }
        close_lists(&mut lists, out, top);
        render_block(b, atts, out);
        if top {
            out.push('\n');
        }
    }
    close_lists(&mut lists, out, top);
}

fn render_block(b: &Block, atts: &[SavedImage], out: &mut String) {
    match b {
        Block::Para(p) => {
            let attrs = format_attrs(p.align, p.indent);
            match p.kind {
                Kind::Heading(n) => {
                    let n = n.clamp(1, 3);
                    out.push_str(&format!("<h{n}{attrs}>"));
                    render_inlines(&p.inl, out, true);
                    out.push_str(&format!("</h{n}>"));
                }
                _ => {
                    out.push_str(&format!("<p{attrs}>"));
                    render_inlines(&p.inl, out, false);
                    out.push_str("</p>");
                }
            }
        }
        Block::Image(img) => {
            let Some(att) = atts.get(img.idx) else { return };
            out.push_str("<img src=\"");
            esc_attr(&att.rel_path, out);
            out.push_str("\" data-rel-path=\"");
            esc_attr(&att.rel_path, out);
            out.push_str("\" alt=\"");
            esc_attr(&att.name, out);
            out.push('"');
            if let Some(w) = img.width_pct {
                out.push_str(&format!(" style=\"width: {w}%\""));
            }
            out.push('>');
        }
        Block::Table(t) => {
            out.push_str("<table>");
            for row in &t.rows {
                out.push_str("<tr>");
                for cell in row {
                    let tag = if cell.header { "th" } else { "td" };
                    out.push('<');
                    out.push_str(tag);
                    if cell.colspan > 1 {
                        out.push_str(&format!(" colspan=\"{}\"", cell.colspan));
                    }
                    if cell.rowspan > 1 {
                        out.push_str(&format!(" rowspan=\"{}\"", cell.rowspan));
                    }
                    if let Some(w) = &cell.colwidth {
                        let list = w.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
                        out.push_str(&format!(" colwidth=\"{list}\""));
                    }
                    if let Some(bg) = cell.bg.as_deref().filter(|c| is_hex6(c)) {
                        out.push_str(&format!(" style=\"background-color: {bg}\""));
                    }
                    out.push('>');
                    render_blocks(&cell.blocks, atts, out, false);
                    out.push_str("</");
                    out.push_str(tag);
                    out.push('>');
                }
                out.push_str("</tr>");
            }
            out.push_str("</table>");
        }
    }
}

impl Parsed {
    /// ③ 렌더. `atts[i]` 는 `images[i]` 가 저장된 결과다(없는 번호의 그림은 건너뛴다).
    pub fn render(&self, atts: &[SavedImage]) -> String {
        let mut out = String::new();
        render_blocks(&self.blocks, atts, &mut out, true);
        if !self.footnotes.is_empty() {
            out.push_str(&format!("<h3>{FOOTNOTES_HEADING}</h3>\n"));
            for blocks in &self.footnotes {
                render_blocks(blocks, atts, &mut out, true);
            }
        }
        out.trim().to_string()
    }
}
