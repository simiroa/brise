# Suggestions — 제안 시스템 (겹침 · 링크 · 테마 · 수집 후처리)

> 한 줄 요약: `suggestions` 테이블 하나가 "이 두 노트가 관련 있을까요?" 류의 후행(백그라운드)
> 제안 전종류(overlap/link/theme/collect_post_process)를 담는다. 모든 상태 전이는 펫 창의
> 다리(`petSuggestionsBridge.ts`)를 경유해야 배지가 60초씩 스테일해지지 않는다.

**SSOT 관계**: 기능 결정의 1차 소스는 `specs/features/suggestions.yaml`(F-SU01, 케이스별
기대값). 저장·정규화·상태 전이 로직의 실제 SSOT는 `src-tauri/src/repo/suggestions.rs`. 이
문서는 그 둘을 통합한 설명이며, 코드와 갈리면 코드를 믿는다.

## 1. 기능 개요

제안은 사용자가 직접 만들지 않고 백그라운드/AI 파이프라인이 "이거 볼래?" 하고 띄우는 카드다.
네 종류가 한 테이블에 섞여 있다:

| kind | 트리거 | 수락 시 부수효과 |
|---|---|---|
| `overlap` | 그래프 탭 로드 시 `related_sql`이 노트 쌍 유사도를 스캔 | 내부 링크(첨부) 하나 생성 — 그래프 탭 경로는 `repo::attachments::add_internal`을 트랜잭션 안에서 직접, "관련 노트" 탭(메인 창 UI) 경로는 `src/lib/attachmentService.ts::addInternalAttachment`(→ `attachment_add_internal` 커맨드)를 경유(§2.4) |
| `link` | 에디터에 단독 URL 붙여넣기(옵트인, `link_suggestions` 설정) | 없음(제안 자체가 이미 요약 결과) |
| `theme` | (스키마만 존재, 프로덕션 생산자 없음 — 테스트 전용) | — |
| `collect_post_process` | 수집 소스의 `post_process="suggest"`로 노트가 생성될 때 | 노트 열기 + organize propose(`ai_organize_note origin="collect_post_process"`) → `AiConfirmModal` 검토·적용 (`petCollectBridge.ts`) |

노출 경로는 두 갈래다: (1) 노트 안의 "관련 노트" 탭(`AttachmentsBar` → `useRelatedTiles`)에서
겹침 제안이 auto-related 타일에 배지로 얹힌다. (2) 펫(별도 웹뷰 창)의 채팅 패널에 카드 형태로
하나씩 뜬다(`PetChat.tsx`/`PetBubbleApp.tsx`) — 60초 폴링 + 즉시 리프레시 이벤트로 갱신된다.

## 2. 동작 방식

### 2.1 상태 전이

`VALID_STATUSES = ["pending", "dismissed", "accepted"]`(`repo/suggestions.rs`). `set_status`가
이 목록 밖의 값을 거부한다(`AppError::Validation`) — 프론트 오타나 구버전 방어. 전이는 단방향이
강제되지 않는다(테이블 자체는 재전이를 막지 않음)지만, 실제 호출부는 pending → accepted 또는
pending → dismissed로만 움직인다.

**overlap 전용 원자적 전이**가 따로 있다(그래프 탭 UI가 씀):
- `graph_suggestion_accept(conn, id)` — 트랜잭션 안에서 (a) 아직 내부 링크가 없으면
  `repo::attachments::add_internal`로 하나 생성, (b) `set_status(accepted)`. 이미
  `accepted`면 링크를 또 만들지 않고 그냥 성공 반환(재생 안전, idempotent). 대상 노트가
  삭제/보관 상태면 `NotFound`.
- `graph_suggestion_dismiss(conn, id)` — 트랜잭션 안에서 (a)
  `repo::notes::related_exclude(source, target)`로 이 쌍을 자동 관련 스코어링에서 제외,
  (b) `set_status(dismissed)`. 이미 `dismissed`면 no-op 반환.

이 둘은 "겹침 제안을 그래프 탭에서 직접 수락/무시" 흐름 전용이고, 일반 `suggestion_set_status`
커맨드와는 별개 경로다 — `suggestion_set_status`는 status만 바꾸고 부수효과(링크 생성/제외
등록)를 하지 않는다.

### 2.2 페어 정규화 (overlap)

`upsert_overlap`/`upsert_overlap_batch`는 `note_a`/`note_b`를 문자열 비교로 `(min, max)` 순서로
정규화해 저장한다 — A→B 스캔과 B→A 스캔이 서로 다른 순서로 들어와도 같은
`UNIQUE(kind, note_id, related_note_id)` 키에 수렴한다(안 그러면 두 방향 스캔이 별개 행 두
개를 만든다). `INSERT OR IGNORE`라 이미 어떤 status로든 존재하는 쌍은 조용히 건너뛴다 —
**dismissed된 쌍은 재탐지돼도 다시 pending으로 뜨지 않는다**(존중 정책). `theme`은 4개 이상
멤버라 쌍으로 정규화할 수 없으므로 "멤버 노트 집합이 하나라도 겹치면 같은 클러스터로 보고
기존 행이 있으면 스킵"하는 별도 규칙(`upsert_theme`)을 쓴다 — status 무관하게 스킵한다
(dismissed=재제안 금지, accepted=이미 처리됨, pending=아직 답 안 한 카드, 셋 다 다시 물을
이유 없음). ponytail: 멤버 1개만 겹쳐도 같은 클러스터로 접는다 — 조르지 않는 쪽으로 기운
보수적 기본값.

`link`은 반대로 **dismissed를 재탐지 허용**한다(`has_pending_link`가 pending만 검사) — 사용자가
같은 URL을 다시 붙여넣으면 매번 새 판단 기회를 준다. overlap의 dismissed 존중과 의도적으로
다른 정책: overlap은 자동 재탐지지만, link는 애초에 사용자의 명시적 붙여넣기 행동이 매번의
트리거이기 때문이다.

### 2.3 목록 조회 — 삭제 노트 필터

`list(conn, workspace_id, status)`는 `notes` 이너 조인 + `deleted_at IS NULL` 필터로 소프트
삭제된 노트가 관련된 제안 행을 자연스럽게 걸러낸다(별도 후처리 불필요). `graph_suggestion_accept`/
`_dismiss`는 한 걸음 더 나가 `archived_at IS NULL`까지 요구한다 — 보관된 노트를 대상으로 한
그래프 액션은 `NotFound`로 거부된다(관계도에 안 보이는 노트를 링크/제외 조작할 이유가 없다).

### 2.4 펫 브리지 — 모든 accept/dismiss는 여기를 경유해야 한다

펫 창(`pet`/`pet-bubble` 웹뷰)은 좁은 커맨드 allowlist(`PET_ALLOWED_COMMANDS`,
`src-tauri/src/pet_window.rs`) 안에서 동작하고, 여기에 `suggestions_list`/
`suggestion_set_status`가 없다 — 펫 창이 이 커맨드들을 직접 부를 수 없다. 대신 메인 창의
`src/plugins/pet/bridge/petSuggestionsBridge.ts`가 대리인 역할을 한다:

**이벤트 계약**:
```
main → pet(broadcast)  "pet-suggestions-pending" { suggestions: Suggestion[] }  (오래된 것 먼저)
pet-bubble → main       "pet-suggestions-refresh"  (payload 없음)
pet-bubble → main       "pet-suggestion-dismiss"   { id: string }
```

`refreshAndBroadcast`가 60초 폴링(`POLL_MS`)마다 `suggestions_list(status:"pending")`를 불러
결과를 뒤집어(최신순 응답을 오래된 것 먼저로) `pet-suggestions-pending`으로 브로드캐스트한다.
펫 카드는 한 번에 하나만 보여주므로(`PetBubbleApp.tsx`, `suggestions[0]`) 오래된 것부터
처리되는 게 우선순위다.

**핵심 규칙**: `acceptSuggestion(id)`/`dismissSuggestion(id)`(같은 파일)가
"`suggestion_set_status` 호출 + `pet-suggestions-refresh` emit" 페어를 캡슐화한다. 이 페어를
직접 두 줄로 풀어써서 우회하면(예: `suggestion_set_status`만 부르고 refresh emit을 빠뜨리면)
펫 배지가 다음 60초 폴링까지 스테일 상태로 남는다 — 이 정확한 실패 모드가 과거
`PetSuggestionReviewBridge.tsx`/`petLinkBridge.ts`/`petThemeBridge.ts` 세 다리가 각자
"set_status + refresh emit" 짝을 (주석까지) 복제해 구현하고 있어서 실제로 발생했었고, 지금은
`petSuggestionsBridge.ts`의 두 함수 하나로 모아졌다 — 세 다리 모두 이 함수들을 호출한다.
`stores/suggestions.ts`의 `acceptSuggestion`/`dismissSuggestion`(메인 창 UI, 즉 "관련 노트"
탭에서의 수락/무시)도 내부적으로 이 브리지의 `bridgeAccept`/`bridgeDismiss`를 그대로 쓴다 —
**메인 창 UI든 펫 카드든 accept/dismiss 경로는 결국 하나**(`petSuggestionsBridge.ts`)로
수렴한다.

새 제안 kind나 새 UI 진입점을 추가할 때, `suggestion_set_status`를 직접 호출하지 말고 이
브리지의 `acceptSuggestion`/`dismissSuggestion`을 재사용해야 이 불변식이 깨지지 않는다.

### 2.5 자동 관련 노트 타일 (`useRelatedTiles`)

`src/components/attachments/useRelatedTiles.ts`가 노트 상세의 "관련 노트" 탭 데이터를
조립한다. 수동 링크(내부 첨부, `useManualRelated`)와 자동 관련(`note_related` 유사도,
`useAutoRelated`)을 병합해 중복 제거한 타일 리스트를 만든다 — **수동 링크가 충돌 시 우선**
(같은 노트가 수동 링크이면서 자동 제안이기도 하면 수동/제거가능 타일로 한 번만 보임).

pending 제안은 워크스페이스 전역(노트별이 아님)이므로 마운트 시 1회 + `autoRefreshKey` 변화
시에만 다시 불러온다(활성 노트를 바꾸는 것만으로는 재조회하지 않는다 — 진짜 변경
(exclude/restore, 제안 수락)이 있을 때만 `AttachmentsBar`가 `autoRefreshKey`를 올린다).
`overlapSuggestionByPair`는 정규화된 `(lo,hi)` 페어 키로 제안을 Map에 인덱싱해, auto-related
노트마다 O(1)로 대응하는 pending overlap 제안을 찾아 배지에 얹는다(O(n) `.find()` 스캔 대신).

## 3. 데이터 모델

`suggestions` 테이블 핵심 컬럼(`repo/suggestions.rs`가 소유):

| 컬럼 | 의미 |
|---|---|
| `kind` | `overlap` \| `link` \| `theme` \| `collect_post_process` |
| `note_id` / `related_note_id` | overlap은 정규화된 (min,max) 쌍, link/collect_post_process는 대상 없으면 note_id 자기참조(컬럼이 NOT NULL이라 "대상 없음"을 이렇게 인코딩) |
| `link_url` | link 전용, 부분 유니크 인덱스로 같은 노트·URL의 pending 행 중복 방지 |
| `payload` | kind별 JSON — overlap은 자유형, link는 `{url, summary, title, target_note_id?, target_note_title?}`, theme은 `{note_ids: [...]}`, collect_post_process는 `{source_id, source_name, post_process_model}` |
| `score` | float — overlap/link 유사도, collect_post_process는 고정 1.0 |
| `status` | `pending` \| `dismissed` \| `accepted` |

`UNIQUE(kind, note_id, related_note_id)`가 overlap 페어 중복(정규화 후)과 link의 같은
노트+대상 조합을 막는다. link는 추가로 `link_url` 부분 유니크 인덱스가 같은 노트+URL의
pending 중복까지 막는다(대상 노트가 달라도 URL이 같으면 막힘).

## 4. 핵심 코드 경로

| 관심사 | 파일 |
|---|---|
| 저장소 계층(정규화·upsert·상태 전이·원자적 accept/dismiss) | `src-tauri/src/repo/suggestions.rs` |
| 커맨드(list/set_status/graph_accept/graph_dismiss/link_suggest/link_preview) | `src-tauri/src/commands/suggestions.rs` |
| 메인 창 스토어(로드/accept/dismiss, 내부 첨부 생성 트리거) | `src/stores/suggestions.ts` |
| 펫 브리지(accept/dismiss 단일 경로, 60초 폴링, 이벤트 계약) | `src/plugins/pet/bridge/petSuggestionsBridge.ts` |
| 자동 관련 노트 타일 병합 | `src/components/attachments/useRelatedTiles.ts` |
| 펫 카드 렌더(kind별 분기, 하나씩 표시) | `src/plugins/pet/PetBubbleApp.tsx`, `src/plugins/pet/PetChat.tsx` |
| 메인 창 UI에서의 수락/무시 다리(구현체, 지금은 petSuggestionsBridge로 수렴) | `src/components/PetSuggestionReviewBridge.tsx`, `src/plugins/pet/bridge/petLinkBridge.ts`, `src/plugins/pet/bridge/petThemeBridge.ts` |
| 기능 카탈로그 | `specs/features/suggestions.yaml` |

## 5. 알려진 한계 / 결정

- **`theme` kind는 저장 스키마만 존재** — 실제 생산 경로(어떤 백그라운드 작업이 클러스터를
  탐지해 `upsert_theme`을 호출하는지)가 프로덕션에 없다. 호출은 `repo/suggestions.rs`
  테스트뿐(`upsert_theme_row_is_listable_and_carries_members` 등).
- **카드 소비자는 렌더 가능 kind만 통과시킨다** — `bridge/petSuggestionCards.ts::
  pickRenderableSuggestion`이 overlap/link(payload 유효)/theme(멤버≥2)/collect_post_process만
  카드로 바꾸고, 미지의 kind는 건너뛰어 다음 제안을 본다. 예전엔 두 소비자(PetBubbleApp·
  SidebarChat)가 각자 `suggestions[0]`을 overlap으로 폴백해, 자기참조 행(collect_post_process)이
  "X와 X 내용이 겹쳐요" 자기병합 카드로 오렌더되고 큐를 막는 사고가 있었다(2026-08-29 수리).
  새 kind를 추가하면 이 헬퍼에 분기를 함께 추가해야 카드가 뜬다.
- **accept/dismiss를 브리지 없이 직접 `suggestion_set_status`로 호출하면 펫 배지가 최대 60초
  스테일** — §2.4의 규칙을 어기는 새 호출부를 추가하지 않도록 주의. 커밋 직전 수정 사항으로
  이 규율이 다시 한 번 강조/정리됐다(petSuggestionsBridge로 통합).
- **overlap의 dismissed는 영구 존중, link의 dismissed는 재제안 허용** — 의도적으로 다른
  정책(§2.2)이며 대칭이 아니다. 새 kind를 추가할 때 어느 쪽 정책을 따를지 명시적으로 결정해야
  한다.
- **`related_sql`(겹침 생산자)이 언제/어떤 주기로 도는지는 이 문서 범위 밖** — 그래프 탭 로드
  시점 트리거라는 사실만 확인했고, 스코어링 알고리즘 자체는 `repo::dashboard::graph`/관련
  코드를 참고해야 한다(이 문서는 suggestions 저장소·전이·노출 경로에 집중).
