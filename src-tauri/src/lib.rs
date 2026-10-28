// Brise — Tauri 2 엔트리. DB 부트스트랩 + 커맨드 등록 + 단일 인스턴스(R2).
/// P3 수집 관문 러너(docs/PLAN-2026-08-07-second-brain.md Q6) — embedding과 같은 패턴, 백그라운드
/// 전용, 부팅/저장 경로를 블로킹하지 않는다. collect::start() 헤더 주석 참고.
pub mod collect;
pub mod commands;
pub mod db;
/// 10만+ 노트 스케일 측정용 합성 코퍼스 시더(docs/SCALABILITY.md §6) — release 빌드 미포함.
/// 3091321에서 참조 0으로 삭제됐다가 W10/W11 실측을 위해 복구(2026-08-21).
#[cfg(any(debug_assertions, test))]
pub mod dev_seed;
/// 앱 전역 진단 싱크(AUDIT-2026-09-26-fallback-observability.md §7.1) — JSONL+회전+링버퍼,
/// repo/ai/call_log.rs와 같은 방식. 헤더 주석이 규칙 SSOT.
pub mod diag;
mod boot_timing;
mod window_geometry;
pub mod error;
/// 실시간 변경 통지의 단일 초크포인트(커맨드 계층 → 데스크톱 웹뷰 + SSE). events.rs 헤더 주석이 규칙 SSOT.
pub mod events;
pub mod models;
pub mod pet_window;
pub mod aux_window;
pub mod settings_window;
pub mod activity_window;
pub mod ai_history_window;
pub mod briefing_window;
pub mod section_window;
pub mod repo;
pub mod sync_server;
pub mod tray;
pub mod util;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    boot_timing::mark("run");
    // 진단 싱크 패닉 훅(AUDIT-2026-09-26-fallback-observability.md §7.1) — DB 부트스트랩보다도
    // 먼저 건다. release 빌드는 windows_subsystem="windows"라 콘솔이 없어, 이게 없으면 panic
    // 메시지가 완전히 사라진다(§3 G1). diag::init() 이전이라 파일에는 안 남고 링 버퍼에만
    // 쌓이지만(diag.rs 헤더 주석), 그래도 diag_status/diag_recent 로 그 세션 안에서는 보인다.
    diag::install_panic_hook();
    // 앱 커맨드는 capabilities/ACL 을 타지 않는다(그건 `plugin:` 접두사가 붙는 코어 커맨드 전용).
    // 그래서 펫 웹뷰의 JS 가 db_reset·backup_restore·export_all·settings_set 까지 그대로 부를 수
    // 있었다 — capabilities/pet.json 은 창 관리 권한만 제한한다. 여기가 그걸 막는 단 한 곳이다:
    // 펫 창(pet / pet-bubble)에서 온 호출은 **기본 거부**이고 허용 목록에 있는 것만 통과한다.
    // 커맨드 100개의 시그니처를 건드리지 않는 최소 폭발반경. 상세는 pet_window.rs 의
    // PET_ALLOWED_COMMANDS 주석과 docs/SECURITY-REVIEW-2026-08-04.md #8.
    let app_commands: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static> =
        Box::new(tauri::generate_handler![
            // notes + folders
            commands::notes::note_create,
            commands::notes::note_get,
            commands::notes::note_get_many,
            commands::notes::note_update,
            commands::notes::note_delete,
            commands::notes::note_restore,
            commands::notes::note_purge,
            commands::notes::note_trash_list,
            commands::notes::note_trash_count,
            commands::notes::note_archive,
            commands::notes::note_unarchive,
            commands::notes::note_archived_list,
            commands::notes::note_archived_count,
            commands::notes::note_query,
            commands::notes::note_year_histogram,
            commands::notes::note_record_histogram,
            commands::notes::note_toggle_favorite,
            commands::notes::note_toggle_content_lock,
            commands::notes::note_set_tags,
            commands::notes::note_set_region,
            commands::notes::note_set_status,
            commands::notes::note_set_icon,
            commands::notes::note_set_location,
            commands::notes::note_related,
            commands::notes::note_related_exclude,
            commands::notes::note_related_restore,
            commands::notes::note_related_hidden_count,
            commands::notes::note_region_add,
            commands::notes::note_region_remove,
            commands::notes::note_regions_list,
            commands::notes::note_region_reorder,
            commands::notes::note_region_move,
            commands::notes::region_registry,
            commands::notes::note_date_add,
            commands::notes::note_date_update,
            commands::notes::note_date_remove,
            commands::notes::note_date_reorder,
            commands::notes::note_dates_list,
            commands::notes::note_date_make_primary,
            commands::notes::note_summaries_map,
            commands::notes::folder_list,
            commands::notes::folder_list_meta,
            commands::notes::note_tags_index,
            commands::notes::tag_counts,
            commands::notes::tag_colors,
            commands::notes::tag_set_color,
            commands::notes::tag_rename,
            commands::notes::tag_merge,
            commands::notes::tag_delete,
            commands::notes::folder_create,
            commands::notes::folder_rename,
            commands::notes::folder_set_open,
            commands::notes::folder_set_color,
            commands::notes::folder_set_icon,
            commands::notes::folder_set_rules,
            commands::notes::folder_set_exclusions,
            commands::notes::folder_files,
            // dashboard (Wave 3 — native IPC; http:false)
            commands::dashboard::dashboard_board,
            commands::dashboard::todo_toggle,
            commands::dashboard::dashboard_calendar,
            commands::dashboard::dashboard_timeline,
            commands::dashboard::dashboard_graph,
            commands::dashboard::note_cover_image,
            commands::dashboard::note_cover_images,
            commands::dashboard::schedule_today,
            // sections
            commands::sections::section_create,
            commands::sections::section_create_with_body,
            commands::sections::section_update,
            commands::sections::section_delete,
            commands::sections::section_reorder,
            commands::sections::section_move,
            commands::sections::section_restore,
            commands::sections::section_purge,
            commands::sections::section_trash_list,
            commands::sections::sheet_set_cells,
            commands::sections::section_import_file,
            commands::sections::doc_import_html,
            commands::sections::section_import_scan,
            // note snapshots (editor autosave cache — http:false, commands/snapshots.yaml)
            commands::snapshots::note_snapshot_capture,
            commands::snapshots::note_snapshot_list,
            commands::snapshots::note_snapshot_get,
            commands::snapshots::note_snapshot_restore,
            // activity log (device-local audit trail — http:false, commands/activity.yaml)
            commands::activity::activity_list,
            // sources
            commands::sources::source_add_text,
            commands::sources::source_add_file,
            commands::sources::source_rename,
            commands::sources::source_delete,
            // attachments
            commands::attachments::attachment_add_file,
            commands::attachments::attachment_add_bytes,
            commands::attachments::attachment_add_link,
            commands::attachments::attachment_add_internal,
            commands::attachments::attachment_add_chart,
            // 각주(Wave 4, d2f7b5d) — 도입 당시 여기 등록이 빠져 데스크톱 웹뷰에서 호출하면
            // 런타임에 거부됐다(src/components/editor/footnoteMark.ts 가 부른다). HTTP 경로는
            // dispatch.gen.rs 가 생성해 주므로 모바일에서만 멀쩡했고, invariant_command_registry
            // 테스트는 전체 cargo test 에서만 도는데 앱이 exe 를 잠그고 있어 계속 못 돌았다.
            commands::attachments::attachment_add_footnote,
            commands::attachments::attachment_remove,
            commands::attachments::attachment_rename,
            commands::attachments::attachment_open,
            commands::attachments::attachment_reveal,
            commands::audio_transcribe::audio_transcribe,
            commands::audio_transcribe::attachment_transcript_mark_inserted,
            commands::attachments::attachment_fetch_reader,
            commands::attachments::attachment_read_text,
            commands::attachments::attachments_base_dir,
            commands::attachments::attachment_thumbs,
            commands::attachments::attachment_query,
            commands::attachments::attachment_thumbs_for_ids,
            // 슬라이드 프리뷰(pptx → pdf, LibreOffice headless)
            commands::slides::slide_preview_render,
            // search
            commands::search::search_notes,
            commands::suggestions::suggestions_list,
            commands::suggestions::suggestion_set_status,
            commands::suggestions::graph_suggestion_accept,
            commands::suggestions::graph_suggestion_dismiss,
            commands::suggestions::link_suggest,
            commands::suggestions::link_preview,
            // collect (P3 수집 관문, docs/PLAN-2026-08-07-second-brain.md Q6)
            commands::collect::collect_source_list,
            commands::collect::collect_source_set_enabled,
            commands::collect::collect_source_delete,
            commands::collect::collect_source_add_nl,
            commands::collect::collect_source_run_now,
            commands::collect::collect_source_dry_run,
            commands::collect::collect_ytdlp_status,
            commands::collect::collect_ytdlp_install,
            commands::collect::collect_source_create,
            commands::collect::collect_source_update,
            commands::collect::collect_resolve_youtube_channel,
            commands::collect::collect_get_stats,
            commands::collect::collect_detect_local,
            commands::collect::collect_detect_chat_sessions,
            commands::collect::collect_import_local,
            commands::geocode::geocode_search,
            commands::geocode::geocode_reverse,
            commands::geocode::geo_timezone,
            // weather (specs/commands/weather.yaml) — met.no, replaces Open-Meteo (2026-08-29)
            commands::weather::weather_forecast,
            // settings
            commands::settings::settings_get_all,
            commands::settings::settings_set,
            commands::settings::theme_defaults,
            commands::settings::theme_read,
            commands::settings::theme_export,
            commands::settings::db_stats,
            commands::settings::phrase_packs_list,
            commands::settings::phrase_pack_save,
            // transfer
            commands::transfer::export_note,
            commands::transfer::export_diagram_png,
            commands::transfer::export_sheet_csv,
            commands::transfer::export_section_md,
            commands::transfer::export_hwpx,
            commands::transfer::export_docx,
            commands::transfer::export_html,
            commands::transfer::export_html_inline,
            commands::transfer::export_open,
            commands::transfer::export_all,
            commands::transfer::export_folder,
            commands::transfer::export_folder_bundle,
            commands::transfer::export_workspace_bundle,
            commands::transfer::import_bundle,
            commands::transfer::db_reset,
            commands::transfer::backup_create,
            commands::transfer::backup_restore,
            commands::transfer::backup_auto_status,
            commands::transfer::backup_auto_list,
            commands::transfer::backup_auto_run,
            commands::transfer::data_dir_open,
            commands::data_location::data_location_get,
            commands::data_location::data_subdir_open,
            commands::data_location::data_location_inspect,
            commands::data_location::data_location_apply,
            commands::migrate::migration_import_markdown,
            commands::migrate::migration_import_notion,
            commands::migrate::migration_import_enex,
            // ai
            commands::ai::ai_organize_note,
            commands::ai::ai_apply_organize,
            commands::ai::ai_apply_plan,
            commands::ai::ai_test_connection,
            commands::ai::ai_test_connection_before_enable,
            commands::ai::ai_openrouter_connect,
            commands::ai::ai_translate_text,
            commands::ai::ai_cleanup_text,
            commands::ai::ai_generate_from_prompt,
            commands::ai::ai_get_history,
            commands::ai::ai_get_usage,
            commands::ai::ai_calls_active,
            commands::ai::ai_calls_recent,
            commands::ai::ai_cancel_call,
            commands::ai::ai_calls_summary,
            commands::ai::ai_call_annotate,
            // pet (W6-d2 챗 코어 — specs/commands/pet.yaml, 전부 http:false)
            commands::pet::pet_chat,
            commands::pet::pet_chat_history,
            commands::pet::pet_chat_clear,
            commands::pet::pet_session_list,
            commands::pet::pet_session_new,
            commands::pet::pet_session_open,
            commands::pet::pet_chat_rewind,
            commands::pet::pet_chat_delete,
            commands::pet::pet_chat_read_attach,
            commands::pet::pet_note_create,
            commands::pet::pet_conversation_save,
            commands::pet::pet_notifications,
            commands::pet::pet_open_main,
            commands::pet::pet_close,
            commands::pet::pet_menu_popup,
            // pet (W8-h 펫 대화창 스타일 상속 — 좁은 테마 읽기)
            commands::pet::pet_theme,
            // pet (W7-h 창 분리 · 설정 섹션 · 에셋)
            commands::pet::pet_set_enabled,
            // pet (W8-g 2단계 노출: 마스터 pet_enabled 와 별개의 표시/숨김)
            commands::pet::pet_set_visible,
            commands::pet::pet_set_position,
            commands::pet::pet_bubble_toggle,
            commands::pet::pet_bubble_notice,
            // 펫 클립보드 저장 확인 카드(Q9) — 메인 창 전용(PET_ALLOWED_COMMANDS 밖).
            commands::pet::pet_bubble_clip,
            // 펫 화면 저장(PLAN-2026-08-09-pet-capture Phase 1) — 역시 메인 창 전용.
            commands::pet::pet_screenshot_capture,
            commands::pet::pet_bubble_close,
            commands::pet::pet_bubble_state,
            commands::pet::pet_bubble_resize,
            commands::pet::pet_assets_list,
            commands::pet::pet_asset_set,
            commands::pet::pet_asset_preview,
            commands::pet::pet_asset_clear,
            commands::pet::pet_packages_list,
            commands::pet::pet_package_asset,
            commands::pet::pet_package_install,
            commands::pet::pet_package_install_url,
            commands::pet::pet_packages_import_codex,
            commands::pet::pet_package_select,
            commands::pet::pet_package_remove,
            commands::pet::pet_position_reset,
            // window (SINGLE-SHEET ACRYLIC CONTRACT — surface_style ↔ flat/acrylic, native Acrylic material)
            commands::window::window_set_effect,
            commands::window::window_surface_support,
            commands::window::window_close_confirmed,
            commands::window::settings_window_open,
            commands::window::activity_window_open,
            commands::window::ai_history_window_open,
            commands::window::briefing_window_open,
            // 섹션 분리 창(section_window.rs, specs/commands/sections.yaml — http:false)
            commands::window::section_window_open,
            commands::window::section_window_close,
            commands::window::section_window_list,
            // workspaces
            commands::workspaces::workspace_list,
            commands::workspaces::workspace_create,
            commands::workspaces::workspace_duplicate,
            commands::workspaces::workspace_rename,
            commands::workspaces::workspace_delete,
            commands::workspaces::workspace_set_bg_image,
            commands::workspaces::workspace_clear_bg_image,
            commands::workspaces::workspace_set_icon,
            commands::workspaces::workspace_bg_base_dir,
            // routine (docs/PLAN-2026-08-16-space-widgets.md §4 W13)
            commands::routine::routine_toggle,
            commands::routine::routine_today,
            commands::routine::routine_history,
            // timeline_routine (specs/commands/timeline_routines.yaml) — 시간축 배경 루틴.
            // routine(위)과 이름이 비슷하지만 다른 개념이다 — 혼동 금지(CLAUDE.md).
            commands::timeline_routine::timeline_routine_list,
            commands::timeline_routine::timeline_routine_create,
            commands::timeline_routine::timeline_routine_update,
            commands::timeline_routine::timeline_routine_delete,
            // habits (specs/commands/habits.yaml) - briefing habits (PLAN-2026-09-30-briefing).
            commands::habits::habit_list,
            commands::habits::habit_create,
            commands::habits::habit_update,
            commands::habits::habit_delete,
            commands::habits::habit_reorder,
            commands::habits::habit_check,
            commands::habits::habit_week,
            commands::habits::habit_history,
            // briefing (specs/commands/briefing.yaml) - PLAN-2026-09-30-briefing W7.
            commands::briefing::briefing_recent_collected,
            commands::collect::collect_history,
            commands::briefing::briefing_recent_notes,
            // PLAN-2026-10-19-briefing-rewrite W2 — 시간축 일정 만들기 · 내 노트 인용.
            commands::briefing::briefing_block_create,
            commands::briefing::briefing_note_quote,
            // calendar_marks (specs/commands/calendar_marks.yaml) — 달력 표시일(공휴일·기념일).
            commands::calendar_marks::calendar_marks_list,
            commands::calendar_marks::calendar_mark_create,
            commands::calendar_marks::calendar_mark_update,
            commands::calendar_marks::calendar_mark_delete,
            commands::calendar_marks::calendar_mark_set_hidden,
            commands::calendar_marks::calendar_source_save,
            commands::calendar_marks::calendar_source_update,
            commands::calendar_marks::calendar_source_delete,
            commands::calendar_marks::calendar_fetch_ics,
            // notifications (학습 타이머 등 위젯 OS 알림 — specs/commands/notifications.yaml, http:false)
            commands::notifications::notify_send,
            // taxonomy: workspace-scoped user regions/eras (Wave 14)
            commands::taxonomy::workspace_region_list,
            commands::taxonomy::workspace_region_add,
            commands::taxonomy::workspace_region_remove,
            commands::taxonomy::workspace_era_list,
            commands::taxonomy::workspace_era_add,
            commands::taxonomy::workspace_era_remove,
            commands::taxonomy::workspace_status_list,
            commands::taxonomy::workspace_status_add,
            commands::taxonomy::workspace_status_rename,
            commands::taxonomy::workspace_status_remove,
            // emoji
            commands::emoji::emoji_base_dir,
            commands::emoji::emoji_style_status,
            commands::emoji::emoji_download,
            // fonts (PLAN-2026-10-27-fonts)
            commands::fonts::fonts_base_dir,
            commands::fonts::font_status,
            commands::fonts::font_download,
            // sync (beta): tailnet 읽기전용 서버
            commands::sync::sync_status,
            commands::sync::sync_set_enabled,
            commands::sync::sync_regenerate_token,
            commands::sync::agent_skill_install,
            // capture (Phase 2): 크롬 익스텐션 클리핑용 loopback ingest 리스너
            commands::capture::capture_status,
            commands::capture::capture_set_ledger_enabled,
            // diag (AUDIT-2026-09-26-fallback-observability.md §7.1): 앱 전역 진단 싱크
            commands::diag::diag_record,
            commands::diag::diag_recent,
            commands::diag::diag_status,
            commands::diag::diag_take_notices,
        ]);
    tauri::Builder::default()
        // R2: 단일 인스턴스 — 후발 실행은 기존 창을 포커스(트레이로 숨어 있었다면 복원도).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_and_focus(app, tray::RevealVia::SecondInstance);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 일정 알림 OS 토스트(docs/PLAN-schedule-system.md §4.2) — 발화는 Rust(repo::schedule 틱)
        // 에서만 한다. capabilities 는 무변경: 앱 커맨드는 ACL 을 안 타고, `plugin:notification|*`
        // 를 JS 표면에 열면 펫 창의 기본 거부 정책에 구멍이 생길 뿐 얻는 게 없다.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_clipboard_manager::init())
        // 자동 업데이트(docs/RELEASING.md) + 설치 후 재시작. dev 에서도 tauri.conf.json 의
        // endpoints 로 실제 네트워크 요청이 나간다 — 실패(레포 private 등)는 프런트
        // lib/updater.ts 가 항상 catch 해 조용히 삼킨다(설계, tauri.dev.conf.json 은 무관).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            boot_timing::mark("setup");
            let default_data_dir = app.path().app_data_dir()?;
            // 저장 위치 이동(PLAN-2026-09-28-onboarding-rebuild.md §6) — 포인터 파일은 항상 기본
            // 앱 데이터 폴더에 있다(위치를 옮겨도 부팅이 찾을 수 있는 유일한 고정점). 없으면
            // 전부 None 이라 지금과 동일하게 동작한다. root 이동(D2)은 data_dir 자체를 바꾸고,
            // 분리 이동(D3, 클라우드 폴더는 DB 를 로컬에 남긴다)은 attachments_dir()/backups_dir()
            // 재정의만 세팅한다 — 이 두 함수의 호출자 79곳은 그대로 둔다.
            let location_pointer = repo::data_location::read_pointer(&default_data_dir);
            let data_dir = repo::data_location::effective_data_dir(&default_data_dir, &location_pointer);
            db::set_dir_overrides(location_pointer.attachments.clone(), location_pointer.backups.clone());
            // 진단 싱크(AUDIT-2026-09-26-fallback-observability.md §7.1) — 예전엔 AppState 배선
            // 직후(db::bootstrap 한참 뒤)에 불렀다. 그러면 부트스트랩 도중에 나는 진단(P0 복구
            // 알림 등)이 파일에는 전혀 안 남고 프로세스 링 버퍼에만 쌓였다가 재시작하면 사라진다
            // (diag.rs 헤더 주석 — "init() 전에도 record_from()은 링 버퍼만으로 동작한다"가 바로
            // 이 공백이다). data_dir 해석 직후, DB 부트스트랩보다도 먼저로 옮긴다 — diag::init은
            // PathBuf 하나만 받고 AppState/DB 무엇에도 기대지 않는다(diag.rs::init 참고).
            diag::init(data_dir.clone());
            boot_timing::mark("diag_init");
            // Windows asset.localhost 전역 403 의 근본 수정(tauri 2.11.5 소스 실측): is_allowed 는
            // 요청 경로를 canonicalize 해 verbatim 프리픽스(\\?\C:\…) 경로로 비교하는데, conf 의
            // $APPDATA 글롭이든 프리픽스 없는 allow_directory 든 패턴에 \\?\ 가 없어 절대 안 맞았다.
            // push_pattern 은 verbatim 경로를 받으면 프리픽스 제거 변형까지 같이 등록하므로,
            // canonicalize 한 경로로 허용하면 양쪽 모두 커버된다. canonicalize 는 존재하는 경로가
            // 필요해 create_dir_all 을 먼저 한다(모두 어차피 앱이 만드는 디렉토리).
            let scope = app.asset_protocol_scope();
            for dir in [
                db::attachments_dir(&data_dir),
                db::workspace_bg_dir(&data_dir),
                db::emoji_dir(&data_dir),
                // pptx→pdf 파생 캐시 — 프런트가 convertFileSrc 로 여는 대상이라 여기 없으면
                // asset.localhost 가 403 으로 조용히 막는다(위 주석의 그 사고).
                db::slide_cache_dir(&data_dir),
                // 내려받기 글꼴(PLAN-2026-10-27-fonts) — 지연 로더가 FontFace 로 asset URL 을 읽는다.
                repo::fonts::fonts_dir(&data_dir),
            ] {
                let _ = std::fs::create_dir_all(&dir);
                let canon = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
                if let Err(e) = scope.allow_directory(&canon, true) {
                    diag::warn(
                        "boot",
                        "asset_scope_allow_failed",
                        format!("{}: {e}", canon.file_name().and_then(|n| n.to_str()).unwrap_or("?")),
                    );
                }
                // MSIX/AppContainer 파일 가상화(예: 샌드박스 셸이 띄운 dev 앱): 새 파일 쓰기가
                // Packages\…\LocalCache 오버레이로 리다이렉트되어, 파일 canonicalize 가 위에서
                // 허용한 디렉토리와 다른 곳을 가리키면 그 파일은 전부 403 이 된다. 프로브 파일로
                // 리다이렉트를 감지해 오버레이 디렉토리도 함께 허용한다(가상화 없으면 no-op).
                let probe = dir.join(".asset-scope-probe");
                if std::fs::write(&probe, b"").is_ok() {
                    if let Ok(canon_file) = std::fs::canonicalize(&probe) {
                        if let Some(parent) = canon_file.parent() {
                            if parent != canon {
                                let _ = scope.allow_directory(parent, true);
                            }
                        }
                    }
                    let _ = std::fs::remove_file(&probe);
                }
            }
            // R3 사고 대응: 이전에는 bootstrap 실패가 여기서 그대로 Err으로 전파돼 아래
            // .run().expect()가 패닉했다. main.rs는 release 빌드에서 windows_subsystem="windows"로
            // 콘솔을 숨기므로(콘솔창 금지 주석 참조) 그 패닉 메시지는 완전히 사라지고, 사용자에게는
            // 앱이 "그냥 안 켜짐"으로만 보였다(P0, 비개발자는 원인을 알 방법이 없음). 메인 창을
            // 띄우기 전이라도 네이티브 블로킹 다이얼로그는 표시할 수 있으므로, 여기서 실패 원인과
            // 백업 위치를 보여주고 숨은 패닉 대신 명시적으로 종료한다.
            boot_timing::mark("pre_bootstrap");
            let conn = match db::bootstrap(&data_dir) {
                Ok(conn) => conn,
                Err(e) => {
                    app.dialog()
                        .message(format!(
                            "{e}\n\n데이터 백업 위치: {}",
                            db::backups_dir(&data_dir).display()
                        ))
                        .title("Brise를 시작할 수 없습니다")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            // 시작 시 고아 첨부 디렉토리 청소 (실패 무시).
            boot_timing::mark("bootstrap");
            // 본 창(아직 숨김)의 크기·위치를 여기서 복원한다 — 프런트가 설정을 다 읽은 뒤 IPC 사슬로 하던 것을
            // 웹뷰가 페이지를 읽는 동안 끝내 둔다(window_geometry.rs 머리 주석). 최대화는 프런트가 표시 직전에.
            if let Some(w) = app.get_webview_window("main") {
                let s = repo::settings::get_all(&conn).unwrap_or_default();
                window_geometry::restore(&w, s.get("window_geometry"));
            }
            boot_timing::mark("geometry");
            let _ = repo::attachments::orphan_cleanup(&conn, &data_dir);
            // 같은 이유로 슬라이드 변환 캐시도 — 첨부가 사라지면 그 변환본(수십~수백 MB)은
            // 다시 변환될 일이 없어 영원히 남는다.
            let _ = repo::slide_render::orphan_cleanup(&conn, &data_dir);
            // 지난 실행의 백업 스테이징 잔해 청소 — 이 프로세스의 어떤 백업(아래 auto_backup·티커, AppState 뒤의 IPC)보다도 앞이고 single-instance 라 진행 중인 걸 지울 수 없다.
            repo::transfer::backup::cleanup_stale_staging(&data_dir);
            boot_timing::mark("orphan_cleanup");
            // Settings redesign (Données ②): 사용자 스케줄 기반 전체 zip 자동 백업 — bootstrap()
            // 안이 아니라 여기서 호출한다(db::maybe_spawn_auto_backup 주석 참고: bootstrap()은
            // 테스트에서 임시 디렉토리에 반복 호출되므로 그 안에 넣으면 테스트마다 백그라운드
            // 스레드가 뜬다).
            db::maybe_spawn_auto_backup(&conn, &data_dir);
            // 부팅 때만 보면 며칠 켜 둔 앱은 스케줄이 안 지켜진다 — 6시간마다 재확인.
            db::start_auto_backup_ticker(data_dir.clone());
            // P3 수집 관문(docs/PLAN-2026-08-07-second-brain.md Q6): RSS 등 소스 어댑터 실행 워커 —
            // 별도 스레드/커넥션으로 띄운다.
            boot_timing::mark("backup_spawn");
            collect::start(data_dir.clone());
            // 일정 알림 틱(docs/PLAN-schedule-system.md §4.3) — 위 둘과 같은 이유·같은 모양의 세
            // 번째 백그라운드 워커. 차이는 AppHandle 을 들고 있다는 것뿐(알림을 쏘아야 하므로).
            repo::schedule::start(app.handle().clone(), data_dir.clone());
            // 동기화(beta): SyncState 를 먼저 관리해야 boot autostart 가 서버 핸들을 저장할 자리가
            // 있다. AppState(다음 줄)와 같은 이유로 bootstrap() 밖, 부팅 경로 전용 — sync_server::
            // mod.rs 주석 참고.
            // 변경 통지 버스에 웹뷰 emit 대상 등록 — 서버 기동보다 먼저(부팅 직후의 쓰기도 놓치지 않게).
            events::set_app_handle(app.handle().clone());
            app.manage(sync_server::SyncState::default());
            sync_server::maybe_start_at_boot(app.handle(), &conn, &data_dir);
            // 캡처 ingest 리스너(결제문자 /ledger) — 같은 패턴의 **별개** 서버다: sync_enabled 와
            // 무관하게 capture_ledger_enabled 만 본다.
            app.manage(sync_server::ingest::IngestState::default());
            sync_server::ingest::maybe_start_at_boot(app.handle(), &conn, &data_dir);
            boot_timing::mark("workers_sync");
            // 읽기 전용 연결을 같이 연다 — 채팅 근거 검색이 전역 잠금 밖에서 돈다(commands::AppState::with_read).
            app.manage(commands::AppState::new_with_read_handle(conn, data_dir));
            // AI 호출 로그(PLAN-2026-09-05-ai-guardrails.md §3 C-1~C-4) — data_dir(DB 와 같은
            // 앱 데이터 디렉터리)·ai_debug_verbose 스냅샷을 부팅 시 한 번 전역에 심는다.
            // AppState 배선 없이 RealTextTransport::new/RealVisionTransport::new 가 어디서
            // 만들어지든(commands::ai/pet/collect/suggestions, collect::summary,
            // sync_server::ingest) 자동으로 로그가 붙는다 — repo::ai::call_log 헤더 주석의
            // ponytail 한계: ai_debug_verbose 를 설정 화면에서 바꿔도 재시작 전까지는 그대로다.
            {
                let state = app.state::<commands::AppState>();
                let verbose = {
                    let conn = state.db.lock();
                    repo::settings::get_all(&conn)
                        .unwrap_or_default()
                        .get("ai_debug_verbose")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                };
                repo::ai::call_log::init(state.data_dir.clone(), verbose);
                // diag::init은 더 위(data_dir 해석 직후, db::bootstrap 이전)로 옮겼다 — 여기
                // 두면 부트스트랩 도중의 진단이 파일에 못 남는다(위 이동 지점의 주석 참고).
            }
            // 트레이 상주 — 무조건 부팅 시 만든다(더 이상 close_to_tray 설정에 안 물려 있다,
            // tray.rs 헤더 주석 참고). 종료는 트레이 "종료" 메뉴로만.
            app.manage(tray::TrayHandles::default());
            let _ = tray::ensure_tray(app.handle());
            // 펫 창(W6-d1, W8-g 2단계 노출) — 부팅 시 마스터(pet_enabled)와 표시(pet_visible)가
            // 둘 다 켜져 있으면 메인 창 부팅 시퀀스 뒤에 만든다(트레이/타이틀바 토글은 tray.rs
            // 의 reconcile 이 소유, 여기는 마지막 저장 상태 복원만 — AND 를 여기서 다시 계산하되
            // tray::reconcile 과 같은 규칙: enabled=="1" && visible!="0"). conn은 위에서 이미
            // AppState로 move됐으므로 여기서는 AppState 를 통해 다시 잠근다.
            let (pet_enabled, pet_visible) = {
                let state = app.state::<commands::AppState>();
                let conn = state.db.lock();
                let s = repo::settings::get_all(&conn).unwrap_or_default();
                let enabled = s.get("pet_enabled").and_then(|v| v.as_str()).map(str::to_string);
                let visible = s.get("pet_visible").and_then(|v| v.as_str()).map(str::to_string);
                (enabled, visible)
            };
            if pet_enabled.as_deref() == Some("1") && pet_visible.as_deref() != Some("0") {
                let _ = pet_window::ensure_pet_window(app.handle());
            }
            // 창을 닫을 때(X 버튼) settings.close_to_tray(기본 true)에 따라 트레이로 숨기거나
            // 실제 종료한다 — 매 CloseRequested 이벤트마다 다시 읽으므로(tray::close_to_tray_setting)
            // 설정 화면에서 바꾸면 재시작 없이 바로 반영된다.
            if let Some(w) = app.get_webview_window("main") {
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 프론트엔드의 onCloseRequested(flushAll() 실행)가 비동기 저장을 완료한 후
                        // window_close_confirmed 커맨드를 호출하도록 네이티브 즉시 종료를 방어한다.
                        //
                        // ponytail: prevent_close() 는 무조건이라 웹뷰가 멈춰/백지 상태면(이 저장소의
                        // 알려진 실패 모드) window_close_confirmed 가 영영 안 오고 X 버튼이 죽는다.
                        // 짧은 타이머로 강제 종료하는 폴백은 flushAll() 이 실제로 얼마나 걸릴지 모르는
                        // 채로 "저장 중일 뿐"과 "영영 안 옴"을 구분해야 해서(너무 짧으면 데이터 유실,
                        // 너무 길면 폴백 의미 없음) 진짜 신호(예: flush 시작/완료 이벤트) 없이는 안전하게
                        // 못 짠다 — 여기서는 스킵. 필요해지면 프런트가 flush 시작 시 별도 커맨드로
                        // "flush 진행 중" 플래그를 세팅하게 하고, 그 플래그가 없을 때만 타이머 폴백을 태운다.
                        api.prevent_close();
                    }
                });
            }
            // H2 failsafe: window starts hidden (`visible: false`). If the webview never
            // reaches getCurrentWindow().show() (JS exception / hang), reveal after ~5s so
            // the user is not stuck with an invisible, unclosable app. Never panics. Skips if
            // the window is invisible because the user deliberately closed it to tray in the
            // meantime — tray::TrayHandles::hidden_to_tray, set by tray::hide_to_tray (the single
            // chokepoint every tray-hide path routes through — currently window_close_confirmed) —
            // otherwise this would un-hide a legitimate tray-close.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    if let Some(handles) = handle.try_state::<tray::TrayHandles>() {
                        if handles.hidden_to_tray.load(std::sync::atomic::Ordering::Relaxed) {
                            return;
                        }
                    }
                    if let Some(w) = handle.get_webview_window("main") {
                        let already = w.is_visible().unwrap_or(false);
                        if !already {
                            // 웹뷰가 5초 안에 getCurrentWindow().show()를 못 불렀다는 뜻 —
                            // JS 예외/행 상태일 수 있으니 남긴다(§3 G1, 이 failsafe 자체가
                            // "원인 미기록"이었다).
                            diag::warn("boot", "window_force_shown", "main window did not call show() within 5s failsafe window");
                            let _ = w.show();
                        }
                    }
                });
            }
            boot_timing::mark("setup_end");
            boot_timing::flush();
            Ok(())
        })
        .invoke_handler(move |invoke| {
            // 펫 창에서 온 호출은 allowlist 밖이면 여기서 끝난다(핸들러까지 가지 않는다).
            let label = invoke.message.webview_ref().label().to_string();
            if pet_window::is_pet_label(&label) && !pet_window::is_pet_command_allowed(invoke.message.command()) {
                invoke
                    .resolver
                    .reject("command not allowed from the pet window");
                return true;
            }
            // 모든 앱 커맨드가 지나는 자리 — 부른 창의 라벨을 실행 동안 주변에 둔다. 그 안의 publish 는
            // payload 에 `window` 로 실어, 각 창이 자기 쓰기의 메아리만 거를 수 있다(events.rs::scope_window,
            // async 커맨드는 이 스코프 밖에서 돌아 null — 쓰기를 알리는 async 커맨드는 `webview` 를 받아
            // events::publish_as 로 직접 싣는다. 거기 ponytail).
            events::scope_window(&label, || app_commands(invoke))
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 정상 종료 시에만 clean-shutdown 마커를 남긴다. 강제 종료/크래시는 마커가 없어
            // 다음 부팅에서 PRAGMA quick_check 가 돈다(R3).
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<commands::AppState>() {
                    // 세션 동안 실제로 쓴 테이블만 재분석. 부팅 시 PRAGMA optimize 는
                    // 테이블을 건드리지 않은 연결에서 무효(sqlite_stat1 불변). analysis_limit
                    // 으로 대형 코퍼스에서도 종료가 늘어지지 않게 한다. 종료를 막거나 panic 하면 안 됨.
                    {
                        let conn = state.db.lock();
                        let _ = conn.pragma_update(None, "analysis_limit", 400);
                        let _ = conn.execute_batch("PRAGMA optimize");
                    }
                    db::mark_clean_shutdown(&state.data_dir);
                }
            }
        });
}
