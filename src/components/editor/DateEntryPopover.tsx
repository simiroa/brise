/**
 * PLAN-2026-09-18-nl-dates.md §W2 — the shared date-entry popover for both the "/날짜" slash
 * command (slashCommand.tsx) and the "일정으로 등록" selection-menu item
 * (SelectionContextMenu.tsx). Subscribes to lib/dateEntryBridge.ts (siblings mounted separately in
 * EditorPanel have no prop path — same reasoning as footnoteMark.ts's hover/jump bridge).
 *
 * Does NOT build a new form: it hosts `DatesPanel`'s existing "+" row-add UI as-is (W0-Frontend
 * already wired note_date_add's label through it) — same idiom as the translateCtx/linkCtx
 * popovers in SelectionContextMenu.tsx (manual `useMenuPos` + `overlay` class + Escape/backdrop
 * dismiss), not `ContextMenuShell` (DatesPanel is its own scrollable form, not a menu-row list).
 */
import { useEffect, useState } from "react";
import { DatesPanel, type DatesPanelAddedRow } from "../titlebar/DatesPanel";
import { subscribeDateEntry, type DateEntryPayload } from "../../lib/dateEntryBridge";
import { getActiveEditor } from "../../lib/aiSectionBridge";
import { formatDateBadgeLabel } from "../titlebar/eventDate";
import { useMenuPos } from "../../lib/ui";
import { t } from "../../i18n/t";

/** D6 — plain-text line format for the "/날짜" flow's body insertion: the date/range in this app's
 *  usual dot notation (formatDateBadgeLabel, same function the date chip and related-date rows
 *  use), the time range if set (same "HH:MM–HH:MM" convention as scheduleRrule.ts::scheduleLabels'
 *  `time` field — kept inline here rather than importing, since that helper takes a full row and
 *  computes repeat/offset too), then the label. 2026-09-19 후속: 처음엔 시각을 안 실었다. */
export function formatDateEntryLine(row: DatesPanelAddedRow): string {
  const datePart = formatDateBadgeLabel(row.year, row.month, row.day, {
    end_year: row.end_year,
    end_month: row.end_month,
    end_day: row.end_day,
  });
  const timePart = row.start_time ? `${row.start_time}${row.end_time ? `–${row.end_time}` : ""}` : null;
  return [datePart, timePart, row.label].filter((part): part is string => !!part).join(" ");
}

export function DateEntryPopover({ noteId }: { noteId: string }) {
  const [payload, setPayload] = useState<DateEntryPayload | null>(null);

  useEffect(() => subscribeDateEntry(setPayload), []);

  const { ref, x, y } = useMenuPos(payload ? { x: payload.anchorX, y: payload.anchorY } : null);

  // 번역/링크 팝오버(SelectionContextMenu.tsx)와 같은 관용구 — 메인 선택 메뉴처럼 overlayStack
  // 체인에 올라가 있지 않으니 직접 Escape 를 듣는다.
  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPayload(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload]);

  if (!payload) return null;

  // PLAN-2026-09-18-nl-dates.md §W3a — both success paths tag the row's id onto the body so a
  // later click can jump back to this exact row (DateMark, mdSerialize.ts's BriseDateMark).
  const handleRowAdded = (row: DatesPanelAddedRow) => {
    const editor = getActiveEditor();
    if (editor) {
      const { from, to } = payload.range;
      const markType = editor.schema.marks.date;
      if (payload.replaceRangeOnSave) {
        // "/날짜" flow — the range is still the "/날짜" trigger text; replace it with the
        // formatted plain-text line, then mark exactly the inserted span (same tr, so the mark's
        // position math needs no separate round-trip through the chain's position mapping).
        const line = formatDateEntryLine(row);
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            const start = Math.min(from, tr.doc.content.size);
            const end = Math.min(to, tr.doc.content.size);
            tr.insertText(line, start, end);
            if (markType) tr.addMark(start, start + line.length, markType.create({ id: row.id }));
            return true;
          })
          .run();
      } else if (!payload.editRowId) {
        // "일정으로 등록" flow — body stays untouched (D6); the already-selected text at `range`
        // is what gets marked, so a later click finds its way back to this row.
        //
        // Gated on !editRowId: when this popover was opened by clicking an EXISTING DateMark
        // (editRowId set), `range` is that mark's own — real, non-collapsed — span. If the user
        // then presses "+" to add an unrelated NEW row (DatesPanel's "+" always creates a fresh
        // row regardless of initialSelectedId), marking `range` here would silently repoint the
        // original mark's id to this new, unrelated row — corrupting a correct existing link
        // rather than leaving it alone. There is no source body span for a row created from the
        // edit-view, so it simply gets no mark (consistent with §W3a's "no crash" bar for this
        // interaction, plan doc's "residual risk" note).
        const docSize = editor.state.doc.content.size;
        const start = Math.min(from, docSize);
        const end = Math.min(to, docSize);
        if (start < end) {
          editor.chain().focus().setTextSelection({ from: start, to: end }).setMark("date", { id: row.id }).run();
        }
      }
    }
    setPayload(null);
  };

  return (
    <>
      <div
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPayload(null)}
        style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
      />
      <div
        ref={ref}
        className="overlay"
        role="dialog"
        aria-label={t("editor.year_date_popover_label")}
        data-editor-pop=""
        data-testid="date-entry-popover"
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          zIndex: "var(--z-modal)",
          width: 296,
          maxWidth: "calc(100vw - 32px)",
          border: "2px solid var(--divider)",
          boxShadow: "var(--shadow-lg)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-3)",
          left: x,
          top: y,
        }}
      >
        <DatesPanel
          noteId={payload.noteId ?? noteId}
          seed={
            payload.prefill
              ? {
                  year: payload.prefill.start.year,
                  month: payload.prefill.start.month,
                  day: payload.prefill.start.day,
                  end_year: payload.prefill.end.end_year,
                  end_month: payload.prefill.end.end_month,
                  end_day: payload.prefill.end.end_day,
                }
              : undefined
          }
          initialLabel={payload.prefill?.label ?? undefined}
          initialStartTime={payload.prefill?.startTime ?? undefined}
          initialEndTime={payload.prefill?.endTime ?? undefined}
          initialSelectedId={payload.editRowId}
          onRowAdded={handleRowAdded}
        />
      </div>
    </>
  );
}
