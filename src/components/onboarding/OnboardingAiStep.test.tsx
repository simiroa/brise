import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { OnboardingAiStep } from "./OnboardingAiStep";

const callMock = vi.fn().mockResolvedValue(undefined);
const callSilentMock = vi.fn().mockResolvedValue({ settings: {} });
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

/** settings_set 은 통과, ai_test_connection_before_enable 은 주어진 결과로 응답. 프로바이더 전환
 *  (lib/aiProviderSwitch)이 쓰기 전에 settings_get_all 로 지금 값을 읽으므로 그것도 응답한다. */
function routeCalls(test: () => Promise<unknown>, stored: Record<string, unknown> = {}) {
  callMock.mockImplementation((cmd: string) =>
    cmd === "ai_test_connection_before_enable"
      ? test()
      : cmd === "settings_get_all"
        ? Promise.resolve({ settings: stored })
        : Promise.resolve(undefined),
  );
}

/** 로컬(Ollama) 시나리오: settings_get_all 이 저장된 ai_model 을 돌려주고, 테스트는 모델 목록으로 응답. */
function routeLocalCalls(models: string[], savedModel?: string) {
  callSilentMock.mockResolvedValue({ settings: { ai_provider: "ollama", ai_model: savedModel ?? "" } });
  callMock.mockImplementation((cmd: string) =>
    cmd === "ai_test_connection_before_enable"
      ? Promise.resolve({ ok: true, latency_ms: 5, models })
      : cmd === "settings_get_all"
        ? Promise.resolve({ settings: { ai_provider: "ollama", ai_model: savedModel ?? "" } })
        : Promise.resolve(undefined),
  );
}

function baseProps() {
  return { onAdopted: vi.fn(), onAdoptReady: vi.fn() };
}

/** 셸(하단 주 버튼)에 마지막으로 올라온 "켜기" 함수 — 켤 수 없는 상태면 null. */
function lastAdopt(props: ReturnType<typeof baseProps>): (() => Promise<boolean>) | null {
  const calls = props.onAdoptReady.mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as (() => Promise<boolean>) | null) : null;
}

describe("OnboardingAiStep", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue(undefined);
    callSilentMock.mockClear();
    callSilentMock.mockResolvedValue({ settings: {} });
    useAiStore.setState({ availableModels: [] } as any);
  });

  it("typing an API key saves nothing (no extra IPC beyond the initial background fetch)", async () => {
    render(<OnboardingAiStep {...baseProps()} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));
    callMock.mockClear();

    await userEvent.type(screen.getByTestId("onboarding-ai-key-input"), "sk-test-key");

    expect(callMock).not.toHaveBeenCalled();
  });

  it("pressing the test button applies the provider/key settings, then tests", async () => {
    routeCalls(() => Promise.resolve({ ok: true, latency_ms: 12 }));
    render(<OnboardingAiStep {...baseProps()} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByTestId("onboarding-ai-key-input"), "sk-test-key");
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));

    // 전환은 한 배치: 새 프로바이더 + 방금 친 키 + 그 프로바이더의 엔드포인트(보관값 없음 → 빈 값),
    // 이전 프로바이더(기본 ollama)의 값은 보관함으로.
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: {
          ai_provider: "gemini",
          ai_api_key: "sk-test-key",
          ai_endpoint: "",
          ai_provider_creds: { ollama: { api_key: "", endpoint: "" } },
        },
      }),
    );
    // ai_enabled 게이트가 있는 ai_test_connection 이 아니라 켜기 전 전용 커맨드로, 키는 인자로.
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("ai_test_connection_before_enable", {
        provider: "gemini",
        api_key: "sk-test-key",
      }),
    );
    expect(await screen.findByText(/Connected\./)).toBeTruthy();
  });

  it("a failed test shows the error and never enables AI", async () => {
    routeCalls(() => Promise.resolve({ ok: false, latency_ms: 0 }));
    const setAiEnabled = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ setAiEnabled } as any);
    const props = baseProps();
    render(<OnboardingAiStep {...props} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByTestId("onboarding-ai-key-input"), "sk-test-key");
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));

    expect(await screen.findByText(/Error:/)).toBeTruthy();
    expect(setAiEnabled).not.toHaveBeenCalled();
    expect(lastAdopt(props)).toBeNull();
  });

  it("adopting after a successful cloud test enables AI and reports provider with model null", async () => {
    routeCalls(() => Promise.resolve({ ok: true, latency_ms: 12 }));
    const ensureAiReachable = vi.fn().mockResolvedValue(undefined);
    const setAiEnabled = vi.fn().mockResolvedValue(undefined);
    useAiStore.setState({ ensureAiReachable } as any);
    useSettingsStore.setState({ setAiEnabled } as any);
    const props = baseProps();
    render(<OnboardingAiStep {...props} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByTestId("onboarding-ai-key-input"), "sk-test-key");
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));
    await waitFor(() => expect(lastAdopt(props)).not.toBeNull());
    expect(setAiEnabled).not.toHaveBeenCalled(); // 테스트 성공만으로는 켜지 않는다
    await act(async () => {
      expect(await lastAdopt(props)!()).toBe(true);
    });

    await waitFor(() => expect(setAiEnabled).toHaveBeenCalledWith(true));
    expect(lastAdopt(props)).toBeNull(); // 켠 뒤엔 셸 버튼이 다시 "다음"
    expect(ensureAiReachable).toHaveBeenCalled();
    expect(props.onAdopted).toHaveBeenCalledWith({ provider: "Gemini", model: null });
  });

  it("a local success with models shows a model select defaulting to the saved ai_model", async () => {
    routeLocalCalls(["llama3.2", "mistral"], "mistral");
    render(<OnboardingAiStep {...baseProps()} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByText("On this device"));
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));

    const select = await screen.findByTestId("onboarding-ai-model-select");
    expect(select.textContent).toBe("mistral");
  });

  it("adopting a local connection saves ai_model before enabling AI and reports Ollama + model", async () => {
    routeLocalCalls(["llama3.2", "mistral"]);
    const ensureAiReachable = vi.fn().mockResolvedValue(undefined);
    const setAiEnabled = vi.fn().mockResolvedValue(undefined);
    useAiStore.setState({ ensureAiReachable } as any);
    useSettingsStore.setState({ setAiEnabled } as any);
    const props = baseProps();
    render(<OnboardingAiStep {...props} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByText("On this device"));
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));
    await screen.findByTestId("onboarding-ai-model-select");
    await act(async () => {
      await lastAdopt(props)!();
    });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { ai_model: "llama3.2" } }),
    );
    const setOrder = callMock.mock.calls.findIndex((c) => c[0] === "settings_set" && (c[1] as any)?.entries?.ai_model === "llama3.2");
    expect(setOrder).toBeGreaterThanOrEqual(0);
    expect(setAiEnabled).toHaveBeenCalledWith(true);
    expect(props.onAdopted).toHaveBeenCalledWith({ provider: "Ollama", model: "llama3.2" });
  });

  it("a local success with zero models shows a hint and offers no adopt", async () => {
    routeLocalCalls([]);
    const props = baseProps();
    render(<OnboardingAiStep {...props} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByText("On this device"));
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));

    await screen.findByText(/ollama pull/);
    expect(lastAdopt(props)).toBeNull();
    expect(screen.queryByTestId("onboarding-ai-model-select")).toBeNull();
  });

  it("다른 클라우드 프로바이더로 테스트해도 이전 프로바이더의 키는 지워지지 않고 보관된다", async () => {
    routeCalls(() => Promise.resolve({ ok: true, latency_ms: 12 }), {
      ai_provider: "openai",
      ai_api_key: "sk-openai-old",
      ai_endpoint: "https://proxy.test/v1",
    });
    render(<OnboardingAiStep {...baseProps()} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByTestId("onboarding-ai-key-input"), "AIza-new");
    await userEvent.click(screen.getByTestId("onboarding-ai-test-button"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: expect.objectContaining({
          ai_provider: "gemini",
          ai_api_key: "AIza-new",
          // OpenAI 용 엔드포인트가 Gemini 로 새지 않는다.
          ai_endpoint: "",
          ai_provider_creds: { openai: { api_key: "sk-openai-old", endpoint: "https://proxy.test/v1" } },
        }),
      }),
    );
  });
});
