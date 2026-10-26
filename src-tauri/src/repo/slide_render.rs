//! 슬라이드(pptx) → pdf 변환. 변환 결과는 **기존 pdf 프리뷰가 그대로** 그린다(두 번째 구현 없음).
//!
//! 부재·실패·타임아웃은 전부 정상 경로다 — LibreOffice 를 안 깐 사용자가 에러를 보면 안 된다.
//! 그래서 이 모듈은 `AppError` 를 내지 않고 폴백 사유 문자열만 돌려준다.
//!
//! ponytail: 진행률·취소가 없다. 1GB 덱은 분 단위가 걸리고 그동안 프런트는 스피너만 돈다 —
//! 필요해지면 `crate::events::publish` 로 단계를 올리고 취소 토큰을 붙인다.

use crate::db;
use crate::error::{db as dberr, AppResult};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 슬라이드로 볼 확장자. docx 는 텍스트 추출로 충분하다는 게 이번 판단(2026-09-10) —
/// 바뀌면 여기 한 줄이 는다.
pub const SLIDE_EXTS: &[&str] = &["pptx"];

/// ponytail: 고정 상한. 덱 크기로 스케일할 신호가 없어 평평한 벽이다 — 넘으면 프로세스를 죽인다
/// (멈춘 soffice 가 남으면 다음 변환까지 막힌다).
const CONVERT_TIMEOUT: Duration = Duration::from_secs(300);

/// 폴백 사유 — 프런트가 그대로 분기한다.
pub const REASON_NO_CONVERTER: &str = "no_converter";
pub const REASON_UNSUPPORTED: &str = "unsupported";
pub const REASON_FAILED: &str = "failed";
pub const REASON_TIMEOUT: &str = "timeout";

pub fn is_slide(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    SLIDE_EXTS.contains(&ext.as_str())
}

/// ponytail: 자동 탐지 결과는 프로세스 수명 동안 캐시한다 — 앱을 켠 뒤 LibreOffice 를 설치하면
/// 재시작해야 잡힌다. 설정 override 는 캐시하지 않으므로 즉시 반영된다.
static AUTO_SOFFICE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// override(설정) → PATH → OS 표준 설치 경로 순.
pub fn soffice_path(override_path: &str) -> Option<PathBuf> {
    let over = override_path.trim();
    if !over.is_empty() {
        let p = PathBuf::from(over);
        return p.is_file().then_some(p);
    }
    AUTO_SOFFICE.get_or_init(detect_soffice).clone()
}

/// 변환기 경로가 `dir`(데이터 폴더) 안을 가리키는가 — 정규화 경로 접두 검사. 데이터 폴더는 첨부 업로드가
/// 닿는 곳이라 그 안의 실행 파일을 변환기로 돌리면 안 된다(AUDIT-2026-10-23 R1 심층 방어). 정규화에
/// 실패한 쪽은 원문 그대로 비교한다 — `soffice_path` 가 `is_file()` 을 이미 확인했으므로 보통은 둘 다 성공한다.
pub fn is_inside_dir(path: &Path, dir: &Path) -> bool {
    // 둘 다 정규화되거나 둘 다 원문이어야 한다 — Windows 의 정규화 경로는 `\\?\` 접두가 붙어 원문과 섞어 비교하면 늘 거짓이 된다.
    match (path.canonicalize(), dir.canonicalize()) {
        (Ok(p), Ok(d)) => p.starts_with(&d),
        _ => path.starts_with(dir),
    }
}

fn detect_soffice() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "soffice.exe" } else { "soffice" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join(exe);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    for base in [
        r"C:\Program Files\LibreOffice\program",
        r"C:\Program Files (x86)\LibreOffice\program",
        "/Applications/LibreOffice.app/Contents/MacOS",
        "/usr/bin",
        "/usr/local/bin",
        "/snap/bin",
    ] {
        let cand = Path::new(base).join(exe);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 캐시 키 = 첨부 id + 원본 mtime + 원본 크기. 원본이 바뀌면 파일명이 바뀌어 자동으로 다시 변환된다.
fn cache_key(id: &str, src: &Path) -> Option<String> {
    let meta = std::fs::metadata(src).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let safe = safe_id(id);
    if safe.is_empty() {
        return None;
    }
    Some(format!("{safe}.{mtime}.{}.pdf", meta.len()))
}

/// 같은 첨부의 옛 변환본을 지운다 — 1GB 덱을 몇 번 고치면 캐시가 무한히 커진다.
/// 부팅 시 고아 슬라이드 캐시 청소 — 첨부가 사라졌는데 변환본만 남는 것을 막는다.
///
/// `prune_stale` 은 **같은 첨부를 다시 변환할 때만** 돈다. 삭제된 첨부는 다시 변환될 일이 없으니
/// 그 변환본은 영원히 남는다. 1GB 덱의 변환본이 수십~수백 MB 라 조용한 디스크 누수다(2026-09-10
/// 에 다른 원인으로 C: 가 100% 차서 빌드가 링크에서 깨지는 것을 겪었다 — 같은 부류다).
///
/// 형태는 `attachments::orphan_cleanup` 과 같다: 살아 있는 id 를 **한 번에** 셋으로 읽고
/// 디렉터리를 훑는다(파일마다 SELECT 하는 N+1 을 만들지 않는다).
///
/// ponytail: 부팅에 한 번만 돈다. 한 세션 안에서 첨부를 지우면 그 변환본은 다음 부팅까지 남는다 —
/// 삭제 경로에서 지우려면 `attachments::remove` 가 이 모듈을 알아야 해서, 그 결합보다 다음 부팅을
/// 택했다. 캐시가 커지는 게 실제로 문제가 되면 그때 삭제 경로에 훅을 건다.
pub fn orphan_cleanup(conn: &Connection, data_dir: &Path) -> AppResult<()> {
    let dir = db::slide_cache_dir(data_dir);
    if !dir.exists() {
        return Ok(());
    }
    // cache_key 가 id 에서 영숫자·`-`·`_` 만 남기므로, 살아 있는 쪽도 같은 필터를 통과시켜야
    // 파일명과 맞춰볼 수 있다.
    let live: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT id FROM attachments").map_err(dberr)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(dberr)?;
        rows.collect::<Result<Vec<String>, _>>()
            .map_err(dberr)?
            .into_iter()
            .map(|id| safe_id(&id))
            .collect()
    };
    for entry in std::fs::read_dir(&dir).map_err(crate::error::io)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        // 작업 디렉터리(.work-*)와 LibreOffice 프로필(.loprofile)은 캐시 항목이 아니다.
        if name.starts_with('.') {
            continue;
        }
        let Some(id) = name.split('.').next() else { continue };
        if !live.contains(id) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// 파일명에 쓸 수 있게 id 를 정규화한다. cache_key 와 orphan_cleanup 이 **같은 규칙**을 써야
/// 파일명과 살아 있는 id 를 맞춰볼 수 있다 — 규칙이 갈리면 청소가 멀쩡한 캐시를 지우거나
/// 고아를 못 알아본다.
fn safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn prune_stale(cache_dir: &Path, id: &str, keep: &str) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name != keep && name.starts_with(&format!("{id}.")) && name.ends_with(".pdf") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// LibreOffice 의 `-env:UserInstallation` 은 경로가 아니라 URL 을 받는다.
/// ponytail: 공백만 인코딩한다 — 실전에서 걸리는 건 "Program Files" 류의 공백뿐이고,
/// 한글/비ASCII 경로는 LibreOffice 가 UTF-8 그대로 받는다.
fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/").replace(' ', "%20");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// 변환(또는 캐시 히트) 후 pdf 절대 경로. Err 는 폴백 사유.
pub fn render(data_dir: &Path, id: &str, src: &Path, soffice: &Path) -> Result<PathBuf, &'static str> {
    let cache_dir = db::slide_cache_dir(data_dir);
    let key = cache_key(id, src).ok_or(REASON_FAILED)?;
    let out = cache_dir.join(&key);
    if out.is_file() {
        return Ok(out);
    }
    std::fs::create_dir_all(&cache_dir).map_err(|_| REASON_FAILED)?;
    prune_stale(&cache_dir, id, &key);

    // 변환은 전용 작업 디렉토리로 받는다 — soffice 는 출력 파일명을 원본 stem 으로 정하므로,
    // 이름이 같은 다른 첨부가 동시에 변환되면 캐시 디렉토리에서 서로 덮어쓴다.
    let work = cache_dir.join(format!(".work-{id}"));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|_| REASON_FAILED)?;

    let mut cmd = std::process::Command::new(soffice);
    cmd.arg("--headless")
        .arg("--norestore")
        // 이미 떠 있는 LibreOffice 가 있으면 headless 변환이 그 인스턴스에 붙어 조용히
        // 실패하거나 멈춘다 — 별도 프로필이 표준 회피책이다.
        .arg(format!("-env:UserInstallation={}", file_url(&cache_dir.join(".loprofile"))))
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&work)
        .arg(src);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let result = crate::collect::ytdlp::run_with_timeout(cmd, CONVERT_TIMEOUT);
    let converted = match result {
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            let _ = std::fs::remove_dir_all(&work);
            return Err(REASON_TIMEOUT);
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&work);
            return Err(REASON_FAILED);
        }
        // soffice 는 변환 실패에도 0 을 내는 일이 있다 — 상태코드가 아니라 산출물로 판정한다.
        Ok(_) => std::fs::read_dir(&work)
            .ok()
            .and_then(|entries| {
                entries.flatten().map(|e| e.path()).find(|p| {
                    p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("pdf")) == Some(true)
                })
            }),
    };
    let Some(converted) = converted else {
        let _ = std::fs::remove_dir_all(&work);
        return Err(REASON_FAILED);
    };
    let moved = std::fs::rename(&converted, &out).is_ok();
    let _ = std::fs::remove_dir_all(&work);
    if moved { Ok(out) } else { Err(REASON_FAILED) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 데이터 폴더 안의 실행 파일은 변환기로 쓰이면 안 된다(첨부 업로드가 닿는 곳). 밖의 파일은 허용.
    #[test]
    fn converter_inside_data_dir_is_detected_and_outside_is_not() {
        let data = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let inside = data.path().join("attachments").join("n1");
        std::fs::create_dir_all(&inside).unwrap();
        touch(&inside, "soffice.exe", b"MZ");
        touch(elsewhere.path(), "soffice.exe", b"MZ");
        assert!(is_inside_dir(&inside.join("soffice.exe"), data.path()));
        assert!(!is_inside_dir(&elsewhere.path().join("soffice.exe"), data.path()));
        // 존재하지 않는 경로도 원문 비교로 판정한다(정규화 실패가 허용으로 새지 않게).
        assert!(is_inside_dir(&data.path().join("nope").join("x.exe"), data.path()));
    }

    /// 첨부가 사라지면 그 변환본도 사라져야 한다. `prune_stale` 은 **같은 첨부를 다시 변환할
    /// 때만** 돌기 때문에, 삭제된 첨부의 변환본은 이 청소가 없으면 영원히 남는다.
    #[test]
    fn orphan_cleanup_drops_caches_of_deleted_attachments_only() {
        let dir = tempfile::tempdir().unwrap();
        let cache = db::slide_cache_dir(dir.path());
        std::fs::create_dir_all(&cache).unwrap();

        // 살아 있는 첨부 하나, 죽은 첨부 하나. 작업 디렉터리와 LibreOffice 프로필도 함께 둔다.
        touch(&cache, "att-live.111.222.pdf", b"pdf");
        touch(&cache, "att-dead.333.444.pdf", b"pdf");
        std::fs::create_dir_all(cache.join(".work-att-dead")).unwrap();
        std::fs::create_dir_all(cache.join(".loprofile")).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE attachments(id TEXT PRIMARY KEY);
             INSERT INTO attachments(id) VALUES ('att-live');",
        )
        .unwrap();

        orphan_cleanup(&conn, dir.path()).unwrap();

        assert!(cache.join("att-live.111.222.pdf").is_file(), "살아 있는 첨부의 변환본을 지웠다");
        assert!(!cache.join("att-dead.333.444.pdf").exists(), "고아 변환본이 남았다");
        // 점으로 시작하는 것은 캐시 항목이 아니다 — 프로필을 지우면 다음 변환이 프로필을 다시 만든다.
        assert!(cache.join(".loprofile").exists(), "LibreOffice 프로필을 지웠다");
    }

    fn touch(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    #[test]
    fn is_slide_only_matches_pptx() {
        assert!(is_slide("deck.pptx"));
        assert!(is_slide("DECK.PPTX"));
        assert!(!is_slide("report.docx"));
        assert!(!is_slide("notes.md"));
        assert!(!is_slide("noext"));
    }

    #[test]
    fn cache_key_changes_with_size() {
        let dir = tempfile::tempdir().unwrap();
        let src = touch(dir.path(), "deck.pptx", b"aa");
        let a = cache_key("att-1", &src).unwrap();
        let src2 = touch(dir.path(), "deck2.pptx", b"aaaa");
        let b = cache_key("att-1", &src2).unwrap();
        assert_ne!(a, b, "원본 크기가 바뀌면 키가 바뀌어 다시 변환된다");
        assert!(a.starts_with("att-1.") && a.ends_with(".pdf"));
    }

    #[test]
    fn prune_stale_keeps_only_current_key() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "att-1.111.222.pdf", b"old");
        touch(dir.path(), "att-1.999.222.pdf", b"new");
        touch(dir.path(), "att-2.111.222.pdf", b"other");
        prune_stale(dir.path(), "att-1", "att-1.999.222.pdf");
        assert!(!dir.path().join("att-1.111.222.pdf").exists());
        assert!(dir.path().join("att-1.999.222.pdf").exists());
        assert!(dir.path().join("att-2.111.222.pdf").exists(), "다른 첨부의 캐시는 건드리지 않는다");
    }

    #[test]
    fn soffice_override_must_be_an_existing_file() {
        assert!(soffice_path("C:/definitely/not/here/soffice.exe").is_none());
        let dir = tempfile::tempdir().unwrap();
        let fake = touch(dir.path(), "soffice.exe", b"");
        assert_eq!(soffice_path(&fake.to_string_lossy()), Some(fake));
    }

    #[test]
    fn file_url_is_a_url_not_a_path() {
        let u = file_url(Path::new(r"C:\Program Files\x"));
        assert_eq!(u, "file:///C:/Program%20Files/x");
        assert_eq!(file_url(Path::new("/home/u/x")), "file:///home/u/x");
    }
}
