import { createRef, useState } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { t } from "../i18n/t";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";

// src/components/diagram/DiagramSection (concurrent agent, NOT owned by this pass — never edit it)
// does real diagram rendering via a lazy `import('./FlowCanvas')` (React Flow; DiagramSection did a
// dynamic `import('mermaid')` before the 2026-09-04 JSON IR rebuild deleted that dependency); that's
// its own contract, already its own concern to test. What THIS file is responsible for is
// MobileNote's WIRING: does it render the diagram component (not the Tiptap editor) for a
// kind:'diagram' section, with the right section prop, and does that component's edit path reach
// the same updateSectionBody(id, body_md) store action prose uses. This fake reproduces just that
// shape (tap -> textarea -> onChange -> save) without pulling the real, heavier renderer into this
// test file.
vi.mock("../components/diagram/DiagramSection", () => ({
  DiagramSection: ({ section }: { section: { id: string; body_md: string } }) => {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(section.body_md);
    if (!editing) {
      return (
        <pre data-testid="diagram-source" onClick={() => setEditing(true)}>
          {section.body_md}
        </pre>
      );
    }
    return (
      <textarea
        data-testid="diagram-source-textarea"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          void useNotesStore.getState().updateSectionBody(section.id, e.target.value);
        }}
      />
    );
  },
}));

// MobileNote mounts a real Tiptap editor in production; MobileApp.test.tsx documents why that's
// slow/unnecessary for flow tests and stubs the whole component instead. This file specifically
// targets the apply->repaint seam (advisor review 2026-07-30: applyCapturePreset must not depend
// on the note-load effect's early-return to get preset/AI content on screen — that path can race
// ensureMaterialized and, for AI prose containing e.g. a markdown link, strand the just-written
// body behind a false "unsupported formatting" read-only wall). A minimal fake editor exercises
// that exact call path without paying for a real ProseMirror view.
const setContentMock = vi.fn();
const setEditableMock = vi.fn();
const updateAttributesMock = vi.fn();
const insertContentMock = vi.fn();
const insertContentAtMock = vi.fn();
let activeImageMock = false;
let editorFocusedMock = false;
// 진짜 Tiptap 의 `editor.isEmpty` — 독 슬롯·프리셋 칠하기 길목이 "살아 있는 문서가 비었나"를 여기서 읽는다. 기본 = 빈 입력 화면.
let editorEmptyMock = true;
afterEach(() => {
  editorEmptyMock = true; // 한 테스트의 "글을 쳤다"가 다음 테스트의 빈 입력 화면으로 새지 않게
});
let fakeMarkdown = "";
function makeFakeEditor() {
  return {
    getMarkdown: () => fakeMarkdown,
    isDestroyed: false,
    get isFocused() {
      return editorFocusedMock;
    },
    get isEmpty() {
      return editorEmptyMock;
    },
    state: { doc: { content: { size: 42 } } },
    isActive: (name?: string) => (name === "image" ? activeImageMock : false),
    getAttributes: (name?: string) => (name === "image" ? { width: "40%" } : {}),
    getHTML: () => "",
    getText: () => ({ trim: () => ({ length: 0 }) }),
    commands: { setContent: setContentMock, clearContent: vi.fn(), focus: vi.fn(), insertContentAt: insertContentAtMock },
    setEditable: setEditableMock,
    chain: () => ({
      focus: () => ({
        toggleTaskList: () => ({ run: vi.fn() }),
        toggleBold: () => ({ run: vi.fn() }),
        toggleItalic: () => ({ run: vi.fn() }),
        updateAttributes: (name: string, attrs: any) => {
          updateAttributesMock(name, attrs);
          return { run: vi.fn() };
        },
        insertContent: (text: string) => {
          insertContentMock(text);
          return { run: vi.fn() };
        },
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
vi.mock("./MobileSheetEditor", () => ({
  MobileSheetEditor: ({ section }: { section: { id: string } }) => <div data-testid="sheet-editor">{section.id}</div>,
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

// Wiki-link tap navigation goes through fetchNoteSummary as its missing-note guard (same as
// desktop's EditorPanel.tsx / DiagramSection.tsx). The file-level lib/invoke mock above answers
// `{}` for any command other than workspace_status_list, which would resolve every id as missing —
// mock this module directly instead so each test controls the summary result.
vi.mock("../lib/noteSummaries", () => ({ fetchNoteSummary: vi.fn() }));

// S2 입력 — 녹음기(IndexedDB/MediaRecorder)·업로드·위치·SSE·토스트는 경계에서 대체한다. 이 파일이 보는 것은
// MobileNote 의 배선: 업로드 메타, 모드별 전사/삽입, 칩, 위치 모드.
vi.mock("./mobileApi", async (orig) => ({ ...(await orig<typeof import("./mobileApi")>()), uploadAttachment: vi.fn() }));
let recorderProps: any = null;
vi.mock("./MobileVoiceRecorder", () => ({
  MobileVoiceRecorder: (p: any) => {
    recorderProps = p;
    return p.open ? <div data-testid="fake-recorder" /> : null;
  },
}));
vi.mock("./useCurrentLocationApply", () => ({
  isLocationDenied: vi.fn(() => false),
  resolveCurrentLocation: vi.fn(),
}));
let listenSpecs: Array<readonly [string, (e: any) => void]> = [];
vi.mock("../lib/tauriListen", () => ({
  listenMany: (specs: any) => {
    listenSpecs = specs;
    return () => {};
  },
}));
vi.mock("../lib/undo", () => ({ showToastOnly: vi.fn(), showUndoToast: vi.fn() }));
// 입력 감지(날짜·지역·링크·#태그) — 감지 훅은 자기 테스트(useMobileTypingNudges.test.tsx)가 진짜 에디터로 본다.
// 여기서는 MobileNote 의 배선만: 감지 결과 → 칩 → 적용(IPC·마크·되돌리기).
const nudgeH = vi.hoisted(() => ({
  state: {} as any,
  dismiss: vi.fn(),
  applyDateMark: vi.fn(() => true),
  stripDateMark: vi.fn(),
  replaceTagToken: vi.fn(() => true),
  importLinks: vi.fn(async () => []),
}));
vi.mock("./useMobileTypingNudges", () => ({
  NUDGE_DEBOUNCE_MS: 700,
  useMobileTypingNudges: () => ({ state: nudgeH.state, dismiss: nudgeH.dismiss }),
}));
vi.mock("./mobileNudgeApply", () => ({
  applyDateMark: nudgeH.applyDateMark,
  stripDateMark: nudgeH.stripDateMark,
  replaceTagToken: nudgeH.replaceTagToken,
}));
vi.mock("../lib/linkImport", () => ({ importLinksToSections: nudgeH.importLinks }));

// Real MobileNote import AFTER the mocks above so its own `import { useEditor } from
// "@tiptap/react"` etc. resolve to the fakes.
import { MobileNote, type MobileNoteHandle } from "./MobileNote";
import { MobileAiResultSheet } from "./MobileAiResultSheet";
import { call as callFromInvoke, emitNotice as emitNoticeMock } from "../lib/invoke";
import { fetchNoteSummary as fetchNoteSummaryMock } from "../lib/noteSummaries";
import { callSilent as callSilentMock } from "../lib/invoke";
import { uploadAttachment as uploadAttachmentMock } from "./mobileApi";
import { resolveCurrentLocation as resolveLocationMock, isLocationDenied as isDeniedMock } from "./useCurrentLocationApply";
import { showToastOnly as showToastMock } from "../lib/undo";
import { setLocMode } from "./mobilePrefs";
import { parseDiagram } from "../components/diagram/diagramModel";
import { listStashes, putStash, stashesForNote } from "./unsavedStash";

function draftActiveNote(sections: { id: string; body_md: string; kind?: string }[] = [{ id: "draft_sec", body_md: "" }]) {
  return {
    note: {
      id: "__draft__",
      folder_id: "f1",
      title: "Untitled Note",
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
    sections: sections.map((s, i) => ({ ...s, name: "Overview", position: i })),
    sources: [],
    attachments: [],
  } as any;
}

describe("MobileNote — capture preset apply -> editor repaint", () => {
  beforeEach(() => {
    editorEmptyMock = true;
    setContentMock.mockClear();
    setEditableMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({
      aiReachable: true,
      ensureAiReachable: vi.fn().mockResolvedValue(undefined),
      generateFromPrompt: vi.fn().mockResolvedValue("Some generated body with a [link](https://x)"),
      promptPending: false,
    } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  it("todo preset: applyPreset resolving null (draft branch) still repaints the editor via the fallback section id, not the effect", async () => {
    const activeNote = draftActiveNote();
    const applyPreset = vi.fn(async (bodyMd: string) => {
      // Mirrors notes.ts::applyPreset's real draft-branch shape: patches the section body in
      // place and swaps activeNote's reference, returns null.
      useNotesStore.setState({
        activeNote: draftActiveNote([{ id: "draft_sec", body_md: bodyMd }]),
        activeBodyEmpty: false,
      } as any);
      return null;
    });
    useNotesStore.setState({ activeNote, activeBodyEmpty: true, applyPreset } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);

    fireEvent.click(await screen.findByText("To-do list"));

    await waitFor(() => expect(applyPreset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(setContentMock).toHaveBeenCalled());
    const [content] = setContentMock.mock.calls[setContentMock.mock.calls.length - 1];
    expect(content).toContain("taskList");
    // Never flipped read-only — the checklist HTML is fully supported.
    expect(setEditableMock).toHaveBeenLastCalledWith(true);
  });

  it("AI preset: plain generated prose reaches the editor even though applyPreset returns null", async () => {
    const activeNote = draftActiveNote();
    const applyPreset = vi.fn(async (bodyMd: string) => {
      useNotesStore.setState({
        activeNote: draftActiveNote([{ id: "draft_sec", body_md: bodyMd }]),
        activeBodyEmpty: false,
      } as any);
      return null;
    });
    useAiStore.setState({ generateFromPrompt: vi.fn().mockResolvedValue("Plain generated text, no markup.") } as any);
    useNotesStore.setState({ activeNote, activeBodyEmpty: true, applyPreset } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);

    fireEvent.click(await screen.findByTestId("mobile-preset-more"));
    fireEvent.click(screen.getByText("Start with AI"));
    fireEvent.change(screen.getByPlaceholderText("What's this note about?"), { target: { value: "My trip" } });
    fireEvent.click(screen.getByText("Generate"));

    await waitFor(() => expect(applyPreset).toHaveBeenCalledWith("Plain generated text, no markup.", "My trip"));
    await waitFor(() =>
      expect(setContentMock).toHaveBeenLastCalledWith("Plain generated text, no markup.", {
        contentType: "markdown",
        emitUpdate: false,
      })
    );
    expect(setEditableMock).toHaveBeenLastCalledWith(true);
  });

  it("AI preset: text typed WHILE the AI is generating is never overwritten — the generated body is dropped, applyPreset never runs", async () => {
    // 생성은 몇 초 걸린다. 그 사이 사용자가 칠한 글 위에 프리셋을 칠하면 되돌릴 길이 없다(초안은 서버 사본이 없고 폰엔
    // 실행 취소가 없다) — applyCapturePreset 의 빈 본문 확인이 모든 프리셋 경로의 마지막 방어선이다.
    const activeNote = draftActiveNote();
    const applyPreset = vi.fn(async () => null);
    let finishGeneration!: (text: string) => void;
    useAiStore.setState({
      generateFromPrompt: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishGeneration = resolve;
          })
      ),
    } as any);
    useNotesStore.setState({ activeNote, activeBodyEmpty: true, applyPreset } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    fireEvent.click(await screen.findByTestId("mobile-preset-more"));
    fireEvent.click(screen.getByText("Start with AI"));
    fireEvent.change(screen.getByPlaceholderText("What's this note about?"), { target: { value: "My trip" } });
    fireEvent.click(screen.getByText("Generate"));
    setContentMock.mockClear();

    editorEmptyMock = false; // 생성 중에 사용자가 본문에 글을 쳤다 — 스토어 플래그(activeBodyEmpty)는 아직 true 다
    await act(async () => {
      finishGeneration("Generated starter text");
    });

    expect(applyPreset).not.toHaveBeenCalled();
    expect(setContentMock).not.toHaveBeenCalled();
  });

  it("todo preset on a still-empty editor does apply (the guard only trips on real content)", async () => {
    const activeNote = draftActiveNote();
    const applyPreset = vi.fn(async () => null);
    useNotesStore.setState({ activeNote, activeBodyEmpty: true, applyPreset } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    fireEvent.click(await screen.findByText("To-do list"));
    await waitFor(() => expect(applyPreset).toHaveBeenCalledTimes(1));
  });

  it("AI preset: output containing unsupported markup (a table) renders read-only instead of silently vanishing", async () => {
    // P0-2: markdown links/images are now mobile-editable (Link + BriseImage + Markdown).
    // Tables still lack the Table extension on mobile — use that as the unsupported fixture.
    const activeNote = draftActiveNote();
    const applyPreset = vi.fn(async (bodyMd: string) => {
      useNotesStore.setState({
        activeNote: draftActiveNote([{ id: "draft_sec", body_md: bodyMd }]),
        activeBodyEmpty: false,
      } as any);
      return null;
    });
    useAiStore.setState({
      generateFromPrompt: vi.fn().mockResolvedValue("<table><tr><td>cell</td></tr></table>"),
    } as any);
    useNotesStore.setState({ activeNote, activeBodyEmpty: true, applyPreset } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    fireEvent.click(await screen.findByTestId("mobile-preset-more"));
    await screen.findByText("Start with AI"); // let the initial mount's own setContent("") settle
    setContentMock.mockClear();

    fireEvent.click(screen.getByText("Start with AI"));
    fireEvent.change(screen.getByPlaceholderText("What's this note about?"), { target: { value: "My trip" } });
    fireEvent.click(screen.getByText("Generate"));

    await waitFor(() => expect(applyPreset).toHaveBeenCalledTimes(1));
    // sectionRef/activeNote both now hold the real body server-side (applyPreset already
    // persisted it) — it's the mobile editor specifically that can't safely re-serialize it, so
    // this must degrade to the same read-only fallback unsupported desktop content always gets,
    // not silently drop the content from view.
    await waitFor(() => expect(setEditableMock).toHaveBeenLastCalledWith(false));
    expect(setContentMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/can't edit/i)).toBeTruthy();
  });
});

function diagramActiveNote(bodyMd: string) {
  const n = draftActiveNote([{ id: "diag_sec", body_md: bodyMd }]);
  n.sections[0].kind = "diagram";
  n.note.id = "note-with-diagram"; // materialized (not "__draft__") — diagram sections are never a fresh capture draft
  return n;
}

describe("MobileNote — kind:'diagram' sections (owner brief: first-class kind, never 'unsupported markup')", () => {
  beforeEach(() => {
    setContentMock.mockClear();
    setEditableMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  it("renders the diagram component (not the Tiptap editor) with the section's own body, never the read-only 'edit on desktop' banner", async () => {
    const activeNote = diagramActiveNote('flowchart TD\nn1["A"] -->|"소속"| n2["B"]');
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    const source = await screen.findByTestId("diagram-source");
    expect(source.textContent).toBe('flowchart TD\nn1["A"] -->|"소속"| n2["B"]');
    expect(screen.queryByTestId("editor-content")).toBeNull();
    expect(screen.queryByText(/can't edit/i)).toBeNull();
  });

  it("tapping the diagram enters source edit; editing saves through the same updateSectionBody(id, body_md) path prose uses", async () => {
    const updateSectionBody = vi.fn(async () => {});
    const activeNote = diagramActiveNote("flowchart TD\nn1 --> n2");
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    fireEvent.click(await screen.findByTestId("diagram-source"));
    const textarea = await screen.findByTestId("diagram-source-textarea");
    fireEvent.change(textarea, { target: { value: 'flowchart TD\nn1 -->|"rel"| n2' } });

    expect(updateSectionBody).toHaveBeenCalledWith("diag_sec", 'flowchart TD\nn1 -->|"rel"| n2');
  });

  // Owner feedback 2026-07-30 item 4: they used to render `disabled`; a dead control is still
  // clutter on a 390px screen, so a 관계도 section shows no formatting verbs at all. 첨부 stays —
  // attachments are note-level and would otherwise be unreachable while a diagram is open.
  it("a diagram section renders NO formatting toolbar (checklist/bold/italic gone, 첨부 kept via the dock speed dial)", async () => {
    const activeNote = diagramActiveNote("flowchart TD\nn1 --> n2");
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("diagram-source");

    expect(screen.queryByLabelText("Checklist")).toBeNull();
    expect(screen.queryByLabelText("Bold")).toBeNull();
    expect(screen.queryByLabelText("Italic")).toBeNull();
    // 첨부는 노트 단위라 관계도에서도 닿아야 한다 — 독 슬롯의 ＋ 를 열면 "파일 첨부" 가 있다.
    fireEvent.click(screen.getByLabelText("Quick input", { selector: "button" }));
    expect(screen.getByLabelText("Attach file")).toBeTruthy();
  });

  // The picture's 폭 맞춤/확대/축소 row stays MOUNTED (DiagramSection is src/components/**, not ours
  // to edit) and is removed from the mobile surface by stylesheet instead — jsdom applies none of
  // our CSS, so the rule itself is what this asserts. Losing it strands a zoomed-out user: `zoom`
  // starts null (=fit) and the ± buttons only ever set a number, so only 폭 맞춤 returns to fit.
  it("the diagram view-tools row (폭 맞춤/확대/축소) is removed from the mobile surface by mobile.css", () => {
    // 진입 배럴(mobile.css)과 styles/mobile/ 부분 파일 전부 — 규칙이 어느 부분에 있든 본다(vitest cwd = repo root).
    const css = ["src/styles/mobile.css", ...readdirSync("src/styles/mobile").filter((f) => f.endsWith(".css")).map((f) => `src/styles/mobile/${f}`)]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(css).toMatch(
      /\.mobile-diagram-host \[data-testid="diagram-view-tools"\]\s*\{[^}]*display:\s*none/
    );
  });
});

describe("MobileNote — creating a diagram from a template (mobile had no entry point at all before)", () => {
  beforeEach(() => {
    setContentMock.mockClear();
    setEditableMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  it("the section strip's + picker opens the template gallery, and a template seeds a real kind:'diagram' section", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "workspace_status_list") return { statuses: [] };
      if (cmd === "section_create_with_body")
        return { id: "new_diag", name: args.name, body_md: args.body_md, position: 1, kind: args.kind };
      return {};
    });
    // Materialized note (not a fresh draft) so insertSection's activeNote patch lands — the fake
    // useEditor above returns a NEW object every render, which re-runs the note-load effect
    // constantly, so the created section has to really exist in activeNote.sections to stay open.
    const activeNote = draftActiveNote();
    activeNote.note.id = "note-1";
    useNotesStore.setState({
      activeNote,
      activeBodyEmpty: true,
      ensureMaterialized: vi.fn(async () => "note-1"),
      updateSectionBody: vi.fn(async () => {}),
    } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    // One creation path now: strip "+" -> [Text | Diagram] -> the shared template gallery. The old
    // toolbar 관계도 button is gone (owner feedback 2026-07-30 item 2/4).
    fireEvent.click(await screen.findByTestId("mobile-section-add"));
    fireEvent.click(screen.getByTestId("mobile-section-add-diagram"));

    // Template gallery (the SHARED diagramStarter one), not a blank raw-source box.
    // ids: people/process/decision/comparison/system/timeline (retired family/blank).
    fireEvent.click(screen.getByTestId("mobile-diagram-tpl-people"));

    await waitFor(() => {
      const created = callMock.mock.calls.find((c) => c[0] === "section_create_with_body");
      expect(created).toBeTruthy();
      // kind:'diagram' must reach the backend — a "text" section holding diagram JSON renders as prose.
      expect(created![1].kind).toBe("diagram");
      // TD everywhere and unchangeable (owner, 2026-07-30): vertical fills the tall section area,
      // and the ↓/→ toggle is gone, so the seed's direction is the diagram's direction.
      expect(created![1].body_md).toContain('"v": 1');
      // A filled-in, structured-editable seed from diagramStarter's people template — user starts
      // by EDITING, not authoring (label + edge text, not bare node ids).
      expect(created![1].body_md).toContain("팀장 김민준");
      expect(created![1].body_md).toContain("선임 레포트");
    });

    // ...and the seeded source is on screen immediately (diagram renderer, not the prose editor).
    const source = await screen.findByTestId("diagram-source");
    expect(source.textContent).toContain('"v": 1');
    expect(screen.queryByTestId("editor-content")).toBeNull();
  });
});

// Live defect 2026-07-30: a kind:'diagram' section with an EMPTY body rendered as a blank canvas
// under "구조 편집을 지원하지 않습니다". runAiAction rejects an empty MODEL ANSWER but strips the
// ```mermaid/```json fence afterwards (stripMermaidFence, aiPrompts.ts), so an answer that is
// nothing but an empty fence reaches the inserter as "". Mobile has its own inserter, so the
// never-born-empty guard has to hold on this side too.
describe("MobileNote — AI 관계도 만들기 never creates an empty diagram section", () => {
  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    // PLAN-2026-09-05 §2 트랙 B의 AI 결과 게이트(stores/aiResultGate.ts::runWithAiResultGate)는
    // MobileAiResultSheet가 마운트돼 있을 때만 걸린다 — 이 스위트는 MobileNote를 단독으로 렌더해
    // 그 시트가 없으므로 원래도 우회됐지만, 그 우회는 모듈 스코프 `gateHostMounted` 플래그가
    // 우연히 false인 데 기대는 것이었다(다른 테스트 파일이 시트를 마운트한 채 못 닫으면 깨진다).
    // 의도를 명시적으로 남긴다 — 이 스위트는 게이트를 안 태우는 걸 테스트한다.
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as any);
  });

  it("an AI generated diagram lands as a real, parseable diagram", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "workspace_status_list") return { statuses: [] };
      if (cmd === "section_create_with_body")
        return { id: "new_diag", name: args.name, body_md: args.body_md, position: 1, kind: args.kind };
      return {};
    });
    const validJson = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "세종" },
        { id: "n2", label: "장영실" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", label: "신하" }],
    });
    useAiStore.setState({
      aiReachable: true,
      ensureAiReachable: vi.fn().mockResolvedValue(undefined),
      generateFromPrompt: vi.fn(async () => validJson),
      promptPending: false,
    } as any);
    const activeNote = draftActiveNote([{ id: "sec_1", body_md: "세종과 장영실 이야기" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({
      activeNote,
      activeBodyEmpty: false,
      ensureMaterialized: vi.fn(async () => "note-1"),
      updateSectionBody: vi.fn(async () => {}),
    } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    fireEvent.click(screen.getByLabelText("AI actions"));
    fireEvent.click(await screen.findByText("Create a relationship diagram"));

    await waitFor(() => {
      const created = callMock.mock.calls.find((c) => c[0] === "section_create_with_body");
      expect(created).toBeTruthy();
      expect(created![1].kind).toBe("diagram");
      const model = parseDiagram(created![1].body_md);
      expect(model.empty).toBe(false);
      expect(model.structured).toBe(true);
      expect(model.nodes.length).toBeGreaterThan(0);
    });
  });
});

describe("MobileNote — AI 관계도 수정하기 replaces the open diagram's body (owner item ⑤)", () => {
  // The lib/invoke `call` mock is module-level, so its history carries over between tests — read
  // section_create_with_body calls through this helper after clearing, never off the raw history.
  const createCalls = () => {
    const m = (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return m.filter((c) => c[0] === "section_create_with_body");
  };

  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    setContentMock.mockClear();
    setEditableMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    // See the sibling describe above — this block's first test drives diagram_edit directly
    // (no MobileAiResultSheet in the tree), so it opts out of the gate explicitly instead of
    // depending on gateHostMounted happening to be false. The second test below mounts the sheet
    // and flips this back to true to prove the gate itself (2026-09-05 실측: diagram_edit hung
    // forever behind the gate on mobile before MobileAiResultSheet existed) no longer hangs.
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as any);
  });

  it("runs the real preset store's diagram_edit action, writes the returned source through updateSectionBody, and the rendered diagram shows it", async () => {
    const BEFORE_OBJ = {
      v: 1,
      nodes: [
        { id: "n1", label: "세종", link: "note-abc" },
        { id: "n2", label: "장영실" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", label: "신하" }],
    };
    const AFTER_OBJ = {
      v: 1,
      nodes: [
        { id: "n1", label: "세종", link: "note-abc" },
        { id: "n2", label: "장영실" },
        { id: "n3", label: "아무개" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", label: "신하" },
        { id: "e2", from: "n1", to: "n3", label: "신하" },
      ],
    };
    const BEFORE = JSON.stringify(BEFORE_OBJ, null, 2);
    const AFTER = JSON.stringify(AFTER_OBJ, null, 2);
    const generateFromPrompt = vi.fn(async () => AFTER);
    useAiStore.setState({
      aiReachable: true,
      ensureAiReachable: vi.fn().mockResolvedValue(undefined),
      generateFromPrompt,
      promptPending: false,
    } as any);
    const updateSectionBody = vi.fn(async () => {});
    useNotesStore.setState({ activeNote: diagramActiveNote(BEFORE), activeBodyEmpty: false, updateSectionBody } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("diagram-source");

    fireEvent.click(screen.getByLabelText("AI actions"));
    // The edit row only exists because the open section is a diagram (activeSectionKind wiring).
    fireEvent.click(await screen.findByText("Edit this diagram"));
    fireEvent.change(screen.getByPlaceholderText(/What should change/), {
      target: { value: "아무개 추가하고 세종과 연결해줘" },
    });
    fireEvent.click(screen.getByText("Apply"));

    // The model saw the CURRENT source verbatim, in the prompt half (context stays null).
    await waitFor(() => expect(generateFromPrompt).toHaveBeenCalled());
    const [prompt, context] = generateFromPrompt.mock.calls[0] as unknown as [string, string | null];
    expect(prompt).toContain(BEFORE);
    expect(prompt).toContain("아무개 추가하고 세종과 연결해줘");
    expect(context).toBeNull();

    // Replaced the SAME section's body — no new section was created.
    await waitFor(() => expect(updateSectionBody).toHaveBeenCalledWith("diag_sec", AFTER));
    expect(createCalls().length).toBe(0);

    // Remount contract: DiagramSection seeds its draft from body_md on mount only, so the AI's
    // rewrite is only visible if MobileNote bumps its key — assert the user actually sees it.
    await waitFor(() => expect(screen.getByTestId("diagram-source").textContent).toContain('"아무개"'));
    expect(screen.getByTestId("diagram-source").textContent).toContain('"note-abc"');
  });

  // WH (2026-09-06) — the regression this whole file's other AI tests now dodge via
  // aiConfirmBeforeApply:false. Mounting MobileAiResultSheet alongside MobileNote is what makes
  // stores/aiResultGate.ts's module-scope `gateHostMounted` true on the mobile surface, so
  // runWithAiResultGate no longer takes the desktop-modal-less bypass — it actually waits for a
  // decide() call. Before MobileAiResultSheet existed, nothing could ever call decide() here and
  // diagram_edit hung forever (the failure this test proves is fixed).
  it("with the AI result gate armed (MobileAiResultSheet mounted), diagram_edit waits for [Insert] in the sheet before writing anything", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as any);
    const BEFORE_OBJ = { v: 1, nodes: [{ id: "n1", label: "세종" }], edges: [] };
    const AFTER_OBJ = {
      v: 1,
      nodes: [
        { id: "n1", label: "세종" },
        { id: "n2", label: "장영실" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", label: "신하" }],
    };
    const BEFORE = JSON.stringify(BEFORE_OBJ, null, 2);
    const AFTER = JSON.stringify(AFTER_OBJ, null, 2);
    const generateFromPrompt = vi.fn(async () => AFTER);
    useAiStore.setState({
      aiReachable: true,
      ensureAiReachable: vi.fn().mockResolvedValue(undefined),
      generateFromPrompt,
      promptPending: false,
    } as any);
    const updateSectionBody = vi.fn(async () => {});
    useNotesStore.setState({ activeNote: diagramActiveNote(BEFORE), activeBodyEmpty: false, updateSectionBody } as any);

    render(
      <>
        <MobileAiResultSheet />
        <MobileNote onBack={() => {}} onOpenNote={() => {}} />
      </>
    );
    await screen.findByTestId("diagram-source");

    fireEvent.click(screen.getByLabelText("AI actions"));
    fireEvent.click(await screen.findByText("Edit this diagram"));
    fireEvent.change(screen.getByPlaceholderText(/What should change/), {
      target: { value: "장영실 추가" },
    });
    fireEvent.click(screen.getByText("Apply"));

    // The generation finished (the gate polled the model's answer into the preview)…
    await waitFor(() => expect(generateFromPrompt).toHaveBeenCalled());
    const preview = await screen.findByTestId("ai-result-preview");
    expect(preview.textContent).toContain("장영실");
    // …but nothing was written yet — the gate is holding it for a human decision.
    expect(updateSectionBody).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ai-result-insert"));

    await waitFor(() => expect(updateSectionBody).toHaveBeenCalledWith("diag_sec", AFTER));
  });
});

/**
 * Owner feedback 2026-07-30, items 1 + 2 — the two shape changes to the note screen itself.
 * Item 1's other half (the tab bar staying visible on the "note" screen) lives in MobileApp.test.tsx:
 * that file stubs MobileNote, this one stubs the shell, so the assertion has to be split.
 */
describe("MobileNote — one note screen, one chrome (item 1) + the section strip (item 2)", () => {
  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    setContentMock.mockClear();
    setEditableMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  // Same chrome WITHOUT `capture` (owner 2026-07-30 item 1). Since 2026-10-10 that chrome has no 저장하기 (typing autosaves)
  // and the ✨ lives in the ＋ speed dial; the save state is a faint word at the end of the title line.
  it("an existing note (no `capture`): no 저장하기, the AI action is a speed-dial item, and the title line shows the save state", async () => {
    const activeNote = draftActiveNote([{ id: "s1", body_md: "hello" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({
      activeNote,
      activeDraft: false,
      savedState: "saved",
      activeBodyEmpty: false,
      updateSectionBody: vi.fn(async () => {}),
    } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    await screen.findByTestId("mobile-dock");
    expect(screen.queryByText("Save")).toBeNull();
    expect(document.querySelector(".mobile-capture-save, .mobile-ai-bubble")).toBeNull();
    const ai = screen.getByLabelText("AI actions");
    expect(ai.getAttribute("data-testid")).toBe("mobile-fab-ai");
    expect(screen.getByTestId("mobile-speed-dial").contains(ai)).toBe(true);
    expect(screen.getByTestId("mobile-save-status").textContent).toBe(t("mobile.save_status_saved"));
    act(() => useNotesStore.setState({ savedState: "saving" } as any));
    expect(screen.getByTestId("mobile-save-status").textContent).toBe(t("mobile.save_status_saving"));
    act(() => useNotesStore.setState({ savedState: "failed" } as any));
    expect(screen.getByTestId("mobile-save-status").getAttribute("data-state")).toBe("failed");
    expect(screen.getByTestId("mobile-save-status").textContent).toBe(t("mobile.save_status_failed"));
  });

  it("a draft that has never been saved shows no save state (nothing is stored yet — '저장됨' would be a lie)", async () => {
    useNotesStore.setState({ activeNote: draftActiveNote(), activeDraft: true, savedState: "saved", activeBodyEmpty: true } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await screen.findByTestId("mobile-dock");
    expect(screen.queryByTestId("mobile-save-status")).toBeNull();
    act(() => useNotesStore.setState({ savedState: "saving" } as any)); // first keystroke
    expect(screen.getByTestId("mobile-save-status").textContent).toBe(t("mobile.save_status_saving"));
  });

  it("lists every section in order, marks the current one, and switching loads the tapped section's body", async () => {
    const activeNote = draftActiveNote([
      { id: "s1", body_md: "first" },
      { id: "s2", body_md: "second" },
    ]);
    activeNote.note.id = "note-1";
    activeNote.sections[0].name = "Overview";
    activeNote.sections[1].name = "Notes";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    const strip = await screen.findByRole("tablist");
    expect(Array.from(strip.querySelectorAll('[role="tab"]')).map((b) => b.textContent)).toEqual([
      "Overview",
      "Notes",
    ]);
    // Same initial pick desktop's resolveActiveSection makes: the last section.
    expect(screen.getByTestId("mobile-section-tab-s2").getAttribute("data-active")).toBe("true");

    setContentMock.mockClear();
    fireEvent.click(screen.getByTestId("mobile-section-tab-s1"));

    await waitFor(() =>
      expect(setContentMock).toHaveBeenLastCalledWith("first", {
        contentType: "markdown",
        emitUpdate: false,
      })
    );
    expect(screen.getByTestId("mobile-section-tab-s1").getAttribute("data-active")).toBe("true");
  });

  it("the + picker's Text option creates a section through the same section_create_with_body path", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "workspace_status_list") return { statuses: [] };
      if (cmd === "section_create_with_body")
        return { id: "s_new", name: args.name, body_md: args.body_md, position: 9, kind: "text" };
      return {};
    });
    const activeNote = draftActiveNote([{ id: "s1", body_md: "first" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({
      activeNote,
      activeBodyEmpty: false,
      ensureMaterialized: vi.fn(async () => "note-1"),
      updateSectionBody: vi.fn(async () => {}),
    } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByTestId("mobile-section-add"));
    fireEvent.click(screen.getByTestId("mobile-section-add-text"));

    await waitFor(() => {
      const created = callMock.mock.calls.find((c) => c[0] === "section_create_with_body");
      expect(created).toBeTruthy();
      expect(created![1].kind).toBeUndefined(); // undefined kind = the backend's "text" default
    });
    // …and the new section is the one on screen + highlighted.
    await waitFor(() => expect(screen.getByTestId("mobile-section-tab-s_new").getAttribute("data-active")).toBe("true"));
  });
});

// Owner feedback 2026-07-30 item 5 — every overlay this screen owns rides the shared centered,
// keyboard-aware primitive (MobileModal), never a second bottom-sheet system.
// 2026-10-07 S22 실기 QA 결함 A — 전사 삽입 직후 첨부 패치가 새 activeNote 참조를 만들자, note-load 효과가
// 스토어의 낡은 본문(캐럿 보호로 일부러 갱신 안 함)으로 에디터를 다시 칠해 방금 넣은 전사가 화면에서 사라졌다.
// 다음 타이핑 저장이면 DB 까지 지워진다. 같은 섹션은 서버 버전(updated_at)이 움직였을 때만 다시 칠한다.
describe("MobileNote — note-load repaint only when the section's server version moved", () => {
  beforeEach(() => {
    setContentMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  const open = () => {
    const activeNote = draftActiveNote([{ id: "s1", body_md: "painted" }]);
    activeNote.note.id = "note-1";
    (activeNote.sections[0] as any).updated_at = "v1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    return activeNote;
  };

  it("a non-body patch (new activeNote reference, same updated_at, stale body) does not repaint over the editor", async () => {
    const n = open();
    await waitFor(() => expect(setContentMock).toHaveBeenCalledWith("painted", expect.anything()));
    setContentMock.mockClear();
    act(() => {
      useNotesStore.setState({
        activeNote: { ...n, sections: [{ ...n.sections[0], body_md: "stale store copy" }], attachments: [] },
      } as any);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(setContentMock).not.toHaveBeenCalled();
  });

  it("a real server change (updated_at moved, e.g. reload after another device's edit) repaints", async () => {
    const n = open();
    await waitFor(() => expect(setContentMock).toHaveBeenCalledWith("painted", expect.anything()));
    setContentMock.mockClear();
    act(() => {
      useNotesStore.setState({
        activeNote: { ...n, sections: [{ ...n.sections[0], body_md: "from other device", updated_at: "v2" }] },
      } as any);
    });
    await waitFor(() => expect(setContentMock).toHaveBeenCalledWith("from other device", expect.anything()));
  });
});

describe("MobileNote — overlays use the shared MobileModal primitive (item 5)", () => {
  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    const activeNote = draftActiveNote([{ id: "s1", body_md: "x" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
  });

  it("the + section picker and the AI sheet both render as .mobile-modal, not .mobile-sheet", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    fireEvent.click(await screen.findByTestId("mobile-section-add"));
    expect(screen.getByTestId("mobile-modal").getAttribute("aria-label")).toBe("New section");
    expect(document.querySelector(".mobile-sheet")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" }); // MobileModal owns Esc now

    fireEvent.click(screen.getByLabelText("AI actions"));
    await waitFor(() => expect(screen.getByTestId("mobile-modal").getAttribute("aria-label")).toBe("AI Assistant"));
    expect(document.querySelector(".mobile-sheet")).toBeNull();
  });
});

describe("MobileNote — image size 3-stage selection UI (D5)", () => {
  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    const activeNote = draftActiveNote([{ id: "s1", body_md: "x" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
  });

  it("renders 25%, 40%, 100% size selection controls when an image is active in editor", () => {
    activeImageMock = true;
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    const sizeControls = screen.getByTestId("mobile-image-size-controls");
    expect(sizeControls).toBeTruthy();
    // Labels go through t() — en defaults (mobile.img_size_*) after D5 i18n pass.
    expect(screen.getAllByText("S 25%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("M 40%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("L 100%").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText("S 25%")[0]);
    expect(updateAttributesMock).toHaveBeenCalledWith("image", { width: "25%" });

    fireEvent.click(screen.getAllByText("L 100%")[0]);
    expect(updateAttributesMock).toHaveBeenCalledWith("image", { width: "100%" });
    activeImageMock = false;
  });
});

// Mobile equivalent of EditorPanel.tsx's scroll-wrapper click handler (desktop) — a tap on a
// note:// wiki-link inside the body used to be inert on mobile (.mobile-note-body-wrap had no
// click handler at all). EditorContent is the fake empty div from the @tiptap/react mock above, so
// these tests append a raw <a> as a child of the wrap and click it directly — React 18 delegates
// its onClick listener at the render root, and the click still bubbles through real DOM nodes
// whether or not React itself created them.
describe("MobileNote — note:// wiki-link tap navigation", () => {
  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    (vi.mocked(emitNoticeMock) as unknown as ReturnType<typeof vi.fn>).mockClear();
    (vi.mocked(fetchNoteSummaryMock) as unknown as ReturnType<typeof vi.fn>).mockReset();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    const activeNote = draftActiveNote([{ id: "s1", body_md: "x" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
  });

  it("tapping a note:// link resolves the target via fetchNoteSummary and navigates through onOpenNote", async () => {
    (vi.mocked(fetchNoteSummaryMock) as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "target-1",
      title: "Target",
    } as any);
    const onOpenNote = vi.fn();
    const { container } = render(<MobileNote onBack={() => {}} onOpenNote={onOpenNote} />);

    const wrap = container.querySelector(".mobile-note-body-wrap") as HTMLElement;
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "note://target-1");
    anchor.textContent = "linked note";
    wrap.appendChild(anchor);

    // fireEvent.click returns false when preventDefault() was called on the (cancelable) event —
    // the handler must never let the webview try to follow a note:// URL as a real link.
    expect(fireEvent.click(anchor)).toBe(false);

    await waitFor(() => expect(fetchNoteSummaryMock).toHaveBeenCalledWith("target-1"));
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith("target-1"));
    expect(emitNoticeMock).not.toHaveBeenCalled();
  });

  it("tapping a note:// link to a missing/deleted note shows the notice instead of navigating", async () => {
    (vi.mocked(fetchNoteSummaryMock) as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const onOpenNote = vi.fn();
    const { container } = render(<MobileNote onBack={() => {}} onOpenNote={onOpenNote} />);

    const wrap = container.querySelector(".mobile-note-body-wrap") as HTMLElement;
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "note://gone");
    wrap.appendChild(anchor);

    fireEvent.click(anchor);

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalledWith("This note is no longer available."));
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it("a non-note link inside the body is left alone — not prevented, no lookup, no navigation", () => {
    const onOpenNote = vi.fn();
    const { container } = render(<MobileNote onBack={() => {}} onOpenNote={onOpenNote} />);

    const wrap = container.querySelector(".mobile-note-body-wrap") as HTMLElement;
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://example.com");
    wrap.appendChild(anchor);

    // Not preventDefault-ed — an ordinary link stays exactly as inert/functional as before.
    expect(fireEvent.click(anchor)).toBe(true);
    expect(fetchNoteSummaryMock).not.toHaveBeenCalled();
    expect(onOpenNote).not.toHaveBeenCalled();
  });
});

// K1 (WORKORDER W1) — the ref MobileApp calls when handleRemoteNoteWrite skips reloadActive() for
// buffer-protection (focus in the editor). body_md is "" to match sec.body so flushRef.current()'s
// mdSerializeEditor(fakeEditor) (no getMarkdown on the fake -> always "") is a clean no-op, keeping
// these tests about the banner/reload wiring, not the unrelated flush-serialize path.
describe("MobileNote — K1 remote-change banner (W1)", () => {
  const noteId = "note-1";
  let reloadActive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    const activeNote = draftActiveNote([{ id: "s1", body_md: "" }]);
    activeNote.note.id = noteId;
    reloadActive = vi.fn(async () => {});
    useNotesStore.setState({
      activeNote,
      activeBodyEmpty: false,
      updateSectionBody: vi.fn(async () => {}),
      reloadActive,
    } as any);
  });

  it("shows the banner when notifyRemoteChange fires for the note currently open", async () => {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    expect(screen.queryByText("This note changed on another device.")).toBeNull();

    act(() => ref.current!.notifyRemoteChange(noteId));

    expect(await screen.findByText("This note changed on another device.")).toBeTruthy();
  });

  it("ignores a notification for a note id other than the one currently open (stale/cross-note guard)", () => {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);

    act(() => ref.current!.notifyRemoteChange("some-other-note"));

    expect(screen.queryByText("This note changed on another device.")).toBeNull();
  });

  it("tapping Reload flushes, calls reloadActive(), and hides the banner", async () => {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    act(() => ref.current!.notifyRemoteChange(noteId));
    await screen.findByText("This note changed on another device.");

    fireEvent.click(screen.getByText("Reload"));

    await waitFor(() => expect(reloadActive).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("This note changed on another device.")).toBeNull();
  });
});

// K2 (W6) — section-strip long-press: rename/move forward/move backward/delete. All route through
// section_update/section_reorder/section_delete (already http:true), call-then-patch (never
// optimistic — see MobileNote.tsx's own comment on why), and flush the pending debounced edit first
// the same way switchSection already does.
describe("MobileNote — section-strip long-press actions (K2, W6)", () => {
  async function longPress(testId: string) {
    const el = await screen.findByTestId(testId);
    fireEvent.pointerDown(el);
    // lib/longPress.ts's real 400ms window.setTimeout — real (not faked) timers, matching the
    // existing long-press test precedent in MobileNoteTree.test.tsx. Polling for the sheet's own
    // effect (rather than a fixed sleep slightly longer than 400ms) instead of a bare `setTimeout`
    // wait: under the full suite's parallel load, a single fixed sleep raced the internal timer and
    // occasionally resolved first (flake caught in a full `npx vitest run`, not in this file alone)
    // — waitFor's poll-until-true has no such race, it just waits however long the timer actually
    // takes, up to the timeout.
    await waitFor(() => expect(screen.getByTestId("mobile-section-action-rename")).toBeTruthy(), { timeout: 2000 });
    fireEvent.pointerUp(el);
  }

  beforeEach(() => {
    (vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>).mockClear();
    (vi.mocked(emitNoticeMock) as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  it("long-pressing a tab opens the action sheet instead of switching; a plain tap still switches", async () => {
    const activeNote = draftActiveNote([
      { id: "s1", body_md: "first" },
      { id: "s2", body_md: "second" },
    ]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    await longPress("mobile-section-tab-s1");

    expect(screen.getByTestId("mobile-section-action-rename")).toBeTruthy();
    // The long-press did not switch the active tab (still s2, desktop's resolveActiveSection pick).
    expect(screen.getByTestId("mobile-section-tab-s2").getAttribute("data-active")).toBe("true");
  });

  it("rename: flushes, calls section_update{id,name}, and the strip label updates", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {}));
    const activeNote = draftActiveNote([{ id: "s1", body_md: "first" }, { id: "s2", body_md: "second" }]);
    activeNote.note.id = "note-1";
    activeNote.sections[0].name = "Overview";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    await longPress("mobile-section-tab-s1");
    fireEvent.click(screen.getByTestId("mobile-section-action-rename"));
    const input = screen.getByDisplayValue("Overview");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => {
      const call = callMock.mock.calls.find((c) => c[0] === "section_update");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ id: "s1", name: "Renamed" });
    });
    await waitFor(() => expect(screen.getByTestId("mobile-section-tab-s1").textContent).toBe("Renamed"));
  });

  it("move forward/backward: calls section_reorder with the swapped order and reflects it in the strip", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {}));
    const activeNote = draftActiveNote([
      { id: "s1", body_md: "first" },
      { id: "s2", body_md: "second" },
    ]);
    activeNote.note.id = "note-1";
    activeNote.sections[0].name = "First";
    activeNote.sections[1].name = "Second";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    // s1 is first already — "move forward" (further left) must be disabled.
    await longPress("mobile-section-tab-s1");
    expect((screen.getByTestId("mobile-section-action-forward") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("mobile-section-action-backward"));

    await waitFor(() => {
      const call = callMock.mock.calls.find((c) => c[0] === "section_reorder");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ note_id: "note-1", ordered_ids: ["s2", "s1"] });
    });
    const strip = await screen.findByRole("tablist");
    await waitFor(() =>
      expect(Array.from(strip.querySelectorAll('[role="tab"]')).map((b) => b.textContent)).toEqual([
        "Second",
        "First",
      ])
    );
  });

  it("delete: removes the tab and, when the deleted section was active, switches to a remaining one", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {}));
    const activeNote = draftActiveNote([
      { id: "s1", body_md: "first" },
      { id: "s2", body_md: "second" },
    ]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    // Initial pick is the last section (s2, same rule switchSection's test above documents).
    expect(screen.getByTestId("mobile-section-tab-s2").getAttribute("data-active")).toBe("true");

    await longPress("mobile-section-tab-s2");
    fireEvent.click(screen.getByTestId("mobile-section-action-delete"));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_delete", { id: "s2" }));
    await waitFor(() => expect(screen.queryByTestId("mobile-section-tab-s2")).toBeNull());
    // The deleted tab was active — MobileNote must fall back to the one remaining section.
    expect(screen.getByTestId("mobile-section-tab-s1").getAttribute("data-active")).toBe("true");
  });

  it("the delete row is disabled for a note's last remaining section (client-side guard, no round trip)", async () => {
    const activeNote = draftActiveNote([{ id: "s1", body_md: "only" }]);
    activeNote.note.id = "note-1";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    await longPress("mobile-section-tab-s1");

    expect((screen.getByTestId("mobile-section-action-delete") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed rename keeps the sheet open instead of silently discarding the edit (call() already toasted)", async () => {
    const callMock = vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "workspace_status_list") return { statuses: [] };
      if (cmd === "section_update") throw { code: "NOT_FOUND", message: "gone" };
      return {};
    });
    const activeNote = draftActiveNote([{ id: "s1", body_md: "first" }]);
    activeNote.note.id = "note-1";
    activeNote.sections[0].name = "Overview";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, updateSectionBody: vi.fn(async () => {}) } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    await longPress("mobile-section-tab-s1");
    fireEvent.click(screen.getByTestId("mobile-section-action-rename"));
    fireEvent.change(screen.getByDisplayValue("Overview"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Apply"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_update", { id: "s1", name: "Renamed" }));
    // Still on the rename dialog (not silently closed) and the tab keeps its old name.
    expect(screen.getByDisplayValue("Renamed")).toBeTruthy();
    expect(screen.getByTestId("mobile-section-tab-s1").textContent).toBe("Overview");
  });
});

describe("MobileNote — 편집 불가 서식 노트는 열람·이탈만으로 본문을 덮어쓰지 않는다 (데이터 유실 회귀)", () => {
  // 2026-10-04 실기기: 표/하이라이트 등이 든 노트를 폰에서 열었다 나오면 Tiptap(빈 채)의 직렬화 결과 ""가
  // 원래 본문과 달라 updateSectionBody(id, "") 가 나가 두 섹션이 0자가 됐다. 읽기 전용 섹션은 쓰기 경로가
  // 아예 닫혀 있어야 한다. (가짜 에디터는 getMarkdown 이 없어 mdSerializeEditor 가 "" 를 돌려준다 — 실제
  // 빈 에디터와 같은 상황이다.)
  const TABLE_BODY = "<table><tr><td>cell</td></tr></table>";

  function readOnlyNote() {
    const n = draftActiveNote([{ id: "ro_sec", body_md: TABLE_BODY }]);
    n.note.id = "note-readonly"; // materialized — 임시 초안이 아니다
    return n;
  }

  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  it("flush(탭 이동·뒤로가기가 부르는 경로)가 읽기 전용 섹션의 본문을 빈 값으로 쓰지 않는다", async () => {
    const updateSectionBody = vi.fn(async () => {});
    useNotesStore.setState({ activeNote: readOnlyNote(), activeBodyEmpty: false, updateSectionBody } as any);
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByText(/can't edit/i);

    await act(async () => {
      await ref.current!.flushAndMeasure();
    });

    expect(updateSectionBody).not.toHaveBeenCalled();
  });
});

// V5 - save failure is visible and never mistaken for saved.
describe("MobileNote - save failure honesty (V5)", () => {
  let updateSectionBody: ReturnType<typeof vi.fn>;
  let failNext: boolean;

  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    fakeMarkdown = "typed text";
    failNext = true;
    // Mirrors the real store: a failed section_update does NOT throw, it only flips savedState.
    updateSectionBody = vi.fn(async () => {
      useNotesStore.setState({ savedState: failNext ? "failed" : "saved" } as any);
    });
    const activeNote = draftActiveNote([{ id: "s1", body_md: "" }]);
    activeNote.note.id = "note-v5";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false, savedState: "saved", updateSectionBody } as any);
    localStorage.clear(); // 보관함(unsavedStash)은 같은 파일 안 테스트끼리 새면 안 된다 — note-v5 id 를 여럿이 쓴다
    vi.mocked(emitNoticeMock).mockClear();
  });
  afterEach(() => {
    fakeMarkdown = "";
    delete (navigator as any).clipboard;
  });

  it("failed flush shows the banner and reports an unsaved body; retry succeeding clears both", async () => {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    expect(screen.queryByTestId("mobile-save-failed")).toBeNull();

    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(await screen.findByTestId("mobile-save-failed")).toBeTruthy();
    expect(ref.current!.hasUnsavedFailure()).toBe(true);

    failNext = false;
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.queryByTestId("mobile-save-failed")).toBeNull());
    expect(updateSectionBody).toHaveBeenCalledTimes(2);
    expect(updateSectionBody).toHaveBeenLastCalledWith("s1", "typed text");
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("success path shows no status at all", async () => {
    failNext = false;
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(updateSectionBody).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mobile-save-failed")).toBeNull();
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  // 2026-10-07: [그래도 나가기]는 클립보드가 아니라 이 기기 보관(unsavedStash)에 기댄다. 폰은 http://100.x 비보안
  // 컨텍스트라 navigator.clipboard 가 없고, 예전엔 그래서 영영 못 나갔다 — 아래 테스트는 그 옛 계약("복사 실패 =
  // 나가기 차단")을 일부러 바꾼 것이다: 이제 차단되는 건 보관도 복사도 못 했을 때뿐이다.
  const setClipboard = (value: unknown) =>
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });
  async function renderBlockedExit() {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    const proceed = vi.fn();
    act(() => ref.current!.showLeaveBlocked(proceed));
    return { ref, proceed };
  }

  it("leave-anyway without a clipboard (insecure context): stashes the text on the device, then leaves", async () => {
    setClipboard(undefined);
    const { ref, proceed } = await renderBlockedExit();

    fireEvent.click(await screen.findByText("Leave anyway"));
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));

    const kept = stashesForNote("note-v5");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ sectionId: "s1", sectionName: "Overview", kind: "text", bodyMd: "typed text" });
    expect(vi.mocked(emitNoticeMock)).toHaveBeenCalledWith(t("mobile.save_stashed"));
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("leave-anyway with a clipboard: still stashes, and the copy is a bonus (a rejected copy does not block)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });
    const { proceed } = await renderBlockedExit();

    fireEvent.click(await screen.findByText("Leave anyway"));
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("typed text");
    expect(stashesForNote("note-v5").map((s) => s.bodyMd)).toEqual(["typed text"]);
  });

  it("leave-anyway when the device cannot keep it and there is no clipboard: stays on the screen", async () => {
    setClipboard(undefined);
    const { ref, proceed } = await renderBlockedExit();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      fireEvent.click(await screen.findByText("Leave anyway"));
      await waitFor(() => expect(vi.mocked(emitNoticeMock)).toHaveBeenCalledWith(t("mobile.save_stash_failed")));
    } finally {
      setItem.mockRestore();
    }
    expect(proceed).not.toHaveBeenCalled();
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy(); // 배너·버튼이 그대로라 다시 누를 수 있다
    expect(listStashes()).toEqual([]);

    // 저장소가 돌아오면 같은 버튼으로 나간다.
    fireEvent.click(screen.getByText("Leave anyway"));
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(stashesForNote("note-v5").map((s) => s.bodyMd)).toEqual(["typed text"]);
  });

  it("leave-anyway when the stash fails but the clipboard copy works: leaves, as before", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { proceed } = await renderBlockedExit();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      fireEvent.click(await screen.findByText("Leave anyway"));
      await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    } finally {
      setItem.mockRestore();
    }
    expect(writeText).toHaveBeenCalledWith("typed text");
    expect(vi.mocked(emitNoticeMock)).toHaveBeenCalledWith(t("mobile.save_copied"));
  });

  it("the whole loop: save fails -> leave anyway -> screen goes away -> opening the same note again offers the text back", async () => {
    setClipboard(undefined);
    const first = createRef<MobileNoteHandle>();
    const view = render(<MobileNote ref={first} onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {
      await first.current!.flushAndMeasure();
    });
    expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull();
    const proceed = vi.fn();
    act(() => first.current!.showLeaveBlocked(proceed));
    fireEvent.click(await screen.findByText("Leave anyway"));
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    view.unmount(); // MobileApp 은 screen 이 바뀌면 key={screen} 로 MobileNote 를 다시 마운트한다

    // 같은 노트를 다시 연다 — 새 인스턴스, 서버본(빈 본문)이 그려지고 보관한 글이 배너로 돌아온다.
    failNext = false;
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    expect((await screen.findByTestId("mobile-stash-recovery")).textContent).toContain(t("mobile.stash_found"));
    expect(stashesForNote("note-v5").map((x) => x.bodyMd)).toEqual(["typed text"]);
  });

  it("K1 reload never overwrites an unsaved body with the remote version", async () => {
    const reloadActive = vi.fn(async () => {});
    useNotesStore.setState({ reloadActive } as any);
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    act(() => ref.current!.notifyRemoteChange("note-v5"));
    fireEvent.click(await screen.findByText("Reload"));
    await waitFor(() => expect(updateSectionBody).toHaveBeenCalled());
    expect(reloadActive).not.toHaveBeenCalled();
  });
});

// [그래도 나가기]가 이 기기에 보관한 글의 복구 — 그 노트를 다시 열면 배너, "새 섹션으로 넣기"는 아무것도 덮지 않는다.
describe("MobileNote - recovery of text kept on this device", () => {
  const callFn = () => callFromInvoke as unknown as ReturnType<typeof vi.fn>;
  let defaultImpl: any;
  let updateSectionBody: ReturnType<typeof vi.fn>;
  let ensureMaterialized: ReturnType<typeof vi.fn>;
  let createFails: boolean;

  const noteWith = (id: string) => {
    const n = draftActiveNote([{ id: "s1", body_md: "server text" }]);
    n.note.id = id;
    return n;
  };
  const keep = (over: Record<string, unknown> = {}) =>
    putStash({ noteId: "note-r", sectionId: "s1", sectionName: "Overview", kind: "text", bodyMd: "lost text", ...over } as any);

  beforeEach(() => {
    localStorage.clear();
    createFails = false;
    fakeMarkdown = "server text"; // 에디터 본문 = 서버본 → flush 는 쓸 것이 없다
    setContentMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    defaultImpl = callFn().getMockImplementation();
    callFn().mockClear();
    callFn().mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "workspace_status_list") return { statuses: [] };
      if (cmd === "section_create_with_body") {
        if (createFails) throw { code: "IO", message: "server down" };
        return { id: "rec1", name: args.name, body_md: args.body_md, position: 1, kind: args.kind };
      }
      return {};
    });
    updateSectionBody = vi.fn(async () => {});
    ensureMaterialized = vi.fn(async () => useNotesStore.getState().activeNote!.note.id);
    useNotesStore.setState({
      activeNote: noteWith("note-r"),
      activeDraft: false,
      activeBodyEmpty: false,
      savedState: "saved",
      saveConflict: null,
      updateSectionBody,
      ensureMaterialized,
    } as any);
  });
  afterEach(() => {
    fakeMarkdown = "";
    callFn().mockClear(); // 뒤 describe 들이 callFn().mock.calls.find(...) 로 첫 호출을 찾는다 — 내 호출이 남으면 안 된다
    callFn().mockImplementation(defaultImpl as any);
  });

  const createCalls = () => callFn().mock.calls.filter((c) => c[0] === "section_create_with_body");
  const mount = () => render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

  it("shows nothing when this note has no kept text (another note's stash does not leak in)", async () => {
    keep({ noteId: "some-other-note" });
    mount();
    await screen.findByTestId("editor-content");
    expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull();
  });

  it("opening the note again shows the banner; adding as a new section creates it, drops the stash and shows it, overwriting nothing", async () => {
    keep();
    mount();
    expect((await screen.findByTestId("mobile-stash-recovery")).textContent).toContain(t("mobile.stash_found"));

    fireEvent.click(screen.getByTestId("mobile-stash-insert"));
    await waitFor(() => expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull());

    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][1]).toEqual({
      note_id: "note-r",
      name: t("mobile.stash_section_name", { name: "Overview" }),
      body_md: "lost text",
      kind: "text",
    });
    expect(listStashes()).toEqual([]);
    // 새 섹션이 노트에 붙고 화면에 올라왔다. 기존 섹션 본문은 한 번도 쓰이지 않았다.
    expect(useNotesStore.getState().activeNote!.sections.map((x) => x.id)).toEqual(["s1", "rec1"]);
    expect(setContentMock.mock.calls.some((c) => c[0] === "lost text")).toBe(true);
    expect(updateSectionBody).not.toHaveBeenCalled();
  });

  it("a failed insert keeps the stash and the banner (the stash is then the only copy), so it can be retried", async () => {
    keep();
    createFails = true;
    mount();
    fireEvent.click(await screen.findByTestId("mobile-stash-insert"));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    await waitFor(() => expect((screen.getByTestId("mobile-stash-insert") as HTMLButtonElement).disabled).toBe(false));

    expect(screen.getByTestId("mobile-stash-recovery")).toBeTruthy();
    expect(stashesForNote("note-r").map((x) => x.bodyMd)).toEqual(["lost text"]);
    expect(useNotesStore.getState().activeNote!.sections).toHaveLength(1);
    expect(setContentMock.mock.calls.some((c) => c[0] === "lost text")).toBe(false);

    createFails = false;
    fireEvent.click(screen.getByTestId("mobile-stash-insert"));
    await waitFor(() => expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull());
    expect(listStashes()).toEqual([]);
  });

  it("discard needs a second tap (it deletes the only copy); the first tap only asks", async () => {
    keep();
    mount();
    const discard = await screen.findByTestId("mobile-stash-discard");
    expect(discard.textContent).toBe(t("mobile.stash_discard"));

    fireEvent.click(discard);
    expect(screen.getByTestId("mobile-stash-discard").textContent).toBe(t("mobile.stash_discard_confirm"));
    expect(listStashes()).toHaveLength(1);
    expect(screen.getByTestId("mobile-stash-recovery")).toBeTruthy();

    fireEvent.click(screen.getByTestId("mobile-stash-discard"));
    await waitFor(() => expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull());
    expect(listStashes()).toEqual([]);
    expect(createCalls()).toHaveLength(0);
  });

  it("several stashes: newest first with a count; resolving one reveals the next, and the next starts at the first tap again", async () => {
    keep({ bodyMd: "older text", sectionId: "s1" });
    keep({ bodyMd: "newer text", sectionId: "s2", sectionName: "Notes" });
    mount();
    expect((await screen.findByTestId("mobile-stash-recovery")).textContent).toContain("(2)");

    fireEvent.click(screen.getByTestId("mobile-stash-discard"));
    fireEvent.click(screen.getByTestId("mobile-stash-discard")); // newer 를 버린다
    await waitFor(() => expect(stashesForNote("note-r").map((x) => x.bodyMd)).toEqual(["older text"]));
    expect(screen.getByTestId("mobile-stash-recovery").textContent).not.toContain("(");
    expect(screen.getByTestId("mobile-stash-discard").textContent).toBe(t("mobile.stash_discard")); // 확인 상태가 새 항목으로 새지 않는다

    fireEvent.click(screen.getByTestId("mobile-stash-insert"));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0][1]).toMatchObject({ body_md: "older text" });
  });

  it("switching to a note that has a stash raises the banner (the hook follows the active note id)", async () => {
    keep({ noteId: "note-b" });
    mount();
    await screen.findByTestId("editor-content");
    expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull();

    act(() => useNotesStore.setState({ activeNote: noteWith("note-b") } as any));
    expect(await screen.findByTestId("mobile-stash-recovery")).toBeTruthy();
    act(() => useNotesStore.setState({ activeNote: noteWith("note-r") } as any));
    await waitFor(() => expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull());
  });

  it("a capture draft's stash comes back on the next draft and materializes it on insert", async () => {
    keep({ noteId: "__draft__" });
    ensureMaterialized.mockResolvedValue("real-note-id");
    useNotesStore.setState({ activeNote: noteWith("__draft__"), activeDraft: true } as any);
    mount();
    fireEvent.click(await screen.findByTestId("mobile-stash-insert"));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(ensureMaterialized).toHaveBeenCalled();
    expect(createCalls()[0][1]).toMatchObject({ note_id: "real-note-id", body_md: "lost text" });
  });

  it("a draft stash whose note cannot be created yet (server still down) keeps the stash and the banner, no unhandled rejection", async () => {
    keep({ noteId: "__draft__" });
    ensureMaterialized.mockRejectedValue({ code: "IO", message: "server down" });
    useNotesStore.setState({ activeNote: noteWith("__draft__"), activeDraft: true } as any);
    mount();
    fireEvent.click(await screen.findByTestId("mobile-stash-insert"));
    await waitFor(() => expect(ensureMaterialized).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId("mobile-stash-insert") as HTMLButtonElement).disabled).toBe(false));
    expect(createCalls()).toHaveLength(0);
    expect(screen.getByTestId("mobile-stash-recovery")).toBeTruthy();
    expect(stashesForNote("__draft__").map((x) => x.bodyMd)).toEqual(["lost text"]);
  });

  it("a sheet/diagram stash is recreated with its own kind", async () => {
    keep({ kind: "sheet", sectionName: "Budget", bodyMd: '{"v":1}' });
    mount();
    fireEvent.click(await screen.findByTestId("mobile-stash-insert"));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0][1]).toMatchObject({ kind: "sheet", body_md: '{"v":1}' });
  });
});

// 2026-10-06 실기기 검증: 노트를 열면 기본 섹션이 마지막 섹션이라, 마지막이 시트면 노트 로드 효과가
// 시트 분기 없이 시트 JSON 을 편집 가능한 본문으로 열었다(switchSection 만 시트를 알았다).
describe("MobileNote — 마지막 섹션이 시트인 노트를 열면", () => {
  it("시트 편집기를 보여 주고 시트 JSON 을 본문 편집기에 넣지 않는다", async () => {
    setContentMock.mockClear();
    const sheetJson = '{"v":1,"rows":100,"cols":[{}],"cells":{"B1":{"raw":"x"}},"charts":[]}';
    const activeNote = draftActiveNote([
      { id: "t1", body_md: "prose" },
      { id: "sh1", body_md: sheetJson, kind: "sheet" },
    ]);
    activeNote.note.id = "note-sheet";
    useNotesStore.setState({ activeNote, activeBodyEmpty: false } as any);

    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);

    expect((await screen.findByTestId("sheet-editor")).textContent).toBe("sh1");
    expect(screen.queryByTestId("editor-content")).toBeNull();
    expect(setContentMock.mock.calls.some((c) => c[0] === sheetJson)).toBe(false);
  });
});

// ───────────────────────── S2 입력: 음성·위치·메타 제안 칩 (E1) ─────────────────────────
const AUDIO_ATT = { id: "att1", name: "v.weba", kind: "audio", rel_path: "n/v.weba", url: null, size_bytes: 1000, position: 0 };
const REC = {
  recordedAt: "2026-10-06T14:32:00+09:00",
  durationMs: 84000,
  lat: 37.5,
  lng: 127,
};
const callSilentFn = () => vi.mocked(callSilentMock) as unknown as ReturnType<typeof vi.fn>;
const callFn = () => vi.mocked(callFromInvoke) as unknown as ReturnType<typeof vi.fn>;
const restoreCall = () =>
  callFn().mockImplementation(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {}));
let silentImpl: (cmd: string, args?: any) => Promise<any>;

function setupInputNote(opts: { sections?: any[]; attachments?: any[]; region?: string | null; id?: string } = {}) {
  const activeNote = draftActiveNote(opts.sections ?? [{ id: "s1", body_md: "" }]);
  activeNote.note.id = opts.id ?? "note-v";
  activeNote.note.region = opts.region ?? null;
  activeNote.attachments = opts.attachments ?? [];
  const setRegion = vi.fn(async (r: string | null) => {
    const n = useNotesStore.getState().activeNote!;
    useNotesStore.setState({ activeNote: { ...n, note: { ...n.note, region: r } } } as any);
  });
  useNotesStore.setState({
    activeNote,
    activeBodyEmpty: false,
    savedState: "saved",
    ensureMaterialized: vi.fn(async () => activeNote.note.id),
    updateSectionBody: vi.fn(async () => {}),
    reloadActive: vi.fn(async () => {}),
    setRegion,
    setLocation: vi.fn(async () => {}),
  } as any);
  return { setRegion };
}

function transcribeCalls() {
  return callSilentFn().mock.calls.filter((c) => c[0] === "audio_transcribe");
}
function markCalls() {
  return callSilentFn().mock.calls.filter((c) => c[0] === "attachment_transcript_mark_inserted");
}
async function finishRecording() {
  await act(async () => {
    recorderProps.onFinished({ file: new File(["x"], "v.weba", { type: "audio/webm" }), ...REC });
  });
}

describe("MobileNote — 음성 녹음 → 업로드 → 받아쓰기 → 본문 삽입 (S2-3)", () => {
  beforeEach(() => {
    localStorage.clear();
    insertContentAtMock.mockClear();
    insertContentMock.mockClear();
    editorFocusedMock = false;
    fakeMarkdown = "";
    recorderProps = null;
    useSettingsStore.setState({
      aiEnabled: true,
      uiLang: "en",
      voiceTranscribeMode: "auto",
      voiceCleanupMode: "off",
      dateNudgeEnabled: false,
      dateNudgeAuto: false,
    } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    silentImpl = async (cmd) => {
      if (cmd === "audio_transcribe") return { text: "hello world\nsecond line" };
      if (cmd === "workspace_status_list") return { statuses: [] };
      return { ok: true };
    };
    callSilentFn().mockReset();
    callSilentFn().mockImplementation((cmd: string, args?: any) => silentImpl(cmd, args));
    restoreCall();
    callFn().mockClear();
    vi.mocked(uploadAttachmentMock).mockReset();
    vi.mocked(uploadAttachmentMock).mockResolvedValue(AUDIO_ATT as any);
    setupInputNote();
  });
  afterEach(() => {
    callSilentFn().mockReset();
    callSilentFn().mockImplementation(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {}));
    restoreCall();
    fakeMarkdown = "";
  });

  it("the speed dial's 녹음 action opens the recorder sheet", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    expect(screen.queryByTestId("fake-recorder")).toBeNull();
    fireEvent.click(await screen.findByTestId("mobile-fab-toggle"));
    fireEvent.click(screen.getByLabelText("Voice recording"));
    expect(screen.getByTestId("fake-recorder")).toBeTruthy();
  });

  it("uploads the recording through the shared path with recordedAt/lat/lng as upload meta", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledTimes(1));
    const [noteId, file, meta] = vi.mocked(uploadAttachmentMock).mock.calls[0] as any[];
    expect(noteId).toBe("note-v");
    expect(file.name).toBe("v.weba");
    expect(meta).toEqual({ recordedAt: REC.recordedAt, lat: 37.5, lng: 127 });
  });

  it("auto: transcribes after upload, inserts a quote block at the body end (not focused) and marks it inserted", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(transcribeCalls()[0][1]).toEqual({ note_id: "note-v", attachment_id: "att1" });
    expect(markCalls()[0][1]).toEqual({ attachment_id: "att1" });
    // 키보드를 올리지 않는 본문 끝 삽입(insertContentAt) — 포커스 경로는 쓰지 않는다.
    expect(insertContentAtMock).toHaveBeenCalledTimes(1);
    expect(insertContentMock).not.toHaveBeenCalled();
    const [pos, node] = insertContentAtMock.mock.calls[0];
    expect(pos).toBe(42);
    expect(node.type).toBe("blockquote");
    const texts = node.content.map((p: any) => p.content[0].text);
    expect(texts[0]).toMatch(/^🎙 \d\d:\d\d · 1m 24s$/); // 머리말: 시각 · 길이
    expect(texts.slice(1)).toEqual(["hello world", "second line"]);
    expect(useNotesStore.getState().activeNote!.attachments[0].transcript_inserted).toBe(true);
  });

  it("auto while typing: still goes to the END of the body, never the caret (M-13)", async () => {
    editorFocusedMock = true;
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(insertContentAtMock).toHaveBeenCalledTimes(1);
    expect(insertContentMock).not.toHaveBeenCalled();
  });

  it("ask: no transcription until the row button is pressed", async () => {
    useSettingsStore.setState({ voiceTranscribeMode: "ask" } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    const btn = await screen.findByText("Transcribe and insert");
    expect(transcribeCalls()).toHaveLength(0);
    fireEvent.click(btn);
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(transcribeCalls()).toHaveLength(1);
    expect(insertContentAtMock).toHaveBeenCalledTimes(1);
  });

  it("off: the recording is just attached — no call, no button", async () => {
    useSettingsStore.setState({ voiceTranscribeMode: "off" } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    await waitFor(() => expect(screen.getByText("v.weba")).toBeTruthy());
    expect(transcribeCalls()).toHaveLength(0);
    expect(screen.queryByText("Transcribe and insert")).toBeNull();
  });

  it("AI off (server code ai_required): explains it on the row, no retry button, nothing inserted", async () => {
    silentImpl = async (cmd) => {
      if (cmd === "audio_transcribe") throw { code: "VALIDATION", message: "ai_required: AI is off" };
      return {};
    };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    expect(await screen.findByText(/needs an AI connection/)).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
    expect(insertContentAtMock).not.toHaveBeenCalled();
    expect(markCalls()).toHaveLength(0);
  });

  it("cleanup ask: after inserting, the row offers a tidy-up button; off offers none", async () => {
    useSettingsStore.setState({ voiceCleanupMode: "ask" } as any);
    const { unmount } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    expect(await screen.findByText("Tidy up transcript")).toBeTruthy();
    unmount();

    useSettingsStore.setState({ voiceCleanupMode: "off" } as any);
    setupInputNote();
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    await waitFor(() => expect(markCalls()).toHaveLength(2));
    expect(screen.queryByText("Tidy up transcript")).toBeNull();
  });

  it("a generic failure shows Retry; retrying succeeds and inserts", async () => {
    let fail = true;
    silentImpl = async (cmd) => {
      if (cmd === "audio_transcribe") {
        if (fail) throw { code: "AI", message: "boom" };
        return { text: "ok now" };
      }
      return {};
    };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    const retry = await screen.findByText("Retry");
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(insertContentAtMock).toHaveBeenCalledTimes(1);
  });

  it("reopen: a stored transcript that was never inserted offers the chip; an inserted one does not", async () => {
    setupInputNote({ attachments: [{ ...AUDIO_ATT, transcript: "stored words", transcript_inserted: false }] });
    const { unmount } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByText("Transcript ready · Insert"));
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    expect(transcribeCalls()).toHaveLength(0); // 서버에 이미 있다 — 다시 부르지 않는다
    expect(insertContentAtMock.mock.calls[0][1].content[1].content[0].text).toBe("stored words");
    unmount();

    setupInputNote({ attachments: [{ ...AUDIO_ATT, transcript: "stored words", transcript_inserted: true }] });
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByText("v.weba");
    expect(screen.queryByText("Transcript ready · Insert")).toBeNull();
  });

  it("NEGATIVE: if the body save fails the transcript is NOT marked inserted (the chip stays for a retry)", async () => {
    fakeMarkdown = "typed text"; // flush 가 실제 쓰기를 시도하게
    const failing = vi.fn(async () => {
      useNotesStore.setState({ savedState: "failed" } as any);
    });
    useNotesStore.setState({ updateSectionBody: failing } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    await finishRecording();
    await waitFor(() => expect(insertContentAtMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(failing).toHaveBeenCalled());
    await act(async () => {});
    expect(markCalls()).toHaveLength(0);
    expect(await screen.findByText("Transcript ready · Insert")).toBeTruthy();
  });

  it("a diagram section has no body to type into: the transcript becomes its own text section", async () => {
    setupInputNote({ sections: [{ id: "d1", body_md: '{"v":1,"nodes":[],"edges":[]}', kind: "diagram" }] });
    callFn().mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "section_create_with_body") {
        return { id: "new1", name: args.name, body_md: args.body_md, position: 1, kind: "text" };
      }
      return cmd === "workspace_status_list" ? { statuses: [] } : {};
    });
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("diagram-source");
    await finishRecording();
    await waitFor(() => expect(markCalls()).toHaveLength(1));
    const created = callFn().mock.calls.find((c) => c[0] === "section_create_with_body")!;
    expect(created[1].name).toBe("Transcript");
    expect(created[1].body_md).toMatch(/^> 🎙 /);
    expect(created[1].body_md).toContain("> hello world");
    expect(insertContentAtMock).not.toHaveBeenCalled();
  });

  describe("날짜 후보(date_nudge_* 정책)", () => {
    beforeEach(() => {
      silentImpl = async (cmd) => (cmd === "audio_transcribe" ? { text: "dentist appointment tomorrow at 3pm" } : {});
      callFn().mockImplementation(async (cmd: string) => (cmd === "note_date_add" ? { id: "d9" } : {}));
    });
    it("suggest: a chip, applied through note_date_add", async () => {
      useSettingsStore.setState({ dateNudgeEnabled: true, dateNudgeAuto: false } as any);
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      await finishRecording();
      const chip = await screen.findByTestId("mobile-input-chips");
      expect(chip.textContent).toMatch(/as a date\?/);
      fireEvent.click(screen.getByText("Apply"));
      await waitFor(() => {
        const c = callFn().mock.calls.find((x) => x[0] === "note_date_add");
        expect(c![1].note_id).toBe("note-v");
        expect(c![1].start_time).toBe("15:00");
      });
      await waitFor(() => expect(screen.queryByTestId("mobile-input-chips")).toBeNull());
    });
    it("auto: adds the date straight away with an undo toast", async () => {
      useSettingsStore.setState({ dateNudgeEnabled: true, dateNudgeAuto: true } as any);
      vi.mocked(showToastMock).mockClear();
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      await finishRecording();
      await waitFor(() => expect(callFn().mock.calls.some((x) => x[0] === "note_date_add")).toBe(true));
      await waitFor(() => expect(showToastMock).toHaveBeenCalled());
      expect(screen.queryByTestId("mobile-input-chips")).toBeNull();
    });
    it("off: neither a chip nor a date", async () => {
      useSettingsStore.setState({ dateNudgeEnabled: false } as any);
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      await finishRecording();
      await waitFor(() => expect(markCalls()).toHaveLength(1));
      expect(screen.queryByTestId("mobile-input-chips")).toBeNull();
      expect(callFn().mock.calls.some((x) => x[0] === "note_date_add")).toBe(false);
    });
  });

  // 녹음 시트의 결과 단계(stageOf) — 시트는 가짜라 MobileNote 가 넘기는 stageOf 를 직접 읽는다.
  describe("result stage in the recorder sheet (stageOf)", () => {
    const stageFor = (f: File) => recorderProps.stageOf(f);
    async function finishWith(): Promise<File> {
      const file = new File(["x"], "v.weba", { type: "audio/webm" });
      await act(async () => {
        void recorderProps.onFinished({ file, ...REC });
      });
      return file;
    }

    it("auto: uploading -> transcribing -> done with the text and where it went (the body)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      silentImpl = async (cmd) => {
        if (cmd === "audio_transcribe") { await gate; return { text: "hello world" }; }
        return {};
      };
      let finishUpload!: () => void;
      vi.mocked(uploadAttachmentMock).mockImplementation(
        () => new Promise((r) => { finishUpload = () => r(AUDIO_ATT as any); }),
      );
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      const file = await finishWith();
      expect(stageFor(file)).toEqual({ kind: "saving" });
      await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalled());
      await act(async () => { finishUpload(); });
      await waitFor(() => expect(stageFor(file)).toEqual({ kind: "transcribing" }));
      await act(async () => { release(); });
      await waitFor(() => expect(stageFor(file)).toEqual({ kind: "done", text: "hello world", placed: "body" }));
      expect(stageFor(new File(["y"], "other.weba"))).toBeNull(); // a file this sheet never handed off
    });

    it("closing the sheet mid-transcription does not cancel it — the transcript still lands in the body", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      silentImpl = async (cmd) => {
        if (cmd === "audio_transcribe") { await gate; return { text: "later words" }; }
        return {};
      };
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      fireEvent.click(await screen.findByTestId("mobile-fab-toggle"));
      fireEvent.click(screen.getByLabelText("Voice recording"));
      const file = await finishWith();
      await waitFor(() => expect(stageFor(file)).toEqual({ kind: "transcribing" }));
      act(() => recorderProps.onClose());
      expect(screen.queryByTestId("fake-recorder")).toBeNull();
      await act(async () => { release(); });
      await waitFor(() => expect(markCalls()).toHaveLength(1));
      expect(insertContentAtMock).toHaveBeenCalledTimes(1);
    });

    it("ask: the stage offers transcription; accepting it in the sheet runs the same path as the row button", async () => {
      useSettingsStore.setState({ voiceTranscribeMode: "ask" } as any);
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      const file = await finishWith();
      await waitFor(() => expect(stageFor(file)?.kind).toBe("offer"));
      expect(transcribeCalls()).toHaveLength(0);
      act(() => stageFor(file).transcribe());
      await waitFor(() => expect(stageFor(file)?.kind).toBe("done"));
      expect(transcribeCalls()).toHaveLength(1);
      expect(markCalls()).toHaveLength(1);
    });

    it("off: no stage — the sheet keeps its saved-then-close beat", async () => {
      useSettingsStore.setState({ voiceTranscribeMode: "off" } as any);
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      const file = await finishWith();
      expect(stageFor(file)).toBeNull();
    });

    it("upload failure: in-sheet retry re-uploads the same recording, then transcription follows", async () => {
      vi.mocked(uploadAttachmentMock).mockRejectedValueOnce(new Error("offline"));
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      const file = await finishWith();
      await waitFor(() => expect(stageFor(file)?.kind).toBe("upload_failed"));
      act(() => stageFor(file).retry());
      await waitFor(() => expect(stageFor(file)?.kind).toBe("done"));
      expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);
      expect((vi.mocked(uploadAttachmentMock).mock.calls[1] as any[])[1]).toBe(file);
    });

    it("transcription failure: a retry for a generic error, none when AI is off", async () => {
      silentImpl = async (cmd) => {
        if (cmd === "audio_transcribe") throw { code: "AI", message: "boom" };
        return {};
      };
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      const file = await finishWith();
      await waitFor(() => expect(stageFor(file)?.kind).toBe("transcribe_failed"));
      expect(stageFor(file).code).toBe("failed");
      silentImpl = async (cmd) => (cmd === "audio_transcribe" ? { text: "second try" } : {});
      act(() => stageFor(file).retry());
      await waitFor(() => expect(stageFor(file)).toEqual({ kind: "done", text: "second try", placed: "body" }));
    });

    it("AI off: transcription failure carries no retry", async () => {
      silentImpl = async (cmd) => {
        if (cmd === "audio_transcribe") throw { code: "VALIDATION", message: "ai_required: AI is off" };
        return {};
      };
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("editor-content");
      const file = await finishWith();
      await waitFor(() => expect(stageFor(file)?.kind).toBe("transcribe_failed"));
      expect(stageFor(file)).toEqual({ kind: "transcribe_failed", code: "ai_required", retry: undefined });
    });
  });
});

describe("MobileNote — 현재 위치(기기별 loc 모드, 새 노트 첫 저장 시점)", () => {
  const resolve = () => vi.mocked(resolveLocationMock) as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en", voiceTranscribeMode: "off" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    resolve().mockReset();
    resolve().mockResolvedValue({ region: "Seoul", lat: 37.5, lng: 127 });
    vi.mocked(isDeniedMock).mockReturnValue(false);
    vi.mocked(showToastMock).mockClear();
    restoreCall();
    callFn().mockClear();
  });

  it("auto: applies the region in the background and shows an undo toast", async () => {
    setLocMode("auto");
    const { setRegion } = setupInputNote({ id: "note-loc" });
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await waitFor(() => expect(setRegion).toHaveBeenCalledWith("Seoul"));
    expect(showToastMock).toHaveBeenCalled();
    expect(vi.mocked(showToastMock).mock.calls[0][0]).toContain("Seoul");
    // 되돌리기 토스트가 지역을 비운다.
    await act(async () => {
      vi.mocked(showToastMock).mock.calls[0][1]();
    });
    await waitFor(() => expect(setRegion).toHaveBeenLastCalledWith(null));
  });

  it("ask: a chip, and no position is read until the user taps it", async () => {
    setLocMode("ask");
    const { setRegion } = setupInputNote({ id: "note-loc" });
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    const chips = await screen.findByTestId("mobile-input-chips");
    expect(chips.textContent).toMatch(/current location/);
    expect(resolve()).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(setRegion).toHaveBeenCalledWith("Seoul"));
    await waitFor(() => expect(screen.queryByTestId("mobile-input-chips")).toBeNull());
  });

  it("off, a denied permission, a non-capture screen, or an existing region: never tries", async () => {
    setLocMode("off");
    setupInputNote({ id: "note-loc" });
    const a = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await screen.findByTestId("editor-content");
    a.unmount();

    setLocMode("auto");
    vi.mocked(isDeniedMock).mockReturnValue(true);
    setupInputNote({ id: "note-loc2" });
    const b = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await screen.findByTestId("editor-content");
    b.unmount();
    vi.mocked(isDeniedMock).mockReturnValue(false);

    setupInputNote({ id: "note-loc3" });
    const c = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    c.unmount();

    // NEGATIVE: 대표 지역이 이미 있으면 자동 모드여도 위치를 읽지 않는다.
    setupInputNote({ id: "note-loc4", region: "Busan" });
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await screen.findByTestId("editor-content");
    await act(async () => {});
    expect(resolve()).not.toHaveBeenCalled();
  });

  it("auto never overwrites a region that someone filled while the position was being read", async () => {
    setLocMode("auto");
    const { setRegion } = setupInputNote({ id: "note-loc" });
    resolve().mockImplementation(async () => {
      const n = useNotesStore.getState().activeNote!;
      useNotesStore.setState({ activeNote: { ...n, note: { ...n.note, region: "Jeju" } } } as any);
      return { region: "Seoul", lat: 1, lng: 2 };
    });
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await waitFor(() => expect(resolve()).toHaveBeenCalled());
    await act(async () => {});
    expect(setRegion).not.toHaveBeenCalled();
    expect(useNotesStore.getState().activeNote!.note.region).toBe("Jeju");
  });
});

describe("MobileNote — 서버 이벤트 attachment-meta-* (사진/오디오 메타)", () => {
  const fire = (name: string, payload: any) => {
    const spec = listenSpecs.find((s) => s[0] === name)!;
    act(() => spec[1]({ payload }));
  };
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en", voiceTranscribeMode: "off" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    vi.mocked(showToastMock).mockClear();
    restoreCall();
    callFn().mockClear();
    setupInputNote({ id: "note-m" });
  });

  it("suggested -> a chip; Apply adds the date and fills the empty primary region", async () => {
    callFn().mockImplementation(async (cmd: string) => (cmd === "note_date_add" ? { id: "d1" } : {}));
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    fire("attachment-meta-suggested", {
      note_id: "note-m",
      date: { year: 2026, month: 10, day: 3, time: "09:30" },
      region: { name: "Seoul", lat: 37.5, lng: 127 },
    });
    expect((await screen.findByTestId("mobile-input-chips")).textContent).toContain("2026-10-03 09:30 · Seoul");
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => {
      const c = callFn().mock.calls.find((x) => x[0] === "note_date_add")!;
      expect(c[1]).toMatchObject({ note_id: "note-m", year: 2026, month: 10, day: 3, start_time: "09:30" });
    });
    await waitFor(() => expect(useNotesStore.getState().setRegion).toHaveBeenCalledWith("Seoul"));
    await waitFor(() => expect(screen.queryByTestId("mobile-input-chips")).toBeNull());
  });

  it("with a primary region already set, the suggested place becomes a waypoint instead", async () => {
    setupInputNote({ id: "note-m", region: "Busan" });
    callFn().mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [{ position: 0 }] } : {}));
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    fire("attachment-meta-suggested", { note_id: "note-m", region: { name: "Seoul", lat: 37.5, lng: 127 } });
    fireEvent.click(await screen.findByText("Apply"));
    await waitFor(() => {
      const c = callFn().mock.calls.find((x) => x[0] === "note_region_add")!;
      expect(c[1]).toMatchObject({ note_id: "note-m", name: "Seoul" });
    });
    expect(useNotesStore.getState().setRegion).not.toHaveBeenCalled();
  });

  it("applied -> the shared undo toast", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    fire("attachment-meta-applied", { note_id: "note-m", date_row_id: "r1", summary: "2026-10-03 · Seoul" });
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(vi.mocked(showToastMock).mock.calls[0][0]).toContain("2026-10-03 · Seoul");
  });

  it("NEGATIVE: another note's or another client's event is ignored", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    fire("attachment-meta-suggested", { note_id: "other-note", region: { name: "X", lat: 1, lng: 2 } });
    fire("attachment-meta-suggested", { note_id: "note-m", client: "someone-else", region: { name: "Y", lat: 1, lng: 2 } });
    fire("attachment-meta-applied", { note_id: "other-note", date_row_id: "r1", summary: "S" });
    fire("attachment-meta-applied", { note_id: "note-m", client: "someone-else", date_row_id: "r1", summary: "S" });
    await act(async () => {});
    expect(screen.queryByTestId("mobile-input-chips")).toBeNull();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe("MobileNote — 업로드 줄 신뢰성 (적대적 리뷰 반영)", () => {
  beforeEach(() => {
    localStorage.clear();
    recorderProps = null;
    insertContentAtMock.mockClear();
    useSettingsStore.setState({
      aiEnabled: true,
      uiLang: "en",
      voiceTranscribeMode: "auto",
      voiceCleanupMode: "off",
      dateNudgeEnabled: false,
      dateNudgeAuto: false,
    } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    silentImpl = async (cmd) => (cmd === "audio_transcribe" ? { text: "hello" } : { ok: true });
    callSilentFn().mockReset();
    callSilentFn().mockImplementation((cmd: string, args?: any) => silentImpl(cmd, args));
    restoreCall();
    callFn().mockClear();
    vi.mocked(uploadAttachmentMock).mockReset();
    vi.mocked(uploadAttachmentMock).mockResolvedValue(AUDIO_ATT as any);
    setupInputNote({ id: "note-a" });
  });
  afterEach(() => {
    callSilentFn().mockReset();
    callSilentFn().mockImplementation(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : {}));
    restoreCall();
  });

  const rec = () => ({ file: new File(["x"], "v.weba", { type: "audio/webm" }), ...REC });

  it("onFinished resolves true after a successful upload and false after a failed one", async () => {
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    let ok: boolean | undefined;
    await act(async () => { ok = await recorderProps.onFinished(rec()); });
    expect(ok).toBe(true);
    vi.mocked(uploadAttachmentMock).mockRejectedValueOnce(new Error("net"));
    await act(async () => { ok = await recorderProps.onFinished(rec()); });
    expect(ok).toBe(false);
  });

  it("a queued upload stays bound to the note it was recorded in: no cross-note attach, transcribe or insert", async () => {
    // 현재 활성 노트를 그대로 돌려주는 ensureMaterialized — 실행 시점에 부르면 B 로 샌다.
    useNotesStore.setState({ ensureMaterialized: vi.fn(async () => useNotesStore.getState().activeNote!.note.id) } as any);
    let release!: () => void;
    vi.mocked(uploadAttachmentMock).mockImplementationOnce(
      () => new Promise((res) => { release = () => res({ ...AUDIO_ATT, id: "att-first" } as any); }),
    );
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    let second!: Promise<boolean>;
    await act(async () => {
      void recorderProps.onFinished(rec()); // 첫 업로드가 줄을 붙잡는다
      second = recorderProps.onFinished(rec()); // 이 항목은 A 에서 기록됐지만 B 로 이동한 뒤에 실행된다
    });
    await act(async () => {
      const a = useNotesStore.getState().activeNote!;
      useNotesStore.setState({ activeNote: { ...a, note: { ...a.note, id: "note-b" }, attachments: [] } } as any);
    });
    await act(async () => { release(); await second; });
    const noteIds = vi.mocked(uploadAttachmentMock).mock.calls.map((c) => c[0]);
    expect(noteIds).toEqual(["note-a", "note-a"]);
    expect(useNotesStore.getState().activeNote!.attachments).toEqual([]); // B 에 낙관 반영 없음
    expect(transcribeCallsAll()).toHaveLength(0);
    expect(insertContentAtMock).not.toHaveBeenCalled();
  });

  it("an upload left in error blocks leaving the note (same gate as an unsaved body); retry clears it", async () => {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
    vi.mocked(uploadAttachmentMock).mockRejectedValueOnce(new Error("net"));
    await act(async () => { await recorderProps.onFinished(rec()); });
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    const proceed = vi.fn();
    act(() => ref.current!.showLeaveBlocked(proceed));
    expect((await screen.findByTestId("mobile-save-failed")).textContent).toContain(t("mobileVoice.leave_upload_failed"));
    fireEvent.click(within(screen.getByTestId("mobile-save-failed")).getByText("Retry"));
    await waitFor(() => expect(ref.current!.hasUnsavedFailure()).toBe(false));
  });

  it("a failing region step rolls the already-added date row back so a re-tap does not duplicate it", async () => {
    setupInputNote({ id: "note-a" });
    const setRegion = vi.fn(async () => { throw new Error("region failed"); });
    useNotesStore.setState({ setRegion } as any);
    callFn().mockImplementation(async (cmd: string) => (cmd === "note_date_add" ? { id: "d1" } : {}));
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("editor-content");
    const spec = listenSpecs.find((s) => s[0] === "attachment-meta-suggested")!;
    act(() => spec[1]({ payload: { note_id: "note-a", date: { year: 2026, month: 10, day: 3 }, region: { name: "Seoul", lat: 1, lng: 2 } } }));
    fireEvent.click(await screen.findByText("Apply"));
    await waitFor(() => expect(callFn().mock.calls.some((c) => c[0] === "note_date_remove" && c[1].id === "d1")).toBe(true));
    expect(screen.getByTestId("mobile-input-chips")).toBeTruthy(); // 칩은 남아 다시 누를 수 있다
  });
});

function transcribeCallsAll() {
  return callSilentFn().mock.calls.filter((c) => c[0] === "audio_transcribe");
}

// ───────────────────────── D2② W3: 저장 충돌 배너 ─────────────────────────
describe("MobileNote — save conflict (D2②)", () => {
  // 앞 describe 들이 setState 로 갈아 끼운 액션 대신 진짜 스토어 액션을 쓴다(수집 시점에 잡아 둔다).
  const real = useNotesStore.getState();
  const callFn = () => callFromInvoke as unknown as ReturnType<typeof vi.fn>;
  let serverToken = "t-remote";
  let defaultImpl: any;

  const noteDetail = (body: string) => {
    const n = draftActiveNote([{ id: "s1", body_md: body }]);
    n.note.id = "note-c";
    n.sections[0].updated_at = serverToken;
    return n;
  };

  beforeEach(async () => {
    const { __resetSectionTokens, seedSectionTokens } = await import("../lib/sectionTokens");
    __resetSectionTokens();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    fakeMarkdown = "my local text";
    serverToken = "t-remote";
    defaultImpl = callFn().getMockImplementation();
    callFn().mockImplementation(async (cmd: string, args: any) => {
      switch (cmd) {
        case "workspace_status_list":
          return { statuses: [] };
        case "section_update":
          if (args.expected_updated_at !== undefined && args.expected_updated_at !== serverToken) {
            throw { code: "CONFLICT", message: "conflict" };
          }
          serverToken = `${serverToken}+`;
          return { updated_at: "note-ts", section_updated_at: serverToken };
        case "note_get":
          return noteDetail("remote text");
        case "section_create_with_body":
          return { id: "copy1", name: args.name, body_md: args.body_md, position: 1, kind: args.kind };
        default:
          return {};
      }
    });
    useNotesStore.setState({
      activeNote: noteDetail("old"),
      activeDraft: false,
      activeBodyEmpty: false,
      savedState: "saved",
      saveConflict: null,
      updateSectionBody: real.updateSectionBody,
      resolveSaveConflict: real.resolveSaveConflict,
      reloadActive: real.reloadActive,
    } as any);
    seedSectionTokens([{ id: "s1", updated_at: "t-stale" }]); // 이 기기가 본 토큰은 낡았다
  });
  afterEach(() => {
    fakeMarkdown = "";
    callFn().mockImplementation(defaultImpl as any);
    useNotesStore.setState({ saveConflict: null } as any);
  });

  const sectionUpdates = () => callFn().mock.calls.filter((c) => c[0] === "section_update").map((c) => c[1]);

  async function renderConflicted() {
    const ref = createRef<MobileNoteHandle>();
    render(<MobileNote ref={ref} onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    return ref;
  }

  it("shows conflict wording with both actions (no plain retry) and keeps leave blocked", async () => {
    const ref = await renderConflicted();
    const banner = await screen.findByTestId("mobile-save-failed");
    expect(banner.textContent).toContain(t("mobile.save_conflict_named", { name: "Overview" })); // 어느 섹션인지 이름을 밝힌다
    expect(screen.getByTestId("mobile-conflict-copy")).toBeTruthy();
    expect(screen.getByTestId("mobile-conflict-overwrite")).toBeTruthy();
    expect(within(banner).queryByText(t("mobile.save_retry"))).toBeNull();
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    expect(useNotesStore.getState().savedState).toBe("failed");
    // 다시 flush 해도 서버로 다시 보내지 않는다(조용한 재시도 없음) — 나가기도 계속 막힌다.
    const before = sectionUpdates().length;
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(sectionUpdates().length).toBe(before);
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
  });

  it("leave stays blocked by the conflict even after another write resets savedState", async () => {
    const ref = await renderConflicted();
    act(() => useNotesStore.setState({ savedState: "saved" } as any));
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy();
  });

  it("copy mine: creates a section with the local body, then reloads; banner and leave-block clear", async () => {
    const ref = await renderConflicted();
    fireEvent.click(await screen.findByTestId("mobile-conflict-copy"));
    await waitFor(() => expect(useNotesStore.getState().saveConflict).toBeNull());
    const calls = callFn().mock.calls.map((c) => c[0]);
    const create = callFn().mock.calls.find((c) => c[0] === "section_create_with_body");
    expect(create?.[1]).toMatchObject({ note_id: "note-c", body_md: "my local text", kind: "text" });
    expect(calls.lastIndexOf("note_get")).toBeGreaterThan(calls.indexOf("section_create_with_body"));
    // 원본 섹션은 내 본문으로 덮지 않았다.
    expect(sectionUpdates().filter((u: any) => u.expected_updated_at === "t-remote")).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId("mobile-save-failed")).toBeNull());
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("overwrite: resends the local body with the freshly read token", async () => {
    const ref = await renderConflicted();
    fireEvent.click(await screen.findByTestId("mobile-conflict-overwrite"));
    await waitFor(() => expect(screen.queryByTestId("mobile-save-failed")).toBeNull());
    expect(sectionUpdates()).toContainEqual({ id: "s1", body_md: "my local text", expected_updated_at: "t-remote" });
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("leave-anyway during a conflict keeps the editor body AND the other sections' gate-held bodies on the device", async () => {
    localStorage.clear();
    const { holdConflictBody } = await import("../lib/sectionTokens");
    const n = noteDetail("old");
    // 노트를 열면 기본 섹션은 마지막 섹션이다 — 충돌 나는 s1 이 마지막이어야 에디터에 뜬다.
    n.sections.unshift({ id: "s2", name: "Notes", body_md: "srv2", position: 0, kind: "text" });
    useNotesStore.setState({ activeNote: n } as any);
    const ref = await renderConflicted();
    holdConflictBody("s2", "held body of section two"); // 폰에서 섹션을 옮기면 게이트가 그 본문의 유일한 사본이다
    const proceed = vi.fn();
    act(() => ref.current!.showLeaveBlocked(proceed));

    fireEvent.click(await screen.findByText("Leave anyway"));
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    const kept = stashesForNote("note-c");
    expect(kept.map((k) => [k.sectionId, k.sectionName, k.bodyMd]).sort()).toEqual([
      ["s1", "Overview", "my local text"],
      ["s2", "Notes", "held body of section two"],
    ]);
  });

  it("leave-anyway during a conflict whose bodyUnsaved flag was cleared still rescues the gate-held body of the open section", async () => {
    localStorage.clear();
    const ref = await renderConflicted();
    // 다른 저장이 성공하거나 에디터가 서버본과 같아지면 bodyUnsaved 는 풀리지만 충돌은 열려 있고 내 글은 게이트에만 있다.
    fakeMarkdown = "old";
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(ref.current!.hasUnsavedFailure()).toBe(true); // conflictOpen 이 막는다
    const proceed = vi.fn();
    act(() => ref.current!.showLeaveBlocked(proceed));

    fireEvent.click(await screen.findByText("Leave anyway"));
    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(stashesForNote("note-c").map((k) => [k.sectionId, k.bodyMd])).toEqual([["s1", "my local text"]]);
  });
});

describe("MobileNote — 폰 입력 감지 칩 (날짜·지역·링크·#태그)", () => {
  const DATE_NUDGE = {
    payload: { year: 2026, month: 10, day: 8, start_time: "15:00", remind: true },
    label: "2026.10.08 15:00",
    matchFrom: 0,
    matchTo: 8,
    paraStart: 1,
    paraText: "내일 오후 3시 치과",
  };
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      aiEnabled: true,
      uiLang: "en",
      voiceTranscribeMode: "off",
      dateNudgeEnabled: true,
      dateNudgeAuto: false,
    } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
    vi.mocked(showToastMock).mockClear();
    nudgeH.state = {};
    nudgeH.dismiss.mockClear();
    nudgeH.applyDateMark.mockClear();
    nudgeH.stripDateMark.mockClear();
    nudgeH.replaceTagToken.mockClear();
    nudgeH.importLinks.mockClear();
    restoreCall();
    callFn().mockClear();
    setupInputNote({ id: "note-n" });
  });
  afterEach(() => {
    nudgeH.state = {};
  });

  it("날짜 칩: 누르면 note_date_add → 매치 범위에 마크 → 되돌리기 토스트(마크 걷기 + note_date_remove)", async () => {
    callFn().mockImplementation(async (cmd: string) => (cmd === "note_date_add" ? { id: "d1" } : {}));
    nudgeH.state = { date: DATE_NUDGE };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    // 날짜는 키보드 위 칩 줄이 아니라 문장 위 말풍선이다.
    const row = await screen.findByTestId("mobile-nudge-bubble");
    expect(screen.queryByTestId("mobile-nudge-chips")).toBeNull();
    expect(row.textContent).toContain("10.08 15:00"); // 알약은 짧은 날짜(올해면 연도 생략), 전체 문구는 aria-label
    fireEvent.click(within(row).getByRole("button", { name: /2026\.10\.08 15:00/ }));
    await waitFor(() => {
      const c = callFn().mock.calls.find((x) => x[0] === "note_date_add")!;
      expect(c[1]).toMatchObject({ note_id: "note-n", year: 2026, month: 10, day: 8, start_time: "15:00" });
    });
    await waitFor(() =>
      expect(nudgeH.applyDateMark).toHaveBeenCalledWith(
        expect.anything(),
        { paraStart: 1, paraText: "내일 오후 3시 치과", from: 0, to: 8 },
        "d1",
      ),
    );
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    callFn().mockClear();
    vi.mocked(showToastMock).mock.calls[0][1]();
    expect(nudgeH.stripDateMark).toHaveBeenCalledWith(expect.anything(), "d1");
    await waitFor(() => expect(callFn().mock.calls.some((x) => x[0] === "note_date_remove" && x[1].id === "d1")).toBe(true));
    expect(nudgeH.dismiss).toHaveBeenCalledWith("date", expect.anything());
  });

  it("날짜 칩: date_nudge_auto 면 칩 없이 바로 반영하고 토스트만 띄운다", async () => {
    useSettingsStore.setState({ dateNudgeAuto: true } as any);
    callFn().mockImplementation(async (cmd: string) => (cmd === "note_date_add" ? { id: "d2" } : {}));
    nudgeH.state = { date: DATE_NUDGE };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await waitFor(() => expect(callFn().mock.calls.some((x) => x[0] === "note_date_add")).toBe(true));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(nudgeH.applyDateMark).toHaveBeenCalled();
    expect(screen.queryByTestId("mobile-nudge-chips")).toBeNull();
    expect(screen.queryByTestId("mobile-nudge-bubble")).toBeNull();
  });

  it("날짜 칩: note_date_add 가 실패하면 마크를 걸지 않고 칩을 닫지 않는다", async () => {
    callFn().mockImplementation(async (cmd: string) => {
      if (cmd === "note_date_add") throw new Error("boom");
      return {};
    });
    nudgeH.state = { date: DATE_NUDGE };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const row = await screen.findByTestId("mobile-nudge-bubble");
    fireEvent.click(within(row).getByRole("button", { name: /2026\.10\.08/ }));
    await waitFor(() => expect(callFn().mock.calls.some((x) => x[0] === "note_date_add")).toBe(true));
    await act(async () => {});
    expect(nudgeH.applyDateMark).not.toHaveBeenCalled();
    expect(nudgeH.dismiss).not.toHaveBeenCalled();
  });

  it("지역 칩: 대표 지역이 비었으면 대표로 설정하고, 되돌리면 비운다", async () => {
    nudgeH.state = { region: { name: "Gyeongju", lat: 35.8, lng: 129.2 }, restParaStart: 1 };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const row = await screen.findByTestId("mobile-nudge-bubble");
    fireEvent.click(within(row).getByRole("button", { name: /Gyeongju/ }));
    await waitFor(() => expect(useNotesStore.getState().setRegion).toHaveBeenCalledWith("Gyeongju"));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    vi.mocked(showToastMock).mock.calls[0][1]();
    await waitFor(() => expect(useNotesStore.getState().setRegion).toHaveBeenCalledWith(null));
  });

  it("지역 칩: 대표 지역이 있으면 경유지로 넣고, 되돌리면 note_region_remove", async () => {
    setupInputNote({ id: "note-n", region: "Busan" });
    callFn().mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [{ position: 0 }] };
      if (cmd === "note_region_add") return { id: "wp1" };
      return {};
    });
    nudgeH.state = { region: { name: "Gyeongju", lat: 35.8, lng: 129.2 }, restParaStart: 1 };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const row = await screen.findByTestId("mobile-nudge-bubble");
    fireEvent.click(within(row).getByRole("button", { name: /Gyeongju/ }));
    await waitFor(() => expect(callFn().mock.calls.some((x) => x[0] === "note_region_add")).toBe(true));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    vi.mocked(showToastMock).mock.calls[0][1]();
    await waitFor(() => expect(callFn().mock.calls.some((x) => x[0] === "note_region_remove" && x[1].id === "wp1")).toBe(true));
  });

  it("링크 칩: AI 가 켜져 있으면 ai 모드로, 꺼져 있으면 raw 로 가져온다", async () => {
    nudgeH.state = { url: "https://example.com/a" };
    const { unmount } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Fetch link content/ }));
    await waitFor(() => expect(nudgeH.importLinks).toHaveBeenCalledWith(["https://example.com/a"], "note-n", "ai"));
    unmount();
    nudgeH.importLinks.mockClear();
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Fetch link content/ }));
    await waitFor(() => expect(nudgeH.importLinks).toHaveBeenCalledWith(["https://example.com/a"], "note-n", "raw"));
  });

  it("태그 칩: 누르면 #질의 를 #태그 로 바꾸고 setTags 로 기존 태그 뒤에 덧붙인다", async () => {
    const setTags = vi.fn(async () => {});
    const n = useNotesStore.getState().activeNote!;
    useNotesStore.setState({ activeNote: { ...n, note: { ...n.note, tag_names: ["old"] } }, setTags } as any);
    nudgeH.state = {
      tag: {
        query: { query: "co", from: 3, to: 6 },
        items: [
          { name: "company", isNew: false },
          { name: "co", isNew: true },
        ],
        paraStart: 1,
        paraText: "memo #co",
      },
    };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const row = await screen.findByTestId("mobile-nudge-chips");
    expect(within(row).getByRole("button", { name: "#company" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /New tag/ })).toBeTruthy();
    // 태그 칩에는 무시 버튼이 없다
    expect(within(row).queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "#company" }));
    await waitFor(() =>
      expect(nudgeH.replaceTagToken).toHaveBeenCalledWith(
        expect.anything(),
        { paraStart: 1, paraText: "memo #co", from: 3, to: 6 },
        "company",
      ),
    );
    await waitFor(() => expect(setTags).toHaveBeenCalledWith(["old", "company"]));
  });

  it("태그 칩: 글자가 달라져 치환이 거부되면 태그를 등록하지 않는다", async () => {
    const setTags = vi.fn(async () => {});
    useNotesStore.setState({ setTags } as any);
    nudgeH.replaceTagToken.mockReturnValueOnce(false);
    nudgeH.state = {
      tag: { query: { query: "co", from: 3, to: 6 }, items: [{ name: "company", isNew: false }], paraStart: 1, paraText: "memo #co" },
    };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "#company" }));
    await act(async () => {});
    expect(setTags).not.toHaveBeenCalled();
  });

  it("무시: 칩의 × 는 dismiss 를 부른다", async () => {
    nudgeH.state = { url: "https://example.com/a" };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const row = await screen.findByTestId("mobile-nudge-chips");
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
    expect(nudgeH.dismiss).toHaveBeenCalledWith("url", expect.anything());
  });

  // ── 날짜·지역은 문장 위 말풍선, 링크·#태그는 키보드 위 칩 줄 (오너 2026-10-07) ──
  // 자리 계산(위/아래/숨김/가두기)은 MobileNudgeBubble.test.tsx 가 진짜 에디터로 본다. 여기는 MobileNote 의 배선뿐이다.
  it("날짜와 지역이 함께 있으면 한 말풍선 안의 두 동작이고, 칩 줄은 생기지 않는다", async () => {
    nudgeH.state = {
      date: DATE_NUDGE,
      region: { name: "Gyeongju", lat: 35.8, lng: 129.2 },
      restParaStart: 1,
    };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const bubble = await screen.findByTestId("mobile-nudge-bubble");
    expect(screen.queryByTestId("mobile-nudge-chips")).toBeNull();
    expect(bubble.querySelectorAll(".mobile-nudge-bubble-action")).toHaveLength(2);
    expect(within(bubble).getByRole("button", { name: /2026\.10\.08 15:00/ })).toBeTruthy();
    expect(within(bubble).getByRole("button", { name: /Region · Gyeongju/ })).toBeTruthy();
    // 말풍선은 본문 상자(.mobile-note-stage) 안에 있고 칩 줄·독 위치를 건드리지 않는다.
    expect(bubble.closest(".mobile-note-stage")).toBeTruthy();
  });

  it("말풍선의 ×(무시)는 그 종류만 닫는다", async () => {
    nudgeH.state = { date: DATE_NUDGE, region: { name: "Gyeongju", lat: 35.8, lng: 129.2 }, restParaStart: 1 };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const bubble = await screen.findByTestId("mobile-nudge-bubble");
    const regionAction = bubble.querySelector('[data-kind="region"]') as HTMLElement;
    fireEvent.click(within(regionAction).getByRole("button", { name: "Dismiss" }));
    expect(nudgeH.dismiss).toHaveBeenCalledWith("region", expect.anything());
    expect(nudgeH.dismiss).not.toHaveBeenCalledWith("date", expect.anything());
  });

  it("링크·#태그는 칩 줄에만 있고 말풍선은 없다", async () => {
    nudgeH.state = {
      url: "https://example.com/a",
      tag: { query: { query: "co", from: 3, to: 6 }, items: [{ name: "company", isNew: false }], paraStart: 1, paraText: "memo #co" },
    };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const row = await screen.findByTestId("mobile-nudge-chips");
    expect(within(row).getByRole("button", { name: /Fetch link content/ })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "#company" })).toBeTruthy();
    expect(screen.queryByTestId("mobile-nudge-bubble")).toBeNull();
  });

  it("말풍선을 눌러도 에디터 포커스(=키보드)를 뺏지 않는다 — mousedown 기본 동작이 막힌다", async () => {
    nudgeH.state = { date: DATE_NUDGE, region: { name: "Gyeongju", lat: 35.8, lng: 129.2 }, restParaStart: 1 };
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    const bubble = await screen.findByTestId("mobile-nudge-bubble");
    const stays = (el: Element) => fireEvent.mouseDown(el) === false;
    for (const b of within(bubble).getAllByRole("button")) expect(stays(b)).toBe(true);
  });

  it("감지 결과가 없으면 말풍선도 없다", async () => {
    nudgeH.state = {};
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("mobile-dock");
    expect(screen.queryByTestId("mobile-nudge-bubble")).toBeNull();
  });
});

// ───────────── 하단 독(도구 슬롯) + 스피드 다이얼 ＋ (오너 2026-10-07; ✨ 는 다이얼로, 저장하기는 제거 2026-10-10) ─────────────
// 슬롯 상태표 자체(dockSlotKind)는 MobileDockSlot.test.tsx 가 표로 본다. 여기는 MobileNote 의 배선: 어떤 화면 상태가
// 어떤 슬롯을 만드는가 · 다이얼(텍스트 섹션 = 떠 있는 FAB, 관계도·시트 = 독 슬롯)이 같은 녹음기/갤러리/첨부 시트를 여는가 ·
// 칩 줄이 독 바로 위인가.
describe("MobileNote — bottom dock + ＋ speed dial (owner 2026-10-07)", () => {
  /** 다이얼을 연다 — 펼침 항목은 열려야 눌린다(닫힌 항목은 CSS 가 막는다). */
  const openDial = () => fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
  const slot = () => screen.getByTestId("mobile-dock-slot");
  const slotKind = () => slot().getAttribute("data-slot");

  beforeEach(() => {
    localStorage.clear();
    editorEmptyMock = true;
    setContentMock.mockClear();
    setEditableMock.mockClear();
    activeImageMock = false;
    recorderProps = null;
    nudgeH.state = {};
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en", dateNudgeEnabled: false, dateNudgeAuto: false } as any);
    useAiStore.setState({ aiReachable: true, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  });

  it("empty capture: presets in the slot; once the body has content the slot becomes formatting", async () => {
    useNotesStore.setState({ activeNote: draftActiveNote(), activeBodyEmpty: true } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);

    await screen.findByTestId("mobile-preset-more");
    expect(slotKind()).toBe("presets");
    expect(within(slot()).getByText("To-do list")).toBeTruthy();
    expect(screen.queryByLabelText("Checklist")).toBeNull();

    act(() => {
      useNotesStore.setState({ activeBodyEmpty: false } as any);
    });
    expect(slotKind()).toBe("format");
    expect(screen.getByLabelText("Checklist")).toBeTruthy();
    expect(screen.getByLabelText("Bold")).toBeTruthy();
    expect(screen.getByLabelText("Italic")).toBeTruthy();
    expect(screen.queryByTestId("mobile-preset-more")).toBeNull();
  });

  it("the store flag lags the first keystrokes: a non-empty live editor never shows the presets even while activeBodyEmpty is still true", async () => {
    editorEmptyMock = false;
    useNotesStore.setState({ activeNote: draftActiveNote(), activeBodyEmpty: true } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await screen.findByTestId("mobile-dock");
    expect(slotKind()).toBe("format");
    expect(screen.queryByTestId("mobile-preset-more")).toBeNull();
    expect(screen.queryByText("To-do list")).toBeNull();
  });

  it("applying a preset latches the slot to formatting even though a checklist body still reads as empty", async () => {
    const applyPreset = vi.fn(async (bodyMd: string) => {
      useNotesStore.setState({ activeNote: draftActiveNote([{ id: "draft_sec", body_md: bodyMd }]) } as any); // activeBodyEmpty stays true
      return null;
    });
    useNotesStore.setState({ activeNote: draftActiveNote(), activeBodyEmpty: true, applyPreset } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);

    fireEvent.click(await screen.findByText("To-do list"));
    await waitFor(() => expect(slotKind()).toBe("format"));
    expect(screen.getByLabelText("Checklist")).toBeTruthy();
  });

  it("an existing note (not a capture) with an empty body shows formatting, never presets", async () => {
    const n = draftActiveNote([{ id: "s1", body_md: "" }]);
    n.note.id = "note-1";
    useNotesStore.setState({ activeNote: n, activeBodyEmpty: true } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("mobile-dock");
    expect(slotKind()).toBe("format");
    expect(screen.queryByTestId("mobile-preset-more")).toBeNull();
  });

  it("an image selected in the body swaps the slot to the 3 size steps", () => {
    const n = draftActiveNote([{ id: "s1", body_md: "x" }]);
    n.note.id = "note-1";
    useNotesStore.setState({ activeNote: n, activeBodyEmpty: false } as any);
    activeImageMock = true;
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    expect(slotKind()).toBe("image");
    expect(within(slot()).getByTestId("mobile-image-size-controls")).toBeTruthy();
    expect(screen.queryByLabelText("Checklist")).toBeNull();
    activeImageMock = false;
  });

  it("a diagram section: no formatting/presets in the slot, only the ＋ speed dial (with AI in it); NO floating FAB over the diagram controls", async () => {
    useNotesStore.setState({
      activeNote: diagramActiveNote("flowchart TD\nn1 --> n2"),
      activeBodyEmpty: false,
      updateSectionBody: vi.fn(async () => {}),
    } as any);
    const { container } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} capture />);
    await screen.findByTestId("diagram-source");
    expect(slotKind()).toBe("none");
    // 슬롯에는 스피드 다이얼 ＋ 하나만 선다(서식·프리셋·크기 3단은 없다).
    expect(slot().childElementCount).toBe(1);
    expect(within(slot()).getByTestId("mobile-fab-toggle")).toBeTruthy();
    expect(screen.getByTestId("mobile-speed-dial").getAttribute("data-placement")).toBe("dock");
    expect(screen.queryByTestId("mobile-preset-more")).toBeNull();
    expect(screen.queryByLabelText("Checklist")).toBeNull();
    expect(slot().contains(screen.getByLabelText("AI actions"))).toBe(true); // ✨ 는 독 ＋ 다이얼의 항목
    expect(screen.queryByText("Save")).toBeNull();
    // 떠 있는 FAB 는 없다 — 그게 관계도 아래쪽 "소스 편집" 줄을 가렸다.
    expect(screen.queryByTestId("mobile-note-fab")).toBeNull();
    expect(container.querySelector(".mobile-note-fab")).toBeNull();
    // 본문 아래에 FAB 몫의 빈 띠를 남기지 않는다.
    expect(container.querySelector(".mobile-note-stage")!.getAttribute("data-fab")).toBe("dock");
    // 펼치면 네 동작이 독 안에서 열린다.
    openDial();
    for (const id of ["mobile-fab-mic", "mobile-fab-photo", "mobile-fab-attach", "mobile-fab-ai"]) {
      expect(slot().contains(screen.getByTestId(id)), id).toBe(true);
    }
  });

  it("a sheet section: same — the ＋ is in the dock slot, not floating over the grid bottom tools", async () => {
    const n = draftActiveNote([{ id: "sh1", body_md: '{"v":1,"rows":10,"cols":[{}],"cells":{},"charts":[]}', kind: "sheet" }]);
    n.note.id = "note-sheet";
    useNotesStore.setState({ activeNote: n, activeBodyEmpty: false } as any);
    const { container } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("sheet-editor");
    expect(slotKind()).toBe("none");
    expect(within(slot()).getByTestId("mobile-fab-toggle")).toBeTruthy();
    expect(container.querySelector(".mobile-note-fab")).toBeNull();
    expect(container.querySelector(".mobile-note-stage")!.getAttribute("data-fab")).toBe("dock");
  });

  it("the dock ＋ reaches the same recorder / gallery input as the floating one", async () => {
    useNotesStore.setState({
      activeNote: diagramActiveNote("flowchart TD\nn1 --> n2"),
      activeBodyEmpty: false,
      updateSectionBody: vi.fn(async () => {}),
    } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("diagram-source");
    const pick = vi.spyOn(screen.getByTestId("attach-input-gallery"), "click").mockImplementation(() => {});
    openDial();
    fireEvent.click(screen.getByTestId("mobile-fab-photo"));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mobile-modal")).toBeNull(); // 사진은 시트를 거치지 않는다
    openDial();
    fireEvent.click(screen.getByTestId("mobile-fab-mic"));
    expect(screen.getByTestId("fake-recorder")).toBeTruthy();
  });

  it("a read-only (unsupported-format) body: formatting disabled, record / photo / attach still usable", async () => {
    const n = draftActiveNote([{ id: "s1", body_md: "<table><tr><td>x</td></tr></table>" }]);
    n.note.id = "note-1";
    useNotesStore.setState({ activeNote: n, activeBodyEmpty: false } as any);
    render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByText(/can't edit/i);
    expect(slotKind()).toBe("format");
    expect((screen.getByLabelText("Checklist") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Bold") as HTMLButtonElement).disabled).toBe(true);
    openDial();
    for (const id of ["mobile-fab-toggle", "mobile-fab-mic", "mobile-fab-photo", "mobile-fab-attach"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(false);
    }
  });

  it("the old top toolbar row is gone — the speed dial is not in any toolbar (text section: floating, not in the dock slot)", async () => {
    useNotesStore.setState({ activeNote: draftActiveNote([{ id: "s1", body_md: "x" }]), activeBodyEmpty: false } as any);
    const { container } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
    await screen.findByTestId("mobile-dock");
    expect(container.querySelector(".mobile-note-toolbar")).toBeNull();
    expect(slot().contains(screen.getByTestId("mobile-fab-toggle"))).toBe(false);
    expect(slot().contains(screen.getByTestId("mobile-fab-mic"))).toBe(false);
    expect(slot().contains(screen.getByTestId("mobile-fab-attach"))).toBe(false);
    expect(screen.getByTestId("mobile-speed-dial").getAttribute("data-placement")).toBe("float");
    expect(container.querySelector(".mobile-note-stage")!.getAttribute("data-fab")).toBe("float");
  });

  describe("FAB", () => {
    beforeEach(() => {
      setupInputNote();
    });

    it("sits in the non-scrolling stage NEXT TO the scrolling body, so it never scrolls away with the text", async () => {
      const { container } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      const fab = await screen.findByTestId("mobile-note-fab");
      const stage = container.querySelector(".mobile-note-stage") as HTMLElement;
      const wrap = container.querySelector(".mobile-note-body-wrap") as HTMLElement;
      expect(stage).toBeTruthy();
      expect(stage.contains(fab)).toBe(true);
      expect(stage.contains(wrap)).toBe(true);
      expect(wrap.contains(fab)).toBe(false);
    });

    it("one ＋ (closed): the three actions are inside the dial and become live when it opens", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      const toggle = await screen.findByTestId("mobile-fab-toggle");
      const layer = screen.getByTestId("mobile-speed-dial").querySelector(".mobile-speed-dial-layer")!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(layer.hasAttribute("inert")).toBe(true);
      openDial();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(layer.hasAttribute("inert")).toBe(false);
    });

    it("녹음 opens the same recorder sheet the toolbar mic did", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      expect(screen.queryByTestId("fake-recorder")).toBeNull();
      await screen.findByTestId("mobile-fab-toggle");
      openDial();
      fireEvent.click(screen.getByTestId("mobile-fab-mic"));
      expect(screen.getByTestId("fake-recorder")).toBeTruthy();
      expect(screen.getByTestId("mobile-fab-mic").getAttribute("aria-label")).toBe("Voice recording");
      expect(screen.getByTestId("mobile-fab-toggle").getAttribute("aria-expanded")).toBe("false"); // 다이얼은 닫힌다
    });

    it("파일 첨부 opens the attach sheet (all four rows survive: camera, gallery, audio, file)", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      expect(screen.queryByTestId("mobile-modal")).toBeNull();
      await screen.findByTestId("mobile-fab-toggle");
      openDial();
      fireEvent.click(screen.getByTestId("mobile-fab-attach"));
      await waitFor(() => expect(screen.getByTestId("mobile-modal").getAttribute("aria-label")).toBe("Add attachment"));
      const rows = within(screen.getByTestId("mobile-modal")).getAllByRole("button");
      expect(rows.length).toBeGreaterThanOrEqual(5); // 4 rows + 닫기
    });

    it("AI opens the AI sheet (the old dock ✨ moved into the dial) and the dial closes", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("mobile-fab-toggle");
      openDial();
      expect(screen.queryByTestId("mobile-modal")).toBeNull();
      fireEvent.click(screen.getByTestId("mobile-fab-ai"));
      await waitFor(() => expect(screen.getByTestId("mobile-modal")).toBeTruthy());
      expect(screen.getByTestId("mobile-fab-toggle").getAttribute("aria-expanded")).toBe("false");
    });

    it("AI off: the AI item stays (the sheet explains why) but is muted", async () => {
      useSettingsStore.setState({ aiEnabled: false } as any);
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("mobile-fab-toggle");
      expect(screen.getByTestId("mobile-fab-ai").getAttribute("data-muted")).toBe("true");
      expect(screen.getByTestId("mobile-fab-mic").hasAttribute("data-muted")).toBe(false);
    });

    it("사진 clicks the gallery input directly, no attach sheet in between", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      const pick = vi.spyOn(screen.getByTestId("attach-input-gallery"), "click").mockImplementation(() => {});
      await screen.findByTestId("mobile-fab-toggle");
      openDial();
      fireEvent.click(screen.getByTestId("mobile-fab-photo"));
      expect(pick).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("mobile-modal")).toBeNull();
    });

    it("＋, the opened actions and every dock button keep the editor focus (mousedown default prevented)", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("mobile-dock");
      const stays = (el: Element) => fireEvent.mouseDown(el) === false;
      expect(stays(screen.getByTestId("mobile-fab-toggle"))).toBe(true);
      openDial();
      expect(stays(screen.getByTestId("mobile-fab-mic"))).toBe(true);
      expect(stays(screen.getByTestId("mobile-fab-photo"))).toBe(true);
      expect(stays(screen.getByTestId("mobile-fab-attach"))).toBe(true);
      expect(stays(screen.getByTestId("mobile-fab-ai"))).toBe(true);
      expect(stays(screen.getByLabelText("Checklist"))).toBe(true);
      expect(stays(screen.getByLabelText("Bold"))).toBe(true);
      expect(stays(screen.getByLabelText("Italic"))).toBe(true);
    });
  });

  describe("chip rows", () => {
    beforeEach(() => {
      setupInputNote();
    });

    it("the typing-nudge row is DIRECTLY above the dock, and below the body stage", async () => {
      nudgeH.state = { url: "https://example.com/a" };
      const { container } = render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      const row = await screen.findByTestId("mobile-nudge-chips");
      const dock = screen.getByTestId("mobile-dock");
      const stage = container.querySelector(".mobile-note-stage") as HTMLElement;
      expect(row.nextElementSibling).toBe(dock);
      expect(row.previousElementSibling).toBe(stage);
    });

    it("the S2 suggestion cards carry .mobile-input-chips (the class the keyboard-open rule hides)", async () => {
      render(<MobileNote onBack={() => {}} onOpenNote={() => {}} />);
      await screen.findByTestId("mobile-dock");
      await waitFor(() => expect(listenSpecs.find((s) => s[0] === "attachment-meta-suggested")).toBeTruthy());
      act(() => {
        listenSpecs.find((s) => s[0] === "attachment-meta-suggested")![1]({
          payload: { note_id: "note-v", region: { name: "Seoul", lat: 37.5, lng: 127 } },
        });
      });
      const cards = await screen.findByTestId("mobile-input-chips");
      expect(cards.className).toContain("mobile-input-chips");
    });
  });
});
