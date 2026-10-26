// repo: tombstone — docs/SYNC.md Phase 0 G2: 범용 삭제 전파(deleted_rows).
//
// 캐스케이드 규칙: tombstone 은 **직접 삭제한 엔티티에 대해서만** 기록한다. ON DELETE CASCADE 로
// 함께 지워지는 자식 행(예: notes 를 purge 하면 sections/sources/attachments/note_tags
// 가 FK CASCADE 로 같이 사라진다)은 부모의 tombstone 하나로 암시되므로 별도로
// 기록하지 않는다 — 그렇지 않으면 캐스케이드 규모만큼 tombstone 행이 폭증하고, 동기화 클라이언트는
// 어차피 부모가 지워졌다는 사실만으로 자식도 지워야 함을 재구성할 수 있다.
use crate::error::{db as dberr, AppResult};
use crate::util::now_iso;
use rusqlite::{params, Connection};

/// 하드 삭제와 같은 트랜잭션에서 호출한다. `INSERT OR REPLACE` — 같은 (tbl, id) 가 재생성 후
/// 다시 삭제되면 deleted_at 이 최신 시각으로 갱신된다.
pub fn record_tombstone(conn: &Connection, tbl: &str, id: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO deleted_rows(tbl, id, deleted_at) VALUES (?1, ?2, ?3)",
        params![tbl, id, now_iso()],
    )
    .map_err(dberr)?;
    Ok(())
}

/// 같은 (tbl, id) 가 **같은 id 로** 되살아나는 복구 경로에서 호출한다(현재 유일한 호출부:
/// `repo::sections::restore`). 살아 있는 행에 삭제 묘비가 붙어 있는 상태를 남기지 않는다 —
/// 지금은 `deleted_rows` 를 읽는 코드가 없지만(docs/SYNC.md Phase 0 G2 는 쓰기만 갖춘 단계),
/// Phase 2 동기화가 이 표를 읽으면 복구한 행을 상대가 다시 지운다.
pub fn remove_tombstone(conn: &Connection, tbl: &str, id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM deleted_rows WHERE tbl=?1 AND id=?2",
        params![tbl, id],
    )
    .map_err(dberr)?;
    Ok(())
}
