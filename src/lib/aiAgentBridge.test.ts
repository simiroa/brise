import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
}));

const loadTreeMock = vi.fn(async () => {});
const reloadActiveMock = vi.fn(async () => {});
vi.mock("../stores/notes", () => ({
  useNotesStore: { getState: () => ({ loadTree: loadTreeMock, reloadActive: reloadActiveMock }) },
}));

import { executeApprovedPlan, type AiPlanAction } from "./aiAgentBridge";

function action(overrides: Partial<AiPlanAction> & Pick<AiPlanAction, "type">): AiPlanAction {
  return { id: overrides.id ?? "model-display-id", type: overrides.type, description: "", payload: overrides.payload ?? {} };
}

describe("executeApprovedPlan", () => {
  beforeEach(() => {
    callMock.mockReset();
    loadTreeMock.mockClear();
    reloadActiveMock.mockClear();
  });

  it("sends app-owned receipts to the one atomic backend command without an Inbox fallback", async () => {
    callMock.mockImplementation(async (command: string, args: { actions: { action_id: string }[] }) => {
      expect(command).toBe("ai_apply_plan");
      return args.actions.map((item) => ({ action_id: item.action_id, status: "applied" }));
    });
    const result = await executeApprovedPlan([
      action({ type: "create_note", payload: { folderId: "folder-1", title: "T", bodyMd: "B" } }),
      action({ id: "merge-display", type: "merge_notes", payload: { folderId: "folder-1", sourceNoteIds: ["a", "b"], bodyMd: "merged" } }),
    ], "execution-1");

    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("ai_apply_plan", expect.objectContaining({
      execution_id: "execution-1",
      actions: [
        expect.objectContaining({ kind: "create_note", payload: { folder_id: "folder-1", title: "T", body_md: "B" } }),
        expect.objectContaining({ kind: "merge_notes", payload: { folder_id: "folder-1", source_note_ids: ["a", "b"], body_md: "merged" } }),
      ],
    }));
    const sent = callMock.mock.calls[0][1].actions as { action_id: string }[];
    expect(sent[0].action_id).not.toBe("model-display-id");
    expect(result).toMatchObject({ executed: 2, completedActionIds: ["model-display-id", "merge-display"], failed: [] });
  });

  it("maps per-action backend failures while preserving completed actions for retry UI", async () => {
    callMock.mockImplementation(async (_command: string, args: { actions: { action_id: string }[] }) => [
      { action_id: args.actions[0].action_id, status: "applied" },
      { action_id: args.actions[1].action_id, status: "failed", error: "stale proposal" },
    ]);
    const first = action({ id: "first", type: "update_note", payload: { noteId: "n1", title: "T" } });
    const second = action({ id: "second", type: "delete_note", payload: { noteId: "n2" } });
    const result = await executeApprovedPlan([first, second], "execution-2");

    expect(result.completedActionIds).toEqual(["first"]);
    expect(result.failed).toEqual([{ action: second, message: "stale proposal" }]);
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an app-generated action receipt when the same failed action is retried", async () => {
    callMock.mockImplementation(async (_command: string, args: { actions: { action_id: string }[] }) =>
      args.actions.map((item) => ({ action_id: item.action_id, status: "failed", error: "retry" })),
    );
    const failed = action({ type: "delete_note", payload: { noteId: "n1" } });
    await executeApprovedPlan([failed], "execution-stable");
    await executeApprovedPlan([failed], "execution-stable");
    expect(callMock.mock.calls[0][1].actions[0].action_id).toBe(callMock.mock.calls[1][1].actions[0].action_id);
  });

  it("forwards the plan-time revision and folder scope with the active workspace", async () => {
    callMock.mockImplementation(async (command: string, args?: { actions?: { action_id: string }[] }) => {
      if (command === "settings_get_all") return { settings: { active_workspace_id: "ws-1" } };
      return args!.actions!.map((item) => ({ action_id: item.action_id, status: "applied" }));
    });

    await executeApprovedPlan(
      [action({ type: "update_note", payload: { noteId: "n1", title: "T" } })],
      "execution-scoped",
      {
        noteRevisions: { n1: "2026-08-09T00:00:00Z" },
        noteFolderIds: { n1: "folder-1" },
        folderIds: ["folder-1"],
      },
    );

    expect(callMock).toHaveBeenCalledWith("ai_apply_plan", expect.objectContaining({
      workspace_id: "ws-1",
      scope: {
        note_revisions: { n1: "2026-08-09T00:00:00Z" },
        note_folder_ids: { n1: "folder-1" },
        folder_ids: ["folder-1"],
      },
    }));
  });
});
