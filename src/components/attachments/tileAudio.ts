import { useEffect, useState, useSyncExternalStore } from "react";
import { reportFallback } from "../../lib/diag";

/* 갤러리 타일의 "바로 듣기" — 데스크톱은 호버하는 동안, 폰은 탭으로 켜고 끈다.
 *
 * 소리 엔진은 모듈에 하나뿐인 `<audio>` 다: 타일마다 요소를 두면 호버를 빠르게 옮길 때 여럿이 겹쳐 울리고,
 * 가상 스크롤(react-window)이 행을 내리면 요소째 사라져 누가 울리는지 아무도 모른다. 하나를 두고 "지금 울리는
 * 타일 id" 만 구독하게 하면 새 타일이 켜질 때 앞의 것은 저절로 멈춘다.
 *
 * ponytail: 재생 위치·길이 표시는 없다(미리듣기라서). 끝까지 듣거나 탐색하려면 노트의 첨부 재생기로 간다. */

let audio: HTMLAudioElement | null = null;
let playingId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setPlaying(id: string | null) {
  if (playingId === id) return;
  playingId = id;
  emit();
}

function engine(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = "none";
    audio.addEventListener("ended", () => setPlaying(null));
    audio.addEventListener("error", () => {
      if (playingId) reportFallback("gallery", "audio_error", String(audio?.error?.code ?? ""));
      setPlaying(null);
    });
  }
  return audio;
}

export function playTileAudio(id: string, src: string): void {
  const a = engine();
  if (a.getAttribute("src") !== src) a.src = src;
  else a.currentTime = 0;
  setPlaying(id);
  // 재생 여부는 거부되면 되돌린다(자동 재생 정책·디코드 실패) — 조용히 삼키지 않고 기록한다.
  Promise.resolve(a.play()).catch((e) => {
    // U-10: 로드 중 pause()/src 교체로 끊긴 것은 실패가 아니다 — 기록하면 진단을 쓸어 채운다.
    if (e instanceof Error && e.name === "AbortError") {
      if (playingId === id) setPlaying(null);
      return;
    }
    if (playingId === id) setPlaying(null);
    reportFallback("gallery", "audio_play_failed", e instanceof Error ? e.name : "play rejected");
  });
}

/** `id` 를 주면 그 타일이 울리고 있을 때만 멈춘다(늦게 온 mouseleave 가 다음 타일을 끊지 않게). */
export function stopTileAudio(id?: string): void {
  if (id !== undefined && playingId !== id) return;
  audio?.pause();
  setPlaying(null);
}

export function toggleTileAudio(id: string, src: string): void {
  if (playingId === id) stopTileAudio(id);
  else playTileAudio(id, src);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 이 타일이 지금 울리고 있나. 타일이 사라지면(가상 스크롤·필터 변경) 자기 소리를 끈다. */
export function useTileAudioPlaying(id: string): boolean {
  const playing = useSyncExternalStore(subscribe, () => playingId === id);
  useEffect(() => () => stopTileAudio(id), [id]);
  return playing;
}

const durations = new Map<string, number>();

/** 길이 "m:ss"(1시간 넘으면 "h:mm:ss"). */
export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 호버한 오디오 타일의 길이 — 메타데이터만 읽는 일회용 <audio>(미리듣기 엔진과 별개). 없으면 null.
 * ponytail: 호버할 때만 읽고 id 별로 모듈에 캐시한다. DB 에 길이 컬럼을 두면 호버 없이도 보이지만 스키마 변경이 필요. */
export function useAudioDuration(id: string, src: string | null, enabled: boolean): number | null {
  const [dur, setDur] = useState<number | null>(durations.get(id) ?? null);
  useEffect(() => {
    if (!enabled || !src || durations.has(id)) return;
    const a = new Audio();
    a.preload = "metadata";
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) {
        durations.set(id, a.duration);
        setDur(a.duration);
      }
    };
    a.src = src;
    return () => {
      a.onloadedmetadata = null;
      a.removeAttribute("src");
      a.load();
    };
  }, [id, src, enabled]);
  return dur;
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function __resetTileAudioForTests(): void {
  audio = null;
  playingId = null;
  listeners.clear();
}
