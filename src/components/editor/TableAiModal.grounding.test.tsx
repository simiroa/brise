/**
 * AI로 표 편집 — 병합 양식 열기 · 근거 노트 칩 · 칸 라벨 미리보기 (PLAN-2026-10-07-doc-import-export W2).
 *
 * tableAiPlan 은 목으로 대신하지 않는다: 병합 표가 모달에서 열리는지·라벨이 붙는지는 실제 스냅샷/미리보기 계약이
 * 맞물려야 성립한다. 노트 고르기(InternalNotePicker)만 자리표시로 바꾼다 — 그 컴포넌트의 검색은 자체 테스트가 있다.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { TableAiModal } from "./TableAiModal";
import { t } from "../../i18n/t";
import { useAiStore } from "../../stores/ai";
import { useNotesStore } from "../../stores/notes";
import { getActiveSection } from "../../lib/aiSectionBridge";
import { createMarkdownSchemaExtensions } from "../../lib/mdSerialize";

const invoke = vi.hoisted(() => ({
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
}));
vi.mock("../../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/invoke")>()),
  callSilent: invoke.callSilent,
  emitNotice: invoke.emitNotice,
  flushAll: invoke.flushAll,
}));
vi.mock("../../lib/aiSectionBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/aiSectionBridge")>()),
  getActiveSection: vi.fn(() => null),
}));
// 노트 고르기는 자리표시 — 버튼을 누르면 그 노트가 골라진다.
vi.mock("../attachments/InternalNotePicker", () => ({
  InternalNotePicker: ({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) => (
    <div data-testid="picker">
      <button type="button" onClick={() => onPick("n-profile")}>pick-profile</button>
      <button type="button" onClick={() => onPick("n-huge")}>pick-huge</button>
      <button type="button" onClick={() => onPick("n-empty")}>pick-empty</button>
      <button type="button" onClick={onCancel}>picker-cancel</button>
    </div>
  ),
}));

const NOTES: Record<string, { note: { id: string; title: string }; sections: { id: string; body_md: string }[] }> = {
  "n-profile": {
    note: { id: "n-profile", title: "내 이력" },
    sections: [{ id: "p1", body_md: "성명: 김하늘" }, { id: "p2", body_md: "생년월일: 1990-01-02" }],
  },
  "n-huge": { note: { id: "n-huge", title: "아주 긴 노트" }, sections: [{ id: "h1", body_md: "가".repeat(60_000) }] },
  "n-empty": { note: { id: "n-empty", title: "빈 노트" }, sections: [{ id: "e1", body_md: "  " }] },
  "n-self": {
    note: { id: "n-self", title: "이력서 양식" },
    sections: [{ id: "s-table", body_md: "TABLE-SECTION-BODY" }, { id: "s-other", body_md: "OTHER-SECTION-FACT: 서울 거주" }],
  },
};

const PLAIN_HTML = "<table><tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>";
// 라벨(th) | 빈칸 | 라벨(th) | 빈칸 / 라벨(th) | 빈칸 3칸 병합 — hwpx 이력서·기안서 모양.
const FORM_HTML =
  "<table><tbody><tr><th>성명</th><td></td><th>생년월일</th><td></td></tr>" +
  '<tr><th>주소</th><td colspan="3"></td></tr></tbody></table>';

function makeEditor(html: string) {
  return new TiptapEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: html,
  });
}

function placeCursorIn(editor: TiptapEditor, text: string) {
  let pos: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (pos === null && node.isText && node.text === text) pos = position;
  });
  if (pos === null) throw new Error(`text "${text}" not found in doc`);
  editor.commands.setTextSelection(pos + 1);
}

/** generateFromPrompt 를 가로채 프롬프트를 모으고, `plan()` 이 만든 변경안을 돌려준다. 표 지문은 일부러 안 실어 보낸다 —
 *  모달이 응답에 채워 넣는다(프롬프트에도 지문이 없다). */
function stubAi(plan: () => unknown[] = () => []) {
  const prompts: string[] = [];
  useAiStore.setState({
    refreshTranslateGate: vi.fn(async () => true),
    generateFromPrompt: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ version: 1, operations: plan() });
    }),
  } as never);
  return prompts;
}

const preview = () => fireEvent.click(screen.getByRole("button", { name: t("editor.table_ai_preview") }));
const addNote = (pick: string) => {
  fireEvent.click(screen.getByTestId("table-ai-add-note"));
  fireEvent.click(screen.getByText(pick));
};

beforeEach(() => {
  invoke.callSilent.mockReset();
  invoke.callSilent.mockImplementation(async (cmd: string, args?: { id?: string }) => {
    if (cmd === "note_get" && args?.id && NOTES[args.id]) return NOTES[args.id];
    throw new Error(`unexpected ${cmd}`);
  });
  invoke.emitNotice.mockReset();
  invoke.flushAll.mockClear();
  vi.mocked(getActiveSection).mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  useNotesStore.setState({ activeNote: null } as never);
});

describe("TableAiModal — merged form tables", () => {
  it("opens a merged table instead of showing the old 'unsupported' notice, and says what is switched off", () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    const onClose = vi.fn();
    render(<TableAiModal editor={editor} onClose={onClose} />);

    expect(screen.getByText(t("editor.table_ai_title"))).toBeTruthy();
    expect(invoke.emitNotice).not.toHaveBeenCalledWith(t("editor.table_ai_unsupported"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("table-ai-locked-note").textContent).toBe(t("editor.table_ai_scope_merged", { count: 1 }));
    editor.destroy();
  });

  it("sends the merged grid + merges, and no schema entry for row/column changes", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    const prompts = stubAi();
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    preview();
    await waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain('"merges"');
    expect(prompts[0]).toContain("왼쪽 위 좌표");
    expect(prompts[0]).not.toContain('"type": "row-insert"');
    expect(prompts[0]).not.toContain("docFingerprint");
    editor.destroy();
  });

  it("shows the label cell's name in the preview row: '성명 · … (빈칸) → 김하늘'", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    stubAi(() => [
      { type: "cell-set", row: 0, col: 1, value: "김하늘" },
      { type: "cell-set", row: 1, col: 1, value: "서울" }, // 병합 셀 — 왼쪽 위 좌표
    ]);
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    preview();
    await waitFor(() => expect(screen.getByText(t("editor.table_ai_selected_count", { selected: 2, total: 2 }))).toBeTruthy());
    expect(screen.getByText(/^성명 ·/)).toBeTruthy();
    expect(screen.getByText(/^주소 ·/)).toBeTruthy();
    expect(screen.getByText("김하늘")).toBeTruthy();
    // 빈 칸은 ∅ 가 아니라 말로 쓴다.
    expect(screen.getAllByText(t("editor.table_ai_empty_cell"))).toHaveLength(2);
    editor.destroy();
  });

  it("applies a fill on the merged cell end-to-end: colspan and the label cells survive, the value lands inside", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    stubAi(() => [{ type: "cell-set", row: 1, col: 1, value: "서울" }]);
    const onClose = vi.fn();
    render(<TableAiModal editor={editor} onClose={onClose} />);

    preview();
    const applyName = t("editor.table_ai_apply", { count: 1 });
    await waitFor(() => expect(screen.getByRole("button", { name: applyName })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: applyName }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    const cells = Array.from(editor.view.dom.querySelectorAll("th, td"));
    const merged = cells.find((c) => c.getAttribute("colspan") === "3");
    expect(merged?.tagName).toBe("TD");
    expect(merged?.textContent).toBe("서울");
    expect(cells.filter((c) => c.tagName === "TH").map((c) => c.textContent)).toEqual(["성명", "생년월일", "주소"]);
    editor.destroy();
  });

  it("rejects a plan that edits a cell covered by a merge (the model ignored the rule)", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    stubAi(() => [{ type: "cell-set", row: 1, col: 2, value: "가려진 칸" }]);
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    preview();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t("editor.table_ai_invalid")));
    editor.destroy();
  });
});

describe("TableAiModal — source note chips", () => {
  it("adds a picked note as a chip and removes it again", async () => {
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    expect(screen.queryByText("내 이력")).toBeNull();
    addNote("pick-profile");
    await waitFor(() => expect(screen.getByText("내 이력")).toBeTruthy());
    expect(invoke.callSilent).toHaveBeenCalledWith("note_get", { id: "n-profile" });
    // 크기도 칩에 보인다(두 섹션을 빈 줄로 이은 길이).
    const body = "성명: 김하늘\n\n생년월일: 1990-01-02";
    expect(screen.getByText(`· ${t("ai.ctx_chars", { count: body.length.toLocaleString() })}`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("ai.ctx_remove", { name: "내 이력" }) }));
    expect(screen.queryByText("내 이력")).toBeNull();
    editor.destroy();
  });

  it("puts the note in the prompt (inside untrusted data, with the no-invention rule) and drops it once removed", async () => {
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    const prompts = stubAi();
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    addNote("pick-profile");
    await waitFor(() => expect(screen.getByText("내 이력")).toBeTruthy());
    preview();
    await waitFor(() => expect(prompts).toHaveLength(1));
    const blocks = Array.from(prompts[0].matchAll(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/g), (m) => m[1]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain("[근거 노트: 내 이력]");
    expect(blocks[1]).toContain("성명: 김하늘");
    expect(prompts[0]).toContain("지어내거나 추측하지 마세요");

    fireEvent.click(screen.getByRole("button", { name: t("ai.ctx_remove", { name: "내 이력" }) }));
    await waitFor(() => expect(screen.queryByText("내 이력")).toBeNull());
    preview(); // 변경안이 비어 미리보기 줄이 없으니 버튼은 그대로 "변경안 미리보기"
    await waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).not.toContain("근거 노트");
    expect(prompts[1]).not.toContain("김하늘");
  });

  it("does not add the same note twice", async () => {
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    addNote("pick-profile");
    await waitFor(() => expect(screen.getAllByText("내 이력")).toHaveLength(1));
    addNote("pick-profile");
    await waitFor(() => expect(invoke.callSilent).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("내 이력")).toHaveLength(1);
    editor.destroy();
  });

  it("tells the user instead of adding a chip when the note is empty or cannot be read", async () => {
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    addNote("pick-empty");
    await waitFor(() => expect(invoke.emitNotice).toHaveBeenCalledWith(t("editor.table_ai_ground_note_empty")));
    expect(screen.queryByText("빈 노트")).toBeNull();

    invoke.callSilent.mockRejectedValueOnce(new Error("gone"));
    addNote("pick-profile");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t("editor.table_ai_ground_unreadable")));
    expect(screen.queryByText("내 이력")).toBeNull();
    editor.destroy();
  });

  it("shows a one-line notice when a long note is cut to fit, and the prompt stays within 30,000 chars", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    const prompts = stubAi();
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    expect(screen.queryByTestId("table-ai-ground-truncated")).toBeNull();
    addNote("pick-huge");
    await waitFor(() => expect(screen.getByTestId("table-ai-ground-truncated")).toBeTruthy());
    expect(screen.getByTestId("table-ai-ground-truncated").textContent).toBe(t("editor.table_ai_ground_truncated", { count: 1 }));

    preview();
    await waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0].length).toBeLessThanOrEqual(30_000);
    expect(prompts[0]).toContain("[근거 노트: 아주 긴 노트]");
    editor.destroy();
  });
});

describe("TableAiModal — 'other sections of this note' chip", () => {
  const openNote = () => {
    useNotesStore.setState({ activeNote: { note: { id: "n-self", title: "이력서 양식" }, sections: [] } } as never);
    vi.mocked(getActiveSection).mockReturnValue({ id: "s-table" } as never);
  };

  it("is absent when no note is open", () => {
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    render(<TableAiModal editor={editor} onClose={() => {}} />);
    expect(screen.queryByText(t("editor.table_ai_ground_self"))).toBeNull();
    editor.destroy();
  });

  it("is off by default — nothing is read and the note body is not sent", async () => {
    openNote();
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    const prompts = stubAi();
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    const chip = screen.getByTestId("askai-ctx-body-0");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    preview();
    await waitFor(() => expect(prompts).toHaveLength(1));
    expect(invoke.callSilent).not.toHaveBeenCalled();
    expect(prompts[0]).not.toContain("OTHER-SECTION-FACT");
    expect(prompts[0]).not.toContain("근거 노트");
    editor.destroy();
  });

  it("when turned on: flushes, reads the note, and sends every section except the one holding the table", async () => {
    openNote();
    const editor = makeEditor(PLAIN_HTML);
    placeCursorIn(editor, "A1");
    const prompts = stubAi();
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("askai-ctx-body-0"));
    await waitFor(() => expect(screen.getByTestId("askai-ctx-body-0").getAttribute("aria-pressed")).toBe("true"));
    expect(invoke.flushAll).toHaveBeenCalled();
    expect(invoke.callSilent).toHaveBeenCalledWith("note_get", { id: "n-self" });

    preview();
    await waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("OTHER-SECTION-FACT: 서울 거주");
    expect(prompts[0]).not.toContain("TABLE-SECTION-BODY");
    expect(prompts[0]).toContain("[근거 노트: 이력서 양식 (현재 노트의 다른 섹션)]");

    // 다시 누르면 꺼지고, 다음 요청에는 실리지 않는다 — 다시 읽지도 않는다.
    fireEvent.click(screen.getByTestId("askai-ctx-body-0"));
    expect(screen.getByTestId("askai-ctx-body-0").getAttribute("aria-pressed")).toBe("false");
    expect(invoke.callSilent).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("stays off and says so when the note has nothing besides the table's section", async () => {
    openNote();
    const original = NOTES["n-self"].sections;
    NOTES["n-self"].sections = [{ id: "s-table", body_md: "TABLE-SECTION-BODY" }];
    const editor = makeEditor(PLAIN_HTML);
    try {
      placeCursorIn(editor, "A1");
      render(<TableAiModal editor={editor} onClose={() => {}} />);

      fireEvent.click(screen.getByTestId("askai-ctx-body-0"));
      await waitFor(() => expect(invoke.emitNotice).toHaveBeenCalledWith(t("editor.table_ai_ground_self_empty")));
      expect(screen.getByTestId("askai-ctx-body-0").getAttribute("aria-pressed")).toBe("false");
    } finally {
      NOTES["n-self"].sections = original; // 실패해도 다음 테스트로 새지 않게
      editor.destroy();
    }
  });
});

// 표 지문은 모델이 베끼지 않는다 · 그림 칸은 변경안에서 빠진다 — 모달 끝에서 끝까지.
describe("TableAiModal — fingerprint injection and image cells", () => {
  /** 이미지는 마크다운 스키마(BriseImage)에만 있다 — 위의 StarterKit 에디터에는 <img> 가 들어가지 않는다. */
  function makeSchemaEditor(html: string) {
    return new TiptapEditor({ extensions: createMarkdownSchemaExtensions(), content: html });
  }
  const countImages = (editor: TiptapEditor) => {
    let count = 0;
    editor.state.doc.descendants((node) => { if (node.type.name === "image") count++; });
    return count;
  };
  const IMAGE_FORM_HTML =
    "<table><tbody><tr><th>성명</th><td></td><th>사진</th>" +
    '<td><p><img src="attachments/n1/pic.png" data-rel-path="attachments/n1/pic.png"></p></td></tr>' +
    '<tr><th>주소</th><td colspan="3"></td></tr></tbody></table>';

  /** 응답에 일부러 틀린 표 지문을 실어 보내는 스텁 — 모달이 지문을 직접 채워야 통과한다. */
  function stubAiWithBadFingerprint(operations: unknown[]) {
    const prompts: string[] = [];
    useAiStore.setState({
      refreshTranslateGate: vi.fn(async () => true),
      generateFromPrompt: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({ version: 1, baseTableFingerprint: "한 글자 틀린 지문", operations });
      }),
    } as never);
    return prompts;
  }

  it("does not put the table fingerprint in the prompt, and a wrong or missing one in the reply no longer breaks the preview", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    const prompts = stubAiWithBadFingerprint([{ type: "cell-set", row: 0, col: 1, value: "김하늘" }]);
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    preview();
    await waitFor(() => expect(screen.getByText(t("editor.table_ai_selected_count", { selected: 1, total: 1 }))).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(prompts[0]).not.toMatch(/fingerprint/i);
    editor.destroy();
  });

  it("applies after the injected fingerprint too (apply re-checks the document, so stale edits are still caught)", async () => {
    const editor = makeEditor(FORM_HTML);
    placeCursorIn(editor, "성명");
    stubAiWithBadFingerprint([{ type: "cell-set", row: 0, col: 1, value: "김하늘" }]);
    const onClose = vi.fn();
    render(<TableAiModal editor={editor} onClose={onClose} />);

    preview();
    const applyName = t("editor.table_ai_apply", { count: 1 });
    await waitFor(() => expect(screen.getByRole("button", { name: applyName })).toBeTruthy());
    // 미리보기 뒤 사용자가 문서를 고쳤다 — 지문이 모달 몫이어도 적용은 막힌다.
    editor.commands.insertContentAt(editor.state.doc.content.size, "<p>그 사이에 고침</p>");
    fireEvent.click(screen.getByRole("button", { name: applyName }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(t("editor.table_ai_stale"));
    editor.destroy();
  });

  it("drops a fill aimed at an image cell from the preview and keeps the image when the rest is applied", async () => {
    const editor = makeSchemaEditor(IMAGE_FORM_HTML);
    expect(countImages(editor)).toBe(1); // 스키마가 <img> 를 받아들였다는 것부터 — 아니면 아래가 헛돈다
    placeCursorIn(editor, "성명");
    const prompts = stubAiWithBadFingerprint([
      { type: "cell-set", row: 0, col: 3, value: "(사진 첨부)" }, // 모델이 빈 칸으로 착각한 그림 칸
      { type: "cell-set", row: 0, col: 1, value: "김하늘" },
    ]);
    const onClose = vi.fn();
    render(<TableAiModal editor={editor} onClose={onClose} />);

    preview();
    await waitFor(() => expect(screen.getByText(t("editor.table_ai_selected_count", { selected: 1, total: 1 }))).toBeTruthy());
    expect(prompts[0]).toContain("opaque");
    expect(screen.queryByText("(사진 첨부)")).toBeNull();
    expect(screen.getByText("김하늘")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("editor.table_ai_apply", { count: 1 }) }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(countImages(editor)).toBe(1);
    expect(editor.view.dom.textContent).toContain("김하늘");
    expect(editor.view.dom.textContent).not.toContain("(사진 첨부)");
    editor.destroy();
  });

  it("says 'no changes' when the only proposal was for an image cell", async () => {
    const editor = makeSchemaEditor(IMAGE_FORM_HTML);
    placeCursorIn(editor, "성명");
    stubAiWithBadFingerprint([{ type: "cell-clear", row: 0, col: 3 }]);
    render(<TableAiModal editor={editor} onClose={() => {}} />);

    preview();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t("editor.table_ai_no_changes")));
    expect(countImages(editor)).toBe(1);
    editor.destroy();
  });
});
