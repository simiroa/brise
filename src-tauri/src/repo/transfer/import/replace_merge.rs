// repo::transfer::import::replace_merge — `replace`(전체 교체)와 `merge`(레거시 id 기반 병합)
// 두 알고리즘. R4 이전에는 import_bundle 안의 if/else 두 분기였다 — 시그니처를 add_notebook/
// hash_merge와 통일해(conn, data_dir, bundle, bundle_att, data_att) 독립 함수로 뽑았다.
use crate::db;
use crate::error::{db as dberr, io, AppResult};
use crate::repo::fts;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::super::swap::{discard_old_tree, sibling_of, swap_tree};
use super::super::bundle::{AttachmentRow, Bundle};
use super::ImportResult;

/// 교체 가져오기의 첨부 스왑에 쓰는 (스테이징, 옛 첨부) 자리 — 둘 다 **실제 첨부 폴더(`data_att`)의 형제**다.
/// 저장 위치 재정의(db::set_dir_overrides)로 attachments/ 가 data_dir 밖(다른 볼륨)에 있으면 data_dir 아래 자리로는
/// rename 이 볼륨을 건너 실패하는데, 커밋 **뒤**에야 터져 DB 는 번들·첨부는 옛 파일인 채 남는다(복원·초기화의
/// `attachments_sibling` 과 같은 이유 — backup.rs). 재정의가 없으면 부모 = data_dir 그대로다.
fn att_swap_paths(data_dir: &Path, data_att: &Path) -> (PathBuf, PathBuf) {
    (
        sibling_of(data_att, data_dir, &format!("attachments.incoming-{}", crate::util::new_id())),
        sibling_of(data_att, data_dir, &format!("attachments.old-{}", crate::util::new_id())),
    )
}

/// `replace` — 스냅샷 백업 → 첨부 스테이징 복사(실패해도 기존 상태 보존) → 단일 트랜잭션으로
/// wipe + insert_all → 커밋 후 attachments/ rename 스왑.
pub(super) fn import_replace(
    conn: &mut Connection,
    data_dir: &Path,
    bundle: &Bundle,
    bundle_att: &Path,
    data_att: &Path,
) -> AppResult<ImportResult> {
        let backup_path = db::snapshot_backup(conn, &db::backups_dir(data_dir))?;

        // 첨부 복사(실패 확률이 높은 IO)를 DB 커밋보다 먼저, 라이브 attachments/ 와 무관한
        // 스테이징 디렉토리에서 끝낸다. 예전 순서(커밋 → 기존 attachments/ 삭제 → 복사)는
        // 삭제와 복사 사이의 창(crash/IO 에러)에 프로세스가 죽으면 DB 는 이미 새 상태로
        // 커밋됐는데 기존 첨부 파일은 통째로 사라진 채 복구 불가능했다. 이 순서면 복사가
        // 실패해도 DB/기존 attachments/ 모두 그대로이고, 커밋 뒤에는 rename 스왑만 남아
        // 실패 가능성이 훨씬 낮다.
        let (staging_att, old_att) = att_swap_paths(data_dir, data_att);
        std::fs::create_dir_all(&staging_att).map_err(io)?;
        if let Err(e) = super::copy_attachments(&bundle.attachments, &bundle_att, &staging_att) {
            let _ = std::fs::remove_dir_all(&staging_att);
            return Err(e);
        }
        if let Err(e) = super::copy_space_images(&bundle.space_items, bundle_att, &staging_att) {
            let _ = std::fs::remove_dir_all(&staging_att);
            return Err(e);
        }

        let tx = conn.transaction().map_err(dberr)?;
        let secrets = super::read_secret_settings(&tx)?;
        // 수집 소스는 번들에 안 실린다(extras.rs 헤더) — 비밀 설정처럼 이 설치본 쪽 상태다. V96 부터
        // wipe 의 `DELETE FROM workspaces` 가 collect_sources/collect_seen 까지 CASCADE 로 지우므로,
        // 미리 떠 두었다가 번들에 같은 id 의 노트북이 돌아온 소스만 되살린다(나머지는 정당한 고아).
        // FK PRAGMA 가 꺼진 연결이어도 결과가 같도록 명시적으로 비운 뒤 다시 넣는다.
        tx.execute_batch(
            "DROP TABLE IF EXISTS temp._replace_keep_cs;
             DROP TABLE IF EXISTS temp._replace_keep_seen;
             CREATE TEMP TABLE _replace_keep_cs AS SELECT * FROM collect_sources;
             CREATE TEMP TABLE _replace_keep_seen AS SELECT * FROM collect_seen;",
        )
        .map_err(dberr)?;
        super::wipe(&tx)?;
        super::insert_all(&tx, &bundle)?;
        tx.execute_batch(
            "DELETE FROM collect_seen;
             DELETE FROM collect_sources;
             INSERT INTO collect_sources SELECT * FROM temp._replace_keep_cs
               WHERE workspace_id IN (SELECT id FROM workspaces);
             INSERT INTO collect_seen SELECT * FROM temp._replace_keep_seen
               WHERE source_id IN (SELECT id FROM collect_sources);
             DROP TABLE temp._replace_keep_cs;
             DROP TABLE temp._replace_keep_seen;",
        )
        .map_err(dberr)?;
        super::restore_secret_settings(&tx, &secrets)?;
        for n in &bundle.notes {
            fts::fts_upsert(&tx, &n.id)?;
        }
        super::prune_dangling_internal(&tx)?;
        if let Err(e) = tx.commit() {
            let _ = std::fs::remove_dir_all(&staging_att);
            return Err(dberr(e));
        }

        // 커밋은 끝났으니 여기서부터는 되돌릴 수 없다. 남은 건 rename 뿐이라(복사와 달리)
        // 실패 확률이 낮고, 설령 실패해도 기존 파일들은 data_att 또는 old_att 위치에 그대로
        // 남아 있어 유실로 이어지지 않는다. 그래도 실패하면 DB 는 번들·attachments/ 는 옛 파일인 채
        // 어긋나므로 반드시 기록한다(릴리즈엔 콘솔이 없다 — diag).
        swap_tree(data_att, &staging_att, &old_att, "import attachments")?;
        discard_old_tree(&old_att, "import attachments.old");

        Ok(ImportResult {
            imported_notes: bundle.notes.len() as i64,
            skipped: 0,
            backup_path: Some(backup_path.to_string_lossy().to_string()),
        })
}

/// `merge` — 기존 행은 보존, id 충돌 노트는 skip(레거시 id 기반). 태그는 이름(COLLATE
/// NOCASE) 병합, 그 외 워크스페이스/폴더/노트/자식 엔터티는 INSERT OR IGNORE.
pub(super) fn import_merge(
    conn: &mut Connection,
    _data_dir: &Path,
    bundle: Bundle,
    bundle_att: &Path,
    data_att: &Path,
) -> AppResult<ImportResult> {
        let mut imported = 0i64;
        let mut skipped = 0i64;
        let mut imported_ids: Vec<String> = Vec::new();
        {
            let tx = conn.transaction().map_err(dberr)?;
            for ws in &bundle.workspaces {
                tx.execute(
                    "INSERT OR IGNORE INTO workspaces(id, name, created_at) VALUES (?1,?2,?3)",
                    params![ws.id, ws.name, ws.created_at],
                )
                .map_err(dberr)?;
            }
            // Wave 14: 사용자 추가 지역/시대 — id 충돌은 skip(OR IGNORE), 대상 워크스페이스가
            // 이 번들에 없으면 FK 위반으로 마찬가지로 조용히 skip(부분 번들 안전).
            for r in &bundle.workspace_regions {
                tx.execute(
                    "INSERT OR IGNORE INTO workspace_regions(id, workspace_id, name, position, created_at)
                     VALUES (?1,?2,?3,?4,?5)",
                    params![r.id, r.workspace_id, r.name, r.position, r.created_at],
                )
                .map_err(dberr)?;
            }
            for e in &bundle.workspace_eras {
                tx.execute(
                    "INSERT OR IGNORE INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![e.id, e.workspace_id, e.name, e.from_year, e.to_year, e.position, e.created_at],
                )
                .map_err(dberr)?;
            }
            // Wave 15: 사용자 추가 노트 상태 — workspace_regions/workspace_eras 와 동일하게
            // id 충돌은 skip, 대상 워크스페이스가 이 번들에 없으면 FK 위반으로 skip.
            for s in &bundle.workspace_statuses {
                tx.execute(
                    "INSERT OR IGNORE INTO workspace_statuses(id, workspace_id, name, position, created_at)
                     VALUES (?1,?2,?3,?4,?5)",
                    params![s.id, s.workspace_id, s.name, s.position, s.created_at],
                )
                .map_err(dberr)?;
            }
            for f in &bundle.folders {
                tx.execute(
                    "INSERT OR IGNORE INTO folders(id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![f.id, f.workspace_id, f.name, f.position, f.is_open, f.created_at, f.color_hue, f.icon, f.rules, f.search_excluded, f.ai_excluded],
                )
                .map_err(dberr)?;
            }
            // 태그 이름 병합(vocabulary hygiene): tags.name 은 COLLATE NOCASE UNIQUE(schema, tag
            // 생성 시 repo::notes::replace_note_tags 가 재사용하는 것과 동일 규칙) — 번들의 태그
            // 이름이 이미 있는 태그와 대소문자만 다르면, 예전처럼 INSERT OR IGNORE 로 조용히
            // 버리면 그 태그를 참조하는 note_tags 행까지 FK 위반으로 함께 사라져 노트가 태그를
            // 통째로 잃었다(다른 사람 번들을 가져올 때 "새 태그가 안 생겼다"가 아니라 "태그가
            // 사라졌다"는 실제 데이터 손실). 대신 들어오는 tag id -> 기존(또는 방금 만든) tag id
            // 로 매핑해두고, note_tags 삽입 때 그 매핑을 거친다. 번들 자체에 같은 이름이 여러 개
            // 있어도(다른 사람이 만든 번들이라 보장 없음) 트랜잭션 안에서 먼저 넣은 것부터
            // 순서대로 보여 뒤엣것이 그 id 로 수렴한다.
            let mut tag_id_map: HashMap<String, String> = HashMap::new();
            for t in &bundle.tags {
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                        [&t.name],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(dberr)?;
                match existing {
                    Some(existing_id) => {
                        tag_id_map.insert(t.id.clone(), existing_id);
                    }
                    None => {
                        tx.execute(
                            "INSERT OR IGNORE INTO tags(id, name) VALUES (?1,?2)",
                            params![t.id, t.name],
                        )
                        .map_err(dberr)?;
                        tag_id_map.insert(t.id.clone(), t.id.clone());
                    }
                }
            }
            for note in &bundle.notes {
                let exists: bool = tx
                    .query_row("SELECT 1 FROM notes WHERE id=?1", [&note.id], |_| Ok(true))
                    .ok()
                    .unwrap_or(false);
                if exists {
                    skipped += 1;
                    continue;
                }
                super::insert_note(&tx, note)?;
                for s in bundle.sections.iter().filter(|s| s.note_id == note.id) {
                    super::insert_section(&tx, s)?;
                }
                for s in bundle.sources.iter().filter(|s| s.note_id == note.id) {
                    super::insert_source(&tx, s)?;
                }
                for a in bundle.attachments.iter().filter(|a| a.note_id == note.id) {
                    super::insert_attachment(&tx, a)?;
                }
                for r in bundle.note_regions.iter().filter(|r| r.note_id == note.id) {
                    super::insert_note_region(&tx, r)?;
                }
                for d in bundle.note_dates.iter().filter(|d| d.note_id == note.id) {
                    super::insert_note_date(&tx, d)?;
                }
                for nt in bundle.note_tags.iter().filter(|nt| nt.note_id == note.id) {
                    // 매핑에 없으면(번들이 자기 tags 목록에 없는 tag_id 를 참조하는 기형 케이스)
                    // 원래 id 그대로 시도 — 어차피 tags 에 없으니 FK 위반으로 OR IGNORE 가 조용히
                    // 스킵한다(이전과 동일한 fail-safe, 정상 번들에서는 도달하지 않는다).
                    let tag_id = tag_id_map.get(&nt.tag_id).unwrap_or(&nt.tag_id);
                    tx.execute(
                        "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
                        params![nt.note_id, tag_id],
                    )
                    .map_err(dberr)?;
                }
                for rc in bundle.routine_completions.iter().filter(|rc| rc.note_id == note.id) {
                    super::insert_routine_completion(&tx, rc)?;
                }
                fts::fts_upsert(&tx, &note.id)?;
                imported += 1;
                imported_ids.push(note.id.clone());
            }
            // note_related_exclusions references TWO notes, so it can't be scoped to "children of
            // one note" the way sections/sources/attachments/note_regions are above — it has to run
            // once after every note in this bundle has settled (freshly inserted above, or already
            // existing locally and skipped), so a pair's FK targets are resolved either way
            // regardless of which note in the pair the loop above visited first.
            // insert_note_related_exclusion's OR IGNORE absorbs both "pair already exists locally"
            // and "the other side of the pair isn't in this DB at all" (partial/folder bundle).
            for x in &bundle.note_related_exclusions {
                super::insert_note_related_exclusion(&tx, x)?;
            }
            for s in &bundle.spaces {
                tx.execute(
                    "INSERT OR IGNORE INTO spaces(id, workspace_id, title, position, is_home, is_favorite, archived_at, default_style, last_viewport_x, last_viewport_y, last_viewport_zoom, home_viewport_x, home_viewport_y, home_viewport_zoom, layout_locked, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                    params![s.id, s.workspace_id, s.title, s.position, s.is_home, s.is_favorite, s.archived_at, s.default_style, s.last_viewport_x, s.last_viewport_y, s.last_viewport_zoom, s.home_viewport_x, s.home_viewport_y, s.home_viewport_zoom, s.layout_locked, s.created_at, s.updated_at],
                )
                .map_err(dberr)?;
                tx.execute(
                    "UPDATE workspaces SET space_bootstrapped = 1 WHERE id = ?1",
                    [&s.workspace_id],
                )
                .map_err(dberr)?;
            }
            for item in &bundle.space_items {
                tx.execute(
                    "INSERT OR IGNORE INTO space_items(id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    params![item.id, item.space_id, item.kind, item.source_id, item.content, item.x, item.y, item.width, item.height, item.z_index, item.display_mode, item.style, item.locked, item.created_at, item.updated_at],
                )
                .map_err(dberr)?;
            }
            super::prune_dangling_internal(&tx)?;
            tx.commit().map_err(dberr)?;
        }
        // merge 도 commit 이 파일 복사보다 먼저라는 점에서 같은 부류의 문제이지만, replace 와
        // 달리 기존 attachments/ 를 지우지 않고 새 파일만 더하기 때문에 최악의 경우도 "복사 중
        // 실패해 새 첨부 일부가 안 보임"이지 기존 데이터 유실이 아니다(replace 가 P0인 이유).
        // new_atts 계산이 위 트랜잭션의 exists 체크 결과(imported_ids)에 의존해 replace 처럼
        // 커밋 전으로 옮기려면 그 판정 로직을 트랜잭션 밖에서 중복 구현해야 해 여기서는 그대로 둔다.
        let new_atts: Vec<AttachmentRow> = bundle
            .attachments
            .into_iter()
            .filter(|a| imported_ids.contains(&a.note_id))
            .collect();
        std::fs::create_dir_all(&data_att).map_err(io)?;
        super::copy_attachments(&new_atts, &bundle_att, &data_att)?;
        super::copy_space_images(&bundle.space_items, bundle_att, data_att)?;
        Ok(ImportResult {
            imported_notes: imported,
            skipped,
            backup_path: None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::import_bundle;
    use crate::db::migrations;
    use crate::error::AppError;
    use crate::repo::transfer::bundle::{FolderRow, NoteRow, WorkspaceRow};
    use crate::util::now_iso;

    // 부분/단일 export 번들이 "다른 노트를 가리키는 internal 첨부"를 포함하되 그 대상 노트는
    // 번들에 없는 상황을 재현한다: noteA -> internal -> "ghost" (번들에 없음), 그리고
    // noteA -> internal -> noteB (둘 다 번들에 있어 유효) 를 함께 넣어 유효한 행은 살아남는지도
    // 같이 검증한다.
    fn bundle_with_dangling_internal(folder_id: &str, version: i64) -> Bundle {
        let now = now_iso();
        Bundle {
            version,
            workspaces: vec![],
            folders: vec![],
            notes: vec![
                NoteRow {
                    id: "noteA".to_string(),
                    folder_id: folder_id.to_string(),
                    title: "Note A".to_string(),
                    year: 2000,
                    is_favorite: 0,
                    exported_at: None,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    region: None,
                    status: None,
                    month: None,
                    day: None,
                    remind: 0,
                    end_year: None,
                    end_month: None,
                    end_day: None,
                    icon: None,
                    lat: None,
                    lng: None,
                    start_time: None,
                    end_time: None,
                    remind_offset_min: None,
                    rrule: None,
                    archived_at: None,
                },
                NoteRow {
                    id: "noteB".to_string(),
                    folder_id: folder_id.to_string(),
                    title: "Note B".to_string(),
                    year: 2001,
                    is_favorite: 0,
                    exported_at: None,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    region: None,
                    status: None,
                    month: None,
                    day: None,
                    remind: 0,
                    end_year: None,
                    end_month: None,
                    end_day: None,
                    icon: None,
                    lat: None,
                    lng: None,
                    start_time: None,
                    end_time: None,
                    remind_offset_min: None,
                    rrule: None,
                    archived_at: None,
                },
            ],
            sections: vec![],
            sources: vec![],
            attachments: vec![
                // dangling: target "ghost" is not part of the bundle/db.
                AttachmentRow {
                    id: "att-dangling".to_string(),
                    note_id: "noteA".to_string(),
                    name: "dead link".to_string(),
                    kind: "internal".to_string(),
                    rel_path: None,
                    url: Some("ghost".to_string()),
                    size_bytes: None,
                    position: 0,
                    created_at: now.clone(),
                },
                // valid: target noteB is part of the bundle.
                AttachmentRow {
                    id: "att-valid".to_string(),
                    note_id: "noteA".to_string(),
                    name: "live link".to_string(),
                    kind: "internal".to_string(),
                    rel_path: None,
                    url: Some("noteB".to_string()),
                    size_bytes: None,
                    position: 1,
                    created_at: now,
                },
            ],
            tags: vec![],
            note_tags: vec![],
            settings: vec![],
            workspace_regions: vec![],
            workspace_eras: vec![],
            workspace_statuses: vec![],
            note_regions: vec![],
            note_dates: vec![],
            note_related_exclusions: vec![],
            spaces: vec![],
            space_items: vec![],
            routine_completions: vec![],
            workspace_settings: vec![],
            timeline_routines: vec![],
        calendar_sources: vec![],
        calendar_marks: vec![],
        calendar_mark_hides: vec![],
        }
    }

    fn write_bundle(dir: &Path, bundle: &Bundle) -> std::path::PathBuf {
        let path = dir.join("brise-bundle.json");
        let json = serde_json::to_string_pretty(bundle).unwrap();
        std::fs::write(&path, json).unwrap();
        path
    }

    /// Item 7 (belt-and-suspenders): a hand-crafted bundle carrying secret/device-local settings
    /// keys must not have them land in the DB — export.rs's own dump() already excludes these when
    /// *building* a bundle, but import_bundle treats the bundle file as untrusted input (that's
    /// the whole point of the fail-closed validate_setting() check a few lines above this filter),
    /// so a bundle from somewhere else entirely could still carry them. Mirrors
    /// backup.rs::backup_restore's equivalent filter for the same trust boundary.
    #[test]
    fn import_skips_secret_and_device_local_setting_keys_even_if_the_bundle_carries_them() {
        use crate::repo::transfer::export::KvRow;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let version = migrations::current_version(&conn).unwrap();

        let mut bundle = bundle_with_dangling_internal(
            &conn.query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap(),
            version,
        );
        bundle.attachments.clear(); // keep this test focused on settings, not the dangling-attachment case
        bundle.settings = vec![
            KvRow { key: "ai_api_key".to_string(), value: "\"sk-leaked\"".to_string() },
            KvRow { key: "sync_token".to_string(), value: "\"leaked-token\"".to_string() },
            KvRow { key: "device_id".to_string(), value: "\"source-device\"".to_string() },
            KvRow { key: "sync_enabled".to_string(), value: "true".to_string() },
            KvRow { key: "sync_port".to_string(), value: "9999".to_string() },
            KvRow { key: "theme".to_string(), value: "\"dark\"".to_string() },
        ];

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false).unwrap();

        for blocked_key in ["ai_api_key", "sync_token", "device_id", "sync_enabled", "sync_port"] {
            // Some of these (device_id, sync_enabled, sync_port) always have a pre-existing
            // default row from migrations seeding — the point isn't "absent", it's "did not adopt
            // the bundle's malicious value", so compare values rather than presence.
            let value: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key=?1", [blocked_key], |r| r.get(0))
                .ok();
            let bundle_value = bundle.settings.iter().find(|kv| kv.key == blocked_key).map(|kv| kv.value.as_str());
            assert_ne!(value.as_deref(), bundle_value, "{blocked_key} must not adopt the bundle's value");
        }

        // merge 모드는 설정을 **아예** 가져오지 않는다 — 설정 복원 루프(super::insert_all)는
        // wipe 뒤의 replace 경로에만 있다. 남의 노트를 합치는 것이 내 테마를 갈아치우면 안 되므로
        // 이게 의도된 동작이다. 번들이 "dark" 를 실어 보내도 시드 기본값("system", E5-a)이 남는다.
        //
        // ⚠️ 그래서 위 차단 키 단언들도 이 모드에서는 공회전이다("가져온 적이 없으니 당연히 다름").
        // 필터 자체(is_secret_setting_key/is_device_local_setting_key)를 실제로 태우려면 replace
        // 모드가 필요한데, 이 픽스처(bundle_with_dangling_internal)는 wipe 후 폴더가 사라져 FK 가
        // 깨진다 — 자족적인 번들 픽스처를 새로 만들어야 한다. 후속 과제로 남긴다
        // (docs/PLAN-2026-09-02-settings-audit.md §1 A6-f). 필터의 다른 진입점인
        // backup.rs::backup_restore 쪽은 자체 테스트가 있다.
        // V86 이후 theme 은 노트북 키라 전역 행이 아니다 — 읽기 관문(get_all)으로 본다.
        let theme = crate::repo::settings::get_all(&conn).unwrap()["theme"].clone();
        assert_eq!(theme, serde_json::json!("system"), "merge 는 번들의 설정을 채택하지 않는다 (기본값 유지)");
    }

    #[test]
    fn merge_import_prunes_dangling_internal_attachment() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let version = migrations::current_version(&conn).unwrap();

        let bundle = bundle_with_dangling_internal(&folder_id, version);
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false).unwrap();
        assert_eq!(result.imported_notes, 2);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.backup_path, None); // 지우지 않는 모드는 스냅샷을 찍지 않는다

        let remaining: Vec<(String, String)> = conn
            .prepare("SELECT id, url FROM attachments WHERE kind='internal' ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec![("att-valid".to_string(), "noteB".to_string())]);
    }

    // 리그레션(P0): 스테이징 복사가 실패하면 DB/기존 attachments/ 는 손대지 않은 채 그대로여야
    // 한다 — 예전 순서(커밋 → 기존 attachments/ 삭제 → 복사)였다면 이 시나리오에서 커밋까지
    // 끝나고 기존 첨부 파일도 지워진 뒤에야 실패해 복구 불가능했다.
    #[test]
    fn replace_import_leaves_db_and_attachments_untouched_when_staging_copy_fails() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let version = migrations::current_version(&conn).unwrap();

        let existing_folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status)
             VALUES ('old-note', ?1, 'Old Note', 1999, 0, NULL, ?2, ?2, NULL, NULL)",
            params![existing_folder_id, now],
        )
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let data_att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&data_att).unwrap();
        std::fs::write(data_att.join("existing.txt"), b"keep me").unwrap();

        // 번들의 첨부 소스를 파일이 아닌 디렉토리로 만들어 copy_attachments 내부의
        // std::fs::copy 가 실패하도록 유도한다(src.exists() 는 true, 복사만 실패).
        let bundle = Bundle {
            version,
            workspaces: vec![WorkspaceRow {
                id: "ws1".to_string(),
                name: "Workspace".to_string(),
                created_at: now.clone(),
            }],
            folders: vec![FolderRow {
                id: "folder1".to_string(),
                workspace_id: "ws1".to_string(),
                name: "Notes".to_string(),
                position: 0,
                is_open: 1,
                created_at: now.clone(),
                color_hue: None,
                icon: None,
                rules: None,
                search_excluded: false,
                ai_excluded: false,
            }],
            notes: vec![NoteRow {
                id: "noteX".to_string(),
                folder_id: "folder1".to_string(),
                title: "Note X".to_string(),
                year: 2020,
                is_favorite: 0,
                exported_at: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                region: None,
                status: None,
                month: None,
                day: None,
                remind: 0,
                end_year: None,
                end_month: None,
                end_day: None,
                icon: None,
                lat: None,
                lng: None,
                start_time: None,
                end_time: None,
                remind_offset_min: None,
                rrule: None,
                archived_at: None,
            }],
            sections: vec![],
            sources: vec![],
            attachments: vec![AttachmentRow {
                id: "att-bad".to_string(),
                note_id: "noteX".to_string(),
                name: "bad".to_string(),
                kind: "file".to_string(),
                rel_path: Some("baddir".to_string()),
                url: None,
                size_bytes: None,
                position: 0,
                created_at: now,
            }],
            tags: vec![],
            note_tags: vec![],
            settings: vec![],
            workspace_regions: vec![],
            workspace_eras: vec![],
            workspace_statuses: vec![],
            note_regions: vec![],
            note_dates: vec![],
            note_related_exclusions: vec![],
            spaces: vec![],
            space_items: vec![],
            routine_completions: vec![],
            workspace_settings: Vec::new(),
            timeline_routines: Vec::new(),
        calendar_sources: vec![],
        calendar_marks: vec![],
        calendar_mark_hides: vec![],
        };

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let bundle_att_baddir = bundle_dir.path().join("attachments").join("baddir");
        std::fs::create_dir_all(&bundle_att_baddir).unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "replace", None, false);
        assert!(result.is_err(), "staging copy should fail on a directory source");

        // DB: 커밋 전에 실패했으므로 wipe/insert 는 전혀 반영되지 않아야 한다.
        let old_note_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id='old-note'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(old_note_count, 1);
        let new_note_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id='noteX'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new_note_count, 0);

        // 기존 attachments/ 파일은 그대로 남아있어야 한다.
        assert_eq!(
            std::fs::read(data_att.join("existing.txt")).unwrap(),
            b"keep me"
        );

        // 스테이징 디렉토리는 실패 경로에서 정리되어 잔여물이 남지 않아야 한다.
        let leftovers = std::fs::read_dir(data_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("attachments.incoming-") || n.starts_with("attachments.old-"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    // 리그레션: 첨부 위치 재정의로 attachments/ 가 data_dir 밖(다른 볼륨)에 있으면 스테이징·옛 첨부 자리도 그 **형제**여야
    // 한다 — data_dir 아래에 두면 rename 이 볼륨을 건너 실패하는데 그건 커밋 뒤라 DB 는 번들·첨부는 옛 파일인 채 남는다.
    // 볼륨 교차 자체는 테스트로 만들 수 없어 경로 생성 규칙을 검증한다(재정의가 없으면 부모 = data_dir 그대로).
    #[test]
    fn att_swap_paths_are_siblings_of_the_live_attachments_dir_not_of_data_dir() {
        let data_dir = Path::new("C:/data");
        let live_elsewhere = Path::new("D:/cloud/brise-attachments");
        let (staging, old) = att_swap_paths(data_dir, live_elsewhere);
        assert_eq!(staging.parent(), Some(Path::new("D:/cloud")));
        assert_eq!(old.parent(), Some(Path::new("D:/cloud")));
        assert!(staging.file_name().unwrap().to_string_lossy().starts_with("attachments.incoming-"));
        assert!(old.file_name().unwrap().to_string_lossy().starts_with("attachments.old-"));
        assert_ne!(staging, old);

        // 재정의가 없을 때(live = data_dir/attachments)는 예전과 같은 자리다.
        let live_default = data_dir.join("attachments");
        let (staging, old) = att_swap_paths(data_dir, &live_default);
        assert_eq!(staging.parent(), Some(data_dir));
        assert_eq!(old.parent(), Some(data_dir));
    }

    // 첨부 폴더가 data_dir 밖에 있어도 교체 가져오기가 번들 첨부를 그 폴더로 스왑하고, data_dir·첨부 부모에 잔여물을 안 남긴다.
    #[test]
    fn replace_import_swaps_attachments_that_live_outside_data_dir() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let version = migrations::current_version(&conn).unwrap();

        let mut bundle = bundle_with_dangling_internal("folder1", version);
        bundle.workspaces.push(WorkspaceRow { id: "ws1".to_string(), name: "Workspace".to_string(), created_at: now.clone() });
        bundle.folders.push(FolderRow {
            id: "folder1".to_string(),
            workspace_id: "ws1".to_string(),
            name: "Notes".to_string(),
            position: 0,
            is_open: 1,
            created_at: now.clone(),
            color_hue: None,
            icon: None,
            rules: None,
            search_excluded: false,
            ai_excluded: false,
        });
        bundle.attachments.push(AttachmentRow {
            id: "att-file".to_string(),
            note_id: "noteA".to_string(),
            name: "a.txt".to_string(),
            kind: "doc".to_string(),
            rel_path: Some("a.txt".to_string()),
            url: None,
            size_bytes: None,
            position: 5,
            created_at: now,
        });

        let bundle_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(bundle_dir.path().join("attachments")).unwrap();
        std::fs::write(bundle_dir.path().join("attachments").join("a.txt"), b"from bundle").unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        // 첨부는 data_dir 밖(예: 다른 드라이브의 클라우드 폴더)에 산다 — 부모(cloud)는 data_dir 의 부모가 아니다.
        let cloud = tempfile::tempdir().unwrap();
        let data_att = cloud.path().join("brise-attachments");
        std::fs::create_dir_all(&data_att).unwrap();
        std::fs::write(data_att.join("existing.txt"), b"old").unwrap();

        import_replace(&mut conn, data_dir.path(), &bundle, &bundle_dir.path().join("attachments"), &data_att).unwrap();

        assert_eq!(std::fs::read(data_att.join("a.txt")).unwrap(), b"from bundle");
        assert!(!data_att.join("existing.txt").exists(), "교체이므로 옛 첨부는 사라진다");
        // 스테이징·옛 폴더 잔여물이 어디에도 없다(data_dir 에도, 첨부 부모에도).
        for dir in [data_dir.path(), cloud.path()] {
            let strays: Vec<String> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with("attachments."))
                .collect();
            assert!(strays.is_empty(), "stray swap folders in {}: {strays:?}", dir.display());
        }
    }

    #[test]
    fn replace_import_prunes_dangling_internal_attachment() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let version = migrations::current_version(&conn).unwrap();

        // replace 는 wipe() 로 workspaces/folders 까지 지우므로 번들에 직접 포함시켜야 한다.
        let mut bundle = bundle_with_dangling_internal("folder1", version);
        bundle.workspaces.push(WorkspaceRow {
            id: "ws1".to_string(),
            name: "Workspace".to_string(),
            created_at: now.clone(),
        });
        bundle.folders.push(FolderRow {
            id: "folder1".to_string(),
            workspace_id: "ws1".to_string(),
            name: "Notes".to_string(),
            position: 0,
            is_open: 1,
            created_at: now,
            color_hue: None,
            icon: None,
            rules: None,
            search_excluded: false,
            ai_excluded: false,
        });
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        // 번들에는 비밀이 없다 — 교체 가져오기가 이 설치본의 AI 키·보관함을 지우면 안 된다.
        for (k, v) in [("ai_api_key", "\"sk-live\""), ("ai_provider_creds", "{\"gemini\":{\"api_key\":\"g\"}}")] {
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?1, ?2)", [k, v]).unwrap();
        }
        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "replace", None, false).unwrap();
        assert_eq!(result.imported_notes, 2);
        let kept: String = conn
            .query_row("SELECT value FROM settings WHERE key='ai_provider_creds'", [], |r| r.get(0))
            .unwrap();
        assert!(kept.contains("gemini"));
        let key: String = conn.query_row("SELECT value FROM settings WHERE key='ai_api_key'", [], |r| r.get(0)).unwrap();
        assert_eq!(key, "\"sk-live\"");
        // 지우기 전 안전 스냅샷 경로를 돌려준다 — 설정 창이 그 경로를 보여 준다.
        let backup = result.backup_path.as_deref().expect("replace 는 스냅샷 경로를 돌려준다");
        assert!(std::path::Path::new(backup).is_file());
        assert!(std::path::Path::new(backup).starts_with(crate::db::backups_dir(data_dir.path())));

        let remaining: Vec<(String, String)> = conn
            .prepare("SELECT id, url FROM attachments WHERE kind='internal' ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec![("att-valid".to_string(), "noteB".to_string())]);
    }

    /// V96 CASCADE 회귀 — 교체 가져오기가 번들에 돌아온 노트북의 수집 소스(+seen)는 지키고,
    /// 번들에 없는 노트북의 소스만 고아로 지운다.
    #[test]
    fn replace_import_keeps_collect_sources_of_notebooks_in_the_bundle() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let version = migrations::current_version(&conn).unwrap();
        conn.execute_batch(&format!(
            "DELETE FROM workspaces;
             INSERT INTO workspaces(id, name, created_at) VALUES ('ws1','W','{now}'), ('ws_gone','G','{now}');
             INSERT INTO collect_sources(id, workspace_id, kind, name, config, created_at, updated_at, post_process_model)
               VALUES ('src1','ws1','rss','A','{{}}','{now}','{now}','m1'),
                      ('src2','ws_gone','rss','B','{{}}','{now}','{now}',NULL);
             INSERT INTO collect_seen(source_id, guid) VALUES ('src1','g1'), ('src2','g2');"
        ))
        .unwrap();

        let mut bundle = bundle_with_dangling_internal("folder1", version);
        bundle.workspaces.push(WorkspaceRow { id: "ws1".to_string(), name: "W".to_string(), created_at: now.clone() });
        bundle.folders.push(FolderRow {
            id: "folder1".to_string(),
            workspace_id: "ws1".to_string(),
            name: "Notes".to_string(),
            position: 0,
            is_open: 1,
            created_at: now,
            color_hue: None,
            icon: None,
            rules: None,
            search_excluded: false,
            ai_excluded: false,
        });
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();
        import_bundle(&mut conn, data_dir.path(), &bundle_path, "replace", None, false).unwrap();

        let sources: Vec<(String, Option<String>)> = conn
            .prepare("SELECT id, post_process_model FROM collect_sources ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(sources, vec![("src1".to_string(), Some("m1".to_string()))]);
        let seen: Vec<String> = conn
            .prepare("SELECT source_id || ':' || guid FROM collect_seen ORDER BY 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(seen, vec!["src1:g1".to_string()]);
    }

    // --- Bundle version gate ---------------------------------------------------------------

    #[test]
    fn merge_import_rejects_bundle_newer_than_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let cur = migrations::current_version(&conn).unwrap();

        let bundle = bundle_with_dangling_internal(&folder_id, cur + 1);
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let err = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // Rejected before any row was touched — the bundle's notes never landed.
        let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(note_count, 0);
    }

    #[test]
    fn replace_import_rejects_bundle_newer_than_schema_leaves_db_untouched() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let cur = migrations::current_version(&conn).unwrap();

        let existing_folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, exported_at, created_at, updated_at, region, status)
             VALUES ('old-note', ?1, 'Old Note', 1999, 0, NULL, ?2, ?2, NULL, NULL)",
            params![existing_folder_id, now],
        )
        .unwrap();

        // replace wipes workspaces/folders too, so the bundle carries its own — but the version
        // gate must reject before wipe() ever runs, so none of that matters to the outcome.
        let mut bundle = bundle_with_dangling_internal("folder1", cur + 1);
        bundle.workspaces.push(WorkspaceRow {
            id: "ws1".to_string(),
            name: "Workspace".to_string(),
            created_at: now.clone(),
        });
        bundle.folders.push(FolderRow {
            id: "folder1".to_string(),
            workspace_id: "ws1".to_string(),
            name: "Notes".to_string(),
            position: 0,
            is_open: 1,
            created_at: now,
            color_hue: None,
            icon: None,
            rules: None,
            search_excluded: false,
            ai_excluded: false,
        });
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let err = import_bundle(&mut conn, data_dir.path(), &bundle_path, "replace", None, false).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));

        // wipe() never ran: the pre-existing note is still there and nothing from the bundle
        // landed (workspaces stays at its seeded count, not 1 = only "ws1").
        let old_note_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes WHERE id='old-note'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(old_note_count, 1);
        let ws1_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces WHERE id='ws1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ws1_count, 0);
    }

    #[test]
    fn merge_import_accepts_bundle_version_equal_to_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let cur = migrations::current_version(&conn).unwrap();

        let bundle = bundle_with_dangling_internal(&folder_id, cur);
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false).unwrap();
        assert_eq!(result.imported_notes, 2);
    }

    #[test]
    fn merge_import_accepts_bundle_version_older_than_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let cur = migrations::current_version(&conn).unwrap();
        assert!(cur > 1, "test needs schema headroom below current to exercise 'older'");

        let bundle = bundle_with_dangling_internal(&folder_id, cur - 1);
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false).unwrap();
        assert_eq!(result.imported_notes, 2);
    }

    // --- Tag name-merge on import (merge mode) ----------------------------------------------

    /// Merge-mode import must not create a second tag with the same name (COLLATE NOCASE, same
    /// rule as the tags.name UNIQUE constraint) under a different id — it should map the
    /// incoming tag id to the existing one and rewrite note_tags accordingly. A genuinely new
    /// name still inserts normally.
    #[test]
    fn merge_import_maps_same_name_tag_to_existing_id_and_inserts_new_names() {
        use crate::repo::transfer::export::{NoteTagRow, TagRow};

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = now_iso();
        let version = migrations::current_version(&conn).unwrap();

        // Pre-existing local tag, different case than what the bundle will carry.
        conn.execute(
            "INSERT INTO tags(id, name) VALUES ('tag-existing', 'History')",
            [],
        )
        .unwrap();

        let bundle = Bundle {
            version,
            workspaces: vec![],
            folders: vec![],
            notes: vec![NoteRow {
                id: "noteX".to_string(),
                folder_id: folder_id.clone(),
                title: "Note X".to_string(),
                year: 2020,
                is_favorite: 0,
                exported_at: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                region: None,
                status: None,
                month: None,
                day: None,
                remind: 0,
                end_year: None,
                end_month: None,
                end_day: None,
                icon: None,
                lat: None,
                lng: None,
                start_time: None,
                end_time: None,
                remind_offset_min: None,
                rrule: None,
                archived_at: None,
            }],
            sections: vec![],
            sources: vec![],
            attachments: vec![],
            // "history" collides case-insensitively with the existing "History"; "newtag" does not
            // exist locally yet and should be inserted as-is.
            tags: vec![
                TagRow { id: "tag-incoming".to_string(), name: "history".to_string() },
                TagRow { id: "tag-new".to_string(), name: "newtag".to_string() },
            ],
            note_tags: vec![
                NoteTagRow { note_id: "noteX".to_string(), tag_id: "tag-incoming".to_string() },
                NoteTagRow { note_id: "noteX".to_string(), tag_id: "tag-new".to_string() },
            ],
            settings: vec![],
            workspace_regions: vec![],
            workspace_eras: vec![],
            workspace_statuses: vec![],
            note_regions: vec![],
            note_dates: vec![],
            note_related_exclusions: vec![],
            spaces: vec![],
            space_items: vec![],
            routine_completions: vec![],
            workspace_settings: Vec::new(),
            timeline_routines: Vec::new(),
        calendar_sources: vec![],
        calendar_marks: vec![],
        calendar_mark_hides: vec![],
        };

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false).unwrap();
        assert_eq!(result.imported_notes, 1);

        // No duplicate "history"/"History" tag row was created — the incoming id never made it
        // into the tags table.
        let tag_count_named_history: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tags WHERE name = 'history' COLLATE NOCASE",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tag_count_named_history, 1);
        let incoming_id_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM tags WHERE id='tag-incoming'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(incoming_id_exists, 0);

        // The new name inserted normally, under its bundle id.
        let new_tag_name: String = conn
            .query_row("SELECT name FROM tags WHERE id='tag-new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(new_tag_name, "newtag");

        // note_tags for the colliding name resolved to the *existing* tag id, not the incoming one.
        let mut tag_ids: Vec<String> = conn
            .prepare("SELECT tag_id FROM note_tags WHERE note_id='noteX' ORDER BY tag_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        tag_ids.sort();
        assert_eq!(tag_ids, vec!["tag-existing".to_string(), "tag-new".to_string()]);
    }

    // ── QA8 3C: add_notebook / hash_merge ─────────────────────────────────────

    // ── 2026-09-07 오너 결정(notes.yaml::note_date_add): note_dates.label 제거,
    //    V85 부활(PLAN-2026-09-18-nl-dates.md D1)로 다시 보존됨 ──────────────────────────

    /// V74~V84 사이의 번들은 note_dates 행에 label 키가 있어도(예: 그보다 더 옛 V74 이전 번들을
    /// 재수출했거나 손상 등) `NoteDateRow`에 그 필드가 없어 serde 가 조용히 무시했다(그 시절엔
    /// "라벨이 사라진다"가 맞는 말이었다). V85로 `NoteDateRow`가 label을 다시 선언하면서 이제는
    /// **똑같은 모양의 번들이 label을 무시하지 않고 보존한다** — "사라진다"던 옛 단언은 더 이상
    /// 진실이 아니므로 뒤집는다. 손으로 "label" 키를 얹은 옛 모양(`date`/`end_date` 문자열) 번들
    /// JSON으로 실제 import_bundle 왕복까지 고정한다(구조체 단위 역직렬화가 아니라 파일→DB 전 경로).
    #[test]
    fn import_preserves_legacy_note_dates_label_field_from_old_bundles() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let version = migrations::current_version(&conn).unwrap();

        let mut bundle = bundle_with_dangling_internal(&folder_id, version);
        bundle.attachments.clear(); // this test is about note_dates, not the dangling-attachment case
        let mut value = serde_json::to_value(&bundle).unwrap();
        let now = now_iso();
        // Hand-crafted legacy shape (pre-V76 date/end_date strings) carrying a "label" key —
        // NoteDateRow now declares that field (V85), so it round-trips instead of being dropped.
        value["note_dates"] = serde_json::json!([{
            "id": "nd-legacy",
            "note_id": "noteA",
            "date": "2020-06-01",
            "end_date": null,
            "label": "옛 라벨",
            "remind": 0,
            "created_at": now,
        }]);

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("brise-bundle.json");
        std::fs::write(&bundle_path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false)
            .expect("import must not fail just because the bundle carries a legacy-shaped label field");
        assert_eq!(result.imported_notes, 2);

        // PLAN-2026-09-08-dates-rebuild.md W1: note_dates 이제 noteA 의 position=0 미러 행도
        // 갖는다 — position != 0 으로 이 관련 날짜만 골라 트리플에서 재조립한다.
        let (date, label): (String, Option<String>) = conn
            .query_row(
                "SELECT printf('%04d-%02d-%02d', year, month, day), label FROM note_dates WHERE note_id='noteA' AND position != 0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(date, "2020-06-01");
        assert_eq!(label.as_deref(), Some("옛 라벨"), "V85부터는 label이 더 이상 사라지지 않고 보존된다");
    }

    // ── archived_at (W7-f, V36) — 리그레션(데이터 손실 P0, 리뷰어 확인) ──────────────────

    /// bundle.rs::NoteRow 에 archived_at 필드 자체가 없던 구버전 번들(v36 이후~이 수정 이전)은
    /// notes JSON 객체에 "archived_at" 키가 아예 없다. `#[serde(default)]` 로 그런 행도 파싱
    /// 실패 없이 None(=미아카이브, 지금까지의 동작과 동일)으로 읽혀 정상 임포트돼야 한다 —
    /// label 필드의 옛 번들 호환 테스트(바로 위)와 같은 패턴으로, 구조체 단위가 아니라
    /// 파일→DB 전 경로까지 고정한다.
    #[test]
    fn import_accepts_old_format_bundle_without_archived_at_field_as_not_archived() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let folder_id: String = conn
            .query_row("SELECT id FROM folders LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let version = migrations::current_version(&conn).unwrap();

        let mut bundle = bundle_with_dangling_internal(&folder_id, version);
        bundle.attachments.clear(); // this test is about archived_at, not the dangling-attachment case
        let mut value = serde_json::to_value(&bundle).unwrap();
        // 구버전 번들 재현: 두 노트 JSON 객체에서 "archived_at" 키 자체를 지운다(값을 null 로
        // 두는 것과 다르다 — 필드 자체가 없던 시절을 재현해야 #[serde(default)] 경로를 태운다).
        for note in value["notes"].as_array_mut().unwrap() {
            note.as_object_mut().unwrap().remove("archived_at");
        }

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("brise-bundle.json");
        std::fs::write(&bundle_path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "merge", None, false)
            .expect("import must not fail just because the bundle predates the archived_at field");
        assert_eq!(result.imported_notes, 2);

        let (a_archived, b_archived): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT (SELECT archived_at FROM notes WHERE id='noteA'),
                        (SELECT archived_at FROM notes WHERE id='noteB')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(a_archived, None, "old bundle without the field must import as not archived");
        assert_eq!(b_archived, None, "old bundle without the field must import as not archived");
    }

    /// replace 임포트(전체 교체)는 wipe 뒤 insert_all -> insert_note 를 그대로 타므로 archived_at
    /// 도 다른 컬럼과 함께 보존돼야 한다.
    #[test]
    fn replace_import_preserves_archived_at() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let version = migrations::current_version(&conn).unwrap();

        let mut bundle = bundle_with_dangling_internal("folder1", version);
        bundle.attachments.clear();
        bundle.workspaces.push(WorkspaceRow {
            id: "ws1".to_string(),
            name: "Workspace".to_string(),
            created_at: now.clone(),
        });
        bundle.folders.push(FolderRow {
            id: "folder1".to_string(),
            workspace_id: "ws1".to_string(),
            name: "Notes".to_string(),
            position: 0,
            is_open: 1,
            created_at: now.clone(),
            color_hue: None,
            icon: None,
            rules: None,
            search_excluded: false,
            ai_excluded: false,
        });
        // noteA 는 아카이브 상태로, noteB 는 미아카이브 상태로 실어 보낸다(양쪽 다 검증).
        bundle.notes[0].archived_at = Some(now.clone());
        assert_eq!(bundle.notes[1].archived_at, None);

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = write_bundle(bundle_dir.path(), &bundle);
        let data_dir = tempfile::tempdir().unwrap();

        let result = import_bundle(&mut conn, data_dir.path(), &bundle_path, "replace", None, false).unwrap();
        assert_eq!(result.imported_notes, 2);

        let (a_archived, b_archived): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT (SELECT archived_at FROM notes WHERE id='noteA'),
                        (SELECT archived_at FROM notes WHERE id='noteB')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(a_archived, Some(now), "archived note must survive a replace import");
        assert_eq!(b_archived, None, "non-archived note must stay non-archived after a replace import");
    }
}
