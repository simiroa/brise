import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useFeatureBriefStore } from "../../stores/featureBrief";
import { FeatureBriefModal } from "./FeatureBriefModal";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
}));

// PLAN-2026-08-30 §4 W7 — 두 모드가 같은 문구를 그리되 액션만 다르다는 계약을 확인한다.
describe("FeatureBriefModal", () => {
  beforeEach(() => {
    useSettingsStore.setState({ seenFeatureBriefs: [], uiLang: "ko" } as any);
    useFeatureBriefStore.setState({ activeId: null, mode: "read" });
  });

  it("activeId가 없으면 아무 것도 그리지 않는다", () => {
    render(<FeatureBriefModal />);
    expect(screen.queryByTestId("modal-shell")).toBeNull();
  });

  it("모르는 id면 아무 것도 그리지 않는다(방어적 no-op)", () => {
    useFeatureBriefStore.setState({ activeId: "not_a_real_brief", mode: "read" });
    render(<FeatureBriefModal />);
    expect(screen.queryByTestId("modal-shell")).toBeNull();
  });

  it("온보딩 모드: [알겠습니다] + [사용법 자세히보기] + 외부 링크를 보여준다", async () => {
    useFeatureBriefStore.setState({ activeId: "ai_master", mode: "onboarding" });
    render(<FeatureBriefModal />);

    expect(screen.getByTestId("feature-brief-modal-ai_master")).toBeTruthy();
    expect(screen.getByTestId("feature-brief-ack")).toBeTruthy();
    expect(screen.getByTestId("feature-brief-learn-more")).toBeTruthy();
    expect(screen.getByTestId("feature-brief-external-link-0")).toBeTruthy();
    expect(screen.queryByTestId("feature-brief-close")).toBeNull();

    // 사용법 자세히보기는 외부 링크가 아니라 인라인 확장이다.
    expect(screen.queryByTestId("feature-brief-learn-more-body")).toBeNull();
    await userEvent.click(screen.getByTestId("feature-brief-learn-more"));
    expect(screen.getByTestId("feature-brief-learn-more-body")).toBeTruthy();
  });

  it("[알겠습니다]를 누르면 닫힌다", async () => {
    useFeatureBriefStore.setState({ activeId: "ai_master", mode: "onboarding" });
    render(<FeatureBriefModal />);

    await userEvent.click(screen.getByTestId("feature-brief-ack"));
    expect(useFeatureBriefStore.getState().activeId).toBeNull();
  });

  it("읽기 모드: [닫기]만 있고, 열어도 seenFeatureBriefs를 건드리지 않는다", () => {
    useFeatureBriefStore.setState({ activeId: "ai_post_process", mode: "read" });
    render(<FeatureBriefModal />);

    expect(screen.getByTestId("feature-brief-close")).toBeTruthy();
    expect(screen.queryByTestId("feature-brief-ack")).toBeNull();
    expect(screen.queryByTestId("feature-brief-learn-more")).toBeNull();
    // 읽기 모드는 카탈로그 "자세히 ▸"에서 직접 여는 경로라 트리거 훅(seen 갱신)을 타지 않는다.
    expect(useSettingsStore.getState().seenFeatureBriefs).not.toContain("ai_post_process");
  });

  it("읽기 모드에서 온보딩 모드와 같은 titleKey/bodyKey 문구를 보여준다(문구 이원화 금지)", () => {
    useFeatureBriefStore.setState({ activeId: "ai_post_process", mode: "read" });
    const { unmount } = render(<FeatureBriefModal />);
    const readBody = screen.getByTestId("feature-brief-modal-ai_post_process").textContent;
    unmount();

    useFeatureBriefStore.setState({ activeId: "ai_post_process", mode: "onboarding" });
    render(<FeatureBriefModal />);
    const onboardingBody = screen.getByTestId("feature-brief-modal-ai_post_process").textContent;

    expect(readBody).toBe(onboardingBody);
  });
});
