-- Brise DDL: 2글자 낱말 색인 (migrations.rs V94 = 이 파일 그대로, include_str!)
-- 왜: notes_fts 는 trigram 이라 3글자 미만을 원리상 못 찾는다. 채팅 질문 검색(repo/question_search.rs)의
-- 2글자 핵심어(커피·여행·부산·일정 — 한국어 명사 대부분)가 그동안 notes_fts 네 열 LIKE 전체 스캔이었고,
-- 노트 수 × 본문 길이에 비례해 느려졌다(docs/HANDOFF-2026-10-08-chat-search-perf.md Wave B).
--
-- 의미 = 길이 2 부분 문자열(LIKE '%ab%', ASCII 만 대소문자 무시)과 **정확히 같다**:
-- notes_fts 행의 title/body/source_body/tag_names 각각에서 글자·숫자(char::is_alphanumeric, 한글 포함)가
-- 이어진 구간마다 겹치는 2글자 창을 모두 넣는다(ASCII 만 소문자화). 예) "커피값만" → 커피 피값 값만,
-- "10km" → 10 0k km, "9월에" → 9월 월에. 열 경계·구분자를 넘는 창은 없다.
-- 질문 핵심어는 글자·숫자로만 이뤄지므로(question_terms), 핵심어가 창 목록에 있다 ⇔ LIKE 매치.
--
-- 갱신 책임: notes_fts 와 같다 — 트리거가 아니라 repo/fts.rs 가 notes_fts 를 쓰는 같은 트랜잭션에서
-- (clear_all · fts_upsert · fts_update_title · fts_delete). dev_seed 배치는 fts::bigram_index 로 직접.
-- 노트 → 색인 행 매핑은 명시적 INTEGER PRIMARY KEY(암묵 rowid 는 VACUUM 때 바뀔 수 있다).
-- V95 부터 id = 그 노트의 notes_fts rowid 이고, notes_fts 의 **모든** 행에 매핑 행이 있다(2글자 창이 없는 노트도).
-- 질문 검색 3자 이상 경로가 trigram MATCH 의 rowid → 이 표로 note_id 를 찾는다 — notes_fts.note_id 를 읽으면
-- FTS5 가 맞은 행마다 본문까지 가져온다(5000건 ~19ms, 이 표 경유 ~5ms). notes_fts rowid 는 내용 표의
-- INTEGER PRIMARY KEY 라 VACUUM 에도 유지된다. 이 파일은 V94 의 SQL 이다 — V95 는 스키마가 아니라 백필만 다시 돈다.
CREATE TABLE notes_bigram_map (
  id      INTEGER PRIMARY KEY,   -- = notes_bigram.rowid = notes_fts.rowid (V95)
  note_id TEXT NOT NULL UNIQUE   -- notes.id
);

-- 창 목록은 공백 구분 문자열 하나. 토크나이저 ascii = ASCII 영숫자 외 ASCII 문자는 구분자, 비ASCII 는
-- 전부 토큰 글자, ASCII 만 소문자화 — LIKE 의 대소문자 규칙과 같다(unicode61 은 비ASCII 도 접고
-- 발음기호를 지워 LIKE 와 어긋난다). 낱말 소속만 필요하므로 detail=none(위치 없음) · 내용 미저장 ·
-- contentless_delete=1(rowid 로 삭제). columnsize=0 은 bundled SQLite 3.53 이 contentless_delete 와 같이 못 쓴다
-- ("contentless_delete=1 is incompatible with columnsize=0") — 열 하나라 docsize 비용은 행당 몇 바이트.
CREATE VIRTUAL TABLE notes_bigram USING fts5(
  grams,
  content = '',
  contentless_delete = 1,
  detail = none,
  tokenize = 'ascii'
);
