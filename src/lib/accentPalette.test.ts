import { describe, it, expect } from "vitest";
import {
  ACCENT_CHROMA_STEPS,
  ACCENT_L,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_HUE,
  accentHex,
  accentHueOf,
  accentPalette,
  accentStepOf,
  contrastRatio,
  hexToOklch,
  isAccentHex,
  maxChromaFor,
  oklchToHex,
  onAccentFor,
  renderAccent,
  mixHex,
  lightnessForContrast,
  alphaForContrast,
} from "./accentPalette";

/**
 * 강조색 팔레트(PLAN-2026-09-12 §4)는 순수 함수라 테스트가 싸다 — 그래서 UI 가 아니라 **여기서**
 * 계약을 지킨다. 지키는 것 넷: 칩이 서로 구분되는가 · 색역 클램프가 도는가 · 초기화가 기본
 * 청자색을 정확히 내는가 · `--on-accent` 가 실제로 읽히는 대비를 내는가.
 */

const HUES = [0, 25, 60, 95, 120, 150, 185, 220, 250, 285, 310, 340];
const THEMES = ["dark", "light"] as const;

describe("OKLCH ↔ sRGB 왕복", () => {
  it("hex → OKLCH → hex 가 같은 hex 로 돌아온다", () => {
    for (const hex of ["#9cc5a4", "#7da98c", "#ace1af", "#5d8a6e", "#ffffff", "#000000", "#3b82f6"]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it("3자리 hex 와 대문자도 같은 색으로 읽는다", () => {
    expect(isAccentHex("#ABC")).toBe(true);
    expect(oklchToHex(hexToOklch("#ABC"))).toBe("#aabbcc");
  });
});

describe("칩 사다리", () => {
  it("같은 hue 의 5칩이 서로 다른 hex 다 — 어떤 hue·테마에서도", () => {
    for (const theme of THEMES) {
      for (const hue of HUES) {
        const palette = accentPalette(hue, theme);
        expect(palette).toHaveLength(5);
        expect(new Set(palette).size).toBe(5);
      }
    }
  });

  it("채도가 단계마다 실제로 올라간다(반올림으로 뒤집히지 않는다)", () => {
    for (const theme of THEMES) {
      for (const hue of HUES) {
        const chromas = accentPalette(hue, theme).map((hex) => hexToOklch(hex).C);
        for (let i = 1; i < chromas.length; i++) {
          expect(chromas[i]).toBeGreaterThan(chromas[i - 1]);
        }
      }
    }
  });

  it("무채 단은 진짜 무채색이다(R=G=B)", () => {
    for (const theme of THEMES) {
      const neutral = accentPalette(200, theme)[0];
      expect(neutral.slice(1, 3)).toBe(neutral.slice(3, 5));
      expect(neutral.slice(3, 5)).toBe(neutral.slice(5, 7));
      // 무채색에서는 hue 가 결과에 영향을 주지 않는다 — UI 가 hue 칩을 죽이는 근거다.
      expect(accentPalette(20, theme)[0]).toBe(neutral);
    }
  });

  it("명도는 테마가 정한다 — 칩이 달라져도 L 은 한 값이다", () => {
    for (const theme of THEMES) {
      for (const hex of accentPalette(250, theme)) {
        expect(hexToOklch(hex).L).toBeCloseTo(ACCENT_L[theme], 2);
      }
    }
  });
});

describe("색역 클램프", () => {
  it("가장 진한 단은 hue 에 따라 색역 경계로 깎인다(안 깎으면 칩이 붙는다)", () => {
    const top = ACCENT_CHROMA_STEPS[ACCENT_CHROMA_STEPS.length - 1];
    // H=270(보라·파랑 쪽)은 밝은 L 에서 sRGB 가 낼 수 있는 채도가 가장 좁은 구간이다.
    const ceiling = maxChromaFor(ACCENT_L.dark, 270);
    expect(ceiling).toBeLessThan(top);
    expect(hexToOklch(accentHex(270, top, "dark")).C).toBeCloseTo(ceiling, 2);
  });

  it("클램프해도 색상각은 지킨다 — 채도만 줄인다", () => {
    const clamped = accentHex(270, 0.3, "dark");
    expect(hexToOklch(clamped).H).toBeCloseTo(270, 0);
  });

  it("어떤 요청이 와도 sRGB 안의 6자리 hex 가 나온다", () => {
    for (const theme of THEMES) {
      for (let hue = 0; hue < 360; hue += 5) {
        for (const c of [...ACCENT_CHROMA_STEPS, 0.5]) {
          expect(accentHex(hue, c, theme)).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });
});

describe("기본값과 초기화", () => {
  it("초기화는 기본 청자색 #9cc5a4 를 **정확히** 낸다", () => {
    expect(DEFAULT_ACCENT).toBe("#9cc5a4");
    expect(renderAccent(DEFAULT_ACCENT, "dark")).toBe("#9cc5a4");
  });

  it("기본값이 사다리 한가운데 칩과 같은 색이다 — 초기화 뒤 선택 표시가 비지 않는다", () => {
    expect(accentHex(DEFAULT_ACCENT_HUE, ACCENT_CHROMA_STEPS[2], "dark")).toBe(DEFAULT_ACCENT);
    expect(accentStepOf(DEFAULT_ACCENT)).toBe(2);
    expect(accentHueOf(DEFAULT_ACCENT)).toBeCloseTo(DEFAULT_ACCENT_HUE, 6);
  });

  it("라이트 테마의 기본 강조색은 tokens.css 의 --accent:#7da98c 와 같다", () => {
    expect(renderAccent("#7da98c", "light")).toBe("#7da98c");
  });

  it("테마를 바꾸면 같은 저장값이 그 배경의 명도로 옮겨간다", () => {
    const light = renderAccent(DEFAULT_ACCENT, "light");
    expect(light).not.toBe(DEFAULT_ACCENT);
    expect(hexToOklch(light).L).toBeCloseTo(ACCENT_L.light, 2);
    // 색상·채도는 사용자 것이라 그대로다.
    expect(hexToOklch(light).H).toBeCloseTo(hexToOklch(DEFAULT_ACCENT).H, 1);
    expect(hexToOklch(light).C).toBeCloseTo(hexToOklch(DEFAULT_ACCENT).C, 2);
  });

  it("무채색으로 저장돼 있으면 hue 는 기본 색상각으로 돌아간다", () => {
    const gray = accentPalette(300, "dark")[0];
    expect(accentHueOf(gray)).toBeCloseTo(DEFAULT_ACCENT_HUE, 6);
    expect(accentStepOf(gray)).toBe(0);
  });

  it("칩을 눌러 만든 색은 그 칩 번호로 되짚힌다", () => {
    for (const theme of THEMES) {
      for (const hue of HUES) {
        accentPalette(hue, theme).forEach((hex, i) => {
          expect(accentStepOf(hex)).toBe(i);
        });
      }
    }
  });
});

describe("isAccentHex — 옛 VALID_ACCENTS 화이트리스트의 후임", () => {
  it("hex 면 통과한다(5색 열거가 아니다)", () => {
    expect(isAccentHex("#ff0000")).toBe(true);
    expect(isAccentHex(DEFAULT_ACCENT)).toBe(true);
  });

  it("hex 가 아니면 거부한다", () => {
    for (const bad of ["red", "#12", "#1234567", "rgb(1,2,3)", "", 0, null, undefined, {}]) {
      expect(isAccentHex(bad)).toBe(false);
    }
  });
});

describe("--on-accent", () => {
  it("밝은 강조색에는 어두운 글자를 낸다", () => {
    const ink = onAccentFor(DEFAULT_ACCENT);
    expect(hexToOklch(ink).L).toBeLessThan(0.35);
  });

  it("어두운 강조색에는 밝은 글자를 낸다(L 상수를 내려도 따라온다)", () => {
    const ink = onAccentFor(oklchToHex({ L: 0.35, C: 0.08, H: 250 }));
    expect(hexToOklch(ink).L).toBeGreaterThan(0.9);
  });

  it("어떤 칩 위에서도 본문 대비 4.5:1 을 넘는다", () => {
    for (const theme of THEMES) {
      for (let hue = 0; hue < 360; hue += 10) {
        for (const hex of accentPalette(hue, theme)) {
          expect(contrastRatio(hex, onAccentFor(hex))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

// ── 글자색 자동 보정의 재료 (PLAN-2026-09-12 §5/E6) ──────────────────────────
// 셋 다 순수 함수라 여기서 못 박는다. 소비처는 lib/appearance.ts::autoInk 이고, 그쪽은
// "어떤 배경에서 무엇이 바뀌는가"를 본다 — 여기서는 **푸는 것이 맞게 풀리는가**만 본다.

describe("mixHex", () => {
  it("t=0/1 은 양 끝을 그대로 돌려준다", () => {
    expect(mixHex("#171b1a", "#ffffff", 0)).toBe("#171b1a");
    expect(mixHex("#171b1a", "#ffffff", 1)).toBe("#ffffff");
  });

  it("검정과 50% 섞으면 채널이 절반이 된다(color-mix(in srgb) 와 같은 감마공간 보간)", () => {
    expect(mixHex("#804020", "#000000", 0.5)).toBe("#402010");
  });

  it("범위를 벗어난 t 는 0~1 로 클램프된다", () => {
    expect(mixHex("#123456", "#ffffff", -1)).toBe("#123456");
    expect(mixHex("#123456", "#ffffff", 9)).toBe("#ffffff");
  });
});

describe("lightnessForContrast", () => {
  const INK = { C: 0.0058, H: 84.6 }; // 다크 --text #e0deda 의 채도·색상

  it("목표를 만족하는 L 을 찾아낸다 — 밝은 쪽으로도 어두운 쪽으로도", () => {
    for (const bg of ["#171b1a", "#928f88", "#f4efe3"]) {
      for (const [target, endpoint] of [
        [4.5, 0.97],
        [4.5, 0.08],
        [3, 0.97],
      ] as const) {
        const L = lightnessForContrast(bg, INK, target, endpoint);
        const cr = contrastRatio(oklchToHex({ L, C: INK.C, H: INK.H }), bg);
        // 끝까지 갔는데도 모자란 경우(=낼 수 있는 최대)만 예외로 둔다.
        if (L !== endpoint) expect(cr).toBeGreaterThanOrEqual(target - 0.01);
      }
    }
  });

  it("**최소한만** 움직인다 — 한 눈금 덜 가면 목표에 못 미친다", () => {
    const bg = "#928f88";
    const L = lightnessForContrast(bg, INK, 4.5, 0.08);
    expect(L).toBeGreaterThan(0.08); // 끝까지 가지 않았다 = 해가 있다
    const looser = contrastRatio(oklchToHex({ L: L + 0.01, C: INK.C, H: INK.H }), bg);
    expect(looser).toBeLessThan(4.5);
  });

  it("해가 없으면 끝값을 돌려준다(낼 수 있는 최대 대비)", () => {
    // 중간 명도 배경 + 위쪽 끝 — onAccentFor 주석이 말하는 "두 후보 모두 미달" 구간이다.
    expect(lightnessForContrast("#7f7f7f", INK, 7, 0.97)).toBe(0.97);
  });

  it("색상·채도는 건드리지 않는다(글자가 회색으로 변색되면 안 된다)", () => {
    // 채도를 0.03 으로 두고 본다 — 잉크 실측 채도(0.0095)는 어두운 L 에서 8비트 양자화가
    // 각도를 크게 흔들어(측정 잡음) 색상 보존을 재는 자로 쓸 수 없다. 보존되는지 여부는
    // 채도와 무관한 성질이므로 잡음이 작은 자리에서 잰다.
    const ink = { C: 0.03, H: 80.7 };
    const L = lightnessForContrast("#928f88", ink, 4.5, 0.08);
    const out = hexToOklch(oklchToHex({ L, C: ink.C, H: ink.H }));
    // 허용 오차가 6° 인 것은 계산이 아니라 **출력 형식** 때문이다: 결과가 hex(채널당 8비트)라
    // 어두운 자리에서는 한 단위 반올림이 각도를 몇 도씩 흔든다. 색이 남아 있는지(채도)가 본질.
    expect(Math.abs(out.H - ink.H)).toBeLessThan(6);
    expect(out.C).toBeGreaterThan(0.02);
  });
});

describe("alphaForContrast", () => {
  it("반투명 잉크가 목표를 넘는 최소 알파를 찾는다", () => {
    const bg = "#f4efe3";
    const ink = "#3b3833";
    const a = alphaForContrast(bg, ink, 3, 0.45);
    expect(a).toBeGreaterThan(0.45);
    expect(contrastRatio(mixHex(bg, ink, a), bg)).toBeGreaterThanOrEqual(2.99);
    expect(contrastRatio(mixHex(bg, ink, a - 0.02), bg)).toBeLessThan(3);
  });

  it("불투명(1)으로도 모자라면 1 을 돌려준다", () => {
    expect(alphaForContrast("#f4efe3", "#eeeae0", 4.5, 0.4)).toBe(1);
  });

  it("이미 충분하면 시작 알파를 넘지 않는다", () => {
    expect(alphaForContrast("#171b1a", "#e0deda", 3, 0.46)).toBeLessThanOrEqual(0.46);
  });
});
