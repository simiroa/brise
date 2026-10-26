import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
// C(AUDIT-2026-09-26): tracks calls that went specifically through the `call()` alias (both
// aliases still resolve/reject via the shared callMock above, so every other assertion in this
// file keeps working) — lets the open-history fix be verified as routed through call() (which
// toasts on failure in the real lib/invoke.ts), not still silently through callSilent().
const callOnlyMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => {
    callOnlyMock(...args);
    return callMock(...args);
  },
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
}));

// 네이티브 OS 드래그&드롭(useFileDropZone)이 구독하는 Tauri webview 이벤트 — settings/pet의
// PetPackageGallery.test.tsx와 같은 모양으로 dropHandler를 잡아 직접 호출한다.
type DropPayload = { type: string; paths: string[]; position: { x: number; y: number } };
let dropHandler: ((e: { payload: DropPayload }) => void) | null = null;
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: DropPayload }) => void) => {
      dropHandler = cb;
      return Promise.resolve(() => {
        dropHandler = null;
      });
    },
  }),
}));

// 연필·"+추가"가 여는 AI 프리셋 편집기 — 여기서는 무엇을 넘겨 여는지만 본다(편집기 자체는
// presets/AiActionEditor.test.tsx 가 소유).
vi.mock("./presets/PresetManageModal", () => ({
  PresetManageModal: (p: { aiOnly?: boolean; autoAdd?: unknown; initialId?: string; onClose: () => void }) => (
    <div
      data-testid="preset-modal-stub"
      data-ai-only={String(!!p.aiOnly)}
      data-auto-add={JSON.stringify(p.autoAdd ?? null)}
      data-initial-id={p.initialId ?? ""}
    >
      <button type="button" onClick={p.onClose}>close-preset-modal</button>
    </div>
  ),
}));

import { t } from "../i18n/t";
import { AskAiModal, runMetadataProposal, runTagsProposal, runNoteSummary, type AskAiTarget } from "./AskAiModal";
import { ASKAI_TILE_ORDER, tilesForTarget } from "./ai/askAiPresets";
import * as askAiHistory from "../lib/askAiHistory";
import { useAiStore } from "../stores/ai";
import { useAiPresetsStore } from "../stores/aiPresets";
import { useAiInstructionsStore } from "../stores/aiInstructions";
import { DIAGRAM_EDIT_ID, type AiActionPreset } from "../stores/aiPrompts";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiResultGateStore } from "../stores/aiResultGate";
import { useProposalHostStore } from "../stores/proposalHost";
import { AiConfirmModal } from "./AiConfirmModal";
import { registerSectionInserter, registerDiagramTarget, registerActiveSectionGetter } from "../lib/aiSectionBridge";

// 저장소의 실제 모양(2026-09-28 검토): 타일은 요청 문장(빈 문장 = DEFS 문장)을 들고, 엔진 장문은 지침 저장소가 든다.
// 예전 고정값은 타일 자리에 엔진 장문을 넣어 두어, 실제로는 깨진 관계도·시트 경로가 테스트에서만 통과했다.
const PRESETS: AiActionPreset[] = [
  { id: "summarize", name: "요약하기", prompt: "", kind: "text", isBuiltin: true, hidden: false },
  { id: "metadata", name: "데이터 자동 채우기", prompt: "", kind: "metadata", isBuiltin: true, hidden: false },
  { id: "diagram", name: "관계도 만들기", prompt: "", kind: "diagram", isBuiltin: true, hidden: false },
];
const ENGINE_OVERRIDES: Record<string, string> = {
  metadata: "METADATA GUIDANCE",
  [DIAGRAM_EDIT_ID]: "DIAGRAM EDIT RULES",
  diagram: "DIAGRAM CREATE RULES",
  sheet: "SHEET CREATE RULES",
};

// AI-on, loopback ollama — the click-time gate every action goes through resolves true.
function gateOkSettings() {
  return { settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } };
}

const noteTarget: AskAiTarget = { kind: "note", noteId: "note-1", noteTitle: "Note 1" };

/** TipTap parks the Editor on its root DOM node — the modal does not expose it, so tests read it there.
 *  ModalShell portals into body, so lookups go through document, not the render container. */
const pm = () => document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
const editorOf = (): Editor => pm().editor;
const tileIds = () =>
  screen
    .queryAllByTestId(/^askai-tile-/)
    .map((el) => el.getAttribute("data-testid")!.replace("askai-tile-", ""));
const genCall = () => callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt");
const ctxLabels = () =>
  Array.from(document.querySelectorAll(".askai-ctxstrip__item")).map((el) => ({
    text: el.textContent,
    active: el.getAttribute("data-active") !== "false",
  }));
const pressEnter = async () => {
  await act(async () => {
    // jsdom cannot measure text nodes — PM's scrollToSelection would throw on a text-ending doc.
    editorOf().commands.focus("end", { scrollIntoView: false });
  });
  fireEvent.keyDown(pm(), { key: "Enter" });
};

/**
 * OWNER PHILOSOPHY (see task HANDOFF): every AI-capable context exposes ONE entry — "AI에게 묻기" —
 * opening this ONE modal, rather than an enumerated row per action. Tiles stamp a sentence into the
 * composer; sending always dispatches the sentence on screen (PLAN-2026-09-15-askai-composer).
 */
describe("AskAiModal — preset stamp composer (owner: ONE modal, tiles are sentence stamps)", () => {
  let insertSectionMock: ReturnType<typeof vi.fn>;
  // zustand setState is permanent — the stubbed tree actions must not leak into the describe below.
  const { selectNote: origSelectNote, loadTree: origLoadTree } = useNotesStore.getState();
  afterEach(() => {
    useNotesStore.setState({ selectNote: origSelectNote, loadTree: origLoadTree });
    useAiInstructionsStore.setState({ instructions: {}, loaded: false });
  });

  beforeEach(() => {
    localStorage.clear();
    callMock.mockReset();
    callOnlyMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    dropHandler = null;
    registerActiveSectionGetter(() => null);
    registerDiagramTarget(() => null);
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
      if (cmd === "ai_organize_note") return Promise.resolve({ confidence: 0.9 });
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "<p>generated</p>" });
      if (cmd === "note_create") return Promise.resolve({ note: { id: "new-1", folder_id: "f-2", title: "T" }, sections: [{ id: "new-s1", name: "Overview", body_md: "", position: 0, kind: "text" }], sources: [], attachments: [] });
      if (cmd === "section_update") return Promise.resolve({ updated_at: "now" });
      return Promise.resolve({});
    });
    useAiPresetsStore.setState({ list: PRESETS, loaded: true });
    useAiInstructionsStore.setState({ instructions: { ...ENGINE_OVERRIDES }, loaded: true });
    // 이 블록은 "확인 없이 곧장 적용"(ai_confirm_before_apply 끔) 경로를 본다 — 보내면 바로 쓰이고 모달이
    // 닫힌다. 결과를 모달 안에서 검토하는 흐름(켬, 기본값)은 아래 "한 모달에서 검토" 블록이 소유한다.
    useSettingsStore.setState({ aiConfirmBeforeApply: false, seenFeatureBriefs: ["askai_welcome"] } as never);
    useAiStore.setState({ organizePending: false, lastProposal: null, lastProposalNoteId: null, translateGateOk: null, translateTargetLang: "en" });
    useNotesStore.setState({
      activeNote: {
        note: { id: "note-1", title: "Note 1", folder_id: "f-1" },
        sections: [{ id: "s1", name: "Overview", body_md: "hello world", position: 0, kind: "text" }],
      },
      folders: [
        { id: "f-1", name: "Inbox" },
        { id: "f-2", name: "Work" },
      ],
      notesByFolder: {},
      selectNote: vi.fn(async () => {}),
      loadTree: vi.fn(async () => {}),
    } as never);
    insertSectionMock = vi.fn(async () => null);
    registerSectionInserter(insertSectionMock as never);
  });

  // 단일 순서(PLAN-2026-09-27 §7-1·Q7) — 모달 타일은 저장된 AI 프리셋 목록의 순서를 대상으로 거를 뿐이다. 목록에 없는
  // 내장 타일은 그 뒤에 기본 순서로 붙는다. 빈 시트는 시작 프리셋(blank)만.
  it("renders tiles in the stored single order, filtered by target", () => {
    const stored = useAiPresetsStore.getState().list;
    const expected = (kind: keyof typeof ASKAI_TILE_ORDER, blank = false) => tilesForTarget(kind, stored, blank).map((p) => p.id);

    const r1 = render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    expect(tileIds()).toEqual(expected("note"));
    // 저장 목록의 순서가 먼저다: 고정값의 summarize → metadata → diagram
    expect(tileIds().slice(0, 3)).toEqual(["summarize", "metadata", "diagram"]);
    expect(tileIds()).not.toContain("start_text");
    r1.unmount();

    const r2 = render(<AskAiModal target={{ kind: "selection", selectedText: "picked", from: 1, to: 7 }} onClose={() => {}} />);
    expect(tileIds()).toEqual(expected("selection"));
    r2.unmount();

    render(<AskAiModal target={{ kind: "section", sectionId: "t1", sectionName: "Sheet", sectionBody: "", isDiagram: false, diagramMounted: false, isSheet: true, sheetMounted: true }} onClose={() => {}} />);
    expect(tileIds()).toEqual(expected("sheet", true));
    expect(tileIds()).toContain("start_sheet");
  });

  it("dialog name stays the action name; the title bar is ✦ AI only and the note identity moved to the context strip (D19)", async () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
    expect(screen.getByTestId("askai-header").textContent).toContain("AI");
    // 제공자는 설정을 읽은 뒤에 선다(모르는 동안엔 이름도 외부 배지도 없다).
    await waitFor(() => expect(screen.getByTestId("askai-header").textContent).toContain("Ollama"));
    expect(screen.queryByTestId("askai-external-badge")).toBeNull();
    expect(screen.getByTestId("askai-header").textContent).not.toContain("Note 1");
    const [first] = ctxLabels();
    expect(first.text).toContain("Note 1");
    expect(first.text).toContain("1 sections");
    expect(first.text).toContain("11 chars");
    expect(first.active).toBe(true);
  });

  it("seeds the context strip from the target: selection → selection, section → that section, new → nothing", () => {
    const r1 = render(<AskAiModal target={{ kind: "selection", selectedText: "picked words", from: 1, to: 13 }} onClose={() => {}} />);
    expect(ctxLabels().map((c) => c.text)).toEqual([expect.stringContaining("Selected text")]);
    r1.unmount();

    const r2 = render(<AskAiModal target={{ kind: "section", sectionId: "s1", sectionName: "Overview", sectionBody: "hello world", isDiagram: false, diagramMounted: false }} onClose={() => {}} />);
    expect(ctxLabels().map((c) => c.text)).toEqual([expect.stringContaining("Overview")]);
    r2.unmount();

    render(<AskAiModal target={{ kind: "new" }} onClose={() => {}} />);
    expect(screen.queryByTestId("askai-ctxstrip")).toBeNull();
  });

  it("clicking a context item deactivates it; the deactivated body is NOT sent (D14)", async () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-summarize"));
    });
    expect(screen.queryByTestId("askai-no-ctx-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("askai-ctx-body-0"));
    expect(ctxLabels()[0].active).toBe(false);
    // 지워지지 않았다 — 흐려졌을 뿐이라 다시 눌러 되살릴 수 있다.
    expect(ctxLabels()).toHaveLength(1);
    expect(screen.getByTestId("askai-no-ctx-hint")).toBeTruthy();

    await pressEnter();
    await waitFor(() => expect(genCall()).toBeTruthy());
    expect(genCall()![1].prompt).not.toContain("hello world");
    expect(genCall()![1].prompt).toContain("요약해줘");
  });

  it("번역 tile stamps a lang slot only; the body rides the context strip and Enter sends both", async () => {
    const onClose = vi.fn();
    render(<AskAiModal target={noteTarget} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-translate"));
    });
    await waitFor(() => expect(pm().querySelector(".askai-slot[data-kind='lang']")?.textContent).toBe("영어"));
    // 문장에는 컨텍스트 칩이 없다(D15) — 참조는 위 줄이 소유한다.
    expect(pm().querySelector(".askai-ctx")).toBeNull();
    expect(ctxLabels()[0].text).toContain("Note 1");
    expect(screen.getByTestId("askai-tile-translate").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("askai-where").textContent).toBe("New section");

    await pressEnter();
    // 내용 경로는 결과가 실제로 쓰인 뒤에 닫힌다(2026-09-27 — 예전엔 보내자마자 닫혔다).
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(genCall()).toBeTruthy());
    const prompt = genCall()![1].prompt as string;
    expect(prompt).toContain("영어로 자연스럽게 번역해줘");
    expect(prompt).toContain("[Body]\nhello world");
    await waitFor(() => expect(insertSectionMock).toHaveBeenCalled());
    expect(insertSectionMock.mock.calls[0][2]).toBe("note-1");
    // history records the instruction + the active refs (relative ones kept generic), never the body
    const [entry] = askAiHistory.list();
    expect(entry.presetId).toBe("translate");
    expect(entry.targetKind).toBe("note");
    expect(entry.refs).toEqual([{ k: "body" }]);
    expect(JSON.stringify(entry)).not.toContain("hello world");
  });

  it("메타 tile shows the fixed 「검토 후 적용」 pill; sending routes to the metadata proposal with the sentence as guidance — in this modal", async () => {
    const organizeCurrentNote = vi.fn(async (..._args: unknown[]) => {});
    useAiStore.setState({ organizeCurrentNote } as never);
    const onClose = vi.fn();
    render(<AskAiModal target={noteTarget} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-metadata"));
    });
    expect(screen.queryByTestId("askai-where")).toBeNull();
    expect(screen.getByTestId("askai-fixed-where").textContent).toContain("Review before applying");

    fireEvent.click(screen.getByText("Send").closest("button")!);
    await waitFor(() => expect(organizeCurrentNote).toHaveBeenCalled());
    // 예전엔 모달이 닫히고 독립 확인 창이 따로 떴다(오너 2026-09-27 "따로 분리된 게 싫다"). 제안이 없으면
    // (여기 목은 아무것도 만들지 않는다) 작성으로 돌아온다.
    await waitFor(() => expect(screen.getByTestId("askai-fixed-where")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(organizeCurrentNote.mock.calls[0][0]).toBe("note-1");
    expect(organizeCurrentNote.mock.calls[0][1]).toEqual(["title", "tags", "year", "region", "folder"]);
    expect(organizeCurrentNote.mock.calls[0][2]).toContain("제목·태그·연도·지역·폴더를 제안해줘");
  });

  it("editing the stamped sentence shows the Custom badge and deselects the tile; re-picking resets it", async () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-summarize"));
    });
    expect(screen.queryByText("Custom")).toBeNull();
    await act(async () => {
      editorOf().commands.insertContentAt(1, "짧게 ");
    });
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.getByTestId("askai-tile-summarize").getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-summarize"));
    });
    expect(screen.queryByText("Custom")).toBeNull();
    expect(editorOf().getText()).not.toContain("짧게");
    expect(screen.getByTestId("askai-tile-summarize").getAttribute("aria-pressed")).toBe("true");
  });

  it("where=note creates the note in the chosen folder and fills it", async () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-summarize"));
    });
    fireEvent.click(screen.getByTestId("askai-where"));
    fireEvent.click(screen.getByText("New note"));
    const folder = screen.getByTestId("askai-folder");
    expect(folder.textContent).toBe("Inbox");
    fireEvent.click(folder);
    fireEvent.click(screen.getByText("Work"));

    await pressEnter();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ folder_id: "f-2" })));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_update", expect.objectContaining({ id: "new-s1", body_md: "<p>generated</p>" })));
  });

  it("history tab lists a pushed entry; picking it restores the sentence, the refs and where", async () => {
    askAiHistory.push({
      doc: [{ t: "text", v: "핵심만 세 줄로" }],
      refs: [{ k: "body" }, { k: "weather" }],
      where: "note",
      folderId: "f-2",
      targetKind: "note",
      noteTitle: "Old note",
    });
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    const row = screen.getByText("핵심만 세 줄로").closest("button")!;
    expect(row.textContent).toContain("Old note");
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(editorOf().getText()).toContain("핵심만 세 줄로"));
    // 절대 참조(날씨)는 그대로, 상대 참조(body)는 지금 대상에 다시 묶인다(D18).
    expect(ctxLabels().map((c) => c.text)).toEqual([expect.stringContaining("Note 1"), expect.stringContaining("Weather")]);
    expect(screen.getByTestId("askai-where").textContent).toBe("New note");
    expect(screen.getByTestId("askai-folder").textContent).toBe("Work");
  });

  // C(AUDIT-2026-09-26): the "open full history" (window) button used to be
  // callSilent(...).catch(() => {}) — a failure was completely silent (this is a user action, a
  // button click). It must now route through call() (which toasts on failure in the real
  // lib/invoke.ts).
  it("'open full history' window button routes through call() (not callSilent)", async () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Open full history"));
    await waitFor(() => expect(callOnlyMock).toHaveBeenCalledWith("ai_history_window_open", {}));
  });

  // 어시스트 "바로 실행"(§7-4) — 스탬프 직후 한 번만 판단한다(2026-09-28 검토 S6: 칸에 첫 글자를 치는 순간 나갔다).
  it("assist autorun: a preset with an empty text slot is not sent, and typing into the slot does not send it", async () => {
    render(<AskAiModal target={{ ...noteTarget, presetId: "ask", autoSend: true }} onClose={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(genCall()).toBeFalsy();
    await act(async () => {
      editorOf().commands.insertContent("질문 하나");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(genCall()).toBeFalsy();
  });

  it("assist autorun: a preset with nothing to fill is sent once, right after it is stamped", async () => {
    render(<AskAiModal target={{ ...noteTarget, presetId: "summarize", autoSend: true }} onClose={() => {}} />);
    await waitFor(() => expect(genCall()).toBeTruthy());
    expect(callMock.mock.calls.filter((c) => c[0] === "ai_generate_from_prompt")).toHaveLength(1);
  });

  it("new kind: only the blank start presets, header says new draft, where is forced to note with a folder dropdown", () => {
    render(<AskAiModal target={{ kind: "new" }} onClose={() => {}} />);
    // 새 초안에는 시작 프리셋(글 시작하기)만 — 요약·태그 같은 본문 작업 타일은 없다(§7-5).
    expect(tileIds()).toEqual(["start_text"]);
    expect(screen.queryByTestId("askai-ctxstrip")).toBeNull();
    expect(screen.getByTestId("askai-where").textContent).toBe("New note");
    expect(screen.getByTestId("askai-folder").textContent).toBe("Inbox");
    fireEvent.click(screen.getByTestId("askai-where"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["New note"]);
  });

  it("diagram target that is not mounted: the replace option is disabled with a hint and the default falls to new section", () => {
    render(
      <AskAiModal
        target={{ kind: "section", sectionId: "d1", sectionName: "Flow", sectionBody: "{}", isDiagram: true, diagramMounted: false }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("askai-where").textContent).toBe("New section");
    fireEvent.click(screen.getByTestId("askai-where"));
    const replace = screen.getAllByRole("option")[0];
    expect(replace.textContent).toBe("Replace diagram");
    expect(replace.getAttribute("aria-disabled")).toBe("true");
    expect(replace.getAttribute("title")).toBeTruthy();
  });

  it("empty active note: body-work tiles give way to the start presets, with the warning", () => {
    useNotesStore.setState({
      activeNote: { note: { id: "note-1", title: "Note 1", folder_id: "f-1" }, sections: [{ id: "s1", name: "Overview", body_md: "  ", position: 0, kind: "text" }] },
    } as never);
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    expect(tileIds()).toEqual(["start_text"]);
    expect(screen.getByText(/This note is empty/)).toBeTruthy();
  });

  it("selection kind: a body-needing preset seeds the SELECTION ref, and the prompt carries the selected text", async () => {
    render(<AskAiModal target={{ kind: "selection", selectedText: "picked words", from: 1, to: 13 }} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-sel_concise"));
    });
    expect(ctxLabels().map((c) => c.text)).toEqual([expect.stringContaining("Selected text")]);
    await pressEnter();
    await waitFor(() => expect(genCall()).toBeTruthy());
    expect(genCall()![1].prompt).toContain("[Selection]\npicked words");
  });

  it("'/' drops folder and weather into the context strip (not into the sentence) and they resolve into prompt blocks (D16)", async () => {
    useSettingsStore.setState({ defaultMapLocationCustomized: true, defaultMapLocation: { lat: 37.5, lng: 127, zoom: 11 } } as never);
    useNotesStore.setState({ notesByFolder: { "f-1": [{ id: "n-2", title: "\uc9c1\uc804 \ud68c\uc758" }] } } as never);
    callMock.mockImplementation((cmd: string, args: { id: string }) => {
      if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "<p>generated</p>" });
      if (cmd === "note_get") return Promise.resolve({ note: { id: args.id, title: "\uc9c1\uc804 \ud68c\uc758" }, sections: [{ id: "x", body_md: "\uc9c0\ub09c\uc8fc \uc815\ub9ac", kind: "text" }], sources: [], attachments: [] });
      if (cmd === "weather_forecast") return Promise.resolve({ entries: [{ time: "2026-09-15T09:00:00Z", temp_c: 21, symbol_1h: "clearsky_day", symbol_6h: null }] });
      return Promise.resolve({});
    });
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    await act(async () => {
      editorOf().commands.insertContent("\uc774\uac78\ub85c \ub0b4\uc77c \uc77c\uc815 \uc9c0\uc5b4\uc918 /");
    });
    await waitFor(() => expect(document.querySelector(".askai-slash-menu")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Notes in this folder/ }));
    });
    await act(async () => {
      editorOf().commands.insertContent("/");
    });
    await waitFor(() => expect(document.querySelector(".askai-slash-menu")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Weather/ }));
    });
    // \ubb38\uc7a5\uc5d0\ub294 \uce69\uc774 \uc548 \ub4e4\uc5b4\uac00\uace0 `/` \ub3c4 \ub0a8\uc9c0 \uc54a\ub294\ub2e4.
    expect(editorOf().getText()).toBe("\uc774\uac78\ub85c \ub0b4\uc77c \uc77c\uc815 \uc9c0\uc5b4\uc918 ");
    expect(ctxLabels().map((c) => c.text)).toEqual([
      expect.stringContaining("Note 1"),
      expect.stringContaining("Inbox"),
      expect.stringContaining("Weather"),
    ]);

    await pressEnter();
    await waitFor(() => expect(genCall()).toBeTruthy());
    const prompt = genCall()![1].prompt as string;
    expect(prompt).toContain("[Notes in folder]");
    expect(prompt).toContain("\uc9c0\ub09c\uc8fc \uc815\ub9ac");
    expect(prompt).toContain("[Weather]");
    expect(askAiHistory.list()[0].refs).toEqual([{ k: "body" }, { k: "folder", id: "f-1" }, { k: "weather" }]);
  });

  it("'/' shows weather disabled with a hint when no location is saved, and marks refs already on the strip", async () => {
    useSettingsStore.setState({ defaultMapLocationCustomized: false } as never);
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    await act(async () => {
      editorOf().commands.insertContent("/");
    });
    await waitFor(() => expect(document.querySelector(".askai-slash-menu")).toBeTruthy());
    const weather = screen.getByRole("option", { name: /Weather/ });
    expect(weather).toHaveProperty("disabled", true);
    expect(weather.textContent).toContain("No saved location");
    // \uc774\ubbf8 \uc904\uc5d0 \uc788\ub294 \ubcf8\ubb38\uc740 \u300c\ucd94\uac00\ub428\u300d \uc73c\ub85c \ube44\ud65c\uc131.
    const body = screen.getByRole("option", { name: /Whole body/ });
    expect(body).toHaveProperty("disabled", true);
    expect(body.textContent).toContain("Added");
  });

  it("a preset that needs the body seeds it when the strip has none (D17)", async () => {
    // \uc608\uc804\uc5d0 \ucee8\ud14d\uc2a4\ud2b8 \uc5c6\uc774 \ubcf4\ub0b8 \uae30\ub85d\uc744 \uace0\ub974\uba74 \uc904\uc774 \ube44\uc5b4 \uc2dc\uc791\ud55c\ub2e4 \u2014 \uadf8 \ub2e4\uc74c \ud0c0\uc77c\uc774 \ud544\uc694\ud55c \uac83\ub9cc \uc2ec\ub294\ub2e4.
    askAiHistory.push({ doc: [{ t: "text", v: "\uc544\ubb34 \uc9c8\ubb38" }], refs: [], where: "section", targetKind: "note", noteTitle: "Old" });
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    await act(async () => {
      fireEvent.click(screen.getByText("\uc544\ubb34 \uc9c8\ubb38").closest("button")!);
    });
    expect(screen.queryByTestId("askai-ctxstrip")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "AI presets" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-summarize"));
    });
    expect(ctxLabels().map((c) => c.text)).toEqual([expect.stringContaining("Note 1")]);

    // \ud544\uc694 \uc5c6\ub2e4\uace0 \uc120\uc5b8\ud55c \ud0c0\uc77c(\uc9c8\ubb38)\uc740 \uc544\ubb34\uac83\ub3c4 \uc2ec\uc9c0 \uc54a\ub294\ub2e4.
    fireEvent.click(screen.getByLabelText(/Remove/));
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-ask"));
    });
    expect(screen.queryByTestId("askai-ctxstrip")).toBeNull();
  });

  it("a preset with an empty text slot does not send — the slot gets focus instead", async () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("askai-tile-ask"));
    });
    await pressEnter();
    expect(genCall()).toBeUndefined();
    const ed = editorOf();
    expect(ed.state.selection.$from.parent.type.name).toBe("slot");
  });

  // 네이티브 OS 경로 드롭(useFileDropZone — HTML5 File 첨부와 나란한 둘째 경로, SidebarChat.tsx의
  // addDroppedPaths와 같은 모양). pet_chat_read_attach는 부작용 없는 미리보기 커맨드.
  describe("네이티브 파일 드롭 — pet_chat_read_attach 경로", () => {
    it("드롭된 각 경로로 pet_chat_read_attach를 부른다", async () => {
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
        if (cmd === "pet_chat_read_attach") return Promise.resolve({ kind: "doc", name: "report.pdf", excerpt: "pdf 내용 일부" });
        return Promise.resolve({});
      });
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await waitFor(() => expect(dropHandler).not.toBeNull());

      await act(async () => {
        dropHandler!({ payload: { type: "drop", paths: ["C:/drop/report.pdf"], position: { x: 0, y: 0 } } });
      });

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_read_attach", { path: "C:/drop/report.pdf" }));
    });

    it("kind:'doc'+excerpt 응답은 첨부 목록에 반영되고, kind:'image' 응답은 첨부되지 않고 notice만 뜬다", async () => {
      callMock.mockImplementation((cmd: string, args?: { path?: string }) => {
        if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
        if (cmd === "pet_chat_read_attach") {
          if (args?.path === "C:/drop/report.pdf") {
            return Promise.resolve({ kind: "doc", name: "report.pdf", excerpt: "pdf excerpt text" });
          }
          if (args?.path === "C:/drop/photo.png") {
            return Promise.resolve({ kind: "image", name: "photo.png", mime: "image/png", base64: "AAA" });
          }
        }
        return Promise.resolve({});
      });
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await waitFor(() => expect(dropHandler).not.toBeNull());

      await act(async () => {
        dropHandler!({
          payload: { type: "drop", paths: ["C:/drop/report.pdf", "C:/drop/photo.png"], position: { x: 0, y: 0 } },
        });
      });

      // 첨부는 컨텍스트 줄의 file 칩이 유일한 표면이다(드롭 영역의 칩 줄은 중복이라 2026-09-26 에 뺐다).
      await waitFor(() => expect(ctxLabels().some((c) => c.text?.includes("report.pdf"))).toBe(true));
      expect(screen.queryByText("photo.png")).toBeNull();
      await waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    });

    const dropReport = async () => {
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
        if (cmd === "pet_chat_read_attach") return Promise.resolve({ kind: "doc", name: "report.md", excerpt: "REPORT BODY" });
        if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "<p>generated</p>" });
        return Promise.resolve({});
      });
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await waitFor(() => expect(dropHandler).not.toBeNull());
      await act(async () => {
        dropHandler!({ payload: { type: "drop", paths: ["C:/drop/report.md"], position: { x: 0, y: 0 } } });
      });
      await waitFor(() => expect(screen.getByTestId("askai-ctx-file-1")).toBeTruthy());
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
    };

    it("a file chip toggled off is not sent — not even as an 'unreferenced attachment'", async () => {
      await dropReport();
      fireEvent.click(screen.getByTestId("askai-ctx-file-1"));
      expect(ctxLabels()[1].active).toBe(false);
      await pressEnter();
      await waitFor(() => expect(genCall()).toBeTruthy());
      expect(genCall()![1].prompt).toContain("hello world");
      expect(genCall()![1].prompt).not.toContain("REPORT BODY");
    });

    it("picking a history entry keeps the chip of a file attached right now (and it is still sent)", async () => {
      askAiHistory.push({ doc: [{ t: "text", v: "세 줄 요약" }], refs: [{ k: "body" }], where: "section", targetKind: "note", noteTitle: "Old note" });
      await dropReport();
      fireEvent.click(screen.getByRole("tab", { name: "History" }));
      await act(async () => {
        fireEvent.click(screen.getByText("세 줄 요약").closest("button")!);
      });
      await waitFor(() => expect(editorOf().getText()).toContain("세 줄 요약"));
      expect(ctxLabels().map((c) => c.text)).toEqual([expect.stringContaining("Note 1"), expect.stringContaining("report.md")]);
      await pressEnter();
      await waitFor(() => expect(genCall()).toBeTruthy());
      expect(genCall()![1].prompt).toContain("REPORT BODY");
    });

    it("the ✕ on a file chip drops the attachment itself, not just the chip", async () => {
      await dropReport();
      expect(screen.getByLabelText("Attach files").textContent).toContain("1");
      fireEvent.click(screen.getByLabelText("Remove attachment: report.md"));
      expect(ctxLabels().some((c) => c.text?.includes("report.md"))).toBe(false);
      expect(screen.getByLabelText("Attach files").textContent).not.toContain("1");
      await pressEnter();
      await waitFor(() => expect(genCall()).toBeTruthy());
      expect(genCall()![1].prompt).not.toContain("REPORT BODY");
    });
  });

  // 빛줄기는 AI 가 일하는 동안의 신호다 — 작성 중인 모달에 상시로 두르지 않는다(오너 2026-09-27).
  it("the AI modal does not carry the AI beam while composing", () => {
    render(<AskAiModal target={noteTarget} onClose={() => {}} />);
    const card = document.querySelector(".askai-modal-body")!.closest("[data-testid='modal-shell']")!;
    expect(card.getAttribute("data-ai-glow")).toBeNull();
    expect(card.getAttribute("data-ai-glow-beam")).toBeNull();
  });

  // 한 모달에서 작성 → 생성 → 검토(오너 2026-09-27). 결과 확인 켬(기본값) — 보내도 닫히지 않고 결과가
  // 이 안(AiResultPanel)에 뜬다. [삽입]이 실제로 쓰여야 닫히고, 요청문을 고쳐 Enter 하면 새로 만든다.
  describe("한 모달에서 검토", () => {
    const gens = () => callMock.mock.calls.filter((c) => c[0] === "ai_generate_from_prompt");
    const card = () => document.querySelector(".askai-modal-body")!.closest("[data-testid='modal-shell']")!;
    let replies: string[];
    beforeEach(() => {
      useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
      replies = ["<p>첫 결과</p>", "<p>둘째 결과</p>", "<p>셋째 결과</p>"];
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
        if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: replies.shift() ?? "<p>끝</p>" });
        return Promise.resolve({});
      });
    });
    afterEach(() => {
      useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    });

    const sendSummary = async (onClose = vi.fn()) => {
      render(<AskAiModal target={noteTarget} onClose={onClose} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toBe("<p>첫 결과</p>"));
      return onClose;
    };

    // Q9-b(2026-09-28 검토): 메타데이터 스위치는 [삽입] 순간의 값이다 — 보낼 때 굳힌 값이 아니다. 예전엔 결과를 보며
    // 꺼도 메타데이터 호출(노트 내용이 외부로)이 나갔다.
    describe("metadata switch is read at insert time", () => {
      let organize: ReturnType<typeof vi.fn>;
      beforeEach(() => {
        organize = vi.fn(async () => {});
        useAiStore.setState({ organizeCurrentNote: organize } as never);
      });
      const sendAndReview = async (metaAtSend: boolean, onClose = vi.fn()) => {
        render(<AskAiModal target={noteTarget} onClose={onClose} />);
        await act(async () => {
          fireEvent.click(screen.getByTestId("askai-tile-summarize"));
        });
        if (metaAtSend) fireEvent.click(screen.getByTestId("askai-meta-toggle"));
        await pressEnter();
        await waitFor(() => expect(screen.getByTestId("ai-result-insert")).toBeTruthy());
        return onClose;
      };

      it("on when sent, turned off while reviewing → [삽입] makes no metadata call and closes", async () => {
        const onClose = await sendAndReview(true);
        fireEvent.click(screen.getByTestId("askai-meta-toggle"));
        fireEvent.click(screen.getByTestId("ai-result-insert"));
        await waitFor(() => expect(insertSectionMock).toHaveBeenCalled());
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(organize).not.toHaveBeenCalled();
      });

      it("off when sent, turned on while reviewing → [삽입] is followed by the metadata proposal", async () => {
        await sendAndReview(false);
        fireEvent.click(screen.getByTestId("askai-meta-toggle"));
        fireEvent.click(screen.getByTestId("ai-result-insert"));
        await waitFor(() => expect(organize).toHaveBeenCalled());
        expect(organize.mock.calls[0][0]).toBe("note-1");
      });
    });

    it("format chips are only for new content — a replace (section) result offers no 시트로/관계도로", async () => {
      render(<AskAiModal target={{ kind: "section", sectionId: "s1", sectionName: "Overview", sectionBody: "hello world", isDiagram: false, diagramMounted: false }} onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      fireEvent.click(screen.getByTestId("askai-where"));
      fireEvent.click(screen.getByRole("option", { name: t("ai.where_replace_section") }));
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("askai-refine")).toBeTruthy());
      expect(screen.queryByTestId("askai-refine-sheet")).toBeNull();
      expect(screen.queryByTestId("askai-refine-diagram")).toBeNull();
    });

    it("sends without closing, shows the result inline, and [삽입] writes it and then closes", async () => {
      const onClose = await sendSummary();
      expect(onClose).not.toHaveBeenCalled();
      expect(insertSectionMock).not.toHaveBeenCalled();
      // 결과는 이 모달 안 — 작성 단계의 동작 줄(위치·전송)은 결과 패널의 행동 줄로 바뀐다.
      expect(document.querySelector(".askai-modal-body [data-testid='ai-result-panel']")).toBeTruthy();
      expect(screen.queryByTestId("askai-where")).toBeNull();
      await new Promise((r) => setTimeout(r, 450));
      fireEvent.click(screen.getByTestId("ai-result-insert"));
      await waitFor(() => expect(insertSectionMock).toHaveBeenCalled());
      expect(insertSectionMock.mock.calls[0][1]).toContain("첫 결과");
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("the beam runs only while generating", async () => {
      let release!: (v: unknown) => void;
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
        if (cmd === "ai_generate_from_prompt") return new Promise((r) => (release = r));
        return Promise.resolve({});
      });
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      expect(card().getAttribute("data-ai-glow")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-abort")).toBeTruthy());
      expect(card().getAttribute("data-ai-glow")).toBe("active");
      await act(async () => {
        release({ generated: "<p>됐다</p>" });
      });
      await waitFor(() => expect(screen.getByTestId("ai-result-preview")).toBeTruthy());
      expect(card().getAttribute("data-ai-glow")).not.toBe("active");
    });

    it("[버리기] returns to composing with the request kept — nothing written, still open", async () => {
      const onClose = await sendSummary();
      fireEvent.click(screen.getByTestId("ai-result-discard"));
      await waitFor(() => expect(screen.getByTestId("askai-where")).toBeTruthy());
      expect(screen.queryByTestId("ai-result-panel")).toBeNull();
      expect(editorOf().getText()).toContain("요약해줘");
      expect(insertSectionMock).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Enter with the request unchanged regenerates the same request", async () => {
      await sendSummary();
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toBe("<p>둘째 결과</p>"));
      expect(gens()).toHaveLength(2);
      expect(gens()[1][1].prompt).toBe(gens()[0][1].prompt);
    });

    it("editing the request and pressing Enter drops the result and sends the new request — and [삽입] writes the new one", async () => {
      const onClose = await sendSummary();
      await act(async () => {
        editorOf().commands.insertContent(" 세 줄로");
      });
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toBe("<p>둘째 결과</p>"));
      expect(gens()).toHaveLength(2);
      expect(gens()[1][1].prompt).toContain("세 줄로");
      expect(gens()[0][1].prompt).not.toContain("세 줄로");
      await new Promise((r) => setTimeout(r, 450));
      fireEvent.click(screen.getByTestId("ai-result-insert"));
      await waitFor(() => expect(insertSectionMock).toHaveBeenCalledTimes(1));
      expect(insertSectionMock.mock.calls[0][1]).toContain("둘째 결과");
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("changing only the context (a chip turned off) and pressing Enter is a new request, not a replay of the old one", async () => {
      await sendSummary();
      expect(gens()[0][1].prompt).toContain("hello world");
      fireEvent.click(screen.getByTestId("askai-ctx-body-0"));
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toBe("<p>둘째 결과</p>"));
      expect(gens()).toHaveLength(2);
      expect(gens()[1][1].prompt).not.toContain("hello world");
    });

    // 버전 비교(2단계) — 결과마다 버전이 남고, 이전 버전은 다시 생성하지 않고 그대로 삽입된다.
    it("versions: each result is kept; going back to v1 and inserting writes v1 without generating again", async () => {
      const onClose = await sendSummary();
      expect(screen.queryByTestId("askai-version-pager")).toBeNull(); // 하나뿐이면 넘기개 없음
      await pressEnter(); // 그대로 Enter = 다시 생성 → v2
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("둘째 결과"));
      expect(screen.getByTestId("askai-version-pager").textContent).toContain("2/2");
      fireEvent.click(screen.getByLabelText("Previous version"));
      expect(screen.getByTestId("askai-version-view")).toBeTruthy();
      expect(screen.getByTestId("ai-result-preview").textContent).toContain("첫 결과");
      expect(screen.getByTestId("askai-version-pager").textContent).toContain("1/2");
      const before = gens().length;
      fireEvent.click(screen.getByTestId("askai-version-insert"));
      await waitFor(() => expect(insertSectionMock).toHaveBeenCalledTimes(1));
      expect(insertSectionMock.mock.calls[0][1]).toContain("첫 결과");
      expect(gens()).toHaveLength(before); // 생성 없음
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      // 이전 버전 삽입은 히스토리에 새 줄을 남기지 않는다(보낼 때 한 번 남았다).
      expect(askAiHistory.list()).toHaveLength(1);
    });

    it("versions: a revised request adds a version too, and Next returns to the live result", async () => {
      await sendSummary();
      await act(async () => {
        editorOf().commands.insertContent(" 세 줄로");
      });
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("둘째 결과"));
      fireEvent.click(screen.getByLabelText("Previous version"));
      expect(screen.getByTestId("ai-result-preview").textContent).toContain("첫 결과");
      fireEvent.click(screen.getByLabelText("Next version"));
      expect(screen.queryByTestId("askai-version-view")).toBeNull();
      expect(screen.getByTestId("ai-result-preview").textContent).toContain("둘째 결과");
      expect(screen.getByTestId("ai-result-insert")).toBeTruthy();
    });

    // 이어서 다듬기(2단계) — 칩 하나로 그 결과를 입력 삼아 곧장 다시 보낸다.
    it("refine: a chip sends the previous result as context with its instruction, shows it on the strip, and skips history", async () => {
      await sendSummary();
      await waitFor(() => expect(screen.getByTestId("askai-refine")).toBeTruthy());
      fireEvent.click(within(screen.getByTestId("askai-refine")).getByText("Shorter"));
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("둘째 결과"));
      const prompt = gens()[1][1].prompt as string;
      expect(prompt).toContain("Make the previous result shorter");
      expect(prompt).toContain("[Previous result]\n<p>첫 결과</p>");
      expect(ctxLabels().some((c) => c.text?.includes("Result 1") && c.active)).toBe(true);
      expect(editorOf().getText()).toContain("Make the previous result shorter");
      expect(askAiHistory.list()).toHaveLength(1); // 칩 요청은 남기지 않는다
    });

    it("refine twice: the newer result replaces the older one as context", async () => {
      await sendSummary();
      fireEvent.click(within(screen.getByTestId("askai-refine")).getByText("Shorter"));
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("둘째 결과"));
      fireEvent.click(within(screen.getByTestId("askai-refine")).getByText("More detail"));
      await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("셋째 결과"));
      const prompt = gens()[2][1].prompt as string;
      expect(prompt).toContain("[Previous result]\n<p>둘째 결과</p>");
      expect(prompt).not.toContain("첫 결과");
      expect(ctxLabels().filter((c) => c.text?.startsWith("Result"))).toHaveLength(1);
    });

    // 메타데이터 단계(2단계) — "메타데이터 포함"으로 삽입하면 닫지 않고 그 노트의 제안을 이 안에서 받는다.
    describe("메타데이터 단계", () => {
      let applyProposal: ReturnType<typeof vi.fn>;
      beforeEach(() => {
        const organizeCurrentNote = vi.fn(async (noteId: string) => {
          useAiStore.setState({ lastProposal: { title: "새 제목", confidence: 0.9 }, lastProposalNoteId: noteId, lastProposalOrigin: "manual" } as never);
        });
        applyProposal = vi.fn(async () => {
          useAiStore.setState({ lastProposal: null, lastProposalNoteId: null, lastProposalOrigin: null } as never);
        });
        useAiStore.setState({ organizeCurrentNote, applyProposal } as never);
      });
      afterEach(() => {
        useAiStore.setState({ lastProposal: null, lastProposalNoteId: null, lastProposalOrigin: null } as never);
      });
      const insertWithMetadata = async (onClose: () => void) => {
        const utils = render(<AskAiModal target={noteTarget} onClose={onClose} />);
        await act(async () => {
          fireEvent.click(screen.getByTestId("askai-tile-summarize"));
        });
        fireEvent.click(screen.getByTestId("askai-meta-toggle"));
        await pressEnter();
        await waitFor(() => expect(screen.getByTestId("ai-result-insert")).toBeTruthy());
        await new Promise((r) => setTimeout(r, 450));
        fireEvent.click(screen.getByTestId("ai-result-insert"));
        await waitFor(() => expect(insertSectionMock).toHaveBeenCalled());
        return utils;
      };

      it("after [삽입] the modal stays for the proposal (not the standalone window); applying it closes the modal", async () => {
        const onClose = vi.fn();
        await insertWithMetadata(onClose);
        await waitFor(() => expect(document.querySelector("[data-testid='askai-meta-step'] [data-testid='askai-meta-review']")).toBeTruthy());
        expect(onClose).not.toHaveBeenCalled();
        // 그 노트의 제안은 AI 모달이 품고 있다 — 독립 확인 창은 그리지 않는다.
        expect(useProposalHostStore.getState().noteId).toBe("note-1");
        fireEvent.click(screen.getByTestId("askai-meta-apply"));
        await waitFor(() => expect(applyProposal).toHaveBeenCalled());
        await waitFor(() => expect(onClose).toHaveBeenCalled());
      });

      it("closing while the proposal is still being made: it never pops up in the standalone window, and the flag is released after", async () => {
        let finish!: () => void;
        const organizeCurrentNote = vi.fn(
          (noteId: string) =>
            new Promise<void>((resolve) => {
              finish = () => {
                useAiStore.setState({ lastProposal: { title: "새 제목", confidence: 0.9 }, lastProposalNoteId: noteId, lastProposalOrigin: "manual" } as never);
                resolve();
              };
            }),
        );
        useAiStore.setState({ organizeCurrentNote } as never);
        render(<AiConfirmModal />); // 독립 확인 창 — 이 테스트 동안 한 번도 제안을 그리면 안 된다
        let panelSeen = false;
        const mo = new MutationObserver(() => {
          if (document.querySelector("[data-testid='ai-proposal-panel']")) panelSeen = true;
        });
        mo.observe(document.body, { childList: true, subtree: true });
        try {
          const { unmount } = await insertWithMetadata(vi.fn());
          await waitFor(() => expect(screen.getByTestId("askai-meta-pending")).toBeTruthy());
          unmount();
          // 아직 만드는 중 — 표시를 붙들어 둔다(지금 풀면 곧 올 제안이 독립 창에 한 번 뜬다).
          expect(useProposalHostStore.getState().noteId).toBe("note-1");
          await act(async () => {
            finish();
          });
          await waitFor(() => expect(useProposalHostStore.getState().noteId).toBeNull());
          expect(useAiStore.getState().lastProposal).toBeNull();
          expect(panelSeen).toBe(false);
        } finally {
          mo.disconnect();
        }
      });

      it("closing during the metadata step skips it — the proposal is cleared and the host flag released", async () => {
        const { unmount } = await insertWithMetadata(vi.fn());
        await waitFor(() => expect(screen.getByTestId("askai-meta-review")).toBeTruthy());
        unmount();
        expect(useAiStore.getState().lastProposal).toBeNull();
        expect(useProposalHostStore.getState().noteId).toBeNull();
        expect(applyProposal).not.toHaveBeenCalled();
      });

      // 오너 2026-09-27 "메타데이터 모달이 따로 분리된 게 싫다" — 제안은 결과 패널과 같은 틀에 서고, 위의 줄과
      // 요청문 상자는 그대로 남는다.
      it("after inserting: the proposal sits under an 'inserted' line in the result frame, the request box rests, Skip closes", async () => {
        const onClose = vi.fn();
        await insertWithMetadata(onClose);
        await waitFor(() => expect(screen.getByTestId("askai-meta-review")).toBeTruthy());
        expect(screen.getByTestId("askai-meta-inserted")).toBeTruthy();
        expect(screen.getByTestId("askai-meta-step").classList.contains("ai-result-panel--inline")).toBe(true);
        expect(pm().getAttribute("contenteditable")).toBe("false");
        expect(screen.getByTestId("askai-meta-cancel").textContent).toBe("Skip");
        fireEvent.click(screen.getByTestId("askai-meta-cancel"));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(applyProposal).not.toHaveBeenCalled();
      });

      it("metadata/tags presets are reviewed here too, never in the standalone window; discarding returns to composing", async () => {
        const onClose = vi.fn();
        render(<AiConfirmModal />);
        render(<AskAiModal target={noteTarget} onClose={onClose} />);
        await act(async () => {
          fireEvent.click(screen.getByTestId("askai-tile-metadata"));
        });
        await pressEnter();
        await waitFor(() => expect(screen.getByTestId("askai-meta-review")).toBeTruthy());
        expect(screen.queryByTestId("ai-proposal-panel")).toBeNull();
        expect(screen.queryByTestId("askai-meta-inserted")).toBeNull();
        expect(pm().getAttribute("contenteditable")).toBe("true");
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId("askai-meta-cancel"));
        await waitFor(() => expect(screen.getByTestId("askai-fixed-where")).toBeTruthy());
        expect(onClose).not.toHaveBeenCalled();
        expect(useAiStore.getState().lastProposal).toBeNull();
        expect(useProposalHostStore.getState().noteId).toBeNull();
      });

      // 개발 빌드(StrictMode)는 마운트 직후 정리를 한 번 돌린다 — "닫혔다" 표시가 그대로 켜져 남아, 도착한 제안을
      // 늦게 온 것으로 치우고 "만드는 중"에 멈췄었다(2026-09-27 실앱에서 발견).
      it("under StrictMode the proposal still arrives in the modal (the closed flag is reset on mount)", async () => {
        render(
          <StrictMode>
            <AskAiModal target={noteTarget} onClose={vi.fn()} />
          </StrictMode>,
        );
        await act(async () => {
          fireEvent.click(screen.getByTestId("askai-tile-metadata"));
        });
        await pressEnter();
        await waitFor(() => expect(screen.getByTestId("askai-meta-review")).toBeTruthy());
        expect(useAiStore.getState().lastProposal).not.toBeNull();
      });

      it("a preset proposal: Enter with an edited request asks again; applying closes", async () => {
        const onClose = vi.fn();
        render(<AskAiModal target={noteTarget} onClose={onClose} />);
        await act(async () => {
          fireEvent.click(screen.getByTestId("askai-tile-metadata"));
        });
        await pressEnter();
        await waitFor(() => expect(screen.getByTestId("askai-meta-review")).toBeTruthy());
        const organize = useAiStore.getState().organizeCurrentNote as unknown as ReturnType<typeof vi.fn>;
        await act(async () => {
          editorOf().commands.insertContentAt(1, "영어로 ");
        });
        await pressEnter();
        await waitFor(() => expect(organize).toHaveBeenCalledTimes(2));
        expect(organize.mock.calls[1][2]).toContain("영어로");
        await waitFor(() => expect(screen.getByTestId("askai-meta-review")).toBeTruthy());
        fireEvent.click(screen.getByTestId("askai-meta-apply"));
        await waitFor(() => expect(applyProposal).toHaveBeenCalled());
        await waitFor(() => expect(onClose).toHaveBeenCalled());
      });
    });

    it("versions: a retry that fails does not strand the good result — the error is one more slot and v1 stays insertable", async () => {
      replies = ["<p>첫 결과</p>", ""];
      const onClose = await sendSummary();
      await pressEnter(); // 그대로 Enter = 다시 생성 → 오류
      await waitFor(() => expect(screen.getByTestId("ai-result-close")).toBeTruthy());
      expect(screen.getByTestId("askai-version-pager").textContent).toContain("2/2");
      fireEvent.click(screen.getByLabelText("Previous version"));
      expect(screen.getByTestId("ai-result-preview").textContent).toContain("첫 결과");
      fireEvent.click(screen.getByTestId("askai-version-insert"));
      await waitFor(() => expect(insertSectionMock).toHaveBeenCalledTimes(1));
      expect(insertSectionMock.mock.calls[0][1]).toContain("첫 결과");
      expect(gens()).toHaveLength(2); // 이전 버전 삽입은 생성하지 않는다
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("an error inside the modal offers 'Edit request' (not 'Close') and it returns to composing", async () => {
      replies = [""]; // 빈 결과 → 오류 상태
      const onClose = vi.fn();
      render(<AskAiModal target={noteTarget} onClose={onClose} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      await pressEnter();
      const back = await screen.findByTestId("ai-result-close");
      expect(back.textContent).toBe("Edit request");
      // 대상 문구는 행동 줄 안(작성 단계의 "위치" 자리)에 있다.
      expect(screen.getByTestId("ai-result-target").closest(".ai-result-panel__actions")).toBeTruthy();
      fireEvent.click(back);
      await waitFor(() => expect(screen.getByTestId("askai-where")).toBeTruthy());
      expect(onClose).not.toHaveBeenCalled();
      expect(insertSectionMock).not.toHaveBeenCalled();
    });

    // ProseMirror 가 편집기 안 Escape 를 삼켜 ModalShell 이 못 닫던 것(2026-09-27) — 상자에 포커스가 있어도
    // Escape 는 모달을 닫는다(= 버리기).
    it("Escape inside the request box closes the modal and discards the result", async () => {
      const onClose = await sendSummary();
      fireEvent.keyDown(pm(), { key: "Escape" });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(insertSectionMock).not.toHaveBeenCalled();
    });

    it("closing the modal while a result is shown discards it — nothing written, no session left behind", async () => {
      const { unmount } = render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      await pressEnter();
      await waitFor(() => expect(screen.getByTestId("ai-result-preview")).toBeTruthy());
      unmount();
      await waitFor(() => expect(useAiResultGateStore.getState().session).toBeNull());
      expect(insertSectionMock).not.toHaveBeenCalled();
    });

    describe("Wave 1 (W1: 틀 · 행동 줄 · 첫 실행 · 버리기 이유 제거)", () => {
      it("first run: shows welcome card when askai_welcome is not seen; dismisses and updates seenFeatureBriefs", async () => {
        useSettingsStore.setState({ seenFeatureBriefs: [] });
        render(<AskAiModal target={noteTarget} onClose={() => {}} />);
        expect(screen.getByTestId("askai-welcome-card")).toBeTruthy();
        expect(document.querySelector(".askai-composer__editor")).toBeNull();

        fireEvent.click(screen.getByTestId("askai-welcome-start"));
        expect(screen.queryByTestId("askai-welcome-card")).toBeNull();
        expect(document.querySelector(".askai-composer__editor")).toBeTruthy();
        expect(useSettingsStore.getState().seenFeatureBriefs).toContain("askai_welcome");
      });

      it("header: ? button re-opens welcome card; header displays provider and external badge when external", async () => {
        callMock.mockImplementation((cmd: string) => {
          if (cmd === "settings_get_all") {
            return Promise.resolve({ settings: { ai_provider: "gemini" } });
          }
          return Promise.resolve({});
        });

        render(<AskAiModal target={noteTarget} onClose={() => {}} />);
        await waitFor(() => {
          expect(screen.getByTestId("askai-header").textContent).toContain("Gemini");
        });
        expect(screen.getByTestId("askai-external-badge")).toBeTruthy();

        // Click ? button
        fireEvent.click(screen.getByTestId("askai-help-btn"));
        expect(screen.getByTestId("askai-welcome-card")).toBeTruthy();

        // Dismiss again
        fireEvent.click(screen.getByTestId("askai-welcome-start"));
        expect(screen.queryByTestId("askai-welcome-card")).toBeNull();
      });

      it("review composer hint: unchanged shows 'Enter 다시 생성', edited shows 'Enter 새 요청'", async () => {
        await sendSummary();
        // Review phase: unchanged prompt shows 'Enter 다시 생성'
        expect(screen.getByTestId("askai-enter-hint").textContent).toBe(t("ai.hint_enter_regenerate"));

        // Edit prompt: changes to 'Enter 새 요청'
        await act(async () => {
          editorOf().commands.insertContent(" 추가 지시");
        });
        expect(screen.getByTestId("askai-enter-hint").textContent).toBe(t("ai.hint_enter_new_request"));
      });

      it("Q9-b: toggling metadata switch during review does NOT change request signature", async () => {
        await sendSummary();
        expect(screen.getByTestId("askai-enter-hint").textContent).toBe(t("ai.hint_enter_regenerate"));

        // Toggle metadata switch
        fireEvent.click(screen.getByTestId("askai-meta-toggle"));

        // Hint should STILL be '다시 생성' because metadata switch is isolated from signature
        expect(screen.getByTestId("askai-enter-hint").textContent).toBe(t("ai.hint_enter_regenerate"));
      });

      it("version view displays unified action buttons: [버리기] [다시 생성] [삽입]", async () => {
        await sendSummary(); // v1
        await pressEnter(); // v2
        await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toBe("<p>둘째 결과</p>"));

        // Navigate to previous version
        fireEvent.click(screen.getByLabelText("Previous version"));
        expect(screen.getByTestId("askai-version-view")).toBeTruthy();

        // Check unified action buttons
        expect(screen.getByTestId("askai-version-discard")).toBeTruthy();
        expect(screen.getByTestId("askai-version-retry")).toBeTruthy();
        expect(screen.getByTestId("askai-version-insert")).toBeTruthy();
        // Discarding returns to compose mode
        fireEvent.click(screen.getByTestId("askai-version-discard"));
        await waitFor(() => expect(screen.getByTestId("askai-where")).toBeTruthy());
      });
    });

    describe("Wave 2 (W2: 결과 상자 머리·몸·발, 생성 중 스켈레톤, 오류를 상자 안으로)", () => {
      it("결과 상자 구조: 머리(결과), 몸(미리보기), 발(메타 캡션) 및 다듬기 칩 상자 밖 배치", async () => {
        await sendSummary();
        const box = document.querySelector(".ai-result-box[data-status='result']");
        expect(box).toBeTruthy();

        // 머리: 제목 'Result · Text' (W3 형식 표기)
        const headTitle = box!.querySelector(".ai-result-box__title");
        expect(headTitle?.textContent).toBe(t("aiResult.head_result_with_format", { format: t("ai.format_text") }));

        // 몸: 결과 본문
        const body = box!.querySelector(".ai-result-box__body");
        expect(body?.querySelector("[data-testid='ai-result-preview']")).toBeTruthy();

        // 발: 메타 캡션
        const foot = box!.querySelector(".ai-result-box__foot");
        expect(foot?.querySelector(".ai-result-panel__meta-caption")).toBeTruthy();

        // 다듬기 칩: 상자 밖 바로 아래
        const refine = screen.getByTestId("askai-refine");
        expect(box!.contains(refine)).toBe(false);
      });

      it("버전 넘기개가 행동 줄이 아닌 머리 오른쪽으로 이동하고 이전 버전도 동일한 상자 구조를 가짐", async () => {
        await sendSummary(); // v1
        await pressEnter(); // v2
        await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("둘째 결과"));

        const box = document.querySelector(".ai-result-box[data-status='result']");
        const headExtra = box!.querySelector(".ai-result-box__head-extra");
        const pager = screen.getByTestId("askai-version-pager");
        expect(headExtra?.contains(pager)).toBe(true);

        const actions = document.querySelector(".ai-result-panel__actions");
        expect(actions?.contains(pager)).toBe(false);

        // 이전 버전 보기
        fireEvent.click(screen.getByLabelText("Previous version"));
        const versionView = screen.getByTestId("askai-version-view");
        const vBox = versionView.querySelector(".ai-result-box[data-status='result']");
        expect(vBox).toBeTruthy();
        expect(vBox!.querySelector(".ai-result-box__title")?.textContent).toBe(t("aiResult.head_result_with_format", { format: t("ai.format_text") }));
        expect(vBox!.querySelector(".ai-result-box__head-extra")?.contains(screen.getByTestId("askai-version-pager"))).toBe(true);
        expect(vBox!.querySelector(".ai-result-box__body [data-testid='ai-result-preview']")).toBeTruthy();
        expect(versionView.querySelector(".ai-result-panel__actions")?.contains(screen.getByTestId("askai-version-pager"))).toBe(false);
      });

      it("생성 중: 결과 상자 머리에 'Generating'과 경과시간, 몸에 스켈레톤 3줄, 발에 모델 캡션", async () => {
        render(<AskAiModal target={noteTarget} onClose={() => {}} />);
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));

        // 응답을 지연시켜 pending 상태 유지
        let resolveGen: (v: any) => void;
        callMock.mockImplementation((cmd: string) => {
          if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
          if (cmd === "ai_generate_from_prompt") {
            return new Promise((resolve) => {
              resolveGen = resolve;
            });
          }
          return Promise.resolve({});
        });

        await pressEnter();
        await waitFor(() => expect(document.querySelector(".ai-result-box[data-status='pending']")).toBeTruthy());

        const box = document.querySelector(".ai-result-box[data-status='pending']")!;
        expect(box.querySelector(".ai-result-box__title")?.textContent).toBe(t("aiResult.head_generating"));
        expect(box.querySelector(".ai-result-box__head-extra")?.textContent).toMatch(/^\d+:\d{2}$/);

        // 몸: 스켈레톤 라인 3개
        const skeletons = box.querySelectorAll(".ai-skeleton-line");
        expect(skeletons.length).toBe(3);

        // 발: 모델만 — 제공자는 헤더가 보인다(§3.6), 캡션에 되풀이하지 않는다.
        const foot = box.querySelector(".ai-result-box__foot");
        expect(foot?.textContent?.toLowerCase() ?? "").not.toContain("ollama");
        expect(screen.getByTestId("askai-header").textContent).toContain("Ollama");

        // 마무리
        await act(async () => {
          resolveGen!({ generated: "<p>완료</p>" });
        });
        await waitFor(() => expect(screen.getByTestId("ai-result-preview")).toBeTruthy());
      });

      it("오류가 결과 상자 안으로 들어옴: 머리에 에러 타이틀, 몸에 힌트 및 details", async () => {
        await sendSummary();
        callMock.mockImplementation((cmd: string) => {
          if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
          if (cmd === "ai_generate_from_prompt") return Promise.reject(new Error("AI connection refused"));
          return Promise.resolve({});
        });

        await pressEnter(); // retry -> error
        await waitFor(() => expect(document.querySelector(".ai-result-box[data-status='error']")).toBeTruthy());

        const box = document.querySelector(".ai-result-box[data-status='error']")!;
        expect(box.querySelector(".ai-result-box__title")?.textContent).toContain("⚠");
        expect(box.querySelector(".ai-result-panel__error-hint")).toBeTruthy();
        expect(box.querySelector(".ai-result-panel__error-summary")).toBeTruthy();
      });

      it("제안 단계: 상자 머리에 'Proposal · <노트제목>', 발에 적용 후 태그 캡션", async () => {
        useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
        useAiStore.setState({
          organizeCurrentNote: vi.fn(async (noteId: string) => {
            useAiStore.setState({
              lastProposal: { title: "새제목", tag_names: ["여행", "휴가"], confidence: 0.9 },
              lastProposalNoteId: noteId,
              lastProposalOrigin: "manual",
            } as never);
          }),
          lastProposalNoteId: "note-1",
        } as never);
        render(<AskAiModal target={noteTarget} onClose={() => {}} />);

        // 제안 프리셋 스탬프
        fireEvent.click(screen.getByTestId("askai-tile-tags"));
        await pressEnter();
        await waitFor(() => expect(document.querySelector(".askai-metapanel")).toBeTruthy());

        const box = document.querySelector(".ai-result-box[data-status='proposal']")!;
        expect(box).toBeTruthy();
        expect(box.querySelector(".ai-result-box__title")?.textContent).toContain(t("ai.proposal_head"));

        await waitFor(() => expect(document.querySelector("[data-testid='askai-meta-review']")).toBeTruthy());
        await waitFor(() => expect(document.querySelector(".ai-result-box__foot")).toBeTruthy());
        const foot = document.querySelector(".ai-result-box__foot");
        expect(foot?.textContent).toContain("여행");
      });
    });

    describe("Wave 3 (W3: 결과 렌더링 · 출력 형식)", () => {
      it("행동 줄 형식 드롭다운: 기본값 텍스트 및 시트/관계도 선택 가능", async () => {
        render(<AskAiModal target={noteTarget} onClose={() => {}} />);
        const formatBtn = screen.getByTestId("askai-format");
        expect(formatBtn.textContent).toContain(t("ai.format_text"));

        fireEvent.click(formatBtn);
        const formatList = screen.getByTestId("askai-format-list");
        const sheetOption = within(formatList).getByText(t("ai.format_sheet"));
        fireEvent.click(sheetOption);
        expect(screen.getByTestId("askai-format").textContent).toContain(t("ai.format_sheet"));

        fireEvent.click(screen.getByTestId("askai-format"));
        const formatList2 = screen.getByTestId("askai-format-list");
        const diagramOption = within(formatList2).getByText(t("ai.format_diagram"));
        fireEvent.click(diagramOption);
        expect(screen.getByTestId("askai-format").textContent).toContain(t("ai.format_diagram"));
      });

      it("위치가 교체 대상이면 형식 드롭다운 대신 고정 라벨이 표시됨", async () => {
        const sectionTarget: AskAiTarget = { kind: "section", sectionId: "s1", sectionName: "Intro", sectionBody: "Hello", isDiagram: false, diagramMounted: false, isSheet: false, sheetMounted: false };
        render(<AskAiModal target={sectionTarget} onClose={() => {}} />);
        fireEvent.click(screen.getByTestId("askai-where"));
        const whereList = screen.getByTestId("askai-where-list");
        fireEvent.click(within(whereList).getByText(t("ai.where_replace_section")));

        expect(screen.queryByTestId("askai-format")).toBeNull();
        const fixed = screen.getByTestId("askai-fixed-format");
        expect(fixed.textContent).toContain(t("ai.format_text"));
      });

      it("원문 보기 토글: 결과 상자 머리에서 원문(raw) 보기와 렌더링 보기 전환", async () => {
        await sendSummary();
        const rawToggle = screen.getByTestId("ai-result-raw-toggle");
        expect(rawToggle.textContent).toContain(t("aiResult.view_raw"));

        // 원문 보기로 전환
        fireEvent.click(rawToggle);
        expect(screen.getByTestId("ai-result-raw-content")).toBeTruthy();
        expect(screen.getByTestId("ai-result-raw-content").textContent).toContain("첫 결과");
        expect(rawToggle.textContent).toContain(t("aiResult.view_rendered"));

        // 다시 렌더링 보기로 복귀
        fireEvent.click(rawToggle);
        expect(screen.queryByTestId("ai-result-raw-content")).toBeNull();
        expect(screen.getByTestId("ai-result-preview")).toBeTruthy();
      });

      it("다듬기 줄 분할: 기존 칩과 형식 칩 구분선 및 현재 형식 칩 숨김", async () => {
        await sendSummary();
        const refineGroup = screen.getByTestId("askai-refine");
        expect(refineGroup.querySelector(".askai-refine__sep")).toBeTruthy();

        // 텍스트 결과 상태: As text는 없고 As sheet, As diagram 표시
        expect(screen.queryByTestId("askai-refine-text")).toBeNull();
        expect(screen.getByTestId("askai-refine-sheet")).toBeTruthy();
        expect(screen.getByTestId("askai-refine-diagram")).toBeTruthy();
      });

      it("형식이 다른 버전 간 이동 시 머리 제목 및 렌더러 전환", async () => {
        const validSheetJson = JSON.stringify({
          v: 1,
          rows: 10,
          cols: [{ w: 100 }, { w: 100 }],
          cells: {
            A1: { raw: "사과" },
            B1: { raw: "5" },
          },
          charts: [],
        });

        replies = ["첫 텍스트 결과", validSheetJson];
        render(<AskAiModal target={noteTarget} onClose={() => {}} />);
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
        await pressEnter();

        // v1: 텍스트 결과
        await waitFor(() => expect(screen.getByTestId("ai-result-preview").textContent).toContain("첫 텍스트 결과"));
        let headTitle = document.querySelector(".ai-result-box__title");
        expect(headTitle?.textContent).toBe(t("aiResult.head_result_with_format", { format: t("ai.format_text") }));

        // 형식 칩(시트로)을 눌러 새 요청
        fireEvent.click(screen.getByTestId("askai-refine-sheet"));
        await waitFor(() => expect(screen.getByTestId("askai-version-pager").textContent).toContain("2/2"));

        // v2: 시트 결과 확인
        headTitle = document.querySelector(".ai-result-box__title");
        expect(headTitle?.textContent).toBe(t("aiResult.head_result_with_format", { format: t("ai.format_sheet") }));
        expect(document.querySelector(".sheet-preview-container")).toBeTruthy();

        // 이전 버전(v1: 텍스트)으로 이동
        fireEvent.click(screen.getByLabelText("Previous version"));
        await waitFor(() => expect(screen.getByTestId("askai-version-pager").textContent).toContain("1/2"));
        headTitle = document.querySelector(".ai-result-box__title");
        expect(headTitle?.textContent).toBe(t("aiResult.head_result_with_format", { format: t("ai.format_text") }));
        expect(screen.getByTestId("ai-result-preview").textContent).toContain("첫 텍스트 결과");
      });

      it("형식이 섞인 버전 캐시에서 시트 버전 삽입 시 안전하게 스키마 검증 후 삽입", async () => {
        const validSheetJson = JSON.stringify({
          v: 1,
          rows: 10,
          cols: [{ w: 100 }],
          cells: { A1: { raw: "사과" } },
          charts: [],
        });
        replies = ["첫 텍스트 결과", validSheetJson];
        render(<AskAiModal target={noteTarget} onClose={() => {}} />);
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
        await pressEnter();
        // v2 시트 생성
        await waitFor(() => expect(screen.getByTestId("askai-refine-sheet")).toBeTruthy());
        fireEvent.click(screen.getByTestId("askai-refine-sheet"));
        await waitFor(() => expect(screen.getByTestId("askai-version-pager").textContent).toContain("2/2"));

        // 시트 버전 삽입
        await new Promise((r) => setTimeout(r, 450));
        fireEvent.click(screen.getByTestId("ai-result-insert"));
        await waitFor(() => expect(insertSectionMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining("사과"),
          expect.anything(),
          "sheet",
          expect.anything(),
        ));
      });
    });
  });

  // AI 프리셋 편집(오너 2026-09-27) — 연필·"+추가"는 설정 창이 아니라 이 모달 위에 편집기를 연다.
  describe("AI 프리셋 편집 진입점", () => {
    it("the pencil opens the AI-presets-only editor in place (no settings window); closing returns to the modal", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      fireEvent.click(screen.getByLabelText("Edit AI presets"));
      const stub = await screen.findByTestId("preset-modal-stub");
      expect(stub.dataset.aiOnly).toBe("true");
      expect(stub.dataset.autoAdd).toBe("null");
      expect(callMock).not.toHaveBeenCalledWith("settings_window_open", expect.anything());
      fireEvent.click(screen.getByText("close-preset-modal"));
      expect(screen.queryByTestId("preset-modal-stub")).toBeNull();
      expect(document.querySelector(".askai-modal-body")).toBeTruthy();
    });

    it("the add tile opens it with a new preset that will show up for THIS target", async () => {
      const { unmount } = render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      fireEvent.click(screen.getByLabelText("Add"));
      expect(JSON.parse((await screen.findByTestId("preset-modal-stub")).dataset.autoAdd!)).toEqual({ kind: "text" });
      unmount();

      // 관계도 대상 — 커스텀 프리셋의 옛 기본 자리(노트·섹션)에는 관계도가 없어, 대상을 적어야 타일로 뜬다.
      const diagram: AskAiTarget = { kind: "section", sectionId: "d1", sectionName: "Flow", sectionBody: "{}", isDiagram: true, diagramMounted: true };
      render(<AskAiModal target={diagram} onClose={() => {}} />);
      fireEvent.click(screen.getByLabelText("Add"));
      expect(JSON.parse((await screen.findByTestId("preset-modal-stub")).dataset.autoAdd!)).toEqual({ kind: "diagram", targets: ["diagram"] });
    });

    it("the pencil opens the editor on the tile picked right now", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      fireEvent.click(screen.getByLabelText("Edit AI presets"));
      expect((await screen.findByTestId("preset-modal-stub")).dataset.initialId).toBe("summarize");
    });
  });

  // 프리셋으로 저장(오너 2026-09-27 "적은 내용을 바로 프리셋으로") — 요청문 상자 모서리의 버튼.
  describe("프리셋으로 저장", () => {
    const origAddCustom = useAiPresetsStore.getState().addCustom;
    let addCustom: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      addCustom = vi.fn(async (name: string, prompt: string, kind?: string, targets?: unknown, extra?: Record<string, unknown>) => {
        const created = { id: "mine-1", name, prompt, kind, isBuiltin: false, hidden: false, ...(targets ? { targets } : {}), ...(extra ?? {}) };
        useAiPresetsStore.setState({ list: [...useAiPresetsStore.getState().list, created] } as never);
      });
      useAiPresetsStore.setState({ addCustom } as never);
    });
    afterEach(() => useAiPresetsStore.setState({ addCustom: origAddCustom }));

    it("appears only when there is something new; saves the request as a preset for this target and selects its tile", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      expect(screen.queryByTestId("askai-save-preset")).toBeNull(); // 빈 상자
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      expect(screen.queryByTestId("askai-save-preset")).toBeNull(); // 스탬프 그대로 — 저장할 새것이 없다
      await act(async () => {
        editorOf().commands.insertContentAt(1, "표로 ");
      });
      fireEvent.click(screen.getByTestId("askai-save-preset"));
      await waitFor(() => expect(addCustom).toHaveBeenCalledTimes(1));
      const [name, prompt, kind, targets, extra] = addCustom.mock.calls[0];
      expect(prompt.startsWith("표로 ")).toBe(true);
      expect(name.startsWith("표로 ")).toBe(true);
      expect(kind).toBe("text");
      expect(targets).toBeUndefined(); // 노트·섹션 = 커스텀 프리셋의 기본 자리
      expect(extra).toEqual({ where: undefined, needs: ["body"] });
      await waitFor(() => expect(screen.getByTestId("askai-tile-mine-1").getAttribute("aria-pressed")).toBe("true"));
      expect(screen.queryByTestId("askai-save-preset")).toBeNull();
      expect(emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining(name));
    });

    it("a free request keeps its destination; proposal presets cannot be saved", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await act(async () => {
        editorOf().commands.insertContent("회의록 양식으로 정리해");
      });
      fireEvent.click(screen.getByTestId("askai-where"));
      fireEvent.click(screen.getByText("New note"));
      fireEvent.click(screen.getByTestId("askai-save-preset"));
      await waitFor(() => expect(addCustom).toHaveBeenCalledTimes(1));
      expect(addCustom.mock.calls[0][1]).toBe("회의록 양식으로 정리해");
      expect(addCustom.mock.calls[0][4]).toEqual({ where: "note", needs: ["body"] });

      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-metadata"));
      });
      await act(async () => {
        editorOf().commands.insertContentAt(1, "꼼꼼히 ");
      });
      expect(screen.queryByTestId("askai-save-preset")).toBeNull();
    });
  });

  // 메타데이터 스위치(오너 2026-09-26) — 기본 꺼짐. 켜면 내용이 노트에 반영된 **뒤** 같은 요청으로
  // 제목·태그·연도·지역을 고칠 제안이 이어진다(검토 후 적용). 꺼져 있으면 내용만.
  describe("메타데이터 스위치", () => {
    let organizeCurrentNote: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      organizeCurrentNote = vi.fn(async (..._args: unknown[]) => {});
      useAiStore.setState({ organizeCurrentNote } as never);
    });
    const settle = () => act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    it("off by default: sending processes the content only", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      expect(screen.getByTestId("askai-meta-toggle").getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      await pressEnter();
      await waitFor(() => expect(insertSectionMock).toHaveBeenCalled());
      await settle();
      expect(organizeCurrentNote).not.toHaveBeenCalled();
    });

    it("on: after the content lands, a metadata proposal follows for the same note with the request (no folder)", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      fireEvent.click(screen.getByTestId("askai-meta-toggle"));
      expect(screen.getByTestId("askai-meta-toggle").getAttribute("aria-checked")).toBe("true");
      await pressEnter();
      await waitFor(() => expect(organizeCurrentNote).toHaveBeenCalled());
      expect(insertSectionMock).toHaveBeenCalled();
      const [noteId, fields, guidance] = organizeCurrentNote.mock.calls[0];
      expect(noteId).toBe("note-1");
      expect(fields).toEqual(["title", "tags", "year", "region"]);
      // 사용자가 고친 메타데이터 프리셋 지침은 살아 있고, 요청문이 그 뒤에 붙는다.
      expect(guidance).toContain("METADATA GUIDANCE");
      expect(guidance).toContain("요약해줘");
      // organize 는 본문을 DB 에서 읽는다 — 내용을 쓴 **뒤**, 제안을 부르기 **전**에 flush 가 한 번 있다
      // (body 참조를 풀 때의 flush 는 쓰기보다 앞이라 이 순서를 만족하지 못한다).
      const lastFlush = Math.max(...flushAllMock.mock.invocationCallOrder);
      expect(lastFlush).toBeGreaterThan(insertSectionMock.mock.invocationCallOrder[0]);
      expect(lastFlush).toBeLessThan(organizeCurrentNote.mock.invocationCallOrder[0]);
    });

    it("on, but the content produced nothing: no metadata proposal", async () => {
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
        if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "" });
        return Promise.resolve({});
      });
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-summarize"));
      });
      fireEvent.click(screen.getByTestId("askai-meta-toggle"));
      await pressEnter();
      await waitFor(() => expect(genCall()).toBeTruthy());
      await settle();
      expect(insertSectionMock).not.toHaveBeenCalled();
      expect(organizeCurrentNote).not.toHaveBeenCalled();
    });

    it("disabled for a new-note destination and for proposal presets; absent for a new draft", async () => {
      const { unmount } = render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId("askai-meta-toggle"));
      fireEvent.click(screen.getByTestId("askai-where"));
      fireEvent.click(screen.getByText("New note"));
      const toggle = screen.getByTestId("askai-meta-toggle");
      expect(toggle.getAttribute("aria-disabled")).toBe("true");
      // 켜 둔 값은 남아 있어도 이 위치에선 꺼진 것으로 보이고, 보내도 후속이 없다.
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-metadata"));
      });
      expect(screen.getByTestId("askai-meta-toggle").getAttribute("aria-disabled")).toBe("true");
      unmount();

      render(<AskAiModal target={{ kind: "new" }} onClose={() => {}} />);
      expect(screen.queryByTestId("askai-meta-toggle")).toBeNull();
    });
  });

  // F-N09 확장: 잠긴 노트를 대상으로 열리면 배너를 보여주고 전송(=삽입) 버튼을 비활성화한다.
  // 대화(요청문 작성) 자체는 막지 않는다 — 인풋은 계속 입력할 수 있다.
  describe("잠긴 노트 대상 — 배너 + 전송 버튼 비활성화", () => {
    beforeEach(() => {
      const current = useNotesStore.getState().activeNote!;
      useNotesStore.setState({
        activeNote: { ...current, note: { ...current.note, content_locked: true } },
      } as never);
    });

    it("배너를 보여주고 전송 버튼을 비활성화한다", () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      expect(screen.getByTestId("askai-locked-banner")).toBeTruthy();
      expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("Enter를 눌러도 전송되지 않는다(요청문 작성 자체는 막지 않는다)", async () => {
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("askai-tile-ask"));
      });
      await pressEnter();
      expect(genCall()).toBeUndefined();
    });

    it("대상 노트가 잠겨 있지 않으면 배너가 없고 전송 버튼이 활성이다", () => {
      const current = useNotesStore.getState().activeNote!;
      useNotesStore.setState({
        activeNote: { ...current, note: { ...current.note, content_locked: false } },
      } as never);
      render(<AskAiModal target={noteTarget} onClose={() => {}} />);
      expect(screen.queryByTestId("askai-locked-banner")).toBeNull();
    });
  });
});

describe("AskAiModal's shared action functions — self-gated (safe to call directly, e.g. PreviewAttachment's empty-state chips)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    registerActiveSectionGetter(() => null);
    useAiPresetsStore.setState({ list: PRESETS, loaded: true });
    useAiInstructionsStore.setState({ instructions: { ...ENGINE_OVERRIDES }, loaded: true });
    useAiStore.setState({ organizePending: false, lastProposal: null, lastProposalNoteId: null, translateGateOk: null });
    useNotesStore.setState({
      activeNote: { note: { id: "note-1", title: "Note 1" }, sections: [{ id: "s1", name: "Overview", body_md: "hello", position: 0, kind: "text" }] },
    } as never);
  });

  it("runMetadataProposal is a no-op (and notices) when the AI gate is blocked", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "openai", ai_endpoint: "https://api.openai.com" } });
      return Promise.resolve({});
    });
    const organizeCurrentNote = vi.fn(async () => {});
    useAiStore.setState({ organizeCurrentNote } as never);

    await runMetadataProposal("note-1");

    expect(organizeCurrentNote).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  it("runTagsProposal calls through when the gate is open", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
      return Promise.resolve({});
    });
    const organizeCurrentNote = vi.fn(async () => {});
    useAiStore.setState({ organizeCurrentNote } as never);

    await runTagsProposal("note-1");

    expect(organizeCurrentNote).toHaveBeenCalledWith("note-1", ["tags"], "METADATA GUIDANCE");
  });

  it("runNoteSummary opens the note first when it isn't already active, then summarizes ITS body", async () => {
    callMock.mockImplementation((cmd: string, args: { id: string }) => {
      if (cmd === "settings_get_all") return Promise.resolve(gateOkSettings());
      if (cmd === "note_get") {
        return Promise.resolve({
          note: { id: args.id, title: "Note 2" },
          sections: [{ id: "t1", name: "Overview", body_md: "note 2 body", position: 0, kind: "text" }],
          sources: [],
          attachments: [],
        });
      }
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "<p>summary</p>" });
      return Promise.resolve({});
    });
    const insertSectionMock = vi.fn(async () => null);
    registerSectionInserter(insertSectionMock);

    await runNoteSummary("note-2");

    await waitFor(() => expect(useNotesStore.getState().activeNote?.note.id).toBe("note-2"));
    expect(callMock).toHaveBeenCalledWith("ai_generate_from_prompt", expect.objectContaining({ context_text: "note 2 body" }));
  });
});


