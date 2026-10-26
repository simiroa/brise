import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "../../lib/commands.gen";
import { FootnotePreview, footnoteAttachments } from "./FootnotePreview";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));

// 에디터 브리지는 mock — 이 테스트는 "목록이 브리지를 올바르게 호출하는가"만 본다(브리지 자체와
// 앵커 찾기/데코레이션은 components/editor/footnoteMark.test.ts).
const setHoveredFootnoteMock = vi.fn();
const revealFootnoteMock = vi.fn();
vi.mock("../editor/footnoteMark", async (importActual) => ({
  // MarkdownBody → PREVIEW_EXTENSIONS 가 FootnoteMark 를 쓰므로 나머지는 실제 모듈 유지.
  ...(await importActual<typeof import("../editor/footnoteMark")>()),
  setHoveredFootnote: (id: string | null) => setHoveredFootnoteMock(id),
  revealFootnoteInEditor: (id: string) => revealFootnoteMock(id),
}));

const reloadActiveMock = vi.fn();
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({ reloadActive: () => reloadActiveMock() }),
  },
}));

function fnAtt(partial: Partial<Attachment> & { id: string }): Attachment {
  return {
    name: `${partial.id}.md`,
    kind: "footnote",
    rel_path: `n1/${partial.id}.md`,
    url: null,
    size_bytes: 12,
    position: 0,
    ...partial,
  } as Attachment;
}

/** 본문은 attachment_read_text IPC 로 온다 — id → text 로 응답하는 기본 mock. */
function mockBodies(bodies: Record<string, string>) {
  callSilentMock.mockImplementation(async (cmd: unknown, args: unknown) => {
    const { id } = args as { id: string };
    if (cmd !== "attachment_read_text" || !(id in bodies)) throw new Error(`unexpected ${cmd} ${id}`);
    return { text: bodies[id] };
  });
}

describe("footnoteAttachments", () => {
  it("keeps only footnote kind and sorts by position then id", () => {
    const rows = [
      fnAtt({ id: "b", position: 2 }),
      fnAtt({ id: "a", position: 1 }),
      { ...fnAtt({ id: "x" }), kind: "note" } as Attachment,
      fnAtt({ id: "c", position: 1 }),
    ];
    expect(footnoteAttachments(rows).map((a) => a.id)).toEqual(["a", "c", "b"]);
  });
});

describe("FootnotePreview", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue(undefined);
    callSilentMock.mockReset();
    reloadActiveMock.mockReset();
    reloadActiveMock.mockResolvedValue(undefined);
    setHoveredFootnoteMock.mockReset();
    revealFootnoteMock.mockReset();
    scrollIntoView.mockReset();
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it("shows a quiet empty state when there are no footnotes", () => {
    render(<FootnotePreview footnotes={[]} />);
    expect(screen.getByTestId("footnote-preview-empty")).toBeTruthy();
    expect(screen.queryByTestId("footnote-preview-list")).toBeNull();
    expect(screen.queryByTestId("footnote-preview")).toBeNull();
  });

  it("always renders the single list — bodies load over IPC (attachment_read_text)", async () => {
    const a = fnAtt({ id: "fn1", position: 0, url: "first anchor" });
    const b = fnAtt({ id: "fn2", position: 1, url: "second anchor" });
    mockBodies({ fn1: "Body one", fn2: "Body two" });

    render(<FootnotePreview footnotes={[a, b]} />);

    const list = await screen.findByTestId("footnote-preview-list");
    const items = within(list).getAllByTestId("footnote-preview-list-item");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-footnote-id")).toBe("fn1");
    expect(items[1].getAttribute("data-footnote-id")).toBe("fn2");
    await waitFor(() => {
      expect(list.textContent).toContain("Body one");
      expect(list.textContent).toContain("Body two");
    });
    // Anchor excerpt renders per entry (the detail-only variant is gone).
    expect(screen.getAllByTestId("footnote-preview-anchor")).toHaveLength(2);
    // Mode switches removed with detail mode.
    expect(screen.queryByTestId("footnote-preview-show-all")).toBeNull();
    expect(screen.queryByTestId("footnote-preview-show-detail")).toBeNull();
    // Every body goes through the shared MarkdownBody renderer.
    expect(screen.getAllByTestId("footnote-preview-body")).toHaveLength(2);
    expect(callSilentMock).toHaveBeenCalledWith("attachment_read_text", { id: "fn1" });
    expect(callSilentMock).toHaveBeenCalledWith("attachment_read_text", { id: "fn2" });
  });

  it("renders markdown bodies as real elements (bold, list)", async () => {
    mockBodies({ fn1: "**bold** text\n\n- item a\n- item b" });
    render(<FootnotePreview footnotes={[fnAtt({ id: "fn1" })]} />);
    const body = await screen.findByTestId("footnote-preview-body");
    await waitFor(() => {
      expect(body.querySelector("strong")?.textContent).toBe("bold");
      expect(body.querySelectorAll("li")).toHaveLength(2);
    });
  });

  // 회귀: asset 프로토콜 fetch 시절 Windows 에서 scope 403 으로 모든 본문이
  // "텍스트를 불러오지 못했습니다"였다 — 이제 실패는 그 항목에만 국한된 문구여야 한다.
  it("shows the failure text only for the entry whose read fails", async () => {
    const a = fnAtt({ id: "fn1", position: 0 });
    const b = fnAtt({ id: "fn2", position: 1 });
    callSilentMock.mockImplementation(async (_cmd: unknown, args: unknown) => {
      const { id } = args as { id: string };
      if (id === "fn2") throw new Error("boom");
      return { text: "Body one" };
    });

    render(<FootnotePreview footnotes={[a, b]} />);
    const list = await screen.findByTestId("footnote-preview-list");
    await waitFor(() => {
      expect(list.textContent).toContain("Body one");
      expect(list.textContent).toContain("Failed to load text content.");
    });
  });

  it("focusId scrolls the matching entry into view and highlights it", async () => {
    const a = fnAtt({ id: "fn1", position: 0 });
    const b = fnAtt({ id: "fn2", position: 1 });
    mockBodies({ fn1: "body", fn2: "body" });

    const { rerender } = render(<FootnotePreview footnotes={[a, b]} focusId="fn2" />);

    const items = await screen.findAllByTestId("footnote-preview-list-item");
    expect(items[1].getAttribute("data-active")).toBe("true");
    expect(items[0].getAttribute("data-active")).toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    // A second marker click (different focusId) must re-scroll, not be swallowed as a no-op.
    scrollIntoView.mockClear();
    rerender(<FootnotePreview footnotes={[a, b]} focusId="fn1" />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.getAllByTestId("footnote-preview-list-item")[0].getAttribute("data-active")).toBe("true");
  });

  it("does not scroll when no focusId is given (attachments-bar tile entry point)", async () => {
    const a = fnAtt({ id: "fn1" });
    mockBodies({ fn1: "body" });
    render(<FootnotePreview footnotes={[a]} />);
    await screen.findByTestId("footnote-preview-list");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("per-entry delete confirms, calls attachment_remove and refreshes the note", async () => {
    const user = userEvent.setup();
    const a = fnAtt({ id: "fn1", position: 0 });
    const b = fnAtt({ id: "fn2", position: 1 });
    mockBodies({ fn1: "body", fn2: "body" });

    render(<FootnotePreview footnotes={[a, b]} />);
    await screen.findByTestId("footnote-preview-list");

    const deletes = screen.getAllByTestId("footnote-preview-delete");
    expect(deletes).toHaveLength(2);
    await user.click(deletes[1]);

    // Confirm dialog first — nothing is removed on the delete click alone.
    expect(callMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "fn2" });
    });
    await waitFor(() => expect(reloadActiveMock).toHaveBeenCalledTimes(1));
  });

  it("cancelling the delete dialog removes nothing", async () => {
    const user = userEvent.setup();
    const a = fnAtt({ id: "fn1" });
    mockBodies({ fn1: "body" });

    render(<FootnotePreview footnotes={[a]} />);
    await screen.findByTestId("footnote-preview-list");

    await user.click(screen.getByTestId("footnote-preview-delete"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(callMock).not.toHaveBeenCalled();
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });

  it("hover는 본문 앵커 강조를 켜고 끄며, 언마운트에서도 반드시 끈다", async () => {
    const user = userEvent.setup();
    const a = fnAtt({ id: "fn1" });
    mockBodies({ fn1: "body" });

    const { unmount } = render(<FootnotePreview footnotes={[a]} />);
    const item = await screen.findByTestId("footnote-preview-list-item");

    await user.hover(item);
    expect(setHoveredFootnoteMock).toHaveBeenLastCalledWith("fn1");
    await user.unhover(item);
    expect(setHoveredFootnoteMock).toHaveBeenLastCalledWith(null);

    // 마우스를 얹은 채로 패널이 사라져도 강조가 에디터에 남으면 안 된다.
    await user.hover(item);
    setHoveredFootnoteMock.mockClear();
    unmount();
    expect(setHoveredFootnoteMock).toHaveBeenCalledWith(null);
  });

  it("항목 클릭은 에디터를 그 앵커로 이동시키고, 삭제 버튼 클릭은 이동시키지 않는다", async () => {
    const user = userEvent.setup();
    const a = fnAtt({ id: "fn1", position: 0 });
    const b = fnAtt({ id: "fn2", position: 1 });
    mockBodies({ fn1: "body", fn2: "body" });

    render(<FootnotePreview footnotes={[a, b]} />);
    const items = await screen.findAllByTestId("footnote-preview-list-item");

    await user.click(items[1]);
    expect(revealFootnoteMock).toHaveBeenCalledWith("fn2");

    revealFootnoteMock.mockReset();
    await user.click(screen.getAllByTestId("footnote-preview-delete")[0]);
    expect(revealFootnoteMock).not.toHaveBeenCalled();
  });
});
