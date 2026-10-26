import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsRow } from "./SettingsRow";

describe("SettingsRow", () => {
  it("renders label and control correctly", () => {
    render(
      <SettingsRow
        label="Test Label"
        control={<button>Test Control</button>}
      />
    );

    expect(screen.getByText("Test Label")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test Control" })).toBeTruthy();
  });

  it("renders hint when provided", () => {
    render(
      <SettingsRow
        label="Label"
        hint="Test Hint"
        control={<button>Control</button>}
      />
    );

    expect(screen.getByText("Test Hint")).toBeTruthy();
  });

  // PLAN-2026-09-12 §2(D2): 옵션 행 아래에는 선을 긋지 않는다. 약속은 하나다 —
  // **어떤 행도 자기 아래에 선을 만들지 않는다.** W1 이 호환용으로 남겼던 no-op `last` prop 은
  // W3 에서 타입과 호출부를 함께 지웠으므로, 이 테스트도 더는 그것을 통해 말하지 않는다
  // (prop 이 되살아나면 여기가 아니라 tsc 가 먼저 막는다).
  it.each([
    ["힌트 없음", undefined],
    ["힌트 있음", "Test Hint"],
  ])("행 아래 헤어라인을 긋지 않는다 (%s)", (_name, hint) => {
    const { container } = render(
      <SettingsRow label="Label" hint={hint} control={<button>Control</button>} />
    );

    const row = container.firstChild as HTMLElement;
    expect(row.style.borderBottom).toBe("");
    expect(row.style.borderBottomStyle).toBe("");
    const inline = row.getAttribute("style") ?? "";
    expect(inline).not.toContain("var(--line)");
    // `border*` 선언 자체가 없다. (값으로 등장하는 box-sizing: border-box 는 걸리지 않게
    // 속성 시작 위치로만 본다.)
    expect(inline).not.toMatch(/(?:^|;)\s*border[a-z-]*\s*:/);
  });

  it("applies opacity and disabled reason when disabled is true", () => {
    render(
      <SettingsRow
        label="Label"
        control={<button>Control</button>}
        disabled
        disabledReason="Disabled Reason"
        data-testid="settings-row"
      />
    );

    const row = screen.getByTestId("settings-row");
    expect(row.style.opacity).toBe("var(--dim-disabled)");
    expect(row.getAttribute("title")).toBe("Disabled Reason");
    expect(row.getAttribute("data-disabled-reason")).toBe("Disabled Reason");
    expect(row.getAttribute("aria-disabled")).toBe("true");
  });

  // 꺼진 행은 흐리기만 하고 조작은 되던 시절이 있었다 — 이제 컨트롤 영역 전체가 inert 다.
  // (jsdom 은 inert 를 집행하지 않으므로 속성으로 계약을 본다.)
  it("disabled 면 컨트롤 영역이 inert 이고, 이유는 inert 밖에서 aria-describedby 로 이어진다", () => {
    render(
      <SettingsRow
        label="Label"
        control={<button>Control</button>}
        disabled
        disabledReason="Briefing is off"
        data-testid="settings-row"
      />
    );

    const row = screen.getByTestId("settings-row");
    const control = screen.getByText("Control");
    const area = control.closest("[data-settings-row-control]") as HTMLElement;
    expect(area.hasAttribute("inert")).toBe(true);

    const describedBy = row.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!);
    expect(reason?.textContent).toBe("Briefing is off");
    // 이유 문구가 inert 영역 안에 있으면 접근성 트리에서 함께 사라진다.
    expect(area.contains(reason)).toBe(false);
  });

  it("disabled 가 아니면 inert·describedby 를 달지 않는다", () => {
    render(
      <SettingsRow label="Label" control={<button>Control</button>} disabledReason="unused" data-testid="settings-row" />
    );

    const row = screen.getByTestId("settings-row");
    expect(row.hasAttribute("aria-describedby")).toBe(false);
    expect(row.hasAttribute("title")).toBe(false);
    expect(screen.getByText("Control").closest("[data-settings-row-control]")!.hasAttribute("inert")).toBe(false);
  });

  it("anchor 는 행 루트의 id(settings-anchor-<name>)가 된다 — 설정 검색·딥링크의 스크롤 대상", () => {
    render(<SettingsRow label="Label" control={<button>Control</button>} anchor="demo_row" data-testid="settings-row" />);
    expect(screen.getByTestId("settings-row").id).toBe("settings-anchor-demo_row");
  });

  it("anchor 가 없으면 id 를 달지 않는다", () => {
    render(<SettingsRow label="Label" control={<button>Control</button>} data-testid="settings-row" />);
    expect(screen.getByTestId("settings-row").hasAttribute("id")).toBe(false);
  });
});
