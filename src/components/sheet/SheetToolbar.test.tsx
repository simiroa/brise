import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SheetToolbar, type SheetToolbarProps } from "./SheetToolbar";
import { t } from "../../i18n/t";

function setup(over: Partial<SheetToolbarProps> = {}) {
  const props: SheetToolbarProps = {
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onSetFormat: vi.fn(),
    onSetDecimals: vi.fn(),
    onInsertRow: vi.fn(),
    onDeleteRow: vi.fn(),
    onInsertCol: vi.fn(),
    onDeleteCol: vi.fn(),
    onAddRow: vi.fn(),
    onAddCol: vi.fn(),
    onSortAsc: vi.fn(),
    onSortDesc: vi.fn(),
    onClear: vi.fn(),
    canClear: true,
    onExportCsv: vi.fn(),
    ...over,
  };
  render(<SheetToolbar {...props} />);
  return props;
}

const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

describe("SheetToolbar", () => {
  // 오너 결정 2026-08-19: 보이는 라벨 0개. 접근 이름은 aria-label 로만 남는다.
  it("모든 컨트롤이 아이콘 전용 — 보이는 텍스트 라벨이 없다", () => {
    setup();
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.textContent).toBe("");
    for (const btn of toolbar.querySelectorAll("button")) {
      expect(btn.getAttribute("aria-label")).toBeTruthy();
      expect(btn.getAttribute("title")).toBe(btn.getAttribute("aria-label"));
    }
  });

  it("구조 편집 4종이 선택 위치 콜백을 부른다", () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText(t("editor.sheet_insert_row_above")));
    fireEvent.click(screen.getByLabelText(t("editor.sheet_delete_row")));
    fireEvent.click(screen.getByLabelText(t("editor.sheet_insert_col_left")));
    fireEvent.click(screen.getByLabelText(t("editor.sheet_delete_col")));
    expect(p.onInsertRow).toHaveBeenCalledTimes(1);
    expect(p.onDeleteRow).toHaveBeenCalledTimes(1);
    expect(p.onInsertCol).toHaveBeenCalledTimes(1);
    expect(p.onDeleteCol).toHaveBeenCalledTimes(1);
  });

  it("맨 끝에 덧붙이기 경로가 남아 있다", () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText(t("editor.sheet_add_row")));
    fireEvent.click(screen.getByLabelText(t("editor.sheet_add_col")));
    expect(p.onAddRow).toHaveBeenCalledTimes(1);
    expect(p.onAddCol).toHaveBeenCalledTimes(1);
  });

  it("소수 자릿수 ± 는 비숫자 서식에서 (숨김이 아니라) 비활성", () => {
    setup({ activeFormat: "text", activeDp: 0 });
    expect(btn("sheet-dp-more").disabled).toBe(true);
    expect(btn("sheet-dp-less").disabled).toBe(true);
  });

  it("숫자 서식: − 는 0 에서 잠기고 + 는 6 에서 잠긴다", () => {
    const p = setup({ activeFormat: "currency", activeDp: 0 });
    expect(btn("sheet-dp-less").disabled).toBe(true);
    fireEvent.click(screen.getByTestId("sheet-dp-more"));
    expect(p.onSetDecimals).toHaveBeenCalledWith(1);
  });

  it("소수 자릿수 상한 6", () => {
    setup({ activeFormat: "number", activeDp: 6 });
    expect(btn("sheet-dp-more").disabled).toBe(true);
    expect(btn("sheet-dp-less").disabled).toBe(false);
  });

  it("지울 내용이 없으면 지우기 버튼이 진짜로 비활성", () => {
    setup({ canClear: false });
    expect(btn("sheet-clear").disabled).toBe(true);
  });

  it("서식 팝오버: 트리거는 현재 서식을 접근 이름에 싣고, 고르면 콜백이 온다", () => {
    const p = setup({ activeFormat: "percent" });
    const trigger = screen.getByTestId("sheet-format-trigger");
    expect(trigger.getAttribute("aria-label")).toContain(t("editor.sheet_fmt_percent"));
    expect(screen.queryByTestId("sheet-format-list")).toBeNull();

    fireEvent.click(trigger);
    const list = screen.getByTestId("sheet-format-list");
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(6);
    expect(list.querySelector('[aria-selected="true"]')?.textContent).toContain(
      t("editor.sheet_fmt_percent")
    );

    fireEvent.click(screen.getByText(t("editor.sheet_fmt_date")));
    expect(p.onSetFormat).toHaveBeenCalledWith("date");
    expect(screen.queryByTestId("sheet-format-list")).toBeNull();
  });

  // 2026-09-26: AI 진입점은 노트 제목 줄(☆ 옆) 한 곳 — AI 가 켜져 있어도 섹션 툴바엔 두지 않는다.
  it("does not render an AI entry in the toolbar even when AI is available (it lives in the title row)", async () => {
    const { useSettingsStore } = await import("../../stores/settings");
    const { useAiStore } = await import("../../stores/ai");
    useSettingsStore.setState({ aiEnabled: true } as never);
    useAiStore.setState({ aiReachable: true } as never);

    setup();
    expect(screen.queryByTestId("ai-actions-menu")).toBeNull();
  });
});
