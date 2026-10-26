// repo::transfer::import::extras — 노트북 복제(duplicate_notebook) 전용 "비공개 부속":
// 펫 대화(pet_sessions/pet_messages)·수집 소스(collect_sources/collect_seen)·에디터 자동저장
// 스냅샷(note_snapshots). 2026-09-20 오너 결정("펫 대화·수집 소스도 복제에 포함해줘" +
// "스냅샷도 복제에 포함해줘").
//
// 이 다섯 테이블은 Bundle(bundle.rs, export가 만드는 brise-bundle.json 포맷)에 **절대** 싣지
// 않는다 — 노트북 내보내기는 다른 사람에게 건네는 파일이고, AI 대화 이력이 몰래 실려 나가면
// 안 되기 때문이다(오너 스코프 결정: 복제에만 포함, 내보내기는 지금 그대로). note_snapshots는
// 애초에 device-local 에디터 캐시라는 별도 이유로도 export 대상이 아니다(repo/snapshots.rs
// 헤더 주석, db/migrations.rs V31_SQL 주석 — "export_all/export_folder_bundle 에서 제외"가 이미
// 확정된 설계). 그래서 export.rs의 dump_folder/dump_workspace/dump 세 진입점 중 어디도 이 파일을
// 참조하지 않는다 — Bundle 구조체 자체에 필드를 추가하지 않았으므로 "export 바이트가 그대로"는
// 타입으로 보장된다(bundle.rs 헤더 주석이 경고하는, 새 필드를 세 export 진입점 중 하나에서만
// 빠뜨리는 사고 자체가 여기선 구조적으로 일어날 수 없다).
//
// duplicate_notebook 은 파일을 거치지 않고 DB→DB로 바로 옮기는 유일한 경로라, 여기서 별도로
// 읽어 add_notebook::import_add_notebook_with_extras 가 **id 재매핑과 같은 트랜잭션** 안에서
// 삽입한다(절반만 복제된 노트북이 남지 않도록 — 커밋 시점이 하나뿐이라 실패하면 전부 롤백된다).
//
// 대상 5테이블 최종 컬럼(db/migrations.rs, ALTER 로 늘어난 것까지):
// - pet_sessions(V47): id, workspace_id, title, created_at, closed_at, message_count
// - pet_messages(V35 + V46 meta + V47 session_id): id, workspace_id, role, text, created_at, meta, session_id
// - collect_sources(V40 + V60 컬럼 5개): id, workspace_id, kind, name, config, enabled, dry_run,
//   target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, last_status,
//   last_error, created_at, updated_at
// - collect_seen(V40): source_id, guid (복합 PK, workspace_id 컬럼 없음 — collect_sources 를 거쳐 좁힌다)
// - note_snapshots(V31, ALTER 없이 그대로): id, note_id, taken_at, payload (workspace_id 컬럼
//   없음 — notes→folders 를 거쳐 좁힌다. payload 는 PayloadSection{section_id,title,kind,body_md}
//   JSON 배열, repo/snapshots.rs)
//
// 첨부파일 참조: **있다.** payload 의 body_md 는 섹션 본문의 과거 사본이고, 본문은 인라인 이미지를
// `![alt]({note_id}/{stored_name}){width=…}` — 첨부의 rel_path 를 글자 그대로 — 적는다
// (src/components/editor/imageExtension.ts). 이 파일의 첫 판은 "본문에서 스캔·치환되는 것은 note://
// 뿐"이라는 관찰에서 "참조가 없다"고 결론 냈는데, 그 관찰 자체가 버그였다: add_notebook 이 섹션
// 본문에서도 이 경로를 안 고치고 있었다(사본의 이미지가 원본 노트의 파일을 가리킴). 지금은
// super::rewrite_attachment_rel_paths 가 섹션 본문과 스냅샷 payload 양쪽을 같은 rel_map(이번
// 복제에서 첨부 행이 실제로 옮겨 간 경로)으로 고친다 — 스냅샷을 복원해도 사본 자신의 파일이다.
use crate::error::{db as dberr, AppResult};
use crate::repo::snapshots::PayloadSection;
use crate::util::new_id;
use rusqlite::{params, Connection};
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub(super) struct NotebookExtras {
    pub(super) pet_sessions: Vec<PetSessionRow>,
    pub(super) pet_messages: Vec<PetMessageRow>,
    pub(super) collect_sources: Vec<CollectSourceRow>,
    pub(super) collect_seen: Vec<CollectSeenRow>,
    pub(super) note_snapshots: Vec<NoteSnapshotRow>,
}

#[derive(Debug, Clone)]
pub(super) struct PetSessionRow {
    pub(super) id: String,
    pub(super) workspace_id: String,
    pub(super) title: String,
    pub(super) created_at: String,
    pub(super) closed_at: Option<String>,
    pub(super) message_count: i64,
}

#[derive(Debug, Clone)]
pub(super) struct PetMessageRow {
    pub(super) id: String,
    pub(super) workspace_id: String,
    pub(super) role: String,
    pub(super) text: String,
    pub(super) created_at: String,
    pub(super) meta: Option<String>,
    pub(super) session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct CollectSourceRow {
    pub(super) id: String,
    pub(super) workspace_id: String,
    pub(super) kind: String,
    pub(super) name: String,
    pub(super) config: String,
    pub(super) enabled: bool,
    pub(super) dry_run: bool,
    pub(super) show_in_briefing: bool,
    pub(super) target_folder_id: Option<String>,
    pub(super) post_process: String,
    pub(super) post_process_model: Option<String>,
    pub(super) interval_minutes: Option<i64>,
    pub(super) last_run_at: Option<String>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(Debug, Clone)]
pub(super) struct CollectSeenRow {
    pub(super) source_id: String,
    pub(super) guid: String,
}

#[derive(Debug, Clone)]
pub(super) struct NoteSnapshotRow {
    pub(super) id: String,
    pub(super) note_id: String,
    pub(super) taken_at: String,
    pub(super) payload: String,
}

/// 이 노트북(workspace_id) 소유의 펫 대화·수집 소스를 통째로 읽는다. export.rs 의 dump_folder/
/// dump_workspace/dump 중 어디에서도 불리지 않는다 — duplicate_notebook 하나만 이 함수를 부른다.
pub(super) fn dump_notebook_extras(conn: &Connection, workspace_id: &str) -> AppResult<NotebookExtras> {
    let pet_sessions = conn
        .prepare("SELECT id, workspace_id, title, created_at, closed_at, message_count FROM pet_sessions WHERE workspace_id=?1")
        .map_err(dberr)?
        .query_map(params![workspace_id], |r| {
            Ok(PetSessionRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                title: r.get(2)?,
                created_at: r.get(3)?,
                closed_at: r.get(4)?,
                message_count: r.get(5)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;

    let pet_messages = conn
        .prepare("SELECT id, workspace_id, role, text, created_at, meta, session_id FROM pet_messages WHERE workspace_id=?1")
        .map_err(dberr)?
        .query_map(params![workspace_id], |r| {
            Ok(PetMessageRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                role: r.get(2)?,
                text: r.get(3)?,
                created_at: r.get(4)?,
                meta: r.get(5)?,
                session_id: r.get(6)?,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;

    let collect_sources = conn
        .prepare(
            "SELECT id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, created_at, updated_at, show_in_briefing
             FROM collect_sources WHERE workspace_id=?1",
        )
        .map_err(dberr)?
        .query_map(params![workspace_id], |r| {
            Ok(CollectSourceRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                kind: r.get(2)?,
                name: r.get(3)?,
                config: r.get(4)?,
                enabled: r.get::<_, i64>(5)? != 0,
                dry_run: r.get::<_, i64>(6)? != 0,
                target_folder_id: r.get(7)?,
                post_process: r.get(8)?,
                post_process_model: r.get(9)?,
                interval_minutes: r.get(10)?,
                last_run_at: r.get(11)?,
                created_at: r.get(12)?,
                updated_at: r.get(13)?,
                show_in_briefing: r.get::<_, i64>(14)? != 0,
            })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;

    // collect_seen 은 workspace_id 컬럼이 없다 — collect_sources 를 거쳐 이 노트북 소유 source_id 로 좁힌다.
    let collect_seen = conn
        .prepare(
            "SELECT cs.source_id, cs.guid FROM collect_seen cs
             JOIN collect_sources s ON s.id = cs.source_id
             WHERE s.workspace_id=?1",
        )
        .map_err(dberr)?
        .query_map(params![workspace_id], |r| Ok(CollectSeenRow { source_id: r.get(0)?, guid: r.get(1)? }))
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;

    // note_snapshots 도 workspace_id 컬럼이 없다 — notes→folders 를 거쳐 좁힌다. deleted_at IS NULL
    // 은 export.rs::dump_workspace 의 노트 SELECT 와 같은 스코프 규칙(휴지통 노트는 이 노트북에
    // "속하지 않는다") — 여기서 걸러도 아래 remap_notebook_extras 가 note_map 기준으로 한 번 더
    // 걸러 방어선을 이중으로 둔다(휴지통 노트는 애초에 note_map 에 없다).
    let note_snapshots = conn
        .prepare(
            "SELECT ns.id, ns.note_id, ns.taken_at, ns.payload FROM note_snapshots ns
             JOIN notes n ON n.id = ns.note_id
             JOIN folders f ON f.id = n.folder_id
             WHERE f.workspace_id=?1 AND n.deleted_at IS NULL",
        )
        .map_err(dberr)?
        .query_map(params![workspace_id], |r| {
            Ok(NoteSnapshotRow { id: r.get(0)?, note_id: r.get(1)?, taken_at: r.get(2)?, payload: r.get(3)? })
        })
        .map_err(dberr)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(dberr)?;

    Ok(NotebookExtras { pet_sessions, pet_messages, collect_sources, collect_seen, note_snapshots })
}

/// pet_messages.meta(JSON, repo::pet::assistant_message_meta 계약) 안 note_id/hits[].note_id 를
/// note_map 으로 정확히 다시 쓴다. 섹션 본문·펫 대화 원문의 note://<id> 자유텍스트 치환
/// (super::rewrite_note_links)과 이 함수를 하나로 합치지 않는다 — meta 는 앱이 만드는 구조화
/// JSON(고정 키)이고 body_md/펫 메시지 text 는 사용자가 쓰는 자유 텍스트(위키링크 문법)라
/// 페이로드 모양 자체가 다르다: 텍스트 치환을 JSON 문자열 전체에 걸면 note_id 가 다른 필드 값의
/// 부분 문자열로 우연히 나타났을 때도 건드릴 위험이 있어, 여기서는 알려진 필드만 정확히 짚어
/// 고친다. 파싱 실패나 예상 밖 모양이면 원본 그대로 둔다(meta 는 보조 정보라 파싱 실패로 메시지
/// 자체를 잃을 이유가 없다 — normalize_pet_message_meta 가 저장 시 이미 검증했으므로 정상 경로는
/// 항상 유효한 JSON 객체이지만, 방어적으로 폴백을 둔다).
fn remap_pet_message_meta_note_ids(raw: &str, note_map: &HashMap<String, String>) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return raw.to_string();
    };
    if let Some(nid) = obj.get("note_id").and_then(|v| v.as_str()).map(str::to_string) {
        if let Some(new_nid) = note_map.get(&nid) {
            obj.insert("note_id".to_string(), serde_json::Value::String(new_nid.clone()));
        }
    }
    if let Some(serde_json::Value::Array(hits)) = obj.get_mut("hits") {
        for hit in hits.iter_mut() {
            let Some(hobj) = hit.as_object_mut() else { continue };
            if let Some(nid) = hobj.get("note_id").and_then(|v| v.as_str()).map(str::to_string) {
                if let Some(new_nid) = note_map.get(&nid) {
                    hobj.insert("note_id".to_string(), serde_json::Value::String(new_nid.clone()));
                }
            }
        }
    }
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

/// note_snapshots.payload(JSON 배열, PayloadSection{section_id,title,kind,body_md} — repo/
/// snapshots.rs 가 이미 정의해 둔 타입을 그대로 재사용한다, 손으로 필드를 다시 정의하지 않는다)
/// 안 section_id 를 section_map 으로, body_md 안 note://<id> 위키링크를 note_map 으로 다시 쓴다.
/// remap_pet_message_meta_note_ids 와 같은 이유로 알려진 필드만 정확히 짚어 고친다 — 파싱
/// 실패나 예상 밖 모양이면 원본 그대로 둔다(스냅샷은 에디터 자동저장 캐시라, 파싱 실패로 통째로
/// 잃기보다 remap 없이라도 남기는 쪽이 낫다).
fn remap_snapshot_payload(
    raw: &str,
    section_map: &HashMap<String, String>,
    note_map: &HashMap<String, String>,
    rel_map: &HashMap<String, String>,
) -> String {
    let Ok(sections) = serde_json::from_str::<Vec<PayloadSection>>(raw) else {
        return raw.to_string();
    };
    let remapped: Vec<PayloadSection> = sections
        .into_iter()
        .map(|s| PayloadSection {
            section_id: section_map.get(&s.section_id).cloned().unwrap_or(s.section_id),
            title: s.title,
            kind: s.kind,
            // 섹션 본문과 **같은 두 치환**을 같은 순서로 — 스냅샷은 그 본문의 과거 사본이라 인라인
            // 이미지 경로도 똑같이 품고 있다(복원하면 그대로 본문이 된다).
            body_md: super::rewrite_attachment_rel_paths(&super::rewrite_note_links(&s.body_md, note_map), rel_map),
        })
        .collect();
    serde_json::to_string(&remapped).unwrap_or_else(|_| raw.to_string())
}

/// extras 안의 id 를 add_notebook 의 id 매핑(ws_map/folder_map/note_map/section_map — remap_bundle_ids
/// 가 만든 것과 정확히 같은 맵)으로 다시 쓴다. pet_sessions/pet_messages/collect_sources/
/// note_snapshots 자신의 id 는 여기서 새로 발급한다(add_notebook 의 맵에는 없는, 이 extras 안에서만
/// 쓰이는 로컬 매핑).
pub(super) fn remap_notebook_extras(
    extras: &NotebookExtras,
    ws_map: &HashMap<String, String>,
    folder_map: &HashMap<String, String>,
    note_map: &HashMap<String, String>,
    section_map: &HashMap<String, String>,
    rel_map: &HashMap<String, String>,
) -> NotebookExtras {
    let mut session_map: HashMap<String, String> = HashMap::new();
    for s in &extras.pet_sessions {
        session_map.insert(s.id.clone(), new_id());
    }
    let mut source_map: HashMap<String, String> = HashMap::new();
    for s in &extras.collect_sources {
        source_map.insert(s.id.clone(), new_id());
    }
    let map_or = |m: &HashMap<String, String>, id: &str| m.get(id).cloned().unwrap_or_else(|| id.to_string());

    let pet_messages: Vec<PetMessageRow> = extras
        .pet_messages
        .iter()
        .map(|m| PetMessageRow {
            id: new_id(),
            workspace_id: map_or(ws_map, &m.workspace_id),
            role: m.role.clone(),
            // 방어적: 펫 채팅창은 자유 텍스트 입력이라 앱이 note:// 링크를 직접 삽입하지는 않지만
            // (프런트에서 note:// 삽입은 노트 본문 에디터의 위키링크 전용), 노트 본문에서 복사해
            // 붙여넣으면 그대로 들어올 수 있다 — 섹션 본문과 같은 치환 규칙을 적용한다.
            text: super::rewrite_note_links(&m.text, note_map),
            created_at: m.created_at.clone(),
            meta: m.meta.as_deref().map(|raw| remap_pet_message_meta_note_ids(raw, note_map)),
            // session_id 가 이 extras 의 session_map 에 없으면(있을 수 없는 경우다 — 메시지는
            // 항상 자기 노트북의 세션을 가리킨다) target_folder_id 와 같은 이유로 None 을 넣는다:
            // 원본 노트북의 남 세션 id 를 사본에 그대로 흘려보내느니 라이브 세션 없음으로 둔다
            // (pet::live_session_id 가 없으면 다음 메시지 때 자연히 새 라이브 세션을 만든다).
            session_id: m.session_id.as_ref().and_then(|sid| session_map.get(sid).cloned()),
        })
        .collect();

    // message_count 는 방금 만든 pet_messages 에서 직접 센다(원본 컬럼을 그대로 믿지 않는다) —
    // 원본이 어떤 이유로든 드리프트돼 있어도 복제본은 항상 스스로 정합적이다.
    let mut counts: HashMap<String, i64> = HashMap::new();
    for m in &pet_messages {
        if let Some(sid) = &m.session_id {
            *counts.entry(sid.clone()).or_insert(0) += 1;
        }
    }
    let pet_sessions: Vec<PetSessionRow> = extras
        .pet_sessions
        .iter()
        .map(|s| {
            let new_sid = map_or(&session_map, &s.id);
            let message_count = *counts.get(&new_sid).unwrap_or(&0);
            PetSessionRow {
                id: new_sid,
                workspace_id: map_or(ws_map, &s.workspace_id),
                title: s.title.clone(),
                created_at: s.created_at.clone(),
                // 열린 세션은 열린 채로 둔다 — 세션은 workspace_id 스코프라(repo::pet::live_session_id
                // 가 workspace_id 로 걸러 찾는다) 원본과 사본이 각자 독립된 라이브 세션을 가져도
                // 서로 충돌하지 않는다.
                closed_at: s.closed_at.clone(),
                message_count,
            }
        })
        .collect();

    let collect_sources: Vec<CollectSourceRow> = extras
        .collect_sources
        .iter()
        .map(|s| CollectSourceRow {
            id: map_or(&source_map, &s.id),
            workspace_id: map_or(ws_map, &s.workspace_id),
            kind: s.kind.clone(),
            name: s.name.clone(),
            // config(JSON) 안에는 다른 행을 가리키는 id 가 없다 — collect::config 의 kind 별 스키마
            // (RssConfig/ClaudePromptsConfig/CodexPromptsConfig/WebConfig/YoutubeConfig/
            // BrowserHistoryConfig, 전부 #[serde(deny_unknown_fields)])는 url/dir/project/prompt/
            // browser/profile/backfill_days/min_seconds 류만 갖고 folder/note/tag id 를 담지
            // 않는다(직접 확인, src-tauri/src/collect/config.rs) — 그대로 복사해도 원본 노트북을
            // 침범하지 않는다. 실제로 다른 행을 가리키는 것은 컬럼으로 승격된 target_folder_id 뿐
            // (V60, 바로 아래).
            config: s.config.clone(),
            // 2026-09-20 오너 결정("수집 소스는 꺼진 채로 복사"): 원본이 켜져 있었든 꺼져 있었든
            // 사본은 항상 enabled=false 로 시작한다 — 조용히 백그라운드에서 같은 피드를 다시
            // 수집하기 시작하면 네트워크 요청이 두 배가 되고, 사용자가 아직 열어보지도 않은
            // 노트북을 채운다. 원하는 소스는 사용자가 나중에 직접 켠다(collect::find_due 가
            // `WHERE enabled = 1` 로 걸러 꺼진 소스는 애초에 스케줄러 눈에 띄지 않는다).
            enabled: false,
            dry_run: s.dry_run,
            show_in_briefing: s.show_in_briefing,
            // 폴더는 이 노트북(workspace_id) 소유일 때만 유효하다(collect::mod::resolve_target_folder_id
            // 가 실행마다 workspace_id 로 재확인 후 아니면 인박스로 폴백) — folder_map 에 없으면
            // (있을 수 없는 경우지만) 원본의 남 노트북 폴더 id 를 사본에 그대로 들려 보내느니
            // None 으로 비워 같은 폴백 규칙(인박스)에 맡긴다.
            target_folder_id: s.target_folder_id.as_ref().and_then(|fid| folder_map.get(fid).cloned()),
            post_process: s.post_process.clone(),
            post_process_model: s.post_process_model.clone(),
            interval_minutes: s.interval_minutes,
            // 실행 이력 3종(last_run_at/last_status/last_error) 결정:
            // - last_run_at 은 그대로 복사한다. **재검토(2026-09-20, enabled=false 도입 이후)**:
            //   이 값을 그대로 두는 원래 이유("복제 직후 모든 소스가 일제히 재실행되는 걸 막는다")는
            //   이제 성립하지 않는다 — collect::find_due 가 `WHERE enabled = 1` 로 걸러 꺼진
            //   소스는 last_run_at 값과 무관하게 애초에 스케줄러 눈에 띄지 않으니 "재실행 폭주"
            //   자체가 일어날 수 없다. 그래도 그대로 두기로 한다: 다른 시각 컬럼(created_at/
            //   updated_at)과 같은 원칙("타임스탬프는 그대로")을 따를 뿐 아니라, 사용자가 나중에
            //   이 소스를 직접 켰을 때 "마지막으로 실제 돈 시점"이라는 사실 정보를 유지해야
            //   is_due/`since` 판단(CollectCtx.since = last_run_at)이 원본 기준 최신성을 그대로
            //   반영한다 — NULL 로 비워도(=한 번도 안 돎) 켜는 즉시 도래 판정되는 건 똑같지만,
            //   NULL 은 "이 소스가 실제로 한 번도 실행된 적 없다"는 거짓 신호가 된다. collect_seen
            //   을 함께 옮기므로 켠 뒤 재실행돼도 이미 본 항목은 다시 수집하지 않는다(아래).
            // - last_status/last_error 는 NULL 로 비운다 — 이 복제본은 실제로 한 번도 실행된 적이
            //   없으므로 "ok"/"error"/"partial" 어느 것도 사본의 사실이 아니다. last_error 를 그대로
            //   옮기면 실행조차 안 한 소스가 실패했다고 거짓말하는 꼴이다. is_due 의 partial 특례는
            //   last_status 로만 판정하므로(== Some("partial")) None 이면 자연히 일반 interval
            //   경로를 탄다 — 스케줄 판정이 깨지지 않는다.
            last_run_at: s.last_run_at.clone(),
            created_at: s.created_at.clone(),
            updated_at: s.updated_at.clone(),
        })
        .collect();

    // 소스가 remap 되지 않은(=이 extras 에 없는) source_id 를 가리키는 collect_seen 행은 있을 수
    // 없다(항상 같은 workspace_id 스캔으로 함께 모았다) — filter_map 은 방어적 가드일 뿐이다.
    let collect_seen: Vec<CollectSeenRow> = extras
        .collect_seen
        .iter()
        .filter_map(|row| source_map.get(&row.source_id).map(|new_sid| CollectSeenRow { source_id: new_sid.clone(), guid: row.guid.clone() }))
        .collect();

    // note_id 가 note_map 에 없는 스냅샷(=휴지통 노트)은 여기서 드롭한다 — dump_notebook_extras 가
    // 이미 deleted_at IS NULL 로 걸렀으므로 정상 경로에선 항상 있어야 하지만(방어적 가드,
    // collect_seen 의 source_map 필터와 같은 이유), 이 filter_map 이 실제 "노트북에 없는 노트를
    // 가리키는 스냅샷은 안 옮긴다"는 불변식을 강제하는 지점이다.
    let note_snapshots: Vec<NoteSnapshotRow> = extras
        .note_snapshots
        .iter()
        .filter_map(|s| {
            let new_note_id = note_map.get(&s.note_id)?.clone();
            Some(NoteSnapshotRow {
                id: new_id(),
                note_id: new_note_id,
                taken_at: s.taken_at.clone(),
                payload: remap_snapshot_payload(&s.payload, section_map, note_map, rel_map),
            })
        })
        .collect();

    NotebookExtras { pet_sessions, pet_messages, collect_sources, collect_seen, note_snapshots }
}

/// remap_notebook_extras 가 만든 행을 그대로 넣는다. 세션→메시지, 소스→seen 순서로 넣어(FK 는
/// 걸려있지 않지만) 읽는 사람이 참조 방향을 좇기 쉽게 한다. 호출자(add_notebook.rs)가 이미 연
/// 트랜잭션 위에서 부른다 — 여기서 커밋/롤백을 하지 않는다.
pub(super) fn insert_notebook_extras(tx: &rusqlite::Transaction, extras: &NotebookExtras) -> AppResult<()> {
    for s in &extras.pet_sessions {
        tx.execute(
            "INSERT INTO pet_sessions (id, workspace_id, title, created_at, closed_at, message_count) VALUES (?1,?2,?3,?4,?5,?6)",
            params![s.id, s.workspace_id, s.title, s.created_at, s.closed_at, s.message_count],
        )
        .map_err(dberr)?;
    }
    for m in &extras.pet_messages {
        tx.execute(
            "INSERT INTO pet_messages (id, workspace_id, role, text, created_at, meta, session_id) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![m.id, m.workspace_id, m.role, m.text, m.created_at, m.meta, m.session_id],
        )
        .map_err(dberr)?;
    }
    for s in &extras.collect_sources {
        tx.execute(
            "INSERT INTO collect_sources (id, workspace_id, kind, name, config, enabled, dry_run, target_folder_id, post_process, post_process_model, interval_minutes, last_run_at, created_at, updated_at, show_in_briefing)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                s.id,
                s.workspace_id,
                s.kind,
                s.name,
                s.config,
                s.enabled as i64,
                s.dry_run as i64,
                s.target_folder_id,
                s.post_process,
                s.post_process_model,
                s.interval_minutes,
                s.last_run_at,
                s.created_at,
                s.updated_at,
                s.show_in_briefing as i64,
            ],
        )
        .map_err(dberr)?;
    }
    for r in &extras.collect_seen {
        tx.execute("INSERT INTO collect_seen (source_id, guid) VALUES (?1,?2)", params![r.source_id, r.guid])
            .map_err(dberr)?;
    }
    for s in &extras.note_snapshots {
        tx.execute(
            "INSERT INTO note_snapshots (id, note_id, taken_at, payload) VALUES (?1,?2,?3,?4)",
            params![s.id, s.note_id, s.taken_at, s.payload],
        )
        .map_err(dberr)?;
    }
    Ok(())
}
