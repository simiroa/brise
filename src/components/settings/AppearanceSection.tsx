import { anchorId } from "./settingsAnchor";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  useSettingsStore,
  type ThemePref,
  type SurfaceStyle,
} from "../../stores/settings";
import {
  BG_SAT_MIN,
  BG_SAT_MAX,
  BG_TONE_MAX,
  CONTENT_TINT_MIN,
  CONTENT_TINT_MAX,
  DEFAULT_APPEARANCE_SEED,
  SHEET_ALPHA_MIN,
  SHEET_ALPHA_MAX,
} from "../../lib/appearance";
import {
  ACCENT_CHROMA_STEPS,
  ACCENT_NEUTRAL_STEP,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_HUE,
  accentHex,
  accentHueOf,
  accentPalette,
  accentStepOf,
} from "../../lib/accentPalette";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { groupCardStyle, SETTINGS_CTRL_WIDTH } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { SubGroup } from "./SubGroup";
import { Select } from "../Select";
import { SegGroup } from "./SegGroup";
import { Badge } from "./Badge";
import { AppearancePreview } from "./AppearancePreview";
import { IconFileExport, IconFileImport, IconFmtText, IconPalette, IconRefresh, IconUndo } from "../icons";
import { IconAction } from "./IconAction";
import {
  exportThemeToPicker,
  importThemeFromPicker,
  resetAppearance,
  restoreAppearance,
} from "../../lib/themeTransfer";

const FONT_CUSTOM = "__custom__";
// lib/appearance.ts::applyAppearance 의 stack 과 같은 값이어야 한다(여기는 드롭다운 미리보기용).
const FONT_STACK: Record<string, string> = {
  pretendard: '"Pretendard", "Source Sans 3", system-ui, sans-serif',
  serif: '"Source Serif 4", "Noto Serif KR", serif',
  sans: '"Source Sans 3", "Noto Sans KR", system-ui, sans-serif',
};
/** Bundled 3 + Windows-Korean representative system fonts. Uninstalled names fall back honestly.
 *  "Pretendard" 시스템 글꼴 항목은 2026-09-09 에 번들 "pretendard" 로 승격됐다 — 설치돼 있어야
 *  보이던 것이 이제 앱이 들고 다니는 기본값이라, 같은 이름의 시스템 항목은 중복이라 뺐다. */
const CURATED_FONTS: Array<{ value: string; labelKey: string }> = [
  { value: "pretendard", labelKey: "settings.font_pretendard" },
  { value: "serif", labelKey: "settings.font_serif" },
  { value: "sans", labelKey: "settings.font_sans" },
  { value: "Malgun Gothic", labelKey: "settings.font_malgun" },
  { value: "Gulim", labelKey: "settings.font_gulim" },
  { value: "Batang", labelKey: "settings.font_batang" },
  { value: "NanumGothic", labelKey: "settings.font_nanum" },
  { value: "Segoe UI", labelKey: "settings.font_segoe" },
];
const CURATED_VALUES = CURATED_FONTS.map((f) => f.value);
function isCuratedFont(value: string): boolean {
  return CURATED_VALUES.includes(value);
}
/** 직접 입력 칸을 비웠을 때 돌아갈 곳 — 앱 기본 글꼴(첫 페인트 시드와 같은 값). */
const DEFAULT_FONT_FAMILY = DEFAULT_APPEARANCE_SEED.fontFamily;
/** 배경 밝기 슬라이더 음수 끝(-100%)이 싣는 bg_dim 값 — Rust settings_schema.rs 의 bg_dim arm
 *  상한(0..=40)과 같아야 한다(넘기면 저장이 거부된다). */
const BG_DIM_MAX = 40;

function fontStack(value: string): string {
  return FONT_STACK[value] ?? `"${value}", "Pretendard", system-ui, sans-serif`;
}

function SliderRow({
  label,
  hint,
  display,
  min,
  max,
  step,
  value,
  onChange,
  onCommit,
  ariaLabel,
  testid,
  anchor,
}: {
  label: string;
  /** 설정 검색 앵커 이름 — SettingsRow 로 넘긴다. */
  anchor?: string;
  /** 한 줄. 두 줄짜리는 여기 넣지 않는다(DESIGN.md 규칙 ③) */
  hint?: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  /** 드래그가 **끝난** 순간 한 번(강조색 hue 슬라이더와 같은 형태). 틱마다 하면 안 되는 일
   *  — 지금은 OS 아크릴 재틴트 — 을 여기에 건다. 없으면 onChange 만 있는 평범한 슬라이더다. */
  onCommit?: () => void;
  ariaLabel: string;
  testid?: string;
}) {
  return (
    <SettingsRow
      anchor={anchor}
      hint={hint}
      label={
        <>
          {label}{" "}
          <span style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>{display}</span>
        </>
      }
      control={
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          onBlur={onCommit}
          style={{ width: SETTINGS_CTRL_WIDTH, accentColor: "var(--accent)" }}
          aria-label={ariaLabel}
          data-testid={testid}
        />
      }
    />
  );
}

const SURFACE_STYLES: SurfaceStyle[] = ["flat", "acrylic"];

/** 채도 사다리 5칸의 라벨 키 — `ACCENT_CHROMA_STEPS` 와 **같은 순서**다.
 *  `t(`...${i}`)` 로 조립하지 않고 키를 통째로 적어 둔 이유: check:i18n 의 미사용 키 검사는
 *  소스에 따옴표째 박힌 문자열을 찾는다 — 조립한 키는 쓰이고 있는데도 "미사용"으로 잡힌다
 *  (예외를 만들려면 scripts/i18n-dynamic-prefixes.json 을 건드려야 하는데, 다섯 칸뿐이라
 *  그럴 값어치가 없다). */
const CHROMA_LABEL_KEYS = [
  "settings.accent_chroma_neutral",
  "settings.accent_chroma_soft",
  "settings.accent_chroma_medium",
  "settings.accent_chroma_vivid",
  "settings.accent_chroma_intense",
];

export function AppearanceSection() {
  const browser = isBrowser();
  const themePref = useSettingsStore((s) => s.themePref);
  const fontScale = useSettingsStore((s) => s.fontScale);
  const bgDim = useSettingsStore((s) => s.bgDim);
  const bgTone = useSettingsStore((s) => s.bgTone);
  const bgSat = useSettingsStore((s) => s.bgSat);
  const contentTint = useSettingsStore((s) => s.contentTint);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const surfaceStyle = useSettingsStore((s) => s.surfaceStyle);
  // F5(PLAN-2026-09-15): window_set_effect 가 실제로 적용됐는지 — Win10 등에서 flat 으로 폴백해도
  // 선택 상태는 "아크릴" 로 남는다. 화면이 그 사실을 말하고 불투명도 슬라이더는 잠근다.
  const surfaceEffectApplied = useSettingsStore((s) => s.surfaceEffectApplied);
  const surfaceUnsupported = surfaceStyle !== "flat" && !surfaceEffectApplied;
  // PLAN-2026-09-19 §4-2: 이 기기(Windows 빌드 22523 미만 — Windows 10 포함)에선 아크릴 칸을 잠근다.
  const acrylicSupported = useSettingsStore((s) => s.acrylicSupported);

  // PLAN-2026-09-19 §5: 초기화·불러오기 직후의 **되돌리기** — 직전 모양 스냅샷을 화면이 들고
  // 있다가 같은 적용 경로로 되돌린다. 페이지를 떠나면 사라진다(확인 모달 대신).
  const [undoSnapshot, setUndoSnapshot] = useState<Record<string, unknown> | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const runTransfer = async (job: () => Promise<Record<string, unknown> | null>) => {
    if (transferBusy) return;
    setTransferBusy(true);
    try {
      const prev = await job();
      if (prev) setUndoSnapshot(prev);
    } finally {
      setTransferBusy(false);
    }
  };
  const undo = async () => {
    if (!undoSnapshot || transferBusy) return;
    setTransferBusy(true);
    try {
      if (await restoreAppearance(undoSnapshot)) setUndoSnapshot(null);
    } finally {
      setTransferBusy(false);
    }
  };

  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFontScale = useSettingsStore((s) => s.setFontScale);
  const setBgDim = useSettingsStore((s) => s.setBgDim);
  const setBgTone = useSettingsStore((s) => s.setBgTone);
  const setBgSat = useSettingsStore((s) => s.setBgSat);
  const setContentTint = useSettingsStore((s) => s.setContentTint);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setSurfaceStyle = useSettingsStore((s) => s.setSurfaceStyle);

  // W11 (결정 5): 단일 "배경 밝기" 슬라이더 (-100 ~ +100). 양수는 bg_tone(밝게), 음수는 bg_tone
  // 반대쪽 + bg_dim(어둡게)으로 나눠 싣는다. 로드 시 가장 가까운 축 위 값으로 표시하되, 사용자가
  // 슬라이더를 건드리기 전까지 저장값을 덮어쓰지 않는다.
  // 드래그 틱은 조용히 저장하고(live — 본 창이 실시간으로 따라온다), 손을 뗄 때(onCommit) 두 값을 한 번씩
  // 확정한다(실패하면 토스트) — 배경 채도와 같은 형태.
  const brightness =
    bgDim > 0 ? -Math.round((bgDim / BG_DIM_MAX) * 100) : Math.round((bgTone / BG_TONE_MAX) * 100);

  const brightnessDirty = useRef(false);
  const handleBrightnessChange = (val: number) => {
    brightnessDirty.current = true;
    const live = { live: true };
    if (val >= 0) {
      setBgTone(Math.round((val / 100) * BG_TONE_MAX), live);
      setBgDim(0, live);
    } else {
      const negRatio = -val / 100;
      setBgTone(-Math.round(negRatio * BG_TONE_MAX), live);
      setBgDim(Math.round(negRatio * BG_DIM_MAX), live);
    }
  };
  // 손을 뗀 확정 — onCommit 은 pointerup·keyup·blur 셋에 걸려 있어 한 번 끄고 포커스를 옮기면 두 번
  // 온다. 틱이 하나라도 있었을 때만 확정한다(그냥 Tab 으로 지나가는 blur 도 확정하지 않는다).
  const commitBrightness = () => {
    if (!brightnessDirty.current) return;
    brightnessDirty.current = false;
    const { bgTone: tone, bgDim: dim } = useSettingsStore.getState();
    setBgTone(tone);
    setBgDim(dim);
  };

  // W11 / W23-d: 큐레이션 드롭다운 + 직접 입력. 스키마 키 font_family 불변.
  // 직접 입력 모드는 화면 상태지만 **저장값을 따라간다** — 초기화·불러오기·되돌리기·다른 창·저장
  // 실패 롤백으로 글꼴이 바깥에서 바뀌면 드롭다운과 입력 칸을 저장값에 다시 맞춘다. 드롭다운에서
  // "직접 입력"만 고르고 아직 확정하지 않은 상태는 저장값이 그대로라 이 effect 가 건드리지 않는다.
  const [customMode, setCustomMode] = useState(() => !isCuratedFont(fontFamily));
  const [customFontInput, setCustomFontInput] = useState(() => (isCuratedFont(fontFamily) ? "" : fontFamily));
  useEffect(() => {
    const custom = !isCuratedFont(fontFamily);
    setCustomMode(custom);
    setCustomFontInput(custom ? fontFamily : "");
  }, [fontFamily]);
  const selectValue = customMode ? FONT_CUSTOM : fontFamily;

  // 확정(blur/Enter) 한 번 — 타이핑마다 부르지 않는다(setFontFamily 는 call() 이라 실패하면 글자마다
  // 토스트가 뜬다). 바뀐 게 없으면 저장하지 않는다. 비우면 직접 입력 모드를 닫는데, 저장된 글꼴이
  // **직접 입력한 이름**이었을 때만 앱 기본 글꼴로 되돌린다 — 큐레이션 글꼴에서 "직접 입력"을 열었다가
  // 빈 칸으로 나가는 것은 아무것도 바꾸지 않는다.
  const commitCustomFont = () => {
    const typed = customFontInput.trim();
    if (!typed) {
      setCustomMode(false);
      setCustomFontInput("");
      if (!isCuratedFont(fontFamily)) void setFontFamily(DEFAULT_FONT_FAMILY);
      return;
    }
    if (typed !== fontFamily) void setFontFamily(typed);
  };

  return (
    <>
      {/* 1. 테마·재질 + 강조색 — 한 카드(같은 관심사인 색·재질, 오너 R2 2026-09-15). 카드 머리는 다른
          카드와 같은 아이콘 달린 SectionHeader 이고, 강조색은 그 아래 구분선 있는 SubGroup 이다. */}
      <div className="card" style={groupCardStyle} id={anchorId("appearance_theme")} data-testid="settings-appearance-theme">
        {/* 되돌리기·내보내기·불러오기·초기화는 첫 카드 제목 줄로(PLAN-2026-10-24 D4). 브라우저 탭엔 없다. */}
        <SectionHeader
          title={t("settings.appearance_group_theme")}
          icon={<IconPalette size={14} strokeWidth={2} />}
          actions={
            browser ? undefined : (
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                {undoSnapshot && (
                  <IconAction
                    icon={<IconUndo size={16} />}
                    label={t("settings.theme_undo")}
                    data-testid="appearance-undo"
                    disabled={transferBusy}
                    onClick={() => void undo()}
                  />
                )}
                <IconAction
                  icon={<IconFileImport size={16} />}
                  label={t("settings.theme_import")}
                  id={anchorId("theme_import")}
                  data-testid="appearance-import"
                  disabled={transferBusy}
                  onClick={() => void runTransfer(importThemeFromPicker)}
                />
                <IconAction
                  icon={<IconFileExport size={16} />}
                  label={t("settings.theme_export")}
                  id={anchorId("theme_export")}
                  data-testid="appearance-export"
                  disabled={transferBusy}
                  onClick={() => void exportThemeToPicker()}
                />
                {/* 되돌리기가 있으므로 danger 아님(PLAN-2026-09-19-settings-icon-actions §2). 설명 힌트는
                    툴팁에 이름 뒤로 붙여 잃지 않는다 — 접근 이름은 여전히 label 하나. */}
                <IconAction
                  icon={<IconRefresh size={16} />}
                  label={t("settings.theme_reset")}
                  titleOverride={`${t("settings.theme_reset")} — ${t("settings.theme_reset_hint")}`}
                  id={anchorId("theme_reset")}
                  data-testid="appearance-reset"
                  disabled={transferBusy}
                  onClick={() => void runTransfer(resetAppearance)}
                />
              </div>
            )
          }
        />
        <SettingsRow
          anchor="theme"
          label={t("settings.theme")}
          control={
            <SegGroup
              value={themePref}
              onChange={(v) => void setTheme(v)}
              ariaLabel={t("settings.theme")}
              options={[
                { value: "system" as ThemePref, label: t("settings.theme_system") },
                { value: "dark" as ThemePref, label: t("settings.dark") },
                { value: "light" as ThemePref, label: t("settings.light") },
              ]}
            />
          }
        />

        {/* 아크릴은 네이티브 창 재질(Windows 11 전용 — window_set_effect)이다. 브라우저 탭에는 native
            window 가 없어 골라도 적용되지 않으므로 통째로 가린다. "플랫"은 CSS 뿐이라 이 행 없이도
            기존 저장값으로 정상 렌더된다. */}
        {!browser && (
          <SettingsRow
            anchor="surface_style"
            label={t("settings.surface_style")}
            control={
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <SegGroup
                  value={surfaceStyle}
                  onChange={(v) => void setSurfaceStyle(v)}
                  ariaLabel={t("settings.surface_style")}
                  options={SURFACE_STYLES.map((style) => {
                    const locked = style === "acrylic" && !acrylicSupported;
                    return {
                      value: style,
                      label: t(`settings.surface_${style}`),
                      disabled: locked,
                      title: locked ? t("settings.surface_acrylic_unsupported") : undefined,
                    };
                  })}
                />
                {surfaceUnsupported && (
                  <span data-testid="settings-surface-unsupported">
                    <Badge tone="neutral">{t("settings.surface_effect_unsupported")}</Badge>
                  </span>
                )}
              </div>
            }
          />
        )}

        {!browser && surfaceStyle === "acrylic" && <AcrylicParams disabled={surfaceUnsupported} />}

        <SubGroup title={t("settings.appearance_group_accent")} divider data-testid="settings-appearance-accent">
          <AccentRow />
        </SubGroup>
      </div>

      {/* 2. 글꼴·배경 — 글꼴 Select(+직접 입력), 슬라이더 4개, 미리보기 */}
      <div className="card" style={groupCardStyle} id={anchorId("appearance_font")} data-testid="settings-appearance-font">
        <SectionHeader title={t("settings.appearance_group_font")} icon={<IconFmtText size={14} strokeWidth={2} />} />
        <SettingsRow
          anchor="font_family"
          label={t("settings.font_family")}
          control={
            <Select
              testid="settings-font-family"
              value={selectValue}
              ariaLabel={t("settings.font_family")}
              onChange={(mode) => {
                if (mode === FONT_CUSTOM) {
                  setCustomMode(true);
                  return;
                }
                setCustomMode(false);
                if (mode !== fontFamily) void setFontFamily(mode);
              }}
              options={[
                ...CURATED_FONTS.map((f) => ({
                  value: f.value,
                  label: t(f.labelKey),
                  style: { fontFamily: fontStack(f.value) },
                })),
                { value: FONT_CUSTOM, label: t("settings.font_custom") },
              ]}
              style={{ width: SETTINGS_CTRL_WIDTH, minWidth: SETTINGS_CTRL_WIDTH }}
            />
          }
        />

        {customMode && (
          <input
            className="field"
            type="text"
            value={customFontInput}
            placeholder={t("settings.font_custom_placeholder")}
            aria-label={t("settings.font_custom")}
            maxLength={64}
            onChange={(e) => setCustomFontInput(e.target.value)}
            onBlur={commitCustomFont}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            style={{ width: "100%", marginBottom: "var(--space-2)" }}
            data-testid="settings-font-custom-input"
          />
        )}

        <SliderRow
          anchor="font_scale"
          label={t("settings.font_scale")}
          display={`${Math.round(fontScale * 100)}%`}
          min={0.85}
          max={1.35}
          step={0.05}
          value={fontScale}
          onChange={(v) => void setFontScale(v)}
          ariaLabel={t("settings.font_scale")}
        />

        <SliderRow
          anchor="bg_brightness"
          label={t("settings.bg_brightness")}
          display={brightness > 0 ? `+${brightness}%` : `${brightness}%`}
          min={-100}
          max={100}
          step={1}
          value={brightness}
          onChange={(v) => handleBrightnessChange(Math.round(v))}
          onCommit={commitBrightness}
          ariaLabel={t("settings.bg_brightness")}
        />

        {/* PLAN-2026-09-12 §3/E3: 배경 **채도**. 바로 위 밝기와 같은 전역 축이라 붙여 둔다 —
            밝기는 흰/검정 쪽, 이건 테마색 쪽이고 밝기는 건드리지 않는다.
            드래그 중엔 CSS 만 칠하고, 손을 뗀 뒤(onCommit)에야 OS 아크릴 틴트를 한 번 다시 보낸다
            (틱마다 보내면 2026-07-24 의 flicker 재발). */}
        <SliderRow
          anchor="bg_saturation"
          label={t("settings.bg_saturation")}
          hint={t("settings.bg_saturation_hint")}
          display={`${bgSat}%`}
          min={BG_SAT_MIN}
          max={BG_SAT_MAX}
          step={1}
          value={bgSat}
          onChange={(v) => void setBgSat(Math.round(v), { live: true })}
          onCommit={() => void setBgSat(useSettingsStore.getState().bgSat)}
          ariaLabel={t("settings.bg_saturation")}
          testid="settings-bg-sat"
        />

        {/* PLAN-2026-09-12 §5 (D6): 바로 위 "배경 밝기"는 사이드바를 포함한 **전역**이고, 이건
            본문 영역만 움직인다. 그래서 순서가 중요하다 — 넓은 것 아래에 좁은 것이 온다.
            사이드바 전용 슬라이더는 만들지 않는다(전역이 그 역할이다, 오너 결정 D6). */}
        <SliderRow
          anchor="content_tint"
          label={t("settings.content_tint")}
          hint={t("settings.content_tint_hint")}
          display={contentTint > 0 ? `+${contentTint}` : `${contentTint}`}
          min={CONTENT_TINT_MIN}
          max={CONTENT_TINT_MAX}
          step={1}
          value={contentTint}
          onChange={(v) => setContentTint(Math.round(v))}
          ariaLabel={t("settings.content_tint")}
          testid="settings-content-tint"
        />

        <AppearancePreview />
      </div>
    </>
  );
}

/**
 * 강조색 한 줄 — `[◐ hue] [무채] [옅음] [중간] [선명] [강렬] [↺]` (PLAN-2026-09-12 §4 / D4).
 *
 * 축이 셋인데 손잡이는 둘이다: **H 는 슬라이더, C 는 5칩, L 은 테마가 정한다**(왜 L 을 열지
 * 않는지는 lib/accentPalette.ts 상단). 저장 값은 여전히 hex 하나뿐이라 "몇 번째 칩이었는지"는
 * 채도로 되짚는다(`accentStepOf`) — 화면과 저장 사이에 중간 상태를 만들지 않기 위해서다.
 *
 * 키보드: 5칩은 radiogroup 이라 탭 정지는 선택된 칩 하나뿐이고(roving tabindex), 화살표·Home·End 가
 * 선택을 옮긴다. hue 팝오버는 열리면 슬라이더로 포커스가 들어가고, Escape 로 닫으면 칩으로 돌아온다.
 */
/** bare: 온보딩처럼 바깥에서 라벨을 이미 달았을 때 — 라벨 없이 컨트롤 줄만 그린다(SettingsRow 를 건너뛴다). */
export function AccentRow({ bare = false }: { bare?: boolean } = {}) {
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const setAccent = useSettingsStore((s) => s.setAccent);

  // 채도는 저장 값에서 되짚고(칩 선택 표시), **색상각은 화면이 들고 있는다.**
  //
  // 왜 색상각만 상태인가: 저장 값이 hex 라 8비트 양자화를 거친다 — 낮은 채도에서 150° 로 만든
  // 색을 다시 읽으면 151° 가 나온다. 그 되읽은 값을 슬라이더에 되먹이면 손잡이가 손가락 밑에서
  // 1~2° 씩 미끄러지고, 무채(C=0)에서는 색상각이 아예 남지도 않는다(R=G=B). 그래서 사용자가
  // 고른 각을 여기서 들고, 저장 값은 그 결과로 둔다.
  // 바깥에서 바뀐 강조색은 아래 effect 가 따라간다.
  const [hue, setHue] = useState(() => accentHueOf(accent));
  const step = accentStepOf(accent);
  const neutral = step === ACCENT_NEUTRAL_STEP;

  // 강조색이 **이 줄 밖에서** 바뀌면(모양 초기화·불러오기·다른 창) 들고 있던 색상각이 저장값과
  // 어긋난다. 지금 색상각으로 다시 만든 색이 저장값과 다를 때만 저장값에서 되짚는다 — 이 줄이
  // 스스로 만든 변경은 같은 색이 나오므로 손잡이가 미끄러지지 않는다(위 양자화 문제). 무채는
  // 색상각이 남지 않으므로 건드리지 않는다.
  useEffect(() => {
    if (neutral) return;
    if (accentHex(hue, ACCENT_CHROMA_STEPS[step], theme) !== accent) setHue(accentHueOf(accent));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hue 는 일부러 뺀다: 드래그마다 돌면 안 된다
  }, [accent, theme]);

  const [hueOpen, setHueOpen] = useState(false);
  const hueWrapRef = useRef<HTMLDivElement | null>(null);
  const hueChipRef = useRef<HTMLButtonElement | null>(null);
  const hueSliderRef = useRef<HTMLInputElement | null>(null);
  const chipRefs = useRef<Array<HTMLDivElement | null>>([]);
  // 확정할 드래그가 있는가 — 슬라이더의 blur 는 팝오버를 닫거나 포커스만 옮겨도 불리므로, 실제로
  // 움직인 뒤에만 확정 저장(토스트·롤백 경로)을 한 번 탄다.
  const hueDirtyRef = useRef(false);

  // 바깥 클릭/Escape 로 닫는다. 열려 있을 때만 리스너를 단다 — 설정 창은 오래 떠 있는 화면이라
  // 닫힌 팝오버가 document 리스너를 계속 붙들고 있을 이유가 없다. 열리면 포커스를 슬라이더로
  // 옮기고, Escape 로 닫으면 여는 칩으로 돌려준다(키보드 사용자가 길을 잃지 않게).
  useEffect(() => {
    if (!hueOpen) return;
    hueSliderRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!hueWrapRef.current?.contains(e.target as Node)) setHueOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHueOpen(false);
        hueChipRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [hueOpen]);

  const palette = accentPalette(hue, theme);
  // 팝오버의 색상 띠 — 지금 고른 채도 그대로 한 바퀴 돌려 보인다. 무채(0)에서는 띠가 회색 한
  // 덩어리가 되어 아무것도 말하지 않으므로 사다리 가운데 채도로 그린다.
  const sweepChroma = ACCENT_CHROMA_STEPS[neutral ? 2 : step];
  const sweep = Array.from({ length: 13 }, (_, i) => accentHex(i * 30, sweepChroma, theme));

  const pickStep = (i: number) => {
    void setAccent(accentHex(hue, ACCENT_CHROMA_STEPS[i], theme));
  };

  // radiogroup 화살표 — 선택을 옮기고 포커스도 따라 옮긴다(끝에서 반대쪽 끝으로 감긴다).
  const onChipKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, i: number) => {
    const last = palette.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Enter" || e.key === " ") next = i;
    if (next === null) return;
    e.preventDefault();
    if (next !== step) pickStep(next);
    chipRefs.current[next]?.focus();
  };

  // 드래그 중(onChange, 틱마다)은 `live` — 조용히 칠하기만 한다. 손을 떼거나 키보드 조작이
  // 끝나는 순간(onPointerUp/onKeyUp/onBlur)에 옵션 없이 한 번 더 불러 **확정**한다. 그래야 저장
  // 실패가 토스트로 보이고 화면도 되돌아간다(스토어 setAccent 그룹 주석 참고).
  const pickHue = (h: number) => {
    setHue(h);
    // 무채에서는 슬라이더가 막혀 있어 여기 오지 않지만, 와도 저장 값은 바뀌지 않는 게 맞다.
    if (!neutral) {
      hueDirtyRef.current = true;
      void setAccent(accentHex(h, ACCENT_CHROMA_STEPS[step], theme), { live: true });
    }
  };

  const commitHue = () => {
    if (neutral || !hueDirtyRef.current) return;
    hueDirtyRef.current = false;
    void setAccent(accentHex(hue, ACCENT_CHROMA_STEPS[step], theme));
  };

  const reset = () => {
    setHue(DEFAULT_ACCENT_HUE);
    setHueOpen(false);
    hueDirtyRef.current = false;
    void setAccent(DEFAULT_ACCENT);
  };

  const control = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-5)",
        width: SETTINGS_CTRL_WIDTH,
        boxSizing: "border-box",
      }}
    >
      <div ref={hueWrapRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
        <button
          ref={hueChipRef}
          type="button"
          data-testid="accent-hue-chip"
          aria-haspopup="dialog"
          aria-expanded={hueOpen}
          // 무채색에서는 색상각이 결과에 영향을 주지 않는다 — 막고, 흐리게 해서 그 사실을
          // 말한다(설명 문장을 한 줄 더 얹는 대신).
          disabled={neutral}
          title={neutral ? t("settings.accent_hue_muted") : t("settings.accent_hue")}
          aria-label={t("settings.accent_hue")}
          onClick={() => setHueOpen((o) => !o)}
          style={{
            width: 24,
            height: 24,
            padding: 0,
            borderRadius: "50%",
            cursor: neutral ? "not-allowed" : "pointer",
            border: `2px solid ${hueOpen ? "var(--text)" : "transparent"}`,
            background: `conic-gradient(from 90deg, ${sweep.join(", ")})`,
            opacity: neutral ? "var(--dim-disabled)" : 1,
          }}
        />
        {hueOpen && (
          <div
            className="overlay"
            role="dialog"
            aria-label={t("settings.accent_hue")}
            data-testid="accent-hue-popover"
            style={{
              position: "absolute",
              top: "calc(100% + var(--space-2))",
              left: 0,
              zIndex: "var(--z-dropdown)",
              width: 200,
              padding: "var(--space-3)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                marginBottom: "var(--space-2)",
              }}
            >
              <span>{t("settings.accent_hue")}</span>
              <span>{`${Math.round(hue)}°`}</span>
            </div>
            <div
              aria-hidden
              style={{
                height: 8,
                borderRadius: "var(--radius-pill)",
                marginBottom: "var(--space-2)",
                background: `linear-gradient(to right, ${sweep.join(", ")})`,
              }}
            />
            <input
              ref={hueSliderRef}
              type="range"
              min={0}
              max={360}
              step={1}
              value={Math.round(hue)}
              onChange={(e) => pickHue(parseInt(e.target.value, 10))}
              onPointerUp={commitHue}
              onKeyUp={commitHue}
              onBlur={commitHue}
              aria-label={t("settings.accent_hue")}
              data-testid="accent-hue-slider"
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
          </div>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label={t("settings.accent_color")}
        style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}
      >
        {palette.map((hex, i) => (
          <div
            key={hex}
            ref={(el) => {
              chipRefs.current[i] = el;
            }}
            role="radio"
            aria-checked={i === step}
            tabIndex={i === step ? 0 : -1}
            data-testid={`accent-chip-${i}`}
            onClick={() => pickStep(i)}
            onKeyDown={(e) => onChipKeyDown(e, i)}
            title={t("settings.accent_swatch_label", { hex })}
            aria-label={t(CHROMA_LABEL_KEYS[i])}
            style={{
              width: 24,
              height: 24,
              cursor: "pointer",
              borderRadius: "var(--radius-sm)",
              border: `2px solid ${i === step ? "var(--text)" : "transparent"}`,
              background: hex,
            }}
          />
        ))}
      </div>

      <IconAction
        icon={<IconRefresh size={13} />}
        label={t("settings.accent_reset")}
        size="sm"
        data-testid="accent-reset"
        onClick={reset}
      />
    </div>
  );
  if (bare) return control;
  return <SettingsRow anchor="accent_color" label={t("settings.accent_color")} control={control} />;
}

function AcrylicParams({ disabled }: { disabled?: boolean }) {
  const sheetAlpha = useSettingsStore((s) => s.sheetAlpha);
  const setSheetAlpha = useSettingsStore((s) => s.setSheetAlpha);
  // 100% 면 시트가 뒤를 완전히 덮어 아크릴이 원리상 보이지 않는다 — 그때만 힌트를 갈아 끼운다.
  // 줄을 하나 더 얹지 않는 이유는 규칙 ③(행 힌트는 한 줄이 상한)이고, 정작 필요한 순간에만
  // 다른 말을 하는 쪽이 상시 두 줄보다 낫다.
  const opaque = sheetAlpha >= 0.99;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", padding: "var(--space-3) 0" }}>
      <SettingsRow
        label={
          <>
            {t("settings.sheet_opacity")}{" "}
            <span style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>{Math.round(sheetAlpha * 100)}%</span>
          </>
        }
        hint={opaque ? t("settings.sheet_opacity_opaque_hint") : t("settings.sheet_opacity_hint")}
        // F5: OS 효과가 적용되지 않았으면 이 슬라이더는 아무것도 바꾸지 못한다 — 작동하는 척하지 않는다.
        disabled={disabled}
        disabledReason={disabled ? t("settings.surface_effect_unsupported") : undefined}
        control={
          <input
            type="range"
            min={SHEET_ALPHA_MIN}
            max={SHEET_ALPHA_MAX}
            step={0.01}
            value={sheetAlpha}
            disabled={disabled}
            onChange={(e) => setSheetAlpha(parseFloat(e.target.value))}
            style={{ width: SETTINGS_CTRL_WIDTH, accentColor: "var(--accent)" }}
            aria-label={t("settings.sheet_opacity")}
            data-testid="settings-sheet-opacity"
          />
        }
      />
    </div>
  );
}
