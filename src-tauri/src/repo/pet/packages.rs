use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const CODEX_PET_SPRITE_VERSION: u32 = 2;
pub const CODEX_PET_ATLAS_WIDTH: u32 = 1536;
pub const CODEX_PET_CELL_WIDTH: u32 = 192;
pub const CODEX_PET_CELL_HEIGHT: u32 = 208;
pub const CODEX_PET_COLUMNS: u32 = 8;
/// P1(2026-09-15): 배포되는 아틀라스는 8×9(기본 동작만)와 8×11(9~10행이 16방향 시선) 두 가지다.
/// 둘 다 받아들이고, 프런트가 `rows` 로 시선 지원 여부를 판단한다(9행이면 idle 로 폴백).
pub const CODEX_PET_ROWS_COMPACT: u32 = 9;
pub const CODEX_PET_ROWS_EXTENDED: u32 = 11;
pub const CODEX_PET_ATLAS_HEIGHT_COMPACT: u32 = CODEX_PET_CELL_HEIGHT * CODEX_PET_ROWS_COMPACT;
pub const CODEX_PET_ATLAS_HEIGHT_EXTENDED: u32 = CODEX_PET_CELL_HEIGHT * CODEX_PET_ROWS_EXTENDED;
pub const CODEX_PET_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const PET_URL_MAX_BYTES: u64 = 32 * 1024 * 1024;
pub const PET_URL_MAX_REDIRECTS: usize = 5;
/// zip 설치(P2)의 압축폭탄 방어 — 엔트리들이 **선언한** 해제 크기 총합 상한. 배포 zip 은
/// preview/source-sheet 까지 들어 있어 아틀라스 상한(8MiB)보다 넉넉해야 한다.
const PET_ZIP_MAX_UNCOMPRESSED: u64 = 64 * 1024 * 1024;
const PET_MANIFEST_MAX_BYTES: u64 = 64 * 1024;
const PET_PREVIEW_MAX_BYTES: u64 = 512 * 1024;
const BRISE_PET_FORMAT: &str = "brise-pet/1";
const DIALECT_CODEX_V1: &str = "codex-v1";
const DIALECT_CODEX_V2: &str = "codex-v2";
const DIALECT_IDLE_IMAGE: &str = "idle-image";
/// zip 을 푸는 임시 폴더. `pets/` 밖에 둔다 — 안에 두면 잔여물이 목록에 패키지처럼 잡힌다.
const PET_IMPORT_STAGING: &str = ".pet_import";
const PET_UNPACK_SUBDIR: &str = "unpack";
pub const PET_SELECTED_PACKAGE_KEY: &str = "pet_selected_package";
const PACKAGES_SUBDIR: &str = "pets";
const PREVIEW_NAMES: [&str; 4] = ["preview.png", "preview.webp", "preview.jpg", "preview.jpeg"];
const IDLE_IMAGE_EXTS: [&str; 4] = ["gif", "apng", "webp", "png"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PetPackageClip {
    pub name: String,
    pub row: u32,
    pub frames: u32,
}

// data_url 없음 — 목록은 metadata만(아틀라스는 package_asset). pet_packages_list가 설치된
// 모든 패키지의 8MiB 스프라이트를 실어 나르던 비용을 분리한다(프리셋 3~5개 대비).
// IPC 는 snake_case 유지(프런트가 display_name / sprite_version_number 를 읽는다).
#[derive(Clone, Debug, Serialize)]
pub struct PetPackage {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub sprite_version_number: u32,
    /// 9 또는 11(아틀라스). idle-image 는 1.
    pub rows: u32,
    pub selected: bool,
    pub dialect: String,
    pub has_preview: bool,
    pub clips: Vec<PetPackageClip>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PetInstallFailure {
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexImportResult {
    pub installed: Vec<String>,
    pub failed: Vec<PetInstallFailure>,
}

/// 디스크에 쓰는 정규 매니페스트. camelCase, format=brise-pet/1.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPetManifest {
    format: String,
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
    dialect: String,
    sprite_version_number: u32,
    atlas: StoredAtlas,
    #[serde(default)]
    clips: Vec<PetPackageClip>,
    #[serde(default)]
    has_preview: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAtlas {
    columns: u32,
    cell_width: u32,
    cell_height: u32,
    rows: u32,
}

struct Intake {
    id: String,
    display_name: String,
    description: String,
    dialect: String,
    sprite_version_number: u32,
    clips: Vec<PetPackageClip>,
    atlas: StoredAtlas,
    sprite_src: PathBuf,
    sprite_name: String,
    source_dir: PathBuf,
}

struct LoadedPackage {
    id: String,
    display_name: String,
    description: String,
    sprite_version_number: u32,
    rows: u32,
    dialect: String,
    has_preview: bool,
    clips: Vec<PetPackageClip>,
    sprite_path: PathBuf,
    preview_path: Option<PathBuf>,
}

fn pet_install(code: &str) -> AppError {
    AppError::Validation(format!("pet_install:{code}"))
}

fn bad_atlas(w: u32, h: u32) -> AppError {
    pet_install(&format!("bad_atlas:{w}x{h}"))
}

pub fn packages_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(PACKAGES_SUBDIR)
}

fn unpack_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(PET_IMPORT_STAGING).join(PET_UNPACK_SUBDIR)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn json_str(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

fn json_u32(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u32> {
    for key in keys {
        if let Some(n) = obj.get(*key).and_then(|v| v.as_u64()) {
            return u32::try_from(n).ok();
        }
    }
    None
}

fn clip(name: &str, row: u32, frames: u32) -> PetPackageClip {
    PetPackageClip {
        name: name.to_string(),
        row,
        frames,
    }
}

/// Codex 표준 9행(+ 확장 시선 2행). 행 순서·프레임 수는 프런트 아틀라스 계약과 같다.
fn standard_codex_clips(rows: u32) -> Vec<PetPackageClip> {
    let mut clips = vec![
        clip("idle", 0, 6),
        clip("running-right", 1, 8),
        clip("running-left", 2, 8),
        clip("waving", 3, 4),
        clip("jumping", 4, 5),
        clip("failed", 5, 8),
        clip("waiting", 6, 6),
        clip("running", 7, 6),
        clip("review", 8, 6),
    ];
    if rows >= CODEX_PET_ROWS_EXTENDED {
        clips.push(clip("look-a", 9, 8));
        clips.push(clip("look-b", 10, 8));
    }
    clips
}

fn idle_clip() -> Vec<PetPackageClip> {
    vec![clip("idle", 0, 1)]
}

fn ensure_idle(clips: &[PetPackageClip]) -> AppResult<()> {
    if clips.iter().any(|c| c.name == "idle" && c.frames >= 1) {
        Ok(())
    } else {
        Err(pet_install("no_idle"))
    }
}

/// 치수 + 선택적 버전 → 방언. 빠진 spriteVersionNumber 를 2 로 기본값 두지 않는다.
/// 2288 높이는 버전이 없어도 v2(치수가 이긴다). 1872 에서 버전 생략/1 은 v1, 명시 2 는 compact v2.
fn infer_codex_dialect(w: u32, h: u32, version: Option<u32>) -> AppResult<(String, u32, u32)> {
    if w != CODEX_PET_ATLAS_WIDTH {
        return Err(bad_atlas(w, h));
    }
    if h == CODEX_PET_ATLAS_HEIGHT_EXTENDED {
        if let Some(v) = version {
            if v != 1 && v != 2 {
                return Err(pet_install("unsupported"));
            }
        }
        return Ok((
            DIALECT_CODEX_V2.to_string(),
            CODEX_PET_SPRITE_VERSION,
            CODEX_PET_ROWS_EXTENDED,
        ));
    }
    if h == CODEX_PET_ATLAS_HEIGHT_COMPACT {
        return match version {
            Some(2) => Ok((
                DIALECT_CODEX_V2.to_string(),
                CODEX_PET_SPRITE_VERSION,
                CODEX_PET_ROWS_COMPACT,
            )),
            Some(1) | None => Ok((DIALECT_CODEX_V1.to_string(), 1, CODEX_PET_ROWS_COMPACT)),
            Some(_) => Err(pet_install("unsupported")),
        };
    }
    Err(bad_atlas(w, h))
}

fn spritesheet_file_name(path: &str, atlas: bool) -> AppResult<&str> {
    let p = Path::new(path);
    let mut parts = p.components();
    let Some(Component::Normal(name)) = parts.next() else {
        return Err(pet_install("missing_sheet"));
    };
    if parts.next().is_some() {
        return Err(pet_install("missing_sheet"));
    }
    let name = name
        .to_str()
        .ok_or_else(|| pet_install("missing_sheet"))?;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if atlas {
        if !matches!(ext.as_str(), "png" | "webp") {
            return Err(pet_install("unsupported"));
        }
    } else if !IDLE_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(pet_install("unsupported"));
    }
    Ok(name)
}

fn resolve_sheet_in_dir(dir: &Path, declared: Option<&str>, atlas: bool) -> AppResult<(String, PathBuf)> {
    if let Some(path) = declared.map(str::trim).filter(|s| !s.is_empty()) {
        let name = spritesheet_file_name(path, atlas)?.to_string();
        let full = dir.join(&name);
        if !full.is_file() {
            return Err(pet_install("missing_sheet"));
        }
        return Ok((name, full));
    }
    for name in ["spritesheet.webp", "spritesheet.png"] {
        let full = dir.join(name);
        if full.is_file() {
            return Ok((name.to_string(), full));
        }
    }
    Err(pet_install("missing_sheet"))
}

fn find_preview_file(dir: &Path) -> Option<PathBuf> {
    for name in PREVIEW_NAMES {
        let p = dir.join(name);
        if p.is_file() {
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.len() <= PET_PREVIEW_MAX_BYTES {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn image_dimensions(path: &Path) -> AppResult<(u32, u32, bool)> {
    let image = image::ImageReader::open(path)
        .map_err(crate::error::io)?
        .with_guessed_format()
        .map_err(crate::error::io)?
        .decode()
        .map_err(|_| pet_install("unsupported"))?;
    Ok((image.width(), image.height(), image.color().has_alpha()))
}

fn image_header(path: &Path) -> AppResult<(u32, u32)> {
    image::ImageReader::open(path)
        .map_err(crate::error::io)?
        .with_guessed_format()
        .map_err(crate::error::io)?
        .into_dimensions()
        .map_err(|_| pet_install("unsupported"))
}

/// 설치 시점 — 풀 디코드로 치수+알파까지. 목록 경로에서는 부르지 않는다.
fn validate_codex_atlas(path: &Path, version: Option<u32>) -> AppResult<(String, u32, u32)> {
    let meta = std::fs::metadata(path).map_err(crate::error::io)?;
    if meta.len() > CODEX_PET_MAX_BYTES {
        return Err(pet_install("too_large"));
    }
    let (w, h, has_alpha) = image_dimensions(path)?;
    if !has_alpha {
        return Err(pet_install("no_alpha"));
    }
    infer_codex_dialect(w, h, version)
}

fn validate_codex_header(path: &Path, version: Option<u32>) -> AppResult<(String, u32, u32)> {
    let (w, h) = image_header(path)?;
    infer_codex_dialect(w, h, version)
}

fn parse_json_object(path: &Path) -> AppResult<serde_json::Map<String, serde_json::Value>> {
    let bytes = std::fs::read(path).map_err(crate::error::io)?;
    if bytes.len() as u64 > PET_MANIFEST_MAX_BYTES {
        return Err(pet_install("too_large"));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| pet_install("unsupported"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| pet_install("unsupported"))
}

fn slug_from_stem(stem: &str) -> Option<String> {
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_ascii_uppercase() {
            out.push(c.to_ascii_lowercase());
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' {
            out.push(c);
        } else if c.is_whitespace() || c == '.' {
            if !out.ends_with('-') && !out.is_empty() {
                out.push('-');
            }
        }
    }
    let out = out.trim_matches('-').to_string();
    if valid_id(&out) {
        Some(out)
    } else {
        None
    }
}

fn intake_from_loose_obj(
    obj: &serde_json::Map<String, serde_json::Value>,
    manifest_path: &Path,
) -> AppResult<Intake> {
    let id = json_str(obj, &["id"]).ok_or_else(|| pet_install("missing_id"))?;
    if !valid_id(&id) {
        return Err(pet_install("bad_id"));
    }
    let display_name = json_str(obj, &["displayName", "display_name", "name"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    let description = json_str(obj, &["description"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let version = json_u32(obj, &["spriteVersionNumber", "sprite_version_number"]);
    let declared = json_str(obj, &["spritesheetPath", "spritesheet_path", "sprite"]);
    let dir = manifest_path
        .parent()
        .ok_or_else(|| pet_install("no_manifest"))?;
    let (sprite_name, sprite_src) = resolve_sheet_in_dir(dir, declared.as_deref(), true)?;
    let (dialect, sprite_version_number, rows) = validate_codex_atlas(&sprite_src, version)?;
    let clips = standard_codex_clips(rows);
    ensure_idle(&clips)?;
    Ok(Intake {
        id,
        display_name,
        description,
        dialect,
        sprite_version_number,
        clips,
        atlas: StoredAtlas {
            columns: CODEX_PET_COLUMNS,
            cell_width: CODEX_PET_CELL_WIDTH,
            cell_height: CODEX_PET_CELL_HEIGHT,
            rows,
        },
        sprite_src,
        sprite_name,
        source_dir: dir.to_path_buf(),
    })
}

fn intake_from_stored(stored: StoredPetManifest, manifest_path: &Path) -> AppResult<Intake> {
    if !valid_id(&stored.id) {
        return Err(pet_install("bad_id"));
    }
    let dir = manifest_path
        .parent()
        .ok_or_else(|| pet_install("no_manifest"))?;
    let atlas = stored.dialect != DIALECT_IDLE_IMAGE;
    let (sprite_name, sprite_src) =
        resolve_sheet_in_dir(dir, Some(&stored.spritesheet_path), atlas)?;
    let (dialect, sprite_version_number, clips, atlas) = if stored.dialect == DIALECT_IDLE_IMAGE {
        validate_idle_image(&sprite_src, Path::new(&sprite_name))?;
        let (w, h) = image_header(&sprite_src).unwrap_or((0, 0));
        (
            DIALECT_IDLE_IMAGE.to_string(),
            1,
            idle_clip(),
            StoredAtlas {
                columns: 1,
                cell_width: w,
                cell_height: h,
                rows: 1,
            },
        )
    } else {
        let (dialect, ver, rows) =
            validate_codex_atlas(&sprite_src, Some(stored.sprite_version_number).filter(|v| *v > 0))?;
        let clips = if stored.clips.iter().any(|c| c.name == "idle") {
            stored.clips.clone()
        } else {
            standard_codex_clips(rows)
        };
        ensure_idle(&clips)?;
        (
            dialect,
            ver,
            clips,
            StoredAtlas {
                columns: CODEX_PET_COLUMNS,
                cell_width: CODEX_PET_CELL_WIDTH,
                cell_height: CODEX_PET_CELL_HEIGHT,
                rows,
            },
        )
    };
    let display_name = {
        let t = stored.display_name.trim();
        if t.is_empty() {
            stored.id.clone()
        } else {
            stored.display_name
        }
    };
    Ok(Intake {
        id: stored.id,
        display_name,
        description: stored.description.trim().to_string(),
        dialect,
        sprite_version_number,
        clips,
        atlas,
        sprite_src,
        sprite_name,
        source_dir: dir.to_path_buf(),
    })
}

fn intake_from_manifest(path: &Path) -> AppResult<Intake> {
    if path.file_name().and_then(|n| n.to_str()) != Some("pet.json") {
        return Err(pet_install("no_manifest"));
    }
    let obj = parse_json_object(path)?;
    if obj.get("format").and_then(|v| v.as_str()) == Some(BRISE_PET_FORMAT) {
        let stored: StoredPetManifest = serde_json::from_value(serde_json::Value::Object(obj))
            .map_err(|_| pet_install("unsupported"))?;
        return intake_from_stored(stored, path);
    }
    intake_from_loose_obj(&obj, path)
}

fn validate_idle_image(path: &Path, file_name: &Path) -> AppResult<String> {
    let ext = file_name
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !IDLE_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(pet_install("unsupported"));
    }
    let meta = std::fs::metadata(path).map_err(crate::error::io)?;
    if meta.len() > super::PET_ASSET_MAX_BYTES {
        return Err(pet_install("too_large"));
    }
    let (_w, _h, has_alpha) = image_dimensions(path)?;
    // GIF 는 팔레트라 알파가 없을 수 있다. 그 외 idle-image 도 아틀라스가 아니라서 알파를 강제하지 않는다.
    let _ = has_alpha;
    Ok(ext)
}

fn intake_from_idle_image(path: &Path) -> AppResult<Intake> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| pet_install("bad_id"))?;
    let ext = validate_idle_image(path, Path::new(file_name))?;
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("pet");
    let id = slug_from_stem(stem).ok_or_else(|| pet_install("bad_id"))?;
    let (w, h) = image_header(path).unwrap_or((0, 0));
    let sprite_name = format!("spritesheet.{ext}");
    let clips = idle_clip();
    ensure_idle(&clips)?;
    Ok(Intake {
        display_name: stem.to_string(),
        description: String::new(),
        dialect: DIALECT_IDLE_IMAGE.to_string(),
        sprite_version_number: 1,
        clips,
        atlas: StoredAtlas {
            columns: 1,
            cell_width: w,
            cell_height: h,
            rows: 1,
        },
        sprite_src: path.to_path_buf(),
        sprite_name,
        source_dir: path.parent().unwrap_or(path).to_path_buf(),
        id,
    })
}

fn write_canonical(dest: &Path, intake: &Intake, has_preview: bool) -> AppResult<()> {
    let stored = StoredPetManifest {
        format: BRISE_PET_FORMAT.to_string(),
        id: intake.id.clone(),
        display_name: intake.display_name.clone(),
        description: intake.description.clone(),
        spritesheet_path: intake.sprite_name.clone(),
        dialect: intake.dialect.clone(),
        sprite_version_number: intake.sprite_version_number,
        atlas: intake.atlas.clone(),
        clips: intake.clips.clone(),
        has_preview,
    };
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|_| pet_install("unsupported"))?;
    std::fs::write(dest.join("pet.json"), bytes).map_err(crate::error::io)
}

fn select_id(conn: &mut Connection, id: &str) -> AppResult<()> {
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(PET_SELECTED_PACKAGE_KEY.to_string(), serde_json::json!(id));
    crate::repo::settings::set(conn, &entries)?;
    Ok(())
}

fn clear_selected_package(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM settings WHERE key=?1",
        rusqlite::params![PET_SELECTED_PACKAGE_KEY],
    )
    .map_err(|e| AppError::Io(format!("settings delete error: {e}")))?;
    Ok(())
}

fn commit_intake(conn: &mut Connection, data_dir: &Path, intake: Intake) -> AppResult<String> {
    let root = packages_dir(data_dir);
    let dest = root.join(&intake.id);
    std::fs::create_dir_all(&dest).map_err(crate::error::io)?;
    std::fs::copy(&intake.sprite_src, dest.join(&intake.sprite_name)).map_err(crate::error::io)?;
    let has_preview = if let Some(preview) = find_preview_file(&intake.source_dir) {
        let name = preview
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("preview.png");
        std::fs::copy(&preview, dest.join(name)).map_err(crate::error::io)?;
        true
    } else {
        false
    };
    write_canonical(&dest, &intake, has_preview)?;
    select_id(conn, &intake.id)?;
    Ok(intake.id)
}

pub fn install_package(
    conn: &mut Connection,
    data_dir: &Path,
    manifest_path: &Path,
) -> AppResult<String> {
    let intake = intake_from_manifest(manifest_path)?;
    commit_intake(conn, data_dir, intake)
}

/// macOS 가 zip 에 끼워 넣는 리소스 포크 잔해. 경로 어느 조각에든 있으면 통째로 건너뛴다.
fn is_macos_junk(component: &str) -> bool {
    component == "__MACOSX" || component.starts_with("._")
}

fn zip_entry_is_junk(name: &str) -> bool {
    name.split('/').any(is_macos_junk)
}

fn path_ext(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// P2: 설치 입력 한 지점 — pet.json · 폴더 · zip · 단일 이미지. 폴더/zip 은 루트에
/// pet.json 이 없으면 **한 층만** 내려가 찾는다(배포본이 `<id>/` 로 한 번 감싸는 형태).
pub fn install_from_path(
    conn: &mut Connection,
    data_dir: &Path,
    path: &Path,
) -> AppResult<String> {
    if path.is_dir() {
        let manifest = find_manifest_in_dir(path)?;
        return install_package(conn, data_dir, &manifest);
    }
    let ext = path_ext(path);
    if ext == "zip" {
        return install_from_zip(conn, data_dir, path);
    }
    if IDLE_IMAGE_EXTS.contains(&ext.as_str()) {
        if let Some(parent) = path.parent() {
            let sibling = parent.join("pet.json");
            if sibling.is_file() {
                return install_package(conn, data_dir, &sibling);
            }
        }
        let intake = intake_from_idle_image(path)?;
        return commit_intake(conn, data_dir, intake);
    }
    if path.file_name().and_then(|n| n.to_str()) == Some("pet.json") {
        return install_package(conn, data_dir, path);
    }
    Err(pet_install("unsupported"))
}

fn find_manifest_in_dir(dir: &Path) -> AppResult<PathBuf> {
    let direct = dir.join("pet.json");
    if direct.is_file() {
        return Ok(direct);
    }
    for entry in std::fs::read_dir(dir).map_err(crate::error::io)?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if is_macos_junk(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let candidate = entry.path().join("pet.json");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(pet_install("no_manifest"))
}

fn extract_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
    dest: &Path,
) -> AppResult<()> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| pet_install("bad_zip"))?;
    let mut out = std::fs::File::create(dest).map_err(crate::error::io)?;
    std::io::copy(&mut entry, &mut out).map_err(crate::error::io)?;
    Ok(())
}

fn zip_has(names: &[(String, u64)], entry: &str) -> Option<u64> {
    names.iter().find(|(n, _)| n == entry).map(|(_, s)| *s)
}

/// zip 배포본 설치. 스프라이트시트 + 있으면 preview(512KiB 이하)만 꺼낸다.
fn install_from_zip(conn: &mut Connection, data_dir: &Path, zip_path: &Path) -> AppResult<String> {
    let file = std::fs::File::open(zip_path).map_err(crate::error::io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| pet_install("bad_zip"))?;

    // 압축폭탄 방어 — 한 바이트도 풀기 전에 **선언된** 해제 크기 총합부터 본다.
    let mut names: Vec<(String, u64)> = Vec::new();
    let mut declared: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| pet_install("bad_zip"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if zip_entry_is_junk(&name) {
            continue;
        }
        declared = declared.saturating_add(entry.size());
        if declared > PET_ZIP_MAX_UNCOMPRESSED {
            return Err(pet_install("too_large"));
        }
        names.push((name, entry.size()));
    }

    let (manifest_name, manifest_size) = names
        .iter()
        .filter(|(n, _)| n.rsplit('/').next() == Some("pet.json") && n.matches('/').count() <= 1)
        .min_by_key(|(n, _)| n.matches('/').count())
        .cloned()
        .ok_or_else(|| pet_install("no_manifest"))?;
    if manifest_size > PET_MANIFEST_MAX_BYTES {
        return Err(pet_install("too_large"));
    }
    let prefix = manifest_name[..manifest_name.len() - "pet.json".len()].to_string();

    let staging = unpack_dir(data_dir);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(crate::error::io)?;
    let staged_manifest = staging.join("pet.json");
    let result = (|| {
        extract_entry(&mut archive, &manifest_name, &staged_manifest)?;
        let obj = parse_json_object(&staged_manifest)?;
        let declared = json_str(&obj, &["spritesheetPath", "spritesheet_path", "sprite"]);
        let sprite_entry = if let Some(path) = declared.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let name = spritesheet_file_name(path, true)?;
            format!("{prefix}{name}")
        } else if zip_has(&names, &format!("{prefix}spritesheet.webp")).is_some() {
            format!("{prefix}spritesheet.webp")
        } else if zip_has(&names, &format!("{prefix}spritesheet.png")).is_some() {
            format!("{prefix}spritesheet.png")
        } else {
            return Err(pet_install("sheet_missing_from_zip"));
        };
        let sprite_name = sprite_entry
            .rsplit('/')
            .next()
            .unwrap_or("spritesheet.webp")
            .to_string();
        let size = zip_has(&names, &sprite_entry).ok_or_else(|| pet_install("sheet_missing_from_zip"))?;
        if size > CODEX_PET_MAX_BYTES {
            return Err(pet_install("too_large"));
        }
        extract_entry(&mut archive, &sprite_entry, &staging.join(&sprite_name))?;
        for preview in PREVIEW_NAMES {
            let entry = format!("{prefix}{preview}");
            if let Some(sz) = zip_has(&names, &entry) {
                if sz <= PET_PREVIEW_MAX_BYTES {
                    extract_entry(&mut archive, &entry, &staging.join(preview))?;
                    break;
                }
            }
        }
        install_package(conn, data_dir, &staged_manifest)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    let parent = data_dir.join(PET_IMPORT_STAGING);
    if let Ok(mut it) = std::fs::read_dir(&parent) {
        if it.next().is_none() {
            let _ = std::fs::remove_dir(&parent);
        }
    }
    result
}

/// P4: 패키지 폴더를 지운다. 선택 중이던 것을 지우면 선택을 비워 기본 캐릭터로 돌아간다 —
/// 빈 문자열은 settings_schema 가 거부하므로(슬러그 검증) 행 자체를 지운다.
pub fn remove_package(conn: &mut Connection, data_dir: &Path, id: &str) -> AppResult<()> {
    if !valid_id(id) {
        return Err(AppError::Validation(format!("unknown pet package: {id}")));
    }
    let dir = packages_dir(data_dir).join(id);
    if !dir.is_dir() {
        return Err(AppError::Validation(format!("unknown pet package: {id}")));
    }
    std::fs::remove_dir_all(&dir).map_err(crate::error::io)?;
    if selected_package_id(conn)?.as_deref() == Some(id) {
        clear_selected_package(conn)?;
    }
    Ok(())
}

/// DB 락 안에서 쓰는 조회 — 선택된 패키지 id만 읽는다(파일 I/O 없음). 커맨드 계층이 락을
/// 놓은 뒤 list_packages_fs를 spawn_blocking에서 부르는 두 단계 패턴에 쓴다.
pub fn selected_package_id(conn: &Connection) -> AppResult<Option<String>> {
    Ok(crate::repo::settings::get_all(conn)?
        .get(PET_SELECTED_PACKAGE_KEY)
        .and_then(|v| v.as_str())
        .map(str::to_owned))
}

fn load_installed(dir: &Path) -> AppResult<LoadedPackage> {
    let manifest_path = dir.join("pet.json");
    let obj = parse_json_object(&manifest_path)?;
    if obj.get("format").and_then(|v| v.as_str()) == Some(BRISE_PET_FORMAT) {
        let stored: StoredPetManifest = serde_json::from_value(serde_json::Value::Object(obj))
            .map_err(|_| pet_install("unsupported"))?;
        if !valid_id(&stored.id) {
            return Err(pet_install("bad_id"));
        }
        let sprite_path = dir.join(&stored.spritesheet_path);
        if !sprite_path.is_file() {
            return Err(pet_install("missing_sheet"));
        }
        let preview_path = find_preview_file(dir);
        if stored.dialect == DIALECT_IDLE_IMAGE {
            let _ = image_header(&sprite_path)?;
            let clips = if stored.clips.iter().any(|c| c.name == "idle") {
                stored.clips
            } else {
                idle_clip()
            };
            return Ok(LoadedPackage {
                id: stored.id,
                display_name: stored.display_name,
                description: stored.description,
                sprite_version_number: stored.sprite_version_number.max(1),
                rows: 1,
                dialect: DIALECT_IDLE_IMAGE.to_string(),
                has_preview: stored.has_preview || preview_path.is_some(),
                clips,
                sprite_path,
                preview_path,
            });
        }
        let version = Some(stored.sprite_version_number).filter(|v| *v > 0);
        let (dialect, ver, header_rows) = validate_codex_header(&sprite_path, version)?;
        let rows = if stored.atlas.rows == header_rows {
            stored.atlas.rows
        } else {
            header_rows
        };
        let clips = if stored.clips.iter().any(|c| c.name == "idle") {
            stored.clips
        } else {
            standard_codex_clips(rows)
        };
        return Ok(LoadedPackage {
            id: stored.id,
            display_name: stored.display_name,
            description: stored.description,
            sprite_version_number: ver,
            rows,
            dialect,
            has_preview: stored.has_preview || preview_path.is_some(),
            clips,
            sprite_path,
            preview_path,
        });
    }

    // 구 Codex 형태(format 없음, spritesheetPath 있음) — 설치 때와 같이 치수로 방언을 추론한다.
    let id = json_str(&obj, &["id"]).ok_or_else(|| pet_install("missing_id"))?;
    if !valid_id(&id) {
        return Err(pet_install("bad_id"));
    }
    let display_name = json_str(&obj, &["displayName", "display_name", "name"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.clone());
    let description = json_str(&obj, &["description"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let version = json_u32(&obj, &["spriteVersionNumber", "sprite_version_number"]);
    let declared = json_str(&obj, &["spritesheetPath", "spritesheet_path", "sprite"]);
    let ( _name, sprite_path) = resolve_sheet_in_dir(dir, declared.as_deref(), true)?;
    let (dialect, sprite_version_number, rows) = validate_codex_header(&sprite_path, version)?;
    let preview_path = find_preview_file(dir);
    Ok(LoadedPackage {
        id,
        display_name,
        description,
        sprite_version_number,
        rows,
        dialect,
        has_preview: preview_path.is_some(),
        clips: standard_codex_clips(rows),
        sprite_path,
        preview_path,
    })
}

/// 순수 파일시스템 스캔(DB 락 없음) — selected는 호출부가 미리 읽어 넘긴다.
pub fn list_packages_fs(data_dir: &Path, selected: Option<&str>) -> AppResult<Vec<PetPackage>> {
    let root = packages_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(root) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let loaded = match load_installed(&entry.path()) {
            Ok(l) => l,
            Err(_) => {
                // package id/name 만 남긴다(경로·에러 상세는 제외 — diag 메시지 계약).
                let dir_name = entry.file_name();
                crate::diag::warn("pet", "package_corrupt_skipped", dir_name.to_string_lossy());
                continue;
            }
        };
        out.push(PetPackage {
            selected: selected == Some(loaded.id.as_str()),
            id: loaded.id,
            display_name: loaded.display_name,
            description: loaded.description,
            sprite_version_number: loaded.sprite_version_number,
            rows: loaded.rows,
            dialect: loaded.dialect,
            has_preview: loaded.has_preview,
            clips: loaded.clips,
        });
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(out)
}

pub fn list_packages(conn: &Connection, data_dir: &Path) -> AppResult<Vec<PetPackage>> {
    let selected = selected_package_id(conn)?;
    list_packages_fs(data_dir, selected.as_deref())
}

pub fn select_package(conn: &mut Connection, data_dir: &Path, id: &str) -> AppResult<()> {
    let id = id.trim();
    if id.is_empty() || id == "default" {
        return clear_selected_package(conn);
    }
    if !list_packages(conn, data_dir)?.iter().any(|p| p.id == id) {
        return Err(AppError::Validation(format!("unknown pet package: {id}")));
    }
    select_id(conn, id)
}

/// DB 락 안에서 쓰는 조회 — id가 있으면 그대로, 없으면 선택된 패키지 id를 읽는다(파일 I/O 없음).
pub fn resolve_package_id(conn: &Connection, id: Option<&str>) -> AppResult<String> {
    match id {
        Some(id) => Ok(id.to_string()),
        None => selected_package_id(conn)?
            .ok_or_else(|| AppError::Validation("no pet package selected".into())),
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" | "apng" => "image/png",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "image/webp",
    }
}

fn encode_data_url(path: &Path) -> AppResult<String> {
    use base64::Engine as _;
    let bytes = std::fs::read(path).map_err(crate::error::io)?;
    let ext = path_ext(path);
    Ok(format!(
        "data:{};base64,{}",
        mime_for_ext(&ext),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 순수 파일시스템 읽기(DB 락 없음) — 설치 패키지 1개의 아틀라스(또는 preview)만 Base64 data URL.
pub fn read_package_asset_fs(data_dir: &Path, id: &str, preview: bool) -> AppResult<String> {
    if !valid_id(id) {
        return Err(AppError::Validation(format!("unknown pet package: {id}")));
    }
    let loaded = load_installed(&packages_dir(data_dir).join(id))
        .map_err(|_| AppError::Validation(format!("unknown pet package: {id}")))?;
    if preview {
        let path = loaded.preview_path.ok_or_else(|| pet_install("missing_sheet"))?;
        return encode_data_url(&path);
    }
    encode_data_url(&loaded.sprite_path)
}

/// 설치 패키지 1개의 아틀라스만 Base64 data URL로 반환한다(list_packages는 metadata만).
/// id 생략 시 pet_selected_package 설정값을 쓴다 — 그것도 없으면 VALIDATION.
pub fn package_asset(
    conn: &Connection,
    data_dir: &Path,
    id: Option<&str>,
    preview: bool,
) -> AppResult<String> {
    let id = resolve_package_id(conn, id)?;
    read_package_asset_fs(data_dir, &id, preview)
}

pub fn parse_pet_install_url(url: &str) -> AppResult<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| pet_install("bad_url"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(pet_install("bad_url"));
    }
    Ok(parsed)
}

pub fn download_file_name_for_url(url: &reqwest::Url) -> &'static str {
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".png") {
        "download.png"
    } else if path.ends_with(".gif") {
        "download.gif"
    } else if path.ends_with(".webp") {
        "download.webp"
    } else if path.ends_with(".apng") {
        "download.apng"
    } else {
        "download.zip"
    }
}

/// `$CODEX_HOME/pets` 우선, 없으면 `%USERPROFILE%/.codex/pets` 또는 `$HOME/.codex/pets`.
pub fn default_codex_pets_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        let home = home.trim();
        if !home.is_empty() {
            return Some(PathBuf::from(home).join("pets"));
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let profile = profile.trim();
        if !profile.is_empty() {
            return Some(PathBuf::from(profile).join(".codex").join("pets"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = home.trim();
        if !home.is_empty() {
            return Some(PathBuf::from(home).join(".codex").join("pets"));
        }
    }
    None
}

/// Codex pets 폴더의 각 하위 디렉터리를 install_from_path. 마지막 성공 id 가 선택된다.
pub fn import_codex_pets(
    conn: &mut Connection,
    data_dir: &Path,
    pets_root: &Path,
) -> AppResult<CodexImportResult> {
    let mut installed = Vec::new();
    let mut failed = Vec::new();
    if !pets_root.is_dir() {
        return Ok(CodexImportResult { installed, failed });
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(pets_root)
        .map_err(crate::error::io)?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !is_macos_junk(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for dir in dirs {
        let name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("pet")
            .to_string();
        match install_from_path(conn, data_dir, &dir) {
            Ok(id) => installed.push(id),
            Err(e) => failed.push(PetInstallFailure {
                name,
                reason: e.to_string(),
            }),
        }
    }
    Ok(CodexImportResult { installed, failed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use image::{ImageBuffer, Rgba};

    fn setup() -> (Connection, tempfile::TempDir) {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        (conn, tempfile::tempdir().unwrap())
    }

    fn write_sheet(dir: &Path, width: u32, height: u32) {
        std::fs::create_dir_all(dir).unwrap();
        ImageBuffer::from_pixel(width, height, Rgba([20u8, 30, 40, 255]))
            .save(dir.join("spritesheet.webp"))
            .unwrap();
    }

    fn make_package(root: &Path, id: &str, width: u32, height: u32) -> PathBuf {
        make_package_json(
            root,
            id,
            width,
            height,
            serde_json::json!({
                "id": id,
                "displayName": "Compatibility Pet",
                "description": "A test pet.",
                "spriteVersionNumber": 2,
                "spritesheetPath": "spritesheet.webp"
            }),
        )
    }

    fn make_package_json(
        root: &Path,
        id: &str,
        width: u32,
        height: u32,
        manifest: serde_json::Value,
    ) -> PathBuf {
        let dir = root.join(id);
        write_sheet(&dir, width, height);
        let path = dir.join("pet.json");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        path
    }

    fn stored_json(data: &Path, id: &str) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(packages_dir(data).join(id).join("pet.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn codex_v2_package_installs_lists_and_selects() {
        let (mut conn, temp) = setup();
        let source = make_package(
            temp.path(),
            "compat-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_EXTENDED,
        );
        let data = temp.path().join("data");
        assert_eq!(install_package(&mut conn, &data, &source).unwrap(), "compat-pet");
        let items = list_packages(&conn, &data).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].selected);
        assert_eq!(items[0].dialect, DIALECT_CODEX_V2);
        select_package(&mut conn, &data, "compat-pet").unwrap();
    }

    #[test]
    fn package_asset_returns_data_url_for_id_or_selected_default() {
        let (mut conn, temp) = setup();
        let source = make_package(
            temp.path(),
            "compat-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_EXTENDED,
        );
        let data = temp.path().join("data");
        install_package(&mut conn, &data, &source).unwrap();

        let url = package_asset(&conn, &data, Some("compat-pet"), false).unwrap();
        assert!(url.starts_with("data:image/webp;base64,"));

        let url = package_asset(&conn, &data, None, false).unwrap();
        assert!(url.starts_with("data:image/webp;base64,"));
    }

    #[test]
    fn package_asset_rejects_unknown_id() {
        let (conn, temp) = setup();
        let data = temp.path().join("data");
        assert!(package_asset(&conn, &data, Some("no-such-pet"), false).is_err());
    }

    #[test]
    fn package_asset_without_selection_and_without_id_is_err() {
        let (conn, temp) = setup();
        let data = temp.path().join("data");
        assert!(package_asset(&conn, &data, None, false).is_err());
    }

    #[test]
    fn list_packages_excludes_mismatched_atlas_via_header_check_only() {
        let (conn, temp) = setup();
        let data = temp.path().join("data");
        // install_package를 거치지 않고 디스크에 직접 심는다 — list_packages_fs가 헤더만 읽고도
        // (풀 디코드 없이) 치수 불일치 패키지를 걸러내는지 확인한다.
        make_package(&packages_dir(&data), "bad-atlas", 100, 100);
        assert!(list_packages(&conn, &data).unwrap().is_empty());
    }

    /// P1: 9행(1872)과 11행(2288) 둘 다 설치되고 rows 가 그대로 실린다. 어긋난 치수는 거부.
    #[test]
    fn accepts_both_atlas_heights_and_reports_rows() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");

        let nine = make_package(
            temp.path(),
            "nine-row",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
        );
        install_package(&mut conn, &data, &nine).unwrap();
        let eleven = make_package(
            temp.path(),
            "eleven-row",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_EXTENDED,
        );
        install_package(&mut conn, &data, &eleven).unwrap();

        let items = list_packages(&conn, &data).unwrap();
        let rows = |id: &str| items.iter().find(|p| p.id == id).unwrap().rows;
        assert_eq!(rows("nine-row"), CODEX_PET_ROWS_COMPACT);
        assert_eq!(rows("eleven-row"), CODEX_PET_ROWS_EXTENDED);

        let odd = make_package(temp.path(), "odd-row", CODEX_PET_ATLAS_WIDTH, 2000);
        assert!(install_package(&mut conn, &data, &odd).is_err(), "1536x2000 은 거부");
    }

    /// P2: zip 은 루트에 pet.json 이 없으면 한 층만 내려가 찾고, __MACOSX/._* 는 무시하며,
    /// 스프라이트시트 + 작은 preview 를 복사한다.
    #[test]
    fn zip_install_descends_one_level_ignores_macos_junk_and_copies_only_the_spritesheet() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package(
            temp.path(),
            "zip-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
        );
        let sprite_bytes = std::fs::read(source.parent().unwrap().join("spritesheet.webp")).unwrap();
        let manifest_bytes = std::fs::read(&source).unwrap();

        let zip_path = temp.path().join("zip-pet.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            // __MACOSX 쪽에 **먼저** 가짜 pet.json 을 넣는다 — 무시하지 않으면 이걸 집는다.
            zip.start_file("__MACOSX/zip-pet/pet.json", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"not json").unwrap();
            zip.start_file("zip-pet/._pet.json", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"resource fork").unwrap();
            zip.start_file("zip-pet/pet.json", opts).unwrap();
            std::io::Write::write_all(&mut zip, &manifest_bytes).unwrap();
            zip.start_file("zip-pet/spritesheet.webp", opts).unwrap();
            std::io::Write::write_all(&mut zip, &sprite_bytes).unwrap();
            zip.start_file("zip-pet/preview.png", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"ignored").unwrap();
            zip.start_file("zip-pet/validation.json", opts).unwrap();
            std::io::Write::write_all(&mut zip, b"{}").unwrap();
            zip.finish().unwrap();
        }

        assert_eq!(install_from_path(&mut conn, &data, &zip_path).unwrap(), "zip-pet");
        let installed = packages_dir(&data).join("zip-pet");
        let mut files: Vec<String> = std::fs::read_dir(&installed)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        assert_eq!(
            files,
            vec![
                "pet.json".to_string(),
                "preview.png".to_string(),
                "spritesheet.webp".to_string()
            ]
        );
        assert!(!unpack_dir(&data).exists(), "임시 폴더는 남지 않는다");
        let listed = list_packages(&conn, &data).unwrap();
        assert!(listed[0].has_preview);
        let preview = package_asset(&conn, &data, Some("zip-pet"), true).unwrap();
        assert!(preview.starts_with("data:image/png;base64,"));
    }

    /// P4: 선택 중이던 패키지를 지우면 선택이 비워진다(기본 캐릭터로 복귀).
    #[test]
    fn remove_deletes_the_folder_and_clears_the_selection() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package(
            temp.path(),
            "compat-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_EXTENDED,
        );
        install_package(&mut conn, &data, &source).unwrap();
        assert_eq!(selected_package_id(&conn).unwrap().as_deref(), Some("compat-pet"));

        remove_package(&mut conn, &data, "compat-pet").unwrap();
        assert!(list_packages(&conn, &data).unwrap().is_empty());
        assert_eq!(selected_package_id(&conn).unwrap(), None);
        assert!(
            remove_package(&mut conn, &data, "compat-pet").is_err(),
            "없는 id 는 VALIDATION"
        );
    }

    #[test]
    fn rejects_wrong_atlas_dimensions_and_path_traversal() {
        let (mut conn, temp) = setup();
        let bad_size = make_package(temp.path(), "bad-size", 192, 208);
        let err = install_package(&mut conn, temp.path(), &bad_size).unwrap_err();
        assert!(err.to_string().contains("pet_install:bad_atlas"));

        let package = make_package(
            temp.path(),
            "bad-path",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_EXTENDED,
        );
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&package).unwrap()).unwrap();
        manifest["spritesheetPath"] = serde_json::json!("../spritesheet.webp");
        std::fs::write(&package, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(install_package(&mut conn, temp.path(), &package).is_err());
    }

    #[test]
    fn v1_manifest_without_sprite_version_installs_as_codex_v1() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package_json(
            temp.path(),
            "pumpy",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
            serde_json::json!({
                "id": "pumpy",
                "displayName": "Pumpy",
                "spritesheetPath": "spritesheet.webp"
            }),
        );
        assert_eq!(install_package(&mut conn, &data, &source).unwrap(), "pumpy");
        let items = list_packages(&conn, &data).unwrap();
        assert_eq!(items[0].dialect, "codex-v1");
        assert_eq!(items[0].sprite_version_number, 1);
        assert_eq!(items[0].rows, 9);
        assert!(items[0].clips.iter().any(|c| c.name == "idle" && c.frames == 6));
        assert!(!items[0].clips.iter().any(|c| c.name.starts_with("look-")));
        let stored = stored_json(&data, "pumpy");
        assert_eq!(stored["format"], "brise-pet/1");
        assert_eq!(stored["dialect"], "codex-v1");
        assert_eq!(stored["spriteVersionNumber"], 1);
    }

    #[test]
    fn underscore_id_pet_abc123_installs() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package(
            temp.path(),
            "pet_abc123",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
        );
        assert_eq!(
            install_package(&mut conn, &data, &source).unwrap(),
            "pet_abc123"
        );
    }

    #[test]
    fn empty_description_is_allowed() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package_json(
            temp.path(),
            "quiet-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
            serde_json::json!({
                "id": "quiet-pet",
                "displayName": "Quiet",
                "description": "   ",
                "spritesheetPath": "spritesheet.webp"
            }),
        );
        install_package(&mut conn, &data, &source).unwrap();
        let items = list_packages(&conn, &data).unwrap();
        assert_eq!(items[0].description, "");
        assert_eq!(stored_json(&data, "quiet-pet")["description"], "");
    }

    #[test]
    fn extra_json_key_is_ignored() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package_json(
            temp.path(),
            "kind-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
            serde_json::json!({
                "id": "kind-pet",
                "displayName": "Kind",
                "description": "ok",
                "spritesheetPath": "spritesheet.webp",
                "kind": "animal"
            }),
        );
        assert_eq!(install_package(&mut conn, &data, &source).unwrap(), "kind-pet");
        assert_eq!(list_packages(&conn, &data).unwrap()[0].dialect, "codex-v1");
    }

    #[test]
    fn snake_case_manifest_keys_install() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package_json(
            temp.path(),
            "snake-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_EXTENDED,
            serde_json::json!({
                "id": "snake-pet",
                "display_name": "Snake",
                "description": "from aliases",
                "spritesheet_path": "spritesheet.webp",
                "sprite_version_number": 2
            }),
        );
        install_package(&mut conn, &data, &source).unwrap();
        let items = list_packages(&conn, &data).unwrap();
        assert_eq!(items[0].display_name, "Snake");
        assert_eq!(items[0].dialect, "codex-v2");
        assert_eq!(items[0].sprite_version_number, 2);
        assert_eq!(items[0].rows, 11);
        assert!(items[0].clips.iter().any(|c| c.name == "look-a"));
    }

    #[test]
    fn rejects_1536x2000_with_bad_atlas_token() {
        let (mut conn, temp) = setup();
        let odd = make_package(temp.path(), "odd-row", CODEX_PET_ATLAS_WIDTH, 2000);
        let err = install_package(&mut conn, temp.path(), &odd).unwrap_err();
        assert!(err.to_string().contains("pet_install:bad_atlas"));
        assert!(err.to_string().contains("1536x2000"));
    }

    #[test]
    fn select_default_or_empty_clears_selection() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let source = make_package(
            temp.path(),
            "compat-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
        );
        install_package(&mut conn, &data, &source).unwrap();
        assert_eq!(selected_package_id(&conn).unwrap().as_deref(), Some("compat-pet"));
        select_package(&mut conn, &data, "default").unwrap();
        assert_eq!(selected_package_id(&conn).unwrap(), None);
        select_package(&mut conn, &data, "compat-pet").unwrap();
        select_package(&mut conn, &data, "").unwrap();
        assert_eq!(selected_package_id(&conn).unwrap(), None);
    }

    #[test]
    fn idle_image_png_installs_as_idle_image() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let png = temp.path().join("buddy.png");
        ImageBuffer::from_pixel(64, 64, Rgba([10u8, 20, 30, 255]))
            .save(&png)
            .unwrap();
        assert_eq!(install_from_path(&mut conn, &data, &png).unwrap(), "buddy");
        let items = list_packages(&conn, &data).unwrap();
        assert_eq!(items[0].dialect, "idle-image");
        assert_eq!(items[0].rows, 1);
        assert_eq!(items[0].clips, idle_clip());
        let stored = stored_json(&data, "buddy");
        assert_eq!(stored["format"], "brise-pet/1");
        assert_eq!(stored["dialect"], "idle-image");
        assert_eq!(stored["spritesheetPath"], "spritesheet.png");
    }

    #[test]
    fn import_codex_pets_collects_success_and_failure() {
        let (mut conn, temp) = setup();
        let data = temp.path().join("data");
        let pets_root = temp.path().join("codex-pets");
        make_package(
            &pets_root,
            "good-pet",
            CODEX_PET_ATLAS_WIDTH,
            CODEX_PET_ATLAS_HEIGHT_COMPACT,
        );
        std::fs::create_dir_all(pets_root.join("bad-folder")).unwrap();
        let result = import_codex_pets(&mut conn, &data, &pets_root).unwrap();
        assert_eq!(result.installed, vec!["good-pet".to_string()]);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].name, "bad-folder");
        assert!(result.failed[0].reason.contains("pet_install:no_manifest"));
        assert_eq!(selected_package_id(&conn).unwrap().as_deref(), Some("good-pet"));
    }

    #[test]
    fn install_url_rejects_non_http_schemes() {
        let err = parse_pet_install_url("file:///tmp/x.zip").unwrap_err();
        assert!(err.to_string().contains("pet_install:bad_url"));
    }

    #[test]
    fn zip_without_pet_json_is_no_manifest() {
        let (mut conn, temp) = setup();
        let zip_path = temp.path().join("empty.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("readme.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut zip, b"hi").unwrap();
            zip.finish().unwrap();
        }
        let err = install_from_path(&mut conn, temp.path(), &zip_path).unwrap_err();
        assert!(err.to_string().contains("pet_install:no_manifest"));
    }
}
