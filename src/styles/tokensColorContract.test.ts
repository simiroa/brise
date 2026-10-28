import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 색 구조 계약 가드 (PLAN-2026-09-12 §2/E1 · §3/E5).
 *
 * 이 파일이 지키는 것은 둘이다.
 *
 *  ① 테마색 한 규칙 — 구분선은 --theme 파생이고, **알파 두 단은 양 테마 공통**이다.
 *     옛날에는 다크가 "accent 의 RGB 그대로", 라이트가 "그와 무관한 제3의 색"이라 테마마다
 *     규칙이 달랐고, 강조색이 청자색 원툴인 동안만 그 어긋남이 안 보였다. 선을 --accent 에
 *     다시 매달거나(레드를 고르면 모든 선이 분홍) 라이트에만 알파를 따로 주면 여기서 깨진다.
 *
 *  ② 본문 표면 파생 공식의 드리프트 — .content-canvas 가 기준면을 갈아끼우면서 파생 공식이
 *     **두 벌**이 됐다(:root 와 .content-canvas). 한쪽만 고치면 본문 안의 면만 조용히
 *     어긋난다. 그 사고는 눈으로 안 잡힌다 — 이름은 그대로고 색만 한 단 틀리기 때문이다.
 *     그래서 문자열 일치가 아니라 **구조**를 본다: 같은 토큰이 같은 형태의 공식을 쓰는가,
 *     기준면만 다르고 나머지는 같은가, :root 에 새로 생긴 파생이 본문에도 따라왔는가.
 *     (선례: src/lib/appearanceSeedDrift.test.ts 가 index.html 과 appearance.ts 를 대조한다.)
 */
const RAW = readFileSync("src/styles/tokens.css", "utf8");

/** CSS 주석 제거(개행 보존 — 실패 메시지의 줄 감각을 유지). base64 데이터 URI 에는 `*` 가
 *  없으므로 `* /` 오인식이 없다. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const CSS = stripComments(RAW);

/** 셀렉터 바로 뒤 `{` 부터 짝이 맞는 `}` 까지의 본문. `:root` 는 `:root[data-theme=...]` 에
 *  걸리지 않는다 — 셀렉터 다음 글자가 `{` 여야 하기 때문이다. */
function blockBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(`(?:^|[}\\n;])\\s*${esc}\\s*\\{`, "m");
  const m = CSS.match(open);
  if (!m || m.index === undefined) {
    throw new Error(`tokens.css: \`${selector} { ... }\` 블록을 찾지 못했습니다 (셀렉터가 바뀌었나요?)`);
  }
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < CSS.length && depth > 0; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`tokens.css: \`${selector}\` 블록의 닫는 중괄호를 찾지 못했습니다`);
  return CSS.slice(start, i - 1);
}

/** 값 정규화 — 공백/줄바꿈 차이는 드리프트가 아니다. `calc(100% - var(--x))` 의 연산자 공백은
 *  의미가 있으므로 건드리지 않고, 괄호 안쪽 여백과 콤마 뒤 여백만 없앤다. */
function normalize(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

/** 블록 안의 커스텀 프로퍼티 선언. 같은 이름이 두 번이면 뒤엣것이 이긴다(CSS 와 같게). */
function declarations(selector: string): Map<string, string> {
  const body = blockBody(selector);
  const out = new Map<string, string>();
  let depth = 0;
  let buf = "";
  const flush = () => {
    const m = buf.match(/^\s*(--[A-Za-z0-9_-]+)\s*:([\s\S]*)$/);
    if (m) out.set(m[1], normalize(m[2]));
    buf = "";
  };
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) flush();
    else buf += ch;
  }
  flush();
  return out;
}

const root = declarations(":root");
const light = declarations(":root[data-theme='light']");
const content = declarations(".content-canvas");
const focus = declarations(".content-canvas--focus");

// ════════════════════════════════════════════════════════════════════════════
// ① 테마색 — 하나의 규칙
// ════════════════════════════════════════════════════════════════════════════
describe("색 세 층 ① 테마색 --theme (PLAN-2026-09-12 §2/E1)", () => {
  it("두 테마 모두 --theme 을 고정 hex 로 정의한다 (사용자가 못 바꾸는 정체성 색)", () => {
    expect(root.get("--theme")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(light.get("--theme")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(light.get("--theme")).not.toBe(root.get("--theme"));
  });

  it("구분선은 --theme + 알파 두 단이다 (--accent 파생 금지)", () => {
    for (const name of ["--divider", "--line"] as const) {
      const value = root.get(name);
      expect(value, `:root 에 ${name} 선언이 없습니다`).toBeDefined();
      expect(
        value,
        `${name} 은 --theme 파생이어야 합니다. --accent 로 만들면 사용자가 레드를 고르는 순간 ` +
          "화면의 모든 선이 분홍이 되고, 채도 0단에서는 전부 회색이 됩니다(= 오늘 오전의 '탁하다').",
      ).toMatch(/^color-mix\(in srgb,var\(--theme\) \d{1,2}%,transparent\)$/);
      expect(value).not.toContain("--accent");
    }
  });

  it("divider 가 line 보다 진하다 (사다리 두 단의 방향)", () => {
    const pct = (v: string) => Number(/(\d{1,2})%/.exec(v)?.[1]);
    expect(pct(root.get("--divider")!)).toBeGreaterThan(pct(root.get("--line")!));
  });

  it("라이트 테마는 알파를 따로 주지 않는다 — 달라지는 것은 --theme 뿐이다", () => {
    expect(
      light.has("--divider") || light.has("--line"),
      "라이트에서 --divider/--line 을 재정의하면 두 테마가 다시 서로 다른 규칙이 됩니다. " +
        "무게를 바꿔야 한다면 알파가 아니라 라이트 --theme 의 밝기를 조정하세요(근거는 tokens.css 주석).",
    ).toBe(false);
  });

  it("--sel/--hover/--search-hit 는 강조색 파생 그대로다 (그건 구조가 아니라 상태다)", () => {
    expect(root.get("--sel")).toContain("var(--accent)");
    expect(root.get("--hover")).toContain("var(--accent)");
    expect(root.get("--search-hit")).toContain("var(--accent)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ② 본문 표면 재정의 — 두 벌이 된 파생 공식의 드리프트 가드
// ════════════════════════════════════════════════════════════════════════════

/** :root 의 파생 토큰 중 본문이 따라갈 **필요가 없는** 것. 항목마다 이유를 남긴다. */
const CONTENT_EXEMPT: Record<string, string> = {
  "--bg": "`.app` 시트 자체의 페인트 — 본문은 시트를 다시 그리지 않는다(그 위에 틴트만 얹는다)",
  "--app-sheet-base":
    "틴트 **이전**의 바탕을 본문에 전달하는 통로. 본문에서 재정의하면 기준면 식이 자기 자신을 " +
    "참조하는 사이클이 되어 CSS 가 두 선언을 통째로 무효로 만든다",
};

const BASE_TOKENS = ["--surface-base", "--app-canvas"] as const;

describe("본문 표면 재정의 드리프트 가드 (PLAN-2026-09-12 §3/E5)", () => {
  it("기준면 전달용 --app-sheet-base 가 :root 에만 있다 (사이클 방지)", () => {
    expect(root.get("--app-sheet-base")).toBe("var(--surface-base)");
    expect(
      content.has("--app-sheet-base"),
      "`.content-canvas` 가 --app-sheet-base 를 재정의하면 --surface-base ↔ --app-sheet-base " +
        "사이클이 생겨 두 토큰이 모두 무효가 됩니다(화면에선 배경이 통째로 사라지는 모양으로 보입니다).",
    ).toBe(false);
  });

  it("본문 기준면은 '시트 + 본문 틴트' 합성이다 — 틴트 0% 에서 무연산", () => {
    expect(
      content.get("--surface-base"),
      "본문 기준면은 --content-tint 가 얹힌 실제 바탕이어야 합니다. 퍼센트를 " +
        "var(--content-tint-amount) 가 아닌 리터럴로 굳히면 슬라이더를 잃고, 틴트 0% 에서 " +
        "무연산이라는 안전선(지금과 픽셀이 같아야 한다)도 함께 깨집니다.",
    ).toBe(
      "color-mix(in srgb,var(--content-tint-color) var(--content-tint-amount),var(--app-sheet-base))",
    );
  });

  it("본문에서 --app-canvas 는 눈에 보이는 바탕(= 기준면)을 가리킨다", () => {
    // :root 의 --app-canvas 는 dim 이전의 생캔버스다. 본문 안에서 그 값을 쓰면 §0 의 펫 액자처럼
    // 틴트와 bg_dim 을 **둘 다** 건너뛴 색이 된다.
    expect(content.get("--app-canvas")).toBe("var(--surface-base)");
    expect(root.get("--app-canvas")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("파생 공식은 :root 와 **글자 그대로** 같다 (기준면만 다르다)", () => {
    // **이행 폐포(transitive closure)로 찾는다.** 기준면을 직접 참조하는 토큰만 보면 구멍이
    // 생긴다 — `.content-canvas` 가 재정의하는 것은 --surface-base 뿐 아니라 --surface ·
    // --surface-sunken 도 마찬가지라, :root 에
    // 그것들을 **거쳐** 파생되는 토큰을 새로 만들면(예: --panel-tone: color-mix(… var(--surface) …))
    // 그 토큰도 선언 지점에서 :root 값으로 굳어 본문을 따라가지 않는다. 막으려는 드리프트와
    // 정확히 같은 종류인데 한 다리 건너 있을 뿐이다.
    // 씨앗 = `.content-canvas` 가 실제로 재정의하는 토큰 전부(파싱 결과에서 직접 얻는다 —
    // 목록을 손으로 들고 있으면 그 목록 자체가 드리프트한다).
    const rebased = new Set<string>(content.keys());
    for (let pass = 0; pass < 10; pass++) {
      let grew = false;
      for (const [k, v] of root) {
        if (rebased.has(k)) continue;
        if ([...rebased].some((t) => v.includes(`var(${t})`))) {
          rebased.add(k);
          grew = true;
        }
      }
      if (!grew) break;
    }
    const derived = [...root.keys()].filter(
      (k) =>
        !BASE_TOKENS.includes(k as (typeof BASE_TOKENS)[number]) &&
        !(k in CONTENT_EXEMPT) &&
        rebased.has(k) &&
        k !== "--surface-base" &&
        k !== "--app-canvas",
    );
    // 가드의 가드: 파생이 하나도 안 잡히면 정규식/파서가 망가진 것이지 드리프트가 없는 게 아니다.
    // 하한 2 = --surface · --surface-sunken (2026-09-28 캔버스 제거로 미사용 별칭 --bg-surface · --bg-base 가,
    // 2026-10-19 브리핑 재작성으로 마지막 사용처를 잃은 --surface-soft 가 빠졌다).
    expect(derived.length).toBeGreaterThanOrEqual(2);
    for (const name of derived) {
      expect(
        content.get(name),
        `:root 의 ${name} 은 기준면에서 파생되는데 \`.content-canvas\` 에 짝이 없습니다. ` +
          "본문에도 같은 식으로 추가하세요 — 안 그러면 본문 안의 그 면만 옛 바탕 위에서 계산됩니다. " +
          `본문이 따라갈 필요가 없는 토큰이면 이 테스트의 CONTENT_EXEMPT 에 **이유와 함께** 올리세요.`,
      ).toBe(root.get(name));
    }
  });

  it("본문의 파생은 전부 기준면 하나에 매달려 있다 (포커스 모드가 한 줄로 되돌릴 수 있게)", () => {
    for (const [name, value] of content) {
      if (name === "--surface-base") continue;
      expect(
        value,
        `\`.content-canvas\` 의 ${name} 이 기준면(--surface-base / --app-canvas)을 거치지 않습니다. ` +
          "그러면 .content-canvas--focus 가 기준면 하나만 되돌려도 이 토큰은 틴트가 낀 채로 남습니다.",
      ).toMatch(/var\(--surface-base\)|var\(--app-canvas\)/);
    }
  });

  it("포커스 모드는 기준면을 되돌리지 않는다 — 바탕이 본문 색이다(오너 2026-10-27)", () => {
    // 집중모드의 바탕은 바깥 .content-surface 가 칠하는 본문 틴트다. 여기서 기준면을 시트로 되돌리면
    // 토큰이 실제보다 밝은 바탕을 가정한다 — 예전엔 그 되돌림 때문에 집중모드가 사이드바 색이었다.
    expect([...focus.keys()]).toEqual([]);
  });
});
