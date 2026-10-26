// Commands: notifications — OS 알림 발화 한 줄(docs/PLAN-2026-08-25-space-widget-waves.md §3.3).
// 발화 경로는 repo::schedule::fire 와 같은 tauri-plugin_notification 빌더고, JS 플러그인 바인딩·
// capability 는 없다(앱 커맨드는 ACL 을 안 탄다 — Cargo.toml 의 기존 결정 유지). 새 OS 창을
// 만들지 않는다(§5 함정 체크리스트). http:false — OS 알림은 데스크톱 로컬 부수효과다
// (specs/commands/notifications.yaml).
use super::{AppState, Okay};
use crate::error::AppError;
use rusqlite::Connection;
use tauri::State;

/// notifications_enabled 마스터 스위치 판정 — repo::schedule::tick 이 쓰는 것과 **같은** 규칙
/// (같은 키 상수, as_bool, 기본 false). AppHandle 이 필요 없으므로 단위 테스트 대상이다.
fn notifications_enabled(conn: &Connection) -> bool {
    crate::repo::settings::get_all(conn)
        .ok()
        .and_then(|s| {
            s.get(crate::repo::schedule::NOTIFICATIONS_ENABLED_KEY)
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

/// 학습 타이머 등 위젯이 완료 시점에 부르는 알림. 스케줄 틱과 달리 여기가 발화 진입부이므로
/// 게이트를 커맨드 안에서 직접 본다. 꺼져 있으면 에러가 아니라 ok:false 로 조용히 억제한다 —
/// "알림 끔"은 사용자의 선택이지 실패가 아니다. 발화 자체의 실패(show() Err)도 승격하지 않는다:
/// repo::schedule::fire 가 그 결과를 무시하는 것과 같은 태도다(리마인더이지 돈이 아니다).
#[tauri::command(rename_all = "snake_case")]
pub fn notify_send(
    app: tauri::AppHandle,
    state: State<AppState>,
    title: String,
    body: String,
) -> Result<Okay, AppError> {
    let enabled = {
        let conn = state.db.lock();
        notifications_enabled(&conn)
    };
    if !enabled {
        return Ok(Okay { ok: false });
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(&title).body(&body).show();
    Ok(Okay { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use serde_json::json;

    fn setup() -> Connection {
        // get_all 은 활성 워크스페이스를 참조하므로 실제 bootstrap 마이그레이션을 쓴다
        // (repo::settings::get_all 의 시드+덮어쓰기 규칙을 그대로 검증하기 위함).
        let data_dir = tempfile::tempdir().unwrap();
        db::bootstrap(data_dir.path()).unwrap()
    }

    #[test]
    fn gated_off_by_default() {
        let conn = setup();
        // settings_schema 의 시드값이 false 다 — 마스터 스위치는 기본 꺼짐이다.
        assert!(!notifications_enabled(&conn));
    }

    #[test]
    fn enabled_flag_is_respected() {
        let mut conn = setup();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('notifications_enabled', 'true')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![],
        )
        .unwrap();
        assert!(notifications_enabled(&conn));

        conn.execute(
            "UPDATE settings SET value='false' WHERE key='notifications_enabled'",
            params![],
        )
        .unwrap();
        assert!(!notifications_enabled(&conn));
    }

    #[test]
    fn non_boolean_value_counts_as_disabled() {
        let conn = setup();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('notifications_enabled', '\"yes\"')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![],
        )
        .unwrap();
        // as_bool 이 아닌 값은 tick 과 동일하게 false 취급한다(방어적 일관성).
        assert!(!notifications_enabled(&conn));
    }

    #[test]
    fn okay_shape_matches_spec_output() {
        // specs/commands/notifications.yaml output {ok: boolean} — 공용 Okay 를 재사용한다.
        let serialized = serde_json::to_value(Okay { ok: true }).unwrap();
        assert_eq!(serialized, json!({ "ok": true }));
    }
}
