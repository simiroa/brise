import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSection } from "./AppearanceSection";
import { useSettingsStore } from "../../stores/settings";
import { DEFAULT_ACCENT, accentHueOf, accentStepOf, hexToOklch } from "../../lib/accentPalette";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

describe("AppearanceSection (W11 / W23-d)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({});
    // isBrowser() (lib/env.ts) isn't mocked in this file — it reads this real token, so clear it
    // between tests rather than mocking the module.
    sessionStorage.removeItem("brise_sync_token");
    useSettingsStore.setState({
      theme: "dark",
      accent: "#9cc5a4",
      fontScale: 1,
      fontFamily: "serif",
      bgDim: 0,
      bgTone: 0,
      bgSat: 0,
      contentTint: 0,
      surfaceStyle: "flat",
      sheetAlpha: 0.85,
    });
  });

  it("renders appearance controls including theme, font family, font scale, brightness, surface", () => {
    render(<AppearanceSection />);

    expect(screen.getAllByText("Theme").length).toBeGreaterThanOrEqual(1);
    // PLAN-2026-10-27-fonts W5 — 앱 화면 · 노트 본문 · 코드 세 줄.
    expect(screen.getByText("App font")).toBeTruthy();
    expect(screen.getByText("Note body font")).toBeTruthy();
    expect(screen.getByText("Code font")).toBeTruthy();
    expect(screen.getByTestId("settings-font-family")).toBeTruthy();
    expect(screen.getByTestId("settings-font-editor")).toBeTruthy();
    expect(screen.getByTestId("settings-font-mono")).toBeTruthy();
    expect(screen.getByText("Font scale")).toBeTruthy();
    expect(screen.getByText("Background brightness")).toBeTruthy();
    expect(screen.getByText("Surface style")).toBeTruthy();
  });

  it("renders two cards (theme card with an accent SubGroup / font) — owner R2 2026-09-15", () => {
    const { container } = render(<AppearanceSection />);

    expect(screen.getByText("Theme & material")).toBeTruthy();
    expect(screen.getByText("Font & background")).toBeTruthy();
    // "Accent color" is both the SubGroup title and the row label.
    expect(screen.getAllByText("Accent color").length).toBe(2);
    expect(container.querySelectorAll(".card").length).toBe(2);
    const themeCard = screen.getByTestId("settings-appearance-theme");
    expect(themeCard.querySelector("[aria-label='Theme']")).toBeTruthy();
    // accent is a SubGroup inside the theme card, not its own card (R2: no single-control cards)
    const accent = screen.getByTestId("settings-appearance-accent");
    expect(accent.closest(".card")).toBe(themeCard);
    expect(accent.querySelector("[data-testid='accent-reset']")).toBeTruthy();
    expect(screen.getByTestId("settings-appearance-font").querySelector("[data-testid='settings-font-family']")).toBeTruthy();
  });

  it("switches theme between system, dark, and light", async () => {
    render(<AppearanceSection />);

    const lightBtn = screen.getByText("Light");
    await userEvent.click(lightBtn);

    expect(useSettingsStore.getState().themePref).toBe("light");
    expect(useSettingsStore.getState().theme).toBe("light");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { theme: "light" },
    });

    const sysBtn = screen.getByText("System");
    await userEvent.click(sysBtn);

    expect(useSettingsStore.getState().themePref).toBe("system");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { theme: "system" },
    });
  });

  it("switches font family via dropdown: sans, curated system font, and custom input", async () => {
    render(<AppearanceSection />);

    await userEvent.click(screen.getByTestId("settings-font-family"));
    await userEvent.click(screen.getByRole("option", { name: "Sans-serif" }));
    expect(useSettingsStore.getState().fontFamily).toBe("sans");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { font_family: "sans" },
    });

    await userEvent.click(screen.getByTestId("settings-font-family"));
    await userEvent.click(screen.getByRole("option", { name: "Malgun Gothic" }));
    expect(useSettingsStore.getState().fontFamily).toBe("Malgun Gothic");

    await userEvent.click(screen.getByTestId("settings-font-family"));
    await userEvent.click(screen.getByRole("option", { name: "Custom" }));

    const input = screen.getByPlaceholderText(/System font name/i);
    expect(input).toBeTruthy();
    // 직접 입력은 **확정(blur/Enter)에서만** 저장한다 — 타이핑마다 부르면 "Malgun Gothic" 한 번에
    // 13회 IPC 가 나가고, setFontFamily 는 call() 이라 실패 시 글자마다 토스트가 뜬다(2026-09-12).
    fireEvent.change(input, { target: { value: "Consolas" } });
    expect(useSettingsStore.getState().fontFamily).not.toBe("Consolas");

    fireEvent.blur(input);
    expect(useSettingsStore.getState().fontFamily).toBe("Consolas");
  });

  // 직접 입력 모드는 화면 상태지만 저장값을 따라간다 — 초기화·불러오기·되돌리기·다른 창·롤백.
  it("custom font mode resyncs when fontFamily changes outside this page", () => {
    useSettingsStore.setState({ fontFamily: "Consolas" });
    render(<AppearanceSection />);
    expect((screen.getByTestId("settings-font-custom-input") as HTMLInputElement).value).toBe("Consolas");

    act(() => useSettingsStore.setState({ fontFamily: "serif" }));
    expect(screen.queryByTestId("settings-font-custom-input")).toBeNull();

    act(() => useSettingsStore.setState({ fontFamily: "Fira Code" }));
    expect((screen.getByTestId("settings-font-custom-input") as HTMLInputElement).value).toBe("Fira Code");
  });

  it("clearing the custom font falls back to the app default (pretendard) and closes custom mode", () => {
    useSettingsStore.setState({ fontFamily: "Consolas" });
    render(<AppearanceSection />);
    const input = screen.getByTestId("settings-font-custom-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(useSettingsStore.getState().fontFamily).toBe("pretendard");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { font_family: "pretendard" } });
    expect(screen.queryByTestId("settings-font-custom-input")).toBeNull();
  });

  it("opening Custom on a curated font and leaving the box empty changes nothing", async () => {
    render(<AppearanceSection />);
    await userEvent.click(screen.getByTestId("settings-font-family"));
    await userEvent.click(screen.getByRole("option", { name: "Custom" }));
    fireEvent.blur(screen.getByTestId("settings-font-custom-input"));
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    expect(useSettingsStore.getState().fontFamily).toBe("serif");
    expect(screen.queryByTestId("settings-font-custom-input")).toBeNull();
  });

  it("committing an unchanged custom font does not save", () => {
    useSettingsStore.setState({ fontFamily: "Consolas" });
    render(<AppearanceSection />);
    const input = screen.getByTestId("settings-font-custom-input");
    fireEvent.change(input, { target: { value: " Consolas " } });
    fireEvent.blur(input);
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
  });

  it("a failed font save rolls the dropdown back to the previous font", async () => {
    callMock.mockReset().mockImplementation(async (cmd: string) => {
      if (cmd === "settings_set") throw new Error("db locked");
      return {};
    });
    render(<AppearanceSection />);
    await userEvent.click(screen.getByTestId("settings-font-family"));
    await userEvent.click(screen.getByRole("option", { name: "Sans-serif" }));
    await vi.waitFor(() => expect(useSettingsStore.getState().fontFamily).toBe("serif"));
  });

  it("the theme & material card leads with an icon header like the other cards", () => {
    render(<AppearanceSection />);
    const card = screen.getByTestId("settings-appearance-theme");
    const fontCard = screen.getByTestId("settings-appearance-font");
    // 두 카드 머리 모두 아이콘 칩(svg)을 단다.
    expect(card.firstElementChild?.querySelector("svg")).toBeTruthy();
    expect(fontCard.firstElementChild?.querySelector("svg")).toBeTruthy();
  });

  it("adjusts unified background brightness slider", () => {
    render(<AppearanceSection />);

    const brightnessSlider = screen.getByLabelText("Background brightness");
    expect(brightnessSlider).toBeTruthy();

    fireEvent.change(brightnessSlider, { target: { value: "50" } });
    expect(useSettingsStore.getState().bgTone).toBe(5);
    expect(useSettingsStore.getState().bgDim).toBe(0);

    fireEvent.change(brightnessSlider, { target: { value: "-50" } });
    expect(useSettingsStore.getState().bgTone).toBe(-5);
    expect(useSettingsStore.getState().bgDim).toBe(20);
  });

  it("배경 밝기 드래그 틱마다 조용히 저장하고, 손을 뗄 때 한 번 확정한다", () => {
    render(<AppearanceSection />);
    const slider = screen.getByLabelText("Background brightness");
    const bgSaves = () =>
      callMock.mock.calls.filter(
        (c) =>
          c[0] === "settings_set" &&
          ("bg_tone" in (c[1] as { entries: Record<string, unknown> }).entries ||
            "bg_dim" in (c[1] as { entries: Record<string, unknown> }).entries),
      );

    // 틱마다 저장 — 본 창이 settings-changed 로 실시간으로 따라온다(틱당 tone·dim 두 건).
    fireEvent.change(slider, { target: { value: "30" } });
    fireEvent.change(slider, { target: { value: "-50" } });
    expect(bgSaves()).toHaveLength(4);

    fireEvent.pointerUp(slider);
    expect(bgSaves()).toHaveLength(6);
    expect(bgSaves().slice(4).map((c) => c[1])).toEqual([
      { entries: { bg_tone: -5 } },
      { entries: { bg_dim: 20 } },
    ]);

    // pointerup 뒤의 blur(포커스 이동)는 같은 확정을 또 보내지 않는다.
    fireEvent.blur(slider);
    expect(bgSaves()).toHaveLength(6);
  });

  it("shows acrylic params when acrylic surface is selected", async () => {
    render(<AppearanceSection />);

    expect(screen.queryByText("Surface opacity")).toBeNull();

    const acrylicBtn = screen.getByText("Acrylic");
    await userEvent.click(acrylicBtn);

    expect(useSettingsStore.getState().surfaceStyle).toBe("acrylic");
    expect(screen.getByText("Surface opacity")).toBeTruthy();
  });

  // W5: 아크릴은 네이티브 창 재질(Mica/Acrylic, Windows 11 전용)이다. App.tsx 의 부팅 분기가
  // 브라우저 탭에서는 applySurfaceEffectAfterShow() 자체를 건너뛰므로 여기서 골라도 절대
  // 적용되지 않는다 — 죽은 컨트롤이라 통째로 가린다. 진짜 isBrowser() 판정을 쓴다(모킹 없이
  // env.ts 의 세션 토큰 계약대로).
  it("W5: hides the surface-style picker and acrylic params entirely in browser mode", () => {
    sessionStorage.setItem("brise_sync_token", "t");
    useSettingsStore.setState({ surfaceStyle: "acrylic" });
    render(<AppearanceSection />);
    expect(screen.queryByText("Surface style")).toBeNull();
    expect(screen.queryByText("Surface opacity")).toBeNull();
  });

  // ── F5(PLAN-2026-09-15): 아크릴이 실제로 안 먹은 환경 ────────────────────
  // surfaceEffectApplied 는 window_set_effect 의 실제 반환이다. Win10 등에서 flat 으로 폴백해도
  // 선택 상태는 "아크릴" 로 남아 슬라이더가 작동하는 척했다.
  it("아크릴이 적용되지 않았으면 미지원 배지가 서고 불투명도 슬라이더가 잠긴다", () => {
    useSettingsStore.setState({ surfaceStyle: "acrylic", surfaceEffectApplied: false } as never);
    render(<AppearanceSection />);

    expect(screen.getByTestId("settings-surface-unsupported")).toBeTruthy();
    expect((screen.getByTestId("settings-sheet-opacity") as HTMLInputElement).disabled).toBe(true);
  });

  it("아크릴이 적용된 환경에서는 배지도 없고 슬라이더도 살아 있다", () => {
    useSettingsStore.setState({ surfaceStyle: "acrylic", surfaceEffectApplied: true } as never);
    render(<AppearanceSection />);

    expect(screen.queryByTestId("settings-surface-unsupported")).toBeNull();
    expect((screen.getByTestId("settings-sheet-opacity") as HTMLInputElement).disabled).toBe(false);
  });

  // ── 강조색 6칩 (PLAN-2026-09-12 §4 / D4) ────────────────────────────────
  // 새 i18n 키는 .i18n-pending/ 에 있어 아직 병합 전이다 — 그래서 라벨 텍스트가 아니라
  // testid 로 잡는다(병합 뒤 문구가 바뀌어도 이 테스트는 안 흔들린다).
  describe("강조색 — hue 슬라이더 1칩 + 채도 5칩 + 초기화", () => {
    it("채도 사다리 5칩을 그리고, 저장된 색이 속한 칸이 선택돼 있다", () => {
      render(<AppearanceSection />);
      for (let i = 0; i < 5; i++) expect(screen.getByTestId(`accent-chip-${i}`)).toBeTruthy();
      // 기본 청자색은 사다리 한가운데다.
      expect(screen.getByTestId("accent-chip-2").getAttribute("aria-checked")).toBe("true");
    });

    it("칩을 누르면 같은 색상각의 다른 채도로 저장된다(hex 로)", async () => {
      render(<AppearanceSection />);
      await userEvent.click(screen.getByTestId("accent-chip-4"));

      const next = useSettingsStore.getState().accent;
      expect(next).toMatch(/^#[0-9a-f]{6}$/);
      expect(next).not.toBe(DEFAULT_ACCENT);
      expect(accentStepOf(next)).toBe(4);
      // 색상각은 건드리지 않는다 — 칩은 채도 축이다.
      expect(accentHueOf(next)).toBeCloseTo(accentHueOf(DEFAULT_ACCENT), 1);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { accent: next } });
    });

    it("무채 칩을 고르면 색이 회색이 되고 hue 칩이 죽는다", async () => {
      render(<AppearanceSection />);
      expect(screen.getByTestId("accent-hue-chip").hasAttribute("disabled")).toBe(false);

      await userEvent.click(screen.getByTestId("accent-chip-0"));

      expect(hexToOklch(useSettingsStore.getState().accent).C).toBeLessThan(0.005);
      // C=0 에서는 hue 가 결과에 영향을 주지 않는다 — 막아서 그 사실을 말한다.
      expect(screen.getByTestId("accent-hue-chip").hasAttribute("disabled")).toBe(true);
    });

    it("hue 칩을 누르면 팝오버가 열리고, 슬라이더가 색상각을 바꾼다", async () => {
      render(<AppearanceSection />);
      expect(screen.queryByTestId("accent-hue-popover")).toBeNull();

      await userEvent.click(screen.getByTestId("accent-hue-chip"));
      const slider = screen.getByTestId("accent-hue-slider");
      fireEvent.change(slider, { target: { value: "25" } });

      const next = useSettingsStore.getState().accent;
      // hex 는 8비트라 되읽은 색상각이 1~2° 어긋난다 — 그래서 손잡이 값은 저장 값에서 되읽지
      // 않는다(되읽으면 드래그 중에 손가락 밑에서 미끄러진다).
      expect(accentHueOf(next)).toBeGreaterThan(23);
      expect(accentHueOf(next)).toBeLessThan(27);
      expect((slider as HTMLInputElement).value).toBe("25");
      // 채도 칸은 그대로다 — 두 축이 서로를 밀지 않는다.
      expect(accentStepOf(next)).toBe(accentStepOf(DEFAULT_ACCENT));
    });

    it("채도 칩은 roving tabindex 다 — 탭 정지는 선택된 칩 하나, 화살표가 선택과 포커스를 옮긴다", () => {
      render(<AppearanceSection />);
      const tabStops = [0, 1, 2, 3, 4].filter(
        (i) => screen.getByTestId(`accent-chip-${i}`).getAttribute("tabindex") === "0",
      );
      expect(tabStops).toEqual([2]);

      fireEvent.keyDown(screen.getByTestId("accent-chip-2"), { key: "ArrowRight" });
      expect(accentStepOf(useSettingsStore.getState().accent)).toBe(3);
      expect(document.activeElement).toBe(screen.getByTestId("accent-chip-3"));
      expect(screen.getByTestId("accent-chip-3").getAttribute("tabindex")).toBe("0");

      fireEvent.keyDown(screen.getByTestId("accent-chip-3"), { key: "Home" });
      expect(accentStepOf(useSettingsStore.getState().accent)).toBe(0);
      expect(document.activeElement).toBe(screen.getByTestId("accent-chip-0"));
    });

    it("hue 팝오버는 열리면 슬라이더로 포커스가 들어가고, 움직이지 않은 blur 는 저장하지 않으며, Escape 는 칩으로 돌려준다", async () => {
      render(<AppearanceSection />);
      await userEvent.click(screen.getByTestId("accent-hue-chip"));
      const slider = screen.getByTestId("accent-hue-slider");
      expect(document.activeElement).toBe(slider);

      fireEvent.blur(slider);
      expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("accent-hue-popover")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("accent-hue-chip"));
    });

    it("초기화는 기본 청자색으로 정확히 되돌린다", async () => {
      useSettingsStore.setState({ accent: "#d9817a" });
      render(<AppearanceSection />);

      await userEvent.click(screen.getByTestId("accent-reset"));

      expect(useSettingsStore.getState().accent).toBe(DEFAULT_ACCENT);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { accent: DEFAULT_ACCENT } });
    });
  });

  // ── 배경 채도 (PLAN-2026-09-12 §3 / E3) ─────────────────────────────────
  describe("배경 채도 슬라이더", () => {
    it("드래그 틱은 live 로 저장하고, 밝기 슬라이더(bg_tone/bg_dim)는 건드리지 않는다", () => {
      render(<AppearanceSection />);

      fireEvent.change(screen.getByTestId("settings-bg-sat"), { target: { value: "40" } });

      expect(useSettingsStore.getState().bgSat).toBe(40);
      expect(useSettingsStore.getState().bgTone).toBe(0);
      expect(useSettingsStore.getState().bgDim).toBe(0);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_sat: 40 } });
      // 채도는 --app-canvas 한 줄에 얹힌다(그 아래 표면 파생이 전부 따라온다).
      expect(document.documentElement.style.getPropertyValue("--app-canvas")).not.toBe("#171b1a");
    });

    it("손을 뗄 때 한 번 더 확정한다 — 그 한 번이 OS 아크릴 재틴트를 맡는다", () => {
      render(<AppearanceSection />);
      const slider = screen.getByTestId("settings-bg-sat");

      fireEvent.change(slider, { target: { value: "25" } });
      const beforeCommit = callMock.mock.calls.filter(
        (c) => c[0] === "settings_set" && "bg_sat" in (c[1] as { entries: Record<string, unknown> }).entries,
      ).length;
      fireEvent.pointerUp(slider);

      const afterCommit = callMock.mock.calls.filter(
        (c) => c[0] === "settings_set" && "bg_sat" in (c[1] as { entries: Record<string, unknown> }).entries,
      ).length;
      expect(afterCommit).toBe(beforeCommit + 1);
      expect(useSettingsStore.getState().bgSat).toBe(25);
    });

    it("0 으로 되돌리면 캔버스가 테마 기준색 그대로다(기본값 = 오늘 화면)", () => {
      render(<AppearanceSection />);
      const slider = screen.getByTestId("settings-bg-sat");
      fireEvent.change(slider, { target: { value: "80" } });
      fireEvent.change(slider, { target: { value: "0" } });
      expect(document.documentElement.style.getPropertyValue("--app-canvas")).toBe("#171b1a");
    });
  });

  // ── 본문 틴트 (PLAN-2026-09-12 §5 / D6) ─────────────────────────────────
  describe("본문 밝기 슬라이더", () => {
    it("전역 배경 밝기와 **별개로** 본문만 조절하고 정수로 저장된다", () => {
      render(<AppearanceSection />);

      const slider = screen.getByTestId("settings-content-tint");
      fireEvent.change(slider, { target: { value: "-18" } });

      expect(useSettingsStore.getState().contentTint).toBe(-18);
      // 전역 슬라이더(bg_tone/bg_dim)는 건드리지 않는다 — 사이드바는 그쪽 담당이다(D6).
      expect(useSettingsStore.getState().bgTone).toBe(0);
      expect(useSettingsStore.getState().bgDim).toBe(0);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { content_tint: -18 } });
    });

    it("음수 오프셋은 틴트를 흰색으로 뒤집어 본문을 사이드바보다 밝게 만든다", () => {
      render(<AppearanceSection />);
      const root = document.documentElement;

      fireEvent.change(screen.getByTestId("settings-content-tint"), { target: { value: "-30" } });
      // 다크 기준값 16 + (-30) = -14 → 흰색 14%. `%` 가 빠지면 color-mix 가 통째로 무효가 되어
      // 본문 배경이 조용히 사라진다(계획 §5 의 경고).
      expect(root.style.getPropertyValue("--content-tint-color")).toBe("#fff");
      expect(root.style.getPropertyValue("--content-tint-amount")).toBe("14%");

      fireEvent.change(screen.getByTestId("settings-content-tint"), { target: { value: "0" } });
      expect(root.style.getPropertyValue("--content-tint-color")).toBe("#000");
      expect(root.style.getPropertyValue("--content-tint-amount")).toBe("16%");
    });
  });
});

// PLAN-2026-09-19 — 모양 초기화·되돌리기 + Windows 10 아크릴 가드
describe("AppearanceSection — theme presets & acrylic guard", () => {
  const settingsSetCalls = () => callMock.mock.calls.filter((c) => c[0] === "settings_set").map((c) => c[1]);

  beforeEach(() => {
    sessionStorage.removeItem("brise_sync_token");
    useSettingsStore.setState({
      loaded: true,
      acrylicSupported: true,
      themePref: "dark",
      theme: "dark",
      accent: "#9cc5a4",
      fontScale: 1.2,
      fontFamily: "serif",
      bgDim: 0,
      bgTone: 0,
      bgSat: 30,
      contentTint: 5,
      surfaceStyle: "flat",
      sheetAlpha: 0.85,
    });
    callMock.mockReset().mockImplementation(async (cmd: string) => {
      if (cmd === "theme_defaults") return { entries: { theme: "system", font_scale: 1, bg_sat: 0 } };
      if (cmd === "settings_get_all") return { settings: { theme: "system", font_scale: 1, bg_sat: 0 } };
      if (cmd === "window_set_effect") return { applied: true };
      return { ok: true };
    });
  });

  it("reset writes Rust defaults in one settings_set, then undo writes the previous snapshot back", async () => {
    render(<AppearanceSection />);
    expect(screen.queryByTestId("appearance-undo")).toBeNull();

    fireEvent.click(screen.getByTestId("appearance-reset"));
    const undoBtn = await screen.findByTestId("appearance-undo");
    expect(settingsSetCalls()).toEqual([{ entries: { theme: "system", font_scale: 1, bg_sat: 0 } }]);

    fireEvent.click(undoBtn);
    await vi.waitFor(() => expect(settingsSetCalls()).toHaveLength(2));
    expect(settingsSetCalls()[1]).toEqual({
      entries: {
        theme: "dark",
        accent: "#9cc5a4",
        font_family: "serif",
        font_editor: "",
        font_mono: "source-code-pro",
        font_scale: 1.2,
        bg_dim: 0,
        bg_tone: 0,
        bg_sat: 30,
        content_tint: 5,
        surface_style: "flat",
        sheet_alpha: 0.85,
      },
    });
    await vi.waitFor(() => expect(screen.queryByTestId("appearance-undo")).toBeNull());
  });

  it("locks the acrylic option on a device without acrylic support (Windows 10)", () => {
    useSettingsStore.setState({ acrylicSupported: false });
    render(<AppearanceSection />);
    const acrylic = screen.getByRole("radio", { name: "Acrylic" });
    expect(acrylic.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(acrylic);
    expect(callMock).not.toHaveBeenCalledWith("window_set_effect", expect.anything());
    expect(useSettingsStore.getState().surfaceStyle).toBe("flat");
  });

  it("keeps the acrylic option selectable when supported", () => {
    render(<AppearanceSection />);
    expect(screen.getByRole("radio", { name: "Acrylic" }).getAttribute("aria-disabled")).toBeNull();
  });
});

