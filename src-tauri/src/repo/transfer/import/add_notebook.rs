// repo::transfer::import::add_notebook — `add_notebook` 모드: remap_bundle_ids로 번들 전체
// (워크스페이스/폴더/노트/자식 엔터티) id를 새로 발급해 충돌 없이 새 노트북으로 추가한다.
// 태그만 예외 — 이름(COLLATE NOCASE) 기준으로 기존/신규를 병합한다(super::plan_tag_merge).
use crate::error::{db as dberr, io, AppError, AppResult};
use crate::repo::fts;
use crate::util::new_id;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::Path;

use super::super::bundle::{
    AttachmentRow, Bundle, CalendarMarkHideRow, FolderRow, NoteDateRow, NoteRegionRow, NoteRelatedExclusionRow, NoteRow,
    NoteTagRow, RoutineCompletionRow, SectionRow, SourceRow, SpaceItemRow, SpaceRow, TagRow,
    TimelineRoutineRow, WorkspaceEraRow, WorkspaceRegionRow, WorkspaceRow, WorkspaceSettingRow,
    WorkspaceStatusRow,
};
use super::ImportResult;

/// (ws_map, folder_map, note_map, section_map, rel_map) — remap_bundle_ids 가 만든 매핑 중 extras.rs(펫
/// 대화·수집 소스·노트 스냅샷, duplicate_notebook 전용)가 재사용하는 네 가지만 별도 타입 없이
/// 튜플로 넘긴다. section_map 은 2026-09-20 스냅샷 복제 추가로 새로 실어보낸다(note_snapshots.
/// payload 안 section_id 를 다시 쓰는 데 쓴다) — remap_bundle_ids 안에서 이미 섹션 remap 에
/// 쓰던 맵을 그대로 반환값에 얹을 뿐, 두 번째 맵을 새로 만들지 않는다.
type BundleIdMaps = (
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, String>,
);

/// 번들 한 벌에 대한 id 재발급 맵 묶음 — 표마다 하나씩 짝이 있다. `tag` 만 예외로 바깥에서 온다
/// (태그는 전역이라 새 id 를 발급하지 않고, super::plan_tag_merge 가 이름 기준으로 기존/신규를
/// 이미 정해 넘겨준다).
struct IdMaps<'a> {
    ws: HashMap<String, String>,
    folder: HashMap<String, String>,
    note: HashMap<String, String>,
    section: HashMap<String, String>,
    source: HashMap<String, String>,
    att: HashMap<String, String>,
    region: HashMap<String, String>, // workspace_regions
    era: HashMap<String, String>,
    status: HashMap<String, String>,
    note_region: HashMap<String, String>,
    note_date: HashMap<String, String>,
    space: HashMap<String, String>,
    space_item: HashMap<String, String>,
    cal_source: HashMap<String, String>,
    /// 옛 rel_path → 새 rel_path. 아래 attachments 매핑이 쓰는 것과 **같은 함수**로 만든다 — 본문이
    /// 가리키는 경로와 첨부 행이 실제로 옮겨 간 경로가 어긋날 수 없게(super::rewrite_attachment_rel_paths).
    rel: HashMap<String, String>,
    tag: &'a HashMap<String, String>,
}

impl<'a> IdMaps<'a> {
    fn build(bundle: &Bundle, tag_id_map: &'a HashMap<String, String>) -> Self {
        let note = fresh_ids(&bundle.notes, |n| n.id.as_str());
        let mut rel: HashMap<String, String> = HashMap::new();
        for a in &bundle.attachments {
            let Some(old_rel) = a.rel_path.as_deref() else { continue };
            let new_note_id = map_or(&note, &a.note_id);
            let new_rel = super::remap_attachment_rel_path(old_rel, &a.note_id, &new_note_id);
            if new_rel != old_rel {
                rel.insert(old_rel.to_string(), new_rel);
            }
        }
        Self {
            ws: fresh_ids(&bundle.workspaces, |w| w.id.as_str()),
            folder: fresh_ids(&bundle.folders, |f| f.id.as_str()),
            note,
            section: fresh_ids(&bundle.sections, |s| s.id.as_str()),
            source: fresh_ids(&bundle.sources, |s| s.id.as_str()),
            att: fresh_ids(&bundle.attachments, |a| a.id.as_str()),
            region: fresh_ids(&bundle.workspace_regions, |r| r.id.as_str()),
            era: fresh_ids(&bundle.workspace_eras, |e| e.id.as_str()),
            status: fresh_ids(&bundle.workspace_statuses, |s| s.id.as_str()),
            note_region: fresh_ids(&bundle.note_regions, |r| r.id.as_str()),
            note_date: fresh_ids(&bundle.note_dates, |d| d.id.as_str()),
            space: fresh_ids(&bundle.spaces, |s| s.id.as_str()),
            space_item: fresh_ids(&bundle.space_items, |i| i.id.as_str()),
            cal_source: fresh_ids(&bundle.calendar_sources, |c| c.id.as_str()),
            rel,
            tag: tag_id_map,
        }
    }
}

/// 표 하나의 행 id 를 전부 새로 발급한다(옛 id → 새 id). 같은 id 가 두 번 나오면 마지막 것이
/// 남는다 — 원래의 `for … { map.insert(…) }` 와 같은 규칙.
fn fresh_ids<T>(rows: &[T], id_of: impl Fn(&T) -> &str) -> HashMap<String, String> {
    rows.iter().map(|r| (id_of(r).to_string(), new_id())).collect()
}

/// 맵에 없으면 원래 id 를 그대로 둔다 — 번들 밖을 가리키는 참조(부분 번들의 internal 링크 등)를
/// 임의로 바꾸지 않기 위한 폴백.
fn map_or(m: &HashMap<String, String>, id: &str) -> String {
    m.get(id).cloned().unwrap_or_else(|| id.to_string())
}

/// Build a full id-remap of every entity in the bundle so it can land without colliding with
/// any existing row. Tags are the one exception: they stay global and merge by name (COLLATE
/// NOCASE) so UNIQUE(tags.name) never fires and vocabulary doesn't fork. Status fields that
/// reference workspace_statuses.id are rewritten through the status map; wiki-links (`note://id`)
/// and internal attachments follow the note map.
///
/// Bundle 과 함께 (ws_map, folder_map, note_map, section_map) 도 돌려준다 — duplicate_notebook 이
/// 펫 대화·수집 소스·노트 스냅샷(extras.rs)을 **같은 id 매핑**으로 다시 써서 같은 트랜잭션에
/// 넣어야 하기 때문(import_add_notebook_with_extras). 일반 import_bundle(add_notebook 모드) 경로는
/// 이 매핑을 그냥 버린다(extras 가 항상 비어 있으므로 쓸 데가 없다).
fn remap_bundle_ids(bundle: &Bundle, tag_id_map: &HashMap<String, String>) -> (Bundle, BundleIdMaps) {
    // Bundle 을 `..` 없이 전부 구조분해한다 — 번들에 표가 새로 붙으면 이 패턴에서 **컴파일이
    // 깨져** 리맵 방침을 정하게 만든다. 최근 3주에만 다섯 번 났던 "번들엔 실렸는데 remap 이
    // 빠졌다" 류 누락(notes.archived_at 등)을 컴파일 타임으로 끌어올린 것이다.
    let Bundle {
        version,
        workspaces,
        folders,
        notes,
        sections,
        sources,
        attachments,
        tags,
        note_tags,
        // Device-wide settings never ride along on a notebook add — 아래 출력은 항상 빈 Vec.
        settings: _,
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
    } = bundle;

    let maps = IdMaps::build(bundle, tag_id_map);

    let out = Bundle {
        version: *version,
        workspaces: remap_workspaces(workspaces, &maps),
        folders: remap_folders(folders, &maps),
        notes: remap_notes(notes, &maps),
        sections: remap_sections(sections, &maps),
        sources: remap_sources(sources, &maps),
        attachments: remap_attachments(attachments, &maps),
        tags: remap_tags(tags, &maps),
        note_tags: remap_note_tags(note_tags, &maps),
        // Device-wide settings never ride along on a notebook add.
        settings: Vec::new(),
        workspace_regions: remap_workspace_regions(workspace_regions, &maps),
        workspace_eras: remap_workspace_eras(workspace_eras, &maps),
        workspace_statuses: remap_workspace_statuses(workspace_statuses, &maps),
        note_regions: remap_note_regions(note_regions, &maps),
        note_related_exclusions: remap_note_related_exclusions(note_related_exclusions, &maps),
        spaces: remap_spaces(spaces, &maps),
        space_items: remap_space_items(space_items, &maps),
        routine_completions: remap_routine_completions(routine_completions, &maps),
        note_dates: remap_note_dates(note_dates, &maps),
        workspace_settings: remap_workspace_settings(workspace_settings, &maps),
        timeline_routines: remap_timeline_routines(timeline_routines, &maps),
        calendar_sources: remap_calendar_sources(calendar_sources, &maps),
        calendar_marks: remap_calendar_marks(calendar_marks, &maps),
        calendar_mark_hides: remap_calendar_mark_hides(calendar_mark_hides, &maps),
    };

    let IdMaps { ws, folder, note, section, rel, .. } = maps;
    (out, (ws, folder, note, section, rel))
}

fn remap_workspaces(rows: &[WorkspaceRow], maps: &IdMaps) -> Vec<WorkspaceRow> {
    rows.iter()
        .map(|ws| WorkspaceRow {
            id: map_or(&maps.ws, &ws.id),
            name: ws.name.clone(),
            created_at: ws.created_at.clone(),
        })
        .collect()
}

fn remap_folders(rows: &[FolderRow], maps: &IdMaps) -> Vec<FolderRow> {
    rows.iter()
        .map(|f| FolderRow {
            id: map_or(&maps.folder, &f.id),
            workspace_id: map_or(&maps.ws, &f.workspace_id),
            name: f.name.clone(),
            position: f.position,
            is_open: f.is_open,
            created_at: f.created_at.clone(),
            color_hue: f.color_hue,
            icon: f.icon.clone(),
            rules: f.rules.clone(),
            search_excluded: f.search_excluded,
            ai_excluded: f.ai_excluded,
        })
        .collect()
}

fn remap_notes(rows: &[NoteRow], maps: &IdMaps) -> Vec<NoteRow> {
    rows.iter()
        .map(|n| {
            // Builtin keys ("in_progress"/"exported"/"done") stay; custom status ids remap.
            let status = n.status.as_ref().map(|s| map_or(&maps.status, s));
            NoteRow {
                id: map_or(&maps.note, &n.id),
                folder_id: map_or(&maps.folder, &n.folder_id),
                title: n.title.clone(),
                year: n.year,
                is_favorite: n.is_favorite,
                exported_at: n.exported_at.clone(),
                created_at: n.created_at.clone(),
                updated_at: n.updated_at.clone(),
                region: n.region.clone(),
                status,
                month: n.month,
                day: n.day,
                remind: n.remind,
                end_year: n.end_year,
                end_month: n.end_month,
                end_day: n.end_day,
                icon: n.icon.clone(),
                lat: n.lat,
                lng: n.lng,
                start_time: n.start_time.clone(),
                end_time: n.end_time.clone(),
                remind_offset_min: n.remind_offset_min,
                rrule: n.rrule.clone(),
                // 순수 타임스탬프 — 다른 시각 컬럼(created_at/updated_at)과 같은 이유로 remap 없이
                // 그대로 옮긴다(bundle.rs NoteRow archived_at 주석).
                archived_at: n.archived_at.clone(),
            }
        })
        .collect()
}

fn remap_sections(rows: &[SectionRow], maps: &IdMaps) -> Vec<SectionRow> {
    rows.iter()
        .map(|s| {
            // Rewrite wiki-links `note://<old>` so in-body references keep working after remap.
            let body = super::rewrite_note_links(&s.body_md, &maps.note);
            // …and inline images, which spell out the attachment's rel_path verbatim.
            let body = super::rewrite_attachment_rel_paths(&body, &maps.rel);
            SectionRow {
                id: map_or(&maps.section, &s.id),
                note_id: map_or(&maps.note, &s.note_id),
                name: s.name.clone(),
                body_md: body,
                position: s.position,
            }
        })
        .collect()
}

fn remap_sources(rows: &[SourceRow], maps: &IdMaps) -> Vec<SourceRow> {
    rows.iter()
        .map(|s| SourceRow {
            id: map_or(&maps.source, &s.id),
            note_id: map_or(&maps.note, &s.note_id),
            name: s.name.clone(),
            ext: s.ext.clone(),
            body: s.body.clone(),
            position: s.position,
            created_at: s.created_at.clone(),
        })
        .collect()
}

fn remap_attachments(rows: &[AttachmentRow], maps: &IdMaps) -> Vec<AttachmentRow> {
    rows.iter()
        .map(|a| {
            let url = match a.kind.as_str() {
                "internal" => a.url.as_ref().map(|u| map_or(&maps.note, u)),
                // 차트 참조는 섹션 id 를 안고 있다 — 섹션이 새 id 를 받았으니 같이 옮긴다.
                "chart" => a.url.as_ref().map(|u| super::remap_chart_url(u, &maps.section)),
                _ => a.url.clone(),
            };
            let new_note_id = map_or(&maps.note, &a.note_id);
            // rel_path 도 note_id 와 같은 remap 을 거쳐야 한다 — 안 그러면 DB 행은 새 note_id 를
            // 가리키는데 파일은 옛 note_id 디렉토리 이름으로 저장돼, 재시작 시 orphan_cleanup 이
            // 그 디렉토리를 고아로 보고 지운다(버그 리포트 참조).
            let rel_path = a
                .rel_path
                .as_ref()
                .map(|rp| super::remap_attachment_rel_path(rp, &a.note_id, &new_note_id));
            AttachmentRow {
                id: map_or(&maps.att, &a.id),
                note_id: new_note_id,
                name: a.name.clone(),
                kind: a.kind.clone(),
                rel_path,
                url,
                size_bytes: a.size_bytes,
                position: a.position,
                created_at: a.created_at.clone(),
            }
        })
        .collect()
}

/// Tags: keep mapped ids from the name-merge pass (already resolved to existing-or-new).
fn remap_tags(rows: &[TagRow], maps: &IdMaps) -> Vec<TagRow> {
    rows.iter()
        .filter_map(|t| {
            let new_id = maps.tag.get(&t.id)?;
            // Only emit one TagRow per distinct resolved id (two bundle tags may collapse).
            Some(TagRow {
                id: new_id.clone(),
                name: t.name.clone(),
            })
        })
        .collect()
}

fn remap_note_tags(rows: &[NoteTagRow], maps: &IdMaps) -> Vec<NoteTagRow> {
    rows.iter()
        .map(|nt| NoteTagRow {
            note_id: map_or(&maps.note, &nt.note_id),
            tag_id: map_or(maps.tag, &nt.tag_id),
        })
        .collect()
}

fn remap_workspace_regions(rows: &[WorkspaceRegionRow], maps: &IdMaps) -> Vec<WorkspaceRegionRow> {
    rows.iter()
        .map(|r| WorkspaceRegionRow {
            id: map_or(&maps.region, &r.id),
            workspace_id: map_or(&maps.ws, &r.workspace_id),
            name: r.name.clone(),
            position: r.position,
            created_at: r.created_at.clone(),
        })
        .collect()
}

fn remap_workspace_eras(rows: &[WorkspaceEraRow], maps: &IdMaps) -> Vec<WorkspaceEraRow> {
    rows.iter()
        .map(|e| WorkspaceEraRow {
            id: map_or(&maps.era, &e.id),
            workspace_id: map_or(&maps.ws, &e.workspace_id),
            name: e.name.clone(),
            from_year: e.from_year,
            to_year: e.to_year,
            position: e.position,
            created_at: e.created_at.clone(),
        })
        .collect()
}

fn remap_workspace_statuses(rows: &[WorkspaceStatusRow], maps: &IdMaps) -> Vec<WorkspaceStatusRow> {
    rows.iter()
        .map(|s| WorkspaceStatusRow {
            id: map_or(&maps.status, &s.id),
            workspace_id: map_or(&maps.ws, &s.workspace_id),
            name: s.name.clone(),
            position: s.position,
            created_at: s.created_at.clone(),
        })
        .collect()
}

fn remap_note_regions(rows: &[NoteRegionRow], maps: &IdMaps) -> Vec<NoteRegionRow> {
    rows.iter()
        .map(|r| NoteRegionRow {
            id: map_or(&maps.note_region, &r.id),
            note_id: map_or(&maps.note, &r.note_id),
            name: r.name.clone(),
            lat: r.lat,
            lng: r.lng,
            position: r.position,
            created_at: r.created_at.clone(),
        })
        .collect()
}

fn remap_note_dates(rows: &[NoteDateRow], maps: &IdMaps) -> Vec<NoteDateRow> {
    rows.iter()
        .map(|d| NoteDateRow {
            id: map_or(&maps.note_date, &d.id),
            note_id: map_or(&maps.note, &d.note_id),
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
        })
        .collect()
}

fn remap_note_related_exclusions(
    rows: &[NoteRelatedExclusionRow],
    maps: &IdMaps,
) -> Vec<NoteRelatedExclusionRow> {
    rows.iter()
        .map(|x| NoteRelatedExclusionRow {
            id_1: map_or(&maps.note, &x.id_1),
            id_2: map_or(&maps.note, &x.id_2),
            created_at: x.created_at.clone(),
        })
        .collect()
}

fn remap_spaces(rows: &[SpaceRow], maps: &IdMaps) -> Vec<SpaceRow> {
    rows.iter()
        .map(|s| SpaceRow {
            id: map_or(&maps.space, &s.id),
            workspace_id: map_or(&maps.ws, &s.workspace_id),
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
        })
        .collect()
}

fn remap_space_items(rows: &[SpaceItemRow], maps: &IdMaps) -> Vec<SpaceItemRow> {
    rows.iter()
        .map(|i| {
            let source_id = super::remap_space_item_source_id(
                &i.kind,
                i.source_id.clone(),
                &maps.note,
                &maps.space,
            );
            SpaceItemRow {
                id: map_or(&maps.space_item, &i.id),
                space_id: map_or(&maps.space, &i.space_id),
                kind: i.kind.clone(),
                source_id,
                content: i.content.clone(),
                x: i.x,
                y: i.y,
                width: i.width,
                height: i.height,
                z_index: i.z_index,
                display_mode: i.display_mode.clone(),
                style: i.style.clone(),
                locked: i.locked,
                created_at: i.created_at.clone(),
                updated_at: i.updated_at.clone(),
            }
        })
        .collect()
}

fn remap_routine_completions(rows: &[RoutineCompletionRow], maps: &IdMaps) -> Vec<RoutineCompletionRow> {
    rows.iter()
        .map(|rc| RoutineCompletionRow {
            note_id: map_or(&maps.note, &rc.note_id),
            occur_on: rc.occur_on.clone(),
            done_at: rc.done_at.clone(),
        })
        .collect()
}

/// PLAN-2026-09-19-notebook-settings §5: 설정·반복 일정은 새 노트북 id 를 따라간다.
fn remap_workspace_settings(rows: &[WorkspaceSettingRow], maps: &IdMaps) -> Vec<WorkspaceSettingRow> {
    rows.iter()
        .map(|r| WorkspaceSettingRow {
            workspace_id: map_or(&maps.ws, &r.workspace_id),
            key: r.key.clone(),
            value: r.value.clone(),
        })
        .collect()
}

fn remap_timeline_routines(rows: &[TimelineRoutineRow], maps: &IdMaps) -> Vec<TimelineRoutineRow> {
    rows.iter()
        .map(|r| TimelineRoutineRow {
            id: new_id(),
            workspace_id: map_or(&maps.ws, &r.workspace_id),
            ..r.clone()
        })
        .collect()
}

// 달력 표시일: 노트북·출처·표시일 id 를 새로 매긴다. 숨김의 source 는 'builtin' 이거나 출처 id 다.
fn remap_calendar_sources(
    rows: &[crate::models::CalendarSource],
    maps: &IdMaps,
) -> Vec<crate::models::CalendarSource> {
    rows.iter()
        .map(|cs| crate::models::CalendarSource {
            id: map_or(&maps.cal_source, &cs.id),
            workspace_id: map_or(&maps.ws, &cs.workspace_id),
            ..cs.clone()
        })
        .collect()
}

fn remap_calendar_marks(
    rows: &[crate::models::CalendarMark],
    maps: &IdMaps,
) -> Vec<crate::models::CalendarMark> {
    rows.iter()
        .map(|m| crate::models::CalendarMark {
            id: new_id(),
            workspace_id: map_or(&maps.ws, &m.workspace_id),
            source_id: m.source_id.as_ref().map(|s| map_or(&maps.cal_source, s)),
            ..m.clone()
        })
        .collect()
}

fn remap_calendar_mark_hides(rows: &[CalendarMarkHideRow], maps: &IdMaps) -> Vec<CalendarMarkHideRow> {
    rows.iter()
        .map(|h| CalendarMarkHideRow {
            workspace_id: map_or(&maps.ws, &h.workspace_id),
            source: map_or(&maps.cal_source, &h.source),
            iso_day: h.iso_day.clone(),
        })
        .collect()
}

pub(super) fn import_add_notebook(
    conn: &mut Connection,
    data_dir: &Path,
    bundle: &Bundle,
    bundle_att: &Path,
    data_att: &Path,
) -> AppResult<ImportResult> {
    // 파일에서 가져오는 일반 add_notebook 경로 — Bundle 은 펫 대화/수집 소스를 절대 담지 않으므로
    // (오너 스코프 결정, extras.rs 헤더) 항상 빈 extras 로 부른다(no-op: remap/insert 둘 다 빈 배열).
    let (_new_ws_id, result) =
        import_add_notebook_with_extras(conn, data_dir, bundle, bundle_att, data_att, &super::extras::NotebookExtras::default())?;
    Ok(result)
}

/// duplicate_notebook 전용 확장 — import_add_notebook 과 완전히 같은 id 재매핑·삽입 경로를 타되,
/// 마지막에 펫 대화·수집 소스(extras)를 **같은 트랜잭션** 안에서 함께 넣고 새 노트북 id 를 직접
/// 반환한다(호출자가 rowid 로 "방금 만든 노트북"을 다시 찾는 불안정한 수법을 쓰지 않아도 된다 —
/// remap_bundle_ids 가 이미 정확한 새 workspace id 를 알고 있다).
pub(super) fn import_add_notebook_with_extras(
    conn: &mut Connection,
    _data_dir: &Path,
    bundle: &Bundle,
    bundle_att: &Path,
    data_att: &Path,
    extras: &super::extras::NotebookExtras,
) -> AppResult<(String, ImportResult)> {
    if bundle.workspaces.is_empty() {
        return Err(AppError::Validation(
            "bundle has no notebooks (workspaces) to add".into(),
        ));
    }

    let remapped;
    let new_ws_id: String;
    let imported_note_ids: Vec<String>;
    {
        let tx = conn.transaction().map_err(dberr)?;
        let tag_id_map = super::plan_tag_merge(&tx, &bundle.tags)?;
        let (r, (ws_map, folder_map, note_map, section_map, rel_map)) = remap_bundle_ids(bundle, &tag_id_map);
        remapped = r;
        // remap_bundle_ids 는 bundle.workspaces 를 1:1(필터 없이) 매핑하므로, 위에서 이미 확인한
        // "bundle.workspaces 가 비어있지 않음"이 여기서도 그대로 성립한다.
        new_ws_id = remapped.workspaces[0].id.clone();
        super::insert_tags_from_map(&tx, &bundle.tags, &tag_id_map)?;

        // Insert notebook structure without settings (remapped.settings is empty).
        for ws in &remapped.workspaces {
            tx.execute(
                "INSERT INTO workspaces(id, name, created_at) VALUES (?1,?2,?3)",
                params![ws.id, ws.name, ws.created_at],
            )
            .map_err(dberr)?;
        }
        for r in &remapped.workspace_regions {
            tx.execute(
                "INSERT INTO workspace_regions(id, workspace_id, name, position, created_at)
                 VALUES (?1,?2,?3,?4,?5)",
                params![r.id, r.workspace_id, r.name, r.position, r.created_at],
            )
            .map_err(dberr)?;
        }
        for e in &remapped.workspace_eras {
            tx.execute(
                "INSERT INTO workspace_eras(id, workspace_id, name, from_year, to_year, position, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![e.id, e.workspace_id, e.name, e.from_year, e.to_year, e.position, e.created_at],
            )
            .map_err(dberr)?;
        }
        // 이전 번들(workspace_settings 없음)은 원본 번들의 전역 settings 에 실린 노트북 키를 쓴다 —
        // remapped.settings 는 비워 두므로 원본에서 읽는다.
        let new_ws_ids: Vec<String> = remapped.workspaces.iter().map(|w| w.id.clone()).collect();
        super::insert_notebook_settings(&tx, &remapped.workspace_settings, &bundle.settings, &new_ws_ids)?;
        for r in &remapped.timeline_routines {
            super::insert_timeline_routine(&tx, r)?;
        }
        super::insert_calendar(
            &tx,
            &remapped.calendar_sources,
            &remapped.calendar_marks,
            &remapped.calendar_mark_hides,
            &new_ws_ids,
        )?;
        for s in &remapped.workspace_statuses {
            tx.execute(
                "INSERT INTO workspace_statuses(id, workspace_id, name, position, created_at)
                 VALUES (?1,?2,?3,?4,?5)",
                params![s.id, s.workspace_id, s.name, s.position, s.created_at],
            )
            .map_err(dberr)?;
        }
        for f in &remapped.folders {
            tx.execute(
                "INSERT INTO folders(id, workspace_id, name, position, is_open, created_at, color_hue, icon, rules, search_excluded, ai_excluded)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![f.id, f.workspace_id, f.name, f.position, f.is_open, f.created_at, f.color_hue, f.icon, f.rules, f.search_excluded, f.ai_excluded],
            )
            .map_err(dberr)?;
        }
        for n in &remapped.notes {
            super::insert_note(&tx, n)?;
            for s in remapped.sections.iter().filter(|s| s.note_id == n.id) {
                super::insert_section(&tx, s)?;
            }
            for s in remapped.sources.iter().filter(|s| s.note_id == n.id) {
                super::insert_source(&tx, s)?;
            }
            for a in remapped.attachments.iter().filter(|a| a.note_id == n.id) {
                super::insert_attachment(&tx, a)?;
            }
            for r in remapped.note_regions.iter().filter(|r| r.note_id == n.id) {
                super::insert_note_region(&tx, r)?;
            }
            for d in remapped.note_dates.iter().filter(|d| d.note_id == n.id) {
                super::insert_note_date(&tx, d)?;
            }
            for nt in remapped.note_tags.iter().filter(|nt| nt.note_id == n.id) {
                tx.execute(
                    "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1,?2)",
                    params![nt.note_id, nt.tag_id],
                )
                .map_err(dberr)?;
            }
            for rc in remapped.routine_completions.iter().filter(|rc| rc.note_id == n.id) {
                super::insert_routine_completion(&tx, rc)?;
            }
            fts::fts_upsert(&tx, &n.id)?;
        }
        for x in &remapped.note_related_exclusions {
            super::insert_note_related_exclusion(&tx, x)?;
        }
        for s in &remapped.spaces {
            super::insert_space(&tx, s)?;
            tx.execute(
                "UPDATE workspaces SET space_bootstrapped = 1 WHERE id = ?1",
                [&s.workspace_id],
            )
            .map_err(dberr)?;
        }
        for i in &remapped.space_items {
            super::insert_space_item(&tx, i)?;
        }

        // 펫 대화·수집 소스·노트 스냅샷(extras) — add_notebook 이 방금 만든 것과 같은 id 매핑
        // (ws_map/folder_map/note_map/section_map)으로 다시 써서 **같은 트랜잭션** 안에서 넣는다.
        // 일반 import_bundle 경로에서는 extras 가 항상 빈 NotebookExtras 이므로 이 두 호출은 no-op.
        let remapped_extras = super::extras::remap_notebook_extras(extras, &ws_map, &folder_map, &note_map, &section_map, &rel_map);
        super::extras::insert_notebook_extras(&tx, &remapped_extras)?;

        super::prune_dangling_internal(&tx)?;
        imported_note_ids = remapped.notes.iter().map(|n| n.id.clone()).collect();
        tx.commit().map_err(dberr)?;
    }

    // 소스 경로(번들 안, 옛 note_id)와 대상 경로(DB 에 쓰인 remapped.attachments 의 rel_path, 새
    // note_id)가 remap 이후 갈라지므로 쌍으로 뽑는다. bundle.attachments 와 remapped.attachments
    // 는 remap_bundle_ids 가 filter 없이 1:1 map 으로 만들어 순서·개수가 항상 같다.
    let copy_pairs: Vec<(String, String)> = bundle
        .attachments
        .iter()
        .zip(remapped.attachments.iter())
        .filter(|(_, new_a)| imported_note_ids.contains(&new_a.note_id))
        .filter_map(|(orig, new_a)| Some((orig.rel_path.clone()?, new_a.rel_path.clone()?)))
        .collect();
    std::fs::create_dir_all(data_att).map_err(io)?;
    super::copy_attachments_remapped(&copy_pairs, bundle_att, data_att)?;
    let space_map: HashMap<String, String> = bundle
        .spaces
        .iter()
        .zip(remapped.spaces.iter())
        .map(|(o, n)| (o.id.clone(), n.id.clone()))
        .collect();
    super::copy_space_images_remapped(&bundle.space_items, &space_map, bundle_att, data_att)?;

    Ok((
        new_ws_id,
        ImportResult {
            imported_notes: imported_note_ids.len() as i64,
            skipped: 0,
            backup_path: None,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::import_bundle;
    use super::super::test_support::seed_notebook_bundle_source;
    use crate::db::{self, migrations};
    use std::path::Path;

    /// 참조무결성: 리맵되는 **모든 표**에 행을 한 개 이상 채운 번들을 remap 한 뒤 (a) 새로
    /// 발급되는 행 id 가 전부 원본과 다르고 (b) 모든 FK 가 **새 번들 안의 행**을 가리키는지 못
    /// 박는다. 표가 새로 붙었는데 remap 이 빠지는 누락은 remap_bundle_ids 의 Bundle 구조분해가
    /// 컴파일 타임에 잡지만, FK 를 옛 id 로 남겨두는 종류의 누락은 컴파일이 못 잡는다 — 그쪽이
    /// 이 테스트의 몫이다. 태그만 예외로 새 id 를 발급하지 않는다(이름 병합 맵이 정한 id 를
    /// 그대로 쓴다). settings 는 remap 대상이 아니라 통째로 버려지는 표다.
    #[test]
    fn remap_bundle_ids_rewires_every_table_and_every_fk() {
        use crate::models::{CalendarMark, CalendarSource};
        use crate::repo::transfer::bundle::KvRow;
        use crate::util::now_iso;

        // 원본 id 는 서로의 접두사가 되지 않게 고른다 — 본문 치환(note://, rel_path)이 문자열
        // 단위라 "note-a"/"note-a-2" 같은 쌍이면 테스트가 진짜 결함을 가릴 수 있다.
        const OLD_IDS: &[&str] = &[
            "ws-1", "fo-1", "note-a", "note-b", "sec-1", "src-1", "att-img", "att-chart",
            "att-int", "reg-1", "era-1", "sta-1", "nreg-1", "ndate-1", "spc-1", "sitem-note",
            "sitem-img", "troutine-1", "csrc-1", "cmark-1",
        ];

        let now = now_iso();
        let note_row = |id: &str, status: Option<&str>| NoteRow {
            id: id.to_string(),
            folder_id: "fo-1".to_string(),
            title: id.to_string(),
            year: 2000,
            is_favorite: 0,
            exported_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            region: None,
            status: status.map(str::to_string),
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
        };
        let bundle = Bundle {
            version: 9,
            workspaces: vec![WorkspaceRow {
                id: "ws-1".to_string(),
                name: "Notebook".to_string(),
                created_at: now.clone(),
            }],
            folders: vec![FolderRow {
                id: "fo-1".to_string(),
                workspace_id: "ws-1".to_string(),
                name: "Folder".to_string(),
                position: 0,
                is_open: 1,
                created_at: now.clone(),
                color_hue: None,
                icon: None,
                rules: None,
                search_excluded: false,
                ai_excluded: false,
            }],
            // note-a 는 커스텀 상태(리맵 대상), note-b 는 빌트인 키(그대로).
            notes: vec![note_row("note-a", Some("sta-1")), note_row("note-b", Some("done"))],
            sections: vec![SectionRow {
                id: "sec-1".to_string(),
                note_id: "note-a".to_string(),
                name: "Body".to_string(),
                body_md: "note://note-a 와 ![i](note-a/img.png)".to_string(),
                position: 0,
            }],
            sources: vec![SourceRow {
                id: "src-1".to_string(),
                note_id: "note-a".to_string(),
                name: "src".to_string(),
                ext: "txt".to_string(),
                body: "b".to_string(),
                position: 0,
                created_at: now.clone(),
            }],
            attachments: vec![
                AttachmentRow {
                    id: "att-img".to_string(),
                    note_id: "note-a".to_string(),
                    name: "img.png".to_string(),
                    kind: "image".to_string(),
                    rel_path: Some("note-a/img.png".to_string()),
                    url: None,
                    size_bytes: None,
                    position: 0,
                    created_at: now.clone(),
                },
                AttachmentRow {
                    id: "att-chart".to_string(),
                    note_id: "note-a".to_string(),
                    name: "chart".to_string(),
                    kind: "chart".to_string(),
                    rel_path: None,
                    url: Some("sec-1#c1".to_string()),
                    size_bytes: None,
                    position: 1,
                    created_at: now.clone(),
                },
                AttachmentRow {
                    id: "att-int".to_string(),
                    note_id: "note-a".to_string(),
                    name: "link".to_string(),
                    kind: "internal".to_string(),
                    rel_path: None,
                    url: Some("note-b".to_string()),
                    size_bytes: None,
                    position: 2,
                    created_at: now.clone(),
                },
            ],
            tags: vec![TagRow {
                id: "tag-1".to_string(),
                name: "t".to_string(),
            }],
            note_tags: vec![NoteTagRow {
                note_id: "note-a".to_string(),
                tag_id: "tag-1".to_string(),
            }],
            settings: vec![KvRow {
                key: "ui.theme".to_string(),
                value: "dark".to_string(),
            }],
            workspace_regions: vec![WorkspaceRegionRow {
                id: "reg-1".to_string(),
                workspace_id: "ws-1".to_string(),
                name: "Hanseong".to_string(),
                position: 0,
                created_at: now.clone(),
            }],
            workspace_eras: vec![WorkspaceEraRow {
                id: "era-1".to_string(),
                workspace_id: "ws-1".to_string(),
                name: "Joseon".to_string(),
                from_year: 1392,
                to_year: 1897,
                position: 0,
                created_at: now.clone(),
            }],
            workspace_statuses: vec![WorkspaceStatusRow {
                id: "sta-1".to_string(),
                workspace_id: "ws-1".to_string(),
                name: "검토".to_string(),
                position: 0,
                created_at: now.clone(),
            }],
            note_regions: vec![NoteRegionRow {
                id: "nreg-1".to_string(),
                note_id: "note-a".to_string(),
                name: "Gyeongbok".to_string(),
                lat: 37.5,
                lng: 127.0,
                position: 0,
                created_at: now.clone(),
            }],
            note_related_exclusions: vec![NoteRelatedExclusionRow {
                id_1: "note-a".to_string(),
                id_2: "note-b".to_string(),
                created_at: now.clone(),
            }],
            spaces: vec![SpaceRow {
                id: "spc-1".to_string(),
                workspace_id: "ws-1".to_string(),
                title: "Space".to_string(),
                position: 0,
                is_home: 1,
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
            }],
            space_items: vec![
                SpaceItemRow {
                    id: "sitem-note".to_string(),
                    space_id: "spc-1".to_string(),
                    kind: "note".to_string(),
                    source_id: Some("note-a".to_string()),
                    content: String::new(),
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                    z_index: 0,
                    display_mode: "preview".to_string(),
                    style: String::new(),
                    locked: 0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
                SpaceItemRow {
                    id: "sitem-img".to_string(),
                    space_id: "spc-1".to_string(),
                    kind: "image".to_string(),
                    source_id: Some("spaces/spc-1/pic.png".to_string()),
                    content: String::new(),
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                    z_index: 1,
                    display_mode: "preview".to_string(),
                    style: String::new(),
                    locked: 0,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                },
            ],
            routine_completions: vec![RoutineCompletionRow {
                note_id: "note-a".to_string(),
                occur_on: "2026-09-21".to_string(),
                done_at: now.clone(),
            }],
            note_dates: vec![NoteDateRow {
                id: "ndate-1".to_string(),
                note_id: "note-a".to_string(),
                position: Some(1),
                year: Some(1446),
                month: Some(9),
                day: Some(1),
                end_year: None,
                end_month: None,
                end_day: None,
                remind: 0,
                created_at: now.clone(),
                start_time: None,
                end_time: None,
                remind_offset_min: None,
                rrule: None,
                label: None,
                date: None,
                end_date: None,
            }],
            workspace_settings: vec![WorkspaceSettingRow {
                workspace_id: "ws-1".to_string(),
                key: "notebook.pet.enabled".to_string(),
                value: "1".to_string(),
            }],
            timeline_routines: vec![TimelineRoutineRow {
                id: "troutine-1".to_string(),
                workspace_id: "ws-1".to_string(),
                title: "아침".to_string(),
                weekday_mask: 127,
                start_time: "08:00".to_string(),
                end_time: "09:00".to_string(),
                color_hue: None,
                skip_holidays: 0,
                position: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            calendar_sources: vec![CalendarSource {
                id: "csrc-1".to_string(),
                workspace_id: "ws-1".to_string(),
                name: "Holidays".to_string(),
                url: None,
                enabled: true,
                color_hue: None,
                fetched_at: None,
                position: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            calendar_marks: vec![CalendarMark {
                id: "cmark-1".to_string(),
                workspace_id: "ws-1".to_string(),
                source_id: Some("csrc-1".to_string()),
                uid: None,
                title: "설".to_string(),
                year: None,
                month: 1,
                day: 1,
                repeat: "yearly".to_string(),
                lunar: true,
                day_off: true,
                color_hue: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            calendar_mark_hides: vec![CalendarMarkHideRow {
                workspace_id: "ws-1".to_string(),
                source: "csrc-1".to_string(),
                iso_day: "2026-01-01".to_string(),
            }],
        };
        let tag_id_map: HashMap<String, String> =
            [("tag-1".to_string(), "tag-merged".to_string())].into();

        let (out, (ws_map, folder_map, note_map, section_map, rel_map)) =
            remap_bundle_ids(&bundle, &tag_id_map);

        // (a) id 를 새로 받는 표의 모든 행 id 가 원본과 다르다.
        let mut emitted: Vec<&str> = Vec::new();
        emitted.extend(out.workspaces.iter().map(|r| r.id.as_str()));
        emitted.extend(out.folders.iter().map(|r| r.id.as_str()));
        emitted.extend(out.notes.iter().map(|r| r.id.as_str()));
        emitted.extend(out.sections.iter().map(|r| r.id.as_str()));
        emitted.extend(out.sources.iter().map(|r| r.id.as_str()));
        emitted.extend(out.attachments.iter().map(|r| r.id.as_str()));
        emitted.extend(out.workspace_regions.iter().map(|r| r.id.as_str()));
        emitted.extend(out.workspace_eras.iter().map(|r| r.id.as_str()));
        emitted.extend(out.workspace_statuses.iter().map(|r| r.id.as_str()));
        emitted.extend(out.note_regions.iter().map(|r| r.id.as_str()));
        emitted.extend(out.note_dates.iter().map(|r| r.id.as_str()));
        emitted.extend(out.spaces.iter().map(|r| r.id.as_str()));
        emitted.extend(out.space_items.iter().map(|r| r.id.as_str()));
        emitted.extend(out.timeline_routines.iter().map(|r| r.id.as_str()));
        emitted.extend(out.calendar_sources.iter().map(|r| r.id.as_str()));
        emitted.extend(out.calendar_marks.iter().map(|r| r.id.as_str()));
        assert_eq!(emitted.len(), OLD_IDS.len(), "id 를 새로 받는 행 개수");
        for id in &emitted {
            assert!(!OLD_IDS.contains(id), "원본 id 가 그대로 남았다: {id}");
        }
        // 태그는 전역이라 새 id 를 발급하지 않고 이름 병합 맵이 정한 id 를 쓴다.
        assert_eq!(out.tags[0].id, "tag-merged");
        // 기기 전역 설정은 노트북 추가에 딸려가지 않는다.
        assert!(out.settings.is_empty());

        // (b) 모든 FK 가 새 번들 안의 행을 가리킨다.
        let ws = out.workspaces[0].id.as_str();
        let folder = out.folders[0].id.as_str();
        let note_a = out.notes[0].id.as_str();
        let note_b = out.notes[1].id.as_str();
        let space = out.spaces[0].id.as_str();
        let cal_source = out.calendar_sources[0].id.as_str();

        assert_eq!(out.folders[0].workspace_id, ws);
        assert_eq!(out.notes[0].folder_id, folder);
        assert_eq!(out.notes[1].folder_id, folder);
        assert_eq!(
            out.notes[0].status.as_deref(),
            Some(out.workspace_statuses[0].id.as_str())
        );
        assert_eq!(out.notes[1].status.as_deref(), Some("done"), "빌트인 상태 키는 그대로");
        assert_eq!(out.sections[0].note_id, note_a);
        assert_eq!(out.sources[0].note_id, note_a);
        for a in &out.attachments {
            assert_eq!(a.note_id, note_a);
        }
        assert_eq!(out.attachments[0].rel_path, Some(format!("{note_a}/img.png")));
        assert_eq!(out.attachments[1].url, Some(format!("{}#c1", out.sections[0].id)));
        assert_eq!(out.attachments[2].url.as_deref(), Some(note_b));
        assert_eq!(out.note_tags[0].note_id, note_a);
        assert_eq!(out.note_tags[0].tag_id, "tag-merged");
        assert_eq!(out.workspace_regions[0].workspace_id, ws);
        assert_eq!(out.workspace_eras[0].workspace_id, ws);
        assert_eq!(out.workspace_statuses[0].workspace_id, ws);
        assert_eq!(out.note_regions[0].note_id, note_a);
        assert_eq!(out.note_dates[0].note_id, note_a);
        assert_eq!(out.note_related_exclusions[0].id_1, note_a);
        assert_eq!(out.note_related_exclusions[0].id_2, note_b);
        assert_eq!(out.spaces[0].workspace_id, ws);
        assert_eq!(out.space_items[0].space_id, space);
        assert_eq!(out.space_items[1].space_id, space);
        assert_eq!(out.space_items[0].source_id.as_deref(), Some(note_a));
        assert_eq!(out.space_items[1].source_id, Some(format!("spaces/{space}/pic.png")));
        assert_eq!(out.routine_completions[0].note_id, note_a);
        assert_eq!(out.workspace_settings[0].workspace_id, ws);
        assert_eq!(out.timeline_routines[0].workspace_id, ws);
        assert_eq!(out.calendar_sources[0].workspace_id, ws);
        assert_eq!(out.calendar_marks[0].workspace_id, ws);
        assert_eq!(out.calendar_marks[0].source_id.as_deref(), Some(cal_source));
        assert_eq!(out.calendar_mark_hides[0].workspace_id, ws);
        assert_eq!(out.calendar_mark_hides[0].source, cal_source);

        // 본문 속 위키링크·인라인 이미지 경로도 새 id 를 가리킨다.
        let body = &out.sections[0].body_md;
        assert!(body.contains(&format!("note://{note_a}")), "{body}");
        assert!(body.contains(&format!("{note_a}/img.png")), "{body}");
        assert!(!body.contains("note-a"), "{body}");

        // 반환되는 매핑도 같은 id 를 가리킨다 — extras.rs 가 이걸 그대로 다시 쓴다.
        assert_eq!(ws_map.get("ws-1").map(String::as_str), Some(ws));
        assert_eq!(folder_map.get("fo-1").map(String::as_str), Some(folder));
        assert_eq!(note_map.get("note-a").map(String::as_str), Some(note_a));
        assert_eq!(
            section_map.get("sec-1").map(String::as_str),
            Some(out.sections[0].id.as_str())
        );
        assert_eq!(rel_map.get("note-a/img.png"), Some(&format!("{note_a}/img.png")));
    }

    #[test]
    fn add_notebook_remaps_ids_and_preserves_structure() {
        use crate::repo::transfer::export::{dump_workspace, export_workspace_bundle};

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        // Drop seed workspace noise for cleaner counts — keep schema, add our notebook.
        let (ws, _folder, note_a) = seed_notebook_bundle_source(&mut conn);

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"hello").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();
        assert_eq!(exp.note_count, 2);

        // Import into a FRESH db as new notebook.
        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let seeded_ws: i64 = fresh
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        let imp = import_bundle(
            &mut fresh,
            fresh_data.path(),
            Path::new(&exp.bundle_path),
            "add_notebook",
            None,
            false,
        )
        .unwrap();
        assert_eq!(imp.imported_notes, 2);
        assert_eq!(imp.skipped, 0);

        // One new notebook beyond the seed.
        let ws_count: i64 = fresh
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ws_count, seeded_ws + 1);

        // Original note id must NOT exist (remapped).
        let old_id_count: i64 = fresh
            .query_row("SELECT COUNT(*) FROM notes WHERE id=?1", [&note_a], |r| r.get(0))
            .unwrap();
        assert_eq!(old_id_count, 0);

        // Structure preserved under the new notebook named "History Lab".
        let new_ws: String = fresh
            .query_row(
                "SELECT id FROM workspaces WHERE name='History Lab'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let note_count: i64 = fresh
            .query_row(
                "SELECT COUNT(*) FROM notes n JOIN folders f ON f.id=n.folder_id WHERE f.workspace_id=?1",
                [&new_ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(note_count, 2);

        let tag: String = fresh
            .query_row(
                "SELECT t.name FROM tags t
                 JOIN note_tags nt ON nt.tag_id=t.id
                 JOIN notes n ON n.id=nt.note_id
                 WHERE n.title='Sejong'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tag, "hangul");

        let regions: i64 = fresh
            .query_row(
                "SELECT COUNT(*) FROM workspace_regions WHERE workspace_id=?1 AND name='Hanseong'",
                [&new_ws],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(regions, 1);

        let note_regions: i64 = fresh
            .query_row(
                "SELECT COUNT(*) FROM note_regions nr JOIN notes n ON n.id=nr.note_id WHERE n.title='Sejong'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(note_regions, 1);

        // GRILL-2026-09-07 D2: note_dates must survive the id-remap path too (same class of
        // per-note user content as note_regions above). PLAN-2026-09-08-dates-rebuild.md W1:
        // note_dates now also holds the position=0 mirror row, so this must filter it out and
        // reassemble the "YYYY-MM-DD" shape from the year/month/day triple.
        let note_date: String = fresh
            .query_row(
                "SELECT printf('%04d-%02d-%02d', nd.year, nd.month, nd.day) FROM note_dates nd
                 JOIN notes n ON n.id=nd.note_id WHERE n.title='Sejong' AND nd.position != 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(note_date, "1446-09-01");

        let exclusions: i64 = fresh
            .query_row("SELECT COUNT(*) FROM note_related_exclusions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(exclusions, 1);

        let att_on_disk = std::fs::read(db::attachments_dir(fresh_data.path()).join("file.txt")).unwrap();
        assert_eq!(att_on_disk, b"hello");

        // dump_workspace self-check: source dump includes taxonomy.
        let dumped = dump_workspace(&conn, &ws).unwrap();
        assert_eq!(dumped.workspace_regions.len(), 1);
        assert!(dumped.settings.is_empty());
    }

    /// 리그레션(데이터 손실 P0): export_workspace_bundle -> import_bundle(add_notebook) 왕복도
    /// duplicate_notebook 과 같은 경로(dump_workspace -> insert_note)를 타므로 같은 버그를 갖고
    /// 있었다 — "노트북으로 가져오기"("노트북으로 가져오기" import_add_notebook, F-N06) 로 받은
    /// 노트북에서 아카이브가 조용히 풀렸다.
    #[test]
    fn add_notebook_import_preserves_archived_state() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _folder, note_a) = seed_notebook_bundle_source(&mut conn);
        crate::repo::notes::archive(&mut conn, &note_a).unwrap();
        let archived_at: String = conn
            .query_row("SELECT archived_at FROM notes WHERE id=?1", [&note_a], |r| r.get(0))
            .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"hello").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(&mut fresh, fresh_data.path(), Path::new(&exp.bundle_path), "add_notebook", None, false)
            .unwrap();

        let imported_sejong_archived: Option<String> = fresh
            .query_row("SELECT archived_at FROM notes WHERE title='Sejong'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            imported_sejong_archived.as_deref(),
            Some(archived_at.as_str()),
            "archived note must import as archived with the same timestamp"
        );
        let imported_partner_archived: Option<String> = fresh
            .query_row("SELECT archived_at FROM notes WHERE title='Partner'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(imported_partner_archived, None, "non-archived note must import as non-archived");
    }

    #[test]
    fn add_notebook_twice_creates_two_notebooks() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join("file.txt"), b"x").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let before: i64 = fresh
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(
            &mut fresh,
            fresh_data.path(),
            Path::new(&exp.bundle_path),
            "add_notebook",
            None,
            false,
        )
        .unwrap();
        import_bundle(
            &mut fresh,
            fresh_data.path(),
            Path::new(&exp.bundle_path),
            "add_notebook",
            None,
            false,
        )
        .unwrap();
        let after: i64 = fresh
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before + 2);
        let hist: i64 = fresh
            .query_row(
                "SELECT COUNT(*) FROM workspaces WHERE name='History Lab'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hist, 2);
        let sejong: i64 = fresh
            .query_row("SELECT COUNT(*) FROM notes WHERE title='Sejong'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sejong, 2);
    }

    // 리그레션(데이터 손실 P0): test_support::seed_notebook_bundle_source 의 'file.txt' 같은
    // 맨 파일명 rel_path 는 실제로는 attachments::attachment_add 가 절대 만들지 않는 모양이라
    // (실제는 항상 "{note_id}/{stored_name}") 이 버그를 가려왔다. 여기서는 실제 포맷을 그대로
    // 재현해, note_id 가 remap 된 뒤에도 rel_path 가 새 note_id 를 따라가고 파일이 실제로 그
    // 경로에 있는지, 그리고 부팅 시 orphan_cleanup 이 그 디렉토리를 고아로 오인해 지우지 않는지
    // 확인한다.
    #[test]
    fn add_notebook_remaps_attachment_rel_path_and_survives_orphan_cleanup() {
        use crate::repo::transfer::export::export_workspace_bundle;
        use crate::util::now_iso;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let now = now_iso();
        let ws = new_id();
        let folder = new_id();
        let note = new_id();
        conn.execute(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?1,'Realistic',?2)",
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
        // Realistic rel_path — mirrors attachments::attachment_add's actual format
        // "{note_id}/{stored_name}", unlike the bare 'file.txt' fixture elsewhere.
        let rel_path = format!("{note}/file.png");
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, position, created_at)
             VALUES (?1,?2,'file.png','doc',?3,0,?4)",
            params![new_id(), note, rel_path, now],
        )
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att_dir = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(att_dir.join(&note)).unwrap();
        std::fs::write(att_dir.join(&rel_path), b"PNGDATA").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(
            &mut fresh,
            fresh_data.path(),
            Path::new(&exp.bundle_path),
            "add_notebook",
            None,
            false,
        )
        .unwrap();

        let (new_note_id, new_rel_path): (String, String) = fresh
            .query_row(
                "SELECT note_id, rel_path FROM attachments WHERE name='file.png'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(new_note_id, note, "note id must be remapped on add_notebook import");
        assert!(
            new_rel_path.starts_with(&format!("{new_note_id}/")),
            "rel_path must point at the NEW note id, got {new_rel_path}"
        );

        let on_disk =
            std::fs::read(db::attachments_dir(fresh_data.path()).join(&new_rel_path)).unwrap();
        assert_eq!(on_disk, b"PNGDATA");

        // Boot-time orphan_cleanup must not treat the freshly-imported dir as orphaned.
        crate::repo::attachments::orphan_cleanup(&fresh, fresh_data.path()).unwrap();
        assert!(db::attachments_dir(fresh_data.path()).join(&new_rel_path).exists());
    }

    fn ws_setting(conn: &Connection, ws: &str, key: &str) -> Option<String> {
        use rusqlite::OptionalExtension;
        conn.query_row(
            "SELECT value FROM workspace_settings WHERE workspace_id=?1 AND key=?2",
            params![ws, key],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// PLAN-2026-09-19-notebook-settings §5: 노트북 내보내기 → 새 노트북으로 가져오기가 그 노트북의
    /// 설정과 반복 일정을 함께 옮긴다(격리된 노트북이 통째로 이사한다).
    #[test]
    fn add_notebook_carries_the_notebooks_settings_and_routines() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        conn.execute(
            r#"INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, 'theme', '"dark"'), (?1, 'ui_lang', '"fr"')"#,
            [&ws],
        )
        .unwrap();
        crate::repo::timeline_routine::create(&conn, &ws, "출근", 0b0011111, "08:00", "09:00", None, true)
            .unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(db::attachments_dir(data_dir.path())).unwrap();
        std::fs::write(db::attachments_dir(data_dir.path()).join("file.txt"), b"x").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(&mut fresh, fresh_data.path(), Path::new(&exp.bundle_path), "add_notebook", None, false)
            .unwrap();
        let new_ws: String = fresh
            .query_row("SELECT id FROM workspaces WHERE name='History Lab'", [], |r| r.get(0))
            .unwrap();
        assert_ne!(new_ws, ws, "ids are remapped");
        assert_eq!(ws_setting(&fresh, &new_ws, "theme").as_deref(), Some(r#""dark""#));
        assert_eq!(ws_setting(&fresh, &new_ws, "ui_lang").as_deref(), Some(r#""fr""#));
        let routines: Vec<(String, i64)> = fresh
            .prepare("SELECT title, skip_holidays FROM timeline_routines WHERE workspace_id=?1")
            .unwrap()
            .query_map([&new_ws], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(routines, vec![("출근".to_string(), 1)]);
        // 다른(기존) 노트북은 아무것도 받지 않는다.
        let others: i64 = fresh
            .query_row("SELECT COUNT(*) FROM workspace_settings WHERE workspace_id != ?1", [&new_ws], |r| r.get(0))
            .unwrap();
        assert_eq!(others, 0);
    }

    /// V86 이전 번들(workspace_settings 없음, 노트북 키가 전역 settings 에 실림)은 그 값으로 새 노트북을
    /// 채운다. 노트북 키가 아닌 전역 키(close_to_tray)는 노트북으로 새어 들어가지 않는다.
    #[test]
    fn legacy_bundle_global_notebook_keys_seed_the_new_notebook() {
        use crate::repo::transfer::bundle::KvRow;
        use crate::repo::transfer::export::dump_workspace;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        let mut bundle = dump_workspace(&conn, &ws).unwrap();
        bundle.attachments.clear();
        bundle.workspace_settings.clear();
        bundle.settings = vec![
            KvRow { key: "theme".into(), value: r#""light""#.into() },
            KvRow { key: "close_to_tray".into(), value: "false".into() },
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("brise-bundle.json");
        std::fs::write(&path, serde_json::to_string(&bundle).unwrap()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(&mut fresh, fresh_data.path(), &path, "add_notebook", None, false).unwrap();
        let new_ws: String = fresh
            .query_row("SELECT id FROM workspaces WHERE name='History Lab'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ws_setting(&fresh, &new_ws, "theme").as_deref(), Some(r#""light""#));
        assert_eq!(ws_setting(&fresh, &new_ws, "close_to_tray"), None);
    }

    /// 손으로 만든 번들이 노트북 설정 행에 전역 키를 밀어 넣거나, **이미 있는 내 노트북의 id** 를
    /// 적어 그 노트북 설정을 덮어쓰려 해도 받지 않는다.
    #[test]
    fn non_notebook_keys_in_workspace_settings_rows_are_ignored() {
        use crate::repo::transfer::bundle::WorkspaceSettingRow;
        use crate::repo::transfer::export::dump_workspace;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        let mut bundle = dump_workspace(&conn, &ws).unwrap();
        bundle.attachments.clear();
        bundle.workspace_settings = vec![
            WorkspaceSettingRow { workspace_id: ws.clone(), key: "ai_api_key".into(), value: r#""sk-leak""#.into() },
            WorkspaceSettingRow {
                workspace_id: ws.clone(),
                key: "ai_provider_creds".into(),
                value: r#"{"openai":{"api_key":"sk-leak"}}"#.into(),
            },
            WorkspaceSettingRow { workspace_id: ws.clone(), key: "theme".into(), value: r#""dark""#.into() },
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("brise-bundle.json");
        std::fs::write(&path, serde_json::to_string(&bundle).unwrap()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        // 받는 쪽에 이미 있는 노트북 — 번들이 이 id 를 겨냥한다.
        let victim = crate::repo::folders::active_workspace_id(&fresh).unwrap();
        fresh
            .execute(
                r#"INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, 'theme', '"light"')"#,
                [&victim],
            )
            .unwrap();
        let mut bundle: crate::repo::transfer::bundle::Bundle =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        bundle.workspace_settings.push(WorkspaceSettingRow {
            workspace_id: victim.clone(),
            key: "theme".into(),
            value: r#""dark""#.into(),
        });
        std::fs::write(&path, serde_json::to_string(&bundle).unwrap()).unwrap();

        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(&mut fresh, fresh_data.path(), &path, "add_notebook", None, false).unwrap();
        let leaked: i64 = fresh
            .query_row("SELECT COUNT(*) FROM workspace_settings WHERE key IN ('ai_api_key', 'ai_provider_creds')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leaked, 0);
        assert_eq!(ws_setting(&fresh, &victim, "theme").as_deref(), Some(r#""light""#), "existing notebook untouched");
        // 정당한 행(번들 자신의 노트북)은 새 노트북으로 들어간다.
        let new_ws: String = fresh
            .query_row("SELECT id FROM workspaces WHERE name='History Lab'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ws_setting(&fresh, &new_ws, "theme").as_deref(), Some(r#""dark""#));
    }

    /// 달력 표시일(V87)도 노트북과 함께 이사한다 — 출처·표시일·숨김이 새 id 로, 숨김은 새 출처를 가리킨다.
    #[test]
    fn add_notebook_carries_calendar_marks_sources_and_hides() {
        use crate::repo::calendar_marks as cal;
        use crate::repo::transfer::export::dump_workspace;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        let f = |t: &str, m: i64, d: i64| cal::MarkFields {
            title: t.into(),
            year: None,
            month: m,
            day: d,
            repeat: "yearly".into(),
            lunar: false,
            day_off: true,
            color_hue: None,
        };
        cal::create(&conn, &ws, &f("엄마 생일", 3, 15)).unwrap();
        let (src, _) = cal::save_source(
            &mut conn,
            &ws,
            None,
            "공휴일",
            Some("https://example.com/h.ics"),
            &[cal::ImportedMark { uid: Some("u1".into()), fields: f("신정", 1, 1) }],
        )
        .unwrap();
        cal::set_hidden(&conn, &ws, &src.id, "2026-01-01", true).unwrap();
        cal::set_hidden(&conn, &ws, cal::BUILTIN_SOURCE, "2026-06-06", true).unwrap();

        let mut bundle = dump_workspace(&conn, &ws).unwrap();
        bundle.attachments.clear();
        assert_eq!((bundle.calendar_sources.len(), bundle.calendar_marks.len(), bundle.calendar_mark_hides.len()), (1, 2, 2));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("brise-bundle.json");
        std::fs::write(&path, serde_json::to_string(&bundle).unwrap()).unwrap();

        let mut fresh = Connection::open_in_memory().unwrap();
        migrations::run(&mut fresh).unwrap();
        let fresh_data = tempfile::tempdir().unwrap();
        import_bundle(&mut fresh, fresh_data.path(), &path, "add_notebook", None, false).unwrap();
        let new_ws: String = fresh
            .query_row("SELECT id FROM workspaces WHERE name='History Lab'", [], |r| r.get(0))
            .unwrap();
        let d = cal::list(&fresh, &new_ws).unwrap();
        assert_eq!(d.sources.len(), 1);
        assert_ne!(d.sources[0].id, src.id, "source ids are remapped");
        assert_eq!(d.marks.len(), 2);
        assert!(d.marks.iter().any(|m| m.source_id.as_deref() == Some(d.sources[0].id.as_str())));
        let mut hide_sources: Vec<&str> = d.hides.iter().map(|h| h.source.as_str()).collect();
        hide_sources.sort();
        let mut want = vec![cal::BUILTIN_SOURCE, d.sources[0].id.as_str()];
        want.sort();
        assert_eq!(hide_sources, want, "hides follow the remapped source");
    }

    /// 노트북 복제: 노트·설정·반복 일정·표시일이 새 노트북으로 통째로, 원본은 그대로.
    /// 본문 속 인라인 이미지는 `![alt]({note_id}/{stored_name}){width=…}` — 첨부의 rel_path 를 그대로
    /// 적는다(src/components/editor/imageExtension.ts renderMarkdown). 복제/노트북으로 가져오기는
    /// 첨부 행의 rel_path 와 파일을 새 note_id 디렉토리로 옮기면서 **본문 속 같은 경로는 그대로 뒀다**:
    /// 사본의 이미지가 원본 노트의 파일을 가리켜(원본을 비우면 깨진다), 다른 기기로 가져오면 그
    /// 디렉토리가 아예 없어 처음부터 깨진 이미지였다. 스냅샷 payload 의 body_md 도 같은 경로를 품는다.
    #[test]
    fn duplicate_notebook_rewrites_inline_image_rel_paths_in_bodies_and_snapshots() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, note) = seed_notebook_bundle_source(&mut conn);
        let data_dir = tempfile::tempdir().unwrap();
        let att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(att.join(&note)).unwrap();
        std::fs::write(att.join(&note).join("ab12cd34-pic.png"), b"png").unwrap();
        let old_rel = format!("{note}/ab12cd34-pic.png");
        conn.execute(
            "INSERT INTO attachments(id, note_id, name, kind, rel_path, url, size_bytes, position, created_at)
             VALUES ('att-inline', ?1, 'pic.png', 'image', ?2, NULL, 3, 99, '2026-01-01T00:00:00Z')",
            params![note, old_rel],
        )
        .unwrap();
        let body = format!("앞 글\n\n![그림]({old_rel}){{width=40%}}\n\n뒤 글");
        conn.execute("UPDATE sections SET body_md=?1 WHERE note_id=?2", params![body, note]).unwrap();
        let section_id: String =
            conn.query_row("SELECT id FROM sections WHERE note_id=?1 LIMIT 1", [&note], |r| r.get(0)).unwrap();
        let payload = serde_json::json!([{ "section_id": section_id, "title": "Over", "kind": "text", "body_md": body }]);
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES ('snap-inline', ?1, '2026-01-02T00:00:00Z', ?2)",
            params![note, payload.to_string()],
        )
        .unwrap();

        let copy = super::super::duplicate_notebook(&mut conn, data_dir.path(), &ws, "사본").unwrap();

        let (new_note, new_rel): (String, String) = conn
            .query_row(
                "SELECT a.note_id, a.rel_path FROM attachments a JOIN notes n ON n.id=a.note_id
                 JOIN folders f ON f.id=n.folder_id WHERE f.workspace_id=?1 AND a.name='pic.png'",
                [&copy],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(new_rel, format!("{new_note}/ab12cd34-pic.png"), "첨부 행은 원래부터 새 디렉토리로 옮겨졌다");
        assert!(att.join(&new_rel).exists(), "파일도 새 디렉토리에 복사됐다");

        let new_body: String =
            conn.query_row("SELECT body_md FROM sections WHERE note_id=?1 LIMIT 1", [&new_note], |r| r.get(0)).unwrap();
        assert!(new_body.contains(&format!("]({new_rel})")), "사본 본문은 사본의 파일을 가리켜야 한다: {new_body}");
        assert!(!new_body.contains(&old_rel), "원본 노트의 경로가 사본 본문에 남으면 안 된다: {new_body}");

        let new_payload: String =
            conn.query_row("SELECT payload FROM note_snapshots WHERE note_id=?1", [&new_note], |r| r.get(0)).unwrap();
        assert!(new_payload.contains(&new_rel), "스냅샷 payload 의 body_md 도 같이 고쳐 쓴다: {new_payload}");
        assert!(!new_payload.contains(&old_rel), "{new_payload}");

        // 원본은 그대로.
        let orig_body: String =
            conn.query_row("SELECT body_md FROM sections WHERE note_id=?1 LIMIT 1", [&note], |r| r.get(0)).unwrap();
        assert!(orig_body.contains(&old_rel));
    }

    #[test]
    fn duplicate_notebook_copies_everything_under_new_ids() {
        use crate::repo::calendar_marks as cal;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        conn.execute(
            r#"INSERT INTO workspace_settings(workspace_id, key, value) VALUES (?1, 'theme', '"dark"')"#,
            [&ws],
        )
        .unwrap();
        crate::repo::timeline_routine::create(&conn, &ws, "출근", 31, "08:00", "09:00", None, false).unwrap();
        cal::create(
            &conn,
            &ws,
            &cal::MarkFields {
                title: "결혼기념일".into(),
                year: Some(2010),
                month: 5,
                day: 20,
                repeat: "yearly".into(),
                lunar: false,
                day_off: false,
                color_hue: None,
            },
        )
        .unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        let att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("file.txt"), b"x").unwrap();
        let notes_in = |c: &Connection, w: &str| -> i64 {
            c.query_row(
                "SELECT COUNT(*) FROM notes n JOIN folders f ON f.id=n.folder_id WHERE f.workspace_id=?1",
                [w],
                |r| r.get(0),
            )
            .unwrap()
        };
        let before_notes = notes_in(&conn, &ws);

        let copy = super::super::duplicate_notebook(&mut conn, data_dir.path(), &ws, "History Lab 사본").unwrap();
        assert_ne!(copy, ws);
        assert_eq!(notes_in(&conn, &copy), before_notes);
        assert_eq!(notes_in(&conn, &ws), before_notes, "original untouched");
        assert_eq!(ws_setting(&conn, &copy, "theme").as_deref(), Some(r#""dark""#));
        let routines: i64 = conn
            .query_row("SELECT COUNT(*) FROM timeline_routines WHERE workspace_id=?1", [&copy], |r| r.get(0))
            .unwrap();
        assert_eq!(routines, 1);
        assert_eq!(cal::list(&conn, &copy).unwrap().marks[0].title, "결혼기념일");
        let name: String = conn.query_row("SELECT name FROM workspaces WHERE id=?1", [&copy], |r| r.get(0)).unwrap();
        assert_eq!(name, "History Lab 사본");
    }

    /// 리그레션(데이터 손실 P0, 리뷰어 확인 버그): 노트북 복제(duplicate_notebook)는
    /// dump_workspace -> add_notebook 경로를 그대로 탄다. 번들이 archived_at 을 안 실으면(export
    /// 세 SELECT 중 어디도 이 컬럼을 담지 않았다) 복제된 노트가 항상 archived_at=NULL 로
    /// 착지해 아카이브했던 노트가 복제본에서 조용히 언아카이브됐다 — 한 클릭짜리 복제 기능이라
    /// 이 버그를 밟기 더 쉬워졌다(F-N06, docs/NOTES.md). 아카이브 노트는 같은 시각 그대로
    /// 아카이브 유지, 미아카이브 노트는 그대로 미아카이브 유지되어야 한다.
    #[test]
    fn duplicate_notebook_preserves_archived_state_and_timestamp() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, note_a) = seed_notebook_bundle_source(&mut conn);
        // note_a = "Sejong" 을 아카이브, note_b("Partner")는 그대로 둔다.
        crate::repo::notes::archive(&mut conn, &note_a).unwrap();
        let archived_at: String = conn
            .query_row("SELECT archived_at FROM notes WHERE id=?1", [&note_a], |r| r.get(0))
            .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("file.txt"), b"x").unwrap();

        let copy = super::super::duplicate_notebook(&mut conn, data_dir.path(), &ws, "History Lab 사본").unwrap();

        let copied_sejong_archived: Option<String> = conn
            .query_row(
                "SELECT archived_at FROM notes n JOIN folders f ON f.id=n.folder_id
                 WHERE f.workspace_id=?1 AND n.title='Sejong'",
                [&copy],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            copied_sejong_archived.as_deref(),
            Some(archived_at.as_str()),
            "archived note must stay archived with the same timestamp after duplicate_notebook"
        );

        let copied_partner_archived: Option<String> = conn
            .query_row(
                "SELECT archived_at FROM notes n JOIN folders f ON f.id=n.folder_id
                 WHERE f.workspace_id=?1 AND n.title='Partner'",
                [&copy],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            copied_partner_archived, None,
            "non-archived note must stay non-archived after duplicate_notebook"
        );

        // 원본은 그대로.
        let original_still_archived: bool = conn
            .query_row(
                "SELECT archived_at IS NOT NULL FROM notes WHERE id=?1",
                [&note_a],
                |r| r.get(0),
            )
            .unwrap();
        assert!(original_still_archived, "original note's archived state untouched");
    }

    /// 오너 결정(2026-09-20): "펫 대화·수집 소스도 복제에 포함해줘" + "수집 소스는 꺼진 채로
    /// 복사". 이 테스트는 프로덕션 코드를 고치기 **전에** 먼저 작성해 실패를 확인한다(지금
    /// duplicate_notebook 은 pet_sessions/pet_messages/collect_sources/collect_seen 을 전혀
    /// 옮기지 않는다).
    ///
    /// 닫힌 세션 1개(메시지 2개, 그중 어시스턴트 메시지는 note:// 위키링크 + meta.note_id/
    /// hits[].note_id 를 담아 remap 이 실제로 동작하는지 확인) + 열린 세션 1개(메시지 1개) +
    /// 수집 소스 3개(하나는 이 노트북 폴더를 target_folder_id 로 가리키고 last_status/last_error 도
    /// 채움, 나머지 둘 중 하나는 켜짐·하나는 이미 꺼짐 — 사본에서 전부 꺼지는지 확인, collect_seen
    /// 2건) + 스냅샷 1개(내보내기 제외 확인용)를 갖춘 노트북을 복제해 사본에 전부 나타나는지,
    /// 원본은 그대로인지, 내보내기 번들에는 안 실리는지 확인한다.
    #[test]
    fn duplicate_notebook_copies_pet_chat_and_collect_sources() {
        use crate::repo::transfer::export::export_workspace_bundle;

        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, folder, note_a) = seed_notebook_bundle_source(&mut conn);
        let now = crate::util::now_iso();

        // 닫힌 세션 + 메시지 2개.
        let closed_session = new_id();
        conn.execute(
            "INSERT INTO pet_sessions (id, workspace_id, title, created_at, closed_at, message_count) VALUES (?1,?2,'첫 대화',?3,?3,2)",
            params![closed_session, ws, now],
        )
        .unwrap();
        let meta_with_note = serde_json::json!({
            "note_id": note_a,
            "hits": [{"note_id": note_a, "title": "Sejong", "snippet": "s"}],
        })
        .to_string();
        conn.execute(
            "INSERT INTO pet_messages (id, workspace_id, role, text, created_at, meta, session_id) VALUES (?1,?2,'user','이 노트 봐줘',?3,NULL,?4)",
            params![new_id(), ws, now, closed_session],
        )
        .unwrap();
        let assistant_text = format!("[Sejong](note://{note_a}) 를 찾았어요.");
        conn.execute(
            "INSERT INTO pet_messages (id, workspace_id, role, text, created_at, meta, session_id) VALUES (?1,?2,'assistant',?3,?4,?5,?6)",
            params![new_id(), ws, assistant_text, now, meta_with_note, closed_session],
        )
        .unwrap();

        // 열린(라이브) 세션 + 메시지 1개 — 원본에 라이브 세션이 있어도 사본은 자기 노트북 스코프의
        // 독립적인 라이브 세션을 가지므로(repo::pet::live_session_id 는 workspace_id 로 조회) 충돌하지 않는다.
        let open_session = new_id();
        conn.execute(
            "INSERT INTO pet_sessions (id, workspace_id, title, created_at, closed_at, message_count) VALUES (?1,?2,'둘째 대화',?3,NULL,1)",
            params![open_session, ws, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pet_messages (id, workspace_id, role, text, created_at, meta, session_id) VALUES (?1,?2,'user','안녕',?3,NULL,?4)",
            params![new_id(), ws, now, open_session],
        )
        .unwrap();

        // 수집 소스 2개 — 하나는 target_folder_id 가 이 노트북 폴더, last_status/last_error 도 채움.
        let source_with_folder = new_id();
        conn.execute(
            "INSERT INTO collect_sources (id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, last_status, last_error, created_at, updated_at)
             VALUES (?1,?2,'rss','Feed',?3,1,0,?4,'none',NULL,30,?5,'error','boom',?5,?5)",
            params![source_with_folder, ws, r#"{"url":"https://example.com/feed.xml"}"#, folder, now],
        )
        .unwrap();
        let source_plain = new_id();
        conn.execute(
            "INSERT INTO collect_sources (id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, last_status, last_error, created_at, updated_at)
             VALUES (?1,?2,'web','Page','{\"url\":\"https://example.com\"}',1,0,NULL,'none',NULL,NULL,NULL,NULL,NULL,?3,?3)",
            params![source_plain, ws, now],
        )
        .unwrap();
        // 이미 꺼져 있던 소스 — 사본에서도 꺼진 채로 남아야 한다(원본이 켜져 있던 두 소스와 구분).
        let source_disabled = new_id();
        conn.execute(
            "INSERT INTO collect_sources (id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, last_status, last_error, created_at, updated_at)
             VALUES (?1,?2,'web','Off','{\"url\":\"https://example.com/off\"}',0,0,NULL,'none',NULL,NULL,NULL,NULL,NULL,?3,?3)",
            params![source_disabled, ws, now],
        )
        .unwrap();
        conn.execute("INSERT INTO collect_seen(source_id, guid) VALUES (?1,'g1')", params![source_with_folder])
            .unwrap();
        conn.execute("INSERT INTO collect_seen(source_id, guid) VALUES (?1,'g2')", params![source_with_folder])
            .unwrap();

        // 스냅샷 1개 — 아래 "내보내기 번들에는 안 실린다" 체크가 실제로 뭔가 있는 상태에서
        // 검증하도록(빈 데이터에서의 "포함 안 함"은 공허하게 참이 된다).
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES (?1,?2,?3,'[]')",
            params![new_id(), note_a, now],
        )
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("file.txt"), b"x").unwrap();

        let copy = super::super::duplicate_notebook(&mut conn, data_dir.path(), &ws, "History Lab 사본").unwrap();

        // --- 펫 세션/메시지 ---
        let copied_sessions: Vec<(String, Option<String>, i64, String)> = conn
            .prepare("SELECT id, closed_at, message_count, created_at FROM pet_sessions WHERE workspace_id=?1 ORDER BY created_at")
            .unwrap()
            .query_map([&copy], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(copied_sessions.len(), 2, "closed + open session both copied");
        assert!(
            copied_sessions.iter().all(|(id, ..)| *id != closed_session && *id != open_session),
            "session ids are new"
        );
        assert!(copied_sessions.iter().all(|(_, _, _, created_at)| created_at == &now), "timestamps travel verbatim");
        let copied_open = copied_sessions
            .iter()
            .find(|(_, closed_at, ..)| closed_at.is_none())
            .expect("open session copied as open (session is workspace-scoped, no cross-notebook conflict)");
        assert_eq!(copied_open.2, 1, "message_count recomputed from the copied messages");
        let copied_closed = copied_sessions.iter().find(|(_, closed_at, ..)| closed_at.is_some()).expect("closed session copied as closed");
        assert_eq!(copied_closed.2, 2);
        let (copied_open_id, copied_closed_id) = (copied_open.0.clone(), copied_closed.0.clone());

        let copied_message_sessions: Vec<Option<String>> = conn
            .prepare("SELECT session_id FROM pet_messages WHERE workspace_id=?1")
            .unwrap()
            .query_map([&copy], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(copied_message_sessions.len(), 3);
        assert!(
            copied_message_sessions
                .iter()
                .all(|sid| sid.as_deref() == Some(copied_open_id.as_str()) || sid.as_deref() == Some(copied_closed_id.as_str())),
            "every copied message's session_id points at one of the copy's OWN sessions: {copied_message_sessions:?}"
        );

        let new_note_id: String = conn
            .query_row(
                "SELECT n.id FROM notes n JOIN folders f ON f.id=n.folder_id WHERE f.workspace_id=?1 AND n.title='Sejong'",
                [&copy],
                |r| r.get(0),
            )
            .unwrap();
        let (copied_text, copied_meta): (String, Option<String>) = conn
            .query_row("SELECT text, meta FROM pet_messages WHERE workspace_id=?1 AND role='assistant'", [&copy], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(copied_text.contains(&format!("note://{new_note_id}")), "note:// link rewritten to the copy's note id: {copied_text}");
        assert!(!copied_text.contains(&note_a), "old note id must not survive in copied text");
        let meta_value: serde_json::Value = serde_json::from_str(&copied_meta.unwrap()).unwrap();
        assert_eq!(meta_value["note_id"], new_note_id, "meta.note_id remapped to the copy's note");
        assert_eq!(meta_value["hits"][0]["note_id"], new_note_id, "meta.hits[].note_id remapped to the copy's note");

        // --- 수집 소스 ---
        let copied_sources: Vec<(String, Option<String>, Option<String>, Option<String>, bool)> = conn
            .prepare("SELECT id, target_folder_id, last_status, last_error, enabled FROM collect_sources WHERE workspace_id=?1")
            .unwrap()
            .query_map([&copy], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(copied_sources.len(), 3);
        assert!(
            copied_sources.iter().all(|(id, ..)| *id != source_with_folder && *id != source_plain && *id != source_disabled),
            "source ids are new"
        );
        // 2026-09-20 오너 결정("수집 소스는 꺼진 채로 복사"): 원본에서 켜져 있던 두 소스도, 이미
        // 꺼져 있던 한 소스도 사본에서는 전부 enabled=false.
        assert!(
            copied_sources.iter().all(|(.., enabled)| !enabled),
            "every copied source is disabled regardless of the original's enabled state: {copied_sources:?}"
        );
        let new_folder_id: String = conn.query_row("SELECT id FROM folders WHERE workspace_id=?1", [&copy], |r| r.get(0)).unwrap();
        let with_folder = copied_sources.iter().find(|(_, tfid, ..)| tfid.is_some()).expect("one source keeps a target folder");
        assert_eq!(with_folder.1.as_deref(), Some(new_folder_id.as_str()), "target_folder_id remapped to the copy's folder");
        assert_eq!(with_folder.2, None, "last_status not copied — this copy never ran");
        assert_eq!(with_folder.3, None, "last_error not copied — copying it would lie about a run that never happened");

        let copied_seen: i64 = conn
            .query_row("SELECT COUNT(*) FROM collect_seen WHERE source_id=?1", [&with_folder.0], |r| r.get(0))
            .unwrap();
        assert_eq!(copied_seen, 2, "collect_seen carried so the copy doesn't re-collect items already seen");

        // --- 원본은 그대로 (개수 + 내용, enabled 포함) ---
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pet_sessions WHERE workspace_id=?1", [&ws], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pet_messages WHERE workspace_id=?1", [&ws], |r| r.get::<_, i64>(0)).unwrap(), 3);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM collect_sources WHERE workspace_id=?1", [&ws], |r| r.get::<_, i64>(0)).unwrap(), 3);
        assert_eq!(
            conn.query_row("SELECT last_error FROM collect_sources WHERE id=?1", [&source_with_folder], |r| r.get::<_, Option<String>>(0))
                .unwrap(),
            Some("boom".to_string()),
            "original last_error untouched"
        );
        assert_eq!(
            conn.query_row("SELECT target_folder_id FROM collect_sources WHERE id=?1", [&source_with_folder], |r| r
                .get::<_, Option<String>>(0))
                .unwrap(),
            Some(folder.clone()),
            "original target_folder_id untouched"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM collect_seen WHERE source_id=?1", [&source_with_folder], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let enabled_of = |c: &Connection, id: &str| -> bool {
            c.query_row("SELECT enabled FROM collect_sources WHERE id=?1", [id], |r| r.get::<_, i64>(0)).unwrap() != 0
        };
        assert!(enabled_of(&conn, &source_with_folder), "original stays enabled");
        assert!(enabled_of(&conn, &source_plain), "original stays enabled");
        assert!(!enabled_of(&conn, &source_disabled), "already-disabled original stays disabled");
        let original_text: String = conn
            .query_row("SELECT text FROM pet_messages WHERE workspace_id=?1 AND role='assistant'", [&ws], |r| r.get(0))
            .unwrap();
        assert_eq!(original_text, assistant_text, "original message text untouched");

        // --- 내보내기 번들에는 안 실린다 (Bundle 파일 포맷 — 파일을 건네받는 사람에게 AI 대화가 몰래 안 실린다) ---
        // note_snapshots 도 같은 이유로 확인한다 — Bundle 구조체 자체에 필드가 없으므로(extras.rs
        // 헤더 주석에서 직접 확인) 이 스냅샷은 애초에 export 경로에 실릴 수 없지만, 위에서 실제로
        // note_a 에 스냅샷을 심어 두었으니 이 assert 가 공허하게 참이 되지 않는다.
        let dest = tempfile::tempdir().unwrap();
        let exp = export_workspace_bundle(&conn, data_dir.path(), &ws, dest.path()).unwrap();
        let bundle_json = std::fs::read_to_string(&exp.bundle_path).unwrap();
        for forbidden in [
            "pet_sessions",
            "pet_messages",
            "collect_sources",
            "collect_seen",
            "pet_session",
            "collect_source",
            "note_snapshots",
            "note_snapshot",
        ] {
            assert!(!bundle_json.contains(forbidden), "exported bundle file must not carry {forbidden}");
        }
    }

    /// 오너 결정(2026-09-20): "스냅샷도 복제에 포함해줘". 이 테스트는 프로덕션 코드를 고치기
    /// **전에** 먼저 작성해 실패를 확인한다(지금 duplicate_notebook 은 note_snapshots 를 전혀
    /// 옮기지 않는다).
    ///
    /// note_a 에 스냅샷 2개(그중 하나의 payload 에 note_a 자신의 section_id + note://note_a
    /// 위키링크를 담아 remap 이 실제로 동작하는지 확인) + 휴지통에 넣은 별도 노트에 스냅샷 1개
    /// (복제에서 제외돼야 함 — 소프트삭제 노트는 dump_workspace 가 애초에 안 담아 note_map 에
    /// 없다)를 갖춘 노트북을 복제해, 사본에 정확히 2건만 나타나는지·id 가 새로 발급됐는지·
    /// note_id 가 사본의 노트를 가리키는지·payload 안 section_id/note:// 링크가 remap 됐는지·
    /// 원본은 그대로인지 확인한다.
    #[test]
    fn duplicate_notebook_copies_note_snapshots() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, folder, note_a) = seed_notebook_bundle_source(&mut conn);

        let section_id: String = conn
            .query_row("SELECT id FROM sections WHERE note_id=?1", [&note_a], |r| r.get(0))
            .unwrap();
        let make_payload = |body: &str| {
            serde_json::to_string(&vec![crate::repo::snapshots::PayloadSection {
                section_id: section_id.clone(),
                title: "Body".into(),
                kind: "text".into(),
                body_md: body.to_string(),
            }])
            .unwrap()
        };

        let now = crate::util::now_iso();
        let now2 = (chrono::Utc::now() + chrono::Duration::minutes(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let snap1 = new_id();
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES (?1,?2,?3,?4)",
            params![snap1, note_a, now, make_payload(&format!("본문 [Sejong](note://{note_a})"))],
        )
        .unwrap();
        let snap2 = new_id();
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES (?1,?2,?3,?4)",
            params![snap2, note_a, now2, make_payload("두번째 스냅샷")],
        )
        .unwrap();

        // 휴지통 노트의 스냅샷 — 복제에서 제외돼야 한다.
        let trashed_note = new_id();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, year, is_favorite, created_at, updated_at)
             VALUES (?1,?2,'Trashed',1443,0,?3,?3)",
            params![trashed_note, folder, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_snapshots(id, note_id, taken_at, payload) VALUES (?1,?2,?3,'[]')",
            params![new_id(), trashed_note, now],
        )
        .unwrap();
        crate::repo::notes::delete(&mut conn, &trashed_note).unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("file.txt"), b"x").unwrap();

        let copy = super::super::duplicate_notebook(&mut conn, data_dir.path(), &ws, "History Lab 사본").unwrap();

        let new_note_id: String = conn
            .query_row(
                "SELECT n.id FROM notes n JOIN folders f ON f.id=n.folder_id WHERE f.workspace_id=?1 AND n.title='Sejong'",
                [&copy],
                |r| r.get(0),
            )
            .unwrap();
        let new_section_id: String = conn
            .query_row("SELECT id FROM sections WHERE note_id=?1", [&new_note_id], |r| r.get(0))
            .unwrap();

        let copied: Vec<(String, String, String, String)> = conn
            .prepare("SELECT id, note_id, taken_at, payload FROM note_snapshots WHERE note_id=?1 ORDER BY taken_at")
            .unwrap()
            .query_map([&new_note_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(copied.len(), 2, "both of note_a's snapshots must be copied, trashed note's snapshot excluded");
        assert!(copied.iter().all(|(id, ..)| *id != snap1 && *id != snap2), "snapshot ids are new");
        assert!(copied.iter().all(|(_, nid, ..)| nid == &new_note_id), "note_id points at the copy's note");
        assert_eq!(copied[0].2, now, "timestamps travel verbatim");
        assert_eq!(copied[1].2, now2, "timestamps travel verbatim");

        let parsed0: Vec<crate::repo::snapshots::PayloadSection> = serde_json::from_str(&copied[0].3).unwrap();
        assert_eq!(parsed0[0].section_id, new_section_id, "payload section_id remapped to the copy's section");
        assert!(
            parsed0[0].body_md.contains(&format!("note://{new_note_id}")),
            "note:// link in payload rewritten: {}",
            parsed0[0].body_md
        );
        assert!(!parsed0[0].body_md.contains(&note_a), "old note id must not survive in payload");

        // 휴지통 노트의 스냅샷은 사본 어디에도 없다 — 원본 1건만 남는다.
        let trashed_snapshot_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_snapshots WHERE payload='[]'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(trashed_snapshot_count, 1, "trashed note's snapshot must not be duplicated");

        // 원본은 그대로.
        let original_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_snapshots WHERE note_id=?1", [&note_a], |r| r.get(0))
            .unwrap();
        assert_eq!(original_count, 2, "original note's snapshots untouched");
    }

    /// 트랜잭션이 정말 하나인지(반쪽짜리 노트북이 안 남는지)를 값싸게 강제로 확인한다: 손상된
    /// extras(두 CollectSourceRow 가 같은 원본 id 를 공유 — remap_notebook_extras 의 source_map
    /// 이 같은 새 id 로 접어버려 두 번째 INSERT 가 PRIMARY KEY 충돌로 실패)를 넘겨 삽입 도중
    /// 실패를 강제하고, 이미 그 앞에서 삽입됐을 workspaces/notes 행까지 전부 롤백됐는지 본다.
    #[test]
    fn import_add_notebook_with_extras_rolls_back_everything_on_a_forced_extras_failure() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let (ws, _, _) = seed_notebook_bundle_source(&mut conn);
        let data_dir = tempfile::tempdir().unwrap();
        let att = db::attachments_dir(data_dir.path());
        std::fs::create_dir_all(&att).unwrap();
        std::fs::write(att.join("file.txt"), b"x").unwrap();

        let bundle = crate::repo::transfer::export::dump_workspace(&conn, &ws).unwrap();
        let now = crate::util::now_iso();
        let dup_id = new_id();
        let make_source = |name: &str| super::super::extras::CollectSourceRow {
            id: dup_id.clone(),
            workspace_id: ws.clone(),
            kind: "rss".to_string(),
            name: name.to_string(),
            config: "{}".to_string(),
            enabled: true,
            dry_run: false,
            show_in_briefing: true,
            target_folder_id: None,
            post_process: "none".to_string(),
            post_process_model: None,
            interval_minutes: None,
            last_run_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let corrupted_extras = super::super::extras::NotebookExtras {
            pet_sessions: Vec::new(),
            pet_messages: Vec::new(),
            collect_sources: vec![make_source("A"), make_source("B")],
            collect_seen: Vec::new(),
            note_snapshots: Vec::new(),
        };

        let before_ws: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0)).unwrap();
        let before_notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();

        import_add_notebook_with_extras(&mut conn, data_dir.path(), &bundle, &att, &att, &corrupted_extras)
            .expect_err("duplicate collect_sources.id inside one extras payload must fail the PRIMARY KEY constraint");

        let after_ws: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0)).unwrap();
        let after_notes: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(after_ws, before_ws, "extras 실패는 새로 삽입된 노트북 행까지 함께 롤백해야 한다 — 반쪽짜리 노트북 금지");
        assert_eq!(after_notes, before_notes, "extras 실패는 새로 삽입된 노트들도 함께 롤백해야 한다");
        let leaked: i64 = conn
            .query_row("SELECT COUNT(*) FROM collect_sources WHERE name IN ('A','B')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leaked, 0, "실패한 extras 삽입 자체도 아무것도 남지 않아야 한다");
    }
}
