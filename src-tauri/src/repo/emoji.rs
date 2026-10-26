use crate::error::{io, AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;

// ponytail: 2026-08 3d/animated 스타일 제거 — ManifestEntry.png3d, AnimatedManifestEntry,
// get_animated_manifest() 는 그 스타일들 전용이라 같이 걷어냈다. 이미 디스크에 받아둔 3d/animated
// 팩 파일이 있다면(과거 다운로드) 그대로 무해하게 남아있고 지우는 정리 로직은 새로 만들지 않는다.
#[derive(Debug, Deserialize)]
pub struct ManifestEntry {
    pub unicode: String,
    pub color: String,
}

#[derive(Debug, Default)]
pub struct SingleStyleState {
    pub downloading: AtomicBool,
    pub progress_pct: AtomicU8,
}

#[derive(Debug, Default)]
pub struct EmojiDownloadState {
    pub color: SingleStyleState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StyleState {
    pub present: bool,
    pub downloading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_pct: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EmojiStyleStatus {
    pub color: StyleState,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmojiDownloadResult {
    pub started: bool,
}

pub fn get_manifest() -> Vec<ManifestEntry> {
    let manifest_str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/emoji/fluent-manifest.json"
    ));
    serde_json::from_str(manifest_str).unwrap_or_default()
}

fn get_style_status(data_dir: &Path, style: &str, state: &SingleStyleState) -> StyleState {
    let marker = crate::db::emoji_dir(data_dir).join(style).join(".complete");
    let present = marker.exists();
    let downloading = state.downloading.load(Ordering::SeqCst);
    let progress_pct = if downloading {
        Some(state.progress_pct.load(Ordering::SeqCst) as i64)
    } else {
        None
    };

    StyleState {
        present,
        downloading,
        progress_pct,
    }
}

pub fn emoji_style_status(data_dir: &Path, state: &EmojiDownloadState) -> EmojiStyleStatus {
    EmojiStyleStatus {
        color: get_style_status(data_dir, "color", &state.color),
    }
}

pub fn start_emoji_download<F>(
    data_dir: PathBuf,
    style: String,
    state: Arc<EmojiDownloadState>,
    spawn: F,
) -> AppResult<EmojiDownloadResult>
where
    F: FnOnce(std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>),
{
    let single_state = match style.as_str() {
        "color" => &state.color,
        _ => {
            return Err(AppError::Validation(
                "emoji style not available for download".to_string(),
            ));
        }
    };

    let style_dir = crate::db::emoji_dir(&data_dir).join(&style);
    let marker = style_dir.join(".complete");

    if marker.exists() || single_state.downloading.load(Ordering::SeqCst) {
        return Ok(EmojiDownloadResult { started: false });
    }

    single_state.downloading.store(true, Ordering::SeqCst);
    single_state.progress_pct.store(0, Ordering::SeqCst);

    let state_task = state.clone();
    let style_task = style.clone();

    let fut = Box::pin(async move {
        let single_state_ref = match style_task.as_str() {
            "color" => &state_task.color,
            _ => unreachable!(),
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build();
        let result = match client {
            Ok(c) => download_style_pack(&c, &data_dir, &style_task, single_state_ref).await,
            Err(e) => Err(AppError::Io(e.to_string())),
        };
        if let Err(e) = result {
            crate::diag::warn("emoji", "pack_download_failed", format!("{style_task}: {e}"));
        }
        single_state_ref.downloading.store(false, Ordering::SeqCst);
    });
    spawn(fut);

    Ok(EmojiDownloadResult { started: true })
}

pub fn sanitize_unicode(unicode: &str) -> String {
    let s: String = unicode
        .replace('/', "-")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    s.trim_matches('-').to_string()
}

/// One extraction target: where the file lives inside the source zip, and the sanitized
/// unicode-keyed name to write it under in `style_dir`.
struct ZipItem {
    in_zip_path: String,
    dest_name: String,
}

/// Download a single GitHub codeload zip archive (with retry) and extract the requested subset of
/// files into `style_dir`. Used for the (now only) color style — it used to fire one HTTP request
/// per emoji (1285-1595 requests via jsDelivr) which is what made the download slow. Partial-failure
/// semantics are preserved: if any item fails to extract, no `.complete` marker is written, so the
/// next `emoji_download` call (marker absent) restarts the whole thing — same as the old per-file
/// loop's all-or-nothing retry contract.
///
/// Progress reporting: codeload sends no Content-Length, so we can't track download-fraction
/// against the real size. 0-90% is estimated against `expected_bytes` (ponytail: hardcoded size
/// estimate — widen/measure live if the archive size drifts enough to make the bar visibly lie),
/// 90-100% is the (fast, in-memory) extraction pass.
async fn download_zip_pack(
    client: &reqwest::Client,
    style_dir: &Path,
    state: &SingleStyleState,
    zip_url: &str,
    expected_bytes: u64,
    items: Vec<ZipItem>,
) -> AppResult<()> {
    let total = items.len();
    if total == 0 {
        return Ok(());
    }

    let mut attempts = 0;
    let mut zip_bytes: Option<Vec<u8>> = None;

    while attempts < 3 && zip_bytes.is_none() {
        attempts += 1;
        state.progress_pct.store(0, Ordering::SeqCst);
        if let Ok(resp) = client.get(zip_url).send().await {
            if resp.status().is_success() {
                use futures_util::StreamExt;
                let mut stream = resp.bytes_stream();
                let mut buf = Vec::with_capacity(expected_bytes as usize);
                let mut ok = true;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            buf.extend_from_slice(&bytes);
                            let pct = ((buf.len() as f64 / expected_bytes as f64) * 90.0).floor() as u8;
                            state.progress_pct.store(pct.min(90), Ordering::SeqCst);
                        }
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok {
                    zip_bytes = Some(buf);
                }
            }
        }
        if zip_bytes.is_none() && attempts < 3 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    let zip_bytes =
        zip_bytes.ok_or_else(|| AppError::Io(format!("failed to download archive: {zip_url}")))?;

    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| AppError::Io(format!("zip error: {e}")))?;

    let mut extracted = 0;
    for item in &items {
        let dest_path = style_dir.join(&item.dest_name);
        if let Ok(mut zip_file) = archive.by_name(&item.in_zip_path) {
            let part_path = style_dir.join(format!("{}.part", item.dest_name));
            let mut file_bytes = Vec::new();
            if std::io::Read::read_to_end(&mut zip_file, &mut file_bytes).is_ok()
                && std::fs::write(&part_path, &file_bytes).is_ok()
                && std::fs::rename(&part_path, &dest_path).is_ok()
            {
                extracted += 1;
            }
        }
        let pct = 90 + (((extracted as f64) / (total as f64)) * 10.0).floor() as u8;
        state.progress_pct.store(pct.min(100), Ordering::SeqCst);
    }

    if extracted == total {
        let marker = style_dir.join(".complete");
        std::fs::File::create(&marker).map_err(io)?;
        state.progress_pct.store(100, Ordering::SeqCst);
        Ok(())
    } else {
        Err(AppError::Io(format!(
            "failed to extract all files from archive ({extracted}/{total} completed)"
        )))
    }
}

async fn download_style_pack(
    client: &reqwest::Client,
    data_dir: &Path,
    style: &str,
    state: &SingleStyleState,
) -> AppResult<()> {
    let style_dir = crate::db::emoji_dir(data_dir).join(style);
    std::fs::create_dir_all(&style_dir).map_err(io)?;

    match style {
        "color" => {
            let manifest = get_manifest();
            let items = manifest
                .into_iter()
                .map(|e| {
                    let safe_unicode = sanitize_unicode(&e.unicode);
                    ZipItem {
                        in_zip_path: format!("fluentui-emoji-main/{}", e.color),
                        dest_name: format!("{safe_unicode}.svg"),
                    }
                })
                .collect();
            download_zip_pack(
                client,
                &style_dir,
                state,
                "https://codeload.github.com/microsoft/fluentui-emoji/zip/refs/heads/main",
                // ponytail: hardcoded estimate (measured 2026-07-29, full repo incl. all styles) —
                // see doc comment above.
                150_000_000,
                items,
            )
            .await
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_unicode() {
        let unsafe_unicode = "../1f600-fe0f/test";
        let safe = sanitize_unicode(unsafe_unicode);
        assert_eq!(safe, "1f600-fe0f-test");
    }

    #[test]
    fn test_zip_path_for_color() {
        let color_rel = "assets/Grinning face/Color/grinning_face_color.svg";
        assert_eq!(
            format!("fluentui-emoji-main/{color_rel}"),
            "fluentui-emoji-main/assets/Grinning face/Color/grinning_face_color.svg"
        );
    }

    /// Real network smoke test for the single-archive download path (color style): downloads the
    /// actual ~150MB codeload zip and extracts a handful of real manifest entries. Slow — ignored
    /// by default, same convention as db::mod::tests' bootstrap-phase test.
    /// `cargo test -p brise repo::emoji::tests::download_zip_pack_extracts_real_entries -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn download_zip_pack_extracts_real_entries() {
        let manifest = get_manifest();
        assert!(!manifest.is_empty(), "fluent-manifest.json embed is empty");
        let items: Vec<ZipItem> = manifest
            .into_iter()
            .take(3)
            .map(|e| ZipItem {
                in_zip_path: format!("fluentui-emoji-main/{}", e.color),
                dest_name: format!("{}.svg", sanitize_unicode(&e.unicode)),
            })
            .collect();
        let expected_names: Vec<String> = items.iter().map(|i| i.dest_name.clone()).collect();

        let dir = std::env::temp_dir().join(format!("brise-emoji-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = SingleStyleState::default();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap();

        download_zip_pack(
            &client,
            &dir,
            &state,
            "https://codeload.github.com/microsoft/fluentui-emoji/zip/refs/heads/main",
            150_000_000,
            items,
        )
        .await
        .expect("download_zip_pack should succeed against the real archive");

        for name in expected_names {
            assert!(dir.join(&name).exists(), "expected extracted file {name} to exist");
        }
        assert!(dir.join(".complete").exists());
        assert_eq!(state.progress_pct.load(Ordering::SeqCst), 100);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

