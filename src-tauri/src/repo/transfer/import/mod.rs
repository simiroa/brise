// repo::transfer::import — 번들 가져오기(4개 독립 모드). R4에서 디렉터리 모듈로 분리:
// mod.rs(진입점 import_bundle + mode enum 파싱 + insert_all/copy_attachments 등 공유 glue),
// replace_merge.rs(replace+merge 알고리즘), add_notebook.rs(remap_bundle_ids 기반 신규 노트북
// 추가), hash_merge.rs(콘텐츠 해시 병합). 외부에는 기존과 동일하게 `import_bundle`/`ImportResult`
// 만 노출된다(transfer::mod.rs의 재수출 경로 불변).
use crate::db::{self, migrations};
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::repo::fts;
use crate::util::new_id;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::bundle::{
    AttachmentRow, Bundle, CalendarMarkHideRow, KvRow, NoteDateRow, NoteRegionRow, NoteRelatedExclusionRow, NoteRow,
    RoutineCompletionRow, SectionRow, SourceRow, SpaceItemRow, SpaceRow, TagRow, TimelineRoutineRow,
    WorkspaceSettingRow,
};

mod add_notebook;
mod extras;
mod hash_merge;
mod replace_merge;

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub imported_notes: i64,
    pub skipped: i64,
    /// `replace` 만 채운다 — 지우기 전에 찍은 안전 스냅샷(db::snapshot_backup) 경로.
    /// 설정 창이 복원·초기화와 같은 "스냅샷을 저장했습니다" 대화상자로 보여 준다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// mode: &str 를 한 번만 파싱한 내부 enum — 외부 커맨드 시그니처(mode: &str)는 그대로 두고
/// (specs/commands 계약 불변), 진입점 안쪽에서만 stringly dispatch를 걷어낸다.
enum Mode {
    Merge,
    Replace,
    AddNotebook,
    HashMerge,
}

impl Mode {
    fn parse(s: &str) -> AppResult<Self> {
        match s {
            "merge" => Ok(Mode::Merge),
            "replace" => Ok(Mode::Replace),
            "add_notebook" => Ok(Mode::AddNotebook),
            "hash_merge" => Ok(Mode::HashMerge),
            _ => Err(AppError::Validation(format!("unknown mode: {s}"))),
        }
    }
}

/// Import a `brise-bundle.json` (+ sibling `attachments/`).
///
/// Modes:
/// - `merge` — keep existing rows; skip notes whose id already exists (legacy id-based).
/// - `replace` — wipe DB and rebuild from the bundle.
/// - `add_notebook` — remap **all** notebook/folder/note ids to new ids so the bundle lands as
///   one (or more) brand-new notebook(s) with zero collision risk. Same bundle twice = two
///   notebooks (integrity-first).
/// - `hash_merge` — merge into an existing notebook (`target_workspace_id`) by content hash
///   (title + ordered section bodies). Same hash → skip. Different hash → add as a new note
///   unless `update_existing` is true (then same-title notes are updated in place).
pub fn import_bundle(
    conn: &mut Connection,
    data_dir: &Path,
    bundle_path: &Path,
    mode: &str,
    target_workspace_id: Option<&str>,
    update_existing: bool,
) -> AppResult<ImportResult> {
    let parsed_mode = Mode::parse(mode)?;
    let raw = std::fs::read_to_string(bundle_path).map_err(io)?;
    let bundle: Bundle = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("bundle schema mismatch: {e}")))?;

    // 버전 게이트 — backup_restore(repo/transfer/backup.rs)와 동일 원칙: 번들이 이 앱보다 새
    // 스키마에서 만들어졌으면 fail-closed 거부한다. 반드시 mode 분기(merge/replace) 이전, 즉
    // replace 의 snapshot_backup/wipe 를 포함한 어떤 파괴적 단계보다도 먼저 — 그래야 거부된
    // import 가 기존 DB 를 조금도 건드리지 않는다. 같거나 오래된 버전은 허용(구버전 번들은
    // insert_all 이 현재 스키마 컬럼 그대로 넣고, 없는 신규 컬럼은 NoteRow 등의 #[serde(default)]
    // 가 메꾼다). 메시지는 프론트 Toast(components/Toast.tsx)가 지금 AppError.message 를 그대로
    // 보여주므로(번역 레이어 없음) 그 자체로 사람이 읽을 수 있게 쓴다 — i18n/{en,ko,fr}.json 의
    // settings.import_version_newer 에 번역문을 함께 남겨뒀다(DataManagementSection.tsx 가 이
    // 에러를 감지해 그 키로 옮겨붙이는 배선은 이 변경 범위 밖 — 그 파일은 다른 에이전트 소유).
    let cur = migrations::current_version(conn)?;
    if bundle.version > cur {
        return Err(AppError::Validation(format!(
            "This bundle requires a newer version of Brise (bundle schema {}, this app supports {}). Update Brise, then try importing again.",
            bundle.version, cur
        )));
    }
    for a in &bundle.attachments {
        if let Some(rel) = &a.rel_path {
            crate::repo::paths::safe_rel(rel)?;
        }
    }
    // Space image source_id is an attachments/-relative path. Fail-closed on escape
    // the same way note attachments do — a missing file is fine (broken-image
    // tombstone) but a path that walks out of attachments/ is not.
    for i in &bundle.space_items {
        if i.kind == "image" {
            if let Some(rel) = &i.source_id {
                crate::repo::paths::safe_rel(rel)?;
            }
        }
    }

    let bundle_dir = bundle_path.parent().unwrap_or(Path::new("."));
    let bundle_att = bundle_dir.join("attachments");
    let data_att = db::attachments_dir(data_dir);

    match parsed_mode {
        Mode::AddNotebook => add_notebook::import_add_notebook(conn, data_dir, &bundle, &bundle_att, &data_att),
        Mode::HashMerge => {
            let target = target_workspace_id.ok_or_else(|| {
                AppError::Validation(
                    "hash_merge requires target_workspace_id (the notebook to merge into)".into(),
                )
            })?;
            hash_merge::import_hash_merge(
                conn,
                data_dir,
                &bundle,
                &bundle_att,
                &data_att,
                target,
                update_existing,
            )
        }
        Mode::Replace => replace_merge::import_replace(conn, data_dir, &bundle, &bundle_att, &data_att),
        Mode::Merge => replace_merge::import_merge(conn, data_dir, bundle, &bundle_att, &data_att),
    }
}

// ── add_notebook / hash_merge 공용: 태그 이름-머지 (두 알고리즘 모두 사용) ─────────────
/// Resolve each bundle tag to an existing (name match, COLLATE NOCASE) or freshly-created id.
/// Returns map: bundle_tag_id → local_tag_id. Does **not** insert yet — caller inserts after
/// building the remapped bundle (so OR IGNORE / INSERT order stays under one transaction).
fn plan_tag_merge(
    tx: &rusqlite::Transaction,
    tags: &[TagRow],
) -> AppResult<HashMap<String, String>> {
    let mut tag_id_map: HashMap<String, String> = HashMap::new();
    // Within the bundle, collapse same-name tags onto the first id we saw.
    let mut name_to_local: HashMap<String, String> = HashMap::new();
    for t in tags {
        let key = t.name.to_lowercase();
        if let Some(local) = name_to_local.get(&key) {
            tag_id_map.insert(t.id.clone(), local.clone());
            continue;
        }
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                [&t.name],
                |r| r.get(0),
            )
            .optional()
            .map_err(dberr)?;
        let local_id = existing.unwrap_or_else(new_id);
        name_to_local.insert(key, local_id.clone());
        tag_id_map.insert(t.id.clone(), local_id);
    }
    Ok(tag_id_map)
}

fn insert_tags_from_map(
    tx: &rusqlite::Transaction,
    tags: &[TagRow],
    tag_id_map: &HashMap<String, String>,
) -> AppResult<()> {
    let mut seen: HashSet<String> = HashSet::new();
    for t in tags {
        let Some(local_id) = tag_id_map.get(&t.id) else {
            continue;
        };
        if !seen.insert(local_id.clone()) {
            continue;
        }
        // Skip if already present under that id (name-merge hit an existing row).
        let exists: bool = tx
            .query_row("SELECT 1 FROM tags WHERE id=?1", [local_id], |_| Ok(true))
            .ok()
            .unwrap_or(false);
        if exists {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO tags(id, name) VALUES (?1,?2)",
            params![local_id, t.name],
        )
        .map_err(dberr)?;
    }
    Ok(())
}


// ── replace_merge / add_notebook / hash_merge 공용 삽입 헬퍼 ──────────────────────
/// replace/merge 전용: 이 두 모드는 note id 를 그대로 보존하므로 rel_path 는 번들 안 경로와
/// 저장 대상 경로가 항상 동일하다. 실제 복사는 copy_attachments_remapped 로 위임.
pub(crate) fn copy_attachments(atts: &[AttachmentRow], from: &Path, to: &Path) -> AppResult<()> {
    let pairs: Vec<(String, String)> = atts
        .iter()
        .filter_map(|a| a.rel_path.clone().map(|rp| (rp.clone(), rp)))
        .collect();
    copy_attachments_remapped(&pairs, from, to)
}

/// add_notebook/hash_merge 전용: 이 두 모드는 가져온 노트에 새 note_id 를 발급하지만, 번들 안
/// 첨부 파일은 여전히 옛 note_id 로 된 디렉토리(`{old_note_id}/file.png`)에 있다. 소스 경로
/// (번들 기준, 옛 id)와 대상 경로(DB 에 실제로 쓰인 rel_path, 새 id)가 갈라지므로 쌍으로 받는다
/// — pairs 는 (원본 rel_path, remap_attachment_rel_path 를 거친 새 rel_path).
pub(crate) fn copy_attachments_remapped(
    pairs: &[(String, String)],
    from: &Path,
    to: &Path,
) -> AppResult<()> {
    for (src_rel, dst_rel) in pairs {
        let safe_src = crate::repo::paths::safe_rel(src_rel)?;
        let src = from.join(&safe_src);
        if src.exists() {
            let safe_dst = crate::repo::paths::safe_rel(dst_rel)?;
            let dst = to.join(&safe_dst);
            // 노트북 복제(duplicate_notebook)는 데이터 폴더가 곧 번들 폴더라, 노트 id 로 시작하지 않는
            // 예전 평평한 경로(`file.txt`)는 원본과 대상이 같은 파일이다 — 자기 자신 위로 복사하면
            // Windows 가 os error 32 로 막는다. 그 파일은 두 노트북이 함께 쓴다(ponytail: 한쪽이 지우면
            // 다른 쪽도 잃는다 — 평평한 경로는 옛 픽스처류라 드묾).
            if src == dst {
                continue;
            }
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).map_err(io)?;
            }
            std::fs::copy(&src, &dst).map_err(io)?;
        }
    }
    Ok(())
}

/// add_notebook/hash_merge 공유: 노트가 새 id 를 받을 때 첨부 rel_path 의 선두 세그먼트
/// (`{old_note_id}/...`)를 새 id 로 다시 쓴다. 첫 세그먼트가 old_note_id 와 다르면(맨 파일명만
/// 있는 예전 픽스처류 `file.txt`) 손대지 않고 그대로 둔다 — merge/replace 는 note id 를 보존해
/// 이 함수를 호출조차 하지 않는다.
pub(crate) fn copy_space_images(items: &[SpaceItemRow], from: &Path, to: &Path) -> AppResult<()> {
    copy_attachments_remapped(
        &crate::repo::canvas_page_image::identity_copy_pairs(items),
        from,
        to,
    )
}

pub(crate) fn copy_space_images_remapped(
    orig: &[SpaceItemRow],
    space_map: &HashMap<String, String>,
    from: &Path,
    to: &Path,
) -> AppResult<()> {
    copy_attachments_remapped(
        &crate::repo::canvas_page_image::remapped_copy_pairs(orig, space_map),
        from,
        to,
    )
}

/// Remap kind='note' via note ids and kind='image' via space ids. Unmapped keys stay
/// (tombstone card / broken image) — never drop the row.
pub(crate) fn remap_space_item_source_id(
    kind: &str,
    source_id: Option<String>,
    note_map: &HashMap<String, String>,
    space_map: &HashMap<String, String>,
) -> Option<String> {
    match kind {
        "note" => source_id.map(|sid| note_map.get(&sid).cloned().unwrap_or(sid)),
        "image" => source_id.map(|sid| crate::repo::canvas_page_image::remap_source_id(&sid, space_map)),
        _ => source_id,
    }
}

pub(crate) fn remap_attachment_rel_path(rel_path: &str, old_note_id: &str, new_note_id: &str) -> String {
    match rel_path.split_once('/') {
        Some((first, rest)) if first == old_note_id => format!("{new_note_id}/{rest}"),
        _ => rel_path.to_string(),
    }
}

/// kind='chart' 첨부의 url 은 `"<section_id>#<chart_id>"` 다(repo/attachments::add_chart_ref).
/// 가져오기가 섹션 id 를 새로 발급하면(add_notebook 의 section_map, hash_merge 의 새 노트 분기)
/// 앞부분도 같이 옮겨야 프리뷰가 "원본 없음"이 아니라 차트를 그린다. 맵에 없는 섹션(번들 밖)은
/// 그대로 둔다 — internal url 의 `note_map.get(u).unwrap_or(u)` 와 같은 규칙.
pub(crate) fn remap_chart_url(url: &str, section_map: &HashMap<String, String>) -> String {
    match url.split_once('#') {
        Some((sec, chart)) => match section_map.get(sec) {
            Some(new_sec) => format!("{new_sec}#{chart}"),
            None => url.to_string(),
        },
        None => url.to_string(),
    }
}

/// 본문 속 인라인 이미지 경로를 새 첨부 경로로 다시 쓴다. 에디터는 이미지를
/// `![alt]({note_id}/{stored_name}){width=…}`(옛 본문은 `<img data-rel-path="…">`)로 저장한다 — 첨부의
/// rel_path 를 **글자 그대로** 적는다(src/components/editor/imageExtension.ts). add_notebook 은 첨부
/// 행과 파일을 새 note_id 디렉토리로 옮기는데(remap_attachment_rel_path) 본문의 같은 문자열은 그대로
/// 두고 있었다: 복제본의 이미지는 **원본 노트의 파일**을 가리켜 원본을 비우는 순간 깨지고, 다른
/// 기기로 가져온 노트북은 그 디렉토리가 아예 없어 처음부터 깨진 이미지였다(2026-09-20, 스냅샷
/// 복제 검토 중 발견).
///
/// `rel_map` = 옛 rel_path → 새 rel_path, **이번 번들의 첨부 행에서만** 만든다. note_id 접두어를
/// 통째로 바꾸지 않고 rel_path 전체 문자열만 짚는 이유: stored_name 은 `{8자 id}-{정규화된 이름}`
/// 이라(attachments::normalize_stored_name — 공백·괄호 없음) 마크다운에서 인코딩 없이 그대로 나오고,
/// 실제로 옮겨진 파일만 정확히 고치므로 본문의 다른 글자를 건드릴 일이 없다.
pub(crate) fn rewrite_attachment_rel_paths(text: &str, rel_map: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (old, new) in rel_map {
        if out.contains(old.as_str()) {
            out = out.replace(old.as_str(), new);
        }
    }
    out
}

/// `note://<old>` 위키링크를 새 id 로 다시 쓴다(자유 텍스트 안의 링크 문법 — 구조화 JSON 필드
/// remap 은 다른 문제라 extras.rs::remap_pet_message_meta_note_ids 가 따로 담당한다, 그쪽 주석
/// 참고). add_notebook::remap_bundle_ids 의 섹션 본문(body_md)과 extras::remap_notebook_extras 의
/// 펫 대화 원문(pet_messages.text) 이 공유한다 — 펫 채팅창은 TipTap 에디터가 아니라 일반 텍스트
/// 입력이라 앱이 note:// 링크를 직접 넣지는 않지만, 노트 본문에서 복사해 붙여넣으면 그대로
/// 들어올 수 있어 같은 규칙을 방어적으로 적용한다.
pub(crate) fn rewrite_note_links(text: &str, note_map: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (old, new) in note_map {
        let from = format!("note://{old}");
        let to = format!("note://{new}");
        if out.contains(&from) {
            out = out.replace(&from, &to);
        }
    }
    out
}

/// 가져오기 후 정합성 보정: `internal` 첨부는 url 컬럼에 대상 note id 를 담는데, 부분/단일
/// export 로 만든 번들은 그 대상 노트가 번들에 포함되지 않은 채로 internal 링크만 들어올 수
/// 있다. export-all 은 전체 노트를 포함하므로 안전하지만, 부분 번들을 그대로 삽입하면 가져온
/// DB 안에 죽은 note id 를 가리키는 internal 링크가 남는다 (notes::delete 의 동일 문제와
/// 대칭). 삽입이 끝난 뒤 같은 트랜잭션 안에서 한 번에 정리한다.
/// G2(docs/SYNC.md): notes::purge 의 dangling-internal 정리와 동일한 모양 — CASCADE 가 아니라
/// 명시적 삭제이므로 지워지는 각 첨부 행을 직접 tombstone 한다.
pub(crate) fn prune_dangling_internal(tx: &rusqlite::Transaction) -> AppResult<()> {
    let dangling_ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM attachments WHERE kind='internal' AND url NOT IN (SELECT id FROM notes)")
            .map_err(dberr)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(dberr)?;
        rows.collect::<Result<_, _>>().map_err(dberr)?
    };
    tx.execute(
        "DELETE FROM attachments WHERE kind='internal' AND url NOT IN (SELECT id FROM notes)",
        [],
    )
    .map_err(dberr)?;
    for id in &dangling_ids {
        crate::repo::tombstone::record_tombstone(tx, "attachments", id)?;
    }
    Ok(())
}

/// G2(docs/SYNC.md) 예외: 이 함수는 의도적으로 tombstone 을 남기지 않는다 — bundle replace-import
/// (import_bundle mode="replace")에서 이 전체 삭제 직후 항상 insert_all(번들 재삽입)이 뒤따른다.
/// (db_reset 은 2026-10-26 부터 이 함수를 쓰지 않는다 — 빈 DB 로 통째 스왑, reset.rs. 결과는 같다:
/// 새 DB 의 deleted_rows 는 비어 있다.) 즉 이 함수는 "행 하나를
/// 지운다"가 아니라 "로컬 상태 전체를 다른 스냅샷으로 교체한다"는 의미라, 지워지는 개별 행마다
/// tombstone 을 남기면 오히려 왜곡된다(예: replace-import는 새 번들의 행 id 들을 곧바로 다시
/// 살려내므로 "삭제됐다"는 신호 자체가 거짓이 된다). 로컬 전체 교체는 Phase 2 동기화 설계
/// 시점에 별도 전략(예: 풀싱크 폴백)으로 다뤄야 한다.
///
/// 같은 이유로 기존 deleted_rows 도 함께 비운다 — 복원된 스냅샷이 새 진실인데 복원 이전의
/// tombstone 이 살아남으면, 백업 이후에 지웠던 행을 복원으로 되살렸을 때 Phase 2 LWW 가
/// "삭제가 더 최신"으로 판정해 복원한 행을 다시 지우는 버그가 된다.
/// 이 설치본의 비밀 설정(AI 키·키 보관함·동기화 토큰 등) 읽기. 번들/백업에는 비밀이 실리지 않으므로
/// (export::is_secret_setting_key) 전체 교체 뒤에는 이 값이 통째로 사라진다 — 교체 전에 읽어 두었다가
/// `restore_secret_settings` 로 되돌린다. wipe 자체는 비밀을 보존하지 않는다(호출자가 고른다 — db_reset 은 이월하지 않는다).
pub(crate) fn read_secret_settings(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(dberr)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(dberr)?;
    let mut out = Vec::new();
    for row in rows {
        let (k, v) = row.map_err(dberr)?;
        if super::export::is_secret_setting_key(&k) {
            out.push((k, v));
        }
    }
    Ok(out)
}

pub(crate) fn restore_secret_settings(conn: &Connection, secrets: &[(String, String)]) -> AppResult<()> {
    for (k, v) in secrets {
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?1, ?2)", rusqlite::params![k, v])
            .map_err(dberr)?;
    }
    Ok(())
}

pub(crate) fn wipe(tx: &rusqlite::Transaction) -> AppResult<()> {
    fts::clear_all(tx)?;
    for sql in [
        "DELETE FROM deleted_rows",
        "DELETE FROM routine_completions",
        "DELETE FROM space_items",
        "DELETE FROM spaces",
        "DELETE FROM note_related_exclusions",
        "DELETE FROM note_regions",
        "DELETE FROM note_dates",
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
        "DELETE FROM workspace_settings",
        "DELETE FROM timeline_routines",
        "DELETE FROM calendar_mark_hides",
        "DELETE FROM calendar_marks",
        "DELETE FROM calendar_sources",
        "DELETE FROM workspaces",
        "DELETE FROM settings",
    ] {
        tx.execute(sql, []).map_err(dberr)?;
    }
    Ok(())
}

/// 노트북 복제(PLAN-2026-09-19-notebook-settings §3) — 노트·설정·반복 일정·표시일까지 통째로, 새 id 로.
/// "노트북 내보내기 → 새 노트북으로 가져오기" 를 파일 없이 한 번에 한다: 같은 dump_workspace 와
/// add_notebook 경로를 타므로 id 재매핑·첨부 경로 재매핑·태그 병합 규칙이 가져오기와 똑같다. 첨부 원본은
/// 데이터 폴더 자신이 번들 폴더 역할을 한다(내보내기가 같은 상대 경로로 복사하는 구조라 그대로 맞는다).
/// ponytail: 배경 이미지 파일은 복사하지 않는다(아이콘만 옮긴다) — 필요하면 workspace_bg/{id}/ 를 복사.
///
/// 2026-09-20 오너 결정("펫 대화·수집 소스도 복제에 포함해줘"): pet_sessions/pet_messages/
/// collect_sources/collect_seen 도 함께 옮긴다. 이 넷은 Bundle(파일 번들 포맷)에는 절대 안 싣는다
/// (extras.rs 헤더 참고 — 내보낸 파일이 다른 사람에게 AI 대화 이력을 몰래 나르면 안 된다) —
/// duplicate_notebook 이 파일을 거치지 않는 유일한 add_notebook 경로라, extras 를 따로 읽어
/// add_notebook 과 **같은 트랜잭션** 안에서 넣는다(import_add_notebook_with_extras).
pub fn duplicate_notebook(
    conn: &mut Connection,
    data_dir: &Path,
    workspace_id: &str,
    new_name: &str,
) -> AppResult<String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::Validation("workspace name is empty".into()));
    }
    let mut bundle = super::export::dump_workspace(conn, workspace_id)?;
    if let Some(ws) = bundle.workspaces.first_mut() {
        ws.name = new_name.to_string();
    }
    let data_att = db::attachments_dir(data_dir);
    let extras = extras::dump_notebook_extras(conn, workspace_id)?;
    let (new_id, _result) = add_notebook::import_add_notebook_with_extras(conn, data_dir, &bundle, &data_att, &data_att, &extras)?;
    conn.execute(
        "UPDATE workspaces SET icon = (SELECT icon FROM workspaces WHERE id=?1) WHERE id=?2",
        params![workspace_id, new_id],
    )
    .map_err(dberr)?;
    Ok(new_id)
}

pub(crate) fn insert_all(tx: &rusqlite::Transaction, b: &Bundle) -> AppResult<()> {
    for ws in &b.workspaces {
        tx.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?1,?2,?3)",
            params![ws.id, ws.name, ws.created_at],
        )
        .map_err(dberr)?;
    }
    for r in &b.workspace_regions {
        tx.execute(
            "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![r.id, r.workspace_id, r.name, r.position, r.created_at],
        )
        .map_err(dberr)?;
    }
    for e in &b.workspace_eras {
        tx.execute(
            "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![e.id, e.workspace_id, e.name, e.from_year, e.to_year, e.position, e.created_at],
        )
        .map_err(dberr)?;
    }
    for s in &b.workspace_statuses {
        tx.execute(
            "INSERT INTO workspace_statuses(id, workspace_id, name, position, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![s.id, s.workspace_id, s.name, s.position, s.created_at],
        )
        .map_err(dberr)?;
    }
    for f in &b.folders {
        tx.execute(
            "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![f.id, f.workspace_id, f.name, f.position, f.is_open, f.created_at, f.color_hue, f.icon, f.rules, f.search_excluded, f.ai_excluded],
        )
        .map_err(dberr)?;
    }
    for t in &b.tags {
        tx.execute(
            "INSERT INTO tags(id, name) VALUES (?1,?2)",
            params![t.id, t.name],
        )
        .map_err(dberr)?;
    }
    for n in &b.notes {
        insert_note(tx, n)?;
    }
    for s in &b.sections {
        insert_section(tx, s)?;
    }
    for s in &b.sources {
        insert_source(tx, s)?;
    }
    for a in &b.attachments {
        insert_attachment(tx, a)?;
    }
    for r in &b.note_regions {
        insert_note_region(tx, r)?;
    }
    for d in &b.note_dates {
        insert_note_date(tx, d)?;
    }
    for nt in &b.note_tags {
        tx.execute(
            "INSERT INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
            params![nt.note_id, nt.tag_id],
        )
        .map_err(dberr)?;
    }
    for rc in &b.routine_completions {
        insert_routine_completion(tx, rc)?;
    }
    // note_related_exclusions references two notes (id_1, id_2) rather than being owned by one,
    // so — unlike sections/sources/attachments/note_regions above — it can't run until every note
    // in the bundle has been inserted (which just finished a few lines up).
    for x in &b.note_related_exclusions {
        insert_note_related_exclusion(tx, x)?;
    }
    for s in &b.spaces {
        insert_space(tx, s)?;
        tx.execute(
            "UPDATE workspaces SET space_bootstrapped = 1 WHERE id = ?1",
            [&s.workspace_id],
        )
        .map_err(dberr)?;
    }
    for i in &b.space_items {
        insert_space_item(tx, i)?;
    }
    for kv in &b.settings {
        // export.rs::dump() already excludes secret/device-local keys from a bundle it builds
        // itself (is_secret_setting_key/is_device_local_setting_key, export.rs line ~758) — but
        // import_bundle treats the bundle file as untrusted input (that's the whole reason for the
        // validate_setting() fail-closed check right below), so a hand-crafted bundle could still
        // carry ai_api_key/sync_token/device_id/sync_enabled/sync_port. backup.rs::backup_restore
        // already applies this same belt-and-suspenders filter for its own settings restore path
        // (backup.rs ~427); import_bundle didn't, even though it's reachable from the exact same
        // "someone hands me a file" trust boundary. Silently skip rather than fail-closed-reject
        // the whole import — a bundle carrying one of these keys is not itself malformed, it's
        // just a key this device must never adopt from an external source.
        if super::export::is_secret_setting_key(&kv.key) || super::export::is_device_local_setting_key(&kv.key) {
            continue;
        }
        // 노트북 키는 전역에 쓰지 않는다 — 아래 insert_notebook_settings 가 노트북 행으로 옮긴다.
        // 없어진 키(settings_schema::is_retired_setting_key)는 옛 번들에 실려 와도 버린다.
        if crate::repo::settings_schema::is_notebook_setting_key(&kv.key)
            || crate::repo::settings_schema::is_retired_setting_key(&kv.key)
        {
            continue;
        }
        // 번들은 신뢰할 수 없다 — 설정 복원 시 settings_set 과 동일한 검증을 강제한다.
        // (미검증 복원은 dictation_model 경로이탈 등 임의 설정 주입 경로였다.) fail-closed:
        // 파싱 불가/규칙 위반이면 import 전체를 거부한다.
        let parsed: serde_json::Value = serde_json::from_str(&kv.value).map_err(|_| {
            crate::error::AppError::Validation(format!("invalid setting value for {}", kv.key))
        })?;
        crate::repo::settings_schema::validate_setting(&kv.key, &parsed)?;
        tx.execute(
            "INSERT INTO settings(key, value) VALUES (?1,?2)",
            params![kv.key, kv.value],
        )
        .map_err(dberr)?;
    }
    let ws_ids: Vec<String> = b.workspaces.iter().map(|w| w.id.clone()).collect();
    insert_notebook_settings(tx, &b.workspace_settings, &b.settings, &ws_ids)?;
    for r in &b.timeline_routines {
        insert_timeline_routine(tx, r)?;
    }
    insert_calendar(tx, &b.calendar_sources, &b.calendar_marks, &b.calendar_mark_hides, &ws_ids)?;
    Ok(())
}

/// 달력 표시일 세 테이블(replace·add_notebook 공용). 번들은 신뢰할 수 없다 — 이번 가져오기의 노트북
/// 밖을 가리키는 행은 건너뛰고(insert_notebook_settings 와 같은 이유), 표시일은 repo 와 같은 검증을
/// 거친다(깨진 줄은 건너뜀 — 외부 파일 한 줄 때문에 노트북 전체를 버리지 않는다).
pub(crate) fn insert_calendar(
    tx: &rusqlite::Transaction,
    sources: &[crate::models::CalendarSource],
    marks: &[crate::models::CalendarMark],
    hides: &[CalendarMarkHideRow],
    workspace_ids: &[String],
) -> AppResult<()> {
    use crate::repo::calendar_marks::{validate, MarkFields, MARK_COLUMNS, SOURCE_COLUMNS};
    let mut source_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for s in sources.iter().filter(|s| workspace_ids.contains(&s.workspace_id)) {
        tx.execute(
            &format!("INSERT INTO calendar_sources({SOURCE_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"),
            params![s.id, s.workspace_id, s.name, s.url, s.enabled as i64, s.color_hue, s.fetched_at, s.position, s.created_at, s.updated_at],
        )
        .map_err(dberr)?;
        source_ids.insert(s.id.as_str());
    }
    for m in marks.iter().filter(|m| workspace_ids.contains(&m.workspace_id)) {
        if let Some(src) = &m.source_id {
            if !source_ids.contains(src.as_str()) {
                continue;
            }
        }
        let f = MarkFields {
            title: m.title.clone(),
            year: m.year,
            month: m.month,
            day: m.day,
            repeat: m.repeat.clone(),
            lunar: m.lunar,
            day_off: m.day_off,
            color_hue: m.color_hue,
        };
        if validate(&f).is_err() {
            continue;
        }
        tx.execute(
            &format!("INSERT INTO calendar_marks({MARK_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"),
            params![m.id, m.workspace_id, m.source_id, m.uid, m.title.trim(), m.year, m.month, m.day, m.repeat, m.lunar as i64, m.day_off as i64, m.color_hue, m.created_at, m.updated_at],
        )
        .map_err(dberr)?;
    }
    for h in hides.iter().filter(|h| workspace_ids.contains(&h.workspace_id)) {
        if h.source != crate::repo::calendar_marks::BUILTIN_SOURCE && !source_ids.contains(h.source.as_str()) {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO calendar_mark_hides(workspace_id, source, iso_day) VALUES (?1,?2,?3)",
            params![h.workspace_id, h.source, h.iso_day],
        )
        .map_err(dberr)?;
    }
    Ok(())
}

/// 번들의 노트북 설정을 넣는다(replace·add_notebook 공용, PLAN-2026-09-19-notebook-settings §5).
///
/// - `rows` 가 있으면 그것이 진실이다 — `workspace_ids`(이번에 넣는 노트북) 밖을 가리키는 행과
///   노트북 키가 아닌 행은 건너뛰고(손으로 만든 번들이 남의 노트북이나 전역
///   키를 노트북 행으로 밀어 넣지 못하게), 값은 settings_set 과 같은 검증을 fail-closed 로 거친다.
/// - `rows` 가 비었으면 V86 이전 번들이다: 그 번들의 전역 `settings` 에 실린 노트북 키를
///   `workspace_ids` 모든 노트북에 복사한다 — V86 마이그레이션이 기존 설치에 한 것과 같은 규칙.
pub(crate) fn insert_notebook_settings(
    tx: &rusqlite::Transaction,
    rows: &[WorkspaceSettingRow],
    legacy_global: &[KvRow],
    workspace_ids: &[String],
) -> AppResult<()> {
    let put = |ws: &str, key: &str, value: &str| -> AppResult<()> {
        if !crate::repo::settings_schema::is_notebook_setting_key(key) {
            return Ok(());
        }
        let parsed: serde_json::Value = serde_json::from_str(value).map_err(|_| {
            crate::error::AppError::Validation(format!("invalid setting value for {key}"))
        })?;
        crate::repo::settings_schema::validate_setting(key, &parsed)?;
        tx.execute(
            "INSERT OR REPLACE INTO workspace_settings(workspace_id, key, value) VALUES (?1,?2,?3)",
            params![ws, key, value],
        )
        .map_err(dberr)?;
        Ok(())
    };
    if !rows.is_empty() {
        // 이번 가져오기가 만드는 노트북의 행만 받는다. add_notebook 의 id 재매핑은 번들에 없는
        // workspace_id 를 **그대로** 통과시키므로(map_or), 손으로 만든 번들이 이미 있는 내 노트북의 id 를
        // 적어 오면 INSERT OR REPLACE 가 그 노트북 설정을 조용히 덮어쓴다 — 여기서 막는다.
        for r in rows.iter().filter(|r| workspace_ids.contains(&r.workspace_id)) {
            put(&r.workspace_id, &r.key, &r.value)?;
        }
    } else {
        for ws in workspace_ids {
            for kv in legacy_global {
                put(ws, &kv.key, &kv.value)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn insert_timeline_routine(tx: &rusqlite::Transaction, r: &TimelineRoutineRow) -> AppResult<()> {
    tx.execute(
        &format!(
            "INSERT INTO timeline_routines({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            TimelineRoutineRow::COLUMNS
        ),
        params![
            r.id, r.workspace_id, r.title, r.weekday_mask, r.start_time, r.end_time, r.color_hue,
            r.skip_holidays, r.position, r.created_at, r.updated_at
        ],
    )
    .map_err(dberr)?;
    Ok(())
}

pub(crate) fn insert_note(tx: &rusqlite::Transaction, n: &NoteRow) -> AppResult<()> {
    // archived_at (bundle.rs NoteRow 헤더 주석 참조): 이 컬럼이 INSERT 목록에 없으면 번들을 거친
    // 모든 노트가 항상 archived_at=NULL 로 착지해 아카이브 상태가 조용히 사라진다.
    tx.execute(
        "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status, month, day, remind, end_year, end_month, end_day, icon, lat, lng, start_time, end_time, remind_offset_min, rrule, archived_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
        params![n.id, n.folder_id, n.title, n.year, n.is_favorite, n.exported_at, n.created_at, n.updated_at, n.region, n.status, n.month, n.day, n.remind, n.end_year, n.end_month, n.end_day, n.icon, n.lat, n.lng, n.start_time, n.end_time, n.remind_offset_min, n.rrule, n.archived_at],
    )
    .map_err(dberr)?;
    // PLAN-2026-09-08-dates-rebuild.md W1: 가져오기도 노트 생성 경로다 — position=0 행을 함께
    // 심는다(note_dates 가 진실). 번들의 NoteRow.* 를 그대로 미러링한다.
    crate::repo::notes::dates::insert_primary_row(
        tx,
        &n.id,
        n.year,
        n.month,
        n.day,
        n.end_year,
        n.end_month,
        n.end_day,
        n.start_time.as_deref(),
        n.end_time.as_deref(),
        n.remind != 0,
        n.remind_offset_min,
        n.rrule.as_deref(),
        &n.created_at,
    )?;
    Ok(())
}
pub(crate) fn insert_note_region(tx: &rusqlite::Transaction, r: &NoteRegionRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO note_regions(id, note_id, name, lat, lng, position, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![r.id, r.note_id, r.name, r.lat, r.lng, r.position, r.created_at],
    )
    .map_err(dberr)?;
    Ok(())
}
/// PLAN-2026-09-08-dates-rebuild.md W3: 번들의 NoteDateRow 가 이제 트리플+position+시각/알림/반복
/// 전체를 싣는다. **옛 번들 호환**: `year` 가 없는 행(V70~V76 시절, `date`/`end_date` 문자열만
/// 있음)은 그 문자열을 풀어 트리플로 받는다 — 커스텀 Deserialize 없이 두 모양을 한 함수에서
/// 갈라 처리한다(bundle.rs::NoteDateRow 문서 참고). `position` 이 번들에 없으면(옛 개념이거나
/// 신규 병합 경로) 이 노트의 다음 빈 자리(next_position)에 순서대로 붙인다.
///
/// D1 부활(V85, PLAN-2026-09-18-nl-dates.md): `d.label` 을 그대로 싣는다 — V74~V84 번들(필드 없음)
/// 은 `#[serde(default)]` 로 이미 None 이라 자연히 라벨 없이 들어온다(옛 번들이 "사라뜨리던" 라벨이
/// 이제는 애초에 담겨 있지 않을 뿐 에러가 아니다). V85 이후 번들은 label 이 그대로 보존된다.
pub(crate) fn insert_note_date(tx: &rusqlite::Transaction, d: &NoteDateRow) -> AppResult<()> {
    let (year, month, day, end_year, end_month, end_day) = if let Some(year) = d.year {
        (year, d.month, d.day, d.end_year, d.end_month, d.end_day)
    } else if let Some(ref date) = d.date {
        let Some(start) = crate::repo::notes::dates::parse_date(date) else {
            // 손상된 번들 방어선 — date_add 관문을 이미 통과했을 값이지만, 손상됐으면 이 한 행만
            // 조용히 건너뛴다(패닉/import 전체 실패 대신).
            return Ok(());
        };
        let end = d.end_date.as_deref().and_then(crate::repo::notes::dates::parse_date);
        (
            start.y, Some(start.m as i64), Some(start.d as i64),
            end.map(|e| e.y), end.map(|e| e.m as i64), end.map(|e| e.d as i64),
        )
    } else {
        // year 도 date 도 없는 완전히 형태를 갖추지 못한 행 — 조용히 건너뛴다.
        return Ok(());
    };
    let position = match d.position {
        Some(p) => p,
        None => crate::repo::notes::dates::next_position(tx, &d.note_id)?,
    };
    tx.execute(
        "INSERT INTO note_dates(id, note_id, position, year, month, day, end_year, end_month, end_day, remind, created_at, start_time, end_time, remind_offset_min, rrule, label)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            d.id, d.note_id, position, year, month, day, end_year, end_month, end_day,
            d.remind, d.created_at, d.start_time, d.end_time, d.remind_offset_min, d.rrule, d.label,
        ],
    )
    .map_err(dberr)?;
    Ok(())
}
/// OR IGNORE covers two cases at once: (1) the pair's PK already exists locally (idempotent
/// re-import, same as note_tags/workspace_regions above), and (2) either note_id doesn't exist in
/// this DB — a partial/folder-scoped bundle can carry a pair where only one side was in scope
/// (export.rs::dump_folder), and under `foreign_keys=ON` (db::mod.rs bootstrap) that's a
/// constraint violation SQLite treats like any other for ON CONFLICT, so it's silently dropped
/// rather than failing the whole import (same fail-safe philosophy as note_tags' orphan tag_id
/// fallback below).
pub(crate) fn insert_note_related_exclusion(
    tx: &rusqlite::Transaction,
    x: &NoteRelatedExclusionRow,
) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO note_related_exclusions(id_1, id_2, created_at) VALUES (?1,?2,?3)",
        params![x.id_1, x.id_2, x.created_at],
    )
    .map_err(dberr)?;
    Ok(())
}
pub(crate) fn insert_section(tx: &rusqlite::Transaction, s: &SectionRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,?3,?4,?5)",
        params![s.id, s.note_id, s.name, s.body_md, s.position],
    )
    .map_err(dberr)?;
    Ok(())
}
pub(crate) fn insert_source(tx: &rusqlite::Transaction, s: &SourceRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO sources(id, note_id, name, ext, body, position, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![s.id, s.note_id, s.name, s.ext, s.body, s.position, s.created_at],
    )
    .map_err(dberr)?;
    Ok(())
}
pub(crate) fn insert_attachment(tx: &rusqlite::Transaction, a: &AttachmentRow) -> AppResult<()> {
    // fail-closed: 번들의 link url 은 결국 opener 로 흘러가므로 http(s) 아닌 scheme 은 import 를 중단시킨다.
    // 두 삽입 루프(merge/replace)가 모두 이 단일 지점을 지난다.
    if a.kind == "link" {
        let ok = a
            .url
            .as_deref()
            .is_some_and(crate::repo::attachments::is_safe_link_url);
        if !ok {
            return Err(AppError::Validation(format!(
                "bundle has unsafe link attachment url: {:?}",
                a.url
            )));
        }
    }
    tx.execute(
        "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![a.id, a.note_id, a.name, a.kind, a.rel_path, a.url, a.size_bytes, a.position, a.created_at],
    )
    .map_err(dberr)?;
    Ok(())
}
pub(crate) fn insert_routine_completion(
    tx: &rusqlite::Transaction,
    rc: &RoutineCompletionRow,
) -> AppResult<()> {
    tx.execute(
        "INSERT OR REPLACE INTO routine_completions(note_id, occur_on, done_at) VALUES (?1,?2,?3)",
        params![rc.note_id, rc.occur_on, rc.done_at],
    )
    .map_err(dberr)?;
    Ok(())
}
pub(crate) fn insert_space(tx: &rusqlite::Transaction, s: &SpaceRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO spaces(id, workspace_id, title, position, is_home, is_favorite, archived_at, default_style, last_viewport_x, last_viewport_y, last_viewport_zoom, home_viewport_x, home_viewport_y, home_viewport_zoom, layout_locked, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![s.id, s.workspace_id, s.title, s.position, s.is_home, s.is_favorite, s.archived_at, s.default_style, s.last_viewport_x, s.last_viewport_y, s.last_viewport_zoom, s.home_viewport_x, s.home_viewport_y, s.home_viewport_zoom, s.layout_locked, s.created_at, s.updated_at],
    )
    .map_err(dberr)?;
    Ok(())
}
pub(crate) fn insert_space_item(tx: &rusqlite::Transaction, i: &SpaceItemRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO space_items(id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![i.id, i.space_id, i.kind, i.source_id, i.content, i.x, i.y, i.width, i.height, i.z_index, i.display_mode, i.style, i.locked, i.created_at, i.updated_at],
    )
    .map_err(dberr)?;
    Ok(())
}

// add_notebook.rs 와 hash_merge.rs 테스트가 공유하는 시드 헬퍼 — 두 파일 모두 같은 '작은
// 노트북(태그/지역/첨부/연관노트 제외 포함)' 픽스처가 필요해 한 곳에 둔다(중복 방지).
#[cfg(test)]
pub(crate) mod test_support {
    use crate::util::{new_id, now_iso};
    use rusqlite::{params, Connection};

    pub(crate) fn seed_notebook_bundle_source(conn: &mut Connection) -> (String, String, String) {
        // Returns (workspace_id, folder_id, note_id) for a small notebook with tags, region,
        // attachment, related exclusion — enough to prove remap + roundtrip.
        let now = now_iso();
        let ws = new_id();
        let folder = new_id();
        let note_a = new_id();
        let note_b = new_id();
        let tag = new_id();
        let region = new_id();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'History Lab',?2)",
            params![ws, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
             VALUES (?1,?2,'Era',0,1,?3)",
            params![folder, ws, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
             VALUES (?1,?2,'Sejong',1443,0,?3,?3)",
            params![note_a, folder, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
             VALUES (?1,?2,'Partner',1443,0,?3,?3)",
            params![note_b, folder, now],
        )
        .unwrap();
        // PLAN-2026-09-08-dates-rebuild.md W1: 이 두 노트는 raw INSERT 로 만들어져 insert_note/
        // create_with_sections_with_hook(project_primary 를 갖춘 경로)를 거치지 않는다 — 이
        // 픽스처는 그 경로들이 항상 만드는 position=0 행을 스스로 심어 불변식을 지킨다.
        conn.execute(
            "INSERT INTO note_dates(id, note_id, position, year, remind, created_at) VALUES (?1,?2,0,1443,0,?3)",
            params![new_id(), note_a, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_dates(id, note_id, position, year, remind, created_at) VALUES (?1,?2,0,1443,0,?3)",
            params![new_id(), note_b, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','## Over\n\nbody',0)",
            params![new_id(), note_a],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','partner body',0)",
            params![new_id(), note_b],
        )
        .unwrap();
        conn.execute("INSERT INTO tags(id, name) VALUES (?1,'hangul')", [&tag])
            .unwrap();
        conn.execute(
            "INSERT INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
            params![note_a, tag],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
             VALUES (?1,?2,'Hanseong',0,?3)",
            params![region, ws, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_regions(id, note_id, name, lat, lng, position, created_at)
             VALUES (?1,?2,'Gyeongbok',37.5,127.0,0,?3)",
            params![new_id(), note_a, now],
        )
        .unwrap();
        // GRILL-2026-09-07 D2: note_dates (추가 날짜) — note_regions 와 같은 급의 사용자
        // 콘텐츠라 remap/merge 경로 모두 이걸 보존해야 한다. PLAN-2026-09-08-dates-rebuild.md W1:
        // position=1(관련 날짜, 대표는 위에서 이미 position=0 으로 심었다).
        conn.execute(
            "INSERT INTO note_dates(id, note_id, position, year, month, day, remind, created_at)
             VALUES (?1,?2,1,1446,9,1,0,?3)",
            params![new_id(), note_a, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_related_exclusions(id_1, id_2, created_at) VALUES (?1,?2,?3)",
            params![note_a, note_b, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, position, created_at)
             VALUES (?1,?2,'file.txt','doc','file.txt',0,?3)",
            params![new_id(), note_a, now],
        )
        .unwrap();
        (ws, folder, note_a)
    }

}

#[cfg(test)]
mod chart_url_tests {
    use super::remap_chart_url;
    use std::collections::HashMap;

    /// chart url 은 섹션 부분만 옮기고 차트 id 는 그대로, 맵에 없는 섹션·`#` 없는 url 은 그대로.
    #[test]
    fn remap_chart_url_moves_only_the_section_part() {
        let map: HashMap<String, String> = [("old-sec".to_string(), "new-sec".to_string())].into();
        assert_eq!(remap_chart_url("old-sec#c1", &map), "new-sec#c1");
        assert_eq!(remap_chart_url("other#c1", &map), "other#c1");
        assert_eq!(remap_chart_url("no-hash", &map), "no-hash");
    }
}
