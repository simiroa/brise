// repo: web_reader — link-attachment "reader view" (commands/attachments.yaml: attachment_fetch_reader)
//
// Why this exists: previewing a `link` attachment in an <iframe> is blank/broken on most real
// sites (X-Frame-Options: DENY/SAMEORIGIN, or CSP frame-ancestors) — the webview has no way around
// that from script. Fetching the page *from Rust* sidesteps it entirely: framing restrictions are a
// browser-enforced rule about embedding a page inside another page's DOM, and a plain HTTP GET from
// the backend is not "embedding" at all, so those headers are simply irrelevant here.
//
// This intentionally extracts to PLAIN TEXT only (title + paragraph/heading/list text), the same
// contract as repo::extraction's PDF/DOCX text extraction that source_add_from_file already uses.
// That is a deliberate scope limit, not laziness: rendering sanitized *HTML* back into the webview
// would need a real sanitizer (strip <script>, event-handler attributes, javascript: URLs, inline
// <style> exfil vectors, ...) and still wouldn't stop remote subresource loads (<img src>, web
// fonts) without also rewriting every URL — a much larger, easier-to-get-wrong surface. Plain text
// rendered through React (which auto-escapes) has no script-execution surface at all, and we never
// issue a second network request for any subresource, so "no remote scripts, no remote subresources"
// holds by construction rather than by careful sanitization.
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use scraper::{Html, Selector};
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 10;
/// Hard cap on bytes read off the wire, enforced while streaming (not after buffering) so a
/// server that lies about (or omits) Content-Length can't force us to hold an unbounded amount
/// of attacker/publisher-controlled data in memory first.
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024; // 5MB
/// Cap on the *extracted* text handed back to the frontend — mirrors
/// repo::extraction::MAX_EXTRACTED_BYTES's UTF-8-safe truncation approach.
const MAX_READER_CHARS: usize = 200_000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ReaderContent {
    pub title: Option<String>,
    pub text: String,
    pub truncated: bool,
}

/// Max redirect hops we'll follow. Same budget as the previous `Policy::limited(5)`, but now each
/// hop is host-validated (see `fetch_reader`) instead of blindly followed.
const MAX_REDIRECTS: usize = 5;

/// True if `ip` points back into the local host or a private/link-local network — the set of
/// destinations a user-initiated "fetch this public link" must never reach. A crafted link (or one
/// arriving via an imported bundle) that redirects to `http://127.0.0.1:<port>/…` or a LAN address
/// would otherwise let the backend probe internal services (SSRF).
pub(crate) fn ip_is_internal(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
                // Shared carrier-grade NAT, benchmarking, documentation, multicast, and
                // reserved ranges are not publicly reachable application hosts either.  Treating
                // them as internal avoids using a feed/attachment fetch as a network probe.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1])) // 100.64/10
                || (v4.octets()[0] == 198 && (18..=19).contains(&v4.octets()[1])) // 198.18/15
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0) // IETF protocol
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 2) // TEST-NET-1
                || (v4.octets()[0] == 198 && v4.octets()[1] == 51 && v4.octets()[2] == 100) // TEST-NET-2
                || (v4.octets()[0] == 203 && v4.octets()[1] == 0 && v4.octets()[2] == 113) // TEST-NET-3
                || v4.is_multicast()
                || v4.octets()[0] >= 240
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_is_internal(&std::net::IpAddr::V4(mapped));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || v6.is_multicast()
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8) // documentation
        }
    }
}

/// Resolves `url`'s host, rejects the fetch if *any* resolved address is internal, and returns the
/// validated address to connect to. Called before the initial request and before following every
/// redirect hop, so neither the original link nor a redirect target can reach a loopback/private
/// address. Returning the pinned `SocketAddr` (rather than `()`) closes the DNS-rebinding gap: the
/// caller feeds it to reqwest's `.resolve()` so the connect goes to exactly the IP we validated,
/// instead of re-resolving the host at connect time (where it could flip public→private).
pub(crate) async fn guard_public_host(url: &reqwest::Url) -> AppResult<std::net::SocketAddr> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Validation(format!("url has no host: {url}")))?;
    let port = url.port_or_known_default().unwrap_or(80);
    // IP 리터럴은 DNS 를 거치지 않고 바로 판정한다. `host_str()` 은 IPv6 를 `[::1]` 처럼 괄호째 돌려주는데, 그 문자열을
    // lookup_host 에 넘기면 Windows 는 풀어 주고 Linux 는 해석 실패(Io)로 떨어져 차단 판정(Validation)이 플랫폼마다
    // 갈렸다(CI 의 collect_rejects_loopback… 실패, AUDIT-2026-10-23 R5). url 크레이트가 IPv4 변형(0x7f.1 등)은 이미 정규화한다.
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if ip_is_internal(&ip) {
            return Err(AppError::Validation(format!("refusing to fetch internal/loopback address ({ip}) for {host}")));
        }
        return Ok(std::net::SocketAddr::new(ip, port));
    }
    let resolved: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| AppError::Io(format!("dns resolve failed for {host}: {e}")))?
        .collect();
    if resolved.is_empty() {
        return Err(AppError::Io(format!("host did not resolve: {host}")));
    }
    for addr in &resolved {
        if ip_is_internal(&addr.ip()) {
            return Err(AppError::Validation(format!(
                "refusing to fetch internal/loopback address ({}) for {host}",
                addr.ip()
            )));
        }
    }
    // Every resolved address passed the internal check — pin the first one for the connect.
    Ok(resolved[0])
}

/// Fetches `url` and extracts a readable plain-text view of it. Any failure along the way
/// (network, timeout, non-HTML response, oversized response, no extractable text) is surfaced as
/// an `AppError` — the frontend treats *all* of these identically: fall back to the "open in your
/// browser" card. There is no partial/silent state; either this returns real text or it errors.
pub async fn fetch_reader(url: &str) -> AppResult<ReaderContent> {
    let mut current = reqwest::Url::parse(url)
        .map_err(|_| AppError::Validation(format!("not a fetchable http(s) url: {url}")))?;
    if !matches!(current.scheme(), "http" | "https") {
        return Err(AppError::Validation(format!(
            "not a fetchable http(s) url: {url}"
        )));
    }

    let mut hops = 0;
    let resp = loop {
        // Redirects are followed manually (Policy::none) so every hop's destination host can be
        // re-validated against internal addresses before we connect — reqwest's built-in redirect
        // follower gives no hook to inspect/blocklist each hop. The client is (re)built per hop so
        // `.resolve()` can pin the connect to the exact address guard_public_host just validated,
        // defeating DNS-rebinding between the check and the connect.
        let pinned = guard_public_host(&current).await?;
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
            // Identify honestly as Brise rather than spoofing a browser UA — some sites still serve
            // a reasonable HTML document to unrecognized agents, and this is a single, explicit,
            // user-initiated fetch, not a scraper impersonating a real browser.
            .header("User-Agent", "Brise-ReaderView/1.0")
            .header("Accept", "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(|e| AppError::Io(format!("fetch failed: {e}")))?;

        if resp.status().is_redirection() {
            if hops >= MAX_REDIRECTS {
                return Err(AppError::Io("too many redirects".to_string()));
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    AppError::Io("redirect without a valid Location header".to_string())
                })?;
            let next = current
                .join(location)
                .map_err(|e| AppError::Io(format!("bad redirect target: {e}")))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(AppError::Validation(format!(
                    "refusing to follow non-http(s) redirect to {next}"
                )));
            }
            current = next;
            hops += 1;
            continue;
        }
        break resp;
    };

    if !resp.status().is_success() {
        return Err(AppError::Io(format!("http {}", resp.status())));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !(content_type.contains("text/html") || content_type.contains("xhtml")) {
        return Err(AppError::Validation(format!(
            "unsupported content-type for reader view: {}",
            if content_type.is_empty() {
                "(none)"
            } else {
                &content_type
            }
        )));
    }

    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("read failed: {e}")))?;
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::Validation(
                "page is too large for reader view".to_string(),
            ));
        }
        body.extend_from_slice(&chunk);
    }

    let html = String::from_utf8_lossy(&body).into_owned();
    extract_reader_content(&html)
}

/// True if `el` or any ancestor *strictly between it and `root`* (exclusive of `root` itself)
/// looks like page chrome rather than article content (nav/sidebar/footer/language-switcher/
/// etc.) — matched against individual class/id *tokens*, not a raw substring of the whole
/// attribute value, so e.g. a class like "canvas-wrapper" can't accidentally match "nav".
///
/// The walk deliberately stops at `root` rather than continuing to the document root: real sites
/// routinely wrap their entire skin/theme in a chrome-sounding class (Wikipedia's whole page is
/// inside a "vector-body" / "vector-*" skin wrapper), and if the walk kept going past the content
/// root, that alone would disqualify every real paragraph in the article — which is exactly the
/// bug this had before being scoped to `root`.
///
/// This is a coarse, best-effort filter (not a full readability-scoring algorithm) — good enough
/// to strip the most common chrome patterns (Wikipedia's interlanguage-link list showing up ahead
/// of the actual article, for example) without the much larger surface of reimplementing
/// something like Mozilla's Readability.js.
fn is_chrome_element(el: &scraper::ElementRef, root: &scraper::ElementRef) -> bool {
    const BLOCKLIST: &[&str] = &[
        "nav",
        "menu",
        "sidebar",
        "footer",
        "header",
        "toc",
        "infobox",
        "navbox",
        "vector",
        "interlanguage",
        "breadcrumb",
        "cookie",
        "advert",
        "banner",
        "skip",
    ];
    let is_chrome_token = |attr: Option<&str>| {
        attr.unwrap_or("")
            .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
            .map(|tok| tok.to_lowercase())
            .any(|tok| BLOCKLIST.contains(&tok.as_str()))
    };
    let root_id = root.id();
    std::iter::once(*el)
        .chain(
            el.ancestors()
                .take_while(|a| a.id() != root_id)
                .filter_map(scraper::ElementRef::wrap),
        )
        .any(|e| is_chrome_token(e.value().attr("class")) || is_chrome_token(e.value().attr("id")))
}

fn extract_reader_content(html: &str) -> AppResult<ReaderContent> {
    let doc = Html::parse_document(html);

    let title_sel = Selector::parse("title").expect("static selector");
    let title = doc
        .select(&title_sel)
        .next()
        .map(|e| {
            e.text()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|s| !s.is_empty());

    // Prefer a semantic content root over the whole <body> — cuts out nav/header/footer chrome on
    // most modern pages. #mw-content-text / [itemprop='articleBody'] are common-CMS special cases
    // (MediaWiki/Wikipedia, schema.org-annotated news/blog sites) worth naming explicitly since a
    // history-notes app's saved links skew heavily toward exactly those; the rest are generic
    // HTML5 landmarks. Falls back progressively if a candidate root yields no text at all.
    const ROOT_CANDIDATES: &[&str] = &[
        "#mw-content-text",
        "[itemprop='articleBody']",
        "article",
        "main",
        "[role='main']",
        "body",
    ];
    let text_tags = Selector::parse("h1,h2,h3,h4,h5,h6,p,li,blockquote").expect("static selector");

    let mut paragraphs: Vec<String> = Vec::new();
    for root_sel_str in ROOT_CANDIDATES {
        let root_sel = Selector::parse(root_sel_str).expect("static selector");
        let Some(root) = doc.select(&root_sel).next() else {
            continue;
        };
        paragraphs.clear();
        for el in root.select(&text_tags) {
            if is_chrome_element(&el, &root) {
                continue;
            }
            let text = el.text().collect::<String>();
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            // Drop very short fragments (bare icons/whitespace nodes, "»", stray nav labels) that
            // would otherwise litter the reader view with noise lines.
            if text.chars().count() >= 2 {
                paragraphs.push(text);
            }
        }
        if !paragraphs.is_empty() {
            break;
        }
    }

    let mut text = paragraphs.join("\n\n").trim().to_string();
    if text.is_empty() {
        return Err(AppError::Validation(
            "no extractable text on this page".to_string(),
        ));
    }

    let truncated = text.chars().count() > MAX_READER_CHARS;
    if truncated {
        let mut cut = MAX_READER_CHARS;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }

    Ok(ReaderContent {
        title,
        text,
        truncated,
    })
}

/// RSS/Atom 항목의 description/summary/content 조각을 플레인 텍스트로 (P3 수집 관문,
/// docs/PLAN-2026-08-07-second-brain.md Q6, crate::collect::rss가 쓴다). `extract_reader_content`
/// (페이지 전체용 — nav/footer 같은 "chrome" 요소를 걸러내고 h1-h6/p/li/blockquote 화이트리스트만
/// 고른다)를 그대로 재사용하지 않는다: 피드 항목은 <p> 하나 없이 인라인 텍스트+<a>만 있거나 아예
/// 태그가 없는 순수 텍스트인 경우가 흔해서, 그 화이트리스트에 아무것도 안 걸리면 "추출 텍스트
/// 없음" 에러가 난다. 짧은 조각이라 chrome 필터링도 필요 없다 — 프래그먼트의 텍스트 노드를 전부
/// 모아 공백만 정규화한다(빈 입력/태그 없는 순수 텍스트도 그대로 통과).
pub fn html_fragment_to_text(html: &str) -> String {
    let fragment = Html::parse_fragment(html);
    let mut out = String::new();
    collect_fragment_text(fragment.root_element(), &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Recursive text-node walk, explicitly skipping `<script>`/`<style>` subtrees — unlike
/// `ElementRef::text()` (which yields every descendant text node, script/style content included),
/// this never leaks their raw contents into the returned text.
fn collect_fragment_text(el: scraper::ElementRef, out: &mut String) {
    for child in el.children() {
        if let Some(text) = child.value().as_text() {
            out.push_str(text);
            out.push(' ');
        } else if let Some(child_el) = scraper::ElementRef::wrap(child) {
            if matches!(child_el.value().name(), "script" | "style") {
                continue;
            }
            collect_fragment_text(child_el, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    /// IP 리터럴은 DNS 없이 판정한다 — `[::1]` 이 Linux 에서 해석 실패(Io)로 빠지면 차단 판정(Validation)이 아니었다.
    /// 공개 리터럴은 그 주소를 그대로 고정해 돌려준다. 네트워크를 쓰지 않는다.
    #[test]
    fn guard_public_host_judges_ip_literals_without_dns() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for u in ["http://[::1]/f", "http://127.0.0.1/f", "http://10.0.0.1/f", "http://[fd00::1]/f", "http://0x7f.1/f", "http://[::ffff:127.0.0.1]/f"] {
            let url = reqwest::Url::parse(u).unwrap();
            let err = rt.block_on(guard_public_host(&url)).unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{u} must be a Validation refusal, got {err:?}");
        }
        for (u, ip, port) in [("https://[2606:4700:4700::1111]/", "2606:4700:4700::1111", 443), ("http://1.1.1.1:8080/", "1.1.1.1", 8080)] {
            let url = reqwest::Url::parse(u).unwrap();
            let addr = rt.block_on(guard_public_host(&url)).unwrap();
            assert_eq!((addr.ip(), addr.port()), (ip.parse::<IpAddr>().unwrap(), port), "{u}");
        }
    }

    #[test]
    fn ip_is_internal_flags_loopback_and_private_ranges() {
        for ip in [
            "127.0.0.1",
            "127.9.9.9",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.10.10",    // link-local
            "0.0.0.0",          // unspecified
            "::1",              // v6 loopback
            "::",               // v6 unspecified
            "fc00::1",          // v6 unique-local
            "fd12:3456::1",     // v6 unique-local
            "fe80::1",          // v6 link-local
            "::ffff:127.0.0.1", // v4-mapped loopback
            "::ffff:10.0.0.1",  // v4-mapped private
            "100.64.0.1",       // shared carrier-grade NAT
            "198.18.0.1",       // benchmarking network
            "224.0.0.1",        // multicast
            "2001:db8::1",      // documentation range
        ] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(ip_is_internal(&parsed), "{ip} should be internal");
        }
    }

    #[test]
    fn ip_is_internal_allows_public_addresses() {
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",        // example.com
            "172.15.0.1",           // just outside 172.16/12
            "172.32.0.1",           // just outside 172.16/12
            "2606:4700:4700::1111", // cloudflare v6
        ] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(!ip_is_internal(&parsed), "{ip} should be public");
        }
    }

    #[test]
    fn filters_out_chrome_elements_inside_the_chosen_root() {
        // Regression test: live-checked against real en.wikipedia.org — MediaWiki's
        // interlanguage-link list (and similar nav/toc chrome) sits *inside* the same
        // #mw-content-text container as the real article body, so root-selection alone doesn't
        // exclude it. Before is_chrome_element(), a page like this would surface "Home | About |
        // Site nav item" ahead of (or interleaved with) the real paragraph.
        let html = r#"
            <html><head><title>t</title></head>
            <body><main>
              <div class="vector-page-titlebar-languages">
                <ul><li>Français</li><li>한국어</li></ul>
              </div>
              <div id="siteSub">From Wikipedia, the free encyclopedia</div>
              <p>The real article paragraph goes here.</p>
              <ul class="navbox"><li>See also: Other topic</li></ul>
            </main></body></html>
        "#;
        let r = extract_reader_content(html).unwrap();
        assert!(r.text.contains("The real article paragraph goes here."));
        assert!(!r.text.contains("Français"));
        assert!(!r.text.contains("한국어"));
        assert!(!r.text.contains("Other topic"));
    }

    #[test]
    fn extracts_title_and_paragraphs_preferring_article() {
        let html = r#"
            <html><head><title>  Sejong the Great  </title></head>
            <body>
              <nav>Home | About | Contact</nav>
              <header>Site Header</header>
              <article>
                <h1>Sejong the Great</h1>
                <p>King Sejong promulgated Hangul in 1443.</p>
                <p>It remains in use today.</p>
              </article>
              <footer>Copyright 2024</footer>
            </body></html>
        "#;
        let r = extract_reader_content(html).unwrap();
        assert_eq!(r.title.as_deref(), Some("Sejong the Great"));
        assert!(r.text.contains("Sejong promulgated Hangul"));
        assert!(r.text.contains("remains in use today"));
        // article-scoped extraction must not pull in nav/header/footer chrome.
        assert!(!r.text.contains("Home | About"));
        assert!(!r.text.contains("Site Header"));
        assert!(!r.text.contains("Copyright"));
        assert!(!r.truncated);
    }

    #[test]
    fn never_surfaces_script_or_style_content_as_text() {
        let html = r#"
            <html><head><title>t</title>
              <style>.x{color:red} p::before{content:"leak"}</style>
              <script>window.__evil = "should never appear";</script>
            </head>
            <body><main><p>Real paragraph content here.</p></main></body></html>
        "#;
        let r = extract_reader_content(html).unwrap();
        assert!(r.text.contains("Real paragraph content"));
        assert!(!r.text.contains("should never appear"));
        assert!(!r.text.contains("color:red"));
    }

    #[test]
    fn falls_back_to_body_when_no_article_or_main() {
        let html = r#"<html><head><title>Plain page</title></head>
            <body><p>Only a body, no landmark elements.</p></body></html>"#;
        let r = extract_reader_content(html).unwrap();
        assert!(r.text.contains("Only a body"));
    }

    #[test]
    fn errors_on_no_extractable_text() {
        let html = r#"<html><head><title>Empty</title></head><body><div><span></span></div></body></html>"#;
        let err = extract_reader_content(html).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn truncates_long_text_at_a_char_boundary() {
        // Multibyte filler so a naive byte-index cut would panic — this is exactly the failure
        // mode repo::extraction's MAX_EXTRACTED_BYTES cutoff already guards against.
        let filler = "한".repeat(300_000);
        let html = format!(
            "<html><head><title>t</title></head><body><main><p>{filler}</p></main></body></html>"
        );
        let r = extract_reader_content(&html).unwrap();
        assert!(r.truncated);
        assert!(r.text.chars().count() <= MAX_READER_CHARS);
    }

    #[test]
    fn html_fragment_to_text_extracts_inline_markup_without_a_p_wrapper() {
        // Regression case extract_reader_content would fail on: no h1-h6/p/li/blockquote at all,
        // just inline text + <a> — a very common shape for RSS <description>.
        let out =
            html_fragment_to_text("Check out <a href=\"https://example.com\">this link</a> today.");
        assert_eq!(out, "Check out this link today.");
    }

    #[test]
    fn html_fragment_to_text_passes_through_plain_text_untouched() {
        let out = html_fragment_to_text("Just plain text, no markup at all.");
        assert_eq!(out, "Just plain text, no markup at all.");
    }

    #[test]
    fn html_fragment_to_text_normalizes_whitespace_and_never_leaks_script_content() {
        let out = html_fragment_to_text("<p>Real   text</p>\n<script>evil()</script>");
        assert_eq!(out, "Real text");
    }
}
