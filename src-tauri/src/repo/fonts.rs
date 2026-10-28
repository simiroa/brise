//! 내려받기 글꼴 — docs/PLAN-2026-10-27-fonts.md §5.1.
//!
//! 카탈로그(`src/lib/fonts/catalog.json`, scripts/fonts/build-catalog.mjs 생성)를 **바이너리에 묻어**
//! 쓴다 — 프런트는 글꼴 id 만 넘기고, 받을 URL·해시는 여기서만 정한다(웹뷰가 임의 URL 을 받게 하지 않는다).
//! 받는 흐름은 emoji 팩(repo/emoji.rs)과 같은 계약이다: 진행 상태는 `SingleStyleState`, 파일은
//! `.part` 로 쓰고 rename, 전부 끝나야 `.complete` — 표식이 없으면 다음 요청이 처음부터 다시 받는다.
//! emoji 와 달리 파일마다 sha256·크기를 검증한다(카탈로그의 URL 은 버전 고정이라 바이트가 바뀌지 않는다).

use crate::error::{io, AppError, AppResult};
use crate::repo::emoji::SingleStyleState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

pub const FONTS_DIR: &str = "fonts";
const OFL_TEXT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/fonts/OFL-1.1.txt"));

#[derive(Debug, Deserialize)]
struct Catalog {
    fonts: Vec<CatalogFont>,
}

#[derive(Debug, Deserialize)]
struct CatalogFont {
    id: String,
    copyright: String,
    faces: Vec<CatalogFace>,
}

#[derive(Debug, Deserialize)]
struct CatalogFace {
    file: String,
    url: String,
    sha256: String,
    bytes: u64,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/fonts/catalog.json"));
        serde_json::from_str(raw).expect("src/lib/fonts/catalog.json 형식 오류 — 빌드 산출물이 깨졌다")
    })
}

fn find(id: &str) -> AppResult<&'static CatalogFont> {
    catalog()
        .fonts
        .iter()
        .find(|f| f.id == id)
        .ok_or_else(|| AppError::NotFound(format!("font not in catalog: {id}")))
}

pub fn fonts_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(FONTS_DIR)
}

#[derive(Debug, Default)]
pub struct FontDownloadState {
    by_id: Mutex<HashMap<String, Arc<SingleStyleState>>>,
}

impl FontDownloadState {
    fn slot(&self, id: &str) -> Arc<SingleStyleState> {
        let mut m = self.by_id.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(id.to_string()).or_default().clone()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FontStatus {
    /// 받아 둔(.complete) 카탈로그 글꼴 id.
    pub installed: Vec<String>,
    /// 받는 중인 id → 진행률(0~100).
    pub downloading: HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FontDownloadResult {
    pub started: bool,
}

pub fn font_status(data_dir: &Path, state: &FontDownloadState) -> FontStatus {
    let dir = fonts_dir(data_dir);
    let installed = catalog()
        .fonts
        .iter()
        .filter(|f| dir.join(&f.id).join(".complete").exists())
        .map(|f| f.id.clone())
        .collect();
    let m = state.by_id.lock().unwrap_or_else(|e| e.into_inner());
    let downloading = m
        .iter()
        .filter(|(_, s)| s.downloading.load(Ordering::SeqCst))
        .map(|(id, s)| (id.clone(), s.progress_pct.load(Ordering::SeqCst) as i64))
        .collect();
    FontStatus { installed, downloading }
}

pub fn start_font_download<F>(
    data_dir: PathBuf,
    id: String,
    state: Arc<FontDownloadState>,
    spawn: F,
) -> AppResult<FontDownloadResult>
where
    F: FnOnce(std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>),
{
    let font = find(&id)?;
    let font_dir = fonts_dir(&data_dir).join(&font.id);
    let slot = state.slot(&font.id);
    if font_dir.join(".complete").exists() || slot.downloading.swap(true, Ordering::SeqCst) {
        return Ok(FontDownloadResult { started: false });
    }
    slot.progress_pct.store(0, Ordering::SeqCst);

    spawn(Box::pin(async move {
        let result = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build() {
            Ok(c) => download_font(&c, &font_dir, font, &slot).await,
            Err(e) => Err(AppError::Io(e.to_string())),
        };
        if let Err(e) = result {
            crate::diag::warn("fonts", "download_failed", format!("{}: {e}", font.id));
        }
        slot.downloading.store(false, Ordering::SeqCst);
    }));
    Ok(FontDownloadResult { started: true })
}

/// 받은 바이트가 카탈로그와 같은지 — 크기와 sha256 둘 다.
fn verify(bytes: &[u8], face: &CatalogFace) -> AppResult<()> {
    if bytes.len() as u64 != face.bytes {
        return Err(AppError::Io(format!("{}: size {} != {}", face.file, bytes.len(), face.bytes)));
    }
    let got = format!("{:x}", Sha256::digest(bytes));
    if got != face.sha256 {
        return Err(AppError::Io(format!("{}: sha256 mismatch", face.file)));
    }
    Ok(())
}

async fn fetch_verified(client: &reqwest::Client, face: &CatalogFace) -> AppResult<Vec<u8>> {
    let mut last = AppError::Io(format!("{}: not attempted", face.file));
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let bytes = match client.get(&face.url).send().await.and_then(|r| r.error_for_status()) {
            Ok(r) => match r.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    last = AppError::Io(e.to_string());
                    continue;
                }
            },
            Err(e) => {
                last = AppError::Io(e.to_string());
                continue;
            }
        };
        match verify(&bytes, face) {
            Ok(()) => return Ok(bytes.to_vec()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

async fn download_font(
    client: &reqwest::Client,
    font_dir: &Path,
    font: &CatalogFont,
    slot: &SingleStyleState,
) -> AppResult<()> {
    std::fs::create_dir_all(font_dir).map_err(io)?;
    let total: u64 = font.faces.iter().map(|f| f.bytes).sum::<u64>().max(1);
    let mut done = 0u64;
    for face in &font.faces {
        let bytes = fetch_verified(client, face).await?;
        let part = font_dir.join(format!("{}.part", face.file));
        std::fs::write(&part, &bytes).map_err(io)?;
        std::fs::rename(&part, font_dir.join(&face.file)).map_err(io)?;
        done += face.bytes;
        slot.progress_pct.store(((done * 100) / total).min(99) as u8, Ordering::SeqCst);
    }
    // OFL 조건: 글꼴 사본마다 저작권 표시 + 라이선스 전문.
    std::fs::write(font_dir.join("LICENSE.txt"), format!("{}\n\n{}", font.copyright, OFL_TEXT)).map_err(io)?;
    std::fs::File::create(font_dir.join(".complete")).map_err(io)?;
    slot.progress_pct.store(100, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_well_formed() {
        let c = catalog();
        assert!(c.fonts.len() > 40);
        let mut ids = std::collections::HashSet::new();
        for f in &c.fonts {
            assert!(ids.insert(f.id.as_str()), "duplicate id {}", f.id);
            // id·파일 이름이 경로가 되므로 경로 문자가 섞이면 안 된다.
            assert!(f.id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'), "{}", f.id);
            assert!(!f.copyright.trim().is_empty(), "{}: copyright", f.id);
            assert!(!f.faces.is_empty(), "{}: faces", f.id);
            for face in &f.faces {
                assert!(face.file.ends_with(".woff2") && !face.file.contains(['/', '\\']) && !face.file.contains(".."));
                assert!(face.url.starts_with("https://cdn.jsdelivr.net/npm/@fontsource/") && face.url.contains('@'));
                assert_eq!(face.sha256.len(), 64);
                assert!(face.bytes > 0);
            }
        }
    }

    #[test]
    fn verify_rejects_wrong_bytes() {
        let face = CatalogFace {
            file: "x.woff2".into(),
            url: String::new(),
            sha256: format!("{:x}", Sha256::digest(b"abc")),
            bytes: 3,
        };
        assert!(verify(b"abc", &face).is_ok());
        assert!(verify(b"abd", &face).is_err());
        assert!(verify(b"abcd", &face).is_err());
    }

    /// 실제 네트워크 — 카탈로그에서 가장 작은 글꼴 하나를 받아 해시 검증·LICENSE·표식까지 본다.
    /// `cargo test --lib repo::fonts::tests::downloads_smallest_font -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn downloads_smallest_font() {
        let font = catalog()
            .fonts
            .iter()
            .min_by_key(|f| f.faces.iter().map(|x| x.bytes).sum::<u64>())
            .unwrap();
        let dir = std::env::temp_dir().join(format!("brise-fonts-dl-{}", std::process::id()));
        let client = reqwest::Client::new();
        let slot = SingleStyleState::default();
        download_font(&client, &dir, font, &slot).await.expect("download");
        for face in &font.faces {
            assert!(dir.join(&face.file).exists());
        }
        assert!(std::fs::read_to_string(dir.join("LICENSE.txt")).unwrap().contains("SIL OPEN FONT LICENSE"));
        assert!(dir.join(".complete").exists());
        assert_eq!(slot.progress_pct.load(Ordering::SeqCst), 100);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_id_is_rejected_before_spawn() {
        let dir = std::env::temp_dir().join(format!("brise-fonts-test-{}", std::process::id()));
        let r = start_font_download(dir, "../evil".into(), Arc::new(FontDownloadState::default()), |_| {
            panic!("must not spawn")
        });
        assert!(r.is_err());
    }
}
