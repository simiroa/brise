# Search — 검색 스펙 (SSOT 확장)

> 이 문서는 `specs/features/search.yaml`(F-S01/F-S02/F-S03, 기계가 읽는 1차 소스)의
> 사람용 디테일 확장이다. `specs/commands/search.yaml`·`specs/service/search.yaml`·
> `specs/db/schemas/fts.sql`이 계약, `src-tauri/src/repo/search.rs`가 구현. 스펙과 코드가
> 갈리면 **코드의 현재 shipped 동작을 우선**한다 — 아래는 코드를 직접 읽어 확인한 사실만
> 적는다.

## 0. 정체성

- 검색 커맨드는 하나, `search_notes` — `query`(빈 문자열 허용) + `year_from`/`year_to`
  (inclusive) + `workspace_id`(생략 시 활성 노트북)를 받아 `NoteSummary[]` + `total`을
  돌려준다 (`specs/commands/search.yaml`).
- 의미(벡터) 검색은 `F-S03`으로 **removed** 상태다 — `note_embeddings` 테이블(V25 DROP),
  `vector.rs`, `vector_reindex`/`vector_status`/`note_find_similar` 커맨드가 전부
  삭제됐다(`specs/features/search.yaml` F-S03). 지금 검색은 키워드 FTS5 하나뿐이다.

## 1. 기능 개요

키보드 입력마다(200ms 디바운스, `src/stores/search.ts::scheduleSearch`) `search_notes`를
호출해 좌측 패널 트리/검색 결과를 갱신한다. 검색은 두 축의 교집합이다:

1. **키워드**(`query`) — FTS5 trigram MATCH, 실패/짧은 쿼리는 LIKE 폴백.
2. **연대**(`year_from`/`year_to`) — `notes.year` 범위. UI 기본 전체 스팬(900~1960)과 값이
   같으면 이 술어 자체를 생략한다(`FULL_SPAN_FROM`/`FULL_SPAN_TO`, `repo/search.rs:15-16`).
   생략되면 스팬 밖(BC 연도, 1960 이후) 노트도 텍스트 검색에는 걸린다.

연대 필터 UI는 `specs/features/search.yaml` F-S02가 "3모드"로 카탈로그화한다 — **스크러버 /
Range+왕조 / Decade** 세 가지 프론트 표현 모두 결국 `search_notes(year_from, year_to)`
하나로 수렴한다(백엔드는 모드를 모른다). 이와 별개로 `src/stores/search.ts`의
`DateRangeKey`(`"last7"|"last30"|"thisYear"`)는 **record 축**(`notes.updated_at` 기반 "최근
n일" 칩) 필터로, F-S02의 연대(event 축, `notes.year`) 3모드와는 다른 축이다 — 이 문서는
F-S01/F-S02가 다루는 `search_notes`의 연대 축만 서술한다.

빈 쿼리는 연대 필터만 적용한 노트 목록을 반환한다(`search()`의 `q.is_empty()` 분기,
`repo/search.rs:63-68`) — 정상 응답이며 에러가 아니다.

## 2. 동작 방식

`search()`(`src-tauri/src/repo/search.rs:35`)의 후보 수집 순서:

1. `year_from > year_to` → `AppError::Validation`.
2. `query`가 비면 `year_scoped_ids`(연대만으로 SELECT, `ORDER BY n.year, n.created_at`,
   `SEARCH_RESULT_CAP`으로 LIMIT)로 바로 반환.
3. `query`가 있으면:
   - `build_match_query(q)`로 FTS5 MATCH 쿼리를 조립할 수 있으면 `fts_ids`를 먼저 실행.
   - 쿼리 문자 수(코드포인트 기준) **2자 이하**이거나 FTS 매치가 0건이면 `like_ids`를
     UNION(dedupe 후 append, `repo/search.rs:79-83`).
4. 후보 id를 `SEARCH_RESULT_CAP`(500)으로 잘라 `notes::note_summaries_for_ids`로 요약
   조립, 쿼리가 있으면 `populate_snippets`로 스니펫을 채운다.

**정렬 기준이 경로마다 다르다** — `year_scoped_ids`/`like_ids`는 `ORDER BY n.year,
n.created_at`(연대순), `fts_ids`는 `ORDER BY bm25(...)`(관련도순). 코드 주석이 이 차이를
명시한다(`repo/search.rs:86-88`: "두 경로의 정렬 기준이 다르다").
2026-10-09(Wave D, 5ed051c7)부터 `fts_ids`·`like_ids` 모두 마지막에 **note id** 로 동점을 깬다 —
그 전엔 (점수, year, created_at) 완전 동점의 순서가 정해지지 않았다.

`search_notes` 는 전역 DB 잠금이 아니라 **읽기 연결**(`AppState::with_read`)에서 비동기 워커 스레드로 돈다(Wave D3 / CMD) —
검색 중에도 UI 스레드와 자동 저장이 기다리지 않는다.

### 스케일 상한 (Scale Phase 0/1, `repo/search.rs:18-27`)

| 상수 | 값 | 적용 대상 |
|---|---|---|
| `SEARCH_RESULT_CAP` | 500 | 요약 조립(모든 경로 공통) — `total`은 `ids.len()`(정확한 COUNT 재조회 없음) |
| `LIKE_SCAN_CAP` | 1000 | `like_ids`의 매치 id 셋 상한 — FTS 인덱스를 못 쓰는 풀스캔이므로 상한을 둠 |

`SEARCH_RESULT_CAP`보다 `LIKE_SCAN_CAP`이 커서 연대 정렬 후 상위 요약을 뽑을 여유를
남긴다. 두 상한 모두 실제 유닛 테스트(`cap_tests::keyword_search_caps_results_but_total_is_true_count`,
`like_ids_caps_match_set_at_like_scan_cap`)로 회귀 고정돼 있다.

## 3. 데이터 모델 (FTS5)

### 3.1 `notes_fts` 가상 테이블

`specs/db/schemas/fts.sql`:

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  note_id UNINDEXED,   -- notes.id
  title,               -- notes.title
  body,                -- 모든 sections.body_md 연결 ('\n\n' 구분)
  source_body,         -- 모든 sources.body 연결
  tag_names,           -- 연결된 tags.name 공백 구분
  tokenize = 'trigram case_sensitive 0'
);
```

**5개 컬럼, `note_id`만 UNINDEXED**(검색 매치에 관여하지 않고 결과 식별용). 나머지 4개
(`title`/`body`/`source_body`/`tag_names`)가 색인 대상이다.

- **토크나이저 = trigram**(migrations.rs V10). 이전 `unicode61`은 공백 구분 CJK 어절을
  통짜 토큰으로 취급해 어절 중간/끝 부분 문자열을 못 찾는 P1 버그가 있었다("세종대왕"이
  있어도 "종대"로 미매치). trigram은 3글자(코드포인트) 시퀀스 단위 인덱싱이라 CJK/Latin
  관계없이 어디서든 부분 문자열 매치가 된다.
- `case_sensitive 0` = 대소문자 무시.
- 갱신 책임은 **DB 트리거가 아니라 Rust 저장소 계층**이 노트 변경과 동일 트랜잭션에서
  upsert한다(`repo/fts.rs`) — sections/sources/tags를 노트 단위 1행으로 집계해야 하므로
  트리거보다 계층 갱신이 단순·검증 용이하다는 것이 스키마 주석의 근거.

### 3.2 bm25 가중치

`repo/search.rs:162`:

```rust
const BM25_WEIGHTS: &str = "0.0, 10.0, 1.0, 2.0, 5.0";
```

호출부(`fts_sql`, `repo/search.rs:175`)는 `bm25(notes_fts, {BM25_WEIGHTS})`로 **5개 값을
전부** 넘긴다. `notes_fts`의 컬럼 선언 순서(`note_id`, `title`, `body`, `source_body`,
`tag_names`)에 위치가 그대로 대응하므로:

| 위치 | 컬럼 | 가중치 |
|---|---|---|
| 1 | `note_id` (UNINDEXED) | 0.0 |
| 2 | `title` | 10.0 |
| 3 | `body` | 1.0 |
| 4 | `source_body` | 2.0 |
| 5 | `tag_names` | 5.0 |

즉 **title(10) > tag_names(5) > source_body(2) > body(1)** 순으로 랭킹에 반영된다. 코드
주석(`repo/search.rs:158-161`)이 이 매핑을 명시적으로 경고한다: "bm25() 가중치는
UNINDEXED 컬럼을 포함한 선언 순서에 그대로 포지셔널로 매핑되므로 4개만 주면 한 칸씩
밀린다(과거 버그: title에 5.0, tag_names는 기본값 1.0으로 새어 들어갔었다)". 4-인자 호출
(`bm25(notes_fts, 10.0, 5.0, 1.0, 2.0)`)이면 `note_id` 자리가 생략되지 않고 title이
0번째로 밀려 title=10→(빠짐), 사실상 title에 매핑되던 값이 body로, tag에 매핑되던 값이
source_body로 밀리는 식으로 전부 한 칸씩 어긋난다.

이 순서는 `search_invariants::test_bm25_ranking_prioritizes_title_matches`
(`repo/search.rs:726`)로 회귀 고정돼 있다 — title/tag/source_body/body 각각에만
동일 키워드를 넣은 4개 노트를 만들어 정확히 title > tag > source_body > body 순서로
반환되는지 단언한다. 테스트 주석: "The tag-vs-source_body pair is the discriminating
case" — 4-인자 버그가 났다면 source_body(2.0)가 tag_names(1.0 기본값)를 역전시키는데,
이 케이스가 그 역전을 잡아낸다.

또한 `cap_tests::fts_and_like_queries_structure`(`repo/search.rs:495`)가 생성된 SQL
문자열에 `bm25(notes_fts, 0.0, 10.0, 1.0, 2.0, 5.0)`이 그대로 포함되는지 단언해 상수
자체의 회귀도 고정한다.

### 3.3 R9 회귀 방지 — 지금 모양 (2026-10-09 Wave D)

> **아래 "semi-join 형태" 서술은 2026-10-09 이전 역사다.** 그 모양은 bm25 를 후보마다 MATCH 를
> **다시** 도는 상관 서브쿼리로 계산해 흔한 낱말에서 O(매치수²) 였다 — 합성 1만 노트(본문×4)
> release 실측 "프로젝트" **86,168ms**, "동기화 방식 고민" 64,451ms. Wave D(5ed051c7)가 이렇게 바꿨다:
>
> ```sql
> WITH c AS MATERIALIZED (
>   SELECT (SELECT note_id FROM notes_bigram_map WHERE id = notes_fts.rowid) AS nid,
>          bm25(notes_fts, 0.0, 10.0, 1.0, 2.0, 5.0) AS score
>   FROM notes_fts WHERE notes_fts MATCH ?)
> SELECT c.nid FROM c
> WHERE (SELECT 1 FROM notes n WHERE n.id = c.nid AND +n.folder_id IN (…) AND +n.deleted_at IS NULL [AND +n.year …]) IS NOT NULL
> ORDER BY c.score, (SELECT year …), (SELECT created_at …), c.nid
> LIMIT ?
> ```
>
> R9 의 의도(통계가 어떻든 notes 를 FTS 루프 안쪽에서 훑지 못할 것)를 지키는 규칙:
> - FROM 에는 **FTS5 가상 표 하나, 또는 물질화된 CTE 하나**만. JOIN·EXISTS 금지 — `CROSS JOIN` 으로 순서를
>   고정해도 안쪽 표에 **어떻게** 닿을지는 통계로 고르고(zero-row 통계에서 `SCAN n` 실측), EXISTS 는 SQLite 가
>   조인으로 바꾼다(`SCAN n EXISTS` 실측).
> - notes·매핑 표는 상관 서브쿼리의 **단일 표 + 유일 키 동등**으로만 닿는다 — 통계와 무관하게 키 조회.
> - 필터 열에 단항 `+` — PK 대신 다른 인덱스를 잡을 여지를 없앤다.
> - note_id 는 매핑 표에서(§4.1 V95 — notes_fts 열을 읽으면 FTS5 가 행 전체를 가져온다). 따라서
>   **매핑 행이 없는 notes_fts 행은 검색에 안 보인다** — 매핑은 notes_fts 의 모든 행을 가져야 한다
>   (`docs/DATA-WRITES.md` §1). 테스트에서 notes_fts 를 직접 넣을 땐 `fts::bigram_index` 도 함께.
>
> 잠금: `cap_tests::fts_and_like_queries_structure`(SQL 모양 — MATCH·bm25 한 번, MATERIALIZED, JOIN/EXISTS 없음)
> + `poisoned_stats_keep_notes_a_pk_lookup`(통계 없음·ANALYZE·zero-row 세 상태에서 EXPLAIN QUERY PLAN — notes 는
> 늘 PK 조회, MATCH 는 상관 노드 밖 한 번). 결과·순서가 예전과 같다는 건 예전 SQL 을 그대로 둔 오라클과의
> 등가성 테스트(`equivalence::*`, `automation_corpus::search_box_equals_old_search_on_corpus`)가 지킨다.

#### (역사) semi-join 형태 잠금 — 2026-10-09 이전

`repo/search.rs:164-169`의 `fts_sql`/`like_sql` 바로 위 주석:

> R9: notes_fts 를 `f JOIN notes n ON n.id = f.note_id` 형태로 조인하면 플래너가 통계가
> 어긋난 상황(빈 DB ANALYZE 등, `db::scrub_zero_row_stats` 참조)에서 notes 쪽
> `idx_notes_year_alive` range scan 을 안쪽 루프에 놓아 O(매치수 × 노트수) 로 폭발한다
> (**실측: 10k 노트 DB에서 90ms → 62,279ms**). 그래서 후보 선별은 반드시
> semi-join(`n.id IN (SELECT note_id FROM notes_fts WHERE MATCH ?)`) 형태를 유지하고,
> BM25 순위는 note_id 로 상관된 스칼라 서브쿼리로 별도 계산한다 — notes 를 FTS 결과와
> 직접 JOIN하지 않으므로 플래너가 나쁜 조인 순서를 고를 여지가 없다.

실제 생성 SQL(`fts_sql`)도 이 형태 그대로다:

```sql
SELECT n.id FROM notes n
WHERE n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?)
  AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?) AND n.deleted_at IS NULL
ORDER BY (SELECT bm25(notes_fts, 0.0, 10.0, 1.0, 2.0, 5.0) FROM notes_fts WHERE notes_fts MATCH ? AND note_id = n.id)
LIMIT 500
```

이 형태는 `cap_tests::fts_and_like_queries_structure`(`repo/search.rs:490-523`)가 **생성된
SQL 문자열**에 대해 고정한다 — `EXPLAIN QUERY PLAN`이 아니라 SQL 형태에 단언을 거는
이유도 주석에 적혀 있다: "플랜은 통계·데이터에 종속이라 빈 인메모리 DB 에서는 나쁜 플랜이
재현되지 않아(관측함) 단언이 vacuous 해진다. 형태 잠금은 JOIN 으로 되돌리는 순간 결정적으로
실패한다." 테스트는 `fts_sql`/`like_sql` 양쪽 모두에 대해:

- `sql.contains("n.id IN (SELECT note_id FROM notes_fts")` (semi-join 형태 유지)
- `!sql.contains("JOIN notes")` (derived-table JOIN 회귀 시 실패)

를 `apply_year` true/false 두 경우 모두 단언한다. 즉 **"JOIN으로 되돌리면 62초대 회귀가
재현된다"**는 근거가 테스트 코드에 직접 실측치(90ms → 62,279ms)와 함께 박제돼 있다.

### 3.4 연대 필터 3모드

`specs/features/search.yaml` F-S02가 카탈로그화한 프론트 3모드: **스크러버 / Range+왕조 /
Decade**(`notes: 프론트 전용 — 세 모드 모두 search_notes(year_from, year_to) 하나로
수렴`). 백엔드에는 모드 개념이 없다 — `year_clause(apply_year)`가 `year_from`/`year_to`를
그대로 `BETWEEN` 조건으로 바인딩할 뿐이다(`repo/search.rs:128-134`). `apply_year`가
`false`인 경우(요청 범위가 UI 기본 전체 스팬 900~1960과 동일)는 이 절 자체를 생략한다.

### 3.5 LIKE 폴백 경로

> **2026-10-09(Wave D1)**: 쿼리에 2글자 창이 하나라도 있으면(`fts::bigrams_into` 규칙) 전체 LIKE 스캔 대신
> **2글자 색인**(`notes_bigram`, 창마다 따옴표 친 FTS5 암묵 AND)으로 후보를 좁히고, 아래의 네 열 LIKE 를 그 후보에만
> 최종 술어로 건다(`like_bigram_sql`, notes_fts 는 rowid 로만). 쿼리가 열 안의 부분 문자열이면 쿼리의 창은 전부 그
> 노트의 창이므로 후보는 LIKE 매치의 상위 집합 — 결과가 **구성상** 같다. 창이 없는 쿼리(1글자·기호뿐)만 아래
> 전체 스캔(`like_sql`)을 그대로 쓴다. 결과 0건 오타("부산여헹") 44→0.3ms. 단 아주 흔한 2글자는 후보가 거의
> 전부라 예전 순차 스캔보다 조금 느리다("커피" 48→62ms, "부산 여행" 69→76ms — 둘 다 100ms 이하).

`like_ids`(`repo/search.rs:223-247`)가 발동하는 조건 두 가지(`search()` 호출부,
`repo/search.rs:79`):

1. 쿼리 문자 수(코드포인트) **2자 이하** — trigram MATCH는 원리상 3글자 미만 토큰에서
   트라이그램을 하나도 만들 수 없어 인덱싱이 불가능하다(`build_match_query`가 3글자 미만
   토큰을 건너뛰고, 유효 토큰이 하나도 없으면 `None`을 반환해 FTS 자체를 스킵).
2. FTS 매치가 **0건**일 때(`!fts_has_hits`).

`like_sql`은 `notes_fts`의 4개 텍스트 컬럼(`title`/`body`/`source_body`/`tag_names`)
전체에 `LIKE ? ESCAPE '\\'`를 걸어 UNION 개념으로 후보를 모은다 — title/tag만 보던 과거엔
본문(sections)/출처(sources)에만 있는 짧은 매치를 놓쳤다는 것이 주석의 회귀 배경
(R8, `repo/search.rs:217-222`). semi-join 형태(§3.3)와 `LIKE_SCAN_CAP`(1000) 상한을
`like_sql`도 동일하게 따른다. `%`/`_`는 `escape_like()`로 리터럴 이스케이프된다(LIKE
와일드카드로 오작동하지 않음 — `like_escape_treats_percent_and_underscore_as_literals`
테스트로 고정).

### 3.6 스니펫 생성

`populate_snippets`(`repo/search.rs:262-338`)는 FTS5의 `snippet()` 함수를 직접 쓰지
않는다 — 대신 노트 본문(sections 투영, `repo::sheet::note_body_texts`)과 sources 테이블을
배치 SELECT한 뒤, Rust 쪽 `extract_plain_snippet`(`repo/search.rs:340-376`)이 대소문자
무시 부분 문자열 매치를 찾아 앞 30자/뒤 40자(문자 단위) 윈도우를 잘라 `\u{0002}`(STX)/
`\u{0003}`(ETX) 센티널로 매치 구간을 감싼 문자열을 만든다. 함수 주석이 이유를 밝힌다:
"notes_fts 가상 테이블(note_id UNINDEXED로 풀스캔 유발)을 조회하지 않고 원본 테이블에서
note_id 인덱스를 활용" — 즉 FTS5 가상 테이블을 다시 스캔하는 대신 이미 인덱스가 있는 실제
테이블에서 텍스트를 가져온다. 본문에서 못 찾으면 `sources` 테이블을 추가로 배치 조회한다.
멀티바이트 문자 경계 어긋남(`to_lowercase()`가 일부 문자에서 바이트 길이를 바꾸는 경우,
예 `'İ'`→`"i̇"`)이 감지되면 스니펫을 포기하고 `None`을 반환한다(패닉 방지).

## 4. 핵심 코드 경로

| 경로 | 역할 |
|---|---|
| `src-tauri/src/repo/search.rs` | 검색 구현 본체 — `search()`, `fts_ids`/`like_ids`/`year_scoped_ids`, `populate_snippets` |
| `src-tauri/src/repo/fts.rs` | `notes_fts` upsert(노트 쓰기 트랜잭션과 동일 트랜잭션에서 호출) |
| `specs/db/schemas/fts.sql` | `notes_fts` 가상 테이블 DDL |
| `specs/commands/search.yaml` | `search_notes` IPC 계약 |
| `specs/service/search.yaml` | 의사결정 흐름(SSaC) |
| `specs/features/search.yaml` | 기능 카탈로그(F-S01/F-S02/F-S03), verify 경로·cases |
| `src-tauri/tests/invariant_fts_sync.rs` | FTS 동기화 불변성(생성/수정/삭제 시 인덱스 반영) |
| `src-tauri/tests/invariant_year_filter.rs` | 연대 필터 경계값·검증 오류 |
| `src/lib/searchMatch.test.ts` | 프론트 매치 커서(find-next) 순수 함수 테스트 |
| `src/stores/search.ts` | 프론트 검색 스토어 — 디바운스(200ms), stale 응답 가드, `recentSearches` |
| `src/lib/noteQuery.ts` | record 축 `DateRangeKey`(최근 7일/30일/올해) 해석 — search_notes와 별개 축 |
| `src-tauri/src/repo/question_search.rs` | **채팅 질문 검색**(§4.1) — 검색창과 다른 의미(OR·idf) |

### 4.1 채팅 질문 검색 (2026-10-08)

검색창(`search()`)은 여러 낱말을 **전부(AND)** 요구한다 — 사람이 검색창에 "부산 여행"을 치면 둘 다 담은 노트를 원하므로 맞다.
그런데 채팅은 "부산 여행 준비할 거 뭐 있었지?" 같은 **문장**을 그대로 넣었고, 그 문장의 모든 어절을 담은 노트는 없어서
채팅 근거 검색이 사실상 죽어 있었다 — 라벨 코퍼스 실측 재현율 **0/31**(`docs/PLAN-2026-10-08-automation.md` F22).

- **경로**: `pet_chat` → `repo::pet::rag_query`(프런트가 붙인 `[첨부: …]`·`[참고할 노트 검색 결과]` 블록 잘라 냄) →
  `repo::pet::rag_hits` → `repo::question_search::question_hits`. 펫·사이드바 챗 모두 이 한 지점을 지난다. 검색창 의미는 그대로.
- **방식(토큰 0)**: 문장부호 제거 → 조사·어미 떼기(남는 줄기 2자 이상일 때만) → 의문사·군더더기 제거 → 2자 이상 핵심어(최대 10) →
  핵심어마다 노트 집합(3자 이상 = trigram FTS 로 **집합만**, 2자 = **2글자 색인** `notes_bigram`(V94) 조회 — 둘 다 note_id 는 매핑 표 `notes_bigram_map` 에서) → 드문 말일수록 큰 가중치(idf) 합 + 제목 가산.
  검색창의 `fts_ids` 는 쓰지 않는다 — bm25 정렬용 상관 서브쿼리가 흔한 낱말에서 매치 수의 제곱으로 느려져, 합성 1만 노트에서 11~33초가 걸렸다(채팅은 전역 DB 잠금을 쥔 채 돈다).
  (그 제곱 문제는 2026-10-09 Wave D 에서 검색창 쪽도 고쳤다 — §3.3. 채팅은 의미가 달라 계속 질문 검색을 쓴다.)
- **채팅 턴의 검색은 이 한 번뿐(2026-10-09 Wave S, 14d715b8)**: 예전엔 프런트(`chatSearchTool.ts`, 삭제됨)가 문장 그대로
  `search_notes`(AND 라 대개 0~2건)를 부르고, 3건 미만이면 **유사어 확장 AI 호출**을 한 번 더 한 뒤 결과를
  `[참고할 노트 검색 결과]` 블록으로 메시지에 붙였다. 이 경로는 `chat_read_files`("채팅이 노트 읽기")를 **무시**하고
  제목·발췌를 보냈다(버그). 지금은 한 턴 = `pet_chat` 한 번, 검색은 Rust 질문 검색 한 번. 프런트는 질문 패턴일 때
  `show_evidence: true` 만 보내고, `answer` 응답이면 **프롬프트에 실제로 넣은 근거 노트**가 `hits`(카드)로 돌아온다 —
  어시스턴트 행 meta 로 저장돼 다시 열어도 남는다. `chat_read_files` 가 꺼져 있으면 근거 주입도 카드도 없다.
  `rag_query` 의 블록 잘라 내기는 옛 클라이언트(새로 고치지 않은 폰 `/app` 탭 등) 때문에 남겨 둔다.
  검색 제외 폴더·휴지통은 검색창과 같은 선으로 빠진다.
- **실측(2026-10-08, `src-tauri/tests/automation_corpus.rs`)**:

  | 조건 | dev | holdout |
  |---|---|---|
  | 이전(문장 전체 AND) | 0/22 | 0/9 |
  | 질문 검색 | **9/22** | **6/9** ¹ |
  | + AI 검색어 확장(Gemini flash-lite 기록본) ² | 9/22 | 7/9 |
  | + 정답 태그(= 분류가 맞았을 때) | 11/22 | 7/9 |

  동음이의 오인용 0, 답 없는 질문에 근거 0. 바닥은 `chat_retrieval_question_recall_floor` 가 래칫으로 지킨다.
  ¹ **엄밀한 홀드아웃이 아니다** — 추출기 단위 테스트가 holdout 질문(q14)도 단언하고, 그걸 통과시키려 군더더기("중에")를 더했다. 16문항 전체를 보고 맞춘 수치로 읽을 것.
  ² **잠정** — 확장 프롬프트도 추출기도 1글자 낱말을 버려서, 가장 큰 실패(q10 "잠")를 확장이 시험받지 못했다. "확장은 효과 없다"의 증거가 아니라 "1글자 제외 조건에서 +1"이다.
- **속도**: 합성 1만 노트·본문 평균 1,002자 release 실측(`src-tauri/tests/bench_question_search.rs`, ignore,
  `BRISE_BENCH_BODY_SCALE=4`) 질문당 평균 **12.5ms**·최악 **21.4ms**(2026-10-09, 작업자 측정). 검증 재측정(같은 날, 별도 실행)은
  평균 13.5ms·최악 18.8ms — 실행마다 ±1~3ms 흔들리고, 목표(평균 ≤15·최악 ≤25ms)는 두 번 다 충족한다. 단계별로:

  | 단계 | 평균 / 최악 |
  |---|---|
  | 처음 커밋(245297b7, 검색창 `fts_ids` 재사용) | 흔한 낱말에서 11~33초 |
  | 2자 = LIKE 한 번의 스캔, 3자+ = FTS 집합(663d4836) | 97.3 / 127.2ms |
  | 2자 = 2글자 색인(V94, 49195b23) | 24~25 / 42~48ms |
  | 3자+ = MATCH rowid → 매핑 표(V95) | **12.5 / 21.4ms** |

  - **2글자 색인(V94, `specs/db/schemas/fts_bigram.sql`)**: notes_fts 네 열의 글자·숫자 구간마다 겹치는 2글자 창을
    contentless FTS5(`detail=none`, `tokenize='ascii'`)에 넣는다. 의미는 예전 `LIKE '%ab%'`(ASCII 만 대소문자 무시)와
    **정확히 같다** — 단위 테스트(é/É·결합 문자·`_`/`%`·태그·출처·시트·검색 제외·휴지통)와 코퍼스 전체 창 대조가 LIKE 를
    오라클로 지킨다. 크기는 notes_fts 의 3%(1만 노트 2.1MB), 쓰기 경로 비용은 측정 잡음 안, 백필 1만 노트 1.0초.
  - **3자+ 경로(V95)**: `notes_fts.note_id` 를 읽으면 FTS5 가 맞은 행마다 내용 행 전체(본문 포함)를 가져온다 — MATCH 자체는
    0.5ms 인데 5000건 id 읽기가 ~19~24ms 였다. 매핑 표의 id 를 notes_fts rowid 로 맞춰 rowid 만으로 note_id 를 찾는다(→ 3.7ms).
    매핑 표는 그래서 notes_fts 의 **모든** 행을 가진다(`docs/DATA-WRITES.md` §1).
  - 읽기는 전역 DB 잠금 밖 읽기 전용 연결(37ffdbe0, `AppState::with_read`) — 검색 중에도 자동 저장이 기다리지 않는다.
    이 연결은 앱이 켜져 있는 내내 DB 파일·-wal·-shm 을 쥔다. 그래서 DB 파일을 통째로 바꾸는 일(백업 복원)은
    `AppState::with_db_file_swap` 으로 읽기 연결을 닫았다가 다시 연다. 처음엔 이게 빠져 있어 Windows 에서 복원이 늘
    os error 32 로 실패했다(검증 중 발견, 회귀 테스트 `backup_restore_with_read_handle_…`). 파일을 바꾸는 새 경로도 같은 함수를 지나야 한다.
  - ponytail: 낱말당 상한 5000 을 넘는 흔한 낱말은 **어느** 5000개가 잡히는지가 예전과 다를 수 있다(지금은 색인 rowid 순).
    상한 아래에선 집합이 같다. 10만 노트에선 상한에 걸리는 낱말이 늘어 정확도·속도 모두 다시 재 볼 것.
    백필은 **V95 단계에서 한 번만** 돈다(2026-10-12, 오너 O-4 — 그 전엔 V93 이하 DB 가 V94·V95 에서 두 번 돌아 첫 부팅이 두 배였다. 1만 노트 0.8~1.0초).
- **답변까지(2026-10-08, Gemini `gemini-3.1-flash-lite`, 실제 `pet_chat_inner` 경로 전체)**: 다양한 입력 25종
  (`src-tauri/tests/fixtures/automation/chat_inputs.json` — 사실·바꿔 말하기·오타·키워드만·엇갈림·동음이의·답 없음·비밀값 떠보기·주입·영어·상대 날짜·가계부)
  **22/25 통과, 평균 1.7초**(검색 근거 끄면 18/25 — 대부분 "검색 카드"로 우회, 평균 4.4초). 평가 중 찾은 결함 둘을 고쳤다:
  핵심어가 제목에만 있으면 본문 대신 제목만 모델에 가던 것(→ 본문 첫머리) · "km야"처럼 영문+한글 붙은 어절을 못 가르던 것.
  남은 실패: 요약 요청(근거 4개·발췌 240자 한도) · "작년 크리스마스"에 엉뚱한 카드 · 영어 질문(교차 언어).
  실행: `BRISE_EVAL_API_KEY=… cargo test --test automation_corpus -- --ignored --nocapture chat_answers_live_report`(결과 `.eval/chat/`).
- **한계**: 동의어(노트엔 "잠", 질문엔 "수면")·오타("커퓌")·1글자 낱말은 못 잡는다. AI 확장은 이 조건에서 이득이 작아(+1/31, 잠정 ²) 지금은 도입하지 않았다 —
  어휘 차이는 **정리(태그·지식 노트)**가 메우는 몫이고, 그게 자동화(PLAN W11·W12)의 존재 이유다.

## 5. 최근 검색 (`search_recent`)

- **전용 테이블이 아니라 settings kv 키 하나**다(`emoji_recent`와 같은 패턴) —
  `specs/db/schemas/settings.sql:31`: `search_recent(string[], 기본 [] — QA8 Wave 3A 검색
  자동완성 기록, newest-first, 상한 20은 프런트 stores/search.ts)`.
- 저장 형태는 문자열 배열, newest-first, LRU(`src/stores/search.ts::promoteRecentSearch`).
  프론트 상한 20개(`SEARCH_RECENT_MAX`), 백엔드 `validate_setting`은 항목당 200자
  (`SEARCH_RECENT_ITEM_MAX_LEN`과 동기)·배열 길이 40까지 느슨하게 허용(구버전 빌드의
  약간 큰 쓰기도 통과시키기 위한 여유, `settings_schema.rs:385-388` 주석).
- 쓰기 경로는 `note_update` 같은 전용 커맨드가 아니라 범용 `settings_set`
  (`src/stores/search.ts::persistRecent` → `settings_set({ entries: { search_recent: next
  } })`).
- **기기 로컬, 동기화 안 됨** — `src-tauri/src/repo/settings_schema.rs::is_device_local_setting_key`
  가 `"search_recent"`를 `"device_id"`/`"sync_enabled"`/`"sync_port"`/`"sync_token"`과 같은
  목록에 포함시킨다. 근거 주석(`settings_schema.rs:65-67`): "query history is
  content-adjacent — a notebook handed to someone else must not carry the previous owner's
  search terms." export 번들/백업 zip 어느 경로에도 실리지 않는다 —
  `repo/transfer/export.rs::dump_excludes_search_recent_from_the_exported_bundle` 테스트가
  `search_recent` 키를 심어 둔 뒤 `dump()` 결과에 그 키가 없는지 확인한다.
- `docs/SYNC.md`의 "동기화 안 하는 것" 원칙(FTS5는 파생 데이터라 로컬 재빌드)과는 결이
  다른 이유다 — FTS5는 "다시 계산 가능한 파생 데이터라서" 동기화 제외, `search_recent`는
  "노트북과 함께 넘기면 안 되는 개인 사용 이력이라서" 제외. 둘 다 §6 공통 원칙("모든
  동기화 쓰기는 repo 계층 단일 경로 경유")과는 별개로, 애초에 동기화/번들 대상에서
  원천 배제된 데이터라는 공통점만 있다.

## 6. 알려진 한계/결정

- **`total`은 정확한 COUNT가 아니라 캡된 후보 집합의 크기다.** 빈 쿼리·전체 연도처럼
  넓은 검색은 `SEARCH_RESULT_CAP`(500)에서 잘리고, `total = ids.len()`(캡 이전 실제 후보
  수 — `year_scoped_ids`/`fts_ids`는 SQL `LIMIT`으로 이미 캡된 상태로 반환되므로 500을
  넘는 매치가 있어도 `total`이 500으로 보고될 수 있다). LIKE 폴백 경로는 `LIKE_SCAN_CAP`
  (1000)에서 잘린 뒤의 개수가 `total`이 된다 — "진짜 전량 매치 수"가 아니라 "캡된 후보
  수"라는 것이 코드 주석의 명시적 설계 의도(무거운 `COUNT(*)` 재조회를 피하기 위함).
  프론트는 500개 도달 시 "500+"로 표시하는 관례를 쓴다(코드 주석 근거, 실제 프론트 표시
  로직은 이 문서 확인 범위 밖).
- **notes_fts는 파생 데이터, 절대 동기화 대상이 아니다** — `docs/SYNC.md` §1/§6: "동기화
  안 하는 것: FTS5 인덱스 — 파생 데이터, 동기화 후 로컬 재빌드." 동기화 로드맵(Phase 2)이
  구현돼도 FTS5 인덱스 자체는 행 단위로 push/pull되지 않고, 노트 본문 동기화 뒤 로컬에서
  재색인된다.
- **아카이브는 FTS 색인을 지우지 않는다** — `repo/search.rs` 파일 최상단 주석: "이 파일은
  의도적으로 `archived_at`을 걸지 않는다. '보이지 않지만 찾으면 나온다'의 핵심 계약이
  바로 이것 — 아카이브는 `delete()`와 달리 FTS 색인을 지우지 않으므로
  (`repo/notes.rs::archive`) 이 파일의 `deleted_at IS NULL` 술어들은 그대로 두고
  `archived_at`은 절대 추가하지 않는다." 즉 아카이브된 노트도 검색 결과에 그대로
  뜬다 — 소프트 삭제(`deleted_at`)만 검색에서 제외된다.
- **검색창 SQL 모양은 잠겨 있다** — §3.3. 2026-10-09 전엔 semi-join 이 프리즈돼 있었고, 지금은
  "FROM 에 FTS5 표·물질화 CTE 하나, 일반 표는 유일 키 동등 스칼라 서브쿼리로만, JOIN·EXISTS 없음"이
  SQL 모양 테스트와 zero-row 통계 플랜 테스트 두 겹으로 잠겨 있다. 이 파일을 고칠 때는 두 테스트와
  예전 SQL 오라클 등가성 테스트가 그대로 통과하는지 먼저 본다.
- **검색창 속도(2026-10-09, 합성 1만 노트·본문×4·release·limit 500, 5회 평균, 코디네이터 재측정)**:
  프로젝트 49 · 해운대 38 · 커피 62 · 부산 여행 76 · 부산여헹 0.3 · 비 59 · 동기화 방식 고민 53ms(최악 76ms).
  `populate_snippets`(요약+본문)는 ~5ms. 합성 어휘가 ~100낱말이라 "드문" 낱말도 500건 넘게 맞는다 — 드문 2글자가
  매치 수에 비례하는지는 미실측.
- **bm25 가중치 인자 개수는 반드시 5개** — `notes_fts`가 5컬럼이므로 `bm25()` 호출도
  5개 값을 명시해야 한다(§3.2). 4개만 주면 포지션이 한 칸씩 밀려 조용히 잘못된 랭킹을
  만든다 — 과거 실제로 났던 버그(코드 주석에 명시)이고, 지금은 SQL 문자열 상수 검사 +
  랭킹 순서 단언 두 겹으로 잠겨 있다.
