import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { copyWithNotice } from "../../lib/clipboard";
import type { SyncStatusOutput } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { useFeatureBriefTrigger } from "../../lib/useFeatureBrief";
import { Badge } from "./Badge";
import { DisabledGroup } from "./DisabledGroup";
import { SettingsRow } from "./SettingsRow";
import { PageLead } from "./PageLead";
import { Toggle } from "./Toggle";
import { isBrowser } from "../../lib/env";
import { ModalShell } from "../ModalShell";
import { PromptDialog } from "../PromptDialog";
import { Banner } from "./Banner";
import { IconCopy, IconLink, IconRefresh } from "../icons";
import { IconAction } from "./IconAction";
import { AgentConnectCard } from "./AgentConnectCard";
import { SettingsCard } from "./SettingsCard";

// Tailscale CGNAT 대역(100.64.0.0/10) — sync_server::bind::pick_bind_addr 가 이 대역 밖이면
// loopback으로 폴백한다. bound_addr이 loopback이면 "이 PC에서만 접속 가능" 경고를 보여준다
// (프런트가 그 판정을 다시 하지 않고, 백엔드가 고른 주소의 접두사만 본다).
function isLoopback(boundAddr: string | null): boolean {
  return !!boundAddr && boundAddr.startsWith("127.0.0.1:");
}

/** 14.2 Tailscale 안내 다이얼로그는 세션당 1회만 표시 (결정 15) */
let tailscaleNoticeShownThisSession = false;

/** 읽는 값 + 복사 아이콘 한 줄 — 긴 값은 줄임표(전체는 title), 선택·복사 가능. */
function CopyRow({ label, value, testId, copyTestId, onCopy, extra }: {
  label: string;
  value: string;
  testId: string;
  copyTestId?: string;
  onCopy: () => void;
  extra?: ReactNode;
}) {
  return (
    <SettingsRow
      label={label}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <span
            data-testid={testId}
            title={value}
            style={{ fontFamily: "monospace", fontSize: "var(--text-xs)", color: "var(--muted)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "text" }}
          >
            {value}
          </span>
          <IconAction
            icon={<IconCopy size={14} />}
            label={t("iconActions.copy_value", { label })}
            size="sm"
            data-testid={copyTestId ?? `${testId}-copy`}
            onClick={onCopy}
          />
          {extra}
        </div>
      }
    />
  );
}

export function SyncSection() {
  // 동기화(beta) 브라우저 탭 자신이 그 서버에 붙어 있는 원격 클라이언트다 — 자기 자신이 연결된
  // 서버를 켜고 끄거나 토큰을 재발급하면 스스로의 접속을 끊어버릴 수 있으므로, 이 카드는 여기서는
  // 항상 읽기 전용으로만 보여준다(sync_status 자체도 부르지 않는다 — 이 카드가 표시할 상태가
  // 없다).
  const browser = isBrowser();
  const [status, setStatus] = useState<SyncStatusOutput | null>(null);
  // 첫 읽기가 실패했다 — 빈 페이지 대신 오류와 재시도를 보여 준다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState("7332");
  // 사용자가 포트 칸을 고치는 중 — 주기 재조회·포커스 재조회가 그 초안을 서버 값으로 덮지 않는다.
  const portDirty = useRef(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [showTailscaleModal, setShowTailscaleModal] = useState(false);
  const notifyFeatureBrief = useFeatureBriefTrigger();

  const applyStatus = (s: SyncStatusOutput) => {
    setStatus(s);
    setLoadFailed(false);
    if (!portDirty.current) setPort(String(s.port));
  };

  // silent: true for the periodic poll / focus refetch below — a background re-check failing
  // (e.g. a transient network blip) shouldn't toast every 20s, only the user-initiated load/toggle
  // paths should (call() does that; callSilent() doesn't, see lib/invoke.ts).
  const load = async (silent = false) => {
    try {
      const s = await (silent ? callSilent<SyncStatusOutput>("sync_status") : call<SyncStatusOutput>("sync_status"));
      applyStatus(s);
    } catch {
      // call()/callSilent() 이 이미 처리(토스트 또는 진단 로그) — 이전 상태가 있으면 그대로 두고,
      // 한 번도 못 읽었으면 그 사실을 화면에 남긴다.
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    if (browser) return;
    void load();
  }, [browser]);

  // R2 (review finding): this card never re-polled sync_status, so a mid-session server crash,
  // stale bind, or IP change never surfaced until the user happened to reopen Settings. Poll while
  // enabled + refetch on window focus (coming back to the app tab/window is exactly when a stale
  // reading is most likely to matter).
  useEffect(() => {
    if (browser || !status?.enabled) return;
    const interval = setInterval(() => void load(true), 20_000);
    return () => clearInterval(interval);
  }, [browser, status?.enabled]);

  useEffect(() => {
    if (browser) return;
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [browser]);

  const toggle = async () => {
    if (!status) return;
    const wasEnabled = status.enabled;
    setBusy(true);
    try {
      const nextEnabled = !status.enabled;
      const s = await call<SyncStatusOutput>("sync_set_enabled", { enabled: nextEnabled });
      applyStatus(s);
      notifyFeatureBrief("sync_server", wasEnabled, nextEnabled);

      // 14.2: 켜는 순간 Tailscale 인터페이스가 없어 loopback 바인딩된 경우 세션당 1회 다이얼로그
      if (nextEnabled && s.running && isLoopback(s.bound_addr) && !tailscaleNoticeShownThisSession) {
        tailscaleNoticeShownThisSession = true;
        setShowTailscaleModal(true);
      }
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 */
    } finally {
      setBusy(false);
    }
  };

  // 포트는 settings_set 으로 즉시 저장하되, 실행 중인 서버는 sync_set_enabled 에서만 포트를 읽으므로
  // **동기화를 껐다 켜야** 새 포트로 다시 연다 — 힌트가 그 사실을 말한다. 저장이 실패하면 call() 이
  // 토스트하고 칸을 저장된 값으로 되돌린다.
  const savePort = async () => {
    if (!portDirty.current) return;
    const saved = String(status?.port ?? 7332);
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      portDirty.current = false;
      setPort(saved);
      emitNotice(t("settings.sync_port_invalid"));
      return;
    }
    if (String(n) === saved) {
      portDirty.current = false;
      return;
    }
    try {
      await call("settings_set", { entries: { sync_port: n } });
      portDirty.current = false;
      setStatus((prev) => (prev ? { ...prev, port: n } : prev));
      if (status?.running) emitNotice(t("settings.sync_port_restart_needed"));
    } catch {
      portDirty.current = false;
      setPort(saved);
    }
  };

  const regenerateToken = async () => {
    setConfirmRegenerate(false);
    setBusy(true);
    try {
      const s = await call<SyncStatusOutput>("sync_regenerate_token");
      applyStatus(s);
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 */
    } finally {
      setBusy(false);
    }
  };

  // 주소·URL·토큰 복사 한 길 — 실패하면 알리지 않고 넘어가던 것을 "복사했습니다"로 거짓 안내하지 않는다.
  const copyValue = async (value: string | null | undefined, label: string) => {
    if (!value) return;
    await copyWithNotice(value, t("settings.sync_value_copied", { label }));
  };

  // 연결 활성화 스위치는 페이지 첫 줄 설정 행(PLAN-2026-10-24 D4) — 상태 배지(베타·경고)는 라벨 옆.
  const warning =
    !!status &&
    status.enabled &&
    (!status.running || isLoopback(status.bound_addr) || status.bind_stale);
  // 프레임(.card)을 벗겼다(2026-10-27) — 마스터 스위치는 박스가 아니라 페이지 맨 위 한 줄이다.
  const hero = (
    <PageLead testId="settings-sync-master-card">
      <SettingsRow
        anchor="sync_enable"
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
            {t("settings.sync_enable")}
            <Badge>{t("settings.sync_beta_badge")}</Badge>
            {warning && (
              <span data-testid="settings-sync-warning-badge">
                <Badge tone="danger">{t("settings.sync_warning_badge")}</Badge>
              </span>
            )}
          </span>
        }
        control={
          browser ? null : (
            <Toggle
              checked={!!status?.enabled}
              busy={busy}
              disabled={!status}
              onChange={() => void toggle()}
              aria-label={t("settings.sync_enable")}
              data-testid="settings-sync-toggle"
            />
          )
        }
      />
    </PageLead>
  );

  if (browser) {
    return (
      <>
        {hero}
        <SettingsCard title={t("settings.sync_title")} icon={<IconLink size={14} strokeWidth={2} />}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>{t("common.desktop_only")}</div>
        </SettingsCard>
      </>
    );
  }

  if (!status) {
    if (!loadFailed) return hero; // 읽는 중
    return (
      <>
        {hero}
        <SettingsCard title={t("settings.sync_title")} icon={<IconLink size={14} strokeWidth={2} />}>
          <Banner
            tone="danger"
            role="alert"
            testId="settings-sync-load-failed"
            actions={
              <IconAction
                icon={<IconRefresh size={14} />}
                label={t("common.retry")}
                data-testid="settings-sync-retry"
                onClick={() => void load()}
              />
            }
          >
            {t("settings.sync_status_failed")}
          </Banner>
        </SettingsCard>
      </>
    );
  }

  return (
    <>
    {hero}
    {/* 꺼짐이어도 아래 구성을 흐리게 잠가 보여 준다(2026-10-27) — 빈 카드 머리만 남아 상태가 읽히지 않던 것을 막는다. */}
    <DisabledGroup disabled={!status.enabled} reason={t("settings.sync_off_reason")} testId="settings-sync-locked">
    <SettingsCard title={t("settings.sync_title")} icon={<IconLink size={14} strokeWidth={2} />}>

      {status.enabled && (
        <>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", padding: "var(--space-2) 0" }}>
            {status.running
              ? t("settings.sync_running")
              : t("settings.sync_pending")}
          </div>

          {/* 경고는 흐린 본문이 아니라 경고 띠로 — 접속이 안 되는 이유를 말하는 줄이다. */}
          {(!status.running || isLoopback(status.bound_addr) || status.bind_stale) && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", margin: "var(--space-2) 0" }}>
              {!status.running && (
                <Banner tone="warn" testId="settings-sync-warn-down">
                  {t("settings.sync_server_down_warning")}
                </Banner>
              )}
              {status.running && isLoopback(status.bound_addr) && (
                <Banner tone="warn" testId="settings-sync-warn-loopback">
                  {t("settings.sync_no_tailscale_warning")}
                </Banner>
              )}
              {/* bind_stale (SyncStatus, landed 2026-07-30) — the bound address no longer matches the
                  machine's current network interface, e.g. after a Wi-Fi/VPN change. */}
              {status.running && status.bind_stale && (
                <Banner tone="warn" testId="settings-sync-warn-stale">
                  {t("settings.sync_bind_stale_warning")}
                </Banner>
              )}
            </div>
          )}
        </>
      )}

          {(() => {
            const controls = (
              <>
                {status.bound_addr && (
                  <CopyRow
                    label={t("settings.connect_tile_bind")}
                    value={status.bound_addr}
                    testId="settings-sync-bind"
                    onCopy={() => void copyValue(status.bound_addr, t("settings.connect_tile_bind"))}
                  />
                )}
                {status.url && (
                  <CopyRow
                    label={t("settings.sync_url_label")}
                    value={status.url}
                    testId="settings-sync-url"
                    copyTestId="settings-sync-copy-url"
                    onCopy={() => void copyValue(status.url, t("settings.sync_url_label"))}
                  />
                )}
                <CopyRow
                  label={t("settings.sync_token_label")}
                  value={`${status.token.slice(0, 8)}…`}
                  testId="settings-sync-token"
                  onCopy={() => void copyValue(status.token, t("settings.sync_token_label"))}
                  extra={
                    <IconAction
                      icon={<IconRefresh size={14} />}
                      label={t("settings.sync_regenerate_token")}
                      size="sm"
                      data-testid="settings-sync-regenerate-token"
                      onClick={() => setConfirmRegenerate(true)}
                      disabled={busy}
                    />
                  }
                />

                {/* ponytail: 포트를 묻는 설정은 이 칸 하나다(문자 파싱 카드의 capture_ingest_port 는 화면이
                    걷혔다 — 백엔드만 남음). 포트 충돌 진단이 실제로 필요해지면 그때 네트워크 카드로 묶는다. */}
                <SettingsRow
                  label={t("settings.sync_port_label")}
                  hint={`${t("settings.local_port_desc")} ${t("settings.sync_port_restart_hint")}`}
                  control={
                    <input
                      value={port}
                      onChange={(e) => {
                        portDirty.current = true;
                        setPort(e.target.value);
                      }}
                      onBlur={() => void savePort()}
                      aria-label={t("settings.sync_port_label")}
                      data-testid="settings-sync-port"
                      type="number"
                      min={1024}
                      max={65535}
                      className="field"
                      style={{ width: 90, textAlign: "right" }}
                    />
                  }
                />
              </>
            );

            if (!status.enabled || !status.qr_svg) return controls;

            return (
              <div style={{ display: "flex", gap: "var(--space-4)" }}>
                <div style={{ flex: "none", width: 180 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-5) 0" }}>
                    <div
                      className="brise-sync-qr"
                      // PLAN-2026-09-12 §7 — 이 `#fff` 는 **테마가 아니라 데이터다.** 토큰으로 바꾸지
                      // 않는다. QR 은 어두운 모듈/밝은 여백이 규격이고, 코드 둘레의 여백(quiet zone,
                      // 여기 padding: 8)까지 밝아야 스캐너가 읽는다. 서버가 주는 SVG 는
                      // qrcode::render::svg::Color 기본값(검정 모듈)이라(src-tauri/src/commands/sync.rs
                      // build_qr_svg), 이 상자를 테마 표면색으로 칠하면 다크 테마에서 검정 위 검정이 되어
                      // **스캔이 아예 안 된다.** 그래서 앱 테마와 무관하게 항상 흰 바탕이다 — 카드 자체의
                      // flat/acrylic 시트 색과도 별개(SINGLE-SHEET 계약 예외 지점).
                      style={{
                        background: "#fff",
                        border: "1px solid var(--divider)",
                        borderRadius: "var(--radius-sm)",
                        padding: 8,
                        boxSizing: "border-box",
                        width: 180,
                        height: 180,
                      }}
                    >
                      {/* 서버가 준 SVG는 qrcode::render의 min_dimensions 로 자기 자신의 width/height 속성을
                          갖고 있다 — 그걸 그대로 두면 180px 박스 안에서 넘치거나 잘린다. 자식에게만 먹는
                          inline style로는 그 속성을 못 덮어써서(dangerouslySetInnerHTML은 다른 children과
                          같은 엘리먼트에 못 둠) 이 한 규칙만 스코프한 <style> 을 형제로 둔다. */}
                      <style>{".brise-sync-qr svg{width:100%;height:100%;display:block}"}</style>
                      <div style={{ width: "100%", height: "100%" }} dangerouslySetInnerHTML={{ __html: status.qr_svg }} />
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{t("settings.sync_qr_caption")}</div>
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 240 }}>
                  {controls}
                </div>
              </div>
            );
          })()}

          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-3)", lineHeight: 1.5 }}>
            {t("settings.sync_hint")}
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-2)", lineHeight: 1.6 }}>
            {t("settings.sync_steps_hint")}
          </div>
    </SettingsCard>
    </DisabledGroup>
    {status.enabled && <AgentConnectCard />}

      {/* 토큰을 바꾸면 지금 붙어 있는 모든 기기(폰·브라우저 탭)가 끊긴다 — 한 번 묻는다. */}
      {confirmRegenerate && (
        <PromptDialog
          mode="confirm"
          danger
          title={t("settings.sync_regenerate_token")}
          description={t("settings.sync_regenerate_confirm")}
          confirmLabel={t("settings.sync_regenerate_token")}
          onCancel={() => setConfirmRegenerate(false)}
          onSubmit={() => void regenerateToken()}
        />
      )}

      {showTailscaleModal && (
        <ModalShell
          title={t("settings.sync_tailscale_dialog_title")}
          onClose={() => setShowTailscaleModal(false)}
          width={480}
          footer={
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)", width: "100%" }}>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  void (async () => {
                    try {
                      const { openUrl } = await import("@tauri-apps/plugin-opener");
                      await openUrl("https://tailscale.com/download");
                    } catch (e) {
                      reportFallback("sync", "opener_failed", e instanceof Error ? e.message : String(e));
                      window.open("https://tailscale.com/download", "_blank");
                    }
                  })();
                }}
                data-testid="settings-sync-tailscale-download-btn"
              >
                {t("settings.sync_tailscale_download_btn")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setShowTailscaleModal(false)}
                data-testid="settings-sync-tailscale-close-btn"
              >
                {t("common.close")}
              </button>
            </div>
          }
        >
          <div style={{ fontSize: "var(--text-sm)", color: "var(--text)", lineHeight: 1.6, padding: "var(--space-2) 0" }}>
            {t("settings.sync_tailscale_dialog_desc")}
          </div>
        </ModalShell>
      )}
    </>
  );
}
