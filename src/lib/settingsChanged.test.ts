import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// "settings-changed" 핸들러를 직접 잡는다 — listenMany 가 Tauri listen() 을 부르는 자리.
let handler: ((e?: { payload?: unknown }) => void) | null = null;
vi.mock("./tauriListen", () => ({
  listenMany: (specs: ReadonlyArray<readonly [string, (e?: { payload?: unknown }) => void]>) => {
    for (const [event, h] of specs) if (event === "settings-changed") handler = h;
    return () => {
      handler = null;
    };
  },
}));
vi.mock("./env", () => ({ isBrowser: () => false }));

import { listenSettingsChanged } from "./settingsChanged";
import { useSettingsStore } from "../stores/settings";
import { useAiPresetsStore } from "../stores/aiPresets";
import { useAiInstructionsStore } from "../stores/aiInstructions";

const keysEvent = (...keys: string[]) => ({ payload: { keys } });

describe("listenSettingsChanged", () => {
  let settingsLoad: ReturnType<typeof vi.fn>;
  let presetsLoad: ReturnType<typeof vi.fn>;
  let instructionsLoad: ReturnType<typeof vi.fn>;
  const origSettingsLoad = useSettingsStore.getState().load;
  const origPresets = { load: useAiPresetsStore.getState().load, loaded: useAiPresetsStore.getState().loaded };
  const origInstructions = {
    load: useAiInstructionsStore.getState().load,
    loaded: useAiInstructionsStore.getState().loaded,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    settingsLoad = vi.fn(async () => {});
    presetsLoad = vi.fn(async () => {});
    instructionsLoad = vi.fn(async () => {});
    useSettingsStore.setState({ load: settingsLoad } as never);
    useAiPresetsStore.setState({ load: presetsLoad } as never);
    useAiInstructionsStore.setState({ load: instructionsLoad } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({ load: origSettingsLoad } as never);
    useAiPresetsStore.setState(origPresets as never);
    useAiInstructionsStore.setState(origInstructions as never);
  });

  // 2026-09-27: 설정 창의 「AI 프리셋」 페이지에서 고친 것이 본 창 AI 모달 타일에 닿아야 한다 —
  // 프리셋은 설정 스토어가 아니라 자기 스토어에 있어서, 예전엔 창을 다시 열기 전까지 옛 목록이었다.
  it("reloads AI presets too (debounced), but only in a window that has already loaded them", () => {
    useAiPresetsStore.setState({ loaded: true } as never);
    const stop = listenSettingsChanged();
    handler!();
    handler!();
    expect(presetsLoad).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    expect(presetsLoad).toHaveBeenCalledTimes(1);
    stop();
  });

  it("skips the preset store in a window that never read it", () => {
    useAiPresetsStore.setState({ loaded: false } as never);
    const stop = listenSettingsChanged();
    handler!();
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    expect(presetsLoad).not.toHaveBeenCalled();
    stop();
  });

  // 2026-10-22: 노트를 열 때마다 나가는 탭 저장(open_tabs/active_tab_id)의 메아리가 모든 창에서
  // settings_get_all 전체 재조회를 돌렸다 — 본 창만 쓰고 읽는 키뿐인 쓰기는 거른다.
  it("ignores an echo whose keys are all window-local UI state", () => {
    useAiPresetsStore.setState({ loaded: true } as never);
    const stop = listenSettingsChanged();
    handler!(keysEvent("open_tabs", "active_tab_id"));
    handler!(keysEvent("window_geometry"));
    handler!(keysEvent("left_width"));
    vi.advanceTimersByTime(1000);
    expect(settingsLoad).not.toHaveBeenCalled();
    expect(presetsLoad).not.toHaveBeenCalled();
    stop();
  });

  it("a window-local echo neither cancels nor delays a real pending change", () => {
    const stop = listenSettingsChanged();
    handler!(keysEvent("theme"));
    vi.advanceTimersByTime(150);
    handler!(keysEvent("open_tabs", "active_tab_id"));
    vi.advanceTimersByTime(60);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    stop();
  });

  it("a write mixing local and real keys still reloads once", () => {
    const stop = listenSettingsChanged();
    handler!(keysEvent("open_tabs", "accent"));
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps debouncing real changes (slider drag = one load)", () => {
    const stop = listenSettingsChanged();
    for (let i = 0; i < 5; i++) {
      handler!(keysEvent("sheet_alpha"));
      vi.advanceTimersByTime(100);
    }
    expect(settingsLoad).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reloads presets/instructions only when their own key changed", () => {
    useAiPresetsStore.setState({ loaded: true } as never);
    useAiInstructionsStore.setState({ loaded: true } as never);
    const stop = listenSettingsChanged();

    handler!(keysEvent("theme"));
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    expect(presetsLoad).not.toHaveBeenCalled();
    expect(instructionsLoad).not.toHaveBeenCalled();

    handler!(keysEvent("ai_action_presets"));
    vi.advanceTimersByTime(250);
    expect(presetsLoad).toHaveBeenCalledTimes(1);
    expect(instructionsLoad).not.toHaveBeenCalled();

    handler!(keysEvent("ai_internal_instructions"));
    vi.advanceTimersByTime(250);
    expect(presetsLoad).toHaveBeenCalledTimes(1);
    expect(instructionsLoad).toHaveBeenCalledTimes(1);
    stop();
  });

  it("falls back to a full reload when the payload carries no keys (old emitter / {} )", () => {
    useAiPresetsStore.setState({ loaded: true } as never);
    useAiInstructionsStore.setState({ loaded: true } as never);
    const stop = listenSettingsChanged();
    handler!({ payload: {} });
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    expect(presetsLoad).toHaveBeenCalledTimes(1);
    expect(instructionsLoad).toHaveBeenCalledTimes(1);
    handler!({ payload: null });
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a notebook switch reloads everything even though it also writes tab keys", () => {
    useAiPresetsStore.setState({ loaded: true } as never);
    const stop = listenSettingsChanged();
    handler!(keysEvent("active_workspace_id", "open_tabs", "active_tab_id", "recent_closed_tabs"));
    vi.advanceTimersByTime(250);
    expect(settingsLoad).toHaveBeenCalledTimes(1);
    expect(presetsLoad).toHaveBeenCalledTimes(1);
    stop();
  });
});
