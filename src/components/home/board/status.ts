/**
 * Board status/column-target helpers — extracted from BoardPane (pure move, same behavior).
 * Shared by BoardPane, BoardColumn and BoardCard.
 */
import type { BoardColumn as BoardColumnData, BoardNote } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { isBuiltInStatus } from "../../../lib/status";
import { toIsoDateLocal } from "../../titlebar/dueDate";

/** Drop target id prefix so tree drop handlers ignore board-column drops (and vice versa). */
export const BOARD_DROP_PREFIX = "board-status:";

/** Encode null status as a sentinel for data attributes / drop target ids. */
export const NO_STATUS_TARGET = "__none__";

export function statusTargetId(status: string | null): string {
  return status === null ? NO_STATUS_TARGET : status;
}

export function parseStatusTarget(targetId: string): string | null {
  return targetId === NO_STATUS_TARGET ? null : targetId;
}

/**
 * Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01 owner decision): the ONE pin predicate —
 * shared by BoardCard's red dot and BoardColumn's sort so the two can never disagree. A note
 * pins only when the user explicitly opted in (remind=true), the end date has full day precision
 * (year-only/year-month never pins), that date is strictly before today (no time-window cutoff —
 * an ancient remind-flagged note still pins, that's the point of an explicit flag), and the
 * column isn't "done" (a finished note is never pinned/dotted — the original complaint this
 * whole model replaces). Mirrors repo::dashboard::is_pinned exactly.
 */
export function isPinned(note: BoardNote, columnStatus: string | null): boolean {
  if (!note.remind || columnStatus === "done") return false;
  if (note.end_year == null || note.end_month == null || note.end_day == null) return false;
  const endIso = `${String(note.end_year).padStart(4, "0")}-${String(note.end_month).padStart(2, "0")}-${String(note.end_day).padStart(2, "0")}`;
  return endIso < toIsoDateLocal();
}

export function columnLabel(col: BoardColumnData): string {
  if (col.status === null) return t("note.no_status");
  if (isBuiltInStatus(col.status)) {
    return t(`status.${col.status}`);
  }
  // Custom: server sends the workspace name in status_label.
  return col.status_label ?? col.status;
}
