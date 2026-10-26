// repo::notes::dates — note_dates table (PLAN-2026-09-08-dates-rebuild.md W1). 행 하나가 정밀도
// 사다리(연→월→일→시:분)를 갖고, position=0 이 사건 축(대표)이다. **note_dates 가 진실이고
// notes.{year,month,day,end_*,remind,start_time,end_time,remind_offset_min,rrule} 은 position=0
// 행의 투영(mirror)이다** — 루틴(repo::routine)·달력(repo::dashboard::calendar, 부분 인덱스
// idx_notes_rrule_span)·note_query.rs·transfer/render.rs·ical 내보내기가 그 컬럼을 읽는다.
// `project_primary()` 가 그 투영을 갱신하는 유일한 함수 — 행을 만들거나 고치거나 지우거나
// position 을 바꾸는 모든 경로가 같은 트랜잭션에서 이걸 부른다.
//
// note_regions(V27)의 형제 — 같은 INSERT+DELETE 전용 규율, 같은 삭제 시 tombstone(docs/SYNC.md
// §8.1). position 에 UNIQUE(note_id, position) 를 걸지 않는다 — note_regions 의 position 도
// 플레인 인덱스뿐이고 region_reorder 가 여러 행의 position 을 한 트랜잭션 안에서 겹치는 값을
// 거쳐 재배치한다(regions.rs); date_make_primary 의 position 교환도 같은 이유로 sentinel 값이
// 필요 없다.
//
// PLAN-2026-09-08-dates-rebuild.md W3(§①②): 커맨드 표면이 이제 데이터 모델(모든 행이 같은
// 컬럼)을 그대로 반영한다 — `date_add`/`date_update` 둘 다 정밀도 사다리 전체(연→월→일, 기간,
// 시각, 알림, 반복)를 입출력한다. 대표(position 0)와 관련 날짜(position != 0) 사이에 능력 차이가
// 없다: 반복도 시각도 어느 행에나 붙는다. `dates_list` 는 여전히 position != 0(관련 날짜)만
// 돌려준다 — position=0 은 note_get/NoteSummary 가 이미 notes.* 투영으로 노출하므로 두 번 싣지
// 않는다(§4 코드 방침: 이 결정은 W3 보고서에 근거와 함께 남긴다).
//
// 검증은 새 함수를 만들지 않고 기존 관문만 재사용한다(super::validate_month_day/
// validate_end_triple/assert_start_not_after_end, repo::schedule::parse_hhmm_min,
// repo::schedule::rrule::parse_for_seed) — 그래서 이 검증들은 **달력상 실재 여부(2월 30일 등)를
// 보지 않는다**(대표 축과 동일 자세, mod.rs::validate_month_day 주석 참조). 옛 `parse_date`
// 기반의 문자열 형식 검증(date_add 가 이전에 하던 것)보다 느슨해진 것은 의도된 변화다 — 모든
// 행이 대표와 같은 검증을 받는다는 원칙(§1.1)의 자연스러운 결과.
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::dashboard::dateord::NaiveYmd;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};

/// "YYYY-MM-DD" 풀 정밀도만 허용. 형식이 깨졌거나 실재하지 않는 날짜(2026-02-30 등)는 None —
/// repo::schedule::parse_stamp 와 같은 자세(모양 + 달력 유효성을 한 번에 본다), 달력 규칙 자체는
/// NaiveYmd::checked_ord(chrono 위임)에 맡겨 윤년 등을 재구현하지 않는다.
///
/// W3: 커맨드 표면(date_add/date_update)은 더 이상 이 함수를 쓰지 않는다(트리플 정수를 직접
/// 받는다) — 옛 번들 호환(`transfer/import/mod.rs::insert_note_date`)만 이 함수를 쓴다.
pub(crate) fn parse_date(s: &str) -> Option<NaiveYmd> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let ymd = NaiveYmd {
        y: s[0..4].parse().ok()?,
        m: s[5..7].parse().ok()?,
        d: s[8..10].parse().ok()?,
    };
    ymd.checked_ord()?;
    Some(ymd)
}

/// position=0 행을 읽어 notes.* 의 대응 컬럼 전부에 그대로 쓴다(§1.2 투영). 이 트랜잭션 안에서
/// note_dates 를 건드린 모든 경로가 마지막에 이 함수를 부른다 — notes.* 를 직접 쓰는 지점을
/// 하나로 좁혀 두 벌이 어긋나는 것(드리프트)을 구조적으로 막는다. docs/SYNC.md §8.1과 동일
/// 우회로 notes.updated_at 도 함께 올린다(note_dates 자체엔 updated_at 이 없다).
///
/// position=0 행이 없으면(불변식 위반 — §7-2) 조용히 넘어가지 않고 에러로 드러낸다: 침묵하면
/// 드리프트를 은폐할 뿐이고, 이 함수를 부르는 모든 경로는 이미 그 노트가 존재함을 확인했으므로
/// (note_summary/exists 조회) 정상 상태에서는 항상 성공해야 한다.
pub(crate) fn project_primary(tx: &rusqlite::Transaction, note_id: &str) -> AppResult<()> {
    #[allow(clippy::type_complexity)]
    let row: Option<(
        i64,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        bool,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    )> = tx
        .query_row(
            "SELECT year, month, day, end_year, end_month, end_day, remind, start_time, end_time, remind_offset_min, rrule
             FROM note_dates WHERE note_id=?1 AND position=0",
            [note_id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?,
                ))
            },
        )
        .optional()
        .map_err(dberr)?;
    let Some((year, month, day, end_year, end_month, end_day, remind, start_time, end_time, remind_offset_min, rrule)) = row else {
        return Err(AppError::Db(format!(
            "project_primary: note {note_id} has no position=0 note_dates row (invariant violated)"
        )));
    };
    tx.execute(
        "UPDATE notes SET year=?1, month=?2, day=?3, end_year=?4, end_month=?5, end_day=?6, remind=?7, start_time=?8, end_time=?9, remind_offset_min=?10, rrule=?11, updated_at=?12 WHERE id=?13",
        params![
            year, month, day, end_year, end_month, end_day, remind, start_time, end_time, remind_offset_min, rrule, now_iso(), note_id
        ],
    )
    .map_err(dberr)?;
    Ok(())
}

/// 노트 생성 경로 전부가 지나는 단일 지점 — 새 노트의 position=0 행을 심는다(노트 자신이 곧
/// 사건 축이므로 notes.* 와 같은 값으로 함께 만든다: 드리프트가 생길 시점 자체가 없다).
/// repo::notes::create_with_sections_with_hook(note_create 등) · commands::ai::create_plan_note_tx
/// (AI 플랜 "새 노트 만들기") · repo::transfer::import::insert_note(가져오기 3경로: add_notebook·
/// hash_merge·replace_merge) 가 이 함수를 부른다.
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_primary_row(
    tx: &rusqlite::Transaction,
    note_id: &str,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: Option<&str>,
    end_time: Option<&str>,
    remind: bool,
    remind_offset_min: Option<i64>,
    rrule: Option<&str>,
    created_at: &str,
) -> AppResult<()> {
    // ponytail: 방어선 — migrations.rs 의 마이그레이션 히스토리 테스트 몇몇은 `notes::create` 를
    // note_dates 가 아직 없던(V70 이전) 옛 스키마 스냅샷 위에서 그대로 호출해 데이터를 심는다
    // (예: test_v69_diagram_migration, `m[..68]`). 실제 앱은 항상 `migrations::run()` 을 거친
    // 뒤에만 커맨드를 받으므로 이 분기는 프로덕션에서 절대 타지 않는다 — 타면 그냥 조용히
    // 생략한다(그 노트는 나중에 실제 마이그레이션이 통째로 지나가면서 정상적으로 채워진다).
    let table_exists: bool = tx
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_dates'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !table_exists {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO note_dates(id, note_id, position, year, month, day, end_year, end_month, end_day, start_time, end_time, remind, remind_offset_min, rrule, created_at)
         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            new_id(), note_id, year, month, day, end_year, end_month, end_day, start_time, end_time, remind, remind_offset_min, rrule, created_at
        ],
    )
    .map_err(dberr)?;
    Ok(())
}

/// 이 노트의 관련 날짜(position != 0) 중 다음 빈 position — 대표(0)를 바닥으로 삼으므로 첫 관련
/// 날짜는 항상 1부터 시작한다. date_add/가져오기 경로가 공유하는 유일한 채번 지점.
pub(crate) fn next_position(tx: &rusqlite::Transaction, note_id: &str) -> AppResult<i64> {
    tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM note_dates WHERE note_id=?1",
        [note_id],
        |r| r.get(0),
    )
    .map_err(dberr)
}

/// note_date_add/note_date_update 공용 검증 — 정밀도 사다리(§1.1: month 1..12, day 1..31,
/// day⇒month) + 기간 트리플(end_day⇒end_month⇒end_year, start<=end) + 시각/알림/반복 교차
/// 불변식(I1~I5, 옛 repo::notes::set_schedule 관문과 동일 문구). **새 검증 함수를 만들지 않는다**
/// (§②) — 기존 super::validate_month_day/validate_end_triple/assert_start_not_after_end,
/// repo::schedule::parse_hhmm_min, repo::schedule::rrule::parse_for_seed 를 그대로 호출만 한다.
/// 대표(position 0)든 관련 날짜든 이 한 함수를 지난다 — 능력 차이를 만들지 않는다는 원칙(§1.1)의
/// 코드 형태.
///
/// PLAN-2026-09-13-separation-of-concerns.md D4: 날짜 축(`validate_date_triple`)과 시각 축
/// (`validate_schedule_fields`)으로 갈라 두 함수의 합성으로 남겼다 — 시각 축은
/// `repo::notes::set_schedule` 이 같은 문장을 그대로 다시 구현하고 있던 것을 지우기 위해서다.
/// 거기서 **날짜 축까지** 부르면 손상된 기존 데이터(역전된 기간 등)에서만 새 오류가 나므로
/// 동작 변경이 된다 — 그래서 둘로 나뉘어 있어야 한다.
#[allow(clippy::too_many_arguments)]
fn validate_row(
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: &Option<String>,
    end_time: &Option<String>,
    remind_offset_min: Option<i64>,
    rrule: &Option<String>,
) -> AppResult<()> {
    validate_date_triple(year, month, day, end_year, end_month, end_day)?;
    validate_schedule_fields(
        year,
        month,
        day,
        end_year,
        end_month,
        end_day,
        start_time,
        end_time,
        remind_offset_min,
        rrule,
    )
}

/// 날짜 축만 — 연 범위 + 정밀도 사다리 + 기간 트리플 + 시작<=종료.
fn validate_date_triple(
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
) -> AppResult<()> {
    if !(super::YEAR_MIN..=super::YEAR_MAX).contains(&year) {
        return Err(AppError::Validation(format!("year out of range: {year}")));
    }
    super::validate_month_day(month, day)?;
    super::validate_end_triple(end_year, end_month, end_day)?;
    if end_year.is_some() {
        super::assert_start_not_after_end(year, month, day, end_year, end_month, end_day)?;
    }
    Ok(())
}

/// 시각·알림 오프셋·반복의 교차 불변식(I1~I5)만 — 날짜 삼중(`validate_date_triple`)은 보지
/// 않는다. `date_add`/`date_update`(validate_row 경유)와 `repo::notes::set_schedule` 이 공유하는
/// 단일 지점이다. `year`/`month`/`day`/`end_*` 는 검증 대상이 아니라 **문맥**이다 — I1/I4 의 풀
/// 정밀도 판정, I3 의 "같은 날" 판정, I5 의 seed 에 쓰인다.
///
/// 시각 형식(docs/PLAN-schedule-system.md §1.2): DB CHECK(GLOB)는 자릿수 모양만 거른다
/// ("24:00"~"29:59"도 통과) — 실제 시(0..23)/분(0..59) 범위 검증은
/// `repo::schedule::parse_hhmm_min` 이 하고, W5-3 이 틱/설정 검증에서 같은 파싱을 필요로 하면서
/// 그쪽을 단일 지점으로 삼았다. 빈 문자열은 여기 들어오지 않는다(호출부가 normalize_blank /
/// Option 정규화로 먼저 None 처리).
#[allow(clippy::too_many_arguments)]
pub(super) fn validate_schedule_fields(
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: &Option<String>,
    end_time: &Option<String>,
    remind_offset_min: Option<i64>,
    rrule: &Option<String>,
) -> AppResult<()> {
    if let Some(t) = start_time {
        if crate::repo::schedule::parse_hhmm_min(t).is_none() {
            return Err(AppError::Validation(format!(
                "invalid time format (HH:MM 00:00..23:59): {t}"
            )));
        }
    }
    if let Some(t) = end_time {
        if crate::repo::schedule::parse_hhmm_min(t).is_none() {
            return Err(AppError::Validation(format!(
                "invalid time format (HH:MM 00:00..23:59): {t}"
            )));
        }
    }
    if let Some(offset) = remind_offset_min {
        if !(0..=40320).contains(&offset) {
            return Err(AppError::Validation(format!(
                "remind_offset_min out of range (0..40320): {offset}"
            )));
        }
    }
    // I1: start_time ⇒ 시작일 연월일 풀 정밀도.
    if start_time.is_some() && (month.is_none() || day.is_none()) {
        return Err(AppError::Validation("time requires day precision".to_string()));
    }
    // I2: end_time ⇒ start_time.
    if end_time.is_some() && start_time.is_none() {
        return Err(AppError::Validation("end_time requires start_time".to_string()));
    }
    // I3: 시작일==종료일(또는 end_* 없음)일 때만 start_time<=end_time — 다일 이벤트는 예외.
    if let (Some(s), Some(e)) = (start_time, end_time) {
        let same_day = end_year.is_none()
            || (end_year == Some(year) && end_month == month && end_day == day);
        if same_day && s.as_str() > e.as_str() {
            return Err(AppError::Validation(
                "end_time must not be before start_time".to_string(),
            ));
        }
    }
    // I4: rrule ⇒ 시작일 연월일 풀 정밀도(반복의 seed 가 필요).
    if rrule.is_some() && (month.is_none() || day.is_none()) {
        return Err(AppError::Validation("rrule requires day precision".to_string()));
    }
    // I5: rrule 문법·seed 규칙 검증 — 관문은 파서 하나뿐.
    if let Some(r) = rrule {
        let seed = NaiveYmd {
            y: year,
            m: month.unwrap() as u32,
            d: day.unwrap() as u32,
        };
        crate::repo::schedule::rrule::parse_for_seed(r, seed)?;
    }
    Ok(())
}

/// D3 폐지(V85, PLAN-2026-09-18-nl-dates.md): 관련 날짜끼리 (year,month,day) 트리플이 겹치면
/// VALIDATION 이던 `duplicate_related_date` 관문과 그 두 호출부(date_add/date_update)를 완전히
/// 삭제했다 — 여행 일정에서 "체크인 10:00 경복궁 / 체크아웃 14:00 경복궁"처럼 같은 날 행이 둘 이상
/// 필요한 게 정상 용도라 이 규칙이 핵심 용도를 막았다. 라벨·시각·rrule까지 섞은 좁은 키(예:
/// (date,start_time,label))도 검토했으나 이름 없는 종일 행 둘이 겹치는 경우를 여전히 막지 못해
/// 보호 가치가 거의 없었다 — 그래서 불변식 자체를 없앴다. 대표(position=0)는 원래도 비교 대상이
/// 아니었으니, 이제 "행끼리 유일해야 한다"는 규칙이 완전히 사라졌다(옛 fmt_ymd 에러 포맷 헬퍼도
/// 이 두 호출부만 썼으므로 함께 삭제).
///
/// docs/SYNC.md §8.1과 동일 우회: note_dates 자체엔 updated_at 이 없으므로(신규 테이블, G1
/// 미확장) 추가 사실을 LWW 가 보게 하는 유일한 수단은 소속 노트의 updated_at 을 같이 올리는
/// 것 — project_primary 가 그걸 겸한다. 그래서 `&Connection` 대신 트랜잭션이 필요하다.
///
/// position 채번: 새 행은 항상 이 노트의 관련 날짜 맨 뒤(next_position)에 붙는다. position=0
/// (대표)는 절대 건드리지 않는다(D4 그대로).
///
/// PLAN-2026-09-08-dates-rebuild.md W3: 정밀도 사다리 전체(연 필수, 월/일/기간/시각/알림/반복
/// 전부 선택)를 받는다 — 옛 "YYYY-MM-DD" 문자열 전용 시그니처는 사라졌다. 검증은 `validate_row`
/// 하나(§ 위 주석) — 달력상 실재 여부(2월 30일 등)는 보지 않는다(대표 축과 동일 자세).
#[allow(clippy::too_many_arguments)]
pub fn date_add(
    conn: &mut Connection,
    note_id: &str,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: Option<String>,
    end_time: Option<String>,
    remind: bool,
    remind_offset_min: Option<i64>,
    rrule: Option<String>,
    // D1 부활(V85): 맨 끝에 붙여 기존 호출부는 전부 `, None`만 덧붙이면 된다. date_add 는 항상
    // position != 0 행을 만드므로(D2, 대표는 insert_primary_row 전용 경로) label 을 그대로 받는다
    // — position=0 특례가 필요 없다(date_update 와 다른 점).
    label: Option<String>,
) -> AppResult<String> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    let start_time = super::normalize_blank(start_time);
    let end_time = super::normalize_blank(end_time);
    let rrule = super::normalize_blank(rrule);
    let label = super::normalize_blank(label);
    validate_row(
        year, month, day, end_year, end_month, end_day, &start_time, &end_time,
        remind_offset_min, &rrule,
    )?;
    // D3 폐지(V85): 관련 날짜끼리 (year,month,day) 중복 검사는 더 이상 하지 않는다(위 doc 참조).
    let id = new_id();
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    let position = next_position(&tx, note_id)?;
    tx.execute(
        "INSERT INTO note_dates(id, note_id, position, year, month, day, end_year, end_month, end_day, start_time, end_time, remind, remind_offset_min, rrule, created_at, label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id, note_id, position, year, month, day, end_year, end_month, end_day,
            start_time, end_time, remind, remind_offset_min, rrule, now, label,
        ],
    )
    .map_err(dberr)?;
    project_primary(&tx, note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(id)
}

/// 삭제는 tombstone 을 남긴다 — note_dates 는 note_regions 와 동일하게 INSERT+DELETE 전용
/// 테이블이라, 삭제 사실을 다른 기기로 전파할 유일한 수단이 deleted_rows 다. position=0(대표)은
/// 지울 수 없다 — 축은 notes.year 처럼 NOT NULL 이고, "초기화"는 정밀도를 연도로 되돌리는 것이지
/// 행 삭제가 아니다(§1.1). 반환값은 소속 note_id — 커맨드 계층이 그 노트만 콕 집어 갱신 이벤트를
/// 낼 수 있게 한다.
pub fn date_remove(conn: &mut Connection, id: &str) -> AppResult<Option<String>> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT note_id, position FROM note_dates WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?;
    let Some((note_id, position)) = row else { return Ok(None) };
    if position == 0 {
        return Err(AppError::Validation(
            "cannot remove the representative date (position 0); change its precision instead".to_string(),
        ));
    }
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("DELETE FROM note_dates WHERE id = ?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "note_dates", id)?;
    project_primary(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(Some(note_id))
}

// D1 부활(V85): label을 맨 끝에 붙인다 — 기존 열넷의 순서/의미를 하나도 건드리지 않는다.
const NOTE_DATE_COLUMNS: &str =
    "id, note_id, position, year, month, day, end_year, end_month, end_day, remind, created_at, start_time, end_time, remind_offset_min, rrule, label";

fn row_to_note_date(row: &rusqlite::Row) -> rusqlite::Result<crate::models::NoteDate> {
    Ok(crate::models::NoteDate {
        id: row.get(0)?,
        note_id: row.get(1)?,
        position: row.get(2)?,
        year: row.get(3)?,
        month: row.get(4)?,
        day: row.get(5)?,
        end_year: row.get(6)?,
        end_month: row.get(7)?,
        end_day: row.get(8)?,
        remind: row.get(9)?,
        created_at: row.get(10)?,
        start_time: row.get(11)?,
        end_time: row.get(12)?,
        remind_offset_min: row.get(13)?,
        rrule: row.get(14)?,
        label: row.get(15)?,
    })
}

/// 이 노트의 **모든** 날짜 행 — position ASC, 그래서 **첫 항목이 대표(position 0)** 다
/// (PLAN-2026-09-08-dates-rebuild.md §2 "목록이 있고 첫 항목이 대표"). 나머지는 date_add 가 항상
/// 맨 뒤에 append 하므로 추가한 순서 그대로다.
///
/// W4b: W3 은 대표를 일부러 뺐다("note_get 이 notes.* 투영으로 이미 노출하므로 두 번 싣지 않는다").
/// 그 판단이 **프런트에서 대표 행을 id 로 지목할 길을 없앴고**, W4 는 그걸 우회하려 "새 행 추가 →
/// 0번으로 승격 → 목록 차집합으로 강등된 옛 대표를 찾아 삭제"라는 IPC 7회짜리 컴포지트를 만들어야
/// 했다. 그 우회로는 대표 행의 id 를 편집할 때마다 바꾸고, 중간에 죽으면 강등된 행을 유령으로
/// 남기며, 무엇보다 **이미 관련 날짜로 있는 날로 대표를 옮기면 중복 검사에 걸려 실패**했다.
/// 한 줄(`AND position != 0`)을 빼면 그 전부가 `note_date_update` 한 번으로 돌아온다.
///
/// W3: `date`/`end_date` 파생 문자열을 제거했다(W1 이 ponytail 로 남겼던 것) — 프런트가 트리플을
/// 직접 받는다.
pub fn dates_list(conn: &Connection, note_id: &str) -> AppResult<Vec<crate::models::NoteDate>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {NOTE_DATE_COLUMNS} FROM note_dates WHERE note_id = ?1 ORDER BY position ASC"
        ))
        .map_err(dberr)?;
    let dates = stmt
        .query_map([note_id], row_to_note_date)
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(dates)
}

/// 행 하나 조회 — `date_update` 가 저장 직후 그 행을 그대로 돌려주는 데 쓴다(position 무관, 대표도
/// 포함). 없으면 NOT_FOUND(값을 다루는 조회라 region_move 와 동일 자세, date_remove 의
/// "missing=Ok(None)" 과는 다르다 — 저건 삭제라 멱등이 자연스럽다).
pub fn date_get(conn: &Connection, id: &str) -> AppResult<crate::models::NoteDate> {
    conn.query_row(
        &format!("SELECT {NOTE_DATE_COLUMNS} FROM note_dates WHERE id=?1"),
        [id],
        row_to_note_date,
    )
    .optional()
    .map_err(dberr)?
    .ok_or_else(|| AppError::NotFound(format!("note date not found: {id}")))
}

/// D3 철회(2026-09-07 D10): 관련 날짜의 알림 토글. 완료 수단이 이 토글을 다시 끄는 것이므로
/// (오너 확인, notes.yaml::note_date_set_remind) 별도 상태 컬럼을 두지 않는다. `id` 가 어느
/// position 이든(이론상 0도) project_primary 가 그 결과를 notes.* 로 되비춘다 — 프런트는
/// dates_list(position != 0)만 id 로 쓰므로 실제로는 항상 관련 날짜다. 스펙대로 id 가 없으면
/// NOT_FOUND(region_move 와 동일 자세 — date_remove 의 "missing=Ok(None)" 과는 다르다, 저건 삭제라
/// 멱등이 자연스럽지만 이건 값 변경이라 대상이 없으면 오류다).
pub fn set_remind(conn: &mut Connection, id: &str, remind: bool) -> AppResult<String> {
    let note_id: Option<String> = conn
        .query_row("SELECT note_id FROM note_dates WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(dberr)?;
    let note_id = note_id.ok_or_else(|| AppError::NotFound(format!("note date not found: {id}")))?;
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "UPDATE note_dates SET remind=?1 WHERE id=?2",
        params![remind, id],
    )
    .map_err(dberr)?;
    project_primary(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(note_id)
}

/// PLAN-2026-09-07-reminder-2tier.md §3(V75)/notes.yaml::note_date_set_schedule: 관련 날짜의
/// 시각·알림 오프셋(+remind 플래그)을 한 번에 저장 — "이 행의 일정 전부"를 넣는 모달 저장용.
/// `set_remind` (1클릭 토글, 플래그만)와는 의미가 다르다: 확장하지 않고 옆에 둔 이유는
/// notes.yaml 참조. 검증 관문은 repo::schedule::parse_hhmm_min 재사용(새 파서를 만들지 않는다) —
/// remind_offset_min 상한(0..40320)은 대표 날짜의 repo::notes::set_schedule 과 동일 범위.
pub fn date_set_schedule(
    conn: &mut Connection,
    id: &str,
    remind: bool,
    start_time: Option<String>,
    remind_offset_min: Option<i64>,
) -> AppResult<String> {
    let note_id: Option<String> = conn
        .query_row("SELECT note_id FROM note_dates WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(dberr)?;
    let note_id = note_id.ok_or_else(|| AppError::NotFound(format!("note date not found: {id}")))?;

    if let Some(ref t) = start_time {
        if crate::repo::schedule::parse_hhmm_min(t).is_none() {
            return Err(AppError::Validation(format!(
                "invalid time format (HH:MM 00:00..23:59): {t}"
            )));
        }
    }
    if let Some(offset) = remind_offset_min {
        if !(0..=40320).contains(&offset) {
            return Err(AppError::Validation(format!(
                "remind_offset_min out of range (0..40320): {offset}"
            )));
        }
    }

    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "UPDATE note_dates SET remind=?1, start_time=?2, remind_offset_min=?3 WHERE id=?4",
        params![remind, start_time, remind_offset_min, id],
    )
    .map_err(dberr)?;
    project_primary(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(note_id)
}

/// notes.yaml::note_date_update — **행 하나의 모든 것을 한 번에** 고친다(정밀도·기간·시각·알림·
/// 반복). 옛 note_date_set_remind/note_date_set_schedule/note_set_schedule/note_set_event_precision/
/// note_set_event_end 다섯 커맨드가 하던 일을 이 한 커맨드가 흡수한다(§ W3 보고서).
///
/// **부분 갱신이 아니라 전량 교체다** — 호출자가 매번 이 행의 열두 필드(year는 필수, 나머지는
/// `Option`)를 전부 보낸다. `note_set_schedule`("네 필드 모두 매번 전달, null=해제")과 같은 관례를
/// 그대로 확장한 것 — "생략=미변경"과 "명시 null=해제"를 같은 타입(`Option<T>`)으로는 구분할 수
/// 없다(이 코드베이스의 dispatch 코드젠은 `"T?"`와 `"T|null"`을 둘 다 `Option<T>`로 접어버린다,
/// scripts/gen-commands.mjs::parseRustField). 이 행이 정밀도·기간·시각·알림·반복을 한 트랜잭션
/// 안에서 교차 검증해야 하는 값 뭉치라(I1~I5), 일부만 부분 갱신하면 "새 month는 왔는데 옛
/// start_time과 조합하면 invariant 위반" 같은 중간 상태가 생긴다 — 전량 교체는 그 조합을
/// 원천적으로 없앤다. 프런트는 폼을 열 때 `date_get`/`dates_list`로 현재 값을 채우고, 저장 시
/// 전체를 다시 보낸다.
///
/// 대표(position 0)든 관련 날짜든 이 한 함수로 고친다 — 능력 차이가 없다(§1.1), **단 label 은
/// 예외다(D2)**: 대표는 라벨을 받지 않으므로 position=0 행에 대해서는 들어온 `label` 을 무시하고
/// 항상 NULL 로 쓴다(표시 규칙 `label ?? 노트 제목`이 대표에도 라벨을 태우면 뜻이 어긋난다) —
/// 프런트가 폼에서부터 필드를 숨기는 것과 별개로, repo 계층에서도 이 불변식을 강제한다. 검증은
/// `validate_row`(§ 위 주석) 하나. D3 폐지(V85): (year,month,day) 중복 검사는 더 이상 하지 않는다
/// (위 doc 참조). 저장 후 이 행을 `date_get`으로 다시 읽어 돌려준다(프런트가 왕복 없이 바로
/// 반영할 수 있게).
#[allow(clippy::too_many_arguments)]
pub fn date_update(
    conn: &mut Connection,
    id: &str,
    year: i64,
    month: Option<i64>,
    day: Option<i64>,
    end_year: Option<i64>,
    end_month: Option<i64>,
    end_day: Option<i64>,
    start_time: Option<String>,
    end_time: Option<String>,
    remind: bool,
    remind_offset_min: Option<i64>,
    rrule: Option<String>,
    // D1 부활(V85) — 맨 끝에 붙인다(date_add 와 같은 이유). position=0 이면 아래에서 무시된다(D2).
    label: Option<String>,
) -> AppResult<crate::models::NoteDate> {
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT note_id, position FROM note_dates WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?;
    let Some((note_id, position)) = row else {
        return Err(AppError::NotFound(format!("note date not found: {id}")));
    };

    let start_time = super::normalize_blank(start_time);
    let end_time = super::normalize_blank(end_time);
    let rrule = super::normalize_blank(rrule);
    // D2: 대표(position 0)는 라벨을 받지 않는다 — 무엇이 들어오든 NULL로 고정한다.
    let label = if position == 0 { None } else { super::normalize_blank(label) };
    validate_row(
        year, month, day, end_year, end_month, end_day, &start_time, &end_time,
        remind_offset_min, &rrule,
    )?;
    // D3 폐지(V85): 관련 날짜끼리 (year,month,day) 중복 검사는 더 이상 하지 않는다(위 doc 참조).

    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "UPDATE note_dates SET year=?1, month=?2, day=?3, end_year=?4, end_month=?5, end_day=?6, start_time=?7, end_time=?8, remind=?9, remind_offset_min=?10, rrule=?11, label=?12 WHERE id=?13",
        params![
            year, month, day, end_year, end_month, end_day, start_time, end_time, remind,
            remind_offset_min, rrule, label, id,
        ],
    )
    .map_err(dberr)?;
    project_primary(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    date_get(conn, id)
}

/// notes.yaml::note_date_reorder — 관련 날짜(position != 0)의 순서를 바꾼다. note_region_reorder
/// 와 동일 계약(ordered_ids 가 대상 집합과 정확히 일치해야 함)이되, **대표(position=0)는 대상에서
/// 제외된다** — position 을 1..n 으로 다시 쓴다(0 은 항상 대표 예약).
///
/// 대표를 바꾸는 것은 `date_make_primary`의 몫이지 이 커맨드의 특수한 경우가 아니다: 승격은
/// "정밀도 부족 시 거부" 같은 자신만의 검증을 갖는 순수 2행 스왑이고, reorder 는 검증 없는 n행
/// 재배치다. reorder 가 position=0 자리를 쓸 수 있게 허용하면 그 검증을 우회하는 두 번째 길이
/// 열린다 — 그래서 범위를 아예 겹치지 않게 나눴다.
pub fn date_reorder(conn: &mut Connection, note_id: &str, ordered_ids: &[String]) -> AppResult<bool> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    let current: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM note_dates WHERE note_id=?1 AND position != 0")
            .map_err(dberr)?;
        let rows: Vec<String> = stmt
            .query_map([note_id], |r| r.get::<_, String>(0))
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        rows
    };
    let mut a = current.clone();
    a.sort();
    let mut b = ordered_ids.to_vec();
    b.sort();
    if a != b {
        return Err(AppError::Validation(
            "ordered_ids does not match this note's related dates".to_string(),
        ));
    }
    let tx = conn.transaction().map_err(dberr)?;
    for (i, rid) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE note_dates SET position=?1 WHERE id=?2 AND note_id=?3",
            params![i as i64 + 1, rid, note_id],
        )
        .map_err(dberr)?;
    }
    tx.execute(
        "UPDATE notes SET updated_at=?1 WHERE id=?2",
        params![now_iso(), note_id],
    )
    .map_err(dberr)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

/// notes.yaml::note_date_make_primary — note_region 의 "대표로"와 같은 역할: 목록의 대표를 이
/// 행으로 교체한다. 대표는 자동으로 바뀌지 않는다(가장 이른 날짜를 자동 승격하면 note_dates 를
/// 하나 넣는 것만으로 사건 축(연대 필터·타임라인·그래프가 보는 그 축)이 조용히 바뀐다) — 그래서
/// 명시적 행동으로만 바뀐다.
///
/// PLAN-2026-09-08-dates-rebuild.md W1: 모든 행이 이제 같은 컬럼을 갖는다 — 승격은 **position
/// 교환**일 뿐이다(옮길 값이 없고 따라서 흘릴 값도 없다). 옛 4단계(내리기/올리기/삭제/remind
/// 이관)로 하던 시각·오프셋 수동 이관은 삭제됐다: 행 자신의 데이터는 스왑 중에 손대지 않으므로
/// start_time/remind_offset_min/end_time/rrule 은 그 행이 원래 갖고 있던 값 그대로 어느
/// position에 있든 따라간다(왕복 테스트로 고정,
/// make_primary_demotes_old_primarys_time_into_note_dates_row_and_roundtrips).
///
/// W2(§4): W1이 남긴 "rrule 만은 슬롯을 따라간다" 특례는 사라졌다 — 반복은 이제 행의 속성이고
/// 승격은 순수 position 교환이므로 rrule 을 옮길 이유가 없다(make_primary_moves_rrule_with_the_row_not_the_slot
/// 가 새 동작을 고정한다).
///
/// W3: "지금 대표가 연도만 있으면(정밀도 부족) 내릴 수 없다"는 옛 게이트를 없앴다 — 그 규칙은
/// "note_dates 가 풀 정밀도만 담을 수 있던" 시절의 유물이었고(W1 당시 겉 동작 보존 목적으로
/// 유지), 이제 관련 날짜도 임의 정밀도를 담을 수 있으므로(§1.1) 연도만 있는 행도 자유롭게
/// 대표/관련 사이를 오갈 수 있다(make_primary_allows_a_year_only_row_on_either_side 가 새 동작을
/// 고정한다). 대상 행의 트리플은 여전히 방어적으로 재검증한다(손상 가능성 — 수동 DB 편집 등) —
/// 기존 불변식 재사용(validate_month_day/validate_end_triple/assert_start_not_after_end,
/// repo::notes::mod). 이 검사는 트랜잭션을 열기 전에 끝나므로 실패 시 DB 에 쓰기는 단 한 줄도
/// 일어나지 않는다.
///
/// 2026-09-19 정정 — 위 "옮길 값이 없고 따라서 흘릴 값도 없다"는 label(D1 부활, V85 — 이 함수가
/// 쓰인 뒤 추가된 컬럼)에는 안 맞았다: label 있는 관련 행이 승격되면 position=0이 되고도 label을
/// 그대로 들고 있어 date_update가 지키는 "대표는 label 없음"(D2) 불변식을 깼다(UI가 대표 행엔
/// label 편집 진입점을 안 보여주므로 사용자가 지울 방법도 없었다 — PLAN-2026-09-19-date-region-ui.md
/// §P1 구현·검증 중 발견). label만은 승격 시 명시적으로 비운다 — position/시각/오프셋/rrule은
/// 여전히 순수 스왑.
pub fn date_make_primary(conn: &mut Connection, id: &str) -> AppResult<String> {
    #[allow(clippy::type_complexity)]
    let target: Option<(String, i64, i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT note_id, position, year, month, day, end_year, end_month, end_day FROM note_dates WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .optional()
        .map_err(dberr)?;
    let Some((note_id, target_position, t_year, t_month, t_day, t_end_year, t_end_month, t_end_day)) = target else {
        return Err(AppError::NotFound(format!("note date not found: {id}")));
    };
    if target_position == 0 {
        // 이미 대표다 — UI 는 dates_list(position != 0)의 id 만 넘기므로 실제로는 일어나지 않는다.
        // 방어적 no-op(대표를 자기 자신으로 "승격"하는 것은 아무 일도 아니다).
        return Ok(note_id);
    }

    let old_primary_id: String = conn
        .query_row(
            "SELECT id FROM note_dates WHERE note_id=?1 AND position=0",
            [&note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;

    // 방어선: 대상 행의 트리플이 손상돼도 승격 시 다시 검증한다 — date_add 가 이미 통과시킨
    // 값이라 사실상 항상 통과한다.
    super::validate_month_day(t_month, t_day)?;
    if let Some(ey) = t_end_year {
        super::validate_end_triple(Some(ey), t_end_month, t_end_day)?;
        super::assert_start_not_after_end(t_year, t_month, t_day, Some(ey), t_end_month, t_end_day)?;
    }

    let tx = conn.transaction().map_err(dberr)?;
    // position 교환 — UNIQUE 제약이 없으므로(파일 상단 주석) sentinel 없이 두 UPDATE 로 충분하다.
    tx.execute(
        "UPDATE note_dates SET position=?1 WHERE id=?2",
        params![target_position, old_primary_id],
    )
    .map_err(dberr)?;
    tx.execute("UPDATE note_dates SET position=0 WHERE id=?1", [id])
        .map_err(dberr)?;
    // W2(§4): rrule 은 더 이상 슬롯을 따라가지 않는다 — 순수 스왑이라 각 행이 원래 갖고 있던
    // rrule 을 그대로 간직한다(start_time/remind_offset_min/end_time 과 동일한 자세).
    //
    // 2026-09-19 버그 수정 — label만은 예외(D2, date_update 의 같은 문구 참고: "대표는 라벨을
    // 받지 않는다"). 순수 스왑이라면 label 있는 관련 행이 승격된 뒤에도 label을 그대로 들고
    // position=0이 되어 그 불변식을 깬다 — UI가 대표 행엔 label 편집 진입점 자체를 안 보여주므로
    // (D2 전제) 한번 이렇게 되면 사용자가 지울 방법도 없었다. 옛 대표는 원래도 label이 항상
    // None(D2가 이미 보장)이므로 내려가는 쪽은 손댈 게 없다 — 올라가는 쪽만 비운다.
    tx.execute("UPDATE note_dates SET label=NULL WHERE id=?1", [id])
        .map_err(dberr)?;
    project_primary(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(note_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes::{create, note_summary};

    /// W4b: `dates_list` 는 이제 대표(position 0)를 **첫 항목으로 포함**한다(§2 "첫 항목이 대표").
    /// 아래 테스트 대부분은 "관련 날짜만"을 기대하고 쓰인 것이라 그 의도를 이 헬퍼로 유지한다 —
    /// 대표 포함 여부 자체를 고정하는 테스트(dates_list_puts_the_primary_row_first)는 원본을 쓴다.
    fn related_only(conn: &Connection, note_id: &str) -> Vec<crate::models::NoteDate> {
        dates_list(conn, note_id)
            .unwrap()
            .into_iter()
            .filter(|d| d.position != 0)
            .collect()
    }

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    /// §7-1 투영 불변성의 유일한 확인 지점 — notes.* 는 항상 position=0 note_dates 행과 일치해야
    /// 한다. project_primary 를 우회하는 쓰기가 하나라도 남아있으면 이 헬퍼가 잡는다. 아래
    /// `projection_stays_in_sync_across_every_mutation` 테스트가 모든 mutation 뒤에 이걸 부른다.
    fn assert_projection_matches(conn: &Connection, note_id: &str) {
        let n = note_summary(conn, note_id).unwrap();
        #[allow(clippy::type_complexity)]
        let row: (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, bool, Option<String>, Option<String>, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT year, month, day, end_year, end_month, end_day, remind, start_time, end_time, remind_offset_min, rrule
                 FROM note_dates WHERE note_id=?1 AND position=0",
                [note_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
            )
            .unwrap();
        assert_eq!(n.year, row.0, "year drift for {note_id}");
        assert_eq!(n.month, row.1, "month drift for {note_id}");
        assert_eq!(n.day, row.2, "day drift for {note_id}");
        assert_eq!(n.end_year, row.3, "end_year drift for {note_id}");
        assert_eq!(n.end_month, row.4, "end_month drift for {note_id}");
        assert_eq!(n.end_day, row.5, "end_day drift for {note_id}");
        assert_eq!(n.remind, row.6, "remind drift for {note_id}");
        assert_eq!(n.start_time, row.7, "start_time drift for {note_id}");
        assert_eq!(n.end_time, row.8, "end_time drift for {note_id}");
        assert_eq!(n.remind_offset_min, row.9, "remind_offset_min drift for {note_id}");
        assert_eq!(n.rrule, row.10, "rrule drift for {note_id}");
    }

    /// §7-1: 행을 추가/삭제/수정/재배치/승격한 뒤 notes.* 가 **항상** position=0 행과 일치하는지,
    /// 대표 슬롯을 바꾸는 경로 전부(dates.rs 의 date_add/date_remove/set_remind/date_set_schedule/
    /// date_update/date_reorder/date_make_primary, notes::mod 의
    /// set_event_precision/set_event_end/set_schedule/update)를 한 번씩 지나며 고정한다.
    #[test]
    fn projection_stays_in_sync_across_every_mutation() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = crate::repo::notes::create(&mut conn, &folder_id, Some("Invariant".into()), Some(2026)).unwrap();
        let id = n.note.id.clone();
        assert_projection_matches(&conn, &id);

        // year 만 먼저 바꾼다(아직 end_* 가 없으니 역전 검증에 안 걸린다).
        crate::repo::notes::update(&mut conn, &id, None, Some(2027), None, None).unwrap();
        assert_projection_matches(&conn, &id);

        crate::repo::notes::set_event_precision(&mut conn, &id, Some(3), Some(10)).unwrap();
        assert_projection_matches(&conn, &id);

        crate::repo::notes::set_event_end(&mut conn, &id, Some(2027), Some(3), Some(12)).unwrap();
        assert_projection_matches(&conn, &id);

        crate::repo::notes::set_schedule(&mut conn, &id, Some("09:00".into()), Some("10:00".into()), Some(15), Some("FREQ=WEEKLY;BYDAY=MO".into())).unwrap();
        assert_projection_matches(&conn, &id);

        crate::repo::notes::update(&mut conn, &id, None, None, None, Some(true)).unwrap();
        assert_projection_matches(&conn, &id);

        let extra_id = date_add(&mut conn, &id, 2027, Some(5), Some(1), Some(2027), Some(5), Some(3), None, None, false, None, None, None).unwrap();
        assert_projection_matches(&conn, &id);

        date_set_schedule(&mut conn, &extra_id, true, Some("14:00".into()), Some(30)).unwrap();
        assert_projection_matches(&conn, &id);

        set_remind(&mut conn, &extra_id, false).unwrap();
        assert_projection_matches(&conn, &id);

        // W3: date_update 는 행 하나를 전량 교체한다 — 대표(id, position 0)에 대해서도 지나간다.
        let primary_id: String = conn
            .query_row("SELECT id FROM note_dates WHERE note_id=?1 AND position=0", [&id], |r| r.get(0))
            .unwrap();
        date_update(&mut conn, &primary_id, 2027, Some(3), Some(12), None, None, None, None, None, false, None, None, None).unwrap();
        assert_projection_matches(&conn, &id);

        // W3: date_reorder 는 position=0 을 건드리지 않는다 — 관련 날짜가 하나뿐이라 no-op 재배치.
        date_reorder(&mut conn, &id, &[extra_id.clone()]).unwrap();
        assert_projection_matches(&conn, &id);

        date_make_primary(&mut conn, &extra_id).unwrap();
        assert_projection_matches(&conn, &id);

        // 승격 뒤 남은 옛 대표(이제 관련 날짜)를 다시 지운다 — position=0 은 여전히 새 대표라
        // 삭제가 허용된다.
        let remaining = related_only(&conn, &id);
        assert_eq!(remaining.len(), 1);
        date_remove(&mut conn, &remaining[0].id).unwrap();
        assert_projection_matches(&conn, &id);
    }

    /// W3: date_add 는 이제 정밀도 사다리(연 필수, 나머지 선택)를 받는다 — 옛 "YYYY-MM-DD" 문자열
    /// 형식 검증은 사라지고 range/ladder 검증(validate_row, mod.rs 의 기존 관문)으로 대체됐다.
    /// 달력상 실재 여부(2월 30일 등)는 이제 보지 않는다(대표 축과 동일 자세 — mod.rs::
    /// validate_month_day 주석 참조, 의도된 완화).
    ///
    /// D3 폐지(V85): 이 테스트의 이름이 한때 "duplicates"를 검증했지만, 이제는 정반대(같은
    /// (year,month,day) 트리플을 가진 행을 두 개 이상 허용)를 고정한다 — 여행 일정의 "체크인/
    /// 체크아웃 같은 날" 같은 핵심 용도가 옛 중복 금지 규칙에 막혔기 때문(위 dates.rs 헤더 주석,
    /// duplicate_related_date 삭제 지점 참조).
    #[test]
    fn date_add_validates_the_precision_ladder_and_allows_duplicates_then_lists_by_insertion_order() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Launch".into()), Some(2026)).unwrap();

        // NOT_FOUND: no such note.
        let err = date_add(&mut conn, "does-not-exist", 2026, Some(11), Some(5), None, None, None, None, None, false, None, None, None).unwrap_err();
        match err {
            AppError::NotFound(_) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }

        // VALIDATION: day without month, and out-of-range month (2026-02-30 은 이제 range 검증만
        // 통과하면 허용된다 — 달력 실재 여부는 보지 않는다, 위 doc 참조).
        let err = date_add(&mut conn, &n.note.id, 2026, None, Some(5), None, None, None, None, None, false, None, None, None).unwrap_err();
        match err {
            AppError::Validation(_) => {}
            other => panic!("expected Validation (day without month), got {other:?}"),
        }
        let err = date_add(&mut conn, &n.note.id, 2026, Some(13), Some(1), None, None, None, None, None, false, None, None, None).unwrap_err();
        match err {
            AppError::Validation(_) => {}
            other => panic!("expected Validation (month out of range), got {other:?}"),
        }
        // 2026-02-30 은 달력상 없는 날이지만 range 검증만 지나므로 이제 허용된다(의도된 완화).
        let leap_free = date_add(&mut conn, &n.note.id, 2026, Some(2), Some(30), None, None, None, None, None, false, None, None, None).unwrap();
        date_remove(&mut conn, &leap_free).unwrap();

        let id1 = date_add(&mut conn, &n.note.id, 2026, Some(11), Some(5), None, None, None, None, None, false, None, None, None).unwrap();
        let id0 = date_add(&mut conn, &n.note.id, 2026, Some(9), Some(1), None, None, None, None, None, false, None, None, None).unwrap();

        // date_add must bump the owning note's updated_at (LWW visibility, same as region_add).
        let after_add = note_summary(&conn, &n.note.id).unwrap().updated_at;
        assert!(after_add >= n.note.updated_at);

        // D4: adding an extra date must not touch the note's own event axis.
        let after = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!((after.year, after.month, after.day), (2026, None, None));

        // D3 폐지(V85): 같은 (year,month,day) 트리플이라도 더 이상 거부되지 않는다 — 여행 일정의
        // "체크인/체크아웃 같은 날" 같은 용도가 핵심.
        let id_dup = date_add(&mut conn, &n.note.id, 2026, Some(11), Some(5), None, None, None, None, None, false, None, None, None).unwrap();
        // A different date on the same note was never a duplicate either.
        let id2 = date_add(&mut conn, &n.note.id, 2026, Some(12), Some(25), None, None, None, None, None, false, None, None, None).unwrap();

        // dates_list 는 position ASC 로 정렬한다 — date_add 는 항상 맨 뒤에 append 하므로 목록은
        // 추가한 순서와 같다(id1, id0, id_dup, id2 순으로 추가했다).
        let listed = related_only(&conn, &n.note.id);
        assert_eq!(
            listed.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            vec![id1.as_str(), id0.as_str(), id_dup.as_str(), id2.as_str()],
            "position ASC == insertion order (date_add always appends, duplicates included)"
        );
        assert_eq!(listed.iter().map(|d| d.position).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
    }

    /// D1 부활(V85)/D2: label 은 관련 날짜(position != 0)에는 왕복하고, 대표(position 0)에는
    /// 무엇을 보내든 항상 NULL 로 고정된다. 빈 문자열은 다른 문자열 필드와 동일하게
    /// normalize_blank 로 None 취급된다(§ date_add/date_update 위 doc 참조).
    #[test]
    fn label_roundtrips_on_related_rows_and_is_ignored_on_the_primary_row() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("여행".into()), Some(2026)).unwrap();

        // date_add: label 이 그대로 저장된다.
        let id_checkin = date_add(
            &mut conn, &n.note.id, 2026, Some(9), Some(19), None, None, None, None, None, false, None, None,
            Some("체크인".to_string()),
        )
        .unwrap();
        let listed = related_only(&conn, &n.note.id);
        let checkin = listed.iter().find(|d| d.id == id_checkin).unwrap();
        assert_eq!(checkin.label.as_deref(), Some("체크인"));

        // date_update: 관련 날짜의 label 을 바꿀 수 있다 — 빈 문자열은 None 으로 정규화된다.
        let updated = date_update(
            &mut conn, &id_checkin, 2026, Some(9), Some(19), None, None, None, None, None, false, None, None,
            Some("체크인(수정)".to_string()),
        )
        .unwrap();
        assert_eq!(updated.label.as_deref(), Some("체크인(수정)"));
        let cleared = date_update(
            &mut conn, &id_checkin, 2026, Some(9), Some(19), None, None, None, None, None, false, None, None,
            Some("".to_string()),
        )
        .unwrap();
        assert_eq!(cleared.label, None, "빈 문자열은 다른 필드처럼 None 으로 정규화된다");

        // D2: 대표(position 0)에 label 을 보내도 무시되고 항상 None 으로 저장된다.
        let primary_id: String = conn
            .query_row("SELECT id FROM note_dates WHERE note_id=?1 AND position=0", [&n.note.id], |r| r.get(0))
            .unwrap();
        let primary_after = date_update(
            &mut conn, &primary_id, 2026, Some(1), Some(1), None, None, None, None, None, false, None, None,
            Some("대표에겐 안 통함".to_string()),
        )
        .unwrap();
        assert_eq!(primary_after.label, None, "대표는 label 을 받지 않는다(D2)");
        let primary_label_in_db: Option<String> = conn
            .query_row("SELECT label FROM note_dates WHERE id=?1", [&primary_id], |r| r.get(0))
            .unwrap();
        assert_eq!(primary_label_in_db, None);
    }

    /// W4b — 이 목록의 **첫 항목이 대표(position 0)** 다. W3 은 대표를 일부러 뺐고("note_get 이
    /// notes.* 투영으로 이미 노출한다"), 그 판단이 프런트에서 대표 행을 **id 로 지목할 길을
    /// 없애** 대표 편집을 "새 행 추가 → 승격 → 옛 대표 삭제" 우회로로 만들었다. 그 우회로는
    /// 대표의 id 를 편집마다 바꾸고, 이미 관련 날짜로 있는 날로 대표를 옮기면 중복 검사에
    /// 걸려 실패했다. 이 테스트가 "목록은 대표를 포함한다"를 고정한다.
    #[test]
    fn dates_list_puts_the_primary_row_first() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("대표가 맨 위".into()), Some(2026)).unwrap();
        date_add(&mut conn, &n.note.id, 2026, Some(11), Some(5), None, None, None, None, None, false, None, None, None).unwrap();

        let listed = dates_list(&conn, &n.note.id).unwrap();
        assert_eq!(listed.len(), 2, "대표 + 관련 날짜 하나");
        assert_eq!(listed[0].position, 0, "첫 항목이 대표다");
        assert_eq!(listed[0].year, 2026);
        assert_eq!(listed[1].position, 1);

        // 대표 행의 id 로 곧장 고칠 수 있다 — 우회로가 필요 없다는 것이 이 웨이브의 요점.
        date_update(
            &mut conn, &listed[0].id, 2030, Some(3), Some(9), None, None, None, None, None, false, None, None,
            None,
        )
        .unwrap();
        let year: i64 = conn
            .query_row("SELECT year FROM notes WHERE id=?1", [&n.note.id], |r| r.get(0))
            .unwrap();
        assert_eq!(year, 2030, "투영도 따라온다");
    }

    /// W3: year-only/year+month-only 관련 날짜도 이제 허용된다(§1.1 정밀도 완화) — 옛 date_add 는
    /// 풀 정밀도만 받았다.
    #[test]
    fn date_add_accepts_coarser_precision_than_full_ymd() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Coarse".into()), Some(2026)).unwrap();

        let year_only = date_add(&mut conn, &n.note.id, 1990, None, None, None, None, None, None, None, false, None, None, None).unwrap();
        let year_month = date_add(&mut conn, &n.note.id, 1991, Some(6), None, None, None, None, None, None, false, None, None, None).unwrap();

        let listed = related_only(&conn, &n.note.id);
        let a = listed.iter().find(|d| d.id == year_only).unwrap();
        assert_eq!((a.year, a.month, a.day), (1990, None, None));
        let b = listed.iter().find(|d| d.id == year_month).unwrap();
        assert_eq!((b.year, b.month, b.day), (1991, Some(6), None));
    }

    #[test]
    fn date_remove_leaves_a_tombstone_bumps_the_owning_note_and_rejects_position_zero() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Launch".into()), Some(2026)).unwrap();
        let id = date_add(&mut conn, &n.note.id, 2026, Some(11), Some(5), None, None, None, None, None, false, None, None, None).unwrap();

        let before_remove = note_summary(&conn, &n.note.id).unwrap().updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let note_id = date_remove(&mut conn, &id).unwrap();
        assert_eq!(note_id.as_deref(), Some(n.note.id.as_str()));

        let after_remove = note_summary(&conn, &n.note.id).unwrap().updated_at;
        assert!(
            after_remove > before_remove,
            "date_remove must bump notes.updated_at so LWW sees the change"
        );
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_dates' AND id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1);
        assert!(related_only(&conn, &n.note.id).is_empty());

        // Missing id → Ok(None), not an error (mirrors region_remove's posture).
        assert_eq!(date_remove(&mut conn, "does-not-exist").unwrap(), None);

        // §1.1: position=0(대표)은 지울 수 없다.
        let primary_id: String = conn
            .query_row(
                "SELECT id FROM note_dates WHERE note_id=?1 AND position=0",
                [&n.note.id],
                |r| r.get(0),
            )
            .unwrap();
        let err = date_remove(&mut conn, &primary_id).unwrap_err();
        match err {
            AppError::Validation(_) => {}
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    /// 회귀 고정(GRILL-2026-09-07 D4): 추가 날짜는 타임라인/연대 필터 결과를 바꾸지 않는다.
    /// 노트 자신의 사건 축(1443년)과 전혀 다른 해(1998년)에 추가 날짜를 심어도, 그 해를 훑는
    /// 타임라인 조회는 이 노트를 절대 돌려주지 않는다 — timeline() 은 notes.year/month/day 만
    /// 보고 note_dates 를 조인하지 않으므로 구조적으로 불가능하지만, 실제로 그런지 여기서 고정한다.
    #[test]
    fn extra_dates_never_leak_into_the_timeline_or_the_notes_own_event_axis() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Sejong".into()), Some(1443)).unwrap();
        date_add(&mut conn, &n.note.id, 1998, Some(1), Some(1), None, None, None, None, None, false, None, None, None).unwrap();

        let before = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!((before.year, before.month, before.day), (1443, None, None));

        let timeline_1998 = crate::repo::dashboard::timeline(&conn, &ws, 1998, 1998).unwrap();
        assert!(
            !timeline_1998.items.iter().any(|i| i.note_id == n.note.id),
            "note_dates 의 1998년은 timeline 의 연대 축과 무관해야 한다"
        );
        let timeline_1443 = crate::repo::dashboard::timeline(&conn, &ws, 1443, 1443).unwrap();
        assert!(
            timeline_1443.items.iter().any(|i| i.note_id == n.note.id),
            "노트 자신의 사건 축(1443년)은 그대로 timeline 에 남아 있어야 한다"
        );
    }

    /// 2026-09-07: 관련 날짜도 기간을 가질 수 있다. end_date < date 는 VALIDATION, end_date == date
    /// (단일 시점과 동치)는 허용, 저장/조회 왕복도 확인한다.
    #[test]
    fn date_add_validates_end_date_and_the_period_roundtrips_through_dates_list() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Launch".into()), Some(2026)).unwrap();

        // VALIDATION: end before start.
        let err = date_add(&mut conn, &n.note.id, 2026, Some(9), Some(10), Some(2026), Some(9), Some(9), None, None, false, None, None, None).unwrap_err();
        match err {
            AppError::Validation(_) => {}
            other => panic!("expected Validation, got {other:?}"),
        }

        // VALIDATION: end_month out of range.
        let err = date_add(&mut conn, &n.note.id, 2026, Some(9), Some(10), Some(2026), Some(13), Some(1), None, None, false, None, None, None).unwrap_err();
        match err {
            AppError::Validation(_) => {}
            other => panic!("expected Validation, got {other:?}"),
        }

        // end == start is allowed (a one-day "period", same shape as no period at all).
        let id_eq = date_add(&mut conn, &n.note.id, 2026, Some(9), Some(10), Some(2026), Some(9), Some(10), None, None, false, None, None, None).unwrap();
        // A real multi-day period.
        let id_period = date_add(&mut conn, &n.note.id, 2026, Some(10), Some(1), Some(2026), Some(10), Some(5), None, None, false, None, None, None).unwrap();

        let listed = related_only(&conn, &n.note.id);
        let period = listed.iter().find(|d| d.id == id_period).unwrap();
        assert_eq!((period.year, period.month, period.day), (2026, Some(10), Some(1)));
        assert_eq!((period.end_year, period.end_month, period.end_day), (Some(2026), Some(10), Some(5)));
        let eq = listed.iter().find(|d| d.id == id_eq).unwrap();
        assert_eq!((eq.end_year, eq.end_month, eq.end_day), (Some(2026), Some(9), Some(10)));

        // A date added with no end at all still round-trips as None (existing single-point rows).
        let id_single = date_add(&mut conn, &n.note.id, 2026, Some(11), Some(1), None, None, None, None, None, false, None, None, None).unwrap();
        let single = related_only(&conn, &n.note.id).into_iter().find(|d| d.id == id_single).unwrap();
        assert_eq!(single.end_year, None);
    }

    /// W2c: date_set_schedule 이 쓴 start_time/remind_offset_min 이 dates_list 로 그대로 돌아오는지
    /// 고정한다.
    #[test]
    fn date_set_schedule_roundtrips_through_dates_list_and_untouched_rows_stay_none() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("Launch".into()), Some(2026)).unwrap();

        let id_scheduled = date_add(&mut conn, &n.note.id, 2026, Some(11), Some(5), None, None, None, None, None, false, None, None, None).unwrap();
        let id_untouched = date_add(&mut conn, &n.note.id, 2026, Some(12), Some(1), None, None, None, None, None, false, None, None, None).unwrap();

        date_set_schedule(
            &mut conn,
            &id_scheduled,
            true,
            Some("09:30".to_string()),
            Some(15),
        )
        .unwrap();

        let listed = related_only(&conn, &n.note.id);

        let scheduled = listed.iter().find(|d| d.id == id_scheduled).unwrap();
        assert!(scheduled.remind);
        assert_eq!(scheduled.start_time.as_deref(), Some("09:30"));
        assert_eq!(scheduled.remind_offset_min, Some(15));

        // A row that never went through date_set_schedule stays None for both — no accidental
        // defaulting to 0 or "".
        let untouched = listed.iter().find(|d| d.id == id_untouched).unwrap();
        assert_eq!(untouched.start_time, None);
        assert_eq!(untouched.remind_offset_min, None);
    }

    /// notes.yaml::note_date_make_primary — position 교환: 옛 대표가 note_dates 목록으로 내려가고
    /// (원래 있던 remind 값을 그대로 지닌 채), 대상이 대표로 올라가며(그 결과가 project_primary 로
    /// notes.remind 에 반영된다). 대상 행의 id 자체는 사라지지 않는다 — position 만 0 이 된다.
    #[test]
    fn make_primary_swaps_the_representative_and_moves_remind() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // 옛 대표: 2026-03-10 ~ 2026-03-12(기간), remind 켜짐.
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("행사".into()), Some(2026), Some(3), Some(10), None, None,
        )
        .unwrap();
        crate::repo::notes::set_event_end(&mut conn, &n.note.id, Some(2026), Some(3), Some(12)).unwrap();
        crate::repo::notes::update(&mut conn, &n.note.id, None, None, None, Some(true)).unwrap();

        // 대상 행: 알림 켜짐, 기간도 가짐 — 둘 다 승격 후 확인 대상.
        let target_id = date_add(&mut conn, &n.note.id, 2026, Some(5), Some(1), Some(2026), Some(5), Some(3), None, None, false, None, None, None).unwrap();
        set_remind(&mut conn, &target_id, true).unwrap();

        let before_updated_at = note_summary(&conn, &n.note.id).unwrap().updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));

        let note_id = date_make_primary(&mut conn, &target_id).unwrap();
        assert_eq!(note_id, n.note.id);

        // 2. 대상이 대표로 올라간다.
        let after = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!((after.year, after.month, after.day), (2026, Some(5), Some(1)));
        assert_eq!((after.end_year, after.end_month, after.end_day), (Some(2026), Some(5), Some(3)));
        // 4. remind 도 대상 것을 따라간다(켜져 있었다).
        assert!(after.remind);
        assert!(after.updated_at > before_updated_at, "notes.updated_at 이 bump 돼야 한다");

        // 3. 대상 행 자체는 사라지지 않는다 — 순수 position 교환이라 id 는 그대로 살아있고
        //    position 만 0 이 됐다(dates_list 는 position != 0 만 돌려주므로 목록에서는 빠진다).
        //    삭제가 아니므로 tombstone 도 남지 않는다 — 옛 4단계(삭제+재생성) 모델과의 핵심 차이.
        assert!(related_only(&conn, &n.note.id).iter().all(|d| d.id != target_id));
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='note_dates' AND id=?1",
                [&target_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 0, "순수 position 교환은 아무 행도 지우지 않는다");

        // 1. 옛 대표가 note_dates 행으로 내려갔다 — 순수 position 교환이라 그 행 자신의 값(날짜·
        //    remind 포함)은 손대지 않고 그대로 옮겨간다. 옛 대표는 notes::update(remind=true) 를
        //    거쳐 자신의 position=0 행에 이미 remind=1 이 실려 있었으므로, 내려간 뒤에도 그 값을
        //    그대로 지닌다 — "대표 슬롯의 알림"이라는 옛 개념이 사라지고 "행 자신의 알림"이 된
        //    것이 이 웨이브의 핵심 변화(§1.1 "반복도 시각도 어느 행에나 붙는다"와 같은 결).
        let demoted = related_only(&conn, &n.note.id);
        assert_eq!(demoted.len(), 1, "옛 대표 하나만 관련 날짜로 보여야 한다(대상은 position=0 이 되어 목록에서 빠졌다)");
        let demoted = &demoted[0];
        assert_eq!((demoted.year, demoted.month, demoted.day), (2026, Some(3), Some(10)));
        assert_eq!((demoted.end_year, demoted.end_month, demoted.end_day), (Some(2026), Some(3), Some(12)));
        assert!(demoted.remind, "행 자신의 remind 값은 스왑으로 사라지지 않는다");
    }

    /// W3(§1.1 정밀도 완화): 연도만 있는 대표도 이제 자유롭게 관련 날짜로 내려가고, 연도만 있는
    /// 관련 날짜도 자유롭게 대표로 올라간다 — "note_dates 는 풀 정밀도만 담을 수 있다"는 옛 전제가
    /// 사라졌으므로 그 전제에 기대던 거부 규칙(구 make_primary_rejects_a_year_only_representative)도
    /// 함께 사라졌다.
    #[test]
    fn make_primary_allows_a_year_only_row_on_either_side() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = create(&mut conn, &folder_id, Some("연도만".into()), Some(2026)).unwrap();
        // 대상도 연도만.
        let target_id = date_add(&mut conn, &n.note.id, 2031, None, None, None, None, None, None, None, false, None, None, None).unwrap();

        let note_id = date_make_primary(&mut conn, &target_id).unwrap();
        assert_eq!(note_id, n.note.id);

        // 대상이 대표로 올라갔다(연도만인 채로).
        let after = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!((after.year, after.month, after.day), (2031, None, None));

        // 옛 대표(2026, 연도만)가 관련 날짜로 내려갔다 — 정밀도가 낮아도 거부되지 않는다.
        let demoted = related_only(&conn, &n.note.id);
        assert_eq!(demoted.len(), 1);
        assert_eq!((demoted[0].year, demoted[0].month, demoted[0].day), (2026, None, None));

        // 왕복: 다시 승격해도 정밀도 부족으로 거부되지 않는다.
        let back = date_make_primary(&mut conn, &demoted[0].id).unwrap();
        assert_eq!(back, n.note.id);
        let restored = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!((restored.year, restored.month, restored.day), (2026, None, None));
    }

    /// PLAN-2026-09-07-reminder-2tier.md §3/W2b — 시각·오프셋을 가진 관련 날짜를 승격하면 그
    /// 값이 notes.start_time/remind_offset_min 으로 올라간다(순수 position 교환 + project_primary).
    #[test]
    fn make_primary_lifts_target_start_time_and_offset_to_notes() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // 옛 대표: 시각 없음(승격 후에도 그대로일 걸 확인할 대조군은 다른 테스트가 맡는다).
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("컨퍼런스".into()), Some(2026), Some(1), Some(1), None, None,
        )
        .unwrap();

        let target_id = date_add(&mut conn, &n.note.id, 2026, Some(5), Some(1), None, None, None, None, None, false, None, None, None).unwrap();
        date_set_schedule(&mut conn, &target_id, true, Some("14:30".into()), Some(30)).unwrap();

        date_make_primary(&mut conn, &target_id).unwrap();

        let after = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!((after.year, after.month, after.day), (2026, Some(5), Some(1)));
        assert_eq!(after.start_time.as_deref(), Some("14:30"));
        assert_eq!(after.remind_offset_min, Some(30));
        assert!(after.remind);
    }

    /// PLAN-2026-09-07-reminder-2tier.md §3/W2b — 옛 대표의 시각·오프셋이 내려간 note_dates 행에
    /// 그대로 남는다(순수 position 교환이라 값 자체는 손대지 않는다). 왕복: 다시 승격하면 원래
    /// 값이 notes 로 돌아온다.
    #[test]
    fn make_primary_demotes_old_primarys_time_into_note_dates_row_and_roundtrips() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("행사".into()), Some(2026), Some(3), Some(10), None, None,
        )
        .unwrap();
        crate::repo::notes::set_schedule(
            &mut conn,
            &n.note.id,
            Some("09:00".into()),
            None,
            Some(15),
            None,
        )
        .unwrap();

        let target_id = date_add(&mut conn, &n.note.id, 2026, Some(5), Some(1), None, None, None, None, None, false, None, None, None).unwrap();

        date_make_primary(&mut conn, &target_id).unwrap();

        // 옛 대표가 내려간 note_dates 행에 시각·오프셋이 실려 있다.
        let demoted = related_only(&conn, &n.note.id);
        assert_eq!(demoted.len(), 1);
        let demoted_id = demoted[0].id.clone();
        assert_eq!(demoted[0].start_time.as_deref(), Some("09:00"));
        assert_eq!(demoted[0].remind_offset_min, Some(15));

        // 왕복: 그 행을 다시 승격하면 시각·오프셋이 notes 로 돌아온다.
        date_make_primary(&mut conn, &demoted_id).unwrap();
        let restored = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!(restored.start_time.as_deref(), Some("09:00"));
        assert_eq!(restored.remind_offset_min, Some(15));
    }

    /// PLAN-2026-09-07-reminder-2tier.md §3/W2b — 시각 없는 관련 날짜를 승격하면 notes.start_time
    /// 과 notes.end_time 이 둘 다 NULL 이 된다(대상 행 자신이 애초에 둘 다 가진 적 없다 — date_add/
    /// date_set_schedule 모두 end_time 을 받지 않는다, W1 커맨드 표면 불변).
    #[test]
    fn make_primary_with_untimed_target_clears_notes_start_time_and_end_time() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("행사".into()), Some(2026), Some(3), Some(10), None, None,
        )
        .unwrap();
        crate::repo::notes::set_schedule(
            &mut conn,
            &n.note.id,
            Some("09:00".into()),
            Some("10:30".into()),
            None,
            None,
        )
        .unwrap();

        // 시각 없는 관련 날짜.
        let target_id = date_add(&mut conn, &n.note.id, 2026, Some(5), Some(1), None, None, None, None, None, false, None, None, None).unwrap();

        date_make_primary(&mut conn, &target_id).unwrap();

        let after = note_summary(&conn, &n.note.id).unwrap();
        assert_eq!(after.start_time, None);
        assert_eq!(after.end_time, None, "start_time 없는 end_time 은 남아선 안 된다");
    }

    /// W2(§4, PLAN-2026-09-08-dates-rebuild.md): W1 이 남긴 "rrule 만은 슬롯을 따라간다" 특례가
    /// 사라졌다 — 순수 position 교환이라 rrule 은 그 값이 원래 붙어있던 **행**을 그대로 따라간다.
    /// 대상 행(target)은 rrule 이 없었으므로 승격 후 투영(notes.rrule)도 비고, 내려간 옛 대표
    /// 행은 자신의 rrule 을 그대로 간직한다.
    #[test]
    fn make_primary_moves_rrule_with_the_row_not_the_slot() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("행사".into()), Some(2026), Some(3), Some(10), None, None,
        )
        .unwrap();
        crate::repo::notes::set_schedule(
            &mut conn,
            &n.note.id,
            Some("09:00".into()),
            None,
            None,
            Some("FREQ=WEEKLY;BYDAY=MO".into()),
        )
        .unwrap();

        let target_id = date_add(&mut conn, &n.note.id, 2026, Some(5), Some(1), None, None, None, None, None, false, None, None, None).unwrap();

        let before_rrule = note_summary(&conn, &n.note.id).unwrap().rrule;
        assert_eq!(before_rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO"));

        date_make_primary(&mut conn, &target_id).unwrap();

        let after_rrule = note_summary(&conn, &n.note.id).unwrap().rrule;
        assert_eq!(after_rrule, None, "반복 없던 행이 대표가 됐으니 투영도 반복이 사라진다");

        let demoted_rrule: Option<String> = conn
            .query_row(
                "SELECT rrule FROM note_dates WHERE note_id=?1 AND position != 0",
                [&n.note.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            demoted_rrule.as_deref(),
            Some("FREQ=WEEKLY;BYDAY=MO"),
            "내려간 옛 대표 행은 스왑이 손대지 않은 자신의 rrule 을 그대로 간직한다"
        );
    }

    /// PLAN-2026-09-08-dates-rebuild.md W2(§1.3): 발화는 항상 시작일 — 승격은 순수 position
    /// 교환이므로 "어느 행이 시작일을 갖는가"만 바뀌고, 시각 유무는 더 이상 기준일에 영향을 주지
    /// 않는다(과거 `schedule::anchor_date`가 시각 유무로 기준일을 종료일↔시작일 사이에서 옮기던
    /// 것은 이 웨이브가 없앤 규칙이다).
    #[test]
    fn make_primary_moves_the_fire_anchor_to_the_new_primarys_start_date() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        // 옛 대표: 4/1~4/5 기간, 시각 없음 → 발화는 항상 시작일(4/1).
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("행사".into()), Some(2026), Some(4), Some(1), None, None,
        )
        .unwrap();
        crate::repo::notes::set_event_end(&mut conn, &n.note.id, Some(2026), Some(4), Some(5)).unwrap();
        crate::repo::notes::update(&mut conn, &n.note.id, None, None, None, Some(true)).unwrap();

        // 승격 전: 시작일(4/1) 00:00(기본 all_day_at) 에 울리고, 종료일(4/5)엔 울리지 않는다.
        assert_eq!(
            crate::repo::schedule::due_in_window(&conn, &ws, "2026-03-31T23:59", "2026-04-01T00:00")
                .unwrap()
                .len(),
            1
        );
        assert!(crate::repo::schedule::due_in_window(&conn, &ws, "2026-04-04T23:59", "2026-04-05T00:00")
            .unwrap()
            .is_empty());

        // 대상: 6/1~6/10 기간 + 시각 09:00.
        let target_id = date_add(&mut conn, &n.note.id, 2026, Some(6), Some(1), Some(2026), Some(6), Some(10), None, None, false, None, None, None).unwrap();
        date_set_schedule(&mut conn, &target_id, true, Some("09:00".into()), None).unwrap();

        date_make_primary(&mut conn, &target_id).unwrap();

        // 승격 후: 발화가 새 대표의 시작일(6/1) 09:00 으로 옮겨간다 — 종료일(6/10)엔 울리지 않는다.
        assert_eq!(
            crate::repo::schedule::due_in_window(&conn, &ws, "2026-06-01T08:59", "2026-06-01T09:00")
                .unwrap()
                .len(),
            1
        );
        assert!(crate::repo::schedule::due_in_window(&conn, &ws, "2026-06-09T23:59", "2026-06-10T00:00")
            .unwrap()
            .is_empty());
    }

    /// NOT_FOUND: 존재하지 않는 id.
    #[test]
    fn make_primary_not_found_for_a_missing_id() {
        let mut conn = setup_db();
        let err = date_make_primary(&mut conn, "does-not-exist").unwrap_err();
        match err {
            AppError::NotFound(_) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    /// 2026-09-19 버그 수정(PLAN-2026-09-19-date-region-ui.md §P1 검증 중 발견) — D2("대표는
    /// label을 받지 않는다")는 date_update만 지키고 있었다. date_make_primary는 순수 position
    /// 교환이라 label 컬럼을 건드리지 않으므로, label이 있는 관련 행을 승격하면 그 행이 position=0
    /// 이 되고도 label을 그대로 들고 있었다 — 대표 요약(rowSummary)이 날짜 대신 그 label을 보여주고,
    /// UI는 대표 행에 label 편집 진입점 자체를 숨기므로(D2 전제) 사용자가 지울 방법이 없었다.
    #[test]
    fn make_primary_clears_the_promoted_rows_label_d2() {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let n = crate::repo::notes::create_with_timestamp(
            &mut conn, &folder_id, Some("여행".into()), Some(2026), Some(1), Some(1), None, None,
        )
        .unwrap();
        let target_id = date_add(
            &mut conn, &n.note.id, 2026, Some(12), Some(11), None, None, None, None, None, false,
            None, None, Some("광화문 출사".into()),
        )
        .unwrap();

        date_make_primary(&mut conn, &target_id).unwrap();

        let label_in_db: Option<String> = conn
            .query_row("SELECT label FROM note_dates WHERE id=?1", [&target_id], |r| r.get(0))
            .unwrap();
        assert_eq!(label_in_db, None, "승격된 행은 대표가 되는 순간 label이 비워져야 한다(D2)");
    }

    fn row_err(
        month: Option<i64>,
        day: Option<i64>,
        start_time: Option<&str>,
        end_time: Option<&str>,
        remind_offset_min: Option<i64>,
        rrule: Option<&str>,
    ) -> String {
        validate_row(
            2026,
            month,
            day,
            None,
            None,
            None,
            &start_time.map(Into::into),
            &end_time.map(Into::into),
            remind_offset_min,
            &rrule.map(Into::into),
        )
        .unwrap_err()
        .to_string()
    }

    /// PLAN-2026-09-13-separation-of-concerns.md D4 대조 특성화: `validate_row` 의 시각·알림·반복
    /// 구간(I1~I5)이 `repo::notes::set_schedule` 의 인라인 검증부와 **같은 문구를 같은 순서로**
    /// 낸다는 사실을 못 박는다(그 반대편 테이블은 mod.rs::
    /// test_set_schedule_error_messages_and_precedence_are_pinned). 두 벌이 한 벌로 합쳐진 뒤에도
    /// 이 표는 그대로 통과해야 한다.
    #[test]
    fn validate_row_pins_the_same_schedule_messages_as_set_schedule() {
        // 연월일 풀 정밀도(2026-08-10 대응) vs 연월만.
        let full = (Some(8), Some(10));
        let month_only = (Some(8), None);

        let fmt = "invalid time format (HH:MM 00:00..23:59)";
        assert_eq!(row_err(full.0, full.1, Some("25:00"), None, None, None), format!("{fmt}: 25:00"));
        assert_eq!(row_err(full.0, full.1, Some("7:00"), None, None, None), format!("{fmt}: 7:00"));
        assert_eq!(row_err(full.0, full.1, Some("25:00"), Some("99:99"), None, None), format!("{fmt}: 25:00"));
        assert_eq!(row_err(full.0, full.1, Some("09:00"), Some("99:99"), None, None), format!("{fmt}: 99:99"));

        let range = "remind_offset_min out of range (0..40320)";
        assert_eq!(row_err(full.0, full.1, None, None, Some(-1), None), format!("{range}: -1"));
        assert_eq!(row_err(full.0, full.1, None, None, Some(40321), None), format!("{range}: 40321"));
        assert_eq!(row_err(full.0, full.1, Some("99:99"), None, Some(-1), None), format!("{fmt}: 99:99"));
        assert_eq!(row_err(full.0, full.1, None, Some("10:00"), Some(-1), None), format!("{range}: -1"));

        assert_eq!(
            row_err(month_only.0, month_only.1, Some("09:00"), Some("08:00"), None, None),
            "time requires day precision"
        );
        assert_eq!(
            row_err(month_only.0, month_only.1, Some("09:00"), None, None, Some("FREQ=DAILY")),
            "time requires day precision"
        );
        assert_eq!(row_err(full.0, full.1, None, Some("10:00"), None, None), "end_time requires start_time");
        assert_eq!(
            row_err(full.0, full.1, None, Some("10:00"), None, Some("FREQ=HOURLY")),
            "end_time requires start_time"
        );
        assert_eq!(
            row_err(full.0, full.1, Some("10:00"), Some("09:00"), None, None),
            "end_time must not be before start_time"
        );
        assert_eq!(
            row_err(full.0, full.1, Some("10:00"), Some("09:00"), None, Some("FREQ=HOURLY")),
            "end_time must not be before start_time"
        );
        assert_eq!(
            row_err(month_only.0, month_only.1, None, None, None, Some("FREQ=DAILY")),
            "rrule requires day precision"
        );
        assert_eq!(
            row_err(full.0, full.1, None, None, None, Some("FREQ=HOURLY")),
            "rrule: unsupported FREQ 'HOURLY'"
        );

        // 전부 유효하면 통과.
        validate_row(
            2026,
            Some(8),
            Some(10),
            None,
            None,
            None,
            &Some("09:00".into()),
            &Some("10:00".into()),
            Some(40320),
            &Some("FREQ=DAILY".into()),
        )
        .unwrap();

        // set_schedule 이 **하지 않는** 쪽(기간·정밀도 사다리)도 validate_row 는 본다 — 이 둘이
        // 갈라지는 지점이라 합치더라도 set_schedule 쪽으로 넘어가면 안 된다.
        assert_eq!(
            validate_row(99999, Some(8), Some(10), None, None, None, &None, &None, None, &None)
                .unwrap_err()
                .to_string(),
            "year out of range: 99999"
        );
        assert_eq!(
            validate_row(2026, Some(8), Some(10), Some(2020), Some(1), Some(1), &None, &None, None, &None)
                .unwrap_err()
                .to_string(),
            "event start must not be after event end"
        );
    }
}
