// repo: attachment_query — workspace gallery read endpoint (bounded page of attachments)
// Drive from attachments (newest first); reach notes by PK. Never generate thumbnails here.
use crate::db;
use crate::error::{db as dberr, AppResult};
use crate::repo::attachments;
use crate::repo::folders;
use crate::repo::paths;
use crate::repo::search::escape_like;
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use std::path::Path;

/// Default page size when the client omits `limit`.
pub const ATTACHMENT_QUERY_DEFAULT_LIMIT: i64 = 60;
/// Hard upper bound on a single window — keeps IPC + stat() work bounded.
pub const ATTACHMENT_QUERY_MAX_LIMIT: i64 = 300;

#[derive(Debug, Clone, Default)]
pub struct AttachmentQuery {
    /// Empty = every kind except `internal`. Non-empty = exact kind filter.
    pub kinds: Vec<String>,
    /// Substring match on `attachments.name` (escaped LIKE). `None` / blank = no name filter.
    pub query: Option<String>,
    pub offset: i64,
    pub limit: Option<i64>,
    /// `None` = active workspace (same as search).
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentQueryItem {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub kind: String,
    pub rel_path: Option<String>,
    pub size_bytes: Option<i64>,
    pub created_at: String,
    pub title: String,
    pub year: i64,
    /// `Some` only when `{rel_path}.thumb.jpg` already exists on disk — never generated here.
    pub thumb_rel_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentQueryResult {
    pub items: Vec<AttachmentQueryItem>,
}

/// Build the gallery SQL (exported for shape-lock tests). Filters stay on `attachments`;
/// notes are joined by primary key with workspace + soft-delete predicates.
///
/// `kind_count == 0` is the "every kind except internal" page, and it is NOT written as
/// `kind IN (…every kind…)`. Measured at 30,000 attachments: the IN form cannot take its
/// order from idx_attachments_kind_created (one range per kind), so SQLite sorts every
/// matching row before applying LIMIT — 373ms for the first 60 rows. Pinning
/// idx_attachments_created and testing `kind <> 'internal'` leaves only the a.id tiebreak to
/// sort ("RIGHT PART OF ORDER BY"), so LIMIT stops early: 93ms. INDEXED BY is deliberate —
/// without it the planner (which after boot has no statistics at all, see
/// db::scrub_zero_row_stats) drives from notes instead and the sort comes back.
pub(crate) fn gallery_sql(kind_count: usize, has_name: bool) -> String {
    let (from_clause, kind_clause) = if kind_count == 0 {
        (
            "attachments a INDEXED BY idx_attachments_created".to_string(),
            "a.kind <> 'internal'".to_string(),
        )
    } else {
        let kind_ph = (0..kind_count).map(|_| "?").collect::<Vec<_>>().join(", ");
        ("attachments a".to_string(), format!("a.kind IN ({kind_ph})"))
    };

    let name_clause = if has_name {
        " AND a.name LIKE ? ESCAPE '\\'"
    } else {
        ""
    };

    format!(
        // W7-f: gallery is a browsing surface (like dashboard board/calendar/timeline), so
        // archived notes' attachments stay out of it too — search_notes still finds the note.
        "SELECT a.id, a.note_id, a.name, a.kind, a.rel_path, a.size_bytes, a.created_at,
                n.title, n.year
           FROM {from_clause}
           JOIN notes n ON n.id = a.note_id
          WHERE {kind_clause}
            AND n.deleted_at IS NULL
            AND n.archived_at IS NULL
            AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?)
            {name_clause}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ? OFFSET ?"
    )
}

/// Workspace gallery page: bounded attachment rows, newest insertion first.
///
/// Filesystem work is limited to at most `limit` `is_file()` checks for existing thumbnails.
/// This function never generates thumbnails.
pub fn query(
    conn: &Connection,
    data_dir: &Path,
    q: AttachmentQuery,
) -> AppResult<AttachmentQueryResult> {
    let offset = q.offset.max(0);
    let limit = q
        .limit
        .unwrap_or(ATTACHMENT_QUERY_DEFAULT_LIMIT)
        .clamp(0, ATTACHMENT_QUERY_MAX_LIMIT);
    if limit == 0 {
        return Ok(AttachmentQueryResult { items: Vec::new() });
    }

    let ws = match &q.workspace_id {
        Some(w) => w.clone(),
        None => folders::active_workspace_id(conn)?,
    };

    // Empty = "everything except internal", expressed as a predicate rather than an IN list
    // so the created_at index can order the page (see gallery_sql).
    let kinds: Vec<String> = q.kinds;

    let name_pat = q
        .query
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", escape_like(s)));

    let sql = gallery_sql(kinds.len(), name_pat.is_some());

    let mut binds: Vec<Value> = kinds.into_iter().map(Value::Text).collect();
    binds.push(Value::Text(ws));
    if let Some(pat) = name_pat {
        binds.push(Value::Text(pat));
    }
    binds.push(Value::Integer(limit));
    binds.push(Value::Integer(offset));

    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })
        .map_err(dberr)?;

    let att_root = db::attachments_dir(data_dir);
    let mut items = Vec::new();
    for row in rows {
        let (id, note_id, name, kind, rel_path, size_bytes, created_at, title, year) =
            row.map_err(dberr)?;
        let thumb_rel_path = rel_path.as_ref().and_then(|rel| {
            let thumb_rel = attachments::thumb_rel_for(rel);
            let clean = paths::safe_rel(&thumb_rel).ok()?;
            if att_root.join(clean).is_file() {
                Some(thumb_rel)
            } else {
                None
            }
        });
        items.push(AttachmentQueryItem {
            id,
            note_id,
            name,
            kind,
            rel_path,
            size_bytes,
            created_at,
            title,
            year,
            thumb_rel_path,
        });
    }

    Ok(AttachmentQueryResult { items })
}

/// Image-attachment rows for the given ids (gallery on-screen thumbs).
/// Read-only DB work — command layer drops the lock before any decode.
/// Cap is enforced by the caller (ATTACHMENT_QUERY_MAX_LIMIT).
pub fn thumb_candidates_for_ids(
    conn: &Connection,
    ids: &[String],
) -> AppResult<Vec<(String, String)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (0..ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, rel_path FROM attachments
          WHERE id IN ({placeholders})
            AND kind = 'image'
            AND rel_path IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let binds: Vec<Value> = ids.iter().cloned().map(Value::Text).collect();
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(dberr)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, rel) = row.map_err(dberr)?;
        let ext = Path::new(&rel)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if ext.eq_ignore_ascii_case("svg") {
            continue;
        }
        out.push((id, rel));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::util::now_iso;
    use rusqlite::{params, Connection};

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    fn seed_note(conn: &Connection, id: &str, folder_id: &str, title: &str) {
        let now = now_iso();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1900, ?4, ?4)",
            params![id, folder_id, title, now],
        )
        .unwrap();
    }

    fn seed_attachment(
        conn: &Connection,
        id: &str,
        note_id: &str,
        name: &str,
        kind: &str,
        created_at: &str,
    ) {
        // CHECK: link/internal require url + null rel_path; file kinds the inverse.
        let (rel, url): (Option<String>, Option<String>) = if kind == "link" || kind == "internal" {
            (None, Some(format!("https://example.test/{id}")))
        } else {
            (Some(format!("{note_id}/{id}.bin")), None)
        };
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7)",
            params![id, note_id, name, kind, rel, url, created_at],
        )
        .unwrap();
    }

    fn default_folder(conn: &Connection) -> String {
        conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap()
    }

    fn empty_data_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn paging_is_stable_newest_first() {
        let conn = setup_db();
        let folder = default_folder(&conn);
        seed_note(&conn, "n1", &folder, "Host");
        // 5 attachments, newest first by created_at then id.
        let rows = [
            ("a1", "2020-01-01T00:00:00Z"),
            ("a2", "2020-01-02T00:00:00Z"),
            ("a3", "2020-01-03T00:00:00Z"),
            ("a4", "2020-01-04T00:00:00Z"),
            ("a5", "2020-01-05T00:00:00Z"),
        ];
        for (id, ts) in rows {
            seed_attachment(&conn, id, "n1", id, "image", ts);
        }
        let data = empty_data_dir();
        let page1 = query(
            &conn,
            data.path(),
            AttachmentQuery {
                limit: Some(2),
                offset: 0,
                ..Default::default()
            },
        )
        .unwrap();
        let page2 = query(
            &conn,
            data.path(),
            AttachmentQuery {
                limit: Some(2),
                offset: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let page3 = query(
            &conn,
            data.path(),
            AttachmentQuery {
                limit: Some(2),
                offset: 4,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            page1.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["a5", "a4"]
        );
        assert_eq!(
            page2.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["a3", "a2"]
        );
        assert_eq!(
            page3.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["a1"]
        );

        let mut all: Vec<&str> = page1
            .items
            .iter()
            .chain(page2.items.iter())
            .chain(page3.items.iter())
            .map(|i| i.id.as_str())
            .collect();
        let expected = vec!["a5", "a4", "a3", "a2", "a1"];
        assert_eq!(all, expected);
        // no repeats
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 5);
    }

    #[test]
    fn limit_clamped_and_defaulted() {
        let conn = setup_db();
        let folder = default_folder(&conn);
        seed_note(&conn, "n1", &folder, "Host");
        // Seed more than default so default limit is observable.
        for i in 0..70 {
            seed_attachment(
                &conn,
                &format!("att{i:03}"),
                "n1",
                &format!("f{i}"),
                "doc",
                &format!("2020-01-01T00:{i:02}:00Z"),
            );
        }
        let data = empty_data_dir();

        let def = query(
            &conn,
            data.path(),
            AttachmentQuery {
                limit: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(def.items.len(), ATTACHMENT_QUERY_DEFAULT_LIMIT as usize);

        let over = query(
            &conn,
            data.path(),
            AttachmentQuery {
                limit: Some(ATTACHMENT_QUERY_MAX_LIMIT + 500),
                ..Default::default()
            },
        )
        .unwrap();
        // We only seeded 70, so clamp is not fully visible as 300 rows, but the clamp path
        // must not error and must not exceed what was asked after clamp.
        assert!(over.items.len() <= ATTACHMENT_QUERY_MAX_LIMIT as usize);
        assert_eq!(over.items.len(), 70);

        // Seed enough to hit the hard cap (ids + created_at keep order stable).
        for i in 70..(ATTACHMENT_QUERY_MAX_LIMIT as usize + 20) {
            seed_attachment(
                &conn,
                &format!("att{i:04}"),
                "n1",
                &format!("f{i}"),
                "doc",
                &format!("2021-{:02}-{:02}T00:00:00Z", (i % 12) + 1, (i % 28) + 1),
            );
        }
        let capped = query(
            &conn,
            data.path(),
            AttachmentQuery {
                limit: Some(10_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(capped.items.len(), ATTACHMENT_QUERY_MAX_LIMIT as usize);
    }

    #[test]
    fn soft_deleted_and_other_workspace_excluded() {
        let mut conn = setup_db();
        let folder = default_folder(&conn);
        seed_note(&conn, "alive", &folder, "Alive");
        seed_note(&conn, "trashed", &folder, "Trashed");
        conn.execute(
            "UPDATE notes SET deleted_at=?1 WHERE id='trashed'",
            params![now_iso()],
        )
        .unwrap();
        seed_attachment(&conn, "a-alive", "alive", "keep", "image", "2020-06-01T00:00:00Z");
        seed_attachment(
            &conn,
            "a-trash",
            "trashed",
            "gone",
            "image",
            "2020-06-02T00:00:00Z",
        );

        // Other workspace
        let other = crate::repo::workspaces::create(&mut conn, "Other").unwrap();
        let other_folder: String = conn
            .query_row(
                "SELECT id FROM folders WHERE workspace_id=?1 LIMIT 1",
                [&other.id],
                |r| r.get(0),
            )
            .unwrap();
        seed_note(&conn, "other-note", &other_folder, "Elsewhere");
        seed_attachment(
            &conn,
            "a-other",
            "other-note",
            "foreign",
            "image",
            "2020-06-03T00:00:00Z",
        );

        let data = empty_data_dir();
        let r = query(
            &conn,
            data.path(),
            AttachmentQuery {
                ..Default::default()
            },
        )
        .unwrap();
        let ids: Vec<&str> = r.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a-alive"]);
        assert!(!ids.contains(&"a-trash"));
        assert!(!ids.contains(&"a-other"));

        // Anti-vacuity: without deleted_at / workspace predicates the excluded rows appear.
        // (Report: we confirmed this fails without those predicates, then restored.)
        {
            let sql_bad = "SELECT a.id FROM attachments a
                 JOIN notes n ON n.id = a.note_id
                 WHERE a.kind IN ('image')
                 ORDER BY a.created_at DESC, a.id DESC";
            let mut stmt = conn.prepare(sql_bad).unwrap();
            let bad: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            assert!(
                bad.contains(&"a-trash".to_string()) && bad.contains(&"a-other".to_string()),
                "anti-vacuity: unfiltered join must include trash + other-ws (got {bad:?})"
            );
        }
    }

    #[test]
    fn empty_kinds_excludes_internal_includes_file_kinds() {
        let conn = setup_db();
        let folder = default_folder(&conn);
        seed_note(&conn, "n1", &folder, "Host");
        seed_note(&conn, "n2", &folder, "Target");
        let kinds = [
            ("k-image", "image"),
            ("k-doc", "doc"),
            ("k-audio", "audio"),
            ("k-link", "link"),
            ("k-note", "note"),
            ("k-internal", "internal"),
        ];
        for (i, (id, kind)) in kinds.iter().enumerate() {
            seed_attachment(
                &conn,
                id,
                "n1",
                id,
                kind,
                &format!("2020-01-{:02}T00:00:00Z", i + 1),
            );
        }
        // internal needs a valid shape — seed_attachment already inserts; kind is enough for filter.
        let data = empty_data_dir();
        let r = query(
            &conn,
            data.path(),
            AttachmentQuery {
                kinds: vec![],
                ..Default::default()
            },
        )
        .unwrap();
        let got: Vec<&str> = r.items.iter().map(|i| i.kind.as_str()).collect();
        for k in ["image", "doc", "audio", "link", "note"] {
            assert!(got.contains(&k), "expected kind {k} in {got:?}");
        }
        assert!(!got.contains(&"internal"));
        assert_eq!(r.items.len(), 5);
    }

    #[test]
    fn name_filter_substring_case_insensitive_and_escapes_wildcards() {
        let conn = setup_db();
        let folder = default_folder(&conn);
        seed_note(&conn, "n1", &folder, "Host");
        seed_attachment(
            &conn,
            "m1",
            "n1",
            "Photo 100pct",
            "image",
            "2020-01-01T00:00:00Z",
        );
        seed_attachment(
            &conn,
            "m2",
            "n1",
            "Report 100%",
            "doc",
            "2020-01-02T00:00:00Z",
        );
        seed_attachment(
            &conn,
            "m3",
            "n1",
            "Other",
            "image",
            "2020-01-03T00:00:00Z",
        );
        seed_attachment(
            &conn,
            "m4",
            "n1",
            "UPPER case Mix",
            "image",
            "2020-01-04T00:00:00Z",
        );
        let data = empty_data_dir();

        let r = query(
            &conn,
            data.path(),
            AttachmentQuery {
                query: Some("upper".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].id, "m4");

        // Literal % must not match everything.
        let r = query(
            &conn,
            data.path(),
            AttachmentQuery {
                query: Some("100%".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].id, "m2");
        assert_eq!(r.items[0].name, "Report 100%");

        // Underscore is also escaped — a query of "100_" must not act as single-char wildcard
        // matching "100pct".
        let r = query(
            &conn,
            data.path(),
            AttachmentQuery {
                query: Some("100_".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.items.is_empty());
    }

    /// Shape lock: gallery SQL must drive from attachments and join notes by PK.
    /// Do not assert EXPLAIN QUERY PLAN (vacuous on empty in-memory DBs).
    #[test]
    fn gallery_sql_drives_from_attachments_not_notes_outer() {
        for kind_count in [0usize, 1, 5] {
            for has_name in [false, true] {
                let sql = gallery_sql(kind_count, has_name);
                let norm = sql.split_whitespace().collect::<Vec<_>>().join(" ");
                let from_ok = if kind_count == 0 {
                    // 전체 페이지는 created_at 인덱스를 고정해야 LIMIT 이 일찍 끊는다
                    // (실측 30k: IN 목록 373ms vs 고정 93ms). 커버리지는 gallery_sql 주석 참조.
                    norm.contains(
                        "FROM attachments a INDEXED BY idx_attachments_created JOIN notes n ON n.id = a.note_id",
                    ) && norm.contains("WHERE a.kind <> 'internal'")
                } else {
                    norm.contains("FROM attachments a JOIN notes n ON n.id = a.note_id")
                };
                assert!(
                    from_ok,
                    "must drive from attachments, join notes by PK. Got: {norm}"
                );
                assert!(
                    !norm.contains("FROM notes n JOIN attachments"),
                    "must not drive from notes. Got: {norm}"
                );
                assert!(
                    norm.contains("ORDER BY a.created_at DESC, a.id DESC"),
                    "stable newest-first order. Got: {norm}"
                );
                assert!(
                    norm.contains("n.deleted_at IS NULL"),
                    "soft-delete predicate required. Got: {norm}"
                );
                assert!(
                    norm.contains("n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?)"),
                    "workspace via folder subquery. Got: {norm}"
                );
                if has_name {
                    assert!(
                        norm.contains("a.name LIKE ? ESCAPE '\\'"),
                        "name filter with ESCAPE. Got: {norm}"
                    );
                } else {
                    assert!(!norm.contains("a.name LIKE"), "no name clause. Got: {norm}");
                }
            }
        }
    }
}
