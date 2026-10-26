import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";

vi.mock("../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));

const PRESETS = [
  { id: "list", name: "Turn into a list", prompt: "p1", kind: "text", isBuiltin: true, hidden: false },
  { id: "organize", name: "Clean up content", prompt: "p2", kind: "text", isBuiltin: true, hidden: false },
  { id: "summarize", name: "Summarize", prompt: "p3", kind: "text", isBuiltin: true, hidden: false },
  { id: "metadata", name: "Auto-fill metadata", prompt: "p4", kind: "metadata", isBuiltin: true, hidden: false },
];

const loadMock = vi.fn().mockResolvedValue(undefined);
const runAiActionMock = vi.fn();
let presetsState = { list: PRESETS, loaded: true, load: loadMock };
vi.mock("../stores/aiPresets", () => ({
  useAiPresetsStore: (selector: (s: typeof presetsState) => unknown) => selector(presetsState),
  // Menus use menuActionPresets (excludes agent_*), not visiblePresets.
  menuActionPresets: (list: typeof PRESETS) =>
    list.filter((p) => !p.hidden && !String(p.id).startsWith("agent_")),
}));
vi.mock("../stores/runAiAction", () => ({
  runAiAction: (...args: unknown[]) => runAiActionMock(...args),
}));
vi.mock("../stores/aiPrompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/aiPrompts")>();
  return {
    ...actual,
    // Same id-based test the real store exports (a 'diagram_edit' KIND would be rejected by the
    // Rust settings allowlist, so the edit action is a kind:"diagram" preset keyed by id).
    isDiagramEditPreset: (p: { id: string; kind: string }) => p.kind === "diagram" && p.id === "diagram_edit",
  };
});

import { MobileAiSheet } from "./MobileAiSheet";
import { useNotesStore } from "../stores/notes";

beforeEach(() => {
  loadMock.mockClear();
  runAiActionMock.mockReset();
  presetsState = { list: PRESETS, loaded: true, load: loadMock };
  useSettingsStore.setState({ aiEnabled: true } as any);
  useAiStore.setState({ aiReachable: true } as any);
  useNotesStore.setState({
    activeNote: { note: { id: "note-mobile" }, sections: [] },
  } as any);
});

function baseProps(overrides: Partial<Parameters<typeof MobileAiSheet>[0]> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    getActiveSection: () => ({ id: "s1", body_md: "some body text" }),
    insertSection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("MobileAiSheet — disabled / closed states", () => {
  it("shows the muted hint instead of action rows when AI is off / unreachable", () => {
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileAiSheet {...baseProps()} />);
    expect(screen.getByText("Enable AI from desktop Settings.")).toBeTruthy();
    expect(screen.queryByText("Summarize")).toBeNull();
  });

  it("renders nothing (no dialog) when closed", () => {
    render(<MobileAiSheet {...baseProps({ open: false })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("MobileAiSheet — preset list from the shared store", () => {
  it("loads presets on open", () => {
    presetsState = { ...presetsState, loaded: false };
    render(<MobileAiSheet {...baseProps()} />);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("shows every visible preset's name once loaded", () => {
    render(<MobileAiSheet {...baseProps()} />);
    expect(screen.getByText("Turn into a list")).toBeTruthy();
    expect(screen.getByText("Clean up content")).toBeTruthy();
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("Auto-fill metadata")).toBeTruthy();
  });

  it("a hidden preset does not render", () => {
    presetsState = { ...presetsState, list: PRESETS.map((p) => (p.id === "list" ? { ...p, hidden: true } : p)) };
    render(<MobileAiSheet {...baseProps()} />);
    expect(screen.queryByText("Turn into a list")).toBeNull();
  });

  it("`only` restricts which preset ids render (post-save's summarize/organize subset)", () => {
    render(<MobileAiSheet {...baseProps({ only: ["summarize", "organize"] })} />);
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("Clean up content")).toBeTruthy();
    expect(screen.queryByText("Turn into a list")).toBeNull();
    expect(screen.queryByText("Auto-fill metadata")).toBeNull();
  });
});

describe("MobileAiSheet — running a preset", () => {
  it("runs the tapped preset via runAiAction with an explicit ctx (never a direct ai-store call), closing the sheet on success", async () => {
    runAiActionMock.mockResolvedValue(true);
    const insertSection = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<MobileAiSheet {...baseProps({ insertSection, onClose })} />);

    fireEvent.click(screen.getByText("Summarize"));

    await waitFor(() =>
      expect(runAiActionMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "summarize" }),
        expect.objectContaining({
          contextText: "some body text",
          insertSection,
          targetNoteId: "note-mobile",
        }),
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("the metadata preset also runs through runAiAction — no separate field-preview UI (organizeCurrentNote applies directly)", async () => {
    runAiActionMock.mockResolvedValue(true);
    const onClose = vi.fn();
    render(<MobileAiSheet {...baseProps({ onClose })} />);

    fireEvent.click(screen.getByText("Auto-fill metadata"));

    await waitFor(() =>
      expect(runAiActionMock).toHaveBeenCalledWith(expect.objectContaining({ id: "metadata" }), expect.anything())
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a false result (empty/failed, already toasted inside runAiAction) leaves the sheet open", async () => {
    runAiActionMock.mockResolvedValue(false);
    const onClose = vi.fn();
    render(<MobileAiSheet {...baseProps({ onClose })} />);

    fireEvent.click(screen.getByText("Summarize"));
    await waitFor(() => expect(runAiActionMock).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("disables every action row while one is pending", async () => {
    let resolveRun: (v: boolean) => void = () => {};
    runAiActionMock.mockReturnValue(new Promise<boolean>((r) => (resolveRun = r)));
    render(<MobileAiSheet {...baseProps()} />);

    fireEvent.click(screen.getByText("Summarize"));
    await waitFor(() => expect((screen.getByText("Turn into a list") as HTMLButtonElement).disabled).toBe(true));

    resolveRun(true);
  });
});

describe("MobileAiSheet — 관계도 수정하기 (AI edit of the OPEN diagram, owner item ⑤)", () => {
  const EDIT_PRESET = { id: "diagram_edit", name: "Edit this diagram", prompt: "rules", kind: "diagram", isBuiltin: true, hidden: false };
  const SOURCE = 'flowchart TD\n  n1["세종"] --> n2["장영실"]\n%% brise:link n1=note-abc';

  function diagramProps(overrides: Record<string, unknown> = {}) {
    return baseProps({
      getActiveSection: () => ({ id: "s1", body_md: SOURCE }),
      activeSectionKind: "diagram" as const,
      replaceSection: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }

  beforeEach(() => {
    presetsState = { ...presetsState, list: [...PRESETS, EDIT_PRESET] };
  });

  it("is not offered when the open section is prose (it would only ever notice 'open a diagram first')", () => {
    render(<MobileAiSheet {...baseProps()} />);
    expect(screen.queryByText("Edit this diagram")).toBeNull();
    expect(screen.getByText("Summarize")).toBeTruthy(); // the rest of the list is untouched
  });

  it("is offered when a diagram section is open, and expands into an instruction box instead of firing immediately", () => {
    render(<MobileAiSheet {...diagramProps()} />);
    const row = screen.getByText("Edit this diagram");
    expect(screen.queryByPlaceholderText(/What should change/)).toBeNull();
    fireEvent.click(row);
    expect(screen.getByPlaceholderText(/What should change/)).toBeTruthy();
    expect(runAiActionMock).not.toHaveBeenCalled(); // tapping the row opens the box, never runs blind
  });

  it("passes the CURRENT source + typed instruction + replaceSection into runAiAction (edit, not insert)", async () => {
    runAiActionMock.mockResolvedValue(true);
    const replaceSection = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<MobileAiSheet {...diagramProps({ replaceSection, onClose })} />);

    fireEvent.click(screen.getByText("Edit this diagram"));
    fireEvent.change(screen.getByPlaceholderText(/What should change/), {
      target: { value: "아무개 추가하고 세종과 연결해줘" },
    });
    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => expect(runAiActionMock).toHaveBeenCalled());
    const [preset, ctx] = runAiActionMock.mock.calls[0] as [{ id: string }, { diagram?: Record<string, unknown> }];
    expect(preset.id).toBe("diagram_edit");
    // K5(2026-09-06) — sectionId/getLive now ride along so applyIfFresh can re-read the live
    // source instead of comparing the injected snapshot against itself.
    expect(ctx.diagram).toEqual({
      sectionId: "s1",
      source: SOURCE,
      instruction: "아무개 추가하고 세종과 연결해줘",
      replaceSection,
      getLive: expect.any(Function),
    });
    expect((ctx.diagram as { getLive: () => unknown }).getLive()).toEqual({ sectionId: "s1", source: SOURCE });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("the Apply button stays disabled until an instruction is typed", () => {
    render(<MobileAiSheet {...diagramProps()} />);
    fireEvent.click(screen.getByText("Edit this diagram"));
    expect((screen.getByText("Apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/What should change/), { target: { value: "좌우로 바꿔줘" } });
    expect((screen.getByText("Apply") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Enter submits, but not mid-IME-composition (Korean typing)", async () => {
    runAiActionMock.mockResolvedValue(true);
    render(<MobileAiSheet {...diagramProps()} />);
    fireEvent.click(screen.getByText("Edit this diagram"));
    const input = screen.getByPlaceholderText(/What should change/);
    fireEvent.change(input, { target: { value: "순서를 좌우로 바꿔줘" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(runAiActionMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runAiActionMock).toHaveBeenCalledTimes(1));
  });

  it("other presets still run with no diagram ctx even while a diagram is open", async () => {
    runAiActionMock.mockResolvedValue(true);
    render(<MobileAiSheet {...diagramProps()} />);
    fireEvent.click(screen.getByText("Summarize"));
    await waitFor(() => expect(runAiActionMock).toHaveBeenCalled());
    const [, ctx] = runAiActionMock.mock.calls[0] as [unknown, { diagram?: unknown }];
    expect(ctx.diagram).toBeUndefined();
  });
});
