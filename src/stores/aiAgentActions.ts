import { useAiStore, AI_GLOW_KEYS } from "./ai";
import { call } from "../lib/invoke";
import { useNotesStore } from "./notes";
import { type AgentPlanPresetId } from "./aiPrompts";
import { filterWorkspaceCandidates } from "../lib/workspaceAiFilter";
import { noteQueryCollect, hydrateTagNames } from "../lib/noteQuery";
import type { AiPlan, AiPlanAction, AiPlanActionType, AiPlanSourceNote } from "../lib/aiAgentBridge";
import type { NoteDetail, NoteSummary } from "../lib/commands.gen";
// 플랜 계약의 앱 고정 절반(골격·데이터 경계·출력 계약) — 원문은 specs/ai/prompts/agent/ 가 SSOT.
// 파일은 끝 개행 없이 LF 로 둔다(.gitattributes) — 프롬프트가 바이트 그대로 나간다.
import AGENT_PLAN_SCHEMA_FILE from "../../specs/ai/prompts/agent/plan-schema.json?raw";
import DATA_BOUNDARY_FILE from "../../specs/ai/prompts/agent/data-boundary.md?raw";
import OUTPUT_CONTRACT_FILE from "../../specs/ai/prompts/agent/output-contract.md?raw";

/**
 * Workspace agent scan cap — note_query is paged; we never pull an unbounded corpus
 * (docs/SCALABILITY.md). Candidates are further compressed by filterWorkspaceCandidates.
 */
export const WORKSPACE_AI_SCAN_CAP = 500;

/**
 * Folder agent scan cap — same rationale as WORKSPACE_AI_SCAN_CAP, scoped to one folder via
 * note_query(folder_ids). Before this cap existed, the folder-organize menu action was handed
 * `notesByFolder[folderId]` directly — the left-panel tree's *windowed* cache, i.e. only whatever
 * had scrolled into view (windowLoad.ts). A 100-note folder with 30 loaded rows made the AI judge
 * "no duplicates" from 30 notes while the review UI read as a full-folder verdict — a quietly
 * wrong answer (docs/PLAN-2026-07-31-round2.md N2-1). Folder scope has no candidate-compression
 * pass like workspace (filterWorkspaceCandidates) — raw note list is small enough at this cap that
 * compressing it wasn't judged worth the extra complexity; revisit if folders regularly exceed it.
 */
export const FOLDER_AI_SCAN_CAP = 500;

/** A second pass deliberately stays small: merge drafts must use complete source bodies. */
export const MERGE_DRAFT_MAX_SOURCES = 8;
export const MERGE_DRAFT_MAX_BODY_CHARS = 32_000;
export const AI_PLAN_MAX_ACTIONS = 20;
export const AI_PLAN_MAX_TITLE_CHARS = 80;
export const AI_PLAN_MAX_DESCRIPTION_CHARS = 500;
export const AI_PLAN_MAX_BODY_CHARS = 32_000;
export const AI_PLAN_MAX_ID_CHARS = 128;
export const AI_PLAN_MAX_SOURCE_NOTES = 8;

/** Fixed JSON schema contract for agent plans — empty values only (never filled placeholders).
 *  Models copy example content; "Topic 1 Title" / "Content 1" style demos caused placeholder
 *  leakage. Schema field names/types are app-owned; guidance text is the editable half.
 *  원문 SSOT = `specs/ai/prompts/agent/plan-schema.json` (PLAN-2026-10-08 §7 W0 — W2 의 Rust 플랜 엔진이
 *  같은 파일을 include_str! 로 읽는다). 바이트 동일성 고정: aiPromptFiles.test.ts. */
export const AGENT_PLAN_SCHEMA_SKELETON: string = AGENT_PLAN_SCHEMA_FILE;

const VALID_ACTION_TYPES = new Set<AiPlanActionType>([
  "create_note",
  "update_note",
  "delete_note",
  "merge_notes",
]);

import { getEngineInstruction, useAiInstructionsStore } from "./aiInstructions";

/** Delimiters around note context so models treat the block as data, not instructions. */
export const UNTRUSTED_DATA_OPEN = "<untrusted_data>";
export const UNTRUSTED_DATA_CLOSE = "</untrusted_data>";

/**
 * Fixed contract line: anything inside the untrusted delimiters is note data only.
 * Kept as a constant so tests can assert the wording is present and not user-editable.
 * 원문 SSOT = `specs/ai/prompts/agent/data-boundary.md` (PLAN-2026-10-08 §7 W0).
 */
export const UNTRUSTED_DATA_CONTRACT: string = DATA_BOUNDARY_FILE;

/** 출력 계약 한 줄 — 골격 바로 앞에 붙는다. 원문 SSOT = `specs/ai/prompts/agent/output-contract.md`. */
export const AGENT_PLAN_OUTPUT_CONTRACT: string = OUTPUT_CONTRACT_FILE;

/** Build full model prompt: user-editable guidance + isolated note data + fixed empty schema. */
export function buildAgentPlanPrompt(guidance: string, contextBlock: string): string {
  return (
    `${guidance.trim()}\n\n` +
    `${UNTRUSTED_DATA_CONTRACT}\n` +
    `${UNTRUSTED_DATA_OPEN}\n${contextBlock}\n${UNTRUSTED_DATA_CLOSE}\n\n` +
    `${AGENT_PLAN_OUTPUT_CONTRACT}\n` +
    AGENT_PLAN_SCHEMA_SKELETON
  );
}

/**
 * Parse model output into AiPlan. Handles fenced JSON, leading/trailing prose, and partial
 * objects. Returns null on total failure — never throws.
 *
 * When `allowedNoteIds` is provided, actions that reference note ids outside that set are
 * dropped (deterministic injection boundary; see normalizePlan).
 */
export function parseAiPlan(raw: string, allowedNoteIds?: ReadonlySet<string>): AiPlan | null {
  if (!raw || !raw.trim()) return null;

  let text = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if the whole response is fenced.
  const fence = text.match(/^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (fence) text = fence[1].trim();

  // Prefer first balanced-looking object; models often wrap JSON in prose.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // Partial JSON: try progressive truncation from the end to the last complete brace.
    const sliced = jsonMatch[0];
    let recovered: unknown = null;
    for (let i = sliced.length - 1; i > 20; i--) {
      if (sliced[i] !== "}") continue;
      try {
        recovered = JSON.parse(sliced.slice(0, i + 1));
        break;
      } catch {
        // keep scanning
      }
    }
    if (!recovered) return null;
    parsed = recovered;
  }

  return normalizePlan(parsed, allowedNoteIds);
}

/**
 * True when an action's noteId / sourceNoteIds all lie inside `allowed`. create_note has no
 * note refs and always passes. Actions that *reference* any out-of-scope id fail (discarded).
 */
function actionWithinAllowedNoteScope(
  type: AiPlanActionType,
  payload: AiPlanAction["payload"],
  allowed: ReadonlySet<string>,
): boolean {
  if (type === "create_note") return true;
  if (type === "update_note" || type === "delete_note") {
    const noteId = payload.noteId;
    // Missing noteId is a schema/exec problem, not an injection path — keep for later failure.
    if (noteId === undefined) return true;
    return allowed.has(noteId);
  }
  // merge_notes: any source outside the context set → discard whole action.
  const sources = payload.sourceNoteIds ?? [];
  if (sources.length === 0) return true;
  return sources.every((id) => allowed.has(id));
}

function validModelId(value: string | undefined): value is string {
  return Boolean(value?.trim()) && value!.length <= AI_PLAN_MAX_ID_CHARS;
}

function payloadWithinModelLimits(type: AiPlanActionType, payload: AiPlanAction["payload"]): boolean {
  if (payload.title !== undefined && payload.title.length > AI_PLAN_MAX_TITLE_CHARS) return false;
  if (payload.bodyMd !== undefined && payload.bodyMd.length > AI_PLAN_MAX_BODY_CHARS) return false;
  if (payload.noteId !== undefined && !validModelId(payload.noteId)) return false;
  if (payload.folderId !== undefined && !validModelId(payload.folderId)) return false;
  if (type === "create_note") return Boolean(payload.bodyMd?.trim());
  if (type === "update_note") return validModelId(payload.noteId) && Boolean(payload.title !== undefined || payload.bodyMd?.trim());
  if (type === "delete_note") return validModelId(payload.noteId);
  const sources = payload.sourceNoteIds;
  return Boolean(sources && sources.length >= 2 && sources.length <= AI_PLAN_MAX_SOURCE_NOTES &&
    sources.every(validModelId) && new Set(sources).size === sources.length && payload.bodyMd?.trim());
}

/**
 * Validate/coerce unknown JSON into AiPlan; drop invalid actions.
 * When `allowedNoteIds` is set, also drop actions that reference note ids outside that set
 * (prompt-injection cannot invent delete/merge targets beyond the notes the user scoped in).
 */
export function normalizePlan(
  parsed: unknown,
  allowedNoteIds?: ReadonlySet<string>,
): AiPlan | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title : "";
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  if (!Array.isArray(obj.actions)) return null;
  if (title.length > AI_PLAN_MAX_TITLE_CHARS || obj.actions.length > AI_PLAN_MAX_ACTIONS) return null;

  const actions: AiPlanAction[] = [];
  // `id` is a UI identity as well as a model field: selections, React rows, and execution
  // receipts all use it. Keep the first occurrence only; accepting duplicate model IDs would
  // allow one checkbox to represent multiple writes.
  const usedActionIds = new Set<string>();
  let filteredOutOfScopeCount = 0;
  for (let i = 0; i < obj.actions.length; i++) {
    const a = obj.actions[i];
    if (!a || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    const type = rec.type;
    if (typeof type !== "string" || !VALID_ACTION_TYPES.has(type as AiPlanActionType)) continue;
    const description = typeof rec.description === "string" ? rec.description : "";
    if (description.length > AI_PLAN_MAX_DESCRIPTION_CHARS) continue;
    const payloadRaw = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
    const payload: AiPlanAction["payload"] = {};
    if (typeof payloadRaw.noteId === "string") payload.noteId = payloadRaw.noteId;
    if (typeof payloadRaw.title === "string") payload.title = payloadRaw.title;
    if (typeof payloadRaw.bodyMd === "string") payload.bodyMd = payloadRaw.bodyMd;
    if (typeof payloadRaw.folderId === "string") payload.folderId = payloadRaw.folderId;
    if (Array.isArray(payloadRaw.sourceNoteIds)) {
      if (!payloadRaw.sourceNoteIds.every((x): x is string => typeof x === "string")) continue;
      payload.sourceNoteIds = payloadRaw.sourceNoteIds;
    }
    const actionType = type as AiPlanActionType;
    if (!payloadWithinModelLimits(actionType, payload)) continue;
    if (allowedNoteIds && !actionWithinAllowedNoteScope(actionType, payload, allowedNoteIds)) {
      filteredOutOfScopeCount++;
      continue;
    }
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `act-${i + 1}`;
    if (usedActionIds.has(id)) continue;
    usedActionIds.add(id);
    actions.push({
      id,
      type: actionType,
      description,
      payload,
    });
  }

  if (actions.length === 0) return null;
  const truncatedCount =
    typeof obj.truncatedCount === "number" && Number.isFinite(obj.truncatedCount)
      ? obj.truncatedCount
      : undefined;
  return {
    title,
    summary,
    actions,
    truncatedCount,
    ...(filteredOutOfScopeCount > 0 ? { filteredOutOfScopeCount } : {}),
  };
}

/**
 * Split plans must state what happens to the original note. If the model only emitted
 * create_note actions, append an explicit trash-original action so the review table shows
 * the disposition (keep via update_note, or trash via delete_note).
 */
export function ensureSplitOriginalDisposition(
  plan: AiPlan,
  originalNoteId: string,
  originalTitle: string,
): AiPlan {
  const touchesOriginal = plan.actions.some(
    (a) =>
      (a.type === "delete_note" || a.type === "update_note") && a.payload.noteId === originalNoteId,
  );
  if (touchesOriginal) return plan;

  return {
    ...plan,
    actions: [
      ...plan.actions,
      {
        id: "act-original-disposition",
        type: "update_note",
        // Korean description for the review row — not a model instruction.
        description:
          "원본 노트를 유지합니다. (삭제를 원할 경우 휴지통 액션을 직접 선택하세요)",
        payload: { noteId: originalNoteId, title: originalTitle },
      },
    ],
  };
}

/**
 * The model may suggest a destination, but it never owns one. Scoped plans receive their
 * destination from the caller; workspace merges are permitted only when every source already
 * shares a folder. This prevents an absent/model-invented folderId from quietly becoming Inbox.
 */
export function canonicalizePlanDestinations(
  plan: AiPlan,
  notesById: ReadonlyMap<string, Pick<NoteSummary, "folder_id">>,
  scopedFolderId?: string,
): AiPlan {
  const actions = plan.actions.flatMap((action): AiPlanAction[] => {
    if (action.type === "create_note") {
      if (!scopedFolderId) return [];
      return [{ ...action, payload: { ...action.payload, folderId: scopedFolderId } }];
    }
    if (action.type !== "merge_notes") return [action];

    if ((action.payload.sourceNoteIds ?? []).length < 2) return [];

    const sourceFolders = (action.payload.sourceNoteIds ?? [])
      .map((id) => notesById.get(id)?.folder_id)
      .filter((id): id is string => Boolean(id));
    const canonicalFolder = scopedFolderId ?? (sourceFolders.length > 0 && sourceFolders.every((id) => id === sourceFolders[0])
      ? sourceFolders[0]
      : undefined);
    if (!canonicalFolder) return [];
    return [{ ...action, payload: { ...action.payload, folderId: canonicalFolder } }];
  });
  return { ...plan, actions };
}

type PlanScopeNote = Pick<NoteSummary, "id" | "folder_id" | "updated_at">;

/**
 * Bind an approved plan to the exact note revisions and folders the app reviewed. This data is
 * app-derived (never model JSON) and the backend rechecks it before mutating anything.
 */
export function attachPlanApplyScope(plan: AiPlan, notes: readonly PlanScopeNote[]): AiPlan {
  const notesById = new Map(notes.map((note) => [note.id, note] as const));
  const referencedIds = new Set<string>();
  const folderIds = new Set<string>();
  for (const action of plan.actions) {
    if (action.payload.noteId) referencedIds.add(action.payload.noteId);
    for (const id of action.payload.sourceNoteIds ?? []) referencedIds.add(id);
    if (action.payload.folderId) folderIds.add(action.payload.folderId);
  }

  const noteRevisions: Record<string, string> = {};
  const noteFolderIds: Record<string, string> = {};
  for (const id of referencedIds) {
    const note = notesById.get(id);
    if (!note) continue;
    noteRevisions[id] = note.updated_at;
    noteFolderIds[id] = note.folder_id;
    folderIds.add(note.folder_id);
  }
  return { ...plan, applyScope: { noteRevisions, noteFolderIds, folderIds: [...folderIds].sort() } };
}

function noteBody(detail: NoteDetail): string {
  return detail.sections.map((section) => section.body_md).join("\n\n");
}

/**
 * Load the exact bodies used by a merge draft. We refuse a merge rather than truncate its
 * sources: a summary-derived merge is not reviewable enough to approve.
 */
async function hydrateMergeSources(
  actions: readonly AiPlanAction[],
  titlesById: ReadonlyMap<string, string>,
): Promise<Map<string, AiPlanSourceNote> | null> {
  const ids = [...new Set(actions.flatMap((action) => action.type === "merge_notes" ? action.payload.sourceNoteIds ?? [] : []))];
  if (ids.length === 0) return new Map();
  if (ids.length > MERGE_DRAFT_MAX_SOURCES) return null;

  const sources = new Map<string, AiPlanSourceNote>();
  let bodyChars = 0;
  try {
    for (const id of ids) {
      const detail = await call<NoteDetail>("note_get", { id });
      const bodyMd = noteBody(detail);
      bodyChars += bodyMd.length;
      if (bodyChars > MERGE_DRAFT_MAX_BODY_CHARS) return null;
      sources.set(id, { id, title: detail.note.title || titlesById.get(id) || "", bodyMd });
    }
  } catch {
    return null;
  }
  return sources;
}

function buildMergeDraftPrompt(guidance: string, sources: ReadonlyMap<string, AiPlanSourceNote>): string {
  const context = [...sources.values()]
    .map((source) => `노트 id: ${source.id}\n제목: ${source.title || "(제목 없음)"}\n전체 본문:\n${source.bodyMd}`)
    .join("\n\n---\n\n");
  return buildAgentPlanPrompt(
    `${guidance}\n\n[2단계 병합 초안] 아래에 제공된 전체 본문을 근거로 merge_notes만 작성하세요. ` +
      "sourceNoteIds는 제공된 ID만 사용하고, bodyMd에는 병합 결과 전문을 반드시 넣으세요.",
    context,
  );
}

/** Replace summary-stage merge candidates with drafts derived from the exact loaded sources. */
async function draftHydratedMerges(
  candidate: AiPlan,
  allowed: ReadonlySet<string>,
  notesById: ReadonlyMap<string, Pick<NoteSummary, "folder_id" | "title">>,
  scopedFolderId?: string,
): Promise<AiPlan> {
  const candidates = candidate.actions.filter((action) => action.type === "merge_notes");
  if (candidates.length === 0) return candidate;

  const titles = new Map([...notesById].map(([id, note]) => [id, note.title]));
  const sources = await hydrateMergeSources(candidates, titles);
  // Do not leave a title/tag-only merge in a plan if hydration cannot make it reviewable.
  const nonMerges = candidate.actions.filter((action) => action.type !== "merge_notes");
  if (!sources) return { ...candidate, actions: nonMerges };

  const raw = await useAiStore.getState().generateFromPrompt(buildMergeDraftPrompt(guidanceFor("agent_merge"), sources), null);
  const drafted = raw ? parseAiPlan(raw, allowed) : null;
  if (!drafted) return { ...candidate, actions: nonMerges };
  const canonicalDraft = canonicalizePlanDestinations(drafted, notesById, scopedFolderId);
  const exactMerges = canonicalDraft.actions
    .filter((action) =>
      action.type === "merge_notes" &&
      Boolean(action.payload.bodyMd?.trim()) &&
      (action.payload.sourceNoteIds ?? []).every((id) => sources.has(id)),
    )
    .map((action) => ({
      ...action,
      payload: {
        ...action.payload,
        sourceNotes: (action.payload.sourceNoteIds ?? [])
          .map((id) => sources.get(id))
          .filter((source): source is AiPlanSourceNote => Boolean(source)),
      },
    }));

  return { ...candidate, actions: [...nonMerges, ...exactMerges] };
}

async function ensureAgentPresetsLoaded(): Promise<void> {
  const s = useAiInstructionsStore.getState();
  if (!s.loaded) await s.load();
}

function guidanceFor(id: AgentPlanPresetId): string {
  return getEngineInstruction(id);
}

/**
 * Backend gates ai_organize_note per-note, but the folder/workspace scans below build their own
 * prompt text via ai_generate_from_prompt — the backend has no visibility into that scope, so the
 * ai_excluded cut has to happen here before notes reach the prompt. Only applied to the live
 * noteQueryCollect path; preloadedNotes (test injection) bypasses this by design.
 */
function excludeAiFolders(notes: NoteSummary[]): NoteSummary[] {
  const excludedFolderIds = new Set(
    useNotesStore
      .getState()
      .folders.filter((f) => f.ai_excluded)
      .map((f) => f.id),
  );
  if (excludedFolderIds.size === 0) return notes;
  return notes.filter((n) => !excludedFolderIds.has(n.folder_id));
}

/**
 * Scope 1: Note-Level (Split Note).
 * Proposes N new notes from body topics + explicit original disposition (keep/trash).
 */
/** `guidance` 가 있으면 agent_split 프리셋 prompt 대신 그것이 간다(AskAi 컴포저의 요청문, D10). */
export async function generateSplitNotePlan(note: NoteDetail, guidance?: string): Promise<AiPlan | null> {
  const fullBody = note.sections.map((s) => s.body_md).join("\n\n");
  if (!fullBody.trim()) return null;

  const glowKey = AI_GLOW_KEYS.note(note.note.id);
  const aiStore = useAiStore.getState();
  aiStore.addGlow(glowKey);

  try {
    await ensureAgentPresetsLoaded();
    const effectiveGuidance = guidance?.trim() ? guidance : guidanceFor("agent_split");
    const context =
      `원본 noteId: ${note.note.id}\n` +
      `원본 제목: ${note.note.title || "(제목 없음)"}\n` +
      `원본 folderId: ${note.note.folder_id}\n` +
      `본문:\n${fullBody}`;

    const prompt = buildAgentPlanPrompt(effectiveGuidance, context);
    const raw = await aiStore.generateFromPrompt(prompt, null);
    if (!raw) return null;

    // Only the note the user asked to split is in scope — injected ids cannot reach update/delete.
    const allowed = new Set<string>([note.note.id]);
    const plan = parseAiPlan(raw, allowed);
    if (!plan) return null;
    const canonical = canonicalizePlanDestinations(
      plan,
      new Map([[note.note.id, { folder_id: note.note.folder_id }]]),
      note.note.folder_id,
    );
    if (canonical.actions.length === 0) return null;
    return attachPlanApplyScope(
      ensureSplitOriginalDisposition(canonical, note.note.id, note.note.title),
      [note.note],
    );
  } finally {
    aiStore.removeGlow(glowKey);
  }
}

/**
 * Chat "이 노트에 반영" — one update_note for the scoped note. pet_chat never writes;
 * the review modal + executeApprovedPlan do. Delete/rename/merge from the model are dropped.
 */
export async function generateFillNotePlan(
  note: NoteDetail,
  instruction?: string,
): Promise<AiPlan | null> {
  const fullBody = note.sections.map((s) => s.body_md).join("\n\n");
  const glowKey = AI_GLOW_KEYS.note(note.note.id);
  const aiStore = useAiStore.getState();
  aiStore.addGlow(glowKey);

  try {
    await ensureAgentPresetsLoaded();
    const guidance =
      "활성 노트 본문을 사용자 요청에 맞게 다듬어 반영하는 계획만 작성하세요. " +
      "type 은 update_note 만 허용한다. delete_note / merge_notes / create_note 는 넣지 마세요. " +
      "payload.noteId 는 제공된 원본 id 만 쓰고, bodyMd 에 반영할 본문 전체를 넣으세요.";
    const extra = instruction?.trim() ? `\n사용자 요청:\n${instruction.trim()}` : "";
    const context =
      `원본 noteId: ${note.note.id}\n` +
      `원본 제목: ${note.note.title || "(제목 없음)"}\n` +
      `원본 folderId: ${note.note.folder_id}\n` +
      `본문:\n${fullBody || "(비어 있음)"}` +
      extra;

    const prompt = buildAgentPlanPrompt(guidance, context);
    const raw = await aiStore.generateFromPrompt(prompt, null);
    if (!raw) return null;

    const allowed = new Set<string>([note.note.id]);
    const plan = parseAiPlan(raw, allowed);
    if (!plan) return null;
    const updates = plan.actions.filter(
      (action) => action.type === "update_note" && action.payload.noteId === note.note.id,
    );
    if (updates.length === 0) return null;
    return attachPlanApplyScope(
      canonicalizePlanDestinations(
        { ...plan, actions: updates },
        new Map([[note.note.id, { folder_id: note.note.folder_id }]]),
        note.note.folder_id,
      ),
      [note.note],
    );
  } finally {
    aiStore.removeGlow(glowKey);
  }
}

/**
 * Scope 2: Folder-Level (Merge, Clean, Delete).
 * Loads a **bounded** note_query(folder_ids) page — not the tree's windowed cache — so the model
 * judges the folder it was actually asked about (see FOLDER_AI_SCAN_CAP). Evaluates note
 * summaries; schema includes merge_notes and delete_note (not update-only).
 */
export async function generateFolderOrganizePlan(
  folderId: string,
  folderName: string,
  /** Optional preloaded notes — tests inject these. Production entry passes nothing. */
  preloadedNotes?: NoteSummary[],
): Promise<AiPlan | null> {
  const glowKey = AI_GLOW_KEYS.folder(folderId);
  const aiStore = useAiStore.getState();
  aiStore.addGlow(glowKey);

  try {
    let notes: NoteSummary[];
    let scanTruncated = 0;

    if (preloadedNotes) {
      notes = preloadedNotes;
    } else {
      const collected = await noteQueryCollect(
        { folderIds: [folderId], sort: "updated_desc" },
        { maxNotes: FOLDER_AI_SCAN_CAP },
      );
      notes = excludeAiFolders(await hydrateTagNames(collected.notes));
      scanTruncated = Math.max(0, collected.total - collected.notes.length);
    }

    if (notes.length === 0) return null;

    await ensureAgentPresetsLoaded();
    const guidance = guidanceFor("agent_folder");
    const folder = useNotesStore.getState().folders.find((f) => f.id === folderId);
    const summaryList = notes
      .map((n) => `- [${n.id}] "${n.title}" (tags: ${(n.tag_names ?? []).join(",") || "—"})`)
      .join("\n");
    const context =
      `폴더 이름: ${folderName}\n` +
      (folder?.rules?.trim() ? `폴더 지침: ${folder.rules.trim()}\n` : "") +
      `평가한 노트 수: ${notes.length}` +
      (scanTruncated > 0
        ? ` (폴더 전체 ${notes.length + scanTruncated}개 중 상위 ${notes.length}개만 스캔 — 나머지 ${scanTruncated}개는 이 검토에 포함되지 않았습니다)`
        : "") +
      `\n노트 목록:\n${summaryList}`;

    const prompt = buildAgentPlanPrompt(guidance, context);
    const raw = await aiStore.generateFromPrompt(prompt, null);
    if (!raw) return null;
    const allowed = new Set(notes.map((n) => n.id));
    const plan = parseAiPlan(raw, allowed);
    if (!plan) return null;
    const notesById = new Map(notes.map((note) => [note.id, note] as const));
    const canonical = canonicalizePlanDestinations(plan, notesById, folderId);
    const reviewed = await draftHydratedMerges(canonical, allowed, notesById, folderId);
    if (reviewed.actions.length === 0) return null;
    // Quiet truncation is the exact bug this fix closes — always surface it on the plan so the
    // review modal's existing truncatedCount banner (AiAgentReviewModal.tsx) renders it, same as
    // the workspace scope.
    if (scanTruncated > 0) reviewed.truncatedCount = scanTruncated;
    return attachPlanApplyScope(reviewed, notes);
  } finally {
    aiStore.removeGlow(glowKey);
  }
}

/**
 * P2 2단계 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — 펫이 이미 겹침을 감지해 넘긴
 * "정확히 이 두 노트" 쌍만 평가한다(agent_folder 처럼 후보를 스캔하지 않는다). 호출자는 두 노트
 * 모두 flushAll() 이후 note_get 으로 새로 읽어서 넘겨야 한다(CLAUDE.md 함정 4 — activeNote.sections
 * 는 캐럿 보호로 갱신을 미룬다).
 */
export async function generateMergeSuggestionPlan(
  noteA: NoteDetail,
  noteB: NoteDetail,
): Promise<AiPlan | null> {
  const bodyA = noteA.sections.map((s) => s.body_md).join("\n\n");
  const bodyB = noteB.sections.map((s) => s.body_md).join("\n\n");
  if (!bodyA.trim() && !bodyB.trim()) return null;

  const glowKey = AI_GLOW_KEYS.note(noteA.note.id);
  const aiStore = useAiStore.getState();
  aiStore.addGlow(glowKey);

  try {
    await ensureAgentPresetsLoaded();
    const guidance = guidanceFor("agent_merge");
    const context =
      `노트 A — id: ${noteA.note.id}, 제목: ${noteA.note.title || "(제목 없음)"}, 폴더: ${noteA.note.folder_id}\n` +
      `본문 A:\n${bodyA}\n\n` +
      `노트 B — id: ${noteB.note.id}, 제목: ${noteB.note.title || "(제목 없음)"}\n` +
      `본문 B:\n${bodyB}`;

    const prompt = buildAgentPlanPrompt(guidance, context);
    const raw = await aiStore.generateFromPrompt(prompt, null);
    if (!raw) return null;

    // 이 쌍의 두 노트 밖은 스코프가 아니다 — 다른 noteId 를 참조하는 액션은 버려진다.
    const allowed = new Set<string>([noteA.note.id, noteB.note.id]);
    const plan = parseAiPlan(raw, allowed);
    if (!plan) return null;
    const notesById = new Map([
      [noteA.note.id, { folder_id: noteA.note.folder_id, title: noteA.note.title }],
      [noteB.note.id, { folder_id: noteB.note.folder_id, title: noteB.note.title }],
    ] as const);
    const canonical = canonicalizePlanDestinations(plan, notesById, noteA.note.folder_id);
    // This entry point already receives the exact two bodies, unlike folder/workspace scans.
    // Attach them for review without issuing an unnecessary second request.
    const sourceById = new Map<string, AiPlanSourceNote>([
      [noteA.note.id, { id: noteA.note.id, title: noteA.note.title, bodyMd: bodyA }],
      [noteB.note.id, { id: noteB.note.id, title: noteB.note.title, bodyMd: bodyB }],
    ]);
    return attachPlanApplyScope({
      ...canonical,
      actions: canonical.actions.map((action) => action.type === "merge_notes"
        ? { ...action, payload: { ...action.payload, sourceNotes: (action.payload.sourceNoteIds ?? []).map((id) => sourceById.get(id)).filter((source): source is AiPlanSourceNote => Boolean(source)) } }
        : action),
    }, [noteA.note, noteB.note]);
  } finally {
    aiStore.removeGlow(glowKey);
  }
}

/**
 * Scope 3: Workspace-Level (Structure Refactoring).
 * Loads a **bounded** workspace page via note_query (not expanded-folder cache),
 * compresses with filterWorkspaceCandidates, then asks AI for a plan.
 */
export async function generateWorkspaceRefactorPlan(
  /** Optional preloaded notes — tests inject these. Production entry passes nothing. */
  preloadedNotes?: NoteSummary[],
): Promise<AiPlan | null> {
  const aiStore = useAiStore.getState();
  let glowKey: string | null = null;
  try {
    const s = await call<{ settings: Record<string, unknown> }>("settings_get_all");
    const activeWsId = (s.settings.active_workspace_id as string) || "";
    if (activeWsId) glowKey = AI_GLOW_KEYS.workspace(activeWsId);
  } catch {
    /* fallback to no glowKey */
  }

  if (glowKey) aiStore.addGlow(glowKey);

  try {
    let notes: NoteSummary[];
    let scanTruncated = 0;

    if (preloadedNotes) {
      notes = preloadedNotes;
    } else {
      const collected = await noteQueryCollect(
        { sort: "updated_desc" },
        { maxNotes: WORKSPACE_AI_SCAN_CAP },
      );
      notes = excludeAiFolders(await hydrateTagNames(collected.notes));
      scanTruncated = Math.max(0, collected.total - collected.notes.length);
    }

    const filterResult = filterWorkspaceCandidates(notes);
    if (filterResult.candidates.length === 0) return null;

    await ensureAgentPresetsLoaded();
    const guidance = guidanceFor("agent_workspace");
    const candidateSummary = filterResult.candidates
      .map((c) => `- [${c.noteId}] "${c.title}" (Signal: ${c.reason})`)
      .join("\n");
    const context =
      `평가한 노트 수: ${filterResult.totalEvaluated}` +
      // = 노트북 (내부 filterWorkspaceCandidates / agent_workspace id 유지)
      (scanTruncated > 0 ? ` (노트북 전체 ${filterResult.totalEvaluated + scanTruncated} 중 상위 스캔)` : "") +
      `\n압축 후보:\n${candidateSummary}`;

    const prompt = buildAgentPlanPrompt(guidance, context);
    const raw = await aiStore.generateFromPrompt(prompt, null);
    if (!raw) return null;

    const allowed = new Set(filterResult.candidates.map((c) => c.noteId));
    const plan = parseAiPlan(raw, allowed);
    if (!plan) return null;
    const notesById = new Map(notes.map((note) => [note.id, note] as const));
    const canonical = canonicalizePlanDestinations(plan, notesById);
    const reviewed = await draftHydratedMerges(canonical, allowed, notesById);
    if (reviewed.actions.length === 0) return null;
    reviewed.truncatedCount = (filterResult.truncatedCount || 0) + scanTruncated;
    return attachPlanApplyScope(reviewed, notes);
  } finally {
    if (glowKey) aiStore.removeGlow(glowKey);
  }
}

