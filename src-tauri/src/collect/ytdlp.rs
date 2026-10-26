//! yt-dlp 사이드카 및 유튜브 자막 추출 (docs/PLAN-2026-08-23-collect-advanced.md §3.8, W4b).
//!
//! 보안 및 무비용 원칙:
//! 1. 유튜브 Data API 키 불필요 (되풀이 비용 0).
//! 2. 번들 씨앗본을 앱 데이터(쓰기 가능 위치)로 복사하여 자체 업데이트(-U) 수행.
//! 3. 자체 업데이트는 하루 1회 상한(.last-update-check)으로 GitHub API 속도 제한 방지.
//! 4. 오프라인 또는 업데이트 실패 시에도 기존 바이너리로 계속 진행 (실패는 로그만).
//! 5. URL은 검증된 http(s) 공인 호스트만 통과하며 인자 배열로 전달(셸 경유 금지).
//! 6. 파일 생성 없이 stdout 스트림으로 자막(VTT) 수신 후 평문 정제.

use crate::collect::config::{self, SourceConfig};
use crate::collect::{CollectCtx, CollectedItem};
use crate::error::{io as io_err, AppError, AppResult};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows `CREATE_NO_WINDOW` — yt-dlp is a console exe; without this every invocation flashes a
/// console window on top of the Tauri GUI.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// ponytail: fixed ceiling for one subtitle fetch. yt-dlp has no per-video length signal we can
/// scale off ahead of time, so this is a flat cap, not a heuristic — raise it if long-form videos
/// start timing out in practice.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// ponytail: separate (also flat) ceiling for the detached self-update thread — it never blocks
/// the fetch path, so a slow/hung update just gets abandoned by this timeout instead of hanging
/// a background thread forever.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(60);

/// Run `cmd` with a wall-clock timeout, killing it if it outlives the deadline. `std::process`
/// has no built-in timeout, so this is the stdlib-only way to add one — spawn, drain stdout/
/// stderr on background threads (required: without a concurrent reader, a large stdout write —
/// yt-dlp streams subtitles to stdout via `-o -` — can fill the OS pipe buffer and deadlock the
/// child before `try_wait` ever sees it exit), poll `try_wait` for completion or timeout.
pub(crate) fn run_with_timeout(mut cmd: std::process::Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    // 프로그램 이름은 spawn 전에 떠 둔다 — 타임아웃 메시지가 "어느 외부 프로세스가" 를 말해야 한다
    // (이 헬퍼는 repo::slide_render 의 soffice 변환도 함께 쓴다).
    let program = cmd.get_program().to_string_lossy().to_string();
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdout_pipe = child.stdout.take().expect("stdout piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            // Do NOT join the reader threads here: killing `child` only terminates that one
            // process, not any grandchild it may have spawned (e.g. `cmd /C x` orphans `x`'s own
            // children) — if a grandchild still holds the write end of the stdout/stderr pipe
            // open, read_to_end blocks until it exits, which could be indefinitely. Abandon the
            // threads instead; they finish harmlessly in the background whenever the pipes close,
            // but must never block the timeout we're trying to enforce.
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{program} timed out after {}s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

fn parse_vtt_timestamp(s: &str) -> Option<u64> {
    let s = s.trim();
    let time_part = s.split('.').next().unwrap_or(s).split(',').next().unwrap_or(s);
    let parts: Vec<&str> = time_part.split(':').collect();
    match parts.len() {
        2 => {
            let m: u64 = parts[0].parse().ok()?;
            let sec: u64 = parts[1].parse().ok()?;
            Some(m * 60 + sec)
        }
        3 => {
            let h: u64 = parts[0].parse().ok()?;
            let m: u64 = parts[1].parse().ok()?;
            let sec: u64 = parts[2].parse().ok()?;
            Some(h * 3600 + m * 60 + sec)
        }
        _ => None,
    }
}

fn format_timestamp(sec: u64) -> String {
    let h = sec / 3600;
    let m = (sec % 3600) / 60;
    let s = sec % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

/// VTT 자막 텍스트에서 타임스탬프 큐를 분석하여 3분(180초) 간격의 마크다운 챕터(`### ⏱️ HH:MM:SS`)와
/// 정제된 텍스트로 구조화한다.
pub fn clean_vtt(vtt_content: &str) -> String {
    const CHAPTER_INTERVAL_SECS: u64 = 180; // 3분 간격

    let mut chapters: Vec<(u64, Vec<String>)> = Vec::new();
    let mut current_chap_start: Option<u64> = None;
    let mut current_chap_lines: Vec<String> = Vec::new();
    let mut current_cue_sec: Option<u64> = None;
    let mut prev_line = String::new();

    for line in vtt_content.lines() {
        let trimmed = line.trim();
        // 헤더 및 메타데이터 무시
        if trimmed.is_empty()
            || trimmed.starts_with("WEBVTT")
            || trimmed.starts_with("Kind:")
            || trimmed.starts_with("Language:")
            || trimmed.starts_with("NOTE")
        {
            continue;
        }

        // 타임스탬프 라인 (예: 00:00:01.000 --> 00:00:04.000)
        if trimmed.contains("-->") {
            if let Some(start_part) = trimmed.split("-->").next() {
                if let Some(sec) = parse_vtt_timestamp(start_part) {
                    current_cue_sec = Some(sec);
                }
            }
            continue;
        }

        // 숫자 인덱스만 있는 라인 무시
        if trimmed.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        // HTML/VTT 인라인 태그 제거 (예: <c.colorE5E5E5>...</c>, <00:00:01.000>)
        let mut clean_line = String::new();
        let mut inside_tag = false;
        for c in trimmed.chars() {
            if c == '<' {
                inside_tag = true;
            } else if c == '>' {
                inside_tag = false;
            } else if !inside_tag {
                clean_line.push(c);
            }
        }
        let clean_trimmed = clean_line.trim();
        if clean_trimmed.is_empty() {
            continue;
        }

        // 연속 중복 라인 방지 (자막 스트림에 흔함)
        if clean_trimmed != prev_line {
            let cue_sec = current_cue_sec.unwrap_or(0);
            match current_chap_start {
                None => {
                    current_chap_start = Some(cue_sec);
                }
                Some(start) => {
                    if cue_sec >= start + CHAPTER_INTERVAL_SECS {
                        if !current_chap_lines.is_empty() {
                            chapters.push((start, std::mem::take(&mut current_chap_lines)));
                        }
                        current_chap_start = Some(cue_sec);
                    }
                }
            }
            current_chap_lines.push(clean_trimmed.to_string());
            prev_line = clean_trimmed.to_string();
        }
    }

    if let Some(start) = current_chap_start {
        if !current_chap_lines.is_empty() {
            chapters.push((start, current_chap_lines));
        }
    }

    if chapters.is_empty() {
        return String::new();
    }

    let mut output = Vec::with_capacity(chapters.len());
    for (start_sec, lines) in chapters {
        let header = format!("### ⏱️ {}", format_timestamp(start_sec));
        let body = lines.join("\n");
        output.push(format!("{header}\n{body}"));
    }

    output.join("\n\n")
}

/// data_dir/bin 아래에 yt-dlp 바이너리를 준비하고 하루 1회 상한으로 업데이트를 확인한다.
pub fn ensure_ytdlp(data_dir: &Path) -> AppResult<PathBuf> {
    let bin_dir = data_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(io_err)?;

    let exe_name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let target_path = bin_dir.join(exe_name);

    // 씨앗 복사: target_path가 없으면 번들본 또는 환경 탐색
    if !target_path.exists() {
        let mut copied = false;
        // 1. 현재 실행 파일 디렉토리 주변 탐색 (Tauri 번들 사이드카 위치)
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                let candidate = exe_dir.join(exe_name);
                if candidate.exists() {
                    if let Ok(_) = std::fs::copy(&candidate, &target_path) {
                        copied = true;
                    }
                }
                // binaries/ 서브디렉토리도 확인
                let candidate_sub = exe_dir.join("binaries").join(exe_name);
                if !copied && candidate_sub.exists() {
                    if let Ok(_) = std::fs::copy(&candidate_sub, &target_path) {
                        copied = true;
                    }
                }
            }
        }
        // 2. 개발 환경 repo 경로 (src-tauri/binaries/...)
        if !copied {
            let dev_candidate = PathBuf::from(format!("binaries/yt-dlp-x86_64-pc-windows-msvc.exe"));
            if dev_candidate.exists() {
                let _ = std::fs::copy(&dev_candidate, &target_path);
            }
        }
    }

    // 하루 1회 업데이트 체크 (.last-update-check)
    let (ty, tm, td) = crate::util::today_ymd_local();
    let today_str = format!("{ty:04}-{tm:02}-{td:02}");
    let stamp_file = bin_dir.join(".last-update-check");

    let already_checked = std::fs::read_to_string(&stamp_file)
        .map(|s| s.trim() == today_str)
        .unwrap_or(false);

    if !already_checked && target_path.exists() {
        // 오늘 날짜를 먼저(업데이트 결과와 무관하게) 기록해 같은 날 재시도를 막는다 — 아래 스레드가
        // 걸리거나 느려도 stamp는 이미 써졌으므로 fetch 경로가 이를 기다릴 이유가 없다.
        let _ = std::fs::write(&stamp_file, &today_str);
        // ponytail: fire-and-forget detached thread — 자막 fetch는 디스크에 이미 있는 바이너리만
        // 필요하다(업데이트된 바이너리는 "다음 실행"에만 쓰인다). 예전엔 이 -U 호출이 fetch 경로를
        // 동기로 막았다(Finding 2b) — 이제 fetch와 완전히 분리, 실패/타임아웃은 로그만 남긴다.
        let update_target = target_path.clone();
        std::thread::spawn(move || {
            let mut cmd = std::process::Command::new(&update_target);
            cmd.arg("-U");
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            match run_with_timeout(cmd, UPDATE_TIMEOUT) {
                Ok(output) => {
                    if !output.status.success() {
                        let err_msg = String::from_utf8_lossy(&output.stderr);
                        crate::diag::warn("collect", "ytdlp_update_warning", err_msg.as_ref());
                    }
                }
                Err(e) => {
                    crate::diag::warn("collect", "ytdlp_update_check_failed", format!("{e}"));
                }
            }
        });
    }

    Ok(target_path)
}

/// True if a usable yt-dlp binary is already present at `data_dir/bin` (or can be seeded there
/// from a bundled/dev-tree copy without any network access). `ensure_ytdlp` is safe to call
/// speculatively for this check — its only side effect when nothing is found is creating the
/// (empty) `bin/` directory, and its seed-copy step never deletes or overwrites anything.
pub fn ytdlp_installed(data_dir: &Path) -> bool {
    ensure_ytdlp(data_dir).map(|p| p.exists()).unwrap_or(false)
}

// ── 온디맨드 다운로드 (사용자 동의 후, 설치본 비동봉 — docs/COLLECT.md §2.4) ──────────────────
// 유료 판매 시 다운로더 바이너리 동봉은 스토어 심사·유튜브 약관 노출 리스크라 씨앗 복사가 실패하면
// (설치본엔 애초에 아무 것도 동봉하지 않는다) 여기서 GitHub 공식 릴리스를 사용자 동의 후 내려받는다.
// 호출 지점은 항상 프론트(설정 > 수집)의 명시적 사용자 동작뿐 — 백그라운드 러너는 절대 다운로드를
// 트리거하지 않는다(§2.2와 같은 원칙: 부수효과가 큰 네트워크 동작은 사용자 동작 경유로만).

/// yt-dlp가 OS별로 게시하는 릴리스 자산명(github.com/yt-dlp/yt-dlp/releases).
#[cfg(windows)]
const RELEASE_ASSET_NAME: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const RELEASE_ASSET_NAME: &str = "yt-dlp_macos";
#[cfg(not(any(windows, target_os = "macos")))]
const RELEASE_ASSET_NAME: &str = "yt-dlp";

const RELEASE_BASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// 폭주 방어용 상한이지 실제 기대 크기가 아니다(실물은 ~20-30MB) — Content-Length 헤더는 없거나
/// 거짓일 수 있으므로 신뢰하지 않고 스트리밍 도중 누적 바이트로 직접 센다.
const MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024;
const DOWNLOAD_USER_AGENT: &str = "BriseNoteApp/1.0 (https://github.com/simiroa/brise)";

/// `SHA2-256SUMS` 형식(yt-dlp가 릴리스마다 같이 게시)을 파싱해 `asset_name`의 hex 다이제스트를
/// 찾는다. 각 행은 공백으로 나뉜 `<hex64> <파일명>` — sha256sum의 바이너리 모드 `*` 접두는
/// 허용하고, 파일명이 경로를 포함해도 basename만 정확히 비교한다. 순수 동기 함수라 네트워크 없이
/// 단위 테스트 가능.
fn parse_sha256sums(text: &str, asset_name: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.trim().splitn(2, char::is_whitespace);
        let hash = parts.next()?.trim();
        let filename = parts.next()?.trim().trim_start_matches('*');
        let basename = Path::new(filename).file_name().and_then(|n| n.to_str()).unwrap_or(filename);
        let is_hex64 = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
        if is_hex64 && basename == asset_name {
            return Some(hash.to_lowercase());
        }
    }
    None
}

/// `actual_hash_hex`를 `expected_hash_hex`와 대조해, 일치하면 `tmp_path`를 `target_path`로 원자적
/// rename하고, 불일치면 `tmp_path`를 지우고 IO 에러를 반환한다. `ytdlp_download`에서 분리한 이유는
/// 이 검증+설치 단계만 네트워크 없이 로컬 임시 파일로 단위 테스트하기 위해서다.
fn verify_and_install(
    tmp_path: &Path,
    target_path: &Path,
    actual_hash_hex: &str,
    expected_hash_hex: &str,
) -> AppResult<()> {
    if !actual_hash_hex.eq_ignore_ascii_case(expected_hash_hex) {
        let _ = std::fs::remove_file(tmp_path);
        return Err(AppError::Io(format!(
            "yt-dlp download checksum mismatch (expected {expected_hash_hex}, got {actual_hash_hex})"
        )));
    }
    std::fs::rename(tmp_path, target_path).map_err(io_err)
}

/// yt-dlp를 GitHub 공식 릴리스에서 `data_dir/bin`으로 내려받는다 — 같은 릴리스에 게시된 SHA2-256
/// 체크섬으로 검증한 뒤에만 설치한다. 실제 경로(exe_name)가 아니라 `.yt-dlp.download` 임시 파일로
/// 스트리밍하므로, 중단/크래시가 나도 `ensure_ytdlp`가 찾아 실행하려 들 반쪽짜리 바이너리를 절대
/// 남기지 않는다. 릴리스 URL은 사용자 입력이 아니라 고정 상수이므로 — `web_reader::fetch_reader`/
/// `fetch_youtube_channel_html`과 달리 — 매 리다이렉트 홉을 손수 재검증하지 않고 reqwest의 기본
/// 리다이렉트 처리를 그대로 신뢰한다(guard_public_host가 막아야 할 공격자 제어 입력이 애초에 없다).
pub async fn ytdlp_download(data_dir: &Path) -> AppResult<()> {
    let bin_dir = data_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(io_err)?;

    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;

    let sums_resp = client
        .get(format!("{RELEASE_BASE_URL}/SHA2-256SUMS"))
        .header("User-Agent", DOWNLOAD_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("failed to fetch yt-dlp checksums: {e}")))?;
    if !sums_resp.status().is_success() {
        return Err(AppError::Io(format!(
            "failed to fetch yt-dlp checksums: http {}",
            sums_resp.status()
        )));
    }
    let sums_text = sums_resp
        .text()
        .await
        .map_err(|e| AppError::Io(format!("failed to read yt-dlp checksums: {e}")))?;
    let expected_hash = parse_sha256sums(&sums_text, RELEASE_ASSET_NAME).ok_or_else(|| {
        AppError::Io(format!("yt-dlp checksum listing has no entry for {RELEASE_ASSET_NAME}"))
    })?;

    let mut resp = client
        .get(format!("{RELEASE_BASE_URL}/{RELEASE_ASSET_NAME}"))
        .header("User-Agent", DOWNLOAD_USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("failed to download yt-dlp: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Io(format!("failed to download yt-dlp: http {}", resp.status())));
    }

    let tmp_path = bin_dir.join(".yt-dlp.download");
    let mut file = std::fs::File::create(&tmp_path).map_err(io_err)?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Io(format!("yt-dlp download interrupted: {e}")))?
    {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(AppError::Io(format!(
                "yt-dlp download exceeded the {MAX_DOWNLOAD_BYTES}-byte size cap"
            )));
        }
        file.write_all(&chunk).map_err(io_err)?;
        hasher.update(&chunk);
    }
    drop(file);
    let actual_hash: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();

    let exe_name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let target_path = bin_dir.join(exe_name);
    verify_and_install(&tmp_path, &target_path, &actual_hash, &expected_hash)?;

    // 실행 비트: Windows는 확장자가 실행을 결정하지만 Unix는 파일 모드 비트가 있어야 실행된다 —
    // 내려받은 파일은 기본적으로 그 비트가 꺼져 있다.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&target_path) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&target_path, perms);
        }
    }

    Ok(())
}

/// 유튜브 영상 URL에서 자막을 추출해 정제된 텍스트로 반환한다.
pub fn fetch_subtitles(data_dir: &Path, url: &str) -> AppResult<String> {
    let ytdlp = ensure_ytdlp(data_dir)?;
    if !ytdlp.exists() {
        return Err(AppError::Io(
            "yt-dlp is not installed — add or edit a YouTube source in Settings > Collect to download it"
                .to_string(),
        ));
    }

    let mut cmd = std::process::Command::new(&ytdlp);
    cmd.args([
        "--skip-download",
        "--write-auto-subs",
        "--write-subs",
        "--sub-lang",
        "ko,en,ja",
        "--sub-format",
        "vtt",
        "-o",
        "-",
        url,
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = run_with_timeout(cmd, FETCH_TIMEOUT)
        .map_err(|e| AppError::Io(format!("failed to execute yt-dlp: {e}")))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Io(format!("yt-dlp subtitle extraction failed: {err_msg}")));
    }

    let raw_vtt = String::from_utf8_lossy(&output.stdout);
    let cleaned = clean_vtt(&raw_vtt);
    if cleaned.trim().is_empty() {
        return Err(AppError::Validation("no subtitles found for video".to_string()));
    }

    Ok(cleaned)
}

fn youtube_title(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or("");
            let path = parsed.path();
            if host.is_empty() {
                url.to_string()
            } else if path.is_empty() || path == "/" {
                host.to_string()
            } else {
                format!("{host}{path}")
            }
        }
        Err(_) => url.to_string(),
    }
}

/// Fetch cleaned subtitles for one YouTube URL. guid is the URL so reruns are idempotent.
pub fn collect(config_json: &str, ctx: &CollectCtx) -> AppResult<Vec<CollectedItem>> {
    let cfg = match config::parse("youtube", config_json)? {
        SourceConfig::Youtube(c) => c,
        _ => return Err(AppError::Validation("expected youtube config".to_string())),
    };
    let url = cfg.url.trim().to_string();
    let body_md = fetch_subtitles(&ctx.data_dir, &url)?;
    Ok(vec![CollectedItem {
        guid: url.clone(),
        title: youtube_title(&url),
        body_md,
        source_url: Some(url),
        published_at: None,
        parts: Vec::new(),
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_vtt_removes_headers_timestamps_and_duplicate_lines() {
        let sample_vtt = r#"WEBVTT
Kind: captions
Language: ko

00:00:00.500 --> 00:00:02.000
<c.colorE5E5E5>안녕하세요 여러분</c>

00:00:02.000 --> 00:00:04.500
<c.colorE5E5E5>안녕하세요 여러분</c>
오늘 소개해드릴 내용은

00:00:04.500 --> 00:00:07.000
브리즈의 새로운 수집 기능입니다.
"#;

        let cleaned = clean_vtt(sample_vtt);
        assert_eq!(
            cleaned,
            "### ⏱️ 00:00:00\n안녕하세요 여러분\n오늘 소개해드릴 내용은\n브리즈의 새로운 수집 기능입니다."
        );
    }

    #[test]
    fn test_clean_vtt_with_timestamps_and_chapters() {
        let multi_chapter_vtt = r#"WEBVTT
Kind: captions
Language: ko

1
00:00:01.000 --> 00:00:04.000
<c.colorE5E5E5>첫 번째 챕터 시작입니다.</c>

2
00:01:30.000 --> 00:01:35.000
첫 번째 챕터의 중간 내용입니다.

3
00:03:05.000 --> 00:03:10.000
두 번째 챕터가 3분 후에 시작됩니다.

4
00:06:45.000 --> 00:06:50.000
세 번째 챕터는 6분 후에 시작됩니다.
"#;

        let cleaned = clean_vtt(multi_chapter_vtt);
        let expected = "\
### ⏱️ 00:00:01
첫 번째 챕터 시작입니다.
첫 번째 챕터의 중간 내용입니다.

### ⏱️ 00:03:05
두 번째 챕터가 3분 후에 시작됩니다.

### ⏱️ 00:06:45
세 번째 챕터는 6분 후에 시작됩니다.";

        assert_eq!(cleaned, expected);
    }

    /// Finding 2a: a hung/slow yt-dlp process must be killed at the deadline, not awaited forever.
    #[cfg(windows)]
    #[test]
    fn run_with_timeout_kills_a_process_that_outlives_the_deadline() {
        // Spawn ping.exe directly (not via `cmd /C`) so kill() terminates the pinging process
        // itself rather than leaving an orphaned grandchild holding the stdout pipe open.
        let mut cmd = std::process::Command::new("ping");
        cmd.args(["-n", "30", "127.0.0.1"]); // ~29s — far past the short timeout below
        cmd.creation_flags(CREATE_NO_WINDOW);
        let start = Instant::now();
        let err = run_with_timeout(cmd, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(5), "must kill, not wait out the child's full lifetime");
    }

    /// A fast process's stdout must still come through — guards against the pipe-deadlock trap
    /// (draining stdout/stderr on background threads instead of only after wait()).
    #[cfg(windows)]
    #[test]
    fn run_with_timeout_captures_output_of_a_fast_process() {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "echo", "hello"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = run_with_timeout(cmd, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
    }

    #[test]
    fn ensure_ytdlp_daily_stamp_avoids_repeated_checks() {
        let temp_dir = std::env::temp_dir().join(format!("brise-ytdlp-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let bin_dir = temp_dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();

        let (ty, tm, td) = crate::util::today_ymd_local();
        let today_str = format!("{ty:04}-{tm:02}-{td:02}");
        let stamp_file = bin_dir.join(".last-update-check");
        std::fs::write(&stamp_file, &today_str).unwrap();

        let target = ensure_ytdlp(&temp_dir).unwrap();
        assert_eq!(target, bin_dir.join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" }));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // ── parse_sha256sums: 순수 함수, 네트워크 없음 ──────────────────────────────────────────
    #[test]
    fn parse_sha256sums_finds_the_matching_asset_by_basename() {
        let hash_a = "deadbeef".repeat(8);
        let hash_b = "cafebabe".repeat(8);
        let listing = format!("{hash_a}  yt-dlp\n{hash_b}  yt-dlp.exe\n");
        assert_eq!(parse_sha256sums(&listing, "yt-dlp.exe").as_deref(), Some(hash_b.as_str()));
    }

    #[test]
    fn parse_sha256sums_returns_none_when_the_asset_is_absent() {
        let hash_a = "deadbeef".repeat(8);
        let listing = format!("{hash_a}  yt-dlp\n");
        assert_eq!(parse_sha256sums(&listing, "yt-dlp.exe"), None);
    }

    #[test]
    fn parse_sha256sums_ignores_malformed_lines_and_still_finds_a_valid_one() {
        let hash_b = "cafebabe".repeat(8);
        let listing = format!("not a valid line\ntoo-short-hash  yt-dlp.exe\n{hash_b}  yt-dlp.exe\n");
        assert_eq!(parse_sha256sums(&listing, "yt-dlp.exe").as_deref(), Some(hash_b.as_str()));
    }

    // ── verify_and_install: 로컬 임시 파일, 네트워크 없음 ───────────────────────────────────
    #[test]
    fn verify_and_install_renames_into_place_and_a_second_install_overwrites_cleanly() {
        let dir = std::env::temp_dir().join(format!("brise-ytdlp-verify-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("yt-dlp.exe");

        let tmp1 = dir.join(".yt-dlp.download");
        std::fs::write(&tmp1, b"first version").unwrap();
        verify_and_install(&tmp1, &target, "ABCDEF", "abcdef").unwrap(); // case-insensitive match
        assert_eq!(std::fs::read(&target).unwrap(), b"first version");
        assert!(!tmp1.exists());

        // 멱등 경로: 재설치가 기존 target을 깨끗이 교체한다(러너 재실행/재클릭 안전).
        let tmp2 = dir.join(".yt-dlp.download");
        std::fs::write(&tmp2, b"second version").unwrap();
        verify_and_install(&tmp2, &target, "abcdef", "ABCDEF").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second version");
        assert!(!tmp2.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_and_install_deletes_the_temp_file_and_errors_on_a_hash_mismatch() {
        let dir = std::env::temp_dir().join(format!("brise-ytdlp-verify-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join(".yt-dlp.download");
        std::fs::write(&tmp, b"fake binary bytes").unwrap();
        let target = dir.join("yt-dlp.exe");

        let err = verify_and_install(&tmp, &target, "abcdef", "123456").unwrap_err();

        assert!(matches!(err, AppError::Io(_)));
        assert!(!tmp.exists(), "mismatched download must not be left behind");
        assert!(!target.exists(), "mismatched download must never be installed");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
