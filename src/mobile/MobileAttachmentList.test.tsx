import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({}));
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: vi.fn(),
  // Importing the real useNotesStore (below) transitively runs stores/notesActive.ts's module-init,
  // which registers an autosave flush callback via lib/noteAutosave.ts — needs a stub here even
  // though this file never calls it directly (same requirement MobileActionSheet.test.tsx has).
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

import { MobileAttachmentList, type PendingAttachment } from "./MobileAttachmentList";
import type { Attachment } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { rememberVoiceDuration, resetVoiceDurations } from "./voiceDurations";

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "a1",
    name: "file",
    kind: "doc",
    rel_path: "n1/file",
    url: null,
    size_bytes: 1024,
    position: 0,
    ...overrides,
  };
}

afterEach(() => {
  sessionStorage.clear();
  resetVoiceDurations();
});

describe("MobileAttachmentList", () => {
  it("renders nothing when there are no attachments and nothing pending", () => {
    const { container } = render(<MobileAttachmentList attachments={[]} pending={[]} onRetry={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an image as a clickable thumbnail, and opens the fullscreen viewer on tap", () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    render(
      <MobileAttachmentList
        attachments={[attachment({ id: "img1", name: "sunset.jpg", kind: "image", rel_path: "n1/sunset.jpg" })]}
        pending={[]}
        onRetry={() => {}}
      />
    );

    const thumb = screen.getByLabelText("sunset.jpg");
    const img = thumb.querySelector("img")!;
    expect(img.src).toContain("sunset.jpg");
    expect(img.src).toContain("tok-abc");

    fireEvent.click(thumb);
    // Fullscreen viewer close button (aria-label "Close").
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  it("renders audio as a native <audio controls> row with the filename", () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    render(
      <MobileAttachmentList
        attachments={[attachment({ id: "au1", name: "memo.m4a", kind: "audio", rel_path: "n1/memo.m4a" })]}
        pending={[]}
        onRetry={() => {}}
      />
    );

    expect(screen.getByText("memo.m4a")).toBeTruthy();
    const audio = document.querySelector("audio")!;
    expect(audio).toBeTruthy();
    expect(audio.getAttribute("src")).toContain("memo.m4a");
  });

  it("renders a doc attachment as a name+size row with a download link", () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    render(
      <MobileAttachmentList
        attachments={[attachment({ id: "d1", name: "report.pdf", kind: "doc", rel_path: "n1/report.pdf", size_bytes: 2048 })]}
        pending={[]}
        onRetry={() => {}}
      />
    );

    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    const link = screen.getByText("Download").closest("a")!;
    expect(link.getAttribute("download")).toBe("report.pdf");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("does not render link/note/internal attachments (no rel_path — no file to serve)", () => {
    render(
      <MobileAttachmentList
        attachments={[
          attachment({ id: "l1", name: "External", kind: "link", rel_path: null, url: "https://example.com" }),
          attachment({ id: "n1", name: "Related note", kind: "internal", rel_path: null, url: "note-2" }),
        ]}
        pending={[]}
        onRetry={() => {}}
      />
    );

    expect(screen.queryByText("External")).toBeNull();
    expect(screen.queryByText("Related note")).toBeNull();
  });

  it("shows an uploading placeholder tile for a pending photo, and a retry action once it errors", () => {
    const onRetry = vi.fn();
    const pending: PendingAttachment[] = [{ key: "p1", name: "new.jpg", kind: "photo", status: "uploading" }];
    const { rerender } = render(<MobileAttachmentList attachments={[]} pending={pending} onRetry={onRetry} />);
    expect(screen.getByText("Uploading…")).toBeTruthy();

    const errored: PendingAttachment[] = [{ key: "p1", name: "new.jpg", kind: "photo", status: "error" }];
    rerender(<MobileAttachmentList attachments={[]} pending={errored} onRetry={onRetry} />);
    const retryBtn = screen.getByText(/Retry/);
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledWith("p1");
  });

  it("shows an uploading/failed row for a pending non-photo file, with a retry action", () => {
    const onRetry = vi.fn();
    const pending: PendingAttachment[] = [{ key: "p2", name: "memo.m4a", kind: "audio", status: "error" }];
    render(<MobileAttachmentList attachments={[]} pending={pending} onRetry={onRetry} />);

    expect(screen.getByText("memo.m4a")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith("p2");
  });
});

// K4 (W6): long-press -> confirm -> attachment_remove. Pessimistic (call-then-patch, see
// MobileAttachmentList.tsx's own header comment on runDelete) — there is nothing optimistic to roll
// back, so a failed delete just leaves the row and the store untouched.
describe("MobileAttachmentList — long-press delete (K4, W6)", () => {
  beforeEach(() => {
    call.mockClear();
    call.mockResolvedValue({});
    useNotesStore.setState({ activeNote: null } as any);
  });

  async function longPress(el: Element) {
    fireEvent.pointerDown(el);
    // lib/longPress.ts's real 400ms window.setTimeout — real (not faked) timers, matching the
    // existing long-press test precedent (MobileNoteTree.test.tsx). Polls for the confirm dialog's
    // own text instead of a fixed sleep slightly longer than 400ms: a bare setTimeout(…,450) raced
    // the internal timer under the full suite's parallel load and occasionally lost (flake caught
    // in a full `npx vitest run`, not in this file alone) — waitFor's poll-until-true has no such
    // race, it just waits however long the timer actually takes, up to the timeout.
    await waitFor(() => expect(screen.getByText("Delete this attachment?")).toBeTruthy(), { timeout: 2000 });
    fireEvent.pointerUp(el);
  }

  it("long-pressing an image thumbnail opens a delete confirmation instead of the viewer", async () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    const att = attachment({ id: "img1", name: "sunset.jpg", kind: "image", rel_path: "n1/sunset.jpg" });
    render(<MobileAttachmentList attachments={[att]} pending={[]} onRetry={() => {}} />);

    await longPress(screen.getByLabelText("sunset.jpg"));

    expect(screen.getByText("Delete this attachment?")).toBeTruthy();
    expect(screen.queryByLabelText("Close")).toBeNull(); // fullscreen viewer did not also open
  });

  it("long-pressing a doc row (not just its download link) opens the same delete confirmation", async () => {
    const att = attachment({ id: "d1", name: "report.pdf", kind: "doc", rel_path: "n1/report.pdf" });
    render(<MobileAttachmentList attachments={[att]} pending={[]} onRetry={() => {}} />);

    await longPress(screen.getByText("report.pdf").closest(".mobile-attach-row")!);

    expect(screen.getByText("Delete this attachment?")).toBeTruthy();
  });

  it("long-pressing an audio row opens the same delete confirmation", async () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    const att = attachment({ id: "au1", name: "memo.m4a", kind: "audio", rel_path: "n1/memo.m4a" });
    render(<MobileAttachmentList attachments={[att]} pending={[]} onRetry={() => {}} />);

    await longPress(screen.getByText("memo.m4a").closest(".mobile-attach-row")!);

    expect(screen.getByText("Delete this attachment?")).toBeTruthy();
  });

  it("confirming delete calls attachment_remove({id}) and patches the note's attachments in the store", async () => {
    const att = attachment({ id: "img1", name: "sunset.jpg", kind: "image", rel_path: "n1/sunset.jpg" });
    useNotesStore.setState({
      activeNote: { note: { id: "note-1" }, sections: [], sources: [], attachments: [att] } as any,
    } as any);
    render(<MobileAttachmentList attachments={[att]} pending={[]} onRetry={() => {}} />);

    await longPress(screen.getByLabelText("sunset.jpg"));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("attachment_remove", { id: "img1" }));
    await waitFor(() => expect(useNotesStore.getState().activeNote!.attachments).toEqual([]));
    expect(screen.queryByText("Delete this attachment?")).toBeNull();
  });

  it("a failed delete leaves the store untouched and keeps the confirm dialog open to retry/cancel", async () => {
    call.mockRejectedValueOnce({ code: "NOT_FOUND", message: "gone" });
    const att = attachment({ id: "img1", name: "sunset.jpg", kind: "image", rel_path: "n1/sunset.jpg" });
    useNotesStore.setState({
      activeNote: { note: { id: "note-1" }, sections: [], sources: [], attachments: [att] } as any,
    } as any);
    render(<MobileAttachmentList attachments={[att]} pending={[]} onRetry={() => {}} />);

    await longPress(screen.getByLabelText("sunset.jpg"));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("attachment_remove", { id: "img1" }));
    expect(useNotesStore.getState().activeNote!.attachments).toEqual([att]);
    expect(screen.getByText("Delete this attachment?")).toBeTruthy();
  });

  it("Cancel closes the confirmation without calling attachment_remove", async () => {
    const att = attachment({ id: "img1", name: "sunset.jpg", kind: "image", rel_path: "n1/sunset.jpg" });
    render(<MobileAttachmentList attachments={[att]} pending={[]} onRetry={() => {}} />);

    await longPress(screen.getByLabelText("sunset.jpg"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByText("Delete this attachment?")).toBeNull();
    expect(call).not.toHaveBeenCalledWith("attachment_remove", expect.anything());
  });
});

// 폰 녹음(조각난 MP4)은 <audio> 가 길이를 5초로 읽는다 — 녹음기가 잰 길이를 아는 행은 그 길이를 직접 그린다.
describe("MobileAttachmentList — voice duration (fragmented MP4 reports 0:05)", () => {
  const voiceAtt = (id: string) => attachment({ id, name: "voice-20261007-120000.m4a", kind: "audio", rel_path: `n1/${id}.m4a` });

  it("a recording whose duration the recorder measured shows that duration in a custom player, not native controls", () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    rememberVoiceDuration("au_known", 54_000);
    render(<MobileAttachmentList attachments={[voiceAtt("au_known")]} pending={[]} onRetry={() => {}} />);

    expect(screen.getByTestId("audio-time").textContent).toBe("0:00 / 0:54");
    const audio = document.querySelector("audio")!;
    expect(audio.hasAttribute("controls")).toBe(false);
    expect(audio.getAttribute("src")).toContain("au_known.m4a");

    // The element then claims the first 5s fragment is the whole file: the row does not follow it.
    Object.defineProperty(audio, "duration", { configurable: true, value: 5 });
    fireEvent(audio, new Event("durationchange"));
    expect(screen.getByTestId("audio-time").textContent).toBe("0:00 / 0:54");
  });

  it("an older recording (duration unknown) keeps the native <audio controls> row, unchanged", () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    rememberVoiceDuration("someone_else", 54_000);
    render(<MobileAttachmentList attachments={[voiceAtt("au_old")]} pending={[]} onRetry={() => {}} />);

    const audio = document.querySelector("audio")!;
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.className).toContain("mobile-attach-audio");
    expect(screen.queryByTestId("audio-time")).toBeNull();
  });

  it("each audio row uses its own duration", () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    rememberVoiceDuration("a_short", 12_000);
    render(
      <MobileAttachmentList attachments={[voiceAtt("a_short"), voiceAtt("a_unknown")]} pending={[]} onRetry={() => {}} />,
    );
    expect(screen.getAllByTestId("audio-time").map((n) => n.textContent)).toEqual(["0:00 / 0:12"]);
    expect(document.querySelectorAll("audio[controls]")).toHaveLength(1);
  });

  it("long-pressing the player's row still opens the delete confirmation", async () => {
    sessionStorage.setItem("brise_sync_token", "tok-abc");
    rememberVoiceDuration("au_lp", 12_000);
    render(<MobileAttachmentList attachments={[voiceAtt("au_lp")]} pending={[]} onRetry={() => {}} />);
    fireEvent.pointerDown(screen.getByTestId("audio-time"));
    await waitFor(() => expect(screen.getByText("Delete this attachment?")).toBeTruthy(), { timeout: 2000 });
    fireEvent.pointerUp(screen.getByTestId("audio-time"));
  });

  it("shows specific error messages for key, format, in_progress, deadline and hides retry for isSettingsFix", () => {
    const vAtt = voiceAtt("au_err");
    const onTranscribe = vi.fn();
    const voiceProps = (code: any) => ({
      transcribeMode: "off" as const,
      states: { au_err: { status: "error" as const, code } },
      cleanupOffers: new Set<string>(),
      onTranscribe,
      onInsert: vi.fn(),
      onCleanup: vi.fn(),
    });

    // key -> settings fix, retry hidden
    const { rerender } = render(<MobileAttachmentList attachments={[vAtt]} pending={[]} onRetry={() => {}} voice={voiceProps("key")} />);
    expect(screen.getByTestId("voice-error")).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();

    // format -> settings fix, retry hidden
    rerender(<MobileAttachmentList attachments={[vAtt]} pending={[]} onRetry={() => {}} voice={voiceProps("format")} />);
    expect(screen.queryByText("Retry")).toBeNull();

    // in_progress -> retry shown
    rerender(<MobileAttachmentList attachments={[vAtt]} pending={[]} onRetry={() => {}} voice={voiceProps("in_progress")} />);
    expect(screen.getByText("Retry")).toBeTruthy();

    // deadline -> retry shown
    rerender(<MobileAttachmentList attachments={[vAtt]} pending={[]} onRetry={() => {}} voice={voiceProps("deadline")} />);
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
