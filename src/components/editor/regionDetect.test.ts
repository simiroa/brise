import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { matchRegionCandidates, useRegionDetect } from "./regionDetect";
import { getActiveEditor } from "../../lib/aiSectionBridge";
import { loadRegionRegistry } from "../../lib/regionRegistry";
import { useNoteWaypoints } from "../home/useNoteWaypoints";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { useRegionNudgeStore } from "../../stores/regionNudge";

vi.mock("../../lib/aiSectionBridge", () => ({
  getActiveEditor: vi.fn(),
}));
vi.mock("../../lib/regionRegistry", () => ({
  loadRegionRegistry: vi.fn(),
}));
vi.mock("../home/useNoteWaypoints", () => ({
  useNoteWaypoints: vi.fn(),
}));

// ── D12 pure matcher — no React/store/editor machinery needed ──────────────────────────────────
describe("matchRegionCandidates / boundary matching (D12)", () => {
  const registry = [
    { name: "경주", lat: 35.8562, lng: 129.2247 },
    { name: "부산", lat: 35.1796, lng: 129.0756 },
  ];

  it("matches a standalone registered name (space-bounded) in strict mode", () => {
    const out = matchRegionCandidates("이번 여행지는 경주 였다", registry, "strict");
    expect(out.map((e) => e.name)).toEqual(["경주"]);
  });

  it("strict mode does NOT match inside a longer Hangul word (경주마)", () => {
    const out = matchRegionCandidates("경주마를 타고 여행했다", registry, "strict");
    expect(out).toEqual([]);
  });

  it("strict mode does NOT match with a preceding AND following Hangul syllable (불경주의보)", () => {
    const out = matchRegionCandidates("불경주의보가 떴다", registry, "strict");
    expect(out).toEqual([]);
  });

  it("loose mode matches the same text strict mode rejects (plain substring)", () => {
    expect(matchRegionCandidates("경주마를 타고 여행했다", registry, "loose")).toHaveLength(1);
    expect(matchRegionCandidates("불경주의보가 떴다", registry, "loose")).toHaveLength(1);
  });

  it("scans every occurrence — a rejected match inside a word doesn't hide a later standalone match", () => {
    const out = matchRegionCandidates("경주마에 갔다가 경주 구경도 했다", registry, "strict");
    expect(out.map((e) => e.name)).toEqual(["경주"]);
  });

  it("strict mode does not match a name carrying a Korean postposition (경주에/경주로/경주의) — documented recall limit, not a bug", () => {
    // 에(U+C5D0)/로(U+B85C)/의(U+C758) are Hangul syllables, so they count as continuation
    // characters like any other — Korean's agglutinative particles mean strict mode only fires
    // reliably at punctuation/space/text-boundary, matching the owner's "정밀도 우선" decision
    // (D12) at the cost of recall on plain prose. The loose escape hatch exists for exactly this.
    expect(matchRegionCandidates("경주에 다녀왔다", registry, "strict")).toEqual([]);
    expect(matchRegionCandidates("경주로 가는 길", registry, "strict")).toEqual([]);
    expect(matchRegionCandidates("경주의 유적지", registry, "strict")).toEqual([]);
    expect(matchRegionCandidates("경주에 다녀왔다", registry, "loose")).toHaveLength(1);
  });

  it("matches at the very start and very end of the scanned text (no neighbor to check)", () => {
    expect(matchRegionCandidates("경주 여행 다녀옴", registry, "strict").map((e) => e.name)).toEqual(["경주"]);
    expect(matchRegionCandidates("다녀온 곳: 부산", registry, "strict").map((e) => e.name)).toEqual(["부산"]);
  });

  it("is case-insensitive and trims registry names before matching", () => {
    const out = matchRegionCandidates("we went to paris last year", [{ name: " Paris ", lat: 1, lng: 1 }], "strict");
    expect(out).toHaveLength(1);
  });

  it("rejects a Latin name inside a longer word via a combining-mark boundary (Nice vs Nicée)", () => {
    // \p{L} covers accented Latin letters (é), so "Nice" inside "Nicée" must NOT count as a
    // strict-mode boundary match — a plain [A-Za-z] boundary check would incorrectly accept it.
    const niceRegistry = [{ name: "Nice", lat: 43.7, lng: 7.27 }];
    expect(matchRegionCandidates("on a visité Nicée", niceRegistry, "strict")).toEqual([]);
    expect(matchRegionCandidates("on a visité Nice, en France", niceRegistry, "strict")).toHaveLength(1);
  });

  // 2026-09-19 버그 수정(§P3 Phase A 적대적 검증에서 발견) — haystack[idx-1] 같은 UTF-16 코드
  // 유닛 직접 인덱싱은 BMP 밖 문자(서로게이트 쌍, 2유닛)의 절반만 집어 "연속 문자 아님"으로
  // 오판했다. \u{20000}(한자 확장 B 영역의 실재 글자)을 "경주" 바로 앞/뒤에 붙이면 strict
  // 모드가 거짓 양성을 냈다 — 실제로는 글자가 바로 붙어 있는데 경계로 오판.
  it("strict mode correctly rejects a match glued to a non-BMP (surrogate-pair) Unicode letter", () => {
    const astralLetter = "\u{20000}"; // CJK Unified Ideographs Extension B — a real \p{L} letter
    expect(matchRegionCandidates(`${astralLetter}경주`, registry, "strict")).toEqual([]);
    expect(matchRegionCandidates(`경주${astralLetter}`, registry, "strict")).toEqual([]);
    // Sanity: a non-BMP character that is NOT a letter (an emoji, category So) must not block
    // the boundary — only \p{L}/\p{N}/\p{M} should count as a continuation character.
    const astralEmoji = "\u{1F600}";
    expect(matchRegionCandidates(`경주${astralEmoji}`, registry, "strict").map((e) => e.name)).toEqual(["경주"]);
  });

  it("skips a registry entry whose trimmed name is empty (whitespace-only name)", () => {
    const out = matchRegionCandidates("아무 텍스트나", [{ name: "   ", lat: 0, lng: 0 }], "loose");
    expect(out).toEqual([]);
  });

  it("returns [] for blank text or an empty registry without matching everything", () => {
    expect(matchRegionCandidates("   ", registry, "loose")).toEqual([]);
    expect(matchRegionCandidates("경주 이야기", [], "loose")).toEqual([]);
  });
});

// ── useRegionDetect hook (D5/D6/D9/D10) ─────────────────────────────────────────────────────────
function makeFakeEditor(text: string) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    isDestroyed: false,
    state: {
      doc: {
        content: { size: text.length },
        textBetween: () => text,
      },
    },
    on(event: string, cb: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    off(event: string, cb: () => void) {
      listeners.get(event)?.delete(cb);
    },
    fire(event: string) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
}

describe("useRegionDetect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useNotesStore.setState({ activeNote: null } as never);
    useSettingsStore.setState({ regionNudgeStrict: true, regionNudgeEnabled: true } as never);
    useRegionNudgeStore.setState({ noteId: null, candidates: [], dismissedNames: new Set() });
    vi.mocked(useNoteWaypoints).mockReturnValue([]);
    vi.mocked(loadRegionRegistry).mockResolvedValue([
      { name: "경주", lat: 35.8562, lng: 129.2247 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scans immediately on mount (no doc-change event needed) — covers setContent({emitUpdate:false}) note loads", async () => {
    const editor = makeFakeEditor("여기는 경주 여행기");
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);

    renderHook(() => useRegionDetect("note-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);
  });

  it("D9: excludes a candidate that matches the note's own primary region", async () => {
    useNotesStore.setState({
      activeNote: { note: { id: "note-1", region: "경주" } },
    } as never);
    const editor = makeFakeEditor("여기는 경주 여행기");
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);

    renderHook(() => useRegionDetect("note-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useRegionNudgeStore.getState().candidates).toEqual([]);
  });

  // §P3 Phase B 검증 중 발견 — 대표가 바뀌는 것은 에디터 "update" 도 waypoints 변화도 아니라서
  // (setRegion 은 attachmentRevision 을 올리지 않는다) 재스캔이 안 걸렸다: 팝오버에서 "경주"를
  // 대표로 등록해도 바로 아래 "감지됨"에 "경주"가 다음 타이핑까지 남아 있었다.
  it("D9: re-scans when the note's own primary region changes — no editor update or waypoint change needed", async () => {
    useNotesStore.setState({ activeNote: { note: { id: "note-1", region: null } } } as never);
    const editor = makeFakeEditor("여기는 경주 여행기");
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);

    renderHook(() => useRegionDetect("note-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);

    await act(async () => {
      useNotesStore.setState({ activeNote: { note: { id: "note-1", region: "경주" } } } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);
  });

  it("D9: excludes a candidate that matches one of the note's own waypoints — including when the waypoint list is still [] on the mount scan and only resolves afterwards (useNoteWaypoints's own async cache-miss path)", async () => {
    // Deliberately NOT mockReturnValue(...) synchronously — useNoteWaypoints starts at [] on a
    // real cache miss and only has the real list after its own effect resolves. A synchronous
    // mock here would hide exactly the race this test exists to catch (waypoints must be a real
    // effect dependency, not just a ref, or the mount scan always sees an empty waypoint list).
    const waypointsMock = vi.mocked(useNoteWaypoints);
    waypointsMock.mockReturnValueOnce([]);
    waypointsMock.mockReturnValue([
      { id: "wp1", note_id: "note-1", name: "경주", lat: 35.8562, lng: 129.2247, position: 0 },
    ] as never);
    const editor = makeFakeEditor("여기는 경주 여행기");
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);

    const { rerender } = renderHook(() => useRegionDetect("note-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Mount scan ran with waypoints still [] — the textual match is not yet excluded.
    expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);

    // useNoteWaypoints "resolves" (its cache-hit render now returns the real list) — a re-render
    // is what a real fetch's setState would trigger.
    rerender();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);
  });

  it("debounces re-scans on the editor's 'update' event (700ms since the LAST event, not per-event)", async () => {
    const editor = makeFakeEditor("경주 이야기");
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);

    renderHook(() => useRegionDetect("note-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(loadRegionRegistry).mockClear();

    // Three rapid "update" events within the debounce window must collapse into one re-scan.
    act(() => editor.fire("update"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => editor.fire("update"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => editor.fire("update"));
    expect(loadRegionRegistry).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(loadRegionRegistry).toHaveBeenCalledTimes(1);
  });

  it("D10: resets the dismiss set on a note change but a same-note section-id change alone does not touch it", async () => {
    const editor = makeFakeEditor("경주 이야기");
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);

    const { rerender } = renderHook(({ noteId, sectionId }) => useRegionDetect(noteId, sectionId), {
      initialProps: { noteId: "note-1", sectionId: "sec-a" },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);

    act(() => useRegionNudgeStore.getState().dismiss("note-1", "경주"));
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);

    // Same note, different section — dismiss set must survive (D10: reset is note-scoped only).
    rerender({ noteId: "note-1", sectionId: "sec-b" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().dismissedNames.has("경주")).toBe(true);
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);

    // A real note switch clears the dismiss set — the same textual match reappears.
    rerender({ noteId: "note-2", sectionId: "sec-b" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().dismissedNames.has("경주")).toBe(false);
    expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);
  });

  it("does nothing when there is no active editor (e.g. a diagram section)", async () => {
    vi.mocked(getActiveEditor).mockReturnValue(null);
    renderHook(() => useRegionDetect("note-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useRegionNudgeStore.getState().candidates).toEqual([]);
    expect(loadRegionRegistry).not.toHaveBeenCalled();
  });

  // 오너 결정(2026-09-20) — region_nudge_enabled 킬 스위치.
  describe("regionNudgeEnabled kill switch", () => {
    it("disabled: no scan, no region_registry fetch, and clears candidates already present for the note", async () => {
      const editor = makeFakeEditor("여기는 경주 여행기");
      vi.mocked(getActiveEditor).mockReturnValue(editor as never);

      const { rerender } = renderHook(({ enabled }) => {
        useSettingsStore.setState({ regionNudgeEnabled: enabled } as never);
        return useRegionDetect("note-1");
      }, { initialProps: { enabled: true } });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);

      vi.mocked(loadRegionRegistry).mockClear();
      rerender({ enabled: false });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Badge dot / "감지됨" section both read straight off these candidates — emptying them here
      // is what makes both disappear immediately (RegionDetectedSection returns null for []).
      expect(useRegionNudgeStore.getState().candidates).toEqual([]);
      expect(loadRegionRegistry).not.toHaveBeenCalled();
    });

    it("re-enabling triggers an immediate scan (same mount-time path as a fresh note open)", async () => {
      const editor = makeFakeEditor("여기는 경주 여행기");
      vi.mocked(getActiveEditor).mockReturnValue(editor as never);
      useSettingsStore.setState({ regionNudgeEnabled: false } as never);

      const { rerender } = renderHook(({ enabled }) => {
        useSettingsStore.setState({ regionNudgeEnabled: enabled } as never);
        return useRegionDetect("note-1");
      }, { initialProps: { enabled: false } });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(useRegionNudgeStore.getState().candidates).toEqual([]);
      expect(loadRegionRegistry).not.toHaveBeenCalled();

      rerender({ enabled: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // No editor "update" event fired — the scan only happened because re-enabling re-entered the
      // effect body, which scans immediately on mount (same path a fresh note-open takes).
      expect(loadRegionRegistry).toHaveBeenCalledTimes(1);
      expect(useRegionNudgeStore.getState().candidates.map((c) => c.name)).toEqual(["경주"]);
    });
  });
});
