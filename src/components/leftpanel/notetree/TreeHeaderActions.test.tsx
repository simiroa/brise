import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUiStore } from "../../../stores/ui";
import { usePresetsStore } from "../../../stores/presets";
import { useSettingsStore } from "../../../stores/settings";
import { useAiStore } from "../../../stores/ai";
import { TreeHeaderActions } from "./TreeHeaderActions";

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({}),
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));

describe("TreeHeaderActions", () => {
  beforeEach(() => {
    useUiStore.setState({ trashOpen: false });
    usePresetsStore.setState({ loaded: true, customPresets: [] } as any);
    useSettingsStore.setState({ aiEnabled: false } as any);
    useAiStore.setState({
      aiReachable: false,
      ensureAiReachable: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it("renders a presets button and a trash button", () => {
    render(<TreeHeaderActions />);
    expect(screen.getByRole("button", { name: "Manage presets — note & AI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trash" })).toBeTruthy();
  });

  it("clicking the trash button flips the ui store's trashOpen", async () => {
    render(<TreeHeaderActions />);
    await userEvent.click(screen.getByRole("button", { name: "Trash" }));
    expect(useUiStore.getState().trashOpen).toBe(true);
  });

  it("clicking the presets button opens a modal showing the reused PresetList", async () => {
    render(<TreeHeaderActions />);
    await userEvent.click(screen.getByRole("button", { name: "Manage presets — note & AI" }));
    expect(screen.getByText("Blank note")).toBeTruthy();
    // 진입점 일원화(2026-09-27) — 같은 모달이 노트 프리셋과 AI 프리셋을 둘 다 다룬다.
    expect(screen.getByRole("tab", { name: "Note presets" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Custom prompts" })).toBeTruthy();
  });
});
