import { describe, it, expect, vi, beforeEach } from "vitest";

// WHERE THE PNG GOES is the whole subject of this file — see flowPng.ts's header for the two
// destinations (a path the user picks, and an attachment on the note) and why `<a download>` is not
// one of them. These tests are about the PAYLOAD and the FEEDBACK (the two things the old path got
// wrong: an unverifiable write and a silent one), never about the raster itself — html-to-image is
// stubbed.
const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({
  written_path: "C:/Users/me/diagram.png",
}));
const emitNotice = vi.fn();
const reloadActive = vi.fn(async () => {});
const save = vi.fn(async (_opts?: unknown): Promise<string | null> => "C:/Users/me/diagram.png");
let activeNote: { note: { id: string } } | null = { note: { id: "note-1" } };

vi.mock("../../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: (message: string) => emitNotice(message),
}));
vi.mock("../../stores/notes", () => ({
  useNotesStore: { getState: () => ({ activeNote, reloadActive }) },
}));
vi.mock("html-to-image", () => ({
  toPng: async () => "data:image/png;base64,QUJD",
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (opts?: unknown) => save(opts),
}));

import { exportFlowPngAttachment, exportFlowPngToFile, pngFilename } from "./flowPng";

/** FlowCanvas's own `.diagram-flow` div, reduced to the one child the raster step looks for. */
function host(): HTMLElement {
  const el = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.className = "react-flow__viewport";
  el.appendChild(viewport);
  return el;
}

const NODES = [{ id: "n1", position: { x: 0, y: 0 }, width: 100, height: 40, data: {} }];

describe("exportFlowPngToFile — the PNG lands where the user pointed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue("C:/Users/me/diagram.png");
    call.mockResolvedValue({ written_path: "C:/Users/me/diagram.png" });
  });

  it("writes the chosen path through export_diagram_png, base64 payload only", async () => {
    expect(await exportFlowPngToFile(host(), NODES, "#fff")).toBe(true);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ defaultPath: pngFilename() });

    expect(call).toHaveBeenCalledTimes(1);
    const [cmd, args] = call.mock.calls[0];
    expect(cmd).toBe("export_diagram_png");
    expect(args).toEqual({
      dest_path: "C:/Users/me/diagram.png",
      // The `data:image/png;base64,` prefix must NOT ride along — the Rust side decodes raw base64
      // and answers VALIDATION if it does.
      data_base64: "QUJD",
    });
    // The notice names WHERE it went — an export the user cannot find did not export anything.
    expect(emitNotice.mock.calls[0][0]).toContain("C:/Users/me/diagram.png");
  });

  it("does nothing at all when the save dialog is cancelled — no write, no toast", async () => {
    save.mockResolvedValue(null);
    // true, not false: the caller's failure notice is for things that went wrong, and the user's
    // own Esc is not one of them.
    expect(await exportFlowPngToFile(host(), NODES, "#fff")).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(emitNotice).not.toHaveBeenCalled();
  });

  it("never opens a dialog for an empty diagram", async () => {
    expect(await exportFlowPngToFile(host(), [], "#fff")).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("exportFlowPngAttachment — the copy that travels with the note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeNote = { note: { id: "note-1" } };
  });

  it("saves the raster as an attachment on the active note, base64 payload only", async () => {
    expect(await exportFlowPngAttachment(host(), NODES, "#fff")).toBe(true);

    expect(call).toHaveBeenCalledTimes(1);
    const [cmd, args] = call.mock.calls[0];
    expect(cmd).toBe("attachment_add_bytes");
    expect(args).toEqual({ note_id: "note-1", name: pngFilename(), data_base64: "QUJD" });
    // No file dialog on this path — the destination is the note itself.
    expect(save).not.toHaveBeenCalled();
  });

  it("refreshes the note so the attachment card shows it, and names the file in a notice", async () => {
    await exportFlowPngAttachment(host(), NODES, "#fff");
    // Without this the file exists on disk and nowhere on screen — the original complaint.
    expect(reloadActive).toHaveBeenCalledTimes(1);
    expect(emitNotice).toHaveBeenCalledTimes(1);
    expect(emitNotice.mock.calls[0][0]).toContain(pngFilename());
  });

  it("writes nothing and reports failure with no active note to attach to", async () => {
    activeNote = null;
    expect(await exportFlowPngAttachment(host(), NODES, "#fff")).toBe(false);
    expect(call).not.toHaveBeenCalled();
    // The caller owns the failure notice (FlowCanvas's exportPng) — this must not double up.
    expect(emitNotice).not.toHaveBeenCalled();
  });

  it("writes nothing on an empty diagram", async () => {
    expect(await exportFlowPngAttachment(host(), [], "#fff")).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});
