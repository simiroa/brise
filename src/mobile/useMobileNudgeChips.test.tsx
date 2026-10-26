import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { call } from "../lib/invoke";
import { showToastOnly } from "../lib/undo";
import { applyDateMark, stripDateMark } from "./mobileNudgeApply";
import { applyRegionToNote } from "./mobileNoteInputActions";
import { useMobileNudgeChips, shortBubbleDate } from "./useMobileNudgeChips";

/**
 * 감지 결과 → UI 모델. 링크·#태그는 키보드 위 칩 줄(chips), 날짜·지역은 문장 위 말풍선(bubble)으로 갈린다.
 * 감지 자체(디바운스·IME·무시 기억)는 useMobileTypingNudges.test.tsx, 칩·말풍선이 화면에 어떻게 그려지는가는
 * MobileNote.test.tsx / MobileNudgeBubble.test.tsx. 여기는 가름과 "누르면 반영" 클로저(되돌리기 토스트·노트 전환 가드).
 */

const h = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dismiss: vi.fn() }));
vi.mock("./useMobileTypingNudges", () => ({
  NUDGE_DEBOUNCE_MS: 700,
  useMobileTypingNudges: () => ({ state: h.state, dismiss: h.dismiss }),
}));
vi.mock("../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(async () => ({ counts: {} })),
  emitNotice: vi.fn(),
  flushAll: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../lib/undo", () => ({ showToastOnly: vi.fn(), showUndoToast: vi.fn() }));
vi.mock("../lib/diag", () => ({ reportFallback: vi.fn() }));
vi.mock("../lib/linkImport", () => ({ importLinksToSections: vi.fn(async () => []) }));
vi.mock("./mobileNudgeApply", () => ({
  applyDateMark: vi.fn(() => true),
  stripDateMark: vi.fn(),
  replaceTagToken: vi.fn(() => true),
}));
vi.mock("./mobileNoteInputActions", () => ({
  applyRegionToNote: vi.fn(async () => ({ waypointId: null })),
  removeDateRow: vi.fn(async () => {}),
}));

const DATE = {
  payload: { year: 2026, month: 10, day: 8, start_time: "15:00", remind: true },
  label: "2026.10.08 15:00",
  matchFrom: 0,
  matchTo: 8,
  paraStart: 7,
  paraText: "내일 오후 3시 치과",
};
const REGION = { name: "Gyeongju", lat: 35.8, lng: 129.2 };
const TAG = {
  query: { query: "co", from: 3, to: 6 },
  items: [
    { name: "company", isNew: false },
    { name: "co", isNew: true },
  ],
  paraStart: 7,
  paraText: "memo #co",
};

const editor = { isDestroyed: false } as never;
const ed = (over: Record<string, unknown> = {}) =>
  ({ editor, readOnly: false, diagramSection: null, sheetSection: null, activeSectionId: "s1", ...over }) as never;
const activeNote = (region: string | null = null) => ({ note: { id: "n1", region } }) as never;

const setup = (state: Record<string, unknown>, opts: { region?: string | null } = {}) => {
  h.state = state;
  return renderHook(() => useMobileNudgeChips({ ed: ed(), activeNote: activeNote(opts.region ?? null) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state = {};
  useSettingsStore.setState({ uiLang: "en", aiEnabled: true, dateNudgeEnabled: true, dateNudgeAuto: false } as never);
  useNotesStore.setState({
    activeNote: { note: { id: "n1", region: null } } as never,
    bumpAttachmentRevision: vi.fn(),
    ensureMaterialized: vi.fn(async () => "n1"),
    setRegion: vi.fn(),
    setLocation: vi.fn(),
  } as never);
  vi.mocked(call).mockImplementation((async (cmd: string) => (cmd === "note_date_add" ? { id: "d1" } : {})) as never);
});

describe("useMobileNudgeChips — which UI each nudge gets", () => {
  it("date + region → bubble actions; link + #tag → keyboard chips", () => {
    const { result } = setup({ date: DATE, region: REGION, restParaStart: 7, url: "https://example.com/a", tag: TAG });
    expect(result.current.bubble!.actions.map((a) => a.key)).toEqual(["date", "region"]);
    expect(result.current.chips.map((c) => c.key)).toEqual(["nudge:url", "nudge:tag:company", "nudge:tag:new:co"]);
    // 날짜·지역은 칩 줄에 없다
    expect(result.current.chips.some((c) => c.key === "nudge:date" || c.key === "nudge:region")).toBe(false);
  });

  it("no date/region → no bubble (null), chips untouched", () => {
    const { result } = setup({ url: "https://example.com/a" });
    expect(result.current.bubble).toBeNull();
    expect(result.current.chips.map((c) => c.key)).toEqual(["nudge:url"]);
  });

  it("nothing detected → empty chips and no bubble", () => {
    const { result } = setup({});
    expect(result.current).toEqual({ chips: [], bubble: null });
  });

  it("the bubble anchors on the date's paragraph, else on the scan's restParaStart (region has none of its own)", () => {
    expect(setup({ date: DATE, region: REGION, restParaStart: 99 }).result.current.bubble!.anchorPos).toBe(7);
    expect(setup({ region: REGION, restParaStart: 42 }).result.current.bubble!.anchorPos).toBe(42);
    // 앵커가 없으면 null — 말풍선은 "잴 수 없음"으로 그려지고 CSS 가 감춘다(엉뚱한 문단 위로 뛰지 않는다).
    expect(setup({ region: REGION }).result.current.bubble!.anchorPos).toBeNull();
  });

  it("date_nudge_auto: no date action (the effect applies it), but a region action may remain", async () => {
    useSettingsStore.setState({ dateNudgeAuto: true } as never);
    const { result } = setup({ date: DATE, region: REGION, restParaStart: 7 });
    expect(result.current.bubble!.actions.map((a) => a.key)).toEqual(["region"]);
    await waitFor(() => expect(vi.mocked(call).mock.calls.some((c) => c[0] === "note_date_add")).toBe(true));
    expect(h.dismiss).toHaveBeenCalledWith("date", expect.anything());
  });

  it("date_nudge_enabled=false: no date action", () => {
    useSettingsStore.setState({ dateNudgeEnabled: false } as never);
    const { result } = setup({ date: DATE, restParaStart: 7 });
    expect(result.current.bubble).toBeNull();
  });

  it("labels: the pill is short (icon + name / short date); the full wording stays in aria-label", () => {
    const withRegion = setup({ region: REGION, restParaStart: 7 }, { region: "Busan" }).result.current.bubble!.actions[0];
    expect(withRegion.text).toBe("Gyeongju");
    expect(withRegion.ariaLabel).toBe("Waypoint · Gyeongju");
    const bare = setup({ region: REGION, restParaStart: 7 }).result.current.bubble!.actions[0];
    expect(bare.text).toBe("Gyeongju"); // 아이콘이 "지역 ·" 접두를 대신한다
    expect(bare.ariaLabel).toBe("Region · Gyeongju");
    const date = setup({ date: DATE }).result.current.bubble!.actions[0];
    expect(date.text).toMatch(/10\.08 15:00$/); // 올해면 연도 없이 — 연도 판정은 아래 shortBubbleDate 테스트가 고정
    expect(date.ariaLabel).toBe("Add date · 2026.10.08 15:00");
  });

  it("shortBubbleDate: drops the year only for the current year", () => {
    const now = new Date(2026, 9, 7);
    expect(shortBubbleDate({ year: 2026, month: 10, day: 8, start_time: "15:00" }, now)).toBe("10.08 15:00");
    expect(shortBubbleDate({ year: 2027, month: 1, day: 5 }, now)).toBe("2027.01.05");
    expect(shortBubbleDate({ year: 2026, month: 12 }, now)).toBe("12");
    expect(shortBubbleDate({ year: 2028 }, now)).toBe("2028");
  });
});

describe("useMobileNudgeChips — bubble apply / dismiss (same as the chips were)", () => {
  it("date: note_date_add → mark the match → undo toast (strip mark + remove row) → dismiss", async () => {
    const { result } = setup({ date: DATE, restParaStart: 7 });
    await act(async () => {
      await result.current.bubble!.actions[0].onApply();
    });
    expect(vi.mocked(call).mock.calls.find((c) => c[0] === "note_date_add")![1]).toMatchObject({
      note_id: "n1",
      year: 2026,
      month: 10,
      day: 8,
      start_time: "15:00",
    });
    expect(applyDateMark).toHaveBeenCalledWith(editor, { paraStart: 7, paraText: "내일 오후 3시 치과", from: 0, to: 8 }, "d1");
    expect(showToastOnly).toHaveBeenCalledTimes(1);
    vi.mocked(showToastOnly).mock.calls[0][1]!();
    expect(stripDateMark).toHaveBeenCalledWith(editor, "d1");
    expect(h.dismiss).toHaveBeenCalledWith("date", expect.anything());
  });

  it("date: a failed note_date_add neither marks nor dismisses (the suggestion stays for a retry)", async () => {
    vi.mocked(call).mockRejectedValue(new Error("boom"));
    const { result } = setup({ date: DATE, restParaStart: 7 });
    await act(async () => {
      await result.current.bubble!.actions[0].onApply();
    });
    expect(applyDateMark).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
  });

  it("date: switching to another note while the IPC runs does NOT paint a mark onto the new note's body", async () => {
    let finish!: (v: { id: string }) => void;
    vi.mocked(call).mockImplementation((() => new Promise((r) => (finish = r))) as never);
    const { result } = setup({ date: DATE, restParaStart: 7 });
    let applying!: Promise<void>;
    act(() => {
      applying = Promise.resolve(result.current.bubble!.actions[0].onApply());
    });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    useNotesStore.setState({ activeNote: { note: { id: "n2", region: null } } as never });
    await act(async () => {
      finish({ id: "d1" });
      await applying;
    });
    expect(applyDateMark).not.toHaveBeenCalled();
    // 날짜 행은 이미 생겼으니 되돌리기 토스트는 남는다
    expect(showToastOnly).toHaveBeenCalledTimes(1);
  });

  it("region: sets it via applyRegionToNote, toasts, then dismisses", async () => {
    const { result } = setup({ region: REGION, restParaStart: 7 });
    await act(async () => {
      await result.current.bubble!.actions[0].onApply();
    });
    expect(applyRegionToNote).toHaveBeenCalledWith("n1", expect.objectContaining({ name: "Gyeongju" }));
    expect(showToastOnly).toHaveBeenCalledTimes(1);
    expect(h.dismiss).toHaveBeenCalledWith("region", expect.anything());
  });

  it("region: a failed apply keeps the suggestion", async () => {
    vi.mocked(applyRegionToNote).mockRejectedValueOnce(new Error("boom"));
    const { result } = setup({ region: REGION, restParaStart: 7 });
    await act(async () => {
      await result.current.bubble!.actions[0].onApply();
    });
    expect(h.dismiss).not.toHaveBeenCalled();
  });

  it("× dismisses exactly that kind", () => {
    const { result } = setup({ date: DATE, region: REGION, restParaStart: 7 });
    result.current.bubble!.actions[1].onDismiss();
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    expect(h.dismiss).toHaveBeenCalledWith("region", expect.anything());
  });

  it("a draft note is materialised first (same contract as the desktop nudges)", async () => {
    const ensureMaterialized = vi.fn(async () => "n1");
    useNotesStore.setState({ activeNote: { note: { id: "__draft__", region: null } } as never, ensureMaterialized } as never);
    const { result } = setup({ region: REGION, restParaStart: 7 });
    await act(async () => {
      await result.current.bubble!.actions[0].onApply();
    });
    expect(ensureMaterialized).toHaveBeenCalled();
    expect(applyRegionToNote).toHaveBeenCalledWith("n1", expect.anything());
  });
});
