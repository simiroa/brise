import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Folder } from "../lib/commands.gen";

const defaultImpl = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "note_query") {
    const folder = (args?.folder_ids as string[] | undefined)?.[0];
    if (folder === "inbox") return { notes: [{ id: "u1" }, { id: "u2" }], total: 2 };
    if (folder === "f1") return { notes: [{ id: "a1" }], total: 1 };
    return { notes: [], total: 0 };
  }
  return {};
};
const call = vi.fn(defaultImpl);
const emitNotice = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: (msg: string) => emitNotice(msg),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));
// The batch modal itself is desktop's (covered by its own tests) — here we only pin WHICH notes reach it.
vi.mock("../components/AiBatchOrganizeModal", () => ({
  AiBatchOrganizeModal: ({ noteIds }: { noteIds: string[] }) => (
    <div data-testid="batch-modal">{noteIds.join(",")}</div>
  ),
}));

import { t } from "../i18n/t";
import { MobileFolderAiSheet, FOLDER_AI_NOTE_CAP, FOLDER_AI_DEFAULT_LIMIT } from "./MobileFolderAiSheet";

function folder(patch: Partial<Folder>): Folder {
  return {
    id: "f",
    workspace_id: "ws1",
    name: "F",
    position: 0,
    is_open: false,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
    ...patch,
  };
}

const FOLDERS: Folder[] = [
  folder({ id: "inbox", name: "inbox", note_count: 2 }),
  folder({ id: "f1", name: "Work", note_count: 1 }),
  folder({ id: "f2", name: "Private", note_count: 3, ai_excluded: true }),
];

function renderSheet(props: Partial<React.ComponentProps<typeof MobileFolderAiSheet>> = {}) {
  const onClose = vi.fn();
  render(<MobileFolderAiSheet inboxId="inbox" folders={FOLDERS} aiReady onClose={onClose} {...props} />);
  return { onClose };
}

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(defaultImpl);
  emitNotice.mockClear();
});

describe("MobileFolderAiSheet — ① 미분류 노트 정리", () => {
  it("feeds the current notebook's Inbox notes to the same batch AI organize modal MobileBulkSelection uses", async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("mobile-folder-ai-inbox"));
    await waitFor(() => expect(screen.getByTestId("batch-modal").textContent).toBe("u1,u2"));
    expect(call).toHaveBeenCalledWith("note_query", { folder_ids: ["inbox"], sort: "updated_desc", limit: FOLDER_AI_DEFAULT_LIMIT });
  });

  it("is disabled with a reason when the Inbox is empty / missing / AI-excluded", () => {
    const { unmount } = render(
      <MobileFolderAiSheet inboxId="inbox" folders={[folder({ id: "inbox", note_count: 0 })]} aiReady onClose={() => {}} />,
    );
    expect((screen.getByTestId("mobile-folder-ai-inbox") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("mobileFolderAi.inbox_empty"))).toBeTruthy();
    unmount();

    renderSheet({ inboxId: null });
    expect((screen.getByTestId("mobile-folder-ai-inbox") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("mobileFolderAi.inbox_missing"))).toBeTruthy();
  });

  it("does not open the batch modal (and says so) when the folder query comes back empty", async () => {
    call.mockImplementationOnce(async () => ({ notes: [], total: 0 }));
    renderSheet();
    fireEvent.click(screen.getByTestId("mobile-folder-ai-inbox"));
    await waitFor(() => expect(emitNotice).toHaveBeenCalledWith(t("mobileFolderAi.folder_no_notes")));
    expect(screen.queryByTestId("batch-modal")).toBeNull();
  });
});

describe("MobileFolderAiSheet — 기본 30개 + 더 보기", () => {
  it("queries 30 by default; a full page offers 더 보기 which re-queries with the 200 cap", async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
    call.mockImplementation(async (cmd, args) => {
      if (cmd === "note_query") return { notes: mk(args?.limit === FOLDER_AI_NOTE_CAP ? 50 : 30), total: 50 };
      return {};
    });
    renderSheet();
    fireEvent.click(screen.getByTestId("mobile-folder-ai-inbox"));
    await waitFor(() => expect(screen.getByTestId("mobile-folder-ai-more")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("note_query", { folder_ids: ["inbox"], sort: "updated_desc", limit: 30 });
    expect(FOLDER_AI_DEFAULT_LIMIT).toBe(30);
    expect(screen.queryByTestId("batch-modal")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-folder-ai-load-more"));
    await waitFor(() => expect(screen.getByTestId("batch-modal").textContent!.split(",").length).toBe(50));
    expect(call).toHaveBeenCalledWith("note_query", { folder_ids: ["inbox"], sort: "updated_desc", limit: FOLDER_AI_NOTE_CAP });
  });

  it("a full page can also start right away with the 30 loaded", async () => {
    call.mockImplementation(async (cmd) =>
      cmd === "note_query" ? { notes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}` })), total: 99 } : {},
    );
    renderSheet();
    fireEvent.click(screen.getByTestId("mobile-folder-ai-inbox"));
    await waitFor(() => screen.getByTestId("mobile-folder-ai-start"));
    fireEvent.click(screen.getByTestId("mobile-folder-ai-start"));
    expect(screen.getByTestId("batch-modal").textContent!.split(",").length).toBe(30);
  });
});

describe("MobileFolderAiSheet — ② 폴더 골라 정리", () => {
  it("picks a folder (Inbox not offered, AI-excluded folder disabled), then batch-organizes that folder's notes", async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("mobile-folder-ai-folder"));
    expect(screen.getByTestId("mobile-folder-ai-picker")).toBeTruthy();
    expect(screen.queryByTestId("mobile-folder-ai-pick-inbox")).toBeNull();
    expect((screen.getByTestId("mobile-folder-ai-pick-f2") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("mobile-folder-ai-pick-f1"));
    await waitFor(() => expect(screen.getByTestId("batch-modal").textContent).toBe("a1"));
    expect(call).toHaveBeenCalledWith("note_query", { folder_ids: ["f1"], sort: "updated_desc", limit: FOLDER_AI_DEFAULT_LIMIT });
  });

  it("desktop's 정리·병합 제안 is shown disabled with a reason (ai_apply_plan is not reachable over HTTP)", () => {
    renderSheet();
    expect((screen.getByTestId("mobile-folder-ai-plan") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("mobileFolderAi.plan_desktop_only"))).toBeTruthy();
  });
});

describe("MobileFolderAiSheet — AI not ready", () => {
  it("shows the AI-disabled hint and disables both entries", () => {
    renderSheet({ aiReady: false });
    expect(screen.getByText(t("mobile.ai_disabled_hint"))).toBeTruthy();
    expect((screen.getByTestId("mobile-folder-ai-inbox") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mobile-folder-ai-folder") as HTMLButtonElement).disabled).toBe(true);
  });
});
