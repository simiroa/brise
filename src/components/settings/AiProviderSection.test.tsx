import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { AiProviderSection } from "./AiProviderSection";

/** 메모리 DB — settings_get_all / settings_set 을 흉내 낸다. 나머지 커맨드는 그냥 통과. */
let db: Record<string, unknown> = {};
let failSet: ((entries: Record<string, unknown>) => boolean) | null = null;
const callMock = vi.fn(async (cmd: string, args?: { entries?: Record<string, unknown> }) => {
  if (cmd === "settings_get_all") return { settings: JSON.parse(JSON.stringify(db)) };
  if (cmd === "settings_set") {
    if (failSet?.(args!.entries!)) throw new Error("VALIDATION");
    Object.assign(db, JSON.parse(JSON.stringify(args!.entries)));
    return undefined;
  }
  return undefined;
});
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...(args as [string, { entries?: Record<string, unknown> }])),
  callSilent: (...args: unknown[]) => callMock(...(args as [string, { entries?: Record<string, unknown> }])),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallbackMock(...a) }));

function settingsSets() {
  return callMock.mock.calls.filter((c) => c[0] === "settings_set").map((c) => c[1]!.entries!);
}

async function renderLoaded(stored: Record<string, unknown>) {
  db = { ...stored };
  render(<AiProviderSection />);
  await waitFor(() => expect(callMock).toHaveBeenCalledWith("settings_get_all"));
  // 첫 읽기가 화면에 반영될 때까지(프로바이더 SegGroup 의 선택 칸으로 확인).
  const want = String(stored.ai_provider ?? "ollama").toLowerCase();
  if (useSettingsStore.getState().aiEnabled) {
    await waitFor(() =>
      expect(
        screen.getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true")?.textContent?.toLowerCase(),
      ).toBe(want),
    );
  }
}

beforeEach(() => {
  db = {};
  failSet = null;
  callMock.mockClear();
  reportFallbackMock.mockClear();
  useAiStore.setState({
    aiReachable: null,
    aiReachableChecking: false,
    availableModels: [],
    ensureAiReachable: vi.fn().mockResolvedValue(undefined),
  } as any);
});

describe("AiProviderSection — collapse when AI disabled", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: false } as any);
  });

  it("hides provider/endpoint/key/model/test fields when ai_enabled is off, keeps header", () => {
    render(<AiProviderSection />);

    expect(screen.getAllByText("AI Provider")[0]).toBeTruthy();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(screen.queryByText("Endpoint")).toBeNull();
    expect(screen.queryByText("API Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("collapses/expands live when the store flag flips, no remount", () => {
    render(<AiProviderSection />);
    expect(screen.queryByText("Endpoint")).toBeNull();
    act(() => useSettingsStore.setState({ aiEnabled: true } as any));
    expect(screen.getByText("Endpoint")).toBeTruthy();
    act(() => useSettingsStore.setState({ aiEnabled: false } as any));
    expect(screen.queryByText("Endpoint")).toBeNull();
  });

  // PLAN-2026-10-24 D7: 마스터 스위치의 유일한 거처. 접히는 본문 밖이라 꺼진 상태에서도 보인다.
  it("the master AI toggle is the first row of this page and stays visible while collapsed", () => {
    const { container } = render(<AiProviderSection />);
    expect(container.firstElementChild).toBe(screen.getByTestId("settings-ai-master-card"));
    const toggle = screen.getByTestId("settings-ai-enabled-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("ai-off-banner")).toBeNull();
    expect(screen.queryByTestId("ai-off-link")).toBeNull();
  });

  it("turning the master on saves ai_enabled, then checks reachability", async () => {
    const ensureAiReachable = vi.fn().mockResolvedValue(undefined);
    useAiStore.setState({ ensureAiReachable } as any);
    render(<AiProviderSection />);

    fireEvent.click(screen.getByTestId("settings-ai-enabled-toggle"));
    await waitFor(() => expect(settingsSets()).toContainEqual({ ai_enabled: true }));
    await waitFor(() => expect(ensureAiReachable).toHaveBeenCalled());
    // 켜지면 접혀 있던 본문이 펼쳐진다.
    await waitFor(() => expect(screen.getByText("Endpoint")).toBeTruthy());
  });
});

describe("AiProviderSection — fields come from settings", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true } as any);
  });

  it("cloud provider (Gemini) shows key, endpoint, model, fallback and test button", async () => {
    await renderLoaded({ ai_provider: "gemini", ai_api_key: "AIza-1", ai_model: "gemini-x", ai_model_fallback: "gemma" });
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("AIza-1");
    expect((screen.getByPlaceholderText("gemma-4-31b") as HTMLInputElement).value).toBe("gemma");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
  });

  it("Ollama hides the key row and shows the local notice", async () => {
    await renderLoaded({ ai_provider: "ollama" });
    expect(screen.getByText("Endpoint")).toBeTruthy();
    expect(screen.queryByText("API Key")).toBeNull();
  });

  it("an unknown stored provider is treated as external and recorded, not shown as Ollama", async () => {
    db = { ai_provider: "mistral" };
    render(<AiProviderSection />);
    await waitFor(() => expect(reportFallbackMock).toHaveBeenCalledWith("ai", "unknown_provider", "mistral"));
    await waitFor(() => expect(screen.getByText("External transmission")).toBeTruthy());
    expect(screen.getAllByRole("radio").some((r) => r.getAttribute("aria-checked") === "true")).toBe(false);
  });

  it("a focus reload does not clobber a field the user is editing", async () => {
    await renderLoaded({ ai_provider: "gemini", ai_api_key: "AIza-1" });
    const key = screen.getByLabelText("API Key") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "AIza-typing" } });
    db.ai_api_key = "AIza-from-elsewhere";
    db.ai_model = "changed-elsewhere";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect((screen.getAllByLabelText("Model")[0] as HTMLInputElement).value).toBe("changed-elsewhere"));
    expect(key.value).toBe("AIza-typing");
  });
});

describe("AiProviderSection — saving", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true } as any);
  });

  it("the fallback model persists under its own key, trimmed", async () => {
    await renderLoaded({ ai_provider: "gemini" });
    const input = screen.getByPlaceholderText("gemma-4-31b");
    await userEvent.type(input, "  gemma-4-31b ");
    await userEvent.tab();
    await waitFor(() => expect(settingsSets()).toContainEqual({ ai_model_fallback: "gemma-4-31b" }));
  });

  it("blur without a change does not save", async () => {
    await renderLoaded({ ai_provider: "gemini", ai_api_key: "AIza-1" });
    await userEvent.click(screen.getByLabelText("API Key"));
    await userEvent.tab();
    expect(settingsSets()).toEqual([]);
  });

  it("a failed key save rolls the field back to the last saved value", async () => {
    await renderLoaded({ ai_provider: "gemini", ai_api_key: "AIza-1" });
    failSet = (e) => "ai_api_key" in e;
    const key = screen.getByLabelText("API Key") as HTMLInputElement;
    await userEvent.clear(key);
    await userEvent.type(key, "AIza-bad");
    await userEvent.tab();
    await waitFor(() => expect(key.value).toBe("AIza-1"));
  });

  it("switching provider stashes the old key and restores the new one's — keys are never dropped", async () => {
    await renderLoaded({
      ai_provider: "openai",
      ai_api_key: "sk-openai",
      ai_endpoint: "",
      ai_provider_creds: { gemini: { api_key: "AIza-saved", endpoint: "" } },
    });
    await userEvent.click(screen.getByRole("radio", { name: "Gemini" }));
    await waitFor(() => expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("AIza-saved"));
    expect(db.ai_provider).toBe("gemini");
    expect((db.ai_provider_creds as Record<string, { api_key?: string }>).openai.api_key).toBe("sk-openai");

    await userEvent.click(screen.getByRole("radio", { name: "OpenAI" }));
    await waitFor(() => expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("sk-openai"));
  });

  it("a key typed right before switching is stashed under the old provider, not sent to the new one", async () => {
    await renderLoaded({ ai_provider: "openai", ai_api_key: "" });
    await userEvent.type(screen.getByLabelText("API Key"), "sk-fresh");
    // 클릭이 입력칸의 blur 를 먼저 일으킨다 — blur 저장이 끝난 뒤 전환이 돈다.
    await userEvent.click(screen.getByRole("radio", { name: "Gemini" }));
    await waitFor(() => expect(db.ai_provider).toBe("gemini"));
    expect(db.ai_api_key).toBe("");
    expect((db.ai_provider_creds as Record<string, { api_key?: string }>).openai.api_key).toBe("sk-fresh");
  });

  it("a failed provider switch reverts the selection", async () => {
    await renderLoaded({ ai_provider: "openai", ai_api_key: "sk-openai" });
    failSet = (e) => "ai_provider" in e;
    await userEvent.click(screen.getByRole("radio", { name: "Gemini" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "OpenAI" }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("sk-openai");
  });
});

describe("AiProviderSection — connection test", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true } as any);
  });

  it("waits for the pending key save before testing (no stale-key test)", async () => {
    const order: string[] = [];
    useAiStore.setState({
      testConnection: vi.fn(async () => {
        order.push(`test:${db.ai_api_key ?? ""}`);
        return { latencyMs: 5, models: [] };
      }),
    } as any);
    db = { ai_provider: "gemini" };
    render(<AiProviderSection />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Gemini" }).getAttribute("aria-checked")).toBe("true"));
    await userEvent.type(screen.getByLabelText("API Key"), "AIza-new");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(order).toEqual(["test:AIza-new"]));
  });

  it("ok:false shows one inline error", async () => {
    useAiStore.setState({ testConnection: vi.fn().mockRejectedValue(new Error("connection_failed")) } as any);
    await renderLoaded({ ai_provider: "ollama" });
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByTestId("settings-ai-test-error")).toBeTruthy());
  });

  it("an IPC rejection (already toasted by call()) adds no second inline error", async () => {
    useAiStore.setState({
      testConnection: vi.fn(async () => {
        useAiStore.setState({ aiReachable: false, aiReachableError: "boom" } as any);
        throw new Error("boom");
      }),
    } as any);
    await renderLoaded({ ai_provider: "ollama" });
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(useAiStore.getState().aiReachable).toBe(false));
    expect(screen.queryByTestId("settings-ai-test-error")).toBeNull();
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});

/** PLAN-2026-09-15 W3: 히어로 + 연결 상태 배지 + 통계 타일 + SubGroup 3 */
describe("AiProviderSection — hero, badge, tiles, groups", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true } as any);
  });

  it("renders the reachability badge in the provider card header", () => {
    render(<AiProviderSection />);
    expect(screen.getByTestId("settings-ai-provider-card").contains(screen.getByTestId("ai-reach-badge"))).toBe(true);
    expect(screen.getByTestId("ai-reach-badge").textContent).toBe("Not checked");
  });

  it("badge follows aiReachableChecking / aiReachable", () => {
    render(<AiProviderSection />);
    act(() => useAiStore.setState({ aiReachableChecking: true } as any));
    expect(screen.getByTestId("ai-reach-badge").textContent).toBe("Checking");
    act(() => useAiStore.setState({ aiReachableChecking: false, aiReachable: true } as any));
    expect(screen.getByTestId("ai-reach-badge").textContent).toBe("Connected");
    act(() => useAiStore.setState({ aiReachable: false } as any));
    expect(screen.getByTestId("ai-reach-badge").textContent).toBe("Unreachable");
  });

  it("tiles without data are not shown; model count and current model are", () => {
    useAiStore.setState({ availableModels: ["llama3", "gemma"] } as any);
    render(<AiProviderSection />);
    expect(screen.queryByTestId("metric-tile-latency")).toBeNull();
    expect(screen.getByTestId("metric-tile-models").textContent).toContain("2");
    expect(screen.getByTestId("metric-tile-model").textContent).toContain("Default");
  });

  it("with no models known, only the current-model tile shows", () => {
    render(<AiProviderSection />);
    expect(screen.queryByTestId("metric-tile-models")).toBeNull();
    expect(screen.getByTestId("metric-tile-model")).toBeTruthy();
  });

  it("splits the body into auth / models / diag sub-groups and the link-model placeholder is translated", async () => {
    await renderLoaded({ ai_provider: "gemini" });
    expect(screen.getByTestId("settings-ai-group-auth")).toBeTruthy();
    expect(screen.getByTestId("settings-ai-group-models")).toBeTruthy();
    expect(screen.getByTestId("settings-ai-group-diag")).toBeTruthy();
    expect(screen.getByTestId("settings-link-suggestions-model").getAttribute("placeholder")).toBe("e.g. gemini-3.1-flash-lite, llama3.2");
    expect(screen.getByRole("radio", { name: "Gemini" }).getAttribute("aria-checked")).toBe("true");
  });
});
