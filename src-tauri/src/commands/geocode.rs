// 커맨드: geocode (specs/commands/geocode.yaml)
use crate::error::AppError;
use crate::repo::geocode::{self, GeocodeResult};
use serde::Serialize;

#[derive(Serialize)]
pub struct GeocodeSearchOutput {
    pub results: Vec<GeocodeResult>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn geocode_search(
    query: String,
    lang: Option<String>,
) -> Result<GeocodeSearchOutput, AppError> {
    let results = geocode::geocode_search(&query, lang.as_deref()).await?;
    Ok(GeocodeSearchOutput { results })
}

#[derive(Serialize)]
pub struct GeocodeReverseOutput {
    pub label: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn geocode_reverse(
    lat: f64,
    lng: f64,
    lang: Option<String>,
) -> Result<GeocodeReverseOutput, AppError> {
    let label = geocode::geocode_reverse(lat, lng, lang.as_deref()).await?;
    Ok(GeocodeReverseOutput { label })
}

#[derive(Serialize)]
pub struct GeoTimezoneOutput {
    pub time_zone: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn geo_timezone(lat: f64, lng: f64) -> Result<GeoTimezoneOutput, AppError> {
    // 첫 호출은 내장 경계 데이터(수 MB)를 디코드한다 — 비동기 런타임 스레드를 막지 않게 분리.
    let time_zone = tauri::async_runtime::spawn_blocking(move || geocode::geo_timezone(lat, lng))
        .await
        .map_err(|e| AppError::Io(format!("geo_timezone worker join error: {e}")))??;
    Ok(GeoTimezoneOutput { time_zone })
}
