import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "../../lib/commands.gen";
import { LinkReaderPreview } from "./LinkReaderPreview";

const callMock = vi.fn();
const callSilentMock = vi.fn();
const emitNoticeMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));

const insertAiSectionMock = vi.fn();
vi.mock("../../lib/aiSectionBridge", () => ({
  insertAiSection: (...args: unknown[]) => insertAiSectionMock(...args),
  withSourceLine: (body: string, sources: { label: string; url?: string }[]) =>
    sources.length ? `${body}\n\n> 출처: [${sources[0].label}](${sources[0].url})\n` : body,
}));

const att: Attachment = {
  id: "a-link",
  name: "example.com",
  kind: "link",
  rel_path: null,
  url: "https://example.com/article",
  size_bytes: 0,
  position: 0,
};

/**
 * 관문 재사용 계약: 프리뷰가 이미 손에 든 fetch 결과(linkReaderData)를 insertAiSection 에
 * 그대로 넘긴다 — attachment_fetch_reader 를 다시 부르지 않는다(=importLinkToSection 우회
 * 아님, 관문의 마지막 단계만 재사용). CLAUDE.md 레인 P 지시서 참고.
 */
describe("LinkReaderPreview — 섹션으로 가져오기", () => {
  beforeEach(() => {
    callMock.mockReset();
    callSilentMock.mockReset();
    emitNoticeMock.mockReset();
    insertAiSectionMock.mockReset();
    callSilentMock.mockResolvedValue({
      title: "Example Article",
      text: "본문 내용",
      truncated: false,
    });
  });

  it("성공 상태에서 버튼을 누르면 추출된 본문+출처 한 줄로 insertAiSection 이 불리고 재fetch 하지 않는다", async () => {
    insertAiSectionMock.mockResolvedValue({ id: "sec-1", body: "본문 내용" });
    render(<LinkReaderPreview att={att} noteId="note-1" />);

    const btn = await screen.findByTitle("Import to section");
    await userEvent.click(btn);

    await waitFor(() => expect(insertAiSectionMock).toHaveBeenCalledTimes(1));
    const [name, body, noteId] = insertAiSectionMock.mock.calls[0];
    expect(name).toBe("Example Article");
    expect(body).toContain("본문 내용");
    expect(body).toContain("https://example.com/article");
    expect(noteId).toBe("note-1");

    // fetch 는 최초 마운트 시 한 번뿐 — 버튼 클릭이 재fetch 를 유발하지 않는다.
    expect(callSilentMock).toHaveBeenCalledTimes(1);
  });

  it("insertAiSection 이 null 이면 실패를 알린다", async () => {
    insertAiSectionMock.mockResolvedValue(null);
    render(<LinkReaderPreview att={att} noteId="note-1" />);

    const btn = await screen.findByTitle("Import to section");
    await userEvent.click(btn);

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
  });
});
