import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useSettingsStore } from "../../../stores/settings";
import { CollectHistorySection } from "./CollectHistorySection";

const callSilentMock = vi.fn();
vi.mock("../../../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/invoke")>()),
  callSilent: (...a: unknown[]) => callSilentMock(...a),
}));

const openMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../lib/openNoteInMain", () => ({ requestOpenNoteInMain: (...a: unknown[]) => openMock(...a) }));

// collect_history 가 돌려주는 행 — 표가 쓰는 필드만(발췌·태그·소스 id 는 없다).
const item = (id: string, title: string, source: string | null) => ({
  note_id: id, title, source_name: source,
  collected_at: new Date(Date.now() - 3_600_000).toISOString(),
});

describe("CollectHistorySection", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
    openMock.mockClear();
    useSettingsStore.setState({ uiLang: "en" } as never);
  });

  it("수집된 노트를 최근순 표로 보여 주고, 행이나 제목 단추를 누르면 본 창에서 연다", async () => {
    callSilentMock.mockResolvedValue({ items: [item("n1", "First", "Feed A"), item("n2", "Second", null)] });
    render(<CollectHistorySection />);
    await waitFor(() => expect(screen.getAllByTestId("collect-history-row")).toHaveLength(2));
    // 브리핑 카드용 briefing_recent_collected 가 아니라 이력 전용 커맨드 — 브리핑에서 끈 소스의 노트도 나와야 한다.
    expect(callSilentMock).toHaveBeenCalledWith("collect_history", { limit: 30 });
    expect(callSilentMock).not.toHaveBeenCalledWith("briefing_recent_collected", expect.anything());
    expect(screen.getByText("Feed A")).toBeTruthy();

    fireEvent.click(screen.getAllByTestId("collect-history-row")[1]);
    expect(openMock).toHaveBeenCalledWith("n2");
    // 단추를 눌러도 한 번만 — 행 클릭과 겹치지 않는다.
    openMock.mockClear();
    fireEvent.click(screen.getAllByTestId("collect-history-open")[0]);
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith("n1");
  });

  it("비어 있으면 안내 한 줄, 실패하면 실패 문구", async () => {
    callSilentMock.mockResolvedValue({ items: [] });
    const { unmount } = render(<CollectHistorySection />);
    await waitFor(() => expect(screen.getByText("No collected notes yet.")).toBeTruthy());
    unmount();
    callSilentMock.mockRejectedValue(new Error("boom"));
    render(<CollectHistorySection />);
    await waitFor(() => expect(screen.getByText("Couldn't load the collection history.")).toBeTruthy());
  });
});
