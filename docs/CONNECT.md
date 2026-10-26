# 커넥트 — 결제문자 캡처 (loopback ingest 리스너)

> 한 줄 요약: 폰의 자동화 앱(Tasker/단축어)이 은행·카드 알림을 앱의 loopback API
> (127.0.0.1:`capture_ingest_port`, 기본 `DEFAULT_INGEST_PORT`=7333)로 POST 하면, AI가
> 상호명·금액·분류로 정리해 하루치 노트로 모은다. 인증은 토큰(`capture_ingest_token`)
> 하나.
>
> **SSOT 관계**: IPC 커맨드(채널 토글·상태 조회)의 1차 소스는
> `specs/commands/capture.yaml`. 리스너 자체의 HTTP API(`GET /ping`, `POST /ledger`)는
> Tauri invoke 가 아니라 실제 HTTP라 이 계약 밖이고, 유일한 명세는
> `src-tauri/src/sync_server/ingest.rs`와 이 문서다. 코드가 실제 SSOT다 — 이 문서와
> 코드가 갈리면 코드를 믿는다.
>
> **2026-09-09 크롬 익스텐션 철수.** 이 리스너에는 원래 클리핑(`/clip`)·방문 기록
> (`/visit`·`/config`)·페어링(`/pair`) 채널이 같이 얹혀 있었고, 이 문서도 그쪽이
> 대부분이었다. 익스텐션 자체(`extension/`)와 그 세 라우트·설정 키·설정 카드가 전부
> 지워졌다. 방문 기록은 익스텐션 대신 **크롬 History 파일을 직접 읽는** 로컬 가져오기가
> 맡는다(`docs/COLLECT.md`, `collect::browser_history`). 되살릴 계획은 없다 —
> 압축해제 로드의 개발자 모드 경고, 웹스토어 미게시, 브라우저별 재구현 부담이 값에
> 비해 컸다.

## 1. 기능 개요

채널은 하나다.

| 채널 | 트리거 | 무엇을 보내나 |
|---|---|---|
| 가계부 문자 캡처 | 폰의 자동화 앱(Tasker/단축어, 자동) | 결제/입금 알림 원문 |

`sync_server`(동기화 서버)와는 완전히 독립이고, `sync_enabled`와 무관하게 켜지고
꺼진다. 채널이 켜져 있으면 리스너가 뜨고, 꺼지면 리스너 자체가 없다. 게이트는 리스너
수명주기가 아니라 **요청마다 Rust가 DB를 다시 읽어** 강제한다(원 설계 Q7) — 설정과
리스너 상태가 어긋나도(수동 DB 편집, 껐다 켜는 도중) 꺼진 채널로는 아무것도 들어오지
못한다.

## 2. 동작 방식

### 2.1 리스너 수명주기

`commands/capture.rs::capture_set_ledger_enabled`가 토글·수명주기의 **단일 지점**이다.
토큰이 비어 있으면(첫 활성화) `new_id()`로 생성해 영속. 바인딩 실패(포트 사용중 등)
시 방금 저장한 설정값을 `"0"`으로 롤백한다 — 안 그러면 DB는 "켜짐"인데 리스너는 안
떠서 사용자가 껐다 켜기 전엔 재시도되지 않는다.

부팅 시에는 `ingest::maybe_start_at_boot`(`lib.rs::setup`)가 채널이 켜져 있고 토큰이
있으면 자동 기동한다. `CaptureStatus.running`은 저장된 설정이 아니라 **태스크가 실제로
살아있는지**의 헬스체크다(`!handle.inner().is_finished()`) — `running: false`인데
채널이 켜져 있으면 포트 충돌 등으로 기동에 실패했다는 뜻.

> 익스텐션 시절에는 이 함수가 `key: &str`를 받아 "세 채널 중 하나라도 켜져 있으면
> 기동"을 판정했다. 채널이 하나만 남아 그 일반화는 지웠다 — 다음 채널이 실제로 생기면
> 그때 되살리는 것이 업그레이드 경로다.

### 2.2 HTTP API

인증은 `Authorization: Bearer <token>` 헤더만 본다 — 쿼리 파라미터(`?token=`)는
지원하지 않는다. 본문 상한은 라우터 전체에 `INGEST_BODY_LIMIT_BYTES = 256 * 1024`
(256KB)가 걸려 있어 초과 시 413.

| 경로 | 인증 실패 | 본문 | 성공 응답 | 그 외 |
|---|---|---|---|---|
| `GET /ping` | 401 | 없음 | `200 {ok:true}` | 앱 상태를 흘리지 않음(연결 테스트 전용) |
| `POST /ledger` | 401 | `LedgerBody{text}` | `200 {ok, stored}` | `400`(text 빈 문자열) · `403`(채널 OFF) |

채널 게이트는 401보다 뒤에 판정된다(토큰이 틀리면 채널 상태와 무관하게 401 먼저).

### 2.3 가계부 캡처 흐름

`POST /ledger` → 토큰 검사 → 채널 게이트 → **DB 연결을 놓은 뒤** AI 파싱(락 규율,
`docs/COLLECT.md` §2.2와 같은 원칙) → `append_ledger_line`으로 하루치 노트에 한 줄
append.

AI 파싱 실패(프로바이더 게이트 닫힘·타임아웃·JSON 파싱 실패 전부)는 조용히 `None`이
되고 **원문 그대로** 저장된다 — "파싱 실패 시 통째로 버림"보다 항상 낫다. 같은 날 같은
텍스트는 중복 append 하지 않는다.

### 2.4 보안 경계

- 바인딩 주소는 **127.0.0.1 고정**이고 `bind.rs`(Tailscale CGNAT 등)를 아예 거치지
  않는다 — sync 서버가 CGNAT 인터페이스에 바인딩해 loopback을 못 쓰게 되는 상황과
  무관하게 항상 로컬에서만 붙는다.
- **CORS 헤더를 붙이지 않는다.** 일반 웹페이지가 이 포트로 JSON POST를 던지려면
  preflight가 필요한데, 헤더가 없으면 브라우저가 요청 자체를 막는다 — 토큰이 이미
  있어야 하는 것과 별개의 두 번째 벽이다. 폰 자동화 앱은 브라우저가 아니라 CORS를
  타지 않는다.
- **토큰 = 비밀번호.** 설정 화면에 일부(8자)와 복사 버튼으로 노출된다. 신뢰 경계는
  "같은 PC의 다른 프로세스" — 원격 공격자는 loopback 바인딩 때문에 애초에 이 포트에
  닿을 수 없고, 이 안에서는 토큰을 아는 쪽이 곧 권한이다.

## 3. 데이터 모델

전용 테이블 없음 — 설정 키와 노트 제목 접두사만 있다.

| 키 | 의미 |
|---|---|
| `capture_ledger_enabled` | 가계부 문자 캡처 채널 ("0"/"1", 시드 없음 = OFF) |
| `capture_ingest_port` | 리스너 포트, 기본 `DEFAULT_INGEST_PORT = 7333` |
| `capture_ingest_token` | 인증 토큰, 첫 활성화 시 `new_id()`로 생성 |
| `capture_visit_excluded_domains` | 익스텐션 시절 제외 도메인 — **읽기 폴백 전용**. `collect_excluded_domains`가 비어 있을 때 한 번 읽어 이관한다 |

노트 제목 접두사: `"가계부 — "`(가계부 캡처 일자별 노트).

## 4. 핵심 코드 경로

| 관심사 | 경로 |
|---|---|
| ingest 리스너(라우터·게이트·가계부 핸들러) | `src-tauri/src/sync_server/ingest.rs` |
| IPC 래퍼(채널 토글·수명주기) | `src-tauri/src/commands/capture.rs` |
| 커맨드 계약 | `specs/commands/capture.yaml` |
| 설정 UI(토글·전송 주소·토큰·포트) | `src/components/settings/SmsParseSection.tsx` |
| 캡처 상태 공유 훅(왕복 1회, busy 락 공유) | `src/components/settings/useCaptureStatus.ts` |
| 원 설계 | `docs/PLAN-2026-08-09-pet-capture.md` |

## 5. 설정 절차

1. 설정 > 연결 > 문자 파싱을 켠다(토큰 자동 생성, 리스너 기동).
2. 같은 카드에서 전송 주소(`http://127.0.0.1:<port>/ledger`)와 토큰을 복사한다.
3. 폰의 자동화 앱에서 알림 트리거 → HTTP POST 액션을 만들고, 헤더에
   `Authorization: Bearer <token>`, 본문에 `{"text": "<알림 원문>"}`을 넣는다.
4. 같은 네트워크에서 PC의 loopback에 닿아야 하므로, 폰에서 직접 치려면 동기화
   서버 쪽 경로(`docs/SYNC.md`)를 함께 본다.

## 6. 알려진 한계 / 결정

- **오프라인 큐 없음**(원 설계 Q4) — 앱은 트레이 상주라 대개 살아 있고, 실패한 전송을
  몰래 쌓아 뒀다가 나중에 쏟아내는 쪽이 더 나쁘다는 판단. fire-and-forget이다.
- **문턱·모델 오버라이드 설정 없음** — SMS 볼륨이 자연히 낮아 RSS의
  `post_process_model` 같은 비용 제어가 이 단계에선 과하다(ponytail).
- **리스너 미기동 경고는 이 카드에만** — 채널이 하나뿐이라 더 이상 갈릴 곳이 없다.
- **실기 검증은 오너가 직접** — 실제 폰 자동화 앱 연동은 자동화 테스트로 대신할 수
  없어 오너가 직접 확인한다([[owner-does-hands-on-qa]]).
