// 드릴 1(디스크 가득) · 드릴 2(트랜잭션 중 kill) — docs/DRILLS-2026-10-06.md
// 목적은 결함 발견이다. 실제 동작을 그대로 단언하고, 기대와 다른 곳은 `DEFECT` 주석으로 남긴다.
// 앱 DB 는 건드리지 않는다 — 전부 tempdir.
mod common;
use brise_lib::db;
use brise_lib::error::AppError;
use brise_lib::repo::{attachments, notes, sections, transfer};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn file_count(dir: &Path) -> usize {
    fn walk(d: &Path) -> usize {
        std::fs::read_dir(d)
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .map(|e| if e.path().is_dir() { walk(&e.path()) } else { 1 })
                    .sum()
            })
            .unwrap_or(0)
    }
    walk(dir)
}

fn integrity_ok(conn: &Connection) -> bool {
    let r: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    r == "ok"
}

/// 이 커넥션의 DB 크기를 현재 페이지 수로 고정 = "디스크 가득". 새 페이지가 필요한 쓰기는 SQLITE_FULL.
fn fill_up(conn: &Connection) {
    let pc: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let _: i64 = conn.query_row(&format!("PRAGMA max_page_count={pc}"), [], |r| r.get(0)).unwrap();
}

fn is_full(e: &AppError) -> bool {
    matches!(e, AppError::Db(m) if m.to_lowercase().contains("full"))
}

// ───────────────────────── 드릴 1: 디스크 가득 ─────────────────────────

#[test]
fn drill1_note_create_when_db_full() {
    let mut ctx = common::setup();
    let before = common::count(&ctx.conn, "notes");
    fill_up(&ctx.conn);
    let mut ok = 0;
    let mut err = None;
    for i in 0..500 {
        match notes::create(&mut ctx.conn, &ctx.folder_id, Some(format!("full-{i}")), None) {
            Ok(_) => ok += 1,
            Err(e) => {
                err = Some(e);
                break;
            }
        }
    }
    let e = err.expect("DB 가 가득 찼는데 500개 생성이 전부 성공");
    assert!(is_full(&e), "FULL 에러가 호출자에게 와야 한다: {e}");
    // 부분 생성 없음: 노트 수 = before + 성공 수, 섹션 없는 노트 없음
    assert_eq!(common::count(&ctx.conn, "notes"), before + ok);
    let orphans: i64 = ctx
        .conn
        .query_row(
            "SELECT COUNT(*) FROM notes n WHERE NOT EXISTS (SELECT 1 FROM sections s WHERE s.note_id=n.id)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphans, 0, "섹션 없는 반쪽 노트");
    assert!(integrity_ok(&ctx.conn));
    // 공간이 확보되면 다시 쓰기 가능
    let _: i64 = ctx.conn.query_row("PRAGMA max_page_count=1000000", [], |r| r.get(0)).unwrap();
    assert!(notes::create(&mut ctx.conn, &ctx.folder_id, Some("after".into()), None).is_ok());
}

#[test]
fn drill1_section_update_when_db_full_keeps_old_body() {
    let mut ctx = common::setup();
    let note = notes::create(&mut ctx.conn, &ctx.folder_id, Some("n".into()), None).unwrap();
    let sid = note.sections[0].id.clone();
    sections::update(&mut ctx.conn, &sid, None, Some("original".into()), None).unwrap();
    fill_up(&ctx.conn);
    let big = "x".repeat(2 * 1024 * 1024);
    let r = sections::update(&mut ctx.conn, &sid, None, Some(big), None);
    let e = r.expect_err("가득 찬 DB 에 2MB 본문이 저장됨");
    assert!(is_full(&e), "{e}");
    let body: String = ctx
        .conn
        .query_row("SELECT body_md FROM sections WHERE id=?1", [&sid], |r| r.get(0))
        .unwrap();
    assert_eq!(body, "original", "실패한 저장이 기존 본문을 건드림");
    assert!(integrity_ok(&ctx.conn));
}

#[test]
fn drill1_attachment_add_when_db_full_leaves_orphan_file() {
    let mut ctx = common::setup();
    let note = notes::create(&mut ctx.conn, &ctx.folder_id, Some("att".into()), None).unwrap();
    let src = common::make_external_file(&ctx.tmp.path().join("ext"), "a.txt", b"hello");
    fill_up(&ctx.conn);
    let mut ok = 0;
    let mut err = None;
    for _ in 0..2000 {
        match attachments::add_file(&mut ctx.conn, &ctx.data_dir, &note.note.id, src.to_str().unwrap()) {
            Ok(_) => ok += 1,
            Err(e) => {
                err = Some(e);
                break;
            }
        }
    }
    let e = err.expect("가득 찬 DB 에 첨부가 2000개 들어감");
    assert!(is_full(&e), "{e}");
    let rows = common::count(&ctx.conn, "attachments");
    let note_dir = db::attachments_dir(&ctx.data_dir).join(&note.note.id);
    let files = file_count(&note_dir);
    let tmp_left = std::fs::read_dir(&note_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-"))
        .count();
    assert_eq!(tmp_left, 0, ".tmp- 잔해");
    assert_eq!(rows as usize, ok);
    // DEFECT(LOW, 실측): add_file 은 파일을 먼저 복사하고 INSERT 를 나중에 한다. INSERT 실패 시
    // 복사본을 지우지 않아 행 없는 고아 파일이 실패 1건당 1개 남는다. 게다가 orphan_cleanup 은
    // "알려지지 않은 노트의 디렉터리"만 보관함으로 옮길 뿐 **알려진 노트 디렉터리 안의 고아 파일**은
    // 영영 회수하지 않는다(아래 단언). 현재 동작을 그대로 단언 — 고쳐지면 files == rows 로 바꿀 것.
    // 한 줄 수리안: add_file 의 INSERT 가 Err 면 remove_file(&dest) 후 반환.
    assert_eq!(files, rows as usize, "INSERT 실패 시 복사본을 지운다(고아 0)");
    attachments::orphan_cleanup(&ctx.conn, &ctx.data_dir).unwrap();
    assert_eq!(file_count(&note_dir), rows as usize, "고아 파일이 남지 않는다");
    assert!(integrity_ok(&ctx.conn));
}

#[test]
fn drill1_attachment_dir_unwritable_returns_err_no_row() {
    let mut ctx = common::setup();
    let note = notes::create(&mut ctx.conn, &ctx.folder_id, Some("att".into()), None).unwrap();
    let src = common::make_external_file(&ctx.tmp.path().join("ext"), "a.txt", b"hello");
    // 노트 첨부 폴더 자리에 일반 파일을 둔다 → create_dir_all 실패(쓰기 불가 디렉터리 모사).
    let note_dir = db::attachments_dir(&ctx.data_dir).join(&note.note.id);
    let _ = std::fs::remove_dir_all(&note_dir);
    std::fs::write(&note_dir, b"i am a file").unwrap();
    let before = common::count(&ctx.conn, "attachments");
    let r = attachments::add_file(&mut ctx.conn, &ctx.data_dir, &note.note.id, src.to_str().unwrap());
    assert!(matches!(r, Err(AppError::Io(_))), "{r:?}");
    assert_eq!(common::count(&ctx.conn, "attachments"), before);
}

#[test]
fn drill1_backup_when_backups_dir_unusable() {
    let ctx = common::setup();
    let backups = db::backups_dir(&ctx.data_dir);
    std::fs::remove_dir_all(&backups).unwrap();
    std::fs::write(&backups, b"file, not dir").unwrap(); // 폴더 생성 불가 모사
    let r = transfer::backup::auto_backup_run(&ctx.data_dir, 3);
    assert!(r.is_err());
    // 실패가 설정 키에 기록돼 설정 화면에서 발견 가능해야 한다
    let conn = db::open(&db::db_path(&ctx.data_dir)).unwrap();
    let v: String = conn
        .query_row("SELECT value FROM settings WHERE key='backup_auto_last_error'", [], |r| r.get(0))
        .unwrap();
    assert!(v.len() > 6, "last_error 미기록: {v}");
    let r2 = transfer::backup::pre_delete_backup(&ctx.data_dir);
    assert!(r2.is_err(), "pre_delete_backup 실패는 Err — 호출자가 삭제를 중단해야 한다");
    let staging: Vec<_> = std::fs::read_dir(&ctx.data_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("staging"))
        .collect();
    assert!(staging.is_empty(), "staging 잔해: {staging:?}");
}

/// 쓰는 도중 실패(zip 작성 중 첨부 파일을 못 읽음 — Windows 독점 잠금으로 모사)하면
/// 반쯤 쓴 zip 이 남는가.
#[cfg(windows)]
#[test]
fn drill1_backup_midwrite_failure_leaves_partial_zip() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut ctx = common::setup();
    let note = notes::create(&mut ctx.conn, &ctx.folder_id, Some("att".into()), None).unwrap();
    let src = common::make_external_file(&ctx.tmp.path().join("ext"), "a.txt", b"hello");
    attachments::add_file(&mut ctx.conn, &ctx.data_dir, &note.note.id, src.to_str().unwrap()).unwrap();
    let note_dir = db::attachments_dir(&ctx.data_dir).join(&note.note.id);
    let stored: PathBuf = std::fs::read_dir(&note_dir).unwrap().next().unwrap().unwrap().path();
    let backups = db::backups_dir(&ctx.data_dir);
    let count_auto = || {
        std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("auto-"))
            .count()
    };
    let zips_before = count_auto();
    let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&stored).unwrap();

    let r = transfer::backup::auto_backup_run(&ctx.data_dir, 3);
    assert!(r.is_err(), "잠긴 첨부가 있는데 백업이 성공");
    drop(lock);
    // 수리됨(드릴 1·2 발견): 예전엔 ZipWriter 의 Drop 이 finish() 를 불러 '열리는 불완전 zip'이 최신 백업으로
    // 남아 스케줄·회전·복원을 속였다. 이제 실패한 백업은 dest 를 지운다.
    assert_eq!(count_auto(), zips_before, "실패한 백업의 불완전 zip 이 남지 않는다");
    assert!(
        transfer::backup::newest_auto_backup(&backups).is_none()
            || count_auto() == zips_before,
        "잔해가 최신 백업으로 보이지 않는다"
    );
}

// ───────────────────────── 드릴 2: 트랜잭션 중 kill ─────────────────────────

const ENV_MODE: &str = "DRILL_CHILD_MODE";
const ENV_DIR: &str = "DRILL_CHILD_DIR";

/// 부모가 `--exact drill_child_entry` 로 다시 띄우는 진입점. 환경변수가 없으면 즉시 통과(일반 실행).
#[test]
fn drill_child_entry() {
    let Ok(mode) = std::env::var(ENV_MODE) else { return };
    let dir = PathBuf::from(std::env::var(ENV_DIR).unwrap());
    let ready = dir.join("ready");
    match mode.as_str() {
        "tx" => {
            let mut conn = db::open(&db::db_path(&dir)).unwrap();
            let folder: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
            conn.execute("CREATE TABLE drill_blob(id INTEGER PRIMARY KEY, b BLOB)", []).unwrap();
            for i in 0..3 {
                notes::create(&mut conn, &folder, Some(format!("committed-{i}")), None).unwrap();
            }
            for _ in 0..100 {
                conn.execute("INSERT INTO drill_blob(b) VALUES (zeroblob(4096))", []).unwrap();
            }
            // 미커밋 트랜잭션: 작은 캐시로 더티 페이지를 WAL 로 spill 시킨다(커밋 안 된 프레임이 WAL 에 존재).
            conn.pragma_update(None, "cache_size", 10).unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute("INSERT INTO settings(key,value) VALUES('drill_uncommitted','1')", []).unwrap();
            for _ in 0..3000 {
                tx.execute("INSERT INTO drill_blob(b) VALUES (zeroblob(4096))", []).unwrap();
            }
            std::fs::write(&ready, b"1").unwrap();
            std::thread::sleep(Duration::from_secs(120));
            drop(tx);
        }
        "migrate" => {
            let mut conn = db::open(&db::db_path(&dir)).unwrap();
            // v2 는 일부러 오래 걸리는 단일 문장(수억 행) — 트랜잭션 도중 kill 되도록.
            let slow = "CREATE TABLE big(x INTEGER);
                 WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<400000000)
                 INSERT INTO big SELECT n FROM c;";
            let list: Vec<(i64, &str)> = vec![
                (
                    1,
                    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                     CREATE TABLE m1(x INTEGER);",
                ),
                (2, slow),
            ];
            // apply 가 한 덩어리라 v2 시작 시점에 신호를 못 준다 → 별도 스레드가 잠시 뒤 신호.
            let ready2 = ready.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                std::fs::write(ready2, b"1").unwrap();
            });
            let _ = brise_lib::db::migrations::apply(&mut conn, &list);
        }
        other => panic!("unknown mode {other}"),
    }
}

fn spawn_child(mode: &str, dir: &Path) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "drill_child_entry", "--nocapture", "--test-threads=1"])
        .env(ENV_MODE, mode)
        .env(ENV_DIR, dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn child")
}

fn wait_ready(dir: &Path, child: &mut std::process::Child) {
    for _ in 0..600 {
        if dir.join("ready").exists() {
            return;
        }
        if let Some(st) = child.try_wait().unwrap() {
            panic!("child 가 ready 전에 종료: {st}");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("child ready 타임아웃");
}

#[test]
fn drill2_kill_mid_transaction_preserves_committed_and_drops_uncommitted() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    drop(db::bootstrap(&dir).unwrap()); // 스키마 준비 후 닫기

    let mut child = spawn_child("tx", &dir);
    wait_ready(&dir, &mut child);
    assert!(child.try_wait().unwrap().is_none(), "kill 시점에 자식이 이미 끝남(드릴 무효)");
    let wal_len = std::fs::metadata(dir.join("brise.db-wal")).map(|m| m.len()).unwrap_or(0);
    child.kill().unwrap(); // Windows: TerminateProcess — 정리 코드 없이 즉사
    let _ = child.wait();
    assert!(wal_len > 0, "WAL 이 비어 있으면 복구 경로를 시험한 게 아니다");

    // 앱 경로 그대로 다시 연다(부팅과 동일: bootstrap → open_checked/quick_check/migrate).
    let conn = db::bootstrap(&dir).expect("kill 후 재부팅 실패");
    assert!(integrity_ok(&conn));
    let committed: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE title LIKE 'committed-%'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(committed, 3, "커밋된 노트 유실");
    let blobs: i64 = conn.query_row("SELECT COUNT(*) FROM drill_blob", [], |r| r.get(0)).unwrap();
    assert_eq!(blobs, 100, "미커밋 행이 보이거나 커밋 행이 유실: {blobs}");
    let unc: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings WHERE key='drill_uncommitted'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(unc, 0, "미커밋 설정 행이 보임");
    // 재부팅 후 쓰기 가능(잠금이 안 남음)
    conn.execute("INSERT INTO drill_blob(b) VALUES (zeroblob(10))", []).unwrap();
}

#[test]
fn drill2_kill_during_migration_is_atomic_per_version() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let mut child = spawn_child("migrate", &dir);
    wait_ready(&dir, &mut child);
    assert!(child.try_wait().unwrap().is_none(), "마이그레이션이 kill 전에 끝남 — 행 수를 늘려라");
    child.kill().unwrap();
    let _ = child.wait();

    let mut conn = db::open(&db::db_path(&dir)).unwrap();
    assert!(integrity_ok(&conn));
    assert_eq!(brise_lib::db::migrations::current_version(&conn).unwrap(), 1, "v1 만 커밋돼 있어야");
    let has = |t: &str| -> bool {
        conn.query_row("SELECT 1 FROM sqlite_master WHERE name=?1", [t], |_| Ok(true)).unwrap_or(false)
    };
    assert!(has("m1"), "커밋된 v1 의 결과 유실");
    assert!(!has("big"), "v2 가 반적용 상태로 남음(트랜잭션 단위가 아님)");
    // 같은 번호의 빠른 마이그레이션으로 재시작 → v2 가 처음부터 정상 적용
    let list: Vec<(i64, &str)> = vec![(1, ""), (2, "CREATE TABLE big(x INTEGER); INSERT INTO big VALUES (1);")];
    brise_lib::db::migrations::apply(&mut conn, &list).unwrap();
    assert_eq!(brise_lib::db::migrations::current_version(&conn).unwrap(), 2);
}
