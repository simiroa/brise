import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const emitNoticeMock = vi.fn();
const callSilentMock = vi.fn().mockResolvedValue({ settings: {} });
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callSilentMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: vi.fn(() => () => {}),
}));

import { MobileAiResultSheet } from "./MobileAiResultSheet";
import { openAiResultGate, useAiResultGateStore } from "../stores/aiResultGate";

// P6/Q1 — 버리기 이유(K3) 제거: [버리기]를 누르면 즉시 discard 결정되고 이유 칩이 뜨지 않는다.
describe("MobileAiResultSheet — discard behavior (K3 removed)", () => {
  beforeEach(() => {
    emitNoticeMock.mockReset();
    callSilentMock.mockReset().mockResolvedValue({ settings: {} });
    useAiResultGateStore.setState({ session: null });
  });

  it("[버리기]를 누르면 즉시 discard 결정되며 이유 칩이나 ai_call_annotate 호출이 없다", async () => {
    const gate = openAiResultGate({ title: "요약", target: "새 섹션으로 삽입 예정", kind: "text" });
    gate.setResult("생성된 본문");
    render(<MobileAiResultSheet />);

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
    render(<MobileAiResultSheet />);

    const decision = gate.waitDecision();
    await userEvent.click(screen.getByTestId("ai-result-abort"));

    expect(await decision).toBe("discard");
    expect(callSilentMock).not.toHaveBeenCalledWith("ai_call_annotate", expect.anything());
  });
});
