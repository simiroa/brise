/**
 * Header weather group — data parent for the header's weather display: met.no current conditions
 * (fetched via Rust, lib/weather.ts) rendered as an ambient WeatherVignette (icon + gentle
 * motion) beside the existing label/temp text. Quietly renders nothing when location unset or
 * fetch fails (offline) — the
 * header's right-side date/time unit is unaffected either way (see HomeHeader.tsx), this group
 * just doesn't add itself.
 *
 * Location comes from a priority chain (see lib/weather.ts::resolveWeatherLocation):
 * notebook default (Settings→Map / onboarding) > most-common note location. A title tooltip
 * names which link fired, so "why is this showing Seoul weather" is answerable at a glance
 * without opening Settings.
 *
 * Typography (QA8 2A): temp tracks the header clock scale (--text-2xl); condition label stays
 * secondary so the numeric readout leads. Temp remounts via key on change for a short fade/slide
 * (same .home-clock-tick class as the minute clock — reduced-motion gated in tokens.css).
 *
 * W7-c: 하늘 그라데이션의 **범위가 이 컴포넌트로 줄었다**. W6-c 에서는 HomeHeader 가 밴드 전체를
 * 칠했지만 이제는 이 칩을 감싸는 라운드박스 하나만 하늘이다(QA §4). 박스를 여기서 그리는 이유는
 * 하나뿐이다 — "날씨가 없으면 박스도 없다"를 아는 곳이 여기다(아래 `!snap` 조기 반환). HomeHeader
 * 는 WeatherSlot 이 실제로 무엇을 렌더할지 모르므로, 거기서 감쌌다면 위치 미설정·오프라인일 때
 * 빈 그라데이션 사각형이 남는다. 대신 분 단위로 갱신되는 `sky` 는 시계 틱을 가진 HomeHeader 가
 * 계산해 prop 으로 내려준다(새 타이머 0).
 *
 * on-gradient 톤(--on-sky*)과 전역 텍스트 토큰 재바인딩도 이 박스 안에서만 일어난다. 그래서 아래
 * `var(--on-sky, var(--text))` 폴백은 그대로 두면 된다 — 박스 안이면 하늘 톤, 밖이면 테마색.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { t } from "../../i18n/t";
import { fetchWeather, type ResolvedWeatherLocation, type WeatherSnapshot } from "../../lib/weather";
import type { SkyStyle } from "../../lib/skyGradient";
import { useWeatherLocation } from "./useWeatherLocation";
import { usePlaceName } from "./usePlaceName";
import { WeatherVignette } from "./WeatherVignette";

/** Exported for reuse by settings/WeatherSection.tsx's read-only "resolved from" line. */
export function sourceLabel(source: ResolvedWeatherLocation["source"]): string {
  if (source === "workspace") return t("home.weather_source_workspace");
  return t("home.weather_source_notes");
}

// U4(AUDIT-2026-09-26): 예전엔 fetchWeather 가 한 번 실패하면(오프라인 순간, met.no 일시 오류 등)
// 위치가 바뀌어 이 effect 가 재실행될 때까지 재시도가 전혀 없었다 — 세션 내내 날씨 박스가 사라진
// 채로 남았다. 30초/2분/5분 3회 백오프로 재시도하고, 그 사이에 탭이 다시 보이면(visibilitychange)
// 남은 백오프를 기다리지 않고 즉시 한 번 더 시도한다(자리를 비웠다 돌아온 사용자가 가장 흔한 케이스).
const WEATHER_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

export function WeatherSlot({ sky }: { sky: SkyStyle }) {
  const [snap, setSnap] = useState<WeatherSnapshot | null>(null);
  const [source, setSource] = useState<ResolvedWeatherLocation["source"] | null>(null);

  const resolved = useWeatherLocation();
  const placeName = usePlaceName(resolved);

  useEffect(() => {
    if (!resolved) {
      setSnap(null);
      setSource(null);
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // 이 위치로 한 번이라도 받아 온 적이 있나 — 있으면 새로 받기가 실패해도 마지막 값을 계속
    // 보여준다(창이 다시 보일 때의 갱신 실패가 멀쩡히 보이던 날씨를 지우던 문제, 2026-09-26 리뷰).
    let hasGoodSnap = false;

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const attemptFetch = () => {
      clearRetry();
      void fetchWeather(resolved).then((s) => {
        if (cancelled) return;
        if (s) {
          attempt = 0;
          hasGoodSnap = true;
          setSnap(s);
          setSource(resolved.source);
          return;
        }
        // 이미 보여주던 값이 있으면 그대로 둔다 — 다음 가시성 복귀 때 다시 갱신을 시도한다.
        if (hasGoodSnap) return;
        setSnap(null);
        setSource(null);
        if (attempt < WEATHER_RETRY_DELAYS_MS.length) {
          const delay = WEATHER_RETRY_DELAYS_MS[attempt];
          attempt += 1;
          retryTimer = setTimeout(attemptFetch, delay);
        }
      });
    };

    attemptFetch();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") attemptFetch();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearRetry();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [resolved]);

  if (!snap || !source) return null;

  // 실제 지명 우선, 못 얻었으면 좌표의 출처 설명(오프라인 폴백).
  const title = placeName ?? sourceLabel(source);

  return (
    <div
      data-testid="home-weather-group"
      data-sky-tone={sky.tone}
      // .sky-box = 배경/텍스트 톤 전이(tokens.css). prefers-reduced-motion 은 거기 미디어 쿼리가
      // 끈다 — JS 훅으로 분기할 이유가 없는 순수 CSS 전이다(lib/ui.ts 훅 주석 참고).
      className="sky-box"
      style={
        {
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          // 상하 패딩이 같은 값 하나(--space-4) → 칩은 박스 안에서 자동으로 수직 중앙(QA §4).
          // 세로 10px × 비네트 36px = 박스 높이 56px 로, 3스톱 팔레트가 각자 자리를 갖는 최소치다.
          // 좌우는 한 단계 넓게(--space-6) — 좁고 긴 상자라야 세로 그라데이션이 하늘로 읽힌다.
          padding: "var(--space-4) var(--space-6)",
          // 56px 높이에 radius-lg(16px) = 알약이 아니라 "하늘 창". 알약은 우측 통계 칩(999)과
          // 형태가 겹쳐 위계가 뭉갠다.
          borderRadius: "var(--radius-lg)",
          // 헤어라인은 박스 자신의 톤에서 뽑는다(--on-sky-line). 안개/눈처럼 팔레트가 한지에
          // 가까워지는 시각에도 가장자리가 녹지 않는다. 그림자는 쓰지 않는다 — 단일 시트 원칙.
          border: "1px solid var(--on-sky-line)",
          background: sky.background,
          color: "var(--on-sky)",
          flex: "none",
          // overflow 를 자르지 않는 것이 계약이다: 비/눈 장식이 박스 아래를 살짝 넘어간다
          // (tokens.css wx-fall/wx-snowfall).
          ...sky.vars,
          "--text": "var(--on-sky)",
          "--muted": "var(--on-sky-muted)",
          "--faint": "var(--on-sky-faint)",
        } as CSSProperties
      }
    >
      <WeatherVignette weatherCode={snap.weatherCode} tempC={snap.tempC} />
      <span
        data-testid="home-weather"
        title={title}
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: "var(--space-2)",
          color: "var(--muted)",
        }}
      >
        <span
          data-testid="home-weather-label"
          style={{ fontSize: "var(--text-sm)", color: "var(--faint)" }}
        >
          {t(snap.labelKey)}
        </span>
        {/* key=tempC restarts the tick fade when the reading changes (same class as home-time). */}
        <span
          key={snap.tempC}
          data-testid="home-weather-temp"
          className="home-clock-tick"
          style={{
            // 하늘 그라데이션 위 톤 우선(HomeHeader가 심는 --on-sky), 헤더 밖이면 테마 토큰 폴백.
            color: "var(--on-sky, var(--text))",
            fontSize: "var(--text-2xl)",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {snap.tempC}°
        </span>
      </span>
    </div>
  );
}
