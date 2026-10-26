import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary } from "../lib/commands.gen";

const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  // stores/ai.ts now imports lib/undo.ts (W6 folder-move undo toast), which registers a flush
  // callback at module load — the mock needs the export even though this file never exercises it.
  registerFlush: vi.fn(),
}));

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "note-1",
    folder_id: "root",
    title: "",
    year: 0,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    month: null,
    day: null,
    ...overrides,
  } as NoteSummary;
}

const mockReloadActive = vi.fn();
const mockSetSavedState = vi.fn();
const mockLoadTree = vi.fn();
let mockNoteIndex = new Map<string, NoteSummary>([
  ["note-1", note({ id: "note-1", title: "Active Note" })],
  ["note-bg", note({ id: "note-bg", title: "Background Note" })],
]);
let mockFolders: { id: string; name: string }[] = [];
const mockInboxId = "root";

// Selector-callable store stub (AiConfirmModal reads noteIndex / activeNote / folders / inboxId
// as hooks; applyProposal in ai.ts also uses getState()).
function mockUseNotesStore(selector?: (s: Record<string, unknown>) => unknown) {
  const state = {
    activeNote: { note: { id: "note-1", title: "Active Note" } },
    noteIndex: mockNoteIndex,
    folders: mockFolders,
    inboxId: mockInboxId,
    reloadActive: mockReloadActive,
    setSavedState: mockSetSavedState,
    loadTree: mockLoadTree,
  };
  if (typeof selector === "function") return selector(state);
  return state;
}
mockUseNotesStore.getState = () => mockUseNotesStore() as never;

vi.mock("../stores/notes", () => ({
  useNotesStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => mockUseNotesStore(selector),
    { getState: () => mockUseNotesStore() },
  ),
  // stores/ai.ts::applyProposal now guards on this (내용잠금, F-N09) — 이 파일의 note() 픽스처는
  // content_locked를 세팅한 적이 없으니(FolderBadge.test.tsx/aiPostProcess.test.ts와 같은 이유로)
  // 항상 false로 둔다.
  isNoteContentLocked: () => false,
  // applyProposal 의 되돌리기 토스트 문구가 이것을 거친다 — notesActive.displayTitle 과 같은 판정.
  displayTitle: (t: string) => (t.trim() && t !== "Untitled Note" ? t : "Untitled Note"),
}));

import { useAiStore } from "../stores/ai";
import { AiConfirmModal } from "./AiConfirmModal";
import { useProposalHostStore } from "../stores/proposalHost";

describe("AiConfirmModal — field-level selection (W1, PLAN-2026-09-05 §1)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ applied: [] });
    mockReloadActive.mockReset();
    mockSetSavedState.mockReset();
    mockLoadTree.mockReset();
    mockNoteIndex = new Map([
      ["note-1", note({ id: "note-1", title: "Active Note" })],
      ["note-bg", note({ id: "note-bg", title: "Background Note" })],
    ]);
    mockFolders = [];
    useAiStore.setState({ lastProposal: null, lastProposalNoteId: null });
  });

  it("renders nothing when there is no proposal", () => {
    const { container } = render(<AiConfirmModal />);
    expect(container.firstChild).toBeNull();
  });

  // 2026-09-27 — AI 모달이 "메타데이터 포함" 삽입 뒤 그 노트의 제안을 제 안에 품는다. 그 노트의 제안만 숨고,
  // 다른 노트의 제안(배경·대기열)은 그대로 여기서 뜬다.
  it("hides only the proposal the AI modal is hosting", () => {
    useProposalHostStore.setState({ noteId: "note-bg" });
    try {
      useAiStore.setState({ lastProposal: { title: "T", confidence: 0.8 }, lastProposalNoteId: "note-bg" });
      const { container, rerender } = render(<AiConfirmModal />);
      expect(container.firstChild).toBeNull();
      expect(screen.queryByRole("heading")).toBeNull();
      useAiStore.setState({ lastProposal: { title: "T", confidence: 0.8 }, lastProposalNoteId: "note-other" });
      rerender(<AiConfirmModal />);
      expect(screen.getByTestId("ai-proposal-panel")).toBeTruthy();
    } finally {
      useProposalHostStore.setState({ noteId: null });
    }
  });

  it("header shows the target note title (background organize must not look anonymous)", () => {
    useAiStore.setState({
      lastProposal: { title: "T", confidence: 0.8 },
      lastProposalNoteId: "note-bg",
    });
    render(<AiConfirmModal />);
    expect(screen.getByRole("heading", { name: /Background Note/ })).toBeTruthy();
  });

  it("Cancel clears the proposal without calling any backend command", async () => {
    useAiStore.setState({
      lastProposal: { title: "T", folder_id: "f-1", folder_name: "Archive", confidence: 0.8 },
      lastProposalNoteId: "note-1",
    });
    render(<AiConfirmModal />);
    await userEvent.click(screen.getByRole("button", { name: /cancel|annuler|취소/i }));

    expect(callMock).not.toHaveBeenCalled();
    expect(useAiStore.getState().lastProposal).toBeNull();
  });

  it("shows the no-changes message and disables Apply when the proposal matches the current note exactly", () => {
    mockNoteIndex.set("note-1", note({ id: "note-1", title: "Same" }));
    useAiStore.setState({
      lastProposal: { title: "Same", confidence: 0.8 },
      lastProposalNoteId: "note-1",
    });
    render(<AiConfirmModal />);

    expect(screen.getByText(/변경 사항이 없|No changes|Aucun changement/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /apply|적용|appliquer/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("② 채움/덮어씀 판정 및 기본 선택", () => {
    it("fill field (current empty) is checked by default and included in the apply payload", async () => {
      mockNoteIndex.set("note-1", note({ id: "note-1", title: "" }));
      useAiStore.setState({
        lastProposal: { title: "새 제목", confidence: 0.9 },
        lastProposalNoteId: "note-1",
      });
      render(<AiConfirmModal />);

      const cb = screen.getByRole("checkbox", { name: t_field("title") }) as HTMLInputElement;
      expect(cb.checked).toBe(true);

      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));
      expect(callMock).toHaveBeenCalledWith(
        "ai_apply_organize",
        expect.objectContaining({ id: "note-1", title: "새 제목" }),
      );
    });

    it("③ overwrite field (current has a value) is unchecked by default, so Apply leaves it undefined", async () => {
      // year (empty → fill, default ON) rides along so Apply isn't disabled purely because the
      // overwrite checkbox under test starts off — the point here is title specifically stays out.
      mockNoteIndex.set("note-1", note({ id: "note-1", title: "옛 제목", year: 0 }));
      useAiStore.setState({
        lastProposal: { title: "새 제목", year: 1443, confidence: 0.9 },
        lastProposalNoteId: "note-1",
      });
      render(<AiConfirmModal />);

      const cb = screen.getByRole("checkbox", { name: t_field("title") }) as HTMLInputElement;
      expect(cb.checked).toBe(false);

      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));
      const call = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize");
      expect(call![1].year).toBe(1443);
      expect(call![1].title).toBeUndefined();
    });
  });

  describe("① 태그 12개 노트 + 모델이 12개 그대로 제안", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);

    it("Apply is disabled when the ONLY thing proposed is the same 12 tags back (true no-op, nothing to send)", () => {
      mockNoteIndex.set("note-1", note({ id: "note-1", tag_names: twelve }));
      useAiStore.setState({
        lastProposal: { tag_names: twelve, confidence: 0.9 },
        lastProposalNoteId: "note-1",
      });
      render(<AiConfirmModal />);

      // All 12 are "kept" — no per-tag checkboxes for them (only add/remove zones get checkboxes).
      for (const tag of twelve) {
        expect(screen.queryByRole("checkbox", { name: `#${tag}` })).toBeNull();
        expect(screen.getByText(`#${tag}`)).toBeTruthy();
      }
      expect((screen.getByRole("button", { name: /apply|적용|appliquer/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("applying alongside another selected field leaves every existing tag intact (no tag_names sent)", async () => {
      mockNoteIndex.set("note-1", note({ id: "note-1", title: "", tag_names: twelve }));
      useAiStore.setState({
        lastProposal: { title: "새 제목", tag_names: twelve, confidence: 0.9 },
        lastProposalNoteId: "note-1",
      });
      render(<AiConfirmModal />);

      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));
      const call = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize");
      expect(call![1].title).toBe("새 제목");
      expect(call![1].tag_names).toBeUndefined();
    });
  });

  describe("⑤ 제거 태그는 체크한 것만 빠진다", () => {
    it("unchecked removed tags survive; checking one removes only that one", async () => {
      mockNoteIndex.set("note-1", note({ id: "note-1", tag_names: ["조선", "세종", "훈민정음", "임시"] }));
      useAiStore.setState({
        lastProposal: { tag_names: ["조선", "세종", "한글"], confidence: 0.9 },
        lastProposalNoteId: "note-1",
      });
      render(<AiConfirmModal />);

      const removeTemp = screen.getByRole("checkbox", { name: "#임시" }) as HTMLInputElement;
      expect(removeTemp.checked).toBe(false);
      await userEvent.click(removeTemp);

      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));
      const call = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize");
      const sent: string[] = call![1].tag_names;
      expect(sent.sort()).toEqual(["세종", "조선", "한글", "훈민정음"].sort());
      expect(sent).not.toContain("임시");
    });
  });

  describe("over-tag soft cap (added-only, kept never capped)", () => {
    it("more than 10 NEW tags proposed on top of existing ones → only first 10 additions default-selected", () => {
      const addedTags = Array.from({ length: 13 }, (_, i) => `new${i + 1}`);
      mockNoteIndex.set("note-1", note({ id: "note-1", tag_names: ["keep1"] }));
      useAiStore.setState({
        lastProposal: { tag_names: ["keep1", ...addedTags], confidence: 0.9 },
        lastProposalNoteId: "note-1",
      });
      render(<AiConfirmModal />);

      for (let i = 1; i <= 10; i++) {
        expect((screen.getByRole("checkbox", { name: `#new${i}` }) as HTMLInputElement).checked).toBe(true);
      }
      expect((screen.getByRole("checkbox", { name: "#new11" }) as HTMLInputElement).checked).toBe(false);
      expect((screen.getByRole("checkbox", { name: "#new13" }) as HTMLInputElement).checked).toBe(false);
      // "keep1" has no checkbox at all (kept zone, always survives).
      expect(screen.queryByRole("checkbox", { name: "#keep1" })).toBeNull();
    });
  });

  it("folder row shows the proposed folder name and sends folder_id when checked (default unchecked, an overwrite)", async () => {
    mockNoteIndex.set("note-1", note({ id: "note-1", folder_id: "misc" }));
    useAiStore.setState({
      lastProposal: { folder_id: "f-1", folder_name: "Archive", confidence: 0.8 },
      lastProposalNoteId: "note-1",
    });
    render(<AiConfirmModal />);
    expect(screen.getByText(/Archive/)).toBeTruthy();

    const cb = screen.getByRole("checkbox", { name: t_field("folder_id") }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await userEvent.click(cb);
    await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));

    expect(callMock).toHaveBeenCalledWith(
      "ai_apply_organize",
      expect.objectContaining({ id: "note-1", folder_id: "f-1" }),
    );
  });

  it("omits the folder row when the proposal has no folder (제안 없음 is valid)", () => {
    useAiStore.setState({ lastProposal: { title: "T", confidence: 0.8 }, lastProposalNoteId: "note-1" });
    render(<AiConfirmModal />);
    expect(screen.queryByText(/Archive|Dossier/i)).toBeNull();
  });

  it("locks Apply while the request is running, then allows retry when it fails", async () => {
    let rejectRequest!: (reason?: unknown) => void;
    callMock.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject; }));
    mockNoteIndex.set("note-1", note({ id: "note-1", title: "" }));
    useAiStore.setState({
      lastProposal: { title: "T", confidence: 0.8 },
      lastProposalNoteId: "note-1",
    });
    render(<AiConfirmModal />);

    const apply = screen.getByRole("button", { name: /apply|적용|appliquer/i });
    fireEvent.click(apply);

    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /applying/i })).toBeTruthy();
    fireEvent.click(apply);
    expect(callMock).toHaveBeenCalledTimes(1);

    rejectRequest(new Error("network down"));
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    expect(useAiStore.getState().lastProposal).not.toBeNull();
  });
});

// Helper: field checkbox aria-label is the localized field name (ko locale is the test default —
// see t.ts: uiLang defaults to 'en' unless settings say otherwise, but this repo's vitest setup
// stubs settings such that t() falls through to the same fixed dictionary in every test file).
function t_field(key: "title" | "folder_id"): RegExp {
  return key === "title" ? /제목|Title|Titre/ : /폴더|Folder|Dossier/;
}
