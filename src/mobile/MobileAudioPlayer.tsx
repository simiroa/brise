import { useRef, useState } from "react";
import { t } from "../i18n/t";
import { IconPlay, IconPause } from "../components/icons";
import { reportFallback } from "../lib/diag";
import { consumeLongPress } from "../lib/longPress";
import "../styles/mobileAudioPlayer.css";

/**
 * 길이를 아는 음성 첨부의 재생기(MobileAttachmentList 의 오디오 행).
 *
 * 기본 `<audio controls>` 는 파일이 말하는 길이를 믿는데, 폰 녹음(조각난 MP4)은 그 길이가 첫 조각(5초)이라
 * 12초·54초 녹음도 "0:05" 로 나온다. 여기서는 `<audio>` 를 컨트롤 없이 소리 엔진으로만 쓰고, 총 길이는 호출 쪽이
 * 넘긴 `durationMs`(녹음기가 잰 값, voiceDurations)로 고정한다 — `audio.duration` 이 Infinity·NaN·틀린 유한값(5)이어도
 * 읽지 않는다. 경과 시간은 audio.currentTime 을 총 길이로 잘라 쓴다.
 *
 * 길이를 모르는 행(옛 녹음·다른 기기·사용자가 고른 파일)은 이 컴포넌트가 아니라 예전 그대로 기본 플레이어다.
 *
 * ponytail: 조각난 MP4 는 탐색 가능 범위(seekable)도 불완전할 수 있다 — 슬라이더로 뒤쪽을 눌러 브라우저가 되돌리면
 * 경과 표시가 그 위치로 따라간다(timeupdate 가 진실). 실기에서 어긋나면 업그레이드 경로는 업로드 때 길이를 채우는 리먹스.
 */

/** 0:12 형식. `round` = 총 길이(전사 머리말의 formatVoiceDuration 과 같은 반올림), 아니면 경과(내림). */
export function formatClock(ms: number, round = false): string {
  const total = Math.max(0, round ? Math.round(ms / 1000) : Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Glyph({ playing }: { playing: boolean }) {
  const Icon = playing ? IconPause : IconPlay;
  return <Icon size={20} fill="currentColor" strokeWidth={0} aria-hidden />;
}

export function MobileAudioPlayer({ src, durationMs }: { src: string; durationMs: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const shownMs = Math.min(Math.max(0, elapsedMs), durationMs);

  const toggle = () => {
    // 행 전체에 길게 누르기(삭제 확인)가 걸려 있다 — 방금 발동했다면 이 탭은 삭제를 향한 것이다.
    if (consumeLongPress()) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // 재생 여부는 play/pause 이벤트가 정한다(낙관적으로 바꾸지 않는다) — 거부되면 "멈춤" 그대로 두고 기록한다.
      Promise.resolve(audio.play()).catch((e) =>
        reportFallback("voice", "play_failed", e instanceof Error ? e.name : "play rejected"));
    } else {
      audio.pause();
    }
  };

  const seek = (ms: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = ms / 1000;
    setElapsedMs(ms);
  };

  return (
    <div className="mobile-audio">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- voice memos have no captions to provide */}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setElapsedMs(0);
        }}
        onTimeUpdate={(e) => setElapsedMs(e.currentTarget.currentTime * 1000)}
      />
      <button
        type="button"
        className="mobile-audio-btn"
        aria-label={playing ? t("mobileVoice.player_pause") : t("mobileVoice.player_play")}
        onClick={toggle}
      >
        <Glyph playing={playing} />
      </button>
      <input
        type="range"
        className="mobile-audio-seek"
        min={0}
        max={durationMs}
        step={100}
        value={shownMs}
        aria-label={t("mobileVoice.player_seek")}
        // 슬라이더를 끌고 있는 손가락이 행의 길게 누르기(삭제)를 켜지 않게 한다.
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className="mobile-audio-time" data-testid="audio-time">
        {formatClock(shownMs)} / {formatClock(durationMs, true)}
      </span>
    </div>
  );
}
