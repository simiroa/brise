// repo: attachments — commands/attachments.yaml
// 파일은 data_dir/attachments/{note_id}/ 로 복사 (원본 참조 아님). rel_path 는 attachments/ 기준 상대경로.
// R4: 이미지 썸네일 파이프라인(SQL 없는 순수 처리)은 thumbs.rs로 분리 — 재수출로 호출부 불변.
use crate::db;
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::models::Attachment;
use crate::util::{new_id, now_iso};
#[cfg(test)]
use image::GenericImageView;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

mod exif_region;
/// 커밋 후 후속 단계(썸네일·EXIF 경유지)와 바이트 스테이징 — 데스크톱 커맨드 2개와 원격 업로드
/// 핸들러가 같은 것을 세 번 적고 있어 실제로 표류했다.
pub mod post_add;
mod thumbs;
pub use exif_region::{auto_meta, PhotoMeta};
pub use thumbs::{ensure_thumb_for_attachment, wants_thumbnail};

/// 복사/하드링크로 보관할 수 있는 최대 크기. 이걸 넘는 원본은 복사 대신 **참조**(ext_path)로
/// 붙인다 — repo::sources::add_file 의 "원본 보관" 경로가 이 값으로 자동 전환한다.
/// ponytail: 자동 전환은 임시 규칙이다. 사용자가 복사/참조를 직접 고르게 하는 것이 다음 단계
/// (프런트 다이얼로그 + source_original_policy 에 "ref" 값 추가).
pub const MAX_ATTACHMENT_BYTES: u64 = 200 * 1024 * 1024; // 200MB

/// 이 크기를 넘으면 **복사하지 않고 참조**한다. 200MB(복사 상한)를 기준으로 두면 사진 작업이
/// 조용히 무너진다 — RAW 한 장이 50MB 라 한 장씩은 상한을 안 넘고, 200장을 넣으면 10GB 가
/// 앱 폴더로 복사된다. 오너 결정(2026-09-10): 32MB. 일반 문서·사진은 복사되고 RAW·동영상·큰
/// 덱은 참조로 간다.
pub const REF_THRESHOLD_BYTES: u64 = 32 * 1024 * 1024; // 32MB

/// Tile thumbnails: longest side 256px, JPEG quality 80, alpha flattened onto white.
/// Named `{rel_path}.thumb.jpg` next to the original — no schema change, cleaned with the note dir.
/// thumbs.rs(자식 모듈)가 `super::THUMB_MAX_SIDE`/`super::THUMB_JPEG_QUALITY`로 참조한다 — 이
/// 파일의 테스트(add_file_image_writes_thumbnail_with_bounded_side 등)도 같이 참조해 여기 둔다.
const THUMB_MAX_SIDE: u32 = 256;
const THUMB_JPEG_QUALITY: u8 = 80;

// ── G4(docs/SYNC.md): 첨부 내용 해시(SHA-256 hex) ──────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `src` → `dest` 복사와 SHA-256 해시 계산을 한 번의 읽기 패스로 수행한다(add_file 의 스트리밍
/// 복사 경로 — 해시를 위해 파일을 다시 읽지 않는다).
fn copy_and_hash(src: &Path, dest: &Path) -> Result<String, std::io::Error> {
    let mut src_file = std::fs::File::open(src)?;
    let mut dest_file = std::fs::File::create(dest)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = src_file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dest_file.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// `src` 를 복사 없이 스트리밍으로만 읽어 SHA-256 을 계산한다 — add_file 의 reference 모드(원본을
/// 복사하지 않음)와 link 모드의 하드링크 성공 분기(대상이 이미 원본과 같은 inode)에서 쓴다. 두
/// 곳 모두 예전엔 이 루프를 각자 인라인으로 들고 있었다(copy_and_hash 의 절반짜리 복제).
fn hash_file(src: &Path) -> Result<String, std::io::Error> {
    let mut src_file = std::fs::File::open(src)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = src_file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 임시 파일명으로 복사+해시 후 원자적으로 목표 이름으로 rename — copy 모드와 link 모드의 하드링크
/// 실패 폴백이 같은 모양이라 하나로 모았다.
fn copy_via_tmp_and_hash(
    src: &Path,
    note_dir: &Path,
    stored_name: &str,
    dest: &Path,
) -> Result<String, std::io::Error> {
    let tmp = note_dir.join(format!(".tmp-{stored_name}"));
    let h = copy_and_hash(src, &tmp)?;
    std::fs::rename(&tmp, dest)?;
    Ok(h)
}

/// 첨부의 **실제 파일 경로**를 계산하는 유일한 지점. 복사본은 `attachments_dir/{rel_path}`,
/// 참조 첨부는 앱 폴더 밖 절대경로(ext_path)다. 파일이 없어도 Some 을 돌려준다 — 사용자가
/// 원본을 옮기거나 지웠을 수 있고, **존재 확인은 읽는 쪽의 몫**이다(NotFound 는 정상 경로).
/// None 은 애초에 파일이 없는 첨부(link/internal) 또는 rel_path 가 attachments/ 밖을 가리키는
/// 경우(safe_rel 거부 — import 로 들어온 DB 는 신뢰 경계 밖).
pub fn file_path_of(
    data_dir: &Path,
    rel_path: Option<&str>,
    ext_path: Option<&str>,
) -> Option<PathBuf> {
    if let Some(ext) = ext_path {
        return Some(PathBuf::from(ext));
    }
    let clean = super::paths::safe_rel(rel_path?).ok()?;
    Some(db::attachments_dir(data_dir).join(clean))
}

/// attachment_open 이 반환하는 해석 결과 (실제 OS 열기는 커맨드 계층 담당).
pub enum OpenTarget {
    File(PathBuf),
    Link(String),
}

/// link 첨부 url 은 결국 opener(ShellExecute 류, scheme allowlist 없음)로 흘러간다. import_bundle 은
/// 외부 JSON 을 무검증 삽입하므로, 임의 scheme/UNC 가 사용자 클릭 한 번에 실행되는 걸 막으려면 http(s)
/// 만 허용해야 한다. add_link(정상 UI), insert_attachment(import), open(방어) 세 경로가 공유한다.
pub(crate) fn is_safe_link_url(url: &str) -> bool {
    let u = url.trim();
    u.starts_with("http://") || u.starts_with("https://")
}

/// 단일 노트의 이미지 첨부 존재 여부 (온디맨드). `folder_list` 는 더 이상 전 코퍼스 has_image 를
/// 스캔하지 않으므로, UI 가 한 행에 대해 필요할 때만 이 경로를 쓴다. 검색/related 배치 경로는
/// `notes::note_summaries_map` 이 그대로 담당한다.
pub fn has_image_for_note(conn: &Connection, note_id: &str) -> AppResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM attachments WHERE note_id=?1 AND kind='image')",
        [note_id],
        |r| r.get::<_, i64>(0),
    )
    .map_err(dberr)
    .map(|n| n != 0)
}

/// 여러 노트의 첨부를 한 쿼리로 배치 로드한다(note_id → 첨부 목록, position 순).
/// folders::files 가 노트당 load_for_note 로 N+1 이던 것을 대체(note_summaries_map 패턴).
pub fn load_for_ids(
    conn: &Connection,
    note_ids: &[String],
) -> AppResult<std::collections::HashMap<String, Vec<Attachment>>> {
    let mut out: std::collections::HashMap<String, Vec<Attachment>> = std::collections::HashMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    // Scale: 변수 상한을 넘기지 않도록 청크로 나눠 조회한다. 각 노트는 한 청크 안에 온전히 들어가므로
    // note 별 position 순서가 보존된다.
    for chunk in note_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT note_id, id, name, kind, rel_path, url, size_bytes, position, ext_path, transcript, transcript_inserted
             FROM attachments WHERE note_id IN ({placeholders}) ORDER BY note_id, position"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Attachment {
                        id: r.get(1)?,
                        name: r.get(2)?,
                        kind: r.get(3)?,
                        rel_path: r.get(4)?,
                        ext_path: r.get(8)?,
                        url: r.get(5)?,
                        size_bytes: r.get(6)?,
                        position: r.get(7)?,
                        transcript: r.get(9)?,
                        transcript_inserted: r.get(10)?,
                    },
                ))
            })
            .map_err(dberr)?;
        for row in rows {
            let (nid, att) = row.map_err(dberr)?;
            out.entry(nid).or_default().push(att);
        }
    }
    Ok(out)
}

pub fn load_for_note(conn: &Connection, note_id: &str) -> AppResult<Vec<Attachment>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, rel_path, url, size_bytes, position, ext_path, transcript, transcript_inserted
             FROM attachments WHERE note_id = ?1 ORDER BY position",
        )
        .map_err(dberr)?;
    let rows = stmt
        .query_map([note_id], |r| {
            Ok(Attachment {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                rel_path: r.get(3)?,
                ext_path: r.get(7)?,
                url: r.get(4)?,
                size_bytes: r.get(5)?,
                position: r.get(6)?,
                transcript: r.get(8)?,
                transcript_inserted: r.get(9)?,
            })
        })
        .map_err(dberr)?;
    rows.collect::<Result<_, _>>().map_err(dberr)
}

pub fn kind_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        // heic/heif: 안드로이드/아이폰 카메라 원본. 분류만 image(EXIF 훅·타일 슬롯) — 썸네일 디코더는
        // 없다(thumbs::thumb_undecodable). 프런트 ATTACHMENT_IMAGE_EXTS(fileKinds.ts)와 같아야 한다.
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "tiff" | "heic" | "heif" => "image",
        // weba/opus: 폰 녹음기(MediaRecorder audio/webm;codecs=opus)가 파일명을 .weba 로 붙여 올린다.
        // .webm 은 동영상 쪽이다(webm 컨테이너만으론 소리/영상을 확장자로 가를 수 없어 이름으로 약속한다).
        "mp3" | "wav" | "ogg" | "oga" | "m4a" | "flac" | "aac" | "weba" | "opus" => "audio",
        _ => "doc",
    }
}

/// Thumbnail path convention relative to attachments/ — discoverable without a DB column.
pub fn thumb_rel_for(rel_path: &str) -> String {
    format!("{rel_path}.thumb.jpg")
}

fn ext_of_rel(rel_path: &str) -> &str {
    Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
}


/// Rows that may need a tile thumbnail: image kind with a file path, excluding SVG by extension.
/// Read-only DB work — command layer drops the lock before calling ensure_thumb_for_attachment.
pub fn thumb_candidates(conn: &Connection, note_id: &str) -> AppResult<Vec<(String, String)>> {
    let atts = load_for_note(conn, note_id)?;
    Ok(atts
        .into_iter()
        .filter(|a| a.kind == "image")
        .filter_map(|a| {
            let rel = a.rel_path?;
            if thumbs::thumb_undecodable(ext_of_rel(&rel)) {
                return None;
            }
            Some((a.id, rel))
        })
        .collect())
}

pub(crate) fn require_note(conn: &Connection, note_id: &str) -> AppResult<()> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM notes WHERE id=?1", [note_id], |_| Ok(true))
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("note not found: {note_id}")))
    }
}

/// 저장 파일명 정규화. orig_name 의 공백·특수문자가 rel_path → 마크다운 `![]()` → asset URL 까지
/// 그대로 흘러가며 링크가 깨지는 문제의 근본 수정 — 온디스크 이름에만 적용하고 DB 표시 이름
/// (attachments.name)은 원본을 그대로 유지한다(add_file 참고).
/// 1) safe_attachment_basename 으로 경로탈출/예약어 방어를 먼저 통과시키고
/// 2) 유니코드 letter/digit(한글 포함)과 `.` `-` `_` 만 남기고 나머지는 `-` 로 치환,
///    연속 `-` 는 하나로 축약, 앞뒤 `-` 제거
/// 3) 확장자는 소문자화
/// 결과가 빈 문자열이면 "attachment" 로 폴백.
fn normalize_stored_name(name: &str) -> String {
    let base = crate::repo::transfer::render::safe_attachment_basename(name);
    let mut out = String::with_capacity(base.len());
    let mut last_dash = false;
    for c in base.chars() {
        if c.is_alphanumeric() || c == '.' || c == '_' {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let result = match trimmed.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() => format!("{stem}.{}", ext.to_lowercase()),
        Some((stem, _)) => stem.to_string(),
        None => trimmed.to_string(),
    };
    if result.is_empty() {
        "attachment".to_string()
    } else {
        result
    }
}

fn next_pos(conn: &Connection, note_id: &str) -> AppResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM attachments WHERE note_id=?1",
        [note_id],
        |r| r.get(0),
    )
    .map_err(dberr)
}

fn storage_mode(conn: &Connection) -> AppResult<String> {
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key='attachment_storage_mode'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(dberr)?
        .and_then(|json| serde_json::from_str::<String>(&json).ok())
        .unwrap_or_else(|| "copy".to_string()))
}

/// 디스크의 **사용자 원본**을 붙이는 진입점 — 복사할지 참조할지를 여기 한 곳에서 정한다.
/// `mode` 가 "ref" 면 참조, 없으면 설정(attachment_storage_mode)의 "reference" 를 따른다.
/// 클립보드 붙여넣기·원격 업로드는 이 함수를 쓰지 않는다(원본이 OS temp 라 참조로 저장하면
/// 곧 지워질 파일을 가리키게 된다) — 그쪽은 add_file 을 바로 부른다.
pub fn add_file_from_disk(
    conn: &mut Connection,
    data_dir: &Path,
    note_id: &str,
    file_path: &str,
    mode: Option<&str>,
) -> AppResult<Attachment> {
    // 설정의 "참조만" 모드는 예전엔 url 에 file:// 를 넣었는데, 그 모양은 파일 kind 의
    // CHECK(url IS NULL)를 위반해 저장 자체가 조용히 실패했다(V80 이전). 이제 ext_path 로 간다.
    // 크기 판정을 여기 두는 이유: 노트에 2GB 동영상을 끌어다 놓는 경우와 사료 원본 보관이 같은
    // 답을 받아야 한다. 예전에는 sources.rs 만 크기를 봐서, 같은 파일이 경로에 따라 복사되기도
    // 하고 200MB 상한에 막히기도 했다.
    let too_big = std::fs::metadata(file_path)
        .map(|m| m.len() > REF_THRESHOLD_BYTES)
        .unwrap_or(false);
    let want_ref = match mode {
        Some(m) => m == "ref",
        None => too_big || storage_mode(conn)? == "reference",
    };
    if want_ref {
        add_file_ref(conn, note_id, file_path)
    } else {
        add_file(conn, data_dir, note_id, file_path)
    }
}

pub fn add_file(
    conn: &mut Connection,
    data_dir: &Path,
    note_id: &str,
    file_path: &str,
) -> AppResult<Attachment> {
    let storage_mode = storage_mode(conn)?;
    require_note(conn, note_id)?;
    let src = Path::new(file_path);
    let meta = std::fs::metadata(src).map_err(io)?;
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation(
            "attachment exceeds 200MB limit".to_string(),
        ));
    }
    let orig_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let kind = kind_from_ext(&ext);
    let size = meta.len() as i64;
    let pos = next_pos(conn, note_id)?;
    let id = new_id();

    // 대상 디렉토리 준비 및 충돌 방지용 저장 파일명.
    let note_dir = db::attachments_dir(data_dir).join(note_id);
    std::fs::create_dir_all(&note_dir).map_err(io)?;
    let short = &new_id()[..8];
    let stored_name = format!("{short}-{}", normalize_stored_name(&orig_name));
    let dest = note_dir.join(&stored_name);

    let content_hash = if storage_mode == "link" {
        // Link (하드링크) 모드: hard_link 시도, 교차 디바이스 등 실패 시 copy로 폴백
        if let Ok(()) = std::fs::hard_link(src, &dest) {
            hash_file(src).map_err(io)?
        } else {
            copy_via_tmp_and_hash(src, &note_dir, &stored_name, &dest).map_err(io)?
        }
    } else {
        // Copy 모드 (기본값): 임시명 -> rename
        copy_via_tmp_and_hash(src, &note_dir, &stored_name, &dest).map_err(io)?
    };

    let rel_path = format!("{note_id}/{stored_name}");
    conn.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9)",
        params![id, note_id, orig_name, kind, rel_path, size, pos, now_iso(), content_hash],
    )
    .map_err(|e| {
        // 행 없는 복사본이 고아로 남지 않게(드릴 1 — DB full 등). 지우기 실패는 어쩔 수 없이 삼키되 진단에 남긴다.
        if let Err(re) = std::fs::remove_file(&dest) {
            crate::diag::warn("attachments", "orphan_copy_cleanup_failed", format!("{re}"));
        }
        dberr(e)
    })?;

    Ok(Attachment {
        id,
        name: orig_name,
        kind: kind.to_string(),
        rel_path: Some(rel_path),
        ext_path: None,
        url: None,
        size_bytes: Some(size),
        position: pos,
        transcript: None,
        transcript_inserted: false,
    })
}

/// 참조 첨부 — 원본을 복사하지 않고 절대경로만 저장한다(1GB pptx 처럼 복사가 말이 안 되는 원본).
/// 크기 상한 없음. content_hash 는 채우지 않는다 — 추가 시점에 1GB 를 해싱하면 앱이 멈춘다.
/// ponytail: 참조 첨부에는 썸네일을 만들지 않는다. 썸네일 키(`{rel_path}.thumb.jpg`)가 rel_path
/// 규약이라 참조에는 키가 없기 때문. 천장: 참조 이미지는 갤러리/타일에서 플레이스홀더로 보인다.
/// 업그레이드 경로: 썸네일 키를 첨부 id 기반(`_thumbs/{id}.jpg`)으로 바꾸면 앱 폴더 안에 만들 수
/// 있다(원본 옆에는 절대 쓰지 않는다 — 남의 폴더를 오염시킨다).
pub fn add_file_ref(
    conn: &mut Connection,
    note_id: &str,
    file_path: &str,
) -> AppResult<Attachment> {
    require_note(conn, note_id)?;
    let src = Path::new(file_path);
    // 원본이 나중에 사라져도 경로는 남는다(읽는 쪽이 NotFound 로 다룬다) — 다만 추가 시점엔
    // 존재해야 크기를 읽을 수 있고, 상대경로가 앱의 cwd 에 묶이지 않게 절대경로로 정규화한다.
    let meta = std::fs::metadata(src).map_err(io)?;
    // 이미 절대경로면 그대로 둔다 — Windows 의 canonicalize 는 `\\?\C:\...` 를 만들고 그 모양은
    // opener(ShellExecute)/표시 양쪽에서 말썽이다.
    let ext_path = if src.is_absolute() {
        src.to_path_buf()
    } else {
        std::fs::canonicalize(src).map_err(io)?
    }
    .to_string_lossy()
    .to_string();
    let orig_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    let kind = kind_from_ext(ext);
    let size = meta.len() as i64;
    let pos = next_pos(conn, note_id)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, ext_path)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?7, ?8)",
        params![id, note_id, orig_name, kind, size, pos, now_iso(), ext_path],
    )
    .map_err(dberr)?;
    Ok(Attachment {
        id,
        name: orig_name,
        kind: kind.to_string(),
        rel_path: None,
        ext_path: Some(ext_path),
        url: None,
        size_bytes: Some(size),
        position: pos,
        transcript: None,
        transcript_inserted: false,
    })
}

pub fn add_link(
    conn: &mut Connection,
    note_id: &str,
    name: &str,
    url: &str,
) -> AppResult<Attachment> {
    require_note(conn, note_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("link name is empty".to_string()));
    }
    let url = url.trim();
    if !is_safe_link_url(url) {
        return Err(AppError::Validation(format!("invalid url: {url}")));
    }
    let pos = next_pos(conn, note_id)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
         VALUES (?1, ?2, ?3, 'link', NULL, ?4, NULL, ?5, ?6)",
        params![id, note_id, name, url, pos, now_iso()],
    )
    .map_err(dberr)?;
    Ok(Attachment {
        id,
        name: name.to_string(),
        kind: "link".to_string(),
        rel_path: None,
        ext_path: None,
        url: Some(url.to_string()),
        size_bytes: None,
        position: pos,
        transcript: None,
        transcript_inserted: false,
    })
}

/// Insert a safe link only when this note does not already contain the exact URL.  AI metadata
/// applies can be retried, so URL links must behave as a set rather than accumulating duplicates.
/// The caller owns the surrounding transaction; this helper deliberately does not commit.
pub(crate) fn add_link_if_absent_tx(
    tx: &Transaction<'_>,
    note_id: &str,
    url: &str,
) -> AppResult<bool> {
    let url = url.trim();
    if !is_safe_link_url(url) {
        return Err(AppError::Validation(format!("invalid url: {url}")));
    }
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM attachments WHERE note_id=?1 AND kind='link' AND url=?2 LIMIT 1",
            params![note_id, url],
            |_| Ok(true),
        )
        .optional()
        .map_err(dberr)?
        .unwrap_or(false);
    if exists {
        return Ok(false);
    }
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM attachments WHERE note_id=?1",
            [note_id],
            |r| r.get(0),
        )
        .map_err(dberr)?;
    tx.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
         VALUES (?1, ?2, ?3, 'link', NULL, ?3, NULL, ?4, ?5)",
        params![new_id(), note_id, url, position, now_iso()],
    )
    .map_err(dberr)?;
    Ok(true)
}

/// 각주 첨부 — `add_note`(제거됨)와 같은 .md 저장 경로, kind='footnote'.
/// `anchor_text` 는 생성 시점 선택 텍스트(목록 표시 힌트)로 `url` 컬럼에 넣는다(위치 SSOT 아님 —
/// 위치는 본문 TipTap mark 의 attachment id). 이름 입력이 없으므로:
/// - non-empty trimmed `anchor_text` → 최대 40자 truncate 를 name 으로 사용
/// - 없거나 공백뿐이면 고정 fallback `"footnote"`
/// 빈 본문(trim 후 empty)은 VALIDATION.
pub fn add_footnote(
    conn: &mut Connection,
    data_dir: &Path,
    note_id: &str,
    text: &str,
    anchor_text: Option<&str>,
) -> AppResult<Attachment> {
    require_note(conn, note_id)?;
    if text.trim().is_empty() {
        return Err(AppError::Validation("footnote text is empty".to_string()));
    }
    if text.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation(
            "footnote text exceeds 200MB limit".to_string(),
        ));
    }

    let anchor_trimmed = anchor_text.map(str::trim).filter(|s| !s.is_empty());
    // name: list/export basename. anchor 발췌 우선, 없으면 고정 "footnote".
    const NAME_MAX_CHARS: usize = 40;
    let name = match anchor_trimmed {
        Some(a) => {
            let mut s: String = a.chars().take(NAME_MAX_CHARS).collect();
            if a.chars().count() > NAME_MAX_CHARS {
                s.push('…');
            }
            s
        }
        None => "footnote".to_string(),
    };
    // url 컬럼 = display-only anchor hint (None if omitted/blank).
    let url: Option<&str> = anchor_trimmed;

    let note_dir = db::attachments_dir(data_dir).join(note_id);
    std::fs::create_dir_all(&note_dir).map_err(io)?;
    let short = &new_id()[..8];
    let safe_name: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let stored_name = format!("{short}-{safe_name}.md");
    let dest = note_dir.join(&stored_name);

    std::fs::write(&dest, text).map_err(io)?;

    let rel_path = format!("{note_id}/{stored_name}");
    let size = text.len() as i64;
    let pos = next_pos(conn, note_id)?;
    let id = new_id();
    let content_hash = sha256_hex(text.as_bytes());

    // INSERT 실패 시 방금 쓴 .md 즉시 정리 (add_note 과 동일 — 고아 파일 방지).
    if let Err(e) = conn.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at, content_hash)
         VALUES (?1, ?2, ?3, 'footnote', ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, note_id, name, rel_path, url, size, pos, now_iso(), content_hash],
    ) {
        let _ = std::fs::remove_file(&dest);
        return Err(dberr(e));
    }

    Ok(Attachment {
        id,
        name,
        kind: "footnote".to_string(),
        rel_path: Some(rel_path),
        ext_path: None,
        url: url.map(|s| s.to_string()),
        size_bytes: Some(size),
        position: pos,
        transcript: None,
        transcript_inserted: false,
    })
}

pub fn add_internal(
    conn: &Connection,
    note_id: &str,
    target_note_id: &str,
    name: &str,
) -> AppResult<Attachment> {
    require_note(conn, note_id)?;
    require_note(conn, target_note_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("internal document name is empty".to_string()));
    }
    
    let pos = next_pos(conn, note_id)?;
    let id = new_id();
    
    conn.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
         VALUES (?1, ?2, ?3, 'internal', NULL, ?4, NULL, ?5, ?6)",
        params![id, note_id, name, target_note_id, pos, now_iso()],
    )
    .map_err(dberr)?;

    Ok(Attachment {
        id,
        name: name.to_string(),
        kind: "internal".to_string(),
        rel_path: None,
        ext_path: None,
        url: Some(target_note_id.to_string()),
        size_bytes: None,
        position: pos,
        transcript: None,
        transcript_inserted: false,
    })
}

/// 시트 차트 **라이브 참조** 첨부(PLAN-2026-09-20 §2.3, D5) — kind='chart',
/// `url = "<section_id>#<chart_id>"`, 파일 없음. 프리뷰가 열 때마다 시트 본문에서 다시 그린다.
/// 검증: 노트 실재 · 섹션 실재 + kind='sheet' + **같은 노트 소속** · chart_id 가 그 섹션
/// `charts[]` 에 있음. 같은 url 의 chart 행이 이미 이 노트에 있으면 **그 행을 그대로 돌려준다**
/// (멱등 — 편집기 토글·카드 버튼·어시스트가 같은 함수를 부르므로 중복 행이 생기면 안 된다).
/// 섹션이 나중에 지워져도 행은 남는다(D8) — 프리뷰가 "원본 없음"을 그리고 삭제는 사용자 몫.
/// ponytail: 다른 노트의 시트 차트 참조는 v1 천장 — 프리뷰가 activeNote.sections 에서만 섹션을
/// 찾는다. 노트 간 참조가 필요해지면 프리뷰가 남의 섹션을 IPC 로 읽고 여기 소속 검증을 푼다.
pub fn add_chart_ref(
    conn: &Connection,
    note_id: &str,
    section_id: &str,
    chart_id: &str,
    name: &str,
) -> AppResult<Attachment> {
    require_note(conn, note_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("chart attachment name is empty".to_string()));
    }
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT note_id, kind, body_md FROM sections WHERE id=?1",
            [section_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (sec_note_id, sec_kind, body_md) =
        row.ok_or_else(|| AppError::NotFound(format!("section not found: {section_id}")))?;
    if sec_note_id != note_id {
        return Err(AppError::Validation(
            "chart section belongs to another note".to_string(),
        ));
    }
    if sec_kind != "sheet" {
        return Err(AppError::Validation(format!(
            "section is not a sheet: kind={sec_kind}"
        )));
    }
    let has_chart = serde_json::from_str::<serde_json::Value>(&body_md)
        .ok()
        .and_then(|v| {
            v.get("charts")?.as_array().map(|charts| {
                charts
                    .iter()
                    .any(|c| c.get("id").and_then(|i| i.as_str()) == Some(chart_id))
            })
        })
        .unwrap_or(false);
    if !has_chart {
        return Err(AppError::NotFound(format!(
            "chart not found in sheet: {section_id}#{chart_id}"
        )));
    }
    let url = format!("{section_id}#{chart_id}");
    let existing: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT id, name, position FROM attachments WHERE note_id=?1 AND kind='chart' AND url=?2",
            params![note_id, url],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(dberr)?;
    if let Some((id, name, position)) = existing {
        return Ok(Attachment {
            id,
            name,
            kind: "chart".to_string(),
            rel_path: None,
            ext_path: None,
            url: Some(url),
            size_bytes: None,
            position,
            transcript: None,
            transcript_inserted: false,
        });
    }
    let pos = next_pos(conn, note_id)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
         VALUES (?1, ?2, ?3, 'chart', NULL, ?4, NULL, ?5, ?6)",
        params![id, note_id, name, url, pos, now_iso()],
    )
    .map_err(dberr)?;
    Ok(Attachment {
        id,
        name: name.to_string(),
        kind: "chart".to_string(),
        rel_path: None,
        ext_path: None,
        url: Some(url),
        size_bytes: None,
        position: pos,
        transcript: None,
        transcript_inserted: false,
    })
}

pub fn remove(conn: &mut Connection, data_dir: &Path, id: &str) -> AppResult<bool> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT rel_path, ext_path FROM attachments WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (rel_path, ext_path) =
        row.ok_or_else(|| AppError::NotFound(format!("attachment not found: {id}")))?;
    // 참조 첨부는 **사용자의 원본**을 가리킨다 — 행만 지우고 파일은 절대 건드리지 않는다.
    // 이 줄은 이중 방어다: 참조 행은 CHECK 상 rel_path 가 이미 NULL 이라 아래 삭제가 탈 것이
    // 없다. 가드를 꺼도 테스트가 초록인 이유가 그것이고(음성 확인함), 진짜로 지켜야 할 불변식은
    // **"삭제는 attachments/ 안에서만 일어난다"** 다 — 아래가 rel_path 대신 file_path_of() 를
    // 쓰도록 누가 바꾸는 순간 참조 원본이 지워지고, ref_attachment_..._keeps_the_original 이
    // 그때 빨개진다. 그 회귀가 이 테스트의 존재 이유다.
    let rel_path = if ext_path.is_some() { None } else { rel_path };
    let tx = conn.transaction().map_err(dberr)?;
    tx.execute("DELETE FROM attachments WHERE id=?1", [id])
        .map_err(dberr)?;
    crate::repo::tombstone::record_tombstone(&tx, "attachments", id)?;
    tx.commit().map_err(dberr)?;
    // 커밋 후 파일 삭제. rel_path 는 DB 유래이므로 safe_rel 로 attachments/ 밖을 가리키지 않는지
    // 검증 후 삭제 (open() 과 동일한 방어).
    // ponytail: 리스크 감사 B — 실패를 삼키지 않고 로그로 남긴다(발견 가능하게). "시작 청소가
    // 수거한다"던 예전 주석은 부정확했다: orphan_cleanup 은 notes 테이블에서 아예 사라진
    // note_id 의 attachments/<note_id>/ 디렉토리 전체만 지운다 — 살아 있는 노트 폴더 안에서
    // remove_file 이 실패해 남는 개별 고아 파일은 어떤 코드 경로도 청소하지 않는다. 천장:
    // 그런 파일은 디스크에 영구히 남는다. 업그레이드 경로: orphan_cleanup 을 파일 단위 대조로
    // 확장(디렉토리별로 attachments 테이블의 rel_path 셋과 diff) — 지금은 diff 크기상 보류.
    // Thumbnail lives at `{rel}.thumb.jpg` — remove it too so a live note dir is not left with
    // an orphan tile after the attachment row is gone.
    if let Some(rel) = rel_path {
        let att_root = db::attachments_dir(data_dir);
        if let Ok(clean) = super::paths::safe_rel(&rel) {
            let path = att_root.join(clean);
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    crate::diag::warn(
                        "attachments",
                        "attachment_delete_failed",
                        format!("{}: {e}", path.file_name().and_then(|n| n.to_str()).unwrap_or("?")),
                    );
                }
            }
        }
        let thumb_rel = thumb_rel_for(&rel);
        if let Ok(thumb_clean) = super::paths::safe_rel(&thumb_rel) {
            let thumb_path = att_root.join(thumb_clean);
            if let Err(e) = std::fs::remove_file(&thumb_path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    crate::diag::warn(
                        "attachments",
                        "thumbnail_delete_failed",
                        format!("{}: {e}", thumb_path.file_name().and_then(|n| n.to_str()).unwrap_or("?")),
                    );
                }
            }
        }
    }
    Ok(true)
}

/// 첨부 표시 이름 변경. **DB 의 name 만** 바꾼다 — 저장 파일(`{8hex}-{정규화 이름}`)·참조 원본은 절대 건드리지
/// 않으므로 충돌이 없고, 참조 첨부의 원본 파일 이름도 그대로다. 파일 첨부(image/doc/audio)만 대상이고,
/// **확장자는 바꿀 수 없다**(프리뷰 종류·코드 하이라이트가 이름의 확장자로 갈리는데 실제 파일은 그대로라
/// 거짓말이 된다). 이름 구분자(/ )·제어문자·255자 초과는 거부한다.
/// pptx 는 첨부↔추출본(source)을 **이름으로** 잇고 있어(DocPreview.tsx), 같은 노트에서 옛 이름과 같던
/// source 이름도 함께 바꿔 그 연결을 지킨다. ponytail: 같은 이름 pptx 가 둘이면 둘 다 바뀐다(기존 결합의
/// 천장 그대로) — 풀려면 sources.attachment_id 스키마 변경이 필요하다.
pub fn rename(conn: &mut Connection, id: &str, new_name: &str) -> AppResult<Attachment> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::Validation("attachment name is empty".to_string()));
    }
    if new_name.chars().count() > 255 || new_name.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err(AppError::Validation("invalid attachment name".to_string()));
    }
    let (note_id, old_name, kind): (String, String, String) = conn
        .query_row("SELECT note_id, name, kind FROM attachments WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("attachment not found: {id}")))?;
    if !matches!(kind.as_str(), "image" | "doc" | "audio") {
        return Err(AppError::Validation(format!("{kind} attachments cannot be renamed")));
    }
    let ext_of = |n: &str| -> String {
        n.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
    };
    if ext_of(new_name) != ext_of(&old_name) {
        return Err(AppError::Validation("attachment extension cannot be changed".to_string()));
    }
    if new_name != old_name {
        let tx = conn.transaction().map_err(dberr)?;
        tx.execute("UPDATE attachments SET name=?1 WHERE id=?2", params![new_name, id])
            .map_err(dberr)?;
        tx.execute(
            "UPDATE sources SET name=?1, updated_at=?2 WHERE note_id=?3 AND name=?4",
            params![new_name, now_iso(), note_id, old_name],
        )
        .map_err(dberr)?;
        tx.commit().map_err(dberr)?;
    }
    load_for_note(conn, &note_id)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| AppError::NotFound(format!("attachment not found: {id}")))
}

/// 실행형 확장자 — attachment_open 이 OS 셸에 넘기면 더블클릭처럼 **실행**된다. 첨부는 외부에서 온
/// 파일일 수 있으므로 커맨드 계층이 이 목록이면 "열기" 대신 폴더에서 보기로 돌린다(한 관문).
pub fn is_executable_ext(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    matches!(
        ext.as_str(),
        "exe" | "bat" | "cmd" | "com" | "scr" | "vbs" | "vbe" | "js" | "jse" | "wsf" | "wsh" | "msi" | "ps1" | "psm1" | "psd1" | "lnk" | "reg" | "hta" | "jar"
            // 스크립트 언어 — 코드 첨부 뷰어가 이 확장자들을 앱 안에서 보여주므로 OS 기본 앱(파이썬 런처·셸)에
            // 넘겨 실행시킬 이유가 없다. 폴더에서 보기로 돌린다.
            | "py" | "pyw" | "sh" | "bash" | "zsh" | "rb" | "pl" | "php" | "cpl" | "pif" | "url" | "scf" | "msc" | "application" | "appref-ms" | "gadget"
    )
}

/// attachment_open 해석 — 파일은 존재 확인(IO), 링크는 URL 반환. 실제 열기는 커맨드 계층.
pub fn open(conn: &Connection, data_dir: &Path, id: &str) -> AppResult<OpenTarget> {
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT kind, rel_path, url, ext_path FROM attachments WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(dberr)?;
    let (kind, rel_path, url, ext_path) =
        row.ok_or_else(|| AppError::NotFound(format!("attachment not found: {id}")))?;
    // internal 은 url 에 대상 note id 를 담을 뿐 OS/브라우저로 여는 대상이 아니다 —
    // 프론트가 selectNote 로 처리한다. attachment_open 으로 오면 명시적 거부.
    // chart 도 같다 — url 은 "<section_id>#<chart_id>" 참조일 뿐이다(add_chart_ref).
    if kind == "internal" || kind == "chart" {
        return Err(AppError::Validation(format!(
            "{kind} attachments are opened in-app, not via attachment_open"
        )));
    }
    // footnote 은 rel_path(.md) 가 있어도 OS 로 열지 않는다 — 인앱 각주 UI 전용.
    // (url 컬럼은 anchor_text 표시 힌트라 link 가 아님; open 경로에 넘기면 안 된다.)
    if kind == "footnote" {
        return Err(AppError::Validation(
            "footnote attachments are opened in-app, not via attachment_open".to_string(),
        ));
    }
    if kind == "link" {
        let url = url.ok_or_else(|| AppError::Io("link has no url".to_string()))?;
        // 방어: import 시점 이후 DB 가 신뢰 경계를 벗어났을 수 있다. opener 로 넘기기 전 재검증.
        if !is_safe_link_url(&url) {
            return Err(AppError::Validation(format!("unsafe link url: {url}")));
        }
        return Ok(OpenTarget::Link(url));
    }
    // R5: 복사본은 attachments/ 안인지 검증(import 시점 이후 DB가 신뢰 경계 밖일 가능성),
    // 참조는 앱 폴더 밖 절대경로 — 둘 다 file_path_of 한 곳에서 갈린다.
    let path = file_path_of(data_dir, rel_path.as_deref(), ext_path.as_deref())
        .ok_or_else(|| AppError::Io("attachment has no path".to_string()))?;
    // 원본이 옮겨졌거나 지워졌을 수 있다 — 정상 경로로 다룬다(패닉 금지).
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "file missing: {}",
            path.display()
        )));
    }
    Ok(OpenTarget::File(path))
}

// attachment_read_text 캡: 텍스트 프리뷰용 인메모리 반환 상한.
//
// 넘으면 **거부하지 않고 앞부분만 돌려준다.** 예전에는 VALIDATION 이었는데, 그 주석은 "프리뷰는
// 이걸 넘길 일이 없다" 고 적어두고 있었다 — 로그 파일에는 틀린 가정이다. 2MB 짜리 .log/.csv 는
// 첫 화면조차 못 보고 "외부에서 열기" 만 떴다. 상한의 목적은 메모리 보호이고, 프리뷰에서 그
// 목적을 지키는 옳은 방법은 거부가 아니라 앞부분을 보여주는 것이다(pptx 추출 상한과 같은 교훈).
// 대신 **잘렸다는 사실은 반드시 알린다** — 안 알리면 사용자가 파일 전체를 봤다고 믿는다.
const MAX_TEXT_READ_BYTES: u64 = 1024 * 1024; // 1MB

/// 각주/노트/텍스트 문서 본문을 IPC 로 읽는다 — 프리뷰의 asset 프로토콜 fetch 가 Windows 에서
/// scope 403 으로 전면 불능이었던 사고의 근본 수정(specs/commands/attachments.yaml 참고).
/// kind 게이트: footnote/note 는 항상 .md 저장, doc 은 확장자가 .md/.txt/.json/.csv/.log/.vtt/.yaml/.yml 일 때만 — 임의
/// 바이너리를 텍스트로 끌어올리는 통로가 되지 않게 한다.
pub fn read_text(conn: &Connection, data_dir: &Path, id: &str) -> AppResult<(String, bool)> {
    let row: Option<(String, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT kind, name, rel_path, ext_path FROM attachments WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (kind, name, rel_path, ext_path) =
        row.ok_or_else(|| AppError::NotFound(format!("attachment not found: {id}")))?;
    let text_kind = match kind.as_str() {
        "footnote" | "note" => true,
        "doc" => {
            let ext = ext_of_rel(&name).to_lowercase();
            // 코드/스크립트 확장자는 프런트 lib/fileKinds.ts 의 CODE_PREVIEW_EXTS 와 같은 목록이다(코드 뷰어).
            matches!(
                ext.as_str(),
                "md" | "txt" | "json" | "csv" | "log" | "vtt" | "yaml" | "yml"
                    | "py" | "pyw" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs" | "go" | "java" | "kt" | "kts" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "rb" | "php" | "swift" | "lua" | "r" | "sh" | "bash" | "zsh" | "ps1" | "bat" | "cmd" | "sql" | "css" | "scss" | "less" | "xml" | "toml" | "ini" | "cfg" | "conf" | "vue" | "svelte" | "dart" | "gradle" | "mk"
            )
        }
        _ => false,
    };
    if !text_kind {
        return Err(AppError::Validation(format!(
            "attachment is not a text document: kind={kind}"
        )));
    }
    let path = file_path_of(data_dir, rel_path.as_deref(), ext_path.as_deref())
        .ok_or_else(|| AppError::Io("attachment has no path".to_string()))?;
    let meta = std::fs::metadata(&path).map_err(io)?;
    let truncated = meta.len() > MAX_TEXT_READ_BYTES;
    if !truncated {
        return Ok((std::fs::read_to_string(&path).map_err(io)?, false));
    }
    // 상한만큼만 읽는다. 경계에서 멀티바이트 문자가 반토막 날 수 있으므로 **유효한 데까지만**
    // 자른다 — lossy 로 받으면 잘린 조각이 U+FFFD 로 바뀌어 프리뷰 끝에 깨진 글자가 남고,
    // 대체문자가 3바이트라 결과가 오히려 상한을 넘는다.
    let f = std::fs::File::open(&path).map_err(io)?;
    let mut buf = Vec::new();
    let mut limited = std::io::Read::take(f, MAX_TEXT_READ_BYTES);
    std::io::Read::read_to_end(&mut limited, &mut buf).map_err(io)?;
    let valid = match std::str::from_utf8(&buf) {
        Ok(s) => s.len(),
        Err(e) => e.valid_up_to(),
    };
    buf.truncate(valid);
    Ok((String::from_utf8(buf).expect("valid_up_to 까지는 정의상 유효한 UTF-8"), true))
}

/// attachment_fetch_reader 가 쓰는 조회: link 종류인지 확인하고 url 을 반환한다. attachment_open
/// 이 이미 하는 kind 검증과 같은 이유 — id 하나로 임의 파일/내부노트가 아니라 실제로 사용자가
/// 저장한 웹 링크만 원격 fetch 대상이 되도록 강제한다 (프라이버시 민감 네트워크 호출이므로).
pub fn link_url(conn: &Connection, id: &str) -> AppResult<String> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT kind, url FROM attachments WHERE id=?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(dberr)?;
    let (kind, url) = row.ok_or_else(|| AppError::NotFound(format!("attachment not found: {id}")))?;
    if kind != "link" {
        return Err(AppError::Validation(
            "reader view is only available for link attachments".to_string(),
        ));
    }
    url.ok_or_else(|| AppError::Io("link has no url".to_string()))
}

/// orphan_cleanup: notes 에 없는 note_id 첨부 디렉토리를 정리(앱 시작 시 1회).
///
/// P0 (docs/AUDIT-2026-09-26-fallback-observability.md §1): 예전엔 여기서 바로 remove_dir_all
/// 했다 — DB 손상 → 최신(옛) 백업으로 자동 복구된 직후 부팅에서는, 그 백업 스냅샷 이후 만든
/// 노트가 "고아"로 오판되어 첨부가 영구 삭제됐다(스냅샷은 하루 1회뿐이라 그 폭이 컸다). 청소는
/// 매 부팅 돌기 때문에 복구 부팅 한 번만 건너뛰는 건 해법이 아니다. 그래서 지금은 절대 지우지
/// 않고 repo::orphan_hold 로 옮긴다 — 실제로 죽은 디렉토리든 복구로 오판된 생존자든, 사용자가
/// 필요하면 나중에 data_dir/orphaned/ 에서 되찾을 수 있다.
pub fn orphan_cleanup(conn: &Connection, data_dir: &Path) -> AppResult<()> {
    let dir = db::attachments_dir(data_dir);
    if !dir.exists() {
        return Ok(());
    }
    // 모든 note id 를 한 번에 로드해 메모리 셋으로 조회한다 — 디렉토리마다 SELECT 하던 N+1
    // (10만 노트면 시작 시 10만 쿼리)을 1쿼리로. soft-delete 필터 없음(원본 동일): 휴지통 노트도
    // 행이 남아 있으면 첨부 디렉토리는 고아가 아니다.
    let known_ids: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT id FROM notes").map_err(dberr)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(dberr)?;
        rows.collect::<Result<_, _>>().map_err(dberr)?
    };
    for entry in std::fs::read_dir(&dir).map_err(io)? {
        let entry = entry.map_err(io)?;
        if !entry.path().is_dir() {
            continue;
        }
        let note_id = entry.file_name().to_string_lossy().to_string();
        // Reserved roots for canvas-page images and legacy space-tab images (dormant, still
        // used by the notebook backup/restore feature). Neither is a note_id — skipping them is
        // required, otherwise every boot would sweep them into holding.
        // ponytail: canvas plugin removed 2026-09-28 — canvas_pages/ stays dormant on disk and no
        // sweep touches it (its own active-page orphan sweep was removed with the plugin).
        if note_id == crate::repo::canvas_page_image::CANVAS_PAGE_IMAGE_ROOT
            || note_id == crate::repo::canvas_page_image::SPACE_IMAGE_ROOT
        {
            continue;
        }
        if !known_ids.contains(&note_id) {
            // 절대 삭제하지 않는다(위 함수 주석 §P0) — 보관함 이동이 실패해도(잠금 등)
            // orphan_hold::move_to_holding 은 삭제로 대체하지 않고 원본을 제자리에 남긴다.
            let _ = crate::repo::orphan_hold::move_to_holding(
                data_dir,
                crate::db::ATTACHMENTS_DIR,
                &note_id,
                &entry.path(),
            );
        }
    }
    crate::repo::canvas_page_image::dormant_orphan_cleanup(conn, data_dir)?;
    // 보관함 회수(30일 지난 배치 삭제, 격리 DB 파일이 있으면 통째로 보류)도 같은 스윕에서 —
    // 별도 트리거를 두면 "언제 도는지"가 또 하나의 관측성 구멍이 된다.
    let _ = crate::repo::orphan_hold::purge_stale(data_dir);
    Ok(())
}

/// G4 백필 — 기존(마이그레이션 이전에 쓰인) 파일 첨부의 content_hash 를 채운다. link/internal
/// kind 는 rel_path 가 없어 대상에서 자연히 제외된다(WHERE rel_path IS NOT NULL). 앱 부팅 시
/// db::bootstrap 이 별도 스레드에서 1회 호출한다(파일이 많으면 I/O 비용이 있어 부팅을 막지
/// 않기 위함) — 이 함수 자체는 동기 루프다.
/// ponytail: 파일이 없거나(원본 이동/삭제) 읽기 실패하면 그 행만 조용히 skip 한다 — best-effort
/// 백필이라 하나의 실패로 부팅/나머지 백필을 막을 이유가 없다.
/// 참조 첨부(ext_path)도 rel_path 가 NULL 이라 같은 WHERE 로 자연히 빠진다 — 의도한 것이다:
/// 1GB 원본을 부팅 뒤 조용히 해싱하지 않는다.
pub fn backfill_content_hashes(conn: &Connection, data_dir: &Path) -> AppResult<()> {
    let mut stmt = conn
        .prepare("SELECT id, rel_path FROM attachments WHERE content_hash IS NULL AND rel_path IS NOT NULL")
        .map_err(dberr)?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(stmt);

    let att_root = db::attachments_dir(data_dir);
    for (id, rel) in rows {
        let Ok(clean) = super::paths::safe_rel(&rel) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(att_root.join(clean)) else {
            continue; // 원본 파일 없음/읽기 실패 — 조용히 skip.
        };
        let hash = sha256_hex(&bytes);
        let _ = conn.execute(
            "UPDATE attachments SET content_hash=?1 WHERE id=?2",
            params![hash, id],
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    
    // notes 는 folder_id/year/created_at/updated_at 가 NOT NULL 이고 folder_id 는 folders 를
    // 참조한다. migrations::run 이 시드 워크스페이스+폴더("Notes")를 만들므로 그 폴더에 붙인다.
    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        for (id, title) in [("note1", "title"), ("note2", "target")] {
            conn.execute(
                "INSERT INTO notes(id, folder_id, title, year, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1000, ?4, ?4)",
                params![id, folder_id, title, now],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn normalize_stored_name_rules() {
        // 한글은 유지.
        assert_eq!(normalize_stored_name("사진.png"), "사진.png");
        // 공백 → 하이픈.
        assert_eq!(normalize_stored_name("my photo.png"), "my-photo.png");
        // 괄호/샵/퍼센트 등은 전부 하이픈으로 치환.
        assert_eq!(normalize_stored_name("a(1)#b%c.png"), "a-1-b-c.png");
        // 연속 하이픈은 하나로 축약.
        assert_eq!(normalize_stored_name("a   b---c.png"), "a-b-c.png");
        // 확장자는 소문자화.
        assert_eq!(normalize_stored_name("IMG.PNG"), "IMG.png");
        // 특수문자뿐인 이름은 "attachment" 로 폴백.
        assert_eq!(normalize_stored_name("???.???"), "attachment");
        assert_eq!(normalize_stored_name("###"), "attachment");
    }

    #[test]
    fn add_file_normalizes_stored_name_but_keeps_display_name() {
        // 회귀: 공백+괄호 든 원본 파일명이 rel_path(→ 마크다운 → asset URL)까지 그대로 흘러가면
        // 링크가 깨진다. 저장 경로만 정규화하고 DB 표시 이름(name)은 원본 그대로여야 한다.
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("my photo (final).png");
        write_test_png(&src, 10, 10);

        let att = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();
        assert_eq!(att.name, "my photo (final).png", "DB display name must stay original");
        let rel = att.rel_path.as_ref().unwrap();
        assert!(
            !rel.contains(' ') && !rel.contains('(') && !rel.contains(')'),
            "stored rel_path must not contain spaces/parens: {rel}"
        );
        assert!(
            db::attachments_dir(temp.path()).join(rel).is_file(),
            "normalized path must exist on disk"
        );
    }

    #[test]
    fn link_url_allowlist_rejects_nonhttp_schemes() {
        // opener 로 흘러가는 link url 은 http(s) 만 허용 — 임의 scheme/UNC/relative 는 전부 거부.
        assert!(is_safe_link_url("http://example.com"));
        assert!(is_safe_link_url("https://example.com/a?b=c"));
        assert!(is_safe_link_url("  https://trimmed.example  "));
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "\\\\attacker\\share\\payload.exe",
            "ms-msdt:/id",
            "data:text/html,<script>",
            "ftp://example.com",
            "",
        ] {
            assert!(!is_safe_link_url(bad), "should reject: {bad:?}");
        }
    }

    #[test]
    fn read_text_roundtrips_footnote_and_gates_kind() {
        // 회귀: 각주 본문 프리뷰가 asset 프로토콜 fetch 로 읽다가 Windows scope 403 으로 전면
        // 실패했던 사고 — 본문은 이 IPC 경로로 읽는다(add_footnote 가 쓴 .md 를 그대로 반환).
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();

        let att = add_footnote(&mut conn, dir.path(), "note1", "각주 본문입니다", Some("앵커")).unwrap();
        let (text, _truncated) = read_text(&conn, dir.path(), &att.id).unwrap();
        assert_eq!(text, "각주 본문입니다");
        assert!(!_truncated, "상한 안쪽 파일이 잘렸다고 보고했다");

        // 텍스트 kind 가 아닌 첨부는 VALIDATION — 임의 파일을 텍스트로 끌어올리는 통로 금지.
        let link = add_link(&mut conn, "note1", "l", "https://example.com").unwrap();
        assert!(matches!(
            read_text(&conn, dir.path(), &link.id),
            Err(AppError::Validation(_))
        ));

        // 없는 id 는 NotFound.
        assert!(matches!(
            read_text(&conn, dir.path(), "nope"),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn rename_changes_display_name_only_and_guards_extension_kind_and_chars() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("main.py");
        std::fs::write(&src, "print(1)").unwrap();
        let a = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();
        let rel = a.rel_path.clone().unwrap();

        // 정상 — 표시 이름만 바뀌고 저장 파일·rel_path 는 그대로.
        let r = rename(&mut conn, &a.id, "  server.PY ").unwrap();
        assert_eq!(r.name, "server.PY");
        assert_eq!(r.rel_path.as_deref(), Some(rel.as_str()));
        assert!(db::attachments_dir(temp.path()).join(&rel).is_file());

        // 확장자 변경·빈 이름·구분자·제어문자 거부.
        for bad in ["server.txt", "server", "", "  ", "a/b.py", "a\\b.py", "a\nb.py"] {
            assert!(matches!(rename(&mut conn, &a.id, bad), Err(AppError::Validation(_))), "{bad:?}");
        }
        assert!(matches!(rename(&mut conn, "nope", "x.py"), Err(AppError::NotFound(_))));

        // 파일이 아닌 종류(link)는 거부.
        let l = add_link(&mut conn, "note1", "구글", "https://example.com").unwrap();
        assert!(matches!(rename(&mut conn, &l.id, "x"), Err(AppError::Validation(_))));
    }

    #[test]
    fn rename_keeps_the_same_named_source_linked() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("deck.pptx");
        std::fs::write(&src, b"x").unwrap();
        let a = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();
        conn.execute(
            "INSERT INTO sources(id, note_id, name, ext, body, position, truncated, created_at, updated_at) VALUES ('s1','note1','deck.pptx','pptx','본문',0,0,'t','t')",
            [],
        )
        .unwrap();
        rename(&mut conn, &a.id, "발표.pptx").unwrap();
        let n: String = conn.query_row("SELECT name FROM sources WHERE id='s1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, "발표.pptx", "첨부↔추출본 이름 결합이 끊기면 안 된다");
    }

    #[test]
    fn executable_exts_are_detected_case_insensitively() {
        assert!(is_executable_ext(Path::new("a/setup.EXE")));
        assert!(is_executable_ext(Path::new("run.bat")));
        // 스크립트(py/sh/…)는 코드 뷰어가 앱 안에서 보여주므로 OS 기본 앱 실행 대상에서 뺀다(폴더에서 보기로).
        assert!(is_executable_ext(Path::new("tool.py")));
        assert!(is_executable_ext(Path::new("run.SH")));
        assert!(!is_executable_ext(Path::new("notes.md")));
        assert!(!is_executable_ext(Path::new("noext")));
    }

    #[test]
    fn read_text_supports_expanded_text_formats() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();
        let files_dir = tempfile::tempdir().unwrap();

        let test_cases = [
            ("document.md", "# Markdown Title"),
            ("notes.txt", "Plain text content"),
            ("data.json", "{\"key\": \"value\"}"),
            ("table.csv", "id,name,value\n1,alpha,100"),
            ("app.log", "[INFO] 2026-08-25: server started"),
            ("subtitles.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello"),
            ("config.yaml", "app:\n  name: brise"),
            ("tool.py", "print(1)"),
            ("app.tsx", "export const a = 1;"),
            ("main.rs", "fn main() {}"),
        ];

        for (filename, content) in test_cases {
            let file_path = files_dir.path().join(filename);
            std::fs::write(&file_path, content).unwrap();

            let att = add_file(&mut conn, dir.path(), "note1", file_path.to_str().unwrap()).unwrap();
            let (read, _truncated) = read_text(&conn, dir.path(), &att.id).unwrap();
            assert_eq!(read, content, "read_text should succeed for {filename}");
        }
    }

    #[test]
    fn test_add_internal() {
        let mut conn = setup_db();

        let att_internal = add_internal(&mut conn, "note1", "note2", "link to target").unwrap();
        assert_eq!(att_internal.kind, "internal");
        assert_eq!(att_internal.url.as_deref(), Some("note2"));

        // 존재하지 않는 대상 노트로 internal 링크 시 NotFound.
        let bad = add_internal(&mut conn, "note1", "nonexistent", "x");
        assert!(matches!(bad, Err(AppError::NotFound(_))));
    }

    const SHEET_WITH_CHART: &str = r#"{"v":1,"rows":3,"cols":[{"w":80},{"w":80}],"cells":{"A1":{"raw":"x"},"B1":{"raw":"1"}},"charts":[{"id":"c1","type":"bar","title":"매출","series":["B1:B3"]}]}"#;

    fn seed_sheet_section(conn: &mut Connection, note_id: &str) -> String {
        crate::repo::sections::create_with_body_and_kind(
            conn,
            note_id,
            Some("sheet".into()),
            SHEET_WITH_CHART.to_string(),
            Some("sheet".into()),
        )
        .unwrap()
        .id
    }

    /// PLAN-2026-09-20 §2.3 W4 왕복: 추가 → 같은 url 재추가는 같은 행(멱등) → 섹션 삭제 후에도
    /// 행이 남는다(D8) → remove 가 지운다(파일 없음). 검증 세 갈래(다른 노트·시트 아님·없는 차트)는
    /// 각각 Validation/Validation/NotFound.
    #[test]
    fn add_chart_ref_roundtrip_is_idempotent_and_survives_section_delete() {
        let mut conn = setup_db();
        let sec_id = seed_sheet_section(&mut conn, "note1");
        // 삭제 가능하도록 두 번째 섹션(유일 섹션 삭제는 CONFLICT).
        crate::repo::sections::create(&mut conn, "note1", None).unwrap();

        let att = add_chart_ref(&conn, "note1", &sec_id, "c1", "매출").unwrap();
        assert_eq!(att.kind, "chart");
        assert_eq!(att.url.as_deref(), Some(format!("{sec_id}#c1").as_str()));
        assert_eq!(att.rel_path, None);
        assert_eq!(att.ext_path, None);

        // 멱등 — 두 번째 호출은 새 행을 만들지 않고 같은 id 를 돌려준다(이름이 달라도).
        let again = add_chart_ref(&conn, "note1", &sec_id, "c1", "다른 이름").unwrap();
        assert_eq!(again.id, att.id);
        assert_eq!(again.name, "매출", "기존 행의 이름이 유지된다");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE kind='chart'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);

        // 검증 갈래.
        assert!(matches!(
            add_chart_ref(&conn, "note2", &sec_id, "c1", "x"),
            Err(AppError::Validation(_))
        ), "다른 노트의 시트는 v1 천장");
        assert!(matches!(
            add_chart_ref(&conn, "note1", &sec_id, "nope", "x"),
            Err(AppError::NotFound(_))
        ), "charts[] 에 없는 id");
        let text_sec = crate::repo::sections::create(&mut conn, "note1", None).unwrap();
        assert!(matches!(
            add_chart_ref(&conn, "note1", &text_sec.id, "c1", "x"),
            Err(AppError::Validation(_))
        ), "sheet 가 아닌 섹션");
        assert!(matches!(
            add_chart_ref(&conn, "note1", "missing-section", "c1", "x"),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            add_chart_ref(&conn, "note1", &sec_id, "c1", "   "),
            Err(AppError::Validation(_))
        ), "빈 이름");

        // 갤러리: kinds=["chart"] 는 chart 만, 빈 kinds 는 chart 를 포함한다.
        let dir = tempfile::tempdir().unwrap();
        let only_chart = crate::repo::attachment_query::query(
            &conn,
            dir.path(),
            crate::repo::attachment_query::AttachmentQuery {
                kinds: vec!["chart".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_chart.items.len(), 1);
        assert_eq!(only_chart.items[0].kind, "chart");
        assert_eq!(only_chart.items[0].id, att.id);
        let all = crate::repo::attachment_query::query(
            &conn,
            dir.path(),
            crate::repo::attachment_query::AttachmentQuery::default(),
        )
        .unwrap();
        assert!(all.items.iter().any(|i| i.kind == "chart"), "전체 탭(kind <> 'internal')에 chart 포함");

        // attachment_open 은 인앱 전용이라 거부.
        assert!(matches!(open(&conn, dir.path(), &att.id), Err(AppError::Validation(_))));

        // D8: 섹션을 지워도 첨부 행은 남는다 — 프리뷰가 "원본 없음"을 그린다.
        crate::repo::sections::delete(&mut conn, &sec_id).unwrap();
        let still: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE id=?1", [&att.id], |r| r.get(0))
            .unwrap();
        assert_eq!(still, 1, "section delete must not cascade to the chart attachment");
        // 섹션이 사라졌으니 재등록은 NotFound — 행이 남아 있어도 새로 만들 수는 없다.
        assert!(matches!(
            add_chart_ref(&conn, "note1", &sec_id, "c1", "x"),
            Err(AppError::NotFound(_))
        ));

        // remove 는 url 행이라 파일 삭제 없이 행만 지운다(link/internal 과 같은 경로).
        assert!(remove(&mut conn, dir.path(), &att.id).unwrap());
        let gone: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE id=?1", [&att.id], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn test_open_rejects_internal() {
        let mut conn = setup_db();
        let att = add_internal(&mut conn, "note1", "note2", "ref").unwrap();
        // internal 은 attachment_open 대상이 아니다 → Validation.
        let temp = tempfile::tempdir().unwrap();
        assert!(matches!(
            open(&conn, temp.path(), &att.id),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn test_add_footnote_success() {
        let mut conn = setup_db();
        let temp_dir = tempfile::tempdir().unwrap();

        let att = add_footnote(
            &mut conn,
            temp_dir.path(),
            "note1",
            "footnote body text",
            Some("selected anchor"),
        )
        .unwrap();
        assert_eq!(att.kind, "footnote");
        assert_eq!(att.name, "selected anchor");
        assert_eq!(att.url.as_deref(), Some("selected anchor"));
        assert!(att.rel_path.is_some());
        let stored = std::fs::read_to_string(
            db::attachments_dir(temp_dir.path()).join(att.rel_path.as_ref().unwrap()),
        )
        .unwrap();
        assert_eq!(stored, "footnote body text");
        // content_hash filled like add_note
        let hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM attachments WHERE id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hash.as_deref(), Some(sha256_hex(b"footnote body text").as_str()));
    }

    #[test]
    fn test_add_footnote_empty_text_rejected() {
        let mut conn = setup_db();
        let temp_dir = tempfile::tempdir().unwrap();
        for empty in ["", "   ", "\n\t"] {
            assert!(
                matches!(
                    add_footnote(&mut conn, temp_dir.path(), "note1", empty, Some("a")),
                    Err(AppError::Validation(_))
                ),
                "should reject empty text: {empty:?}"
            );
        }
    }

    #[test]
    fn test_add_footnote_name_fallback_and_open_reject() {
        let mut conn = setup_db();
        let temp_dir = tempfile::tempdir().unwrap();
        // no anchor → name = "footnote", url = NULL
        let att = add_footnote(&mut conn, temp_dir.path(), "note1", "body", None).unwrap();
        assert_eq!(att.name, "footnote");
        assert_eq!(att.url, None);
        // blank anchor same as omit
        let att2 = add_footnote(&mut conn, temp_dir.path(), "note1", "body2", Some("  ")).unwrap();
        assert_eq!(att2.name, "footnote");
        assert_eq!(att2.url, None);
        // not OS-openable
        assert!(matches!(
            open(&conn, temp_dir.path(), &att.id),
            Err(AppError::Validation(_))
        ));
        // reader-view only for link
        assert!(matches!(
            link_url(&conn, &att.id),
            Err(AppError::Validation(_))
        ));
        // no thumbnail
        assert!(!wants_thumbnail(&att.kind, "md"));
    }

    #[test]
    fn test_footnote_survives_export_as_file_attachment() {
        // rel_path 있는 footnote 은 export_note 가 다른 파일 첨부와 같이 _files 로 복사한다.
        // (GFM [^n] 변환은 내보내기 상위 레이어 몫 — 여기서는 행+파일이 유실되지 않음만 고정.)
        // url=anchor_text 가 있어도 link 로 오인되지 않고 파일이 복사된다.
        let mut conn = setup_db();
        let temp_dir = tempfile::tempdir().unwrap();
        let att = add_footnote(
            &mut conn,
            temp_dir.path(),
            "note1",
            "export me",
            Some("anchor"),
        )
        .unwrap();
        let dest = temp_dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let result =
            crate::repo::transfer::export::export_note(&mut conn, temp_dir.path(), "note1", &dest.join("note.md"))
                .unwrap();
        assert!(std::path::Path::new(&result.written_path).is_file());
        // Scan export dest for any sidecar *_files copy of the footnote body.
        let mut found_body = false;
        for entry in std::fs::read_dir(&dest).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_dir() {
                continue;
            }
            for f in std::fs::read_dir(entry.path()).unwrap() {
                let f = f.unwrap();
                if let Ok(s) = std::fs::read_to_string(f.path()) {
                    if s == "export me" {
                        found_body = true;
                    }
                }
            }
        }
        assert!(
            found_body,
            "footnote .md body must be copied into export sidecar; att={att:?}"
        );
    }

    // Trash: 소프트 삭제(notes::delete)는 internal 링크를 건드리지 않는다(복구를 위해 보존) —
    // 이 정리는 완전 삭제(notes::purge, 구 notes::delete의 하드 삭제 로직)로 옮겨갔다.
    #[test]
    fn test_purge_target_note_removes_dangling_internal() {
        let mut conn = setup_db();
        // note1 이 note2 를 internal 링크로 참조.
        add_internal(&mut conn, "note1", "note2", "ref").unwrap();
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE kind='internal'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, 1);
        // 대상 note2 완전 삭제(purge) → 이를 가리키던 internal 링크도 제거되어야 한다.
        let temp = tempfile::tempdir().unwrap();
        crate::repo::notes::purge(&mut conn, temp.path(), "note2").unwrap();
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments WHERE kind='internal'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 0);
    }

    /// Write a solid-colour PNG larger than THUMB_MAX_SIDE so downscale is forced.
    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        img.save(path).unwrap();
    }

    #[test]
    fn add_file_image_writes_thumbnail_with_bounded_side() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("big.png");
        write_test_png(&src, 400, 300); // both sides > would-be tile; longest 400 > 256

        let att = add_file(
            &mut conn,
            temp.path(),
            "note1",
            src.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(att.kind, "image");
        let rel = att.rel_path.as_deref().expect("file attachment has rel_path");
        // 커맨드 계층과 같은 조합: add_file 은 DB 락 안에서 돌고, 썸네일은 락 밖에서 만든다.
        assert!(wants_thumbnail(&att.kind, "png"));
        ensure_thumb_for_attachment(temp.path(), rel).expect("thumbnail generated");
        let thumb_rel = thumb_rel_for(rel);
        let thumb_path = db::attachments_dir(temp.path()).join(
            super::super::paths::safe_rel(&thumb_rel).unwrap(),
        );
        assert!(
            thumb_path.is_file(),
            "expected thumbnail at {}",
            thumb_path.display()
        );

        let thumb = image::open(&thumb_path).unwrap();
        let (tw, th) = thumb.dimensions();
        assert!(
            tw.max(th) <= THUMB_MAX_SIDE,
            "thumb longest side {tw}x{th} exceeds {THUMB_MAX_SIDE}"
        );
        // Source was larger on the long edge — prove we actually downscaled.
        assert!(tw.max(th) < 400);
    }

    #[test]
    fn add_file_undecodable_image_still_succeeds_without_thumb() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("broken.png");
        std::fs::write(&src, b"this is not a png").unwrap();

        let att = add_file(
            &mut conn,
            temp.path(),
            "note1",
            src.to_str().unwrap(),
        )
        .expect("undecodable image must still attach");
        assert_eq!(att.kind, "image");
        let rel = att.rel_path.as_ref().unwrap();
        assert!(
            ensure_thumb_for_attachment(temp.path(), rel).is_none(),
            "corrupt source must not yield a thumbnail path"
        );
        let thumb_path = db::attachments_dir(temp.path()).join(
            super::super::paths::safe_rel(&thumb_rel_for(rel)).unwrap(),
        );
        assert!(!thumb_path.exists(), "corrupt source must not leave a thumb");
        // Original is on disk.
        let orig = db::attachments_dir(temp.path())
            .join(super::super::paths::safe_rel(rel).unwrap());
        assert!(orig.is_file());
    }

    #[test]
    fn remove_deletes_original_and_thumbnail() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("shot.png");
        write_test_png(&src, 320, 240);

        let att = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();
        let rel = att.rel_path.as_ref().unwrap().clone();
        ensure_thumb_for_attachment(temp.path(), &rel).expect("thumbnail generated");
        let att_root = db::attachments_dir(temp.path());
        let orig = att_root.join(super::super::paths::safe_rel(&rel).unwrap());
        let thumb = att_root.join(super::super::paths::safe_rel(&thumb_rel_for(&rel)).unwrap());
        assert!(orig.is_file());
        assert!(thumb.is_file());

        assert!(remove(&mut conn, temp.path(), &att.id).unwrap());
        assert!(!orig.exists(), "original must be removed");
        assert!(!thumb.exists(), "thumbnail must be removed with the attachment");
    }

    // G4(docs/SYNC.md): add_file 는 원본 복사와 같은 읽기 패스에서 SHA-256 을 계산해 저장해야
    // 한다 — 알려진 바이트열의 해시를 독립적으로(우리 sha256_hex 헬퍼를 거치지 않고 sha2 를 직접
    // 호출해) 계산한 값과 DB에 저장된 content_hash 가 일치하는지 검증한다.
    #[test]
    fn add_file_computes_and_stores_sha256_content_hash() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("known.bin");
        let bytes = b"brise sync phase 0 content hash test".to_vec();
        std::fs::write(&src, &bytes).unwrap();

        let att = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();

        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let expected: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();

        let stored: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM attachments WHERE id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, Some(expected));
    }

    /// link/internal 은 파일이 없으므로 content_hash 가 NULL 로 남아야 한다.
    #[test]
    fn add_link_and_internal_leave_content_hash_null() {
        let mut conn = setup_db();
        let link = add_link(&mut conn, "note1", "ref", "https://example.com").unwrap();
        let internal = add_internal(&mut conn, "note1", "note2", "ref2").unwrap();
        for id in [&link.id, &internal.id] {
            let stored: Option<String> = conn
                .query_row(
                    "SELECT content_hash FROM attachments WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, None);
        }
    }

    // G2(docs/SYNC.md): 하드 삭제(attachment_remove)는 같은 트랜잭션에서 deleted_rows 에
    // tombstone 을 남겨야 하고, 같은 id 가 재생성 후 다시 삭제되면 INSERT OR REPLACE 로
    // deleted_at 이 최신 시각으로 갱신되어야 한다(중복 행이 쌓이지 않고 정확히 하나 유지).
    #[test]
    fn remove_records_tombstone_and_redelete_refreshes_deleted_at() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("t.png");
        write_test_png(&src, 10, 10);

        let att = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();
        assert!(remove(&mut conn, temp.path(), &att.id).unwrap());

        let first_deleted_at: String = conn
            .query_row(
                "SELECT deleted_at FROM deleted_rows WHERE tbl='attachments' AND id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();

        // 같은 id 로 재생성(예: import 복원) 후 다시 삭제.
        std::thread::sleep(std::time::Duration::from_millis(5));
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, size_bytes, position, created_at)
             VALUES (?1, 'note1', 'x.png', 'image', 'note1/x.png', 1, 0, ?2)",
            params![att.id, now_iso()],
        )
        .unwrap();
        assert!(remove(&mut conn, temp.path(), &att.id).unwrap());

        let second_deleted_at: String = conn
            .query_row(
                "SELECT deleted_at FROM deleted_rows WHERE tbl='attachments' AND id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            second_deleted_at > first_deleted_at,
            "re-delete must refresh deleted_at"
        );

        // PRIMARY KEY (tbl, id) 위의 REPLACE — 중복 누적이 아니라 정확히 한 행이어야 한다.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deleted_rows WHERE tbl='attachments' AND id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    /// 참조 첨부의 계약 전부를 한 번에 못박는다: 복사하지 않는다 · 크기 상한이 없다 ·
    /// content_hash 를 채우지 않는다 · **삭제가 사용자의 원본을 지우지 않는다**(가장 중요) ·
    /// 원본이 사라지면 열기가 NotFound 로 끝난다(패닉/500 아님).
    /// 32MB 경계가 복사/참조를 가른다. 이 판정이 add_file_from_disk 한 곳에만 있어야 한다 —
    /// 예전에는 sources.rs 만 크기를 봐서, 같은 파일이 노트에 끌어다 놓으면 복사되고 사료로
    /// 넣으면 참조되는 식으로 갈렸다.
    #[test]
    fn size_alone_decides_copy_or_reference_at_one_place() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();

        let small = dir.path().join("small.bin");
        std::fs::write(&small, vec![0u8; 1024]).unwrap();
        let a = add_file_from_disk(&mut conn, dir.path(), "note1", small.to_str().unwrap(), None)
            .unwrap();
        assert!(a.rel_path.is_some() && a.ext_path.is_none(), "작은 파일은 복사되어야 한다");

        let big = dir.path().join("big.bin");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(REF_THRESHOLD_BYTES + 1).unwrap();
        drop(f);
        let b = add_file_from_disk(&mut conn, dir.path(), "note1", big.to_str().unwrap(), None)
            .unwrap();
        assert!(
            b.ext_path.is_some() && b.rel_path.is_none(),
            "임계값을 넘으면 복사하지 않고 참조해야 한다"
        );
        assert!(big.is_file(), "참조가 원본을 옮기거나 지웠다");
        // 앱 폴더에 그 바이트가 없어야 한다 — 참조의 요점이 복사 회피다.
        let copied_into_app = db::attachments_dir(dir.path()).join("note1").join("big.bin");
        assert!(!copied_into_app.exists(), "참조인데 앱 폴더로 복사됐다");
    }

    /// 프리뷰 상한을 넘는 텍스트는 **거부가 아니라 절단**이다. 예전에는 VALIDATION 이라 2MB 짜리
    /// 로그가 첫 화면조차 안 보였다. 잘렸다는 사실을 함께 돌려주지 않으면 사용자가 전체를 봤다고
    /// 믿으므로, 플래그가 계약의 일부다.
    #[test]
    fn oversized_text_is_truncated_not_refused() {
        let mut conn = setup_db();
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("huge.log");
        // 한글로 채운다 — 상한 경계에서 멀티바이트가 잘려도 죽지 않아야 한다.
        let body = "가나다라마바사".repeat((MAX_TEXT_READ_BYTES as usize) / 3);
        std::fs::write(&src, &body).unwrap();
        assert!(
            std::fs::metadata(&src).unwrap().len() > MAX_TEXT_READ_BYTES,
            "픽스처가 상한을 넘겨야 이 테스트가 의미가 있다"
        );

        let att = add_file(&mut conn, dir.path(), "note1", src.to_str().unwrap()).unwrap();
        let (text, truncated) = read_text(&conn, dir.path(), &att.id).unwrap();
        assert!(truncated, "상한을 넘겼는데 잘렸다고 알리지 않았다");
        assert!(!text.is_empty(), "앞부분조차 돌려주지 않았다 — 옛 거부 동작이 살아 있다");
        assert!(text.len() as u64 <= MAX_TEXT_READ_BYTES);
        assert!(body.starts_with(&text[..text.len().min(21)]), "앞부분이 원문과 다르다");
    }

    #[test]
    fn ref_attachment_never_copies_and_remove_keeps_the_original() {
        let mut conn = setup_db();
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap(); // 앱 폴더 밖 — 사용자의 폴더
        let src = outside.path().join("huge deck.pptx");
        std::fs::write(&src, b"pretend this is a gigabyte").unwrap();

        let att = add_file_ref(&mut conn, "note1", src.to_str().unwrap()).unwrap();
        assert_eq!(att.rel_path, None, "참조는 rel_path 를 갖지 않는다");
        assert_eq!(att.ext_path.as_deref(), Some(src.to_str().unwrap()));
        assert_eq!(att.name, "huge deck.pptx", "표시 이름은 원본 그대로");
        assert_eq!(att.size_bytes, Some(26));
        // 앱 폴더에는 아무것도 만들지 않는다.
        assert!(
            !db::attachments_dir(data.path()).join("note1").exists(),
            "참조는 보관소에 파일을 만들지 않는다"
        );
        // 1GB 를 추가 시점에 해싱하지 않는다.
        let hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM attachments WHERE id=?1",
                [&att.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hash, None);
        // 경로 해석은 한 함수를 지난다.
        assert_eq!(
            file_path_of(data.path(), att.rel_path.as_deref(), att.ext_path.as_deref()),
            Some(src.clone())
        );
        // 열기는 원본을 가리킨다.
        assert!(matches!(
            open(&conn, data.path(), &att.id).unwrap(),
            OpenTarget::File(p) if p == src
        ));

        // ── 핵심: 첨부를 지워도 사용자의 원본은 그대로 있다 ──
        assert!(remove(&mut conn, data.path(), &att.id).unwrap());
        assert!(src.is_file(), "참조 첨부 삭제가 사용자의 원본을 지웠다");

        // 원본이 사라진 뒤의 열기는 NotFound(정상 경로) — 패닉도 500 도 아니다.
        let att2 = add_file_ref(&mut conn, "note1", src.to_str().unwrap()).unwrap();
        std::fs::remove_file(&src).unwrap();
        assert!(matches!(
            open(&conn, data.path(), &att2.id),
            Err(AppError::NotFound(_))
        ));
    }

    /// 설정의 "참조만" 모드(attachment_storage_mode="reference")가 실제로 저장된다 — V80 이전에는
    /// url=file:// 로 넣어 CHECK 위반으로 조용히 실패하던 경로다. 붙여넣기/원격 업로드가 쓰는
    /// add_file 은 이 설정과 무관하게 계속 복사한다(원본이 OS temp 라 참조하면 안 된다).
    #[test]
    fn storage_mode_reference_stores_ext_path_only_for_on_disk_originals() {
        let mut conn = setup_db();
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let src = outside.path().join("doc.txt");
        std::fs::write(&src, b"hi").unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('attachment_storage_mode', '\"reference\"')",
            [],
        )
        .unwrap();

        let att =
            add_file_from_disk(&mut conn, data.path(), "note1", src.to_str().unwrap(), None).unwrap();
        assert!(att.ext_path.is_some() && att.rel_path.is_none());

        let copied = add_file(&mut conn, data.path(), "note1", src.to_str().unwrap()).unwrap();
        assert!(copied.rel_path.is_some() && copied.ext_path.is_none());
    }

    #[test]
    fn attachment_thumbs_backfills_missing_thumbnail() {
        let mut conn = setup_db();
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("old.png");
        write_test_png(&src, 300, 300);

        let att = add_file(&mut conn, temp.path(), "note1", src.to_str().unwrap()).unwrap();
        let rel = att.rel_path.as_ref().unwrap().clone();
        ensure_thumb_for_attachment(temp.path(), &rel).expect("thumbnail generated");
        let att_root = db::attachments_dir(temp.path());
        let thumb_path = att_root.join(super::super::paths::safe_rel(&thumb_rel_for(&rel)).unwrap());
        assert!(thumb_path.is_file());
        // Simulate pre-feature attachment: row exists, thumb file gone.
        std::fs::remove_file(&thumb_path).unwrap();
        assert!(!thumb_path.exists());

        // Same composition as the command: read under "lock", then ensure without DB.
        let candidates = thumb_candidates(&conn, "note1").unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, att.id);

        let mut thumbs = Vec::new();
        for (id, rel_path) in candidates {
            if let Some(thumb_rel) = ensure_thumb_for_attachment(temp.path(), &rel_path) {
                thumbs.push((id, thumb_rel));
            }
        }
        assert_eq!(thumbs.len(), 1);
        assert_eq!(thumbs[0].0, att.id);
        assert_eq!(thumbs[0].1, thumb_rel_for(&rel));
        assert!(thumb_path.is_file(), "backfill must recreate the thumbnail");
    }

    // ── P0 (docs/AUDIT-2026-09-26-fallback-observability.md §1): 고아 첨부 청소는 절대 삭제하지
    // 않는다 — DB 손상 → 옛 백업 자동 복구 → 그 복구된(옛) DB 기준 청소가 스냅샷 이후 만든 노트의
    // 첨부를 영구 삭제하던 사고의 재발 방지. ──────────────────────────────────────────────

    /// (a) 평범한 고아 디렉토리는 삭제가 아니라 보관함으로 이동되고, 이동 후에도 읽을 수 있다.
    #[test]
    fn orphan_cleanup_moves_dead_note_dir_to_holding_and_stays_readable() {
        let conn = setup_db(); // note1, note2 만 알려진 note_id
        let data = tempfile::tempdir().unwrap();
        let att_root = db::attachments_dir(data.path());
        let ghost = att_root.join("ghost-note-id");
        std::fs::create_dir_all(&ghost).unwrap();
        std::fs::write(ghost.join("photo.png"), b"orphan bytes").unwrap();

        orphan_cleanup(&conn, data.path()).unwrap();

        assert!(!ghost.exists(), "orphan dir must be gone from its live location");
        let held = crate::repo::orphan_hold::hold_dir(data.path());
        let batch = std::fs::read_dir(&held)
            .unwrap()
            .next()
            .expect("orphan_cleanup must create a holding batch")
            .unwrap()
            .path();
        let moved = batch.join(db::ATTACHMENTS_DIR).join("ghost-note-id").join("photo.png");
        assert_eq!(
            std::fs::read(&moved).unwrap(),
            b"orphan bytes",
            "moved file must still be readable with its original content: {}",
            moved.display()
        );
    }

    /// (b) DB 손상 복구 시나리오: 노트 A(DB 안, 살아있음)와 노트 B(첨부 디렉토리만 있음 — 롤백
    /// 뒤 첨부가 옛 DB엔 없는 노트를 흉내)를 만들고, brise.corrupt-x.db 격리 파일을 둔 채 스윕을
    /// "부팅" 세 번(최초 1회 + 2회 더) 반복해도 B의 파일이 보관함에서 사라지지 않아야 한다 —
    /// 격리 파일이 있는 한 30일 경과 배치도 회수(purge)가 전부 보류되기 때문(§P0).
    #[test]
    fn orphan_cleanup_survives_repeated_boots_after_restore_while_quarantine_file_exists() {
        let conn = setup_db(); // note1 은 살아있는 것으로 취급(known_ids 에 포함)
        let data = tempfile::tempdir().unwrap();
        let att_root = db::attachments_dir(data.path());

        // 노트 A: DB 에 있는 첨부 디렉토리(살아있음) — 청소되면 안 된다.
        let a_dir = att_root.join("note1");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::write(a_dir.join("a.png"), b"note A bytes").unwrap();

        // 노트 B: 롤백으로 DB엔 없지만 디렉토리는 남은 "생존자".
        let b_dir = att_root.join("note-b-post-snapshot");
        std::fs::create_dir_all(&b_dir).unwrap();
        std::fs::write(b_dir.join("b.png"), b"note B bytes").unwrap();

        // 복구 흔적: 격리 DB 파일.
        std::fs::write(data.path().join("brise.corrupt-sim.db"), b"quarantined").unwrap();

        // 부팅 1: 스윕이 B 를 고아로 오판해 보관함으로 옮긴다.
        orphan_cleanup(&conn, data.path()).unwrap();
        assert!(a_dir.join("a.png").is_file(), "note A's live dir must survive (still known to the DB)");
        assert!(!b_dir.exists(), "note B's dir must be gone from its live location after boot 1");

        // 보관함에 실제로 착지했는지 확인하고, 배치 이름을 30일 전으로 바꿔 "그때 이후 부팅이
        // 여러 번 더 있었다"를 흉내낸다.
        let held = crate::repo::orphan_hold::hold_dir(data.path());
        let batches: Vec<_> = std::fs::read_dir(&held)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        assert_eq!(batches.len(), 1, "boot 1 must create exactly one holding batch");
        let old_batch = held.join("20200101-000000");
        std::fs::rename(&batches[0], &old_batch).unwrap();
        let b_in_holding = old_batch.join(db::ATTACHMENTS_DIR).join("note-b-post-snapshot").join("b.png");
        assert!(b_in_holding.is_file(), "note B's file must be in the (now aged) holding batch");

        // 부팅 2, 3: 격리 파일이 여전히 있으므로 30일 지난 배치라도 회수(purge)가 보류되어야 한다.
        orphan_cleanup(&conn, data.path()).unwrap();
        orphan_cleanup(&conn, data.path()).unwrap();

        assert!(
            b_in_holding.is_file(),
            "note B's file must still exist in holding after two more boots — quarantine file blocks purge"
        );
    }
}
