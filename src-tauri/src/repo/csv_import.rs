// repo: CSV/TSV → 시트 JSON v1 임포트 (specs/commands/sections.yaml section_import_file).
// 스키마 SSOT: docs/SHEET.md §3 · src/lib/sheet/types.ts::SheetDoc. 왕복 대칭 대상:
// src/lib/sheet/csv.ts::escapeCsvCell (RFC 4180 — 따옴표 감싸기, "" 이스케이프, 셀 안 개행).
use crate::error::AppResult;
use std::path::Path;

const INIT_ROWS: usize = 100;
const INIT_COLS: usize = 26;
const MAX_ROWS: usize = 1000;
const MAX_COLS: usize = 52;

/// CSV/TSV 파일 → 시트 JSON 문자열 + truncated. 구분자는 호출부가 확장자로 결정해 넘긴다
/// (csv=',' · tsv='\t') — 여기서 추측하지 않는다.
pub fn import_csv(path: &Path, delimiter: char) -> AppResult<(String, bool)> {
    let text = read_text_with_fallback(path)?;
    let rows = parse_rows(&text, delimiter);
    Ok(rows_to_sheet_json(rows))
}

/// 행렬(문자열 셀, 희소 아님) → 시트 JSON v1 문자열 + truncated. CSV/TSV/xlsx 가 공유하는
/// 유일한 조립부(상한 계산 · A1 키 생성 · cols 배열 · serde_json 직렬화) — 두 벌로 복제하면
/// 상한 규칙이 갈린다(specs/commands/sections.yaml xlsx 규칙 노트).
pub fn rows_to_sheet_json(rows: Vec<Vec<String>>) -> (String, bool) {
    let data_rows = rows.len();
    let data_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let truncated = data_rows > MAX_ROWS || data_cols > MAX_COLS;

    let sheet_rows = data_rows.max(INIT_ROWS).min(MAX_ROWS);
    let sheet_cols = data_cols.max(INIT_COLS).min(MAX_COLS);

    let mut cells = serde_json::Map::new();
    for (r, row) in rows.iter().take(MAX_ROWS).enumerate() {
        for (c, raw) in row.iter().take(MAX_COLS).enumerate() {
            if raw.is_empty() {
                continue; // 희소 맵 — 빈 셀은 키 자체를 넣지 않는다
            }
            let key = format!("{}{}", col_letters(c), r + 1);
            cells.insert(key, serde_json::json!({ "raw": raw }));
        }
    }

    let cols: Vec<serde_json::Value> = (0..sheet_cols).map(|_| serde_json::json!({})).collect();
    let doc = serde_json::json!({
        "v": 1,
        "rows": sheet_rows,
        "cols": cols,
        "cells": serde_json::Value::Object(cells),
        "charts": [],
    });
    (doc.to_string(), truncated)
}

/// UTF-8 우선(BOM 제거), 실패 시 CP949 폴백(EUC-KR — WHATWG 정의상 CP949 상위호환이라
/// encoding_rs::EUC_KR 이 정확히 이 용도). 폴백은 조용히 한다 — 사용자가 할 수 있는 일이 없다.
fn read_text_with_fallback(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path).map_err(crate::error::io)?;
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            let (decoded, _enc, _had_errors) = encoding_rs::EUC_KR.decode(bytes);
            Ok(decoded.into_owned())
        }
    }
}

/// RFC 4180: 큰따옴표 감싸기, 셀 안 `""` → `"` 이스케이프, 셀 안 개행 허용. `\r\n` / `\n` 둘 다
/// 처리. 마지막 빈 줄은 버린다.
fn parse_rows(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            in_quotes = true;
        } else if c == delimiter {
            row.push(std::mem::take(&mut field));
        } else if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else if c == '\n' {
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    // 트레일링 뉴라인 없는 마지막 줄 — 있으면 밀어 넣는다.
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    // 마지막 빈 줄(빈 필드 하나뿐인 행)은 버린다.
    while rows.last().is_some_and(|r| r.len() == 1 && r[0].is_empty()) {
        rows.pop();
    }
    rows
}

/// 0-based 열 인덱스 → A1 열 문자. src/lib/sheet/a1.ts::colToLetters 와 동일 규칙
/// (0→A, 25→Z, 26→AA).
fn col_letters(col: usize) -> String {
    let mut n = col + 1;
    let mut out = String::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        out.insert(0, (b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_bytes(bytes: &[u8], suffix: &str) -> tempfile::NamedTempFile {
        let mut tmp = tempfile::NamedTempFile::with_suffix(suffix).unwrap();
        tmp.write_all(bytes).unwrap();
        tmp
    }

    #[test]
    fn test_csv_import_rfc4180_quotes() {
        // 따옴표 감싼 셀 + "" 이스케이프 + 셀 안 개행.
        let csv = "name,note\r\n\"Kim, Bob\",\"line1\nline2\"\r\n\"she said \"\"hi\"\"\",plain\r\n";
        let tmp = write_bytes(csv.as_bytes(), ".csv");
        let (json, truncated) = import_csv(tmp.path(), ',').unwrap();
        assert!(!truncated);
        let doc: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(doc["cells"]["A1"]["raw"], "name");
        assert_eq!(doc["cells"]["B1"]["raw"], "note");
        assert_eq!(doc["cells"]["A2"]["raw"], "Kim, Bob");
        assert_eq!(doc["cells"]["B2"]["raw"], "line1\nline2");
        assert_eq!(doc["cells"]["A3"]["raw"], "she said \"hi\"");
        assert_eq!(doc["cells"]["B3"]["raw"], "plain");
    }

    #[test]
    fn test_csv_import_cp949_fallback() {
        let (cp949_bytes, _, _) = encoding_rs::EUC_KR.encode("이름,나이\n김철수,30\n");
        let tmp = write_bytes(&cp949_bytes, ".csv");
        let (json, _truncated) = import_csv(tmp.path(), ',').unwrap();
        let doc: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(doc["cells"]["A1"]["raw"], "이름");
        assert_eq!(doc["cells"]["B1"]["raw"], "나이");
        assert_eq!(doc["cells"]["A2"]["raw"], "김철수");
        assert_eq!(doc["cells"]["B2"]["raw"], "30");
    }

    #[test]
    fn test_csv_import_truncates_beyond_limits() {
        // 1001행 × 53열 — 행/열 상한을 모두 넘긴다.
        let header: Vec<String> = (0..53).map(|i| format!("c{i}")).collect();
        let mut csv = header.join(",");
        csv.push('\n');
        for r in 0..1000 {
            let row: Vec<String> = (0..53).map(|c| format!("{r}-{c}")).collect();
            csv.push_str(&row.join(","));
            csv.push('\n');
        }
        let tmp = write_bytes(csv.as_bytes(), ".csv");
        let (json, truncated) = import_csv(tmp.path(), ',').unwrap();
        assert!(truncated);
        let doc: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(doc["rows"], 1000);
        assert_eq!(doc["cols"].as_array().unwrap().len(), 52);
        // 53번째 열(인덱스 52, col_letters(52)="BA")은 절단되어 존재하지 않는다.
        assert!(doc["cells"].get("BA1").is_none());
        // 1001번째 데이터 행(행 번호 1001, header가 행1이므로 데이터는 행2..1001)은 잘려나간다.
        assert!(doc["cells"].get("A1002").is_none());
    }

    #[test]
    fn test_csv_import_tsv_delimiter() {
        let tsv = "a\tb\n1\t2\n";
        let tmp = write_bytes(tsv.as_bytes(), ".tsv");
        let (json, _truncated) = import_csv(tmp.path(), '\t').unwrap();
        let doc: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(doc["cells"]["A1"]["raw"], "a");
        assert_eq!(doc["cells"]["B1"]["raw"], "b");
        assert_eq!(doc["cells"]["A2"]["raw"], "1");
        assert_eq!(doc["cells"]["B2"]["raw"], "2");
    }
}
