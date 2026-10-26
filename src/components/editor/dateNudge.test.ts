/**
 * PLAN-2026-09-18-nl-dates.md §W3b — dateNudge.ts unit tests: debounce timing (fake timers),
 * caret-inside-vs-past-match gating, exclusion of ranges already covered by a `date` mark, and the
 * accept/undo round trip (note_date_add → DateMark → showUndoToast → undo strips the mark and
 * calls note_date_remove).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import type { NlDateParseResult } from "../../lib/nlDate";

const parseNlDateMock = vi.fn<(text: string, locale: string) => NlDateParseResult | null>();
vi.mock("../../lib/nlDate", () => ({
  parseNlDate: (...args: [string, string]) => parseNlDateMock(...args),
}));

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

const bumpMock = vi.fn();
vi.mock("../../lib/noteQuery", () => ({
  bumpNoteQueryVersion: (...args: unknown[]) => bumpMock(...args),
}));

const undoToastMock = vi.fn();
vi.mock("../../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => undoToastMock(...args),
}));

let uiLang = "ko";
let dateNudgeAuto = false;
let dateNudgeEnabled = true;
type SettingsSnapshot = { uiLang: string; dateNudgeAuto: boolean; dateNudgeEnabled: boolean };
function settingsSnapshot(): SettingsSnapshot {
  return { uiLang, dateNudgeAuto, dateNudgeEnabled };
}
let settingsListeners: Array<(state: SettingsSnapshot, prev: SettingsSnapshot) => void> = [];
/** Test-only stand-in for zustand's real `subscribe` — dateNudge.ts's plugin view() subscribes to
 *  useSettingsStore to clear an already-shown chip the instant dateNudgeEnabled flips off (see
 *  that file's own comment). Flips the module-scope var AND notifies listeners with (next, prev),
 *  same shape the real store calls its listeners with. */
function setDateNudgeEnabled(v: boolean) {
  const prev = settingsSnapshot();
  dateNudgeEnabled = v;
  const next = settingsSnapshot();
  for (const l of settingsListeners) l(next, prev);
}
vi.mock("../../stores/settings", () => ({
  useSettingsStore: {
    getState: () => settingsSnapshot(),
    subscribe: (listener: (state: SettingsSnapshot, prev: SettingsSnapshot) => void) => {
      settingsListeners.push(listener);
      return () => {
        settingsListeners = settingsListeners.filter((l) => l !== listener);
      };
    },
  },
}));

let activeNoteId: string | null = "note-1";
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote: activeNoteId ? { note: { id: activeNoteId } } : null,
    }),
  },
}));

let activeEditor: Editor | null = null;
vi.mock("../../lib/aiSectionBridge", () => ({
  getActiveEditor: () => (activeEditor && !activeEditor.isDestroyed ? activeEditor : null),
}));

vi.mock("../../i18n/t", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

import { DateMark, findDateMarkRanges } from "./dateMark";
import { DateNudge } from "./dateNudge";

function makeEditor(content: string) {
  return new Editor({
    extensions: [StarterKit.configure({ link: false }), Markdown, DateMark, DateNudge],
    content,
  });
}

function chipEl(ed: Editor): HTMLElement | null {
  return ed.view.dom.querySelector('[data-testid="date-nudge-chip"]');
}

function highConfidence(overrides: Partial<NlDateParseResult> = {}): NlDateParseResult {
  return {
    start: { year: 2026, month: 9, day: 20 },
    startTime: null,
    end: { end_year: null, end_month: null, end_day: null },
    endTime: null,
    rrule: null,
    title: null,
    matchRange: [0, 4],
    confidence: "high",
    ...overrides,
  };
}

beforeEach(() => {
  parseNlDateMock.mockReset();
  callMock.mockReset();
  bumpMock.mockReset();
  undoToastMock.mockReset();
  uiLang = "ko";
  dateNudgeAuto = false;
  dateNudgeEnabled = true;
  settingsListeners = [];
  activeNoteId = "note-1";
  activeEditor = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dateNudge — debounce", () => {
  it("does not nudge before ~700ms of quiet, nudges once quiet", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" "); // docChanged — caret ends at block end, past matchRange [0,4]

    expect(chipEl(ed)).toBeNull();
    vi.advanceTimersByTime(699);
    expect(chipEl(ed)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(chipEl(ed)?.textContent).toBe("editor.date_nudge_bubble_label");

    ed.destroy();
  });

  // 오너 2026-09-19: 매치 구간에만 붙는 칩은 "날짜만 등록되는" 느낌을 줬다 — 실제로는 나머지
  // 문장도 제목(label)으로 같이 등록된다(dateNudge.ts의 accept 테스트 참고). 이제 문단 전체를
  // 감싸는 프레임 + 줄 끝의 순수 CTA 버블로 바뀌었다: 날짜 재표기 없이 "이 줄 전체"를 보여준다.
  it("frames the whole line and places the bubble at the line's end, not right after the matched date", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence()); // matchRange [0,4] → absolute [1,5) = "abcd"
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" "); // docChanged — caret ends at block end, past the match
    vi.advanceTimersByTime(700);

    const frame = ed.view.dom.querySelector('[data-testid="date-nudge-line-frame"]');
    expect(frame).not.toBeNull();
    expect(frame?.textContent).toBe("abcdef ");

    const chip = chipEl(ed);
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("editor.date_nudge_bubble_label");
    // The bubble sits at the very end of the line ("...ef "), not wedged right after "abcd" — i.e.
    // it follows the frame in document order (ProseMirror may also render a trailing
    // ProseMirror-trailingBreak <br> after it, so this checks relative order, not "last child").
    expect(frame!.compareDocumentPosition(chip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    ed.destroy();
  });

  it("resets the timer on further typing before it fires", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(500);
    expect(chipEl(ed)).toBeNull();

    ed.commands.insertContent("!"); // resets the debounce
    vi.advanceTimersByTime(600);
    expect(chipEl(ed)).toBeNull(); // only 600ms since the LAST edit

    vi.advanceTimersByTime(100); // now 700ms since the last edit
    expect(chipEl(ed)).not.toBeNull();

    ed.destroy();
  });

  // 2026-09-19 후속(검증 중 발견) — setContent(..., { emitUpdate: false })(노트 열기/전환,
  // MARKDOWN_SET_CONTENT_OPTIONS)는 TipTap 코어가 preventUpdate 메타를 단다. 이 트랜잭션은
  // docChanged 이지만 "타이핑"이 아니므로 디바운스가 걸리면 안 된다 — 걸리면 옛 노트를 열었을
  // 때 캐럿이 우연히 미등록 날짜 문구 위에 놓이면 타이핑 없이 유령 넛지가 뜬다.
  it("does not arm the debounce for a preventUpdate transaction (setContent-style note load)", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.setTextSelection(5); // caret past matchRange [0,4] once parsed
    ed.view.dispatch(
      ed.state.tr.insertText(" ", 5, 5).setMeta("preventUpdate", true),
    );

    vi.advanceTimersByTime(5000); // well past 700ms — no timer was ever armed
    expect(chipEl(ed)).toBeNull();
    expect(parseNlDateMock).not.toHaveBeenCalled();

    // A genuine follow-up user edit (no preventUpdate meta) still works normally afterward.
    ed.commands.insertContent("!");
    vi.advanceTimersByTime(700);
    expect(chipEl(ed)).not.toBeNull();

    ed.destroy();
  });

  it("does not nudge on low-confidence (or null) parses", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence({ confidence: "low" }));
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(700);
    expect(chipEl(ed)).toBeNull();

    parseNlDateMock.mockReturnValue(null);
    ed.commands.insertContent("!");
    vi.advanceTimersByTime(700);
    expect(chipEl(ed)).toBeNull();

    ed.destroy();
  });
});

describe("dateNudge — already-marked ranges are excluded", () => {
  it("does not nudge when the matched span already carries a date mark", () => {
    vi.useFakeTimers();
    // Block text "abcdxy" (6 chars) at blockFrom=1; "abcd" (positions 1..5) already has a date
    // mark. matchRange [0,4] → absolute [1,5) — exactly the marked span.
    parseNlDateMock.mockReturnValue(highConfidence({ matchRange: [0, 4] }));
    const ed = makeEditor('<p><span data-date="existing">abcd</span>xy</p>');
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent("!");
    vi.advanceTimersByTime(700);

    expect(chipEl(ed)).toBeNull();
    ed.destroy();
  });
});

describe("dateNudge — caret-inside-match gating", () => {
  it("stays hidden while the caret is still inside the match, shows once it moves past (no extra debounce)", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence({ matchRange: [0, 4] }));
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    // Insert "Z" at the very start of the paragraph (pos 1) — docChanged, caret ends at pos 2,
    // which is inside the absolute match range [1,5).
    ed.commands.insertContentAt(1, "Z");
    vi.advanceTimersByTime(700);
    expect(chipEl(ed)).toBeNull(); // parsed, but caret still inside matchRange

    // Selection-only move past matchTo (5) — must flip synchronously, no timer needed.
    ed.commands.setTextSelection(6);
    expect(chipEl(ed)).not.toBeNull();

    // Selection-only move OUT of the paragraph (doc start, not inside any textblock) — dismiss.
    ed.commands.setTextSelection(0);
    expect(chipEl(ed)).toBeNull();

    ed.destroy();
  });

  it("Escape dismisses a shown chip", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(700);
    expect(chipEl(ed)).not.toBeNull();

    ed.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(chipEl(ed)).toBeNull();

    ed.destroy();
  });
});

describe("dateNudge — accept / undo", () => {
  it("clicking the chip registers the date, marks the range, and undo cleanly unwinds both", async () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(
      highConfidence({
        start: { year: 2026, month: 9, day: 20 },
        startTime: "14:00",
        endTime: "22:00",
        title: "경복궁방문",
        matchRange: [0, 4],
      }),
    );
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(700);
    const chip = chipEl(ed);
    expect(chip).not.toBeNull();

    callMock.mockResolvedValueOnce({ id: "date-999" }); // note_date_add
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Hidden immediately, before the async note_date_add call resolves.
    expect(chipEl(ed)).toBeNull();

    await vi.advanceTimersByTimeAsync(0);

    expect(callMock).toHaveBeenNthCalledWith(
      1,
      "note_date_add",
      expect.objectContaining({
        note_id: "note-1",
        year: 2026,
        month: 9,
        day: 20,
        start_time: "14:00",
        end_time: "22:00",
        label: "경복궁방문",
        remind: true,
      }),
    );
    expect(findDateMarkRanges(ed.state.doc, "date-999")).not.toEqual([]);
    expect(bumpMock).toHaveBeenCalledTimes(1);
    expect(undoToastMock).toHaveBeenCalledTimes(1);

    const onUndo = undoToastMock.mock.calls[0][1] as () => void;
    callMock.mockResolvedValueOnce({ ok: true }); // note_date_remove
    onUndo();
    await vi.advanceTimersByTimeAsync(0);

    expect(findDateMarkRanges(ed.state.doc, "date-999")).toEqual([]);
    expect(callMock).toHaveBeenNthCalledWith(2, "note_date_remove", { id: "date-999" });
    expect(bumpMock).toHaveBeenCalledTimes(2);

    ed.destroy();
  });

  it("a failed note_date_add leaves no mark and does not toast an undo", async () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(700);
    const chip = chipEl(ed);
    expect(chip).not.toBeNull();

    callMock.mockRejectedValueOnce(new Error("boom"));
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(undoToastMock).not.toHaveBeenCalled();
    expect(bumpMock).not.toHaveBeenCalled();

    ed.destroy();
  });

  it("no-ops without throwing when there is no active note", async () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(700);
    const chip = chipEl(ed);
    expect(chip).not.toBeNull();

    activeNoteId = null;
    expect(() => chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(callMock).not.toHaveBeenCalled();

    ed.destroy();
  });
});

// PLAN-2026-09-18-nl-dates.md §W4 — full-auto opt-in (date_nudge_auto). Chip must never render;
// the same accept/undo path fires on its own once the caret passes the match.
describe("dateNudge — §W4 auto mode (date_nudge_auto)", () => {
  it("registers immediately without ever showing the chip, once the caret passes the match", async () => {
    vi.useFakeTimers();
    dateNudgeAuto = true;
    parseNlDateMock.mockReturnValue(
      highConfidence({
        start: { year: 2026, month: 9, day: 20 },
        startTime: "14:00",
        endTime: "22:00",
        title: "경복궁방문",
        matchRange: [0, 4],
      }),
    );
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;
    callMock.mockResolvedValueOnce({ id: "date-auto-1" }); // note_date_add

    ed.commands.focus("end");
    ed.commands.insertContent(" "); // docChanged — caret ends past matchRange [0,4]
    await vi.advanceTimersByTimeAsync(700); // debounce fires → "result" meta, shown flips true

    expect(chipEl(ed)).toBeNull(); // never rendered — buildDecos() suppresses it in auto mode

    await vi.advanceTimersByTimeAsync(10); // the deferred trigger tick + note_date_add's await

    expect(callMock).toHaveBeenCalledWith(
      "note_date_add",
      expect.objectContaining({
        note_id: "note-1",
        year: 2026,
        month: 9,
        day: 20,
        start_time: "14:00",
        end_time: "22:00",
        label: "경복궁방문",
        remind: true,
      }),
    );
    expect(findDateMarkRanges(ed.state.doc, "date-auto-1")).not.toEqual([]);
    // Auto skips the confirm step, not the safety net (D4) — undo toast still fires.
    expect(undoToastMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledTimes(1); // exactly once — no double-fire off the same edge

    ed.destroy();
  });

  // NOTE on timing: the deferred trigger's `setTimeout(fn, 0)` is scheduled *while* an outer
  // `vi.advanceTimersByTime()` call is still processing (from inside `runParse`'s dispatch, or
  // from a plain synchronous command dispatch). A timer scheduled mid-advance is NOT drained by
  // that same advance call — it needs a **separate subsequent** timer advance to fire (verified
  // empirically: a single `vi.advanceTimersByTime(700)` alone leaves it pending; a following
  // `advanceTimersByTimeAsync(10)` drains it). Every "should NOT auto-register" test below still
  // performs that second drain — otherwise "not called" would be true merely because the timer
  // never got a chance to run, not because the gate actually blocked it (this bit a first draft:
  // both negative tests below passed even with their gate deliberately broken, i.e. the assertion
  // was vacuous — caught by temporarily flipping each gate and confirming the test then failed).
  it("does not auto-register a low-confidence match (auto skips confirmation, not the confidence gate)", async () => {
    vi.useFakeTimers();
    dateNudgeAuto = true;
    parseNlDateMock.mockReturnValue(highConfidence({ confidence: "low" }));
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(10); // drain — see NOTE above

    expect(chipEl(ed)).toBeNull();
    expect(callMock).not.toHaveBeenCalled();

    ed.destroy();
  });

  it("stays a manual chip (no auto-register) when the setting is off", async () => {
    vi.useFakeTimers();
    dateNudgeAuto = false;
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    await vi.advanceTimersByTimeAsync(700);

    expect(chipEl(ed)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10); // drain — see NOTE above
    expect(callMock).not.toHaveBeenCalled(); // nothing auto-fires — still waits for a click

    ed.destroy();
  });

  it("auto-registers off a selection-only edge too (caret moves past the match after the debounce already fired with it inside)", async () => {
    vi.useFakeTimers();
    dateNudgeAuto = true;
    // Mirrors the W3b "caret-inside-match gating" test's setup: insert at pos 1 so the caret ends
    // inside the absolute match range [1,5) once parsed — debounce fires with shown still false,
    // and only the LATER selection-only move past matchTo is the `shown` edge that must trigger.
    parseNlDateMock.mockReturnValue(highConfidence({ matchRange: [0, 4] }));
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;
    callMock.mockResolvedValueOnce({ id: "date-auto-selection" });

    ed.commands.insertContentAt(1, "Z");
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(10); // drain — nothing should have fired yet
    expect(callMock).not.toHaveBeenCalled(); // parsed, but caret still inside matchRange — no edge

    ed.commands.setTextSelection(6); // selection-only transaction — this is the edge
    await vi.advanceTimersByTimeAsync(10); // drain the deferred trigger this edge schedules

    expect(callMock).toHaveBeenCalledWith(
      "note_date_add",
      expect.objectContaining({ note_id: "note-1", remind: true }),
    );
    expect(findDateMarkRanges(ed.state.doc, "date-auto-selection")).not.toEqual([]);
    expect(callMock).toHaveBeenCalledTimes(1);

    ed.destroy();
  });
});

// 오너 결정(2026-09-20) — date_nudge_enabled 킬 스위치. "off" 가 dateNudgeAuto 보다 우선한다
// (§W4 자동 등록도 off 앞에서는 안 뜬다), 그리고 이미 떠 있는 칩은 다음 키 입력을 기다리지 않고
// 설정을 끄는 순간 바로 사라진다(dateNudge.ts view()의 useSettingsStore.subscribe).
describe("dateNudge — date_nudge_enabled kill switch", () => {
  it("does nothing when disabled — no line frame, no chip, no parsing work at all", async () => {
    vi.useFakeTimers();
    dateNudgeEnabled = false;
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    await vi.advanceTimersByTimeAsync(700);

    expect(chipEl(ed)).toBeNull();
    expect(ed.view.dom.querySelector('[data-testid="date-nudge-line-frame"]')).toBeNull();
    // The plugin bails at the very top of view().update() while disabled — the debounce timer is
    // never armed, so parseNlDate never runs at all (not just "runs but is suppressed").
    expect(parseNlDateMock).not.toHaveBeenCalled();

    ed.destroy();
  });

  it("off beats dateNudgeAuto — no auto-register even with dateNudgeAuto on", async () => {
    vi.useFakeTimers();
    dateNudgeEnabled = false;
    dateNudgeAuto = true;
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(10); // drain — see the §W4 block's own timing NOTE above

    expect(chipEl(ed)).toBeNull();
    expect(callMock).not.toHaveBeenCalled();

    ed.destroy();
  });

  it("clears an already-shown chip immediately when flipped off mid-nudge — no keystroke needed", () => {
    vi.useFakeTimers();
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    vi.advanceTimersByTime(700);
    expect(chipEl(ed)).not.toBeNull();
    expect(ed.view.dom.querySelector('[data-testid="date-nudge-line-frame"]')).not.toBeNull();

    setDateNudgeEnabled(false);

    expect(chipEl(ed)).toBeNull();
    expect(ed.view.dom.querySelector('[data-testid="date-nudge-line-frame"]')).toBeNull();

    ed.destroy();
  });

  it("flipping back on restores normal nudging on the next debounce cycle", async () => {
    vi.useFakeTimers();
    setDateNudgeEnabled(false);
    parseNlDateMock.mockReturnValue(highConfidence());
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.commands.focus("end");
    ed.commands.insertContent(" ");
    await vi.advanceTimersByTimeAsync(700);
    expect(chipEl(ed)).toBeNull();

    setDateNudgeEnabled(true);
    ed.commands.insertContent("!"); // a fresh debounce cycle, now enabled
    await vi.advanceTimersByTimeAsync(700);
    expect(chipEl(ed)).not.toBeNull();

    ed.destroy();
  });

  it("the explicit /날짜 slash entry path is untouched by this switch (DateMark applies regardless of the nudge)", () => {
    // DateEntryPopover/the slash command live outside this plugin entirely — this test only
    // confirms that disabling the nudge doesn't somehow also block the DateMark mark itself from
    // being applied to a range, which is the mechanism the explicit entry path shares with the
    // nudge's own accept step (dateNudge.ts's acceptCandidate uses the same setMark("date", …)).
    dateNudgeEnabled = false;
    const ed = makeEditor("<p>abcdef</p>");
    activeEditor = ed;

    ed.chain().setTextSelection({ from: 1, to: 5 }).setMark("date", { id: "manual-1" }).run();
    expect(findDateMarkRanges(ed.state.doc, "manual-1")).not.toEqual([]);

    ed.destroy();
  });
});
