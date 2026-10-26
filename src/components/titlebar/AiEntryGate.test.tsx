import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NoteDetail, Folder } from "../../lib/commands.gen";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

vi.mock("../PromptDialog", () => ({
  PromptDialog: () => null,
}));
vi.mock("../map/RegionPickerDialog", () => ({
  RegionPickerDialog: () => null,
}));

// Marker stub so we assert presence without rendering the full menu tree.
vi.mock("./AiActionsMenu", () => ({
  AiActionsMenu: () => <div data-testid="ai-actions-menu">AI</div>,
}));

import { TitleBar } from "../TitleBar";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";

function makeFolders(): Folder[] {
  return [
    {
      id: "f1",
      workspace_id: "ws",
      name: "Folder",
      position: 0,
      is_open: true,
      note_count: 1,
      color_hue: null,
      icon: null,
      rules: null,
      search_excluded: false,
      ai_excluded: false,
    },
  ];
}

function makeActiveNote(): NoteDetail {
  return {
    note: {
      id: "n1",
      folder_id: "f1",
      title: "Note",
      year: 1900,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: "draft",
      icon: null,
      lat: null,
      lng: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      month: null,
      day: null,
    },
    sections: [],
    sources: [],
    attachments: [],
  };
}

describe("TitleBar AI entry gate — aiEnabled + aiReachable", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    useUiStore.setState({ focusMode: false });
    useTaxonomyStore.setState({ statuses: [] });
    useSettingsStore.setState({ aiEnabled: false, uiLang: "en" } as never);
    useAiStore.setState({
      organizePending: false,
      promptPending: false,
      translateTargetLang: "en",
      translateGateOk: true,
      aiReachable: null,
      refreshTranslateGate: async () => true,
      ensureAiReachable: async () => {},
      loadHistory: async () => {},
      organizeCurrentNote: async () => {},
      generateFromPrompt: async () => null,
      setTranslateTargetLang: async () => {},
    } as never);
    useNotesStore.setState({
      activeNote: makeActiveNote(),
      folders: makeFolders(),
      savedState: "saved",
      loadTree: async () => {},
      selectNote: async () => {},
      setTitle: () => {},
      setNoteYear: () => {},
      setTags: async () => {},
      setRegion: async () => {},
      setStatus: async () => {},
      toggleFavorite: async () => {},
    } as never);
  });

  it("hides the AI entry when aiEnabled is false, even if the probe succeeded", () => {
    useSettingsStore.setState({ aiEnabled: false } as never);
    useAiStore.setState({ aiReachable: true } as never);
    render(<TitleBar />);
    expect(screen.queryByTestId("ai-actions-menu")).toBeNull();
  });

  it("hides the AI entry when aiEnabled is true but the probe returned ok: false", () => {
    useSettingsStore.setState({ aiEnabled: true } as never);
    useAiStore.setState({ aiReachable: false } as never);
    render(<TitleBar />);
    expect(screen.queryByTestId("ai-actions-menu")).toBeNull();
  });

  it("hides the AI entry while the first probe is still unknown (no flash)", () => {
    useSettingsStore.setState({ aiEnabled: true } as never);
    useAiStore.setState({ aiReachable: null } as never);
    render(<TitleBar />);
    expect(screen.queryByTestId("ai-actions-menu")).toBeNull();
  });

  it("shows the AI entry only when aiEnabled and aiReachable are both true", () => {
    useSettingsStore.setState({ aiEnabled: true } as never);
    useAiStore.setState({ aiReachable: true } as never);
    render(<TitleBar />);
    expect(screen.getByTestId("ai-actions-menu")).toBeTruthy();
  });
});
