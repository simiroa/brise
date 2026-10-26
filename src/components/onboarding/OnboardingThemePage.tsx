import { useSettingsStore, type Theme, type SurfaceStyle } from "../../stores/settings";
import { SegGroup } from "../settings/SegGroup";
import { AccentRow } from "../settings/AppearanceSection";
import { SpaceArt } from "./OnboardingArt";
import { isBrowser } from "../../lib/env";
import { t } from "../../i18n/t";

/**
 * 설정 1쪽 — 테마·재질·강조색. 스토어 값은 여기서 직접 구독한다(wizard 는 요약 화면용 값을 따로 안 든다).
 * `active` 가 아니면 hidden 으로 가려 마운트만 유지하고, 그림은 보이는 동안만 마운트한다.
 */
export function OnboardingThemePage({ active }: { active: boolean }) {
  const theme = useSettingsStore((s) => s.theme);
  const surfaceStyle = useSettingsStore((s) => s.surfaceStyle);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setSurfaceStyle = useSettingsStore((s) => s.setSurfaceStyle);
  const acrylicSupported = useSettingsStore((s) => s.acrylicSupported);
  const browser = isBrowser();

  return (
    <div className="ob-setup-row" hidden={!active}>
      <div className="ob-setup-art">
        <div className="ob-panel">
          <span className="badge ob-pill">{t("onboarding.preview_pill")}</span>
          {active && <SpaceArt />}
        </div>
      </div>
      <div className="ob-setup-fields">
        <div>
          <h2 className="ob-title">{t("onboarding.setup_space_heading")}</h2>
          <p className="ob-sub">{t("onboarding.setup_space_sub")}</p>
        </div>
        {/* 밝기와 재질은 "화면 분위기" 한 묶음 — 설정 > 모양과 같은 SegGroup·같은 아크릴 잠금 규칙(Windows 10
            은 아크릴 불가, 브라우저 탭은 네이티브 창이 없어 재질 자체를 감춘다). 누르는 즉시 적용된다. */}
        <div className="ob-group">
          <span className="ob-label">{t("onboarding.setup_theme_label")}</span>
          <div className="ob-theme-split">
            <div className="ob-group ob-seg">
              <span className="ob-hint">{t("onboarding.setup_brightness_label")}</span>
              <SegGroup<Theme>
                value={theme}
                onChange={(v) => void setTheme(v)}
                ariaLabel={t("settings.theme")}
                options={[
                  { value: "light", label: t("settings.light") },
                  { value: "dark", label: t("settings.dark") },
                ]}
              />
            </div>
            {!browser && (
              <>
                <span className="ob-vr" aria-hidden="true" />
                <div className="ob-group ob-seg">
                  <span className="ob-hint">{t("settings.surface_style")}</span>
                  <SegGroup<SurfaceStyle>
                    value={surfaceStyle}
                    onChange={(v) => void setSurfaceStyle(v)}
                    ariaLabel={t("settings.surface_style")}
                    options={(["acrylic", "flat"] as SurfaceStyle[]).map((style) => {
                      const locked = style === "acrylic" && !acrylicSupported;
                      return {
                        value: style,
                        label: t(`settings.surface_${style}`),
                        disabled: locked,
                        title: locked ? t("settings.surface_acrylic_unsupported") : undefined,
                      };
                    })}
                  />
                </div>
              </>
            )}
          </div>
          {!browser && (
            <p className="ob-hint">
              {surfaceStyle === "acrylic" ? t("onboarding.setup_surface_desc_acrylic") : t("onboarding.setup_surface_desc_flat")}
            </p>
          )}
        </div>
        <div className="ob-group">
          <span className="ob-label">{t("settings.accent_color")}</span>
          {/* 강조색 팔레트는 재구현하지 않는다 — 설정 화면과 같은 부품(AccentRow)을 그대로 쓴다(라벨은 위에서 한 번만). */}
          <div className="ob-accent">
            <AccentRow bare />
          </div>
          <p className="ob-hint">{t("onboarding.settings_hint")}</p>
        </div>
      </div>
    </div>
  );
}
