# 데이터 쓰기 규칙 — 노트를 만드는 모든 경로가 지켜야 할 것

이 문서는 **노트를 만들거나 고치는 코드**를 위한 것이다. 앱 UI, 임포트 스크립트, 마이그레이션
도구, 일괄 편집 유틸리티가 모두 대상이다. 읽기만 하는 코드에는 해당 없음.

## 1. FTS 인덱스는 트리거가 아니라 저장소 계층이 갱신한다

`notes_fts`(`specs/db/schemas/fts.sql`)는 **DB 트리거로 자동 갱신되지 않는다.** Rust 저장소
계층이 노트 변경과 **같은 트랜잭션에서** upsert 한다. 노트 본문은 `sections`, 출처는 `sources`,
태그는 `note_tags` 에 흩어져 있어서 노트 단위 1행으로 집계해야 하는데, 그건 트리거로 짜기보다
계층에서 다루는 편이 단순하고 검증하기 쉽기 때문이다(그 판단 근거는 fts.sql 상단 주석에 있다).

**따라서 SQLite 에 직접 INSERT 하면 노트는 생기지만 검색에 잡히지 않는다.** 사용자 눈에는
"분명히 저장했는데 검색해도 안 나오는 노트"로 보이고, 원인을 짐작하기가 매우 어렵다.

향후 만들 **마크다운 임포트 스크립트도 여기에 해당한다.** 파일을 읽어 SQLite 에 바로 쓰지 말고,
앱이 쓰는 것과 동일한 Rust 커맨드(`note_create` → `section_update` → `note_set_tags` …)를 타야
한다. 개발용 시더(`src-tauri/src/bin/seed_corpus.rs`)가 어떻게 하는지 참고할 것 — 그쪽은 배치
성능을 위해 저수준으로 쓰되 FTS 갱신을 같은 트랜잭션에서 함께 수행한다.

불변식 정의: `specs/tests/invariant-fts-sync.yaml`.

**2글자 색인도 같은 규칙이다(V94·V95, `specs/db/schemas/fts_bigram.sql`).** `notes_bigram`(2글자 창) +
`notes_bigram_map`(노트 매핑)은 `notes_fts` 의 같은 네 열에서 파생되고, `repo/fts.rs` 가 `notes_fts` 를 쓰는
**같은 함수·같은 트랜잭션**에서 함께 맞춘다. 매핑 표의 `id` 는 그 노트의 **`notes_fts` rowid** 이고 `notes_fts`
의 모든 행에 매핑 행이 있어야 한다 — 채팅 질문 검색이 3자 이상 낱말을 trigram MATCH 의 rowid → 매핑 표로
찾기 때문에, 매핑이 빠진 노트는 2글자뿐 아니라 **3자 이상 질문 검색에서도 조용히 사라진다.** `notes_fts` 에 직접
INSERT 하는 예외 경로(개발용 시더 `dev_seed.rs`)는 곧바로 `fts::bigram_index(tx, last_insert_rowid(), …)` 를
불러야 한다. 불변식 테스트: `src-tauri/tests/invariant_bigram_sync.rs`.

**마이그레이션 전용 경로 주의:** `fts_upsert_fts_only`(`repo/fts.rs`)는 V69 마이그레이션 백필 전용(MIG, `ee0e4d04`)이다. `notes_bigram` 매핑을 생략하고 `notes_fts`만 갱신하므로 일반 런타임 쓰기 경로에서는 절대 호출해선 안 되며, 런타임 쓰기는 반드시 `notes_bigram` 매핑을 함께 맞추는 `fts_upsert`를 써야 한다.

## 2. 최적화는 읽기만 바꾼다

성능 작업(전송 형식, 캐시, 인덱스, 창 단위 로딩 등)은 **데이터를 어떻게 읽고 보여줄지만** 바꾼다.
**어떻게 쓰고 내보낼지는 건드리지 않는다.** 판단 기준은 하나다 — 최적화 전후로 노트의 내용과
export 결과물이 바이트 단위로 같아야 한다.

이 선을 지키면 성능 작업이 데이터를 깨뜨릴 경로가 원천적으로 생기지 않는다. 원본은 SQLite
테이블이고 FTS·벡터 인덱스·프론트 인덱스·스냅샷은 전부 파생물이라, 파생물이 틀리면 검색 결과가
나빠질 뿐 노트는 멀쩡하다.

## 3. 쓰기는 원자적으로, 부분 성공을 사용자에게 숨기지 않는다

여러 필드를 순차로 저장하는 경로(새 노트 생성이 대표적이다)는 중간에 하나가 실패하면 나머지가
조용히 건너뛰어진다. 화면이 이미 "저장됨"으로 바뀐 뒤라면 사용자는 실패를 알 수 없고, DB 와
화면이 갈라진 채로 남는다.

원칙: **저장이 끝나기 전에 저장됐다고 표시하지 않는다.** 부득이 낙관적으로 표시했다면 실패 시
반드시 되돌리거나 DB 에서 다시 읽어 맞춘다.

## 4. 동기화 준비(Phase 0, docs/SYNC.md): updated_at + tombstone

행 단위 변경 추적이 필요한 테이블(sections/sources/tags/folders/workspaces — 실제 UPDATE 경로가
있는 테이블만, notes 는 이미 있음)의 모든 UPDATE 경로는 `updated_at = now_iso()` 를 함께 찍는다.

하드 삭제 경로(예: `note_purge`, `attachment_remove`, `section_delete`, 태그 고아 정리)는 삭제와
**같은 트랜잭션**에서 `repo/tombstone.rs::record_tombstone(tx, tbl, id)` 를 호출해 `deleted_rows`
에 한 행을 남긴다. 캐스케이드 규칙: **직접 삭제한 엔티티만** tombstone 한다 — `ON DELETE CASCADE`
로 함께 사라지는 자식 행(예: 노트를 지우면 sections/sources/attachments/note_tags 가 같이
사라진다)은 부모의 tombstone 하나로 암시되므로 별도로 기록하지 않는다. 새 하드 삭제 경로를
추가할 때 이 헬퍼를 거치지 않으면 그 삭제는 다른 기기로 전파되지 않는다(부활 버그).

## 런타임 스모크 게이트

프론트엔드 또는 UI를 변경했다면 완료로 선언하기 전에 `npm run smoke`를 실행한다. 이 게이트는
개발 앱에 CDP로 연결해 실제 기동을 확인한다. 정적 게이트는 렌더 루프, 죽은 이벤트 핸들러,
누락된 Tauri capability 권한을 볼 수 없기 때문에 별도의 런타임 검증이 필요하다.
