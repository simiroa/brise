# Scalability Policy — 10만+ 노트 / 100만+ 첨부

> Status: **policy / design gate** (2026-07-23). 구현 전 합의용. Phase 0/1/2 로드맵 포함.
> 근거: 3영역(frontend load·render / backend query·index / vector·fs·transfer) 병렬 감사.
>
> **2026-07-26 갱신 — 이 문서는 여전히 목표를 정의하지만, 아래 "현재 아키텍처" 서술은 일부
> 옛 상태다.** 그 사이 실측과 착수가 있었다:
> - 실측 baseline: `docs/reviews/2026-07-25-phase0-perf-baseline.md` (10만 기준. 예산 위반이
>   기동·필터 전환·좌측 패널 뷰 전환·검색에서 확인됐고, 연도 슬라이더·지도 팬은 통과).
> - 검색: 중복 FTS MATCH 와 정확 COUNT 를 제거해 광범위 질의 1,491ms → 813ms. 남은 비용의
>   뿌리는 trigram 토크나이저이며 이중 인덱스 결정은 아직 열려 있다.
> - 기동: `folder_list_meta`(폴더+카운트만, 9.5ms)로 첫 페인트를 분리했으나, 전량 로드가 여전히
>   부팅 창 안에서 돌아 10만 기동은 9.3초로 남아 있다 — **미해결**.
> - 진행 중(Wave A): 사이드바의 노트 읽기를 단일 엔드포인트 `note_query` 로 모으고 축을 하나씩
>   서버로 옮기는 중. 클라이언트 상주 코퍼스는 **마지막에** 제거하며, 그때까지 축마다 서버·
>   클라이언트 결과 동등성 테스트로 고정한다.
> - 쓰기 경로 규칙은 `docs/DATA-WRITES.md` 로 분리했다(임포터가 FTS 를 깨뜨리지 않도록).

## 0. Governing principle (지배 원칙)

**비용은 "지금 화면에 보이는 것" 또는 "방금 바뀐 것"에 비례해야 한다 — "코퍼스 전체 크기"에
비례하면 안 된다.**

즉 앱의 어떤 상호작용도 노트북의 총 노트 수 `N` 이나 총 첨부 수 `A` 에 선형(또는 그 이상)으로
느려져서는 안 된다. 허용되는 O(N) 은 (a) 사용자가 명시적으로 기다림을 감수하는 배경 작업(시맨틱
검색 = 수초 허용, 전체 export/backup = 진행률 있는 일회성)뿐이고, 그 외 모든 hot path
(앱 기동, 폴더 열기, 타이핑, 노트 선택, 필터 조작)는 코퍼스 크기와 **무관**해야 한다.

## 1. Scale target & budget

| 축 | 목표 규모 | 예산(budget) |
|---|---|---|
| 노트 수 `N` | 100,000+ | 기동·폴더열기·타이핑·필터: 코퍼스 크기 무관(체감 즉시) |
| 첨부 수 `A` | 1,000,000+ (노트당 ~10) | 첨부는 활성 노트 것만 로드 |
| 임베딩 청크 | ~300k–500k (노트당 3–5) | 시맨틱 검색: **수초 허용**(사용자 승인). 단 "매 검색 전체 재청킹"은 불가 |
| export/backup | 다 GB | 일회성 배경 작업, 진행률 표시, 스트리밍·원자적 |

## 2. Why the current architecture doesn't scale

앱은 **"노트북 전체를 프론트로 통째 로드하고 클라이언트에서 필터·렌더"** 하는 모델이다.
개인 노트(수천) 규모에는 이상적이지만 10만에서는 무너진다. 그리고 **UI 가 단일 노트북만
노출**(`db/schemas/notes.sql`)하므로 `workspace_id` 술어는 사실상 전체 행(≈100%)을 매치한다 —
따라서 이 문제는 **인덱스로 풀리지 않고**, 페이지네이션·지연로드·가상화·incremental 처리가
본질적 해법이다.

## 3. What breaks first (심각도 순, file:line)

### P0 — 아키텍처: 전체 코퍼스 로드 + 변경마다 재로드
- `repo/folders.rs::list` (folders.rs:73–181): 노트북 **전체 노트**(:132) + **전체 태그
  조인**(:102) + **전체 첨부 has_image 스캔**(:119) 을 LIMIT 없이 한 번에 반환.
- `stores/notes.ts::loadTree` (notes.ts:213): 위 전량을 `notesByFolder` 에 상주. 게다가
  `toggleFavorite`/`setTags`/`setRegion`/`setStatus`/`folder_set_open`/`folder_create`
  (notes.ts:307,331,359,386; NoteTree.tsx:95,148) **모든 변경마다 loadTree() 재다운로드**.

### P0 — 벡터: 매 검색마다 전체 코퍼스 재청킹 + N+1 (REMOVED — 2026-07-29 owner 결정으로
  semantic/hybrid 검색 서브시스템 전체 삭제, 이 병목 자체가 코드에서 사라졌다. 아래는 삭제 전
  감사 기록으로만 남긴다.)
- `repo/search.rs` semantic/hybrid (search.rs:140,181) 이 코사인 이전에
  `vector::reindex_with_config(full=false)` 를 무조건 호출.
- `repo/vector.rs::prepare_reindex` (vector.rs:489–562): 전체 노트를 순회하며 `split_windows`
  (vector.rs:67, 본문 전체 `chars().collect()`)로 **재청킹**하고, `existing_chunks`
  (vector.rs:457) 를 **note 당 1쿼리**(N+1)로 실행 → 10만 노트면 검색 1회에 10만 SQL 왕복 +
  전체 텍스트 재해시. 재임베딩(네트워크)만 스킵될 뿐 나머지는 매 검색 지불. 코드 주석도
  follow-up 부채로 인정(vector.rs:515–518).

### P0 — 렌더: 가상화 없음 → **해결**(react-window 가상화 + 상주 코퍼스 제거)
- `NoteTree.tsx:1` 은 `export { NoteTree } from "./notetree/index";` 한 줄이 됐고, 실제 트리는
  `notetree/index.tsx:2` 가 react-window 의 `List` 로 `TreeListRow` 를 가상화한다. 폴더를 열 때
  읽는 범위는 `notetree/windowLoad.ts` 가 제한한다.
- 내부노트 링크 피커가 `Object.values(notesByFolder).flat()` 을 통째로 렌더하던 자리는
  `attachments/InternalNotePicker.tsx` 로 대체됐다 — 상주 코퍼스 없음(:8–9, 빈 질의는
  `note_query`, 나머지는 `search_notes`), 하드 캡 `INTERNAL_PICKER_LIMIT = 50`(:22).
- 태그 클라우드(`expanded/TagsExpandedCloud.tsx:2`)와 갤러리(`expanded/GalleryExpanded.tsx:2`)도
  같은 `List` 로 가상화돼 있다.
- 불변식: **좌측 패널에서 코퍼스 크기만큼 행을 만드는 뷰가 다시 생기면 안 된다.** 새 뷰는
  `List` 위에 올리고, 목록을 여는 피커는 캡을 갖는다.

### P0/P1 — 검색: LIMIT 없음 + 본문 LIKE 풀스캔 → **해결**(캡 + 조인 형태 + 통계 위생)
- `year_scoped_ids`/`fts_ids`/`like_ids` 의 LIMIT 전무는 SEARCH_RESULT_CAP / LIKE_SCAN_CAP 으로 해결됨.
- 그러나 캡만으로는 부족했다. 진짜 비용은 스캔이 아니라 **조인 플랜**이었다 — 10k 노트 실측:
  `MATCH '"les"'` 62,279ms, `LIKE '%de%'` 62,122ms. `notes_fts f JOIN notes n ON n.id = f.note_id`
  에서 플래너가 notes 를 PK 가 아니라 `idx_notes_year_alive` range scan 으로 안쪽 루프에 놓아
  O(매치수 × 노트수). ORDER BY 가 LIMIT 보다 앞서므로 캡은 출력만 자르고 작업량을 못 줄인다.
- 원인은 `sqlite_stat1` 오염이다. V19/V20 의 `ANALYZE notes` 가 **신규 설치의 빈 DB** 에서 돌아
  "이 인덱스는 0행" 통계를 영구히 남긴다. 동일 DB·동일 쿼리 단일 변수 실측:
  정상 통계 122ms / 통계 없음 127ms / **zero-row 통계 63,148ms**(통계가 없는 것보다 나쁨).
- 조치 두 가지 — (a) 두 쿼리를 semi-join(`n.id IN (SELECT note_id FROM notes_fts …)`)으로 고정해
  플랜 선택 여지를 제거, (b) `db::scrub_zero_row_stats` 가 부팅마다 zero-row 행을 지우고
  `ANALYZE sqlite_schema` 로 플래너 캐시를 리로드(DELETE 만으로는 같은 연결에서 무효),
  종료 시 `PRAGMA analysis_limit=400; PRAGMA optimize` 로 실제 통계 갱신.
- 실앱 IPC 재측정(10k 노트): les 44ms · tion 50ms · de 40ms · mission 23ms · attachment 23ms.
  불변식: **sqlite_stat1 은 정확하거나 부재해야 하며 zero-row 여서는 안 된다.** 새 마이그레이션을
  `ANALYZE` 로 끝내면 신규 설치에서 이 결함이 재발한다.

### 규칙 — 무거운 커맨드는 `async` + `spawn_blocking` 이어야 한다 (실측 근거)
`AppState.db` 단일 Mutex 를 놓는 것만으로는 부족하다. Tauri 는 **동기 커맨드를 직렬로 실행**하므로
DB 를 전혀 건드리지 않는 커맨드조차 뒤에 줄 선다. 첨부 썸네일(4000x3000 6장, 디코드+인코드) 실측:

| | 유휴 | 무거운 동기 커맨드 동시 실행 |
|---|---:|---:|
| `attachments_base_dir` (락 미사용) | 2 ms | **1,837 ms** |
| `note_query` | 9 ms | 309 ms |

`#[tauri::command] async fn` + `tauri::async_runtime::spawn_blocking` 으로 옮긴 뒤 각각 **2 ms / 11 ms**.
CPU 를 수백 ms 이상 쓰는 커맨드(이미지 디코드, 파싱, 압축)는 이 형태를 지켜야 한다 —
`commands/attachments.rs::attachment_thumbs` 가 기준 구현이다.

### 규칙 — 타일 `<img>` 는 원본 래스터를 가리키지 않는다 (실측 근거)
Chromium 은 디코드한 비트맵을 JS 가 건드릴 수 없는 캐시에 들고 있다 — `<img>` 를 전부 떼고 GC 를
강제해도 298 MB 중 37 MB 만 돌아왔다. 4000×3000 한 장을 한 프레임만 가리켜도 ~37 MB 가 남는다.

| 첨부바 타일이 가리키는 것 | 증가분 |
|---|---:|
| 원본 | +298 MB |
| 썸네일, 없으면 원본 폴백 | +181 MB |
| 썸네일, 없으면 플레이스홀더 | **+19 MB** |

규칙의 단일 소유자는 `attachments/tileImage.ts:18` 의 `pickTileImageRel` 이다 — svg 만 원본을
쓰고(디코드 불가·벡터), 썸네일을 모르는 동안에는 아무것도 그리지 않는다. 썸네일 규격은 긴 축
256px·JPEG q80(1.71 MB 원본 → ~31 KB, 생성 ~300 ms, 재조회 1 ms). 사본을 만들지 말 것 — 한쪽만
"고쳐서" 원본 폴백이 돌아오는 게 이 결함의 재발 경로다.

### 규칙 — 갤러리 읽기는 상한이 있고 정렬을 인덱스에서 가져온다 (실측 근거)
- `attachment_query`(`repo/attachment_query.rs:15–17`)는 기본 60행·최대 300행, total 을 세지
  않는다. 클라이언트는 짧은 페이지가 올 때까지 페이징한다.
- 전체 종류 페이지는 `kind IN (…5종…)` 이 아니라 `kind <> 'internal'` +
  `INDEXED BY idx_attachments_created` 다(`:54–61`). `IN` 형태는 종류마다 range 가 하나씩이라
  `idx_attachments_kind_created` 에서 순서를 가져올 수 없고, SQLite 가 LIMIT 전에 전부 정렬한다
  — 3만 첨부 실측 373 ms → 93 ms. `INDEXED BY` 는 의도적이다: 부팅 직후 통계가 없는 상태
  (`db::scrub_zero_row_stats`)에서 플래너가 notes 부터 몰면 정렬이 되돌아온다.

### P1 — 키 입력마다 O(N) → **해결**(카운터 참조 + 열린 탭만 순회)
- `YearFilter.tsx:18` 은 `Object.values(notesByFolder).flat().length` 대신 스토어가 유지하는
  `totalNotes` 를 읽는다(:15–17 주석).
- `TabBar.tsx:38–48` 의 `titleById` 는 코퍼스 전체 Map 을 다시 만들지 않고 `openTabs` 만
  순회한다(:34–37 주석). 제목을 칠 때마다 여전히 재실행되지만 비용은 O(열린 탭)이다 —
  남은 잔여물이고, 코퍼스에 비례하지 않으므로 스케일 항목에서는 내려온다.

### P1 — 매 부팅 전체 DB 백업 + 스택된 O(N)
- `db/mod.rs::snapshot_backup` (mod.rs:308) 이 **매 bootstrap**(mod.rs:106) 전체 DB 파일 복사 +
  3개 보관 = 시작 지연 코퍼스 비례, 디스크 4배. import replace/db_reset 에서도.
- 변경 1회에 memoized 전체스캔 ~7개 동시 재실행(search bounds/yearCounts, tag/region/status
  counts, allTags/allRegions, notesById, context-menu find) — `notesByFolder` 참조가 loadTree
  마다 새로 생겨 전부 트리거.

### P1 — related() 전체 GROUP BY
- `repo/notes.rs::related` (notes.rs:198): LIMIT 있어도 노트북 전체를 GROUP BY 후 정렬 —
  스캔 비용은 O(N). related 뷰 열 때마다.

### P2 — N+1 / 전송
- `folders.rs::files` (:311) note당 attachment 쿼리, `export.rs::export_folder` (:52) note당 5쿼리,
  `attachments.rs::orphan_cleanup` (:340) 부팅시 note당 1쿼리.
- `export.rs::dump/export_all` (:308,328) 전체 번들을 메모리 JSON 문자열로(스트리밍 아님),
  첨부 동기 복사 + **스테이징 없음**(export 중 크래시 = 반쪽 폴더).

### ✅ 이미 양호 — 건드리지 말 것
- 첨부 FS: `attachments/{note_id}/{short8}-{name}` (attachments.rs:98) **note_id 샤딩** — 100만
  파일도 플랫 디렉터리 문제 없음. `orphan_cleanup` 은 최상위만 read_dir(O(notes)).
- `cosine_topk` (vector.rs:113, REMOVED — vector.rs 삭제됨): 브루트포스지만 **행 단위
  스트리밍** — 전체 벡터 행렬을 RAM 에 상주시키지 않음(한 번에 한 벡터). 사용자 허용범위(수초).
  재읽기만 캐시 부재.
- `notes.rs::note_summaries_map` (:90): 3개 고정 쿼리로 **배치**(N+1 아님). 모범 패턴 —
  export.rs 가 따라야 할 형태.
- `fts.rs::fts_upsert`: Wave PERF(L-6, `80643ab7`)에서 `notes_bigram_map` rowid 조회로 FTS5 전체 스캔 제거 완료 (10k 노트 기준 15.06ms → 2.11ms, 약 7.1배 개선). 단일노트 편집 O(1) — 양호.

## 4. Policy (레이어별 규칙)

### A. 데이터 로딩 — "경량 인덱스는 전량, 무거운 것은 지연" (B안, 10만 타깃 권장)

> 결정(2026-07-23): 10만 타깃에는 **완전 서버사이드 페이지네이션(C안)이 과설계**다. 노트당 경량
> 필드 ≈100B → 10만 = ~10MB(메모리 무문제), 10만 원소 typed 배열 `.filter` ≈1–5ms(디바운스
> 검색에 무의미). 즉 "메모리에 다 두고 클라 필터"는 **경량 필드만 + 가상화**할 때 10만까지 여전히
> 옳다. 진짜 killer는 데이터 양이 아니라 무거운 페이로드·가상화 부재·재로드·키입력 O(N)다.
> 완전 페이지네이션(C안)은 100만+ 성장 시 Phase 2로 미룬다.

1. `folder_list`(및 로드 경로)는 **경량 요약만** 반환: `id, folder_id, title, year, is_favorite,
   status, region, icon`. 무거운 것(태그 리스트, has_image, 섹션 본문, 첨부)은 **제외** →
   활성 노트 것만 별도 로드. 태그/지역/상태 **카운트**는 백엔드 aggregate(A4)로.
2. 변경(favorite/tag/region/status/rename)은 **전체 loadTree 금지** → 영향받은 노트만 스토어에서
   로컬 패치. 폴더 카운트는 델타 조정.
3. 스토어 자료구조: `Record<folderId, Note[]>` 를 **`Map<noteId, NoteSummary>` 인덱스**로
   보강(폴더별은 id 리스트만). `Object.values().flat()`/`.find()` 를 인덱스 조회로 대체 —
   특히 per-keystroke 경로.
4. 집계(태그·지역·상태 카운트, 연도 bounds·히스토그램)는 **백엔드 aggregate 쿼리**로
   (`SELECT year, COUNT(*) ... GROUP BY year`, 인덱스 활용) 또는 경량 인덱스 위 클라 계산 중
   더 싼 쪽. 무거운 조인(태그 카운트)은 백엔드로. *(주의: 2026-07-23 추가 `search.yearCounts`
   히스토그램은 현재 전량 notesByFolder 의존 — 경량 인덱스엔 year 가 있으므로 클라 유지 가능하나,
   무거운 태그 카운트는 백엔드로 이관.)*
5. **완전 페이지네이션(C안)** — `folder_list` 가 폴더 메타+count 만, 노트는 확장 시 keyset
   커서(`(year,id) > ? LIMIT n`)로 — 는 **경량 인덱스도 감당 못 하는 100만+ 규모의 Phase 2**로 둔다.

### B. 렌더링 — "보이는 행만"
5. NoteTree(폴더별 노트), 검색결과, FolderFilesModal 을 **가상화**(react-window 또는
   @tanstack/react-virtual — 오프라인 자립 번들 확인). 보이는 행 + 오버스캔만 DOM.
6. 내부노트 링크 피커(AttachmentsBar.tsx:545)는 전체 목록 금지 → **디바운스 백엔드 검색**
   (`search_notes` 재사용, LIMIT).

### C. 검색 — "상위 N + 커서"
7. `search_notes` 모든 경로에 **LIMIT + total**(또는 keyset 커서). UI 는
   "상위 200 / 45,213 — 좁혀보세요" + 결과 리스트 가상화.
8. `like_ids` 는 LIMIT 부여 + 폴백 범위를 title/tag 로 축소(전체 body LIKE 지양).

### D. 벡터/시맨틱 — "재청킹은 변경분만, 코사인은 그대로"
9. 매 검색의 reindex 를 **incremental 로 진짜 만들기**:
   - `existing_chunks` 를 배치(`WHERE note_id IN (...)` 후 Rust 에서 group) — N+1 제거.
   - **dirty-check 단락**: 노트북 `MAX(notes.updated_at)`(또는 dirty set)을 저장해두고,
     지난 검색 이후 변화 없으면 prepare 전체를 스킵.
10. `cosine_topk` 브루트포스는 **유지**(사용자 허용). 성장 시 티어: 인메모리 캐시 행렬(쓰기시
    무효화) 또는 `sqlite-vec`/HNSW ANN. `find_similar` 도 동일.

### E. 백업/전송 — "부팅에 전체복사 금지, export 는 스트리밍·원자적"
11. 부팅 백업을 **integrity check + 크기/시간 트리거 스냅샷**으로. 매 부팅 전체 DB 복사 폐지.
12. export 는 `serde_json::to_writer(BufWriter)` 스트리밍 + 첨부 스테이징(temp→rename, import
    replace 가 이미 쓰는 패턴) + 진행률. N+1(export/folder-files/orphan)은 batch-by-ids 로.

### F. 인덱스 (server-side 필터 이관의 전제)
13. 필터를 SQL 로 옮기면(정책 A4/C) 필요: `notes(status)`, `notes(region)`,
    `note_tags(tag_id)`, 복합 `notes(folder_id, deleted_at, year, id)`(keyset 커버링).

## 5. Phased roadmap

**Phase 0 — 억제형 quick wins (아키텍처 미변경, 즉효)**
- D9 벡터 dirty-check + existing_chunks 배치 → 시맨틱 검색을 스케일에서 가능하게.
- C7/C8 검색 LIMIT + like_ids 축소.
- P1 키입력 O(N) 제거(YearFilter 카운트를 스토어의 값으로, TabBar titleById 의존성 정리).
- E11 부팅 백업 정책 전환.
- P2 N+1 배치(export/folder-files/orphan_cleanup).
- 효과: 가장 아픈 벡터/검색/타이핑/부팅을 큰 리팩터 없이 완화.

**Phase 1 — 아키텍처 핵심, B안 (10만에서 상수시간 UI)**
- A1–A4 **경량 요약만 로드**(무거운 페이로드 제외) + 스토어 `Map` 인덱스화 + 변경시 부분갱신 +
  무거운 집계(태그 카운트) 백엔드 이관.
- B5/B6 NoteTree·검색결과·내부링크 피커 **가상화**(react-window). 내부링크 피커는 디바운스
  백엔드 검색.
- F13 인덱스 추가(server-side 필터/aggregate 전제).
- 효과: 10만 노트에서 기동·폴더열기·필터·타이핑이 코퍼스 크기 무관. **완전 페이지네이션 없이**
  경량 인덱스+가상화로 달성 — 복잡도(커서·부분상태·캐시무효화) 회피.

**Phase 1 진행 (2026-07-23):**
- ✅ `folder_list` 경량화: `tag_names=[]` / `has_image=false`. 태그 맵은 `note_tags_index` 로 분리.
  단일 노트 이미지는 `attachments::has_image_for_note`. 검색/related 는 기존
  `note_summaries_map` 유지.
- ✅ 프론트 `loadTree`: 경량 트리 먼저 → 태그 보강. `toggleFavorite`/`setTags`/`setRegion`/
  `setStatus`/`folder_set_open` 은 전체 재다운로드 대신 `patchNoteSummary`/`patchFolder`.
- ✅ NoteTree + 검색결과: `react-window` v2 `List` 로 가상화(평탄 행 모델).
- ✅ 100k release 실측: `folder_list` **1830ms → 594ms** (~3×). `note_tags_index` 1156ms 는
  전체 loadTree 시 1회(부분갱신 경로에서는 재호출 없음).
- ⏳ 태그 카운트 백엔드 aggregate, 내부링크 피커 디바운스 검색, F13 인덱스.

**Phase 2 — 성장 대비 (100만+ 또는 필요 입증 시)**
- A5 완전 서버사이드 페이지네이션(C안, keyset). D10 sqlite-vec/ANN 또는 캐시 행렬.
  E12 export 스트리밍. related() 연도윈도우 prefilter. materialized 카운터.
- 원칙: 전부 **YAGNI** — 경량 인덱스(Phase 1)가 한계에 닿았다는 측정(§6) 후에만.

## 6. Verification (스케일은 측정으로 증명)

정책 준수는 **재현 가능한 벤치마크**로 검증한다:
- **Seed harness**: 테스트 전용 커맨드/스크립트로 N=100k 노트 + A=1M 첨부 메타 생성(랜덤 연도·태그·
  본문). Rust 통합 테스트 또는 dev-only seed.
- **측정 지표(예산 대비)**: 기동→상호작용 가능 시간, 폴더 열기 프레임, 타이핑 입력지연(p95),
  시맨틱 검색 벽시계, 부팅 백업 시간, 프로세스 RSS. Phase 별 before/after 기록.
- **회귀 가드**: 각 Phase 의 핵심 불변식을 테스트로(예: "folder_list 응답 행 수는 폴더 수에
  비례하고 노트 수와 무관", "N개 노트에서 2회 연속 시맨틱 검색의 2번째는 reindex 스킵").

## 7. Open questions (구현 전 확정 필요)
- 페이지 크기(50? 100?)와 무한스크롤 vs 페이지 버튼.
- 가상화 라이브러리 선택(오프라인 번들 제약 — @fontsource 처럼 자립 필요).
- ANN 도입 시점(Phase 2 트리거 기준: 청크 수 임계?).
- 집계(카운트/히스토그램) 이관 시 실시간성 vs 캐시 허용 범위.
