import { createElement, type ReactNode } from "react";
import { act, render } from "@testing-library/react";

/**
 * Mount a probe that must settle below `maxRenders`. A self-sustaining
 * effect→setState loop blows past the ceiling and throws.
 */
export function assertRenderSettles(
  renderProbe: (renderCount: number) => ReactNode,
  maxRenders = 40,
): { renders: number } {
  let renders = 0;
  function Probe() {
    renders++;
    if (renders > maxRenders) {
      throw new Error(`render storm: ${renders} renders (loop)`);
    }
    return renderProbe(renders);
  }
  render(createElement(Probe));
  return { renders };
}

/**
 * Drain microtasks / macrotasks that hooks schedule from effects
 * (dynamic import, then setState). Without this, an effect that only
 * setStates after `await` never runs during the assertion window.
 */
async function flushHookAsyncWork(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  }
}

/**
 * Same gate for a custom hook: the probe calls `useHook` every render and
 * fails if renders keep climbing (effect→setState feedback).
 *
 * Flushes async effect bodies so the real setState path runs — a sync-only
 * mount cannot catch loops driven by `await import` / `await call` then setState.
 */
export async function assertHookSettles(
  useHook: () => void,
  maxRenders = 40,
): Promise<{ renders: number }> {
  let renders = 0;
  function Probe() {
    renders++;
    if (renders > maxRenders) {
      throw new Error(`render storm: ${renders} renders (loop)`);
    }
    useHook();
    return null;
  }
  render(createElement(Probe));

  // Keep draining until the render count is stable across two flush rounds,
  // or until a storm throws from Probe.
  let last = -1;
  let stable = 0;
  for (let i = 0; i < maxRenders + 5; i++) {
    await flushHookAsyncWork(2);
    if (renders === last) {
      stable++;
      if (stable >= 2) break;
    } else {
      stable = 0;
      last = renders;
    }
    if (renders > maxRenders) {
      throw new Error(`render storm: ${renders} renders (loop)`);
    }
  }
  return { renders };
}
