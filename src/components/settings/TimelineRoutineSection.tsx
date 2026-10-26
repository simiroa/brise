import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../../lib/invoke";
import { t } from "../../i18n/t";
import { TableSection } from "./TableSection";
import { SettingsTable, SettingsTableRow } from "./SettingsTable";
import { Badge } from "./Badge";
import { IconClock, IconEdit, IconEraser, IconPalette, IconPlus, IconTrash } from "../icons";
import { IconAction } from "./IconAction";
import { FormError, FormField, FormStack, FormToggleRow, WeekdayMaskField } from "./FormField";
import { ModalShell } from "../ModalShell";
import { PromptDialog } from "../PromptDialog";
import { folderColorCss } from "../../lib/ui";
import { weekdayShortLabels } from "../home/dateFmt";
import { bumpTimelineRoutineVersion } from "../../lib/timelineRoutines";
import { useSettingsStore } from "../../stores/settings";
import type { TimelineRoutine, TimelineRoutineListOutput } from "../../lib/commands.gen";

/**
 * 시간축 배경 루틴(그릴 2026-09-13 W3) — 노트에 안 묶이는 "출퇴근"류 매주 반복 일정을 Settings에서
 * 등록한다. 저장은 `timeline_routines` 테이블(specs/db/schemas/timeline_routines.sql) 하나이고,
 * `DayDetailPanel.tsx` 의 시간축이 요일이 맞는 행만 배경 띠로 그린다(v1: 클릭·드래그 없음).
 *
 * **`repo::routine`/캔버스 위젯의 습관 체크트래커와 이름이 비슷하지만 다른 기능이다** — 혼동 금지
 * (CLAUDE.md, specs/commands/timeline_routines.yaml 헤더).
 *
 * 목록은 노트북마다 따로라 활성 노트북이 바뀌면 다시 읽는다(늦게 온 옛 노트북 응답은 버린다).
 * 표 블록(TableSection) + 우측 상단 "+"(ModalShell 폼). 삭제는 묻는다 — 지운 뒤 다시 만들면 순서가
 * 맨 뒤로 가서 되돌리기 토스트로는 원래 자리를 못 돌려준다. 저장 실패는 call() 토스트 하나로 알리고,
 * 폼 안의 오류 줄은 클라이언트 검증 문구만 보여준다.
 */

/** weekday_mask 는 비트0=월..비트6=일(ISO 순서) 고정 — 사용자의 weekStart 설정과 무관하다
 *  (specs/db/schemas/timeline_routines.sql 헤더). 그래서 요일 토글은 항상 "monday" 순서로 그려
 *  저장 순서와 화면 순서가 절대 어긋나지 않는다. */
function isoWeekdayLabels(uiLang: string): string[] {
  return weekdayShortLabels(uiLang, "monday");
}

/** 월~금(비트0..4) — 가장 흔한 기본값("출퇴근"). */
const DEFAULT_WEEKDAY_MASK = 0b0011111;

interface RoutineFormState {
  id?: string;
  title: string;
  weekdayMask: number;
  startTime: string;
  endTime: string;
  hasColor: boolean;
  colorHue: number;
  skipHolidays: boolean;
}

const DEFAULT_FORM: RoutineFormState = {
  title: "",
  weekdayMask: DEFAULT_WEEKDAY_MASK,
  startTime: "09:00",
  endTime: "18:00",
  hasColor: false,
  colorHue: 200,
  skipHolidays: false,
};

/** 폼 → 오류 문구(없으면 null). 자정 넘김(22:00–06:00)은 서버가 거부하므로(v1 미지원, 스펙 헤더)
 *  "시각이 거꾸로" 대신 둘로 나누라고 말해 준다. */
function validateRoutineForm(f: RoutineFormState): string | null {
  if (!f.title.trim()) return t("settings.timeline_routine_title_required");
  if (f.weekdayMask === 0) return t("settings.timeline_routine_weekday_required");
  if (!f.startTime || !f.endTime || f.endTime === f.startTime) return t("settings.timeline_routine_time_order_invalid");
  if (f.endTime < f.startTime) {
    return t("settings.timeline_routine_overnight_unsupported", { start: f.startTime, end: f.endTime });
  }
  return null;
}

export function TimelineRoutineSection() {
  const uiLang = useSettingsStore((s) => s.uiLang) || "en";
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const weekdayLabels = isoWeekdayLabels(uiLang);

  const [routines, setRoutines] = useState<TimelineRoutine[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [formState, setFormState] = useState<RoutineFormState>(DEFAULT_FORM);
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TimelineRoutine | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** 마지막으로 보낸 조회 번호 — 노트북을 빠르게 바꿀 때 늦게 온 옛 응답이 새 목록을 덮지 않게. */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await call<TimelineRoutineListOutput>(
        "timeline_routine_list",
        workspaceId ? { workspace_id: workspaceId } : {},
      );
      if (alive.current && seq === loadSeq.current) setRoutines(r.routines ?? []);
    } catch {
      /* call() 이 토스트를 띄웠다 — 목록은 그대로 둔다 */
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreateForm = () => {
    setFormState(DEFAULT_FORM);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (r: TimelineRoutine) => {
    setFormState({
      id: r.id,
      title: r.title,
      weekdayMask: r.weekday_mask,
      startTime: r.start_time,
      endTime: r.end_time,
      hasColor: r.color_hue != null,
      colorHue: r.color_hue ?? 200,
      skipHolidays: r.skip_holidays,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const toggleWeekday = (bit: number) => {
    setFormState((prev) => ({ ...prev, weekdayMask: prev.weekdayMask ^ bit }));
  };

  const saveForm = async () => {
    const invalid = validateRoutineForm(formState);
    if (invalid) {
      setFormError(invalid);
      return;
    }

    setFormSaving(true);
    setFormError(null);
    const colorHue = formState.hasColor ? formState.colorHue : null;
    try {
      if (formState.id) {
        await call("timeline_routine_update", {
          id: formState.id,
          title: formState.title.trim(),
          weekday_mask: formState.weekdayMask,
          start_time: formState.startTime,
          end_time: formState.endTime,
          color_hue: colorHue,
          skip_holidays: formState.skipHolidays,
        });
      } else {
        await call("timeline_routine_create", {
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
          title: formState.title.trim(),
          weekday_mask: formState.weekdayMask,
          start_time: formState.startTime,
          end_time: formState.endTime,
          color_hue: colorHue,
          skip_holidays: formState.skipHolidays,
        });
      }
      if (!alive.current) return;
      setFormOpen(false);
      await load();
      bumpTimelineRoutineVersion();
    } catch {
      /* call() 이 토스트를 띄웠다 — 폼은 열어 둔 채 입력을 지킨다 */
    } finally {
      if (alive.current) setFormSaving(false);
    }
  };

  const deleteRoutine = async (r: TimelineRoutine) => {
    try {
      await call("timeline_routine_delete", { id: r.id });
      await load();
      bumpTimelineRoutineVersion();
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  const closeForm = () => setFormOpen(false);

  return (
    <TableSection
      anchor="routines"
      data-testid="settings-timeline-routine-section"
      title={t("settings.timeline_routine_section")}
      hint={t("settings.timeline_routine_section_hint")}
      icon={<IconClock size={14} strokeWidth={2} />}
      actions={
        <IconAction
          icon={<IconPlus size={16} strokeWidth={1.8} />}
          label={t("settings.timeline_routine_add")}
          data-testid="timeline-routine-add-btn"
          onClick={openCreateForm}
        />
      }
    >
      <SettingsTable
        columns="minmax(140px, 1.4fr) minmax(160px, 1fr) 72px"
        isEmpty={routines.length === 0}
        emptyText={t("settings.timeline_routine_empty")}
        bodyTestId="timeline-routine-list"
        header={
          <>
            <div>{t("settings.timeline_routine_title_label")}</div>
            <div>{t("settings.timeline_routine_weekday_label")}</div>
            <div style={{ textAlign: "right" }}>{t("settings.collect_table_actions")}</div>
          </>
        }
      >
        {routines.map((r, idx) => {
          const activeLabels = weekdayLabels.filter((_, i) => (r.weekday_mask & (1 << i)) !== 0);
          return (
            <SettingsTableRow key={r.id} isLast={idx === routines.length - 1} data-testid={`timeline-routine-row-${r.id}`}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
                <span
                  aria-hidden="true"
                  style={{
                    flex: "none",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: r.color_hue != null ? folderColorCss(r.color_hue) : "var(--faint)",
                  }}
                />
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.title}
                </span>
                {r.skip_holidays && (
                  <span data-testid={`timeline-routine-skip-badge-${r.id}`}>
                    <Badge tone="neutral">{t("settings.routine_badge_skip_holidays")}</Badge>
                  </span>
                )}
              </div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                {activeLabels.join(" ")} · {r.start_time}–{r.end_time}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" }}>
                <IconAction
                  icon={<IconEdit size={14} strokeWidth={1.8} />}
                  label={t("settings.timeline_routine_edit")}
                  size="sm"
                  data-testid={`timeline-routine-edit-${r.id}`}
                  onClick={() => openEditForm(r)}
                />
                <IconAction
                  icon={<IconTrash size={14} strokeWidth={1.8} />}
                  label={t("common.delete")}
                  size="sm"
                  danger
                  data-testid={`timeline-routine-delete-${r.id}`}
                  onClick={() => setPendingDelete(r)}
                />
              </div>
            </SettingsTableRow>
          );
        })}
      </SettingsTable>

      {formOpen && (
        <ModalShell
          title={formState.id ? t("settings.timeline_routine_edit_title") : t("settings.timeline_routine_add_title")}
          onClose={closeForm}
          // 저장 중엔 Escape·바깥 클릭으로 닫히지 않는다(취소 버튼도 꺼진다).
          busy={formSaving}
          width={480}
          footer={
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
              <button
                type="button"
                className="btn"
                data-testid="timeline-routine-form-cancel-btn"
                onClick={closeForm}
                disabled={formSaving}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="timeline-routine-form-save-btn"
                onClick={() => void saveForm()}
                disabled={formSaving}
              >
                {formSaving ? t("note.saving") : t("common.save")}
              </button>
            </div>
          }
        >
          <FormStack>
            <FormField label={t("settings.timeline_routine_title_label")}>
              <input
                type="text"
                className="field"
                value={formState.title}
                onChange={(e) => setFormState((p) => ({ ...p, title: e.target.value }))}
                data-testid="timeline-routine-title-input"
                autoFocus
              />
            </FormField>

            <WeekdayMaskField
              label={t("settings.timeline_routine_weekday_label")}
              labels={weekdayLabels}
              mask={formState.weekdayMask}
              onToggle={toggleWeekday}
              testIdPrefix="timeline-routine-weekday-"
            />

            <div style={{ display: "flex", gap: "var(--space-5)" }}>
              <FormField label={t("settings.timeline_routine_start_label")} style={{ flex: 1 }}>
                <input
                  type="time"
                  className="field"
                  value={formState.startTime}
                  onChange={(e) => setFormState((p) => ({ ...p, startTime: e.target.value }))}
                  data-testid="timeline-routine-start-input"
                />
              </FormField>
              <FormField label={t("settings.timeline_routine_end_label")} style={{ flex: 1 }}>
                <input
                  type="time"
                  className="field"
                  value={formState.endTime}
                  onChange={(e) => setFormState((p) => ({ ...p, endTime: e.target.value }))}
                  data-testid="timeline-routine-end-input"
                />
              </FormField>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-5)" }}>
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  border: "1px solid var(--divider)",
                  background: formState.hasColor ? folderColorCss(formState.colorHue) : "var(--faint)",
                }}
              />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--muted)",
                    fontWeight: 600,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>
                    {t("settings.timeline_routine_color_label")} ({formState.hasColor ? `${formState.colorHue}°` : "—"})
                  </span>
                  {/* 상태에 따라 라벨·아이콘이 함께 바뀐다(PLAN-2026-09-19-settings-icon-actions §2). */}
                  <IconAction
                    icon={formState.hasColor ? <IconEraser size={14} /> : <IconPalette size={14} />}
                    label={
                      formState.hasColor
                        ? t("settings.timeline_routine_color_clear")
                        : t("settings.timeline_routine_color_use")
                    }
                    size="sm"
                    onClick={() => setFormState((p) => ({ ...p, hasColor: !p.hasColor }))}
                    data-testid="timeline-routine-color-toggle"
                  />
                </span>
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={formState.colorHue}
                  disabled={!formState.hasColor}
                  aria-label={t("settings.timeline_routine_color_label")}
                  onChange={(e) =>
                    setFormState((p) => ({ ...p, hasColor: true, colorHue: parseInt(e.target.value, 10) }))
                  }
                  data-testid="timeline-routine-color-slider"
                  style={{
                    width: "100%",
                    height: 6,
                    borderRadius: 3,
                    cursor: formState.hasColor ? "pointer" : "not-allowed",
                    accentColor: formState.hasColor ? folderColorCss(formState.colorHue) : "var(--faint)",
                    background: "var(--line)",
                  }}
                />
              </div>
            </div>

            <FormToggleRow
              label={t("settings.timeline_routine_skip_holidays")}
              checked={formState.skipHolidays}
              onChange={(next) => setFormState((p) => ({ ...p, skipHolidays: next }))}
              data-testid="timeline-routine-skip-holidays"
            />

            {formError && <FormError data-testid="timeline-routine-form-error">{formError}</FormError>}
          </FormStack>
        </ModalShell>
      )}

      {pendingDelete && (
        <PromptDialog
          title={t("settings.timeline_routine_delete_title")}
          description={t("settings.timeline_routine_delete_confirm", { name: pendingDelete.title })}
          mode="confirm"
          danger
          confirmLabel={t("common.delete")}
          onCancel={() => setPendingDelete(null)}
          onSubmit={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void deleteRoutine(target);
          }}
        />
      )}
    </TableSection>
  );
}
