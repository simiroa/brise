// repo: doc_export::testutil — 두 작성기(HWPX · DOCX)의 테스트가 같이 쓰는 픽스처와 XML 검사 도구 (W4-RE 에서 hwpx 테스트에서 올림)
//
// `#[cfg(test)]` 전용. 같은 문서·같은 도구로 두 형식을 보면 "한쪽만 빠뜨린" 회귀가 드러난다.
use super::DocExportSection;
use quick_xml::events::Event;
use serde_json::{json, Value};
use std::io::{Cursor, Read};

/// 실제 `createMarkdownEditor(...).getJSON()` 모양의 덤프(제목·정렬·들여쓰기·마크·링크·목록·할 일·코드·인용·접기·병합 표·중첩 표·그림).
pub(crate) const REAL_PM: &str = r##"{"type":"doc","content":[{"type":"heading","attrs":{"level":1,"textAlign":"left","indent":0},"content":[{"type":"text","text":"제목 1"}]},{"type":"heading","attrs":{"level":2,"textAlign":"center","indent":0},"content":[{"type":"text","text":"가운데 제목"}]},{"type":"paragraph","attrs":{"textAlign":"justify","indent":2},"content":[{"type":"text","text":"양쪽 "},{"type":"text","marks":[{"type":"bold"}],"text":"굵게"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"italic"}],"text":"기울임"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"underline"}],"text":"밑줄"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"strike"}],"text":"취소"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"highlight"}],"text":"형광"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#ff0000"}}],"text":"빨강"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"rgb(0, 128, 0)"}}],"text":"초록"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"link","attrs":{"href":"https://example.com/a?b=1&c=2","target":"_blank","rel":"noopener noreferrer nofollow","class":null,"title":null}}],"text":"링크"},{"type":"text","text":" "},{"type":"text","marks":[{"type":"code"}],"text":"code"},{"type":"hardBreak"},{"type":"text","text":"다음줄"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"가"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"가1"}]}]}]}]},{"type":"listItem","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"나"}]}]}]},{"type":"orderedList","attrs":{"start":3,"type":null},"content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"하나"}]},{"type":"orderedList","attrs":{"start":1,"type":null},"content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"중첩"}]}]}]}]}]},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"done"}]}]},{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"todo"}]}]}]},{"type":"codeBlock","attrs":{"language":"ts"},"content":[{"type":"text","text":"const a = 1;\n  if (a) {}"}]},{"type":"blockquote","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"인용"}]}]},{"type":"horizontalRule"},{"type":"details","content":[{"type":"detailsSummary","content":[{"type":"text","text":"요약"}]},{"type":"detailsContent","content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"내용"}]}]}]},{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":2,"rowspan":1,"colwidth":[100,100],"align":null,"backgroundColor":"rgb(255, 230, 153)"},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"AB"}]}]},{"type":"tableHeader","attrs":{"colspan":1,"rowspan":1,"colwidth":[100],"align":null,"backgroundColor":null},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"C"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":2,"colwidth":[100],"align":null,"backgroundColor":null},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"1"}]}]},{"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":[100],"align":null,"backgroundColor":null},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"2"}]}]},{"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":[100],"align":null,"backgroundColor":null},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"3"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":[100],"align":null,"backgroundColor":null},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"5"}]}]},{"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":[100],"align":null,"backgroundColor":null},"content":[{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":null,"align":null,"backgroundColor":null},"content":[{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"text","text":"중첩표"}]}]}]}]}]}]}]},{"type":"paragraph","attrs":{"textAlign":"left","indent":0},"content":[{"type":"image","attrs":{"src":"n1/ab-pic.png","alt":"그림","title":null,"width":"70%","height":null,"relPath":"n1/ab-pic.png"}},{"type":"text","text":" 텍스트"}]}]}"##;

pub(crate) fn no_images(_: &str) -> Option<Vec<u8>> {
    None
}

pub(crate) fn png_bytes() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(8, 6, image::Rgb([200, 30, 30]));
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    buf.into_inner()
}

pub(crate) fn sec(name: &str, content: Vec<Value>) -> DocExportSection {
    DocExportSection { name: name.to_string(), doc: json!({ "type": "doc", "content": content }) }
}

pub(crate) fn p(text: &str) -> Value {
    json!({ "type": "paragraph", "attrs": { "textAlign": "left", "indent": 0 }, "content": [{ "type": "text", "text": text }] })
}

pub(crate) fn mark(name: &str) -> Value {
    json!({ "type": name })
}

pub(crate) fn image_node(rel: Option<&str>, alt: &str, width: &str) -> Value {
    json!({ "type": "image", "attrs": { "src": rel, "relPath": rel, "alt": alt, "title": null, "width": width } })
}

pub(crate) fn real_section() -> DocExportSection {
    DocExportSection { name: "본문".to_string(), doc: serde_json::from_str(REAL_PM).unwrap() }
}

pub(crate) fn real_resolver(rel: &str) -> Option<Vec<u8>> {
    (rel == "n1/ab-pic.png").then(png_bytes)
}

// ── 표 ────────────────────────────────────────────────────────────────────────

pub(crate) fn tcell(text: &str, colspan: u32, rowspan: u32, colwidth: Value) -> Value {
    json!({ "type": "tableCell", "attrs": { "colspan": colspan, "rowspan": rowspan, "colwidth": colwidth, "backgroundColor": null }, "content": [p(text)] })
}

pub(crate) fn trow(cells: Vec<Value>) -> Value {
    json!({ "type": "tableRow", "content": cells })
}

pub(crate) fn table_of(rows: Vec<Value>) -> Value {
    json!({ "type": "table", "content": rows })
}

// ── zip · XML 검사 ────────────────────────────────────────────────────────────

pub(crate) fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut ar = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..ar.len())
        .map(|i| {
            let mut f = ar.by_index(i).unwrap();
            let mut v = Vec::new();
            f.read_to_end(&mut v).unwrap();
            (f.name().unwrap().to_string(), v)
        })
        .collect()
}

pub(crate) fn part(bytes: &[u8], name: &str) -> String {
    let e = entries(bytes);
    let (_, v) = e.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no entry {name}"));
    String::from_utf8(v.clone()).unwrap()
}

/// XML 이벤트 — 시작(로컬 이름, 속성들) · 끝(로컬 이름). 네임스페이스 접두사는 떼어 낸다(`w:val` → `val`).
pub(crate) enum Ev<'a> {
    Start(&'a str, &'a [(String, String)]),
    End(&'a str),
}

/// XML 을 끝까지 읽으며 시작·끝 이벤트를 콜백에 준다 — 잘 형성되지 않았으면 panic.
pub(crate) fn scan(xml: &str, mut f: impl FnMut(Ev)) {
    let mut r = quick_xml::Reader::from_str(xml);
    r.config_mut().expand_empty_elements = true;
    let decoder = r.decoder();
    let mut depth = 0i32;
    loop {
        match r.read_event().expect("XML must be well-formed") {
            Event::Eof => break,
            Event::Start(e) => {
                depth += 1;
                let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                let attrs: Vec<(String, String)> = e
                    .attributes()
                    .map(|a| {
                        let a = a.expect("attribute must be well-formed");
                        (
                            String::from_utf8_lossy(a.key.local_name().as_ref()).into_owned(),
                            a.decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder).unwrap().into_owned(),
                        )
                    })
                    .collect();
                f(Ev::Start(&name, &attrs));
            }
            Event::End(e) => {
                depth -= 1;
                f(Ev::End(&String::from_utf8_lossy(e.local_name().as_ref())));
            }
            _ => {}
        }
    }
    assert_eq!(depth, 0, "unbalanced XML");
}

/// 시작 이벤트만 — (로컬 이름, 속성들).
pub(crate) fn walk(xml: &str, mut f: impl FnMut(&str, &[(String, String)])) {
    scan(xml, |ev| {
        if let Ev::Start(n, a) = ev {
            f(n, a);
        }
    });
}

pub(crate) fn attr_vals(xml: &str, element: &str, key: &str) -> Vec<String> {
    let mut v = Vec::new();
    walk(xml, |n, a| {
        if n == element {
            if let Some((_, val)) = a.iter().find(|(k, _)| k == key) {
                v.push(val.clone());
            }
        }
    });
    v
}

pub(crate) fn count(xml: &str, element: &str) -> usize {
    let mut n = 0;
    walk(xml, |name, _| {
        if name == element {
            n += 1;
        }
    });
    n
}

// ── 샘플(오너가 뷰어로 열어 보는 파일) ─────────────────────────────────────────

fn text(t: &str, marks: Vec<Value>) -> Value {
    json!({ "type": "text", "marks": marks, "text": t })
}

fn para(align: &str, nodes: Vec<Value>) -> Value {
    json!({ "type": "paragraph", "attrs": { "textAlign": align, "indent": 0 }, "content": nodes })
}

fn heading(lvl: u32, t: &str) -> Value {
    json!({ "type": "heading", "attrs": { "level": lvl, "textAlign": "left", "indent": 0 }, "content": [text(t, vec![])] })
}

/// 샘플 대표 문서(세로, 이력서식 병합 표 + 제목 + 본문 + 목록, 그림 없음) — 두 형식의 `write_sample` 이 같이 쓴다. `label` = 문장에 들어갈 형식 이름.
pub(crate) fn sample_main(label: &str) -> DocExportSection {
    let cell = |ty: &str, cs: u32, rs: u32, w: Value, bg: Value, nodes: Vec<Value>| {
        json!({ "type": ty, "attrs": { "colspan": cs, "rowspan": rs, "colwidth": w, "backgroundColor": bg }, "content": nodes })
    };
    let c = |t: &str| vec![para("left", vec![text(t, vec![])])];
    let n = Value::Null;
    let resume = json!({ "type": "table", "content": [
        { "type": "tableRow", "content": [cell("tableHeader", 4, 1, json!([90, 140, 90, 140]), json!("rgb(221, 235, 247)"), vec![para("center", vec![text("이 력 서", vec![])])])] },
        { "type": "tableRow", "content": [
            cell("tableCell", 1, 3, json!([90]), json!("#F2F2F2"), vec![para("center", vec![text("사진", vec![])])]),
            cell("tableHeader", 1, 1, json!([140]), n.clone(), c("성명")),
            cell("tableCell", 2, 1, json!([90, 140]), n.clone(), c("홍길동")),
        ] },
        { "type": "tableRow", "content": [cell("tableHeader", 1, 1, n.clone(), n.clone(), c("생년월일")), cell("tableCell", 2, 1, n.clone(), n.clone(), c("1990. 1. 1."))] },
        { "type": "tableRow", "content": [cell("tableHeader", 1, 1, n.clone(), n.clone(), c("연락처")), cell("tableCell", 1, 1, n.clone(), n.clone(), c("010-0000-0000")), cell("tableCell", 1, 1, n.clone(), n.clone(), c("hong@example.com"))] },
        { "type": "tableRow", "content": [
            cell("tableHeader", 1, 2, json!([90]), n.clone(), c("경력")),
            cell("tableCell", 3, 1, json!([140, 90, 140]), n.clone(), vec![para("left", vec![text("2019 – 2024  Brise 개발", vec![mark("bold")])]), para("left", vec![text("노트 앱 데이터 계층과 내보내기 기능을 만들었다.", vec![])])]),
        ] },
        { "type": "tableRow", "content": [cell("tableCell", 3, 1, n.clone(), json!("#FFF2CC"), c("2015 – 2019  기록 도구 스타트업 — 검색·동기화"))] },
    ] });
    let item = |t: &str| json!({ "type": "listItem", "content": [para("left", vec![text(t, vec![])])] });
    let nested = |t: &str, inner: Value| json!({ "type": "listItem", "content": [para("left", vec![text(t, vec![])]), inner] });
    let content = vec![
        heading(1, "문서 내보내기 샘플"),
        para("justify", vec![
            text(&format!("이 문서는 Brise 가 만든 {label} 입니다. "), vec![]),
            text("굵게", vec![mark("bold")]), text(" · ", vec![]),
            text("기울임", vec![mark("italic")]), text(" · ", vec![]),
            text("밑줄", vec![mark("underline")]), text(" · ", vec![]),
            text("취소선", vec![mark("strike")]), text(" · ", vec![]),
            text("형광", vec![mark("highlight")]), text(" · ", vec![]),
            text("빨간 글자", vec![json!({ "type": "textStyle", "attrs": { "color": "#d32f2f" } })]), text(" · ", vec![]),
            text("링크", vec![json!({ "type": "link", "attrs": { "href": "https://example.com/?a=1&b=2" } })]), text(".", vec![]),
        ]),
        para("center", vec![text("가운데 정렬 문단", vec![])]),
        para("right", vec![text("오른쪽 정렬 문단", vec![])]),
        heading(2, "이력서 표"),
        resume,
        heading(2, "목록"),
        json!({ "type": "bulletList", "content": [nested("글머리표 하나", json!({ "type": "bulletList", "content": [item("안쪽 둘째 수준"), item("안쪽 또 하나")] })), item("글머리표 둘")] }),
        json!({ "type": "orderedList", "attrs": { "start": 1, "type": null }, "content": [nested("번호 하나", json!({ "type": "orderedList", "attrs": { "start": 1, "type": null }, "content": [item("안쪽 가"), item("안쪽 나")] })), item("번호 둘")] }),
        json!({ "type": "taskList", "content": [
            json!({ "type": "taskItem", "attrs": { "checked": true }, "content": [para("left", vec![text("끝낸 일", vec![])])] }),
            json!({ "type": "taskItem", "attrs": { "checked": false }, "content": [para("left", vec![text("할 일", vec![])])] }),
        ] }),
        heading(3, "코드와 인용"),
        json!({ "type": "codeBlock", "attrs": { "language": "rust" }, "content": [text("fn main() {\n    println!(\"안녕\");\n}", vec![])] }),
        json!({ "type": "blockquote", "content": [para("left", vec![text("인용문은 한 단 들여쓴다.", vec![])])] }),
        json!({ "type": "horizontalRule" }),
        para("left", vec![text("끝.", vec![])]),
    ];
    DocExportSection { name: "샘플".to_string(), doc: json!({ "type": "doc", "content": content }) }
}

/// 샘플 그림 섹션 — `sample_png()` 를 가리키는 relPath `n/pic.png` 그림 둘.
pub(crate) fn sample_picture() -> DocExportSection {
    DocExportSection {
        name: "그림".to_string(),
        doc: json!({ "type": "doc", "content": [
            heading(1, "그림 샘플"),
            para("left", vec![json!({ "type": "image", "attrs": { "relPath": "n/pic.png", "alt": "그라데이션", "width": "30%" } }), text(" 그림 뒤에 이어지는 글자.", vec![])]),
            para("center", vec![json!({ "type": "image", "attrs": { "relPath": "n/pic.png", "alt": "", "width": "60%" } })]),
        ] }),
    }
}

pub(crate) fn sample_png() -> Vec<u8> {
    let img = image::RgbImage::from_fn(160, 90, |x, y| image::Rgb([(x * 255 / 160) as u8, (y * 255 / 90) as u8, 120]));
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    buf.into_inner()
}

/// 실제 덤프의 값을 결정적으로 무작위 변형(null · 숫자 · 문자열 · 빈 배열 · 키 삭제)한다 — "변형해도 panic 하지 않는다" 테스트용.
pub(crate) fn mutate(v: &mut Value, rng: &mut u64, depth: usize) {
    let mut next = |m: u64| {
        *rng ^= *rng << 13;
        *rng ^= *rng >> 7;
        *rng ^= *rng << 17;
        *rng % m
    };
    if next(40) == 0 {
        *v = match next(7) {
            0 => Value::Null,
            1 => json!(-1),
            2 => json!(1e15),
            3 => json!("x"),
            4 => json!([]),
            5 => json!({}),
            _ => json!(0.5),
        };
        return;
    }
    if depth > 60 {
        return;
    }
    match v {
        Value::Object(m) => {
            if next(30) == 0 {
                if let Some(k) = m.keys().nth(next(m.len().max(1) as u64) as usize).cloned() {
                    m.remove(&k);
                }
            }
            for (_, c) in m.iter_mut() {
                mutate(c, rng, depth + 1);
            }
        }
        Value::Array(a) => {
            if next(30) == 0 && !a.is_empty() {
                let i = next(a.len() as u64) as usize;
                a.remove(i);
            }
            for c in a.iter_mut() {
                mutate(c, rng, depth + 1);
            }
        }
        _ => {}
    }
}

/// 깊이 `n` 의 중첩 목록(`kind` = bulletList · orderedList · taskList) — 조각을 **옮겨** 감싸 만든다. `json!` 은 끼워 넣는 값을 깊은 복사하므로
/// 층마다 쓰면 O(n²) 이고(1500단이 수십 초), 스택도 쓴다. 호출자는 큰 스택의 스레드에서 쓰고 버린다(버리는 것도 재귀).
pub(crate) fn nested_lists(kind: &str, n: usize) -> Value {
    let wrap = |ty: &str, content: Vec<Value>| {
        let mut m = serde_json::Map::new();
        m.insert("type".to_string(), Value::String(ty.to_string()));
        m.insert("content".to_string(), Value::Array(content));
        Value::Object(m)
    };
    let mut node = wrap(kind, vec![wrap("listItem", vec![p("끝")])]);
    for _ in 1..n {
        node = wrap(kind, vec![wrap("listItem", vec![p("층"), node])]);
    }
    node
}
