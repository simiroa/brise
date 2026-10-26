import { describe, expect, it } from "vitest";
import {
  barSeed,
  barTarget,
  EQ_ATTACK_S,
  EQ_BARS,
  EQ_FLOOR,
  EQ_FRAME_MS,
  EQ_RELEASE_S,
  stepToward,
} from "./recEqualizerMath";

const idx = Array.from({ length: EQ_BARS }, (_, i) => i);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

describe("recEqualizer — shape", () => {
  it("is 20–28 columns, written ~15–20 times a second", () => {
    expect(EQ_BARS).toBeGreaterThanOrEqual(20);
    expect(EQ_BARS).toBeLessThanOrEqual(28);
    expect(1000 / EQ_FRAME_MS).toBeGreaterThanOrEqual(15);
    expect(1000 / EQ_FRAME_MS).toBeLessThanOrEqual(20);
  });

  it("per-column seeds are deterministic (no Math.random) and differ column to column", () => {
    expect(idx.map((i) => barSeed(i))).toEqual(idx.map((i) => barSeed(i)));
    const phases = idx.map((i) => barSeed(i).phase);
    expect(new Set(phases.map((p) => p.toFixed(3))).size).toBe(EQ_BARS);
    for (const i of idx) {
      const s = barSeed(i);
      expect(s.gain).toBeGreaterThanOrEqual(0.55);
      expect(s.gain).toBeLessThanOrEqual(1);
      expect(s.env).toBeGreaterThanOrEqual(0.6);
      expect(s.env).toBeLessThanOrEqual(1);
    }
  });
});

describe("recEqualizer — targets", () => {
  it("stays within [floor, 1] for any level and time", () => {
    for (const level of [null, 0, 0.05, 0.3, 0.7, 1]) {
      for (let t = 0; t < 20; t += 0.37) {
        for (const i of idx) {
          const v = barTarget(i, t, level);
          expect(v).toBeGreaterThanOrEqual(EQ_FLOOR);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("louder input lifts the columns; silence keeps a visible floor", () => {
    const avg = (level: number) => mean(idx.map((i) => barTarget(i, 3.1, level)));
    expect(avg(0.6)).toBeGreaterThan(avg(0.1) + 0.1);
    expect(avg(0.1)).toBeGreaterThan(avg(0));
    expect(avg(0)).toBeGreaterThanOrEqual(EQ_FLOOR);
  });

  it("with a level the columns are not a bar chart: heights differ and move with time", () => {
    const at = (t: number) => idx.map((i) => barTarget(i, t, 0.6));
    expect(spread(at(1.2))).toBeGreaterThan(0.1);
    expect(at(1.2)).not.toEqual(at(1.5));
  });

  it("no level → a gentle sway that stays low (it must never look like loud input)", () => {
    for (let t = 0; t < 30; t += 0.5) {
      expect(Math.max(...idx.map((i) => barTarget(i, t, null)))).toBeLessThan(0.4);
    }
    // but it does move
    expect(idx.map((i) => barTarget(i, 0, null))).not.toEqual(idx.map((i) => barTarget(i, 2, null)));
  });
});

describe("recEqualizer — smoothing", () => {
  it("attack is fast and release is slow (same distance, same time)", () => {
    const up = stepToward(0.2, 0.8, 0.1) - 0.2;
    const down = 0.8 - stepToward(0.8, 0.2, 0.1);
    expect(EQ_ATTACK_S).toBeLessThan(EQ_RELEASE_S);
    expect(up).toBeGreaterThan(down * 2);
  });

  it("is frame-rate independent: two half steps ≈ one whole step", () => {
    const whole = stepToward(0.2, 0.8, 0.1);
    const halves = stepToward(stepToward(0.2, 0.8, 0.05), 0.8, 0.05);
    expect(halves).toBeCloseTo(whole, 6);
  });

  it("never overshoots and ignores a negative dt", () => {
    expect(stepToward(0.2, 0.8, 100)).toBeLessThanOrEqual(0.8);
    expect(stepToward(0.2, 0.8, 100)).toBeGreaterThan(0.79);
    expect(stepToward(0.2, 0.8, -1)).toBe(0.2);
  });
});
