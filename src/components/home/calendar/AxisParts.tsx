import { memo, type ReactNode } from "react";
import type { TimelineRoutine } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { folderColorCss } from "../../../lib/ui";
import { DAY_MIN, formatHhmm, parseHhmm, TIME_LABEL_W } from "../calendarLayout";

/**
 * 시간축의 **그리기 전용 층들** — DayAxis 에서 떼어 냈다(순수 이동, DOM·testid·스타일 변화 0). 칩을 끄는 동안 DayAxis 는 스냅 칸이 바뀔 때마다
 * 다시 그려지는데, 아래 셋은 그 사이에 입력이 안 바뀌므로 memo 로 건너뛴다(배율·구간·루틴·분이 그대로면 같은 props).
 */

/** 익일 구간 — 자정에 눈에 띄는 구분선(일반 눈금선보다 굵게) + 다음 날 날짜 라벨, 구간 전체는 옅은 면으로 구분한다.
 *  칩보다 뒤(DOM 순서)·포인터 없음이라 만들기 드래그가 이 위에서 그대로 시작된다. */
export const TailZone = memo(function TailZone({
  tailMinutes,
  tailDay,
  pxPerMin,
}: {
  tailMinutes: number;
  tailDay: string;
  pxPerMin: number;
}) {
  return (
    <>
      <div
        aria-hidden
        data-testid="cal-time-tail-zone"
        style={{
          position: "absolute",
          top: DAY_MIN * pxPerMin,
          height: tailMinutes * pxPerMin,
          left: 0,
          right: 0,
          background: "color-mix(in srgb, var(--faint) 7%, transparent)",
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        data-testid="cal-time-midnight"
        style={{
          position: "absolute",
          top: DAY_MIN * pxPerMin,
          left: 0,
          right: 0,
          height: 0,
          borderTop: "2px solid var(--faint)",
          pointerEvents: "none",
        }}
      >
        <span
          data-testid="cal-time-midnight-label"
          className="cal-tick-label cal-tick-label--solid"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            transform: "translateY(-50%)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text)",
            fontWeight: 600,
            fontSize: "var(--text-xs)",
          }}
        >
          {t("home.cal_axis_next_day", { date: tailDay.slice(5).replace("-", "/") })}
        </span>
      </div>
    </>
  );
});

/** 시간축 배경 루틴 띠들. */
export const RoutineBands = memo(function RoutineBands({
  routines,
  pxPerMin,
}: {
  routines: TimelineRoutine[];
  pxPerMin: number;
}) {
  return (
    <>
    {routines.map((r) => {
      const startMin = parseHhmm(r.start_time);
      const endMin = parseHhmm(r.end_time);
      if (startMin === null || endMin === null || endMin <= startMin) return null;
      const bandColor =
        r.color_hue != null ? folderColorCss(r.color_hue) : "var(--accent)";
      return (
        <div
          key={r.id}
          data-testid={`cal-timeline-routine-${r.id}`}
          title={`${r.title} ${r.start_time}–${r.end_time}`}
          style={{
            position: "absolute",
            top: startMin * pxPerMin,
            height: (endMin - startMin) * pxPerMin,
            left: TIME_LABEL_W,
            right: 0,
            zIndex: 0,
            background: `color-mix(in srgb, ${bandColor} 12%, transparent)`,
            pointerEvents: "none",
          }}
        >
          <div
            data-testid={`cal-timeline-routine-title-${r.id}`}
            style={{
              position: "absolute",
              top: 1,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: "calc(100% - var(--space-2))",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "var(--text-2xs)",
              fontWeight: 600,
              color: bandColor,
            }}
          >
            {r.title}
          </div>
        </div>
      );
    })}
    </>
  );
});

/** ③ 오늘의 현재 시각 선 + 라벨. */
export const NowLine = memo(function NowLine({ nowTop, minutes }: { nowTop: number; minutes: number }) {
  return (
      <div
        data-testid="cal-time-now"
        className="cal-now-line"
        style={{
          position: "absolute",
          top: nowTop,
          left: TIME_LABEL_W,
          right: 0,
          height: 0,
          zIndex: 1,
          borderTop: "2px solid var(--accent)",
          pointerEvents: "none",
        }}
      >
        {/* W11 ②: accent 알약 + 흰 글자(--on-solid)를 버렸다 — 밝은 세이지 위의 흰 글자는
            대비가 2:1 남짓이고, 바로 이 선의 발광이 같은 색으로 번져 글자가 묻혔다(오너
            실기의 "흰색 폰트 + 밝은 배경"이 정확히 이것이다). 이제 눈금 라벨과 **같은**
            `.cal-tick-label` 로 선을 끊고, 글자는 그 배경 위에서 가장 또렷한 --text 다.
            --accent 는 고르지 않았다: 라이트 테마에서 accent(#7da98c) 대 한지 배경
            (#f4efe3)이 2.4:1 로 11px 글자에는 모자라고, "지금"이라는 신호는 2px accent 선과
            맥동 발광이 이미 충분히 말한다. 대신 굵기 한 단(600)으로 --faint 400 인 눈금
            라벨과 구분된다.
            선 중앙에 걸터앉는다(눈금 라벨과 같은 처방) — 이 컨테이너가 height 0 + 2px
            테두리라 translateY(-50%) 가 곧 선 중앙이다. */}
        <span
          data-testid="cal-time-now-label"
          className="cal-tick-label cal-tick-label--solid"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            transform: "translateY(-50%)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text)",
            fontWeight: 600,
            fontSize: "var(--text-xs)",
          }}
        >
          {formatHhmm(minutes)}
        </span>
      </div>
  );
});

/** 도구 줄 — 왼쪽 안내/다음 일정 + 오른쪽 "하루 전체 보기" 토글. */
export function AxisToolbar({
  toolbarHint,
  nextStartMin,
  wholeDayView,
  onToggleWholeDayView,
}: {
  toolbarHint: ReactNode;
  /** 사이드바: 오늘의 다음 일정 시작 분(없으면 null). */
  nextStartMin: number | null;
  wholeDayView: boolean;
  onToggleWholeDayView: () => void;
}) {
  return (
    <>
    {/* 오너 요청(2026-09-16) — "하루 전체 보기": 사이드바 축은 보이는 창이 ~168px(≈6시간)뿐이라
        하루를 보려면 계속 스크롤해야 한다는 피드백. **실제 레이아웃 행**(flex:"none")으로 두어
        스크롤 영역 위에 떠서 칩(특히 스크롤 맨 위에 걸린 칩의 설정 아이콘)을 가리지 않는다 —
        absolute 오버레이는 스크롤 위치에 따라 매번 다른 칩과 겹치므로 쓰지 않았다. */}
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "flex-end",
        gap: "var(--space-2)",
        minWidth: 0,
      }}
    >
      {(toolbarHint || nextStartMin !== null) && (
        <div
          title={nextStartMin !== null ? t("home.cal_next_event", { time: formatHhmm(nextStartMin) }) : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--faint)",
            fontSize: "var(--text-2xs)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {toolbarHint}
          {nextStartMin !== null && (
            <span data-testid="cal-axis-next">
              {toolbarHint ? " · " : ""}
              {t("home.cal_next_event", { time: formatHhmm(nextStartMin) })}
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="cal-axis-fit-day"
        aria-pressed={wholeDayView}
        title={t("home.cal_axis_fit_day")}
        onClick={onToggleWholeDayView}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          font: "inherit",
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
          color: wholeDayView ? "var(--accent)" : "var(--faint)",
          cursor: "pointer",
          textDecoration: "underline",
          textUnderlineOffset: 2,
        }}
      >
        {t("home.cal_axis_fit_day")}
      </button>
    </div>
    </>
  );
}
