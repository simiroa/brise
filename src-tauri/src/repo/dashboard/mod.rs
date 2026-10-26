// repo: dashboard — docs/DASHBOARD.md §3–§4 server-side query commands.
//
// Module layout (behavior-preserving split of the former monolithic dashboard.rs):
// - board: kanban + checkbox parse/toggle + pin/schedule sort
// - calendar: month event-span query
// - timeline: year-window items + eras + folder-year buckets
// - dateord: proleptic YMD ordinal arithmetic shared by board/calendar
// This file keeps workspace helpers + note_cover_image, and re-exports the
// public API so external paths (`crate::repo::dashboard::X`) stay stable.
//
// Governing rules:
// - All reads are workspace-scoped SQL (no client corpus reuse; docs/SCALABILITY.md §0).
// - Only write is todo_toggle → reuses repo::sections::update (FTS + updated_at; DATA-WRITES.md).
// - body_md is Tiptap HTML in production (taskItem markup). The Wave 3 plan wording mentions
//   GFM "- [ ]" lines; we accept both formats. kind='diagram' (mermaid source) is never scanned.
//
// Checkbox index contract: `line_index` is the 0-based ordinal of the checkbox *within that
// section's body* (not a raw source line number). dashboard_board returns it; todo_toggle
// consumes the same value. For HTML this matches repo::checklist::toggle_at's local_index;
// for GFM it is the n-th "- [ ]"/"- [x]" match in document order.
use crate::db;
use crate::error::{db as dberr, AppError, AppResult};
use crate::repo::{attachments, paths};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

mod board;
mod calendar;
pub mod dateord;
mod graph;
mod timeline;

pub use board::{
    board, board_note_cmp, due_reminders, parse_checkboxes, todo_toggle, toggle_checkbox_in_body,
    BoardColumn, BoardNote, BoardResult, BoardTodoItem, ParsedCheckbox, TodoToggleResult,
    BOARD_NOTE_CAP,
};
pub use calendar::{calendar, CalendarItem, CalendarResult};
pub use graph::{graph, GraphEdge, GraphNode, GraphResult, GRAPH_EDGE_CAP, GRAPH_NODE_CAP};
pub use timeline::{
    timeline, TimelineEra, TimelineNoteItem, TimelineResult, TimelineYearBucket, TIMELINE_ITEM_CAP,
};

// ── Shared workspace helpers ─────────────────────────────────────────────────

pub(super) fn ensure_workspace(conn: &Connection, workspace_id: &str) -> AppResult<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM workspaces WHERE id=?1",
            [workspace_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound(format!(
            "workspace not found: {workspace_id}"
        )));
    }
    Ok(())
}

// ── note_cover_image ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CoverImageResult {
    pub note_id: String,
    /// Tile-ready path — same path clients feed into
    /// convertFileSrc(`${attachments_base_dir}/${rel_path}`). This is the *thumbnail*
    /// (`{original}.thumb.jpg`), not the original raster: SCALABILITY.md §3 — a 32/84px
    /// `<img>` pointed at a 12MP original decodes the full bitmap (+298MB measured vs +19MB
    /// with the thumb). SVGs pass through as-is (vector, no thumb is ever generated for them).
    /// None when there's no image attachment, OR when one exists but its thumbnail hasn't
    /// been generated yet — this command never generates one (mirrors
    /// attachments/tileImage.ts::pickTileImageRel: no original-image fallback).
    pub rel_path: Option<String>,
    pub attachment_id: Option<String>,
}

/// SVG passes through (vector; thumbs::wants_thumbnail never generates a thumb for it).
/// Raster originals only resolve to their existing `{rel}.thumb.jpg` — never the original.
fn tile_cover_rel(data_dir: &Path, rel: &str) -> Option<String> {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if ext.eq_ignore_ascii_case("svg") {
        return Some(rel.to_string());
    }
    let thumb_rel = attachments::thumb_rel_for(rel);
    let att_root = db::attachments_dir(data_dir);
    let clean = paths::safe_rel(&thumb_rel).ok()?;
    att_root.join(clean).is_file().then_some(thumb_rel)
}

/// Live (not soft-deleted) check + first-image lookup shared by the single and batch forms.
/// `prepare_cached` keeps the batch loop at one statement compile each.
fn note_alive(conn: &Connection, note_id: &str) -> AppResult<bool> {
    conn.prepare_cached("SELECT 1 FROM notes WHERE id=?1 AND deleted_at IS NULL")
        .map_err(dberr)?
        .exists([note_id])
        .map_err(dberr)
}

fn cover_of_live_note(
    conn: &Connection,
    data_dir: &Path,
    note_id: &str,
) -> AppResult<CoverImageResult> {
    let row: Option<(String, String)> = conn
        .prepare_cached(
            "SELECT id, rel_path FROM attachments
             WHERE note_id=?1 AND kind='image' AND rel_path IS NOT NULL
             ORDER BY position ASC, created_at ASC
             LIMIT 1",
        )
        .map_err(dberr)?
        .query_row([note_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(dberr)?;
    Ok(match row {
        Some((id, rel)) => CoverImageResult {
            note_id: note_id.to_string(),
            rel_path: tile_cover_rel(data_dir, &rel),
            attachment_id: Some(id),
        },
        None => CoverImageResult {
            note_id: note_id.to_string(),
            rel_path: None,
            attachment_id: None,
        },
    })
}

pub fn note_cover_image(
    conn: &Connection,
    data_dir: &Path,
    note_id: &str,
) -> AppResult<CoverImageResult> {
    // W7-f: archived_at intentionally NOT checked — single-note-by-id lookup (e.g. rendering a
    // cover for a note reached via search or the archive view), not a listing surface. Mirrors
    // note_get/note_summary's deleted_at-only posture.
    if !note_alive(conn, note_id)? {
        return Err(AppError::NotFound(format!("note not found: {note_id}")));
    }
    cover_of_live_note(conn, data_dir, note_id)
}

/// Upper bound on one `note_cover_images` call — same ceiling as attachment_thumbs_for_ids
/// (ATTACHMENT_QUERY_MAX_LIMIT). The board only asks for cards that scrolled into view, so a
/// real batch is a screenful; this just keeps one call from becoming unbounded work.
pub const NOTE_COVER_BATCH_MAX: usize = 300;

/// Batch form of `note_cover_image` for the kanban (one IPC per visibility batch instead of one
/// per card). Missing / deleted notes are skipped rather than failing the batch — one stale id
/// must not blank every other card's cover. Ids past NOTE_COVER_BATCH_MAX are dropped.
pub fn note_cover_images(
    conn: &Connection,
    data_dir: &Path,
    note_ids: &[String],
) -> AppResult<Vec<CoverImageResult>> {
    let mut out = Vec::new();
    for note_id in note_ids.iter().take(NOTE_COVER_BATCH_MAX) {
        if note_alive(conn, note_id)? {
            out.push(cover_of_live_note(conn, data_dir, note_id)?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes;
    use crate::util::now_iso;
    use rusqlite::{params, Connection};

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn ws_and_folder(conn: &Connection) -> (String, String) {
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let folder: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&ws],
                |r| r.get(0),
            )
            .unwrap();
        (ws, folder)
    }

    // ── cover + activity ───────────────────────────────────────────────────

    #[test]
    fn note_cover_image_first_image_by_position() {
        let mut conn = setup_db();
        let (_ws, folder) = ws_and_folder(&conn);
        let d = notes::create(&mut conn, &folder, Some("Pic".into()), None).unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a1', ?1, 'doc.pdf', 'doc', 'n/doc.pdf', NULL, 1, 0, ?2)",
            params![d.note.id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a2', ?1, 'img.png', 'image', 'n/img.png', NULL, 1, 1, ?2)",
            params![d.note.id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a3', ?1, 'earlier.png', 'image', 'n/earlier.png', NULL, 1, 0, ?2)",
            params![d.note.id, now],
        )
        .unwrap();
        // position 0 image should win over position 1 image; doc is skipped
        // a3 has position 0, a2 has 1 — but a1 doc also pos 0. ORDER BY position, created_at —
        // both a1 and a3 at pos 0; a1 is doc so skipped, a3 image at pos 0 wins... wait a3 also pos 0.
        // Actually a1 is doc, a3 is image at pos 0. Query filters kind=image so a3 wins.
        // No thumbnail has been generated on disk for a3 — SCALABILITY.md §3: this command never
        // falls back to the (potentially multi-megapixel) original, so rel_path is None here.
        let data = tempfile::tempdir().unwrap();
        let cover = note_cover_image(&conn, data.path(), &d.note.id).unwrap();
        assert_eq!(cover.rel_path, None);
        assert_eq!(cover.attachment_id.as_deref(), Some("a3"));
    }

    #[test]
    fn note_cover_image_returns_thumb_rel_when_thumbnail_exists_on_disk() {
        let mut conn = setup_db();
        let (_ws, folder) = ws_and_folder(&conn);
        let d = notes::create(&mut conn, &folder, Some("Pic".into()), None).unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a1', ?1, 'img.png', 'image', 'n/img.png', NULL, 1, 0, ?2)",
            params![d.note.id, now],
        )
        .unwrap();

        let data = tempfile::tempdir().unwrap();
        let att_root = db::attachments_dir(data.path());
        std::fs::create_dir_all(att_root.join("n")).unwrap();
        std::fs::write(att_root.join("n/img.png.thumb.jpg"), b"fake-jpeg").unwrap();

        let cover = note_cover_image(&conn, data.path(), &d.note.id).unwrap();
        assert_eq!(cover.rel_path.as_deref(), Some("n/img.png.thumb.jpg"));
    }

    #[test]
    fn note_cover_image_svg_passes_through_without_thumb() {
        let mut conn = setup_db();
        let (_ws, folder) = ws_and_folder(&conn);
        let d = notes::create(&mut conn, &folder, Some("Vector".into()), None).unwrap();
        let now = now_iso();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a1', ?1, 'icon.svg', 'image', 'n/icon.svg', NULL, 1, 0, ?2)",
            params![d.note.id, now],
        )
        .unwrap();

        // No thumb ever exists for SVGs (thumbs::wants_thumbnail excludes them) — must still
        // resolve to the original since it's a vector, not a raster decode blowup.
        let data = tempfile::tempdir().unwrap();
        let cover = note_cover_image(&conn, data.path(), &d.note.id).unwrap();
        assert_eq!(cover.rel_path.as_deref(), Some("n/icon.svg"));
    }

    #[test]
    fn note_cover_images_batches_and_skips_missing_or_deleted_notes() {
        let mut conn = setup_db();
        let (_ws, folder) = ws_and_folder(&conn);
        let pic = notes::create(&mut conn, &folder, Some("Pic".into()), None).unwrap();
        let plain = notes::create(&mut conn, &folder, Some("Plain".into()), None).unwrap();
        let gone = notes::create(&mut conn, &folder, Some("Gone".into()), None).unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('a1', ?1, 'img.png', 'image', 'n/img.png', NULL, 1, 0, ?2)",
            params![pic.note.id, now_iso()],
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET deleted_at=?2 WHERE id=?1",
            params![gone.note.id, now_iso()],
        )
        .unwrap();

        let data = tempfile::tempdir().unwrap();
        let att_root = db::attachments_dir(data.path());
        std::fs::create_dir_all(att_root.join("n")).unwrap();
        std::fs::write(att_root.join("n/img.png.thumb.jpg"), b"fake-jpeg").unwrap();

        let ids = vec![
            pic.note.id.clone(),
            plain.note.id.clone(),
            gone.note.id.clone(),
            "no-such-note".to_string(),
        ];
        let covers = note_cover_images(&conn, data.path(), &ids).unwrap();
        assert_eq!(covers.len(), 2, "deleted + unknown ids are skipped, not an error");
        assert_eq!(covers[0].note_id, pic.note.id);
        assert_eq!(covers[0].rel_path.as_deref(), Some("n/img.png.thumb.jpg"));
        assert_eq!(covers[1].note_id, plain.note.id);
        assert_eq!(covers[1].rel_path, None);

        let many: Vec<String> = (0..NOTE_COVER_BATCH_MAX + 5)
            .map(|_| pic.note.id.clone())
            .collect();
        assert_eq!(
            note_cover_images(&conn, data.path(), &many).unwrap().len(),
            NOTE_COVER_BATCH_MAX
        );
    }
}
