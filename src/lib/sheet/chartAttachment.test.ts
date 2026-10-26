import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotesStore } from "../../stores/notes";
import type { Attachment, NoteDetail } from "../commands.gen";
import {
  chartAttachmentUrl,
  findChartAttachment,
  isChartRegistered,
  setChartRegistered,
} from "./chartAttachment";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
vi.mock("../invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

const chartAtt: Attachment = {
  id: "att-1",
  name: "매출",
  kind: "chart",
  rel_path: null,
  url: "sec-1#c1",
  size_bytes: null,
  position: 0,
};

function seed(attachments: Attachment[]) {
  useNotesStore.setState({
    activeNote: {
      note: { id: "n1" },
      sections: [],
      sources: [],
      attachments,
    } as unknown as NoteDetail,
  });
}

describe("chartAttachment", () => {
  beforeEach(() => {
    callMock.mockReset();
    flushAllMock.mockClear();
    useNotesStore.setState({ reloadActive: vi.fn(async () => {}) });
  });

  it("url is section#chart and lookup matches only kind=chart with that url", () => {
    expect(chartAttachmentUrl("sec-1", "c1")).toBe("sec-1#c1");
    const link: Attachment = { ...chartAtt, id: "att-2", kind: "link" };
    expect(findChartAttachment([link, chartAtt], "sec-1", "c1")?.id).toBe("att-1");
    expect(isChartRegistered([chartAtt], "sec-1", "c1")).toBe(true);
    expect(isChartRegistered([chartAtt], "sec-1", "c2")).toBe(false);
    expect(isChartRegistered([link], "sec-1", "c1")).toBe(false);
    expect(isChartRegistered(undefined, "sec-1", "c1")).toBe(false);
  });

  it("on=true flushes pending sheet saves, calls attachment_add_chart, then reloads", async () => {
    seed([]);
    callMock.mockResolvedValue(chartAtt);
    await setChartRegistered({ noteId: "n1", sectionId: "sec-1", chartId: "c1", name: "매출", on: true });
    expect(flushAllMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("attachment_add_chart", {
      note_id: "n1",
      section_id: "sec-1",
      chart_id: "c1",
      name: "매출",
    });
    expect(useNotesStore.getState().reloadActive).toHaveBeenCalledTimes(1);
  });

  it("on=false removes the existing chart row by id and reloads", async () => {
    seed([chartAtt]);
    callMock.mockResolvedValue({ deleted: true });
    await setChartRegistered({ noteId: "n1", sectionId: "sec-1", chartId: "c1", name: "매출", on: false });
    expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-1" });
    expect(useNotesStore.getState().reloadActive).toHaveBeenCalledTimes(1);
  });

  it("on=false with no matching row is a no-op (no IPC, no reload)", async () => {
    seed([]);
    await setChartRegistered({ noteId: "n1", sectionId: "sec-1", chartId: "c1", name: "매출", on: false });
    expect(callMock).not.toHaveBeenCalled();
    expect(useNotesStore.getState().reloadActive).not.toHaveBeenCalled();
  });

  it("rethrows when the IPC fails and does not reload (no optimistic state to roll back)", async () => {
    seed([]);
    callMock.mockRejectedValue({ code: "NOT_FOUND", message: "chart not found" });
    await expect(
      setChartRegistered({ noteId: "n1", sectionId: "sec-1", chartId: "c1", name: "매출", on: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(useNotesStore.getState().reloadActive).not.toHaveBeenCalled();
  });
});
