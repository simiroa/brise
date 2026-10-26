-- Brise DDL: note_embeddings (Wave 3C 벡터/시맨틱 검색) — REMOVED as of V25 (migrations.rs).
-- Owner decision: 시맨틱/임베딩 검색 서브시스템 전체 제거. 이 파일은 V2_SQL 이
-- include_str! 로 그대로 참조하는 히스토리 마이그레이션 SQL이라 삭제할 수 없다(과거 DB가
-- V2에서 이 테이블을 만들었다는 사실 자체가 마이그레이션 히스토리) — additive 컨벤션,
-- migrations.rs 파일 서두 주석 참고. V25_SQL(DROP TABLE IF EXISTS note_embeddings)이 이
-- 테이블을 드롭한다. 이 아래 DDL은 죽은 코드가 아니라 "V2 시점에 실제로 실행됐던 SQL"의
-- 불변 기록이므로 건드리지 않는다.
-- 결정: service/vector-search.yaml 결정 1 — sqlite-vec 같은 네이티브 확장 없이 BLOB(f32 LE)로 저장,
-- Rust 측 코사인 브루트포스 스캔 (개인 노트 규모에서 충분히 빠름). vec0 가상 테이블은 향후 최적화로 유보.

CREATE TABLE note_embeddings (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content_hash TEXT NOT NULL,     -- sha256(prefix+chunk) — 동일 해시면 재임베딩 생략 (지연 증분 재색인)
  model        TEXT NOT NULL,     -- 임베딩 생성에 사용된 모델 (dims 일관성 검증용)
  dims         INTEGER NOT NULL,
  embedding    BLOB NOT NULL,     -- f32 LE 배열
  updated_at   TEXT NOT NULL,
  UNIQUE(note_id, chunk_index)
);
CREATE INDEX idx_note_embeddings_note ON note_embeddings(note_id);
