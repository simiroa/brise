import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import "../components/diagram/FlowCanvas";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";

/**
 * Mobile structured-authoring integration. Unlike MobileNote.test.tsx, this file does NOT stub
 * DiagramSection — the whole point is that the mobile screen mounts the REAL desktop component and
 * therefore gets the real diagramModel mutations, tap-to-select and 되돌리기 stack with no
 * mobile-side copy of any of it. Nothing about the renderer itself is faked any more: since the
 * 2026-09-04 JSON IR rebuild (commit 88195857) FlowCanvas (React Flow) is the only diagram renderer,
 * there is no separate SVG-render step to fake the way `mermaidRender` used to be faked here before
 * mermaidRender.ts was deleted — `ResizeObserver` above is the one DOM polyfill React Flow needs in
 * jsdom, and the rest mounts for real.
 *
 * What this file owns is the SEAM: the mobile screen renders those controls, they are reachable,
 * and their writes land in the same updateSectionBody path prose uses. The mutations themselves are
 * the concurrent agent's, tested in src/components/diagram/**.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const setContentMock = vi.fn();
function makeFakeEditor() {
  return {
    isDestroyed: false,
    isFocused: false,
    isEmpty: true,
    isActive: () => false,
    getHTML: () => "",
    getText: () => ({ trim: () => ({ length: 0 }) }),
    commands: { setContent: setContentMock, clearContent: vi.fn(), focus: vi.fn() },
    setEditable: vi.fn(),
    chain: () => ({
      focus: () => ({
        toggleTaskList: () => ({ run: vi.fn() }),
        toggleBold: () => ({ run: vi.fn() }),
        toggleItalic: () => ({ run: vi.fn() }),
      }),
    }),
    view: { dom: { focus: vi.fn() } },
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}
vi.mock("@tiptap/react", () => ({
  useEditor: () => makeFakeEditor(),
  EditorContent: () => <div data-testid="editor-content" />,
  BubbleMenu: ({ children }: any) => <div data-testid="bubble-menu">{children}</div>,
}));
vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: any) => <div data-testid="bubble-menu">{children}</div>,
}));
vi.mock("@tiptap/starter-kit", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-task-list", () => ({ default: {} }));
vi.mock("@tiptap/extension-task-item", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-placeholder", () => ({ default: { configure: () => ({}) } }));
vi.mock("../lib/invoke", () => ({
  call: vi.fn(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {})),
  callSilent: vi.fn(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {})),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));

// 입력 감지 훅(56d22c9b)은 위의 가짜 useEditor 가 렌더마다 새 에디터를 돌려줘 매 렌더 다시 구독한다 —
// 진짜 훅을 두면 무한 재렌더로 워커가 OOM(4GB)으로 죽는다. 이 파일은 관계도 작성 흐름만 보므로 스텁한다
// (MobileNote.test.tsx 와 같은 스텁).
const nudgeStub = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dismiss: () => {} }));
vi.mock("./useMobileTypingNudges", () => ({
  NUDGE_DEBOUNCE_MS: 700,
  useMobileTypingNudges: () => ({ state: nudgeStub.state, dismiss: nudgeStub.dismiss }),
}));
import { MobileNote } from "./MobileNote";

const SOURCE = JSON.stringify({
  v: 1,
  nodes: [
    { id: "n1", label: "세종", shape: "rect" },
    { id: "n2", label: "장영실", shape: "rect" },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", label: "신하", line: "solid", arrow: "end" },
  ],
});

function diagramNote(bodyMd: string) {
  return {
    note: {
      id: "note-1",
      folder_id: "f1",
      title: "T",
      year: 2026,
      month: 7,
      day: 30,
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
    sections: [{ id: "diag_sec", name: "관계도", body_md: bodyMd, position: 0, kind: "diagram" }],
    sources: [],
    attachments: [],
  } as any;
}

describe("MobileNote — structured diagram authoring reuses the desktop stack (no mobile fork)", () => {
  let updateSectionBody: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    setContentMock.mockClear();
    updateSectionBody = vi.fn(async () => {});
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    useNotesStore.setState({ activeNote: diagramNote(SOURCE), activeBodyEmpty: false, updateSectionBody } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("mounts the real authoring controls inside the mobile touch host (the CSS hook that sizes them and turns the selection row into a bottom sheet)", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();

    const controls = screen.getByTestId("diagram-controls");
    expect(controls).toBeTruthy();
    // Missing wrapper = desktop-sized 4px-padding controls on a phone, silently.
    expect(controls.closest(".mobile-diagram-host")).toBeTruthy();
    // The picture's own fit/zoom row is inside the same touch host (mobile.css sizes it to 48px).
    expect(screen.queryByTestId("diagram-view-tools")).toBeNull();
    // The forms the owner asked for, not a raw source (JSON) box — quiet buttons until one is opened.
    fireEvent.click(within(controls).getByTestId("diagram-add-node-toggle"));
    expect(within(controls).getByTestId("diagram-node-label")).toBeTruthy();
    fireEvent.click(within(controls).getByTestId("diagram-add-node-close"));
    fireEvent.click(within(controls).getByTestId("diagram-add-edge-toggle"));
    expect(within(controls).getByTestId("diagram-edge-from")).toBeTruthy();
    expect(within(controls).getByTestId("diagram-edge-to")).toBeTruthy();
    // Both endpoint pickers are populated FROM THE MODEL, so no id is ever typed on a phone.
    // In-app listbox, not a native <select> — its rows are buttons in a portaled `.overlay`.
    fireEvent.click(within(controls).getByTestId("diagram-edge-from"));
    expect(Array.from(screen.getByTestId("diagram-edge-from-list").querySelectorAll("button")).map((o) => o.textContent))
      .toEqual(["From", "세종", "장영실"]);
  });

  it("캔버스 동사 \"텍스트로 추가\"가 폰에도 있다 — 데스크톱 툴바와 같은 canvasVerbs 목록, 폼은 모달이 아니라 아래 행", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();
    const controls = screen.getByTestId("diagram-controls");
    fireEvent.click(within(controls).getByTestId("diagram-add-text"));
    expect(within(controls).getByTestId("diagram-add-text-form")).toBeTruthy();
    fireEvent.click(within(controls).getByTestId("diagram-add-text-close"));
    expect(within(controls).queryByTestId("diagram-add-text-form")).toBeNull();
  });

  it("인물 추가 mutates through diagramModel and saves via the same updateSectionBody path prose uses", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();
    const controls = screen.getByTestId("diagram-controls");

    fireEvent.click(within(controls).getByTestId("diagram-add-node-toggle"));
    fireEvent.change(within(controls).getByTestId("diagram-node-label"), { target: { value: "이순신" } });
    fireEvent.click(within(controls).getByTestId("diagram-add-node"));
    await flush(700); // the 700ms save debounce, unchanged on mobile

    expect(updateSectionBody).toHaveBeenCalled();
    const [id, body] = updateSectionBody.mock.calls[updateSectionBody.mock.calls.length - 1];
    expect(id).toBe("diag_sec");
    // A fresh id from nextNodeId, existing ids untouched (the join key invariant).
    expect(body).toContain('"label": "이순신"');
    expect(body).toContain('"label": "세종"');
  });

  it("tapping a node in the rendered canvas opens its action row — the content mobile.css promotes into a bottom sheet", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();
    await act(async () => {
      await Promise.resolve();
    });
    await flush();

    expect(screen.queryByTestId("diagram-node-actions")).toBeNull();
    const labelEl = screen.getByText("세종");
    const nodeEl = labelEl.closest(".diagram-flow-node");
    expect(nodeEl).toBeTruthy();
    fireEvent.click(nodeEl!);
    await flush();

    const actions = screen.getByTestId("diagram-node-actions");
    expect(actions).toBeTruthy();
    expect(actions.closest(".mobile-diagram-host")).toBeTruthy(); // scoped by the sheet CSS
    // The row renders the shared nodeVerbs list (diagram/verbs.tsx) through VerbButtons. Since
    // 2026-10-19 (GRILL R6) it no longer carries 배지·구획·여기서 연결 — the same items the desktop
    // bubble dropped; the phone connects through the 관계 추가 form instead. The rename is a
    // persistent field here (the desktop renames by double-clicking the box), both actions.rename.
    expect(screen.getByTestId("diagram-rename")).toBeTruthy();
    expect(Array.from(actions.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"))).toEqual([
      "diagram-shape",
      "diagram-flag",
      "diagram-link-note",
      "diagram-delete-node",
    ]);
    // …and the phone never inherits the desktop toolbar/bubbles.
    expect(screen.queryByTestId("diagram-view-tools")).toBeNull();
  });

  it("the 도형 menu opens as a touch listbox on the phone too (never an OS-drawn native select)", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();
    await act(async () => {
      await Promise.resolve();
    });
    await flush();
    const labelEl = screen.getByText("세종");
    const nodeEl = labelEl.closest(".diagram-flow-node");
    fireEvent.click(nodeEl!);
    await flush();

    const shape = screen.getByTestId("diagram-shape");
    expect(shape.tagName).toBe("BUTTON"); // a native <select> renders a white OS popup on the dark app
    fireEvent.click(shape);
    const list = screen.getByTestId("diagram-shape-list");
    // Portaled to <body> — which is also why mobile.css sizes `.diagram-bubble-menu .menu-row` to
    // 48px from a `hover: none` media query instead of from inside .mobile-diagram-host.
    expect(list.parentElement).toBe(document.body);
    expect(list.className).toContain("overlay");
    fireEvent.click(list.querySelector('[data-value="diamond"]')!);
    await flush(700);
    const [, body] = updateSectionBody.mock.calls[updateSectionBody.mock.calls.length - 1];
    expect(body).toContain('"shape": "diamond"');
  });

  it("되돌리기 is the same snapshot stack desktop uses — one press undoes the last structured edit", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();
    const controls = screen.getByTestId("diagram-controls");
    const undoBtn = () => within(controls).getByTestId("diagram-undo") as HTMLButtonElement;
    expect(undoBtn().disabled).toBe(true);

    fireEvent.click(within(controls).getByTestId("diagram-add-node-toggle"));
    fireEvent.change(within(controls).getByTestId("diagram-node-label"), { target: { value: "이순신" } });
    fireEvent.click(within(controls).getByTestId("diagram-add-node"));
    await flush(700);
    expect(undoBtn().disabled).toBe(false);

    fireEvent.click(undoBtn());
    await flush(700);
    const [, body] = updateSectionBody.mock.calls[updateSectionBody.mock.calls.length - 1];
    expect(body).toBe(SOURCE);
  });

  it("a non-flowchart (sequenceDiagram) offers the source-edit fallback instead of dead structured controls", async () => {
    useNotesStore.setState({
      activeNote: diagramNote("sequenceDiagram\n  participant p1 as A\n  p1->>p1: x"),
      activeBodyEmpty: false,
      updateSectionBody,
    } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await flush();

    expect(screen.queryByTestId("diagram-add-node-toggle")).toBeNull();
    expect(screen.queryByTestId("diagram-add-edge-toggle")).toBeNull();
    expect(screen.getAllByTestId("diagram-edit-source").length).toBeGreaterThan(0); // 소스 편집은 계속 가능
  });
});
