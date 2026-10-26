/**
 * Recording format (pure): how a voice segment is encoded, split, named and time-stamped.
 * No React, no recorder state — `useVoiceRecorder` (live capture) and `useRecoverableRecordings`
 * (crash recovery) both build their `File` through here, so the two paths can never name or type a
 * recording differently.
 */

export const TIMESLICE_MS = 5000;
/** Low bitrate on purpose: opus ~32kbps => ~58 minutes per 14MiB file. */
export const BITRATE = 32000;
/**
 * The binding limit is transcription, not upload: audio_transcribe.rs AUDIO_INLINE_MAX_BYTES = 14MiB
 * (Gemini inline_data is 20MB per request, base64 inflates by 4/3). A file over it can be stored but
 * never transcribed, so split below it. The 256KiB margin covers the slice that crosses the cap
 * (5s ~ 20KB) plus encoder bitrate overshoot.
 */
export const SPLIT_BYTES = 14 * 1024 * 1024 - 256 * 1024;

// AAC 를 맨 앞에(2026-10-07 S22 실측). 안드로이드 WebView 의 맨 "audio/mp4" 는 **Opus-in-MP4** 로 녹음되는데,
// Gemini 는 그걸 audio/mp4 로 받아 "성공"을 돌려주면서 전사는 엉터리 숫자열을 낸다(같은 Opus 를 Ogg 로 옮기면
// 정상, AAC-in-MP4(조각 MP4 포함)도 정상). 코덱을 명시해야 AAC 가 고정된다. 데스크톱 크롬 등 AAC 녹음이 안 되는
// 곳은 다음 후보로 내려간다 — ponytail: webm/opus 도 Gemini 공식 목록 밖이라 그 경로가 실사용되면 서버에서
// Ogg 로 리먹스(컨테이너만 교체)하는 게 업그레이드 경로.
const MIME_PRIORITY = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_PRIORITY.find((m) => MediaRecorder.isTypeSupported(m));
}

/** "audio/mp4;codecs=mp4a.40.2" -> "audio/mp4" (the type stored with the chunks and put on the File). */
export const baseMime = (m: string) => m.split(";")[0] || "audio/webm";
// webm 은 서버가 동영상으로 분류한다 — 오디오 전용 webm/opus 는 .weba 로 올려야 오디오가 된다(attachments/mod.rs).
const extOf = (m: string) => (m.includes("mp4") ? "m4a" : m.includes("ogg") ? "ogg" : "weba");

/** RFC3339 with the device's local offset. The server treats a 'Z' time as UTC and would shift the
 *  wall-clock date the user actually recorded on, so the phone sends its own offset instead. */
export function localIso(d: Date | number): string {
  const ms = typeof d === "number" ? d : d.getTime();
  const off = -new Date(ms).getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  // 오프셋만큼 민 UTC 필드를 읽는다 — 로컬 필드 getter 와 오프셋이 따로 놀 일이 없다.
  return `${new Date(ms + off * 60000).toISOString().slice(0, 19)}${sign}${p(off / 60)}:${p(off % 60)}`;
}

/** Assemble the recorded slices into one File, or null when nothing was captured. */
export function buildFile(chunks: Blob[], mime: string, startedAtMs: number): File | null {
  const type = baseMime(mime);
  const blob = new Blob(chunks, { type });
  if (blob.size === 0) return null;
  const stamp = new Date(startedAtMs).toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  return new File([blob], `voice-${stamp}.${extOf(type)}`, { type });
}
