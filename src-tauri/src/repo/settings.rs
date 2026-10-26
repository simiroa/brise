// repo: settings — commands/settings.yaml. 키 SSOT: db/schemas/settings.sql 주석.
use crate::error::{db as dberr, io, AppResult};
use crate::repo::settings_schema;
use crate::repo::folders;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// 미설정 키는 기본값을 채워 반환.
///
/// 세 겹(docs/PLAN-2026-09-19-notebook-settings.md §3): 기본값 → 전역 `settings` → 활성 노트북의
/// `workspace_settings`. 노트북 키(`settings_schema::NOTEBOOK_KEYS`)는 **전역 행을 보지 않는다** —
/// 새 노트북은 행이 없어 기본값으로 시작해야 하는데(오너 결정), 어딘가에 남은 전역 행이 있으면 그
/// 값이 모든 새 노트북에 새어 들어간다. 소비처(프런트 스토어·Rust 의 AI/알림/트레이…)는 이 한 함수만
/// 읽으므로 노트북 전환을 따로 알 필요가 없다.
pub fn get_all(conn: &Connection) -> AppResult<BTreeMap<String, Value>> {
    let mut map: BTreeMap<String, Value> = BTreeMap::new();
    // 기본값 시드.
    let ws = folders::active_workspace_id(conn).unwrap_or_default();
    for (k, v) in settings_schema::default_settings(&ws) {
        let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::Null);
        map.insert(k.to_string(), parsed);
    }
    // 저장된 전역 값으로 덮어쓰기(노트북 키 제외).
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(dberr)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(dberr)?;
    for row in rows {
        let (k, v) = row.map_err(dberr)?;
        if settings_schema::is_notebook_setting_key(&k) {
            continue;
        }
        let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
        map.insert(k, parsed);
    }
    // 활성 노트북 값으로 덮어쓰기.
    for (k, v) in notebook_rows(conn, &ws)? {
        if !settings_schema::is_notebook_setting_key(&k) {
            continue;
        }
        let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::String(v));
        map.insert(k, parsed);
    }
    Ok(map)
}

/// 한 노트북에 저장된 설정 행(raw JSON 텍스트) — 번들 내보내기·복사가 쓴다.
pub fn notebook_rows(conn: &Connection, workspace_id: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM workspace_settings WHERE workspace_id=?1 ORDER BY key")
        .map_err(dberr)?;
    let rows = stmt
        .query_map([workspace_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok(rows)
}

/// `get_all()`의 "활성 노트북 값으로 덮어쓰기" 단계를, 활성 노트북이 아닌 임의의 workspace_id
/// 하나·키 하나에 대해서만 수행한다 — 노트가 속한 **폴더**의 노트북이 활성 노트북과 다를 수 있는
/// 호출부용(예: repo::notes::create_today_default — AI 디스패치·가져오기·동기화 HTTP 핸들러가 활성이
/// 아닌 노트북의 폴더에 노트를 만들 수 있다). get_all 과 같은 이유로 전역 `settings` 테이블은 보지
/// 않는다(노트북 키는 전역 행을 보지 않는다는 규약, 위 get_all 주석 참고). 저장된 행이 없거나 JSON
/// 파싱에 실패하면 None — 기본값 결정과 shape 검증은 호출부 책임이다: 이 함수는
/// `settings_schema::NOTEBOOK_KEYS`/`default_settings`를 전혀 참조하지 않으므로, 아직 그 허용목록에
/// 등록되지 않은 키(예: 2026-09-20 실험 기능의 노트 기본값 두 키)에도 그대로 쓸 수 있다.
pub fn notebook_setting_raw(conn: &Connection, workspace_id: &str, key: &str) -> AppResult<Option<Value>> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM workspace_settings WHERE workspace_id=?1 AND key=?2",
            params![workspace_id, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(dberr)?;
    Ok(stored.and_then(|v| serde_json::from_str(&v).ok()))
}

/// 새 노트북 만들기의 "설정만 현재 노트북에서 복사"(PLAN §7 Q4) — `to` 의 행을 `from` 의 사본으로 바꾼다.
pub fn copy_notebook_settings(conn: &Connection, from: &str, to: &str) -> AppResult<()> {
    conn.execute("DELETE FROM workspace_settings WHERE workspace_id=?1", [to])
        .map_err(dberr)?;
    conn.execute(
        "INSERT INTO workspace_settings(workspace_id, key, value)
         SELECT ?2, key, value FROM workspace_settings WHERE workspace_id=?1",
        params![from, to],
    )
    .map_err(dberr)?;
    Ok(())
}

/// 동기화 준비(G3) — 기기 식별자. DB 부팅 시 없으면 1회 생성해 저장한다(examples_seeded/
/// onboarding_completed 백필과 동일하게 validate_setting/settings_set 을 우회하는 직접 기록 —
/// 사용자가 바꿀 수 있는 값이 아니므로 settings_set 진입점으로는 노출하지 않는다). 아직 이
/// 값을 읽는 곳은 없다(향후 Phase 2 동기화가 기기 식별에 사용).
pub fn ensure_device_id(conn: &Connection) -> AppResult<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM settings WHERE key='device_id'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if exists {
        return Ok(());
    }
    let id = crate::util::new_id();
    let json = serde_json::to_string(&id).unwrap_or_else(|_| "null".to_string());
    conn.execute(
        "INSERT OR IGNORE INTO settings(key, value) VALUES ('device_id', ?1)",
        params![json],
    )
    .map_err(dberr)?;
    Ok(())
}

/// 부분 업데이트 — 제공 키만. 알 수 없는 키/타입·범위 위반 시 VALIDATION (검증 후 커밋).
///
/// 노트북 키는 활성 노트북의 `workspace_settings` 로, 나머지는 전역으로 간다. 전역을 먼저 쓰고
/// 활성 노트북을 **그 뒤에** 읽는다 — 한 호출에 `active_workspace_id` 와 노트북 키가 같이 오면
/// 노트북 키는 새로 활성이 된 노트북에 쓰인다.
pub fn set(conn: &mut Connection, entries: &BTreeMap<String, Value>) -> AppResult<bool> {
    for (k, v) in entries {
        settings_schema::validate_setting(k, v)?;
    }
    let tx = conn.transaction().map_err(dberr)?;
    for (k, v) in entries.iter().filter(|(k, _)| !settings_schema::is_notebook_setting_key(k)) {
        let json = serde_json::to_string(v).unwrap_or_else(|_| "null".to_string());
        tx.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![k, json],
        )
        .map_err(dberr)?;
    }
    let mut notebook = entries.iter().filter(|(k, _)| settings_schema::is_notebook_setting_key(k)).peekable();
    if notebook.peek().is_some() {
        let ws = folders::active_workspace_id(&tx)?;
        for (k, v) in notebook {
            let json = serde_json::to_string(v).unwrap_or_else(|_| "null".to_string());
            tx.execute(
                "INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value",
                params![ws, k, json],
            )
            .map_err(dberr)?;
        }
    }
    tx.commit().map_err(dberr)?;
    Ok(true)
}

// Settings redesign (Données ①): DB-only 통계. 폴더 크기(attachments_size_bytes/image_size_bytes)는
// 파일시스템 walk 이 필요해 여기 넣지 않는다 — commands::settings::db_stats 가 DB 락을 놓은 뒤 별도로
// dir_sizes() 를 호출해 합친다(attachments.rs:174-178 의 실측 교훈과 동일: 동기 커맨드에서 DB 락을
// 쥔 채 디스크 I/O 를 하면 다른 모든 커맨드가 그 시간만큼 막힌다).
#[derive(Debug, Serialize)]
pub struct DbStats {
    pub note_count: i64,
    pub attachment_count: i64,
    /// "사용 N일" — 노트가 하나라도 작성된 날짜 수(created_at 기준). 노트 개수가 아니라 날짜 수.
    pub distinct_note_days: i64,
    pub db_size_bytes: i64,
}

pub fn stats(conn: &Connection) -> AppResult<DbStats> {
    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .map_err(dberr)?;
    let attachment_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
        .map_err(dberr)?;
    let distinct_note_days: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT date(created_at)) FROM notes",
            [],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    let page_count: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(dberr)?;
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(dberr)?;
    Ok(DbStats {
        note_count,
        attachment_count,
        distinct_note_days,
        db_size_bytes: page_count * page_size,
    })
}

/// data_dir/attachments/ 를 한 번 walk 해 총 바이트와 이미지로 분류된 바이트를 함께 집계한다.
/// 확장자 기준 분류(attachments::kind_from_ext)를 쓴다 — DB의 kind 컬럼을 따로 조회하지 않는
/// 이유: 썸네일(`{rel_path}.thumb.jpg`)은 DB 행이 없는 파생 파일이라 kind 컬럼으로는 못 잡지만
/// 실제로는 디스크를 차지하고, 확장자로 보면 자연히 이미지 버킷에 들어가 image <= total 불변식이
/// 항상 성립한다(원본+썸네일 모두 이미지 확장자).
pub fn dir_sizes(data_dir: &Path) -> AppResult<(i64, i64)> {
    let dir = crate::db::attachments_dir(data_dir);
    let mut total = 0i64;
    let mut image = 0i64;
    walk_sizes(&dir, &mut total, &mut image)?;
    Ok((total, image))
}

/// data_dir 이 있는 볼륨의 여유 공간. OS 호출 실패(경로 없음 등)는 None — 게이지가 바 없이 숫자만 보인다.
pub fn disk_free_bytes(data_dir: &Path) -> Option<i64> {
    // Windows 는 없는 경로도 상위 볼륨으로 답하므로 exists() 로 플랫폼 간 계약을 맞춘다.
    if !data_dir.exists() {
        return None;
    }
    fs4::available_space(data_dir).ok().map(|v| v as i64)
}

fn walk_sizes(dir: &Path, total: &mut i64, image: &mut i64) -> AppResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(io)? {
        let entry = entry.map_err(io)?;
        let path = entry.path();
        if path.is_dir() {
            walk_sizes(&path, total, image)?;
            continue;
        }
        let len = entry.metadata().map_err(io)?.len() as i64;
        *total += len;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if crate::repo::attachments::kind_from_ext(ext) == "image" {
            *image += len;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::util::new_id;
    use rusqlite::params;

    fn seed_note(conn: &Connection, id: &str, title: &str, created_at: &str) {
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status)
             VALUES (?1, ?2, ?3, 2000, 0, NULL, ?4, ?4, NULL, NULL)",
            params![id, folder_id, title, created_at],
        )
        .unwrap();
    }

    /// "사용 N일" = 노트가 있는 날짜 수, 노트 개수가 아니다 — 같은 날 2개를 써도 1로 세야 한다.
    #[test]
    fn distinct_note_days_counts_dates_not_notes() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        seed_note(&conn, &new_id(), "a", "2026-01-01T09:00:00Z");
        seed_note(&conn, &new_id(), "b", "2026-01-01T18:00:00Z"); // 같은 날 — 중복
        seed_note(&conn, &new_id(), "c", "2026-01-03T09:00:00Z");

        let s = stats(&conn).unwrap();
        assert_eq!(s.note_count, 3);
        assert_eq!(s.distinct_note_days, 2, "same-day notes must collapse to one day");
    }

    #[test]
    fn dir_sizes_classifies_images_by_extension_and_stays_within_total() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let att = db::attachments_dir(data_dir);
        let note_dir = att.join("note1");
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(note_dir.join("photo.png"), vec![0u8; 100]).unwrap();
        std::fs::write(note_dir.join("photo.png.thumb.jpg"), vec![0u8; 10]).unwrap();
        std::fs::write(note_dir.join("report.pdf"), vec![0u8; 50]).unwrap();

        let (total, image) = dir_sizes(data_dir).unwrap();
        assert_eq!(total, 160);
        assert_eq!(image, 110, "original png + its jpg thumbnail both count as image");
        assert!(image <= total);
    }

    #[test]
    fn dir_sizes_is_zero_when_attachments_dir_absent() {
        let dir = tempfile::tempdir().unwrap();
        let (total, image) = dir_sizes(dir.path()).unwrap();
        assert_eq!((total, image), (0, 0));
    }

    #[test]
    fn disk_free_bytes_is_positive_for_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(disk_free_bytes(dir.path()).unwrap() > 0);
    }

    #[test]
    fn disk_free_bytes_is_none_for_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(disk_free_bytes(&dir.path().join("nope")), None);
    }

    fn switch_to(conn: &mut Connection, ws: &str) {
        let mut e = BTreeMap::new();
        e.insert("active_workspace_id".to_string(), Value::String(ws.to_string()));
        set(conn, &e).unwrap();
    }

    fn put(conn: &mut Connection, key: &str, v: Value) {
        let mut e = BTreeMap::new();
        e.insert(key.to_string(), v);
        set(conn, &e).unwrap();
    }

    /// PLAN-2026-09-19-notebook-settings: 노트북 키는 노트북마다 따로, 전역 키는 공유.
    /// 새 노트북은 기본값으로 시작한다(다른 노트북 값이 새지 않는다).
    #[test]
    fn notebook_keys_follow_the_active_notebook_and_global_keys_do_not() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let a = folders::active_workspace_id(&conn).unwrap();
        put(&mut conn, "theme", Value::String("dark".into()));
        put(&mut conn, "week_start", Value::String("monday".into()));
        put(&mut conn, "close_to_tray", Value::Bool(false));

        let b = crate::repo::workspaces::create(&mut conn, "B").unwrap().id;
        switch_to(&mut conn, &b);
        let s = get_all(&conn).unwrap();
        assert_eq!(s["theme"], Value::String("system".into()), "new notebook starts at defaults");
        assert_eq!(s["week_start"], Value::String("sunday".into()));
        assert_eq!(s["close_to_tray"], Value::Bool(false), "global keys are shared");

        put(&mut conn, "theme", Value::String("light".into()));
        switch_to(&mut conn, &a);
        let s = get_all(&conn).unwrap();
        assert_eq!(s["theme"], Value::String("dark".into()), "A keeps its own theme");
        assert_eq!(s["week_start"], Value::String("monday".into()));
        switch_to(&mut conn, &b);
        assert_eq!(get_all(&conn).unwrap()["theme"], Value::String("light".into()));
    }

    /// 한 호출에 active_workspace_id 와 노트북 키가 같이 오면 노트북 키는 **새** 노트북에 쓰인다.
    #[test]
    fn notebook_keys_in_the_same_call_as_a_switch_land_in_the_new_notebook() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let a = folders::active_workspace_id(&conn).unwrap();
        let b = crate::repo::workspaces::create(&mut conn, "B").unwrap().id;
        let mut e = BTreeMap::new();
        e.insert("active_workspace_id".to_string(), Value::String(b.clone()));
        e.insert("theme".to_string(), Value::String("light".into()));
        set(&mut conn, &e).unwrap();
        assert_eq!(
            notebook_rows(&conn, &b).unwrap(),
            vec![("theme".to_string(), r#""light""#.to_string())]
        );
        assert!(notebook_rows(&conn, &a).unwrap().is_empty());
    }

    /// 어딘가 남은 전역 노트북 키 행(옛 가져오기 등)은 무시된다 — 새 노트북에 새면 격리가 깨진다.
    #[test]
    fn stray_global_rows_for_notebook_keys_are_ignored() {
        let data_dir = tempfile::tempdir().unwrap();
        let conn = db::bootstrap(data_dir.path()).unwrap();
        conn.execute(r#"INSERT OR REPLACE INTO settings(key, value) VALUES ('theme', '"dark"')"#, [])
            .unwrap();
        assert_eq!(get_all(&conn).unwrap()["theme"], Value::String("system".into()));
    }

    /// 새 노트북 만들기의 "설정만 복사" — 원본 노트북 값을 그대로 가져가되, 이후로는 따로 논다.
    #[test]
    fn create_with_settings_copies_then_diverges() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let a = folders::active_workspace_id(&conn).unwrap();
        put(&mut conn, "theme", Value::String("dark".into()));
        put(&mut conn, "ui_lang", Value::String("fr".into()));

        let b = crate::repo::workspaces::create_with_settings(&mut conn, "B", Some(&a)).unwrap().id;
        assert_eq!(notebook_rows(&conn, &b).unwrap(), notebook_rows(&conn, &a).unwrap());

        switch_to(&mut conn, &b);
        put(&mut conn, "theme", Value::String("light".into()));
        switch_to(&mut conn, &a);
        assert_eq!(get_all(&conn).unwrap()["theme"], Value::String("dark".into()));
    }

    /// 노트북을 지우면 그 설정 행도 사라진다(CASCADE).
    #[test]
    fn deleting_a_notebook_drops_its_settings() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(data_dir.path()).unwrap();
        let a = folders::active_workspace_id(&conn).unwrap();
        put(&mut conn, "theme", Value::String("dark".into()));
        let b = crate::repo::workspaces::create_with_settings(&mut conn, "B", Some(&a)).unwrap().id;
        assert!(!notebook_rows(&conn, &b).unwrap().is_empty());
        crate::repo::workspaces::delete(&mut conn, data_dir.path(), &b).unwrap();
        assert!(notebook_rows(&conn, &b).unwrap().is_empty());
    }
}
