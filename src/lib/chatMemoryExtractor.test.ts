import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSettingsStore } from "../stores/settings";
import { extractAndSaveChatMemory } from "./chatMemoryExtractor";

const callSilentMock = vi.fn();
// stores/settings.ts::setSimplePref (chatMemory 도 이 경로를 지난다) 는 call() 도 쓴다 — call
// 을 안 채워두면 undefined 호출로 매번 던지는데, 이전엔 그 throw 가 조용히 삼켜지고도 낙관적
// set() 이 롤백 없이 남아 우연히 통과했다(2026-09-01 롤백 추가로 드러남). settings_set 은
// 성공해야 진짜 흐름과 같으므로 같은 mock 을 공유한다.
//
// D1(AUDIT-2026-09-26): extractAndSaveChatMemory 이제 stores/ai.ts::aiCreds() 로 settings 에서
// provider/endpoint/api_key/model 을 읽는다 — ai_generate_from_prompt 보다 먼저 settings_get_all
// 이 나간다. 예전엔 이 파일의 모든 테스트가 "커맨드 상관없이 한 응답"으로 목킹했는데, 그 응답이
// { generated: ... } 모양이면 aiCreds() 가 s.settings 를 읽다 던진다 — 그래서 커맨드별로 분기한다.
const AI_SETTINGS_RESPONSE = {
  settings: {
    ai_provider: "ollama",
    ai_endpoint: "http://localhost:11434",
    ai_api_key: "",
    ai_model: "llama3",
  },
};

// aiCreds() 재사용으로 stores/ai.ts(→ stores/notes.ts 등)를 끌고 오는데, 그 그래프가 registerFlush
// 같은 다른 ./invoke export 를 실제로 참조한다 — call/callSilent 만 목킹하고 나머지는
// importOriginal 로 진짜 구현을 유지한다(invoke.ts 자신이 Tauri 밖에서도 안전하게 no-op 한다).
vi.mock("./invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./invoke")>();
  return {
    ...actual,
    call: (...args: unknown[]) => callSilentMock(...args),
    callSilent: (...args: unknown[]) => callSilentMock(...args),
  };
});

// A(AUDIT-2026-09-26): memory-extraction failure is now instrumented.
const reportFallbackMock = vi.fn();
vi.mock("./diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diag")>()),
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

/** settings_get_all(aiCreds용) 은 항상 채우고, ai_generate_from_prompt 응답/거부만 테스트별로 준다. */
function mockAiPipeline(gen: () => Promise<unknown>) {
  callSilentMock.mockImplementation((cmd: string) => {
    if (cmd === "settings_get_all") return Promise.resolve(AI_SETTINGS_RESPONSE);
    if (cmd === "ai_generate_from_prompt") return gen();
    return Promise.resolve({ ok: true }); // settings_set 등
  });
}

describe("chatMemoryExtractor (W17)", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
    reportFallbackMock.mockClear();
    useSettingsStore.setState({
      aiEnabled: true,
      chatMemory: [],
    });
  });

  it("does not run when aiEnabled is false", async () => {
    useSettingsStore.setState({ aiEnabled: false });
    await extractAndSaveChatMemory({ userText: "I am a photographer", assistantText: "Nice to meet you!" });

    expect(callSilentMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().chatMemory).toEqual([]);
  });

  it("does not run when user text is too short", async () => {
    await extractAndSaveChatMemory({ userText: "hi", assistantText: "Hello!" });
    expect(callSilentMock).not.toHaveBeenCalled();
  });

  it("does not add new memory when 50 cap is reached", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      text: `Memory ${i}`,
      created_at: new Date().toISOString(),
    }));
    useSettingsStore.setState({ chatMemory: full });

    await extractAndSaveChatMemory({ userText: "I live in Tokyo now", assistantText: "Tokyo is great!" });
    expect(callSilentMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().chatMemory).toHaveLength(50);
  });

  it("extracts facts from AI json response and appends to chatMemory", async () => {
    mockAiPipeline(() => Promise.resolve({
      generated: '["사용자는 도쿄에 거주하고 있다", "사용자의 직업은 디자이너이다"]',
    }));

    await extractAndSaveChatMemory({
      userText: "나는 도쿄에 살고 디자이너로 일하고 있어",
      assistantText: "도쿄에서 디자이너로 일하시는군요!",
    });

    const genCall = callSilentMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt");
    expect(genCall).toBeDefined();
    expect(genCall![1]).toEqual(expect.objectContaining({
      prompt: expect.stringContaining("Analyze the following conversation turn"),
    }));
    // D1 회귀 고정: provider 가 실제로 전달되고, api_key/model 에 "omit" 리터럴이 없어야 한다
    // (Rust 쪽 provider: String 필수 — 없으면 인자 역직렬화에서 조용히 거부된다).
    const args = genCall![1] as Record<string, unknown>;
    expect(args.provider).toBe("ollama");
    expect(args.api_key).not.toBe("omit");
    expect(args.model).not.toBe("omit");

    const memory = useSettingsStore.getState().chatMemory;
    expect(memory.map((m) => m.text)).toEqual(["사용자는 도쿄에 거주하고 있다", "사용자의 직업은 디자이너이다"]);
  });

  it("skips duplicate memories and respects remaining cap slots", async () => {
    useSettingsStore.setState({
      chatMemory: [{ id: "m1", text: "사용자는 도쿄에 거주하고 있다", created_at: "2026-08-21T00:00:00Z" }],
    });

    mockAiPipeline(() => Promise.resolve({
      generated: '["사용자는 도쿄에 거주하고 있다", "사용자는 고양이를 키운다"]',
    }));

    await extractAndSaveChatMemory({
      userText: "나 고양이 키워",
      assistantText: "귀엽겠네요!",
    });

    const memory = useSettingsStore.getState().chatMemory;
    expect(memory.map((m) => m.text)).toEqual(["사용자는 고양이를 키운다", "사용자는 도쿄에 거주하고 있다"]);
  });

  it("silently handles AI error or invalid JSON", async () => {
    mockAiPipeline(() => Promise.reject(new Error("AI connection timeout")));

    await expect(
      extractAndSaveChatMemory({
        userText: "나는 커피를 좋아해",
        assistantText: "커피는 맛있죠!",
      })
    ).resolves.not.toThrow();

    expect(useSettingsStore.getState().chatMemory).toEqual([]);
    // A(AUDIT-2026-09-26): the extraction failure is reported once.
    expect(reportFallbackMock).toHaveBeenCalledWith("chat", "memory_extraction_failed", "AI connection timeout");
  });

  it("silently handles the settings/creds lookup (aiCreds) itself failing", async () => {
    callSilentMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.reject(new Error("db locked"));
      return Promise.resolve({ ok: true });
    });

    await expect(
      extractAndSaveChatMemory({ userText: "나는 요리사야", assistantText: "멋지네요!" })
    ).resolves.not.toThrow();

    expect(useSettingsStore.getState().chatMemory).toEqual([]);
  });

  it("skips short chat without first-person pattern (W18 C1 gate)", async () => {
    await extractAndSaveChatMemory({ userText: "쿠쿠 고마워", assistantText: "별말씩요!" });
    expect(callSilentMock).not.toHaveBeenCalled();
  });

  it("passes gate when first-person fact pattern is present (W18 C1 gate)", async () => {
    mockAiPipeline(() => Promise.resolve({ generated: "[]" }));
    await extractAndSaveChatMemory({ userText: "나는 디자이너야", assistantText: "그렇군요!" });
    expect(callSilentMock).toHaveBeenCalledWith("ai_generate_from_prompt", expect.any(Object));
  });

  it("merges against freshly re-queried memory, not the stale pre-await snapshot (W18 C1 race fix)", async () => {
    let resolveGen!: (v: { generated: string }) => void;
    callSilentMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve(AI_SETTINGS_RESPONSE);
      if (cmd === "ai_generate_from_prompt") {
        return new Promise((resolve) => { resolveGen = resolve; });
      }
      return Promise.resolve({ ok: true }); // settings_set 등
    });

    const pending = extractAndSaveChatMemory({ userText: "나는 요리사야", assistantText: "멋지네요!" });

    // D1 이후로 ai_generate_from_prompt 앞에 aiCreds() 의 settings_get_all 왕복이 하나 더 끼었다
    // — resolveGen 이 실제로 채워질 때까지(그 호출이 일어날 때까지) 매크로태스크 한 틱을 기다린다.
    await new Promise((r) => setTimeout(r, 0));

    // LLM 왕복(수 초) 동안 다른 턴/설정 창이 chatMemory 를 바꿨다고 가정 — 이 값이 write 에
    // 살아남아야 경합이 없는 것이다(옛 스냅샷으로 덮어쓰면 사라진다).
    useSettingsStore.setState({
      chatMemory: [{ id: "concurrent", text: "동시에 추가된 항목", created_at: "2026-08-22T00:00:00Z" }],
    });

    resolveGen({ generated: '["사용자는 요리사다"]' });
    await pending;

    const memory = useSettingsStore.getState().chatMemory;
    expect(memory.map((m) => m.text)).toEqual(["사용자는 요리사다", "동시에 추가된 항목"]);
  });
});
