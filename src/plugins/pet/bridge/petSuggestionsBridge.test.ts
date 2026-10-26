import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

// listen()/emit() mocks — listen captures registered handlers by event name so tests can fire
// them directly (same shape remoteNoteWrite.test.ts already relies on).
const listenMock = vi.fn();
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

import { listenPetSuggestionsBridge } from "./petSuggestionsBridge";

describe("listenPetSuggestionsBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callMock.mockReset();
    listenMock.mockReset();
    emitMock.mockReset();
    emitMock.mockResolvedValue(undefined);
    listenMock.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls suggestions_list immediately, keeps both kinds, and broadcasts oldest-first", async () => {
    callMock.mockResolvedValueOnce({
      // suggestions_list returns created_at DESC (newest first) — s2 (link, newer) before s1
      // (overlap, older).
      suggestions: [
        { id: "s2", kind: "link", note_id: "n3", note_title: "C", related_note_id: "n4", related_note_title: "D", payload: "{}", score: 0.5, created_at: "2026-08-08T02:00:00.000Z" },
        { id: "s1", kind: "overlap", note_id: "n1", note_title: "A", related_note_id: "n2", related_note_title: "B", payload: "{}", score: 0.9, created_at: "2026-08-08T01:00:00.000Z" },
      ],
    });

    const cleanup = listenPetSuggestionsBridge();
    await Promise.resolve();
    await Promise.resolve();

    expect(callMock).toHaveBeenCalledWith("suggestions_list", { status: "pending" });
    // Both kinds survive (no kind filter — PetChat.tsx branches on kind itself), reordered
    // oldest-first so PetBubbleApp's "show suggestions[0]" picks up the older one first.
    expect(emitMock).toHaveBeenCalledWith("pet-suggestions-pending", {
      suggestions: [
        expect.objectContaining({ id: "s1", kind: "overlap" }),
        expect.objectContaining({ id: "s2", kind: "link" }),
      ],
    });
    cleanup();
  });

  it("re-polls every 60s and stops once cleanup runs", async () => {
    callMock.mockResolvedValue({ suggestions: [] });
    const cleanup = listenPetSuggestionsBridge();
    await Promise.resolve();
    await Promise.resolve();
    expect(callMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(callMock).toHaveBeenCalledTimes(2);

    cleanup();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(callMock).toHaveBeenCalledTimes(2); // no further polls after cleanup
  });

  it("unregisters both listeners on cleanup", async () => {
    const unlistenRefresh = vi.fn();
    const unlistenDismiss = vi.fn();
    listenMock.mockImplementation((name: string) =>
      Promise.resolve(name === "pet-suggestions-refresh" ? unlistenRefresh : unlistenDismiss),
    );
    callMock.mockResolvedValue({ suggestions: [] });

    const cleanup = listenPetSuggestionsBridge();
    await Promise.resolve();
    await Promise.resolve();
    cleanup();
    expect(unlistenRefresh).toHaveBeenCalledTimes(1);
    expect(unlistenDismiss).toHaveBeenCalledTimes(1);
  });

  it("a 'pet-suggestions-refresh' event triggers an immediate extra poll", async () => {
    callMock.mockResolvedValue({ suggestions: [] });
    let refreshHandler: (() => void) | undefined;
    listenMock.mockImplementation((name: string, handler: () => void) => {
      if (name === "pet-suggestions-refresh") refreshHandler = handler;
      return Promise.resolve(vi.fn());
    });

    const cleanup = listenPetSuggestionsBridge();
    await Promise.resolve();
    await Promise.resolve();
    expect(callMock).toHaveBeenCalledTimes(1);

    refreshHandler?.();
    await Promise.resolve();
    expect(callMock).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("a 'pet-suggestion-dismiss' event sets status=dismissed then re-polls", async () => {
    callMock.mockResolvedValue({ suggestions: [] });
    let dismissHandler: ((e: { payload: { id: string } }) => void) | undefined;
    listenMock.mockImplementation((name: string, handler: (e: { payload: { id: string } }) => void) => {
      if (name === "pet-suggestion-dismiss") dismissHandler = handler;
      return Promise.resolve(vi.fn());
    });

    const cleanup = listenPetSuggestionsBridge();
    await Promise.resolve();
    await Promise.resolve();
    callMock.mockClear();

    dismissHandler?.({ payload: { id: "s1" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(callMock).toHaveBeenCalledWith("suggestion_set_status", { id: "s1", status: "dismissed" });
    expect(callMock).toHaveBeenCalledWith("suggestions_list", { status: "pending" });
    cleanup();
  });
});
