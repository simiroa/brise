/**
 * 시간축 칩의 일정 수정 모달 — 칩의 ⚙ 버튼 또는 롱프레스가 연다. 예전의 칩 아래 플로팅 메뉴(ChipSchedule)를 대체한다.
 *
 * 구조(제목 · 날짜/시작/종료 · 종일 · 반복 · 푸터 좌측 삭제 / 우측 취소·저장)는 kargulstudio/calender-app-design 의
 * 일정 생성 모달(event-dialog.tsx)에서 차용했다. 코드는 우리 토큰·ModalShell·Toggle 로 다시 썼다.
 * Based on "calender-app-design" (event-dialog.tsx) — Copyright (c) 2026 Kargul Studio, MIT License.
 *
 * **쓰기는 새로 만들지 않는다**: 제목은 renameNote, 날짜·시각은 commitDateRow 한 번(되돌리기 토스트 하나), 반복은 칩 메뉴 시절과
 * 같은 onRepeatApply(→ 확인 다이얼로그 → resolveRepeatApply, 사후 판정 포함), 삭제는 축의 Delete 키와 같은 확인 흐름이다.
 *
 * 뺀 것: 색(칩 색은 폴더 색상이고 일정별 색 필드가 없다) · 장소 · 메모(그런 컬럼이 없다) · 복제(노트 복제는 일정 복제가 아니다).
 * 날짜·시각 입력은 네이티브 `type=date/time` 이 아니라 텍스트다 — 24시제와 로케일 표기가 갈리고 OS 달력이 앱 달력 위에 또
 * 뜨기 때문이다(titlebar/eventDate.ts parseTimeInput 주석). 날짜 모델 개편(PLAN-2026-10-27-date-model) 때 이 한 곳의
 * `dateText` ↔ moveRowToDay 만 바꾸면 된다.
 */
import { useState } from "react";
import type { CalendarItem } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { ModalShell } from "../../ModalShell";
import { Select, type SelectOption } from "../../Select";
import { Toggle } from "../../settings/Toggle";
import { IconTrash } from "../../icons";
import { renameNote } from "../../../lib/noteActions";
import { formatEventDate, parseEventDateInput, parseTimeInput, toDateInputValue } from "../../titlebar/eventDate";
import {
  buildRrule,
  parseRruleForUi,
  REPEAT_OPTIONS,
  type RepeatDraft,
  type RepeatFreq,
} from "../../titlebar/scheduleRrule";
import { DAY_MIN, formatHhmm, parseHhmm, rawStartIso, rowIsSameDay } from "../calendarLayout";
import { ByDayButtons } from "../../titlebar/ByDayButtons";
import { commitDateRow, moveRowToDay, timeChangeLabel } from "./dateWrite";

export interface ChipEventModalProps {
  item: CalendarItem;
  uiLang: string;
  onClose: () => void;
  /** 반복이 바뀌었을 때만 — 모달은 이미 닫혔다(모달 위 모달 금지). 확인 → 저장은 축의 기존 흐름이다. */
  onRepeatApply: (draft: RepeatDraft) => void;
  /** 삭제 — 모달을 닫은 뒤 축의 확인 다이얼로그(deleteEvent / deleteRepeat)를 부른다. */
  onDelete: () => void;
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "var(--space-3)" };
const labelStyle: React.CSSProperties = { fontSize: "var(--text-sm)", color: "var(--muted)" };

export function ChipEventModal({ item, uiLang, onClose, onRepeatApply, onDelete }: ChipEventModalProps) {
  // 하루짜리가 아니면 종료 시각·날짜를 고치지 않는다 — 여러 날 span 의 end_time 은 마지막 날의 것이다(§1.3 I3).
  const sameDay = rowIsSameDay(item);
  const canMoveDay = sameDay && !item.rrule;
  const [title, setTitle] = useState(item.title);
  // 행의 **진짜 시작일** — span_start 는 월 경계에서 매달 1일로 잘린 값이라 시작일로 쓰면 안 된다(calendarLayout::rawStartIso).
  const startIso = rawStartIso(item) ?? item.span_start;
  const [dateText, setDateText] = useState(() => {
    const [y, m, d] = startIso.split("-").map(Number);
    return formatEventDate(y, m, d);
  });
  const [allDay, setAllDay] = useState(item.start_time === null);
  const [startText, setStartText] = useState(item.start_time ?? "");
  const [endText, setEndText] = useState(item.end_time ?? "");
  const [repeat, setRepeat] = useState<RepeatDraft>(() => parseRruleForUi(item.rrule));
  const [busy, setBusy] = useState(false);

  const start = allDay ? null : parseTimeInput(startText);
  const end = allDay || !sameDay || endText.trim() === "" ? null : parseTimeInput(endText);
  const date = parseEventDateInput(dateText);
  const dateOk = !canMoveDay || (date !== null && date.month !== null && date.day !== null);
  const startOk = allDay || start !== null;
  const endBad = !allDay && sameDay && endText.trim() !== "" && end === null;
  // 종료 <= 시작 — 레퍼런스의 "End time must be after the start time." 규칙. 자정을 넘기는 끝은 저장 쪽(I3)이 따로 다룬다.
  const orderBad = start !== null && end !== null && (parseHhmm(end) ?? 0) <= (parseHhmm(start) ?? 0);
  const error = !dateOk
    ? t("home.cal_event_err_date")
    : !startOk || endBad
      ? t("home.cal_event_err_time")
      : orderBad
        ? t("home.cal_event_err_order")
        : null;

  /** 시작을 고치면 끝이 길이를 지키며 따라간다(레퍼런스의 "시작 시 종료 자동 이동"). 끝이 비어 있으면 그대로 둔다. */
  const changeStart = (text: string) => {
    const before = parseTimeInput(startText);
    const next = parseTimeInput(text);
    const curEnd = parseTimeInput(endText);
    setStartText(text);
    if (before === null || next === null || curEnd === null) return;
    const len = (parseHhmm(curEnd) ?? 0) - (parseHhmm(before) ?? 0);
    const moved = (parseHhmm(next) ?? 0) + len;
    if (len > 0 && moved < DAY_MIN) setEndText(formatHhmm(moved));
  };

  const save = async () => {
    if (error || busy) return;
    setBusy(true);
    try {
      const trimmed = title.trim();
      if (trimmed && trimmed !== item.title) await renameNote(item.note_id, trimmed);
      const iso = canMoveDay && date ? toDateInputValue(date.year, date.month, date.day) || null : null;
      const nextStart = allDay ? null : start;
      const nextEnd = allDay ? null : end;
      const moveDay = iso !== null && iso !== startIso;
      const changed =
        moveDay ||
        nextStart !== item.start_time ||
        (sameDay && nextEnd !== (item.end_time ?? null));
      if (changed) {
        // commitDateRow 는 throw 하지 않고 실패·행 없음에 false 를 돌려준다 — 안 보고 닫으면 입력이 사라진다.
        const ok = await commitDateRow(
          item.note_id,
          item.date_id,
          (r) => ({
            start_time: nextStart,
            // 끝은 하루짜리 DB 행에만 쓴다(화면 항목이 아니라 행이 판정 — 함정 ⓑ).
            ...(rowIsSameDay(r) ? { end_time: nextEnd } : {}),
            ...(moveDay && iso ? (moveRowToDay(r, iso) ?? {}) : {}),
          }),
          // W15 ③ — 시각이 바뀌었으면 토스트에 이전 → 이후가 들어간다(날짜만 옮겼으면 고정 문구).
          nextStart !== item.start_time
            ? timeChangeLabel(item.start_time, nextStart)
            : sameDay && nextEnd !== (item.end_time ?? null)
              ? timeChangeLabel(item.end_time, nextEnd)
              : t("home.cal_time_changed"),
        );
        if (!ok) {
          // 저장 실패·행 없음 — 열어 둔다(입력을 잃지 않는다). 쓰기 실패 토스트는 commitDateRow 안의 call() 이 이미 띄웠다.
          setBusy(false);
          return;
        }
      }
      const draftRrule = buildRrule(repeat);
      onClose();
      if (draftRrule !== (item.rrule ?? null)) onRepeatApply(repeat);
    } catch {
      // 실패하면 열어 둔다 — 입력을 잃지 않는다. renameNote 의 call() 이 이미 토스트로 알렸다.
      setBusy(false);
    }
  };

  // ModalShell 은 포털이지만 React 이벤트는 트리를 따라 올라간다 — 모달 안의 포인터·클릭이 축(빈 곳 드래그 = 새 일정)이나 칩으로
  // 새지 않도록 여기서 한 번에 끊는다. keydown 은 끊지 않는다(Escape 는 window 리스너가 받아야 한다).
  const stop = (ev: React.SyntheticEvent) => ev.stopPropagation();
  return (
    <div style={{ display: "contents" }} onPointerDown={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
    <ModalShell
      title={t("home.cal_event_edit")}
      width={440}
      busy={busy}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <button
            type="button"
            className="btn btn-icon"
            data-testid="cal-event-delete"
            aria-label={t("common.delete")}
            title={t("common.delete")}
            disabled={busy}
            onClick={() => {
              onClose();
              onDelete();
            }}
            style={{ color: "var(--danger)" }}
          >
            <IconTrash size={15} />
          </button>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <button type="button" className="btn" data-testid="cal-event-cancel" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="cal-event-save"
              disabled={busy || error !== null}
              onClick={() => void save()}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      }
    >
      <form
        data-testid="cal-event-modal"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={labelStyle}>{t("home.cal_event_title")}</span>
          <input
            className="field"
            data-testid="cal-event-title"
            autoFocus
            value={title}
            placeholder={t("note.untitled_note")}
            onChange={(ev) => setTitle(ev.target.value)}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: "var(--space-3)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={labelStyle}>{t("home.cal_event_date")}</span>
            <input
              className="field"
              data-testid="cal-event-date"
              inputMode="numeric"
              placeholder="YYYY.MM.DD"
              disabled={!canMoveDay}
              value={dateText}
              onChange={(ev) => setDateText(ev.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={labelStyle}>{t("editor.time_start")}</span>
            <input
              className="field"
              data-testid="cal-event-start"
              inputMode="numeric"
              placeholder="00:00"
              disabled={allDay}
              value={startText}
              onChange={(ev) => changeStart(ev.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={labelStyle}>{t("editor.time_end")}</span>
            <input
              className="field"
              data-testid="cal-event-end"
              inputMode="numeric"
              placeholder="00:00"
              disabled={allDay || !sameDay}
              value={endText}
              onChange={(ev) => setEndText(ev.target.value)}
            />
          </label>
        </div>
        {error && (
          <p role="alert" data-testid="cal-event-error" style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <div style={row}>
          <Toggle
            checked={allDay}
            aria-label={t("home.cal_event_all_day")}
            data-testid="cal-event-all-day"
            onChange={(next) => {
              setAllDay(next);
              // 종일을 풀면 비어 있는 시작에 자리표시용 시각을 넣지 않는다 — 사용자가 직접 적는다.
            }}
          />
          <span style={{ fontSize: "var(--text-md)" }}>{t("home.cal_event_all_day")}</span>
        </div>

        <RepeatFields value={repeat} onChange={setRepeat} uiLang={uiLang} />
      </form>
    </ModalShell>
    </div>
  );
}

/** 반복 입력 — RRULE 네 필드(freq/interval/byday/until)를 지역 초안으로 받는다(칩 메뉴 시절 ChipRepeatEditor 가 옮겨 온 것).
 *  종료일(UNTIL) 입력은 없다 — OS 달력이 앱 달력 위에 뜬다. 이미 저장된 UNTIL 은 parseRruleForUi → buildRrule 왕복으로 산다. */
function RepeatFields({
  value,
  onChange,
  uiLang,
}: {
  value: RepeatDraft;
  onChange: (next: RepeatDraft) => void;
  uiLang: string;
}) {
  const options: SelectOption[] = REPEAT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={labelStyle}>{t("editor.repeat")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}>
        <Select
          value={value.freq}
          onChange={(v) => onChange({ ...value, freq: v as RepeatFreq })}
          options={options}
          ariaLabel={t("editor.repeat")}
          testid="cal-event-repeat"
        />
        {value.freq !== "none" && (
          <input
            type="number"
            min={1}
            max={999}
            className="field"
            data-testid="cal-event-interval"
            value={value.interval}
            onChange={(ev) => onChange({ ...value, interval: ev.target.value })}
            style={{ width: "6ch", flex: "none" }}
          />
        )}
        {value.freq === "WEEKLY" && (
          <ByDayButtons
            byday={value.byday}
            onChange={(byday) => onChange({ ...value, byday })}
            uiLang={uiLang}
            testIdPrefix="cal-event-byday"
          />
        )}
      </div>
    </div>
  );
}
