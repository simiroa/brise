// repo: doc_export::html — 내보내기 모달 "HTML"(export_html)·"서식 복사"(export_html_inline)의 그림 채우기 (PLAN-2026-10-07 W6)
//
// HTML 은 프런트가 만든 완성 문서다(미리보기와 같은 헤드리스 TipTap 렌더 + CSS) — Rust 는 다시 렌더하지 않고 `<img>` 만 고친다:
//   · `data-rel-path="폴더/파일"` 이 있으면 export_hwpx·docx 와 **같은 해석기**(`attachment_resolver` — 첨부 루트 안에서만, `../`·
//     절대 경로·드라이브 문자 거절)로 읽어 src 를 data: URI 로 바꾸고 data-rel-path 는 지운다. 못 읽으면 src="" (skipped).
//   · 없으면 src 가 `data:`·앱 밖 `http(s)://` 일 때만 그대로, 그 밖(asset:·http://asset.localhost·상대 경로·파일 경로·blob:)은
//     src="" (skipped) — **src 로는 절대 파일을 읽지 않는다**. 파일 하나로 어디서나 열리고 앱 내부 주소가 밖으로 새지 않는다.
//
// 정규식 대신 작은 토크나이저(HTML 토크나이저 규칙을 필요한 만큼만): 주석·`<!…>`·원문 요소(script·style·textarea·title …) 안의
// `<img` 글자는 태그가 아니고, 다른 태그의 따옴표 속성 값 안(`title="<img …>"`)도 태그가 아니다 — 브라우저가 그림으로 안 그리는 것은
// 건드리지 않는다. `<image>` 는 브라우저가 `<img>` 로 바꾸므로 같이 본다. 닫히지 않은 채 문자열 끝까지 가는 태그는 브라우저가 버리므로
// 우리도 버린다(그 안의 주소가 남지 않는다). 모든 자르기는 ASCII 구분자 위치에서만 해서 다중 바이트 글자를 가르지 않는다.
//
// ponytail: 고치는 것은 `<img>`(`<image>`) 의 src·srcset 뿐이다 — SVG `<image href>`·`<picture><source srcset>`·CSS `url()`·
// `<video poster>` 는 그대로 둔다. 프런트 렌더(`renderPaperBody`)가 그런 것을 만들지 않아서다. 만들게 되면 이 스캐너에 그 속성을 더한다.
// (보안 경계는 그와 무관하다 — 파일은 data-rel-path 로만, 첨부 루트 안에서만 읽는다.)
use super::{attachment_resolver, ExportDocResult, MAX_IMAGES, MAX_IMAGES_TOTAL_BYTES, MAX_IMAGE_BYTES};
use crate::error::{AppError, AppResult};
use crate::repo::attachments;
use base64::Engine as _;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;

const MB: usize = 1024 * 1024;

/// 상한. 그림 장수·한 장·전체 바이트는 export_hwpx·docx 의 `ImageStore` 와 같은 값이다. 출력은 base64(4/3 배)로 커지므로 따로 막는다 —
/// 넘기게 되는 그림부터 그 자리만 건너뛴다(skipped).
#[derive(Clone, Copy)]
struct Limits {
    input: usize,
    output: usize,
    images: usize,
    image_bytes: u64,
    images_total: usize,
}

const LIMITS: Limits = Limits {
    input: 16 * MB,
    output: 64 * MB,
    images: MAX_IMAGES,
    image_bytes: MAX_IMAGE_BYTES,
    images_total: MAX_IMAGES_TOTAL_BYTES,
};

/// `export_html_inline` 출력(specs `ExportHtmlInlineOutput`) — 그림을 채운 HTML 과 집계.
/// `image_count` 는 data: URI 로 채운 `<img>` 수(같은 그림이 두 번 나오면 두 번), `skipped_images` 는 비운 `<img>` 수.
#[derive(Serialize, Debug)]
pub struct InlinedHtml {
    pub html: String,
    pub image_count: usize,
    pub skipped_images: usize,
}

/// specs/commands/export.yaml `export_html` 본체 — 확장자 → 노트 → 그림 채우기 → tmp→rename. **블로킹**(호출자가 spawn_blocking).
/// `exported_at` 은 찍지 않는다(export_hwpx 와 같다 — 섹션 하나만 내보낼 수도 있어 "노트를 내보냈다"고 단정할 수 없다).
pub fn export_html(
    db: &Mutex<Connection>,
    data_dir: &Path,
    note_id: &str,
    dest_path: &str,
    html: &str,
) -> AppResult<ExportDocResult> {
    require_html_ext(dest_path)?;
    attachments::require_note(&db.lock(), note_id)?;
    let filled = inline_images(data_dir, html)?;
    let written_path = crate::repo::transfer::export::write_atomic(Path::new(dest_path), filled.html.as_bytes(), "html")?;
    Ok(ExportDocResult { written_path, image_count: filled.image_count, skipped_images: filled.skipped_images })
}

/// specs/commands/export.yaml `export_html_inline` 본체 — `export_html` 과 같은 그림 채우기, 파일 대신 문자열(클립보드용).
pub fn export_html_inline(db: &Mutex<Connection>, data_dir: &Path, note_id: &str, html: &str) -> AppResult<InlinedHtml> {
    attachments::require_note(&db.lock(), note_id)?;
    inline_images(data_dir, html)
}

/// 저장 경로는 `.html`·`.htm`(대소문자 무관)이어야 한다 — 저장 대화상자에서 이름을 바꿔 다른 확장자로 HTML 을 쓰는 일을 막는다.
fn require_html_ext(dest_path: &str) -> AppResult<()> {
    match crate::repo::transfer::export::dest_ext_lower(Path::new(dest_path)).as_deref() {
        Some("html" | "htm") => Ok(()),
        _ => Err(AppError::Validation("dest_path must end with .html or .htm".to_string())),
    }
}

/// `<img>` 의 그림을 채운다(파일 머리 주석 참고). 그림 파일은 `data-rel-path` 로만, 첨부 루트 안에서만 읽는다.
pub fn inline_images(data_dir: &Path, html: &str) -> AppResult<InlinedHtml> {
    let resolver = attachment_resolver(data_dir);
    inline_with(html, &resolver, LIMITS)
}

fn inline_with(html: &str, resolve: &dyn Fn(&str) -> Option<Vec<u8>>, lim: Limits) -> AppResult<InlinedHtml> {
    if html.len() > lim.input {
        return Err(AppError::Validation(format!("html is too large to export (max {} MB)", lim.input / MB)));
    }
    let b = html.as_bytes();
    let n = b.len();
    let mut f = Filler { out: String::with_capacity(n), imgs: WebImages::new(resolve, lim), image_count: 0, skipped: 0, lim };
    // html[..copied] 은 이미 out 에 있다 — 고치는 `<img>` 앞에서만 그 사이를 통째로 옮긴다.
    let mut copied = 0;
    let mut p = 0;
    while let Some(off) = b[p..].iter().position(|&c| c == b'<') {
        let lt = p + off;
        let rest = &b[lt..];
        let at = |i: usize| rest.get(i).copied();
        if rest.starts_with(b"<!--") {
            p = comment_end(b, lt);
        } else if matches!(at(1), Some(b'!' | b'?')) {
            p = bogus_comment_end(b, lt + 2);
        } else if at(1) == Some(b'/') {
            match at(2) {
                Some(c) if c.is_ascii_alphabetic() => match parse_tag(b, lt, lt + 2).end {
                    Some(end) => p = end,
                    None => {
                        // 문자열 끝까지 닫히지 않은 태그 — 브라우저처럼 버린다.
                        f.out.push_str(&html[copied..lt]);
                        copied = n;
                        break;
                    }
                },
                Some(b'>') => p = lt + 3,
                Some(_) => p = bogus_comment_end(b, lt + 2),
                None => break,
            }
        } else if at(1).is_some_and(|c| c.is_ascii_alphabetic()) {
            let tag = parse_tag(b, lt, lt + 1);
            let name = &html[tag.name.0..tag.name.1];
            let is_img = name.eq_ignore_ascii_case("img") || name.eq_ignore_ascii_case("image");
            let Some(end) = tag.end else {
                f.out.push_str(&html[copied..lt]);
                copied = n;
                if is_img {
                    f.skipped += 1;
                }
                break;
            };
            if is_img {
                f.out.push_str(&html[copied..lt]);
                f.img(html, &tag, end, n - end);
                copied = end;
            }
            p = match raw_text(name) {
                RawText::No => end,
                RawText::UntilEndTag => find_end_tag(b, end, name.as_bytes()).unwrap_or(n),
                RawText::ToEof => n,
            };
        } else {
            p = lt + 1; // 글자 '<'
        }
    }
    if copied < n {
        f.out.push_str(&html[copied..]);
    }
    Ok(InlinedHtml { html: f.out, image_count: f.image_count, skipped_images: f.skipped })
}

// ── 토크나이저 조각 ──────────────────────────────────────────────────────────

fn is_ws(c: u8) -> bool {
    matches!(c, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

/// `<!--` 로 시작하는 주석의 끝(다음 위치). `<!-->`·`<!--->` 는 바로 닫히고, `-->`·`--!>` 로 닫힌다. 안 닫히면 끝까지.
fn comment_end(b: &[u8], lt: usize) -> usize {
    let s = lt + 4;
    if b[s..].starts_with(b">") {
        return s + 1;
    }
    if b[s..].starts_with(b"->") {
        return s + 2;
    }
    let mut i = s;
    while let Some(off) = b[i..].iter().position(|&c| c == b'-') {
        let d = i + off;
        if b[d..].starts_with(b"-->") {
            return d + 3;
        }
        if b[d..].starts_with(b"--!>") {
            return d + 4;
        }
        i = d + 1;
    }
    b.len()
}

/// `<!DOCTYPE …>`·`<?…>`·`</ …>` 같은 가짜 주석 — 다음 `>` 까지.
fn bogus_comment_end(b: &[u8], from: usize) -> usize {
    b[from..].iter().position(|&c| c == b'>').map_or(b.len(), |off| from + off + 1)
}

/// 태그 하나 — 위치는 모두 `html` 의 바이트 범위(ASCII 구분자 경계라 그대로 잘라 쓸 수 있다).
struct Tag {
    start: usize,
    name: (usize, usize),
    attrs: Vec<Attr>,
    /// `>` 다음 위치. None = 문자열 끝까지 닫히지 않음.
    end: Option<usize>,
    self_closing: bool,
}

struct Attr {
    name: (usize, usize),
    /// 따옴표 안쪽(엔티티 디코딩 전). None = 값 없는 속성.
    value: Option<(usize, usize)>,
    /// 이름부터 값 끝(닫는 따옴표 포함)까지 — 고치지 않는 속성은 이 원문 그대로 다시 쓴다.
    raw: (usize, usize),
}

impl Attr {
    /// 이름이 `name` 인가(HTML 속성 이름은 대소문자를 가리지 않는다).
    fn is(&self, html: &str, name: &str) -> bool {
        html[self.name.0..self.name.1].eq_ignore_ascii_case(name)
    }

    /// 엔티티를 푼 값(값 없는 속성은 빈 글자).
    fn decoded<'h>(&self, html: &'h str) -> Cow<'h, str> {
        decode_entities(self.value.map_or("", |(s, e)| &html[s..e]))
    }
}

/// `<` 위치 `start`, 이름 첫 글자 위치 `name_start` 에서 태그 하나를 읽는다(HTML 토크나이저의 속성 규칙: 따옴표 안의 `>` 는
/// 태그 끝이 아니고, 값 사이 공백이 없어도 다음 속성이 시작된다).
fn parse_tag(b: &[u8], start: usize, name_start: usize) -> Tag {
    let n = b.len();
    let mut p = name_start;
    while p < n && !is_ws(b[p]) && b[p] != b'/' && b[p] != b'>' {
        p += 1;
    }
    let name = (name_start, p);
    let mut attrs = Vec::new();
    loop {
        // 속성 이름 앞 — 공백과 '/' 를 건너뛴다. `>` 바로 앞의 '/' 는 자기 닫힘 표시.
        let mut slash = false;
        while p < n && (is_ws(b[p]) || b[p] == b'/') {
            slash = b[p] == b'/';
            p += 1;
        }
        if p >= n {
            return Tag { start, name, attrs, end: None, self_closing: false };
        }
        if b[p] == b'>' {
            return Tag { start, name, attrs, end: Some(p + 1), self_closing: slash };
        }
        // 속성 이름 — 첫 글자는 '=' 이어도 이름에 든다(토크나이저 규칙).
        let ns = p;
        p += 1;
        while p < n && !is_ws(b[p]) && !matches!(b[p], b'/' | b'>' | b'=') {
            p += 1;
        }
        let ne = p;
        let mut q = p;
        while q < n && is_ws(b[q]) {
            q += 1;
        }
        if q >= n || b[q] != b'=' {
            attrs.push(Attr { name: (ns, ne), value: None, raw: (ns, ne) });
            continue; // p = ne — 공백은 다음 바퀴가 건너뛴다
        }
        q += 1;
        while q < n && is_ws(b[q]) {
            q += 1;
        }
        match b.get(q) {
            None => return Tag { start, name, attrs, end: None, self_closing: false },
            Some(&quote @ (b'"' | b'\'')) => {
                let vs = q + 1;
                let Some(off) = b[vs..].iter().position(|&c| c == quote) else {
                    return Tag { start, name, attrs, end: None, self_closing: false };
                };
                let ve = vs + off;
                p = ve + 1;
                attrs.push(Attr { name: (ns, ne), value: Some((vs, ve)), raw: (ns, p) });
            }
            Some(b'>') => {
                attrs.push(Attr { name: (ns, ne), value: Some((q, q)), raw: (ns, q) });
                return Tag { start, name, attrs, end: Some(q + 1), self_closing: false };
            }
            Some(_) => {
                let vs = q;
                while q < n && !is_ws(b[q]) && b[q] != b'>' {
                    q += 1;
                }
                attrs.push(Attr { name: (ns, ne), value: Some((vs, q)), raw: (ns, q) });
                p = q;
            }
        }
    }
}

enum RawText {
    No,
    UntilEndTag,
    ToEof,
}

/// 안의 글자를 태그로 읽지 않는 요소. `<plaintext>` 는 문서 끝까지 글자다.
fn raw_text(name: &str) -> RawText {
    const UNTIL_END: [&str; 9] = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"];
    if name.eq_ignore_ascii_case("plaintext") {
        RawText::ToEof
    } else if UNTIL_END.iter().any(|t| name.eq_ignore_ascii_case(t)) {
        RawText::UntilEndTag
    } else {
        RawText::No
    }
}

/// `from` 부터 `</name` (대소문자 무시, 뒤가 공백·'/'·'>'·끝) 의 `<` 위치.
fn find_end_tag(b: &[u8], from: usize, name: &[u8]) -> Option<usize> {
    let mut i = from;
    while let Some(off) = b[i..].iter().position(|&c| c == b'<') {
        let lt = i + off;
        let after = lt + 2 + name.len();
        if b.get(lt + 1) == Some(&b'/')
            && b.len() >= after
            && b[lt + 2..after].eq_ignore_ascii_case(name)
            && b.get(after).is_none_or(|&c| is_ws(c) || c == b'/' || c == b'>')
        {
            return Some(lt);
        }
        i = lt + 1;
    }
    None
}

/// 따옴표 안 속성 값의 HTML 엔티티를 한 번에 푼다(`&amp;lt;` → `&lt;`, 두 번 풀지 않는다). 이름 엔티티는 자주 쓰는 여섯 개,
/// 숫자는 `&#N;`·`&#xH;`. 모르는 것은 글자 그대로.
fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match entity(after) {
            Some((c, used)) => {
                out.push(c);
                rest = &after[used..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// `&` 다음 글자들 → (글자, `;` 까지 쓴 바이트 수). `;` 는 12바이트 안에 있어야 한다(긴 글자에서 매번 끝까지 찾지 않게).
fn entity(s: &str) -> Option<(char, usize)> {
    let semi = s.bytes().take(12).position(|c| c == b';')?;
    let name = &s[..semi];
    let c = match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        _ => {
            let num = name.strip_prefix('#')?;
            let code = match num.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => num.parse::<u32>().ok()?,
            };
            char::from_u32(code)?
        }
    };
    Some((c, semi + 1))
}

/// 그대로 둬도 되는 src — `data:` 와 앱 밖 `http(s)://` 만. 앱 내부 주소(`asset:`·`http://asset.localhost`·`ipc.localhost`·
/// 개발 서버 `localhost:1420`·루프백)·상대 경로·파일 경로·`blob:` 은 아니다. URL 파서처럼 앞뒤 C0·공백을 떼고 안쪽 탭·줄바꿈을
/// 지운 뒤 본다. 호스트가 영숫자·`.`·`-` 가 아니면(퍼센트 인코딩·전각 점 같은 우회) 장담할 수 없으므로 비운다.
fn is_web_src(src: &str) -> bool {
    let u: String = src
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect::<String>()
        .to_ascii_lowercase();
    if u.starts_with("data:") {
        return true;
    }
    let Some(rest) = u.strip_prefix("http://").or_else(|| u.strip_prefix("https://")) else {
        return false;
    };
    let authority = rest.trim_start_matches(['/', '\\']).split(['/', '\\', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        host_port.split_inclusive(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let host = host.trim_end_matches('.');
    if host.is_empty() || host == "[::1]" {
        return false;
    }
    if !host.starts_with('[') && !host.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-') {
        return false;
    }
    !(host == "localhost" || host.ends_with(".localhost") || host.starts_with("127.") || host == "0.0.0.0")
}

// ── 그림 ──────────────────────────────────────────────────────────────────────

struct Filler<'a> {
    out: String,
    imgs: WebImages<'a>,
    image_count: usize,
    skipped: usize,
    lim: Limits,
}

impl Filler<'_> {
    /// `<img>` 하나를 `out` 에 쓴다 — 고칠 게 없으면 원문 그대로. `rest_len` = 이 태그 뒤 남은 입력 길이(출력 상한 계산용).
    fn img(&mut self, html: &str, t: &Tag, end: usize, rest_len: usize) {
        let named = |name: &'static str| t.attrs.iter().filter(move |a| a.is(html, name));
        if let Some(rel_attr) = named("data-rel-path").next() {
            let rel = rel_attr.decoded(html).into_owned();
            match self.imgs.get(&rel) {
                // 같은 그림이 여러 번 나오면 data: URI 도 여러 번 들어간다 — 출력 상한은 나올 때마다 센다.
                Some(uri) if self.out.len() + uri.len() + rest_len <= self.lim.output => {
                    self.image_count += 1;
                    write_img(&mut self.out, html, t, Some(uri));
                }
                _ => {
                    self.skipped += 1;
                    write_img(&mut self.out, html, t, Some(""));
                }
            }
            return;
        }
        let src = named("src").next().map(|a| a.decoded(html));
        if src.as_deref().is_some_and(|s| !s.trim_matches(|c: char| c <= ' ').is_empty() && !is_web_src(s)) {
            self.skipped += 1;
            write_img(&mut self.out, html, t, Some(""));
        } else if named("src").count() > 1 || named("srcset").next().is_some() {
            // 두 번째 src(브라우저는 무시)·srcset(브라우저가 src 보다 먼저 쓴다)에 남은 주소를 치운다.
            write_img(&mut self.out, html, t, None);
        } else {
            self.out.push_str(&html[t.start..end]);
        }
    }
}

/// `<img>` 를 다시 쓴다 — `data-rel-path`·`srcset`·두 번째 이후 `src` 는 빼고, 나머지 속성은 원문 그대로. `new_src` 가 Some 이면
/// 첫 `src` 자리(없으면 끝)에 그 값을 쓰고, None 이면 원래 첫 `src` 를 둔다.
fn write_img(out: &mut String, html: &str, t: &Tag, new_src: Option<&str>) {
    let push_src = |out: &mut String, v: &str| {
        out.push_str(" src=\"");
        for c in v.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '"' => out.push_str("&quot;"),
                c => out.push(c),
            }
        }
        out.push('"');
    };
    out.push('<');
    out.push_str(&html[t.name.0..t.name.1]);
    let mut src_done = false;
    for a in &t.attrs {
        if a.is(html, "data-rel-path") || a.is(html, "srcset") {
            continue;
        }
        if a.is(html, "src") {
            if std::mem::replace(&mut src_done, true) {
                continue;
            }
            if let Some(v) = new_src {
                push_src(out, v);
                continue;
            }
        }
        out.push(' ');
        out.push_str(&html[a.raw.0..a.raw.1]);
    }
    if !src_done {
        if let Some(v) = new_src {
            push_src(out, v);
        }
    }
    out.push_str(if t.self_closing { " />" } else { ">" });
}

/// relPath → data: URI. 같은 relPath 는 한 번만 읽는다(실패도 기억한다). 장수·한 장·전체 상한을 넘는 그림은 None.
struct WebImages<'a> {
    resolve: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    lim: Limits,
    uris: Vec<String>,
    by_rel: HashMap<String, Option<usize>>,
    total: usize,
}

impl<'a> WebImages<'a> {
    fn new(resolve: &'a dyn Fn(&str) -> Option<Vec<u8>>, lim: Limits) -> Self {
        WebImages { resolve, lim, uris: Vec::new(), by_rel: HashMap::new(), total: 0 }
    }

    fn get(&mut self, rel: &str) -> Option<&str> {
        let idx = match self.by_rel.get(rel) {
            Some(cached) => *cached,
            None => {
                let loaded = self.load(rel);
                self.by_rel.insert(rel.to_string(), loaded);
                loaded
            }
        };
        idx.map(|i| self.uris[i].as_str())
    }

    fn load(&mut self, rel: &str) -> Option<usize> {
        if self.uris.len() >= self.lim.images {
            return None;
        }
        let bytes = (self.resolve)(rel)?;
        if bytes.len() as u64 > self.lim.image_bytes {
            return None;
        }
        let (mime, bytes) = sniff_web(bytes)?;
        if self.total + bytes.len() > self.lim.images_total {
            return None;
        }
        self.total += bytes.len();
        let mut uri = String::with_capacity(bytes.len() / 3 * 4 + 40);
        uri.push_str("data:");
        uri.push_str(mime);
        uri.push_str(";base64,");
        base64::engine::general_purpose::STANDARD.encode_string(&bytes, &mut uri);
        self.uris.push(uri);
        Some(self.uris.len() - 1)
    }
}

/// 그림 바이트 → (mime, 바이트). 브라우저가 그리는 png·jpeg·gif·webp·bmp 는 그대로(export_hwpx 와 달리 webp 를 png 로 바꾸지
/// 않는다 — 브라우저는 webp 를 그린다), tiff 는 브라우저가 못 그려 png 로(`sniff_image` 의 변환·화소 상한 그대로), svg 는 글자
/// 머리로 판별한다(image 크레이트가 모른다 — `<img>` 안의 svg 는 스크립트가 돌지 않는다). 그 밖·깨진 파일은 None.
fn sniff_web(bytes: Vec<u8>) -> Option<(&'static str, Vec<u8>)> {
    use image::ImageFormat as F;
    if is_svg(&bytes) {
        return Some(("image/svg+xml", bytes));
    }
    let fmt = image::guess_format(&bytes).ok()?;
    let mime = match fmt {
        F::Png => "image/png",
        F::Jpeg => "image/jpeg",
        F::Gif => "image/gif",
        F::WebP => "image/webp",
        F::Bmp => "image/bmp",
        F::Tiff => {
            let (_, png, _, _) = super::sniff_image(bytes)?;
            return Some(("image/png", png));
        }
        _ => return None,
    };
    let (w, h) = image::ImageReader::with_format(Cursor::new(&bytes), fmt).into_dimensions().ok()?;
    (w > 0 && h > 0).then_some((mime, bytes))
}

/// 머리(BOM·공백·`<?xml …?>`·주석·DOCTYPE 를 지난 뒤)의 첫 요소가 `<svg` 인가.
fn is_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let mut s = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    loop {
        while let [c, rest @ ..] = s {
            if !is_ws(*c) {
                break;
            }
            s = rest;
        }
        let close: &[u8] = if s.starts_with(b"<?") {
            b"?>"
        } else if s.starts_with(b"<!--") {
            b"-->"
        } else if s.starts_with(b"<!") {
            b">"
        } else {
            break;
        };
        match s.windows(close.len()).position(|w| w == close) {
            Some(i) => s = &s[i + close.len()..],
            None => return false,
        }
    }
    s.len() > 4 && s[..4].eq_ignore_ascii_case(b"<svg") && (is_ws(s[4]) || s[4] == b'>' || s[4] == b'/')
}

#[cfg(test)]
mod tests {
    use super::super::testutil::png_bytes;
    use super::*;
    use std::cell::RefCell;

    const BIG: Limits = Limits { input: 16 * MB, output: 64 * MB, images: 200, image_bytes: 20 * MB as u64, images_total: 64 * MB };

    /// 이름 → 바이트 표로 해석기를 만든다. 불린 relPath 를 `calls` 에 남긴다(같은 그림 한 번만 읽기 · src 로 읽지 않기 검사용).
    fn fill(html: &str, files: &[(&str, Vec<u8>)], lim: Limits) -> (InlinedHtml, Vec<String>) {
        let calls = RefCell::new(Vec::new());
        let resolve = |rel: &str| {
            calls.borrow_mut().push(rel.to_string());
            files.iter().find(|(n, _)| *n == rel).map(|(_, b)| b.clone())
        };
        let out = inline_with(html, &resolve, lim).unwrap();
        (out, calls.into_inner())
    }

    fn png_uri() -> String {
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png_bytes()))
    }

    fn encoded(img: &image::DynamicImage, fmt: image::ImageFormat) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, fmt).unwrap();
        buf.into_inner()
    }

    #[test]
    fn data_rel_path_becomes_a_data_uri_and_the_attribute_is_removed() {
        let files = [("n1/a.png", png_bytes())];
        let (r, calls) = fill(r#"<p>앞 <img data-rel-path="n1/a.png" src="" alt="그림" style="width: 50%"> 뒤</p>"#, &files, BIG);
        assert_eq!(r.html, format!(r#"<p>앞 <img src="{}" alt="그림" style="width: 50%"> 뒤</p>"#, png_uri()));
        assert_eq!((r.image_count, r.skipped_images), (1, 0));
        assert_eq!(calls, vec!["n1/a.png"]);
        // src 가 없으면 끝에 붙인다 · 기존 asset src 는 대체한다.
        let (r, _) = fill(r#"<img alt="x" data-rel-path="n1/a.png">"#, &files, BIG);
        assert_eq!(r.html, format!(r#"<img alt="x" src="{}">"#, png_uri()));
        let (r, _) = fill(r#"<img src="http://asset.localhost/C%3A/x.png" data-rel-path="n1/a.png">"#, &files, BIG);
        assert_eq!(r.html, format!(r#"<img src="{}">"#, png_uri()));
    }

    #[test]
    fn the_same_image_twice_is_read_once_and_embedded_at_both_places() {
        let files = [("n1/a.png", png_bytes())];
        let (r, calls) = fill(r#"<img data-rel-path="n1/a.png"><img data-rel-path="n1/a.png">"#, &files, BIG);
        assert_eq!(calls, vec!["n1/a.png"]);
        assert_eq!((r.image_count, r.skipped_images), (2, 0));
        assert_eq!(r.html.matches(&png_uri()).count(), 2);
    }

    #[test]
    fn unreadable_images_are_emptied_and_counted_without_leaving_the_rel_path() {
        let files = [("n1/note.txt", b"just text".to_vec()), ("n1/broken.png", vec![0x89, b'P', b'N', b'G', 0, 0])];
        for rel in ["n1/missing.png", "n1/note.txt", "n1/broken.png", ""] {
            let (r, _) = fill(&format!(r#"<img data-rel-path="{rel}" src="">"#), &files, BIG);
            assert_eq!(r.html, r#"<img src="">"#, "{rel:?}");
            assert_eq!((r.image_count, r.skipped_images), (0, 1), "{rel:?}");
        }
    }

    /// 실제 해석기(첨부 루트 안에서만)를 지난다 — 엔티티로 감춘 `../` 도 디코딩한 뒤 같은 검사에 걸린다.
    #[test]
    fn rel_paths_go_through_the_attachment_resolver_and_cannot_escape_the_attachments_root() {
        let data = tempfile::tempdir().unwrap();
        let att = crate::db::attachments_dir(data.path());
        std::fs::create_dir_all(att.join("n1")).unwrap();
        std::fs::write(att.join("n1/a&b.png"), png_bytes()).unwrap();
        std::fs::write(data.path().join("secret.png"), png_bytes()).unwrap();
        let ok = inline_images(data.path(), r#"<img data-rel-path="n1/a&amp;b.png">"#).unwrap();
        assert_eq!((ok.image_count, ok.skipped_images), (1, 0), "{}", ok.html);
        let absolute = data.path().join("secret.png").to_string_lossy().into_owned();
        for rel in [
            "../secret.png",
            "n1/../../secret.png",
            "n1/..&#47;..&#47;secret.png",
            "n1/&#x2E;&#x2E;/../secret.png",
            "/secret.png",
            "C:x.png",
            "C:/Windows/win.ini",
            "\\\\server\\share\\a.png",
            &absolute,
        ] {
            let r = inline_images(data.path(), &format!(r#"<img data-rel-path="{rel}">"#)).unwrap();
            assert_eq!((r.image_count, r.skipped_images), (0, 1), "{rel:?}");
            assert_eq!(r.html, r#"<img src="">"#, "{rel:?}");
        }
    }

    /// data-rel-path 가 없는 그림: 앱 내부 주소·상대 경로·파일 경로는 비우고(해석기를 부르지 않는다), data:·http(s) 는 원문 그대로.
    #[test]
    fn src_without_rel_path_is_never_read_internal_addresses_are_emptied_and_web_urls_are_kept() {
        for src in [
            "asset://localhost/C%3A%2Fx.png",
            "http://asset.localhost/C%3A/x.png",
            "HTTPS://Asset.LocalHost./x.png",
            "http://ipc.localhost/x",
            "http://localhost:1420/x.png",
            "http://127.0.0.1/x.png",
            "http://[::1]/x.png",
            "http://user@asset.localhost/x.png",
            "http://asset%2Elocalhost/x.png",
            "http:\\\\asset.localhost\\x.png",
            "http:asset.localhost/x.png",
            " java\nscript:alert(1)",
            "images/a.png",
            "/abs/a.png",
            "C:\\Users\\me\\a.png",
            "file:///C:/a.png",
            "blob:http://tauri.localhost/1234",
            "//cdn.example.com/a.png",
        ] {
            let html = format!(r#"<img src="{}" alt="a">"#, src.replace('"', "&quot;"));
            let (r, calls) = fill(&html, &[], BIG);
            assert_eq!(r.html, r#"<img src="" alt="a">"#, "{src:?}");
            assert_eq!((r.image_count, r.skipped_images), (0, 1), "{src:?}");
            assert!(calls.is_empty(), "src must never be resolved as a file: {src:?}");
        }
        for src in ["https://example.com/a.png", "HTTP://EXAMPLE.COM/A.PNG", "data:image/png;base64,AAAA", "https://xn--hi-ad.kr/a.png?x=1&amp;y=2", ""] {
            let html = format!(r#"<IMG SRC="{src}" alt=a>"#);
            let (r, calls) = fill(&html, &[], BIG);
            assert_eq!(r.html, html, "{src:?} must be kept verbatim");
            assert_eq!((r.image_count, r.skipped_images, calls.len()), (0, 0, 0), "{src:?}");
        }
    }

    #[test]
    fn attribute_case_quoting_and_entities_are_handled_like_a_browser() {
        let files = [("n1/a b.png", png_bytes())];
        // 대소문자 · 작은따옴표 · 따옴표 없는 값 · 값 사이 공백 없음 · 따옴표 안의 '>' · 엔티티.
        let cases = [
            r#"<IMG DATA-REL-PATH='n1/a b.png' SRC=asset:x ALT='1 > 0'>"#,
            r#"<img alt="1 > 0"data-rel-path="n1/a&#32;b.png"src=''>"#,
            "<img\ndata-rel-path = \"n1/a&#x20;b.png\"\tsrc=asset:x />",
        ];
        for html in cases {
            let (r, _) = fill(html, &files, BIG);
            assert_eq!((r.image_count, r.skipped_images), (1, 0), "{html}");
            assert!(r.html.contains(&png_uri()), "{html}");
            assert!(!r.html.to_ascii_lowercase().contains("data-rel-path") && !r.html.contains("asset:"), "{}", r.html);
        }
        let (r, _) = fill(cases[0], &files, BIG);
        assert_eq!(r.html, format!(r#"<IMG src="{}" ALT='1 > 0'>"#, png_uri()));
        let (r, _) = fill(cases[2], &files, BIG);
        assert!(r.html.ends_with(" />"), "{}", r.html);
        // 엔티티는 한 번만 푼다 — `&amp;lt;` 는 `&lt;` 라는 글자(없는 파일)이지 `<` 가 아니다.
        let calls = RefCell::new(Vec::new());
        let resolve = |rel: &str| {
            calls.borrow_mut().push(rel.to_string());
            None
        };
        inline_with(r#"<img data-rel-path="a&amp;lt;b&#xAC00;&unknown;&#;">"#, &resolve, BIG).unwrap();
        assert_eq!(calls.into_inner(), vec!["a&lt;b가&unknown;&#;"]);
    }

    #[test]
    fn duplicate_src_and_srcset_are_dropped_so_no_internal_address_survives() {
        let (r, _) = fill(r#"<img src="https://e.com/a.png" src="asset://x" srcset="asset://y 2x">"#, &[], BIG);
        assert_eq!(r.html, r#"<img src="https://e.com/a.png">"#);
        assert_eq!((r.image_count, r.skipped_images), (0, 0));
        let files = [("n/a.png", png_bytes())];
        let (r, _) = fill(r#"<img data-rel-path="n/a.png" data-rel-path="n/x.png" src="a" src="b" srcset="c">"#, &files, BIG);
        assert_eq!(r.html, format!(r#"<img src="{}">"#, png_uri()));
    }

    /// 브라우저가 그림으로 그리지 않는 곳의 `<img` 글자는 건드리지 않는다. `<image>` 는 브라우저가 `<img>` 로 바꾸므로 같이 본다.
    #[test]
    fn img_text_inside_comments_raw_text_and_other_attributes_is_not_a_tag() {
        let untouched = [
            r#"<!-- <img src="asset://x"> --><p>a</p>"#,
            r#"<!--><img src="asset://x" alt="after abrupt comment is real">"#,
            r#"<script>var s = '<img src="asset://x">';</script>"#,
            r#"<style>/* <img src=asset://x> */ p { color: red }</style>"#,
            r#"<textarea><img src="asset://x"></textarea>"#,
            r#"<TITLE><img src=asset://x></title >"#,
            r#"<a title="<img src=asset://x>">링크</a>"#,
            r#"<imgx src="asset://x"><imagex src="asset://y">"#,
            r#"<!DOCTYPE html><?xml x?></ img src=asset://x>"#,
            "a < b <3 </> 끝",
        ];
        for html in untouched {
            let (r, _) = fill(html, &[], BIG);
            if html.starts_with("<!-->") {
                // `<!-->` 는 그 자리에서 닫힌 주석이라 뒤의 img 는 진짜 태그다.
                assert_eq!(r.html, r#"<!--><img src="" alt="after abrupt comment is real">"#);
                continue;
            }
            assert_eq!(r.html, html);
            assert_eq!(r.skipped_images, 0, "{html}");
        }
        let (r, _) = fill(r#"<image src="asset://x"><script>x</script><img src="asset://y">"#, &[], BIG);
        assert_eq!(r.html, r#"<image src=""><script>x</script><img src="">"#);
        assert_eq!(r.skipped_images, 2);
    }

    /// 닫히지 않은 채 끝나는 태그는 브라우저처럼 버린다(그 안의 주소가 남지 않는다) — 어떤 접두사에서도 panic 이 없다.
    #[test]
    fn broken_and_truncated_html_never_panics_and_never_keeps_an_internal_address() {
        let files = [("n1/a.png", png_bytes())];
        for (html, want, skipped) in [
            (r#"<p>a</p><img data-rel-path="n1/a.png" src="asset:x"#, "<p>a</p>", 1),
            ("<p>a</p><img", "<p>a</p>", 1),
            (r#"<p>a</p><img src='asset:x"#, "<p>a</p>", 1),
            ("<p>a</p><img src=", "<p>a</p>", 1),
            ("<p>a</p><span title=\"x", "<p>a</p>", 0),
            ("<p>a</p></span", "<p>a</p>", 0),
            ("<p>a</p><", "<p>a</p><", 0),
            ("<p>a</p><!-- 안 닫힌 주석 <img src=asset:x>", "<p>a</p><!-- 안 닫힌 주석 <img src=asset:x>", 0),
        ] {
            let (r, _) = fill(html, &files, BIG);
            assert_eq!(r.html, want, "{html}");
            assert_eq!(r.skipped_images, skipped, "{html}");
        }
        let sample = r#"<!doctype html><html><head><title>t</title><style>p{}</style></head><body><p class="가">한글 <img data-rel-path="n1/a.png" src="" alt='a "b"'><IMG SRC=asset:x/></p><!-- c --><a href="https://e.com?a=1&amp;b=2">l</a></body></html>"#;
        let mut cut = 0;
        while cut <= sample.len() {
            if sample.is_char_boundary(cut) {
                let (r, _) = fill(&sample[..cut], &files, BIG);
                assert!(!r.html.contains("asset:") && !r.html.contains("data-rel-path"), "prefix {cut}: {}", r.html);
            }
            cut += 1;
        }
        let (r, _) = fill(sample, &files, BIG);
        assert_eq!((r.image_count, r.skipped_images), (1, 1));
        // `SRC=asset:x/>` 의 '/' 는 따옴표 없는 값의 일부라 자기 닫힘이 아니다(토크나이저 규칙).
        assert!(r.html.contains("한글 <img src=\"data:image/png;base64,") && r.html.contains("<IMG src=\"\"></p>"), "{}", r.html);
    }

    #[test]
    fn formats_are_sniffed_from_the_content_webp_stays_webp_tiff_becomes_png_and_svg_is_text() {
        let rgb = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 2, image::Rgb([9, 9, 9])));
        let rgba = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(3, 2, image::Rgba([9, 9, 9, 255])));
        let jpg = encoded(&rgb, image::ImageFormat::Jpeg);
        let gif = encoded(&rgba, image::ImageFormat::Gif);
        let bmp = encoded(&rgb, image::ImageFormat::Bmp);
        let tif = encoded(&rgb, image::ImageFormat::Tiff);
        let webp = encoded(&rgba, image::ImageFormat::WebP);
        let svg = b"\xEF\xBB\xBF <?xml version=\"1.0\"?>\n<!-- logo --><!DOCTYPE svg><svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
        for (bytes, mime) in [(jpg.clone(), "image/jpeg"), (gif, "image/gif"), (bmp, "image/bmp"), (webp.clone(), "image/webp"), (tif, "image/png"), (svg.clone(), "image/svg+xml")] {
            let (got_mime, got) = sniff_web(bytes.clone()).unwrap_or_else(|| panic!("{mime} must be accepted"));
            assert_eq!(got_mime, mime);
            if mime != "image/png" {
                assert_eq!(got, bytes, "{mime} is embedded as-is");
            } else {
                assert_eq!(image::guess_format(&got).unwrap(), image::ImageFormat::Png);
            }
        }
        for bad in [b"<html><svg></svg></html>".to_vec(), b"<svgx/>".to_vec(), b"hello".to_vec(), vec![], jpg[..20].to_vec()] {
            assert!(sniff_web(bad.clone()).is_none(), "{bad:?}");
        }
        let (r, _) = fill(r#"<img data-rel-path="s.svg">"#, &[("s.svg", svg.clone())], BIG);
        assert!(r.html.starts_with(r#"<img src="data:image/svg+xml;base64,"#), "{}", r.html);
    }

    #[test]
    fn limits_input_size_image_count_image_bytes_and_output_size() {
        let files = [("a", png_bytes()), ("b", png_bytes()), ("c", png_bytes())];
        let uri_len = png_uri().len();
        // 입력 상한 → VALIDATION.
        let small = Limits { input: 10, ..BIG };
        assert!(matches!(inline_with("<p>12345678901</p>", &|_| None, small), Err(AppError::Validation(_))));
        // 장수 상한: 서로 다른 그림 둘째부터 건너뛴다(이미 넣은 그림의 반복은 된다).
        let one = Limits { images: 1, ..BIG };
        let (r, _) = fill(r#"<img data-rel-path="a"><img data-rel-path="b"><img data-rel-path="a">"#, &files, one);
        assert_eq!((r.image_count, r.skipped_images), (2, 1));
        // 한 장 바이트 상한 · 전체 바이트 상한.
        let tiny = Limits { image_bytes: png_bytes().len() as u64 - 1, ..BIG };
        let (r, _) = fill(r#"<img data-rel-path="a">"#, &files, tiny);
        assert_eq!((r.image_count, r.skipped_images), (0, 1));
        let total = Limits { images_total: png_bytes().len() * 2 - 1, ..BIG };
        let (r, _) = fill(r#"<img data-rel-path="a"><img data-rel-path="b">"#, &files, total);
        assert_eq!((r.image_count, r.skipped_images), (1, 1));
        // 출력 상한: 둘째 자리(같은 그림이라도)부터 넘기게 되면 그 자리만 비운다 — 출력은 상한 안이다.
        let html = r#"<img data-rel-path="a"><img data-rel-path="a"><p>끝</p>"#;
        let out = Limits { output: uri_len * 2, ..BIG };
        let (r, _) = fill(html, &files, out);
        assert_eq!((r.image_count, r.skipped_images), (1, 1));
        assert!(r.html.len() <= out.output && r.html.ends_with("<img src=\"\"><p>끝</p>"), "{}", r.html);
    }

    // ── export_html · export_html_inline — DB · 파일 ──────────────────────

    fn seeded() -> (tempfile::TempDir, Mutex<Connection>, String) {
        let data = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(data.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let note_id = crate::repo::notes::create(&mut conn, &folder_id, None, None).unwrap().note.id;
        (data, Mutex::new(conn), note_id)
    }

    #[test]
    fn export_html_validates_the_extension_and_note_then_writes_atomically_without_stamping_exported_at() {
        let (data, db, note_id) = seeded();
        let src = data.path().join("pic.png");
        std::fs::write(&src, png_bytes()).unwrap();
        let rel = attachments::add_file(&mut db.lock(), data.path(), &note_id, &src.to_string_lossy()).unwrap().rel_path.unwrap();
        let html = format!(r#"<!doctype html><p><img data-rel-path="{rel}" src=""><img src="asset://x"></p>"#);
        let out = tempfile::tempdir().unwrap();
        for bad in ["a.txt", "a", "a.html.md", "", "a.xhtml"] {
            let dest = out.path().join(bad).to_string_lossy().into_owned();
            let dest = if bad.is_empty() { String::new() } else { dest };
            assert!(matches!(export_html(&db, data.path(), &note_id, &dest, &html), Err(AppError::Validation(_))), "{bad:?}");
        }
        let dest = out.path().join("sub").join("문서.HTML");
        assert!(matches!(export_html(&db, data.path(), "no-such-note", &dest.to_string_lossy(), &html), Err(AppError::NotFound(_))));
        assert!(!dest.exists());
        let res = export_html(&db, data.path(), &note_id, &dest.to_string_lossy(), &html).unwrap();
        assert_eq!((res.image_count, res.skipped_images), (1, 1));
        assert_eq!(res.written_path, dest.to_string_lossy());
        let written = std::fs::read_to_string(&dest).unwrap();
        assert!(written.starts_with("<!doctype html><p><img src=\"data:image/png;base64,") && written.ends_with(r#"<img src=""></p>"#), "{written}");
        let left: Vec<String> = std::fs::read_dir(dest.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec!["문서.HTML".to_string()]);
        assert!(export_html(&db, data.path(), &note_id, &out.path().join("b.htm").to_string_lossy(), "<p>x</p>").is_ok());
        // Windows 는 이름 끝 `.`·공백을 버린다 — `c.html.` 은 .html 로 본다(export_note 의 .html 거절과 같은 판정).
        assert!(export_html(&db, data.path(), &note_id, &out.path().join("c.html. ").to_string_lossy(), "<p>x</p>").is_ok());
        // 폴더를 고르면 rename 실패로 tmp 가 남는 대신 VALIDATION — 폴더 안에 `.tmp-*` 가 생기지 않는다.
        let folder = out.path().join("폴더.html");
        std::fs::create_dir(&folder).unwrap();
        assert!(matches!(export_html(&db, data.path(), &note_id, &folder.to_string_lossy(), "<p>x</p>"), Err(AppError::Validation(_))));
        assert!(std::fs::read_dir(out.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".tmp-")));
        let exported: Option<String> = db.lock().query_row("SELECT exported_at FROM notes WHERE id=?1", [&note_id], |r| r.get(0)).unwrap();
        assert!(exported.is_none());
    }

    #[test]
    fn export_html_inline_returns_the_filled_html_and_checks_the_note() {
        let (data, db, note_id) = seeded();
        assert!(matches!(export_html_inline(&db, data.path(), "no-such-note", "<p/>"), Err(AppError::NotFound(_))));
        let r = export_html_inline(&db, data.path(), &note_id, r#"<p style="color: red">a<img src="asset://x"></p>"#).unwrap();
        assert_eq!(r.html, r#"<p style="color: red">a<img src=""></p>"#);
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "html": r#"<p style="color: red">a<img src=""></p>"#, "image_count": 0, "skipped_images": 1 })
        );
    }
}
