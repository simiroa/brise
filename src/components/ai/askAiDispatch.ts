/**
 * AI에게 묻기 — 라우팅 (PLAN-2026-09-15-askai-composer §3).
 *
 * 컴포저가 직렬화한 요청(`SerializedRequest`)을 받아 ① 컨텍스트 참조를 본문 블록으로 풀고
 * ② 프롬프트 한 문자열로 합친 뒤 ③ `where` 에 따라 기존 실행 경로 하나로 보낸다. 옛
 * `AskAiModal.tsx` 의 `runFreePrompt`·`runSelectionAiGate`·칩 onClick 들이 각자 들고 있던 분기를
 * 이 한 곳으로 모은 것이라, 새로 발명한 경로는 「이 섹션 교체」(text section + where=replace) 와
 * 「새 노트」(where=note) 둘뿐이다.
 */
import { t } from "../../i18n/t";
import { call, callSilent, emitNotice, flushAll } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import type { NoteDetail, SectionUpdateOutput } from "../../lib/commands.gen";
import { fetchDailyForecast, savedWeatherLocation, weatherLabelKey } from "../../lib/weather";
import { useAiStore, suppressEditorGlow } from "../../stores/ai";
import { runAiAction } from "../../stores/runAiAction";
import { DIAGRAM_EDIT_ID, DIAGRAM_EXPAND_BRANCH_ID, DIAGRAM_PROGRESS_ID, SHEET_CREATE_ID, SHEET_EDIT_ID, type AiActionKind, type AskAiProposal, type AskAiWhere } from "../../stores/aiPrompts";
import { generateAutoFootnotes, formatAutoFootnotesAsMarkdown, applyAutoFootnotes, type AutoFootnoteTerm } from "../../lib/autoFootnote";
import { useNotesStore } from "../../stores/notes";
import {
  insertAiSection,
  getDiagramTarget,
  getSheetTarget,
  getActiveEditor,
  getActiveSection,
  formatDiagramAsContext,
  withSourceLine,
  type SectionSource,
} from "../../lib/aiSectionBridge";
import { generateSplitNotePlan } from "../../stores/aiAgentActions";
import type { AiPlan } from "../../lib/aiAgentBridge";
import { runWithAiResultGate, aiResultTarget, type AiGenerateOutcome } from "../../stores/aiResultGate";
import type { AskAiTarget, AttachedFileItem } from "./askAiTypes";
import type { CtxRef, SerializedRequest } from "./composer/types";
import { parseSheet } from "../../lib/sheet/types";
import { parseDiagramJson, validateDiagramModel } from "../diagram/diagramSchema";
import { getSectionToken } from "../../lib/sectionTokens";
import { noteBodyForAi, runMetadataProposal, runTagsProposal, runMetadataFollowUp, enginePreset } from "./askAiHelpers";
import { readNoteForContext } from "./noteContext";

export interface DispatchInput {
  req: SerializedRequest;
  /** 컨텍스트 줄에서 **활성**인 참조들(6안 D14). 문장은 더 이상 참조를 품지 않는다. */
  refs: CtxRef[];
  where: AskAiWhere;
  /** where === "proposal" 일 때 라우팅 키. */
  proposal?: AskAiProposal;
  /** where === "note" 일 때 새 노트가 들어갈 폴더. 없으면 활성 노트의 폴더. */
  folderId?: string | null;
  target: AskAiTarget;
  /** file 참조는 이 목록에서 이름으로 찾는다. 참조되지 않은 첨부도 프롬프트 끝에 붙는다. */
  attached: AttachedFileItem[];
  /** 결과 게이트 제목 겸 새 노트 제목(짧게). */
  title: string;
  presetId?: string;
  /**
   * 스탬프된 프리셋의 kind. `diagram`·`sheet` 가 새 섹션/새 노트로 가면 텍스트 생성이 아니라
   * 그 종류의 **생성** 프리셋(관계도 만들기·시트 만들기)을 돈다 — 옛 「관계도로」 칩과 같은 경로.
   */
  presetKind?: AiActionKind;
  /**
   * 메타데이터 스위치(2026-09-26). 켜져 있고 결과가 **대상 노트에** 실제로 반영됐으면(`metadataFollows`),
   * 이어서 같은 요청으로 그 노트의 제목·태그·연도·지역을 고칠 제안을 띄운다(검토 후 적용).
   * 게이트에서 버렸거나 새 노트로 갔으면 아무 일도 없다.
   */
  /** 함수면 **내용이 반영된 순간에** 부른다 — AI 모달은 결과를 보는 동안 스위치를 바꿀 수 있어, 보낼 때가 아니라
   *  [삽입] 시점의 값을 쓴다(PLAN-2026-09-27 Q9-b). 이전 버전 삽입도 같은 입력을 쓰므로 그때의 값이 아니라 지금 값. */
  includeMetadata?: boolean | (() => boolean);
  /**
   * 이미 생성해 사람이 본 텍스트 결과(AI 모달의 버전 비교 — 이전 버전 삽입). 있으면 생성하지 않고 이
   * 값을 그대로 적용한다(게이트도 열지 않는다, `reviewed`). 텍스트 경로(새 섹션·새 노트·섹션/선택
   * 교체)에서만 쓰인다 — 관계도·시트는 runAiAction 의 검증·신선도 확인을 건너뛰면 안 돼서 버전 대상이 아니다.
   * 참조도 풀지 않는다(노트 본문 참조는 대상 노트를 열어 탭을 바꿀 수 있다).
   */
  cachedResult?: string;
  /** 캐시한 시트·관계도 결과를 **교체**로 넣을 때, 그 결과를 만들 때의 대상 원본. 지금 원본과 다르면(그 사이 고쳐졌거나
   *  다른 섹션이 대상이 됐다) 넣지 않는다 — runAiAction 의 applyIfFresh 와 같은 규칙, 교체는 되돌릴 수 없다.
   *  `token`(D2② W4): 텍스트 섹션 교체 결과를 만들 때 읽은 섹션 버전 토큰 — 이전 버전을 교체로 넣을 때 그 사이
   *  편집(이 기기·다른 기기)을 덮지 않게 `expected_updated_at` 으로 보낸다. */
  cachedBase?: { sectionId?: string; source: string; token?: string };
  /** `result` 참조(이어서 다듬기)가 가리키는 이전 버전 텍스트 — 버전 key → 텍스트. */
  results?: Record<string, string>;
}

/** 메타데이터 스위치가 의미 있는 `where` — 결과가 대상 노트 안에 쓰이는 경우뿐이다. 새 노트는 원본을
 *  건드리지 않고, `proposal` 은 그 자체가 검토형 제안이다. 모달의 스위치 활성 여부도 이걸 본다. */
export function metadataFollows(where: AskAiWhere): boolean {
  return where === "section" || where === "replace";
}

/** 모달이 다음에 무엇을 할지 정할 수 있게 돌려준다(2026-09-27 — AI 모달이 결과까지 품는다). */
export interface DispatchResult {
  /** split 제안의 계획 — 모달이 `AiAgentReviewModal` 로 보여줘야 하므로. */
  plan?: AiPlan;
  /** 내용 경로에서 결과가 실제로 노트에 쓰였는가. AI 모달은 true 일 때만 닫힌다. */
  applied?: boolean;
  /** 메타데이터 후속 제안(스위치가 켜져 있고 반영됐을 때). **기다리지 않고** 돌려준다 — 두 번째 AI
   *  호출이라, 기다리면 AI 모달이 그동안 닫히지 못한다. 결과는 AiConfirmModal 이 받는다. */
  followUp?: Promise<void>;
}

export interface WhereOption {
  value: AskAiWhere;
  label: string;
  disabled?: boolean;
  hint?: string;
}

export interface LiveState {
  selectionAlive: boolean;
  diagramMounted: boolean;
  sheetMounted: boolean;
}

const isDiagramTarget = (target: AskAiTarget) =>
  target.kind === "diagram" || (target.kind === "section" && target.isDiagram);
const isSheetTarget = (target: AskAiTarget) => target.kind === "section" && !!target.isSheet;

function targetNoteId(target: AskAiTarget): string | undefined {
  return target.kind === "note" ? target.noteId : useNotesStore.getState().activeNote?.note.id;
}

function refLabel(ref: CtxRef): string {
  switch (ref.k) {
    case "body":
      return t("ai.ctx_label_body");
    case "section":
      return t("ai.ctx_label_section");
    case "selection":
      return t("ai.ctx_label_selection");
    case "note":
      return t("ai.ctx_label_note");
    case "file":
      return t("ai.ctx_label_file", { name: ref.name });
    case "folder":
      return t("ai.ctx_label_folder");
    case "weather":
      return t("ai.ctx_label_weather");
    case "result":
      return t("ai.ctx_label_result");
  }
}

// ponytail: 폴더 참조의 천장 — 노트 20개 · 3만자(최근 수정순). 백엔드 AI_GENERATE_INPUT_CHAR_CAP(32,000자)
// 미만으로 맞춰 사전 거절을 방지한다(AUDIT-2026-09-22 W1). 넘으면 거기서 자르고 마지막에
// 「잘렸다」 한 줄을 붙인다. 폴더 하나가 프롬프트를 통째로 삼키는 것을 막는 고정 상한이고, 사용자가
// 고를 수 있게 하려면 그때 설정 키 두 개(개수·글자수)로 올려라.
const FOLDER_MAX_NOTES = 20;
const FOLDER_MAX_CHARS = 30_000;

/** 폴더 안 노트들의 제목+본문을 최근순으로 모은다. 상한에 걸리면 끝에 잘렸다는 줄이 붙는다. */
async function folderBody(folderId: string): Promise<string | null> {
  const notes = useNotesStore.getState().notesByFolder[folderId] ?? [];
  if (notes.length === 0) return null;
  const recent = [...notes]
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, FOLDER_MAX_NOTES);
  const parts: string[] = [];
  let chars = 0;
  let truncated = notes.length > recent.length;
  for (const n of recent) {
    const read = await readNoteForContext(n.id);
    if (!read) continue;
    const piece = `## ${read.title}\n${read.body}`;
    if (chars + piece.length > FOLDER_MAX_CHARS) {
      truncated = true;
      break;
    }
    parts.push(piece);
    chars += piece.length;
  }
  if (parts.length === 0) return null;
  if (truncated) parts.push(t("ai.ctx_folder_truncated", { count: String(parts.length) }));
  return parts.join("\n\n");
}

/** 저장된 위치(설정 → 지도 기본 위치)의 오늘·내일 예보 한 문단. 위치가 없으면 null = 없는 참조.
 *  좌표·네트워크·1시간 캐시는 전부 lib/weather.ts 가 소유한다 — 여기서 `weather_forecast` 를 직접
 *  부르지 않는 이유는 그 파일 상단 주석과 같다(met.no ToS 의 User-Agent 는 Rust 가 붙인다). */
async function weatherBody(): Promise<string | null> {
  const loc = savedWeatherLocation();
  if (!loc) return null;
  const daily = await fetchDailyForecast(loc);
  if (!daily || daily.time.length === 0) return null;
  const lines = daily.time.slice(0, 2).map((date, i) =>
    t("ai.ctx_weather_line", {
      date,
      label: t(weatherLabelKey(daily.weatherCode[i])),
      max: String(Math.round(daily.tempMaxC[i])),
      min: String(Math.round(daily.tempMinC[i])),
    }),
  );
  return lines.join("\n");
}

const block = (label: string, body: string) => `[${label}]\n${body}`;

/**
 * 참조 → 본문 블록. 풀리지 않는 참조(선택이 풀림, 섹션이 지워짐, 첨부가 빠짐)는 `missing` 으로
 * 돌려주고 호출자가 토스트 한 줄을 띄운다(§3-1).
 *
 * `note` 참조는 `noteBodyForAi` 를 쓰지 않는다 — 그 함수는 대상 노트를 **선택**해서(탭 전환) 읽는데,
 * 다른 노트는 곁다리 컨텍스트라 사용자 화면을 바꾸면 안 된다. `note_get` 으로 조용히 읽는다.
 */
export async function resolveRefs(
  refs: CtxRef[],
  target: AskAiTarget,
  attached: AttachedFileItem[],
  /** `result` 참조의 본문 — AI 모달이 가진 이전 버전 텍스트(버전 key → 텍스트). */
  results: Record<string, string> = {},
): Promise<{ blocks: string[]; missing: CtxRef[] }> {
  const blocks: string[] = [];
  const missing: CtxRef[] = [];
  for (const ref of refs) {
    let body: string | null = null;
    switch (ref.k) {
      case "body": {
        const id = targetNoteId(target);
        body = id ? await noteBodyForAi(id) : null;
        break;
      }
      case "section": {
        await flushAll();
        const sec = useNotesStore.getState().activeNote?.sections.find((s) => s.id === ref.id);
        if (sec) {
          const live = getActiveSection();
          const raw = live && live.id === sec.id ? live.body_md : sec.body_md;
          body = sec.kind === "diagram" ? formatDiagramAsContext(raw) : raw;
        }
        break;
      }
      case "selection":
        body = target.kind === "selection" ? target.selectedText : null;
        break;
      case "note":
        // 읽기 자체는 noteContext.ts — AI로 표 편집의 근거 노트와 같은 함수다.
        body = (await readNoteForContext(ref.id))?.body ?? null;
        break;
      case "file":
        body = attached.find((f) => f.name === ref.name)?.content ?? null;
        break;
      case "folder":
        body = await folderBody(ref.id);
        break;
      case "weather":
        body = await weatherBody();
        break;
      case "result":
        body = results[ref.key] ?? null;
        break;
    }
    if (body == null) missing.push(ref);
    else blocks.push(block(refLabel(ref), body));
  }
  return { blocks, missing };
}

/** 지시문 + 빈 줄 + 블록들. 참조되지 않은 첨부 파일도 뒤에 붙는다(옛 buildAttachedContext 동작). */
export function buildPrompt(req: SerializedRequest, refs: CtxRef[], blocks: string[], attached: AttachedFileItem[] = []): string {
  const referenced = new Set(refs.flatMap((r) => (r.k === "file" ? [r.name] : [])));
  const extra = attached.filter((f) => !referenced.has(f.name)).map((f) => block(refLabel({ k: "file", name: f.name }), f.content));
  return [req.instruction.trim(), ...blocks, ...extra].filter(Boolean).join("\n\n");
}

export function liveState(target: AskAiTarget): LiveState {
  return {
    selectionAlive: target.kind === "selection" && target.from !== undefined && target.to !== undefined && !!getActiveEditor(),
    diagramMounted: target.kind === "diagram" ? !!getDiagramTarget() : target.kind === "section" && target.diagramMounted,
    sheetMounted: target.kind === "section" && !!target.sheetMounted,
  };
}

/** 대상별 `where` 선택지(§3 끝). 배열 순서가 곧 드롭다운 순서이고, 첫 활성 항목이 기본값이다. */
export function whereOptions(target: AskAiTarget, live: LiveState): WhereOption[] {
  const section: WhereOption = { value: "section", label: t("ai.where_section") };
  const note: WhereOption = { value: "note", label: t("ai.where_note") };
  if (isDiagramTarget(target)) {
    return [
      { value: "replace", label: t("ai.where_replace_diagram"), disabled: !live.diagramMounted, hint: live.diagramMounted ? undefined : t("ai.diagram_edit_no_section") },
      section,
      note,
    ];
  }
  if (isSheetTarget(target)) {
    return [
      { value: "replace", label: t("ai.where_replace_sheet"), disabled: !live.sheetMounted, hint: live.sheetMounted ? undefined : t("ai.sheet_edit_no_section") },
      section,
      note,
    ];
  }
  if (target.kind === "selection") {
    return [
      section,
      note,
      { value: "replace", label: t("ai.where_replace_selection"), disabled: !live.selectionAlive, hint: live.selectionAlive ? undefined : t("ai.where_hint_selection_gone") },
    ];
  }
  if (target.kind === "section") return [section, note, { value: "replace", label: t("ai.where_replace_section") }];
  return [section, note];
}

/** 프리셋의 `where` 가 허용되면 그것, 아니면 첫 활성 선택지. `proposal` 은 드롭다운에 없지만 항상 허용. */
export function defaultWhere(target: AskAiTarget, presetWhere?: AskAiWhere, live: LiveState = liveState(target)): AskAiWhere {
  if (presetWhere === "proposal") return "proposal";
  const opts = whereOptions(target, live);
  const wanted = opts.find((o) => o.value === presetWhere && !o.disabled);
  return (wanted ?? opts.find((o) => !o.disabled) ?? opts[0]).value;
}

type Gen = { ok: boolean; raw?: string; preview?: string; error?: string };

/** 게이트용 생성 콜백 — 빈 결과는 토스트 한 줄(옛 runSelectionAiGate 와 같다). */
function textGen(prompt: string) {
  return async (requestId: string): Promise<Gen> => {
    const generated = await useAiStore.getState().generateFromPrompt(prompt, null, { requestId });
    if (!generated || !generated.trim()) {
      emitNotice(t("editor.ai_empty_result"));
      return { ok: false, error: t("editor.ai_empty_result") };
    }
    return { ok: true, raw: generated, preview: generated };
  };
}

/** 이미 본 결과를 그대로 돌려주는 생성 콜백 — `DispatchInput.cachedResult`. */
function cachedGen(text: string) {
  return async (): Promise<Gen> => ({ ok: true, raw: text, preview: text });
}

/** 안내 한 줄을 띄우고 "반영 안 됨"을 돌려준다 — 내용 경로의 조기 종료가 모두 이 모양이다. */
function notice(message: string): false {
  emitNotice(message);
  return false;
}

/**
 * 선택 영역 대상 AI 실행 — `AskAiModal.tsx` 에서 옮겨왔다(W4 가 그쪽 사본을 지운다). from/to 가
 * 있고 에디터가 살아 있으면 그 범위를 제자리에서 교체하고, 아니면 새 섹션으로 삽입한다 —
 * 어느 쪽이든 게이트가 사람이 [삽입]을 누르기 전까지 노트를 건드리지 않는다.
 */
export async function runSelectionAiGate(opts: { title: string; prompt: string; from?: number; to?: number; sources?: SectionSource[]; cached?: string }): Promise<boolean> {
  const hasRange = !!(getActiveEditor() && opts.from !== undefined && opts.to !== undefined);
  return runWithAiResultGate(
    {
      title: opts.title,
      target: hasRange ? aiResultTarget.replaceSelection() : aiResultTarget.insertNewSection(),
      replacesExisting: hasRange,
      kind: "text",
      reviewed: opts.cached != null,
    },
    opts.cached != null ? cachedGen(opts.cached) : textGen(opts.prompt),
    async (generatedText) => {
      const liveEditor = getActiveEditor();
      if (hasRange && liveEditor) {
        liveEditor.chain().focus().insertContentAt({ from: opts.from!, to: opts.to! }, generatedText.trim()).run();
        return;
      }
      const noteId = useNotesStore.getState().activeNote?.note.id;
      if (noteId) {
        await insertAiSection(t("editor.ai_prompt_section_name"), withSourceLine(generatedText, opts.sources ?? []), noteId, undefined, { aiOrigin: "prompt" });
      }
    },
  );
}

/**
 * 관계도·시트 **생성** — `runAiAction` 의 diagram/sheet 분기(JSON 검증·수리 루프·kind 있는 섹션 삽입)를
 * 그대로 탄다. 사용자의 요청(`req.instruction`)은 메인 프롬프트(`preset.prompt`) 뒤에 `[요청]` 블록으로
 * 결합되고, `contextText`에는 순수 참조 컨텍스트(노트/섹션 내용)만 실린다. 새 노트일 때는 노트를
 * **삽입 시점에** 만든다 — 게이트에서 취소하면 빈 노트가 남지 않는다.
 */
async function runCreatePreset(input: DispatchInput, blocks: string[], noteId: string | undefined): Promise<boolean> {
  const { req, where, attached, title } = input;
  const basePreset = await enginePreset(input.presetKind === "diagram" ? "diagram" : SHEET_CREATE_ID);
  if (!basePreset) return notice(t("ai.preset_missing"));
  const userInstruction = req.instruction.trim();
  const preset = userInstruction
    ? { ...basePreset, prompt: `${basePreset.prompt}\n\n${block(t("ai.ctx_label_request"), userInstruction)}` }
    : basePreset;
  const contextText = buildPrompt({ ...req, instruction: "" }, input.refs, blocks, attached);
  if (where === "section") {
    if (!noteId) return notice(t("editor.note_required_for_section"));
    return runAiAction(preset, { contextText, insertSection: insertAiSection, targetNoteId: noteId, allowEmptyContext: true });
  }
  const folderId = input.folderId ?? useNotesStore.getState().activeNote?.note.folder_id;
  if (!folderId) return notice(t("editor.note_required_for_section"));
  return runAiAction(preset, {
    contextText,
    // 참조 칩이 하나도 없으면 contextText 가 빈 문자열이다 — 요청문은 위에서 preset.prompt 로
    // 옮겼으므로 그게 정상이다(runAiAction 의 allowEmptyContext 주석 참고).
    allowEmptyContext: true,
    // runAiAction 은 빈 targetNoteId 를 거절한다. 실제 노트는 아래 insertSection 이 만들어 그 id 로 넣으므로
    // 이 값은 글로우 키에만 쓰인다 — 활성 노트가 없으면(new 대상) 자리표시자.
    targetNoteId: noteId ?? "pending",
    insertSection: async (name, body, _ignored, kind, opts) => {
      const detail = await call<NoteDetail>("note_create", { folder_id: folderId, title: title || undefined });
      await insertAiSection(name, body, detail.note.id, kind, opts);
      const notes = useNotesStore.getState();
      await notes.loadTree();
      await notes.selectNote(detail.note.id);
    },
  });
}

/** AI에게 묻기 모달 전용 경로 — 이 함수 하나가 텍스트·선택 교체·관계도·시트 생성/편집 전부의
 *  단일 통과 지점이다. 모달이 자기 안에서 이미 빛줄기를 보여주므로(useGenerationBeam), 여기서 도는
 *  동안은 에디터 테두리 발광을 억제한다(오너 2026-09-28) — suppressEditorGlow 한 곳으로 감싸면
 *  안쪽의 모든 생성 경로(routeContent → textGen/runSelectionAiGate/runAiAction)에 함께 적용된다. */
export async function dispatchAskAi(input: DispatchInput): Promise<DispatchResult | void> {
  return suppressEditorGlow(async () => {
    const { req, where, target, attached } = input;
    const sources: SectionSource[] = attached.map((f) => ({ label: f.name }));
    const noteId = targetNoteId(target);

    if (where === "proposal") {
      if (!noteId) return;
      const guidance = req.instruction.trim() || undefined;
      if (input.proposal === "tags") return void (await runTagsProposal(noteId, guidance));
      if (input.proposal === "split") {
        const detail = useNotesStore.getState().activeNote;
        if (!detail || detail.note.id !== noteId) return;
        const plan = await generateSplitNotePlan(detail, guidance);
        return { plan: plan ?? undefined };
      }
      return void (await runMetadataProposal(noteId, guidance));
    }

    const applied = await routeContent(input, noteId, sources);
    // 메타데이터 후속은 **내용이 대상 노트에 반영된 뒤에만** — 게이트에서 버렸으면 고칠 근거가 없고,
    // 반영된 본문을 읽고 제안해야 제목·태그가 바뀐 내용을 따른다(runMetadataFollowUp 이 flush 후 DB 에서 읽는다).
    const wantsMetadata = typeof input.includeMetadata === "function" ? input.includeMetadata() : !!input.includeMetadata;
    if (applied && wantsMetadata && noteId && metadataFollows(where)) {
      const followUp = runMetadataFollowUp(noteId, req.instruction).catch((e: unknown) => {
        // organize 쪽이 제 실패를 토스트로 알린다 — 여기 오는 건 그 밖(게이트 확인·flush)의 예외뿐이다.
        reportFallback("askai", "metadata_follow_up_failed", String(e));
      });
      return { applied, followUp };
    }
    return { applied };
  });
}

async function insertCachedNonTextPreset(
  input: DispatchInput,
  cached: string,
  kind: "sheet" | "diagram",
  noteId: string | undefined,
): Promise<boolean> {
  const { where, title } = input;

  if (kind === "sheet") {
    const doc = parseSheet(cached);
    if (!doc || !Array.isArray(doc.cols) || doc.cols.length === 0) {
      emitNotice(t("aiResult.sheet_parse_error"));
      return false;
    }
  } else {
    const model = parseDiagramJson(cached);
    const validation = validateDiagramModel(model);
    if (!validation.valid || !!model.error) {
      emitNotice(t("aiResult.diagram_parse_error"));
      return false;
    }
  }

  if (where === "section") {
    if (!noteId) return notice(t("editor.note_required_for_section"));
    await insertAiSection(title || t("editor.ai_prompt_section_name"), cached, noteId, kind, { aiOrigin: "prompt" });
    return true;
  }

  if (where === "note") {
    const folderId = input.folderId ?? useNotesStore.getState().activeNote?.note.folder_id;
    if (!folderId) return notice(t("editor.note_required_for_section"));
    const detail = await call<NoteDetail>("note_create", { folder_id: folderId, title: title || undefined });
    await insertAiSection(t("editor.ai_prompt_section_name"), cached, detail.note.id, kind, { aiOrigin: "prompt" });
    const notes = useNotesStore.getState();
    await notes.loadTree();
    await notes.selectNote(detail.note.id);
    return true;
  }

  if (where === "replace") {
    const live = kind === "sheet" ? getSheetTarget() : getDiagramTarget();
    if (!live) return notice(t(kind === "sheet" ? "ai.sheet_edit_no_section" : "ai.diagram_edit_no_section"));
    const base = input.cachedBase;
    if (!base || live.sectionId !== base.sectionId || live.source !== base.source) return notice(t("aiResult.stale_section_notice"));
    await live.replaceSection(cached);
    return true;
  }

  return false;
}

/** 내용 경로(section·note·replace) — 결과가 실제로 쓰였으면 true. 조기 종료·게이트 취소·빈 결과는 false. */
async function routeContent(input: DispatchInput, noteId: string | undefined, sources: SectionSource[]): Promise<boolean> {
  const { req, where, target, attached, title } = input;
  // 관계도·시트 제자리 교체는 runAiAction 이 라이브 소스를 직접 먹인다 — 같은 섹션을 가리키는
  // body/section 참조를 블록으로 또 넣으면 소스가 두 번 실린다.
  const liveReplace = where === "replace" && (isDiagramTarget(target) || isSheetTarget(target));
  const refs = liveReplace ? input.refs.filter((r) => r.k !== "body" && r.k !== "section") : input.refs;
  const cached = input.cachedResult;

  // W3 §3.7: 시트·관계도 캐시 버전을 삽입할 때는 검증 로직을 거쳐 안전하게 삽입
  if (cached != null) {
    const isSheet = input.presetKind === "sheet" || (where === "replace" && isSheetTarget(target));
    const isDiagram = input.presetKind === "diagram" || (where === "replace" && isDiagramTarget(target));
    if (isSheet) {
      return insertCachedNonTextPreset(input, cached, "sheet", noteId);
    }
    if (isDiagram) {
      return insertCachedNonTextPreset(input, cached, "diagram", noteId);
    }
  }

  if (input.presetId === DIAGRAM_PROGRESS_ID) {
    const preset = await enginePreset(DIAGRAM_PROGRESS_ID);
    if (!preset) return notice(t("ai.preset_missing"));
    return runAiAction(preset, { contextText: "", insertSection: insertAiSection });
  }

  if (input.presetId === "auto_footnote") {
    const editor = getActiveEditor();
    const docText = editor
      ? editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ")
      : (target.kind === "section" ? target.sectionBody : (await noteBodyForAi(noteId ?? "")) ?? "");
    let generatedTerms: AutoFootnoteTerm[] = [];
    const footnoteGen = async (_requestId: string): Promise<AiGenerateOutcome<string>> => {
      const terms = await generateAutoFootnotes(docText);
      // 실패는 generateFromPrompt 가 이미 알렸다 — 결과 상자에는 일반 오류로만.
      if (terms == null) return { ok: false, error: t("aiResult.unknown_error") };
      generatedTerms = terms;
      if (!terms.length) {
        return { ok: false, error: t(docText.trim() ? "ai.auto_footnote_none" : "editor.ai_empty_result") };
      }
      const md = formatAutoFootnotesAsMarkdown(generatedTerms);
      return { ok: true, raw: md, preview: md };
    };
    const footnoteApply = async (rawMd: string): Promise<boolean> => {
      let termsToApply = generatedTerms;
      if (!termsToApply.length && rawMd) {
        termsToApply = [];
        for (const line of rawMd.split("\n")) {
          const match = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
          if (match) {
            termsToApply.push({ term: match[1].trim(), definition: match[2].trim() });
          }
        }
      }
      if (termsToApply.length > 0) {
        const added = await applyAutoFootnotes(termsToApply, editor);
        return added > 0;
      }
      return false;
    };
    const reviewed = cached != null;
    return runWithAiResultGate(
      {
        title: input.title || t("ai.auto_footnote_action"),
        target: aiResultTarget.replaceSection(),
        kind: "text",
        // 각주는 첨부로 들어가 되돌리기가 없다 — "적용 전 확인"을 꺼 두었어도 늘 검토를 거친다(교체와 같다).
        replacesExisting: true,
        reviewed,
      },
      cached != null ? cachedGen(cached) : footnoteGen,
      footnoteApply,
    );
  }

  // D2② W4 — 텍스트 섹션 교체는 AI 가 그 섹션을 **읽은 시점**의 버전 토큰을 들고 쓴다. 참조를 풀기(=읽기) 전에
  // flush 해 이 기기의 대기 편집을 먼저 저장하고 토큰을 잡는다. 적용 직전(아래 apply 의 flushAll)에 다시 잡지
  // 않는다 — 생성 중 사용자가 친 글이 그 flush 로 저장되면 CONFLICT 가 나야 덮지 않는다.
  // 캐시(이전 버전 삽입)면 그 버전을 만들 때 AI 모달이 잡아 둔 토큰. 토큰을 모르면 생략 = 기존 LWW.
  const textReplace = where === "replace" && target.kind === "section" && !isDiagramTarget(target) && !isSheetTarget(target);
  let readToken: string | undefined;
  if (textReplace) {
    if (cached != null) {
      readToken = input.cachedBase?.sectionId === target.sectionId ? input.cachedBase.token : undefined;
    } else {
      await flushAll();
      readToken = getSectionToken(target.sectionId);
    }
  }

  const { blocks, missing } = cached != null ? { blocks: [], missing: [] } : await resolveRefs(refs, target, attached, input.results);
  if (missing.length) emitNotice(t("ai.ctx_missing", { list: missing.map(refLabel).join(", ") }));
  // 캐시 적용이면 프롬프트는 쓰이지 않는다 — 비어 있다고 멈추지 않게 자리만 채운다.
  const prompt = cached != null ? cached : buildPrompt(req, refs, blocks, attached);
  // 텍스트 경로의 생성 콜백과 "이미 검토됨" 표시. 캐시가 있으면 생성하지 않고 게이트도 열지 않는다.
  const gen = cached != null ? cachedGen(cached) : textGen(prompt);
  const reviewed = cached != null;
  if (!prompt) return false;

  if ((input.presetKind === "diagram" || input.presetKind === "sheet") && (where === "section" || where === "note")) {
    return runCreatePreset(input, blocks, noteId);
  }

  if (where === "replace") {
    if (target.kind === "selection") {
      return runSelectionAiGate({ title, prompt, from: target.from, to: target.to, sources, cached });
    }
    if (isDiagramTarget(target)) {
      const live = getDiagramTarget();
      if (!live) return notice(t("ai.diagram_edit_no_section"));
      if (input.presetId === DIAGRAM_EXPAND_BRANCH_ID) {
        // 분기 전개는 선택 노드를 기준으로 한 전용 프롬프트(runDiagramExpandBranch)를 탄다 — 옛 칩과 같다.
        // 스탬프 문장은 규칙 뒤에 [요청] 으로 붙어, 사용자가 고친 지침이 살아남는다.
        const preset = await enginePreset(DIAGRAM_EXPAND_BRANCH_ID);
        if (!preset) return notice(t("ai.preset_missing"));
        if (!live.selectedNodeId) return notice(t("ai.diagram_expand_select_node"));
        return runAiAction(
          { ...preset, prompt: `${preset.prompt}

${block(t("ai.ctx_label_request"), req.instruction.trim())}` },
          { contextText: "", insertSection: insertAiSection, diagram: { ...live } },
        );
      }
      const preset = await enginePreset(DIAGRAM_EDIT_ID);
      if (!preset) return notice(t("ai.preset_missing"));
      const instruction = target.kind === "diagram" ? `[선택 노드: "${target.label}" (ID: ${target.id})]\n${prompt}` : prompt;
      return runAiAction(preset, { contextText: "", insertSection: insertAiSection, diagram: { source: live.source, instruction, replaceSection: live.replaceSection } });
    }
    if (isSheetTarget(target)) {
      const live = getSheetTarget();
      const preset = await enginePreset(SHEET_EDIT_ID);
      if (!live || !preset) return notice(t("ai.sheet_edit_no_section"));
      return runAiAction(preset, { contextText: "", insertSection: insertAiSection, sheet: { source: live.source, instruction: prompt, replaceSection: live.replaceSection } });
    }
    if (target.kind === "section") {
      // 신설 — 텍스트 섹션 제자리 교체. undo 가 없어 replacesExisting 으로 게이트를 항상 지난다.
      return runWithAiResultGate(
        { title, target: aiResultTarget.replaceSection(), kind: "text", replacesExisting: true, reviewed },
        gen,
        async (text) => {
          await flushAll();
          const body = text.trim();
          try {
            // callSilent — CONFLICT 는 아래에서 안내 한 줄로 대신한다(call() 이면 에러 토스트가 겹친다).
            await callSilent<SectionUpdateOutput>("section_update", {
              id: target.sectionId,
              body_md: body,
              ai_origin: "prompt",
              ...(readToken ? { expected_updated_at: readToken } : {}),
            });
          } catch (e) {
            const err = e as { code?: string; message?: string } | null;
            if (err?.code === "CONFLICT" && noteId) {
              // AI 가 읽은 뒤 그 섹션이 바뀌었다(생성 중 이 기기의 타이핑, 또는 다른 기기). 덮지 않고 새 섹션으로 —
              // 사람이 만든 글과 AI 결과가 둘 다 남는다. 삽입은 기존 경로라 에디터가 그 섹션으로 넘어간다.
              reportFallback("askai", "replace_conflict_new_section");
              emitNotice(t("aiResult.replace_conflict_new_section"));
              const sec = await insertAiSection(t("editor.ai_prompt_section_name"), body, noteId, undefined, { aiOrigin: "prompt" });
              return sec ? undefined : false;
            }
            // 그 밖(휴지통 노트 NOT_FOUND 등)은 실패 — callSilent 라 토스트가 없으니 메시지를 직접 띄운다.
            emitNotice(err?.message || t("aiResult.unknown_error"));
            return false; // DB 는 그대로라 되돌릴 것이 없다.
          }
          // 스토어 사본·에디터 문서는 이 쓰기를 모른다 — reloadActive 가 note_get 으로 다시 읽고
          // EditorPanel 의 노트 로드 효과가 새 activeNote 참조에 setContent 한다. `rewritten` 이 이 섹션의
          // 에디터 캐시(교체 전 본문)를 reload 안의 flush **뒤에** 버린다 — 남기면 낡은 본문이 다시 그려지고
          // 다음 타이핑이 새 토큰으로 AI 결과를 덮는다. 새 토큰은 reload 의 seed 가 심는다. 응답 토큰을 여기서
          // 따로 set 하지 않는 이유: reload 가 실패하면(스스로 삼킨다) 에디터는 교체 전 본문 그대로라, 그때
          // 새 토큰을 쥐여 주면 그 낡은 본문이 AI 결과를 조용히 덮는다 — 옛 토큰이면 CONFLICT 로 멈춘다.
          await useNotesStore.getState().reloadActive({ rewritten: [target.sectionId] });
        },
      );
    }
    // note/new 대상엔 교체할 자리가 없다 — 새 섹션으로 떨어진다.
  }

  if (where === "note") {
    const folderId = input.folderId ?? useNotesStore.getState().activeNote?.note.folder_id;
    if (!folderId) return notice(t("editor.note_required_for_section"));
    return runWithAiResultGate({ title, target: aiResultTarget.newNote(), kind: "text", reviewed }, gen, async (text) => {
      try {
        const detail = await call<NoteDetail>("note_create", { folder_id: folderId, title: title || undefined });
        const body = withSourceLine(text, sources);
        // 새 노트의 기본 섹션(Overview)이 있으면 거기에 채운다 — 빈 Overview 뒤에 「AI 결과」가 따로
        // 붙는 것보다 사람이 만든 노트와 같은 모양이다. 없으면 삽입 경로.
        const first = detail.sections[0];
        // 방금 만든 노트의 섹션에 1회 쓰기 — note_create 응답의 토큰을 그대로 보낸다(아무도 아직 못 봤다).
        if (first) {
          await call<SectionUpdateOutput>("section_update", {
            id: first.id,
            body_md: body,
            ai_origin: "prompt",
            ...(first.updated_at ? { expected_updated_at: first.updated_at } : {}),
          });
        }
        else await insertAiSection(t("editor.ai_prompt_section_name"), body, detail.note.id, undefined, { aiOrigin: "prompt" });
        const notes = useNotesStore.getState();
        await notes.loadTree();
        await notes.selectNote(detail.note.id);
      } catch {
        // call() 이 토스트를 띄웠다. 노트가 만들어진 뒤 본문 쓰기가 실패하면 빈 노트가 남는데,
        // 그건 사용자가 트리에서 보고 지울 수 있는 상태다 — 조용히 지우는 편이 더 놀랍다.
        return false;
      }
    });
  }

  // section (기본)
  if (!noteId) return notice(t("editor.note_required_for_section"));
  return runWithAiResultGate({ title, target: aiResultTarget.insertNewSection(), kind: "text", reviewed }, gen, async (text) => {
    await insertAiSection(t("editor.ai_prompt_section_name"), withSourceLine(text, sources), noteId, undefined, { aiOrigin: "prompt" });
  });
}
