-- 달력 표시일 — 공휴일·기념일 이름표 (migration v87, docs/PLAN-2026-09-19-calendar-schedule.md).
--
-- 한 날에 붙는 **이름표**다. 노트가 아니고 칩도 아니다: 매년 반복 노트로는 빨간 날(dayTone)을 만들 수
-- 없고 반복 일정 skip(timeline_routines.skip_holidays)도 못 켠다 — 둘 다 공휴일 맵만 읽는다.
-- 전부 **노트북 소속**(workspace_id, 오너 결정 2026-09-19 노트북 완전 격리) — 노트북 내보내기/가져오기에
-- 함께 실린다(repo/transfer/bundle.rs).
--
-- 기본 공휴일(대한민국 정적 표, src/lib/holidays.ts)은 **DB 에 복사하지 않는다** — 표는 코드가 연장하는데
-- DB 사본은 그 연장을 못 받는다. 어느 나라 표를 쓸지는 노트북 설정 `holiday_region` 이 정하고, 표의
-- 하루를 끄는 것만 calendar_mark_hides(source='builtin') 에 남는다.

-- 불러온 캘린더(.ics 파일 또는 URL) 하나. 그 안의 날들은 calendar_marks.source_id 로 매달린다.
-- 다시 불러오기 = 이 출처의 표시일 행을 한 트랜잭션에서 통째로 교체한다.
CREATE TABLE calendar_sources (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  url          TEXT NULL,                 -- NULL = 파일에서 불러옴(다시 불러오기는 파일을 다시 고른다)
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  color_hue    INTEGER NULL,
  fetched_at   TEXT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_calendar_sources_workspace ON calendar_sources(workspace_id, position);

-- 표시일. source_id NULL = "내 기념일"(직접 추가·편집·삭제). NOT NULL = 불러온 캘린더의 행(직접 편집
-- 안 함 — 다시 불러오면 덮인다).
-- repeat: 'once'(그해 한 번, year 필수) | 'yearly'(매년, year = 처음 해 — "N주년" 표시에 쓴다, 선택).
-- lunar: 음력 월/일(매년일 때만 의미). 전개는 프런트(lib/lunar.ts, Intl 'dangi' 달력)가 한다.
-- day_off: 빨간 날(dayTone "sun" + 루틴 skip_holidays 대상). 0 이면 이름표만.
CREATE TABLE calendar_marks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id    TEXT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  uid          TEXT NULL,                 -- ics UID(다시 불러오기 때 같은 행을 알아보는 열쇠, 참고용)
  title        TEXT NOT NULL,
  year         INTEGER NULL,
  month        INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day          INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  repeat       TEXT NOT NULL CHECK (repeat IN ('once','yearly')),
  lunar        INTEGER NOT NULL DEFAULT 0 CHECK (lunar IN (0,1)),
  day_off      INTEGER NOT NULL DEFAULT 0 CHECK (day_off IN (0,1)),
  color_hue    INTEGER NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (repeat = 'yearly' OR year IS NOT NULL)
);
CREATE INDEX idx_calendar_marks_workspace ON calendar_marks(workspace_id);
CREATE INDEX idx_calendar_marks_source ON calendar_marks(source_id);

-- 하루 숨기기. source = 'builtin'(기본 공휴일 표) 또는 calendar_sources.id. 불러온 캘린더 행을 지우지
-- 않고 숨기는 이유: 다시 불러오면 지운 날이 되살아난다 — 숨김은 날짜로 매달려 살아남는다.
CREATE TABLE calendar_mark_hides (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  iso_day      TEXT NOT NULL,             -- 'YYYY-MM-DD'
  PRIMARY KEY (workspace_id, source, iso_day)
);
