import React from "react";
import { useSettingsStore } from "../../stores/settings";
import { useWorkspacesStore } from "../../stores/workspaces";
import { openExternalUrl } from "../../lib/urls";
import { isBrowser } from "../../lib/env";
import { callSilent } from "../../lib/invoke";
import { t } from "../../i18n/t";
import type { RegionSelection } from "./OnboardingRegionStep";
import { UI_LANG_LABELS } from "./OnboardingFirstScreen";
import {
  IconFile,
  IconFolder,
  IconCheckMark,
  IconMoon,
  IconSun,
  IconGlobe,
  IconMapPin,
  IconSparkles,
  IconLink,
  IconCaret,
  IconImage,
  IconSmile,
  IconHeart,
} from "../icons";

// TODO(owner): 후원 링크 — 비어 있으면 버튼이 숨는다
const SPONSOR_URL = "";

/**
 * 요약 화면 — 가운데 정렬 한 열: 축하 장면 · 제목 · 요약 띠(칩 한 줄) · 이런 기능도 · 인사말.
 * 테마·재질·강조색·언어·노트북 이름은 스토어에서 직접 읽고, 위저드 안에서만 아는 값은 props 로 받는다.
 */
export function OnboardingDoneScreen({
  confirmedRegion,
  aiAdopted,
  connectEnabled,
  pendingDataPath,
  currentDataRoot,
}: {
  /** 요약에 보이는 지역은 "확정해서 저장한" 것뿐 — 없으면 "설정 안 함". */
  confirmedRegion: RegionSelection | null;
  aiAdopted: { provider: string; model: string | null } | null;
  connectEnabled: boolean;
  /** 데이터 관리 쪽에서 골라 둔 새 저장 위치(있으면 현재 위치보다 우선 표시). */
  pendingDataPath: string | null;
  /** 지금 데이터 위치(root) — 아직 못 읽었으면 undefined. */
  currentDataRoot: string | undefined;
}) {
  const theme = useSettingsStore((s) => s.theme);
  const surfaceStyle = useSettingsStore((s) => s.surfaceStyle);
  const accent = useSettingsStore((s) => s.accent);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const notebookNameLive = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? ""); // = 노트북
  const browser = isBrowser();

  const themeLabel = t(theme === "dark" ? "settings.dark" : "settings.light");
  const surfaceLabel = t(surfaceStyle === "acrylic" ? "settings.surface_acrylic" : "settings.surface_flat");
  const languageLabel = UI_LANG_LABELS[uiLang] ?? uiLang;
  const regionLabel = confirmedRegion?.label ?? t("onboarding.done_region_none");
  const dataLocationLabel = pendingDataPath ?? currentDataRoot ?? t("common.loading");
  const aiLabel = aiAdopted
    ? aiAdopted.model
      ? `${aiAdopted.provider} · ${aiAdopted.model}`
      : aiAdopted.provider
    : t("onboarding.done_ai_later");
  const connectLabel = connectEnabled ? t("onboarding.done_connect_on") : t("onboarding.done_connect_off");

  return (
    <div className="ob-done">
      <DoneCelebration />
      <div>
        <h2 className="ob-title ob-title--hero">{t("onboarding.done_heading")}</h2>
        <p className="ob-sub">{t("onboarding.done_settings_hint")}</p>
      </div>

      <div className="ob-strip" data-testid="onboarding-done-summary">
        <SummaryChip icon={<IconFile size={14} />} label={t("onboarding.done_summary_notebook")} value={notebookNameLive || "—"} />
        <SummaryChip
          icon={theme === "dark" ? <IconMoon size={14} /> : <IconSun size={14} />}
          label={t("onboarding.done_summary_theme")}
          value={`${themeLabel} · ${surfaceLabel}`}
          swatch={accent}
        />
        <SummaryChip icon={<IconGlobe size={14} />} label={t("onboarding.done_summary_language")} value={languageLabel} />
        <SummaryChip
          icon={<IconFolder size={14} />}
          label={t("onboarding.done_summary_data_location")}
          value={lastPathSegment(dataLocationLabel)}
          full={dataLocationLabel}
          testId="onboarding-done-data-location"
        />
        <SummaryChip icon={<IconMapPin size={14} />} label={t("onboarding.done_summary_region")} value={regionLabel} testId="onboarding-done-region" />
        <SummaryChip icon={<IconSparkles size={14} />} label={t("onboarding.done_summary_ai")} value={aiLabel} testId="onboarding-done-ai" />
        <SummaryChip icon={<IconLink size={14} />} label={t("onboarding.done_summary_connect")} value={connectLabel} testId="onboarding-done-connect" />
        {!browser && (
          // 설정 창은 데스크톱 전용(브라우저 탭엔 OS 창이 없다) — App.tsx openSettingsWindow 와 같은 한 줄.
          <button type="button" className="btn-link ob-strip-link" onClick={openSettings} data-testid="onboarding-done-open-settings">
            {t("onboarding.done_view_settings")}
            <IconCaret dir="right" size={12} />
          </button>
        )}
      </div>

      <div className="ob-divlabel">{t("onboarding.done_features_heading")}</div>
      {/* 안내 카드 — 누를 곳이 아니다(기능 소개 모달은 설정 창에만 마운트돼 여기서 열 수 없다). */}
      <div className="ob-feats">
        <FeatureCard icon={<IconImage size={18} />} title={t("onboarding.done_feature_collect_title")} desc={t("onboarding.done_feature_collect_desc")} />
        <FeatureCard icon={<IconSmile size={18} />} title={t("onboarding.done_feature_pet_title")} desc={t("onboarding.done_feature_pet_desc")} />
      </div>

      <p className="ob-hint" style={{ maxWidth: 680, lineHeight: 1.6, whiteSpace: "pre-line" }}>
        {t("onboarding.done_dev_greeting")}
      </p>
      {SPONSOR_URL && (
        <button
          type="button"
          className="btn-link"
          style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
          onClick={() => void openExternalUrl(SPONSOR_URL)}
          data-testid="onboarding-done-sponsor"
        >
          <IconHeart size={13} />
          {t("onboarding.done_sponsor_button")}
        </button>
      )}
    </div>
  );
}

// 경로의 마지막 조각 — 요약 칩엔 폴더 이름만 보이고 전체 경로는 title 로 둔다(끝이 슬래시여도 안전).
function lastPathSegment(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

// ponytail: App.tsx openSettingsWindow 는 모듈 비공개 한 줄이라 여기서 같은 커맨드를 직접 부른다 — 세 번째 호출처가 생기면 lib 로.
function openSettings() {
  void callSilent("settings_window_open", {}).catch(() => {});
}

// 요약 띠의 칩 하나 — 아이콘 + 값(라벨은 화면에 없고 title 로만: 띠가 한 줄에 들어가야 한다). full 이 있으면 title 에 전체 값.
function SummaryChip({
  icon,
  label,
  value,
  full,
  swatch,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  full?: string;
  swatch?: string;
  testId?: string;
}) {
  return (
    <span className="ob-chip" data-testid={testId} title={`${label}: ${full ?? value}`}>
      {icon}
      <span>{value}</span>
      {swatch && (
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: "50%", background: swatch, border: "1px solid var(--divider)", flex: "none" }}
        />
      )}
    </span>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="ob-feat">
      <span className="ob-feat-icon">{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span className="ob-feat-title">{title}</span>
        <span className="ob-hint">{desc}</span>
      </span>
    </div>
  );
}

// 요약 화면 진입 축하 장면 — 은은한 글로우 + 체크 + 작은 도형들이 바깥으로 흩어지며 자리를 잡는다.
// transform/opacity 만 움직이고(onboarding.css obDone* 키프레임), 장식이라 aria-hidden.
// prefers-reduced-motion 에서는 CSS 쪽이 애니메이션을 끄고 완성 장면만 보여준다(스크립트 분기 없음).
const DONE_PARTICLES: Array<[number, number, number]> = [
  [-64, -34, 0], [58, -40, 0.03], [-40, -58, 0.06], [44, -60, 0.09],
  [-72, 4, 0.12], [70, 8, 0.02], [-30, 54, 0.08], [34, 56, 0.05],
  [0, -70, 0.1], [-54, 34, 0.14],
];

function DoneCelebration() {
  return (
    <div className="ob-done-scene" aria-hidden="true">
      <div className="ob-done-glow" />
      {DONE_PARTICLES.map(([dx, dy, delay], i) => (
        <span
          key={i}
          className="ob-done-particle"
          style={{ "--ob-done-p-to": `translate(${dx}px, ${dy}px)`, animationDelay: `${delay}s` } as React.CSSProperties}
        />
      ))}
      <div className="ob-done-check">
        <IconCheckMark size={28} strokeWidth={3} />
      </div>
    </div>
  );
}
