import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { useSettingsStore } from "./stores/settings";
import { t } from "./i18n/t";

vi.mock("./lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({}),
  callSilent: vi.fn().mockResolvedValue({}),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

// Root cause (i18n/t.ts): t() reads uiLang imperatively via getState(), so a component that only
// calls t() — never subscribes to uiLang — does not re-render on its own when the language
// changes. App.tsx's fix: subscribe to uiLang reactively and put key={uiLang} on the top-level
// layout element, forcing every descendant (including plain t()-callers) to remount and re-run
// t() with the new language. This mirrors that shape without pulling in App's full dependency
// tree (Tauri window APIs, notes/ui stores, etc).
function Label() {
  return <div>{t("common.nav_settings")}</div>;
}

function KeyedApp() {
  const uiLang = useSettingsStore((s) => s.uiLang);
  return (
    <div key={uiLang}>
      <Label />
    </div>
  );
}

describe("App language remount (uiLang key)", () => {
  it("re-renders t()-only descendants after setUiLang, via the uiLang key remount", async () => {
    useSettingsStore.setState({ uiLang: "en" });
    render(<KeyedApp />);
    expect(screen.getByText("Settings")).toBeTruthy();

    await act(async () => {
      await useSettingsStore.getState().setUiLang("ko");
    });

    expect(screen.getByText("설정")).toBeTruthy();
  });

  it("without the key, a plain t()-only component stays stale (documents the bug this fixes)", async () => {
    useSettingsStore.setState({ uiLang: "en" });
    render(<Label />);
    expect(screen.getByText("Settings")).toBeTruthy();

    await act(async () => {
      await useSettingsStore.getState().setUiLang("ko");
    });

    // Still English — Label never subscribed to uiLang and had no reason to remount.
    expect(screen.getByText("Settings")).toBeTruthy();
  });
});
