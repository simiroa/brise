import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forwardRef, useImperativeHandle } from "react";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { useNotesStore } from "../stores/notes";
import { useAiStore } from "../stores/ai";
import { useMobileAmbientStore } from "../stores/mobileAmbient";
import { useWorkspacesStore } from "../stores/workspaces";
import { useSearchStore } from "../stores/search";
import { MobileApp } from "./MobileApp";

let searchResultsFixture: unknown[] = [];
const callMock = vi.fn(async (cmd: string) => {
  if (cmd === "settings_get_all") return { settings: { ui_lang: "en" } };
  if (cmd === "note_year_histogram") return { counts: [] };
  // MobileHome always mounts MobileWorkspaceSwitcher (owner feedback item 6), which loads this on
  // mount — shaped like the real workspace_list response so its .find()/.map() calls don't blow up.
  if (cmd === "workspace_list") return { workspaces: [], active_id: null };
  // setQuery() schedules a debounced search_notes — keep the response shape valid (tests that want
  // hits set searchResultsFixture).
  if (cmd === "search_notes") return { results: searchResultsFixture, total: searchResultsFixture.length };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(args[0] as string),
  callSilent: (...args: unknown[]) => callMock(args[0] as string),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));

// MobileNote mounts a real Tiptap editor — irrelevant to "does the tab bar/leaveCapture flow wire
// the right store actions and screen transitions", and slow/heavy to mount in jsdom for that.
// Stubbed as a forwardRef component so MobileApp's leaveCapture() (which reads
// noteRef.current.flushAndMeasure()) has something to call — flushAndMeasureMock's resolved value
// is what each test uses to drive the short-note-vs-long-note branch. notifyRemoteChangeMock is the
// W1/K1 half of the handle — MobileApp is now lazy() + Suspense over this component (bundle
// W1-(b)-3), so the "does the ref still attach behind a lazy boundary" test below calling it through
// noteRef IS the regression guard the work order asks for.
const flushAndMeasureMock = vi.fn(async () => 0);
const notifyRemoteChangeMock = vi.fn();
const hasUnsavedFailureMock = vi.fn(() => false);
const showLeaveBlockedMock = vi.fn();
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));
vi.mock("./MobileOfflineBanner", () => ({
  MobileOfflineBanner: () => null,
}));

vi.mock("./MobileNote", () => ({
  MobileNote: forwardRef(function MobileNoteStub(
    { onBack }: { onBack: () => void },
    ref: React.Ref<{
      flushAndMeasure: () => Promise<number>;
      notifyRemoteChange: (noteId: string) => void;
      hasUnsavedFailure: () => boolean;
      showLeaveBlocked: (proceed: () => void) => void;
    }>
  ) {
    useImperativeHandle(ref, () => ({
      flushAndMeasure: flushAndMeasureMock,
      notifyRemoteChange: notifyRemoteChangeMock,
      hasUnsavedFailure: hasUnsavedFailureMock,
      showLeaveBlocked: showLeaveBlockedMock,
    }));
    return (
      <div data-testid="mobile-note-stub">
        <button onClick={onBack}>back</button>
      </div>
    );
  }),
}));

// MobileHome's real "필터" tab now renders MobileNoteTree (note_query/folder_list_meta-backed —
// W2 retired the old REST-feed "최근" card list, see MobileHome.tsx's header comment). Seeding a
// note through that tree for the 2 tests below that need one clickable existing-note row would mean
// wiring note_query/folder_list_meta/tag_counts/etc. through the shared callMock, for something this
// file doesn't otherwise care about testing (tree contents are MobileNoteTree.test.tsx's job). So
// this partial-mocks MobileHome: real component by default (every other test here still exercises
// the genuine home screen, e.g. the "Search notes…" label checks below), and ONLY when
// mobileHomeOpenableNotes is non-null (set by the one describe block that needs it) swaps in a
// trivial stub exposing onOpenNote — same "mutable-variable-read-at-render-time" convention this
// file already uses for capturedRemoteWriteOpts below.
let mobileHomeOpenableNotes: { id: string; title: string }[] | null = null;
vi.mock("./MobileHome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MobileHome")>();
  return {
    ...actual,
    MobileHome: (props: Parameters<typeof actual.MobileHome>[0]) => {
      if (!mobileHomeOpenableNotes) return <actual.MobileHome {...props} />;
      return (
        <div data-testid="mobile-home-stub">
          {mobileHomeOpenableNotes.map((n) => (
            <button key={n.id} onClick={() => props.onOpenNote(n.id)}>
              {n.title}
            </button>
          ))}
        </div>
      );
    },
  };
});

// K1: the real listenRemoteNoteWrite() picks Tauri's listen() whenever isBrowser() is false (no
// sync token in sessionStorage, the default here) — and that listen() calls invoke() on
// window.__TAURI_INTERNALS__, which doesn't exist in jsdom, producing an unhandled rejection. Real
// registration behavior is already covered end to end by remoteNoteWrite.test.ts; this file only
// needs to prove MobileApp wires noteRef into the callback correctly (see the test below), so the
// mock captures the opts it was called with instead of touching any real transport.
let capturedRemoteWriteOpts: { onFocusSkipped?: (noteId: string) => void } | undefined;
const listenRemoteNoteWriteMock = vi.fn((opts?: typeof capturedRemoteWriteOpts) => {
  capturedRemoteWriteOpts = opts;
  return () => {};
});
vi.mock("../lib/remoteNoteWrite", () => ({
  listenRemoteNoteWrite: (opts?: unknown) => listenRemoteNoteWriteMock(opts as any),
}));

// Minimal NoteDetail-shaped stub — MobilePostSave reads note.title/note.id + the last section's
// id/body_md; nothing else in this test suite touches activeNote (MobileNote itself is mocked).
function fakeActiveNote() {
  return {
    note: {
      id: "n1",
      title: "Untitled Note",
      year: 2026,
      month: null,
      day: null,
      folder_id: "f1",
      is_favorite: false,
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      tag_names: [],
      created_at: "",
      updated_at: "",
      exported_at: null,
    },
    sections: [{ id: "s1", name: "default", body_md: "hello world", position: 0 }],
    attachments: [],
  } as any;
}

// Keeps raw fetch() (the settings screen's /api/v1/ping) off the network: every URL 404s.
function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
}

describe("MobileApp — tab bar + capture flow", () => {
  beforeEach(() => {
    callMock.mockClear();
    flushAndMeasureMock.mockReset().mockResolvedValue(0);
    stubFetch();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tapping the 입력 tab calls the notes store's newNote() and shows the capture screen", async () => {
    const newNoteMock = vi.fn().mockResolvedValue(undefined);
    useNotesStore.setState({ newNote: newNoteMock, activeNote: null } as any);

    render(<MobileApp />);

    const captureTab = await screen.findByLabelText("Write");
    fireEvent.click(captureTab);

    await waitFor(() => expect(newNoteMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("mobile-note-stub")).toBeTruthy();
  });

  it("leaving a short capture note (via the back arrow) returns straight to the home feed, no interstitial", async () => {
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as any);
    flushAndMeasureMock.mockResolvedValue(20); // well under the 200-char "long" threshold

    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    fireEvent.click(await screen.findByText("back"));

    // MobileHome's topbar no longer shows a static "Brise" wordmark (item 2, this pass) — the
    // search button is a stable home-screen marker instead.
    await waitFor(() => expect(screen.getByLabelText("Search notes, tags, sources…")).toBeTruthy());
    expect(screen.queryByText("Your note has been saved.")).toBeNull();
  });

  it("leaving a long capture note shows the post-save interstitial instead of the feed", async () => {
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: fakeActiveNote() } as any);
    flushAndMeasureMock.mockResolvedValue(250); // over the 200-char threshold

    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    fireEvent.click(await screen.findByText("back"));

    expect(await screen.findByText("Your note has been saved.")).toBeTruthy();
  });

  it("post-save's [다음 메모 작성] equivalent starts a fresh capture note", async () => {
    const newNoteMock = vi.fn().mockResolvedValue(undefined);
    useNotesStore.setState({ newNote: newNoteMock, activeNote: fakeActiveNote() } as any);
    flushAndMeasureMock.mockResolvedValue(250);

    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    fireEvent.click(await screen.findByText("back"));
    await screen.findByText("Your note has been saved.");

    fireEvent.click(screen.getByText("Write another note"));
    await waitFor(() => expect(newNoteMock).toHaveBeenCalledTimes(2)); // once entering capture, once from postsave
    expect(await screen.findByTestId("mobile-note-stub")).toBeTruthy();
  });

  it("post-save's quiet feed link returns to the home tab", async () => {
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: fakeActiveNote() } as any);
    flushAndMeasureMock.mockResolvedValue(250);

    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    fireEvent.click(await screen.findByText("back"));
    await screen.findByText("Your note has been saved.");

    fireEvent.click(screen.getByText("Back to feed"));
    // MobileHome's topbar no longer shows a static "Brise" wordmark (item 2, this pass) — the
    // search button is a stable home-screen marker instead.
    await waitFor(() => expect(screen.getByLabelText("Search notes, tags, sources…")).toBeTruthy());
  });

  it("입력 keeps the shared tab bar visible (owner feedback this pass, item 4) with 입력 marked active", async () => {
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as any);
    const { container } = render(<MobileApp />);
    expect(container.querySelector(".mobile-tabbar")).toBeTruthy();

    fireEvent.click(await screen.findByLabelText("Write"));
    await screen.findByTestId("mobile-note-stub");
    const tabbar = container.querySelector(".mobile-tabbar");
    expect(tabbar).toBeTruthy();
    const captureTab = within(tabbar as HTMLElement).getByLabelText("Write");
    expect(captureTab.getAttribute("data-active")).toBe("true");
  });

  it("derives slide direction from left-to-right tab order instead of always animating forward", async () => {
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as any);
    const { container } = render(<MobileApp />);

    // home -> settings is a rightward move: the current (last) screen pane slides in "forward".
    const tabbar = () => container.querySelector(".mobile-tabbar") as HTMLElement;
    fireEvent.click(within(tabbar()).getByLabelText("Settings"));
    await waitFor(() => {
      const panes = container.querySelectorAll(".mobile-screen");
      const current = panes[panes.length - 1];
      expect(current.className).toContain("mobile-screen--forward");
    });

    // settings -> home is a leftward move: must now animate "back", not "forward" again (the bug
    // being fixed — the old code hardcoded "forward" for every tab-to-tab move).
    fireEvent.click(within(tabbar()).getByLabelText("Notes"));
    await waitFor(() => {
      const panes = container.querySelectorAll(".mobile-screen");
      const current = panes[panes.length - 1];
      expect(current.className).toContain("mobile-screen--back");
    });
  });
});

/**
 * Owner feedback 2026-07-30, item 1 — "노트 보기와 입력이 같은 UX여야 한다". The two halves of the
 * shared chrome are asserted in two files because each one stubs the other side: the bottom dock
 * and the ＋ speed dial (with AI in it; 저장하기 was removed 2026-10-10) are MobileNote's, tested in MobileNote.test.tsx; the tab bar is the shell's,
 * tested here. Before this pass the "note" screen was a pushed screen and showTabBar excluded it.
 */
describe("MobileApp — opening an existing note gets the same chrome as 입력 (item 1)", () => {
  beforeEach(() => {
    callMock.mockClear();
    flushAndMeasureMock.mockReset().mockResolvedValue(0);
    stubFetch();
    // These 2 tests only care about "an existing note was opened", not about how the tree found it
    // (MobileNoteTree.test.tsx owns that) — see the MobileHome mock's header comment above.
    mobileHomeOpenableNotes = [{ id: "n-existing", title: "An older note" }];
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
  });
  afterEach(() => {
    mobileHomeOpenableNotes = null;
    vi.unstubAllGlobals();
  });

  it("keeps the tab bar visible on the note screen, with 노트 still the active tab", async () => {
    const selectNote = vi.fn().mockResolvedValue(undefined);
    useNotesStore.setState({ selectNote, newNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as any);

    const { container } = render(<MobileApp />);

    fireEvent.click(await screen.findByText("An older note"));
    await waitFor(() => expect(selectNote).toHaveBeenCalledWith("n-existing"));
    expect(await screen.findByTestId("mobile-note-stub")).toBeTruthy();

    // THE regression: this used to be null — "note" was a pushed screen, so showTabBar hid the bar.
    const tabbar = container.querySelector(".mobile-tabbar");
    expect(tabbar).toBeTruthy();
    expect(within(tabbar as HTMLElement).getByLabelText("Notes").getAttribute("data-active")).toBe(
      "true"
    );
  });

  it("leaving an existing note (back) flushes and returns — never the post-save interstitial", async () => {
    const selectNote = vi.fn().mockResolvedValue(undefined);
    useNotesStore.setState({
      selectNote,
      newNote: vi.fn().mockResolvedValue(undefined),
      activeNote: fakeActiveNote(),
    } as any);
    // Long enough that capture's own rule WOULD show the interstitial — proving the existing-note
    // rule is a different one, not just a short-note coincidence.
    flushAndMeasureMock.mockResolvedValue(5000);

    render(<MobileApp />);
    fireEvent.click(await screen.findByText("An older note"));
    await screen.findByTestId("mobile-note-stub");

    fireEvent.click(screen.getByText("back"));

    await waitFor(() => expect(flushAndMeasureMock).toHaveBeenCalledTimes(1));
    // Back to the feed, no 메모가 저장되었습니다 screen.
    await waitFor(() => expect(screen.queryByTestId("mobile-note-stub")).toBeNull());
    expect(screen.queryByText("Note saved.")).toBeNull();
  });
});

/**
 * Regression guard for the MobileModal wiring (item 5). MobileModal pushes a throwaway history
 * entry on open so the Android back gesture closes the modal; popping it fires MobileApp's own
 * popstate listener too, with the UNDERLYING entry's state. On 입력 that state is `{screen:"capture"}`
 * — and the listener's "stale capture entry" branch would have called newNote(), destroying the
 * draft the user was typing into while the modal was open.
 */
describe("MobileApp — a back-pop that lands on the capture screen we're already on keeps the draft", () => {
  beforeEach(() => {
    callMock.mockClear();
    flushAndMeasureMock.mockReset().mockResolvedValue(0);
    stubFetch();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call newNote() again when popstate re-reports the capture screen", async () => {
    const newNoteMock = vi.fn().mockResolvedValue(undefined);
    useNotesStore.setState({ newNote: newNoteMock, activeNote: null } as any);

    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    await waitFor(() => expect(newNoteMock).toHaveBeenCalledTimes(1));
    await screen.findByTestId("mobile-note-stub");

    // What popping a modal's throwaway entry looks like from here: state is the capture entry that
    // was already underneath, and we are already showing it.
    fireEvent.popState(window, { state: { screen: "capture" } });

    await waitFor(() => expect(screen.getByTestId("mobile-note-stub")).toBeTruthy());
    expect(newNoteMock).toHaveBeenCalledTimes(1); // NOT 2 — the draft survived
  });
});

/**
 * K1 (WORKORDER W1, goal a) + the lazy-MobileNote bundle change (goal b-3) land in the same wave —
 * this is the seam between them: MobileApp registers listenRemoteNoteWrite() once and threads
 * onFocusSkipped through noteRef, and noteRef now points at a component behind a Suspense boundary.
 * If lazy() ever stopped forwarding the ref, this would be a silent no-op (optional chaining) rather
 * than a crash — exactly the "flush quietly doesn't go out" failure mode the work order warns about
 * for flushAndMeasure, so this asserts the ref side explicitly instead of trusting it by absence of
 * error.
 */
describe("MobileApp — K1 remote-write registration wired to noteRef through the lazy boundary", () => {
  beforeEach(() => {
    callMock.mockClear();
    flushAndMeasureMock.mockReset().mockResolvedValue(0);
    notifyRemoteChangeMock.mockClear();
    listenRemoteNoteWriteMock.mockClear();
    capturedRemoteWriteOpts = undefined;
    stubFetch();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as any);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers listenRemoteNoteWrite({ onFocusSkipped }) once on mount", () => {
    render(<MobileApp />);
    expect(listenRemoteNoteWriteMock).toHaveBeenCalledTimes(1);
    expect(typeof capturedRemoteWriteOpts?.onFocusSkipped).toBe("function");
  });

  it("onFocusSkipped is a safe no-op while no note screen is mounted (noteRef.current is null)", () => {
    render(<MobileApp />);
    expect(() => capturedRemoteWriteOpts?.onFocusSkipped?.("n1")).not.toThrow();
    expect(notifyRemoteChangeMock).not.toHaveBeenCalled();
  });

  it("onFocusSkipped reaches the lazy-loaded MobileNote's notifyRemoteChange through noteRef", async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    // The lazy MobileNote chunk (mocked here, but still an async import()) must have resolved and
    // attached its ref before this proves anything — findByTestId polls until it does.
    await screen.findByTestId("mobile-note-stub");

    capturedRemoteWriteOpts?.onFocusSkipped?.("n1");

    expect(notifyRemoteChangeMock).toHaveBeenCalledWith("n1");
  });
});

/**
 * V2 (tab moves must not stack history) + V1 (search query must not leak into home).
 * Stack invariant: home is the single root entry; non-home tab = idx 1, tab<->tab replaces.
 */
describe("MobileApp — tab history invariant (V2) and search-query scoping (V1)", () => {
  const SEARCH_LABEL = "Search notes, tags, sources…";
  const tabbar = (c: HTMLElement) => c.querySelector(".mobile-tabbar") as HTMLElement;
  const idxOf = () => (history.state as { idx?: number } | null)?.idx;
  let newNoteMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Earlier describes leave jsdom history traversals (history.back()) in flight; let them land
    // before this file's assertions read history.state.
    await new Promise((r) => setTimeout(r, 50));
    callMock.mockClear();
    flushAndMeasureMock.mockReset().mockResolvedValue(0);
    stubFetch();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
    newNoteMock = vi.fn().mockResolvedValue(undefined);
    useNotesStore.setState({ newNote: newNoteMock, selectNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as any);
    useSearchStore.setState({ query: "", searchResults: [] } as any);
  });
  afterEach(() => {
    mobileHomeOpenableNotes = null;
    searchResultsFixture = [];
    vi.unstubAllGlobals();
  });

  it("home -> 입력 -> 설정 -> back lands on home without creating a note", async () => {
    const { container } = render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    await screen.findByTestId("mobile-note-stub");
    expect(newNoteMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(tabbar(container)).getByLabelText("Settings"));
    await waitFor(() => expect(screen.queryByTestId("mobile-note-stub")).toBeNull());
    expect(idxOf()).toBe(1); // replaced, not stacked

    window.history.back();
    await waitFor(() => expect(idxOf()).toBe(0));
    await waitFor(() => expect(screen.getByLabelText(SEARCH_LABEL)).toBeTruthy());
    expect(newNoteMock).toHaveBeenCalledTimes(1); // the back did not fabricate a draft
  });

  it("tab hopping keeps exactly one entry above home; tab -> home returns to the root", async () => {
    const { container } = render(<MobileApp />);
    const push = vi.spyOn(history, "pushState");
    const hop = (label: string) => fireEvent.click(within(tabbar(container)).getByLabelText(label));

    hop("Settings");
    await waitFor(() => expect(idxOf()).toBe(1));
    hop("Write");
    await screen.findByTestId("mobile-note-stub");
    hop("Settings");
    await waitFor(() => expect(screen.queryByTestId("mobile-note-stub")).toBeNull());
    expect(push).toHaveBeenCalledTimes(1); // only home -> first tab pushed
    expect(idxOf()).toBe(1);

    hop("Notes");
    await waitFor(() => expect(screen.getByLabelText(SEARCH_LABEL)).toBeTruthy());
    expect(idxOf()).toBe(0);
    push.mockRestore();
  });

  it("a layer left open on home (selection mode keeps the tab bar usable) is consumed by a tab move, so coming back lands on home", async () => {
    const { container } = render(<MobileApp />);
    const hop = (label: string) => fireEvent.click(within(tabbar(container)).getByLabelText(label));
    await waitFor(() => expect(idxOf()).toBe(0));
    history.pushState({ mobileModal: true, layerSeq: 999 }, ""); // e.g. selection mode's marker

    hop("Settings");
    await waitFor(() => expect(idxOf()).toBe(1));
    hop("Notes");
    await waitFor(() => expect(screen.getByLabelText(SEARCH_LABEL)).toBeTruthy());
    await waitFor(() => expect(idxOf()).toBe(0));
    expect((history.state as { mobileModal?: boolean } | null)?.mobileModal).toBeFalsy();
  });

  it("leaving search for home (back) clears the query; no active filter remains", async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText(SEARCH_LABEL));
    await screen.findByPlaceholderText(/search/i);
    useSearchStore.setState({ query: "kimchi", searchResults: [] } as any);

    window.history.back();
    await waitFor(() => expect(screen.getByLabelText(SEARCH_LABEL)).toBeTruthy());
    await waitFor(() => expect(useSearchStore.getState().query).toBe(""));
  });

  it("search -> open a result -> back keeps the query and results; a further back clears it", async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText(SEARCH_LABEL));
    await screen.findByPlaceholderText(/search/i);
    searchResultsFixture = [{ id: "r1", title: "Stew recipe", snippet: "", updated_at: "2026-01-01T00:00:00Z" }];
    useSearchStore.setState({ query: "kimchi", searchResults: searchResultsFixture } as any);
    fireEvent.click(await screen.findByText("Stew recipe"));
    await screen.findByTestId("mobile-note-stub");
    expect(useSearchStore.getState().query).toBe("kimchi");

    window.history.back();
    await waitFor(() => expect(screen.queryByTestId("mobile-note-stub")).toBeNull());
    expect(useSearchStore.getState().query).toBe("kimchi");
    expect(screen.getByText("Stew recipe")).toBeTruthy();

    window.history.back();
    await waitFor(() => expect(screen.getByLabelText(SEARCH_LABEL)).toBeTruthy());
    await waitFor(() => expect(useSearchStore.getState().query).toBe(""));
  });
});

/**
 * V5 - a failed save must keep the user on the screen with the text intact, record why, and hand
 * MobileNote a `proceed` for the leave-anyway button. Success path (flag false) is covered above.
 */
describe("MobileApp - leaving with an unsaved (failed) body is blocked (V5)", () => {
  beforeEach(() => {
    callMock.mockClear();
    flushAndMeasureMock.mockReset().mockResolvedValue(20);
    hasUnsavedFailureMock.mockReset().mockReturnValue(true);
    showLeaveBlockedMock.mockReset();
    reportFallbackMock.mockReset();
    stubFetch();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined), activeNote: fakeActiveNote() } as any);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    hasUnsavedFailureMock.mockReturnValue(false);
  });

  it("capture back: stays on capture, records a diag entry without body, proceed leaves", async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    fireEvent.click(await screen.findByText("back"));

    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();
    expect(reportFallbackMock).toHaveBeenCalledWith("mobile-save", "leave_blocked", "capture_back");

    hasUnsavedFailureMock.mockReturnValue(false);
    (showLeaveBlockedMock.mock.calls[0] as unknown as [() => void])[0]();
    await waitFor(() => expect(screen.getByLabelText("Search notes, tags, sources…")).toBeTruthy());
  });

  it("capture tab tap away: blocked too", async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    await screen.findByTestId("mobile-note-stub");
    fireEvent.click(screen.getByLabelText("Notes"));

    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();
    expect(reportFallbackMock).toHaveBeenCalledWith("mobile-save", "leave_blocked", "capture_tab");
  });

  it("existing note: header back is blocked (twice — it stays blocked until the user decides)", async () => {
    mobileHomeOpenableNotes = [{ id: "n-existing", title: "An older note" }];
    hasUnsavedFailureMock.mockReturnValue(false);
    useNotesStore.setState({ selectNote: vi.fn().mockResolvedValue(undefined) } as any);
    render(<MobileApp />);
    fireEvent.click(await screen.findByText("An older note"));
    await screen.findByTestId("mobile-note-stub");
    hasUnsavedFailureMock.mockReturnValue(true);

    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("back"));
    await waitFor(() => expect(showLeaveBlockedMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("mobile-note-stub")).toBeTruthy();
    expect(reportFallbackMock).toHaveBeenCalledWith("mobile-save", "leave_blocked", "note_back");
    mobileHomeOpenableNotes = null;
  });
});

// 배경 신호(MobileAmbient — AI 빛줄기·녹음 이퀄라이저 띠). 레이어 자체의 단계/타이밍은 MobileAmbient.test.tsx 가 본다 —
// 여기서는 "앱 루트에 한 장 걸려 있고, 스토어 신호가 실제 앱 트리에서 그 레이어에 닿는가"만 확인한다.
describe("MobileApp — ambient signals (AI beam / recording equalizer)", () => {
  beforeEach(() => {
    callMock.mockClear();
    stubFetch();
    useWorkspacesStore.setState({ workspaces: [], activeId: null, loaded: false } as any);
  });
  afterEach(() => {
    act(() => {
      useAiStore.setState({ promptPending: false });
      useMobileAmbientStore.setState({ rec: "off" });
    });
    vi.unstubAllGlobals();
  });

  it("mounts one decorative, touch-transparent layer inside the app root", async () => {
    const { container } = render(<MobileApp />);
    const layer = await screen.findByTestId("mobile-ambient");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".mobile-app")?.contains(layer)).toBe(true);
    expect(screen.getAllByTestId("mobile-ambient")).toHaveLength(1);
    // idle: beam host is armed but dark, no recording layer
    expect(screen.getByTestId("mobile-ambient-beam").getAttribute("data-ai-glow-beam")).toBe("true");
    expect(screen.getByTestId("mobile-ambient-beam").hasAttribute("data-ai-glow")).toBe(false);
    expect(screen.queryByTestId("mobile-rec")).toBeNull();
  });

  it("AI busy lights the beam; when it ends the beam fades, then goes dark", async () => {
    render(<MobileApp />);
    const beam = await screen.findByTestId("mobile-ambient-beam");
    act(() => useAiStore.setState({ promptPending: true }));
    expect(beam.getAttribute("data-ai-glow")).toBe("active");
    act(() => useAiStore.setState({ promptPending: false }));
    expect(beam.getAttribute("data-ai-glow")).toBe("fading");
    await waitFor(() => expect(beam.hasAttribute("data-ai-glow")).toBe(false));
  });

  it("the recording store lights the equalizer layer", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-ambient");
    act(() => useMobileAmbientStore.setState({ rec: "on" }));
    expect(screen.getByTestId("mobile-rec").getAttribute("data-rec")).toBe("on");
  });
});

describe("MobileApp — 입력 화면의 노트가 사라지면 새 초안 (2026-10-07 S22 빈 화면)", () => {
  it("입력 화면에서 열려 있던 노트가 null 이 되면 newNote 를 한 번 다시 부른다", async () => {
    const draft = { note: { id: "__draft__", title: "" }, sections: [{ id: "s", name: "", body_md: "", position: 0, kind: "text" }], sources: [], attachments: [] };
    const newNoteMock = vi.fn(async () => {
      useNotesStore.setState({ activeNote: draft } as any);
    });
    useNotesStore.setState({ newNote: newNoteMock, activeNote: null } as any);
    render(<MobileApp />);
    fireEvent.click(await screen.findByLabelText("Write"));
    await waitFor(() => expect(newNoteMock).toHaveBeenCalledTimes(1));
    // 가져온 초안을 버린 것처럼 — 화면은 그대로 입력인데 노트가 사라진다.
    act(() => {
      useNotesStore.setState({ activeNote: null } as any);
    });
    await waitFor(() => expect(newNoteMock).toHaveBeenCalledTimes(2));
  });
});
