-- 노트북별 설정 (migration v86, docs/PLAN-2026-09-19-notebook-settings.md).
--
-- 오너 결정(2026-09-19): 노트북마다 완전히 격리된 경험 — 테마·언어·달력까지 노트북을 바꾸면 바뀌고,
-- 노트북 내보내기/가져오기에 함께 실린다. 새 노트북은 행이 없다 = 전부 기본값.
--
-- 어떤 키가 여기 사는지는 Rust `repo/settings_schema.rs::NOTEBOOK_KEYS` 가 정한다(SQL CHECK 로 걸지
-- 않는다 — 목록이 자라면 CHECK 를 고치는 테이블 재작성이 필요해진다; 쓰기 관문은
-- `repo::settings::set` 하나다). value 는 `settings.value` 와 같은 JSON 텍스트.
--
-- 읽기: `repo::settings::get_all` = 기본값 → 전역 settings → **활성 노트북의 이 테이블** 순서로 덮는다.
-- 쓰기: `repo::settings::set` 이 NOTEBOOK_KEYS 는 활성 노트북 행으로, 나머지는 전역으로 보낸다.

CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
