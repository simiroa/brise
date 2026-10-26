import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...a: unknown[]) => callMock(...a),
  callSilent: (...a: unknown[]) => callMock(...a),
}));
const reportFallbackMock = vi.fn();
vi.mock("./diag", () => ({ reportFallback: (...a: unknown[]) => reportFallbackMock(...a) }));

import { planProviderSwitch, switchAiProvider, parseCredsStash } from "./aiProviderSwitch";

/** settings_get_all / settings_set 을 메모리 DB 로 흉내 낸다. */
function fakeDb(initial: Record<string, unknown>) {
  const db: Record<string, unknown> = { ...initial };
  callMock.mockImplementation(async (cmd: string, args?: { entries: Record<string, unknown> }) => {
    if (cmd === "settings_get_all") return { settings: JSON.parse(JSON.stringify(db)) };
    if (cmd === "settings_set") {
      Object.assign(db, JSON.parse(JSON.stringify(args!.entries)));
      return undefined;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return db;
}

describe("aiProviderSwitch", () => {
  beforeEach(() => {
    callMock.mockReset();
    reportFallbackMock.mockReset();
  });

  it("A→B→A 왕복이 A 의 키·엔드포인트를 되살린다", async () => {
    const db = fakeDb({ ai_provider: "openai", ai_api_key: "sk-openai", ai_endpoint: "https://proxy.test/v1", ai_provider_creds: {} });

    const toB = await switchAiProvider("Gemini");
    expect(toB).toMatchObject({ provider: "gemini", apiKey: "", endpoint: "" });
    expect(db.ai_provider).toBe("gemini");
    expect(db.ai_api_key).toBe("");
    expect(db.ai_endpoint).toBe("");
    expect((db.ai_provider_creds as Record<string, unknown>).openai).toEqual({
      api_key: "sk-openai",
      endpoint: "https://proxy.test/v1",
    });

    // B 에 키를 넣는다(설정 화면의 blur 저장과 같다).
    db.ai_api_key = "AIza-gemini";

    const back = await switchAiProvider("OpenAI");
    expect(back).toMatchObject({ provider: "openai", apiKey: "sk-openai", endpoint: "https://proxy.test/v1" });
    expect(db.ai_api_key).toBe("sk-openai");
    // B 의 키도 버려지지 않았다.
    expect((db.ai_provider_creds as Record<string, { api_key?: string }>).gemini.api_key).toBe("AIza-gemini");
  });

  it("전환은 settings_set 한 번(한 배치)에 네 키를 함께 쓴다", async () => {
    fakeDb({ ai_provider: "ollama", ai_api_key: "", ai_endpoint: "" });
    await switchAiProvider("Claude");
    const sets = callMock.mock.calls.filter((c) => c[0] === "settings_set");
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0][1].entries).sort()).toEqual(["ai_api_key", "ai_endpoint", "ai_provider", "ai_provider_creds"]);
  });

  it("화면의 현재 값(current)이 DB 값보다 우선해 보관된다 — 아직 안 끝난 blur 저장 대비", () => {
    const plan = planProviderSwitch(
      { ai_provider: "openai", ai_api_key: "sk-old", ai_endpoint: "" },
      "Gemini",
      { current: { apiKey: "  sk-just-typed ", endpoint: "" } },
    );
    expect(plan.creds.openai).toEqual({ api_key: "sk-just-typed", endpoint: "" });
  });

  it("next 로 들어온 키는 한 배치에 함께 쓰이고, 엔드포인트는 보관함에서 꺼낸다", () => {
    const plan = planProviderSwitch(
      { ai_provider: "ollama", ai_api_key: "", ai_endpoint: "http://box:11434", ai_provider_creds: { gemini: { endpoint: "https://g.test" } } },
      "gemini",
      { next: { apiKey: "AIza-new" } },
    );
    expect(plan).toMatchObject({ provider: "gemini", apiKey: "AIza-new", endpoint: "https://g.test" });
    expect(plan.creds.ollama).toEqual({ api_key: "", endpoint: "http://box:11434" });
  });

  it("같은 프로바이더면 보관함을 건드리지 않고 덮어쓸 값만 적용한다", () => {
    const plan = planProviderSwitch(
      { ai_provider: "gemini", ai_api_key: "AIza-old", ai_endpoint: "", ai_provider_creds: { openai: { api_key: "sk" } } },
      "Gemini",
      { next: { apiKey: "AIza-new" } },
    );
    expect(plan.apiKey).toBe("AIza-new");
    expect(plan.creds).toEqual({ openai: { api_key: "sk" } });
  });

  it("읽기가 실패하면 쓰지 않는다(빈 읽기로 보관함을 새로 만들지 않는다)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "settings_get_all") throw new Error("boom");
      return undefined;
    });
    await expect(switchAiProvider("Gemini")).rejects.toThrow("boom");
    expect(callMock.mock.calls.some((c) => c[0] === "settings_set")).toBe(false);
    // 설정 객체 없는 응답도 읽기 실패로 친다.
    callMock.mockImplementation(async (cmd: string) => (cmd === "settings_get_all" ? {} : undefined));
    await expect(switchAiProvider("Gemini")).rejects.toThrow();
    expect(callMock.mock.calls.some((c) => c[0] === "settings_set")).toBe(false);
    // 실패 뒤에도 다음 전환은 줄에 막히지 않는다.
    fakeDb({ ai_provider: "ollama" });
    await expect(switchAiProvider("Gemini")).resolves.toMatchObject({ provider: "gemini" });
  });

  it("옛 전환이 Ollama 에 남긴 클라우드 키는 Ollama 밑에 숨지 않고 들어오는 프로바이더로 넘어간다", async () => {
    const db = fakeDb({ ai_provider: "ollama", ai_api_key: "AIza-legacy", ai_endpoint: "http://box:11434", ai_provider_creds: {} });
    const plan = await switchAiProvider("Gemini");
    expect(plan).toMatchObject({ provider: "gemini", apiKey: "AIza-legacy", endpoint: "" });
    expect(db.ai_api_key).toBe("AIza-legacy");
    expect((db.ai_provider_creds as Record<string, unknown>).ollama).toEqual({ api_key: "", endpoint: "http://box:11434" });
  });

  it("들어오는 쪽에 이미 키가 있거나 새 키를 받으면 옛 키는 버리지 않고 Ollama 보관함에 둔다", () => {
    const legacy = { ai_provider: "ollama", ai_api_key: "AIza-legacy", ai_endpoint: "" };
    const stashed = planProviderSwitch({ ...legacy, ai_provider_creds: { gemini: { api_key: "AIza-new" } } }, "gemini");
    expect(stashed.apiKey).toBe("AIza-new");
    expect(stashed.creds.ollama.api_key).toBe("AIza-legacy");

    const typed = planProviderSwitch({ ...legacy, ai_provider_creds: {} }, "gemini", { next: { apiKey: "AIza-typed" } });
    expect(typed.apiKey).toBe("AIza-typed");
    expect(typed.creds.ollama.api_key).toBe("AIza-legacy");
  });

  it("모양이 어긋난 보관함 항목만 버린다", () => {
    expect(parseCredsStash({ openai: { api_key: "sk", model: "x" }, Bad: { api_key: "y" }, gemini: "nope" })).toEqual({
      openai: { api_key: "sk" },
    });
    expect(parseCredsStash([])).toEqual({});
  });
});
