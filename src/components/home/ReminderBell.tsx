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
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { t } from "../../i18n/t";
import { callSilent, emitNotice } from "../../lib/invoke";
import { patchDateRow } from "../../lib/primaryDate";
import type { DueReminder, ScheduleTodayResult } from "../../lib/commands.gen";
import { IconBell, IconCheck } from "../icons";
import { Toggle } from "../settings/Toggle";
import { useFloatingPopover } from "../../lib/ui";
import { displayTitle } from "../../stores/notes";

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

export function ReminderBell() {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const [items, setItems] = useState<DueReminder[]>([]);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { anchorRef, popRef, x, y } = useFloatingPopover(open, close);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void callSilent<ScheduleTodayResult>("schedule_today", { workspace_id: workspaceId })
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadToken]);

  // Badge count now means "needs your attention" (today + overdue), not just today — D5.
  const count = items.length;
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

  // PLAN-2026-09-08-dates-rebuild.md §1.5: completion means the same thing for every row now —
  // turning that row's own remind off — never note_set_status(done). The "mark the note done"
  // path is gone: state control owns done-ness, the bell only ever silences a reminder.
  // PLAN-2026-09-10 D6: 대표 분기(note_update{remind})도 사라졌다 — W4b 이후 대표 행에도 진짜
  // note_dates.id 가 있으므로 `related_date_id` 가 null 이면 patchDateRow 가 position 0 행을
  // 찾는다. 한 길이라 투영(project_primary)을 반드시 지난다.
  const dismissReminder = async (r: DueReminder) => {
    const snapshot = items;
    setItems((prev) =>
      prev.filter((x) => !(x.note_id === r.note_id && x.related_date_id === r.related_date_id)),
    );
    try {
      await patchDateRow(r.note_id, r.related_date_id ?? null, { remind: false });
      // 대표 행일 때만 notes.remind 투영이 바뀐다 — 트리 요약과 열려 있는 노트에 반영.
      if (!r.related_date_id) {
        useNotesStore.getState().patchNoteSummary(r.note_id, { remind: false });
        if (useNotesStore.getState().activeNote?.note.id === r.note_id) {
          await useNotesStore.getState().reloadActive();
        }
      }
    } catch (e) {
      setItems(snapshot);
      // call() 의 AppError 는 이미 토스트됐고 {code,message} 평범한 객체라 instanceof Error 가
      // 거짓이다 — 그대로 String(e) 하면 "[object Object]" 토스트가 하나 더 뜬다.
      // (useAttachmentActions.ts::addFile 과 같은 판정. 롤백은 위 setItems 가 이미 했다.)
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    }
  };

  return (
    <div ref={anchorRef} style={{ flex: "none", display: "flex" }}>
      <style>{`
        .reminder-row-btn { background: transparent; transition: background var(--dur-fast); }
        .reminder-row-btn:hover { background: var(--hover); }
      `}</style>
      <button
        type="button"
        className="icon-btn"
        data-testid="home-reminder-bell"
        data-count={count}
        title={t("home.reminder_today")}
        aria-label={t("home.reminder_today")}
        onClick={() => {
          if (!open) setReloadToken((n) => n + 1);
          setOpen((v) => !v);
        }}
        style={{ display: "flex", alignItems: "center", gap: "var(--space-2xs)" }}
      >
        <IconBell
          size={16}
          strokeWidth={1.8}
          style={{ fill: count > 0 ? "var(--accent)" : "none" }}
        />
        {count > 0 && (
          <span style={{ fontSize: "var(--text-label)", fontVariantNumeric: "tabular-nums" }}>
            {count}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="overlay"
            role="dialog"
            aria-label={t("home.reminder_today")}
            data-testid="home-reminder-pop"
            style={{
              position: "fixed",
              left: x,
              top: y,
              zIndex: "var(--z-popover)",
              width: 260,
              maxHeight: 320,
              overflowY: "auto",
              padding: "var(--space-4)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
