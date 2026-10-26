import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useAiStore } from "../../stores/ai";
import { OnboardingImportStep } from "./OnboardingImportStep";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({
  isBrowser: () => mockBrowser,
}));

// 네이티브 OS 드래그&드롭(useFileDropZone)이 구독하는 Tauri webview 이벤트 — AskAiModal.test.tsx와
// 같은 모양으로 dropHandler를 잡아 직접 호출한다(HTML5 DnD는 실제 경로를 안 준다).
type DropPayload = { type: string; paths: string[]; position: { x: number; y: number } };
let dropHandler: ((e: { payload: DropPayload }) => void) | null = null;
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: DropPayload }) => void) => {
      dropHandler = cb;
      return Promise.resolve(() => {
        dropHandler = null;
      });
    },
  }),
}));

function drop(path: string) {
  return act(async () => {
    dropHandler!({ payload: { type: "drop", paths: [path], position: { x: 0, y: 0 } } });
  });
}

describe("OnboardingImportStep", () => {
  beforeEach(() => {
    mockBrowser = false;
    dropHandler = null;
    callMock.mockReset().mockResolvedValue({ imported: 3, skipped: 0, note_ids: ["n1", "n2", "n3"] });
    useSettingsStore.setState({ uiLang: "en", aiEnabled: false } as any);
    useAiStore.setState({ aiReachable: null, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    useNotesStore.setState({
      ensureInboxId: vi.fn().mockResolvedValue("inbox-1"),
      loadTree: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it("renders the drop zone and the picker fallback", async () => {
    render(<OnboardingImportStep onImported={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("onboarding-import-dropzone")).toBeTruthy();
    expect(screen.getByTestId("import-sources-dropdown")).toBeTruthy();
    await waitFor(() => expect(dropHandler).not.toBeNull());
  });

  it("browser mode: no drop zone, just the desktop-only explanation", () => {
    mockBrowser = true;
    render(<OnboardingImportStep onImported={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("onboarding-import-dropzone")).toBeNull();
    expect(screen.queryByTestId("import-sources-dropdown")).toBeNull();
    expect(screen.getByText("Desktop app only")).toBeTruthy();
  });

  it("dropping a .zip routes to the Notion importer", async () => {
    const onImported = vi.fn();
    render(<OnboardingImportStep onImported={onImported} onCancel={vi.fn()} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    await drop("C:/export/Notion Export.zip");

    expect(callMock).toHaveBeenCalledWith("migration_import_notion", { folder_id: "inbox-1", zip_path: "C:/export/Notion Export.zip" });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it("dropping a .enex routes to the Evernote importer", async () => {
    const onImported = vi.fn();
    render(<OnboardingImportStep onImported={onImported} onCancel={vi.fn()} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    await drop("C:/export/notes.enex");

    expect(callMock).toHaveBeenCalledWith("migration_import_enex", { folder_id: "inbox-1", enex_path: "C:/export/notes.enex" });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it("dropping a folder (no extension) routes to the Markdown importer", async () => {
    const onImported = vi.fn();
    render(<OnboardingImportStep onImported={onImported} onCancel={vi.fn()} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    await drop("C:/export/my-notes");

    expect(callMock).toHaveBeenCalledWith("migration_import_markdown", { folder_id: "inbox-1", source_dir: "C:/export/my-notes" });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it("dropping an unsupported extension shows an inline message and calls no IPC", async () => {
    const onImported = vi.fn();
    render(<OnboardingImportStep onImported={onImported} onCancel={vi.fn()} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    await drop("C:/export/photo.png");

    expect(callMock).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.getByTestId("onboarding-import-error")).toBeTruthy();
  });

  it("a failed import shows an inline error instead of calling onCancel (stays to retry)", async () => {
    callMock.mockResolvedValue({ imported: 0, skipped: 0, note_ids: [] });
    const onImported = vi.fn();
    const onCancel = vi.fn();
    render(<OnboardingImportStep onImported={onImported} onCancel={onCancel} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    await drop("C:/export/notes.enex");

    await waitFor(() => expect(screen.getByTestId("onboarding-import-error")).toBeTruthy());
    expect(onImported).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
