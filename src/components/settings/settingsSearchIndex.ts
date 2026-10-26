/**
 * 설정 검색 색인 (PLAN-2026-10-24 W4) — **데이터뿐이다**. 섹션 컴포넌트·지연 화면을 import 하지 않는다
 * (설정 창 부팅 경로로 지연 화면이 끌려온다). 표시·매칭은 런타임 `t()` 라 ko/en/fr 로 다 검색된다.
 *
 * - `page` = SettingsPanel 의 페이지 id. `anchor` = 행/카드에 단 앵커 이름(`SettingsRow anchor=…`,
 *   `anchorId("…")`). 없으면 그 페이지만 연다 — 상태에 따라 안 그려지는 행(펫·동기화 세부, 저장된 값에
 *   따라 나오는 행)이 그렇다.
 * - `groupKey` = 그 행이 든 카드의 제목 키 → 결과에 "페이지 › 그룹" 으로 보인다.
 * - `requires` = 그 상태일 때만 행이 그려진다: "ai"(AI 꺼짐이면 본문이 접힌다) · "desktop"(브라우저/태블릿
 *   모드엔 없다). 안 맞으면 선택 시 앵커 없이 페이지만 연다(anchor_not_found 진단 소음 방지).
 * - 새 설정을 만들 때는 `docs/SETTINGS.md` 의 "검색에 등록" 절차를 따른다. 표류는
 *   `settingsSearchIndex.test.ts` 가 막는다(키 실재 · 페이지 id · 소스에 앵커 실재 · 중복).
 */
export type SettingsSearchRequires = "ai" | "desktop";

export interface SettingsSearchEntry {
  page: string;
  /** 없으면 페이지만 연다. 이름은 snake_case, 한 페이지 안에서 유일. */
  anchor?: string;
  labelKey: string;
  groupKey?: string;
  /** 흔한 동의어 문자열(공백으로 이어 쓴 i18n 값) — 라벨에 없는 말로도 찾게 한다. */
  keywordKeys?: string[];
  requires?: SettingsSearchRequires;
}

const KW_BACKUP = "settings.search_kw_backup";
const KW_THEME = "settings.search_kw_theme";
const KW_FONT = "settings.search_kw_font";
const KW_SYNC = "settings.search_kw_sync";
const KW_NOTIFY = "settings.search_kw_notify";
const KW_AI = "settings.search_kw_ai";

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // ── 페이지 자체(앵커 없음 — 페이지만 연다) ──
  { page: "general", labelKey: "settings.page_general" },
  { page: "editor", labelKey: "settings.page_editor" },
  { page: "notifications", labelKey: "settings.page_notifications", keywordKeys: [KW_NOTIFY] },
  { page: "appearance", labelKey: "settings.appearance", keywordKeys: [KW_THEME] },
  { page: "view", labelKey: "settings.page_view" },
  { page: "dashboard", labelKey: "settings.page_dashboard" },
  { page: "collect", labelKey: "settings.page_collect" },
  { page: "connect", labelKey: "settings.page_connect", keywordKeys: [KW_SYNC] },
  { page: "ai", labelKey: "settings.page_ai", keywordKeys: [KW_AI] },
  { page: "ai_permissions", labelKey: "settings.page_ai_permissions" },
  { page: "ai_features", labelKey: "settings.page_ai_features" },
  { page: "ai_presets", labelKey: "settings.page_ai_presets" },
  { page: "ai_chat", labelKey: "settings.page_ai_chat" },
  { page: "data", labelKey: "settings.data_management", keywordKeys: [KW_BACKUP] },
  { page: "license", labelKey: "settings.page_license" },
  { page: "pet", labelKey: "settings.pet" },
  { page: "briefing", labelKey: "settings.page_briefing" },

  // ── 일반 ──
  { page: "general", anchor: "update_check_auto", labelKey: "settings.update_check_auto", requires: "desktop" },
  { page: "general", anchor: "ui_language", labelKey: "settings.ui_language", groupKey: "settings.app_behavior" },
  { page: "general", anchor: "autostart", labelKey: "settings.autostart", groupKey: "settings.app_behavior", requires: "desktop" },
  { page: "general", anchor: "close_to_tray", labelKey: "settings.close_to_tray", groupKey: "settings.app_behavior", requires: "desktop" },
  { page: "general", anchor: "capture_screenshot", labelKey: "settings.pet_capture_screenshot", groupKey: "settings.app_behavior", requires: "desktop" },
  // 화면 저장 폴더는 캡처 토글이 켜졌을 때만 그려진다 → 앵커 없음.
  { page: "general", labelKey: "settings.capture_dir", groupKey: "settings.app_behavior" },
  { page: "general", anchor: "onboarding", labelKey: "onboarding.title", groupKey: "settings.app_behavior" },

  // ── 에디터 ──
  { page: "editor", anchor: "date_nudge_mode", labelKey: "settings.date_nudge_mode_label", groupKey: "settings.editor_auto_suggest_group" },
  { page: "editor", anchor: "region_nudge_mode", labelKey: "settings.region_nudge_mode_label", groupKey: "settings.editor_auto_suggest_group" },
  { page: "editor", anchor: "original_policy", labelKey: "settings.original_policy", groupKey: "settings.editor_paste_drop_group" },
  { page: "editor", anchor: "paste_link_nudge", labelKey: "settings.paste_link_nudge_label", groupKey: "settings.editor_paste_drop_group" },
  { page: "editor", anchor: "paste_path_inline_code", labelKey: "settings.paste_path_inline_code_label", groupKey: "settings.editor_paste_drop_group" },
  { page: "editor", anchor: "paste_table_sheet_suggest", labelKey: "settings.paste_table_sheet_suggest_label", groupKey: "settings.editor_paste_drop_group" },
  { page: "editor", anchor: "editor_md_autoformat", labelKey: "settings.editor_md_autoformat_label", groupKey: "settings.editor_input_group" },
  { page: "editor", anchor: "link_open_on_click", labelKey: "settings.link_open_on_click_label", groupKey: "settings.editor_input_group" },
  { page: "editor", anchor: "new_note_date_precision", labelKey: "settings.new_note_date_precision_label", groupKey: "settings.editor_new_note_group" },
  { page: "editor", anchor: "new_note_section_name", labelKey: "settings.new_note_section_name_label", groupKey: "settings.editor_new_note_group" },
  { page: "editor", anchor: "editor_full_width", labelKey: "settings.editor_full_width_label", groupKey: "settings.editor_display_group" },
  { page: "editor", anchor: "editor_width", labelKey: "settings.editor_width_label", groupKey: "settings.editor_display_group" },
  { page: "editor", anchor: "editor_word_count", labelKey: "settings.editor_word_count_label", groupKey: "settings.editor_display_group" },
  { page: "editor", anchor: "spellcheck_enabled", labelKey: "settings.spellcheck_enabled_label", groupKey: "settings.editor_display_group" },

  // ── 알림 및 일정 ──
  { page: "notifications", anchor: "week_start", labelKey: "settings.week_start", groupKey: "settings.view_calendar_section" },
  { page: "notifications", anchor: "holiday_region", labelKey: "settings.holiday_region", groupKey: "settings.view_calendar_section" },
  { page: "notifications", anchor: "day_marks", labelKey: "dayMarks.section" },
  { page: "notifications", anchor: "routines", labelKey: "settings.timeline_routine_section", requires: "desktop" },
  { page: "notifications", anchor: "notifications_enabled", labelKey: "settings.notifications_enabled", groupKey: "settings.notifications_group", keywordKeys: [KW_NOTIFY] },
  { page: "notifications", anchor: "notifications_all_day_at", labelKey: "settings.notifications_all_day_at", groupKey: "settings.notifications_group" },

  // ── 모양 ──
  { page: "appearance", anchor: "theme", labelKey: "settings.theme", groupKey: "settings.appearance_group_theme", keywordKeys: [KW_THEME] },
  { page: "appearance", anchor: "surface_style", labelKey: "settings.surface_style", groupKey: "settings.appearance_group_theme", requires: "desktop" },
  // 시트 불투명도는 아크릴을 고른 데스크톱에서만 그려진다 → 앵커 없음.
  { page: "appearance", labelKey: "settings.sheet_opacity", groupKey: "settings.appearance_group_theme" },
  { page: "appearance", anchor: "accent_color", labelKey: "settings.accent_color", groupKey: "settings.appearance_group_theme" },
  { page: "appearance", anchor: "theme_import", labelKey: "settings.theme_import", groupKey: "settings.appearance_group_theme", requires: "desktop" },
  { page: "appearance", anchor: "theme_export", labelKey: "settings.theme_export", groupKey: "settings.appearance_group_theme", requires: "desktop" },
  { page: "appearance", anchor: "theme_reset", labelKey: "settings.theme_reset", groupKey: "settings.appearance_group_theme", requires: "desktop" },
  { page: "appearance", anchor: "font_family", labelKey: "settings.font_family", groupKey: "settings.appearance_group_font", keywordKeys: [KW_FONT] },
  { page: "appearance", anchor: "font_scale", labelKey: "settings.font_scale", groupKey: "settings.appearance_group_font", keywordKeys: [KW_FONT] },
  { page: "appearance", anchor: "bg_brightness", labelKey: "settings.bg_brightness", groupKey: "settings.appearance_group_font" },
  { page: "appearance", anchor: "bg_saturation", labelKey: "settings.bg_saturation", groupKey: "settings.appearance_group_font" },
  { page: "appearance", anchor: "content_tint", labelKey: "settings.content_tint", groupKey: "settings.appearance_group_font" },

  // ── 지역 및 날씨 ──
  { page: "view", anchor: "region_enabled", labelKey: "settings.region_enabled" },
  { page: "view", anchor: "weather", labelKey: "settings.region_weather_environment" },

  // ── 대시보드 ──
  { page: "dashboard", anchor: "dashboard_tabs", labelKey: "settings.dashboard_top_tabs" },
  { page: "dashboard", anchor: "status_add_locked", labelKey: "settings.status_add_locked", groupKey: "home.tab_board" },

  // ── 수집 ──
  { page: "collect", anchor: "collect_enabled", labelKey: "settings.collect_enabled_label" },
  { page: "collect", anchor: "sources", labelKey: "settings.collect_sources_title" },
  { page: "collect", anchor: "add", labelKey: "settings.collect_add_source", groupKey: "settings.collect_sources_title" },
  { page: "collect", anchor: "detect", labelKey: "settings.collect_detect_btn", groupKey: "settings.collect_sources_title" },
  { page: "collect", anchor: "excluded_domains", labelKey: "settings.collect_excluded_section" },

  // ── 연결 — 세부 행은 서버가 켜졌을 때만 그려진다(켜졌는지는 IPC 상태라 색인이 모른다) → 앵커 없음 ──
  { page: "connect", anchor: "sync_enable", labelKey: "settings.sync_enable", keywordKeys: [KW_SYNC] },
  { page: "connect", labelKey: "settings.sync_url_label", groupKey: "settings.sync_title" },
  { page: "connect", labelKey: "settings.sync_token_label", groupKey: "settings.sync_title" },
  { page: "connect", labelKey: "settings.sync_port_label", groupKey: "settings.sync_title" },

  // ── AI 연결 — 마스터 행 밖은 AI 가 꺼지면 접힌다 ──
  { page: "ai", anchor: "ai_master", labelKey: "settings.enable_ai_features", keywordKeys: [KW_AI] },
  // 키 행은 Ollama 에선 안 그려진다(프로바이더 상태) → 앵커 없음.
  { page: "ai", labelKey: "settings.api_key_label", groupKey: "settings.ai_group_auth", requires: "ai" },
  { page: "ai", anchor: "ai_endpoint", labelKey: "settings.endpoint_label", groupKey: "settings.ai_group_auth", requires: "ai" },
  { page: "ai", anchor: "ai_model", labelKey: "settings.model_label", groupKey: "settings.ai_group_models", requires: "ai" },
  { page: "ai", anchor: "ai_model_fallback", labelKey: "settings.model_fallback_label", groupKey: "settings.ai_group_models", requires: "ai" },
  { page: "ai", anchor: "ai_link_suggest_model", labelKey: "settings.collect_link_suggest_model", groupKey: "settings.ai_group_models", requires: "ai" },
  { page: "ai", anchor: "ai_test_connection", labelKey: "settings.test_connection", groupKey: "settings.ai_group_diag", requires: "ai" },

  // ── AI 권한 ──
  { page: "ai_permissions", anchor: "perm_chat_read_history", labelKey: "settings.chat_perm_read_history", groupKey: "settings.ai_perm_read_title" },
  { page: "ai_permissions", anchor: "perm_chat_read_files", labelKey: "settings.chat_perm_read_files", groupKey: "settings.ai_perm_read_title" },
  { page: "ai_permissions", anchor: "perm_chat_write_enabled", labelKey: "settings.chat_perm_write_notes", groupKey: "settings.ai_perm_write_title" },
  { page: "ai_permissions", anchor: "perm_collect_chat_register", labelKey: "settings.ai_perm_collect_register_short", groupKey: "settings.ai_perm_write_title" },
  { page: "ai_permissions", anchor: "perm_ai_confirm_before_apply", labelKey: "settings.ai_confirm_before_apply", groupKey: "settings.ai_perm_safety_title" },
  { page: "ai_permissions", anchor: "perm_ai_debug_verbose", labelKey: "settings.ai_perm_debug_verbose_short", groupKey: "settings.ai_perm_safety_title" },

  // ── AI 기능 — 기능별 토글은 카탈로그 데이터라 색인하지 않는다(그 페이지의 자체 검색칸이 맡는다) ──
  { page: "ai_features", anchor: "ai_policy_level", labelKey: "settings.ai_policy_level_title" },
  { page: "ai_features", anchor: "ai_actions", labelKey: "ai.actions_section", requires: "ai" },

  // ── AI 채팅 — 페르소나·기록 지우기는 AI 연결 상태(Ollama 포함)에 따라 갈려 앵커 없음 ──
  { page: "ai_chat", labelKey: "settings.pet_persona", groupKey: "settings.chat_group_assistant" },
  { page: "ai_chat", labelKey: "settings.pet_chat_clear", groupKey: "settings.chat_group_assistant" },
  { page: "ai_chat", anchor: "user_name", labelKey: "settings.user_name", groupKey: "settings.chat_group_profile" },
  { page: "ai_chat", anchor: "ai_chat_sidebar_visible", labelKey: "settings.ai_chat_sidebar_visible", groupKey: "settings.chat_group_profile" },
  { page: "ai_chat", anchor: "chat_permissions", labelKey: "settings.chat_permissions" },
  { page: "ai_chat", anchor: "ai_chat_memory", labelKey: "aiCapabilities.ai_chat_memory_name", groupKey: "settings.chat_memory_title" },

  // ── 데이터 관리 ──
  { page: "data", anchor: "attachment_storage_mode", labelKey: "settings.attachment_storage_mode", groupKey: "settings.attachment_storage_section" },
  { page: "data", anchor: "slide_preview", labelKey: "settings.slide_preview", groupKey: "settings.attachment_storage_section" },
  { page: "data", anchor: "soffice_path", labelKey: "settings.soffice_path", groupKey: "settings.attachment_storage_section" },
  { page: "data", anchor: "storage_backup", labelKey: "settings.storage_backup_group", keywordKeys: [KW_BACKUP] },
  { page: "data", anchor: "data_location", labelKey: "settings.data_location_row", groupKey: "settings.storage_backup_group" },
  { page: "data", anchor: "backup_auto", labelKey: "settings.backup_auto", groupKey: "settings.storage_backup_group", keywordKeys: [KW_BACKUP] },
  { page: "data", anchor: "export_notebook", labelKey: "settings.export_notebook", groupKey: "settings.transfer_tile" },
  { page: "data", labelKey: "settings.import_notebook", groupKey: "settings.transfer_tile" },
  { page: "data", anchor: "danger_zone", labelKey: "settings.danger_zone", requires: "desktop" },
  { page: "data", anchor: "backup_all", labelKey: "settings.backup_all", groupKey: "settings.danger_zone", keywordKeys: [KW_BACKUP], requires: "desktop" },
  { page: "data", anchor: "restore_all", labelKey: "settings.restore_all", groupKey: "settings.danger_zone", keywordKeys: [KW_BACKUP], requires: "desktop" },
  { page: "data", anchor: "reset_db", labelKey: "settings.reset_db", groupKey: "settings.danger_zone", requires: "desktop" },

  // ── 라이선스 ──
  { page: "license", labelKey: "settings.license_open_external" },

  // ── 펫 — 마스터 행 밖은 펫이 켜졌을 때만 그려진다(IPC 상태) → 앵커 없음 ──
  { page: "pet", anchor: "pet_enable", labelKey: "settings.pet_enable" },
  { page: "pet", labelKey: "settings.pet_character_section" },
  { page: "pet", labelKey: "settings.pet_dblclick_action", groupKey: "settings.pet_group_behavior" },
  { page: "pet", labelKey: "settings.pet_position_section" },

  // ── 브리핑 ──
  { page: "briefing", anchor: "briefing_enable", labelKey: "settings.briefing_enable" },
  { page: "briefing", anchor: "schedule", labelKey: "settings.briefing_schedule_section" },
  { page: "briefing", anchor: "briefing_when", labelKey: "settings.briefing_when", groupKey: "settings.briefing_schedule_section" },
  // 시각 행은 "표시 시점" 값에 따라 나온다 → 앵커 없음.
  { page: "briefing", labelKey: "settings.briefing_time", groupKey: "settings.briefing_schedule_section" },
  { page: "briefing", anchor: "briefing_evening", labelKey: "settings.briefing_evening", groupKey: "settings.briefing_schedule_section" },
  { page: "briefing", labelKey: "settings.briefing_evening_time", groupKey: "settings.briefing_schedule_section" },
  { page: "briefing", anchor: "briefing_notify", labelKey: "settings.briefing_notify", groupKey: "settings.briefing_schedule_section", keywordKeys: [KW_NOTIFY] },
  { page: "briefing", anchor: "phrase_packs", labelKey: "settings.phrase_packs" },
  { page: "briefing", anchor: "phrase_pack_active", labelKey: "settings.phrase_pack_active", groupKey: "settings.phrase_packs" },
  { page: "briefing", anchor: "habits", labelKey: "settings.briefing_habits_section" },
  { page: "briefing", anchor: "habits_add", labelKey: "settings.briefing_habit_add", groupKey: "settings.briefing_habits_section" },
  { page: "briefing", anchor: "routines", labelKey: "settings.timeline_routine_section" },
];
