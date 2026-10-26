// repo: extraction
use crate::error::{AppError, AppResult};
use std::path::Path;

const MAX_EXTRACTED_BYTES: usize = 1024 * 1024; // 1MB

/// 입력 상한은 **형식마다 다른 것을 잰다.** 전에는 `sources.rs` 가 파일 크기 하나로 10MB 를
/// 막았는데, 그건 잰 대상이 틀렸다: pptx/docx/hwpx 는 zip 이라 필요한 XML 엔트리만 풀기 때문에
/// 파일 크기와 추출 비용이 무관하다. 1GB 짜리 pptx 의 999MB 는 임베드된 이미지·동영상이고 우리는
/// 열어보지도 않는다. 게다가 그 게이트는 **세 관문 중 하나에만** 있었다 — `section_import_file`
/// 과 펫 챗 첨부는 같은 추출기를 상한 없이 부르고 있었다. 그래서 정책을 추출기가 갖는다.
///
/// zip 계열은 파일 크기가 아니라 **압축 해제 누적량**을 잰다. 그게 비용에 비례하는 값이고,
/// zip bomb 도 같이 막힌다(10MB 짜리 아카이브가 수 GB 로 부풀 수 있는데 지금까지 이 상한이
/// 아예 없었다).
pub(crate) const MAX_DECOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

/// pdf 만 파일 크기로 막는다 — `pdf_extract::extract_text` 는 경로를 받아 파일 전체를 파싱하므로
/// 중간에 끊을 방법이 없다.
const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;

/// zip 엔트리를 예산 안에서만 푼다. 예산은 한 문서 전체가 공유한다 — 슬라이드 하나하나는 작아도
/// 수천 장이면 같은 문제가 되기 때문. 바이트 그대로 돌려주는 쪽(hwpx 그림 BinData 도 이걸 쓴다)이
/// 핵심이고, 텍스트 XML 용 `read_entry_capped` 는 그 위에 얹은 얇은 래퍼다.
pub(crate) fn read_entry_bytes_capped<R: std::io::Read>(r: &mut R, budget: &mut u64) -> AppResult<Vec<u8>> {
    let mut buf = Vec::new();
    let allowed = *budget;
    let mut limited = std::io::Read::take(r, allowed.saturating_add(1));
    let n = std::io::Read::read_to_end(&mut limited, &mut buf).map_err(crate::error::io)? as u64;
    if n > allowed {
        return Err(AppError::Validation(format!(
            "extracted content exceeds {}MB limit",
            MAX_DECOMPRESSED_BYTES / (1024 * 1024)
        )));
    }
    *budget -= n;
    Ok(buf)
}

pub(crate) fn read_entry_capped<R: std::io::Read>(r: &mut R, budget: &mut u64) -> AppResult<String> {
    let buf = read_entry_bytes_capped(r, budget)?;
    // 잘린 멀티바이트가 아니라 zip 엔트리 전체이므로 정상 UTF-8 이지만, 손상된 파일에서
    // panic 하지 않도록 lossy 로 받는다.
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// `{prefix}{N}{suffix}` 꼴의 zip 엔트리(hwpx `Contents/section{N}.xml`, pptx `ppt/slides/slide{N}.xml`)를
/// **번호 순**으로 모은다 — zip 내부 저장 순서에 기대지 않고, 문자열 정렬이 아니라 숫자 정렬이다
/// (section10 은 section2 뒤). 추출기 둘과 서식형 hwpx 가져오기(`doc_import`)가 같은 규칙을 쓴다.
pub(crate) fn numbered_zip_entries<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    prefix: &str,
    suffix: &str,
) -> AppResult<Vec<(usize, String)>> {
    let mut names: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let name = archive.by_index(i).map_err(|e| AppError::Io(format!("zip error: {e}")))?.name().to_string();
        if let Some(rest) = name.strip_prefix(prefix).and_then(|s| s.strip_suffix(suffix)) {
            if let Ok(n) = rest.parse::<usize>() {
                names.push((n, name));
            }
        }
    }
    names.sort_by_key(|(n, _)| *n);
    Ok(names)
}

/// 반환값의 `bool` 은 **1MB 상한에 걸려 뒷부분을 버렸는지**다. String 하나만 돌려주던 때는
/// pptx 2000장 넘는 덱의 뒷 슬라이드가 조용히 사라졌고 사용자가 알 방법이 없었다 —
/// 첨부 프리뷰(`attachments::read_text`)가 이미 `(String, bool)` 로 같은 절단을 알리고 있다.
pub fn extract_markdown(path: &str) -> AppResult<(String, bool)> {
    let p = Path::new(path);
    let ext_lower = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let text = match ext_lower.as_str() {
        "pdf" => {
            let len = std::fs::metadata(p).map_err(crate::error::io)?.len();
            if len > MAX_PDF_BYTES {
                return Err(AppError::Validation(format!(
                    "pdf exceeds {}MB limit",
                    MAX_PDF_BYTES / (1024 * 1024)
                )));
            }
            pdf_extract::extract_text(p).map_err(|e| AppError::Io(format!("pdf extraction failed: {e}")))?
        }
        "docx" => extract_docx(p)?,
        "hwpx" => extract_hwpx(p)?,
        "pptx" => extract_pptx(p)?,
        // 통째로 읽으면 파일 크기가 그대로 RAM 이 된다. 어차피 아래에서 1MB 로 자르므로 앞부분만
        // 읽는다 — 그러면 txt/md 에는 파일 크기 상한 자체가 필요 없다(앞이 공백뿐인 파일도 trim
        // 뒤 1MB 를 채울 수 있게 넉넉히 잡는다).
        "txt" | "md" => {
            let f = std::fs::File::open(p).map_err(crate::error::io)?;
            let mut buf = Vec::new();
            let mut limited = std::io::Read::take(f, (MAX_EXTRACTED_BYTES as u64) * 4);
            std::io::Read::read_to_end(&mut limited, &mut buf).map_err(crate::error::io)?;
            String::from_utf8_lossy(&buf).into_owned()
        }
        _ => return Err(AppError::Validation(format!("unsupported extraction extension: .{ext_lower}"))),
    };

    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Validation("no extractable text — scanned document?".to_string()));
    }

    if text.len() > MAX_EXTRACTED_BYTES {
        // UTF-8 문자 경계 안전 절단 (é/한글 등 멀티바이트에서 panic 방지)
        let mut cut = MAX_EXTRACTED_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        Ok((text[..cut].to_string(), true))
    } else {
        Ok((text.to_string(), false))
    }
}

/// docx(`w:t`/`w:p`)와 hwpx(`hp:t`/`hp:p`)가 공유하는 quick-xml 순회 — 태그 이름만 다르고 꼴이
/// 같은 두 파서를 하나로 접는다. text_tag 안 텍스트를 모으고, para_tag 시작마다 개행을 넣는다.
fn extract_xml_text(xml: &str, text_tag: &[u8], para_tag: &[u8]) -> String {
    let mut text = String::new();
    let mut in_text = false;
    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(ref e)) if e.name().as_ref() == text_tag => in_text = true,
            Ok(quick_xml::events::Event::End(ref e)) if e.name().as_ref() == text_tag => in_text = false,
            Ok(quick_xml::events::Event::Text(e)) if in_text => {
                if let Ok(s) = std::str::from_utf8(e.as_ref()) {
                    text.push_str(s);
                }
            }
            Ok(quick_xml::events::Event::Start(ref e)) if e.name().as_ref() == para_tag => {
                text.push('\n');
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => (),
        }
    }
    text
}

fn extract_docx(p: &Path) -> AppResult<String> {
    let file = std::fs::File::open(p).map_err(crate::error::io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Io(format!("zip error: {e}")))?;
    let mut document_xml = archive
        .by_name("word/document.xml")
        .map_err(|e| AppError::Io(format!("docx missing document.xml: {e}")))?;
    let mut budget = MAX_DECOMPRESSED_BYTES;
    let xml = read_entry_capped(&mut document_xml, &mut budget)?;

    Ok(extract_xml_text(&xml, b"w:t", b"w:p"))
}

/// hwpx = zip 아카이브, 본문은 `Contents/section0.xml`, `section1.xml` ... 로 나뉜다(문서가
/// 길면 여러 개). extract_docx 와 같은 꼴(zip::ZipArchive + quick_xml::Reader) — 텍스트 요소만
/// `w:t`/`w:p` 대신 `hp:t`/`hp:p`.
fn extract_hwpx(p: &Path) -> AppResult<String> {
    let file = std::fs::File::open(p).map_err(crate::error::io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Io(format!("zip error: {e}")))?;

    // section*.xml 이름을 번호 순으로 — zip 내부 저장 순서에 기대지 않는다.
    let section_names = numbered_zip_entries(&mut archive, "Contents/section", ".xml")?;
    if section_names.is_empty() {
        return Err(AppError::Validation("hwpx missing Contents/section*.xml".to_string()));
    }

    let mut text = String::new();
    let mut budget = MAX_DECOMPRESSED_BYTES;
    for (_, name) in section_names {
        let mut xml_file = archive.by_name(&name).map_err(|e| AppError::Io(format!("zip error: {e}")))?;
        let xml = read_entry_capped(&mut xml_file, &mut budget)?;
        drop(xml_file);

        text.push_str(&extract_xml_text(&xml, b"hp:t", b"hp:p"));
    }
    Ok(text)
}

/// pptx = zip 아카이브(OOXML), 슬라이드 본문은 `ppt/slides/slide{N}.xml` 로 한 슬라이드당 한
/// 파일. extract_hwpx 와 같은 꼴(zip::ZipArchive + quick_xml::Reader, 파일명 번호로 정렬 —
/// zip 내부 저장 순서에 기대지 않는다) — 텍스트 요소만 DrawingML 네임스페이스라 `a:t`/`a:p`
/// (`w:t`/`hp:t` 가 아니라 `a:` 접두사). 화자 노트(`ppt/notesSlides/*`)는 스코프 밖 — 슬라이드
/// 본문만 다룬다. 슬라이드 사이에 `## Slide {n}` 마크다운 헤딩을 넣어 경계를 남긴다 — 섹션으로
/// 가져오면 TipTap 이 h2 로 렌더해 슬라이드 목차가 되고, AI 요약·미리보기가 슬라이드 단위를 안다.
fn extract_pptx(p: &Path) -> AppResult<String> {
    let file = std::fs::File::open(p).map_err(crate::error::io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Io(format!("zip error: {e}")))?;

    // slide*.xml 이름을 번호 순으로 — zip 내부 저장 순서에 기대지 않는다.
    let slide_names = numbered_zip_entries(&mut archive, "ppt/slides/slide", ".xml")?;
    if slide_names.is_empty() {
        return Err(AppError::Validation("pptx missing ppt/slides/slide*.xml".to_string()));
    }

    let mut text = String::new();
    let mut budget = MAX_DECOMPRESSED_BYTES;
    for (n, name) in slide_names {
        let mut xml_file = archive.by_name(&name).map_err(|e| AppError::Io(format!("zip error: {e}")))?;
        let xml = read_entry_capped(&mut xml_file, &mut budget)?;
        drop(xml_file);

        // ponytail: 슬라이드 경계 헤딩은 en 고정 — 이 문자열은 UI 가 아니라 DB 에 저장되는
        // 데이터라, 저장 시점 로케일로 굳히면 en/fr 사용자에게 잘못된 데이터가 남고 나중에
        // 로케일을 바꿔도 안 바뀐다.
        text.push_str(&format!("\n\n## Slide {n}\n\n"));
        text.push_str(&extract_xml_text(&xml, b"a:t", b"a:p"));
    }
    Ok(text)
}

/// zip 을 메모리에서 만들어 실제 임시 파일로 쓰는 테스트 도우미 — 이 파일의 추출기 테스트와
/// `doc_import` 테스트가 같이 쓴다(repo/transfer/migrate/notion.rs 테스트와 동일 패턴).
#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Cursor, Write};

    /// extract_hwpx/extract_pptx 가 std::fs::File::open + ZipArchive::new 를 실제로 타는지까지 확인한다.
    pub(crate) fn build_zip(suffix: &str, entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        let cursor = writer.finish().unwrap();
        let mut tmp = tempfile::NamedTempFile::with_suffix(suffix).unwrap();
        tmp.write_all(cursor.get_ref()).unwrap();
        tmp
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::build_zip;
    use super::*;
    use std::io::Write;

    #[test]
    fn test_hwpx_extracts_paragraph_text() {
        let section0 = br#"<hp:sec xmlns:hp="ns"><hp:p><hp:run><hp:t>Hello</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>World</hp:t></hp:run></hp:p></hp:sec>"#;
        // 두 번째 section 파일이 번호 순으로 이어붙는지도 확인 — zip 저장 순서를 일부러 뒤집는다.
        let section1 = br#"<hp:sec xmlns:hp="ns"><hp:p><hp:run><hp:t>Second</hp:t></hp:run></hp:p></hp:sec>"#;
        let tmp = build_zip(".hwpx", &[
            ("Contents/section1.xml", section1),
            ("Contents/section0.xml", section0),
        ]);

        let text = extract_hwpx(tmp.path()).unwrap();
        let hello_pos = text.find("Hello").unwrap();
        let world_pos = text.find("World").unwrap();
        let second_pos = text.find("Second").unwrap();
        assert!(hello_pos < world_pos, "section0 paragraphs out of order: {text:?}");
        assert!(world_pos < second_pos, "section1 must come after section0: {text:?}");
    }

    #[test]
    fn test_hwpx_missing_sections_is_validation_error() {
        let tmp = build_zip(".hwpx", &[("Contents/header.xml", b"<x/>")]);
        let err = extract_hwpx(tmp.path()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn test_pptx_extracts_slides_in_order() {
        let slide1 = br#"<p:sld xmlns:a="ns"><p:sp><a:t>Hello</a:t></p:sp></p:sld>"#;
        let slide2 = br#"<p:sld xmlns:a="ns"><p:sp><a:t>World</a:t></p:sp></p:sld>"#;
        // slide2 를 slide1 보다 먼저 저장 — zip 내부 저장 순서가 아니라 파일명 번호로 정렬되는지 고정.
        let tmp = build_zip(".pptx", &[
            ("ppt/slides/slide2.xml", slide2),
            ("ppt/slides/slide1.xml", slide1),
        ]);

        let text = extract_pptx(tmp.path()).unwrap();
        // extract_markdown trims the final text before storing — mirror that here so the
        // assertion matches what actually lands in `sources` (see F-N07 pptx-slides-concatenated-in-order).
        assert!(text.trim().starts_with("## Slide 1"), "must start with Slide 1 heading: {text:?}");
        let slide1_pos = text.find("## Slide 1").unwrap();
        let slide2_pos = text.find("## Slide 2").unwrap();
        let hello_pos = text.find("Hello").unwrap();
        let world_pos = text.find("World").unwrap();
        assert!(slide1_pos < slide2_pos, "Slide 1 block must come before Slide 2: {text:?}");
        assert!(hello_pos < world_pos, "slide text out of order: {text:?}");
    }

    /// 상한이 재는 대상이 바뀌었다는 것 자체를 봉인한다 — 파일이 커도 **푸는 양**이 작으면
    /// 통과해야 한다. 오너의 1GB pptx 가 정확히 이 경우다(999MB 는 임베드 미디어).
    #[test]
    fn test_pptx_big_archive_with_small_slides_extracts() {
        // 슬라이드는 작고, 아카이브 안 다른 엔트리(= 이미지 자리)가 훨씬 크다.
        let slide = br#"<p:sld xmlns:a="ns"><p:sp><a:t>Hello</a:t></p:sp></p:sld>"#;
        let fat_media = vec![b' '; 8 * 1024 * 1024];
        let f = build_zip(
            ".pptx",
            &[("ppt/slides/slide1.xml", slide), ("ppt/media/image1.png", &fat_media)],
        );
        let (text, truncated) = extract_markdown(f.path().to_str().unwrap()).unwrap();
        assert!(text.contains("Hello"), "슬라이드 텍스트가 나와야 한다: {text:?}");
        assert!(!truncated, "상한 안쪽인데 잘렸다고 보고했다");
    }

    /// 1MB 절단은 **조용하면 안 된다** — 잘린 사실을 안 돌려주면 사료 본문이 전부인 척한다.
    /// 경계가 한글 한가운데(1048576 % 3 == 1)에 떨어지도록 픽스처를 잡아, 멀티바이트가
    /// 반토막 나지 않는지도 같은 테스트가 본다.
    #[test]
    fn test_truncation_is_reported_and_keeps_char_boundary() {
        let mut tmp = tempfile::NamedTempFile::with_suffix(".txt").unwrap();
        let n = MAX_EXTRACTED_BYTES / 3 + 100;
        tmp.write_all("가".repeat(n).as_bytes()).unwrap();
        tmp.flush().unwrap();

        let (text, truncated) = extract_markdown(tmp.path().to_str().unwrap()).unwrap();
        assert!(truncated, "1MB 를 넘겼는데 잘렸다고 보고하지 않았다");
        assert!(text.len() <= MAX_EXTRACTED_BYTES, "상한을 넘겼다: {}", text.len());
        assert_eq!(text.len() % 3, 0, "한글이 반토막 났다: {}", text.len());
        assert!(text.chars().all(|c| c == '가'), "깨진 문자가 섞였다");
    }

    #[test]
    fn test_short_text_is_not_reported_truncated() {
        let mut tmp = tempfile::NamedTempFile::with_suffix(".txt").unwrap();
        tmp.write_all("짧은 본문".as_bytes()).unwrap();
        tmp.flush().unwrap();

        let (text, truncated) = extract_markdown(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(text, "짧은 본문");
        assert!(!truncated);
    }

    /// 반대 방향 — 파일은 작아도 푸는 양이 크면 막힌다(zip bomb). 예전 파일 크기 게이트는
    /// 이걸 통과시켰다.
    #[test]
    fn test_pptx_decompression_budget_is_enforced() {
        // 압축이 잘 되는 반복 바이트라 아카이브 자체는 작지만 풀면 예산을 넘는다.
        let mut huge = Vec::with_capacity(MAX_DECOMPRESSED_BYTES as usize + 1024);
        huge.extend_from_slice(br#"<p:sld xmlns:a="ns"><p:sp><a:t>"#);
        huge.resize(MAX_DECOMPRESSED_BYTES as usize + 512, b'A');
        huge.extend_from_slice(br#"</a:t></p:sp></p:sld>"#);
        let f = build_zip(".pptx", &[("ppt/slides/slide1.xml", &huge)]);
        let err = extract_markdown(f.path().to_str().unwrap()).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("exceeds")),
            "압축 해제 예산 초과는 VALIDATION 이어야 한다: {err:?}"
        );
    }

    #[test]
    fn test_pptx_missing_slides_is_validation_error() {
        let tmp = build_zip(".pptx", &[("ppt/presentation.xml", b"<x/>")]);
        let err = extract_pptx(tmp.path()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
