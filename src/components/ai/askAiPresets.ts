/**
 * AI에게 묻기 — 대상별 타일 목록 (PLAN-2026-09-15-askai-composer §2.1·§4).
 *
 * 옛 `AskAiModal.tsx` 의 `baseChips` 배열(대상 종류별 칩 + 각 칩이 보내던 한국어 프롬프트)을
 * 데이터로 이관했다. 타일은 실행 버튼이 아니라 **문장 스탬프**(D4)라 여기엔 onClick 이 없고,
 * `prompt` 가 곧 템플릿이다 — 슬롯 `{{lang}}` `{{n=5}}` `{{tone}}` `{{text:…}}`. 컨텍스트는 문장에
 * 들어가지 않고(6안 D17) `needs` 가 선언한다 — 스탬프할 때 컨텍스트 줄에 없으면 모달이 더한다.
 *
 * 배열 순서 = 화면 순서. 한 프롬프트는 한 프리셋이고 여러 대상에 뜨면 `targets` 가 여럿이다.
 * 기존 빌트인과 같은 일을 하는 타일은 **같은 id** 를 쓴다(summarize·metadata·proofread·diagram·
 * list·agent_split·diagram_to_tasks…) — 설정의 hidden/이름 재정의와 AI 글로우가 그 id 로 붙는다.
 *
 * ponytail: 프롬프트는 여전히 한국어 리터럴(UI 라벨만 i18n). 로케일 분리는 별도 결정(§2.1).
 */
import type { ComponentType } from "react";
import { t } from "../../i18n/t";
import type { AiActionKind, AiActionPreset, AskAiKind, AskAiProposal, AskAiWhere } from "../../stores/aiPrompts";
import type { CtxKind } from "./composer/types";
import { DIAGRAM_EXPAND_BRANCH_ID, DIAGRAM_TO_ARTICLE_ID, DIAGRAM_TO_TASKS_ID, PROOFREAD_ID } from "../../stores/aiPrompts";
import { noteIconComp } from "../../lib/noteIcons";
import {
  IconAi,
  IconAlignLeft,
  IconAsterisk,
  IconBulletList,
  IconChart,
  IconChat,
  IconCheck,
  IconDoc,
  IconEye,
  IconFeather,
  IconFmtNumber,
  IconGraph,
  IconH1,
  IconMinus,
  IconPlus,
  IconScissors,
  IconSheet,
  IconSparkles,
  IconSpellCheck,
  IconSummary,
  IconTable,
  IconTag,
  IconTranslate,
  type IconProps,
} from "../icons";

interface TileDef {
  id: string;
  /** 타일 라벨(2~4자) 키. */
  labelKey: string;
  /** 전체 이름 키 — aria-label·title. */
  nameKey: string;
  icon: string;
  kind: AiActionKind;
  targets: AskAiKind[];
  prompt: string;
  where?: AskAiWhere;
  proposal?: AskAiProposal;
  needs?: CtxKind[];
  /** 빈 노트·빈 시트에서만 노출되는 시작 프리셋 여부(PLAN-2026-09-27 §7-5). */
  blank?: boolean;
}

/** 대상의 본문을 먹는 프리셋 — 모달이 대상에 맞는 참조(본문/선택/섹션)로 바꿔 넣는다(D17). */
const BODY: CtxKind[] = ["body"];

const DEFS: TileDef[] = [
  // ── 선택 영역: 교정·간결·톤·번역·요약·키워드·목록·표 ─────────────────────────────
  {
    id: PROOFREAD_ID,
    labelKey: "ai.tile_proofread",
    nameKey: "ai.chip_sel_proofread",
    icon: "spell-check",
    kind: "text",
    targets: ["selection", "note", "section"],
    prompt: "다음 텍스트의 맞춤법, 띄어쓰기, 문법 오류를 교정하고 자연스럽게 다듬어줘",
    needs: BODY,
  },
  {
    id: "sel_concise",
    labelKey: "ai.tile_sel_concise",
    nameKey: "ai.chip_sel_concise",
    icon: "minus",
    kind: "text",
    targets: ["selection"],
    prompt: "다음 텍스트를 핵심만 남겨 더 간결하고 명확하게 다듬어줘",
    needs: BODY,
  },
  {
    // 옛 "전문적인 톤으로" — 톤이 슬롯이 되어 정중/격식 외 톤도 같은 타일이 맡는다.
    id: "sel_tone",
    labelKey: "ai.tile_sel_tone",
    nameKey: "ai.name_sel_tone",
    icon: "feather",
    kind: "text",
    targets: ["selection"],
    prompt: "다음 텍스트를 {{tone}} 톤으로 다듬어줘",
    needs: BODY,
  },
  {
    id: "translate",
    labelKey: "ai.tile_translate",
    nameKey: "ai.translate",
    icon: "languages",
    kind: "text",
    targets: ["selection", "note", "section"],
    prompt: "다음 내용을 {{lang}}로 자연스럽게 번역해줘. 번역문만 써줘.",
    needs: BODY,
  },
  {
    id: "summarize",
    labelKey: "ai.tile_summarize",
    nameKey: "ai.summarize",
    icon: "file-text",
    kind: "text",
    targets: ["selection", "note", "section"],
    prompt: "다음 텍스트의 핵심 내용을 간결하게 요약해줘",
    needs: BODY,
  },
  {
    id: "keywords",
    labelKey: "ai.tile_keywords",
    nameKey: "ai.chip_sel_keywords",
    icon: "asterisk",
    kind: "text",
    targets: ["selection", "note"],
    prompt: "다음 텍스트에서 가장 중요한 핵심 키워드와 개념들을 추출해줘",
    needs: BODY,
  },
  {
    id: "list",
    labelKey: "ai.tile_list",
    nameKey: "ai.chip_sel_bullets",
    icon: "list",
    kind: "text",
    targets: ["selection", "note", "section"],
    prompt: "다음 텍스트를 구조화된 불릿 목록(- 항목)으로 정리해줘",
    needs: BODY,
  },
  {
    id: "table",
    labelKey: "ai.tile_table",
    nameKey: "ai.chip_sel_table",
    icon: "table",
    kind: "text",
    targets: ["selection", "note"],
    prompt: "다음 텍스트의 항목과 데이터를 깔끔한 Markdown 표로 정리해줘",
    needs: BODY,
  },

  // ── 노트: 메타·태그·요약·번역·분리·관계도·구조·다듬기·키워드·표·할 일·질문 ─────────────
  // (요약·번역·키워드·표는 위 공용 프리셋의 targets 로 이미 노트에 뜬다.)
  {
    id: "metadata",
    labelKey: "ai.tile_metadata",
    nameKey: "ai.action_default_name_metadata",
    icon: "sparkles",
    kind: "metadata",
    targets: ["note"],
    where: "proposal",
    proposal: "metadata",
    prompt: "노트 본문을 분석해 제목·태그·연도·지역·폴더를 제안해줘",
  },
  {
    id: "tags",
    labelKey: "ai.tile_tags",
    nameKey: "ai.chip_tags",
    icon: "tag",
    kind: "metadata",
    targets: ["note"],
    where: "proposal",
    proposal: "tags",
    prompt: "노트를 나중에 다시 찾을 때 검색할 법한 핵심어 위주로 태그를 제안해줘",
  },
  {
    id: "agent_split",
    labelKey: "ai.tile_agent_split",
    nameKey: "ai.split_note_proposal",
    icon: "scissors",
    kind: "text",
    targets: ["note"],
    where: "proposal",
    proposal: "split",
    prompt: "노트에 서로 다른 주제가 섞여 있으면 주제별로 나눈 새 노트 초안을 제안해줘",
  },
  {
    id: "diagram",
    labelKey: "ai.tile_diagram",
    nameKey: "ai.chip_section_diagram",
    icon: "network",
    kind: "diagram",
    targets: ["note", "section"],
    prompt: "다음 내용에 등장하는 인물·조직·사건과 그 사이의 관계를 관계도로 만들어줘",
    needs: BODY,
  },
  {
    id: "restructure",
    labelKey: "ai.tile_restructure",
    nameKey: "ai.chip_note_restructure",
    icon: "align-left",
    kind: "text",
    targets: ["note"],
    where: "note",
    prompt: "현재 노트 전체의 흐름을 분석하고 목차와 구조를 체계적으로 재정리해줘",
    needs: BODY,
  },
  {
    // 옛 섹션 칩 "섹션 내 문장의 맞춤법을 교정하고 자연스럽게 다듬어줘" — 노트에도 뜨도록 "섹션 내" 만 뺐다.
    id: "polish",
    labelKey: "ai.tile_polish",
    nameKey: "ai.chip_section_proofread",
    icon: "spell-check",
    kind: "text",
    targets: ["note", "section"],
    prompt: "문장의 맞춤법을 교정하고 자연스럽게 다듬어줘",
    needs: BODY,
  },
  {
    id: "todo",
    labelKey: "ai.tile_todo",
    nameKey: "ai.name_todo",
    icon: "check-square",
    kind: "text",
    targets: ["note"],
    prompt: "다음 내용에서 해야 할 일을 추출해 체크리스트로 만들어줘",
    needs: BODY,
  },
  {
    id: "ask",
    labelKey: "ai.tile_ask",
    nameKey: "ai.name_ask",
    icon: "message-circle",
    kind: "text",
    targets: ["note"],
    prompt: "{{text:질문}}",
  },
  {
    id: "start_text",
    labelKey: "ai.tile_start_text",
    nameKey: "ai.action_start_text",
    icon: "file-text",
    kind: "text",
    targets: ["note"],
    blank: true,
    prompt: "다음 주제로 글 작성을 시작해줘: {{text:주제}}",
  },
  {
    id: "auto_footnote",
    labelKey: "ai.tile_auto_footnote",
    nameKey: "ai.chip_auto_footnote",
    icon: "asterisk",
    kind: "tool",
    targets: ["note", "section"],
    prompt: "",
    needs: BODY,
  },

  // ── 관계도: 전개·할 일·보고서·정렬·단순화·노드 추가·번역 ─────────────────────────────
  {
    id: DIAGRAM_EXPAND_BRANCH_ID,
    labelKey: "ai.tile_diagram_expand_branch",
    nameKey: "ai.chip_diagram_expand",
    icon: "network",
    kind: "diagram",
    targets: ["diagram"],
    where: "replace",
    prompt: "선택한 노드의 하위 흐름을 전개해서 관계도에 추가해줘",
  },
  {
    id: DIAGRAM_TO_TASKS_ID,
    labelKey: "ai.tile_todo",
    nameKey: "ai.chip_diagram_tasks",
    icon: "check-square",
    kind: "text",
    targets: ["diagram"],
    prompt: "관계도의 노드와 관계에서 해야 할 일을 추출해 체크리스트로 만들어줘",
    needs: BODY,
  },
  {
    id: DIAGRAM_TO_ARTICLE_ID,
    labelKey: "ai.tile_diagram_to_article",
    nameKey: "ai.chip_diagram_article",
    icon: "file-text",
    kind: "text",
    targets: ["diagram"],
    prompt: "관계도의 구조와 흐름을 설명하는 보고서를 써줘",
    needs: BODY,
  },
  {
    id: "diagram_align",
    labelKey: "ai.tile_diagram_align",
    nameKey: "ai.chip_diagram_align",
    icon: "align-left",
    kind: "diagram",
    targets: ["diagram"],
    where: "replace",
    prompt: "다이어그램 노드와 배치를 읽기 쉽게 자동 정렬해줘",
  },
  {
    id: "diagram_simplify",
    labelKey: "ai.tile_diagram_simplify",
    nameKey: "ai.chip_diagram_simplify",
    icon: "minus",
    kind: "diagram",
    targets: ["diagram"],
    where: "replace",
    prompt: "다이어그램의 복잡한 연결을 단순화하고 핵심만 남겨줘",
  },
  {
    id: "diagram_add_node",
    labelKey: "ai.tile_diagram_add_node",
    nameKey: "ai.chip_diagram_add_node",
    icon: "plus",
    kind: "diagram",
    targets: ["diagram"],
    where: "replace",
    prompt: "새로운 흐름 노드를 추가해줘: {{text:노드 설명}}",
  },
  {
    id: "diagram_translate",
    labelKey: "ai.tile_translate",
    nameKey: "ai.translate",
    icon: "languages",
    kind: "diagram",
    targets: ["diagram"],
    where: "replace",
    prompt: "다이어그램 내의 모든 노드 라벨과 텍스트를 {{lang}}로 번역해줘",
  },
  {
    id: "diagram_progress",
    labelKey: "ai.tile_diagram_progress",
    nameKey: "ai.chip_diagram_progress",
    icon: "network",
    kind: "tool",
    targets: ["diagram"],
    where: "replace",
    prompt: "",
  },

  // ── 시트: 합계·수식·서식·이상치·헤더·피벗·표·번역·헤더 번역 ──────────────────────────
  {
    id: "start_sheet",
    labelKey: "ai.tile_start_sheet",
    nameKey: "ai.action_start_sheet",
    icon: "table",
    kind: "sheet",
    targets: ["sheet"],
    blank: true,
    prompt: "다음 주제로 표나 시트 작성을 시작해줘: {{text:주제}}",
  },
  {
    id: "sheet_sum",
    labelKey: "ai.tile_sheet_sum",
    nameKey: "ai.chip_sheet_sum",
    icon: "hash",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "하단에 숫자 열들의 합계(SUM) 및 평균 행을 추가해줘",
  },
  {
    id: "sheet_formula",
    labelKey: "ai.tile_sheet_formula",
    nameKey: "ai.chip_sheet_formula",
    icon: "asterisk",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "수식 계산 열을 추가해줘: {{text:수식 설명}}",
  },
  {
    id: "sheet_format",
    labelKey: "ai.tile_sheet_format",
    nameKey: "ai.chip_sheet_format",
    icon: "sparkles",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "금액 및 숫자 데이터 열의 서식과 단위를 일관되게 정리해줘",
  },
  {
    id: "sheet_outliers",
    labelKey: "ai.tile_sheet_outliers",
    nameKey: "ai.chip_sheet_outliers",
    icon: "eye",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "시트 내 빈 셀, 중복 데이터 및 이상치(Outlier)를 검증하고 정리해줘",
  },
  {
    id: "sheet_headers",
    labelKey: "ai.tile_sheet_headers",
    nameKey: "ai.chip_sheet_headers",
    icon: "heading",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "시트의 헤더(열 이름)를 표준 명명 규칙에 맞게 명확히 다듬어줘",
  },
  {
    id: "sheet_pivot",
    labelKey: "ai.tile_sheet_pivot",
    nameKey: "ai.chip_sheet_pivot",
    icon: "chart",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "시트 데이터를 주요 범주별로 그룹화하여 요약 통계 테이블을 작성해줘",
  },
  {
    // Markdown 표는 시트 JSON 이 아니라 텍스트 결과 — 새 섹션으로 간다.
    id: "sheet_table",
    labelKey: "ai.tile_table",
    nameKey: "ai.chip_sheet_table",
    icon: "table",
    kind: "text",
    targets: ["sheet"],
    prompt: "현재 시트의 데이터를 깔끔한 Markdown 표 형식으로 변환해줘",
    needs: BODY,
  },
  {
    id: "sheet_translate",
    labelKey: "ai.tile_translate",
    nameKey: "ai.translate",
    icon: "languages",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "시트의 텍스트와 열 헤더를 {{lang}}로 번역하고 표 구조를 유지해줘",
  },
  {
    id: "sheet_translate_headers",
    labelKey: "ai.tile_sheet_translate_headers",
    nameKey: "ai.chip_sheet_translate_headers",
    icon: "languages",
    kind: "sheet",
    targets: ["sheet"],
    where: "replace",
    prompt: "시트의 열 이름(헤더)을 {{lang}} 및 글로벌 비즈니스 표준 용어로 번역해줘",
  },

  // ── 텍스트 섹션: 요약·번역·관계도·다듬기·구조 (앞 넷은 공용 프리셋의 targets) ─────────
  {
    id: "section_restructure",
    labelKey: "ai.tile_restructure",
    nameKey: "ai.chip_section_restructure",
    icon: "align-left",
    kind: "text",
    targets: ["section"],
    prompt: "섹션의 내용을 적절한 소제목과 단락으로 재구성해줘",
    needs: BODY,
  },
];

/** 내장 타일 전부 — 라벨·이름은 호출 시점 로케일로 푼다(모듈 상수로 두면 언어 변경을 못 따라간다). */
export function askAiBuiltinTiles(): AiActionPreset[] {
  return DEFS.map((d, index) => ({
    id: d.id,
    name: t(d.nameKey),
    prompt: d.prompt,
    kind: d.kind,
    isBuiltin: true,
    hidden: false,
    label: t(d.labelKey),
    icon: d.icon,
    targets: d.targets,
    where: d.where ?? "section",
    proposal: d.proposal,
    needs: d.needs,
    blank: d.blank,
    order: index,
  }));
}

/**
 * 대상별 기본 화면 순서(하위 호환 및 초기값 생성용).
 * PLAN-2026-09-27 §7-1·Q7에 따라 저장소 `ai_action_presets`의 순서가 단일 SSOT가 된다.
 */
export const ASKAI_TILE_ORDER: Record<AskAiKind, readonly string[]> = {
  selection: [PROOFREAD_ID, "sel_concise", "sel_tone", "translate", "summarize", "keywords", "list", "table"],
  note: ["start_text", "metadata", "tags", "summarize", "translate", "agent_split", "diagram", "restructure", "polish", "proofread", "keywords", "table", "list", "todo", "auto_footnote", "ask"],
  diagram: [DIAGRAM_EXPAND_BRANCH_ID, DIAGRAM_TO_TASKS_ID, DIAGRAM_TO_ARTICLE_ID, "diagram_align", "diagram_simplify", "diagram_add_node", "diagram_translate", "diagram_progress"],
  sheet: ["start_sheet", "sheet_sum", "sheet_formula", "sheet_format", "sheet_outliers", "sheet_headers", "sheet_pivot", "sheet_table", "sheet_translate", "sheet_translate_headers"],
  section: ["summarize", "translate", "diagram", "polish", "proofread", "list", "section_restructure", "auto_footnote"],
};

/**
 * 내장 타일의 **기본 단일 순서** — 대상별 옛 순서(ASKAI_TILE_ORDER)를 노트 → 섹션 → 선택 → 관계도 → 시트 순으로 이어
 * 붙이고, 어느 순서에도 없는 타일을 DEFS 순서로 끝에 둔다. AI 프리셋 저장소의 처음 목록(stores/aiPresets
 * `builtinDefaults`)과, 목록에 없는 타일을 끝에 붙일 때(`tilesForTarget`) 같은 순서를 쓴다.
 */
export function defaultTileOrder(): AiActionPreset[] {
  const tiles = askAiBuiltinTiles();
  const byId = new Map(tiles.map((p) => [p.id, p]));
  const out: AiActionPreset[] = [];
  const seen = new Set<string>();
  const push = (p: AiActionPreset | undefined) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    out.push(p);
  };
  for (const kind of ["note", "section", "selection", "diagram", "sheet"] as const) {
    for (const id of ASKAI_TILE_ORDER[kind]) push(byId.get(id));
  }
  for (const p of tiles) push(p);
  return out;
}

/** 옛 커스텀 프리셋(targets 없음)이 뜨던 자리 — 노트·텍스트 섹션 칩 목록에만 섞여 있었다. */
const LEGACY_CUSTOM_TARGETS: readonly AskAiKind[] = ["note", "section"];

/**
 * 대상 종류별 타일 — **저장된 AI 프리셋 목록의 순서 그대로**(단일 순서, PLAN-2026-09-27 §7-1·Q7). 대상으로 거르기만
 * 하고 순서를 바꾸지 않는다. 내장은 DEFS 의 모양(아이콘·대상·위치·필요 참조)에 저장된 이름과 문장(사용자가 고친 요청
 * 문장)을 얹는다. 목록에 아직 없는 내장 타일(옛 목록·테스트 고정값)은 끝에 DEFS 순서로 붙인다.
 * `isBlank` — 빈 노트·빈 시트면 시작 프리셋(`blank`)만, 아니면 시작 프리셋을 뺀다.
 * 타일이 없는 빌트인 id(바로 실행 액션의 숨김 자리, stores/aiPresets `isActionSlot`)는 보이지 않는다.
 */
export function tilesForTarget(kind: AskAiKind, presets: AiActionPreset[], isBlank = false): AiActionPreset[] {
  const defaults = defaultTileOrder();
  const builtinMap = new Map(defaults.map((p) => [p.id, p]));
  const out: AiActionPreset[] = [];
  const seen = new Set<string>();
  const consider = (p: AiActionPreset) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    if (p.hidden || p.kind === "template") return;
    const tile = p.isBuiltin ? builtinMap.get(p.id) : undefined;
    if (p.isBuiltin && !tile) return;
    const item: AiActionPreset = tile ? { ...tile, name: p.name || tile.name, prompt: p.prompt.trim() ? p.prompt : tile.prompt } : p;
    if (Boolean(item.blank) !== isBlank) return;
    const targets = item.targets ?? LEGACY_CUSTOM_TARGETS;
    if (!targets.includes(kind)) return;
    out.push(item);
  };
  for (const p of presets) consider(p);
  for (const tile of defaults) consider(tile);
  return out;
}

/** 프리셋 → 스탬프 템플릿. 도구(tool) 항목은 읽기 전용 설명을 돌려준다(PLAN-2026-09-27 §7-5). */
export function resolveTemplateForPreset(p: AiActionPreset, _kind: AskAiKind): string {
  if (p.kind === "tool") {
    if (p.id === "auto_footnote") {
      return t("ai.auto_footnote_desc") || "본문의 용어에 각주를 답니다.";
    }
    if (p.id === "diagram_progress") {
      return t("aiCapabilities.diagram_progress_reads") || "노트 본문(로그)을 읽어 관계도의 상태(state)를 갱신합니다.";
    }
  }
  return p.prompt;
}

// 타일 아이콘 어휘 — 노트 아이콘 팔레트(noteIconComp)에 없는 UI 아이콘만 여기서 덧댄다.
const UI_ICONS: Record<string, ComponentType<IconProps>> = {
  "spell-check": IconSpellCheck,
  minus: IconMinus,
  plus: IconPlus,
  feather: IconFeather,
  languages: IconTranslate,
  "file-text": IconDoc,
  summary: IconSummary,
  asterisk: IconAsterisk,
  list: IconBulletList,
  table: IconTable,
  sparkles: IconSparkles,
  tag: IconTag,
  scissors: IconScissors,
  network: IconGraph,
  "align-left": IconAlignLeft,
  "check-square": IconCheck,
  "message-circle": IconChat,
  hash: IconFmtNumber,
  eye: IconEye,
  heading: IconH1,
  chart: IconChart,
};

const KIND_ICONS: Record<AiActionKind, ComponentType<IconProps>> = {
  text: IconSparkles,
  metadata: IconAi,
  diagram: IconGraph,
  template: IconDoc,
  sheet: IconSheet,
  tool: IconSparkles,
};

/** 아이콘 이름 → 컴포넌트. UI 어휘 → 노트 아이콘 팔레트 → kind 기본 순으로 푼다. */
export function tileIcon(name: string | undefined, kind: AiActionKind): ComponentType<IconProps> {
  const fallback = KIND_ICONS[kind] ?? IconSparkles;
  if (!name) return fallback;
  return UI_ICONS[name] ?? noteIconComp(name, fallback);
}
