import { beforeEach, describe, expect, it, vi } from "vitest";

const emitNoticeMock = vi.fn();
vi.mock("./invoke", () => ({ emitNotice: (...a: unknown[]) => emitNoticeMock(...a) }));

let nextToastId = 100;
const showToastOnlyMock = vi.fn((_label: string, _onUndo: () => void, _opts?: unknown) => nextToastId++);
const dismissToastMock = vi.fn();
vi.mock("./undo", () => ({
  showToastOnly: (...a: Parameters<typeof showToastOnlyMock>) => showToastOnlyMock(...a),
  dismissToast: (...a: unknown[]) => dismissToastMock(...a),
}));

import {
  dismissNotice,
  pushNotice,
  removeNotice,
  resetFrameNoticesForTests,
  runNoticeAction,
  useFrameNotices,
} from "./frameNotices";

const keys = () => useFrameNotices.getState().notices.map((n) => n.key);

describe("frameNotices — 토스트 + 벨 한 목록", () => {
  beforeEach(() => {
    resetFrameNoticesForTests();
    emitNoticeMock.mockClear();
    showToastOnlyMock.mockClear();
    dismissToastMock.mockClear();
  });

  it("처음 생길 때만 토스트 한 번 — 같은 key 를 다시 올려도 내용만 바뀐다", () => {
    pushNotice({ key: "a", text: "첫 문구", actionLabel: "열기", onAction: vi.fn() });
    pushNotice({ key: "a", text: "바뀐 문구", actionLabel: "열기", onAction: vi.fn() });
    expect(showToastOnlyMock).toHaveBeenCalledTimes(1);
    expect(useFrameNotices.getState().notices).toHaveLength(1);
    expect(useFrameNotices.getState().notices[0].text).toBe("바뀐 문구");
    // 지웠다가 다시 올려도(예: 저장 실패 롤백) 토스트는 다시 안 뜬다.
    removeNotice("a");
    pushNotice({ key: "a", text: "또", actionLabel: "열기", onAction: vi.fn() });
    expect(showToastOnlyMock).toHaveBeenCalledTimes(1);
  });

  it("행동이 없는 알림은 글만 있는 토스트(emitNotice)로 한 번, 벨 목록엔 남는다", () => {
    pushNotice({ key: "storage", text: "용량 한도를 넘었어요" });
    expect(emitNoticeMock).toHaveBeenCalledWith("용량 한도를 넘었어요");
    expect(showToastOnlyMock).not.toHaveBeenCalled();
    expect(keys()).toEqual(["storage"]);
  });

  it("토스트 버튼은 누를 때 key 로 **현재** 알림을 찾아 실행한다 — 낡은 클로저가 아니다", () => {
    const first = vi.fn();
    const second = vi.fn();
    pushNotice({ key: "s", text: "t", actionLabel: "수락", onAction: first });
    const toastAction = showToastOnlyMock.mock.calls[0][1];
    // 같은 key 로 더 새 알림이 올라왔다 — 토스트 버튼은 이제 그 새 행동을 부른다.
    pushNotice({ key: "s", text: "t2", actionLabel: "수락", onAction: second });
    toastAction();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("이미 처리돼 사라진 알림의 토스트 버튼은 아무 일도 하지 않고, 처리되면 그 토스트도 닫힌다", () => {
    const action = vi.fn();
    pushNotice({ key: "s", text: "t", actionLabel: "수락", onAction: action });
    const toastAction = showToastOnlyMock.mock.calls[0][1];
    removeNotice("s");
    const toastId = showToastOnlyMock.mock.results[0].value; // 모듈 수준 id 카운터라 테스트마다 값이 다르다
    expect(dismissToastMock).toHaveBeenCalledWith(toastId); // 알림이 지워지면 떠 있는 토스트도 닫는다
    toastAction(); // 그래도 남아 있던 낡은 버튼을 누르면
    expect(action).not.toHaveBeenCalled();
    expect(keys()).toEqual([]);
  });

  it("dismissNotice 는 onDismiss 의 부수효과를 부르고 지운다 / removeNotice 는 조용히 지운다", () => {
    const onDismiss = vi.fn();
    pushNotice({ key: "d", text: "t", actionLabel: "x", onAction: vi.fn(), onDismiss });
    pushNotice({ key: "r", text: "t", actionLabel: "x", onAction: vi.fn(), onDismiss });
    removeNotice("r");
    expect(onDismiss).not.toHaveBeenCalled();
    dismissNotice("d");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(keys()).toEqual([]);
    dismissNotice("nope"); // 없는 key 는 무시
  });

  it("runNoticeAction 은 없는 key 를 무시한다", () => {
    expect(() => runNoticeAction("missing")).not.toThrow();
  });
});
