import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const callOrder: string[] = [];
const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {
  callOrder.push("flushAll");
});
const emitNoticeMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => {
    callOrder.push(`call:${String(args[0])}`);
    return callMock(...args);
  },
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: () => () => {},
}));

const yieldFrameMock = vi.fn(async () => {});
vi.mock("../../lib/yieldFrame", () => ({ yieldFrame: () => yieldFrameMock() }));
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", async (orig) => ({
  ...(await orig<typeof import("../../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));

const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

// 첨부 기반 폴더 — 미리보기 그림이 풀리는 경로. 실제 훅은 Tauri 를 부른다.
vi.mock("../../lib/attachmentsBase", () => ({
  useAttachmentsBase: () => ({ baseDir: "C:/att", convert: (p: string) => `asset://${p}` }),
}));

const showToastOnlyMock = vi.fn();
vi.mock("../../lib/undo", () => ({
  showToastOnly: (...args: unknown[]) => showToastOnlyMock(...args),
  showUndoToast: vi.fn(),
  scheduleUndoableDelete: vi.fn(),
}));

import { ExportModal, ExportModalHost } from "./ExportModal";
import { useExportModalStore, type ExportRequest } from "../../stores/exportModal";
import { t } from "../../i18n/t";
import type { NoteDetail } from "../../lib/commands.gen";

/** 시트 섹션 본문(body_md JSON, specs/features/sheet.md) — 1행이 머리글, 금액 열은 숫자 서식. */
const SHEET_BODY = JSON.stringify({
  v: 1,
  rows: 100,
  cols: [{}, { fmt: "number" }],
  cells: { A1: { raw: "항목" }, B1: { raw: "금액" }, A2: { raw: "식비" }, B2: { raw: "1000" } },
  charts: [],
});

const NOTE: NoteDetail = {
  note: { id: "n1", title: "이력서 노트" } as NoteDetail["note"],
  sections: [
    { id: "s1", name: "이력서", body_md: "# 이 력 서\n\n- [ ] 포트폴리오\n- [x] 경력증명서\n\n![사진](n1/photo.png){width=40%}", position: 0, kind: "text" },
    {
      id: "s2",
      name: "자기소개",
      body_md: '안녕하세요. <span data-footnote="fn1">통계</span>를 봤어요. [사이트](https://example.com) · [노트](note://abc)',
      position: 1,
      kind: "text",
    },
    { id: "s3", name: "예산", body_md: SHEET_BODY, position: 2, kind: "sheet" },
    { id: "s4", name: "관계도", body_md: "{}", position: 3, kind: "diagram" },
  ] as NoteDetail["sections"],
  sources: [],
  attachments: [],
};

function mockInvoke(detail: NoteDetail = NOTE, overrides: Record<string, unknown> = {}) {
  callMock.mockImplementation(async (cmd: string) => {
    if (cmd === "note_get") return detail;
    if (cmd in overrides) {
      const v = overrides[cmd];
      if (v instanceof Error) throw v;
      return v;
    }
    if (cmd === "attachment_read_text") return { text: "2026 통계 연보", truncated: false };
    if (cmd === "export_hwpx") return { written_path: "C:/out/이력서.hwpx", image_count: 1, skipped_images: 0 };
    if (cmd === "export_docx") return { written_path: "C:/out/이력서.docx", image_count: 1, skipped_images: 0 };
    if (cmd === "export_html") return { written_path: "C:/out/이력서.html", image_count: 1, skipped_images: 0 };
    if (cmd === "export_html_inline") return { html: "<p>채운 조각</p>", image_count: 1, skipped_images: 0 };
    if (cmd === "export_section_md") return { written_path: "C:/out/이력서.md" };
    if (cmd === "export_note") return { written_path: "C:/out/노트.md", exported_at: "x" };
    if (cmd === "export_open") return {};
    return {};
  });
}

const sectionRequest: ExportRequest = { noteId: "n1", noteTitle: "이력서 노트", sectionId: "s1" };
const noteRequest: ExportRequest = { noteId: "n1", noteTitle: "이력서 노트", sectionId: null };

async function renderLoaded(request: ExportRequest = sectionRequest, onClose = vi.fn()) {
  render(<ExportModal request={request} onClose={onClose} />);
  await waitFor(() => expect(screen.getByTestId("export-preview")).toBeTruthy());
  return onClose;
}

/** jsdom 은 srcdoc 을 그리지 않는다 — 미리보기 프레임 문서에 lazy 그림 몇 장을 직접 심는다. */
function plantLazyImages(frame: HTMLIFrameElement, n = 3) {
  const doc = frame.contentDocument!;
  for (let i = 0; i < n; i++) {
    const img = doc.createElement("img");
    img.setAttribute("loading", "lazy");
    img.setAttribute("src", `asset://C:/att/n1/p${i}.png`);
    doc.body.appendChild(img);
  }
}

/** jsdom 은 그림을 받지 않아 img 가 끝나지 않는다 — 미리보기 안의 그림에 load 를 보낸다. */
function settleImages(frame: HTMLIFrameElement) {
  const imgs = Array.from(frame.contentDocument!.images);
  imgs.forEach((img) => img.dispatchEvent(new Event("load")));
  return imgs;
}

const srcDocOf = () => screen.getByTestId("export-preview").getAttribute("srcdoc") ?? "";
const argsOf = <T,>(cmd: string) => callMock.mock.calls.find((c) => c[0] === cmd)![1] as T;
/** 형식은 드롭다운(Select) — 열어서 그 값의 행을 누른다. */
function pickFormat(id: string) {
  fireEvent.click(screen.getByTestId("export-format"));
  fireEvent.click(screen.getByTestId("export-format-list").querySelector(`[data-value="${id}"]`)!);
}
function pickPaperSize(id: string) {
  fireEvent.click(screen.getByTestId("export-paper-size"));
  fireEvent.click(screen.getByTestId("export-paper-size-list").querySelector(`[data-value="${id}"]`)!);
}
/** 드롭다운을 열어 행 순서를 읽고 다시 닫는다. */
const formatIds = () => {
  fireEvent.click(screen.getByTestId("export-format"));
  const ids = [...screen.getByTestId("export-format-list").querySelectorAll('[role="option"]')].map((o) =>
    o.getAttribute("data-value"),
  );
  fireEvent.click(screen.getByTestId("export-format"));
  return ids;
};

/** jsdom 에는 클립보드가 없다 — 쓰기를 붙잡는 가짜를 단다. */
class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
}
function stubClipboard(write: (items: FakeClipboardItem[]) => Promise<void>) {
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
}

describe("ExportModal", () => {
  beforeEach(() => {
    callOrder.length = 0;
    callMock.mockReset();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    saveMock.mockReset();
    showToastOnlyMock.mockReset();
    useExportModalStore.setState({ request: null });
    mockInvoke();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
    sessionStorage.removeItem("brise_sync_token");
  });

  it("a section request opens scoped to that section: paper shows only its text, HWPX is the default format", async () => {
    await renderLoaded(sectionRequest);

    expect(screen.getByTestId("export-scope-section").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("export-scope-note").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("export-format").textContent).toBe(t("export.format_hwpx"));
    expect(screen.getByTestId("export-hint").textContent).toBe(t("export.hint_hwpx"));

    const doc = srcDocOf();
    expect(doc).toContain("이 력 서");
    expect(doc).not.toContain("안녕하세요."); // 다른 섹션은 아직 아님
    expect(doc).not.toContain('class="sec-title"'); // 섹션이 하나면 제목 문단을 붙이지 않는다
    // 그림은 에디터와 같은 규칙으로 asset URL 이 된다
    expect(doc).toContain("asset://C:/att/n1/photo.png");
    // 종이는 앱 테마와 무관한 따로 된 문서다 — 자기 CSS 를 들고 간다(`?raw` 로 읽은 exportPaper.css 가 비면 스타일 없이 그려진다)
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain('li[data-type="taskItem"]');
    expect(doc).toContain(String.raw`"\2610"`);
    expect(screen.getByTestId("export-file-name").textContent).toBe("이력서.hwpx");
  });

  it("a note request opens as whole-note scope: text and sheet sections on the paper with titles, diagrams left out", async () => {
    await renderLoaded(noteRequest);

    // 섹션을 고를 수 없으니 범위는 고정 문구 한 줄 — 시트도 센다(텍스트 2 + 시트 1)
    expect(screen.queryByTestId("export-scope-section")).toBeNull();
    expect(screen.getByTestId("export-scope-note-only").textContent).toBe(t("export.scope_note", { n: 3 }));

    const doc = srcDocOf();
    expect(doc).toContain("이 력 서");
    expect(doc).toContain("안녕하세요.");
    expect(doc).toContain('<h2 class="sec-title">이력서</h2>');
    expect(doc).toContain('<h2 class="sec-title">자기소개</h2>');
    // 시트는 계산된 값 표로 — 1행이 머리글
    expect(doc).toContain('<h2 class="sec-title">예산</h2>');
    expect(doc).toMatch(/<th[^>]*><p>항목<\/p><\/th>/);
    expect(doc).toContain("식비");
    expect(doc).not.toContain("관계도");
    // 시트 1개는 값 표로, 관계도 1개는 제외로 달라지는 점에 나온다
    expect(screen.getByTestId("export-diff-sheets").textContent).toContain(t("export.diff_sheets", { n: 1 }));
    expect(screen.getByTestId("export-diff-excluded").textContent).toContain(t("export.diff_excluded", { n: 1 }));
    expect(screen.getByTestId("export-file-name").textContent).toBe("이력서 노트.hwpx");
  });

  // 결함 재현(W6 검증 V3): Markdown 미리보기가 시트를 계산 값 표로 그렸지만 .md 에는 Rust 가 칸에 적힌 그대로(수식 포함) 쓴다 —
  // 미리보기에 없는 값을 보여 주지 않고, 달라지는 점이 "적힌 그대로" 를 알린다. 각주 목록은 마지막 텍스트 섹션 끝에 그대로 남는다.
  it("Markdown leaves sheets off the preview and says they are written as typed", async () => {
    await renderLoaded(noteRequest);
    pickFormat("md");
    const doc = srcDocOf();
    expect(doc).toContain("이 력 서");
    expect(doc).not.toContain('<h2 class="sec-title">예산</h2>');
    expect(doc).not.toContain("식비");
    expect(doc).toContain(`<h3>${t("export.footnote_heading")}</h3>`);
    expect(screen.getByTestId("export-diff-sheets").textContent).toContain(t("export.diff_sheets_md", { n: 1 }));
  });

  it("footnotes become [n] in the text plus a footnote list at the end, on the paper and in the diff list", async () => {
    await renderLoaded(noteRequest);
    const doc = srcDocOf();
    expect(doc).toContain("통계</span>[1]");
    expect(doc).toContain(`<h3>${t("export.footnote_heading")}</h3>`);
    expect(doc).toContain("[1] 2026 통계 연보");
    expect(screen.getByTestId("export-diff-footnotes").textContent).toContain(t("export.diff_footnotes", { n: 1 }));
    // 각주 본문은 조용한 조회로 읽는다
    expect(callMock).toHaveBeenCalledWith("attachment_read_text", { id: "fn1" });
  });

  it("lists what changes for HWPX from the document (checkboxes, font) and says 'as is' only when nothing differs", async () => {
    await renderLoaded(sectionRequest);
    expect(screen.getByTestId("export-diff-tasks").textContent).toContain(t("export.diff_tasks", { n: 2 }));
    expect(screen.getByTestId("export-diff-font")).toBeTruthy();
    expect(screen.queryByTestId("export-diff-none")).toBeNull();

    // Markdown: 이 섹션엔 색·정렬·병합 표가 없다 → "그대로 나갑니다"
    pickFormat("md");
    expect(screen.getByTestId("export-diff-none").textContent).toContain(t("export.diff_none"));
    expect(screen.getByTestId("export-hint").textContent).toBe(t("export.hint_text"));
  });

  it("format dropdown lists HWPX · DOCX · HTML · copy · Markdown in both scopes (no PDF/print format), and switching scope keeps the format", async () => {
    await renderLoaded(sectionRequest);
    const order = ["hwpx", "docx", "html", "copy", "md"];
    expect(formatIds()).toEqual(order);
    pickFormat("copy");
    expect(screen.getByTestId("export-format").textContent).toBe(t("export.format_copy"));

    // HTML 은 이제 섹션 범위에서도 된다 — 범위를 오가도 형식이 그대로다
    pickFormat("html");
    fireEvent.click(screen.getByTestId("export-scope-note"));
    expect(formatIds()).toEqual(order);
    expect(screen.getByTestId("export-format").textContent).toBe(t("export.format_html"));
    fireEvent.click(screen.getByTestId("export-scope-section"));
    expect(screen.getByTestId("export-format").textContent).toBe(t("export.format_html"));
  });

  it("page setup (size · orientation · margins) is a HWPX/DOCX option only and redraws the preview and the print page", async () => {
    await renderLoaded(sectionRequest);
    expect(srcDocOf()).toContain("width:210mm");
    expect(srcDocOf()).toContain("size: 210mm 297mm;");
    fireEvent.click(screen.getByTestId("export-orient-landscape"));
    expect(srcDocOf()).toContain("width:297mm");
    pickPaperSize("letter");
    expect(srcDocOf()).toContain("width:279.4mm");
    expect(srcDocOf()).toContain("size: 279.4mm 215.9mm;");
    expect(screen.getByTestId("export-margin-normal").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("export-margin-narrow"));
    expect(srcDocOf()).toContain("margin: 12.7mm 12.7mm 12.7mm;");

    // 고른 쪽 설정은 HWPX -> DOCX 로 형식을 바꿔도 그대로, 선택도 DOCX 에 있다
    pickFormat("docx");
    expect(screen.getByTestId("export-orient-landscape").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("export-margin-narrow").getAttribute("aria-pressed")).toBe("true");
    expect(srcDocOf()).toContain("width:279.4mm");

    // 쪽 설정이 없는 형식은 숨은 선택값과 무관하게 A4 세로 창이다
    for (const f of ["md", "html", "copy"]) {
      pickFormat(f);
      expect(screen.queryByTestId("export-orient-portrait"), f).toBeNull();
      expect(screen.queryByTestId("export-margin-normal"), f).toBeNull();
    }
    pickFormat("md");
    expect(srcDocOf()).toContain("width:210mm");
  });

  it("choosing DOCX swaps the hint above the paper, the font line and the note, and the file name gets .docx", async () => {
    await renderLoaded(sectionRequest);
    expect(screen.getByTestId("export-hint").textContent).toBe(t("export.hint_hwpx"));
    expect(screen.getByTestId("export-diff-font").textContent).toContain(t("export.diff_font"));
    expect(screen.getByText(t("export.note_hwpx"))).toBeTruthy();

    pickFormat("docx");
    expect(screen.getByTestId("export-format").textContent).toBe(t("export.format_docx"));
    expect(screen.getByTestId("export-hint").textContent).toBe(t("export.hint_docx"));
    // 겹치는 규칙(체크박스)은 그대로, 글꼴 줄만 맑은 고딕
    expect(screen.getByTestId("export-diff-tasks").textContent).toContain(t("export.diff_tasks", { n: 2 }));
    expect(screen.getByTestId("export-diff-font").textContent).toContain(t("export.diff_font_docx"));
    expect(screen.queryByText(t("export.note_hwpx"))).toBeNull();
    expect(screen.getByText(t("export.note_docx"))).toBeTruthy();
    expect(screen.getByTestId("export-file-name").textContent).toBe("이력서.docx");
    // 종이도 Word 쪽 글꼴로 그린다 - HWPX 는 함초롬바탕 그대로
    expect(srcDocOf()).toContain("Malgun Gothic");
    pickFormat("hwpx");
    expect(srcDocOf()).not.toContain("Malgun Gothic");
  });

  it("HWPX save: flushAll runs before note_get, then the save dialog (.hwpx), then export_hwpx with text and sheet sections", async () => {
    saveMock.mockResolvedValue("C:/out/이력서.hwpx");
    const onClose = await renderLoaded(noteRequest);

    fireEvent.click(screen.getByTestId("export-orient-landscape"));
    pickPaperSize("b5");
    fireEvent.click(screen.getByTestId("export-margin-wide"));
    fireEvent.click(screen.getByTestId("export-save"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_hwpx", expect.anything()));
    expect(callOrder.indexOf("flushAll")).toBeLessThan(callOrder.indexOf("call:note_get"));
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "이력서 노트.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] }),
    );
    const args = argsOf<{
      note_id: string; dest_path: string; title: string; paper: string; margin: string;
      sections: { name: string; doc: { type: string; content: { type: string }[] } }[];
    }>("export_hwpx");
    expect(args.note_id).toBe("n1");
    expect(args.dest_path).toBe("C:/out/이력서.hwpx");
    expect(args.title).toBe("이력서 노트");
    expect(args.paper).toBe("b5-landscape");
    expect(args.margin).toBe("wide");
    // 관계도(s4)는 빠지고 텍스트 둘 + 시트(값 표) 하나, 문서는 ProseMirror JSON
    expect(args.sections.map((s) => s.name)).toEqual(["이력서", "자기소개", "예산"]);
    expect(args.sections[0].doc.type).toBe("doc");
    expect(args.sections[2].doc.content[0].type).toBe("table");
    // 각주를 편 문서가 간다 — 본문 [1]
    expect(JSON.stringify(args.sections[1].doc)).toContain('"text":"[1]를 봤어요. "');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("DOCX save: the save dialog (.docx filter) then export_docx with the same arguments as HWPX, never export_hwpx", async () => {
    saveMock.mockResolvedValue("C:/out/이력서.docx");
    const onClose = await renderLoaded(noteRequest);

    pickFormat("docx");
    fireEvent.click(screen.getByTestId("export-orient-landscape"));
    fireEvent.click(screen.getByTestId("export-save"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_docx", expect.anything()));
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "이력서 노트.docx", filters: [{ name: "DOCX", extensions: ["docx"] }] }),
    );
    expect(callMock.mock.calls.some((c) => c[0] === "export_hwpx")).toBe(false);
    const args = argsOf<{
      note_id: string; dest_path: string; title: string; paper: string;
      sections: { name: string; doc: { type: string } }[];
    }>("export_docx");
    expect(args).toEqual({
      note_id: "n1",
      dest_path: "C:/out/이력서.docx",
      title: "이력서 노트",
      paper: "a4-landscape",
      margin: "normal",
      sections: expect.any(Array),
    });
    expect(args.sections.map((s) => s.name)).toEqual(["이력서", "자기소개", "예산"]);
    expect(args.sections[0].doc.type).toBe("doc");

    // 같은 성공 토스트(파일 이름 + 열기/폴더)
    await waitFor(() => expect(showToastOnlyMock).toHaveBeenCalled());
    const [label, onOpen, opts] = showToastOnlyMock.mock.calls[0] as [
      string, () => void, { actionLabel: string; extraAction: { label: string; onAction: () => void } },
    ];
    expect(label).toBe(t("export.saved", { name: "이력서.docx" }));
    expect(opts.actionLabel).toBe(t("export.open_file"));
    onOpen();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_open", { path: "C:/out/이력서.docx", reveal: false }));
    opts.extraAction.onAction();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_open", { path: "C:/out/이력서.docx", reveal: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("DOCX: cancelling the dialog is silent; a failed export keeps the modal open; skipped images are reported", async () => {
    // 취소
    saveMock.mockResolvedValue(null);
    const onClose = await renderLoaded(sectionRequest);
    pickFormat("docx");
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    await act(async () => {});
    expect(callMock.mock.calls.some((c) => c[0] === "export_docx")).toBe(false);
    expect(showToastOnlyMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 실패 - call() 이 토스트를 이미 띄웠으니 여기서 더하지 않는다
    saveMock.mockResolvedValue("C:/out/x.docx");
    mockInvoke(NOTE, { export_docx: new Error("disk full") });
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_docx", expect.anything()));
    await act(async () => {});
    expect(showToastOnlyMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 그림을 못 넣은 개수 안내
    mockInvoke(NOTE, { export_docx: { written_path: "C:/out/이력서.docx", image_count: 0, skipped_images: 3 } });
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(showToastOnlyMock).toHaveBeenCalled());
    expect(showToastOnlyMock.mock.calls[0][0]).toBe(t("export.saved_skipped", { name: "이력서.docx", n: 3 }));
  });

  it("section scope sends just that section to export_hwpx, titled with the section name", async () => {
    saveMock.mockResolvedValue("C:/out/이력서.hwpx");
    await renderLoaded(sectionRequest);
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_hwpx", expect.anything()));
    const args = argsOf<{ title: string; paper: string; margin: string; sections: { name: string }[] }>("export_hwpx");
    expect(args.sections.map((s) => s.name)).toEqual(["이력서"]);
    expect(args.title).toBe("이력서");
    expect(args.paper).toBe("a4-portrait");
    expect(args.margin).toBe("normal");
  });

  it("cancelling the save dialog is silent: no export call, no toast, the modal stays open", async () => {
    saveMock.mockResolvedValue(null);
    const onClose = await renderLoaded(sectionRequest);
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    await act(async () => {});

    expect(callMock.mock.calls.some((c) => c[0] === "export_hwpx")).toBe(false);
    expect(showToastOnlyMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId("export-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failed export keeps the modal open and adds no second toast of its own (call() already toasted)", async () => {
    saveMock.mockResolvedValue("C:/out/x.hwpx");
    mockInvoke(NOTE, { export_hwpx: new Error("disk full") });
    const onClose = await renderLoaded(sectionRequest);
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_hwpx", expect.anything()));
    await act(async () => {});

    expect(showToastOnlyMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("success toast names the file, and its two buttons call export_open (open / reveal)", async () => {
    saveMock.mockResolvedValue("C:/out/이력서.hwpx");
    await renderLoaded(sectionRequest);
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(showToastOnlyMock).toHaveBeenCalled());

    const [label, onOpen, opts] = showToastOnlyMock.mock.calls[0] as [
      string, () => void, { ttlMs: number; actionLabel: string; extraAction: { label: string; onAction: () => void } },
    ];
    expect(label).toBe(t("export.saved", { name: "이력서.hwpx" }));
    expect(opts.actionLabel).toBe(t("export.open_file"));
    expect(opts.extraAction.label).toBe(t("export.open_folder"));
    expect(opts.ttlMs).toBeGreaterThanOrEqual(8000);

    onOpen();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_open", { path: "C:/out/이력서.hwpx", reveal: false }));
    opts.extraAction.onAction();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_open", { path: "C:/out/이력서.hwpx", reveal: true }));
  });

  it("says how many images could not be included when the writer skipped some", async () => {
    saveMock.mockResolvedValue("C:/out/이력서.hwpx");
    mockInvoke(NOTE, { export_hwpx: { written_path: "C:/out/이력서.hwpx", image_count: 0, skipped_images: 2 } });
    await renderLoaded(sectionRequest);
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(showToastOnlyMock).toHaveBeenCalled());
    expect(showToastOnlyMock.mock.calls[0][0]).toBe(t("export.saved_skipped", { name: "이력서.hwpx", n: 2 }));
  });

  it("Markdown uses the existing commands: export_section_md for a section, export_note {id, dest_path} (no format) for the whole note", async () => {
    saveMock.mockResolvedValue("C:/out/x.md");
    const closeA = await renderLoaded(sectionRequest);
    pickFormat("md");
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("export_section_md", { id: "s1", dest_path: "C:/out/x.md" }),
    );
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "이력서.md" }));
    await waitFor(() => expect(closeA).toHaveBeenCalled());
    expect(callMock.mock.calls.some((c) => c[0] === "export_hwpx")).toBe(false);

    cleanup();
    callMock.mockClear();
    saveMock.mockClear();
    mockInvoke();
    await renderLoaded(noteRequest);
    pickFormat("md");
    fireEvent.click(screen.getByTestId("export-save"));
    await waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "export_note")).toBe(true));
    expect(argsOf("export_note")).toEqual({ id: "n1", dest_path: "C:/out/x.md" });
  });

  it("HTML previews as a browser page (reading width, no paper choice) with the HTML hint, note and a .html file name", async () => {
    await renderLoaded(sectionRequest);
    pickFormat("html");

    expect(screen.getByTestId("export-hint").textContent).toBe(t("export.hint_html"));
    expect(screen.getByText(t("export.note_html"))).toBeTruthy();
    expect(screen.getByTestId("export-file-name").textContent).toBe("이력서.html");
    expect(screen.queryByTestId("export-orient-portrait")).toBeNull();
    const doc = srcDocOf();
    expect(doc).toContain("max-width: 46em");
    expect(doc).not.toContain("width:210mm");
    // 미리보기는 그림을 asset 주소로 그린다(파일로 나갈 때만 Rust 가 채운다)
    expect(doc).toContain("asset://C:/att/n1/photo.png");
    expect(screen.getByTestId("export-save")).toBeTruthy();
  });

  it("HTML save: .html dialog, then export_html with a whole document whose images are data-rel-path (no asset URLs) and links kept", async () => {
    saveMock.mockResolvedValue("C:/out/이력서 노트.html");
    const onClose = await renderLoaded(noteRequest);
    // 미리보기 안에서는 링크를 벗긴다 — 프레임이 어디로도 못 가게
    pickFormat("html");
    expect(srcDocOf()).not.toContain('href="https://example.com/"');
    fireEvent.click(screen.getByTestId("export-save"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_html", expect.anything()));
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "이력서 노트.html", filters: [{ name: "HTML", extensions: ["html"] }] }),
    );
    const args = argsOf<{ note_id: string; dest_path: string; html: string }>("export_html");
    expect(Object.keys(args).sort()).toEqual(["dest_path", "html", "note_id"]);
    expect(args.note_id).toBe("n1");
    expect(args.dest_path).toBe("C:/out/이력서 노트.html");
    expect(args.html.startsWith("<!doctype html>")).toBe(true);
    expect(args.html).toContain("<title>이력서 노트</title>");
    expect(args.html).toContain('data-rel-path="n1/photo.png"');
    expect(args.html).not.toContain("asset://");
    expect(args.html).toContain('href="https://example.com/"');
    expect(args.html).not.toContain("note://");
    expect(args.html).toContain("size: 210mm 297mm"); // 인쇄 CSS 는 W5 그대로
    expect(args.html).toContain("[1] 2026 통계 연보"); // 각주 목록도 들어간다
    // 예전 덤프 경로(export_note html)는 부르지 않는다
    expect(callMock.mock.calls.some((c) => c[0] === "export_note")).toBe(false);

    await waitFor(() => expect(showToastOnlyMock).toHaveBeenCalled());
    expect(showToastOnlyMock.mock.calls[0][0]).toBe(t("export.saved", { name: "이력서.html" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("copy: export_html_inline fills the inline-styled fragment, then the clipboard gets text/html + text/plain and the modal closes", async () => {
    const written: FakeClipboardItem[][] = [];
    stubClipboard(async (items) => {
      written.push(items);
    });
    const onClose = await renderLoaded(sectionRequest);
    pickFormat("copy");
    expect(screen.getByTestId("export-hint").textContent).toBe(t("export.hint_copy"));
    expect(screen.getByText(t("export.note_copy"))).toBeTruthy();
    expect(screen.getByTestId("export-file-name").textContent).toBe("");
    expect(screen.queryByTestId("export-save")).toBeNull();
    // 미리보기는 붙여넣은 모습 — 체크박스 대신 ☐/☑ 글자, 읽기 폭 문서(종이 아님)
    expect(srcDocOf()).toContain("☐ 포트폴리오");
    expect(srcDocOf()).not.toContain("<input");
    expect(srcDocOf()).toContain("max-width: 46em");
    fireEvent.click(screen.getByTestId("export-copy"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const args = argsOf<{ note_id: string; html: string }>("export_html_inline");
    expect(Object.keys(args).sort()).toEqual(["html", "note_id"]);
    expect(args.note_id).toBe("n1");
    expect(args.html).toContain('data-rel-path="n1/photo.png"');
    expect(args.html).not.toContain("asset://");
    expect(args.html).not.toContain("<input");
    expect(args.html).toContain("☐ 포트폴리오");
    expect(args.html).toContain('style="');

    expect(written).toHaveLength(1);
    const item = written[0][0];
    expect(Object.keys(item.items).sort()).toEqual(["text/html", "text/plain"]);
    // 클립보드에는 Rust 가 그림을 채운 결과가 들어간다
    expect(await item.items["text/html"].text()).toBe("<p>채운 조각</p>");
    const plain = await item.items["text/plain"].text();
    expect(plain).toContain("☐ 포트폴리오");
    expect(plain).toContain("☑ 경력증명서");
    expect(plain).not.toContain("<");
    expect(emitNoticeMock).toHaveBeenCalledWith(t("export.copied"));
  });

  it("copy says how many images were left out when Rust skipped some", async () => {
    stubClipboard(async () => {});
    mockInvoke(NOTE, { export_html_inline: { html: "<p>x</p>", image_count: 0, skipped_images: 2 } });
    const onClose = await renderLoaded(sectionRequest);
    pickFormat("copy");
    fireEvent.click(screen.getByTestId("export-copy"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(emitNoticeMock).toHaveBeenCalledWith(t("export.copied_skipped", { n: 2 }));
  });

  it("copy: no clipboard API or a refused write shows a line in the modal and keeps it open", async () => {
    // 클립보드 API 가 없다(jsdom 그대로)
    const onClose = await renderLoaded(sectionRequest);
    pickFormat("copy");
    fireEvent.click(screen.getByTestId("export-copy"));
    await waitFor(() => expect(screen.getByTestId("export-copy-failed").textContent).toBe(t("export.copy_failed")));
    expect(onClose).not.toHaveBeenCalled();
    expect(emitNoticeMock).not.toHaveBeenCalled();

    // 쓰기를 거절했다
    stubClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    fireEvent.click(screen.getByTestId("export-copy"));
    await waitFor(() => expect(callMock.mock.calls.filter((c) => c[0] === "export_html_inline")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("export-copy-failed")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("copy: a failed export_html_inline is call()'s toast only — no copy-failed line, no clipboard write, modal stays", async () => {
    const write = vi.fn(async () => {});
    stubClipboard(write);
    mockInvoke(NOTE, { export_html_inline: new Error("too big") });
    const onClose = await renderLoaded(sectionRequest);
    pickFormat("copy");
    fireEvent.click(screen.getByTestId("export-copy"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("export_html_inline", expect.anything()));
    await act(async () => {});
    expect(write).not.toHaveBeenCalled();
    expect(screen.queryByTestId("export-copy-failed")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId("export-copy") as HTMLButtonElement).disabled).toBe(false);
  });

  it("browser mode: HTML save and copy are desktop-only (Rust commands), print still works", async () => {
    sessionStorage.setItem("brise_sync_token", "tok");
    await renderLoaded(sectionRequest);

    pickFormat("html");
    const save = screen.getByTestId("export-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe(t("common.desktop_only"));

    pickFormat("copy");
    const copy = screen.getByTestId("export-copy") as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(copy.title).toBe(t("common.desktop_only"));

    // 인쇄는 Tauri 가 필요 없어 브라우저 모드에서도 된다(어느 형식이든)
    fireEvent.load(screen.getByTestId("export-preview"));
    expect((screen.getByTestId("export-print") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a note with nothing exportable (only a diagram) has nothing to save: empty message, save disabled", async () => {
    mockInvoke({ ...NOTE, sections: [NOTE.sections[3]] });
    render(<ExportModal request={noteRequest} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("export-stage-status").textContent).toBe(t("export.empty")));
    expect((screen.getByTestId("export-save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("export-preview")).toBeNull();
  });

  it("a read failure shows the failure message in the paper area and keeps save disabled", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_get") throw new Error("boom");
      return {};
    });
    render(<ExportModal request={noteRequest} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("export-stage-status").textContent).toBe(t("export.load_failed")));
    expect((screen.getByTestId("export-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the preview iframe is sandboxed without scripts", async () => {
    await renderLoaded(sectionRequest);
    const sandbox = screen.getByTestId("export-preview").getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    // 인쇄 창은 allow-modals 가 없으면 막힌다(W5)
    expect(sandbox).toContain("allow-modals");
  });

  it("[print] is a secondary button next to save/copy in every format, and its tooltip says how to make a PDF", async () => {
    await renderLoaded(sectionRequest);
    for (const f of ["hwpx", "docx", "html", "copy", "md"]) {
      pickFormat(f);
      const frame = screen.getByTestId("export-preview");
      fireEvent.load(frame);
      const print = screen.getByTestId("export-print") as HTMLButtonElement;
      expect(print.className, f).toBe("btn");
      expect(print.textContent, f).toBe(t("export.print"));
      expect(print.title, f).toBe(t("export.note_print"));
      expect(screen.queryByTestId("export-save") ?? screen.queryByTestId("export-copy"), f).toBeTruthy();
    }
  });

  it("print waits for the preview to finish loading the current paper, then prints the iframe document without saving anything", async () => {
    const onClose = await renderLoaded(sectionRequest);
    let frame = screen.getByTestId("export-preview") as HTMLIFrameElement;
    const button = () => screen.getByTestId("export-print") as HTMLButtonElement;

    // 지금 문서를 다 그리면 누를 수 있다(jsdom 은 srcdoc iframe 의 load 를 스스로도 보낸다 — 한 번 더 보내도 같다)
    fireEvent.load(frame);
    expect(button().disabled).toBe(false);

    // 용지를 바꾸면 새 문서가 그려질 때까지 막힌다(이전·빈 문서를 인쇄하지 않게).
    // key={srcDoc} 이라 iframe 이 새로 만들어진다 — 옛 프레임의 늦은 load 는 새 문서를 열 수 없다(U-6).
    const oldFrame = frame;
    fireEvent.click(screen.getByTestId("export-orient-landscape"));
    expect(button().disabled).toBe(true);
    expect(button().title).toBe(t("export.print_wait"));
    frame = screen.getByTestId("export-preview") as HTMLIFrameElement;
    expect(frame).not.toBe(oldFrame);
    const printSpy = vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => {});
    fireEvent.load(frame);
    expect(button().disabled).toBe(false);
    // 새 프레임의 문서가 실제로 다 그려질 때까지(onPrint 의 readyState 겹침 방어)
    await waitFor(() => expect(frame.contentWindow!.document.readyState).toBe("complete"));

    fireEvent.click(button());
    settleImages(frame);
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    // 파일을 쓰지 않는다 — 저장 대화상자도 내보내기 커맨드도 없고, 인쇄 창을 닫으면 모달로 돌아온다
    expect(saveMock).not.toHaveBeenCalled();
    expect(callMock.mock.calls.filter((c) => String(c[0]).startsWith("export_"))).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("export-print-failed")).toBeNull();
  });

  it("saving formats also offer [print] next to [save], printing the same preview without saving", async () => {
    await renderLoaded(sectionRequest);
    expect(screen.getByTestId("export-save")).toBeTruthy();
    const frame = screen.getByTestId("export-preview") as HTMLIFrameElement;
    const printSpy = vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => {});
    fireEvent.load(frame);
    await waitFor(() => expect(frame.contentWindow!.document.readyState).toBe("complete"));
    fireEvent.click(screen.getByTestId("export-print"));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(callMock.mock.calls.filter((c) => String(c[0]).startsWith("export_"))).toEqual([]);
  });

  it("a blocked print dialog says so in the modal instead of doing nothing", async () => {
    await renderLoaded(sectionRequest);
    const frame = screen.getByTestId("export-preview") as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    fireEvent.load(frame);
    fireEvent.click(screen.getByTestId("export-print"));
    settleImages(frame);
    await waitFor(() => expect(screen.getByTestId("export-print-failed").textContent).toBe(t("export.print_failed")));
  });

  it("preview images are lazy; [print] switches them to eager, shows the preparing label, ignores a second click, and prints only after every image finished", async () => {
    await renderLoaded(sectionRequest);
    const frame = screen.getByTestId("export-preview") as HTMLIFrameElement;
    expect(srcDocOf()).toContain('loading="lazy"');
    const printSpy = vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => {});
    fireEvent.load(frame);
    await waitFor(() => expect(frame.contentWindow!.document.readyState).toBe("complete"));
    plantLazyImages(frame);
    const imgs = Array.from(frame.contentDocument!.images);
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.every((i) => i.getAttribute("loading") === "lazy")).toBe(true);

    const button = () => screen.getByTestId("export-print") as HTMLButtonElement;
    fireEvent.click(button());
    expect(imgs.every((i) => i.loading === "eager")).toBe(true);
    await waitFor(() => expect(button().textContent).toBe(t("export.print_preparing")));
    expect(button().disabled).toBe(true);
    fireEvent.click(button()); // 무시된다
    expect(printSpy).not.toHaveBeenCalled();

    settleImages(frame);
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button().textContent).toBe(t("export.print")));
    expect(reportFallbackMock).not.toHaveBeenCalledWith("export", "print_images_timeout", expect.anything());
  });

  it("if images never finish, prints anyway after the cap and records print_images_timeout", async () => {
    await renderLoaded(sectionRequest);
    const frame = screen.getByTestId("export-preview") as HTMLIFrameElement;
    const printSpy = vi.spyOn(frame.contentWindow!, "print").mockImplementation(() => {});
    fireEvent.load(frame);
    await waitFor(() => expect(frame.contentWindow!.document.readyState).toBe("complete"));
    plantLazyImages(frame);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(screen.getByTestId("export-print"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(reportFallbackMock).toHaveBeenCalledWith("export", "print_images_timeout", expect.any(String));
  });

  it("shows 'section i/N' progress while the document is being opened", async () => {
    let release!: () => void;
    yieldFrameMock.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    render(<ExportModal request={sectionRequest} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("export-stage-status").textContent).toBe(t("export.loading_section", { i: 1, n: 3 })));
    release();
    await waitFor(() => expect(screen.getByTestId("export-preview")).toBeTruthy());
  });
});

describe("ExportModalHost", () => {
  beforeEach(() => {
    callMock.mockReset();
    mockInvoke();
    useExportModalStore.setState({ request: null });
  });
  afterEach(() => cleanup());

  it("renders nothing until a request is made, then shows the modal; closing clears the request", async () => {
    render(<ExportModalHost />);
    expect(screen.queryByTestId("export-modal")).toBeNull();

    act(() => useExportModalStore.getState().open(noteRequest));
    await waitFor(() => expect(screen.getByTestId("export-modal")).toBeTruthy());

    fireEvent.click(screen.getByTestId("export-cancel"));
    expect(useExportModalStore.getState().request).toBeNull();
    expect(screen.queryByTestId("export-modal")).toBeNull();
  });
});
