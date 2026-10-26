// repo: weather (specs/commands/weather.yaml)
//
// met.no (Norwegian Meteorological Institute) locationforecast/2.0/compact — replaces Open-Meteo
// (2026-08-29): Open-Meteo's free tier is non-commercial-only, met.no is free for commercial use
// under CC-BY 4.0 (attribution shown in Settings→Weather, identifying User-Agent required below).
//
// Returns the flattened timeseries as-is (WeatherEntry, met.no's own symbol_code vocabulary) —
// mapping symbol_code -> WMO code is a frontend concern (src/lib/weather.ts), same split as
// geocode.rs (Rust fetches/parses, TS derives display concerns).
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WeatherEntry {
    pub time: String,
    pub temp_c: f64,
    pub symbol_1h: Option<String>,
    pub symbol_6h: Option<String>,
    pub temp_max_6h: Option<f64>,
    pub temp_min_6h: Option<f64>,
    // 상세 지표(브리핑 날씨 카드) — met.no 응답에 있을 때만 채운다. 없으면 직렬화에서 빠져 TS 에서 undefined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub humidity_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wind_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressure_hpa: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uv_index: Option<f64>,
    /// 강수량(mm) — next_1_hours 우선, 없으면 next_6_hours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precip_mm: Option<f64>,
    /// 강수 확률(%) — next_1/6/12_hours details 중 처음 있는 것.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precip_prob_pct: Option<f64>,
}

// ---- met.no response shape — only the fields we use, all lenient/Option so an unrecognized or
// missing field never fails the whole parse. ----
#[derive(Debug, Deserialize)]
struct MetNoResponse {
    properties: MetNoProperties,
}
#[derive(Debug, Deserialize)]
struct MetNoProperties {
    timeseries: Vec<MetNoTimeseriesEntry>,
}
#[derive(Debug, Deserialize)]
struct MetNoTimeseriesEntry {
    time: String,
    data: MetNoData,
}
#[derive(Debug, Deserialize)]
struct MetNoData {
    instant: MetNoInstant,
    next_1_hours: Option<MetNoNext1Hours>,
    next_6_hours: Option<MetNoNext6Hours>,
    next_12_hours: Option<MetNoNext12Hours>,
}
#[derive(Debug, Deserialize)]
struct MetNoNext12Hours {
    details: Option<MetNoPrecipDetails>,
}
#[derive(Debug, Default, Deserialize)]
struct MetNoPrecipDetails {
    precipitation_amount: Option<f64>,
    probability_of_precipitation: Option<f64>,
}
#[derive(Debug, Deserialize)]
struct MetNoInstant {
    details: MetNoInstantDetails,
}
#[derive(Debug, Default, Deserialize)]
struct MetNoInstantDetails {
    air_temperature: Option<f64>,
    relative_humidity: Option<f64>,
    wind_speed: Option<f64>,
    air_pressure_at_sea_level: Option<f64>,
    ultraviolet_index_clear_sky: Option<f64>,
}
#[derive(Debug, Deserialize)]
struct MetNoNext1Hours {
    summary: MetNoSummary,
    details: Option<MetNoPrecipDetails>,
}
#[derive(Debug, Deserialize)]
struct MetNoNext6Hours {
    summary: MetNoSummary,
    details: Option<MetNoNext6HoursDetails>,
}
#[derive(Debug, Default, Deserialize)]
struct MetNoSummary {
    symbol_code: Option<String>,
}
#[derive(Debug, Deserialize)]
struct MetNoNext6HoursDetails {
    air_temperature_max: Option<f64>,
    air_temperature_min: Option<f64>,
    precipitation_amount: Option<f64>,
    probability_of_precipitation: Option<f64>,
}

/// Pure parse (no network) so it's unit-testable against a fixture string. Entries without an
/// air_temperature reading are skipped — everything downstream (current/daily/hourly) needs a
/// temperature to be useful, and met.no's own tail entries sometimes omit it.
fn parse_timeseries(body: &str) -> AppResult<Vec<WeatherEntry>> {
    let parsed: MetNoResponse = serde_json::from_str(body)
        .map_err(|e| AppError::Io(format!("Failed to parse met.no response: {e}")))?;

    let mut entries = Vec::new();
    for item in parsed.properties.timeseries {
        let Some(temp_c) = item.data.instant.details.air_temperature else {
            continue;
        };
        let d = item.data.instant.details;
        let (symbol_1h, p1) = match item.data.next_1_hours {
            Some(n1) => (n1.summary.symbol_code, n1.details),
            None => (None, None),
        };
        let (symbol_6h, temp_max_6h, temp_min_6h, p6_mm, p6_prob) = match item.data.next_6_hours {
            Some(n6) => {
                let (max, min, mm, prob) = n6
                    .details
                    .map(|d| {
                        (
                            d.air_temperature_max,
                            d.air_temperature_min,
                            d.precipitation_amount,
                            d.probability_of_precipitation,
                        )
                    })
                    .unwrap_or((None, None, None, None));
                (n6.summary.symbol_code, max, min, mm, prob)
            }
            None => (None, None, None, None, None),
        };
        let p12_prob = item
            .data
            .next_12_hours
            .and_then(|n| n.details)
            .and_then(|d| d.probability_of_precipitation);
        let (p1_mm, p1_prob) = p1
            .map(|d| (d.precipitation_amount, d.probability_of_precipitation))
            .unwrap_or((None, None));
        entries.push(WeatherEntry {
            time: item.time,
            temp_c,
            symbol_1h,
            symbol_6h,
            temp_max_6h,
            temp_min_6h,
            humidity_pct: d.relative_humidity,
            wind_ms: d.wind_speed,
            pressure_hpa: d.air_pressure_at_sea_level,
            uv_index: d.ultraviolet_index_clear_sky,
            precip_mm: p1_mm.or(p6_mm),
            precip_prob_pct: p1_prob.or(p6_prob).or(p12_prob),
        });
    }
    Ok(entries)
}

pub async fn weather_forecast(lat: f64, lng: f64) -> AppResult<Vec<WeatherEntry>> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return Err(AppError::Validation(format!(
            "coordinate out of range: {lat}, {lng}"
        )));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;

    // met.no ToS asks for rounded coordinates (cache-friendly on their edge) — 4 decimals is
    // ~11m precision, plenty for a weather forecast.
    let url = format!(
        "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat:.4}&lon={lng:.4}"
    );

    let res = client
        .get(&url)
        .header("User-Agent", "BriseNoteApp/1.0 (https://github.com/simiroa/brise)")
        .send()
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;

    let status = res.status();
    if !status.is_success() {
        return Err(AppError::Io(format!("met.no HTTP {status}")));
    }

    let body = res
        .text()
        .await
        .map_err(|e| AppError::Io(format!("Failed to read met.no response: {e}")))?;

    parse_timeseries(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed real-shape met.no locationforecast/2.0/compact fixture: one full entry (instant +
    // next_1_hours + next_6_hours) and one tail entry with only `instant` (no summaries, no
    // air_temperature) to exercise the lenient-Option / skip-on-missing-temp paths.
    const FIXTURE: &str = r#"{
      "type": "Feature",
      "properties": {
        "timeseries": [
          {
            "time": "2026-08-29T12:00:00Z",
            "data": {
              "instant": { "details": { "air_temperature": 24.3, "relative_humidity": 48.5, "wind_speed": 2.1, "air_pressure_at_sea_level": 1014.2, "ultraviolet_index_clear_sky": 3.4 } },
              "next_1_hours": { "summary": { "symbol_code": "partlycloudy_day" }, "details": { "precipitation_amount": 0.2 } },
              "next_12_hours": { "summary": { "symbol_code": "rain" }, "details": { "probability_of_precipitation": 40.0 } },
              "next_6_hours": {
                "summary": { "symbol_code": "rain" },
                "details": { "air_temperature_max": 26.1, "air_temperature_min": 20.4 }
              }
            }
          },
          {
            "time": "2026-08-29T13:00:00Z",
            "data": { "instant": { "details": {} } }
          }
        ]
      }
    }"#;

    #[test]
    fn parse_timeseries_flattens_and_skips_entries_without_temperature() {
        let entries = parse_timeseries(FIXTURE).unwrap();
        assert_eq!(entries.len(), 1); // second entry has no air_temperature -> skipped

        let e = &entries[0];
        assert_eq!(e.time, "2026-08-29T12:00:00Z");
        assert_eq!(e.temp_c, 24.3);
        assert_eq!(e.symbol_1h.as_deref(), Some("partlycloudy_day"));
        assert_eq!(e.symbol_6h.as_deref(), Some("rain"));
        assert_eq!(e.temp_max_6h, Some(26.1));
        assert_eq!(e.temp_min_6h, Some(20.4));
        assert_eq!(e.humidity_pct, Some(48.5));
        assert_eq!(e.wind_ms, Some(2.1));
        assert_eq!(e.pressure_hpa, Some(1014.2));
        assert_eq!(e.uv_index, Some(3.4));
        assert_eq!(e.precip_mm, Some(0.2));
        assert_eq!(e.precip_prob_pct, Some(40.0));
    }

    #[tokio::test]
    async fn weather_forecast_rejects_out_of_range_coordinates() {
        let err = weather_forecast(91.0, 0.0).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let err = weather_forecast(0.0, 181.0).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
