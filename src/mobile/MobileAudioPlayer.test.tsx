import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const reportFallback = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallback(...a) }));

import { t } from "../i18n/t";
import { formatClock, MobileAudioPlayer } from "./MobileAudioPlayer";

// jsdom has no media pipeline: play()/pause() are "not implemented". Stub them on the prototype and keep a
// `paused` flag the way a real element does, firing the same events the player listens to.
let playImpl: () => Promise<void>;
beforeEach(() => {
  reportFallback.mockReset();
  playImpl = async () => {};
  let paused = true;
  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: () => paused });
  HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
    return playImpl().then(() => {
      paused = false;
      this.dispatchEvent(new Event("play"));
    });
  });
  HTMLMediaElement.prototype.pause = vi.fn(function (this: HTMLMediaElement) {
    paused = true;
    this.dispatchEvent(new Event("pause"));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const audioEl = () => document.querySelector("audio")!;
const time = () => screen.getByTestId("audio-time").textContent;
function setAudioProp(name: "duration" | "currentTime", v: number) {
  Object.defineProperty(audioEl(), name, { configurable: true, writable: true, value: v });
}

describe("formatClock", () => {
  it("floors the elapsed time and rounds the total", () => {
    expect(formatClock(12_400)).toBe("0:12");
    expect(formatClock(12_600)).toBe("0:12");
    expect(formatClock(12_600, true)).toBe("0:13");
    expect(formatClock(54_000, true)).toBe("0:54");
    expect(formatClock(125_000, true)).toBe("2:05");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("MobileAudioPlayer", () => {
  it("shows the recorder's duration, not the file's: native Infinity / NaN / a wrong 5s change nothing", () => {
    render(<MobileAudioPlayer src="http://x/a.m4a" durationMs={54_000} />);
    expect(time()).toBe("0:00 / 0:54");

    for (const wrong of [Infinity, NaN, 5]) {
      setAudioProp("duration", wrong);
      fireEvent(audioEl(), new Event("durationchange"));
      fireEvent(audioEl(), new Event("loadedmetadata"));
      expect(time()).toBe("0:00 / 0:54");
    }
    expect((screen.getByLabelText(t("mobileVoice.player_seek")) as HTMLInputElement).max).toBe("54000");
  });

  it("is a custom player: the audio element has no native controls", () => {
    render(<MobileAudioPlayer src="http://x/a.m4a" durationMs={12_000} />);
    expect(audioEl().hasAttribute("controls")).toBe(false);
  });

  it("follows currentTime, clamps elapsed to the total, and resets on ended", () => {
    render(<MobileAudioPlayer src="http://x/a.m4a" durationMs={12_000} />);
    setAudioProp("currentTime", 3.4);
    fireEvent.timeUpdate(audioEl());
    expect(time()).toBe("0:03 / 0:12");

    setAudioProp("currentTime", 20); // the file runs past the (estimated) total
    fireEvent.timeUpdate(audioEl());
    expect(time()).toBe("0:12 / 0:12");

    fireEvent.ended(audioEl());
    expect(time()).toBe("0:00 / 0:12");
  });

  it("plays and pauses from the button; the label follows the real play/pause events", async () => {
    render(<MobileAudioPlayer src="http://x/a.m4a" durationMs={12_000} />);
    fireEvent.click(screen.getByLabelText(t("mobileVoice.player_play")));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    const pauseBtn = await screen.findByLabelText(t("mobileVoice.player_pause"));
    fireEvent.click(pauseBtn);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(t("mobileVoice.player_play"))).toBeTruthy();
  });

  it("a rejected play() stays paused and is recorded, not swallowed", async () => {
    playImpl = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    render(<MobileAudioPlayer src="http://x/a.m4a" durationMs={12_000} />);
    fireEvent.click(screen.getByLabelText(t("mobileVoice.player_play")));
    await vi.waitFor(() => expect(reportFallback).toHaveBeenCalledWith("voice", "play_failed", "NotAllowedError"));
    expect(screen.getByLabelText(t("mobileVoice.player_play"))).toBeTruthy();
  });

  it("the slider seeks the audio against the known total", () => {
    render(<MobileAudioPlayer src="http://x/a.m4a" durationMs={54_000} />);
    setAudioProp("currentTime", 0); // a plain writable property (jsdom has no media pipeline behind the real one)
    fireEvent.change(screen.getByLabelText(t("mobileVoice.player_seek")), { target: { value: "30000" } });
    expect(audioEl().currentTime).toBe(30);
    expect(time()).toBe("0:30 / 0:54");
  });

  it("a finger on the slider does not reach the row's long-press (delete) handler", () => {
    const rowDown = vi.fn();
    render(
      <div onPointerDown={rowDown}>
        <MobileAudioPlayer src="http://x/a.m4a" durationMs={12_000} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByLabelText(t("mobileVoice.player_seek")));
    expect(rowDown).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId("audio-time")); // the readout still belongs to the row
    expect(rowDown).toHaveBeenCalledTimes(1);
  });
});
