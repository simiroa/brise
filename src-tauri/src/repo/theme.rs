// repo: theme — 모양(테마) 설정만 떼어 파일로 내보내고/읽고/기본값을 내준다.
// docs/PLAN-2026-09-19-theme-presets.md. 키 목록 SSOT 는 settings_schema::APPEARANCE_KEYS.
//
// 여기는 **쓰지 않는다.** 읽은 값은 프런트가 settings_set 한 번으로 쓴다 — 쓰기 초크포인트
// (검증 + 한 트랜잭션 + settings-changed 방송)를 하나로 유지하기 위해서다(§3).
use super::settings;
use super::settings_schema::{default_settings, is_appearance_setting_key, validate_setting};
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

pub const THEME_KIND: &str = "brise-theme";
pub const THEME_VERSION: i64 = 1;

#[derive(Debug, Serialize, PartialEq)]
pub struct ThemeRead {
    pub entries: BTreeMap<String, Value>,
    /// 테마 파일 안의 모르는 키 수 — 옛 빌드가 새 파일을 여는 경우. 번들에서 뽑을 때는 모양이
    /// 아닌 설정이 원래 잔뜩 들어 있으므로 세지 않는다(0).
    pub skipped_unknown: usize,
    /// "theme" | "bundle"
    pub source: &'static str,
}

/// 기본 모양 값 — default_settings 를 APPEARANCE_KEYS 로 거른 것(기본값 사본을 따로 두지 않는다).
pub fn defaults() -> BTreeMap<String, Value> {
    default_settings("")
        .into_iter()
        .filter(|(k, _)| is_appearance_setting_key(k))
        .map(|(k, v)| (k.to_string(), serde_json::from_str(&v).unwrap_or(Value::Null)))
        .collect()
}

/// 지금 DB 의 모양 값. 검증을 통과하지 못하는 옛 값(예: 리네임 전 surface_style "mica")은
/// 내보내지 않는다 — 내보낸 파일을 우리 자신이 다시 못 읽는 일을 막는다.
pub fn current(conn: &Connection) -> AppResult<BTreeMap<String, Value>> {
    let all = settings::get_all(conn)?;
    Ok(all
        .into_iter()
        .filter(|(k, v)| is_appearance_setting_key(k) && validate_setting(k, v).is_ok())
        .collect())
}

pub fn export(conn: &Connection, path: &Path) -> AppResult<()> {
    let body = json!({
        "kind": THEME_KIND,
        "version": THEME_VERSION,
        "settings": current(conn)?,
    });
    let text = serde_json::to_string_pretty(&body).map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::write(path, text).map_err(crate::error::io)
}

pub fn read(path: &Path) -> AppResult<ThemeRead> {
    let text = std::fs::read_to_string(path).map_err(crate::error::io)?;
    parse(&text)
}

/// 규칙표는 PLAN §2. 반만 적용하는 일은 없다 — 아는 키의 값이 하나라도 틀리면 전체 거부.
pub fn parse(text: &str) -> AppResult<ThemeRead> {
    let root: Value = serde_json::from_str(text)
        .map_err(|_| AppError::Validation("Not a Brise theme file (invalid JSON).".into()))?;
    let obj = root
        .as_object()
        .ok_or_else(|| AppError::Validation("Not a Brise theme file.".into()))?;

    let (raw, source): (Vec<(String, Value)>, &'static str) = if obj.get("kind").and_then(Value::as_str) == Some(THEME_KIND) {
        let version = obj.get("version").and_then(Value::as_i64).unwrap_or(0);
        if version > THEME_VERSION {
            return Err(AppError::Validation(format!(
                "This theme requires a newer version of Brise (theme format {version}, this app supports {THEME_VERSION}). Update Brise, then try importing again."
            )));
        }
        let settings = obj
            .get("settings")
            .and_then(Value::as_object)
            .ok_or_else(|| AppError::Validation("Theme file has no settings.".into()))?;
        (settings.iter().map(|(k, v)| (k.clone(), v.clone())).collect(), "theme")
    } else if let Some(rows) = bundle_settings(obj) {
        (rows, "bundle")
    } else {
        return Err(AppError::Validation("Not a Brise theme file.".into()));
    };

    let mut entries = BTreeMap::new();
    let mut skipped_unknown = 0;
    for (k, v) in raw {
        if !is_appearance_setting_key(&k) {
            if source == "theme" {
                skipped_unknown += 1;
            }
            continue;
        }
        validate_setting(&k, &v)?;
        entries.insert(k, v);
    }
    if entries.is_empty() {
        return Err(AppError::Validation("This file has no appearance settings.".into()));
    }
    Ok(ThemeRead { entries, skipped_unknown, source })
}

/// 전체 내보내기 번들(brise-bundle.json)의 `settings: [{ key, value }]` — value 는 JSON 으로
/// 인코딩된 **문자열**이다(bundle.rs::KvRow). 번들 모양이 아니면 None.
fn bundle_settings(obj: &Map<String, Value>) -> Option<Vec<(String, Value)>> {
    obj.get("version")?.as_i64()?;
    let rows = obj.get("settings")?.as_array()?;
    let mut out = Vec::new();
    for row in rows {
        let key = row.get("key")?.as_str()?;
        if !is_appearance_setting_key(key) {
            continue;
        }
        let parsed: Value = serde_json::from_str(row.get("value")?.as_str()?).ok()?;
        out.push((key.to_string(), parsed));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::settings_schema::APPEARANCE_KEYS;

    #[test]
    fn defaults_cover_every_appearance_key() {
        let d = defaults();
        assert_eq!(d.len(), APPEARANCE_KEYS.len());
        assert_eq!(d["theme"], json!("system"));
        assert_eq!(d["surface_style"], json!("flat"));
    }

    #[test]
    fn parses_theme_file_and_counts_unknown_keys() {
        let r = parse(r##"{"kind":"brise-theme","version":1,"settings":{"theme":"dark","accent":"#112233","future_knob":3}}"##).unwrap();
        assert_eq!(r.source, "theme");
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries["accent"], json!("#112233"));
        assert_eq!(r.skipped_unknown, 1);
    }

    #[test]
    fn rejects_whole_file_when_a_known_value_is_invalid() {
        let err = parse(r#"{"kind":"brise-theme","version":1,"settings":{"theme":"dark","bg_sat":999}}"#);
        assert!(err.is_err());
    }

    #[test]
    fn rejects_newer_format_version() {
        let err = parse(r#"{"kind":"brise-theme","version":2,"settings":{"theme":"dark"}}"#).unwrap_err();
        assert!(format!("{err:?}").contains("newer version of Brise"));
    }

    #[test]
    fn rejects_file_without_appearance_settings() {
        assert!(parse(r#"{"kind":"brise-theme","version":1,"settings":{"nope":1}}"#).is_err());
        assert!(parse(r#"{"hello":"world"}"#).is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn extracts_only_appearance_keys_from_an_export_bundle() {
        let bundle = r##"{"version":80,"workspaces":[],"settings":[
            {"key":"theme","value":"\"light\""},
            {"key":"sheet_alpha","value":"0.5"},
            {"key":"ai_provider","value":"\"ollama\""}
        ]}"##;
        let r = parse(bundle).unwrap();
        assert_eq!(r.source, "bundle");
        assert_eq!(r.skipped_unknown, 0);
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries["theme"], json!("light"));
        assert_eq!(r.entries["sheet_alpha"], json!(0.5));
    }

    #[test]
    fn export_round_trips_through_read() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        settings::set(&mut conn, &BTreeMap::from([("accent".to_string(), json!("#445566"))])).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mine.brise-theme.json");
        export(&conn, &path).unwrap();
        let r = read(&path).unwrap();
        assert_eq!(r.source, "theme");
        assert_eq!(r.skipped_unknown, 0);
        assert_eq!(r.entries.len(), APPEARANCE_KEYS.len());
        assert_eq!(r.entries["accent"], json!("#445566"));
    }
}
