import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AudioAttachmentPlayer } from "./AudioAttachmentPlayer";
import type { Attachment } from "../../lib/commands.gen";

describe("AudioAttachmentPlayer", () => {
  const sampleAudio: Attachment = {
    id: "att-audio-1",
    name: "interview_recording.mp3",
    kind: "audio",
    rel_path: "notes/audio/interview_recording.mp3",
    url: null,
    size_bytes: 1048576, // 1 MB
    position: 0,
  };

  beforeEach(() => {
    // Mock HTMLMediaElement methods
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();
  });

  it("renders audio filename, size and controls", () => {
    render(<AudioAttachmentPlayer attachment={sampleAudio} src="http://localhost/audio.mp3" />);

    expect(screen.getByText("interview_recording.mp3")).toBeTruthy();
    expect(screen.getByTestId("audio-play-button")).toBeTruthy();
    expect(screen.getByTestId("audio-seek-slider")).toBeTruthy();
    expect(screen.getByTestId("audio-rate-button")).toBeTruthy();
    expect(screen.getByTestId("audio-mute-button")).toBeTruthy();
  });

  it("toggles play/pause when play button is clicked", async () => {
    const user = userEvent.setup();
    render(<AudioAttachmentPlayer attachment={sampleAudio} src="http://localhost/audio.mp3" />);

    const playBtn = screen.getByTestId("audio-play-button");
    expect(playBtn.textContent).toMatch(/play/i);

    await user.click(playBtn);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();

    // Trigger onPlay event manually
    fireEvent.play(document.querySelector("audio")!);
    expect(playBtn.textContent).toMatch(/pause/i);

    await user.click(playBtn);
    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it("cycles playback rate on click", async () => {
    const user = userEvent.setup();
    render(<AudioAttachmentPlayer attachment={sampleAudio} src="http://localhost/audio.mp3" />);

    const rateBtn = screen.getByTestId("audio-rate-button");
    expect(rateBtn.textContent).toBe("1x");

    await user.click(rateBtn);
    expect(rateBtn.textContent).toBe("1.25x");

    await user.click(rateBtn);
    expect(rateBtn.textContent).toBe("1.5x");

    await user.click(rateBtn);
    expect(rateBtn.textContent).toBe("2x");

    await user.click(rateBtn);
    expect(rateBtn.textContent).toBe("1x");
  });

  it("toggles mute on button click", async () => {
    const user = userEvent.setup();
    render(<AudioAttachmentPlayer attachment={sampleAudio} src="http://localhost/audio.mp3" />);

    const muteBtn = screen.getByTestId("audio-mute-button");
    expect(muteBtn.textContent).toBe("🔊");

    await user.click(muteBtn);
    expect(muteBtn.textContent).toBe("🔇");

    await user.click(muteBtn);
    expect(muteBtn.textContent).toBe("🔊");
  });

  it("disables the seek slider until a real finite duration loads, then enables it", () => {
    render(<AudioAttachmentPlayer attachment={sampleAudio} src="http://localhost/audio.mp3" />);

    const slider = screen.getByTestId("audio-seek-slider") as HTMLInputElement;
    const audio = document.querySelector("audio")!;

    // Before loadedmetadata: disabled, no fake 100s fallback, seeking is a no-op.
    expect(slider.disabled).toBe(true);
    expect(slider.max).toBe("0");
    fireEvent.change(slider, { target: { value: "42" } });
    expect(audio.currentTime).toBe(0);

    // Simulate real metadata arriving.
    Object.defineProperty(audio, "duration", { value: 180, configurable: true });
    fireEvent.loadedMetadata(audio);

    expect(slider.disabled).toBe(false);
    expect(slider.max).toBe("180");
  });

  it("calls onOpenExternal when external launch button is clicked", async () => {
    const onOpenExternal = vi.fn();
    const user = userEvent.setup();
    render(
      <AudioAttachmentPlayer
        attachment={sampleAudio}
        src="http://localhost/audio.mp3"
        onOpenExternal={onOpenExternal}
      />
    );

    const extBtn = screen.getByRole("button", { name: /open/i });
    await user.click(extBtn);
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
  });
});
