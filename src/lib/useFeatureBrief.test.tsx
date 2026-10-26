import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../stores/settings";
import { useFeatureBriefStore } from "../stores/featureBrief";
import { useFeatureBriefTrigger, useSeedFeatureBriefsOnce } from "./useFeatureBrief";
import { FEATURE_BRIEF_SEED_SENTINEL } from "./featureBriefs";

const callMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

function TriggerHarness({ briefId }: { briefId: string }) {
  const notify = useFeatureBriefTrigger();
  return (
    <button data-testid="fire" onClick={() => notify(briefId, false, true)}>
      fire
    </button>
  );
}

function SeedHarness() {
  useSeedFeatureBriefsOnce();
  return null;
}

// PLAN-2026-08-30 §4 W7 — 트리거 훅은 "모든 호출자가 지나가는 한 곳"이다. 여기서 그 판단 로직
// (OFF→ON만, 이미 본 건 다시 안 뜸, 모르는 id는 무시)을 실제 트리거 지점(AiPermissionsSection 등)
// UI 없이 직접 검증한다.
describe("useFeatureBriefTrigger", () => {
  beforeEach(() => {
    callMock.mockReset();
    useSettingsStore.setState({ seenFeatureBriefs: [], loaded: true } as any);
    useFeatureBriefStore.setState({ activeId: null, mode: "read" });
  });

  it("OFF→ON 전환에서 처음 보는 브리핑을 온보딩 모드로 연다", async () => {
    render(<TriggerHarness briefId="ai_master" />);
    await userEvent.click(screen.getByTestId("fire"));

    expect(useFeatureBriefStore.getState().activeId).toBe("ai_master");
    expect(useFeatureBriefStore.getState().mode).toBe("onboarding");
    expect(useSettingsStore.getState().seenFeatureBriefs).toContain("ai_master");
  });

  it("이미 본 브리핑은 다시 열지 않는다", async () => {
    useSettingsStore.setState({ seenFeatureBriefs: ["ai_master"] } as any);
    render(<TriggerHarness briefId="ai_master" />);
    await userEvent.click(screen.getByTestId("fire"));

    expect(useFeatureBriefStore.getState().activeId).toBeNull();
  });

  it("이 웨이브가 모르는 id는 조용히 무시한다", async () => {
    render(<TriggerHarness briefId="not_a_real_brief" />);
    await userEvent.click(screen.getByTestId("fire"));

    expect(useFeatureBriefStore.getState().activeId).toBeNull();
    expect(useSettingsStore.getState().seenFeatureBriefs).not.toContain("not_a_real_brief");
  });

  it("OFF→ON이 아니면(끄거나, 이미 켜져 있던 경우) 무시한다", async () => {
    function OffHarness() {
      const notify = useFeatureBriefTrigger();
      return (
        <>
          <button data-testid="turn-off" onClick={() => notify("ai_master", true, false)}>
            off
          </button>
          <button data-testid="already-on" onClick={() => notify("ai_master", true, true)}>
            already-on
          </button>
        </>
      );
    }
    render(<OffHarness />);
    await userEvent.click(screen.getByTestId("turn-off"));
    await userEvent.click(screen.getByTestId("already-on"));

    expect(useFeatureBriefStore.getState().activeId).toBeNull();
  });
});

// 소급 금지 시딩 — 정확히 한 번만(sentinel), 이미 ON인 기능은 seen으로 채워 넣어 이후 진짜
// OFF→ON 전환에서만 브리핑이 뜨게 한다.
describe("useSeedFeatureBriefsOnce", () => {
  beforeEach(() => {
    callMock.mockReset();
    useFeatureBriefStore.setState({ activeId: null, mode: "read" });
  });

  it("loaded 전환 시 현재 ON인 기능들을 seen에 소급 시딩하고 sentinel을 심는다", async () => {
    callMock.mockResolvedValue({
      settings: {
        sync_enabled: true,
        capture_clip_enabled: "0",
        capture_visits_enabled: "0",
        capture_ledger_enabled: "1",
      },
    });
    useSettingsStore.setState({
      loaded: true,
      seenFeatureBriefs: [],
      aiEnabled: true,
      aiPostProcess: false,
      linkSuggestions: false,
      aiChatMemory: true,
    } as any);

    render(<SeedHarness />);

    await waitFor(() => {
      expect(useSettingsStore.getState().seenFeatureBriefs).toContain(FEATURE_BRIEF_SEED_SENTINEL);
    });

    const seen = useSettingsStore.getState().seenFeatureBriefs;
    // ON이었던 것들(aiEnabled/aiChatMemory/sync_enabled/ledger 채널)만 소급 시딩된다.
    expect(seen).toEqual(expect.arrayContaining(["ai_master", "ai_chat_memory", "sync_server", "capture_channel"]));
    // OFF였던 것들은 시딩되지 않는다 — 다음에 진짜로 켜면 브리핑이 뜬다.
    expect(seen).not.toContain("ai_post_process");
    expect(seen).not.toContain("link_suggestions");
  });

  it("sentinel이 이미 있으면 IPC를 다시 부르지 않는다(매 설정 창 오픈마다 반복되지 않음)", () => {
    useSettingsStore.setState({
      loaded: true,
      seenFeatureBriefs: [FEATURE_BRIEF_SEED_SENTINEL],
    } as any);

    render(<SeedHarness />);

    expect(callMock).not.toHaveBeenCalled();
  });
});
