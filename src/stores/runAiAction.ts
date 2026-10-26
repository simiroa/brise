import { emitNotice, flushAll, call } from "../lib/invoke";
import { t } from "../i18n/t";
import { useAiStore, ensureAiAskGate, AI_GLOW_KEYS, isEditorGlowSuppressed, type TranslateLang } from "./ai";
import type { AiTranslateTextOutput } from "../lib/commands.gen";
import { getActiveSection, insertAiSection, getDiagramTarget, getSheetTarget, formatDiagramAsContext } from "../lib/aiSectionBridge";
import { runWithAiResultGate, aiResultTarget, type AiGenerateOutcome } from "./aiResultGate";
import {
  type AiActionPreset,
  AI_METADATA_FIELDS,
  isDiagramEditPreset,
  isDiagramProgressPreset,
  isDiagramExpandBranchPreset,
  isSheetEditPreset,
  isAgentPlanPreset,
  isChatBuiltinPreset,
  buildDiagramEditPrompt,
  buildDiagramProgressPrompt,
  buildDiagramExpandBranchPrompt,
  buildSheetEditPrompt,
  stripMermaidFence,
  stripJsonFence,
  stripTextFence,
} from "./aiPrompts";
import {
  parseDiagramJson,
  validateDiagramModel,
  sanitizeDiagramAiOutput,
  isDiagramStructureEqual,
  serializeDiagram,
  type DiagramModel,
  type DiagramNode,
} from "../components/diagram/diagramSchema";
import { parseSheet, serializeSheet, type SheetDoc } from "../lib/sheet/types";
import { usedBounds } from "../lib/sheet/ops";
import { colToLetters, formatRange, refKey } from "../lib/sheet/a1";

/**
 * Single entry point both desktop and mobile call to run a preset against the active note — this
 * is the "logic lives in the store, not the component" piece HANDOFF asks for.
 *
 * No required ctx: text-kind actions read/write the active section through lib/aiSectionBridge,
 * the same generic getter/inserter pub-sub EditorPanel already registers into (see that file's
 * header comment) — any editor (desktop's EditorPanel today, mobile's editor once it registers
 * the same two hooks) is reachable through it without this function needing to know which one is
 * live. `ctx` is only an escape hatch for a caller that isn't wired into that bridge.
 */
export interface AiActionCtx {
  contextText: string;
  // Signature mirrors lib/aiSectionBridge.ts's public insertAiSection exactly (aiOrigin lives in
  // the opts object there, not a bare positional string) — every real caller here passes
  // insertAiSection itself as this field, so the two types must line up or the aiOrigin plumbed
  // through runAiAction below silently lands on the wrong parameter at runtime.
  insertSection: (
    name: string,
    body_md: string,
    targetNoteId: string,
    kind?: "text" | "diagram" | "sheet",
    opts?: { postProcess?: boolean; aiOrigin?: string },
  ) => Promise<unknown>;
  /**
   * Note the AI request targets. Captured by the caller (or by runAiAction from activeNote
   * before the generate await) so a mid-flight note switch cannot land the result on B —
   * same class of bug lastProposalNoteId fixes on the metadata path (stores/ai.ts).
   */
  targetNoteId?: string;
  /**
   * 빈 `contextText` 를 정상으로 볼지(AUDIT-2026-09-22 후속). 기본은 false —
   * 빈 섹션에 변환 액션을 거는 것은 여전히 막아야 한다("결과가 비었습니다").
   *
   * AskAi 의 관계도·시트 **생성**만 true 다. 그쪽은 W2 에서 사용자의 요청문이 `contextText`
   * 에서 `preset.prompt` 로 옮겨갔기 때문에, 참조 칩을 하나도 켜지 않으면 `contextText` 가
   * 합법적으로 빈 문자열이 된다 — `AskAiModal` 의 새 노트 대상은 `ctxList` 가 빈 배열로
   * 시작하고 전송 버튼도 참조를 요구하지 않으므로 이게 기본 경로다. 그때 빈 값을 거절하면
   * "A가 B를 관리하는 관계도 그려줘" 같은 요청이 모델 호출 0회로 조용히 죽는다.
   * 센티넬 문자열로 채우지 않는 이유: 그 문자열이 그대로 모델 입력에 실려 W2 가 걷어낸
   * 군더더기가 되돌아온다.
   */
  allowEmptyContext?: boolean;
  /**
   * 관계도 수정하기 (DIAGRAM_EDIT_ID) / 진행 상황 갱신 target
   */
  diagram?: {
    sectionId?: string;
    source: string;
    instruction?: string;
    /** diagram_expand_branch — 선택 노드(lib/aiSectionBridge.ts::DiagramTarget 과 같은 필드). */
    selectedNodeId?: string;
    selectedNodeLabel?: string;
    replaceSection: (body_md: string) => Promise<void>;
    /** K5(2026-09-06) — §2 B-2 재대조용 라이브 게터. 데스크톱 경로는 getDiagramTarget()을 다시
     * 불러 항상 신선하지만, ctx로 target을 주입하는 경로(모바일)는 이게 없으면 캡처해 둔 스냅샷을
     * 자기 자신과 비교해 staleness를 절대 못 본다 — 이 필드가 있으면 그것으로 "지금" 값을 다시
     * 읽는다. 없으면(기존 호출부) 주입된 target을 그대로 쓰는 이전 동작 그대로. */
    getLive?: () => { sectionId?: string; source: string } | null;
  };
  /**
   * 시트 수정하기 (SHEET_EDIT_ID) target
   */
  sheet?: {
    sectionId?: string;
    source: string;
    instruction?: string;
    replaceSection: (body_md: string) => Promise<void>;
    /** K5 — diagram과 동일한 재대조용 라이브 게터. */
    getLive?: () => { sectionId?: string; source: string } | null;
  };
}

// WG(2026-09-06) G2 — 백엔드 AI_GENERATE_INPUT_CHAR_CAP(src-tauri/src/repo/ai/mod.rs,
// generate_from_prompt_inner)의 프런트 미러. 이 캡을 넘는 노트에서 액션을 누르면 백엔드가 즉시
// VALIDATION으로 실패하긴 하지만(45s 대기 없음), 사용자에겐 "왜 실패했는지"가 결과 게이트조차
// 뜨지 않은 채로는 안 보인다 — 게이트를 열기 전에 미리 재서 이유를 알려준다.
//
// 이 파일의 모든 게이트 경로가 실제로 부르는 커맨드는 `ai_generate_from_prompt` 하나뿐이다
// (diagram_edit/diagram_progress/diagram_expand_branch/sheet_edit도 자체 프롬프트를 만들어
// generateFromPrompt에 실어 보낸다 — generateDiagramWithRepair가 그 위에 한 겹 쌓일 뿐, 결국
// 같은 커맨드) — `ai_cleanup_text`/`ai_translate_text`(AI_TEXT_CHAR_CAP=8192, 조용히 절단)는 이
// 파일이 부르지 않는다(stores/ai.ts의 cleanupText/translateNow가 별도 경로). 그래서 캡은
// generate 하나뿐이고, 액션별로 갈리는 건 "무엇이 prompt+context로 합쳐지는가"뿐이다.
//
// ponytail: 값을 커맨드로 노출하지 않고 리터럴로 미러한다(드리프트 천장 — AiResultModal.tsx의
// TEXT_OPERATION_DEADLINE_MS 미러와 같은 자세). 백엔드 상수가 바뀌는데 이 리터럴을 깜빡하면
// 안내가 실제 캡보다 느슨/엄격해질 뿐 데이터가 새지는 않는다(최종 판정은 언제나 백엔드) —
// 드리프트가 실제 문제가 되면 값을 반환하는 커맨드로 승격한다.
const AI_GENERATE_INPUT_CHAR_CAP = 32_000;

/** Rust `chars().count()`(코드 포인트 수)를 미러 — JS `.length`(UTF-16 코드 유닛)는 서로게이트
 * 쌍(이모지 등)에서 실제보다 크게 세어 드물게 과잉 차단할 수 있다. */
function codePointLength(s: string): number {
  return [...s].length;
}

/** 넘으면 안내하고 true(호출부는 게이트를 열지 않고 곧장 false를 반환해야 한다). 백엔드와 같은
 * 판정식 — prompt(trim)와 context(원문)의 합. */
function noticeIfGenerateInputTooLong(prompt: string, context: string | null | undefined): boolean {
  const total = codePointLength(prompt.trim()) + codePointLength(context ?? "");
  if (total <= AI_GENERATE_INPUT_CHAR_CAP) return false;
  emitNotice(
    t("aiResult.preflight_input_too_long_notice", {
      chars: total.toLocaleString(),
      cap: AI_GENERATE_INPUT_CHAR_CAP.toLocaleString(),
    }),
  );
  return true;
}

export interface DiagramRepairResult {
  ok: boolean;
  json?: string;
  model?: DiagramModel;
  attempts: number;
  lastRaw?: string;
  errors?: string[];
}

/** 활성 노트 제목(있으면) — AiResultModal 헤더의 `— "…"` 부분. 없어도 게이트는 그냥 연다. */
async function currentNoteTitle(): Promise<string | undefined> {
  const { useNotesStore } = await import("./notes");
  const title = useNotesStore.getState().activeNote?.note.title;
  // 새 노트의 저장된 제목은 센티널 "Untitled Note"(notesActive.displayTitle 과 같은 판정) — 그대로 넘기면 결과 창
  // 제목이 한국어 화면에서도 영어로 "Untitled Note" 가 됐다(2026-10-07 S22). 비었으면 undefined → 결과 창이
  // aiResult.modal_title_untitled 로 그린다.
  return title && title.trim() && title !== "Untitled Note" ? title : undefined;
}

/**
 * §2 B-2 재대조 — [삽입] 직전에 대상 섹션이 대기 중 바뀌지 않았는지 다시 본다. 관계도 수정·진행
 * 갱신·분기 전개·시트 수정 4분기가 공유한다. `getLive`는 데스크톱 경로에서는 다시
 * getDiagramTarget()/getSheetTarget()를 불러 지금 화면에 실제 붙어 있는 섹션을 보고, ctx로
 * target이 명시 주입된 경로(모바일·테스트)는 K5(2026-09-06)부터 `target.getLive`가 있으면 그걸로
 * "지금" 값을 다시 읽는다(모바일은 `MobileAiSheet`가 `getActiveSection()`을 다시 불러 채운다) —
 * `getLive`가 없는 호출부(기존 테스트 등)는 이전처럼 주입된 target 스냅샷을 그대로 돌려준다.
 */
/** K5(2026-09-06) — ctx로 주입된 target(모바일·테스트)의 "지금" 스냅샷. `getLive`가 있으면 그걸로
 * sectionId/source만 다시 읽어 원래 target(replaceSection 등 나머지 필드는 그대로)과 합친다 —
 * `getLive`가 null을 돌려주면(섹션이 사라짐) 이 함수도 null. `getLive`가 없는 호출부는 이전처럼
 * 주입된 target 자체를 그대로 돌려준다(기존 동작 불변). */
function liveInjectedTarget<
  T extends { sectionId?: string; source: string; getLive?: () => { sectionId?: string; source: string } | null },
>(target: T): T | null {
  if (!target.getLive) return target;
  const live = target.getLive();
  return live ? { ...target, ...live } : null;
}

async function applyIfFresh<T extends { sectionId?: string; source: string }>(
  getLive: () => T | null,
  start: { sectionId?: string; source: string },
  doApply: (live: T) => Promise<void>,
): Promise<boolean> {
  const live = getLive();
  if (!live || live.sectionId !== start.sectionId || live.source !== start.source) {
    emitNotice(t("aiResult.stale_section_notice"));
    return false;
  }
  await doApply(live);
  return true;
}

export interface SheetRepairResult {
  ok: boolean;
  doc?: SheetDoc;
  json?: string;
  attempts: number;
  lastRaw?: string;
  errors?: string[];
}

export async function generateDiagramWithRepair(
  prompt: string,
  contextText: string | null,
  maxAttempts: number = 3,
  onAttempt?: (attempt: number, maxAttempts: number) => void,
  requestId?: string,
  presetId?: string,
  existingDiagram?: DiagramModel | DiagramNode[] | null,
): Promise<DiagramRepairResult> {
  const aiStore = useAiStore.getState();
  let currentPrompt = prompt;
  let attempts = 0;
  let lastRaw = "";
  let lastErrors: string[] = [];

  while (attempts < maxAttempts) {
    attempts++;
    onAttempt?.(attempts, maxAttempts);
    const generated = await aiStore.generateFromPrompt(
      currentPrompt,
      contextText,
      { requestId, presetId, purpose: "json" },
    );
    if (generated === null) {
      lastErrors = ["AI generation request failed"];
      break;
    }
    if (!generated.trim()) {
      lastErrors = ["Empty AI response"];
      lastRaw = "";
      currentPrompt = `${prompt}\n\n[이전 시도 실패: 빈 응답이 반환되었습니다. 유효한 JSON IR v1 형식으로 다시 생성하세요.]`;
      continue;
    }

    const cleaned = stripMermaidFence(generated);
    lastRaw = cleaned;
    const model = parseDiagramJson(cleaned);
    const validation = validateDiagramModel(model);

    if (validation.valid) {
      const sanitized = sanitizeDiagramAiOutput(model, existingDiagram);
      const json = serializeDiagram(sanitized);
      return {
        ok: true,
        json,
        model: sanitized,
        attempts,
        lastRaw,
      };
    }

    lastErrors = validation.errors;
    const feedbackHeader =
      `${prompt}\n\n[이전 출력 유효성 검사 실패 (${attempts}회차)]\n` +
      `다음 오류를 수정한 올바른 JSON IR v1을 다시 작성하세요:\n` +
      validation.errors.map((e) => `- ${e}`).join("\n") +
      `\n\n[이전 출력]\n`;

    const contextLen = codePointLength(contextText ?? "");
    const headerLen = codePointLength(feedbackHeader);
    const maxRawChars = Math.max(0, AI_GENERATE_INPUT_CHAR_CAP - headerLen - contextLen - 50);

    let trimmedRaw = cleaned;
    if (codePointLength(trimmedRaw) > maxRawChars) {
      trimmedRaw = [...trimmedRaw].slice(0, maxRawChars).join("") + "\n...(truncated)";
    }
    currentPrompt = feedbackHeader + trimmedRaw;
  }

  return {
    ok: false,
    attempts,
    lastRaw,
    errors: lastErrors,
  };
}

export async function generateSheetWithRepair(
  prompt: string,
  contextText: string | null,
  maxAttempts: number = 3,
  onAttempt?: (attempt: number, maxAttempts: number) => void,
  requestId?: string,
  presetId?: string,
): Promise<SheetRepairResult> {
  const aiStore = useAiStore.getState();
  let currentPrompt = prompt;
  let attempts = 0;
  let lastRaw = "";
  let lastErrors: string[] = [];

  while (attempts < maxAttempts) {
    attempts++;
    onAttempt?.(attempts, maxAttempts);
    const generated = await aiStore.generateFromPrompt(
      currentPrompt,
      contextText,
      { requestId, presetId, purpose: "json" },
    );
    if (generated === null) {
      lastErrors = ["AI generation request failed"];
      break;
    }
    if (!generated.trim()) {
      lastErrors = ["Empty AI response"];
      lastRaw = "";
      currentPrompt = `${prompt}\n\n[이전 시도 실패: 빈 응답이 반환되었습니다. 유효한 스프레드시트 JSON 형식으로 다시 생성하세요.]`;
      continue;
    }

    const cleaned = stripJsonFence(generated);
    lastRaw = cleaned;
    const parsed = parseSheet(cleaned);

    if (parsed) {
      return {
        ok: true,
        doc: parsed,
        json: serializeSheet(parsed),
        attempts,
        lastRaw,
      };
    }

    lastErrors = ["Invalid sheet JSON schema or parse failure"];
    const feedbackHeader =
      `${prompt}\n\n[이전 출력 유효성 검사 실패 (${attempts}회차)]\n` +
      `스프레드시트 JSON 파싱 또는 스키마 검증에 실패했습니다. 유효한 SheetDoc v1 JSON을 다시 작성하세요:\n` +
      `- 유효한 JSON 구문이어야 합니다.\n` +
      `- cells 객체는 필수이며, 각 셀 키는 "A1", "B2"와 같은 정규 A1 형식이어야 합니다.\n` +
      `- 각 셀 객체는 { "raw": "..." } 문자열 값을 반드시 가져야 합니다.\n\n` +
      `[이전 출력]\n`;

    const contextLen = codePointLength(contextText ?? "");
    const headerLen = codePointLength(feedbackHeader);
    const maxRawChars = Math.max(0, AI_GENERATE_INPUT_CHAR_CAP - headerLen - contextLen - 50);

    let trimmedRaw = cleaned;
    if (codePointLength(trimmedRaw) > maxRawChars) {
      trimmedRaw = [...trimmedRaw].slice(0, maxRawChars).join("") + "\n...(truncated)";
    }
    currentPrompt = feedbackHeader + trimmedRaw;
  }

  return {
    ok: false,
    attempts,
    lastRaw,
    errors: lastErrors,
  };
}

async function runDiagramEdit(preset: AiActionPreset, target: AiActionCtx["diagram"]): Promise<boolean> {
  const diagTarget = target ?? getDiagramTarget();
  if (!diagTarget || !diagTarget.source.trim()) {
    emitNotice(t("ai.diagram_edit_no_section"));
    return false;
  }
  const instruction = (diagTarget.instruction ?? "").trim();
  if (!instruction) {
    emitNotice(t("ai.diagram_edit_no_instruction"));
    return false;
  }
  // §2 B-2 재대조용 시작 스냅샷 — [삽입] 시점에 이걸 지금의 라이브 target과 비교한다.
  const startSnapshot = { sectionId: diagTarget.sectionId, source: diagTarget.source };
  const getLiveDiagramTarget = () => (target ? liveInjectedTarget(target) : getDiagramTarget());

  // G2 — 실제로 generateFromPrompt에 실릴 prompt를 한 번 만들어 캡을 확인하고, 그대로 재사용한다
  // (생성 콜백 안에서 다시 만들면 같은 문자열을 두 번 만드는 셈이다).
  const editPrompt = buildDiagramEditPrompt(preset.prompt, diagTarget.source, instruction);
  if (noticeIfGenerateInputTooLong(editPrompt, null)) return false;

  const aiStore = useAiStore.getState();
  const actionKey = AI_GLOW_KEYS.action(preset.id);
  const diagramKey = diagTarget.sectionId ? AI_GLOW_KEYS.diagram(diagTarget.sectionId) : null;

  aiStore.addGlow(actionKey);
  if (diagramKey) aiStore.addGlow(diagramKey);

  try {
    return await runWithAiResultGate(
      { title: preset.name, target: aiResultTarget.replaceDiagram(), kind: "diagram", noteTitle: await currentNoteTitle(), replacesExisting: true },
      async (requestId, onAttempt): Promise<AiGenerateOutcome<string>> => {
        const origModel = parseDiagramJson(diagTarget.source);
        const res = await generateDiagramWithRepair(editPrompt, null, 3, onAttempt, requestId, preset.id, origModel);
        if (!res.ok || !res.json) {
          const errorMsg = t("ai.diagram_validation_failed", {
            attempts: res.attempts,
            errors: res.errors?.join(", ") ?? "Invalid JSON syntax",
          });
          const fullError = `${errorMsg}\n\n${res.lastRaw ?? ""}`.trim();
          emitNotice(fullError);
          return { ok: false, error: fullError };
        }
        // Replaces this section's body — an edit is never a new section.
        return { ok: true, raw: res.json, preview: res.json };
      },
      (json) => applyIfFresh(getLiveDiagramTarget, startSnapshot, (live) => live.replaceSection(json)),
    );
  } finally {
    aiStore.removeGlow(actionKey);
    if (diagramKey) aiStore.removeGlow(diagramKey);
  }
}

async function runDiagramProgress(
  preset: AiActionPreset,
  target: AiActionCtx["diagram"],
  contextText?: string,
): Promise<boolean> {
  const diagTarget = target ?? getDiagramTarget();
  if (!diagTarget || !diagTarget.source.trim()) {
    emitNotice(t("ai.diagram_progress_no_section"));
    return false;
  }

  let noteBody = (contextText ?? "").trim();
  if (!noteBody) {
    const notesStore = (await import("./notes")).useNotesStore.getState();
    const activeNote = notesStore.activeNote;
    if (activeNote) {
      const textSections = activeNote.sections.filter((s) => s.kind !== "diagram");
      noteBody = textSections.map((s) => s.body_md).join("\n\n").trim();
    }
  }

  if (!noteBody) {
    emitNotice(t("editor.ai_empty_result"));
    return false;
  }
  // §2 B-2 재대조용 시작 스냅샷.
  const startSnapshot = { sectionId: diagTarget.sectionId, source: diagTarget.source };
  const getLiveDiagramTarget = () => (target ? liveInjectedTarget(target) : getDiagramTarget());

  // G2 — 캡 체크용으로 한 번 만들고 그대로 재사용.
  const progressPrompt = buildDiagramProgressPrompt(preset.prompt, diagTarget.source, noteBody);
  if (noticeIfGenerateInputTooLong(progressPrompt, null)) return false;

  const aiStore = useAiStore.getState();
  const actionKey = AI_GLOW_KEYS.action(preset.id);
  const diagramKey = diagTarget.sectionId ? AI_GLOW_KEYS.diagram(diagTarget.sectionId) : null;

  aiStore.addGlow(actionKey);
  if (diagramKey) aiStore.addGlow(diagramKey);

  try {
    return await runWithAiResultGate(
      { title: preset.name, target: aiResultTarget.replaceDiagram(), kind: "diagram", noteTitle: await currentNoteTitle(), replacesExisting: true },
      async (requestId, onAttempt): Promise<AiGenerateOutcome<string>> => {
        const origModel = parseDiagramJson(diagTarget.source);
        const res = await generateDiagramWithRepair(
          progressPrompt,
          null,
          3,
          onAttempt,
          requestId,
          preset.id,
          origModel,
        );
        if (!res.ok || !res.json) {
          const errorMsg = t("ai.diagram_validation_failed", {
            attempts: res.attempts,
            errors: res.errors?.join(", ") ?? "Invalid JSON syntax",
          });
          const fullError = `${errorMsg}\n\n${res.lastRaw ?? ""}`.trim();
          emitNotice(fullError);
          return { ok: false, error: fullError };
        }

        const newModel = parseDiagramJson(res.json);
        if (!isDiagramStructureEqual(origModel, newModel)) {
          const msg = t("ai.diagram_progress_structure_changed");
          emitNotice(msg);
          return { ok: false, error: msg };
        }

        return { ok: true, raw: res.json, preview: res.json };
      },
      (json) => applyIfFresh(getLiveDiagramTarget, startSnapshot, (live) => live.replaceSection(json)),
    );
  } finally {
    aiStore.removeGlow(actionKey);
    if (diagramKey) aiStore.removeGlow(diagramKey);
  }
}

async function runDiagramExpandBranch(preset: AiActionPreset, target: AiActionCtx["diagram"]): Promise<boolean> {
  const diagTarget = target ?? getDiagramTarget();
  if (!diagTarget || !diagTarget.source.trim()) {
    emitNotice(t("ai.diagram_edit_no_section"));
    return false;
  }
  const targetNodeId = diagTarget.selectedNodeId;
  if (!targetNodeId) {
    emitNotice("하위 단계를 확장할 노드를 먼저 선택해 주세요.");
    return false;
  }
  // §2 B-2 재대조용 시작 스냅샷.
  const startSnapshot = { sectionId: diagTarget.sectionId, source: diagTarget.source };
  const getLiveDiagramTarget = () => (target ? liveInjectedTarget(target) : getDiagramTarget());

  // G2 — 캡 체크용으로 한 번 만들고 그대로 재사용.
  const expandBranchPrompt = buildDiagramExpandBranchPrompt(preset.prompt, diagTarget.source, targetNodeId, diagTarget.selectedNodeLabel);
  if (noticeIfGenerateInputTooLong(expandBranchPrompt, null)) return false;

  const aiStore = useAiStore.getState();
  const actionKey = AI_GLOW_KEYS.action(preset.id);
  const diagramKey = diagTarget.sectionId ? AI_GLOW_KEYS.diagram(diagTarget.sectionId) : null;

  aiStore.addGlow(actionKey);
  if (diagramKey) aiStore.addGlow(diagramKey);

  try {
    return await runWithAiResultGate(
      { title: preset.name, target: aiResultTarget.replaceDiagram(), kind: "diagram", noteTitle: await currentNoteTitle(), replacesExisting: true },
      async (requestId, onAttempt): Promise<AiGenerateOutcome<string>> => {
        const origModel = parseDiagramJson(diagTarget.source);
        const res = await generateDiagramWithRepair(expandBranchPrompt, null, 3, onAttempt, requestId, preset.id, origModel);
        if (!res.ok || !res.json) {
          const errorMsg = t("ai.diagram_validation_failed", {
            attempts: res.attempts,
            errors: res.errors?.join(", ") ?? "Invalid JSON syntax",
          });
          const fullError = `${errorMsg}\n\n${res.lastRaw ?? ""}`.trim();
          emitNotice(fullError);
          return { ok: false, error: fullError };
        }
        return { ok: true, raw: res.json, preview: res.json };
      },
      (json) => applyIfFresh(getLiveDiagramTarget, startSnapshot, (live) => live.replaceSection(json)),
    );
  } finally {
    aiStore.removeGlow(actionKey);
    if (diagramKey) aiStore.removeGlow(diagramKey);
  }
}


async function runSheetEdit(preset: AiActionPreset, target: AiActionCtx["sheet"]): Promise<boolean> {
  const sheetTarget = target ?? getSheetTarget();
  if (!sheetTarget || !sheetTarget.source.trim()) {
    emitNotice(t("ai.sheet_edit_no_section"));
    return false;
  }
  const instruction = (sheetTarget.instruction ?? "").trim();
  if (!instruction) {
    emitNotice(t("ai.sheet_edit_no_instruction"));
    return false;
  }
  // §2 B-2 재대조용 시작 스냅샷.
  const startSnapshot = { sectionId: sheetTarget.sectionId, source: sheetTarget.source };
  const getLiveSheetTarget = () => (target ? liveInjectedTarget(target) : getSheetTarget());

  // G2 — 캡 체크용으로 한 번 만들고 그대로 재사용.
  const sheetEditPrompt = buildSheetEditPrompt(sheetTarget.source, instruction);
  if (noticeIfGenerateInputTooLong(sheetEditPrompt, null)) return false;

  const aiStore = useAiStore.getState();
  const actionKey = AI_GLOW_KEYS.action(preset.id);
  const sheetKey = sheetTarget.sectionId ? AI_GLOW_KEYS.section(sheetTarget.sectionId) : null;

  aiStore.addGlow(actionKey);
  if (sheetKey) aiStore.addGlow(sheetKey);

  try {
    return await runWithAiResultGate(
      { title: preset.name, target: aiResultTarget.replaceSheet(), kind: "sheet", noteTitle: await currentNoteTitle(), replacesExisting: true },
      async (requestId, onAttempt): Promise<AiGenerateOutcome<SheetDoc>> => {
        const res = await generateSheetWithRepair(sheetEditPrompt, null, 3, onAttempt, requestId, preset.id);
        if (!res.ok || !res.doc) {
          emitNotice(t("editor.ai_empty_result"));
          return { ok: false, error: t("editor.ai_empty_result") };
        }
        return { ok: true, raw: res.doc, preview: res.json ?? serializeSheet(res.doc) };
      },
      (parsed) => applyIfFresh(getLiveSheetTarget, startSnapshot, (live) => live.replaceSection(serializeSheet(parsed))),
    );
  } finally {
    aiStore.removeGlow(actionKey);
    if (sheetKey) aiStore.removeGlow(sheetKey);
  }
}

// ── 수식 도우미 ───────────────────────────────────────────────────────────────
// 셀 편집 중 `=` 뒤에 자연어를 쓰고 Ctrl+Enter(또는 툴바 ✨) → 수식 1개 제안.
// 프리셋이 아니다(설정에서 편집할 여지가 없는 출력 계약 = "`=` 로 시작하는 한 줄"뿐이라
// 시트 만들기/수정하기와 달리 사용자 편집 가능한 규칙 절반을 두지 않는다).
// 적용은 언제나 사용자가 Enter 로 한다 — 이 함수는 문자열만 돌려주고 시트를 건드리지 않는다.

const FORMULA_HELPER_RULES =
  "당신은 스프레드시트 수식 도우미입니다. 사용자의 요청을 수식 하나로 옮기세요.\n\n" +
  "규칙:\n" +
  "- `=` 로 시작하는 수식 한 줄만 출력하세요. 설명·인사말·코드 펜스(```)를 절대 붙이지 마세요.\n" +
  "- 수식은 Excel 호환 및 @formulajs/formulajs 지원 표준 함수 방언을 사용합니다.\n" +
  "- 함수 이름은 대문자(SUM, AVERAGE, COUNT, COUNTIF, SUMIF, MAX, MIN, IF, ROUND 등)를 씁니다.\n" +
  "- 참조는 A1 표기(예: B2, C2:C13)로 쓰고, 1행은 헤더이므로 데이터 범위에서 제외하세요.\n" +
  '- 셀 또는 수식 내 숫자에 천 단위 쉼표(,)를 절대 넣지 마세요 (순수 숫자 형식).\n' +
  "- 값을 직접 계산해 적지 말고 수식으로 답하세요.";

/** 1행 raw 값 + 열 문자 — 모델이 "금액 합계"를 어느 열로 옮길지 정하는 유일한 단서. */
function headerRowContext(doc: SheetDoc): string {
  const parts: string[] = [];
  for (let c = 0; c < doc.cols.length; c++) {
    const raw = doc.cells[refKey(c, 0)]?.raw ?? "";
    if (raw.trim()) parts.push(`${colToLetters(c)}: ${raw}`);
  }
  return parts.join(" | ");
}

function usedRangeContext(doc: SheetDoc): string {
  const b = usedBounds(doc);
  if (b.row < 0 || b.col < 0) return "";
  return formatRange({ start: { col: 0, row: 0 }, end: { col: b.col, row: b.row } });
}

export function buildFormulaHelperPrompt(ctx: {
  header: string;
  usedRange: string;
  target: string;
  request: string;
}): string {
  return (
    `${FORMULA_HELPER_RULES}\n\n` +
    `[헤더 행]\n${ctx.header || "(없음)"}\n\n` +
    `[사용 범위]\n${ctx.usedRange || "(비어 있음)"}\n\n` +
    `[대상 셀]\n${ctx.target}\n\n` +
    `[사용자 요청]\n${ctx.request}`
  );
}

/** 모델 출력 → 수식 한 줄. 코드 펜스를 걷어내고 `=` 가 없으면 붙인다. 건질 게 없으면 "". */
export function normalizeFormula(out: string | null | undefined): string {
  const line = (out ?? "")
    .replace(/```[a-zA-Z]*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.startsWith("=") ? line : `=${line}`;
}

/** 편집 중인 셀에 채워 넣을 수식 1개. 취소·실패·빈 결과는 null(시트는 그대로). */
export async function runSheetFormulaHelper(args: {
  doc: SheetDoc;
  targetRef: string;
  /** 사용자가 편집칸에 친 것. 앞의 `=` 는 있어도 없어도 된다. */
  request: string;
  sectionId?: string;
}): Promise<string | null> {
  const request = args.request.trim().replace(/^=/, "").trim();
  if (!request) return null;
  if (!(await ensureAiAskGate())) return null;

  const aiStore = useAiStore.getState();
  const glowKey = args.sectionId ? AI_GLOW_KEYS.section(args.sectionId) : null;
  if (glowKey) aiStore.addGlow(glowKey);
  try {
    const generated = await aiStore.generateFromPrompt(
      buildFormulaHelperPrompt({
        header: headerRowContext(args.doc),
        usedRange: usedRangeContext(args.doc),
        target: args.targetRef,
        request,
      }),
      null,
      { presetId: "formula_helper" },
    );
    const formula = normalizeFormula(generated);
    if (!formula) {
      emitNotice(t("ai.sheet_formula_helper_empty"));
      return null;
    }
    return formula;
  } finally {
    if (glowKey) aiStore.removeGlow(glowKey);
  }
}

export async function runAiAction(preset: AiActionPreset, ctx?: AiActionCtx): Promise<boolean> {
  // Agent plan presets are guidance for generate*Plan only — never HTML insert via this path.
  if (isAgentPlanPreset(preset)) {
    emitNotice(t("ai.agent_plan_not_runnable"));
    return false;
  }
  if (isChatBuiltinPreset(preset)) {
    emitNotice(t("ai.chat_preset_not_runnable"));
    return false;
  }

  // kind:"template" 은 모델을 부르지 않는 노트 스캐폴드다(Q7) — prompt 필드가 곧 노트 본문이라
  // 그대로 LLM 에 보내면 "본문을 프롬프트로 착각한" 결과가 나온다. 메뉴 쪽은 menuActionPresets
  // 가 이미 걸러내지만, 여기서도 막아 어떤 호출자를 통해서도 이 경로로 못 들어오게 한다.
  if (preset.kind === "template") {
    emitNotice(t("ai.template_not_runnable"));
    return false;
  }

  if (isDiagramEditPreset(preset)) return runDiagramEdit(preset, ctx?.diagram);
  if (isDiagramProgressPreset(preset)) return runDiagramProgress(preset, ctx?.diagram, ctx?.contextText);
  if (isDiagramExpandBranchPreset(preset)) return runDiagramExpandBranch(preset, ctx?.diagram);
  if (isSheetEditPreset(preset)) return runSheetEdit(preset, ctx?.sheet);

  const aiStore = useAiStore.getState();
  const actionKey = AI_GLOW_KEYS.action(preset.id);

  if (preset.kind === "metadata") {
    aiStore.addGlow(actionKey);
    try {
      // preset.prompt는 이제 guidance로 실제 전송된다(Wave EDITABLE METADATA PROMPT) — 사용자가
      // 손대지 않은 기본값이면 METADATA_PROMPT 그대로, 편집했다면 그 편집본이 간다.
      await aiStore.organizeCurrentNote(undefined, [...AI_METADATA_FIELDS], preset.prompt);
      return true;
    } finally {
      aiStore.removeGlow(actionKey);
    }
  }

  let text: string;
  let insert: (
    name: string,
    body_md: string,
    targetNoteId: string,
    kind?: "text" | "diagram" | "sheet",
    opts?: { postProcess?: boolean; aiOrigin?: string },
  ) => Promise<unknown>;
  // Capture the insert target BEFORE any generate await — a mid-flight note switch must not
  // redirect the section onto whatever is active when the response arrives.
  let targetNoteId: string | undefined;
  if (ctx) {
    text = ctx.contextText;
    insert = ctx.insertSection;
    targetNoteId = ctx.targetNoteId ?? (await import("./notes")).useNotesStore.getState().activeNote?.note.id;
  } else {
    await flushAll();
    const activeSec = getActiveSection();
    if (activeSec) {
      text = activeSec.body_md ?? "";
    } else {
      const diag = getDiagramTarget();
      if (diag && diag.source.trim()) {
        text = formatDiagramAsContext(diag.source);
      } else {
        text = "";
      }
    }
    insert = insertAiSection;
    targetNoteId = (await import("./notes")).useNotesStore.getState().activeNote?.note.id;
  }

  if (!text.trim() && !ctx?.allowEmptyContext) {
    emitNotice(t("editor.ai_empty_result"));
    return false;
  }

  if (!targetNoteId) {
    emitNotice(t("editor.note_required_for_section"));
    return false;
  }

  // G2 — 이 아래 두 분기(diagram 생성/text·sheet 생성) 모두 결국 preset.prompt + text를
  // generateFromPrompt(또는 그 위의 generateDiagramWithRepair)에 그대로 실어 보낸다.
  if (noticeIfGenerateInputTooLong(preset.prompt, text)) return false;

  // Narrow once into a const — TS control-flow narrowing on the `let` above does not survive
  // into the arrow-function closures the gate wrapper below takes as apply().
  const finalNoteId: string = targetNoteId;

  const activeNoteId = targetNoteId;
  const activeSectionId = getActiveSection()?.id;

  const editorKey = activeNoteId && !isEditorGlowSuppressed() ? AI_GLOW_KEYS.editor(activeNoteId) : null;
  const sectionKey = activeSectionId ? AI_GLOW_KEYS.section(activeSectionId) : null;
  const diagramKey = preset.kind === "diagram" && activeSectionId ? AI_GLOW_KEYS.diagram(activeSectionId) : null;
  const sheetGlowKey = preset.kind === "sheet" && activeSectionId ? AI_GLOW_KEYS.section(activeSectionId) : null;

  aiStore.addGlow(actionKey);
  if (editorKey) aiStore.addGlow(editorKey);
  if (sectionKey) aiStore.addGlow(sectionKey);
  if (diagramKey) aiStore.addGlow(diagramKey);
  if (sheetGlowKey) aiStore.addGlow(sheetGlowKey);

  try {
    if (preset.kind === "diagram") {
      return await runWithAiResultGate(
        { title: preset.name, target: aiResultTarget.insertNewSection(), kind: "diagram", noteTitle: await currentNoteTitle() },
        async (requestId, onAttempt): Promise<AiGenerateOutcome<string>> => {
          const res = await generateDiagramWithRepair(preset.prompt, text, 3, onAttempt, requestId, preset.id);
          if (!res.ok || !res.json) {
            const errorMsg = t("ai.diagram_validation_failed", {
              attempts: res.attempts,
              errors: res.errors?.join(", ") ?? "Invalid JSON syntax",
            });
            const fullError = `${errorMsg}\n\n${res.lastRaw ?? ""}`.trim();
            emitNotice(fullError);
            return { ok: false, error: fullError };
          }
          return { ok: true, raw: res.json, preview: res.json };
        },
        (json) => insert(preset.name, json, finalNoteId, "diagram", { aiOrigin: preset.id }).then(() => {}),
      );
    }

    const isSheetKind = preset.kind === "sheet";
    if (isSheetKind) {
      return await runWithAiResultGate(
        {
          title: preset.name,
          target: aiResultTarget.insertNewSection(),
          kind: "sheet",
          noteTitle: await currentNoteTitle(),
        },
        async (requestId, onAttempt): Promise<AiGenerateOutcome<string>> => {
          const res = await generateSheetWithRepair(preset.prompt, text, 3, onAttempt, requestId, preset.id);
          if (!res.ok || !res.json) {
            emitNotice(t("editor.ai_empty_result"));
            return { ok: false, error: t("editor.ai_empty_result") };
          }
          return { ok: true, raw: res.json, preview: res.json };
        },
        (body) => insert(preset.name, body, finalNoteId, "sheet", { aiOrigin: preset.id }).then(() => {}),
      );
    }

    return await runWithAiResultGate(
      {
        title: preset.name,
        target: aiResultTarget.insertNewSection(),
        kind: "text",
        noteTitle: await currentNoteTitle(),
      },
      async (requestId): Promise<AiGenerateOutcome<string>> => {
        const generated = await aiStore.generateFromPrompt(preset.prompt, text, { requestId, presetId: preset.id, purpose: "transform" });
        if (!generated || !generated.trim()) {
          emitNotice(t("editor.ai_empty_result"));
          return { ok: false, error: t("editor.ai_empty_result") };
        }
        const cleaned = stripTextFence(generated);
        return { ok: true, raw: cleaned, preview: cleaned };
      },
      (body) => insert(preset.name, body, finalNoteId, undefined, { aiOrigin: preset.id }).then(() => {}),
    );
  } finally {
    aiStore.removeGlow(actionKey);
    if (editorKey) aiStore.removeGlow(editorKey);
    if (sectionKey) aiStore.removeGlow(sectionKey);
    if (diagramKey) aiStore.removeGlow(diagramKey);
    if (sheetGlowKey) aiStore.removeGlow(sheetGlowKey);
  }
}

/**
 * 번역 — 활성 섹션 본문을 번역해 새 섹션으로 넣는다.
 */
export async function runTranslateAction(lang: TranslateLang): Promise<void> {
  await flushAll();
  const targetNoteId = (await import("./notes")).useNotesStore.getState().activeNote?.note.id;
  if (!targetNoteId) {
    emitNotice(t("editor.note_required_for_section"));
    return;
  }
  const sec = getActiveSection();
  const text = sec?.body_md ?? "";
  if (!text.trim()) {
    emitNotice(t("editor.ai_empty_result"));
    return;
  }
  const s = await call<{ settings: Record<string, unknown> }>("settings_get_all");
  const args = {
    text,
    target_lang: lang,
    provider: ((s.settings.ai_provider as string) || "ollama").toLowerCase(),
    endpoint: (s.settings.ai_endpoint as string) || undefined,
    api_key: (s.settings.ai_api_key as string) || undefined,
    model: (s.settings.ai_model as string) || undefined,
  };
  try {
    const res = await call<AiTranslateTextOutput>("ai_translate_text", args);
    if (res.translated && res.translated.trim()) {
      await insertAiSection(
        `${t("ai.translate_section_name") || "Translation"} (${lang.toUpperCase()})`,
        res.translated,
        targetNoteId,
        undefined,
        // 번역은 언어 변환일 뿐 새 내용이 아니다 — 메타데이터 후처리 제외(AiActionsMenu 와 동일).
        // aiOrigin: "translate" — 그래도 AI 산출물이다(W5), postProcess만 별개로 꺼진다.
        { postProcess: false, aiOrigin: "translate" },
      );
    }
  } catch {
    /* call() handled error */
  }
}
