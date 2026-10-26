import { t } from "../i18n/t";
import type { CtxKind } from "../components/ai/composer/types";
import { DIAGRAM_TYPES } from "../components/diagram/types/registry";
import { CHART_TYPE_IDS } from "../lib/sheet/types";

/**
 * 통합 프리셋 모델의 kind (docs/PLAN-2026-08-08-presets-schedule.md Q5~Q7):
 *   - text / diagram — LLM 변환 액션. AI 액션 메뉴에 뜨고 runAiAction 이 실행한다.
 *   - metadata — 출력 스키마가 앱 고정이라 **빌트인 전용**(커스텀 생성 불가, CUSTOM_KINDS 참고).
 *   - template — LLM 을 아예 부르지 않는 순수 노트 스캐폴드. `prompt` 필드가 곧 노트 본문이고
 *     실행 경로가 다르다(변환이 아니라 새 노트 생성) — menuActionPresets/runAiAction 의 kind
 *     가드로 AI 액션 경로에서 배제되고, 표출은 노트 템플릿 피커(components/PresetList.tsx)가 맡는다
 *     — 그쪽이 이미 note_presets(빈 노트/할 일/오늘 기록/여행 기록/회고 + 커스텀)를 그리는 자리라,
 *     두 저장소를 한 목록에서 보여주는 "통합 UI, 저장은 유지"(Q6)가 거기서 성립한다.
 * kind 를 늘릴 때는 함정 3: src-tauri/src/repo/settings_schema.rs::validate_setting 의
 * "ai_action_presets" arm 도 같이 늘리고 Rust 왕복 테스트로 확인할 것.
 */
export type AiActionKind = "text" | "metadata" | "diagram" | "template" | "sheet" | "tool";

/** 사용자가 직접 만들 수 있는 kind — metadata 는 빠진다(출력 스키마가 앱 고정). */
export const CUSTOM_KINDS = ["text", "diagram", "template", "sheet"] as const;
export type CustomAiActionKind = (typeof CUSTOM_KINDS)[number];


/** AI에게 묻기 모달이 프리셋을 여는 대상 종류(PLAN-2026-09-15-askai-composer §2.1). */
export type AskAiKind = "note" | "section" | "selection" | "diagram" | "sheet";
/** 결과가 가는 곳. `proposal` 은 문장이 아니라 검토 모달로 라우팅된다(§3). */
export type AskAiWhere = "section" | "note" | "replace" | "proposal";
export type AskAiProposal = "metadata" | "tags" | "split";

export interface AiActionPreset {
  id: string;
  name: string;
  /**
   * 프롬프트이자 **스탬프 템플릿**. 슬롯 `{{lang}}` · `{{n=5}}` · `{{tone}}` · `{{text:질문}}`.
   * 컨텍스트는 문장에 들어가지 않는다(6안 D17) — 옛 `{{ctx}}` 는 파싱 때 버려지고, 필요한 참조는
   * `needs` 가 선언한다. 슬롯이 없는 옛 프롬프트는 그대로 스탬프.
   */
  prompt: string;
  kind: AiActionKind;
  isBuiltin: boolean;
  hidden: boolean;
  // ── 타일 필드(2026-09-15). 전부 optional — 저장 스키마(settings_schema.rs)와 옛 클라이언트 호환.
  /** 타일 라벨(짧게). 없으면 name 전체 — 타일이 두 줄까지 감싸고 넘치면 말줄임한다. */
  label?: string;
  /** 노트 아이콘 id(noteIconComp). 없으면 kind 기본. */
  icon?: string;
  /** 이 프리셋이 뜨는 대상. 없으면 kind 기본(askAiPresets.ts). */
  targets?: AskAiKind[];
  /** 기본 저장 위치. 없으면 "section". */
  where?: AskAiWhere;
  /** where === "proposal" 일 때 라우팅 키. */
  proposal?: AskAiProposal;
  /**
   * 이 프리셋이 필요로 하는 컨텍스트(6안 D17). 스탬프할 때 컨텍스트 줄에 없으면 활성으로 더한다.
   * `"body"` 는 **대상의 본문**이라는 뜻이라 선택 영역·섹션 대상에서는 모달이 그 대상의 참조로
   * 바꿔 넣는다. 필요 없는 프리셋(질문·제안형·제자리 교체)은 선언하지 않는다.
   */
  needs?: CtxKind[];
  /** 빈 노트/빈 시트에서만 뜨는 시작 프리셋(PLAN-2026-09-27 §7-5). */
  blank?: boolean;
  /** 단일 정렬 순서(Q7). */
  order?: number;
}

// ── Built-in prompts ─────────────────────────────────────────────────────────────────────────
// Fed to ai_generate_from_prompt as the "User request" half of the user_text (see
// repo/ai.rs::generate_from_prompt_inner) — the backend wraps it with a fixed, generic system
// prompt ("write new content based on the user's request... respond with ONLY the generated
// content") and appends the active section's body as "Existing note context" below it. So each
// prompt here only needs to say what THIS action wants — not re-litigate "no commentary" etc.,
// though it's restated anyway since duplicated instructions are cheap insurance against a model
// that only reads its own turn closely.
//
// Output format is clean Markdown: EditorPanel and section insertion natively parse Markdown
// (including `- [ ]` task lists, lists, headings, tables, bold/italic, etc.). Prompts instruct
// the model to produce clean markdown directly, without surrounding HTML tags or markdown fences.
//
// Not i18n'd (unlike UI chrome strings): these are instructions TO the model, not text shown to
// the user, and the app's notes are Korean-primary (see CLAUDE.md) — translating carefully-tuned
// prompt-engineering text into en/fr without re-tuning it would be worse than not having it.
export const LIST_PROMPT =
  "당신은 노트 정리를 돕는 도우미입니다. 아래 노트 내용을 항목별 리스트로 재구성하세요.\n\n" +
  "목표: 문단으로 흩어진 정보를 한눈에 훑어볼 수 있는 리스트 구조로 바꿉니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 날짜·이름·수치·고유명사 등 원문의 모든 사실과 세부사항을 빠짐없이 보존하세요. 원문에 없는 내용을 지어내지 마세요.\n" +
  "- 복문/장문은 뜻이 하나인 단위로 쪼개, 각 항목이 한 가지 사실 또는 할 일만 담게 하세요. 원문 표현이 이미 자연스러우면 그대로 쓰고, 불필요하게 다시 쓰지 마세요.\n" +
  "- 항목이 해야 할 일/행동(예: 준비할 것, TODO, 다음에 할 일)이면 체크리스트(- [ ] ...)로 만들고, 단순 정보 나열이면 글머리 기호 리스트(- ...)로 만드세요. 판단이 애매하면 체크리스트를 기본으로 쓰세요.\n" +
  "- 노트 원문과 동일한 언어로 답하세요(번역 금지).\n\n" +
  "하지 말아야 할 것: 설명·서론·맺음말을 붙이지 마세요. 코드 펜스(```)를 쓰지 마세요.\n\n" +
  "출력 형식 (깔끔한 마크다운 리스트만 출력):\n" +
  "- 체크리스트: - [ ] 항목\n" +
  "- 글머리 기호 리스트: - 항목";

export const ORGANIZE_PROMPT =
  "당신은 노트 정리를 돕는 도우미입니다. 아래 노트 내용을 더 읽기 쉽게 다듬어 재구성하세요. 요약이 아니라 정리이므로 분량을 임의로 크게 줄이지 마세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 날짜·이름·수치·인용 등 모든 사실관계를 그대로 보존하세요. 원문에 없는 내용을 지어내지 마세요.\n" +
  "- 맞춤법·비문·중복된 표현을 정리하고, 관련 있는 문장끼리 문단으로 묶으세요. 원문에 이미 있던 구조(리스트, 단락 구분, 순서)는 최대한 존중하세요.\n" +
  "- 원문의 말투와 표현이 이미 자연스러운 부분은 그대로 유지하세요.\n" +
  "- 노트 원문과 동일한 언어로 답하세요(번역 금지).\n\n" +
  '하지 말아야 할 것: 설명·서론·맺음말("정리한 내용입니다" 등)을 붙이지 마세요. 코드 펜스를 쓰지 마세요.\n\n' +
  "출력 형식 (깔끔한 마크다운만 출력): 문단 구분과 빈 줄, 나열이 자연스러운 부분은 리스트(-), 강조가 꼭 필요할 때만 **굵게**를 사용하세요.";

// 맞춤법 교정 — ORGANIZE_PROMPT 와 다르다: 저쪽은 "재구성"(문단 묶기·순서 정리)까지 하고,
// 이쪽은 **표기만** 고친다. 노트 도우미(PresetList assist)와 AI 액션 메뉴가 같은 프리셋을 쓴다.
export const PROOFREAD_PROMPT =
  "당신은 맞춤법 교정을 돕는 도우미입니다. 아래 글의 맞춤법·띄어쓰기·오타·명백한 비문만 고쳐 그대로 다시 출력하세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 내용·순서·구조·말투를 바꾸지 마세요. 문장을 합치거나 나누지 말고, 요약하거나 덧붙이지 마세요.\n" +
  "- 고칠 곳이 없는 문장은 원문 그대로 두세요.\n" +
  "- 원문과 동일한 언어로 답하세요(번역 금지).\n\n" +
  "하지 말아야 할 것: 무엇을 고쳤는지 설명하지 마세요. 서론·맺음말을 붙이지 마세요. 코드 펜스를 쓰지 마세요.\n\n" +
  "출력 형식 (마크다운 출력): 원문의 줄바꿈·단락·리스트 등 문서 구조를 그대로 유지한 마크다운 텍스트만 출력하세요.";

export const SUMMARIZE_PROMPT =
  "당신은 노트 요약을 돕는 도우미입니다. 아래 노트 내용을 핵심만 남겨 요약하세요.\n\n" +
  "목표: 원문을 읽지 않아도 무슨 내용인지 파악할 수 있는 간결한 요약을 만듭니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 날짜·이름·수치·고유명사 등 핵심 사실은 반드시 보존하세요. 원문에 없는 내용을 추측하거나 지어내지 마세요.\n" +
  "- 부차적인 세부사항과 반복, 군더더기는 과감히 생략하되 문맥 이해에 필요한 정보는 남기세요.\n" +
  "- 원문이 여러 주제를 다루면 주제별로 문단이나 항목을 나누세요.\n" +
  "- 노트 원문과 동일한 언어로 답하세요(번역 금지).\n\n" +
  '하지 말아야 할 것: "요약하면", "다음은 요약입니다" 같은 서론/맺음말을 붙이지 마세요. 코드 펜스를 쓰지 마세요.\n\n' +
  "출력 형식 (깔끔한 마크다운만 출력): 짧으면 한두 문단으로, 핵심 포인트가 여러 개면 글머리 기호 리스트(-)로 정리하세요.";

// Wave(EDITABLE METADATA PROMPT): 이제 실제로 모델에 보내진다 — repo/ai.rs::compose_organize_system_prompt
// 가 "backend 고정 OUTPUT CONTRACT(JSON 필드 이름/형식) + 이 텍스트(guidance)"로 합성해
// ai_organize_note의 custom_prompt 인자로 전달된다(runAiAction 참고). 즉 이 텍스트로 바꿀 수
// 있는 건 "무엇을 우선할지/어떤 관점으로 판단할지"뿐이고, JSON 스키마 자체(필드 이름 등)는
// 앱이 고정해 항상 그대로 전송된다 — AiActionsSection의 안내 문구(ai.action_metadata_guidance_hint)도
// 같은 구분을 설명한다. 월/일 단위의 정확한 날짜 추론은 여전히 지원되지 않으며(연도만), 폴더는
// 아래에서 지원된다(Wave FOLDER INFERENCE) — 기존 노트북(= workspace) 폴더 중에서만 고르고, 새 이름을
// 지어내지 않는다(그 강제는 backend 계약에 있다 — 이 프롬프트가 바꿀 수 없는 부분).
export const METADATA_PROMPT =
  "노트 본문을 분석해 제목·태그·연도·지역·폴더를 제안할 때 다음을 우선하세요(지역이 확인되면 위도·경도도 함께 조회됩니다).\n\n" +
  "판단 기준:\n" +
  "- 노트 본문에 없는 사실을 지어내지 마세요. 확신이 서지 않는 항목은 비워두는 편이 낫습니다 — 특히 폴더는 이 노트북에 실제로 존재하는 이름 중에서만 고르고, 뚜렷하게 맞는 폴더가 없으면 아무것도 제안하지 마세요(제안 없음도 정상적인 결과입니다).\n" +
  "- 제목은 80자 이내로 간결하게, 연도는 노트의 핵심 주제와 가장 관련 깊은 시점으로 추정하세요.\n" +
  "- 태그는 노트를 나중에 다시 찾을 때 실제로 검색할 법한 핵심어 위주로 고르세요.\n" +
  "- 지역은 노트와 직접 관련된 역사적·지리적 지명만 제안하세요.";

// Wave (EDITABLE METADATA PROMPT) self-heal: the metadata preset's prompt used to be
// documentation-only (backend ignored it — see the removed "not editable" comment this replaced).
// Any install where the user has EVER edited/reordered/deleted ANY AI action already has the
// WHOLE list persisted verbatim (stores/aiPresets.ts's header: "the moment the user edits
// anything, the WHOLE current list is snapshotted — including untouched built-ins"), so an
// untouched metadata preset there still carries this exact old text. Now that the prompt is
// actually sent to the model as guidance, that old text would say "폴더 지정은 지원되지 않습니다" —
// actively telling the model not to do the thing this Wave adds. aiPresets.ts's parseStored()
// swaps it for the current default, once, the same way it already self-heals a list missing a
// newer built-in.
export const METADATA_PROMPT_LEGACY_V1 =
  "이 항목은 노트 본문을 분석해 제목·태그·연도·지역 메타데이터를 제안합니다(지역이 확인되면 위도·경도도 함께 조회됩니다). " +
  "실제 분석 기준은 앱에 고정되어 있어 이 텍스트를 수정해도 결과에는 반영되지 않습니다 — 이 텍스트는 참고용 설명입니다. " +
  "폴더 지정이나 월/일 단위의 정확한 날짜 추론은 현재 지원되지 않으며, 연도만 제안됩니다.";

// 관계도 만들기 (kind "diagram") — output contract: JSON IR v1
// Must produce ONLY valid JSON syntax ({ "v": 1, "nodes": [...], "edges": [...] })
// because runAiAction inserts it as a new section with kind:"diagram". Scope is owner-confirmed
// as the CURRENT NOTE'S BODY ONLY.
//
// Invariants:
// 1. Never write coordinates (`pos`): auto-layout by dagre positions them cleanly.
// 2. Clear main path with branches diverging from nearest main node.
// 3. Prune low-value edges before styling.
// 4. Edge labels carry semantic data and must not be omitted if directional/conditional.
// 5. Node count: default up to 12 (max 25 only when user explicitly asks for density).

/**
 * Pre-2026-08-12 needle kept for self-heal backward compatibility. Do not use in prompt.
 */
export const DIAGRAM_NO_ADVANCED_V1 =
  "- subgraph, classDef, style, click 같은 스타일/고급 지시문은 쓰지 마세요. 라벨 안에 <br/> 같은 HTML 태그를 쓰지 마세요.\n";

export const DIAGRAM_CREATE_VOCAB_MERMAID_V2 =
  '- 그룹: 레이어·영역·소속처럼 덩어리로 묶이는 구조가 있으면 `subgraph g1["기획팀"]` 과 `end` 로 묶으세요. 그룹 id는 g1, g2 처럼 영문·숫자로 쓰고 노드 id와 겹치지 않게 하세요. 화살표는 그룹 밖(톱레벨)에 그대로 쓰고, 그룹 자체를 화살표의 끝점으로 삼지 마세요.\n' +
  '- 아이콘·설명: 노드에 어울리는 이모지 한 글자와 한 줄 설명을 `%% brise:meta n1={"icon":"🗂","desc":"문서 보관"}` 주석으로 붙이세요(둘 다 선택 — 어울리지 않으면 그 줄을 만들지 마세요). icon 과 desc 외의 키는 쓰지 마세요.\n' +
  "- `%% brise:meta` 외의 `%% brise:` 주석은 만들지 마세요. 상자의 배치는 앱이 알아서 합니다.\n" +
  "- classDef, style, click 같은 스타일 지시문은 쓰지 마세요. 라벨 안에 <br/> 같은 HTML 태그를 쓰지 마세요.\n";

export const DIAGRAM_PROMPT_MERMAID_V1 =
  "당신은 노트에서 인물·조직·사건 등 개체와 그 사이의 관계를 추출해 mermaid 다이어그램으로 만드는 도우미입니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 노트 본문에 실제로 등장하는 인물·조직·사건만 노드로 삼으세요. 원문에 없는 인물이나 관계를 지어내지 마세요.\n" +
  "- 노트 성격에 맞는 다이어그램 종류를 고르세요: 위계·조직·소속 관계면 flowchart TD, 시간 순서나 절차면 flowchart LR, 여러 인물이 주고받은 사건·대화 흐름이면 sequenceDiagram.\n" +
  "- 모든 화살표(관계)에는 실제 관계를 라벨로 붙이세요(직위, 소속, 사건 관계 등) — 라벨 없는 화살표는 만들지 마세요.\n" +
  "- 노드 id는 영문·숫자(n1, p2 등)만 쓰고, 화면에 보이는 라벨은 노트의 언어 그대로 큰따옴표로 감싸 쓰세요.\n" +
  "- 노드는 최대 25개까지만 쓰세요. 그보다 많으면 노트에서 가장 중심이 되는 축(예: 핵심 인물 1~2명)을 골라 그 축과 직접 연결된 관계만 남기고 나머지는 과감히 생략하세요 — 전부 욱여넣지 마세요.\n\n";

/**
 * 2026-09-20 이전의 JSON IR 어휘 — 타입 힌트 블록이 붙기 전 텍스트. self-heal 의 needle 로만 쓴다
 * (`healDiagramPrompt`). 프롬프트에 직접 쓰지 마라. `DIAGRAM_CREATE_VOCAB` = 이것 + `DIAGRAM_TYPE_HINTS`.
 */
export const DIAGRAM_CREATE_VOCAB_JSON_V1 =
  "출력 포맷: JSON IR v1 (설명이나 코드 펜스 없이 순수 JSON 객체 하나만 출력)\n" +
  "{\n" +
  '  "v": 1,\n' +
  '  "route": "curve", // "curve" 또는 "orthogonal" (시스템/기술 구조도면 orthogonal)\n' +
  '  "states": ["상태1", "상태2", "상태3"], // 주제에 어울리는 상태 어휘 3~4개 (예: 논문이면 개념/근거/반론, 프로젝트면 준비/진행중/완료, 시스템이면 정상/지연/장애)\n' +
  '  "nodes": [\n' +
  '    {\n' +
  '      "id": "n1", // 영문+숫자 고유 식별자\n' +
  '      "label": "이름", // 화면에 노출될 명칭\n' +
  '      "shape": "rect", // "rect" | "round" | "stadium" | "circle" | "diamond"\n' +
  '      "icon": "🗂", // 선택: 어울리는 이모지 한 글자\n' +
  '      "desc": "한 줄 설명", // 선택: 라벨 아래 작은 설명\n' +
  '      "tag": "배지", // 선택: D-3, v1.0 등 짧은 배지\n' +
  '      "state": 0, // 선택: states 배열의 인덱스 (0..states.length-1)\n' +
  '      "flag": true, // 선택: 강조/활성 여부 boolean\n' +
  '      "group": "g1" // 선택: 소속 그룹 id\n' +
  '    }\n' +
  '  ],\n' +
  '  "edges": [\n' +
  '    {\n' +
  '      "id": "e1",\n' +
  '      "from": "n1",\n' +
  '      "to": "n2",\n' +
  '      "label": "관계 설명", // 방향/순서/인과/조건을 담은 설명\n' +
  '      "line": "solid", // "solid" | "dotted" | "dashed" | "thick" | "double"\n' +
  '      "arrow": "end" // "end" | "both" | "none"\n' +
  '    }\n' +
  '  ],\n' +
  '  "groups": [\n' +
  '    { "id": "g1", "title": "그룹 제목" }\n' +
  '  ]\n' +
  "}\n\n" +
  "논리 및 배치 규칙 (반드시 준수):\n" +
  "- 좌표(pos)는 절대 작성하지 마세요. 상자의 배치는 앱의 자동 레이아웃 엔진이 수행합니다.\n" +
  "- 명확한 주 경로(main path) 하나를 구성하고, 곁가지는 주 경로의 최근접 노드에서 분기시키세요.\n" +
  "- 라우팅/장식을 더하기 전에 가치 낮은 엣지를 먼저 제거하세요.\n" +
  "- 엣지 라벨은 시맨틱 데이터입니다. 방향·순서·인과·조건이 있으면 생략하지 마세요.\n" +
  "- 노드 수는 기본 최대 12개로 가독성을 유지하세요 (사용자가 명시적으로 밀도를 요구할 때만 최대 25개).\n";

/** 배치·구획 어휘 블록의 첫 줄 — 타입 힌트 블록과 같은 방식의 self-heal 표식(블록 통째 교체). */
const DIAGRAM_LAYOUT_VOCAB_HEAD = "배치·구획 어휘 (앱이 자동 갱신 — 유형에 맞는 배치가 있으면 layout 을 지정하세요):\n";

/**
 * PLAN-2026-09-20 W2 — `layout`/`rows`/`axes` 를 가르치는 블록. `DIAGRAM_CREATE_VOCAB_JSON_V1` 텍스트는 self-heal
 * needle 이라 손대지 않고, 이 블록을 별도 상수로 뒤에 잇는다. 배치 이름은 `diagramSchema.ts::DIAGRAM_LAYOUTS` 와
 * 같아야 한다(검증이 enum 밖을 거부하고 자동수리 루프가 고친다).
 */
export const DIAGRAM_LAYOUT_VOCAB =
  DIAGRAM_LAYOUT_VOCAB_HEAD +
  '- 최상위 "layout": "dagre"(기본, 계층) | "radial"(방사형 트리: 들어오는 엣지 없는 노드가 중심) | "lanes"(스윔레인: 그룹 = 레인) | "grid"(여정/스토리맵: 그룹 = 단계 열, 그룹 안 노드 순서 = 행) | "quadrant"(사분면: 그룹 정확히 4개, 순서 좌상·우상·좌하·우하) | "stack"(계층 스택: 노드 배열 순서 = 위→아래) | "circle"(원형 루프: 엣지를 따라간 순서로 원주) | "fishbone"(피시본: 그룹 없는 노드 = 머리, 그룹 = 원인 범주) | "sequence"(시퀀스: 노드 = 참여자 좌→우, 엣지 순서 = 시간순). 이 목록 밖의 값은 오류입니다.\n' +
  '- 노드 "rows": ["id: uuid", "email: text"] — 라벨 아래 구획 목록(ER 의 컬럼, 클래스의 멤버). 문자열 배열만.\n' +
  '- 최상위 "axes": { "x": ["왼쪽", "오른쪽"], "y": ["아래", "위"] } — layout 이 "quadrant" 일 때만 씁니다.\n' +
  '- 최상위 "type": 선택 메타(예: "er"). 배치는 layout 이 정합니다.\n';

/** 타입 힌트 블록의 첫 줄 — `healDiagramPrompt` 가 저장된 프롬프트에서 옛 블록을 찾아 통째로 바꾸는 표식. */
const DIAGRAM_TYPE_HINTS_HEAD = "관계도 유형별 힌트 (앱이 자동 갱신 — 요청이 아래 유형에 해당하면 그 규약을 따르세요):\n";

/**
 * 레지스트리(`components/diagram/types/registry.ts`)를 순회해 타입별 한 줄 힌트를 잇는다 — 타입 파일을
 * 지우면 프롬프트에서도 사라진다(PLAN-2026-09-20 §3). `aiVocab` 이 없는 타입은 나오지 않는다.
 */
export const DIAGRAM_TYPE_HINTS =
  DIAGRAM_TYPE_HINTS_HEAD + DIAGRAM_TYPES.filter((d) => d.aiVocab).map((d) => `- ${d.aiVocab}\n`).join("");

export const DIAGRAM_CREATE_VOCAB = DIAGRAM_CREATE_VOCAB_JSON_V1 + "\n" + DIAGRAM_LAYOUT_VOCAB + "\n" + DIAGRAM_TYPE_HINTS;

export const DIAGRAM_PROMPT =
  "당신은 노트에서 인물·조직·사건·개념 등 개체와 그 사이의 관계를 추출해 관계도 JSON IR v1을 작성하는 도우미입니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 노트 원문과 동일한 언어로 라벨과 텍스트를 작성하세요.\n" +
  "- 노트 본문에 실제로 등장하는 개체와 관계만 포함하세요. 원문에 없는 사실을 지어내지 마세요.\n" +
  "- 노트 주제에 맞는 상태 어휘(states)를 3~4개 정의하고 각 노드에 알맞은 state 인덱스를 배정하세요.\n" +
  "- 모든 엣지의 from과 to는 실재하는 nodes의 id를 참조해야 합니다.\n" +
  "- 노드가 속한 group은 groups 배열에 정의된 id를 참조해야 합니다.\n" +
  "- 노드에 pos(좌표) 속성을 절대 포함하지 마세요.\n\n" +
  DIAGRAM_CREATE_VOCAB +
  "\n출력 형식: 설명, 서론, 맺음말, 코드 펜스(```) 없이 오직 유효한 JSON 문자열 하나만 출력하세요.";

/**
 * Pre-2026-08-12 needles for edit prompt self-heal.
 */
export const DIAGRAM_EDIT_PRESERVE_BULLET =
  "- `%% brise:` 로 시작하는 주석 줄(`%% brise:link` = 노트 연결, `%% brise:pos` = 사용자가 직접 배치한 좌표, `%% brise:meta` = 노드 아이콘·설명)은 한 줄도 빠짐없이, 값도 순서도 그대로 보존하세요. 지우거나 고치지 마세요 — 이 줄이 사라지면 사용자가 손으로 배치한 그림이 통째로 흐트러집니다. 단, 그 줄이 가리키는 노드를 삭제하라는 요청이면 그 노드의 `%% brise:` 줄도 함께 지우세요.\n" +
  "- 새로 추가하는 노드에는 `%% brise:pos` 줄을 만들지 마세요. 좌표가 없는 노드는 앱이 알아서 배치합니다.\n";

export const DIAGRAM_EDIT_PRESERVE_BULLET_V1 =
  "- `%% brise:link` 로 시작하는 주석 줄은 노트 연결 정보입니다 — 한 줄도 빠짐없이 그대로 보존하세요. 단, 그 줄이 가리키는 노드를 삭제하라는 요청이면 해당 줄도 함께 지우세요.\n";

export const DIAGRAM_EDIT_PRESERVE_BULLET_V2 =
  "- `%% brise:` 로 시작하는 주석 줄(`%% brise:link` = 노트 연결, `%% brise:pos` = 사용자가 직접 배치한 좌표)은 한 줄도 빠짐없이, 값도 순서도 그대로 보존하세요. 지우거나 고치지 마세요 — 이 줄이 사라지면 사용자가 손으로 배치한 그림이 통째로 흐트러집니다. 단, 그 줄이 가리키는 노드를 삭제하라는 요청이면 그 노드의 `%% brise:` 줄도 함께 지우세요.\n" +
  "- 새로 추가하는 노드에는 `%% brise:pos` 줄을 만들지 마세요. 좌표가 없는 노드는 앱이 알아서 배치합니다.\n";

export const DIAGRAM_EDIT_VOCAB_MERMAID =
  '- subgraph(그룹) 구조를 임의로 해체하지 마세요. 요청이 명시적으로 그룹을 없애거나 바꾸라고 하지 않는 한 subgraph·end 줄과 그 안의 멤버 구성을 원본 그대로 두세요. 새 그룹이 필요하면 `subgraph g2["제목"]` 과 `end` 로 추가하고, 그룹을 화살표의 끝점으로 삼지 마세요.\n' +
  '- 노드 아이콘·설명은 `%% brise:meta n1={"icon":"🗂","desc":"설명"}` 형식입니다. 요청이 아이콘이나 설명을 말할 때만 이 줄을 추가·수정하세요.\n' +
  "- classDef, style, click 같은 스타일 지시문은 쓰지 마세요. 라벨 안에 <br/> 같은 HTML 태그를 쓰지 마세요.\n";

export const DIAGRAM_EDIT_PROMPT_MERMAID =
  "당신은 이미 만들어진 mermaid 관계도를 사용자의 요청대로 수정하는 도우미입니다. 새 다이어그램을 처음부터 다시 만드는 것이 아니라, 아래 [현재 관계도 소스]를 그대로 이어받아 [요청]에 해당하는 부분만 고칩니다.\n\n";

export const DIAGRAM_EDIT_PROMPT =
  "당신은 이미 만들어진 관계도 JSON IR v1을 사용자의 요청대로 수정하는 도우미입니다. 새 관계도를 처음부터 다시 만드는 것이 아니라, 아래 [현재 관계도 소스]를 그대로 이어받아 [요청]에 해당하는 부분만 고칩니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 기존 관계도 및 노트 원문과 동일한 언어로 라벨과 텍스트를 작성하세요.\n" +
  "- 요청한 변경만 정확히 적용하세요. 요청과 무관한 노드·엣지·그룹·상태 정의는 원본 그대로 보존하세요.\n" +
  "- 기존 노드 id를 함부로 바꾸지 마세요. 새로 추가하는 노드만 겹치지 않는 새 id를 받습니다.\n" +
  "- 모든 엣지의 from과 to는 실재하는 nodes의 id를 참조해야 합니다.\n" +
  "- 노드에 pos(좌표) 속성을 작성하지 마세요. (기존 pos가 있더라도 새 노드에는 추가하지 마세요)\n" +
  "- 요청을 적용할 수 없으면 원본 JSON을 그대로 출력하세요.\n\n" +
  DIAGRAM_LAYOUT_VOCAB + "\n" +
  "출력 형식: 수정된 전체 JSON IR v1 문자열만 출력하세요. 코드 펜스(```)나 설명 없이 순수 JSON만 반환하세요.";

// ── 진행 상황 갱신 (kind "diagram", id "diagram_progress") ──────────────────
export const DIAGRAM_PROGRESS_ID = "diagram_progress";

export const DIAGRAM_PROGRESS_PROMPT =
  "당신은 노트 본문(작업 일지, 진행 기록)을 분석하여 기존 관계도의 상태(state)를 갱신하는 도우미입니다.\n\n" +
  "지켜야 할 것 (구조 불변성 엄수):\n" +
  "- 기존 관계도 및 노트 원문과 동일한 언어로 라벨과 텍스트를 작성하세요.\n" +
  "- 기존 관계도의 노드 목록, 엣지 목록, 그룹 목록, 상태 목록(states)의 구조를 절대 변경하지 마세요.\n" +
  "- 노드를 추가하거나 삭제하지 마세요. 엣지를 추가하거나 삭제하지 마세요.\n" +
  "- 오직 노트 본문 내용을 바탕으로 각 노드의 `state` 번호(또는 `tag`, `flag`)만 적절히 갱신하세요.\n" +
  "- `state` 번호는 관계도에 정의된 `states` 배열의 인덱스 범위(0..states.length-1) 내여야 합니다.\n" +
  "- 변경할 진행 상황이 없다면 기존 JSON을 그대로 출력하세요.\n\n" +
  DIAGRAM_LAYOUT_VOCAB + "\n" +
  "출력 형식: 상태가 갱신된 전체 JSON IR v1 문자열만 출력하세요. 코드 펜스(```)나 설명 없이 순수 JSON만 반환하세요.";

// ── 관계도 → 할 일 추출 (kind "text", id "diagram_to_tasks") ──────────────────
export const DIAGRAM_TO_TASKS_ID = "diagram_to_tasks";
export const DIAGRAM_TO_TASKS_PROMPT =
  "당신은 관계도(토폴로지, 개체, 상태, 연결 흐름)를 분석하여 실행 가능한 세부 체크리스트를 도출하는 도우미입니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 관계도의 각 노드와 흐름(의존 관계)을 기반으로 순서에 맞게 구체적인 할 일 항목들을 작성하세요.\n" +
  "- 노드 라벨, 태그, 설명, 상태 정보를 적극 반영하세요 (예: 미완료/진행중 상태 노드는 액션 아이템화).\n" +
  "- 관계도에 언급된 고유명사와 맥락을 충실히 반영하고, 실행 가능한 동사형 표현(예: ~조사하기, ~구축하기)으로 작성하세요.\n" +
  "- 노트 원문/관계도와 동일한 언어로 작성하세요.\n" +
  "- 설명·서론·맺음말을 붙이지 마세요. 코드 펜스를 쓰지 마세요.\n\n" +
  "출력 형식 (마크다운 체크리스트만 출력):\n" +
  "- [ ] 할 일 항목";

// ── 관계도 → 구조적 문서 작성 (kind "text", id "diagram_to_article") ─────────────
export const DIAGRAM_TO_ARTICLE_ID = "diagram_to_article";
export const DIAGRAM_TO_ARTICLE_PROMPT =
  "당신은 관계도 구조(개체 간 관계, 흐름, 그룹)를 명쾌하고 논리적인 산문 보고서나 설명문으로 작성하는 도우미입니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 관계도에 표현된 전체 아키텍처나 프로세스 흐름을 서론-본론(핵심 단계별)-결론 구조로 체계화하세요.\n" +
  "- 각 노드의 역할과 연결(화살표 및 라벨)의 인과관계·데이터 흐름을 명확히 해설하세요.\n" +
  "- 사실관계를 왜곡하거나 원본 관계도에 없는 사실을 임의로 지어내지 마세요.\n" +
  "- 노트 원문/관계도와 동일한 언어로 작성하세요.\n" +
  "- 설명·서론 안내(\"작성된 글입니다\" 등)나 코드 펜스를 쓰지 마세요.\n\n" +
  "출력 형식 (깔끔한 마크다운 문서만 출력): 제목/소제목은 ##, ###, 문단 구분은 빈 줄, 주요 항목 나열은 리스트(-)를 쓰세요.";

// ── 관계도 노드 하위 단계 분기 전개 (kind "diagram", id "diagram_expand_branch") ──
export const DIAGRAM_EXPAND_BRANCH_ID = "diagram_expand_branch";
export const DIAGRAM_EXPAND_BRANCH_PROMPT =
  "당신은 관계도의 특정 노드를 바탕으로 그 하류(downstream)로 이어지는 세부 후속 단계 3~5개를 자연스럽게 확장 전개하는 도우미입니다.\n\n" +
  "지켜야 할 것:\n" +
  "- 기존 관계도 및 노트 원문과 동일한 언어로 라벨과 텍스트를 작성하세요.\n" +
  "- 지정된 기준 노드의 의미와 맥락을 파악하고, 그 노드에서 파생되는 현실적이고 논리적인 후속 노드(3~5개)와 엣지를 추가하세요.\n" +
  "- 기존의 모든 노드, 엣지, 그룹, states 배열은 온전히 유지하고, 새 노드(중복되지 않는 새 id)와 새 엣지만 덧붙이세요.\n" +
  "- 새로 추가하는 엣지의 from은 기준 노드(또는 바로 앞 단계 후속 노드)를 가리켜야 합니다.\n" +
  "- 노드에 pos(좌표) 속성은 절대 넣지 마세요.\n" +
  "- 코드 펜스나 부연 설명 없이 유효한 전체 JSON IR v1 문자열만 반환하세요.";

/**
 * SEQUENTIAL replaces, oldest needle first, so ONE pass lands a prompt persisted at ANY past version
 * on the current text (V1 → V2 → current).
 */
function healChain(prompt: string, swaps: [string, string][]): string {
  let out = prompt;
  for (const [from, to] of swaps) if (out.includes(from)) out = out.replace(from, to);
  return out;
}

export function healDiagramEditPrompt(prompt: string): string {
  // 2026-09-22 W2 needle: JSON 판이지만 배치·구획 어휘가 없던 텍스트. 정확히 일치할 때만 교체한다.
  if (prompt === DIAGRAM_EDIT_PROMPT_NO_LAYOUT_V1) return DIAGRAM_EDIT_PROMPT;
  if (prompt.includes("mermaid") || prompt.includes("%% brise:") || prompt.includes(DIAGRAM_EDIT_PRESERVE_BULLET_V1)) {
    return DIAGRAM_EDIT_PROMPT;
  }
  return healChain(prompt, [
    [DIAGRAM_EDIT_PRESERVE_BULLET_V1, DIAGRAM_EDIT_PRESERVE_BULLET_V2],
    [DIAGRAM_EDIT_PRESERVE_BULLET_V2, DIAGRAM_EDIT_PRESERVE_BULLET],
    [DIAGRAM_NO_ADVANCED_V1, DIAGRAM_EDIT_PROMPT],
  ]);
}

/** 저장된 프롬프트 안의 옛 블록(머리줄 + 이어지는 `- ` 줄들). 블록 전체를 현재 것으로 바꾼다. */
const blockRe = (head: string) => new RegExp(`\\n?${head.replace(/[()|]/g, "\\$&")}(?:- .*\\n?)*`);
const DIAGRAM_TYPE_HINTS_RE = blockRe(DIAGRAM_TYPE_HINTS_HEAD);
/** 2026-09-20 W2 needle — 배치·구획 어휘 블록도 같은 방식(없으면 붙이고, 낡았으면 통째 교체). */
const DIAGRAM_LAYOUT_VOCAB_RE = blockRe(DIAGRAM_LAYOUT_VOCAB_HEAD);

export function healDiagramPrompt(prompt: string): string {
  if (prompt.includes("mermaid") || prompt.includes("flowchart") || prompt.includes(DIAGRAM_NO_ADVANCED_V1)) {
    return DIAGRAM_PROMPT;
  }
  // 2026-09-20 needle: JSON 어휘는 그대로인데 타입 힌트 블록이 없거나(타입 힌트 도입 전 저장분) 낡았다
  // (그 뒤 타입이 늘거나 줄었다). 블록을 떼어내고 어휘 뒤에 현재 블록을 다시 붙인다 — 멱등이라 이미
  // 현재인 프롬프트는 그대로 나온다. 어휘 자체를 손본 커스텀 프롬프트는 건드리지 않는다.
  // 같은 날 W2 의 배치·구획 블록도 같은 needle 로 — 앱이 갱신하는 블록은 전부 떼어낸 뒤 한 번에 다시 붙인다.
  if (prompt.includes(DIAGRAM_CREATE_VOCAB_JSON_V1)) {
    return prompt
      .replace(DIAGRAM_TYPE_HINTS_RE, "")
      .replace(DIAGRAM_LAYOUT_VOCAB_RE, "")
      .replace(DIAGRAM_CREATE_VOCAB_JSON_V1, DIAGRAM_CREATE_VOCAB);
  }
  return prompt;
}

export function buildDiagramEditPrompt(rules: string, source: string, instruction: string): string {
  return `${rules}\n\n[현재 관계도 소스]\n${source}\n\n[요청]\n${instruction}`;
}

export function buildDiagramProgressPrompt(rules: string, source: string, noteBody: string): string {
  return `${rules}\n\n[현재 관계도 소스]\n${source}\n\n[노트 본문(진행 기록)]\n${noteBody}`;
}

export function buildDiagramExpandBranchPrompt(rules: string, source: string, targetNodeId: string, targetNodeLabel?: string): string {
  const nodeInfo = targetNodeLabel ? `"${targetNodeLabel}" (ID: ${targetNodeId})` : `노드 ID "${targetNodeId}"`;
  return `${rules}\n\n[현재 관계도 소스]\n${source}\n\n[확장 대상 기준 노드]\n${nodeInfo}\n위 기준 노드로부터 파생되는 구체적인 하류 후속 단계 3~5개와 엣지를 전개하세요.`;
}

export function stripMermaidFence(text: string): string {
  const m = text.trim().match(/^```(?:mermaid|json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  return (m ? m[1] : text).trim();
}

export const PROOFREAD_ID = "proofread";
export const DIAGRAM_EDIT_ID = "diagram_edit";

export function isDiagramEditPreset(p: AiActionPreset): boolean {
  return p.kind === "diagram" && p.id === DIAGRAM_EDIT_ID;
}

export function isDiagramProgressPreset(p: AiActionPreset): boolean {
  return p.kind === "diagram" && p.id === DIAGRAM_PROGRESS_ID;
}

export function isDiagramExpandBranchPreset(p: AiActionPreset): boolean {
  return p.kind === "diagram" && p.id === DIAGRAM_EXPAND_BRANCH_ID;
}


// ── 시트 (Sheet) 빌트인 프롬프트 ──────────────────────────────────────────
// 종류 목록은 차트 종류 id 목록(lib/sheet/types.ts CHART_TYPE_IDS — 레지스트리와 테스트로 묶임)으로 조립한다 —
// 관계도 DIAGRAM_TYPE_HINTS 와 같은 이유(W6): 타입을 지우면 이 목록에서도 자동으로 사라진다. 레지스트리
// (lib/sheet/chartTypes.ts)를 직접 import 하지 않는다 — 렌더러(recharts)가 부팅 번들에 딸려 온다.
// ponytail: 시트 프리셋에는 관계도의 healDiagramPrompt 같은 self-heal 체인이 원래 없었다 — 이번에도
// 안 만든다. 저장된 커스텀 시트 프롬프트는 새 종류 목록을 자동으로 받지 못한다(사용자가 프리셋을
// "기본값으로 되돌리기" 하거나 직접 고쳐야 한다). 필요해지면 healDiagramPrompt 패턴을 그대로 옮긴다.
export const SHEET_CHART_TYPE_LIST = CHART_TYPE_IDS.join(", ");
export const SHEET_CREATE_ID = "sheet";
export const SHEET_CREATE_PROMPT =
  "제공된 배경 내용을 바탕으로 스프레드시트 JSON을 작성하세요.\n\n" +
  "규칙:\n" +
  "- 유효한 JSON 객체 하나만 출력하세요. 설명, 인사말, 코드 펜스(```)를 절대 붙이지 마세요.\n" +
  "- 1행은 각 열의 제목을 나타내는 헤더 행으로 구성하세요 (예: A1, B1).\n" +
  '- 셀에 숫자를 입력할 때는 천 단위 쉼표(,)를 절대 포함하지 마세요 (예: "15000" (O), "15,000" (X)). 순수 숫자 형식만 허용됩니다.\n' +
  "- 수식은 Excel 호환 및 @formulajs/formulajs 지원 표준 함수 방언을 따르며 대문자(=SUM, =AVERAGE, =COUNT, =MAX, =MIN, =IF 등)로 작성하세요.\n" +
  "- raw 값에 계산 결과를 미리 적지 말고, 수식(=...) 또는 리터럴 값을 적으세요.\n" +
  `- charts[].type 은 다음 중 하나만 쓰세요: ${SHEET_CHART_TYPE_LIST}. (scatter 는 series 2개 = x,y. kpi/total 은 x 불필요)\n` +
  "- 스키마:\n" +
  '  {\n' +
  '    "v": 1,\n' +
  '    "rows": 100,\n' +
  '    "cols": [{ "fmt": "text" }, { "fmt": "currency", "cur": "KRW" }],\n' +
  '    "cells": {\n' +
  '      "A1": { "raw": "항목" },\n' +
  '      "B1": { "raw": "금액" },\n' +
  '      "A2": { "raw": "식비" },\n' +
  '      "B2": { "raw": "15000" },\n' +
  '      "A3": { "raw": "총합" },\n' +
  '      "B3": { "raw": "=SUM(B2:B2)" }\n' +
  '    },\n' +
  '    "charts": [\n' +
  '      { "id": "c1", "type": "total", "title": "총 지출", "series": ["B2:B2"] }\n' +
  '    ]\n' +
  '  }';

export const SHEET_EDIT_ID = "sheet_edit";
export const SHEET_EDIT_RULES =
  "기존 스프레드시트의 내용을 사용자의 요청에 맞게 수정하세요.\n\n" +
  "규칙:\n" +
  "- 전체 시트 JSON 하나를 온전하게 출력하세요. 코드 펜스(```)나 설명 없이 순수 JSON만 반환하세요.\n" +
  "- 1행은 각 열의 헤더(제목)로 유지하세요.\n" +
  '- 셀에 숫자를 입력할 때는 천 단위 쉼표(,)를 절대 포함하지 마세요 (예: "15000" (O), "15,000" (X)). 순수 숫자 형식만 허용됩니다.\n' +
  "- 수식은 Excel 호환 및 @formulajs/formulajs 지원 표준 함수 방언을 따르며 대문자(=SUM, =AVERAGE, =IF 등)를 사용하세요.\n" +
  "- 기존의 행·열 구조와 서식을 최대한 유지하면서 요청된 셀 값, 수식, 차트 항목을 변경/추가/삭제하세요.\n" +
  `- charts[].type 은 다음 중 하나만 쓰세요: ${SHEET_CHART_TYPE_LIST}.`;

export function isSheetEditPreset(p: AiActionPreset): boolean {
  return p.kind === "sheet" && p.id === SHEET_EDIT_ID;
}

export function buildSheetEditPrompt(currentJson: string, instruction: string): string {
  return `${SHEET_EDIT_RULES}\n\n[기존 시트 JSON]\n${currentJson}\n\n[사용자 요청]\n${instruction}`;
}

export function stripJsonFence(text: string): string {
  const m = text.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  return (m ? m[1] : text).trim();
}

export function stripTextFence(text: string): string {
  const m = text.trim().match(/^```(?:html|markdown|md|text)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  return (m ? m[1] : text).trim();
}


// ── Agent plan guidance (editable half) ──────────────────────────────────────
// Used by stores/aiAgentActions.ts for split / folder / workspace plan generation.
// Same pattern as METADATA_PROMPT: this text is guidance only; the JSON schema
// contract (empty skeleton) is owned by the app and appended at call time —
// models must not be given filled "Topic 1 Title" placeholders (they copy them).
//
// These are built-ins so Settings > AI actions can edit them, but they are NOT
// run via runAiAction (different output contract: AiPlan JSON, not HTML/mermaid).
// Menus use menuActionPresets() which excludes them; isAgentPlanPreset guards
// accidental dispatch.
export type AgentPlanPresetId = "agent_split" | "agent_folder" | "agent_workspace" | "agent_merge";

export const AGENT_PLAN_IDS: readonly AgentPlanPresetId[] = [
  "agent_split",
  "agent_folder",
  "agent_workspace",
  "agent_merge",
] as const;

export function isAgentPlanPreset(p: { id: string }): boolean {
  return (AGENT_PLAN_IDS as readonly string[]).includes(p.id);
}

/** 사이드바 챗 전용 빌트인 — 설정 AI 작업과 같은 생명주기, 변환 메뉴에는 안 뜬다. */
export type ChatBuiltinPresetId =
  | "ask_note"
  | "find_related"
  | "fill_note"
  | "rename_plan"
  | "prune_plan";

export const CHAT_BUILTIN_IDS: readonly ChatBuiltinPresetId[] = [
  "ask_note",
  "find_related",
  "fill_note",
  "rename_plan",
  "prune_plan",
] as const;

export function isChatBuiltinPreset(p: { id: string }): boolean {
  return (CHAT_BUILTIN_IDS as readonly string[]).includes(p.id);
}

/** 에이전트 계획형 챗 프리셋 — 채팅 문구로 계획만 요청하고 삭제를 실행하지 않는다. */
export function isChatPlanPreset(p: { id: string }): boolean {
  return isAgentPlanPreset(p) || p.id === "fill_note" || p.id === "rename_plan" || p.id === "prune_plan";
}

// 에이전트 계획 기본 지침 4종의 원문은 `specs/ai/prompts/agent/*.md` 가 SSOT 다(PLAN-2026-10-08 §7 W0).
// Vite `?raw` 로 바이트 그대로 읽는다 — 파일은 끝 개행이 없고 LF 다(.gitattributes). 고치면 저장된 사용자
// 재정의와의 정확 일치 비교가 달라지므로, 문구 변경은 별도 결정이다. 동일성 고정: aiPromptFiles.test.ts.
// agent_workspace id는 내부 식별자 유지(= 노트북 재편). 사용자/모델 문구만 노트북 용어.
// agent_merge: P2 2단계 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — 펫이 겹침을 이미 감지해 넘긴
// "정확히 이 두 노트" 쌍을 평가한다. agent_folder 와 달리 후보를 고르는 게 아니라 이미 정해진
// 한 쌍의 병합 여부만 판단한다.
import AGENT_SPLIT_PROMPT from "../../specs/ai/prompts/agent/split.md?raw";
import AGENT_FOLDER_PROMPT from "../../specs/ai/prompts/agent/folder.md?raw";
import AGENT_WORKSPACE_PROMPT from "../../specs/ai/prompts/agent/workspace.md?raw";
import AGENT_MERGE_PROMPT from "../../specs/ai/prompts/agent/merge.md?raw";

// 사이드바 챗 빌트인 — 클릭 즉시 pet_chat 사용자 메시지로 보낸다. fill/rename/prune 은
// 계획만 요청하고 삭제·본문 덮어쓰기를 실행하지 않는다(툴 칩 실행은 T4).
const ASK_NOTE_PROMPT =
  "지금 보고 있는 노트를 읽고 무엇을 다루는지 설명해 주세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 핵심 주장·사실·열린 질문만 짧게 정리하세요. 원문에 없는 내용을 지어내지 마세요.\n" +
  "- 노트와 같은 언어로 답하세요.\n" +
  "- 노트를 만들거나 수정·삭제하지 마세요. 설명만 하세요.";

const FIND_RELATED_PROMPT =
  "지금 보고 있는 노트와 관련된 다른 노트를 찾아 주세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 제목·태그·내용이 겹치는 것을 우선하세요. 검색으로 근거를 찾고 연결 이유를 한 줄씩 달아 주세요.\n" +
  "- 원문에 없는 노트를 지어내지 마세요. 없으면 없다고 말하세요.\n" +
  "- 노트를 만들거나 수정·삭제하지 마세요.";

const FILL_NOTE_PROMPT =
  "지금 보고 있는 노트에 반영할 수정 계획을 세워 주세요. 본문을 직접 덮어쓰지 마세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 추가·수정·삭제할 문장을 항목으로 제안만 하세요. 실행은 사용자가 확인한 뒤에만 합니다.\n" +
  "- 원문에 없는 사실을 지어내지 마세요. 확신이 약한 항목은 빼세요.\n" +
  "- 삭제·개명·본문 덮어쓰기를 지금 실행하지 마세요. JSON 도구 호출을 가장한 삭제도 하지 마세요.";

const RENAME_PLAN_PROMPT =
  "이 노트북의 노트 제목을 더 찾기 쉽게 다듬는 이름 정리 계획을 세워 주세요. 실제 개명은 하지 마세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 각 항목에 현재 제목, 제안 제목, 짧은 이유를 적으세요.\n" +
  "- 확신이 약한 항목은 빼세요. 목록에 없는 노트를 만들어내지 마세요.\n" +
  "- 지금 제목을 바꾸거나 노트를 삭제하지 마세요. 계획만 제시하세요.";

const PRUNE_PLAN_PROMPT =
  "이 노트북에서 비었거나 중복이거나 쓸모없는 노트를 정리·제거하는 계획을 세워 주세요. 실제 삭제나 휴지통 이동은 하지 마세요.\n\n" +
  "지켜야 할 것:\n" +
  "- 각 항목에 대상 제목과 이유만 적으세요.\n" +
  "- 기본으로 선택된 항목은 두지 마세요 — 전부 미선택 제안입니다.\n" +
  "- 지금 노트를 지우거나 옮기지 마세요. 계획만 제시하세요.";


export interface EngineInstructionDef {
  id: string;
  nameKey: string;
  prompt: string;
  kind: AiActionKind;
}

export type BuiltinDef = EngineInstructionDef;

/**
 * PLAN-2026-09-27 §7.1 & Q5(b) 앱 내부 지침(엔진 지침 16개).
 * 관계도/시트 JSON 규칙, 에이전트 계획, 메타데이터 기준 등 앱 내부에서 사용하는 장문 시스템 프롬프트.
 * AI 프리셋 목록(요청 문장 템플릿)에서 완전히 분리되어 설정 > AI > 고급 섹션에서 관리된다.
 */
export const ENGINE_INSTRUCTION_DEFS: EngineInstructionDef[] = [
  { id: "metadata", nameKey: "ai.action_default_name_metadata", prompt: METADATA_PROMPT, kind: "metadata" },
  { id: "diagram", nameKey: "ai.action_default_name_diagram", prompt: DIAGRAM_PROMPT, kind: "diagram" },
  { id: DIAGRAM_EDIT_ID, nameKey: "ai.action_default_name_diagram_edit", prompt: DIAGRAM_EDIT_PROMPT, kind: "diagram" },
  { id: DIAGRAM_PROGRESS_ID, nameKey: "ai.action_default_name_diagram_progress", prompt: DIAGRAM_PROGRESS_PROMPT, kind: "diagram" },
  { id: DIAGRAM_EXPAND_BRANCH_ID, nameKey: "ai.action_default_name_diagram_expand_branch", prompt: DIAGRAM_EXPAND_BRANCH_PROMPT, kind: "diagram" },
  { id: SHEET_CREATE_ID, nameKey: "ai.action_default_name_sheet", prompt: SHEET_CREATE_PROMPT, kind: "sheet" },
  { id: SHEET_EDIT_ID, nameKey: "ai.action_default_name_sheet_edit", prompt: SHEET_EDIT_RULES, kind: "sheet" },

  // Agent plan guidance — kind "text" satisfies Rust allowlist; not run via runAiAction.
  { id: "agent_split", nameKey: "ai.action_default_name_agent_split", prompt: AGENT_SPLIT_PROMPT, kind: "text" },
  { id: "agent_folder", nameKey: "ai.action_default_name_agent_folder", prompt: AGENT_FOLDER_PROMPT, kind: "text" },
  { id: "agent_workspace", nameKey: "ai.action_default_name_agent_workspace", prompt: AGENT_WORKSPACE_PROMPT, kind: "text" },
  { id: "agent_merge", nameKey: "ai.action_default_name_agent_merge", prompt: AGENT_MERGE_PROMPT, kind: "text" },
  { id: "ask_note", nameKey: "ai.action_default_name_ask_note", prompt: ASK_NOTE_PROMPT, kind: "text" },
  { id: "find_related", nameKey: "ai.action_default_name_find_related", prompt: FIND_RELATED_PROMPT, kind: "text" },
  { id: "fill_note", nameKey: "ai.action_default_name_fill_note", prompt: FILL_NOTE_PROMPT, kind: "text" },
  { id: "rename_plan", nameKey: "ai.action_default_name_rename_plan", prompt: RENAME_PLAN_PROMPT, kind: "text" },
  { id: "prune_plan", nameKey: "ai.action_default_name_prune_plan", prompt: PRUNE_PLAN_PROMPT, kind: "text" },
];

/**
 * 텍스트 변환 장문 4종 — AI 프리셋(타일 문장)으로는 은퇴했지만, 입력창 없이 바로 실행하는 표면(모바일 AI 시트,
 * 사이드바 챗 프리셋)과 AI 기능 카탈로그(`lib/aiCapabilities.ts`)가 여전히 이 실행 목록을 쓴다.
 */
export const LEGACY_TEXT_DEFS: BuiltinDef[] = [
  { id: "list", nameKey: "ai.action_default_name_list", prompt: LIST_PROMPT, kind: "text" },
  { id: "organize", nameKey: "ai.action_default_name_organize", prompt: ORGANIZE_PROMPT, kind: "text" },
  { id: "summarize", nameKey: "ai.action_default_name_summarize", prompt: SUMMARIZE_PROMPT, kind: "text" },
  { id: PROOFREAD_ID, nameKey: "ai.action_default_name_proofread", prompt: PROOFREAD_PROMPT, kind: "text" },
];

/**
 * 바로 실행하는 빌트인 액션 전부(텍스트 변환 4 + 엔진 지침 16) — 2026-09-27 이전의 BUILTIN_DEFS 와 같은 모양.
 * AI 프리셋 목록(요청 문장 타일, `components/ai/askAiPresets.ts`)과는 다른 목록이다. 엔진 지침의 **실제 문장**은
 * 사용자 재정의를 반영하는 `stores/aiInstructions.getEngineInstruction` 이 소유한다 — 여기 prompt 는 기본값.
 */
export const BUILTIN_DEFS: BuiltinDef[] = [...LEGACY_TEXT_DEFS, ...ENGINE_INSTRUCTION_DEFS];

/**
 * 2026-09-22 감사 후속(W2) 이전에 저장된 텍스트 프리셋 원문 — **정확 일치 치유의 needle 로만** 쓴다.
 *
 * 왜 필요한가: `aiPresets.ts` 헤더가 적어 둔 대로, 사용자가 AI 액션을 **하나라도** 편집하면 그 순간
 * 빌트인까지 포함한 목록 전체가 통째로 저장된다. 그래서 손대지 않은 `list`/`organize`/`summarize`/
 * `proofread` 도 저 옛 문구("순수 HTML 조각만 출력")를 그대로 들고 있고, 치유가 없으면 마크다운
 * 전환이 그런 설치에는 **영원히 내려가지 않는다** — 저장된 "마크다운 문법을 쓰지 마세요"와 새
 * 시스템 프롬프트("markdown allowed")가 서로 모순된 채 모델에 실린다.
 *
 * `METADATA_PROMPT_LEGACY_V1` 과 같은 자세로 **정확히 일치할 때만** 현재 기본값으로 바꾼다.
 * `"순수 HTML"` 같은 부분 문자열 검사로 넓히지 않는 이유: 그 문구 주변을 손본 사용자의 진짜
 * 커스터마이즈까지 날아간다(`parseStored` 의 "surgical rather than a whole-prompt reset" 주석).
 */
export const TEXT_PROMPT_LEGACY_HTML_V1: Record<string, string> = {
  list: "당신은 노트 정리를 돕는 도우미입니다. 아래 노트 내용을 항목별 리스트로 재구성하세요.\n\n목표: 문단으로 흩어진 정보를 한눈에 훑어볼 수 있는 리스트 구조로 바꿉니다.\n\n지켜야 할 것:\n- 날짜·이름·수치·고유명사 등 원문의 모든 사실과 세부사항을 빠짐없이 보존하세요. 원문에 없는 내용을 지어내지 마세요.\n- 복문/장문은 뜻이 하나인 단위로 쪼개, 각 항목이 한 가지 사실 또는 할 일만 담게 하세요. 원문 표현이 이미 자연스러우면 그대로 쓰고, 불필요하게 다시 쓰지 마세요.\n- 항목이 해야 할 일/행동(예: 준비할 것, TODO, 다음에 할 일)이면 체크리스트로 만들고, 단순 정보 나열이면 글머리 기호 리스트로 만드세요. 판단이 애매하면 체크리스트를 기본으로 쓰세요.\n- 노트 원문과 동일한 언어로 답하세요(번역 금지).\n\n하지 말아야 할 것: 설명·서론·맺음말을 붙이지 마세요. 마크다운 문법(-, *, 1. 등)을 쓰지 마세요. 코드 펜스(```)를 쓰지 마세요.\n\n출력 형식(순수 HTML 조각만 출력, 이 형식 외에는 아무것도 출력하지 마세요):\n- 글머리 기호 리스트: <ul><li>항목</li>...</ul>\n- 체크리스트: <ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><label><input type=\"checkbox\"></label><div><p>항목</p></div></li>...</ul>\n- 두 형식이 함께 필요하면 각각 별도의 <ul> 블록으로 나누세요.",
  organize: "당신은 노트 정리를 돕는 도우미입니다. 아래 노트 내용을 더 읽기 쉽게 다듬어 재구성하세요. 요약이 아니라 정리이므로 분량을 임의로 크게 줄이지 마세요.\n\n지켜야 할 것:\n- 날짜·이름·수치·인용 등 모든 사실관계를 그대로 보존하세요. 원문에 없는 내용을 지어내지 마세요.\n- 맞춤법·비문·중복된 표현을 정리하고, 관련 있는 문장끼리 문단으로 묶으세요. 원문에 이미 있던 구조(리스트, 단락 구분, 순서)는 최대한 존중하세요.\n- 원문의 말투와 표현이 이미 자연스러운 부분은 그대로 유지하세요.\n- 노트 원문과 동일한 언어로 답하세요(번역 금지).\n\n하지 말아야 할 것: 설명·서론·맺음말(\"정리한 내용입니다\" 등)을 붙이지 마세요. 마크다운 문법을 쓰지 마세요. 코드 펜스를 쓰지 마세요.\n\n출력 형식(순수 HTML 조각만 출력): 문단은 <p>...</p>, 나열이 자연스러운 부분만 <ul><li>...</li></ul>를 쓰세요. 강조가 꼭 필요할 때만 <strong>을 쓰세요.",
  summarize: "당신은 노트 요약을 돕는 도우미입니다. 아래 노트 내용을 핵심만 남겨 요약하세요.\n\n목표: 원문을 읽지 않아도 무슨 내용인지 파악할 수 있는 간결한 요약을 만듭니다.\n\n지켜야 할 것:\n- 날짜·이름·수치·고유명사 등 핵심 사실은 반드시 보존하세요. 원문에 없는 내용을 추측하거나 지어내지 마세요.\n- 부차적인 세부사항과 반복, 군더더기는 과감히 생략하되 문맥 이해에 필요한 정보는 남기세요.\n- 원문이 여러 주제를 다루면 주제별로 문단이나 항목을 나누세요.\n- 노트 원문과 동일한 언어로 답하세요(번역 금지).\n\n하지 말아야 할 것: \"요약하면\", \"다음은 요약입니다\" 같은 서론/맺음말을 붙이지 마세요. 마크다운 문법을 쓰지 마세요. 코드 펜스를 쓰지 마세요.\n\n출력 형식(순수 HTML 조각만 출력): 짧으면 <p>...</p> 한두 문단으로, 핵심 포인트가 여러 개면 <ul><li>...</li></ul> 리스트로 정리하세요.",
  proofread: "당신은 맞춤법 교정을 돕는 도우미입니다. 아래 글의 맞춤법·띄어쓰기·오타·명백한 비문만 고쳐 그대로 다시 출력하세요.\n\n지켜야 할 것:\n- 내용·순서·구조·말투를 바꾸지 마세요. 문장을 합치거나 나누지 말고, 요약하거나 덧붙이지 마세요.\n- 고칠 곳이 없는 문장은 원문 그대로 두세요.\n- 원문과 동일한 언어로 답하세요(번역 금지).\n\n하지 말아야 할 것: 무엇을 고쳤는지 설명하지 마세요. 서론·맺음말을 붙이지 마세요. 마크다운 문법·코드 펜스를 쓰지 마세요.\n\n출력 형식(순수 HTML 조각만 출력): 문단은 <p>...</p>, 원문이 리스트면 <ul><li>...</li></ul> 로 원문의 구조를 그대로 유지하세요.",
};

/** 저장된 텍스트 프리셋이 옛 HTML 판과 정확히 같으면 현재 마크다운 기본값으로 바꾼다. */
export function healTextPrompt(id: string, prompt: string): string {
  const legacy = TEXT_PROMPT_LEGACY_HTML_V1[id];
  if (legacy === undefined || prompt !== legacy) return prompt;
  return BUILTIN_DEFS.find((d) => d.id === id)?.prompt ?? prompt;
}

/**
 * 관계도 수정·진행 프롬프트의 2026-09-22 이전 판 — 배치·구획 어휘(layout enum)와 라벨 언어 규칙이
 * 없던 텍스트. 검증기는 enum 밖 `layout` 을 거부하는데 프롬프트가 그 목록을 알려주지 않으면
 * 수리 시도만 태운다.
 */
export const DIAGRAM_EDIT_PROMPT_NO_LAYOUT_V1 = "당신은 이미 만들어진 관계도 JSON IR v1을 사용자의 요청대로 수정하는 도우미입니다. 새 관계도를 처음부터 다시 만드는 것이 아니라, 아래 [현재 관계도 소스]를 그대로 이어받아 [요청]에 해당하는 부분만 고칩니다.\n\n지켜야 할 것:\n- 요청한 변경만 정확히 적용하세요. 요청과 무관한 노드·엣지·그룹·상태 정의는 원본 그대로 보존하세요.\n- 기존 노드 id를 함부로 바꾸지 마세요. 새로 추가하는 노드만 겹치지 않는 새 id를 받습니다.\n- 모든 엣지의 from과 to는 실재하는 nodes의 id를 참조해야 합니다.\n- 노드에 pos(좌표) 속성을 작성하지 마세요. (기존 pos가 있더라도 새 노드에는 추가하지 마세요)\n- 요청을 적용할 수 없으면 원본 JSON을 그대로 출력하세요.\n\n출력 형식: 수정된 전체 JSON IR v1 문자열만 출력하세요. 코드 펜스(```)나 설명 없이 순수 JSON만 반환하세요.";
export const DIAGRAM_PROGRESS_PROMPT_NO_LAYOUT_V1 = "당신은 노트 본문(작업 일지, 진행 기록)을 분석하여 기존 관계도의 상태(state)를 갱신하는 도우미입니다.\n\n지켜야 할 것 (구조 불변성 엄수):\n- 기존 관계도의 노드 목록, 엣지 목록, 그룹 목록, 상태 목록(states)의 구조를 절대 변경하지 마세요.\n- 노드를 추가하거나 삭제하지 마세요. 엣지를 추가하거나 삭제하지 마세요.\n- 오직 노트 본문 내용을 바탕으로 각 노드의 `state` 번호(또는 `tag`, `flag`)만 적절히 갱신하세요.\n- `state` 번호는 관계도에 정의된 `states` 배열의 인덱스 범위(0..states.length-1) 내여야 합니다.\n- 변경할 진행 상황이 없다면 기존 JSON을 그대로 출력하세요.\n\n출력 형식: 상태가 갱신된 전체 JSON IR v1 문자열만 출력하세요. 코드 펜스(```)나 설명 없이 순수 JSON만 반환하세요.";

/** 진행 상황 갱신 프리셋 치유 — 정확 일치할 때만 현재 기본값으로. */
export function healDiagramProgressPrompt(prompt: string): string {
  return prompt === DIAGRAM_PROGRESS_PROMPT_NO_LAYOUT_V1 ? DIAGRAM_PROGRESS_PROMPT : prompt;
}

export function builtinDefault(id: string): AiActionPreset | null {
  const def = BUILTIN_DEFS.find((d) => d.id === id);
  if (!def) return null;
  return { id: def.id, name: t(def.nameKey), prompt: def.prompt, kind: def.kind, isBuiltin: true, hidden: false };
}

export function builtinDefaults(): AiActionPreset[] {
  return BUILTIN_DEFS.map((d) => builtinDefault(d.id)!);
}

/** Fields ai_organize_note actually supports (commands/ai.rs::ai_organize_note_inner) — see
 *  METADATA_PROMPT's comment for what's deliberately still NOT here (month/day precision). */
export const AI_METADATA_FIELDS = ["title", "tags", "year", "region", "folder"] as const;
