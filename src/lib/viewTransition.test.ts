import { afterEach, describe, expect, it, vi } from "vitest";
import { withViewTransition } from "./viewTransition";

const doc = document as unknown as { startViewTransition?: unknown };
const mm = (reduced: boolean) =>
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }) as MediaQueryList);

afterEach(() => {
  delete doc.startViewTransition;
  vi.unstubAllGlobals();
});

describe("withViewTransition", () => {
  it("미지원이면 동기 실행", () => {
    const fn = vi.fn();
    withViewTransition(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("reduced-motion 이면 전환 없이 동기 실행", () => {
    mm(true);
    const svt = vi.fn();
    doc.startViewTransition = svt;
    const fn = vi.fn();
    withViewTransition(fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(svt).not.toHaveBeenCalled();
  });

  it("지원이면 startViewTransition 콜백 안에서 실행, 연속 호출은 이전 전환을 건너뛴다", () => {
    mm(false);
    const skips: number[] = [];
    let n = 0;
    doc.startViewTransition = vi.fn((cb: () => void) => {
      const id = ++n;
      cb();
      return { skipTransition: () => skips.push(id), finished: new Promise(() => {}) };
    });
    const a = vi.fn();
    const b = vi.fn();
    withViewTransition(a);
    withViewTransition(b);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(skips).toEqual([1]);
  });

  it("startViewTransition 이 던져도 갱신은 반드시 실행", () => {
    mm(false);
    doc.startViewTransition = () => {
      throw new Error("boom");
    };
    const fn = vi.fn();
    withViewTransition(fn);
    expect(fn).toHaveBeenCalledOnce();
  });
});
