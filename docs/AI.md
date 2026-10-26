# Brise AI Architecture & Agent SSOT (Single Source of Truth)

This document defines the AI capabilities, contracts, execution gates, safety models, and agentic refactoring procedures for Brise.

---

## 1. Overview & Core Philosophy

> **노트는 내가 쓴다. AI는 거들 뿐이고, 쓰기는 언제나 내 확인을 거친다.**

> **원칙 개정(2026-10-07 그릴 확정, PLAN-2026-10-08 — 자동화 W6 부터 효력)**:
> **"AI 는 쓸 수 있고 관리할 수 있다. 공동 관리지만 결정권은 사용자에게 있다."** 사용자의 허용이 우선한다.
> AI 는 "AI 가 소유하는 구역"이 아니라 사용자와 **공동으로 가꾸는 작업 공간**의 일원이다(GRILL §3 라운드 1 Q6 · 라운드 2 Q2).
> AI 가 확인 없이 직접 고칠 수 있는 범위는 **자동화가 켜져 있고, 사용자가 허용한 폴더와 내용 안**으로 한정된다(라운드 2 Q3)
> — 아래 [§1.2a 자동화 허용 단계](#12a-자동화-허용-단계-w6-부터).
>
> **지금(W0 시점) 코드에는 그런 쓰기 경로가 없다.** 위 한 문장과 아래 불변 계약 1~5 는 W6 전까지 그대로 참이고,
> W6 부터는 **자동화가 쓰는 경로 하나만** 예외가 된다(불변 계약 2 의 예외). 수동 AI 기능(손질·정돈·수집)의 확인 단계는
> 이 개정으로 바뀌지 않는다.

이 한 문장이 **3계층**으로 쪼개진다(`docs/PLAN-2026-08-30-ai-surface-and-clients.md` §2 확정).
이 표가 설정 카탈로그(`src/lib/aiCapabilities.ts`)의 섹션 머리글이고, 온보딩 브리핑의 뼈대이며,
**새 AI 기능을 어디에 넣을지 판단하는 기준**이다. 세 계층 중 어디에도 안 들어가는 기능은
설계를 다시 본다.

| 계층 | 정의 | 원본에 무슨 일이 | 해당 기능 |
| :-- | :-- | :-- | :-- |
| **L1 손질** (refine) | 내가 쓴 것을 **읽고 다듬는다** | 원본 보존, 결과는 **새 섹션으로 삽입** | 정리 · 요약 · 목록화 · 교정 · 번역 · 자동 각주 · 시트 · 프롬프트 박스 · 선택영역 AI |
| **L2 정돈** (organize) | 구조·메타데이터를 **붙인다** | **제안 → 확인 → 적용.** 확인 없는 쓰기 경로 없음 | 메타데이터 제안 · 후처리 · 관계도 · 노트 분리 · 폴더 정리·병합 · 노트북 재편 · 배치 정리 |
| **L3 수집** (gather) | **바깥의 것을** 들여온다 | 원문은 **사료 패널에 보존** | 링크 요약 · 수집 채널 · 가계부 캡처 · 펫/사이드바 비서 |

**불변 계약** — 아래는 전부 이미 코드가 지키고 있고 테스트가 못박은 것이다:

1. L1은 원본을 덮어쓰지 않는다 — `lib/aiSectionBridge.ts::insertAiSection` 한 지점.
   **그리고 삽입 자체가 확인을 거친다** (PLAN-2026-09-05 §2) — 어시스트 결과는 `AiResultModal`
   (결과 프리뷰 게이트, `stores/aiResultGate.ts::runWithAiResultGate`)에서 사람이 [삽입]을 누르기
   전까지 노트에 한 글자도 쓰이지 않는다. 같은 모달이 대기 중에는 진행 표시기(경과 시간 · 재시도
   n/3 · [중단])다. 킬 스위치 `ai_confirm_before_apply`(기본 ON) — 끄면 현행처럼 즉시 삽입.
   대기 상한은 프로바이더 무관 45s(vision 75s). 로컬 Ollama 연장안(120s)은 2026-09-05 오너 결정으로
   철회 — GPU 없는 기기의 Ollama 사용자는 상정하지 않으며, 느린 추론을 기다리게 두지 않고 45s 에 알린다.
   예외 — **제자리 교체**인 `diagram_edit` · `diagram_progress` · `sheet_edit`(`replaceSection`)은
   "새 섹션" 원칙의 예외이고, 그래서 이 게이트가 그 경로에 필수다 — **킬 스위치를 꺼도 유지된다**
   (`replacesExisting` 플래그, 선택영역 교체 포함; `AUDIT-2026-09-05-ai-guard-friction` §2-7). 모바일은
   `MobileAiResultSheet`가 같은 게이트 스토어를 그린다(화면 2벌·정책 1벌). 게이트 밖: 번역 토글(읽기
   전용 뷰) · 표 AI(자체 프리뷰) · 챗 `create_section`(칩 확인) · 메타데이터/에이전트(각자 모달).
2. L2는 전부 propose-only. DB 반영은 확인 모달을 통과한 뒤에만. 파괴적 액션(휴지통·병합)은
   **별도 게이트 + 2차 확인**(`AiAgentReviewModal`).
3. L3은 원문을 버리지 않는다(원문 사료 패널 `F-N03`).
4. 클라우드 프로바이더는 `ai_enabled` 없이 한 바이트도 못 나간다 — 로컬 Ollama만 예외
   (`invariant_ai_privacy_gate.rs`).
5. AI 히스토리는 본문·API키를 저장하지 않는다(`invariant_ai_history_audit.rs`).

### 1.0 원칙

1. **Local-First & Privacy First**: AI operations require explicit opt-in (`aiEnabled` setting). All outbound requests are checked against the `privacy_gate_ok` flag and logged in `ai_history`.
2. **Read-Only / Plan-Only AI Outputs**: The AI model NEVER mutates the database directly. It produces structured JSON Plans (`AiPlan`).
3. **User Approval Gate**: The app renders the proposed JSON Plan in an interactive review modal (`AiConfirmModal` / `AiAgentReviewModal`) with per-item checkboxes. The user selectively approves items.
4. **Standard Command Pass-Through**: 승인된 변경은 전부 실재하는 표준 커맨드를 통과한다 —
   `note_create` / `note_update` / `section_update` / `note_delete`. 이로써 FK, 소프트 삭제
   (휴지통), tombstone, 동기화 규칙(V24+)이 그대로 적용된다.
   커맨드 이름은 `specs/commands/*.yaml` 이 SSOT다. `call()` 이 문자열 기반이라 오타를 tsc 가
   잡지 못하므로, 새 액션을 추가할 때는 반드시 스펙에 있는 이름인지 확인한다 — 이 문서의 이전
   판은 존재하지 않는 `note_set_title` / `section_update_body` 를 전제로 쓰여 있었고, 실행
   경로도 그 이름을 부르고 있었다(전 항목 무동작).

5. **출처(provenance)는 두 겹이다** — "누가 썼나"와 "무엇으로부터 썼나"는 다른 질문이고 저장
   위치도 다르다. 앞은 `sections.ai_origin`(액션 id, V67 — 섹션 탭의 AI 점), 뒤는 **본문 안의
   출처 한 줄**(`lib/aiSectionBridge.ts::withSourceLine` — `> 출처: [제목](url) · 파일명`).
   뒤가 컬럼이 아니라 본문인 이유: 내보내기(.md)·동기화·검색에 함께 실려야 한다.
   모델에게 "출처를 적어라"고 프롬프트로 부탁하지 않는다 — 지킬 때와 안 지킬 때가 섞여 출처가
   있는 섹션과 없는 섹션이 생긴다. `runAiAction` 의 `ctx.insertSection` 을 호출자가 감싸서
   **삽입 직전** 코드가 붙인다(`lib/linkImport.ts` 의 AI 갈래가 그 형태의 원본이다).
   각주(`footnoteMark`)로 가지 않은 이유(2026-09-10 확인): 각주 마크는 `attrs.id` 로 **첨부 행**을
   가리키고 각주 목록/프리뷰는 `isFootnoteKind` 로 필터한 뒤 `attachment_read_text`(텍스트 kind
   전용)로 읽는다 — 링크 첨부를 가리키면 본문에는 마커가 생기는데 목록에 항목이 없고 조회는
   VALIDATION 으로 거부된다(눌러도 아무것도 안 나오는 마커). AskAi 의 첨부 파일은 노트 첨부로
   **등록조차 되지 않는다**(메모리 안 `{name,size,content}`). 각주로 가려면 같은 사실을 담은
   footnote 첨부를 하나 더 만들어야 하는데 그건 이 한 줄이 이미 하는 일이다.

### 1.1 AI audit event contract

`ai_history.action_type` is a stable `operation.outcome` value. AI calls write one terminal
event: metadata planning uses `organize.proposed` or `organize.failed`; text operations use
`translate.succeeded|failed`, `cleanup.succeeded|failed`, and `generate.succeeded|failed`.
Exception: `ai_organize_note(origin: "collect_post_process")` — the collect post-process card's
accept path — records the flat action_type `collect_post_process` for BOTH outcomes, because
`collect_get_stats`/`AiHistoryPanel` already key on that exact suffix-less literal; success vs
failure stays readable from the result text (`AiAuditEvent::CollectPostProcess`).
User-approved mutations write `organize.applied` or `plan.applied` in the same transaction as
their database change. History retains at most 50 entries per workspace and stores only capped,
redacted input metadata and completion/error summaries—never note bodies, generated output, or
API keys. A history write is best-effort for a provider call, so it cannot replace its original
success or failure; apply events are transactional because they describe committed mutations.

### 1.2 AI 호출 로그 — 감사 기록과 **다른 것**

`ai_history`(위)는 **사용자 대면 감사 기록**이다. 별도로 **개발자용 진단 로그**가 있다
(PLAN-2026-09-05 §3, `src-tauri/src/repo/ai/call_log.rs`):

- 기록 지점은 `transport::logged_call` 하나 — `RealTextTransport::send_text`/`send_json`(Gemini·Ollama
  네이티브 스키마 경로) · `RealVisionTransport::send_vision` · `RealTranslateTransport::translate` 네 곳이
  이 헬퍼를 지난다. 모든 실 프로바이더 호출(펫 챗 · 수집 자동요약 · 가계부처럼 `record_history`를 안
  부르는 경로 포함)이 여기를 지난다. 재시도·폴백 **바깥**에서 한 번 기록해 사용자 행동 1건 = 1행(시도
  횟수는 필드). 취소(`ai_cancel_call`)도 같은 자리에서 `tokio::select!`로 걸려 취소 뒤 폴백 재시도가
  나가지 않는다.
- `op`/`caller`/`note_id`/`request_id`는 tokio `task_local` **호출 컨텍스트**(`call_log::with_call_ctx`)로
  들어온다 — `TextTransport` 트레잇 시그니처는 바꾸지 않았다(테스트 목 7개). `ai_organize_note` ·
  `ai_translate_text` · `ai_cleanup_text` · `ai_generate_from_prompt`가 커맨드 본문을 감싸고, 뒤의 셋은
  프런트가 준 `request_id`를 싣는다. 결과 프리뷰 게이트는 세션마다 `request_id`를 만들어 이 셋에 넘기고
  [중단] 때 **그 id로만** 취소한다(`ai_cancel_call { request_id }` → 진행 중 호출 N건, `count`) — 같은
  순간 시작된 후처리·수집 요약 호출은 건드리지 않는다. 배경 경로(펫 비전 · collect summary ·
  가계부)는 아직 컨텍스트가 없어 `caller`가 비어 있다(각 호출부에서 `with_call_ctx`로 감싸면 채워진다).
- 저장: 앱 데이터 디렉터리 `ai-calls.jsonl`, 2MB(verbose 시 10MB)에서 `ai-calls.1.jsonl`로 한 번 회전(두 세대).
  메모리 링(300)이 진행 중 + 최근 항목을 들고 `ai_calls_active` / `ai_calls_recent`(둘 다 `http: false`)로
  읽힌다 — `ai-history` 창의 "호출 로그" 탭이 소비자.
- **본문은 기본 미저장.** 크기(`prompt_bytes`/`response_bytes`) · provider/model · attempts ·
  fallback_used · duration_ms · outcome(ok|error|deadline|cancelled) · `mask_secrets`를 통과한 error만.
  `ai_debug_verbose`(기본 OFF)를 켜면 앞 2000자가 붙는다 — 설정 화면에 "노트 내용이 로그 파일에
  기록됩니다"를 명시. `settings_set`이 저장 성공 직후 `call_log::set_verbose`를 불러 **즉시** 반영된다
  (끄면 다음 호출부터 본문이 기록되지 않는다 — 재시작 불필요).
- **집계·주석**: `ai_calls_summary { days 1~90 }`가 파일(`ai-calls.jsonl` + `.1`)을 읽어 total · outcome별 ·
  provider별 · duration 중간값/p90 · 버리기 이유 분포를 돌려준다(링이 아니라 파일 — 링은 300건·재부팅 소실).
  결과 프리뷰 게이트에서 [버리기]를 누르면 이유 칩(wrong·too_long·bad_format·other)이 `ai_call_annotate`로
  `{"kind":"annotation", request_id, discard_reason}` 한 줄을 append하고 링 항목에도 남긴다. 둘 다 `http: false`.
  `ai-history` 창 호출 로그 탭 상단의 7일 요약 카드가 소비자 — 첫 사용자에게 어떤 실패가 많은지 보는 장치다.
- `ai_history`를 이 용도로 쓰지 않는 이유: 노트북당 50행 캡이라 챗 몇 번에 밀리고, 본문·키 미저장이
  불변식으로 못박힌 사용자 기록이라 성격이 다르다. 반대로 이 로그는 `ai_usage` 통계를 대신하지 않는다.

### 1.2a 자동화 허용 단계 (W6 부터)

> **상태: 계획(구현 0).** 판정의 SSOT 는 `docs/PLAN-2026-10-08-automation.md` §5 R1~R3 이고, 이 절은 그 요약이다
> — 다르면 PLAN 이 이긴다. 결정 근거는 PLAN §2(A1~A16)와 `docs/GRILL-2026-10-07-routine.md` §3.
> W6(판정 `ladder.rs`·저널·되돌리기) 전까지는 어떤 단계도 효력이 없고, 마일스톤 A(W4·W5)에선 자동화 결과가 **전부 검토함**으로 간다.

**자동화**는 폴더(본거지)에 거는 AI 작업이다 — 트리거(수동·예약·도착) + 지시문 + 동작 체크박스 + 목적지 체크박스.
실행은 Rust 워커(창이 숨어도 돈다), 목적은 "입력된 노트를 AI 가 알아서 정리하고 향후 인사이트에 도움"(A10)이다.
용어는 `docs/GLOSSARY.md` "자동화" 절.

**허용 단계** — 폴더마다, **기기 로컬**(노트북과 함께 가지 않는다). 행이 없는 폴더 = "제안만". 가져온 노트북의 폴더도 "제안만"으로 도착하고,
전체 자동화 스위치를 끄면 전부 잠든다. 원본 폴더와 목적지 폴더를 **둘 다** 본다(이동은 양쪽 모두 "추가" 이상).

| 단계 | 바로 처리 | 검토함 |
|---|---|---|
| 제안만 | — | 전부 |
| 추가 | 메타 붙이기(태그는 더하기만) · 섹션·노트 추가 · 덧붙이기 · 이 폴더로 옮겨 오기 | 고치기 · 병합 · 휴지통 |
| 공동 관리 | + AI 글 고치기 · AI 글로만 된 노트의 병합·휴지통 | 사람 글이 섞인 동작 |
| 전부 맡김 | 전부(사람 글 포함, 태그 빼기 포함) | — |

- **기본은 바로 처리, 검토함은 예외만**(A5): 자동화 폼의 "바로 처리"(기본)는 저장할 때 본거지·목적지 단계를 필요한 만큼
  **사용자에게 보여 주고** 올린다. "처음엔 확인하며 쓰기"를 켜면 단계를 건드리지 않는다. 폴더 단계의 기본값("제안만")과
  자동화의 기본 동작("바로 처리")은 이렇게 맞물린다 — 단계를 올리는 것은 언제나 사용자가 본 저장 동작이다.
- **사람 글**(R2): 동작의 입력에 `sections.ai_origin` 이 없는 섹션이 하나라도 있으면 "사람 글 고치기"다. "전부 맡김"이 아니면 검토함.
- **파괴 상한**(R3): 한 실행에서 바로 처리될 휴지통·병합·덮어쓰기가 3건을 넘으면 그 실행 전체가 검토함으로 간다.
- `ai_excluded` 폴더는 어떤 단계든 건드리지 않는다(Rust 에서 강제). 클라우드 전송은 지금처럼 `ai_enabled` 관문을 지난다(불변 계약 4).
- 이 단계는 설정 > AI 의 **AI 기능 레벨**(`ai_policy_level`, en "AI permission level")과 다른 축이다 — 그쪽은 노트북 전체에서 어떤 AI 기능을 쓸 수 있는지,
  이쪽은 폴더마다 자동화가 확인 없이 무엇을 할 수 있는지.
- **아직 결정 대기(정책 아님)**: ⚠️ R17 수습 기간(처음 20동작 검토 → 승인율 90%↑ 졸업) · ⚠️ WS 기본값 시험 · PLAN §8·§14 의 🔒 항목.

---

## 2. Builtin AI Actions

Brise 는 **빌트인 AI 액션 20개**를 제공한다 — 실행형 11개 + 계획/챗 지침 9개.

ID는 `src/stores/aiPrompts.ts`의 `BUILTIN_DEFS`가 SSOT다 — 아래 표는 그 파일에서 그대로 옮긴
것이며, 다른 이름을 지어내면 안 된다.

> ⚠️ **이 표는 2026-08-30까지 "6개 + 에이전트 3개"라고 적혀 있었다.** 그 사이 코드는 18개까지
> 자랐는데(`proofread` · `sheet` · `sheet_edit` · `agent_merge` · `ask_note` · `find_related` ·
> `fill_note` · `rename_plan` · `prune_plan` 이 문서에 없었다) 아무도 알아채지 못했다.
> 이제 `src/lib/aiCapabilities.test.ts` 의 역방향 케이스가 `BUILTIN_DEFS` 의 **모든** 항목이
> 설정 카탈로그에 등장하는지 검사한다 — 새 액션을 추가하면 카탈로그에 넣을 때까지 게이트가
> 빨갛다. **이 표를 갱신하는 것도 그 작업의 일부다.**
>
> 2026-09-05 감사에서 또 한 번 어긋나 있었다 — `diagram_progress`가 표에 없어 "18개"로 적혀 있었다
> (`AUDIT-2026-09-05-ai-features.md` §6). `diagram_expand_branch`(선택 노드 하위 단계 전개)는 그때
> 상수만 있고 `BUILTIN_DEFS`·카탈로그 미등재라 "구현 중"으로 빠져 있었는데, 2026-09-22 감사 후속
> W1 에서 **등재되어 이제 20개**다(`AUDIT-2026-09-22-ai-prompts.md` §4 W1). 타일은 그전에도 AskAi 에
> 떠 있었고 누르면 `findPreset` 이 빈손으로 돌아와 매번 "프리셋을 찾을 수 없습니다"로 죽었다.
>
> 카탈로그 누락은 `aiCapabilities.test.ts` 가 잡지만 **이 마크다운 표는 어느 게이트도 보지 않는다** —
> 위 개수와 아래 표 행은 손으로 맞춰야 한다.

| Action ID | 이름 키 | 하는 일 | 출력 |
| :--- | :--- | :--- | :--- |
| `list` | `ai.action_default_name_list` | 본문을 체크리스트/목록으로 정리 | 마크다운 |
| `organize` | `ai.action_default_name_organize` | 본문을 다듬어 구조화 | 마크다운 |
| `summarize` | `ai.action_default_name_summarize` | 요점 요약 | 마크다운 |
| `metadata` | `ai.action_default_name_metadata` | 제목·태그·연도·지역·폴더 제안 | `ai_organize_note` 의 고정 JSON |
| `diagram` | `ai.action_default_name_diagram` | 관계도 생성(2026-09-04 리빌드 — mermaid 삭제) | 관계도 JSON IR v1 (`diagramSchema.ts`, 검증·자동수리 루프 최대 3회) |
| `diagram_edit` | `ai.action_default_name_diagram_edit` | 기존 관계도 수정 — **제자리 교체**(`replaceSection`) | 관계도 JSON IR v1 |
| `diagram_progress` | `ai.action_default_name_diagram_progress` | 관계도 노드 상태만 갱신(구조 불변 검증) — **제자리 교체** | 관계도 JSON IR v1 |
| `diagram_expand_branch` | `ai.action_default_name_diagram_expand_branch` | 선택 노드의 하류 후속 단계 3~5개를 전개해 덧붙임 — **제자리 교체** | 관계도 JSON IR v1 |
| `proofread` | `ai.action_default_name_proofread` | 맞춤법·문장 교정 | 마크다운 |
| `sheet` | `ai.action_default_name_sheet` | 본문을 근거로 시트 생성 | 시트 JSON |
| `sheet_edit` | `ai.action_default_name_sheet_edit` | 기존 시트 셀 수정 — **제자리 교체**(`replaceSection`) | 시트 셀 패치 |
| `agent_split` | `ai.action_default_name_agent_split` | 노트 분리 **계획** 지침(편집 가능) | (실행 아님 — 아래 §4) |
| `agent_folder` | `ai.action_default_name_agent_folder` | 폴더 정리 **계획** 지침 | (실행 아님) |
| `agent_workspace` | `ai.action_default_name_agent_workspace` | 노트북 재편 **계획** 지침 | (실행 아님) |
| `agent_merge` | `ai.action_default_name_agent_merge` | 겹치는 노트 병합 **계획** 지침 | (실행 아님) |
| `ask_note` | `ai.action_default_name_ask_note` | 사이드바 챗 — 열린 노트에 관해 묻기 | 챗 응답 |
| `find_related` | `ai.action_default_name_find_related` | 사이드바 챗 — 관련 노트 찾기 | 챗 응답 |
| `fill_note` | `ai.action_default_name_fill_note` | 사이드바 챗 — 노트 초안 채우기 | 새 섹션 |
| `rename_plan` | `ai.action_default_name_rename_plan` | 이름 정리 **계획** 지침 | (실행 아님) |
| `prune_plan` | `ai.action_default_name_prune_plan` | 정리·솎아내기 **계획** 지침 | (실행 아님) |

에이전트 지침 프리셋은 "AI 프리셋" 편집기(프리셋 관리 모달의 AI 프리셋 탭 · 설정 > AI > AI 프리셋 —
같은 `AiActionEditor`)에서 편집할 수 있지만 메뉴의 `runAiAction` 으로는 실행되지 않는다
(`menuActionPresets` 가 제외, `isAgentPlanPreset` 가드). 계획 생성 진입점은 각각 AI 메뉴 분리 /
폴더 우클릭 / 설정 노트북 재편 / 겹침 제안 카드 "검토하기" / 사이드바 챗의 "자세히 보기" 칩이다.

⚠️ `rename_plan` / `prune_plan` 은 **프리셋 문구를 고쳐도 스캔 방식이 바뀌지 않는다** —
`petChatPlan.ts` 가 `agent_folder` / `agent_workspace` 지침을 대신 쓴다. 그리고 `prune_plan` 은
지목한 노트로 좁혀지지 않고 **항상 노트북 전체**를 훑는다.

출력이 "마크다운"인 이유: 에디터 및 섹션 삽입 경로가 마크다운(체크리스트 `- [ ]`, 리스트, 제목, 서식 등)을 직접 지원하므로, 모델이 불필요한 HTML 태그 대신 읽기 쉽고 직관적인 마크다운 형식으로 산출물을 직접 생성한다.

### 2.1 후처리 — AI 생성 직후의 자동 메타데이터 제안

AI가 노트에 **새 본문을 넣은 직후**(`lib/aiSectionBridge.ts::insertAiSection` — 모든 text/diagram
결과가 지나가는 한 지점), `lib/aiPostProcess.ts::schedulePostProcess(noteId)` 가 백그라운드로
`metadata` 액션과 **똑같은** propose 계약을 한 번 돌린다(`ai_organize_note` → `lastProposal` →
확인 모달 → `ai_apply_organize`). 새 파이프라인이 아니라 기존 계약의 자동 트리거일 뿐이고,
**확인 없이 쓰는 경로는 없다**.

제안이 준비됐을 때 **모달을 자동으로 띄우지 않는다**(2026-09-05, 감사 §2-1 — 결과 프리뷰 게이트 [삽입]
직후라 모달이 연달아 두 개 뜨던 마찰). 노트를 보고 있으면 "보기" 버튼이 있는 토스트(10초)로 알리고
누르면 그 자리에서 확인 모달을 연다; 놓치거나 다른 노트로 옮겼으면 기존 대기 구독이 노트를 다시
열 때 보여준다. 제안은 어느 경우에도 버려지지 않는다.

| 트리거되는 것 | 트리거되지 않는 것 |
| :--- | :--- |
| `list` / `organize` / `summarize` / 커스텀 text 액션 | `metadata` (그 자체가 이 흐름 — 재귀) |
| `diagram` (관계도 만들기) | `diagram_edit` (기존 섹션 교체, 삽입 아님) |
| 프롬프트 박스 / 선택 영역 AI / Ask-AI 모달의 생성 결과 | 번역 (`postProcess:false` — 언어 변환일 뿐) |
| | 관계도 **템플릿** 프리셋 (`lib/presetBridge.ts`, AI 산출물 아님) |
| | 모바일 자체 inserter (확인 모달이 없다 — 아래) |

- **동시성**: 노트당 1건(in-flight `Set`). 진행 중에 두 번째 삽입이 오면 **건너뛴다**(큐 없음).
- **모달 vs 알림**: 결과가 왔을 때 그 노트를 아직 보고 있으면 확인 모달이 그대로 열린다. 다른
  노트로 이동했으면 제안을 들고 있다가 `ai.postprocess_ready` 알림만 띄우고, 그 노트로
  **돌아오는 순간** 모달이 열린다(남의 노트 제안이 튀어나오지 않게).
- **실패**: 조용히(`organizeCurrentNote(..., silent=true)` → `callSilent`) — 사용자가 요청한 적
  없는 작업이 에러 토스트를 띄우지 않는다.
- **킬 스위치**: 설정 > AI > 고급의 `ai_post_process`(기본 ON).
- **모바일**: `MobileNote::insertSection` 은 `insertAiSection` 을 거치지 않고, 모바일은 아직
  `AiConfirmModal` 을 렌더하지 않는다 — 확인 UI가 없는 곳에 제안을 만들어 두면 낭비라 이번
  웨이브에서는 데스크톱 전용이다. 모바일에 확인 UI가 생기면 그때 같은 트리거를 붙인다.

### 2.2 오디오 전사 (S2-3b, `audio_transcribe`)

설계 SSOT: `docs/PLAN-2026-10-06-s2-input.md` §5. 폰 녹음기가 올린 오디오 첨부를 PC 가 Gemini 로 받아쓴다
(엔진 결정 Q1=A, 오디오 외부 전송 동의는 `ai_enabled` 로 갈음 Q2). 구현은 `commands/audio_transcribe.rs`,
전송은 `repo/ai` 의 `AudioTransport`(`provider_send_audio`, 이미지용 `inline_data` 모양 재사용).

- **게이트**: `ai_enabled` **그리고** `privacy_gate_ok`. 닫혀 있으면 외부 호출 0, `VALIDATION` 메시지가
  `ai_required:` 로 시작한다(프런트가 "AI 연결 필요" 로 바꾸는 안정 코드). Gemini 가 아닌 provider 는
  요청을 보내기 전에 `audio_unsupported_provider:` 로 실패한다. 새 동의 키는 만들지 않는다.
- **검증**: 첨부가 `note_id` 의 `audio` 여야 한다(다른 노트의 첨부 id 만으로는 못 읽는다).
- **자격**: 커맨드 인자에 endpoint/api_key 가 없다 — 서버가 자기 DB 에서만 읽는다. 원격(`/api/v1/invoke`)
  호출자가 엔드포인트를 바꿔 키를 빼돌릴 수 없고, 응답·로그에는 키가 없다(`post_chat` 의 `mask_secrets`,
  `call_log` 에는 지시문만 — 오디오 base64 는 기록하지 않는다). `diag` 에는 실패 코드 종류만 남긴다(본문·경로 금지).
- **한도**: 원본 **14MB**(`AUDIO_INLINE_MAX_BYTES`) 초과는 `audio_too_large:`. Gemini `inline_data` 는 요청
  전체 20MB 한도이고 base64 가 4/3 로 부풀기 때문이다(≈ opus 32kbps 로 58분). 첨부 업로드 상한(25MB)보다
  작으므로 그 사이 크기는 전사 불가 — 더 긴 녹음은 Gemini Files API 가 필요하다(ponytail, 필요가 실측되면).
  파일 크기는 읽기 **전에** metadata 로 거른다.
- **타임아웃·재시도**: 작업 전체 120s(`AUDIO_OPERATION_DEADLINE`, vision 75s 보다 길다 — 업로드+긴 오디오),
  HTTP 90s, 실패 시 재시도 1회(`logged_call` 공통 규칙). 폴백 모델은 쓰지 않는다(Gemma 계열은 오디오를 못 받는다).
- **프롬프트**: 말한 그대로 받아쓰기, 음성 언어 유지, 문장부호·단락 정리만, 요약·번역·덧붙임 금지, 들리지
  않는 곳은 지어내지 않고 `[들리지 않음]`.
- **멱등**: 저장된 `attachments.transcript` 가 있으면 AI 호출 없이 그대로 돌려준다(AI 가 꺼져 있어도).
  같은 첨부의 **동시** 호출은 `CONFLICT transcribe_in_progress:` 로 거절한다(중복 비용 방지). 실패는
  저장하지 않으며 재시도할 수 있다. 빈 응답은 `transcribe_empty:` 로 에러(저장 안 함).
- **저장**: 서버는 첨부 행(`transcript`, `transcript_inserted`, 마이그레이션 V93)에만 쓰고 `events::publish` 로
  알린다. **노트 본문은 서버가 쓰지 않는다**(D2② `expected_updated_at` 부재 — 폰이 편집 중인 본문을 덮을 수 있다).
  삽입은 클라이언트가 하고 `attachment_transcript_mark_inserted` 로 중복 삽입을 막는다.
- **알려진 천장**: webm/m4a 는 Gemini 공식 오디오 목록(wav·mp3·aiff·aac·ogg·flac)에 없다 — 실기에서 거절되면
  녹음기 형식을 맞추거나 변환 단계를 둔다. 전사 텍스트는 번들 내보내기에 아직 싣지 않는다.

---

## 3. Fixed App Contracts & Constraints

1. **Folder Name Guarantee**: When AI suggests folders or categorization, it MUST only pick from existing user folder names unless explicit creation is allowed.
2. **JSON Schemas**: All structured responses follow strict JSON schemas with system prompt boundaries.
3. **Agent plan prompt pattern** (same split as metadata):
   - **Guidance** (user-editable): Korean text in `agent_*` presets.
   - **Schema contract** (app-owned): empty-value skeleton in `AGENT_PLAN_SCHEMA_SKELETON`
     (`stores/aiAgentActions.ts`). Never send filled placeholder examples ("Topic 1 Title") —
     models copy them.
   - **원문 SSOT 파일(2026-10-09, PLAN-2026-10-08 §7 W0)**: 에이전트 기본 지침 4종과 앱 고정 절반은
     `specs/ai/prompts/agent/` 에 있다 — `split.md`·`folder.md`·`workspace.md`·`merge.md`(지침 기본값),
     `plan-schema.json`(`AGENT_PLAN_SCHEMA_SKELETON`), `data-boundary.md`(`UNTRUSTED_DATA_CONTRACT` — `<untrusted_data>` 계약),
     `output-contract.md`(`AGENT_PLAN_OUTPUT_CONTRACT`). TS 는 Vite `?raw` 로 바이트 그대로 읽고(dev·build·vitest 실측),
     W2 의 Rust 플랜 엔진은 같은 파일을 `include_str!` 로 읽는다. 파일은 **LF·끝 개행 없음**(`.gitattributes` `eol=lf`) —
     끝 개행 하나도 프롬프트와 저장된 사용자 재정의의 정확 일치 비교를 바꾼다. 고정 테스트 `src/stores/aiPromptFiles.test.ts`
     (파일 == 상수 · W0 이전 리터럴의 sha256). `specs/ai/prompts/automation/*.md` 는 평가 하네스용 초안이라 규약이 다르다(맨 앞 주석을 로더가 지움).
4. **Failure Policy**:
   - If AI returns invalid JSON, the app fails gracefully (`parseAiPlan` returns null) with no DB mutation.
   - On network/API failure, no DB state is altered.
   - Plan execution records per-action failures and never swallows them (`empty catch {}` 금지).
5. **Policy Lock Styling**: 정책 잠금은 더 이상 `label-caps` 배지로 표시되지 않는다. 행 전체가 `opacity: var(--dim-disabled)`로 흐려지고 사유는 `title` 툴팁으로만 제공된다.

---

## 4. Agentic Refactoring (D2/D3 Scope Design)

Agentic actions operate across 3 distinct scopes. The model returns an `AiPlan`; the app renders
`AiAgentReviewModal`, user checks items (default: **none selected** — destructive actions must
not be pre-checked), then `executeApprovedPlan` runs approved actions via real commands.

### 4.0 Sidebar / pet chat — secretary

Chat is a **secretary**. It finds, explains, and chats immediately (`answer` / `search`).
Simple writing (templates, drafts, fill) is `create_section`: the model returns the
full markdown; the app inserts a **new section** via `insertAiSection` when the
sidebar **수정 권한** toggle is on and a note is open. It never overwrites an
existing section body. The toggle is persisted in settings (`chat_write_enabled`, default on;
formerly the local `brise.chatWriteEnabled` — migrated to the DB key).
An Inbox memo remains `create_note` / `pet_note_create` — but if a note is already
open, `create_note` is remapped to `create_section`.

Metadata, folder moves, title changes, delete, and merge stay on `propose_plan`
(`rename_plan` / `prune_plan`) → **자세히 보기** chip → `AiAgentReviewModal` →
`executeApprovedPlan`. Legacy `fill_note` chips generate a draft and insert a
section; they do not open the rewrite-the-whole-note modal.

`propose_plan` does **not** mutate notes or folders — it returns a short reply plus
`plan_kind` / `plan_id` stored on `pet_messages.meta`. The model must not delete
or rename directly. `section_body` is IPC-only (meta is 8KB).

**Retrieval (2026-10-09, Wave S)**: one turn = one `pet_chat` IPC, and the only note retrieval is the
Rust question search inside it (`docs/SEARCH.md` §4.1). The former front-end pre-search (sentence-as-is
`search_notes` + an extra synonym LLM call) is gone — it also ignored `chat_read_files` and sent note
titles/snippets anyway. With `chat_read_files` off, **no note content** reaches the provider. Evidence
cards (`show_evidence`) are exactly the notes injected into the prompt, persisted in the assistant meta.

The pet window is a **mirror** of the same thread. Tools, presets, and file drop
stay on the sidebar. Chips survive reload via message meta. Failures and vision
fallback are transcript rows (`failed`, `vision_status`), not toast-only.
Operating policy (windows, open-main, compact bubble, AI off): `docs/PET.md`.

### Scope 1: Note-Level (Split Note)
- **Entry Point**: Editor AI Menu → "노트 분리 제안 (AI)"
- **Input Context**: Full note text body of the active note.
- **Proposed Plan**: `create_note` actions for split parts **and** an explicit original
  disposition: `delete_note` (trash original) or `update_note` (keep / trim original).
  If the model omits disposition, the app appends a trash-original action so the review table
  always shows what happens to the source (`ensureSplitOriginalDisposition`).
- Topic count is **not** hardcoded to 2 — guidance asks for as many distinct notes as needed.

### Scope 2: Folder-Level (Merge, Clean, Delete)
- **Entry Point**: Folder row context menu → "폴더 정리·병합 제안 (AI)"
- **Input Context**: Bounded `note_query(folder_ids: [id])` page (`FOLDER_AI_SCAN_CAP`, default
  500) — **not** `notesByFolder[folderId]` (the left tree's windowed cache, only whatever had
  scrolled into view; a 100-note folder with 30 rows loaded made the model judge "no duplicates"
  from 30 notes while the review UI read as a full-folder verdict — round2 N2-1). Tags are
  hydrated via `hydrateTagNames`. Light metadata (`title`, `tags`, ids) of the returned notes.
  When the folder exceeds the cap, `plan.truncatedCount` is set and the review modal's existing
  truncation banner renders it — no candidate-compression pass here (unlike workspace scope),
  the raw list is small enough at this cap.
- **Proposed Plan**: `merge_notes`, `update_note`, `delete_note` (schema skeleton includes all three;
  not update-only demos).

### Scope 3: Notebook-Level (Structure Refactoring)
- **Entry Point**: Settings > AI > "노트북 재편 (AI)"
- **Input Context**: Bounded `note_query` scan (`WORKSPACE_AI_SCAN_CAP`, default 500) — **not**
  `Object.values(notesByFolder).flat()` (that was only expanded folders). Tags are hydrated via
  `hydrateTagNames` when needed. Pass 1 compresses to max 30 candidates.

#### Notebook Scalability & 2-Pass Compressed Candidate Filter
To comply with `docs/SCALABILITY.md` (no full-workspace unbounded loading):
1. **Pass 1 (Local Compressed Signal Detection)** — `workspaceAiFilter.ts` on `NoteSummary`:
   - Duplicate titles
   - Tag overlaps (`tag_names`)
   - Identical event dates (year+month+day, 3+ notes)
   - **Not** `attachments.content_hash`: that column is on attachment rows (V24) and is used by
     `note_related` scoring; NoteSummary has no hash field, so this pass does not claim hash
     signals without a dedicated query.
   - Cap at 30 candidates; UI shows truncation count when exceeded.
2. **Pass 2 (AI Proposal & Review)**:
   - Only Pass 1 candidates are sent to the model.
   - Generates an `AiPlan` with merges / updates / deletes.

### Plan action types → commands

| `AiPlanAction.type` | Commands (order matters) |
| :--- | :--- |
| `create_note` | `note_create` → `section_update` (body required) |
| `update_note` | `note_update` (title) and/or `note_get` + `section_update` (body) |
| `delete_note` | `note_delete` (soft delete / trash) |
| `merge_notes` | `note_create` + `section_update` **first**, then `note_delete` each source. Refuses if `bodyMd` is empty so sources are never trashed without a written merge body. |

---

## 5. User Review & Approval UI Contract

1. **Itemized Checkboxes**: Every action in an `AiPlan` has an individual checkbox.
   **Default: none selected** (not "all checked") so delete/merge cannot run on a single click.
2. **Explicit Target Display**: Type badge + title/id; delete and merge use danger styling so
   original disposition and source-trash are visible.
3. **Primary action**: **"선택 항목 적용 (N)"** / Apply Selected (N) — disabled when N=0.
4. **Partial failure**: toast with ok/failed counts; modal stays open when any action failed.
5. **메타데이터 제안은 필드 단위 선택** (`AiConfirmModal`, PLAN-2026-09-05 §1): 행마다 체크박스 +
   **현재값 → 제안값** + 배지. 판정과 기본값은 `lib/aiProposalDiff.ts`(순수 함수)가 SSOT이며
   `AiBatchOrganizeModal`도 같은 함수를 쓴다 — **채움**(현재 비어 있음 → 기본 ☑) · **덮어씀**(현재 값
   있고 다름 → 기본 ☐) · **동일**(행 숨김). 좌표는 lat/lng 한 행(백엔드가 둘 다/둘 다 아님 강제),
   폴더는 항상 덮어씀. 미선택 필드는 `undefined`로 보내 백엔드 `Option::None`
   = "손대지 않음"이 된다(Rust 무변경).
   **호스트는 둘이다(2026-09-27)** — 독립 확인 창(`AiConfirmModal`)과 AI 모달 안(`ai/AskAiMetaPanel`,
   결과 패널과 같은 틀). AI 모달에서 시작한 제안(메타·태그 프리셋, "메타데이터 포함" 삽입 뒤)은 그 노트에
   한해 AI 모달이 품고(`stores/proposalHost`) 독립 창은 그리지 않는다. 선택·적용 규칙은 두 호스트가
   같은 훅(`useProposalReview`)을 쓴다. 어시스트 패널의 빠른 실행("데이터 자동 채우기"·"태그 제안")은
   여전히 독립 창으로 간다.
   ⚠️ **출처 링크 행은 2026-09-22 W2 이후 사실상 뜨지 않는다** — `organize_format_contract`에서
   `source_urls` 요구를 뺐기 때문이다(웹 접근이 없는 모델에게 URL을 지어내게 하고 그 URL이 확인
   모달을 거쳐 그대로 첨부되던 경로였다, `AUDIT-2026-09-22-ai-prompts.md` §1.3). 입력·적용·되돌리기
   경로(`source_urls` / `remove_source_urls`)는 그대로 살아 있으므로 다른 호출자가 채우면 동작한다.
6. **태그는 교체 시맨틱을 UI가 정직하게 드러낸다** — `replace_note_tags`는 통째 교체이므로 세 구역:
   **유지**(현재∩제안, 체크박스 없음) · **추가**(제안에만, 기본 ☑, 소프트캡 10 초과분만 ☐) ·
   **제거**(현재에만, **기본 ☐ = 지우지 않음**). 최종 집합 = 유지 ∪ 선택된 추가 ∪ (선택 안 된 제거)를
   "적용 후: …(N개)"로 항상 표시하고, 현재와 같으면 `tag_names`를 보내지 않는다. 이 기본값이 2026-09-05
   감사의 A-0 손실(모델이 기존 태그를 일부만 돌려주거나, 12개를 그대로 돌려줬는데 소프트캡이 2개를
   기본 해제해 지워지던 일)을 구조적으로 막는다.
7. **배치 정리도 같은 규칙** (`AiBatchOrganizeModal`): 행마다 `computeFieldDiffs` → 기본은 **채움 필드 +
   추가 태그만** 전송. 값이 있는 필드는 모달 상단 "값이 있는 필드도 덮어쓰기"(기본 꺼짐)를 켠 때만.
   행별 "채움 N · 덮어씀 M(건너뜀/포함)" 요약을 보이고, 적용할 게 없는 행은 호출을 생략한다.
8. **적용은 되돌릴 수 있다**: `applyProposal`이 적용 전 `NoteSummary`로 역방향 페이로드
   (`lib/aiProposalDiff.ts::buildRevertPayload`)를 만들어 한 undo 토스트로 제목·연도·지역·좌표·폴더·태그를
   되돌린다(폴더 전용 undo를 흡수). 되돌릴 수 없는 것 — 빈 값에서 채운 **좌표**(백엔드 `Option::None` =
   "손대지 않음", clear 시맨틱 없음)와 **출처 링크**(추가만 있고 제거 경로 없음) — 는 토스트 문구에
   이름을 적어 알린다. → 2026-09-06 `ai_apply_organize`에 `clear_fields`(location|region|year) ·
   `remove_source_urls[]` 입력이 추가되어 좌표·링크도 되돌린다(`applied`에 `*_cleared`/`attachments_removed`).
   `Option::None`은 여전히 "손대지 않음"이고, 지우기는 이 두 입력으로만 일어난다. 값 입력과 clear 동시 지정은
   VALIDATION. 배치 정리는 배치당 `request_id` 하나로 `ai_organize_note`를 묶어 [중단] 시 진행 중 호출을 실제로
   끊는다(`ai_cancel_call { request_id }`).
