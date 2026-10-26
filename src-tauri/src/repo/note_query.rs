// repo: note_query — single sidebar read endpoint (folder/year/fav/tags/region/status/coords)
// Pure extraction from notes.rs (Wave A-4). Behaviour unchanged; tests live here with the query.
use crate::error::{db as dberr, AppError, AppResult};
use crate::models::NoteSummary;
use crate::repo::note_summary_row::{map_summary_base, summary_cols};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};

const YEAR_MIN: i64 = -9999;
const YEAR_MAX: i64 = 9999;

// ── note_query: single sidebar read endpoint ───────────────────────────────────────
//
// Request carries the full view state. Implemented axes: folder scope, year range,
// favourites, tags (OR), region (single), statuses (OR), coordinates (has/none/bbox).
// Axes compose with AND across axes and OR within multi-value axes — same as
// createMatchesTagRegion + year/fav + map viewport. Unimplemented axes that are
// *active* (non-default) return VALIDATION. Text search still reserved.
//
// SQL drives from notes predicates first (partial indexes) and scopes workspace via
// `folder_id IN (SELECT …)`. Tag OR starts FROM note_tags (covering index). Bbox uses
// idx_notes_geo_alive so map surfaces never pull every located note.

/// Default page size when the client omits `limit`. Not a hard cap on total; `total` is unwindowed.
pub const NOTE_QUERY_DEFAULT_LIMIT: i64 = 200;
/// Hard upper bound on a single window — keeps IPC payloads bounded. Not the search result cap.
pub const NOTE_QUERY_MAX_LIMIT: i64 = 1000;
/// Hard cap for map marker windows — the renderer must never see an unbounded set.
pub const NOTE_QUERY_MAP_MAX_LIMIT: i64 = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TagMode {
    #[default]
    Or,
    And,
}

#[derive(Debug, Clone, Default)]
pub struct NoteQuery {
    pub workspace_id: Option<String>,
    /// Restrict to these folders (open folders / inbox). `None` = all folders in the workspace.
    /// `Some([])` = empty result (no open folders).
    pub folder_ids: Option<Vec<String>>,
    /// Inclusive lower year bound. `None` = no lower bound.
    pub year_from: Option<i64>,
    /// Inclusive upper year bound. `None` = no upper bound.
    pub year_to: Option<i64>,
    /// Record-axis (`updated_at`) inclusive lower bound, ISO date (YYYY-MM-DD). `None` = no
    /// lower bound. NOT the event axis above (`year_from`/`year_to` filter `notes.year`) — see
    /// docs/HANDOFF-calendar-onboarding.md §2.1/§2.8. Advanced-search date-range chips
    /// ("last 7 days" etc.) resolve to this at query-build time.
    pub updated_from: Option<String>,
    /// Record-axis (`updated_at`) inclusive upper bound, ISO date (YYYY-MM-DD). `None` = no
    /// upper bound.
    pub updated_to: Option<String>,
    /// Record-axis (`created_at`) inclusive lower bound, ISO date (YYYY-MM-DD). `None` = no
    /// lower bound. Independent of `updated_from`/`updated_to` — the calendar day-click list
    /// uses this (not `dateRange`) to split "created that day" from "updated that day".
    pub created_from: Option<String>,
    /// Record-axis (`created_at`) inclusive upper bound, ISO date (YYYY-MM-DD). `None` = no
    /// upper bound.
    pub created_to: Option<String>,
    /// When true, only notes with `is_favorite = 1`.
    pub favorites_only: bool,
    /// W7-f archive opt-in axis: default (false) excludes archived notes from every browsing
    /// surface this endpoint powers (tree/filter), mirroring the always-on `deleted_at IS NULL`
    /// predicate above it. `true` stops filtering `archived_at` (archived notes mix back in) —
    /// "hidden but findable" only applies to *passive* browsing; a caller that explicitly opts in
    /// (e.g. a future "show archived" toggle) gets them. Does not affect trash: `deleted_at IS
    /// NULL` stays unconditional regardless of this flag.
    pub include_archived: bool,
    /// Tag names (empty = no tag axis). Matches createMatchesTagRegion / TagsFilter.
    pub tags: Vec<String>,
    /// Mode for tag matching: OR (default) vs AND.
    pub tag_mode: TagMode,
    /// Region axis:
    /// - `RegionFilterSpec::Any` (default) = no region filter
    /// - `None` = no primary and no waypoints (`{kind:"none"}`)
    /// - `Eq(name)` = primary OR any waypoint name match (D4 union, `{kind:"region", name}`)
    pub region: RegionFilterSpec,
    /// Status keys OR-match (empty = no status axis). Each value is a built-in key or a
    /// `workspace_statuses.id` — stored as-is on `notes.status`.
    pub statuses: Vec<String>,
    /// Coordinate axis (map views). See [`CoordsFilterSpec`].
    pub coords: CoordsFilterSpec,
    /// Later wave: free-text search (folds into this endpoint eventually). Non-empty → VALIDATION.
    pub query: Option<String>,
    pub sort: NoteQuerySort,
    pub offset: i64,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NoteQuerySort {
    #[default]
    YearAsc,
    YearDesc,
    UpdatedDesc,
    /// Created-at descending — calendar empty state "recently added".
    CreatedDesc,
    /// Title ascending (case-insensitive) — Tags/Status expanded sections.
    TitleAsc,
}

/// Coordinate filter on `note_query` — map viewport bounding, or "has coords at all".
#[derive(Debug, Clone, PartialEq, Default)]
pub enum CoordsFilterSpec {
    /// No coordinate axis (default).
    #[default]
    Any,
    /// `lat IS NOT NULL AND lng IS NOT NULL` (located notes, no bbox).
    HasCoords,
    /// Missing either coordinate — client: `lat === null || lng === null` (after NaN checks).
    NoCoords,
    /// Inclusive axis-aligned box. Implies has both coordinates.
    /// When `min_lng > max_lng`, longitude wraps the antimeridian (`lng >= min OR lng <= max`).
    Bbox {
        min_lat: f64,
        max_lat: f64,
        min_lng: f64,
        max_lng: f64,
    },
}

/// Region axis on `note_query` — shaped so later waves do not need a contract break.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RegionFilterSpec {
    #[default]
    Any,
    /// Notes with no region set.
    None,
    Eq(String),
}

#[derive(Debug, Clone)]
pub struct NoteQueryResult {
    pub notes: Vec<NoteSummary>,
    pub total: i64,
}

/// Sidebar note window: applies implemented filter axes and returns one page + total.
///
/// Light summaries match `folder_list` (tag_names=[], has_image=false) — tags hydrate via
/// `note_tags_index` until a later wave folds tag payload into this endpoint.
pub fn query(conn: &Connection, q: NoteQuery) -> AppResult<NoteQueryResult> {
    // Text search still reserved — active query would disagree with the client path.
    if let Some(ref s) = q.query {
        if !s.trim().is_empty() {
            return Err(AppError::Validation(
                "note_query: text search not implemented in this wave".into(),
            ));
        }
    }

    validate_note_query_bounds(&q)?;

    let offset = q.offset.max(0);
    let limit = q
        .limit
        .unwrap_or(NOTE_QUERY_DEFAULT_LIMIT)
        .clamp(0, NOTE_QUERY_MAX_LIMIT);
    // limit 0 → empty window, total still meaningful.
    if limit == 0 {
        let total = query_total(conn, &q)?;
        return Ok(NoteQueryResult {
            notes: Vec::new(),
            total,
        });
    }

    let ws = match &q.workspace_id {
        Some(w) => w.clone(),
        None => crate::repo::folders::active_workspace_id(conn)?,
    };

    // Empty open-folder list is a valid "show nothing" — short-circuit without SQL.
    if let Some(ref ids) = q.folder_ids {
        if ids.is_empty() {
            return Ok(NoteQueryResult {
                notes: Vec::new(),
                total: 0,
            });
        }
    }

    let (where_sql, binds) = query_where_clause(&ws, &q)?;
    let order_sql = match q.sort {
        NoteQuerySort::YearAsc => "n.year ASC, n.created_at ASC, n.id ASC",
        NoteQuerySort::YearDesc => "n.year DESC, n.created_at DESC, n.id DESC",
        NoteQuerySort::UpdatedDesc => "n.updated_at DESC, n.id DESC",
        NoteQuerySort::CreatedDesc => "n.created_at DESC, n.id DESC",
        // Title first (NOCASE) then year/id for stable order — matches Tags/Status localeCompare + year.
        NoteQuerySort::TitleAsc => "n.title COLLATE NOCASE ASC, n.year ASC, n.id ASC",
    };

    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM notes n WHERE {where_sql}");
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        stmt.query_row(params_from_iter(binds.iter()), |r| r.get(0))
            .map_err(dberr)?
    };

    let cols = summary_cols("n");
    let sql = format!(
        "SELECT {cols}
         FROM notes n
         WHERE {where_sql}
         ORDER BY {order_sql}
         LIMIT ? OFFSET ?"
    );
    let mut page_binds = binds;
    page_binds.push(Value::Integer(limit));
    page_binds.push(Value::Integer(offset));

    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    // 파생 필드는 map_summary_base 가 비워 둔 그대로 쓴다: tag_names 는 note_tags_index 가
    // 따로 하이드레이션하고, note_query 는 서버측 RegionFilterSpec 으로 이미 합집합 필터링을
    // 마쳤으므로 클라 후처리용 region_names 는 불필요하다 — models.rs 주석 참고.
    let rows = stmt
        .query_map(params_from_iter(page_binds.iter()), map_summary_base)
        .map_err(dberr)?;

    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(dberr)?);
    }

    Ok(NoteQueryResult { notes, total })
}

fn query_total(conn: &Connection, q: &NoteQuery) -> AppResult<i64> {
    let ws = match &q.workspace_id {
        Some(w) => w.clone(),
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    if let Some(ref ids) = q.folder_ids {
        if ids.is_empty() {
            return Ok(0);
        }
    }
    let (where_sql, binds) = query_where_clause(&ws, q)?;
    let sql = format!("SELECT COUNT(*) FROM notes n WHERE {where_sql}");
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    stmt.query_row(params_from_iter(binds.iter()), |r| r.get(0))
        .map_err(dberr)
}

/// Shared WHERE for note_query COUNT + page. Binds order matches `?` placeholders left-to-right.
fn query_where_clause(ws: &str, q: &NoteQuery) -> AppResult<(String, Vec<Value>)> {
    let mut clauses: Vec<String> = vec!["n.deleted_at IS NULL".into()];
    // W7-f: archived notes are hidden from the tree/filter path by default (opt-in axis above).
    if !q.include_archived {
        clauses.push("n.archived_at IS NULL".into());
    }
    let mut binds: Vec<Value> = Vec::new();

    // Workspace scope: drive from notes indexes, not folders → notes join.
    // folder_ids (open folders) further restricts when provided.
    if let Some(ref folder_ids) = q.folder_ids {
        let placeholders = std::iter::repeat_n("?", folder_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        clauses.push(format!("n.folder_id IN ({placeholders})"));
        for id in folder_ids {
            binds.push(Value::Text(id.clone()));
        }
        // Still require workspace membership so a client cannot pass foreign folder ids.
        clauses.push(
            "n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?)".into(),
        );
        binds.push(Value::Text(ws.to_string()));
    } else {
        clauses.push(
            "n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?)".into(),
        );
        binds.push(Value::Text(ws.to_string()));
    }

    if let Some(from) = q.year_from {
        clauses.push("n.year >= ?".into());
        binds.push(Value::Integer(from));
    }
    if let Some(to) = q.year_to {
        clauses.push("n.year <= ?".into());
        binds.push(Value::Integer(to));
    }

    // Record axis (updated_at) — distinct from the year (event) axis just above, do not
    // conflate (§2.1/§2.8 HANDOFF-calendar-onboarding.md). Inclusive both ends. Parsing here
    // (rather than in validate_note_query_bounds) keeps the format-check + range-check +
    // exclusive-bump in one place, mirroring record_histogram. Stays on the raw `updated_at`
    // column (not substr) so idx_notes_updated_alive (migration v22) stays sargable.
    let updated_from_date = q
        .updated_from
        .as_deref()
        .map(|s| parse_calendar_date(s, "updated_from"))
        .transpose()?;
    let updated_to_date = q
        .updated_to
        .as_deref()
        .map(|s| parse_calendar_date(s, "updated_to"))
        .transpose()?;
    if let (Some(f), Some(t)) = (updated_from_date, updated_to_date) {
        if f > t {
            return Err(AppError::Validation(format!(
                "note_query: updated_from ({}) must be <= updated_to ({})",
                q.updated_from.as_deref().unwrap_or(""),
                q.updated_to.as_deref().unwrap_or("")
            )));
        }
    }
    if let Some(from) = &q.updated_from {
        clauses.push("n.updated_at >= ?".into());
        binds.push(Value::Text(from.clone()));
    }
    if let Some(to_date) = updated_to_date {
        // Exclusive-bumped to the next day so a full timestamp compares correctly against a
        // 10-char date, same technique as record_histogram's to_exclusive.
        let to_exclusive = to_date
            .succ_opt()
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "note_query: updated_to ({}) has no successor day",
                    q.updated_to.as_deref().unwrap_or("")
                ))
            })?
            .format("%Y-%m-%d")
            .to_string();
        clauses.push("n.updated_at < ?".into());
        binds.push(Value::Text(to_exclusive));
    }

    // Record axis (created_at) — independent of the updated_at block above (a note can be
    // filtered by one, the other, both, or neither; the calendar day-click list queries each
    // separately to split "created that day" from "updated that day"). Same parse/validate/
    // exclusive-bump technique.
    let created_from_date = q
        .created_from
        .as_deref()
        .map(|s| parse_calendar_date(s, "created_from"))
        .transpose()?;
    let created_to_date = q
        .created_to
        .as_deref()
        .map(|s| parse_calendar_date(s, "created_to"))
        .transpose()?;
    if let (Some(f), Some(t)) = (created_from_date, created_to_date) {
        if f > t {
            return Err(AppError::Validation(format!(
                "note_query: created_from ({}) must be <= created_to ({})",
                q.created_from.as_deref().unwrap_or(""),
                q.created_to.as_deref().unwrap_or("")
            )));
        }
    }
    if let Some(from) = &q.created_from {
        clauses.push("n.created_at >= ?".into());
        binds.push(Value::Text(from.clone()));
    }
    if let Some(to_date) = created_to_date {
        let to_exclusive = to_date
            .succ_opt()
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "note_query: created_to ({}) has no successor day",
                    q.created_to.as_deref().unwrap_or("")
                ))
            })?
            .format("%Y-%m-%d")
            .to_string();
        clauses.push("n.created_at < ?".into());
        binds.push(Value::Text(to_exclusive));
    }

    if q.favorites_only {
        clauses.push("n.is_favorite = 1".into());
    }

    // Tags — start from note_tags (covering idx_note_tags_tag_note), not EXISTS-per-note.
    // Empty selection = no axis (client: selectedTags.length === 0 skips the check).
    if !q.tags.is_empty() {
        let placeholders = std::iter::repeat_n("?", q.tags.len())
            .collect::<Vec<_>>()
            .join(",");
        match q.tag_mode {
            TagMode::Or => {
                clauses.push(format!(
                    "n.id IN (SELECT nt.note_id FROM note_tags nt \
                     JOIN tags tg ON tg.id = nt.tag_id \
                     WHERE tg.name IN ({placeholders}))"
                ));
            }
            TagMode::And => {
                let required_count = q.tags.len();
                clauses.push(format!(
                    "n.id IN (SELECT nt.note_id FROM note_tags nt \
                     JOIN tags tg ON tg.id = nt.tag_id \
                     WHERE tg.name IN ({placeholders}) \
                     GROUP BY nt.note_id \
                     HAVING COUNT(DISTINCT tg.name) = {required_count})"
                ));
            }
        }
        for name in &q.tags {
            binds.push(Value::Text(name.clone()));
        }
    }

    // Region — single-select tagged union (client RegionFilter).
    // D4 multi-region: filter matches the **union** of primary (`notes.region`) and waypoints
    // (`note_regions.name`). "none" means neither primary nor any waypoint.
    match &q.region {
        RegionFilterSpec::Any => {}
        RegionFilterSpec::None => {
            // `{kind:"none"}` → no primary and no waypoints.
            clauses.push(
                "(n.region IS NULL AND NOT EXISTS (\
                 SELECT 1 FROM note_regions nr WHERE nr.note_id = n.id))"
                    .into(),
            );
        }
        RegionFilterSpec::Eq(name) => {
            clauses.push(
                "(n.region = ? OR EXISTS (\
                 SELECT 1 FROM note_regions nr WHERE nr.note_id = n.id AND nr.name = ?))"
                    .into(),
            );
            binds.push(Value::Text(name.clone()));
            binds.push(Value::Text(name.clone()));
        }
    }

    // Statuses OR — built-in keys or workspace_statuses ids stored on notes.status.
    // Notes with status NULL never match a non-empty selection (client: n.status && includes).
    if !q.statuses.is_empty() {
        let placeholders = std::iter::repeat_n("?", q.statuses.len())
            .collect::<Vec<_>>()
            .join(",");
        clauses.push(format!("n.status IN ({placeholders})"));
        for s in &q.statuses {
            binds.push(Value::Text(s.clone()));
        }
    }

    // Coordinate axis — map viewport / located-vs-unlocated split.
    match &q.coords {
        CoordsFilterSpec::Any => {}
        CoordsFilterSpec::HasCoords => {
            clauses.push("n.lat IS NOT NULL AND n.lng IS NOT NULL".into());
        }
        CoordsFilterSpec::NoCoords => {
            clauses.push("(n.lat IS NULL OR n.lng IS NULL)".into());
        }
        CoordsFilterSpec::Bbox {
            min_lat,
            max_lat,
            min_lng,
            max_lng,
        } => {
            clauses.push("n.lat IS NOT NULL AND n.lng IS NOT NULL".into());
            clauses.push("n.lat >= ? AND n.lat <= ?".into());
            binds.push(Value::Real(*min_lat));
            binds.push(Value::Real(*max_lat));
            if min_lng <= max_lng {
                clauses.push("n.lng >= ? AND n.lng <= ?".into());
                binds.push(Value::Real(*min_lng));
                binds.push(Value::Real(*max_lng));
            } else {
                // Antimeridian wrap: box crosses ±180.
                clauses.push("(n.lng >= ? OR n.lng <= ?)".into());
                binds.push(Value::Real(*min_lng));
                binds.push(Value::Real(*max_lng));
            }
        }
    }

    Ok((clauses.join(" AND "), binds))
}

fn validate_note_query_bounds(q: &NoteQuery) -> AppResult<()> {
    if let (Some(from), Some(to)) = (q.year_from, q.year_to) {
        if from > to {
            return Err(AppError::Validation(format!(
                "year_from ({from}) must be <= year_to ({to})"
            )));
        }
    }
    for y in [q.year_from, q.year_to].into_iter().flatten() {
        if !(YEAR_MIN..=YEAR_MAX).contains(&y) {
            return Err(AppError::Validation(format!(
                "year out of range ({YEAR_MIN}..{YEAR_MAX}): {y}"
            )));
        }
    }
    if let CoordsFilterSpec::Bbox {
        min_lat,
        max_lat,
        min_lng: _,
        max_lng: _,
    } = &q.coords
    {
        if !(-90.0..=90.0).contains(min_lat) || !(-90.0..=90.0).contains(max_lat) {
            return Err(AppError::Validation(
                "note_query: lat out of range (-90..90)".into(),
            ));
        }
        if min_lat > max_lat {
            return Err(AppError::Validation(format!(
                "note_query: min_lat ({min_lat}) must be <= max_lat ({max_lat})"
            )));
        }
        // lng range is free form (may wrap); values must still be finite in -180..180.
        if let CoordsFilterSpec::Bbox {
            min_lng, max_lng, ..
        } = &q.coords
        {
            for lng in [min_lng, max_lng] {
                if !(-180.0..=180.0).contains(lng) {
                    return Err(AppError::Validation(
                        "note_query: lng out of range (-180..180)".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Year → count histogram for the density strip (TimelineFilter). Soft-deleted excluded.
/// Unfiltered by year/tags/region/status — matches client `yearCounts` from the full corpus.
/// Partial index `idx_notes_year_alive` keeps this cheap at 100k (~5ms measured).
pub fn year_histogram(
    conn: &Connection,
    workspace_id: Option<String>,
) -> AppResult<Vec<(i64, i64)>> {
    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    let mut stmt = conn
        .prepare(
            // W7-f: feeds the timeline density strip (a dashboard surface) — archived notes stay
            // hidden here unconditionally, same posture as deleted_at (no opt-in axis; this
            // endpoint has no per-call filter state at all).
            "SELECT n.year, COUNT(*)
             FROM notes n
             WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
               AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)
             GROUP BY n.year
             ORDER BY n.year ASC",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([&ws], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(dberr)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(dberr)?);
    }
    Ok(out)
}

/// Record axis for `note_record_histogram` (calendar grid) — allowlisted so the caller's string
/// never reaches SQL directly; each variant maps to a literal, hardcoded column name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordAxis {
    Updated,
    Created,
    /// Calendar grid axis: a day counts once per note if that note was created OR updated
    /// that day (not a plain sum of the two single-axis histograms, which would double-count
    /// every note whose created_at and updated_at land on the same day — e.g. any note created
    /// and never since edited).
    Union,
}

impl RecordAxis {
    fn column(self) -> &'static str {
        match self {
            RecordAxis::Updated => "updated_at",
            RecordAxis::Created => "created_at",
            RecordAxis::Union => unreachable!("Union has no single column — see record_histogram"),
        }
    }
}

/// Day → count histogram for the calendar grid (record axis: `updated_at`/`created_at`, as
/// opposed to `year_histogram`'s event axis). Soft-deleted excluded, workspace-scoped, no
/// tag/region/status filters — same posture as `year_histogram`. Unlike `year_histogram` this
/// is bounded (`from`/`to` inclusive, `YYYY-MM-DD`) — day cardinality over a note's full history
/// is unbounded in a way year is not (~19999 possible years vs. one bucket per day ever), so an
/// unbounded call here could return an unbounded series.
///
/// Grouping is by the UTC calendar day of the stored ISO8601 UTC timestamp (`substr(ts, 1, 10)`
/// — specs/db/schemas/notes.sql:2 states the UTC convention). A calendar renders in the user's
/// local time zone, so a note updated at 23:30 local on day D can be stored as 01:30 UTC on
/// day D+1 (or the reverse near UTC-negative offsets) and land in a different day bucket here
/// than the calendar cell the user expects. The caller (calendar UI, not built in this wave) is
/// responsible for converting local-day boundaries to UTC before choosing `from`/`to`, or for
/// re-bucketing client-side if it needs local-day grouping.
///
/// `from`/`to` are compared against the raw column (not `substr`) so the partial index
/// (`idx_notes_updated_alive` / `idx_notes_created_alive`, migration v22) stays sargable: `to` is
/// exclusive-bumped to the next day internally so the whole `to` day is included without turning
/// the upper bound into a substr comparison.
pub fn record_histogram(
    conn: &Connection,
    workspace_id: Option<String>,
    axis: RecordAxis,
    from: &str,
    to: &str,
) -> AppResult<Vec<(String, i64)>> {
    let from_date = parse_calendar_date(from, "from")?;
    let to_date = parse_calendar_date(to, "to")?;
    if from_date > to_date {
        return Err(AppError::Validation(format!(
            "note_record_histogram: from ({from}) must be <= to ({to})"
        )));
    }
    // Exclusive upper bound = day after `to`, so a plain `< ?` on the full timestamp includes
    // every instant of the `to` day without comparing a full timestamp against a 10-char date.
    let to_exclusive = to_date
        .succ_opt()
        .ok_or_else(|| AppError::Validation(format!("note_record_histogram: to ({to}) has no successor day")))?
        .format("%Y-%m-%d")
        .to_string();

    let ws = match workspace_id {
        Some(w) => w,
        None => crate::repo::folders::active_workspace_id(conn)?,
    };
    // Alias is deliberately NOT "day" (§2.3 HANDOFF-calendar-onboarding.md added notes.day as a
    // real column). `GROUP BY`/`ORDER BY` resolve a bare name against FROM-clause columns before
    // SELECT-list aliases, so "GROUP BY day" would silently group by the real (mostly-NULL)
    // notes.day column instead of this computed bucket — collapsing every date into one NULL
    // group. bucket_day avoids the collision; the Vec<(String,i64)> tuple field itself is still
    // named "day" in the JSON output (note_record_histogram's contract), only the SQL alias moved.
    let sql = match axis {
        RecordAxis::Union => {
            // UNION (not UNION ALL) dedupes (id, bucket_day) pairs, so a note created and
            // updated on the same day counts once for that day — a plain sum of the two
            // single-axis histograms would double-count it. ?1/?2/?3 (ws/from/to_exclusive)
            // are each reused across both branches; sqlite binds a numbered placeholder once
            // and lets every occurrence refer to it.
            // W7-f: calendar grid (dashboard surface) — archived hidden unconditionally, same
            // posture as year_histogram above.
            "SELECT bucket_day, COUNT(*) FROM (
                 SELECT n.id, substr(n.created_at, 1, 10) AS bucket_day
                 FROM notes n
                 WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
                   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)
                   AND n.created_at >= ?2
                   AND n.created_at < ?3
                 UNION
                 SELECT n.id, substr(n.updated_at, 1, 10) AS bucket_day
                 FROM notes n
                 WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
                   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)
                   AND n.updated_at >= ?2
                   AND n.updated_at < ?3
             )
             GROUP BY bucket_day
             ORDER BY bucket_day ASC"
                .to_string()
        }
        RecordAxis::Updated | RecordAxis::Created => {
            let column = axis.column(); // allowlisted literal — never the caller's raw string.
            format!(
                "SELECT substr(n.{column}, 1, 10) AS bucket_day, COUNT(*)
                 FROM notes n
                 WHERE n.deleted_at IS NULL AND n.archived_at IS NULL
                   AND n.folder_id IN (SELECT id FROM folders WHERE workspace_id = ?1)
                   AND n.{column} >= ?2
                   AND n.{column} < ?3
                 GROUP BY bucket_day
                 ORDER BY bucket_day ASC"
            )
        }
    };
    let mut stmt = conn.prepare(&sql).map_err(dberr)?;
    let rows = stmt
        .query_map(rusqlite::params![ws, from, to_exclusive], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(dberr)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(dberr)?);
    }
    Ok(out)
}

fn parse_calendar_date(s: &str, field: &str) -> AppResult<chrono::NaiveDate> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
        AppError::Validation(format!(
            "note_record_histogram: {field} must be an ISO date (YYYY-MM-DD): '{s}'"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::repo::notes::{
        create, delete, set_location, set_region, set_status, set_tags, toggle_favorite,
    };
    use rusqlite::{params, Connection};

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    // Wave A-4: client filter derivations removed. Pin server results to fixture
    // titles (stable) so the old corpus scan cannot silently diverge.

    fn server_titles(conn: &Connection, q: NoteQuery) -> Vec<String> {
        let mut q = q;
        q.limit = Some(NOTE_QUERY_MAX_LIMIT);
        q.offset = 0;
        let r = query(conn, q).unwrap();
        let mut titles: Vec<String> = r.notes.into_iter().map(|n| n.title).collect();
        titles.sort();
        titles
    }

    fn assert_titles(conn: &Connection, q: NoteQuery, expected: &[&str]) {
        let mut exp: Vec<String> = expected.iter().map(|s| (*s).to_string()).collect();
        exp.sort();
        assert_eq!(server_titles(conn, q), exp);
    }

    fn fixture_year_fav() -> (Connection, String, String) {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();
        // Years spanning the range; one favourite; one soft-deleted (must never appear).
        for (title, year, fav) in [
            ("A", 900i64, false),
            ("B", 1400, true),
            ("C", 1443, false),
            ("D", 1500, true),
            ("E", 1900, false),
            // Edge: year at extreme bounds of CHECK
            ("Lo", -9999, false),
            ("Hi", 9999, true),
        ] {
            let d = create(
                &mut conn,
                &folder_id,
                Some(title.into()),
                Some(year),
            )
            .unwrap();
            if fav {
                toggle_favorite(&mut conn, &d.note.id).unwrap();
            }
        }
        let gone = create(
            &mut conn,
            &folder_id,
            Some("trashed".into()),
            Some(1443),
        )
        .unwrap();
        delete(&mut conn, &gone.note.id).unwrap();
        (conn, ws, folder_id)
    }

    /// Fixture for tags / region / status axes (and composition with year + favourites).
    /// Returns (conn, ws, folder_id, custom_status_id, orphan_status_id).
    fn fixture_tag_region_status() -> (Connection, String, String, String, String) {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();

        let custom = crate::repo::taxonomy::add_status(
            &mut conn,
            Some(ws.clone()),
            "Review",
        )
        .unwrap();
        let custom_id = custom.id.clone();
        // Orphan status string — never existed in workspace_statuses (or was deleted without
        // nullify). Client still matches if statusFilter includes this exact string.
        let orphan_id = "orphaned-status-id-not-in-ws".to_string();

        // alpha + Joseon + done + fav + 1450
        let n1 = create(&mut conn, &folder_id, Some("n1".into()), Some(1450)).unwrap();
        set_tags(&mut conn, &n1.note.id, vec!["alpha".into()]).unwrap();
        set_region(&mut conn, &n1.note.id, Some("Joseon".into())).unwrap();
        set_status(&mut conn, &n1.note.id, Some("done".into())).unwrap();
        toggle_favorite(&mut conn, &n1.note.id).unwrap();

        // beta only + no region + in_progress + 1500
        let n2 = create(&mut conn, &folder_id, Some("n2".into()), Some(1500)).unwrap();
        set_tags(&mut conn, &n2.note.id, vec!["beta".into()]).unwrap();
        set_status(&mut conn, &n2.note.id, Some("in_progress".into())).unwrap();

        // alpha + beta + Joseon + custom status + 1400
        let n3 = create(&mut conn, &folder_id, Some("n3".into()), Some(1400)).unwrap();
        set_tags(
            &mut conn,
            &n3.note.id,
            vec!["alpha".into(), "beta".into()],
        )
        .unwrap();
        set_region(&mut conn, &n3.note.id, Some("Joseon".into())).unwrap();
        set_status(&mut conn, &n3.note.id, Some(custom_id.clone())).unwrap();

        // no tags + France + exported + 1600
        let n4 = create(&mut conn, &folder_id, Some("n4".into()), Some(1600)).unwrap();
        set_region(&mut conn, &n4.note.id, Some("France".into())).unwrap();
        set_status(&mut conn, &n4.note.id, Some("exported".into())).unwrap();

        // no tags, no region, no status + 1700
        let _n5 = create(&mut conn, &folder_id, Some("n5".into()), Some(1700)).unwrap();

        // orphan status id still on the note + no tags + no region + 1480
        let n6 = create(&mut conn, &folder_id, Some("n6".into()), Some(1480)).unwrap();
        conn.execute(
            "UPDATE notes SET status=?1 WHERE id=?2",
            params![orphan_id.as_str(), n6.note.id.as_str()],
        )
        .unwrap();

        // soft-deleted with alpha — must never appear
        let gone = create(&mut conn, &folder_id, Some("gone".into()), Some(1450)).unwrap();
        set_tags(&mut conn, &gone.note.id, vec!["alpha".into()]).unwrap();
        delete(&mut conn, &gone.note.id).unwrap();

        (conn, ws, folder_id, custom_id, orphan_id)
    }

    #[test]
    fn test_note_query_year_range_matches_client() {
        let (conn, ws, _) = fixture_year_fav();

        // Typical narrow range (inclusive): B(1400), C(1443), D(1500).
        let q = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: Some(1400),
            year_to: Some(1500),
            ..Default::default()
        };
        assert_titles(&conn, q.clone(), &["B", "C", "D"]);
        assert_eq!(query(&conn, q).unwrap().total, 3);

        // Empty range (from > to is rejected).
        let err = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                year_from: Some(1500),
                year_to: Some(1400),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // Empty match range (valid bounds, no notes).
        let q_empty = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: Some(1600),
            year_to: Some(1700),
            ..Default::default()
        };
        assert_titles(&conn, q_empty.clone(), &[]);
        assert_eq!(query(&conn, q_empty).unwrap().total, 0);

        // No bounds = all alive fixture notes (trashed excluded).
        let q_all = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: None,
            year_to: None,
            ..Default::default()
        };
        assert_titles(&conn, q_all.clone(), &["A", "B", "C", "D", "E", "Hi", "Lo"]);
        assert_eq!(query(&conn, q_all).unwrap().total, 7);

        // Single-sided lower bound: D(1500), E(1900), Hi(9999).
        let q_from = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: Some(1500),
            year_to: None,
            ..Default::default()
        };
        assert_titles(&conn, q_from, &["D", "E", "Hi"]);
    }

    #[test]
    fn test_note_query_favorites_matches_client() {
        let (conn, ws, _) = fixture_year_fav();

        let q = NoteQuery {
            workspace_id: Some(ws.clone()),
            favorites_only: true,
            ..Default::default()
        };
        assert_titles(&conn, q.clone(), &["B", "D", "Hi"]);
        let r = query(&conn, q).unwrap();
        assert_eq!(r.total, 3);
        assert!(r.notes.iter().all(|n| n.is_favorite));
    }

    #[test]
    fn test_note_query_favorites_combined_with_year_range() {
        let (conn, ws, _) = fixture_year_fav();

        let q = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: Some(1400),
            year_to: Some(1500),
            favorites_only: true,
            ..Default::default()
        };
        // B(1400 fav), D(1500 fav) — C is not fav
        assert_titles(&conn, q.clone(), &["B", "D"]);
        assert_eq!(query(&conn, q).unwrap().total, 2);
    }

    #[test]
    fn test_note_query_window_total_and_pagination() {
        let (conn, ws, _) = fixture_year_fav();
        let r1 = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                sort: NoteQuerySort::YearAsc,
                offset: 0,
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r1.notes.len(), 2);
        assert!(r1.total >= 7); // fixture alive count

        let r2 = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                sort: NoteQuerySort::YearAsc,
                offset: 2,
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r2.total, r1.total);
        // Windows must not overlap.
        let s1: std::collections::HashSet<_> = r1.notes.iter().map(|n| n.id.clone()).collect();
        let s2: std::collections::HashSet<_> = r2.notes.iter().map(|n| n.id.clone()).collect();
        assert!(s1.is_disjoint(&s2));
        // Year order.
        assert!(r1.notes[0].year <= r1.notes[1].year);
    }

    #[test]
    fn test_note_query_folder_ids_and_soft_delete_excluded() {
        let (conn, ws, folder_id) = fixture_year_fav();
        // Restrict to the fixture folder — same as full ws for this fixture.
        let r = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                folder_ids: Some(vec![folder_id.clone()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.total >= 7);
        // Empty folder list → empty.
        let empty = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                folder_ids: Some(vec![]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(empty.total, 0);
        assert!(empty.notes.is_empty());

        // Soft-deleted title must never appear.
        assert!(!r.notes.iter().any(|n| n.title == "trashed"));
    }

    fn fixture_geo() -> (Connection, String, String) {
        let mut conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();
        // Seoul-ish, Busan-ish, Paris-ish, shared coord (two notes same pin), no coords.
        let specs: Vec<(&str, i64, Option<(f64, f64)>)> = vec![
            ("seoul_a", 1450, Some((37.5665, 126.9780))),
            ("seoul_b", 1451, Some((37.5665, 126.9780))), // same pin
            ("busan", 1500, Some((35.1796, 129.0756))),
            ("paris", 1600, Some((48.8566, 2.3522))),
            ("no_geo", 1700, None),
            ("half_geo", 1710, None), // force lat only via raw SQL below
        ];
        for (title, year, loc) in specs {
            let d = create(&mut conn, &folder_id, Some(title.into()), Some(year)).unwrap();
            if let Some((lat, lng)) = loc {
                set_location(&mut conn, &d.note.id, Some(lat), Some(lng)).unwrap();
            }
            if title == "half_geo" {
                conn.execute(
                    "UPDATE notes SET lat=1.0, lng=NULL WHERE id=?1",
                    [&d.note.id],
                )
                .unwrap();
            }
        }
        (conn, ws, folder_id)
    }

    #[test]
    fn test_note_query_coords_has_none_and_bbox_matches_client() {
        let (conn, ws, _) = fixture_geo();

        // has coords: seoul_a/b, busan, paris
        let q_has = NoteQuery {
            workspace_id: Some(ws.clone()),
            coords: CoordsFilterSpec::HasCoords,
            ..Default::default()
        };
        assert_titles(&conn, q_has.clone(), &["seoul_a", "seoul_b", "busan", "paris"]);
        assert_eq!(query(&conn, q_has).unwrap().total, 4);

        // no coords (bare + half_geo)
        let q_none = NoteQuery {
            workspace_id: Some(ws.clone()),
            coords: CoordsFilterSpec::NoCoords,
            ..Default::default()
        };
        assert_titles(&conn, q_none.clone(), &["no_geo", "half_geo"]);
        assert_eq!(query(&conn, q_none).unwrap().total, 2);

        // Korea-ish bbox — seoul pair + busan, not paris
        let q_box = NoteQuery {
            workspace_id: Some(ws.clone()),
            coords: CoordsFilterSpec::Bbox {
                min_lat: 33.0,
                max_lat: 39.0,
                min_lng: 124.0,
                max_lng: 132.0,
            },
            ..Default::default()
        };
        assert_titles(&conn, q_box.clone(), &["seoul_a", "seoul_b", "busan"]);
        assert_eq!(query(&conn, q_box).unwrap().total, 3);

        // Empty viewport
        let q_empty = NoteQuery {
            workspace_id: Some(ws.clone()),
            coords: CoordsFilterSpec::Bbox {
                min_lat: 0.0,
                max_lat: 1.0,
                min_lng: 0.0,
                max_lng: 1.0,
            },
            ..Default::default()
        };
        assert_eq!(query(&conn, q_empty).unwrap().total, 0);

        // Shared coordinate: both seoul notes returned (grouping is a view concern).
        let q_pin = NoteQuery {
            workspace_id: Some(ws),
            coords: CoordsFilterSpec::Bbox {
                min_lat: 37.5664,
                max_lat: 37.5666,
                min_lng: 126.9779,
                max_lng: 126.9781,
            },
            ..Default::default()
        };
        let pin = query(&conn, q_pin).unwrap();
        assert_eq!(pin.total, 2);
        let mut pin_titles: Vec<_> = pin.notes.iter().map(|n| n.title.as_str()).collect();
        pin_titles.sort();
        assert_eq!(pin_titles, vec!["seoul_a", "seoul_b"]);
    }

    #[test]
    fn test_year_histogram_matches_client_counts() {
        let (conn, ws, _) = fixture_year_fav();
        // Fixture years: 900,1400,1443,1500,1900,-9999,9999 — one each.
        let server = year_histogram(&conn, Some(ws)).unwrap();
        let server_map: std::collections::BTreeMap<i64, i64> = server.into_iter().collect();
        let expected: std::collections::BTreeMap<i64, i64> = [
            (-9999, 1),
            (900, 1),
            (1400, 1),
            (1443, 1),
            (1500, 1),
            (1900, 1),
            (9999, 1),
        ]
        .into_iter()
        .collect();
        assert_eq!(server_map, expected);
    }

    /// Directly overrides the record-axis columns — `create()` always stamps `now_iso()`, so
    /// record_histogram tests need raw SQL to place notes on specific calendar days.
    fn set_record_times(conn: &Connection, note_id: &str, created_at: &str, updated_at: &str) {
        conn.execute(
            "UPDATE notes SET created_at=?1, updated_at=?2 WHERE id=?3",
            params![created_at, updated_at, note_id],
        )
        .unwrap();
    }

    /// Minimal fixture for record_histogram: workspace + folder, no notes yet — each test seeds
    /// its own notes with explicit created_at/updated_at via `set_record_times`.
    fn fixture_record() -> (Connection, String, String) {
        let conn = setup_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ws: String = conn
            .query_row(
                "SELECT workspace_id FROM folders WHERE id=?1",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();
        (conn, ws, folder_id)
    }

    #[test]
    fn test_record_histogram_counts_land_on_right_day() {
        let (mut conn, ws, folder_id) = fixture_record();
        let a = create(&mut conn, &folder_id, Some("a".into()), Some(1000)).unwrap();
        set_record_times(&conn, &a.note.id, "2026-01-01T00:00:00.000Z", "2026-01-05T09:00:00.000Z");
        let b = create(&mut conn, &folder_id, Some("b".into()), Some(1000)).unwrap();
        set_record_times(&conn, &b.note.id, "2026-01-02T00:00:00.000Z", "2026-01-05T23:59:59.999Z");
        let c = create(&mut conn, &folder_id, Some("c".into()), Some(1000)).unwrap();
        set_record_times(&conn, &c.note.id, "2026-01-03T00:00:00.000Z", "2026-01-06T00:00:00.000Z");

        let hist = record_histogram(&conn, Some(ws), RecordAxis::Updated, "2026-01-01", "2026-01-31").unwrap();
        let map: std::collections::BTreeMap<String, i64> = hist.into_iter().collect();
        // a and b both updated on 01-05 (one at 09:00, one at 23:59:59) -> bucketed together.
        assert_eq!(map.get("2026-01-05"), Some(&2));
        assert_eq!(map.get("2026-01-06"), Some(&1));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn test_record_histogram_range_bound_excludes_out_of_range() {
        let (mut conn, ws, folder_id) = fixture_record();
        let inside = create(&mut conn, &folder_id, Some("inside".into()), Some(1000)).unwrap();
        set_record_times(&conn, &inside.note.id, "2026-02-01T00:00:00.000Z", "2026-02-15T00:00:00.000Z");
        let before = create(&mut conn, &folder_id, Some("before".into()), Some(1000)).unwrap();
        set_record_times(&conn, &before.note.id, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
        let after = create(&mut conn, &folder_id, Some("after".into()), Some(1000)).unwrap();
        set_record_times(&conn, &after.note.id, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");

        let hist = record_histogram(&conn, Some(ws), RecordAxis::Updated, "2026-02-01", "2026-02-28").unwrap();
        let total: i64 = hist.iter().map(|(_, c)| c).sum();
        assert_eq!(total, 1, "only the in-range note should be counted");
        assert_eq!(hist, vec![("2026-02-15".to_string(), 1)]);

        // `to` day itself is inclusive up to its last instant.
        let boundary = create(&mut conn, &folder_id, Some("boundary".into()), Some(1000)).unwrap();
        set_record_times(&conn, &boundary.note.id, "2026-02-28T00:00:00.000Z", "2026-02-28T23:59:59.999Z");
        let hist2 = record_histogram(&conn, None, RecordAxis::Updated, "2026-02-28", "2026-02-28").unwrap();
        assert_eq!(hist2, vec![("2026-02-28".to_string(), 1)]);
    }

    #[test]
    fn test_record_histogram_soft_deleted_excluded() {
        let (mut conn, ws, folder_id) = fixture_record();
        let gone = create(&mut conn, &folder_id, Some("gone".into()), Some(1000)).unwrap();
        set_record_times(&conn, &gone.note.id, "2026-04-01T00:00:00.000Z", "2026-04-10T00:00:00.000Z");
        delete(&mut conn, &gone.note.id).unwrap();

        let hist = record_histogram(&conn, Some(ws), RecordAxis::Updated, "2026-04-01", "2026-04-30").unwrap();
        assert!(hist.is_empty(), "soft-deleted note must not appear in the histogram");
    }

    #[test]
    fn test_record_histogram_axes_diverge_for_created_then_updated_note() {
        let (mut conn, ws, folder_id) = fixture_record();
        let d = create(&mut conn, &folder_id, Some("moved".into()), Some(1000)).unwrap();
        // Created on 05-01, later updated (edited) on 05-20 — a different day.
        set_record_times(&conn, &d.note.id, "2026-05-01T00:00:00.000Z", "2026-05-20T00:00:00.000Z");

        let created_hist = record_histogram(&conn, Some(ws.clone()), RecordAxis::Created, "2026-05-01", "2026-05-31").unwrap();
        assert_eq!(created_hist, vec![("2026-05-01".to_string(), 1)]);

        let updated_hist = record_histogram(&conn, Some(ws), RecordAxis::Updated, "2026-05-01", "2026-05-31").unwrap();
        assert_eq!(updated_hist, vec![("2026-05-20".to_string(), 1)]);
    }

    #[test]
    fn test_record_histogram_union_dedupes_same_day_but_counts_different_days_once_each() {
        let (mut conn, ws, folder_id) = fixture_record();
        // Created AND updated the same day (07-01) — must count once, not twice, on that day.
        let same_day = create(&mut conn, &folder_id, Some("same_day".into()), Some(1000)).unwrap();
        set_record_times(&conn, &same_day.note.id, "2026-07-01T00:00:00.000Z", "2026-07-01T18:00:00.000Z");
        // Created 07-02, later edited 07-20 — a plain sum of the two axes would double-count
        // this note across the two days too; union must show it once per day it touched.
        let moved = create(&mut conn, &folder_id, Some("moved".into()), Some(1000)).unwrap();
        set_record_times(&conn, &moved.note.id, "2026-07-02T00:00:00.000Z", "2026-07-20T00:00:00.000Z");

        let hist = record_histogram(&conn, Some(ws), RecordAxis::Union, "2026-07-01", "2026-07-31").unwrap();
        let map: std::collections::BTreeMap<String, i64> = hist.into_iter().collect();
        assert_eq!(map.get("2026-07-01"), Some(&1), "same_day must count once, not twice, on 07-01");
        assert_eq!(map.get("2026-07-02"), Some(&1));
        assert_eq!(map.get("2026-07-20"), Some(&1));
        assert_eq!(map.values().sum::<i64>(), 3, "3 note-day touches total, no double-count");
    }

    // Not asserted via EXPLAIN QUERY PLAN: planner drives from idx_notes_folder on tiny fixtures
    // (verified: existing year_histogram does the same); range predicate stays on the raw
    // column so the partial index is available at scale.

    #[test]
    fn test_record_histogram_rejects_bad_input() {
        let (conn, ws, _) = fixture_record();
        let bad_format = record_histogram(&conn, Some(ws.clone()), RecordAxis::Updated, "2026/01/01", "2026-01-31");
        assert!(matches!(bad_format, Err(AppError::Validation(_))));

        let inverted = record_histogram(&conn, Some(ws), RecordAxis::Updated, "2026-02-01", "2026-01-01");
        assert!(matches!(inverted, Err(AppError::Validation(_))));
    }

    // ── note_query record-axis range (updated_from/updated_to) ──────────────────────────
    // §2.1/§2.8 HANDOFF-calendar-onboarding.md: distinct axis from year_from/year_to (event
    // axis). Reuses fixture_record()/set_record_times() from the record_histogram tests above.

    #[test]
    fn test_note_query_updated_range_narrows_and_total_matches() {
        let (mut conn, ws, folder_id) = fixture_record();
        let inside = create(&mut conn, &folder_id, Some("inside".into()), Some(1000)).unwrap();
        set_record_times(&conn, &inside.note.id, "2026-01-01T00:00:00.000Z", "2026-02-15T12:00:00.000Z");
        let before = create(&mut conn, &folder_id, Some("before".into()), Some(1000)).unwrap();
        set_record_times(&conn, &before.note.id, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
        let after = create(&mut conn, &folder_id, Some("after".into()), Some(1000)).unwrap();
        set_record_times(&conn, &after.note.id, "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");

        let q = NoteQuery {
            workspace_id: Some(ws.clone()),
            updated_from: Some("2026-02-01".into()),
            updated_to: Some("2026-02-28".into()),
            ..Default::default()
        };
        assert_titles(&conn, q.clone(), &["inside"]);
        let r = query(&conn, q).unwrap();
        // total (COUNT path) must agree with the returned page (page path) — same predicate,
        // same binds, both built from query_where_clause.
        assert_eq!(r.total, 1);
        assert_eq!(r.notes.len(), 1);
    }

    #[test]
    fn test_note_query_updated_range_inclusive_both_ends() {
        let (mut conn, ws, folder_id) = fixture_record();
        let first_instant = create(&mut conn, &folder_id, Some("first_instant".into()), Some(1000)).unwrap();
        set_record_times(&conn, &first_instant.note.id, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
        let last_instant = create(&mut conn, &folder_id, Some("last_instant".into()), Some(1000)).unwrap();
        set_record_times(&conn, &last_instant.note.id, "2026-01-01T00:00:00.000Z", "2026-02-28T23:59:59.999Z");
        let just_before = create(&mut conn, &folder_id, Some("just_before".into()), Some(1000)).unwrap();
        set_record_times(&conn, &just_before.note.id, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
        let just_after = create(&mut conn, &folder_id, Some("just_after".into()), Some(1000)).unwrap();
        set_record_times(&conn, &just_after.note.id, "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");

        let q = NoteQuery {
            workspace_id: Some(ws),
            updated_from: Some("2026-02-01".into()),
            updated_to: Some("2026-02-28".into()),
            ..Default::default()
        };
        assert_titles(&conn, q, &["first_instant", "last_instant"]);
    }

    #[test]
    fn test_note_query_updated_range_single_sided_bounds() {
        let (mut conn, ws, folder_id) = fixture_record();
        let early = create(&mut conn, &folder_id, Some("early".into()), Some(1000)).unwrap();
        set_record_times(&conn, &early.note.id, "2026-01-01T00:00:00.000Z", "2026-01-10T00:00:00.000Z");
        let mid = create(&mut conn, &folder_id, Some("mid".into()), Some(1000)).unwrap();
        set_record_times(&conn, &mid.note.id, "2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z");
        let late = create(&mut conn, &folder_id, Some("late".into()), Some(1000)).unwrap();
        set_record_times(&conn, &late.note.id, "2026-01-01T00:00:00.000Z", "2026-01-30T00:00:00.000Z");

        // Only updated_from — no upper bound.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                updated_from: Some("2026-01-15".into()),
                ..Default::default()
            },
            &["mid", "late"],
        );
        // Only updated_to — no lower bound.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                updated_to: Some("2026-01-20".into()),
                ..Default::default()
            },
            &["early", "mid"],
        );
    }

    #[test]
    fn test_note_query_updated_range_rejects_bad_input() {
        let (conn, ws, _) = fixture_record();
        let bad_format = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                updated_from: Some("2026/01/01".into()),
                ..Default::default()
            },
        );
        assert!(matches!(bad_format, Err(AppError::Validation(_))));

        let inverted = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                updated_from: Some("2026-02-01".into()),
                updated_to: Some("2026-01-01".into()),
                ..Default::default()
            },
        );
        assert!(matches!(inverted, Err(AppError::Validation(_))));
    }

    #[test]
    fn test_note_query_updated_range_matches_a_freshly_created_note() {
        // No set_record_times — this note carries the real now_iso() stamp (create()'s default),
        // which is what the predicate compares against in production, not the hand-picked
        // literals every other test in this block uses. Reads the stamp back from the DB (rather
        // than hardcoding "today") so the test still catches it if now_iso()'s format ever stops
        // starting with a plain YYYY-MM-DD prefix (the predicate is a lexicographic string
        // compare against a 10-char date — see query_where_clause).
        let (mut conn, ws, folder_id) = fixture_record();
        let n = create(&mut conn, &folder_id, Some("today".into()), Some(1000)).unwrap();
        let today: String = conn
            .query_row(
                "SELECT substr(updated_at, 1, 10) FROM notes WHERE id = ?1",
                [&n.note.id],
                |r| r.get(0),
            )
            .unwrap();

        let q = NoteQuery {
            workspace_id: Some(ws),
            updated_from: Some(today.clone()),
            updated_to: Some(today),
            ..Default::default()
        };
        assert_titles(&conn, q, &["today"]);
    }

    #[test]
    fn test_note_query_updated_range_ands_with_tags_axis() {
        let (mut conn, ws, folder_id) = fixture_record();
        // Both in range, only one tagged "alpha" — the AND across axes must require both.
        let tagged = create(&mut conn, &folder_id, Some("tagged".into()), Some(1000)).unwrap();
        set_record_times(&conn, &tagged.note.id, "2026-01-01T00:00:00.000Z", "2026-03-10T00:00:00.000Z");
        set_tags(&mut conn, &tagged.note.id, vec!["alpha".into()]).unwrap();
        let untagged = create(&mut conn, &folder_id, Some("untagged".into()), Some(1000)).unwrap();
        set_record_times(&conn, &untagged.note.id, "2026-01-01T00:00:00.000Z", "2026-03-12T00:00:00.000Z");
        // In range but wrong tag.
        let out_of_range = create(&mut conn, &folder_id, Some("out_of_range".into()), Some(1000)).unwrap();
        set_record_times(&conn, &out_of_range.note.id, "2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
        set_tags(&mut conn, &out_of_range.note.id, vec!["alpha".into()]).unwrap();

        let q = NoteQuery {
            workspace_id: Some(ws),
            updated_from: Some("2026-03-01".into()),
            updated_to: Some("2026-03-31".into()),
            tags: vec!["alpha".into()],
            ..Default::default()
        };
        assert_titles(&conn, q.clone(), &["tagged"]);
        assert_eq!(query(&conn, q).unwrap().total, 1);
    }

    #[test]
    fn test_note_query_empty_year_range_and_title_sort() {
        let (conn, ws, _) = fixture_year_fav();
        // Year range containing nothing.
        let q = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: Some(1600),
            year_to: Some(1650),
            ..Default::default()
        };
        assert_eq!(query(&conn, q).unwrap().total, 0);

        // Title sort stable.
        let r = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                sort: NoteQuerySort::TitleAsc,
                limit: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.notes.len(), 3);
        for w in r.notes.windows(2) {
            let a = w[0].title.to_lowercase();
            let b = w[1].title.to_lowercase();
            assert!(a <= b);
        }
    }

    #[test]
    fn test_note_query_rejects_unimplemented_text_search() {
        let (conn, ws, _) = fixture_year_fav();
        let err = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                query: Some("hangul".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        // Empty / whitespace query is treated as inactive (no filter).
        let ok = query(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                query: Some("   ".into()),
                ..Default::default()
            },
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn test_note_query_tags_or_matches_client() {
        let (conn, ws, _, _, _) = fixture_tag_region_status();

        // No selection → all alive notes (axis inactive).
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec![],
                ..Default::default()
            },
            &["n1", "n2", "n3", "n4", "n5", "n6"],
        );

        // Tag carried by no live note.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["no-such-tag".into()],
                ..Default::default()
            },
            &[],
        );

        // Single tag: n1 + n3 have alpha; soft-deleted "gone" excluded.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["alpha".into()],
                ..Default::default()
            },
            &["n1", "n3"],
        );

        // OR across two tags: alpha ∪ beta = n1, n2, n3 (not AND).
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["alpha".into(), "beta".into()],
                ..Default::default()
            },
            &["n1", "n2", "n3"],
        );

        // Untagged notes never match a non-empty tag selection.
        let alpha_titles = server_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                tags: vec!["alpha".into()],
                ..Default::default()
            },
        );
        for bare in ["n4", "n5", "n6"] {
            assert!(!alpha_titles.iter().any(|t| t == bare));
        }
    }

    #[test]
    fn test_note_query_tag_mode_and_and_or() {
        let (conn, ws, _, _, _) = fixture_tag_region_status();

        // tags=["alpha", "beta"], tag_mode=Or -> union: n1, n2, n3
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["alpha".into(), "beta".into()],
                tag_mode: TagMode::Or,
                ..Default::default()
            },
            &["n1", "n2", "n3"],
        );

        // tags=["alpha", "beta"], tag_mode=And -> ONLY note carrying both (n3)
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["alpha".into(), "beta".into()],
                tag_mode: TagMode::And,
                ..Default::default()
            },
            &["n3"],
        );

        // tags=["alpha", "beta"], tag_mode omitted -> default Or (union: n1, n2, n3)
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["alpha".into(), "beta".into()],
                ..Default::default()
            },
            &["n1", "n2", "n3"],
        );

        // tags=[], tag_mode=And -> axis disabled, same as tags=[] with Or
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                tags: vec![],
                tag_mode: TagMode::And,
                ..Default::default()
            },
            &["n1", "n2", "n3", "n4", "n5", "n6"],
        );
    }

    #[test]
    fn test_note_query_explain_query_plan_tags() {
        let (conn, _ws, _, _, _) = fixture_tag_region_status();

        // OR query plan
        let mut stmt_or = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT n.id FROM notes n \
                 WHERE n.id IN (SELECT nt.note_id FROM note_tags nt \
                 JOIN tags tg ON tg.id = nt.tag_id \
                 WHERE tg.name IN ('alpha', 'beta'))",
            )
            .unwrap();
        let plan_or: Vec<String> = stmt_or
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let plan_or_str = plan_or.join("\n");
        println!("--- EXPLAIN QUERY PLAN (OR) ---\n{}", plan_or_str);
        assert!(plan_or_str.contains("idx_note_tags_tag_note"));

        // AND query plan
        let mut stmt_and = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT n.id FROM notes n \
                 WHERE n.id IN (SELECT nt.note_id FROM note_tags nt \
                 JOIN tags tg ON tg.id = nt.tag_id \
                 WHERE tg.name IN ('alpha', 'beta') \
                 GROUP BY nt.note_id HAVING COUNT(DISTINCT tg.name) = 2)",
            )
            .unwrap();
        let plan_and: Vec<String> = stmt_and
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let plan_and_str = plan_and.join("\n");
        println!("--- EXPLAIN QUERY PLAN (AND) ---\n{}", plan_and_str);
        assert!(plan_and_str.contains("idx_note_tags_tag_note"));
    }

    #[test]
    fn test_note_query_region_matches_client() {
        let (conn, ws, _, _, _) = fixture_tag_region_status();

        // Omitted / Any → no region axis.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                region: RegionFilterSpec::Any,
                ..Default::default()
            },
            &["n1", "n2", "n3", "n4", "n5", "n6"],
        );

        // `{kind:"none"}` — notes with region IS NULL (n2, n5, n6).
        let q_none = NoteQuery {
            workspace_id: Some(ws.clone()),
            region: RegionFilterSpec::None,
            ..Default::default()
        };
        assert_titles(&conn, q_none.clone(), &["n2", "n5", "n6"]);
        assert!(query(&conn, q_none).unwrap().notes.iter().all(|n| n.region.is_none()));

        // Exact name.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                region: RegionFilterSpec::Eq("Joseon".into()),
                ..Default::default()
            },
            &["n1", "n3"],
        );

        // Name matching nothing.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                region: RegionFilterSpec::Eq("Atlantis".into()),
                ..Default::default()
            },
            &[],
        );
    }

    /// D4: region filter is the union of primary (`notes.region`) and waypoints (`note_regions`).
    #[test]
    fn test_note_query_region_matches_waypoints_union() {
        let (mut conn, ws, folder_id, _, _) = fixture_tag_region_status();

        // n2 has no primary region — attach a waypoint named "Joseon".
        let n2_id: String = conn
            .query_row(
                "SELECT id FROM notes WHERE title = 'n2' AND folder_id = ?1 AND deleted_at IS NULL",
                [&folder_id],
                |r| r.get(0),
            )
            .unwrap();
        crate::repo::notes::region_add(&mut conn, &n2_id, "Joseon", 37.5, 127.0, 0).unwrap();

        // Eq("Joseon") must include n1, n3 (primary) AND n2 (waypoint only).
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                region: RegionFilterSpec::Eq("Joseon".into()),
                ..Default::default()
            },
            &["n1", "n2", "n3"],
        );

        // None must exclude n2 now that it has a waypoint (n5, n6 remain).
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                region: RegionFilterSpec::None,
                ..Default::default()
            },
            &["n5", "n6"],
        );
    }

    #[test]
    fn test_note_query_statuses_matches_client() {
        let (conn, ws, _, custom_id, orphan_id) = fixture_tag_region_status();

        // No selection → full alive set.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                statuses: vec![],
                ..Default::default()
            },
            &["n1", "n2", "n3", "n4", "n5", "n6"],
        );

        // Built-in key — n1 is done. Empty status board column still queryable as total 0 elsewhere.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                statuses: vec!["done".into()],
                ..Default::default()
            },
            &["n1"],
        );

        // Custom workspace_statuses id — n3.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                statuses: vec![custom_id.clone()],
                ..Default::default()
            },
            &["n3"],
        );

        // OR across built-in + custom — n1, n3, n4.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                statuses: vec!["done".into(), custom_id, "exported".into()],
                ..Default::default()
            },
            &["n1", "n3", "n4"],
        );

        // Orphan status still stored on note — match by string equality (n6).
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                statuses: vec![orphan_id],
                ..Default::default()
            },
            &["n6"],
        );

        // Selection matching nothing (null status never matches).
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                statuses: vec!["no-such-status".into()],
                ..Default::default()
            },
            &[],
        );
    }

    #[test]
    fn test_note_query_axes_compose_and_across() {
        let (conn, ws, _, custom_id, _) = fixture_tag_region_status();

        // tags OR + region + statuses + year + favourites — every axis at once.
        // n1 is the only note with alpha ∩ Joseon ∩ done ∩ fav ∩ year∈[1400,1500].
        let q = NoteQuery {
            workspace_id: Some(ws.clone()),
            year_from: Some(1400),
            year_to: Some(1500),
            favorites_only: true,
            tags: vec!["alpha".into(), "beta".into()],
            region: RegionFilterSpec::Eq("Joseon".into()),
            statuses: vec!["done".into(), custom_id],
            ..Default::default()
        };
        assert_titles(&conn, q.clone(), &["n1"]);
        assert_eq!(query(&conn, q).unwrap().total, 1);

        // Tag + region without fav: n1 and n3 both alpha + Joseon.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws.clone()),
                tags: vec!["alpha".into()],
                region: RegionFilterSpec::Eq("Joseon".into()),
                ..Default::default()
            },
            &["n1", "n3"],
        );

        // Region none + in_progress → n2 only.
        assert_titles(
            &conn,
            NoteQuery {
                workspace_id: Some(ws),
                region: RegionFilterSpec::None,
                statuses: vec!["in_progress".into()],
                ..Default::default()
            },
            &["n2"],
        );
    }

    /// Optional release timing against the real 100k DB. No-op unless BRISE_REAL_DB + BRISE_WS are set.
    /// Not part of the default suite (skips when env unset).
    #[test]
    fn measure_note_query_real_db_if_env() {
        use std::time::Instant;
        let Ok(path) = std::env::var("BRISE_REAL_DB") else {
            return;
        };
        let Ok(ws) = std::env::var("BRISE_WS") else {
            return;
        };
        let conn = Connection::open(&path).expect("open real db");
        let tags = vec!["dynastie".into(), "guerre".into(), "culture".into()];
        let cases: Vec<(&str, NoteQuery)> = vec![
            (
                "tags",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    tags: tags.clone(),
                    limit: Some(100),
                    ..Default::default()
                },
            ),
            (
                "region",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    region: RegionFilterSpec::Eq("Japon".into()),
                    limit: Some(100),
                    ..Default::default()
                },
            ),
            (
                "region_none",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    region: RegionFilterSpec::None,
                    limit: Some(100),
                    ..Default::default()
                },
            ),
            (
                "status",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    statuses: vec![
                        "in_progress".into(),
                        "exported".into(),
                        "done".into(),
                    ],
                    limit: Some(100),
                    ..Default::default()
                },
            ),
            (
                "combined",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    year_from: Some(1400),
                    year_to: Some(1600),
                    tags: tags.clone(),
                    region: RegionFilterSpec::Eq("Japon".into()),
                    statuses: vec![
                        "in_progress".into(),
                        "exported".into(),
                        "done".into(),
                    ],
                    limit: Some(100),
                    ..Default::default()
                },
            ),
            (
                "bbox_kr",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    coords: CoordsFilterSpec::Bbox {
                        min_lat: 33.0,
                        max_lat: 39.0,
                        min_lng: 124.0,
                        max_lng: 132.0,
                    },
                    limit: Some(500),
                    ..Default::default()
                },
            ),
            (
                "no_coords",
                NoteQuery {
                    workspace_id: Some(ws.clone()),
                    coords: CoordsFilterSpec::NoCoords,
                    limit: Some(100),
                    ..Default::default()
                },
            ),
        ];
        for (label, q) in cases {
            for _ in 0..2 {
                let _ = query(&conn, q.clone()).unwrap();
            }
            let t = Instant::now();
            let r = query(&conn, q).unwrap();
            eprintln!(
                "note_query {label:12}: {:>6} ms  page {} of {}",
                t.elapsed().as_millis(),
                r.notes.len(),
                r.total
            );
        }
        for _ in 0..2 {
            let _ = year_histogram(&conn, Some(ws.clone())).unwrap();
        }
        let t = Instant::now();
        let yh = year_histogram(&conn, Some(ws)).unwrap();
        eprintln!(
            "year_histogram       : {:>6} ms  years {}",
            t.elapsed().as_millis(),
            yh.len()
        );
    }
}
