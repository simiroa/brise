// repo::transfer::bundle — 번들 wire-format 구조체(export가 만들고 import가 소비). R4 이전에는
// import.rs가 export.rs에서 이 타입들을 역수입했다(방향이 거꾸로) — 공유 지점을 여기로 분리해
// export/import 양쪽이 동등하게 이 파일을 import한다.
//
// `from_row` 메서드들(각 구조체 옆): export.rs의 dump_folder/dump_workspace(load_note_children
// 경유)/dump() 세 스캔이 각자 독립적으로 재입력하던 Row→구조체 매핑을 여기 한 곳으로 모았다
// (docs/PLAN-2026-09-13-separation-of-concerns.md §4-g). SELECT 컬럼 목록·WHERE 절은 호출부마다
// 그대로 남아있고(쿼리 자체는 안 건드림 — 동작 변경 0), 여기서 하는 일은 오직 그 결과 Row 하나를
// 같은 컬럼 순서로 구조체에 옮기는 것뿐이다. 컬럼 순서를 바꾸려면 이 메서드와 호출부의 SELECT
// 컬럼 목록을 **함께** 맞춰야 한다.
use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Bundle {
    pub version: i64,
    pub workspaces: Vec<WorkspaceRow>,
    pub folders: Vec<FolderRow>,
    pub notes: Vec<NoteRow>,
    pub sections: Vec<SectionRow>,
    pub sources: Vec<SourceRow>,
    pub attachments: Vec<AttachmentRow>,
    pub tags: Vec<TagRow>,
    pub note_tags: Vec<NoteTagRow>,
    pub settings: Vec<KvRow>,
    // Wave 14: 사용자가 추가한 지역/시대(workspace_regions/workspace_eras) — 태그와 마찬가지로
    // 사용자가 직접 입력한 콘텐츠라, 내보내기/가져오기 왕복에서 유실되면 실제 데이터 손실이다
    // (반면 workspace.bg_image_path 같은 UI 프리셋은 애초에 이 번들에 없다 —
    // 기존 범위, Wave 14 에서 새로 건드리지 않음). #[serde(default)] 로 v8 이전 번들(이 필드
    // 자체가 없음)도 빈 배열로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub workspace_regions: Vec<WorkspaceRegionRow>,
    #[serde(default)]
    pub workspace_eras: Vec<WorkspaceEraRow>,
    // Wave 15: 사용자가 추가한 노트 상태(workspace_statuses) — regions/eras 와 동일한 이유로
    // 사용자 콘텐츠라 왕복에서 유실되면 실제 데이터 손실이다. #[serde(default)] 로 v8 이전
    // 번들(이 필드 자체가 없음)도 빈 배열로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub workspace_statuses: Vec<WorkspaceStatusRow>,
    // Sync audit P1 fix (2026-08-01): V27 added these two tables but Bundle never carried them —
    // note_regions (경유지, per-note child owned by note_id) and note_related_exclusions (자동
    // 연관노트 해제, a note-pair relation) both round-trip like tags/note_tags do. docs/SYNC.md §8
    // already declared both as sync targets ("행 전체를 push") before this fix landed the actual
    // wiring. #[serde(default)] so bundles from before this fix (fields absent) still parse as
    // empty and import cleanly.
    #[serde(default)]
    pub note_regions: Vec<NoteRegionRow>,
    #[serde(default)]
    pub note_related_exclusions: Vec<NoteRelatedExclusionRow>,
    // Wave 1 Space tab (docs/PLAN-2026-08-15-space-tab.md §3.3): spaces & space_items.
    // #[serde(default)] ensures existing bundles without spaces import cleanly.
    #[serde(default)]
    pub spaces: Vec<SpaceRow>,
    #[serde(default)]
    pub space_items: Vec<SpaceItemRow>,
    // Wave 13 Routine completion history (docs/PLAN-2026-08-16-space-widgets.md §4 W13).
    #[serde(default)]
    pub routine_completions: Vec<RoutineCompletionRow>,
    // GRILL-2026-09-07 D2 (V70): note_dates — note_regions 와 같은 이유로 사용자 콘텐츠라 번들
    // 왕복에서 유실되면 실제 데이터 손실이다. #[serde(default)]로 v70 이전 번들(필드 자체가
    // 없음)도 빈 배열로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub note_dates: Vec<NoteDateRow>,
    // PLAN-2026-09-19-notebook-settings §5: 노트북별 설정(V86 workspace_settings). 노트북과 함께
    // 내보내지고 들어온다. #[serde(default)] — 이전 번들은 빈 배열로 읽히고, 그때는 전역
    // `settings` 에 실려 온 노트북 키가 대신 쓰인다(import::insert_notebook_settings).
    #[serde(default)]
    pub workspace_settings: Vec<WorkspaceSettingRow>,
    // 반복 일정(V82 timeline_routines) — 노트북 소속인데 어느 번들에도 실리지 않아 왕복에서
    // 사라지던 것(같은 계획 §1 빈틈). #[serde(default)] 로 이전 번들도 그대로 읽힌다.
    #[serde(default)]
    pub timeline_routines: Vec<TimelineRoutineRow>,
    // 달력 표시일(V87, PLAN-2026-09-19-calendar-schedule) — 노트북 소속 사용자 데이터라 번들에 실린다.
    // 행 모양은 models 의 커맨드 타입을 그대로 쓴다(열 목록 = repo::calendar_marks::*_COLUMNS).
    #[serde(default)]
    pub calendar_sources: Vec<crate::models::CalendarSource>,
    #[serde(default)]
    pub calendar_marks: Vec<crate::models::CalendarMark>,
    #[serde(default)]
    pub calendar_mark_hides: Vec<CalendarMarkHideRow>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub created_at: String,
}
impl WorkspaceRow {
    /// SELECT id, name, created_at FROM workspaces [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            created_at: r.get(2)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct FolderRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
    pub is_open: i64,
    pub created_at: String,
    // Wave 11: 폴더 아이콘 색상(자유 hue, 0..359) — NULL 이면 커스텀 색상 없음. 번들 왕복 시
    // 보존되어야 한다(invariant_export_roundtrip.rs).
    #[serde(default)]
    pub color_hue: Option<i64>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub rules: Option<String>,
    /// 폴더 단위 일괄 제외(migration v63) — false = 제외 없음. 번들 왕복 시 보존되어야 한다.
    #[serde(default)]
    pub search_excluded: bool,
    #[serde(default)]
    pub ai_excluded: bool,
}
impl FolderRow {
    /// SELECT id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules,
    /// search_excluded, ai_excluded FROM folders [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            name: r.get(2)?,
            position: r.get(3)?,
            is_open: r.get(4)?,
            created_at: r.get(5)?,
            color_hue: r.get(6)?,
            icon: r.get(7)?,
            rules: r.get(8)?,
            search_excluded: r.get::<_, i64>(9)? != 0,
            ai_excluded: r.get::<_, i64>(10)? != 0,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NoteRow {
    pub id: String,
    pub folder_id: String,
    pub title: String,
    pub year: i64,
    pub is_favorite: i64,
    pub exported_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // Wave 12: 노트 지역(region) — NULL 이면 미설정. 번들 왕복 시 보존되어야 한다
    // (invariant_export_roundtrip.rs). #[serde(default)] 로 v6 이전 번들(region 필드 없음)도
    // None 으로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub region: Option<String>,
    // Wave 15: 노트 진행 상태 — NULL 이면 미설정. #[serde(default)] 로 v9 이전 번들(status 필드
    // 없음)도 None 으로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub status: Option<String>,
    // §2.3 HANDOFF-calendar-onboarding.md: 사건 축 정밀도. #[serde(default)] 로 v23 이전 번들
    // (month/day 필드 없음)도 None/None(연도만)으로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub month: Option<i64>,
    #[serde(default)]
    pub day: Option<i64>,
    // Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): "알려줘" opt-in 플래그. #[serde(default)]
    // 로 v30 이전 번들(remind 필드 없음)도 0(false)으로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub remind: i64,
    // Sync audit P1 fix (2026-08-01): end_year/end_month/end_day (V28/V29, 사건 축 기간 종료 —
    // due_at 흡수 후 유일한 종료일 축) + icon(V11)/lat/lng(V17) 는 진작 컬럼이 있었는데도 이
    // NoteRow/두 SELECT/insert_note 에서 누락돼 있었다 — export→import 왕복 시 조용히 사라졌다
    // (remind 를 스레딩한 a0f76cf 와 같은 패턴을 뒤늦게 따라잡음). #[serde(default)] 로 이 필드들이
    // 아예 없던 구버전 번들도 전부 None 으로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub end_year: Option<i64>,
    #[serde(default)]
    pub end_month: Option<i64>,
    #[serde(default)]
    pub end_day: Option<i64>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    // docs/PLAN-schedule-system.md §2.2 W5-1: 일정 시각·알림 오프셋·반복(RRULE 원문) — SYNC.md
    // §8.4 사고(icon/lat/lng/end_* 가 컬럼만 있고 번들엔 빠져 조용히 사라졌던 것)를 반복하지
    // 않기 위해 컬럼 도입과 **동시에** 번들 필드를 넣는다. #[serde(default)] 로 v42 이전 번들
    // (이 필드들 자체가 없음)도 None 으로 파싱되어 정상 임포트된다.
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub remind_offset_min: Option<i64>,
    #[serde(default)]
    pub rrule: Option<String>,
    // 리그레션(데이터 손실 P0, 리뷰어 확인): W7-f 아카이브(V36, migrations.rs) — deleted_at(Trash)
    // 와 나란한 두 번째 소프트 상태인데도, 이 필드가 애초에 없어 세 export SELECT
    // (dump_folder/dump_workspace/dump) 어디도 담지 않았다. deleted_at IS NULL 만 걸러 아카이브
    // 노트도 정상적으로 dump 에는 실리지만(의도된 동작 — 아카이브는 "숨김"이지 "제외"가 아니다),
    // archived_at 자체가 번들에 없어 insert_note 가 항상 NULL 로 심었다 — 즉 번들을 거치는 모든
    // 경로(add_notebook/duplicate_notebook/replace/merge/hash_merge)에서 아카이브 노트가 조용히
    // 언아카이브됐다. 바로 위 end_year/end_month/end_day·icon·lat/lng 가 겪은 것과 같은 계열의
    // 누락(이 파일 헤더 주석 "past incident" 참조) — 이번엔 반복하지 않도록 SELECT/INSERT/remap
    // 전부를 이 필드 도입과 동시에 채운다. #[serde(default)] 로 이 필드 자체가 없는 구버전 번들도
    // None(=미아카이브, 지금까지의 동작과 동일)으로 파싱된다. 순수 타임스탬프 컬럼이라 remap 대상이
    // 아니다(add_notebook::remap_bundle_ids 는 다른 타임스탬프들과 마찬가지로 그대로 clone).
    #[serde(default)]
    pub archived_at: Option<String>,
}
impl NoteRow {
    /// SELECT id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at,
    /// region, status, month, day, remind, end_year, end_month, end_day, icon, lat, lng,
    /// start_time, end_time, remind_offset_min, rrule, archived_at FROM notes [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            folder_id: r.get(1)?,
            title: r.get(2)?,
            year: r.get(3)?,
            is_favorite: r.get(4)?,
            exported_at: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
            region: r.get(8)?,
            status: r.get(9)?,
            month: r.get(10)?,
            day: r.get(11)?,
            remind: r.get(12)?,
            end_year: r.get(13)?,
            end_month: r.get(14)?,
            end_day: r.get(15)?,
            icon: r.get(16)?,
            lat: r.get(17)?,
            lng: r.get(18)?,
            start_time: r.get(19)?,
            end_time: r.get(20)?,
            remind_offset_min: r.get(21)?,
            rrule: r.get(22)?,
            archived_at: r.get(23)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SectionRow {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub body_md: String,
    pub position: i64,
}
impl SectionRow {
    /// SELECT id, note_id, name, body_md, position FROM sections [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            note_id: r.get(1)?,
            name: r.get(2)?,
            body_md: r.get(3)?,
            position: r.get(4)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SourceRow {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub ext: String,
    pub body: String,
    pub position: i64,
    pub created_at: String,
}
impl SourceRow {
    /// SELECT id, note_id, name, ext, body, position, created_at FROM sources [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            note_id: r.get(1)?,
            name: r.get(2)?,
            ext: r.get(3)?,
            body: r.get(4)?,
            position: r.get(5)?,
            created_at: r.get(6)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct AttachmentRow {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub kind: String,
    pub rel_path: Option<String>,
    pub url: Option<String>,
    pub size_bytes: Option<i64>,
    pub position: i64,
    pub created_at: String,
}
impl AttachmentRow {
    /// SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at
    /// FROM attachments [...] (WHERE 절 필터는 호출부마다 다름, 컬럼 순서는 동일)
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            note_id: r.get(1)?,
            name: r.get(2)?,
            kind: r.get(3)?,
            rel_path: r.get(4)?,
            url: r.get(5)?,
            size_bytes: r.get(6)?,
            position: r.get(7)?,
            created_at: r.get(8)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct TagRow {
    pub id: String,
    pub name: String,
}
impl TagRow {
    /// SELECT id, name FROM tags [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NoteTagRow {
    pub note_id: String,
    pub tag_id: String,
}
impl NoteTagRow {
    /// SELECT note_id, tag_id FROM note_tags [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            note_id: r.get(0)?,
            tag_id: r.get(1)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct KvRow {
    pub key: String,
    pub value: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceRegionRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
}
impl WorkspaceRegionRow {
    /// SELECT id, workspace_id, name, position, created_at FROM workspace_regions [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            name: r.get(2)?,
            position: r.get(3)?,
            created_at: r.get(4)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceEraRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub from_year: i64,
    pub to_year: i64,
    pub position: i64,
    pub created_at: String,
}
impl WorkspaceEraRow {
    /// SELECT id, workspace_id, name, from_year, to_year, position, created_at FROM workspace_eras [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            name: r.get(2)?,
            from_year: r.get(3)?,
            to_year: r.get(4)?,
            position: r.get(5)?,
            created_at: r.get(6)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceStatusRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
}
impl WorkspaceStatusRow {
    /// SELECT id, workspace_id, name, position, created_at FROM workspace_statuses [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            name: r.get(2)?,
            position: r.get(3)?,
            created_at: r.get(4)?,
        })
    }
}
// Wave 4 (V27): note_regions/note_related_exclusions — schema (specs 아님, db/migrations.rs
// V27_SQL) 이 둘 다 NOT NULL 컬럼만 두고 있어(자유 텍스트/좌표 필드도 NULL 허용 아님) 아래 두
// 구조체 모두 Option 없이 그대로 미러링한다.
#[derive(Debug, Serialize, Deserialize)]
pub struct NoteRegionRow {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub position: i64,
    pub created_at: String,
}
impl NoteRegionRow {
    /// SELECT id, note_id, name, lat, lng, position, created_at FROM note_regions [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            note_id: r.get(1)?,
            name: r.get(2)?,
            lat: r.get(3)?,
            lng: r.get(4)?,
            position: r.get(5)?,
            created_at: r.get(6)?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NoteRelatedExclusionRow {
    pub id_1: String,
    pub id_2: String,
    pub created_at: String,
}
impl NoteRelatedExclusionRow {
    /// SELECT id_1, id_2, created_at FROM note_related_exclusions [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id_1: r.get(0)?,
            id_2: r.get(1)?,
            created_at: r.get(2)?,
        })
    }
}
// note_dates — note_regions 의 형제. PLAN-2026-09-08-dates-rebuild.md W3: 왕복 모양이 옛
// "date"/"end_date" 문자열 두 컬럼에서 정밀도 트리플 + position + 시각/알림/반복 전체로 바뀌었다
// (§1.1 "모든 행이 같은 컬럼을 갖는다"). **옛 번들 호환**: `year` 가 없는(=옛 번들) 행은 `date`/
// `end_date` 문자열 필드로 대신 온다 — 커스텀 Deserialize 대신 두 모양을 전부 `#[serde(default)]`
// 로 받아두고 `import/mod.rs::insert_note_date` 가 `year.is_some()` 로 새/옛 모양을 갈라 처리한다
// (Option<Option<T>> 커스텀 역직렬화보다 이쪽이 훨씬 짧다 — ponytail). `position` 이 없는 옛
// 번들은 `insert_note_date` 가 `next_position` 으로 순서대로 채번한다.
// 2026-09-07 오너 결정(V74, notes.yaml::note_date_add): label 필드 제거 — 당시엔 구조체에 필드가
// 아예 없어서, label 을 가진 옛 번들의 note_dates 행도 serde 가 그 키를 조용히 무시하고 정상
// 파싱됐다(deny_unknown_fields 없음, 이 파일 어디에도 그 속성이 없다).
// V85 부활(PLAN-2026-09-18-nl-dates.md D1): 아래 label 필드를 다시 선언한다 — 이제부터는 옛 번들의
// label 도 무시되지 않고 **보존**된다. `#[serde(default)]`는 V85 이전(필드 자체가 없던 시절)에
// 만들어진 번들과의 하위 호환용 — 그 경우 키가 아예 없으므로 None 으로 채워진다.
#[derive(Debug, Serialize, Deserialize)]
pub struct NoteDateRow {
    pub id: String,
    pub note_id: String,
    // W3 신규 필드 — #[serde(default)] 로 옛 번들(필드 자체가 없음)도 None 으로 파싱된다.
    #[serde(default)]
    pub position: Option<i64>,
    // W3: 새 모양(트리플). 옛 번들에는 이 키가 없으므로 None — 그 경우 아래 `date`/`end_date`
    // 문자열에서 대신 읽는다(insert_note_date).
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub month: Option<i64>,
    #[serde(default)]
    pub day: Option<i64>,
    #[serde(default)]
    pub end_year: Option<i64>,
    #[serde(default)]
    pub end_month: Option<i64>,
    #[serde(default)]
    pub end_day: Option<i64>,
    // D3 철회(V72, 2026-09-07): 관련 날짜 알림. #[serde(default)] 로 V72 이전 번들(remind 필드
    // 없음)도 0(false)으로 파싱되어 정상 임포트된다 — notes.remind 의 동일 관례(bundle.rs 위 주석).
    #[serde(default)]
    pub remind: i64,
    pub created_at: String,
    // V75(2026-09-07, W2c)/W3: 관련 날짜의 시각·알림 오프셋. #[serde(default)] 로 V75 이전 번들
    // (필드 자체가 없음)도 None 으로 파싱된다 — end_date/remind 와 동일 관례. 이 필드가 없으면
    // 노트북 내보내기/가져오기 왕복에서 사용자가 저장한 시각이 조용히 사라진다.
    #[serde(default)]
    pub start_time: Option<String>,
    // W3 신규.
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub remind_offset_min: Option<i64>,
    // W3 신규 — 반복이 이제 어느 행에나 붙을 수 있다.
    #[serde(default)]
    pub rrule: Option<String>,
    // D1 부활(V85) — 이 파일 위 헤더 주석 참조. 옛 번들(V74~V84, 필드 자체가 없음)은 #[serde(default)]
    // 로 None 파싱된다.
    #[serde(default)]
    pub label: Option<String>,
    // 옛 번들 호환 전용(V70~V76 시절 모양) — "YYYY-MM-DD" 문자열. 새 번들은 이 필드를 쓰지 않고
    // 항상 None 으로 내보낸다(`year` 트리플이 진실).
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
}
impl NoteDateRow {
    /// SELECT id, note_id, position, year, month, day, end_year, end_month, end_day, remind,
    /// created_at, start_time, end_time, remind_offset_min, rrule, label FROM note_dates [...]
    /// (WHERE position != 0 항상 붙음, 필터 대상만 호출부마다 다름). `date`/`end_date`는 옛 번들
    /// 호환 전용 필드라 DB에서 절대 읽지 않는다 — 새로 만드는 행은 항상 None. D1 부활(V85): label
    /// 이 열다섯 번째 컬럼으로 추가됐다 — 이 함수를 부르는 export.rs 의 두 SELECT 문(청크/전체
    /// 덤프) 모두 컬럼 목록에 label 을 포함해야 한다(둘 중 하나라도 빠지면 인덱스가 밀린다).
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            note_id: r.get(1)?,
            position: r.get(2)?,
            year: r.get(3)?,
            month: r.get(4)?,
            day: r.get(5)?,
            end_year: r.get(6)?,
            end_month: r.get(7)?,
            end_day: r.get(8)?,
            remind: r.get(9)?,
            created_at: r.get(10)?,
            start_time: r.get(11)?,
            end_time: r.get(12)?,
            remind_offset_min: r.get(13)?,
            rrule: r.get(14)?,
            label: r.get(15)?,
            date: None,
            end_date: None,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SpaceRow {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub position: i64,
    pub is_home: i64,
    #[serde(default)]
    pub is_favorite: i64,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub default_style: String,
    pub last_viewport_x: f64,
    pub last_viewport_y: f64,
    pub last_viewport_zoom: f64,
    // W5 (migration v62): 미니맵 홈 뷰포트 + 배치 잠금. 구 버전 bundle 에는 필드가 없으므로
    // serde default 로 흡수한다(NULL/false) — is_favorite/archived_at 과 같은 관례.
    #[serde(default)]
    pub home_viewport_x: Option<f64>,
    #[serde(default)]
    pub home_viewport_y: Option<f64>,
    #[serde(default)]
    pub home_viewport_zoom: Option<f64>,
    #[serde(default)]
    pub layout_locked: i64,
    pub created_at: String,
    pub updated_at: String,
}
impl SpaceRow {
    /// SELECT id, workspace_id, title, position, is_home, is_favorite, archived_at,
    /// default_style, last_viewport_x, last_viewport_y, last_viewport_zoom, home_viewport_x,
    /// home_viewport_y, home_viewport_zoom, layout_locked, created_at, updated_at FROM spaces [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            title: r.get(2)?,
            position: r.get(3)?,
            is_home: r.get(4)?,
            is_favorite: r.get(5)?,
            archived_at: r.get(6)?,
            default_style: r.get(7)?,
            last_viewport_x: r.get(8)?,
            last_viewport_y: r.get(9)?,
            last_viewport_zoom: r.get(10)?,
            home_viewport_x: r.get(11)?,
            home_viewport_y: r.get(12)?,
            home_viewport_zoom: r.get(13)?,
            layout_locked: r.get(14)?,
            created_at: r.get(15)?,
            updated_at: r.get(16)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SpaceItemRow {
    pub id: String,
    pub space_id: String,
    pub kind: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub content: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub z_index: i64,
    #[serde(default = "default_space_item_display_mode")]
    pub display_mode: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub locked: i64,
    pub created_at: String,
    pub updated_at: String,
}
impl SpaceItemRow {
    /// SELECT id, space_id, kind, source_id, content, x, y, width, height, z_index,
    /// display_mode, style, locked, created_at, updated_at FROM space_items [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            space_id: r.get(1)?,
            kind: r.get(2)?,
            source_id: r.get(3)?,
            content: r.get(4)?,
            x: r.get(5)?,
            y: r.get(6)?,
            width: r.get(7)?,
            height: r.get(8)?,
            z_index: r.get(9)?,
            display_mode: r.get(10)?,
            style: r.get(11)?,
            locked: r.get(12)?,
            created_at: r.get(13)?,
            updated_at: r.get(14)?,
        })
    }
}

fn default_space_item_display_mode() -> String {
    "preview".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CalendarMarkHideRow {
    pub workspace_id: String,
    pub source: String,
    pub iso_day: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct WorkspaceSettingRow {
    pub workspace_id: String,
    pub key: String,
    pub value: String,
}
impl WorkspaceSettingRow {
    /// SELECT workspace_id, key, value FROM workspace_settings [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            workspace_id: r.get(0)?,
            key: r.get(1)?,
            value: r.get(2)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct TimelineRoutineRow {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub weekday_mask: i64,
    pub start_time: String,
    pub end_time: String,
    pub color_hue: Option<i64>,
    pub skip_holidays: i64,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}
impl TimelineRoutineRow {
    pub const COLUMNS: &'static str =
        "id, workspace_id, title, weekday_mask, start_time, end_time, color_hue, skip_holidays, position, created_at, updated_at";
    /// SELECT {COLUMNS} FROM timeline_routines [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            title: r.get(2)?,
            weekday_mask: r.get(3)?,
            start_time: r.get(4)?,
            end_time: r.get(5)?,
            color_hue: r.get(6)?,
            skip_holidays: r.get(7)?,
            position: r.get(8)?,
            created_at: r.get(9)?,
            updated_at: r.get(10)?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct RoutineCompletionRow {
    pub note_id: String,
    pub occur_on: String,
    pub done_at: String,
}
impl RoutineCompletionRow {
    /// SELECT note_id, occur_on, done_at FROM routine_completions [...]
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            note_id: r.get(0)?,
            occur_on: r.get(1)?,
            done_at: r.get(2)?,
        })
    }
}
