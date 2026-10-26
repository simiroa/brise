import { describe, it, expect } from 'vitest';
import { kToGlZoom, glZoomToK, GL_TILE_SIZE } from './mapZoomScale';

describe('k ↔ GL zoom', () => {
  it('세계 폭이 양쪽에서 같다 (정의 그대로)', () => {
    const w = 1024;
    for (const k of [1, 2, 30, 150, 320, 400]) {
      const z = kToGlZoom(k, w);
      expect(w * k).toBeCloseTo(GL_TILE_SIZE * 2 ** z, 6);
    }
  });

  it('왕복이 항등이다 (대표 k, 여러 뷰포트 폭)', () => {
    for (const w of [320, 800, 1024, 1920]) {
      for (const k of [1, 2, 20, 150, 320, 400]) {
        expect(glZoomToK(kToGlZoom(k, w), w)).toBeCloseTo(k, 9);
      }
    }
  });

  it('대표값', () => {
    // 800px 폭에서 k=150 → 세계 폭 120000px → z = log2(120000/512) ≈ 7.873
    expect(kToGlZoom(150, 800)).toBeCloseTo(Math.log2(120000 / 512), 9);
    expect(kToGlZoom(320, 1024)).toBeCloseTo(Math.log2(327680 / 512), 9);
    // 폭이 2배면 같은 k 가 zoom 을 1 올린다.
    expect(kToGlZoom(150, 1600) - kToGlZoom(150, 800)).toBeCloseTo(1, 9);
  });

  it('불량 입력은 터지지 않는다', () => {
    expect(kToGlZoom(0, 800)).toBe(0);
    expect(kToGlZoom(150, 0)).toBe(0);
    expect(glZoomToK(5, 0)).toBe(1);
  });
});
