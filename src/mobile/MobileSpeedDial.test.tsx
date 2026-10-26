import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { t } from "../i18n/t";
import { MobileSpeedDial, type SpeedDialPlacement } from "./MobileSpeedDial";
import { useBackClosable } from "./useBackClosable";

/**
 * 스피드 다이얼(오너 2026-10-07: "＋ 눌러서 위쪽으로 녹음·사진·파일첨부가 텐션 있게 등장"). jsdom 은 CSS 를 안 입히므로 두 층으로 본다:
 * ⓐ 동작 — 열림/닫힘·aria·동작 호출·뒤로가기·포커스 유지(렌더 결과) ⓑ 모션 계약 — note-capture.css 규칙 본문(문자열)
 * (transform/opacity 만 움직인다 · 스프링 오버슈트 · 닫힌 항목은 눌리지 않는다 · reduced-motion 은 이동 없이 페이드만).
 */
function setup(placement: SpeedDialPlacement = "float", aiReady = true) {
  const h = { onOpenVoice: vi.fn(), onPickPhoto: vi.fn(), onOpenAttach: vi.fn(), onOpenAi: vi.fn(), aiReady };
  const r = render(<MobileSpeedDial placement={placement} {...h} />);
  return { ...h, ...r };
}
const toggle = () => screen.getByTestId("mobile-fab-toggle");
const root = () => screen.getByTestId("mobile-speed-dial");
const layer = () => root().querySelector(".mobile-speed-dial-layer") as HTMLElement;
const items = () => Array.from(root().querySelectorAll<HTMLButtonElement>(".mobile-speed-dial-item"));
const catcher = () => screen.queryByTestId("mobile-speed-dial-catcher");
const open = () => fireEvent.click(toggle());
const hardwareBack = () => act(() => void fireEvent.popState(window));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MobileSpeedDial — the ＋ toggle", () => {
  it("is closed by default: a labelled toggle button, aria-expanded=false, actions inert", () => {
    setup();
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("aria-label")).toBe(t("mobile.fab_group"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe(layer().id);
    expect(root().getAttribute("data-open")).toBe("false");
    expect(layer().hasAttribute("inert")).toBe(true); // out of the tab order and the a11y tree while closed
    expect(items().every((b) => b.tabIndex === -1)).toBe(true);
    expect(catcher()).toBeNull(); // only mounted while open
  });

  it("tapping ＋ opens it (aria-expanded=true, actions live, tap-catcher mounted) and tapping again closes it", () => {
    setup();
    open();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(root().getAttribute("data-open")).toBe("true");
    expect(layer().hasAttribute("inert")).toBe(false);
    expect(items().every((b) => b.tabIndex === 0)).toBe(true);
    expect(catcher()).not.toBeNull();

    open();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(root().getAttribute("data-open")).toBe("false");
    expect(layer().hasAttribute("inert")).toBe(true);
    expect(catcher()).toBeNull();
  });

  it("has four actions, nearest the ＋ first: 녹음 · 사진 · 파일 첨부 · AI — named, with the stagger index --i", () => {
    setup();
    const btns = items();
    expect(btns.map((b) => b.getAttribute("data-action"))).toEqual(["record", "photo", "attach", "ai"]);
    // 접근 가능한 이름 = 보이는 글자. 녹음은 예전 마이크의 이름표를, AI 는 예전 독 ✨ 의 이름표를 그대로 쓴다(낭독기 계약).
    expect(btns.map((b) => b.getAttribute("aria-label"))).toEqual([
      t("mobileInput.voice_mic"),
      t("mobile.dial_photo"),
      t("mobile.dial_file"),
      t("editor.ai_menu_title"),
    ]);
    expect(btns.map((b) => b.querySelector(".mobile-speed-dial-label")!.textContent)).toEqual([
      t("mobileInput.voice_mic"),
      t("mobile.dial_photo"),
      t("mobile.dial_file"),
      t("editor.ai_menu_title"),
    ]);
    expect(btns.map((b) => b.style.getPropertyValue("--i"))).toEqual(["0", "1", "2", "3"]);
    // 예전 FAB 의 id 를 이어 쓴다 — 녹음기/첨부 시트가 같은 곳을 여는 계약.
    expect(btns.map((b) => b.getAttribute("data-testid"))).toEqual([
      "mobile-fab-mic",
      "mobile-fab-photo",
      "mobile-fab-attach",
      "mobile-fab-ai",
    ]);
  });

  it("labels are plain text, not a surface pill (owner 2026-10-10) — no .overlay on the label, only on the circle", () => {
    setup();
    for (const b of items()) {
      expect(b.querySelector(".mobile-speed-dial-label")!.classList.contains("overlay")).toBe(false);
      expect(b.querySelector(".mobile-speed-dial-btn")!.classList.contains("overlay")).toBe(true);
    }
  });

  it("AI off: the AI item stays tappable but is muted with the hint as its title", () => {
    const s = setup("float", false);
    const ai = screen.getByTestId("mobile-fab-ai");
    expect(ai.getAttribute("data-muted")).toBe("true");
    expect(ai.getAttribute("title")).toBe(t("mobile.ai_disabled_hint"));
    open();
    fireEvent.click(ai);
    expect(s.onOpenAi).toHaveBeenCalledTimes(1);
  });

  it("DOM order = keyboard / screen-reader order: ＋ first, then 녹음 → 사진 → 파일 첨부 → AI (the layer comes AFTER the ＋)", () => {
    setup();
    open();
    const order = Array.from(root().querySelectorAll("button")).map((b) => b.getAttribute("data-testid"));
    expect(order).toEqual(["mobile-fab-toggle", "mobile-fab-mic", "mobile-fab-photo", "mobile-fab-attach", "mobile-fab-ai"]);
    // 가로채기(포커스 불가)는 ＋ 앞, 레이어는 ＋ 뒤 — 겹침은 같은 z-index 에서 DOM 순서가 정한다(CSS 계약 아래).
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(catcher()!.compareDocumentPosition(toggle()) & FOLLOWING).toBeTruthy();
    expect(toggle().compareDocumentPosition(layer()) & FOLLOWING).toBeTruthy();
    expect(catcher()!.tabIndex).toBe(-1); // div — 탭 순서에 끼지 않는다
  });

  it("Tab from the open ＋ lands on the NEAREST action (녹음), then 사진, 파일 첨부; Shift+Tab walks back to ＋", async () => {
    const user = userEvent.setup();
    setup();
    await user.tab(); // 닫힌 동안엔 ＋ 만 탭 가능(항목은 tabIndex -1 + inert)
    expect(document.activeElement).toBe(toggle());
    await user.keyboard("{Enter}");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle()); // 열어도 포커스는 ＋ 에 남는다

    const [mic, photo, attach] = items();
    await user.tab();
    expect(document.activeElement).toBe(mic);
    await user.tab();
    expect(document.activeElement).toBe(photo);
    await user.tab();
    expect(document.activeElement).toBe(attach);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(photo);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(mic);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(toggle());
  });

  it("the placement is exposed for the CSS (float over the body | dock in the tool slot)", () => {
    const a = setup("float");
    expect(root().getAttribute("data-placement")).toBe("float");
    a.unmount();
    setup("dock");
    expect(root().getAttribute("data-placement")).toBe("dock");
  });
});

describe("MobileSpeedDial — actions", () => {
  it.each([
    ["mobile-fab-mic", "onOpenVoice"],
    ["mobile-fab-photo", "onPickPhoto"],
    ["mobile-fab-attach", "onOpenAttach"],
    ["mobile-fab-ai", "onOpenAi"],
  ] as const)("%s calls %s exactly once, nothing else, and closes the dial", (testId, handler) => {
    const s = setup();
    open();
    fireEvent.click(screen.getByTestId(testId));
    for (const name of ["onOpenVoice", "onPickPhoto", "onOpenAttach", "onOpenAi"] as const) {
      expect(s[name], name).toHaveBeenCalledTimes(name === handler ? 1 : 0);
    }
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(catcher()).toBeNull();
  });

  it("사진 reaches the host in the SAME tick as the tap (no timer, no await) — a deferred input.click() is refused by the WebView", () => {
    vi.useFakeTimers();
    const s = setup();
    open();
    fireEvent.click(screen.getByTestId("mobile-fab-photo"));
    // 가짜 타이머를 한 번도 안 돌렸다 — 종료 애니메이션이나 setTimeout 뒤가 아니라 클릭 핸들러 안에서 불렀다는 뜻.
    expect(s.onPickPhoto).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a tap outside (the tap-catcher) closes it without calling any action", () => {
    const s = setup();
    open();
    fireEvent.click(catcher()!);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(catcher()).toBeNull();
    expect(s.onOpenVoice).not.toHaveBeenCalled();
    expect(s.onPickPhoto).not.toHaveBeenCalled();
    expect(s.onOpenAttach).not.toHaveBeenCalled();
  });

  it("Escape closes it; focus returns to ＋ only if it was inside the actions", () => {
    setup();
    open();
    items()[1].focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());

    // 포커스가 밖(에디터)에 있으면 건드리지 않는다.
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    open();
    outside.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("other keys do not close it", () => {
    setup();
    open();
    fireEvent.keyDown(window, { key: "a" });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("MobileSpeedDial — keeps the editor focus (the soft keyboard stays up when opened from typing)", () => {
  // fireEvent.mouseDown 은 기본 동작이 막혔으면 false.
  const stays = (el: Element) => fireEvent.mouseDown(el) === false;

  it("＋, every action and the tap-catcher swallow the mousedown default", () => {
    setup();
    expect(stays(toggle())).toBe(true);
    open();
    for (const b of items()) expect(stays(b)).toBe(true);
    expect(stays(catcher()!)).toBe(true);
  });
});

describe("MobileSpeedDial — Android back key", () => {
  it("opening pushes one history marker; the back key closes the dial (and nothing else)", () => {
    const push = vi.spyOn(history, "pushState");
    setup();
    expect(push).not.toHaveBeenCalled();
    open();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ mobileModal: true });

    hardwareBack();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(catcher()).toBeNull();
  });

  it("closing it by hand pops its marker again (the stack is left as found)", async () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    setup();
    open();
    open(); // ＋ again
    await act(async () => {
      await Promise.resolve();
    });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("녹음 → the recorder takes over the SAME history entry; the next back closes the recorder while the dial stays closed", () => {
    // 닫고-열기가 한 커밋이라야 useBackClosable 의 보류 항목 입양이 일어난다 — 새 항목이 하나 더 쌓이면 뒤로가기 두 번이 필요해진다.
    const push = vi.spyOn(history, "pushState");
    function Harness() {
      const [rec, setRec] = useState(false);
      useBackClosable(rec, () => setRec(false)); // 실제 MobileVoiceRecorder/MobileModal 도 같은 훅이다
      return (
        <>
          <MobileSpeedDial
            placement="float"
            onOpenVoice={() => setRec(true)}
            onPickPhoto={() => {}}
            onOpenAttach={() => {}}
            onOpenAi={() => {}}
            aiReady
          />
          {rec && <div data-testid="recorder" />}
        </>
      );
    }
    render(<Harness />);
    open();
    expect(push).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("mobile-fab-mic"));
    expect(screen.getByTestId("recorder")).toBeTruthy();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(push).toHaveBeenCalledTimes(1); // 입양 — 두 번째 항목을 쌓지 않았다

    hardwareBack();
    expect(screen.queryByTestId("recorder")).toBeNull(); // 한 번에 녹음기가 닫히고
    expect(toggle().getAttribute("aria-expanded")).toBe("false"); // 다이얼은 다시 열리지 않는다
  });
});

// ─────────────────────────── 모션 계약 (CSS 문자열) ───────────────────────────
const raw = readFileSync("src/styles/mobile/note-capture.css", "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 선택자(공백 정규화)가 정확히 `sel` 인 첫 규칙의 본문. */
function rule(source: string, sel: string): string | null {
  const m = source.match(new RegExp(`(?:^|[}\\n])\\s*${esc(sel)}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}
/** reduced-motion 블록의 안쪽(바깥 `@media … {` 와 닫는 `}` 를 뗀 규칙들). 스피드 다이얼 블록 = 안에 .mobile-speed-dial-item 이 든 것. */
const reduced = (() => {
  const blocks = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) ?? [];
  const b = blocks.find((x) => x.includes(".mobile-speed-dial-item")) ?? "";
  return b ? b.slice(b.indexOf("{") + 1, b.lastIndexOf("}")) : "";
})();
/** @media/@supports 래퍼를 뗀 CSS — 안쪽 규칙도 `선택자 { 본문 }` 쌍으로 훑을 수 있다. */
const flat = css.replace(/@(?:media|supports)[^{]*\{/g, "");
/** 스피드 다이얼 영역 = `.mobile-speed-dial` 로 시작하는 선택자의 규칙들(주석 제거본)에서 transition 선언만. */
function dialTransitions(): string[] {
  const out: string[] = [];
  for (const m of flat.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (!/\.mobile-speed-dial/.test(m[1])) continue;
    for (const d of m[2].matchAll(/(?<![\w-])transition\s*:\s*([^;]+);/g)) out.push(d[1].trim());
  }
  return out;
}
const props = (decl: string) => decl.split(",").map((p) => p.trim().split(/\s+/)[0]);
/** 오너가 요청한 스프링의 두 숫자(note-capture.css 의 transition 줄에 그대로 적혀 있다). 상수로 두는 이유: check:type-scale ⓕ 가 테스트의 `transition:` 줄 안 생값도 읽는다. */
const SPRING = "460ms";
const STAGGER = "45ms";

describe("speed dial motion contract (note-capture.css)", () => {
  it("only transform · opacity (· visibility, to hide after the exit) ever transition — never layout, never `all`", () => {
    const all = dialTransitions();
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const decl of all) {
      for (const p of props(decl)) expect(["transform", "opacity", "visibility", "none"], decl).toContain(p); // none = reduced-motion icon
    }
  });

  it("enter is a spring: an overshooting cubic-bezier fallback AND a linear() spring that goes past 1", () => {
    const bez = css.match(/--m-dial-ease:\s*cubic-bezier\(([^)]+)\)/);
    expect(bez, "fallback easing").not.toBeNull();
    const [, y1] = bez![1].split(",").map((n) => Number(n.trim()));
    expect(y1).toBeGreaterThan(1); // control point above 1 = overshoot
    const lin = css.match(/--m-dial-ease:\s*linear\(([^)]+)\)/);
    expect(lin, "linear() spring").not.toBeNull();
    const values = lin![1].split(",").map((s) => Number(s.trim().split(/\s+/)[0]));
    expect(Math.max(...values)).toBeGreaterThan(1.05);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1); // lands exactly on the resting position
    expect(css).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\)/);
  });

  it("open: staggered by --i (nearest the ＋ first), spring on transform, fade on opacity", () => {
    const open = rule(css, '.mobile-speed-dial[data-open="true"] .mobile-speed-dial-item')!;
    expect(open).toContain("transform: none");
    expect(open).toMatch(new RegExp(`transition:[^;]*transform ${SPRING} var\\(--m-dial-ease\\) calc\\(var\\(--i\\) \\* ${STAGGER}\\)`));
    expect(open).toMatch(new RegExp(`opacity var\\(--dur-med\\) ease-out calc\\(var\\(--i\\) \\* ${STAGGER}\\)`));
    expect(open).toMatch(/pointer-events:\s*auto/);
    expect(open).toMatch(/visibility:\s*visible/);
  });

  it("the spring numbers are NOT hidden behind custom properties: every raw 460ms / 45ms sits on a transition line under a reasoned exemption comment", () => {
    // check:type-scale ⓕ only flags raw durations on `transition` lines — a `--m-dial-spring: 460ms` custom property would slip through
    // silently. The deviation from the --dur-* ladder must stay visible (CLAUDE.md: don't reshape the code so the script passes).
    expect(raw).not.toMatch(/--m-dial-(spring|stagger)/);
    const lines = raw.split("\n");
    const isTransition = (l: string) => /(?<![\w-])transition\s*:/.test(l);
    const hasRawDuration = (l: string) => /(?<![\w-])[1-9]\d*(?:\.\d+)?m?s\b/.test(l);
    const rawLines = lines.flatMap((l, i) => (isTransition(l) && hasRawDuration(l) ? [i] : []));
    expect(rawLines.length).toBeGreaterThanOrEqual(2); // the open rule + the ＋ icon
    // 면제 표지를 쪼개 쓴다 — check:type-scale 이 이 테스트 파일의 같은 줄·다음 줄까지 면제로 읽지 않게.
    const marker = ["type-scale", "exempt"].join("-");
    const reasoned = (l: string | undefined) => new RegExp(`${marker}:\\s*\\S`).test(l ?? "");
    for (const i of rawLines) expect(reasoned(lines[i]) || reasoned(lines[i - 1]), `line ${i + 1}: ${lines[i].trim()}`).toBe(true);
  });

  it("closed: starts at the ＋ (translateY by its slot, scaled down), and is invisible + untappable", () => {
    const closed = rule(css, ".mobile-speed-dial-item")!;
    expect(closed).toMatch(/transform:\s*translateY\(calc\(\(var\(--i\) \+ 1\) \* var\(--m-dial-step\)\)\) scale\(0\.5\)/);
    expect(closed).toMatch(/opacity:\s*0/);
    expect(closed).toMatch(/visibility:\s*hidden/);
    expect(closed).toMatch(/pointer-events:\s*none/);
  });

  it("exit: quick ease-in (no stagger, no spring); visibility flips only AFTER the exit finishes", () => {
    const closed = rule(css, ".mobile-speed-dial-item")!;
    const tr = closed.match(/transition:\s*([^;]+);/)![1];
    expect(tr).toContain("var(--dur-med)");
    expect(tr).toContain("var(--m-dial-out)");
    expect(tr).not.toMatch(new RegExp(`${SPRING}|${STAGGER}|--i\\b`)); // no spring, no stagger
    expect(tr).toMatch(/visibility 0s linear var\(--dur-med\)/);
    const out = css.match(/--m-dial-out:\s*cubic-bezier\(([^)]+)\)/)![1].split(",").map((n) => Number(n.trim()));
    expect(out).toEqual([0.4, 0, 1, 1]); // ease-in: slow start, fast finish
  });

  it("the ＋ icon turns 45° into × with the same spring", () => {
    expect(rule(css, '.mobile-speed-dial[data-open="true"] .mobile-speed-dial-icon')).toContain("rotate(45deg)");
    expect(rule(css, ".mobile-speed-dial-icon")).toMatch(new RegExp(`transition:\\s*transform ${SPRING} var\\(--m-dial-ease\\)`));
  });

  it("prefers-reduced-motion: no travel, no scale, no stagger, no spring — a fade only; the icon swaps instantly", () => {
    expect(reduced, "a reduced-motion block for the dial").not.toBe("");
    const bodies = [...reduced.matchAll(/([^{}]*)\{([^}]*)\}/g)];
    const itemRules = bodies.filter((b) => /\.mobile-speed-dial-item/.test(b[1]));
    expect(itemRules.length).toBeGreaterThanOrEqual(2);
    // 닫힌/열린 두 선택자 모두 이동을 없앤다 — 열린 쪽은 (0,3,0) 이라 같은 선택자로 덮어야 한다.
    expect(reduced).toContain('.mobile-speed-dial[data-open="true"] .mobile-speed-dial-item');
    for (const [, , body] of itemRules) {
      expect(body).toMatch(/transition:[^;]*opacity/);
      expect(body).not.toMatch(new RegExp(`--m-dial-ease|${SPRING}|${STAGGER}|--i\\b`));
      for (const p of props(body.match(/transition:\s*([^;]+);/)![1])) expect(["opacity", "visibility"]).toContain(p);
    }
    expect(reduced).toMatch(/transform:\s*none/);
    expect(reduced).toMatch(/\.mobile-speed-dial-icon\s*\{\s*transition:\s*none/);
  });
});

describe("speed dial layout contract (note-capture.css)", () => {
  it("float: anchored to the ＋ and opens upward; dock: anchored to the dock BAR, not to anything inside the clipping slot", () => {
    const float = rule(css, '.mobile-speed-dial[data-placement="float"] .mobile-speed-dial-layer')!;
    expect(float).toMatch(/right:\s*0/);
    expect(float).toMatch(/bottom:\s*calc\(100% \+ var\(--space-3\)\)/);
    expect(rule(css, '.mobile-speed-dial[data-placement="float"]')).toMatch(/position:\s*relative/);

    const dock = rule(css, '.mobile-speed-dial[data-placement="dock"] .mobile-speed-dial-layer')!;
    expect(dock).toMatch(/left:\s*var\(--m-gutter\)/);
    expect(dock).toMatch(/bottom:\s*calc\(100% \+ var\(--space-3\)\)/);
    // 슬롯은 overflow-x:auto(=세로도 잘림). 도크 루트가 위치 기준이 되면 펼침이 48px 줄로 잘린다 — 막대(.mobile-capture-bar)가 기준이어야 한다.
    const dockRoot = rule(css, '.mobile-speed-dial[data-placement="dock"]')!;
    expect(dockRoot).not.toMatch(/position:|overflow|transform|filter|z-index/);
    expect(rule(css, ".mobile-dock-slot")).toMatch(/overflow-x:\s*auto/);
    expect(rule(css, ".mobile-capture-bar")).toMatch(/position:\s*relative/);
    expect(rule(css, ".mobile-speed-dial-layer")).toMatch(/position:\s*absolute/);
  });

  it("the layer is click-through; the tap-catcher is fixed, full-screen and NON-dimming", () => {
    expect(rule(css, ".mobile-speed-dial-layer")).toMatch(/pointer-events:\s*none/);
    const c = rule(css, ".mobile-speed-dial-catcher")!;
    expect(c).toMatch(/position:\s*fixed/);
    expect(c).toMatch(/inset:\s*0/);
    expect(c).toMatch(/pointer-events:\s*auto/);
    expect(c).toMatch(/background:\s*transparent/);
    expect(c).not.toMatch(/opacity|rgba|--overlay|backdrop/);
  });

  it("48px targets: the row, the circle; the ＋ is 56 floating and 48 in the dock", () => {
    expect(rule(css, ".mobile-speed-dial-item")).toMatch(/min-height:\s*48px/);
    expect(rule(css, ".mobile-speed-dial .mobile-speed-dial-btn")).toMatch(/width:\s*48px;[^}]*height:\s*48px/);
    expect(rule(css, ".mobile-speed-dial .mobile-speed-dial-trigger")).toMatch(/width:\s*56px;[^}]*height:\s*56px/);
    expect(rule(css, '.mobile-speed-dial[data-placement="dock"] .mobile-speed-dial-trigger')).toMatch(/width:\s*48px;[^}]*height:\s*48px/);
  });

  it("the circle/pill/＋ are `.overlay` surfaces: its overlayIn animation is switched off, and the rules out-rank .overlay (0,1,0)", () => {
    expect(rule(css, ".mobile-speed-dial .overlay")).toMatch(/animation:\s*none/);
    for (const sel of [".mobile-speed-dial .mobile-speed-dial-btn", ".mobile-speed-dial .mobile-speed-dial-label", ".mobile-speed-dial .mobile-speed-dial-trigger"]) {
      expect(rule(css, sel), sel).not.toBeNull();
    }
    expect(rule(css, ".mobile-speed-dial .mobile-speed-dial-trigger")).toMatch(/background:\s*var\(--btn-primary-bg\)/);
  });

  it("the ＋ sits above the tap-catcher (so a second tap toggles): same token z-index, later in the DOM — see the DOM-order test", () => {
    const token = /z-index:\s*var\(--z-overlay\)/;
    expect(rule(css, ".mobile-speed-dial .mobile-speed-dial-trigger")).toMatch(token);
    expect(rule(css, ".mobile-speed-dial-layer")).toMatch(token);
    // The catcher is a sibling BEFORE the ＋ (no longer inside the layer), so it carries its own z-index to stay above the page
    // (the dock placement has no stacking context of its own) — equal to the ＋ so the ＋'s later DOM position wins.
    expect(rule(css, ".mobile-speed-dial-catcher")).toMatch(token);
  });
});

describe("the old two-button FAB stack is gone", () => {
  it("no leftover mic/+ stack classes in the CSS", () => {
    expect(css).not.toContain(".mobile-fab-btn");
    expect(css).not.toMatch(/\.mobile-note-fab\s*\{[^}]*flex-direction/);
  });
});
