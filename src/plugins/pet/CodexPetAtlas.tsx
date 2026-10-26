import { useEffect, useRef, useState } from "react";

export type CodexPetState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export interface CodexPetFrame {
  row: number;
  column: number;
  durationMs: number;
}

/** 패키지 매니페스트의 clips 행 — 이름(idle/waving/look-a …)·아틀라스 행·프레임 수. */
export interface CodexPetClip {
  name: string;
  row: number;
  frames: number;
}

const IDLE_DURATIONS = [280, 110, 110, 140, 140, 320] as const;
// reaction: 반응 3회 + 느린 idle 이어붙임 (일회성 반응). loop: 순수 루프, 지속 상태용 (idle 미첨부).
type PlaybackMode = "reaction" | "loop";
const STATE_ROWS: Record<CodexPetState, { row: number; durations: readonly number[]; mode: PlaybackMode }> = {
  idle: { row: 0, durations: IDLE_DURATIONS, mode: "loop" }, // mode는 무시됨 (framesForState에서 idle 별도 처리)
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220], mode: "loop" },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220], mode: "loop" },
  waving: { row: 3, durations: [140, 140, 140, 280], mode: "reaction" },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280], mode: "reaction" },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240], mode: "reaction" },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260], mode: "loop" },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220], mode: "loop" },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280], mode: "loop" },
};

export const CODEX_PET_ATLAS = {
  width: 1536,
  height: 2288,
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  rows: 11,
} as const;

function clipNamed(clips: readonly CodexPetClip[] | undefined, name: string): CodexPetClip | undefined {
  return clips?.find((clip) => clip.name === name);
}

/** clip.frames 에 맞춰 기존 상태 타이밍을 자르거나 마지막 값으로 채운다. 8열을 넘기지 않는다. */
function durationsForClip(durations: readonly number[], frameCount: number): number[] {
  const count = Math.max(1, Math.min(frameCount, CODEX_PET_ATLAS.columns));
  if (count <= durations.length) return durations.slice(0, count);
  const out = durations.slice();
  const pad = durations[durations.length - 1] ?? 140;
  while (out.length < count) out.push(pad);
  return out;
}

function framesOnRow(row: number, durations: readonly number[]): CodexPetFrame[] {
  return durations.map((durationMs, column) => ({ row, column, durationMs }));
}

export function framesForState(state: CodexPetState, reducedMotion = false): CodexPetFrame[] {
  const spec = STATE_ROWS[state];
  const frames = framesOnRow(spec.row, spec.durations);
  if (reducedMotion) return frames.slice(0, 1);
  if (state === "idle" || spec.mode === "loop") return frames;
  // Codex는 반응 애니메이션을 세 번 재생한 뒤 느린 idle 루프로 자연스럽게 이어 붙인다.
  const reaction = [...frames, ...frames, ...frames];
  const idle = framesOnRow(0, STATE_ROWS.idle.durations).map((frame) => ({
    ...frame,
    durationMs: frame.durationMs * 6,
  }));
  return [...reaction, ...idle];
}

/** 패키지 clips 표로 재생. 없는 클립은 idle 클립, 그것도 없으면 STATE_ROWS 기본값. */
export function framesForClip(
  state: CodexPetState,
  clips?: readonly CodexPetClip[],
  reducedMotion = false,
): CodexPetFrame[] {
  if (!clips || clips.length === 0) return framesForState(state, reducedMotion);
  const matched = clipNamed(clips, state);
  const clip = matched ?? clipNamed(clips, "idle");
  if (!clip) return framesForState(state, reducedMotion);

  // 요청 클립이 없으면 idle 픽셀을 반응 모드로 속이지 않고 idle 루프를 그대로 쓴다.
  const resolved: CodexPetState = matched ? state : "idle";
  const spec = STATE_ROWS[resolved];
  const frames = framesOnRow(clip.row, durationsForClip(spec.durations, clip.frames));
  if (reducedMotion) return frames.slice(0, 1);
  if (resolved === "idle" || spec.mode === "loop") return frames;

  const reaction = [...frames, ...frames, ...frames];
  const idleClip = clipNamed(clips, "idle");
  const idleDurations = idleClip
    ? durationsForClip(STATE_ROWS.idle.durations, idleClip.frames)
    : STATE_ROWS.idle.durations;
  const idle = framesOnRow(idleClip?.row ?? 0, idleDurations).map((frame) => ({
    ...frame,
    durationMs: frame.durationMs * 6,
  }));
  return [...reaction, ...idle];
}

/** 8×9(기본 동작만) 배포본 — 9·10행의 시선 자세가 없다(PLAN-2026-09-15 P1). */
export const CODEX_PET_ROWS_COMPACT = 9;

/** rows 는 아틀라스의 실제 행 수(9 또는 11) — 배경 위치는 마지막 행이 100%가 되게 나눈다. */
export function framePosition(
  frame: Pick<CodexPetFrame, "row" | "column">,
  rows: number = CODEX_PET_ATLAS.rows,
): string {
  return `${(frame.column / (CODEX_PET_ATLAS.columns - 1)) * 100}% ${(frame.row / (rows - 1)) * 100}%`;
}

function idleGazeFrame(clips?: readonly CodexPetClip[]): CodexPetFrame {
  return { row: clipNamed(clips, "idle")?.row ?? 0, column: 0, durationMs: 0 };
}

// 9·10행(look-a/look-b)은 애니메이션이 아니라 16방향 정적 시선 자세다. framesForState의 반응/루프 규칙과 무관.
// 9행 아틀라스·clips 에 look 행이 없으면 idle 첫 프레임으로 폴백한다(빈 행을 읽지 않는다).
export function gazeFrame(
  angleDeg: number,
  rows: number = CODEX_PET_ATLAS.rows,
  clips?: readonly CodexPetClip[],
): CodexPetFrame {
  const lookA = clipNamed(clips, "look-a");
  const lookB = clipNamed(clips, "look-b");
  const hasLookClips = Boolean(lookA && lookB);
  if (clips && clips.length > 0) {
    if (!hasLookClips) return idleGazeFrame(clips);
  } else if (rows < CODEX_PET_ATLAS.rows) {
    return idleGazeFrame(clips);
  }
  const index = Math.round((((angleDeg % 360) + 360) % 360) / 22.5) % 16;
  const row =
    lookA && lookB ? (index < 8 ? lookA.row : lookB.row) : 9 + Math.floor(index / 8);
  return { row, column: index % 8, durationMs: 0 };
}

/** 아틀라스 높이 → 행 수. Rust(repo::pet::packages::rows_for_dimensions)와 같은 두 치수만 안다. */
export function rowsForHeight(height: number): number {
  return height === CODEX_PET_ATLAS.cellHeight * CODEX_PET_ROWS_COMPACT
    ? CODEX_PET_ROWS_COMPACT
    : CODEX_PET_ATLAS.rows;
}

export function CodexPetAtlas({
  dataUrl,
  state = "idle",
  size = 120,
  reducedMotion = false,
  label = "Codex 호환 펫",
  facing,
  rows,
  clips,
}: {
  dataUrl: string;
  state?: CodexPetState;
  size?: number;
  reducedMotion?: boolean;
  label?: string;
  /** 주어지면 state 애니메이션 대신 해당 각도의 정적 시선 프레임을 표시한다 (타이머 없음). */
  facing?: number;
  /** 아틀라스 행 수(9 또는 11). 생략하면 이미지 높이에서 스스로 잰다 — 패키지 메타를 들고
   *  있지 않은 호출부(PetSprite 등)도 9행 배포본을 올바른 비율로 그린다. */
  rows?: number;
  /** 있으면 하드코드 8×11 대신 패키지 클립 표로 재생. 생략 시 STATE_ROWS(설치분·구테스트). */
  clips?: readonly CodexPetClip[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [measuredRows, setMeasuredRows] = useState<number | null>(null);
  const atlasRows = rows ?? measuredRows ?? CODEX_PET_ATLAS.rows;

  useEffect(() => {
    if (rows !== undefined) return;
    const img = new Image();
    img.onload = () => setMeasuredRows(rowsForHeight(img.naturalHeight));
    img.src = dataUrl;
    return () => {
      img.onload = null;
    };
  }, [dataUrl, rows]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (facing !== undefined) {
      el.style.backgroundPosition = framePosition(gazeFrame(facing, atlasRows, clips), atlasRows);
      return;
    }
    const frames = framesForClip(state, clips, reducedMotion);
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showFrame = () => {
      el.style.backgroundPosition = framePosition(frames[index], atlasRows);
    };
    // 탭이 백그라운드면 타이머를 멈추고 현재 프레임에 고정, 복귀 시 재개.
    const scheduleNext = () => {
      if (frames.length === 1) return;
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        index = (index + 1) % frames.length;
        showFrame();
        scheduleNext();
      }, frames[index].durationMs);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        scheduleNext();
      } else {
        clearTimeout(timer);
      }
    };
    showFrame();
    scheduleNext();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [reducedMotion, state, facing, atlasRows, clips]);

  return (
    <div
      ref={ref}
      className="codex-pet-atlas"
      role="img"
      aria-label={label}
      data-codex-pet-state={state}
      style={{
        width: size,
        height: (size * CODEX_PET_ATLAS.cellHeight) / CODEX_PET_ATLAS.cellWidth,
        backgroundImage: `url(${dataUrl})`,
        backgroundSize: `${CODEX_PET_ATLAS.columns * 100}% ${atlasRows * 100}%`,
      }}
    />
  );
}
