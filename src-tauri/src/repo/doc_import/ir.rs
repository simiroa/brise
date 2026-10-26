// repo: doc_import::ir — 중간 표현(Block)과 후처리 (HWPX 가져오기에서 떼어 낸 형식 무관 부분, W4-0)
//
// 파서(형식별)는 문서를 이 표현으로 만들고, 렌더(`html.rs`)는 이 표현에서만 HTML 을 쓴다. 후처리(빈 문단 접기 · 제목 추정 ·
// 표 열 배치 · 표 머리글)는 형식과 무관하다 — 파서가 컨테이너(본문·셀·각주)를 다 만든 뒤에 호출한다.
use super::{DocImportDropped, ImageData};
use crate::error::{AppError, AppResult};

/// 표 한 개의 격자 칸 수(병합 면적 합) 상한과, 병합 폭·높이 상한.
const MAX_GRID_CELLS: usize = 500_000;
pub(super) const MAX_COLSPAN: usize = 200;
pub(super) const MAX_ROWSPAN: usize = 1000;
/// 개요 문단이라도 이보다 길면 제목이 아니라 본문 항목(공문 "1. 2. 가." 번호 체계)이므로 문단으로 둔다.
pub(super) const MAX_OUTLINE_HEADING_CHARS: usize = 150;
/// 크기로 제목을 추정할 때의 글자 수 상한(조사: 보수적으로).
pub(super) const MAX_INFERRED_HEADING_CHARS: usize = 60;

/// ① 파싱의 결과 — 아직 HTML 이 아니다(`render`).
pub struct Parsed {
    pub(super) blocks: Vec<Block>,
    pub(super) footnotes: Vec<Vec<Block>>,
    pub images: Vec<ImageData>,
    pub dropped: Vec<DocImportDropped>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(super) enum Align {
    #[default]
    Left,
    Center,
    Right,
    Justify,
}

impl Align {
    pub(super) fn css(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
            Align::Justify => "justify",
        }
    }
}

// ── 중간 표현 ─────────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Default)]
pub(super) struct Style {
    pub(super) bold: bool,
    pub(super) italic: bool,
    pub(super) underline: bool,
    pub(super) strike: bool,
    pub(super) mark: bool,
    pub(super) code: bool,
    pub(super) color: Option<String>,
    pub(super) height: u32,
}

pub(super) struct Piece {
    pub(super) text: String,
    pub(super) st: Style,
    pub(super) link: Option<String>,
}

pub(super) enum Inline {
    Text(Piece),
    Br,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Kind {
    Normal,
    Heading(u8),
    Ul,
    Ol,
}

pub(super) struct Para {
    pub(super) kind: Kind,
    pub(super) level: u8,
    pub(super) align: Align,
    pub(super) indent: u8,
    /// 번호 목록 항목의 번호(DOCX 가 센다). 목록이 끊겼다 이어질 때 `<ol start>` 로 이어 세게 한다. 모르면 `None`(= 1부터).
    pub(super) ord: Option<u32>,
    pub(super) inl: Vec<Inline>,
}

pub(super) struct Cell {
    pub(super) header: bool,
    pub(super) colspan: usize,
    pub(super) rowspan: usize,
    /// cellSz 너비(px = HWPUNIT / 75).
    pub(super) width_px: Option<u32>,
    /// 가로로 차지한 열마다 하나(prosemirror-tables 규약) — 모든 열 너비를 알 때만.
    pub(super) colwidth: Option<Vec<u32>>,
    pub(super) bg: Option<String>,
    pub(super) blocks: Vec<Block>,
}

pub(super) struct Table {
    pub(super) rows: Vec<Vec<Cell>>,
}

pub(super) struct ImgBlock {
    pub(super) idx: usize,
    pub(super) width_pct: Option<u32>,
}

pub(super) enum Block {
    Para(Para),
    Table(Table),
    Image(ImgBlock),
}

pub(super) fn inl_blank(inl: &[Inline]) -> bool {
    inl.iter().all(|i| match i {
        Inline::Text(p) => p.text.chars().all(char::is_whitespace),
        Inline::Br => true,
    })
}

pub(super) fn inl_text(inl: &[Inline]) -> String {
    let mut s = String::new();
    for i in inl {
        if let Inline::Text(p) = i {
            s.push_str(&p.text);
        }
    }
    s
}

pub(super) fn is_empty_para(b: &Block) -> bool {
    matches!(b, Block::Para(p) if p.kind == Kind::Normal && inl_blank(&p.inl))
}

pub(super) fn empty_para() -> Block {
    Block::Para(Para { kind: Kind::Normal, level: 0, align: Align::Left, indent: 0, ord: None, inl: Vec::new() })
}

/// 문단 하나를 내보낸다. 빈 문단은 제목·목록 모양을 벗고, 앞뒤 `<br>` 는 버린다.
pub(super) fn push_para(out: &mut Vec<Block>, mut p: Para) {
    // 앞쪽 `<br>` 는 센 뒤 한 번에 지운다 — `remove(0)` 반복은 O(n²) 라 줄바꿈만 수만 개인 문단 하나로 수 초~수 분이 걸린다.
    let lead = p.inl.iter().take_while(|i| matches!(i, Inline::Br)).count();
    p.inl.drain(..lead);
    while matches!(p.inl.last(), Some(Inline::Br)) {
        p.inl.pop();
    }
    if inl_blank(&p.inl) {
        // 빈 문단에 정렬·들여쓰기 속성을 달아 봐야 HTML 섬(body_md 크기)만 늘린다.
        p.kind = Kind::Normal;
        p.level = 0;
        p.align = Align::Left;
        p.indent = 0;
        p.inl.clear();
    } else if matches!(p.kind, Kind::Heading(_)) && inl_text(&p.inl).trim().chars().count() > MAX_OUTLINE_HEADING_CHARS {
        p.kind = Kind::Normal;
    }
    out.push(Block::Para(p));
}

/// 문단 하나를 짓는 중의 형식 무관 상태(DOCX 가 쓴다 — HWPX 의 `ParaBuilder` 는 여기에 링크·형광펜 상태를 더 가진다).
/// 표·그림은 문단 안(run)에 있지만 HTML 에서는 블록이라, 만나면 그 앞까지를 문단으로 내보낸다(`flush_before_object`) —
/// 문단에 표뿐이면 앞뒤로 빈 `<p>` 가 안 생긴다.
pub(super) struct ParaAcc {
    pub(super) kind: Kind,
    pub(super) level: u8,
    pub(super) align: Align,
    pub(super) indent: u8,
    /// `Para::ord` — 문단을 내보낼 때 그대로 실린다(표·그림 뒤로 이어지는 조각도 같은 번호).
    pub(super) ord: Option<u32>,
    pub(super) inl: Vec<Inline>,
    pub(super) had_object: bool,
}

impl ParaAcc {
    pub(super) fn new(kind: Kind, level: u8, align: Align, indent: u8) -> Self {
        ParaAcc { kind, level, align, indent, ord: None, inl: Vec::new(), had_object: false }
    }

    fn take_para(&mut self) -> Para {
        Para {
            kind: self.kind,
            level: self.level,
            align: self.align,
            indent: self.indent,
            ord: self.ord,
            inl: std::mem::take(&mut self.inl),
        }
    }

    pub(super) fn flush_before_object(&mut self, out: &mut Vec<Block>) {
        if !inl_blank(&self.inl) {
            let p = self.take_para();
            push_para(out, p);
        } else {
            self.inl.clear();
        }
        self.had_object = true;
    }

    pub(super) fn finish(mut self, out: &mut Vec<Block>) {
        if inl_blank(&self.inl) && self.had_object {
            return; // 표·그림만 앵커한 문단 — 빈 `<p>` 를 남기지 않는다.
        }
        let p = self.take_para();
        push_para(out, p);
    }
}

/// 컨테이너(본문·셀·각주·글상자) 하나의 블록들을 정리한다: 연속된 빈 문단은 하나로, 앞뒤 빈 문단은 없앤다.
/// 셀은 비어도 문단 하나를 남긴다(셀 내용은 `block+`).
pub(super) fn finish_blocks(blocks: &mut Vec<Block>, in_cell: bool) {
    let mut out: Vec<Block> = Vec::with_capacity(blocks.len());
    for b in blocks.drain(..) {
        if is_empty_para(&b) && out.last().is_none_or(is_empty_para) {
            continue;
        }
        out.push(b);
    }
    while out.last().is_some_and(is_empty_para) {
        out.pop();
    }
    if in_cell && out.is_empty() {
        out.push(empty_para());
    }
    *blocks = out;
}

/// 스타일·개요가 없는 문단을 글자 크기로 제목 추정(보수적): 문단 전체가 본문의 2.0배↑ → h1, 1.5배↑ → h2.
/// 60자 이하(`chars().count()`)만, **표 밖 최상위 블록**만.
pub(super) fn infer_headings(blocks: &mut [Block], base: u32) {
    if base == 0 {
        return;
    }
    for b in blocks {
        let Block::Para(p) = b else { continue };
        if p.kind != Kind::Normal {
            continue;
        }
        let text = inl_text(&p.inl);
        let len = text.trim().chars().count();
        if len == 0 || len > MAX_INFERRED_HEADING_CHARS {
            continue;
        }
        let min_h = p
            .inl
            .iter()
            .filter_map(|i| match i {
                Inline::Text(pc) if pc.st.height > 0 && !pc.text.trim().is_empty() => Some(pc.st.height),
                _ => None,
            })
            .min();
        let Some(min_h) = min_h else { continue };
        // 높이는 읽을 때 `MAX_CHAR_HEIGHT` 로 막혀 있지만, 곱셈이 넘치지 않는 것을 이 줄만 봐도 알게 u64 로 한다.
        let (min_h, base) = (u64::from(min_h), u64::from(base));
        if min_h * 10 >= base * 20 {
            p.kind = Kind::Heading(1);
        } else if min_h * 10 >= base * 15 {
            p.kind = Kind::Heading(2);
        }
    }
}

/// 제어 문자를 걷어낸다 — 탭·개행은 공백으로, 그 밖의 제어 문자와 BOM 은 버린다.
pub(super) fn clean_text(raw: &str) -> String {
    raw.chars()
        .filter_map(|c| match c {
            '\t' | '\n' | '\r' => Some(' '),
            '\u{feff}' => None,
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

/// 병합을 따라 각 셀이 시작하는 열을 구하고, 열 너비(px)를 알아낸다. HTML 표와 같은 점유 규칙이라 PM 이 읽는 격자와
/// 일치한다. 열마다 하나씩의 `colwidth` 는 prosemirror-tables 규약이다(colspan > 1 이면 차지한 열 수만큼).
pub(super) fn layout_columns(rows: &mut [Vec<Cell>]) -> AppResult<()> {
    // 표 끝을 넘는 rowspan 은 남은 행 수로 막는다 — HTML 은 어차피 표 끝에서 자르고, 막지 않으면 면적(= 예산·시간)만 부푼다.
    let nrows = rows.len();
    for (r, row) in rows.iter_mut().enumerate() {
        for cell in row {
            cell.rowspan = cell.rowspan.min(nrows - r);
        }
    }
    let mut budget = MAX_GRID_CELLS;
    // busy[c] = 열 c 가 위 행에서 내려온 병합 셀에 막혀 있는 마지막 행 + 1. 칸마다 집합에 넣는 대신 열 하나에 숫자 하나라
    // 셀 하나의 비용이 colspan 이다(rowspan 에 비례하지 않는다). 지금 행 r 에서 열 c 가 막혔는가 ⇔ busy[c] > r —
    // 기록된 병합은 전부 r 보다 앞 행에서 시작했으므로 끝(마지막 행 + 1)이 r 을 넘으면 r 을 덮고 있다.
    let mut busy: Vec<usize> = Vec::new();
    let mut starts: Vec<Vec<usize>> = Vec::with_capacity(rows.len());
    let mut ncols = 0usize;
    for (r, row) in rows.iter().enumerate() {
        let mut c = 0usize;
        let mut row_starts = Vec::with_capacity(row.len());
        for cell in row {
            while busy.get(c).is_some_and(|end| *end > r) {
                c += 1;
            }
            row_starts.push(c);
            let area = cell.colspan * cell.rowspan;
            if area > budget {
                return Err(AppError::Validation("table is too complex".to_string()));
            }
            budget -= area;
            if busy.len() < c + cell.colspan {
                busy.resize(c + cell.colspan, 0);
            }
            for end in &mut busy[c..c + cell.colspan] {
                *end = (*end).max(r + cell.rowspan);
            }
            c += cell.colspan;
            ncols = ncols.max(c);
        }
        starts.push(row_starts);
    }
    let mut col_w: Vec<Option<u32>> = vec![None; ncols];
    for (r, row) in rows.iter().enumerate() {
        for (i, cell) in row.iter().enumerate() {
            if let (1, Some(w)) = (cell.colspan, cell.width_px) {
                col_w[starts[r][i]].get_or_insert(w);
            }
        }
    }
    // 병합 셀의 너비로, 홑 셀이 한 번도 안 나온 열을 채운다(알려진 열 너비를 뺀 나머지를 균등 분배).
    for (r, row) in rows.iter().enumerate() {
        for (i, cell) in row.iter().enumerate() {
            let (Some(w), true) = (cell.width_px, cell.colspan > 1) else { continue };
            let range = starts[r][i]..starts[r][i] + cell.colspan;
            // 합은 u64 로 — 열 200개 × u32 최댓값은 u32 를 넘는다(셀 너비는 읽을 때 막혀 있지만 이 줄만 봐도 안전하게).
            let known: u64 = col_w[range.clone()].iter().flatten().map(|w| u64::from(*w)).sum();
            let unknown = col_w[range.clone()].iter().filter(|c| c.is_none()).count() as u64;
            if unknown > 0 && u64::from(w) > known {
                let share = (((u64::from(w) - known) / unknown).max(1)).min(u64::from(u32::MAX)) as u32;
                for slot in &mut col_w[range] {
                    slot.get_or_insert(share);
                }
            }
        }
    }
    for (r, row) in rows.iter_mut().enumerate() {
        for (i, cell) in row.iter_mut().enumerate() {
            let range = starts[r][i]..starts[r][i] + cell.colspan;
            let widths: Vec<u32> = col_w[range].iter().flatten().copied().collect();
            if widths.len() == cell.colspan {
                cell.colwidth = Some(widths);
            }
        }
    }
    Ok(())
}

/// 행들(파일에 있는 셀만 문서 순서대로)을 표로 — 열 배치 · 빈 행 걷기 · 머리글 승격. 셀이 하나도 없으면 `None`.
///
/// Brise 표의 첫 행은 머리글이다. 머리글 셀이 하나도 없는 GFM 표는 직렬화가 **빈 머리글 행을 끼워 넣어** 데이터가 한 줄
/// 밀린다(2026-10-07 프로브: td 만 있는 표 → `|   |   |` 행이 맨 위에 생김). 문서 표는 머리글 표시가 없는 것이 흔하므로,
/// 병합·셀 배경이 없는 표(= GFM 로 갈 표)에 머리글 표시가 없으면 첫 행을 머리글로 올린다. 병합·배경이 있는 표는
/// `<table>` 조각으로 저장돼 td/th 구분이 그대로 남으므로 건드리지 않는다.
pub(super) fn build_table(mut rows: Vec<Vec<Cell>>) -> AppResult<Option<Table>> {
    if rows.iter().all(Vec::is_empty) {
        return Ok(None);
    }
    layout_columns(&mut rows)?;
    drop_empty_rows(&mut rows);
    let plain = rows.iter().flatten().all(|c| c.colspan == 1 && c.rowspan == 1 && c.bg.is_none());
    if plain && !rows.iter().flatten().any(|c| c.header) {
        for c in &mut rows[0] {
            c.header = true;
        }
    }
    Ok(Some(Table { rows }))
}

/// 셀이 하나도 없는 행(전부 병합에 가려진 행)을 걷는다. HTML 표(와 Brise 스키마)에는 셀 없는 행이 없으므로, 그 행을 가로지르던
/// 병합 셀의 rowspan 은 걷는 행 수만큼 줄인다 — 줄이지 않으면 rowspan 이 표 끝을 넘고 아래 행이 한 칸씩 어긋난다.
/// 셀마다 걷는 행을 세지 않고 "앞에서부터의 빈 행 누계"로 뺀다(셀 수 × 빈 행 수 가 되지 않게).
pub(super) fn drop_empty_rows(rows: &mut Vec<Vec<Cell>>) {
    if rows.iter().all(|r| !r.is_empty()) {
        return;
    }
    // empties[i] = rows[..i] 안의 빈 행 수.
    let mut empties: Vec<usize> = Vec::with_capacity(rows.len() + 1);
    empties.push(0);
    for row in rows.iter() {
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
