import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* H2 회귀: 창은 `visible: false` 로 만들어지므로 show() 가 유일한 표시 경로다. 테마(data-theme)와
   최대화가 적용된 뒤에만 show() 가 불려야 한다 — 순서가 곧 결함 부재다. 크기·위치는 Rust 가 창이 숨겨진
   채 setup 에서 이미 복원한다(src-tauri/src/window_geometry.rs) — 여기서 다시 하지 않는다. */

const calls: string[] = [];
let themeAtShow: string | null = null;
let minimized = false;
let rafQueue: FrameRequestCallback[] = [];

let onResizedCb: (() => void) | null = null;
let onCloseCb: (() => void) | null = null;

const win = {
  onResized: async (cb: () => void) => { onResizedCb = cb; return () => {}; },
  onMoved: async () => () => {},
  onCloseRequested: async (cb: () => void) => { onCloseCb = cb; return () => {}; },
  isMinimized: async () => minimized,
  isMaximized: async () => false,
  outerPosition: async () => ({ x: 300, y: 400 }),
  innerSize: async () => ({ width: 1400, height: 900 }),
  outerSize: async () => ({ width: 1418, height: 910 }),
  setSize: vi.fn(async () => void calls.push("setSize")),
  setPosition: vi.fn(async () => void calls.push("setPosition")),
  maximize: vi.fn(async () => void calls.push("maximize")),
  show: vi.fn(async () => {
    themeAtShow = document.documentElement.getAttribute("data-theme");
    calls.push("show");
  }),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
  availableMonitors: async () => [{ position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }],
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalSize: class { constructor(public width: number, public height: number) {} },
  PhysicalPosition: class { constructor(public x: number, public y: number) {} },
}));
vi.mock("./invoke", () => ({
  call: async (cmd: string) =>
    cmd === "settings_get_all"
      ? { settings: { window_geometry: JSON.stringify({ x: 300, y: 400, width: 1400, height: 900 }) } }
      : {},
  callSilent: async (cmd: string) =>
    cmd === "settings_get_all"
      ? { settings: { window_geometry: JSON.stringify({ x: 300, y: 400, width: 1400, height: 900 }) } }
      : {},
}));

import { applyThemeGeometryAndShow, currentWindowGeometry, trackWindowGeometry } from "./bootWindow";

// jsdom 은 rAF 를 실제로 돌리지 않으므로 큐를 직접 흘려보낸다.
async function drainUntilShown(pending: Promise<void>): Promise<void> {
  for (let i = 0; i < 40 && !calls.includes("show"); i++) {
    await Promise.resolve();
    for (const cb of rafQueue.splice(0)) cb(0);
  }
  await pending;
}

beforeEach(() => {
  calls.length = 0;
  themeAtShow = null;
  minimized = false;
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafQueue.push(cb));
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

describe("applyThemeGeometryAndShow", () => {
  it("shows the window only after the theme is applied, and leaves size/position to Rust", async () => {
    await drainUntilShown(
      applyThemeGeometryAndShow(() => document.documentElement.setAttribute("data-theme", "light")),
    );

    expect(themeAtShow).toBe("light"); // show() 시점에 이미 테마가 붙어 있어야 한다
    expect(calls).not.toContain("setSize");
    expect(calls).not.toContain("setPosition");
    expect(calls).not.toContain("maximize");
  });

  it("maximizes before show when the saved geometry was maximized", async () => {
    const raw = { window_geometry: JSON.stringify({ x: 0, y: 0, width: 1400, height: 900, maximized: true }) };
    await drainUntilShown(applyThemeGeometryAndShow(() => {}, raw));
    expect(calls.indexOf("maximize")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("maximize")).toBeLessThan(calls.indexOf("show"));
  });

  it("still shows the window when applyRoot does nothing", async () => {
    // show() 를 테마에 의존시켜 창이 영영 안 뜨는 일은 없어야 한다.
    await drainUntilShown(applyThemeGeometryAndShow(() => {}));
    expect(calls).toContain("show");
    expect(themeAtShow).toBeNull();
  });
});

describe("currentWindowGeometry", () => {
  it("saves the inner size, not the outer size", async () => {
    // setSize 는 inner 를 설정한다. outer(1418x910)를 저장하면 테두리만큼 매 실행 커진다.
    expect(JSON.parse((await currentWindowGeometry())!)).toMatchObject({
      x: 300, y: 400, width: 1400, height: 900,
    });
  });

  it("refuses to save while minimized", async () => {
    minimized = true;
    expect(await currentWindowGeometry()).toBeNull();
  });
});

describe("trackWindowGeometry", () => {
  it("persists a resize after the debounce", async () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    trackWindowGeometry((g) => saved.push(g));
    await vi.advanceTimersByTimeAsync(0); // listeners attach
    onResizedCb!();
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(1);
    vi.useRealTimers();
  });

  it("drops a pending save once the window is closing", async () => {
    // 창 해체 중 resize 는 프레임이 벗겨진 크기를 보고한다 — 그걸 저장하면 매 종료마다 창이 자란다.
    vi.useFakeTimers();
    const saved: string[] = [];
    trackWindowGeometry((g) => saved.push(g));
    await vi.advanceTimersByTimeAsync(0);
    onResizedCb!();          // 종료 직전 resize
    onCloseCb!();            // 닫기 요청
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(0);
    vi.useRealTimers();
  });
});
