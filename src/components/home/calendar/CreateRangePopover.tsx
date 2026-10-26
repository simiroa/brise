/**
 * Drag-to-create range confirm popover (`cal-create-pop`) — split out of CalendarEventDialog
 * (2026-09-12) so the dashboard month grid and the sidebar mini calendar (leftpanel/expanded/
 * CalendarExpanded.tsx) share one component instead of the sidebar growing a second copy.
 *
 * **Owner feedback (2026-09-12): this popover used to embed `DatesPanel`** (title bar's date
 * chip body — a full month calendar grid + related-dates list), reasoning "same component as
 * the note tab" (docs/PLAN-2026-09-10-calendar-reminders.md §0/D1). That put a second calendar
 * grid inside a popover that's anchored ON TOP of the calendar the user just dragged on — the
 * date is already picked, so the grid only duplicated it. The exact same tension was already
 * resolved the other way for the card's inline "이 날의 기록" add-date affordance (same plan,
 * D5/W4): "달력은 안 넣는다 — 280px 패널에 296px 팝오버 본체는 안 들어가고, 날짜는 이미 골라져
 * 있다." This popover now follows that precedent — `NoteDatesList` alone (bell · time · repeat ·
 * remove, still everything the original request asked for) with no calendar grid. Adding a
 * *second* related date from here still needs the grid, so that stays a job for the note's own
 * date chip (DateBadge → DatesPanel) once opened — this popover was never the only way to reach
 * that, just the fast path for the one date the drag already picked.
 */
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { t } from "../../../i18n/t";
import { CreatePopover } from "../CreatePopover";
import { Select } from "../../Select";
import { NoteDatesList } from "../../attachments/NoteDatesList";
import { useNotesStore } from "../../../stores/notes";
import { parseIsoDay } from "../calendarLayout";

function formatShort(iso: string): string {
  const p = parseIsoDay(iso);
  if (!p) return iso;
  return `${p.month}/${p.day}`;
}

export interface CreateRangePopoverProps {
  popover: { startDay: string; endDay: string; x: number; y: number } | null;
  /** PLAN-2026-09-10 D3 — 드래그를 놓는 순간 이미 만들어진 노트. 팝오버는 그 노트를 고치는
   *  자리이고(제목·폴더·날짜 칩), 취소는 그 노트를 purge 한다. 생성이 끝나기 전엔 null. */
  createdNoteId?: string | null;
  creating?: boolean;
  onConfirmCreate: (title: string, folderId: string) => Promise<void> | void;
  onClosePopover: () => void;
}

/** Title/subtitle text below the range — shared by both callers, both format the same way. */
function rangeTitle(startDay: string, endDay: string): ReactNode {
  return startDay === endDay
    ? t("home.cal_create_single", { day: formatShort(startDay) })
    : t("home.cal_create_range", { from: formatShort(startDay), to: formatShort(endDay) });
}

export function CreateRangePopover({
  popover,
  createdNoteId = null,
  creating = false,
  onConfirmCreate,
  onClosePopover,
}: CreateRangePopoverProps) {
  const [createTitle, setCreateTitle] = useState("");
  const createTitleRef = useRef<HTMLInputElement>(null);
  // 노트는 이미 받은편지함에 있다(createNoteForRange) — 이 칸은 "옮길 곳"이고 기본값이 곧 현재값.
  const folders = useNotesStore((s) => s.folders);
  const inboxId = useNotesStore((s) => s.inboxId);
  const [createFolderId, setCreateFolderId] = useState("");

  // 타임라인 "폴더로 이동" 메뉴와 **같은 목록 소스**(notes 스토어의 folders), FolderBadge 와 같은
  // 정렬(position → name). 받은편지함도 남긴다 — 여기선 그것이 기본값이다.
  const folderOptions = useMemo(
    () =>
      [...folders]
        .sort((a, b) => (a.position !== b.position ? a.position - b.position : a.name.localeCompare(b.name)))
        .map((f) => ({ value: f.id, label: f.name })),
    [folders],
  );

  useEffect(() => {
    if (!popover) return;
    setCreateTitle("");
    setCreateFolderId(inboxId ?? "");
    const id = requestAnimationFrame(() => createTitleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [popover, inboxId]);

  const handleCreateFromRange = useCallback(async () => {
    if (!popover || creating || !createdNoteId) return;
    await onConfirmCreate(createTitle, createFolderId);
  }, [popover, creating, createdNoteId, onConfirmCreate, createTitle, createFolderId]);

  if (!popover) return null;

  return (
    <CreatePopover
      testId="cal-create-pop"
      anchor={{ x: popover.x, y: popover.y }}
      title={
        <>
          {rangeTitle(popover.startDay, popover.endDay)}{" "}
          <span style={{ color: "var(--faint)" }}>({t("home.cal_create_hint")})</span>
        </>
      }
      confirmLabel={t("home.cal_create")}
      cancelLabel={t("home.cal_cancel")}
      confirmTestId="cal-create-confirm"
      cancelTestId="cal-create-cancel"
      creating={creating || !createdNoteId}
      onConfirm={() => void handleCreateFromRange()}
      onCancel={onClosePopover}
    >
      <input
        ref={createTitleRef}
        type="text"
        data-testid="cal-create-title"
        value={createTitle}
        placeholder={t("note.untitled_note")}
        onChange={(e) => setCreateTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void handleCreateFromRange();
          }
        }}
        className="field"
        style={{
          height: 30,
          padding: "0 var(--space-3)",
          fontSize: "var(--text-sm)",
        }}
      />
      <label style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <span style={{ color: "var(--faint)", fontSize: "var(--text-xs)", flex: "none" }}>
          {t("home.cal_create_folder")}
        </span>
        <Select
          value={createFolderId}
          onChange={setCreateFolderId}
          options={folderOptions}
          ariaLabel={t("home.cal_create_folder")}
          testid="cal-create-folder"
          style={{ flex: 1, minWidth: 0 }}
        />
      </label>
      {/* 날짜는 이미 드래그로 골랐다 — 달력을 또 넣지 않는다(파일 헤더 주석). 벨·시각·반복은
          NoteDatesList 하나로 다 된다(그 파일이 SSOT). 두 번째 관련 날짜를 추가하려면 노트의
          날짜 칩(DateBadge)을 연다 — 거긴 화면에 다른 달력이 없으니 그리드가 그대로 맞다. */}
      {createdNoteId && (
        <div data-testid="cal-create-dates" style={{ width: 296, maxWidth: "100%" }}>
          <NoteDatesList noteId={createdNoteId} />
        </div>
      )}
    </CreatePopover>
  );
}
