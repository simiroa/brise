import React from "react";
import { useSettingsStore } from "../../stores/settings";
import { Select } from "../Select";
import { WelcomeArt } from "./OnboardingArt";
import { t } from "../../i18n/t";
import { IconFile, IconFolder, IconSettings, IconArrowRight, IconRefresh } from "../icons";

// 언어 선택 라벨 — Select 옵션과 요약 화면 표시가 같은 세 값을 쓰므로 한 곳에 둔다.
export const UI_LANG_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
];
export const UI_LANG_LABELS: Record<string, string> = Object.fromEntries(UI_LANG_OPTIONS.map((o) => [o.value, o.label]));

/**
 * 첫 화면 — 노트북 이름·언어 + 세 경로(바로 시작 / 가져오기 / 설정). 이름 확정(goFrom)은 wizard 몫이고
 * 여기는 값과 콜백만 받는다.
 */
export function OnboardingFirstScreen({
  notebookName,
  notebookNameLive,
  hasOwnName,
  starting,
  onNameChange,
  onShuffleName,
  onKeepName,
  onStartBlank,
  onImport,
  onSetup,
}: {
  notebookName: string;
  /** 지금 활성 노트북의 실제 이름(= 노트북, 내부 식별자 workspace) */
  notebookNameLive: string;
  hasOwnName: boolean;
  starting: boolean;
  onNameChange: (name: string) => void;
  onShuffleName: () => void;
  onKeepName: () => void;
  onStartBlank: () => void;
  onImport: () => void;
  onSetup: () => void;
}) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const setUiLang = useSettingsStore((s) => s.setUiLang);
  const firstHeadline = t("onboarding.first_headline").split("\n");

  return (
    <div className="ob-first">
      <div className="ob-first-top">
        <div className="ob-first-art">
          <WelcomeArt />
        </div>
        <div className="ob-first-copy">
          <div>
            <p className="ob-eyebrow">{t("onboarding.first_eyebrow")}</p>
            {/* 헤드라인은 두 줄 — 둘째 줄만 강조색(첫 줄은 "\n" 앞). */}
            <h2 className="ob-title ob-title--hero">
              {firstHeadline[0]}
              {firstHeadline.length > 1 && (
                <>
                  <br />
                  <span style={{ color: "var(--accent)" }}>{firstHeadline.slice(1).join(" ")}</span>
                </>
              )}
            </h2>
            <p className="ob-sub">{t("onboarding.first_sub")}</p>
          </div>
          {/* 첫 노트북 이름과 언어는 첫 화면에서 — 어느 경로로 가든 이 둘은 필요하다(오너 결정).
              이름 · 새로고침 · 언어가 한 줄(라벨은 위, 새로고침은 둘 사이). */}
          <div>
            <div className="ob-first-form">
              <Field label={t("onboarding.workspace_name_label")}>
                <input
                  className="field"
                  value={notebookName}
                  onChange={(e) => onNameChange(e.target.value)}
                  data-testid="onboarding-notebook-name-input"
                />
              </Field>
              <button
                type="button"
                className="icon-btn icon-btn--lg"
                onClick={onShuffleName}
                aria-label={t("onboarding.notebook_name_shuffle")}
                title={t("onboarding.notebook_name_shuffle")}
                data-testid="onboarding-notebook-name-shuffle"
              >
                <IconRefresh size={16} />
              </button>
              <Field label={t("settings.ui_language")}>
                <Select value={uiLang} onChange={(v) => void setUiLang(v)} ariaLabel={t("settings.ui_language")} options={UI_LANG_OPTIONS} />
              </Field>
            </div>
            {hasOwnName && notebookName !== notebookNameLive && (
              <button
                type="button"
                onClick={onKeepName}
                data-testid="onboarding-notebook-name-keep"
                style={{ marginTop: "var(--space-2)", background: "none", border: "none", padding: 0, color: "var(--muted)", fontSize: "var(--text-sm)", cursor: "pointer", textDecoration: "underline", textAlign: "left" }}
              >
                {t("onboarding.notebook_name_keep", { name: notebookNameLive })}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 세 경로 — 카드는 제목·화살표만, 짧은 설명은 카드 아래 흐린 글씨(목업). */}
      <div className="ob-paths">
        <FirstScreenCard
          icon={<IconFile size={20} strokeWidth={1.8} />}
          title={t("onboarding.first_start_title")}
          desc={t("onboarding.first_start_desc")}
          primary
          disabled={starting}
          onClick={onStartBlank}
          testId="onboarding-start-blank"
        />
        <FirstScreenCard
          icon={<IconFolder size={20} strokeWidth={1.8} />}
          title={t("onboarding.first_import_title")}
          desc={t("onboarding.first_import_desc")}
          onClick={onImport}
          testId="onboarding-go-import"
        />
        <FirstScreenCard
          icon={<IconSettings size={20} strokeWidth={1.8} />}
          title={t("onboarding.setup_title")}
          desc={t("onboarding.first_setup_desc")}
          onClick={onSetup}
          testId="onboarding-go-setup"
        />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ob-group">
      <label className="ob-label">{label}</label>
      {children}
    </div>
  );
}

function FirstScreenCard({
  icon,
  title,
  desc,
  onClick,
  primary,
  disabled,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  testId: string;
}) {
  const descId = `${testId}-desc`;
  return (
    <div className="ob-path">
      <button
        type="button"
        className="card ob-path-card"
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
        data-primary={primary ? "true" : undefined}
        aria-describedby={descId}
      >
        <span className="ob-path-icon">{icon}</span>
        <span className="ob-path-title">{title}</span>
        <span className="ob-path-go">
          <IconArrowRight size={14} strokeWidth={2} />
        </span>
      </button>
      <span id={descId} className="ob-hint ob-path-desc">
        {desc}
      </span>
    </div>
  );
}
