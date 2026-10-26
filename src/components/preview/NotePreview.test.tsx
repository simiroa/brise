import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NotePreview } from "./NotePreview";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));

const sec = (id: string, name: string, body: string) => ({ id, name, kind: "text", body_md: body });

function noteWith(sections: ReturnType<typeof sec>[]) {
  callMock.mockImplementation(async (cmd: string) =>
    cmd === "note_get" ? { note: { id: "n1", title: "노트" }, sections } : {}
  );
}

describe("NotePreview — 섹션 넘겨보기", () => {
  beforeEach(() => callMock.mockReset());

  it("섹션이 하나면 탭이 없다", async () => {
    noteWith([sec("a", "A", "hello")]);
    render(<NotePreview noteId="n1" />);
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(screen.queryByTestId("note-preview-sections")).toBeNull();
  });

  it("2개 이상이면 세그먼트 탭이 나오고 누르면 그 섹션이 보인다", async () => {
    noteWith([sec("a", "첫째", "one-body"), sec("b", "둘째", "two-body")]);
    render(<NotePreview noteId="n1" />);
    await waitFor(() => expect(screen.getByText("one-body")).toBeTruthy());
    expect(screen.getByTestId("note-preview-sections")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "둘째" }));
    await waitFor(() => expect(screen.getByText("two-body")).toBeTruthy());
    expect(screen.queryByText("one-body")).toBeNull();
  });
});
