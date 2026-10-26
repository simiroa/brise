import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { PhrasePacksSection } from "./PhrasePacksSection";
import * as phraseLib from "../../lib/phrasePacks";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

const generateMock = vi.fn();
vi.mock("../../stores/ai", () => ({
  ensureAiAskGate: async () => true,
  useAiStore: (sel: (s: unknown) => unknown) => sel({ generateFromPrompt: generateMock }),
}));
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", () => ({
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));

describe("PhrasePacksSection (W7 §7.5)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    useSettingsStore.setState({ phrasePackId: "bundled:note-quotes", aiEnabled: false });
    vi.spyOn(phraseLib, "loadAllPhrasePacks").mockResolvedValue([
      {
        id: "bundled:note-quotes",
        name: "Note Quotes",
        origin: "bundled",
        items: [{ text: "Hello", source: "World" }],
      },
    ]);
  });

  it("renders phrase packs settings (preview lives in DashboardMiniPreview now)", async () => {
    render(<PhrasePacksSection />);
    expect(screen.getByTestId("settings-phrase-packs")).toBeTruthy();
    expect(screen.queryByTestId("settings-phrase-preview")).toBeNull();
    await waitFor(() => expect(phraseLib.loadAllPhrasePacks).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-phrase-pack-user-badge")).toBeNull();
  });

  it("shows the user-made badge only when the selected pack's origin is user (PLAN-2026-09-15 §4)", async () => {
    useSettingsStore.setState({ phrasePackId: "user:mine" });
    vi.spyOn(phraseLib, "loadAllPhrasePacks").mockResolvedValue([
      { id: "bundled:note-quotes", name: "Note Quotes", origin: "bundled", items: [] },
      { id: "user:mine", name: "Mine", origin: "user", items: [] },
    ]);
    render(<PhrasePacksSection />);
    expect((await screen.findByTestId("settings-phrase-pack-user-badge")).textContent).toBe("User-made");
  });

  it("팩 목록을 못 읽어도 번들 선택지로 그려지고 진단에 남긴다", async () => {
    vi.spyOn(phraseLib, "loadAllPhrasePacks").mockRejectedValue(new Error("io"));
    render(<PhrasePacksSection />);
    await waitFor(() => expect(reportFallbackMock).toHaveBeenCalledWith("phrase_packs", "load_failed", "io"));
    expect(screen.getByTestId("settings-phrase-pack-select")).toBeTruthy();
  });

  it("AI 생성은 브리핑 창 머리줄 문구로 묻고 JSON 응답(purpose: json)을 요청한다", async () => {
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as never);
    generateMock.mockReset().mockResolvedValue('[{"text":"a"}]');
    render(<PhrasePacksSection />);
    fireEvent.click(await screen.findByTestId("settings-phrase-pack-ai-btn"));
    fireEvent.change(await screen.findByTestId("settings-phrase-pack-ai-topic"), { target: { value: "calm" } });
    fireEvent.click(screen.getByTestId("settings-phrase-pack-ai-generate"));
    await waitFor(() => expect(generateMock).toHaveBeenCalled());
    const [prompt, ctx, opts] = generateMock.mock.calls[0];
    expect(prompt).toContain("briefing window");
    expect(prompt).not.toContain("dashboard");
    expect(ctx).toBeNull();
    expect(opts).toEqual({ purpose: "json" });
  });
});
