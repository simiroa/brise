import { describe, it, expect, vi } from "vitest";
import { createStableRectAnchor } from "./stableAnchor";

function rect(n: number): DOMRect {
  return { top: n, left: n, right: n, bottom: n, width: 0, height: 0, x: n, y: n, toJSON: () => ({}) } as DOMRect;
}

describe("createStableRectAnchor (N1-2 anchor memoization)", () => {
  it("reuses the cached rect while (from,to) is unchanged — e.g. a bold toggle mid-selection", () => {
    const anchor = createStableRectAnchor();
    const compute = vi.fn(() => rect(1));
    const r1 = anchor(10, 20, compute);
    const r2 = anchor(10, 20, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(r2).toBe(r1);
  });

  it("recomputes when the selection range changes", () => {
    const anchor = createStableRectAnchor();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return rect(calls);
    };
    const r1 = anchor(10, 20, compute);
    const r2 = anchor(30, 40, compute);
    expect(calls).toBe(2);
    expect(r2).not.toBe(r1);
  });

  it("recomputes when only one side of the range moves (extend-selection case)", () => {
    const anchor = createStableRectAnchor();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return rect(calls);
    };
    anchor(10, 20, compute);
    anchor(10, 25, compute); // `to` moved — a real selection change, not a formatting toggle
    expect(calls).toBe(2);
  });
});

// 릴리즈 후속(owner 미결 #3): 선택을 유지한 채 스크롤하면 프레임이 옛 화면 좌표에 얼어붙어
// 글자는 흘러가고 메뉴만 남았다. 에디터는 창이 아니라 안쪽 컨테이너가 스크롤되므로, 호출자가
// 콘텐츠 top 을 지문으로 넘겨 그 순간에만 다시 재도록 한다.
describe("viewportEpoch", () => {
  it("지문이 바뀌면 같은 선택이라도 다시 잰다 (스크롤)", () => {
    const anchor = createStableRectAnchor();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { top: calls } as DOMRect;
    };
    anchor(3, 9, compute, 0);
    anchor(3, 9, compute, 0);
    expect(calls).toBe(1);
    anchor(3, 9, compute, -120); // 스크롤로 콘텐츠가 밀려 올라감
    expect(calls).toBe(2);
  });

  it("지문이 그대로면 서식 토글에도 재계산하지 않는다", () => {
    const anchor = createStableRectAnchor();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { top: calls } as DOMRect;
    };
    anchor(3, 9, compute, 42);
    anchor(3, 9, compute, 42);
    anchor(3, 9, compute, 42);
    expect(calls).toBe(1);
  });
});
