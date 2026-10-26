//! Offline synthetic corpus seeder for Brise performance measurement.
//!
//! **Debug-only.** Release builds of this binary refuse to run (see main). The seed
//! implementation itself lives in `brise_lib::dev_seed`, which is compiled only under
//! `debug_assertions` or `test` — so release `brise` / `brise_lib` never contain the seeder.
//!
//! Usage (app must be **closed** — it locks brise.db). `--db` is **required** — this is an
//! offline instrumentation tool and must never default to a real user's data directory
//! (risk audit C: it used to fall back to `%APPDATA%\com.brise.app`, and `--wipe` could silently
//! wipe a real notebook if the flag was forgotten):
//! ```text
//! cargo run --manifest-path src-tauri/Cargo.toml --bin seed_corpus --features dev-tools -- --db C:\path\to\brise.db --notes 1000
//! cargo run --manifest-path src-tauri/Cargo.toml --bin seed_corpus --features dev-tools -- --db C:\path\to\brise.db --wipe
//! ```
//!
//! `BRISE_DATA_DIR` is no longer consulted for the default path (there is no default path).

fn main() {
    #[cfg(not(debug_assertions))]
    {
        eprintln!(
            "seed_corpus is debug-only and cannot run in a release build.\n\
             Rebuild without --release:\n  \
             cargo run --manifest-path src-tauri/Cargo.toml --bin seed_corpus --features dev-tools -- --notes N"
        );
        std::process::exit(2);
    }

    #[cfg(debug_assertions)]
    {
        if let Err(e) = run() {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

/// 리스크 감사 C: 예전엔 `--db` 를 빠뜨리면 %APPDATA%\com.brise.app(실사용자 노트북 DB) 로
/// 폴백했다 — 계측 도구에 `--wipe` 까지 있어 위험했다. 이제 `--db` 없이는 그냥 에러로 죽는다.
#[cfg(debug_assertions)]
fn resolve_db_path(explicit: Option<&std::path::Path>) -> Result<std::path::PathBuf, String> {
    explicit
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "--db PATH is required (no default — this tool must never guess a real user's data dir; see --help)".to_string())
}

#[cfg(debug_assertions)]
fn run() -> Result<(), String> {
    use brise_lib::db::{self, migrations};
    use brise_lib::dev_seed;
    use std::env;
    use std::path::PathBuf;

    let mut notes: Option<usize> = None;
    let mut folders: usize = 20;
    let mut wipe_only = false;
    let mut wipe_first = true;
    let mut db_path: Option<PathBuf> = None;
    let mut rng_seed: u64 = 1;
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--notes" | "-n" => {
                let v = args
                    .next()
                    .ok_or("--notes requires a value")?
                    .parse::<usize>()
                    .map_err(|e| format!("--notes: {e}"))?;
                notes = Some(v);
            }
            "--folders" | "-f" => {
                folders = args
                    .next()
                    .ok_or("--folders requires a value")?
                    .parse()
                    .map_err(|e| format!("--folders: {e}"))?;
            }
            "--wipe" => wipe_only = true,
            "--no-wipe" => wipe_first = false,
            "--db" => {
                db_path = Some(PathBuf::from(
                    args.next().ok_or("--db requires a path")?,
                ));
            }
            "--seed" => {
                rng_seed = args
                    .next()
                    .ok_or("--seed requires a value")?
                    .parse()
                    .map_err(|e| format!("--seed: {e}"))?;
            }
            "--help" | "-h" => {
                print_help();
                return Ok(());
            }
            other => return Err(format!("unknown arg: {other} (try --help)")),
        }
    }

    let path = resolve_db_path(db_path.as_deref())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    println!("db: {}", path.display());
    let mut conn = db::open(&path).map_err(|e| e.to_string())?;
    migrations::run(&mut conn).map_err(|e| e.to_string())?;
    // Minimal workspace if brand-new file (migrations::seed is idempotent).
    migrations::seed(&mut conn).map_err(|e| e.to_string())?;

    if wipe_only {
        let r = dev_seed::wipe_corpus(&mut conn)?;
        println!("wiped corpus in {} ms", r.elapsed_ms);
        return Ok(());
    }

    let n = notes.ok_or(
        "pass --notes N (e.g. 1000, 10000, 100000) or --wipe\n  see --help",
    )?;
    if n == 0 {
        return Err("--notes must be > 0".into());
    }

    println!(
        "seeding {n} notes / {folders} folders \
         (wipe_first={wipe_first}, rng_seed={rng_seed})…"
    );
    let r = dev_seed::seed_corpus(&mut conn, n, folders, wipe_first, rng_seed)?;
    println!(
        "done in {} ms — notes={} folders={} tags={} geo={} favorites={}",
        r.elapsed_ms,
        r.notes,
        r.folders,
        r.tags,
        r.with_geo,
        r.favorites,
    );
    println!(
        "\nNext: start the app (dev build) and open the Perf overlay (Ctrl+Shift+P) \
         to measure UI interactions."
    );
    Ok(())
}

#[cfg(debug_assertions)]
fn print_help() {
    eprintln!(
        "\
Brise synthetic corpus seeder (debug-only)

USAGE:
  cargo run --manifest-path src-tauri/Cargo.toml --bin seed_corpus --features dev-tools -- [OPTIONS]

OPTIONS:
  --notes, -n N         Number of notes to insert (required unless --wipe)
  --folders, -f N       Folder count (default 20)
  --wipe                Only wipe notes/folders/tags/attachments (no seed)
  --no-wipe             Append without wiping first (default is wipe then seed)
  --db PATH             brise.db path (REQUIRED — no default, to avoid ever touching a real user's data)
  --seed N              RNG seed for reproducible corpora (default 1)
  --help, -h            Show this help

The app must be closed while seeding (SQLite lock on brise.db).
Settings (including API keys) are never read or modified.
"
    );
}
