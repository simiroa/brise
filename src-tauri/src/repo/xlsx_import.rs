// repo: xlsx → 시트 섹션 여러 개 (specs/commands/sections.yaml section_import_file xlsx 규칙).
// 워크시트 한 장 = 시트 섹션 하나. 상한/절단 조립은 csv_import::rows_to_sheet_json 재사용 —
// CSV 와 두 벌로 갈리면 상한 규칙이 어긋난다.
use crate::error::{AppError, AppResult};
use crate::repo::csv_import::rows_to_sheet_json;
use calamine::{open_workbook_auto, Data, Reader};
use std::path::Path;

#[derive(Debug)]
pub struct XlsxSheet {
    pub name: String,
    pub json: String,
    pub truncated: bool,
}

/// `stem_fallback`은 워크시트 이름이 빈 문자열일 때만 쓰인다(파일 stem).
pub fn import_xlsx(path: &Path, stem_fallback: &str) -> AppResult<Vec<XlsxSheet>> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| AppError::Io(format!("xlsx open failed: {e}")))?;

    let mut sheets = Vec::new();
    for name in workbook.sheet_names() {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|e| AppError::Io(format!("xlsx sheet read failed: {e}")))?;
        if range.is_empty() {
            continue; // 빈 시트는 건너뛴다
        }
        let rows: Vec<Vec<String>> = range.rows().map(|row| row.iter().map(cell_to_string).collect()).collect();
        let (json, truncated) = rows_to_sheet_json(rows);
        let sheet_name = if name.trim().is_empty() { stem_fallback.to_string() } else { name };
        sheets.push(XlsxSheet { name: sheet_name, json, truncated });
    }

    if sheets.is_empty() {
        return Err(AppError::Validation("xlsx has no non-empty worksheets".to_string()));
    }
    Ok(sheets)
}

/// **계산된 값**을 문자열로(수식 문자열이 아니다 — 우리 수식 엔진과 엑셀 함수 집합이 달라
/// 수식을 그대로 옮기면 조용히 다른 값을 낸다). 날짜는 ISO(YYYY-MM-DD), 그 밖은 표시 문자열.
fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Bool(b) => b.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => format_number(*f),
        Data::DateTime(dt) => dt
            .as_datetime()
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| format_number(dt.as_f64())),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e}"),
    }
}

/// 정수값이면 소수점 없이(엑셀 표시 관례), 아니면 있는 그대로.
fn format_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        f.to_string()
    }
}

/// commands/sections.rs 커맨드 레벨 테스트가 재사용하는 xlsx 픽스처 빌더 — cfg(test) 라
/// 프로덕션 바이너리에는 들어가지 않는다.
#[cfg(test)]
pub mod test_support {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// 워크시트 2장짜리 최소 xlsx 를 zip 으로 손으로 조립한다(calamine 은 읽을 수 있어야 하고
    /// rust_xlsxwriter 같은 새 dev-dependency 는 들이지 않는다). sheet1 은 문자열 A1 + 날짜
    /// 서식(numFmtId=14, 내장 "mm-dd-yy") 이 걸린 숫자 셀 B1(엑셀 시리얼 44927 = 2023-01-01),
    /// sheet2 는 문자열 A1 하나.
    pub fn build_minimal_xlsx(sheet1_a1: &str, sheet2_a1: &str) -> tempfile::NamedTempFile {
        const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;
        const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;
        const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;
        // cellXfs[0] = 기본(numFmtId 0), cellXfs[1] = 내장 날짜 서식(numFmtId 14) — B1 이 s="1" 로 참조.
        const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cellXfs count="2">
<xf numFmtId="0"></xf>
<xf numFmtId="14"></xf>
</cellXfs>
</styleSheet>"#;
        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Revenue" sheetId="1" r:id="rId1"/>
<sheet name="Costs" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>"#;
        let sheet1_xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="str"><v>{sheet1_a1}</v></c><c r="B1" s="1"><v>44927</v></c></row></sheetData>
</worksheet>"#
        );
        let sheet2_xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="str"><v>{sheet2_a1}</v></c></row></sheetData>
</worksheet>"#
        );

        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", CONTENT_TYPES.to_string()),
            ("_rels/.rels", ROOT_RELS.to_string()),
            ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS.to_string()),
            ("xl/workbook.xml", workbook_xml.to_string()),
            ("xl/styles.xml", STYLES_XML.to_string()),
            ("xl/worksheets/sheet1.xml", sheet1_xml),
            ("xl/worksheets/sheet2.xml", sheet2_xml),
        ] {
            writer.start_file(name, opts).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        let cursor = writer.finish().unwrap();
        let mut tmp = tempfile::NamedTempFile::with_suffix(".xlsx").unwrap();
        tmp.write_all(cursor.get_ref()).unwrap();
        tmp
    }

    /// commands/sections.rs::import_command_tests 가 쓰는 문자열-only 2시트 픽스처.
    pub fn two_sheet_fixture() -> tempfile::NamedTempFile {
        build_minimal_xlsx("hello", "world")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use test_support::build_minimal_xlsx;

    #[test]
    fn test_xlsx_two_worksheets_become_two_sections_named_by_sheet() {
        let tmp = build_minimal_xlsx("hello", "world");
        let sheets = import_xlsx(tmp.path(), "fallback").unwrap();
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[0].name, "Revenue");
        assert_eq!(sheets[1].name, "Costs");
        let doc0: serde_json::Value = serde_json::from_str(&sheets[0].json).unwrap();
        assert_eq!(doc0["cells"]["A1"]["raw"], "hello");
        let doc1: serde_json::Value = serde_json::from_str(&sheets[1].json).unwrap();
        assert_eq!(doc1["cells"]["A1"]["raw"], "world");
    }

    /// 날짜 서식이 걸린 숫자 셀(엑셀 시리얼 44927)이 ISO YYYY-MM-DD 로 나온다.
    #[test]
    fn test_xlsx_date_cell_becomes_iso_string() {
        let tmp = build_minimal_xlsx("hello", "world");
        let sheets = import_xlsx(tmp.path(), "fallback").unwrap();
        let doc0: serde_json::Value = serde_json::from_str(&sheets[0].json).unwrap();
        assert_eq!(doc0["cells"]["B1"]["raw"], "2023-01-01");
    }

    /// 워크시트가 전부 비면(sheetData 자체가 없음) VALIDATION.
    #[test]
    fn test_xlsx_all_worksheets_empty_is_validation() {
        const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;
        const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;
        const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
        const WORKBOOK_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Empty" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
        const SHEET1_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData></sheetData>
</worksheet>"#;

        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", ROOT_RELS),
            ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
            ("xl/workbook.xml", WORKBOOK_XML),
            ("xl/worksheets/sheet1.xml", SHEET1_XML),
        ] {
            writer.start_file(name, opts).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        let cursor = writer.finish().unwrap();
        let mut tmp = tempfile::NamedTempFile::with_suffix(".xlsx").unwrap();
        tmp.write_all(cursor.get_ref()).unwrap();

        let err = import_xlsx(tmp.path(), "fallback").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn test_format_number_whole_vs_fractional() {
        assert_eq!(format_number(5.0), "5");
        assert_eq!(format_number(5.5), "5.5");
    }
}
