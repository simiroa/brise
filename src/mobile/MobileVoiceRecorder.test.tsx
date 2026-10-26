import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n/t";
import { MobileVoiceRecorder, type VoiceStage } from "./MobileVoiceRecorder";
import { createMemoryChunkStore, type ChunkStore } from "./voiceChunkStore";
import { SPLIT_BYTES } from "./voiceFormat";

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

function setHidden(v: boolean) {
  Object.defineProperty(document, "hidden", { value: v, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
const renderSheet = (extra: Record<string, unknown> = {}) =>
  render(<MobileVoiceRecorder open onClose={onClose} onFinished={onFinished} store={store} {...extra} />);
/** The retry control of the failed phase (opening already starts recording — there is no start button). */
const retryBtn = () => screen.getByText(t("mobileVoice.retry"));
/** Opening the sheet starts recording; wait until it actually is (the pause control only exists while live). */
async function startRecording() {
  await screen.findByText(t("mobileVoice.pause"));
}
const sessions = () => store.listSessions();
/** The pre-seeded crash copy only — opening the sheet now also writes the new live recording's own session. */
const oldSessions = async () => (await sessions()).filter((x) => x.id === "old");

beforeEach(() => {
  FakeRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  store = createMemoryChunkStore();
  localStorage.setItem("brise_voice_intro_seen", "1");
  onFinished.mockReset();
  onFinished.mockResolvedValue(true); // 업로드 확인 — 보호본은 true 일 때만 지워진다
  onClose.mockReset();
});
afterEach(() => {
  cleanup();
  setHidden(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MobileVoiceRecorder", () => {
  it("opening the sheet starts recording right away (no tap-to-record step)", async () => {
    renderSheet();
    expect(screen.getByText(t("mobileVoice.starting"))).toBeTruthy(); // same frame while the mic is granted
    await startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(last().state).toBe("recording");
  });

  it("first use: the one-line intro holds the mic until continue, then recording starts", async () => {
    localStorage.removeItem("brise_voice_intro_seen");
    renderSheet();
    expect(screen.getByText(t("mobileVoice.intro_body"))).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
    fireEvent.click(screen.getByText(t("mobileVoice.intro_continue")));
    await startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("closing while the mic is still being granted starts nothing and hands the mic back", async () => {
    const stopTrack = vi.fn();
    let grant!: (s: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise((res) => { grant = res; }));
    const view = renderSheet();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(stopTrack).toHaveBeenCalled();
    expect(await sessions()).toEqual([]);
  });

  it("phases share one frame: the timer and the action row stay mounted from recording through confirm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    renderSheet();
    await startRecording();
    const frame = screen.getByTestId("voice-time").closest(".voice-rec") as HTMLElement;
    expect(frame.dataset.phase).toBe("recording");
    fireEvent.click(screen.getByText(t("mobileVoice.pause")));
    expect(frame.dataset.phase).toBe("paused");
    fireEvent.click(screen.getByText(t("mobileVoice.resume")));
    vi.setSystemTime(Date.now() + 4000);
    await waitFor(() => expect(screen.getByTestId("voice-time").textContent).toBe("00:04"));
    fireEvent.click(screen.getByText(t("mobileVoice.cancel")));
    // The confirm question is the same element, not a new layout.
    expect(screen.getByRole("alertdialog")).toBe(frame);
    expect(frame.dataset.phase).toBe("confirm");
    expect(frame.contains(screen.getByTestId("voice-time"))).toBe(true);
  });

  it("start -> pause -> resume -> finish assembles one File and calls onFinished with the contract shape", async () => {
    renderSheet();
    await startRecording();
    expect(last().state).toBe("recording");
    last().emit(new Blob(["aaaa"]));
    fireEvent.click(screen.getByText(t("mobileVoice.pause")));
    expect(last().state).toBe("paused");
    fireEvent.click(screen.getByText(t("mobileVoice.resume")));
    expect(last().state).toBe("recording");
    last().emit(new Blob(["bb"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    const r = onFinished.mock.calls[0][0];
    expect(r.file).toBeInstanceOf(File);
    expect(r.file.size).toBe(4 + 2 + 4); // aaaa + bb + the "tail" slice flushed on stop
    expect(r.file.type).toBe("audio/webm");
    expect(r.file.name).toMatch(/^voice-\d{8}-\d{6}\.weba$/);
    expect(typeof r.recordedAt).toBe("string");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(screen.getByText(t("mobileVoice.saved"))).toBeTruthy(); // the saved beat, in the same sheet
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await sessions()).toEqual([]); // crash copy dropped once handed over
  });

  it("passes the position captured at start (getPosition extension point)", async () => {
    renderSheet({ getPosition: async () => ({ lat: 37.5, lng: 127 }) });
    await startRecording();
    last().emit(new Blob(["x"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(onFinished.mock.calls[0][0]).toMatchObject({ lat: 37.5, lng: 127 });
  });

  it("permission denied shows the settings guidance; no-mic shows a different message; retry records", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    renderSheet();
    expect((await screen.findByRole("alert")).textContent).toBe(t("mobileVoice.err_denied"));
    expect(FakeRecorder.instances).toHaveLength(0);

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFoundError" }));
    fireEvent.click(retryBtn());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t("mobileVoice.err_no_mic")));

    fireEvent.click(retryBtn());
    await startRecording();
    expect(FakeRecorder.instances).toHaveLength(1);
    fireEvent.click(screen.getByText(t("mobileVoice.cancel")));
    expect(onClose).toHaveBeenCalled();
  });

  it("failed phase: close closes", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    renderSheet();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText(t("mobileVoice.close")));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancel discards the stored chunks and never calls onFinished", async () => {
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abc"]));
    await waitFor(async () => expect((await sessions())[0]?.chunkCount).toBe(1));
    fireEvent.click(screen.getByText(t("mobileVoice.cancel"))); // <3s => immediate
    await waitFor(async () => expect(await sessions()).toEqual([]));
    expect(onFinished).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("cancel after 3s asks first; keep-recording leaves the session intact", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // only the clock; promises/timers stay real
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abc"]));
    vi.setSystemTime(Date.now() + 4000);
    await waitFor(() => expect(screen.getByTestId("voice-time").textContent).toBe("00:04"));
    fireEvent.click(screen.getByText(t("mobileVoice.cancel")));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(t("mobileVoice.confirm_continue")));
    expect(screen.getByTestId("voice-time")).toBeTruthy();
    expect(last().state).toBe("recording");
    expect(await sessions()).toHaveLength(1);
  });

  it("Escape while recording asks instead of closing", async () => {
    renderSheet();
    await startRecording();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(t("mobileVoice.confirm_discard")));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("backgrounding saves what was recorded and offers to continue in a NEW recording", async () => {
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abcd"]));
    act(() => setHidden(true));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished.mock.calls[0][0].file.size).toBe(4 + 4);
    expect(screen.getByText(t("mobileVoice.interrupted"))).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    act(() => setHidden(false));
    fireEvent.click(screen.getByText(t("mobileVoice.continue_recording")));
    await startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(FakeRecorder.instances).toHaveLength(2);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("splits automatically at the size cap and keeps recording", async () => {
    renderSheet();
    await startRecording();
    const first = last();
    await act(async () => { first.emit(new Blob([new Uint8Array(SPLIT_BYTES)])); });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished.mock.calls[0][0].file.size).toBeGreaterThanOrEqual(SPLIT_BYTES);
    await waitFor(() => expect(FakeRecorder.instances).toHaveLength(2));
    expect(last().state).toBe("recording");
    expect(screen.getByTestId("voice-time")).toBeTruthy();
  });

  it("offers recovery of an unsaved recording (3 chunks) and uploads it", async () => {
    await store.putSession({ id: "old", mimeType: "audio/webm", startedAt: "2026-10-06T01:02:03.000Z" });
    await store.putChunk("old", 0, new Blob(["aa"]));
    await store.putChunk("old", 1, new Blob(["bb"]));
    await store.putChunk("old", 2, new Blob(["cc"]));
    await store.putSession({ id: "empty", mimeType: "audio/webm", startedAt: "2026-10-06T01:00:00.000Z" });
    renderSheet();
    const rows = await screen.findAllByTestId("voice-recover-row");
    expect(rows).toHaveLength(1); // the zero-chunk session is not offered
    expect(await screen.findByText(t("mobileVoice.ready"))).toBeTruthy();
    expect(FakeRecorder.instances).toHaveLength(0); // X-10: nothing auto-started while something is recoverable
    fireEvent.click(screen.getByText(t("mobileVoice.new_recording")));
    await startRecording(); // recovery stays listed alongside the live recording, in the same sheet
    fireEvent.click(screen.getByText(t("mobileVoice.recover_upload")));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    const r = onFinished.mock.calls[0][0];
    expect(r.file.size).toBe(6);
    expect(Date.parse(r.recordedAt)).toBe(Date.parse("2026-10-06T01:02:03.000Z"));
    await waitFor(async () => expect(await oldSessions()).toEqual([]));
  });

  it("discarding a recoverable recording deletes it without calling onFinished", async () => {
    await store.putSession({ id: "old", mimeType: "audio/webm", startedAt: "2026-10-06T01:02:03.000Z" });
    await store.putChunk("old", 0, new Blob(["aa"]));
    renderSheet();
    await screen.findByTestId("voice-recover-row");
    fireEvent.click(screen.getByText(t("mobileVoice.recover_discard")));
    await waitFor(async () => expect(await oldSessions()).toEqual([]));
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("the live recording is never listed (or swept) as recoverable — only the earlier session is offered", async () => {
    await store.putSession({ id: "old", mimeType: "audio/webm", startedAt: "2026-10-06T01:02:03.000Z" });
    await store.putChunk("old", 0, new Blob(["aa"]));
    renderSheet();
    fireEvent.click(await screen.findByText(t("mobileVoice.new_recording")));
    await startRecording();
    last().emit(new Blob(["live"]));
    await waitFor(async () => expect((await sessions()).length).toBe(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getAllByTestId("voice-recover-row")).toHaveLength(1);
    expect((await sessions()).find((x) => x.id !== "old")?.chunkCount).toBe(1); // live crash copy intact
  });

  it("keeps the crash copy when onFinished reports false, a void, or rejects; drops it only on true", async () => {
    for (const [ret, kept] of [[false, 1], [undefined, 1], ["reject", 1], [true, 0]] as const) {
      store = createMemoryChunkStore();
      onFinished.mockReset();
      if (ret === "reject") onFinished.mockRejectedValue(new Error("upload failed"));
      else onFinished.mockReturnValue(ret === true ? Promise.resolve(true) : ret);
      const view = renderSheet();
      await startRecording();
      last().emit(new Blob(["abc"]));
      fireEvent.click(screen.getByText(t("mobileVoice.finish")));
      await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10)); // let the background confirmation settle
      expect((await sessions()).length, String(ret)).toBe(kept);
      onClose.mockReset();
      view.unmount();
    }
  });

  it("a failed upload's session is offered again on the next sheet open", async () => {
    onFinished.mockResolvedValue(false);
    const v = renderSheet();
    await startRecording();
    last().emit(new Blob(["abc"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    v.unmount();
    renderSheet();
    expect(await screen.findAllByTestId("voice-recover-row")).toHaveLength(1);
  });

  it("recovery keeps the stored session when the upload is not confirmed", async () => {
    await store.putSession({ id: "old", mimeType: "audio/webm", startedAt: "2026-10-06T01:02:03.000Z" });
    await store.putChunk("old", 0, new Blob(["aa"]));
    onFinished.mockResolvedValue(false);
    renderSheet();
    await screen.findByTestId("voice-recover-row");
    fireEvent.click(screen.getByText(t("mobileVoice.recover_upload")));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(await oldSessions()).toHaveLength(1);
  });

  it("a recorder error with chunks in hand saves them (interrupt path) instead of dropping them", async () => {
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abcd"]));
    act(() => { last().onerror?.(); });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished.mock.calls[0][0].file.size).toBe(4 + 4);
    expect(screen.getByText(t("mobileVoice.interrupted"))).toBeTruthy();
  });

  it("a recorder error before any chunk is still a failure", async () => {
    renderSheet();
    await startRecording();
    act(() => { last().onerror?.(); });
    expect((await screen.findByRole("alert")).textContent).toBe(t("mobileVoice.err_unknown"));
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("Escape after an interruption just closes (the confirm dialog's finish would be a no-op there)", async () => {
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abcd"]));
    act(() => setHidden(true));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape while paused (by hand) saves what was recorded, then closes, without a dialog (M-12)", async () => {
    renderSheet();
    await startRecording();
    last().emit(new Blob(["abcd"]));
    fireEvent.click(screen.getByText(t("mobileVoice.pause")));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0].file.size).toBeGreaterThan(0);
  });

  it("names an mp4 recording .m4a", async () => {
    vi.stubGlobal("MediaRecorder", class extends FakeRecorder {
      static isTypeSupported: (m: string) => boolean = (m) => m === "audio/mp4";
    });
    renderSheet();
    await startRecording();
    last().emit(new Blob(["x"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(onFinished.mock.calls[0][0].file.name).toMatch(/\.m4a$/);
  });
});

describe("localIso through the recovery path", () => {
  afterEach(() => vi.restoreAllMocks());
  it("recovered sessions stored as UTC are sent with the local offset", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-540);
    const st = createMemoryChunkStore();
    await st.putSession({ id: "o", mimeType: "audio/webm", startedAt: "2026-10-03T23:30:00.000Z" });
    await st.putChunk("o", 0, new Blob(["a"]));
    onFinished.mockResolvedValue(true);
    render(<MobileVoiceRecorder open onClose={onClose} onFinished={onFinished} store={st} />);
    fireEvent.click(await screen.findByText(t("mobileVoice.recover_upload")));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(onFinished.mock.calls[0][0].recordedAt).toBe("2026-10-04T08:30:00+09:00");
  });
});

// 위치 권한 대화상자는 녹음 중인 화면 위에 뜨면 안 된다(2026-10-07 실기 QA) — 제공자가 시작 때 "later" 로 미루면
// 녹음기는 정지 뒤(저장 직전)에 다시 묻는다. 미루지 않은 답(좌표·null)은 다시 묻지 않는다.
describe("MobileVoiceRecorder — position timing", () => {
  const POS = { lat: 37.5, lng: 127 };

  it("a deferred ('later') start is asked again only after the recorder has stopped, and that fix is attached", async () => {
    let stateWhenStopAsked = "";
    const getPosition = vi.fn(async (phase: "start" | "stop") => {
      if (phase === "stop") stateWhenStopAsked = last().state;
      return phase === "start" ? ("later" as const) : POS;
    });
    renderSheet({ getPosition });
    await startRecording();
    expect(getPosition.mock.calls).toEqual([["start"]]); // while live: only the (deferred) start ask
    last().emit(new Blob(["x"]));
    expect(getPosition).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(getPosition.mock.calls).toEqual([["start"], ["stop"]]);
    expect(stateWhenStopAsked).toBe("inactive"); // the recorder had already stopped
    expect(onFinished.mock.calls[0][0]).toMatchObject({ lat: 37.5, lng: 127 });
  });

  it("a start that answered with a fix, or with null, is not asked again at the stop", async () => {
    for (const startAnswer of [POS, null]) {
      FakeRecorder.instances = [];
      onFinished.mockClear();
      const getPosition = vi.fn(async () => startAnswer);
      const { unmount } = renderSheet({ getPosition });
      await startRecording();
      last().emit(new Blob(["x"]));
      fireEvent.click(screen.getByText(t("mobileVoice.finish")));
      await waitFor(() => expect(onFinished).toHaveBeenCalled());
      expect(getPosition).toHaveBeenCalledTimes(1);
      expect(onFinished.mock.calls[0][0].lat).toBe(startAnswer?.lat);
      unmount();
    }
  });

  it("a deferred start whose stop-time ask fails still saves the recording, without coordinates", async () => {
    const getPosition = vi.fn(async (phase: "start" | "stop") => {
      if (phase === "start") return "later" as const;
      throw new Error("boom");
    });
    renderSheet({ getPosition });
    await startRecording();
    last().emit(new Blob(["x"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(onFinished.mock.calls[0][0].lat).toBeUndefined();
    expect(onFinished.mock.calls[0][0].file.size).toBeGreaterThan(0);
  });

  it("a size-cap rollover and a backgrounding save do not ask at the stop (recording goes on / no screen for a dialog)", async () => {
    const getPosition = vi.fn(async (phase: "start" | "stop") => (phase === "start" ? ("later" as const) : POS));
    renderSheet({ getPosition });
    await startRecording();
    await act(async () => { last().emit(new Blob([new Uint8Array(SPLIT_BYTES)])); });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(FakeRecorder.instances).toHaveLength(2));
    expect(onFinished.mock.calls[0][0].lat).toBeUndefined();
    expect(getPosition.mock.calls.map((c) => c[0])).toEqual(["start", "start"]); // each segment deferred, none asked at the rollover

    act(() => setHidden(true));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));
    expect(onFinished.mock.calls[1][0].lat).toBeUndefined();
    expect(getPosition.mock.calls.map((c) => c[0])).not.toContain("stop");
  });

  it("a stop-time ask that never answers (a dialog nobody touches) does not hold the recording hostage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const getPosition = vi.fn((phase: "start" | "stop") =>
      phase === "start" ? Promise.resolve("later" as const) : new Promise<never>(() => {}));
    renderSheet({ getPosition });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId("voice-time")).toBeTruthy();
    last().emit(new Blob(["x"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); }); // the start-phase wait elapsed
    expect(onFinished).not.toHaveBeenCalled(); // still waiting on the stop-time ask
    await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0].lat).toBeUndefined();
  });
});

describe("MobileVoiceRecorder — result stage after 완료 (same frame)", () => {
  /** Record, press 완료, and return the File the sheet handed off. `stage` is read on every render, like MobileNote's. */
  let stage: VoiceStage | null = null;
  const stageOf = vi.fn((_f: File) => stage);
  const sheet = () =>
    <MobileVoiceRecorder open onClose={onClose} onFinished={onFinished} store={store} stageOf={stageOf} />;
  async function recordAndFinish() {
    const view = render(sheet());
    await startRecording();
    last().emit(new Blob(["abc"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    return { ...view, file: onFinished.mock.calls[0][0].file as File, frame: () => screen.getByTestId("voice-time").closest(".voice-rec") as HTMLElement };
  }
  beforeEach(() => {
    stage = null;
    stageOf.mockClear();
  });

  it("follows exactly the file 완료 handed off, and stays open (no saved-beat close) while there is a stage", async () => {
    stage = { kind: "saving" };
    const { file, frame } = await recordAndFinish();
    await waitFor(() => expect(frame().dataset.phase).toBe("uploading"));
    expect(stageOf).toHaveBeenCalledWith(file);
    expect(screen.getByText(t("mobileVoice.uploading"))).toBeTruthy(); // M-4: an upload-specific line, not "저장하는 중"
    expect(screen.getByText(t("mobileVoice.uploading_hint"))).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); }); // longer than the saved beat
    expect(onClose).not.toHaveBeenCalled();
    // The recorder is done: only [닫기] is left (the upload goes on in the note screen).
    expect(screen.queryByText(t("mobileVoice.pause"))).toBeNull();
    fireEvent.click(screen.getByText(t("mobileVoice.close")));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saving -> transcribing -> done morphs in place: preview + where it went, one polite announcement, [닫기]", async () => {
    stage = { kind: "saving" };
    const { rerender, frame } = await recordAndFinish();
    const el = frame();
    const live = el.querySelector("[aria-live]") as HTMLElement;
    expect(live.textContent).toBe("");

    stage = { kind: "transcribing" };
    rerender(sheet());
    expect(frame()).toBe(el);
    expect(el.dataset.phase).toBe("transcribing");
    expect(screen.getByText(t("mobileVoice.transcribing_hint"))).toBeTruthy();
    expect(live.textContent).toBe(""); // nothing announced in between

    stage = { kind: "done", text: "회의는 금요일 세 시", placed: "body" };
    rerender(sheet());
    expect(el.dataset.phase).toBe("done");
    expect(screen.getByTestId("voice-preview").textContent).toBe("회의는 금요일 세 시");
    expect(el.contains(screen.getByTestId("voice-time"))).toBe(true); // the block is covered, not removed (height kept)
    expect(live.textContent).toBe(t("mobileVoice.placed_body"));
    expect(document.querySelectorAll("[aria-live]").length).toBe(1);
    fireEvent.click(screen.getByText(t("mobileVoice.close")));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names a new section / an un-inserted transcript honestly", async () => {
    stage = { kind: "done", text: "x", placed: "section" };
    const { rerender } = await recordAndFinish();
    await screen.findByTestId("voice-preview");
    expect(screen.getAllByText(t("mobileVoice.placed_section")).length).toBeGreaterThan(0);
    stage = { kind: "done", text: "x", placed: "kept" };
    rerender(sheet());
    expect(screen.getAllByText(t("mobileVoice.placed_kept")).length).toBeGreaterThan(0);
  });

  it("ask mode: [받아 적기] in the sheet starts it; closing mid-transcription just closes (work lives in the note)", async () => {
    const transcribe = vi.fn();
    stage = { kind: "offer", transcribe };
    const { rerender, frame } = await recordAndFinish();
    await waitFor(() => expect(frame().dataset.phase).toBe("offer"));
    fireEvent.click(screen.getByText(t("mobileVoice.transcribe")));
    expect(transcribe).toHaveBeenCalledTimes(1);
    stage = { kind: "transcribing" };
    rerender(sheet());
    fireEvent.click(screen.getByText(t("mobileVoice.close")));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an upload failure shows in the sheet with [다시 시도]", async () => {
    const retry = vi.fn();
    stage = { kind: "upload_failed", retry };
    const { frame } = await recordAndFinish();
    await waitFor(() => expect(frame().dataset.phase).toBe("result_failed"));
    expect(screen.getByRole("alert").textContent).toBe(t("mobileVoice.upload_failed"));
    fireEvent.click(screen.getByText(t("mobileVoice.retry")));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a transcription failure offers retry, except when AI is off (nothing to retry)", async () => {
    const retry = vi.fn();
    stage = { kind: "transcribe_failed", code: "failed", retry };
    const { rerender } = await recordAndFinish();
    fireEvent.click(await screen.findByText(t("mobileVoice.retry")));
    expect(retry).toHaveBeenCalledTimes(1);
    stage = { kind: "transcribe_failed", code: "ai_required" };
    rerender(sheet());
    expect(screen.getByRole("alert").textContent).toBe(t("mobileInput.voice_err_ai"));
    expect(screen.queryByText(t("mobileVoice.retry"))).toBeNull();
  });

  it("no stage for the file (transcription off) keeps the saved beat that closes the sheet", async () => {
    stage = null;
    await recordAndFinish();
    expect(screen.getByText(t("mobileVoice.saved"))).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a size-cap rollover file is not the one followed — only the file 완료 handed off", async () => {
    stage = { kind: "saving" };
    render(sheet());
    await startRecording();
    const first = last();
    await act(async () => { first.emit(new Blob([new Uint8Array(SPLIT_BYTES)])); });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(FakeRecorder.instances.length).toBe(2));
    last().emit(new Blob(["x"]));
    fireEvent.click(screen.getByText(t("mobileVoice.finish")));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(stageOf).toHaveBeenCalled());
    for (const [f] of stageOf.mock.calls) expect(f).toBe(onFinished.mock.calls[1][0].file);
  });
});
