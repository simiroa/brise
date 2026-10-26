use crate::db::{self, migrations};
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::repo::notes;
use crate::util::now_iso;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

use super::render::{attachment_file_names, render_md, slugify, unique_filename, AttachmentLinks};
use super::reset::copy_dir_all;
use crate::models::NoteDetail;

// 번들 wire-format 구조체는 bundle.rs SSOT — transfer::mod.rs의 `pub use export::{Bundle, ...}`
// 가 계속 통하도록 여기서 재수출한다(외부에서 보던 `export::Bundle` 경로 유지).
pub use super::bundle::{
    AttachmentRow, Bundle, CalendarMarkHideRow, FolderRow, KvRow, NoteDateRow, NoteRegionRow, NoteRelatedExclusionRow,
    NoteRow, NoteTagRow, RoutineCompletionRow, SectionRow, SourceRow, SpaceItemRow, SpaceRow,
    TagRow, TimelineRoutineRow, WorkspaceEraRow, WorkspaceRegionRow, WorkspaceRow,
    WorkspaceSettingRow, WorkspaceStatusRow,
};

/// Load footnote attachment file bodies for GFM export rewrite. Missing files are skipped
/// (those anchors become plain text in `apply_footnotes_to_markdown`).
fn load_footnote_bodies(data_dir: &Path, detail: &NoteDetail) -> Vec<(String, String)> {
    let root = db::attachments_dir(data_dir);
    let mut out = Vec::new();
    for att in &detail.attachments {
        if att.kind != "footnote" {
            continue;
        }
        // 첨부 루트 밖 파일의 내용을 내보내기에 싣지 않는다(write_note_md 의 첨부 복사와 같은 관문 — paths::file_inside).
        let Some(path) = att.rel_path.as_deref().and_then(|rel| crate::repo::paths::file_inside(&root, rel)) else {
            crate::diag::warn("export", "footnote_body_unreadable", format!("attachment {}: missing or outside the attachment root", att.id));
            continue;
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => out.push((att.id.clone(), text)),
            // 함정 11: 그 각주 표시는 글자로만 남는다 — 기록은 남긴다(경로·본문 없이 첨부 id 만).
            Err(e) => crate::diag::warn("export", "footnote_body_unreadable", format!("attachment {}: {:?}", att.id, e.kind())),
        }
    }
    out
}

/// Settings keys that must never travel inside an export bundle. The bundle is written as a
/// plaintext JSON file on disk (and typically synced to a cloud drive or handed to someone else),
/// so any secret in it is effectively leaked. Mirrors the secret-typed keys in
/// `settings_schema::default_settings` — add new secrets here the moment they're introduced.
pub(crate) fn is_secret_setting_key(key: &str) -> bool {
    // sync_token (동기화(beta) 임베디드 서버 인증 토큰) — bearer/query-param 인증의 유일한 비밀.
    // 평문 그대로 export 번들이나 백업 zip에 실리면 그 파일을 손에 넣은 누구든 같은 tailnet에서
    // 이 설치본의 서버를 그대로 조회할 수 있다.
    // capture_ingest_token (크롬 익스텐션 ingest 리스너 bearer) — sync_token 과 같은 이유.
    // ai_provider_creds (비활성 프로바이더들의 키 보관함, settings_schema 주석) — ai_api_key 와 같은 비밀.
    matches!(key, "ai_api_key" | "ai_provider_creds" | "sync_token" | "capture_ingest_token")
}

/// Sync Phase 0 G3: `device_id` identifies *this* physical install, not the notes it holds — a
/// restored backup must keep the device it's being restored onto, not adopt the source device's
/// id. It's also not in `validate_setting`'s allow-list (repo::settings::ensure_device_id writes
/// it directly, bypassing settings_set), so import's fail-closed validation would reject the
/// whole bundle if this key ever traveled inside it. Excluded here rather than added to
/// validate_setting, since it must stay unreachable from settings_set either way.
/// sync_enabled/sync_port/sync_token: 동기화(beta) 임베디드 서버 설정도 device_id 와 같은 이유로
/// 로컬 전용이다 — 이 기기의 서버 on/off·포트·토큰을 다른 기기(bundle을 받는 쪽)나 이 기기의
/// 미래 상태(백업 복원)로 그대로 옮기면 안 된다. sync_token 은 is_secret_setting_key 에도 이미
/// 있다(export 번들에서는 두 필터 중 하나만 걸려도 제외되지만, backup.rs 의 zip 스테이징은
/// is_secret_setting_key 만 본다 — 여기 추가한 이유는 restore 이후 sync_enabled/sync_port까지
/// 정리하는 backup.rs::backup_restore 쪽 로직과 짝을 맞추기 위함).
/// search_recent (QA8 Wave 3A): query history is content-adjacent — a notebook handed to someone
/// else must not carry the previous owner's search terms. Frontend-owned LRU list; exclude from
/// export bundle / restore the same way as sync_* device-local keys.
/// recent_closed_tabs (QA8 Wave 4A): session convenience for "reopen closed tab" — device-local,
/// not notebook content. activity_log itself is a table (not a settings key) and is never walked
/// by dump()/export column lists (notes→sections/sources/attachments only) — same device-local
/// posture as note_snapshots.
pub(crate) fn is_device_local_setting_key(key: &str) -> bool {
    matches!(
        key,
        "device_id"
            | "sync_enabled"
            | "sync_port"
            | "sync_token"
            | "search_recent"
            | "recent_closed_tabs"
            // 캡처 ingest 리스너(크롬 익스텐션) — sync_* 3종과 완전히 같은 이유로 기기 로컬이다:
            // 이 기기의 loopback 서버 on/off·포트·토큰이 다른 기기로 따라가면 안 된다.
            | "capture_clip_enabled"
            | "capture_ingest_port"
            | "capture_ingest_token"
            // 화면 저장 폴더 — 이 기기 파일시스템 경로다. 번들을 받는 쪽에선 없는 경로고(사용자명이
            // 든 경로를 남에게 넘기기도 한다), remote_policy 가 원격 쓰기를 막는 것과 같은 이유.
            | "capture_screenshot_dir"
    )
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub written_path: String,
    pub exported_at: String,
}

#[derive(Debug, Serialize)]
pub struct ExportFolderResult {
    pub exported_count: i64,
    /// 쓰지 못해 건너뛴 노트 수(휴지통 노트는 처음부터 대상이 아니라 세지 않는다). 사유는 진단 기록에 남는다.
    pub skipped_count: i64,
    pub written_dir: String,
}

/// 폴더 단위 Markdown 내보내기 — `dest_dir` 아래 새 폴더(`{폴더 슬러그}`, 있으면 `-1`·`-2` …) 안에 노트마다 `{노트 슬러그}.md`
/// (+ 파일 첨부가 있으면 `{그 파일 stem}_files/`). Markdown 만이다(W6 오너 결정 2026-10-08: 폴더 단위 HTML 은 쓸 일이 없다).
/// 노트마다 `write_note_md` 에 **파일 경로**를 넘긴다 — 같은 제목은 `unique_filename` 이 ` (2)` 를 붙이고, 첨부 폴더는 그 이름을 따른다.
/// 한 노트가 실패해도 나머지는 계속 쓴다(실패는 진단 기록에 남기고 `skipped_count` 로 올린다).
///
/// DB 잠금은 노트 상세를 읽는 동안과 `exported_at` 을 찍는 마지막 순간에만 쥔다 — 첨부 복사(`std::fs::copy`)와 파일 쓰기는
/// 잠금 밖이다(L-2: 예전엔 폴더 전체 동안 `state.db` 를 쥐고 메인 스레드에서 돌았다).
/// 휴지통 노트는 건너뛴다(R-1 — `dump_folder` 와 같은 이유: 지운 노트가 내보내기에 되살아나면 안 된다).
pub fn export_folder_shared(
    db: &Mutex<Connection>,
    data_dir: &Path,
    id: &str,
    dest_dir: &Path,
) -> AppResult<ExportFolderResult> {
    export_folder_with(&mut { db }, data_dir, id, dest_dir)
}

/// 이미 `Connection` 을 쥔 호출자용 — `export_folder_shared` 와 같은 일(앱 커맨드는 `_shared`).
pub fn export_folder(conn: &mut Connection, data_dir: &Path, id: &str, dest_dir: &Path) -> AppResult<ExportFolderResult> {
    export_folder_with(conn, data_dir, id, dest_dir)
}

/// DB 를 "쓸 때마다 잠깐 빌리는" 것으로 추상화 — `Connection` 은 그대로, `&Mutex<Connection>` 은 그때그때 잠근다.
trait Db {
    fn run<R>(&mut self, f: impl FnOnce(&mut Connection) -> R) -> R;
}
impl Db for Connection {
    fn run<R>(&mut self, f: impl FnOnce(&mut Connection) -> R) -> R {
        f(self)
    }
}
impl Db for &Mutex<Connection> {
    fn run<R>(&mut self, f: impl FnOnce(&mut Connection) -> R) -> R {
        f(&mut self.lock())
    }
}

fn export_folder_with<D: Db>(db: &mut D, data_dir: &Path, id: &str, dest_dir: &Path) -> AppResult<ExportFolderResult> {
    let (folder_name, note_ids): (String, Vec<String>) = db.run(|conn| -> AppResult<_> {
        let folder_name: String = conn
            .query_row("SELECT name FROM folders WHERE id=?1", [id], |r| r.get(0))
            .map_err(dberr)?;
        let mut stmt = conn
            .prepare("SELECT id FROM notes WHERE folder_id=?1 AND deleted_at IS NULL")
            .map_err(dberr)?;
        let note_ids: Vec<String> = stmt
            .query_map([id], |r| r.get(0))
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        Ok((folder_name, note_ids))
    })?;
    let base = slugify(&folder_name);
    // 폴더의 경우 ext 없이 unique 처리
    let mut out_dir_name = base.clone();
    let mut i = 1;
    while dest_dir.join(&out_dir_name).exists() {
        out_dir_name = format!("{base}-{i}");
        i += 1;
    }
    let out_dir = dest_dir.join(&out_dir_name);
    std::fs::create_dir_all(&out_dir).map_err(io)?;

    let mut exported: Vec<(String, String)> = Vec::new(); // (note_id, exported_at)
    let mut skipped_count = 0;
    for note_id in &note_ids {
        let detail = db.run(|conn| notes::note_detail(conn, note_id));
        let written = detail.and_then(|detail| {
            let file = out_dir.join(unique_filename(&out_dir, &slugify(&detail.note.title), "md"));
            write_note_md(data_dir, &detail, &file)
        });
        match written {
            Ok(r) => exported.push((note_id.clone(), r.exported_at)),
            // 함정 11: 건너뛴 노트는 기록한다(제목·경로는 남기지 않는다 — id 와 오류 종류만).
            Err(e) => {
                skipped_count += 1;
                crate::diag::warn("export", "folder_note_skipped", format!("note {note_id}: {}", e.code()));
            }
        }
    }
    db.run(|conn| -> AppResult<()> {
        for (note_id, at) in &exported {
            mark_exported(conn, note_id, at)?;
        }
        Ok(())
    })?;

    Ok(ExportFolderResult {
        exported_count: exported.len() as i64,
        skipped_count,
        written_dir: out_dir.to_string_lossy().to_string(),
    })
}

/// 노트 전체 → Markdown 파일. `dest_path` 는 저장 대화상자가 고른 **파일 경로**다(W6 결함 수정 — 예전엔 폴더로 취급해
/// `x.md/{슬러그}.md` 를 만들었다). 첨부는 그 파일 옆 `{파일 stem}_files/`. 성공하면 `exported_at` 을 찍는다.
/// DB 잠금은 상세를 읽을 때와 `exported_at` 을 찍을 때만(첨부 복사 동안은 놓는다 — L-2).
pub fn export_note_shared(
    db: &Mutex<Connection>,
    data_dir: &Path,
    id: &str,
    dest_path: &Path,
) -> AppResult<ExportResult> {
    export_note_with(&mut { db }, data_dir, id, dest_path)
}

/// 이미 `Connection` 을 쥔 호출자용 — `export_note_shared` 와 같은 일(앱 커맨드는 `_shared`).
pub fn export_note(conn: &mut Connection, data_dir: &Path, id: &str, dest_path: &Path) -> AppResult<ExportResult> {
    export_note_with(conn, data_dir, id, dest_path)
}

fn export_note_with<D: Db>(db: &mut D, data_dir: &Path, id: &str, dest_path: &Path) -> AppResult<ExportResult> {
    check_export_note_dest(dest_path)?;
    let detail = db.run(|conn| notes::note_detail(conn, id))?; // NOT_FOUND
    let out = write_note_md(data_dir, &detail, dest_path)?;
    db.run(|conn| mark_exported(conn, &detail.note.id, &out.exported_at))?;
    Ok(out)
}

/// W6 에서 format 인자가 없어졌다 — Tauri 는 모르는 인자를 조용히 버리므로, 옛 호출(`format: "html"`, `x.html`)이 오면
/// 마크다운이 .html 파일에 조용히 쓰인다. 그 경로만은 크게 실패시킨다(읽히는 HTML 은 export_html).
fn check_export_note_dest(dest_path: &Path) -> AppResult<()> {
    if matches!(dest_ext_lower(dest_path).as_deref(), Some("html" | "htm")) {
        return Err(AppError::Validation("export_note writes Markdown only — use export_html for .html".into()));
    }
    Ok(())
}

fn mark_exported(conn: &mut Connection, note_id: &str, at: &str) -> AppResult<()> {
    conn.execute("UPDATE notes SET exported_at=?1 WHERE id=?2", params![at, note_id])
        .map_err(dberr)?;
    Ok(())
}

/// `export_note`·`export_folder` 공용 본체 — 노트 하나를 `dest_file`(**파일 경로**)에 쓴다.
///
/// 파일 첨부는 `dest_file` 옆 첨부 폴더(`attachment_dir_name` — 보통 `{파일 stem}_files/`)로 복사하고, 그 폴더 이름과 복사한 파일
/// 이름을 **여기서 정해** `render_md` 에 넘긴다(렌더러가 따로 계산하면 어긋난다). 파일 이름은 `attachment_file_names` 한 목록이라
/// 디스크 상태와 무관하다 — 그래서 **덮어써도 되는 폴더만** 고른다: 이 내보내기가 바꾸는 `.md` 가 가리키던 폴더(같은 파일로 다시
/// 내보내기 — 복사본이 ` (2)` 로 쌓이지 않는다)이거나 아직 없는 폴더. 원본이 없는 첨부는 복사하지 않고 링크 없이 이름만 적는다.
/// 마크다운은 tmp→rename(`write_atomic`). DB 는 건드리지 않는다.
fn write_note_md(data_dir: &Path, detail: &NoteDetail, dest_file: &Path) -> AppResult<ExportResult> {
    let stem = dest_file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Validation("dest_path has no file name".into()))?;
    if dest_file.is_dir() {
        return Err(AppError::Validation("dest_path is a folder, not a file".into()));
    }
    let parent = dest_file.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let now = now_iso();

    // 첨부 복사 (파일 첨부만).
    // 폴더는 실제로 복사할 첨부가 있을 때만 만든다(빈 `_files` 를 남기지 않는다). 이름은 바꾸기 전의 `.md` 를 보고 정하므로
    // write_atomic 보다 먼저다.
    let replaced_md = if dest_file.is_file() { std::fs::read_to_string(dest_file).ok() } else { None };
    let files_dir_name = attachment_dir_name(parent, &stem, replaced_md.as_deref());
    let files_dir = parent.join(&files_dir_name);
    let att_root = db::attachments_dir(data_dir);
    let mut copied: HashMap<String, String> = HashMap::new();
    for (att, name) in attachment_file_names(&detail.attachments) {
        // rel_path 는 가져오기에서 이미 검증된다(R5) — 그래도 첨부 루트 밖 파일을 내보내기 폴더로 복사하는 일이 없게 한 번 더 막는다
        // (문자열 검사 + 디스크의 정규화 경로 — paths::file_inside). 원본이 없어도 여기서 빠진다.
        let Some(src) = att.rel_path.as_deref().and_then(|rel| crate::repo::paths::file_inside(&att_root, rel)) else {
            // 함정 11: 그 첨부는 링크 없이 이름만 남는다 — 기록은 남긴다(경로 없이 첨부 id 만).
            crate::diag::warn("export", "attachment_not_copied", format!("attachment {}: missing or outside the attachment root", att.id));
            continue;
        };
        std::fs::create_dir_all(&files_dir).map_err(io)?;
        // 결과를 버리면 예약명 충돌/디스크풀 시 export 는 성공을 보고하나 링크가 dangling 된다.
        std::fs::copy(&src, files_dir.join(&name)).map_err(io)?;
        copied.insert(att.id.clone(), name);
    }

    // Load footnote .md bodies for GFM rewrite in render_md (storage stays attachment rows).
    let footnote_bodies = load_footnote_bodies(data_dir, detail);
    let links = AttachmentLinks { dir: &files_dir_name, names: &copied };
    let content = render_md(detail, &now, &footnote_bodies, &links);
    let written_path = write_atomic(dest_file, content.as_bytes(), "md")?;

    // `exported_at` 은 여기서 찍지 않는다 — DB 잠금을 쥔 채 파일을 복사하지 않도록 호출자가 잠금을 다시 잡아 찍는다(`mark_exported`).
    Ok(ExportResult {
        written_path,
        exported_at: now,
    })
}

/// Markdown 옆 첨부 폴더 이름 — `{stem}_files`, 이미 있으면 `{stem}_files-1`·`-2` …(export_folder 의 폴더 이름과 같은 규칙).
///
/// 이미 있는 폴더는 **바꾸는 `.md`(`replaced_md`)가 그 폴더를 가리킬 때만** 다시 쓴다(W6 검증 V1). 저장 대화상자가 확인하는 건
/// `.md` 한 파일을 바꾸는 일뿐이라, `x.md` 없이 남아 있는 `x_files/`(브라우저 "웹 페이지 전체 저장"이 만드는 바로 그 이름)나
/// 남의 `x.md` 옆 폴더의 같은 이름 파일을 조용히 덮어쓰면 안 된다. 링크는 `](폴더/` 로 시작하므로 그 문자열로 본다.
fn attachment_dir_name(parent: &Path, stem: &str, replaced_md: Option<&str>) -> String {
    let base = format!("{stem}_files");
    let mut name = base.clone();
    let mut i = 1;
    loop {
        let path = parent.join(&name);
        if !path.exists() {
            return name;
        }
        if path.is_dir() && replaced_md.is_some_and(|md| md.contains(&format!("]({name}/"))) {
            return name;
        }
        name = format!("{base}-{i}");
        i += 1;
    }
}

#[derive(Debug, Serialize)]
pub struct ExportPngResult {
    pub written_path: String,
}

/// 관계도 PNG 를 저장 다이얼로그가 고른 경로에 쓴다 — DB 도 data_dir 도 읽지 않는 유일한 export.
/// 래스터는 프론트(html-to-image)가 이미 만들었고, 여기가 하는 일은 디코딩 + 쓰기뿐이다.
///
/// 디코딩은 commands::attachments::attachment_add_bytes 와 같은 엔진/같은 에러 매핑(STANDARD,
/// 실패 시 VALIDATION — 잘린 data URL 이나 prefix 를 같이 보낸 호출은 여기서 걸린다). 쓰기는
/// export_note 와 같은 tmp→rename 이라, 디스크가 차거나 프로세스가 죽어도 사용자가 고른 기존
/// 파일이 반쯤 덮인 채로 남지 않는다.
/// 저장 다이얼로그가 고른 경로에 바이트를 원자적으로 쓴다 — 같은 볼륨의 옆자리 임시 파일에 쓴 뒤
/// rename 하므로, 디스크가 차거나 프로세스가 죽어도 사용자가 고른 기존 파일이 반쯤 덮인 채로
/// 남지 않는다. export_diagram_png / export_sheet_csv / export_section_md / export_hwpx·docx·html / export_note(W6 부터 —
/// 그 전엔 dest 를 폴더로 받아 따로 썼다) 공용 — 같은 12줄을 각자 복제하고 있었다.
/// 부모 디렉토리 생성은 저장 다이얼로그 경로라 사실상 no-op 이지만, tmp 파일이 목적지 **옆**에
/// 떨어져야 rename 이 같은 볼륨 안에서 원자적이므로 경로 계산을 여기서 한 번에 한다.
/// 저장 경로의 확장자(소문자) — Windows 처럼 파일 이름 끝의 `.`·공백은 떼고 본다(`a.html.` 은 디스크에 `a.html` 로 생긴다).
/// 확장자 검사(export_note 의 .html 거절, export_html 의 .html 요구)가 같은 규칙으로 판정해야 우회가 안 된다.
pub(crate) fn dest_ext_lower(dest_path: &Path) -> Option<String> {
    let name = dest_path.file_name()?.to_str()?.trim_end_matches(['.', ' ']);
    Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase)
}

pub(crate) fn write_atomic(dest_path: &Path, bytes: &[u8], tmp_ext: &str) -> AppResult<String> {
    use std::io::Write as _;
    write_atomic_with(dest_path, tmp_ext, |f| f.write_all(bytes).map_err(io)).map(|(path, ())| path)
}

/// `write_atomic` 의 스트리밍 형제 — 바이트 대신 tmp 파일을 받는 클로저가 채운다(HWPX·DOCX 가 zip 을 메모리에 모으지 않고 바로 쓴다).
/// 검증·tmp 위치·rename·정리가 `write_atomic` 과 **같은 한 곳**이다. 클로저가 실패해도 tmp 를 지운다. `(쓴 경로, 클로저 값)`.
pub(crate) fn write_atomic_with<T>(
    dest_path: &Path,
    tmp_ext: &str,
    fill: impl FnOnce(&mut std::fs::File) -> AppResult<T>,
) -> AppResult<(String, T)> {
    if dest_path.as_os_str().is_empty() {
        return Err(AppError::Validation("dest_path is empty".into()));
    }
    // 폴더를 고르면 rename 이 IO 로 실패하고 tmp 가 남는다 — 그 전에 거절한다.
    if dest_path.is_dir() {
        return Err(AppError::Validation("dest_path is a folder".into()));
    }
    let parent = dest_path.parent().filter(|p| !p.as_os_str().is_empty());
    if let Some(parent) = parent {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let tmp_name = format!(".tmp-{}.{}", &crate::util::new_id()[..8], tmp_ext);
    let tmp = match parent {
        Some(parent) => parent.join(&tmp_name),
        None => std::path::PathBuf::from(&tmp_name),
    };
    // 파일은 rename 전에 닫혀 있어야 한다(Windows) — 안쪽 블록이 끝나면 닫힌다.
    let filled = (|| {
        let mut file = std::fs::File::create(&tmp).map_err(io)?;
        fill(&mut file)
    })();
    let value = match filled {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp); // silent-ok: 반쯤 쓴 tmp 정리 — 실패 원인은 돌려주는 오류가 알린다
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&tmp, dest_path) {
        // 이름 바꾸기가 실패하면(대상이 잠김 등) 사용자 폴더에 `.tmp-*` 가 남지 않게 지운다.
        let _ = std::fs::remove_file(&tmp); // silent-ok: tmp 정리 — 실패 원인은 돌려주는 IO 오류가 알린다
        return Err(io(e));
    }
    Ok((dest_path.to_string_lossy().to_string(), value))
}

pub fn export_diagram_png(dest_path: &Path, data_base64: &str) -> AppResult<ExportPngResult> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| AppError::Validation(format!("invalid base64: {e}")))?;

    Ok(ExportPngResult {
        written_path: write_atomic(dest_path, &bytes, "png")?,
    })
}

#[derive(Debug, Serialize)]
pub struct ExportCsvResult {
    pub written_path: String,
}

/// 시트 CSV 를 저장 다이얼로그가 고른 경로에 쓴다.
/// 엑셀 한글 호환을 위해 UTF-8 BOM(EF BB BF)을 추가하여 기록한다.
pub fn export_sheet_csv(dest_path: &Path, csv: &str) -> AppResult<ExportCsvResult> {
    // BOM 삽입은 호출자 책임 — write_atomic 은 넘겨받은 바이트를 그대로 쓴다.
    let mut bytes = Vec::new();
    if !csv.as_bytes().starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(csv.as_bytes());

    Ok(ExportCsvResult {
        written_path: write_atomic(dest_path, &bytes, "csv")?,
    })
}

#[derive(Debug, Serialize)]
pub struct ExportSectionMdResult {
    pub written_path: String,
}

/// 섹션 탭 우클릭 "내보내기…" — 텍스트 섹션 하나의 body_md 를 .md 파일로 그대로 쓴다
/// (specs/commands/export.yaml export_section_md). export_sheet_csv/export_diagram_png 와 반대
/// 방향으로 DB 를 읽는다는 점에서는 export_note 와 같은 부류 — kind 검사는 repo::sheet::set_cells
/// 와 같은 조회+검증 자리(SELECT body_md, kind ... .optional() ... NotFound/Validation).
pub fn export_section_md(conn: &Connection, section_id: &str, dest_path: &Path) -> AppResult<ExportSectionMdResult> {
    let (body_md, kind): (String, String) = conn
        .query_row(
            "SELECT body_md, kind FROM sections WHERE id=?1",
            [section_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(dberr)?
        .ok_or_else(|| AppError::NotFound(format!("section not found: {section_id}")))?;
    if kind != "text" {
        return Err(AppError::Validation(format!(
            "section {section_id} is kind '{kind}', not 'text'"
        )));
    }
    Ok(ExportSectionMdResult {
        written_path: write_atomic(dest_path, body_md.as_bytes(), "md")?,
    })
}

#[derive(Debug, Serialize)]
pub struct ExportAllResult {
    pub note_count: i64,
    pub bundle_path: String,
}

pub fn export_all(conn: &Connection, data_dir: &Path, dest_dir: &Path) -> AppResult<ExportAllResult> {
    std::fs::create_dir_all(dest_dir).map_err(io)?;
    let bundle = dump(conn)?;
    let note_count = bundle.notes.len() as i64;
    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| AppError::Io(format!("serialize bundle: {e}")))?;
    let bundle_path = dest_dir.join("brise-bundle.json");
    std::fs::write(&bundle_path, json.as_bytes()).map_err(io)?;

    let src_att = db::attachments_dir(data_dir);
    let dst_att = dest_dir.join("attachments");
    if src_att.exists() {
        copy_dir_all(&src_att, &dst_att)?;
    }
    Ok(ExportAllResult {
        note_count,
        bundle_path: bundle_path.to_string_lossy().to_string(),
    })
}

/// Folder-scoped counterpart to `dump`: same `Bundle` shape, filtered to one folder's notes (+
/// their sections/sources/attachments/note_tags), only the tags those notes actually use, plus
/// the folder row and its parent workspace row. No settings/workspace_regions/eras/statuses —
/// those are workspace-wide, not folder-scoped, and out of scope for a "hand this folder to
/// someone else" export. Internal wiki-links pointing at notes outside the folder end up
/// dangling in the exported bundle; import already prunes those silently
/// (`prune_dangling_internal`), so this is a known, accepted limitation (see export.yaml notes).
pub(crate) fn dump_folder(conn: &Connection, folder_id: &str) -> AppResult<Bundle> {
    let version = migrations::current_version(conn)?;
    let folder: FolderRow = conn
        .query_row(
            "SELECT id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded FROM folders WHERE id=?1",
            [folder_id],
            FolderRow::from_row,
        )
        .map_err(dberr)?;
    let workspace: WorkspaceRow = conn
        .query_row(
            "SELECT id, name, created_at FROM workspaces WHERE id=?1",
            [&folder.workspace_id],
            WorkspaceRow::from_row,
        )
        .map_err(dberr)?;

    // deleted_at IS NULL: a note the sender put in the trash must not resurrect as a live note in
    // the recipient's DB — insert_note never writes deleted_at, so anything this query returns
    // comes back alive on the other end (mirrors note_summaries_map's same guard).
    // archived_at is intentionally NOT filtered — archive is "hidden, not excluded" (W7-f), so an
    // archived note still rides along here; its archived_at column just needs to travel with it
    // (bundle.rs NoteRow archived_at comment — 이전엔 이 컬럼이 SELECT 에 없어 조용히 사라졌다).
    let mut notes_stmt = conn
        .prepare("SELECT id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status, month, day, remind, end_year, end_month, end_day, icon, lat, lng, start_time, end_time, remind_offset_min, rrule, archived_at FROM notes WHERE folder_id=?1 AND deleted_at IS NULL")
        .map_err(dberr)?;
    let notes: Vec<NoteRow> = notes_stmt
        .query_map([folder_id], NoteRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(notes_stmt);

    let note_ids: Vec<String> = notes.iter().map(|n| n.id.clone()).collect();
    // Chunked child loads live in load_note_children (shared with dump_workspace).
    let (
        sections,
        sources,
        attachments,
        note_tags,
        note_regions,
        note_dates,
        note_related_exclusions,
        tags,
        routine_completions,
    ) = load_note_children(conn, &note_ids)?;

    Ok(Bundle {
        version,
        workspaces: vec![workspace],
        folders: vec![folder],
        notes,
        sections,
        sources,
        attachments,
        tags,
        note_tags,
        settings: Vec::new(),
        workspace_regions: Vec::new(),
        workspace_eras: Vec::new(),
        workspace_statuses: Vec::new(),
        note_regions,
        note_related_exclusions,
        spaces: Vec::new(),
        space_items: Vec::new(),
        routine_completions,
        note_dates,
        workspace_settings: Vec::new(),
        timeline_routines: Vec::new(),
        calendar_sources: Vec::new(),
        calendar_marks: Vec::new(),
        calendar_mark_hides: Vec::new(),
    })
}

/// Notebook-scoped dump (workspace_id = 노트북). Same Bundle shape as `dump_folder`, but
/// **includes** notebook-scoped taxonomy (`workspace_regions` / `workspace_eras` /
/// `workspace_statuses`) that folder export intentionally omits — a notebook must be
/// self-sufficient to restore. Settings stay empty (device-wide, not notebook content).
/// Soft-deleted notes are excluded (same guard as `dump_folder`).
pub(crate) fn dump_workspace(conn: &Connection, workspace_id: &str) -> AppResult<Bundle> {
    let version = migrations::current_version(conn)?;
    let workspace: WorkspaceRow = conn
        .query_row(
            "SELECT id, name, created_at FROM workspaces WHERE id=?1",
            [workspace_id],
            WorkspaceRow::from_row,
        )
        .map_err(dberr)?;

    let mut folders_stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded FROM folders WHERE workspace_id=?1",
        )
        .map_err(dberr)?;
    let folders: Vec<FolderRow> = folders_stmt
        .query_map([workspace_id], FolderRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(folders_stmt);

    // deleted_at IS NULL: same resurrection guard as dump_folder. archived_at stays unfiltered for
    // the same reason as dump_folder above (archive hides, it doesn't exclude from export).
    let mut notes_stmt = conn
        .prepare(
            "SELECT n.id, n.folder_id, n.title, n.year, n.is_favorite, n.exported_at, n.created_at, n.updated_at, n.region, n.status, n.month, n.day, n.remind, n.end_year, n.end_month, n.end_day, n.icon, n.lat, n.lng, n.start_time, n.end_time, n.remind_offset_min, n.rrule, n.archived_at
             FROM notes n
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id=?1 AND n.deleted_at IS NULL",
        )
        .map_err(dberr)?;
    let notes: Vec<NoteRow> = notes_stmt
        .query_map([workspace_id], NoteRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(notes_stmt);

    let note_ids: Vec<String> = notes.iter().map(|n| n.id.clone()).collect();
    let (
        sections,
        sources,
        attachments,
        note_tags,
        note_regions,
        note_dates,
        note_related_exclusions,
        tags,
        routine_completions,
    ) = load_note_children(conn, &note_ids)?;

    let workspace_regions = conn
        .prepare("SELECT id, workspace_id, name, position, created_at FROM workspace_regions WHERE workspace_id=?1")
        .map_err(dberr)?
        .query_map([workspace_id], WorkspaceRegionRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let workspace_eras = conn
        .prepare("SELECT id, workspace_id, name, from_year, to_year, position, created_at FROM workspace_eras WHERE workspace_id=?1")
        .map_err(dberr)?
        .query_map([workspace_id], WorkspaceEraRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let workspace_statuses = conn
        .prepare("SELECT id, workspace_id, name, position, created_at FROM workspace_statuses WHERE workspace_id=?1")
        .map_err(dberr)?
        .query_map([workspace_id], WorkspaceStatusRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    let spaces: Vec<SpaceRow> = conn
        .prepare("SELECT id, workspace_id, title, position, is_home, is_favorite, archived_at, default_style, last_viewport_x, last_viewport_y, last_viewport_zoom, home_viewport_x, home_viewport_y, home_viewport_zoom, layout_locked, created_at, updated_at FROM spaces WHERE workspace_id=?1")
        .map_err(dberr)?
        .query_map([workspace_id], SpaceRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    // PLAN-2026-09-19-notebook-settings §5: 이 노트북의 설정과 반복 일정.
    let workspace_settings: Vec<WorkspaceSettingRow> = conn
        .prepare("SELECT workspace_id, key, value FROM workspace_settings WHERE workspace_id=?1 ORDER BY key")
        .map_err(dberr)?
        .query_map([workspace_id], WorkspaceSettingRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let timeline_routines: Vec<TimelineRoutineRow> = conn
        .prepare(&format!(
            "SELECT {} FROM timeline_routines WHERE workspace_id=?1 ORDER BY position",
            TimelineRoutineRow::COLUMNS
        ))
        .map_err(dberr)?
        .query_map([workspace_id], TimelineRoutineRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let (calendar_sources, calendar_marks, calendar_mark_hides) = dump_calendar(conn, Some(workspace_id))?;

    let space_ids: Vec<String> = spaces.iter().map(|s| s.id.clone()).collect();
    let mut space_items: Vec<SpaceItemRow> = Vec::new();
    for chunk in space_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at FROM space_items WHERE space_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<SpaceItemRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), SpaceItemRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        space_items.extend(rows);
    }

    Ok(Bundle {
        version,
        workspaces: vec![workspace],
        folders,
        notes,
        sections,
        sources,
        attachments,
        tags,
        note_tags,
        // Device-wide prefs stay out of a notebook hand-off (same as dump_folder) — the
        // notebook's own settings travel in `workspace_settings` instead.
        settings: Vec::new(),
        workspace_regions,
        workspace_eras,
        workspace_statuses,
        note_regions,
        note_related_exclusions,
        spaces,
        space_items,
        routine_completions,
        note_dates,
        workspace_settings,
        timeline_routines,
        calendar_sources,
        calendar_marks,
        calendar_mark_hides,
    })
}

type CalendarDump = (Vec<crate::models::CalendarSource>, Vec<crate::models::CalendarMark>, Vec<CalendarMarkHideRow>);

/// 달력 표시일 세 테이블 — `workspace_id` 가 있으면 그 노트북만, 없으면 전부(전체 내보내기).
fn dump_calendar(conn: &Connection, workspace_id: Option<&str>) -> AppResult<CalendarDump> {
    use crate::repo::calendar_marks::{mark_from_row, source_from_row, MARK_COLUMNS, SOURCE_COLUMNS};
    let filter = if workspace_id.is_some() { "WHERE workspace_id=?1" } else { "WHERE ?1 IS NULL" };
    let sources = conn
        .prepare(&format!("SELECT {SOURCE_COLUMNS} FROM calendar_sources {filter} ORDER BY workspace_id, position"))
        .map_err(dberr)?
        .query_map([workspace_id], source_from_row)
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    let marks = conn
        .prepare(&format!("SELECT {MARK_COLUMNS} FROM calendar_marks {filter} ORDER BY workspace_id, month, day"))
        .map_err(dberr)?
        .query_map([workspace_id], mark_from_row)
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    let hides = conn
        .prepare(&format!("SELECT workspace_id, source, iso_day FROM calendar_mark_hides {filter} ORDER BY workspace_id, iso_day"))
        .map_err(dberr)?
        .query_map([workspace_id], |r| {
            Ok(CalendarMarkHideRow { workspace_id: r.get(0)?, source: r.get(1)?, iso_day: r.get(2)? })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;
    Ok((sources, marks, hides))
}

/// Shared per-note child loader for scoped dumps (`dump_folder` / `dump_workspace`). Returns
/// (sections, sources, attachments, note_tags, note_regions, note_dates, note_related_exclusions, tags, routine_completions).
fn load_note_children(
    conn: &Connection,
    note_ids: &[String],
) -> AppResult<(
    Vec<SectionRow>,
    Vec<SourceRow>,
    Vec<AttachmentRow>,
    Vec<NoteTagRow>,
    Vec<NoteRegionRow>,
    Vec<NoteDateRow>,
    Vec<NoteRelatedExclusionRow>,
    Vec<TagRow>,
    Vec<RoutineCompletionRow>,
)> {
    let mut sections = Vec::new();
    let mut sources = Vec::new();
    let mut attachments = Vec::new();
    let mut note_tags = Vec::new();
    let mut note_regions = Vec::new();
    let mut note_dates = Vec::new();
    let mut note_related_exclusions = Vec::new();
    let mut routine_completions = Vec::new();
    let mut tag_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for chunk in note_ids.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");

        let sql = format!(
            "SELECT id, note_id, name, body_md, position FROM sections WHERE note_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<SectionRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), SectionRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        sections.extend(rows);
        drop(stmt);

        let sql = format!(
            "SELECT id, note_id, name, ext, body, position, created_at FROM sources WHERE note_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<SourceRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), SourceRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        sources.extend(rows);
        drop(stmt);

        let sql = format!(
            // 참조 첨부(ext_path)는 번들에 담지 않는다 — 파일이 앱 폴더 밖에 있어 복사 대상이
            // 아니고, 이 기계의 절대경로는 받는 쪽에서 의미가 없다(import 의 CHECK 도 못 넘는다).
            "SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at FROM attachments WHERE note_id IN ({placeholders}) AND ext_path IS NULL"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<AttachmentRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), AttachmentRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        attachments.extend(rows);
        drop(stmt);

        let sql = format!("SELECT note_id, tag_id FROM note_tags WHERE note_id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<NoteTagRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), NoteTagRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        for nt in &rows {
            tag_ids.insert(nt.tag_id.clone());
        }
        note_tags.extend(rows);
        drop(stmt);

        let sql = format!(
            "SELECT id, note_id, name, lat, lng, position, created_at FROM note_regions WHERE note_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<NoteRegionRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), NoteRegionRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        note_regions.extend(rows);
        drop(stmt);

        // PLAN-2026-09-08-dates-rebuild.md W3: 번들의 NoteDateRow 가 이제 트리플+position+시각/
        // 알림/반복 전체를 그대로 싣는다(옛 date/end_date 문자열 printf 조립은 사라졌다 — 새
        // 번들은 date/end_date 를 항상 None 으로 내보낸다). `position != 0` — position=0(대표)은
        // notes.* 로 이미 번들에 실리므로 여기 또 실으면 가져오기 때 대표가 관련 날짜로 중복된다.
        let sql = format!(
            "SELECT id, note_id, position, year, month, day, end_year, end_month, end_day,
                    remind, created_at, start_time, end_time, remind_offset_min, rrule, label
             FROM note_dates WHERE position != 0 AND note_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<NoteDateRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), NoteDateRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        note_dates.extend(rows);
        drop(stmt);

        let sql = format!(
            "SELECT id_1, id_2, created_at FROM note_related_exclusions WHERE id_1 IN ({placeholders}) OR id_2 IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<NoteRelatedExclusionRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter().chain(chunk.iter())), NoteRelatedExclusionRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        note_related_exclusions.extend(rows);
        drop(stmt);

        let sql = format!(
            "SELECT note_id, occur_on, done_at FROM routine_completions WHERE note_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<RoutineCompletionRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), RoutineCompletionRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        routine_completions.extend(rows);
        drop(stmt);
    }

    let tag_id_list: Vec<String> = tag_ids.into_iter().collect();
    let mut tags = Vec::new();
    for chunk in tag_id_list.chunks(crate::util::IN_CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!("SELECT id, name FROM tags WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(dberr)?;
        let rows: Vec<TagRow> = stmt
            .query_map(rusqlite::params_from_iter(chunk.iter()), TagRow::from_row)
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        tags.extend(rows);
        drop(stmt);
    }

    Ok((
        sections,
        sources,
        attachments,
        note_tags,
        note_regions,
        note_dates,
        note_related_exclusions,
        tags,
        routine_completions,
    ))
}

/// Notebook-scoped bundle export (workspace_id = 노트북) — same `brise-bundle.json` +
/// `attachments/` shape as `export_folder_bundle`, but self-sufficient for a full notebook
/// restore (includes workspace_regions/eras/statuses). Nested under a slugified subdirectory
/// of dest_dir so successive exports never clobber each other.
pub fn export_workspace_bundle(
    conn: &Connection,
    data_dir: &Path,
    workspace_id: &str,
    dest_dir: &Path,
) -> AppResult<ExportAllResult> {
    std::fs::create_dir_all(dest_dir).map_err(io)?;
    let bundle = dump_workspace(conn, workspace_id)?;

    let base = slugify(&bundle.workspaces[0].name);
    let mut out_dir_name = base.clone();
    let mut i = 1;
    while dest_dir.join(&out_dir_name).exists() {
        out_dir_name = format!("{base}-{i}");
        i += 1;
    }
    let out_dir = dest_dir.join(&out_dir_name);
    std::fs::create_dir_all(&out_dir).map_err(io)?;

    let note_count = bundle.notes.len() as i64;
    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| AppError::Io(format!("serialize bundle: {e}")))?;
    let bundle_path = out_dir.join("brise-bundle.json");
    std::fs::write(&bundle_path, json.as_bytes()).map_err(io)?;

    // Only attachments this notebook's notes reference (not the whole attachments/ tree),
    // plus space-image files keyed by space_items.source_id.
    let data_att = db::attachments_dir(data_dir);
    let dst_att = out_dir.join("attachments");
    for a in &bundle.attachments {
        if let Some(rel) = &a.rel_path {
            let src = data_att.join(rel);
            if src.exists() {
                let dst = dst_att.join(rel);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent).map_err(io)?;
                }
                std::fs::copy(&src, &dst).map_err(io)?;
            }
        }
    }
    super::import::copy_space_images(&bundle.space_items, &data_att, &dst_att)?;

    Ok(ExportAllResult {
        note_count,
        bundle_path: bundle_path.to_string_lossy().to_string(),
    })
}

/// Folder-scoped bundle export — same `brise-bundle.json` + `attachments/` shape as `export_all`,
/// but filtered to one folder (see `dump_folder`). Lets a user hand a coherent subset (e.g. one
/// AI-organized study-notes folder) to someone else, re-importable via the normal `import_bundle`.
/// Written under a slugified, collision-disambiguated subdirectory of dest_dir (same
/// slugify/uniqueness scheme as `export_folder` above) rather than straight into dest_dir — a
/// fixed "brise-bundle.json" name there would silently clobber a previous folder export dropped
/// into the same destination.
pub fn export_folder_bundle(
    conn: &Connection,
    data_dir: &Path,
    folder_id: &str,
    dest_dir: &Path,
) -> AppResult<ExportAllResult> {
    std::fs::create_dir_all(dest_dir).map_err(io)?;
    let bundle = dump_folder(conn, folder_id)?;

    let base = slugify(&bundle.folders[0].name);
    let mut out_dir_name = base.clone();
    let mut i = 1;
    while dest_dir.join(&out_dir_name).exists() {
        out_dir_name = format!("{base}-{i}");
        i += 1;
    }
    let out_dir = dest_dir.join(&out_dir_name);
    std::fs::create_dir_all(&out_dir).map_err(io)?;

    let note_count = bundle.notes.len() as i64;
    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| AppError::Io(format!("serialize bundle: {e}")))?;
    let bundle_path = out_dir.join("brise-bundle.json");
    std::fs::write(&bundle_path, json.as_bytes()).map_err(io)?;

    // Only the attachments this folder's notes actually reference get copied (not the whole
    // attachments/ dir, unlike export_all) — out_dir/attachments/<rel_path> so it lines up with
    // import_bundle's copy_attachments expectations.
    let data_att = db::attachments_dir(data_dir);
    let dst_att = out_dir.join("attachments");
    for a in &bundle.attachments {
        if let Some(rel) = &a.rel_path {
            let src = data_att.join(rel);
            if src.exists() {
                let dst = dst_att.join(rel);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent).map_err(io)?;
                }
                std::fs::copy(&src, &dst).map_err(io)?;
            }
        }
    }

    Ok(ExportAllResult {
        note_count,
        bundle_path: bundle_path.to_string_lossy().to_string(),
    })
}

pub(crate) fn dump(conn: &Connection) -> AppResult<Bundle> {
    let version = migrations::current_version(conn)?;
    let workspaces = conn
        .prepare("SELECT id, name, created_at FROM workspaces")
        .map_err(dberr)?
        .query_map([], WorkspaceRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let folders = conn
        .prepare("SELECT id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded FROM folders")
        .map_err(dberr)?
        .query_map([], FolderRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let notes = conn
        .prepare("SELECT id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status, month, day, remind, end_year, end_month, end_day, icon, lat, lng, start_time, end_time, remind_offset_min, rrule, archived_at FROM notes")
        .map_err(dberr)?
        .query_map([], NoteRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let sections = conn
        .prepare("SELECT id, note_id, name, body_md, position FROM sections")
        .map_err(dberr)?
        .query_map([], SectionRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let sources = conn
        .prepare("SELECT id, note_id, name, ext, body, position, created_at FROM sources")
        .map_err(dberr)?
        .query_map([], SourceRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let attachments = conn
        // 참조 첨부 제외 — dump_notes_children 과 같은 이유(앱 폴더 밖 원본은 번들에 못 담는다).
        .prepare("SELECT id, note_id, name, kind, rel_path, url, size_bytes, position, created_at FROM attachments WHERE ext_path IS NULL")
        .map_err(dberr)?
        .query_map([], AttachmentRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let tags = conn
        .prepare("SELECT id, name FROM tags")
        .map_err(dberr)?
        .query_map([], TagRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let note_tags = conn
        .prepare("SELECT note_id, tag_id FROM note_tags")
        .map_err(dberr)?
        .query_map([], NoteTagRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    // Secrets (API keys) are dropped here so they never land in the on-disk bundle. On a
    // `replace` import the key row is simply absent afterwards, which the frontend reads as empty
    // (every setting is `?? default`) — the intended, secure outcome for a restored backup.
    let settings: Vec<KvRow> = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(dberr)?
        .query_map([], |r| {
            Ok(KvRow {
                key: r.get(0)?,
                value: r.get(1)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<KvRow>, _>>()
        .map_err(dberr)?
        .into_iter()
        .filter(|kv| !is_secret_setting_key(&kv.key) && !is_device_local_setting_key(&kv.key))
        // 노트북 키는 전역 행이 죽은 행이다(get_all 이 무시) — 노트북별 값은 workspace_settings 로 간다.
        .filter(|kv| !crate::repo::settings_schema::is_notebook_setting_key(&kv.key))
        .collect();
    let workspace_settings: Vec<WorkspaceSettingRow> = conn
        .prepare("SELECT workspace_id, key, value FROM workspace_settings ORDER BY workspace_id, key")
        .map_err(dberr)?
        .query_map([], WorkspaceSettingRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let timeline_routines: Vec<TimelineRoutineRow> = conn
        .prepare(&format!(
            "SELECT {} FROM timeline_routines ORDER BY workspace_id, position",
            TimelineRoutineRow::COLUMNS
        ))
        .map_err(dberr)?
        .query_map([], TimelineRoutineRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let (calendar_sources, calendar_marks, calendar_mark_hides) = dump_calendar(conn, None)?;
    let workspace_regions = conn
        .prepare("SELECT id, workspace_id, name, position, created_at FROM workspace_regions")
        .map_err(dberr)?
        .query_map([], WorkspaceRegionRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let workspace_eras = conn
        .prepare("SELECT id, workspace_id, name, from_year, to_year, position, created_at FROM workspace_eras")
        .map_err(dberr)?
        .query_map([], WorkspaceEraRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let workspace_statuses = conn
        .prepare("SELECT id, workspace_id, name, position, created_at FROM workspace_statuses")
        .map_err(dberr)?
        .query_map([], WorkspaceStatusRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let note_regions = conn
        .prepare("SELECT id, note_id, name, lat, lng, position, created_at FROM note_regions")
        .map_err(dberr)?
        .query_map([], NoteRegionRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    // PLAN-2026-09-08-dates-rebuild.md W3: 위 청크 경로와 동일 이유(트리플+position+시각/알림/반복
    // 전체, position != 0).
    let note_dates: Vec<NoteDateRow> = conn
        .prepare(
            "SELECT id, note_id, position, year, month, day, end_year, end_month, end_day,
                    remind, created_at, start_time, end_time, remind_offset_min, rrule, label
             FROM note_dates WHERE position != 0",
        )
        .map_err(dberr)?
        .query_map([], NoteDateRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let note_related_exclusions = conn
        .prepare("SELECT id_1, id_2, created_at FROM note_related_exclusions")
        .map_err(dberr)?
        .query_map([], NoteRelatedExclusionRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let spaces: Vec<SpaceRow> = conn
        .prepare("SELECT id, workspace_id, title, position, is_home, is_favorite, archived_at, default_style, last_viewport_x, last_viewport_y, last_viewport_zoom, home_viewport_x, home_viewport_y, home_viewport_zoom, layout_locked, created_at, updated_at FROM spaces")
        .map_err(dberr)?
        .query_map([], SpaceRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let space_items: Vec<SpaceItemRow> = conn
        .prepare("SELECT id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at FROM space_items")
        .map_err(dberr)?
        .query_map([], SpaceItemRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    let routine_completions: Vec<RoutineCompletionRow> = conn
        .prepare("SELECT note_id, occur_on, done_at FROM routine_completions")
        .map_err(dberr)?
        .query_map([], RoutineCompletionRow::from_row)
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;

    Ok(Bundle {
        version,
        workspaces,
        folders,
        notes,
        sections,
        sources,
        attachments,
        tags,
        note_tags,
        settings,
        workspace_regions,
        workspace_eras,
        workspace_statuses,
        note_regions,
        note_related_exclusions,
        spaces,
        space_items,
        routine_completions,
        note_dates,
        workspace_settings,
        timeline_routines,
        calendar_sources,
        calendar_marks,
        calendar_mark_hides,
    })
}

#[cfg(test)]
mod tests {
    use super::super::render::safe_attachment_basename;
    use super::*;

    /// 확장자 판정은 Windows 이름 규칙(끝 `.`·공백 무시)을 따른다 — `a.html.` 로 export_note 의 .html 거절을 비켜 갈 수 없다.
    #[test]
    fn dest_ext_lower_ignores_trailing_dots_and_spaces_like_windows() {
        for (p, want) in [("a.html", Some("html")), ("a.HTML.", Some("html")), ("a.html .", Some("html")), ("a.md", Some("md")), ("a", None), ("a.", None)] {
            assert_eq!(dest_ext_lower(Path::new(p)).as_deref(), want, "{p:?}");
        }
    }

    /// 폴더를 저장 경로로 주면 VALIDATION — rename 실패로 사용자 폴더에 `.tmp-*` 가 남던 길.
    #[test]
    fn write_atomic_rejects_a_folder_and_leaves_no_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("x.png");
        std::fs::create_dir(&folder).unwrap();
        assert!(matches!(write_atomic(&folder, b"x", "png"), Err(AppError::Validation(_))));
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".tmp-")));
    }

    /// 스트리밍 형제: 클로저가 실패하면 tmp 가 남지 않고 목적지도 만들어지지 않는다 · 폴더 목적지는 클로저를 부르기 전에 거절 ·
    /// 성공하면 클로저가 쓴 내용이 떨어지고 클로저 값이 돌아온다.
    #[test]
    fn write_atomic_with_cleans_up_on_closure_error_and_rejects_a_folder() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let no_tmp = |d: &Path| std::fs::read_dir(d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".tmp-"));
        let dest = dir.path().join("out.bin");
        let err = write_atomic_with(&dest, "bin", |f| -> AppResult<()> {
            f.write_all(b"half").unwrap();
            Err(AppError::Validation("boom".into()))
        });
        assert!(matches!(err, Err(AppError::Validation(_))));
        assert!(!dest.exists() && no_tmp(dir.path()));

        let folder = dir.path().join("x.bin");
        std::fs::create_dir(&folder).unwrap();
        let mut called = false;
        let r = write_atomic_with(&folder, "bin", |_| -> AppResult<()> {
            called = true;
            Ok(())
        });
        assert!(matches!(r, Err(AppError::Validation(_))) && !called && no_tmp(dir.path()));
        assert!(matches!(write_atomic_with(Path::new(""), "bin", |_| -> AppResult<()> { Ok(()) }), Err(AppError::Validation(_))));

        let (path, n) = write_atomic_with(&dest, "bin", |f| f.write_all(b"full").map(|_| 4).map_err(io)).unwrap();
        assert_eq!((path, n), (dest.to_string_lossy().to_string(), 4));
        assert_eq!(std::fs::read(&dest).unwrap(), b"full");
        assert!(no_tmp(dir.path()));
    }

    /// 관계도 PNG 저장 — 고른 경로에 정확히 그 바이트가 떨어진다(tmp 파일은 남지 않는다).
    #[test]
    fn export_diagram_png_writes_the_decoded_bytes_to_the_chosen_path() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("diagram.png");
        // "ABC" — attachment_add_bytes 가 받는 것과 같은 raw base64(데이터 URL prefix 없음).
        let out = export_diagram_png(&dest, "QUJD").unwrap();

        assert_eq!(out.written_path, dest.to_string_lossy());
        assert_eq!(std::fs::read(&dest).unwrap(), b"ABC");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp file left behind: {leftovers:?}");
    }

    /// 잘못된 base64(예: `data:image/png;base64,` prefix 를 같이 보낸 호출)는 IO 가 아니라
    /// VALIDATION — 디스크 문제와 호출자 문제를 사용자에게 같은 말로 보고하면 안 된다.
    #[test]
    fn export_diagram_png_rejects_bad_input_as_validation() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("diagram.png");
        let err = export_diagram_png(&dest, "data:image/png;base64,QUJD").unwrap_err();
        assert_eq!(err.code(), "VALIDATION");
        assert!(!dest.exists(), "nothing must be written on a rejected payload");

        let err = export_diagram_png(Path::new(""), "QUJD").unwrap_err();
        assert_eq!(err.code(), "VALIDATION");
    }

    #[test]
    fn secret_setting_keys_are_excluded_from_bundle() {
        assert!(is_secret_setting_key("ai_api_key"));
        assert!(is_secret_setting_key("ai_provider_creds"));
        assert!(is_secret_setting_key("sync_token"));
        assert!(!is_secret_setting_key("ai_endpoint"));
        assert!(!is_secret_setting_key("ai_provider"));
        assert!(!is_secret_setting_key("theme"));
    }

    /// sync_enabled/sync_port/sync_token 은 device_id 와 같은 취급(device_local) — 번들을 받는
    /// 쪽이 보내는 쪽의 로컬 서버 설정을 이어받으면 안 된다.
    #[test]
    fn sync_setting_keys_are_device_local() {
        assert!(is_device_local_setting_key("sync_enabled"));
        assert!(is_device_local_setting_key("sync_port"));
        assert!(is_device_local_setting_key("sync_token"));
    }

    /// dump()(export_all/export_folder_bundle 이 쓰는 실제 번들 조립기) 로 확인 — is_secret/
    /// is_device_local 함수 자체가 옳아도 dump() 의 필터 체인이 실제로 둘 다 적용하는지는 별개다.
    #[test]
    fn dump_excludes_sync_settings_from_the_exported_bundle() {
        use crate::db::migrations;
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('sync_enabled', 'true')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('sync_port', '7332')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('sync_token', '\"super-secret-token\"')",
            [],
        )
        .unwrap();

        let bundle = dump(&conn).unwrap();
        for key in ["sync_enabled", "sync_port", "sync_token"] {
            assert!(
                !bundle.settings.iter().any(|kv| kv.key == key),
                "{key} must never travel inside an export bundle"
            );
        }
    }

    /// device_id is not in validate_setting's allow-list (it bypasses settings_set entirely), so
    /// if it ever traveled inside a bundle, import's fail-closed validation would reject the whole
    /// restore. It must also never overwrite the device it's being restored onto.
    #[test]
    fn device_local_setting_keys_are_excluded_from_bundle() {
        assert!(is_device_local_setting_key("device_id"));
        assert!(is_device_local_setting_key("search_recent"));
        assert!(is_device_local_setting_key("capture_screenshot_dir"));
        assert!(!is_device_local_setting_key("theme"));
        assert!(!is_device_local_setting_key("onboarding_completed"));
    }

    /// QA8 Wave 3A — search history must never travel inside an export bundle (content-adjacent).
    #[test]
    fn dump_excludes_search_recent_from_the_exported_bundle() {
        use crate::db::migrations;
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('search_recent', '[\"silla\",\"baekje\"]')",
            [],
        )
        .unwrap();
        // Control: a normal (app-wide) setting still ships so the filter isn't "drop everything".
        // (theme 은 V86 이후 노트북 키라 workspace_settings 로 간다 — 전역 대조군은 close_to_tray.)
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES ('close_to_tray', 'false')",
            [],
        )
        .unwrap();

        let bundle = dump(&conn).unwrap();
        assert!(
            !bundle.settings.iter().any(|kv| kv.key == "search_recent"),
            "search_recent must never travel inside an export bundle"
        );
        assert!(
            bundle.settings.iter().any(|kv| kv.key == "close_to_tray"),
            "non-device-local settings must still be exported"
        );
    }

    /// PLAN-2026-09-19-notebook-settings §5: 전체 내보내기는 노트북 설정을 노트북별 행으로 싣고,
    /// 전역 settings 에는 노트북 키를 싣지 않는다(죽은 전역 행이 번들을 오염시키지 않게).
    #[test]
    fn dump_carries_notebook_settings_per_notebook_not_as_globals() {
        let conn = export_test_db();
        let ws = crate::repo::folders::active_workspace_id(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, 'theme', '\"dark\"')",
            [&ws],
        )
        .unwrap();
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('theme', '\"light\"')", [])
            .unwrap();
        let bundle = dump(&conn).unwrap();
        assert!(!bundle.settings.iter().any(|kv| kv.key == "theme"));
        assert!(bundle
            .workspace_settings
            .iter()
            .any(|r| r.workspace_id == ws && r.key == "theme" && r.value == "\"dark\""));
    }

    #[test]
    fn attachment_basename_strips_traversal_and_absolute_paths() {
        // Windows and POSIX separators both collapse to the final component.
        assert_eq!(safe_attachment_basename("photo.png"), "photo.png");
        assert_eq!(
            safe_attachment_basename("..\\..\\..\\Users\\Public\\evil.txt"),
            "evil.txt"
        );
        assert_eq!(
            safe_attachment_basename("../../etc/passwd"),
            "passwd"
        );
        assert_eq!(
            safe_attachment_basename("C:\\Windows\\System32\\evil.dll"),
            "evil.dll"
        );
        // Pure-traversal / empty names fall back to a fixed safe stem.
        assert_eq!(safe_attachment_basename(".."), "attachment");
        assert_eq!(safe_attachment_basename(""), "attachment");
        assert_eq!(safe_attachment_basename("   "), "attachment");
        // Trailing dots/spaces (Windows-hostile) are trimmed — combined pass leaves no residual space.
        assert_eq!(safe_attachment_basename("report.pdf. "), "report.pdf");
        assert_eq!(safe_attachment_basename("report.txt ."), "report.txt");
        // Windows reserved device names are neutralized (stem compared case-insensitively).
        assert_eq!(safe_attachment_basename("CON"), "CON_");
        assert_eq!(safe_attachment_basename("nul.txt"), "nul.txt_");
        assert_eq!(safe_attachment_basename("COM1"), "COM1_");
        // A normal name whose stem merely contains a reserved word is untouched.
        assert_eq!(safe_attachment_basename("console.log"), "console.log");
    }

    /// 회귀(hwpx 가져오기 검증): `:` 는 구분자가 아니라 위 분리를 통과하는데, `dir.join("C:x.png")` 는 드라이브 접두사가 붙은 상대
    /// 경로라 기준 폴더를 통째로 대체해 스테이징 폴더 밖(현재 작업 폴더)에 쓴다. Windows 가 못 쓰는 문자와 긴 이름은 첨부 한 장이
    /// 문서 전체 가져오기를 죽였다. 이 함수 한 곳이 `stage_bytes`·내보내기·`normalize_stored_name` 의 공통 입구다.
    #[test]
    fn attachment_basename_neutralizes_drive_prefix_windows_hostile_chars_and_long_names() {
        assert_eq!(safe_attachment_basename("C:x.png"), "C-x.png");
        assert_eq!(safe_attachment_basename("BinData/C:x.png"), "C-x.png");
        assert_eq!(safe_attachment_basename("a:b:c.txt"), "a-b-c.txt");
        assert_eq!(safe_attachment_basename("a?b.png"), "a-b.png");
        assert_eq!(safe_attachment_basename("<img onerror=x>.png"), "-img onerror=x-.png");
        assert_eq!(safe_attachment_basename("한글 이름?*.png"), "한글 이름--.png");
        assert_eq!(safe_attachment_basename("a\u{1}b|c.png"), "a-b-c.png");
        // 스트림 표기(`file.txt:stream`)도 `:` 라 같은 길로 무력화된다.
        assert_eq!(safe_attachment_basename("file.txt:secret"), "file.txt-secret");

        // 어떤 이름이든 결과는 구분자·드라이브 접두사·금지 문자가 없는 한 조각이고, 한 번 더 돌려도 그대로다.
        let long_ascii = format!("{}.png", "a".repeat(300));
        let long_korean = format!("{}.jpeg", "가".repeat(100)); // 300바이트
        let no_ext = "b".repeat(500);
        for name in [
            "C:x.png", "a?b.png", "<img onerror=x>.png", "한글 이름?*.png", "..:..", "a\u{1}b", long_ascii.as_str(),
            long_korean.as_str(), no_ext.as_str(), "COM1:.txt", "x:y\\z/w:v.gif",
        ] {
            let safe = safe_attachment_basename(name);
            assert!(!safe.is_empty(), "{name:?}");
            assert!(safe.len() <= 120, "{name:?} -> {} bytes", safe.len());
            assert!(
                !safe.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20),
                "{name:?} -> {safe:?}"
            );
            assert_eq!(std::path::Path::new(&safe).components().count(), 1, "{name:?} -> {safe:?}");
            assert_eq!(safe_attachment_basename(&safe), safe, "멱등: {name:?}");
        }
        // 길면 stem 만 자르고 확장자는 지킨다(kind 판정이 확장자에 달려 있다).
        assert!(safe_attachment_basename(&long_ascii).ends_with(".png"));
        assert!(safe_attachment_basename(&long_korean).ends_with(".jpeg"));
        // 예약어 검사는 정리·자르기 뒤 마지막에 돈다.
        assert_eq!(safe_attachment_basename("con"), "con_");
    }

    /// dump_folder must include only the target folder's own notes/sections/attachments/note_tags,
    /// only the tags those notes actually reference (not every tag in the DB), the folder row
    /// itself and its parent workspace — and nothing belonging to a sibling folder.
    #[test]
    fn dump_folder_scopes_to_one_folder() {
        use crate::db::migrations;
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let ws_id: String = conn.query_row("SELECT id FROM workspaces LIMIT 1", [], |r| r.get(0)).unwrap();
        let folder_a: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let folder_b = crate::util::new_id();
        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at) VALUES (?1,?2,'B',1,1,'2020-01-01T00:00:00Z')",
            params![folder_b, ws_id],
        )
        .unwrap();

        let note_a = crate::util::new_id();
        let note_b = crate::util::new_id();
        let now = "2020-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at) VALUES (?1,?2,'Note A',2020,0,?3,?3)",
            params![note_a, folder_a, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at) VALUES (?1,?2,'Note B',2020,0,?3,?3)",
            params![note_b, folder_b, now],
        )
        .unwrap();

        let tag_alpha = crate::util::new_id();
        let tag_beta = crate::util::new_id();
        conn.execute("INSERT INTO tags(id, name) VALUES (?1,'alpha')", [&tag_alpha]).unwrap();
        conn.execute("INSERT INTO tags(id, name) VALUES (?1,'beta')", [&tag_beta]).unwrap();
        conn.execute(
            "INSERT INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
            params![note_a, tag_alpha],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
            params![note_b, tag_beta],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, position, created_at) VALUES (?1,?2,'file.txt','doc','file.txt',0,?3)",
            params![crate::util::new_id(), note_a, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','hi',0)",
            params![crate::util::new_id(), note_a],
        )
        .unwrap();

        // Trashed (soft-deleted) note in the SAME folder — must not resurrect as live in whoever
        // imports this bundle. insert_note never writes deleted_at, so anything dump_folder hands
        // back comes back alive on the other end.
        let note_trashed = crate::util::new_id();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at, deleted_at) VALUES (?1,?2,'Trashed',2020,0,?3,?3,?3)",
            params![note_trashed, folder_a, now],
        )
        .unwrap();

        let bundle = dump_folder(&conn, &folder_a).unwrap();
        assert_eq!(bundle.folders.len(), 1);
        assert_eq!(bundle.folders[0].id, folder_a);
        assert_eq!(bundle.workspaces.len(), 1);
        assert_eq!(bundle.workspaces[0].id, ws_id);
        assert_eq!(bundle.notes.iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec![note_a.clone()]);
        assert!(!bundle.notes.iter().any(|n| n.id == note_trashed));
        assert_eq!(bundle.sections.len(), 1);
        assert_eq!(bundle.attachments.len(), 1);
        assert_eq!(bundle.attachments[0].note_id, note_a);
        assert_eq!(bundle.tags.iter().map(|t| t.name.clone()).collect::<Vec<_>>(), vec!["alpha".to_string()]);
        assert!(bundle.note_tags.iter().all(|nt| nt.note_id == note_a));
        assert!(bundle.settings.is_empty());
    }

    /// Exporting the same folder twice into the same dest_dir must not clobber the first bundle —
    /// each export lands in its own slugified, disambiguated subdirectory (same scheme as
    /// export_folder above), the way two same-named files would get " (2)".
    #[test]
    fn export_folder_bundle_does_not_clobber_a_previous_export_in_the_same_dest_dir() {
        use crate::db::migrations;
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_a: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let now = "2020-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at) VALUES (?1,?2,'Note A',2020,0,?3,?3)",
            params![crate::util::new_id(), folder_a, now],
        )
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let dest_dir = tempfile::tempdir().unwrap();

        let first = export_folder_bundle(&conn, data_dir.path(), &folder_a, dest_dir.path()).unwrap();
        let second = export_folder_bundle(&conn, data_dir.path(), &folder_a, dest_dir.path()).unwrap();

        assert_ne!(first.bundle_path, second.bundle_path);
        // Both files must exist AND actually contain the exported note — not just be present as
        // empty/garbage placeholders in the (correctly) disambiguated directory.
        for path in [&first.bundle_path, &second.bundle_path] {
            let raw = std::fs::read_to_string(path).unwrap();
            let bundle: Bundle = serde_json::from_str(&raw).unwrap();
            assert_eq!(bundle.notes.len(), 1);
            assert_eq!(bundle.notes[0].title, "Note A");
        }
    }

    /// End-to-end: export_folder_bundle writes a bundle + copies only the referenced attachment,
    /// and the result imports cleanly (merge) into a fresh DB — the exported note lands with its
    /// tag and attachment, the sibling folder's note never existed in the source bundle at all.
    #[test]
    fn export_folder_bundle_roundtrips_into_fresh_db() {
        use crate::db::migrations;
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_a: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let note_a = crate::util::new_id();
        let now = "2020-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at) VALUES (?1,?2,'Note A',2020,0,?3,?3)",
            params![note_a, folder_a, now],
        )
        .unwrap();
        let tag_alpha = crate::util::new_id();
        conn.execute("INSERT INTO tags(id, name) VALUES (?1,'alpha')", [&tag_alpha]).unwrap();
        conn.execute(
            "INSERT INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
            params![note_a, tag_alpha],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, position, created_at) VALUES (?1,?2,'file.txt','doc','file.txt',0,?3)",
            params![crate::util::new_id(), note_a, now],
        )
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"hello").unwrap();

        let dest_dir = tempfile::tempdir().unwrap();
        let result = export_folder_bundle(&conn, data_dir.path(), &folder_a, dest_dir.path()).unwrap();
        assert_eq!(result.note_count, 1);
        // bundle_path lives in the same (slugified) subdirectory as attachments/ — derive it
        // rather than assuming dest_dir directly, since export_folder_bundle nests output under a
        // per-folder subdirectory (see the collision-avoidance test below for why).
        let out_dir = Path::new(&result.bundle_path).parent().unwrap();
        assert!(std::fs::metadata(out_dir.join("attachments").join("file.txt")).is_ok());

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let bundle_path = Path::new(&result.bundle_path);
        let fresh_data_dir = tempfile::tempdir().unwrap();
        let import_result = super::super::import::import_bundle(
            &mut fresh,
            fresh_data_dir.path(),
            bundle_path,
            "merge",
            None,
            false,
        )
        .unwrap();
        assert_eq!(import_result.imported_notes, 1);

        let imported_title: String = fresh
            .query_row("SELECT title FROM notes WHERE id=?1", [&note_a], |r| r.get(0))
            .unwrap();
        assert_eq!(imported_title, "Note A");
        let tag_name: String = fresh
            .query_row(
                "SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=?1",
                [&note_a],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tag_name, "alpha");
    }

    #[test]
    fn export_sheet_csv_writes_utf8_bom() {
        let dir = std::env::temp_dir().join(format!("brise-sheet-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("test.csv");
        let res = export_sheet_csv(&target, "a,b,c\n1,2,3").unwrap();
        assert_eq!(res.written_path, target.to_string_lossy());
        let read_bytes = std::fs::read(&target).unwrap();
        assert!(read_bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(read_bytes[3..].to_vec()).unwrap();
        assert_eq!(text, "a,b,c\n1,2,3");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn export_test_db() -> Connection {
        use crate::db::migrations;
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }

    #[test]
    fn export_section_md_writes_body_md_verbatim() {
        use crate::repo::sections;
        let mut conn = export_test_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = notes::create(&mut conn, &folder_id, None, None).unwrap();
        let section = sections::create_with_body(
            &mut conn,
            &detail.note.id,
            None,
            "# 제목\n본문".to_string(),
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!("brise-section-md-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.md");

        let out = export_section_md(&conn, &section.id, &dest).unwrap();
        assert_eq!(out.written_path, dest.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "# 제목\n본문");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// kind != 'text' (예: 시트)는 VALIDATION — 시트/관계도는 각자의 형식(export_sheet_csv,
    /// export_diagram_png)이 있고, 그 body_md(JSON)를 .md 로 쓰는 건 의미가 없다.
    #[test]
    fn test_export_section_md_rejects_non_text_kind() {
        use crate::repo::sections;
        let mut conn = export_test_db();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let detail = notes::create(&mut conn, &folder_id, None, None).unwrap();
        let sheet_section = sections::create_with_body_and_kind(
            &mut conn,
            &detail.note.id,
            None,
            r#"{"v":1,"rows":10,"cols":[],"cells":{}}"#.to_string(),
            Some("sheet".to_string()),
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!("brise-section-md-reject-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.md");

        let err = export_section_md(&conn, &sheet_section.id, &dest).unwrap_err();
        assert_eq!(err.code(), "VALIDATION");
        assert!(!dest.exists(), "nothing must be written on a rejected kind");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── export_note · export_folder (Markdown) ───────────────────────────

    /// (data_dir, conn, note_id) — 첨부 루트가 있는 DB.
    fn md_export_fixture(title: &str) -> (tempfile::TempDir, Connection, String) {
        let data = tempfile::tempdir().unwrap();
        let mut conn = crate::db::bootstrap(data.path()).unwrap();
        let folder_id: String = conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0)).unwrap();
        let id = notes::create(&mut conn, &folder_id, Some(title.into()), None).unwrap().note.id;
        (data, conn, id)
    }

    fn add_file_att(conn: &mut Connection, data: &Path, note_id: &str, name: &str, bytes: &[u8]) {
        let dir = data.join("src").join(crate::util::new_id());
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join(name);
        std::fs::write(&src, bytes).unwrap();
        crate::repo::attachments::add_file(conn, data, note_id, &src.to_string_lossy()).unwrap();
    }

    /// 마크다운의 첨부 링크 대상(`](대상)`)을 모은다.
    fn md_link_targets(md: &str) -> Vec<String> {
        md.lines()
            .filter_map(|l| l.split_once("](").map(|(_, rest)| rest.trim_end_matches(')').to_string()))
            .collect()
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    /// 결함 재현(W6): 저장 대화상자가 고른 **파일 경로**를 넘기면 그 경로에 파일이 생긴다(예전엔 `x.md/제목.md`).
    /// 첨부는 그 옆 `{stem}_files/` 에 가고, 마크다운의 링크가 실제로 복사된 파일을 가리킨다(같은 이름 둘 → ` (2)`).
    #[test]
    fn export_note_writes_the_chosen_file_with_attachments_beside_it_and_links_that_resolve() {
        let (data, mut conn, id) = md_export_fixture("제목");
        add_file_att(&mut conn, data.path(), &id, "pic.png", b"one");
        add_file_att(&mut conn, data.path(), &id, "pic.png", b"two");
        add_file_att(&mut conn, data.path(), &id, "doc.pdf", b"pdf");
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("보고서.md");
        let res = export_note(&mut conn, data.path(), &id, &dest).unwrap();
        assert_eq!(res.written_path, dest.to_string_lossy());
        assert!(dest.is_file());
        let md = std::fs::read_to_string(&dest).unwrap();
        let targets = md_link_targets(&md);
        assert_eq!(targets, vec!["보고서_files/pic.png", "보고서_files/pic (2).png", "보고서_files/doc.pdf"], "{md}");
        for t in &targets {
            assert!(out.path().join(t).is_file(), "link {t} must resolve");
        }
        let mut copies = vec![std::fs::read(out.path().join(&targets[0])).unwrap(), std::fs::read(out.path().join(&targets[1])).unwrap()];
        copies.sort();
        assert_eq!(copies, vec![b"one".to_vec(), b"two".to_vec()], "same-named attachments are two different files");
        // tmp 파일이 남지 않는다 · exported_at 을 찍는다.
        assert_eq!(names_in(out.path()), vec!["보고서.md", "보고서_files"]);
        let exported: Option<String> = conn.query_row("SELECT exported_at FROM notes WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(exported.as_deref(), Some(res.exported_at.as_str()));
    }

    /// 같은 파일로 다시 내보내면(저장 대화상자에서 바꾸기) 첨부 폴더의 같은 이름을 덮어쓴다 — 복사본이 ` (2)` 로 쌓이거나
    /// 링크가 옛 파일을 가리키지 않는다.
    #[test]
    fn export_note_reexport_to_the_same_file_overwrites_attachment_copies_and_keeps_links_matching() {
        let (data, mut conn, id) = md_export_fixture("n");
        add_file_att(&mut conn, data.path(), &id, "pic.png", b"v1");
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("x.md");
        export_note(&mut conn, data.path(), &id, &dest).unwrap();
        export_note(&mut conn, data.path(), &id, &dest).unwrap();
        assert_eq!(names_in(&out.path().join("x_files")), vec!["pic.png"]);
        let md = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(md_link_targets(&md), vec!["x_files/pic.png"]);
        assert_eq!(names_in(out.path()), vec!["x.md", "x_files"]);
    }

    /// 원본이 없는 첨부는 복사하지 않고 이름만 적는다(없는 파일을 가리키는 링크를 만들지 않는다). 복사한 것이 없으면 빈 `_files` 도 없다.
    #[test]
    fn export_note_lists_attachments_with_missing_sources_by_name_and_makes_no_empty_files_dir() {
        let (data, mut conn, id) = md_export_fixture("n");
        add_file_att(&mut conn, data.path(), &id, "gone.png", b"x");
        let rel: String = conn.query_row("SELECT rel_path FROM attachments WHERE note_id=?1", [&id], |r| r.get(0)).unwrap();
        std::fs::remove_file(db::attachments_dir(data.path()).join(rel)).unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("x.md");
        export_note(&mut conn, data.path(), &id, &dest).unwrap();
        let md = std::fs::read_to_string(&dest).unwrap();
        assert!(md.contains("- gone.png\n") && md_link_targets(&md).is_empty(), "{md}");
        assert_eq!(names_in(out.path()), vec!["x.md"]);
    }

    #[test]
    fn export_note_rejects_a_folder_or_empty_destination_and_unknown_notes() {
        let (data, mut conn, id) = md_export_fixture("n");
        let out = tempfile::tempdir().unwrap();
        assert!(matches!(export_note(&mut conn, data.path(), &id, out.path()), Err(AppError::Validation(_))));
        assert!(matches!(export_note(&mut conn, data.path(), &id, Path::new("")), Err(AppError::Validation(_))));
        // 옛 html 호출(`format` 인자는 IPC 에서 조용히 버려진다)이 마크다운을 .html 에 쓰지 않게.
        for html in ["a.html", "a.HTM"] {
            assert!(matches!(export_note(&mut conn, data.path(), &id, &out.path().join(html)), Err(AppError::Validation(_))), "{html}");
        }
        assert!(matches!(export_note(&mut conn, data.path(), "no-such-note", &out.path().join("a.md")), Err(AppError::NotFound(_))));
        let exported: Option<String> = conn.query_row("SELECT exported_at FROM notes WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert!(exported.is_none(), "a rejected export must not stamp exported_at");
        assert!(names_in(out.path()).is_empty());
    }

    /// 폴더 단위는 Markdown 만 — 노트마다 `{슬러그}.md` + `{그 stem}_files/`. 같은 제목은 ` (2)` 가 붙고 첨부 폴더도 그 이름을
    /// 따라 서로 섞이지 않는다.
    #[test]
    fn export_folder_writes_one_md_per_note_with_its_own_attachment_folder() {
        let (data, mut conn, a) = md_export_fixture("같은 제목");
        let folder_id: String = conn.query_row("SELECT folder_id FROM notes WHERE id=?1", [&a], |r| r.get(0)).unwrap();
        let b = notes::create(&mut conn, &folder_id, Some("같은 제목".into()), None).unwrap().note.id;
        add_file_att(&mut conn, data.path(), &a, "pic.png", b"A");
        add_file_att(&mut conn, data.path(), &b, "pic.png", b"B");
        let out = tempfile::tempdir().unwrap();
        let conn = Mutex::new(conn);
        let res = export_folder_shared(&conn, data.path(), &folder_id, out.path()).unwrap();
        assert_eq!(res.skipped_count, 0);
        let dir = Path::new(&res.written_dir);
        let mds: Vec<String> = names_in(dir).into_iter().filter(|n| n.ends_with(".md")).collect();
        assert_eq!(res.exported_count as usize, mds.len());
        assert!(mds.contains(&"같은 제목.md".to_string()) && mds.contains(&"같은 제목 (2).md".to_string()), "{mds:?}");
        let mut copies = Vec::new();
        for name in ["같은 제목.md", "같은 제목 (2).md"] {
            let md = std::fs::read_to_string(dir.join(name)).unwrap();
            let targets = md_link_targets(&md);
            let stem = name.trim_end_matches(".md");
            assert_eq!(targets, vec![format!("{stem}_files/pic.png")], "{md}");
            copies.push(std::fs::read(dir.join(&targets[0])).unwrap());
        }
        copies.sort();
        assert_eq!(copies, vec![b"A".to_vec(), b"B".to_vec()], "each note links its own copy");
    }

    /// R-1: 휴지통(deleted_at) 노트는 폴더 내보내기에 되살아나지 않는다 — 파일도 없고 exported_at 도 안 찍힌다.
    /// 그리고 export_note(Mutex) 는 exported_at 을 찍는다.
    #[test]
    fn export_folder_skips_trashed_notes_and_export_note_stamps_exported_at() {
        let (data, mut conn, a) = md_export_fixture("살아있는 노트");
        let folder_id: String = conn.query_row("SELECT folder_id FROM notes WHERE id=?1", [&a], |r| r.get(0)).unwrap();
        let trashed = notes::create(&mut conn, &folder_id, Some("지운 노트".into()), None).unwrap().note.id;
        conn.execute("UPDATE notes SET deleted_at=?1 WHERE id=?2", params!["2020-01-01T00:00:00Z", trashed]).unwrap();
        let conn = Mutex::new(conn);
        let out = tempfile::tempdir().unwrap();
        let res = export_folder_shared(&conn, data.path(), &folder_id, out.path()).unwrap();
        let mds: Vec<String> = names_in(Path::new(&res.written_dir)).into_iter().filter(|n| n.ends_with(".md")).collect();
        assert_eq!(mds, vec!["살아있는 노트.md".to_string()], "휴지통 노트는 파일이 되면 안 된다");
        assert_eq!((res.exported_count, res.skipped_count), (1, 0));
        let stamp = |id: &str| -> Option<String> {
            conn.lock().query_row("SELECT exported_at FROM notes WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        assert!(stamp(&a).is_some());
        assert!(stamp(&trashed).is_none());

        let dest = out.path().join("single.md");
        let r = export_note_shared(&conn, data.path(), &a, &dest).unwrap();
        assert!(dest.is_file());
        assert_eq!(stamp(&a), Some(r.exported_at));
    }

    /// 결함 재현(W6 검증 V1): `x.md` 는 없는데 `x_files/` 가 이미 있으면(브라우저 "웹 페이지 전체 저장"이 만드는 바로 그 이름)
    /// 저장 대화상자는 아무것도 묻지 않는다 — 예전엔 그 폴더의 같은 이름 파일을 조용히 덮어썼다. 이제 새 폴더(`x_files-1`)에 쓰고,
    /// 같은 `x.md` 로 다시 내보내도(바꾸기 확인) 그 파일이 가리키던 `x_files-1` 을 다시 쓴다 — 남의 `x_files` 로 돌아가지 않는다.
    #[test]
    fn export_note_never_overwrites_an_attachment_folder_it_did_not_write() {
        let (data, mut conn, id) = md_export_fixture("n");
        add_file_att(&mut conn, data.path(), &id, "pic.png", b"ours");
        let out = tempfile::tempdir().unwrap();
        let theirs = out.path().join("x_files");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(theirs.join("pic.png"), b"unrelated user file").unwrap();
        let dest = out.path().join("x.md");
        for _ in 0..2 {
            export_note(&mut conn, data.path(), &id, &dest).unwrap();
            assert_eq!(std::fs::read(theirs.join("pic.png")).unwrap(), b"unrelated user file");
            let md = std::fs::read_to_string(&dest).unwrap();
            assert_eq!(md_link_targets(&md), vec!["x_files-1/pic.png"], "{md}");
            assert_eq!(std::fs::read(out.path().join("x_files-1").join("pic.png")).unwrap(), b"ours");
            assert_eq!(names_in(out.path()), vec!["x.md", "x_files", "x_files-1"]);
        }
        // 바꾸는 `x.md` 가 남의 것(그 폴더를 가리키지 않는다)이어도 같다 — 확인한 건 그 파일 하나를 바꾸는 일뿐이다.
        let other = out.path().join("y.md");
        std::fs::write(&other, "# 남의 노트\n").unwrap();
        let theirs_y = out.path().join("y_files");
        std::fs::create_dir_all(&theirs_y).unwrap();
        std::fs::write(theirs_y.join("pic.png"), b"y's").unwrap();
        export_note(&mut conn, data.path(), &id, &other).unwrap();
        assert_eq!(std::fs::read(theirs_y.join("pic.png")).unwrap(), b"y's");
        assert_eq!(md_link_targets(&std::fs::read_to_string(&other).unwrap()), vec!["y_files-1/pic.png"]);
    }

    /// 결함 재현(W6 검증 V1): `rel_path` 뒤쪽 컴포넌트의 드라이브 문자(`n1/C:Cargo.toml` — 가져온 번들이 넣을 수 있다)를 예전
    /// `safe_rel` 이 `C:Cargo.toml`(드라이브 상대 경로)로 돌려줘, 첨부 루트 밖 파일이 `_files/` 로 복사되고 각주 본문으로 실렸다.
    /// cargo test 의 cwd 가 `src-tauri` 라 수정 전엔 이 크레이트의 Cargo.toml 이 새어 나왔다 — 드라이브 상대 경로라 Windows 에서만 재현된다
    /// (경로 규칙 자체는 `paths::tests` 가 OS 와 무관하게 본다).
    #[cfg(windows)]
    #[test]
    fn export_note_never_reads_outside_the_attachment_root_through_a_drive_letter_in_rel_path() {
        use crate::repo::{attachments, sections};
        let (data, mut conn, id) = md_export_fixture("n");
        add_file_att(&mut conn, data.path(), &id, "pic.png", b"img");
        let fnote = attachments::add_footnote(&mut conn, data.path(), &id, "각주 본문", Some("앵커")).unwrap();
        let body = format!("<span data-footnote=\"{}\">앵커</span>\n", fnote.id);
        sections::create_with_body_and_kind(&mut conn, &id, None, body, Some("text".into())).unwrap();
        conn.execute("UPDATE attachments SET rel_path='n1/C:Cargo.toml' WHERE note_id=?1", [&id]).unwrap();
        assert!(Path::new("Cargo.toml").is_file(), "precondition: cwd is the crate root");
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("x.md");
        export_note(&mut conn, data.path(), &id, &dest).unwrap();
        let md = std::fs::read_to_string(&dest).unwrap();
        assert!(!md.contains("[package]"), "{md}");
        assert!(md.contains("- pic.png\n") && md_link_targets(&md).is_empty(), "{md}");
        assert_eq!(names_in(out.path()), vec!["x.md"], "nothing copied from outside the root");
    }

    #[test]
    fn export_section_md_missing_section_is_not_found() {
        let conn = export_test_db();
        let dir = std::env::temp_dir().join(format!("brise-section-md-missing-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.md");

        let err = export_section_md(&conn, "does-not-exist", &dest).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        std::fs::remove_dir_all(&dir).ok();
    }
}

