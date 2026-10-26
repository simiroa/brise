import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useNotesStore } from "../stores/notes";
import { AiBatchOrganizeModal } from "./AiBatchOrganizeModal";

const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

function mockNoteTitle(id: string) {
  return `note-${id}`;
}

describe("AiBatchOrganizeModal", () => {
  const loadTreeMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    callMock.mockReset();
    loadTreeMock.mockReset().mockResolvedValue(undefined);
    const noteIndex = new Map();
    for (const id of ["n1", "n2", "n3"]) {
      noteIndex.set(id, { id, title: mockNoteTitle(id) } as any);
    }
    useNotesStore.setState({ noteIndex, loadTree: loadTreeMock } as any);

    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "settings_get_all") {
        return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
      }
      if (cmd === "ai_organize_note") {
        if (args.id === "n2") throw new Error("boom");
        return { title: `AI title ${args.id}`, year: 1999, tag_names: ["history"], region: "Paris", confidence: 0.9 };
      }
      if (cmd === "ai_apply_organize") {
        return { applied: ["title"] };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  it("calls ai_organize_note once per note id, sequentially", async () => {
    render(<AiBatchOrganizeModal noteIds={["n1", "n2", "n3"]} onClose={() => {}} />);

    await waitFor(() => {
      const organizeCalls = callMock.mock.calls.filter((c) => c[0] === "ai_organize_note");
      expect(organizeCalls.length).toBe(3);
    });
    const organizeCalls = callMock.mock.calls.filter((c) => c[0] === "ai_organize_note");
    expect(organizeCalls.map((c) => c[1].id)).toEqual(["n1", "n2", "n3"]);
  });

  // J1: every ai_organize_note call in one batch propose loop shares a single request_id, so
  // [Stop] can cancel whichever one is in flight with one ai_cancel_call({ request_id }).
  it("J1: every ai_organize_note call in the batch carries the same request_id", async () => {
    render(<AiBatchOrganizeModal noteIds={["n1", "n2", "n3"]} onClose={() => {}} />);

    await waitFor(() => {
      expect(callMock.mock.calls.filter((c) => c[0] === "ai_organize_note").length).toBe(3);
    });
    const requestIds = callMock.mock.calls
      .filter((c) => c[0] === "ai_organize_note")
      .map((c) => c[1].request_id);
    expect(requestIds[0]).toBeTruthy();
    expect(new Set(requestIds).size).toBe(1);
  });

  // J1: clicking Stop fires a real ai_cancel_call for the in-flight call's request_id — not just
  // "stop starting new notes" (that part is covered by the WF F1 test below).
  it("J1: clicking Stop calls ai_cancel_call with the batch's request_id", async () => {
    let resolveN1!: (v: unknown) => void;
    const n1Gate = new Promise((resolve) => { resolveN1 = resolve; });
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "settings_get_all") {
        return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
      }
      if (cmd === "ai_organize_note") {
        if (args.id === "n1") {
          await n1Gate;
          return { title: "AI title n1", confidence: 0.9 };
        }
        return { title: `AI title ${args.id}`, confidence: 0.9 };
      }
      if (cmd === "ai_cancel_call") return { cancelled: true, count: 1 };
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<AiBatchOrganizeModal noteIds={["n1", "n2", "n3"]} onClose={() => {}} />);
    const abortBtn = await screen.findByRole("button", { name: /중단|^stop$|arrêter/i });
    await userEvent.click(abortBtn);

    // Assert the cancel call (and its notice) BEFORE releasing n1 — n1 is still gated/in-flight
    // at this point, so the modal is still in its loading view where the notice renders. Once n1
    // resolves the loop moves on to the review table and this text is no longer on screen.
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_cancel_call", expect.objectContaining({ request_id: expect.any(String) })));
    const organizeRequestId = callMock.mock.calls.find((c) => c[0] === "ai_organize_note")![1].request_id;
    const cancelCall = callMock.mock.calls.find((c) => c[0] === "ai_cancel_call")!;
    expect(cancelCall[1].request_id).toBe(organizeRequestId);
    // count > 0 in the response swaps in the "also cancelled the in-flight call" wording.
    await screen.findByText(/진행 중인 호출도 취소했습니다|in-flight call was cancelled too|l'appel en cours a aussi été annulé/i);

    resolveN1({ title: "AI title n1", confidence: 0.9 });
  });

  it("WF F1: clicking Stop breaks the propose loop before the next note's ai_organize_note call", async () => {
    // n1's call is gated on a promise this test controls — clicking Stop while n1 is still
    // in-flight must NOT cancel n1 (no request_id to cancel it with) but MUST stop the loop from
    // ever starting n2 or n3.
    let resolveN1!: (v: unknown) => void;
    const n1Gate = new Promise((resolve) => { resolveN1 = resolve; });
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "settings_get_all") {
        return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
      }
      if (cmd === "ai_organize_note") {
        if (args.id === "n1") {
          await n1Gate;
          return { title: "AI title n1", confidence: 0.9 };
        }
        return { title: `AI title ${args.id}`, confidence: 0.9 };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<AiBatchOrganizeModal noteIds={["n1", "n2", "n3"]} onClose={() => {}} />);

    const abortBtn = await screen.findByRole("button", { name: /중단|^stop$|arrêter/i });
    await userEvent.click(abortBtn);

    // Release n1 — it's allowed to finish (its call was already in flight), but the loop must not
    // start n2 or n3 afterward.
    resolveN1({ title: "AI title n1", confidence: 0.9 });

    await waitFor(() => expect(screen.queryByText(/각 노트를 AI로|organizing each note|IA organise chaque/i)).toBeNull());

    const organizeCalls = callMock.mock.calls.filter((c) => c[0] === "ai_organize_note");
    expect(organizeCalls.map((c) => c[1].id)).toEqual(["n1"]);
    // n1 still made it into the review table — stopping doesn't throw away what's already collected.
    expect(screen.getByText("AI title n1")).toBeTruthy();
  });

  it("a failing note is skipped from the table while the others still appear", async () => {
    render(<AiBatchOrganizeModal noteIds={["n1", "n2", "n3"]} onClose={() => {}} />);

    expect(await screen.findByText("AI title n1")).toBeTruthy();
    expect(screen.getByText("AI title n3")).toBeTruthy();
    expect(screen.queryByText("AI title n2")).toBeNull();
  });

  it("unchecking a row excludes it from the bulk-apply calls", async () => {
    render(<AiBatchOrganizeModal noteIds={["n1", "n3"]} onClose={() => {}} />);

    await screen.findByText("AI title n1");
    const checkboxN1 = screen.getByLabelText(mockNoteTitle("n1"));
    await userEvent.click(checkboxN1);

    const applyBtn = screen.getByRole("button", { name: /apply|적용|appliquer/i });
    await userEvent.click(applyBtn);

    await waitFor(() => {
      const applyCalls = callMock.mock.calls.filter((c) => c[0] === "ai_apply_organize");
      expect(applyCalls.length).toBe(1);
    });
    const applyCalls = callMock.mock.calls.filter((c) => c[0] === "ai_apply_organize");
    expect(applyCalls[0][1].id).toBe("n3");
  });

  it("apply loop calls ai_apply_organize only for checked rows and then closes", async () => {
    const onClose = vi.fn();
    render(<AiBatchOrganizeModal noteIds={["n1", "n3"]} onClose={onClose} />);

    await screen.findByText("AI title n1");
    const applyBtn = screen.getByRole("button", { name: /apply|적용|appliquer/i });
    await userEvent.click(applyBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const applyCalls = callMock.mock.calls.filter((c) => c[0] === "ai_apply_organize");
    expect(applyCalls.length).toBe(2);
    expect(loadTreeMock).toHaveBeenCalled();
  });

  // A-0 (PLAN-2026-09-05 §0): ai_apply_organize's tag_names REPLACES the note's tag set — sending
  // the model's raw proposal verbatim would silently drop pre-existing tags it didn't echo back.
  it("A-0 regression: a note's existing tags survive a batch apply even when the model proposes a different tag set", async () => {
    const noteIndex = new Map();
    noteIndex.set("n1", { id: "n1", title: mockNoteTitle("n1"), tag_names: ["조선", "세종", "훈민정음"] } as any);
    useNotesStore.setState({ noteIndex, loadTree: loadTreeMock } as any);
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "settings_get_all") {
        return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
      }
      if (cmd === "ai_organize_note") {
        return { title: `AI title ${args.id}`, tag_names: ["한글"], confidence: 0.9 };
      }
      if (cmd === "ai_apply_organize") return { applied: ["title", "tags"] };
      throw new Error(`unexpected command ${cmd}`);
    });

    render(<AiBatchOrganizeModal noteIds={["n1"]} onClose={() => {}} />);
    await screen.findByText("AI title n1");
    await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));

    await waitFor(() => {
      const applyCalls = callMock.mock.calls.filter((c) => c[0] === "ai_apply_organize");
      expect(applyCalls.length).toBe(1);
    });
    const sent: string[] = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize")![1].tag_names;
    expect(sent.sort()).toEqual(["세종", "조선", "한글", "훈민정음"].sort());
  });

  // A1 (PLAN-2026-09-05 §1 A-4): the batch modal used to send title/year/region/lat/lng/
  // source_urls verbatim from the proposal regardless of whether the note already had a value —
  // silently overwriting it. It now runs every row through the same field-diff contract
  // AiConfirmModal uses: fill fields (current empty) apply by default, overwrite fields (current
  // has a value) only apply when the "also overwrite" toggle is checked.
  describe("field-level diff apply + overwrite toggle", () => {
    function setupOverwriteScenario() {
      const noteIndex = new Map();
      noteIndex.set("n1", {
        id: "n1",
        title: "Old Title",
        year: 1900,
        tag_names: ["existing"],
        region: null,
      } as any);
      useNotesStore.setState({ noteIndex, loadTree: loadTreeMock } as any);
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "settings_get_all") {
          return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
        }
        if (cmd === "ai_organize_note") {
          return {
            title: "New Title",
            year: 2000,
            region: "New Region",
            tag_names: ["existing"], // unchanged — no tag diff either way
            confidence: 0.9,
          };
        }
        if (cmd === "ai_apply_organize") return { applied: [] };
        throw new Error(`unexpected command ${cmd}`);
      });
    }

    it("① default (toggle off): title/year (both non-empty on the note) are left out of the apply call", async () => {
      setupOverwriteScenario();
      render(<AiBatchOrganizeModal noteIds={["n1"]} onClose={() => {}} />);
      await screen.findByText("New Title");

      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_apply_organize", expect.anything()));
      const sent = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize")![1];
      expect(sent.title).toBeUndefined();
      expect(sent.year).toBeUndefined();
      // region was empty on the note (null) → fill → applies by default.
      expect(sent.region).toBe("New Region");
      // tags proposed identical to current → no tag_names key at all.
      expect(sent.tag_names).toBeUndefined();
    });

    it("② checking 'also overwrite existing values' includes title/year in the apply call", async () => {
      setupOverwriteScenario();
      render(<AiBatchOrganizeModal noteIds={["n1"]} onClose={() => {}} />);
      await screen.findByText("New Title");

      const overwriteToggle = screen.getByRole("checkbox", { name: /덮어쓰기|overwrite|écraser/i });
      await userEvent.click(overwriteToggle);
      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_apply_organize", expect.anything()));
      const sent = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize")![1];
      expect(sent.title).toBe("New Title");
      expect(sent.year).toBe(2000);
      expect(sent.region).toBe("New Region");
    });

    it("③ an empty note (no title/year/tags yet) gets every proposed field as a fill, even with the toggle off", async () => {
      const noteIndex = new Map();
      noteIndex.set("n1", { id: "n1", title: "", year: 0, tag_names: [], region: null } as any);
      useNotesStore.setState({ noteIndex, loadTree: loadTreeMock } as any);
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "settings_get_all") {
          return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
        }
        if (cmd === "ai_organize_note") {
          return { title: "New Title", year: 2000, region: "New Region", tag_names: ["fresh"], confidence: 0.9 };
        }
        if (cmd === "ai_apply_organize") return { applied: [] };
        throw new Error(`unexpected command ${cmd}`);
      });

      render(<AiBatchOrganizeModal noteIds={["n1"]} onClose={() => {}} />);
      await screen.findByText("New Title");
      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_apply_organize", expect.anything()));
      const sent = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize")![1];
      expect(sent.title).toBe("New Title");
      expect(sent.year).toBe(2000);
      expect(sent.region).toBe("New Region");
      expect(sent.tag_names).toEqual(["fresh"]);
    });

    it("WF F1: a failed proposal shows up in the failure list with its title and reason", async () => {
      render(<AiBatchOrganizeModal noteIds={["n1", "n2", "n3"]} onClose={() => {}} />);

      // n2's ai_organize_note rejects with "boom" (beforeEach mock) — classifyAiError has no
      // pattern match for that string, so it falls through to "unknown".
      await screen.findByText("AI title n1");
      const toggle = await screen.findByText(/실패 1건|1 failed|1 échec/i);
      await userEvent.click(toggle);
      expect(await screen.findByText(new RegExp(`${mockNoteTitle("n2")}.*(알 수 없는 오류|unknown error|erreur inconnue)`, "i"))).toBeTruthy();
    });

    it("a row whose default payload is empty is skipped entirely — no apply call, not counted as applied", async () => {
      const noteIndex = new Map();
      // Everything already matches the proposal exactly → computeFieldDiffs produces no rows and
      // tags are identical, so there is nothing to send.
      noteIndex.set("n1", { id: "n1", title: "Same", year: 1999, tag_names: ["t"], region: "Same region" } as any);
      useNotesStore.setState({ noteIndex, loadTree: loadTreeMock } as any);
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "settings_get_all") {
          return { settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } };
        }
        if (cmd === "ai_organize_note") {
          return { title: "Same", year: 1999, region: "Same region", tag_names: ["t"], confidence: 0.9 };
        }
        throw new Error("ai_apply_organize should never be called for a no-op row");
      });

      render(<AiBatchOrganizeModal noteIds={["n1"]} onClose={() => {}} />);
      await screen.findByLabelText("Same"); // checkbox aria-label = currentTitle, row has loaded
      await userEvent.click(screen.getByRole("button", { name: /apply|적용|appliquer/i }));

      await waitFor(() => expect(loadTreeMock).toHaveBeenCalled());
      expect(callMock).not.toHaveBeenCalledWith("ai_apply_organize", expect.anything());
    });
  });

  // J2: a batch above BATCH_WARN_THRESHOLD (50) confirms once before any ai_organize_note call.
  describe("J2: note-count warning above BATCH_WARN_THRESHOLD", () => {
    it("51 notes shows a confirm dialog and makes zero calls until confirmed; Cancel makes zero calls at all", async () => {
      const manyIds = Array.from({ length: 51 }, (_, i) => `n${i}`);
      const onClose = vi.fn();
      render(<AiBatchOrganizeModal noteIds={manyIds} onClose={onClose} />);

      await screen.findByText(/51.*45|45.*51/); // warn_desc interpolates count and the 45s deadline
      expect(callMock).not.toHaveBeenCalledWith("ai_organize_note", expect.anything());

      await userEvent.click(screen.getByRole("button", { name: /^cancel$|취소|annuler/i }));
      expect(onClose).toHaveBeenCalled();
      expect(callMock).not.toHaveBeenCalledWith("ai_organize_note", expect.anything());
    });

    it("51 notes: confirming the warning starts the propose loop", async () => {
      const manyIds = Array.from({ length: 51 }, (_, i) => `n${i}`);
      render(<AiBatchOrganizeModal noteIds={manyIds} onClose={() => {}} />);

      await userEvent.click(await screen.findByRole("button", { name: /계속|continue|continuer/i }));

      await waitFor(() => {
        expect(callMock.mock.calls.filter((c) => c[0] === "ai_organize_note").length).toBeGreaterThan(0);
      });
    });

    it("exactly 50 notes: no confirm dialog, the propose loop starts immediately", async () => {
      const fiftyIds = Array.from({ length: 50 }, (_, i) => `n${i}`);
      render(<AiBatchOrganizeModal noteIds={fiftyIds} onClose={() => {}} />);

      // No PromptDialog confirm/cancel pair — the batch's own [Stop] button appears instead,
      // proving the propose loop is already running.
      await screen.findByRole("button", { name: /중단|^stop$|arrêter/i });
      expect(screen.queryByRole("button", { name: /계속|continue|continuer/i })).toBeNull();
    });
  });
});
