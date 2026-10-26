import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockCall = vi.fn().mockResolvedValue({ settings: { spellcheck_enabled: false } });
const mockCallSilent = vi.fn().mockResolvedValue({});
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => mockCall(...args),
  callSilent: (...args: unknown[]) => mockCallSilent(...args),
}));

import { SpellcheckToggle } from "./SpellcheckToggle";
import { useSettingsStore } from "../../stores/settings";

afterEach(() => {
  cleanup();
  mockCall.mockClear();
  mockCallSilent.mockClear();
});

// 2026-09-20 — spellcheck_enabled 가 로컬 state 에서 스토어 simplePref(spellcheckEnabled)로
// 승격되면서(설정 > 에디터 페이지에 같은 토글이 하나 더 생겨 두 창이 값을 공유해야 했다),
// 매 테스트를 스토어 기본값에서 시작하도록 초기화한다 — 싱글턴 스토어라 이전 테스트의 토글이
// 새지 않게.
beforeEach(() => {
  mockCall.mockResolvedValue({ settings: { spellcheck_enabled: false } });
  act(() => {
    useSettingsStore.setState({ spellcheckEnabled: false } as never);
  });
});

describe("SpellcheckToggle", () => {
  it("renders with toolbar-btn class and toggles data-active and aria-pressed", async () => {
    const mockEditor = {
      view: {
        dom: {
          setAttribute: vi.fn(),
        },
      },
      isDestroyed: false,
    };

    await act(async () => {
      render(<SpellcheckToggle editor={mockEditor as never} />);
    });

    const button = screen.getByRole("button");
    expect(button.className).toContain("toolbar-btn");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-active")).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-active")).toBe("true");
    expect(mockEditor.view.dom.setAttribute).toHaveBeenCalledWith("spellcheck", "true");
    // 클릭이 실제로 영속한다 — 스토어 simplePref 경유(setSimplePref -> settings_set).
    expect(mockCall).toHaveBeenCalledWith("settings_set", { entries: { spellcheck_enabled: true } });
  });

  // 설정 창(별도 웹뷰)에서 같은 키를 바꾸면 이 창은 "settings-changed" 이벤트를 받아 load() 를
  // 다시 돌린다(lib/settingsChanged.ts) — 여기서는 그 결과인 settings_get_all 응답만 흉내 내어,
  // 이미 열려 있는 에디터 툴바 토글이 그 재조회만으로(클릭 없이) 값을 따라가는지 증명한다.
  it("설정 창에서 바뀐 spellcheckEnabled 가 load() 재조회 뒤 이미 열려 있는 에디터 툴바에도 반영된다", async () => {
    const mockEditor = {
      view: {
        dom: {
          setAttribute: vi.fn(),
        },
      },
      isDestroyed: false,
    };

    await act(async () => {
      render(<SpellcheckToggle editor={mockEditor as never} />);
    });
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");

    mockCall.mockResolvedValueOnce({ settings: { spellcheck_enabled: true } });
    await act(async () => {
      await useSettingsStore.getState().load();
    });

    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
    expect(mockEditor.view.dom.setAttribute).toHaveBeenCalledWith("spellcheck", "true");
  });
});
