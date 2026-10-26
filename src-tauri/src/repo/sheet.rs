// repo: sheet (시트 섹션) — specs/features/sheet.md
//
// 두 가지 일을 한다:
//  1. `sheet_set_cells` 커맨드의 셀 패치 — body_md 의 시트 JSON 을 generic 하게 건드린다.
//  2. **투영** — 시트 JSON 이 사람/모델이 읽는 텍스트(FTS 색인 · 검색 스니펫 · 마크다운
//     export · AI 컨텍스트)로 새 나가지 않도록 TSV/마크다운 표로 바꾼다.
//
// 스키마 전체를 struct 로 모델링하지 않는다 — 패치는 `cells` 오브젝트만 건드리고 나머지
// (`v`/`rows`/`cols`/`charts`, 그리고 앞으로 붙을 무엇이든)는 손대지 않은 채 통과시켜야 한다.
// serde_json::Value 로 열고 그 자리만 고친 뒤 그대로 다시 쓴다.

use crate::error::{AppError, AppResult};
use crate::models::Section;
use crate::repo::sections;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub const KIND: &str = "sheet";

/// FTS 색인에 넣는 최대 행 수 (specs/features/sheet.md — 트라이그램 재색인 비용 상한).
pub const FTS_MAX_ROWS: usize = 200;

/// A1 표기 → (0-based col, 0-based row). `^[A-Z]{1,2}[1-9][0-9]*$` 만 통과한다.
/// `$` 절대참조 플래그는 셀 **키**에 올 수 없다(수식 안에서만 쓴다).
fn parse_a1(key: &str) -> Option<(usize, usize)> {
    let bytes = key.as_bytes();
    let letters = bytes.iter().take_while(|b| b.is_ascii_uppercase()).count();
    if letters == 0 || letters > 2 || letters == key.len() {
        return None;
    }
    let digits = &key[letters..];
    if digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let col = key[..letters]
        .bytes()
        .fold(0usize, |acc, b| acc * 26 + (b - b'A' + 1) as usize);
    let row: usize = digits.parse().ok()?;
    Some((col - 1, row - 1))
}

/// 셀 텍스트 한 칸을 한 줄/한 칸에 눌러 담는다 — 탭·개행이 그리드를 깨뜨리지 않도록.
/// (프런트 `src/lib/sheet/projection.ts::toTsv` 와 같은 규칙 — 두 구현의 출력이 같아야 한다.)
fn flatten(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

/// 시트 JSON → 내용이 있는 범위만큼의 2D 문자열 격자. None = 파싱 실패.
/// 행/열 수는 선언된 `rows`/`cols` 가 아니라 **실제로 셀이 있는 마지막 행/열**까지다 —
/// 초기 100×26 의 빈 칸이 검색 색인과 export 를 채우면 안 된다.
fn grid(json: &str, max_rows: Option<usize>) -> Option<Vec<Vec<String>>> {
    let v: Value = serde_json::from_str(json).ok()?;
    let cells = v.get("cells")?.as_object()?;
    let mut placed: Vec<(usize, usize, String)> = Vec::with_capacity(cells.len());
    let (mut w, mut h) = (0usize, 0usize);
    for (key, cell) in cells {
        let Some((c, r)) = parse_a1(key) else { continue };
        let raw = match cell.get("raw") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => continue,
            Some(other) => other.to_string(),
        };
        w = w.max(c + 1);
        h = h.max(r + 1);
        placed.push((r, c, raw));
    }
    if let Some(cap) = max_rows {
        h = h.min(cap);
    }
    let mut out = vec![vec![String::new(); w]; h];
    for (r, c, raw) in placed {
        if r < h {
            out[r][c] = flatten(&raw);
        }
    }
    Some(out)
}

/// 시트 JSON → TSV. None = 파싱 실패(호출자는 raw body 로 폴백한다).
/// `max_rows` = 상위 N 행만(FTS 색인용 상한).
pub fn sheet_to_tsv(json: &str, max_rows: Option<usize>) -> Option<String> {
    let g = grid(json, max_rows)?;
    Some(
        g.iter()
            .map(|row| row.join("\t"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// 시트 JSON → GFM 표(전체 행). 1행 = 헤더(specs/features/sheet.md 서식 결정).
/// None = 파싱 실패. 셀이 하나도 없으면 빈 문자열.
pub fn sheet_to_markdown_table(json: &str) -> Option<String> {
    let g = grid(json, None)?;
    if g.is_empty() {
        return Some(String::new());
    }
    let width = g[0].len().max(1);
    let row_line = |cells: &[String]| {
        let mut s = String::from("|");
        for i in 0..width {
            s.push(' ');
            s.push_str(&cells.get(i).map(|c| c.replace('|', "\\|")).unwrap_or_default());
            s.push_str(" |");
        }
        s
    };
    let mut out = row_line(&g[0]);
    out.push('\n');
    out.push('|');
    for _ in 0..width {
        out.push_str(" --- |");
    }
    for row in &g[1..] {
        out.push('\n');
        out.push_str(&row_line(row));
    }
    Some(out)
}

/// 다이어그램 JSON → FTS/검색용 텍스트 (노드 label, desc, tag, 엣지 label, 그룹 title 줄바꿈 결합).
/// JSON 파싱 실패 시 None.
pub fn diagram_to_text(json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(json).ok()?;
    let mut parts: Vec<String> = Vec::new();

    if let Some(nodes) = v.get("nodes").and_then(|n| n.as_array()) {
        for node in nodes {
            if let Some(label) = node.get("label").and_then(|l| l.as_str()) {
                let trimmed = label.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
            if let Some(desc) = node.get("desc").and_then(|d| d.as_str()) {
                let trimmed = desc.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
            if let Some(tag) = node.get("tag").and_then(|t| t.as_str()) {
                let trimmed = tag.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }

    if let Some(edges) = v.get("edges").and_then(|e| e.as_array()) {
        for edge in edges {
            if let Some(label) = edge.get("label").and_then(|l| l.as_str()) {
                let trimmed = label.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }

    if let Some(groups) = v.get("groups").and_then(|g| g.as_array()) {
        for group in groups {
            if let Some(title) = group.get("title").and_then(|t| t.as_str()) {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
        }
    }

    Some(parts.join("\n"))
}

/// 섹션 하나의 "사람/모델이 읽는 본문". sheet 면 TSV, diagram 이면 요소 텍스트 투영, 그 외(또는 JSON 파싱 실패)는 body_md 그대로.
pub fn section_text(body_md: &str, kind: &str, max_rows: Option<usize>) -> String {
    if kind == KIND {
        if let Some(tsv) = sheet_to_tsv(body_md, max_rows) {
            return tsv;
        }
    } else if kind == "diagram" {
        if let Some(text) = diagram_to_text(body_md) {
            return text;
        }
    }
    body_md.to_string()
}

/// 노트 하나의 섹션 본문을 합친 텍스트 (구분자 = 빈 줄, 예전 SQL group_concat 과 동일).
fn join_sections(secs: &[Section], max_rows: Option<usize>) -> String {
    secs.iter()
        .map(|s| section_text(&s.body_md, &s.kind, max_rows))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// 여러 노트의 본문 텍스트를 한 번에 — FTS upsert(1건) · 검색 스니펫(청크) 공용.
/// 섹션이 0개인 노트는 맵에 키가 생기지 않는다(호출부가 `unwrap_or_default`).
///
/// 예전엔 SQL `group_concat(s.body_md)` 하나로 끝났지만, sheet 섹션은 JSON 대신 TSV 로
/// 바꿔 넣어야 해서 Rust 에서 합친다 — 조회는 여전히 배치 1회(sections::load_for_ids).
pub fn note_body_texts(
    conn: &Connection,
    note_ids: &[String],
    max_rows: Option<usize>,
) -> AppResult<HashMap<String, String>> {
    Ok(sections::load_for_ids(conn, note_ids)?
        .into_iter()
        .map(|(note_id, secs)| (note_id, join_sections(&secs, max_rows)))
        .collect())
}

/// 노트 하나 버전.
pub fn note_body_text(
    conn: &Connection,
    note_id: &str,
    max_rows: Option<usize>,
) -> AppResult<String> {
    let ids = [note_id.to_string()];
    Ok(note_body_texts(conn, &ids, max_rows)?
        .remove(note_id)
        .unwrap_or_default())
}

/// `sheet_set_cells` — 시트 섹션의 셀 패치. `raw: null` = 삭제, 그 외는 raw 를 세팅하고
/// 함께 온 `fmt`/`dp`/`cur` 만 덮어쓴다(생략된 키는 기존 값 유지).
///
/// 쓰기는 `sections::update` 를 그대로 탄다 — updated_at 전파 · FTS upsert · 활동 기록이
/// `section_update` 와 완전히 같은 자리에서 한 번만 일어나도록.
pub fn set_cells(
    conn: &mut Connection,
    section_id: &str,
    patch: &std::collections::BTreeMap<String, Value>,
) -> AppResult<sections::SectionWrite> {
    // 읽기(아래 set_cells_once 첫 문장)와 쓰기 사이에 다른 쓰기(편집기 자동 저장·다른 셀 패치)가 끼면, 읽은
    // 본문에 패치를 얹어 쓰는 순간 그 쓰기를 덮는다. 그래서 읽을 때의 버전 토큰을 expected 로 보내 CONFLICT 로
    // 드러내고, 다시 읽어 다시 얹는다(셀 패치는 멱등이라 재시도가 안전하다). 2026-10-07 제안서가 찾은 결함.
    let mut attempt = 0;
    loop {
        match set_cells_once(conn, section_id, patch) {
            Err(AppError::Conflict(_)) if attempt < 2 => attempt += 1,
            other => return other,
        }
    }
}

fn set_cells_once(
    conn: &mut Connection,
    section_id: &str,
    patch: &std::collections::BTreeMap<String, Value>,
) -> AppResult<sections::SectionWrite> {
    let (body_md, kind, token): (String, String, Option<String>) = conn
        .query_row(
            "SELECT body_md, kind, updated_at FROM sections WHERE id=?1",
            [section_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(crate::error::db)?
        .ok_or_else(|| AppError::NotFound(format!("section not found: {section_id}")))?;
    if kind != KIND {
        return Err(AppError::Validation(format!(
            "section {section_id} is kind '{kind}', not '{KIND}'"
        )));
    }
    let mut doc: Value = serde_json::from_str(&body_md)
        .map_err(|e| AppError::Validation(format!("section body is not valid sheet JSON: {e}")))?;
    let root = doc
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("sheet JSON root must be an object".to_string()))?;
    if !root.get("cells").is_some_and(|c| c.is_object()) {
        root.insert("cells".to_string(), Value::Object(Map::new()));
    }
    let cells = root.get_mut("cells").unwrap().as_object_mut().unwrap();

    for (key, value) in patch {
        if parse_a1(key).is_none() {
            return Err(AppError::Validation(format!("not a valid A1 cell ref: {key}")));
        }
        let entry = value
            .as_object()
            .ok_or_else(|| AppError::Validation(format!("cell patch {key} must be an object")))?;
        match entry.get("raw") {
            None | Some(Value::Null) => {
                cells.remove(key);
            }
            Some(raw) => {
                let cell = cells
                    .entry(key.clone())
                    .or_insert_with(|| Value::Object(Map::new()));
                if !cell.is_object() {
                    *cell = Value::Object(Map::new());
                }
                let cell = cell.as_object_mut().unwrap();
                cell.insert("raw".to_string(), raw.clone());
                // ponytail: fmt/dp/cur 만 오버라이드 대상 — 셀 굵게·색은 후속(스펙 "안 함" 칸).
                for k in ["fmt", "dp", "cur"] {
                    if let Some(v) = entry.get(k) {
                        if v.is_null() {
                            cell.remove(k);
                        } else {
                            cell.insert(k.to_string(), v.clone());
                        }
                    }
                }
            }
        }
    }

    let body = serde_json::to_string(&doc).map_err(|e| AppError::Io(e.to_string()))?;
    // ai_origin: None (보존) — 시트 셀 패치는 저작권 판정 지점이 아니다
    // (specs/commands/sections.yaml section_update notes).
    // 토큰이 없는 구형 행(updated_at NULL)은 어떤 expected 와도 안 맞으므로 예전처럼 토큰 없이 쓴다.
    // 토큰을 보내는 쓰기는 휴지통 노트를 거부한다(update_checked 규약) — 지운 노트의 시트를 고칠 이유가 없다.
    sections::update_checked(conn, section_id, None, Some(body), None, token.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::params;
    use std::collections::BTreeMap;

    /// 프런트 `src/lib/sheet/projection.test.ts` 와 **글자 그대로 같은 픽스처**다.
    /// 두 구현의 toTsv 출력이 갈라지면 둘 중 하나의 테스트가 깨진다.
    const FIXTURE: &str = r#"{"v":1,"rows":100,"cols":[{"w":96},{"w":96},{"w":96}],"cells":{"A1":{"raw":"항목"},"B1":{"raw":"금액"},"C1":{"raw":"메모"},"A2":{"raw":"커피"},"B2":{"raw":"4500"},"A3":{"raw":"점심"},"B3":{"raw":"12000"},"C3":{"raw":"회사 근처"},"B4":{"raw":"=SUM(B2:B3)"}},"charts":[]}"#;
    const FIXTURE_TSV: &str =
        "항목\t금액\t메모\n커피\t4500\t\n점심\t12000\t회사 근처\n\t=SUM(B2:B3)\t";

    #[test]
    fn parse_a1_accepts_and_rejects() {
        assert_eq!(parse_a1("A1"), Some((0, 0)));
        assert_eq!(parse_a1("Z1"), Some((25, 0)));
        assert_eq!(parse_a1("AA10"), Some((26, 9)));
        assert_eq!(parse_a1("AZ1000"), Some((51, 999)));
        for bad in ["", "A", "1", "A0", "a1", "AAA1", "A1B", "$A$1", "A 1"] {
            assert!(parse_a1(bad).is_none(), "{bad} must be rejected");
        }
    }

    #[test]
    fn tsv_matches_the_shared_fixture() {
        assert_eq!(sheet_to_tsv(FIXTURE, None).unwrap(), FIXTURE_TSV);
    }

    #[test]
    fn tsv_caps_rows_and_bails_on_garbage() {
        assert_eq!(sheet_to_tsv(FIXTURE, Some(2)).unwrap(), "항목\t금액\t메모\n커피\t4500\t");
        assert_eq!(sheet_to_tsv("not json", None), None);
        assert_eq!(sheet_to_tsv(r#"{"v":1}"#, None), None, "cells 없으면 시트가 아니다");
        assert_eq!(sheet_to_tsv(r#"{"cells":{}}"#, None).unwrap(), "");
    }

    #[test]
    fn markdown_table_puts_row_1_in_the_header() {
        assert_eq!(
            sheet_to_markdown_table(FIXTURE).unwrap(),
            "| 항목 | 금액 | 메모 |\n| --- | --- | --- |\n| 커피 | 4500 |  |\n| 점심 | 12000 | 회사 근처 |\n|  | =SUM(B2:B3) |  |"
        );
        assert_eq!(sheet_to_markdown_table("nope"), None);
        assert_eq!(sheet_to_markdown_table(r#"{"cells":{}}"#).unwrap(), "");
    }

    #[test]
    fn markdown_table_escapes_pipes_and_flattens_newlines() {
        let json = r#"{"cells":{"A1":{"raw":"a|b"},"B1":{"raw":"two\nlines"}}}"#;
        assert_eq!(
            sheet_to_markdown_table(json).unwrap(),
            "| a\\|b | two lines |\n| --- | --- |"
        );
    }

    fn setup() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 'title', 1000, ?2, ?2)",
            params![folder_id, crate::util::now_iso()],
        )
        .unwrap();
        (conn, "n1".to_string())
    }

    fn patch(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn body_of(conn: &Connection, id: &str) -> Value {
        let s: String = conn
            .query_row("SELECT body_md FROM sections WHERE id=?1", [id], |r| r.get(0))
            .unwrap();
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn set_cells_patches_and_removes() {
        let (mut conn, note_id) = setup();
        let sec = sections::create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            FIXTURE.to_string(),
            Some(KIND.to_string()),
        )
        .unwrap();

        set_cells(
            &mut conn,
            &sec.id,
            &patch(&[
                ("B2", serde_json::json!({ "raw": "5000", "fmt": "currency", "cur": "KRW" })),
                ("D1", serde_json::json!({ "raw": "새 열" })),
                ("C3", serde_json::json!({ "raw": null })),
            ]),
        )
        .unwrap();

        let doc = body_of(&conn, &sec.id);
        assert_eq!(doc["cells"]["B2"]["raw"], "5000");
        assert_eq!(doc["cells"]["B2"]["fmt"], "currency");
        assert_eq!(doc["cells"]["B2"]["cur"], "KRW");
        assert_eq!(doc["cells"]["D1"]["raw"], "새 열");
        assert!(doc["cells"].get("C3").is_none(), "raw:null 은 키를 지운다");
        // 건드리지 않은 필드는 그대로 통과한다.
        assert_eq!(doc["v"], 1);
        assert_eq!(doc["rows"], 100);
        assert_eq!(doc["cols"].as_array().unwrap().len(), 3);
        assert_eq!(doc["cells"]["A1"]["raw"], "항목");

        // 부분 패치는 기존 fmt 를 지우지 않는다.
        set_cells(&mut conn, &sec.id, &patch(&[("B2", serde_json::json!({ "raw": "6000" }))])).unwrap();
        let doc = body_of(&conn, &sec.id);
        assert_eq!(doc["cells"]["B2"]["raw"], "6000");
        assert_eq!(doc["cells"]["B2"]["fmt"], "currency");
    }

    #[test]
    fn set_cells_rejects_non_sheet_bad_ref_and_missing() {
        let (mut conn, note_id) = setup();
        let text = sections::create(&mut conn, &note_id, None).unwrap();
        let err = set_cells(&mut conn, &text.id, &patch(&[("A1", serde_json::json!({"raw":"x"}))]));
        assert!(matches!(err, Err(AppError::Validation(_))), "got {err:?}");

        let sheet = sections::create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            r#"{"v":1,"rows":100,"cols":[],"cells":{}}"#.to_string(),
            Some(KIND.to_string()),
        )
        .unwrap();
        let err = set_cells(&mut conn, &sheet.id, &patch(&[("A0", serde_json::json!({"raw":"x"}))]));
        assert!(matches!(err, Err(AppError::Validation(_))), "got {err:?}");
        let err = set_cells(&mut conn, &sheet.id, &patch(&[("nope", serde_json::json!({"raw":"x"}))]));
        assert!(matches!(err, Err(AppError::Validation(_))), "got {err:?}");

        let err = set_cells(&mut conn, "no-such-section", &patch(&[]));
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn set_cells_rejects_unparseable_body() {
        let (mut conn, note_id) = setup();
        let sec = sections::create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            "이건 JSON 이 아니다".to_string(),
            Some(KIND.to_string()),
        )
        .unwrap();
        let err = set_cells(&mut conn, &sec.id, &patch(&[("A1", serde_json::json!({"raw":"x"}))]));
        assert!(matches!(err, Err(AppError::Validation(_))), "got {err:?}");
    }

    #[test]
    /// 시트 섹션의 JSON 중괄호는 검색 색인에 들어가지 않고, 셀 값은 들어간다.
    fn fts_indexes_the_tsv_not_the_json() {
        let (mut conn, note_id) = setup();
        sections::create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            FIXTURE.to_string(),
            Some(KIND.to_string()),
        )
        .unwrap();
        let body: String = conn
            .query_row("SELECT body FROM notes_fts WHERE note_id=?1", [&note_id], |r| r.get(0))
            .unwrap();
        assert!(body.contains("커피"), "셀 값은 색인된다: {body}");
        assert!(!body.contains('{'), "시트 JSON 이 색인에 샜다: {body}");
        assert!(!body.contains("\"raw\""), "시트 JSON 이 색인에 샜다: {body}");
    }

    #[test]
    fn note_body_text_mixes_text_and_sheet_sections() {
        let (mut conn, note_id) = setup();
        sections::create_with_body(&mut conn, &note_id, None, "산문 본문".to_string()).unwrap();
        sections::create_with_body_and_kind(
            &mut conn,
            &note_id,
            None,
            FIXTURE.to_string(),
            Some(KIND.to_string()),
        )
        .unwrap();
        let text = note_body_text(&conn, &note_id, Some(FTS_MAX_ROWS)).unwrap();
        assert_eq!(text, format!("산문 본문\n\n{FIXTURE_TSV}"));
    }

    #[test]
    fn diagram_projection_extracts_labels_desc_tags_and_groups() {
        let json = r#"{
            "v": 1,
            "route": "curve",
            "nodes": [
                {"id": "n1", "label": "인천공항", "desc": "오전 9:40 출발", "tag": "D-3"},
                {"id": "n2", "label": "나리타공항"}
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "label": "비행 2시간"}
            ],
            "groups": [
                {"id": "g1", "title": "1일차"}
            ]
        }"#;

        let text = section_text(json, "diagram", None);
        assert_eq!(
            text,
            "인천공항\n오전 9:40 출발\nD-3\n나리타공항\n비행 2시간\n1일차"
        );

        // JSON 파싱 실패 시 원본 그대로 반환
        let invalid = "not valid json";
        assert_eq!(section_text(invalid, "diagram", None), invalid);
    }
}
