// FTS 동기화 — 모든 노트 변경 트랜잭션 말미에 호출 (specs/service/search.yaml#fts_upsert)
//
// Sole writer of notes_fts outside db::migrations (docs/DATA-WRITES.md §1).
// ALL maintenance of notes_fts MUST go through this module. Direct SQL writes
// in other modules produce search index desync.
//
// One known exception: src/dev_seed.rs batch seed path — direct INSERT INTO
// notes_fts in the same transaction, permitted by docs/DATA-WRITES.md §1 to
// avoid per-note re-aggregation (routing through fts_upsert would defeat that).
// It keeps the 2-char index in step by calling `bigram_index` itself.
//
// 2글자 색인(notes_bigram + notes_bigram_map, specs/db/schemas/fts_bigram.sql)도 이 모듈만 쓴다 —
// notes_fts 를 쓰는 함수마다 같은 트랜잭션에서 색인을 맞춘다. 색인은 notes_fts 행의 같은 네 열에서 파생된다.
// 매핑 표의 id 는 그 노트의 notes_fts rowid 와 같다(V95) — notes_fts 의 모든 행에 매핑 행이 있고, 질문 검색의
// 3자 이상 경로가 MATCH 의 rowid 로 note_id 를 찾는다(note_id 열을 읽으면 FTS5 가 행마다 본문까지 가져온다).

use crate::error::{db, AppError};
use rusqlite::{OptionalExtension, Transaction};
use std::collections::BTreeSet;

/// 테이블 전체 비우기 (bulk import / dev_seed 재색인 전용).
pub fn clear_all(tx: &Transaction) -> Result<(), AppError> {
    tx.execute("DELETE FROM notes_fts", []).map_err(db)?;
    bigram_clear(tx)?;
    Ok(())
}

fn map_lookup_rowid(tx: &Transaction, note_id: &str) -> Result<Option<i64>, AppError> {
    tx.query_row(
        "SELECT id FROM notes_bigram_map WHERE note_id = ?1",
        [note_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(db)
}

fn fts_and_bigram_remove_mapped(tx: &Transaction, rowid: i64) -> Result<(), AppError> {
    tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])
        .map_err(db)?;
    tx.execute("DELETE FROM notes_bigram WHERE rowid = ?1", [rowid])
        .map_err(db)?;
    tx.execute("DELETE FROM notes_bigram_map WHERE id = ?1", [rowid])
        .map_err(db)?;
    Ok(())
}

pub fn fts_upsert(tx: &Transaction, note_id: &str) -> Result<(), AppError> {
    if let Some(rowid) = map_lookup_rowid(tx, note_id)? {
        fts_and_bigram_remove_mapped(tx, rowid)?;
    }
    if let Some((fts_rowid, title, body, source_body, tag_names)) = fts_write_row(tx, note_id)? {
        bigram_index(tx, fts_rowid, note_id, &[&title, &body, &source_body, &tag_names])?;
    }
    Ok(())
}

/// 마이그레이션 전용(migrate_v69) — notes_fts 만 다시 쓰고 2글자 색인은 건드리지 않는다.
/// V69 시점엔 notes_bigram* 표가 아직 없다(V94 가 만든다). 색인은 V95 백필이 notes_fts 에서 통째로 다시 만든다.
pub fn fts_upsert_fts_only(tx: &Transaction, note_id: &str) -> Result<(), AppError> {
    tx.execute("DELETE FROM notes_fts WHERE note_id = ?1", [note_id])
        .map_err(db)?;
    fts_write_row(tx, note_id)?;
    Ok(())
}

/// notes_fts 에 노트 한 행을 쓴다(이미 지운 뒤). 쓴 행의 (rowid, title, body, source_body, tag_names).
/// 휴지통·없는 노트면 None.
fn fts_write_row(
    tx: &Transaction,
    note_id: &str,
) -> Result<Option<(i64, String, String, String, String)>, AppError> {
    // 휴지통 노트는 색인에 되살리지 않는다 — 노트 삭제가 fts_delete 한 뒤에도 태그·상태 같은 쓰기가
    // 여기를 부르면 색인이 부활했다(검색 쪽 필터가 가려 왔을 뿐, DRILLS-2026-10-06). 복구는
    // deleted_at 을 먼저 지운 뒤 부르므로 영향 없다.
    let trashed: bool = tx
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
            [note_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?
        .unwrap_or(false);
    if trashed {
        return Ok(None);
    }
    // 섹션 본문만 Rust 에서 합친다 — sheet 섹션은 JSON 이 아니라 상위 200행 TSV 로 색인해야
    // 해서(specs/features/sheet.md) SQL group_concat 로는 표현할 수 없다. sources/tags 집계는
    // 그대로 SQL.
    let body = crate::repo::sheet::note_body_text(
        tx,
        note_id,
        Some(crate::repo::sheet::FTS_MAX_ROWS),
    )?;
    // 나머지 열은 SQL 로 모아 Rust 로 받는다 — 같은 값을 2글자 색인에도 넣어야 해서(notes_fts 를 다시
    // note_id 로 훑으면 행 수만큼의 스캔이 하나 더 는다).
    let row: Option<(String, String, String)> = tx
        .query_row(
            r#"
            SELECT n.title,
              COALESCE((SELECT group_concat(o.body, char(10)||char(10)) FROM sources o
                        WHERE o.note_id=n.id ORDER BY o.position), ''),
              COALESCE((SELECT group_concat(t.name, ' ') FROM tags t
                        JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=n.id), '')
            FROM notes n WHERE n.id = ?1"#,
            [note_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db)?;
    let Some((title, source_body, tag_names)) = row else {
        return Ok(None);
    };
    tx.execute(
        "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![note_id, title, body, source_body, tag_names],
    )
    .map_err(db)?;
    let fts_rowid = tx.last_insert_rowid();
    Ok(Some((fts_rowid, title, body, source_body, tag_names)))
}

/// 제목만 변경될 때 — body 재집계 없이 notes_fts.title만 갱신 (Finding 23).
/// 노트가 notes_fts에 없으면 false 반환 → 호출자가 fts_upsert로 폴백.
pub fn fts_update_title(tx: &Transaction, note_id: &str, new_title: &str) -> Result<bool, AppError> {
    // 2글자 색인은 네 열의 합집합이라 제목만 바뀌어도 나머지 열이 필요하다 — 매핑 표로 rowid 를 찾고
    // 그 rowid 로 행을 읽어 갱신한다(notes_bigram_map UNIQUE 인덱스 + rowid 직접 접근).
    let Some(rowid) = map_lookup_rowid(tx, note_id)? else {
        return Ok(false);
    };
    let row: Option<(String, String, String)> = tx
        .query_row(
            "SELECT body, source_body, tag_names FROM notes_fts WHERE rowid = ?1",
            [rowid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db)?;
    let Some((body, source_body, tag_names)) = row else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE notes_fts SET title = ?1 WHERE rowid = ?2",
        rusqlite::params![new_title, rowid],
    )
    .map_err(db)?;
    bigram_index(tx, rowid, note_id, &[new_title, &body, &source_body, &tag_names])?;
    Ok(true)
}

/// 노트 삭제 시 FTS 행 제거 (CASCADE는 가상 테이블에 적용되지 않으므로 명시적).
pub fn fts_delete(tx: &Transaction, note_id: &str) -> Result<(), AppError> {
    if let Some(rowid) = map_lookup_rowid(tx, note_id)? {
        fts_and_bigram_remove_mapped(tx, rowid)?;
    }
    // 휴지통 노트는 색인에 되살리지 않는다 — 노트 삭제가 fts_delete 한 뒤에도 태그·상태 같은 쓰기가
    // 여기를 부르면 색인이 부활했다(검색 쪽 필터가 가려 왔을 뿐, DRILLS-2026-10-06). 복구는
    // deleted_at 을 먼저 지운 뒤 부르므로 영향 없다.
    let trashed: bool = tx
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
            [note_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?
        .unwrap_or(false);
    if trashed {
        return Ok(());
    }
    Ok(())
}

// ── 2글자 색인 (notes_bigram + notes_bigram_map) ─────────────────────────────

/// 텍스트의 2글자 창 — 글자·숫자가 이어진 구간 안에서만, ASCII 만 소문자화(LIKE 의 대소문자 규칙).
/// `question_search::question_terms` 가 핵심어를 만드는 글자 판정(`is_alphanumeric`)과 같아야 한다.
pub fn bigrams_into(text: &str, out: &mut BTreeSet<String>) {
    let mut prev: Option<char> = None;
    for c in text.chars() {
        if !c.is_alphanumeric() {
            prev = None;
            continue;
        }
        let c = c.to_ascii_lowercase();
        if let Some(p) = prev {
            let mut g = String::with_capacity(p.len_utf8() + c.len_utf8());
            g.push(p);
            g.push(c);
            out.insert(g);
        }
        prev = Some(c);
    }
}

/// 노트 한 개의 2글자 색인을 `cols`(notes_fts 의 title/body/source_body/tag_names 값) 로 다시 쓴다.
/// `fts_rowid` = 방금 쓴 그 노트의 notes_fts rowid — 매핑 행은 창이 없어도 항상 만든다(3자 이상 경로가 쓴다).
/// dev_seed 배치는 notes_fts 를 직접 넣은 뒤 `last_insert_rowid()` 로 이걸 부른다.
pub fn bigram_index(tx: &Transaction, fts_rowid: i64, note_id: &str, cols: &[&str]) -> Result<(), AppError> {
    bigram_remove(tx, note_id)?;
    tx.execute(
        "INSERT INTO notes_bigram_map(id, note_id) VALUES (?1, ?2)",
        rusqlite::params![fts_rowid, note_id],
    )
    .map_err(db)?;
    let mut grams = BTreeSet::new();
    for col in cols {
        bigrams_into(col, &mut grams);
    }
    if grams.is_empty() {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO notes_bigram(rowid, grams) VALUES (?1, ?2)",
        rusqlite::params![fts_rowid, join_grams(grams)],
    )
    .map_err(db)?;
    Ok(())
}

fn join_grams(grams: BTreeSet<String>) -> String {
    grams.into_iter().collect::<Vec<_>>().join(" ")
}

fn bigram_remove(tx: &Transaction, note_id: &str) -> Result<(), AppError> {
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM notes_bigram_map WHERE note_id = ?1",
            [note_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db)?;
    if let Some(id) = id {
        tx.execute("DELETE FROM notes_bigram WHERE rowid = ?1", [id])
            .map_err(db)?;
        tx.execute("DELETE FROM notes_bigram_map WHERE id = ?1", [id])
            .map_err(db)?;
    }
    Ok(())
}

fn bigram_clear(tx: &Transaction) -> Result<(), AppError> {
    tx.execute("INSERT INTO notes_bigram(notes_bigram) VALUES ('delete-all')", [])
        .map_err(db)?;
    tx.execute("DELETE FROM notes_bigram_map", []).map_err(db)?;
    Ok(())
}

/// 2글자 색인 전체를 지금의 notes_fts 에서 다시 만든다 — 마이그레이션 백필(V94·V95)·검증용. 멱등.
/// notes_fts 를 한 번 훑으며 바로 쓴다(전부 메모리에 모으지 않는다 — 10만 노트 대비).
pub fn bigram_rebuild_all(tx: &Transaction) -> Result<(), AppError> {
    bigram_clear(tx)?;
    let mut read = tx
        .prepare("SELECT rowid, note_id, title, body, source_body, tag_names FROM notes_fts")
        .map_err(db)?;
    let mut map_stmt = tx
        .prepare("INSERT OR IGNORE INTO notes_bigram_map(id, note_id) VALUES (?1, ?2)")
        .map_err(db)?;
    let mut idx_stmt = tx
        .prepare("INSERT INTO notes_bigram(rowid, grams) VALUES (?1, ?2)")
        .map_err(db)?;
    let mut rows = read.query([]).map_err(db)?;
    while let Some(r) = rows.next().map_err(db)? {
        let rowid: i64 = r.get(0).map_err(db)?;
        let note_id: String = r.get(1).map_err(db)?;
        // 같은 note_id 가 notes_fts 에 두 번 있으면(과거 결함의 잔재) 첫 행만 — UNIQUE 위반으로 백필이 죽지 않게.
        // 둘째 행은 매핑이 없어 질문 검색에서 빠진다(같은 노트가 첫 행으로 이미 잡힌다).
        if map_stmt.execute(rusqlite::params![rowid, note_id]).map_err(db)? == 0 {
            continue;
        }
        let mut grams = BTreeSet::new();
        for k in 2..=5 {
            let col: Option<String> = r.get(k).map_err(db)?;
            bigrams_into(col.as_deref().unwrap_or(""), &mut grams);
        }
        if grams.is_empty() {
            continue;
        }
        idx_stmt
            .execute(rusqlite::params![rowid, join_grams(grams)])
            .map_err(db)?;
    }
    Ok(())
}
