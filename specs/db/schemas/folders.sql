-- Brise DDL: folders
-- 폴더 삭제는 노트 CASCADE (UI에서 노트 수 표시 후 확인 다이얼로그 필수 — service/notes.yaml 참조)

CREATE TABLE folders (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,   -- 트리 정렬 순서
  is_open      INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0,1)),  -- 트리 접힘 상태 영속화
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_folders_ws ON folders(workspace_id, position);
-- Wave 1 시드: 기본 폴더 1행 "Notes" — 폴더 0개면 note_create가 불가능하므로 필수
-- Wave 11 (migration v5, db/migrations.rs V5_SQL): ALTER TABLE folders ADD COLUMN color_hue
-- INTEGER NULL CHECK (0..359) — 폴더 아이콘 색상(owner 결정: 자유 hue 슬라이더, 고정 팔레트
-- 아님). NULL = 커스텀 색상 없음(기본). 고정 헥스를 저장하면 라이트(한지)/다크(잉크) 표면 중
-- 한쪽에서 반드시 안 보이므로, hue만 저장하고 명도/채도는 프론트가 테마별로 CSS
-- light-dark()로 도출한다(ContextMenu.tsx 색상 컨트롤 참조). V1_SQL은 이미 적용된
-- 마이그레이션이라 여기 CREATE TABLE 자체는 그대로 두고 ALTER로 추가한다.
-- folder icon key (migration v48): ALTER TABLE folders ADD COLUMN icon TEXT NULL —
-- src/lib/noteIcons.ts NOTE_ICONS[].key. NULL = 기본 폴더 글리프.
-- folder rules (migration v49): ALTER TABLE folders ADD COLUMN rules TEXT NULL —
-- 폴더 노트 AI 정리 시 상속되는 지침. 전역 메타데이터 프롬프트보다 우선. 빈/NULL = 없음.
-- Sync Phase 0 G1 (migration v24, db/migrations.rs V24_SQL): ALTER TABLE folders ADD COLUMN
-- updated_at TEXT NULL, 기존 created_at 값으로 백필 — rename/set_open/set_color(repo/folders.rs)
-- 갱신 경로가 이 컬럼을 함께 찍는다(docs/SYNC.md).
