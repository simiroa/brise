import { useEffect, useRef, useState } from "react";
import { call, callSilent } from "../../lib/invoke";
import type { SyncStatusOutput } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { openExternalUrl } from "../../lib/urls";
import { isBrowser } from "../../lib/env";
import { IconCopy, IconExternalLink, IconGlobe, IconLink, IconSmartphone } from "../icons";
import { Badge } from "../settings/Badge";

const TAILSCALE_PRICING_URL = "https://tailscale.com/pricing";
const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

// Same check as SyncSection.tsx's isLoopback — sync_server::bind::pick_bind_addr falls back to
// loopback when no Tailscale interface is up. Duplicated here (not exported there, and it's a
// one-liner) rather than adding a cross-file import for one function.
function isLoopback(boundAddr: string | null | undefined): boolean {
  return !!boundAddr && boundAddr.startsWith("127.0.0.1:");
}

/** The QR's white quiet-zone box + caption — rendered by the wizard's left (art) column while
 * connected (replacing the illustration there), not inside this step. 네 모서리 틱(.ob-qr-corner)
 * 안에 QR 을 두고 그 아래 굵은 제목 + 흐린 한 줄 설명. QR 이 담는 값·모양은 그대로다. */
export function ConnectQr({ svg }: { svg: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-4)", width: "100%" }}>
      <div className="ob-qr-frame">
        {(["tl", "tr", "bl", "br"] as const).map((c) => (
          <span key={c} className="ob-qr-corner" data-c={c} aria-hidden="true" />
        ))}
        <div
          className="brise-connect-qr"
          // Same reasoning as SyncSection.tsx's brise-sync-qr: the server's SVG is dark modules on
          // a light quiet zone by spec, not a themeable surface — always a white box regardless of
          // app theme, or a dark theme scans as black-on-black.
          style={{ background: "#fff", border: "1px solid var(--divider)", borderRadius: "var(--radius-sm)", padding: 8, boxSizing: "border-box", width: "100%", aspectRatio: "1 / 1" }}
        >
          <style>{".brise-connect-qr svg{width:100%;height:100%;display:block}"}</style>
          <div style={{ width: "100%", height: "100%" }} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-1)" }}>
        <div className="ob-qr-title">{t("onboarding.connect_qr_title")}</div>
        <div className="ob-hint" style={{ textAlign: "center" }}>
          {t("settings.sync_qr_caption")}
        </div>
      </div>
    </div>
  );
}

export function OnboardingConnectStep({
  onStatusChange,
}: {
  onStatusChange: (s: { enabled: boolean; qrSvg: string | null }) => void;
}) {
  const browser = isBrowser();
  const [status, setStatus] = useState<SyncStatusOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  // Read-only status check on mount so a re-run (server already enabled from a previous session)
  // shows its status instead of the start gate. Never fired in browser mode — this card, like
  // SyncSection's, must not touch the sync server from the tab that might itself be a remote
  // client of it.
  useEffect(() => {
    if (browser) return;
    void callSilent<SyncStatusOutput>("sync_status")
      .then(setStatus)
      .catch(() => {
        /* callSilent() already logged (diag warn) — status stays null, gate renders as if fresh */
      });
  }, [browser]);

  // 켜졌지만 아직 바인딩 전(pending)이면 running 이 될 때까지 짧게 다시 읽는다 — 안 그러면
  // "대기 중" 문구가 QR 로 바뀌지 않는다(SyncSection 은 20초 폴링이 있지만 여기는 없다).
  const pending = !!status?.enabled && !status.running;
  useEffect(() => {
    if (browser || !pending) return;
    const id = setInterval(() => {
      // silent-ok: callSilent() already logged; the next tick retries.
      void callSilent<SyncStatusOutput>("sync_status").then(setStatus).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [browser, pending]);

  const isEnabled = !!status?.enabled;
  const isRunning = !!status?.running;
  const loopback = isLoopback(status?.bound_addr);
  const qrSvg = isRunning && !loopback && status?.qr_svg ? status.qr_svg : null;

  // Report status upward (the QR itself now renders in the wizard's left column) on mount,
  // activation and every poll. Keyed on the derived values rather than on onStatusChange itself —
  // the wizard passes a fresh inline callback on every render, and depending on it directly would
  // re-fire this effect (and the wizard's setState) every render, in a loop.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    onStatusChangeRef.current({ enabled: isEnabled, qrSvg });
  }, [isEnabled, qrSvg]);

  // 켜기·다시 확인·끄기 모두 같은 커맨드다 — sync_set_enabled(true) 는 서버를 멈췄다 다시 띄우며
  // 바인딩 주소(Tailscale/loopback)를 다시 고르므로, Tailscale 을 방금 켠 뒤의 "다시 확인" 이 된다.
  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      setStatus(await call<SyncStatusOutput>("sync_set_enabled", { enabled }));
    } catch {
      /* call() already toasted the error — status stays as it was */
    } finally {
      setBusy(false);
    }
  };

  // 사용자가 누른 복사 — 성공하면 잠깐 "복사됨". 주소는 화면에 그대로 보이므로 실패해도 손으로 고를 수 있다.
  const copyUrl = async () => {
    if (!status?.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // silent-ok: clipboard unavailable (webview permission) — the address stays visible and selectable.
    }
  };

  const heading = (
    <div>
      <h2 className="ob-title">{t("onboarding.connect_heading")}</h2>
      <p className="ob-sub">{t("onboarding.connect_desc")}</p>
    </div>
  );

  if (browser) {
    return (
      <div className="ob-page">
        {heading}
        <div className="card ob-hint" style={{ padding: "var(--space-5)" }}>
          {t("common.desktop_only")}
        </div>
      </div>
    );
  }

  const linkBtn = (label: string, url: string) => (
    <button type="button" className="btn-link" onClick={() => void openExternalUrl(url)} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-sm)" }}>
      {label} <IconExternalLink size={12} />
    </button>
  );

  return (
    <div className="ob-page">
      {heading}

      <div className="ob-card" data-tone="active" data-testid="onboarding-connect-tailscale">
        <div className="ob-card-head">
          <IconLink size={18} />
          <span className="ob-card-title">{t("onboarding.connect_tailscale_title")}</span>
          <Badge tone="accent">{t("onboarding.connect_tailscale_badge")}</Badge>
        </div>

        {!isEnabled && (
          <>
            <p className="ob-hint">
              {t("onboarding.connect_guidance_body")} · {t("onboarding.connect_pricing_note")}{" "}
              {linkBtn(t("onboarding.connect_pricing_link"), TAILSCALE_PRICING_URL)}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void setEnabled(true)}
              disabled={busy}
              data-testid="onboarding-connect-start-btn"
              style={{ alignSelf: "flex-start" }}
            >
              {busy ? t("onboarding.connect_starting") : t("onboarding.connect_start_btn")}
            </button>
          </>
        )}

        {isEnabled && (
          <div data-testid="onboarding-connect-status" style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {!isRunning && <p className="ob-hint">{t("settings.sync_pending")}</p>}

            {isRunning && loopback && (
              <p className="ob-hint">
                {t("onboarding.connect_loopback")}{" "}
                {linkBtn(t("onboarding.connect_install_tailscale"), TAILSCALE_DOWNLOAD_URL)}
              </p>
            )}

            {isRunning && !loopback && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", color: "var(--ok)", fontWeight: 600, fontSize: "var(--text-md)" }}>
                  <span className="ob-dot" aria-hidden="true" />
                  {t("onboarding.connect_running_desc")}
                </div>
                {status?.url && (
                  <div className="ob-inline-row">
                    <IconGlobe size={16} />
                    <span className="ob-inline-text ob-inline-text--mono" data-testid="onboarding-connect-url" title={status.url}>
                      {status.url}
                    </span>
                    <button type="button" className="btn ob-btn-inline" onClick={() => void copyUrl()} data-testid="onboarding-connect-copy-btn">
                      <IconCopy size={14} />
                      {copied ? t("onboarding.connect_copied") : t("onboarding.connect_copy_addr")}
                    </button>
                  </div>
                )}
                <p className="ob-hint">{t("onboarding.connect_scan_steps")}</p>
              </>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap" }}>
              {isRunning && loopback && (
                <button type="button" className="btn" disabled={busy} onClick={() => void setEnabled(true)} data-testid="onboarding-connect-recheck-btn">
                  {t("onboarding.connect_recheck_btn")}
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void setEnabled(false)}
                data-testid="onboarding-connect-stop-btn"
              >
                {t("onboarding.connect_stop_btn")}
              </button>
              <span className="ob-hint" style={{ flex: "1 1 200px", minWidth: 0 }}>
                {t("onboarding.connect_stop_helper")}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="ob-card" data-dim="true" aria-disabled="true" data-testid="onboarding-connect-app-install" style={{ padding: "var(--space-5) var(--space-7)", gap: "var(--space-2)" }}>
        <div className="ob-card-head">
          <IconSmartphone size={18} />
          <span className="ob-card-title">{t("onboarding.connect_app_title")}</span>
          <Badge>{t("onboarding.connect_app_badge")}</Badge>
        </div>
        <span className="ob-hint">{t("onboarding.connect_app_desc")}</span>
      </div>
    </div>
  );
}
