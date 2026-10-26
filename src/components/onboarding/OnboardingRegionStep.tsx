import React, { useEffect, useRef, useState } from "react";
import { callSilent } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { t } from "../../i18n/t";
import { useSettingsStore } from "../../stores/settings";
import { useGeocodeSearch, type GeocodeResultItem } from "../../lib/useGeocodeSearch";
import { fetchWeather, weatherCodeToVisual, type WeatherSnapshot } from "../../lib/weather";
import { IconSearch, IconClose, IconClock, IconMapPin, IconCompass, IconCheckMark, IconCalendar, IconWeather } from "../icons";

export interface RegionSelection {
  label: string;
  lat: number;
  lng: number;
}

type TzState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; timeZone: string }
  | { status: "error" };

type WeatherState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; snapshot: WeatherSnapshot }
  | { status: "error" };

type AutoLocateState = "idle" | "loading" | "failed";

/** Heuristic for "is this region in South Korea" — used only to decide whether to offer the
 *  Korean-holidays chip. Prefers the resolved IANA zone (exact); falls back to the geocode
 *  label's country name when the zone lookup hasn't resolved yet. */
function isKoreaRegion(label: string, timeZone: string | null): boolean {
  if (timeZone) return timeZone === "Asia/Seoul";
  return /대한민국|South Korea|Corée du Sud/i.test(label);
}

/** Last IANA zone segment as a city guess ("Asia/Seoul" -> "Seoul"). Zones with no city part
 *  (UTC, Etc/*) return null — there's nothing meaningful to geocode. */
function deviceCityGuess(): string | null {
  let zone: string;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (!zone || zone === "UTC" || zone.startsWith("Etc/")) return null;
  const city = (zone.split("/").pop() ?? "").replace(/_/g, " ").trim();
  return city || null;
}

/** Intl throws for a garbage IANA name — validated once when the lookup resolves (see the effect
 *  below), so a render-time call here is expected to succeed; the try/catch is just cheap
 *  insurance against a locale/timeZone combo Intl rejects for a reason unrelated to the lookup. */
function formatLocalTime(timeZone: string, uiLang: string): string | null {
  try {
    return new Intl.DateTimeFormat(uiLang || "ko", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
      new Date()
    );
  } catch {
    return null;
  }
}

/**
 * Plan §2 "2/4 지역" right column (PLAN-2026-09-28-onboarding-rebuild.md). The shell owns the
 * footer (이전 / 이대로 설정할게요) and persisting the final selection — this only tracks the
 * search→pick draft and previews local time/weather/map-center for it.
 */
export function OnboardingRegionStep({
  onSelectionChange,
}: {
  onSelectionChange: (s: RegionSelection | null) => void;
}) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const holidayRegion = useSettingsStore((s) => s.holidayRegion);
  const [searchQuery, setSearchQuery] = useState("");
  const [selection, setSelection] = useState<RegionSelection | null>(null);
  const [tz, setTz] = useState<TzState>({ status: "idle" });
  const [weather, setWeather] = useState<WeatherState>({ status: "idle" });
  const [autoStatus, setAutoStatus] = useState<AutoLocateState>("idle");
  const [, forceTick] = useState(0);
  // Bumped on every auto-locate attempt and on any manual search/pick, so a late auto response
  // that lands after the user has already typed or picked something else is ignored.
  const autoReqRef = useRef(0);

  // Once a result is picked the input just displays its label — no need to keep geocoding it.
  const {
    results: searchResults,
    searching,
    unavailable: searchUnavailable,
  } = useGeocodeSearch(selection ? "" : searchQuery, uiLang);

  // Selection changed (including cleared to null): drop any in-flight tz/weather request for the
  // previous pick so a slow response to A can never render under B (plan §2 staleness rule).
  useEffect(() => {
    if (!selection) {
      setTz({ status: "idle" });
      setWeather({ status: "idle" });
      return;
    }
    let cancelled = false;
    const { lat, lng } = selection;
    setTz({ status: "loading" });
    setWeather({ status: "loading" });

    // Optional lookup, no toast on failure — callSilent(...).catch(...) per invoke.ts contract.
    void callSilent<{ time_zone: string | null }>("geo_timezone", { lat, lng })
      .catch(() => null)
      .then((res) => {
        if (cancelled) return;
        const timeZone = res?.time_zone ?? null;
        if (!timeZone) {
          reportFallback("onboarding", "region_timezone_unavailable", res ? "null_time_zone" : "lookup_failed");
          setTz({ status: "error" });
          return;
        }
        if (!formatLocalTime(timeZone, uiLang)) {
          reportFallback("onboarding", "region_timezone_invalid", timeZone);
          setTz({ status: "error" });
          return;
        }
        setTz({ status: "ok", timeZone });
      });

    // fetchWeather never throws and already reports its own fallback on failure — null just means
    // "unavailable", never blocks region confirmation.
    void fetchWeather({ lat, lng }).then((snap) => {
      if (cancelled) return;
      setWeather(snap ? { status: "ok", snapshot: snap } : { status: "error" });
    });

    return () => {
      cancelled = true;
    };
  }, [selection, uiLang]);

  // Re-render once a minute so the displayed local time stays live — only while a selection with
  // a resolved time zone is actually mounted-visible; no timer runs with nothing to show.
  useEffect(() => {
    if (tz.status !== "ok") return;
    const id = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [tz.status]);

  const clearSelection = () => {
    setSelection(null);
    onSelectionChange(null);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    autoReqRef.current++; // invalidate any in-flight auto-locate
    setAutoStatus("idle");
    setSearchQuery(e.target.value);
    if (selection) clearSelection();
  };

  const handleClearSearch = () => {
    autoReqRef.current++;
    setAutoStatus("idle");
    setSearchQuery("");
    if (selection) clearSelection();
  };

  const handlePick = (item: GeocodeResultItem) => {
    const sel: RegionSelection = { label: item.label, lat: item.lat, lng: item.lng };
    setSelection(sel);
    setSearchQuery(item.label);
    setAutoStatus("idle");
    onSelectionChange(sel);
  };

  const handleAutoLocate = async () => {
    const city = deviceCityGuess();
    const reqId = ++autoReqRef.current;
    if (!city) {
      reportFallback("onboarding", "region_auto_no_city", "no_iana_city");
      setAutoStatus("failed");
      return;
    }
    setAutoStatus("loading");
    const res = await callSilent<{ results: GeocodeResultItem[] }>("geocode_search", {
      query: city,
      lang: uiLang || "ko",
    }).catch(() => null); // silent-ok: optional lookup, failure just falls back to manual search
    if (reqId !== autoReqRef.current) return; // stale: user picked/typed something else meanwhile
    const first = res?.results?.[0];
    if (!first) {
      reportFallback("onboarding", "region_auto_no_results", city);
      setAutoStatus("failed");
      return;
    }
    handlePick(first);
  };

  const timeDisplay =
    tz.status === "ok"
      ? formatLocalTime(tz.timeZone, uiLang) ?? t("onboarding.region_time_unavailable")
      : tz.status === "loading"
        ? t("common.loading")
        : t("onboarding.region_time_unavailable");

  // 날씨 카드: 값(온도·상태) 과 아이콘을 따로 — 카드는 "아이콘 | 굵은 값 / 흐린 설명" 구조다.
  let weatherIcon: React.ReactNode = <IconWeather size={18} />;
  let weatherColor: string | undefined;
  let weatherText: string;
  if (weather.status === "loading") {
    weatherText = t("onboarding.region_weather_loading");
  } else if (weather.status === "ok") {
    const { Icon, colorVar } = weatherCodeToVisual(weather.snapshot.weatherCode);
    weatherIcon = <Icon size={18} />;
    weatherColor = colorVar;
    weatherText = `${weather.snapshot.tempC}° · ${t(weather.snapshot.labelKey)}`;
  } else {
    weatherText = t("onboarding.region_weather_unavailable");
  }

  const mapCenterLabel = selection ? selection.label.split(",")[0].trim() : "";
  const isKorea = selection ? isKoreaRegion(selection.label, tz.status === "ok" ? tz.timeZone : null) : false;

  return (
    <div className="ob-page">
      <div>
        <h2 className="ob-title">{t("onboarding.region_heading")}</h2>
        <p className="ob-sub">{t("onboarding.region_desc")}</p>
        <p className="ob-hint" style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--faint)" }}>
          {t("onboarding.region_privacy")}
        </p>
      </div>

      <div className="ob-group" style={{ gap: "var(--space-3)" }}>
        <div className="ob-search">
          <div style={{ position: "relative", display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
            <span
              style={{
                position: "absolute",
                left: "var(--space-4)",
                color: "var(--faint)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconSearch size={16} />
            </span>
            <input
              type="text"
              className="field"
              value={searchQuery}
              onChange={handleInputChange}
              placeholder={t("onboarding.region_search_placeholder")}
              data-testid="onboarding-region-search-input"
              style={{ paddingLeft: "calc(var(--space-8) + var(--space-3))", paddingRight: "calc(var(--space-8) + var(--space-3))", width: "100%" }}
            />
            {searchQuery !== "" && (
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label={t("onboarding.region_clear_search")}
                data-testid="onboarding-region-clear-search"
                style={{
                  position: "absolute",
                  right: "var(--space-3)",
                  display: "grid",
                  placeItems: "center",
                  background: "none",
                  border: "none",
                  padding: "var(--space-1)",
                  color: "var(--faint)",
                  cursor: "pointer",
                }}
              >
                <IconClose size={16} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn--lg"
            onClick={handleAutoLocate}
            disabled={autoStatus === "loading"}
            aria-label={t("onboarding.region_auto_btn")}
            title={t("onboarding.region_auto_btn")}
            data-testid="onboarding-region-auto-btn"
            style={{ opacity: autoStatus === "loading" ? 0.6 : 1 }}
          >
            <IconCompass size={18} />
          </button>
        </div>

        {autoStatus === "failed" && (
          <div data-testid="onboarding-region-auto-failed" className="ob-hint ob-hint--warn">
            {t("onboarding.region_auto_failed")}
          </div>
        )}

        {!selection && searchQuery.trim() !== "" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            {searching && <div className="ob-hint">{t("common.loading")}</div>}
            {searchUnavailable && <div className="ob-hint ob-hint--warn">{t("note.search_unavailable")}</div>}
            {!searching && !searchUnavailable && searchResults.length === 0 && (
              <div className="ob-hint" style={{ color: "var(--faint)" }}>
                {t("onboarding.region_no_results")}
              </div>
            )}
            {!searching && searchResults.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-1)",
                  border: "1px solid var(--divider)",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--space-1)",
                }}
              >
                {searchResults.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="menu-row menu-item"
                    onClick={() => handlePick(item)}
                    data-testid="onboarding-region-result"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      padding: "var(--space-2) var(--space-3)",
                      fontSize: "var(--text-sm)",
                      textAlign: "left",
                    }}
                  >
                    <IconMapPin size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {selection && (
        <div className="ob-group" style={{ gap: "var(--space-4)" }}>
          <div className="ob-preview-head">
            <span className="badge ob-pill" data-tone="accent">{t("onboarding.preview_pill")}</span>
            <span className="ob-hint">{t("onboarding.region_preview_note")}</span>
          </div>

          <div data-testid="onboarding-region-preview" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {/* 세 미리보기 카드 — 같은 폭, 가는 연결선으로 이어진다. */}
            <div className="ob-preview-cards">
              <div className="ob-pcard" title={t("onboarding.region_time_label")} data-testid="onboarding-region-time">
                <span className="ob-pcard-icon">
                  <IconClock size={18} />
                </span>
                <span className="ob-pcard-body">
                  <span className="ob-pcard-val">{timeDisplay}</span>
                  <span className="ob-pcard-cap">{t("onboarding.region_time_caption")}</span>
                </span>
              </div>
              <span className="ob-pconn" aria-hidden="true" />
              <div className="ob-pcard" title={t("onboarding.region_weather_label")} data-testid="onboarding-region-weather">
                <span className="ob-pcard-icon" style={weatherColor ? { color: weatherColor } : undefined}>
                  {weatherIcon}
                </span>
                <span className="ob-pcard-body">
                  <span className="ob-pcard-val">{weatherText}</span>
                  <span className="ob-pcard-cap">{t("onboarding.region_weather_caption")}</span>
                </span>
              </div>
              <span className="ob-pconn" aria-hidden="true" />
              <div className="ob-pcard" title={t("onboarding.region_map_label")}>
                <span className="ob-pcard-icon">
                  <IconMapPin size={18} />
                </span>
                <span className="ob-pcard-body">
                  <span className="ob-pcard-val">{t("onboarding.region_map_center", { label: mapCenterLabel })}</span>
                  <span className="ob-pcard-cap">{t("onboarding.region_map_caption")}</span>
                </span>
              </div>
            </div>
            {isKorea && (
              <button
                type="button"
                className="chip-btn"
                style={{ alignSelf: "flex-start" }}
                data-active={holidayRegion === "kr" ? "true" : undefined}
                data-testid="onboarding-region-holiday-toggle"
                onClick={() => {
                  void useSettingsStore
                    .getState()
                    .setHolidayRegion(holidayRegion === "kr" ? "none" : "kr"); // setSimplePref already rolls back on failure
                }}
              >
                {holidayRegion === "kr" ? <IconCheckMark size={13} /> : <IconCalendar size={13} />}
                {t("onboarding.region_holiday_chip")}
              </button>
            )}
          </div>

          <div
            data-testid="onboarding-region-caption"
            className="ob-hint"
            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
          >
            <span style={{ display: "grid", placeItems: "center", color: "var(--accent)" }}>
              <IconCheckMark size={14} />
            </span>
            {t("onboarding.region_meaning_caption")}
          </div>
        </div>
      )}
    </div>
  );
}
