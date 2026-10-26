import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AttachmentContextMenu } from "./AttachmentContextMenu";
import { t } from "../../i18n/t";

const call = vi.fn(async (_cmd: string, _args?: unknown) => ({}));
const emitNotice = vi.fn();
const reloadActive = vi.fn(async () => {});
const bumpAttachmentRevision = vi.fn();
const openExternal = vi.fn();
const revealExternal = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (cmd: string, args?: unknown) => call(cmd, args),
  callSilent: (cmd: string, args?: unknown) => call(cmd, args),
  emitNotice: (...a: unknown[]) => emitNotice(...a),
}));
vi.mock("../../lib/attachmentOpen", () => ({
  openAttachmentExternal: (id: string) => openExternal(id),
  revealAttachmentExternal: (id: string) => revealExternal(id),
}));
vi.mock("../../stores/notes", () => ({
  useNotesStore: { getState: () => ({ activeNote: { note: { content_locked: false } }, reloadActive, bumpAttachmentRevision }) },
}));

const doc = { id: "a1", name: "main.py", kind: "doc" };

function setup(attachment = doc, over: { onDelete?: () => void; extra?: React.ReactNode } = {}) {
  const onClose = vi.fn();
  const onDelete = over.onDelete ?? vi.fn();
  render(<AttachmentContextMenu x={10} y={10} attachment={attachment} onClose={onClose} onDelete={onDelete} extra={over.extra} />);
  return { onClose, onDelete };
}

describe("AttachmentContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("파일 첨부: 열기 · 폴더에서 보기 · 이름 바꾸기 · 삭제 네 행, extra 는 삭제 위에", () => {
    setup(doc, { extra: <button data-testid="extra-row">x</button> });
    const rows = Array.from(document.querySelectorAll('[data-testid^="attachment-menu-"], [data-testid="extra-row"]')).map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(rows).toEqual(["attachment-menu-open", "attachment-menu-reveal", "attachment-menu-rename", "extra-row", "attachment-menu-remove"]);
  });

  it("링크·차트 등 파일이 아닌 첨부는 삭제만", () => {
    setup({ id: "l1", name: "구글", kind: "link" });
    expect(screen.queryByTestId("attachment-menu-open")).toBeNull();
    expect(screen.queryByTestId("attachment-menu-rename")).toBeNull();
    expect(screen.getByTestId("attachment-menu-remove")).toBeTruthy();
  });

  it("열기·폴더에서 보기는 같은 id 로 공용 헬퍼를 부르고 메뉴를 닫는다", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByTestId("attachment-menu-open"));
    expect(openExternal).toHaveBeenCalledWith("a1");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("attachment-menu-reveal"));
    expect(revealExternal).toHaveBeenCalledWith("a1");
  });

  it("삭제는 호출자가 정한 방식(onDelete)에 맡긴다", () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByTestId("attachment-menu-remove"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("이름 바꾸기: 입력 창에 현재 이름 → 제출하면 attachment_rename(trim) 후 노트·갤러리 갱신", async () => {
    setup();
    fireEvent.click(screen.getByTestId("attachment-menu-rename"));
    const input = screen.getByDisplayValue("main.py") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  server.py " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(call).toHaveBeenCalledWith("attachment_rename", { id: "a1", name: "server.py" }));
    await waitFor(() => expect(bumpAttachmentRevision).toHaveBeenCalledTimes(1));
    expect(reloadActive).toHaveBeenCalledTimes(1);
  });

  it("이름 바꾸기가 서버에서 거부돼도(확장자 변경 등) 예외가 새지 않고 갱신도 하지 않는다", async () => {
    call.mockRejectedValueOnce(new Error("VALIDATION"));
    setup();
    fireEvent.click(screen.getByTestId("attachment-menu-rename"));
    const input = screen.getByDisplayValue("main.py");
    fireEvent.change(input, { target: { value: "main.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(bumpAttachmentRevision).not.toHaveBeenCalled();
    expect(t("attachments.ctx_rename")).toBeTruthy();
  });
});
