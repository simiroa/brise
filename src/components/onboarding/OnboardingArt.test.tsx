import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { WelcomeArt, SpaceArt, DataArt, RegionArt, AiArt, ConnectArt, ImportArt } from "./OnboardingArt";
import { useSettingsStore } from "../../stores/settings";

// PLAN-2026-09-28 §3 — 여섯 그림 모두 장식용(aria-hidden) SVG를 담고 있는지만 확인한다(AiArt는
// 실제 AI 보더빔 때문에 루트가 <div>고 그 안에 SVG가 있다 — querySelector("svg")는 그대로 찾는다).
// 실제 색·모션은 CSS 담당이라 jsdom에서 의미 있게 검증되지 않는다.
describe("OnboardingArt", () => {
  const cases: Array<[string, () => React.ReactElement]> = [
    ["WelcomeArt", () => <WelcomeArt />],
    ["SpaceArt", () => <SpaceArt />],
    ["DataArt", () => <DataArt />],
    ["RegionArt", () => <RegionArt />],
    ["AiArt", () => <AiArt />],
    ["ConnectArt", () => <ConnectArt />],
    ["ImportArt", () => <ImportArt />],
  ];

  for (const [name, Component] of cases) {
    it(`${name}는 aria-hidden svg를 렌더한다`, () => {
      const { container } = render(Component());
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      expect(svg?.getAttribute("viewBox")).toBeTruthy();
    });
  }

  // 2026-09-28 리워크 — 각 그림의 클라이맥스 비트 클래스가 최소 하나는 남아 있는지 확인한다.
  // 앞으로 누군가 손대다 모션 클래스를 통째로 지워도(빈 <g> 등) 여기서 걸린다. 실제 모션(타이밍·
  // 이징)은 onboarding.css 가 담당하고 jsdom 에선 검증되지 않으므로, 클래스 존재만 본다.
  const animatedClassCases: Array<[string, () => React.ReactElement, string]> = [
    ["WelcomeArt", () => <WelcomeArt />, "ob-w-mascot"],
    ["SpaceArt", () => <SpaceArt />, "ob-sp-bookmark"],
    ["DataArt", () => <DataArt />, "ob-dt-folder"],
    ["RegionArt", () => <RegionArt />, "ob-rg-pin"],
    ["AiArt", () => <AiArt />, "ob-ai-stamp"],
    ["ConnectArt", () => <ConnectArt />, "ob-cn-shackle"],
    ["ImportArt", () => <ImportArt />, "ob-im-notebook"],
  ];
  for (const [name, Component, className] of animatedClassCases) {
    it(`${name}는 클라이맥스 비트 클래스(.${className})를 갖는다`, () => {
      const { container } = render(Component());
      expect(container.querySelector(`.${className}`)).not.toBeNull();
    });
  }

  // 2026-09-29 — AiArt는 노트 카드에 실제 AI 보더빔 신호(tokens.css AI-GLOW › BEAM)를 걸어야 한다.
  it("AiArt는 data-ai-glow-beam=true 를 가진 요소를 포함한다", () => {
    const { container } = render(<AiArt />);
    const beamHost = container.querySelector('[data-ai-glow-beam="true"]');
    expect(beamHost).not.toBeNull();
    expect(beamHost?.getAttribute("data-ai-glow")).toBe("active");
  });

  // 2026-09-29 — SpaceArt는 현재 표면 스타일(아크릴/플랫)을 실시간으로 반영해야 한다. 아크릴에서만
  // 창 자리의 흐린 배경 복사본(.ob-sp-blurbg, 정적 blur 필터)이 존재한다.
  describe("SpaceArt", () => {
    afterEach(() => {
      useSettingsStore.setState({ surfaceStyle: "flat" });
    });

    it("아크릴이면 창 자리에 흐린 배경 레이어가 있다", () => {
      useSettingsStore.setState({ surfaceStyle: "acrylic" });
      const { container } = render(<SpaceArt />);
      expect(container.querySelector(".ob-sp-blurbg")).not.toBeNull();
    });

    it("플랫이면 흐린 배경 레이어가 없다", () => {
      useSettingsStore.setState({ surfaceStyle: "flat" });
      const { container } = render(<SpaceArt />);
      expect(container.querySelector(".ob-sp-blurbg")).toBeNull();
    });
  });
});

// jsdom 은 onboarding.css 를 적용하지 않아 렌더 테스트로는 못 잡는다 — .ob-setup-row 의 display:flex
// 가 [hidden] 을 덮어 설정 네 쪽이 한 화면에 다 보였던 회귀(2026-09-28)를 CSS 원문으로 막는다.
describe("onboarding.css", () => {
  it("setup pages hidden via the hidden attribute stay hidden despite display:flex", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "onboarding.css"), "utf-8");
    expect(css).toMatch(/\.ob-setup-row\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });
});
