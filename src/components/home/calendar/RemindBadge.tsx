/**
 * Small bell after a note title on any calendar surface that shows titles — month grid chips and
 * span bars, and the day detail panel's cards and time-axis rows (2026-09-08 owner). The year
 * view has no titles, so it keeps its folder-coloured corner dot instead (YearGrid).
 *
 * Neutral by construction: it says "you asked to be told about this", not "this is late" — same
 * reading as the year dot, so DASHBOARD.md §2's no-urgency rule still holds. It inherits the
 * chip's own color (currentColor) rather than introducing a tone of its own; the caller passes
 * `size` to match the text beside it.
 */
import { IconBell } from "../../icons";
import { t } from "../../../i18n/t";

export function RemindBadge({ size = 10, noteId }: { size?: number; noteId?: string }) {
  return (
    <IconBell
      data-testid={noteId ? `cal-remind-badge-${noteId}` : "cal-remind-badge"}
      size={size}
      strokeWidth={2}
      aria-label={t("editor.reminder")}
      style={{ flex: "none", fill: "currentColor", opacity: 0.75 }}
    />
  );
}
