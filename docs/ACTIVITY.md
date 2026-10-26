# Activity — 활동 이력 · 노트 스냅샷 (SSOT)

기기 로컬 감사 로그(활동 이력)와 에디터 자동저장 캐시(노트 스냅샷)를 다루는 별도 OS 창 하나를
설명한다. 이 문서는 `specs/features/activity.yaml`(F-A01) + `specs/features/snapshots.yaml`
(F-SN01)의 디테일 확장이며, 두 스펙과 실제 shipped 코드가 어긋나는 지점은 코드를 따른다.

## 1. 개요 — 왜 한 문서인가

활동 이력(activity_log)과 노트 스냅샷(note_snapshots)은 DB 테이블도, 보존 정책도, 데이터
성격도 서로 다른 별개 기능이다. 그런데도 한 문서로 묶는 이유는 셋:

1. **같은 창에서 산다** — 둘 다 `#/activity` 라우트(활동 창) 하나의 화면이다. 활동 이력 목록에서
   노트를 클릭하면 그 노트의 스냅샷 목록으로 드릴다운하는 한 개의 UI 흐름
   (`src/components/ActivityHistoryPanel.tsx`)으로 구현돼 있다.
2. **복원 경로가 활동 이력을 씀** — 스냅샷을 복원하면 그 자체가 `KIND_RESTORE` 활동 이벤트로
   기록된다(`src-tauri/src/repo/snapshots.rs::restore` 끝부분에서
   `crate::repo::activity::record_for_note`를 직접 호출). 즉 스냅샷 기능의 산출물 하나가 활동
   이력의 데이터 소스이기도 하다.
3. **"별도 OS 창 + flushAll 뒤 이벤트 브리지 복원"이라는 같은 아키텍처 제약을 공유** — 아래 4절.

**스펙과 코드가 다른 지점(코드 우선)**: `specs/features/activity.yaml`은 `verify.vitest`로
`src/App.activityButton.test.tsx`를 지정하지만, 실제로 App.tsx에서 창을 여는 버튼 클릭 동작을
검증하는 지점이라는 뜻이고 목록/드릴다운 UI 자체의 테스트는 별도(`ActivityHistoryPanel` 관련
컴포넌트 테스트)에 있다. 두 spec 파일 모두 "복원 순서 불변식"이나 이벤트 브리지 이름을 명시하지
않는다 — 그 계약은 코드 주석(`activityWindowBridge.ts`, `specs/commands/snapshots.yaml`)에만
있으며, 이 문서 4절이 그것을 옮겨 적은 것이다.

## 2. 동작 방식

### 2.1 활동 이력 (activity_log)

- **기록 시점**: 노트 생성/삭제/편집/스냅샷 복원/가져오기 시 `repo/activity.rs::record` (또는
  트랜잭션 합류용 `record_tx`)가 이벤트 한 줄을 남긴다. `kind`는 `create` / `delete` / `edit` /
  `restore` / `import` 다섯 종류(`KIND_*` 상수).
- **삭제돼도 남는다**: `note_id`에는 FK가 없다(의도적). 노트를 soft-delete 후 완전 purge해도
  `activity_log` 행은 그대로 남고, `note_alive`만 `false`로 바뀐다 —
  `delete_note_leaves_delete_event_row_no_fk` 테스트가 이를 고정한다. 반면 `note_snapshots`는
  `notes(id)`에 `ON DELETE CASCADE`라 노트가 사라지면 스냅샷도 같이 사라진다 — 그래서 delete
  이벤트를 스냅샷 테이블 위에 얹지 않고 별도 테이블로 설계했다(V33 마이그레이션 주석).
- **보존**: `ACTIVITY_RETENTION_DAYS = 7` 또는 `ACTIVITY_MAX_ROWS = 2000`(노트북당, 내부 컬럼
  `workspace_id` 기준) 중 먼저 걸리는 쪽. 별도 백그라운드 잡이 아니라 매 `record`/`record_tx`
  호출과 **같은 트랜잭션 안에서** age-prune → count-prune 순으로 실행된다.
- **노트북 삭제 시 CASCADE**: `activity_log.workspace_id`가 `workspaces(id)`를
  `ON DELETE CASCADE` 참조 — 노트북이 지워지면 그 활동 로그 전체가 함께 지워진다.
- **조회**: `activity_list` 커맨드가 `note_alive`(현재 살아있는 노트인지) 와 `note_title`(살아
  있으면 현재 제목, soft-delete/purge면 null)을 함께 계산해 반환. `note_alive`는 soft-delete만
  보고 `archived_at`은 보지 않는다 — 보관된 노트도 여전히 정상적으로 열리는 노트라 활동 항목도
  클릭 가능해야 한다는 판단(W7-f, `repo/activity.rs` 주석).
- **디스플레이**: `ActivityHistoryPanel`은 목록을 최신순으로 렌더링하고, `note_alive &&
  note_id`인 항목만 클릭해 노트를 열 수 있게 한다(그 외엔 `summary` — 이벤트 당시 이름 — 만
  보여준다).

### 2.2 노트 스냅샷 (note_snapshots)

- **캡처 주기**: 노트가 열려 있는 동안 60초마다(`src/lib/noteSnapshots.ts::SNAPSHOT_INTERVAL_MS`)
  프론트 타이머가 `note_snapshot_capture`를 호출한다. Rust 쪽에는 별도 타이머가 없다 — 전적으로
  프론트 스케줄러(`wireSnapshotScheduler`, `stores/notes.ts`에서 부팅 시 1회 연결)가 소유한다.
- **더티 플래그로 무의미한 캡처를 건너뜀**: `markSnapshotDirty()`가 세팅되지 않으면(마지막 캡처
  이후 아무 변경 없음) 60초 틱이 와도 캡처를 스킵한다. 본문 수정(`updateSectionBody`)뿐 아니라
  섹션 이름 변경/추가/삭제/재정렬도 각각 `EditorPanel`/`SectionTabBar`에서 성공 후
  `markSnapshotDirty()`를 호출한다.
- **틱 안에서 먼저 flushAll, 그다음 dirty 확인**: 매 60초 틱마다 `flushAll()`(에디터 700ms
  본문 디바운스를 먼저 DB에 반영)을 실행한 뒤에야 `snapshotDirty`를 읽고 소비한다. 순서를
  바꾸면(캡처 전에 dirty부터 지우면) `flushAll()`이 유발한 `markSnapshotDirty()` 호출을 그 틱이
  놓치고 다음 틱으로 영원히 미루게 된다(`noteSnapshots.ts` 주석).
- **노트 전환/닫기 시 1회 추가 캡처**: `wireSnapshotScheduler`가 `activeNote` 변화를 구독,
  이전 노트가 dirty였으면 전환 즉시 한 번 더 캡처한 뒤 새 노트로 타이머를 재시작한다 — "노트가
  열린 동안만 기록"이 여기서 성립한다.
- **캡처 시 30분 초과 프루닝**: `repo/snapshots.rs::capture_internal`이 INSERT 직후 같은
  트랜잭션에서 `taken_at < now - 30min`인 그 노트의 행을 지운다(`SNAPSHOT_WINDOW_MINUTES`).
  하루 종일 켜둔 노트라도 스냅샷은 노트당 최대 ~30행.
- **트리 뷰**: `activity_list` → `note_snapshot_list`(그 노트의 스냅샷 목록, `taken_at` 최신순)
  → `note_snapshot_get`(선택한 스냅샷의 섹션별 본문 미리보기)까지 `ActivityHistoryPanel` 안에서
  드릴다운으로 이어진다.
- **복원**: `note_snapshot_restore`가 section_id 매치 기준으로 병합한다 — 지금도 있는 섹션은
  `body_md`만 교체(이름/kind는 유지), 스냅샷엔 있었지만 지금 없는 섹션은 title/kind/body_md
  그대로 재생성, 지금 있지만 스냅샷엔 없는 섹션은 손대지 않고 개수만 집계
  (`restored_count`/`recreated_count`/`extra_count`). 복원 자체가 되돌릴 수 있도록, 되돌리기
  직전 현재 상태를 `capture_internal`로 한 번 더 찍어 `safety_snapshot_id`로 반환한다.

## 3. 별도 OS 창

`ActivityWindowApp`(`src/activity/ActivityWindowApp.tsx`)은 `#/activity` 라우트로 뜨는
**독립 웹뷰 창**이다 — 메인 창과 같은 프로세스지만 별개의 React 트리·zustand 스토어를 가진 다른
top-level 창이다. `src-tauri/src/activity_window.rs::ensure_activity_window`가
`aux_window.rs::ensure_owned_window`(설정 창·AI 히스토리 창과 공용)로 생성하며, 라벨은
`"activity"`(`capabilities/default.json`의 `windows` 배열에 등록돼 있다). 창을 여는 진입점은
`App.tsx::openActivityWindow()` → `activity_window_open` 커맨드(`commands/window.rs`) → 이미
떠 있으면 unminimize+focus, 없으면 신규 생성(idempotent).

별도 창인 이유(`aux_window.rs` 헤더 주석): 메인 창이 투명 창이라 WebView2가 CSS backdrop-blur를
화면에 반영하지 않는데, 네이티브 Acrylic 효과는 투명 창을 전제로 하지 않는 별도 창에서만 걸 수
있다 — 그래서 오래 열어두고 뒤 화면을 비추는 표면(설정/활동/AI 히스토리)은 전부 별도 Acrylic
창으로 뗐다. `parent()`가 아니라 `owner()`로 메인 창에 붙인다 — Tauri 2의 `parent()`는 WS_CHILD
자식 창이라 실제로 URL 로드조차 되지 않는 문제가 있었다(2026-08-14 확인).

노트 트리·에디터는 이 창에 부팅되지 않는다 — 노트를 열거나(펫 창과 공유하는 `pet-open-note`
이벤트를 재사용) 스냅샷을 복원하는 실제 동작은 메인 창에 위임한다(창끼리 zustand 스토어가
분리돼 있고, 복원 전 `flushAll()`은 에디터가 실제로 있는 웹뷰에서만 의미가 있기 때문).

## 4. 복원의 이벤트 브리지 & flushAll 순서 불변식

활동 창에서 스냅샷 복원 버튼을 누르면, 복원은 활동 창이 아니라 **메인 창**에서 실행된다.
경로는 `src/lib/activityWindowBridge.ts` + `src/activity/ActivityWindowApp.tsx`:

1. 활동 창(`ActivityWindowApp.tsx::onRestoreSnapshot`)이 결과 이벤트 리스너를
   `"activity-restore-snapshot-result"`에 먼저 등록한 뒤(구독 전에 응답이 도착하는 경합을
   피하기 위해), `"activity-restore-snapshot"` 이벤트를 `{ id }` 페이로드로 emit한다.
2. 메인 창(`App.tsx` 부팅 시 연결된 `listenActivityWindowBridge()`)이 이 이벤트를 받아
   `handleActivityRestoreSnapshot`을 실행한다: **`await flushAll()` → `note_snapshot_restore`
   호출 → `useNotesStore.getState().reloadActive()`**.
3. 메인 창이 성공/실패 여부를 `"activity-restore-snapshot-result"` 이벤트로
   `{ id, ok, error? }` 형태로 되돌려준다.
4. 활동 창은 이 결과를 기다렸다가 `ok === false`면 `restoreError` state를 세팅 — 창 상단에
   `role="alert"` 배너(`data-testid="activity-restore-error"`, `ActivityWindowApp.tsx` 14~35행)
   로 에러 메시지(`t("activity.restore_failed", ...)`)를 띄운다. 이 배너는 최근에 추가된 동작으로,
   그 전에는 emit이 fire-and-forget이라 "복원 중" 표시가 실제 완료 전에 풀리고, 실패해도 에러
   토스트는 가려진 메인 창에서만(활동 창엔 안 보이게) 떴었다.

**flushAll이 먼저인 이유(순서 불변식)**: `note_snapshot_restore`는 DB의 `sections.body_md`를
스냅샷 시점 값으로 덮어쓴다. 그런데 메인 창 에디터에는 아직 DB에 반영되지 않은 최근 타이핑이
700ms 디바운스(`registerFlush`)로 대기 중일 수 있다. `flushAll()` 없이 먼저 복원부터 하면, 그
직후 디바운스가 만료되며 미저장 입력이 DB에 쓰이고 방금 끝낸 복원 결과를 덮어써 버린다 — 즉
복원이 조용히 유실된다. 그래서 순서는 반드시 **"에디터의 미저장 변경을 먼저 DB에 반영(flush)
→ 그 위에 스냅샷으로 덮어쓰기(restore)"**여야 한다. 이 불변식은 두 군데에 명문화돼 있다:
`specs/commands/snapshots.yaml`(`note_snapshot_restore`의 notes: "Frontend caller must
flushAll() ... BEFORE calling this")와 `activityWindowBridge.ts` 자신의
`handleActivityRestoreSnapshot` 구현(`await flushAll(); await call("note_snapshot_restore", ...)`
순서 그대로).

같은 불변식이 60초 자동 캡처 틱에도 적용된다(2.2절) — 다만 그쪽은 "먼저 flush해서 캡처가 최신
본문을 담게" 하려는 목적이고, 복원 쪽은 "먼저 flush해서 나중에 그 값이 복원을 덮어쓰지 않게"
하려는 목적으로 방향이 반대다. 두 경우 모두 `flushAll()`이 데이터 쓰기 순서의 앞자리를 차지한다는
점은 같다.

## 5. 데이터 모델

### `activity_log` (V33, `src-tauri/src/db/migrations.rs`)

```sql
CREATE TABLE activity_log (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id      TEXT,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_activity_log_ws_created ON activity_log(workspace_id, created_at);
```

`note_id`에 FK가 없는 것이 의도적 설계(2.1절). `specs/db/schemas/`에는 이 테이블 전용 `.sql`
파일이 없다 — 스키마 정의가 마이그레이션 상수(`V33_SQL`) 안에만 있다.

### `note_snapshots` (V31, `src-tauri/src/db/migrations.rs`)

```sql
CREATE TABLE note_snapshots (
  id       TEXT PRIMARY KEY,
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL,
  payload  TEXT NOT NULL
);
CREATE INDEX idx_note_snapshots_note_taken ON note_snapshots(note_id, taken_at);
```

`payload`는 그 노트의 당시 섹션들을 담은 JSON 배열(`PayloadSection { section_id, title, kind,
body_md }`, `repo/snapshots.rs`) — `title`/`kind`는 `sections.name`/`sections.kind`를 그대로
옮긴 것. `note_snapshots` 역시 이 테이블만의 전용 `.sql` 파일은 없다.

### 동기화·내보내기 대상에서 제외

두 테이블 모두 **기기 로컬 전용**이며 명시적으로 export/import 번들과 sync HTTP 표면 바깥에
있다: `repo/transfer/export.rs`는 `notes → sections/sources/attachments`만 순회하고 이 두
테이블은 아예 참조하지 않으며, `specs/commands/activity.yaml`·`specs/commands/snapshots.yaml`의
모든 커맨드가 `http: false`다.

## 6. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| 활동 창 루트(별도 OS 창) | `src/activity/ActivityWindowApp.tsx` |
| 활동/스냅샷 목록·드릴다운 UI | `src/components/ActivityHistoryPanel.tsx` |
| 복원 이벤트 브리지(메인 창 리스너) | `src/lib/activityWindowBridge.ts` |
| 스냅샷 60초 캡처 스케줄러(프론트) | `src/lib/noteSnapshots.ts` |
| 활동 로그 repo(기록/보존/조회) | `src-tauri/src/repo/activity.rs` |
| 스냅샷 repo(캡처/조회/복원) | `src-tauri/src/repo/snapshots.rs` |
| 창 생성 로직 | `src-tauri/src/activity_window.rs`, `src-tauri/src/aux_window.rs` |
| 창 열기 커맨드 | `src-tauri/src/commands/window.rs::activity_window_open` |
| 메인 창 진입 버튼 | `src/App.tsx::openActivityWindow` |
| DB 스키마(마이그레이션) | `src-tauri/src/db/migrations.rs` (V31 `note_snapshots`, V33 `activity_log`) |
| IPC 계약 | `specs/commands/activity.yaml`, `specs/commands/snapshots.yaml` |
| 기능 카탈로그 | `specs/features/activity.yaml`(F-A01), `specs/features/snapshots.yaml`(F-SN01) |
| 창 라벨/capability 등록 | `src-tauri/capabilities/default.json`(`windows: [..., "activity", ...]`) |

## 7. 알려진 한계 / 결정

- **활동 로그는 버전 히스토리가 아니다** — `KIND_EDIT` 등은 "무언가 편집됐다"는 이벤트일 뿐,
  편집 diff나 이전 내용을 담지 않는다. 편집 내용 자체의 시점별 복원은 스냅샷(`note_snapshots`)의
  역할이고, 둘은 보존 기간·삭제 시 동작이 서로 다르게 설계돼 있다(2.1절).
- **스냅샷은 30분 롤링 캐시일 뿐 장기 버전 관리가 아니다** — `SNAPSHOT_WINDOW_MINUTES = 30`은
  오너 스펙에 못박힌 고정값이며 사용자가 바꿀 수 있는 설정이 아니다(`repo/snapshots.rs`의
  `ponytail:` 주석). 늘리려면 이 상수 자체를 바꿔야 한다.
  노트를 하루 종일 열어둬도 노트당 최대 ~30행으로 상한이 걸린다.
  스냅샷 캡처는 노트가 **열려 있는 동안만** 일어난다 — 백그라운드 정기 스냅샷은 없다.
- **활동 로그 보존은 7일 OR 2000행(노트북당) 중 먼저 도달하는 쪽** — 별도 백그라운드
  프루닝 잡이 없고, 매 insert 트랜잭션 안에서 즉시 정리된다. 오래 안 쓴 노트북은 다음
  기록이 생길 때까지 오래된 행이 그대로 남아 있을 수 있다(프루닝이 조회가 아니라 쓰기에
  트리거되므로).
- **동기화되지 않는다** — 두 테이블 모두 기기 로컬 전용으로 설계됐다(5절). 다른 기기로 옮겨간
  활동 이력/스냅샷은 없다 — `backup_create`의 zip 백업만은 DB 파일 전체를 통째로 복사하므로
  예외적으로 함께 실려간다(`repo/snapshots.rs` V31 주석).
- **`note_id`에 FK가 없는 것은 의도된 트레이드오프** — delete 이벤트가 노트 삭제와 함께 사라지지
  않게 하려는 설계이지만, 그 대가로 DB 차원의 참조 무결성 보장이 없다(정합성은 앱 로직
  `note_alive` 판정으로만 확인).
- **복원 실패 시 타임아웃 없음** — 활동 창은 `"activity-restore-snapshot-result"` 응답을
  무기한 대기한다(`ActivityWindowApp.tsx`의 `ponytail:` 주석). 메인 창과 활동 창이 항상 같은 앱
  프로세스에서 같이 뜨므로 응답 유실은 사실상 없다는 전제 — 실사례가 나오면 그때 타임아웃을
  추가한다는 명시적 유보.
