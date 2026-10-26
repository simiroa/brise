// repo::pet::assets — 데스크톱 펫 에셋 관리(W7-h). pet.rs 대화 코어(mod.rs)에서 순수 추출
// (리팩토링 웨이브 C). 동작 변경 없음; 테스트는 여기 그대로 산다. 오너가 외부에서 만든 애니메이션
// 스프라이트를 동작(mood)별로 등록한다. 등록이 없으면 PetSprite.tsx 의 코드 SVG 로 폴백한다 —
// 그게 무설정 기본값이고, 파일이 사라져도 같은 자리로 되돌아간다(크래시 없음).
//
// 결정(계획 §펫 "저장 위치·백업 포함 여부는 구현 시 결정"):
//  - 저장 위치: `<app_data_dir>/pet_assets/<mood>.<ext>` — attachments/emoji/workspace_bg 와 같은 층.
//  - 백업/내보내기: **포함하지 않는다.** pet_pos_* 와 같은 성격의 기기-로컬 장식이고, 노트북을
//    다른 기기로 옮길 때 따라갈 이유가 없다(번들이 커지기만 한다). 필요해지면 export 번들에
//    선택 항목으로 얹는 것이 업그레이드 경로.
//  - 상한: 파일당 2 MB. 데이터 URL 로 웹뷰에 실어 보내므로(asset: 프로토콜 스코프를 새로 열지
//    않기 위해) 무한정 키울 수 없다.
//  - 파일이 사라지면: 목록에서 조용히 빠진다 → SVG 폴백.
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub const PET_MOODS: [&str; 3] = ["idle", "happy", "alert"];
pub const PET_ASSET_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// GIF/APNG/WebP 는 스스로 움직인다. PNG 만 스프라이트 시트라 프레임 수가 따로 필요하다.
pub const PET_ASSET_EXTS: [&str; 4] = ["gif", "apng", "png", "webp"];
pub const PET_ASSET_FRAMES_MAX: u64 = 64;
/// PNG 스프라이트 시트 재생 속도(한 바퀴 길이, ms). GIF/APNG/WebP 는 컨테이너가 자체 타이밍을
/// 가지므로 이 범위는 PNG 전용이다. ponytail: 200~5000ms 고정 상한 — 더 넓은 범위가 필요해지면
/// (초고속 루프·초저속 프레젠테이션 등) 여기 상수만 넓히면 된다, UI/스키마는 그대로 따라간다.
pub const PET_ASSET_CYCLE_MS_DEFAULT: u32 = 900;
pub const PET_ASSET_CYCLE_MS_MIN: u32 = 200;
pub const PET_ASSET_CYCLE_MS_MAX: u32 = 5000;
/// settings 에 등록 상태를 담는 키(값은 {mood: {file, frames, cycle_ms}} 객체).
pub const PET_ASSETS_KEY: &str = "pet_assets";
const ASSETS_SUBDIR: &str = "pet_assets";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PetAsset {
    pub mood: String,
    /// 확장자 = 프런트의 재생 방식 판정(png 면 스프라이트 시트, 그 외는 그냥 <img>).
    pub kind: String,
    /// PNG 스프라이트 시트일 때만 실린다 — 계약이 `frames?: number` 라 null 대신 아예 뺀다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<u32>,
    /// PNG 스프라이트 시트 재생 속도(ms). frames 와 같은 이유로 그 외 형식엔 싣지 않는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle_ms: Option<u32>,
    pub data_url: String,
}

/// 등록 전 미리보기(commands::pet::pet_asset_preview) 결과 — 저장하지 않고 검증 + 인코딩만.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PetAssetPreview {
    pub kind: String,
    pub data_url: String,
}

pub fn assets_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(ASSETS_SUBDIR)
}

fn ext_of(path: &std::path::Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| PET_ASSET_EXTS.contains(&e.as_str()))
}

/// 파일 바이트 → data URL. list_assets(등록된 파일)와 preview_asset(등록 전 임시 경로)가 공유한다.
fn encode_data_url(path: &std::path::Path, kind: &str) -> AppResult<String> {
    use base64::Engine as _;
    let bytes = std::fs::read(path).map_err(crate::error::io)?;
    let mime = match kind {
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// 저장하지 않고 형식/용량만 검증한 뒤 데이터 URL로 인코딩한다 — 설정 화면이 프레임 수·재생
/// 속도를 확정하기 전에(등록 버튼을 누르기 전에) 실제로 움직이는 모습을 보여주는 용도.
pub fn preview_asset(src: &std::path::Path) -> AppResult<PetAssetPreview> {
    let ext = ext_of(src).ok_or_else(|| {
        AppError::Validation(format!(
            "지원하지 않는 형식입니다 ({})",
            PET_ASSET_EXTS.join("/")
        ))
    })?;
    let meta = std::fs::metadata(src).map_err(crate::error::io)?;
    if meta.len() > PET_ASSET_MAX_BYTES {
        return Err(AppError::Validation(format!(
            "파일이 너무 큽니다 (최대 {} MB)",
            PET_ASSET_MAX_BYTES / (1024 * 1024)
        )));
    }
    Ok(PetAssetPreview {
        data_url: encode_data_url(src, &ext)?,
        kind: ext,
    })
}

fn read_map(conn: &Connection) -> AppResult<serde_json::Map<String, serde_json::Value>> {
    let s = crate::repo::settings::get_all(conn)?;
    Ok(s.get(PET_ASSETS_KEY)
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default())
}

fn write_map(
    conn: &mut Connection,
    map: serde_json::Map<String, serde_json::Value>,
) -> AppResult<()> {
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(PET_ASSETS_KEY.to_string(), serde_json::Value::Object(map));
    crate::repo::settings::set(conn, &entries)?;
    Ok(())
}

/// 외부 파일을 동작에 등록한다. 원본을 참조하지 않고 **복사**한다 — 사용자가 원본을 옮기거나
/// 지워도 펫이 멀쩡해야 하고, 그래야 "파일이 사라짐"이 정말 예외 상황이 된다.
pub fn set_asset(
    conn: &mut Connection,
    data_dir: &std::path::Path,
    mood: &str,
    src: &std::path::Path,
    frames: Option<u32>,
    cycle_ms: Option<u32>,
) -> AppResult<()> {
    if !PET_MOODS.contains(&mood) {
        return Err(AppError::Validation(format!("unknown pet mood: {mood}")));
    }
    let ext = ext_of(src).ok_or_else(|| {
        AppError::Validation(format!(
            "지원하지 않는 형식입니다 ({})",
            PET_ASSET_EXTS.join("/")
        ))
    })?;
    let meta = std::fs::metadata(src).map_err(crate::error::io)?;
    if meta.len() > PET_ASSET_MAX_BYTES {
        return Err(AppError::Validation(format!(
            "파일이 너무 큽니다 (최대 {} MB)",
            PET_ASSET_MAX_BYTES / (1024 * 1024)
        )));
    }
    // PNG 만 프레임 수·재생 속도가 필요하다(스프라이트 시트). 나머지는 컨테이너가 타이밍을 갖고
    // 있으므로 둘 다 무시한다(사용자가 뭘 보냈든 저장하지 않는다 — PetSprite.tsx 가 이 값을
    // 읽는 건 kind=="png" 분기뿐이라 저장해봤자 죽은 값이 된다).
    let (frames, cycle_ms) = if ext == "png" {
        let n = frames.unwrap_or(0);
        if !(2..=PET_ASSET_FRAMES_MAX as u32).contains(&n) {
            return Err(AppError::Validation(
                "PNG 스프라이트 시트는 프레임 수(2~64)가 필요합니다".to_string(),
            ));
        }
        let cycle = cycle_ms.unwrap_or(PET_ASSET_CYCLE_MS_DEFAULT);
        if !(PET_ASSET_CYCLE_MS_MIN..=PET_ASSET_CYCLE_MS_MAX).contains(&cycle) {
            return Err(AppError::Validation(format!(
                "재생 속도는 {}~{}ms 사이여야 합니다",
                PET_ASSET_CYCLE_MS_MIN, PET_ASSET_CYCLE_MS_MAX
            )));
        }
        (Some(n), Some(cycle))
    } else {
        (None, None)
    };

    let dir = assets_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(crate::error::io)?;
    // 먼저 새 파일을 복사하고 나서 옛 파일을 지운다 — 순서를 뒤집으면 metadata() 통과 후
    // copy 가 실패했을 때(원본이 그 사이 사라짐/이동 등) 기존 에셋만 지워지고 새 파일은 없어
    // 등록이 통째로 유실된다(list_assets 가 파일 없는 항목을 조용히 건너뛰므로 무드가 SVG 로
    // 되돌아간다).
    let file = format!("{mood}.{ext}");
    let dest = dir.join(&file);
    std::fs::copy(src, &dest).map_err(crate::error::io)?;
    // 같은 동작의 옛 파일은 확장자가 달라도 지운다(고아 파일이 남지 않게). 방금 쓴 파일 자신은
    // 제외 — 확장자가 같은 재등록(예: idle.gif → idle.gif)이면 dest 와 옛 파일 경로가 같다.
    for old in PET_ASSET_EXTS {
        let old_path = dir.join(format!("{mood}.{old}"));
        if old_path != dest {
            let _ = std::fs::remove_file(old_path);
        }
    }

    let mut map = read_map(conn)?;
    map.insert(
        mood.to_string(),
        serde_json::json!({ "file": file, "frames": frames, "cycle_ms": cycle_ms }),
    );
    write_map(conn, map)
}

pub fn clear_asset(
    conn: &mut Connection,
    data_dir: &std::path::Path,
    mood: &str,
) -> AppResult<()> {
    if !PET_MOODS.contains(&mood) {
        return Err(AppError::Validation(format!("unknown pet mood: {mood}")));
    }
    let dir = assets_dir(data_dir);
    for ext in PET_ASSET_EXTS {
        let _ = std::fs::remove_file(dir.join(format!("{mood}.{ext}")));
    }
    let mut map = read_map(conn)?;
    map.remove(mood);
    write_map(conn, map)
}

/// 등록된 에셋을 데이터 URL 로 돌려준다. 파일이 없어진 항목은 **조용히 빠진다** — 호출자는
/// 목록에 없는 동작을 SVG 로 그리므로 그것으로 폴백이 완성된다.
pub fn list_assets(
    conn: &Connection,
    data_dir: &std::path::Path,
) -> AppResult<Vec<PetAsset>> {
    let map = read_map(conn)?;
    let dir = assets_dir(data_dir);
    let mut out = Vec::new();
    for mood in PET_MOODS {
        let Some(entry) = map.get(mood).and_then(|v| v.as_object()) else {
            continue;
        };
        let Some(file) = entry.get("file").and_then(|v| v.as_str()) else {
            continue;
        };
        let path = dir.join(file);
        let kind = ext_of(&path).unwrap_or_else(|| "png".to_string());
        let Ok(data_url) = encode_data_url(&path, &kind) else {
            continue;
        };
        out.push(PetAsset {
            mood: mood.to_string(),
            frames: entry.get("frames").and_then(|v| v.as_u64()).map(|n| n as u32),
            cycle_ms: entry.get("cycle_ms").and_then(|v| v.as_u64()).map(|n| n as u32),
            kind,
            data_url,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn setup() -> (Connection, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let ws: String = conn
            .query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0))
            .unwrap();
        (conn, ws)
    }

    /// 등록 → 목록 → 해제 왕복. 파일이 사라지면 목록에서 빠져 SVG 폴백으로 돌아가는지까지.
    #[test]
    fn asset_register_list_and_missing_file_falls_back() {
        let (mut conn, _ws) = setup();
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("dongle.gif");
        std::fs::write(&src, b"GIF89a-fake-bytes").unwrap();

        set_asset(&mut conn, dir.path(), "idle", &src, None, None).unwrap();
        let list = list_assets(&conn, dir.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].mood, "idle");
        assert_eq!(list[0].kind, "gif");
        assert_eq!(list[0].frames, None, "GIF 는 프레임 수를 쓰지 않는다");
        assert!(list[0].data_url.starts_with("data:image/gif;base64,"));

        // 등록 파일을 밖에서 지워도 크래시 없이 "미등록"으로 수렴한다.
        std::fs::remove_file(assets_dir(dir.path()).join("idle.gif")).unwrap();
        assert!(list_assets(&conn, dir.path()).unwrap().is_empty());

        // 다시 등록 후 해제하면 파일과 설정이 함께 사라진다.
        set_asset(&mut conn, dir.path(), "idle", &src, None, None).unwrap();
        clear_asset(&mut conn, dir.path(), "idle").unwrap();
        assert!(list_assets(&conn, dir.path()).unwrap().is_empty());
        assert!(!assets_dir(dir.path()).join("idle.gif").exists());
    }

    #[test]
    fn asset_validation_rejects_bad_input() {
        let (mut conn, _ws) = setup();
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("sheet.png");
        std::fs::write(&png, b"fake-png-bytes").unwrap();
        let bad = dir.path().join("sprite.mp4");
        std::fs::write(&bad, b"x").unwrap();

        assert!(set_asset(&mut conn, dir.path(), "dancing", &png, Some(4), None).is_err(), "모르는 동작");
        assert!(set_asset(&mut conn, dir.path(), "idle", &bad, None, None).is_err(), "지원 안 하는 확장자");
        assert!(set_asset(&mut conn, dir.path(), "idle", &png, None, None).is_err(), "PNG 는 프레임 수 필수");
        assert!(set_asset(&mut conn, dir.path(), "idle", &png, Some(1), None).is_err(), "프레임 1장은 의미 없음");
        assert!(set_asset(&mut conn, dir.path(), "idle", &png, Some(999), None).is_err(), "상한 초과");
        assert!(
            set_asset(&mut conn, dir.path(), "idle", &png, Some(4), Some(50)).is_err(),
            "재생 속도 하한 미만"
        );
        assert!(
            set_asset(&mut conn, dir.path(), "idle", &png, Some(4), Some(9999)).is_err(),
            "재생 속도 상한 초과"
        );

        // cycle_ms 미지정 → 기본값으로 채워진다.
        set_asset(&mut conn, dir.path(), "idle", &png, Some(4), None).unwrap();
        assert_eq!(
            list_assets(&conn, dir.path()).unwrap()[0].cycle_ms,
            Some(PET_ASSET_CYCLE_MS_DEFAULT),
            "미지정이면 기본 재생 속도로 채워져야 한다"
        );

        set_asset(&mut conn, dir.path(), "happy", &png, Some(6), Some(1500)).unwrap();
        let list = list_assets(&conn, dir.path()).unwrap();
        let happy = list.iter().find(|a| a.mood == "happy").unwrap();
        assert_eq!(happy.frames, Some(6));
        assert_eq!(happy.kind, "png");
        assert_eq!(happy.cycle_ms, Some(1500), "지정한 재생 속도가 그대로 저장돼야 한다");

        // 큰 파일은 거부된다.
        let big = dir.path().join("big.webp");
        std::fs::write(&big, vec![0u8; (PET_ASSET_MAX_BYTES + 1) as usize]).unwrap();
        assert!(set_asset(&mut conn, dir.path(), "alert", &big, None, None).is_err());
    }

    /// GIF/APNG/WebP 는 재생 속도를 프런트가 안 보내도(항상 None), 보내도 무시된다 — 컨테이너가
    /// 자체 타이밍을 갖고 있어 cycle_ms 를 저장해봤자 죽은 값이다.
    #[test]
    fn non_png_assets_never_persist_a_cycle_ms() {
        let (mut conn, _ws) = setup();
        let dir = tempfile::tempdir().unwrap();
        let gif = dir.path().join("a.gif");
        std::fs::write(&gif, b"g").unwrap();

        set_asset(&mut conn, dir.path(), "idle", &gif, None, Some(1500)).unwrap();
        let list = list_assets(&conn, dir.path()).unwrap();
        assert_eq!(list[0].cycle_ms, None, "GIF 는 cycle_ms 를 쓰지 않는다");
    }

    /// 같은 동작에 다른 확장자를 다시 등록하면 옛 파일이 남지 않는다(고아 방지).
    #[test]
    fn asset_replace_removes_the_previous_file() {
        let (mut conn, _ws) = setup();
        let dir = tempfile::tempdir().unwrap();
        let gif = dir.path().join("a.gif");
        let webp = dir.path().join("a.webp");
        std::fs::write(&gif, b"g").unwrap();
        std::fs::write(&webp, b"w").unwrap();

        set_asset(&mut conn, dir.path(), "alert", &gif, None, None).unwrap();
        set_asset(&mut conn, dir.path(), "alert", &webp, None, None).unwrap();
        assert!(!assets_dir(dir.path()).join("alert.gif").exists());
        assert!(assets_dir(dir.path()).join("alert.webp").exists());
        assert_eq!(list_assets(&conn, dir.path()).unwrap().len(), 1);
    }

    /// 복사가 실패하면(원본이 metadata 체크 이후 사라짐/이동 등) 기존에 등록돼 있던 에셋이
    /// 지워지지 않고 그대로 남아야 한다 — 실패한 교체가 성공한 등록을 지우면 안 된다.
    #[test]
    fn failed_copy_leaves_the_previous_asset_intact() {
        let (mut conn, _ws) = setup();
        let dir = tempfile::tempdir().unwrap();
        let gif = dir.path().join("a.gif");
        std::fs::write(&gif, b"g").unwrap();
        set_asset(&mut conn, dir.path(), "alert", &gif, None, None).unwrap();

        // 확장자는 유효하지만 디렉터리라 std::fs::copy 가 실패하는 "원본" — metadata() 는
        // 통과하고(디렉터리도 메타데이터는 읽힌다) copy 단계에서만 터지는 실제 버그 시나리오를
        // 재현한다(단순히 없는 경로면 metadata() 에서 먼저 죽어 이 경로를 검증하지 못한다).
        let fake_src = dir.path().join("broken.webp");
        std::fs::create_dir(&fake_src).unwrap();

        assert!(set_asset(&mut conn, dir.path(), "alert", &fake_src, None, None).is_err());
        assert!(
            assets_dir(dir.path()).join("alert.gif").exists(),
            "실패한 copy 가 기존 파일을 지우면 안 된다"
        );
        assert_eq!(list_assets(&conn, dir.path()).unwrap().len(), 1, "기존 등록도 그대로 조회돼야 한다");
    }
}
