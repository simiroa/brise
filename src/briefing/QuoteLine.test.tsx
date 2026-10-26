import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const silentMock = vi.fn();
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: vi.fn(),
  callSilent: (...a: unknown[]) => silentMock(...a),
}));
const fallbackMock = vi.fn();
vi.mock("../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diag")>()),
  reportFallback: (...a: unknown[]) => fallbackMock(...a),
}));
const openMock = vi.fn((_id: string) => Promise.resolve());
vi.mock("../lib/openNoteInMain", () => ({ requestOpenNoteInMain: (id: string) => openMock(id) }));
vi.mock("../lib/phrasePacks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/phrasePacks")>()),
  // 사용자 팩은 파일에서 읽는다 — 테스트에선 번들 팩만.
  loadAllPhrasePacks: () =>
    Promise.resolve([{ id: "bundled:knowledge", name: "지식", origin: "bundled", items: [{ text: "물은 100도에서 끓는다", source: "상식" }] }]),
}));

import { useSettingsStore } from "../stores/settings";
import { QuoteLine, NOTE_QUOTES_PACK_ID } from "./QuoteLine";

beforeEach(() => {
  silentMock.mockReset();
  fallbackMock.mockReset();
  openMock.mockClear();
  useSettingsStore.setState({ activeWorkspaceId: "w1", phrasePackId: NOTE_QUOTES_PACK_ID });
});

describe("QuoteLine — 내 노트 인용", () => {
  it("서버가 고른 노트 문장을 보여 주고, 출처를 누르면 본 창에서 그 노트를 연다", async () => {
    silentMock.mockResolvedValue({ quote: { note_id: "n1", title: "독서 노트", text: "천천히 읽자" } });
    render(<QuoteLine />);
    await waitFor(() => expect(screen.getByTestId("brf-quote-text").textContent).toContain("천천히 읽자"));
    expect(silentMock).toHaveBeenCalledWith("briefing_note_quote", { workspace_id: "w1" });
    fireEvent.click(screen.getByTestId("brf-quote-source"));
    expect(openMock).toHaveBeenCalledWith("n1");
  });

  it("새로고침은 방금 본 노트를 피해 달라고 한다", async () => {
    silentMock.mockResolvedValue({ quote: { note_id: "n1", title: "a", text: "첫 문장입니다" } });
    render(<QuoteLine />);
    await waitFor(() => expect(screen.getByTestId("brf-quote-refresh")).toBeTruthy());
    fireEvent.click(screen.getByTestId("brf-quote-refresh"));
    await waitFor(() =>
      expect(silentMock).toHaveBeenLastCalledWith("briefing_note_quote", { workspace_id: "w1", exclude_note_id: "n1" }),
    );
  });

  it("null 이면 지식 팩으로 바꾸지 않는다 — 정직한 빈 상태 + 진단 1행", async () => {
    silentMock.mockResolvedValue({ quote: null });
    render(<QuoteLine />);
    await waitFor(() => expect(screen.getByTestId("brf-quote-empty")).toBeTruthy());
    expect(screen.getByTestId("brf-quote").textContent).not.toContain("물은 100도");
    expect(fallbackMock).toHaveBeenCalledWith("briefing", "note_quote_empty", expect.any(String));
    expect(screen.queryByTestId("brf-quote-copy")).toBeNull();
  });

  it("조회 실패는 오류 + 다시 시도", async () => {
    silentMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ quote: { note_id: "n2", title: "b", text: "다시 온 문장" } });
    render(<QuoteLine />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByTestId("brf-quote-text").textContent).toContain("다시 온 문장"));
  });
});

describe("QuoteLine — 번들 팩·끔", () => {
  it("번들 팩은 파일의 문구를 그대로", async () => {
    useSettingsStore.setState({ phrasePackId: "bundled:knowledge" });
    render(<QuoteLine />);
    await waitFor(() => expect(screen.getByTestId("brf-quote-text").textContent).toContain("물은 100도에서 끓는다"));
    expect(screen.getByTestId("brf-quote").textContent).toContain("상식");
    expect(silentMock).not.toHaveBeenCalledWith("briefing_note_quote", expect.anything());
  });

  it("끔이면 줄 자체가 없다", () => {
    useSettingsStore.setState({ phrasePackId: "off" });
    render(<QuoteLine />);
    expect(screen.queryByTestId("brf-quote")).toBeNull();
  });
});
