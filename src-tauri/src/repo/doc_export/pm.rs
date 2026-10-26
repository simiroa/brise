// repo: doc_export::pm — ProseMirror JSON 도우미 + 표 격자 배치 (HWPX 내보내기에서 떼어 낸 형식 무관 부분, W4-0)
//
// 프런트가 섹션마다 보내는 `getJSON()` 을 읽는 얇은 접근자와, 형식과 무관한 변환(CSS 색 → `#RRGGBB`, 안전한 링크 대상, 표 칸의
// 격자 배치 · 열 너비, 그림 크기)을 모았다. 출력 형식(OWPML·WordprocessingML)에 대한 지식은 여기에 없다 — 정렬은 형식 무관
// `Align` 으로 내놓고 각 작성기가 자기 토큰으로 바꾼다. 길이는 단위 무관(작성기가 넘긴 단위 그대로 돌려준다).
use crate::error::{AppError, AppResult};
use serde_json::Value;

/// 표 한 개의 격자 칸 수(병합 면적 합) · 병합 폭·높이 · 열 수 상한 — 가져오기(`doc_import`)와 같은 값.
const MAX_GRID_CELLS: usize = 200_000;
const MAX_COLSPAN: i64 = 200;
const MAX_ROWSPAN: i64 = 1000;
const MAX_COLS: usize = 200;

/// CSS 색 한 개 → `#RRGGBB`(대문자). `#rgb`·`#rrggbb`·`#rrggbbaa`, `rgb()/rgba()`(쉼표·공백·퍼센트), 기본 색 이름.
/// 알파가 0 이면 "색 없음". 형광펜·글자색·셀 배경이 전부 이 한 함수를 지난다 — XML 속성에 들어가는 색은 항상 이 모양이다.
pub(super) fn css_color(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    if let Some(hex) = s.strip_prefix('#') {
        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let v = |i: usize, n: usize| u8::from_str_radix(&hex[i..i + n], 16).ok();
        let (r, g, b, a) = match hex.len() {
            3 => {
                let d = |i: usize| v(i, 1).map(|x| x * 17);
                (d(0)?, d(1)?, d(2)?, 255)
            }
            6 => (v(0, 2)?, v(2, 2)?, v(4, 2)?, 255),
            8 => (v(0, 2)?, v(2, 2)?, v(4, 2)?, v(6, 2)?),
            _ => return None,
        };
        return (a > 0).then(|| format!("#{r:02X}{g:02X}{b:02X}"));
    }
    if let Some(inner) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")).and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split(|c: char| c == ',' || c == '/' || c.is_whitespace()).filter(|p| !p.is_empty()).collect();
        if parts.len() < 3 || parts.len() > 4 {
            return None;
        }
        let chan = |p: &str| -> Option<u8> {
            let (num, pct) = match p.strip_suffix('%') {
                Some(n) => (n, true),
                None => (p, false),
            };
            let x: f64 = num.parse().ok()?;
            let x = if pct { x * 2.55 } else { x };
            x.is_finite().then(|| x.round().clamp(0.0, 255.0) as u8)
        };
        if let Some(a) = parts.get(3) {
            let (num, pct) = match a.strip_suffix('%') {
                Some(n) => (n, true),
                None => (*a, false),
            };
            let a: f64 = num.parse().ok()?;
            let a = if pct { a / 100.0 } else { a };
            if !(a > 0.0) {
                return None;
            }
        }
        return Some(format!("#{:02X}{:02X}{:02X}", chan(parts[0])?, chan(parts[1])?, chan(parts[2])?));
    }
    let named = match s.as_str() {
        "black" => "#000000",
        "white" => "#FFFFFF",
        "red" => "#FF0000",
        "green" => "#008000",
        "blue" => "#0000FF",
        "yellow" => "#FFFF00",
        "orange" => "#FFA500",
        "purple" => "#800080",
        "gray" | "grey" => "#808080",
        "silver" => "#C0C0C0",
        "maroon" => "#800000",
        "navy" => "#000080",
        "teal" => "#008080",
        "lime" => "#00FF00",
        "aqua" | "cyan" => "#00FFFF",
        "fuchsia" | "magenta" => "#FF00FF",
        "pink" => "#FFC0CB",
        "brown" => "#A52A2A",
        _ => return None,
    };
    Some(named.to_string())
}

// ── JSON 도우미 ───────────────────────────────────────────────────────────────

pub(super) fn ty(n: &Value) -> &str {
    n.get("type").and_then(Value::as_str).unwrap_or("")
}

pub(super) fn kids(n: &Value) -> &[Value] {
    n.get("content").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

pub(super) fn attr<'a>(n: &'a Value, key: &str) -> Option<&'a Value> {
    n.get("attrs").and_then(|a| a.get(key)).filter(|v| !v.is_null())
}

pub(super) fn attr_str<'a>(n: &'a Value, key: &str) -> Option<&'a str> {
    attr(n, key).and_then(Value::as_str)
}

/// 숫자 속성 — JSON 숫자와 숫자 문자열 둘 다 받는다(속성은 비어 있거나 null 일 수 있다).
pub(super) fn attr_f64(n: &Value, key: &str) -> Option<f64> {
    let v = attr(n, key)?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).filter(|x| x.is_finite())
}

pub(super) fn marks(n: &Value) -> &[Value] {
    n.get("marks").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

pub(super) fn mark_attr<'a>(m: &'a Value, key: &str) -> Option<&'a str> {
    m.get("attrs").and_then(|a| a.get(key)).and_then(Value::as_str)
}

/// 노드 안의 글자를 이어 붙인다. `text` 문자열을 가진 노드는 타입이 낯설어도 그 글자를 쓴다(내용이 사라지는 쪽이 더 나쁘다).
pub(super) fn plain_text(n: &Value, out: &mut String) {
    if let Some(t) = n.get("text").and_then(Value::as_str) {
        out.push_str(t);
        return;
    }
    if ty(n) == "hardBreak" {
        out.push('\n');
    }
    for k in kids(n) {
        plain_text(k, out);
    }
}

/// 문단·표 칸 정렬 — 형식 무관 값(OWPML `LEFT` · WordprocessingML `left`/`both` 로의 변환은 작성기 몫).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Align {
    Left,
    Center,
    Right,
    Justify,
}

pub(super) fn align_of(s: Option<&str>) -> Option<Align> {
    match s {
        Some("center") => Some(Align::Center),
        Some("right") => Some(Align::Right),
        Some("justify") => Some(Align::Justify),
        Some("left") => Some(Align::Left),
        _ => None,
    }
}

pub(super) struct LinkTarget {
    pub(super) href: String,
    pub(super) mail: bool,
}

/// http/https/mailto 만 링크로 둔다(가져오기 `safe_href` 와 같은 허용 범위) — `javascript:`·`file:`·`note:` 는 링크 없이 글자만 남긴다.
pub(super) fn link_target(m: &Value) -> Option<LinkTarget> {
    let href = mark_attr(m, "href")?.trim();
    if href.is_empty() || href.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let lower = href.to_ascii_lowercase();
    let mail = lower.starts_with("mailto:");
    if !(mail || lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    Some(LinkTarget { href: href.to_string(), mail })
}

/// 머리글 칸 안의 모든 글자 노드에 굵게 마크를 얹은 사본. 칸 안의 구조(문단·목록·표)는 그대로 두고 text 노드만 건드린다.
pub(super) fn bold_all(nodes: &[Value]) -> Vec<Value> {
    fn walk(v: &Value) -> Value {
        let mut v = v.clone();
        if ty(&v) == "text" {
            let has = marks(&v).iter().any(|m| ty(m) == "bold");
            if !has {
                let mut ms = marks(&v).to_vec();
                ms.push(serde_json::json!({ "type": "bold" }));
                v["marks"] = Value::Array(ms);
            }
            return v;
        }
        if let Some(arr) = v.get("content").and_then(Value::as_array) {
            let walked: Vec<Value> = arr.iter().map(walk).collect();
            v["content"] = Value::Array(walked);
        }
        v
    }
    nodes.iter().map(walk).collect()
}

// ── 표 격자 배치 ──────────────────────────────────────────────────────────────

/// 표 한 칸의 격자 배치 결과.
pub(super) struct CellRef<'v> {
    /// None = 어떤 칸도 덮지 않은 자리를 메우려 합성한 빈 칸.
    pub(super) node: Option<&'v Value>,
    pub(super) header: bool,
    pub(super) colspan: usize,
    pub(super) rowspan: usize,
    pub(super) col: usize,
}

/// 배치된 표 — 행마다 (왼쪽부터 정렬된) 칸들. 모든 행·열 자리가 정확히 한 칸에 덮인다.
pub(super) struct Grid<'v> {
    pub(super) rows: Vec<Vec<CellRef<'v>>>,
    pub(super) nrows: usize,
    pub(super) ncols: usize,
}

/// 표 노드 → 격자. 행이 없거나 열이 없으면 `None`(쓸 표가 없다). `tick` 은 칸 하나를 읽을 때마다 부르는 문서 전체 노드 예산이다
/// (실패하면 그대로 돌려준다). 형식(HWPX·DOCX …)과 무관한 부분만 — 열 너비·단위 환산은 형식별 작성기가 한다.
pub(super) fn place_grid<'v>(n: &'v Value, tick: &mut dyn FnMut() -> AppResult<()>) -> AppResult<Option<Grid<'v>>> {
    let row_nodes: Vec<&Value> = kids(n).iter().filter(|r| ty(r) == "tableRow").collect();
    let nrows = row_nodes.len();
    if nrows == 0 {
        return Ok(None);
    }
    // 격자 배치 — 가려진 칸은 파일에 아예 없다. busy[c] = 열 c 가 위 행에서 내려온 병합 칸에 막힌 마지막 행 + 1.
    let mut rows: Vec<Vec<CellRef>> = Vec::with_capacity(nrows);
    let mut busy: Vec<usize> = Vec::new();
    let mut ncols = 0usize;
    let mut budget = MAX_GRID_CELLS;
    for (r, row) in row_nodes.iter().enumerate() {
        let mut cells = Vec::new();
        let mut c = 0usize;
        for cell in kids(row).iter().filter(|k| matches!(ty(k), "tableCell" | "tableHeader")) {
            tick()?;
            let mut colspan = (attr_f64(cell, "colspan").unwrap_or(1.0) as i64).clamp(1, MAX_COLSPAN) as usize;
            let rowspan = ((attr_f64(cell, "rowspan").unwrap_or(1.0) as i64).clamp(1, MAX_ROWSPAN) as usize).min(nrows - r);
            while busy.get(c).is_some_and(|end| *end > r) {
                c += 1;
            }
            // 가로 병합이 위 행에서 내려온 병합 칸 위로 겹치면 거기서 끊는다 — 겹친 칸은 한글이 표 전체를 깨진 것으로 본다.
            // (raw HTML 표는 겹침을 그대로 만들 수 있다. 마크다운 파이프 표는 파서가 막는다.)
            if let Some(k) = (1..colspan).find(|k| busy.get(c + k).is_some_and(|end| *end > r)) {
                colspan = k;
            }
            let area = colspan * rowspan;
            if area > budget || c + colspan > MAX_COLS {
                return Err(AppError::Validation("table is too complex to export".to_string()));
            }
            budget -= area;
            if busy.len() < c + colspan {
                busy.resize(c + colspan, 0);
            }
            for end in &mut busy[c..c + colspan] {
                *end = (*end).max(r + rowspan);
            }
            cells.push(CellRef { node: Some(cell), header: ty(cell) == "tableHeader", colspan, rowspan, col: c });
            c += colspan;
            ncols = ncols.max(c);
        }
        rows.push(cells);
    }
    if ncols == 0 {
        return Ok(None);
    }
    // 격자 메우기 — raw HTML 표(`<tr><td>a<td>b<td>c</tr><tr><td>d</tr>`, 짧은 rowspan, 빈 `<tr>`)는 어떤 칸도 덮지 않는
    // 자리를 만든다(마크다운 파이프 표는 파서가 채워 준다). rowCnt×colCnt 격자에 구멍이 있으면 한글이 표를 거부하거나 깨뜨리므로,
    // 모든 호출자가 지나는 여기서 빈 칸 하나(1×1, 빈 문단)로 메운다. 자리 수는 위 면적 예산과 같은 상한으로 막는다.
    if nrows * ncols > MAX_GRID_CELLS {
        return Err(AppError::Validation("table is too complex to export".to_string()));
    }
    let mut covered = vec![false; nrows * ncols];
    for (r, row) in rows.iter().enumerate() {
        for cell in row {
            for rr in r..r + cell.rowspan {
                covered[rr * ncols + cell.col..rr * ncols + cell.col + cell.colspan].fill(true);
            }
        }
    }
    for (r, row) in rows.iter_mut().enumerate() {
        let had = row.len();
        for c in (0..ncols).filter(|c| !covered[r * ncols + c]) {
            row.push(CellRef { node: None, header: false, colspan: 1, rowspan: 1, col: c });
        }
        if row.len() != had {
            row.sort_by_key(|cell| cell.col);
        }
    }
    // 격자를 메운 뒤에도 칸이 하나도 없는 행 = 위 행의 병합 칸이 모든 열을 덮은 행이다(빈 `<tr>` 은 위에서 빈 칸으로 채워졌다).
    // 그런 행은 걷고, 그 행을 가로지르던 병합 칸의 rowspan 은 걷는 행 수만큼 줄인다 — 줄이지 않으면 rowspan 이 표 끝을 넘고 아래 행이
    // 한 칸씩 어긋난다(가져오기 `ir::drop_empty_rows` 와 같은 계산). 셀마다 걷는 행을 세지 않고 "앞에서부터의 빈 행 누계"로 뺀다.
    if rows.iter().any(Vec::is_empty) {
        // empties[i] = rows[..i] 안의 빈 행 수.
        let mut empties: Vec<usize> = Vec::with_capacity(rows.len() + 1);
        empties.push(0);
        for row in &rows {
            empties.push(empties[empties.len() - 1] + usize::from(row.is_empty()));
        }
        for (r, row) in rows.iter_mut().enumerate() {
            for cell in row {
                // 이 셀이 덮는 행은 [r, r + rowspan) — 자기 행(r)은 비어 있지 않으니 (r, r + rowspan) 안의 빈 행만 뺀다.
                let end = (r + cell.rowspan).min(empties.len() - 1);
                cell.rowspan -= empties[end] - empties[r + 1];
            }
        }
        rows.retain(|r| !r.is_empty());
    }
    let nrows = rows.len();
    Ok(Some(Grid { rows, nrows, ncols }))
}

// ── 열 너비 · 그림 크기 ───────────────────────────────────────────────────────

/// 열 너비 — colwidth(px, 칸이 차지한 열마다 하나) → 형식 단위(`per_px` = 1px 당 단위 수). 모르는 열은 아는 열의 평균(하나도 없으면
/// 균등), 합이 `avail`(쓸 수 있는 폭)을 넘으면 비례 축소, 열마다 `min_w` 아래로는 내려가지 않는다(`avail` 이 모자라면 그 균등분 아래로는 안 간다).
pub(super) fn column_widths(grid: &Grid, avail: i64, per_px: f64, min_w: i64) -> Vec<i64> {
    let ncols = grid.ncols;
    // 열 하나가 본문 폭보다 넓을 수는 없으므로(어차피 비례 축소된다) 읽는 자리에서 그 폭으로 자른다. 노트 본문의 `colwidth=1e300` 이
    // `w * per_px as i64` 포화 → 합 오버플로(debug panic / release 음수 폭)로 이어져 그 노트의 내보내기가 항상 죽었다.
    let max_px = avail as f64 / per_px;
    let mut raw: Vec<Option<f64>> = vec![None; ncols];
    for row in &grid.rows {
        for cell in row {
            if let Some(arr) = cell.node.and_then(|n| attr(n, "colwidth")).and_then(Value::as_array) {
                for k in 0..cell.colspan {
                    if let Some(px) = arr.get(k).and_then(Value::as_f64).filter(|p| p.is_finite() && *p > 0.0) {
                        raw[cell.col + k].get_or_insert(px.min(max_px));
                    }
                }
            }
        }
    }
    let known: Vec<f64> = raw.iter().flatten().copied().collect();
    let mut widths: Vec<i64> = if known.is_empty() {
        vec![avail / ncols as i64; ncols]
    } else {
        let avg = known.iter().sum::<f64>() / known.len() as f64;
        raw.iter().map(|w| (w.unwrap_or(avg) * per_px) as i64).collect()
    };
    for w in &mut widths {
        *w = (*w).max(min_w);
    }
    let total: i64 = widths.iter().sum();
    if total > avail {
        for w in &mut widths {
            *w = ((*w as f64) * (avail as f64) / (total as f64)) as i64;
            *w = (*w).max(min_w.min(avail / ncols as i64));
        }
    }
    widths
}

/// 그림 폭 속성이 없을 때(= 에디터 기본 40%). 이 크기보다 큰 그림은 쪽 본문 높이의 이 비율 안으로 줄인다(한 쪽에 다 못 들어가는 그림이 잘리지 않게).
const DEFAULT_IMAGE_PCT: f64 = 40.0;
pub(super) const IMAGE_MAX_PAGE_FRACTION: f64 = 0.95;

/// 그림 노드의 폭 속성(`"70%"`) → 퍼센트. 없거나 이상하면 에디터 기본, 100 을 넘지 않는다.
pub(super) fn image_pct(n: &Value) -> f64 {
    attr_str(n, "width")
        .and_then(|w| w.trim().strip_suffix('%'))
        .and_then(|w| w.trim().parse::<f64>().ok())
        .filter(|p| p.is_finite() && *p > 0.0)
        .unwrap_or(DEFAULT_IMAGE_PCT)
        .min(100.0)
}

/// 그림 크기 (폭, 높이) — 쓸 수 있는 폭(`avail_w`)의 `pct`% 에 원본 비율(`ow`:`oh`)을 지키고, 높이가 쪽 본문 높이(`body_h`)를 넘으면 줄인다.
/// 입력 길이들은 같은 단위(HWPUNIT · EMU …)이면 되고, 결과도 그 단위다.
pub(super) fn fit_image(avail_w: i64, body_h: i64, pct: f64, ow: i64, oh: i64) -> (i64, i64) {
    let mut cw = ((avail_w as f64) * pct / 100.0).round().max(1.0);
    let mut ch = (cw * oh as f64 / ow as f64).round().max(1.0);
    let max_h = (body_h as f64) * IMAGE_MAX_PAGE_FRACTION;
    if ch > max_h {
        cw = (cw * max_h / ch).round().max(1.0);
        ch = max_h.round();
    }
    (cw as i64, ch as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_colors_are_normalised_and_junk_is_rejected() {
        for (input, want) in [
            ("#ff0000", Some("#FF0000")),
            ("#f00", Some("#FF0000")),
            ("#FF000080", Some("#FF0000")),
            ("#ff000000", None),
            ("rgb(255, 230, 153)", Some("#FFE699")),
            ("rgba(0, 128, 0, 0.5)", Some("#008000")),
            ("rgba(0, 0, 0, 0)", None),
            ("rgb(100% 0% 0%)", Some("#FF0000")),
            ("rgb(300, -5, 12.4)", Some("#FF000C")),
            ("Red", Some("#FF0000")),
            ("transparent", None),
            ("red\" onclick=\"x", None),
            ("#12345", None),
            ("url(x)", None),
            ("", None),
        ] {
            assert_eq!(css_color(input).as_deref(), want, "{input:?}");
        }
    }

    fn cell(colspan: u32, rowspan: u32) -> Value {
        serde_json::json!({ "type": "tableCell", "attrs": { "colspan": colspan, "rowspan": rowspan }, "content": [] })
    }

    fn row(cells: Vec<Value>) -> Value {
        serde_json::json!({ "type": "tableRow", "content": cells })
    }

    fn grid_of(rows: Vec<Value>) -> Option<(usize, usize, Vec<Vec<(usize, usize, usize)>>)> {
        let t = serde_json::json!({ "type": "table", "content": rows });
        let g = place_grid(&t, &mut || Ok(())).unwrap()?;
        let cells = g.rows.iter().map(|r| r.iter().map(|c| (c.col, c.colspan, c.rowspan)).collect()).collect();
        Some((g.nrows, g.ncols, cells))
    }

    #[test]
    fn rows_covered_end_to_end_by_merges_are_dropped_and_rowspans_shrink() {
        // 전 열이 가려진 행(둘째)은 걷히고, 그 행을 가로지르던 칸의 rowspan 이 준다 — (열, colspan, rowspan).
        let g = grid_of(vec![row(vec![cell(1, 3), cell(1, 2)]), row(vec![]), row(vec![cell(1, 1)])]).unwrap();
        assert_eq!(g, (2, 2, vec![vec![(0, 1, 2), (1, 1, 1)], vec![(1, 1, 1)]]));
        // 덮이지 않은 자리가 있는 빈 행은 남는다(빈 칸으로 메워진다).
        let g = grid_of(vec![row(vec![cell(1, 3), cell(1, 1)]), row(vec![]), row(vec![cell(1, 1)])]).unwrap();
        assert_eq!((g.0, g.1), (3, 2));
        assert_eq!(g.2[0][0], (0, 1, 3));
        // 연속으로 가려진 행 둘 — 병합 칸 하나만 남는다.
        let g = grid_of(vec![row(vec![cell(2, 3)]), row(vec![]), row(vec![])]).unwrap();
        assert_eq!(g, (1, 2, vec![vec![(0, 2, 1)]]));
        // 칸이 없는 표 · 행이 없는 표.
        assert!(grid_of(vec![row(vec![])]).is_none() && grid_of(vec![]).is_none());
    }
}
