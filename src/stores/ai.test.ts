import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

// W6: applyProposal's folder-move undo toast goes through the same undo primitive as
// trash/archive/link-unlink (lib/undo.ts) — mock it like attachmentService.test.ts does, so this
// file doesn't need undo.ts's own registerFlush(../lib/invoke) module-load wiring.
const showUndoToastMock = vi.fn();
vi.mock("../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => showUndoToastMock(...args),
}));

// Identity t() — same convention as attachmentService.test.ts: assertions below check the raw
// i18n KEY (e.g. "undo.note_moved"), not a rendered locale string.
vi.mock("../i18n/t", () => ({
  t: (k: string) => k,
}));

// A(AUDIT-2026-09-26): ensureAiReachable's background probe failure is now instrumented.
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

// notes store isn't exercised by most of these tests, but ai.ts imports it — stub to avoid
// pulling in the real store's tauri-invoke side effects. Mutable so the propose/apply tests
// below can simulate an active note; vitest hoists vi.mock and allows referencing `mock*`-
// prefixed bindings from inside the factory.
const mockReloadActive = vi.fn();
const mockSetSavedState = vi.fn();
const mockLoadTree = vi.fn();
const mockSelectNote = vi.fn();
let mockActiveNote: { note: { id: string } } | null = null;
// F-N09 확장: applyProposal 내용잠금 가드용. isNoteContentLocked는 대상이 activeNote와 다를 수
// 있는 경로(백그라운드/트리 행 organize)를 위한 id-keyed 조회라 별도 Set으로 흉내낸다.
let lockedNoteIds = new Set<string>();
// W6/A2: revert needs the note's fields BEFORE the apply (noteIndex) — empty by default,
// populated per-test. tag_names defaults to [] to match the real NoteSummary shape (always an
// array, never undefined) that buildRevertPayload's currentTags param expects.
let mockNoteIndex = new Map<string, { folder_id: string; title: string; year?: number; tag_names?: string[]; region?: string | null; lat?: number | null; lng?: number | null }>();
let mockFolders: { id: string; name: string }[] = [];

vi.mock("./notes", () => ({
  isNoteContentLocked: (id: string) => lockedNoteIds.has(id),
  // applyProposal 의 되돌리기 토스트 문구가 이것을 거친다 — notesActive.displayTitle 과 같은 판정.
  displayTitle: (t: string) => (t.trim() && t !== "Untitled Note" ? t : "Untitled Note"),
  useNotesStore: {
    getState: () => ({
      activeNote: mockActiveNote,
      reloadActive: mockReloadActive,
      setSavedState: mockSetSavedState,
      loadTree: mockLoadTree,
      selectNote: mockSelectNote,
      noteIndex: mockNoteIndex,
      folders: mockFolders,
    }),
  },
}));

import {
  useAiStore,
  _resetAiReachableCacheForTests,
  selectAiAvailability,
  getAiDisabledHint,
  safeConnError,
  computeAiCredsFingerprint,
  saveAiLastSuccess,
} from "./ai";
import { _resetAiRequestStateForTests } from "../lib/aiRequestState";

describe("ai store — translate privacy gate (R11, mirrors repo/ai.rs::translate_inner)", () => {
  beforeEach(() => {
    callMock.mockReset();
    _resetAiReachableCacheForTests();
    _resetAiRequestStateForTests();
    useAiStore.setState({
      translateEnabled: false,
      translateTargetLang: "en",
      translatedText: "",
      translatePending: false,
      translateGateOk: null,
      aiReachable: null,
      aiReachableError: null,
      aiReachableChecking: false,
    });
  });

  it("refreshTranslateGate: local ollama on loopback is OK even with ai_enabled=false", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" },
    });
    const ok = await useAiStore.getState().refreshTranslateGate();
    expect(ok).toBe(true);
  });

  it("refreshTranslateGate: cloud provider is blocked when ai_enabled=false", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: false, ai_provider: "openai", ai_endpoint: "https://api.openai.com/v1" },
    });
    const ok = await useAiStore.getState().refreshTranslateGate();
    expect(ok).toBe(false);
  });

  it("refreshTranslateGate: cloud provider is allowed once ai_enabled=true", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: true, ai_provider: "openai", ai_endpoint: "https://api.openai.com/v1" },
    });
    const ok = await useAiStore.getState().refreshTranslateGate();
    expect(ok).toBe(true);
  });

  it("refreshTranslateGate: remote (non-loopback) ollama endpoint requires ai_enabled, same as cloud", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "http://192.168.1.50:11434" },
    });
    const ok = await useAiStore.getState().refreshTranslateGate();
    expect(ok).toBe(false);
  });

  it("setTranslateEnabled(true) is refused (returns false, does not flip state) when the gate fails", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: false, ai_provider: "openai", ai_endpoint: "" },
    });
    const ok = await useAiStore.getState().setTranslateEnabled(true);
    expect(ok).toBe(false);
    expect(useAiStore.getState().translateEnabled).toBe(false);
    // settings_set must never be called for a toggle that was refused by the gate.
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
  });

  it("setTranslateEnabled(true) persists and flips state when the gate passes", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: true, ai_provider: "openai", ai_endpoint: "" },
    });
    const ok = await useAiStore.getState().setTranslateEnabled(true);
    expect(ok).toBe(true);
    expect(useAiStore.getState().translateEnabled).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { translate_enabled: true } });
  });

  it("translateNow never touches notes/section state — only updates translatedText", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } });
      }
      if (cmd === "ai_translate_text") {
        return Promise.resolve({ translated: "Hello world" });
      }
      return Promise.resolve({});
    });
    useAiStore.setState({ translateTargetLang: "en" });
    await useAiStore.getState().translateNow("Bonjour le monde");
    expect(useAiStore.getState().translatedText).toBe("Hello world");
    // Only ai_translate_text + settings_get_all should ever be called — never a note/section write.
    const calledCommands = callMock.mock.calls.map((c) => c[0]);
    expect(calledCommands).toEqual(expect.arrayContaining(["settings_get_all", "ai_translate_text"]));
    expect(calledCommands).not.toEqual(expect.arrayContaining(["section_update", "note_update"]));
  });

  it("translateNow clears the view for empty/whitespace-only input without calling the backend", async () => {
    await useAiStore.getState().translateNow("   \n  ");
    expect(useAiStore.getState().translatedText).toBe("");
    expect(callMock).not.toHaveBeenCalledWith("ai_translate_text", expect.anything());
  });
});

describe("ai store — ensureAiReachable (title-bar AI entry gate)", () => {
  const PLACEHOLDER_KEY = "sk-test-placeholder-not-a-real-key";

  function mockSettings(partial: Record<string, unknown>) {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: "ollama",
            ai_endpoint: "http://localhost:11434",
            ai_api_key: PLACEHOLDER_KEY,
            ai_model: "llama3",
            ...partial,
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return Promise.resolve({ ok: true, latency_ms: 7, models: ["llama3"] });
      }
      return Promise.resolve({});
    });
  }

  beforeEach(() => {
    callMock.mockReset();
    _resetAiReachableCacheForTests();
    _resetAiRequestStateForTests();
    useAiStore.setState({
      aiReachable: null,
      aiReachableError: null,
      aiReachableChecking: false,
      availableModels: [],
    });
  });

  it("leaves aiReachable null and never probes when ai_enabled is false", async () => {
    mockSettings({ ai_enabled: false });
    await useAiStore.getState().ensureAiReachable();
    expect(useAiStore.getState().aiReachable).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("ai_test_connection", expect.anything());
  });

  it("sets aiReachable true when ai_test_connection returns ok: true", async () => {
    mockSettings({ ai_enabled: true });
    await useAiStore.getState().ensureAiReachable();
    expect(useAiStore.getState().aiReachable).toBe(true);
    expect(useAiStore.getState().aiReachableError).toBeNull();
    expect(callMock).toHaveBeenCalledWith(
      "ai_test_connection",
      expect.objectContaining({ provider: "ollama" }),
    );
    // Never assert on the key value — only that the call was made with some api_key field shape.
    const testCall = callMock.mock.calls.find((c) => c[0] === "ai_test_connection");
    expect(testCall?.[1]).toHaveProperty("api_key");
  });

  it("sets aiReachable false when ai_test_connection returns ok: false", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: "minimax",
            ai_endpoint: "",
            ai_api_key: PLACEHOLDER_KEY,
            ai_model: "",
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return Promise.resolve({ ok: false, latency_ms: 50, models: [] });
      }
      return Promise.resolve({});
    });
    await useAiStore.getState().ensureAiReachable();
    expect(useAiStore.getState().aiReachable).toBe(false);
  });

  it("sets aiReachable false when ai_test_connection throws", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: "openai",
            ai_endpoint: "",
            ai_api_key: PLACEHOLDER_KEY,
            ai_model: "",
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({});
    });
    await useAiStore.getState().ensureAiReachable();
    expect(useAiStore.getState().aiReachable).toBe(false);
    expect(useAiStore.getState().aiReachableError).toBe("network down");
  });

  // A(AUDIT-2026-09-26): the background probe's failure previously left no trace anywhere — it
  // just silently cached the failure for the TTL window (D3). Now it reports once per failure,
  // with the same already-scrubbed string as aiReachableError (never the raw unscrubbed error).
  it("reports a diag fallback with the scrubbed error when the probe throws", async () => {
    reportFallbackMock.mockClear();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: "openai",
            ai_endpoint: "",
            ai_api_key: PLACEHOLDER_KEY,
            ai_model: "",
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({});
    });
    await useAiStore.getState().ensureAiReachable();
    expect(reportFallbackMock).toHaveBeenCalledWith("ai", "probe_failed", "network down");
  });

  it("does not re-issue ai_test_connection on repeated ensure with the same creds (cache)", async () => {
    mockSettings({ ai_enabled: true });
    await useAiStore.getState().ensureAiReachable();
    await useAiStore.getState().ensureAiReachable();
    await useAiStore.getState().ensureAiReachable();
    const probes = callMock.mock.calls.filter((c) => c[0] === "ai_test_connection");
    expect(probes).toHaveLength(1);
  });

  it("re-issues ai_test_connection when the provider changes", async () => {
    let provider = "ollama";
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: provider,
            ai_endpoint: "http://localhost:11434",
            ai_api_key: PLACEHOLDER_KEY,
            ai_model: "llama3",
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return Promise.resolve({ ok: true, latency_ms: 7, models: [] });
      }
      return Promise.resolve({});
    });
    await useAiStore.getState().ensureAiReachable();
    provider = "minimax";
    await useAiStore.getState().ensureAiReachable();
    const probes = callMock.mock.calls.filter((c) => c[0] === "ai_test_connection");
    expect(probes).toHaveLength(2);
    expect(probes[0][1]).toEqual(expect.objectContaining({ provider: "ollama" }));
    expect(probes[1][1]).toEqual(expect.objectContaining({ provider: "minimax" }));
  });

  it("re-issues after AI is toggled off then on (fingerprint cleared while off)", async () => {
    let enabled = true;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: enabled,
            ai_provider: "ollama",
            ai_endpoint: "",
            ai_api_key: PLACEHOLDER_KEY,
            ai_model: "",
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return Promise.resolve({ ok: true, latency_ms: 1, models: [] });
      }
      return Promise.resolve({});
    });
    await useAiStore.getState().ensureAiReachable();
    enabled = false;
    await useAiStore.getState().ensureAiReachable();
    expect(useAiStore.getState().aiReachable).toBeNull();
    enabled = true;
    await useAiStore.getState().ensureAiReachable();
    const probes = callMock.mock.calls.filter((c) => c[0] === "ai_test_connection");
    expect(probes).toHaveLength(2);
  });
});

describe("ai store — ensureAiReachable FAILED-result TTL + backoff (D3, AUDIT-2026-09-26)", () => {
  const PLACEHOLDER_KEY = "sk-test-placeholder-not-a-real-key";
  const THIRTY_S = 30_000;
  const FIVE_MIN = 5 * 60_000;

  function probeCount() {
    return callMock.mock.calls.filter((c) => c[0] === "ai_test_connection").length;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    callMock.mockReset();
    _resetAiReachableCacheForTests();
    _resetAiRequestStateForTests();
    useAiStore.setState({
      aiReachable: null,
      aiReachableError: null,
      aiReachableChecking: false,
      availableModels: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-probe within the 30s TTL after a failed connection test", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: false, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    await useAiStore.getState().ensureAiReachable();
    expect(useAiStore.getState().aiReachable).toBe(false);
    expect(probeCount()).toBe(1);

    // A mount inside the TTL (e.g. TitleBar remounting) must be a no-op — the whole point of D3
    // is that this never becomes a probe storm.
    await vi.advanceTimersByTimeAsync(THIRTY_S - 1000);
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(1);
  });

  it("re-probes once the 30s TTL has expired", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: false, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(2);
    // Same creds throughout — a stale-failure retry keeps aiReachable at false rather than
    // flashing back to null (only a genuine creds change hides the entry).
    expect(useAiStore.getState().aiReachable).toBe(false);
  });

  it("doubles the TTL on consecutive failures for the same creds, capped at 5 minutes", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: false, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    await useAiStore.getState().ensureAiReachable(); // failure #1 → next TTL 30s
    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    await useAiStore.getState().ensureAiReachable(); // failure #2 (30s TTL expired) → next TTL 60s
    expect(probeCount()).toBe(2);

    // Only 30s since failure #2 — the 60s backoff hasn't expired yet, must stay cached.
    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(2);

    // Another 30s (60s total since failure #2) — now it should re-probe.
    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(3);
  });

  it("resets the backoff to 30s after a success, instead of keeping a doubled interval", async () => {
    // A success caches forever (until creds change), so ensureAiReachable() itself can't re-probe
    // the same fingerprint after a success — only the user's manual "Test connection" button
    // (testConnection(), which always re-probes) can. That's the realistic path this exercises:
    // Ollama drops, recovers (manual retest succeeds), then drops again.
    const settingsResponse = Promise.resolve({
      settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
    });
    const mockConnection = (ok: boolean) => {
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return settingsResponse;
        if (cmd === "ai_test_connection") return Promise.resolve({ ok, latency_ms: 5, models: [] });
        return Promise.resolve({});
      });
    };

    mockConnection(false);
    await useAiStore.getState().ensureAiReachable(); // failure #1 → next TTL 30s
    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    await useAiStore.getState().ensureAiReachable(); // failure #2 (same creds) → next TTL 60s
    expect(probeCount()).toBe(2);

    // Ollama comes back — manual "Test connection" succeeds (same creds throughout).
    mockConnection(true);
    await useAiStore.getState().testConnection();
    expect(useAiStore.getState().aiReachable).toBe(true);
    expect(probeCount()).toBe(3);

    // It drops again immediately after — another manual retest, this time failing.
    mockConnection(false);
    await expect(useAiStore.getState().testConnection()).rejects.toThrow();
    expect(probeCount()).toBe(4);
    expect(useAiStore.getState().aiReachable).toBe(false);

    // Had the backoff kept doubling from before the success (would need 120s), this would still
    // be within TTL at 30s and stay cached. Since the success reset it to base, 30s is enough.
    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(5);
  });

  it("caps the backoff at 5 minutes", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: false, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    // Drive the backoff up past the cap: 30s, 60s, 120s, 240s, 300s(capped), 300s...
    for (let i = 0; i < 6; i++) {
      await useAiStore.getState().ensureAiReachable();
      await vi.advanceTimersByTimeAsync(FIVE_MIN + 1);
    }
    const before = probeCount();
    // One more cycle at exactly the cap must still re-probe (never stuck forever).
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(before + 1);
  });

  it("a focus/visibility revalidation is a no-op while the FAILED cache is still within its TTL", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: false, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    // Registers the module-level focus/visibility listener (lazy, once) as a side effect.
    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    // The listener kicks off ensureAiReachable() fire-and-forget; let any pending microtasks flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(probeCount()).toBe(1);
  });

  it("regaining focus after the TTL expired re-probes without waiting for a component to remount", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: false, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(THIRTY_S + 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probeCount()).toBe(2);
  });

  it("does not touch the connection test at all while AI is reachable (a success never triggers focus re-probing)", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: PLACEHOLDER_KEY, ai_model: "" },
        });
      }
      if (cmd === "ai_test_connection") return Promise.resolve({ ok: true, latency_ms: 5, models: [] });
      return Promise.resolve({});
    });

    await useAiStore.getState().ensureAiReachable();
    expect(probeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(FIVE_MIN + 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(probeCount()).toBe(1);
  });
});

describe("ai store — cleanupText / generateFromPrompt (AI dropdown: tidy + prompt box)", () => {
  beforeEach(() => {
    callMock.mockReset();
    _resetAiReachableCacheForTests();
    _resetAiRequestStateForTests();
    useAiStore.setState({
      translateGateOk: null,
      cleanupPending: false,
      promptPending: false,
    });
  });

  it("cleanupText: blocked by the shared privacy gate (cloud provider, ai_enabled=false) never calls ai_cleanup_text", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: false, ai_provider: "openai", ai_endpoint: "" },
    });
    const result = await useAiStore.getState().cleanupText("some note body");
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("ai_cleanup_text", expect.anything());
  });

  it("cleanupText: local ollama on loopback is allowed without ai_enabled and returns the cleaned text", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" },
        });
      }
      if (cmd === "ai_cleanup_text") return Promise.resolve({ cleaned: "tidy body" });
      return Promise.resolve({});
    });
    const result = await useAiStore.getState().cleanupText("messy body");
    expect(result).toBe("tidy body");
    expect(useAiStore.getState().cleanupPending).toBe(false);
  });

  it("cleanupText: empty/whitespace-only input short-circuits without calling the backend at all", async () => {
    const result = await useAiStore.getState().cleanupText("   ");
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("generateFromPrompt: blocked by the shared privacy gate never calls ai_generate_from_prompt", async () => {
    callMock.mockResolvedValue({
      settings: { ai_enabled: false, ai_provider: "claude", ai_endpoint: "" },
    });
    const result = await useAiStore.getState().generateFromPrompt("write a poem", null);
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("ai_generate_from_prompt", expect.anything());
  });

  it("generateFromPrompt: allowed once ai_enabled=true, passes prompt + context_text through", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "openai", ai_endpoint: "", ai_api_key: "sk-x", ai_model: "" },
        });
      }
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "a fresh script" });
      return Promise.resolve({});
    });
    const result = await useAiStore.getState().generateFromPrompt("make a script", "existing note text");
    expect(result).toBe("a fresh script");
    expect(callMock).toHaveBeenCalledWith(
      "ai_generate_from_prompt",
      expect.objectContaining({ prompt: "make a script", context_text: "existing note text" })
    );
  });

  // WB(2026-09-05) B1: opts.requestId — 결과 프리뷰 게이트가 이 값으로 ai_cancel_call을 정확히
  // 겨냥한다. 안 주면 커맨드 입력에서 그냥 빠진다(undefined는 toEqual류 비교에서 키 부재와 같다).
  it("generateFromPrompt: opts.requestId가 있으면 커맨드 입력의 request_id로 실린다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "openai", ai_endpoint: "", ai_api_key: "sk-x", ai_model: "" },
        });
      }
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "ok" });
      return Promise.resolve({});
    });
    await useAiStore.getState().generateFromPrompt("prompt", null, { requestId: "req-123" });
    expect(callMock).toHaveBeenCalledWith(
      "ai_generate_from_prompt",
      expect.objectContaining({ request_id: "req-123" })
    );
  });

  it("generateFromPrompt: opts 없이 부르면 request_id가 커맨드 입력에 없다(undefined)", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "openai", ai_endpoint: "", ai_api_key: "sk-x", ai_model: "" },
        });
      }
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "ok" });
      return Promise.resolve({});
    });
    await useAiStore.getState().generateFromPrompt("prompt", null);
    const [, args] = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect((args as { request_id?: string }).request_id).toBeUndefined();
  });

  it("generateFromPrompt: empty prompt short-circuits without calling the backend at all", async () => {
    const result = await useAiStore.getState().generateFromPrompt("   ", "some context");
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("generateFromPrompt keeps its spinner on until every concurrent request settles", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    let generateCalls = 0;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } });
      }
      if (cmd === "ai_generate_from_prompt") return generateCalls++ === 0 ? first : second;
      return Promise.resolve({});
    });
    useAiStore.setState({ translateGateOk: true });

    const older = useAiStore.getState().generateFromPrompt("first", null);
    const newer = useAiStore.getState().generateFromPrompt("second", null);
    await vi.waitFor(() => expect(generateCalls).toBe(2));
    expect(useAiStore.getState().promptPending).toBe(true);

    resolveFirst({ generated: "first result" });
    await older;
    expect(useAiStore.getState().promptPending).toBe(true);

    resolveSecond({ generated: "second result" });
    await newer;
    expect(useAiStore.getState().promptPending).toBe(false);
  });

  it("neither cleanupText nor generateFromPrompt ever calls a note/section write command", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: true, ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" },
        });
      }
      if (cmd === "ai_cleanup_text") return Promise.resolve({ cleaned: "x" });
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "y" });
      return Promise.resolve({});
    });
    await useAiStore.getState().cleanupText("body");
    await useAiStore.getState().generateFromPrompt("prompt", null);
    const calledCommands = callMock.mock.calls.map((c) => c[0]);
    expect(calledCommands).not.toEqual(expect.arrayContaining(["section_update", "section_create", "section_create_with_body", "note_update"]));
  });
});

describe("ai store — organizeCurrentNote propose / applyProposal / clearProposal (P0-2: propose must not commit, only Apply does)", () => {
  beforeEach(() => {
    callMock.mockReset();
    _resetAiRequestStateForTests();
    mockReloadActive.mockReset();
    mockSetSavedState.mockReset();
    mockLoadTree.mockReset();
    mockSelectNote.mockReset();
    showUndoToastMock.mockReset();
    mockActiveNote = { note: { id: "note-1" } };
    mockNoteIndex = new Map();
    mockFolders = [];
    lockedNoteIds = new Set();
    useAiStore.setState({
      organizePending: false,
      lastProposal: null,
      lastProposalNoteId: null,
      lastProposalOrigin: null,
      backgroundProposals: new Map(),
      manualProposals: new Map(),
    });
  });

  it("organizeCurrentNote stores whatever ai_organize_note (propose-only) returns, with no applied field to speak of", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } });
      }
      if (cmd === "ai_organize_note") {
        return Promise.resolve({ title: "New Title", year: 1900, tag_names: ["a", "b"], confidence: 0.9 });
      }
      return Promise.resolve({});
    });
    await useAiStore.getState().organizeCurrentNote();
    expect(useAiStore.getState().lastProposal).toEqual({ title: "New Title", year: 1900, tag_names: ["a", "b"], confidence: 0.9 });
    // organizeCurrentNote must never itself call ai_apply_organize — that only happens when the
    // user clicks Apply in the modal.
    expect(callMock).not.toHaveBeenCalledWith("ai_apply_organize", expect.anything());
  });

  it("opts.model overrides the settings-derived model; opts.origin passes through as-is (petCollectBridge.ts)", async () => {
    const organizeArgs: Record<string, unknown>[] = [];
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "default-model" },
        });
      }
      if (cmd === "ai_organize_note") {
        organizeArgs.push(args ?? {});
        return Promise.resolve({ title: "T", confidence: 0.9 });
      }
      return Promise.resolve({});
    });

    await useAiStore.getState().organizeCurrentNote("note-1", ["title"], undefined, false, {
      model: "override-model",
      origin: "collect_post_process",
    });

    expect(organizeArgs[0]).toMatchObject({ model: "override-model", origin: "collect_post_process" });
  });

  it("without opts, keeps prior behavior: model comes from settings, no origin key is sent", async () => {
    const organizeArgs: Record<string, unknown>[] = [];
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "default-model" },
        });
      }
      if (cmd === "ai_organize_note") {
        organizeArgs.push(args ?? {});
        return Promise.resolve({ title: "T", confidence: 0.9 });
      }
      return Promise.resolve({});
    });

    await useAiStore.getState().organizeCurrentNote("note-1");

    expect(organizeArgs[0]).toMatchObject({ model: "default-model" });
    expect(organizeArgs[0]).not.toHaveProperty("origin");
  });

  it("keeps the newest proposal and its pending state when same-note requests resolve out of order", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    let organizeCalls = 0;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } });
      }
      if (cmd === "ai_organize_note") return organizeCalls++ === 0 ? first : second;
      return Promise.resolve({});
    });

    const older = useAiStore.getState().organizeCurrentNote("note-1");
    const newer = useAiStore.getState().organizeCurrentNote("note-1");
    await vi.waitFor(() => expect(organizeCalls).toBe(2));
    expect(useAiStore.getState().organizePending).toBe(true);

    resolveSecond({ title: "new", confidence: 0.9 });
    await newer;
    expect(useAiStore.getState().lastProposal).toEqual({ title: "new", confidence: 0.9 });
    expect(useAiStore.getState().organizePending).toBe(true);

    resolveFirst({ title: "old", confidence: 0.1 });
    await older;
    expect(useAiStore.getState().lastProposal).toEqual({ title: "new", confidence: 0.9 });
    expect(useAiStore.getState().organizePending).toBe(false);
  });

  it("queues manual proposals for different notes and restores the next one after dismissing the current review", async () => {
    callMock.mockImplementation((cmd: string, args?: { id?: string }) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } });
      }
      if (cmd === "ai_organize_note") {
        return Promise.resolve({ title: `Proposal for ${args?.id}`, confidence: 0.9 });
      }
      return Promise.resolve({});
    });

    await useAiStore.getState().organizeCurrentNote("note-1");
    await useAiStore.getState().organizeCurrentNote("note-2");

    expect(useAiStore.getState().lastProposal).toEqual({ title: "Proposal for note-1", confidence: 0.9 });
    expect(useAiStore.getState().lastProposalNoteId).toBe("note-1");
    expect(useAiStore.getState().manualProposals.get("note-2")).toEqual({ title: "Proposal for note-2", confidence: 0.9 });

    useAiStore.getState().clearProposal();

    expect(useAiStore.getState().lastProposal).toEqual({ title: "Proposal for note-2", confidence: 0.9 });
    expect(useAiStore.getState().lastProposalNoteId).toBe("note-2");
    expect(useAiStore.getState().lastProposalOrigin).toBe("manual");
  });

  it("applyProposal invokes ai_apply_organize with the proposal's id/title/year/tag_names, then reloads the note", async () => {
    useAiStore.setState({
      lastProposal: { title: "New Title", year: 1900, tag_names: ["a", "b"], confidence: 0.9 },
    });
    callMock.mockResolvedValue({ applied: ["title", "year", "tags"] });

    await useAiStore.getState().applyProposal();

    expect(callMock).toHaveBeenCalledWith("ai_apply_organize", {
      id: "note-1",
      title: "New Title",
      year: 1900,
      tag_names: ["a", "b"],
    });
    expect(mockReloadActive).toHaveBeenCalledTimes(1);
    // loadTree() is the shared invalidation chokepoint (see stores/notes.ts) — every other note
    // mutation (rename, tag/status/region edits, batch AI apply in AiBatchOrganizeModal.tsx)
    // already calls it so the tree row and expanded filter views (Tags/Status/Timeline/...)
    // pick up the change. Applying a single-note AI proposal writes the same fields and must too.
    expect(mockLoadTree).toHaveBeenCalledTimes(1);
    expect(mockSetSavedState).toHaveBeenCalledWith("ai_organized");
    expect(useAiStore.getState().lastProposal).toBeNull();
    // Title/year/tags only — no folder move, so no "you can't find your note" undo toast (§1.5/W6).
    expect(showUndoToastMock).not.toHaveBeenCalled();
  });

  // F-N09 확장: organizeCurrentNote(제안 만들기)는 "답하는 것"이라 막지 않지만, applyProposal이
  // 실제로 ai_apply_organize를 불러 title/year/tags/... 를 써넣는 지점이라 여기서 막는다 —
  // insertAiSection과 같은 원칙(docs/AI.md L1). ai_apply_organize는 patchActiveNote를 거치지
  // 않으므로 이 가드가 없으면 F-N09의 메타데이터 잠금을 완전히 우회한다.
  it("applyProposal은 잠긴 노트에는 ai_apply_organize를 부르지 않고 잠금 안내를 띄운다", async () => {
    lockedNoteIds.add("note-1");
    useAiStore.setState({
      lastProposal: { title: "New Title", year: 1900, tag_names: ["a", "b"], confidence: 0.9 },
    });

    await useAiStore.getState().applyProposal();

    expect(callMock).not.toHaveBeenCalledWith("ai_apply_organize", expect.anything());
    expect(mockReloadActive).not.toHaveBeenCalled();
    expect(mockLoadTree).not.toHaveBeenCalled();
    // 이 파일은 i18n을 identity mock으로 두므로(위 vi.mock("../i18n/t")) 렌더된 문구가 아니라
    // 키 문자열을 그대로 확인한다.
    const { emitNotice } = await import("../lib/invoke");
    expect(emitNotice).toHaveBeenCalledWith("editor.content_locked_tooltip");
  });

  describe("applyProposal revert-everything undo toast (§1.5/W6 + A2, PLAN-2026-09-05 §1 A-2 — one toast for the whole apply, not just the folder move)", () => {
    it("shows one undo toast covering every changed field, and Undo reverts all of it via a single ai_apply_organize call", async () => {
      mockNoteIndex.set("note-1", { folder_id: "folder-old", title: "My Note", year: 1990, tag_names: ["old"] });
      useAiStore.setState({
        lastProposal: {
          title: "New Title",
          year: 2000,
          tag_names: ["new"],
          confidence: 0.9,
          folder_id: "folder-new",
          folder_name: "New Folder",
        } as any,
      });
      // WF F2: the revert closure re-fetches the note via note_get right before reverting, and
      // only proceeds if it still matches what THIS apply wrote — here it does (no interim edit).
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "note_get") {
          return Promise.resolve({ note: { folder_id: "folder-new", title: "New Title", year: 2000, tag_names: ["new"] } });
        }
        return Promise.resolve({ applied: ["title", "year", "tags", "folder"] });
      });

      await useAiStore.getState().applyProposal();

      expect(showUndoToastMock).toHaveBeenCalledTimes(1);
      // No unrevertable fields in this scenario → the plain (non-partial) label. Third arg is the
      // WF F2 15s delayMs option (module default stays 5s for every other showUndoToast caller).
      expect(showUndoToastMock).toHaveBeenCalledWith(
        "undo.metadata_applied",
        expect.any(Function),
        expect.objectContaining({ delayMs: 15000 }),
      );

      // Undo = ONE ai_apply_organize call back to the values captured BEFORE the apply — folder
      // included, folding the old folder-only toast into this general revert.
      callMock.mockClear();
      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      onUndo();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(callMock).toHaveBeenCalledWith("ai_apply_organize", {
        id: "note-1",
        title: "My Note",
        year: 1990,
        folder_id: "folder-old",
        tag_names: ["old"],
      });
    });

    it("F2: skips the revert (and notifies) when the note was edited after the apply, inside the undo window", async () => {
      mockNoteIndex.set("note-1", { folder_id: "folder-old", title: "My Note", year: 1990, tag_names: ["old"] });
      useAiStore.setState({
        lastProposal: { title: "New Title", year: 2000, tag_names: ["new"], confidence: 0.9 } as any,
      });
      // note_get reflects a note the user has since retitled by hand — no longer "New Title".
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "note_get") {
          return Promise.resolve({ note: { folder_id: "folder-old", title: "User Edited Title", year: 2000, tag_names: ["new"] } });
        }
        return Promise.resolve({ applied: ["title", "year", "tags"] });
      });

      await useAiStore.getState().applyProposal();
      expect(showUndoToastMock).toHaveBeenCalledTimes(1);

      callMock.mockClear();
      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      onUndo();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(callMock).toHaveBeenCalledWith("note_get", { id: "note-1" });
      expect(callMock).not.toHaveBeenCalledWith("ai_apply_organize", expect.anything());
    });

    it("still shows an undo toast when only title/tags changed (no folder move) — A2 generalizes beyond folder-only", async () => {
      mockNoteIndex.set("note-1", { folder_id: "folder-old", title: "My Note", tag_names: ["old"] });
      useAiStore.setState({
        lastProposal: { title: "New Title", tag_names: ["new"], confidence: 0.9 } as any,
      });
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "note_get") {
          return Promise.resolve({ note: { folder_id: "folder-old", title: "New Title", tag_names: ["new"] } });
        }
        return Promise.resolve({ applied: ["title", "tags"] });
      });

      await useAiStore.getState().applyProposal();

      expect(showUndoToastMock).toHaveBeenCalledTimes(1);
      callMock.mockClear();
      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      onUndo();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // No folder_id in the revert payload — the proposal never touched the folder.
      expect(callMock).toHaveBeenCalledWith("ai_apply_organize", {
        id: "note-1",
        title: "My Note",
        tag_names: ["old"],
      });
    });

    it("does not show an undo toast when the note's pre-apply values are unknown (can't offer a safe revert)", async () => {
      // noteIndex has no entry for note-1 — currentBeforeApply is undefined, so revert is skipped
      // entirely rather than guessing with an all-empty fallback (a bogus folder_id: "" would fail
      // ai_apply_organize's own folder lookup).
      useAiStore.setState({
        lastProposal: {
          title: "New Title",
          confidence: 0.9,
          folder_id: "folder-new",
          folder_name: "New Folder",
        } as any,
      });
      callMock.mockResolvedValue({ applied: ["title", "folder"] });

      await useAiStore.getState().applyProposal();

      expect(showUndoToastMock).not.toHaveBeenCalled();
    });

    it("does not show an undo toast when the proposal changed nothing relative to current (diffs empty)", async () => {
      mockNoteIndex.set("note-1", { folder_id: "folder-old", title: "Same Title", tag_names: ["same"] });
      useAiStore.setState({
        lastProposal: { title: "Same Title", tag_names: ["same"], confidence: 0.9 } as any,
      });
      callMock.mockResolvedValue({ applied: [] });

      await useAiStore.getState().applyProposal();

      expect(showUndoToastMock).not.toHaveBeenCalled();
    });

    it("J3: location filled from empty now reverts via clear_fields (full undo, no partial label)", async () => {
      mockNoteIndex.set("note-1", { folder_id: "folder-old", title: "My Note", tag_names: [], lat: null, lng: null });
      useAiStore.setState({
        lastProposal: { title: "New Title", lat: 37.5, lng: 127.0, confidence: 0.9 } as any,
      });
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "note_get") {
          return Promise.resolve({ note: { folder_id: "folder-old", title: "New Title", tag_names: [], lat: 37.5, lng: 127.0 } });
        }
        return Promise.resolve({ applied: ["title", "location"] });
      });

      await useAiStore.getState().applyProposal();

      expect(showUndoToastMock).toHaveBeenCalledTimes(1);
      expect(showUndoToastMock).toHaveBeenCalledWith(
        "undo.metadata_applied",
        expect.any(Function),
        expect.objectContaining({ delayMs: 15000 }),
      );

      callMock.mockClear();
      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      onUndo();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // title reverts by value; location (fill state) reverts via clear_fields — lat/lng values
      // can't express "erase", only clear_fields can (J3, commands/ai.rs CLEARABLE_FIELDS).
      const revertCall = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize");
      expect(revertCall![1]).toEqual({ id: "note-1", title: "My Note", clear_fields: ["location"] });
    });

    it("J3: source_urls now reverts via remove_source_urls (full undo, no partial label)", async () => {
      mockNoteIndex.set("note-1", { folder_id: "folder-old", title: "My Note", tag_names: [] });
      useAiStore.setState({
        lastProposal: { title: "New Title", source_urls: ["https://example.com"], confidence: 0.9 } as any,
      });
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "note_get") {
          return Promise.resolve({ note: { folder_id: "folder-old", title: "New Title", tag_names: [] } });
        }
        return Promise.resolve({ applied: ["title", "attachments"] });
      });

      await useAiStore.getState().applyProposal();

      expect(showUndoToastMock).toHaveBeenCalledWith(
        "undo.metadata_applied",
        expect.any(Function),
        expect.objectContaining({ delayMs: 15000 }),
      );
      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      callMock.mockClear();
      onUndo();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const revertCall = callMock.mock.calls.find((c) => c[0] === "ai_apply_organize");
      expect(revertCall![1]).toEqual({ id: "note-1", title: "My Note", remove_source_urls: ["https://example.com"] });
    });
  });

  it("bug fix: organizing a note that ISN'T the active one still applies to THAT note, not whatever is active at Apply-click time (Ask-AI modal on a tree/tab row)", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_provider: "ollama", ai_endpoint: "", ai_api_key: "", ai_model: "" } });
      }
      if (cmd === "ai_organize_note") {
        return Promise.resolve({ title: "Note B Title", year: 1800, tag_names: ["b"], confidence: 0.8 });
      }
      return Promise.resolve({ applied: ["title"] });
    });

    // note-1 stays active throughout — organizeCurrentNote targets a DIFFERENT note (note-2).
    await useAiStore.getState().organizeCurrentNote("note-2");
    expect(useAiStore.getState().lastProposal).toEqual({ title: "Note B Title", year: 1800, tag_names: ["b"], confidence: 0.8 });

    // The active note could change (or stay the same) between propose and the user clicking
    // Apply — either way, Apply must still target note-2, the note the proposal was FOR.
    await useAiStore.getState().applyProposal();

    expect(callMock).toHaveBeenCalledWith(
      "ai_apply_organize",
      expect.objectContaining({ id: "note-2", title: "Note B Title" }),
    );
    expect(callMock).not.toHaveBeenCalledWith("ai_apply_organize", expect.objectContaining({ id: "note-1" }));
    // TitleBar badge is for the open editor only — background organize must not paint ai_organized
    // onto note-1 while note-2 was the actual target.
    expect(mockSetSavedState).not.toHaveBeenCalled();
    expect(mockReloadActive).not.toHaveBeenCalled();
  });

  it("applyProposal leaves the proposal in place (does not reload) when ai_apply_organize fails", async () => {
    useAiStore.setState({
      lastProposal: { title: "New Title", year: 1900, tag_names: ["a"], confidence: 0.9 },
    });
    callMock.mockRejectedValue(new Error("year out of range"));

    await useAiStore.getState().applyProposal();

    expect(mockReloadActive).not.toHaveBeenCalled();
    expect(mockLoadTree).not.toHaveBeenCalled();
    expect(mockSetSavedState).not.toHaveBeenCalled();
    expect(useAiStore.getState().lastProposal).not.toBeNull();
  });

  it("clearProposal (Cancel) discards the proposal without calling any backend command — propose never committed, so there is nothing to roll back", () => {
    useAiStore.setState({
      lastProposal: { title: "New Title", year: 1900, tag_names: ["a"], confidence: 0.9 },
    });
    useAiStore.getState().clearProposal();
    expect(useAiStore.getState().lastProposal).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
    expect(mockReloadActive).not.toHaveBeenCalled();
  });
});

describe("Wave AISTATE: availability selector, hints, and remembered probe success", () => {
  beforeEach(() => {
    callMock.mockReset();
    _resetAiReachableCacheForTests();
    useAiStore.setState({
      aiReachable: null,
      aiReachableError: null,
      aiReachableChecking: false,
    });
  });

  it("selectAiAvailability truth table", () => {
    expect(selectAiAvailability({ aiEnabled: false }, { aiReachable: true })).toBe("off");
    expect(selectAiAvailability({ aiEnabled: false }, { aiReachable: null })).toBe("off");
    expect(selectAiAvailability({ aiEnabled: false }, { aiReachable: false })).toBe("off");

    expect(selectAiAvailability({ aiEnabled: true }, { aiReachable: true })).toBe("ready");
    expect(selectAiAvailability({ aiEnabled: true }, { aiReachable: false })).toBe("unreachable");
    expect(selectAiAvailability({ aiEnabled: true }, { aiReachable: null })).toBe("checking");
    expect(selectAiAvailability({ aiEnabled: true }, { aiReachable: null, aiReachableChecking: true })).toBe("checking");
  });

  it("getAiDisabledHint returns appropriate hint per availability", () => {
    expect(getAiDisabledHint("off", "editor")).toBe("editor.ai_disabled_hint");
    expect(getAiDisabledHint("checking", "editor")).toBe("editor.ai_checking");
    expect(getAiDisabledHint("unreachable", "editor")).toBe("editor.ai_unreachable");

    expect(getAiDisabledHint("checking", "mobile")).toBe("mobile.ai_checking");
    expect(getAiDisabledHint("unreachable", "mobile")).toBe("mobile.ai_unreachable");

    expect(getAiDisabledHint("checking", "presets")).toBe("presets.ai_checking");
    expect(getAiDisabledHint("unreachable", "presets")).toBe("presets.ai_unreachable");
  });

  it("safeConnError extracts message from string, Error, and object with code/message", () => {
    expect(safeConnError(new Error("standard error"))).toBe("standard error");
    expect(safeConnError("string error")).toBe("string error");
    expect(safeConnError({ code: "AI_DOWN", message: "detail error message" })).toBe("detail error message");
    expect(safeConnError({ code: "AI_DOWN" })).toBe("AI_DOWN");
    expect(safeConnError(null)).toBe("");
  });

  it("fingerprint match starts in ready without waiting; later failure moves to unreachable", async () => {
    const creds = {
      provider: "ollama",
      endpoint: "http://localhost:11434",
      api_key: "",
      model: "llama3",
    };
    const fp = computeAiCredsFingerprint(creds);
    saveAiLastSuccess(fp);

    let resolveProbe: (v: unknown) => void = () => {};
    const probePromise = new Promise((r) => {
      resolveProbe = r;
    });

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: creds.provider,
            ai_endpoint: creds.endpoint,
            ai_api_key: creds.api_key,
            ai_model: creds.model,
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return probePromise;
      }
      return Promise.resolve({});
    });

    // Start probe
    const ensurePromise = useAiStore.getState().ensureAiReachable();
    await Promise.resolve(); // allow settings_get_all to resolve

    // Since fingerprint matched remembered success, reachability is immediately true (ready) while checking
    expect(useAiStore.getState().aiReachable).toBe(true);
    expect(useAiStore.getState().aiReachableChecking).toBe(true);
    expect(selectAiAvailability({ aiEnabled: true }, useAiStore.getState())).toBe("ready");

    // Later failure occurs
    resolveProbe({ ok: false, latency_ms: 10, models: [] });
    await ensurePromise;

    // Moves to unreachable
    expect(useAiStore.getState().aiReachable).toBe(false);
    expect(useAiStore.getState().aiReachableChecking).toBe(false);
    expect(selectAiAvailability({ aiEnabled: true }, useAiStore.getState())).toBe("unreachable");
    expect(getAiDisabledHint(selectAiAvailability({ aiEnabled: true }, useAiStore.getState()), "editor")).toBe("editor.ai_unreachable");
  });

  it("fingerprint mismatch (first run / key changed) starts in checking", async () => {
    let resolveProbe: (v: unknown) => void = () => {};
    const probePromise = new Promise((r) => {
      resolveProbe = r;
    });

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: true,
            ai_provider: "gemini",
            ai_endpoint: "",
            ai_api_key: "brand_new_key",
            ai_model: "",
          },
        });
      }
      if (cmd === "ai_test_connection") {
        return probePromise;
      }
      return Promise.resolve({});
    });

    const ensurePromise = useAiStore.getState().ensureAiReachable();
    await Promise.resolve(); // allow settings_get_all to resolve

    // No remembered success: starts in checking (null)
    expect(useAiStore.getState().aiReachable).toBeNull();
    expect(useAiStore.getState().aiReachableChecking).toBe(true);
    expect(selectAiAvailability({ aiEnabled: true }, useAiStore.getState())).toBe("checking");
    expect(getAiDisabledHint(selectAiAvailability({ aiEnabled: true }, useAiStore.getState()), "editor")).toBe("editor.ai_checking");

    // Successful completion
    resolveProbe({ ok: true, latency_ms: 100, models: ["gemini-pro"] });
    await ensurePromise;

    expect(useAiStore.getState().aiReachable).toBe(true);
    expect(selectAiAvailability({ aiEnabled: true }, useAiStore.getState())).toBe("ready");
  });
});

describe("sha256Sync (AI 지문)", () => {
  it("node:crypto 의 SHA-256 과 모든 블록 경계·UTF-8 입력에서 같다", async () => {
    const { createHash } = await import("node:crypto");
    const { sha256Sync } = await import("./ai");
    const inputs = [
      ...Array.from({ length: 140 }, (_, n) => "a".repeat(n)),
      "gemini\0https://generativelanguage.googleapis.com\0AIzaSyDUMMY_key_1234567890\0gemini-3.1-flash-lite",
      "한글 키\0x".repeat(40),
    ];
    for (const s of inputs) {
      expect(sha256Sync(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});
