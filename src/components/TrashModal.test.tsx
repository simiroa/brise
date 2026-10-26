import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let responses: Record<string, unknown> = {};
const callMock = vi.fn((...args: unknown[]) => Promise.resolve(responses[args[0] as string] ?? {}));

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(),
  flushAll: async () => {},
}));

import { TrashModal } from "./TrashModal";
import { useUiStore } from "../stores/ui";
import { useTrashStore } from "../stores/trash";
import { t } from "../i18n/t";
import type { SectionTrashEntry } from "../lib/commands.gen";

function entry(overrides: Partial<SectionTrashEntry> = {}): SectionTrashEntry {
  return {
    id: "sec-1",
    name: "참고",
    kind: "text",
    note_id: "note-1",
    note_title: "9월 정기회의",
    note_deleted: false,
    deleted_at: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

// W5 (PLAN-2026-09-10 D4 프런트): 휴지통 모달은 노트 구역 아래 섹션 구역을 하나 더 갖는다.
// 섹션 행의 관례는 노트 행과 같다 — 복구는 확인 없이 바로, 완전 삭제만 확인 다이얼로그.
describe("TrashModal — 섹션 구역", () => {
  beforeEach(() => {
    callMock.mockClear();
    responses = { note_trash_list: [], section_trash_list: [] };
    useTrashStore.setState({ trashList: [], trashCount: 0, sectionTrash: [] });
    useUiStore.setState({ trashOpen: true } as never);
  });

  function renderWith(entries: SectionTrashEntry[]) {
    responses.section_trash_list = entries;
    render(<TrashModal />);
    return waitFor(() => expect(useTrashStore.getState().sectionTrash).toHaveLength(entries.length));
  }

  it("섹션 구역 제목과 \"이름 — 노트 에서\" 행을 그린다", async () => {
    await renderWith([entry()]);
    expect(screen.getByText(t("trash.sections_heading"))).toBeTruthy();
    const row = screen.getByTestId("section-trash-restore-sec-1").parentElement!;
    expect(row.textContent).toContain("참고");
    expect(row.textContent).toContain("9월 정기회의");
  });

  it("복구 버튼이 section_restore 를 부른다", async () => {
    await renderWith([entry()]);
    fireEvent.click(screen.getByTestId("section-trash-restore-sec-1"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_restore", { id: "sec-1" }));
  });

  it("원 노트가 휴지통이면 복구가 비활성이고 이유가 보인다", async () => {
    await renderWith([entry({ note_deleted: true })]);
    const btn = screen.getByTestId("section-trash-restore-sec-1") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(t("trash.section_restore_blocked"))).toBeTruthy();
    fireEvent.click(btn);
    expect(callMock).not.toHaveBeenCalledWith("section_restore", expect.anything());
  });

  it("완전 삭제는 노트 행과 같은 확인을 거쳐 section_purge 를 부른다", async () => {
    await renderWith([entry()]);
    fireEvent.click(screen.getByTestId("section-trash-purge-sec-1"));
    // 확인 전에는 아무것도 지우지 않는다.
    expect(callMock).not.toHaveBeenCalledWith("section_purge", expect.anything());

    const confirms = screen.getAllByRole("button", { name: t("trash.delete_forever") });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_purge", { id: "sec-1" }));
  });

  it("노트가 없어도 섹션만 있으면 빈 상태를 그리지 않는다", async () => {
    await renderWith([entry()]);
    expect(screen.queryByText(t("trash.empty_state"))).toBeNull();
  });
});
