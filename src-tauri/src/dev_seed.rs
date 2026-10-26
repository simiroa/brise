//! Dev-only synthetic corpus seeder for scale measurement (docs/SCALABILITY.md §6).
//!
//! Gated with `#[cfg(any(debug_assertions, test))]` from `lib.rs` — this module is **not
//! compiled into release builds of the library**, so production binaries cannot call it.
//! The `seed_corpus` cargo binary also refuses to run under `--release` (compile-time branch).
//!
//! Design goals (Phase 0 measure-only wave):
//! - Batched transactions (not one-tx-per-note) so 100k finishes in seconds, not minutes.
//! - Realistic skew: clustered years, Zipf-ish tags, geo clusters, status/favourite mix,
//!   multi-paragraph bodies so FTS and snippets have real text.
//! - Deterministic given (n_notes, seed) so runs are comparable.
//!
//! Not a Tauri command: seed offline against a closed app (brise.db is locked while running).

use crate::util::{new_id, now_iso, today_ymd_local};
use chrono::Datelike;
use rusqlite::{params, Connection};
use std::time::Instant;

/// Report returned after a successful seed or wipe.
#[derive(Debug, Clone)]
pub struct SeedReport {
    pub notes: usize,
    pub folders: usize,
    pub tags: usize,
    pub with_geo: usize,
    pub favorites: usize,
    pub elapsed_ms: u128,
}

// ── Deterministic PRNG (no extra crate) ──────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // Avoid zero state (xorshift degenerates).
        Self(seed | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() as f64) / (u64::MAX as f64)
    }
    fn gen_range(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        let span = (hi - lo) as u64;
        lo + (self.next_u64() % (span + 1)) as i64
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.next_u64() as usize % items.len()]
    }
}

// ── Corpus shape constants ───────────────────────────────────────────────────

const FOLDER_NAMES: &[&str] = &[
    "Goryeo",
    "Joseon",
    "Modern",
    "Diplomacy",
    "Culture",
    "War & Conflict",
    "Religion",
    "Economy",
    "Science",
    "Daily Life",
    "Persons",
    "Sources",
    "Maps & Places",
    "Drafts",
    "Archive A",
    "Archive B",
    "Comparisons",
    "Historiography",
    "Material Culture",
    "Oral History",
];

/// Head tags appear on thousands of notes; the long tail is rare.
const HEAD_TAGS: &[&str] = &[
    "dynastie",
    "guerre",
    "culture",
    "diplomatie",
    "bouddhisme",
    "roi",
    "réforme",
    "commerce",
    "invasion",
    "indépendance",
];

const TAIL_TAGS: &[&str] = &[
    "sejong",
    "hangul",
    "mongol",
    "imjin",
    "yi-sun-sin",
    "tripitaka",
    "ganghwa",
    "samguk",
    "goryeosa",
    "nanjung",
    "samil",
    "confucianisme",
    "yangban",
    "agriculture",
    "céramique",
    "imprimerie",
    "astronomie",
    "médecine",
    "poésie",
    "architecture",
    "temple",
    "forteresse",
    "marine",
    "cavalerie",
    "traite",
    "missionnaire",
    "carte",
    "chronique",
    "épigraphie",
    "archives",
    "portrait",
    "rituel",
    "calendrier",
    "monnaie",
    "impôt",
    "esclavage",
    "révolte",
    "exil",
    "alliance",
    "tribut",
];

/// Region label + approximate cluster centre (lat, lng) + jitter radius degrees.
const GEO_CLUSTERS: &[(&str, f64, f64, f64)] = &[
    ("Corée", 37.5, 127.0, 2.5),
    ("Corée", 35.2, 129.1, 1.2), // Busan area
    ("Chine", 39.9, 116.4, 3.0),
    ("Chine", 34.3, 108.9, 2.0), // Xi'an
    ("Japon", 35.0, 135.8, 2.0), // Kansai
    ("Japon", 35.7, 139.7, 1.5), // Tokyo
    ("France", 48.9, 2.3, 2.5),
    ("France", 45.8, 4.8, 1.5), // Lyon
    ("Italie", 41.9, 12.5, 2.0),
    ("Égypte", 30.0, 31.2, 2.0),
    ("Inde", 28.6, 77.2, 3.0),
    ("Vietnam", 21.0, 105.8, 2.0),
];

const STATUSES: &[Option<&str>] = &[
    None,
    None,
    None,
    None,
    None,
    None, // ~50% unset
    Some("in_progress"),
    Some("in_progress"),
    Some("exported"),
    Some("done"),
];

const BODY_SNIPPETS: &[&str] = &[
    "Les chroniques de l'époque décrivent une cour préoccupée par la défense des frontières \
     et la légitimité dynastique. Les annales mentionnent des tributs, des alliances \
     matrimoniales et des réformes administratives successives.",
    "Sur le plan culturel, les élites cultivèrent la poésie, l'épigraphie et l'imprimerie \
     sur bois. Les temples et collèges confucéens structurèrent la formation des lettrés \
     pendant plusieurs générations.",
    "Les sources secondaires soulignent le rôle du commerce maritime et des réseaux \
     continentaux. Les portulans et les récits de voyage complètent les chroniques officielles \
     pour reconstituer les flux de biens et d'idées.",
    "La mémoire collective a retenu des batailles décisives et des figures héroïques, \
     mais l'histoire sociale montre aussi la vie des paysans, artisans et marchands sous \
     la pression fiscale et les corvées.",
    "Les archives diplomatiques révèlent une politique de tribut et d'ambassades soigneusement \
     calibrée. Les missives conservées permettent de dater avec précision plusieurs tournants \
     de la politique extérieure.",
    "Les fouilles archéologiques et la céramique fine confirment l'ampleur des échanges \
     régionaux. L'iconographie bouddhique et les stèles funéraires offrent un contrepoint \
     aux récits officiels du pouvoir central.",
];

const TITLE_TOPICS: &[&str] = &[
    "réforme fiscale",
    "ambassade",
    "siège",
    "édit royal",
    "fondation du temple",
    "révolte paysanne",
    "traité commercial",
    "codification",
    "expédition navale",
    "crise de succession",
    "épidémie",
    "construction de forteresse",
    "cérémonie du sacre",
    "réforme de l'écriture",
    "mission d'observation",
];

/// GFM checklist line texts (dashboard work-tab checkbox scan, docs/DASHBOARD.md).
const TODO_ITEMS: &[&str] = &[
    "Vérifier la datation de la source primaire",
    "Comparer avec la chronique parallèle",
    "Relire la section diplomatie",
    "Rassembler les cartes régionales manquantes",
    "Confirmer l'orthographe des noms propres",
    "Ajouter la référence bibliographique complète",
    "Croiser avec les archives locales",
    "Vérifier la traduction du passage cité",
];

// ── Public API ───────────────────────────────────────────────────────────────

/// Wipe note content (and tags/folders) so a seed run starts from a known empty corpus.
/// Keeps workspaces and settings; recreates nothing. Call `seed` afterwards.
/// Never touches the settings table (API keys live there and must not be read, printed, or
/// copied by this path).
pub fn wipe_corpus(conn: &mut Connection) -> Result<SeedReport, String> {
    let t0 = Instant::now();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    crate::repo::fts::clear_all(&tx).map_err(|e| e.to_string())?;
    // Order respects FKs.
    for sql in [
        "DELETE FROM note_tags",
        "DELETE FROM attachments",
        "DELETE FROM sources",
        "DELETE FROM sections",
        "DELETE FROM notes",
        "DELETE FROM tags",
        "DELETE FROM folders",
        "DELETE FROM workspace_regions",
        "DELETE FROM workspace_eras",
        "DELETE FROM workspace_statuses",
    ] {
        tx.execute(sql, []).map_err(|e| format!("{sql}: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SeedReport {
        notes: 0,
        folders: 0,
        tags: 0,
        with_geo: 0,
        favorites: 0,
        elapsed_ms: t0.elapsed().as_millis(),
    })
}

/// Seed `n_notes` into the first workspace (creating one if the DB is empty of workspaces).
/// Wipes existing notes/folders/tags first when `wipe_first` is true.
pub fn seed_corpus(
    conn: &mut Connection,
    n_notes: usize,
    n_folders: usize,
    wipe_first: bool,
    rng_seed: u64,
) -> Result<SeedReport, String> {
    if wipe_first {
        wipe_corpus(conn)?;
    }

    let t0 = Instant::now();
    let now = now_iso();
    let mut rng = Rng::new(rng_seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (n_notes as u64));
    // Real "now" (like `now` above) — content sampling stays seed-deterministic, but the
    // dashboard-QA fields below are defined relative to the current date on purpose.
    let (cur_y, _, _) = today_ymd_local();
    let max_year = cur_y + 1;
    let today_naive = chrono::Local::now().date_naive();

    // Ensure a workspace exists.
    let ws: String = match conn
        .query_row("SELECT id FROM workspaces ORDER BY created_at LIMIT 1", [], |r| {
            r.get(0)
        }) {
        Ok(id) => id,
        Err(_) => {
            let id = new_id();
            conn.execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,?2,?3)",
                params![id, "Perf Corpus", now],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };

    let n_folders = n_folders.clamp(1, FOLDER_NAMES.len().max(1));
    let mut folder_ids = Vec::with_capacity(n_folders);
    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for i in 0..n_folders {
            let id = new_id();
            let name = FOLDER_NAMES[i % FOLDER_NAMES.len()];
            // ~40% open so tree expand cost is exercised but not all folders dump rows.
            let is_open: i64 = if i % 5 < 2 { 1 } else { 0 };
            tx.execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, ws, name, i as i64, is_open, now],
            )
            .map_err(|e| e.to_string())?;
            folder_ids.push(id);
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // Tags: head + tail.
    let mut tag_ids: Vec<String> = Vec::with_capacity(HEAD_TAGS.len() + TAIL_TAGS.len());
    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for name in HEAD_TAGS.iter().chain(TAIL_TAGS.iter()) {
            let id = new_id();
            tx.execute("INSERT INTO tags(id, name) VALUES (?1,?2)", params![id, name])
                .map_err(|e| e.to_string())?;
            tag_ids.push(id);
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // Zipf-ish weights for tag selection (rank 0 is heaviest).
    let tag_weights: Vec<f64> = (0..tag_ids.len())
        .map(|rank| 1.0 / (rank as f64 + 1.0))
        .collect();
    let tag_weight_sum: f64 = tag_weights.iter().sum();

    let batch = 2_000usize;
    let mut with_geo = 0usize;
    let mut favorites = 0usize;

    for batch_start in (0..n_notes).step_by(batch) {
        let batch_end = (batch_start + batch).min(n_notes);
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut note_stmt = tx
                .prepare(
                    "INSERT INTO notes(id, folder_id, title, year, month, day, is_favorite, \
                     exported_at, created_at, updated_at, region, status, lat, lng, \
                     end_year, end_month, end_day, remind) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                )
                .map_err(|e| e.to_string())?;
            // PLAN-2026-09-08-dates-rebuild.md §7-2: every note needs a position=0 note_dates
            // row (the truth the notes.* columns above only mirror) — insert_note/
            // create_with_sections_with_hook always create one, but this seeder writes `notes`
            // directly for batch-insert speed and used to skip it. Without this row,
            // project_primary() throws its invariant-violation error the first time anything
            // touches a seeded note's date (editing it, AI organize, adding a related date) —
            // fine as a guard for real data, not fine for a QA/perf corpus that's meant to be
            // clicked around in a dev build.
            let mut date_stmt = tx
                .prepare(
                    "INSERT INTO note_dates(id, note_id, position, year, month, day, end_year, end_month, end_day, remind, created_at) \
                     VALUES (?1,?2,0,?3,?4,?5,?6,?7,?8,?9,?10)",
                )
                .map_err(|e| e.to_string())?;
            let mut sec_stmt = tx
                .prepare(
                    "INSERT INTO sections(id, note_id, name, body_md, position) \
                     VALUES (?1,?2,'Overview',?3,0)",
                )
                .map_err(|e| e.to_string())?;
            // Direct FTS insert (same columns as fts_upsert) — avoids per-note re-aggregation.
            // Sanctioned exception to the fts.rs sole-writer rule (docs/DATA-WRITES.md §1):
            // the seeder may write notes_fts low-level in the same transaction; routing
            // through fts::fts_upsert would defeat the reason the seeder exists. The 2-char index
            // (notes_bigram) is written per note right after, through fts::bigram_index.
            let mut fts_stmt = tx
                .prepare(
                    "INSERT INTO notes_fts(note_id, title, body, source_body, tag_names) \
                     VALUES (?1,?2,?3,'',?4)",
                )
                .map_err(|e| e.to_string())?;
            let mut tag_stmt = tx
                .prepare("INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1,?2)")
                .map_err(|e| e.to_string())?;

            for i in batch_start..batch_end {
                let id = new_id();
                let folder_id = &folder_ids[i % folder_ids.len()];
                let mut year = sample_year(&mut rng, max_year);
                let mut month: Option<i64> = None;
                let mut day: Option<i64> = None;
                let mut end_year: Option<i64> = None;
                let mut end_month: Option<i64> = None;
                let mut end_day: Option<i64> = None;

                // ~10%: "near deadline" — due_at is retired (docs/DASHBOARD.md §2, 2026-08-01);
                // a period's end *is* the deadline now. Full day precision on both start and
                // end, both close to today, so the work-tab board's four urgency buckets
                // (overdue/today/this-week/later) stay populated after the merge. This must run
                // BEFORE the title is built below — re-rolling `year` *after* formatting the
                // title was a real bug here (title showed the old year, DB stored the new one).
                if rng.next_f64() < 0.10 {
                    let (sy, sm, sd, ey, em, ed) = sample_near_deadline(&mut rng, today_naive);
                    year = sy;
                    month = Some(sm);
                    day = Some(sd);
                    end_year = Some(ey);
                    end_month = Some(em);
                    end_day = Some(ed);
                } else if rng.next_f64() < 0.10 {
                    // ~10% of the remainder: multi-year historical span (year precision only,
                    // unrelated to deadlines) — so the calendar's span rendering and the
                    // timeline's period bars have real cases beyond point events.
                    end_year = sample_end_year(&mut rng, year);
                }

                // Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): "알려줘"(remind) opt-in
                // flag — only meaningful on notes that actually have an end date, so QA can see
                // the kanban pin/red-dot without every seeded note qualifying.
                let remind: i64 = if end_year.is_some() && rng.next_f64() < 0.05 { 1 } else { 0 };

                let topic = rng.pick(TITLE_TOPICS);
                let title = format!("{topic} ({year}) #{i}"); // always the final `year`
                let mut body = sample_body(&mut rng, i, year, topic);
                if rng.next_f64() < 0.15 {
                    body.push_str(&sample_checklist_md(&mut rng));
                }
                let is_fav: i64 = if rng.next_f64() < 0.08 {
                    favorites += 1;
                    1
                } else {
                    0
                };
                let status = *rng.pick(STATUSES);
                let (region, lat, lng) = sample_geo(&mut rng);
                if region.is_some() {
                    with_geo += 1;
                }

                // 0–4 tags with Zipf pick (duplicates possible → OR IGNORE).
                let n_tags = match rng.next_u64() % 10 {
                    0..=2 => 0,
                    3..=5 => 1,
                    6..=7 => 2,
                    8 => 3,
                    _ => 4,
                };
                let mut tag_names: Vec<&str> = Vec::with_capacity(n_tags);
                let mut picked_tag_ids: Vec<String> = Vec::with_capacity(n_tags);
                for _ in 0..n_tags {
                    let idx = weighted_index(&mut rng, &tag_weights, tag_weight_sum);
                    picked_tag_ids.push(tag_ids[idx].clone());
                    let name = if idx < HEAD_TAGS.len() {
                        HEAD_TAGS[idx]
                    } else {
                        TAIL_TAGS[idx - HEAD_TAGS.len()]
                    };
                    if !tag_names.contains(&name) {
                        tag_names.push(name);
                    }
                }
                let tag_names_str = tag_names.join(" ");

                note_stmt
                    .execute(params![
                        id,
                        folder_id,
                        title,
                        year,
                        month,
                        day,
                        is_fav,
                        now,
                        region,
                        status,
                        lat,
                        lng,
                        end_year,
                        end_month,
                        end_day,
                        remind
                    ])
                    .map_err(|e| e.to_string())?;
                date_stmt
                    .execute(params![
                        new_id(),
                        id,
                        year,
                        month,
                        day,
                        end_year,
                        end_month,
                        end_day,
                        remind,
                        now
                    ])
                    .map_err(|e| e.to_string())?;
                sec_stmt
                    .execute(params![new_id(), id, body])
                    .map_err(|e| e.to_string())?;
                fts_stmt
                    .execute(params![id, title, body, tag_names_str])
                    .map_err(|e| e.to_string())?;
                // 2글자 색인도 같은 값으로(fts.rs 가 유일한 작성자 — 이 노트 한 개만, 전체 재색인 없이).
                let fts_rowid = tx.last_insert_rowid();
                crate::repo::fts::bigram_index(&tx, fts_rowid, &id, &[&title, &body, "", &tag_names_str])
                    .map_err(|e| e.to_string())?;
                for tid in &picked_tag_ids {
                    tag_stmt
                        .execute(params![id, tid])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(SeedReport {
        notes: n_notes,
        folders: n_folders,
        tags: tag_ids.len(),
        with_geo,
        favorites,
        elapsed_ms: t0.elapsed().as_millis(),
    })
}

// ── Sampling helpers ─────────────────────────────────────────────────────────

/// Clustered years across the UI-relevant span and a long historical tail.
/// Uniform sampling would flatten the timeline histogram; real history is lumpy.
///
/// `max_year` caps the sparse-late bucket — pass the *current* year (+1) so a subset of
/// notes always land in the dashboard's default calendar month/board view (year-only notes
/// span their whole year, so year == current year is what makes them show up there; a fixed
/// 2020 cap silently aged out of "current" as real time moved past it).
fn sample_year(rng: &mut Rng, max_year: i64) -> i64 {
    let r = rng.next_f64();
    if r < 0.30 {
        // Goryeo core
        rng.gen_range(918, 1392)
    } else if r < 0.65 {
        // Joseon core
        rng.gen_range(1392, 1910)
    } else if r < 0.85 {
        // Modern / colonial / early 20c (within search FULL_SPAN upper half)
        rng.gen_range(1910, 1960)
    } else if r < 0.93 {
        // Pre-Goryeo / early medieval (still in FULL_SPAN lower end)
        rng.gen_range(900, 918)
    } else if r < 0.98 {
        // Sparse deep history (exercises bounds outside default FULL_SPAN 900..1960)
        rng.gen_range(-200, 899)
    } else {
        // Sparse late (outside FULL_SPAN upper), up through "now" so dashboard views that
        // key off the current year/month have something to show.
        rng.gen_range(1961, max_year)
    }
}

/// Dashboard Wave 2 (docs/DASHBOARD.md §2, 2026-08-01): due_at is retired — a period's end is
/// the deadline now. Samples a full-precision (start, end) pair both close to today, spread
/// across the four urgency buckets the work-tab board sorts by (overdue / due-today /
/// due-this-week / later), so QA still sees all four after the merge. Start is 0..21 days
/// before end (never after — end⇒start invariant).
fn sample_near_deadline(
    rng: &mut Rng,
    today: chrono::NaiveDate,
) -> (i64, i64, i64, i64, i64, i64) {
    let r = rng.next_f64();
    let end_offset_days = if r < 0.25 {
        rng.gen_range(-7, -1) // overdue: end was last week
    } else if r < 0.35 {
        0 // due today
    } else if r < 0.65 {
        rng.gen_range(1, 7) // due this week
    } else {
        rng.gen_range(8, 30) // due later (within the month)
    };
    let end_date = today + chrono::Duration::days(end_offset_days);
    let start_date = end_date - chrono::Duration::days(rng.gen_range(0, 21));
    (
        start_date.year() as i64,
        start_date.month() as i64,
        start_date.day() as i64,
        end_date.year() as i64,
        end_date.month() as i64,
        end_date.day() as i64,
    )
}

/// ~10% of notes get an `end_year` (multi-year span) so the calendar's span rendering and
/// the timeline's period bars have real cases to draw, not just point events.
fn sample_end_year(rng: &mut Rng, year: i64) -> Option<i64> {
    if rng.next_f64() >= 0.10 {
        return None;
    }
    Some(year + rng.gen_range(1, 5))
}

/// ~15% of notes get a short GFM checklist appended to the body so the work-tab checkbox
/// scan (dashboard::parse_checkboxes) has real "- [ ]"/"- [x]" lines to find.
fn sample_checklist_md(rng: &mut Rng) -> String {
    let n = rng.gen_range(2, 5);
    let mut out = String::from("\n### À faire\n\n");
    for _ in 0..n {
        let mark = if rng.next_f64() < 0.4 { 'x' } else { ' ' };
        out.push_str(&format!("- [{mark}] {}\n", rng.pick(TODO_ITEMS)));
    }
    out
}

fn sample_body(rng: &mut Rng, i: usize, year: i64, topic: &str) -> String {
    let a = rng.pick(BODY_SNIPPETS);
    let b = rng.pick(BODY_SNIPPETS);
    let c = rng.pick(BODY_SNIPPETS);
    format!(
        "# {topic} ({year})\n\n\
         Note synthétique #{i} destinée aux mesures de performance. \
         Le sujet principal est **{topic}** autour de l'année {year}.\n\n\
         {a}\n\n\
         {b}\n\n\
         ### Sources mentionnées\n\n\
         - Chronique officielle, volume {}.\n\
         - Compte rendu d'ambassade, année {year}.\n\
         - Inventaire matériel, entrée {}.\n\n\
         {c}\n\n\
         Mots-clés pour la recherche plein texte: dynastie, réforme, tribut, \
         invasion, temple, chroniques, commerce maritime, lettrés.\n",
        (i % 40) + 1,
        (i % 900) + 1,
    )
}

/// ~1/3 of notes get region + lat/lng in real-world clusters.
fn sample_geo(rng: &mut Rng) -> (Option<String>, Option<f64>, Option<f64>) {
    if rng.next_f64() >= 0.34 {
        return (None, None, None);
    }
    let (region, lat0, lng0, radius) = *rng.pick(GEO_CLUSTERS);
    let lat = (lat0 + (rng.next_f64() * 2.0 - 1.0) * radius).clamp(-85.0, 85.0);
    let lng = (lng0 + (rng.next_f64() * 2.0 - 1.0) * radius).clamp(-180.0, 180.0);
    // 5% of geo notes have region but no coords (partial data path).
    if rng.next_f64() < 0.05 {
        return (Some(region.to_string()), None, None);
    }
    (
        Some(region.to_string()),
        Some((lat * 1e6).round() / 1e6),
        Some((lng * 1e6).round() / 1e6),
    )
}

fn weighted_index(rng: &mut Rng, weights: &[f64], sum: f64) -> usize {
    let mut x = rng.next_f64() * sum;
    for (i, w) in weights.iter().enumerate() {
        if x < *w {
            return i;
        }
        x -= *w;
    }
    weights.len().saturating_sub(1)
}

// ── Tests (gate: cargo test --lib dev_seed) ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use rusqlite::Connection;
    use std::path::Path;

    fn open_seeded_db(data_dir: &Path) -> Connection {
        let db_path = data_dir.join(crate::db::DB_FILE);
        let mut conn = Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        migrations::seed(&mut conn).unwrap();
        conn
    }

    #[test]
    fn sample_year_reaches_current_year() {
        // A fixed upper cap (e.g. 2020) ages out of "current" as real time passes; sample_year
        // must track today's year so the dashboard calendar's default month has notes to show
        // (year-only notes span their whole year, so year == current year is what matters).
        let (cur_y, _, _) = today_ymd_local();
        let max_year = cur_y + 1;
        let mut rng = Rng::new(1);
        let hit = (0..5_000).any(|_| sample_year(&mut rng, max_year) == cur_y);
        assert!(hit, "expected sample_year to reach the current year ({cur_y}) within 5000 draws");
    }

    #[test]
    fn seed_covers_current_year_for_calendar_qa() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_seeded_db(dir.path());
        seed_corpus(&mut conn, 2_000, 10, true, 1).unwrap();
        // End-to-end check that max_year reaches seed_corpus (not just the unit-level
        // sample_year test above): the old hardcoded cap topped out at 2019, so any note
        // past that proves the current-year wiring, without depending on the exact current
        // year landing in the ~2% sparse-late bucket (which would make this test flaky).
        let max_year: i64 = conn
            .query_row("SELECT MAX(year) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert!(
            max_year > 2019,
            "expected sample_year to exceed the old hardcoded 2019 cap, got max={max_year}"
        );
    }

    // 리그레션(PLAN-2026-09-08-dates-rebuild.md §7-2, 감사 2026-09-08 발견): 이 시더는 성능을
    // 위해 `notes` 를 직접 INSERT 하고 insert_note/create_with_sections_with_hook 을 거치지
    // 않는다 — 그 경로들이 항상 심는 position=0 note_dates 행이 빠지면
    // repo::notes::dates::project_primary 가 불변식 위반 에러를 던진다. 이 코드베이스에서 그
    // 함수는 날짜를 건드리는 모든 경로(달력 편집, AI 정리, 관련 날짜 추가...)의 마지막 단계라,
    // 시딩한 노트를 조금만 만져도 개발 빌드가 에러로 죽었을 것이다.
    #[test]
    fn seed_gives_every_note_a_position_zero_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_seeded_db(dir.path());
        seed_corpus(&mut conn, 500, 10, true, 1).unwrap();

        let n_notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        let n_primary_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_dates WHERE position=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_notes, n_primary_rows, "every seeded note must have exactly one position=0 note_dates row");

        // End-to-end: project_primary() must not error on a freshly seeded note (this is the
        // actual failure mode the count check above stands in for).
        let some_note: String = conn.query_row("SELECT id FROM notes LIMIT 1", [], |r| r.get(0)).unwrap();
        let tx = conn.transaction().unwrap();
        crate::repo::notes::dates::project_primary(&tx, &some_note).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn seed_populates_near_deadline_ends_and_checklists() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_seeded_db(dir.path());
        seed_corpus(&mut conn, 500, 10, true, 1).unwrap();

        // 칸반 핀 게이트(repo::dashboard::is_pinned)의 필요조건인 end_day(풀 정밀도)가
        // 시딩되는지 — due_at 폐지 후 이 필드가 그 자리를 대신한다.
        let n_deadline: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE end_day IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            n_deadline > 0,
            "expected some notes with a full-precision (near-deadline) end"
        );
        // Near-deadline notes also get a full-precision start — "시작도 근접 날짜" (owner spec).
        let n_start_precise: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE end_day IS NOT NULL AND day IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            n_start_precise, n_deadline,
            "near-deadline notes must have full start precision too"
        );

        // All four urgency buckets used by the board (overdue/today/this-week/later) exist.
        let (cur_y, cur_m, cur_d) = today_ymd_local();
        let today = format!("{cur_y:04}-{cur_m:02}-{cur_d:02}");
        let n_overdue: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE end_day IS NOT NULL
                 AND printf('%04d-%02d-%02d', end_year, end_month, end_day) < ?1",
                params![today],
                |r| r.get(0),
            )
            .unwrap();
        let n_upcoming: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE end_day IS NOT NULL
                 AND printf('%04d-%02d-%02d', end_year, end_month, end_day) >= ?1",
                params![today],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n_overdue > 0, "expected at least one overdue note");
        assert!(n_upcoming > 0, "expected at least one due-today-or-later note");

        // The unrelated (non-deadline) year-precision multi-year span bucket: end_year set,
        // no end_day — distinct from the near-deadline rows checked above.
        let n_span: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE end_year IS NOT NULL AND end_day IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n_span > 0, "expected some notes with a year-precision end (calendar span QA)");
        // end_year must be strictly after year — a real span, not a same-year no-op (near-
        // deadline rows are excluded: same-year same/near-day ends are valid there).
        let n_bad_span: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE end_year IS NOT NULL AND end_day IS NULL AND end_year <= year",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_bad_span, 0, "end_year must be after year");

        // At least one section body has a GFM checklist line the dashboard's checkbox scan
        // (repo::dashboard::parse_checkboxes) can find.
        let n_checklist: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sections WHERE body_md LIKE '%- [ ] %' OR body_md LIKE '%- [x] %'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n_checklist > 0, "expected some sections with a GFM checklist");

        // Dashboard Wave 3 (2026-08-01): some end-dated notes are flagged remind=1 so QA can see
        // the kanban pin/red-dot; a note without any end date is never flagged (opt-in flag is
        // inert without a date, but the seeder shouldn't waste flags on notes that can't show it).
        let n_remind: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE remind=1", [], |r| r.get(0))
            .unwrap();
        assert!(n_remind > 0, "expected some notes flagged remind=1");
        let n_remind_without_end: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE remind=1 AND end_year IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_remind_without_end, 0, "remind must only be set on notes with an end date");
    }
}
