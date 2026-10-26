-- Brise DDL: FTS5 검색 인덱스
-- 갱신 책임: DB 트리거가 아니라 Rust 저장소 계층이 노트 변경과 동일 트랜잭션에서 upsert
-- (sections/sources/tags를 노트 단위 1행으로 집계해야 하므로 트리거보다 계층 갱신이 단순·검증 용이)
-- 불변성: specs/tests/invariant-fts-sync.yaml
--
-- 토크나이저 = trigram (migrations.rs V10, P1 버그 수정). 이전 unicode61은 공백으로 구분된
-- CJK 어절을 통짜 토큰 하나로 취급해 어절 중간/끝 부분 문자열을 못 찾았다(예: 본문에 "세종대왕"
-- 이 있어도 "종대"로 검색하면 미매치 — R8 LIKE 폴백도 title/tag만 커버해 본문 매치를 놓쳤다).
-- trigram은 3글자(코드포인트) 시퀀스 단위로 인덱싱하므로 CJK/Latin 관계없이 어절 어디서든
-- 부분 문자열 매치가 된다. SQLite 3.34+ 요구 — bundled libsqlite3-sys(3.53.2)로 충족 확인.
-- case_sensitive 0 = 대소문자 무시(기존 Latin 키워드 검색 동작 보존). 3글자 미만 쿼리는 trigram
-- MATCH가 원리상 불가 — repo/search.rs::build_match_query + LIKE 폴백(R8) 참고.
CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED,   -- notes.id
  title,               -- notes.title
  body,                -- 모든 sections.body_md 연결 ('\n\n' 구분)
  source_body,         -- 모든 sources.body 연결
  tag_names,           -- 연결된 tags.name 공백 구분
  tokenize = 'trigram case_sensitive 0'
);

-- 벡터 인덱스는 Wave 1 범위 외 — 이후 웨이브에서 별도 DDL 파일로 추가 (이 파일 수정 금지)
