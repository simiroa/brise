// repo: doc_import::xml — XML → 트리 (HWPX 가져오기에서 떼어 낸 형식 무관 유틸, W4-0)
//
// 로컬 이름(접두사 없음)으로 맞춘 가벼운 DOM 이다. 파서는 이 트리를 `effective`(hp:switch 투명 펼침)·`find_*` 로 읽는다.
// 형식마다 다른 두 가지는 `XmlOpts` 로 받는다(글자를 남길 요소 이름 · DOCTYPE 거절) — HWPX 는 `parse_xml` 의 기본값 그대로.
// 상한(깊이·노드 수)은 여기서 한 번 막는다 — 깊이는 재귀(스택) 보호, 노드 수는 메모리 보호다.
use crate::error::{AppError, AppResult};

/// XML 트리 상한 — 깊이는 재귀(스택) 보호, 노드 수는 메모리 보호다(`<a/>` 4바이트가 노드 하나가 될 수 있다).
pub(super) const MAX_XML_DEPTH: usize = 128;
const MAX_XML_NODES: usize = 2_000_000;

// ── XML 트리 ──────────────────────────────────────────────────────────────────

pub(super) struct Node {
    /// 로컬 이름(접두사 없음).
    pub(super) name: String,
    pub(super) attrs: Vec<(String, String)>,
    pub(super) kids: Vec<Kid>,
}

pub(super) enum Kid {
    El(Node),
    Text(String),
}

impl Node {
    pub(super) fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub(super) fn elements(&self) -> impl Iterator<Item = &Node> {
        self.kids.iter().filter_map(|k| match k {
            Kid::El(n) => Some(n),
            Kid::Text(_) => None,
        })
    }

    /// 직계 텍스트만 이어 붙인다.
    pub(super) fn text(&self) -> String {
        let mut s = String::new();
        for k in &self.kids {
            if let Kid::Text(t) = k {
                s.push_str(t);
            }
        }
        s
    }
}

/// 형식마다 다른 파싱 옵션. 기본값(`parse_xml`)이 HWPX 의 동작이다.
#[derive(Clone, Copy, Default)]
pub(super) struct XmlOpts {
    /// 공통 목록(`t` · `script` · `*Param`) 말고 글자를 남길 요소 로컬 이름(DOCX 의 `instrText` 필드 명령).
    pub(super) extra_text: &'static [&'static str],
    /// DOCTYPE 이 있으면 거절한다 — 워드는 DOCTYPE 을 쓰지 않는다(엔티티 선언을 읽지는 않지만, 있어야 할 이유도 없다).
    pub(super) reject_doctype: bool,
}

/// 글자를 읽을 요소만 텍스트 노드를 남긴다 — 들여쓰기 공백까지 노드로 쥐면 메모리만 먹는다.
/// `hp:t` 는 공백 하나짜리 글도 의미가 있어 그대로 둔다.
fn keeps_text(name: &str, opts: &XmlOpts) -> bool {
    matches!(name, "t" | "script") || name.ends_with("Param") || opts.extra_text.contains(&name)
}

fn push_text_kid(node: &mut Node, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Kid::Text(last)) = node.kids.last_mut() {
        last.push_str(text);
    } else {
        node.kids.push(Kid::Text(text.to_string()));
    }
}

fn xml_bad(what: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!("document xml is malformed: {what}"))
}

/// quick-xml 0.41 은 `&amp;` 같은 참조를 텍스트와 **따로** `GeneralRef` 로 준다 — 이걸 안 받으면 `A&amp;B` 가 `AB` 가
/// 된다. 미리 정의된 다섯 개와 문자 참조(`&#xAC00;`)만 풀고, 그 밖의 엔티티는 버린다(DTD 를 읽지 않는다).
fn resolve_general_ref(r: &quick_xml::events::BytesRef<'_>) -> String {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        return ch.to_string();
    }
    match r.decode().ok().as_deref() {
        Some("lt") => "<".to_string(),
        Some("gt") => ">".to_string(),
        Some("amp") => "&".to_string(),
        Some("apos") => "'".to_string(),
        Some("quot") => "\"".to_string(),
        _ => String::new(),
    }
}

/// XML → 트리. 깨진 XML 은 어떤 경우에도 panic 이 아니라 VALIDATION 이다(`Err`·EOF 앞 닫히지 않은 요소 모두).
pub(super) fn parse_xml(xml: &str) -> AppResult<Node> {
    parse_xml_with(xml, &XmlOpts::default())
}

pub(super) fn parse_xml_with(xml: &str, opts: &XmlOpts) -> AppResult<Node> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    // 자기 닫힘 요소(`<hp:lineBreak/>`)가 대부분이다 — Start/End 한 쌍으로 펴 두면 한 갈래만 다루면 된다.
    reader.config_mut().expand_empty_elements = true;
    let decoder = reader.decoder();
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    let mut nodes = 0usize;
    loop {
        match reader.read_event() {
            Err(e) => return Err(xml_bad(e)),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                if stack.len() >= MAX_XML_DEPTH {
                    return Err(AppError::Validation("document xml nesting is too deep".to_string()));
                }
                nodes += 1;
                if nodes > MAX_XML_NODES {
                    return Err(AppError::Validation("document xml has too many elements".to_string()));
                }
                let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                let mut attrs = Vec::new();
                for a in e.attributes() {
                    let a = a.map_err(xml_bad)?;
                    let key = String::from_utf8_lossy(a.key.local_name().as_ref()).into_owned();
                    let val = a
                        .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
                        .map_err(xml_bad)?
                        .into_owned();
                    attrs.push((key, val));
                }
                stack.push(Node { name, attrs, kids: Vec::new() });
            }
            Ok(Event::End(_)) => {
                let node = stack.pop().ok_or_else(|| xml_bad("unbalanced end tag"))?;
                match stack.last_mut() {
                    Some(parent) => parent.kids.push(Kid::El(node)),
                    None if root.is_none() => root = Some(node),
                    None => {}
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(top) = stack.last_mut().filter(|n| keeps_text(&n.name, opts)) {
                    push_text_kid(top, &t.decode().map_err(xml_bad)?);
                }
            }
            Ok(Event::CData(c)) => {
                if let Some(top) = stack.last_mut().filter(|n| keeps_text(&n.name, opts)) {
                    push_text_kid(top, &c.decode().map_err(xml_bad)?);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if let Some(top) = stack.last_mut().filter(|n| keeps_text(&n.name, opts)) {
                    push_text_kid(top, &resolve_general_ref(&r));
                }
            }
            Ok(Event::DocType(_)) if opts.reject_doctype => {
                return Err(AppError::Validation("document xml must not declare a DOCTYPE".to_string()));
            }
            Ok(_) => {}
        }
    }
    if !stack.is_empty() {
        return Err(xml_bad("unclosed element"));
    }
    root.ok_or_else(|| xml_bad("no root element"))
}

/// `hp:switch` 를 투명하게 편다 — `hp:case` 가 있으면 그 자식들, 없으면 `hp:default` 의 자식들을 부모의 자식인 것처럼
/// 돌려준다(두 번째 값 = default 에서 왔는가). hwpxlib 은 run/p/t/subList/paraPr … 거의 모든 자리에서 switch 를
/// 받는다(`childElementInSwitch`)라서, 자식 순회는 전부 이걸 거친다.
pub(super) fn effective(n: &Node) -> Vec<(&Node, bool)> {
    fn walk<'a>(n: &'a Node, from_default: bool, out: &mut Vec<(&'a Node, bool)>) {
        for k in n.elements() {
            if k.name == "switch" {
                let pick = k
                    .elements()
                    .find(|c| c.name == "case")
                    .map(|c| (c, false))
                    .or_else(|| k.elements().find(|c| c.name == "default").map(|c| (c, true)));
                if let Some((c, d)) = pick {
                    walk(c, from_default || d, out);
                }
            } else {
                out.push((k, from_default));
            }
        }
    }
    let mut out = Vec::new();
    walk(n, false, &mut out);
    out
}

/// switch 하나에서 고른 가지(`case` 우선) — `hp:t` 안의 switch 처럼 텍스트 노드가 섞인 자리용.
pub(super) fn pick_switch(sw: &Node) -> Option<&Node> {
    sw.elements()
        .find(|c| c.name == "case")
        .or_else(|| sw.elements().find(|c| c.name == "default"))
}

pub(super) fn eff_child<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
    effective(n).into_iter().map(|(k, _)| k).find(|k| k.name == name)
}

pub(super) fn find_all<'a>(n: &'a Node, name: &str, out: &mut Vec<&'a Node>) {
    for k in n.elements() {
        if k.name == name {
            out.push(k);
        }
        find_all(k, name, out);
    }
}

pub(super) fn find_first<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
    for k in n.elements() {
        if k.name == name {
            return Some(k);
        }
        if let Some(found) = find_first(k, name) {
            return Some(found);
        }
    }
    None
}

pub(super) fn num<T: std::str::FromStr>(s: Option<&str>) -> Option<T> {
    s.and_then(|v| v.trim().parse().ok())
}
