import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useAiStore,
  AI_GLOW_KEYS,
  useAiGlow,
  AI_GLOW_MIN_VISIBLE_MS,
  AI_GLOW_FADE_MS,
  _resetAiGlowForTests,
} from "./ai";
import { renderHook, act } from "@testing-library/react";

describe("aiGlow store & helper hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetAiGlowForTests();
    useAiStore.setState({ aiGlowTargets: new Map() });
  });

  afterEach(() => {
    _resetAiGlowForTests();
    vi.useRealTimers();
  });

  it("exports exact AI_GLOW_KEYS format", () => {
    expect(AI_GLOW_KEYS.note("n1")).toBe("note:n1");
    expect(AI_GLOW_KEYS.tags("n1")).toBe("tags:n1");
    expect(AI_GLOW_KEYS.editor("n1")).toBe("editor:n1");
    expect(AI_GLOW_KEYS.section("s1")).toBe("section:s1");
    expect(AI_GLOW_KEYS.diagram("s1")).toBe("diagram:s1");
    expect(AI_GLOW_KEYS.translate).toBe("translate");
    expect(AI_GLOW_KEYS.folder("f1")).toBe("folder:f1");
    expect(AI_GLOW_KEYS.workspace("w1")).toBe("workspace:w1");
    expect(AI_GLOW_KEYS.action("p1")).toBe("action:p1");
  });

  // DOM placement contract (TitleBar / TagEditor / RegionMetaBadge):
  // - AI_GLOW_KEYS.tags → each titlebar-tag-chip (not titlebar-tag-strip)
  // - AI_GLOW_KEYS.note → each meta badge/shell (not titlebar-meta-fixed)
  // Asserted in TitleBar.meta.test.tsx + RegionMetaBadge.test.tsx.

  it("subscribes correctly to glow keys via useAiGlow", () => {
    const { result } = renderHook(() => useAiGlow(AI_GLOW_KEYS.note("note-123")));
    expect(result.current).toBe(false);

    act(() => {
      useAiStore.getState().addGlow(AI_GLOW_KEYS.note("note-123"));
    });
    expect(result.current).toBe("active");

    act(() => {
      useAiStore.getState().removeGlow(AI_GLOW_KEYS.note("note-123"));
    });
    // Min-visible holds active; not deleted immediately.
    expect(result.current).toBe("active");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS);
    });
    expect(result.current).toBe("fading");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_FADE_MS);
    });
    expect(result.current).toBe(false);
  });

  it("handles multiple glow targets independently", () => {
    const noteHook = renderHook(() => useAiGlow(AI_GLOW_KEYS.note("n1")));
    const tagsHook = renderHook(() => useAiGlow(AI_GLOW_KEYS.tags("n1")));

    act(() => {
      useAiStore.getState().addGlow(AI_GLOW_KEYS.tags("n1"));
    });

    expect(noteHook.result.current).toBe(false);
    expect(tagsHook.result.current).toBe("active");

    act(() => {
      useAiStore.getState().removeGlow(AI_GLOW_KEYS.tags("n1"));
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS + AI_GLOW_FADE_MS);
    });

    expect(tagsHook.result.current).toBe(false);
  });

  it("immediate response (0ms): stays active for MIN_VISIBLE then fading then delete", () => {
    const key = AI_GLOW_KEYS.note("fast");
    const aiStore = useAiStore.getState();

    act(() => {
      aiStore.addGlow(key);
      // Simulate instant AI completion.
      aiStore.removeGlow(key);
    });

    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS - 1);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("fading");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_FADE_MS - 1);
    });
    expect(useAiStore.getState().aiGlowTargets.has(key)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useAiStore.getState().aiGlowTargets.has(key)).toBe(false);
  });

  it("failure/throw path still cleans up after min visible + fade", () => {
    const key = AI_GLOW_KEYS.note("n2");
    const aiStore = useAiStore.getState();

    act(() => {
      aiStore.addGlow(key);
      try {
        throw new Error("Simulated AI Failure");
      } catch {
        // Ignored
      } finally {
        aiStore.removeGlow(key);
      }
    });

    // Still present (min-visible hold) — not a hard delete.
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("fading");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_FADE_MS);
    });
    expect(useAiStore.getState().aiGlowTargets.has(key)).toBe(false);
  });

  it("re-request cancels pending fade timer and returns to active", () => {
    const key = AI_GLOW_KEYS.action("preset-1");
    const aiStore = useAiStore.getState();

    act(() => {
      aiStore.addGlow(key);
      aiStore.removeGlow(key);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS / 2);
      // Second request while first is waiting to fade — cancels timer, resets add time.
      aiStore.addGlow(key);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    // Past the original remove's min-visible deadline — must still be active (timer cancelled).
    act(() => {
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS / 2 + 1);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    // Reset clock with another add, then remove immediately for a full min-visible hold.
    act(() => {
      aiStore.addGlow(key);
      aiStore.removeGlow(key);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS - 1);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("fading");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_FADE_MS);
    });
    expect(useAiStore.getState().aiGlowTargets.has(key)).toBe(false);
  });

  it("re-add during fading cancels delete and restores active", () => {
    const key = AI_GLOW_KEYS.editor("e1");
    const aiStore = useAiStore.getState();

    act(() => {
      aiStore.addGlow(key);
      aiStore.removeGlow(key);
      vi.advanceTimersByTime(AI_GLOW_MIN_VISIBLE_MS);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("fading");

    act(() => {
      aiStore.addGlow(key);
    });
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");

    act(() => {
      vi.advanceTimersByTime(AI_GLOW_FADE_MS + 50);
    });
    // Delete timer cancelled — still active.
    expect(useAiStore.getState().aiGlowTargets.get(key)).toBe("active");
  });
});
