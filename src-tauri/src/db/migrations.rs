// 스키마 마이그레이션 러너 (R4): schema_migrations 기반, 버전당 단일 트랜잭션.
// v1 DDL = specs/db/schemas/*.sql 을 include_str! 로 연결 (SSOT는 스펙 파일).
// 시드: 워크스페이스 "Histoire" + 폴더 "Notes" + 기본 설정.
use crate::error::{db, AppResult};
use crate::repo::settings_schema::default_settings;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

// 연결 순서: 테이블 생성은 SQLite에서 FK 대상이 미존재해도 허용되므로 안전.
pub const V1_SQL: &str = concat!(
    include_str!("../../../specs/db/schemas/notes.sql"),
    "\n",
    include_str!("../../../specs/db/schemas/folders.sql"),
    "\n",
    include_str!("../../../specs/db/schemas/content.sql"),
    "\n",
    include_str!("../../../specs/db/schemas/fts.sql"),
    "\n",
    include_str!("../../../specs/db/schemas/settings.sql"),
);

// Wave 3C: 벡터/시맨틱 검색 (note_embeddings) — 별도 버전으로 추가, V1과 독립.
pub const V2_SQL: &str = include_str!("../../../specs/db/schemas/vectors.sql");

// Wave 7 (P30): 워크스페이스별 연대 프리셋 — V1_SQL은 이미 적용된 마이그레이션이라
// CREATE TABLE 자체를 건드리지 않고 ALTER로 컬럼을 추가한다 (SSOT 주석: db/schemas/notes.sql).
pub const V3_SQL: &str = "ALTER TABLE workspaces ADD COLUMN timeline_preset TEXT NULL;";

// Wave 10: 첨부 kind 확장 — 'note'(직접 메모, .md 파일) + 'internal'(다른 노트 링크).
// SQLite 는 CHECK 제약을 ALTER 로 못 바꾸므로 테이블을 재생성한다(공식 권장 절차). attachments 는
// 다른 테이블이 참조하지 않는 리프라 안전하게 drop/rename 가능. SSOT: db/schemas/content.sql.
// internal 은 link 처럼 url 만 있고 rel_path 는 NULL 이므로 배타 CHECK 도 함께 갱신.
pub const V4_SQL: &str = "\
CREATE TABLE attachments_new (\n\
  id         TEXT PRIMARY KEY,\n\
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  name       TEXT NOT NULL,\n\
  kind       TEXT NOT NULL CHECK (kind IN ('image','doc','link','audio','note','internal')),\n\
  rel_path   TEXT,\n\
  url        TEXT,\n\
  size_bytes INTEGER,\n\
  position   INTEGER NOT NULL DEFAULT 0,\n\
  created_at TEXT NOT NULL,\n\
  CHECK ((kind IN ('link','internal') AND url IS NOT NULL AND rel_path IS NULL)\n\
      OR (kind NOT IN ('link','internal') AND rel_path IS NOT NULL AND url IS NULL))\n\
);\n\
INSERT INTO attachments_new (id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)\n\
  SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at FROM attachments;\n\
DROP TABLE attachments;\n\
ALTER TABLE attachments_new RENAME TO attachments;\n\
CREATE INDEX idx_attachments_note ON attachments(note_id, position);";

// Wave 11: 폴더 아이콘 색상 — 자유 hue 슬라이더(owner 결정, 고정 팔레트 아님). 라이트(한지)/
// 다크(잉크) 두 표면에서 고정 헥스 하나는 반드시 한쪽에서 안 보이므로, hue(0..359)만 저장하고
// 명도/채도는 프론트가 테마별로 CSS로 도출한다(색상.md/ContextMenu 참조). NULL = 커스텀 색상
// 없음(기본). SQLite는 ALTER로 단일 컬럼 참조 CHECK 추가를 지원한다(3.25.0+, bundled로 충족).
pub const V5_SQL: &str = "ALTER TABLE folders ADD COLUMN color_hue INTEGER NULL \
CHECK (color_hue IS NULL OR (color_hue >= 0 AND color_hue <= 359));";

// Wave 5a: 태그 색상 — 폴더 아이콘 색상(V5_SQL)과 동일하게 자유 hue(0..359) 슬라이더 저장.
// NULL = 기본/커스텀 색상 없음.
pub const V16_SQL: &str = "ALTER TABLE tags ADD COLUMN color_hue INTEGER NULL \
CHECK (color_hue IS NULL OR (color_hue >= 0 AND color_hue <= 359));";

// Wave 6a: 노트 좌표 — lat REAL NULL (-90..90), lng REAL NULL (-180..180).
// NULL = 좌표 미설정. (SSOT 주석: db/schemas/notes.sql).
pub const V17_SQL: &str = "\
ALTER TABLE notes ADD COLUMN lat REAL NULL CHECK (lat IS NULL OR (lat >= -90.0 AND lat <= 90.0));\n\
ALTER TABLE notes ADD COLUMN lng REAL NULL CHECK (lng IS NULL OR (lng >= -180.0 AND lng <= 180.0));";

// Wave 12: 사이드바 필터 스트립 개편 — "Décennie" 대신 "Région". 지역은 태그와 달리 노트당
// 정확히 하나의 값을 갖는 1급 필드로 결정(owner). 자유 텍스트(TEXT NULL) — 프리셋별 지역
// 목록(src/lib/eras.ts)은 UI가 보여주는 선택지일 뿐, DB에는 제약을 걸지 않는다(사용자가
// 프리셋에 없는 지역명을 적어도 허용). V1_SQL은 이미 적용된 마이그레이션이라 여기
// CREATE TABLE 자체는 그대로 두고 ALTER로 추가한다 (SSOT 주석: db/schemas/notes.sql).
pub const V6_SQL: &str = "ALTER TABLE notes ADD COLUMN region TEXT NULL;";

// Wave 13: 워크스페이스 배경 이미지 — 좌상단 워크스페이스 스위처는 노트 컬렉션의 "이름"이므로
// 사용자가 배경 이미지를 지정할 수 있어야 한다(owner 결정). 첨부(attachments)와 동일한 스트리밍
// 복사 패턴으로 data_dir/workspace_bg/{workspace_id}/ 에 저장하고, 그 디렉토리 기준 상대경로만
// 저장한다(repo/workspaces.rs::set_bg_image). V1_SQL은 이미 적용된 마이그레이션이라 CREATE TABLE
// 자체는 건드리지 않고 ALTER로 추가한다 (SSOT 주석: db/schemas/notes.sql 패턴과 동일).
pub const V7_SQL: &str = "ALTER TABLE workspaces ADD COLUMN bg_image_path TEXT NULL;";

// Wave 14: 사용자 확장형 지역/시대 — Région 필터·시대 프리셋의 지역/연대 목록이 src/lib/eras.ts
// 에 하드코딩된 고정 세트라 사용자가 새 지역명·시대구간을 추가할 수 없었다(owner 요청: "지역태그는
// 사용자가 추가할수있도록 해야하고, 연도도 마찬가지로 사용자가 추가할수있어야함"). 이 두 테이블은
// 사용자가 "추가한" 항목만 담는다 — 내장 프리셋(korea/france)의 목록은 여전히 eras.ts 상수이고
// DB에 없다(프론트가 두 출처를 합쳐 렌더링하고, 삭제 버튼은 이 테이블 유래 행에만 보여준다).
// 워크스페이스 스코프로 결정한 이유: workspaces.timeline_preset(v3)이 이미 "역사적 맥락은
// 워크스페이스마다 다르다"는 전제로 설계되어 있고(예: 한국사 워크스페이스 vs 프랑스사
// 워크스페이스), 전역으로 두면 한 워크스페이스에서 추가한 지역이 무관한 다른 워크스페이스의
// Région 스트립에도 새어나가 지금 있는 "프랑스사 지역이 한국사 워크스페이스에 뜬다" 버그와
// 같은 종류의 혼란을 재생산한다. 워크스페이스 삭제 시 그 워크스페이스가 추가한 지역/시대도
// 함께 사라져야 하므로 ON DELETE CASCADE. name 은 COLLATE NOCASE 로 대소문자 무시 중복 방지
// (tags 테이블과 동일 관례) — UNIQUE(workspace_id, name) 인덱스가 이 컬럼 콜레이션을 그대로
// 물려받는다. eras 는 notes.year 와 동일한 유효 범위(-9999..9999, notes.sql CHECK)를 커맨드
// 계층에서 검증하고, to_year > from_year 는 DB CHECK로 고정한다.
pub const V8_SQL: &str = "\
CREATE TABLE workspace_regions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL COLLATE NOCASE,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX idx_workspace_regions_ws ON workspace_regions(workspace_id, position);
CREATE TABLE workspace_eras (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  from_year    INTEGER NOT NULL,
  to_year      INTEGER NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  CHECK (to_year > from_year)
);
CREATE INDEX idx_workspace_eras_ws ON workspace_eras(workspace_id, position);";

// Wave 15: 노트 진행 상태(status) — 타이틀바 재구성 + "작성중/내보냄/완료" 3종 내장 상태.
// 내장 상태는 코드 상수(src/lib/status.ts BUILT_IN_STATUSES, repo::taxonomy::BUILT_IN_STATUSES)
// 로만 존재하고 DB에 행을 두지 않는다 — "내장 상태는 삭제 불가"를 애초에 지울 행이 없는 것으로
// 자연히 만족시킨다(workspace_regions/workspace_eras 와 동일 설계). notes.status 는 내장 상태
// 키(문자열) 또는 workspace_statuses.id 를 담는 자유 TEXT 컬럼 — 두 종류가 섞이므로 FK 제약은
// 걸지 않고 커맨드 계층(repo/notes.rs::set_status, repo/taxonomy.rs::validate_status_for_workspace)
// 에서 검증한다. NULL = 상태 없음(기본값, 빈 렌더링 — owner 요구사항). workspace_statuses 는
// "검색필터쪽에서 추가할 수 있게" 요구사항에 따른 사용자 확장 목록 — workspace_regions(v8)와
// 완전히 동일한 모양(워크스페이스 스코프, position 정렬, COLLATE NOCASE 대소문자 무시 중복 방지,
// 워크스페이스 삭제 시 CASCADE). V1_SQL은 이미 적용된 마이그레이션이라 CREATE TABLE 자체는
// 건드리지 않고 여기서 ALTER/CREATE로 추가한다 (SSOT 주석: db/schemas/notes.sql).
pub const V9_SQL: &str = "\
ALTER TABLE notes ADD COLUMN status TEXT NULL;\n\
CREATE TABLE workspace_statuses (\n\
  id           TEXT PRIMARY KEY,\n\
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\n\
  name         TEXT NOT NULL COLLATE NOCASE,\n\
  position     INTEGER NOT NULL DEFAULT 0,\n\
  created_at   TEXT NOT NULL,\n\
  UNIQUE(workspace_id, name)\n\
);\n\
CREATE INDEX idx_workspace_statuses_ws ON workspace_statuses(workspace_id, position);";

// Wave 16 (P1 버그 수정 — R8 확장): FTS5 unicode61 토크나이저는 공백으로 구분된 CJK 어절을
// 통짜 토큰 하나로 취급해 어절 중간/끝 부분 문자열을 못 찾는다(예: 본문에 "세종대왕"이 있어도
// "종대"로 검색하면 미매치 — 기존 R8 LIKE 폴백도 title/tag만 커버해 본문 매치를 놓쳤다. 히스토리
// 노트 앱에서 "분명히 적어놨는데 검색이 안 된다"는 크래시보다 나쁜 조용한 재현율 손실이다).
// trigram 토크나이저(SQLite 3.34+, bundled libsqlite3-sys 3.53.2로 충족 — Cargo.lock 확인)로
// 전환: 3글자(코드포인트) 시퀀스 단위 인덱싱이라 CJK/Latin 관계없이 어절 어디서든 부분 문자열
// 매치가 된다. FTS5 가상 테이블은 토크나이저를 ALTER로 못 바꾸므로 drop 후 재생성 + 기존
// notes 전체에서 재집계한다 — 집계 쿼리는 repo/fts.rs::fts_upsert와 동일 로직(note_id 필터만
// 제거한 벌크 버전)이라 마이그레이션 후 색인이 레포 계층이 이후에 쓰는 형태와 정확히 일치한다.
// SSOT: specs/db/schemas/fts.sql(신규 설치 V1_SQL도 동일하게 trigram으로 갱신됨).
pub const V10_SQL: &str = "\
DROP TABLE notes_fts;\n\
CREATE VIRTUAL TABLE notes_fts USING fts5(\n\
  note_id UNINDEXED,\n\
  title,\n\
  body,\n\
  source_body,\n\
  tag_names,\n\
  tokenize = 'trigram case_sensitive 0'\n\
);\n\
INSERT INTO notes_fts(note_id, title, body, source_body, tag_names)\n\
SELECT n.id, n.title,\n\
  COALESCE((SELECT group_concat(s.body_md, char(10)||char(10)) FROM sections s\n\
            WHERE s.note_id=n.id ORDER BY s.position), ''),\n\
  COALESCE((SELECT group_concat(o.body, char(10)||char(10)) FROM sources o\n\
            WHERE o.note_id=n.id ORDER BY o.position), ''),\n\
  COALESCE((SELECT group_concat(t.name, ' ') FROM tags t\n\
            JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=n.id), '')\n\
FROM notes n;";

// 워크스페이스/노트 아이콘 — 좌상단 스위처(노트 모음의 정체성)와 트리 행의 아이콘을 사용자가
// 큐레이션 팔레트에서 바꿀 수 있게 한다(owner 요청). NULL = 기본 아이콘 폴백(워크스페이스=그리드,
// 노트=note). 저장값은 아이콘 키 문자열(src/lib/noteIcons.ts NOTE_ICONS[].key). folder color_hue(V5)
// 와 동일하게 순수 표현 데이터라 테마 무관, 단일 값으로 저장 가능. V1_SQL은 이미 적용된
// 마이그레이션이라 CREATE TABLE 자체는 건드리지 않고 ALTER로만 추가한다.
pub const V11_SQL: &str = "\
ALTER TABLE workspaces ADD COLUMN icon TEXT NULL;\n\
ALTER TABLE notes ADD COLUMN icon TEXT NULL;";

// Trash(휴지통) — 노트 삭제를 즉시 영구 삭제 대신 소프트 삭제(복구 가능)로 바꾼다(owner 요청).
// deleted_at IS NULL = 정상 노트, NOT NULL = 휴지통에 있는 노트(ISO8601, 삭제 시각). 목록/검색/
// 관련노트/벡터 재색인 등 "노출" 경로는 전부 deleted_at IS NULL 을 추가로 걸어 휴지통 노트가
// 새어나가지 않게 한다(repo/notes.rs::delete/restore/purge/trash_list, repo/folders.rs,
// repo/search.rs, repo/vector.rs, repo/workspaces.rs 참조) — 단, 단일 노트 조회(note_summary/
// note_detail)는 의도적으로 필터하지 않는다: 휴지통 화면이 개별 노트를 여전히 불러와야 한다.
// repo/attachments.rs::orphan_cleanup 도 의도적으로 건드리지 않는다 — 그 함수는 notes 행의
// 존재 자체로 첨부 디렉토리 보존 여부를 결정하므로, 소프트 삭제된 노트(행은 살아있음)의 첨부는
// 자동으로 보존된다. V1_SQL은 이미 적용된 마이그레이션이라 CREATE TABLE 자체는 건드리지 않고
// ALTER로만 추가한다 (SSOT 주석: db/schemas/notes.sql).
pub const V12_SQL: &str = "ALTER TABLE notes ADD COLUMN deleted_at TEXT NULL;";

// Scale Phase 1: note_tags 역방향 인덱스 — PK(note_id, tag_id) 만 있으면 "이 태그를 단 노트" 쪽
// 조회(tag_counts GROUP BY, related 공유 태그 등)가 tag_id 로 스캔한다. tag_id 선행 인덱스로
// tags → note_tags 조인을 가속. SSOT 주석: db/schemas/notes.sql.
pub const V13_SQL: &str =
    "CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);";

// Scale Phase 1 (F13, 보수적): notes(status) / notes(region) 인덱스.
//
// WHY now (and why this does NOT speed up today's UI):
// - UI는 단일 워크스페이스만 노출 → workspace_id 술어는 사실상 전 코퍼스를 매치한다
//   (docs/SCALABILITY.md). 그래서 "workspace_id + status" 복합 인덱스 이득도 제한적이다.
// - 현재 status/region 필터는 클라가 notesByFolder 를 메모리에서 걸러 쓰므로 SQLite 가 이
//   인덱스를 전혀 타지 않는다. folder_list 는 이미 경량 요약 경로(566ms/100k)라 여기서
//   서버 필터를 끼우면 UX/IPC 계약 변경이 따른다.
// - 이 마이그레이션은 **미래 서버사이드 필터 이관** 을 위한 선제 인프라다. 풀 이관
//   (SearchStore status/region → folder_list/search IPC 파라미터) 은 별도 사용자 승인 항목
//   — 본 커밋 범위 밖. SSOT 주석: db/schemas/notes.sql.
pub const V14_SQL: &str = "\
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);\n\
CREATE INDEX IF NOT EXISTS idx_notes_region ON notes(region);";

// Bug fix (mica→acrylic 리네임 후속, 2026-07-24): 기존 사용자 DB의 레거시 mica_alpha 값을
// sheet_alpha 로 이관한다. 배경: default_settings()/validate_setting 은 이미 sheet_alpha 로
// 리네임됐지만(surface_style/sheet_alpha 리네임 커밋), 이 이관 없이는 사용자가 실제로 골랐던
// 불투명도(mica_alpha)가 영원히 묻힌다 — repo::settings::get_all()이 매 부팅마다 settings 테이블
// 조회 전에 default_settings()로 map을 미리 채우는데, 그 기본값에 이미 "sheet_alpha":0.85 가
// 들어 있어(키 이름이 존재 자체를 리네임했으므로) 프런트의 `sheet_alpha ?? mica_alpha` 폴백이
// 절대 발동하지 않는다(sheet_alpha 가 항상 0.85 로 "존재"하기 때문에 ?? 가 mica_alpha 까지 못
// 간다) — 실사용자 DB(마이카 알파 1.0 저장)에서 실측된 결함. `seed()`(신규 워크스페이스 최초
// 생성시 1회, ws_count==0 게이트)는 이미 워크스페이스가 있는 기존 DB에는 적용되지 않으므로 이
// 이관은 반드시 버전 마이그레이션(schema_migrations 게이트, 매 부팅 apply() 경로 — DB가 있든
// 없든 정확히 1회)으로 둬야 한다. INSERT OR IGNORE 라 이미 sheet_alpha 가 있으면(신규 설치처럼
// mica_alpha 가 애초에 없거나, 사용자가 이미 acrylic 패널에서 값을 저장했으면) 아무 일도
// 일어나지 않는다 — mica_alpha 자체는 지우지 않는다(참고용으로 남겨도 안전, validate_setting
// 이 더 이상 그 키를 받지 않으므로 재저장될 일이 없다).
//
// surface_style 은 이 이관이 필요 없다 — 키 이름 자체는 안 바뀌었고(리네임된 건 값 "mica"→
// "acrylic"), 저장된 실제 값이 있으면 get_all()의 "저장된 값으로 덮어쓰기" 단계가 그 값
// ("mica")으로 default_settings()의 기본값("flat")을 정확히 덮어쓴다 — 그리고 프런트 load()가
// 그 값을 읽어 "mica"→"acrylic"으로 매핑한다(settings.ts). 즉 default_settings()의 임시값이
// 실제 저장값을 가리는 지점이 없다 — sheet_alpha 버그는 "키 이름 자체가 바뀌어서 새 키의
// 기본값이 옛 키를 가린다"는 것이 핵심이라 값만 바뀐 surface_style에는 적용되지 않는다.
pub const V15_SQL: &str = "\
INSERT OR IGNORE INTO settings(key, value)
  SELECT 'sheet_alpha', value FROM settings WHERE key = 'mica_alpha';";

// Wave 9: AI 히스토리 — 워크스페이스별 past AI requests 및 results 저장.
pub const V18_SQL: &str = "\
CREATE TABLE ai_history (\n\
  id              TEXT PRIMARY KEY,\n\
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\n\
  note_id         TEXT,\n\
  action_type     TEXT NOT NULL,\n\
  prompt_or_input TEXT,\n\
  result_text     TEXT NOT NULL,\n\
  created_at      TEXT NOT NULL\n\
);\n\
CREATE INDEX idx_ai_history_ws ON ai_history(workspace_id, created_at);";

// Scale: note_query / server-side filter axes — partial indexes so year/favourite/trash scans
// skip soft-deleted rows and avoid the planner's folder-join path (SEARCH f → SEARCH n via
// idx_notes_folder → temp B-tree sort, ~500ms at 100k). Combined with note_query's rewrite
// (drive from notes year/favourite predicates first; workspace via folder_id IN subquery)
// year range drops to a few ms. idx_note_tags_tag_note is covering for tag OR filters
// (later waves). idx_notes_deleted makes the trash badge COUNT cheap even when empty
// (folder-join of deleted_at IS NOT NULL was ~500ms at 100k with zero trash rows).
// SSOT 주석: specs/db/schemas/notes.sql.
pub const V19_SQL: &str = "\
CREATE INDEX IF NOT EXISTS idx_notes_year_alive ON notes(year) WHERE deleted_at IS NULL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_favorite_year_alive ON notes(is_favorite, year) WHERE deleted_at IS NULL;\n\
CREATE INDEX IF NOT EXISTS idx_note_tags_tag_note ON note_tags(tag_id, note_id);\n\
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at) WHERE deleted_at IS NOT NULL;\n\
ANALYZE notes;\n\
ANALYZE note_tags;\n\
ANALYZE folders;";

// Scale note_query bbox axis (Wave A-3): live rows with coordinates. Map views query a
// viewport box rather than every located note (unbounded markers regressed to 33k SVGs).
// Partial so soft-deleted / unlocated rows stay out of the leaf set.
// SSOT 주석: specs/db/schemas/notes.sql.
pub const V20_SQL: &str = "\
CREATE INDEX IF NOT EXISTS idx_notes_geo_alive ON notes(lat, lng) \
  WHERE deleted_at IS NULL AND lat IS NOT NULL AND lng IS NOT NULL;\n\
ANALYZE notes;";

// Gallery: bounded attachment_query pages by kind/created_at. idx_attachments_kind_created
// covers type-filtered pages; idx_attachments_created covers the unfiltered (all non-internal)
// page. Do NOT append ANALYZE — V19/V20 wrote zero-row sqlite_stat1 on fresh installs and the
// planner then preferred those indexes as free inner loops (measured 63s vs 122ms).
// scrub_zero_row_stats cleans legacy bad stats at boot; do not add a new source.
pub const V21_SQL: &str = "\
CREATE INDEX IF NOT EXISTS idx_attachments_kind_created ON attachments(kind, created_at);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);";

// Calendar (record axis): notes(updated_at)/notes(created_at) had no index at all — a calendar
// grid count query (note_record_histogram) would scan. Partial on deleted_at IS NULL so trash
// stays out of the leaf set, same shape as idx_notes_year_alive (V19). Both columns get an index
// because the calendar's created-date toggle queries the same way on the other column.
// Do NOT append ANALYZE — see the V21 comment above (zero-row sqlite_stat1 regression).
// SSOT 주석: specs/db/schemas/notes.sql.
pub const V22_SQL: &str = "\
CREATE INDEX IF NOT EXISTS idx_notes_updated_alive ON notes(updated_at) WHERE deleted_at IS NULL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_created_alive ON notes(created_at) WHERE deleted_at IS NULL;";

// §2.3 HANDOFF-calendar-onboarding.md: event-axis precision. `year` stays NOT NULL; `month`/`day`
// are nullable and encode precision by absence — year-only / year+month / year+month+day. No
// separate precision column (redundant with "is this column null"). day-without-month is rejected
// at the app layer (repo::notes::set_event_precision), not here — SQLite ALTER TABLE ADD COLUMN
// cannot add a cross-column CHECK against an existing table's rows.
pub const V23_SQL: &str = "\
ALTER TABLE notes ADD COLUMN month INTEGER NULL CHECK (month IS NULL OR (month >= 1 AND month <= 12));\n\
ALTER TABLE notes ADD COLUMN day INTEGER NULL CHECK (day IS NULL OR (day >= 1 AND day <= 31));";

// docs/SYNC.md Phase 0 (sync-readiness, 서버 0원 선행 작업) — G1/G2/G4:
// G1 — updated_at: repo/*.rs 전수 조사(실제 "UPDATE <table>" 문 서베이) 결과, notes(이미 있음)
// 를 빼고 실제로 UPDATE 경로가 있는 테이블은 sections/sources/tags/folders/workspaces 다.
// attachments/workspace_regions/workspace_eras/workspace_statuses 는 INSERT+DELETE만 있고
// (생성 후 불변) 열 갱신 경로가 없어 제외했다 — G2 tombstone이 삭제 전파를 이미 커버한다.
// sections/tags 는 created_at 컬럼 자체가 없어(설계상 생성 시각을 추적한 적이 없다) 이
// 마이그레이션 적용 시각(strftime('now'))으로 백필한다 — 기존 행의 "진짜" 생성 시각을 복원할
// 방법이 없으므로 최선의 근사치. SSOT 주석: db/schemas/notes.sql(tags/workspaces),
// db/schemas/folders.sql, db/schemas/content.sql(sections/sources/attachments).
//
// G2 — 범용 tombstone: deleted_rows(tbl, id, deleted_at). 캐스케이드 규칙(직접 삭제한 엔티티만
// 기록, ON DELETE CASCADE 로 함께 지워지는 자식 행은 부모 tombstone 으로 암시)은
// repo/tombstone.rs::record_tombstone 주석 참조.
//
// G4 — 첨부 내용 해시: attachments.content_hash(SHA-256 hex). link/internal 은 파일이 없어
// NULL 유지. 기존 행 백필은 repo/attachments.rs::backfill_content_hashes(부팅 후 백그라운드
// 스레드, db/mod.rs::bootstrap).
pub const V24_SQL: &str = "\
ALTER TABLE sections ADD COLUMN updated_at TEXT NULL;\n\
ALTER TABLE sources ADD COLUMN updated_at TEXT NULL;\n\
ALTER TABLE tags ADD COLUMN updated_at TEXT NULL;\n\
ALTER TABLE folders ADD COLUMN updated_at TEXT NULL;\n\
ALTER TABLE workspaces ADD COLUMN updated_at TEXT NULL;\n\
UPDATE sources SET updated_at = created_at;\n\
UPDATE folders SET updated_at = created_at;\n\
UPDATE workspaces SET updated_at = created_at;\n\
UPDATE sections SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');\n\
UPDATE tags SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');\n\
CREATE TABLE deleted_rows (\n\
  tbl        TEXT NOT NULL,\n\
  id         TEXT NOT NULL,\n\
  deleted_at TEXT NOT NULL,\n\
  PRIMARY KEY (tbl, id)\n\
);\n\
ALTER TABLE attachments ADD COLUMN content_hash TEXT NULL;";

// 시맨틱/임베딩 검색 서브시스템 제거(owner decision) — note_embeddings 테이블(V2_SQL 생성)을
// 드롭한다. V2_SQL 자체는 히스토리로 남긴다(과거 DB가 V2에서 이 테이블을 만들었던 사실은
// 지우지 않는다 — additive 마이그레이션 컨벤션, migrations.rs 파일 서두 참고). IF EXISTS 라
// V2를 이미 거친 기존 DB와, 처음부터 V1..V25를 한 번에 다 적용하는 신규 DB(테이블이 존재한
// 적조차 없음) 양쪽에서 안전하다.
pub const V25_SQL: &str = "DROP TABLE IF EXISTS note_embeddings;";

// Diagram sections (mermaid-based 순서/위계 뷰, owner-confirmed) — sections gain an explicit
// `kind` discriminator so EditorPanel can pick Tiptap prose vs. a mermaid renderer per tab
// (db/schemas/content.sql SSOT comment). DEFAULT 'text' backfills every pre-existing row silently
// (SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT applies it to existing rows, not just
// future inserts). CHECK is defense-in-depth only — SQLite does not retroactively validate it
// against pre-existing rows on ADD COLUMN (same as V23's month/day CHECKs), and it's satisfied
// here anyway since every backfilled row gets the literal 'text'. The real gate for bad input is
// repo::sections::validate_kind (AppError::Validation, not a DB-layer CHECK failure) — a CHECK
// alone can't be the only guard because a rejected write from the repo layer must not even reach
// SQL, let alone surface as a raw DB error.
pub const V26_SQL: &str =
    "ALTER TABLE sections ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','diagram'));";

// Wave 4: 자동 연관노트 해제 (note_related_exclusions) 및 다중 지역 (note_regions)
pub const V27_SQL: &str = "\
CREATE TABLE note_related_exclusions (\n\
  id_1 TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  id_2 TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  created_at TEXT NOT NULL,\n\
  PRIMARY KEY (id_1, id_2)\n\
);\n\
CREATE INDEX idx_note_related_exclusions_1 ON note_related_exclusions(id_1);\n\
CREATE INDEX idx_note_related_exclusions_2 ON note_related_exclusions(id_2);\n\
CREATE TABLE note_regions (\n\
  id TEXT PRIMARY KEY,\n\
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  name TEXT NOT NULL,\n\
  lat REAL NOT NULL CHECK (lat >= -90.0 AND lat <= 90.0),\n\
  lng REAL NOT NULL CHECK (lng >= -180.0 AND lng <= 180.0),\n\
  position INTEGER NOT NULL,\n\
  created_at TEXT NOT NULL\n\
);\n\
CREATE INDEX idx_note_regions_note_id ON note_regions(note_id);";

// Dashboard Wave 1 (docs/DASHBOARD.md §2): notes.due_at (마감 축, ISO date "YYYY-MM-DD") +
// notes.end_year/end_month/end_day (사건 축 기간 종료). month/day 와 동일하게 단일 컬럼 범위 CHECK
// 만 두고, cross-column 불변식(end_day ⇒ end_month, end_month ⇒ end_year, start ≤ end) 은
// repo::notes::set_due / set_event_end / set_event_precision 이 강제한다 — SQLite ALTER TABLE
// ADD COLUMN 으로는 기존 테이블에 교차 컬럼 CHECK 를 붙일 수 없다 (V23 과 동일 관례).
// SSOT 주석: specs/db/schemas/notes.sql.
pub const V28_SQL: &str = "\
ALTER TABLE notes ADD COLUMN due_at TEXT NULL;\n\
ALTER TABLE notes ADD COLUMN end_year INTEGER NULL CHECK (end_year IS NULL OR (end_year >= -9999 AND end_year <= 9999));\n\
ALTER TABLE notes ADD COLUMN end_month INTEGER NULL CHECK (end_month IS NULL OR (end_month >= 1 AND end_month <= 12));\n\
ALTER TABLE notes ADD COLUMN end_day INTEGER NULL CHECK (end_day IS NULL OR (end_day >= 1 AND end_day <= 31));";

// Dashboard Wave 2 (docs/DASHBOARD.md §2, 2026-08-01 오너 결정): 마감(due_at) 축 폐지 — "기간의
// 끝 = 처리 기한", 같은 개념을 두 필드로 들고 있지 않는다. due_at 이 있던 노트를
// end_year/end_month/end_day 로 흡수한 뒤 컬럼 자체를 드롭한다:
//   ① end_* 가 비어 있으면(end_year IS NULL) due_at(YYYY-MM-DD)를 그대로 end 트리플로 옮긴다.
//   ② end_* 가 이미 있으면(과거 사건의 실제 종료) 역사적 종료가 우선 — due_at 은 버린다.
//   ③ 이관 후 start(year/month/day)가 새 end 보다 뒤라면(예: due_at 이 아주 오래된 사건 노트에
//      얹혀 있던 경우) end⇒start 불변식을 지키기 위해 start 도 같은 날짜로 당긴다 — 정밀도
//      누락은 "가장 이름"(0)으로 취급하는 repo::notes::assert_start_not_after_end 의 비교 규칙을
//      SQL로 그대로 옮긴 것. notes.year 는 NOT NULL(CHECK, notes.sql)이라 "시작이 아예 없는"
//      문자 그대로의 케이스는 스키마상 존재할 수 없다 — ③이 그 취지(고아가 된 due 이관이 시작을
//      역전하지 않게)를 대신한다.
// due_at 은 히스토리 컬럼으로 남기지 않고 완전히 사라진다: 이 프로젝트의 rusqlite(bundled
// libsqlite3-sys 0.38.1, Cargo.lock)는 SQLite 3.35(2021, DROP COLUMN 지원 버전)를 한참 상회하고,
// due_at 은 인덱스도 CHECK도 트리거도 걸려 있지 않아(V28_SQL 참고 — 컬럼 CHECK는 end_* 뿐)
// SQLite의 DROP COLUMN 거부 조건(WITHOUT ROWID/컬럼 CHECK/인덱스/PK/FK/generated 컬럼 참조) 중
// 어느 것에도 걸리지 않는다.
pub const V29_SQL: &str = "\
UPDATE notes SET\n\
  end_year  = CAST(substr(due_at,1,4) AS INTEGER),\n\
  end_month = CAST(substr(due_at,6,2) AS INTEGER),\n\
  end_day   = CAST(substr(due_at,9,2) AS INTEGER)\n\
WHERE due_at IS NOT NULL AND length(due_at) = 10 AND end_year IS NULL;\n\
UPDATE notes SET\n\
  year = end_year, month = end_month, day = end_day\n\
WHERE due_at IS NOT NULL AND length(due_at) = 10\n\
  AND end_year  = CAST(substr(due_at,1,4) AS INTEGER)\n\
  AND end_month = CAST(substr(due_at,6,2) AS INTEGER)\n\
  AND end_day   = CAST(substr(due_at,9,2) AS INTEGER)\n\
  AND (year > end_year\n\
       OR (year = end_year AND COALESCE(month, 0) > end_month)\n\
       OR (year = end_year AND COALESCE(month, 0) = end_month AND COALESCE(day, 0) > end_day));\n\
ALTER TABLE notes DROP COLUMN due_at;";

// Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01 오너 결정): 마감/긴급도 모델 전면 폐지 —
// 노트의 날짜는 중립 기록 정보다("과거 날짜"는 정상이지 "지남"이 아니다). 대신 노트별 명시
// opt-in 플래그 "알려줘"(remind) 하나만 둔다: 이 플래그가 켜져 있고 종료일(end_*)이 풀 정밀도로
// 오늘보다 과거일 때만 그 노트가 칸반 컬럼 안에서 맨 위로 뜨고 모서리에 작은 빨간 점이 붙는다
// (완료 컬럼은 예외 — repo::dashboard 참조). 날짜가 없으면 플래그는 아무 효과가 없다(그냥
// 저장된 불리언, 조용히 무시). NOT NULL DEFAULT 0 이라 기존 노트는 전부 꺼진 채로 시작한다.
pub const V30_SQL: &str = "ALTER TABLE notes ADD COLUMN remind INTEGER NOT NULL DEFAULT 0 CHECK (remind IN (0,1));";

// Editor autosave snapshots (owner spec, 2026-08-01): "에디터에 1분마다 스냅샷처럼 자동저장하고
// 30분은 저장되도록" — a rolling local working cache, not a version history feature. payload is a
// JSON array of {section_id, title, kind, body_md} captured from repo::sections::load_for_note at
// snapshot time (repo/snapshots.rs). One row per capture; repo::snapshots::capture prunes rows
// older than 30 minutes for that note in the same call (no background job/timer on the Rust side —
// the 60s cadence lives entirely in the frontend scheduler, stores/notes.ts). Device-local scratch
// cache, like a lint cache: deliberately excluded from export_all/export_folder_bundle
// (brise-bundle.json only ever walks notes→sections/sources/attachments, never this table — see
// specs/commands/export.yaml) and from the sync HTTP surface (every note_snapshot_* command below
// is http:false, specs/commands/snapshots.yaml). backup_create's byte-exact zip (repo/transfer/
// backup.rs) still carries it along for free (whole-DB file copy) — harmless, it's still this
// device's own cache after a restore. ON DELETE CASCADE — a note's snapshots have no meaning once
// the note itself is gone (mirrors sections/sources/attachments, db/schemas/content.sql).
pub const V31_SQL: &str = "\
CREATE TABLE note_snapshots (
  id       TEXT PRIMARY KEY,
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL,
  payload  TEXT NOT NULL
);
CREATE INDEX idx_note_snapshots_note_taken ON note_snapshots(note_id, taken_at);";

// QA8 1D (2026-08): factory default map zoom raised country/wide k=50 → city-scale k=150
// (~2.4° lon; city labels visible at k≥32). Existing installs that ever saved default_map_location
// kept zoom:50 permanently (MapSection only writes lat/lng). Raise zoom only when strictly below
// the new factory default — never touch lat/lng (user-chosen). json_set preserves other keys.
// Matches frontend FACTORY_DEFAULT_MAP_ZOOM in src/stores/settings.ts.
pub const V32_DEFAULT_MAP_CITY_ZOOM: f64 = 150.0;
pub const V32_SQL: &str = "\
UPDATE settings
SET value = json_set(value, '$.zoom', 150.0)
WHERE key = 'default_map_location'
  AND json_valid(value)
  AND json_type(json_extract(value, '$.zoom')) IN ('integer', 'real')
  AND CAST(json_extract(value, '$.zoom') AS REAL) < 150.0;";

// QA8 Wave 4A (2026-08): device-local activity audit trail — note create/delete/edit/restore/
// import events. Deliberately NOT an extension of note_snapshots: that table is ON DELETE CASCADE
// on notes(id), so a delete event row would vanish with the note (self-contradiction). Shape
// mirrors ai_history (workspace_id FK CASCADE, note_id nullable with NO FK) so delete events
// survive note purge. Retention: 7 days OR 2000 rows per workspace, whichever first — enforced
// on every insert in the same transaction (repo/activity.rs, ACTIVITY_RETENTION_DAYS /
// ACTIVITY_MAX_ROWS). Device-local like note_snapshots: never added to export column lists
// (repo/transfer/export.rs walks notes→sections/sources/attachments only; this table is never
// referenced there) and every activity_* command is http:false (specs/commands/activity.yaml).
// "Reopen closed tab" is a separate settings kv (recent_closed_tabs), not mixed into this table.
pub const V33_SQL: &str = "\
CREATE TABLE activity_log (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id      TEXT,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_activity_log_ws_created ON activity_log(workspace_id, created_at);";

// Wave 4 footnotes: kind='footnote' + optional url (anchor_text display hint). SQLite cannot
// ALTER a CHECK, so rebuild attachments (same approach as V4). Preserve content_hash (V24).
// SSOT: specs/db/schemas/content.sql.
pub const V34_SQL: &str = "\
CREATE TABLE attachments_new (\n\
  id         TEXT PRIMARY KEY,\n\
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  name       TEXT NOT NULL,\n\
  kind       TEXT NOT NULL CHECK (kind IN ('image','doc','link','audio','note','internal','footnote')),\n\
  rel_path   TEXT,\n\
  url        TEXT,\n\
  size_bytes INTEGER,\n\
  position   INTEGER NOT NULL DEFAULT 0,\n\
  created_at TEXT NOT NULL,\n\
  content_hash TEXT NULL,\n\
  CHECK ((kind IN ('link','internal') AND url IS NOT NULL AND rel_path IS NULL)\n\
      OR (kind = 'footnote' AND rel_path IS NOT NULL)\n\
      OR (kind NOT IN ('link','internal','footnote') AND rel_path IS NOT NULL AND url IS NULL))\n\
);\n\
INSERT INTO attachments_new (id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)\n\
  SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash FROM attachments;\n\
DROP TABLE attachments;\n\
ALTER TABLE attachments_new RENAME TO attachments;\n\
CREATE INDEX idx_attachments_note ON attachments(note_id, position);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_kind_created ON attachments(kind, created_at);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);";

// W6-d2 펫 채팅 히스토리. 기존 ai_history 를 재사용하지 않은 이유 두 가지:
// (1) ai_history 는 워크스페이스당 50행 캡을 **모든 action_type 에 걸쳐** 걸므로, 펫 대화 몇 번이면
//     설정 화면의 AI 히스토리(ai_get_history → stores/ai.ts)가 통째로 밀려난다 — 서로 다른 두
//     기능이 한 캡을 나눠 쓰면 둘 다 못 쓴다.
// (2) 대화는 turn 순서가 곧 의미다. ai_history 의 정렬 키는 created_at(ms) 하나뿐이라 같은
//     밀리초에 들어온 두 턴의 순서가 미정이다 — 여기서는 created_at + rowid 로 안정 정렬한다.
// device-local(activity_log/note_snapshots 와 같은 부류): export 컬럼 목록에 넣지 않고
// (repo/transfer/export.rs 는 notes→sections/sources/attachments 만 훑는다) 모든 pet_* 커맨드는
// http:false 다(specs/commands/pet.yaml).
pub const V35_SQL: &str = "\
CREATE TABLE pet_messages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_pet_messages_ws_created ON pet_messages(workspace_id, created_at);";

// W7-f: 아카이브 — deleted_at(Trash, V12)과 나란한 두 번째 소프트 상태. 오너가 결정한 핵심
// 차이: 아카이브는 "보이지 않지만 찾으면 나온다" — 트리/대시보드(보드·달력·타임라인)에서는
// 숨기지만 FTS 색인은 그대로 둬(delete()의 fts_delete 호출을 archive()는 하지 않는다) 검색으로는
// 여전히 잡힌다(휴지통은 정반대 — fts_delete로 검색에서도 사라진다). archived_at IS NULL = 보임,
// NOT NULL(ISO8601) = 아카이브된 시각. repo::notes::archive/unarchive/archived_list/
// archived_count 가 delete/restore/trash_list/trash_count 를 그대로 본떴다. 노출 경로 8-10곳
// (note_query, folders::list, dashboard::{timeline,calendar,board}, note_tags::{tag_counts,
// tag_colors}, attachment_query::gallery_sql)에 archived_at IS NULL 을 추가로 걸었다 — search.rs는
// 의도적으로 제외(검색은 아카이브를 계속 반환해야 계약이 성립한다). idx_notes_archived 는
// idx_notes_deleted(V19)와 동일한 이유(카운트 배지가 폴더-조인 풀스캔을 피하게) 로 둔다.
// SSOT 주석: specs/db/schemas/notes.sql.
pub const V36_SQL: &str = "\
ALTER TABLE notes ADD COLUMN archived_at TEXT NULL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived_at) WHERE archived_at IS NOT NULL;";

// close_to_tray 부활(2026-08-06): 이 키는 opt-in 시절(당시 기본값 false)에 프레시 설치 seed()가
// 이미 'false' 로 써놨다 — 이후 기본값을 true 로 뒤집어도(settings_schema.rs::default_settings)
// 이미 저장된 행이 있으면 그 값이 이긴다(default_settings()/seed()는 값이 없을 때만 쓰인다). 이
// 백필이 없으면, close_to_tray 를 실제로 읽기 시작하는 이번 릴리즈부터 오늘까지의 모든 기존
// 설치가 갑자기 "X = 종료"로 바뀐다(지금까지는 무조건 트레이-숨김이었다) — 이 값을 바꿀 프런트
// UI가 이번 릴리즈 전까지 전혀 없었으므로(grep 확인 완료) 저장된 'false' 는 전부 그 시절 seed
// 잔재이지 사용자의 실제 선택이 아니다. 한 번만 true로 되돌린다 — 버전 게이트(schema_migrations)
// 라 이후 사용자가 새 체크박스로 명시적으로 false를 고르면 이 마이그레이션은 이미 적용된 뒤라
// 다시 실행되지 않는다(V32의 재실행-불가 버전 게이팅과 동일 안전성).
pub const V37_SQL: &str = "UPDATE settings SET value = 'true' WHERE key = 'close_to_tray' AND value = 'false';";

// P1 시맨틱 검색 기반(docs/PLAN-2026-08-07-second-brain.md Q2/Q3): 섹션 단위 임베딩 캐시.
// V25_SQL이 드롭한 note_embeddings(2026-07 owner decision, 노트 단위)와는 별개 테이블이다 —
// 이번엔 섹션 단위(에디터 탭 하나가 한 행)이고, owner가 그릴 세션에서 시맨틱 검색을 다시
// 채택했다(위 플랜 문서 Q1~Q8). FK를 걸지 않는다: section_id는 sections(id)를 가리키지만
// sections 삭제(직접 또는 note cascade)를 이 테이블까지 자동 전파할 필요가 없다 — 임베딩
// 워커가 매 재스캔마다 고아 행을 정리한다(embedding::worker, "스캔 시 함께" 청소 — attachments
// content_hash 백필과 같은 best-effort 패턴). workspace_id도 비정규화 저장(섹션→노트→폴더
// 조인 없이 워크스페이스 스코프 브루트포스 코사인 스캔이 바로 필터링할 수 있게, Q2 하이브리드
// 검색의 질의 경로). model/dim은 임베딩 모델 교체(Q3 업그레이드 카드: EmbeddingGemma) 시 서로
// 다른 차원의 벡터가 섞였을 때 왕은 걸러낼 수 있게 각 행에 함께 저장한다. content_hash(SHA-256
// hex, sections.body_md 기준)는 재스캔이 "이미 최신인 행"을 건너뛰는 유일한 근거 — 별도 큐
// 테이블 없이 이 컬럼 하나로 멱등 재시작 가능한 백필을 구현한다(embedding::worker 헤더 주석).
pub const V38_SQL: &str = "\
CREATE TABLE section_embeddings (
  section_id TEXT PRIMARY KEY,
  note_id TEXT,
  workspace_id TEXT,
  model TEXT,
  dim INTEGER,
  vec BLOB,
  content_hash TEXT,
  updated_at TEXT
);
CREATE INDEX idx_section_embeddings_workspace ON section_embeddings(workspace_id);";
// ponytail: dropped in V61.

// P2 1단계 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5): 임베딩 겹침 감지·(추후) 링크
// 제안을 담는 범용 제안함. kind는 지금 'overlap'만 쓴다 — P2 3단계가 같은 테이블에 'link'를
// 얹어 재사용할 예정이라 스키마는 kind로 분기하는 범용 형태로 만든다(칼럼을 kind별로 늘리지
// 않음). note_id/related_note_id는 FK 없음 — section_embeddings(V38_SQL)와 같은 이유(고아 정리는
// 조회 쪽 조인 필터로 처리, embedding::overlap 헤더 주석). UNIQUE(kind, note_id, related_note_id)
// 가 "이미 어떤 status로든 존재하는 쌍은 재제안하지 않는다"(dismissed 존중)를 강제한다 —
// INSERT OR IGNORE 한 줄로 충분하고 별도 조회+분기가 필요 없다. note_id/related_note_id는 항상
// (min,max) 정규화 후 저장한다(embedding::overlap::detect_and_store) — A→B와 B→A가 같은 유니크
// 키로 수렴하게. score는 그 쌍의 최고 코사인 유사도(REAL), payload는 kind별 부가 정보(JSON
// 문자열 — overlap은 겹친 섹션 id 쌍).
pub const V39_SQL: &str = "\
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  note_id TEXT NOT NULL,
  related_note_id TEXT NOT NULL,
  payload TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(kind, note_id, related_note_id)
);
CREATE INDEX idx_suggestions_workspace ON suggestions(workspace_id);";

// P3 수집 관문(docs/PLAN-2026-08-07-second-brain.md Q6) — 소스 어댑터형 관문. 관리 UX(2026-08-08
// 오너 결정): kind 기반 모듈식, config는 kind별 엄격한 serde 스키마를 JSON(TEXT)에 담아
// 저장한다(런타임 관문은 collect::config). enabled는 사용자가 리스트에서 ON/OFF만 하는
// 관리 UX를 그대로 반영(편집 없음 — 지우고 재추가). last_run_at/last_status('ok'|'error')/
// last_error는 러너(src-tauri/src/collect/mod.rs)가 매 실행 후 기록 — 소스별 상태를 사용자가
// 리스트에서 바로 확인할 수 있게 한다.
// collect_seen은 (source_id, guid) 복합 PK로 "이미 인박스에 넣은 항목"을 멱등하게 기록한다 — 큐
// 테이블이 아니라 조회 후 스킵 방식(embedding::worker의 해시 비교와 같은 철학: 재시작해도 그냥
// 다시 스캔하면 스테일한 것만 다시 걸린다). FK 없음 — section_embeddings/suggestions(V38/V39_SQL)와
// 같은 이유(고아 정리가 필요해지면 delete 시 함께 지운다, repo::collect::delete).
// → V96 이 두 테이블 모두 ON DELETE CASCADE FK 로 재생성했다(노트북 삭제가 소스를 남기던 고아).
pub const V40_SQL: &str = "\
CREATE TABLE collect_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_collect_sources_workspace ON collect_sources(workspace_id);
CREATE TABLE collect_seen (
  source_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  PRIMARY KEY (source_id, guid)
 );";

// P2 링크 제안 정합성(V41): V39의 범용 UNIQUE(kind,note_id,related_note_id)는 overlap 쌍에는
// 맞지만 link는 같은 대상 노트에 서로 다른 URL이 도달할 수 있어 두 번째 제안을 유실시켰다.
// link_url을 별도 컬럼으로 승격하고, overlap 쌍과 pending link URL에 각각 필요한 제약을 분리한다.
// 기존 pending 중복 link는 마이그레이션 중 하나만 남긴다(동일 URL의 중복 카드만 제거).
pub const V41_SQL: &str = "\
CREATE TABLE suggestions_v41 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  note_id TEXT NOT NULL,
  related_note_id TEXT NOT NULL,
  link_url TEXT,
  payload TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT,
  updated_at TEXT
);
INSERT INTO suggestions_v41
  (id, workspace_id, kind, note_id, related_note_id, link_url, payload, score, status, created_at, updated_at)
SELECT id, workspace_id, kind, note_id, related_note_id,
       CASE WHEN kind = 'link' AND json_valid(payload) THEN json_extract(payload, '$.url') ELSE NULL END,
       payload, score, status, created_at, updated_at
  FROM suggestions;
DELETE FROM suggestions_v41
 WHERE kind = 'link' AND status = 'pending' AND link_url IS NOT NULL
   AND id NOT IN (
     SELECT MIN(id) FROM suggestions_v41
      WHERE kind = 'link' AND status = 'pending' AND link_url IS NOT NULL
      GROUP BY note_id, link_url
   );
DROP TABLE suggestions;
ALTER TABLE suggestions_v41 RENAME TO suggestions;
CREATE INDEX idx_suggestions_workspace ON suggestions(workspace_id);
CREATE UNIQUE INDEX idx_suggestions_overlap_pair
  ON suggestions(kind, note_id, related_note_id) WHERE kind = 'overlap';
CREATE UNIQUE INDEX idx_suggestions_pending_link_url
  ON suggestions(note_id, link_url) WHERE kind = 'link' AND status = 'pending' AND link_url IS NOT NULL;";

// docs/PLAN-schedule-system.md §1 — 일정·알림. Q10(PLAN-2026-08-08-presets-schedule.md):
// 노트에 시각(HH:MM)·알림 오프셋·반복(RRULE 서브셋)을 얹되 occurrence 행은 실체화하지 않는다.
//
// 정밀도 전제: start_time 이 있으면 시작이 연월일 풀 정밀도여야 한다(month/day NOT NULL),
// end_time 이 있으면 end_* 가 풀 정밀도여야 한다. V23/V28 과 같은 이유로 이 교차 불변식은
// 여기가 아니라 repo::notes::set_schedule 이 강제한다 — ADD COLUMN 은 교차 CHECK 를 못 붙인다.
//
// end_year/end_month/end_day 의 의미는 반복(rrule)이 붙어도 **바뀌지 않는다** — 여전히 그 노트
// 한 회차의 기간이다. 반복 시리즈의 종료는 rrule 안의 UNTIL 이 표현한다(§3.2, 2026-08-09 오너
// 확정).
//
// rrule 에는 CHECK 를 걸지 않는다: 문법을 SQL 로 표현할 수 없고, 실제 게이트는 Rust 파서
// (repo::schedule::rrule::parse, W5-2)다 — V26 의 sections.kind 주석과 같은 판단(CHECK 는
// defense-in-depth 일 뿐, 나쁜 입력의 진짜 관문은 repo 계층의 AppError::Validation). 이 웨이브
// (W5-1)는 rrule 을 검증 없이 TEXT 그대로 저장/왕복만 한다 — 파서 연동은 W5-2가 landing된 뒤.
//
// CHECK 를 붙이면 훗날 DROP COLUMN 이 막힌다(V29 주석이 due_at 을 드롭할 수 있었던 근거가
// 정확히 "CHECK 도 인덱스도 없다"였다). start_time/end_time/remind_offset_min 은 그래도 붙인다 —
// 형식 오류가 조용히 저장되면 틱이 매분 잘못된 시각에 발화하기 때문. rrule 만 예외.
//
// ponytail: GLOB '[0-2][0-9]:[0-5][0-9]' 는 "24:00"~"29:59"를 통과시킨다(SQL GLOB로는 시(0..23)
// 범위를 정확히 못 쓴다) — 이 CHECK는 길이/자릿수 모양까지만 거르는 저비용 방어선이고, 정확한
// 범위 검증은 Rust(repo::schedule::parse_hhmm_min)가 한다.
pub const V42_SQL: &str = "\
ALTER TABLE notes ADD COLUMN start_time TEXT NULL CHECK (start_time IS NULL OR (length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]'));\n\
ALTER TABLE notes ADD COLUMN end_time TEXT NULL CHECK (end_time IS NULL OR (length(end_time) = 5 AND end_time GLOB '[0-2][0-9]:[0-5][0-9]'));\n\
ALTER TABLE notes ADD COLUMN remind_offset_min INTEGER NULL CHECK (remind_offset_min IS NULL OR (remind_offset_min >= 0 AND remind_offset_min <= 40320));\n\
ALTER TABLE notes ADD COLUMN rrule TEXT NULL;";

// 대시보드 스케일(SCALABILITY.md §0, 2026-08-09): dashboard_calendar 의 월 교집합 술어가
// MIN/MAX/CASE/COALESCE 표현식이라 어떤 인덱스도 못 타서, 달을 넘길 때마다 노트 풀스캔이었다.
// 그 표현식을 **생성 컬럼**으로 옮겨 술어를 `span_month_lo <= ?k AND span_month_hi >= ?k` 라는
// 순수 컬럼 비교(sargable)로 만든다 — 계산식 자체는 calendar.rs 가 쓰던 것과 글자 그대로 같으므로
// 결과 동치다(resolve_start 의 month.unwrap_or(1) / resolve_end 의 month.unwrap_or(12), 그리고
// end<start 스왑까지 MIN/MAX 로 그대로 옮겼다).
//
// VIRTUAL 인 이유: SQLite 의 ALTER TABLE ADD COLUMN 은 STORED 생성 컬럼을 지원하지 않는다(테이블
// 재작성이 필요). VIRTUAL 이어도 **인덱스에는 계산값이 저장**되므로 목표(인덱스 타기)는 그대로
// 달성되고, 행 자체는 커지지 않는다.
//
// 인덱스 두 개:
// - idx_notes_span_month(span_month_hi, span_month_lo): 선행이 hi 인 이유는 "이 달 이후에 끝나는
//   노트"가 보통 더 선택적이기 때문이다(코퍼스 대부분은 과거로 끝나 있고 달력은 현재 근처를 본다).
//   partial(alive+non-archived)이라 달력 쿼리의 WHERE 와 정확히 겹치고 리프도 작다.
// - idx_notes_rrule_span: 반복 노트는 seed 가 10년 전이어도 이 달에 회차가 떨어지므로 스팬
//   교집합으로 거를 수 없다 — rrule IS NOT NULL 부분 인덱스로 그 소수 행만 따로 훑는다.
//
// ANALYZE 는 붙이지 않는다 — V21 주석 참조(신규 설치의 zero-row sqlite_stat1 회귀).
// SSOT 주석: specs/db/schemas/notes.sql.
// 월키 식: 시작 = (year*12 + COALESCE(month,1) - 1), 종료 = end_* 가 있으면 그쪽(월 없으면 12월),
// 없으면 시작 노트의 그 해/그 달 끝 — calendar.rs 의 resolve_start/resolve_end 기본값과 동일.
pub const V43_SQL: &str = "\
ALTER TABLE notes ADD COLUMN span_month_lo INTEGER GENERATED ALWAYS AS (MIN( \
(year * 12 + COALESCE(month, 1) - 1), \
(CASE WHEN end_year IS NOT NULL THEN end_year * 12 + COALESCE(end_month, 12) - 1 \
ELSE year * 12 + COALESCE(month, 12) - 1 END))) VIRTUAL;\n\
ALTER TABLE notes ADD COLUMN span_month_hi INTEGER GENERATED ALWAYS AS (MAX( \
(year * 12 + COALESCE(month, 1) - 1), \
(CASE WHEN end_year IS NOT NULL THEN end_year * 12 + COALESCE(end_month, 12) - 1 \
ELSE year * 12 + COALESCE(month, 12) - 1 END))) VIRTUAL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_span_month ON notes(span_month_hi, span_month_lo) \
WHERE deleted_at IS NULL AND archived_at IS NULL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_rrule_span ON notes(span_month_lo) \
WHERE rrule IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL;";

// 대시보드 스케일 2차(SCALABILITY.md §0, 2026-08-09 오너 결정): dashboard_board 의 우선순위
// 정렬을 인덱스로 가져오기 위한 축들. V43 이 준 것은 "LIMIT 이 걸린 temp B-tree"였고, 그건
// 여전히 노트북 전 행을 정렬기에 밀어 넣는다 — 이 마이그레이션은 그 정렬 자체를 없앤다.
//
// board 의 캡 이전 티어(board_priority_cmp, unchecked=0)는 셋으로 쪼갤 수 있다:
//   ① 핀 후보  = remind=1 · 종료 트리플 풀 정밀도 · done 아님   → 아주 작은 집합
//   ② 날짜 있음 = end_year IS NOT NULL, 종료일 오름차순
//   ③ 날짜 없음 = end_year IS NULL, updated_at 내림차순
// 각 축에 부분 인덱스를 하나씩 주면 세 쿼리 모두 LIMIT 만큼만 읽고 멈춘다.
//
// end_sort_key 를 **생성 컬럼**으로 두는 이유: schedule_bucket 은 정밀도 부족분을 1 로 채워
// (`month.unwrap_or(1)`, `day.unwrap_or(1)`) 비교한다. 원시 (end_year, end_month, end_day) 3열
// 인덱스는 NULL 을 1 보다 앞에 놓아 그 규칙과 미세하게 어긋난다(연 정밀도 vs 1월 1일). 채운 값을
// 컬럼으로 만들어 두면 인덱스 순서가 Rust 비교자와 **정확히** 같아진다. 음수(기원전) 연도에서도
// 수치 비교라 순서가 옳다 — 최종 출력 정렬은 여전히 Rust schedule_bucket 이 소유하므로 이 키는
// 후보 선정에만 쓰인다.
//
// updated_at 을 DESC 로 선언한 이유: ORDER BY 가 `end_sort_key ASC, updated_at DESC` 라 혼합
// 방향이고, 인덱스가 같은 방향을 들고 있어야 temp B-tree 없이 순서를 그대로 가져온다.
// (SQLite 는 완전 역순일 때만 인덱스를 거꾸로 훑을 수 있다.)
//
// 부분 인덱스 WHERE 가 board 쿼리의 WHERE 와 정확히 겹치므로 리프에는 "지금 보드에 나올 수 있는
// 행"만 들어간다. ②/③ 은 서로 배타적이라(end_year 유/무) 한 행은 둘 중 하나에만 실린다 —
// 쓰기 증폭은 사실상 인덱스 하나분이다.
//
// ANALYZE 는 붙이지 않는다 — V21 주석 참조.
// SSOT 주석: specs/db/schemas/notes.sql.
pub const V44_SQL: &str = "\
ALTER TABLE notes ADD COLUMN end_sort_key INTEGER GENERATED ALWAYS AS ( \
end_year * 10000 + COALESCE(end_month, 1) * 100 + COALESCE(end_day, 1)) VIRTUAL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_end_sort_alive ON notes(end_sort_key, updated_at DESC) \
WHERE deleted_at IS NULL AND archived_at IS NULL AND end_year IS NOT NULL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_undated_updated_alive ON notes(updated_at DESC) \
WHERE deleted_at IS NULL AND archived_at IS NULL AND end_year IS NULL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_remind_end ON notes(end_sort_key, updated_at DESC) \
WHERE deleted_at IS NULL AND archived_at IS NULL AND remind = 1 AND end_day IS NOT NULL;";

// AI plan execution receipts are the idempotency boundary for user-approved multi-step writes.
// The app, not the model, creates both IDs. A receipt is inserted in the same transaction as the
// mutation, so a retry can never create a second note after an uncertain IPC/network outcome.
pub const V45_SQL: &str = "\
CREATE TABLE ai_plan_action_receipts (
  execution_id TEXT NOT NULL,
  action_id    TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('applied', 'failed')),
  note_id      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY(execution_id, action_id)
);
CREATE INDEX idx_ai_plan_receipts_created ON ai_plan_action_receipts(created_at);";

// 챗 비서 안정화 P1: 펫/사이드바 스레드가 재시작 후에도 칩·표시문구·실패 상태를 복원하려면
// 행에 JSON meta 가 필요하다. 본문·이미지 바이트는 넣지 않는다(TEXT, 8KB 상한은 repo::pet).
pub const V46_SQL: &str = "ALTER TABLE pet_messages ADD COLUMN meta TEXT NULL;";

// 챗 세션 보관(docs/PLAN-2026-08-13-chat-sessions.md). 노트북(= workspace)당 라이브 세션 1개
// (closed_at IS NULL). 기존 pet_messages 가 있는 노트북마다 라이브 세션 1개를 백필한다.
pub const V48_SQL: &str = "ALTER TABLE folders ADD COLUMN icon TEXT NULL;";

/// Folder organize rules — inherited by notes in the folder when AI organizes them.
/// Empty/NULL = no extra folder guidance (global metadata prompt only).
pub const V49_SQL: &str = "ALTER TABLE folders ADD COLUMN rules TEXT NULL;";

/// Space tab (docs/PLAN-2026-08-15-space-tab.md §3.1).
/// Adds spaces, space_items tables, and workspaces.space_bootstrapped flag.
pub const V50_SQL: &str = "\
CREATE TABLE spaces (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  position           INTEGER NOT NULL DEFAULT 0,
  is_home            INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0,1)),
  last_viewport_x    REAL NOT NULL DEFAULT 0,
  last_viewport_y    REAL NOT NULL DEFAULT 0,
  last_viewport_zoom REAL NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_spaces_ws ON spaces(workspace_id, position);
CREATE UNIQUE INDEX idx_spaces_home ON spaces(workspace_id) WHERE is_home = 1;

CREATE TABLE space_items (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','text','checklist','frame','today','image')),
  source_id    TEXT NULL,
  content      TEXT NOT NULL DEFAULT '',
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  z_index      INTEGER NOT NULL DEFAULT 0,
  display_mode TEXT NOT NULL DEFAULT 'preview',
  style        TEXT NOT NULL DEFAULT '',
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_space_items_space ON space_items(space_id, z_index);

ALTER TABLE workspaces ADD COLUMN space_bootstrapped INTEGER NOT NULL DEFAULT 0
  CHECK (space_bootstrapped IN (0,1));";

/// Space favorite & archive support (docs/PLAN-2026-08-16-space-next.md §2 W6).
/// Adds is_favorite and archived_at columns to spaces table.
pub const V51_SQL: &str = "\
ALTER TABLE spaces ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1));\n\
ALTER TABLE spaces ADD COLUMN archived_at TEXT NULL;\n\
CREATE INDEX idx_spaces_ws_archived ON spaces(workspace_id, archived_at);";

/// Space default item style support (docs/PLAN-2026-08-16-space-widgets.md §3.6-4 W11).
/// Adds default_style column to spaces table.
pub const V52_SQL: &str = "ALTER TABLE spaces ADD COLUMN default_style TEXT NOT NULL DEFAULT '';";

/// Space widget support (docs/PLAN-2026-08-16-space-widgets.md §6 W12).
/// Updates space_items check constraint to include 'widget'.
pub const V53_SQL: &str = "\
CREATE TABLE space_items_v53 (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','text','checklist','frame','today','image','widget')),
  source_id    TEXT NULL,
  content      TEXT NOT NULL DEFAULT '',
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  z_index      INTEGER NOT NULL DEFAULT 0,
  display_mode TEXT NOT NULL DEFAULT 'preview',
  style        TEXT NOT NULL DEFAULT '',
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO space_items_v53 SELECT id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at FROM space_items;
DROP TABLE space_items;
ALTER TABLE space_items_v53 RENAME TO space_items;
CREATE INDEX idx_space_items_space ON space_items(space_id, z_index);";

/// Routine completion history (docs/PLAN-2026-08-16-space-widgets.md §4 W13).
/// Adds routine_completions table.
pub const V54_SQL: &str = "\
CREATE TABLE routine_completions (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  occur_on TEXT NOT NULL,
  done_at  TEXT NOT NULL,
  PRIMARY KEY (note_id, occur_on)
);
CREATE INDEX idx_routine_completions_day ON routine_completions(occur_on);";

/// space_items 의 kind CHECK 에 'sketch' 를 넣는다.
///
/// 툴바에 add_sketch 가 있고 프런트가 kind:"sketch" 를 보내고 repo::spaces 의 검증도
/// 'sketch' 를 허용하는데, **CHECK 에만 빠져 있어 INSERT 가 거부됐다** — 스케치는 저장
/// 자체가 안 됐다(라이브 DB 에서 재현: "CHECK constraint failed"). 그림 노드 533줄이
/// 통째로 도달 불가 상태였다.
///
/// V53 이 정확히 같은 이유로 'widget' 을 넣었다. 같은 사고가 두 번 났다는 뜻이라,
/// 아래 kinds_check_matches_repo_validation 테스트로 목록 두 벌이 갈라지는 것을 막는다.
pub const V55_SQL: &str = "CREATE TABLE space_items_v55 (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('note','text','checklist','frame','today','image','widget','sketch')),
  source_id    TEXT NULL,
  content      TEXT NOT NULL DEFAULT '',
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  z_index      INTEGER NOT NULL DEFAULT 0,
  display_mode TEXT NOT NULL DEFAULT 'preview',
  style        TEXT NOT NULL DEFAULT '',
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO space_items_v55 SELECT id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at FROM space_items;
DROP TABLE space_items;
ALTER TABLE space_items_v55 RENAME TO space_items;
CREATE INDEX idx_space_items_space ON space_items(space_id, z_index);";

/// Space relation storage (space_nodes & space_edges).
/// Migrates embedded mind_map, skill_tree, milestone_path nodes/edges from space_items.content blob to relational tables.
pub const V56_SQL: &str = "\
CREATE TABLE space_nodes (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  note_id    TEXT REFERENCES notes(id) ON DELETE SET NULL,
  parent_id  TEXT REFERENCES space_nodes(id) ON DELETE SET NULL,
  label      TEXT NOT NULL DEFAULT '',
  status     TEXT NULL,
  due_on     TEXT NULL,
  x          REAL NOT NULL DEFAULT 0.0,
  y          REAL NOT NULL DEFAULT 0.0,
  position   INTEGER NOT NULL DEFAULT 0,
  collapsed  INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0,1)),
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_space_nodes_space ON space_nodes(space_id);
CREATE INDEX idx_space_nodes_item ON space_nodes(item_id, position);
CREATE INDEX idx_space_nodes_note ON space_nodes(note_id);
CREATE INDEX idx_space_nodes_parent ON space_nodes(parent_id);

CREATE TABLE space_edges (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES space_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES space_nodes(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'parent' CHECK (kind IN ('parent','requires','suggests','branches','next')),
  label          TEXT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_space_edges_space ON space_edges(space_id);
CREATE INDEX idx_space_edges_item ON space_edges(item_id);
CREATE INDEX idx_space_edges_source ON space_edges(source_node_id);
CREATE INDEX idx_space_edges_target ON space_edges(target_node_id);

INSERT INTO space_nodes (id, space_id, item_id, note_id, parent_id, label, status, due_on, x, y, position, collapsed, data, created_at, updated_at)
SELECT
  json_extract(node.value, '$.id'),
  item.space_id,
  item.id,
  CASE WHEN json_extract(node.value, '$.note_id') IS NOT NULL AND json_extract(node.value, '$.note_id') != '' THEN json_extract(node.value, '$.note_id') ELSE NULL END,
  CASE WHEN json_extract(node.value, '$.parent') IS NOT NULL AND json_extract(node.value, '$.parent') != '' THEN json_extract(node.value, '$.parent') ELSE NULL END,
  COALESCE(json_extract(node.value, '$.label'), ''),
  NULL,
  NULL,
  COALESCE(json_extract(node.value, '$.x'), 0.0),
  COALESCE(json_extract(node.value, '$.y'), 0.0),
  CAST(node.key AS INTEGER),
  CASE WHEN json_extract(node.value, '$.collapsed') = 1 OR json_extract(node.value, '$.collapsed') = true THEN 1 ELSE 0 END,
  COALESCE(json_remove(node.value, '$.id', '$.label', '$.parent', '$.note_id', '$.x', '$.y', '$.collapsed'), '{}'),
  item.created_at,
  item.updated_at
FROM space_items item,
     json_each(json_extract(item.content, '$.nodes')) node
WHERE json_valid(item.content)
  AND json_extract(item.content, '$.type') = 'mind_map'
  AND json_extract(node.value, '$.id') IS NOT NULL;

INSERT INTO space_edges (id, space_id, item_id, source_node_id, target_node_id, kind, label, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  item.space_id,
  item.id,
  json_extract(node.value, '$.parent'),
  json_extract(node.value, '$.id'),
  'parent',
  NULL,
  item.created_at,
  item.updated_at
FROM space_items item,
     json_each(json_extract(item.content, '$.nodes')) node
WHERE json_valid(item.content)
  AND json_extract(item.content, '$.type') = 'mind_map'
  AND json_extract(node.value, '$.parent') IS NOT NULL
  AND json_extract(node.value, '$.parent') != '';

INSERT INTO space_nodes (id, space_id, item_id, note_id, parent_id, label, status, due_on, x, y, position, collapsed, data, created_at, updated_at)
SELECT
  json_extract(node.value, '$.id'),
  item.space_id,
  item.id,
  CASE WHEN json_extract(node.value, '$.note_id') IS NOT NULL AND json_extract(node.value, '$.note_id') != '' THEN json_extract(node.value, '$.note_id') ELSE NULL END,
  NULL,
  COALESCE(json_extract(node.value, '$.label'), ''),
  json_extract(node.value, '$.status'),
  NULL,
  COALESCE(json_extract(node.value, '$.x'), 0.0),
  COALESCE(json_extract(node.value, '$.y'), 0.0),
  CAST(node.key AS INTEGER),
  0,
  COALESCE(json_remove(node.value, '$.id', '$.label', '$.status', '$.note_id', '$.x', '$.y'), '{}'),
  item.created_at,
  item.updated_at
FROM space_items item,
     json_each(json_extract(item.content, '$.nodes')) node
WHERE json_valid(item.content)
  AND json_extract(item.content, '$.type') = 'skill_tree'
  AND json_extract(node.value, '$.id') IS NOT NULL;

INSERT INTO space_edges (id, space_id, item_id, source_node_id, target_node_id, kind, label, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  item.space_id,
  item.id,
  json_extract(edge.value, '$.from'),
  json_extract(edge.value, '$.to'),
  COALESCE(json_extract(edge.value, '$.kind'), 'requires'),
  NULL,
  item.created_at,
  item.updated_at
FROM space_items item,
     json_each(json_extract(item.content, '$.edges')) edge
WHERE json_valid(item.content)
  AND json_extract(item.content, '$.type') = 'skill_tree'
  AND json_extract(edge.value, '$.from') IS NOT NULL
  AND json_extract(edge.value, '$.to') IS NOT NULL;

INSERT INTO space_nodes (id, space_id, item_id, note_id, parent_id, label, status, due_on, x, y, position, collapsed, data, created_at, updated_at)
SELECT
  json_extract(m.value, '$.id'),
  item.space_id,
  item.id,
  CASE WHEN json_extract(m.value, '$.note_id') IS NOT NULL AND json_extract(m.value, '$.note_id') != '' THEN json_extract(m.value, '$.note_id') ELSE NULL END,
  NULL,
  COALESCE(json_extract(m.value, '$.label'), ''),
  CASE WHEN json_extract(m.value, '$.done') = 1 OR json_extract(m.value, '$.done') = true THEN 'done' ELSE 'todo' END,
  json_extract(m.value, '$.due_on'),
  0.0,
  0.0,
  CAST(m.key AS INTEGER),
  0,
  COALESCE(json_remove(m.value, '$.id', '$.label', '$.due_on', '$.done', '$.note_id'), '{}'),
  item.created_at,
  item.updated_at
FROM space_items item,
     json_each(json_extract(item.content, '$.items')) m
WHERE json_valid(item.content)
  AND json_extract(item.content, '$.type') IN ('milestone_path', 'milestone')
  AND json_extract(m.value, '$.id') IS NOT NULL;";

/// 시트 섹션(specs/features/sheet.md P1): `sections.kind` CHECK 에 `'sheet'` 를 넣는다.
///
/// SQLite 는 CHECK 를 ALTER 하지 못하므로 V55(space_items) 와 같은 테이블 재생성 패턴이다 —
/// 새 테이블 생성 → 전체 복사 → DROP → RENAME → 인덱스 재생성. sections 를 참조하는 FK 는
/// 어디에도 없다(section_embeddings 는 의도적으로 FK 를 걸지 않는다 — V33 주석 참고)이므로
/// DROP 이 다른 테이블로 cascade 하지 않는다.
///
/// 재생성 후의 컬럼 구성 = 원본 DDL(db/schemas/content.sql) + V24 updated_at + V26 kind.
pub const V57_SQL: &str = "CREATE TABLE sections_v57 (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  body_md    TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NULL,
  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','diagram','sheet'))
);
INSERT INTO sections_v57 SELECT id, note_id, name, body_md, position, updated_at, kind FROM sections;
DROP TABLE sections;
ALTER TABLE sections_v57 RENAME TO sections;
CREATE INDEX idx_sections_note ON sections(note_id, position);";

pub const V47_SQL: &str = "\
CREATE TABLE pet_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pet_sessions_ws ON pet_sessions(workspace_id, closed_at, created_at);
ALTER TABLE pet_messages ADD COLUMN session_id TEXT NULL;
CREATE INDEX idx_pet_messages_session ON pet_messages(session_id, created_at);
INSERT INTO pet_sessions (id, workspace_id, title, created_at, closed_at, message_count)
WITH ws_msgs AS (
  SELECT workspace_id, min(created_at) AS min_created, count(*) AS n
  FROM pet_messages
  GROUP BY workspace_id
)
SELECT
  lower(hex(randomblob(16))),
  w.workspace_id,
  COALESCE(
    (
      SELECT CASE
        WHEN length(trim(m2.text)) > 40 THEN substr(trim(m2.text), 1, 40)
        ELSE trim(m2.text)
      END
      FROM pet_messages m2
      WHERE m2.workspace_id = w.workspace_id
        AND m2.role = 'user'
        AND trim(m2.text) != ''
      ORDER BY m2.created_at ASC, m2.rowid ASC
      LIMIT 1
    ),
    substr(w.min_created, 1, 10)
  ),
  w.min_created,
  NULL,
  w.n
FROM ws_msgs w;
UPDATE pet_messages
SET session_id = (
  SELECT s.id FROM pet_sessions s
  WHERE s.workspace_id = pet_messages.workspace_id
    AND s.closed_at IS NULL
  LIMIT 1
);";

pub const V58_SQL: &str = "\
INSERT OR IGNORE INTO space_items (id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
SELECT
  n.id,
  n.space_id,
  CASE WHEN n.note_id IS NOT NULL AND n.note_id != '' THEN 'note' ELSE 'text' END,
  CASE WHEN n.note_id IS NOT NULL AND n.note_id != '' THEN n.note_id ELSE NULL END,
  n.label,
  COALESCE(parent_item.x, 0.0) + n.x,
  COALESCE(parent_item.y, 0.0) + n.y,
  160.0,
  80.0,
  100,
  'preview',
  '',
  0,
  n.created_at,
  n.updated_at
FROM space_nodes n
LEFT JOIN space_items parent_item ON parent_item.id = n.item_id;

CREATE TABLE space_edges_v58 (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  target_item_id TEXT NOT NULL REFERENCES space_items(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'parent' CHECK (kind IN ('parent','requires','suggests','branches','next')),
  label          TEXT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

INSERT OR IGNORE INTO space_edges_v58 (id, space_id, source_item_id, target_item_id, kind, label, created_at, updated_at)
SELECT
  e.id,
  e.space_id,
  e.source_node_id,
  e.target_node_id,
  e.kind,
  e.label,
  e.created_at,
  e.updated_at
FROM space_edges e
WHERE EXISTS (SELECT 1 FROM space_items WHERE id = e.source_node_id)
  AND EXISTS (SELECT 1 FROM space_items WHERE id = e.target_node_id);

-- 마일스톤의 순서는 간선이 아니라 position 으로만 있었다(사슬은 i→i+1 이 암묵적이었다).
-- 캔버스로 올라오면 그 암묵이 사라져 **순서가 통째로 없어진다** — 마일스톤은 순서가 곧
-- 내용이므로 여기서 next 간선으로 명시한다. 위젯 타입으로 좁히지 않으면 마인드맵·스킬트리
-- 노드에도 엉뚱한 next 가 붙는다.
INSERT OR IGNORE INTO space_edges_v58 (id, space_id, source_item_id, target_item_id, kind, label, created_at, updated_at)
SELECT 'next-' || a.id, a.space_id, a.id, b.id, 'next', NULL, a.created_at, a.updated_at
FROM space_nodes a
JOIN space_nodes b ON b.item_id = a.item_id AND b.position = a.position + 1
JOIN space_items w ON w.id = a.item_id
WHERE json_extract(w.content, '$.type') = 'milestone_path'
  AND EXISTS (SELECT 1 FROM space_items WHERE id = a.id)
  AND EXISTS (SELECT 1 FROM space_items WHERE id = b.id);

DROP TABLE space_edges;
ALTER TABLE space_edges_v58 RENAME TO space_edges;

CREATE INDEX idx_space_edges_space ON space_edges(space_id);
CREATE INDEX idx_space_edges_source ON space_edges(source_item_id);
CREATE INDEX idx_space_edges_target ON space_edges(target_item_id);

DROP TABLE IF EXISTS space_nodes;";

// graph() NODES_SQL 재작성(상관 서브쿼리 → 사전 집계 CTE, repo/dashboard/graph.rs)의 링크 집계가
// attachments(url) 로 조인한다. note_id 쪽은 idx_attachments_note(note_id, position) 가 이미
// 있지만 url 쪽은 인덱스가 없어 links CTE 의 두 번째 JOIN(alive d ON d.id = a.url)이 매번
// internal 행을 전부 스캔했다. kind='internal' 부분 인덱스로 그 스캔만 좁힌다.
// ANALYZE 는 절대 넣지 않는다 — docs/SCALABILITY.md §3 의 scrub_zero_row_stats 불변식, zero-row
// 통계로 63,148ms 사고가 났다.
pub const V59_SQL: &str =
    "CREATE INDEX idx_attachments_internal_url ON attachments(url) WHERE kind='internal';";

// V60: 자동 수집 고도화 (P3 수집 관문 v2, docs/PLAN-2026-08-23-collect-advanced.md).
// - collect_sources: kind 무관 공통 필드를 컬럼으로 승격 (dry_run, target_folder_id, post_process,
//   post_process_model, interval_minutes). target_folder_id 는 folders(id) 를 가리키되
//   collect_seen/suggestions 와 같이 FK 는 걸지 않는다(폴더 삭제 시 인박스로 폴백).
// - ai_usage: 누적 카운트를 보존하는 일자·프로바이더·액션별 AI 호출 집계 테이블(ai_history 의 50행 캡
//   영향을 받지 않음).
pub const V60_SQL: &str = "\
ALTER TABLE collect_sources ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collect_sources ADD COLUMN target_folder_id TEXT NULL;
ALTER TABLE collect_sources ADD COLUMN post_process TEXT NOT NULL DEFAULT 'none';
ALTER TABLE collect_sources ADD COLUMN post_process_model TEXT NULL;
ALTER TABLE collect_sources ADD COLUMN interval_minutes INTEGER NULL;
CREATE TABLE ai_usage (
  workspace_id TEXT NOT NULL,
  day          TEXT NOT NULL,
  action_type  TEXT NOT NULL,
  provider     TEXT NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, action_type, provider)
);";

// V38 이 만든 section_embeddings 를 드롭한다. 프로덕션 읽기/쓰기 0(임베딩 워커 없음).
// V38_SQL 자체는 히스토리로 남긴다(additive 마이그레이션 컨벤션). IF EXISTS 라 V38 을 거친
// 기존 DB와, V38 생성 직후 이 버전에서 지우는 신규 DB 양쪽에서 안전하다. 인덱스는 테이블과
// 함께 사라진다.
pub const V61_SQL: &str = "DROP TABLE IF EXISTS section_embeddings;";

// W5 (docs/PLAN-2026-08-26-space-toolbar-frame-waves.md §2): 미니맵 3버튼 — 홈 보기·배치 잠금.
// - home_viewport_{x,y,zoom}: 미니맵 "홈 보기"가 돌아올 뷰포트. nullable — 미지정(null) 상태에서
//   홈 보기 클릭은 전체보기 폴백(빈 동작 없음). last_viewport_* 와 같은 재질의 REAL 3종이지만
//   자동 갱신되지 않는다 — 우클릭/길게 누르기로 사용자가 명시적으로 지정할 때만 채워진다.
// - layout_locked: 공간 수준 배치 잠금("배치 잠금, 사용은 허용") — 이동·리사이즈·추가·삭제·
//   스타일·엣지·드로우 진입은 막고 위젯 내용 상호작용은 허용한다. 아이템별 space_items.locked 와
//   무관한 별개 축이라 해제 시 원상복구 문제가 없다. boolean 컨벤션은 is_favorite 과 같은
//   INTEGER 0/1 CHECK 로 통일한다. 설정(settings_schema) allowlist 경로가 아니다 — 공간 행의
//   상태이므로 spaces 테이블 컬럼으로만 존재한다.
pub const V62_SQL: &str = "\
ALTER TABLE spaces ADD COLUMN home_viewport_x REAL NULL;
ALTER TABLE spaces ADD COLUMN home_viewport_y REAL NULL;
ALTER TABLE spaces ADD COLUMN home_viewport_zoom REAL NULL;
ALTER TABLE spaces ADD COLUMN layout_locked INTEGER NOT NULL DEFAULT 0 CHECK (layout_locked IN (0,1));";

/// 폴더 단위 일괄 제외 — search_excluded: search_notes(전역 검색)에서 이 폴더의 노트를 뺀다
/// (트리/그래프/타임라인 브라우징에는 그대로 보인다). ai_excluded: ai_organize_note와 에이전트
/// 스캔(폴더/노트북 단위 일괄 계획)의 입력 후보에서 이 폴더의 노트를 뺀다. 둘 다 기본 0(제외 없음).
pub const V63_SQL: &str = "\
ALTER TABLE folders ADD COLUMN search_excluded INTEGER NOT NULL DEFAULT 0 CHECK (search_excluded IN (0,1));
ALTER TABLE folders ADD COLUMN ai_excluded INTEGER NOT NULL DEFAULT 0 CHECK (ai_excluded IN (0,1));";

/// 공간 플러그인 독립 창 재구축 (PLAN-2026-08-27-space-plugin-rebuild §3):
/// space_canvases, space_canvas_items, space_canvas_edges 테이블 신설.
pub const V64_SQL: &str = "\
CREATE TABLE space_canvases (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  position           INTEGER NOT NULL DEFAULT 0,
  is_favorite        INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
  last_viewport_x    REAL NOT NULL DEFAULT 0.0,
  last_viewport_y    REAL NOT NULL DEFAULT 0.0,
  last_viewport_zoom REAL NOT NULL DEFAULT 1.0,
  default_style      TEXT NOT NULL DEFAULT '',
  layout_locked      INTEGER NOT NULL DEFAULT 0 CHECK (layout_locked IN (0,1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_space_canvases_pos ON space_canvases(position);
CREATE INDEX idx_space_canvases_fav ON space_canvases(is_favorite, position);

CREATE TABLE space_canvas_items (
  id           TEXT PRIMARY KEY,
  canvas_id    TEXT NOT NULL REFERENCES space_canvases(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('text','checklist','frame','image','sketch')),
  source_id    TEXT NULL,
  content      TEXT NOT NULL DEFAULT '',
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  z_index      INTEGER NOT NULL DEFAULT 0,
  display_mode TEXT NOT NULL DEFAULT 'preview',
  style        TEXT NOT NULL DEFAULT '',
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_space_canvas_items_canvas ON space_canvas_items(canvas_id, z_index);

CREATE TABLE space_canvas_edges (
  id             TEXT PRIMARY KEY,
  canvas_id      TEXT NOT NULL REFERENCES space_canvases(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES space_canvas_items(id) ON DELETE CASCADE,
  target_item_id TEXT NOT NULL REFERENCES space_canvas_items(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'default' CHECK (kind IN ('default','parent','requires','suggests','branches','next')),
  label          TEXT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_space_canvas_edges_canvas ON space_canvas_edges(canvas_id);
CREATE INDEX idx_space_canvas_edges_source ON space_canvas_edges(source_item_id);
CREATE INDEX idx_space_canvas_edges_target ON space_canvas_edges(target_item_id);";

/// 공간 캔버스 아이템 kind 에 'widget' 추가 (PLAN-2026-08-27-space-plugin-p2-widgets §W1).
/// space_canvas_items 의 kind CHECK 에 'widget' 을 포함하도록 테이블을 재생성한다.
/// space_canvas_edges 가 space_canvas_items 를 참조하므로
/// 두 테이블을 v65 로 생성 후 데이터 복사, 기존 테이블 DROP, RENAME 및 인덱스 재구성 순서로 처리한다.
pub const V65_SQL: &str = "\
CREATE TABLE space_canvas_items_v65 (
  id           TEXT PRIMARY KEY,
  canvas_id    TEXT NOT NULL REFERENCES space_canvases(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('text','checklist','frame','image','sketch','widget')),
  source_id    TEXT NULL,
  content      TEXT NOT NULL DEFAULT '',
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  width        REAL NOT NULL,
  height       REAL NOT NULL,
  z_index      INTEGER NOT NULL DEFAULT 0,
  display_mode TEXT NOT NULL DEFAULT 'preview',
  style        TEXT NOT NULL DEFAULT '',
  locked       INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO space_canvas_items_v65 (id, canvas_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
  SELECT id, canvas_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at FROM space_canvas_items;
CREATE TABLE space_canvas_edges_v65 (
  id             TEXT PRIMARY KEY,
  canvas_id      TEXT NOT NULL REFERENCES space_canvases(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES space_canvas_items_v65(id) ON DELETE CASCADE,
  target_item_id TEXT NOT NULL REFERENCES space_canvas_items_v65(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'default' CHECK (kind IN ('default','parent','requires','suggests','branches','next')),
  label          TEXT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
INSERT INTO space_canvas_edges_v65 (id, canvas_id, source_item_id, target_item_id, kind, label, created_at, updated_at)
  SELECT id, canvas_id, source_item_id, target_item_id, kind, label, created_at, updated_at FROM space_canvas_edges;
DROP TABLE space_canvas_edges;
DROP TABLE space_canvas_items;
ALTER TABLE space_canvas_items_v65 RENAME TO space_canvas_items;
ALTER TABLE space_canvas_edges_v65 RENAME TO space_canvas_edges;
CREATE INDEX idx_space_canvas_items_canvas ON space_canvas_items(canvas_id, z_index);
CREATE INDEX idx_space_canvas_edges_canvas ON space_canvas_edges(canvas_id);
CREATE INDEX idx_space_canvas_edges_source ON space_canvas_edges(source_item_id);
CREATE INDEX idx_space_canvas_edges_target ON space_canvas_edges(target_item_id);";

// 공간(Space)→캔버스(Canvas) / 캔버스(Canvas)→페이지(Page) 전면 개명 (PLAN, 2026-08-29):
// 바깥(플러그인 창)이 "공간"에서 "캔버스"로, 안쪽(공간 창 안에서 전환하는 문서 단위)이
// "캔버스"에서 "페이지"로 바뀐다 — 그래서 space_canvases→canvas_pages, space_canvas_items→
// canvas_page_items(canvas_id 컬럼→page_id), space_canvas_edges→canvas_page_edges 다
// (canvas_canvas_items 가 아니다). libsqlite3-sys 0.38(bundled, Cargo.lock 확인)은 SQLite
// 3.25+ 라 RENAME TO/RENAME COLUMN 이 FK REFERENCES 절을 자동 갱신한다 — V65 처럼 CHECK 을
// 새로 추가하는 게 아니므로 create/copy/drop 재생성이 필요 없는 순수 rename 이다.
// source_id 재작성: canvas_page_items.source_id 가 'spaces/{id}/...' (구 attachments 루트,
// repo/canvas_page_image.rs::SPACE_IMAGE_ROOT) 를 가리키던 이미지 아이템을 새 활성 루트
// 'canvas_pages/{id}/...' 로 옮긴다 — 실제 파일 이동은 db::bootstrap() 이 이 마이그레이션
// 직후 DB 조회 기반으로 수행한다(repo/canvas_page_image.rs::migrate_active_attachments 참고).
// **절대 건드리지 않는다**: spaces/space_items/space_edges/space_nodes 4개 테이블 — 살아있는
// 노트북 백업/복원 기능(repo/transfer/bundle.rs 의 SpaceRow/SpaceItemRow)이 지금도 이 스키마로
// 읽고 쓴다. 여길 건드리면 이번 개명과 무관한 기존 기능이 깨진다.
// settings 키 이관: space_enabled/space_shortcut → canvas_enabled/canvas_shortcut. settings 는
// 단순 (key, value) 테이블이라 UPDATE settings SET value=... WHERE key=...(V37_SQL 전례)와
// 같은 안전성으로 키 자체도 이관할 수 있다. tray.rs 는 키가 없으면 조용히 false 로 읽으므로
// 이 UPDATE 를 놓치면 기존 사용자의 켜짐 상태·단축키가 업그레이드 후 에러 없이 조용히 꺼진다.
pub const V66_SQL: &str = "\
ALTER TABLE space_canvases RENAME TO canvas_pages;
ALTER TABLE space_canvas_items RENAME TO canvas_page_items;
ALTER TABLE canvas_page_items RENAME COLUMN canvas_id TO page_id;
ALTER TABLE space_canvas_edges RENAME TO canvas_page_edges;
ALTER TABLE canvas_page_edges RENAME COLUMN canvas_id TO page_id;

DROP INDEX idx_space_canvases_pos;
DROP INDEX idx_space_canvases_fav;
DROP INDEX idx_space_canvas_items_canvas;
DROP INDEX idx_space_canvas_edges_canvas;
DROP INDEX idx_space_canvas_edges_source;
DROP INDEX idx_space_canvas_edges_target;
CREATE INDEX idx_canvas_pages_pos ON canvas_pages(position);
CREATE INDEX idx_canvas_pages_fav ON canvas_pages(is_favorite, position);
CREATE INDEX idx_canvas_page_items_page ON canvas_page_items(page_id, z_index);
CREATE INDEX idx_canvas_page_edges_page ON canvas_page_edges(page_id);
CREATE INDEX idx_canvas_page_edges_source ON canvas_page_edges(source_item_id);
CREATE INDEX idx_canvas_page_edges_target ON canvas_page_edges(target_item_id);

UPDATE canvas_page_items
   SET source_id = 'canvas_pages/' || substr(source_id, 8)
 WHERE kind = 'image' AND source_id LIKE 'spaces/%';

UPDATE settings SET key = 'canvas_enabled' WHERE key = 'space_enabled';
UPDATE settings SET key = 'canvas_shortcut' WHERE key = 'space_shortcut';";

// W5 provenance (docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W5) — sections gain
// ai_origin TEXT NULL: NULL = user-authored, otherwise the AI action id (summarize/organize/
// translate/…) that wrote this section's current body. Same ALTER-with-NULL-default shape as
// V24's updated_at (existing rows backfill to NULL for free, no UPDATE needed since every
// pre-existing section was written before this column existed and so is definitionally
// user-authored). Three-way write contract lives at the command layer, not here — see
// specs/commands/sections.yaml section_update notes and repo::sections::update.
pub const V67_SQL: &str = "ALTER TABLE sections ADD COLUMN ai_origin TEXT NULL;";

// E2: timeline_preset 전량 제거 (PLAN-2026-09-02 §0 E2).
// SQLite 3.35.0+(bundled rusqlite 0.40.1 / libsqlite3-sys 3.53.2) 지원:
// ALTER TABLE workspaces DROP COLUMN timeline_preset.
pub const V68_SQL: &str = "ALTER TABLE workspaces DROP COLUMN timeline_preset;";

// W1a: 관계도 섹션 body_md JSON IR 전환 및 mermaid 제거 (PLAN-2026-09-04-diagram-rebuild.md).
// 기존 flowchart 관계도는 JSON IR v1 형식으로 변환하고(rider %% brise:* 주석 및 class 톤 흡수),
// flowchart가 아닌 것은 kind='text'로 바꾸며 ```mermaid\n...\n``` 코드블록으로 감싼다.
pub const V69_SQL: &str = "-- v69: migrate diagram sections to JSON IR";

// GRILL-2026-09-07 D2/D3/D4: note_dates — note_regions(V27)의 형제. notes.year/month/day 는
// 대표(사건 축)로 남고, 여기 행은 "이 노트가 걸리는 다른 날들"이다. D3: 날짜만(시각·알림·반복
// 컬럼 없음 — 벨 팝오버/분 단위 틱의 단일 판정 지점을 두 갈래로 쪼개지 않기 위해 의도적으로
// 얇다). note_regions 와 달리 순서 개념(position)이 없다 — date 오름차순이 자연 정렬.
pub const V70_SQL: &str = "\
CREATE TABLE note_dates (\n\
  id TEXT PRIMARY KEY,\n\
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  date TEXT NOT NULL,\n\
  label TEXT,\n\
  created_at TEXT NOT NULL\n\
);\n\
CREATE INDEX idx_note_dates_note_id ON note_dates(note_id);";

// 알림 미처리 통일(2026-09-07 오너 결정): 벨(dashboard::due_reminders)과 칸반 핀(board::is_pinned)이
// 서로 다른 "기준일" 규칙을 쓰고 있었다 — 발화 쪽(repo::schedule::anchor_date)은 시각 있으면
// 시작일·종일이면 종료일(없으면 시작일)인데, 핀은 종료 트리플이 없으면 무조건 거짓이었다. 그래서
// 종료일 없이 시작일만 있는 종일 알림은 시작일에 정상 발화하고도 미처리 목록엔 영영 안 잡혔다.
//
// board.rs 의 pin_sql 은 후보 축을 "종료일"에서 anchor_date 와 같은 규칙으로 넓힌다. end_sort_key
// (V44) 만으로는 이 새 후보(시각 있음 → 항상 시작일 기준, 또는 종료일 자체가 없어 시작일로
// 떨어지는 경우)를 놓친다 — 그 노트가 idx_notes_undated_updated_alive 의 updated_at 상위 cap+1
// 안에 없으면 세 티어 어디에도 안 걸려 통째로 빠진다(펫 5분 폴링과 벨은 이 인덱스를 안 거치므로
// 원래도 영향 없었지만, 칸반 핀은 이 축에 의존했다).
//
// pin_anchor_sort_key 는 end_sort_key 와 같은 채움 규칙(월/일 없으면 1)을 anchor_date 규칙에
// 적용한 것뿐이다 — 실제 핀 판정(오늘 비교 + 풀 정밀도 + checked_ord)은 여전히 전부 Rust
// (dashboard::board::is_pinned)가 한다. 이 컬럼은 후보 정렬/절단에만 쓰인다(pin_sql 은 여전히
// "후보"만 내려주고, 최종 판단은 Rust 몫이라는 V44 이후 설계는 그대로다).
//
// 옛 idx_notes_remind_end 는 지우지 않는다 — V44 마이그레이션 테스트가 신규 DB에 그 인덱스가
// 있다는 것을 이미 단언하고, 안 쓰이는 부분 인덱스 하나가 쓰기 경로에 더하는 비용은 무시할
// 수준이다. pin_sql 은 이제 아래 새 인덱스만 쓴다.
// SSOT 주석: specs/db/schemas/notes.sql.
//
// PLAN-2026-09-08-dates-rebuild.md W2(§2)에서 이 생성식이 V77 로 바뀐다 — "발화"(시각 있으면
// 시작일)와 "미처리"는 다른 질문이라는 게 그 웨이브의 결론이라, 이 CASE 의 `start_time` 분기는
// V77 에서 사라진다. 이 블록은 V71 당시의 역사적 기록으로 남긴다.
pub const V71_SQL: &str = "\
ALTER TABLE notes ADD COLUMN pin_anchor_sort_key INTEGER GENERATED ALWAYS AS ( \
CASE \
  WHEN start_time IS NOT NULL THEN year * 10000 + COALESCE(month, 1) * 100 + COALESCE(day, 1) \
  WHEN end_year IS NOT NULL THEN end_year * 10000 + COALESCE(end_month, 1) * 100 + COALESCE(end_day, 1) \
  ELSE year * 10000 + COALESCE(month, 1) * 100 + COALESCE(day, 1) \
END) VIRTUAL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_remind_anchor ON notes(pin_anchor_sort_key, updated_at DESC) \
WHERE deleted_at IS NULL AND archived_at IS NULL AND remind = 1;";

// GRILL-2026-09-07 D3 철회/D10: 관련 날짜(note_dates)에도 알림을 준다. notes.remind(V30)와 같은
// 모양 — 종일(시각·반복 없음)만 다루므로 컬럼 하나면 충분하다. 발화는 새 판정 지점을 만들지
// 않는다: repo::schedule::due_between 이 이 플래그가 선 행을 anchor 규칙(시작일=기준일, 시각
// 없음 → settings.reminder_all_day_at)에 맞춰 candidates() 와 같은 fire_times() 루프에 흘려보낸다.
pub const V72_SQL: &str =
    "ALTER TABLE note_dates ADD COLUMN remind INTEGER NOT NULL DEFAULT 0 CHECK(remind IN (0,1));";

// 2026-09-07: 관련 날짜도 기간을 가질 수 있다 — 오너의 정신 모델("날짜 목록 하나, 각 항목이
// 기간을 가질 수 있고, 첫 항목이 대표")과 대표(notes.year/month/day + end_*, 이미 기간을 가짐)가
// 어긋나 있었다. NULL = 단일 시점(기존 행 전부). 형식·달력 유효성·end_date>=date 관문은
// repo::notes::dates::date_add(parse_date 재사용) — DB 는 컬럼 존재만 보장한다.
pub const V73_SQL: &str = "ALTER TABLE note_dates ADD COLUMN end_date TEXT NULL;";

// 2026-09-07 오너 결정(specs/commands/notes.yaml::note_date_add): 라벨 전면 제거 — "그냥 노트
// 이름으로 다른 데서 출력되는 게 더 직관적". 날짜마다 이름을 붙이는 건 노트 제목과 경쟁하는
// 두 번째 이름층이었고, 달력에 "라벨 — 노트 제목"처럼 겹쳐 나왔다. 이 컬럼엔 CHECK도 인덱스도
// 없어(V70_SQL 참고) V29/V68 과 같은 조건으로 바로 DROP 가능 — rusqlite(bundled
// libsqlite3-sys, Cargo.lock)가 SQLite 3.35(DROP COLUMN 지원)를 한참 상회한다는 근거도 그대로다.
pub const V74_SQL: &str = "ALTER TABLE note_dates DROP COLUMN label;";

// PLAN-2026-09-07-reminder-2tier.md §3: 관련 날짜도 시각·알림 오프셋을 가질 수 있다 — 지금까지
// `repo::schedule::related_date_candidates` 가 `start_time_min: None, offset_min: 0` 을 하드코딩해
// 관련 날짜 알림이 전부 종일 한 시각에 뭉쳐 울렸다. CHECK 는 V42_SQL(notes.start_time/
// remind_offset_min)과 글자 그대로 같은 관문 — 형식/자릿수 모양까지만 SQL 이 거르고, 정확한
// 범위 검증은 Rust(repo::schedule::parse_hhmm_min, date_set_schedule 이 재사용)가 한다.
//
// **end_time 은 넣지 않는다** — 발화 엔진(schedule::mod.rs, dashboard::board.rs)이 어디서도
// notes.end_time 을 읽지 않는다(순수 표시값). 관련 날짜에 복제할 이유가 없다.
// **rrule 도 넣지 않는다** — D10("토글을 끄는 것이 완료")은 회차가 하나뿐이라는 전제 위에 서
// 있고, 반복은 그 전제를 깬다. 반복은 대표 날짜에만 둔다. 업그레이드 경로: 회차 상태를 먼저
// 설계한 뒤 그때 컬럼을 얹는다.
pub const V75_SQL: &str = "\
ALTER TABLE note_dates ADD COLUMN start_time TEXT NULL CHECK (start_time IS NULL OR (length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]'));\n\
ALTER TABLE note_dates ADD COLUMN remind_offset_min INTEGER NULL CHECK (remind_offset_min IS NULL OR (remind_offset_min >= 0 AND remind_offset_min <= 40320));";

// PLAN-2026-09-08-dates-rebuild.md W1: note_dates 를 "정밀도 사다리를 갖는 행 목록"으로 재편한다.
// position=0 행이 사건 축(대표) — notes.{year,month,day,end_*,remind,start_time,end_time,
// remind_offset_min,rrule} 을 그대로 미러링한다(repo::notes::dates::project_primary 가 그 투영을
// 갱신하는 유일한 통로). 옛 두 컬럼(note_dates.date/end_date, "YYYY-MM-DD" TEXT)은 트리플로 풀어
// position 1.. 로 옮기고 DROP 한다.
//
// 데이터 이관(노트마다 반복하는 backfill, 문자열→트리플 파싱)은 SQL 텍스트만으로 표현할 수 없어
// migrate_v69(V69, 다이어그램 IR 변환)와 같은 Rust 함수 경로를 쓴다 — V76_SQL 자체는 자리표시자
// 주석이고 실제 DDL+backfill은 migrate_v76() 안에 있다.
//
// CHECK 는 기존 컬럼의 CHECK 를 글자 그대로 재사용한다 — 새 검증 문법을 만들지 않는다: year 는
// notes.year(specs/db/schemas/notes.sql, `CHECK (year BETWEEN -9999 AND 9999)`), month/day/end_*
// 는 V23_SQL/V28_SQL, start_time/end_time/remind_offset_min 은 V42_SQL/V75_SQL.
//
// position 에 UNIQUE(note_id, position) 를 걸지 않는다 — note_regions(V27, 형제 테이블)의
// position 도 플레인 인덱스뿐이고 region_reorder 가 여러 행의 position 을 한 트랜잭션 안에서
// 겹치는 값을 거쳐 재배치한다(regions.rs 참고). date_make_primary 의 position 교환도 같은 이유로
// 중간 sentinel 값이 필요 없다 — UNIQUE 였다면 스왑 중간 상태에서 제약 위반이 났을 것이다.
pub const V76_SQL: &str = "-- v76: note_dates precision ladder (DDL + backfill run in migrate_v76, Rust fn)";

/// V76 본체 — CREATE 신규 테이블 → 노트마다 position=0 미러 행 backfill → 옛 note_dates 행을
/// 트리플로 풀어 position 1.. 로 backfill(note_id 별 date ASC, created_at ASC — 옛 dates_list 정렬과
/// 동일 순서, §7-2 "COUNT(notes) == COUNT(note_dates WHERE position=0)" 를 이 함수가 보장) → 옛
/// 테이블 DROP + RENAME. 손상된 날짜 문자열(수동 DB 편집 등)은 조용히 건너뛴다(패닉 대신 —
/// repo::schedule::candidates 의 `full()` 과 같은 자세) — 그 행은 유실되지만 마이그레이션 전체를
/// 막지는 않는다.
pub fn migrate_v76(tx: &rusqlite::Transaction) -> AppResult<()> {
    tx.execute_batch(
        "CREATE TABLE note_dates_new (\n\
          id TEXT PRIMARY KEY,\n\
          note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
          position INTEGER NOT NULL,\n\
          year INTEGER NOT NULL CHECK (year BETWEEN -9999 AND 9999),\n\
          month INTEGER NULL CHECK (month IS NULL OR (month >= 1 AND month <= 12)),\n\
          day INTEGER NULL CHECK (day IS NULL OR (day >= 1 AND day <= 31)),\n\
          end_year INTEGER NULL CHECK (end_year IS NULL OR (end_year >= -9999 AND end_year <= 9999)),\n\
          end_month INTEGER NULL CHECK (end_month IS NULL OR (end_month >= 1 AND end_month <= 12)),\n\
          end_day INTEGER NULL CHECK (end_day IS NULL OR (end_day >= 1 AND end_day <= 31)),\n\
          start_time TEXT NULL CHECK (start_time IS NULL OR (length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]')),\n\
          end_time TEXT NULL CHECK (end_time IS NULL OR (length(end_time) = 5 AND end_time GLOB '[0-2][0-9]:[0-5][0-9]')),\n\
          remind INTEGER NOT NULL DEFAULT 0 CHECK (remind IN (0,1)),\n\
          remind_offset_min INTEGER NULL CHECK (remind_offset_min IS NULL OR (remind_offset_min >= 0 AND remind_offset_min <= 40320)),\n\
          rrule TEXT NULL,\n\
          created_at TEXT NOT NULL\n\
        );",
    )
    .map_err(db)?;

    // position 0: 모든 노트의 사건 축을 그대로 미러링.
    #[allow(clippy::type_complexity)]
    let notes: Vec<(
        String,
        i64,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        i64,
        Option<i64>,
        Option<String>,
        String,
    )> = {
        let mut stmt = tx
            .prepare(
                "SELECT id, year, month, day, end_year, end_month, end_day, start_time, end_time, remind, remind_offset_min, rrule, created_at FROM notes",
            )
            .map_err(db)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, Option<i64>>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, String>(12)?,
                ))
            })
            .map_err(db)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db)?
    };
    for (id, year, month, day, ey, em, ed, start_time, end_time, remind, remind_offset_min, rrule, created_at) in &notes {
        tx.execute(
            "INSERT INTO note_dates_new(id, note_id, position, year, month, day, end_year, end_month, end_day, start_time, end_time, remind, remind_offset_min, rrule, created_at)
             VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                new_id(), id, year, month, day, ey, em, ed, start_time, end_time, remind, remind_offset_min, rrule, created_at
            ],
        )
        .map_err(db)?;
    }

    // 기존 note_dates 행("YYYY-MM-DD" TEXT) → 트리플, position 1.. (note_id 별 date ASC,
    // created_at ASC — 옛 dates_list 의 정렬과 동일 순서로 매긴다).
    #[allow(clippy::type_complexity)]
    let old_rows: Vec<(String, String, String, Option<String>, i64, String, Option<String>, Option<i64>)> = {
        let mut stmt = tx
            .prepare(
                "SELECT id, note_id, date, end_date, remind, created_at, start_time, remind_offset_min
                 FROM note_dates ORDER BY note_id, date ASC, created_at ASC",
            )
            .map_err(db)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                ))
            })
            .map_err(db)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db)?
    };
    let mut next_position: HashMap<String, i64> = HashMap::new();
    for (id, note_id, date, end_date, remind, created_at, start_time, remind_offset_min) in &old_rows {
        let pos_slot = next_position.entry(note_id.clone()).or_insert(1);
        let pos = *pos_slot;
        let Some(start) = crate::repo::notes::dates::parse_date(date) else {
            continue;
        };
        let end = end_date.as_deref().and_then(crate::repo::notes::dates::parse_date);
        tx.execute(
            "INSERT INTO note_dates_new(id, note_id, position, year, month, day, end_year, end_month, end_day, start_time, end_time, remind, remind_offset_min, rrule, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, NULL, ?13)",
            params![
                id,
                note_id,
                pos,
                start.y,
                start.m as i64,
                start.d as i64,
                end.map(|e| e.y),
                end.map(|e| e.m as i64),
                end.map(|e| e.d as i64),
                start_time,
                remind,
                remind_offset_min,
                created_at,
            ],
        )
        .map_err(db)?;
        *pos_slot += 1;
    }

    tx.execute_batch(
        "DROP TABLE note_dates;\n\
         ALTER TABLE note_dates_new RENAME TO note_dates;\n\
         CREATE INDEX idx_note_dates_note_id ON note_dates(note_id);",
    )
    .map_err(db)?;

    Ok(())
}

// PLAN-2026-09-08-dates-rebuild.md W2(§1.3/②): "발화"와 "미처리"는 서로 다른 질문인데 V71 의
// `pin_anchor_sort_key` 생성식은 옛 `schedule::anchor_date` 규칙(시각 있으면 시작일, 없으면
// 종료일)을 그대로 SQL 로 복제해뒀다 — Rust 쪽만 고치고 이 생성 컬럼을 그대로 두면 칸반 핀
// **정렬**(ORDER BY pin_anchor_sort_key)은 옛 규칙, **판정**(Rust is_pinned/pin_anchor_ord)은 새
// 규칙으로 갈린다. 새 규칙(미처리 = 종료일, 없으면 시작일)은 `start_time` 항이 필요 없어
// COALESCE(end_*, *) 로 단순해진다.
//
// 생성 컬럼은 값 자체가 아니라 **식**을 바꾸는 것이라 데이터 이관이 없다 — V76(note_dates)처럼
// 테이블을 통째로 새로 만들 필요 없이, 컬럼을 참조하는 부분 인덱스를 먼저 지우고(그래야 DROP
// COLUMN 이 막히지 않는다) 컬럼을 DROP 후 새 식으로 다시 ADD, 인덱스를 재생성한다 — V71 이 이미
// 증명한 두 연산(ADD COLUMN GENERATED ALWAYS, DROP COLUMN, 둘 다 V71/V74 선례)의 재사용일 뿐이라
// rusqlite(bundled libsqlite3-sys)가 이미 지원한다는 근거가 그대로 적용된다.
pub const V77_SQL: &str = "\
DROP INDEX idx_notes_remind_anchor;\n\
ALTER TABLE notes DROP COLUMN pin_anchor_sort_key;\n\
ALTER TABLE notes ADD COLUMN pin_anchor_sort_key INTEGER GENERATED ALWAYS AS ( \
CASE \
  WHEN end_year IS NOT NULL THEN end_year * 10000 + COALESCE(end_month, 1) * 100 + COALESCE(end_day, 1) \
  ELSE year * 10000 + COALESCE(month, 1) * 100 + COALESCE(day, 1) \
END) VIRTUAL;\n\
CREATE INDEX IF NOT EXISTS idx_notes_remind_anchor ON notes(pin_anchor_sort_key, updated_at DESC) \
WHERE deleted_at IS NULL AND archived_at IS NULL AND remind = 1;";

// v78: 기본 글꼴 serif → 번들 Pretendard (오너 2026-09-09, "가독성이 뛰어난 폰트를 활용").
// 시드(settings_schema::default_settings)는 **키가 없을 때만** 쓰이므로 기본값만 바꾸면 이미
// 설치된 앱은 영원히 serif 로 남는다 — V37_SQL(close_to_tray false→true) 과 같은 형태의 값
// 이관이 필요한 이유다. `value = '"serif"'` 조건을 달아 사용자가 직접 고른 다른 글꼴(sans·
// 시스템 글꼴명·직접 입력)은 건드리지 않는다. serif 로 되돌리고 싶으면 설정 > 모양 > 글꼴에서
// 다시 고르면 되고, 이 마이그레이션은 한 번만 돈다.
pub const V78_SQL: &str =
    "UPDATE settings SET value = '\"pretendard\"' WHERE key = 'font_family' AND value = '\"serif\"';";

// v79: 섹션 휴지통 (docs/PLAN-2026-09-10-section-dnd-trash.md D4). 지운 섹션 행을 통째로 옮겨
// 담는 **별도 테이블**이다 — `sections` 에 `deleted_at` 을 넣지 않는 이유는 `FROM sections` 가
// Rust 에 69곳이고 그 전부에 `deleted_at IS NULL` 을 달아야 하는데 하나만 빠져도 지운 섹션이
// 검색·내보내기·AI 컨텍스트에 유령으로 남기 때문. 별도 테이블은 기존 쿼리 변경 0.
// note_id FK CASCADE: 노트를 완전 삭제하면 그 노트의 휴지통 섹션도 함께 사라진다(복구 대상이
// 사라졌으므로). 인덱스는 목록 정렬 축(deleted_at desc) 하나뿐 — 휴지통은 작다.
pub const V79_SQL: &str = "\
CREATE TABLE section_trash (\n\
  id         TEXT PRIMARY KEY,\n\
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  name       TEXT NOT NULL,\n\
  body_md    TEXT NOT NULL,\n\
  kind       TEXT NOT NULL,\n\
  position   INTEGER NOT NULL,\n\
  ai_origin  TEXT NULL,\n\
  deleted_at TEXT NOT NULL\n\
);\n\
CREATE INDEX idx_section_trash_deleted ON section_trash(deleted_at);";

// v80: 참조 첨부 — 앱 폴더 밖 원본을 복사하지 않고 절대경로만 들고 있는 파일 첨부(1GB pptx 를
// 200MB 상한에 걸려 못 붙이던 자리). 파일 kind 는 이제 rel_path(복사본) 와 ext_path(원본 참조)
// 중 **정확히 하나**를 갖는다 — SQLite 는 CHECK 를 ALTER 못 하므로 V4/V34 와 같은 테이블 재생성.
// 보존 컬럼: id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash.
// 참조 첨부의 content_hash 는 NULL 로 남는다(1GB 를 추가 시점에 해싱하면 앱이 멈춘다).
pub const V80_SQL: &str = "\
CREATE TABLE attachments_new (\n\
  id         TEXT PRIMARY KEY,\n\
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  name       TEXT NOT NULL,\n\
  kind       TEXT NOT NULL CHECK (kind IN ('image','doc','link','audio','note','internal','footnote')),\n\
  rel_path   TEXT,\n\
  url        TEXT,\n\
  size_bytes INTEGER,\n\
  position   INTEGER NOT NULL DEFAULT 0,\n\
  created_at TEXT NOT NULL,\n\
  content_hash TEXT NULL,\n\
  ext_path   TEXT NULL,\n\
  CHECK ((kind IN ('link','internal') AND url IS NOT NULL AND rel_path IS NULL AND ext_path IS NULL)\n\
      OR (kind = 'footnote' AND rel_path IS NOT NULL AND ext_path IS NULL)\n\
      OR (kind NOT IN ('link','internal','footnote') AND url IS NULL\n\
          AND ((rel_path IS NOT NULL) <> (ext_path IS NOT NULL))))\n\
);\n\
INSERT INTO attachments_new (id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)\n\
  SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash FROM attachments;\n\
DROP TABLE attachments;\n\
ALTER TABLE attachments_new RENAME TO attachments;\n\
CREATE INDEX idx_attachments_note ON attachments(note_id, position);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_kind_created ON attachments(kind, created_at);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_internal_url ON attachments(url) WHERE kind='internal';";

// v81: 사료 본문이 추출 상한(1MB)에 걸려 잘렸는지. 본문은 DB 에 남으므로 그 사실도 행에 남아야
// 조회할 때마다 말할 수 있다 — 본문 안에 문구를 박으면 저장 시점 로케일로 굳어 다른 로케일
// 사용자에게 잘못된 데이터가 된다(pptx `## Slide N` 을 en 고정으로 둔 것과 같은 이유).
// 기존 행은 0 — 잘렸는지 알 방법이 없고, 없는 사실을 지어내는 것보다 낫다.
pub const V81_SQL: &str = "ALTER TABLE sources ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;";

// v82: 시간축 반복 일정(그릴 2026-09-13 W3) — SSOT는 specs/db/schemas/timeline_routines.sql
// (그 파일 헤더에 weekday_mask 비트 순서·범위 v1 결정이 있다).
pub const V82_SQL: &str = include_str!("../../../specs/db/schemas/timeline_routines.sql");

// v83: 타임라인 루틴에 공휴일 skip 옵션(그릴 2026-09-13 후속). v82가 이미 커밋된 뒤라 CREATE를
// 고치지 않고 ALTER로 얹는다(이 파일의 일관된 관례 — v4/v5 등 참고). 기본값 0(끔) — 기존 루틴은
// 공휴일에도 그대로 보인다(동작 변화 없음, 명시적으로 켜야 skip한다).
pub const V83_SQL: &str =
    "ALTER TABLE timeline_routines ADD COLUMN skip_holidays INTEGER NOT NULL DEFAULT 0 CHECK (skip_holidays IN (0,1));";

// v84: 더보기 메뉴 "내용잠금"(용어집: "내용"=섹션/본문) — is_favorite와 같은 패턴으로 CREATE는
// 건드리지 않고 ALTER로 얹는다 (SSOT 주석: specs/db/schemas/notes.sql). 기본값 0(해제) — 기존
// 노트는 전부 편집 가능한 채로 남는다.
pub const V84_SQL: &str =
    "ALTER TABLE notes ADD COLUMN content_locked INTEGER NOT NULL DEFAULT 0 CHECK (content_locked IN (0,1));";

// v85 (PLAN-2026-09-18-nl-dates.md D1): note_dates.label 부활 — V74(위, v74_drops_note_dates_label)가
// 드롭했던 컬럼을 되돌린다. 이유가 그때와 다르다: V74 당시는 "노트 이름으로 충분하다"(한 노트=한
// 사건 가정)였지만, 이번 요청은 한 노트 안에 관련 날짜가 여러 개(여행 일정의 날짜별 행선지, 서류
// 일정의 접수/발급/만료) 있는 용도라 행마다 구분할 이름이 필요하다. V29/V68/V74와 같은 ALTER-only
// 관례, 기본값 NULL — 기존 행(과 대표 행, D2)은 라벨 없이 지금과 똑같이 보인다
// (`label ?? 노트 제목`, 프런트 표시 규칙).
pub const V85_SQL: &str = "ALTER TABLE note_dates ADD COLUMN label TEXT NULL;";

// v86 (PLAN-2026-09-19-notebook-settings.md): 노트북별 설정. 테이블 SSOT 는
// specs/db/schemas/workspace_settings.sql. 뒤따르는 두 문장이 업그레이드를 **무변화**로 만든다:
// 지금 전역에 저장된 노트북 키 값을 모든 기존 노트북에 복사하고 전역 행을 지운다 — 어느 노트북도
// 모양·언어가 바뀌지 않는다. 저장된 적 없는 키(= 기본값)는 복사할 것이 없어 그대로 기본값이다.
// 키 목록은 그 시점 `settings_schema::NOTEBOOK_KEYS` 의 **동결 사본**이다(마이그레이션은 과거 사실
// 이라 상수를 참조하지 않는다 — 목록이 자라도 이 SQL 의 의미가 바뀌면 안 된다). 짝 테스트
// `v86_key_list_matches_notebook_keys` 가 적용 시점의 일치를 고정한다.
macro_rules! v86_keys {
    () => {
        "'theme','accent','font_family','font_scale','bg_dim','bg_tone','bg_sat','content_tint','surface_style','sheet_alpha','ui_lang','spellcheck_enabled','translate_enabled','translate_target_lang','phrase_pack_id','week_start','holiday_region','region_enabled','region_nudge_strict','date_nudge_auto','editor_full_width','filter_roster','link_suggestions','status_add_locked','source_original_policy','slide_preview','ai_enabled','ai_policy_level','ai_post_process','ai_confirm_before_apply','ai_chat_memory','chat_memory','chat_write_enabled','chat_read_history','chat_read_files'"
    };
}
pub const V86_KEYS: &str = v86_keys!();
pub const V86_SQL: &str = concat!(
    include_str!("../../../specs/db/schemas/workspace_settings.sql"),
    "\nINSERT INTO workspace_settings(workspace_id, key, value) SELECT w.id, s.key, s.value",
    " FROM workspaces w CROSS JOIN settings s WHERE s.key IN (",
    v86_keys!(),
    ");\nDELETE FROM settings WHERE key IN (",
    v86_keys!(),
    ");\n"
);

// v87 (PLAN-2026-09-19-calendar-schedule.md W1): 달력 표시일 — 공휴일·기념일 이름표와 불러온 캘린더,
// 하루 숨기기. SSOT: specs/db/schemas/calendar_marks.sql. 새 테이블뿐이라 기존 행에 영향 없음.
pub const V87_SQL: &str = include_str!("../../../specs/db/schemas/calendar_marks.sql");

// v89 (PLAN-2026-09-30-briefing.md D1): 브리핑 습관 — habits + habit_checks. SSOT: specs/db/schemas/habits.sql.
// 새 테이블뿐이라 기존 행에 영향 없음. ANALYZE 는 붙이지 않는다 — V21 주석 참조.
pub const V89_SQL: &str = include_str!("../../../specs/db/schemas/habits.sql");

// v90 (PLAN-2026-09-30-briefing.md W7): 수집 출처 속성 — notes.origin_source_id(FK 없음: collect_seen 과
// 같은 이유로 소스 삭제 뒤에도 남는다)·collected_at. 수집 커밋 경로(collect::ingest_item_with_note_id)만
// 채운다. 부분 인덱스는 "수집으로 들어온 살아있는 노트"만. ANALYZE 는 붙이지 않는다 — V21 주석 참조.
pub const V90_SQL: &str = "ALTER TABLE notes ADD COLUMN origin_source_id TEXT NULL;
ALTER TABLE notes ADD COLUMN collected_at TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_collected_alive ON notes(collected_at) WHERE collected_at IS NOT NULL AND deleted_at IS NULL;
";

// v91 (PLAN-2026-09-30-briefing.md W10): 습관 시간대 — habits.time_of_day('any'|'morning'|'evening').
// 단일 컬럼 CHECK 의 ALTER ADD COLUMN(기존 행은 'any'). ANALYZE 는 붙이지 않는다 — V21 주석 참조.
pub const V91_SQL: &str = "ALTER TABLE habits ADD COLUMN time_of_day TEXT NOT NULL DEFAULT 'any' CHECK (time_of_day IN ('any','morning','evening'));
";

// v92 (PLAN-2026-09-30-briefing.md E3): 수집 소스별 "브리핑에 표시" — collect_sources.show_in_briefing.
// 단일 컬럼 CHECK 의 ALTER ADD COLUMN(기존 행은 1=표시). ANALYZE 는 붙이지 않는다 — V21 주석 참조.
pub const V92_SQL: &str = "ALTER TABLE collect_sources ADD COLUMN show_in_briefing INTEGER NOT NULL DEFAULT 1 CHECK (show_in_briefing IN (0,1));
";

// v93 (PLAN-2026-10-06-s2-input.md §5.3-3): 오디오 전사 — attachments.transcript(전사 원문, NULL=아직 없음)·
// transcript_inserted(본문에 삽입했는지). 서버가 노트 본문을 직접 쓰지 않으므로(D2② 없음) 결과를 첨부 행에 두고
// 클라이언트가 삽입한다. 단순 ADD COLUMN 두 개라 테이블 재생성 불필요(CHECK 무변경). ANALYZE 는 붙이지 않는다 — V21 주석 참조.
pub const V93_SQL: &str = "ALTER TABLE attachments ADD COLUMN transcript TEXT NULL;
ALTER TABLE attachments ADD COLUMN transcript_inserted INTEGER NOT NULL DEFAULT 0;
";

// v94 (HANDOFF-2026-10-08-chat-search-perf.md Wave B): 2글자 낱말 색인 — 채팅 질문 검색의 2글자 핵심어가
// notes_fts 네 열 LIKE 전체 스캔이던 것을 색인 조회로. DDL SSOT = specs/db/schemas/fts_bigram.sql.
// 기존 노트 백필은 SQL 로 표현할 수 없어(2글자 창 분해) migrate_v94 가 notes_fts 에서 만든다 — 2026-10-12 부터
// **V95 단계에서 한 번만** 돈다(apply 참고). V94 단계는 빈 표만 만든다.
pub const V94_SQL: &str = include_str!("../../../specs/db/schemas/fts_bigram.sql");

/// V94 백필 — 테이블을 만든 SQL 다음에 같은 트랜잭션에서. notes_fts 가 색인의 원천이라 그대로 다시 만든다.
pub fn migrate_v94(tx: &rusqlite::Transaction) -> AppResult<()> {
    crate::repo::fts::bigram_rebuild_all(tx)
}

// v95 (2026-10-09, 질문 검색 3자 이상 경로): notes_bigram_map.id 를 그 노트의 notes_fts rowid 로 맞추고, 창이 없는
// 노트에도 매핑 행을 둔다(fts_bigram.sql). 질문 검색이 trigram MATCH 의 rowid 로 note_id 를 찾게 — note_id 열을
// 읽으면 FTS5 가 맞은 행마다 본문까지 읽어 5000건에 ~19ms 였다. 스키마는 그대로, 색인만 다시 만든다(V94 와 같은 백필).
// V94 를 고치지 않고 새 버전인 이유: 이미 V94 를 적용한 개발 DB 는 V94 를 다시 돌지 않는다.
pub const V95_SQL: &str = "";

// v96 (2026-10-26, 초기화 구조 정리 트랙 A): 수집 소스가 자기 노트북보다 오래 살지 않게 — V40 이 FK 없이
// 만든 collect_sources.workspace_id → workspaces(id) ON DELETE CASCADE, collect_seen.source_id →
// collect_sources(id) ON DELETE CASCADE. 노트북 삭제(repo::workspaces::delete)가 소스를 남겨 러너가 없는
// 노트북으로 계속 수집하던 고아가 생겼다. SQLite 는 FK 를 ALTER 못 하므로 V88 과 같은 테이블 재생성이고,
// 재생성하면서 이미 생긴 고아(노트북이 없는 소스, 소스가 없는 seen 행)는 버린다. 보존 컬럼 = V40 의 열한 개 +
// V60 다섯 개 + V92 show_in_briefing. 순서가 중요하다 — 부모(collect_sources)를 먼저 갈아끼우고 seen 을
// 나중에 만든다: CASCADE 자식이 먼저 있으면 foreign_keys=ON 에서 옛 부모 DROP(암묵 DELETE)이 자식을
// 같이 지운다. 인덱스는 DROP TABLE 이 같이 날리므로 다시 만든다(seen 은 PK 선두가 source_id 라 별도 불필요).
// ANALYZE 는 붙이지 않는다 — V21 주석 참조.
pub const V96_SQL: &str = "CREATE TABLE collect_sources_v96 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  target_folder_id TEXT NULL,
  post_process TEXT NOT NULL DEFAULT 'none',
  post_process_model TEXT NULL,
  interval_minutes INTEGER NULL,
  show_in_briefing INTEGER NOT NULL DEFAULT 1 CHECK (show_in_briefing IN (0,1))
);
INSERT INTO collect_sources_v96 (id, workspace_id, kind, name, config, enabled, last_run_at, last_status, last_error,
    created_at, updated_at, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, show_in_briefing)
  SELECT id, workspace_id, kind, name, config, enabled, last_run_at, last_status, last_error,
    created_at, updated_at, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, show_in_briefing
  FROM collect_sources WHERE workspace_id IN (SELECT id FROM workspaces);
DROP TABLE collect_sources;
ALTER TABLE collect_sources_v96 RENAME TO collect_sources;
CREATE INDEX idx_collect_sources_workspace ON collect_sources(workspace_id);
CREATE TABLE collect_seen_v96 (
  source_id TEXT NOT NULL REFERENCES collect_sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  PRIMARY KEY (source_id, guid)
);
INSERT INTO collect_seen_v96 (source_id, guid)
  SELECT source_id, guid FROM collect_seen WHERE source_id IN (SELECT id FROM collect_sources);
DROP TABLE collect_seen;
ALTER TABLE collect_seen_v96 RENAME TO collect_seen;";

// v88 (PLAN-2026-09-20 §2.3, D5): 시트 차트 **라이브 참조** 첨부 — kind='chart',
// url = "<section_id>#<chart_id>", 파일 없음(열 때마다 시트에서 재계산). SQLite 는 CHECK 를 ALTER
// 못 하므로 V80 과 같은 테이블 재생성. url 전용 arm 이 ('link','internal') → ('link','internal','chart').
// 보존 컬럼은 V80 의 열 개 + ext_path(V80 이 만든 열이라 이번엔 SELECT 에 포함). 인덱스 4종 재생성
// (DROP TABLE 이 같이 날린다 — V64 의 internal 부분 인덱스 포함).
pub const V88_SQL: &str = "\
CREATE TABLE attachments_new (\n\
  id         TEXT PRIMARY KEY,\n\
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,\n\
  name       TEXT NOT NULL,\n\
  kind       TEXT NOT NULL CHECK (kind IN ('image','doc','link','audio','note','internal','footnote','chart')),\n\
  rel_path   TEXT,\n\
  url        TEXT,\n\
  size_bytes INTEGER,\n\
  position   INTEGER NOT NULL DEFAULT 0,\n\
  created_at TEXT NOT NULL,\n\
  content_hash TEXT NULL,\n\
  ext_path   TEXT NULL,\n\
  CHECK ((kind IN ('link','internal','chart') AND url IS NOT NULL AND rel_path IS NULL AND ext_path IS NULL)\n\
      OR (kind = 'footnote' AND rel_path IS NOT NULL AND ext_path IS NULL)\n\
      OR (kind NOT IN ('link','internal','chart','footnote') AND url IS NULL\n\
          AND ((rel_path IS NOT NULL) <> (ext_path IS NOT NULL))))\n\
);\n\
INSERT INTO attachments_new (id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash, ext_path)\n\
  SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash, ext_path FROM attachments;\n\
DROP TABLE attachments;\n\
ALTER TABLE attachments_new RENAME TO attachments;\n\
CREATE INDEX idx_attachments_note ON attachments(note_id, position);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_kind_created ON attachments(kind, created_at);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);\n\
CREATE INDEX IF NOT EXISTS idx_attachments_internal_url ON attachments(url) WHERE kind='internal';";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramIrNode {
    pub id: String,
    pub label: String,
    pub shape: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<[i64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiagramIrEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub line: String,
    pub arrow: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiagramIrGroup {
    pub id: String,
    pub title: String,
    pub parent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramIr {
    pub v: i64,
    pub route: String,
    pub states: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag_label: Option<String>,
    pub nodes: Vec<DiagramIrNode>,
    pub edges: Vec<DiagramIrEdge>,
    pub groups: Vec<DiagramIrGroup>,
}

// 순서가 핵심: 더 길고 구체적인 래퍼를 먼저 시도해야 한다. 안 그러면 예:
// `[("메인 DB")]` (실린더) 이 `[`/`]` 만 벗기는 rect 로 잘못 매칭돼 라벨에
// `("메인 DB")` 가 그대로 샌다 (v69 실측 버그, 2026-09-04).
const SHAPES: [(&str, &str, &str); 14] = [
    ("circle", "(((", ")))"),  // 이중 원
    ("circle", "((", "))"),
    ("circle", "[(", ")]"),    // 실린더(DB)
    ("stadium", "([", "])"),
    ("rect", "[[", "]]"),      // 서브루틴
    ("rect", "[/", "/]"),      // 평행사변형
    ("rect", "[\\", "\\]"),    // 평행사변형(역)
    ("rect", "[/", "\\]"),     // 사다리꼴
    ("rect", "[\\", "/]"),     // 사다리꼴(역)
    ("rect", ">", "]"),        // 비대칭 플래그
    ("diamond", "{{", "}}"),   // 육각형
    ("rect", "[", "]"),
    ("round", "(", ")"),
    ("diamond", "{", "}"),
];

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    let inner = if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        &s[1..s.len() - 1]
    } else {
        s
    };
    inner.replace("#quot;", "\"")
}

struct ParsedNodeToken {
    id: String,
    label: String,
    shape: &'static str,
    declared: bool,
}

fn parse_node_token(token: &str) -> Option<ParsedNodeToken> {
    let tok = token.trim();
    if tok.is_empty() {
        return None;
    }
    let id_len = tok
        .char_indices()
        .take_while(|(_, c)| {
            !c.is_whitespace()
                && *c != '['
                && *c != ']'
                && *c != '('
                && *c != ')'
                && *c != '{'
                && *c != '}'
                && *c != '<'
                && *c != '>'
                && *c != '|'
                && *c != '&'
                && *c != '"'
                && *c != ';'
        })
        .map(|(idx, c)| idx + c.len_utf8())
        .last()
        .unwrap_or(0);

    if id_len == 0 {
        return None;
    }

    let id = tok[..id_len].to_string();
    let rest = tok[id_len..].trim().trim_end_matches(';').trim();

    if rest.is_empty() {
        return Some(ParsedNodeToken {
            label: id.clone(),
            id,
            shape: "rect",
            declared: false,
        });
    }

    for &(shape, open, close) in &SHAPES {
        if rest.len() >= open.len() + close.len()
            && rest.starts_with(open)
            && rest.ends_with(close)
        {
            let inner = &rest[open.len()..rest.len() - close.len()];
            return Some(ParsedNodeToken {
                id,
                label: unquote(inner),
                shape,
                declared: true,
            });
        }
    }

    None
}

struct Conn {
    text: String,
    label: Option<String>,
}

struct ScannedLine {
    segments: Vec<String>,
    conns: Vec<Conn>,
}

const CONNECTOR_CHARS: [char; 5] = ['-', '.', '=', '<', '>'];

fn scan_line(line: &str) -> ScannedLine {
    let mut segments = Vec::new();
    let mut conns = Vec::new();
    let mut current = String::new();
    let mut depth = 0;
    let mut quoted = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if quoted {
            current.push(c);
            if c == '"' {
                quoted = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            quoted = true;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '[' || c == '(' || c == '{' {
            depth += 1;
            current.push(c);
            i += 1;
            continue;
        }
        if c == ']' || c == ')' || c == '}' {
            if depth > 0 {
                depth -= 1;
            }
            current.push(c);
            i += 1;
            continue;
        }
        if depth == 0 && CONNECTOR_CHARS.contains(&c) {
            let mut j = i;
            while j < chars.len() && CONNECTOR_CHARS.contains(&chars[j]) {
                j += 1;
            }
            if j - i >= 2 {
                segments.push(current);
                let conn_text: String = chars[i..j].iter().collect();
                conns.push(Conn {
                    text: conn_text,
                    label: None,
                });
                current = String::new();
                i = j;
                continue;
            }
        }
        if depth == 0 && c == '|' {
            let mut end = None;
            let mut q = false;
            for j in (i + 1)..chars.len() {
                if chars[j] == '"' {
                    q = !q;
                } else if chars[j] == '|' && !q {
                    end = Some(j);
                    break;
                }
            }
            if let Some(end_idx) = end {
                if let Some(owner) = conns.last_mut() {
                    if current.trim().is_empty() {
                        let pipe_label: String = chars[(i + 1)..end_idx].iter().collect();
                        owner.label = Some(unquote(&pipe_label));
                        current = String::new();
                        i = end_idx + 1;
                        continue;
                    }
                }
                i = end_idx + 1;
                continue;
            }
        }
        current.push(c);
        i += 1;
    }
    segments.push(current);
    ScannedLine { segments, conns }
}

fn map_conn_style(conn: &str) -> (&'static str, &'static str) {
    if conn.starts_with('<') {
        ("solid", "both")
    } else if conn.contains('.') {
        ("dotted", "end")
    } else if conn.contains('=') {
        ("thick", "end")
    } else if !conn.ends_with('>') {
        ("solid", "none")
    } else {
        ("solid", "end")
    }
}

pub fn is_flowchart(source: &str) -> bool {
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("%%") {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        return lower.starts_with("flowchart") || lower.starts_with("graph");
    }
    true
}

pub fn convert_mermaid_flowchart_to_json(source: &str) -> AppResult<String> {
    let lines: Vec<&str> = source.lines().collect();

    let mut groups: Vec<DiagramIrGroup> = Vec::new();
    let mut group_stack: Vec<String> = Vec::new();
    let mut line_to_group: HashMap<usize, String> = HashMap::new();

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("%%") || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("subgraph") {
            let rest = trimmed["subgraph".len()..].trim().trim_end_matches(';').trim();
            let (gid, gtitle) = if let Some(tok) = parse_node_token(rest) {
                (tok.id, tok.label)
            } else {
                let unq = unquote(rest);
                (unq.clone(), unq)
            };
            let parent = group_stack.last().cloned();
            groups.push(DiagramIrGroup {
                id: gid.clone(),
                title: gtitle,
                parent,
            });
            group_stack.push(gid.clone());
            line_to_group.insert(idx, gid);
        } else if trimmed == "end" || trimmed.starts_with("end;") {
            group_stack.pop();
        }
    }

    let mut links: HashMap<String, String> = HashMap::new();
    let mut positions: HashMap<String, [i64; 2]> = HashMap::new();
    let mut metas: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    let mut node_flags: HashMap<String, bool> = HashMap::new();
    let mut node_states: HashMap<String, i64> = HashMap::new();

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with("%%") {
            if let Some(pos) = trimmed.find("brise:link") {
                let rest = trimmed[pos + "brise:link".len()..].trim();
                if let Some((nid, note_id)) = rest.split_once('=') {
                    links.insert(nid.trim().to_string(), note_id.trim().to_string());
                }
            } else if let Some(pos) = trimmed.find("brise:pos") {
                let rest = trimmed[pos + "brise:pos".len()..].trim();
                if let Some((nid, coords)) = rest.split_once('=') {
                    if let Some((x_str, y_str)) = coords.split_once(',') {
                        if let (Ok(x), Ok(y)) = (x_str.trim().parse::<i64>(), y_str.trim().parse::<i64>()) {
                            positions.insert(nid.trim().to_string(), [x, y]);
                        }
                    }
                }
            } else if let Some(pos) = trimmed.find("brise:meta") {
                let rest = trimmed[pos + "brise:meta".len()..].trim();
                if let Some((nid, json_str)) = rest.split_once('=') {
                    if let Ok(v) = serde_json::from_str::<Value>(json_str.trim()) {
                        let icon = v.get("icon").and_then(|i| i.as_str()).map(|s| s.to_string());
                        let desc = v.get("desc").and_then(|d| d.as_str()).map(|s| s.to_string());
                        metas.insert(nid.trim().to_string(), (icon, desc));
                    }
                }
            }
        } else if trimmed.starts_with("class ") {
            let rest = trimmed["class ".len()..].trim().trim_end_matches(';').trim();
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                let class_name = parts[parts.len() - 1];
                let ids_part = parts[..parts.len() - 1].join(" ");
                for id in ids_part.split(',') {
                    let clean_id = id.trim();
                    if clean_id.is_empty() {
                        continue;
                    }
                    match class_name {
                        "briseAccent" => {
                            node_flags.insert(clean_id.to_string(), true);
                        }
                        "briseWarn" => {
                            node_states.insert(clean_id.to_string(), 0);
                        }
                        "briseDone" => {
                            node_states.insert(clean_id.to_string(), 1);
                        }
                        "briseMuted" => {
                            node_states.insert(clean_id.to_string(), 2);
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let mut nodes: Vec<DiagramIrNode> = Vec::new();
    let mut node_idx_by_id: HashMap<String, usize> = HashMap::new();
    let mut edges: Vec<DiagramIrEdge> = Vec::new();
    let mut active_group_stack: Vec<String> = Vec::new();

    for (line_idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("%%") {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("flowchart") || lower.starts_with("graph") {
            continue;
        }
        if trimmed.starts_with("subgraph") {
            if let Some(gid) = line_to_group.get(&line_idx) {
                active_group_stack.push(gid.clone());
            }
            continue;
        }
        if trimmed == "end" || trimmed.starts_with("end;") {
            active_group_stack.pop();
            continue;
        }
        if trimmed.starts_with("classDef")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("style ")
            || trimmed.starts_with("linkStyle ")
            || trimmed.starts_with("click ")
            || trimmed.starts_with("direction ")
            || trimmed.starts_with("accTitle ")
            || trimmed.starts_with("accDescr ")
        {
            continue;
        }

        let scanned = scan_line(trimmed);
        let cur_group = active_group_stack.last().cloned();

        let mut add_or_update_node = |tok: ParsedNodeToken| {
            if let Some(&idx) = node_idx_by_id.get(&tok.id) {
                let node = &mut nodes[idx];
                if node.group.is_none() && cur_group.is_some() {
                    node.group = cur_group.clone();
                }
                if tok.declared && tok.label != node.id {
                    node.label = tok.label;
                    node.shape = tok.shape.to_string();
                }
            } else {
                let id = tok.id.clone();
                let icon_desc = metas.get(&id);
                let (icon, desc) = match icon_desc {
                    Some((i, d)) => (i.clone(), d.clone()),
                    None => (None, None),
                };
                let pos = positions.get(&id).copied();
                let link = links.get(&id).cloned();
                let flag = node_flags.get(&id).copied();
                let state = node_states.get(&id).copied();

                let node = DiagramIrNode {
                    id: id.clone(),
                    label: tok.label,
                    shape: tok.shape.to_string(),
                    icon,
                    desc,
                    tag: None,
                    state,
                    flag,
                    pos,
                    group: cur_group.clone(),
                    link,
                };
                let idx = nodes.len();
                nodes.push(node);
                node_idx_by_id.insert(id, idx);
            }
        };

        if scanned.conns.is_empty() {
            if let Some(tok) = parse_node_token(trimmed) {
                add_or_update_node(tok);
            }
            continue;
        }

        let inline = scanned.conns.len() == 2
            && !scanned.conns[0].text.contains('>')
            && scanned.conns[1].text.contains('>');

        if inline {
            let from_seg = &scanned.segments[0];
            let to_seg = &scanned.segments[2];
            let label = scanned.segments[1].trim();
            let label_opt = if label.is_empty() {
                None
            } else {
                Some(unquote(label))
            };

            let conn_text = format!("{}{}", scanned.conns[0].text, scanned.conns[1].text);
            let (line_style, arrow_style) = map_conn_style(&conn_text);

            if let (Some(tok_from), Some(tok_to)) = (parse_node_token(from_seg), parse_node_token(to_seg)) {
                let from_id = tok_from.id.clone();
                let to_id = tok_to.id.clone();
                add_or_update_node(tok_from);
                add_or_update_node(tok_to);

                let edge_id = format!("e{}", edges.len() + 1);
                edges.push(DiagramIrEdge {
                    id: edge_id,
                    from: from_id,
                    to: to_id,
                    label: label_opt,
                    line: line_style.to_string(),
                    arrow: arrow_style.to_string(),
                });
            }
        } else {
            for (k, conn) in scanned.conns.iter().enumerate() {
                if k + 1 >= scanned.segments.len() {
                    break;
                }
                let from_seg = &scanned.segments[k];
                let to_seg = &scanned.segments[k + 1];

                let (line_style, arrow_style) = map_conn_style(&conn.text);
                let label_opt = conn.label.as_ref().filter(|s| !s.is_empty()).cloned();

                if let (Some(tok_from), Some(tok_to)) = (parse_node_token(from_seg), parse_node_token(to_seg)) {
                    let from_id = tok_from.id.clone();
                    let to_id = tok_to.id.clone();
                    add_or_update_node(tok_from);
                    add_or_update_node(tok_to);

                    let edge_id = format!("e{}", edges.len() + 1);
                    edges.push(DiagramIrEdge {
                        id: edge_id,
                        from: from_id,
                        to: to_id,
                        label: label_opt,
                        line: line_style.to_string(),
                        arrow: arrow_style.to_string(),
                    });
                }
            }
        }
    }

    let ir = DiagramIr {
        v: 1,
        route: "curve".to_string(),
        states: vec![
            "강조".to_string(),
            "주의".to_string(),
            "완료".to_string(),
            "흐리게".to_string(),
        ],
        flag_label: None,
        nodes,
        edges,
        groups,
    };

    serde_json::to_string(&ir).map_err(|e| crate::error::AppError::Validation(e.to_string()))
}

pub fn migrate_v69(tx: &rusqlite::Transaction) -> AppResult<()> {
    let mut stmt = tx
        .prepare("SELECT id, note_id, body_md FROM sections WHERE kind = 'diagram'")
        .map_err(db)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;

    let mut affected_note_ids: HashSet<String> = HashSet::new();

    for (id, note_id, body_md) in rows {
        affected_note_ids.insert(note_id);
        if is_flowchart(&body_md) {
            let json = convert_mermaid_flowchart_to_json(&body_md)?;
            tx.execute(
                "UPDATE sections SET body_md = ?1 WHERE id = ?2",
                rusqlite::params![json, id],
            )
            .map_err(db)?;
        } else {
            let wrapped = format!("```mermaid\n{body_md}\n```");
            tx.execute(
                "UPDATE sections SET kind = 'text', body_md = ?1 WHERE id = ?2",
                rusqlite::params![wrapped, id],
            )
            .map_err(db)?;
        }
    }

    for nid in affected_note_ids {
        // V69 시점엔 2글자 색인 표가 없다 — 현재 fts_upsert 를 부르면 `no such table`(P0-1).
        crate::repo::fts::fts_upsert_fts_only(tx, &nid)?;
    }

    Ok(())
}

pub fn migrations() -> Vec<(i64, &'static str)> {
    vec![
        (1, V1_SQL),
        (2, V2_SQL),
        (3, V3_SQL),
        (4, V4_SQL),
        (5, V5_SQL),
        (6, V6_SQL),
        (7, V7_SQL),
        (8, V8_SQL),
        (9, V9_SQL),
        (10, V10_SQL),
        (11, V11_SQL),
        (12, V12_SQL),
        (13, V13_SQL),
        (14, V14_SQL),
        (15, V15_SQL),
        (16, V16_SQL),
        (17, V17_SQL),
        (18, V18_SQL),
        (19, V19_SQL),
        (20, V20_SQL),
        (21, V21_SQL),
        (22, V22_SQL),
        (23, V23_SQL),
        (24, V24_SQL),
        (25, V25_SQL),
        (26, V26_SQL),
        (27, V27_SQL),
        (28, V28_SQL),
        (29, V29_SQL),
        (30, V30_SQL),
        (31, V31_SQL),
        (32, V32_SQL),
        (33, V33_SQL),
        (34, V34_SQL),
        (35, V35_SQL),
        (36, V36_SQL),
        (37, V37_SQL),
        (38, V38_SQL),
        (39, V39_SQL),
        (40, V40_SQL),
        (41, V41_SQL),
        (42, V42_SQL),
        (43, V43_SQL),
        (44, V44_SQL),
        (45, V45_SQL),
        (46, V46_SQL),
        (47, V47_SQL),
        (48, V48_SQL),
        (49, V49_SQL),
        (50, V50_SQL),
        (51, V51_SQL),
        (52, V52_SQL),
        (53, V53_SQL),
        (54, V54_SQL),
        (55, V55_SQL),
        (56, V56_SQL),
        (57, V57_SQL),
        (58, V58_SQL),
        (59, V59_SQL),
        (60, V60_SQL),
        (61, V61_SQL),
        (62, V62_SQL),
        (63, V63_SQL),
        (64, V64_SQL),
        (65, V65_SQL),
        (66, V66_SQL),
        (67, V67_SQL),
        (68, V68_SQL),
        (69, V69_SQL),
        (70, V70_SQL),
        (71, V71_SQL),
        (72, V72_SQL),
        (73, V73_SQL),
        (74, V74_SQL),
        (75, V75_SQL),
        (76, V76_SQL),
        (77, V77_SQL),
        (78, V78_SQL),
        (79, V79_SQL),
        (80, V80_SQL),
        (81, V81_SQL),
        (82, V82_SQL),
        (83, V83_SQL),
        (84, V84_SQL),
        (85, V85_SQL),
        (86, V86_SQL),
        (87, V87_SQL),
        (88, V88_SQL),
        (89, V89_SQL),
        (90, V90_SQL),
        (91, V91_SQL),
        (92, V92_SQL),
        (93, V93_SQL),
        (94, V94_SQL),
        (95, V95_SQL),
        (96, V96_SQL),
    ]
}

/// 현재 적용된 최고 스키마 버전 (schema_migrations 미존재 시 0).
pub fn current_version(conn: &Connection) -> AppResult<i64> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(db)?
        .unwrap_or(false);
    if !exists {
        return Ok(0);
    }
    let v: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .map_err(db)?;
    Ok(v)
}

/// 마이그레이션 목록을 순서대로 적용. 각 버전은 단일 트랜잭션 — 실패 시 롤백하여
/// 반적용(half-applied) 상태를 남기지 않는다 (R4).
pub fn apply(conn: &mut Connection, migrations: &[(i64, &str)]) -> AppResult<()> {
    let cur = current_version(conn)?;
    for (version, sql) in migrations {
        if *version <= cur {
            continue;
        }
        let tx = conn.transaction().map_err(db)?;
        if *version == 69 {
            migrate_v69(&tx)?;
        }
        if *version == 76 {
            migrate_v76(&tx)?;
        }
        if !sql.trim().is_empty() {
            tx.execute_batch(sql).map_err(db)?;
        }
        // 위 둘(v69·v76)과 달리 SQL 이 만든 테이블을 채우는 단계라 SQL 뒤에 돈다.
        // 백필은 V95 에서 한 번만(O-4, 2026-10-12) — V94(표 생성)와 V95(빈 SQL)는 늘 같은 apply 에서 이어 돌고
        // bigram_rebuild_all 이 먼저 비우므로 결과는 같다. 예전엔 94·95 둘 다 돌아 V93 이하 DB 의 첫 부팅이 두 배로 걸렸다.
        if *version == 95 {
            migrate_v94(&tx)?;
        }
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![version, now_iso()],
        )
        .map_err(db)?;
        tx.commit().map_err(db)?;
    }
    Ok(())
}

/// 표준 마이그레이션 적용 + 최초 실행 시드.
pub fn run(conn: &mut Connection) -> AppResult<()> {
    // §2.6 HANDOFF-calendar-onboarding.md: pre-migration 버전을 먼저 캡처해둔다 — 진짜 신규 DB는
    // schema_migrations 테이블 자체가 없어 0에서 시작해 이 한 번의 호출로 전체 마이그레이션을
    // 몰아서 적용하지만, 기존 사용자의 DB는 이미 0보다 큰 버전에서 시작한다. `apply()` 이후에
    // current_version() 을 다시 재면 신규/기존 DB 둘 다 "최신"으로 똑같아 보여 구분이 불가능해진다.
    let pre_migration_version = current_version(conn)?;
    apply(conn, &migrations())?;
    seed(conn)?;
    // N2-5(잔여 리스크 1): 이번 라운드부터 섹션 본문 저장이 정규화 마크다운으로 바뀌어, 업그레이드
    // 후 첫 편집마다 레거시 본문이 재기록된다(내용 보존, 바이트 비동일 — 되돌릴 수 없음). 기존
    // 설치가 실제로 스키마 버전이 올라간 부팅에서만(신규 설치·무변화 부팅은 제외) 설정 플래그를
    // 한 번 세운다 — 프런트(leftpanel)가 이걸 보고 "백업을 만들어두시겠어요?" 안내를 한 번
    // 보여준다(모달 아님, 무시하고 지나갈 수 있음). ON CONFLICT DO UPDATE: 과거에 껐던 채로
    // 남아있어도 진짜 업그레이드가 또 오면 다시 켠다 — onboarding_completed 의 DO NOTHING 과
    // 의도적으로 다르다(그건 "한 번 완료되면 영구", 이건 "업그레이드마다 다시 알림").
    if pre_migration_version > 0 && current_version(conn)? > pre_migration_version {
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('backup_nudge_pending', 'true')
             ON CONFLICT(key) DO UPDATE SET value='true'",
            [],
        )
        .map_err(db)?;
    }
    if pre_migration_version > 0 {
        // 기존 설치(이미 스키마 버전이 있던 DB)는 이 마이그레이션을 처음 통과하는 순간 온보딩을
        // 완료 처리한다 — 이미 실제 워크스페이스/노트가 있는 사용자에게 "이름을 지어주세요" 첫
        // 실행 마법사를 띄우면 안 된다. `ON CONFLICT DO NOTHING`이라 이후 사용자가 설정에서
        // "온보딩 다시 하기"로 false 로 되돌려도(§2.6) 다음 부팅에서 이 줄이 그걸 다시 덮어쓰지
        // 않는다 — 매번 재실행되지만 이미 값이 있으면 그냥 no-op. 진짜 신규 DB는 이 분기를 아예
        // 안 타지만, seed()가 ws_count==0일 때 default_settings() 전체를 그대로 행으로 남기므로
        // (아래 seed() 참고) onboarding_completed 는 결국 false 로 남는다 — 신규 설치는 마법사를
        // 봐야 하므로 결과는 같다, 다만 그 경로를 이 줄이 만든 게 아니라는 점이 중요하다.
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('onboarding_completed', 'true')
             ON CONFLICT(key) DO NOTHING",
            [],
        )
        .map_err(db)?;
    }
    if pre_migration_version > 0 {
        // collect_paused_until 백필 — 오너 결정(D2) "수집 기본 OFF"는 새 DB에만 적용되어야
        // 하는데, repo::settings::get_all() 은 DB에 저장된 행이 없는 키를 항상
        // default_settings() 값으로 채운다. 그 시드가 far-future 로 바뀌면서, 이 키를 한
        // 번도 명시적으로 설정한 적 없는 기존 설치(신규 DB가 아니라 seed()의 far-future
        // 시드를 거치지 않은 DB)까지 업그레이드 후 get_all() 이 far-future 를 읽어 자동
        // 수집이 조용히 멈추는 회귀가 있었다. onboarding_completed 백필(위)과 같은 이유·
        // 같은 모양: 빈 문자열(값은 JSON 인코딩이므로 `""`) 행을 한 번 심어두면 get_all()
        // 이 그 저장값을 채택해 더 이상 시드 기본값으로 폴백하지 않는다. `ON CONFLICT DO
        // NOTHING` — 이미 명시적으로 값을 설정해 둔 기기는 절대 덮어쓰지 않는다. 진짜 신규
        // DB(pre_migration_version == 0)는 이 분기를 안 타므로 far-future 시드 그대로 =
        // 기본 OFF 유지.
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('collect_paused_until', '\"\"')
             ON CONFLICT(key) DO NOTHING",
            [],
        )
        .map_err(db)?;
    }
    Ok(())
}

/// 최초 실행 시드 — 워크스페이스가 하나도 없을 때만 수행 (idempotent).
pub fn seed(conn: &mut Connection) -> AppResult<()> {
    let ws_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
        .map_err(db)?;
    if ws_count > 0 {
        return Ok(());
    }

    let now = now_iso();
    let ws_id = new_id();
    let folder_id = new_id();
    let tx = conn.transaction().map_err(db)?;
    tx.execute(
        "INSERT INTO workspaces(id, name, created_at) VALUES (?1, ?2, ?3)",
        // 시드 시점엔 언어를 모른다 — 중립 이름을 두고, 첫 화면 온보딩이 언어별 재밌는 이름을 제안한다
        // (OnboardingWizard SEEDED_NOTEBOOK_NAMES). 옛 시드명 "Histoire de Corée" 는 개발 흔적이었다.
        params![ws_id, "Brise", now],
    )
    .map_err(db)?;
    tx.execute(
        "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at) VALUES (?1, ?2, ?3, 0, 1, ?4)",
        params![folder_id, ws_id, "Notes", now],
    )
    .map_err(db)?;

    // 노트북 키는 전역에 심지 않는다(V86 이후): get_all 이 전역 노트북 키 행을 무시하므로 심어 봐야
    // 죽은 행이고, 새 노트북은 행이 없어야 기본값이다(PLAN-2026-09-19-notebook-settings).
    for (key, value) in default_settings(&ws_id)
        .into_iter()
        .filter(|(k, _)| !crate::repo::settings_schema::is_notebook_setting_key(k))
    {
        tx.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(db)?;
    }
    tx.commit().map_err(db)?;
    Ok(())
}

// 예제 콘텐츠 시드(seed_examples)는 2026-07-29 제거 — 신규 설치는 빈 DB로 시작해야 한다(owner 결정,
// 인생기록 중심 컨셉 전환 + 프리셋/온보딩 도입으로 예제 노트 불필요). 기존 설치의 examples_seeded
// 마커와 예제 노트는 사용자 데이터로 간주해 건드리지 않는다. (specs/db/seed.yaml SSOT)

#[cfg(test)]
mod tests {
    use super::*;

    /// V25: note_embeddings 드롭이 두 경로 모두에서 안전한지 — (a) 이미 V2 를 거쳐 테이블이
    /// 존재하는 기존 DB, (b) V1..V25 를 한 번에 적용하는 신규 DB(테이블이 존재한 적조차 없음,
    /// IF EXISTS 가 없으면 신규 DB 경로가 깨진다).
    #[test]
    fn test_v25_drops_note_embeddings_from_existing_and_fresh_db() {
        // (a) 기존 DB: v1..v24 적용 후 note_embeddings 가 실제로 존재하는 상태에서 v25 적용.
        let mut existing = Connection::open_in_memory().unwrap();
        apply(&mut existing, &migrations()[..24]).unwrap(); // v1..v24 (note_embeddings 는 v2에서 생성됨)
        assert!(
            existing.prepare("SELECT id FROM note_embeddings LIMIT 1").is_ok(),
            "precondition: note_embeddings must exist after v1..v24"
        );
        apply(&mut existing, &[(25, V25_SQL)]).unwrap();
        assert!(
            existing.prepare("SELECT id FROM note_embeddings LIMIT 1").is_err(),
            "v25 must drop note_embeddings"
        );

        // (b) 신규 DB: 테이블이 존재한 적 없는 채로 V1..V25 를 한 번에 적용 — DROP TABLE IF EXISTS
        // 가 없으면 여기서 "no such table" 대신 크래시한다.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 25);
        assert!(fresh.prepare("SELECT id FROM note_embeddings LIMIT 1").is_err());
    }

    // Bug fix 검증(2026-07-24): 이미 워크스페이스가 있는 기존 DB(=seed()가 두 번째부터 no-op)에
    // 레거시 mica_alpha 만 있고 sheet_alpha 는 없는 실사용자 상황을 재현한다 — v14까지 적용하고
    // seed() 로 워크스페이스를 만든 뒤, seed() 가 새 키 이름으로 이미 넣어둔 sheet_alpha 행을
    // 지우고 구 키 이름(mica_alpha)으로 되돌려 "리네임 이전 버전에서 넘어온 DB"를 시뮬레이션한다.
    // v15 적용 후 sheet_alpha 가 default_settings() 의 맹목적 기본값(0.85)이 아니라 사용자의
    // 실제 값(0.6)을 이어받아야 한다 — 이게 이 회귀의 핵심(리네임으로 새 키의 기본값이 옛 키를
    // 가려버렸었다).
    #[test]
    fn test_v15_sheet_alpha_migrates_legacy_mica_alpha_forward() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
                (8, V8_SQL),
                (9, V9_SQL),
                (10, V10_SQL),
                (11, V11_SQL),
                (12, V12_SQL),
                (13, V13_SQL),
                (14, V14_SQL),
            ],
        )
        .unwrap();
        seed(&mut conn).unwrap();

        // 리네임 이전 DB 상태 재현: sheet_alpha 없음, mica_alpha=0.6(사용자가 실제로 골랐던 값).
        conn.execute("DELETE FROM settings WHERE key='sheet_alpha'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('mica_alpha', '0.6')",
            [],
        )
        .unwrap();

        // v15 적용.
        apply(&mut conn, &[(15, V15_SQL)]).unwrap();

        let sheet_alpha: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='sheet_alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sheet_alpha, "0.6");

        // 구 키는 지우지 않는다 — 참고용으로 남아도 안전하다(validate_setting 이 더 이상 받지
        // 않으므로 재저장될 일이 없다).
        let mica_alpha: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='mica_alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mica_alpha, "0.6");

        // run()과 동일한 순서(apply 다음 seed)로 seed() 를 다시 불러도 — 이미 워크스페이스가
        // 있으므로 no-op — 방금 이관된 값을 덮어쓰지 않는다.
        seed(&mut conn).unwrap();
        let sheet_alpha_after_seed: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='sheet_alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sheet_alpha_after_seed, "0.6");
    }

    // 신규 설치(레거시 mica_alpha 없음) 대조군 — v15 는 아무 것도 이관할 게 없어 no-op 이고,
    // ws_count==0 이라 seed() 가 실제로 실행돼 default_settings() 의 sheet_alpha 기본값(0.85)이
    // 정상적으로 들어간다 — 리네임 이관 로직이 신규 설치 경로를 깨뜨리지 않는지 확인한다.
    #[test]
    fn test_v15_sheet_alpha_defaults_when_no_legacy_mica_alpha() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()).unwrap();
        seed(&mut conn).unwrap();

        // V86 이후 sheet_alpha 는 노트북 키라 시드가 전역에 심지 않는다 — 읽기 관문(get_all)이
        // 기본값 0.85 를 돌려주는지로 확인한다.
        let s = crate::repo::settings::get_all(&conn).unwrap();
        assert_eq!(s["sheet_alpha"], serde_json::json!(0.85));
    }

    /// CHECK 목록과 repo::spaces 의 검증 목록이 갈라지면 그 종류는 **저장 시점에** 거부된다.
    /// 프런트와 Rust 검증은 통과하므로 단위 테스트로는 안 잡히고, 사용자가 버튼을 눌렀을 때
    /// 조용히 실패한다. 실제로 두 번 났다 — V53('widget'), V55('sketch').
    /// 종류를 새로 추가할 때 이 테스트가 마이그레이션을 잊지 않게 한다.
    #[test]
    fn kinds_check_matches_repo_validation() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()).unwrap();
        seed(&mut conn).unwrap();

        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO spaces (id, workspace_id, title, position, created_at, updated_at) VALUES ('s-kind', ?1, 'k', 0, '', '')",
            [&ws],
        )
        .unwrap();

        // repo::spaces::space_item_add 가 허용하는 목록과 **글자 그대로** 같아야 한다.
        for kind in [
            "note", "text", "checklist", "frame", "today", "image", "widget", "sketch",
        ] {
            let r = conn.execute(
                "INSERT INTO space_items (id, space_id, kind, content, x, y, width, height, created_at, updated_at)                  VALUES (?1, 's-kind', ?1, '', 0, 0, 10, 10, '', '')",
                [kind],
            );
            assert!(
                r.is_ok(),
                "kind '{kind}' 는 repo 검증을 통과하는데 CHECK 이 거부한다 — 마이그레이션이 빠졌다"
            );
        }
    }

    #[test]
    fn test_seed_invariant() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()).unwrap();
        seed(&mut conn).unwrap();
        // 재호출은 no-op (idempotent)
        seed(&mut conn).unwrap();

        // 신규 설치는 빈 DB — 예제 노트 시드는 2026-07-29 제거됨(릴리즈에 노트가 딸려가면 안 됨).
        // 이 단언이 깨지면 누군가 시드에 콘텐츠를 다시 넣은 것이다.
        let notes_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(notes_count, 0);
        let fts_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts_count, 0);

        // 워크스페이스 1개 + 기본 폴더 1개 + 기본 설정만 존재
        let ws_count: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0)).unwrap();
        assert_eq!(ws_count, 1);
        let folder_count: i64 = conn.query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0)).unwrap();
        assert_eq!(folder_count, 1);
    }

    #[test]
    fn test_onboarding_completed_is_false_on_a_genuinely_fresh_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Never applied anything before — schema_migrations doesn't exist yet, current_version()
        // reads 0, so run()'s backfill branch never fires. seed() itself materializes every
        // default_settings() pair as a real row (including this one) since ws_count == 0 here —
        // that's the pre-existing "INSERT OR IGNORE ... for (key, value) in default_settings()"
        // loop, not something this feature added. The outcome a fresh install must see is simply
        // "false" (show the wizard) — however the row got there.
        run(&mut conn).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'onboarding_completed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "false", "a fresh install must see the first-run wizard");
    }

    #[test]
    fn test_onboarding_completed_backfills_true_for_an_existing_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Simulate a DB that already existed before onboarding_completed shipped: apply just the
        // base schema (so the `workspaces` table exists), then insert a workspace directly (NOT
        // via seed(), which would materialize the *current* default_settings() — including this
        // very key — and defeat the point of the test).
        apply(&mut conn, &migrations()[..1]).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'Old Workspace', '2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        // The "upgrade" boot: current_version() > 0 (from the line above) and ws_count > 0, so
        // seed() no-ops (it only ever fires for ws_count == 0) — nothing beats run()'s own
        // backfill branch to inserting this row.
        run(&mut conn).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'onboarding_completed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "true", "an existing install must never see the first-run wizard");

        // Idempotent: a later boot (already fully migrated, pre_migration_version still > 0)
        // must not clobber a value the user or the wizard itself set afterward.
        conn.execute(
            "UPDATE settings SET value = 'false' WHERE key = 'onboarding_completed'",
            [],
        )
        .unwrap();
        run(&mut conn).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'onboarding_completed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "false", "re-running run() must not re-clobber a user's later choice");
    }

    // D2 회귀 수정: repo::settings::get_all() 이 저장된 행 없는 키를 default_settings() 값으로
    // 채우는데, collect_paused_until 의 시드가 far-future 로 바뀌면서 이 키를 한 번도 명시적으로
    // 설정한 적 없는 기존 설치까지 업그레이드 후 자동 수집이 멈추는 회귀가 있었다. 오너 결정은
    // "새 DB만 OFF, 기존 기기는 영향 없음" — is_collect_paused 의 파싱 규칙(빈 문자열/과거 시각
    // → OFF, 키 없음 → 시드 기본값)은 collect::tests 에서 이미 검증하므로, 여기서는 run() 의
    // 백필 메커니즘 자체(행을 심는지, 심지 않는지, 덮어쓰지 않는지)만 저장값으로 확인한다 —
    // 신규 설치가 계속 paused 인지는 collect::tests::fresh_db_starts_paused_by_default 가 이미
    // (test_conn() 을 통해 진짜 pre_migration_version == 0 경로로) 봉인하고 있어 여기서 중복하지
    // 않는다.
    #[test]
    fn test_collect_paused_until_backfilled_empty_for_an_existing_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        // test_onboarding_completed_backfills_true_for_an_existing_db 와 동일한 기법: 베이스
        // 스키마만 적용하고 워크스페이스를 seed() 없이 직접 꽂아 "이 기능이 나오기 전부터 있던
        // DB"를 흉내낸다 — seed() 를 거치면 현재 default_settings() 가 그대로 행이 되어 이 회귀
        // 자체가 재현되지 않는다.
        apply(&mut conn, &migrations()[..1]).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'Old Workspace', '2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        run(&mut conn).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'collect_paused_until'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "\"\"", "an existing install must keep collecting after upgrade, not go silently paused");
    }

    #[test]
    fn test_collect_paused_until_backfill_does_not_clobber_an_explicit_value() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..1]).unwrap();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'Old Workspace', '2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        // 사용자가 이미 명시적으로 일시중지를 걸어둔 상태를 흉내낸다.
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('collect_paused_until', '\"2099-06-01T00:00:00+00:00\"')",
            [],
        )
        .unwrap();

        run(&mut conn).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'collect_paused_until'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "\"2099-06-01T00:00:00+00:00\"", "ON CONFLICT DO NOTHING must never clobber a value the user actually set");
    }

    // N2-5: backup_nudge_pending must only ever be set on a boot where an *existing* install's
    // schema version actually moved forward — never on a brand-new DB, and never re-armed on a
    // no-op boot (already latest) that would otherwise re-nag a user who already dismissed it.
    #[test]
    fn test_backup_nudge_pending_absent_on_a_fresh_install() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        // Not in default_settings() and pre_migration_version was 0, so run()'s upgrade branch
        // never fires — the key must not exist at all (missing == "no nudge" on the frontend).
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'backup_nudge_pending'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(value, None, "a fresh install must never see the backup nudge");
    }

    #[test]
    fn test_backup_nudge_pending_set_true_when_an_existing_db_gains_a_new_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Simulate an existing install stuck a few versions behind HEAD.
        let all = migrations();
        apply(&mut conn, &all[..all.len() - 1]).unwrap();
        seed(&mut conn).unwrap();

        // The upgrade boot: pre_migration_version > 0 and apply() advances it further.
        run(&mut conn).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'backup_nudge_pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "true", "an existing install that just upgraded must see the nudge");

        // Once the user dismisses it (frontend calls settings_set to flip it false), a later boot
        // that applies no further migrations must not re-arm it — otherwise dismissing is
        // pointless (the "one click is enough" requirement from docs/PLAN-2026-07-31-round2.md).
        conn.execute(
            "UPDATE settings SET value = 'false' WHERE key = 'backup_nudge_pending'",
            [],
        )
        .unwrap();
        run(&mut conn).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'backup_nudge_pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "false", "a no-op boot must not re-arm a dismissed nudge");
    }

    // P1 시맨틱 검색(V38): section_embeddings 가 V38 적용 직후 생성되는지만 확인한다.
    // V61 이 이 테이블을 DROP 하므로 전체 run() 이 아니라 version <= 38 까지만 적용한다.
    #[test]
    fn test_v38_creates_section_embeddings_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_38: Vec<(i64, &str)> = migrations()
            .into_iter()
            .filter(|(v, _)| *v <= 38)
            .collect();
        apply(&mut conn, &through_38).unwrap();
        assert_eq!(current_version(&conn).unwrap(), 38);
        conn.execute(
            "INSERT INTO section_embeddings(section_id, note_id, workspace_id, model, dim, vec, content_hash, updated_at)
             VALUES ('s1', 'n1', 'ws1', 'multilingual-e5-small', 384, X'0000', 'hash1', '2026-08-07T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let dim: i64 = conn
            .query_row("SELECT dim FROM section_embeddings WHERE section_id='s1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dim, 384);
    }

    /// V61: section_embeddings 드롭이 두 경로 모두에서 안전한지 — (a) 이미 V38 을 거쳐 테이블이
    /// 존재하는 기존 DB, (b) V1..V61 를 한 번에 적용하는 신규 DB(V38 이 만든 뒤 V61 이 지움).
    #[test]
    fn test_v61_drops_section_embeddings() {
        // (a) 기존 DB: v1..v60 적용 후 section_embeddings 가 실제로 존재하는 상태에서 v61 적용.
        let mut existing = Connection::open_in_memory().unwrap();
        let through_60: Vec<(i64, &str)> = migrations()
            .into_iter()
            .filter(|(v, _)| *v <= 60)
            .collect();
        apply(&mut existing, &through_60).unwrap();
        assert!(
            existing.prepare("SELECT section_id FROM section_embeddings LIMIT 1").is_ok(),
            "precondition: section_embeddings must exist after v1..v60"
        );
        apply(&mut existing, &[(61, V61_SQL)]).unwrap();
        assert!(
            existing.prepare("SELECT section_id FROM section_embeddings LIMIT 1").is_err(),
            "v61 must drop section_embeddings"
        );

        // (b) 신규 DB: run() 이 V38 생성 + V61 드롭을 한 번에 적용.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 61);
        assert!(fresh.prepare("SELECT section_id FROM section_embeddings LIMIT 1").is_err());
    }

    /// V62: spaces 홈 뷰포트(home_viewport_x/y/zoom, nullable)·배치 잠금(layout_locked) 컬럼 추가가
    /// 두 경로 모두에서 안전한지 — (a) V50 에서 spaces 가 만들어진 기존 DB, (b) V1..V62 를 한 번에
    /// 적용하는 신규 DB. ALTER TABLE ADD COLUMN 이라 기존 행은 전부 NULL/false 로 채워져야 한다.
    #[test]
    fn test_v62_adds_home_viewport_and_layout_lock_to_spaces() {
        // (a) 기존 DB: v1..v61 적용 + seed(워크스페이스 확보) 후 spaces 행 하나를 심는다.
        let mut existing = Connection::open_in_memory().unwrap();
        let through_61: Vec<(i64, &str)> = migrations()
            .into_iter()
            .filter(|(v, _)| *v <= 61)
            .collect();
        apply(&mut existing, &through_61).unwrap();
        seed(&mut existing).unwrap();
        let ws_id: String = existing
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        existing
            .execute(
                "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
                 VALUES ('sp-v62', ?1, '기존 공간', 0, 1, '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')",
                rusqlite::params![ws_id],
            )
            .unwrap();
        apply(&mut existing, &[(62, V62_SQL)]).unwrap();

        // 기존 행은 nullable 컬럼 NULL, 잠금 플래그 0 으로 채워진다.
        let (hx, hy, hz, locked): (Option<f64>, Option<f64>, Option<f64>, i64) = existing
            .query_row(
                "SELECT home_viewport_x, home_viewport_y, home_viewport_zoom, layout_locked FROM spaces WHERE id = 'sp-v62'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((hx, hy, hz), (None, None, None));
        assert_eq!(locked, 0);

        // CHECK 제약이 살아 있다(0/1 외 값 거부).
        assert!(existing
            .execute(
                "UPDATE spaces SET layout_locked = 2 WHERE id = 'sp-v62'",
                [],
            )
            .is_err());

        // (b) 신규 DB: run() 이 처음부터 V62 까지 몰아서 적용 — 컬럼 4개가 모두 존재한다.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 62);
        for col in ["home_viewport_x", "home_viewport_y", "home_viewport_zoom", "layout_locked"] {
            let hit: bool = fresh
                .query_row(
                    "SELECT 1 FROM pragma_table_info('spaces') WHERE name = ?1",
                    [col],
                    |_| Ok(true),
                )
                .optional()
                .unwrap()
                .unwrap_or(false);
            assert!(hit, "fresh DB must have spaces.{col}");
        }
    }

    // Wave 10: v3 구 스키마(기존 사용자 DB)에서 v4 로 업그레이드 시 기존 첨부 행이 보존되고
    // 새 kind('note'/'internal')가 허용되는지 검증. content.sql(=V1_SQL)은 이미 새 스키마이므로
    // 여기서는 구 attachments DDL 을 인라인으로 재현해 실제 업그레이드 경로를 테스트한다.
    #[test]
    fn test_v4_attachment_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        // v1~v3 을 적용하고 시드(워크스페이스+폴더)까지, attachments 만 구 스키마로 강제 재생성.
        apply(&mut conn, &[(1, V1_SQL), (2, V2_SQL), (3, V3_SQL)]).unwrap();
        seed(&mut conn).unwrap();
        conn.execute_batch(
            "DROP TABLE attachments;
             CREATE TABLE attachments (
               id TEXT PRIMARY KEY,
               note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               kind TEXT NOT NULL CHECK (kind IN ('image','doc','link','audio')),
               rel_path TEXT, url TEXT, size_bytes INTEGER,
               position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
               CHECK ((kind = 'link' AND url IS NOT NULL AND rel_path IS NULL)
                   OR (kind <> 'link' AND rel_path IS NOT NULL AND url IS NULL)));",
        )
        .unwrap();

        // 시드 워크스페이스/폴더에 노트 + 구 첨부 1행.
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a1','n1','pic.png','image','n1/pic.png',NULL,10,0,?1)",
            params![now],
        )
        .unwrap();

        // v4 적용.
        apply(&mut conn, &[(4, V4_SQL)]).unwrap();

        // 기존 image 행 보존.
        let img: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE id='a1' AND kind='image'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(img, 1);

        // 새 kind 허용: note(rel_path만), internal(url만).
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a2','n1','memo','note','n1/memo.md',NULL,5,1,?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a3','n1','ref','internal',NULL,'n1',NULL,2,?1)",
            params![now],
        )
        .unwrap();

        // 배타 CHECK: internal 이 rel_path 를 가지면 거부.
        let bad = conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a4','n1','x','internal','n1/x',NULL,0,3,?1)",
            params![now],
        );
        assert!(bad.is_err());

        // 인덱스 재생성 확인.
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_attachments_note'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
    }

    // Wave 11: 기존(v1~v4) 사용자 DB — folders 테이블에 color_hue 컬럼이 없는 상태 — 에 v5를
    // 적용해도 기존 폴더 행이 보존되고, 새 컬럼이 NULL 기본값으로 붙으며, 범위 CHECK가
    // 적용되는지 검증한다 (업그레이드 경로, 신규 설치 경로와 별개).
    #[test]
    fn test_v5_folder_color_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        // v1~v4 을 적용 — 이 시점의 folders 테이블은 아직 color_hue 가 없는 구 스키마.
        apply(&mut conn, &[(1, V1_SQL), (2, V2_SQL), (3, V3_SQL), (4, V4_SQL)]).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // v5 적용 전에는 컬럼이 없다.
        let has_col_before: bool = conn
            .prepare("SELECT color_hue FROM folders LIMIT 1")
            .is_err();
        assert!(has_col_before, "color_hue should not exist before v5");

        // v5 적용.
        apply(&mut conn, &[(5, V5_SQL)]).unwrap();

        // 기존 폴더 행 보존 + 새 컬럼은 NULL 기본값.
        let color: Option<i64> = conn
            .query_row("SELECT color_hue FROM folders WHERE id=?1", [&folder_id], |r| r.get(0))
            .unwrap();
        assert_eq!(color, None);

        // 유효 범위(0..359) 값은 허용.
        conn.execute(
            "UPDATE folders SET color_hue=200 WHERE id=?1",
            params![folder_id],
        )
        .unwrap();
        let color: Option<i64> = conn
            .query_row("SELECT color_hue FROM folders WHERE id=?1", [&folder_id], |r| r.get(0))
            .unwrap();
        assert_eq!(color, Some(200));

        // 범위 밖 값은 CHECK 로 거부.
        let bad = conn.execute(
            "UPDATE folders SET color_hue=360 WHERE id=?1",
            params![folder_id],
        );
        assert!(bad.is_err());
        let bad_neg = conn.execute(
            "UPDATE folders SET color_hue=-1 WHERE id=?1",
            params![folder_id],
        );
        assert!(bad_neg.is_err());

        // NULL 로 되돌리기(리셋)도 허용.
        conn.execute(
            "UPDATE folders SET color_hue=NULL WHERE id=?1",
            params![folder_id],
        )
        .unwrap();
    }

    // Wave 12: 기존(v1~v5) 사용자 DB — notes 테이블에 region 컬럼이 없는 상태 — 에 v6을
    // 적용해도 기존 노트 행이 보존되고, 새 컬럼이 NULL 기본값으로 붙으며, 자유 텍스트로
    // 값을 설정/해제할 수 있는지 검증한다 (업그레이드 경로, 신규 설치 경로와 별개).
    #[test]
    fn test_v6_region_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        // v1~v5 을 적용 — 이 시점의 notes 테이블은 아직 region 이 없는 구 스키마.
        apply(&mut conn, &[(1, V1_SQL), (2, V2_SQL), (3, V3_SQL), (4, V4_SQL), (5, V5_SQL)]).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();

        // v6 적용 전에는 컬럼이 없다.
        let has_col_before: bool = conn.prepare("SELECT region FROM notes LIMIT 1").is_err();
        assert!(has_col_before, "region should not exist before v6");

        // v6 적용.
        apply(&mut conn, &[(6, V6_SQL)]).unwrap();

        // 기존 노트 행 보존 + 새 컬럼은 NULL 기본값.
        let region: Option<String> = conn
            .query_row("SELECT region FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(region, None);

        // 자유 텍스트 값 설정 허용 (프리셋 목록에 없는 값도 허용 — DB는 제약 없음).
        conn.execute(
            "UPDATE notes SET region='Gyeongsang' WHERE id='n1'",
            [],
        )
        .unwrap();
        let region: Option<String> = conn
            .query_row("SELECT region FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(region, Some("Gyeongsang".to_string()));

        // NULL 로 되돌리기(해제)도 허용.
        conn.execute("UPDATE notes SET region=NULL WHERE id='n1'", [])
            .unwrap();
        let region: Option<String> = conn
            .query_row("SELECT region FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(region, None);
    }

    // Wave 13: 기존(v1~v6) 사용자 DB — workspaces 테이블에 bg_image_path 컬럼이 없는 상태 — 에
    // v7을 적용해도 기존 워크스페이스 행이 보존되고, 새 컬럼이 NULL 기본값으로 붙으며, 자유
    // 텍스트로 값을 설정/해제할 수 있는지 검증한다 (업그레이드 경로, 신규 설치 경로와 별개).
    #[test]
    fn test_v7_workspace_bg_image_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        // v1~v6 을 적용 — 이 시점의 workspaces 테이블은 아직 bg_image_path 가 없는 구 스키마.
        apply(
            &mut conn,
            &[(1, V1_SQL), (2, V2_SQL), (3, V3_SQL), (4, V4_SQL), (5, V5_SQL), (6, V6_SQL)],
        )
        .unwrap();
        seed(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // v7 적용 전에는 컬럼이 없다.
        let has_col_before: bool = conn
            .prepare("SELECT bg_image_path FROM workspaces LIMIT 1")
            .is_err();
        assert!(has_col_before, "bg_image_path should not exist before v7");

        // v7 적용.
        apply(&mut conn, &[(7, V7_SQL)]).unwrap();

        // 기존 워크스페이스 행 보존 + 새 컬럼은 NULL 기본값.
        let bg: Option<String> = conn
            .query_row(
                "SELECT bg_image_path FROM workspaces WHERE id=?1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bg, None);

        // 값 설정 허용 (repo::workspaces::set_bg_image 이 실제로 쓸 상대경로 형태).
        conn.execute(
            "UPDATE workspaces SET bg_image_path='ws1/abcd1234-bg.png' WHERE id=?1",
            params![ws_id],
        )
        .unwrap();
        let bg: Option<String> = conn
            .query_row(
                "SELECT bg_image_path FROM workspaces WHERE id=?1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bg, Some("ws1/abcd1234-bg.png".to_string()));

        // NULL 로 되돌리기(해제)도 허용.
        conn.execute(
            "UPDATE workspaces SET bg_image_path=NULL WHERE id=?1",
            params![ws_id],
        )
        .unwrap();
        let bg: Option<String> = conn
            .query_row(
                "SELECT bg_image_path FROM workspaces WHERE id=?1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bg, None);
    }

    // Wave 14: 기존(v1~v7) 사용자 DB — workspace_regions/workspace_eras 테이블이 없는 상태 — 에
    // v8을 적용해도 기존 워크스페이스/노트 행이 보존되고, 사용자 추가 지역/시대가 워크스페이스
    // 스코프로 저장되며, 이름 중복(대소문자 무시)이 거부되고, to_year <= from_year 인 시대는
    // CHECK로 거부되는지 검증한다 (업그레이드 경로, 신규 설치 경로와 별개).
    #[test]
    fn test_v8_workspace_taxonomy_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
            ],
        )
        .unwrap();
        seed(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // v8 적용 전에는 테이블이 없다.
        let has_table_before: bool = conn
            .prepare("SELECT 1 FROM workspace_regions LIMIT 1")
            .is_err();
        assert!(has_table_before, "workspace_regions should not exist before v8");

        // v8 적용.
        apply(&mut conn, &[(8, V8_SQL)]).unwrap();

        // 기존 워크스페이스 행 보존 확인 겸.
        let ws_still_there: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces WHERE id=?1", [&ws_id], |r| r.get(0))
            .unwrap();
        assert_eq!(ws_still_there, 1);

        // 사용자 지역 추가 허용.
        conn.execute(
            "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
             VALUES ('r1', ?1, 'Sokcho', 0, ?2)",
            params![ws_id, now_iso()],
        )
        .unwrap();
        let region_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_regions WHERE workspace_id=?1", [&ws_id], |r| r.get(0))
            .unwrap();
        assert_eq!(region_count, 1);

        // 같은 워크스페이스에 대소문자만 다른 이름은 중복으로 거부(COLLATE NOCASE UNIQUE).
        let dup = conn.execute(
            "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
             VALUES ('r2', ?1, 'sokcho', 1, ?2)",
            params![ws_id, now_iso()],
        );
        assert!(dup.is_err());

        // 워크스페이스가 다르면 같은 이름을 다시 써도 허용.
        let ws2 = new_id();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?1, 'Other', ?2)",
            params![ws2, now_iso()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
             VALUES ('r3', ?1, 'Sokcho', 0, ?2)",
            params![ws2, now_iso()],
        )
        .unwrap();

        // 사용자 시대 추가 허용 + to_year > from_year CHECK.
        conn.execute(
            "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
             VALUES ('e1', ?1, 'Custom Era', 1000, 1100, 0, ?2)",
            params![ws_id, now_iso()],
        )
        .unwrap();
        let bad_era = conn.execute(
            "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
             VALUES ('e2', ?1, 'Backwards', 1200, 1100, 1, ?2)",
            params![ws_id, now_iso()],
        );
        assert!(bad_era.is_err());

        // 워크스페이스 삭제 시 그 워크스페이스의 지역/시대도 CASCADE로 사라진다(고아 방지).
        // FK CASCADE는 foreign_keys pragma가 켜져 있어야 발동한다(프로덕션은 db::bootstrap이
        // 설정하지만, 이 테스트는 순수 in-memory Connection이라 직접 켠다).
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute("DELETE FROM workspaces WHERE id=?1", [&ws_id]).unwrap();
        let remaining_regions: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_regions WHERE workspace_id=?1", [&ws_id], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining_regions, 0);
        let remaining_eras: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_eras WHERE workspace_id=?1", [&ws_id], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining_eras, 0);
        // 다른 워크스페이스(ws2)의 지역은 그대로 남아 있다(격리 확인).
        let other_region_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_regions WHERE workspace_id=?1", [&ws2], |r| r.get(0))
            .unwrap();
        assert_eq!(other_region_count, 1);
    }

    // Wave 15: 기존(v1~v8) 사용자 DB — notes 테이블에 status 컬럼도, workspace_statuses
    // 테이블도 없는 상태 — 에 v9를 적용해도 기존 노트/워크스페이스 행이 보존되고, 새 컬럼이
    // NULL 기본값으로 붙으며, 내장 상태 키를 자유 텍스트로 저장할 수 있고, 사용자 커스텀 상태를
    // 워크스페이스 스코프로 추가할 수 있는지(대소문자 무시 중복 거부 포함) 검증한다
    // (업그레이드 경로, test_v6_region_migration_upgrade/test_v8_workspace_taxonomy_migration_upgrade
    // 와 이름·모양을 맞춤).
    #[test]
    fn test_v9_status_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
                (8, V8_SQL),
            ],
        )
        .unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_id: String = conn
            .query_row("SELECT workspace_id FROM folders WHERE id=?1", [&folder_id], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 'Existing note', 1500, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();

        // v9 적용 전에는 컬럼도 테이블도 없다.
        let has_col_before: bool = conn.prepare("SELECT status FROM notes LIMIT 1").is_err();
        assert!(has_col_before, "status should not exist before v9");
        let has_table_before: bool = conn.prepare("SELECT 1 FROM workspace_statuses").is_err();
        assert!(has_table_before, "workspace_statuses should not exist before v9");

        // v9 적용.
        apply(&mut conn, &[(9, V9_SQL)]).unwrap();

        // 기존 노트 행 보존 + 새 컬럼은 NULL 기본값(상태 없음 렌더링의 전제).
        let status: Option<String> = conn
            .query_row("SELECT status FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, None);

        // 내장 상태 키를 그대로 저장할 수 있다 (테이블 행이 아니라 코드 상수라 FK 없음).
        conn.execute("UPDATE notes SET status='done' WHERE id='n1'", [])
            .unwrap();
        let status: Option<String> = conn
            .query_row("SELECT status FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, Some("done".to_string()));

        // 커스텀 상태 추가 + 대소문자 무시 중복 거부(UNIQUE(workspace_id, name COLLATE NOCASE)).
        conn.execute(
            "INSERT INTO workspace_statuses(id, workspace_id, name, position, created_at) VALUES ('s1', ?1, 'Relecture', 0, ?2)",
            params![ws_id, now_iso()],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO workspace_statuses(id, workspace_id, name, position, created_at) VALUES ('s2', ?1, 'relecture', 1, ?2)",
            params![ws_id, now_iso()],
        );
        assert!(dup.is_err(), "case-insensitive duplicate custom status name must be rejected");

        // NULL 로 되돌리기(상태 해제)도 허용 — "상태 없음"은 깨끗이 렌더링돼야 하는 유효 상태.
        conn.execute("UPDATE notes SET status=NULL WHERE id='n1'", [])
            .unwrap();
        let status: Option<String> = conn
            .query_row("SELECT status FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, None);
    }

    // Wave 16 (P1 버그 수정) — 핵심 회귀 테스트: 기존(v1~v9) 사용자 DB의 notes_fts가 구
    // unicode61 토크나이저였다고 재현한 뒤(V1_SQL은 이미 이 코드베이스에서 fts.sql=trigram을
    // include하므로, "구버전 사용자 DB"를 정확히 재현하려면 v9까지 적용한 후 notes_fts를 명시
    // 적으로 unicode61 스키마로 되돌려야 한다 — test_v4/test_v5의 "구 스키마 인라인 재현" 패턴과
    // 동일), v10 적용 전에는 실제로 버그(어절 중간 부분 문자열 미매치)가 재현되는지 sanity
    // 체크하고, v10 적용 후에는 (1) 기존 노트가 새 trigram 인덱스로 재집계되고 (2) "세종대왕"
    // 본문 중 중간 부분 문자열 "종대"가 notes_fts MATCH로도, repo::search::search() 실제 검색
    // 경로로도 매치되는지 검증한다.
    #[test]
    fn test_v10_trigram_migration_korean_substring_regression() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
                (8, V8_SQL),
                (9, V9_SQL),
            ],
        )
        .unwrap();
        seed(&mut conn).unwrap();

        // notes_fts를 구 unicode61 스키마로 되돌려 실제 마이그레이션 이전 사용자 DB를 재현.
        conn.execute_batch(
            "DROP TABLE notes_fts;
             CREATE VIRTUAL TABLE notes_fts USING fts5(
               note_id UNINDEXED, title, body, source_body, tag_names,
               tokenize = 'unicode61 remove_diacritics 2'
             );",
        )
        .unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        let body = "조선의 4대 왕 세종대왕은 1443년 한글을 창제했다.";
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, '세종대왕 이야기', 1443, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position)
             VALUES ('sec1', 'n1', 'Overview', ?1, 0)",
            params![body],
        )
        .unwrap();
        // repo/fts.rs::fts_upsert 가 실제로 쓰는 것과 동일한 모양으로 구 인덱스에 수동 삽입
        // (마이그레이션 시점 실제 사용자 데이터를 재현).
        conn.execute(
            "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names)
             VALUES ('n1', '세종대왕 이야기', ?1, '', '')",
            params![body],
        )
        .unwrap();

        // Sanity: 구 unicode61 토크나이저는 "세종대왕은"을 통짜 토큰으로 취급하므로 중간 부분
        // 문자열 "종대왕"을 못 찾는다 — 버그가 실제로 재현되는지 먼저 확인한다. (trigram MATCH는
        // 원리상 3글자 미만 쿼리를 인덱싱할 수 없으므로 — build_match_query 참고 — 회귀 쿼리는
        // 반드시 3글자 이상이어야 trigram 매치 여부를 검증할 수 있다.)
        let pre: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '\"종대왕\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pre, 0, "sanity: unicode61 must NOT match mid-word substring (bug reproduction)");

        // v10 적용 — drop/재생성(trigram) + 기존 notes 전체 재집계.
        // 그리고 그 이후 마이그레이션 전체(10..N)를 순서대로 적용해 스키마를 최신 상태로 맞춘다
        // (repo::search::search가 lat/lng, status 등 최신 컬럼을 SELECT하므로).
        let all = migrations();
        let remaining: Vec<_> = all.into_iter().filter(|(v, _)| *v >= 10).collect();
        apply(&mut conn, &remaining).unwrap();

        // 재집계로 기존 노트가 새 인덱스에 다시 들어갔는지.
        let fts_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts_count, 1, "existing note must be repopulated into the new trigram index");

        // 핵심 회귀: 본문 중간 부분 문자열("세종대왕은"의 중간 3글자)이 이제 notes_fts MATCH로
        // 직접 잡힌다 — 어절 시작도 끝도 아닌 진짜 "중간" 위치라 unicode61 접두 매치로도 못 찾던
        // 케이스다.
        let post: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '\"종대왕\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(post, 1, "trigram MATCH must find mid-word Korean substring after V10 migration");

        // 실제 검색 경로(repo::search::search)로도 동일하게 확인 — 이게 앱이 실제로 쓰는 함수.
        let r = crate::repo::search::search(&conn, "종대왕", Some(900), Some(1960), None, None).unwrap();
        assert!(
            r.results.iter().any(|n| n.id == "n1"),
            "search() must find the note via Korean mid-word substring '종대왕' after V10 migration"
        );

        // 끝 쪽 부분 문자열("대왕은", 어절 끝+조사)도 마찬가지로 매치되어야 한다.
        let r_end = crate::repo::search::search(&conn, "대왕은", Some(900), Some(1960), None, None).unwrap();
        assert!(
            r_end.results.iter().any(|n| n.id == "n1"),
            "search() must find the note via trailing Korean substring '대왕은'"
        );
    }

    // Wave 16 — 영문 키워드 검색 무회귀: trigram 전환 후에도 (1) 완전한 단어 검색, (2) 여러 단어
    // AND 시맨틱스, (3) 어절 중간 타이핑(구 '*' 접두 매치가 담당하던 UX)이 여전히 동작해야 한다.
    // 신규 설치 경로(V1_SQL이 이미 trigram)로 전체 migrations()를 적용해 검증한다.
    #[test]
    fn test_v10_english_keyword_search_no_regression() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        for (id, title) in [("n1", "Imjin War"), ("n2", "Joseon Dynasty founding")] {
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1500, ?4, ?4)",
                params![id, folder_id, title, now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names)
                 VALUES (?1, ?2, '', '', '')",
                params![id, title],
            )
            .unwrap();
            // V95 불변식: notes_fts 행마다 2글자 색인·매핑 행(검색창이 매핑으로 후보를 찾는다).
            let rowid = conn.last_insert_rowid();
            let tx = conn.transaction().unwrap();
            crate::repo::fts::bigram_index(&tx, rowid, id, &[title, "", "", ""]).unwrap();
            tx.commit().unwrap();
        }

        // 완전한 단어 검색.
        let r = crate::repo::search::search(&conn, "Imjin", Some(900), Some(1960), None, None).unwrap();
        assert_eq!(r.results.iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec!["n1"]);

        // 다중 단어 AND — 둘 다 있는 노트만.
        let r = crate::repo::search::search(&conn, "Joseon Dynasty", Some(900), Some(1960), None, None).unwrap();
        assert_eq!(r.results.iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec!["n2"]);
        let r = crate::repo::search::search(&conn, "Joseon War", Some(900), Some(1960), None, None).unwrap();
        assert!(r.results.is_empty(), "AND semantics: word present in neither note together must yield no match");

        // 어절 중간 부분 문자열(trigram은 이걸 prefix보다 더 일반적으로 지원) — "oseon"은
        // "Joseon"의 중간부터 끝까지이므로 구 '*' 접두 매치로는 아예 못 찾던 패턴이다.
        let r = crate::repo::search::search(&conn, "oseon", Some(900), Some(1960), None, None).unwrap();
        assert_eq!(r.results.iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec!["n2"]);
    }

    // Wave 16 — R8 폴백 확장 회귀: 2글자 쿼리(trigram MATCH 불가 영역)가 title/tag에는 없고
    // 본문(sections)에만 있는 경우, 예전에는 title/tag만 보던 LIKE 폴백이 이를 놓쳤다. like_ids가
    // notes_fts의 body/source_body까지 LIKE로 커버하도록 확장했으므로 이제 잡혀야 한다.
    #[test]
    fn test_v10_short_query_like_fallback_covers_body() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 'Untitled note', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        // "왕건" (2글자) 은 title/tag에는 없고 body에만 등장한다.
        conn.execute(
            "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names)
             VALUES ('n1', 'Untitled note', '고려를 건국한 왕건.', '', '')",
            [],
        )
        .unwrap();
        // V95 불변식: notes_fts 행마다 2글자 색인·매핑 행(검색창이 매핑으로 후보를 찾는다).
        let rowid = conn.last_insert_rowid();
        let tx = conn.transaction().unwrap();
        crate::repo::fts::bigram_index(&tx, rowid, "n1", &["Untitled note", "고려를 건국한 왕건.", "", ""]).unwrap();
        tx.commit().unwrap();

        let r = crate::repo::search::search(&conn, "왕건", Some(900), Some(1960), None, None).unwrap();
        assert!(
            r.results.iter().any(|n| n.id == "n1"),
            "2-char query present only in body must be found via the body-extended LIKE fallback (R8)"
        );
    }

    // Trash: 기존(v1~v11) 사용자 DB — notes 테이블에 deleted_at 컬럼이 없는 상태 — 에 v12를
    // 적용해도 기존 노트 행이 보존되고, 새 컬럼이 NULL 기본값(정상 노트)으로 붙으며, 자유롭게
    // 값을 설정/해제(복구)할 수 있는지 검증한다 (업그레이드 경로, 다른 v* 테스트와 이름·모양을 맞춤).
    #[test]
    fn test_v12_trash_migration_upgrade() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
                (8, V8_SQL),
                (9, V9_SQL),
                (10, V10_SQL),
                (11, V11_SQL),
            ],
        )
        .unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 'Existing note', 1500, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();

        // v12 적용 전에는 컬럼이 없다.
        let has_col_before: bool = conn.prepare("SELECT deleted_at FROM notes LIMIT 1").is_err();
        assert!(has_col_before, "deleted_at should not exist before v12");

        // v12 적용.
        apply(&mut conn, &[(12, V12_SQL)]).unwrap();

        // 기존 노트 행 보존 + 새 컬럼은 NULL 기본값(정상 노트 — 아무도 소급 휴지통행이 되면 안 됨).
        let deleted_at: Option<String> = conn
            .query_row("SELECT deleted_at FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted_at, None);

        // 소프트 삭제(값 설정) 허용.
        conn.execute(
            "UPDATE notes SET deleted_at=?1 WHERE id='n1'",
            params![now_iso()],
        )
        .unwrap();
        let deleted_at: Option<String> = conn
            .query_row("SELECT deleted_at FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert!(deleted_at.is_some());

        // 복구(NULL 로 되돌리기)도 허용.
        conn.execute("UPDATE notes SET deleted_at=NULL WHERE id='n1'", [])
            .unwrap();
        let deleted_at: Option<String> = conn
            .query_row("SELECT deleted_at FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted_at, None);
    }

    /// Scale Phase 1: v13 이 note_tags(tag_id) 역방향 인덱스를 추가하는지 (업그레이드 경로).
    #[test]
    fn test_v13_note_tags_tag_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
                (8, V8_SQL),
                (9, V9_SQL),
                (10, V10_SQL),
                (11, V11_SQL),
                (12, V12_SQL),
            ],
        )
        .unwrap();

        let has_before: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_note_tags_tag'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false);
        assert!(!has_before, "index must not exist before v13");

        apply(&mut conn, &[(13, V13_SQL)]).unwrap();

        let has_after: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_note_tags_tag'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false);
        assert!(has_after, "idx_note_tags_tag must exist after v13");

        // 전체 러너(fresh install) 경로에서도 동일 인덱스 존재.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        let has_fresh: bool = fresh
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_note_tags_tag'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false);
        assert!(has_fresh, "fresh migrate also creates idx_note_tags_tag");
    }

    /// Scale Phase 1 F13 (보수적): v14 가 notes(status)/notes(region) 인덱스를 추가하는지.
    /// 클라 필터 이관은 범위 밖 — 스키마 회귀만 검증.
    #[test]
    fn test_v14_notes_status_region_indexes() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(
            &mut conn,
            &[
                (1, V1_SQL),
                (2, V2_SQL),
                (3, V3_SQL),
                (4, V4_SQL),
                (5, V5_SQL),
                (6, V6_SQL),
                (7, V7_SQL),
                (8, V8_SQL),
                (9, V9_SQL),
                (10, V10_SQL),
                (11, V11_SQL),
                (12, V12_SQL),
                (13, V13_SQL),
            ],
        )
        .unwrap();

        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        assert!(!has_index(&conn, "idx_notes_status"), "status idx before v14");
        assert!(!has_index(&conn, "idx_notes_region"), "region idx before v14");

        apply(&mut conn, &[(14, V14_SQL)]).unwrap();

        assert!(has_index(&conn, "idx_notes_status"), "idx_notes_status after v14");
        assert!(has_index(&conn, "idx_notes_region"), "idx_notes_region after v14");

        // 기존 노트 행 보존(인덱스 추가만 — 데이터 손상 없음).
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, region, status, created_at, updated_at)
             VALUES ('n-f13', ?1, 'F13 note', 1500, 'Seoul', 'draft', ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        let (region, status): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT region, status FROM notes WHERE id='n-f13'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(region.as_deref(), Some("Seoul"));
        assert_eq!(status.as_deref(), Some("draft"));

        // fresh install 경로.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(has_index(&fresh, "idx_notes_status"));
        assert!(has_index(&fresh, "idx_notes_region"));
        assert!(has_index(&fresh, "idx_note_tags_tag"));
    }

    /// Scale note_query: v19 partial indexes for year/favourite/trash + covering note_tags.
    #[test]
    fn test_v19_note_query_indexes() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Apply through v18 only.
        let through_18: Vec<(i64, &str)> = migrations()
            .into_iter()
            .filter(|(v, _)| *v <= 18)
            .collect();
        apply(&mut conn, &through_18).unwrap();

        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        assert!(!has_index(&conn, "idx_notes_year_alive"));
        assert!(!has_index(&conn, "idx_notes_favorite_year_alive"));
        assert!(!has_index(&conn, "idx_note_tags_tag_note"));
        assert!(!has_index(&conn, "idx_notes_deleted"));

        apply(&mut conn, &[(19, V19_SQL)]).unwrap();

        assert!(has_index(&conn, "idx_notes_year_alive"));
        assert!(has_index(&conn, "idx_notes_favorite_year_alive"));
        assert!(has_index(&conn, "idx_note_tags_tag_note"));
        assert!(has_index(&conn, "idx_notes_deleted"));

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(has_index(&fresh, "idx_notes_year_alive"));
        assert!(has_index(&fresh, "idx_notes_favorite_year_alive"));
        assert!(has_index(&fresh, "idx_note_tags_tag_note"));
        assert!(has_index(&fresh, "idx_notes_deleted"));
    }

    /// Scale note_query bbox: v20 partial geo index on live located rows.
    #[test]
    fn test_v20_geo_alive_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_19: Vec<(i64, &str)> = migrations()
            .into_iter()
            .filter(|(v, _)| *v <= 19)
            .collect();
        apply(&mut conn, &through_19).unwrap();

        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        assert!(!has_index(&conn, "idx_notes_geo_alive"));
        apply(&mut conn, &[(20, V20_SQL)]).unwrap();
        assert!(has_index(&conn, "idx_notes_geo_alive"));

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(has_index(&fresh, "idx_notes_geo_alive"));
    }

    /// Calendar record axis: v22 partial indexes on updated_at/created_at for live rows.
    #[test]
    fn test_v22_record_axis_alive_indexes() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_21: Vec<(i64, &str)> = migrations()
            .into_iter()
            .filter(|(v, _)| *v <= 21)
            .collect();
        apply(&mut conn, &through_21).unwrap();

        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        assert!(!has_index(&conn, "idx_notes_updated_alive"));
        assert!(!has_index(&conn, "idx_notes_created_alive"));
        apply(&mut conn, &[(22, V22_SQL)]).unwrap();
        assert!(has_index(&conn, "idx_notes_updated_alive"));
        assert!(has_index(&conn, "idx_notes_created_alive"));

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(has_index(&fresh, "idx_notes_updated_alive"));
        assert!(has_index(&fresh, "idx_notes_created_alive"));
    }

    #[test]
    fn test_v23_event_precision_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        let ws_id = crate::repo::folders::active_workspace_id(&conn).unwrap();
        let folder_id: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1592, 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        // Pre-existing row defaults month/day to NULL (year-only precision) — the ADD COLUMN
        // default, not a separate migration step.
        let (month, day): (Option<i64>, Option<i64>) = conn
            .query_row("SELECT month, day FROM notes WHERE id='n1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(month, None);
        assert_eq!(day, None);

        conn.execute("UPDATE notes SET month=13 WHERE id='n1'", [])
            .unwrap_err();
        conn.execute("UPDATE notes SET day=0 WHERE id='n1'", [])
            .unwrap_err();
        conn.execute("UPDATE notes SET month=7, day=13 WHERE id='n1'", [])
            .unwrap();
    }

    // Sync Phase 0 G1/G2/G4 (docs/SYNC.md): 신규 DB는 v24까지 곧장 도달하고, 기존(v23) DB는
    // updated_at 백필(created_at 이 있는 테이블은 그 값으로, 없는 sections/tags 는 마이그레이션
    // 시각으로)이 실제로 일어나는지, deleted_rows/attachments.content_hash 가 생기는지 검증한다.
    #[test]
    fn test_v24_sync_readiness_migration() {
        // 신규 DB — 최신 버전까지 곧장 도달(V25 추가 이후로도 이 마이그레이션 자체의 효과는
        // 그대로 유효하므로, 정확한 버전 숫자보다 "이 마이그레이션 지점을 지났다"만 확인한다).
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 24);
        assert!(fresh.prepare("SELECT tbl, id, deleted_at FROM deleted_rows").is_ok());
        assert!(fresh.prepare("SELECT content_hash FROM attachments").is_ok());

        // 기존(v23) DB — 폴더/워크스페이스에 실제 행을 심고 v24 업그레이드 시 created_at 값
        // 그대로 백필되는지 확인.
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..23]).unwrap(); // v1..v23
        seed(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws_created_at: String = conn
            .query_row("SELECT created_at FROM workspaces WHERE id=?1", [&ws_id], |r| r.get(0))
            .unwrap();
        let folder_created_at: String = conn
            .query_row("SELECT created_at FROM folders WHERE id=?1", [&folder_id], |r| r.get(0))
            .unwrap();

        // v23 시점: updated_at 컬럼이 아직 없다.
        assert!(conn.prepare("SELECT updated_at FROM folders LIMIT 1").is_err());
        assert!(conn.prepare("SELECT updated_at FROM workspaces LIMIT 1").is_err());
        assert!(conn.prepare("SELECT updated_at FROM tags LIMIT 1").is_err());
        assert!(conn.prepare("SELECT updated_at FROM sections LIMIT 1").is_err());
        assert!(conn.prepare("SELECT updated_at FROM sources LIMIT 1").is_err());

        // sections/tags 는 created_at 자체가 없다 — v24 백필이 "마이그레이션 적용 시각"으로
        // 채우는지 검증하려면 v24 적용 *이전에* pre-existing 행이 있어야 한다.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now_iso()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position)
             VALUES ('s1', 'n1', 'Overview', '', 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO tags(id, name) VALUES ('t1', 'alpha')", [])
            .unwrap();

        apply(&mut conn, &[(24, V24_SQL)]).unwrap();

        // created_at 이 있는 테이블은 그 값 그대로 백필.
        let folder_updated_at: String = conn
            .query_row("SELECT updated_at FROM folders WHERE id=?1", [&folder_id], |r| r.get(0))
            .unwrap();
        assert_eq!(folder_updated_at, folder_created_at);
        let ws_updated_at: String = conn
            .query_row("SELECT updated_at FROM workspaces WHERE id=?1", [&ws_id], |r| r.get(0))
            .unwrap();
        assert_eq!(ws_updated_at, ws_created_at);

        // sections/tags 의 pre-existing 행은 created_at 이 없으니 마이그레이션 시각으로
        // 채워져야 한다 — NULL 이 아닐 뿐 아니라, now_iso() 와 동일한 ISO8601(RFC3339) 모양이어야
        // 한다(문자열 비교로 다른 테이블의 created_at 기반 값과 섞여 쓰이므로 형태가 다르면
        // 렉시코그래픽 비교가 조용히 틀어진다).
        let section_updated_at: Option<String> = conn
            .query_row("SELECT updated_at FROM sections WHERE id='s1'", [], |r| r.get(0))
            .unwrap();
        assert!(section_updated_at.is_some(), "pre-existing section must be backfilled");
        let section_updated_at = section_updated_at.unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(&section_updated_at).is_ok(),
            "section backfill must be a valid RFC3339 timestamp, got {section_updated_at:?}"
        );
        assert!(section_updated_at.ends_with('Z'));

        let tag_updated_at: Option<String> = conn
            .query_row("SELECT updated_at FROM tags WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert!(tag_updated_at.is_some(), "pre-existing tag must be backfilled");
        let tag_updated_at = tag_updated_at.unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(&tag_updated_at).is_ok(),
            "tag backfill must be a valid RFC3339 timestamp, got {tag_updated_at:?}"
        );
        assert!(tag_updated_at.ends_with('Z'));

        // 신규 삽입 행은 (repo 계층이 값을 넣지 않는 한) NULL 로 시작할 수 있다 — 컬럼이
        // NULL 허용임을 확인.
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, updated_at)
             VALUES ('s2', 'n1', 'Extra', '', 1, NULL)",
            [],
        )
        .unwrap();
        let s2_updated_at: Option<String> = conn
            .query_row("SELECT updated_at FROM sections WHERE id='s2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(s2_updated_at, None);

        // deleted_rows / attachments.content_hash 도 v24와 함께 생긴다.
        conn.execute(
            "INSERT INTO deleted_rows(tbl, id, deleted_at) VALUES ('tags', 't-dead', ?1)",
            params![now_iso()],
        )
        .unwrap();
        // 재삭제 시 deleted_at 갱신 — INSERT OR REPLACE 경로가 기대하는 모양.
        conn.execute(
            "INSERT OR REPLACE INTO deleted_rows(tbl, id, deleted_at) VALUES ('tags', 't-dead', ?1)",
            params!["2030-01-01T00:00:00Z"],
        )
        .unwrap();
        let deleted_at: String = conn
            .query_row(
                "SELECT deleted_at FROM deleted_rows WHERE tbl='tags' AND id='t-dead'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(deleted_at, "2030-01-01T00:00:00Z");

        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, size_bytes, position, created_at, content_hash)
             VALUES ('a1', 'n1', 'x.png', 'image', 'n1/x.png', 10, 0, ?1, NULL)",
            params![now_iso()],
        )
        .unwrap();
        let content_hash: Option<String> = conn
            .query_row("SELECT content_hash FROM attachments WHERE id='a1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(content_hash, None, "content_hash defaults NULL until backfilled/written");
    }

    #[test]
    /// V26: sections.kind — existing rows migrate to 'text' silently (DEFAULT backfill, no
    /// explicit UPDATE needed), new rows can choose 'diagram', and the CHECK constraint rejects
    /// anything else at the SQL layer (repo::sections::validate_kind is the primary guard —
    /// AppError::Validation before a bad value ever reaches SQL — this test only proves the
    /// column-level backstop is real too).
    fn test_v26_section_kind_migration() {
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 26);

        // 기존(v25) DB — pre-existing section 행이 kind 컬럼 자체가 없던 시절에 만들어졌다.
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..25]).unwrap(); // v1..v25
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now_iso()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position)
             VALUES ('s1', 'n1', 'Overview', '', 0)",
            [],
        )
        .unwrap();
        assert!(conn.prepare("SELECT kind FROM sections LIMIT 1").is_err());

        apply(&mut conn, &[(26, V26_SQL)]).unwrap();

        let kind: String = conn
            .query_row("SELECT kind FROM sections WHERE id='s1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "text", "pre-existing rows must migrate to 'text' silently");

        // 새 행은 'diagram' 을 명시적으로 고를 수 있다.
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, kind)
             VALUES ('s2', 'n1', 'Relations', 'flowchart TD', 1, 'diagram')",
            [],
        )
        .unwrap();
        let kind2: String = conn
            .query_row("SELECT kind FROM sections WHERE id='s2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind2, "diagram");

        // CHECK 제약 — 알 수 없는 kind는 SQL 레벨에서도 거부된다.
        let err = conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, kind)
             VALUES ('s3', 'n1', 'Bad', '', 2, 'nonsense')",
            [],
        );
        assert!(err.is_err(), "CHECK constraint must reject an unknown kind");
    }

    #[test]
    /// V57: sections 테이블 재생성으로 kind CHECK 에 'sheet' 를 넣는다(SQLite 는 CHECK 를 ALTER
    /// 하지 못한다 — V55 와 같은 패턴). 기존 행이 전부 살아남고(컬럼 값 그대로), 인덱스가
    /// 다시 붙고, 'sheet' 는 통과하고 알 수 없는 kind 는 여전히 거부되는지 본다.
    fn test_v57_sections_kind_sheet() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..56]).unwrap(); // v1..v56
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now_iso()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, updated_at, kind)
             VALUES ('s1', 'n1', 'Overview', 'hello', 0, '2026-01-01T00:00:00.000Z', 'text'),
                    ('s2', 'n1', 'Relations', 'flowchart TD', 1, '2026-01-02T00:00:00.000Z', 'diagram')",
            [],
        )
        .unwrap();
        // 'sheet' 는 V57 이전에는 CHECK 에서 거부된다.
        assert!(conn
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position, kind)
                 VALUES ('s0', 'n1', 'Sheet', '{}', 2, 'sheet')",
                [],
            )
            .is_err());

        apply(&mut conn, &[(57, V57_SQL)]).unwrap();

        // 행이 전부 살아남았고 값도 그대로.
        let rows: Vec<(String, String, String, i64, Option<String>, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, name, body_md, position, updated_at, kind FROM sections ORDER BY position")
                .unwrap();
            stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("s1".into(), "Overview".into(), "hello".into(), 0, Some("2026-01-01T00:00:00.000Z".into()), "text".into()));
        assert_eq!(rows[1].5, "diagram");

        // 인덱스가 재생성됐다.
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sections_note'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1, "idx_sections_note must survive the table rebuild");

        // 이제 'sheet' 가 통과한다.
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position, kind)
             VALUES ('s3', 'n1', 'Budget', '{\"v\":1,\"rows\":100,\"cols\":[],\"cells\":{}}', 2, 'sheet')",
            [],
        )
        .unwrap();
        let kind: String = conn
            .query_row("SELECT kind FROM sections WHERE id='s3'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "sheet");

        // 알 수 없는 kind 는 여전히 거부.
        assert!(conn
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position, kind)
                 VALUES ('s4', 'n1', 'Bad', '', 3, 'bogus')",
                [],
            )
            .is_err());

        // 신규 DB(전체 마이그레이션)도 같은 CHECK 를 갖는다.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 57);
    }

    // Dashboard Wave 1: due_at + end_year/end_month/end_day — 기존 행은 NULL 기본, 신규 컬럼
    // 범위 CHECK, 왕복(업그레이드 경로) 무영향.
    #[test]
    fn test_v28_due_at_and_event_end_columns() {
        // Fresh install pinned at v28 (not `run()`, which now goes through v29 and drops
        // due_at again — this test exercises V28_SQL specifically; V29_SQL has its own test).
        let mut fresh = Connection::open_in_memory().unwrap();
        apply(&mut fresh, &migrations()[..28]).unwrap(); // v1..v28
        seed(&mut fresh).unwrap();
        assert_eq!(current_version(&fresh).unwrap(), 28);
        let ws_id = crate::repo::folders::active_workspace_id(&fresh).unwrap();
        let folder_id: String = fresh
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        fresh
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at)
                 VALUES ('n-fresh', ?1, 't', 1592, 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [&folder_id],
            )
            .unwrap();
        let (due_at, ey, em, ed): (Option<String>, Option<i64>, Option<i64>, Option<i64>) = fresh
            .query_row(
                "SELECT due_at, end_year, end_month, end_day FROM notes WHERE id='n-fresh'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(due_at, None);
        assert_eq!((ey, em, ed), (None, None, None));

        // CHECK: out-of-range end_month/end_day/end_year rejected.
        assert!(fresh
            .execute("UPDATE notes SET end_month=13 WHERE id='n-fresh'", [])
            .is_err());
        assert!(fresh
            .execute("UPDATE notes SET end_day=0 WHERE id='n-fresh'", [])
            .is_err());
        assert!(fresh
            .execute("UPDATE notes SET end_year=10000 WHERE id='n-fresh'", [])
            .is_err());
        fresh
            .execute(
                "UPDATE notes SET due_at='2026-07-31', end_year=1596, end_month=7, end_day=13 WHERE id='n-fresh'",
                [],
            )
            .unwrap();

        // Upgrade path: v27 DB → v28 leaves pre-existing rows at NULL defaults.
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..27]).unwrap(); // v1..v27
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n-pre', ?1, 'pre', 1000, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
            params![folder_id],
        )
        .unwrap();
        assert!(conn
            .prepare("SELECT due_at FROM notes LIMIT 1")
            .is_err());

        apply(&mut conn, &[(28, V28_SQL)]).unwrap();

        let (due_at, ey, em, ed): (Option<String>, Option<i64>, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT due_at, end_year, end_month, end_day FROM notes WHERE id='n-pre'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(due_at, None, "pre-existing row must keep NULL due_at");
        assert_eq!(
            (ey, em, ed),
            (None, None, None),
            "pre-existing row must keep NULL end_*"
        );
        // Pre-existing year/title unchanged by additive migration.
        let (title, year): (String, i64) = conn
            .query_row(
                "SELECT title, year FROM notes WHERE id='n-pre'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((title.as_str(), year), ("pre", 1000));
    }

    // Dashboard Wave 2 (docs/DASHBOARD.md §2, 2026-08-01): due_at 폐지 → end_year/end_month/
    // end_day 로 병합 + 컬럼 드롭. 세 케이스: due만 이관 / due+end 공존(end 우선, due 버림) /
    // due가 start보다 이전(end⇒start 불변식 복구로 start도 함께 당겨짐).
    #[test]
    fn test_v29_due_at_migrates_to_end_triple_then_column_dropped() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..28]).unwrap(); // v1..v28 — due_at/end_* still both exist.
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // Case A: due only, no prior end, start already before due — plain move to end triple.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, month, day, due_at, created_at, updated_at)
             VALUES ('due-only', ?1, 'A', 2026, 1, 1, '2026-08-15', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![folder_id],
        )
        .unwrap();

        // Case B: due AND a pre-existing end triple — historical end wins, due is discarded.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, due_at, end_year, end_month, end_day, created_at, updated_at)
             VALUES ('due-and-end', ?1, 'B', 1592, '2026-08-15', 1598, 11, 19, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![folder_id],
        )
        .unwrap();

        // Case C: due earlier than start (year-only 2030 vs due 2026-08-15) — after end takes
        // the due date, start must be pulled forward too (end⇒start invariant).
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, due_at, created_at, updated_at)
             VALUES ('due-earlier-than-start', ?1, 'C', 2030, '2026-08-15', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![folder_id],
        )
        .unwrap();

        apply(&mut conn, &[(29, V29_SQL)]).unwrap();

        // due_at column itself is gone (SELECT fails to even prepare).
        assert!(
            conn.prepare("SELECT due_at FROM notes LIMIT 1").is_err(),
            "due_at column must be dropped"
        );

        let row = |id: &str| -> (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
            conn.query_row(
                "SELECT year, month, day, end_year, end_month, end_day FROM notes WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap()
        };

        // A: end triple takes the due date; start untouched (already before due).
        assert_eq!(
            row("due-only"),
            (2026, Some(1), Some(1), Some(2026), Some(8), Some(15))
        );

        // B: pre-existing end wins; due discarded, end unchanged.
        assert_eq!(
            row("due-and-end"),
            (1592, None, None, Some(1598), Some(11), Some(19))
        );

        // C: end takes the due date AND start is pulled up to match it (was 2030 year-only) —
        // end⇒start invariant repaired by the migration.
        assert_eq!(
            row("due-earlier-than-start"),
            (2026, Some(8), Some(15), Some(2026), Some(8), Some(15))
        );
    }

    // QA8 1D: raise default_map_location.zoom when below city-scale factory default; never touch lat/lng.
    #[test]
    fn test_v32_default_map_zoom_raises_low_only_preserves_coords() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..31]).unwrap(); // v1..v31
        seed(&mut conn).unwrap();

        // Low zoom + user-chosen Paris coords (must not be reset to Seoul).
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('default_map_location', ?1)",
            params![r#"{"lat":48.8566,"lng":2.3522,"zoom":50.0}"#],
        )
        .unwrap();
        // Already at/above city zoom — must stay (user may have zoomed further in).
        // Use a second key path by re-running only on the one row: apply once after both? We only
        // have one key. Split into two DBs for the "already high" case below.

        apply(&mut conn, &[(32, V32_SQL)]).unwrap();

        let raw: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='default_map_location'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["lat"].as_f64().unwrap(), 48.8566);
        assert_eq!(v["lng"].as_f64().unwrap(), 2.3522);
        assert_eq!(
            v["zoom"].as_f64().unwrap(),
            V32_DEFAULT_MAP_CITY_ZOOM,
            "zoom below factory city default must be raised to {V32_DEFAULT_MAP_CITY_ZOOM}"
        );

        // High zoom preserved; coords still Paris.
        conn.execute(
            "UPDATE settings SET value = ?1 WHERE key = 'default_map_location'",
            params![r#"{"lat":48.8566,"lng":2.3522,"zoom":200.0}"#],
        )
        .unwrap();
        // Re-applying V32 is a no-op for version gating; run the SQL batch directly.
        conn.execute_batch(V32_SQL).unwrap();
        let raw2: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='default_map_location'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let v2: serde_json::Value = serde_json::from_str(&raw2).unwrap();
        assert_eq!(v2["lat"].as_f64().unwrap(), 48.8566);
        assert_eq!(v2["lng"].as_f64().unwrap(), 2.3522);
        assert_eq!(
            v2["zoom"].as_f64().unwrap(),
            200.0,
            "zoom already above factory default must not be lowered"
        );

        // Fresh seed path: new install default is city zoom (via default_settings, not migration).
        let mut fresh = Connection::open_in_memory().unwrap();
        apply(&mut fresh, &migrations()).unwrap();
        seed(&mut fresh).unwrap();
        let seed_raw: String = fresh
            .query_row(
                "SELECT value FROM settings WHERE key='default_map_location'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let seed_v: serde_json::Value = serde_json::from_str(&seed_raw).unwrap();
        assert_eq!(seed_v["lat"].as_f64().unwrap(), 37.5665);
        assert_eq!(seed_v["lng"].as_f64().unwrap(), 126.978);
        assert_eq!(seed_v["zoom"].as_f64().unwrap(), V32_DEFAULT_MAP_CITY_ZOOM);
    }

    // close_to_tray 부활 — opt-in 시절 seed()가 남긴 'false' 는 실제 사용자 선택이 아니므로 한 번만
    // true 로 되돌린다. 사용자가 나중에 새 체크박스로 명시적으로 false 를 고른 값은 건드리지 않는다
    // (버전 게이팅으로 이 마이그레이션은 두 번 실행되지 않는다).
    #[test]
    fn test_v37_close_to_tray_backfills_stale_false_only_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..36]).unwrap(); // v1..v36, before the backfill
        seed(&mut conn).unwrap();

        // Simulate an existing install stuck with the opt-in era's stale seed value.
        conn.execute(
            "UPDATE settings SET value = 'false' WHERE key = 'close_to_tray'",
            [],
        )
        .unwrap();

        apply(&mut conn, &[(37, V37_SQL)]).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'close_to_tray'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "true", "stale opt-in-era false must be backfilled to true");

        // A later, real user choice (via the new Settings checkbox) must survive any later boot —
        // the migration is already recorded as applied, so re-running run()/apply() must not touch it.
        conn.execute(
            "UPDATE settings SET value = 'false' WHERE key = 'close_to_tray'",
            [],
        )
        .unwrap();
        apply(&mut conn, &migrations()).unwrap();
        let value2: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'close_to_tray'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value2, "false", "a real user choice made after the backfill must not be re-clobbered");
    }

    // Fresh installs never see the opt-in-era value at all — seed() writes 'true' directly (from
    // default_settings()), and the V37 backfill only ever touches a stored 'false'.
    #[test]
    fn test_close_to_tray_defaults_true_on_a_fresh_install() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'close_to_tray'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "true");
    }

    #[test]
    fn test_v34_footnote_kind_and_optional_anchor_url() {
        // Upgrade path: v1..v33 then V34 must accept kind='footnote' with rel_path + optional url.
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, &migrations()[..33]).unwrap(); // v1..v33
        seed(&mut conn).unwrap();
        let note_id: String = {
            let folder_id: String = conn
                .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
                .unwrap();
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES ('n-fn', ?1, 't', 1000, ?2, ?2)",
                params![folder_id, now_iso()],
            )
            .unwrap();
            "n-fn".to_string()
        };
        // Pre-V34 CHECK must reject footnote.
        let rejected = conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a-fn', ?1, 'fn', 'footnote', 'n-fn/x.md', 'anchor', 1, 0, ?2)",
            params![note_id, now_iso()],
        );
        assert!(rejected.is_err(), "pre-V34 must reject kind=footnote");

        apply(&mut conn, &[(34, V34_SQL)]).unwrap();

        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)
             VALUES ('a-fn', ?1, 'fn', 'footnote', 'n-fn/x.md', 'anchor', 1, 0, ?2, 'deadbeef')",
            params![note_id, now_iso()],
        )
        .unwrap();
        let (kind, url, hash): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT kind, url, content_hash FROM attachments WHERE id='a-fn'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kind, "footnote");
        assert_eq!(url.as_deref(), Some("anchor"));
        assert_eq!(hash.as_deref(), Some("deadbeef"));

        // url may be NULL for footnotes (no anchor_text).
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a-fn2', ?1, 'fn2', 'footnote', 'n-fn/y.md', NULL, 1, 1, ?2)",
            params![note_id, now_iso()],
        )
        .unwrap();

        // Non-footnote file kinds still require url IS NULL.
        let bad = conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a-bad', ?1, 'n', 'note', 'n-fn/z.md', 'not-allowed', 1, 2, ?2)",
            params![note_id, now_iso()],
        );
        assert!(bad.is_err(), "note kind must still forbid url");
    }

    // P2 1단계 후행 제안(V39): suggestions 테이블 존재 + UNIQUE(kind,note_id,related_note_id)가
    // 실제로 재제안(같은 쌍 재삽입)을 막는지만 확인한다 — 겹침 판정 로직 자체는
    // embedding::overlap 단위테스트가 커버한다(이 파일은 스키마 제약만 책임진다).
    #[test]
    fn test_v39_suggestions_table_and_unique_pair_constraint() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 39);
        conn.execute(
            "INSERT INTO suggestions(id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
             VALUES ('sg1', 'ws1', 'overlap', 'n1', 'n2', '{}', 0.9, 'pending', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        )
        .unwrap();
        // Default status is 'pending' when omitted.
        conn.execute(
            "INSERT INTO suggestions(id, workspace_id, kind, note_id, related_note_id, payload, score, created_at, updated_at)
             VALUES ('sg2', 'ws1', 'overlap', 'n3', 'n4', '{}', 0.9, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let status: String = conn
            .query_row("SELECT status FROM suggestions WHERE id='sg2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "pending");

        // A duplicate (kind, note_id, related_note_id) must be rejected by the UNIQUE constraint —
        // this is the DB-level backstop behind "INSERT OR IGNORE never re-proposes a dismissed pair".
        let dup = conn.execute(
            "INSERT INTO suggestions(id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
             VALUES ('sg3', 'ws1', 'overlap', 'n1', 'n2', '{}', 0.95, 'pending', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        );
        assert!(dup.is_err(), "same (kind,note_id,related_note_id) pair must be rejected");
    }

    // P2 링크 정합성(V41): 링크는 대상 노트가 같아도 URL별로 독립적인 pending 제안이어야 하고,
    // 동일 노트·URL의 pending 제안만 중복을 막아야 한다.
    #[test]
    fn test_v41_link_url_scoped_pending_uniqueness() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 41);

        let insert = |id: &str, url: &str, status: &str| {
            conn.execute(
                "INSERT INTO suggestions
                 (id, workspace_id, kind, note_id, related_note_id, link_url, payload, score, status, created_at, updated_at)
                 VALUES (?1, 'ws1', 'link', 'n1', 'n2', ?2, '{}', 0.5, ?3, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
                params![id, url, status],
            )
        };

        insert("link-1", "https://example.com/one", "pending").unwrap();
        insert("link-2", "https://example.com/two", "pending").unwrap();
        assert!(insert("link-dup", "https://example.com/one", "pending").is_err());

        conn.execute("UPDATE suggestions SET status='dismissed' WHERE id='link-1'", [])
            .unwrap();
        insert("link-retry", "https://example.com/one", "pending").unwrap();

        let overlap = conn.execute(
            "INSERT INTO suggestions
             (id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
             VALUES ('overlap-1', 'ws1', 'overlap', 'n1', 'n2', '{}', 0.5, 'pending', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        );
        assert!(overlap.is_ok());
        let overlap_dup = conn.execute(
            "INSERT INTO suggestions
             (id, workspace_id, kind, note_id, related_note_id, payload, score, status, created_at, updated_at)
             VALUES ('overlap-2', 'ws1', 'overlap', 'n1', 'n2', '{}', 0.6, 'pending', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        );
        assert!(overlap_dup.is_err());
    }

    // P3 수집 관문(V40): collect_sources/collect_seen 테이블 존재 + collect_seen의 (source_id, guid)
    // 복합 PK가 실제로 중복 삽입을 막는지만 확인한다 — 러너 로직 자체는 collect 모듈의 단위테스트가
    // 커버한다(이 파일은 스키마 제약만 책임진다, V39 테스트와 같은 분업).
    #[test]
    fn test_v40_collect_tables_and_seen_composite_pk() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 40);
        // V96 부터 workspace_id 가 FK — 부모 노트북이 먼저 있어야 한다.
        conn.execute("INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', '2026-08-08')", []).unwrap();
        conn.execute(
            "INSERT INTO collect_sources(id, workspace_id, kind, name, config, enabled, created_at, updated_at)
             VALUES ('cs1', 'ws1', 'rss', 'Example Feed', '{\"url\":\"https://example.com/feed.xml\"}', 1, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collect_seen(source_id, guid) VALUES ('cs1', 'g1')",
            [],
        )
        .unwrap();
        let dup = conn.execute("INSERT INTO collect_seen(source_id, guid) VALUES ('cs1', 'g1')", []);
        assert!(dup.is_err(), "same (source_id, guid) must be rejected by the composite PK");
        // Same guid under a different source is a distinct row (PK is the pair, not guid alone).
        conn.execute(
            "INSERT INTO collect_sources(id, workspace_id, kind, name, config, enabled, created_at, updated_at)
             VALUES ('cs2', 'ws1', 'rss', 'Other Feed', '{\"url\":\"https://example.com/other.xml\"}', 1, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO collect_seen(source_id, guid) VALUES ('cs2', 'g1')", []).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM collect_seen", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    // V96: collect_sources/collect_seen 재생성 — 고아(노트북 없는 소스, 소스 없는 seen)는 버리고 살아있는 행은
    // 모든 컬럼 값 그대로, 컬럼 목록(table_info)·인덱스도 그대로. 실제 앱처럼 foreign_keys=ON 에서 돌린다
    // (부모 DROP 의 암묵 DELETE 가 새 자식을 지우는 순서 실수는 이 설정에서만 드러난다). 끝으로 CASCADE 확인.
    #[test]
    fn test_v96_collect_fk_rebuild_drops_orphans_and_keeps_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let before_96: Vec<_> = migrations().into_iter().filter(|(v, _)| *v < 96).collect();
        apply(&mut conn, &before_96).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces(id, name, created_at) VALUES ('ws1', 'ws', '2026-01-01');
             INSERT INTO collect_sources(id, workspace_id, kind, name, config, enabled, last_run_at, last_status, last_error,
                 created_at, updated_at, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, show_in_briefing)
               VALUES ('ok', 'ws1', 'rss', 'Feed', '{\"u\":1}', 0, '2026-02-01', 'error', 'boom',
                 '2026-01-01', '2026-01-02', 1, 'f9', 'summary', 'llama', 15, 0);
             INSERT INTO collect_sources(id, workspace_id, kind, name, config, created_at, updated_at)
               VALUES ('orphan', 'ws-gone', 'rss', 'Orphan', '{}', '2026-01-01', '2026-01-01');
             INSERT INTO collect_seen(source_id, guid) VALUES ('ok', 'g1'), ('ok', 'g2'), ('orphan', 'g1'), ('no-src', 'g1');",
        )
        .unwrap();
        let cols = |c: &Connection, t: &str| -> Vec<(String, String, i64, Option<String>, i64)> {
            let mut st = c.prepare(&format!("PRAGMA table_info({t})")).unwrap();
            st.query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        let row = |c: &Connection| -> Vec<rusqlite::types::Value> {
            let n = cols(c, "collect_sources").len();
            c.query_row("SELECT * FROM collect_sources WHERE id = 'ok'", [], |r| {
                (0..n).map(|i| r.get::<_, rusqlite::types::Value>(i)).collect()
            })
            .unwrap()
        };
        let (src_cols, seen_cols, ok_row) = (cols(&conn, "collect_sources"), cols(&conn, "collect_seen"), row(&conn));

        apply(&mut conn, &migrations()).unwrap();
        assert!(current_version(&conn).unwrap() >= 96);

        assert_eq!(cols(&conn, "collect_sources"), src_cols, "every column (and its default) survives");
        assert_eq!(cols(&conn, "collect_seen"), seen_cols);
        assert_eq!(row(&conn), ok_row, "the valid source keeps all its values");
        let ids = |sql: &str| -> Vec<String> {
            let mut st = conn.prepare(sql).unwrap();
            st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(ids("SELECT id FROM collect_sources"), vec!["ok"]);
        assert_eq!(ids("SELECT source_id || ':' || guid FROM collect_seen ORDER BY 1"), vec!["ok:g1", "ok:g2"]);
        assert_eq!(
            ids("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='collect_sources' AND name NOT LIKE 'sqlite_%'"),
            vec!["idx_collect_sources_workspace"]
        );
        let fk_check: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(fk_check, 0);

        conn.execute("DELETE FROM workspaces WHERE id = 'ws1'", []).unwrap();
        assert!(ids("SELECT id FROM collect_sources").is_empty(), "notebook delete cascades to its sources");
        assert!(ids("SELECT guid FROM collect_seen").is_empty(), "and on to their seen rows");
    }

    // docs/PLAN-schedule-system.md §1.5: V42 4컬럼이 기존 행에 전부 NULL로 백필되는지 —
    // test_v23_event_precision_columns 와 동일한 관례(ADD COLUMN 의 기본 백필은 별도 마이그레이션
    // 단계가 아니라 컬럼 정의 자체다).
    #[test]
    fn test_v42_schedule_columns_default_null() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 42);
        let ws_id = crate::repo::folders::active_workspace_id(&conn).unwrap();
        let folder_id: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        let (start_time, end_time, remind_offset_min, rrule): (
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT start_time, end_time, remind_offset_min, rrule FROM notes WHERE id='n1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(start_time, None);
        assert_eq!(end_time, None);
        assert_eq!(remind_offset_min, None);
        assert_eq!(rrule, None);

        // Well-formed values round-trip through the CHECK.
        conn.execute(
            "UPDATE notes SET start_time='09:00', end_time='10:30', remind_offset_min=15, rrule='FREQ=WEEKLY' WHERE id='n1'",
            [],
        )
        .unwrap();
    }

    // docs/PLAN-schedule-system.md §1.5: CHECK 는 길이/자릿수 모양만 거른다 — "7:00"(length 4),
    // "0700"(콜론 없음) 은 거부. GLOB 통과분("29:59" 같은 실재하지 않는 시각)은 이 테스트의 범위
    // 밖이다(Rust parse_hhmm_min 이 잡는다, 주석 참조).
    #[test]
    fn test_v42_time_check_rejects_malformed() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        let ws_id = crate::repo::folders::active_workspace_id(&conn).unwrap();
        let folder_id: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        conn.execute("UPDATE notes SET start_time='7:00' WHERE id='n1'", [])
            .unwrap_err();
        conn.execute("UPDATE notes SET start_time='0700' WHERE id='n1'", [])
            .unwrap_err();
        conn.execute("UPDATE notes SET end_time='7:00' WHERE id='n1'", [])
            .unwrap_err();
    }

    // docs/PLAN-schedule-system.md §1.2: remind_offset_min 상한 40320(28일), 음수 금지.
    #[test]
    fn test_v42_offset_range() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        let ws_id = crate::repo::folders::active_workspace_id(&conn).unwrap();
        let folder_id: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        conn.execute("UPDATE notes SET remind_offset_min=-1 WHERE id='n1'", [])
            .unwrap_err();
        conn.execute("UPDATE notes SET remind_offset_min=40321 WHERE id='n1'", [])
            .unwrap_err();
        conn.execute("UPDATE notes SET remind_offset_min=40320 WHERE id='n1'", [])
            .unwrap();
        conn.execute("UPDATE notes SET remind_offset_min=0 WHERE id='n1'", [])
            .unwrap();
    }

    /// V43 (SCALABILITY.md §0): 달력 월키 생성 컬럼 + 인덱스. 기존 DB(V42까지 적용)와 신규 DB
    /// 양쪽에서 컬럼/인덱스가 생기고, 이미 저장된 행에도 값이 **즉시** 계산되어 보이는지
    /// (생성 컬럼이라 백필 UPDATE 가 없다) 확인한다.
    #[test]
    fn test_v43_span_month_generated_columns_and_indexes() {
        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        // ── 기존 DB 경로: V42 까지 적용 → 행을 넣어두고 → V43 적용.
        let mut conn = Connection::open_in_memory().unwrap();
        let through_42: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 42).collect();
        apply(&mut conn, &through_42).unwrap();
        seed(&mut conn).unwrap();
        assert!(!has_index(&conn, "idx_notes_span_month"), "V43 이전에는 없다");

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        // year-only(월 정밀도 없음) → lo = 1월, hi = 12월.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n-year', ?1, 'year only', 1500, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        // 종료일이 시작보다 과거(스왑 케이스) → MIN/MAX 가 event_span_ords 의 swap 과 같이 뒤집는다.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, month, day, end_year, end_month, end_day,
                               created_at, updated_at)
             VALUES ('n-swap', ?1, 'swapped', 2000, 6, 15, 1999, 3, 1, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();

        apply(&mut conn, &[(43, V43_SQL)]).unwrap();
        assert!(has_index(&conn, "idx_notes_span_month"));
        assert!(has_index(&conn, "idx_notes_rrule_span"));

        let (lo, hi): (i64, i64) = conn
            .query_row(
                "SELECT span_month_lo, span_month_hi FROM notes WHERE id='n-year'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(lo, 1500 * 12, "year-only 의 시작은 그 해 1월");
        assert_eq!(hi, 1500 * 12 + 11, "year-only 의 끝은 그 해 12월");

        let (lo, hi): (i64, i64) = conn
            .query_row(
                "SELECT span_month_lo, span_month_hi FROM notes WHERE id='n-swap'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(lo, 1999 * 12 + 2, "end < start 면 MIN 이 종료 쪽");
        assert_eq!(hi, 2000 * 12 + 5);

        // ── 신규 DB 경로.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 43);
        assert!(has_index(&fresh, "idx_notes_span_month"));
        assert!(has_index(&fresh, "idx_notes_rrule_span"));
    }

    /// V44 (SCALABILITY.md §0): 보드 티어 축. end_sort_key 는 schedule_bucket 의 채움 규칙
    /// (월/일 없으면 1)을 그대로 따라야 하고 — 그래서 "연 정밀도"와 "그 해 1월 1일"이 **같은 키**다 —
    /// 부분 인덱스 셋이 기존 DB(V43까지)와 신규 DB 양쪽에 생겨야 한다.
    #[test]
    fn test_v44_board_tier_key_and_partial_indexes() {
        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_43: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 43).collect();
        apply(&mut conn, &through_43).unwrap();
        seed(&mut conn).unwrap();
        assert!(!has_index(&conn, "idx_notes_end_sort_alive"), "V44 이전에는 없다");

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        let mk = |id: &str, end: (Option<i64>, Option<i64>, Option<i64>)| {
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, end_year, end_month, end_day,
                                   created_at, updated_at)
                 VALUES (?1, ?2, 't', 1900, ?3, ?4, ?5, ?6, ?6)",
                params![id, folder_id, end.0, end.1, end.2, now],
            )
            .unwrap();
        };
        mk("n-year", (Some(2050), None, None));
        mk("n-jan1", (Some(2050), Some(1), Some(1)));
        mk("n-full", (Some(2050), Some(3), Some(4)));
        mk("n-none", (None, None, None));
        mk("n-bce", (Some(-500), Some(3), Some(4)));

        apply(&mut conn, &[(44, V44_SQL)]).unwrap();
        assert!(has_index(&conn, "idx_notes_end_sort_alive"));
        assert!(has_index(&conn, "idx_notes_undated_updated_alive"));
        assert!(has_index(&conn, "idx_notes_remind_end"));

        let key = |c: &Connection, id: &str| -> Option<i64> {
            c.query_row("SELECT end_sort_key FROM notes WHERE id=?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(
            key(&conn, "n-year"),
            key(&conn, "n-jan1"),
            "연 정밀도는 그 해 1월 1일과 같은 키 — schedule_bucket 의 unwrap_or(1) 과 동일"
        );
        assert_eq!(key(&conn, "n-year"), Some(2050 * 10000 + 100 + 1));
        assert_eq!(key(&conn, "n-full"), Some(2050 * 10000 + 300 + 4));
        assert_eq!(key(&conn, "n-none"), None, "종료일이 없으면 키도 없다(② 인덱스 밖)");
        assert!(
            key(&conn, "n-bce").unwrap() < key(&conn, "n-year").unwrap(),
            "기원전 종료일도 수치 순서가 옳다"
        );

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 44);
        assert!(has_index(&fresh, "idx_notes_end_sort_alive"));
        assert!(has_index(&fresh, "idx_notes_undated_updated_alive"));
        assert!(has_index(&fresh, "idx_notes_remind_end"));
    }

    /// V46: pet_messages.meta (챗 칩/표시문구/실패 플래그). 기존 DB(V45까지)와 신규 DB 모두 컬럼이 생긴다.
    #[test]
    fn test_v46_pet_messages_meta_column() {
        let has_meta = |c: &Connection| -> bool {
            let mut stmt = c.prepare("PRAGMA table_info(pet_messages)").unwrap();
            let names: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            names.iter().any(|n| n == "meta")
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_45: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 45).collect();
        apply(&mut conn, &through_45).unwrap();
        assert!(!has_meta(&conn), "V46 이전에는 meta 가 없다");

        apply(&mut conn, &[(46, V46_SQL)]).unwrap();
        assert!(has_meta(&conn));

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 46);
        assert!(has_meta(&fresh));
    }

    /// V47: pet_sessions + pet_messages.session_id. 기존 메시지가 있는 노트북마다 라이브 세션 1개.
    #[test]
    fn test_v47_pet_sessions_backfill_live_session() {
        let has_session_id = |c: &Connection| -> bool {
            let mut stmt = c.prepare("PRAGMA table_info(pet_messages)").unwrap();
            let names: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            names.iter().any(|n| n == "session_id")
        };
        let has_sessions = |c: &Connection| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pet_sessions'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_46: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 46).collect();
        apply(&mut conn, &through_46).unwrap();
        assert!(!has_session_id(&conn), "V47 이전에는 session_id 가 없다");
        assert!(!has_sessions(&conn));

        seed(&mut conn).unwrap();
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO pet_messages (id, workspace_id, role, text, created_at, meta)
             VALUES ('pm-u', ?1, 'user', '옛 질문', '2026-08-01T00:00:00.000Z', NULL)",
            [&ws],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pet_messages (id, workspace_id, role, text, created_at, meta)
             VALUES ('pm-a', ?1, 'assistant', '옛 답', '2026-08-01T00:00:01.000Z', NULL)",
            [&ws],
        )
        .unwrap();

        apply(&mut conn, &[(47, V47_SQL)]).unwrap();
        assert!(has_session_id(&conn));
        assert!(has_sessions(&conn));

        let (sid, closed_at, count, title): (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT id, closed_at, message_count, title FROM pet_sessions WHERE workspace_id = ?1",
                [&ws],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert!(closed_at.is_none(), "백필 세션은 라이브");
        assert_eq!(count, 2);
        assert_eq!(title, "옛 질문");
        let n_sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM pet_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_sessions, 1, "메시지 있는 노트북마다 세션 1개");
        let linked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pet_messages WHERE session_id = ?1",
                [&sid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, 2);
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pet_messages WHERE session_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 47);
        assert!(has_session_id(&fresh));
        assert!(has_sessions(&fresh));
    }

    #[test]
    fn test_v50_space_schema_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 50);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // Check space_bootstrapped column exists and defaults to 0
        let bootstrapped: i64 = conn
            .query_row(
                "SELECT space_bootstrapped FROM workspaces WHERE id = ?1",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bootstrapped, 0);

        // Insert space
        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
             VALUES ('sp1', ?1, 'Main Space', 0, 1, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        // Insert space_item
        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, content, x, y, width, height, z_index, created_at, updated_at)
             VALUES ('item1', 'sp1', 'text', 'Hello World', 10.0, 20.0, 200.0, 100.0, 1000, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')",
            [],
        )
        .unwrap();

        // Unique index check: cannot insert another is_home=1 space in the same workspace
        let err = conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
             VALUES ('sp2', ?1, 'Second Home', 1, 1, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')",
            [&ws_id],
        );
        assert!(err.is_err(), "must not allow two home spaces in same workspace");
    }

    #[test]
    fn test_v51_space_favorite_archive_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 51);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // Insert space with default favorite and null archived_at
        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
             VALUES ('sp1', ?1, 'Main Space', 0, 1, '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        let (is_fav, arch_at): (i64, Option<String>) = conn
            .query_row(
                "SELECT is_favorite, archived_at FROM spaces WHERE id = 'sp1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(is_fav, 0);
        assert_eq!(arch_at, None);

        // Update favorite and archive
        conn.execute(
            "UPDATE spaces SET is_favorite = 1, archived_at = '2026-08-16T01:00:00Z' WHERE id = 'sp1'",
            [],
        )
        .unwrap();

        let (is_fav2, arch_at2): (i64, Option<String>) = conn
            .query_row(
                "SELECT is_favorite, archived_at FROM spaces WHERE id = 'sp1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(is_fav2, 1);
        assert_eq!(arch_at2.as_deref(), Some("2026-08-16T01:00:00Z"));
    }

    #[test]
    fn test_v52_spaces_default_style() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 52);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
             VALUES ('sp1', ?1, 'Styled Space', 0, 1, '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        let default_style: String = conn
            .query_row(
                "SELECT default_style FROM spaces WHERE id = 'sp1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(default_style, "");

        conn.execute(
            "UPDATE spaces SET default_style = '{\"shape\":\"rounded\"}' WHERE id = 'sp1'",
            [],
        )
        .unwrap();

        let updated_style: String = conn
            .query_row(
                "SELECT default_style FROM spaces WHERE id = 'sp1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated_style, "{\"shape\":\"rounded\"}");
    }

    #[test]
    fn test_v53_space_items_kind_widget() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 53);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
             VALUES ('sp1', ?1, 'Widget Space', 0, 1, '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, content, x, y, width, height, z_index, created_at, updated_at)
             VALUES ('w1', 'sp1', 'widget', '{\"type\":\"clock\"}', 0, 0, 150, 150, 1000, '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
            [],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM space_items WHERE kind = 'widget'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_v54_routine_completions() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 54);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, created_at)
             VALUES ('f1', ?1, 'Default', 0, '2026-08-16T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', 'f1', 'Routine Note', 2026, '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO routine_completions(note_id, occur_on, done_at)
             VALUES ('n1', '2026-08-16', '2026-08-16T12:00:00Z')",
            [],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM routine_completions WHERE note_id = 'n1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // Test cascade on note deletion
        conn.execute("DELETE FROM notes WHERE id = 'n1'", []).unwrap();
        let count_after: i64 = conn
            .query_row(
                "SELECT count(*) FROM routine_completions WHERE note_id = 'n1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_after, 0);
    }

    #[test]
    fn test_v82_timeline_routines() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 82);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, color_hue, position, created_at, updated_at)
             VALUES ('tr1', ?1, '출퇴근', 31, '09:00', '18:00', 200, 0, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM timeline_routines WHERE id = 'tr1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // end_time > start_time CHECK — end == start must be rejected.
        let bad = conn.execute(
            "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, position, created_at, updated_at)
             VALUES ('tr2', ?1, 'bad', 1, '09:00', '09:00', 1, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')",
            [&ws_id],
        );
        assert!(bad.is_err());

        // weekday_mask range CHECK (1..127) — 0 must be rejected.
        let bad_mask = conn.execute(
            "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, position, created_at, updated_at)
             VALUES ('tr3', ?1, 'bad', 0, '09:00', '10:00', 1, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')",
            [&ws_id],
        );
        assert!(bad_mask.is_err());

        // Cascade on workspace deletion.
        conn.execute("DELETE FROM workspaces WHERE id = ?1", [&ws_id]).unwrap();
        let count_after: i64 = conn
            .query_row("SELECT count(*) FROM timeline_routines WHERE id = 'tr1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after, 0);
    }

    #[test]
    fn test_v83_timeline_routines_skip_holidays() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 83);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // Existing insert shape (no skip_holidays) still works — defaults to 0 (off), no behavior
        // change for rows written before this column existed.
        conn.execute(
            "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, position, created_at, updated_at)
             VALUES ('tr1', ?1, '출퇴근', 31, '09:00', '18:00', 0, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();
        let default_flag: i64 = conn
            .query_row("SELECT skip_holidays FROM timeline_routines WHERE id = 'tr1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(default_flag, 0);

        conn.execute(
            "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, skip_holidays, position, created_at, updated_at)
             VALUES ('tr2', ?1, '헬스', 127, '19:00', '20:00', 1, 1, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();
        let on_flag: i64 = conn
            .query_row("SELECT skip_holidays FROM timeline_routines WHERE id = 'tr2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(on_flag, 1);

        // CHECK (skip_holidays IN (0,1)) — anything else must be rejected.
        let bad = conn.execute(
            "INSERT INTO timeline_routines(id, workspace_id, title, weekday_mask, start_time, end_time, skip_holidays, position, created_at, updated_at)
             VALUES ('tr3', ?1, 'bad', 1, '09:00', '10:00', 2, 2, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')",
            [&ws_id],
        );
        assert!(bad.is_err());
    }

    #[test]
    fn v65_migration_preserves_canvas_items_and_edges() {
        let mut conn = Connection::open_in_memory().unwrap();
        // V64까지 적용
        let all_migrations = migrations();
        let v64_migrations: Vec<_> = all_migrations.into_iter().filter(|(v, _)| *v <= 64).collect();
        apply(&mut conn, &v64_migrations).unwrap();

        conn.execute(
            "INSERT INTO space_canvases (id, title, position, created_at, updated_at) VALUES ('c1', 'C1', 0, '2026-08-27', '2026-08-27')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_canvas_items (id, canvas_id, kind, content, x, y, width, height, created_at, updated_at)
             VALUES ('it1', 'c1', 'text', 'hello', 10, 20, 100, 50, '2026-08-27', '2026-08-27')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_canvas_items (id, canvas_id, kind, content, x, y, width, height, created_at, updated_at)
             VALUES ('it2', 'c1', 'checklist', '[]', 110, 20, 100, 50, '2026-08-27', '2026-08-27')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_canvas_edges (id, canvas_id, source_item_id, target_item_id, kind, created_at, updated_at)
             VALUES ('e1', 'c1', 'it1', 'it2', 'default', '2026-08-27', '2026-08-27')",
            [],
        )
        .unwrap();

        // 이제 V65 적용
        apply(&mut conn, &[(65, V65_SQL)]).unwrap();

        // 데이터 보존 확인
        let it_count: i64 = conn.query_row("SELECT COUNT(*) FROM space_canvas_items", [], |r| r.get(0)).unwrap();
        assert_eq!(it_count, 2);
        let ed_count: i64 = conn.query_row("SELECT COUNT(*) FROM space_canvas_edges", [], |r| r.get(0)).unwrap();
        assert_eq!(ed_count, 1);

        // widget kind 허용 확인
        let r_widget = conn.execute(
            "INSERT INTO space_canvas_items (id, canvas_id, kind, content, x, y, width, height, created_at, updated_at)
             VALUES ('it-w', 'c1', 'widget', '{\"type\":\"d_day\"}', 0, 0, 280, 200, '2026-08-27', '2026-08-27')",
            [],
        );
        assert!(r_widget.is_ok(), "widget kind should be allowed after V65");
    }

    /// 노트를 지워도 **계획 단계는 살아남는다** — docs/SPACE.md §0 의 "공간은 내가 세운 구조"가
    /// 노트의 수명에 끌려가면 안 된다는 뜻이다.
    ///
    /// V56 은 이걸 space_nodes.note_id 의 FK ON DELETE SET NULL 로 보장했다. V58 에서 노드가
    /// **캔버스 아이템**이 되면서 노트 링크는 space_items.source_id 로 옮겨졌고, 그 컬럼에는
    /// FK 가 없다(캔버스가 원래 노트 아이템을 다루던 방식 그대로다). 보장은 그대로지만 수단이
    /// 바뀌었다 — 행은 남고, 사라진 노트는 UI 가 tombstone 으로 그린다
    /// (SpaceSelectionBar 의 `tombstone`).
    #[test]
    fn note_deletion_keeps_the_canvas_item() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, created_at, updated_at) VALUES ('sp1', ?1, 'S', 0, '', '')",
            [&ws_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES ('note1', ?1, 'Goal Note', 2026, '', '')",
            [&folder_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, source_id, content, x, y, width, height, created_at, updated_at)              VALUES ('item1', 'sp1', 'note', 'note1', 'Step 1', 0, 0, 160, 80, '', '')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM notes WHERE id = 'note1'", []).unwrap();

        let survived: i64 = conn
            .query_row("SELECT COUNT(*) FROM space_items WHERE id = 'item1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(survived, 1, "노트를 지웠다고 계획 단계까지 사라지면 안 된다");
    }

    #[test]
    fn test_v56_migration_preserves_blob_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Apply migrations up to V55
        let v55_migrations: Vec<_> = migrations().into_iter().filter(|(v, _)| *v <= 55).collect();
        apply(&mut conn, &v55_migrations).unwrap();
        seed(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, created_at) VALUES ('f1', ?1, 'Default', 0, '2026-08-19T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES ('n-mind', 'f1', 'Mind Note', 2026, '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at) VALUES ('sp-legacy', ?1, 'Legacy Space', 0, 1, '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        // 1. Mind Map item
        let mind_content = r#"{"type":"mind_map","nodes":[{"id":"m1","label":"Root","parent":null,"note_id":"n-mind","collapsed":false},{"id":"m2","label":"Child","parent":"m1","collapsed":true}]}"#;
        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, content, x, y, width, height, z_index, created_at, updated_at) VALUES ('item-mind', 'sp-legacy', 'widget', ?1, 0, 0, 400, 300, 1000, '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')",
            [mind_content],
        )
        .unwrap();

        // 2. Skill Tree item
        let skill_content = r#"{"type":"skill_tree","nodes":[{"id":"sk1","label":"Skill 1","status":"done"},{"id":"sk2","label":"Skill 2","status":"available"}],"edges":[{"from":"sk1","to":"sk2","kind":"requires"}]}"#;
        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, content, x, y, width, height, z_index, created_at, updated_at) VALUES ('item-skill', 'sp-legacy', 'widget', ?1, 0, 0, 400, 300, 2000, '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')",
            [skill_content],
        )
        .unwrap();

        // 3. Milestone Path item
        let milestone_content = r#"{"type":"milestone_path","items":[{"id":"ms1","label":"Milestone 1","due_on":"2026-09-01","done":true},{"id":"ms2","label":"Milestone 2","done":false}]}"#;
        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, content, x, y, width, height, z_index, created_at, updated_at) VALUES ('item-ms', 'sp-legacy', 'widget', ?1, 0, 0, 400, 300, 3000, '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')",
            [milestone_content],
        )
        .unwrap();

        // 전체 마이그레이션 — V56 이 블롭을 관계 테이블로 옮기고, V58 이 그것을 다시
        // **캔버스 아이템**으로 올린다. 이 테스트가 지키는 것은 그 두 단계를 거쳐도
        // **아무것도 사라지지 않는다**는 것이다.
        // 전체 마이그레이션 — V56 이 블롭을 관계 테이블로 옮기고, V58 이 그것을 다시
        // **캔버스 아이템**으로 올린다. 이 테스트가 지키는 것은 두 단계를 거쳐도
        // **아무것도 사라지지 않는다**는 것이다.
        apply(&mut conn, &migrations()).unwrap();

        // 마인드맵 2 + 스킬트리 2 + 마일스톤 2 = 노드 6개가 캔버스 아이템으로 살아 있다.
        let migrated: i64 = conn
            .query_row(
                "SELECT count(*) FROM space_items WHERE id IN ('m1','m2','sk1','sk2','ms1','ms2')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(migrated, 6, "블롭의 노드가 캔버스 아이템으로 전부 옮겨져야 한다");

        // 노트에 매달려 있던 노드는 kind='note' + source_id 로 그 연결을 유지한다.
        let m1_source: Option<String> = conn
            .query_row("SELECT source_id FROM space_items WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(m1_source, Some("n-mind".to_string()), "노트 연결이 살아남아야 한다");

        // 간선도 캔버스 레벨로 옮겨져 아이템끼리 잇는다.
        let edges: i64 = conn
            .query_row(
                "SELECT count(*) FROM space_edges WHERE source_item_id IN ('m1','sk1','ms1')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            edges >= 3,
            "세 구조의 간선이 캔버스 레벨로 옮겨져야 한다 — 마일스톤의 순서는 position 으로만              있었으므로 next 간선으로 명시돼야 한다 (실제 {edges})"
        );
    }

    #[test]
    fn test_v60_collect_and_ai_usage() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 60);

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // collect_sources 신규 컬럼 검증
        conn.execute(
            "INSERT INTO collect_sources(id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, created_at, updated_at)
             VALUES ('cs1', ?1, 'rss', 'Feed', '{}', 1, 1, 'f1', 'suggest', 'gpt-4o', 30, '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z')",
            [&ws_id],
        )
        .unwrap();

        let (dry_run, post_process, interval_mins): (i64, String, Option<i64>) = conn
            .query_row(
                "SELECT dry_run, post_process, interval_minutes FROM collect_sources WHERE id = 'cs1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(dry_run, 1);
        assert_eq!(post_process, "suggest");
        assert_eq!(interval_mins, Some(30));

        // ai_usage 테이블 검증
        conn.execute(
            "INSERT INTO ai_usage(workspace_id, day, action_type, provider, calls)
             VALUES (?1, '2026-08-23', 'organize', 'ollama', 1)
             ON CONFLICT (workspace_id, day, action_type, provider)
             DO UPDATE SET calls = calls + 1",
            [&ws_id],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO ai_usage(workspace_id, day, action_type, provider, calls)
             VALUES (?1, '2026-08-23', 'organize', 'ollama', 1)
             ON CONFLICT (workspace_id, day, action_type, provider)
             DO UPDATE SET calls = calls + 1",
            [&ws_id],
        )
        .unwrap();

        let calls: i64 = conn
            .query_row(
                "SELECT calls FROM ai_usage WHERE workspace_id = ?1 AND day = '2026-08-23' AND action_type = 'organize'",
                [&ws_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(calls, 2);
    }

    /// V66: 공간(Space)→캔버스(Canvas) / 캔버스(Canvas)→페이지(Page) 개명 — 테이블·컬럼 rename +
    /// 행 데이터 보존 + 이미지 source_id 재작성('spaces/…'→'canvas_pages/…') + settings 키
    /// 이관(space_enabled/space_shortcut→canvas_enabled/canvas_shortcut)을 한 번에 검증한다.
    #[test]
    fn canvas_pages_migration_renames_and_preserves_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_65: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 65).collect();
        apply(&mut conn, &through_65).unwrap();

        // 구 스키마로 캔버스 1개 + 아이템 2개(이미지 1 + 텍스트 1) + 엣지 1개를 심는다.
        conn.execute(
            "INSERT INTO space_canvases (id, title, position, is_favorite, last_viewport_x, last_viewport_y, last_viewport_zoom, default_style, layout_locked, created_at, updated_at)
             VALUES ('cv1', 'My Canvas', 0, 0, 0.0, 0.0, 1.0, '', 0, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_canvas_items (id, canvas_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
             VALUES ('it-img', 'cv1', 'image', 'spaces/cv1/pic.png', '', 0, 0, 100, 100, 0, 'preview', '', 0, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_canvas_items (id, canvas_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
             VALUES ('it-txt', 'cv1', 'text', NULL, 'hello', 200, 0, 100, 100, 0, 'preview', '', 0, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_canvas_edges (id, canvas_id, source_item_id, target_item_id, kind, label, created_at, updated_at)
             VALUES ('e1', 'cv1', 'it-img', 'it-txt', 'default', NULL, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO settings(key, value) VALUES ('space_enabled', '1')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('space_shortcut', 'Ctrl+Alt+Space')",
            [],
        )
        .unwrap();

        apply(&mut conn, &[(66, V66_SQL)]).unwrap();

        // 신규 테이블명으로 행 데이터 보존.
        let (title, pos): (String, i64) = conn
            .query_row("SELECT title, position FROM canvas_pages WHERE id = 'cv1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, "My Canvas");
        assert_eq!(pos, 0);

        // canvas_id → page_id 컬럼 rename + 이미지 아이템 source_id 재작성(spaces/→canvas_pages/).
        let (page_id, source_id): (String, Option<String>) = conn
            .query_row(
                "SELECT page_id, source_id FROM canvas_page_items WHERE id = 'it-img'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(page_id, "cv1");
        assert_eq!(source_id.as_deref(), Some("canvas_pages/cv1/pic.png"));

        // 텍스트 아이템(kind != 'image')은 재작성 대상이 아니다 — 애초에 NULL 이었으므로 그대로.
        let txt_source: Option<String> = conn
            .query_row("SELECT source_id FROM canvas_page_items WHERE id = 'it-txt'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(txt_source, None);

        // 엣지도 canvas_id → page_id.
        let edge_page_id: String = conn
            .query_row("SELECT page_id FROM canvas_page_edges WHERE id = 'e1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edge_page_id, "cv1");

        // settings 키 이관 — 값은 그대로, 키만 바뀐다.
        let enabled: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'canvas_enabled'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(enabled, "1");
        let shortcut: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'canvas_shortcut'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(shortcut, "Ctrl+Alt+Space");
        let old_settings_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key IN ('space_enabled', 'space_shortcut')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_settings_left, 0, "구 설정 키는 이관 후 남아있으면 안 된다");

        // 구 테이블명은 sqlite_master 에서 완전히 사라졌다.
        let old_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('space_canvases','space_canvas_items','space_canvas_edges')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_tables, 0);
    }

    /// V66 이후에도 canvas_pages → canvas_page_items/canvas_page_edges CASCADE 가 실제로 도는지
    /// 직접 삭제해 확인한다 — RENAME TO/RENAME COLUMN 이 FK REFERENCES 절을 갱신했다는 근거는
    /// PLAN 문서상 SQLite 버전 확인이지, 이 테스트가 실측이다(쿼리가 에러 없이 도는 것만으로는
    /// 부족 — 자식 행이 실제로 사라졌는지까지 확인).
    #[test]
    fn canvas_pages_migration_fk_cascade_still_works() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert!(current_version(&conn).unwrap() >= 66);

        conn.execute(
            "INSERT INTO canvas_pages (id, title, position, created_at, updated_at) VALUES ('cv1', 'C', 0, '', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO canvas_page_items (id, page_id, kind, content, x, y, width, height, created_at, updated_at)
             VALUES ('it1', 'cv1', 'text', 'a', 0, 0, 100, 100, '', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO canvas_page_items (id, page_id, kind, content, x, y, width, height, created_at, updated_at)
             VALUES ('it2', 'cv1', 'text', 'b', 100, 0, 100, 100, '', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO canvas_page_edges (id, page_id, source_item_id, target_item_id, kind, created_at, updated_at)
             VALUES ('e1', 'cv1', 'it1', 'it2', 'default', '', '')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM canvas_pages WHERE id = 'cv1'", []).unwrap();

        let items_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM canvas_page_items WHERE page_id = 'cv1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(items_left, 0, "부모 canvas_pages 삭제 시 canvas_page_items 도 CASCADE 되어야 한다");

        let edges_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM canvas_page_edges WHERE id = 'e1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edges_left, 0, "부모 canvas_pages 삭제 시 canvas_page_edges 도 CASCADE 되어야 한다(간접 참조 포함)");
    }

    /// V66 은 space_canvases/space_canvas_items/space_canvas_edges 만 건드린다 — 휴면
    /// spaces/space_items(노트북 백업/복원 기능, transfer/bundle.rs 가 지금도 소비)는 이번
    /// 개명과 무관하므로 전후 완전히 그대로여야 한다. 스코프 제외 결정의 회귀 테스트.
    #[test]
    fn canvas_pages_migration_leaves_dormant_tables_untouched() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_65: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 65).collect();
        apply(&mut conn, &through_65).unwrap();
        seed(&mut conn).unwrap();

        let ws_id: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO spaces(id, workspace_id, title, position, is_home, created_at, updated_at)
             VALUES ('sp1', ?1, '휴면 공간', 0, 1, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')",
            params![ws_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO space_items(id, space_id, kind, source_id, content, x, y, width, height, created_at, updated_at)
             VALUES ('spi1', 'sp1', 'image', 'spaces/sp1/pic.png', '', 0, 0, 100, 100, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')",
            [],
        )
        .unwrap();

        let before_space: (String, i64) = conn
            .query_row("SELECT title, position FROM spaces WHERE id = 'sp1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let before_item_source: Option<String> = conn
            .query_row("SELECT source_id FROM space_items WHERE id = 'spi1'", [], |r| r.get(0))
            .unwrap();

        apply(&mut conn, &[(66, V66_SQL)]).unwrap();

        // 완전히 그대로 — source_id 재작성은 canvas_page_items 만 대상이라 여긴 손대지 않는다.
        let after_space: (String, i64) = conn
            .query_row("SELECT title, position FROM spaces WHERE id = 'sp1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(before_space, after_space);
        let after_item_source: Option<String> = conn
            .query_row("SELECT source_id FROM space_items WHERE id = 'spi1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before_item_source, after_item_source);
        assert_eq!(after_item_source.as_deref(), Some("spaces/sp1/pic.png"));

        // 테이블 자체도 여전히 존재한다(2개 모두).
        let dormant_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('spaces','space_items')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dormant_tables, 2);
    }

    /// V67: sections.ai_origin TEXT NULL — pre-existing rows backfill to NULL (user-authored,
    /// same as if the column had always been there and nobody had set it), and a fresh write
    /// can set it to an arbitrary action id.
    #[test]
    fn ai_origin_migration_adds_nullable_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_66: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 66).collect();
        apply(&mut conn, &through_66).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position)
             VALUES ('s1', 'n1', 'Overview', '', 0)",
            [],
        )
        .unwrap();

        apply(&mut conn, &[(67, V67_SQL)]).unwrap();

        // Pre-existing row backfills to NULL.
        let ai_origin: Option<String> = conn
            .query_row("SELECT ai_origin FROM sections WHERE id='s1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ai_origin, None);

        // Column accepts an arbitrary action id string.
        conn.execute(
            "UPDATE sections SET ai_origin='summarize' WHERE id='s1'",
            [],
        )
        .unwrap();
        let ai_origin: Option<String> = conn
            .query_row("SELECT ai_origin FROM sections WHERE id='s1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ai_origin.as_deref(), Some("summarize"));
    }

    #[test]
    fn v68_drops_timeline_preset() {
        let mut conn = Connection::open_in_memory().unwrap();
        let m = migrations();
        apply(&mut conn, &m[..67]).unwrap();

        // Before v68, workspaces has timeline_preset column.
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at, timeline_preset) VALUES ('w1', 'W', '2026-01-01', 'korea')",
            [],
        )
        .unwrap();

        apply(&mut conn, &[(68, V68_SQL)]).unwrap();

        // After v68, timeline_preset column is dropped and querying it is an error.
        let res = conn.query_row("SELECT timeline_preset FROM workspaces WHERE id='w1'", [], |r| {
            r.get::<_, Option<String>>(0)
        });
        assert!(res.is_err());
    }

    /// P0-1: V69 이전 스키마(2글자 색인 표 없음)의 DB 를 최신까지 올릴 때 migrate_v69 가
    /// 아직 없는 notes_bigram_map 을 건드려 `no such table` 로 죽던 것. repo 함수는 오늘 스키마를
    /// 가정하므로 시드는 raw SQL 만 쓴다.
    #[test]
    fn test_v69_upgrade_from_old_schema_without_bigram_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        let m = migrations();
        apply(&mut conn, &m[..68]).unwrap();
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at) VALUES ('n1', ?1, '옛 노트', 2026, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        for (id, pos, body) in [
            ("s1", 0, "flowchart TD
  A[\"시작점\"] --> B[\"끝점\"]"),
            ("s2", 1, "sequenceDiagram
  Alice->>Bob: 안녕"),
        ] {
            conn.execute(
                "INSERT INTO sections(id, note_id, name, position, kind, body_md, updated_at) VALUES (?1, 'n1', '섹션', ?2, 'diagram', ?3, '2026-01-01T00:00:00Z')",
                rusqlite::params![id, pos, body],
            )
            .unwrap();
        }

        apply(&mut conn, &m).unwrap();

        let (k1, b1): (String, String) = conn
            .query_row("SELECT kind, body_md FROM sections WHERE id='s1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(k1, "diagram");
        let v1: Value = serde_json::from_str(&b1).expect("IR json");
        assert_eq!(v1["nodes"].as_array().unwrap().len(), 2);
        let (k2, b2): (String, String) = conn
            .query_row("SELECT kind, body_md FROM sections WHERE id='s2'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(k2, "text");
        assert!(b2.starts_with("```mermaid
"));

        let fts_body: String = conn
            .query_row("SELECT body FROM notes_fts WHERE note_id='n1'", [], |r| r.get(0))
            .unwrap();
        assert!(fts_body.contains("Alice"), "변환된 본문이 색인돼야 한다: {fts_body}");
        let fts_n: i64 = conn.query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0)).unwrap();
        let map_n: i64 = conn.query_row("SELECT count(*) FROM notes_bigram_map", [], |r| r.get(0)).unwrap();
        assert_eq!(fts_n, map_n);
    }

    #[test]
    fn test_v69_diagram_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        let m = migrations();
        apply(&mut conn, &m[..68]).unwrap();
        seed(&mut conn).unwrap();
        // 이 테스트는 v68 시점 스키마 위에서 **현재** repo 코드(notes::create → attachments
        // load_for_note)를 부른다 — attachments 에 컬럼이 늘 때마다 여기서 깨진다. v69(섹션 IR
        // 변환)와 무관한 컬럼이라 미리 얹어 둔다(실 설치는 V80_SQL 의 테이블 재작성이 넣는다).
        // sources.truncated(V81_SQL)도 같은 이유 — notes::create → sources::load_for_note 가 읽는다.
        // notes.content_locked(V84_SQL)도 마찬가지 — notes::create → note_summary 가 읽는다.
        conn.execute_batch(
            "ALTER TABLE attachments ADD COLUMN ext_path TEXT NULL;\n\
             ALTER TABLE attachments ADD COLUMN transcript TEXT NULL;\n\
             ALTER TABLE attachments ADD COLUMN transcript_inserted INTEGER NOT NULL DEFAULT 0;\n\
             ALTER TABLE sources ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;\n\
             ALTER TABLE notes ADD COLUMN content_locked INTEGER NOT NULL DEFAULT 0;",
        )
        .unwrap();
        // 2글자 색인(V94_SQL)도 같은 이유 — notes::create → fts::fts_upsert 가 notes_bigram 을 쓴다.
        conn.execute_batch(V94_SQL).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();

        // 1. flowchart 라이더 없음
        let note1 = crate::repo::notes::create(&mut conn, &folder_id, Some("Note 1".into()), Some(2026)).unwrap();
        let sec1_body = "flowchart TD\n  A[\"시작\"] --> B[\"끝\"]";
        let sec1 = crate::repo::sections::create_with_body_and_kind(
            &mut conn,
            &note1.note.id,
            Some("Flowchart 1".into()),
            sec1_body.to_string(),
            Some("diagram".into()),
        ).unwrap();

        // 2. flowchart 라이더 있음 (pos, link, meta)
        let note2 = crate::repo::notes::create(&mut conn, &folder_id, Some("Note 2".into()), Some(2026)).unwrap();
        let sec2_body = "flowchart TD\n  A[\"인천공항\"] --> B[\"나리타공항\"]\n  %% brise:pos A=120,80\n  %% brise:link B=note-uuid-123\n  %% brise:meta A={\"icon\":\"🛩\",\"desc\":\"오전 9:40 출발\"}";
        let sec2 = crate::repo::sections::create_with_body_and_kind(
            &mut conn,
            &note2.note.id,
            Some("Flowchart 2".into()),
            sec2_body.to_string(),
            Some("diagram".into()),
        ).unwrap();

        // 3. flowchart 톤 있음
        let note3 = crate::repo::notes::create(&mut conn, &folder_id, Some("Note 3".into()), Some(2026)).unwrap();
        let sec3_body = "flowchart LR\n  A[\"노드A\"] --> B[\"노드B\"]\n  C[\"노드C\"] --> D[\"노드D\"]\n  class A briseAccent\n  class B briseWarn\n  class C briseDone\n  class D briseMuted";
        let sec3 = crate::repo::sections::create_with_body_and_kind(
            &mut conn,
            &note3.note.id,
            Some("Flowchart 3".into()),
            sec3_body.to_string(),
            Some("diagram".into()),
        ).unwrap();

        // 4. sequenceDiagram (flowchart 아님)
        let note4 = crate::repo::notes::create(&mut conn, &folder_id, Some("Note 4".into()), Some(2026)).unwrap();
        let sec4_body = "sequenceDiagram\n  autonumber\n  Alice->>Bob: Hello John\n  Bob-->>Alice: Hi Alice";
        let sec4 = crate::repo::sections::create_with_body_and_kind(
            &mut conn,
            &note4.note.id,
            Some("Sequence 4".into()),
            sec4_body.to_string(),
            Some("diagram".into()),
        ).unwrap();

        // v69 마이그레이션 적용!
        apply(&mut conn, &[(69, V69_SQL)]).unwrap();

        // 1번 검증: JSON IR, kind='diagram'
        let (k1, b1): (String, String) = conn
            .query_row("SELECT kind, body_md FROM sections WHERE id=?1", [&sec1.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(k1, "diagram");
        let v1: Value = serde_json::from_str(&b1).expect("must parse as json");
        assert_eq!(v1["v"], 1);
        assert_eq!(v1["route"], "curve");
        assert_eq!(v1["states"], serde_json::json!(["강조", "주의", "완료", "흐리게"]));
        let nodes1 = v1["nodes"].as_array().unwrap();
        assert_eq!(nodes1.len(), 2);
        assert_eq!(nodes1[0]["id"], "A");
        assert_eq!(nodes1[0]["label"], "시작");
        assert_eq!(nodes1[1]["id"], "B");
        assert_eq!(nodes1[1]["label"], "끝");
        let edges1 = v1["edges"].as_array().unwrap();
        assert_eq!(edges1.len(), 1);
        assert_eq!(edges1[0]["from"], "A");
        assert_eq!(edges1[0]["to"], "B");
        assert_eq!(edges1[0]["line"], "solid");
        assert_eq!(edges1[0]["arrow"], "end");

        // 2번 검증: pos, link, icon, desc
        let (k2, b2): (String, String) = conn
            .query_row("SELECT kind, body_md FROM sections WHERE id=?1", [&sec2.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(k2, "diagram");
        let v2: Value = serde_json::from_str(&b2).expect("must parse as json");
        let nodes2 = v2["nodes"].as_array().unwrap();
        let a_node = nodes2.iter().find(|n| n["id"] == "A").unwrap();
        assert_eq!(a_node["pos"], serde_json::json!([120, 80]));
        assert_eq!(a_node["icon"], "🛩");
        assert_eq!(a_node["desc"], "오전 9:40 출발");
        let b_node = nodes2.iter().find(|n| n["id"] == "B").unwrap();
        assert_eq!(b_node["link"], "note-uuid-123");

        // 3번 검증: class tones (briseAccent -> flag: true, briseWarn -> state: 0, briseDone -> state: 1, briseMuted -> state: 2)
        let (k3, b3): (String, String) = conn
            .query_row("SELECT kind, body_md FROM sections WHERE id=?1", [&sec3.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(k3, "diagram");
        let v3: Value = serde_json::from_str(&b3).expect("must parse as json");
        let nodes3 = v3["nodes"].as_array().unwrap();
        let node_a = nodes3.iter().find(|n| n["id"] == "A").unwrap();
        assert_eq!(node_a["flag"], true);
        let node_b = nodes3.iter().find(|n| n["id"] == "B").unwrap();
        assert_eq!(node_b["state"], 0);
        let node_c = nodes3.iter().find(|n| n["id"] == "C").unwrap();
        assert_eq!(node_c["state"], 1);
        let node_d = nodes3.iter().find(|n| n["id"] == "D").unwrap();
        assert_eq!(node_d["state"], 2);

        // 4번 검증: sequenceDiagram -> kind='text', ```mermaid\n...\n```로 감싸짐, 데이터 유실 없음
        let (k4, b4): (String, String) = conn
            .query_row("SELECT kind, body_md FROM sections WHERE id=?1", [&sec4.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(k4, "text");
        assert_eq!(b4, format!("```mermaid\n{sec4_body}\n```"));
        assert!(b4.contains(sec4_body));
    }

    /// V70 (GRILL-2026-09-07 D2): note_dates 테이블이 두 경로 모두에서 안전한지 — (a) 기존 DB에
    /// 업그레이드로 얹혔을 때, (b) 신규 DB가 V1..V70을 한 번에 적용했을 때.
    #[test]
    fn note_dates_table_created_by_v70_on_both_upgrade_and_fresh_install() {
        // (a) 기존 DB: V69까지 적용 후 V70만 별도로.
        let mut existing = Connection::open_in_memory().unwrap();
        let through_69: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 69).collect();
        apply(&mut existing, &through_69).unwrap();
        seed(&mut existing).unwrap();
        apply(&mut existing, &[(70, V70_SQL)]).unwrap();

        let folder_id: String = existing
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        existing
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES ('n1', ?1, 't', 1000, ?2, ?2)",
                params![folder_id, now],
            )
            .unwrap();
        existing
            .execute(
                "INSERT INTO note_dates(id, note_id, date, label, created_at) VALUES ('d1','n1','2026-11-05','발표일',?1)",
                params![now],
            )
            .unwrap();
        let (date, label): (String, Option<String>) = existing
            .query_row("SELECT date, label FROM note_dates WHERE id='d1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(date, "2026-11-05");
        assert_eq!(label.as_deref(), Some("발표일"));
        // FK CASCADE: 노트를 지우면 딸린 note_dates 행도 사라진다(note_regions와 동일 규율).
        existing.execute("DELETE FROM notes WHERE id='n1'", []).unwrap();
        let remaining: i64 = existing
            .query_row("SELECT COUNT(*) FROM note_dates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "ON DELETE CASCADE must remove note_dates rows with their note");

        // (b) 신규 DB: run()이 처음부터 V70까지 몰아서 적용해도 테이블이 존재한다.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        let table_exists: bool = fresh
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_dates'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(table_exists);
    }

    /// V71 (2026-09-07 알림 미처리 통일): pin_anchor_sort_key 는 anchor_date 규칙(시각 있으면
    /// 시작일, 종일이면 종료일 — 없으면 시작일)을 end_sort_key(V44)와 같은 채움 규칙(월/일 없으면
    /// 1)으로 SQL에 반영한 것. 새 부분 인덱스가 기존 DB(V70까지)와 신규 DB 양쪽에 생기고, 옛
    /// idx_notes_remind_end 는 지우지 않는다(계속 존재).
    #[test]
    fn test_v71_pin_anchor_sort_key_and_index() {
        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_70: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 70).collect();
        apply(&mut conn, &through_70).unwrap();
        seed(&mut conn).unwrap();
        assert!(!has_index(&conn, "idx_notes_remind_anchor"), "V71 이전에는 없다");

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        #[allow(clippy::too_many_arguments)]
        let mk = |id: &str,
                  year: i64,
                  month: Option<i64>,
                  day: Option<i64>,
                  start_time: Option<&str>,
                  end: (Option<i64>, Option<i64>, Option<i64>)| {
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, month, day, start_time,
                                   end_year, end_month, end_day, created_at, updated_at)
                 VALUES (?1, ?2, 't', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![id, folder_id, year, month, day, start_time, end.0, end.1, end.2, now],
            )
            .unwrap();
        };
        // 시각 있음 — 종료일이 있어도 앵커는 시작일.
        mk("n-timed", 2050, Some(3), Some(4), Some("09:00"), (Some(2050), Some(3), Some(20)));
        // 종일 + 종료일 있음 — 앵커는 종료일(기존 규칙 유지).
        mk("n-allday-end", 2050, Some(1), Some(1), None, (Some(2050), Some(6), Some(15)));
        // 종일 + 종료일 없음 — 앵커는 시작일(이번 수정의 핵심).
        mk("n-allday-no-end", 2050, Some(2), Some(10), None, (None, None, None));

        apply(&mut conn, &[(71, V71_SQL)]).unwrap();
        assert!(has_index(&conn, "idx_notes_remind_anchor"));
        assert!(has_index(&conn, "idx_notes_remind_end"), "옛 인덱스는 그대로 남는다");

        let key = |c: &Connection, id: &str| -> Option<i64> {
            c.query_row("SELECT pin_anchor_sort_key FROM notes WHERE id=?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(
            key(&conn, "n-timed"),
            Some(2050 * 10000 + 300 + 4),
            "시각 있으면 종료일이 있어도 시작일이 앵커"
        );
        assert_eq!(
            key(&conn, "n-allday-end"),
            Some(2050 * 10000 + 600 + 15),
            "종일 + 종료일 있음 — 앵커는 종료일"
        );
        assert_eq!(
            key(&conn, "n-allday-no-end"),
            Some(2050 * 10000 + 200 + 10),
            "종일 + 종료일 없음 — 앵커는 시작일(이번 수정의 핵심)"
        );

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 71);
        assert!(has_index(&fresh, "idx_notes_remind_anchor"));
    }

    /// V72 (GRILL-2026-09-07 D3 철회/D10): note_dates.remind — 기존 DB에 얹혔을 때 기본값 0, CHECK
    /// 로 0/1 만 허용, 신규 DB(V1..최신 몰아치기)에서도 컬럼이 존재.
    #[test]
    fn test_v72_note_dates_remind_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_71: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 71).collect();
        apply(&mut conn, &through_71).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_dates(id, note_id, date, created_at) VALUES ('d1', 'n1', '2026-09-01', ?1)",
            params![now],
        )
        .unwrap();

        apply(&mut conn, &[(72, V72_SQL)]).unwrap();

        let remind: i64 = conn
            .query_row("SELECT remind FROM note_dates WHERE id='d1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remind, 0, "기존 행은 얹힌 컬럼의 기본값 0을 받는다");

        // CHECK 은 0/1 만 허용.
        let err = conn.execute("UPDATE note_dates SET remind=2 WHERE id='d1'", []);
        assert!(err.is_err(), "CHECK(remind IN (0,1)) 이 그 밖의 값을 막아야 한다");

        conn.execute("UPDATE note_dates SET remind=1 WHERE id='d1'", []).unwrap();
        let remind: i64 = conn
            .query_row("SELECT remind FROM note_dates WHERE id='d1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remind, 1);

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 72);
        seed(&mut fresh).unwrap();
        let fresh_folder: String = fresh
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        fresh
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES ('n2', ?1, 't', 2026, ?2, ?2)",
                params![fresh_folder, now],
            )
            .unwrap();
        // PLAN-2026-09-08-dates-rebuild.md W1: run() 은 V76 까지 몰아치므로 `fresh` 의 note_dates
        // 는 이미 새 스키마(year/month/day 트리플 + position)다 — 옛 date 컬럼은 없다.
        fresh
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, month, day, created_at) VALUES ('d2', 'n2', 1, 2026, 9, 2, ?1)",
                params![now],
            )
            .unwrap();
        let remind_default: i64 = fresh
            .query_row("SELECT remind FROM note_dates WHERE id='d2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remind_default, 0, "신규 DB에서도 기본값 0");
    }

    /// V74 (2026-09-07 오너 결정, notes.yaml::note_date_add): note_dates.label 드롭 —
    /// V29/V68(DROP COLUMN)과 같은 패턴.
    #[test]
    fn v74_drops_note_dates_label() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_73: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 73).collect();
        apply(&mut conn, &through_73).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        // Before v74, note_dates has a label column.
        conn.execute(
            "INSERT INTO note_dates(id, note_id, date, label, created_at) VALUES ('d1', 'n1', '2026-09-01', '옛 라벨', ?1)",
            params![now],
        )
        .unwrap();

        apply(&mut conn, &[(74, V74_SQL)]).unwrap();

        // After v74, the label column is gone and querying it is an error.
        let res = conn.query_row("SELECT label FROM note_dates WHERE id='d1'", [], |r| {
            r.get::<_, Option<String>>(0)
        });
        assert!(res.is_err());
        // The row itself (and its other columns) survive the drop.
        let date: String = conn
            .query_row("SELECT date FROM note_dates WHERE id='d1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(date, "2026-09-01");

        // 옛 "fresh install(run() 몰아치기)도 label 컬럼이 없다" 단언은 V85(아래
        // v85_revives_note_dates_label)가 label을 되살리며 더는 사실이 아니게 됐다 — 이 테스트는
        // V74 시점(그 위 through_73+apply(74,..))의 역사적 사실만 고정한다. 현재 스키마의
        // fresh-install 동작(label이 다시 쓰기 가능함)은 v85 테스트가 커버한다.
    }

    /// V86: 전역에 저장된 노트북 키 값은 **모든 기존 노트북**으로 옮겨지고 전역 행은 사라진다 —
    /// 업그레이드 직후 어느 노트북의 모양도 바뀌지 않아야 한다. 전역 키(close_to_tray)는 그대로.
    #[test]
    fn v86_moves_stored_notebook_keys_into_every_notebook() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_85: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 85).collect();
        apply(&mut conn, &through_85).unwrap();
        seed(&mut conn).unwrap();
        let now = now_iso();
        conn.execute("INSERT INTO workspaces(id, name, created_at) VALUES ('w2', 'B', ?1)", [&now])
            .unwrap();
        conn.execute_batch(
            r#"INSERT OR REPLACE INTO settings(key, value) VALUES ('theme', '"dark"');
               INSERT OR REPLACE INTO settings(key, value) VALUES ('ui_lang', '"fr"');
               INSERT OR REPLACE INTO settings(key, value) VALUES ('close_to_tray', 'false');"#,
        )
        .unwrap();
        let ws_count: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0)).unwrap();
        let pre: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='slide_preview'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pre, 0, "precondition: slide_preview was never stored");

        apply(&mut conn, &[(86, V86_SQL)]).unwrap();

        for key in ["theme", "ui_lang"] {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM workspace_settings WHERE key=?1", [key], |r| r.get(0))
                .unwrap();
            assert_eq!(n, ws_count, "{key} must be copied into every notebook");
            let global: i64 = conn
                .query_row("SELECT COUNT(*) FROM settings WHERE key=?1", [key], |r| r.get(0))
                .unwrap();
            assert_eq!(global, 0, "{key} global row must be gone");
        }
        let v: String = conn
            .query_row(
                "SELECT value FROM workspace_settings WHERE workspace_id='w2' AND key='theme'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, r#""dark""#);
        let tray: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key='close_to_tray'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tray, 1, "global keys stay global");
        // 저장된 적 없는 키는 옮길 것이 없다 — 기본값으로 남는다(시드가 쓰지 않는 키로 확인).
        let unset: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_settings WHERE key='slide_preview'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unset, 0);
    }

    /// V86 의 동결 키 목록은 적용 시점의 NOTEBOOK_KEYS 와 같았다. 이 테스트는 원래 **같음**을 단언하는
    /// 인계철선이었다 — NOTEBOOK_KEYS 에 키를 더하면 깨지고, 그때 "그 키의 기존 전역 값을 옮길 새
    /// 마이그레이션이 필요한가"를 판단한 뒤 단언을 "V86 ⊆ NOTEBOOK_KEYS" 로 바꾸라는 지시였다.
    ///
    /// **2026-09-20 판단(에디터 설정 6키)**: date_nudge_enabled · region_nudge_enabled ·
    /// paste_link_nudge · paste_path_inline_code · paste_table_sheet_suggest · editor_md_autoformat 은
    /// 이번에 **처음 생긴** 키다 — 어느 설치본의 전역 `settings` 에도 값이 없으므로 옮길 것이 없고,
    /// 마이그레이션은 필요 없다(없는 값은 default_settings 의 true 로 읽힌다). 그래서 지시대로 부분집합
    /// 단언으로 바꾼다.
    ///
    /// **2026-09-20 판단(같은 날 후속 웨이브, 실험적 4키)**: link_open_on_click · editor_word_count ·
    /// editor_width · new_note_date_precision · new_note_section_name 도 **처음 생긴** 키다(오너:
    /// "4~7번도 넣어봐, 보고 이상하면 지울게" — 위 6키와 달리 "오늘까지의 동작을 지키는 킬스위치"가
    /// 아니라 새 동작/값이지만, 마이그레이션 필요 여부를 가르는 기준은 똑같이 "이전에 전역으로
    /// 저장된 적이 있었는가"이고 다섯 다 없다). 옮길 전역 값이 없으므로 마이그레이션 불필요 —
    /// 부분집합 단언에 그대로 추가한다.
    ///
    /// **다음에 키를 더하는 사람에게**: 인계철선은 그대로 살아 있다 — 아래 목록에 없는 키가
    /// NOTEBOOK_KEYS 에 나타나면 두 번째 단언이 깨져 같은 질문을 다시 강제한다. 더하는 키가 **이미
    /// 전역으로 저장돼 온 키를 노트북별로 승격**하는 것이라면(새 키가 아니라면) V86 처럼 기존 값을
    /// workspace_settings 로 옮기는 마이그레이션이 필요하다. KEYS_ADDED_AFTER_V86 에 적을 때 그 판단도
    /// 같이 적어라.
    #[test]
    fn v86_key_list_is_a_subset_of_notebook_keys_and_every_later_key_is_accounted_for() {
        // V86 이후 NOTEBOOK_KEYS 에 더해진 키 — 전부 "새로 생긴 키라 옮길 전역 값이 없다"(위 주석).
        const KEYS_ADDED_AFTER_V86: &[&str] = &[
            "date_nudge_enabled",
            "region_nudge_enabled",
            "paste_link_nudge",
            "paste_path_inline_code",
            "paste_table_sheet_suggest",
            "editor_md_autoformat",
            // 2026-09-20 후속 웨이브 — 실험적 4종(오너가 보고 뺄 수 있다는 전제로 넣은 키들).
            "link_open_on_click",
            "editor_word_count",
            "editor_width",
            "new_note_date_precision",
            "new_note_section_name",
            // 2026-09-27 PLAN-askai-result-journey §7-4 — 어시스트 "바로 실행" 토글. 새 키라 옮길 전역 값이 없다.
            "assist_preset_autorun",
        ];
        let frozen: Vec<&str> = V86_KEYS.split(',').map(|k| k.trim_matches('\'')).collect();
        let now: Vec<&str> = crate::repo::settings_schema::NOTEBOOK_KEYS.to_vec();
        for k in &frozen {
            assert!(
                now.contains(k),
                "V86 이 옮긴 키 {k} 가 NOTEBOOK_KEYS 에서 빠졌다 — 그 값은 workspace_settings 에 고아로 남는다"
            );
        }
        let mut unaccounted: Vec<&str> = now
            .iter()
            .copied()
            .filter(|k| !frozen.contains(k) && !KEYS_ADDED_AFTER_V86.contains(k))
            .collect();
        unaccounted.sort();
        assert!(
            unaccounted.is_empty(),
            "NOTEBOOK_KEYS 에 새 키 {unaccounted:?} — 기존 전역 값을 옮길 마이그레이션이 필요한지 판단한 뒤 KEYS_ADDED_AFTER_V86 에 적어라"
        );
    }

    /// V85 (PLAN-2026-09-18-nl-dates.md D1): note_dates.label 부활 — V84까지(V76이 이미 note_dates
    /// 를 position/year/month/day 사다리로 재편한 뒤, label 없이) 온 상태에 V85 를 얹으면 다시
    /// 쓰기 가능해지는지, 그리고 신규 설치(run() 몰아치기)에도 label 컬럼이 있는지 왕복으로
    /// 확인한다. v74_drops_note_dates_label 이 남긴 "V74 직후엔 없었다"는 역사적 사실과 대조되는
    /// 현재 사실(V85 이후엔 있다)을 고정하는 짝 테스트.
    #[test]
    fn v85_revives_note_dates_label() {
        let mut conn = Connection::open_in_memory().unwrap();
        // through_84: V76(주석 참조)이 이미 note_dates 를 position/year/month/day 사다리로 재편한
        // 뒤의 모양 — V74가 드롭한 label 은 아직 돌아오지 않았다(V85 이전).
        let through_84: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 84).collect();
        apply(&mut conn, &through_84).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_dates(id, note_id, position, year, created_at) VALUES ('d1', 'n1', 1, 2026, ?1)",
            params![now],
        )
        .unwrap();

        // Before v85 (through v84), the label column does not exist.
        let res = conn.query_row("SELECT label FROM note_dates WHERE id='d1'", [], |r| {
            r.get::<_, Option<String>>(0)
        });
        assert!(res.is_err(), "V74~V84 사이에는 label 컬럼이 없어야 한다");

        apply(&mut conn, &[(85, V85_SQL)]).unwrap();

        // After v85, the column exists, defaults to NULL for the pre-existing row, and is writable.
        let existing_label: Option<String> = conn
            .query_row("SELECT label FROM note_dates WHERE id='d1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(existing_label, None, "기존 행은 라벨 없이 NULL로 시작한다");
        conn.execute("UPDATE note_dates SET label='체크인' WHERE id='d1'", [])
            .unwrap();
        let updated_label: Option<String> = conn
            .query_row("SELECT label FROM note_dates WHERE id='d1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(updated_label.as_deref(), Some("체크인"));

        // Fresh install (run() 몰아치기) also has a writable label column.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 85);
        seed(&mut fresh).unwrap();
        let fresh_folder: String = fresh
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        fresh
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES ('n2', ?1, 't', 2026, ?2, ?2)",
                params![fresh_folder, now],
            )
            .unwrap();
        fresh
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, label, created_at) VALUES ('d2', 'n2', 1, 2026, '체크아웃', ?1)",
                params![now],
            )
            .unwrap();
        let fresh_label: String = fresh
            .query_row("SELECT label FROM note_dates WHERE id='d2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fresh_label, "체크아웃", "신규 설치에도 label 컬럼이 쓰기 가능해야 한다");
    }

    /// V75 (PLAN-2026-09-07-reminder-2tier.md §3): note_dates 에 start_time/remind_offset_min 추가.
    /// 업그레이드(기존 행은 NULL) + 신규설치 양쪽, 그리고 CHECK 관문(V42_SQL 의 notes 컬럼과 같은
    /// 자세 — 형식/자릿수 모양만 SQL 이 거르고 범위는 Rust 가 본다)을 고정한다.
    #[test]
    fn v75_adds_start_time_and_remind_offset_min_to_note_dates() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_74: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 74).collect();
        apply(&mut conn, &through_74).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 2026, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        // Before v75, note_dates has no start_time/remind_offset_min columns.
        conn.execute(
            "INSERT INTO note_dates(id, note_id, date, created_at) VALUES ('d1', 'n1', '2026-09-01', ?1)",
            params![now],
        )
        .unwrap();

        apply(&mut conn, &[(75, V75_SQL)]).unwrap();

        // Existing row backfills to NULL (untouched — 기존 관련 날짜는 계속 종일로 발화한다).
        let (start_time, offset): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT start_time, remind_offset_min FROM note_dates WHERE id='d1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(start_time, None);
        assert_eq!(offset, None);

        // 값 왕복.
        conn.execute(
            "UPDATE note_dates SET start_time='09:00', remind_offset_min=15 WHERE id='d1'",
            [],
        )
        .unwrap();
        let (start_time, offset): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT start_time, remind_offset_min FROM note_dates WHERE id='d1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(start_time.as_deref(), Some("09:00"));
        assert_eq!(offset, Some(15));

        // CHECK: 자릿수 모양이 깨지면 거부(V42_SQL 과 동일 관문).
        assert!(conn
            .execute("UPDATE note_dates SET start_time='7:00' WHERE id='d1'", [])
            .is_err());
        assert!(conn
            .execute("UPDATE note_dates SET remind_offset_min=-1 WHERE id='d1'", [])
            .is_err());
        assert!(conn
            .execute("UPDATE note_dates SET remind_offset_min=40321 WHERE id='d1'", [])
            .is_err());

        // Fresh install (run() 몰아치기) also has both columns.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 75);
        seed(&mut fresh).unwrap();
        let fresh_folder: String = fresh
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        fresh
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES ('n2', ?1, 't', 2026, ?2, ?2)",
                params![fresh_folder, now],
            )
            .unwrap();
        // PLAN-2026-09-08-dates-rebuild.md W1: run() 은 V76 까지 몰아치므로 `fresh` 의 note_dates
        // 는 이미 새 스키마다 — 옛 date 컬럼은 없다.
        fresh
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, month, day, start_time, remind_offset_min, created_at)
                 VALUES ('d2', 'n2', 1, 2026, 9, 2, '10:30', 5, ?1)",
                params![now],
            )
            .unwrap();
        let (start_time, offset): (Option<String>, Option<i64>) = fresh
            .query_row(
                "SELECT start_time, remind_offset_min FROM note_dates WHERE id='d2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(start_time.as_deref(), Some("10:30"));
        assert_eq!(offset, Some(5));
    }

    /// V76 (PLAN-2026-09-08-dates-rebuild.md W1) — 업그레이드 경로: 기존 노트(다양한 정밀도) +
    /// 기존 note_dates 행("YYYY-MM-DD" 문자열, 순서 뒤섞여 삽입)이 있는 DB 에 V76 을 얹었을 때
    /// (a) COUNT(notes) == COUNT(note_dates WHERE position=0)(§7-2 핵심 불변식),
    /// (b) position=0 행이 notes.* 를 그대로 미러링(정밀도 낮은 노트 포함),
    /// (c) 옛 note_dates 행이 트리플로 정확히 풀리고 note_id 별 date ASC 순으로 position 1..
    ///     을 받는지(삽입 순서와 무관하게) 를 고정한다.
    #[test]
    fn v76_backfills_position_zero_mirrors_and_unpacks_legacy_note_dates_rows_in_date_order() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_75: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 75).collect();
        apply(&mut conn, &through_75).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();

        // n1: 풀 정밀도 + 기간 + 시각 + 알림 + 오프셋.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, month, day, end_year, end_month, end_day, remind, start_time, remind_offset_min, created_at, updated_at)
             VALUES ('n1', ?1, 'Event', 2026, 3, 10, 2026, 3, 12, 1, '09:00', 15, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        // n2: 연도만(정밀도 낮음) — position=0 이 month/day NULL 인 채로도 미러링돼야 한다.
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n2', ?1, 'YearOnly', 2020, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();

        // n1 의 옛 note_dates 행 2개 — 삽입 순서를 날짜 역순으로 뒤섞는다(백필이 "삽입 순서"가
        // 아니라 "date ASC" 로 position 을 매기는지 확인하기 위해).
        conn.execute(
            "INSERT INTO note_dates(id, note_id, date, end_date, remind, created_at) VALUES ('d-late', 'n1', '2026-06-15', NULL, 1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_dates(id, note_id, date, end_date, remind, created_at) VALUES ('d-early', 'n1', '2026-01-01', '2026-01-03', 0, ?1)",
            params![now],
        )
        .unwrap();

        apply(&mut conn, &[(76, V76_SQL)]).unwrap();

        // (a) 핵심 불변식.
        let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        let primary_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_dates WHERE position=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note_count, primary_count, "노트 수 == position=0 행 수");
        assert!(note_count >= 2);

        // (b) position=0 이 notes.* 를 그대로 미러링.
        let (y, m, d, ey, em, ed, remind, start_time, offset): (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, i64, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT year, month, day, end_year, end_month, end_day, remind, start_time, remind_offset_min FROM note_dates WHERE note_id='n1' AND position=0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .unwrap();
        assert_eq!((y, m, d), (2026, Some(3), Some(10)));
        assert_eq!((ey, em, ed), (Some(2026), Some(3), Some(12)));
        assert_eq!(remind, 1);
        assert_eq!(start_time.as_deref(), Some("09:00"));
        assert_eq!(offset, Some(15));

        let (y2, m2, d2): (i64, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT year, month, day FROM note_dates WHERE note_id='n2' AND position=0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((y2, m2, d2), (2020, None, None), "정밀도 낮은 노트도 그대로 미러링된다");

        // (c) 옛 note_dates 행이 date ASC 순으로 position 1.. 을 받는다(삽입 순서는 역순이었다).
        let mut stmt = conn
            .prepare("SELECT id, position, year, month, day, end_year, end_month, end_day, remind FROM note_dates WHERE note_id='n1' AND position != 0 ORDER BY position ASC")
            .unwrap();
        let rows: Vec<(String, i64, i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, i64)> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "d-early", "date ASC 이므로 1/1 이 먼저 — 삽입 순서(d-late 먼저)와 무관");
        assert_eq!(rows[0].1, 1);
        assert_eq!((rows[0].2, rows[0].3, rows[0].4), (2026, Some(1), Some(1)));
        assert_eq!((rows[0].5, rows[0].6, rows[0].7), (Some(2026), Some(1), Some(3)));
        assert_eq!(rows[0].8, 0);
        assert_eq!(rows[1].0, "d-late");
        assert_eq!(rows[1].1, 2);
        assert_eq!((rows[1].2, rows[1].3, rows[1].4), (2026, Some(6), Some(15)));
        assert_eq!((rows[1].5, rows[1].6, rows[1].7), (None, None, None));
        assert_eq!(rows[1].8, 1);

        // 신규 설치: run() 이 처음부터 V76까지 몰아 적용해도 같은 불변식이 성립한다(빈 DB 라
        // 양쪽 다 0으로 자명하게 같지만, 실제 노트를 하나 만들어 실질적으로 확인한다).
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 76);
        seed(&mut fresh).unwrap();
        let fresh_folder: String = fresh
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        crate::repo::notes::create(&mut fresh, &fresh_folder, Some("Fresh".into()), Some(2026)).unwrap();
        let fresh_notes: i64 = fresh.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        let fresh_primaries: i64 = fresh
            .query_row("SELECT COUNT(*) FROM note_dates WHERE position=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fresh_notes, fresh_primaries);
    }

    /// V77 (PLAN-2026-09-08-dates-rebuild.md W2§2): `pin_anchor_sort_key` 생성식이 옛
    /// `schedule::anchor_date`(시각 있으면 시작일) 규칙에서 새 규칙(종료일, 없으면 시작일 —
    /// 시각 무관)으로 바뀐다. V71 테스트의 "n-timed" 케이스는 이 마이그레이션으로 값이 달라지는
    /// 것이 핵심 — 시각이 있어도 이제 종료일이 앵커다.
    #[test]
    fn test_v77_pin_anchor_sort_key_drops_the_start_time_branch() {
        let has_index = |c: &Connection, name: &str| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_76: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 76).collect();
        apply(&mut conn, &through_76).unwrap();
        seed(&mut conn).unwrap();

        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        #[allow(clippy::too_many_arguments)]
        let mk = |id: &str,
                  year: i64,
                  month: Option<i64>,
                  day: Option<i64>,
                  start_time: Option<&str>,
                  end: (Option<i64>, Option<i64>, Option<i64>)| {
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, month, day, start_time,
                                   end_year, end_month, end_day, created_at, updated_at)
                 VALUES (?1, ?2, 't', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![id, folder_id, year, month, day, start_time, end.0, end.1, end.2, now],
            )
            .unwrap();
        };
        // 시각 있음 + 종료일 있음 — V71 규칙이었다면 앵커는 시작일이지만, 새 규칙은 종료일.
        mk("n-timed", 2050, Some(3), Some(4), Some("09:00"), (Some(2050), Some(3), Some(20)));
        // 종일 + 종료일 있음 — 규칙 변경과 무관하게 그대로 종료일.
        mk("n-allday-end", 2050, Some(1), Some(1), None, (Some(2050), Some(6), Some(15)));
        // 종일 + 종료일 없음 — 그대로 시작일.
        mk("n-allday-no-end", 2050, Some(2), Some(10), None, (None, None, None));

        apply(&mut conn, &[(77, V77_SQL)]).unwrap();
        assert!(has_index(&conn, "idx_notes_remind_anchor"), "인덱스가 재생성된다");

        let key = |c: &Connection, id: &str| -> Option<i64> {
            c.query_row("SELECT pin_anchor_sort_key FROM notes WHERE id=?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(
            key(&conn, "n-timed"),
            Some(2050 * 10000 + 300 + 20),
            "시각이 있어도 이제 종료일이 앵커(옛 V71 규칙이었다면 300+4)"
        );
        assert_eq!(key(&conn, "n-allday-end"), Some(2050 * 10000 + 600 + 15));
        assert_eq!(key(&conn, "n-allday-no-end"), Some(2050 * 10000 + 200 + 10));

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 77);
        assert!(has_index(&fresh, "idx_notes_remind_anchor"));
    }

    /// V78: 기본 글꼴 이관. 시드는 키가 없을 때만 도는 탓에 기본값 변경만으로는 기존 설치가
    /// 따라오지 않는다 — 그래서 값 이관이 있고, **직접 고른 글꼴은 건드리지 않는다**는 것이
    /// 이 마이그레이션의 전부다.
    #[test]
    fn test_v78_moves_only_the_untouched_serif_default_to_pretendard() {
        let font = |c: &Connection| -> String {
            c.query_row("SELECT value FROM settings WHERE key='font_family'", [], |r| r.get(0))
                .unwrap()
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_77: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 77).collect();
        apply(&mut conn, &through_77).unwrap();
        seed(&mut conn).unwrap();

        // 기존 설치의 모습: 시드가 써 둔 serif. (V86 이후 시드는 노트북 키를 전역에 심지 않으므로
        // 옛 시드가 남긴 행을 직접 만든다.)
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('font_family', '\"serif\"')",
            [],
        )
        .unwrap();
        apply(&mut conn, &[(78, V78_SQL)]).unwrap();
        assert_eq!(font(&conn), "\"pretendard\"");

        // 직접 고른 값은 그대로 — 두 번째 실행에도 덮이지 않는다.
        let mut chosen = Connection::open_in_memory().unwrap();
        apply(&mut chosen, &through_77).unwrap();
        seed(&mut chosen).unwrap();
        chosen
            .execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES ('font_family', '\"Malgun Gothic\"')",
                [],
            )
            .unwrap();
        apply(&mut chosen, &[(78, V78_SQL)]).unwrap();
        assert_eq!(font(&chosen), "\"Malgun Gothic\"");

        // 신규 설치는 시드 자체가 pretendard.
        // (V86 이후엔 노트북 키라 전역 행이 아니라 읽기 관문의 기본값으로 확인한다.)
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        seed(&mut fresh).unwrap();
        let s = crate::repo::settings::get_all(&fresh).unwrap();
        assert_eq!(s["font_family"], serde_json::json!("pretendard"));
    }

    /// V79: 섹션 휴지통 테이블. 기존 설치(78까지)에 적용되고, 신규 설치도 같은 모양을 갖는다 —
    /// content.sql 은 V1_SQL 로 include_str! 되므로 이 CREATE 는 **마이그레이션에만** 있다
    /// (스펙 파일에는 주석 사본). 그 규칙을 어기면 신규 설치에서 "already exists" 로 터진다.
    #[test]
    fn test_v79_creates_the_section_trash_table_on_old_and_new_installs() {
        let has_table = |c: &Connection| -> bool {
            c.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='section_trash'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false)
        };

        let mut conn = Connection::open_in_memory().unwrap();
        let through_78: Vec<(i64, &str)> = migrations().into_iter().filter(|(v, _)| *v <= 78).collect();
        apply(&mut conn, &through_78).unwrap();
        assert!(!has_table(&conn));

        apply(&mut conn, &[(79, V79_SQL)]).unwrap();
        assert!(has_table(&conn));
        assert!(conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_section_trash_deleted'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false));

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 79);
        assert!(has_table(&fresh));
    }

    /// V80(참조 첨부): 테이블 재작성이 **기존 행의 모든 컬럼을 보존**해야 하고, 새 CHECK 가
    /// "파일 kind 는 rel_path/ext_path 중 정확히 하나"를 강제해야 한다. 재작성은 되돌릴 수
    /// 없으므로 왕복을 여기서 못박는다(V64 가 만든 internal 부분 인덱스 재생성 포함 — DROP TABLE
    /// 은 인덱스도 같이 날린다).
    #[test]
    fn test_v80_rebuild_preserves_every_column_and_enforces_exactly_one_path() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_79: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 79).collect();
        apply(&mut conn, &through_79).unwrap();
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)
               VALUES ('a-file','n1','p.png','image','n1/p.png',NULL,7,0,'2026-09-10T00:00:00Z','deadbeef');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-link','n1','ref','link',NULL,'https://example.com',NULL,1,'2026-09-10T00:00:01Z');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-int','n1','goto','internal',NULL,'n1',NULL,2,'2026-09-10T00:00:02Z');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-fn','n1','anchor','footnote','n1/f.md','anchor',3,3,'2026-09-10T00:00:03Z');",
        )
        .unwrap();

        apply(&mut conn, &[(80, V80_SQL)]).unwrap();

        // 모든 행·모든 컬럼이 그대로다.
        let file_row: (String, String, String, Option<String>, Option<String>, Option<i64>, i64, String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash, ext_path
                 FROM attachments WHERE id='a-file'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
            )
            .unwrap();
        assert_eq!(
            file_row,
            (
                "n1".into(),
                "p.png".into(),
                "image".into(),
                Some("n1/p.png".into()),
                None,
                Some(7),
                0,
                "2026-09-10T00:00:00Z".into(),
                Some("deadbeef".into()),
                None
            )
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 4, "네 행 전부 살아남아야 한다");
        let fn_url: Option<String> = conn
            .query_row("SELECT url FROM attachments WHERE id='a-fn'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fn_url.as_deref(), Some("anchor"), "각주 anchor_text 보존");

        // DROP TABLE 이 날린 인덱스 4종이 전부 재생성됐다(V64 의 internal 부분 인덱스 포함).
        for idx in [
            "idx_attachments_note",
            "idx_attachments_kind_created",
            "idx_attachments_created",
            "idx_attachments_internal_url",
        ] {
            let has: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |_| Ok(true),
                )
                .optional()
                .unwrap()
                .unwrap_or(false);
            assert!(has, "index missing after rebuild: {idx}");
        }

        // 참조 행은 들어가고, 둘 다 찬 행/둘 다 빈 행은 CHECK 가 막는다.
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, ext_path)
             VALUES ('a-ref','n1','big.pptx','doc',NULL,NULL,9999999999,4,'2026-09-10T00:00:04Z','C:/Users/me/big.pptx')",
            [],
        )
        .unwrap();
        for bad in [
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, ext_path)
             VALUES ('a-both','n1','x','doc','n1/x',NULL,1,5,'2026-09-10T00:00:05Z','C:/x')",
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, ext_path)
             VALUES ('a-none','n1','x','doc',NULL,NULL,1,6,'2026-09-10T00:00:06Z',NULL)",
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, ext_path)
             VALUES ('a-lnk','n1','x','link',NULL,'https://e.com',1,7,'2026-09-10T00:00:07Z','C:/x')",
        ] {
            assert!(conn.execute(bad, []).is_err(), "CHECK 가 막아야 한다: {bad}");
        }

        // 신규 설치도 같은 모양(ext_path 컬럼 존재).
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(fresh.prepare("SELECT ext_path FROM attachments").is_ok());
    }

    /// V81(사료 절단 플래그): 기존 행은 0 으로 살아남고, 신규 설치도 같은 컬럼을 갖는다.
    #[test]
    fn test_v81_adds_source_truncated_defaulting_to_false() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_80: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 80).collect();
        apply(&mut conn, &through_80).unwrap();
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources(id, note_id, name, ext, body, position, created_at)
             VALUES ('s1','n1','a.txt','TXT','hi',0,'2026-09-10T00:00:00Z')",
            [],
        )
        .unwrap();
        assert!(conn.prepare("SELECT truncated FROM sources").is_err());

        apply(&mut conn, &[(81, V81_SQL)]).unwrap();

        let (body, truncated): (String, bool) = conn
            .query_row("SELECT body, truncated FROM sources WHERE id='s1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(body, "hi", "기존 본문 보존");
        assert!(!truncated, "알 수 없는 과거 행은 잘리지 않은 것으로 둔다");

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(fresh.prepare("SELECT truncated FROM sources").is_ok());
    }

    /// V88(차트 참조 첨부): V80 과 같은 테이블 재생성이라 같은 왕복을 못박는다 — V87 DB 에 기존
    /// 7종 kind 를 한 행씩 심고 V88 을 얹으면 행·컬럼(ext_path 포함)·인덱스 4종이 전부 보존되고,
    /// `chart` 행은 url 전용 arm 으로 들어가며 rel_path/ext_path 가 차면 CHECK 가 막는다.
    #[test]
    fn test_v88_rebuild_keeps_seven_kinds_and_admits_chart_as_url_only() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_87: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 87).collect();
        apply(&mut conn, &through_87).unwrap();
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)
               VALUES ('a-image','n1','p.png','image','n1/p.png',NULL,7,0,'2026-09-20T00:00:00Z','deadbeef');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, ext_path)
               VALUES ('a-doc','n1','big.pptx','doc',NULL,NULL,9,1,'2026-09-20T00:00:01Z','C:/Users/me/big.pptx');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-link','n1','ref','link',NULL,'https://example.com',NULL,2,'2026-09-20T00:00:02Z');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-audio','n1','a.mp3','audio','n1/a.mp3',NULL,3,3,'2026-09-20T00:00:03Z');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-note','n1','memo','note','n1/memo.md',NULL,4,4,'2026-09-20T00:00:04Z');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-int','n1','goto','internal',NULL,'n1',NULL,5,'2026-09-20T00:00:05Z');
             INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
               VALUES ('a-fn','n1','anchor','footnote','n1/f.md','anchor',6,6,'2026-09-20T00:00:06Z');",
        )
        .unwrap();
        // V87 까지는 chart 가 CHECK 에 없다.
        assert!(conn
            .execute(
                "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, position, created_at)
                 VALUES ('a-pre','n1','c','chart',NULL,'s1#c1',7,'2026-09-20T00:00:07Z')",
                [],
            )
            .is_err());

        apply(&mut conn, &[(88, V88_SQL)]).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 7, "일곱 행 전부 살아남아야 한다");
        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM attachments ORDER BY position")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(kinds, ["image", "doc", "link", "audio", "note", "internal", "footnote"]);
        // 참조 첨부의 ext_path 와 파일 첨부의 content_hash 가 재생성을 넘어왔다(V80 은 ext_path 를
        // 새로 만들었지만 이번엔 기존 열이라 SELECT 에 들어 있어야 한다).
        let (ext_path, hash): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT (SELECT ext_path FROM attachments WHERE id='a-doc'),
                        (SELECT content_hash FROM attachments WHERE id='a-image')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ext_path.as_deref(), Some("C:/Users/me/big.pptx"));
        assert_eq!(hash.as_deref(), Some("deadbeef"));

        for idx in [
            "idx_attachments_note",
            "idx_attachments_kind_created",
            "idx_attachments_created",
            "idx_attachments_internal_url",
        ] {
            let has: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |_| Ok(true),
                )
                .optional()
                .unwrap()
                .unwrap_or(false);
            assert!(has, "index missing after rebuild: {idx}");
        }

        // chart 는 url 전용으로 들어간다.
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, position, created_at)
             VALUES ('a-chart','n1','매출','chart',NULL,'s1#c1',7,'2026-09-20T00:00:07Z')",
            [],
        )
        .unwrap();
        for bad in [
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, position, created_at)
             VALUES ('a-c-rel','n1','x','chart','n1/x',NULL,8,'2026-09-20T00:00:08Z')",
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, position, created_at, ext_path)
             VALUES ('a-c-ext','n1','x','chart',NULL,'s1#c1',9,'2026-09-20T00:00:09Z','C:/x')",
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, position, created_at)
             VALUES ('a-c-none','n1','x','chart',NULL,NULL,10,'2026-09-20T00:00:10Z')",
        ] {
            assert!(conn.execute(bad, []).is_err(), "CHECK 가 막아야 한다: {bad}");
        }

        // 신규 설치도 같은 모양.
        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(current_version(&fresh).unwrap() >= 88);
    }
    /// V93(오디오 전사): 기존 DB 에 컬럼 두 개를 얹어도 행·값이 보존되고, 과거 행은 transcript NULL ·
    /// inserted 0 으로 시작하며, 이후 저장한 전사 값이 읽힌다. 신규 설치도 같은 모양.
    #[test]
    fn test_v93_adds_transcript_columns_and_keeps_existing_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        let through_92: Vec<(i64, &str)> =
            migrations().into_iter().filter(|(v, _)| *v <= 92).collect();
        apply(&mut conn, &through_92).unwrap();
        seed(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('n1', ?1, 't', 1000, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z')",
            [&folder_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a1','n1','memo.m4a','audio','n1/memo.m4a',NULL,3,0,'2026-10-06T00:00:00Z')",
            [],
        )
        .unwrap();
        assert!(conn.prepare("SELECT transcript FROM attachments").is_err());

        apply(&mut conn, &[(93, V93_SQL)]).unwrap();

        let (name, tr, ins): (String, Option<String>, i64) = conn
            .query_row(
                "SELECT name, transcript, transcript_inserted FROM attachments WHERE id='a1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(name, "memo.m4a", "기존 행 보존");
        assert_eq!(tr, None);
        assert_eq!(ins, 0);

        conn.execute("UPDATE attachments SET transcript='안녕', transcript_inserted=1 WHERE id='a1'", [])
            .unwrap();
        let (tr, ins): (Option<String>, i64) = conn
            .query_row("SELECT transcript, transcript_inserted FROM attachments WHERE id='a1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(tr.as_deref(), Some("안녕"));
        assert_eq!(ins, 1);

        let mut fresh = Connection::open_in_memory().unwrap();
        run(&mut fresh).unwrap();
        assert!(fresh.prepare("SELECT transcript, transcript_inserted FROM attachments").is_ok());
    }
}
