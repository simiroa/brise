import type { ReactNode } from "react";
import { t } from "../../../i18n/t";
import { toneColor } from "../../../lib/calendarDay";
import {
  weatherCodeToVisual,
  weatherLabelKey,
  weatherTempColorVar,
} from "../../../lib/weather";

/**
 * W15 ② — 지속시간 라벨("1시간 30분" · 30분이면 "30분"). 세 로케일 문구가 필요해 산수만 있는
 * calendarLayout 이 아니라 여기 산다(그 파일은 i18n 을 모른다 — 픽셀↔분 계산만 소유한다).
 * 0 이하는 라벨이 없다(호출자가 그때는 아예 그리지 않는다).
 */
export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return t("home.cal_dur_m", { m });
  if (m === 0) return t("home.cal_dur_h", { h });
  return t("home.cal_dur_hm", { h, m });
}

export interface DayBriefingProps {
  parts: { month: string; day: string; weekday: string };
  holidayName: string | null;
  /** 빨간 날이 아닌 기념일 이름표(PLAN-2026-09-19-calendar-schedule). */
  markLabel?: string | null;
  weather: { code: number; max: number; min: number } | null;
  summary: ReactNode;
}

/**
 * 그 날의 브리핑 리포트 헤더(W4 ②). 위계는 전부 **크기**로 준다 — 굵기 사다리는 400/600 두
 * 단뿐이라(docs/DESIGN.md) 굵기로는 3단이 안 나오고, 사용자가 글꼴 배율(--fs)을 키우면
 * 280px 안에서 큰 글자가 먼저 터진다. 그래서 모든 행이 wrap 되고 숫자만 tabular 로 고정된다.
 * 날씨는 없으면(forecast null 이거나 그 날이 예보 창 밖) **그 자리만 조용히 빈다** — 장식이지
 * 블로킹이 아니라는 lib/weather.ts 의 규칙 그대로다.
 */
export function DayBriefing({
  parts,
  holidayName,
  markLabel = null,
  weather,
  summary,
}: DayBriefingProps) {
  const visual = weather ? weatherCodeToVisual(weather.code, weather.max) : null;
  return (
    <div
      data-testid="cal-day-briefing"
      style={{
        flex: "none",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        fontFamily: "var(--font-heading)",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}>{parts.month}</div>
      {/* 히어로 한 줄 — 날짜는 왼쪽, 날씨는 그 **오른쪽 끝**(오너 실기 2026-09-10: "날짜 우측에
          좀더 잘보이게"). 글꼴 배율(--fs)을 키우면 flexWrap 이 날씨를 아랫줄로 떨어뜨린다. */}
      <h3
        style={{
          margin: 0,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-3)",
          minWidth: 0,
          fontWeight: 400,
          lineHeight: "var(--lh-tight)",
        }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)", minWidth: 0 }}>
          <span
            data-testid="cal-briefing-day"
            style={{ fontSize: "var(--text-clock)", fontVariantNumeric: "tabular-nums" }}
          >
            {parts.day}
          </span>
          <span style={{ fontSize: "var(--text-lg)", color: "var(--muted)", wordBreak: "keep-all" }}>
            {parts.weekday}
          </span>
        </span>
        {visual && weather && (
          <span
            data-testid="cal-briefing-weather"
            // 글자 라벨("구름 조금")은 이 줄에서 뺐다 — 아이콘이 이미 그 말을 하고 있어 한 줄에
            // 여섯 조각이 늘어섰다. **월 그리드가 이미 같은 규칙**이다(MonthGrid 의 weatherTitle:
            // 화면엔 아이콘+온도, 라벨은 title 툴팁). 같은 값은 같은 대접을 받는다.
            title={`${t(weatherLabelKey(weather.code))} ${Math.round(weather.max)}°/${Math.round(weather.min)}°`}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--space-2)",
              flex: "none",
            }}
          >
            <visual.Icon
              size={22}
              strokeWidth={1.8}
              style={{ color: visual.colorVar, flex: "none", alignSelf: "center" }}
            />
            <span
              style={{
                fontSize: "var(--text-xl)",
                fontVariantNumeric: "tabular-nums",
                color: weatherTempColorVar(weather.max, weather.min),
              }}
            >
              {Math.round(weather.max)}°
            </span>
            <span
              style={{
                fontSize: "var(--text-sm)",
                fontVariantNumeric: "tabular-nums",
                color: "var(--faint)",
              }}
            >
              {Math.round(weather.min)}°
            </span>
          </span>
        )}
      </h3>
      {holidayName && (
        <div
          data-testid="cal-briefing-holiday"
          style={{
            // 공휴일은 일요일처럼 읽는다 — 월 그리드와 같은 규칙(lib/calendarDay::toneColor).
            color: toneColor("sun"),
            fontSize: "var(--text-sm)",
            wordBreak: "break-word",
          }}
        >
          {holidayName}
        </div>
      )}
      {markLabel && (
        <div
          data-testid="cal-briefing-mark"
          style={{ color: "var(--accent)", fontSize: "var(--text-sm)", wordBreak: "break-word" }}
        >
          {markLabel}
        </div>
      )}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}>{summary}</div>
    </div>
  );
}
