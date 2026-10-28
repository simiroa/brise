/**
 * 단순 설정(스토어의 `setSimplePref` 가 낙관적 갱신 + `settings_set` 하는 키들)의 **기술자 표**와 열거형 값 목록.
 *
 * 왜 이 파일인가: 단순 키 하나를 추가하려면 예전엔 settings.ts 안에서 타입 유니온 · interface 필드 · 기본값 · `SimplePrefKey` 유니온 ·
 * 강제 변환 표를 손으로 맞춰 고쳐야 했고, UI 옵션 목록이 또 하나의 사본이었다 — 이미 표류가 하나 생겼다(초기 글꼴 "pretendard" ↔ 강제 변환
 * 폴백 "serif"). 이제 값 목록은 `as const` 배열 하나(UI 옵션도 이걸 import — 라벨 i18n 만 UI 몫)이고, 타입·`SimplePrefKey`·기본값
 * (`coerce(undefined)`)은 이 표에서 파생된다. Rust 쪽 검증(settings_schema.rs)과의 일치는 prefs.test.ts 가 파일을 직접 읽어 대조한다.
 */
import { DEFAULT_APPEARANCE_SEED, CONTENT_TINT_MIN, CONTENT_TINT_MAX } from "../lib/appearance";
import { DEFAULT_FONT_MONO } from "../lib/fonts/stacks";
import { normalizeFilterRoster, normalizeDashboardTabs } from "../lib/settingsNormalize";
import { clamp } from "../lib/ui";
import type { ChatMemoryItem, SettingsState } from "./settings";

// ── 열거형 값 목록 — 타입은 여기서 끌어내고, UI 옵션 목록과 Rust 대조 테스트가 같은 배열을 쓴다 ───────────────────
export const WEEK_STARTS = ["sunday", "monday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];
export const TIMELINE_RANGES = ["fit", "around_now", "recent_3m", "recent_1y"] as const;
export type TimelineDefaultRange = (typeof TIMELINE_RANGES)[number];
export const BOARD_DONE_AUTOHIDE = ["off", "7d", "30d"] as const;
export type BoardDoneAutohide = (typeof BOARD_DONE_AUTOHIDE)[number];
export const GALLERY_TILE_SIZES = ["small", "medium", "large"] as const;
export type GalleryTileSize = (typeof GALLERY_TILE_SIZES)[number];
export const GALLERY_SORTS = ["newest", "oldest", "name"] as const;
export type GallerySort = (typeof GALLERY_SORTS)[number];
/** 달력 공휴일 지역 — 날짜 표는 lib/holidays.ts, 백엔드 allowlist 는 `holiday_region`. */
export const HOLIDAY_REGIONS = ["none", "kr", "fr"] as const;
export type HolidayRegion = (typeof HOLIDAY_REGIONS)[number];
export const ATTACHMENT_STORAGE_MODES = ["copy", "link", "reference"] as const;
export type AttachmentStorageMode = (typeof ATTACHMENT_STORAGE_MODES)[number];
export const SLIDE_PREVIEWS = ["auto", "off"] as const;
export type SlidePreview = (typeof SLIDE_PREVIEWS)[number];
/** 본문 최대 폭(editor_width). "normal"(기본) = 오늘까지의 800px 상한. editorFullWidth(전체
 *  너비)가 켜져 있으면 이 값은 쓰이지 않는다 — 설정 화면이 그 상태의 행을 잠근다. */
export const EDITOR_WIDTHS = ["narrow", "normal", "wide"] as const;
export type EditorWidth = (typeof EDITOR_WIDTHS)[number];
/** 새 노트가 받는 오늘 날짜의 정밀도(new_note_date_precision). "day"(기본) = 오늘까지의 동작
 *  (연·월·일까지). 노트별로 언제든 바꿀 수 있으므로 이 값은 "새로 만들 때의 시작값"만 정한다. */
export const NEW_NOTE_DATE_PRECISIONS = ["day", "month", "year"] as const;
export type NewNoteDatePrecision = (typeof NEW_NOTE_DATE_PRECISIONS)[number];
/** S2 입력(docs/PLAN-2026-10-06-s2-input.md §1.1) — 사진·음성·위치가 공유하는 3단 자동 정책.
 *  auto = 묻지 않고 반영 + 되돌리기 토스트, ask = 제안만, off = 반영하지 않음. */
export const INPUT_AUTO_MODES = ["off", "ask", "auto"] as const;
export type InputAutoMode = (typeof INPUT_AUTO_MODES)[number];
export const BRIEFING_WHENS = ["time", "launch", "manual"] as const;
export type BriefingWhen = (typeof BRIEFING_WHENS)[number];
/** 자동 표시 방식 — 창 / OS 알림 한 줄 / 둘 다(W10). */
export const BRIEFING_NOTIFIES = ["window", "os", "both"] as const;
export type BriefingNotify = (typeof BRIEFING_NOTIFIES)[number];
export const PET_DBLCLICK_ACTIONS = ["chat", "new_note", "off"] as const;
export type PetDblclickAction = (typeof PET_DBLCLICK_ACTIONS)[number];

/** 글꼴 패밀리의 기본값 — 초기 상태·강제 변환 폴백·Rust 시드(settings_schema.rs "font_family")가 모두 이 값이다. */
export const DEFAULT_FONT_FAMILY: string = DEFAULT_APPEARANCE_SEED.fontFamily ?? "pretendard";

// ── 변환 도우미 ──────────────────────────────────────────────────────────────────────────────
/** 목록 안의 값이면 그대로, 아니면 `def` — 열거형 설정의 강제 변환. */
export const oneOf =
  <T extends readonly string[]>(list: T, def: T[number]) =>
  (raw: unknown): T[number] =>
    list.includes(raw as string) ? (raw as T[number]) : def;
/** `lo..=hi` 범위의 정수면 그대로, 아니면 `def` — 백엔드 validate_setting 의 범위와 같은 숫자를 쓴다. */
export const intIn =
  (lo: number, hi: number, def: number) =>
  (raw: unknown): number =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= lo && raw <= hi ? raw : def;

// Mercator scale k ∈ [1, 400] (useMapPanZoom). k=1 ≈ whole world; k=50 ≈ 7.2° lon (country/wide);
// k=150 ≈ 2.4° lon city-scale so labels are visible (city dots k≥20, city labels k≥32).
// Named so migrations / MapSection reset share the same city-level default.
export const FACTORY_DEFAULT_MAP_ZOOM = 150.0 as const;

// Factory fallback for defaultMapLocation (Seoul) — used both as the store's initial value and
// to detect "user never touched onboarding's location step" (see lib/weather.ts's location
// priority chain: this exact coordinate is treated as "workspace default not set").
export const FACTORY_DEFAULT_MAP_LOCATION = {
  lat: 37.5665,
  lng: 126.978,
  zoom: FACTORY_DEFAULT_MAP_ZOOM,
} as const;

export interface PrefDescriptor<K extends keyof SettingsState> {
  camel: K;
  snake: string;
  coerce: (raw: unknown) => SettingsState[K];
}

function pref<K extends keyof SettingsState>(
  camel: K,
  snake: string,
  coerce: (raw: unknown) => SettingsState[K],
): PrefDescriptor<K> {
  return { camel, snake, coerce };
}

const boolDefaultFalse = (raw: unknown) => Boolean(raw);
// §3b collect_detect_pending — 숫자가 아니면(부재 포함) 0. 백엔드가 0..=99로 검증하므로 여기는
// 방어적 clamp까지는 하지 않는다(잘못된 값이 저장돼 있었다면 그 자체가 버그 신호).
const numDefault0 = (raw: unknown) => (typeof raw === "number" ? raw : 0);
// header_*_visible predate this table and used "missing key = true" (not Boolean()'s "missing =
// false") — new users get every header widget on by default.
const boolDefaultTrue = (raw: unknown) => (raw === undefined ? true : Boolean(raw));

export const PREFS = [
  pref("uiLock", "ui_lock", boolDefaultFalse),
  pref("aiEnabled", "ai_enabled", boolDefaultFalse),
  // 기본 ON — 없는 키(구 설치)도 켜짐으로 읽는다(header_*_visible 과 같은 관례).
  pref("aiPostProcess", "ai_post_process", boolDefaultTrue),
  // PLAN-2026-08-30 §3 W2 — 챗 메모리 자동 추출 킬 스위치. 기본 ON, 없는 키(구 설치)도 켜짐으로.
  pref("aiChatMemory", "ai_chat_memory", boolDefaultTrue),
  // PLAN-2026-09-05 §2 B-4 — 어시스트 결과 프리뷰 게이트. 기본 ON, 없는 키(구 설치)도 켜짐으로.
  pref("aiConfirmBeforeApply", "ai_confirm_before_apply", boolDefaultTrue),
  // PLAN-2026-09-27 §7-4 (W5) — 어시스트 패널 AI 프리셋 바로 실행 토글. 기본 OFF.
  pref("assistPresetAutorun", "assist_preset_autorun", boolDefaultFalse),
  // PLAN-2026-09-05 §3 C-3 — 호출 로그 본문 동봉. 기본 OFF.
  pref("aiDebugVerbose", "ai_debug_verbose", boolDefaultFalse),
  // PLAN-2026-08-30 §6-A — 전역 AI 정책 사다리. 결측/오타/구버전 값은 전부 "organize"(가장
  // 넓음, 기존 동작 유지)로 폴백 — 백엔드 commands::ai::AiPolicyLevel::parse 와 같은 규칙.
  pref("aiPolicyLevel", "ai_policy_level", (raw) =>
    raw === "gather" || raw === "refine" || raw === "organize" ? raw : "organize",
  ),
  // F-P01 쓰기 게이트 — 기본 ON. 없는 키(구 설치)도 켜짐으로 읽는다.
  pref("chatWriteEnabled", "chat_write_enabled", boolDefaultTrue),
  pref("chatReadHistory", "chat_read_history", boolDefaultTrue),
  pref("chatReadFiles", "chat_read_files", boolDefaultTrue),
  // P2 3단계(docs/PLAN-2026-08-07-second-brain.md Q5) — 기본 OFF(옵트인, 외부 fetch 프라이버시
  // 게이트). 백엔드 settings_schema.rs 기본값(false)과 동일.
  pref("linkSuggestions", "link_suggestions", boolDefaultFalse),
  // PLAN-2026-09-18-nl-dates.md §W4 — 에디터 날짜 넛지 완전자동 등록 옵트인. 기본 OFF(넛지가
  // 기본, 자동은 옵트인 — D4). settings_schema.rs 기본값(false)과 동일.
  pref("dateNudgeAuto", "date_nudge_auto", boolDefaultFalse),
  // PLAN-2026-09-19-date-region-ui.md §P3 D12 — 지역 사전 매칭 넛지 강도. 기본 ON(엄격) —
  // settings_schema.rs 기본값(true)과 동일. "없는 키(구 설치)도 켜짐으로" 읽어야 하므로
  // boolDefaultTrue(dateNudgeAuto 의 boolDefaultFalse 와 반대 — D12 자체가 반대 기본값).
  pref("regionNudgeStrict", "region_nudge_strict", boolDefaultTrue),
  // 오너 결정(2026-09-20) — 3단 UI의 "enabled" 불리언 쌍 + 붙여넣기 자동 동작 3종 + 마크다운
  // 자동 서식. 여섯 다 기본 ON(오늘까지의 동작 유지) — settings_schema.rs 기본값(true)과 동일.
  pref("dateNudgeEnabled", "date_nudge_enabled", boolDefaultTrue),
  pref("regionNudgeEnabled", "region_nudge_enabled", boolDefaultTrue),
  pref("pasteLinkNudge", "paste_link_nudge", boolDefaultTrue),
  pref("pastePathInlineCode", "paste_path_inline_code", boolDefaultTrue),
  pref("pasteTableSheetSuggest", "paste_table_sheet_suggest", boolDefaultTrue),
  pref("editorMdAutoformat", "editor_md_autoformat", boolDefaultTrue),
  // 실험적(2026-09-20, "4~7번도 넣어봐") — 넷 다 settings_schema.rs 기본값과 동일. 위 여섯 키와
  // 달리 기본값이 제각각이다(§4~7 은 킬스위치가 아니라 새 값) — 코드 주석 참고.
  pref("linkOpenOnClick", "link_open_on_click", boolDefaultFalse),
  pref("editorWordCount", "editor_word_count", boolDefaultTrue),
  pref("editorWidth", "editor_width", oneOf(EDITOR_WIDTHS, "normal")),
  pref("newNoteDatePrecision", "new_note_date_precision", oneOf(NEW_NOTE_DATE_PRECISIONS, "day")),
  // 저장 전 클램프는 setNewNoteSectionName(아래)이 맡는다 — 여기 coerce 는 이미 잘못 저장된 값
  // (수동 DB 편집·구버전 왕복 등)을 읽을 때의 방어선이라 같은 규칙(trim + 40자)을 한 번 더 건다.
  pref("newNoteSectionName", "new_note_section_name", (raw) =>
    typeof raw === "string" ? raw.trim().slice(0, 40) : "",
  ),
  // S2 입력 3종 — settings_schema.rs 기본값과 동일. 결측/오타는 각자의 기본값으로 폴백.
  pref("photoMetaMode", "photo_meta_mode", oneOf(INPUT_AUTO_MODES, "auto")),
  pref("voiceTranscribeMode", "voice_transcribe_mode", oneOf(INPUT_AUTO_MODES, "auto")),
  pref("voiceCleanupMode", "voice_cleanup_mode", oneOf(INPUT_AUTO_MODES, "off")),
  pref("onboardingCompleted", "onboarding_completed", boolDefaultFalse),
  pref("briefingEnabled", "briefing_enabled", boolDefaultFalse),
  pref("briefingWhen", "briefing_when", oneOf(BRIEFING_WHENS, "time")),
  pref("briefingTime", "briefing_time", (raw) =>
    typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : "08:00",
  ),
  pref("briefingLastShown", "briefing_last_shown", (raw) => (typeof raw === "string" ? raw : "")),
  pref("briefingEveningEnabled", "briefing_evening_enabled", boolDefaultFalse),
  pref("briefingEveningTime", "briefing_evening_time", (raw) =>
    typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : "21:00",
  ),
  pref("briefingLastShownEvening", "briefing_last_shown_evening", (raw) => (typeof raw === "string" ? raw : "")),
  pref("briefingNotify", "briefing_notify", oneOf(BRIEFING_NOTIFIES, "window")),
  pref("briefingLastSeen", "briefing_last_seen", (raw) => (typeof raw === "string" ? raw : "")),
  pref("favoritesOpen", "favorites_open", boolDefaultFalse),
  pref("backupNudgePending", "backup_nudge_pending", (raw) => raw === true),
  pref("sourceOriginalPolicy", "source_original_policy", (raw) => (typeof raw === "string" ? raw : "ask")),
  pref("uiLang", "ui_lang", (raw) => (typeof raw === "string" ? raw : "ko")),
  pref("updateCheckAuto", "update_check_auto", boolDefaultTrue),
  pref("defaultMapLocation", "default_map_location", (raw) => {
    const loc = raw as { lat?: number; lng?: number; zoom?: number } | undefined;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number" && typeof loc.zoom === "number") {
      return { lat: loc.lat, lng: loc.lng, zoom: loc.zoom };
    }
    return FACTORY_DEFAULT_MAP_LOCATION;
  }),
  pref("filterRoster", "filter_roster", (raw) => normalizeFilterRoster(raw)),
  pref("dashboardTabs", "dashboard_tabs", (raw) => normalizeDashboardTabs(raw)),
  pref("editorFullWidth", "editor_full_width", boolDefaultFalse),
  // 2026-09-20 — 에디터 툴바(SpellcheckToggle.tsx)와 설정 > 에디터 페이지가 같은 값을 보게
  // simplePrefs 로 승격. 백엔드 allowlist·기본값(false)은 이미 있었다(§2.2 4곳 중 이 한 곳만 신규).
  pref("spellcheckEnabled", "spellcheck_enabled", boolDefaultFalse),
  pref("weekStart", "week_start", oneOf(WEEK_STARTS, "sunday")),
  pref("calendarAxisTailHours", "calendar_axis_tail_hours", intIn(0, 12, 3)),
  pref("storageAlertGb", "storage_alert_gb", intIn(0, 500, 0)),
  pref("holidayRegion", "holiday_region", oneOf(HOLIDAY_REGIONS, "none")),
  // 날씨 표시 토글(`header_weather_visible`)은 2026-09-12 오너 결정 D11 로 **사라졌다** —
  // 날씨는 항상 보인다. DB 에 옛 키가 남아 있어도 여기서 읽지 않으므로 무해하다(get_all 은
  // 검증 없이 행을 그대로 돌려주고, 프런트는 이 목록에 있는 키만 집는다).
  pref("closeToTray", "close_to_tray", boolDefaultTrue),
  // docs/PLAN-schedule-system.md §5.5 — 백엔드 settings_schema.rs 기본값과 동일(둘 다 기본 OFF /
  // "00:00"). 형식이 어긋난 값(구 설치·수동 편집)은 안전 기본값으로 되돌린다.
  pref("notificationsEnabled", "notifications_enabled", boolDefaultFalse),
  pref("reminderAllDayAt", "reminder_all_day_at", (raw) =>
    typeof raw === "string" && /^\d{2}:\d{2}$/.test(raw) ? raw : "00:00",
  ),
  // W10: 사용자 이름 (선택, 최대 64자). 기본 빈 문자열.
  pref("userName", "user_name", (raw) => (typeof raw === "string" ? raw : "")),
  // W11: 글꼴 패밀리 ("serif" | "sans" | 시스템 글꼴명 | catalog:<id>). 기본값은 Rust 시드(settings_schema.rs "font_family")와 같은
  // DEFAULT_FONT_FAMILY 하나 — 예전엔 초기 상태가 "pretendard" 인데 이 강제 변환의 폴백만 "serif" 라, 빈 값·결측 저장이 조용히 다른 글꼴이 됐다.
  pref("fontFamily", "font_family", (raw) =>
    typeof raw === "string" && raw.trim().length > 0 ? raw : DEFAULT_FONT_FAMILY,
  ),
  // PLAN-2026-10-27-fonts — 저장은 아래 click setter(setFontEditor/setFontMono)가 직접 한다(fontFamily 와 같은 이유:
  // 바꾸면 화면을 다시 칠해야 한다). 여기는 load() 의 강제 변환만.
  pref("fontEditor", "font_editor", (raw) => (typeof raw === "string" ? raw : "")),
  pref("fontMono", "font_mono", (raw) =>
    typeof raw === "string" && raw.trim().length > 0 ? raw : DEFAULT_FONT_MONO,
  ),
  // W18: 펫 반응 설정 & 챗봇 메모리 (클릭=채팅 고정, pet_click_action 삭제)
  // W18: 구값 search/open_note 는 목록 밖이라 기본값("new_note")으로 흡수된다(마이그레이션 없음, normalizeFilterRoster 패턴).
  pref("petDblclickAction", "pet_dblclick_action", oneOf(PET_DBLCLICK_ACTIONS, "new_note")),
  pref("chatMemory", "chat_memory", (raw) => {
    if (Array.isArray(raw)) {
      return raw.filter((item) =>
        item && typeof item === "object" && typeof (item as any).id === "string" && typeof (item as any).text === "string"
      ).slice(0, 50) as ChatMemoryItem[];
    }
    return [];
  }),
  pref("attachmentStorageMode", "attachment_storage_mode", oneOf(ATTACHMENT_STORAGE_MODES, "copy")),
  pref("slidePreview", "slide_preview", oneOf(SLIDE_PREVIEWS, "auto")),
  pref("sofficePath", "soffice_path", (raw) => (typeof raw === "string" ? raw : "")),
  // collect_excluded_domains — capture_visit_excluded_domains 와 같은 형식. 부팅 시
  // load() 안의 "구 키 폴백" 분기에서 비어있으면 capture_visit_excluded_domains 값을
  // 한 번 읽어 채운다(마이그레이션 불필요, 사용자가 다음 저장부터 새 키로 자동 이관).
  pref("collectExcludedDomains", "collect_excluded_domains", (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw.filter((d): d is string => typeof d === "string" && d.trim().length > 0).slice(0, 200);
  }),
  // link_suggestions_model — 빈 문자열이면 전역 ai_model 폴백. 부재(구 설치)는 빈 문자열로
  // 매핑(키가 있으면 string 으로 강제, 빈 값은 ai_model 폴백 신호).
  pref("linkSuggestionsModel", "link_suggestions_model", (raw) => (typeof raw === "string" ? raw : "")),
  // collect_paused_until — ISO-8601 datetime 또는 빈 문자열. 부재/빈/과거/형식 오류 모두 빈
  // 문자열로 강등(서버 측 validate_setting 이 형식을 보장하지만 망실 경로 대비). 형식 검증은
  // 서버가 chrono::DateTime::parse_from_rfc3339 로 한다.
  pref("collectPausedUntil", "collect_paused_until", (raw) => (typeof raw === "string" ? raw.trim() : "")),
  // PLAN-2026-08-30 §4 W7 — 본 기능 브리핑 id 배열(+ 소급 시딩 sentinel). recentClosedTabs 와
  // 같은 형식(문자열 배열, 결측 시 빈 배열).
  pref("seenFeatureBriefs", "seen_feature_briefs", (raw) =>
    Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [],
  ),
  // PLAN-2026-09-01 W0 — 둘 다 기본 OFF. 키가 없는 구 설치도 꺼짐으로 읽는다(boolDefaultFalse).
  pref("collectChatRegister", "collect_chat_register", boolDefaultFalse),
  pref("statusAddLocked", "status_add_locked", boolDefaultFalse),
  pref("timelineDefaultRange", "timeline_default_range", oneOf(TIMELINE_RANGES, "fit")),
  pref("boardDoneAutohide", "board_done_autohide", oneOf(BOARD_DONE_AUTOHIDE, "off")),
  pref("boardCardThumb", "board_card_thumb", boolDefaultTrue),
  pref("boardCardDate", "board_card_date", boolDefaultTrue),
  pref("graphHideIsolated", "graph_hide_isolated", boolDefaultFalse),
  pref("exportDefaultDir", "export_default_dir", (raw) => (typeof raw === "string" ? raw : "")),
  pref("galleryTileSize", "gallery_tile_size", oneOf(GALLERY_TILE_SIZES, "medium")),
  pref("gallerySort", "gallery_sort", oneOf(GALLERY_SORTS, "newest")),
  pref("galleryShowNames", "gallery_show_names", boolDefaultFalse),
  pref("graphNodeCap", "graph_node_cap", intIn(0, 500, 0)),
  // PLAN-2026-09-04-local-import §3b — 둘 다 시드하지 않는 키(부재 = 기본값, defaultSettings 참고).
  pref("collectDetectPending", "collect_detect_pending", numDefault0),
  pref("collectDetectSeen", "collect_detect_seen", boolDefaultFalse),
  // PLAN-2026-09-12 §5 — 본문 틴트 오프셋. **load()의 강제 변환만 여기서 가져간다**: 저장은
  // 아래 setContentTint 가 직접 한다(setSimplePref 는 CSS 를 다시 칠하지 않는데 이 값은
  // 슬라이더를 끄는 동안 화면에 바로 보여야 한다 — bg_tone/sheet_alpha 와 같은 부류).
  // 범위는 백엔드 validate_setting(-30..=40)과 같은 숫자다.
  pref("contentTint", "content_tint", (raw) =>
    typeof raw === "number" && Number.isFinite(raw)
      ? clamp(Math.round(raw), CONTENT_TINT_MIN, CONTENT_TINT_MAX)
      : 0,
  ),
] as const;

/** 단순 설정 키 — **PREFS 표에서 파생한다**(손으로 쓰던 유니온은 표와 따로 표류했다). aiCapabilities.ts 의 킬스위치 키 타입이 같은 집합을 쓴다. */
export type SimplePrefKey = (typeof PREFS)[number]["camel"];

export const PREF_SNAKE = Object.fromEntries(PREFS.map((p) => [p.camel, p.snake])) as Record<SimplePrefKey, string>;

/** 단순 설정의 기본값 = 키가 없을 때의 강제 변환 결과(`coerce(undefined)`) — 초기 상태·load() 가 같은 값을 말한다. */
export function prefDefaults(): Pick<SettingsState, SimplePrefKey> {
  const out = {} as Record<string, unknown>;
  for (const p of PREFS) out[p.camel] = p.coerce(undefined);
  return out as Pick<SettingsState, SimplePrefKey>;
}
