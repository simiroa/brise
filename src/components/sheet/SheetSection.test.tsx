import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SheetSection } from "./SheetSection";
import { emptySheet, serializeSheet } from "../../lib/sheet/types";
import type { Section } from "../../lib/commands.gen";
import { t } from "../../i18n/t";

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  registerSheetTarget: vi.fn(() => () => {}),
}));

const formulaHelperMock = vi.fn(async (..._args: unknown[]) => "=SUM(B2:B3)" as string | null);
vi.mock("../../stores/runAiAction", () => ({
  runSheetFormulaHelper: (...args: unknown[]) => formulaHelperMock(...args),
}));

vi.mock("../../stores/notes", () => {
  const storeState = {
    updateSectionBody: vi.fn(),
    activeNote: null,
  };
  const mockHook = vi.fn((selector) => (selector ? selector(storeState) : storeState));
  (mockHook as any).getState = () => storeState;
  (mockHook as any).setState = vi.fn();
  return { useNotesStore: mockHook };
});

describe("SheetSection component", () => {
  const dummySection: Section = {
    id: "sec-1",
    name: "My Sheet",
    kind: "sheet",
    body_md: serializeSheet(emptySheet()),
    position: 0,
  };


  beforeEach(() => {
    formulaHelperMock.mockClear();
  });

  it("renders toolbar, formula bar, and grid", () => {
    render(<SheetSection section={dummySection} />);
    expect(screen.getByTestId("sheet-section")).toBeDefined();
    expect(screen.getByText("fx")).toBeDefined();
  });

  // 수식 도우미: `=` 뒤 자연어 + Ctrl+Enter → 제안이 편집칸에 들어오되 커밋은 사용자 Enter 몫.
  it("수식 바에서 Ctrl+Enter 는 도우미를 부르고 편집칸만 채운다 (커밋 없음)", async () => {
    render(<SheetSection section={dummySection} />);
    const input = document.querySelector(".sheet-formula-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "=이번 달 금액 합계" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(input.value).toBe("=SUM(B2:B3)"));
    expect(formulaHelperMock).toHaveBeenCalledTimes(1);
    expect(formulaHelperMock.mock.calls[0][0]).toMatchObject({
      targetRef: "A1",
      request: "=이번 달 금액 합계",
      sectionId: "sec-1",
    });

    // 편집 오버레이가 그대로 살아 있다 = 셀이 커밋되지 않았다.
    const overlay = document.querySelector("textarea.sheet-cell-input-overlay") as HTMLTextAreaElement;
    expect(overlay).not.toBeNull();
    expect(overlay.value).toBe("=SUM(B2:B3)");
  });

  it("그냥 Enter 는 도우미를 부르지 않는다 (평소대로 커밋)", () => {
    render(<SheetSection section={dummySection} />);
    const input = document.querySelector(".sheet-formula-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "=SUM(A1:A2)" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(formulaHelperMock).not.toHaveBeenCalled();
    expect(document.querySelector("textarea.sheet-cell-input-overlay")).toBeNull();
  });

  // 2026-08-19 실기 QA 에서 잡힌 버그: 셀에 바로 타이핑하면 첫 글자가 두 번 들어갔다("z" → "zz",
  // "=SUM(A1:A2)" → "==SUM(...)" 으로 수식 자체가 깨짐). 편집 시작 분기가 preventDefault 를 하지
  // 않아, 같은 키가 초깃값으로 한 번 + 다음 렌더에 뜬 오버레이 input 에 네이티브로 또 한 번 들어갔다.
  it("셀에서 바로 타이핑하면 그 글자가 정확히 한 번만 들어간다(기본 동작 차단)", () => {
    const { container } = render(<SheetSection section={dummySection} />);
    const grid = container.querySelector(".sheet-grid-container") as HTMLElement;
    const firstCell = container.querySelector(".sheet-cell") as HTMLElement;
    fireEvent.mouseDown(firstCell);

    const notPrevented = fireEvent.keyDown(grid, { key: "z" });
    expect(notPrevented).toBe(false); // preventDefault 됨 = 네이티브 입력이 겹치지 않는다

    const input = container.querySelector("textarea.sheet-cell-input-overlay") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("z");
  });

  it("상태줄 우측에 cheatsheet-toggle 이 존재하고 기본 상태에서는 인라인 힌트가 노출되지 않는다", () => {
    render(<SheetSection section={dummySection} />);
    const statusbar = document.querySelector(".sheet-footer-info.section-statusbar") as HTMLElement;
    expect(statusbar).not.toBeNull();

    const toggle = statusbar.querySelector('[data-testid="cheatsheet-toggle"]');
    expect(toggle).not.toBeNull();

    // 기본 상태에서는 인라인 힌트 텍스트가 노출되지 않음 (팝오버 내부로 들어감)
    expect(screen.queryByTestId("cheatsheet-panel")).toBeNull();
    expect(statusbar.textContent).not.toContain(t("editor.sheet_heading_edit"));
    expect(statusbar.textContent).not.toContain(t("editor.sheet_cheat1_desc"));
    expect(statusbar.textContent).not.toContain(t("editor.sheet_cheat2_desc"));

    // 클릭 시 팝오버가 열리고 3개 구획 제목 및 힌트 텍스트·키가 노출됨
    fireEvent.click(toggle!);
    const panel = screen.getByTestId("cheatsheet-panel");
    expect(panel).not.toBeNull();

    // 3개 구획 제목
    expect(panel.textContent).toContain(t("editor.sheet_heading_edit"));
    expect(panel.textContent).toContain(t("editor.sheet_heading_nav"));
    expect(panel.textContent).toContain(t("editor.sheet_heading_table"));

    // 대표 항목 및 키들
    expect(panel.textContent).toContain(t("editor.sheet_cheat1_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_type_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_clear_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat2_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_arrows_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_copy_paste_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_undo_redo_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_rclick_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_colhead_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_colresize_desc"));
    expect(panel.textContent).toContain(t("editor.sheet_cheat_fill_desc"));
    expect(panel.textContent).toContain("F2");
    expect(panel.textContent).toContain("Tab");
    expect(panel.textContent).toContain("←↑→↓");
  });
});

