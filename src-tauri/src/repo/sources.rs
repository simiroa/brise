// repo: sources (읽기 전용 원문 사료) — commands/sources.yaml
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::Source;
use crate::repo::fts;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;


pub fn load_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<Source>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, ext, body, position, truncated FROM sources
             WHERE note_id = ?1 ORDER BY position",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([note_id], |r| {
            Ok(Source {
                id: r.get(0)?,
                name: r.get(1)?,
                ext: r.get(2)?,
                body: r.get(3)?,
                position: r.get(4)?,
                truncated: r.get(5)?,
            })
        })
        .map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

fn require_note(conn: &Connection, note_id: &str) -> AppResult<()> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("note not found: {note_id}")))
    }
}

fn next_pos(conn: &Connection, note_id: &str) -> AppResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM sources WHERE note_id=?1",
        [note_id],
        |r| r.get(0),
    )
    .map_err(dberr)
}

fn insert(
    conn: &mut Connection,
    note_id: &str,
    name: &str,
    ext: &str,
    body: &str,
    truncated: bool,
) -> AppResult<Source> {
    let pos = next_pos(conn, note_id)?;
    let id = new_id();
    let now = now_iso();
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute(
        "INSERT INTO sources(id, note_id, name, ext, body, position, created_at, updated_at, truncated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
        params![id, note_id, name, ext, body, pos, now, truncated],
    )
    .map_err(dberr)?;
    fts::fts_upsert(&tx, note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(Source {
        id,
        name: name.to_string(),
        ext: ext.to_string(),
        body: body.to_string(),
        position: pos,
        truncated,
    })
}

pub fn add_text(conn: &mut Connection, note_id: &str, name: &str, body: &str) -> AppResult<Source> {
    require_note(conn, note_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("source name is empty".to_string()));
    }
    let ext = ext_from_name(name).unwrap_or_else(|| "TXT".to_string());
    // 붙여넣은 본문은 추출기를 거치지 않으므로 잘릴 일이 없다.
    insert(conn, note_id, name, &ext, body, false)
}

pub fn add_file(conn: &mut Connection, data_dir: &Path, note_id: &str, file_path: &str, original_policy: Option<&str>) -> AppResult<Source> {
    require_note(conn, note_id)?;
    let path = Path::new(file_path);
    // 파일 크기 게이트는 없다 — 상한은 `extraction` 이 형식별로 갖는다(zip 계열은 압축 해제
    // 누적량, pdf 만 파일 크기). 여기 있던 10MB 는 잰 대상이 틀렸을 뿐 아니라 세 관문 중
    // 이 하나에만 있어서, 같은 파일이 섹션 가져오기로는 통과하고 사료로는 막혔다.
    let (body, truncated) = crate::repo::extraction::extract_markdown(file_path)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("source")
        .to_string();
    let ext_lower = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let ext = ext_lower.to_uppercase();

    // 트랜잭션 수동 제어는 insert가 내부적으로 하므로, 여기서는 그냥 순차적으로 호출.
    // 어차피 insert와 attachments::add_file은 각각 트랜잭션이나, 원본 보관이 실패하면 Source를 추가하지 않아야 할까?
    // "같은 tx 흐름에서" 라고 했으므로, add_file 내부 로직을 tx 묶어야 할 수도 있지만, 
    // insert가 현재 자체 tx를 생성하므로, insert와 add_file_tx를 나눠야 함.
    // 간단히 insert 를 호출한 후, 실패시 롤백하기보다는 insert가 성공한 후에 attachment 추가.
    let src = insert(conn, note_id, &name, &ext, &body, truncated)?;

    if let Some("keep") = original_policy {
        // 복사할지 참조할지는 **여기서 정하지 않는다** — add_file_from_disk 가 크기(REF_THRESHOLD_BYTES)
        // 와 설정을 보고 한 곳에서 판정한다. 예전에는 이 파일만 크기를 봐서, 같은 파일이 노트에
        // 끌어다 놓으면 복사되고 사료로 넣으면 참조되는 식으로 갈렸다.
        let kept =
            crate::repo::attachments::add_file_from_disk(conn, data_dir, note_id, file_path, None);
        if let Err(e) = kept {
            // attachment 실패 시 삽입된 source 삭제 롤백 시뮬레이션
            let _ = delete(conn, &src.id);
            return Err(e);
        }
    }
    
    Ok(src)
}

pub fn rename(conn: &mut Connection, id: &str, name: &str) -> AppResult<Source> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("source name is empty".to_string()));
    }
    let n = conn
        .execute(
            "UPDATE sources SET name=?1, updated_at=?2 WHERE id=?3",
            params![name, now_iso(), id],
        )
        .map_err(dberr)?;
    if n == 0 {
        return Err(AppError::NotFound(format!("source not found: {id}")));
    }
    let note_id: String = conn
        .query_row("SELECT note_id FROM sources WHERE id=?1", [id], |r| r.get(0))
        .map_err(dberr)?;
    // 이름은 FTS 대상 아님 — upsert 불필요.
    let _ = note_id;
    conn.query_row(
        "SELECT id, name, ext, body, position, truncated FROM sources WHERE id=?1",
        [id],
        |r| {
            Ok(Source {
                id: r.get(0)?,
                name: r.get(1)?,
                ext: r.get(2)?,
                body: r.get(3)?,
                position: r.get(4)?,
                truncated: r.get(5)?,
            })
        },
    )
    .map_err(dberr)
}

pub fn delete(conn: &mut Connection, id: &str) -> AppResult<bool> {
    let note_id: Option<String> = conn
        .query_row("SELECT note_id FROM sources WHERE id=?1", [id], |r| r.get(0))
        .optional()
        .map_err(dberr)?;
    let note_id = note_id.ok_or_else(|| AppError::NotFound(format!("source not found: {id}")))?;
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("DELETE FROM sources WHERE id=?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "sources", id)?;
    fts::fts_upsert(&tx, &note_id)?;
    tx.commit().map_err(dberr)?;
    Ok(true)
}

fn ext_from_name(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::params;
    use std::io::Write;

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = crate::util::now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES ('note1', ?1, 'title', 1000, ?2, ?2)",
            params![folder_id, now],
        )
        .unwrap();
        conn
    }

    /// 오너가 실제로 막힌 문. 여기 있던 10MB 파일 크기 게이트는 잰 대상이 틀렸다 — pptx 는
    /// zip 이라 슬라이드 XML 만 풀고, 1GB 짜리의 대부분은 열어보지도 않는 임베드 미디어다.
    /// 이 테스트는 "파일이 상한보다 커도 푸는 양이 작으면 통과한다" 를 못박는다.
    #[test]
    fn add_file_accepts_a_large_pptx_whose_slides_are_small() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();

        // 12MB 짜리 pptx — 옛 게이트(10MB)라면 여기서 잘렸다. 텍스트는 한 줄뿐이다.
        let path = dir.path().join("deck.pptx");
        let mut zw = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zw.start_file("ppt/slides/slide1.xml", opts).unwrap();
        zw.write_all(br#"<p:sld xmlns:a="ns"><p:sp><a:t>Hello</a:t></p:sp></p:sld>"#)
            .unwrap();
        // Stored(무압축)라 파일 크기가 실제로 12MB 가 된다 — 크기 게이트가 살아 있으면 반드시 걸린다.
        zw.start_file("ppt/media/image1.png", opts).unwrap();
        zw.write_all(&vec![0u8; 12 * 1024 * 1024]).unwrap();
        zw.finish().unwrap();

        assert!(
            std::fs::metadata(&path).unwrap().len() > 10 * 1024 * 1024,
            "픽스처가 옛 10MB 게이트를 넘겨야 이 테스트가 의미가 있다"
        );

        let src = add_file(&mut conn, dir.path(), "note1", path.to_str().unwrap(), None).unwrap();
        assert!(src.body.contains("Hello"), "슬라이드 텍스트가 들어와야 한다: {:?}", src.body);
        assert!(!src.truncated, "상한 안쪽인데 잘렸다고 저장됐다");
    }

    /// 잘린 사실은 **행에 남아야** 한다 — 본문만 저장하면 다시 열었을 때 전문인 척한다.
    #[test]
    fn add_file_records_that_the_body_was_truncated() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        std::fs::write(&path, "가".repeat(400_000)).unwrap(); // 1.2MB > 1MB cap

        let src = add_file(&mut conn, dir.path(), "note1", path.to_str().unwrap(), None).unwrap();
        assert!(src.truncated, "1MB 를 넘겼는데 잘렸다고 보고하지 않았다");
        // 다시 읽어도(= DB 왕복) 같은 말을 한다.
        let reloaded = load_for_note(&conn, "note1").unwrap();
        assert!(reloaded[0].truncated, "절단 사실이 DB 에 남지 않았다");
        assert!(!add_text(&mut conn, "note1", "붙여넣기.txt", "짧은 본문").unwrap().truncated);
    }
}
