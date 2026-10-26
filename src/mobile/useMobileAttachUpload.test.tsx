import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// A minimal notes store: only what the upload line touches. `setState` is where the list re-renders from,
// so the duration lookup is sampled right there (that is the ordering the attachment row depends on).
const h = vi.hoisted(() => ({
  state: { activeNote: null as null | { note: { id: string }; attachments: unknown[] } },
  ensureMaterialized: vi.fn(async () => "n1"),
  setState: vi.fn(),
}));
vi.mock("../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({ activeNote: h.state.activeNote, ensureMaterialized: h.ensureMaterialized }),
    setState: (s: unknown) => h.setState(s),
  },
}));
vi.mock("../lib/invoke", () => ({ emitNotice: vi.fn(), call: vi.fn(), callSilent: vi.fn() }));
vi.mock("./mobileApi", async (orig) => ({ ...(await orig<typeof import("./mobileApi")>()), uploadAttachment: vi.fn() }));

import { uploadAttachment } from "./mobileApi";
import { useMobileAttachUpload } from "./useMobileAttachUpload";
import { getVoiceDuration, resetVoiceDurations } from "./voiceDurations";

const upload = vi.mocked(uploadAttachment);
const audioRow = (id: string, kind = "audio") => ({
  id,
  name: "voice-20261007-120000.m4a",
  kind,
  rel_path: `n1/${id}.m4a`,
  url: null,
  size_bytes: 10,
  position: 0,
});
const rec = (durationMs: number) => ({
  file: new File(["x"], "voice-20261007-120000.m4a", { type: "audio/mp4" }),
  recordedAt: "2026-10-07T12:00:00+09:00",
  durationMs,
});

beforeEach(() => {
  resetVoiceDurations();
  upload.mockReset();
  h.setState.mockReset();
  h.state.activeNote = { note: { id: "n1" }, attachments: [] };
});

describe("useMobileAttachUpload — voice duration hand-off", () => {
  it("records the recorder's duration under the new attachment id BEFORE the list is re-rendered", async () => {
    upload.mockResolvedValue(audioRow("att9") as never);
    let seenAtPatch: number | undefined = -1;
    h.setState.mockImplementation(() => {
      seenAtPatch = getVoiceDuration("att9");
    });
    const onAudioUploaded = vi.fn();
    const { result } = renderHook(() => useMobileAttachUpload({ onAudioUploaded }));

    let ok = false;
    await act(async () => {
      ok = await result.current.onVoiceFinished(rec(54_321));
    });

    expect(ok).toBe(true);
    expect(seenAtPatch).toBe(54_321); // the store patch (what draws the row) already saw it
    expect(getVoiceDuration("att9")).toBe(54_321);
    expect(onAudioUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "att9" }),
      "n1",
      expect.objectContaining({ durationMs: 54_321 }),
    );
  });

  it("still records it when the user has moved to another note (the row shows it when they come back)", async () => {
    upload.mockResolvedValue(audioRow("att10") as never);
    h.state.activeNote = { note: { id: "other" }, attachments: [] };
    const { result } = renderHook(() => useMobileAttachUpload({ onAudioUploaded: vi.fn() }));
    await act(async () => {
      await result.current.onVoiceFinished(rec(12_000));
    });
    expect(getVoiceDuration("att10")).toBe(12_000);
    expect(h.setState).not.toHaveBeenCalled();
  });

  it("remembers nothing for a failed upload, an audio file picked from the device, or a non-audio row", async () => {
    upload.mockRejectedValueOnce(new Error("HTTP 500"));
    const { result } = renderHook(() => useMobileAttachUpload({ onAudioUploaded: vi.fn() }));
    await act(async () => {
      expect(await result.current.onVoiceFinished(rec(9000))).toBe(false);
    });

    upload.mockResolvedValueOnce(audioRow("picked") as never); // no recorder meta: nothing measured it
    await act(async () => {
      result.current.onFilesPicked("audio", [new File(["x"], "song.m4a")] as unknown as FileList);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(getVoiceDuration("picked")).toBeUndefined();

    upload.mockResolvedValueOnce(audioRow("img1", "image") as never);
    await act(async () => {
      await result.current.onVoiceFinished(rec(9000));
    });
    expect(getVoiceDuration("img1")).toBeUndefined();
  });
});

describe("useMobileAttachUpload — retry after a failed recording upload (X-9)", () => {
  it("drops the crash copy when a retry succeeds, and not before", async () => {
    const confirmSession = vi.fn(async () => {});
    upload.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(audioRow("att11") as never);
    const { result } = renderHook(() => useMobileAttachUpload({ onAudioUploaded: vi.fn() }));
    let ok = true;
    await act(async () => {
      ok = await result.current.onVoiceFinished({ ...rec(5_000), confirmSession });
    });
    expect(ok).toBe(false);
    expect(confirmSession).not.toHaveBeenCalled();
    const key = result.current.pending[0].key;
    await act(async () => {
      result.current.retryUpload(key);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(confirmSession).toHaveBeenCalledTimes(1));
  });

  it("reuses the same uploadId on retry for idempotency (M-18)", async () => {
    upload.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(audioRow("att12") as never);
    const { result } = renderHook(() => useMobileAttachUpload({ onAudioUploaded: vi.fn() }));
    await act(async () => {
      await result.current.onVoiceFinished(rec(5_000));
    });
    expect(upload).toHaveBeenCalledTimes(1);
    const firstUploadId = upload.mock.calls[0][3];
    expect(firstUploadId).toBeDefined();

    const key = result.current.pending[0].key;
    await act(async () => {
      result.current.retryUpload(key);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const secondUploadId = upload.mock.calls[1][3];
    expect(secondUploadId).toBe(firstUploadId);
  });
});

describe("useMobileAttachUpload — failure notice (X-8)", () => {
  it("no toast for a recording while the recorder sheet shows the failure; a toast otherwise", async () => {
    const { emitNotice } = await import("../lib/invoke");
    const { setRecorderSheetOpen } = await import("./voiceHandOff");
    const { useSettingsStore } = await import("../stores/settings");
    useSettingsStore.setState({ voiceTranscribeMode: "auto" } as never);
    vi.mocked(emitNotice).mockClear();
    upload.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useMobileAttachUpload({ onAudioUploaded: vi.fn() }));
    setRecorderSheetOpen(true);
    await act(async () => { await result.current.onVoiceFinished(rec(1_000)); });
    expect(emitNotice).not.toHaveBeenCalled();
    setRecorderSheetOpen(false);
    await act(async () => { await result.current.onVoiceFinished(rec(1_000)); });
    expect(emitNotice).toHaveBeenCalledTimes(1);
  });
});
