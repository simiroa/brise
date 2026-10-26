// repo: dashboard/board — kanban board query, checkbox parse/toggle, pin/schedule sort.
//
// Governing rules (see dashboard/mod.rs):
// - All reads are workspace-scoped SQL.
// - Only write is todo_toggle → reuses repo::sections::update (FTS + updated_at).
// - body_md is Tiptap HTML in production; GFM "- [ ]" also accepted.
// - kind='diagram' is never scanned for checkboxes.
//
// Checkbox index contract: `line_index` is the 0-based ordinal of the checkbox *within that
// section's body* (not a raw source line number).
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::schedule::{DueReminder, ReminderKind};
use crate::repo::{checklist, sections, taxonomy};
use crate::util::today_ymd_local;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;

use super::dateord::NaiveYmd;
use super::ensure_workspace;

// ── Shared shapes ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BoardTodoItem {
    pub section_id: String,
    /// 0-based checkbox ordinal inside this section (see module docs).
    pub line_index: i64,
    pub text: String,
    pub checked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoardNote {
    pub id: String,
    pub title: String,
    // 사건 축 시작(카드 날짜 범위 텍스트 — src/components/titlebar/eventDate.ts::formatEventBadge).
    pub year: i64,
    pub month: Option<i64>,
    pub day: Option<i64>,
    // PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 순수 표시값 — 카드 날짜 배지가 시각을 보여줄 때
    // 쓴다. is_pinned/pin_anchor_ord 의 기준일 판정에는 더 이상 들어가지 않는다(발화/미처리 둘 다
    // 시각 유무와 무관하다).
    pub start_time: Option<String>,
    // Dashboard Wave 2 (docs/DASHBOARD.md §2, 2026-08-01): 마감 축(due_at) 폐지 — 종료일로 통합.
    pub end_year: Option<i64>,
    pub end_month: Option<i64>,
    pub end_day: Option<i64>,
    // Dashboard Wave 3 (2026-08-01): "알려줘" opt-in 플래그 — 긴급도/마감 취급 개념은 폐지되고
    // 이 명시적 플래그 + 과거 종료일 조합만 정렬 우선순위(핀)/빨간 점 근거가 된다(is_pinned 참조).
    pub remind: bool,
    pub updated_at: String,
    pub unchecked_count: i64,
    pub items: Vec<BoardTodoItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoardColumn {
    /// Built-in key (`in_progress`/`exported`/`done`), custom `workspace_statuses.id`, or null
    /// (no status). Column identity for set_status drops.
    pub status: Option<String>,
    /// Display label: built-in key as-is, custom status name, or null for the empty column.
    pub status_label: Option<String>,
    pub notes: Vec<BoardNote>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BoardResult {
    pub columns: Vec<BoardColumn>,
    /// Always reported (no silent cap) — mirrors TimelineResult's total_matched/cap/capped.
    pub total_matched: i64,
    pub cap: i64,
    pub capped: bool,
}

// ── Checkbox parsing ─────────────────────────────────────────────────────────
//
// LIMITATIONS (intentionally not over-engineered):
// - HTML path: relies on fixed tiptap TaskItem markup (repo/checklist.rs). Nested task lists
//   work because scan walks every `data-type="taskItem"`.
// - GFM path: matches lines whose first non-ws content is `- [ ]` / `- [x]` / `* [ ]` etc.
//   (indent allowed). Does NOT try to parse fenced code blocks out — a "- [ ]" inside a fence
//   can false-positive. Acceptable: real notes store HTML after editor load; GFM is seed/preset
//   edge case. If that ever matters, prefer HTML path (taskItem present → HTML wins).

/// One checkbox occurrence inside a section body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCheckbox {
    pub line_index: usize,
    pub text: String,
    pub checked: bool,
}

/// Parse checkboxes from one section body. HTML taskItem wins when present; else GFM.
pub fn parse_checkboxes(body_md: &str) -> Vec<ParsedCheckbox> {
    // 모드 판정과 스캔 전에 `<table>` HTML 조각을 가린다 — 표 셀 안 체크리스트는 최상위 항목이 아니고, 가리지
    // 않으면 그 한 항목 때문에 HTML 전용 모드로 넘어가 같은 본문의 GFM 할 일이 통째로 사라졌다
    // (checklist::mask_html_tables, 프런트 inlineSchedule.ts 와 같은 규칙).
    let masked = checklist::mask_html_tables(body_md);
    if checklist::has_task_item_markup(&masked) {
        return checklist::scan_checkboxes(body_md)
            .into_iter()
            .enumerate()
            .map(|(i, (checked, text))| ParsedCheckbox {
                line_index: i,
                text,
                checked,
            })
            .collect();
    }
    parse_gfm_checkboxes(&masked)
}

/// GFM task-list lines: optional indent, then `-`/`*`/`+`, space, `[ ]`/`[x]`/`[X]`, rest.
fn parse_gfm_checkboxes(body_md: &str) -> Vec<ParsedCheckbox> {
    let mut out = Vec::new();
    let mut ordinal = 0usize;
    for line in body_md.lines() {
        if let Some((checked, text)) = parse_gfm_checkbox_line(line) {
            out.push(ParsedCheckbox {
                line_index: ordinal,
                text,
                checked,
            });
            ordinal += 1;
        }
    }
    out
}

fn parse_gfm_checkbox_line(line: &str) -> Option<(bool, String)> {
    let trimmed = line.trim_start();
    let bytes = trimmed.as_bytes();
    // bullet + space + [ + mark + ] + optional space/rest
    if bytes.len() < 5 {
        return None;
    }
    let bullet = bytes[0];
    if bullet != b'-' && bullet != b'*' && bullet != b'+' {
        return None;
    }
    if bytes[1] != b' ' || bytes[2] != b'[' || bytes[4] != b']' {
        return None;
    }
    let mark = bytes[3];
    let checked = mark == b'x' || mark == b'X';
    if !checked && mark != b' ' {
        return None;
    }
    let rest = trimmed[5..].trim_start();
    Some((checked, rest.to_string()))
}

/// Flip the n-th checkbox in body. Returns None if index out of range or format unsupported.
pub fn toggle_checkbox_in_body(body_md: &str, line_index: usize, new_checked: bool) -> Option<String> {
    // parse_checkboxes 와 같은 판정 — 순번(line_index)이 두 함수에서 어긋나면 엉뚱한 항목이 토글된다.
    let masked = checklist::mask_html_tables(body_md);
    if checklist::has_task_item_markup(&masked) {
        return checklist::toggle_at(body_md, line_index, new_checked);
    }
    toggle_gfm_checkbox(body_md, &masked, line_index, new_checked)
}

/// `masked` 는 `body_md` 의 표 조각을 같은 길이의 공백으로 가린 사본이다(줄 구조가 같다) — 항목 판정은 가린 줄로,
/// 고치기는 원본 줄로 한다.
fn toggle_gfm_checkbox(body_md: &str, masked: &str, line_index: usize, new_checked: bool) -> Option<String> {
    let mut ordinal = 0usize;
    let mut out_lines = Vec::new();
    let mut found = false;
    let mark = if new_checked { 'x' } else { ' ' };
    for (line, masked_line) in body_md.lines().zip(masked.lines()) {
        if parse_gfm_checkbox_line(masked_line).is_some() {
            if ordinal == line_index {
                // Replace the [ ] / [x] bracket contents while preserving indent + bullet.
                let mut replaced = String::with_capacity(line.len());
                let mut chars = line.chars().peekable();
                // copy leading whitespace
                while let Some(&c) = chars.peek() {
                    if c == ' ' || c == '\t' {
                        replaced.push(c);
                        chars.next();
                    } else {
                        break;
                    }
                }
                // bullet + space
                if let Some(b) = chars.next() {
                    replaced.push(b);
                }
                if let Some(sp) = chars.next() {
                    replaced.push(sp);
                }
                // [
                if let Some(ob) = chars.next() {
                    replaced.push(ob);
                }
                // skip old mark
                let _ = chars.next();
                replaced.push(mark);
                // rest of line (should start with ']')
                for c in chars {
                    replaced.push(c);
                }
                out_lines.push(replaced);
                found = true;
            } else {
                out_lines.push(line.to_string());
            }
            ordinal += 1;
        } else {
            out_lines.push(line.to_string());
        }
    }
    if !found {
        return None;
    }
    // Preserve trailing newline if original had one.
    let mut joined = out_lines.join("\n");
    if body_md.ends_with('\n') {
        joined.push('\n');
    }
    Some(joined)
}

// ── Pin 판정 ─────────────────────────────────────────────────────────────────

/// 종료일(없으면 시작일)에서 "미처리" 기준일을 고르고, 풀 정밀도 + 달력상 실재(checked_ord)일
/// 때만 그 오디널을 반환한다. `is_pinned`(핀 판정)과 `due_reminders`(정렬 키)가 이 계산 하나를
/// 공유한다 — "언제가 기준일인가"를 두 곳에서 따로 계산하면 벨·핀이 다른 기준일을 쓰는 결함이
/// 재발한다.
///
/// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 시각 유무는 더 이상 이 판정에 들어가지 않는다 —
/// "발화"(언제 울리나, 항상 시작일)와 "미처리"(언제부터 지났나, 종료일 없으면 시작일)는 서로
/// 다른 질문이고, 옛 `schedule::anchor_date`(시각 있으면 시작일, 없으면 종료일)는 이 둘을 하나의
/// 추측으로 뭉뚱그렸던 것 — 그 함수는 삭제됐다.
///
/// start_*/end_* 는 raw DB 트리플 — write-time 검증은 숫자 범위만 본다(validate_end_triple,
/// repo/notes/mod.rs), 달력상 실재 여부가 아니다. 그래서 저장된 2월 30일 같은 값이 여기 닿을 수
/// 있다 — "전부 Some" 인지만 여기서 보고, 실재 여부는 checked_ord(to_ord 아님)가 걸러 달력상
/// 없는 날짜가 핀/패닉으로 이어지지 않게 한다.
fn pin_anchor_ord(
    start: (Option<i64>, Option<i64>, Option<i64>),
    end: (Option<i64>, Option<i64>, Option<i64>),
) -> Option<i64> {
    let full = |t: (Option<i64>, Option<i64>, Option<i64>)| -> Option<NaiveYmd> {
        let (Some(y), Some(m), Some(d)) = t else {
            return None;
        };
        Some(NaiveYmd { y, m: m as u32, d: d as u32 })
    };
    full(end).or_else(|| full(start))?.checked_ord()
}

/// Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01 오너 결정): "칸반 핀"(컬럼 맨 위로 뜨고
/// 빨간 점) 판정의 유일한 지점 — 긴급도/마감 취급 모델은 폐지됐다. 노트 날짜는 중립 기록
/// 정보이므로 과거 날짜 자체는 아무 신호가 아니다. 오직 사용자가 명시적으로 "알려줘"를 켠
/// (remind=true) 노트만, 그리고 풀 정밀도인 **기준일**(anchor)이 오늘보다 과거일 때만 핀이
/// 붙는다 — 시간 윈도우([오늘-30일, +∞) 같은 컷오프) 는 없다: 1598년에 끝난 노트라도 사용자가
/// 직접 remind 를 켰다면 그건 오탐이 아니라 요청받은 동작이다. 완료 컬럼(done)은 핀 대상에서
/// 제외 — "완료된 노트를 알람 취급"이 원래 불만의 발단이었다.
///
/// 기준일은 이 함수가 독자적으로 정하지 않는다 — `pin_anchor_ord`(종료일, 없으면 시작일)로
/// 위임한다. PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 시각 유무는 이제 이 규칙에 들어가지
/// 않는다 — "미처리"는 "발화"와 다른 질문이라 독립된 규칙을 갖는다(pin_anchor_ord 문서 참고).
fn is_pinned(
    remind: bool,
    start: (Option<i64>, Option<i64>, Option<i64>),
    end: (Option<i64>, Option<i64>, Option<i64>),
    today_ord: i64,
    column_status: Option<&str>,
) -> bool {
    if !remind || column_status == Some("done") {
        return false;
    }
    match pin_anchor_ord(start, end) {
        Some(anchor_ord) => anchor_ord < today_ord,
        None => false,
    }
}

/// 펫 알림(W6-d2, repo::pet::notifications)이 쓰는 "지금 알려줄 노트" 목록 — 칸반 핀과 **같은**
/// 판정을 쓴다. 판정을 펫 쪽에 복제하면 두 화면이 서로 다른 노트를 "알림"이라 부르게 되므로
/// is_pinned 를 그대로 통과시키는 이 함수를 여기(판정이 사는 곳)에 둔다. dashboard_board 전체를
/// 부르지 않는 이유는 그쪽이 컬럼·체크박스 파싱까지 하는 무거운 쿼리라서다 — 5분 폴링에 맞지 않는다.
///
/// docs/PLAN-schedule-system.md §1.4 (W5-3): 반환 타입만 `(id, title)` 튜플에서 이유를 실은
/// `DueReminder` 로 넓혔다. 여기는 여전히 `Overdue`("지났다") 전용이고, "도래한다"(`Due`)는
/// repo::schedule 의 fire_at 판정이 따로 소유한다. 두 판정을 섞으면 칸반 핀이 미래 일정에도 붙는다.
///
/// PLAN-2026-09-08-dates-rebuild.md W2(§1.3/①): W1 이후 모든 날짜가 `note_dates` 행이므로(position
/// 0 = 대표, notes.* 의 투영) 후보 조회는 이 한 질의뿐이다 — 옛 "notes 를 읽는 핀 후보" 쿼리와
/// "position != 0 인 관련 날짜" 쿼리 두 벌이 여기 하나로 합쳐졌다(schedule::candidates 의 W2 통합과
/// 같은 이유). 합쳐진 결과로, 관련 날짜도 이제 `is_pinned`(status='done' 제외 포함)를 그대로
/// 통과한다 — 옛 별도 쿼리는 이 제외를 몰랐다(의도된 동작 변화, 보고 참조).
pub fn due_reminders(conn: &Connection, workspace_id: &str) -> AppResult<Vec<DueReminder>> {
    let (ty, tm, td) = today_ymd_local();
    let today_ord = NaiveYmd { y: ty, m: tm as u32, d: td as u32 }.to_ord();
    let mut stmt = conn
        .prepare(
            // W7-f: shares the board's "hide archived" posture (same judgment as the kanban pin
            // column, so an archived note must not surface as a pet notification either).
            //
            // remind 게이트는 nd.remind(각 행 자신의 값) — 대표 행도 이제 이 컬럼을 project_primary
            // 로 투영받으므로 notes.remind 를 따로 읽을 필요가 없다.
            "SELECT nd.id, nd.position, n.id, n.title,
                    nd.year, nd.month, nd.day, nd.end_year, nd.end_month, nd.end_day, n.status
             FROM note_dates nd
             JOIN notes n ON n.id = nd.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id = ?1 AND n.deleted_at IS NULL AND n.archived_at IS NULL
               AND nd.remind = 1",
        )
        .map_err(dberr)?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        i64,
        String,
        String,
        i64,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<String>,
    )> = stmt
        .query_map([workspace_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        })
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    // 정렬은 기준일(anchor) 오름차순(오래된 것부터) — SQL 이 아니라 여기서 계산한다: 후보가
    // remind=1 전체라 인덱스 스캔 이점이 없고, anchor 오디널은 어차피 checked_ord 를 거쳐야
    // 하므로 Rust 계산이 더 단순하다.
    let mut out: Vec<(i64, DueReminder)> = rows
        .into_iter()
        .filter_map(|(date_id, position, note_id, title, y, m, d, ey, em, ed, status)| {
            let start = (Some(y), m, d);
            let end = (ey, em, ed);
            if !is_pinned(true, start, end, today_ord, status.as_deref()) {
                return None;
            }
            let anchor_ord = pin_anchor_ord(start, end)?;
            Some((
                anchor_ord,
                DueReminder {
                    note_id,
                    title,
                    kind: ReminderKind::Overdue,
                    fire_at: None,
                    related_date_id: if position == 0 { None } else { Some(date_id) },
                },
            ))
        })
        .collect();

    out.sort_by(|(ord_a, a), (ord_b, b)| {
        ord_a
            .cmp(ord_b)
            .then_with(|| a.note_id.cmp(&b.note_id))
            .then_with(|| a.related_date_id.cmp(&b.related_date_id))
    });
    Ok(out.into_iter().map(|(_, r)| r).collect())
}

// ── Schedule sort ────────────────────────────────────────────────────────────

/// "일정" 정렬 버킷: 종료일이 있으면 오름차순(정밀도 부족분은 1로 채워 그 달/그 해의 가장 이른
/// 쪽으로 근사), 종료일 자체가 없으면 맨 뒤.
fn schedule_bucket(end: (Option<i64>, Option<i64>, Option<i64>)) -> (u8, Option<String>) {
    match end.0 {
        Some(y) => (
            0,
            Some(format!("{y:04}-{:02}-{:02}", end.1.unwrap_or(1), end.2.unwrap_or(1))),
        ),
        None => (1, None),
    }
}

/// 정렬 핵심 비교자 — pin 우선, 그 다음 미완료 체크박스(`unchecked_count > 0`), 그 다음
/// schedule_bucket(종료일 오름차순·없으면 뒤), 타이는 updated_at desc.
/// `today_ord` 는 로컬 오늘 기준 프로렙틱 오디널. BoardNote(후처리 완료본, board_note_cmp)와 board()
/// 의 cap 이전 raw 튜플(board() 내부, checkbox 파싱 전) 양쪽에서 재사용할 수 있게 원시 필드만
/// 받는다. 캡 이전 호출은 `unchecked_* = 0` 을 넘겨 체크박스 티어를 끈다(아래 ponytail 참조).
#[allow(clippy::too_many_arguments)]
fn board_priority_cmp(
    remind_a: bool,
    start_a: (Option<i64>, Option<i64>, Option<i64>),
    end_a: (Option<i64>, Option<i64>, Option<i64>),
    updated_a: &str,
    status_a: Option<&str>,
    unchecked_a: i64,
    remind_b: bool,
    start_b: (Option<i64>, Option<i64>, Option<i64>),
    end_b: (Option<i64>, Option<i64>, Option<i64>),
    updated_b: &str,
    status_b: Option<&str>,
    unchecked_b: i64,
    today_ord: i64,
) -> Ordering {
    let pin_a = is_pinned(remind_a, start_a, end_a, today_ord, status_a);
    let pin_b = is_pinned(remind_b, start_b, end_b, today_ord, status_b);
    match (pin_a, pin_b) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    // Checkbox priority: only open (unchecked) todos boost a note. Fully-checked lists
    // and notes with no checkboxes share the non-priority side (unchecked_count == 0).
    let open_a = unchecked_a > 0;
    let open_b = unchecked_b > 0;
    match (open_a, open_b) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    let (ba, da) = schedule_bucket(end_a);
    let (bb, db) = schedule_bucket(end_b);
    ba.cmp(&bb)
        .then_with(|| match (&da, &db) {
            (Some(x), Some(y)) => x.cmp(y),
            _ => Ordering::Equal,
        })
        .then_with(|| updated_b.cmp(updated_a))
}

/// `column_status` = the column this note is being sorted within (`col.status`, not the note's
/// own raw `status` field — an orphaned custom status still lands in the null column, and the
/// pin's "done column is exempt" rule must key off where the card actually renders).
pub fn board_note_cmp(
    a: &BoardNote,
    b: &BoardNote,
    today_ord: i64,
    column_status: Option<&str>,
) -> Ordering {
    board_priority_cmp(
        a.remind,
        (Some(a.year), a.month, a.day),
        (a.end_year, a.end_month, a.end_day),
        &a.updated_at,
        column_status,
        a.unchecked_count,
        b.remind,
        (Some(b.year), b.month, b.day),
        (b.end_year, b.end_month, b.end_day),
        &b.updated_at,
        column_status,
        b.unchecked_count,
        today_ord,
    )
}

// ── dashboard_board ──────────────────────────────────────────────────────────

/// Cap on notes actually loaded/rendered (total across all columns), highest-priority (pinned,
/// then soonest-scheduled) first — not a per-column quota. Mirrors TIMELINE_ITEM_CAP's explicit,
/// non-silent cap pattern.
pub const BOARD_NOTE_CAP: usize = 1000;

/// Status-grouped notes + checkbox items for the work tab kanban.
/// Columns always include: null (no status) + built-in 3 + workspace custom statuses (even empty).
pub fn board(conn: &Connection, workspace_id: &str) -> AppResult<BoardResult> {
    board_capped(conn, workspace_id, BOARD_NOTE_CAP)
}

/// 캡 이전 우선순위를 **티어별 세 쿼리**로 나눠 각각 인덱스에서 순서를 그대로 가져온다
/// (SCALABILITY.md §0, V44). 하나의 `ORDER BY CASE …` 쿼리로는 선두 키가 "오늘"에 의존하는
/// 표현식이라 어떤 인덱스도 못 타고, LIMIT 이 있어도 노트북 전 행이 temp B-tree 를 지나갔다.
///
/// board_priority_cmp(unchecked=0) 의 티어와 1:1:
///   ① PIN_SQL      핀 **후보** — remind=1 · done 아님(2026-09-07부터 종료 트리플 요구 없음,
///                   pin_sql 자체 주석 참조 — 후보 축이 anchor 로 넓어졌다)
///   ② DATED_SQL    end_year IS NOT NULL, 종료일(end_sort_key) 오름차순 → updated_at 내림차순
///   ③ UNDATED_SQL  end_year IS NULL, updated_at 내림차순
///
/// ① 은 "후보"다: 핀의 나머지 조건(오늘보다 과거 + 달력상 실재하는 날짜)은 오늘 의존이고
/// checked_ord 판정이라 SQL 로 내리지 않는다 — 받은 소수 행에 기존 `is_pinned` 를 그대로 돌린다.
/// pin_anchor_sort_key 오름차순이라 "과거"인 것들이 앞에 오므로 LIMIT 때문에 핀을 놓치지도 않는다.
///
/// 세 결과의 합집합이 진짜 상위 cap 을 **반드시 포함**한다: 어떤 티어의 노트든 전역 순서에서
/// 자기 앞에 오는 것은 같은 쿼리 안에서도 자기 앞에 오므로, 전역 랭크가 cap 미만이면 그 쿼리의
/// 앞 cap 개 안에 있다. 그래서 아래 병합은 후보를 **기존 비교자 그대로** 정렬해 자르기만 한다 —
/// 근사가 아니라 정확한 상위 cap 이다(예전 단일 쿼리의 근사 ORDER BY 절단보다 오히려 정확하다:
/// 2월 30일 같은 달력상 없는 종료일을 SQL 이 핀으로 오인해 밀어 올리던 문제가 사라진다).
///
/// 워크스페이스 스코프가 semi-join 인 이유, `INDEXED BY` 로 못 박는 이유는 calendar.rs
/// SPAN_SQL 주석과 같다.
const BOARD_COLS: &str = "n.id, n.title, n.year, n.month, n.day,
        n.end_year, n.end_month, n.end_day,
        n.updated_at, n.status, n.remind, n.start_time";

/// W7-f: archived excluded too — the board is a dashboard browsing surface
/// (search_notes still returns archived notes).
const BOARD_SCOPE: &str = "n.deleted_at IS NULL AND n.archived_at IS NULL
   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)";

/// 후보 축은 "종료일"이 아니라 anchor(종료일, 없으면 시작일 — pin_anchor_ord 와 같은 규칙)로
/// 넓어져 있다 — 종료일이 없으면 시작일로 떨어진다. 그래서 옛 `end_day/end_year/end_month IS
/// NOT NULL` 조건을 걸면 이 케이스(종료일 없이 시작일만 있는 종일 알림)를 후보에서 통째로
/// 빠뜨린다. `pin_anchor_sort_key`(V71 생성 컬럼, W2/V77 에서 시각 유무 항을 뺐다)가 이 규칙을
/// 그대로 SQL 로 옮긴 정렬 키 — 여전히 **후보**일 뿐이고, 오늘 의존 + checked_ord 판정은 여기서도
/// Rust `is_pinned` 가 한다.
fn pin_sql() -> String {
    format!(
        "SELECT {BOARD_COLS} FROM notes n INDEXED BY idx_notes_remind_anchor
 WHERE {BOARD_SCOPE}
   AND n.remind = 1
   AND COALESCE(n.status, '') <> 'done'
 ORDER BY n.pin_anchor_sort_key ASC, n.updated_at DESC
 LIMIT ?2"
    )
}

fn dated_sql() -> String {
    format!(
        "SELECT {BOARD_COLS} FROM notes n INDEXED BY idx_notes_end_sort_alive
 WHERE {BOARD_SCOPE}
   AND n.end_year IS NOT NULL
 ORDER BY n.end_sort_key ASC, n.updated_at DESC
 LIMIT ?2"
    )
}

fn undated_sql() -> String {
    format!(
        "SELECT {BOARD_COLS} FROM notes n INDEXED BY idx_notes_undated_updated_alive
 WHERE {BOARD_SCOPE}
   AND n.end_year IS NULL
 ORDER BY n.updated_at DESC
 LIMIT ?2"
    )
}

/// 전체 매치 수(`total_matched`). 캡을 실제로 넘겼을 때만 돈다 — 넘지 않았으면 ②+③ 이 곧 전량이다.
const BOARD_COUNT_SQL: &str = "SELECT COUNT(*) FROM notes n
 WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)";

/// board 가 SQL 에서 받아오는 raw 행. 예전 익명 11-튜플을 그대로 옮긴 것 — 세 쿼리가 같은 모양을
/// 돌려주므로 이름을 붙이는 편이 병합 코드가 읽힌다.
struct BoardRow {
    id: String,
    title: String,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    updated_at: String,
    status: Option<String>,
    remind: bool,
    start_time: Option<String>,
}

fn map_board_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<BoardRow> {
    Ok(BoardRow {
        id: r.get(0)?,
        title: r.get(1)?,
        year: r.get(2)?,
        month: r.get(3)?,
        day: r.get(4)?,
        end_year: r.get(5)?,
        end_month: r.get(6)?,
        end_day: r.get(7)?,
        updated_at: r.get(8)?,
        status: r.get(9)?,
        remind: r.get::<_, i64>(10)? != 0,
        start_time: r.get(11)?,
    })
}

fn board_rows(
    conn: &Connection,
    sql: &str,
    workspace_id: &str,
    limit: i64,
) -> AppResult<Vec<BoardRow>> {
    let mut stmt = conn.prepare(sql).map_err(dberr)?;
    let rows = stmt
        .query_map(rusqlite::params![workspace_id, limit], map_board_row)
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

fn board_capped(conn: &Connection, workspace_id: &str, cap: usize) -> AppResult<BoardResult> {
    ensure_workspace(conn, workspace_id)?;
    let (ty, tm, td) = today_ymd_local();
    let today_ord = NaiveYmd {
        y: ty,
        m: tm as u32,
        d: td as u32,
    }
    .to_ord();

    // Column skeleton: null → built-ins → customs by position.
    let customs = taxonomy::list_statuses(conn, Some(workspace_id.to_string()))?;
    let mut columns: Vec<BoardColumn> = Vec::with_capacity(1 + 3 + customs.len());
    columns.push(BoardColumn {
        status: None,
        status_label: None,
        notes: Vec::new(),
    });
    for key in taxonomy::BUILT_IN_STATUSES {
        columns.push(BoardColumn {
            status: Some(key.to_string()),
            status_label: Some(key.to_string()),
            notes: Vec::new(),
        });
    }
    for c in &customs {
        columns.push(BoardColumn {
            status: Some(c.id.clone()),
            status_label: Some(c.name.clone()),
            notes: Vec::new(),
        });
    }
    // Fast lookup status → column index.
    let mut col_ix: HashMap<Option<String>, usize> = HashMap::new();
    for (i, col) in columns.iter().enumerate() {
        col_ix.insert(col.status.clone(), i);
    }

    // Explicit cap (SCALABILITY.md §0, mirrors timeline()'s TIMELINE_ITEM_CAP): keep only the
    // `cap` highest-priority notes overall (not a per-column quota), *before* the checkbox scan
    // below — so capped-out notes never pay for section loads/parsing either.
    //
    // ②/③ 은 서로 배타적(end_year 유/무)이고 합치면 매치 전량이므로, 각각 `cap + 1` 을 받아
    // 합이 cap 을 넘는지로 초과 여부를 판정한다. ① 은 ②의 부분집합이라 이 셈에 넣지 않는다.
    let over = cap as i64 + 1;
    let dated = board_rows(conn, &dated_sql(), workspace_id, over)?;
    let undated = board_rows(conn, &undated_sql(), workspace_id, over)?;
    let capped = dated.len() + undated.len() > cap;
    let total_matched: i64 = if capped {
        conn.query_row(BOARD_COUNT_SQL, [workspace_id], |r| r.get(0))
            .map_err(dberr)?
    } else {
        (dated.len() + undated.len()) as i64
    };

    // ① 핀 후보. 정확한 핀 판정은 여기서 기존 is_pinned 가 한다 — 오늘 의존 + checked_ord(달력상
    // 실재하지 않는 종료일 거부)라 SQL 로 못 내린다. 정렬 맥락은 노트 자신의 raw `status` 다
    // (컬럼 확정 이전) — 삭제된 커스텀 상태를 단 노트는 이 랭킹에서만 옛 컬럼에 있는 것처럼
    // 취급된다. 무해하다(버킷팅 후에는 정상).
    let pin_candidates = board_rows(conn, &pin_sql(), workspace_id, cap as i64)?;

    // 세 결과를 id 로 dedup 해 합친 뒤(합집합은 진짜 상위 cap 을 포함한다 — pin_sql 주석 참조)
    // **기존 비교자 그대로** 정렬하고 자른다. 후보는 최대 3*cap 이라 이 정렬은 코퍼스가 아니라
    // 캡에 비례한다. id 타이브레이크는 순수 결정성용(비교자가 완전히 같다고 본 두 행 사이).
    let mut seen: std::collections::HashSet<String> =
        std::collections::HashSet::with_capacity(3 * cap);
    let mut note_rows: Vec<BoardRow> = Vec::with_capacity(3 * cap);
    for row in pin_candidates
        .into_iter()
        .filter(|r| {
            is_pinned(
                r.remind,
                (Some(r.year), r.month, r.day),
                (r.end_year, r.end_month, r.end_day),
                today_ord,
                r.status.as_deref(),
            )
        })
        .chain(dated)
        .chain(undated)
    {
        if seen.insert(row.id.clone()) {
            note_rows.push(row);
        }
    }
    note_rows.sort_by(|a, b| {
        board_priority_cmp(
            a.remind,
            (Some(a.year), a.month, a.day),
            (a.end_year, a.end_month, a.end_day),
            &a.updated_at,
            a.status.as_deref(),
            0,
            b.remind,
            (Some(b.year), b.month, b.day),
            (b.end_year, b.end_month, b.end_day),
            &b.updated_at,
            b.status.as_deref(),
            0,
            today_ord,
        )
        .then_with(|| a.id.cmp(&b.id))
    });
    note_rows.truncate(cap);

    if note_rows.is_empty() {
        return Ok(BoardResult {
            columns,
            total_matched,
            cap: BOARD_NOTE_CAP as i64,
            capped,
        });
    }

    let note_ids: Vec<String> = note_rows.iter().map(|r| r.id.clone()).collect();
    // LIKE prefilter: only pull sections that might contain checkboxes; kind='text' only.
    // (diagram bodies are mermaid source — never checkboxes.)
    let sections_by_note = load_checkbox_candidate_sections(conn, &note_ids)?;

    for BoardRow {
        id,
        title,
        year,
        month,
        day,
        end_year,
        end_month,
        end_day,
        updated_at,
        status,
        remind,
        start_time,
    } in note_rows
    {
        let mut items: Vec<BoardTodoItem> = Vec::new();
        if let Some(secs) = sections_by_note.get(&id) {
            for (section_id, body) in secs {
                for cb in parse_checkboxes(body) {
                    items.push(BoardTodoItem {
                        section_id: section_id.clone(),
                        line_index: cb.line_index as i64,
                        text: cb.text,
                        checked: cb.checked,
                    });
                }
            }
        }
        let unchecked_count = items.iter().filter(|i| !i.checked).count() as i64;
        let note = BoardNote {
            id,
            title,
            year,
            month,
            day,
            start_time,
            end_year,
            end_month,
            end_day,
            remind,
            updated_at,
            unchecked_count,
            items,
        };
        // Orphan status (deleted custom) → null column so the note is still reachable.
        let key = match &status {
            Some(s) if col_ix.contains_key(&Some(s.clone())) => Some(s.clone()),
            Some(_) => None,
            None => None,
        };
        if let Some(&ix) = col_ix.get(&key) {
            columns[ix].notes.push(note);
        }
    }

    for col in &mut columns {
        let column_status = col.status.as_deref();
        col.notes
            .sort_by(|a, b| board_note_cmp(a, b, today_ord, column_status));
    }

    Ok(BoardResult {
        columns,
        total_matched,
        cap: BOARD_NOTE_CAP as i64,
        capped,
    })
}

/// Sections that look like they may contain checkboxes (SQL prefilter + kind=text).
fn load_checkbox_candidate_sections(
    conn: &Connection,
    note_ids: &[String],
) -> AppResult<HashMap<String, Vec<(String, String)>>> {
    let mut out: HashMap<String, Vec<(String, String)>> = HashMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    for chunk in note_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        // Prefetch bodies that mention taskItem or GFM checkbox markers.
        let sql = format!(
            "SELECT note_id, id, body_md FROM sections
             WHERE note_id IN ({placeholders})
               AND (kind = 'text' OR kind IS NULL)
               AND (
                 body_md LIKE '%taskItem%'
                 OR body_md LIKE '%- [ ]%'
                 OR body_md LIKE '%- [x]%'
                 OR body_md LIKE '%- [X]%'
                 OR body_md LIKE '%* [ ]%'
                 OR body_md LIKE '%* [x]%'
               )
             ORDER BY position"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(dberr)?;
        for row in rows {
            let (note_id, section_id, body) = row.map_err(dberr)?;
            out.entry(note_id)
                .or_default()
                .push((section_id, body));
        }
    }
    Ok(out)
}


// ── todo_toggle ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TodoToggleResult {
    pub note_id: String,
    pub section_id: String,
    pub line_index: i64,
    pub checked: bool,
    pub updated_at: String,
}

/// Flip one checkbox. Optimistic concurrency: `expected_checked` must match current state
/// (CONFLICT if the body was edited elsewhere). Reuses sections::update → FTS + updated_at.
pub fn todo_toggle(
    conn: &mut Connection,
    note_id: &str,
    section_id: &str,
    line_index: i64,
    expected_checked: bool,
) -> AppResult<TodoToggleResult> {
    if line_index < 0 {
        return Err(AppError::Validation(
            "line_index must be non-negative".into(),
        ));
    }
    let line_index_u = line_index as usize;

    // Confirm section belongs to note and is text.
    let (sec_note_id, body, kind): (String, String, String) = conn
        .query_row(
            "SELECT note_id, body_md, COALESCE(kind, 'text') FROM sections WHERE id=?1",
            [section_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional().map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("section not found: {section_id}")))?;

    if sec_note_id != note_id {
        return Err(AppError::Validation(format!(
            "section {section_id} does not belong to note {note_id}"
        )));
    }
    if kind != "text" {
        return Err(AppError::Validation(format!(
            "cannot toggle checkbox in section kind={kind}"
        )));
    }

    // Note must be alive. W7-f: archived_at intentionally NOT checked here — this is a per-note
    // edit action (toggling a checkbox inside a section), not a listing/browsing surface, and
    // archived notes stay fully editable (only hidden from passive browsing). Mirrors note_get/
    // note_summary's existing deleted_at-only posture for single-note lookups.
    let alive: bool = conn
        .query_row(
            "SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL",
            [note_id],
            |_| Ok(true),
        )
        .optional().map_err(dberr)?
        .unwrap_or(false);
    if !alive {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }

    let items = parse_checkboxes(&body);
    let current = items.get(line_index_u).ok_or_else(|| {
        AppError::Validation(format!(
            "checkbox line_index out of range: {line_index} (section has {} items)",
            items.len()
        ))
    })?;
    if current.checked != expected_checked {
        return Err(AppError::Conflict(format!(
            "checkbox state mismatch at line_index {line_index}: expected checked={expected_checked}, actual checked={}",
            current.checked
        )));
    }

    let new_checked = !expected_checked;
    let new_body = toggle_checkbox_in_body(&body, line_index_u, new_checked).ok_or_else(|| {
        AppError::Validation(format!(
            "failed to toggle checkbox at line_index {line_index}"
        ))
    })?;

    // ai_origin: None (보존) — 체크박스 토글은 저작권 판정 지점이 아니다.
    let updated_at = sections::update(conn, section_id, None, Some(new_body), None)?;

    Ok(TodoToggleResult {
        note_id: note_id.to_string(),
        section_id: section_id.to_string(),
        line_index,
        checked: new_checked,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::error::AppError;
    use crate::repo::{fts, notes, sections as sec};
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn ws_and_folder(conn: &Connection) -> (String, String) {
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        (ws, folder)
    }

    // ── parse ──────────────────────────────────────────────────────────────

    #[test]
    fn parse_gfm_nested_indent_and_checked() {
        let body = "\
# list
- [ ] top
  - [x] nested child
- [X] also checked
plain line
* [ ] star bullet
";
        let items = parse_checkboxes(body);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].text, "top");
        assert!(!items[0].checked);
        assert_eq!(items[0].line_index, 0);
        assert_eq!(items[1].text, "nested child");
        assert!(items[1].checked);
        assert_eq!(items[2].text, "also checked");
        assert!(items[2].checked);
        assert_eq!(items[3].text, "star bullet");
    }

    #[test]
    fn parse_html_task_items_via_checklist() {
        let body = r#"<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Alpha</p></div></li><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Beta</p></div></li></ul>"#;
        let items = parse_checkboxes(body);
        assert_eq!(items.len(), 2);
        assert!(!items[0].checked);
        assert_eq!(items[0].text, "Alpha");
        assert!(items[1].checked);
        assert_eq!(items[1].text, "Beta");
    }

    #[test]
    fn parse_codeblock_gfm_false_positive_is_known_limit() {
        // Documented limit: GFM scanner does not skip fenced code blocks.
        let body = "```\n- [ ] fake\n```\n- [ ] real\n";
        let items = parse_checkboxes(body);
        assert_eq!(items.len(), 2, "limit: fenced '- [ ]' is also matched");
        assert_eq!(items[1].text, "real");
    }

    #[test]
    fn toggle_gfm_round_trip() {
        let body = "- [ ] one\n- [x] two\n";
        let flipped = toggle_checkbox_in_body(body, 0, true).unwrap();
        assert!(flipped.contains("- [x] one"));
        assert!(flipped.contains("- [x] two"));
        let back = toggle_checkbox_in_body(&flipped, 0, false).unwrap();
        assert!(back.contains("- [ ] one"));
    }
    /// W0 검증 결함: 프런트 generateHTML 이 내는 표 조각(셀 안 체크리스트, 속성 순서 data-checked → data-type)이 본문에
    /// 있으면 이 한 항목 때문에 HTML 전용 모드로 넘어가 같은 본문의 GFM 할 일이 전부 사라졌다(parse 도 toggle 도).
    const GFM_BODY_WITH_CELL_CHECKLIST_TABLE: &str = "- [ ] 2026-10-08 보고서\n- [x] 회의\n\n<table style=\"min-width: 50px;\"><tbody><tr><th colspan=\"2\" rowspan=\"1\"><p>제목</p></th></tr><tr><td colspan=\"1\" rowspan=\"1\"><ul data-type=\"taskList\"><li data-checked=\"false\" data-type=\"taskItem\"><label><input type=\"checkbox\"><span></span></label><div><p>마감</p></div></li></ul></td><td colspan=\"1\" rowspan=\"1\"><p>x</p></td></tr></tbody></table>\n\n- [ ] 마무리\n";

    #[test]
    fn parse_gfm_checkboxes_survive_a_table_fragment_with_a_cell_checklist() {
        let items = parse_checkboxes(GFM_BODY_WITH_CELL_CHECKLIST_TABLE);
        assert_eq!(
            items,
            vec![
                ParsedCheckbox { line_index: 0, text: "2026-10-08 보고서".to_string(), checked: false },
                ParsedCheckbox { line_index: 1, text: "회의".to_string(), checked: true },
                ParsedCheckbox { line_index: 2, text: "마무리".to_string(), checked: false },
            ],
            "표 밖 GFM 할 일 셋이 모두 보이고 표 셀 안 항목은 세지 않는다"
        );
    }

    #[test]
    fn toggle_gfm_checkbox_survives_a_table_fragment_with_a_cell_checklist() {
        let body = GFM_BODY_WITH_CELL_CHECKLIST_TABLE;
        let flipped = toggle_checkbox_in_body(body, 2, true).unwrap();
        assert_eq!(flipped, body.replace("- [ ] 마무리", "- [x] 마무리"), "표 조각은 한 글자도 안 바뀐다");
        let first = toggle_checkbox_in_body(body, 0, true).unwrap();
        assert!(first.contains("- [x] 2026-10-08 보고서"));
        assert!(toggle_checkbox_in_body(body, 3, true).is_none(), "표 안 항목은 번호가 없다");
    }

    #[test]
    fn html_mode_ordinals_skip_table_cell_items_in_parse_and_toggle() {
        let item = |checked: &str, text: &str| {
            format!("<li data-type=\"taskItem\" data-checked=\"{checked}\"><label><input type=\"checkbox\"><span></span></label><div><p>{text}</p></div></li>")
        };
        let body = format!(
            "<ul data-type=\"taskList\">{}</ul><table><tr><td><ul data-type=\"taskList\">{}</ul></td></tr></table><ul data-type=\"taskList\">{}</ul>",
            item("false", "가"),
            item("false", "셀"),
            item("false", "나")
        );
        let items = parse_checkboxes(&body);
        assert_eq!(items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), vec!["가", "나"]);
        let flipped = toggle_checkbox_in_body(&body, 1, true).unwrap();
        // parse 가 1 번이라 한 항목은 표 뒤의 "나" 다 — 표 셀 안 "셀" 이 아니다.
        let after = parse_checkboxes(&flipped);
        assert_eq!(after.iter().map(|i| i.checked).collect::<Vec<_>>(), vec![false, true]);
        assert_eq!(flipped.matches("data-checked=\"true\"").count(), 1);
    }

    // ── sort ───────────────────────────────────────────────────────────────

    fn note_for_sort(
        id: &str,
        remind: bool,
        end: (Option<i64>, Option<i64>, Option<i64>),
        updated_at: &str,
    ) -> BoardNote {
        note_for_sort_with_unchecked(id, remind, end, updated_at, 0)
    }

    fn note_for_sort_with_unchecked(
        id: &str,
        remind: bool,
        end: (Option<i64>, Option<i64>, Option<i64>),
        updated_at: &str,
        unchecked_count: i64,
    ) -> BoardNote {
        BoardNote {
            id: id.into(),
            title: id.into(),
            year: 2020,
            month: None,
            day: None,
            start_time: None,
            end_year: end.0,
            end_month: end.1,
            end_day: end.2,
            remind,
            updated_at: updated_at.into(),
            unchecked_count,
            items: vec![],
        }
    }

    // start=(None,None,None) throughout this test: no start info means pin_anchor_ord always
    // resolves to `end` (or None), so this exercises exactly the old end-triple-only behavior
    // these assertions were written for.
    #[test]
    fn is_pinned_requires_remind_full_precision_past_and_not_done_column() {
        let today_ord = NaiveYmd { y: 2026, m: 7, d: 31 }.to_ord();
        let none = (None, None, None);
        // remind off — never pinned even if end is long past.
        assert!(!is_pinned(false, none, (Some(2026), Some(7), Some(1)), today_ord, None));
        // remind on, full precision, past — pinned.
        assert!(is_pinned(true, none, (Some(2026), Some(7), Some(1)), today_ord, None));
        // remind on, full precision, but not yet past (today itself, or future) — not pinned.
        assert!(!is_pinned(true, none, (Some(2026), Some(7), Some(31)), today_ord, None));
        assert!(!is_pinned(true, none, (Some(2026), Some(8), Some(1)), today_ord, None));
        // remind on, year-only precision — never pinned regardless of how "old" the year is.
        assert!(!is_pinned(true, none, (Some(2020), None, None), today_ord, None));
        // remind on, full precision, very old — no time-window cutoff (owner: "1598년 노트라도
        // 사용자가 켰다면 그대로"), still pinned.
        assert!(is_pinned(true, none, (Some(1598), Some(1), Some(1)), today_ord, None));
        // The done column is exempt regardless of remind/date — a finished note never pins.
        assert!(!is_pinned(true, none, (Some(2026), Some(7), Some(1)), today_ord, Some("done")));
        // Calendar-invalid end date (Feb 30 — write validation only range-checks 1..31, never
        // catches this) must not panic; treated as "not pinned" rather than crashing the board.
        assert!(!is_pinned(true, none, (Some(2024), Some(2), Some(30)), today_ord, None));
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): is_pinned 는 이제 시각 유무를 전혀 보지 않는다 —
    /// "미처리"는 종료일(없으면 시작일)만 본다. 옛 `is_pinned_follows_the_shared_anchor_rule`
    /// 테스트는 `schedule::anchor_date`(시각 있으면 시작일)를 공유한다는 것을 고정했는데, 그
    /// 함수가 삭제됐으니 이 테스트도 "종료일이 있으면 항상 종료일" 규칙으로 갱신한다.
    #[test]
    fn is_pinned_anchors_on_end_when_present_else_start() {
        let today_ord = NaiveYmd { y: 2026, m: 7, d: 31 }.to_ord();
        let past_start = (Some(2026), Some(7), Some(1));
        let future_end = (Some(2999), Some(1), Some(1));
        // 종료일이 미래면 시작일이 아무리 과거라도 핀이 아니다 — 시각 유무는 더 이상 안 본다.
        assert!(!is_pinned(true, past_start, future_end, today_ord, None));
        // 종료일이 없으면 시작일로 떨어져 과거면 핀이다.
        assert!(is_pinned(true, past_start, (None, None, None), today_ord, None));
        // 종료일 없음 + 시작일이 연 정밀도뿐 — 여전히 핀 아님(풀 정밀도 요구 유지).
        assert!(!is_pinned(true, (Some(2020), None, None), (None, None, None), today_ord, None));
    }

    /// Regression: a note with a calendar-invalid stored end date (write-time validation only
    /// range-checks end_day 1..31, never day-in-month legality — see validate_end_triple in
    /// repo/notes/mod.rs) must not panic dashboard_board or due_reminders when remind=1.
    #[test]
    fn invalid_stored_end_date_does_not_panic_board_or_due_reminders() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("Bad date".into()), None).unwrap();
        notes::set_event_end(&mut conn, &n.note.id, Some(2024), Some(2), Some(30)).unwrap();
        notes::update(&mut conn, &n.note.id, None, None, None, Some(true)).unwrap();

        // Neither call panics; the invalid-dated note is simply never pinned/overdue.
        let result = board(&conn, &ws).unwrap();
        let found = result.columns.iter().flat_map(|c| c.notes.iter()).find(|n2| n2.id == n.note.id);
        assert!(found.is_some(), "note still shows up on the board");

        let overdue = due_reminders(&conn, &ws).unwrap();
        assert!(
            overdue.iter().all(|r| r.note_id != n.note.id),
            "calendar-invalid end date must not surface as an overdue pin"
        );
    }

    /// 2026-09-07 결함 수정의 핵심 케이스, 실제 SQL 경로 전체(board()·due_reminders() 둘 다)로
    /// 고정: remind=1·과거 시작일·종료일 없음인 종일 노트는 예전엔 어디에도 안 잡혔다(발화는
    /// 되지만 미처리 목록엔 영영 안 뜸). 이제 칸반 핀에도, 벨/펫의 due_reminders 에도 뜨고,
    /// 둘의 답이 같아야 한다(같은 노트 집합에 대해 다른 규칙을 쓰던 게 결함의 뿌리였다).
    #[test]
    fn remind_note_with_only_a_past_start_date_now_pins_and_shows_as_overdue() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);

        // 종료일 없는 과거 종일 노트, remind=1.
        let n = notes::create(&mut conn, &folder, Some("종일 알림".into()), Some(2020)).unwrap();
        notes::set_event_precision(&mut conn, &n.note.id, Some(1), Some(1)).unwrap();
        notes::update(&mut conn, &n.note.id, None, None, None, Some(true)).unwrap();

        // 대조군: 같은 과거 시작일이지만 remind 가 꺼져 있다 — 핀/미처리 둘 다 아니어야 한다.
        let control = notes::create(&mut conn, &folder, Some("알림 꺼짐".into()), Some(2020)).unwrap();
        notes::set_event_precision(&mut conn, &control.note.id, Some(1), Some(1)).unwrap();

        let result = board(&conn, &ws).unwrap();
        let pinned_ids: Vec<&str> = result
            .columns
            .iter()
            .flat_map(|c| c.notes.iter())
            .take(1) // pin 티어가 있으면 전역 우선순위상 항상 맨 앞 컬럼의 맨 앞 카드.
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(pinned_ids, vec![n.note.id.as_str()], "과거 시작일 + remind 노트가 핀으로 뜬다");

        let overdue = due_reminders(&conn, &ws).unwrap();
        let overdue_ids: Vec<&str> = overdue.iter().map(|r| r.note_id.as_str()).collect();
        assert_eq!(overdue_ids, vec![n.note.id.as_str()], "벨/펫도 같은 노트를 미처리로 본다");
        assert_eq!(overdue[0].kind, ReminderKind::Overdue);
    }

    // ── D3 철회(2026-09-07 D10): 관련 날짜(note_dates) 알림 ─────────────────────

    /// 지난 관련 날짜(remind=1)는 due_reminders(벨/펫)의 미처리에 잡히고 related_date_id 가
    /// 채워진다 — 하지만 칸반 핀(board())에는 절대 안 나타난다(핀의 완료 수단은 노트 상태 done,
    /// 관련 날짜의 완료 수단은 토글이라 서로 안 맞는다는 의도된 비대칭).
    #[test]
    fn overdue_related_date_surfaces_in_due_reminders_but_never_pins_the_kanban() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        // 노트 자신은 remind 를 켜지 않는다 — 관련 날짜 알림은 노트의 remind 와 독립이어야 한다.
        let n = notes::create(&mut conn, &folder, Some("행사".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2020, Some(1), Some(1), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();
        // 대조군: 실제로 핀이 붙는 노트(notes.remind=1 + 과거 사건 축) — 핀 티어가 존재함을
        // 확인해야 "관련 날짜 노트가 핀 리스트 맨 앞에 없다"는 것이 의미가 있다(노트 하나뿐이면
        // 무조건 첫 칸 첫 자리라 이 대조군 없이는 가짜로 통과한다).
        let pinned_control = notes::create(&mut conn, &folder, Some("진짜 핀".into()), Some(2020)).unwrap();
        // 핀은 remind 에 더해 **풀 정밀도**(연·월·일) 기준일이 과거여야 붙는다(is_pinned → pin_anchor_ord).
        // 예전엔 연도만 줘서 대조군이 핀이 아니었다 — 두 노트 모두 비핀이라 순서가 updated_at 동률에서 갈려,
        // 시계가 넘어가는 운에 기대 통과하다 CI 에서 실패했다(2026-10-23). 월·일을 채워 진짜 핀으로 만든다
        // (pin_anchor_sort_key 는 year/month/day 의 생성 열이라 직접 UPDATE 로 반영된다).
        conn.execute("UPDATE notes SET remind=1, month=1, day=1 WHERE id=?1", [&pinned_control.note.id]).unwrap();

        let overdue = due_reminders(&conn, &ws).unwrap();
        let target: Vec<_> = overdue.iter().filter(|r| r.note_id == n.note.id).collect();
        assert_eq!(target.len(), 1);
        assert_eq!(target[0].kind, ReminderKind::Overdue);
        assert_eq!(target[0].related_date_id.as_deref(), Some(date_id.as_str()));

        // 칸반 핀 맨 앞자리는 대조군이 차지하고, 관련 날짜만 가진 노트는 안 뜬다 — notes.remind
        // 가 꺼져 있으니 board() 의 pin_sql/is_pinned 경로가 애초에 후보로도 안 본다.
        let result = board(&conn, &ws).unwrap();
        let pinned_first: Vec<&str> = result
            .columns
            .iter()
            .flat_map(|c| c.notes.iter())
            .take(1)
            .map(|n2| n2.id.as_str())
            .collect();
        assert_eq!(
            pinned_first,
            vec![pinned_control.note.id.as_str()],
            "핀 맨 앞자리는 진짜 핀 대조군 것이지 관련 날짜만 가진 노트가 아니다"
        );
    }

    /// 토글을 끄면(note_date_set_remind 의 완료 수단) 벨/펫의 미처리에서 사라진다.
    #[test]
    fn turning_off_the_related_date_reminder_removes_it_from_due_reminders() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("행사".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2020, Some(1), Some(1), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();
        assert_eq!(due_reminders(&conn, &ws).unwrap().len(), 1);

        notes::set_remind(&mut conn, &date_id, false).unwrap();
        assert!(due_reminders(&conn, &ws).unwrap().is_empty(), "토글을 끄면 벨에서 사라진다");
    }

    /// 아카이브된 노트의 관련 날짜는 remind=1 이어도 울리지 않는다 — candidates() 와 같은
    /// 아카이브/휴지통 제외 규칙을 관련 날짜도 따른다.
    #[test]
    fn archived_notes_related_dates_do_not_surface_as_overdue() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("보관됨".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2020, Some(1), Some(1), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();
        conn.execute("UPDATE notes SET archived_at='x' WHERE id=?1", [&n.note.id]).unwrap();

        assert!(due_reminders(&conn, &ws).unwrap().is_empty());
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 기간을 가진 관련 날짜의 미처리 기준일은
    /// 종료일이다(pin_anchor_ord — end.or(start), 시각 유무는 무관). 시작일이 아무리 과거라도
    /// 종료일이 아직 안 지났으면 미처리로 잡히지 않는다.
    #[test]
    fn a_related_date_with_a_period_uses_the_end_date_as_the_overdue_anchor_not_the_start() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);

        // 시작은 아주 오래전이지만 종료는 아직 오지 않았다 — 옛 규칙(시작일=기준일)이었다면
        // 여기서 미처리로 잡혔을 것이다.
        let future = notes::create(&mut conn, &folder, Some("진행중".into()), Some(2020)).unwrap();
        let future_date_id =
            notes::date_add(&mut conn, &future.note.id, 1900, Some(1), Some(1), Some(2100), Some(1), Some(1), None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &future_date_id, true).unwrap();

        // 종료일도 지났다.
        let past = notes::create(&mut conn, &folder, Some("끝난 행사".into()), Some(2020)).unwrap();
        let past_date_id =
            notes::date_add(&mut conn, &past.note.id, 1900, Some(1), Some(1), Some(1999), Some(12), Some(31), None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &past_date_id, true).unwrap();

        let overdue = due_reminders(&conn, &ws).unwrap();
        assert_eq!(overdue.len(), 1, "종료일이 미래인 기간은 아직 미처리가 아니다");
        assert_eq!(overdue[0].related_date_id.as_deref(), Some(past_date_id.as_str()));
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): "발화"(항상 시작일)와 "미처리"(종료일, 없으면
    /// 시작일)는 이제 서로 다른 질문으로 완전히 분리된다 — 시각이 있어도 미처리 기준일은 여전히
    /// 종료일이다. 옛 테스트(`..._matching_fire`)는 "시각이 있으면 둘 다 시작일 기준이어야 한다"는
    /// 옛 `anchor_date` 규칙을 고정하고 있었는데, 그 전제 자체가 이 웨이브의 핵심 변경이라
    /// 뒤집는다.
    #[test]
    fn a_related_date_with_start_time_still_uses_end_for_overdue_even_though_fire_uses_start() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);

        // 시작은 지났고 종료는 아직 — 시각이 있어도 미처리 기준일은 종료일(미래)이라 아직 잡히지
        // 않아야 한다.
        let n = notes::create(&mut conn, &folder, Some("진행중 미팅".into()), Some(2020)).unwrap();
        let date_id =
            notes::date_add(&mut conn, &n.note.id, 1900, Some(1), Some(1), Some(2100), Some(1), Some(1), None, None, false, None, None, None).unwrap();
        notes::date_set_schedule(&mut conn, &date_id, true, Some("09:00".into()), None).unwrap();

        let overdue = due_reminders(&conn, &ws).unwrap();
        let target: Vec<_> = overdue.iter().filter(|r| r.related_date_id.as_deref() == Some(date_id.as_str())).collect();
        assert!(target.is_empty(), "시각이 있어도 미처리 기준일은 종료일 — 종료일이 미래면 아직 미처리가 아니다");
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(①): 후보 조회 통합의 부작용 — 관련 날짜도 이제
    /// `is_pinned` 의 status='done' 제외를 통과한다(옛 별도 쿼리는 이 제외를 몰랐다).
    #[test]
    fn overdue_related_date_of_a_done_note_is_excluded() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let n = notes::create(&mut conn, &folder, Some("완료된 행사".into()), Some(2020)).unwrap();
        let date_id = notes::date_add(&mut conn, &n.note.id, 2020, Some(1), Some(1), None, None, None, None, None, false, None, None, None).unwrap();
        notes::set_remind(&mut conn, &date_id, true).unwrap();
        conn.execute("UPDATE notes SET status='done' WHERE id=?1", [&n.note.id]).unwrap();

        assert!(
            due_reminders(&conn, &ws).unwrap().is_empty(),
            "done 노트의 관련 날짜는 이제 미처리에서도 제외된다"
        );
    }

    #[test]
    fn board_sort_pinned_first_then_schedule_ascending_then_recent() {
        let today_ord = NaiveYmd { y: 2026, m: 7, d: 31 }.to_ord();
        let mut notes = vec![
            note_for_sort("a", false, (None, None, None), "2026-07-30T00:00:00.000Z"),
            note_for_sort("b", true, (Some(2026), Some(7), Some(1)), "2026-07-01T00:00:00.000Z"),
            note_for_sort("c", true, (Some(2026), Some(8), Some(1)), "2026-07-20T00:00:00.000Z"),
            note_for_sort("d", true, (Some(2026), Some(7), Some(20)), "2026-07-29T00:00:00.000Z"),
            note_for_sort("e", false, (None, None, None), "2026-07-10T00:00:00.000Z"),
            // Year-only end — remind is set but precision is insufficient to pin.
            note_for_sort("f", true, (Some(2026), None, None), "2026-07-25T00:00:00.000Z"),
            // Full day precision, long past, but remind is OFF — never pins (opt-in only).
            note_for_sort("h", false, (Some(2026), Some(7), Some(20)), "2026-07-15T00:00:00.000Z"),
            // remind on, full day precision, ended long ago — still pins (no cutoff anymore).
            note_for_sort("g", true, (Some(2026), Some(1), Some(1)), "2026-07-15T00:00:00.000Z"),
        ];
        notes.sort_by(|a, b| board_note_cmp(a, b, today_ord, None));
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        // Pinned (remind + full-precision past end), end date ascending: g(01-01), b(07-01), d(07-20).
        // Then the rest by schedule (end asc, dateless last; ties by updated_at desc):
        // f(2026-01-01 approx from year-only), h(07-20), c(08-01) → then dateless a(07-30), e(07-10).
        assert_eq!(ids, vec!["g", "b", "d", "f", "h", "c", "a", "e"]);
    }

    #[test]
    fn board_sort_done_column_never_pins() {
        let today_ord = NaiveYmd { y: 2026, m: 7, d: 31 }.to_ord();
        let mut notes = vec![
            note_for_sort("old", true, (Some(2026), Some(7), Some(1)), "2026-07-01T00:00:00.000Z"),
            note_for_sort("new", true, (Some(2026), Some(7), Some(20)), "2026-07-29T00:00:00.000Z"),
        ];
        notes.sort_by(|a, b| board_note_cmp(a, b, today_ord, Some("done")));
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        // Neither pins in the done column — falls back to plain schedule ascending.
        assert_eq!(ids, vec!["old", "new"]);
    }

    #[test]
    fn board_sort_pin_then_open_checkbox_then_schedule_then_recent() {
        // Comparator tiers: pin > unchecked-checkbox > schedule > recent (updated_at desc).
        let today_ord = NaiveYmd { y: 2026, m: 7, d: 31 }.to_ord();
        let mut notes = vec![
            // Recent-only (no pin, no open checkbox, no end) — most recent updated_at.
            note_for_sort("recent", false, (None, None, None), "2026-07-30T00:00:00.000Z"),
            // Schedule: end date soon, no open checkbox — older updated_at so schedule wins over recent.
            note_for_sort(
                "sched",
                false,
                (Some(2026), Some(8), Some(1)),
                "2026-07-01T00:00:00.000Z",
            ),
            // Open checkbox, later end than sched so checkbox tier alone lifts it above schedule.
            note_for_sort_with_unchecked(
                "open_cb",
                false,
                (Some(2026), Some(9), Some(1)),
                "2026-07-01T00:00:00.000Z",
                2,
            ),
            // Pinned (remind + full-precision past end) — top regardless of checkbox/schedule.
            note_for_sort("pin", true, (Some(2026), Some(7), Some(1)), "2026-07-01T00:00:00.000Z"),
        ];
        notes.sort_by(|a, b| board_note_cmp(a, b, today_ord, None));
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["pin", "open_cb", "sched", "recent"]);
    }

    #[test]
    fn board_sort_fully_checked_lists_get_no_checkbox_priority() {
        // unchecked_count == 0 (fully checked or no todos) must not beat a scheduled note.
        let today_ord = NaiveYmd { y: 2026, m: 7, d: 31 }.to_ord();
        let mut notes = vec![
            // Fully checked (unchecked_count 0) with a late end — should not float above schedule.
            note_for_sort_with_unchecked(
                "all_done",
                false,
                (Some(2026), Some(12), Some(1)),
                "2026-07-30T00:00:00.000Z",
                0,
            ),
            // Has schedule earlier than all_done — wins schedule tier (both non-open-checkbox).
            note_for_sort(
                "sched_soon",
                false,
                (Some(2026), Some(8), Some(1)),
                "2026-07-01T00:00:00.000Z",
            ),
            // Open checkbox with even later end — still above both via checkbox tier.
            note_for_sort_with_unchecked(
                "still_open",
                false,
                (Some(2027), Some(1), Some(1)),
                "2026-07-01T00:00:00.000Z",
                1,
            ),
        ];
        notes.sort_by(|a, b| board_note_cmp(a, b, today_ord, None));
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        // still_open (open checkbox) → sched_soon (earlier end) → all_done (later end, no open cb)
        assert_eq!(ids, vec!["still_open", "sched_soon", "all_done"]);
    }
    // ── board integration ──────────────────────────────────────────────────

    #[test]
    fn board_groups_by_status_and_parses_items() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let n1 = notes::create(&mut conn, &folder, Some("Todo note".into()), None).unwrap();
        let n2 = notes::create(&mut conn, &folder, Some("Done note".into()), None).unwrap();
        notes::set_status(&mut conn, &n1.note.id, Some("in_progress".into())).unwrap();
        notes::set_status(&mut conn, &n2.note.id, Some("done".into())).unwrap();
        notes::set_event_end(&mut conn, &n1.note.id, Some(2020), Some(1), Some(1)).unwrap();

        let sec_id = &n1.sections[0].id;
        let body = "- [ ] buy milk\n- [x] already done\n";
        sec::update(&mut conn, sec_id, None, Some(body.into()), None).unwrap();

        // diagram section must not contribute checkboxes even if body looks like GFM
        sec::create_with_body_and_kind(
            &mut conn,
            &n1.note.id,
            Some("diagram".into()),
            "- [ ] not a real todo".into(),
            Some("diagram".into()),
        )
        .unwrap();

        let result = board(&conn, &ws).unwrap();
        // columns: null + 3 built-ins (+ any custom none)
        assert!(result.columns.len() >= 4);
        let prog = result
            .columns
            .iter()
            .find(|c| c.status.as_deref() == Some("in_progress"))
            .unwrap();
        assert_eq!(prog.notes.len(), 1);
        assert_eq!(prog.notes[0].unchecked_count, 1);
        assert_eq!(prog.notes[0].items.len(), 2);
        assert_eq!(prog.notes[0].items[0].text, "buy milk");
        assert!(!prog.notes[0].items[0].checked);
        // diagram fake not included
        assert!(!prog.notes[0]
            .items
            .iter()
            .any(|i| i.text.contains("not a real")));

        let done = result
            .columns
            .iter()
            .find(|c| c.status.as_deref() == Some("done"))
            .unwrap();
        assert_eq!(done.notes.len(), 1);

        // Small workspace never trips the cap.
        assert_eq!(result.total_matched, 2);
        assert_eq!(result.cap, BOARD_NOTE_CAP as i64);
        assert!(!result.capped);
    }

    #[test]
    fn board_cap_keeps_most_urgent_1000() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let total = BOARD_NOTE_CAP + 1;
        let mut ids = Vec::with_capacity(total);
        // No end_year (and no remind) on any note → none pin, all share the dateless schedule
        // bucket, so board_priority_cmp orders purely by updated_at DESC. Distinct, zero-padded
        // fractional seconds keep string sort == numeric sort, so note i's priority rank is
        // exactly i (higher i = more recently updated = higher priority).
        for i in 0..total {
            let ts = format!("2020-01-01T00:00:00.{i:04}Z");
            let d = notes::create_with_timestamp(
                &mut conn,
                &folder,
                Some(format!("n{i}")),
                Some(1900),
                None,
                None,
                Some(ts),
                None,
            )
            .unwrap();
            ids.push(d.note.id);
        }

        let result = board(&conn, &ws).unwrap();
        assert_eq!(result.total_matched, total as i64);
        assert_eq!(result.cap, BOARD_NOTE_CAP as i64);
        assert!(result.capped);

        let kept: Vec<&str> = result
            .columns
            .iter()
            .flat_map(|c| c.notes.iter())
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(kept.len(), BOARD_NOTE_CAP, "cap applies across all columns combined");
        // Most recently updated (highest i) survives; least recently updated (i=0) is dropped —
        // not a per-column proportional trim.
        assert!(kept.contains(&ids[total - 1].as_str()));
        assert!(!kept.contains(&ids[0].as_str()));
    }
    /// 캡 이전 우선순위 정렬이 SQL 로 내려간 뒤에도 **예전 Rust 경로와 같은 집합**을 남기는지.
    /// 레퍼런스는 옛 구현 그대로다: 전량을 받아 board_priority_cmp(unchecked=0)로 정렬 후 앞의
    /// cap 개. 티어를 전부 밟는 코퍼스를 깔고(핀 2 · done 컬럼의 과거 remind · 종료일 있음/없음 ·
    /// 연도 정밀도) 낮은 cap 으로 자른다.
    #[test]
    fn board_sql_precap_ranking_matches_the_old_rust_ranking() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);
        let (ty, tm, td) = today_ymd_local();
        let today_ord = NaiveYmd { y: ty, m: tm as u32, d: td as u32 }.to_ord();

        // (title, 시작 연도, 종료 (연, 월?, 일?), remind, status, updated_at)
        // updated_at 은 전부 달라 타이가 없다.
        #[allow(clippy::type_complexity)]
        let specs: Vec<(&str, i64, Option<(i64, Option<i64>, Option<i64>)>, bool, Option<&str>, &str)> = vec![
            ("pin_old", 1900, Some((1990, Some(6), Some(15))), true, None, "2020-01-01T00:00:00.001Z"),
            ("pin_new", 1900, Some((2000, Some(1), Some(1))), true, Some("in_progress"), "2020-01-01T00:00:00.002Z"),
            // done 컬럼은 핀 면제 — 과거 종료일 + remind 여도 일반 일정 티어로 내려간다.
            ("done_past", 1900, Some((1995, Some(1), Some(1))), true, Some("done"), "2020-01-01T00:00:00.003Z"),
            // 미래 종료일 → remind 여도 핀 아님.
            ("future", 1900, Some((2100, Some(1), Some(1))), true, None, "2020-01-01T00:00:00.004Z"),
            // 종료가 연 정밀도(월/일 NULL) → 핀 불가. schedule_bucket 은 그 해 1/1 로 채우고,
            // end_sort_key(V44) 도 같은 규칙이라 아래 jan_first 와 **정확히 같은 키**가 된다 —
            // 원시 3열 인덱스였다면 NULL 이 1 보다 앞서 여기서 순서가 어긋났을 자리다.
            ("year_only", 1900, Some((2050, None, None)), false, None, "2020-01-01T00:00:00.005Z"),
            ("jan_first", 1900, Some((2050, Some(1), Some(1))), false, None, "2020-01-01T00:00:00.006Z"),
            // 기원전 종료일 — 수치 정렬(SQL)과 문자열 정렬(Rust schedule_bucket)이 갈리는 자리.
            ("bce", -600, Some((-500, Some(3), Some(4))), false, None, "2020-01-01T00:00:00.007Z"),
            ("dateless_a", 1900, None, false, None, "2020-01-01T00:00:00.008Z"),
            ("dateless_b", 1900, None, false, Some("exported"), "2020-01-01T00:00:00.009Z"),
        ];
        for (title, start_year, end, remind, status, ts) in &specs {
            let d = notes::create_with_timestamp(
                &mut conn,
                &folder,
                Some((*title).into()),
                Some(*start_year),
                None,
                None,
                Some((*ts).into()),
                None,
            )
            .unwrap();
            if let Some((ey, em, ed)) = *end {
                notes::set_event_end(&mut conn, &d.note.id, Some(ey), em, ed).unwrap();
            }
            if let Some(s) = status {
                notes::set_status(&mut conn, &d.note.id, Some((*s).into())).unwrap();
            }
            // set_event_end / set_status 가 updated_at 을 bump 하므로 마지막에 되돌린다.
            conn.execute(
                "UPDATE notes SET remind=?1, updated_at=?2 WHERE id=?3",
                rusqlite::params![*remind as i64, ts, d.note.id],
            )
            .unwrap();
        }

        // 레퍼런스: 옛 경로 그대로 (전량 → Rust 정렬 → 앞의 cap 개).
        let all = board_capped(&conn, &ws, 1000).unwrap();
        assert!(!all.capped);
        let mut every: Vec<(BoardNote, Option<String>)> = all
            .columns
            .iter()
            .flat_map(|c| c.notes.iter().map(|n| (n.clone(), c.status.clone())))
            .collect();
        assert_eq!(every.len(), specs.len());
        every.sort_by(|(a, sa), (b, sb)| {
            board_priority_cmp(
                a.remind,
                (Some(a.year), a.month, a.day),
                (a.end_year, a.end_month, a.end_day),
                &a.updated_at,
                sa.as_deref(),
                0,
                b.remind,
                (Some(b.year), b.month, b.day),
                (b.end_year, b.end_month, b.end_day),
                &b.updated_at,
                sb.as_deref(),
                0,
                today_ord,
            )
        });

        for cap in [1usize, 2, 3, 5, 6, 8] {
            let expected: std::collections::BTreeSet<String> = every
                .iter()
                .take(cap)
                .map(|(n, _)| n.title.clone())
                .collect();
            let got: std::collections::BTreeSet<String> = board_capped(&conn, &ws, cap)
                .unwrap()
                .columns
                .iter()
                .flat_map(|c| c.notes.iter())
                .map(|n| n.title.clone())
                .collect();
            assert_eq!(got, expected, "cap={cap} 에서 남는 노트 집합이 옛 랭킹과 달라졌다");
        }

        // 캡 이내(cap == 전체 수)에서는 아무것도 잘리지 않고 capped=false, total 도 그대로.
        let exact = board_capped(&conn, &ws, specs.len()).unwrap();
        assert!(!exact.capped);
        assert_eq!(exact.total_matched, specs.len() as i64);
        assert_eq!(
            exact.columns.iter().map(|c| c.notes.len()).sum::<usize>(),
            specs.len()
        );

        // 캡 초과 시 total_matched 는 캡이 아니라 전체 매치 수(별도 COUNT 경로).
        let over = board_capped(&conn, &ws, 2).unwrap();
        assert!(over.capped);
        assert_eq!(over.total_matched, specs.len() as i64);
        assert_eq!(over.columns.iter().map(|c| c.notes.len()).sum::<usize>(), 2);
    }

    /// 3쿼리 분할이 절단 기준을 **더 정확하게** 만든 지점: 캡 이전 랭킹을 통짜 SQL `ORDER BY`
    /// 로 하던 시절에는 핀 티어가 `end_year*10000 + …< 오늘` 숫자 비교였고, 2월 30일처럼 달력상
    /// 존재하지 않는 종료일도 그 비교를 통과해 핀 자리를 차지했다(is_pinned 는 checked_ord 로
    /// 거부하는데도). 이제 핀 판정 자체를 Rust 가 하므로 그 행은 핀 스트림에 들어가지 못한다.
    /// cap=1: 종료일이 더 이른 손상 행이 아니라 **진짜 핀**이 살아남아야 한다.
    #[test]
    fn calendar_invalid_end_date_no_longer_squats_the_pin_tier_at_the_cap() {
        let mut conn = setup_db();
        let (ws, folder) = ws_and_folder(&conn);

        let bad = notes::create_with_timestamp(
            &mut conn, &folder, Some("bad".into()), Some(1900), None, None,
            Some("2020-01-01T00:00:00.001Z".into()), None,
        )
        .unwrap()
        .note
        .id;
        // 2024-02-30: 쓰기 검증은 1..31 범위만 보므로 저장된다. 종료일이 real_pin 보다 이르다.
        notes::set_event_end(&mut conn, &bad, Some(2024), Some(2), Some(30)).unwrap();

        let real = notes::create_with_timestamp(
            &mut conn, &folder, Some("real".into()), Some(1900), None, None,
            Some("2020-01-01T00:00:00.002Z".into()), None,
        )
        .unwrap()
        .note
        .id;
        notes::set_event_end(&mut conn, &real, Some(2025), Some(1), Some(1)).unwrap();
        conn.execute("UPDATE notes SET remind=1", []).unwrap();

        let kept: Vec<String> = board_capped(&conn, &ws, 1)
            .unwrap()
            .columns
            .iter()
            .flat_map(|c| c.notes.iter())
            .map(|n| n.title.clone())
            .collect();
        assert_eq!(
            kept,
            vec!["real".to_string()],
            "달력상 없는 종료일은 핀이 아니므로 진짜 핀에 밀려야 한다"
        );
    }

    /// 계획 고정: 세 티어 쿼리가 각각 **자기 부분 인덱스에서 순서를 그대로 가져와야** 한다.
    /// `USE TEMP B-TREE` 가 하나라도 나오면 그 쿼리는 다시 전 행을 정렬기에 밀어 넣는 것이고,
    /// 이 웨이브가 없앤 바로 그 비용이 돌아온 것이다.
    #[test]
    fn board_tier_queries_read_their_indexes_in_order() {
        let conn = setup_db();
        let plan = |sql: &str| -> String {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            stmt.query_map(rusqlite::params!["ws", 1i64], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap()
                .join(" | ")
        };
        for (name, sql, index) in [
            ("pin", pin_sql(), "idx_notes_remind_anchor"),
            ("dated", dated_sql(), "idx_notes_end_sort_alive"),
            ("undated", undated_sql(), "idx_notes_undated_updated_alive"),
        ]
        .map(|(n, s, i)| (n, plan(&s), i))
        {
            println!("board {name} plan: {sql}");
            assert!(sql.contains(index), "{name} 는 {index} 를 타야 한다: {sql}");
            assert!(
                !sql.contains("TEMP B-TREE"),
                "{name} 정렬이 인덱스에서 안 나오면 다시 코퍼스 비례다: {sql}"
            );
        }
    }

    // ── todo_toggle ────────────────────────────────────────────────────────

    #[test]
    fn todo_toggle_round_trip_and_conflict() {
        let mut conn = setup_db();
        let (_ws, folder) = ws_and_folder(&conn);
        let detail = notes::create(&mut conn, &folder, Some("T".into()), None).unwrap();
        let sid = detail.sections[0].id.clone();
        let nid = detail.note.id.clone();
        sec::update(
            &mut conn,
            &sid,
            None,
            Some("- [ ] alpha\n- [ ] beta\n".into()),
            None,
        )
        .unwrap();

        let r1 = todo_toggle(&mut conn, &nid, &sid, 0, false).unwrap();
        assert!(r1.checked);
        let body: String = conn
            .query_row("SELECT body_md FROM sections WHERE id=?1", [&sid], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(body.contains("- [x] alpha"));

        // Conflict: expected still false but actual is true
        let err = todo_toggle(&mut conn, &nid, &sid, 0, false).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));

        // Round trip back
        let r2 = todo_toggle(&mut conn, &nid, &sid, 0, true).unwrap();
        assert!(!r2.checked);
    }

    #[test]
    fn todo_toggle_updates_fts() {
        let mut conn = setup_db();
        let (_ws, folder) = ws_and_folder(&conn);
        let detail = notes::create(&mut conn, &folder, Some("FTS note".into()), None).unwrap();
        let sid = detail.sections[0].id.clone();
        let nid = detail.note.id.clone();
        // Unique token so FTS MATCH is unambiguous
        sec::update(
            &mut conn,
            &sid,
            None,
            Some("- [ ] uniquezebraxylophone99\n".into()),
            None,
        )
        .unwrap();
        // Baseline FTS already upserted by section_update.
        let count_before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'uniquezebraxylophone99'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_before, 1);

        todo_toggle(&mut conn, &nid, &sid, 0, false).unwrap();
        // Token still present after toggle (checkbox mark change shouldn't drop body text).
        let count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'uniquezebraxylophone99'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_after, 1);

        // And body in FTS reflects [x]
        let body_fts: String = conn
            .query_row(
                "SELECT body FROM notes_fts WHERE note_id=?1",
                [&nid],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            body_fts.contains("[x]") || body_fts.contains("uniquezebraxylophone99"),
            "fts body should still contain the item text: {body_fts}"
        );
        let _ = fts::clear_all; // keep import if needed
    }
}
