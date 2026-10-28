import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SwitchGrid, type SwitchGridItem } from "./SwitchGrid";

function items(overrides: Partial<SwitchGridItem>[] = []): SwitchGridItem[] {
  const base: SwitchGridItem[] = [
    { id: "a", label: "가", checked: true, onChange: () => {} },
    { id: "b", label: "나", checked: false, onChange: () => {} },
    { id: "c", label: "다", checked: false, onChange: () => {} },
  ];
  return base.map((it, i) => ({ ...it, ...(overrides[i] ?? {}) }));
}

describe("SwitchGrid (PLAN-2026-09-12 §3, D3)", () => {
  // 2026-10-27 설정 디자인 개편: 좌우 2단을 없앴다 — 항상 한 열(라벨 | 컨트롤 한 줄)이다.
  it("한 열로 쌓이고 열 규칙(grid)이 없다", () => {
    render(<SwitchGrid items={items()} aria-label="스위치 묶음" />);

    const grid = screen.getByTestId("switch-grid");
    expect(grid.style.display).toBe("flex");
    expect(grid.style.flexDirection).toBe("column");
    expect(grid.style.gridTemplateColumns).toBe("");
  });

  it("그리드는 role=group + aria-label 이고 각 토글은 자기 라벨로 불린다", () => {
    render(<SwitchGrid items={items()} aria-label="스위치 묶음" />);

    expect(screen.getByRole("group", { name: "스위치 묶음" })).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.getByRole("switch", { name: "가" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "나" }).getAttribute("aria-checked")).toBe("false");
  });

  it("라벨이 문자열이 아니면 ariaLabel 이 접근 이름을 맡는다", () => {
    render(
      <SwitchGrid
        items={items([{ label: <strong>가</strong>, ariaLabel: "가 토글" }])}
        aria-label="스위치 묶음"
      />
    );

    expect(screen.getByRole("switch", { name: "가 토글" })).toBeTruthy();
  });

  it("토글을 누르면 그 항목의 onChange 만 반대값으로 불린다", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    render(<SwitchGrid items={items([{ onChange: onA }, { onChange: onB }])} aria-label="스위치 묶음" />);

    fireEvent.click(screen.getByTestId("switch-grid-toggle-a"));
    expect(onA).toHaveBeenCalledWith(false); // a 는 checked=true 였다
    expect(onB).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("switch-grid-toggle-b"));
    expect(onB).toHaveBeenCalledWith(true);
  });

  // DESIGN.md 규칙 ④ — 사유는 title 툴팁으로만, 표현은 셀 전체 opacity 로.
  it("disabled 셀은 행 전체를 dim 하고 사유를 title 로만 준다", () => {
    const onA = vi.fn();
    render(
      <SwitchGrid
        items={items([{ disabled: true, disabledReason: "AI 가 꺼져 있습니다", onChange: onA }])}
        aria-label="스위치 묶음"
      />
    );

    const cell = screen.getByTestId("switch-grid-cell-a");
    expect(cell.style.opacity).toBe("var(--dim-disabled)");
    expect(cell.getAttribute("title")).toBe("AI 가 꺼져 있습니다");
    expect(cell.getAttribute("aria-disabled")).toBe("true");
    // 사유는 화면 텍스트로 상주하지 않는다 — SettingsRow 로 통일하면서 보조기술용 화면 밖 노드(aria-describedby)로만 남는다(2026-10-28 C4).
    const reasonNode = document.getElementById(cell.getAttribute("aria-describedby") ?? "");
    expect(reasonNode?.textContent).toBe("AI 가 꺼져 있습니다");
    expect(reasonNode?.style.clip).toBe("rect(0px, 0px, 0px, 0px)");
    expect(cell.querySelector("[data-settings-row-control]")?.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByTestId("switch-grid-toggle-a"));
    expect(onA).not.toHaveBeenCalled();
  });

  it("힌트는 SettingsRow 와 같은 ⓘ 뱃지 한 벌을 쓴다", () => {
    render(<SwitchGrid items={items([{ hint: "한 줄 힌트" }])} aria-label="스위치 묶음" />);

    expect(screen.getByLabelText("한 줄 힌트")).toBeTruthy();
  });

  // 2026-10-18 화면 보드(31-settings-ai_chat · ai_permissions): 2열 셀에서 "사용자 폴더와 파일을 봅니다" 가
  // nowrap + ellipsis 로 "…봅…" 까지 잘렸다. 라벨은 줄바꿈해야 한다 — 폭 계산은 jsdom 이 못 하니 스타일로 본다.
  it("라벨은 한 줄 말줄임으로 자르지 않고 줄바꿈한다", () => {
    render(<SwitchGrid items={items([{ label: "사용자 폴더와 파일을 봅니다" }])} aria-label="스위치 묶음" />);

    const text = screen.getByText("사용자 폴더와 파일을 봅니다");
    expect(text.style.whiteSpace).not.toBe("nowrap");
    expect(text.style.textOverflow).toBe("");
    expect(text.style.overflow).not.toBe("hidden");
    expect(text.style.wordBreak).toBe("keep-all");
  });

  // 셀 안에서 토글은 라벨 **바로 뒤**에 붙는다(우측 정렬 금지) — 라벨이 남은 폭을 다 먹으면
  // 토글이 오른쪽 끝으로 밀려 그 계약이 깨진다.
  it("셀은 SettingsRow 와 같은 한 줄 — 라벨이 늘어나 토글이 오른쪽 끝에 선다 (2026-10-27)", () => {
    render(<SwitchGrid items={items()} aria-label="스위치 묶음" />);

    const cell = screen.getByTestId("switch-grid-cell-a");
    expect(cell.style.justifyContent).toBe("space-between");
    const label = cell.firstElementChild as HTMLElement;
    expect(label.style.flex).toContain("1");
  });
});
