// repo: doc_export::xmlw — XML 문자열 작성 도우미 (HWPX·DOCX 작성기가 같이 쓰는 형식 무관 부분, W4-RE 에서 hwpx.rs 에서 올림)
//
// 두 작성기 모두 XML 을 문자열로 직접 이어 붙인다(DOM 을 만들지 않는다). 사용자 글이 요소 본문이나 속성값으로 들어가는 모든 자리는
// 이 모듈의 이스케이프를 지난다 — 한 곳에서 막아야 "한 작성기만 빠뜨린" 주입이 없다.

/// XML 1.0 이 허용하는 글자인가. `&#1;` 같은 문자 참조도 불법이라 이스케이프로는 못 살리므로 **버린다**.
pub(super) fn is_xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r') || (c >= ' ' && c != '\u{fffe}' && c != '\u{ffff}')
}

/// 요소 본문·속성값 공용 이스케이프. 불법 글자는 버리고, 속성에서는 개행·탭을 공백으로 접는다(속성값 정규화에 맡기지 않는다).
pub(super) fn esc_into(s: &str, out: &mut String, attr: bool) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attr => out.push_str("&quot;"),
            '\t' | '\n' | '\r' if attr => out.push(' '),
            c if is_xml_char(c) => out.push(c),
            _ => {}
        }
    }
}

pub(super) fn esc_attr(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    esc_into(s, &mut o, true);
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn illegal_characters_are_dropped_and_markup_is_escaped() {
        let mut o = String::new();
        esc_into("a\u{1}b&<>\"c\u{fffe}\td", &mut o, false);
        assert_eq!(o, "ab&amp;&lt;&gt;\"c\td");
        // 속성에서는 따옴표를 막고 개행·탭을 공백으로 접는다.
        assert_eq!(esc_attr("x\"y\n\tz<"), "x&quot;y  z&lt;");
        assert!(is_xml_char('한') && is_xml_char('\u{10000}') && !is_xml_char('\u{0}') && !is_xml_char('\u{ffff}'));
    }
}
