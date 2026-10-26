// repo: section_import_file · section_import_scan 공용 확장자 매트릭스 (specs/commands/sections.yaml).
// 단일 진실 공급원 — 스캔이 통과시키고 가져오기가 거부하는 상태를 막는다(스펙 노트 참고).

/// 확장자(소문자, 점 없음) → 가져오기 처리 종류. commands/sections.rs::section_import_file 이
/// 이 값으로 파서를 고르고, section_import_scan 은 `Some(_)` 여부만 본다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    /// md·txt — 파일 내용 그대로.
    PlainText,
    /// docx·pdf·hwpx·pptx — extraction::extract_markdown 재사용.
    ExtractedText,
    Csv,
    Tsv,
    /// 워크시트 한 장당 섹션 하나.
    Xlsx,
}

pub fn import_kind_for_ext(ext: &str) -> Option<ImportKind> {
    match ext {
        "md" | "txt" => Some(ImportKind::PlainText),
        "docx" | "pdf" | "hwpx" | "pptx" => Some(ImportKind::ExtractedText),
        "csv" => Some(ImportKind::Csv),
        "tsv" => Some(ImportKind::Tsv),
        "xlsx" => Some(ImportKind::Xlsx),
        _ => None,
    }
}

pub fn is_supported_import_extension(ext: &str) -> bool {
    import_kind_for_ext(ext).is_some()
}
