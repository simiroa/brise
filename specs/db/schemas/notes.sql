-- Brise DDL: workspaces / notes 도메인 핵심
-- 규약: id = UUIDv4 TEXT, 시각 = ISO8601 UTC TEXT, bool = INTEGER 0|1

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
-- Sync Phase 0 G1 (migration v24, db/migrations.rs V24_SQL): ALTER TABLE workspaces ADD COLUMN
-- updated_at TEXT NULL, 기존 created_at 값으로 백필 — rename/set_icon/bg_image_path
-- 갱신 경로(repo/workspaces.rs)가 이 컬럼을 함께 찍는다(docs/SYNC.md).
-- Wave 1: 시드 1행 "Korean History", UI는 단일 워크스페이스만 노출
-- Wave 7 (migration v3, db/migrations.rs V3_SQL) / E2 (migration v68, V68_SQL): timeline_preset 컬럼 추가 후 완전 제거됨.
-- Wave 14 (migration v8, db/migrations.rs V8_SQL): 신규 테이블 workspace_regions /
-- workspace_eras — 사용자가 추가한 지역명/시대구간(workspace_id 로 CASCADE 삭제). 내장
-- 프리셋(korea/france)의 지역·시대 목록은 여전히 src/lib/eras.ts 상수이고 이 테이블들에는
-- 없다 — commands/workspaces.yaml 의 workspace_region_*/workspace_era_* 커맨드 참조.

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled Note',
  year        INTEGER NOT NULL CHECK (year BETWEEN -9999 AND 9999),  -- 연대 필터 축
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
  exported_at TEXT,                -- Share=내보내기: 마지막 내보내기 시각 (트리 공유 아이콘 근거)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_notes_folder ON notes(folder_id);
CREATE INDEX idx_notes_year   ON notes(year);
-- Scale note_query (migration v19, db/migrations.rs V19_SQL):
--   CREATE INDEX IF NOT EXISTS idx_notes_year_alive ON notes(year) WHERE deleted_at IS NULL;
--   CREATE INDEX IF NOT EXISTS idx_notes_favorite_year_alive ON notes(is_favorite, year) WHERE deleted_at IS NULL;
--   CREATE INDEX IF NOT EXISTS idx_note_tags_tag_note ON note_tags(tag_id, note_id);
--   CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at) WHERE deleted_at IS NOT NULL;
-- Partial indexes so year/favourite/trash queries skip soft-deleted rows and prefer the
-- notes-side plan over SEARCH f → SEARCH n (folder join). V1 CREATE 는 이미 적용된
-- 마이그레이션이라 여기 본문은 넣지 않음.
-- Scale note_query bbox (migration v20, db/migrations.rs V20_SQL):
--   CREATE INDEX IF NOT EXISTS idx_notes_geo_alive ON notes(lat, lng)
--     WHERE deleted_at IS NULL AND lat IS NOT NULL AND lng IS NOT NULL;
-- Map viewport queries (Region expanded / mini map) must bound markers server-side.
-- Calendar record axis (migration v22, db/migrations.rs V22_SQL):
--   CREATE INDEX IF NOT EXISTS idx_notes_updated_alive ON notes(updated_at) WHERE deleted_at IS NULL;
--   CREATE INDEX IF NOT EXISTS idx_notes_created_alive ON notes(created_at) WHERE deleted_at IS NULL;
-- note_record_histogram (calendar grid day counts) drives from these — before v22 there was no
-- index on either record-axis column, so the query would scan. Partial on deleted_at IS NULL,
-- same shape as idx_notes_year_alive (v19). Two indexes because the calendar's created-date
-- toggle queries the other column the same way. V1 CREATE 는 이미 적용된 마이그레이션이라 여기
-- 본문은 넣지 않음.
-- Scale Phase 1 F13 (migration v14, db/migrations.rs V14_SQL):
--   CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
--   CREATE INDEX IF NOT EXISTS idx_notes_region ON notes(region);
-- 선제 인프라: 현재 필터는 클라 메모리 경로라 이 인덱스를 안 탄다. 서버 필터 이관 시
-- 사용. V1 CREATE 는 이미 적용된 마이그레이션이라 여기 CREATE INDEX 본문은 넣지 않음.
-- Wave 12 (migration v6, db/migrations.rs V6_SQL): ALTER TABLE notes ADD COLUMN region TEXT NULL —
-- 사이드바 필터 스트립의 "Région" 모드(연대 대신). 태그와 달리 노트당 정확히 하나의 값을 갖는
-- 1급 필드로 결정(owner) — 태그처럼 다대다 테이블을 쓰지 않는다. 자유 텍스트, NULL = 지역
-- 미설정. 프리셋별 지역 선택지(src/lib/eras.ts의 EraPreset.regions)는 UI가 보여주는 힌트일
-- 뿐 DB 제약은 아니다 — 사용자가 목록에 없는 지역명을 자유롭게 적어도 허용한다.
-- Wave 15 (migration v9, db/migrations.rs V9_SQL): ALTER TABLE notes ADD COLUMN status TEXT NULL —
-- 타이틀바 재구성과 함께 도입된 노트 진행 상태(작성중/내보냄/완료). 내장 3종은 코드 상수
-- (src/lib/status.ts, repo::taxonomy::BUILT_IN_STATUSES)로만 존재하고 이 컬럼에는 그 키
-- 문자열이 저장된다 — 사용자가 추가한 상태는 새 테이블 workspace_statuses(workspace_regions와
-- 동일한 모양, CASCADE 삭제)의 행 id가 저장된다. 두 종류가 섞이므로 FK 제약은 걸지 않고 커맨드
-- 계층(repo/notes.rs::set_status)에서 검증한다. NULL = 상태 없음(기본, 빈 렌더링).
-- Wave 6a (migration v17, db/migrations.rs V17_SQL): ALTER TABLE notes ADD COLUMN lat REAL NULL,
-- lng REAL NULL — 노트의 위도/경도 좌표. NULL = 좌표 미설정.
-- Trash (migration v12, db/migrations.rs V12_SQL): ALTER TABLE notes ADD COLUMN deleted_at TEXT
-- NULL — 소프트 삭제(휴지통, 복구 가능). NULL = 정상 노트, NOT NULL(ISO8601) = 삭제 시각(휴지통에
-- 있음). note_delete(soft) 는 이 컬럼만 세팅하고 자식 행/첨부는 그대로 둔다(복구를 위해). 완전
-- 삭제는 별도 note_purge 커맨드(구 note_delete의 CASCADE+FTS+internal-link+첨부디렉토리 정리
-- 로직을 그대로 이어받음)가 담당한다. 목록/검색/관련노트 등 모든 "노출" 쿼리는
-- deleted_at IS NULL 을 추가로 걸어야 한다 — repo/notes.rs, repo/folders.rs, repo/search.rs,
-- repo/workspaces.rs 의 다중 쿼리 사이트 참조. 단일 노트 조회(note_summary/
-- note_detail)는 예외 — 휴지통 화면이 개별 삭제 노트를 여전히 불러와야 한다.
-- Event-axis precision (migration v23, db/migrations.rs V23_SQL): ALTER TABLE notes ADD COLUMN
-- month INTEGER NULL / day INTEGER NULL — year(NOT NULL) 위의 선택적 세분화. NULL/NULL=연도만,
-- month만=연월, 둘 다=연월일. day-without-month 는 repo::notes::set_event_precision 이 거부.
-- Dashboard Wave 1 (migration v28, db/migrations.rs V28_SQL):
--   ALTER TABLE notes ADD COLUMN due_at TEXT NULL;           -- (v29에서 폐지됨, 아래 참고)
--   ALTER TABLE notes ADD COLUMN end_year INTEGER NULL;      -- 사건 축 기간 종료
--   ALTER TABLE notes ADD COLUMN end_month INTEGER NULL;
--   ALTER TABLE notes ADD COLUMN end_day INTEGER NULL;
-- Dashboard Wave 2 (migration v29, db/migrations.rs V29_SQL, 2026-08-01 오너 결정): due_at 축
-- 폐지 — "기간의 끝 = 처리 기한", 같은 개념을 두 필드로 들고 있지 않는다. due_at 값이 있던
-- 노트는 end_* 로 이관(end_* 가 비어 있을 때만; 이미 있으면 역사적 종료가 우선하고 due_at은
-- 버려짐, end⇒start 불변식이 깨지면 start도 함께 당김) 후 컬럼 자체를 DROP. 노트의 날짜는
-- 이제 시작(year/month/day) + 종료(end_year/end_month/end_day) 두 축뿐이다. "마감 취급"(긴급도
-- 정렬/빨강/작업탭 레인/달력 ⏰뱃지)은 저장 축이 아니라 표시 규칙: end_day 까지 풀 정밀도가
-- 있고 오늘 기준 [오늘-30일, +∞) 안에 있을 때만 — repo::dashboard 참조. 교차 불변식
-- (end_day⇒end_month⇒end_year, start≤end)은 커맨드 계층(repo/notes.rs::set_event_end /
-- set_event_precision)이 강제 — V23 과 같이 ALTER 로는 교차 CHECK 불가. 쓰기 경로는
-- notes.updated_at 을 bump (docs/SYNC.md LWW).
-- Dashboard Wave 3 (migration v30, db/migrations.rs V30_SQL, 2026-08-01 오너 결정): 마감/긴급도
-- 모델("마감 취급" 표시 규칙, [오늘-30일,+∞) 게이트) 전면 폐지 — 노트 날짜는 중립 기록 정보다.
-- ALTER TABLE notes ADD COLUMN remind INTEGER NOT NULL DEFAULT 0 CHECK (remind IN (0,1)) — 노트별
-- 명시 opt-in "알려줘" 플래그. remind=1 이고 end_day 까지 풀 정밀도가 있는 종료일이 오늘보다
-- 과거일 때만 그 노트가 칸반 컬럼 맨 위로 정렬되고(작업탭 정렬 우선순위일 뿐, 긴급도 표시가
-- 아니다) 모서리에 작은 빨간 점이 붙는다. 완료 컬럼은 이 핀/점 대상에서 제외(완료된 노트를
-- 알람 취급하는 건 원래 불만의 발단이었다). 날짜가 없으면 플래그는 그냥 저장된 불리언으로
-- 아무 효과가 없다. 판정 지점은 repo::dashboard 하나(서버 정렬) — 클라는 서버가 이미 정렬한
-- 순서를 그대로 쓴다.
-- W7-f 아카이브 (migration v36, db/migrations.rs V36_SQL): ALTER TABLE notes ADD COLUMN
-- archived_at TEXT NULL — deleted_at(Trash, v12)과 나란한 두 번째 소프트 상태. "보이지 않지만
-- 찾으면 나온다": 트리/대시보드에서는 deleted_at 처럼 숨기지만, delete()의 fts_delete 는 여기서
-- 호출하지 않으므로 FTS 색인은 그대로 남아 검색 결과에는 계속 나온다(휴지통은 정반대). NULL =
-- 보임, NOT NULL(ISO8601) = 아카이브 시각. repo::notes::archive/unarchive 참조.
-- idx_notes_archived ON notes(archived_at) WHERE archived_at IS NOT NULL — idx_notes_deleted(v19)
-- 와 동일한 이유(카운트 배지 폴더-조인 풀스캔 회피).
-- Dashboard scale (migration v43, db/migrations.rs V43_SQL, SCALABILITY.md §0):
--   ALTER TABLE notes ADD COLUMN span_month_lo INTEGER GENERATED ALWAYS AS (MIN(시작월키, 종료월키)) VIRTUAL;
--   ALTER TABLE notes ADD COLUMN span_month_hi INTEGER GENERATED ALWAYS AS (MAX(시작월키, 종료월키)) VIRTUAL;
--   CREATE INDEX idx_notes_span_month ON notes(span_month_hi, span_month_lo) WHERE deleted_at IS NULL AND archived_at IS NULL;
--   CREATE INDEX idx_notes_rrule_span ON notes(span_month_lo) WHERE rrule IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL;
-- 월키 = year*12 + month-1 (시작은 month 없으면 1월, 종료는 12월 — resolve_start/resolve_end 와
-- 같은 기본값). dashboard_calendar 가 쓰던 MIN/MAX/CASE 표현식 술어는 어떤 인덱스도 못 타서 달을
-- 넘길 때마다 풀스캔이었다 — 같은 식을 생성 컬럼으로 옮겨 `span_month_lo <= ?k AND span_month_hi
-- >= ?k` 라는 순수 컬럼 비교로 만들었다(결과 동치, repo/dashboard/calendar.rs 참조). STORED 가
-- 아니라 VIRTUAL 인 이유는 SQLite ALTER TABLE ADD COLUMN 이 STORED 를 지원하지 않기 때문 —
-- 인덱스에는 계산값이 저장되므로 sargability 목표는 그대로 달성된다.
-- Dashboard board tiers (migration v44, db/migrations.rs V44_SQL, SCALABILITY.md §0):
--   ALTER TABLE notes ADD COLUMN end_sort_key INTEGER GENERATED ALWAYS AS
--     (end_year*10000 + COALESCE(end_month,1)*100 + COALESCE(end_day,1)) VIRTUAL;
--   CREATE INDEX idx_notes_end_sort_alive ON notes(end_sort_key, updated_at DESC)
--     WHERE deleted_at IS NULL AND archived_at IS NULL AND end_year IS NOT NULL;
--   CREATE INDEX idx_notes_undated_updated_alive ON notes(updated_at DESC)
--     WHERE deleted_at IS NULL AND archived_at IS NULL AND end_year IS NULL;
--   CREATE INDEX idx_notes_remind_end ON notes(end_sort_key, updated_at DESC)
--     WHERE deleted_at IS NULL AND archived_at IS NULL AND remind = 1 AND end_day IS NOT NULL;
-- dashboard_board 의 캡 이전 우선순위(board_priority_cmp)는 핀 → 종료일 → updated_at 세 티어인데,
-- 핀 판정이 "오늘"에 의존해 단일 ORDER BY 로는 어떤 인덱스도 못 탄다(LIMIT 이 있어도 전 행이 temp
-- B-tree 를 지난다). 티어마다 부분 인덱스를 주고 세 쿼리로 나눠 각각 LIMIT 만큼만 읽는다 —
-- repo/dashboard/board.rs 의 pin_sql/dated_sql/undated_sql 참조. end_sort_key 가 원시 3열 대신
-- 생성 컬럼인 이유는 schedule_bucket 이 정밀도 부족분을 1 로 채우기 때문(원시 열은 NULL 을 1 보다
-- 앞에 놓아 미세하게 어긋난다). updated_at 이 인덱스에서 DESC 인 이유는 ORDER BY 가 혼합 방향
-- (key ASC, updated_at DESC)이라 같은 방향을 들고 있어야 정렬을 인덱스에서 그대로 가져오기 때문.

CREATE TABLE tags (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL COLLATE NOCASE UNIQUE
  -- Wave 5a (migration v16, db/migrations.rs V16_SQL): color_hue INTEGER NULL CHECK (color_hue IS NULL OR (color_hue >= 0 AND color_hue <= 359))
  -- Sync Phase 0 G1 (migration v24, db/migrations.rs V24_SQL): updated_at TEXT NULL — tags 는
  -- created_at 컬럼 자체가 없어(생성 시각을 추적한 적이 없음) 마이그레이션 적용 시각으로
  -- 백필했다(strftime('now')). repo/notes.rs::tag_set_color 가 갱신 시 이 컬럼을 찍는다.
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);
-- Scale Phase 1 (migration v13, db/migrations.rs V13_SQL): note_tags(tag_id) 역방향 인덱스 —
-- PK 는 (note_id, tag_id) 선행이라 "노트에 달린 태그" 조회는 빠르지만, tag_counts / related 의
-- "이 태그를 단 노트" 쪽은 tag_id 선행 인덱스가 없으면 스캔. V1 CREATE 는 이미 적용된
-- 마이그레이션이라 여기 CREATE INDEX 는 넣지 않고 V13 ALTER 경로로만 추가(SSOT 주석 전용).
-- Scale note_query (migration v19): idx_note_tags_tag_note ON note_tags(tag_id, note_id) —
-- covering 형태(tag OR 필터/집계가 note_id 를 인덱스에서 바로 읽음).

-- Briefing W7 (migration v90, db/migrations.rs V90_SQL): 수집 출처 속성.
--   ALTER TABLE notes ADD COLUMN origin_source_id TEXT NULL;  -- collect_sources.id, FK 없음(소스 삭제 뒤에도 남음)
--   ALTER TABLE notes ADD COLUMN collected_at TEXT NULL;      -- 수집이 이 노트를 쓴(새로 만든/줄을 붙인) 시각
--   CREATE INDEX idx_notes_collected_alive ON notes(collected_at) WHERE collected_at IS NOT NULL AND deleted_at IS NULL;
-- 채우는 곳은 collect::ingest_item_with_note_id 한 곳(repo::notes::stamp_collected). 브리핑 briefing_recent_collected 가 읽는다.
-- 동기화는 이 두 컬럼을 나르지 않는다(기기 로컬 속성).
