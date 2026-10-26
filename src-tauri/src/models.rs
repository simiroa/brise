// 공용 도메인 타입 (commands/_conventions.yaml#shared_shapes 1:1)
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteSummary {
    pub id: String,
    pub folder_id: String,
    pub title: String,
    pub year: i64,
    pub is_favorite: bool,
    // 더보기 메뉴 "내용잠금"(용어집: "내용"=섹션/본문, 메타데이터·첨부와 별개) — true면 섹션
    // 추가/삭제 + 본문 편집이 금지된다(에디터 read-only). is_favorite와 정확히 같은 구조
    // (V84 ALTER TABLE, repo::notes::toggle_content_lock, note_toggle_content_lock 커맨드).
    // App.tsx의 uiLock("UI 잠금", IconLock 사용)과는 이름·개념 모두 무관 — 혼동 주의.
    pub content_locked: bool,
    pub exported_at: Option<String>,
    pub has_image: bool,
    pub tag_names: Vec<String>,
    // Wave 12: 사이드바 "Région" 필터 축 — 자유 텍스트, NULL = 지역 미설정.
    pub region: Option<String>,
    // D4/N2-2: region(대표) ∪ note_regions(경유지) 합집합 — note_query 서버측 RegionFilterSpec 과
    // 동일한 매칭 규칙을 클라 후처리 필터(검색 칩 경로, search_notes)도 쓸 수 있게 노출. 오직
    // repo::notes::note_summaries_map(검색/related 배치 경로)만 채운다 — note_query 를 직접 타는
    // 경로(트리/맵/달력)는 서버가 이미 합집합으로 필터링해 반환하므로 불필요([] 로 둔다).
    pub region_names: Vec<String>,
    // Wave 15: 노트 진행 상태 — 내장 키("in_progress"|"exported"|"done") 또는
    // workspace_statuses.id, NULL = 상태 없음(기본).
    pub status: Option<String>,
    // 노트 아이콘 키 — src/lib/noteIcons.ts NOTE_ICONS[].key. NULL = 기본(note) 아이콘.
    pub icon: Option<String>,
    // Wave 6a: 노트 좌표 — lat/lng REAL NULL, None = 미설정.
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    // 달력(기록 축) 준비: notes.created_at/updated_at 노출 — year(사건 축)와 달리 둘 다 NOT NULL
    // (ISO8601 UTC), 입력 비용 0으로 첫날부터 채워진다. 정렬(sort:'updated_desc')은 이미 이
    // 컬럼을 쓰고 있어 값 자체는 새로 만드는 게 아니라 트리/검색 응답에 노출만 하는 것.
    pub created_at: String,
    pub updated_at: String,
    // §2.3 HANDOFF-calendar-onboarding.md: event-axis precision. year(NOT NULL) 위의 선택적
    // 세분화 — None/None=연도만, Some/None=연월, Some/Some=연월일. day가 있으면 month도 있다
    // (repo::notes::set_event_precision 이 강제; DB CHECK는 단일 컬럼 범위만 검증한다).
    pub month: Option<i64>,
    pub day: Option<i64>,
    // Dashboard Wave 2 (docs/DASHBOARD.md §2, 2026-08-01): 사건 축 기간 종료 (end_year/end_month/
    // end_day). None 트리플 = 단일 시점 노트. end_day ⇒ end_month ⇒ end_year 불변식은
    // repo::notes::set_event_end 가 강제. 마감 축(due_at)은 폐지되어 이 필드로 흡수됐다 —
    // "기간의 끝 = 처리 기한", 같은 개념을 두 필드로 두지 않는다(db/migrations.rs V29_SQL).
    // "마감 취급"(긴급도/빨강/⏰뱃지)은 별도 저장 필드가 아니라 표시 규칙(repo::dashboard 참조:
    // end_day 까지 풀 정밀도 + 오늘 기준 [오늘-30일, +∞)).
    #[serde(default)]
    pub end_year: Option<i64>,
    #[serde(default)]
    pub end_month: Option<i64>,
    #[serde(default)]
    pub end_day: Option<i64>,
    // Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): 노트별 "알려줘" opt-in 플래그. 마감/
    // 긴급도 표시 규칙은 전면 폐지 — remind=true 이고 end_* 가 풀 정밀도로 과거일 때만
    // 표시 효과(칸반 핀 + 빨간 점)가 있다(repo::dashboard 판정). 날짜 없이 켜져 있어도 무효과.
    // #[serde(default)] 로 v30 이전 직렬화 값(필드 없음)도 false 로 파싱된다.
    #[serde(default)]
    pub remind: bool,
    // docs/PLAN-schedule-system.md §1.2/§1.3 (W5-1): 일정 시각·알림 오프셋·반복(RRULE 서브셋 원문).
    // start_time 은 "HH:MM"(로컬), 있으려면 month/day 풀 정밀도가 전제(I1) — 강제는
    // repo::notes::set_schedule. end_time 은 start_time 이 있어야 의미가 있다(I2). remind_offset_min
    // 은 몇 분 전에 알릴지(NULL=정시). rrule 은 §3 서브셋 문자열 원문 — 이 웨이브(W5-1)는 저장/
    // 왕복만 하고 문법 검증(I5)은 하지 않는다(관문은 repo::schedule::rrule::parse, W5-2).
    // ponytail: rrule_parts(파싱된 구조체, §3.3)는 아직 싣지 않는다 — repo::schedule 모듈이
    // 이번 웨이브 소유가 아니라 파서 타입이 없다. W5-2가 landing되면 그 계약을 쓰는 웨이브(W5-4)가
    // 추가한다.
    // #[serde(default)] 로 v42 이전 직렬화 값(필드 없음)도 None 으로 파싱된다(remind 와 동일 관례).
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub remind_offset_min: Option<i64>,
    #[serde(default)]
    pub rrule: Option<String>,
    // Wave 4: 검색 매치 본문 스니펫 (\u0002/\u0003 마커 포함). 검색 이외(폴더 목록 등)에서는 None (JSON 생략).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Section {
    pub id: String,
    pub name: String,
    pub body_md: String,
    pub position: i64,
    // db/migrations.rs V26_SQL/V57_SQL: "text" (Tiptap prose, the historical default) |
    // "diagram" (mermaid source text, never touches the Tiptap/mdSerialize path) | "sheet"
    // (시트 — body_md is one sheet JSON blob, specs/features/sheet.md). Additive JSON field —
    // reaches both native IPC and the sync API for free since this struct is serialized as-is in
    // both places (repo::notes::note_detail). #[serde(default)] covers any Deserialize call site
    // (e.g. a future import path) built against a payload from before this field existed.
    #[serde(default = "default_section_kind")]
    pub kind: String,
    // db/migrations.rs V67_SQL (specs/commands/_conventions.yaml Section shape, additive):
    // NULL = user-authored, otherwise the AI action id (summarize/organize/translate/…) that
    // last wrote this section's body_md. 항상 채워 보낸다 — skip_serializing_if 없음, None 이면
    // JSON null 로 나간다(생략 아님). 세 갈래 쓰기 계약은 repo::sections::update, SSOT는
    // specs/commands/sections.yaml section_update notes.
    #[serde(default)]
    pub ai_origin: Option<String>,
    // ponytail/spec-drift: NOT yet in specs/commands/_conventions.yaml's Section shape (this
    // wave's delegation prompt assumed it already was — it wasn't, since Section never exposed
    // sections.updated_at before now). Added here only, not regenerated into commands.gen.ts, so
    // frontend consumers must locally widen the `Section` type to read it (see
    // components/editor/SectionTabBar.tsx). Reaches both native IPC and the sync API "for free"
    // the same way `kind` above does (this struct is serialized as-is). Needed for the W5
    // section-tab AI-provenance tooltip's date. A future `npm run gen` pass should fold this into
    // _conventions.yaml to close the drift; flagged in the W5 wave report for the coordinator.
    #[serde(default)]
    pub updated_at: Option<String>,
}

fn default_section_kind() -> String {
    "text".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub body: String,
    pub position: i64,
    /// 본문이 추출 상한(1MB)에 걸려 뒷부분이 잘렸는지 — 본문은 DB 에 그대로 남으므로 이 사실도
    /// 함께 남는다(sources.truncated, migration V81). 문구가 아니라 플래그인 이유: 저장 시점
    /// 로케일로 굳은 문장은 다른 로케일 사용자에게 잘못된 데이터가 된다.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub kind: String, // image|doc|link|audio
    pub rel_path: Option<String>,
    /// 앱 폴더 밖 원본의 절대경로(참조 첨부) — rel_path 와 배타(db/migrations.rs V80_SQL).
    pub ext_path: Option<String>,
    pub url: Option<String>,
    pub size_bytes: Option<i64>,
    pub position: i64,
    /// 오디오 전사 결과(V93, audio_transcribe) — 서버가 첨부 행에 보관하고 클라이언트가 삽입한다.
    pub transcript: Option<String>,
    /// 전사 블록이 본문에 이미 삽입됐는지(attachment_transcript_mark_inserted). 같은 전사의 중복 삽입 방지.
    pub transcript_inserted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteDetail {
    pub note: NoteSummary,
    pub sections: Vec<Section>,
    pub sources: Vec<Source>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Folder {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
    pub is_open: bool,
    pub note_count: i64,
    // Wave 11: 자유 hue 슬라이더(0..359) — NULL = 커스텀 색상 없음. 명도/채도는 프론트가
    // 테마별로 도출(color_hue 자체는 헥스가 아니므로 테마 무관하게 하나의 값으로 저장 가능).
    pub color_hue: Option<i64>,
    /// NOTE_ICONS 키. None = 기본 폴더 글리프.
    pub icon: Option<String>,
    /// Folder organize rules. Notes in this folder inherit them as extra AI
    /// organize guidance (override/extend the global metadata prompt).
    pub rules: Option<String>,
    /// search_notes(전역 검색) 후보에서 이 폴더의 노트를 뺀다. 트리/그래프/타임라인은 영향 없음.
    pub search_excluded: bool,
    /// ai_organize_note와 에이전트 스캔(폴더/노트북 일괄 계획)의 입력 후보에서 이 폴더의 노트를 뺀다.
    pub ai_excluded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteRegion {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub position: i64,
}

/// PLAN-2026-09-08-dates-rebuild.md W3: note_regions 의 형제, 정밀도 사다리(연→월→일→시:분)를
/// 갖는다 — 모든 행이 같은 컬럼을 갖고(대표/관련의 능력 차이 없음), note_date_add/note_date_update
/// 양쪽 모두 이 사다리 전체를 입출력한다. `date`/`end_date` 파생 문자열은 W1이 ponytail 로 임시
/// 남겼던 것을 W3에서 제거했다 — 프런트가 트리플을 직접 받는다(W4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteDate {
    pub id: String,
    pub note_id: String,
    /// 0 = 대표(사건 축), 1.. = 관련 날짜. dates_list 는 position != 0 만 돌려주므로 여기 실리는
    /// 값은 항상 1 이상이다.
    pub position: i64,
    /// 정밀도 사다리(§1.1). year 는 NOT NULL, month/day 는 정밀도를 표현한다(notes.year/month/day
    /// 와 동일 모델).
    pub year: i64,
    pub month: Option<i64>,
    pub day: Option<i64>,
    pub end_year: Option<i64>,
    pub end_month: Option<i64>,
    pub end_day: Option<i64>,
    /// 켜면 알림. 완료 수단은 이 토글을 다시 끄는 것(§1.5).
    pub remind: bool,
    pub created_at: String,
    /// "HH:MM"(로컬). W3: 어느 행에나 붙을 수 있다(대표/관련 차이 없음).
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    /// 0..40320(28일) 분.
    #[serde(default)]
    pub remind_offset_min: Option<i64>,
    /// W3: 반복도 어느 행에나 붙을 수 있다 — 옛 "대표 슬롯 전용" 제약이 사라졌다.
    #[serde(default)]
    pub rrule: Option<String>,
    /// D1 부활(V85, PLAN-2026-09-18-nl-dates.md): 관련 날짜 구분용 라벨. V74가 드롭했던 것을
    /// 되돌린다 — 그때는 "노트 이름으로 충분하다"(한 노트=한 사건)였지만, 이번엔 한 노트에 관련
    /// 날짜가 여러 개 붙는 용도(여행 일정 등)라 행마다 이름이 필요하다. 표시는 `label ?? 노트
    /// 제목`. **대표(position=0)는 라벨을 받지 않는다(D2)** — 항상 None.
    #[serde(default)]
    pub label: Option<String>,
}

// ── Space (공간) 탭 도메인 타입 (docs/PLAN-2026-08-15-space-tab.md §5) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Space {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub position: i64,
    pub is_home: bool,
    pub is_favorite: bool,
    pub archived_at: Option<String>,
    pub default_style: String,
    pub last_viewport_x: f64,
    pub last_viewport_y: f64,
    pub last_viewport_zoom: f64,
    // W5 (docs/PLAN-2026-08-26-space-toolbar-frame-waves.md §2): 미니맵 "홈 보기" 좌표.
    // nullable — 미지정 상태에서 홈 보기는 전체보기 폴백. last_viewport_* 과 달리 자동 갱신 없음.
    pub home_viewport_x: Option<f64>,
    pub home_viewport_y: Option<f64>,
    pub home_viewport_zoom: Option<f64>,
    // 공간 수준 배치 잠금("배치 잠금, 사용은 허용") — 아이템별 locked 와 무관한 별개 축.
    pub layout_locked: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpaceItem {
    pub id: String,
    pub space_id: String,
    pub kind: String,
    pub source_id: Option<String>,
    pub content: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
    pub display_mode: String,
    pub style: String,
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpaceItemsResult {
    pub items: Vec<SpaceItem>,
    pub total_matched: i64,
    pub cap: i64,
    pub capped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpaceItemSeed {
    pub kind: String,
    #[serde(default)]
    pub content: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub style: String,
    #[serde(default = "default_seed_display_mode")]
    pub display_mode: String,
}

fn default_seed_display_mode() -> String {
    "preview".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpaceItemMove {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutineToggleResult {
    pub note_id: String,
    pub occur_on: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutineTodayItem {
    pub note_id: String,
    pub title: String,
    pub done: bool,
    pub time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutineTodayResult {
    pub items: Vec<RoutineTodayItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutineDay {
    pub date: String,
    pub done: i64,
    pub due: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutineHistoryResult {
    pub days: Vec<RoutineDay>,
    pub from: String,
    pub to: String,
}

// ── Timeline routines (specs/db/schemas/timeline_routines.sql, specs/commands/timeline_routines.yaml) ──
// 노트에 묶이지 않는, 매주 같은 요일·시각에 시간축을 채우는 배경 블록("출퇴근" 등). 캔버스(space)
// 위젯의 습관 체크트래커(RoutineToday* 위 타입들)와는 다른 개념이다 — 혼동 금지.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelineRoutine {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    /// 비트 0=월 .. 비트 6=일(ISO 순서, 고정). 1..127 범위(CHECK 제약과 동일).
    pub weekday_mask: i64,
    /// 'HH:MM'.
    pub start_time: String,
    /// 'HH:MM', start_time보다 뒤(자정 넘김 v1 미지원).
    pub end_time: String,
    pub color_hue: Option<i64>,
    /// v83 — 켜면 그 요일이어도(프론트의 useHolidayMap 기준) 공휴일인 날엔 축에서 숨는다.
    /// 서버는 공휴일 날짜를 모르고 이 플래그만 저장·왕복한다.
    pub skip_holidays: bool,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

// ── 달력 표시일 (specs/db/schemas/calendar_marks.sql, PLAN-2026-09-19-calendar-schedule) ─────

/// 공휴일·기념일 이름표 한 줄. `source_id` None = 내 기념일.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarMark {
    pub id: String,
    pub workspace_id: String,
    pub source_id: Option<String>,
    pub uid: Option<String>,
    pub title: String,
    pub year: Option<i64>,
    pub month: i64,
    pub day: i64,
    /// 'once' | 'yearly'.
    pub repeat: String,
    pub lunar: bool,
    pub day_off: bool,
    pub color_hue: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// 불러온 캘린더(.ics 파일/URL) 하나.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarSource {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub url: Option<String>,
    pub enabled: bool,
    pub color_hue: Option<i64>,
    pub fetched_at: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 숨긴 하루. `source` = "builtin" | calendar_sources.id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarMarkHide {
    pub source: String,
    pub iso_day: String,
}

// ── Habits (specs/db/schemas/habits.sql, specs/commands/habits.yaml, PLAN-2026-09-30-briefing) ──
// 브리핑 습관 — 시간 없이 날짜별로 체크. timeline_routines·routine_completions 와 별개.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Habit {
    pub id: String,
    pub workspace_id: String, // = 노트북
    pub title: String,
    pub icon: Option<String>,
    pub hue: Option<i64>,
    /// 비트 0=월 .. 비트 6=일. 127 = 매일.
    pub weekday_mask: i64,
    pub position: i64,
    pub archived_at: Option<String>,
    pub created_at: String,
    /// 'any'|'morning'|'evening' — 브리핑 카드의 시간대 그룹(migration v91).
    pub time_of_day: String,
}

/// 브리핑 "최근 수집 노트" 한 줄(PLAN-2026-09-30-briefing W7). NoteSummary 를 늘리지 않으려고 따로 둔다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectedNote {
    pub note_id: String,
    pub title: String,
    pub excerpt: Option<String>,
    pub source_id: Option<String>,
    /// 소스가 삭제됐으면 None — 카드가 출처 칩을 생략한다.
    pub source_name: Option<String>,
    pub source_kind: Option<String>,
    pub collected_at: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentCollected {
    pub items: Vec<CollectedNote>,
    pub new_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HabitDay {
    pub day: String,
    pub scheduled: bool,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HabitWeekRow {
    pub habit: Habit,
    pub days: Vec<HabitDay>,
    pub done_count: i64,
    pub scheduled_count: i64,
    pub rate: Option<f64>,
    /// 현재 연속 일수(기준일부터 거슬러, 쉬는 요일은 건너뜀, 미체크 오늘은 끊지 않음, 상한 365).
    pub streak: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HabitWeek {
    pub from: String,
    pub to: String,
    pub today: String,
    pub rows: Vec<HabitWeekRow>,
    pub done_count: i64,
    pub scheduled_count: i64,
    pub rate: Option<f64>,
}

/// habit_history 의 하루 한 칸 — 그날 예정된 습관 수와 그중 체크된 수(브리핑 12주 히트맵).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HabitHistoryDay {
    pub day: String,
    pub scheduled: i64,
    pub done: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HabitHistory {
    pub from: String,
    pub to: String,
    pub days: Vec<HabitHistoryDay>,
}
