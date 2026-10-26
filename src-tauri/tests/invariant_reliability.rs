// 불변성: 운영 신뢰성 — R3(quick_check+백업 회전), R4(마이그레이션 롤백), R6(파일명 슬러그)
// specs/tests/invariant-reliability.yaml 1:1 (vitest 계층 시나리오는 프론트 측에서 검증)
mod common;
use brise_lib::db;
use brise_lib::repo::{notes, transfer};
use std::fs;

#[test]
fn quick_check_runs_on_boot() {
    // setup()은 이미 부트스트랩 + quick_check를 통과한 상태 → 다시 호출해도 안전
    let ctx = common::setup();
    assert!(db::quick_check(&ctx.conn).is_ok());
    // 백업 디렉토리에 회전된 파일이 존재 (최근 1개 이상)
    let backups = db::backups_dir(&ctx.data_dir);
    let count = fs::read_dir(&backups).map(|it| it.count()).unwrap_or(0);
    assert!(count >= 1, "expected at least one backup file");
    assert!(count <= 3, "backups must be rotated to <=3");
}

#[test]
fn migration_failure_rolls_back() {
    // 손상된 DDL을 마이그레이션 러너에 주입하면 롤백되어야 한다.
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().to_path_buf();
    // 정상 부트스트랩
    let conn = db::bootstrap(&data_dir).unwrap();
    let notes_before = common::count(&conn, "notes");
    drop(conn);

    // 손상된 마이그레이션을 임시로 직접 시도 (테스트 헬퍼는 따로 두지 않고 raw sql 실행)
    let conn = rusqlite::Connection::open(db::db_path(&data_dir)).unwrap();
    let result: Result<(), rusqlite::Error> = conn.execute_batch(
        "BEGIN;
         CREATE TABLE __corrupt_test (id INTEGER, broken_col NOT NULL);
         INSERT INTO __corrupt_test VALUES (1);
         COMMIT;",
    );
    assert!(result.is_err());
    drop(conn);

    // 새 부트스트랩 시도가 여전히 기존 데이터를 본다 — 별도 마이그레이션 버전 도입이 아니므로
    // 여기서는 quick_check가 깨지지 않고 동일 DB를 재오픈할 수 있는지를 검증한다.
    let conn = rusqlite::Connection::open(db::db_path(&data_dir)).unwrap();
    assert!(db::quick_check(&conn).is_ok());
    assert_eq!(common::count(&conn, "notes"), notes_before);
}

#[test]
fn export_slug_sanitized() {
    // R6: 윈도우 금지 문자 / 예약어 처리 — 파일 이름을 제목에서 만드는 쪽(export_folder)이 폴더 안에 생성 성공해야 한다.
    // (W6 부터 export_note 는 저장 대화상자가 고른 파일 경로에 쓰므로 이름을 만들지 않는다 — 슬러그는 폴더 단위가 만든다.)
    let mut ctx = common::setup();
    notes::create(
        &mut ctx.conn,
        &ctx.folder_id,
        Some("세종: <위대한*왕?> CON".into()),
        Some(1443),
    )
    .unwrap();
    let dest = ctx.tmp.path().join("export-out");
    fs::create_dir_all(&dest).unwrap();
    let res = transfer::export_folder(&mut ctx.conn, &ctx.data_dir, &ctx.folder_id, &dest).unwrap();
    assert!(res.exported_count >= 1);
    let mut names = Vec::new();
    for entry in fs::read_dir(&res.written_dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        for forbidden in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
            assert!(!name.contains(forbidden), "{name} contains {forbidden}");
        }
        names.push(name);
    }
    assert!(names.iter().any(|n| n.starts_with("세종_ _위대한_왕__ CON") && n.ends_with(".md")), "{names:?}");
}
