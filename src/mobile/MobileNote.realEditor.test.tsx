import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/core";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";

/**
 * MobileNote — 진짜 Tiptap 으로 보는 조립 스모크. MobileNote.test.tsx 는 에디터를 가짜(렌더마다 새 인스턴스)로
 * 대체해 배선만 보는데, 그 가짜는 "한 인스턴스가 렌더를 넘어 산다"·"조기 반환 위 훅 순서"·"직렬화가 진짜다" 를
 * 못 본다. MobileNote 를 useMobile* 훅으로 쪼갠 뒤 이 세 가지가 그대로인지 여기서 한 번씩 본다.
 * (MobileDiagramAuthoring.test.tsx 도 진짜 DiagramSection 으로 조립을 보지만, 가짜 에디터를 쓴다.)
 */
vi.mock("../lib/invoke", () => ({
  call: vi.fn(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {})),
  callSilent: vi.fn(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : { counts: {} })),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../lib/noteSummaries", () => ({ fetchNoteSummary: vi.fn() }));
vi.mock("../lib/regionRegistry", () => ({ loadRegionRegistry: vi.fn(async () => []) }));
vi.mock("../components/home/useNoteWaypoints", () => ({ useNoteWaypoints: () => [] }));
vi.mock("../lib/tauriListen", () => ({ listenMany: () => () => {} }));
vi.mock("../components/diagram/DiagramSection", () => ({
  DiagramSection: ({ section }: { section: { id: string } }) => <div data-testid="diagram-stub">{section.id}</div>,
}));
vi.mock("./MobileSheetEditor", () => ({
  MobileSheetEditor: ({ section }: { section: { id: string } }) => <div data-testid="sheet-stub">{section.id}</div>,
}));

import { loadRegionRegistry } from "../lib/regionRegistry";
import { MobileNote, type MobileNoteHandle } from "./MobileNote";
import { FAB_CLEARANCE_PX } from "./MobileNoteFab";

function note(sections: { id: string; name: string; body_md: string; kind?: "text" | "diagram" | "sheet" }[]) {
  return {
    note: {
      id: "note-1",
      folder_id: "f1",
      title: "T",
      year: 2026,
      month: 10,
      day: 7,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "",
      updated_at: "",
    },
    sections: sections.map((s, i) => ({ position: i, kind: "text", ...s })),
    sources: [],
    attachments: [],
  } as any;
}

/** TipTap 이 view.dom.editor 에 인스턴스를 단다 — 화면 밖에서 진짜 편집기를 잡는 길. */
const liveEditor = (): Editor => (document.querySelector(".ProseMirror") as any).editor;

let updateSectionBody: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  updateSectionBody = vi.fn(async () => {});
  useSettingsStore.setState({ aiEnabled: false, uiLang: "en", dateNudgeEnabled: false } as any);
  useAiStore.setState({ aiReachable: false, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
  usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  useNotesStore.setState({
    activeNote: note([{ id: "s1", name: "Overview", body_md: "hello world" }]),
    activeBodyEmpty: false,
    savedState: "saved",
    updateSectionBody,
  } as any);
});
afterEach(() => {
  vi.useRealTimers();
  useNotesStore.setState({ activeNote: null } as any);
});

const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const mount = (ref?: React.Ref<MobileNoteHandle>) =>
  render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);

describe("MobileNote — real Tiptap assembly smoke", () => {
  it("paints the section body into one live editor and serializes edits back through the 700ms debounce", async () => {
    const ref = createRef<MobileNoteHandle>();
    mount(ref);
    await settle();
    expect(liveEditor().getText()).toBe("hello world");
    expect(await ref.current!.flushAndMeasure()).toBe(11);
    expect(updateSectionBody).not.toHaveBeenCalled(); // unchanged body → no write

    act(() => {
      liveEditor().commands.insertContentAt(liveEditor().state.doc.content.size, " more");
    });
    expect(updateSectionBody).not.toHaveBeenCalled();
    await settle(800);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(updateSectionBody.mock.calls[0][0]).toBe("s1");
    expect(updateSectionBody.mock.calls[0][1]).toContain("more");
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("a non-canonical body (`* ` bullets save back as `- `) opened and flushed without an edit is not rewritten", async () => {
    // 2026-10-18 가짜 편집 — 원문 비교만 하던 flush 가 손대지 않은 섹션을 정규형으로 다시 썼다(unchangedSinceLoad).
    useNotesStore.setState({ activeNote: note([{ id: "s1", name: "Overview", body_md: "* one\n* two" }]) } as any);
    const ref = createRef<MobileNoteHandle>();
    mount(ref);
    await settle();
    await ref.current!.flushAndMeasure();
    await settle(800);
    expect(updateSectionBody).not.toHaveBeenCalled();

    act(() => {
      liveEditor().commands.insertContentAt(liveEditor().state.doc.content.size, "<p>three</p>");
    });
    await settle(800);
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(updateSectionBody.mock.calls[0][1]).toContain("three");
  });

  it("never writes an unsupported-format body back (read-only guard) and shows the hint", async () => {
    useNotesStore.setState({
      activeNote: note([{ id: "s1", name: "Overview", body_md: "<table><tr><td>x</td></tr></table>" }]),
    } as any);
    const ref = createRef<MobileNoteHandle>();
    mount(ref);
    await settle();
    expect(document.querySelector(".mobile-readonly-banner")).toBeTruthy();
    await ref.current!.flushAndMeasure();
    await settle(2000);
    expect(updateSectionBody).not.toHaveBeenCalled();
  });

  it("switching to a diagram section flushes the pending edit first, then shows the diagram instead of the editor", async () => {
    useNotesStore.setState({
      activeNote: note([
        { id: "s1", name: "Prose", body_md: "hello world" },
        { id: "s2", name: "Map", body_md: "{}", kind: "diagram" },
      ]),
    } as any);
    mount();
    await settle();
    // 마지막 섹션(관계도)이 기본으로 열린다 → 본문 섹션 탭으로 간다.
    expect(screen.getByTestId("diagram-stub").textContent).toBe("s2");
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-section-tab-s1"));
    });
    await settle();
    expect(screen.queryByTestId("diagram-stub")).toBeNull();
    const ed = liveEditor(); // 관계도가 뜨면 .ProseMirror DOM 이 사라지므로 인스턴스를 미리 잡아 둔다
    expect(ed.getText()).toBe("hello world");

    act(() => {
      liveEditor().commands.insertContentAt(liveEditor().state.doc.content.size, "!");
    });
    // 700ms 타이머가 돌기 전에 관계도로 전환 — flush 가 먼저 본문을 쓴다.
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-section-tab-s2"));
    });
    await settle();
    expect(updateSectionBody).toHaveBeenCalledWith("s1", expect.stringContaining("!"));
    expect(screen.getByTestId("diagram-stub").textContent).toBe("s2");
    expect(ed.isEditable).toBe(false); // 같은 인스턴스가 렌더를 넘어 산다 — 비워진 채 숨는다
    expect(ed.getText()).toBe("");
  });

  it("text section round trip (A edit → B → A) repaints A with the edit, not the stale store body", async () => {
    // 스토어 updateSectionBody 는 캐럿 보호로 activeNote.sections 를 일부러 안 고친다(함정 4) — 위 스텁도 같다.
    useNotesStore.setState({
      activeNote: note([
        { id: "s1", name: "One", body_md: "alpha" },
        { id: "s2", name: "Two", body_md: "beta" },
      ]),
    } as any);
    mount();
    await settle();
    expect(liveEditor().getText()).toBe("beta"); // 마지막 섹션이 기본
    act(() => {
      liveEditor().commands.insertContentAt(liveEditor().state.doc.content.size, " edited");
    });
    await settle(800);
    expect(updateSectionBody).toHaveBeenCalledWith("s2", expect.stringContaining("edited"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-section-tab-s1"));
    });
    await settle();
    expect(liveEditor().getText()).toBe("alpha");
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-section-tab-s2"));
    });
    await settle();
    expect(liveEditor().getText()).toContain("edited"); // 고치기 전엔 "beta" 만 — 낡은 스토어 본문이 칠해졌다
  });

  it("keeps hook order when activeNote goes null → note → null (early return sits below every hook)", async () => {
    useNotesStore.setState({ activeNote: null } as any);
    const { container } = mount();
    await settle();
    expect(container.querySelector(".mobile-note-header")).toBeNull();
    act(() => {
      useNotesStore.setState({ activeNote: note([{ id: "s1", name: "Overview", body_md: "hello" }]) } as any);
    });
    await settle();
    expect(container.querySelector(".mobile-note-header")).toBeTruthy();
    act(() => {
      useNotesStore.setState({ activeNote: null } as any);
    });
    await settle();
    expect(container.querySelector(".mobile-note-header")).toBeNull();
  });
});

// ───────────── 하단 독 · 떠 있는 마이크/＋ (오너 2026-10-07) — 진짜 Tiptap 으로만 보이는 것 ─────────────
// 가짜 에디터(MobileNote.test.tsx)는 렌더마다 새 인스턴스라 "선택만 옮겼는데 슬롯이 바뀐다"·"뷰 prop 이 렌더를 넘어 산다"를
// 못 본다. Tiptap v3 는 트랜잭션마다 다시 그리지 않으므로(shouldRerenderOnTransaction 기본 꺼짐) 슬롯 스스로의 구독이 필요하다.
describe("MobileNote — dock slot + FAB with a live Tiptap", () => {
  const slotKind = () => screen.getByTestId("mobile-dock-slot").getAttribute("data-slot");

  it("a pure selection move onto an inline image swaps the slot to the size steps, and off it swaps back", async () => {
    mount();
    await settle();
    expect(slotKind()).toBe("format");
    const ed = liveEditor();

    act(() => {
      ed.commands.insertContentAt(ed.state.doc.content.size, { type: "image", attrs: { src: "a.png" } });
    });
    let imagePos = -1;
    ed.state.doc.descendants((n, pos) => {
      if (n.type.name === "image") imagePos = pos;
    });
    expect(imagePos).toBeGreaterThanOrEqual(0);

    act(() => {
      ed.commands.setNodeSelection(imagePos);
    });
    expect(slotKind()).toBe("image");
    expect(screen.getByTestId("mobile-image-size-controls")).toBeTruthy();
    expect(screen.queryByLabelText("Checklist")).toBeNull();

    act(() => {
      ed.commands.setTextSelection(1);
    });
    expect(slotKind()).toBe("format");
    expect(screen.getByLabelText("Checklist")).toBeTruthy();
    expect(screen.queryByTestId("mobile-image-size-controls")).toBeNull();
  });

  it("bold's pressed state follows the caret without anything else re-rendering the screen", async () => {
    useNotesStore.setState({
      activeNote: note([{ id: "s1", name: "Overview", body_md: "plain **strong** plain" }]),
    } as any);
    mount();
    await settle();
    const ed = liveEditor();
    const bold = () => screen.getByLabelText("Bold").getAttribute("data-active");
    act(() => {
      ed.commands.setTextSelection(1);
    });
    expect(bold()).toBe("false");
    act(() => {
      ed.commands.setTextSelection(8); // inside "strong"
    });
    expect(bold()).toBe("true");
  });

  it("capture: an empty draft shows the presets in the dock; the FIRST typed character flips it to formatting — long before the 700ms autosave moves the store flag", async () => {
    useNotesStore.setState({
      activeNote: note([{ id: "s1", name: "Overview", body_md: "" }]),
      activeBodyEmpty: true,
    } as any);
    render(<MobileNote capture onBack={() => {}} onOpenNote={() => {}} />);
    await settle();
    expect(slotKind()).toBe("presets");
    expect(screen.getByTestId("mobile-preset-more")).toBeTruthy();

    // 진짜로 친다 — 스토어 플래그를 손으로 뒤집지 않는다. activeBodyEmpty 는 updateSectionBody(디바운스 뒤 flush)만 움직이고,
    // 연달아 치는 동안엔 키마다 700ms 타이머가 다시 걸려 flush 가 안 돈다. 슬롯은 살아 있는 문서를 봐야 한다.
    act(() => {
      liveEditor().commands.insertContentAt(1, "MY TYPED SENTENCE");
    });
    await settle(300); // 디바운스(700ms) 전
    expect(updateSectionBody).not.toHaveBeenCalled();
    expect(useNotesStore.getState().activeBodyEmpty).toBe(true); // 스토어는 여전히 "비었다" — 이게 사고의 전제
    expect(slotKind()).toBe("format");
    expect(screen.queryByTestId("mobile-preset-more")).toBeNull();
    expect(screen.queryByText("To-do list")).toBeNull(); // 눌릴 수 있는 프리셋 알약이 하나도 없다
    expect(screen.getByLabelText("Bold")).toBeTruthy();
  });

  it("capture: deleting everything brings the presets back", async () => {
    useNotesStore.setState({
      activeNote: note([{ id: "s1", name: "Overview", body_md: "" }]),
      activeBodyEmpty: true,
    } as any);
    render(<MobileNote capture onBack={() => {}} onOpenNote={() => {}} />);
    await settle();
    const ed = liveEditor();
    act(() => {
      ed.commands.insertContentAt(1, "MY TYPED SENTENCE");
    });
    expect(slotKind()).toBe("format");
    act(() => {
      ed.commands.clearContent(true);
    });
    expect(slotKind()).toBe("presets");
    expect(screen.getByTestId("mobile-preset-more")).toBeTruthy();
  });

  it("the caret keeps clear of the FAB: ProseMirror scrollThreshold + scrollMargin (bottom = the FAB footprint) survive Tiptap's per-render setOptions", async () => {
    mount();
    await settle();
    const ed = liveEditor();
    const margin = () => ed.view.someProp("scrollMargin");
    // 시작선(threshold)과 멈춤선(margin)은 한 쌍이다 — margin 만 있으면 FAB 띠 안의 캐럿은 스크롤이 시작도 안 된다
    // (스크롤 동작 자체는 useFabScrollMargin.test.tsx 가 진짜 prosemirror-view 로 본다).
    const threshold = () => ed.view.someProp("scrollThreshold");
    const MARGIN = { top: 5, right: 5, bottom: FAB_CLEARANCE_PX, left: 5 };
    const THRESHOLD = { top: 0, right: 0, bottom: FAB_CLEARANCE_PX, left: 0 };
    expect(margin()).toEqual(MARGIN);
    expect(threshold()).toEqual(THRESHOLD);

    // useEditor 가 렌더마다 부르는 것과 같다 — editorProps 의 키만 덮으므로 scrollMargin·scrollThreshold 는 그대로여야 한다.
    act(() => {
      ed.setOptions({ editorProps: { attributes: { spellcheck: "true" } } });
    });
    expect(margin()).toEqual(MARGIN);
    expect(threshold()).toEqual(THRESHOLD);
    // 화면이 다시 그려져도(저장 상태 변화) 그대로.
    act(() => {
      useNotesStore.setState({ savedState: "saving" } as any);
    });
    expect(margin()).toEqual(MARGIN);
    expect(threshold()).toEqual(THRESHOLD);
  });

  it("a note that opens on a diagram still has the margin when the user switches to the text section", async () => {
    useNotesStore.setState({
      activeNote: note([
        { id: "s1", name: "Prose", body_md: "hello world" },
        { id: "s2", name: "Map", body_md: "{}", kind: "diagram" },
      ]),
    } as any);
    mount();
    await settle();
    expect(screen.getByTestId("diagram-stub")).toBeTruthy();
    // 관계도 = 서식 없는 슬롯 — 스피드 다이얼 ＋ 하나뿐이고 떠 있는 FAB 는 없다. 열어 둔 채로 섹션을 옮기면 다이얼은 새로 시작한다.
    const slotEl = screen.getByTestId("mobile-dock-slot");
    expect(slotEl.childElementCount).toBe(1);
    expect(slotEl.contains(screen.getByTestId("mobile-fab-toggle"))).toBe(true);
    expect(screen.queryByTestId("mobile-note-fab")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    expect(screen.getByTestId("mobile-fab-toggle").getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-section-tab-s1"));
    });
    await settle();
    expect(screen.getByTestId("mobile-dock-slot").contains(screen.queryByTestId("mobile-fab-toggle"))).toBe(false); // 이제 떠 있는 FAB
    expect(screen.getByTestId("mobile-note-fab").contains(screen.getByTestId("mobile-fab-toggle"))).toBe(true);
    expect(screen.getByTestId("mobile-fab-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(liveEditor().view.someProp("scrollMargin")).toEqual({ top: 5, right: 5, bottom: FAB_CLEARANCE_PX, left: 5 });
    expect(liveEditor().view.someProp("scrollThreshold")).toEqual({ top: 0, right: 0, bottom: FAB_CLEARANCE_PX, left: 0 });
    expect(slotKind()).toBe("format");
  });

  it("the FAB ＋ speed dial (toggle + its three actions) is present beside a live editor and is not inside the scrolling body", async () => {
    const { container } = mount();
    await settle();
    const wrap = container.querySelector(".mobile-note-body-wrap") as HTMLElement;
    for (const id of ["mobile-fab-toggle", "mobile-fab-mic", "mobile-fab-photo", "mobile-fab-attach"]) {
      const btn = screen.getByTestId(id);
      expect(wrap.contains(btn)).toBe(false);
      expect(container.querySelector(".mobile-note-stage")!.contains(btn)).toBe(true);
    }
  });
});

// ───────────── IME 조합 중 독의 서식 버튼 (Gboard) — 진짜 Tiptap + 진짜 ProseMirror 조합 상태 ─────────────
// 독 루트(keepEditorFocus)가 mousedown 을 막으면 조합이 살아 있는 채로 명령이 트랜잭션을 꽂는다. 예전 툴바 줄은 막지 않아서
// 버튼으로 포커스가 넘어가 조합이 확정된 뒤 명령이 돌았다. 조합 중의 서식 눌림(☑·B·I)은 그 보장을 되살린다.
// jsdom 은 포커스 이동이 IME 조합을 끝내는지까지는 못 본다 — 여기서 보는 계약은 "그 눌림은 mousedown 이 막히지 않아 포커스가
// 갈 수 있다 + 클릭 명령은 그대로 돈다" 이다.
describe("MobileNote — dock formatting during an IME composition (live Tiptap)", () => {
  const stays = (el: Element) => fireEvent.mouseDown(el) === false; // true = 기본 동작이 막혔다(포커스 유지)

  function startComposition(ed: Editor) {
    act(() => {
      ed.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    });
    expect(ed.view.composing).toBe(true);
  }
  function endComposition(ed: Editor) {
    act(() => {
      ed.view.dom.dispatchEvent(new Event("compositionend", { bubbles: true }));
    });
    expect(ed.view.composing).toBe(false);
  }

  it("not composing: every formatting button keeps the editor focus (the keyboard stays up)", async () => {
    mount();
    await settle();
    expect(liveEditor().view.composing).toBe(false);
    expect(stays(screen.getByLabelText("Checklist"))).toBe(true);
    expect(stays(screen.getByLabelText("Bold"))).toBe(true);
    expect(stays(screen.getByLabelText("Italic"))).toBe(true);
  });

  it("composing + checklist: mousedown is NOT prevented (the editor may blur and commit the composition) and the click still makes the checklist", async () => {
    mount();
    await settle();
    const ed = liveEditor();
    startComposition(ed);

    const checklist = screen.getByLabelText("Checklist");
    expect(stays(checklist)).toBe(false);
    fireEvent.click(checklist);
    expect(ed.isActive("taskList")).toBe(true);

    endComposition(ed);
    await settle(50);
    expect(stays(screen.getByLabelText("Checklist"))).toBe(true); // 조합이 끝났으니 다시 포커스를 지킨다
  });

  it("composing + bold/italic with only a caret let go of the focus too (the stored-marks path was never exercised on a device), and the click still bolds", async () => {
    mount();
    await settle();
    const ed = liveEditor();
    act(() => {
      ed.commands.setTextSelection(3); // 캐럿만
    });
    startComposition(ed);
    expect(stays(screen.getByLabelText("Bold"))).toBe(false);
    expect(stays(screen.getByLabelText("Italic"))).toBe(false);
    fireEvent.click(screen.getByLabelText("Bold"));
    expect(ed.isActive("bold")).toBe(true);
  });

  it("composing + bold/italic over a selected range let go of the focus", async () => {
    mount();
    await settle();
    const ed = liveEditor();
    act(() => {
      ed.commands.setTextSelection({ from: 1, to: 6 });
    });
    startComposition(ed);
    expect(stays(screen.getByLabelText("Bold"))).toBe(false);
    expect(stays(screen.getByLabelText("Italic"))).toBe(false);
  });
});

// ───────────── 날짜·지역 말풍선 (오너 2026-10-07) — 진짜 Tiptap + 진짜 감지 훅 + 진짜 stage/스크롤 영역 ─────────────
// 말풍선은 .mobile-note-stage 의 **자식**이라 자식의 첫 레이아웃 이펙트가 부모 ref 연결보다 먼저 돈다 — ref 객체로 받으면
// 영영 "잴 수 없음" 이다. 콜백 ref → 상태 배선이 MobileNote/MobileNoteBody 에서 실제로 이어졌는지는 여기서만 보인다.
// (jsdom 에는 레이아웃이 없다 — 좌표와 사각형은 우리가 정한다.)
describe("MobileNote — date/region bubble above the sentence (live Tiptap)", () => {
  const prevRegionNudge = useSettingsStore.getState().regionNudgeEnabled;
  afterEach(() => {
    vi.restoreAllMocks(); // coordsAtPos / getBoundingClientRect 스파이 — 실패해도 새지 않게
    vi.mocked(loadRegionRegistry).mockResolvedValue([]);
    useSettingsStore.setState({ regionNudgeEnabled: prevRegionNudge } as any);
  });

  it("a detected region shows up as a bubble inside the stage, measured above the sentence's first line", async () => {
    vi.mocked(loadRegionRegistry).mockResolvedValue([{ name: "경주", lat: 35.8, lng: 129.2 }]);
    useSettingsStore.setState({ regionNudgeEnabled: true, regionNudgeStrict: false } as any);
    const { container } = mount();
    await settle();
    const ed = liveEditor();
    vi.spyOn(ed.view, "coordsAtPos").mockImplementation((() => ({ left: 16, right: 26, top: 300, bottom: 320 })) as never);
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("mobile-note-stage") || this.classList.contains("mobile-note-body-wrap")) return rect(0, 100, 390, 500);
      if (this.classList.contains("mobile-nudge-bubble")) return rect(0, 0, 200, 38);
      return rect(0, 0, 0, 0);
    });

    act(() => {
      ed.commands.insertContentAt(ed.state.doc.content.size, "<p>주말에 경주 여행</p>");
      ed.commands.setTextSelection(ed.state.doc.content.size - 1);
    });
    await settle(800);

    const bubble = screen.getByTestId("mobile-nudge-bubble");
    expect(container.querySelector(".mobile-note-stage")!.contains(bubble)).toBe(true);
    expect(ed.view.dom.contains(bubble)).toBe(false); // 문서 밖 오버레이
    expect(bubble.textContent).toContain("경주");
    expect(bubble.getAttribute("data-placement")).toBe("above");
    expect((bubble as HTMLElement).style.transform).toBe("translate(16px, 154px)"); // 300 - 8 - 38 - stage.top(100)
    // 링크·#태그 칩 줄은 없다 — 지역은 말풍선에만
    expect(screen.queryByTestId("mobile-nudge-chips")).toBeNull();
  });
});

// D2(오너 2026-10-10): 화면에 들어올 때 키보드를 저절로 올리지 않는다(입력·노트 둘 다). 쓰려면 본문을 탭하고, 글 아래 빈 자리
// 탭(ProseMirror 밖 = 스크롤 상자)도 끝으로 포커스한다. 첨부 목록 위의 탭은 에디터를 건드리지 않는다.
describe("MobileNote — no autofocus; tapping the body area focuses the editor (D2)", () => {
  it("capture entry does not focus the editor, even after the old 50ms insurance window", async () => {
    render(<MobileNote capture onBack={() => {}} onOpenNote={() => {}} />);
    await settle(200);
    expect(liveEditor().isFocused).toBe(false);
    expect(document.activeElement?.classList.contains("ProseMirror")).toBe(false);
  });

  it("a tap on the empty space below the text focuses the editor with the caret at the end", async () => {
    const { container } = mount();
    await settle();
    const ed = liveEditor();
    expect(ed.isFocused).toBe(false);
    fireEvent.click(container.querySelector(".mobile-note-body-wrap")!);
    await settle(50);
    expect(ed.view.hasFocus()).toBe(true);
    expect(ed.state.selection.from).toBe(ed.state.doc.content.size - 1); // end of "hello world"
  });

  it("a tap on the attachment area does not grab the editor", async () => {
    const n = note([{ id: "s1", name: "Overview", body_md: "hello world" }]);
    n.attachments = [{ id: "a1", name: "memo.pdf", kind: "doc", rel_path: "a1.pdf", url: null, size_bytes: 10, position: 0 }];
    useNotesStore.setState({ activeNote: n } as any);
    const { container } = mount();
    await settle();
    const attach = container.querySelector(".mobile-attach-section");
    expect(attach).not.toBeNull();
    fireEvent.click(attach!);
    await settle(50);
    expect(liveEditor().view.hasFocus()).toBe(false);
  });
});
