import { describe, it, expect, beforeEach } from "vitest";
import { activityButtonInfo } from "./App";
import { useSettingsStore } from "./stores/settings";
import { t } from "./i18n/t";

// Pure-function unit test — App itself pulls in the full Tauri/window/store dependency tree
// (see App.langRemount.test.tsx), so the saving/failed → color+tooltip branch is tested against
// the extracted activityButtonInfo() rather than a full App render.
describe("activityButtonInfo (frame-top activity button doubling as save-state indicator)", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en" });
  });

  it("no active note: plain button, no color, regardless of savedState", () => {
    const info = activityButtonInfo(false, "failed");
    expect(info.title).toBe(t("activity.header_button"));
    expect(info.color).toBeUndefined();
  });

  it("failed with an active note: danger color + actionable hint in the tooltip", () => {
    const info = activityButtonInfo(true, "failed");
    expect(info.color).toBe("var(--danger)");
    expect(info.title).toContain(t("activity.header_button"));
    expect(info.title).toContain(t("note.save_failed"));
    expect(info.title).toContain(t("note.save_failed_hint"));
    expect(info.ariaLabel).toBe(`${t("note.save_failed")} — ${t("common.retry")}`);
  });

  it("saving with an active note: accent color", () => {
    const info = activityButtonInfo(true, "saving");
    expect(info.color).toBe("var(--accent)");
    expect(info.title).toBe(
      t("activity.header_button_with_state", { button: t("activity.header_button"), state: t("note.saving") }),
    );
  });

  it("saved/ai_organized with an active note: normal look (no color), state still in tooltip", () => {
    const saved = activityButtonInfo(true, "saved");
    expect(saved.color).toBeUndefined();
    expect(saved.title).toContain(t("note.saved_dot_just_now"));

    const aiOrganized = activityButtonInfo(true, "ai_organized");
    expect(aiOrganized.color).toBeUndefined();
    expect(aiOrganized.title).toContain(t("note.ai_organized"));
  });
});
