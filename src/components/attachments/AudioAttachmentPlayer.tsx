import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { formatFileSize } from "../../lib/ui";
import { IconMic } from "../icons";

export interface AudioAttachmentPlayerProps {
  attachment: Attachment;
  src: string;
  onOpenExternal?: () => void;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function AudioAttachmentPlayer({
  attachment,
  src,
  onOpenExternal,
}: AudioAttachmentPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration || 0);
    const onEnded = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  // Metadata may not have loaded yet (duration stays 0, or NaN/Infinity while streaming) —
  // seeking against a fake fallback duration would jump to the wrong position or set
  // `currentTime` to NaN, so the slider stays disabled/no-op until a real duration is known.
  const hasDuration = duration > 0 && Number.isFinite(duration);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio || !hasDuration) return;
    const time = Number(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const cyclePlaybackRate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const rates = [1, 1.25, 1.5, 2];
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
    const nextRate = rates[nextIdx];
    audio.playbackRate = nextRate;
    setPlaybackRate(nextRate);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  return (
    <div
      data-testid="audio-attachment-player"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        backgroundColor: "var(--surface)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--divider)",
        maxWidth: 420,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <audio ref={audioRef} src={src} preload="metadata" />

      {/* Header with audio icon and file info */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "var(--radius-sm)",
            backgroundColor: "var(--surface-raised)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <IconMic size={20} strokeWidth={1.6} style={{ color: "var(--accent)" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              color: "var(--text)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={attachment.name}
          >
            {attachment.name}
          </span>
          {attachment.size_bytes != null && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              {formatFileSize(attachment.size_bytes)}
            </span>
          )}
        </div>
        {onOpenExternal && (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={onOpenExternal}
            title={t("attachments.open_hint")}
            aria-label={t("attachments.open_hint")}
          >
            <span style={{ fontSize: "var(--text-xs)" }}>↗</span>
          </button>
        )}
      </div>

      {/* Progress track */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <input
          type="range"
          min={0}
          max={hasDuration ? duration : 0}
          step={0.1}
          value={hasDuration ? currentTime : 0}
          onChange={handleSeek}
          disabled={!hasDuration}
          aria-label="Audio playback progress"
          data-testid="audio-seek-slider"
          style={{
            width: "100%",
            accentColor: "var(--accent)",
            cursor: hasDuration ? "pointer" : "default",
            margin: 0,
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "var(--text-2xs)",
            color: "var(--muted)",
          }}
        >
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls: Play/Pause, Speed, Mute */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: "var(--space-1)",
        }}
      >
        <button
          type="button"
          data-testid="audio-play-button"
          onClick={togglePlay}
          style={{
            padding: "6px 14px",
            backgroundColor: "var(--accent)",
            color: "var(--on-solid)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            fontSize: "var(--text-xs)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            data-testid="audio-rate-button"
            onClick={cyclePlaybackRate}
            title="Playback rate"
            style={{ fontSize: "var(--text-2xs)", fontWeight: 600, minWidth: 32 }}
          >
            {playbackRate}x
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            data-testid="audio-mute-button"
            onClick={toggleMute}
            title={isMuted ? "Unmute" : "Mute"}
            style={{ fontSize: "var(--text-xs)" }}
          >
            {isMuted ? "🔇" : "🔊"}
          </button>
        </div>
      </div>
    </div>
  );
}
