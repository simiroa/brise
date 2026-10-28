/**
 * Calendar event dialogs & AI scheduling modals — extracted from CalendarTab.
 * Covers:
 * 1. Drag-to-create range confirm popover (CreatePopover: cal-create-pop)
 * 2. Right-click AI prompt popover (CreatePopover: cal-ai-prompt)
 * 3. Right-click AI proposal confirmation popover (CreatePopover: cal-ai-proposal)
 * 4. Pure AI schedule prompt building & parsing helpers
 */
import { useEffect, useRef, useState, useCallback, memo } from "react";
import { t } from "../../../i18n/t";
import { CreatePopover } from "../CreatePopover";
import { CreateRangePopover, type CreateRangePopoverProps } from "./CreateRangePopover";
import { orderIsoRange, parseIsoDay } from "../calendarLayout";
import { addDaysIso } from "../dateFmt";

/** AI schedule proposal for a right-clicked calendar day (Wave 3 L2). */
export type CalendarScheduleProposal = {
  title: string;
  start: string;
  end: string;
};

// 날짜 더하기의 구현은 ../dateFmt 한 곳 — 기존 import 경로(CalendarTab 재수출)를 위해 여기서도 내보낸다.
export { addDaysIso };

function isoFromYmd(year: unknown, month: unknown, day: unknown): string | null {
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") return null;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const y = Math.trunc(year);
  const m = Math.trunc(month);
  const d = Math.trunc(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return parseIsoDay(s) ? s : null;
}

/**
 * Defensive parse of ai_generate_from_prompt output for calendar scheduling.
 * Returns null on any unusable answer — callers must surface a failure, never create a garbage note.
 */
export function parseCalendarScheduleProposal(
  raw: string,
  anchorDay: string,
): CalendarScheduleProposal | null {
  if (!raw || !raw.trim()) return null;
  if (!parseIsoDay(anchorDay)) return null;

  let text = raw.trim();
  const fence = text.match(/^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (fence) text = fence[1].trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;

  let start = anchorDay;
  if (typeof obj.start === "string" && parseIsoDay(obj.start)) start = obj.start;
  else if (typeof obj.start_date === "string" && parseIsoDay(obj.start_date)) start = obj.start_date;
  else {
    const fromParts = isoFromYmd(obj.year, obj.month, obj.day);
    if (fromParts) start = fromParts;
  }

  let end = start;
  if (typeof obj.end === "string" && parseIsoDay(obj.end)) end = obj.end;
  else if (typeof obj.end_date === "string" && parseIsoDay(obj.end_date)) end = obj.end_date;
  else if (
    typeof obj.duration_days === "number" &&
    Number.isFinite(obj.duration_days) &&
    obj.duration_days >= 1
  ) {
    // Inclusive length: duration_days=7 → start..start+6.
    const e = addDaysIso(start, Math.max(0, Math.floor(obj.duration_days) - 1));
    if (e) end = e;
  } else {
    const endParts = isoFromYmd(obj.end_year, obj.end_month, obj.end_day);
    if (endParts) end = endParts;
  }

  const [lo, hi] = orderIsoRange(start, end);
  return { title, start: lo, end: hi };
}

/** System prompt + user text for calendar AI scheduling (no note body context). */
export function buildCalendarSchedulePrompt(anchorDay: string, userText: string): string {
  return [
    `Schedule one calendar note. Anchor day (local calendar date): ${anchorDay}.`,
    `User request: ${userText.trim()}`,
    "",
    "Reply with ONLY a single JSON object, no markdown fences, no prose:",
    '{"title":"short title","start":"YYYY-MM-DD","end":"YYYY-MM-DD"}',
    "Rules:",
    `- start defaults to ${anchorDay} when the user does not pick another start.`,
    "- end is inclusive; single-day notes set end equal to start.",
    `- For a one-week / 일주일 trip starting on the anchor day: start=${anchorDay}, end=start+6 days.`,
    "- title must be non-empty and concise.",
    "- Dates must be ISO YYYY-MM-DD only.",
  ].join("\n");
}

function formatShort(iso: string): string {
  const p = parseIsoDay(iso);
  if (!p) return iso;
  return `${p.month}/${p.day}`;
}

export interface CalendarEventDialogProps extends CreateRangePopoverProps {
  /** Right-click AI prompt state */
  aiPrompt: { day: string; x: number; y: number } | null;
  aiProposing?: boolean;
  promptPending?: boolean;
  onSubmitAiPrompt: (anchor: { day: string; x: number; y: number }, userText: string) => Promise<void> | void;
  onCloseAiPrompt: () => void;

  /** Right-click AI proposal confirm state */
  aiProposal: (CalendarScheduleProposal & { x: number; y: number }) | null;
  onConfirmAiProposal: () => Promise<void> | void;
  onCloseAiProposal: () => void;
}

export const CalendarEventDialog = memo(function CalendarEventDialog({
  popover,
  createdNoteId = null,
  creating = false,
  onConfirmCreate,
  onClosePopover,
  aiPrompt,
  aiProposing = false,
  promptPending = false,
  onSubmitAiPrompt,
  onCloseAiPrompt,
  aiProposal,
  onConfirmAiProposal,
  onCloseAiProposal,
}: CalendarEventDialogProps) {
  const [aiPromptText, setAiPromptText] = useState("");
  const aiPromptInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!aiPrompt) return;
    setAiPromptText("");
    const id = requestAnimationFrame(() => aiPromptInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [aiPrompt]);

  const handleSubmitAi = useCallback(async () => {
    if (!aiPrompt || aiProposing || promptPending) return;
    const text = aiPromptText.trim();
    if (!text) return;
    await onSubmitAiPrompt(aiPrompt, text);
  }, [aiPrompt, aiProposing, promptPending, aiPromptText, onSubmitAiPrompt]);

  return (
    <>
      {/* Drag-create confirm popover — extracted to CreateRangePopover so the sidebar mini
          calendar (leftpanel/expanded/CalendarExpanded.tsx) can share it verbatim. */}
      <CreateRangePopover
        popover={popover}
        createdNoteId={createdNoteId}
        creating={creating}
        onConfirmCreate={onConfirmCreate}
        onClosePopover={onClosePopover}
      />

      {/* Right-click AI schedule — prompt phase */}
      {aiPrompt && (
        <CreatePopover
          testId="cal-ai-prompt"
          anchor={{ x: aiPrompt.x, y: aiPrompt.y }}
          title={t("home.cal_ai_prompt_title", { day: formatShort(aiPrompt.day) })}
          confirmLabel={t("home.cal_ai_generate")}
          cancelLabel={t("home.cal_cancel")}
          confirmTestId="cal-ai-prompt-submit"
          cancelTestId="cal-ai-prompt-cancel"
          creating={aiProposing || promptPending}
          onConfirm={() => void handleSubmitAi()}
          onCancel={onCloseAiPrompt}
        >
          <input
            ref={aiPromptInputRef}
            type="text"
            data-testid="cal-ai-prompt-input"
            value={aiPromptText}
            placeholder={t("home.cal_ai_prompt_placeholder")}
            disabled={aiProposing || promptPending}
            onChange={(e) => setAiPromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmitAi();
              }
            }}
            className="field"
            style={{
              height: 30,
              padding: "0 var(--space-3)",
              fontSize: "var(--text-sm)",
            }}
          />
        </CreatePopover>
      )}

      {/* Right-click AI schedule — confirm proposal (create only after user OK) */}
      {aiProposal && (
        <CreatePopover
          testId="cal-ai-proposal"
          anchor={{ x: aiProposal.x, y: aiProposal.y }}
          title={aiProposal.title}
          subtitle={
            aiProposal.start === aiProposal.end
              ? t("home.cal_create_single", { day: formatShort(aiProposal.start) })
              : t("home.cal_create_range", {
                  from: formatShort(aiProposal.start),
                  to: formatShort(aiProposal.end),
                })
          }
          confirmLabel={t("home.cal_create")}
          cancelLabel={t("home.cal_cancel")}
          confirmTestId="cal-ai-proposal-confirm"
          cancelTestId="cal-ai-proposal-cancel"
          creating={creating}
          onConfirm={() => void onConfirmAiProposal()}
          onCancel={onCloseAiProposal}
        />
      )}
    </>
  );
});
