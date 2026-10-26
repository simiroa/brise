import { create } from "zustand";
import { call, callSilent } from "../lib/invoke";
import { uniqueId } from "../lib/ids";
import { useTabsStore } from "./tabs";
import { addRecentEmoji } from "../lib/emoji/emojiCore";
import { PHRASE_PACK_OFF, defaultPhrasePackId } from "../lib/phrasePacks";
import { clamp } from "../lib/ui";
import { isBrowser } from "../lib/env";
import { reportFallback } from "../lib/diag";
import { ensureLocale, getDict, rememberLocaleHint } from "../i18n/locales";
// W11(§6-A): type-only — aiCapabilities.ts 도 이 파일에서 SimplePrefKey 를 type-only import 한다.
// 둘 다 `import type` 이라 런타임에는 소거되므로 순환은 컴파일 단계에서만 존재하고 문제가 없다.
import type { AiPolicyLevel } from "../lib/aiCapabilities";
import { DEFAULT_ACCENT, isAccentHex } from "../lib/accentPalette";
import {
  type Theme,
  type ThemePref,
  type Accent,
  type SurfaceStyle,
  BG_TONE_MIN,
  BG_TONE_MAX,
  BG_SAT_MIN,
  BG_SAT_MAX,
  SHEET_ALPHA_MIN,
  SHEET_ALPHA_MAX,
  CONTENT_TINT_MIN,
  CONTENT_TINT_MAX,
  loadAppearanceSeed,
  saveAppearanceSeed,
  applyCssVars,
  syncWindowEffect,
  endBootTransitions,
  resolveTheme,
  attachSystemThemeListener,
} from "../lib/appearance";
import {
  type FilterRosterEntry,
  type DashboardTabEntry,
  ensureOneEnabled,
  normalizeFilterRoster,
  normalizeDashboardTabs,
} from "../lib/settingsNormalize";
export type { Theme, ThemePref, Accent, SurfaceStyle };
export type BriefingWhen = "time" | "launch" | "manual";
/** 자동 표시 방식 — 창 / OS 알림 한 줄 / 둘 다(W10). */
export type BriefingNotify = "window" | "os" | "both";
export type WeekStart = "sunday" | "monday";
/** 달력 공휴일 지역 — 날짜 표는 lib/holidays.ts, 백엔드 allowlist 는 `holiday_region`. */
export type HolidayRegion = "none" | "kr";

// 오너 결정(2026-09-20, "4~7번도 넣어봐, 보고 이상하면 지울게") — **실험적** 에디터 설정 4종.
// 8cdaa347 웨이브의 여섯 키(위 dateNudgeModeOf 근처 주석)와 달리 "오늘까지의 동작을 지키는
// 킬스위치"가 아니라 새 동작/값이다 — 오너가 앱에서 써보고 별로면 빼기로 했으므로, 각각 키
// 하나·스토어 필드 하나·setter 하나·EditorSection.tsx 행 하나로 자기완결시킨다(다른 필드와
// 얽지 않는다 — 빼려면 그 넷만 지우면 된다).
/** 본문 최대 폭(editor_width). "normal"(기본) = 오늘까지의 800px 상한. editorFullWidth(전체
 *  너비)가 켜져 있으면 이 값은 쓰이지 않는다 — 설정 화면이 그 상태의 행을 잠근다. */
export type EditorWidth = "narrow" | "normal" | "wide";
/** 새 노트가 받는 오늘 날짜의 정밀도(new_note_date_precision). "day"(기본) = 오늘까지의 동작
 *  (연·월·일까지). 노트별로 언제든 바꿀 수 있으므로 이 값은 "새로 만들 때의 시작값"만 정한다. */
export type NewNoteDatePrecision = "day" | "month" | "year";
/** S2 입력(docs/PLAN-2026-10-06-s2-input.md §1.1) — 사진·음성·위치가 공유하는 3단 자동 정책.
 *  auto = 묻지 않고 반영 + 되돌리기 토스트, ask = 제안만, off = 반영하지 않음. */
export type InputAutoMode = "off" | "ask" | "auto";

// 오너 결정(2026-09-20): 설정 > 에디터의 날짜/지역 제안을 3단(off/suggest/auto,
// off/strict/loose)으로 보여준다. 저장은 여전히 **불리언 두 개**다 — 새 enabled 키(신설,
// date_nudge_enabled/region_nudge_enabled) 가 기존 date_nudge_auto/region_nudge_strict 앞에
// 서고, 값 모양·의미는 안 바뀐다(enum 으로 바꾸면 전역 settings·노트북별 workspace_settings(V86)
// 양쪽에 마이그레이션이 필요해진다 — src-tauri/src/repo/settings_schema.rs::default_settings()
// 의 같은 WHY 주석 참고). 아래 두 함수는 그 두 불리언 → 3단 표시값 순수 매핑이다(부작용 없음,
// UI 는 이걸로 셀렉트/세그먼트 컨트롤 값을 고른다).
export type DateNudgeMode = "off" | "suggest" | "auto";
/** enabled=false 면 auto 값과 무관하게 항상 "off" — auto 는 "off"에서 꺼졌을 때의 이전 선택을
 *  보존하려고 남겨두는 값이라, 꺼진 상태에서는 읽지 않는다. */
export function dateNudgeModeOf(enabled: boolean, auto: boolean): DateNudgeMode {
  if (!enabled) return "off";
  return auto ? "auto" : "suggest";
}

export type RegionNudgeMode = "off" | "strict" | "loose";
/** dateNudgeModeOf 와 같은 규약 — enabled=false 면 strict 값과 무관하게 항상 "off". */
export function regionNudgeModeOf(enabled: boolean, strict: boolean): RegionNudgeMode {
  if (!enabled) return "off";
  return strict ? "strict" : "loose";
}

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

// 필터 로스터·대시보드 탭 정규화(§2.4 HANDOFF-calendar-onboarding.md · W7 §7.3)는 순수 함수라
// lib/settingsNormalize.ts 로 옮겼다. import 지점이 그대로 가도록 같은 이름으로 다시 내보낸다.
export {
  CANONICAL_ROSTER,
  CANONICAL_DASHBOARD_TABS,
  ensureOneEnabled,
  normalizeFilterRoster,
  normalizeDashboardTabs,
} from "../lib/settingsNormalize";
export type { RosterMode, FilterRosterEntry, DashboardTabId, DashboardTabEntry } from "../lib/settingsNormalize";

// W18 (결정 8 & 결정 10): 펫 반응 액션 & 챗봇 메모리
export type PetDblclickAction = "chat" | "new_note" | "off";
export const CHAT_MEMORY_MAX_ITEMS = 50;
export const CHAT_MEMORY_MAX_LENGTH = 200;
export interface ChatMemoryItem {
  id: string;
  text: string;
  created_at: string;
}

interface SettingsState {
  themePref: ThemePref;
  theme: Theme;
  accent: Accent;
  fontScale: number;
  bgDim: number;
  uiLock: boolean;
  leftWidth: number;
  sourcePct: number;
  activeWorkspaceId: string | null;
  loaded: boolean;
  applyRoot: () => void;
  load: () => Promise<Record<string, unknown>>;
  setTheme: (t: ThemePref) => Promise<void>;
  // 슬라이더/드래그로 끄는 외형 값은 **void 반환**이다 — 드래그 한 번에 수백 틱이 나가므로
  // 호출부가 결과를 기다리지 않고, 따라서 실패가 rejection 으로 샐 자리도 없어야 한다.
  // 아래 setBgTone/setContentTint/setSheetAlpha 와 같은 부류이고, 구현 규칙은 그 그룹 주석에.
  /** `live` 는 **드래그 틱**이다(hue 슬라이더). 그때만 조용히 저장하고 롤백하지 않는다 —
   *  아래 구현부 그룹 주석 참고. 클릭 한 번으로 끝나는 경로는 옵션 없이 부른다. */
  setAccent: (a: Accent, opts?: { live?: boolean }) => Promise<void>;
  setFontScale: (v: number) => void;
  /** `live` 는 배경 밝기 슬라이더의 드래그 틱 — setBgSat 과 같이 칠하고 **조용히** 저장한다(본 창은
   *  settings_set 의 settings-changed 로 실시간으로 따라온다). 옵션 없이 부르면 손을 뗀 **확정**이라
   *  실패가 토스트로 보인다. setBgTone 도 같다. */
  setBgDim: (v: number, opts?: { live?: boolean }) => void;
  setUiLock: (v: boolean) => Promise<void>;
  setLeftWidth: (v: number) => void; // 디바운스 없이 즉시
  setSourcePct: (v: number) => void;
  aiEnabled: boolean;
  setAiEnabled: (v: boolean) => Promise<void>;
  /** Kill-switch for the background metadata proposal that runs after AI writes into a note
   *  (lib/aiPostProcess.ts). Default ON — it never writes anything without the confirm step. */
  aiPostProcess: boolean;
  setAiPostProcess: (v: boolean) => Promise<void>;
  /** PLAN-2026-08-30 §3 W2: 사이드바 챗 대화에서 사실을 추출해 chat_memory 에 자동 저장하는
   *  기능의 킬 스위치 (lib/chatMemoryExtractor.ts). 기본 ON. */
  aiChatMemory: boolean;
  setAiChatMemory: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-05 §2 B-4: 어시스트 AI 결과를 노트에 삽입/교체하기 전에 AiResultModal 로 확인.
   *  기본 ON. 끄면 현행처럼 즉시 삽입. */
  aiConfirmBeforeApply: boolean;
  setAiConfirmBeforeApply: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-27 §7-4 (W5): 어시스트 패널에서 AI 프리셋 클릭 시 모달 열린 직후 바로 실행할지 여부. 기본 OFF. */
  assistPresetAutorun: boolean;
  setAssistPresetAutorun: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-05 §3 C-3: AI 호출 로그(ai-calls.jsonl)에 프롬프트/응답 앞 2000자 동봉.
   *  기본 OFF — 켜면 노트 내용이 로그 파일에 남는다. */
  aiDebugVerbose: boolean;
  setAiDebugVerbose: (v: boolean) => Promise<void>;
  /** W11(§6-A): 전역 AI 정책 사다리 — "gather" < "refine" < "organize" (docs/PLAN-2026-08-30-
   *  ai-surface-and-clients.md §6-A, lib/aiCapabilities.ts::AiPolicyLevel 과 같은 값 집합).
   *  기본 "organize"(가장 넓음, 기존 동작 유지). 낮춰도 개별 토글의 저장값은 지우지 않는다 —
   *  정책은 덮개일 뿐이다. 백엔드 실효 게이트는 commands::ai::ai_gate_and_key/
   *  require_ai_policy_level(모든 ai_* 커맨드가 지나는 단일 지점) — 프런트가 이 값을 아무리
   *  잘못 보내도(또는 우회해도) 그 지점에서 다시 검증된다. */
  aiPolicyLevel: AiPolicyLevel;
  setAiPolicyLevel: (v: AiPolicyLevel) => Promise<void>;
  /** F-P01 비서/펫 노트 쓰기 게이트 (chat_write_enabled). 기본 ON — 구 localStorage
   *  fail-open 과 같다. 실효 게이트는 pet_chat 이 클라 allow_write 와 AND. */
  chatWriteEnabled: boolean;
  setChatWriteEnabled: (v: boolean) => Promise<void>;
  /** 챗봇 권한: 이전 대화 내용 참조 게이트. 기본 ON. */
  chatReadHistory: boolean;
  setChatReadHistory: (v: boolean) => Promise<void>;
  /** 챗봇 권한: 내 파일 및 노트 내용 참조 게이트. 기본 ON. */
  chatReadFiles: boolean;
  setChatReadFiles: (v: boolean) => Promise<void>;
  /** P2 3단계 링크 붙여넣기 후행 제안 옵트인 토글 (link_suggestions, 기본 OFF — 켜면 에디터에
   *  붙여넣은 단독 URL을 백엔드가 fetch·요약한다). 실효 게이트는 백엔드
   *  repo::suggestions::link_suggestions_active(ai_enabled && link_suggestions).
   *  docs/PLAN-2026-08-07-second-brain.md Q5. */
  linkSuggestions: boolean;
  setLinkSuggestions: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-18-nl-dates.md §W4: 에디터 타이핑 넛지(components/editor/dateNudge.ts)의
   *  완전자동 등록 옵트인 (date_nudge_auto). 기본 OFF — 기본은 칩을 띄워 1키로 수락하는
   *  "넛지"고, 켜면 칩 없이 캐럿이 매치 범위를 벗어나는 즉시 등록한다(되돌리기 토스트는
   *  그대로 남는다). D4(문서 상단 "결정" 절) 확정. */
  dateNudgeAuto: boolean;
  setDateNudgeAuto: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-19-date-region-ui.md §P3 D12: 지역 사전 매칭 넛지(components/editor/
   *  regionDetect.ts)의 매칭 강도 (region_nudge_strict). 기본 **ON**(엄격 — 경계 검사: 후보
   *  지역명 앞뒤가 한글 음절/영문자/숫자가 아니어야, 또는 문자열 시작/끝. "경주"가 "경주마"에서
   *  안 걸린다). 끄면 경계 검사 없는 순수 substring 으로 완화된다. dateNudgeAuto 와 반대로 기본이
   *  ON 인 이유: 이건 "기본 꺼진 기능의 옵트인"이 아니라 "항상 도는 넛지의 강도"다(오너 원문:
   *  "주소는 오탐이 잦을거같아서 확실한 부분이 없으면 안나오는게 경험적으로 좋아"). */
  regionNudgeStrict: boolean;
  setRegionNudgeStrict: (v: boolean) => Promise<void>;
  /** 오너 결정(2026-09-20) — 날짜 넛지 3단 UI(off/suggest/auto)의 앞쪽 "enabled" 불리언
   *  (date_nudge_enabled, 신설). 기본 ON(오늘까지의 동작 유지) — 끄면 dateNudgeAuto 값과 무관하게
   *  넛지 자체가 꺼진다(dateNudgeModeOf 가 "off"로 읽는다). */
  dateNudgeEnabled: boolean;
  setDateNudgeEnabled: (v: boolean) => Promise<void>;
  /** 오너 결정(2026-09-20) — 지역 넛지 3단 UI(off/strict/loose)의 앞쪽 "enabled" 불리언
   *  (region_nudge_enabled, 신설). 기본 ON. */
  regionNudgeEnabled: boolean;
  setRegionNudgeEnabled: (v: boolean) => Promise<void>;
  /** 오너 결정(2026-09-20) — 에디터에 단독 URL을 붙여넣을 때의 후행 제안 행동 자체의 on/off
   *  (paste_link_nudge, 신설). link_suggestions(그 뒤 AI 요약 옵트인, 기본 OFF)와는 별개 축 —
   *  이 토글은 "제안 UI를 띄울지"고, link_suggestions는 "그 제안이 AI 요약까지 할지"다. 기본 ON. */
  pasteLinkNudge: boolean;
  setPasteLinkNudge: (v: boolean) => Promise<void>;
  /** 오너 결정(2026-09-20) — 파일 경로 문자열을 붙여넣을 때 인라인 코드 서식으로 감쌀지
   *  (paste_path_inline_code, 신설). 기본 ON(오늘까지의 동작 유지). */
  pastePathInlineCode: boolean;
  setPastePathInlineCode: (v: boolean) => Promise<void>;
  /** 오너 결정(2026-09-20) — 표 모양 텍스트(TSV/CSV 등)를 붙여넣을 때 시트로 변환할지 제안
   *  (paste_table_sheet_suggest, 신설). 기본 ON. */
  pasteTableSheetSuggest: boolean;
  setPasteTableSheetSuggest: (v: boolean) => Promise<void>;
  /** 오너 결정(2026-09-20) — 타이핑 중 마크다운 문법(`**bold**`/`# heading` 등)을 즉시 리치
   *  서식으로 바꾸는 에디터 자동 서식의 킬 스위치 (editor_md_autoformat, 신설). 기본 ON. */
  editorMdAutoformat: boolean;
  setEditorMdAutoformat: (v: boolean) => Promise<void>;
  /** 실험적(2026-09-20, "4~7번도 넣어봐") — 링크를 일반 클릭으로 열지, 지금처럼 Ctrl/Cmd+클릭
   *  에서만 열지 (link_open_on_click, 신설). 기본 false(오늘까지의 동작 유지). 실효 게이트는
   *  다른 에이전트가 얹는다 — 이 스토어 필드는 값만 들고 있다. */
  linkOpenOnClick: boolean;
  setLinkOpenOnClick: (v: boolean) => Promise<void>;
  /** 위 dateNudgeEnabled/dateNudgeAuto 두 불리언을 **한 settings_set 호출**로 같이 바꾼다 —
   *  따로 두 번 쏘면 두 번째가 실패했을 때 절반만 적용된 쌍이 남고, "settings-changed" 이벤트도
   *  두 번 나간다. "off" 로 갈 때는 dateNudgeAuto 를 **건드리지 않는다**(entries 에 아예
   *  안 넣는다) — 그래야 나중에 다시 켰을 때 이전 suggest/auto 선택이 그대로 돌아온다. 실패하면
   *  두 필드 다 함께 롤백(함정 9) — call() 이 이미 토스트를 띄운다. */
  setDateNudgeMode: (mode: DateNudgeMode) => Promise<void>;
  /** setDateNudgeMode 와 같은 규약 — regionNudgeEnabled/regionNudgeStrict 쌍. */
  setRegionNudgeMode: (mode: RegionNudgeMode) => Promise<void>;
  // §2.6 HANDOFF-calendar-onboarding.md: first-run wizard completion flag. false (default) shows
  // the wizard on boot (App.tsx). Existing installs are backfilled to true by
  // db::migrations::run() — see that function's comment for why a plain default can't do this.
  onboardingCompleted: boolean;
  setOnboardingCompleted: (v: boolean) => Promise<void>;
  sourceOriginalPolicy: string;
  setSourceOriginalPolicy: (v: string) => Promise<void>;
  uiLang: string;
  setUiLang: (v: string) => Promise<void>;
  /** E4 자동 업데이트 확인 킬스위치 (update_check_auto). 기본 true. */
  updateCheckAuto: boolean;
  setUpdateCheckAuto: (v: boolean) => Promise<void>;
  // Wave (theme customisation): 배경 톤 + 표면 스타일 — 백엔드 validate_setting 허용 목록에
  // bg_tone / surface_style 로 영속된다(validate_setting allowlist 등록 완료).
  // 클램프 범위는 백엔드 검증과 1:1로 맞춰야 한다 — 어긋나면 백엔드가 조용히 거부한다.
  bgTone: number;
  setBgTone: (v: number, opts?: { live?: boolean }) => void;
  /** PLAN-2026-09-12 §3/E3: 배경 채도(0~100) — 캔버스를 **테마색**(`--theme`) 쪽으로 물들이는
   *  세기. 강조색이 아니다: 배경은 구조라서 사용자가 강조색을 레드로 바꿔도 바탕은 안 따라간다.
   *  0 = 오늘 화면과 픽셀 동일. `live` 는 드래그 틱이고(CSS 만 + 조용한 저장), 옵션 없이 부르면
   *  **확정**이다 — 그때만 OS 아크릴 틴트를 한 번 다시 보낸다(E4: 색은 보내되 드래그당 1회). */
  bgSat: number;
  setBgSat: (v: number, opts?: { live?: boolean }) => Promise<void>;
  /** PLAN-2026-09-12 §5 (D6): 본문 캔버스(.content-canvas) 전용 틴트의 **부호 있는 오프셋**
   *  (-30~40, 기본 0 = 오늘 화면과 픽셀 동일). 위 bgTone/bgDim 은 사이드바를 포함한 **전역**
   *  밝기고, 이건 본문 영역만 움직인다 — 사이드바 전용 슬라이더는 만들지 않는다(오너 결정 D6).
   *  실효 틴트 = 테마 기준값(다크 16 / 라이트 7) + 이 값이고, 음수로 내려가면 틴트가 흰색으로
   *  뒤집혀 본문이 사이드바보다 **밝아진다**(lib/appearance.ts::applyCssVars). */
  contentTint: number;
  setContentTint: (v: number) => void;
  surfaceStyle: SurfaceStyle;
  setSurfaceStyle: (v: SurfaceStyle) => Promise<void>;
  // acrylic 표면 불투명도(--sheet-alpha, 0~1.0) — 뒤 데스크톱이 (1-alpha)만큼 비친다. acrylic 전용
  // 파라미터(설정 > 외관, surfaceStyle==='acrylic'). 하한 없음(사용자 요청, 2026-07-23) — 0에 가까울수록
  // 본문 가독성이 떨어지는 건 사용자 선택.
  sheetAlpha: number;
  setSheetAlpha: (v: number) => void;
  recentColorHues: number[];
  addRecentColorHue: (hue: number) => Promise<void>;
  emojiRecent: string[];
  addEmojiRecent: (key: string) => Promise<void>;
  emojiFavorites: string[];
  toggleEmojiFavorite: (key: string) => Promise<void>;
  defaultMapLocation: { lat: number; lng: number; zoom: number };
  /** 저장 성공 여부를 돌려준다 — 실패하면 화면 값은 이미 되돌아가 있고(토스트도 떴다), 저장을
   *  전제로 다음 단계로 넘어가는 호출부(온보딩 지역 쪽)는 이 값을 보고 멈출 수 있다. */
  setDefaultMapLocation: (loc: { lat: number; lng: number; zoom: number }) => Promise<boolean>;
  // 오너 승인 분석#5: "홈 위치 미설정" 판정을 좌표 비교(공장 서울 좌표와 일치?)가 아니라 명시적
  // 신호로 한다 — 사용자가 우연히/의도적으로 서울 좌표를 홈으로 저장해도 오탐하지 않도록.
  // kv 에 default_map_location 키가 실제로 존재했는지(load()) 또는 setDefaultMapLocation 성공
  // 여부로만 세팅. 새 kv 키 추가 없음 — settings_schema.rs allowlist 안 건드림.
  defaultMapLocationCustomized: boolean;
  // PLAN-2026-09-15 R2/R3 — "기준 지역 활용" 마스터. 기본 ON. 꺼지면 기준 지역이 만들어내던
  // 것들(날씨 요청·현지 시간·장소명 역조회·AI 컨텍스트의 날씨 줄)이 **한 지점**에서 꺼진다:
  // components/home/useWeatherLocation.ts(훅 소비처 전부)와 lib/weather.ts::savedWeatherLocation
  // (훅이 아닌 AI 경로). 소비처는 이미 "위치 없음"을 조용히 처리하므로 각자 검사하지 않는다.
  // 사용자가 노트에 직접 붙인 지역 태그·지도 탭·사이드바 지역 필터는 사용자 데이터라 그대로 산다.
  // 저장값은 "0"/"1" 문자열(pet_enabled 관례)이라 setSimplePref 가 아니라 전용 setter 를 쓴다.
  regionEnabled: boolean;
  setRegionEnabled: (v: boolean) => Promise<void>;
  filterRoster: FilterRosterEntry[];
  setFilterRoster: (entries: FilterRosterEntry[]) => Promise<void>;
  // W7 §7.3: 대시보드 탭 순서
  dashboardTabs: DashboardTabEntry[];
  setDashboardTabs: (entries: DashboardTabEntry[]) => Promise<void>;
  // Wave 8 header phrase pack — "off" | "bundled:…" | "user:…". See lib/phrasePacks.ts.
  phrasePackId: string;
  setPhrasePackId: (id: string) => Promise<void>;
  // Wave (window transparency): whether the OS-level window effect for the current non-flat
  // surfaceStyle actually took hold (Mica/Acrylic requires Windows 11 build 22000+ — see
  // src-tauri/src/commands/window.rs::window_set_effect). Never persisted — always re-derived
  // live from that command's result, on boot and on every change. `applyCssVars` reads this to
  // decide the *effective* `data-surface` written to the DOM: if the user picked acrylic but the OS
  // call failed, we must render as flat (fully opaque `--bg`), never as a translucent canvas with
  // no real material behind it (that would be a punched-through hole, not a graceful degrade).
  surfaceEffectApplied: boolean;
  // Called once the native window is visible. load() must NOT apply Acrylic while the
  // window is still visible:false — window-vibrancy then invalidates the HWND
  // (Win32 0x80070578) and the main window never appears.
  applySurfaceEffectAfterShow: () => Promise<void>;
  /** 이 기기에서 아크릴을 걸 수 있는가(Windows 빌드 22523+, commands/window.rs::acrylic_supported).
   *  부팅 때 한 번 묻는다. 모르는 동안은 true — 진짜 관문은 Rust 의 apply_style 가드이고, 여기는
   *  모양 페이지의 "아크릴" 칸을 미리 잠그는 용도다(PLAN-2026-09-19 §4). */
  acrylicSupported: boolean;
  /** 모양 키 묶음(테마 파일·기본값·되돌리기 스냅샷)을 **한 번에** 적용한다 — PLAN-2026-09-19 §3.
   *  settings_set 한 번 → load() → OS 효과 한 번. 실패는 call() 이 토스트하고 다시 throw 한다.
   *  blockedAcrylic: 미지원 기기라 acrylic 을 flat 으로 바꿔 저장했다. */
  applyAppearance: (entries: Record<string, unknown>) => Promise<{ blockedAcrylic: boolean }>;
  /** DB 를 다시 읽고 OS 창 효과를 한 번 다시 건다 — 모양이 통째로 바뀐 뒤(불러오기·노트북 전환). */
  reloadAppearance: () => Promise<void>;
  // Editor width toggle (Toolbar.tsx chevrons button) — false (default) = comfortable/left-
  // anchored column; true = full-width, fills the panel. Persisted like any other simple UI
  // toggle (same shape as aiEnabled/onboardingCompleted below) — backend allowlist entry is
  // `editor_full_width` (src-tauri/src/db/migrations.rs::validate_setting).
  editorFullWidth: boolean;
  setEditorFullWidth: (v: boolean) => Promise<void>;
  /** 실험적(2026-09-20, "4~7번도 넣어봐") — 본문 최대 폭(editor_width, 신설). 기본 "normal"
   *  (오늘까지의 800px 상한). editorFullWidth 가 켜져 있으면 이 값은 쓰이지 않는다 — 설정
   *  화면(EditorSection.tsx)이 그 상태의 행을 잠근다. */
  editorWidth: EditorWidth;
  setEditorWidth: (v: EditorWidth) => Promise<void>;
  /** 실험적(2026-09-20, "4~7번도 넣어봐") — 에디터 상태줄의 글자 수·단어 수 표시
   *  (editor_word_count). **기본 true**: 그 표시는 이 키 이전부터 늘 보이던 것이라, 이 키는 옵트인이
   *  아니라 "끌 수 있게" 하는 스위치다. 그리는 쪽은 components/editor/WordCountBar.tsx. */
  editorWordCount: boolean;
  setEditorWordCount: (v: boolean) => Promise<void>;
  /** 실험적(2026-09-20, "4~7번도 넣어봐") — 새 노트가 받는 오늘 날짜의 정밀도
   *  (new_note_date_precision, 신설). 기본 "day"(오늘까지의 동작). 노트별로 언제든 바꿀 수
   *  있으므로 이 값은 "새로 만들 때의 시작값"만 정한다. 실효 게이트(note_create 가 이 값을
   *  읽어 실제로 연·월만 채우는 것)는 다른 에이전트가 얹는다. */
  newNoteDatePrecision: NewNoteDatePrecision;
  setNewNoteDatePrecision: (v: NewNoteDatePrecision) => Promise<void>;
  /** 실험적(2026-09-20, "4~7번도 넣어봐") — 새 노트의 첫 섹션 이름 (new_note_section_name,
   *  신설). 기본 ""(빈 문자열) = 백엔드 내장 기본 이름(repo/notes/mod.rs 의 "Overview" 리터럴)을
   *  그대로 쓴다는 신호. 저장 전 trim + 40자 클램프(백엔드 validate_setting 과 같은 상한). */
  newNoteSectionName: string;
  setNewNoteSectionName: (v: string) => Promise<void>;
  /** S2 입력 — 사진 EXIF(GPS·촬영시각)·음성 업로드 메타의 노트 날짜/경유지 반영 정책
   *  (photo_meta_mode, 서버 훅 repo::attachments::exif_region 이 읽는다). 기본 "auto". "off" 면
   *  서버가 EXIF 읽기·역지오코딩(외부 요청) 자체를 건너뛴다. */
  photoMetaMode: InputAutoMode;
  setPhotoMetaMode: (v: InputAutoMode) => Promise<void>;
  /** S2 입력 — 녹음 전사 삽입 정책 (voice_transcribe_mode). 기본 "auto" — 실효는 aiEnabled 일 때만
   *  (오디오가 외부로 나가는 동의의 SSOT 가 ai_enabled). */
  voiceTranscribeMode: InputAutoMode;
  setVoiceTranscribeMode: (v: InputAutoMode) => Promise<void>;
  /** S2 입력 — 전사 블록 정리 프리셋 적용 정책 (voice_cleanup_mode). 기본 "off"(원문 보존 우선). */
  voiceCleanupMode: InputAutoMode;
  setVoiceCleanupMode: (v: InputAutoMode) => Promise<void>;
  // 브리핑 창(PLAN-2026-09-30-briefing §3) — 전부 기기 전역. PLAN-2026-10-19 §9.1 로 화면 구성 키 다섯
  // (briefing_view·presets·layout·cards·options)은 은퇴했다 — 브리핑은 고정 구성이라 저장할 배치가 없다.
  briefingEnabled: boolean;
  setBriefingEnabled: (v: boolean) => Promise<void>;
  briefingWhen: BriefingWhen;
  setBriefingWhen: (v: BriefingWhen) => Promise<void>;
  briefingTime: string;
  setBriefingTime: (v: string) => Promise<void>;
  briefingLastShown: string;
  setBriefingLastShown: (v: string) => Promise<void>;
  // W10 저녁 회고·알림 방식. ponytail: briefing_times 배열 일반화 대신 키 2개 — 세 번째 시각이 생기면 그때 배열로.
  briefingEveningEnabled: boolean;
  setBriefingEveningEnabled: (v: boolean) => Promise<void>;
  briefingEveningTime: string;
  setBriefingEveningTime: (v: string) => Promise<void>;
  briefingLastShownEvening: string;
  setBriefingLastShownEvening: (v: string) => Promise<void>;
  briefingNotify: BriefingNotify;
  setBriefingNotify: (v: BriefingNotify) => Promise<void>;
  /** 브리핑이 마지막으로 새 항목을 보여 준 시각(ISO, 빈 값 = 없음). */
  briefingLastSeen: string;
  setBriefingLastSeen: (v: string) => Promise<void>;
  /** 노트 트리의 즐겨찾기 묶음 펼침(favorites_open). 사이드바 보기를 바꿀 때마다 트리가 다시
   *  마운트되며 settings_get_all 을 따로 불렀다 — 이미 읽은 값을 여기서 준다. */
  favoritesOpen: boolean;
  setFavoritesOpen: (v: boolean) => Promise<void>;
  /** 스키마가 올라간 기존 설치의 첫 부팅에 백업을 권하는 띠(backup_nudge_pending, db/migrations.rs
   *  가 한 번만 세운다). 그리는 쪽은 notetree/BackupNudgeBanner.tsx. */
  backupNudgePending: boolean;
  setBackupNudgePending: (v: boolean) => Promise<void>;
  // 2026-09-20 — "에디터" 설정 페이지 신설(오너: "일반-에디터 페이지 신설해서, 날짜 자동등록,
  // 지역 제한, 드롭 정책 등 관련 내용을 모으는 게 좋아 보임"). 맞춤법 검사는 예전엔 설정
  // 키가 아니라 에디터 툴바(SpellcheckToggle.tsx)만 `settings_get_all`/`settings_set` 을 직접
  // 불러 값을 들고 있었다 — 설정 창(별도 웹뷰)에 같은 토글을 하나 더 두려면 두 창이 값을
  // 공유할 단일 소스가 필요해 simplePrefs 로 승격했다. 백엔드 allowlist(`spellcheck_enabled`,
  // NOTEBOOK_KEYS 포함)는 이미 있었다 — 여기 4곳만 새로 등록한다(§2.2 절차, Rust 는 건드리지
  // 않음). 창 간 동기화는 다른 simplePref 와 동일하게 settings_set → "settings-changed" 이벤트 →
  // load() 재조회(lib/settingsChanged.ts)로 된다.
  spellcheckEnabled: boolean;
  setSpellcheckEnabled: (v: boolean) => Promise<void>;
  weekStart: WeekStart;
  setWeekStart: (v: WeekStart) => Promise<void>;
  holidayRegion: HolidayRegion;
  setHolidayRegion: (v: HolidayRegion) => Promise<void>;
  // 트레이 상주(close_to_tray, 기본 true) — X 버튼이 트레이로 숨기는지 실제 종료하는지.
  // lib.rs::run() 의 CloseRequested 핸들러가 매번 다시 읽으므로 재시작 없이 바로 반영된다.
  closeToTray: boolean;
  setCloseToTray: (v: boolean) => Promise<void>;
  // docs/PLAN-schedule-system.md §1.4/§5.5 — 일정·알림 마스터 스위치. 기본 OFF(오너 확정,
  // settings_schema.rs 기본값과 동일) — 꺼져 있으면 분 단위 틱이 아무것도 쏘지 않는다.
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => Promise<void>;
  // §5.2 확정: 종일 노트의 알림 기준 시각(로컬 "HH:MM"), 기본 "00:00".
  reminderAllDayAt: string;
  setReminderAllDayAt: (v: string) => Promise<void>;
  // W10: 사용자 이름 (선택, 최대 64자). 기본 빈 문자열.
  userName: string;
  setUserName: (v: string) => Promise<void>;
  // W11: 글꼴 패밀리 ("serif" | "sans" | 시스템 글꼴명). 기본 "serif".
  fontFamily: string;
  setFontFamily: (v: string) => Promise<void>;
  // W18: 펫 반응 설정 & 챗봇 메모리
  petDblclickAction: PetDblclickAction;
  setPetDblclickAction: (v: PetDblclickAction) => Promise<void>;
  chatMemory: ChatMemoryItem[];
  setChatMemory: (v: ChatMemoryItem[]) => Promise<void>;
  addChatMemory: (text: string) => Promise<boolean>;
  removeChatMemory: (id: string) => Promise<void>;
  // P3 수집 v2: 첨부 파일 저장 방식
  attachmentStorageMode: AttachmentStorageMode;
  setAttachmentStorageMode: (v: AttachmentStorageMode) => Promise<void>;
  /** pptx 슬라이드 미리보기. "auto" = LibreOffice 가 있으면 pdf 로 변환해 보여준다, "off" = 텍스트 폴백.
   *  실효 게이트는 백엔드 한 곳(commands::slides::slide_preview_render) — 프런트는 저장만 한다. */
  slidePreview: "auto" | "off";
  setSlidePreview: (v: "auto" | "off") => Promise<void>;
  /** soffice 실행 파일 경로 override. 빈 문자열 = 자동 탐지(PATH → OS 표준 설치 경로). */
  sofficePath: string;
  setSofficePath: (v: string) => Promise<void>;
  /** P3 수집 v2: 모든 collection 경로(visits·clip·link_paste)가 공유하는 도메인 차단 목록.
   *  capture_visit_excluded_domains 의 상위 호환 — visits 채널은 새 키 우선 + 구 키 폴백. */
  collectExcludedDomains: string[];
  setCollectExcludedDomains: (v: string[]) => Promise<void>;
  /** link_suggest 가 요약 생성에 쓸 모델 오버라이드. 빈 문자열·null 이면 전역 ai_model 폴백
   *  (commands::suggestions::link_proposal). 프로바이더 검증은 link_suggestions_active 게이트가
   *  담당하므로 별도 검증 없음. */
  linkSuggestionsModel: string;
  setLinkSuggestionsModel: (v: string) => Promise<void>;
  /** 수집 자동 러너 일시중지 마스터 스위치. ISO-8601 datetime 문자열(미래 시각이면 일시중지) 또는
   *  빈 문자열(정상). 백엔드(crate::collect::run_cycle) 가 매 tick 읽어 find_due 자체를
   *  건너뛴다 — 자동 수집만 차단하고 "지금 실행" 버튼·브라우저 클리핑·링크 붙여넣기는 영향받지
   *  않는다. 사용자가 끄면 빈 문자열로 되돌린다. */
  collectPausedUntil: string;
  setCollectPausedUntil: (v: string) => Promise<void>;
  /** PLAN-2026-08-30 §4 W7 — 본 기능 온보딩 브리핑 id 누적(FeatureBriefModal). 같은 배열이
   *  소급 시딩 sentinel(lib/featureBriefs.ts::FEATURE_BRIEF_SEED_SENTINEL)도 담는다 — 새 설정
   *  키를 추가하지 않기 위해서다(§4 W7 "새 설정 키를 또 만들지 마라"). */
  seenFeatureBriefs: string[];
  setSeenFeatureBriefs: (v: string[]) => Promise<void>;
  /** PLAN-2026-09-01 W0 — 챗이 수집 소스를 등록하는 경로의 킬 스위치. 기본 OFF(옵트인).
   *  lib/chatPipeline.ts 의 add_collect_source 분기가 실행 직전에 이 값과 chatWriteEnabled 를
   *  함께 본다 — 꺼져 있으면 IPC 를 쏘지 않고 안내 메시지로 강등한다. */
  collectChatRegister: boolean;
  setCollectChatRegister: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-01 W0 — 노트 진행 상태 "추가" 진입점 잠금. 기본 OFF(=추가 가능).
   *  진입점이 둘(사이드바 StatusFilter · 대시보드 HomeTabActions)이라 두 곳이 같은 셀렉터를
   *  읽고, stores/taxonomy.ts::addStatus 가 우회 경로까지 막는다. */
  statusAddLocked: boolean;
  setStatusAddLocked: (v: boolean) => Promise<void>;
  /** PLAN-2026-09-04-local-import §3b — 첫 부팅 자동 감지(lib/collectDetectOnce.ts)가 찾은,
   *  아직 소스로 등록되지 않은 로컬 후보 개수. 설정 > 수집 레일 항목의 뱃지 숫자
   *  (SettingsPanel.tsx). 수집 페이지를 한 번 열면(CollectSection 마운트) 0으로 돌아간다. */
  collectDetectPending: number;
  setCollectDetectPending: (v: number) => Promise<void>;
  /** PLAN-2026-09-04-local-import §3b — 첫 실행 자동 감지를 이미 돌렸는지. true가 되면
   *  App.tsx 부팅 이펙트가 다시는 collect_detect_local을 부르지 않는다(세션당이 아니라
   *  영구히 — 수집 페이지를 한 번이라도 연 사용자는 그 뒤로 자동 감지가 필요 없다). */
  collectDetectSeen: boolean;
  setCollectDetectSeen: (v: boolean) => Promise<void>;
}

/** 지금 화면의 모양 값 10개를 설정 키 그대로 — 되돌리기 스냅샷(PLAN-2026-09-19 §5).
 *  키 목록은 Rust `settings_schema.rs::APPEARANCE_KEYS` 와 같아야 한다(appearanceKeys.test.ts 가 대조). */
export function appearanceEntries(
  s: Pick<SettingsState, "themePref" | "accent" | "fontFamily" | "fontScale" | "bgDim" | "bgTone" | "bgSat" | "contentTint" | "surfaceStyle" | "sheetAlpha">,
): Record<string, unknown> {
  return {
    theme: s.themePref,
    accent: s.accent,
    font_family: s.fontFamily,
    font_scale: s.fontScale,
    bg_dim: s.bgDim,
    bg_tone: s.bgTone,
    bg_sat: s.bgSat,
    content_tint: s.contentTint,
    surface_style: s.surfaceStyle,
    sheet_alpha: s.sheetAlpha,
  };
}

const defaultSettings = (): Omit<SettingsState,
  "applyRoot" | "load" | "setTheme" | "setAccent" | "setFontScale" | "setBgDim" | "setUiLock" |
  "setLeftWidth" | "setSourcePct" | "setAiEnabled" | "setAiPostProcess" | "setAiChatMemory" | "setAiConfirmBeforeApply" | "setAiDebugVerbose" | "setChatWriteEnabled" | "setChatReadHistory" | "setChatReadFiles" | "loaded" | "setSourceOriginalPolicy" | "setUiLang" | "setUpdateCheckAuto" |
  "setBgTone" | "setBgSat" | "setContentTint" | "setSurfaceStyle" | "setSheetAlpha" | "addRecentColorHue" | "addEmojiRecent" | "toggleEmojiFavorite" | "setDefaultMapLocation" | "setRegionEnabled" | "setFilterRoster" | "setDashboardTabs" | "setOnboardingCompleted" | "setPhrasePackId" | "setEditorFullWidth" | "setSpellcheckEnabled" | "setWeekStart" | "setHolidayRegion" | "setCloseToTray" | "setLinkSuggestions" | "setDateNudgeAuto" | "setRegionNudgeStrict" |
  "setDateNudgeEnabled" | "setRegionNudgeEnabled" | "setPasteLinkNudge" | "setPastePathInlineCode" | "setPasteTableSheetSuggest" | "setEditorMdAutoformat" | "setDateNudgeMode" | "setRegionNudgeMode" |
  "setLinkOpenOnClick" | "setEditorWidth" | "setEditorWordCount" | "setNewNoteDatePrecision" | "setNewNoteSectionName" | "setPhotoMetaMode" | "setVoiceTranscribeMode" | "setVoiceCleanupMode" |
  "setBriefingEnabled" | "setBriefingWhen" | "setBriefingTime" | "setBriefingLastShown" | "setBriefingEveningEnabled" | "setBriefingEveningTime" | "setBriefingLastShownEvening" | "setBriefingNotify" | "setBriefingLastSeen" | "setFavoritesOpen" | "setBackupNudgePending" |
  "setNotificationsEnabled" | "setReminderAllDayAt" | "setUserName" | "setFontFamily" | "setPetDblclickAction" | "setChatMemory" | "addChatMemory" | "removeChatMemory" |   "setAttachmentStorageMode" | "setSlidePreview" | "setSofficePath" | "setCollectExcludedDomains" | "setLinkSuggestionsModel" | "setCollectPausedUntil" | "setSeenFeatureBriefs" | "setCollectChatRegister" | "setStatusAddLocked" | "setCollectDetectPending" | "setCollectDetectSeen" | "setAiPolicyLevel" | "applySurfaceEffectAfterShow" | "applyAppearance" | "reloadAppearance" | "setAssistPresetAutorun"> => {
  const seed = loadAppearanceSeed();
  return {
    themePref: seed.themePref,
    theme: seed.theme,
    accent: seed.accent,
    fontScale: seed.fontScale,
    bgDim: seed.bgDim,
    uiLock: false,
    leftWidth: 324,
    sourcePct: 25, // 온보딩 직후 어시스트 창이 화면 절반을 먹지 않도록 — 에디터가 주인공 (2026-08-20 오너)
    activeWorkspaceId: null,
    aiEnabled: false,
    aiPostProcess: true,
    aiChatMemory: true,
    aiConfirmBeforeApply: true,
    assistPresetAutorun: false,
    aiDebugVerbose: false,
    aiPolicyLevel: "organize",
    chatWriteEnabled: true,
    linkSuggestions: false,
    dateNudgeAuto: false,
    // PLAN-2026-09-19-date-region-ui.md §P3 D12 — 백엔드 default_settings 시드(true)와 같은 값.
    regionNudgeStrict: true,
    // 오너 결정(2026-09-20) — 여섯 키 전부 백엔드 default_settings 시드(true)와 같은 값
    // (오늘까지의 동작 유지). PREFS 의 boolDefaultTrue 가 load() 의 강제 변환도 맡는다.
    dateNudgeEnabled: true,
    regionNudgeEnabled: true,
    pasteLinkNudge: true,
    pastePathInlineCode: true,
    pasteTableSheetSuggest: true,
    editorMdAutoformat: true,
    // 실험적(2026-09-20, "4~7번도 넣어봐") — 백엔드 default_settings 시드와 같은 값. 넷 다
    // "오늘까지의 동작 유지"가 목적이 아니라 새 값이라 기본값이 제각각이다(불리언 둘은 false,
    // editorWidth/newNoteDatePrecision 은 "오늘과 같은 뜻"의 문자열, newNoteSectionName 은
    // "내장 기본 이름을 쓴다"는 빈 문자열).
    linkOpenOnClick: false,
    editorWidth: "normal",
    editorWordCount: true,
    newNoteDatePrecision: "day",
    newNoteSectionName: "",
    // S2 입력 — 백엔드 default_settings 시드와 같은 값(사진 auto / 음성 auto / 정리 off).
    photoMetaMode: "auto",
    voiceTranscribeMode: "auto",
    voiceCleanupMode: "off",
    briefingEnabled: true,
    briefingWhen: "time",
    briefingTime: "08:00",
    briefingLastShown: "",
    briefingEveningEnabled: false,
    briefingEveningTime: "21:00",
    briefingLastShownEvening: "",
    briefingNotify: "window",
    briefingLastSeen: "",
    favoritesOpen: false,
    backupNudgePending: false,
    onboardingCompleted: false,
    sourceOriginalPolicy: "ask",
    uiLang: "ko",
    updateCheckAuto: true,
    bgTone: seed.bgTone,
    bgSat: seed.bgSat,
    // 0 = tokens.css 의 테마 기준값 그대로(다크 16% / 라이트 7%). 시드에는 담지 않는다 —
    // 첫 페인트는 CSS 기본값이 이미 같은 그림을 그리고, load() 가 곧바로 실제 값을 적용한다.
    contentTint: 0,
    surfaceStyle: seed.surfaceStyle,
    // W15 Part 3: 시드에 저장된 지난 실측값으로 시작한다(추측 아님) — load()/applySurfaceEffectAfterShow
    // 가 실제 OS 호출 결과로 다시 확정한다. 구 시드(필드 없음)는 loadAppearanceSeed 가 true 로 채운다.
    surfaceEffectApplied: seed.surfaceEffectApplied,
    acrylicSupported: true,
    sheetAlpha: seed.sheetAlpha,
    recentColorHues: [],
    emojiRecent: [],
    emojiFavorites: [],
    defaultMapLocation: FACTORY_DEFAULT_MAP_LOCATION,
    defaultMapLocationCustomized: false,
    // 기본 ON — 백엔드 default_settings 시드("1")와 같은 값. 키가 아예 없는 구 설치도 ON 으로
    // 읽어 업그레이드 전후 화면이 같다(load() 의 `!== "0"`).
    regionEnabled: true,
    filterRoster: normalizeFilterRoster([]),
    dashboardTabs: normalizeDashboardTabs([]),
    // Default to first bundled pack; user can switch off in Settings.
    phrasePackId: defaultPhrasePackId(),
    editorFullWidth: false,
    // 백엔드 default_settings 시드("false")와 같은 값 — spellcheck_enabled, §2.2.
    spellcheckEnabled: false,
    weekStart: "sunday",
    holidayRegion: "none",
    closeToTray: true,
    notificationsEnabled: false,
    reminderAllDayAt: "00:00",
    userName: "",
    fontFamily: seed.fontFamily ?? "pretendard",
    petDblclickAction: "new_note",
    chatMemory: [],
    attachmentStorageMode: "copy",
    slidePreview: "auto",
    sofficePath: "",
    // 빈 배열 = 차단 도메인 없음. capture_visit_excluded_domains (구 키)는 부팅 시
    // load() 에서 한 번 읽어 비어있으면 폴백한다(setSimplePref 가 그 역할).
    collectExcludedDomains: [],
    // 빈 문자열 = 전역 ai_model 폴백(commands::suggestions::link_proposal). 시드하지 않은
    // link_suggestions_model 키는 load() 에서 미존재 = 빈 문자열로 매핑된다.
    linkSuggestionsModel: "",
    // 빈 문자열 = 일시중지 아님. 키 부재/빈 문자열/과거 시각 모두 정상 동작.
    collectPausedUntil: "",
    // 빈 배열 = 아직 아무 브리핑도 못 봤고, 소급 시딩도 아직 안 돌았음(useFeatureBrief.ts 가
    // 첫 loaded 전환 때 정확히 한 번 채운다).
    seenFeatureBriefs: [],
    // 둘 다 옵트인 — 백엔드 default_settings 의 시드(false)와 같은 값.
    collectChatRegister: false,
    statusAddLocked: false,
    chatReadHistory: true,
    chatReadFiles: true,
    // 둘 다 시드하지 않는 키(부재 = 이 기본값) — §3b, collectPausedUntil과 같은 "빈 문자열/
    // false = 아직 아무 일도 없었음" 부류.
    collectDetectPending: 0,
    collectDetectSeen: false,
  };
};



// 배경 밝기 슬라이더(bg_tone·bg_dim)의 저장 — setBgSat 과 같은 live/commit 분리. 드래그 틱(live)은
// 조용히 저장해 본 창이 실시간으로 따라오게 하고(토스트가 틱마다 뜨면 안 된다), 손을 뗀 확정은 call() 로
// 실패를 보인다. 롤백은 하지 않는다 — 확정 직전 값은 이미 같은 값으로 저장된 마지막 틱이라 되돌릴 곳이 없다.
function saveBgSlider(entries: Record<string, number>, live?: boolean) {
  if (live) {
    void callSilent("settings_set", { entries }).catch(() => {});
    return;
  }
  void (async () => {
    try {
      await call("settings_set", { entries });
    } catch {
      // call() 이 이미 토스트를 띄웠다
    }
  })();
}

// Simple settings — persist-only, no CSS/OS side effect (unlike theme/accent/bgTone/surfaceStyle/
// etc, which stay hand-written below). One descriptor per key drives BOTH load()'s coercion (raw
// JSON value -> typed default) and the setter's snake_case persistence key — previously these were
// two hand-maintained copies of the same camel<->snake table that could (and did) drift apart.
export type AttachmentStorageMode = "copy" | "link" | "reference";

// Exported so lib/aiCapabilities.ts (settings.ts §3 W2) can type-check its "kill switch" control
// keys against the same set setSimplePref() actually persists — one drift-checked source instead
// of a second hand-maintained key list.
export type SimplePrefKey =
  | "uiLock" | "aiEnabled" | "aiPostProcess" | "aiChatMemory" | "aiConfirmBeforeApply" | "assistPresetAutorun" | "aiDebugVerbose" | "aiPolicyLevel" | "chatWriteEnabled" | "linkSuggestions" | "dateNudgeAuto" | "regionNudgeStrict" | "onboardingCompleted" | "sourceOriginalPolicy" | "uiLang" | "updateCheckAuto"
  | "defaultMapLocation" | "filterRoster" | "dashboardTabs" | "editorFullWidth" | "spellcheckEnabled"
  | "weekStart" | "holidayRegion" | "closeToTray" | "notificationsEnabled" | "reminderAllDayAt" | "userName" | "fontFamily"
  | "petDblclickAction" | "chatMemory" | "attachmentStorageMode" | "slidePreview" | "sofficePath"
  | "collectExcludedDomains" | "linkSuggestionsModel" | "collectPausedUntil" | "seenFeatureBriefs"
  | "collectChatRegister" | "statusAddLocked" | "collectDetectPending" | "collectDetectSeen"
  | "chatReadHistory" | "chatReadFiles" | "contentTint"
  | "dateNudgeEnabled" | "regionNudgeEnabled" | "pasteLinkNudge" | "pastePathInlineCode" | "pasteTableSheetSuggest" | "editorMdAutoformat"
  | "linkOpenOnClick" | "editorWidth" | "editorWordCount" | "newNoteDatePrecision" | "newNoteSectionName" | "photoMetaMode" | "voiceTranscribeMode" | "voiceCleanupMode"
  | "briefingEnabled" | "briefingWhen" | "briefingTime" | "briefingLastShown" | "briefingEveningEnabled" | "briefingEveningTime" | "briefingLastShownEvening" | "briefingNotify" | "briefingLastSeen"
  | "favoritesOpen" | "backupNudgePending";

interface PrefDescriptor<K extends SimplePrefKey> {
  camel: K;
  snake: string;
  coerce: (raw: unknown) => SettingsState[K];
}

function pref<K extends SimplePrefKey>(
  camel: K,
  snake: string,
  coerce: (raw: unknown) => SettingsState[K],
): PrefDescriptor<K> {
  return { camel, snake, coerce };
}

const boolDefaultFalse = (raw: unknown) => Boolean(raw);
const inputAutoModeOr = (raw: unknown, fallback: InputAutoMode): InputAutoMode =>
  raw === "off" || raw === "ask" || raw === "auto" ? raw : fallback;
// §3b collect_detect_pending — 숫자가 아니면(부재 포함) 0. 백엔드가 0..=99로 검증하므로 여기는
// 방어적 clamp까지는 하지 않는다(잘못된 값이 저장돼 있었다면 그 자체가 버그 신호).
const numDefault0 = (raw: unknown) => (typeof raw === "number" ? raw : 0);
// header_*_visible predate this table and used "missing key = true" (not Boolean()'s "missing =
// false") — new users get every header widget on by default.
const boolDefaultTrue = (raw: unknown) => (raw === undefined ? true : Boolean(raw));

const PREFS = [
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
  pref("editorWidth", "editor_width", (raw) =>
    raw === "narrow" || raw === "normal" || raw === "wide" ? raw : "normal",
  ),
  pref("newNoteDatePrecision", "new_note_date_precision", (raw) =>
    raw === "day" || raw === "month" || raw === "year" ? raw : "day",
  ),
  // 저장 전 클램프는 setNewNoteSectionName(아래)이 맡는다 — 여기 coerce 는 이미 잘못 저장된 값
  // (수동 DB 편집·구버전 왕복 등)을 읽을 때의 방어선이라 같은 규칙(trim + 40자)을 한 번 더 건다.
  pref("newNoteSectionName", "new_note_section_name", (raw) =>
    typeof raw === "string" ? raw.trim().slice(0, 40) : "",
  ),
  // S2 입력 3종 — settings_schema.rs 기본값과 동일. 결측/오타는 각자의 기본값으로 폴백.
  pref("photoMetaMode", "photo_meta_mode", (raw) => inputAutoModeOr(raw, "auto")),
  pref("voiceTranscribeMode", "voice_transcribe_mode", (raw) => inputAutoModeOr(raw, "auto")),
  pref("voiceCleanupMode", "voice_cleanup_mode", (raw) => inputAutoModeOr(raw, "off")),
  pref("onboardingCompleted", "onboarding_completed", boolDefaultFalse),
  pref("briefingEnabled", "briefing_enabled", boolDefaultTrue),
  pref("briefingWhen", "briefing_when", (raw) => (raw === "launch" || raw === "manual" ? raw : "time")),
  pref("briefingTime", "briefing_time", (raw) =>
    typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : "08:00",
  ),
  pref("briefingLastShown", "briefing_last_shown", (raw) => (typeof raw === "string" ? raw : "")),
  pref("briefingEveningEnabled", "briefing_evening_enabled", boolDefaultFalse),
  pref("briefingEveningTime", "briefing_evening_time", (raw) =>
    typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : "21:00",
  ),
  pref("briefingLastShownEvening", "briefing_last_shown_evening", (raw) => (typeof raw === "string" ? raw : "")),
  pref("briefingNotify", "briefing_notify", (raw) => (raw === "os" || raw === "both" ? raw : "window")),
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
  pref("weekStart", "week_start", (raw) =>
    ["sunday", "monday"].includes(raw as string) ? (raw as WeekStart) : "sunday",
  ),
  pref("holidayRegion", "holiday_region", (raw) =>
    ["none", "kr"].includes(raw as string) ? (raw as HolidayRegion) : "none",
  ),
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
  // W11: 글꼴 패밀리 ("serif" | "sans" | 시스템 글꼴명). 기본 "serif".
  pref("fontFamily", "font_family", (raw) =>
    typeof raw === "string" && raw.trim().length > 0 ? raw : "serif",
  ),
  // W18: 펫 반응 설정 & 챗봇 메모리 (클릭=채팅 고정, pet_click_action 삭제)
  pref("petDblclickAction", "pet_dblclick_action", (raw) => {
    // W18: 구값 search/open_note 를 new_note 로 흡수 (마이그레이션 없음, normalizeFilterRoster 패턴)
    if (raw === "search" || raw === "open_note") return "new_note";
    if (raw === "chat" || raw === "new_note" || raw === "off") return raw as PetDblclickAction;
    return "new_note";
  }),
  pref("chatMemory", "chat_memory", (raw) => {
    if (Array.isArray(raw)) {
      return raw.filter((item) =>
        item && typeof item === "object" && typeof (item as any).id === "string" && typeof (item as any).text === "string"
      ).slice(0, 50) as ChatMemoryItem[];
    }
    return [];
  }),
  pref("attachmentStorageMode", "attachment_storage_mode", (raw) =>
    ["copy", "link", "reference"].includes(raw as string) ? (raw as AttachmentStorageMode) : "copy",
  ),
  pref("slidePreview", "slide_preview", (raw) => (raw === "off" ? "off" : "auto")),
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

const PREF_SNAKE = Object.fromEntries(PREFS.map((p) => [p.camel, p.snake])) as Record<SimplePrefKey, string>;

// setSimplePref 가 실패 사이 같은 키에 새 요청이 뜨면(연타 토글) 그 옛 실패로 롤백하지
// 않기 위한 요청 순번표 — 스토어 인스턴스당 하나면 충분하다(useSettingsStore 는 싱글턴).
const simplePrefSeq: Partial<Record<SimplePrefKey, number>> = {};
// 같은 규약을 PREFS 밖의 클릭 setter(setTheme·setSurfaceStyle·setFontFamily·setDefaultMapLocation)
// 에도 건다 — 실패가 확정된 순간에도 내가 그 setter 의 최신 요청일 때만 롤백한다.
const clickSeq: Record<string, number> = {};
const nextClickSeq = (key: string) => (clickSeq[key] = (clickSeq[key] ?? 0) + 1);
const isLatestClick = (key: string, seq: number) => clickSeq[key] === seq;

export const useSettingsStore = create<SettingsState>((set, get) => {
  // Shared body for every simple setX above: optimistic set() + persist, with rollback on failure.
  //
  // 롤백: 재시작하면 DB 값(구값)으로 돌아가므로, 실패했는데 화면 값을 그대로 두면 "저장된 척"
  // 하는 상태가 된다(2026-09-01 GalleryExpanded 첨부 삭제와 같은 결함 계열 — 표준형은
  // catch { setItems(prev) }).
  //
  // 레이스: 같은 키를 빠르게 연타하면(체크박스 두 번 클릭) 먼저 쏜 요청이 나중에 실패로
  // 확정될 수 있다. 그 옛 실패로 무조건 롤백하면 그 사이 성공했거나 아직 진행 중인 최신 값을
  // 덮어쓴다 — 순번(simplePrefSeq)을 찍어, 실패가 확정된 시점에도 "내가 여전히 이 키의
  // 최신 요청"일 때만 롤백한다. 옛 요청이 롤백을 건너뛰어도 그 뒤 최신 요청이 성공하면 결국
  // 올바른 값에 수렴한다(last-write-wins) — 실패한 옛 요청과 성공한 새 요청의 도착 순서까지
  // 강제로 재정렬하는 큐는 여기서는 과함.
  //
  // rejection: 여기서 삼킨다(재던지지 않는다). call() 이 이미 에러 토스트를 띄우므로 사용자는
  // 실패를 안다. 재던지면 이 함수를 지나는 25곳 넘는 호출부(`void setX(...)` onChange 핸들러,
  // async IIFE 안의 await 등)가 전부 개별적으로 .catch 를 달아야 하는데 — 그건 "모든 호출자가
  // 지나가는 지점에서 한 번 고친다" 원칙에 반하고(증상 위치에 가드를 덧대는 것과 같은 실수),
  // 실제로 몇몇(chatPipeline.ts 의 void extractAndSaveChatMemory, OnboardingWizard 의 async
  // IIFE)은 그냥 두면 진짜 미처리 rejection 이 샌다. `await setX(...)` 뒤 성공을 가정하고
  // 이어가는 소수 호출부(OnboardingWizard, chatMemoryExtractor.ts)는 실패해도 조용히 다음
  // 단계로 넘어가지만, 유일하게 결과가 갈리는 setAiEnabled 후속 처리(ensureAiReachable)는
  // 로컬 스토어가 아니라 DB 를 다시 읽어 판단하므로(stores/ai.ts::ensureAiReachable) 롤백된
  // 값과 무관하게 스스로 정합성을 되찾는다.
  const setSimplePref = async <K extends SimplePrefKey>(camel: K, value: SettingsState[K]) => {
    const prev = get()[camel];
    const seq = (simplePrefSeq[camel] ?? 0) + 1;
    simplePrefSeq[camel] = seq;
    set({ [camel]: value } as Pick<SettingsState, K>);
    try {
      await call("settings_set", { entries: { [PREF_SNAKE[camel]]: value } });
    } catch {
      if (simplePrefSeq[camel] === seq) set({ [camel]: prev } as Pick<SettingsState, K>);
    }
  };

  // 외형 값을 set() 한 직후의 공통 꼬리 — 시드(다음 부팅의 첫 페인트) 저장 → CSS 변수 재칠, 이 순서.
  // setTheme·setSurfaceStyle 은 OS 효과(syncWindowEffect) 결과를 set() 한 뒤 이걸 다시 부른다.
  // setBgSat 확정·reloadAppearance·시스템 테마 리스너는 순서와 끼어드는 문장이 제각각이라 묶지 않았다.
  const repaint = () => {
    saveAppearanceSeed(get());
    applyCssVars(get());
  };

  return {
  ...defaultSettings(),
  loaded: false,
  applyRoot: () => applyCssVars(get()),
  load: async () => {
    // 이 창에서 load() 가 처음인가 — 아래 surfaceEffectApplied 처리의 분기 기준이다.
    // (loaded 는 이 함수 끝의 set 에서 true 가 되므로 그 전에 잡아둔다.)
    const firstLoad = !get().loaded;
    const r = await call<{ settings: Record<string, unknown> }>("settings_get_all");
    const s = r.settings;
    if (firstLoad && !isBrowser()) {
      // 선택 차단(PLAN-2026-09-19 §4-2)용 질의 — 실패하면 낙관값(true)을 그대로 둔다.
      // settings_get_all 뒤에 둔다: 테스트 목들이 첫 호출을 그 응답으로 잡는다.
      void callSilent<{ acrylic: boolean }>("window_surface_support")
        .then((r) => {
          if (typeof r?.acrylic === "boolean") set({ acrylicSupported: r.acrylic });
        })
        .catch(() => {});
    }
    // tabs.ts owns activeTabId/openTabs/recentClosedTabs — hydrate it from the same
    // settings_get_all response, at the same point in the boot sequence (no extra IPC round trip).
    useTabsStore.getState().hydrate(s);
    const simplePrefs = {} as Pick<SettingsState, SimplePrefKey>;
    for (const p of PREFS) (simplePrefs as any)[p.camel] = p.coerce(s[p.snake]);
    // collect_excluded_domains 폴백: 새 키가 비어있으면 구 capture_visit_excluded_domains 를
    // 한 번 읽어 채운다. 다음 사용자가 빈 문자열이 아닌 값을 저장하면 자동으로 새 키로 이관
    // (구 키는 그대로 남지만 더 이상 read 하지 않음). visits 채널(Rust ingest)도 같은 폴백
    // 패턴을 쓴다 — 위 capture_visit_excluded_domains 주석 참고.
    if (
      Array.isArray(simplePrefs.collectExcludedDomains) &&
      simplePrefs.collectExcludedDomains.length === 0
    ) {
      const legacy = s.capture_visit_excluded_domains;
      if (Array.isArray(legacy)) {
        const domains = legacy
          .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
          .slice(0, 200);
        if (domains.length > 0) simplePrefs.collectExcludedDomains = domains;
      }
    }
    // 마이그레이션: 구 로컬스토리지 AI 쓰기 게이트("brise.chatWriteEnabled", 삭제된
    // stores/chatWrite.ts 가 쓰던 키, "0"/"1" 저장)를 DB chat_write_enabled 로 옮긴다. 이 키가
    // 있던 유저가 OFF 로 저장해뒀다면 새 DB 기본값(true)에 조용히 덮여 켜지는 걸 막는다.
    // 키를 지우므로 다음 load() 부터는 건너뛴다 — 별도 "이미 실행함" 플래그가 필요 없다.
    let legacyChatWrite: boolean | null = null;
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("brise.chatWriteEnabled");
      if (raw !== null) {
        legacyChatWrite = raw !== "0" && raw !== "false";
        localStorage.removeItem("brise.chatWriteEnabled");
        simplePrefs.chatWriteEnabled = legacyChatWrite;
      }
    }
    // 언어 사전을 **먼저** 받고 나서 uiLang 을 바꾼다 — t() 는 동기라 바뀐 뒤에 받으면 리마운트가
    // 키 문자열로 그린다(i18n/locales.ts 헤더). 다른 창이 언어를 바꿔 이 창이 다시 읽는 경로도 여기다.
    // 이미 받아 둔 언어면(거의 항상) await 자체를 건너뛴다 — 상태 반영을 한 틱도 미루지 않게.
    if (!getDict(simplePrefs.uiLang)) await ensureLocale(simplePrefs.uiLang).catch((e: unknown) => reportFallback("i18n", "locale_load_failed", String(e)));
    rememberLocaleHint(simplePrefs.uiLang);
    set({
      ...simplePrefs,
      // 키 존재 여부 자체가 신호 — coerce 는 결측 시 FACTORY 값으로 채우므로 여기서 raw 값을
      // 따로 확인한다(위 simplePrefs.defaultMapLocation 은 좌표만, 커스텀 여부는 별도로 판정).
      defaultMapLocationCustomized: s.default_map_location !== undefined,
      // "0"/"1" 문자열 플래그라 PREFS 표(값을 그대로 다시 쓰는)가 아니라 여기서 읽는다 —
      // 키 부재 = ON(구 설치도 지금까지의 동작 그대로).
      regionEnabled: s.region_enabled !== "0",
      themePref: ((): ThemePref => {
        const raw = (s.theme as ThemePref) ?? get().themePref;
        return raw === "system" || raw === "light" || raw === "dark" ? raw : "dark";
      })(),
      theme: ((): Theme => {
        const raw = (s.theme as ThemePref) ?? get().themePref;
        const pref: ThemePref = raw === "system" || raw === "light" || raw === "dark" ? raw : "dark";
        return resolveTheme(pref);
      })(),
      // PLAN-2026-09-12 §4: 5색 화이트리스트를 폐기했다 — hue 슬라이더가 열려 값 공간이
      // 연속이라 열거가 불가능하다. 판정은 백엔드 validate_setting 과 같은 "hex 인가" 하나다.
      accent: isAccentHex(s.accent) ? s.accent : DEFAULT_ACCENT,
      fontScale: (s.font_scale as number) ?? 1,
      bgDim: (s.bg_dim as number) ?? 0,
      bgTone: clamp((s.bg_tone as number) ?? 0, BG_TONE_MIN, BG_TONE_MAX),
      bgSat: clamp((s.bg_sat as number) ?? 0, BG_SAT_MIN, BG_SAT_MAX),
      // 표면 프리셋 로드 매핑 — 구 DB 값 "mica"(2026-07-24 리네임 전)는 "acrylic"으로 읽어들인다.
      // 그 외 알 수 없는 값(레거시 "glass" 포함, 2026-07-21 제거)은 flat 으로 폴백. 다음 저장부터는
      // setSurfaceStyle 이 항상 "acrylic"/"flat" 만 쓴다.
      surfaceStyle: ((): SurfaceStyle => {
        const raw = s.surface_style as string;
        if (raw === "mica") return "acrylic";
        return raw === "acrylic" ? "acrylic" : "flat";
      })(),
      // sheet_alpha(신규 키)를 우선 읽고, 없으면 구 mica_alpha 로 폴백한다(2026-07-24 리네임 전
      // DB). ?? 는 null/undefined 만 폴백시키므로 0 처럼 falsy 하지만 유효한 값은 안 깨진다.
      sheetAlpha: clamp(
        ((s.sheet_alpha as number | undefined) ?? (s.mica_alpha as number | undefined)) ?? 0.85,
        SHEET_ALPHA_MIN,
        SHEET_ALPHA_MAX,
      ),
      leftWidth: (s.left_width as number) ?? 324,
      sourcePct: (s.source_pct as number) ?? 25,
      activeWorkspaceId: (s.active_workspace_id as string) ?? null,
      recentColorHues: Array.isArray(s.recent_color_hues)
        ? (s.recent_color_hues as unknown[]).filter((x): x is number => typeof x === "number" && x >= 0 && x <= 359)
        : [],
      emojiRecent: Array.isArray(s.emoji_recent)
        ? (s.emoji_recent as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      emojiFavorites: Array.isArray(s.emoji_favorites)
        ? (s.emoji_favorites as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      phrasePackId: (() => {
        const raw = s.phrase_pack_id as string | undefined;
        if (typeof raw === "string" && raw.length > 0) return raw;
        return defaultPhrasePackId();
      })(),
      loaded: true,
    });
    if (legacyChatWrite !== null) {
      await call("settings_set", { entries: { chat_write_enabled: legacyChatWrite } });
    }
    // 외형 서브셋을 localStorage 에 시드로 저장 (WAVE K)
    saveAppearanceSeed(get());
    attachSystemThemeListener(async (resolved) => {
      if (get().themePref === "system") {
        set({ theme: resolved });
        saveAppearanceSeed(get());
        applyCssVars(get());
        const style = get().surfaceStyle;
        if (style !== "flat") {
          const applied = await syncWindowEffect(style, resolved, get().bgSat);
          set({ surfaceEffectApplied: applied });
          applyCssVars(get());
          saveAppearanceSeed(get());
        }
      }
    });
    // Acrylic is applied only after show() (applySurfaceEffectAfterShow). Calling
    // window-vibrancy on a hidden HWND kills the handle and the window never appears.
    // Until then, pretend the OS effect is off so applyCssVars keeps an opaque --bg.
    //
    // **이미 적용된 뒤에 다시 load() 되면 그 값을 되감지 않는다**(2026-08-14). load() 는 이제
    // 부팅 때만 도는 함수가 아니다 — 설정 창이 별도 웹뷰가 되면서 lib/settingsChanged.ts 가
    // 설정이 써질 때마다 load() 를 다시 돌린다. 창 지오메트리 저장 같은 무해한 쓰기만으로도
    // 아크릴이 flat 으로 되감겨 창이 통째로 불투명해졌다. 아직 안 걸린 상태(false)는 그대로
    // 두어 "show 전에는 끈 척한다"는 원래 계약을 지킨다.
    set({
      surfaceEffectApplied:
        get().surfaceStyle === "flat" || (!firstLoad && get().surfaceEffectApplied),
    });
    applyCssVars(get());
    return s;
  },
  applyAppearance: async (entries) => {
    const next = { ...entries };
    // 수입 차단(§4-3) — 이 기기에서 못 거는 재질을 저장해 두면 다음 부팅마다 "지원 안 됨"만 뜬다.
    const blockedAcrylic = next.surface_style === "acrylic" && !get().acrylicSupported;
    if (blockedAcrylic) next.surface_style = "flat";
    await call("settings_set", { entries: next });
    // setter 10개를 차례로 부르지 않는다 — setTheme/setBgSat/setSurfaceStyle 이 각자 OS 효과를 다시
    // 걸어 2026-07-24 의 깜빡임을 되풀이한다.
    await get().reloadAppearance();
    return { blockedAcrylic };
  },
  reloadAppearance: async () => {
    // 상태·CSS 변수·시드는 load() 가 한 번에 맞추고, OS 효과는 여기서 **한 번만** 건다(flat 이어도
    // 부른다 — 이전 아크릴을 지워야 한다). 모양이 통째로 바뀌는 두 경로 — 모양 불러오기/초기화
    // (applyAppearance)와 노트북 전환(workspaces.switchTo, PLAN-2026-09-19-notebook-settings §4) —
    // 가 같이 쓴다.
    await get().load();
    const { surfaceStyle, theme, bgSat } = get();
    const applied = await syncWindowEffect(surfaceStyle, theme, bgSat);
    set({ surfaceEffectApplied: applied });
    applyCssVars(get());
    saveAppearanceSeed(get());
  },
  applySurfaceEffectAfterShow: async () => {
    const style = get().surfaceStyle;
    const applied = style === "flat" ? true : await syncWindowEffect(style, get().theme, get().bgSat);
    set({ surfaceEffectApplied: applied });
    applyCssVars(get());
    // W15 Part 3: 이게 매 부팅 최초로 "진짜" OS 결과가 확정되는 지점이다 — 시드에 저장해 다음
    // 부팅의 applySavedAppearanceSeed 가 추측 대신 이 실측값을 쓰게 한다(App.tsx/AuxWindowChrome.tsx
    // 둘 다 이 함수를 거치므로 여기 한 번이면 모든 창을 커버한다).
    saveAppearanceSeed(get());
    // 외형이 확정됐다 — index.html 이 부팅 동안 꺼 둔 transition 을 되살린다(같은 이유로 여기 한 곳).
    endBootTransitions();
  },
  setTheme: async (t) => {
    // 클릭 한 번 — 낙관적으로 칠하고, 저장이 실패하면 **OS 효과까지** 이전 테마로 되돌린다(함정 9).
    // 틴트는 테마색 기반이라 acrylic 이면 테마가 바뀔 때마다 OS 효과를 다시 건다(flat 은 걸 게 없다).
    // --sheet-alpha 슬라이더 드래그는 이 경로를 타지 않는다(별개 CSS 값).
    const prevPref = get().themePref;
    const seq = nextClickSeq("theme");
    const paint = async (pref: ThemePref) => {
      const resolved = resolveTheme(pref);
      set({ themePref: pref, theme: resolved });
      repaint();
      const style = get().surfaceStyle;
      if (style !== "flat") {
        const applied = await syncWindowEffect(style, resolved, get().bgSat);
        set({ surfaceEffectApplied: applied });
        // OS 실측 결과도 시드에 넣어야 다음 부팅의 첫 페인트가 추측하지 않는다(W15 Part 3).
        repaint();
      }
    };
    await paint(t);
    try {
      await call("settings_set", { entries: { theme: t } });
    } catch {
      // call() 이 이미 토스트를 띄웠다. 그 사이 더 새 선택이 있었다면 그쪽이 이긴다.
      if (isLatestClick("theme", seq)) await paint(prevPref);
    }
  },
  // ── 슬라이더/드래그로 끄는 값은 전부 `void callSilent(...).catch(() => {})` 다 ──
  // 이유 둘. ⓐ 드래그 한 번에 틱마다 IPC 가 나간다(강조색 hue 슬라이더는 0→360 한 번에 최대
  // 361회) — 실패하면 call() 은 토스트를 띄우므로 화면이 토스트로 덮인다. ⓑ 호출부는
  // fire-and-forget 이라 rejection 을 받을 사람이 없는데, call() 도 callSilent() 도 **다시
  // throw** 한다(함정 8) — .catch 로 여기서 끝내지 않으면 진짜 미처리 rejection 이 샌다.
  // 아래 setBgTone·setContentTint·setSheetAlpha 도 같은 규칙이고, 예외는 없다.
  // 반대로 **클릭 한 번으로 끝나는** 값(setTheme·setSurfaceStyle·setFontFamily)은 call() 이 맞다 — 사용자가
  // 방금 누른 행동의 실패는 보여야 하고, 화면도 되돌려야 한다(함정 9).
  //
  // 가르는 기준은 **setter 이름이 아니라 그 순간의 호출 경로**다. 강조색이 그 예다: hue
  // 슬라이더는 드래그지만 채도 5칩과 초기화 버튼은 클릭 한 번이고, 셋 다 setAccent 을 부른다.
  // setter 를 통째로 조용하게 만들면 클릭 경로 여섯이 말없이 실패하므로 `live` 로 가른다.
  // (setFontFamily 의 직접 입력 칸은 타이핑마다가 아니라 blur/Enter 에서 한 번 확정한다.)
  setAccent: async (a, opts) => {
    const prev = get().accent;
    const paint = (v: Accent) => {
      set({ accent: v });
      repaint();
    };
    paint(a);
    if (opts?.live) {
      // 드래그 틱 — 0→360 한 번에 최대 361회다. 토스트도 롤백도 여기서는 해가 된다(손을 떼는
      // 순간 호출부가 옵션 없이 한 번 더 불러 확정한다).
      await callSilent("settings_set", { entries: { accent: a } }).catch(() => {});
      return;
    }
    try {
      await call("settings_set", { entries: { accent: a } });
    } catch {
      // call() 이 이미 토스트를 띄웠다 — 여기서는 화면이 거짓말하지 않게 되돌리기만 한다.
      paint(prev);
    }
  },
  setFontScale: (v) => {
    set({ fontScale: v });
    repaint();
    void callSilent("settings_set", { entries: { font_scale: v } }).catch(() => {});
  },
  setBgDim: (v, opts) => {
    set({ bgDim: v });
    repaint();
    // acrylic OS 틴트는 이제 테마 고정값이라 bg_dim 과 무관하다(2026-07-24 개정) — 콘텐츠
    // (--surface-base, CSS)에만 즉시 반영되면 충분하고 재적용/디바운스가 필요 없다.
    saveBgSlider({ bg_dim: v }, opts?.live);
  },
  setUiLock: (v) => setSimplePref("uiLock", v),
  // 영속은 드래그가 끝났을 때 일괄 처리한다. 여기서 반올림하는 게 핵심: 두 값 모두 마우스
  // 좌표에서 나오므로 소수(예: 43.27)가 되는데, 백엔드 validate_setting 은 as_i64() 로 검사해
  // 소수를 통째로 거부한다. source_pct 는 에러 토스트로, left_width 는 .catch(()=>{}) 때문에
  // 조용히 실패하고 있었다 — 상태 자체를 정수로 유지해서 두 경로를 한 번에 막는다.
  setLeftWidth: (v) => set({ leftWidth: Math.round(v) }),
  setSourcePct: (v) => set({ sourcePct: Math.round(v) }),
  setAiEnabled: (v) => setSimplePref("aiEnabled", v),
  setAiPostProcess: (v) => setSimplePref("aiPostProcess", v),
  setAiChatMemory: (v) => setSimplePref("aiChatMemory", v),
  setAiConfirmBeforeApply: (v) => setSimplePref("aiConfirmBeforeApply", v),
  setAssistPresetAutorun: (v) => setSimplePref("assistPresetAutorun", v),
  setAiDebugVerbose: (v) => setSimplePref("aiDebugVerbose", v),
  setAiPolicyLevel: (v) => setSimplePref("aiPolicyLevel", v),
  setChatWriteEnabled: (v) => setSimplePref("chatWriteEnabled", v),
  setChatReadHistory: (v) => setSimplePref("chatReadHistory", v),
  setChatReadFiles: (v) => setSimplePref("chatReadFiles", v),
  setLinkSuggestions: (v) => setSimplePref("linkSuggestions", v),
  setDateNudgeAuto: (v) => setSimplePref("dateNudgeAuto", v),
  setRegionNudgeStrict: (v) => setSimplePref("regionNudgeStrict", v),
  setDateNudgeEnabled: (v) => setSimplePref("dateNudgeEnabled", v),
  setRegionNudgeEnabled: (v) => setSimplePref("regionNudgeEnabled", v),
  setPasteLinkNudge: (v) => setSimplePref("pasteLinkNudge", v),
  setPastePathInlineCode: (v) => setSimplePref("pastePathInlineCode", v),
  setPasteTableSheetSuggest: (v) => setSimplePref("pasteTableSheetSuggest", v),
  setEditorMdAutoformat: (v) => setSimplePref("editorMdAutoformat", v),
  // 실험적(2026-09-20, "4~7번도 넣어봐") — 넷 다 단순 simplePrefs. newNoteSectionName 만 저장
  // 전에 trim + 40자 클램프를 한다(입력창의 로컬 draft state 는 EditorSection.tsx 가 들고
  // 있다가 blur/Enter 에서 이 setter 를 부른다 — 여기서도 한 번 더 클램프해 호출부가 실수로
  // 안 자른 값을 보내도 안전하다).
  setLinkOpenOnClick: (v) => setSimplePref("linkOpenOnClick", v),
  setEditorWidth: (v) => setSimplePref("editorWidth", v),
  setEditorWordCount: (v) => setSimplePref("editorWordCount", v),
  setNewNoteDatePrecision: (v) => setSimplePref("newNoteDatePrecision", v),
  setNewNoteSectionName: (v) => setSimplePref("newNoteSectionName", v.trim().slice(0, 40)),
  setPhotoMetaMode: (v) => setSimplePref("photoMetaMode", v),
  setVoiceTranscribeMode: (v) => setSimplePref("voiceTranscribeMode", v),
  setVoiceCleanupMode: (v) => setSimplePref("voiceCleanupMode", v),
  setBriefingEnabled: (v) => setSimplePref("briefingEnabled", v),
  setBriefingWhen: (v) => setSimplePref("briefingWhen", v),
  setBriefingTime: (v) => setSimplePref("briefingTime", v),
  setBriefingLastShown: (v) => setSimplePref("briefingLastShown", v),
  setBriefingEveningEnabled: (v) => setSimplePref("briefingEveningEnabled", v),
  setBriefingEveningTime: (v) => setSimplePref("briefingEveningTime", v),
  setBriefingLastShownEvening: (v) => setSimplePref("briefingLastShownEvening", v),
  setBriefingNotify: (v) => setSimplePref("briefingNotify", v),
  setBriefingLastSeen: (v) => setSimplePref("briefingLastSeen", v),
  setFavoritesOpen: (v) => setSimplePref("favoritesOpen", v),
  setBackupNudgePending: (v) => setSimplePref("backupNudgePending", v),
  // 오너 결정(2026-09-20) — 3단 UI 콤보 setter. setRegionEnabled(아래, "0"/"1" 문자열 키)와 같은
  // 낙관적 set() + call() + 실패 시 롤백 형태(함정 9)이되, 필드가 둘이라 **함께** 롤백한다.
  // "off"로 갈 때는 date_nudge_auto/region_nudge_strict 를 entries 에 **아예 넣지 않는다** —
  // 그래야 다시 켰을 때(suggest/auto, strict/loose) 이전 선택이 DB 에 그대로 남아 돌아온다.
  // 한 번의 settings_set 호출로 끝난다 — 두 번 쏘면 두 번째가 실패했을 때 절반만 적용된 쌍이
  // 남고 "settings-changed" 이벤트도 두 번 나간다.
  setDateNudgeMode: async (mode) => {
    const prevEnabled = get().dateNudgeEnabled;
    const prevAuto = get().dateNudgeAuto;
    const enabled = mode !== "off";
    const auto = mode === "auto";
    set({ dateNudgeEnabled: enabled, ...(mode === "off" ? {} : { dateNudgeAuto: auto }) });
    try {
      if (mode === "off") {
        await call("settings_set", { entries: { date_nudge_enabled: false } });
      } else {
        await call("settings_set", { entries: { date_nudge_enabled: true, date_nudge_auto: auto } });
      }
    } catch {
      set({ dateNudgeEnabled: prevEnabled, dateNudgeAuto: prevAuto });
    }
  },
  // setDateNudgeMode 와 같은 규약 — regionNudgeEnabled/regionNudgeStrict 쌍.
  setRegionNudgeMode: async (mode) => {
    const prevEnabled = get().regionNudgeEnabled;
    const prevStrict = get().regionNudgeStrict;
    const enabled = mode !== "off";
    const strict = mode === "strict";
    set({ regionNudgeEnabled: enabled, ...(mode === "off" ? {} : { regionNudgeStrict: strict }) });
    try {
      if (mode === "off") {
        await call("settings_set", { entries: { region_nudge_enabled: false } });
      } else {
        await call("settings_set", { entries: { region_nudge_enabled: true, region_nudge_strict: strict } });
      }
    } catch {
      set({ regionNudgeEnabled: prevEnabled, regionNudgeStrict: prevStrict });
    }
  },
  setOnboardingCompleted: (v) => setSimplePref("onboardingCompleted", v),
  setSourceOriginalPolicy: (v) => setSimplePref("sourceOriginalPolicy", v),
  setUiLang: async (v) => {
    // load() 와 같은 순서 — 사전 먼저, 그다음 uiLang(i18n/locales.ts 헤더).
    if (!getDict(v)) {
      try {
        await ensureLocale(v);
      } catch (e) {
        reportFallback("i18n", "locale_load_failed", String(e));
      }
    }
    rememberLocaleHint(v);
    await setSimplePref("uiLang", v);
  },
  setUpdateCheckAuto: (v) => setSimplePref("updateCheckAuto", v),
  // Wave (theme customisation) — 백엔드 allowlist(validate_setting)에 등록 완료, 영속된다.
  // 위 setAccent 그룹 주석의 규칙 그대로: 슬라이더라 fire-and-forget + callSilent + .catch.
  setBgTone: (v, opts) => {
    const n = clamp(v, BG_TONE_MIN, BG_TONE_MAX);
    set({ bgTone: n });
    repaint();
    // bg_dim 과 같은 이유로 재적용 불필요 — 위 setBgDim 주석 참고.
    saveBgSlider({ bg_tone: n }, opts?.live);
  },
  // PLAN-2026-09-12 §3/E3 — 배경 채도. 형태는 위 setAccent 과 **같은 live/commit 분리**다:
  // 드래그 틱은 CSS 만 다시 칠하고 조용히 저장하고(토스트도 롤백도 해가 된다), 손을 뗀 확정
  // 한 번이 토스트 + 롤백 + **OS 아크릴 재틴트**를 맡는다.
  //
  // 왜 OS 호출을 확정에만 두나: 2026-07-24 에 bg_tone/bg_dim 미러링을 걷어낸 이유가 슬라이더
  // 틱마다 OS 재합성이 일어나 flicker/lag 가 났기 때문이다(lib/appearance.ts::ACRYLIC_TINT_FIXED
  // 주석). 색은 드래그당 1회면 충분하므로 그 사고를 되풀이하지 않는다.
  setBgSat: async (v, opts) => {
    const prev = get().bgSat;
    const n = clamp(Math.round(v), BG_SAT_MIN, BG_SAT_MAX);
    const paint = (x: number) => {
      set({ bgSat: x });
      repaint();
    };
    paint(n);
    if (opts?.live) {
      await callSilent("settings_set", { entries: { bg_sat: n } }).catch(() => {});
      return;
    }
    // 확정 — 아크릴이 걸려 있으면 OS 틴트도 새 채도로 한 번 다시 보낸다(flat 은 보낼 게 없다).
    const style = get().surfaceStyle;
    if (style !== "flat") {
      const applied = await syncWindowEffect(style, get().theme, n);
      set({ surfaceEffectApplied: applied });
      applyCssVars(get());
      saveAppearanceSeed(get());
    }
    try {
      await call("settings_set", { entries: { bg_sat: n } });
    } catch {
      // call() 이 이미 토스트를 띄웠다 — 화면이 거짓말하지 않게 되돌리기만 한다(함정 9).
      paint(prev);
    }
  },
  // PLAN-2026-09-12 §5 — 본문 전용 틴트. 전역 bg_tone 과 **같은 부류의 설정**이라 같은 형태로
  // 쓴다: 슬라이더 드래그 중 매 틱 호출되므로 fire-and-forget 이고(토스트가 틱마다 뜨면 안 되니
  // callSilent), 실효값 계산은 applyCssVars 한 곳에만 있다.
  // 백엔드는 as_i64() 로 검증하므로 **반드시 정수**여야 한다 — 소수를 보내면 통째로 거절된다
  // (setLeftWidth/setSourcePct 가 같은 이유로 반올림한다).
  setContentTint: (v) => {
    const n = clamp(Math.round(v), CONTENT_TINT_MIN, CONTENT_TINT_MAX);
    set({ contentTint: n });
    applyCssVars(get());
    void callSilent("settings_set", { entries: { content_tint: n } }).catch(() => {});
  },
  // 실제 창 효과를 라이브로 바꾼다(재시작 불필요). OS 호출 결과를 기다린 뒤에야 data-surface 를
  // 확정한다 — 낙관적으로 먼저 켜면 미지원 OS 에서 아크릴 없이 .app 캔버스만 투명해지는 순간
  // (punch-through)이 생긴다. flat 으로 갈 때도 반드시 부른다(이전 아크릴을 실제로 지워야 한다).
  // 클릭 한 번이라 저장 실패는 토스트 + 롤백이고, 롤백도 같은 경로로 **OS 효과까지** 되돌린다.
  setSurfaceStyle: async (v) => {
    // 선택 차단(PLAN-2026-09-19 §4)의 스토어 쪽 관문 — 화면의 칸 잠금은 부팅 질의가 돌아온 뒤에야
    // 걸리므로, 그 전에 눌려도 못 거는 재질이 저장되지 않게 여기서 한 번 더 막는다.
    if (v === "acrylic" && !get().acrylicSupported) return;
    const prev = get().surfaceStyle;
    const seq = nextClickSeq("surface");
    const paint = async (style: SurfaceStyle) => {
      const applied = await syncWindowEffect(style, get().theme, get().bgSat);
      set({ surfaceStyle: style, surfaceEffectApplied: applied });
      repaint();
    };
    await paint(v);
    try {
      await call("settings_set", { entries: { surface_style: v } });
    } catch {
      if (isLatestClick("surface", seq)) await paint(prev);
    }
  },
  // acrylic 표면 불투명도 — float(step 0.01)라 백엔드는 as_f64() 로 검증한다(sheet_alpha).
  setSheetAlpha: (v) => {
    const n = clamp(v, SHEET_ALPHA_MIN, SHEET_ALPHA_MAX);
    set({ sheetAlpha: n });
    repaint();
    void callSilent("settings_set", { entries: { sheet_alpha: n } }).catch(() => {});
  },
  addRecentColorHue: async (hue) => {
    const h = Math.round(hue);
    if (h < 0 || h > 359) return;
    const current = get().recentColorHues;
    const next = [h, ...current.filter((x) => x !== h)].slice(0, 6);
    set({ recentColorHues: next });
    await call("settings_set", { entries: { recent_color_hues: next } });
  },
  addEmojiRecent: async (key) => {
    const next = addRecentEmoji(get().emojiRecent, key);
    set({ emojiRecent: next });
    await call("settings_set", { entries: { emoji_recent: next } });
  },
  toggleEmojiFavorite: async (key) => {
    const current = get().emojiFavorites;
    const next = current.includes(key) ? current.filter((k) => k !== key) : [key, ...current];
    set({ emojiFavorites: next });
    await call("settings_set", { entries: { emoji_favorites: next } });
  },
  setDefaultMapLocation: async (loc) => {
    const prev = { loc: get().defaultMapLocation, customized: get().defaultMapLocationCustomized };
    const seq = nextClickSeq("mapLocation");
    set({ defaultMapLocation: loc, defaultMapLocationCustomized: true });
    try {
      await call("settings_set", { entries: { default_map_location: loc } });
      return true;
    } catch {
      if (isLatestClick("mapLocation", seq)) {
        set({ defaultMapLocation: prev.loc, defaultMapLocationCustomized: prev.customized });
      }
      return false;
    }
  },
  // setSimplePref 는 상태값을 **그대로** 저장하는데 이 키는 "0"/"1" 문자열이라 직접 쓴다.
  // 낙관적 갱신 + 실패 롤백(CLAUDE.md 함정 9): call() 이 토스트를 띄운 뒤 다시 throw 하므로
  // 여기서 붙잡아 화면을 되돌린다(안 되돌리면 UI 가 저장된 척한다).
  setRegionEnabled: async (v) => {
    const prev = get().regionEnabled;
    set({ regionEnabled: v });
    try {
      await call("settings_set", { entries: { region_enabled: v ? "1" : "0" } });
    } catch {
      set({ regionEnabled: prev });
    }
  },
  setFilterRoster: (entries) => setSimplePref("filterRoster", ensureOneEnabled(entries)),
  setDashboardTabs: (entries) => setSimplePref("dashboardTabs", ensureOneEnabled(entries)),
  setPhrasePackId: async (id) => {
    const next = typeof id === "string" && id.length > 0 ? id : PHRASE_PACK_OFF;
    set({ phrasePackId: next });
    await call("settings_set", { entries: { phrase_pack_id: next } });
  },
  setEditorFullWidth: (v) => setSimplePref("editorFullWidth", v),
  setSpellcheckEnabled: (v) => setSimplePref("spellcheckEnabled", v),
  setWeekStart: (v) => setSimplePref("weekStart", v),
  setHolidayRegion: (v) => setSimplePref("holidayRegion", v),
  setCloseToTray: (v) => setSimplePref("closeToTray", v),
  setNotificationsEnabled: (v) => setSimplePref("notificationsEnabled", v),
  setReminderAllDayAt: (v) => setSimplePref("reminderAllDayAt", v),
  setUserName: (v) => setSimplePref("userName", v),
  setFontFamily: async (v) => {
    const prev = get().fontFamily;
    const seq = nextClickSeq("fontFamily");
    const paint = (f: string) => {
      set({ fontFamily: f });
      repaint();
    };
    paint(v);
    try {
      await call("settings_set", { entries: { font_family: v } });
    } catch {
      if (isLatestClick("fontFamily", seq)) paint(prev);
    }
  },
  setPetDblclickAction: (v) => setSimplePref("petDblclickAction", v),
  setChatMemory: (v) => setSimplePref("chatMemory", v),
  addChatMemory: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const current = get().chatMemory;
    if (current.length >= CHAT_MEMORY_MAX_ITEMS) return false;
    if (current.some((m) => m.text === trimmed)) return false;
    const nextItem: ChatMemoryItem = {
      id: uniqueId("mem"),
      text: trimmed.slice(0, CHAT_MEMORY_MAX_LENGTH),
      created_at: new Date().toISOString(),
    };
    await setSimplePref("chatMemory", [nextItem, ...current]);
    return get().chatMemory.some((m) => m.id === nextItem.id);
  },
  removeChatMemory: async (id: string) => {
    const current = get().chatMemory;
    await setSimplePref("chatMemory", current.filter((m) => m.id !== id));
  },
  setAttachmentStorageMode: (v) => setSimplePref("attachmentStorageMode", v),
  setSlidePreview: (v) => setSimplePref("slidePreview", v),
  setSofficePath: (v) => setSimplePref("sofficePath", v),
  setCollectExcludedDomains: async (v) => {
    const domains = v.filter((d) => d.trim().length > 0).slice(0, 200);
    await setSimplePref("collectExcludedDomains", domains);
    if (get().collectExcludedDomains !== domains) return;
    // 구 capture_visit_excluded_domains 키에도 같은 값을 적어 visits 채널(서버 측 read)이
    // 새 키 부재 환경에서도 폴백으로 잡을 수 있게 한다. 두 키의 의미가 같고 같은 형식 검증
    // 통과. setSimplePref 가 성공한 뒤에야 두 번째 쓰기 — 첫 호출 실패 시 옛 키는 그대로
    // 남아 있어 다음 load() 폴백이 동작한다.
    await callSilent("settings_set", {
      entries: { capture_visit_excluded_domains: domains },
    }).catch(() => {});
  },
  setLinkSuggestionsModel: (v) => setSimplePref("linkSuggestionsModel", v.trim()),
  setSeenFeatureBriefs: (v) => setSimplePref("seenFeatureBriefs", v),
  setCollectPausedUntil: (v) => setSimplePref("collectPausedUntil", v.trim()),
  setCollectChatRegister: (v) => setSimplePref("collectChatRegister", v),
  setStatusAddLocked: (v) => setSimplePref("statusAddLocked", v),
  setCollectDetectPending: (v) => setSimplePref("collectDetectPending", v),
  setCollectDetectSeen: (v) => setSimplePref("collectDetectSeen", v),
  };
});

