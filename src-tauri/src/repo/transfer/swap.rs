// repo::transfer::swap — 라이브 상태(DB + attachments/ + workspace_bg/)를 스테이징본으로 통째로 갈아끼우는 공용 부품.
// backup_restore(zip 에서 — backup.rs)와 db_reset(빈 상태 — reset.rs)이 같은 `swap_live_state` 를 쓰고, 교체 가져오기(import/replace_merge.rs)는
// 첨부 트리 하나에 `swap_tree` 를 쓴다. 예전엔 이 코드가 backup.rs 안에 있었고 reset.rs 가 그 내부를 집어 썼으며, 스테이징 정리 블록이
// 손으로 세 번 복사돼 있었다 — 한 곳으로 모은다. 실패 경로의 의미(live_db_touched, diag 코드, 프런트 App.tsx::diagNoticeMessage 가 읽는
// 알림 코드 db_connection_lost·swap_recovery_failed)는 이동 전과 같다.
use crate::db::{self, migrations};
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::util::new_id;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// 검증 통과 후 스왑에 쓸 준비된(스테이징) 경로들. 이 셋이 모두 채워진 뒤에야 라이브 상태를 건드린다.
/// backup_restore(zip 에서)와 db_reset(빈 DB 로 — reset.rs)이 같이 쓴다.
pub(super) struct Staged {
    pub(super) db_path: PathBuf,
    pub(super) att_path: PathBuf,
    pub(super) bg_path: PathBuf,
}

impl Staged {
    /// 스테이징 잔여물을 지운다(스테이징 실패·스왑 실패 양쪽) — 지워도 되는 사본이다(라이브는 별개 경로). DB 의 -wal/-shm 사이드카도
    /// 같이. 이미 없거나(스왑이 rename 해 갔거나) 못 지워도 할 수 있는 게 없어 조용히 넘어간다.
    pub(super) fn discard(&self) {
        let _ = std::fs::remove_file(&self.db_path); // silent-ok: 이미 rename 됐거나 없는 사본
        for ext in ["-wal", "-shm"] {
            let mut sidecar = self.db_path.clone().into_os_string();
            sidecar.push(ext);
            let _ = std::fs::remove_file(PathBuf::from(sidecar)); // silent-ok: 같은 이유
        }
        let _ = std::fs::remove_dir_all(&self.att_path); // silent-ok: 같은 이유
        let _ = std::fs::remove_dir_all(&self.bg_path); // silent-ok: 같은 이유
    }
}

/// 라이브 attachments/ 와 **같은 부모** 아래의 형제 경로 — 스테이징·옛 첨부 자리는 여기 둔다.
/// 저장 위치 재정의(db::set_dir_overrides)로 attachments/ 가 data_dir 밖(다른 볼륨)에 있으면
/// data_dir 쪽 자리로는 rename 이 볼륨을 건너 실패한다. 재정의가 없으면 부모 = data_dir 그대로.
pub(super) fn attachments_sibling(data_dir: &Path, name: &str) -> PathBuf {
    sibling_of(&db::attachments_dir(data_dir), data_dir, name)
}

/// `live` 와 같은 부모 아래의 형제 경로(부모가 없으면 `fallback_dir` 아래). `attachments_sibling` 의 순수 부분 —
/// 호출자가 이미 실제 첨부 경로(`db::attachments_dir`)를 들고 있으면(교체 가져오기) 전역 재정의를 다시 읽지 않고 이걸 쓴다.
pub(super) fn sibling_of(live: &Path, fallback_dir: &Path, name: &str) -> PathBuf {
    live.parent().unwrap_or(fallback_dir).join(name)
}

/// `staged` 트리를 `live` 자리로 올린다 — 라이브가 있으면 먼저 `old` 로 치운다(반환 = 그래서 `old` 에 옛 트리가 있는가).
/// 두 번째 rename(staged → live)이 실패하면 첫 rename 을 되돌려 라이브를 제자리로 돌려 놓으려 시도한다(되돌리기 실패는 옛 트리가
/// `old` 에 남아 있음을 diag 로 알린다). 어느 단계 실패든 `diag::error` 로 남긴다(`ctx` = "restore attachments" 같은 한 줄 — 이름만, 경로 금지).
/// 성공하면 호출자가 새 상태가 확정된 **뒤에** `discard_old_tree(old)` 로 옛 트리를 지운다(그 전에 지우면 되돌릴 수 없다).
pub(super) fn swap_tree(live: &Path, staged: &Path, old: &Path, ctx: &str) -> AppResult<bool> {
    let had_live = live.exists();
    if had_live {
        if let Err(e) = std::fs::rename(live, old) {
            crate::diag::error("backup", "tree_swap_failed", format!("{ctx}: live -> old: {e}"));
            return Err(io(e));
        }
    }
    if let Err(e) = std::fs::rename(staged, live) {
        if had_live {
            if let Err(re) = std::fs::rename(old, live) {
                crate::diag::error(
                    "backup",
                    "tree_rollback_failed",
                    format!("{ctx}: old -> live: {re} (the previous tree remains in its .old-* sibling folder)"),
                );
            }
        }
        crate::diag::error("backup", "tree_swap_failed", format!("{ctx}: staged -> live: {e}"));
        return Err(io(e));
    }
    Ok(had_live)
}

/// 새 상태가 확정된 뒤 옛 트리를 지운다. 데이터는 새 자리에 있으므로 못 지워도 스왑은 성공이지만, 디스크를 조용히 먹는
/// 잔여물이라 기록은 남긴다(파일 이름만 — 전체 경로 금지).
pub(super) fn discard_old_tree(old: &Path, ctx: &str) {
    if old.exists() {
        if let Err(e) = std::fs::remove_dir_all(old) {
            crate::diag::warn("backup", "old_tree_remove_failed", format!("{ctx}: {e}"));
        }
    }
}

/// 스왑의 파일 삭제 단계용 io 에러 변환 — Windows 공유 위반(os error 32)은 다른 연결이 brise.db 를
/// 잡고 있다는 뜻이라, 일반 io 에러 대신 사용자가 할 수 있는 일을 말해 준다.
/// ponytail: 백그라운드 연결(수집 러너·일정/EXIF 워커·동기화 서버 핸들러·자동 백업)은 각자 db::open 을
/// 하고, with_db_file_swap 은 채팅 읽기 연결만 닫는다. 그래서 그들이 열려 있는 순간의 스왑은 Windows 에선
/// 여기서 실패하고(되돌림 경로로 안전), Unix 에선 unlink 된 옛 inode 에 늦은 쓰기가 사라질 수 있다.
/// 천장: 워커가 db::open 전에 확인하는 일시정지(quiesce) 게이트를 스왑 내내 잡으면 해결된다.
fn file_in_use(e: std::io::Error) -> AppError {
    if e.raw_os_error() == Some(32) {
        AppError::Io(format!(
            "the database file is in use by another connection (sync server, collect or a background worker) - turn off sync, wait for running collect jobs and retry ({e})"
        ))
    } else {
        io(e)
    }
}

/// 스테이징된 DB·첨부·배경 이미지로 라이브 상태를 통째로 갈아끼운다 — backup_restore 와 db_reset 공용.
/// 성공하면 `*conn` 은 새 라이브 커넥션이다. 호출자는 이미 `safety_backup` 스냅샷을 찍어 뒀어야 한다
/// (실패 시 그걸로 되돌린다). `carry_secrets` 는 새 DB 에 되돌려 넣을 이 설치본의 비밀 설정,
/// `op` 는 에러 메시지용 이름("restore"/"reset").
/// 스왑 자체는 rename 위주(거의 실패하지 않음)로 좁혀 "검증 실패 = 기존 상태 100% 보존"을 보장한다.
pub(super) fn swap_live_state(
    conn: &mut Connection,
    data_dir: &Path,
    staged: Staged,
    safety_backup: &Path,
    carry_secrets: &[(String, String)],
    op: &str,
) -> AppResult<()> {
    // 라이브 커넥션을 놓아야 Windows에서 파일 교체(rename)가 가능하다(핸들이 열려 있으면 실패).
    // 채팅 검색의 읽기 연결도 같은 이유로 호출자가 닫아 둬야 한다(AppState::with_db_file_swap).
    let placeholder = Connection::open_in_memory().map_err(dberr)?;
    let old_conn = std::mem::replace(conn, placeholder);
    drop(old_conn);

    let live_db = db::db_path(data_dir);
    let old_att = attachments_sibling(data_dir, &format!("attachments.old-{}", new_id()));
    let old_bg = data_dir.join(format!("workspace_bg.old-{}", new_id()));
    let live_att = db::attachments_dir(data_dir);
    let live_bg = db::workspace_bg_dir(data_dir);
    // 라이브 DB 파일(또는 그 -wal/-shm)을 실제로 건드렸는가 — 아래 실패 경로가 안전 스냅샷을 되 복사할지의 근거다.
    // 사이드카·본 파일 삭제가 공유 위반(Windows os error 32)으로 첫 삭제에서 막힌 경우엔 라이브 DB 는 그대로이고,
    // 그때 스냅샷을 덮어쓰면 멀쩡한 DB 를 (방금 찍은 것이라도) 스냅샷으로 갈아엎는 불필요한 쓰기가 된다.
    let live_db_touched = std::cell::Cell::new(false);
    let outcome: AppResult<Connection> = (|| {
        for ext in ["-wal", "-shm"] {
            let sidecar = data_dir.join(format!("{}{ext}", db::DB_FILE));
            if sidecar.exists() {
                std::fs::remove_file(&sidecar).map_err(file_in_use)?;
                live_db_touched.set(true);
            }
        }
        if live_db.exists() {
            std::fs::remove_file(&live_db).map_err(file_in_use)?;
        }
        // 본 파일이 사라졌거나(원래 없던 경우 포함) 곧 스테이징본으로 바뀐다 — 여기서부터 라이브 상태는 스냅샷 시점과 다르다.
        live_db_touched.set(true);
        std::fs::rename(&staged.db_path, &live_db).map_err(io)?;

        // 트리 스왑(되돌리기·diag 포함은 swap_tree). 여기서 두 번째가 실패하면 첫 번째 트리는 이미 새것으로 바뀐 채라, 아래 실패 경로가
        // old 자리에서 되돌린다.
        swap_tree(&live_att, &staged.att_path, &old_att, &format!("{op} attachments"))?;
        swap_tree(&live_bg, &staged.bg_path, &old_bg, &format!("{op} workspace_bg"))?;

        let mut new_conn = db::open(&live_db)?;
        migrations::run(&mut new_conn)?;
        db::scrub_zero_row_stats(&new_conn);
        // 파일 상단 주석 참고: 복원본은 새 설치본이므로 백업 출처 기기의 device_id 를 버리고
        // 재생성한다(초기화의 빈 DB 엔 애초에 없다 — 같은 줄로 새로 만든다).
        new_conn
            .execute("DELETE FROM settings WHERE key='device_id'", [])
            .map_err(dberr)?;
        crate::repo::settings::ensure_device_id(&new_conn)?;
        // export.rs::is_device_local_setting_key 와 같은 이유(G3 device_id 와 동급) — sync_enabled
        // 는 "이 설치본"의 로컬 서버 on/off 상태다. 복원된 기기가 백업 출처 기기의 sync_enabled=true
        // 를 그대로 이어받아 조용히(사용자가 한 번도 켠 적 없는데) 토큰 있는 서버를 자동 기동하면
        // 안 된다(sync_server::maybe_start_at_boot 는 enabled && token 비어있지 않음을 함께 본다).
        // sync_token 은 backup_create 단계에서 이미 is_secret_setting_key 로 스테이징 사본에서
        // 지워지지만(위 함수 주석), 여기서도 명시적으로 비워 두 경로 중 하나가 바뀌어도 안전하게
        // 한다. 삭제만 하면 settings::get_all() 이 default_settings() 의 false/"" 로 폴백한다 —
        // sync_port 는 민감하지 않으므로(그냥 숫자) device_id/sync_enabled 와 달리 그대로 둔다.
        new_conn
            .execute("DELETE FROM settings WHERE key IN ('sync_enabled', 'sync_token')", [])
            .map_err(dberr)?;
        super::import::restore_secret_settings(&new_conn, carry_secrets)?;
        Ok(new_conn)
    })();

    match outcome {
        Ok(new_conn) => {
            *conn = new_conn;
            // 옛 트리는 새 DB 가 완전히 열린 **뒤에만** 지운다 — 그 전에 지우면 아래 실패 경로가
            // 스냅샷 DB 로 되돌려도 그 DB 가 가리키는 첨부·배경은 이미 사라진 뒤다.
            // 삭제 실패는 스왑을 되돌릴 이유가 아니지만(데이터는 새 자리에 있다), 디스크를 조용히
            // 먹는 잔여물이라 기록은 남긴다(파일 이름만 — 전체 경로 금지).
            discard_old_tree(&old_att, &format!("{op} attachments.old"));
            discard_old_tree(&old_bg, &format!("{op} workspace_bg.old"));
            Ok(())
        }
        Err(e) => {
            // 디렉토리부터 제자리로 — DB 를 아래에서 스냅샷으로 되돌리므로 첨부·배경도 옛 트리여야
            // 짝이 맞는다. old 가 있다는 건 이번 호출의 rename(live → old)이 성공했다는 뜻이고,
            // 그때 live 자리는 비었거나 스테이징 사본이다(지워도 되는 쪽).
            for (old, live, label) in [(&old_att, &live_att, "attachments"), (&old_bg, &live_bg, "workspace_bg")] {
                if !old.exists() {
                    continue;
                }
                let back = (|| -> std::io::Result<()> {
                    if live.exists() {
                        std::fs::remove_dir_all(live)?;
                    }
                    std::fs::rename(old, live)
                })();
                if let Err(re) = back {
                    crate::diag::warn("backup", "tree_rollback_failed", format!("{op} {label}: {re}"));
                }
            }
            // ponytail: 이 지점의 실패(rename/재오픈/마이그레이션)는 이미 검증을 마친 스테이징
            // 파일에 대한 디스크 수준 사고에 가깝다 — conn을 in-memory 로 방치하지 않도록
            // 방금 찍은 안전 스냅샷으로 되돌려 재오픈을 한 번 시도한다. 그마저 실패하면 앱 재시작
            // (bootstrap의 손상 복구 경로)이 실질적 복구 수단이다.
            // 라이브 DB 를 실제로 건드린 뒤에만 스냅샷을 되 복사한다(위 live_db_touched). 단계마다 실패를 기록하고(로그엔
            // 파일 이름만), 재오픈까지 실패해 conn 이 in-memory 자리표시자로 남으면 — 그 뒤의 쓰기는 전부 RAM 으로 가 재시작 때
            // 사라지므로 — 사용자에게 알린다. 초기화(reset.rs)도 같은 함수를 탄다.
            let snapshot_name = safety_backup
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut copy_ok = true;
            if live_db_touched.get() {
                if let Err(ce) = std::fs::copy(safety_backup, &live_db) {
                    copy_ok = false;
                    crate::diag::error("backup", "snapshot_copy_back_failed", format!("{op} {snapshot_name}: {ce}"));
                }
            }
            let reopened = match db::open(&live_db) {
                Ok(mut recovered) => {
                    if let Err(me) = migrations::run(&mut recovered) {
                        crate::diag::error("backup", "recovered_db_migration_failed", format!("{op}: {me}"));
                    }
                    *conn = recovered;
                    true
                }
                Err(oe) => {
                    crate::diag::error("backup", "recovered_db_reopen_failed", format!("{op}: {oe}"));
                    false
                }
            };
            // 두 사고는 사용자가 해야 할 말이 다르다 — 코드를 나눈다(프런트 App.tsx::diagNoticeMessage 에 전용 문구).
            // db_connection_lost: 지금 RAM 위에서 돈다(쓴 건 사라진다) / swap_recovery_failed: 디스크 DB 는 열렸지만 이전 상태로 못 돌렸다.
            if !reopened {
                crate::diag::notify_user(
                    "backup",
                    "db_connection_lost",
                    &[("op", op.to_string()), ("snapshot", snapshot_name)],
                );
            } else if !copy_ok {
                crate::diag::notify_user(
                    "backup",
                    "swap_recovery_failed",
                    &[("op", op.to_string()), ("snapshot", snapshot_name)],
                );
            }
            // 위 되돌리기마저 실패했으면 기존 트리가 old 자리에 남아 사라진 것처럼 보인다 —
            // 메시지에 경로를 남겨 수동 복구 가능하게 한다.
            // 라이브 DB 파일을 건드리기 전(Windows 공유 위반으로 첫 삭제가 막힘)에 실패했으면 아무것도 바뀐 게 없다 — "교체 뒤"라고 말하지 않는다.
            let when = if live_db_touched.get() { "after replacing files" } else { "before anything was replaced" };
            let mut msg = format!(
                "{op} failed {when}: {e}. Safety snapshot of the previous state: {}",
                safety_backup.display()
            );
            if !reopened {
                msg.push_str(
                    " The app is now running on a temporary in-memory database: restart Brise immediately - anything changed until then is NOT saved.",
                );
            } else if !copy_ok {
                msg.push_str(
                    " The previous state could not be copied back automatically: restart Brise and restore from the safety snapshot above if anything looks wrong.",
                );
            }
            if old_att.exists() {
                msg.push_str(&format!(" Previous attachments preserved at: {}.", old_att.display()));
            }
            if old_bg.exists() {
                msg.push_str(&format!(" Previous workspace_bg preserved at: {}.", old_bg.display()));
            }
            // 스왑 전 단계에서 실패했으면 스테이징 잔여물이 남는다 — 지워도 되는 사본이다.
            staged.discard();
            Err(AppError::Db(msg))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 스왑 도중(첨부는 이미 갈아끼운 뒤) 실패하면 첨부·배경 트리가 모두 제자리로 돌아와야 한다 —
    /// 스냅샷 DB 와 짝이 맞는 옛 파일들이 attachments.old-* 에 버려진 채 남으면 안 된다.
    /// 스테이징 배경 경로를 없는 자리로 줘서 마지막 rename 을 실패시킨다.
    #[test]
    fn swap_failure_mid_way_puts_both_trees_back() {
        let data_dir = tempfile::tempdir().unwrap();
        let dd = data_dir.path();
        let mut conn = db::bootstrap(dd).unwrap();
        std::fs::write(db::attachments_dir(dd).join("keep.txt"), b"att").unwrap();
        std::fs::write(db::workspace_bg_dir(dd).join("bg.png"), b"bg").unwrap();
        let safety = db::snapshot_backup(&conn, &db::backups_dir(dd)).unwrap();

        let staged_db = dd.join("staged.db");
        std::fs::copy(&safety, &staged_db).unwrap();
        let staged_att = dd.join("att.incoming");
        std::fs::create_dir_all(&staged_att).unwrap();
        std::fs::write(staged_att.join("new.txt"), b"new").unwrap();
        let staged = Staged { db_path: staged_db, att_path: staged_att, bg_path: dd.join("missing-bg") };

        assert!(swap_live_state(&mut conn, dd, staged, &safety, &[], "test").is_err());

        assert_eq!(std::fs::read(db::attachments_dir(dd).join("keep.txt")).unwrap(), b"att");
        assert!(!db::attachments_dir(dd).join("new.txt").exists());
        assert_eq!(std::fs::read(db::workspace_bg_dir(dd).join("bg.png")).unwrap(), b"bg");
        let leftovers: Vec<String> = std::fs::read_dir(dd)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.contains(".old-") || n.ends_with(".incoming"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        // 실패 경로도 conn 을 스냅샷 DB 로 다시 연다.
        conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get::<_, i64>(0)).unwrap();
    }

    /// 스왑 실패 경로 테스트용: 마지막 rename(배경 스테이징이 없는 자리)이 실패하도록 짠 스테이징 + 유효한 안전 스냅샷.
    fn swap_failure_fixture(dd: &Path) -> (Connection, PathBuf, Staged) {
        let conn = db::bootstrap(dd).unwrap();
        let safety = db::snapshot_backup(&conn, &db::backups_dir(dd)).unwrap();
        let staged_db = dd.join("staged.db");
        std::fs::copy(&safety, &staged_db).unwrap();
        let staged_att = dd.join("att.incoming");
        std::fs::create_dir_all(&staged_att).unwrap();
        let staged = Staged { db_path: staged_db, att_path: staged_att, bg_path: dd.join("missing-bg") };
        (conn, safety, staged)
    }

    fn diag_with(code: &str, token: &str) -> bool {
        crate::diag::recent(500).iter().any(|e| e.feature == "backup" && e.code == code && e.message.contains(token))
    }

    /// B2: 스냅샷으로 되돌려 재오픈까지 실패하면 conn 이 in-memory 자리표시자로 남는다 — 예전엔 아무 기록도 없었다.
    /// 이제 단계별 diag::error + 사용자 알림(재시작 필요) + 반환 에러 메시지의 재시작 안내가 있어야 한다.
    #[test]
    fn swap_failure_that_cannot_reopen_the_db_is_recorded_and_tells_the_user_to_restart() {
        let data_dir = tempfile::tempdir().unwrap();
        let dd = data_dir.path();
        let (mut conn, safety, staged) = swap_failure_fixture(dd);
        // 스냅샷 파일을 깨 둔다 — 되 복사는 되지만 그 파일을 DB 로 열 수 없다.
        std::fs::write(&safety, b"this is not a sqlite database").unwrap();
        let op = format!("b2-reopen-{}", new_id());

        let err = swap_live_state(&mut conn, dd, staged, &safety, &[], &op).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("restart Brise immediately"), "{msg}");
        assert!(msg.contains(&safety.display().to_string()), "스냅샷 경로가 메시지에 있어야 한다: {msg}");
        // 자리표시자 in-memory DB — 앱 테이블이 없다.
        assert!(conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get::<_, i64>(0)).is_err());
        assert!(diag_with("recovered_db_reopen_failed", &op));
        assert!(diag_with("db_connection_lost", &op), "사용자 알림(notify_user)도 기록에 남는다");
    }

    /// B2: 안전 스냅샷을 되 복사하지 못하면(여기선 스냅샷이 사라짐) 기록하고 알린다. 그래도 디스크의 DB 를 다시 열어 쓰기가 RAM 으로 새지 않게 한다.
    #[test]
    fn swap_failure_that_cannot_copy_the_snapshot_back_is_recorded() {
        let data_dir = tempfile::tempdir().unwrap();
        let dd = data_dir.path();
        let (mut conn, safety, staged) = swap_failure_fixture(dd);
        std::fs::remove_file(&safety).unwrap();
        let op = format!("b2-copy-{}", new_id());

        let err = swap_live_state(&mut conn, dd, staged, &safety, &[], &op).unwrap_err();
        assert!(err.to_string().contains("could not be copied back"), "{err}");
        assert!(diag_with("snapshot_copy_back_failed", &op));
        assert!(diag_with("swap_recovery_failed", &op));
        // 스테이징본이 이미 라이브 자리에 있어 재오픈은 된다 — conn 은 파일 DB 다.
        conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get::<_, i64>(0)).unwrap();
    }

    /// B2: 라이브 DB 를 건드리기 전에(Windows 공유 위반으로 첫 삭제가 막힘) 실패하면 스냅샷을 덮어쓰지 않는다 —
    /// 그 사이 쓴 행이 살아 있어야 한다. 공유 위반은 Windows 의 동작이라 Windows 에서만 돈다.
    #[cfg(windows)]
    #[test]
    fn swap_failure_before_touching_the_live_db_keeps_it_and_does_not_copy_the_snapshot_over_it() {
        let data_dir = tempfile::tempdir().unwrap();
        let dd = data_dir.path();
        let (mut conn, safety, staged) = swap_failure_fixture(dd);
        // 스냅샷 뒤에 쓴 행 — 스냅샷으로 되돌리면 사라진다.
        conn.execute("INSERT INTO settings(key, value) VALUES ('b2_marker', '\"live\"') ON CONFLICT(key) DO UPDATE SET value=excluded.value", []).unwrap();
        // 다른 연결이 DB(와 -wal/-shm)를 잡고 있다 → 첫 사이드카 삭제가 공유 위반으로 막힌다.
        let other = db::open(&db::db_path(dd)).unwrap();
        other.query_row("SELECT COUNT(*) FROM settings", [], |r| r.get::<_, i64>(0)).unwrap();
        let op = format!("b2-pretouch-{}", new_id());

        let err = swap_live_state(&mut conn, dd, staged, &safety, &[], &op).unwrap_err();
        assert!(err.to_string().contains("failed before anything was replaced"), "{err}");
        let marker: String = conn
            .query_row("SELECT value FROM settings WHERE key='b2_marker'", [], |r| r.get(0))
            .expect("라이브 DB 는 스냅샷으로 덮이지 않았다");
        assert_eq!(marker, "\"live\"");
        assert!(!diag_with("snapshot_copy_back_failed", &op));
        drop(other);
    }

    // ── swap_tree ──────────────────────────────────────────────────────────────────────────────

    /// 라이브가 있으면 old 로 치우고 새것을 올린다 — 반환 true, old 에 옛 파일이 있다.
    #[test]
    fn swap_tree_replaces_live_and_keeps_the_previous_tree_in_old() {
        let dir = tempfile::tempdir().unwrap();
        let (live, staged, old) = (dir.path().join("att"), dir.path().join("incoming"), dir.path().join("old"));
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("a.txt"), b"old").unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("b.txt"), b"new").unwrap();

        assert!(swap_tree(&live, &staged, &old, "test").unwrap());
        assert_eq!(std::fs::read(live.join("b.txt")).unwrap(), b"new");
        assert_eq!(std::fs::read(old.join("a.txt")).unwrap(), b"old");
        assert!(!staged.exists());
        discard_old_tree(&old, "test");
        assert!(!old.exists());
    }

    /// 라이브가 원래 없으면 그냥 올린다 — 반환 false, old 는 만들어지지 않는다.
    #[test]
    fn swap_tree_without_a_live_tree_just_installs_the_staged_one() {
        let dir = tempfile::tempdir().unwrap();
        let (live, staged, old) = (dir.path().join("att"), dir.path().join("incoming"), dir.path().join("old"));
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("b.txt"), b"new").unwrap();
        assert!(!swap_tree(&live, &staged, &old, "test").unwrap());
        assert_eq!(std::fs::read(live.join("b.txt")).unwrap(), b"new");
        assert!(!old.exists());
    }

    /// 두 번째 rename(스테이징이 없는 자리) 이 실패하면 첫 rename 을 되돌려 라이브가 제자리로 돌아오고 old 는 남지 않는다.
    #[test]
    fn swap_tree_puts_the_live_tree_back_when_the_second_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        let (live, old) = (dir.path().join("att"), dir.path().join("old"));
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("keep.txt"), b"keep").unwrap();

        let ctx = format!("swap-tree-rollback-{}", new_id());
        let err = swap_tree(&live, &dir.path().join("missing-staged"), &old, &ctx);
        assert!(err.is_err());
        assert_eq!(std::fs::read(live.join("keep.txt")).unwrap(), b"keep", "라이브가 제자리로 돌아왔다");
        assert!(!old.exists(), "되돌렸으니 old 에는 아무것도 없다");
        assert!(diag_with("tree_swap_failed", &ctx), "실패는 diag 에 남는다");
    }

    /// Staged::discard — DB·사이드카·두 트리를 모두 지운다(이미 없는 것은 무시).
    #[test]
    fn staged_discard_removes_db_sidecars_and_both_trees() {
        let dir = tempfile::tempdir().unwrap();
        let dd = dir.path();
        let staged = Staged { db_path: dd.join("s.db"), att_path: dd.join("s-att"), bg_path: dd.join("s-bg") };
        std::fs::write(&staged.db_path, b"db").unwrap();
        std::fs::write(dd.join("s.db-wal"), b"w").unwrap();
        std::fs::write(dd.join("s.db-shm"), b"s").unwrap();
        std::fs::create_dir_all(staged.att_path.join("n")).unwrap();
        // bg 는 일부러 만들지 않는다 — 없어도 조용히 넘어간다.
        staged.discard();
        for p in [&staged.db_path, &staged.att_path, &staged.bg_path, &dd.join("s.db-wal"), &dd.join("s.db-shm")] {
            assert!(!p.exists(), "{p:?}");
        }
    }
}
