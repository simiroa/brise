import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const tokens = readFileSync("src/styles/tokens.css", "utf8");

describe("tokens.css font imports — do not block the transparent window", () => {
  it("does not import unsplit Noto KR 400/500/600/700.css (those explode into hundreds of unicode-range slices)", () => {
    expect(tokens).not.toMatch(/@fontsource\/noto-sans-kr\/\d{3}\.css/);
    expect(tokens).not.toMatch(/@fontsource\/noto-serif-kr\/\d{3}\.css/);
  });

  it("loads KR faces via korean + latin subset files", () => {
    expect(tokens).toMatch(/@fontsource\/noto-sans-kr\/korean-400\.css/);
    expect(tokens).toMatch(/@fontsource\/noto-sans-kr\/latin-400\.css/);
    expect(tokens).toMatch(/@fontsource\/noto-serif-kr\/korean-400\.css/);
    expect(tokens).toMatch(/@fontsource\/noto-serif-kr\/latin-400\.css/);
  });

  // 2026-09-09: Pretendard 가 기본 본문·UI 글꼴. 굵기 사다리는 400/600 두 단뿐이므로(CLAUDE.md
  // 함정 10) 나머지 7단은 임포트하지 않는다 — 한 단이 766KB 라 무심코 늘면 그 함정이 기록한
  // "투명 창이 테두리만 보임" 사고 크기대로 불어난다.
  it("bundles Pretendard at 400/600 only", () => {
    expect(tokens).toMatch(/@fontsource\/pretendard\/latin-400\.css/);
    expect(tokens).toMatch(/@fontsource\/pretendard\/latin-600\.css/);
    expect(tokens).not.toMatch(/@fontsource\/pretendard\/(latin-)?(100|200|300|500|700|800|900)\.css/);
    // 단일 subset 패키지라 index.css 를 통째로 끌면 9단이 전부 들어온다.
    expect(tokens).not.toMatch(/@fontsource\/pretendard\/index\.css/);
  });

  it("keeps overlay acrylic fill as inline max(), not a custom-property color-mix", () => {
    expect(tokens).toMatch(
      /color-mix\(in srgb, var\(--surface-base\) calc\(max\(var\(--sheet-alpha\), 0\.92\) \* 100%\), transparent\)/,
    );
    expect(tokens).not.toMatch(/--overlay-alpha\s*:/);
  });

  // 2026-08-14 오너 잠정 결정: 떠 있는 표면은 **프리셋과 무관하게 불투명**이다. CSS 유리는 이 앱에서
  // 불가능한 것으로 실측됐다 — 창이 `transparent: true` 인 동안 WebView2 가 backdrop blur 를 화면에
  // 반영하지 않고(계산된 스타일에는 들어 있다), 그 투명 창은 네이티브 Acrylic(데스크톱 비침)의
  // 전제라 둘이 배타다. 모달 유리는 별도 OS 창 + 네이티브 재질로 다시 시도한다.
  // 되살리려면: 먼저 transparent 창에서 blur 가 실제로 픽셀에 닿는지 실측하고 이 테스트를 고칠 것.
  it("keeps floating surfaces opaque — no CSS glass while the window is transparent", () => {
    // acrylic 프리셋에 .overlay 재정의가 없어야 한다(있으면 유리가 되살아난 것).
    expect(tokens).not.toMatch(/:root\[data-surface='acrylic'\] \.overlay[,{]/);
    // 죽은 유리 토큰이 남아 있으면 안 된다.
    expect(tokens).not.toMatch(/--overlay-blur\s*:/);
    expect(tokens).not.toMatch(/--glass-rim\s*:/);
    expect(tokens).not.toMatch(/--overlay-alpha\s*:/);
    // .app 은 시트 톤만 갖는다 — CSS backdrop-filter 는 없다(데스크톱 블러는 DWM 소유).
    expect(tokens).not.toMatch(/:root\[data-surface='acrylic'\] \.app\{/);
    // 불투명 기본값은 컴포넌트 레이어의 한 줄이 담당한다.
    //
    // **--app-sheet-base 여야 한다. --surface 로 되돌리지 마라**(2026-09-12): PLAN-2026-09-12 §3
    // 이후 --surface 는 `.content-canvas` 안에서 본문 바탕과 같아진다. 그러면 body 로 포털되는
    // 팝오버와 인-트리로 뜨는 팝오버(CreatePopover 등, portal 없이 position:fixed)가 같은
    // 화면에서 **서로 다른 색**이 되고, 인-트리 쪽은 바탕 대비 CR 1.000 이라 아예 안 보인다.
    // --app-sheet-base 는 본문이 재정의하지 않는 시트 기준면이라 어디서 읽어도 같은 값이고,
    // color-mix 결과가 불투명이라 "떠 있는 표면은 항상 불투명" 계약도 그대로 지킨다.
    expect(tokens).toMatch(/\.overlay\{background:var\(--app-sheet-base\)/);
    expect(tokens).not.toMatch(/\.overlay\{background:var\(--surface\)/);
  });

  // 2026-08-14 삭제된 쌍둥이 레이어가 되살아나지 않게 — 셀렉터/속성으로만 검사한다(문서 주석에는
  // 이름이 남아 있고, 그건 남아 있어야 한다). 되살릴 거면 이 테스트부터 지우면서 이유를 적을 것:
  // 그 구조는 카드 배경을 JS 성공에 의존하게 만들고 폴백이 없다.
  it("keeps the body frost twin deleted (no geometry-mirroring layer)", () => {
    expect(tokens).not.toMatch(/\.overlay-frost\s*[,{]/);
    expect(tokens).not.toMatch(/\.overlay--sheet\s*[,{]/);
    expect(tokens).not.toMatch(/\[data-frost-chrome\]/);
    // 스크림은 ::backdrop 의사요소가 아니라 진짜 div 다(top layer 를 떠났으므로).
    expect(tokens).toMatch(/\.modal-scrim\{/);
    expect(tokens).not.toMatch(/::backdrop\s*\{/);
  });

  it("diagram chrome reuses that same acrylic mix (nodes/labels/controls)", () => {
    expect(tokens).toMatch(
      /:root\[data-surface='acrylic'\] \.diagram-flow-node/,
    );
  });
});
