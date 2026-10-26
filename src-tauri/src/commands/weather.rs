// 커맨드: weather (specs/commands/weather.yaml)
use crate::error::AppError;
use crate::repo::weather::{self, WeatherEntry};
use serde::Serialize;

#[derive(Serialize)]
pub struct WeatherForecastOutput {
    pub entries: Vec<WeatherEntry>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn weather_forecast(lat: f64, lng: f64) -> Result<WeatherForecastOutput, AppError> {
    let entries = weather::weather_forecast(lat, lng).await?;
    Ok(WeatherForecastOutput { entries })
}
