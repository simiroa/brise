-- [DORMANT / 휴면] 공간 플러그인 독립 창 재구축(PLAN-2026-08-27-space-plugin-rebuild)으로 인해
-- 기존 spaces / space_items / space_edges / space_nodes 테이블은 읽기/쓰기/삭제 없이 휴면 보존됩니다.
-- 새 테이블 정의는 space_canvases.sql 및 migration V64를 참조하세요.
--
-- Brise DDL: spaces & space_items (migration v50, db/migrations.rs V50_SQL; v51/v52/v62 컬럼 추가)
-- 공간(Space) 탭 DDL 및 인덱스 정의 (docs/PLAN-2026-08-15-space-tab.md §3.1)

-- 1. spaces: 노트북(= workspace)에 속하는 캔버스 공간
CREATE TABLE spaces (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  position           INTEGER NOT NULL DEFAULT 0,                                 -- 공간 목록 정렬 순서
  is_home            INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0,1)),        -- 홈 공간 여부 (노트북당 최대 1개)
  is_favorite        INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),    -- 즐겨찾기 여부 (V51)
  archived_at        TEXT NULL,                                                  -- 보관 시각 (V51)
  default_style      TEXT NOT NULL DEFAULT '',                                   -- 공간 기본 요소 스타일 (V52)
  last_viewport_x    REAL NOT NULL DEFAULT 0,                                    -- 뷰포트 복원용 월드 좌표 X
  last_viewport_y    REAL NOT NULL DEFAULT 0,                                    -- 뷰포트 복원용 월드 좌표 Y
  last_viewport_zoom REAL NOT NULL DEFAULT 1,                                    -- 뷰포트 복원용 줌 배율 (> 0)
  home_viewport_x    REAL NULL,                                                  -- 미니맵 "홈 보기" 좌표 X (V62, nullable = 미지정 → 전체보기 폴백)
  home_viewport_y    REAL NULL,                                                  -- 미니맵 "홈 보기" 좌표 Y (V62)
  home_viewport_zoom REAL NULL,                                                  -- 미니맵 "홈 보기" 줌 배율 (V62, > 0)
  layout_locked      INTEGER NOT NULL DEFAULT 0 CHECK (layout_locked IN (0,1)),  -- 공간 수준 배치 잠금 "배치 잠금, 사용은 허용" (V62). 아이템별 locked 와 무관한 별개 축
  created_at         TEXT NOT NULL,                                              -- ISO 8601 타임스탬프
  updated_at         TEXT NOT NULL                                               -- ISO 8601 타임스탬프 (모든 쓰기 시 갱신)
);
CREATE INDEX idx_spaces_ws ON spaces(workspace_id, position);
CREATE UNIQUE INDEX idx_spaces_home ON spaces(workspace_id) WHERE is_home = 1;
CREATE INDEX idx_spaces_ws_archived ON spaces(workspace_id, archived_at);

-- 2. space_items: 공간 내에 배치되는 캔버스 카드 요소
-- 주의: source_id에는 절대 FK/CASCADE를 걸지 않는다.
-- 원본 노트가 삭제되어도 공간 배치는 조용히 삭제되지 않고 tombstone 카드로 유지된다.
CREATE TABLE space_items (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','text','checklist','frame','today','image','widget')), -- W-R6: 'sketch' kind 추가 (Rust validation allowlist: spaces.rs)
  source_id    TEXT NULL,                                                -- kind='note'면 notes.id, kind='image'면 attachments/-상대경로 `spaces/{space_id}/{file}`. FK 없음!
  content      TEXT NOT NULL DEFAULT '',                                 -- kind별 내용 (text/frame: 텍스트, checklist/sketch: JSON, 그 외: '')
  x            REAL NOT NULL,                                            -- 절대 월드 좌표 X
  y            REAL NOT NULL,                                            -- 절대 월드 좌표 Y
  width        REAL NOT NULL,                                            -- 너비 (px)
  height       REAL NOT NULL,                                            -- 높이 (px)
  z_index      INTEGER NOT NULL DEFAULT 0,                               -- 레이어 순서 (1000 단위 희소값)
  display_mode TEXT NOT NULL DEFAULT 'preview',                          -- 'preview' | 'title'
  style        TEXT NOT NULL DEFAULT '',                                 -- JSON 형식 스타일 ('bg', 'border' 등)
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),       -- 1이면 드래그/리사이즈 잠금
  created_at   TEXT NOT NULL,                                            -- ISO 8601 타임스탬프
  updated_at   TEXT NOT NULL                                             -- ISO 8601 타임스탬프
);
CREATE INDEX idx_space_items_space ON space_items(space_id, z_index);

-- 3. 이미지 에셋 루트 (테이블 없음 — attachments.note_id 가 NOT NULL 이라 그 테이블에 넣을 수 없다):
--    data_dir/attachments/spaces/{space_id}/{stored_name}
--    카드는 원본이 아니라 `{rel_path}.thumb.jpg` (thumbs.rs, 긴 변 256px JPEG q80) 를 가리킨다.
--    orphan_cleanup 은 예약 디렉터리명 `spaces` 를 건너뛰고, 그 안에서 죽은 space_id 만 수거한다.

-- 4. workspaces.space_bootstrapped (migration v50):
-- ALTER TABLE workspaces ADD COLUMN space_bootstrapped INTEGER NOT NULL DEFAULT 0 CHECK (space_bootstrapped IN (0,1));
-- 노트북별 홈 템플릿 최초 부트스트랩 완료 여부.
-- 0 = 부트스트랩 미수행, 1 = 부트스트랩 완료 (공간이 0개로 지워져도 다시 생성되지 않음).
