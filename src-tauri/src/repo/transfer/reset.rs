// 데이터 초기화(db_reset) = "빈 상태로 복원". 예전엔 import::wipe() 의 손으로 관리하는 DELETE 목록을
// 돌렸는데, 새 테이블이 생길 때마다 목록이 뒤처져 suggestions·ai_usage·수집 소스 등이 초기화를 넘어
// 살아남았다(파일 쪽도 workspace_bg/ 는 아예 안 지웠다). 이제 갓 마이그레이션한 빈 DB 와 빈
// attachments/·workspace_bg/ 를 스테이징해 backup_restore 와 **같은 스왑**(swap::swap_live_state)으로
// 갈아끼운다 — 목록이 없으니 빠뜨릴 테이블도 없다. wipe() 는 replace 가져오기용으로 그대로 남는다.
use crate::db::{self, migrations};
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::util::new_id;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

use super::swap::{attachments_sibling, swap_live_state, Staged};

#[derive(Debug, Serialize)]
pub struct ResetResult {
    pub backup_path: String,
}

/// 호출자(commands::transfer::db_reset)는 backup_restore 처럼 `AppState::with_db_file_swap` 안에서
/// 불러야 한다 — 채팅 검색 읽기 연결이 brise.db 를 쥐고 있으면 Windows 가 파일 교체를 거부한다.
pub fn db_reset(conn: &mut Connection, data_dir: &Path, confirm: &str) -> AppResult<ResetResult> {
    if confirm != "RESET" {
        return Err(AppError::Validation("confirm must equal 'RESET'".to_string()));
    }
    let backup = db::snapshot_backup(conn, &db::backups_dir(data_dir))?;
    let staged = stage_empty(data_dir)?;
    // 비밀 설정(AI 키·키 보관함·동기화 토큰)은 이월하지 않는다 — 복원과 달리 초기화는 공장 상태가
    // 약속이다(옛 wipe 도 settings 를 통째로 지웠다). device_id 는 스왑이 새로 만든다. tombstone
    // (deleted_rows)도 새 DB 라 비어 있다 — wipe() 의 G2 주석("전체 교체 뒤 옛 tombstone 을 남기지
    // 않는다")과 같은 결론이다.
    swap_live_state(conn, data_dir, staged, &backup, &[], "reset")?;

    // 파생 캐시(slide_previews/)와 고아 청소 보류함(repo::orphan_hold, data_dir/orphaned/)도 지운다 —
    // 자동 청소와 달리 초기화는 사용자가 "RESET" 으로 확정한 전체 삭제라, 이전 첨부가 보류함에
    // 살아남으면 약속과 다르다. 스왑은 이미 끝났으므로 실패는 되돌리지 않고 기록만 한다.
    for (dir, label) in [
        (db::slide_cache_dir(data_dir), db::SLIDE_CACHE_DIR),
        (crate::repo::orphan_hold::hold_dir(data_dir), "orphaned"),
    ] {
        if dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                crate::diag::warn("backup", "reset_dir_remove_failed", format!("{label}: {e}"));
            }
        }
    }
    Ok(ResetResult {
        backup_path: backup.to_string_lossy().to_string(),
    })
}

/// 빈 상태 스테이징 — 새 파일 DB 에 전체 마이그레이션+시드(migrations::run 이 seed 까지 한다)와 빈
/// 첨부/배경 디렉토리. 실패 시 잔여물을 지우고 에러 — 라이브 상태는 아직 미동이다.
fn stage_empty(data_dir: &Path) -> AppResult<Staged> {
    let id = new_id();
    let staged = Staged {
        db_path: data_dir.join(format!("brise.reset-incoming-{id}.db")),
        att_path: attachments_sibling(data_dir, &format!("attachments.incoming-{id}")),
        bg_path: data_dir.join(format!("workspace_bg.incoming-{id}")),
    };
    let result = (|| -> AppResult<()> {
        let mut c = db::open(&staged.db_path)?;
        migrations::run(&mut c)?;
        // db::open 이 WAL 로 연다 — DELETE 저널로 되돌리면 체크포인트 후 -wal/-shm 이 사라져
        // rename 할 대상이 .db 한 파일이 된다(라이브 재오픈이 다시 WAL 로 켠다).
        c.pragma_update(None, "journal_mode", "DELETE").map_err(dberr)?;
        drop(c);
        std::fs::create_dir_all(&staged.att_path).map_err(io)?;
        std::fs::create_dir_all(&staged.bg_path).map_err(io)?;
        Ok(())
    })();
    if let Err(e) = result {
        staged.discard();
        return Err(e);
    }
    Ok(staged)
}

pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dst).map_err(io)?;
    for entry in std::fs::read_dir(src).map_err(io)? {
        let entry = entry.map_err(io)?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(io)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{collect, notes, tombstone, workspaces};
    use rusqlite::params;
    use std::collections::BTreeMap;

    /// 일반 테이블별 행 수 — sqlite_%·schema_migrations·FTS 섀도 테이블(가상 테이블 이름 + "_" 접두)은 뺀다.
    /// 가상 테이블 자체(notes_fts 등)는 COUNT 가 논리 행 수라 그대로 센다.
    fn table_counts(conn: &Connection) -> BTreeMap<String, i64> {
        let mut st = conn
            .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .unwrap();
        let rows: Vec<(String, Option<String>)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        let virtuals: Vec<String> = rows
            .iter()
            .filter(|(_, sql)| sql.as_deref().is_some_and(|s| s.to_uppercase().starts_with("CREATE VIRTUAL TABLE")))
            .map(|(n, _)| format!("{n}_"))
            .collect();
        rows.into_iter()
            .map(|(n, _)| n)
            .filter(|n| n != "schema_migrations" && !virtuals.iter().any(|v| n.starts_with(v.as_str())))
            .map(|n| {
                let c: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{n}\""), [], |r| r.get(0)).unwrap();
                (n, c)
            })
            .collect()
    }

    fn put(dir: &Path, rel: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    fn is_empty_dir(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().next().is_none()
    }

    /// 불변식: 초기화 뒤 DB 는 **갓 만든 DB 와 행 수까지 같다** — 시드가 만든 노트북 하나·폴더 하나·
    /// 기본 설정 행(+device_id)만 남고 나머지 모든 테이블은 비어 있다. 손으로 관리하던 DELETE 목록
    /// (import::wipe)이 새 테이블을 빠뜨려 suggestions·ai_usage·영수증 등이 초기화를 넘어 살아남았다.
    #[test]
    fn reset_leaves_exactly_a_fresh_db_and_empty_file_trees() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let mut conn = db::bootstrap(&data_dir).unwrap();

        let ws = workspaces::create(&mut conn, "둘째").unwrap();
        let folder: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let n = notes::create(&mut conn, &folder, Some("지워질 노트".into()), None).unwrap();
        let src = collect::create(&conn, &ws.id, "rss", "Feed", "{}").unwrap();
        assert!(collect::claim_seen(&conn, &src.id, "g1").unwrap());
        tombstone::record_tombstone(&conn, "notes", "gone").unwrap();
        conn.execute(
            "INSERT INTO suggestions(id, workspace_id, kind, note_id, related_note_id, status, created_at, updated_at)
             VALUES ('sg1', ?1, 'overlap', ?2, ?2, 'pending', '2026-01-01', '2026-01-01')",
            params![ws.id, n.note.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_usage(workspace_id, day, action_type, provider, calls) VALUES (?1, '2026-01-01', 'chat', 'ollama', 3)",
            params![ws.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_plan_action_receipts(execution_id, action_id, payload_hash, status, created_at)
             VALUES ('e1', 'a1', 'h', 'applied', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('ai_api_key', '\"sk-test\"')", []).unwrap();
        let old_device: String =
            conn.query_row("SELECT value FROM settings WHERE key='device_id'", [], |r| r.get(0)).unwrap();

        let att = db::attachments_dir(&data_dir);
        let bg = db::workspace_bg_dir(&data_dir);
        put(&att, &format!("{}/a.png", n.note.id));
        put(&bg, &format!("{}/bg.png", ws.id));
        put(&db::slide_cache_dir(&data_dir), "x/deck.pdf");
        put(&crate::repo::orphan_hold::hold_dir(&data_dir), "batch/a.png");

        let before = table_counts(&conn);
        for t in ["collect_sources", "collect_seen", "suggestions", "ai_usage", "ai_plan_action_receipts", "deleted_rows"] {
            assert!(before[t] > 0, "precondition: {t} seeded");
        }

        let out = db_reset(&mut conn, &data_dir, "RESET").unwrap();
        assert!(Path::new(&out.backup_path).exists(), "pre-reset snapshot is kept");

        // 기준선: 같은 마이그레이션으로 갓 만든 DB(+기기 id — 부팅이 늘 심는다).
        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        crate::repo::settings::ensure_device_id(&fresh).unwrap();
        // 스왑은 기기 로컬 동기화 키 두 행을 지운다(행이 없으면 get_all 이 같은 기본값으로 폴백 — swap_live_state).
        fresh.execute("DELETE FROM settings WHERE key IN ('sync_enabled', 'sync_token')", []).unwrap();
        let expected = table_counts(&fresh);
        let after = table_counts(&conn);
        let diff: Vec<_> = after.iter().filter(|(t, c)| expected.get(*t) != Some(c)).collect();
        assert!(diff.is_empty(), "tables differing from a fresh DB after reset: {diff:?} (fresh: {expected:?})");
        assert_eq!((after["workspaces"], after["folders"], after["notes"]), (1, 1, 0));

        // 비밀은 이월하지 않는다(초기화 = 공장 상태), device_id 는 새로 생긴다.
        let key: Option<String> =
            conn.query_row("SELECT value FROM settings WHERE key='ai_api_key'", [], |r| r.get(0)).ok();
        assert!(!key.unwrap_or_default().contains("sk-test"), "reset must not carry the AI key");
        let new_device: String =
            conn.query_row("SELECT value FROM settings WHERE key='device_id'", [], |r| r.get(0)).unwrap();
        assert_ne!(new_device, old_device);

        assert!(is_empty_dir(&att), "attachments/ must be empty after reset");
        assert!(is_empty_dir(&bg), "workspace_bg/ must be empty after reset");
        assert!(!db::slide_cache_dir(&data_dir).exists());
        assert!(!crate::repo::orphan_hold::hold_dir(&data_dir).exists());
        let leftovers: Vec<_> = std::fs::read_dir(&data_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".incoming-") || n.contains(".old-") || n.contains("-incoming-"))
            .collect();
        assert!(leftovers.is_empty(), "staging leftovers: {leftovers:?}");

        // 새 라이브 커넥션은 파일 DB 이고 쓸 수 있다.
        let folder: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        notes::create(&mut conn, &folder, Some("초기화 뒤".into()), None).unwrap();
        drop(conn);
        let reopened = db::open(&db::db_path(&data_dir)).unwrap();
        let c: i64 = reopened.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(c, 1, "the live connection after reset must be the on-disk brise.db");
    }

    #[test]
    fn reset_requires_confirm() {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::bootstrap(tmp.path()).unwrap();
        assert!(db_reset(&mut conn, tmp.path(), "reset").is_err());
    }
}
