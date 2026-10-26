import { call, flushAll } from "../../../lib/invoke";
import type { AiPlan } from "../../../lib/aiAgentBridge";
import type { NoteDetail } from "../../../lib/commands.gen";
import {
  generateFolderOrganizePlan,
  generateWorkspaceRefactorPlan,
} from "../../../stores/aiAgentActions";
import { useNotesStore } from "../../../stores/notes";
import { generateAndInsertFillSection } from "./petChatSection";

import { PET_EVENT } from "./petEvents";

export const PET_REVIEW_CHAT_PLAN_EVENT = PET_EVENT.reviewChatPlan;

export type PetChatPlanKind = "fill_note" | "rename_plan" | "prune_plan";

export interface PetChatPlanRequest {
  plan_kind?: PetChatPlanKind | string;
  note_id?: string;
  instruction?: string;
}

export function isPetChatPlanKind(value: string | undefined): value is PetChatPlanKind {
  return value === "fill_note" || value === "rename_plan" || value === "prune_plan";
}

/** fill_note is a new-section write, not a review-modal plan. */
export function isReviewPlanKind(value: string | undefined): boolean {
  return value === "rename_plan" || value === "prune_plan";
}

/**
 * Chip click → existing agent generators for rename/prune.
 * fill_note inserts a new section (docs/AI.md §4.0) and returns null so no modal opens.
 */
export async function generatePetChatPlan(req: PetChatPlanRequest): Promise<AiPlan | null> {
  const kind = isPetChatPlanKind(req.plan_kind) ? req.plan_kind : "prune_plan";
  if (kind === "fill_note") {
    await generateAndInsertFillSection(req.note_id, req.instruction);
    return null;
  }
  if (kind === "rename_plan") {
    const folder = await folderForActive(req.note_id);
    if (folder) {
      const plan = await generateFolderOrganizePlan(folder.id, folder.name);
      if (plan) return plan;
    }
    return generateWorkspaceRefactorPlan();
  }
  return generateWorkspaceRefactorPlan();
}

async function folderForActive(noteId?: string): Promise<{ id: string; name: string } | null> {
  const store = useNotesStore.getState();
  const active = store.activeNote;
  let folderId = active?.note.folder_id;
  if (noteId && active?.note.id !== noteId) {
    try {
      await flushAll();
      folderId = (await call<NoteDetail>("note_get", { id: noteId })).note.folder_id;
    } catch {
      folderId = undefined;
    }
  }
  if (!folderId) return null;
  const folder = store.folders.find((item) => item.id === folderId);
  return { id: folderId, name: folder?.name || "" };
}
