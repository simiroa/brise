import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAiGlowForTests, useAiStore } from "../stores/ai";
import { useAiResultGateStore, type AiResultGateSession } from "../stores/aiResultGate";
import { publishRecLevel, REC_LEVEL_MIN_MS, resetRecLevel, useMobileAmbientStore } from "../stores/mobileAmbient";
import { MobileAmbient } from "./MobileAmbient";
import { EQ_BARS, EQ_FLOOR, EQ_STALE_S } from "./recEqualizerMath";

const beam = () => screen.getByTestId("mobile-ambient-beam");
const recLayer = () => screen.queryByTestId("mobile-rec");
const eq = () => screen.queryByTestId("mobile-rec-eq");
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

// ── 수동 rAF 하네스 — 프레임을 테스트가 직접 굴린다(가짜 타이머와 무관하게 결정적). ────────────────
let rafQueue = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
let rafClock = 0;
function installRaf() {
  rafQueue = new Map();
  rafSeq = 0;
  rafClock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.set(rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafQueue.delete(id); });
}
/** `n` 프레임을 `stepMs` 간격으로 굴린다. 벽시계(Date)도 같이 흘려 레벨 발행의 최소 간격이 현실과 같게 한다. */
function frames(n: number, stepMs = 60) {
  for (let i = 0; i < n; i++) {
    rafClock += stepMs;
    vi.advanceTimersByTime(stepMs);
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    act(() => { for (const [, cb] of due) cb(rafClock); });
  }
}
const barEls = () => [...document.querySelectorAll<HTMLElement>(".mobile-rec-bar")];
const heights = () => barEls().map((b) => Number(b.style.getPropertyValue("--eq-h")));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function setRec(rec: "off" | "on" | "paused") { act(() => useMobileAmbientStore.getState().setRec(rec)); }
/** 녹음 중 한 샘플 — 실제 미터(100ms)처럼 최소 간격 뒤에 발행한다. */
function level(lv: number) { vi.advanceTimersByTime(REC_LEVEL_MIN_MS); publishRecLevel(lv); }

function gateSession(status: AiResultGateSession["status"]): AiResultGateSession {
  return {
    id: 1, title: "t", target: "x", kind: "text", requestId: "r", status, startedAt: 0, attempt: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetAiGlowForTests();
  useAiStore.setState({
    aiGlowTargets: new Map(), promptPending: false, cleanupPending: false, organizePending: false,
  });
  useAiResultGateStore.setState({ session: null });
  useMobileAmbientStore.setState({ rec: "off", aiWork: 0 });
  resetRecLevel();
  installRaf();
});
afterEach(() => {
  cleanup();
  _resetAiGlowForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MobileAmbient — layer contract", () => {
  it("is a decorative layer: aria-hidden, no focusable children", () => {
    render(<MobileAmbient />);
    const root = screen.getByTestId("mobile-ambient");
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("the beam host ALWAYS carries data-ai-glow-beam (data-ai-glow without it would trigger the INK rule on every descendant)", () => {
    render(<MobileAmbient />);
    expect(beam().getAttribute("data-ai-glow-beam")).toBe("true");
    expect(beam().hasAttribute("data-ai-glow")).toBe(false);
    act(() => useAiStore.setState({ promptPending: true }));
    expect(beam().getAttribute("data-ai-glow-beam")).toBe("true");
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
  });

  it("draws no recording layer while idle", () => {
    render(<MobileAmbient />);
    expect(recLayer()).toBeNull();
  });
});

describe("MobileAmbient — AI beam", () => {
  it("active while AI is busy → fading for 300ms → attribute removed", () => {
    render(<MobileAmbient />);
    act(() => useAiStore.setState({ promptPending: true }));
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    expect(screen.getByTestId("mobile-ambient").getAttribute("data-ai")).toBe("on");

    act(() => useAiStore.setState({ promptPending: false }));
    expect(beam().getAttribute("data-ai-glow")).toBe("fading");
    tick(299);
    expect(beam().getAttribute("data-ai-glow")).toBe("fading");
    tick(1);
    expect(beam().hasAttribute("data-ai-glow")).toBe(false);
    expect(screen.getByTestId("mobile-ambient").hasAttribute("data-ai")).toBe(false);
  });

  it("follows the per-target glow map: only 'active' entries count (the store's own fade must not stretch the beam)", () => {
    render(<MobileAmbient />);
    act(() => useAiStore.getState().addGlow("note:1"));
    expect(beam().getAttribute("data-ai-glow")).toBe("active");

    act(() => useAiStore.getState().removeGlow("note:1")); // store keeps it 'active' for a 600ms minimum
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    tick(600); // → store phase 'fading' ⇒ no longer busy ⇒ beam fades
    expect(useAiStore.getState().aiGlowTargets.get("note:1")).toBe("fading");
    expect(beam().getAttribute("data-ai-glow")).toBe("fading");
    tick(300);
    expect(beam().hasAttribute("data-ai-glow")).toBe(false);
  });

  it.each(["cleanupPending", "organizePending"] as const)("%s alone lights it (no glow key needed)", (flag) => {
    render(<MobileAmbient />);
    act(() => useAiStore.setState({ [flag]: true }));
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
  });

  it("a pending result-gate session lights it; a finished one (result / error) does not", () => {
    render(<MobileAmbient />);
    act(() => useAiResultGateStore.setState({ session: gateSession("pending") }));
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    act(() => useAiResultGateStore.setState({ session: gateSession("result") }));
    expect(beam().getAttribute("data-ai-glow")).toBe("fading");
    tick(300);
    expect(beam().hasAttribute("data-ai-glow")).toBe(false);
    act(() => useAiResultGateStore.setState({ session: gateSession("error") }));
    expect(beam().hasAttribute("data-ai-glow")).toBe(false);
  });

  it("AI work that no store knows about (voice transcription) lights it via beginAiWork, and releases exactly once", () => {
    render(<MobileAmbient />);
    let end = () => {};
    let end2 = () => {};
    act(() => {
      end = useMobileAmbientStore.getState().beginAiWork();
      end2 = useMobileAmbientStore.getState().beginAiWork();
    });
    expect(useMobileAmbientStore.getState().aiWork).toBe(2);
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    act(() => end());
    act(() => end()); // idempotent — a double release must not steal the other caller's count
    expect(useMobileAmbientStore.getState().aiWork).toBe(1);
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    act(() => end2());
    expect(useMobileAmbientStore.getState().aiWork).toBe(0);
    expect(beam().getAttribute("data-ai-glow")).toBe("fading");
    tick(300);
    expect(beam().hasAttribute("data-ai-glow")).toBe(false);
  });

  it("re-busy during the fade goes straight back to active (no flicker off)", () => {
    render(<MobileAmbient />);
    act(() => useAiStore.setState({ promptPending: true }));
    act(() => useAiStore.setState({ promptPending: false }));
    tick(100);
    act(() => useAiStore.setState({ promptPending: true }));
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    tick(1000);
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
  });
});

describe("MobileAmbient — recording equalizer", () => {
  it("on → paused → off(fading, then unmounted after the fade)", () => {
    render(<MobileAmbient />);
    act(() => useMobileAmbientStore.setState({ rec: "on" }));
    expect(recLayer()?.getAttribute("data-rec")).toBe("on");
    // the old edge glow + grain are gone: a bottom band of columns instead
    expect(recLayer()?.querySelector(".mobile-rec-glow, .mobile-rec-grain, .mobile-rec-pulse")).toBeNull();
    expect(eq()?.querySelectorAll(".mobile-rec-bar")).toHaveLength(EQ_BARS);

    act(() => useMobileAmbientStore.setState({ rec: "paused" }));
    expect(recLayer()?.getAttribute("data-rec")).toBe("paused");

    act(() => useMobileAmbientStore.setState({ rec: "off" }));
    expect(recLayer()?.getAttribute("data-rec")).toBe("fading");
    tick(699);
    expect(recLayer()).not.toBeNull();
    tick(1);
    expect(recLayer()).toBeNull();
    expect(rafQueue.size).toBe(0); // the loop died with the layer
  });

  it("turning back on during the fade cancels the unmount", () => {
    render(<MobileAmbient />);
    act(() => useMobileAmbientStore.setState({ rec: "on" }));
    act(() => useMobileAmbientStore.setState({ rec: "off" }));
    tick(300);
    act(() => useMobileAmbientStore.setState({ rec: "on" }));
    tick(2000);
    expect(recLayer()?.getAttribute("data-rec")).toBe("on");
  });

  it("recording and AI together: both layers present, the wrapper marks the AI beam so CSS can dim the band", () => {
    render(<MobileAmbient />);
    act(() => {
      useMobileAmbientStore.setState({ rec: "on" });
      useAiStore.setState({ promptPending: true });
    });
    expect(recLayer()?.getAttribute("data-rec")).toBe("on");
    expect(beam().getAttribute("data-ai-glow")).toBe("active");
    expect(screen.getByTestId("mobile-ambient").getAttribute("data-ai")).toBe("on");
  });

  it("the layer stays decorative with the band in it: aria-hidden root, no focusable children", () => {
    render(<MobileAmbient />);
    setRec("on");
    const root = screen.getByTestId("mobile-ambient");
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("columns carry deterministic per-column inputs (--i / --g) and the host carries the column count (--n)", () => {
    render(<MobileAmbient />);
    setRec("on");
    expect(eq()?.style.getPropertyValue("--n")).toBe(String(EQ_BARS));
    const bars = barEls();
    expect(bars.map((b) => b.style.getPropertyValue("--i"))).toEqual(bars.map((_, i) => String(i)));
    expect(new Set(bars.map((b) => b.style.getPropertyValue("--g"))).size).toBeGreaterThan(5);
  });

  describe("level → columns", () => {
    it("the microphone level lifts the columns, and the columns differ from each other", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(2);
      const quiet = mean(heights());
      for (let i = 0; i < 8; i++) { level(0.8); frames(1, 40); }
      expect(eq()?.getAttribute("data-source")).toBe("level");
      const loud = heights();
      expect(mean(loud)).toBeGreaterThan(quiet + 0.2);
      expect(Math.max(...loud) - Math.min(...loud)).toBeGreaterThan(0.1);
      for (const h of loud) {
        expect(h).toBeGreaterThanOrEqual(EQ_FLOOR - 1e-6);
        expect(h).toBeLessThanOrEqual(1);
      }
    });

    it("is deterministic: the same inputs give the same columns on a fresh mount", () => {
      const run = () => {
        installRaf(); // a fresh queue BEFORE mounting — the mount's first frame must land in it
        const view = render(<MobileAmbient />);
        setRec("on");
        frames(1);
        for (let i = 0; i < 4; i++) { level(0.5); frames(1, 40); }
        expect(eq()?.getAttribute("data-source")).toBe("level"); // the loop really ran
        const out = heights();
        view.unmount();
        act(() => useMobileAmbientStore.setState({ rec: "off" }));
        resetRecLevel();
        return out;
      };
      const a = run();
      const b = run();
      expect(a).toHaveLength(EQ_BARS);
      expect(Math.min(...a)).toBeGreaterThanOrEqual(EQ_FLOOR - 1e-6); // real values, not 24 unwritten zeros
      expect(Math.max(...a)).toBeGreaterThan(EQ_FLOOR + 0.05);
      expect(b).toEqual(a);
    });

    it("attacks fast and releases slowly", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(2);
      const base = mean(heights());
      for (let i = 0; i < 2; i++) { level(1); frames(1, 60); }
      const up = mean(heights()) - base; // ~2 frames of attack
      expect(up).toBeGreaterThan(0.15);
      for (let i = 0; i < 6; i++) { level(1); frames(1, 60); }
      const peak = mean(heights());
      for (let i = 0; i < 2; i++) { level(0); frames(1, 60); }
      const down = peak - mean(heights()); // the same two frames of release
      expect(down).toBeGreaterThan(0);
      expect(down).toBeLessThan((peak - base) * 0.5);
    });

    it("writes ~15–20 times a second no matter how fast frames arrive (60fps in, throttled out)", () => {
      render(<MobileAmbient />);
      setRec("on");
      const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
      frames(60, 16); // ≈ 1 second of 60fps frames
      const writes = spy.mock.calls.filter(([name]) => name === "--eq-h").length / EQ_BARS;
      spy.mockRestore();
      expect(writes).toBeGreaterThanOrEqual(13);
      expect(writes).toBeLessThanOrEqual(20);
    });
  });

  describe("no level (idle fallback)", () => {
    it("with no signal the band sways gently instead of sitting still or shouting", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(3);
      expect(eq()?.getAttribute("data-source")).toBe("idle");
      const first = heights();
      frames(12);
      const later = heights();
      expect(later).not.toEqual(first); // it moves
      for (const h of [...first, ...later]) {
        expect(h).toBeGreaterThanOrEqual(EQ_FLOOR - 1e-6);
        expect(h).toBeLessThan(0.4); // and it is low
      }
    });

    it("a level that stops arriving falls back to the sway after the stale window; a fresh one takes over again", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(1);
      for (let i = 0; i < 4; i++) { level(0.9); frames(1, 40); }
      expect(eq()?.getAttribute("data-source")).toBe("level");
      const staleFrames = Math.ceil((EQ_STALE_S * 1000) / 60) + 2;
      frames(staleFrames, 60);
      expect(eq()?.getAttribute("data-source")).toBe("idle");
      level(0.9);
      frames(1);
      expect(eq()?.getAttribute("data-source")).toBe("level");
    });
  });

  describe("paused / stop", () => {
    it("paused freezes the columns where they were and stops the loop entirely", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(1);
      for (let i = 0; i < 5; i++) { level(0.7); frames(1, 40); }
      const before = heights();
      setRec("paused");
      expect(rafQueue.size).toBe(0);
      frames(12);
      expect(heights()).toEqual(before);
      expect(recLayer()?.getAttribute("data-rec")).toBe("paused");
    });

    it("resume continues from the frozen heights (they do not snap back) and restarts the loop", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(1);
      for (let i = 0; i < 5; i++) { level(0.7); frames(1, 40); }
      const frozen = heights();
      setRec("paused");
      setRec("on");
      expect(rafQueue.size).toBe(1);
      frames(1);
      const resumed = heights();
      const delta = Math.max(...resumed.map((h, i) => Math.abs(h - frozen[i])));
      expect(delta).toBeLessThan(0.45);
      // the channel was cleared by the transition ⇒ the new run starts in the sway until a fresh sample arrives
      expect(eq()?.getAttribute("data-source")).toBe("idle");
    });

    it("stop: the layer fades (opacity) while the columns settle, then everything is torn down", () => {
      render(<MobileAmbient />);
      setRec("on");
      frames(1);
      for (let i = 0; i < 5; i++) { level(0.9); frames(1, 40); }
      const loud = mean(heights());
      setRec("off");
      expect(recLayer()?.getAttribute("data-rec")).toBe("fading");
      frames(8, 60); // the fade is 700ms; the columns relax toward the sway meanwhile
      expect(mean(heights())).toBeLessThan(loud);
      tick(700);
      expect(recLayer()).toBeNull();
      expect(rafQueue.size).toBe(0);
    });
  });

  describe("prefers-reduced-motion", () => {
    it("runs no loop and writes no heights — the static low band is pure CSS", () => {
      vi.stubGlobal("matchMedia", (q: string) => ({
        matches: q.includes("prefers-reduced-motion"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      render(<MobileAmbient />);
      setRec("on");
      expect(rafQueue.size).toBe(0);
      frames(5);
      expect(barEls()).toHaveLength(EQ_BARS);
      expect(barEls().every((b) => b.style.getPropertyValue("--eq-h") === "")).toBe(true);
      // the per-column variation the static band uses is still there
      expect(barEls().every((b) => b.style.getPropertyValue("--g") !== "")).toBe(true);
    });
  });

  describe("render discipline", () => {
    it("microphone levels never re-render React: no commits, no store notifications, columns still move", () => {
      let commits = 0;
      render(
        <Profiler id="app" onRender={() => { commits += 1; }}>
          <MobileAmbient />
        </Profiler>,
      );
      setRec("on");
      frames(2);
      const baseline = commits;
      const listener = vi.fn();
      const unsubscribe = useMobileAmbientStore.subscribe(listener);
      const first = heights();
      for (let i = 0; i < 30; i++) {
        level(Math.abs(Math.sin(i)));
        frames(1, 60);
      }
      unsubscribe();
      expect(commits).toBe(baseline);
      expect(listener).not.toHaveBeenCalled();
      expect(heights()).not.toEqual(first);
    });
  });
});
