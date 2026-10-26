import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n/t";
import { readRecLevel, useMobileAmbientStore } from "../stores/mobileAmbient";
import { MobileVoiceRecorder } from "./MobileVoiceRecorder";
import { createMemoryChunkStore, type ChunkStore } from "./voiceChunkStore";

/**
 * 녹음 배경 신호(MobileAmbient)의 켜짐/꺼짐은 useVoiceRecorder 한 곳이 쥔다 — 켜 둔 채 남는 경로가 없어야
 * 한다. 시작=on, 일시정지=paused, 그 밖의 모든 끝(완료·취소·실패·인터럽트·시트 닫힘·언마운트)=off.
 * 하네스(FakeRecorder)는 MobileVoiceRecorder.test.tsx 와 같은 모양이다.
 */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported: (m: string) => boolean = (m) => m === "audio/webm;codecs=opus";
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["tail"]) });
      this.onstop?.();
    });
  }
  emit(data: Blob) { this.ondataavailable?.({ data }); }
}
const last = () => FakeRecorder.instances[FakeRecorder.instances.length - 1];

let getUserMedia: ReturnType<typeof vi.fn>;
let store: ChunkStore;
const onFinished = vi.fn();
const onClose = vi.fn();
const rec = () => useMobileAmbientStore.getState().rec;

function setHidden(v: boolean) {
  Object.defineProperty(document, "hidden", { value: v, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
const renderSheet = (open = true) =>
  render(<MobileVoiceRecorder open={open} onClose={onClose} onFinished={onFinished} store={store} />);
/** Opening the sheet starts recording (PLAN-2026-10-10 W-B); wait until it is live — the pause control only exists then. */
async function startRecording() {
  await screen.findByText(t("mobileVoice.pause"));
}

beforeEach(() => {
  FakeRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  store = createMemoryChunkStore();
  localStorage.setItem("brise_voice_intro_seen", "1");
  onFinished.mockReset();
  onFinished.mockResolvedValue(true);
  onClose.mockReset();
  useMobileAmbientStore.setState({ rec: "off" });
});
afterEach(async () => {
  cleanup();
  // useBackClosable pops its history entry asynchronously; let that popstate land before the next test mounts a back guard.
  await new Promise((r) => setTimeout(r, 50));
  setHidden(false);
  vi.unstubAllGlobals();
});

describe("useVoiceRecorder → mobile ambient store", () => {
  it("is off until the microphone is actually granted (the sheet auto-starts, but the signal waits for audio)", () => {
    renderSheet();
    expect(rec()).toBe("off");
  });

  it("start → on, pause → paused, resume → on, finish → off", async () => {
    renderSheet();
    await startRecording();
    expect(rec()).toBe("on");
    last().emit(new Blob(["aaaa"]));
    fireEvent.click(screen.getByText(t("mobileVoice.pause")));
    expect(rec()).toBe("paused");
    fireEvent.click(screen.getByText(t("mobileVoice.resume")));
    expect(rec()).toBe("on");
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rec()).toBe("off"));
  });

  it("cancel → off", async () => {
    renderSheet();
    await startRecording();
    expect(rec()).toBe("on");
    fireEvent.click(screen.getByText(t("mobileVoice.cancel"))); // < 3s ⇒ discards immediately
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(rec()).toBe("off");
  });

  it("a denied microphone never turns it on, and a recorder failure turns it off", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    renderSheet();
    await screen.findByRole("alert");
    expect(rec()).toBe("off");

    cleanup();
    FakeRecorder.instances = [];
    renderSheet();
    await startRecording();
    expect(rec()).toBe("on");
    act(() => { last().onerror?.(); }); // no chunk yet ⇒ plain failure
    await screen.findByRole("alert");
    expect(rec()).toBe("off");
  });

  it("an interruption (app backgrounded) is not a live recording → off, even though the machine is 'paused'", async () => {
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abcd"]));
    act(() => setHidden(true));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(screen.getByText(t("mobileVoice.interrupted"))).toBeTruthy();
    expect(rec()).toBe("off");
  });

  it("closing the sheet while recording (open → false) turns it off", async () => {
    const view = renderSheet();
    await startRecording();
    expect(rec()).toBe("on");
    view.rerender(<MobileVoiceRecorder open={false} onClose={onClose} onFinished={onFinished} store={store} />);
    expect(rec()).toBe("off");
  });

  it("unmounting while recording or paused turns it off", async () => {
    const live = renderSheet();
    await startRecording();
    expect(rec()).toBe("on");
    live.unmount();
    expect(rec()).toBe("off");
    // The unmounted sheet's history pop (useBackClosable) lands a moment later; it must not hit the next sheet's back guard.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    store = createMemoryChunkStore(); // the unmounted recording stays in the old store as a crash copy; a sheet that finds one holds off auto-start (X-10)

    FakeRecorder.instances = [];
    const paused = renderSheet();
    await startRecording();
    fireEvent.click(screen.getByText(t("mobileVoice.pause")));
    expect(rec()).toBe("paused");
    paused.unmount();
    expect(rec()).toBe("off");
  });
  it("publishes the microphone level to the ambient channel while recording; pause / finish / cancel clear it", async () => {
    // A webview with AudioContext: the level meter samples every 100ms and the hook forwards each sample.
    vi.stubGlobal("AudioContext", class {
      createAnalyser() { return { fftSize: 0, getByteTimeDomainData: (b: Uint8Array) => b.fill(255) }; }
      createMediaStreamSource() { return { connect: vi.fn() }; }
      close = vi.fn(() => Promise.resolve());
    });
    renderSheet();
    await startRecording();
    expect(readRecLevel().seq).toBe(0); // nothing yet — and never a stale peak from a previous run
    await waitFor(() => expect(readRecLevel().seq).toBeGreaterThan(0), { timeout: 2000 });
    expect(readRecLevel().level).toBe(1); // the same clamped RMS the sheet's own bar shows

    last().emit(new Blob(["aaaa"]));
    fireEvent.click(screen.getByText(t("mobileVoice.pause")));
    expect(rec()).toBe("paused");
    expect(readRecLevel().seq).toBe(0); // the transition cleared it; the meter does not sample while paused
    await new Promise((r) => setTimeout(r, 250));
    expect(readRecLevel().seq).toBe(0);

    fireEvent.click(screen.getByText(t("mobileVoice.resume")));
    await waitFor(() => expect(readRecLevel().seq).toBeGreaterThan(0), { timeout: 2000 });

    fireEvent.click(screen.getByText(t("mobileVoice.cancel")));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(rec()).toBe("off");
    expect(readRecLevel().seq).toBe(0);
  });

});
