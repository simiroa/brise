import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { useSettingsStore } from "../../stores/settings";
import { groupCardStyle } from "./shared";
import { IconChip } from "./IconChip";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { useUpdateStatus } from "./updateStatus";

/**
 * 일반 페이지 맨 위 제품·업데이트 카드 (PLAN-2026-10-24 D2). 예전엔 레일 하단의 [업데이트][자동] 칩
 * 둘이었다(SettingsNavFooter) — 앱의 신원(이름·버전)과 그에 딸린 동작이 한 덩어리로 읽히도록 이사했다.
 *
 * 상태는 `useUpdateStatus` 가 든다(레일 점도 같은 값을 읽는다). 설치는 이 카드의 버튼에서만.
 * 변경 요약은 `latest.json` 의 notes 를 그대로 — 마크다운·HTML 해석 없이 줄바꿈만 살린다.
 * 동기화 웹 탭(isBrowser)에서는 업데이트 컨트롤을 아예 그리지 않는다(`getVersion()` 도 부르지 않는다).
 */
export function ProductUpdateCard() {
  const browser = isBrowser();
  const [appVersion, setAppVersion] = useState("");
  const phase = useUpdateStatus((s) => s.phase);
  const version = useUpdateStatus((s) => s.version);
  const notes = useUpdateStatus((s) => s.notes);
  const probe = useUpdateStatus((s) => s.probe);
  const install = useUpdateStatus((s) => s.install);
  const updateCheckAuto = useSettingsStore((s) => s.updateCheckAuto);
  const setUpdateCheckAuto = useSettingsStore((s) => s.setUpdateCheckAuto);

  useEffect(() => {
    if (browser) return;
    // silent-ok: 버전 표시는 선택적 — 못 읽으면 이름만 보인다.
    void getVersion().then(setAppVersion).catch(() => {});
  }, [browser]);

  const checkButton = (
    <button
      type="button"
      className="btn"
      data-testid="settings-update-check"
      onClick={() => void probe()}
    >
      {t("settings.check_updates")}
    </button>
  );

  const mutedText = (text: string) => (
    <span role="status" style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
      {text}
    </span>
  );

  let controls: ReactNode = null;
  if (!browser) {
    if (phase === "available") {
      controls = (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="settings-update-install"
          onClick={() => void install()}
        >
          {t("settings.update_install_version", { version: version ?? "" })}
        </button>
      );
    } else if (phase === "checking") {
      controls = (
        <button type="button" className="btn" data-testid="settings-update-check" disabled aria-busy="true">
          {t("settings.update_checking")}
        </button>
      );
    } else if (phase === "installing") {
      controls = mutedText(t("settings.update_installing"));
    } else if (phase === "latest") {
      controls = (
        <>
          {mutedText(t("settings.update_latest"))}
          {checkButton}
        </>
      );
    } else if (phase === "error") {
      controls = (
        <>
          {mutedText(t("settings.update_error"))}
          {checkButton}
        </>
      );
    } else {
      // idle — 자동 확인이 꺼져 있거나 아직 확인 전: 수동 확인 버튼만.
      controls = checkButton;
    }
  }

  return (
    <div className="card" style={groupCardStyle} data-testid="settings-product-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-5)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-5)", minWidth: 0 }}>
          <IconChip size={48}>
            <span style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>B</span>
          </IconChip>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>Brise</span>
            {appVersion && (
              <span
                data-testid="settings-product-version"
                style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}
              >
                v{appVersion}
              </span>
            )}
          </div>
        </div>
        {controls && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexShrink: 0 }}>{controls}</div>
        )}
      </div>

      {!browser && phase === "available" && notes && (
        <div
          data-testid="settings-update-notes"
          style={{
            marginTop: "var(--space-5)",
            paddingTop: "var(--space-5)",
            borderTop: "1px solid var(--divider)",
            fontSize: "var(--text-sm)",
            color: "var(--muted)",
            lineHeight: "var(--lh-ui)",
            whiteSpace: "pre-line",
            overflowWrap: "anywhere",
          }}
        >
          {notes}
        </div>
      )}

      {!browser && (
        <div style={{ marginTop: "var(--space-4)", borderTop: "1px solid var(--divider)" }}>
          <SettingsRow
            anchor="update_check_auto"
            label={t("settings.update_check_auto")}
            control={
              <Toggle
                checked={updateCheckAuto}
                onChange={(next) => void setUpdateCheckAuto(next)}
                aria-label={t("settings.update_check_auto")}
                data-testid="settings-update-auto-toggle"
              />
            }
          />
        </div>
      )}
    </div>
  );
}
