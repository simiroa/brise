import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const emitNoticeMock = vi.fn();
const callSilentMock = vi.fn().mockResolvedValue({ settings: {} });
// C(AUDIT-2026-09-26): tracks calls that went specifically through the `call()` alias — both
// aliases resolve/reject via the same callSilentMock above (so every other assertion in this
// file that checks callSilentMock keeps working unchanged), but this lets the openAiSettings
// fix be verified as actually routed through call() (which toasts on failure in the real
// lib/invoke.ts), not still silently through callSilent().
const callOnlyMock = vi.fn();
// K1(2026-09-06) — flushAll(창 닫기 경로)이 부르는 콜백을 잡아 뒀다가 테스트에서 직접 실행한다.
// vi.fn(() => () => {}) 로 항상 진짜 해제 함수를 돌려준다 — @testing-library/react 는 매 테스트
// 뒤 자동 unmount(cleanup)를 돌리는데, AiResultModal의 effect cleanup이 이 반환값을 함수로
// 호출한다(installAiResultGateFlushGuard). undefined 를 돌려주면 그 자동 unmount마다 이 파일의
// 모든 테스트가 "uninstallFlushGuard is not a function" 으로 깨진다.
const flushCallbacks: Array<(reason?: "close") => Promise<unknown>> = [];
const registerFlushMock = vi.fn((f: () => Promise<unknown>) => {
  flushCallbacks.push(f);
  return () => {
    const idx = flushCallbacks.indexOf(f);
    if (idx >= 0) flushCallbacks.splice(idx, 1);
  };
});
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => {
    callOnlyMock(...args);
    return callSilentMock(...args);
  },
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: (f: () => Promise<unknown>) => registerFlushMock(f),
}));

import { AiResultModal } from "./AiResultModal";
import { primaryGuard } from "./ai/AiResultPanel";
import { openAiResultGate, useAiResultGateStore } from "../stores/aiResultGate";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";

// PLAN-2026-09-05 §2 (트랙 B) — 대기/결과/실패 3상태 + 버튼이 올바른 decide() 값을 보내는지만
// 검증한다. runAiAction.ts 쪽 테스트가 이 결정들이 실제로 insert/replaceSection 호출 여부를
// 좌우한다는 것을 이미 못박고 있으므로, 여기서는 모달 자체의 렌더/버튼 계약만 본다.
describe("AiResultModal", () => {
  beforeEach(() => {
    emitNoticeMock.mockReset();
    callSilentMock.mockReset().mockResolvedValue({ settings: {} });
    callOnlyMock.mockReset();
    flushCallbacks.length = 0;
    useAiResultGateStore.setState({ session: null });
    // K2 — 배너 테스트가 실행 순서와 무관하게 결정적이도록 매 테스트 seen 목록을 비운다.
    useSettingsStore.setState({ seenFeatureBriefs: [] } as never);
  });

  afterEach(() => {
    // W5: openAiResultGate가 이제 ai_calls_active를 1초 간격으로 폴링한다(취소 대상 id 수집).
    // 이 파일의 테스트는 gate.close()를 부르지 않으므로, 열어 뒀다 바로 닫아 그 타이머가 다음
    // 테스트/파일로 새지 않게 정리한다(openAiResultGate 진입 시 이전 타이머를 멈추고, close()가
    // 이번 것을 멈춘다).
    openAiResultGate({ title: "", target: "", kind: "text" }).close();
  });

  it("세션이 없으면 아무 것도 렌더하지 않는다", () => {
    // ModalShell 은 document.body 로 포탈되므로 (컨테이너가 아니라) 문서 전체에서 확인한다.
    render(<AiResultModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("대기 상태: [중단]을 누르면 discard 결정과 버림 안내가 함께 나간다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    render(<AiResultModal />);
    expect(screen.getByTestId("ai-result-abort")).toBeTruthy();
    // 대기 상태에는 결과/실패 버튼이 없다.
    expect(screen.queryByTestId("ai-result-insert")).toBeNull();

    const decision = gate.waitDecision();
    await userEvent.click(screen.getByTestId("ai-result-abort"));

    expect(await decision).toBe("discard");
    // WB(2026-09-05) B1: decide()가 ai_cancel_call 응답을 기다린 뒤 안내를 띄운다(비동기) — 목이
    // count 없는 { settings: {} }를 돌려주므로 count>0이 아니라 "45초 뒤 스스로 끝난다"쪽이다.
    await vi.waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(emitNoticeMock.mock.calls[0][0]).toContain("45");
  });

  // 2026-09-27: AI 경험이 모달 중심이 되며 에디터 빛줄기가 스크림 뒤로 가려졌다 — 생성 중엔 이 창이 든다.
  it("빛줄기: 생성 중에만 카드 테두리에 돌고, 결과가 오면 사라진다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    render(<AiResultModal />);
    const card = screen.getByTestId("modal-shell");
    expect(card.getAttribute("data-ai-glow")).toBe("active");
    expect(card.getAttribute("data-ai-glow-beam")).toBe("true");
    await act(async () => {
      gate.setResult("생성된 본문");
    });
    expect(screen.getByTestId("modal-shell").getAttribute("data-ai-glow")).not.toBe("active");
    gate.close();
  });

  it("결과 상태: 프리뷰·소요시간을 보여주고 [삽입]을 누르면 insert 결정", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setResult("생성된 본문", { durationMs: 4200 });
    const decision = gate.waitDecision();
    render(<AiResultModal />);

    expect(screen.getByTestId("ai-result-preview").textContent).toBe("생성된 본문");
    await userEvent.click(screen.getByTestId("ai-result-insert"));

    expect(await decision).toBe("insert");
  });

  it("결과 상태: [다시 생성]은 즉시 retry 결정을 보낸다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setResult("생성된 본문");
    render(<AiResultModal />);

    const decision = gate.waitDecision();
    await userEvent.click(screen.getByTestId("ai-result-retry"));
    expect(await decision).toBe("retry");
  });

  // P6/Q1 — 버리기 이유(K3) 제거: [버리기]를 누르면 즉시 discard 결정되고 이유 칩이 뜨지 않는다.
  describe("P6/Q1: [버리기] 이유 수집 제거 및 즉시 discard", () => {
    it("[버리기]를 누르면 즉시 discard 결정되며 이유 칩이나 ai_call_annotate 호출이 없다", async () => {
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      gate.setResult("생성된 본문");
      render(<AiResultModal />);

      const decision = gate.waitDecision();
      await userEvent.click(screen.getByTestId("ai-result-discard"));

      expect(screen.queryByTestId("ai-result-discard-reason-wrong")).toBeNull();
      expect(screen.queryByTestId("ai-result-discard-reason-too_long")).toBeNull();
      expect(screen.queryByTestId("ai-result-discard-reason-bad_format")).toBeNull();
      expect(screen.queryByTestId("ai-result-discard-reason-other")).toBeNull();
      expect(screen.queryByTestId("ai-result-discard-skip")).toBeNull();

      expect(callSilentMock).not.toHaveBeenCalledWith("ai_call_annotate", expect.anything());
      expect(await decision).toBe("discard");
    });

    it("대기 중 [중단]은 이유를 묻지 않고 즉시 discard 결정", async () => {
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      render(<AiResultModal />);

      const decision = gate.waitDecision();
      await userEvent.click(screen.getByTestId("ai-result-abort"));

      expect(await decision).toBe("discard");
      expect(callSilentMock).not.toHaveBeenCalledWith("ai_call_annotate", expect.anything());
    });

    it("주 버튼은 역할이 변경된 직후 400ms 동안 오클릭 방지 가드로 클릭을 무시한다", async () => {
      // 테스트 환경은 가드가 0 이다(결과가 뜨자마자 누르는 테스트가 많다) — 이 테스트만 켠다.
      primaryGuard.ms = 400;
      onTestFinished(() => {
        primaryGuard.ms = 0;
      });
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      const { rerender } = render(<AiResultModal />);

      // pending 상태에서 result로 전환 -> 역할이 'abort'에서 'insert'로 변경됨
      gate.setResult("생성된 본문");
      rerender(<AiResultModal />);

      let resolved = false;
      const decisionPromise = gate.waitDecision().then((d) => {
        resolved = true;
        return d;
      });

      // 변경 직후 바로 클릭 -> 무시되어야 함
      await userEvent.click(screen.getByTestId("ai-result-insert"));
      expect(resolved).toBe(false);

      // 400ms 대기 후 다시 클릭 -> 정상 실행되어야 함
      await new Promise((r) => setTimeout(r, 450));
      await userEvent.click(screen.getByTestId("ai-result-insert"));

      expect(await decisionPromise).toBe("insert");
    });

    it("패널이 새로 선 순간도 가드한다 — [보내기]를 두 번 누르면 두 번째가 막 나타난 [중단]에 떨어지지 않는다", async () => {
      primaryGuard.ms = 400;
      onTestFinished(() => {
        primaryGuard.ms = 0;
      });
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      let decided = false;
      void gate.waitDecision().then(() => {
        decided = true;
      });
      render(<AiResultModal />);
      await userEvent.click(screen.getByTestId("ai-result-abort"));
      expect(decided).toBe(false);
      gate.setResult("x");
    });
  });

  it("실패 상태: 마스킹된 에러 메시지를 보여주고 [다시 생성]을 누르면 retry 결정", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "diagram" });
    gate.setError("문제가 발생했습니다");
    const decision = gate.waitDecision();
    render(<AiResultModal />);

    // 원문은 접힘 영역(<details>)에 그대로 남는다 — E1.
    expect(screen.getByText("문제가 발생했습니다")).toBeTruthy();
    expect(screen.queryByTestId("ai-result-insert")).toBeNull();
    await userEvent.click(screen.getByTestId("ai-result-retry"));

    expect(await decision).toBe("retry");
  });

  it("결과 상태: 빈 결과면 [삽입] 대신 [다시 생성]이 주 버튼으로 뜨고 안내 문구가 뜬다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setResult("   ");
    render(<AiResultModal />);

    expect(screen.queryByTestId("ai-result-insert")).toBeNull();
    expect(screen.getByTestId("ai-result-retry")).toBeTruthy();
    expect(screen.getByTestId("ai-result-discard")).toBeTruthy();
    expect(screen.getByText("The result is empty")).toBeTruthy();
  });

  // E1 — 실패 종류별 행동 버튼. classifyAiError는 별도로 단위 테스트가 있으므로 여기서는
  // 모달이 그 결과에 따라 올바른 버튼을 그리는지만 본다.
  it("실패 상태(no_key): [AI 설정 열기]가 뜨고 [다시 생성]은 없다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setError("openai request failed with status 401 — check your API key: {}");
    render(<AiResultModal />);

    expect(screen.getByTestId("ai-result-open-settings")).toBeTruthy();
    expect(screen.queryByTestId("ai-result-retry")).toBeNull();
    await userEvent.click(screen.getByTestId("ai-result-open-settings"));
    // 키·모델·연결 문제는 AI 연결 페이지로 바로(딥링크).
    expect(callSilentMock).toHaveBeenCalledWith("settings_window_open", { page: "ai" });
  });

  // C(AUDIT-2026-09-26): [AI 설정 열기]가 예전엔 callSilent(...).catch(() => {}) 라 실패해도
  // 완전 무음이었다(사용자가 누른 버튼인데 아무 반응 없음). call() 을 거치는지(실제 lib/invoke.ts
  // 라면 실패 시 토스트) callOnlyMock 으로 직접 확인하고, 실패해도 unhandled rejection 없이
  // 조용히 끝나는지(try/catch)도 함께 본다.
  it("[AI 설정 열기]는 call() 을 거치고(callSilent 아님), 실패해도 unhandled rejection 없이 끝난다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setError("openai request failed with status 401 — check your API key: {}");
    callSilentMock.mockRejectedValueOnce(new Error("window open failed"));
    render(<AiResultModal />);

    await userEvent.click(screen.getByTestId("ai-result-open-settings"));
    expect(callOnlyMock).toHaveBeenCalledWith("settings_window_open", { page: "ai" });
  });

  it("실패 상태(model_missing + ollama): pull 명령 복사 버튼이 뜬다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setError('ollama request failed with status 404: {"error":"model \'llama9\' not found, try pulling it first"}');
    // provider/model은 폴링(ai_calls_active)이 채운다 — 테스트에서는 세션을 직접 패치해 확정한다.
    useAiResultGateStore.setState((s) => (s.session ? { session: { ...s.session, provider: "ollama", model: "llama9" } } : s));
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
    render(<AiResultModal />);

    const copyBtn = screen.getByTestId("ai-result-copy-pull");
    await userEvent.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalledWith("ollama pull llama9");
  });

  it("실패 상태(input_too_long): [다시 생성]이 숨겨지고 안내 문구가 뜬다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setError("prompt and context exceed AI input limit of 8000 characters (9000); reduce or summarize the input");
    render(<AiResultModal />);

    expect(screen.queryByTestId("ai-result-retry")).toBeNull();
    expect(screen.queryByTestId("ai-result-open-settings")).toBeNull();
    // uiLang은 테스트 기본값 "en"(src/test/setup.ts) — 영문 문구로 확인한다.
    expect(screen.getByText("Select a shorter section and try again.")).toBeTruthy();
  });

  // WG(2026-09-06) G1 — 창 닫기/새로고침 중 pending 세션 정리. 이 컴포넌트가 마운트돼 있는 동안만
  // pagehide 가드가 걸린다는 계약이라 render() 뒤에 이벤트를 쏜다.
  it("G1: 마운트 중 pending 상태에서 pagehide가 오면 ai_cancel_call을 그 request_id로 부르고 세션이 즉시 닫힌다", () => {
    openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    const requestId = useAiResultGateStore.getState().session?.requestId;
    render(<AiResultModal />);

    window.dispatchEvent(new Event("pagehide"));

    expect(callSilentMock).toHaveBeenCalledWith("ai_cancel_call", { request_id: requestId });
    expect(useAiResultGateStore.getState().session).toBeNull();
  });

  it("G1: 결과 상태(이미 끝난 호출)에서 pagehide가 와도 취소는 안 쏘지만 세션은 닫는다", () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setResult("생성된 본문");
    render(<AiResultModal />);
    callSilentMock.mockClear();

    window.dispatchEvent(new Event("pagehide"));

    expect(callSilentMock).not.toHaveBeenCalledWith("ai_cancel_call", expect.anything());
    expect(useAiResultGateStore.getState().session).toBeNull();
  });

  it("G1: 언마운트 뒤에는 pagehide가 와도 아무 일도 하지 않는다", () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    const { unmount } = render(<AiResultModal />);
    unmount();
    callSilentMock.mockClear();

    window.dispatchEvent(new Event("pagehide"));

    expect(callSilentMock).not.toHaveBeenCalledWith("ai_cancel_call", expect.anything());
    // 언마운트 뒤 가드가 해제됐으므로 세션은 그대로 남아 있다(이 테스트만의 관찰용 — 실제
    // 화면에선 언마운트될 만큼 창이 닫히면 세션 상태를 볼 사람이 없다).
    expect(useAiResultGateStore.getState().session).not.toBeNull();
    gate.close();
  });

  // K1(2026-09-06) — Tauri 창 닫기는 pagehide가 아니라 flushAll(registerFlush로 등록된 콜백들)을
  // 거친다. registerFlush는 새 core:window:allow-* 권한 없이 이미 배선돼 있으므로, 이 컴포넌트가
  // 마운트돼 있는 동안 등록한 콜백을 여기서 직접 실행해 flushAll이 부른 상황을 재현한다.
  describe("K1: 창 닫기(flushAll) 중 pending 세션 정리", () => {
    it("마운트 중 pending 상태에서 flushAll이 오면 ai_cancel_call을 그 request_id로 부르고 세션이 즉시 닫힌다", async () => {
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      const requestId = gate.requestId();
      render(<AiResultModal />);

      expect(flushCallbacks.length).toBeGreaterThan(0);
      // 평범한 flush(주기 스냅샷·노트 전환)는 세션을 건드리지 않는다(2026-09-27 — 예전엔 생성 중인 결과가
      // 스냅샷 타이머에 조용히 지워졌다). 창 닫기의 flushAll("close") 만 치운다.
      await Promise.all(flushCallbacks.map((f) => f()));
      expect(useAiResultGateStore.getState().session?.requestId).toBe(requestId);
      expect(callSilentMock).not.toHaveBeenCalledWith("ai_cancel_call", expect.anything());
      await Promise.all(flushCallbacks.map((f) => f("close")));

      expect(callSilentMock).toHaveBeenCalledWith("ai_cancel_call", { request_id: requestId });
      expect(useAiResultGateStore.getState().session).toBeNull();
    });

    it("결과 상태(이미 끝난 호출)에서 flushAll이 와도 취소는 안 쏘지만 세션은 닫는다", async () => {
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      gate.setResult("생성된 본문");
      render(<AiResultModal />);
      callSilentMock.mockClear();

      await Promise.all(flushCallbacks.map((f) => f("close")));

      expect(callSilentMock).not.toHaveBeenCalledWith("ai_cancel_call", expect.anything());
      expect(useAiResultGateStore.getState().session).toBeNull();
    });

    it("언마운트 뒤에는 등록이 해제돼 콜백 목록에서 빠진다", () => {
      openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      const { unmount } = render(<AiResultModal />);
      expect(flushCallbacks.length).toBeGreaterThan(0);
      unmount();
      expect(flushCallbacks.length).toBe(0);
    });
  });

  // K2(2026-09-06) — 첫 노출 안내 배너. seenFeatureBriefs에 "ai_result_gate"가 없을 때만 뜬다.
  describe("K2: 첫 노출 안내 배너", () => {
    it("seen이 비어 있으면(첫 실행) 배너가 뜬다", () => {
      openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      render(<AiResultModal />);
      expect(screen.getByTestId("ai-result-first-brief")).toBeTruthy();
    });

    it("이미 seenFeatureBriefs에 있으면 배너가 안 뜬다", () => {
      useSettingsStore.setState({ seenFeatureBriefs: ["ai_result_gate"] } as never);
      openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      render(<AiResultModal />);
      expect(screen.queryByTestId("ai-result-first-brief")).toBeNull();
    });

    it("배너의 [닫기]를 누르면 seenFeatureBriefs에 id가 추가되고, 다시 열어도 배너가 없다", async () => {
      openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      const { unmount } = render(<AiResultModal />);

      await userEvent.click(screen.getByTestId("ai-result-first-brief-dismiss"));
      expect(useSettingsStore.getState().seenFeatureBriefs).toContain("ai_result_gate");

      unmount();
      openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      render(<AiResultModal />);
      expect(screen.queryByTestId("ai-result-first-brief")).toBeNull();
    });

    it("첫 [삽입] 결정 시에도 seenFeatureBriefs에 id가 추가된다", async () => {
      const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      gate.setResult("생성된 본문");
      render(<AiResultModal />);

      await userEvent.click(screen.getByTestId("ai-result-insert"));
      expect(useSettingsStore.getState().seenFeatureBriefs).toContain("ai_result_gate");
    });

    it("[설정 열기]를 누르면 settings_window_open을 부른다", async () => {
      openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
      render(<AiResultModal />);

      await userEvent.click(screen.getByTestId("ai-result-first-brief-settings"));
      // 안내문이 가리키는 "설정 → AI → 권한" 으로 바로.
      expect(callSilentMock).toHaveBeenCalledWith("settings_window_open", { page: "ai_permissions" });
    });
  });

  describe("Wave 3 (W3: 결과 렌더링)", () => {
    it("시트 결과 파싱 오류 시 fallback(경고 문구 및 원문 접힘)을 렌더링한다", () => {
      const gate = openAiResultGate({ title: "시트 결과", target: "새 섹션으로 삽입 예정", kind: "sheet" });
      gate.setResult("invalid sheet json");
      render(<AiResultModal />);

      expect(screen.getByRole("alert").textContent).toBe(t("aiResult.sheet_parse_error"));
      expect(screen.getByText(t("aiResult.raw_error_label"))).toBeTruthy();
    });

    it("관계도 결과 파싱 오류 시 fallback(경고 문구 및 원문 접힘)을 렌더링한다", () => {
      const gate = openAiResultGate({ title: "관계도 결과", target: "새 섹션으로 삽입 예정", kind: "diagram" });
      gate.setResult("invalid diagram json");
      render(<AiResultModal />);

      expect(screen.getByRole("alert").textContent).toBe(t("aiResult.diagram_parse_error"));
      expect(screen.getByText(t("aiResult.raw_error_label"))).toBeTruthy();
    });

    it("유효한 관계도 결과 시 요약 통계와 노드 칩을 렌더링한다", () => {
      const gate = openAiResultGate({ title: "관계도 결과", target: "새 섹션으로 삽입 예정", kind: "diagram" });
      const validDiagram = JSON.stringify({
        nodes: [
          { id: "n1", label: "노드1" },
          { id: "n2", label: "노드2" },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n2", label: "연결" },
        ],
      });
      gate.setResult(validDiagram);
      render(<AiResultModal />);

      expect(screen.getByTestId("ai-result-diagram-stats")).toBeTruthy();
      expect(screen.getByText("노드1")).toBeTruthy();
      expect(screen.getByText("노드2")).toBeTruthy();
    });
  });
});
