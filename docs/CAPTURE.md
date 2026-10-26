# 캡처 (스크린샷 · 빠른 기록)

화면을 찍어 노트로 남기는 흐름과, 새 노트를 만들 때 본문을 빠르게 채우는 프리셋 흐름.
카탈로그/검증 SSOT는 `specs/features/capture.yaml`.

> 결제문자 캡처(가계부)는 별도 기능이다 — [`docs/CONNECT.md`](CONNECT.md) 참고
> (`specs/commands/capture.yaml`의 `capture_status`/`capture_set_ledger_enabled`).
> 이름이 겹치지만 이 문서의 범위 밖.

## 1. 기능 개요

- **화면 저장**: 트레이 상주 앱의 수집 기능 — 활성 창을 캡처해 **저장 폴더에 PNG 로** 남긴다.
  켜고 끄는 곳과 폴더는 설정 > 일반(`capture_screenshot_enabled`, `capture_screenshot_dir` — 빈 값 =
  `<사진>/Brise`). 진입점은 **트레이 메뉴 "화면 저장"**이고, 펫 우클릭은 트레이 메뉴를 그대로 상속한
  같은 메뉴라 거기서도 보인다(`docs/PET.md` §0.3). **펫이 꺼져 있어도 동작한다.** 펫이 떠 있으면
  그 위에 말풍선 확인 카드(노트에 추가 + 선택적 AI 비전 요약)가 얹히고, 펫이 없으면 인박스 노트가
  확인 없이 자동으로 생긴다(AI 요약 없음). 2026-10-16 갭 해소(`docs/PET.md` §0.5).
- **빠른 기록 프리셋**: 새 노트를 만들 때 빈 노트 대신 즉시 쓸 수 있는 본문 틀 —
  할 일 목록 · AI로 시작하기 · 오늘 기록/여행 기록/회고 빌트인 · 사용자 커스텀 프리셋.

## 2. 동작 방식

### 2.1 화면 저장

단일 관문은 `src-tauri/src/tray.rs::capture_to_folder` — 게이트(`capture_screenshot_enabled`, Rust 강제) ·
활성 창 캡처 · 폴더 저장 · OS 알림(`tauri-plugin-notification`, 제목 "화면을 저장했어요", 본문 = 저장 경로).
폴더 저장이 실패하면 실패 알림 + `diag::warn("capture","save_to_folder_failed")`(경로는 진단에 안 남긴다)
후 캡처는 그대로 돌려준다. 메뉴 클릭(`tray::run_capture`)은 두 갈래다.

**A. 펫이 없을 때 (트레이 직행)** — 캡처 → 폴더 저장 → OS 알림 → **인박스 노트 자동 생성**(오너 2026-10-16).
확인 카드는 없고, **AI 비전 요약도 돌리지 않는다**(오너 2026-10-16 — 이미지가 AI 제공자로 나가는 경로는 B
하나뿐). 파일·노트가 곧바로 생긴다(`capture_to_folder` 직후). 본문은 출처 한 줄 `화면 캡처: <창 제목>`
(`screenshot_note_body` — TS `screenshotBody` 가 요약 없이 만드는 문자열과 같고, "AI 요약 꺼짐" 같은 사유는
붙이지 않는다). 저장은 B 와 같은 커맨드(`pet_note_create` → `attachment_add_bytes`). 진입점은
`commands::pet::capture_to_inbox`. 노트는 활성 노트북의 인박스에 들어가고 트리는 `remote-note-write` 로 갱신된다.
캡처·노트·첨부 어느 단계든 실패하면 OS 알림 + `diag::warn("capture","capture_to_inbox_failed")`(코드만).

**B. 펫 창이 떠 있을 때 (카드 경로)** — 펫 창은 캡처·검색·저장 커맨드를 직접 부를 수 없으므로
(`docs/PET.md`, `PET_ALLOWED_COMMANDS`) 메인 창이 다리 역할을 한다(`src/plugins/pet/bridge/petScreenshotBridge.ts`):

1. 메뉴 클릭 → Rust 가 펫에 `pet-menu-run {action:"capture"}` → 펫이 "살펴보는 중…" 말풍선 + 감시 타이머 →
   메인 창이 `pet_screenshot_capture` 커맨드 호출.
2. 커맨드가 `capture_to_folder` 를 탄다 — **카드에서 고르기 전에 파일은 이미 폴더에 있다.** Rust가 **활성 창**을
   캡처한다(전체 화면이 아니다) — 자기 프로세스 창(펫·말풍선·메인·메뉴)을 제외한 뒤 z-order가 가장 위인 일반
   창을 고른다(`repo/screenshot.rs::pick_capture_target`). 최소화·빈 제목·120px 미만인 창은 후보에서 제외.
3. AI 비전 요약이 게이트로 켜져 있으면(설정 > AI, 프라이버시 게이트) 캡처 이미지를 축소
   JPEG(긴 변 1024px)로 변환해 요약을 요청한다. 게이트가 닫혀 있거나 실패해도 이미지 저장
   자체는 막지 않고, 이유를 `ai_summary_status`(`disabled`/`unsupported_or_failed`/`timeout`/
   `generated`)로 구체적으로 돌려준다.
4. 결과가 펫 말풍선에 확인 카드(`pet_bubble_clip`, `kind:"shot"`)로 뜬다 — **확인 전에는 노트에
   아무것도 쓰지 않는다**. 요약(또는 없으면 창 제목)으로 로컬 검색 1건을 돌려 "이 노트에
   추가" 후보를 제안한다.
5. 사용자가 카드에서 고르면(제안 노트에 추가 / 새 인박스 메모) 본문이 먼저 저장되고, 그 뒤
   이미지가 `attachment_add_bytes`로 같은 노트에 첨부된다 — 두 단계를 분리해서, 첨부만
   실패해도 "저장 안 됨"으로 잘못 보이지 않게 한다(노트는 이미 저장돼 있고 알림에 노트로
   가는 링크가 붙는다).
6. 요약이 없을 때도 사유가 사라지지 않도록, 노트 본문 출처 줄에 한 줄로 남는다
   (예: "화면 캡처: 제목 · AI 요약 꺼짐").

Windows 전용(`repo/screenshot.rs`, `xcap` 크레이트) — 다른 OS에서는 캡처 자체를 명시적으로
거절한다(조용한 빈 이미지 없음).

### 2.2 빠른 기록 프리셋

`PresetList.tsx`(데스크톱) / `MobileCapturePresets.tsx`(모바일, `src/mobile/MobileNote.tsx`가
새 노트 화면에서 렌더)가 같은 프리셋 스토어(`stores/presets.ts`)를 쓴다.

- **빌트인**: 할 일 목록(체크리스트 본문 1회 적용) · AI로 시작하기(주제 입력 → AI 생성 →
  적용) · 오늘 기록/여행 기록/회고. 데스크톱에서 "제거"한 빌트인은 `hiddenBuiltinIds`로
  숨겨지고 모바일에도 그대로 반영된다(같은 소스).
- **커스텀**: 사용자가 만든 프리셋 — 이름변경/삭제를 롱프레스(모바일)/우클릭(데스크톱)
  메뉴로.
- 프리셋을 고르면 그 본문(`bodyMd`)이 새 노트에 그대로 적용된다. AI 프리셋은 주제를 받아
  생성한 본문을 같은 방식으로 적용.

## 3. 데이터 모델

전용 테이블 없음. 화면 저장 파일은 저장 폴더(`capture_screenshot_dir`, 원격 `settings_set` 차단 —
`remote_policy.rs`)에 남고, 카드 경로에서 노트에 넣으면 기존 첨부 경로(`attachments`)도 탄다. AI 요약 결과는
민감할 수 있어 히스토리에 원문을 남기지 않는다 — 외부 전송 시도 여부와 결과 상태만
`ai::record_history`로 감사 로그에 남긴다. 파일명은 `screenshot-YYYYMMDD-HHMMSS.png`
(경로 안전 문자만, 창 제목은 파일명에 넣지 않는다).

## 4. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| 캡처 대상 판정 + Windows 캡처 + 폴더 규칙·쓰기 | `src-tauri/src/repo/screenshot.rs`(`capture_dir`·`save_png`) |
| 메뉴 항목(트레이 = 펫 우클릭) · 단일 관문 | `src-tauri/src/tray.rs`(`build_tray_menu`·`run_capture`·`capture_to_folder`) |
| 카드 경로 커맨드(비전 요약) | `src-tauri/src/commands/pet.rs::pet_screenshot_capture_inner` |
| 폴더 설정 UI | `src/components/settings/GeneralSection.tsx`(화면 저장 폴더 행) |
| 메인 창 다리(펫 이벤트 ↔ 커맨드) | `src/plugins/pet/bridge/petScreenshotBridge.ts` |
| 프리셋 스토어 | `src/stores/presets.ts` |
| 프리셋 UI | `src/components/PresetList.tsx`(데스크톱), `src/mobile/MobileCapturePresets.tsx`(모바일) |

## 5. 알려진 한계 / 결정

- 화면 저장은 Windows 전용 — macOS/Linux는 스텁이 명시적으로 거절한다.
- 커맨드·다리 이름(`pet_screenshot_capture`, `petScreenshotBridge`)이 펫에 묶여 있는 것은 진입점이 펫
  하나이던 구현의 흔적이다(개명 안 함). 기능의 소유는 앱(트레이 · 설정 > 일반)이다.
- 펫이 없을 때는 카드가 없으므로 "기존 노트에 추가" 선택지도 없다 — 항상 새 인박스 노트(오너 2026-10-16).
  OS 알림은 클릭 동작이 없다(폴더 열기 버튼 없음, 본문에 경로만). 노트/첨부 실패 알림의 제목은 캡처 실패와
  같은 "화면을 저장하지 못했어요"다(파일은 이미 폴더에 있을 수 있다 — 앞선 "저장했어요" 알림이 그 증거).
- 파일명은 초 단위라 같은 초에 두 번 찍으면 덮어쓴다(진행 중 재요청은 카드 경로에서만 막는다).
- 진행 중인 캡처가 있으면 재요청을 버린다(큐 없음) — "지금 이 화면"이라는 의미상 나중 처리가
  무의미하기 때문. 다음 "화면 저장"이 이전 대기 중 캡처를 덮어쓴다.
- 펫 캐릭터·말풍선 창의 운영 계약(창 분리, allowlist, AI 게이트) 전반은 `docs/PET.md` 참고 —
  여기서는 캡처 흐름만 다룬다.
