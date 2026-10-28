import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FontPickerRow } from "./FontPickerRow";
import { useSettingsStore } from "../../stores/settings";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

let installed: string[] = [];
let downloading: Record<string, number> = {};

beforeEach(() => {
  installed = [];
  downloading = {};
  sessionStorage.removeItem("brise_sync_token");
  useSettingsStore.setState({ fontFamily: "pretendard", fontEditor: "", fontMono: "source-code-pro", uiLang: "en" });
  callMock.mockReset().mockImplementation(async (cmd: string, args?: { id?: string }) => {
    if (cmd === "font_status") return { installed, downloading };
    if (cmd === "font_download") {
      downloading = { [args!.id!]: 10 };
      return { started: true };
    }
    if (cmd === "fonts_base_dir") return { base: "/data/fonts" };
    return {};
  });
});

const settingsSets = () => callMock.mock.calls.filter((c) => c[0] === "settings_set").map((c) => c[1]);

describe("FontPickerRow", () => {
  it("노트 본문: 기본은 '앱 화면 글꼴과 같게', 손글씨 글꼴이 목록에 있다", async () => {
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    expect(screen.getByRole("option", { name: "Same as app font" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("option", { name: /^개구 · download .*MB/ })).toBeTruthy();
  });

  it("설치본에 든 글꼴(함렛·도현·검은고딕)은 받지 않아도 받은 것 — 받기 크기 표기가 없고 바로 저장된다", async () => {
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    const opt = await screen.findByRole("option", { name: /^도현/ });
    expect(opt.textContent).not.toMatch(/download/); // 받기 크기 표기("· download 0.2MB")가 안 붙는다
    await userEvent.click(opt);
    expect(callMock).not.toHaveBeenCalledWith("font_download", expect.anything());
    expect(settingsSets()).toEqual([{ entries: { font_editor: "catalog:do-hyeon" } }]);
  });

  it("앱 화면 목록엔 손글씨·장식이 없다(Q2)", async () => {
    render(<FontPickerRow target="ui" />);
    await userEvent.click(screen.getByTestId("settings-font-family"));
    expect(await screen.findByRole("option", { name: /^고운바탕/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^개구/ })).toBeNull();
  });

  it("받지 않은 글꼴을 고르면 받은 뒤에 적용한다", async () => {
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(await screen.findByRole("option", { name: /^개구/ }));

    expect(callMock).toHaveBeenCalledWith("font_download", { id: "gaegu" });
    expect(settingsSets()).toEqual([]); // 받기 전에는 저장하지 않는다
    expect(screen.getByTestId("settings-font-editor-download").textContent).toMatch(/Downloading font/);

    act(() => {
      installed = ["gaegu"];
      downloading = {};
    });
    await vi.waitFor(() => expect(useSettingsStore.getState().fontEditor).toBe("catalog:gaegu"), { timeout: 3000 });
    expect(settingsSets()).toEqual([{ entries: { font_editor: "catalog:gaegu" } }]);
    expect(screen.queryByTestId("settings-font-editor-download")).toBeNull();
  });

  it("받는 중에 다른 글꼴을 고르면 받기가 끝나도 나중 선택을 덮어쓰지 않는다", async () => {
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(await screen.findByRole("option", { name: /^개구/ }));
    expect(screen.getByTestId("settings-font-editor-download").textContent).toMatch(/Downloading font/);

    // 받는 도중 설치본에 든 글꼴(도현)을 고른다.
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(await screen.findByRole("option", { name: /^도현/ }));
    expect(useSettingsStore.getState().fontEditor).toBe("catalog:do-hyeon");
    expect(screen.queryByTestId("settings-font-editor-download")).toBeNull(); // 받는 중 표시도 걷힌다

    // 개구 받기가 끝난다 — 폴링이 살아 있었다면 이 틱(500ms)에 font_editor 를 개구로 덮어썼을 것이다.
    act(() => {
      installed = ["gaegu"];
      downloading = {};
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(useSettingsStore.getState().fontEditor).toBe("catalog:do-hyeon");
    expect(settingsSets()).toEqual([{ entries: { font_editor: "catalog:do-hyeon" } }]);
  });

  it("받기 실패 표시(다시 시도)도 다른 글꼴을 고르면 사라진다", async () => {
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(await screen.findByRole("option", { name: /^개구/ }));
    act(() => {
      downloading = {};
    });
    expect(await screen.findByRole("button", { name: "Try again" }, { timeout: 3000 })).toBeTruthy();

    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(await screen.findByRole("option", { name: /^도현/ }));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(settingsSets()).toEqual([{ entries: { font_editor: "catalog:do-hyeon" } }]);
  });

  it("목록 미리보기는 받은 글꼴·안 받은 글꼴 모두 이름 글자 미리보기 패밀리로 그리고, 열 때 본 글꼴 파일을 .load() 하지 않는다", async () => {
    // 앞 테스트들이 도현·개구를 고르면 실제 settings 스토어 setter → applyCssVars → loadFonts 가 본 글꼴 등록을 비동기로
    // 건다(내장 글꼴은 동적 import 뒤 addFaces). 그 꼬리가 아래에서 갈아 끼울 가짜 FontFace·document.fonts 에 늦게 떨어지면
    // "마운트가 본 글꼴을 등록·로드했다" 로 오판한다(부하·첫 import 비용에 따라 달라져 파일 단독 실행에서도 갈렸다).
    // loadFonts 는 이미 진행 중이면 그 약속을 그대로 돌려주므로, 가짜를 심기 전에 기다려 누수를 비운다.
    const loader = await import("../../lib/fonts/loader");
    await loader.loadFonts(["catalog:do-hyeon", "catalog:gaegu"]);
    const loadSpy = vi.fn();
    const added: string[] = [];
    class FakeFontFace {
      constructor(public family: string) {}
      load() {
        loadSpy(this.family);
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", {
      value: { add: (f: { family: string }) => added.push(f.family) },
      configurable: true,
    });
    try {
      installed = ["jua"]; // 받아 둔 글꼴 하나 + 내장 3종 + 안 받은 나머지
      render(<FontPickerRow target="editor" />);
      await userEvent.click(screen.getByTestId("settings-font-editor"));
      const bundled = await screen.findByRole("option", { name: /^도현/ });
      const downloaded = screen.getByRole("option", { name: /^주아/ });
      const remote = screen.getByRole("option", { name: /^개구/ });
      for (const el of [bundled, downloaded, remote]) {
        expect((el as HTMLElement).style.fontFamily).toMatch(/brise-preview-/);
      }
      // 미리보기 등록은 글꼴마다 따로 비동기(동적 import)라 순서가 부하에 따라 달라진다 — 셋 다 기다린다.
      await vi.waitFor(
        () => {
          expect(added).toContain("brise-preview-gaegu");
          expect(added).toContain("brise-preview-do-hyeon");
          expect(added).toContain("brise-preview-jua");
        },
        { timeout: 5000 },
      );
      // 본 글꼴(brise-<id>)은 마운트에서 등록·로드하지 않는다 — 현재 선택값은 설정 창 applyCssVars 의 몫.
      expect(added.filter((f) => !f.startsWith("brise-preview-"))).toEqual([]);
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(document, "fonts", { value: undefined, configurable: true });
    }
  });

  it("받기가 실패하면 다시 시도 버튼이 남고 저장하지 않는다", async () => {
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(await screen.findByRole("option", { name: /^개구/ }));
    act(() => {
      downloading = {}; // 받는 중도 아니고 받지도 못함 = 실패
    });
    expect(await screen.findByRole("button", { name: "Try again" }, { timeout: 3000 })).toBeTruthy();
    expect(settingsSets()).toEqual([]);
  });

  it("받아 둔 글꼴은 바로 저장한다", async () => {
    installed = ["jetbrains-mono"];
    render(<FontPickerRow target="mono" />);
    await userEvent.click(screen.getByTestId("settings-font-mono"));
    await userEvent.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
    expect(callMock).not.toHaveBeenCalledWith("font_download", expect.anything());
    expect(useSettingsStore.getState().fontMono).toBe("catalog:jetbrains-mono");
  });

  it("코드 글꼴: 번들 Paper Mono 를 고른다", async () => {
    render(<FontPickerRow target="mono" />);
    await userEvent.click(screen.getByTestId("settings-font-mono"));
    await userEvent.click(screen.getByRole("option", { name: "Paper Mono" }));
    expect(settingsSets()).toEqual([{ entries: { font_mono: "paper-mono" } }]);
  });

  it("'앱 화면 글꼴과 같게'로 돌아가면 빈 값을 저장한다", async () => {
    useSettingsStore.setState({ fontEditor: "serif" });
    render(<FontPickerRow target="editor" />);
    await userEvent.click(screen.getByTestId("settings-font-editor"));
    await userEvent.click(screen.getByRole("option", { name: "Same as app font" }));
    expect(settingsSets()).toEqual([{ entries: { font_editor: "" } }]);
  });

  it("내 PC 글꼴 목록을 못 읽으면 직접 입력으로 물러난다", async () => {
    render(<FontPickerRow target="ui" />);
    await userEvent.click(screen.getByTestId("settings-font-family"));
    await userEvent.click(screen.getByRole("option", { name: "Choose from installed fonts…" }));
    // jsdom 엔 queryLocalFonts 가 없다
    expect(await screen.findByTestId("settings-font-custom-input")).toBeTruthy();
  });

  it("내 PC 글꼴 목록에서 고른다", async () => {
    (window as unknown as { queryLocalFonts: unknown }).queryLocalFonts = async () => [
      { family: "Consolas" },
      { family: "Arial" },
      { family: "Arial" },
    ];
    try {
      render(<FontPickerRow target="ui" />);
      await userEvent.click(screen.getByTestId("settings-font-family"));
      await userEvent.click(screen.getByRole("option", { name: "Choose from installed fonts…" }));
      await userEvent.click(await screen.findByTestId("settings-font-family-system"));
      await userEvent.click(screen.getByRole("option", { name: "Consolas" }));
      expect(useSettingsStore.getState().fontFamily).toBe("Consolas");
    } finally {
      delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
    }
  });
});
