-- Brise DDL: 노트 하위 콘텐츠 (sections = 에디터 탭, sources = 읽기 전용 원문 사료, attachments)

CREATE TABLE sections (
  id        TEXT PRIMARY KEY,
  note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,                  -- 탭 이름 (Overview, Timeline …)
  body_md   TEXT NOT NULL DEFAULT '',       -- 저장 포맷은 항상 markdown
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sections_note ON sections(note_id, position);
-- Sync Phase 0 G1 (migration v24, db/migrations.rs V24_SQL): ALTER TABLE sections ADD COLUMN
-- updated_at TEXT NULL — sections 는 created_at 컬럼 자체가 없어(생성 시각을 추적한 적이 없음)
-- 마이그레이션 적용 시각으로 백필했다(strftime('now')). repo/sections.rs::update/reorder 가
-- 갱신 시 이 컬럼을 찍는다(docs/SYNC.md).
-- Diagram sections (migration v26, db/migrations.rs V26_SQL): ALTER TABLE sections ADD COLUMN
-- kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','diagram')) — 'text' = 기존 Tiptap
-- 산문 섹션, 'diagram' = mermaid 소스 텍스트(body_md에 그대로 저장, HTML 아님 — 절대 Tiptap/
-- mdSerialize 경로를 타지 않는다). 기존 행은 DEFAULT로 조용히 'text'가 된다. 허용값은 CHECK로도
-- 막지만(방어선), 진짜 검증은 repo/sections.rs::validate_kind(AppError::Validation)가 SQL에
-- 닿기 전에 한다.
-- Sheet sections (migration v57, db/migrations.rs V57_SQL): kind CHECK 에 'sheet' 추가 —
-- SQLite 는 CHECK 를 ALTER 못하므로 테이블 재생성(V55 패턴). 'sheet' 섹션의 body_md 는
-- 시트 JSON 한 덩어리다(specs/features/sheet.md §body_md JSON 스키마 v1). FTS·마크다운
-- export·AI 컨텍스트는 이 JSON 대신 repo/sheet.rs 의 TSV/표 투영을 쓴다.
-- Section provenance (migration v67, db/migrations.rs V67_SQL): ALTER TABLE sections ADD COLUMN
-- ai_origin TEXT NULL — NULL = user-authored, otherwise the AI action id (summarize/organize/
-- translate/…) that last wrote this section's body_md. 세 갈래 쓰기 계약은
-- specs/commands/sections.yaml section_update notes 가 SSOT (docs/PLAN-2026-08-30-ai-surface-
-- and-clients.md §3 W5). 쓰는 지점은 lib/aiSectionBridge.ts::insertAiSection 한 곳.

-- Section trash (migration v79, db/migrations.rs V79_SQL — docs/PLAN-2026-09-10-section-dnd-trash.md
-- D4): 섹션 삭제(section_delete)는 행을 이 테이블로 옮긴 뒤 sections 에서 지운다. sections 에
-- deleted_at 컬럼을 두지 않는 이유는 `FROM sections` 가 Rust 에 69곳이라 필터를 하나만 빠뜨려도
-- 지운 섹션이 검색·내보내기·AI 컨텍스트에 유령으로 남기 때문 — 별도 테이블은 기존 쿼리 변경 0.
-- 복구(section_restore)는 같은 id 로 sections 에 재삽입한다(position = 그 노트 MAX+1). 노트
-- 완전 삭제는 FK CASCADE 로 여기도 비운다. 이 파일은 V1_SQL 로 include_str! 되므로(신규 설치
-- DDL) v1 이후에 생긴 테이블은 여기에 CREATE 를 적지 않는다 — 아래는 V79_SQL 의 사본이다:
--
--   CREATE TABLE section_trash (
--     id         TEXT PRIMARY KEY,
--     note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
--     name       TEXT NOT NULL,
--     body_md    TEXT NOT NULL,
--     kind       TEXT NOT NULL,
--     position   INTEGER NOT NULL,
--     ai_origin  TEXT NULL,
--     deleted_at TEXT NOT NULL
--   );
--   CREATE INDEX idx_section_trash_deleted ON section_trash(deleted_at);

CREATE TABLE sources (
  id        TEXT PRIMARY KEY,
  note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,                  -- 파일명 표기 (HUNMINJEONGEUM.txt)
  ext       TEXT NOT NULL,                  -- 표시용 확장자 (TXT, MD …)
  body      TEXT NOT NULL DEFAULT '',       -- 원문 전문 (read-only 표시)
  position  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sources_note ON sources(note_id, position);
-- Sync Phase 0 G1 (migration v24, db/migrations.rs V24_SQL): ALTER TABLE sources ADD COLUMN
-- updated_at TEXT NULL, 기존 created_at 값으로 백필 — repo/sources.rs::rename 갱신 경로가
-- 이 컬럼을 함께 찍는다(docs/SYNC.md).
-- (migration v81, db/migrations.rs V81_SQL): ALTER TABLE sources ADD COLUMN
-- truncated INTEGER NOT NULL DEFAULT 0 — 본문이 추출 상한(1MB)에 걸려 잘렸는지. 본문이 DB 에
-- 남으므로 그 사실도 행에 남는다(문구가 아니라 플래그 — 로케일은 프런트가 고른다).

-- Wave 10 (migration v4, db/migrations.rs V4_SQL): kind 에 'note'(직접 메모 .md) + 'internal'
-- (다른 노트 링크) 추가. SQLite 는 CHECK 를 ALTER 못하므로 v4 에서 테이블 재생성. link/internal 은
-- url 만, 그 외는 rel_path 만 갖는다. 아래 DDL 은 재생성 후의 최종 형태(신규 설치는 이 형태로 생성).
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Wave 4 footnotes: kind='footnote' stores body as .md (rel_path) like 'note';
  -- url holds optional anchor_text (display-only selection excerpt, NOT a navigable URL).
  kind       TEXT NOT NULL CHECK (kind IN ('image','doc','link','audio','note','internal','footnote')),
  rel_path   TEXT,        -- data_dir/attachments/{note_id}/ 하위 상대경로. link/internal 이면 NULL
  url        TEXT,        -- link URL · internal target note id · footnote anchor_text (optional)
  size_bytes INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((kind IN ('link','internal') AND url IS NOT NULL AND rel_path IS NULL)
      OR (kind = 'footnote' AND rel_path IS NOT NULL)
      OR (kind NOT IN ('link','internal','footnote') AND rel_path IS NOT NULL AND url IS NULL))
);
CREATE INDEX idx_attachments_note ON attachments(note_id, position);
-- Sync Phase 0 G4 (migration v24, db/migrations.rs V24_SQL): ALTER TABLE attachments ADD COLUMN
-- content_hash TEXT NULL — SHA-256 hex, 파일 kind(image/doc/audio/note)에만 채운다(link/internal
-- 은 파일이 없어 NULL 유지). repo/attachments.rs::add_file/add_note 가 쓰기 시점에 채우고,
-- backfill_content_hashes 가 기존 행을 부팅 후 백그라운드에서 채운다. G1 updated_at 은 이
-- 테이블에 추가하지 않는다 — attachments 는 사용자 편집 UPDATE 경로가 없다(생성 후 불변, 삭제만
-- 가능 — repo/*.rs 전수 조사 결과 "UPDATE attachments"는 dev_seed.rs 시더 전용). content_hash
-- 백필(backfill_content_hashes)만 예외로 UPDATE 를 쓰지만, 이는 기존 데이터에 대한 계산값
-- 채우기일 뿐 사용자 편집이 아니므로 updated_at 을 찍지 않는다.
-- 참조 첨부 (migration v80, db/migrations.rs V80_SQL): ADD COLUMN ext_path TEXT NULL — 앱 폴더
-- 밖 원본의 절대경로. 복사하지 않으므로 크기 상한이 없고(1GB pptx), content_hash 는 NULL 로
-- 남는다(추가 시점 해싱 금지). 파일 kind 는 rel_path 와 ext_path 중 **정확히 하나**를 갖도록
-- CHECK 가 강제한다 — SQLite 는 CHECK 를 ALTER 못하므로 v80 에서 테이블 재생성(V4/V34 패턴).
-- 실경로 해석은 repo/attachments/mod.rs::file_path_of 한 곳을 지난다.
-- 오디오 전사 (migration v93, db/migrations.rs V93_SQL): ADD COLUMN transcript TEXT NULL (전사 원문,
-- NULL=아직 없음) · transcript_inserted INTEGER NOT NULL DEFAULT 0 (본문 삽입 여부). audio_transcribe
-- (commands/audio_transcribe.rs)가 쓰고 attachment_transcript_mark_inserted 가 플래그를 올린다.
