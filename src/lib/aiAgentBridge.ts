import { call } from "./invoke";
import { useNotesStore } from "../stores/notes";
import { randomId } from "./ids";

export type AiPlanActionType = "create_note" | "update_note" | "delete_note" | "merge_notes";

export interface AiPlanAction {
  id: string;
  type: AiPlanActionType;
  description: string;
  payload: {
    noteId?: string;
    sourceNoteIds?: string[];
    title?: string;
    bodyMd?: string;
    folderId?: string;
    /** App-hydrated source data used for review. Never accepted from model JSON. */
    sourceNotes?: AiPlanSourceNote[];
  };
}

export interface AiPlanSourceNote {
  id: string;
  title: string;
  bodyMd: string;
}

export interface AiPlan {
  title: string;
  summary: string;
  actions: AiPlanAction[];
  /** Immutable note/folder snapshot captured while composing this plan, not model output. */
  applyScope?: AiPlanApplyScope;
  truncatedCount?: number;
  /**
   * Actions dropped because payload.noteId / sourceNoteIds referenced notes outside the
   * context set passed to the model (deterministic injection boundary — not the scan cap).
   */
  filteredOutOfScopeCount?: number;
}

export interface PlanExecutionResult {
  executed: number;
  /** Successfully committed (or previously committed) plan action display IDs. */
  completedActionIds: string[];
  /** 액션별 실패 — 호출자에게 그대로 넘긴다. 절대 삼키지 않는다. */
  failed: { action: AiPlanAction; message: string }[];
}

export interface AiPlanApplyScope {
  workspaceId?: string;
  noteRevisions: Record<string, string>;
  noteFolderIds: Record<string, string>;
  folderIds: string[];
}

type BackendPlanAction = {
  action_id: string;
  kind: AiPlanActionType;
  payload: {
    note_id?: string;
    source_note_ids?: string[];
    title?: string;
    body_md?: string;
    folder_id?: string;
  };
};

type BackendPlanActionResult = {
  action_id: string;
  status: "applied" | "already_applied" | "failed";
  note_id?: string;
  error?: string;
};

const localActionIds = new WeakMap<AiPlanAction, string>();

/** A modal creates one id and retains it for retries; backend receipts make it idempotent. */
export function createPlanExecutionId(): string {
  return randomId("ai-plan");
}

function actionReceiptId(action: AiPlanAction): string {
  const existing = localActionIds.get(action);
  if (existing) return existing;
  const id = randomId("ai-action");
  localActionIds.set(action, id);
  return id;
}

function backendAction(action: AiPlanAction): BackendPlanAction {
  return {
    action_id: actionReceiptId(action),
    kind: action.type,
    payload: {
      ...(action.payload.noteId ? { note_id: action.payload.noteId } : {}),
      ...(action.payload.sourceNoteIds ? { source_note_ids: action.payload.sourceNoteIds } : {}),
      ...(action.payload.title !== undefined ? { title: action.payload.title } : {}),
      ...(action.payload.bodyMd !== undefined ? { body_md: action.payload.bodyMd } : {}),
      ...(action.payload.folderId ? { folder_id: action.payload.folderId } : {}),
    },
  };
}

/**
 * Approved writes cross exactly one backend boundary. That command validates every reference,
 * applies each action atomically, and stores an execution/action receipt. The UI never falls
 * back to Inbox and never reconstructs a merge out of multiple client calls.
 */
export async function executeApprovedPlan(
  actions: AiPlanAction[],
  executionId = createPlanExecutionId(),
  applyScope?: AiPlanApplyScope,
): Promise<PlanExecutionResult> {
  const outgoing = actions.map(backendAction);
  const byReceiptId = new Map(outgoing.map((action, index) => [action.action_id, actions[index]]));
  let scopedArgs: Record<string, unknown> = {};
  if (applyScope) {
    let workspaceId = applyScope.workspaceId;
    if (!workspaceId) {
      const settings = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      workspaceId = typeof settings.settings.active_workspace_id === "string"
        ? settings.settings.active_workspace_id
        : "";
    }
    if (!workspaceId) throw new Error("AI plan workspace is unavailable");
    scopedArgs = {
      workspace_id: workspaceId,
      scope: {
        note_revisions: applyScope.noteRevisions,
        note_folder_ids: applyScope.noteFolderIds,
        folder_ids: applyScope.folderIds,
      },
    };
  }
  const results = await call<BackendPlanActionResult[]>("ai_apply_plan", {
    execution_id: executionId,
    actions: outgoing,
    ...scopedArgs,
  });
  const failed = results
    .filter((result) => result.status === "failed")
    .flatMap((result) => {
      const action = byReceiptId.get(result.action_id);
      return action ? [{ action, message: result.error || "AI plan action failed" }] : [];
    });
  const completedActionIds = results
    .filter((result) => result.status === "applied" || result.status === "already_applied")
    .flatMap((result) => byReceiptId.get(result.action_id)?.id ?? []);

  if (completedActionIds.length > 0) {
    await useNotesStore.getState().loadTree();
    await useNotesStore.getState().reloadActive();
  }

  return { executed: results.filter((result) => result.status === "applied").length, completedActionIds, failed };
}
