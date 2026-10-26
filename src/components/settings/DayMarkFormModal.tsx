import { useState } from "react";
import { call } from "../../lib/invoke";
import { t } from "../../i18n/t";
import { ModalShell } from "../ModalShell";
import { Select } from "../Select";
import { SegGroup } from "./SegGroup";
import { FormError, FormField, FormStack, FormToggleRow } from "./FormField";
import { maxSolarMarkDay } from "./dayMarkRows";
import type { CalendarMark } from "../../lib/commands.gen";

/**
 * 내 기념일 추가/편집 폼(docs/PLAN-2026-09-19-calendar-schedule.md §5.2). 저장 뒤 목록은 스토어 재로드가
 * 맡는다(`onSaved`) — Rust 도 "calendar-marks-changed" 를 내지만 이 창의 표를 그 왕복에 기대지 않는다.
 *
 * 검증은 `repo/calendar_marks.rs::validate` 를 그대로 옮겼다 — 서버가 거부할 조합(음력 + 한 번, 한 번 + 연도
 * 없음, 그 달에 없는 날)을 저장 버튼 전에 말해 준다. 음력은 매년만 되므로 음력을 고르면 반복이 매년으로
 * 고정된다(고를 수 없는 조합을 아예 못 만들게).
 *
 * `calendar_mark_update` 는 모든 필드를 덮는다 — 폼에 색 칸이 없어도 `color_hue` 를 실어 되돌려 보낸다
 * (안 그러면 이름만 고쳐도 색이 지워진다).
 *
 * 폼 아래 오류 줄은 위 검증 문구만 — 저장 실패는 call() 토스트 하나로 알린다. 저장 중엔 Escape·바깥 클릭으로 닫히지 않는다(X 는 ModalShell 이 아직 못 막는다).
 */

/** repo `TITLE_MAX_CHARS` 와 같은 값. */
const TITLE_MAX = 120;

export interface DayMarkFormState {
  title: string;
  month: number;
  day: string;
  lunar: boolean;
  repeat: "once" | "yearly";
  year: string;
  dayOff: boolean;
  colorHue: number | null;
}

function initial(mark: CalendarMark | null, defaultYear: number): DayMarkFormState {
  if (!mark) {
    return { title: "", month: 1, day: "1", lunar: false, repeat: "yearly", year: "", dayOff: false, colorHue: null };
  }
  return {
    title: mark.title,
    month: mark.month,
    day: String(mark.day),
    lunar: mark.lunar,
    repeat: mark.repeat === "once" ? "once" : "yearly",
    year: mark.year != null ? String(mark.year) : mark.repeat === "once" ? String(defaultYear) : "",
    dayOff: mark.day_off,
    colorHue: mark.color_hue,
  };
}

/** 폼 값 → 커맨드 인자, 또는 사용자에게 보일 오류 문구. */
export function validateDayMarkForm(f: DayMarkFormState):
  | { ok: true; value: { title: string; year?: number; month: number; day: number; repeat: string; lunar: boolean; day_off: boolean; color_hue?: number } }
  | { ok: false; error: string } {
  const title = f.title.trim();
  if (!title) return { ok: false, error: t("dayMarks.err_title") };
  if ([...title].length > TITLE_MAX) return { ok: false, error: t("dayMarks.err_title_long", { n: TITLE_MAX }) };
  const yearText = f.year.trim();
  let year: number | null = null;
  if (yearText) {
    year = Number(yearText);
    if (!Number.isInteger(year) || year < 1 || year > 9999) return { ok: false, error: t("dayMarks.err_year_range") };
  }
  const repeat = f.lunar ? "yearly" : f.repeat;
  if (repeat === "once" && year == null) return { ok: false, error: t("dayMarks.err_year_required") };
  const day = Number(f.day);
  const maxDay = f.lunar ? 30 : maxSolarMarkDay(repeat === "once" ? year : null, f.month);
  if (!Number.isInteger(day) || day < 1 || day > maxDay) return { ok: false, error: t("dayMarks.err_day") };
  return {
    ok: true,
    value: {
      title,
      ...(year != null ? { year } : {}),
      month: f.month,
      day,
      repeat,
      lunar: f.lunar,
      day_off: f.dayOff,
      ...(f.colorHue != null ? { color_hue: f.colorHue } : {}),
    },
  };
}

export function DayMarkFormModal({
  mark,
  workspaceId,
  defaultYear,
  onClose,
  onSaved,
}: {
  /** null = 새로 추가. */
  mark: CalendarMark | null;
  workspaceId: string | null;
  /** 표가 보고 있는 해 — 한 번짜리로 바꿀 때 연도 칸의 기본값. */
  defaultYear: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DayMarkFormState>(() => initial(mark, defaultYear));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<DayMarkFormState>) => setForm((prev) => ({ ...prev, ...p }));

  const save = async () => {
    const v = validateDayMarkForm(form);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mark) {
        await call("calendar_mark_update", { id: mark.id, ...v.value });
      } else {
        await call("calendar_mark_create", { ...(workspaceId ? { workspace_id: workspaceId } : {}), ...v.value });
      }
      onSaved();
      onClose();
    } catch {
      /* call() 이 토스트를 띄웠다 — 폼은 열어 둔 채 입력을 지킨다 */
    } finally {
      setSaving(false);
    }
  };

  const repeat = form.lunar ? "yearly" : form.repeat;

  return (
    <ModalShell
      title={mark ? t("dayMarks.form_edit_title") : t("dayMarks.form_add_title")}
      onClose={onClose}
      busy={saving}
      width={480}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
          <button type="button" className="btn" onClick={onClose} disabled={saving} data-testid="day-mark-form-cancel">
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving}
            data-testid="day-mark-form-save"
          >
            {saving ? t("note.saving") : t("common.save")}
          </button>
        </div>
      }
    >
      <FormStack>
        <FormField label={t("dayMarks.form_name")}>
          <input
            type="text"
            className="field"
            value={form.title}
            maxLength={TITLE_MAX}
            onChange={(e) => patch({ title: e.target.value })}
            data-testid="day-mark-form-title"
            autoFocus
          />
        </FormField>

        <FormField as="div" label={t("dayMarks.form_calendar")}>
          <SegGroup
            value={form.lunar ? "lunar" : "solar"}
            onChange={(v) => patch({ lunar: v === "lunar" })}
            ariaLabel={t("dayMarks.form_calendar")}
            options={[
              { value: "solar", label: t("dayMarks.form_solar") },
              { value: "lunar", label: t("dayMarks.form_lunar") },
            ]}
          />
        </FormField>

        <div style={{ display: "flex", gap: "var(--space-5)" }}>
          <FormField as="div" label={t("dayMarks.form_month")} style={{ flex: 1 }}>
            <Select
              value={String(form.month)}
              onChange={(v) => patch({ month: Number(v) })}
              ariaLabel={t("dayMarks.form_month")}
              testid="day-mark-form-month"
              options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
            />
          </FormField>
          <FormField label={t("dayMarks.form_day")} style={{ flex: 1 }}>
            <input
              type="number"
              className="field"
              min={1}
              max={form.lunar ? 30 : 31}
              value={form.day}
              onChange={(e) => patch({ day: e.target.value })}
              data-testid="day-mark-form-day"
            />
          </FormField>
        </div>

        <FormField as="div" label={t("dayMarks.form_repeat")}>
          <SegGroup
            value={repeat}
            onChange={(v) => patch({ repeat: v })}
            ariaLabel={t("dayMarks.form_repeat")}
            options={[
              { value: "yearly", label: t("dayMarks.form_yearly") },
              {
                value: "once",
                label: t("dayMarks.form_once"),
                disabled: form.lunar,
                title: form.lunar ? t("dayMarks.form_lunar_yearly") : undefined,
              },
            ]}
          />
        </FormField>

        <FormField label={repeat === "once" ? t("dayMarks.form_year") : t("dayMarks.form_first_year")}>
          <input
            type="number"
            className="field"
            min={1}
            max={9999}
            value={form.year}
            placeholder={repeat === "once" ? String(defaultYear) : ""}
            onChange={(e) => patch({ year: e.target.value })}
            data-testid="day-mark-form-year"
          />
        </FormField>

        <FormToggleRow
          label={t("dayMarks.form_day_off")}
          hint={t("dayMarks.form_day_off_hint")}
          checked={form.dayOff}
          onChange={(next) => patch({ dayOff: next })}
          data-testid="day-mark-form-day-off"
        />

        {error && <FormError data-testid="day-mark-form-error">{error}</FormError>}
      </FormStack>
    </ModalShell>
  );
}
