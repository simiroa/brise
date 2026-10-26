import { anchorId } from "./settingsAnchor";
import type { CSSProperties } from "react";
import { t } from "../../i18n/t";
import { useSettingsStore } from "../../stores/settings";
import { groupCardStyle } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { MapSection } from "./MapSection";
import { WeatherSection, useWeatherReadout } from "./WeatherSection";
import { usePlaceName } from "../home/usePlaceName";
import { formatHeaderDate } from "../home/greeting";
import { IconMapPin } from "../icons";

/**
 * 설정 > 지역 및 날씨 (PLAN-2026-09-15-settings-pet-region §0 R1~R6).
 *
 * **한 장의 서사**: 지역을 정하면 현지 시간·날씨·공휴일이 따라온다.
 *
 * 페이지 = 첫 줄 마스터 토글 행(R2, D4) + 3:7 스트립(**카드 밖** — R1/R4) + 지역 카드(R5)
 * + "달력은 달력 및 일정에서" 한 줄(R6 은 2026-09-19 재번복 — 달력 카드는 NotificationsSection). 블록은 전부 프래그먼트의 직계 자식이라 SettingsPanel 본문의 flex gap 이
 * 간격을 맡는다.
 *
 * R4 스트립: 좌 3 = 날짜·큰 시계·시간대, 우 7 = 위 줄 지역 이름(역지오코딩, 못 얻으면 좌표),
 * 아래 줄 7일 예보(`WeatherSection`). 시계는 예보가 알려 준 시간대로 그리고, 시간대를 모르면 이 PC
 * 의 시각을 그리되 아래 줄에 "이 PC 기준 시각" 이라고 밝힌다(현지 시간인 척하지 않는다).
 * 예보를 못 받으면 띠 자리에 "불러오지 못했습니다" 한 줄이 선다.
 *
 * R3 게이트: `region_enabled` 가 꺼지면 스트립 자리에 "꺼짐" 한 줄만 남는다. 꺼짐 판정은
 * 여기가 아니라 `useWeatherLocation` **한 지점**에 있다 — 이 컴포넌트는 그 결과(위치 없음)를
 * 볼 뿐이고, 그래서 met.no 요청·장소명 역조회도 같이 사라진다. 지도는 계속 쓸 수 있다
 * (사용자가 고르는 좌표는 날씨와 별개다).
 */
export function ViewSection() {
  const regionEnabled = useSettingsStore((s) => s.regionEnabled);
  const setRegionEnabled = useSettingsStore((s) => s.setRegionEnabled);
  const uiLang = useSettingsStore((s) => s.uiLang);

  const { resolved, forecast, status, localTimeStr, timezone } = useWeatherReadout();
  const placeName = usePlaceName(resolved);

  return (
    <>
      {/* 마스터 스위치는 페이지 첫 줄 설정 행(PLAN-2026-10-24 D4). 이 토글이 끄는 것(현지 시간·날씨·장소 이름
          조회)은 라벨과 힌트가 말한다 — 지도는 안 꺼진다. */}
      <div className="card" style={groupCardStyle} data-testid="settings-region-master-card">
        <SettingsRow
          anchor="region_enabled"
          label={t("settings.region_enabled")}
          hint={t("settings.region_enabled_hint")}
          data-testid="settings-region-enabled-control"
          control={
            <Toggle
              checked={regionEnabled}
              onChange={(next) => void setRegionEnabled(next)}
              aria-label={t("settings.region_enabled")}
              data-testid="settings-switch-region-enabled"
            />
          }
        />
      </div>

      <div
        data-testid="settings-region-strip"
        style={{ ...strip, gridTemplateColumns: resolved ? "minmax(0, 3fr) minmax(0, 7fr)" : "1fr" }}
      >
        {resolved ? (
          <>
            <div style={stripLeft}>
              <span style={stripDate}>{formatHeaderDate(new Date(), uiLang)}</span>
              <span style={stripClock} data-testid="settings-region-clock">
                {localTimeStr ?? "—"}
              </span>
              <span style={stripTimezone} data-testid="settings-region-timezone">
                {timezone ?? t("settings.region_timezone_unknown")}
              </span>
            </div>
            <div style={stripRight}>
              {/* 예보 머리 = 사람이 부르는 지역 이름. 이름을 못 얻었을 때만 좌표로 물러나고, 그 사실은
                  툴팁이 말한다(좌표는 아래 지도 카드에도 있다). */}
              <span
                style={stripPlace}
                data-testid="settings-region-place"
                title={placeName ? undefined : t("settings.region_name_unknown")}
              >
                {placeName ?? `${resolved.lat.toFixed(4)}, ${resolved.lng.toFixed(4)}`}
              </span>
              <WeatherSection forecast={forecast} status={status} />
            </div>
          </>
        ) : (
          <span style={stripOff} data-testid="settings-region-off">
            {t("settings.region_off")}
          </span>
        )}
      </div>

      <div id={anchorId("weather")} className="card" style={groupCardStyle}>
        <SectionHeader
          title={t("settings.region_weather_environment")}
          icon={<IconMapPin size={14} strokeWidth={2} />}
        />
        {/* 서사는 ⓘ 뒤가 아니라 화면에 있다 — 이 페이지의 요점 자체가 "하나를 정하면 둘이
            따라온다"는 인과라, 툴팁으로 내리면 페이지가 자기 설명을 잃는다. 한 줄 상한은 지킨다
            (docs/DESIGN.md §설정 레이아웃 ③). */}
        <p style={lede} data-testid="settings-region-lede">
          {t("settings.region_weather_hint")}
        </p>

        {/* R5: 한 줄 2단 — 좌 지도, 우 지역 이름·주소 검색·[초기화][좌표 지우기]. 그 2단은
            RegionPickerFields 가 6:4 퍼센트 flex 로 갖고 있다(카드 폭을 따라 늘어난다) — 여기서
            두 번째 격자를 덧대지 않는다. */}
        <MapSection />
      </div>

      {/* R6 재번복(2026-09-19, PLAN-2026-09-19-calendar-schedule §0): 달력 카드(주 시작일·공휴일)는
          "달력 및 일정"(알림 페이지)으로 갔다 — 공휴일이 목록이 되어 일정의 재료가 됐다. 여기엔 찾아갈
          곳을 말하는 한 줄만 남긴다. */}
      <p style={movedNote} data-testid="settings-region-calendar-moved">
        {t("settings.region_calendar_moved")}
      </p>
    </>
  );
}

/** 3:7 — 좌측이 날짜/시계라 고정 비율이면 충분하다. `minmax(0,…)` 없이 fr 만 쓰면 우측의
 *  예보 띠(overflow-x)가 트랙을 밀어 넓히므로 둘 다 0 하한을 준다. */
const strip: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 3fr) minmax(0, 7fr)",
  gap: "var(--space-7)",
  alignItems: "center",
  background: "var(--surface-sunken)",
  border: "1px solid var(--divider)",
  borderRadius: "var(--radius-md)",
  padding: "var(--space-6) var(--space-7)",
  boxSizing: "border-box",
  width: "100%",
};

const stripLeft: CSSProperties = { display: "flex", flexDirection: "column", minWidth: 0 };
const stripRight: CSSProperties = { display: "flex", flexDirection: "column", minWidth: 0 };

const stripDate: CSSProperties = { fontSize: "var(--text-md)", color: "var(--muted)" };

const stripClock: CSSProperties = {
  fontSize: "var(--text-clock)",
  fontWeight: 600,
  color: "var(--text)",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "var(--lh-tight)",
};

const stripTimezone: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const stripPlace: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const stripOff: CSSProperties = { fontSize: "var(--text-sm)", color: "var(--muted)" };

/** SectionHeader 바로 아래 한 줄 — 제목이 못 하는 "왜 한 카드인가"를 말한다. */
const lede: CSSProperties = {
  margin: "0 0 var(--space-6)",
  fontSize: "var(--text-sm)",
  color: "var(--muted)",
};

/** 페이지 끝 한 줄 — 옮겨 간 달력 카드를 찾아갈 곳. 카드가 아니다(R1). */
const movedNote: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--muted)",
};
