-- Timeline routines (그릴 2026-09-13: 사이드바/대시보드 시간축용 반복 일정 블록).
--
-- 노트에 묶이지 않는다 — 캔버스(space) 위젯의 습관 체크트래커(routine_completions.sql, note_id
-- 필수)와는 다른 개념이다. 저것은 "오늘 했는가"를 노트별로 체크하는 것이고, 이것은 "출퇴근"처럼
-- 매주 같은 요일·시각에 시간축을 채우는 배경 블록이다 — 어느 노트에도 속하지 않고, 옮기거나
-- 크기를 바꿀 수 없다(그날그날의 note_dates 행이 아니므로).
--
-- v1 범위(그릴 2026-09-13 W3): 예외일(공휴일 skip 등) 없음, 알림 연동 없음 — 순수 시각 표시.
-- 필요해지면 그때 exceptions 테이블이나 rrule 승격을 검토한다(과설계 방지).
--
-- weekday_mask: 비트 0=월 .. 비트 6=일(ISO 순서, 고정) — 사용자의 주 시작 설정(weekStart, UI
-- 표시 전용)과 무관하게 저장은 항상 이 순서.
-- start_time/end_time: 'HH:MM', 자정을 넘는 구간은 표현하지 않는다(그런 루틴은 드묾 — 필요해지면
-- 그때 end_time < start_time을 "다음날까지"로 해석하는 규칙을 추가한다).

CREATE TABLE timeline_routines (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  weekday_mask INTEGER NOT NULL CHECK (weekday_mask BETWEEN 1 AND 127),
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL CHECK (end_time > start_time),
  color_hue    INTEGER NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_timeline_routines_workspace ON timeline_routines(workspace_id, position);

-- 공휴일 skip (migration v83, db/migrations.rs V83_SQL): ALTER TABLE timeline_routines ADD COLUMN
-- skip_holidays INTEGER NOT NULL DEFAULT 0 CHECK (skip_holidays IN (0,1)) — 켜면 그 요일이어도
-- (프론트의 useHolidayMap 기준) 공휴일인 날엔 배경 띠를 그리지 않는다. 기본 0(끔), 기존 행은
-- 동작 변화 없음. v82가 이미 적용된 마이그레이션이라 여기 CREATE TABLE 자체는 그대로 두고
-- ALTER로 추가한다(folders.sql의 color_hue와 같은 관례).
