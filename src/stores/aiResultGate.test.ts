import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn().mockResolvedValue({ settings: {} });
const emitNoticeMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: vi.fn(),
}));

import {
  openAiResultGate,
  runWithAiResultGate,
  useAiResultGateStore,
  registerAiResultGateHost,
  type AiGenerateOutcome,
} from "./aiResultGate";
import { useSettingsStore } from "./settings";

// PLAN-2026-09-05 §2 (트랙 B) — runWithAiResultGate 자체의 오케스트레이션(대기 → 결과/실패 →
// 사람 결정 → 재시도 루프)을 runAiAction.ts 통합 테스트와 분리해 직접 본다.
describe("aiResultGate — openAiResultGate / runWithAiResultGate", () => {
  let unregisterGateHost: () => void;

  beforeEach(() => {
    callMock.mockClear();
    useAiResultGateStore.setState({ session: null });
    // 게이트는 AiResultModal(host)이 실제로 마운트돼 있을 때만 걸린다(§5 모바일 경계) — 이
    // 스위트는 모달 없이 스토어만 보므로 host가 있는 척 등록해둔다. "host 없음" 자체를 보는
    // 케이스는 아래에서 이 등록을 걷어내고 별도로 검증한다.
    unregisterGateHost = registerAiResultGateHost();
  });

  afterEach(() => {
    unregisterGateHost();
  });

  it("aiConfirmBeforeApply=false면 게이트를 열지 않고 즉시 generate → apply", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    const apply = vi.fn(async () => {});
    const ok = await runWithAiResultGate(
      { title: "t", target: "target", kind: "text" },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "hello", preview: "hello" }),
      apply,
    );
    expect(ok).toBe(true);
    expect(apply).toHaveBeenCalledWith("hello");
    expect(useAiResultGateStore.getState().session).toBeNull();
  });

  it("aiConfirmBeforeApply=false 라도 replacesExisting(제자리 교체)이면 게이트가 열리고 [삽입] 전엔 apply 하지 않는다", async () => {
    // AUDIT-2026-09-05-ai-guard-friction §2-7 — 킬 스위치는 새 섹션 삽입만 건너뛴다.
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    const apply = vi.fn(async () => {});
    const run = runWithAiResultGate(
      { title: "t", target: "target", kind: "diagram", replacesExisting: true },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "{}", preview: "{}" }),
      apply,
    );
    // 진입부의 비동기 사전 확인(외부 프로바이더 미설정)이 끝난 뒤 세션이 열린다.
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session).not.toBeNull());
    expect(apply).not.toHaveBeenCalled();
    // 결과가 찬 뒤 사람이 [삽입]
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));
    useAiResultGateStore.getState().decide("insert");
    expect(await run).toBe(true);
    expect(apply).toHaveBeenCalledWith("{}");
  });

  it("게이트 켜짐 + generate 실패면 apply 를 부르지 않고 false", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    const apply = vi.fn(async () => {});
    const ok = await runWithAiResultGate(
      { title: "t", target: "target", kind: "text" },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: false, error: "boom" }),
      apply,
    );
    expect(ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("게이트 켜짐: discard 결정이면 apply 를 부르지 않고 세션이 닫힌다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    const apply = vi.fn(async () => {});
    const runPromise = runWithAiResultGate(
      { title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "hello", preview: "hello" }),
      apply,
    );

    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));
    useAiResultGateStore.getState().decide("discard");

    expect(await runPromise).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(useAiResultGateStore.getState().session).toBeNull();
  });

  it("게이트 켜짐: retry면 generate 가 다시 호출되고, 그다음 insert 로 apply 가 불린다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    const generate = vi
      .fn<() => Promise<AiGenerateOutcome<string>>>()
      .mockResolvedValueOnce({ ok: true, raw: "first", preview: "first" })
      .mockResolvedValueOnce({ ok: true, raw: "second", preview: "second" });
    const apply = vi.fn(async () => {});

    const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, apply);

    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.resultText).toBe("first"));
    useAiResultGateStore.getState().decide("retry");

    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.resultText).toBe("second"));
    expect(generate).toHaveBeenCalledTimes(2);
    useAiResultGateStore.getState().decide("insert");

    expect(await runPromise).toBe(true);
    expect(apply).toHaveBeenCalledWith("second");
  });

  it("대기 중 discard(중단)는 응답을 기다리지 않고 즉시 false — 백그라운드 generate는 계속 돈다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    let resolveGenerate: (v: AiGenerateOutcome<string>) => void = () => {};
    const generate = () => new Promise<AiGenerateOutcome<string>>((resolve) => { resolveGenerate = resolve; });
    const apply = vi.fn(async () => {});

    const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, apply);
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("pending"));
    useAiResultGateStore.getState().decide("discard");

    expect(await runPromise).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    // 백엔드 호출은 계속 진행 중이라는 게 §2 B-2의 계약 — 뒤늦게 응답이 와도 아무 일도 안 한다.
    resolveGenerate({ ok: true, raw: "late", preview: "late" });
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
  });

  it("host(AiResultModal)가 마운트돼 있지 않으면 aiConfirmBeforeApply=true 여도 즉시 적용된다 — 모바일 경계", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    unregisterGateHost(); // 이 테스트만 "host 없음"(모바일 트리)을 재현한다
    const apply = vi.fn(async () => {});

    const ok = await runWithAiResultGate(
      { title: "t", target: "target", kind: "diagram" },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "mobile result", preview: "mobile result" }),
      apply,
    );

    expect(ok).toBe(true);
    expect(apply).toHaveBeenCalledWith("mobile result");
    expect(useAiResultGateStore.getState().session).toBeNull();

    unregisterGateHost = registerAiResultGateHost(); // afterEach가 안전하게 다시 해제하도록
  });

  it("세션이 close() 되거나 대체된 뒤의 patch(setResult 등)는 무시된다", () => {
    const gate = openAiResultGate({ title: "a", target: "target", kind: "text" });
    const firstId = useAiResultGateStore.getState().session?.id;
    gate.close();
    expect(useAiResultGateStore.getState().session).toBeNull();
    gate.setResult("too late");
    expect(useAiResultGateStore.getState().session).toBeNull();

    // 새 세션이 같은 슬롯을 차지한 뒤에도 이전 handle 의 patch 는 새 세션을 건드리지 않는다.
    const gate2 = openAiResultGate({ title: "b", target: "target", kind: "text" });
    expect(useAiResultGateStore.getState().session?.id).not.toBe(firstId);
    gate.setError("stale");
    expect(useAiResultGateStore.getState().session?.status).toBe("pending");
    gate2.close();
  });

  // 2026-09-27 — AI 모달의 "고쳐서 다시": 새 세션 B 가 결정을 기다리기 시작한 **뒤에** 옛 세션 A 의
  // 실행기가 finally 로 close() 를 부른다. 예전 close() 는 대기자를 무조건 지워서 B 의 [삽입]·[버리기]가
  // 허공에 떨어졌다(흐름이 영영 멈춤).
  it("옛 세션의 close() 가 새 세션의 결정 대기를 지우지 않는다", async () => {
    const a = openAiResultGate({ title: "a", target: "target", kind: "text" });
    const b = openAiResultGate({ title: "b", target: "target", kind: "text" });
    const decided = b.waitDecision();
    a.close();
    expect(useAiResultGateStore.getState().session?.title).toBe("b");
    useAiResultGateStore.getState().decide("insert");
    await expect(decided).resolves.toBe("insert");
    b.close();
  });

  // 2026-09-27 실측 — 주기 스냅샷의 flushAll 이 생성 중인 결과 세션을 조용히 지웠다. 닫기 가드는 창이
  // 실제로 닫힐 때(flushAll("close"))만 세션을 치운다.
  it("닫기 가드: 평범한 flush 는 세션을 두고, 창 닫기 flush 만 치운다", async () => {
    const { installAiResultGateFlushGuard } = await import("./aiResultGate");
    const { registerFlush } = await import("../lib/invoke");
    const reg = vi.mocked(registerFlush);
    reg.mockClear();
    installAiResultGateFlushGuard();
    const guard = reg.mock.calls[0][0] as (reason?: "close") => Promise<unknown>;
    const gate = openAiResultGate({ title: "a", target: "target", kind: "text" });
    await guard();
    expect(useAiResultGateStore.getState().session?.title).toBe("a");
    await guard("close");
    expect(useAiResultGateStore.getState().session).toBeNull();
    gate.close();
  });

  // AI 모달이 두 번째 호스트다 — 그 사이 열린 세션은 embedded 로 표시돼 AiResultModal 이 그리지 않는다.
  // 독립 결과 창의 호스트 등록과 따로 세서, AI 모달이 닫혀도 독립 창의 게이트는 살아 있다.
  it("AI 모달 호스트: 열려 있는 동안의 세션만 embedded, 닫혀도 독립 창 호스트는 그대로", async () => {
    const { registerEmbeddedGateHost } = await import("./aiResultGate");
    unregisterGateHost(); // 독립 창 없이 AI 모달만 떠 있는 상황
    const releaseEmbedded = registerEmbeddedGateHost();
    const apply = vi.fn(async () => {});
    const run = runWithAiResultGate({ title: "t", target: "x", kind: "text" }, async () => ({ ok: true, raw: "r", preview: "r" }), apply);
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));
    expect(useAiResultGateStore.getState().session?.embedded).toBe(true);
    useAiResultGateStore.getState().decide("insert");
    await expect(run).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith("r");
    releaseEmbedded();
    releaseEmbedded(); // 두 번 풀어도 수가 틀어지지 않는다

    unregisterGateHost = registerAiResultGateHost();
    const gate = openAiResultGate({ title: "c", target: "target", kind: "text" });
    expect(useAiResultGateStore.getState().session?.embedded).toBe(false);
    gate.close();
  });
});

// WB(2026-09-05) B1 — [중단]의 취소를 "시각 추정"에서 "request_id 정확 취소"로. generate 콜백이
// 받는 request_id가 커맨드에 실리고, [중단]은 그 하나의 request_id로만 ai_cancel_call을 쏜다.
describe("aiResultGate — request_id 기반 취소(B1)", () => {
  let unregisterGateHost: () => void;

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ settings: {} });
    emitNoticeMock.mockReset();
    useAiResultGateStore.setState({ session: null });
    unregisterGateHost = registerAiResultGateHost();
  });

  afterEach(() => {
    useAiResultGateStore.getState().decide("discard");
    unregisterGateHost();
  });

  it("generate 콜백이 게이트가 만든 request_id를 첫 인자로 받는다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    const generate = vi.fn(async (_requestId: string): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "x", preview: "x" }));

    const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, async () => {});
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());

    const requestId = generate.mock.calls[0]![0];
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);
    expect(useAiResultGateStore.getState().session?.requestId).toBe(requestId);

    useAiResultGateStore.getState().decide("insert");
    await runPromise;
  });

  it("다시 생성(retry)마다 새 request_id가 나온다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    const generate = vi.fn(async (_requestId: string): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "x", preview: "x" }));

    const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, async () => {});
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const firstId = generate.mock.calls[0]![0];

    useAiResultGateStore.getState().decide("retry");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    const secondId = generate.mock.calls[1]![0];

    expect(secondId).not.toBe(firstId);

    useAiResultGateStore.getState().decide("insert");
    await runPromise;
  });

  it("대기 중 [중단]은 ai_cancel_call을 그 세션의 request_id 하나로만 부른다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    let resolveGenerate: (v: AiGenerateOutcome<string>) => void = () => {};
    const generate = () => new Promise<AiGenerateOutcome<string>>((resolve) => { resolveGenerate = resolve; });

    const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, async () => {});
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("pending"));
    const requestId = useAiResultGateStore.getState().session?.requestId;

    useAiResultGateStore.getState().decide("discard");
    expect(await runPromise).toBe(false);

    expect(callMock).toHaveBeenCalledWith("ai_cancel_call", { request_id: requestId });
    resolveGenerate({ ok: true, raw: "late", preview: "late" });
  });

  it("ai_cancel_call이 count>0을 돌려주면 '취소했습니다', 0이면 '결과를 버렸습니다'", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "ai_cancel_call") return Promise.resolve({ cancelled: true, count: 1 });
      return Promise.resolve({ settings: {} });
    });
    let resolveGenerate: (v: AiGenerateOutcome<string>) => void = () => {};
    let runPromise = runWithAiResultGate(
      { title: "t", target: "target", kind: "text" },
      () => new Promise<AiGenerateOutcome<string>>((resolve) => { resolveGenerate = resolve; }),
      async () => {},
    );
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("pending"));
    useAiResultGateStore.getState().decide("discard");
    await runPromise;
    await vi.waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(emitNoticeMock.mock.calls[emitNoticeMock.mock.calls.length - 1]![0]).not.toContain("45");
    resolveGenerate({ ok: true, raw: "late", preview: "late" });

    emitNoticeMock.mockClear();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "ai_cancel_call") return Promise.resolve({ cancelled: false, count: 0 });
      return Promise.resolve({ settings: {} });
    });
    runPromise = runWithAiResultGate(
      { title: "t", target: "target", kind: "text" },
      () => new Promise<AiGenerateOutcome<string>>((resolve) => { resolveGenerate = resolve; }),
      async () => {},
    );
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("pending"));
    useAiResultGateStore.getState().decide("discard");
    await runPromise;
    await vi.waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(emitNoticeMock.mock.calls[emitNoticeMock.mock.calls.length - 1]![0]).toContain("45");
    resolveGenerate({ ok: true, raw: "late", preview: "late" });
  });

  it("결과/실패 상태에서의 버리기·닫기는 취소를 쏘지 않는다(이미 끝난 호출)", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    const generate = vi.fn(async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "x", preview: "x" }));

    const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, async () => {});
    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));
    callMock.mockClear();

    useAiResultGateStore.getState().decide("discard");
    expect(await runPromise).toBe(false);
    expect(callMock).not.toHaveBeenCalledWith("ai_cancel_call", expect.anything());
  });

  it("ai_calls_active 폴링은 이 세션의 request_id와 일치하는 항목만 provider/model에 반영한다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    vi.useFakeTimers();
    try {
      let resolveGenerate: (v: AiGenerateOutcome<string>) => void = () => {};
      const generate = () => new Promise<AiGenerateOutcome<string>>((resolve) => { resolveGenerate = resolve; });
      const runPromise = runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, async () => {});

      await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("pending"));
      const requestId = useAiResultGateStore.getState().session!.requestId;

      callMock.mockImplementation((cmd: string) => {
        if (cmd === "ai_calls_active") {
          return Promise.resolve({
            items: [
              { id: "other-call", ts: new Date().toISOString(), provider: "openai", model: "gpt", request_id: "not-this-one" },
              { id: "this-call", ts: new Date().toISOString(), provider: "ollama", model: "llama3.1", request_id: requestId },
            ],
          });
        }
        return Promise.resolve({ settings: {} });
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(useAiResultGateStore.getState().session?.provider).toBe("ollama");
      expect(useAiResultGateStore.getState().session?.model).toBe("llama3.1");

      useAiResultGateStore.getState().decide("discard");
      await runPromise;
      resolveGenerate({ ok: true, raw: "late", preview: "late" });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("세션 종료 후에는 폴링 타이머가 없다 — close() 뒤 시간이 흘러도 ai_calls_active가 더 불리지 않는다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    vi.useFakeTimers();
    try {
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      await vi.advanceTimersByTimeAsync(0);
      const callsBeforeClose = callMock.mock.calls.filter((c) => c[0] === "ai_calls_active").length;
      expect(callsBeforeClose).toBeGreaterThan(0);

      gate.close();
      callMock.mockClear();
      await vi.advanceTimersByTimeAsync(5000);

      expect(callMock).not.toHaveBeenCalledWith("ai_calls_active");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("폴링 실패 시에도 세션은 계속 진행된다(pending 유지, 예외가 새지 않음)", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    vi.useFakeTimers();
    try {
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "ai_calls_active") return Promise.reject(new Error("network down"));
        if (cmd === "settings_get_all") return Promise.reject(new Error("network down"));
        return Promise.resolve(undefined);
      });

      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000); // 폴링 실패가 반복돼도 죽지 않는다

      expect(useAiResultGateStore.getState().session?.status).toBe("pending");
      gate.close();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// WE(2026-09-05) — 결과 게이트 첫 사용자 경험 보강: E2(사전 확인) · E3(빈 결과 삽입 불가) ·
// E4(세션 교체 시 이전 호출 취소).
describe("aiResultGate — E2/E3/E4", () => {
  let unregisterGateHost: () => void;

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ settings: {} });
    emitNoticeMock.mockReset();
    useAiResultGateStore.setState({ session: null });
    unregisterGateHost = registerAiResultGateHost();
  });

  afterEach(() => {
    unregisterGateHost();
  });

  it("E2: aiEnabled=false + 외부 프로바이더(openai)면 게이트를 열지 않고 generate 미호출, false", async () => {
    useSettingsStore.setState({ aiEnabled: false, aiConfirmBeforeApply: true } as never);
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_provider: "openai" } });
      return Promise.resolve(undefined);
    });
    const generate = vi.fn(async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "x", preview: "x" }));
    const apply = vi.fn(async () => {});

    const ok = await runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, apply);

    expect(ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(useAiResultGateStore.getState().session).toBeNull();
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  it("E2: aiEnabled=false 라도 로컬 ollama면 막지 않는다(연결 실패는 실제 호출이 알려준다)", async () => {
    useSettingsStore.setState({ aiEnabled: false, aiConfirmBeforeApply: false } as never);
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_provider: "ollama" } });
      return Promise.resolve(undefined);
    });
    const generate = vi.fn(async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "x", preview: "x" }));
    const apply = vi.fn(async () => {});

    const ok = await runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, apply);

    expect(ok).toBe(true);
    expect(generate).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith("x");
  });

  it("E2: aiEnabled=true 면 프로바이더와 무관하게 막지 않는다", async () => {
    useSettingsStore.setState({ aiEnabled: true, aiConfirmBeforeApply: false } as never);
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_provider: "openai" } });
      return Promise.resolve(undefined);
    });
    const generate = vi.fn(async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "x", preview: "x" }));

    const ok = await runWithAiResultGate({ title: "t", target: "target", kind: "text" }, generate, async () => {});

    expect(ok).toBe(true);
    expect(generate).toHaveBeenCalled();
  });

  it("E3: bypass 경로 — 빈 문자열 결과는 apply 를 부르지 않고 false", async () => {
    useSettingsStore.setState({ aiEnabled: true, aiConfirmBeforeApply: false } as never);
    const apply = vi.fn(async () => {});

    const ok = await runWithAiResultGate(
      { title: "t", target: "target", kind: "text" },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "   ", preview: "" }),
      apply,
    );

    expect(ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("E3: 게이트 경로 — 빈 문자열 결과에서 [삽입]을 눌러도 apply 를 부르지 않는다", async () => {
    useSettingsStore.setState({ aiEnabled: true, aiConfirmBeforeApply: true } as never);
    const apply = vi.fn(async () => {});

    const runPromise = runWithAiResultGate(
      { title: "t", target: "target", kind: "text" },
      async (): Promise<AiGenerateOutcome<string>> => ({ ok: true, raw: "", preview: "" }),
      apply,
    );

    await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));
    useAiResultGateStore.getState().decide("insert");

    expect(await runPromise).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("E4: 빠른 연속 오픈 — 첫 세션이 pending이면 그 request_id로 ai_cancel_call을 쏜다", async () => {
    useSettingsStore.setState({ aiEnabled: true, aiConfirmBeforeApply: true } as never);
    const gate1 = openAiResultGate({ title: "a", target: "target", kind: "text" });
    const firstRequestId = useAiResultGateStore.getState().session?.requestId;
    expect(useAiResultGateStore.getState().session?.status).toBe("pending");
    callMock.mockClear();

    const gate2 = openAiResultGate({ title: "b", target: "target", kind: "text" });

    expect(callMock).toHaveBeenCalledWith("ai_cancel_call", { request_id: firstRequestId });
    gate1.close();
    gate2.close();
  });

  it("E4: 이전 세션이 이미 result/error 였다면 세션 교체 때 취소를 쏘지 않는다", async () => {
    useSettingsStore.setState({ aiEnabled: true, aiConfirmBeforeApply: true } as never);
    const gate1 = openAiResultGate({ title: "a", target: "target", kind: "text" });
    gate1.setResult("done");
    callMock.mockClear();

    const gate2 = openAiResultGate({ title: "b", target: "target", kind: "text" });

    expect(callMock).not.toHaveBeenCalledWith("ai_cancel_call", expect.anything());
    gate1.close();
    gate2.close();
  });
});
