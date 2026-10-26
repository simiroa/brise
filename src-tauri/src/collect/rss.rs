// crate::collect::rss — RSS 2.0 / Atom 어댑터 (P3 수집 관문 1호, kind='rss').
//
// quick_xml(이미 의존성 — repo/transfer/migrate/enex.rs와 같은 low-level pull 파서, DOCTYPE/외부
// 엔티티를 아예 해석하지 않아 XXE 여지가 없다는 점도 동일)로 RSS `<item>`/Atom `<entry>` 의
// guid|id · title · link · description|summary|content(:encoded) · pubDate|updated|published만
// 뽑는다. 그 외 필드(카테고리, 저자, enclosure 등)는 out of scope — ponytail: 필요해지면
// push_field_text의 match에 arm 하나 추가.
use super::{config as source_config, CollectCtx, CollectedItem};
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use quick_xml::events::Event;
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 15;
/// 피드 XML 자체의 크기 상한(스트리밍 중 강제) — 항목 본문 길이 상한(collect::ITEM_BODY_MAX_CHARS)
/// 과는 별개 관심사(네트워크/메모리 방어 vs 노트 가독성).
const MAX_FEED_BYTES: usize = 3 * 1024 * 1024; // 3MB

pub fn collect(config: &str, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let cfg = match source_config::parse("rss", config)? {
        source_config::SourceConfig::Rss(cfg) => cfg,
        _ => unreachable!("kind parser returned the wrong config"),
    };
    let xml = ctx.rt.block_on(fetch_feed_xml(cfg.url.trim()))?;
    parse_feed(&xml)
}

async fn fetch_feed_xml(url: &str) -> AppResult<String> {
    fetch_public_text(
        url,
        "application/rss+xml, application/atom+xml, application/xml, text/xml",
        MAX_FEED_BYTES,
    )
    .await
}

/// 공개 http(s) 주소 하나를 텍스트로 받는다 — 사설 주소·DNS 리바인딩 가드, 리디렉트 5회 수동 추적,
/// 크기 상한 스트리밍 강제. RSS 피드와 달력 `.ics` 구독(commands::calendar_marks)이 같이 쓴다.
pub(crate) async fn fetch_public_text(url: &str, accept: &str, max_bytes: usize) -> AppResult<String> {
    let mut current = reqwest::Url::parse(url)
        .map_err(|_| AppError::Validation(format!("not a fetchable http(s) url: {url}")))?;
    if !matches!(current.scheme(), "http" | "https") || current.host_str().is_none() {
        return Err(AppError::Validation(format!(
            "not a fetchable http(s) url: {url}"
        )));
    }
    if !current.username().is_empty() || current.password().is_some() {
        return Err(AppError::Validation(
            "rss source URL must not contain username or password".to_string(),
        ));
    }

    // Follow redirects manually so every hop goes through the same private-address and DNS
    // rebinding guard as the link reader.  Reqwest's default follower would otherwise let a
    // public feed redirect into localhost/LAN space without an inspection hook.
    const MAX_REDIRECTS: usize = 5;
    let mut hops = 0;
    let resp = loop {
        let pinned = crate::repo::web_reader::guard_public_host(&current).await?;
        let host = current
            .host_str()
            .ok_or_else(|| AppError::Validation(format!("url has no host: {current}")))?
            .to_string();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, pinned)
            .build()
            .map_err(|e| AppError::Io(e.to_string()))?;
        let resp = client
            .get(current.clone())
            .header("User-Agent", "Brise-Collect/1.0")
            .header(
                "Accept",
                accept,
            )
            .send()
            .await
            .map_err(|e| AppError::Io(format!("feed fetch failed: {e}")))?;

        if resp.status().is_redirection() {
            if hops >= MAX_REDIRECTS {
                return Err(AppError::Io("too many feed redirects".to_string()));
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    AppError::Io("feed redirect without a valid Location header".to_string())
                })?;
            let next = current
                .join(location)
                .map_err(|e| AppError::Io(format!("bad feed redirect target: {e}")))?;
            if !matches!(next.scheme(), "http" | "https") || next.host_str().is_none() {
                return Err(AppError::Validation(format!(
                    "refusing to follow non-http(s) feed redirect to {next}"
                )));
            }
            if !next.username().is_empty() || next.password().is_some() {
                return Err(AppError::Validation(
                    "refusing to follow feed redirect with username or password".to_string(),
                ));
            }
            current = next;
            hops += 1;
            continue;
        }
        break resp;
    };

    if !resp.status().is_success() {
        return Err(AppError::Io(format!("feed http {}", resp.status())));
    }
    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("feed read failed: {e}")))?;
        if body.len() + chunk.len() > max_bytes {
            return Err(AppError::Validation("feed is too large".to_string()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[derive(Default)]
struct RawItem {
    guid: Option<String>,
    title: String,
    link: Option<String>,
    description: String,
    pub_date: Option<String>,
}

#[derive(PartialEq, Clone, Copy)]
enum Field {
    None,
    Title,
    Guid,
    Link,
    Description,
    PubDate,
}

/// RSS 2.0 `<item>` / Atom `<entry>` 을 스트리밍 파싱한다. 항목 하나의 XML이 망가져도(닫히지
/// 않은 태그 등) quick_xml이 즉시 Err를 내므로 전체 피드를 실패로 처리한다 — enex.rs의 청크 단위
/// 격리(한 노트 실패가 나머지를 막지 않음)와 달리, RSS는 항목 경계를 미리 잘라둘 수 없는 스트림
/// 하나라 이 이상의 부분 복구는 구현 비용 대비 이득이 낮다(ponytail: 필요해지면 항목별 재시도
/// 대신 quick_xml의 malformed-input 관용도를 먼저 확인).
fn parse_feed(xml: &str) -> AppResult<Vec<CollectedItem>> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut items: Vec<RawItem> = Vec::new();
    let mut in_item = false;
    let mut cur = RawItem::default();
    let mut field = Field::None;

    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(AppError::Validation(format!(
                    "failed to parse feed xml: {e}"
                )))
            }
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let local = e.local_name();
                let name = local.as_ref();
                if !in_item {
                    if name == b"item" || name == b"entry" {
                        in_item = true;
                        cur = RawItem::default();
                    }
                    continue;
                }
                match name {
                    // First occurrence wins — do NOT re-enter Title once cur.title is non-empty.
                    // YouTube channel Atom feeds carry a second, differently-namespaced element
                    // that ALSO local_name-strips to "title" (<media:group><media:title>, sibling
                    // to the entry's own <title>) — local_name-based matching can't distinguish
                    // them, so without this guard push_field_text's accumulate-across-text-events
                    // design (needed for CDATA/entity-split text WITHIN one element) silently
                    // concatenates the two elements' text with no separator, doubling every title
                    // (found 2026-08-29 running a live channel feed through this parser — every
                    // one of 15 real items came back as "TitleTitle"). A title is never legitimately
                    // the concatenation of two different XML elements, unlike Description (§ header
                    // comment: description/summary/content/encoded intentionally may co-occur).
                    b"title" if cur.title.is_empty() => field = Field::Title,
                    b"guid" | b"id" => field = Field::Guid,
                    // description(RSS)/summary(Atom)/content(Atom)/encoded(RSS content:encoded module,
                    // local_name strips the "content:" namespace prefix).
                    b"description" | b"summary" | b"content" | b"encoded" => {
                        field = Field::Description
                    }
                    b"pubDate" | b"updated" | b"published" => field = Field::PubDate,
                    b"link" => {
                        // Atom: <link href="…" rel="…"/> (self-closing, attribute-carried) — RSS:
                        // <link>https://…</link> (text-carried). Only the first href we see wins
                        // (typically the sole or "alternate" link) — ponytail: not rel-filtering,
                        // good enough for "the article URL" which is all a note footer needs.
                        if cur.link.is_none() {
                            if let Ok(Some(href)) = e.try_get_attribute("href") {
                                if let Ok(v) = href.decode_and_unescape_value(reader.decoder()) {
                                    cur.link = Some(v.into_owned());
                                }
                            } else {
                                field = Field::Link;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name();
                let name = local.as_ref();
                if in_item && (name == b"item" || name == b"entry") {
                    items.push(std::mem::take(&mut cur));
                    in_item = false;
                }
                field = Field::None;
            }
            Ok(Event::Text(t)) if in_item => {
                // quick_xml 0.41 splits `&amp;`/`&#38;`-style references out into their own
                // Event::GeneralRef (handled below) — by the time a Text event fires, its content
                // is already entity-free, so this is a plain encoding decode (no unescape needed).
                let text = t
                    .decode()
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(t.as_ref()).into_owned());
                push_field_text(&mut cur, field, &text);
            }
            Ok(Event::GeneralRef(r)) if in_item => {
                // Numeric refs (&#38; / &#x26;) resolve directly; named refs only cover XML's 5
                // predefined entities (amp/lt/gt/quot/apos) — RSS/Atom is well-formed XML with no
                // DTD, so no other named entity is legal here. Unresolvable/unknown refs are
                // dropped rather than guessed at (ponytail: no DTD entity table).
                let resolved = r.resolve_char_ref().ok().flatten().or_else(|| {
                    match r.decode().ok()?.as_ref() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    }
                });
                if let Some(ch) = resolved {
                    push_field_text(&mut cur, field, &ch.to_string());
                }
            }
            Ok(Event::CData(t)) if in_item => {
                // CDATA payloads (feeds commonly wrap HTML descriptions in CDATA) are raw text —
                // not XML-entity-escaped — so no decoding here (matches enex.rs's <content> handling).
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                push_field_text(&mut cur, field, &text);
            }
            _ => {}
        }
    }

    Ok(items.into_iter().filter_map(raw_to_collected).collect())
}

fn push_field_text(cur: &mut RawItem, field: Field, text: &str) {
    match field {
        Field::Title => cur.title.push_str(text),
        Field::Guid => cur.guid.get_or_insert_with(String::new).push_str(text),
        Field::Link => cur.link.get_or_insert_with(String::new).push_str(text),
        Field::Description => cur.description.push_str(text),
        Field::PubDate => cur.pub_date.get_or_insert_with(String::new).push_str(text),
        Field::None => {}
    }
}

fn raw_to_collected(raw: RawItem) -> Option<CollectedItem> {
    let title = raw.title.trim().to_string();
    let link = raw
        .link
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let guid = raw
        .guid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| link.clone())?; // guid도 링크도 없으면 이 항목은 재수집 여부를 판단할 수 없다 — 스킵
    if title.is_empty() && raw.description.trim().is_empty() {
        return None; // 제목도 본문도 없는 항목은 노트로 만들 가치가 없다
    }
    let body_md = crate::repo::web_reader::html_fragment_to_text(&raw.description);
    Some(CollectedItem {
        guid,
        title: if title.is_empty() {
            "(제목 없음)".to_string()
        } else {
            title
        },
        body_md,
        source_url: link,
        published_at: raw
            .pub_date
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        parts: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS2: &str = r#"<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Feed</title>
  <item>
    <title>First Post</title>
    <link>https://example.com/first</link>
    <guid>urn:uuid:first-1</guid>
    <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Second Post</title>
    <link>https://example.com/second</link>
    <description>Plain text summary, no CDATA &amp; no HTML.</description>
  </item>
</channel></rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom-entry" rel="alternate"/>
    <id>tag:example.com,2024:atom-1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <summary>An atom summary.</summary>
  </entry>
</feed>"#;

    #[test]
    fn parses_rss2_items_including_guid_link_cdata_html_and_plain_description() {
        let items = parse_feed(RSS2).unwrap();
        assert_eq!(items.len(), 2);

        assert_eq!(items[0].guid, "urn:uuid:first-1");
        assert_eq!(items[0].title, "First Post");
        assert_eq!(
            items[0].source_url.as_deref(),
            Some("https://example.com/first")
        );
        assert_eq!(items[0].body_md, "Hello world");
        assert_eq!(
            items[0].published_at.as_deref(),
            Some("Mon, 01 Jan 2024 00:00:00 GMT")
        );

        // No <guid> on the second item -> falls back to the link as the dedup key.
        assert_eq!(items[1].guid, "https://example.com/second");
        assert_eq!(items[1].body_md, "Plain text summary, no CDATA & no HTML.");
    }

    #[test]
    fn parses_atom_entries_including_href_link_attribute_and_id() {
        let items = parse_feed(ATOM).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].guid, "tag:example.com,2024:atom-1");
        assert_eq!(items[0].title, "Atom Entry");
        assert_eq!(
            items[0].source_url.as_deref(),
            Some("https://example.com/atom-entry")
        );
        assert_eq!(items[0].body_md, "An atom summary.");
        assert_eq!(
            items[0].published_at.as_deref(),
            Some("2024-01-02T00:00:00Z")
        );
    }

    #[test]
    fn items_missing_both_guid_and_link_are_skipped() {
        let xml = r#"<rss version="2.0"><channel><item><title>No identity</title><description>x</description></item></channel></rss>"#;
        let items = parse_feed(xml).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn malformed_xml_is_a_validation_error() {
        // Mismatched end tag name — quick_xml's default check_end_names catches this even though
        // the pull parser otherwise never validates document-level well-formedness (e.g. it won't
        // complain about a document that simply ends mid-tag without a closing tag at all).
        let err = parse_feed("<rss><channel><item><title>oops</bogus></item></channel></rss>")
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn entity_references_are_resolved_across_named_and_numeric_forms() {
        let xml = "<rss><channel><item><guid>g</guid><title>A &amp; B &lt;C&gt; &#38; &#x26;</title></item></channel></rss>";
        let items = parse_feed(xml).unwrap();
        assert_eq!(items[0].title, "A & B <C> & &");
    }

    #[test]
    fn collect_rejects_config_without_a_url() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let ctx = CollectCtx { rt: &rt, data_dir: std::env::temp_dir(), since: None };
        let err = collect("{}", &ctx).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn collect_rejects_loopback_and_private_feed_hosts_before_connecting() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let ctx = CollectCtx { rt: &rt, data_dir: std::env::temp_dir(), since: None };
        for url in [
            "http://127.0.0.1/feed.xml",
            "http://10.0.0.1/feed.xml",
            "http://[::1]/feed.xml",
        ] {
            let config = serde_json::json!({"url": url}).to_string();
            let err = collect(&config, &ctx).unwrap_err();
            assert!(
                matches!(err, AppError::Validation(_)),
                "{url} must be blocked"
            );
        }
    }
}
