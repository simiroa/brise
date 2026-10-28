import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { PastePolicyCard } from "./PastePolicyCard";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

// 에디터 페이지에서 이사(2026-10-27, 첨부파일 페이지) — EditorSection.test 의 두 테스트를 그대로 가져왔다.
describe("PastePolicyCard — 첨부파일 > 붙여넣기·드롭", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callMock.mockResolvedValue({});
    useSettingsStore.setState({
      uiLang: "ko",
      sourceOriginalPolicy: "ask",
      pasteLinkNudge: true,
      pastePathInlineCode: true,
      pasteTableSheetSuggest: true,
    } as any);
  });

  it("source_original_policy 셀렉트가 붙여넣기·드롭 카드에 있고 고르면 settings_set 을 부른다", async () => {
    render(<PastePolicyCard />);

    const card = screen.getByTestId("settings-editor-paste-drop");
    const trigger = screen.getByLabelText("파일 드롭 시 원본 처리");
    expect(card.contains(trigger)).toBe(true);
    expect(trigger.textContent).toContain("놓을 때마다 묻기");

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("원본 보관"));

    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { source_original_policy: "keep" } });
  });

  it("붙여넣기 제안 토글 세 개가 붙여넣기·드롭 카드에 있고 클릭하면 각자의 스토어 값과 settings_set 을 함께 바꾼다", () => {
    render(<PastePolicyCard />);

    const card = screen.getByTestId("settings-editor-paste-drop");
    const linkToggle = screen.getByTestId("settings-paste-link-nudge-toggle");
    const pathToggle = screen.getByTestId("settings-paste-path-inline-code-toggle");
    const tableToggle = screen.getByTestId("settings-paste-table-sheet-suggest-toggle");
    expect(card.contains(linkToggle)).toBe(true);
    expect(card.contains(pathToggle)).toBe(true);
    expect(card.contains(tableToggle)).toBe(true);

    act(() => {
      fireEvent.click(linkToggle);
    });
    expect(useSettingsStore.getState().pasteLinkNudge).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { paste_link_nudge: false } });

    act(() => {
      fireEvent.click(pathToggle);
    });
    expect(useSettingsStore.getState().pastePathInlineCode).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { paste_path_inline_code: false } });

    act(() => {
      fireEvent.click(tableToggle);
    });
    expect(useSettingsStore.getState().pasteTableSheetSuggest).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { paste_table_sheet_suggest: false } });
  });
});
