// 불변성: export_all -> import_bundle(replace) 왕복은 데이터를 보존한다.
// specs/tests/invariant-export-roundtrip.yaml 1:1
mod common;
use brise_lib::error::AppError;
use brise_lib::repo::{attachments, notes, search, sections, sources, taxonomy, transfer};
use std::fs;

fn seed(ctx: &mut common::Ctx) {
    // Wave 14: 사용자 추가 지역/시대도 번들 왕복에서 보존돼야 한다(태그와 같은 급의 사용자
    // 콘텐츠로 취급 — export.rs Bundle 주석 참조).
    taxonomy::add_region(&mut ctx.conn, None, "Sokcho").unwrap();
    taxonomy::add_era(&mut ctx.conn, None, "Custom Era", 1400, 1500).unwrap();
    // Wave 15: 사용자 추가 노트 상태도 사용자 콘텐츠라 번들 왕복에서 보존돼야 한다.
    let custom_status = taxonomy::add_status(&mut ctx.conn, None, "Relecture").unwrap();
    let f2 = brise_lib::repo::folders::create(&mut ctx.conn, "Era2", None, None, None, None).unwrap();
    // Wave 11: 폴더 아이콘 색상도 번들 왕복에서 보존돼야 한다.
    brise_lib::repo::folders::set_color(&mut ctx.conn, &f2.id, Some(200)).unwrap();
    let d = notes::create(&mut ctx.conn, &f2.id, Some("Sejong".into()), Some(1443)).unwrap();
    let sid = d.sections[0].id.clone();
    sections::update(&mut ctx.conn, &sid, None, Some("## Over\n\n자세한 본문\n".into()), None).unwrap();
    sections::create(&mut ctx.conn, &d.note.id, Some("Timeline".into())).unwrap();
    sources::add_text(&mut ctx.conn, &d.note.id, "원문.txt", "훈민정음 서문 본문").unwrap();
    notes::set_tags(&mut ctx.conn, &d.note.id, vec!["Hangul".into(), "Sejong".into()]).unwrap();
    // Wave 12: 노트 지역(region)도 번들 왕복에서 보존돼야 한다.
    notes::set_region(&mut ctx.conn, &d.note.id, Some("Hanseong".into())).unwrap();
    // Wave 15: 노트 상태(status, 커스텀 상태 id)도 번들 왕복에서 보존돼야 한다.
    notes::set_status(&mut ctx.conn, &d.note.id, Some(custom_status.id.clone())).unwrap();
    // §2.3: 사건 축 정밀도(month/day)도 번들 왕복에서 보존돼야 한다.
    notes::set_event_precision(&mut ctx.conn, &d.note.id, Some(10), Some(9)).unwrap();
    // Dashboard Wave 3 (2026-08-01): "알려줘"(remind) 플래그도 번들 왕복에서 보존돼야 한다.
    notes::update(&mut ctx.conn, &d.note.id, None, None, None, Some(true)).unwrap();
    // Sync audit P1 fix (2026-08-01): end triple(사건 축 기간 종료, V28/V29)·icon(V11)·lat/lng(V17)
    // 도 번들 왕복에서 보존돼야 한다 — export.rs::NoteRow/두 SELECT/insert_note 가 이 필드들을
    // 누락했던 갭.
    notes::set_event_end(&mut ctx.conn, &d.note.id, Some(1450), Some(1), Some(1)).unwrap();
    notes::set_icon(&mut ctx.conn, &d.note.id, Some("crown".into())).unwrap();
    notes::set_location(&mut ctx.conn, &d.note.id, Some(37.5665), Some(126.978)).unwrap();
    // docs/PLAN-schedule-system.md §2.2 W5-1: 일정 시각·알림 오프셋·반복(RRULE 원문)도 번들
    // 왕복에서 보존돼야 한다 — SYNC.md §8.4 사고(컬럼만 있고 번들엔 빠져 있던 것)를 컬럼 도입과
    // 동시에 막는다.
    notes::set_schedule(
        &mut ctx.conn,
        &d.note.id,
        Some("09:30".into()),
        Some("10:00".into()),
        Some(15),
        Some("FREQ=WEEKLY;BYDAY=MO,WE".into()),
    )
    .unwrap();
    // Wave 4 (V27): 다중 경유지(note_regions)도 번들 왕복에서 보존돼야 한다.
    notes::region_add(&mut ctx.conn, &d.note.id, "Gyeongbokgung", 37.5796, 126.977, 0).unwrap();
    // GRILL-2026-09-07 D2 (V70): 추가 날짜(note_dates)도 번들 왕복에서 보존돼야 한다.
    // 2026-09-07 end_date: 기간을 가진 관련 날짜도 번들 왕복에서 보존돼야 한다.
    let extra_date_id = notes::date_add(
        &mut ctx.conn,
        &d.note.id,
        1446,
        Some(9),
        Some(1),
        Some(1446),
        Some(9),
        Some(3),
        None,
        None,
        false,
        None,
        None,
        None,
    )
    .unwrap();
    // PLAN-2026-09-08-dates-rebuild.md W3: note_date_update 가 행 하나의 시각·알림·반복을 한 번에
    // 저장한다(옛 note_date_set_remind+note_date_set_schedule 두 커맨드를 흡수) — end_time/rrule/
    // position 이 번들 왕복에서 살아남는지 여기서 함께 고정한다(§③ 새 필드 전부).
    // PLAN-2026-09-18-nl-dates.md D1(V85): label도 이제 번들 왕복 대상이다.
    notes::date_update(
        &mut ctx.conn,
        &extra_date_id,
        1446,
        Some(9),
        Some(1),
        Some(1446),
        Some(9),
        Some(3),
        Some("08:00".into()),
        Some("09:00".into()),
        true,
        Some(30),
        Some("FREQ=WEEKLY;BYDAY=TU".into()),
        Some("체크인".into()),
    )
    .unwrap();
    let ext = common::make_external_file(&ctx.tmp.path().join("ext"), "p.png", b"png-bytes");
    attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap()).unwrap();
    // Wave 4 (V27): 자동 연관노트 해제(note_related_exclusions)도 번들 왕복에서 보존돼야 한다 —
    // 짝이 될 두 번째 노트를 추가한다(콘텐츠는 최소로 유지해 다른 assertion 의 행 수를 흔들지
    // 않는다: sections/sources/attachments/note_tags 는 이 노트에 하나도 추가하지 않음).
    let partner = notes::create(&mut ctx.conn, &f2.id, Some("Related Partner".into()), Some(1443)).unwrap();
    notes::related_exclude(&ctx.conn, &d.note.id, &partner.note.id).unwrap();
    // W7-f 아카이브(archived_at, V36)도 번들 왕복에서 보존돼야 한다 — 리그레션(데이터 손실 P0,
    // 리뷰어 확인): 이전엔 이 컬럼이 NoteRow/세 SELECT/insert_note 어디에도 없어, 번들을 거친
    // 노트가 항상 archived_at=NULL 로 착지해 아카이브가 조용히 풀렸다(icon/lat/lng 가 겪은 것과
    // 같은 계열의 누락, 위 주석 참조). "Sejong"은 다른 assertion 이 전부 이 노트를 조회하므로
    // 건드리지 않고, "Related Partner"를 아카이브해 행 수/검색 관련 assertion 을 흔들지 않는다.
    notes::archive(&mut ctx.conn, &partner.note.id).unwrap();

    // Wave 13 (V54): 루틴 완료 이력(routine_completions)도 번들 왕복에서 보존돼야 한다.
    brise_lib::repo::routine::toggle(&ctx.conn, &d.note.id, "2026-08-16", true).unwrap();

    // Space (V50): 공간 및 공간 아이템도 번들 왕복에서 보존돼야 한다.
    //
    // repo::spaces 모듈은 캔버스 플러그인 전환(PLAN-2026-08-27)으로 완전히 삭제됐다 — 살아있는
    // 캔버스 기능은 repo::canvas_pages 가 맡고, `spaces`/`space_items` 테이블은 옛 번들(캔버스
    // 전환 이전)과의 export/import 호환만을 위해 dormant 로 남아 있다(canvas_page_image.rs 상단
    // 주석, transfer/export.rs 의 SELECT ... FROM spaces 참조). 이 테이블에 쓰는 공개 repo 함수가
    // 더는 없으므로, 여기서는 그 dormant 스키마(migrations.rs V50~V52/V58)에 맞춰 직접 INSERT한다
    // — "옛 번들 데이터가 여전히 왕복에서 보존되는가"라는 불변성 자체는 여전히 유효하다.
    let ws_id: String = ctx
        .conn
        .query_row("SELECT workspace_id FROM folders WHERE id=?1", [&f2.id], |r| r.get(0))
        .unwrap();
    let sp_id = legacy_space_create(&ctx.conn, &ws_id, "Main Canvas");
    legacy_space_item_add(
        &ctx.conn,
        &sp_id,
        "note",
        Some(d.note.id.clone()),
        None,
        100.0,
        200.0,
        300.0,
        200.0,
        Some(r#"{"color":"blue"}"#.into()),
        Some("preview".into()),
    );
    legacy_space_item_add(
        &ctx.conn,
        &sp_id,
        "text",
        None,
        Some("Sticky Note Memo".into()),
        400.0,
        500.0,
        200.0,
        150.0,
        None,
        None,
    );
    // W5: space image file + thumb ride the bundle the same way note attachments do.
    // 1x1 PNG (valid raster so thumbs.rs can decode); no `image` crate in this test crate.
    const MINI_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let real_png = common::make_external_file(&ctx.tmp.path().join("ext"), "space-real.png", MINI_PNG);
    let img_rel = legacy_space_image_add(
        &ctx.conn,
        &ctx.data_dir,
        &sp_id,
        real_png.to_str().unwrap(),
        50.0,
        60.0,
        320.0,
        240.0,
    );
    brise_lib::repo::attachments::ensure_thumb_for_attachment(&ctx.data_dir, &img_rel);

    // 설정 변경
    let mut entry = std::collections::BTreeMap::new();
    entry.insert(
        "accent".into(),
        serde_json::json!("#3aa0d4"),
    );
    brise_lib::repo::settings::set(&mut ctx.conn, &entry).unwrap();

    // 없어진 키의 묵은 행(캔버스 플러그인 제거 2026-09-28) — 기존 설치엔 남아 있고 export 가 그대로
    // 싣는다. replace 가져오기가 이것 때문에 통째로 거부되면 안 된다(RETIRED_SETTING_KEYS).
    ctx.conn
        .execute("INSERT OR REPLACE INTO settings(key, value) VALUES ('canvas_enabled', '\"1\"')", [])
        .unwrap();
}

// ── dormant `spaces`/`space_items` seed helpers ─────────────────────────────────────────────
// repo::spaces was deleted with the canvas-plugin rewrite; nothing in production writes these
// tables anymore. They are kept around only so export/import can still round-trip bundles saved
// before that rewrite (see canvas_page_image.rs's SPACE_IMAGE_ROOT comment). Insert directly
// against the dormant schema (migrations.rs V50/V51/V52/V58) instead of a repo function.

fn legacy_space_create(conn: &rusqlite::Connection, workspace_id: &str, title: &str) -> String {
    let id = brise_lib::util::new_id();
    let now = brise_lib::util::now_iso();
    conn.execute(
        "INSERT INTO spaces (id, workspace_id, title, position, is_home, last_viewport_x, last_viewport_y, last_viewport_zoom, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 0, 0.0, 0.0, 1.0, ?4, ?4)",
        rusqlite::params![id, workspace_id, title, now],
    )
    .unwrap();
    id
}

#[allow(clippy::too_many_arguments)]
fn legacy_space_item_add(
    conn: &rusqlite::Connection,
    space_id: &str,
    kind: &str,
    source_id: Option<String>,
    content: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    style: Option<String>,
    display_mode: Option<String>,
) -> String {
    let id = brise_lib::util::new_id();
    let now = brise_lib::util::now_iso();
    conn.execute(
        "INSERT INTO space_items (id, space_id, kind, source_id, content, x, y, width, height, z_index, display_mode, style, locked, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, 0, ?12, ?12)",
        rusqlite::params![
            id,
            space_id,
            kind,
            source_id,
            content.unwrap_or_default(),
            x,
            y,
            width,
            height,
            display_mode.unwrap_or_else(|| "preview".into()),
            style.unwrap_or_default(),
            now,
        ],
    )
    .unwrap();
    id
}

/// Copies `file_path` under attachments/spaces/{space_id}/ (the dormant image root — see
/// canvas_page_image.rs's SPACE_IMAGE_ROOT) and inserts the matching `space_items` row.
/// Returns the attachments/-relative path, same shape as the deleted space_image_add's
/// `source_id`.
fn legacy_space_image_add(
    conn: &rusqlite::Connection,
    data_dir: &std::path::Path,
    space_id: &str,
    file_path: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> String {
    let src = std::path::Path::new(file_path);
    let name = src.file_name().unwrap().to_str().unwrap();
    let dest_dir = brise_lib::db::attachments_dir(data_dir).join("spaces").join(space_id);
    std::fs::create_dir_all(&dest_dir).unwrap();
    std::fs::copy(src, dest_dir.join(name)).unwrap();
    let rel = format!("spaces/{space_id}/{name}");
    legacy_space_item_add(conn, space_id, "image", Some(rel.clone()), None, x, y, width, height, None, None);
    rel
}

#[test]
fn full_roundtrip() {
    let mut ctx = common::setup();
    seed(&mut ctx);

    let dest = ctx.tmp.path().join("export-out");
    let res = transfer::export_all(&ctx.conn, &ctx.data_dir, &dest).unwrap();
    // "Sejong" + its related_exclude partner "Related Partner".
    assert_eq!(res.note_count, 2);

    transfer::db_reset(&mut ctx.conn, &ctx.data_dir, "RESET").unwrap();
    assert_eq!(common::count(&ctx.conn, "notes"), 0);

    let bundle = dest.join("brise-bundle.json");
    let imp = transfer::import_bundle(&mut ctx.conn, &ctx.data_dir, &bundle, "replace", None, false).unwrap();
    assert_eq!(imp.imported_notes, 2);
    assert_eq!(imp.skipped, 0);

    // 행 수 보존
    assert_eq!(common::count(&ctx.conn, "notes"), 2);
    // "Sejong"의 2 섹션(기본+Timeline) + partner의 기본 섹션 1개.
    assert_eq!(common::count(&ctx.conn, "sections"), 3);
    assert_eq!(common::count(&ctx.conn, "sources"), 1);
    assert_eq!(common::count(&ctx.conn, "attachments"), 1);
    assert_eq!(common::count(&ctx.conn, "note_tags"), 2);
    assert_eq!(common::count(&ctx.conn, "notes_fts"), 2);

    // FTS 재색인 검증
    let r = search::search(&ctx.conn, "훈민정음", Some(900), Some(1960), None, None).unwrap();
    assert_eq!(r.results.len(), 1);

    // 폴더 아이콘 색상(color_hue) 보존 검증 — export -> reset -> import 왕복.
    let color_hue: Option<i64> = ctx
        .conn
        .query_row(
            "SELECT color_hue FROM folders WHERE name='Era2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(color_hue, Some(200));

    // 노트 지역(region) 보존 검증 — export -> reset -> import 왕복.
    let region: Option<String> = ctx
        .conn
        .query_row(
            "SELECT region FROM notes WHERE title='Sejong'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(region, Some("Hanseong".to_string()));

    // 사건 축 정밀도(month/day) 보존 검증 — export -> reset -> import 왕복.
    let (month, day): (Option<i64>, Option<i64>) = ctx
        .conn
        .query_row(
            "SELECT month, day FROM notes WHERE title='Sejong'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((month, day), (Some(10), Some(9)));

    // "알려줘"(remind) 플래그 보존 검증 — export -> reset -> import 왕복 (Dashboard Wave 3, 2026-08-01).
    let remind: i64 = ctx
        .conn
        .query_row(
            "SELECT remind FROM notes WHERE title='Sejong'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(remind, 1);

    // 사건 축 기간 종료(end_year/end_month/end_day, V28/V29) + 아이콘(icon, V11) + 좌표(lat/lng,
    // V17) 보존 검증 — export -> reset -> import 왕복 (Sync audit P1 fix, 2026-08-01: 이전엔 이
    // 세 부류가 NoteRow/SELECT/INSERT 에서 빠져 있어 조용히 사라졌다).
    let (end_year, end_month, end_day, icon, lat, lng): (
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<f64>,
        Option<f64>,
    ) = ctx
        .conn
        .query_row(
            "SELECT end_year, end_month, end_day, icon, lat, lng FROM notes WHERE title='Sejong'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .unwrap();
    assert_eq!((end_year, end_month, end_day), (Some(1450), Some(1), Some(1)));
    assert_eq!(icon, Some("crown".to_string()));
    assert_eq!((lat, lng), (Some(37.5665), Some(126.978)));

    // 일정 시각·알림 오프셋·반복(start_time/end_time/remind_offset_min/rrule, V42) 보존 검증 —
    // export -> reset -> import 왕복 (docs/PLAN-schedule-system.md §2.2 W5-1).
    let (start_time, end_time, remind_offset_min, rrule): (
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = ctx
        .conn
        .query_row(
            "SELECT start_time, end_time, remind_offset_min, rrule FROM notes WHERE title='Sejong'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(start_time, Some("09:30".to_string()));
    assert_eq!(end_time, Some("10:00".to_string()));
    assert_eq!(remind_offset_min, Some(15));
    assert_eq!(rrule, Some("FREQ=WEEKLY;BYDAY=MO,WE".to_string()));

    // 다중 경유지(note_regions, V27) 보존 검증 — export -> reset -> import 왕복.
    let (region_name, region_lat, region_lng): (String, f64, f64) = ctx
        .conn
        .query_row(
            "SELECT name, lat, lng FROM note_regions WHERE note_id = (SELECT id FROM notes WHERE title='Sejong')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(region_name, "Gyeongbokgung");
    assert_eq!((region_lat, region_lng), (37.5796, 126.977));

    // 추가 날짜(note_dates, GRILL-2026-09-07 D2/V70) 보존 검증 — export -> reset -> import 왕복.
    // PLAN-2026-09-08-dates-rebuild.md W3: position/end_time/rrule 도 이제 번들 왕복 대상이다
    // (NoteDateRow/insert_note_date/export SELECT 가 이 필드들을 누락하면 노트북 내보내기/가져오기
    // 에서 조용히 사라진다) — position != 0 으로 이 관련 날짜만 골라 트리플 그대로 읽는다.
    #[allow(clippy::type_complexity)]
    let (
        extra_position,
        extra_year,
        extra_month,
        extra_day,
        extra_end_year,
        extra_end_month,
        extra_end_day,
        extra_remind,
        extra_start_time,
        extra_end_time,
        extra_offset,
        extra_rrule,
        extra_label,
    ): (
        i64,
        i64,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
    ) = ctx
        .conn
        .query_row(
            "SELECT position, year, month, day, end_year, end_month, end_day,
                    remind, start_time, end_time, remind_offset_min, rrule, label
             FROM note_dates WHERE note_id = (SELECT id FROM notes WHERE title='Sejong') AND position != 0",
            [],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
                    r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(extra_position, 1, "W3: position도 번들 왕복에서 보존돼야 한다");
    assert_eq!((extra_year, extra_month, extra_day), (1446, Some(9), Some(1)));
    assert_eq!((extra_end_year, extra_end_month, extra_end_day), (Some(1446), Some(9), Some(3)), "2026-09-07: 기간(end_*)도 번들 왕복에서 보존돼야 한다");
    assert_eq!(extra_remind, 1, "D3 철회: 관련 날짜 알림도 번들 왕복에서 보존돼야 한다");
    assert_eq!(extra_start_time.as_deref(), Some("08:00"), "W2c: 관련 날짜 시각도 번들 왕복에서 보존돼야 한다");
    assert_eq!(extra_end_time.as_deref(), Some("09:00"), "W3: 관련 날짜 종료 시각도 번들 왕복에서 보존돼야 한다");
    assert_eq!(extra_offset, Some(30), "W2c: 관련 날짜 알림 오프셋도 번들 왕복에서 보존돼야 한다");
    assert_eq!(extra_rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU"), "W3: 관련 날짜 반복도 번들 왕복에서 보존돼야 한다");
    assert_eq!(extra_label.as_deref(), Some("체크인"), "D1 부활(V85): 관련 날짜 label도 번들 왕복에서 보존돼야 한다");

    // 자동 연관노트 해제(note_related_exclusions, V27) 보존 검증 — export -> reset -> import 왕복.
    // 파트너 노트("Related Partner")도 살아 있어야 관계가 의미가 있다.
    assert_eq!(common::count(&ctx.conn, "note_related_exclusions"), 1);
    let partner_survived: i64 = ctx
        .conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE title='Related Partner'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(partner_survived, 1);

    // 아카이브(archived_at, W7-f/V36) 보존 검증 — export -> reset -> import 왕복. "Sejong"은
    // 미아카이브로 남아야 하고("Sejong"을 보는 다른 assertion 들이 이 값에 의존하지 않으므로
    // 안전), "Related Partner"는 아카이브 상태 그대로 살아남아야 한다(이전엔 NoteRow/SELECT/
    // insert_note 에 이 컬럼이 없어 여기서 항상 NULL 로 착지했다).
    let sejong_archived: Option<String> = ctx
        .conn
        .query_row("SELECT archived_at FROM notes WHERE title='Sejong'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sejong_archived, None, "Sejong was never archived");
    let partner_archived: Option<String> = ctx
        .conn
        .query_row("SELECT archived_at FROM notes WHERE title='Related Partner'", [], |r| r.get(0))
        .unwrap();
    assert!(partner_archived.is_some(), "archived note must stay archived after export -> reset -> import(replace)");

    // 사용자 추가 지역/시대(workspace_regions/workspace_eras) 보존 검증 — Wave 14.
    let regions = taxonomy::list_regions(&ctx.conn, None).unwrap();
    assert!(regions.iter().any(|r| r.name == "Sokcho"));
    let eras = taxonomy::list_eras(&ctx.conn, None).unwrap();
    assert!(eras
        .iter()
        .any(|e| e.name == "Custom Era" && e.from_year == 1400 && e.to_year == 1500));

    // 사용자 추가 노트 상태(workspace_statuses) + 노트가 그 상태를 참조하는 관계 보존 검증
    // — Wave 15. export -> reset -> import 왕복 후에도 커스텀 상태 행과, 그 상태를 가리키던
    // 노트의 status 값이 (id 가 동일하게 보존되어) 여전히 유효하게 연결되어 있어야 한다.
    let statuses = taxonomy::list_statuses(&ctx.conn, None).unwrap();
    let relecture = statuses
        .iter()
        .find(|s| s.name == "Relecture")
        .expect("custom status 'Relecture' must survive export/import roundtrip");
    let status: Option<String> = ctx
        .conn
        .query_row(
            "SELECT status FROM notes WHERE title='Sejong'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, Some(relecture.id.clone()));

    // 공간 및 공간 아이템 (V50) 보존 검증 — export -> reset -> import 왕복.
    assert_eq!(common::count(&ctx.conn, "spaces"), 1);
    assert_eq!(common::count(&ctx.conn, "space_items"), 3);
    let space_title: String = ctx
        .conn
        .query_row("SELECT title FROM spaces LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(space_title, "Main Canvas");
    let bootstrapped: i64 = ctx
        .conn
        .query_row(
            "SELECT space_bootstrapped FROM workspaces LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(bootstrapped, 1);

    let note_item_count: i64 = ctx
        .conn
        .query_row(
            "SELECT COUNT(*) FROM space_items WHERE kind='note' AND display_mode='preview'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(note_item_count, 1);

    // 루틴 완료 이력 (V54) 보존 검증 — export -> reset -> import 왕복.
    assert_eq!(common::count(&ctx.conn, "routine_completions"), 1);
    let img_rel: String = ctx
        .conn
        .query_row(
            "SELECT source_id FROM space_items WHERE kind='image'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let att_root = brise_lib::db::attachments_dir(&ctx.data_dir);
    assert!(
        att_root.join(&img_rel).is_file(),
        "space image original must survive replace roundtrip: {img_rel}"
    );
    let thumb = brise_lib::repo::attachments::thumb_rel_for(&img_rel);
    assert!(
        att_root.join(&thumb).is_file(),
        "space image thumb must survive replace roundtrip: {thumb}"
    );
    let text_item_content: String = ctx
        .conn
        .query_row(
            "SELECT content FROM space_items WHERE kind='text'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(text_item_content, "Sticky Note Memo");
}

#[test]
fn merge_skips_conflicts() {
    let mut ctx = common::setup();
    seed(&mut ctx);
    let dest = ctx.tmp.path().join("export-out");
    transfer::export_all(&ctx.conn, &ctx.data_dir, &dest).unwrap();

    // 추가 노트 B
    let b = notes::create(&mut ctx.conn, &ctx.folder_id, Some("Extra".into()), Some(1500)).unwrap();
    assert!(!b.note.id.is_empty());

    let bundle = dest.join("brise-bundle.json");
    let imp = transfer::import_bundle(&mut ctx.conn, &ctx.data_dir, &bundle, "merge", None, false).unwrap();
    // 동일 id 충돌 — 0개 추가, 번들의 두 노트("Sejong" + "Related Partner") 모두 skip
    assert_eq!(imp.imported_notes, 0);
    assert_eq!(imp.skipped, 2);
    // Extra 는 그대로
    let r = search::search(&ctx.conn, "Extra", Some(900), Some(1960), None, None).unwrap();
    assert_eq!(r.results.len(), 1);
}

#[test]
fn future_version_rejected() {
    let mut ctx = common::setup();
    seed(&mut ctx);
    let dest = ctx.tmp.path().join("export-out");
    transfer::export_all(&ctx.conn, &ctx.data_dir, &dest).unwrap();
    let bundle_path = dest.join("brise-bundle.json");

    // version을 비정상 값으로 조작
    let raw = fs::read_to_string(&bundle_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["version"] = serde_json::json!(i64::MAX);
    fs::write(&bundle_path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();

    let err = transfer::import_bundle(&mut ctx.conn, &ctx.data_dir, &bundle_path, "replace", None, false).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    // 원본 노트는 그대로 ("Sejong" + "Related Partner")
    assert_eq!(common::count(&ctx.conn, "notes"), 2);
}

#[test]
fn traversal_rejected() {
    // R5: 첨부 rel_path가 데이터 디렉토리 탈출 시 전체 거부
    let mut ctx = common::setup();
    let d = notes::create(&mut ctx.conn, &ctx.folder_id, None, None).unwrap();
    let ext = common::make_external_file(&ctx.tmp.path().join("ext"), "a.png", b"img");
    attachments::add_file(&mut ctx.conn, &ctx.data_dir, &d.note.id, ext.to_str().unwrap()).unwrap();

    let dest = ctx.tmp.path().join("export-out");
    transfer::export_all(&ctx.conn, &ctx.data_dir, &dest).unwrap();
    let bundle_path = dest.join("brise-bundle.json");

    // 첨부 경로를 탈출 형태로 조작
    let raw = fs::read_to_string(&bundle_path).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    if let Some(arr) = v["attachments"].as_array_mut() {
        if let Some(first) = arr.first_mut() {
            first["rel_path"] = serde_json::json!("../../evil.exe");
        }
    }
    fs::write(&bundle_path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();

    let err = transfer::import_bundle(&mut ctx.conn, &ctx.data_dir, &bundle_path, "merge", None, false).unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    // DB 무변경
    assert_eq!(common::count(&ctx.conn, "notes"), 1);
    // 데이터 디렉토리 외부에 파일 생성되지 않음
    assert!(!ctx.tmp.path().join("evil.exe").exists());
}
