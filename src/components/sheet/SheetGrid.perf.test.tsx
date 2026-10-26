// 시트 그리드의 성능 계약 두 줄을 회귀로 고정한다.
//
//   1. DOM 에는 보이는 칸 + 오버스캔만 있다 (100×26 = 2,600 셀을 통째로 그리지 않는다).
//   2. 편집 중 타건 한 번은 그리드를 **한 번도** 다시 그리지 않는다.
//
// 개선 전(2026-08-19 측정, jsdom): 마운트 478ms · td 2,600개 · 타건당 80.8ms.
// 이 파일은 그 회귀를 막는 게 목적이지 벤치마크가 아니다 — ms 는 콘솔로만 남긴다
// (CI 머신 편차가 커서 시간에 단언을 걸면 플레이키해진다).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { SheetSection } from "./SheetSection";
import { resetSheetCellRenderCount, sheetCellRenderCount } from "./SheetGrid";
import { emptySheet, serializeSheet, type SheetDoc } from "../../lib/sheet/types";
import type { Section } from "../../lib/commands.gen";

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  registerSheetTarget: vi.fn(() => () => {}),
}));

vi.mock("../../stores/runAiAction", () => ({
  runSheetFormulaHelper: vi.fn(async () => null),
}));

vi.mock("../../stores/notes", () => {
  // SheetSection 이 훅으로도 읽는다(차트 카드 "첨부에 등록" 버튼, W4) — 호출 가능한 목이어야 한다.
  const storeState = { updateSectionBody: vi.fn(), activeNote: null };
  const mockHook = vi.fn((selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState));
  (mockHook as unknown as { getState: () => typeof storeState }).getState = () => storeState;
  (mockHook as unknown as { setState: () => void }).setState = vi.fn();
  return { useNotesStore: mockHook };
});

/** 100행 × 26열 — 데이터 20행 + 합계 수식 1개(가계부 프리셋과 같은 모양). */
function ledgerDoc(): SheetDoc {
  const doc = emptySheet();
  doc.cells.A1 = { raw: "날짜" };
  doc.cells.B1 = { raw: "금액" };
  for (let r = 2; r <= 21; r++) {
    doc.cells[`A${r}`] = { raw: `2026-08-${String(r).padStart(2, "0")}` };
    doc.cells[`B${r}`] = { raw: String(r * 1000) };
  }
  doc.cells.B22 = { raw: "=SUM(B2:B21)" };
  doc.cols[0] = { fmt: "date" };
  doc.cols[1] = { fmt: "currency" };
  return doc;
}

const section: Section = {
  id: "sec-perf",
  name: "가계부",
  kind: "sheet",
  body_md: serializeSheet(ledgerDoc()),
  position: 0,
};

describe("SheetGrid 성능 계약", () => {
  it("100×26 문서에서도 보이는 칸만 DOM 에 있다", () => {
    expect(Object.keys(ledgerDoc().cells).length).toBe(43); // 헤더 2 + 데이터 40 + 합계 1

    const t0 = performance.now();
    const { container } = render(<SheetSection section={section} />);
    const mountMs = performance.now() - t0;

    const cells = container.querySelectorAll(".sheet-cell");
    // 800×400 뷰포트(jsdom 폴백) = 열 약 9 + 행 약 16, 오버스캔 2 → 넉넉히 잡아도 600 아래.
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(600);
    // 가상화 없이 그리면 2,600개다. 그 근처면 회귀.
    expect(cells.length).toBeLessThan(26 * 100);

    // eslint-disable-next-line no-console
    console.log(`[perf] mount=${mountMs.toFixed(0)}ms cells=${cells.length}`);
  });

  it("편집 중 타건은 그리드를 다시 그리지 않는다", () => {
    const { container } = render(<SheetSection section={section} />);

    const firstCell = container.querySelector(".sheet-cell") as HTMLElement;
    fireEvent.doubleClick(firstCell);
    const input = container.querySelector("textarea.sheet-cell-input-overlay") as HTMLTextAreaElement;
    expect(input).not.toBeNull();

    // 편집 진입까지의 렌더는 계약 밖 — 여기서부터 센다.
    resetSheetCellRenderCount();

    let text = "";
    const t0 = performance.now();
    for (const ch of "1234567890") {
      text += ch;
      fireEvent.change(input, { target: { value: text } });
    }
    const perKeystrokeMs = (performance.now() - t0) / 10;

    // 셀 컴포넌트 본문이 단 한 번도 돌지 않아야 한다 = 손대지 않은 칸은 전부 그대로.
    expect(sheetCellRenderCount()).toBe(0);
    // 글자는 오버레이와 수식 입력줄에만 반영된다.
    expect(input.value).toBe("1234567890");
    expect((container.querySelector(".sheet-formula-input") as HTMLInputElement).value).toBe("1234567890");

    // eslint-disable-next-line no-console
    console.log(`[perf] perKeystroke=${perKeystrokeMs.toFixed(2)}ms (개선 전 80.8ms)`);
  });

  it("커밋하면 값이 반영되고 그때는 다시 그린다", () => {
    const { container } = render(<SheetSection section={section} />);

    const firstCell = container.querySelector(".sheet-cell") as HTMLElement;
    fireEvent.doubleClick(firstCell);
    const input = container.querySelector("textarea.sheet-cell-input-overlay") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "머리핀" } });

    resetSheetCellRenderCount();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sheetCellRenderCount()).toBeGreaterThan(0);
    expect(container.querySelector("textarea.sheet-cell-input-overlay")).toBeNull();
    expect(firstCell.textContent).toBe("머리핀");
  });
});
