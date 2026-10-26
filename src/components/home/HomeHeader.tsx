/**
 * Dashboard header band — W6-c: 3존 재배치, W7-c: 하늘 그라데이션 범위 축소, W8-a: 헤더 재정리,
 * 2026-08-15: 인사말 제거 + 헤더 높이 축소, **2026-10-19 R14: 문구 제거 + 헤더 낮춤.**
 *
 * 위계(PLAN-2026-08-04-dashboard-pet.md §A, 2026-08-15 갱신): 시계가 1순위(더 크게, 날짜 아래줄),
 * 날짜는 2순위로 작게 그 위에 온다. 오른쪽은 날씨 박스(WeatherSlot) 하나.
 *
 * R14(GRILL-2026-10-19, PLAN-2026-10-19-briefing-rewrite §6·§12.1 Q4 "비우고 낮춘다"): 가운데
 * 문구(옛 PhraseRow)는 브리핑 창 머리줄(src/briefing/QuoteLine.tsx)로 이사했다. 가운데 열이 없어져
 * 3열 대칭 그리드(문구를 수학적 중앙에 두려던 것)도 필요 없다 — 이제 좌(날짜·시계) / 우(날씨) 두
 * 존의 flex 행이다.
 *
 * **높이 — `--row-header` 공유를 일부러 끊었다.** W24 부터 이 헤더는 노트 타이틀바와 같은
 * `--row-header` 로 높이를 강제해(App.tsx 타이틀바 래퍼와 같은 토큰) 홈↔노트 전환 때 밑선이 같은 y 에
 * 오게 했다. 그 높이를 실제로 채우던 것이 문구 2줄 예약(≈66px)이었고, 문구가 빠지면 같은 토큰을 지킬
 * 이유가 내용에 없다. 오너 결정(R14)이 "낮춘다"라서 이 헤더는 **자기 내용의 최댓값**으로 높이를 정한다:
 *   위아래 패딩 --space-2 ×2 + max(날씨 박스, 날짜 줄 + 시계 줄) + 밑선 1px (border-box).
 *   - 날씨 박스 = 비네트 36px + 위아래 --space-4 ×2 + 테두리 2px = 58px(WeatherSlot.tsx — px 고정).
 *   - 날짜 줄 + 시계 줄 = --text-md×1.2 + --text-clock×1.05 (≈47px×fs, 아래 줄높이 그대로).
 *   산식 값(실앱 실측 아님): fs 1 = 71px(전 79px) · fs 0.85 = 71px(전 72.4px) · fs 1.35 = 76.6px(전 94.4px).
 *   이제 바닥은 날씨 박스다 — 더 낮추려면 WeatherSlot 의 세로 패딩(하늘 3스톱 최소치라는 주석이 있다)을
 *   건드려야 하고, 그건 R14 범위 밖이다.
 * 높이를 내용에 맡기지(auto) 않고 위 식으로 **고정**하는 이유: 날씨 박스는 fetch 뒤 비동기로 나타나므로
 * auto 면 그 순간 밴드가 47→58px 로 출렁인다. 식은 날씨가 아직 없을 때도 그 자리를 예약한다
 * (위치가 아예 없으면 — `loc` null — 예약하지 않는다: 날짜·시계만, fs 1 = 60px).
 *
 * 2026-08-15(오너 피드백 — "안녕히 주무세요 문구는 없어도됨... 헤더높이를 줄여서 노트 ui의
 * 타이틀과 유사한 수준으로"): col1 의 인사말 줄을 걷어내고 날짜/시계 순서를 뒤집었다(날짜 위 · 시계
 * 아래, 오너가 "지금처럼"이라 지정한 시계 배치는 유지). 시계 폰트도 그때 줄였다(--text-clock 38→30px).
 *
 * W8-a(오너 피드백): 우측 "N 노트 / N 폴더" 통계 칩은 걷어냈고 그 자리에 날씨 그라데이션 박스
 * (WeatherSlot)를 옮겨왔다. 미완료 일정 칩(headerUnfinishedVisible)도 2026-08-07 에 같은 방식으로
 * 걷어냈다(칩·설정 필드·토글·i18n 키·dashboard_board 헤더 fetch 전부) — 오른쪽은 날씨 박스뿐이다.
 *
 * 우측 슬롯은 날씨가 **비동기로** null 을 반환할 수 있다(위치 미설정/오프라인, WeatherSlot.tsx
 * 조기반환 참고). 위치 미설정(`loc` 없음, useWeatherLocation 동기값)이면 오른쪽 존 자체를 그리지 않는다.
 *
 * W7-c(QA §4): 하늘은 밴드 전체가 아니라 날씨칩을 감싸는 라운드박스 하나다. 밴드 전체를
 * 칠하면 시계·날짜까지 하늘 톤에 끌려가 앱의 나머지와 재질이 어긋났다. 그래서
 * `--on-sky*` 재바인딩과 그라데이션은 전부 WeatherSlot 의 박스 안으로 옮겼고, 이 헤더의 텍스트는
 * 평범한 테마 토큰(--text/--muted/--faint/--line)으로 돌아왔다. skyGradient.ts 는 무변경 —
 * 원래부터 background/tone/vars 를 **데이터로** 돌려주는 순수 함수였다.
 *
 * 하늘 계산(lib/skyGradient.ts: 태양고도 → 팔레트 → 날씨 보정)은 여전히 여기서 한다. 분 단위
 * 시계 틱을 가진 곳이 여기뿐이라 새 타이머가 0으로 유지되기 때문이고, 결과는 prop 으로 내려간다.
 * 날씨는 weather.ts의 1시간 캐시를 읽기만 하고(cachedWeather) API를 새로 부르지 않는다.
 */
import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { cachedWeather } from "../../lib/weather";
import { skyStyle } from "../../lib/skyGradient";
import { formatHeaderDate, formatHeaderTime } from "./greeting";
import { toIsoDateLocal } from "./dateFmt";
import { WeatherSlot } from "./WeatherSlot";
import { useWeatherLocation } from "./useWeatherLocation";

const CLOCK_TICK_MS = 60_000;
// R14 높이 산식의 두 항(파일 상단 주석). 날씨 박스 = 비네트 36px + 위아래 --space-4 + 테두리 2px
// (WeatherSlot.tsx·WeatherVignette.tsx — px 고정). 날짜·시계 = 아래 두 span 의 줄높이 합.
const WEATHER_BOX_HEIGHT = "calc(36px + var(--space-4) * 2 + 2px)";
const DATETIME_HEIGHT = "calc(var(--text-md) * 1.2 + var(--text-clock) * 1.05)";
// Reminder bell lives in the window chrome (ReminderBell.tsx), not this header.

export function HomeHeader() {
  const uiLang = useSettingsStore((s) => s.uiLang);

  const [now, setNow] = useState(() => new Date());
  const loc = useWeatherLocation();

  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setNow(d);
      // Dashboard audit P2 #4: the only date timer in the dashboard — CalendarTab piggybacks on
      // this via uiStore.todayIso instead of owning a second timer (see stores/ui.ts).
      useUiStore.getState().setTodayIso(toIsoDateLocal(d));
    }, CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // 분 틱마다 함께 갱신된다(now가 deps에 있으므로) — 캐시 읽기라 비용도 네트워크도 0.
  const sky = useMemo(
    () =>
      skyStyle({
        date: now,
        loc,
        weatherCode: loc ? (cachedWeather(loc)?.weatherCode ?? null) : null,
      }),
    [now, loc],
  );

  const dateLabel = formatHeaderDate(now, uiLang);
  const timeLabel = formatHeaderTime(now, uiLang);

  // W8-a: loc 이 있으면 WeatherSlot 이 (비동기로) 박스를 그릴 "예정"이다 — 위치 미설정처럼
  // 확실히 빈 경우는 오른쪽 존을 아예 그리지 않고, 높이도 날씨 박스 자리를 예약하지 않는다.
  // 표시 토글은 없다(D11, 2026-09-12) — 위치가 있으면 항상 그린다.
  const showRight = !!loc;
  // R14: 높이 = 내용의 최댓값(파일 상단 주석의 산식). 날씨가 올 예정이면 그 박스 자리를 미리 잡아
  // fetch 도착 때 밴드가 출렁이지 않게 한다.
  // ponytail: 위치는 있는데 fetch 가 계속 실패하면(오프라인 — WeatherSlot 의 재시도 3회까지 소진) 박스 없이
  // 58px 자리만 남아 날짜·시계만일 때보다 약 11px(fs 1) 높다. 천장 = `loc` 만 보고 예약하는 것. 체감되면
  // WeatherSlot 이 fetch 상태(성공/포기)를 위로 올려 주고, 포기했을 때 DATETIME_HEIGHT 로 내린다.
  const contentHeight = showRight ? `max(${WEATHER_BOX_HEIGHT}, ${DATETIME_HEIGHT})` : DATETIME_HEIGHT;

  return (
    <header
      data-testid="home-header"
      style={{
        flex: "none",
        // W24: horizontal --space-7 → --content-inset(14px) — 홈↔노트 전환 시 제목 시작점이
        // 4px 흔들리던 것을 노트 TitleBar와 같은 인셋으로 통일(오너). HomeTab nav 행도 동행.
        // R14: 세로는 위아래 같은 --space-2 — 타이틀바 패딩(12/4)에 맞출 이유가 높이 공유와 함께 사라졌다.
        padding: "var(--space-2) var(--content-inset)",
        // W24: --line → --divider — 노트 TitleBar 하단선과 같은 "구역 경계" 위계(헤어라인 원칙,
        // docs/DESIGN.md). 홈↔노트 전환 시 헤더 밑선의 대비가 미세하게 달라 보이던 것의 수정.
        borderBottom: "1px solid var(--divider)",
        // R14: --row-header(노트 타이틀바와 공유) 대신 자기 내용으로 — 파일 상단 주석 참고. border-box.
        height: `calc(var(--space-2) * 2 + ${contentHeight} + 1px)`,
        boxSizing: "border-box",
      }}
    >
      <div
        data-testid="home-header-row"
        style={{
          // R14: 가운데 문구 열이 빠져 3열 대칭 그리드가 필요 없다 — 좌(날짜·시계) / 우(날씨) 두 존.
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          height: "100%",
        }}
      >
        {/* 좌: 날짜(작게) → 시계(1순위, 크게). W8-a: 날씨는 우측으로 이사했다. */}
        <div
          data-testid="home-header-col1"
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "flex-end",
            gap: "var(--space-5)",
            minWidth: 0,
          }}
        >
          <div
            data-testid="home-header-datetime"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              // DATETIME_HEIGHT 의 1.2 — 바꾸면 위 상수도 같이.
              lineHeight: 1.2,
            }}
          >
            <span
              data-testid="home-date"
              style={{ color: "var(--muted)", fontSize: "var(--text-md)" }}
            >
              {dateLabel}
            </span>
            <span
              key={timeLabel}
              data-testid="home-time"
              className="home-clock-tick"
              style={{
                color: "var(--text)",
                fontSize: "var(--text-clock)",
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                // DATETIME_HEIGHT 의 1.05 — 바꾸면 위 상수도 같이.
                lineHeight: 1.05,
              }}
            >
              {timeLabel}
            </span>
          </div>
        </div>

        {/* 우: W8-a — 통계 칩 대신 날씨 그라데이션 박스(WeatherSlot). 알림 벨은 창 프레임의
            펫 버튼 옆에 있다(ReminderBell). */}
        {showRight && (
          <div
            data-testid="home-header-right"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              flexWrap: "wrap",
              gap: "var(--space-3)",
              minWidth: 0,
            }}
          >
            <WeatherSlot sky={sky} />
          </div>
        )}
      </div>
    </header>
  );
}
