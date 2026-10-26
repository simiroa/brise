import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextAssist } from "./TextAssist";
import { useNotesStore } from "../../stores/notes";
import { t } from "../../i18n/t";
import type { usePresetEntries } from "./usePresetEntries";

// 텍스트 작업 어시스트의 파생 그룹(오너 제안 #6, PLAN-2026-09-21-assist-modes.md §6) — 순수 함수
// (findMarkdownTables/listToDiagramText)는 lib/textDerive.test.ts 에서, 여기선 조건부 행 렌더링과
// 클릭 시 적용 관문 호출만 본다.

type Entries = ReturnType<typeof usePresetEntries>;
const entries = { textEntries: [], contextMenuFor: () => undefined } as unknown as Entries;

const insertAiSectionMock = vi.fn().mockResolvedValue(null);
let activeEditor: Editor | null = null;
let activeSectionBody = "";

vi.mock("../../lib/aiSectionBridge", () => ({
  getActiveEditor: () => (activeEditor && !activeEditor.isDestroyed ? activeEditor : null),
  getActiveSection: () => ({ id: "sec-1", body_md: activeSectionBody }),
  insertAiSection: (...args: unknown[]) => insertAiSectionMock(...args),
}));

const applySheetPresetMock = vi.fn().mockResolvedValue(undefined);
const applyDiagramPresetMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/presetBridge", () => ({
  applySheetPreset: (...args: unknown[]) => applySheetPresetMock(...args),
  applyDiagramPreset: (...args: unknown[]) => applyDiagramPresetMock(...args),
}));

// 캐럿 표 우선 판정(tableAiPlan.ts)은 여기선 항상 "캐럿 표 없음" — 본문 GFM 표 폴백 경로만 본다.
vi.mock("../editor/tableAiPlan", () => ({ extractTableAiSnapshot: vi.fn(() => null) }));

vi.mock("../../lib/invoke", () => ({
  emitNotice: vi.fn(),
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  registerFlush: () => () => {},
  flushAll: vi.fn(async () => {}),
}));

function makeEditor(content: string) {
  return new Editor({ extensions: [StarterKit], content });
}

function renderWork() {
  return render(<TextAssist blank={false} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
}

beforeEach(() => {
  insertAiSectionMock.mockClear();
  applySheetPresetMock.mockClear();
  applyDiagramPresetMock.mockClear();
  activeEditor = null;
  activeSectionBody = "";
  useNotesStore.setState({ activeNote: { note: { id: "n1" }, sections: [] }, activeDraft: false } as never);
});

afterEach(() => {
  activeEditor?.destroy();
  activeEditor = null;
});

describe("TextAssist · 작업 모드 · 파생 그룹", () => {
  it("본문에 GFM 표가 있으면 assist-derive-sheet 행이 있고, 클릭하면 새 시트 섹션으로 적용한다", () => {
    activeSectionBody = ["| 이름 | 나이 |", "| --- | --- |", "| 철수 | 10 |"].join("\n");
    renderWork();
    fireEvent.click(screen.getByTestId("assist-derive-sheet"));
    expect(applySheetPresetMock).toHaveBeenCalledTimes(1);
    const arg = applySheetPresetMock.mock.calls[0][0];
    expect(arg.landing).toBe("new-section");
    expect(arg.sectionName).toBe(t("presets.sheet_name"));
    expect(JSON.parse(arg.bodyMd).cells.A1.raw).toBe("이름");
  });

  it("본문에 표가 없으면 assist-derive-sheet 행이 없다", () => {
    activeSectionBody = "그냥 본문";
    renderWork();
    expect(screen.queryByTestId("assist-derive-sheet")).toBeNull();
  });

  it("들여쓰기 목록이 3항목 이상이면 assist-derive-diagram 행이 있고, 클릭하면 새 관계도 섹션으로 적용한다", () => {
    activeSectionBody = ["- 회사", "  - 개발팀", "  - 디자인팀"].join("\n");
    renderWork();
    fireEvent.click(screen.getByTestId("assist-derive-diagram"));
    expect(applyDiagramPresetMock).toHaveBeenCalledTimes(1);
    const arg = applyDiagramPresetMock.mock.calls[0][0];
    expect(arg.landing).toBe("new-section");
    const json = JSON.parse(arg.bodyMd);
    expect(json.nodes.map((n: { label: string }) => n.label)).toEqual(["회사", "개발팀", "디자인팀"]);
  });

  it("목록 항목이 3개 미만이면 assist-derive-diagram 행이 없다", () => {
    activeSectionBody = "- 하나\n- 둘";
    renderWork();
    expect(screen.queryByTestId("assist-derive-diagram")).toBeNull();
  });

  it("에디터 선택이 있으면 assist-derive-selection 행이 있고, 클릭하면 원본을 두고 새 텍스트 섹션을 postProcess 없이 만든다", () => {
    activeEditor = makeEditor("<p>hello world</p>");
    activeEditor.commands.selectAll();
    renderWork();
    fireEvent.click(screen.getByTestId("assist-derive-selection"));
    expect(insertAiSectionMock).toHaveBeenCalledTimes(1);
    const [, bodyMd, noteId, kind, opts] = insertAiSectionMock.mock.calls[0];
    expect(noteId).toBe("n1");
    expect(kind).toBe("text");
    expect(opts).toEqual({ postProcess: false });
    expect(bodyMd).toContain("hello world");
    // 원본 문서는 그대로 — 이 함수는 삭제/치환을 하지 않는다.
    expect(activeEditor.getText()).toContain("hello world");
  });

  it("에디터 선택이 비어 있으면 assist-derive-selection 행이 없다", () => {
    activeEditor = makeEditor("<p>hello world</p>");
    renderWork();
    expect(screen.queryByTestId("assist-derive-selection")).toBeNull();
  });

  it("세 조건이 모두 안 맞으면 파생 그룹 자체가 없다", () => {
    activeSectionBody = "그냥 본문";
    renderWork();
    expect(screen.queryByTestId("text-derive-group")).toBeNull();
  });

  it("blank(시작) 모드에서는 조건을 만족해도 파생 그룹이 없다", () => {
    activeSectionBody = ["| a |", "| - |", "| 1 |"].join("\n");
    render(<TextAssist blank={true} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    expect(screen.queryByTestId("text-derive-group")).toBeNull();
  });
});
