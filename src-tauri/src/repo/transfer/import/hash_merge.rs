// repo::transfer::import::hash_merge — `hash_merge` 모드: 콘텐츠 해시(제목+섹션 본문)로 기존
// 노트북과 비교해 동일하면 skip, 다르면 새 노트로 추가(또는 update_existing이면 제자리 갱신).
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::repo::fts;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::super::bundle::{
    AttachmentRow, Bundle, FolderRow, NoteDateRow, NoteRegionRow, NoteRow, NoteTagRow,
    RoutineCompletionRow, SectionRow, SourceRow, SpaceItemRow, SpaceRow, WorkspaceEraRow,
    WorkspaceRegionRow, WorkspaceStatusRow,
};
use super::ImportResult;

// ── add_notebook / hash_merge ──────────────────────────────────────────────────

/// Content fingerprint for a note: title + ordered section bodies (name+body).
/// Used by hash_merge to detect identical content across id remaps.
pub(crate) fn note_content_hash(title: &str, sections: &[&SectionRow]) -> String {
    let mut ordered: Vec<&SectionRow> = sections.to_vec();
    ordered.sort_by_key(|s| (s.position, s.id.as_str()));
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0u8]);
    for s in ordered {
        hasher.update(s.name.as_bytes());
        hasher.update([0u8]);
        hasher.update(s.body_md.as_bytes());
        hasher.update([0u8]);
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 노트북 스코프 분류(지역·시대·상태)를 **이름으로** 대상 노트북에 병합한다 — 같은 이름이
/// 이미 있으면 건너뛰고(COLLATE NOCASE), 없으면 새 id 로 넣는다.
fn merge_workspace_taxonomy(
    tx: &rusqlite::Transaction,
    target_workspace_id: &str,
    workspace_regions: &[WorkspaceRegionRow],
    workspace_eras: &[WorkspaceEraRow],
    workspace_statuses: &[WorkspaceStatusRow],
) -> AppResult<()> {
    for r in workspace_regions {
        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM workspace_regions WHERE workspace_id=?1 AND name=?2 COLLATE NOCASE",
                params![target_workspace_id, r.name],
                |_| Ok(true),
            )
            .ok()
            .unwrap_or(false);
        if exists {
            continue;
        }
        tx.execute(
            "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![new_id(), target_workspace_id, r.name, r.position, r.created_at],
        )
        .map_err(dberr)?;
    }
    for e in workspace_eras {
        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM workspace_eras WHERE workspace_id=?1 AND name=?2 COLLATE NOCASE",
                params![target_workspace_id, e.name],
                |_| Ok(true),
            )
            .ok()
            .unwrap_or(false);
        if exists {
            continue;
        }
        tx.execute(
            "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                new_id(),
                target_workspace_id,
                e.name,
                e.from_year,
                e.to_year,
                e.position,
                e.created_at
            ],
        )
        .map_err(dberr)?;
    }
    for s in workspace_statuses {
        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM workspace_statuses WHERE workspace_id=?1 AND name=?2 COLLATE NOCASE",
                params![target_workspace_id, s.name],
                |_| Ok(true),
            )
            .ok()
            .unwrap_or(false);
        if exists {
            continue;
        }
        tx.execute(
            "INSERT INTO workspace_statuses(id, workspace_id, name, position, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![new_id(), target_workspace_id, s.name, s.position, s.created_at],
        )
        .map_err(dberr)?;
    }
    Ok(())
}

/// 분류 병합이 끝난 **뒤** 이름으로 다시 조회해 (번들 status id → 로컬 status id) 를 만든다.
/// note.status 는 내장 상태 키 또는 workspace_statuses.id 를 담는 자유 TEXT 라, 맵에 없는 값은
/// 그대로 둬야 한다(호출부의 unwrap_or_else(|| s.clone())).
fn resolve_status_ids(
    tx: &rusqlite::Transaction,
    target_workspace_id: &str,
    workspace_statuses: &[WorkspaceStatusRow],
) -> AppResult<HashMap<String, String>> {
    // After merge, resolve by name: bundle status name → local status id.
    let mut m = HashMap::new();
    for s in workspace_statuses {
        let local: Option<String> = tx
            .query_row(
                "SELECT id FROM workspace_statuses WHERE workspace_id=?1 AND name=?2 COLLATE NOCASE",
                params![target_workspace_id, s.name],
                |r| r.get(0),
            )
            .optional()
            .map_err(dberr)?;
        if let Some(id) = local {
            m.insert(s.id.clone(), id);
        }
    }
    Ok(m)
}

fn update_note_in_place(
    tx: &rusqlite::Transaction,
    existing_id: &str,
    note: &NoteRow,
    sections: &[&SectionRow],
    status_id_by_bundle: &HashMap<String, String>,
) -> AppResult<()> {
    let status = note.status.as_ref().map(|s| {
        status_id_by_bundle
            .get(s)
            .cloned()
            .unwrap_or_else(|| s.clone())
    });
    // archived_at 은 is_favorite/status 와 같은 규칙을 따른다 — update_existing 제자리 갱신은
    // 로컬 값을 존중하지 않고 들어오는 번들 값이 항상 이긴다(양쪽 방향 모두: 로컬만 아카이브였는데
    // 번들이 미아카이브면 풀리고, 반대로 번들만 아카이브면 로컬이 아카이브된다). deleted_at 은
    // 이 규칙의 대상이 아니다 — deleted_at 은 애초에 번들에 실리지 않고(dump 의 deleted_at IS NULL
    // 필터, insert_note 는 이 컬럼을 쓰지 않음) 휴지통에 있는 로컬 노트는 title_to_id 조회 자체가
    // deleted_at IS NULL 로 스코프에서 뺀다 — "값 병합 규칙"이 아니라 "대상에서 제외"라 애초에 이
    // update_note_in_place 에 도달하지 않는다.
    tx.execute(
        "UPDATE notes SET title=?1, is_favorite=?2, region=?3, status=?4,
         icon=?5, lat=?6, lng=?7, updated_at=?8, archived_at=?9
         WHERE id=?10",
        params![
            note.title,
            note.is_favorite,
            note.region,
            status,
            note.icon,
            note.lat,
            note.lng,
            now_iso(),
            note.archived_at,
            existing_id
        ],
    )
    .map_err(dberr)?;
    // PLAN-2026-09-08-dates-rebuild.md §1.2: notes.{year,month,day,end_*,remind,start_time,
    // end_time,remind_offset_min,rrule} 은 position=0 note_dates 행의 투영이다. 예전(V76 이전)엔
    // 이 컬럼들이 그 자체로 사건 축의 진실이라 위 UPDATE 에 함께 실어도 안전했지만, 지금 그렇게
    // 하면 note_dates 의 position=0 행은 그대로 두고 notes.* 만 갈아치우는 꼴이 되어 다음 날짜
    // mutation(project_primary)이 옛 값으로 조용히 되돌린다 — commands::ai.rs/repo::notes::mod.rs
    // 가 이미 겪은 드리프트와 같은 결함(§7-1). 진실부터 갱신한다.
    tx.execute(
        "UPDATE note_dates SET year=?1, month=?2, day=?3, end_year=?4, end_month=?5, end_day=?6,
         remind=?7, start_time=?8, end_time=?9, remind_offset_min=?10, rrule=?11
         WHERE note_id=?12 AND position=0",
        params![
            note.year,
            note.month,
            note.day,
            note.end_year,
            note.end_month,
            note.end_day,
            note.remind,
            note.start_time,
            note.end_time,
            note.remind_offset_min,
            note.rrule,
            existing_id
        ],
    )
    .map_err(dberr)?;
    crate::repo::notes::dates::project_primary(tx, existing_id)?;
    // Replace sections wholesale (content is the hash identity).
    tx.execute("DELETE FROM sections WHERE note_id=?1", [existing_id])
        .map_err(dberr)?;
    for s in sections {
        let sec = SectionRow {
            id: new_id(),
            note_id: existing_id.to_string(),
            name: s.name.clone(),
            body_md: s.body_md.clone(),
            position: s.position,
        };
        super::insert_section(tx, &sec)?;
    }
    Ok(())
}


/// 번들 폴더를 대상 노트북의 폴더에 **이름으로** 맞춘다 — 같은 이름이 없으면 새로 만든다.
/// 돌려주는 것은 (번들 folder_id → 로컬 folder_id, 폴백 폴더). 폴백은 번들이 폴더를 통째로 안
/// 실어온 부분 번들(Notes whose folder isn't in the bundle)의 노트가 떨어질 자리다.
fn merge_folders(
    tx: &rusqlite::Transaction,
    target_workspace_id: &str,
    folders: &[FolderRow],
) -> AppResult<(HashMap<String, String>, String)> {
    // Folder name → id in the target notebook (create missing).
    let mut folder_by_name: HashMap<String, String> = {
        let mut stmt = tx
            .prepare("SELECT id, name FROM folders WHERE workspace_id=?1")
            .map_err(dberr)?;
        let rows: Vec<(String, String)> = stmt
            .query_map([target_workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(dberr)?
            .collect::<Result<_, _>>()
            .map_err(dberr)?;
        rows.into_iter().map(|(id, name)| (name, id)).collect()
    };
    let mut folder_map: HashMap<String, String> = HashMap::new(); // bundle folder_id → local
    for f in folders {
        if let Some(local) = folder_by_name.get(&f.name) {
            folder_map.insert(f.id.clone(), local.clone());
        } else {
            let new_fid = new_id();
            let now = now_iso();
            tx.execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    new_fid,
                    target_workspace_id,
                    f.name,
                    f.position,
                    f.is_open,
                    now,
                    f.color_hue,
                    f.icon,
                    f.rules,
                    f.search_excluded,
                    f.ai_excluded
                ],
            )
            .map_err(dberr)?;
            folder_by_name.insert(f.name.clone(), new_fid.clone());
            folder_map.insert(f.id.clone(), new_fid);
        }
    }
    // Notes whose folder isn't in the bundle (partial) fall back to first target folder.
    let fallback_folder: String = folder_by_name
        .values()
        .next()
        .cloned()
        .ok_or_else(|| AppError::Validation("target notebook has no folders".into()))?;
    Ok((folder_map, fallback_folder))
}

/// 대상 노트북의 현재 내용을 한 번 훑어 (콘텐츠 해시 집합, 소문자 제목 → note_id) 를 만든다.
/// 해시 집합은 "같은 내용이면 skip" 판정에, 제목 맵은 update_existing 제자리 갱신 매칭에 쓴다.
/// 휴지통(deleted_at)에 있는 노트는 애초에 스코프에서 빠진다 — update_note_in_place 위 주석 참조.
fn scan_target_notes(
    tx: &rusqlite::Transaction,
    target_workspace_id: &str,
) -> AppResult<(HashSet<String>, HashMap<String, String>)> {
    let mut existing_hashes: HashSet<String> = HashSet::new();
    let mut title_to_id: HashMap<String, String> = HashMap::new();
    let mut notes_stmt = tx
        .prepare(
            "SELECT n.id, n.title FROM notes n
                     JOIN folders f ON f.id = n.folder_id
                     WHERE f.workspace_id=?1 AND n.deleted_at IS NULL",
        )
        .map_err(dberr)?;
    let rows: Vec<(String, String)> = notes_stmt
        .query_map([target_workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(dberr)?
        .collect::<Result<_, _>>()
        .map_err(dberr)?;
    drop(notes_stmt);
    for (note_id, title) in rows {
        title_to_id
            .entry(title.to_lowercase())
            .or_insert_with(|| note_id.clone());
        let secs: Vec<SectionRow> = {
            let mut s = tx
                .prepare(
                    "SELECT id, note_id, name, body_md, position FROM sections WHERE note_id=?1",
                )
                .map_err(dberr)?;
            let rows = s
                .query_map([&note_id], |r| {
                    Ok(SectionRow {
                        id: r.get(0)?,
                        note_id: r.get(1)?,
                        name: r.get(2)?,
                        body_md: r.get(3)?,
                        position: r.get(4)?,
                    })
                })
                .map_err(dberr)?
                .collect::<Result<_, _>>()
                .map_err(dberr)?;
            rows
        };
        let refs: Vec<&SectionRow> = secs.iter().collect();
        existing_hashes.insert(note_content_hash(&title, &refs));
    }
    Ok((existing_hashes, title_to_id))
}

/// import_hash_merge 가 표 사이로 나르는 지역 상태를 하나로 묶은 것 — 표별 merge_* 함수는
/// 이것 하나만 받는다(선례: add_notebook.rs 의 IdMaps, 커밋 b86ccdb7).
struct MergeCtx<'a> {
    /// 병합 대상 노트북(= workspace) id.
    target_workspace_id: &'a str,
    /// 같은 제목의 로컬 노트를 제자리 갱신할지 — false 면 언제나 새 노트로 추가한다.
    update_existing: bool,
    /// 대상 노트북에 이미 있는 콘텐츠 해시(제목+섹션 본문) — 같은 해시는 skip.
    /// 새로 들어간 노트의 해시도 여기 쌓여, 한 번들 안의 중복도 걸러진다.
    existing_hashes: HashSet<String>,
    /// 소문자 제목 → 로컬 note_id (update_existing 매칭용, 대상 노트북 스코프).
    title_to_id: HashMap<String, String>,
    /// 번들 folder_id → 로컬 folder_id.
    folder_map: HashMap<String, String>,
    /// 번들에 폴더가 안 실려 온 노트가 떨어질 자리(대상 노트북의 첫 폴더).
    fallback_folder: String,
    /// 번들 status id → 로컬 status id.
    status_id_by_bundle: HashMap<String, String>,
    /// 번들 tag id → 로컬 tag id.
    tag_id_map: HashMap<String, String>,
    /// 번들 note_id → 로컬 note_id (skip·제자리갱신·신규 세 갈래 모두 채운다).
    note_remap: HashMap<String, String>,
    /// 번들 space_id → 로컬 space_id.
    space_remap: HashMap<String, String>,
    /// (원본 rel_path, remap된 rel_path) 쌍 — 새로 발급된 note_id 로 attachments 디렉토리도 함께
    /// 옮겨야 하므로 copy_attachments_remapped 에 그대로 넘긴다.
    new_atts: Vec<(String, String)>,
    imported: i64,
    skipped: i64,
}

/// 노트 한 장에 딸린 자식 표들 — 새 note_id 로 다시 심어야 하는 전부.
/// 슬라이스를 하나씩 넘기면 insert_new_note 의 인자가 열 개가 되므로 묶어서 하나로 넘긴다.
struct NoteChildren<'a> {
    sections: &'a [SectionRow],
    sources: &'a [SourceRow],
    attachments: &'a [AttachmentRow],
    note_regions: &'a [NoteRegionRow],
    note_dates: &'a [NoteDateRow],
    note_tags: &'a [NoteTagRow],
    routine_completions: &'a [RoutineCompletionRow],
}

/// Content-hash merge into an existing notebook (workspace_id = 노트북).
pub(super) fn import_hash_merge(
    conn: &mut Connection,
    _data_dir: &Path,
    bundle: &Bundle,
    bundle_att: &Path,
    data_att: &Path,
    target_workspace_id: &str,
    update_existing: bool,
) -> AppResult<ImportResult> {
    // 번들의 표를 '..' 없이 전부 이름으로 받는다 — Bundle 에 표가 새로 붙으면 여기서 컴파일이
    // 깨져, 병합 방침을 정하기 전엔 조용히 유실될 수 없다(선례: add_notebook.rs 의
    // remap_bundle_ids, 커밋 b86ccdb7). `_` 접두는 이 모드가 다루지 않는 표이고, 그 이유는
    // 줄마다 적는다.
    let Bundle {
        // 버전 게이트는 import_bundle 이 이 함수보다 먼저 본다.
        version: _version,
        // 기존 노트북에 병합하는 모드라 번들이 실어온 노트북 행 자체는 쓰지 않는다.
        workspaces: _workspaces,
        folders,
        notes,
        sections,
        sources,
        attachments,
        tags,
        note_tags,
        // 전역 설정 — 병합은 로컬 설정을 건드리지 않는다.
        settings: _settings,
        workspace_regions,
        workspace_eras,
        workspace_statuses,
        note_regions,
        note_dates,
        routine_completions,
        spaces,
        space_items,
        // 아래 여섯은 이 모드가 **원래부터** 옮기지 않던 표다(add_notebook/replace 는 옮긴다).
        // 이번 리팩터는 동작 변경 0 계약이라 여기서 채우지 않고 이름만 받아 둔다.
        note_related_exclusions: _note_related_exclusions,
        workspace_settings: _workspace_settings,
        timeline_routines: _timeline_routines,
        calendar_sources: _calendar_sources,
        calendar_marks: _calendar_marks,
        calendar_mark_hides: _calendar_mark_hides,
    } = bundle;

    // Target notebook must already exist.
    let target_exists: bool = conn
        .query_row(
            "SELECT 1 FROM workspaces WHERE id=?1",
            [target_workspace_id],
            |_| Ok(true),
        )
        .ok()
        .unwrap_or(false);
    if !target_exists {
        return Err(AppError::NotFound(format!(
            "target notebook not found: {target_workspace_id}"
        )));
    }

    // 표 사이를 흐르는 지역 상태(해시 집합·id 맵·카운터)는 전부 MergeCtx 하나에 모으고, 아래
    // merge_* 는 그 하나만 받는다. 트랜잭션 블록이 ctx 를 그대로 돌려주므로 첨부 복사처럼
    // 커밋 뒤에 필요한 값(new_atts/space_remap)도 같은 자리에서 읽는다.
    let ctx = {
        let tx = conn.transaction().map_err(dberr)?;

        // Existing content hashes in the target notebook + title (lowercase) → note_id
        // for update_existing matches, scoped to target notebook.
        let (existing_hashes, title_to_id) = scan_target_notes(&tx, target_workspace_id)?;

        let (folder_map, fallback_folder) = merge_folders(&tx, target_workspace_id, folders)?;

        // Merge workspace taxonomy by name into the target notebook.
        merge_workspace_taxonomy(
            &tx,
            target_workspace_id,
            workspace_regions,
            workspace_eras,
            workspace_statuses,
        )?;

        // Status name/id maps for rewriting note.status when it points at a custom status.
        let status_id_by_bundle = resolve_status_ids(&tx, target_workspace_id, workspace_statuses)?;

        let tag_id_map = super::plan_tag_merge(&tx, tags)?;
        super::insert_tags_from_map(&tx, tags, &tag_id_map)?;

        let mut ctx = MergeCtx {
            target_workspace_id,
            update_existing,
            existing_hashes,
            title_to_id,
            folder_map,
            fallback_folder,
            status_id_by_bundle,
            tag_id_map,
            note_remap: HashMap::new(),
            space_remap: HashMap::new(),
            new_atts: Vec::new(),
            imported: 0,
            skipped: 0,
        };

        let children = NoteChildren {
            sections,
            sources,
            attachments,
            note_regions,
            note_dates,
            note_tags,
            routine_completions,
        };
        // 순서가 계약이다 — 공간 아이템의 source_id 가 note_remap 을 읽으므로 노트가 먼저다.
        merge_notes(&tx, &mut ctx, notes, &children)?;
        merge_spaces(&tx, &mut ctx, spaces, space_items)?;

        super::prune_dangling_internal(&tx)?;
        tx.commit().map_err(dberr)?;
        ctx
    };

    std::fs::create_dir_all(data_att).map_err(io)?;
    super::copy_attachments_remapped(&ctx.new_atts, bundle_att, data_att)?;
    super::copy_space_images_remapped(space_items, &ctx.space_remap, bundle_att, data_att)?;

    Ok(ImportResult {
        imported_notes: ctx.imported,
        skipped: ctx.skipped,
        backup_path: None,
    })
}

// ── import_hash_merge 의 조각들 ────────────────────────────────────────────────────

/// 번들의 노트를 하나씩 판정해 대상 노트북에 넣는다 — 해시가 같으면 skip, update_existing 이고
/// 제목이 맞으면 제자리 갱신, 아니면 새 노트로 추가. 셋 다 note_remap 에 (번들 note_id → 로컬
/// note_id) 를 남긴다(공간 아이템이 그 맵을 쓴다).
fn merge_notes(
    tx: &rusqlite::Transaction,
    ctx: &mut MergeCtx,
    notes: &[NoteRow],
    children: &NoteChildren,
) -> AppResult<()> {
    for note in notes {
        let note_secs: Vec<&SectionRow> = children
            .sections
            .iter()
            .filter(|s| s.note_id == note.id)
            .collect();
        let hash = note_content_hash(&note.title, &note_secs);
        if ctx.existing_hashes.contains(&hash) {
            if let Some(eid) = ctx.title_to_id.get(&note.title.to_lowercase()).cloned() {
                ctx.note_remap.insert(note.id.clone(), eid);
            }
            ctx.skipped += 1;
            continue;
        }

        if ctx.update_existing {
            if let Some(existing_id) = ctx.title_to_id.get(&note.title.to_lowercase()).cloned() {
                update_existing_note(tx, ctx, note, &note_secs, children, &existing_id)?;
                ctx.existing_hashes.insert(hash);
                ctx.note_remap.insert(note.id.clone(), existing_id);
                ctx.imported += 1;
                continue;
            }
        }

        let new_note_id = insert_new_note(tx, ctx, note, &note_secs, children)?;
        ctx.existing_hashes.insert(hash);
        ctx.title_to_id
            .entry(note.title.to_lowercase())
            .or_insert(new_note_id.clone());
        ctx.note_remap.insert(note.id.clone(), new_note_id);
        ctx.imported += 1;
    }
    Ok(())
}

/// Update-in-place: replace metadata + sections; leave id stable.
/// 콘텐츠와 함께 따라다니는 자식(섹션·태그)만 갈아끼운다 — 첨부·경유지·날짜 등 나머지 자식은
/// 제자리 갱신의 대상이 아니다(원래부터 그랬다, 동작 변경 0).
fn update_existing_note(
    tx: &rusqlite::Transaction,
    ctx: &MergeCtx,
    note: &NoteRow,
    note_secs: &[&SectionRow],
    children: &NoteChildren,
    existing_id: &str,
) -> AppResult<()> {
    update_note_in_place(tx, existing_id, note, note_secs, &ctx.status_id_by_bundle)?;
    // Replace children that ride with content (sections already done).
    // Tags: replace set.
    tx.execute("DELETE FROM note_tags WHERE note_id=?1", [existing_id])
        .map_err(dberr)?;
    merge_note_tags(tx, &ctx.tag_id_map, children.note_tags, &note.id, existing_id)?;
    fts::fts_upsert(tx, existing_id)?;
    Ok(())
}

/// Add as a brand-new note (new ids) under the mapped folder. 새로 발급한 note_id 를 돌려준다.
fn insert_new_note(
    tx: &rusqlite::Transaction,
    ctx: &mut MergeCtx,
    note: &NoteRow,
    note_secs: &[&SectionRow],
    children: &NoteChildren,
) -> AppResult<String> {
    let local_folder = ctx
        .folder_map
        .get(&note.folder_id)
        .cloned()
        .unwrap_or_else(|| ctx.fallback_folder.clone());

    let new_note_id = new_id();
    let status = note.status.as_ref().map(|s| {
        ctx.status_id_by_bundle
            .get(s)
            .cloned()
            .unwrap_or_else(|| s.clone())
    });
    let inserted = NoteRow {
        id: new_note_id.clone(),
        folder_id: local_folder,
        title: note.title.clone(),
        year: note.year,
        is_favorite: note.is_favorite,
        exported_at: note.exported_at.clone(),
        created_at: note.created_at.clone(),
        updated_at: note.updated_at.clone(),
        region: note.region.clone(),
        status,
        month: note.month,
        day: note.day,
        remind: note.remind,
        end_year: note.end_year,
        end_month: note.end_month,
        end_day: note.end_day,
        icon: note.icon.clone(),
        lat: note.lat,
        lng: note.lng,
        start_time: note.start_time.clone(),
        end_time: note.end_time.clone(),
        remind_offset_min: note.remind_offset_min,
        rrule: note.rrule.clone(),
        // 새 노트로 추가되는 분기 — 번들이 실어온 아카이브 상태를 그대로 들고 간다.
        archived_at: note.archived_at.clone(),
    };
    super::insert_note(tx, &inserted)?;

    // 본문의 인라인 이미지는 첨부 rel_path 를 글자 그대로 적는다 — 아래 attachments 루프가
    // 이 노트의 첨부를 새 note_id 디렉토리로 옮기므로 본문도 같은 경로로 고쳐 쓴다
    // (super::rewrite_attachment_rel_paths 주석 — add_notebook 과 같은 구멍이었다).
    let rel_map: HashMap<String, String> = children
        .attachments
        .iter()
        .filter(|a| a.note_id == note.id)
        .filter_map(|a| a.rel_path.as_deref())
        .map(|rp| {
            (
                rp.to_string(),
                super::remap_attachment_rel_path(rp, &note.id, &new_note_id),
            )
        })
        .filter(|(old_rel, new_rel)| old_rel != new_rel)
        .collect();

    // 자식 표들 — 섹션이 첫째다(첨부의 chart url 이 섹션 id 맵을 읽는다).
    let section_map = merge_sections(tx, note_secs, &new_note_id, &rel_map)?;
    merge_sources(tx, children.sources, &note.id, &new_note_id)?;
    merge_attachments(
        tx,
        ctx,
        children.attachments,
        &note.id,
        &new_note_id,
        &section_map,
    )?;
    merge_note_regions(tx, children.note_regions, &note.id, &new_note_id)?;
    merge_note_dates(tx, children.note_dates, &note.id, &new_note_id)?;
    merge_note_tags(tx, &ctx.tag_id_map, children.note_tags, &note.id, &new_note_id)?;
    merge_routine_completions(tx, children.routine_completions, &note.id, &new_note_id)?;
    fts::fts_upsert(tx, &new_note_id)?;
    Ok(new_note_id)
}

/// 섹션을 새 note_id 로 다시 심고, 옛 섹션 id → 새 섹션 id 를 돌려준다.
/// (아래 chart 첨부의 url("<section_id>#<chart_id>")이 이 맵을 쓴다.)
fn merge_sections(
    tx: &rusqlite::Transaction,
    note_secs: &[&SectionRow],
    new_note_id: &str,
    rel_map: &HashMap<String, String>,
) -> AppResult<HashMap<String, String>> {
    let mut section_map: HashMap<String, String> = HashMap::new();
    for s in note_secs {
        let sec = SectionRow {
            id: new_id(),
            note_id: new_note_id.to_string(),
            name: s.name.clone(),
            body_md: super::rewrite_attachment_rel_paths(&s.body_md, rel_map),
            position: s.position,
        };
        section_map.insert(s.id.clone(), sec.id.clone());
        super::insert_section(tx, &sec)?;
    }
    Ok(section_map)
}

fn merge_sources(
    tx: &rusqlite::Transaction,
    sources: &[SourceRow],
    old_note_id: &str,
    new_note_id: &str,
) -> AppResult<()> {
    for s in sources.iter().filter(|s| s.note_id == old_note_id) {
        let src = SourceRow {
            id: new_id(),
            note_id: new_note_id.to_string(),
            name: s.name.clone(),
            ext: s.ext.clone(),
            body: s.body.clone(),
            position: s.position,
            created_at: s.created_at.clone(),
        };
        super::insert_source(tx, &src)?;
    }
    Ok(())
}

/// 첨부 행을 새 note_id 로 다시 심고, 디스크에서 옮겨야 할 (옛 rel_path, 새 rel_path) 쌍을
/// ctx.new_atts 에 쌓는다(커밋 뒤 copy_attachments_remapped 가 그대로 쓴다).
fn merge_attachments(
    tx: &rusqlite::Transaction,
    ctx: &mut MergeCtx,
    attachments: &[AttachmentRow],
    old_note_id: &str,
    new_note_id: &str,
    section_map: &HashMap<String, String>,
) -> AppResult<()> {
    for a in attachments.iter().filter(|a| a.note_id == old_note_id) {
        // rel_path 는 번들 안에서 옛 note_id 디렉토리를 가리킨다 — 이 노트는 방금 새
        // note_id 를 받았으니 DB 행도 같은 remap 을 거쳐야 한다(add_notebook과 동일 버그).
        let rel_path = a
            .rel_path
            .as_ref()
            .map(|rp| super::remap_attachment_rel_path(rp, old_note_id, new_note_id));
        let att = AttachmentRow {
            id: new_id(),
            note_id: new_note_id.to_string(),
            name: a.name.clone(),
            kind: a.kind.clone(),
            rel_path: rel_path.clone(),
            // internal urls may dangle until both sides land — prune later.
            // chart urls carry the section id, which this note just re-issued.
            url: if a.kind == "chart" {
                a.url.as_ref().map(|u| super::remap_chart_url(u, section_map))
            } else {
                a.url.clone()
            },
            size_bytes: a.size_bytes,
            position: a.position,
            created_at: a.created_at.clone(),
        };
        super::insert_attachment(tx, &att)?;
        if let (Some(orig_rel), Some(new_rel)) = (&a.rel_path, &rel_path) {
            ctx.new_atts.push((orig_rel.clone(), new_rel.clone()));
        }
    }
    Ok(())
}

fn merge_note_regions(
    tx: &rusqlite::Transaction,
    note_regions: &[NoteRegionRow],
    old_note_id: &str,
    new_note_id: &str,
) -> AppResult<()> {
    for r in note_regions.iter().filter(|r| r.note_id == old_note_id) {
        let nr = NoteRegionRow {
            id: new_id(),
            note_id: new_note_id.to_string(),
            name: r.name.clone(),
            lat: r.lat,
            lng: r.lng,
            position: r.position,
            created_at: r.created_at.clone(),
        };
        super::insert_note_region(tx, &nr)?;
    }
    Ok(())
}

fn merge_note_dates(
    tx: &rusqlite::Transaction,
    note_dates: &[NoteDateRow],
    old_note_id: &str,
    new_note_id: &str,
) -> AppResult<()> {
    for d in note_dates.iter().filter(|d| d.note_id == old_note_id) {
        let nd = NoteDateRow {
            id: new_id(),
            note_id: new_note_id.to_string(),
            // 새 노트라 이 노트 소유의 기존 note_dates 가 없다 — position 을 그대로 들고
            // 가도 충돌하지 않는다(번들 안에서 이미 노트별로 유일했다).
            position: d.position,
            year: d.year,
            month: d.month,
            day: d.day,
            end_year: d.end_year,
            end_month: d.end_month,
            end_day: d.end_day,
            remind: d.remind,
            created_at: d.created_at.clone(),
            start_time: d.start_time.clone(),
            end_time: d.end_time.clone(),
            remind_offset_min: d.remind_offset_min,
            rrule: d.rrule.clone(),
            label: d.label.clone(),
            date: d.date.clone(),
            end_date: d.end_date.clone(),
        };
        super::insert_note_date(tx, &nd)?;
    }
    Ok(())
}

/// note_tags 를 target_note_id 아래로 옮긴다 — 제자리 갱신(태그 집합 교체)과 새 노트 추가가
/// 글자 그대로 같은 루프를 쓰던 자리라 한 곳으로 합쳤다.
fn merge_note_tags(
    tx: &rusqlite::Transaction,
    tag_id_map: &HashMap<String, String>,
    note_tags: &[NoteTagRow],
    old_note_id: &str,
    target_note_id: &str,
) -> AppResult<()> {
    for nt in note_tags.iter().filter(|nt| nt.note_id == old_note_id) {
        let tag_id = tag_id_map.get(&nt.tag_id).unwrap_or(&nt.tag_id);
        tx.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
            params![target_note_id, tag_id],
        )
        .map_err(dberr)?;
    }
    Ok(())
}

fn merge_routine_completions(
    tx: &rusqlite::Transaction,
    routine_completions: &[RoutineCompletionRow],
    old_note_id: &str,
    new_note_id: &str,
) -> AppResult<()> {
    for rc in routine_completions
        .iter()
        .filter(|rc| rc.note_id == old_note_id)
    {
        let remapped_rc = RoutineCompletionRow {
            note_id: new_note_id.to_string(),
            occur_on: rc.occur_on.clone(),
            done_at: rc.done_at.clone(),
        };
        super::insert_routine_completion(tx, &remapped_rc)?;
    }
    Ok(())
}

/// 번들의 공간(캔버스)을 대상 노트북에 새 id 로 추가한다 — 노트와 달리 **중복 제거가 없다**
/// (같은 번들을 두 번 병합하면 공간도 두 벌이 된다). 기존 동작 그대로다.
fn merge_spaces(
    tx: &rusqlite::Transaction,
    ctx: &mut MergeCtx,
    spaces: &[SpaceRow],
    space_items: &[SpaceItemRow],
) -> AppResult<()> {
    for s in spaces {
        let new_space_id = new_id();
        ctx.space_remap.insert(s.id.clone(), new_space_id.clone());
        let space = SpaceRow {
            id: new_space_id.clone(),
            workspace_id: ctx.target_workspace_id.to_string(),
            title: s.title.clone(),
            position: s.position,
            is_home: s.is_home,
            is_favorite: s.is_favorite,
            archived_at: s.archived_at.clone(),
            default_style: s.default_style.clone(),
            last_viewport_x: s.last_viewport_x,
            last_viewport_y: s.last_viewport_y,
            last_viewport_zoom: s.last_viewport_zoom,
            home_viewport_x: s.home_viewport_x,
            home_viewport_y: s.home_viewport_y,
            home_viewport_zoom: s.home_viewport_zoom,
            layout_locked: s.layout_locked,
            created_at: s.created_at.clone(),
            updated_at: s.updated_at.clone(),
        };
        super::insert_space(tx, &space)?;
        tx.execute(
            "UPDATE workspaces SET space_bootstrapped = 1 WHERE id = ?1",
            [ctx.target_workspace_id],
        )
        .map_err(dberr)?;

        merge_space_items(tx, ctx, space_items, &s.id, &new_space_id)?;
    }
    Ok(())
}

fn merge_space_items(
    tx: &rusqlite::Transaction,
    ctx: &MergeCtx,
    space_items: &[SpaceItemRow],
    old_space_id: &str,
    new_space_id: &str,
) -> AppResult<()> {
    for item in space_items.iter().filter(|i| i.space_id == old_space_id) {
        let source_id = super::remap_space_item_source_id(
            &item.kind,
            item.source_id.clone(),
            &ctx.note_remap,
            &ctx.space_remap,
        );
        let new_item = SpaceItemRow {
            id: new_id(),
            space_id: new_space_id.to_string(),
            kind: item.kind.clone(),
            source_id,
            content: item.content.clone(),
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            z_index: item.z_index,
            display_mode: item.display_mode.clone(),
            style: item.style.clone(),
            locked: item.locked,
            created_at: item.created_at.clone(),
            updated_at: item.updated_at.clone(),
        };
        super::insert_space_item(tx, &new_item)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::import_bundle;
    use super::super::test_support::seed_notebook_bundle_source;
    use crate::db;
    use crate::db::migrations;
    use crate::util::new_id;
    use std::path::Path;

    #[test]
    fn note_content_hash_is_stable_for_same_title_and_bodies() {
        let s1 = SectionRow {
            id: "s1".into(),
            note_id: "n".into(),
            name: "Body".into(),
            body_md: "hello".into(),
            position: 0,
        };
        let s2 = SectionRow {
            id: "s2".into(),
            note_id: "n".into(),
            name: "More".into(),
            body_md: "world".into(),
            position: 1,
        };
        let a = note_content_hash("Title", &[&s1, &s2]);
        let b = note_content_hash("Title", &[&s2, &s1]); // order by position, not input order
        assert_eq!(a, b);
        let c = note_content_hash("Title", &[&s1]);
        assert_ne!(a, c);
        let d = note_content_hash("Other", &[&s1, &s2]);
        assert_ne!(a, d);
    }

    #[test]
    fn hash_merge_skips_identical_and_adds_changed() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, folder, note_a) = seed_notebook_bundle_source(&mut conn);
        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"hello").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        // Target: a notebook that already has "Sejong" with the same body (identical hash)
        // plus we'll later change the bundle mentally by also having a different note.
        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let now = now_iso();
        let t_ws = new_id();
        let t_folder = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Era',0,1,?3)",
                params![t_folder, t_ws, now],
            )
            .unwrap();
        // Identical Sejong (same title + body as source).
        let t_note = new_id();
        target
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
                 VALUES (?1,?2,'Sejong',1443,0,?3,?3)",
                params![t_note, t_folder, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','## Over\n\nbody',0)",
                params![new_id(), t_note],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        let imp = import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            false,
        )
        .unwrap();
        // Sejong identical → skip; Partner is new → import 1.
        assert_eq!(imp.imported_notes, 1);
        assert_eq!(imp.skipped, 1);

        let sejong_count: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM notes n JOIN folders f ON f.id=n.folder_id
                 WHERE f.workspace_id=?1 AND n.title='Sejong'",
                [&t_ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sejong_count, 1, "identical Sejong must not duplicate");
        let partner_count: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM notes n JOIN folders f ON f.id=n.folder_id
                 WHERE f.workspace_id=?1 AND n.title='Partner'",
                [&t_ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(partner_count, 1);

        // Silence unused.
        let _ = (folder, note_a);
    }

    #[test]
    fn hash_merge_update_existing_rewrites_same_title() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        // Mutate Sejong body so the hash differs from target's old copy.
        conn.execute(
            "UPDATE sections SET body_md='## Over\n\nUPDATED body' WHERE note_id IN
             (SELECT id FROM notes WHERE title='Sejong')",
            [],
        )
        .unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"hello").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let now = now_iso();
        let t_ws = new_id();
        let t_folder = new_id();
        let t_note = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Era',0,1,?3)",
                params![t_folder, t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
                 VALUES (?1,?2,'Sejong',1443,0,?3,?3)",
                params![t_note, t_folder, now],
            )
            .unwrap();
        // PLAN-2026-09-08-dates-rebuild.md W1: raw INSERT bypasses insert_note/
        // create_with_sections_with_hook, so this fixture must seed the position=0 row those
        // paths always create — otherwise update_note_in_place's project_primary() call below
        // hits the "no position=0 row" invariant error instead of exercising the update path.
        target
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, remind, created_at) VALUES (?1,?2,0,1443,0,?3)",
                params![new_id(), t_note, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','old body',0)",
                params![new_id(), t_note],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        let imp = import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            true, // update_existing
        )
        .unwrap();
        // Sejong updated in place + Partner added.
        assert_eq!(imp.imported_notes, 2);

        let sejong_count: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM notes n JOIN folders f ON f.id=n.folder_id
                 WHERE f.workspace_id=?1 AND n.title='Sejong'",
                [&t_ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sejong_count, 1, "update-in-place must not create a second Sejong");
        let body: String = target
            .query_row(
                "SELECT body_md FROM sections WHERE note_id=?1",
                [&t_note],
                |r| r.get(0),
            )
            .unwrap();
        assert!(body.contains("UPDATED"), "body must be rewritten: {body}");
        // Same note id preserved.
        let still: i64 = target
            .query_row("SELECT COUNT(*) FROM notes WHERE id=?1", [&t_note], |r| r.get(0))
            .unwrap();
        assert_eq!(still, 1);
    }

    // ── archived_at 병합 규칙(리그레션, 데이터 손실 P0) ──────────────────────────────────
    // update_note_in_place 의 archived_at 은 is_favorite/status 와 같은 "번들 값이 항상 이긴다"
    // 규칙을 따른다(update_note_in_place 위 주석 참조) — 아래 두 테스트가 그 규칙의 양쪽 방향을
    // 각각 고정한다.

    /// 로컬은 미아카이브, 번들(source)은 아카이브 — 제자리 갱신 후 로컬도 아카이브로 바뀐다.
    #[test]
    fn hash_merge_update_existing_adopts_incoming_archived_state() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, src_note) = seed_notebook_bundle_source(&mut conn);
        // Body must differ, or hash_merge takes the "identical → skip" branch instead of
        // update-in-place (same precondition as hash_merge_update_existing_rewrites_same_title).
        conn.execute(
            "UPDATE sections SET body_md='## Over\n\nUPDATED body' WHERE note_id=?1",
            [&src_note],
        )
        .unwrap();
        crate::repo::notes::archive(&mut conn, &src_note).unwrap();
        let archived_at: String = conn
            .query_row("SELECT archived_at FROM notes WHERE id=?1", [&src_note], |r| r.get(0))
            .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        // 대상(로컬) 노트는 같은 제목, 미아카이브 상태로 시작.
        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let now = now_iso();
        let t_ws = new_id();
        let t_folder = new_id();
        let t_note = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Era',0,1,?3)",
                params![t_folder, t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
                 VALUES (?1,?2,'Sejong',1443,0,?3,?3)",
                params![t_note, t_folder, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, remind, created_at) VALUES (?1,?2,0,1443,0,?3)",
                params![new_id(), t_note, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','old body',0)",
                params![new_id(), t_note],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            true, // update_existing
        )
        .unwrap();

        let local_archived: Option<String> = target
            .query_row("SELECT archived_at FROM notes WHERE id=?1", [&t_note], |r| r.get(0))
            .unwrap();
        assert_eq!(
            local_archived.as_deref(),
            Some(archived_at.as_str()),
            "incoming bundle's archived state must win when the local note was not archived"
        );
    }

    /// 병합 규칙의 반대 방향: 로컬은 아카이브, 번들(source)은 미아카이브 — 제자리 갱신 후 로컬
    /// 아카이브가 풀린다. 어느 방향이든 번들 값이 이긴다는 같은 규칙(위 테스트와 대칭).
    #[test]
    fn hash_merge_update_existing_unarchives_when_incoming_is_not_archived() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, src_note) = seed_notebook_bundle_source(&mut conn);
        conn.execute(
            "UPDATE sections SET body_md='## Over\n\nUPDATED body' WHERE note_id=?1",
            [&src_note],
        )
        .unwrap();
        // 번들 쪽(source) 노트는 미아카이브 상태 그대로 둔다.

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        // 대상(로컬) 노트는 같은 제목, 아카이브 상태로 시작 — title_to_id/existing_hashes 스캔은
        // deleted_at 만 걸러 archived_at 은 걸러내지 않으므로(hash_merge.rs 쿼리 참조) 이
        // 로컬 노트도 title 매치 대상이다.
        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let now = now_iso();
        let t_ws = new_id();
        let t_folder = new_id();
        let t_note = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Era',0,1,?3)",
                params![t_folder, t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, is_favorite, archived_at, created_at, updated_at)
                 VALUES (?1,?2,'Sejong',1443,0,?3,?4,?4)",
                params![t_note, t_folder, now, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, remind, created_at) VALUES (?1,?2,0,1443,0,?3)",
                params![new_id(), t_note, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','old body',0)",
                params![new_id(), t_note],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            true, // update_existing
        )
        .unwrap();

        let local_archived: Option<String> = target
            .query_row("SELECT archived_at FROM notes WHERE id=?1", [&t_note], |r| r.get(0))
            .unwrap();
        assert_eq!(
            local_archived, None,
            "incoming bundle's not-archived state must win when the local note was archived"
        );
    }

    // 리그레션(PLAN-2026-09-08-dates-rebuild.md §7-1 투영 드리프트, 감사 2026-09-08 발견):
    // update_note_in_place 가 예전에는 notes.year/remind/start_time 등을 직접 UPDATE 했다 — V76
    // 이전엔 그 컬럼들이 사건 축의 진실이라 안전했지만, 지금은 note_dates 의 position=0 행이
    // 진실이고 notes.* 는 project_primary() 가 갱신하는 투영일 뿐이다. note_dates 를 그대로 두고
    // notes.* 만 갈아치우면, 그 직후엔 화면이 맞아 보여도 **다음 날짜 mutation**(여기서는 상관없는
    // 관련 날짜 하나 추가)이 project_primary 를 다시 태워 옛 값으로 되돌린다 — commands::ai.rs 의
    // AI 정리 드리프트와 같은 결함 계열. "적용 직후"가 아니라 "그 뒤 다른 날짜 작업을 해도
    // 살아남는가"를 봐야 잡힌다(계획서 §5 리스크 1).
    #[test]
    fn hash_merge_update_existing_primary_date_survives_later_date_mutation() {
        use crate::repo::notes::dates;
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        let src_note: String = conn
            .query_row("SELECT id FROM notes WHERE title='Sejong'", [], |r| r.get(0))
            .unwrap();
        // Body must differ too, or hash_merge takes the "identical → skip" branch instead of
        // update-in-place (same precondition as hash_merge_update_existing_rewrites_same_title).
        conn.execute(
            "UPDATE sections SET body_md='## Over\n\nUPDATED body' WHERE note_id=?1",
            [&src_note],
        )
        .unwrap();
        // Move the source's primary date forward through the real repo entry point (note_dates
        // is truth, project_primary mirrors it) so the exported bundle's NoteRow carries the new
        // value the same way a live app would.
        {
            let tx = conn.transaction().unwrap();
            tx.execute(
                "UPDATE note_dates SET year=1592, remind=1, start_time='09:00' WHERE note_id=?1 AND position=0",
                [&src_note],
            )
            .unwrap();
            dates::project_primary(&tx, &src_note).unwrap();
            tx.commit().unwrap();
        }

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let now = now_iso();
        let t_ws = new_id();
        let t_folder = new_id();
        let t_note = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Era',0,1,?3)",
                params![t_folder, t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
                 VALUES (?1,?2,'Sejong',1443,0,?3,?3)",
                params![t_note, t_folder, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO note_dates(id, note_id, position, year, remind, created_at) VALUES (?1,?2,0,1443,0,?3)",
                params![new_id(), t_note, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body','old body',0)",
                params![new_id(), t_note],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            true, // update_existing
        )
        .unwrap();

        let (year, remind, start_time): (i64, i64, Option<String>) = target
            .query_row(
                "SELECT year, remind, start_time FROM notes WHERE id=?1",
                [&t_note],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(year, 1592, "notes.year projection must reflect the imported primary date");
        assert_eq!(remind, 1);
        assert_eq!(start_time.as_deref(), Some("09:00"));
        // The note_dates position=0 row itself (the truth) must also carry the new value —
        // this is what the old code left stale.
        let nd_year: i64 = target
            .query_row(
                "SELECT year FROM note_dates WHERE note_id=?1 AND position=0",
                [&t_note],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(nd_year, 1592, "note_dates position=0 row (truth) must be updated, not just the notes.* mirror");

        // Now perform an unrelated date mutation — date_add ends with project_primary(). If the
        // position=0 row above were still stale, this call would silently revert notes.year back
        // to 1443.
        dates::date_add(
            &mut target, &t_note, 1600, None, None, None, None, None, None, None, false, None, None,
            None,
        )
        .unwrap();
        let year_after: i64 = target
            .query_row("SELECT year FROM notes WHERE id=?1", [&t_note], |r| r.get(0))
            .unwrap();
        assert_eq!(year_after, 1592, "adding an unrelated related date must not revert the primary-date projection");
    }

    // 리그레션(데이터 손실 P0): "새 노트로 추가" 분기(update_existing=false 또는 제목 불일치)도
    // add_notebook 과 같은 버그를 갖고 있었다 — 새 note_id 를 발급하면서 rel_path 는 옛
    // note_id 디렉토리를 그대로 가리켰다. seed_notebook_bundle_source 의 'file.txt' 는 실제
    // attachment_add 가 절대 만들지 않는 맨 파일명이라 이 케이스를 가리지 못했으므로, 실제
    // 포맷("{note_id}/file.png")을 그대로 재현한다.
    #[test]
    fn hash_merge_remaps_attachment_rel_path_for_new_note() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let ws = new_id();
        let folder = new_id();
        let note = new_id();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Source',?2)",
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
             VALUES (?1,?2,'Photo Note',2000,0,?3,?3)",
            params![note, folder, now],
        )
        .unwrap();
        // Realistic rel_path — mirrors attachments::attachment_add's actual format.
        let rel_path = format!("{note}/file.png");
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, position, created_at)
             VALUES (?1,?2,'file.png','doc',?3,0,?4)",
            params![new_id(), note, rel_path, now],
        )
        .unwrap();
        // 본문의 인라인 이미지는 그 rel_path 를 글자 그대로 적는다(imageExtension.ts renderMarkdown).
        conn.execute(
            "INSERT INTO sections(id, note_id, name, body_md, position) VALUES (?1,?2,'Body',?3,0)",
            params![new_id(), note, format!("글

![사진]({rel_path}){{width=40%}}")],
        )
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(att_dir.join(&note)).unwrap();
        std::fs::write(att_dir.join(&rel_path), b"PNGDATA").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        // Target notebook has no overlapping content, so hash_merge takes the "add as new note"
        // branch (the one that assigns a fresh note_id).
        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let t_ws = new_id();
        let t_folder = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Era',0,1,?3)",
                params![t_folder, t_ws, now],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        let imp = import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            false,
        )
        .unwrap();
        assert_eq!(imp.imported_notes, 1);

        let (new_note_id, new_rel_path): (String, String) = target
            .query_row(
                "SELECT note_id, rel_path FROM attachments WHERE name='file.png'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(new_note_id, note, "note id must be remapped on hash_merge import");
        assert!(
            new_rel_path.starts_with(&format!("{new_note_id}/")),
            "rel_path must point at the NEW note id, got {new_rel_path}"
        );

        let on_disk =
            std::fs::read(db::attachments_dir(target_data.path()).join(&new_rel_path)).unwrap();
        assert_eq!(on_disk, b"PNGDATA");

        // 본문도 새 경로를 가리켜야 한다 — 안 그러면 가져온 기기엔 옛 note_id 디렉토리가 없어 깨진 이미지다.
        let body: String = target
            .query_row("SELECT body_md FROM sections WHERE note_id=?1", [&new_note_id], |r| r.get(0))
            .unwrap();
        assert!(body.contains(&format!("]({new_rel_path})")), "body must point at the NEW rel_path: {body}");
        assert!(!body.contains(&rel_path), "old rel_path must not survive in the body: {body}");

        // Boot-time orphan_cleanup must not treat the freshly-imported dir as orphaned.
        crate::repo::attachments::orphan_cleanup(&target, target_data.path()).unwrap();
        assert!(db::attachments_dir(target_data.path()).join(&new_rel_path).exists());
    }

    // 참조/무결성(표별 커버리지 + 멱등): import_hash_merge 를 표별 merge_* 로 쪼갠 뒤,
    // "어느 한 표를 옮기다 빠뜨려도 기존 테스트는 초록"이던 구멍을 막는다. 병합 대상 표마다
    // 행이 있는 번들을 빈 노트북에 넣고 (a) 표별 행 수를, 이어서 같은 번들을 한 번 더 넣고
    // (b) 노트 쪽 표가 한 행도 늘지 않음을 본다.
    #[test]
    fn hash_merge_carries_every_child_table_and_second_merge_adds_nothing() {
        use super::super::{insert_routine_completion, insert_source, insert_space, insert_space_item};
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        // 픽스처가 이미 채우는 것: folders/notes/sections/tags/note_tags/workspace_regions/
        // note_regions/note_dates(position 0·1)/attachments.
        let (ws, _folder, note_a) = seed_notebook_bundle_source(&mut conn);
        let now = now_iso();

        // 픽스처에 없는 나머지 표를 마저 채운다.
        let era = new_id();
        conn.execute(
            "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
             VALUES (?1,?2,'Joseon',1392,1897,0,?3)",
            params![era, ws, now],
        )
        .unwrap();
        let src_status = new_id();
        conn.execute(
            "INSERT INTO workspace_statuses(id, workspace_id, name, position, created_at)
             VALUES (?1,?2,'검토중',0,?3)",
            params![src_status, ws, now],
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET status=?1 WHERE id=?2",
            params![src_status, note_a],
        )
        .unwrap();
        let src_space = new_id();
        {
            let tx = conn.transaction().unwrap();
            insert_source(
                &tx,
                &SourceRow {
                    id: new_id(),
                    note_id: note_a.clone(),
                    name: "원문".into(),
                    ext: "txt".into(),
                    body: "훈민정음".into(),
                    position: 0,
                    created_at: now.clone(),
                },
            )
            .unwrap();
            insert_routine_completion(
                &tx,
                &RoutineCompletionRow {
                    note_id: note_a.clone(),
                    occur_on: "2026-09-21".into(),
                    done_at: now.clone(),
                },
            )
            .unwrap();
            insert_space(
                &tx,
                &SpaceRow {
                    id: src_space.clone(),
                    workspace_id: ws.clone(),
                    title: "보드".into(),
                    position: 0,
                    is_home: 0,
                    is_favorite: 0,
                    archived_at: None,
                    default_style: String::new(),
                    last_viewport_x: 0.0,
                    last_viewport_y: 0.0,
                    last_viewport_zoom: 1.0,
                    home_viewport_x: None,
                    home_viewport_y: None,
                    home_viewport_zoom: None,
                    layout_locked: 0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            )
            .unwrap();
            insert_space_item(
                &tx,
                &SpaceItemRow {
                    id: new_id(),
                    space_id: src_space.clone(),
                    kind: "note".into(),
                    source_id: Some(note_a.clone()),
                    content: String::new(),
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 120.0,
                    z_index: 0,
                    display_mode: "preview".into(),
                    style: String::new(),
                    locked: 0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            )
            .unwrap();
            tx.commit().unwrap();
        }

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"hello").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        // 대상: 노트가 하나도 없는 빈 노트북(폴더 하나뿐, 이름도 번들과 다르다).
        let mut target = Connection::open_in_memory().unwrap();
        migrations::run(&mut target).unwrap();
        let t_ws = new_id();
        target
            .execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Target',?2)",
                params![t_ws, now],
            )
            .unwrap();
        target
            .execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at)
                 VALUES (?1,?2,'Other',0,1,?3)",
                params![new_id(), t_ws, now],
            )
            .unwrap();

        let target_data = tempfile::tempdir().unwrap();
        let first = import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            false,
        )
        .unwrap();
        assert_eq!((first.imported_notes, first.skipped), (2, 0));

        fn count(c: &Connection, table: &str) -> i64 {
            c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        }
        // (a) 표별로 실제 행이 들어갔나 — 하나라도 merge_* 에서 빠지면 여기서 0 이 된다.
        // 이 카운트들은 전역이다 — migrations::run 이 심는 기본 노트북에는 아래 표의 행이
        // 없으므로 섞이지 않는다(folders 만 예외라 따로 노트북 스코프로 센다).
        let expected: [(&str, i64); 13] = [
            ("notes", 2),
            ("sections", 2),
            ("sources", 1),
            ("attachments", 1),
            ("tags", 1),
            ("note_tags", 1),
            ("note_regions", 1),
            ("routine_completions", 1),
            ("workspace_regions", 1),
            ("workspace_eras", 1),
            ("workspace_statuses", 1),
            ("spaces", 1),
            ("space_items", 1),
        ];
        for (table, want) in expected {
            assert_eq!(count(&target, table), want, "{table} after first merge");
        }
        // 폴더는 이름으로 맞춘다 — 번들의 'Era' 는 대상에 없어 새로 생기고 'Other' 는 남는다.
        let folders_in_target = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT COUNT(*) FROM folders WHERE workspace_id=?1",
                [&t_ws],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(folders_in_target(&target), 2);
        // note_dates 3 행 = 노트 2개의 대표 날짜(position=0, insert_note 가 심는다) + 픽스처의
        // 관련 날짜 1개. 번들은 position=0 행을 싣지 않으므로(export.rs `WHERE position != 0`,
        // 대표는 NoteRow 컬럼으로 왕복한다) 대표가 두 번 들어오지 않는다.
        assert_eq!(count(&target, "note_dates"), 3);
        assert_eq!(
            target
                .query_row("SELECT COUNT(*) FROM note_dates WHERE year=1446", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1,
            "관련 날짜가 새 노트로 따라와야 한다"
        );

        // status 는 대상 노트북의 **같은 이름** 상태 id 로 다시 쓰인다(번들 id 그대로가 아니다).
        let local_status: String = target
            .query_row("SELECT id FROM workspace_statuses", [], |r| r.get(0))
            .unwrap();
        let note_status: String = target
            .query_row("SELECT status FROM notes WHERE title='Sejong'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note_status, local_status);
        assert_ne!(note_status, src_status, "번들의 status id 가 그대로 남으면 안 된다");

        // 공간 아이템의 source_id 도 새 note_id 를 가리켜야 한다.
        let new_sejong: String = target
            .query_row("SELECT id FROM notes WHERE title='Sejong'", [], |r| r.get(0))
            .unwrap();
        assert_ne!(new_sejong, note_a, "새 note_id 가 발급돼야 한다");
        let item_source: Option<String> = target
            .query_row("SELECT source_id FROM space_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(item_source.as_deref(), Some(new_sejong.as_str()));



        // (b) 같은 번들을 한 번 더 — 두 노트 모두 콘텐츠 해시가 같아 skip 이고, 노트 쪽 표는
        // 한 행도 늘지 않는다.
        let second = import_bundle(
            &mut target,
            target_data.path(),
            Path::new(&exp.bundle_path),
            "hash_merge",
            Some(&t_ws),
            false,
        )
        .unwrap();
        assert_eq!((second.imported_notes, second.skipped), (0, 2));
        for (table, want) in expected {
            // 공간은 중복 제거가 없어 두 벌이 된다(merge_spaces 문서) — 그 수를 여기서 굳히지
            // 않으려고 이 두 표만 뺀다.
            if table == "spaces" || table == "space_items" {
                continue;
            }
            assert_eq!(count(&target, table), want, "{table} must not grow on a repeat merge");
        }
        assert_eq!(folders_in_target(&target), 2, "folders must not grow on a repeat merge");
        assert_eq!(count(&target, "note_dates"), 3, "note_dates must not grow on a repeat merge");
    }
}
