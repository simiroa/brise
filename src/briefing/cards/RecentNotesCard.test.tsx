import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/invoke")>()),
  call: vi.fn(),
  callSilent: vi.fn(),
}));
vi.mock("../../lib/openNoteInMain", () => ({ requestOpenNoteInMain: vi.fn(() => Promise.resolve()) }));

import type { RecentWorkNote } from "../../lib/commands.gen";
import { requestOpenNoteInMain } from "../../lib/openNoteInMain";
import { t } from "../../i18n/t";
import { useSettingsStore } from "../../stores/settings";
import { RecentNotesCard } from "./RecentNotesCard";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const items: RecentWorkNote[] = [
  { note_id: "n1", title: "회의록", folder_name: "업무", last_at: ago(12 * 60_000) },
  { note_id: "n2", title: "Untitled Note", folder_name: null, last_at: ago(3 * 3_600_000) },
];

describe("RecentNotesCard", () => {
  beforeEach(() => {
    vi.mocked(requestOpenNoteInMain).mockClear();
    useSettingsStore.setState({ uiLang: "en" });
  });

  it("제목 · 폴더(있으면) · 상대 시각을 그리고, 센티널 제목은 '제목 없음'으로", () => {
    render(<RecentNotesCard status="ready" items={items} reload={() => {}} />);
    const rows = screen.getAllByTestId("brf-recent-note-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("회의록");
    expect(rows[0].textContent).toContain("업무");
    expect(rows[0].textContent).toContain("12 minutes ago");
    expect(rows[1].textContent).toContain(t("briefing.recent_untitled"));
    expect(rows[1].textContent).not.toContain("Untitled Note");
    expect(rows[1].querySelector(".brf-recent-folder")).toBeNull();
    expect(rows[1].textContent).toContain("3 hours ago");
  });

  it("행을 누르면 본 창에서 그 노트를 연다", () => {
    render(<RecentNotesCard status="ready" items={items} reload={() => {}} />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(requestOpenNoteInMain).toHaveBeenCalledWith("n1");
  });

  it("0건이면 빈 상태 문구, 로딩·오류는 공통 상태 줄(오류는 재시도)", () => {
    const { rerender } = render(<RecentNotesCard status="ready" items={[]} reload={() => {}} />);
    expect(screen.getByTestId("brf-recent-notes").textContent).toContain(t("briefing.recent_notes_empty"));
    rerender(<RecentNotesCard status="loading" items={[]} reload={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
    const reload = vi.fn();
    rerender(<RecentNotesCard status="error" items={[]} reload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: t("briefing.retry") }));
    expect(reload).toHaveBeenCalled();
  });
});
