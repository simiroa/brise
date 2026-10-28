/**
 * Window-chrome reminder bell (was in HomeHeader; lives next to the pet toggle).
 * Read-only "today's reminders" list — docs/PLAN-schedule-system.md §7.4.
 *
 * GRILL-2026-09-07 D5: schedule_today now also returns overdue reminders (kind:"overdue",
 * fire_at:null) ahead of today's (kind:"due") — no new table, no new command, this is the derived
 * "pinned" judgment (repo::dashboard::due_reminders) the board already uses. The popover splits
 * into an overdue section on top (badge count now covers both, not just today) so a fired-and-
 * forgotten reminder doesn't just vanish (owner's biggest pain point, see the grill doc §1).
 */
import React, { useMemo } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore, displayTitle } from "../../stores/notes";
import { t } from "../../i18n/t";
import { dismissNotice, runNoticeAction, useFrameNotices } from "../../lib/frameNotices";
import type { DueReminder } from "../../lib/commands.gen";
import { IconBell, IconCheck, IconClose } from "../icons";
import { Toggle } from "../settings/Toggle";
import { FrameMenuPop, useFrameMenu } from "../FrameMenu";
import { useDueReminders } from "./useDueReminders";
import { useFrameNoticeProducers } from "./useFrameNoticeProducers";
import "./reminderBell.css";

const rowButtonStyle: React.CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
  alignItems: "baseline",
  width: "100%",
  textAlign: "left",
  border: "none",
  padding: "var(--space-2) var(--space-2)",
  borderRadius: "var(--radius-sm)",
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "inherit",
  cursor: "pointer",
};

/**
 * 두 구역(지난 것 · 오늘)이 쓰는 **한 벌**의 행. 예전엔 "지난 것"에만 알림 끄기(✓)가 붙어
 * 있었고 오늘 행은 여는 버튼 하나뿐이라, 오늘 이미 울린 알림은 자정이 지나 overdue 로 넘어갈
 * 때까지 벨에서 치울 방법이 없었다(오너 보고 2026-09-09). 같은 기능은 같은 관문이어야 하므로
 * 구역을 나누는 것은 시각(fire_at) 표시 유무뿐이고, 끄는 경로는 하나다.
 */
function Row({
  item,
  onOpen,
  onDismiss,
}: {
  item: DueReminder;
  onOpen: (noteId: string) => void;
  onDismiss: (r: DueReminder) => void;
}) {
  const testid = item.related_date_id ? `${item.note_id}-${item.related_date_id}` : item.note_id;
  const time = item.fire_at?.slice(11, 16) ?? "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
      <button
        type="button"
        className="reminder-row-btn"
        data-testid={`home-reminder-item-${testid}`}
        onClick={() => onOpen(item.note_id)}
        style={{ ...rowButtonStyle, flex: 1, minWidth: 0 }}
      >
        {time && (
          <span style={{ color: "var(--faint)", fontVariantNumeric: "tabular-nums", flex: "none" }}>
            {time}
          </span>
        )}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {displayTitle(item.title)}
        </span>
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        data-testid={`home-reminder-complete-${testid}`}
        title={t("home.reminder_dismiss")}
        aria-label={t("home.reminder_dismiss")}
        onClick={() => onDismiss(item)}
        style={{ color: "var(--muted)", width: 22, height: 22, flex: "none" }}
      >
        <IconCheck size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

/** 배지 문구 — 세 자리까지, 넘으면 999+. */
export function badgeLabel(n: number): string {
  return n > 999 ? "999+" : String(n);
}

export function ReminderBell() {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const menu = useFrameMenu();
  const { open, setOpen, anchorRef } = menu;

  // 일정 알림(오늘 + 지난 것) — 조회·끄기·롤백은 훅이 갖고, 울린 알림(app-notice)이 오면 스스로 다시 읽는다.
  const { items, reload, dismiss: dismissReminder } = useDueReminders(workspaceId);
  // 앱 알림(백업 권유·펫 제안·용량 한도) — 목록과 "처음 한 번 토스트"는 lib/frameNotices.ts 가 갖고, 생산자는 각자 모듈이다.
  // 여기는 생산자를 걸고(마운트 지점) 스토어를 그리기만 한다.
  useFrameNoticeProducers();
  const notices = useFrameNotices((s) => s.notices);

  // Badge count now means "needs your attention" (today + overdue + app notices), not just today — D5.
  const count = items.length + notices.length;
  const overdueItems = useMemo(() => items.filter((r) => r.kind === "overdue"), [items]);
  const dueItems = useMemo(() => items.filter((r) => r.kind !== "overdue"), [items]);

  const openNote = (noteId: string) => {
    setOpen(false);
    void useNotesStore.getState().selectNote(noteId);
  };

  // A note can carry several related-date reminders alongside its own primary one (same
  // note_id, different related_date_id|null) — PLAN-2026-09-07-reminder-2tier.md §0.3. Row
  // identity has to be the pair, not just note_id, or siblings collide (key/testid) and an
  // optimistic removal wipes them all.
  const rowKey = (r: DueReminder) => `${r.note_id}:${r.related_date_id ?? "note"}`;

  return (
    <div ref={anchorRef} style={{ flex: "none", display: "flex" }}>
      <button
        type="button"
        className="icon-btn"
        data-testid="home-reminder-bell"
        data-count={count}
        title={t("home.reminder_today")}
        aria-label={t("home.reminder_today")}
        onClick={() => {
          if (!open) reload();
          setOpen((v) => !v);
        }}
        style={{ position: "relative" }}
      >
        <IconBell
          size={16}
          strokeWidth={1.8}
          style={{ fill: count > 0 ? "var(--accent)" : "none" }}
        />
        {/* 아이콘 크기는 그대로, 숫자는 우상단을 덮는다 — 예전엔 버튼 폭 안에 아이콘과 나란히 들어가
            아이콘이 혼자 작아졌다. 오른쪽 끝에 매달아 자리수가 늘면 왼쪽(아이콘 위)으로 자란다. */}
        {count > 0 && (
          <span className="badge reminder-bell-badge" data-testid="home-reminder-badge">
            {badgeLabel(count)}
          </span>
        )}
      </button>
      <FrameMenuPop menu={menu} label={t("home.reminder_today")} testId="home-reminder-pop">
          <div className="frame-menu__body">
            {/* 설정 창과 같은 키(setNotificationsEnabled) — 설정까지 가지 않고 여기서 바로 켜고 끈다. */}
            <div
              data-testid="home-reminder-app-notify"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-3)",
                fontSize: "var(--text-xs)",
                color: notificationsEnabled ? "var(--muted)" : "var(--faint)",
              }}
            >
              <span>{t("settings.notifications_enabled")}</span>
              <Toggle
                checked={notificationsEnabled}
                onChange={(next) => void setNotificationsEnabled(next)}
                aria-label={t("settings.notifications_enabled")}
                data-testid="home-reminder-app-toggle"
              />
            </div>

            {notices.length > 0 && (
              <div
                data-testid="home-reminder-notices"
                style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
              >
                {notices.map((n) => (
                  <div
                    key={n.key}
                    data-testid={`home-notice-${n.key}`}
                    style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
                  >
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>{n.text}</span>
                    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "var(--space-2)" }}>
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        data-testid={`home-notice-dismiss-${n.key}`}
                        title={n.dismissLabel}
                        aria-label={n.dismissLabel}
                        onClick={() => dismissNotice(n.key)}
                      >
                        <IconClose size={12} strokeWidth={2.2} />
                      </button>
                      {n.onAction && (
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          data-testid={`home-notice-action-${n.key}`}
                          disabled={n.busy}
                          onClick={() => {
                            setOpen(false);
                            runNoticeAction(n.key);
                          }}
                          style={{ width: "auto", padding: "0 var(--space-2)", whiteSpace: "nowrap", color: "var(--accent)" }}
                        >
                          {n.actionLabel}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {overdueItems.length > 0 && (
              <div
                data-testid="home-reminder-overdue-section"
                style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
              >
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                    color: "var(--danger)",
                  }}
                >
                  {t("home.reminder_overdue_n", { n: overdueItems.length })}
                </div>
                {overdueItems.map((r) => (
                  <Row key={rowKey(r)} item={r} onOpen={openNote} onDismiss={dismissReminder} />
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--muted)" }}>
                {t("home.reminder_today")}
              </div>
              {dueItems.length === 0 ? (
                <div style={{ fontSize: "var(--text-sm)", color: "var(--faint)" }}>
                  {t("home.reminder_empty")}
                </div>
              ) : (
                dueItems.map((r) => (
                  <Row key={rowKey(r)} item={r} onOpen={openNote} onDismiss={dismissReminder} />
                ))
              )}
            </div>
          </div>
      </FrameMenuPop>
    </div>
  );
}
