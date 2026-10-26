import { anchorId, useSettingsAnchorOnce } from "../settingsAnchor";
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../../../lib/invoke";
import { t } from "../../../i18n/t";
import { TableSection } from "../TableSection";
import { SettingsTable, SettingsTableRow } from "../SettingsTable";
import { IconAction } from "../IconAction";
import { FormError, FormField, FormStack, WeekdayMaskField } from "../FormField";
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconSmile, IconTrash } from "../../icons";
import { ModalShell } from "../../ModalShell";
import { PromptDialog } from "../../PromptDialog";
import { Select } from "../../Select";
import { weekdayShortLabels } from "../../home/dateFmt";
import { useSettingsStore } from "../../../stores/settings";
import { reportFallback } from "../../../lib/diag";
import type { Habit, HabitListOutput } from "../../../lib/commands.gen";

/**
 * 습관 표(PLAN-2026-09-30-briefing D1·D2) — `habits` 테이블 CRUD. 시간 없는 "매일 체크" 항목이라
 * 시간대 반복 일정(TimelineRoutineSection)과는 별개다. 표 블록(TableSection)·모달 폼(FormField)·삭제 확인
 * 문법은 그 섹션과 같다. 삭제를 묻는 이유: 되돌리기로 다시 만들면 체크 기록이 따라오지 않는다.
 *
 * 삭제·순서 변경은 낙관적 갱신 + 실패 시 롤백(CLAUDE.md 함정 #9). 아이콘·색은 이 편집기에서 다루지 않고
 * 수정 때 기존 값을 그대로 되돌려 보낸다(`habit_update` 는 icon/hue 를 통째 교체 — W1 보고).
 * 저장 실패는 call() 토스트 하나로 알리고, 폼 아래 오류 줄은 클라이언트 검증 문구만 보여준다.
 */

/** weekday_mask: 비트0=월..비트6=일 고정(사용자 weekStart 와 무관). 기본 = 매일. */
const ALL_DAYS = 0b1111111;

interface FormState {
  id?: string;
  title: string;
  weekdayMask: number;
  icon: string | null;
  hue: number | null;
  timeOfDay: TimeOfDay;
}

const TIMES_OF_DAY = ["any", "morning", "evening"] as const;
type TimeOfDay = (typeof TIMES_OF_DAY)[number];
const TOD_LABEL: Record<TimeOfDay, string> = {
  any: "settings.briefing_habit_time_any",
  morning: "settings.briefing_habit_time_morning",
  evening: "settings.briefing_habit_time_evening",
};
const asTimeOfDay = (v: string): TimeOfDay => (TIMES_OF_DAY as readonly string[]).includes(v) ? (v as TimeOfDay) : "any";

const NEW_FORM: FormState = { title: "", weekdayMask: ALL_DAYS, icon: null, hue: null, timeOfDay: "any" };

export function HabitsEditor() {
  const uiLang = useSettingsStore((s) => s.uiLang) || "en";
  const weekdayLabels = weekdayShortLabels(uiLang, "monday");

  const [habits, setHabits] = useState<Habit[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Habit | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await call<HabitListOutput>("habit_list", {});
      if (alive.current) setHabits(r.habits ?? []);
    } catch (e) {
      reportFallback("briefing", "habit_list_failed", String((e as Error)?.message ?? e).slice(0, 120));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    const title = form.title.trim();
    if (!title) return setFormError(t("settings.timeline_routine_title_required"));
    if (form.weekdayMask === 0) return setFormError(t("settings.timeline_routine_weekday_required"));
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) {
        await call("habit_update", {
          id: form.id,
          title,
          weekday_mask: form.weekdayMask,
          icon: form.icon ?? undefined,
          hue: form.hue ?? undefined,
          time_of_day: form.timeOfDay,
        });
      } else {
        await call("habit_create", { title, weekday_mask: form.weekdayMask, time_of_day: form.timeOfDay });
      }
      if (!alive.current) return;
      setForm(null);
      await load();
    } catch {
      /* call() 이 토스트를 띄웠다 — 폼은 열어 둔 채 입력을 지킨다 */
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const remove = async (h: Habit) => {
    const prev = habits;
    setHabits(prev.filter((x) => x.id !== h.id));
    try {
      await call("habit_delete", { id: h.id });
    } catch {
      if (alive.current) setHabits(prev); // 롤백 — call() 이 이미 토스트를 띄웠다
    }
  };

  const move = async (i: number, d: -1 | 1) => {
    const prev = habits;
    const next = [...prev];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setHabits(next);
    try {
      await call("habit_reorder", { ids: next.map((x) => x.id) });
    } catch {
      if (alive.current) setHabits(prev);
    }
  };

  const openNew = () => {
    setForm(NEW_FORM);
    setFormError(null);
  };
  const closeForm = () => setForm(null);

  // 딥링크 habits_add — 추가 폼을 1회 연다(패널이 앵커를 지우므로 닫은 폼은 다시 안 열린다).
  useSettingsAnchorOnce("habits_add", openNew);

  return (
    <TableSection
      anchor="habits"
      data-testid="briefing-habits-section"
      title={t("settings.briefing_habits_section")}
      hint={t("settings.briefing_habits_hint")}
      icon={<IconSmile size={14} strokeWidth={2} />}
      actions={
        <IconAction
          icon={<IconPlus size={16} strokeWidth={1.8} />}
          label={t("settings.briefing_habit_add")}
          id={anchorId("habits_add")}
          data-testid="habit-add-btn"
          onClick={openNew}
        />
      }
    >
      <SettingsTable
        columns="minmax(140px, 1.4fr) minmax(120px, 1fr) 72px 112px"
        isEmpty={habits.length === 0}
        emptyText={t("settings.briefing_habits_empty")}
        bodyTestId="habit-list"
        header={
          <>
            <div>{t("settings.timeline_routine_title_label")}</div>
            <div>{t("settings.timeline_routine_weekday_label")}</div>
            <div>{t("settings.briefing_habit_time_label")}</div>
            <div style={{ textAlign: "right" }}>{t("settings.collect_table_actions")}</div>
          </>
        }
      >
        {habits.map((h, i) => (
          <SettingsTableRow key={h.id} isLast={i === habits.length - 1} data-testid={`habit-row-${h.id}`}>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {h.title}
            </span>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              {h.weekday_mask === ALL_DAYS
                ? t("settings.briefing_habit_every_day")
                : weekdayLabels.filter((_, b) => (h.weekday_mask & (1 << b)) !== 0).join(" ")}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              {t(TOD_LABEL[asTimeOfDay(h.time_of_day)])}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" }}>
              <IconAction
                icon={<IconArrowUp size={14} />}
                label={t("settings.briefing_move_up")}
                size="sm"
                disabled={i === 0}
                data-testid={`habit-up-${h.id}`}
                onClick={() => void move(i, -1)}
              />
              <IconAction
                icon={<IconArrowDown size={14} />}
                label={t("settings.briefing_move_down")}
                size="sm"
                disabled={i === habits.length - 1}
                data-testid={`habit-down-${h.id}`}
                onClick={() => void move(i, 1)}
              />
              <IconAction
                icon={<IconEdit size={14} strokeWidth={1.8} />}
                label={t("settings.timeline_routine_edit")}
                size="sm"
                data-testid={`habit-edit-${h.id}`}
                onClick={() => {
                  setForm({
                    id: h.id,
                    title: h.title,
                    weekdayMask: h.weekday_mask,
                    icon: h.icon,
                    hue: h.hue,
                    timeOfDay: asTimeOfDay(h.time_of_day),
                  });
                  setFormError(null);
                }}
              />
              <IconAction
                icon={<IconTrash size={14} strokeWidth={1.8} />}
                label={t("common.delete")}
                size="sm"
                danger
                data-testid={`habit-delete-${h.id}`}
                onClick={() => setPendingDelete(h)}
              />
            </div>
          </SettingsTableRow>
        ))}
      </SettingsTable>

      {form && (
        <ModalShell
          title={form.id ? t("settings.briefing_habit_edit_title") : t("settings.briefing_habit_add_title")}
          onClose={closeForm}
          // 저장 중엔 Escape·바깥 클릭으로 닫히지 않는다(취소 버튼도 꺼진다).
          busy={saving}
          width={440}
          footer={
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
              <button type="button" className="btn" onClick={closeForm} disabled={saving}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="habit-form-save-btn"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? t("note.saving") : t("common.save")}
              </button>
            </div>
          }
        >
          <FormStack>
            <FormField label={t("settings.timeline_routine_title_label")}>
              <input
                type="text"
                className="field"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                data-testid="habit-title-input"
                autoFocus
              />
            </FormField>
            <WeekdayMaskField
              label={t("settings.timeline_routine_weekday_label")}
              labels={weekdayLabels}
              mask={form.weekdayMask}
              onToggle={(bit) => setForm({ ...form, weekdayMask: form.weekdayMask ^ bit })}
              testIdPrefix="habit-weekday-"
            />
            <FormField as="div" label={t("settings.briefing_habit_time_label")}>
              <Select
                value={form.timeOfDay}
                onChange={(v) => setForm({ ...form, timeOfDay: asTimeOfDay(v) })}
                ariaLabel={t("settings.briefing_habit_time_label")}
                testid="habit-time-select"
                options={TIMES_OF_DAY.map((v) => ({ value: v, label: t(TOD_LABEL[v]) }))}
              />
            </FormField>
            {formError && <FormError data-testid="habit-form-error">{formError}</FormError>}
          </FormStack>
        </ModalShell>
      )}

      {pendingDelete && (
        <PromptDialog
          title={t("settings.briefing_habit_delete_title")}
          description={t("settings.briefing_habit_delete_confirm", { name: pendingDelete.title })}
          mode="confirm"
          danger
          confirmLabel={t("common.delete")}
          onCancel={() => setPendingDelete(null)}
          onSubmit={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void remove(target);
          }}
        />
      )}
    </TableSection>
  );
}
