import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

type DropPayload = { type: string; paths?: string[]; position?: { x: number; y: number } };
let dropHandler: ((e: { payload: DropPayload }) => void) | null = null;
const onDragDropEventMock = vi.fn();
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: DropPayload }) => void) => {
      onDragDropEventMock();
      dropHandler = cb;
      return Promise.resolve(() => {
        unlistenMock();
        dropHandler = null;
      });
    },
  }),
}));

import { useFileDropZone } from "./useFileDropZone";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** 실제 구독은 webview 모듈을 동적 import 한 뒤라 마이크로태스크 몇 번으론 안 닿는다. */
async function subscribed(): Promise<void> {
  await waitFor(() => expect(dropHandler).not.toBeNull());
  await flush();
}

function zone(rect: { left: number; right: number; top: number; bottom: number }) {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => rect as DOMRect;
  return el;
}

function drop(x: number, y: number) {
  act(() => {
    dropHandler!({ payload: { type: "drop", paths: ["C:/a.png"], position: { x, y } } });
  });
}

describe("useFileDropZone — 창 하나에 실제 구독 하나", () => {
  beforeEach(async () => {
    await flush(); // 앞 테스트 언마운트의 지연 해제를 흘린다
    dropHandler = null;
    onDragDropEventMock.mockClear();
    unlistenMock.mockClear();
  });

  it("존 둘이 마운트돼도 onDragDropEvent 는 한 번, 드롭은 각 존이 자기 적중으로 받는다", async () => {
    const elA = zone({ left: 0, right: 100, top: 0, bottom: 100 });
    const elB = zone({ left: 200, right: 300, top: 0, bottom: 100 });
    const dropA = vi.fn();
    const dropB = vi.fn();
    const a = renderHook(() => useFileDropZone(() => elA, { onDrop: dropA }));
    const b = renderHook(() => useFileDropZone(() => elB, { onDrop: dropB }));
    await subscribed();
    expect(onDragDropEventMock).toHaveBeenCalledTimes(1);

    drop(250, 50);
    expect(dropA).toHaveBeenCalledWith(["C:/a.png"], { x: 250, y: 50 }, false);
    expect(dropB).toHaveBeenCalledWith(["C:/a.png"], { x: 250, y: 50 }, true);

    // 한 존이 떠나도 남은 존은 계속 받고, 실제 해제는 없다.
    a.unmount();
    await flush();
    expect(unlistenMock).not.toHaveBeenCalled();
    dropA.mockClear();
    drop(250, 50);
    expect(dropA).not.toHaveBeenCalled();
    expect(dropB).toHaveBeenCalledTimes(2);

    // 마지막 존이 떠나면 실제로 해제한다.
    b.unmount();
    await waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it("새 콜백으로 리렌더돼도 재구독하지 않고 최신 콜백을 부른다", async () => {
    const el = zone({ left: 0, right: 100, top: 0, bottom: 100 });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cb }) => useFileDropZone(() => el, { onDrop: cb }), {
      initialProps: { cb: first },
    });
    await subscribed();
    rerender({ cb: second });
    await flush();
    expect(onDragDropEventMock).toHaveBeenCalledTimes(1);
    drop(10, 10);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(["C:/a.png"], { x: 10, y: 10 }, true);
    unmount();
  });

  it("enter/over 는 적중일 때만 dragOver, leave 는 끈다", async () => {
    const el = zone({ left: 0, right: 100, top: 0, bottom: 100 });
    const { result, unmount } = renderHook(() => useFileDropZone(() => el, { onDrop: vi.fn() }));
    await subscribed();
    act(() => dropHandler!({ payload: { type: "over", position: { x: 10, y: 10 } } }));
    expect(result.current.dragOver).toBe(true);
    act(() => dropHandler!({ payload: { type: "leave" } }));
    expect(result.current.dragOver).toBe(false);
    unmount();
  });

  it("disabled 존은 구독하지 않는다", async () => {
    const el = zone({ left: 0, right: 100, top: 0, bottom: 100 });
    const { unmount } = renderHook(() => useFileDropZone(() => el, { onDrop: vi.fn() }, false));
    await flush();
    expect(onDragDropEventMock).not.toHaveBeenCalled();
    unmount();
  });
});
