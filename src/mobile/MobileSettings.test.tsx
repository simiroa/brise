import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useSettingsStore } from "../stores/settings";
import { PHONE_SETTINGS_KEYS, isRemoteBlockedSettingKey } from "../lib/remoteSettingsPolicy";

vi.mock("./mobileApi", () => ({
  fetchPing: vi.fn().mockResolvedValue(null),
}));

// check:surface ⓓ — mocking lib/invoke requires callSilent alongside call (both delegate to the
// same spy here, same pattern as settings/NotificationsSection.test.tsx). This also lets the
// drift test below observe every settings_set the screen actually emits, instead of each control
// needing its own fake setter.
const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

const PRESET_LIST = [
  { id: "list", name: "Turn into a list", prompt: "List prompt", kind: "text", isBuiltin: true, hidden: false },
  { id: "summarize", name: "Summarize", prompt: "Summarize prompt", kind: "text", isBuiltin: true, hidden: false },
  { id: "metadata", name: "Auto-fill metadata", prompt: "Fixed rules text", kind: "metadata", isBuiltin: true, hidden: false },
  { id: "diagram", name: "Create a relationship diagram", prompt: "Diagram prompt", kind: "diagram", isBuiltin: true, hidden: false },
  { id: "c1", name: "My custom action", prompt: "Do the thing", kind: "text", isBuiltin: false, hidden: false },
];

const loadMock = vi.fn().mockResolvedValue(undefined);
const addCustomMock = vi.fn().mockResolvedValue(undefined);
const updateItemMock = vi.fn().mockResolvedValue(undefined);
const deleteItemMock = vi.fn().mockResolvedValue(undefined);
const resetItemMock = vi.fn().mockResolvedValue(undefined);
let presetsState = {
  list: PRESET_LIST,
  loaded: true,
  load: loadMock,
  addCustom: addCustomMock,
  updateItem: updateItemMock,
  deleteItem: deleteItemMock,
  resetItem: resetItemMock,
};
vi.mock("../stores/aiPresets", () => ({
  useAiPresetsStore: (selector: (s: typeof presetsState) => unknown) => selector(presetsState),
  visiblePresets: (list: typeof PRESET_LIST) => list.filter((p) => !p.hidden),
}));

import { MobileSettings } from "./MobileSettings";

const DEFAULT_ROSTER = [
  { mode: "region", enabled: true },
  { mode: "timeline", enabled: true },
  { mode: "calendar", enabled: true },
  { mode: "gallery", enabled: true },
  { mode: "chat", enabled: true },
];

beforeEach(() => {
  loadMock.mockClear();
  addCustomMock.mockClear();
  updateItemMock.mockClear();
  deleteItemMock.mockClear();
  resetItemMock.mockClear();
  callMock.mockClear();
  callMock.mockResolvedValue({ settings: {} });
  presetsState = { ...presetsState, list: PRESET_LIST, loaded: true };
  // aiEnabled defaults true here so the existing "AI 프리셋 편집" suite (written before the AI
  // gate existed) keeps seeing the preset list without every test having to opt in. aiEnabled is
  // now READ ONLY in the component (D8) — no setter to fake, just the boolean.
  useSettingsStore.setState({
    uiLang: "en",
    aiEnabled: true,
    filterRoster: DEFAULT_ROSTER.map((e) => ({ ...e })),
    notificationsEnabled: false,
    reminderAllDayAt: "00:00",
  } as any);
  localStorage.clear();
});

/** Owner verdict on an earlier screen: every element was the same one-line row, so pick-one
 *  settings, openable editors and read-only info were indistinguishable. These lock the three
 *  species apart. */
describe("MobileSettings — information architecture", () => {
  it("each pick-one setting is ONE row carrying its current value (not one row per option)", () => {
    render(<MobileSettings />);

    for (const [testid, label, value] of [
      ["mobile-settings-choice-theme", "Theme", "Follow system"],
      ["mobile-settings-choice-font", "Text size", "Medium"],
      ["mobile-settings-choice-lang", "Language", "English"],
    ]) {
      const row = screen.getByTestId(testid);
      expect(row.tagName).toBe("BUTTON");
      expect(row.textContent).toContain(label);
      expect(row.textContent).toContain(value);
    }
    // The old screen burned 3 rows on the theme group; the other two options must NOT be rows.
    expect(screen.queryByText("Dark")).toBeNull();
    expect(screen.queryByText("Light")).toBeNull();
  });

  it("tapping a pick-one row opens a picker listing every option with the current one checked", () => {
    render(<MobileSettings />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-settings-choice-theme"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Theme");
    for (const opt of ["Follow system", "Light", "Dark"]) {
      expect(within(dialog).getByText(opt)).toBeTruthy();
    }
    const selected = within(dialog).getByText("Follow system").closest("button")!;
    expect(selected.getAttribute("data-selected")).toBe("true");
  });

  it("choosing a value closes the picker and updates the row's displayed value", () => {
    render(<MobileSettings />);
    expect(screen.getByTestId("mobile-settings-choice-font").textContent).toContain("Medium");

    fireEvent.click(screen.getByTestId("mobile-settings-choice-font"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Large"));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("mobile-settings-choice-font").textContent).toContain("Large");
    expect(localStorage.getItem("brise_mobile_font_size")).toBe("large");
  });

  it("AI 작업 rows read as editable items — a per-row edit affordance plus a group hint", () => {
    render(<MobileSettings />);
    expect(screen.getByText("Tap an action to edit its name and prompt.")).toBeTruthy();
    // one affordance slot per preset, each holding icons (pencil + chevron)
    expect(screen.getByTestId("mobile-settings-ai-edit-summarize").querySelectorAll("svg").length).toBe(2);
  });

  it("the AI editor opens in the centered modal primitive, with its actions in the modal footer", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Summarize"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("mobile-modal")).toBe(true);
    // The footer must live INSIDE the dialog — that's what keeps it above the keyboard.
    const footer = within(dialog).getByTestId("mobile-modal-footer");
    expect(within(footer).getByText("Save")).toBeTruthy();
    expect(within(footer).getByText("Cancel")).toBeTruthy();
    // ...and the fields are in the scrolling body, not the footer.
    expect(within(footer).queryByPlaceholderText("Prompt")).toBeNull();
  });

  it("연결 정보 is a different species: not a button, no tap handler, no row hairline", () => {
    render(<MobileSettings />);
    const info = screen.getByTestId("mobile-settings-info-server");
    expect(info.tagName).toBe("DIV");
    expect(info.closest("button")).toBeNull();
    expect(info.classList.contains("mobile-settings-row")).toBe(false);
    expect(info.classList.contains("mobile-settings-info")).toBe(true);
  });

  it("the list ends with a spacer so the last row clears the tab bar", () => {
    render(<MobileSettings />);
    const spacer = screen.getByTestId("mobile-settings-bottom-space");
    expect(spacer.parentElement?.classList.contains("mobile-settings")).toBe(true);
    expect(spacer.parentElement?.lastElementChild).toBe(spacer);
  });

  it("shows the per-device hint once for the appearance section, not per row", () => {
    render(<MobileSettings />);
    expect(screen.getAllByTestId("mobile-settings-device-only")).toHaveLength(1);
    expect(screen.queryByTestId("mobile-settings-device-only-theme")).toBeNull();
  });
});

// D8 — the master toggle wrote ai_enabled, which the remote server rejects with 400
// (lib/remoteSettingsPolicy.ts::isRemoteBlockedSettingKey). setSimplePref's optimistic update then
// rolled back and call() toasted an error — a live bug. The toggle is gone; aiEnabled is read-only
// and the row is replaced by a read-only hint pointing at desktop settings.
describe("MobileSettings — AI 마스터 토글 제거 (D8)", () => {
  it("does not render the AI master toggle, even when aiEnabled is on", () => {
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<MobileSettings />);
    expect(screen.queryByTestId("mobile-settings-ai-enabled")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Enable AI features" })).toBeNull();
  });

  it("shows a read-only hint pointing at desktop settings only while AI is off", () => {
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileSettings />);
    const hint = screen.getByTestId("mobile-settings-ai-desktop-hint");
    expect(hint.textContent).toBe("Enable AI from desktop Settings.");
    expect(hint.tagName).not.toBe("BUTTON");
    expect(hint.closest("button")).toBeNull();
  });

  it("hides the desktop-enable hint when AI is already on", () => {
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<MobileSettings />);
    expect(screen.queryByTestId("mobile-settings-ai-desktop-hint")).toBeNull();
  });
});

// D8 — pet is a desktop-local window; this screen's bar is "meaningful on this device". The
// pet_persona_* keys stay remote-allowed and keep working from desktop's own PetPersonaSection.
describe("MobileSettings — 펫 페르소나 섹션 제거 (D8)", () => {
  it("does not render the persona row or its prompt textarea", () => {
    render(<MobileSettings />);
    expect(screen.queryByTestId("mobile-settings-persona")).toBeNull();
    expect(screen.queryByTestId("mobile-settings-persona-prompt")).toBeNull();
  });
});

// aiEnabled is still read (not written) here to gate the presets group's visibility.
describe("MobileSettings — AI 프리셋 노출 게이트 (aiEnabled read-only)", () => {
  it("hides the AI-actions editor (hint, preset rows, add button) when aiEnabled is off", () => {
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileSettings />);
    expect(screen.queryByText("Tap an action to edit its name and prompt.")).toBeNull();
    expect(screen.queryByText("Summarize")).toBeNull();
    expect(screen.queryByText("Add prompt")).toBeNull();
  });

  it("shows the AI-actions editor once aiEnabled is on", () => {
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<MobileSettings />);
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("Add prompt")).toBeTruthy();
  });
});

// filter_roster — the round's headline addition. on/off + reorder via up/down buttons, NOT the
// desktop segmented-strip-with-drag (FilterRosterStrip.tsx) — phones have no hover/drag precision.
describe("MobileSettings — 보기(사이드바 구성, filter_roster)", () => {
  it("no roster view is marked unavailable on the phone any more (region+chat opened 2026-10-06), rows stay", () => {
    render(<MobileSettings />);
    expect(screen.queryByTestId("mobile-settings-roster-hint-region")).toBeNull();
    expect(screen.queryByTestId("mobile-settings-roster-hint-chat")).toBeNull();
    expect(screen.queryByTestId("mobile-settings-roster-hint-timeline")).toBeNull();
    expect(screen.getByTestId("mobile-settings-roster-region")).toBeTruthy();
    expect(screen.getByTestId("mobile-settings-roster-chat")).toBeTruthy();
  });

  it("renders one row per roster entry, in store order, with its icon/label and current on/off state", () => {
    useSettingsStore.setState({
      filterRoster: [
        { mode: "region", enabled: true },
        { mode: "timeline", enabled: false },
        { mode: "calendar", enabled: true },
        { mode: "gallery", enabled: true },
        { mode: "chat", enabled: true },
      ],
    } as any);
    render(<MobileSettings />);

    const row = screen.getByTestId("mobile-settings-roster-timeline");
    expect(within(row).getByRole("switch").hasAttribute("checked")).toBe(false);
    expect((within(row).getByRole("switch") as HTMLInputElement).checked).toBe(false);
    const regionRow = screen.getByTestId("mobile-settings-roster-region");
    expect((within(regionRow).getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });

  it("toggling a row's checkbox persists filter_roster with only that entry flipped, order intact", async () => {
    render(<MobileSettings />);
    const row = screen.getByTestId("mobile-settings-roster-timeline");
    fireEvent.click(within(row).getByRole("switch"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: {
          filter_roster: [
            { mode: "region", enabled: true },
            { mode: "timeline", enabled: false },
            { mode: "calendar", enabled: true },
            { mode: "gallery", enabled: true },
            { mode: "chat", enabled: true },
          ],
        },
      }),
    );
  });

  it("refuses to turn off the last enabled entry instead of silently jumping to a different one", () => {
    useSettingsStore.setState({
      filterRoster: [
        { mode: "region", enabled: true },
        { mode: "timeline", enabled: false },
        { mode: "calendar", enabled: false },
        { mode: "gallery", enabled: false },
        { mode: "chat", enabled: false },
      ],
    } as any);
    render(<MobileSettings />);
    const row = screen.getByTestId("mobile-settings-roster-region");
    fireEvent.click(within(row).getByRole("switch"));
    expect(callMock).not.toHaveBeenCalled();
  });

  it("the first row's move-up is disabled and the last row's move-down is disabled", () => {
    render(<MobileSettings />);
    const [firstUp] = within(screen.getByTestId("mobile-settings-roster-region")).getAllByRole("button");
    const buttonsLast = within(screen.getByTestId("mobile-settings-roster-chat")).getAllByRole("button");
    expect((firstUp as HTMLButtonElement).disabled).toBe(true);
    expect((buttonsLast[1] as HTMLButtonElement).disabled).toBe(true); // move-down
  });

  it("move-down persists filter_roster with that entry and its neighbor swapped", async () => {
    render(<MobileSettings />);
    const [, downBtn] = within(screen.getByTestId("mobile-settings-roster-region")).getAllByRole("button");
    fireEvent.click(downBtn);

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: {
          filter_roster: [
            { mode: "timeline", enabled: true },
            { mode: "region", enabled: true },
            { mode: "calendar", enabled: true },
            { mode: "gallery", enabled: true },
            { mode: "chat", enabled: true },
          ],
        },
      }),
    );
  });
});

// notifications_enabled / reminder_all_day_at — same keys, same "HH:MM" value shape as desktop's
// NotificationsSection (docs/PLAN-schedule-system.md §5.5).
describe("MobileSettings — 알림", () => {
  it("toggle defaults to off and persists notifications_enabled on tap", async () => {
    render(<MobileSettings />);
    const row = screen.getByTestId("mobile-settings-notifications-enabled");
    const checkbox = within(row).getByRole("switch") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { notifications_enabled: true } }),
    );
  });

  it("all-day reminder time is disabled while notifications are off", () => {
    render(<MobileSettings />);
    const input = screen.getByTestId("mobile-settings-reminder-time").querySelector('input[type="time"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "09:30" } });
    expect(callMock).not.toHaveBeenCalled();
  });

  it("all-day reminder time defaults to 00:00 and persists reminder_all_day_at once notifications are on", async () => {
    useSettingsStore.setState({ notificationsEnabled: true } as any);
    render(<MobileSettings />);
    const row = screen.getByTestId("mobile-settings-reminder-time");
    const input = row.querySelector('input[type="time"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("00:00");

    fireEvent.change(input, { target: { value: "09:30" } });
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { reminder_all_day_at: "09:30" } }),
    );
  });
});

// D9 — the phone screen is a SUMMARY, not a shrunk desktop settings page. This line is what makes
// that legible instead of implicit.
describe('MobileSettings — "나머지는 데스크톱에서" 안내 (D9)', () => {
  it("shows a read-only hint at the bottom that is not a button", () => {
    render(<MobileSettings />);
    const hint = screen.getByTestId("mobile-settings-desktop-only-hint");
    expect(hint.textContent).toBe("Change the rest of your settings in desktop Brise.");
    expect(hint.tagName).not.toBe("BUTTON");
    expect(hint.closest("button")).toBeNull();
  });
});

// Drift prevention (WORKORDER-2026-09-02 §W4 검증): PHONE_SETTINGS_KEYS is the SSOT for what this
// screen may persist. Two directions can drift apart from it — the policy could list a key the
// server actually blocks, or this screen could grow a control emitting a key the policy doesn't
// know about. Both are caught here instead of at "the toggle rolled back in the field" time.
describe("MobileSettings — 노출 키 드리프트 방지", () => {
  it("(a) every PHONE_SETTINGS_KEYS entry is allowed by the remote policy mirror", () => {
    for (const key of PHONE_SETTINGS_KEYS) {
      expect(isRemoteBlockedSettingKey(key)).toBe(false);
    }
  });

  it("(b) every settings_set key this screen actually emits is a subset of PHONE_SETTINGS_KEYS", async () => {
    render(<MobileSettings />);

    // Exercise every control that can call settings_set: language picker, roster checkbox +
    // reorder, notifications toggle, reminder time. (Theme/font are device-local — localStorage,
    // no settings_set — and are deliberately NOT exercised here.)
    fireEvent.click(screen.getByTestId("mobile-settings-choice-lang"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Français"));

    const rosterRow = screen.getByTestId("mobile-settings-roster-timeline");
    fireEvent.click(within(rosterRow).getByRole("switch"));
    const [, rosterDown] = within(screen.getByTestId("mobile-settings-roster-region")).getAllByRole("button");
    fireEvent.click(rosterDown);

    fireEvent.click(within(screen.getByTestId("mobile-settings-notifications-enabled")).getByRole("switch"));
    useSettingsStore.setState({ notificationsEnabled: true } as any);
    fireEvent.change(
      screen.getByTestId("mobile-settings-reminder-time").querySelector('input[type="time"]')!,
      { target: { value: "08:00" } },
    );

    await waitFor(() => expect(callMock.mock.calls.length).toBeGreaterThan(0));

    const emittedKeys = new Set<string>();
    for (const call of callMock.mock.calls) {
      const [cmd, args] = call as [string, { entries?: Record<string, unknown> } | undefined];
      if (cmd === "settings_set" && args?.entries) {
        for (const k of Object.keys(args.entries)) emittedKeys.add(k);
      }
    }
    expect(emittedKeys.size).toBeGreaterThan(0);
    for (const k of emittedKeys) {
      expect(PHONE_SETTINGS_KEYS as readonly string[]).toContain(k);
    }
  });
});

describe("MobileSettings — AI 프리셋 편집", () => {
  it("loads the shared store on mount when not yet loaded", () => {
    presetsState = { ...presetsState, loaded: false };
    render(<MobileSettings />);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("lists every visible preset's name under the note-action presets header", async () => {
    render(<MobileSettings />);
    // 2026-08-08 Q4: 데스크톱 AI 하위 탭 3개(연결/노트 작업 프리셋/펫)를 리스트 섹션으로 미러링.
    expect(await screen.findByText("Note action presets")).toBeTruthy();
    expect(screen.getByText("Turn into a list")).toBeTruthy();
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("Auto-fill metadata")).toBeTruthy();
    expect(screen.getByText("Create a relationship diagram")).toBeTruthy();
    expect(screen.getByText("My custom action")).toBeTruthy();
  });

  it("the diagram (관계도 만들기) preset is editable like the text ones — name + prompt + Reset to default, no read-only hint", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Create a relationship diagram"));

    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByDisplayValue("Diagram prompt") as HTMLTextAreaElement).readOnly).toBe(false);
    expect(within(dialog).getByText("Reset to default")).toBeTruthy();
    expect(within(dialog).queryByText("Delete")).toBeNull();
  });

  it("a hidden (deleted) built-in does not render", () => {
    presetsState = { ...presetsState, list: PRESET_LIST.map((p) => (p.id === "list" ? { ...p, hidden: true } : p)) };
    render(<MobileSettings />);
    expect(screen.queryByText("Turn into a list")).toBeNull();
  });

  it("tapping a text preset opens the edit sheet pre-filled with its name and prompt", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Summarize"));

    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByDisplayValue("Summarize") as HTMLInputElement).value).toBe("Summarize");
    expect((within(dialog).getByDisplayValue("Summarize prompt") as HTMLTextAreaElement).value).toBe("Summarize prompt");
  });

  it("tapping the metadata preset shows the guidance hint (not the old fixed-rules hint) and an EDITABLE prompt field — mobile now matches desktop's AiActionsSection", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Auto-fill metadata"));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "This prompt only adjusts guidance — what to prioritize, tone, domain hints. The output format (the JSON fields) is fixed by the app and can't be changed."
      )
    ).toBeTruthy();
    expect(
      within(dialog).queryByText(
        "This item's analysis rules are fixed in the app — editing the prompt has no effect on the result."
      )
    ).toBeNull();
    const textarea = within(dialog).getByDisplayValue("Fixed rules text") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
  });

  it("editing the metadata prompt and saving calls updateItem with the new prompt text (proves it's genuinely editable, not just unlocked visually)", async () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Auto-fill metadata"));
    const dialog = screen.getByRole("dialog");

    fireEvent.change(within(dialog).getByDisplayValue("Fixed rules text"), {
      target: { value: "우선순위: 최근 사건 위주로" },
    });
    fireEvent.click(within(dialog).getByText("Save"));

    await waitFor(() =>
      expect(updateItemMock).toHaveBeenCalledWith("metadata", {
        name: "Auto-fill metadata",
        prompt: "우선순위: 최근 사건 위주로",
      })
    );
  });

  it("editing a built-in's name/prompt and saving calls updateItem with the patch, then closes", async () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Summarize"));
    const dialog = screen.getByRole("dialog");

    fireEvent.change(within(dialog).getByDisplayValue("Summarize"), { target: { value: "Summarize it" } });
    fireEvent.change(within(dialog).getByDisplayValue("Summarize prompt"), { target: { value: "New prompt text" } });
    fireEvent.click(within(dialog).getByText("Save"));

    await waitFor(() =>
      expect(updateItemMock).toHaveBeenCalledWith("summarize", { name: "Summarize it", prompt: "New prompt text" })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a built-in's sheet offers Reset to default, not Delete", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Summarize"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Reset to default")).toBeTruthy();
    expect(within(dialog).queryByText("Delete")).toBeNull();
  });

  it("a custom action's sheet offers Delete, not Reset to default; deleting calls deleteItem", async () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("My custom action"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Reset to default")).toBeNull();

    fireEvent.click(within(dialog).getByText("Delete"));
    await waitFor(() => expect(deleteItemMock).toHaveBeenCalledWith("c1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resetting a built-in calls resetItem with its id", async () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Summarize"));
    fireEvent.click(screen.getByText("Reset to default"));
    await waitFor(() => expect(resetItemMock).toHaveBeenCalledWith("summarize"));
  });

  it("the Add preset row opens a blank sheet; filling it in and saving calls addCustom", async () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Add prompt"));
    const dialog = screen.getByRole("dialog");

    expect((within(dialog).getByPlaceholderText("Prompt name") as HTMLInputElement).value).toBe("");
    fireEvent.change(within(dialog).getByPlaceholderText("Prompt name"), { target: { value: "Translate to French" } });
    fireEvent.change(within(dialog).getByPlaceholderText("Prompt"), { target: { value: "Translate this to French:" } });
    fireEvent.click(within(dialog).getByText("Save"));

    await waitFor(() =>
      expect(addCustomMock).toHaveBeenCalledWith("Translate to French", "Translate this to French:")
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Save is disabled while the name is empty", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Add prompt"));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Save stays disabled for a new custom action until BOTH name and prompt are filled (addCustom itself no-ops on an empty prompt)", () => {
    render(<MobileSettings />);
    fireEvent.click(screen.getByText("Add prompt"));
    const dialog = screen.getByRole("dialog");

    fireEvent.change(within(dialog).getByPlaceholderText("Prompt name"), { target: { value: "Only a name" } });
    expect((within(dialog).getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  });
});

// S2 입력 그룹 — 사진/음성/정리는 공유 DB 키(settings_set), 위치는 기기별 localStorage.
describe("MobileSettings — 입력 그룹", () => {
  beforeEach(() => {
    useSettingsStore.setState({ photoMetaMode: "auto", voiceTranscribeMode: "auto", voiceCleanupMode: "off" } as any);
  });
  const pick = (testid: string, option: string) => {
    fireEvent.click(screen.getByTestId(testid));
    fireEvent.click(within(screen.getByRole("dialog")).getByText(option));
  };

  it("shows the three defaults (photo auto / voice auto / cleanup off / location ask)", () => {
    render(<MobileSettings />);
    expect(screen.getByTestId("mobile-settings-choice-photo").textContent).toContain("Auto");
    expect(screen.getByTestId("mobile-settings-choice-voice").textContent).toContain("Auto");
    expect(screen.getByTestId("mobile-settings-choice-cleanup").textContent).toContain("Off");
    expect(screen.getByTestId("mobile-settings-choice-loc").textContent).toContain("Ask");
  });

  it.each([
    ["mobile-settings-choice-photo", "Ask", "photo_meta_mode", "ask"],
    ["mobile-settings-choice-voice", "Off", "voice_transcribe_mode", "off"],
    ["mobile-settings-choice-cleanup", "Auto", "voice_cleanup_mode", "auto"],
  ])("%s -> %s saves %s=%s", (testid, option, key, value) => {
    render(<MobileSettings />);
    pick(testid, option);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { [key]: value } });
  });

  it("rolls the row back when the save fails", async () => {
    callMock.mockRejectedValue(new Error("boom"));
    render(<MobileSettings />);
    pick("mobile-settings-choice-photo", "Off");
    await waitFor(() => expect(screen.getByTestId("mobile-settings-choice-photo").textContent).toContain("Auto"));
  });

  it("location mode is per-device localStorage and never hits settings_set", () => {
    render(<MobileSettings />);
    pick("mobile-settings-choice-loc", "Auto");
    expect(screen.getByTestId("mobile-settings-choice-loc").textContent).toContain("Auto");
    expect(localStorage.getItem("brise_mobile_loc_mode")).toBe("auto");
    expect(callMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-settings-input-device-only")).toBeTruthy();
  });

  it("voice row is disabled with a reason while AI is off, and discloses audio upload while on", () => {
    render(<MobileSettings />);
    expect(screen.getByTestId("mobile-settings-hint-voice").textContent).toContain("sent to the AI service");
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<MobileSettings />);
    const rows = screen.getAllByTestId("mobile-settings-choice-voice");
    const row = rows[rows.length - 1] as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByTestId("mobile-settings-hint-voice").pop()!.textContent).toContain("AI connection is off");
  });

  it("rows keep label and value in separate spans so large text can wrap/ellipsize", () => {
    render(<MobileSettings />);
    const row = screen.getByTestId("mobile-settings-choice-photo");
    expect(row.querySelector(".mobile-settings-value")).toBeTruthy();
    expect(row.children.length).toBe(2);
  });
});
