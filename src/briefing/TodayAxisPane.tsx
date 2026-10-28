/**
 * 브리핑 왼쪽 열 — 오늘의 **쓰는** 세로 시간축(PLAN-2026-10-19 §4). 축은 새로 만들지 않는다: 대시보드 달력의
 * 하루 축(calendar/DayAxis.tsx 의 TimeAxis)을 그대로 마운트하고, 쓰기는 달력과 같은 길을 지난다
 * (옮기기·늘리기·키보드 = commitDateRow, Delete = removeDateRow, 반복 회차 = useAxisConfirmFlow 확인,
 * 종일 칩을 축으로 = AllDayStrip 의 planAllDayDrop). 반복 루틴은 읽기 전용 배경 띠.
 *
 * 이 창에서 새로 하는 일은 **만들기** 하나다(§4.1): 빈 시간을 끌어 놓으면(또는 `N`·"＋ 일정") 그 자리에 임시
 * 일정 + 제목칸이 뜨고, Enter(IME 조합 중 아님) 때만 briefing_block_create 한 번으로 받은편지함 노트를 만든다.
 * 제목 없이는 아무것도 쓰지 않는다 — Esc·빈 채 포커스 이탈 = 취소(쓰기 0). 프런트 createNoteForRange 를 쓰지
 * 않는 이유는 §2.4 ①②(이 창은 트리를 안 실어 받은편지함을 중복 생성하고, 두 단계라 반쪽 노트가 남는다).
 *
 * 날짜 이동(§12.1 Q2): ‹ 날짜 › · 오늘 · 가로 쓸어넘기기(트랙패드 가로 휠·터치) — `[`/`]` 는 창 전체 단축키라
 * BriefingWindowApp 이 갖는다. 쓸어넘기기는 가로 성분이 클 때만, 가로로 구르는 영역(종일 칩 줄) 밖에서만.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../i18n/t";
import { call } from "../lib/invoke";
import { showUndoToast } from "../lib/undo";
import { useEscapeConsumer } from "../lib/overlayStack";
import { requestOpenNoteInMain } from "../lib/openNoteInMain";
import { useSettingsStore } from "../stores/settings";
import { clampStoredEndMin, formatHhmm, itemKey, planTimedDay } from "../components/home/calendarLayout";
import { TimeAxis } from "../components/home/calendar/DayAxis";
import { AllDayStrip, type AxisHandle } from "../components/home/calendar/AllDayStrip";
import { useAxisConfirmFlow, type DropPreviewState } from "../components/home/calendar/useAxisConfirmFlow";
import { AxisConfirmDialog } from "../components/home/calendar/AxisConfirmDialog";
import type { ChipChecklist } from "../components/home/calendar/TimeChip";
import { IconCaret, IconPlus } from "../components/icons";
import type { BriefingBlockCreateOutput } from "../lib/commands.gen";
import { dayAfter, useBriefingWeather, useDayItems } from "./hooks/useBriefingData";
import { useRegionReady } from "./hooks/useRegionReady";
import { bumpScheduleVersion } from "./scheduleVersion";
import { CardStatus } from "./cards/CardShell";
import {
  createWheelSwipe,
  defaultDraftRange,
  hourlyCells,
  isTypingTarget,
  nudgeDraft,
  touchSwipeStep,
  type DraftRange,
} from "./dayNav";

// 칩 3행째(발췌)·체크리스트는 v1 에서 빈 맵 — 브리핑이 노트마다 note_get 을 부를 이유가 없다(§4.3). 칩은 2줄.
const NO_EXCERPTS: Record<string, string> = {};
const NO_CHECKLISTS: Record<string, ChipChecklist> = {};
const noop = () => {};

export interface BlockDraft extends DraftRange {
  day: string;
  title: string;
}

/** 이 요소에서 루트까지 가로로 구르는 조상이 있나 — 있으면 가로 휠·스와이프는 그 스크롤의 몫이다. */
function insideHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== root) {
    const ox = getComputedStyle(el).overflowX;
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth) return true;
    el = el.parentElement;
  }
  return false;
}

/** 새 일정 제목칸 — 임시 일정(축의 점선 미리보기)과 짝. Enter = 만들기, ↑/↓ = 시작 15분, Shift+↑/↓ = 끝 15분. */
function DraftRow({
  draft,
  saving,
  onTitle,
  onNudge,
  onSubmit,
  onCancel,
}: {
  draft: BlockDraft;
  saving: boolean;
  onTitle: (title: string) => void;
  onNudge: (part: "start" | "end", dir: 1 | -1) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // 처음 뜰 때만이 아니라 — 초안이 떠 있는 채 빈 시간을 다시 끌어 범위를 바꾸면(축을 누르는 순간 칸이 포커스를
  // 잃는다) 그리고 저장 실패로 칸이 다시 풀리면(disabled 동안 포커스가 빠진다) 다시 칸으로 돌아와야 Enter 가 산다.
  useEffect(() => {
    if (!saving) ref.current?.focus();
  }, [draft.startMin, draft.endMin, saving]);
  const range = `${formatHhmm(draft.startMin)}–${formatHhmm(draft.endMin)}`;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // 조합 중 Enter 는 글자 확정이다(저장소 관례 — PlaceSearch.tsx). 만들기로 보지 않는다.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onNudge(e.shiftKey ? "end" : "start", e.key === "ArrowUp" ? -1 : 1);
    }
  };
  return (
    <div className="brf-draft" data-testid="brf-draft">
      <span className="brf-draft-range" aria-hidden>
        {range}
      </span>
      <input
        ref={ref}
        className="brf-draft-input"
        data-testid="brf-draft-input"
        value={draft.title}
        disabled={saving}
        placeholder={t("briefing.draft_placeholder")}
        aria-label={t("briefing.draft_aria", { range })}
        onChange={(e) => onTitle(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!draft.title.trim() && !saving) onCancel();
        }}
      />
      <span className="brf-draft-hint">{t("briefing.draft_hint")}</span>
    </div>
  );
}

export function TodayAxisPane({
  day,
  todayIso,
  nowMin,
  onStep,
  onToday,
}: {
  day: string;
  todayIso: string;
  nowMin: number;
  onStep: (dir: 1 | -1) => void;
  onToday: () => void;
}) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const regionReady = useRegionReady();
  const { status, data, reload } = useDayItems(day);
  const plan = useMemo(() => planTimedDay(data?.items ?? [], day), [data, day]);
  // 시간축 익일 구간 — 설정은 달력과 같은 값(calendar_axis_tail_hours), 데이터는 useDayItems 가 이미 읽은 다음 날의 달이다.
  const tailHours = useSettingsStore((s) => s.calendarAxisTailHours);
  const tailPlan = useMemo(
    () => (tailHours > 0 && data ? planTimedDay(data.nextItems, dayAfter(day, 1)) : null),
    [data, day, tailHours],
  );
  // 시간별 날씨(오늘만, 지금부터 3시간 간격) — 축의 시 눈금 라벨 아래에 얹는다. 시(時)가 바뀔 때만 새 Map 이라 HourRuler memo 가 산다.
  const { data: weather } = useBriefingWeather();
  const nowHour = Math.floor(nowMin / 60);
  const hourWeather = useMemo(
    () =>
      regionReady && day === todayIso
        ? new Map(hourlyCells(weather?.hourly ?? null, nowHour).map((c) => [c.hour, { code: c.code, tempC: c.tempC }]))
        : undefined,
    [regionReady, day, todayIso, weather, nowHour],
  );
  const axisHandle = useRef<AxisHandle>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);

  // 종일 칩 → 축 드롭의 미리보기(DayDetailBody 와 같은 상태). 새 데이터가 오면 버린다 — 그때부터 plan 이 진실이다.
  const [dropPreview, setDropPreview] = useState<DropPreviewState | null>(null);
  useEffect(() => setDropPreview(null), [plan]);
  const confirmFlow = useAxisConfirmFlow({ selectedDay: day, plan, tailHours, tailPlan, setDropPreview });

  // ── 새 일정 초안 ──────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false); // Enter 연타·Enter 직후 blur 가 두 번 만들지 않게
  const [announce, setAnnounce] = useState("");
  useEffect(() => setDraft(null), [day]); // 다른 날로 넘어가면 초안은 버린다(쓰기 0)
  const cancelDraft = () => {
    if (!submitting.current) setDraft(null);
  };
  // Esc 는 창 닫기(AuxWindowChrome)보다 먼저 이 칸이 먹는다 — 소비 체인에 올린다(조합 중 Esc 는 체인이 무시).
  useEscapeConsumer(draft !== null, cancelDraft);

  const openDraft = (range: DraftRange) => setDraft({ day, title: draft?.title ?? "", ...range });
  const openKeyboardDraft = () => openDraft(defaultDraftRange(day, todayIso, nowMin));

  const submit = async () => {
    if (!draft || submitting.current) return;
    const title = draft.title.trim();
    if (!title) return; // 제목 없이는 쓰지 않는다 — 칸은 그대로 남아 입력을 기다린다.
    submitting.current = true;
    setSaving(true);
    const range = `${formatHhmm(draft.startMin)}–${formatHhmm(draft.endMin)}`;
    try {
      const res = await call<BriefingBlockCreateOutput>("briefing_block_create", {
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        day: draft.day,
        start_time: formatHhmm(draft.startMin),
        // 자정(1440)은 "00:00" 이 되어 start 보다 앞선다 — 달력과 같은 규칙(clampStoredEndMin)으로 23:59.
        end_time: formatHhmm(clampStoredEndMin(draft.endMin)),
        title,
      });
      setDraft(null);
      bumpScheduleVersion();
      setAnnounce(t("briefing.block_created_live", { range, title }));
      // 만든 직후 되돌리기 = 그 노트를 휴지통으로(§4.1 — 기존 휴지통 경로라 복원도 된다).
      showUndoToast(t("briefing.block_created", { title }), () => {
        void (async () => {
          try {
            await call("note_delete", { id: res.note_id });
            bumpScheduleVersion();
            setAnnounce(t("briefing.block_undone", { title }));
          } catch {
            // call() 이 이미 토스트·진단을 남겼다 — 노트는 그대로 남아 축에 계속 보인다(화면이 거짓말하지 않는다).
          }
        })();
      });
    } catch {
      // call() 이 토스트를 띄웠다. 아무것도 쓰이지 않았으니 초안을 그대로 두어 다시 시도하거나 Esc 로 접게 한다.
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  // ── 가로 쓸어넘기기 ──────────────────────────────────────────────────────────
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handle = createWheelSwipe((dir) => onStepRef.current(dir));
    // 네이티브 리스너 — React 합성 onWheel 은 passive 라 preventDefault 가 안 먹는다(DayAxis 의 확대와 같은 이유).
    const onWheel = (e: WheelEvent) => {
      if (insideHorizontalScroller(e.target, el)) return;
      if (handle(e)) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || isTypingTarget(e.target)) return;
    // 한글 자판에서도 같은 키(e.key 는 "ㅜ")가 되도록 물리 키(code)도 본다.
    if (e.code === "KeyN" || e.key === "n" || e.key === "N") {
      e.preventDefault();
      openKeyboardDraft();
    }
  };

  const tomorrow = dayAfter(todayIso, 1);
  const rel =
    day === todayIso ? t("briefing.day_today") : day === tomorrow ? t("briefing.day_tomorrow") : day === dayAfter(todayIso, -1) ? t("briefing.day_yesterday") : null;
  const label = new Intl.DateTimeFormat(uiLang || "en", { month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
  const timedCount = plan.timed.length;
  const ghost = draft ? { title: draft.title || t("briefing.draft_ghost"), startMin: draft.startMin } : dropPreview;
  const allDayItems = plan.allDay.filter((it) => !(dropPreview?.saving && dropPreview.key === itemKey(it)));

  return (
    <section
      ref={rootRef}
      className="card brf-card brf-today"
      data-testid="brf-today"
      aria-label={t("briefing.axis_aria", { day: label })}
      // 축의 빈 곳을 눌러도 포커스가 이 칸에 남아야 `N` 이 닿는다(그냥 section 이면 포커스가 body 로 빠진다).
      // -1 = 탭 순서에는 넣지 않는다 — 키보드 사용자는 안의 버튼·칩으로 들어온다.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onTouchStart={(e) => {
        const p = e.touches[0];
        touch.current =
          p && e.touches.length === 1 && rootRef.current && !insideHorizontalScroller(e.target, rootRef.current)
            ? { x: p.clientX, y: p.clientY, at: Date.now() }
            : null;
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        touch.current = null;
        const p = e.changedTouches[0];
        if (!start || !p) return;
        const dir = touchSwipeStep(p.clientX - start.x, p.clientY - start.y, Date.now() - start.at);
        if (dir) onStep(dir);
      }}
    >
      <div className="brf-nav">
        <button type="button" className="icon-btn" data-testid="brf-day-prev" aria-label={t("briefing.day_prev")} title={t("briefing.day_prev_hint")} onClick={() => onStep(-1)}>
          <IconCaret dir="left" size={18} />
        </button>
        <h2 className="brf-nav-day" data-testid="brf-day-label" aria-live="polite">
          {rel && <span className="brf-nav-rel">{rel}</span>}
          {label}
        </h2>
        <button type="button" className="icon-btn" data-testid="brf-day-next" aria-label={t("briefing.day_next")} title={t("briefing.day_next_hint")} onClick={() => onStep(1)}>
          <IconCaret dir="right" size={18} />
        </button>
        {day !== todayIso && (
          <button type="button" className="btn brf-nav-today" data-testid="brf-day-today" onClick={onToday}>
            {t("briefing.day_today")}
          </button>
        )}
        <button type="button" className="btn brf-nav-add" data-testid="brf-add" title={t("briefing.add_hint")} onClick={openKeyboardDraft}>
          <IconPlus size={14} aria-hidden />
          {t("briefing.add")}
        </button>
      </div>
      {draft && (
        <DraftRow
          draft={draft}
          saving={saving}
          onTitle={(title) => setDraft((d) => (d ? { ...d, title } : d))}
          onNudge={(part, dir) => setDraft((d) => (d ? { ...d, ...nudgeDraft(d, part, dir) } : d))}
          onSubmit={() => void submit()}
          onCancel={cancelDraft}
        />
      )}
      {status === "error" && <CardStatus status="error" onRetry={reload} />}
      <AllDayStrip
        items={allDayItems}
        hasAxis
        selectedDay={day}
        axisHandle={axisHandle}
        focusedNoteId={focusedNoteId}
        onFocus={setFocusedNoteId}
        onOpen={(id) => void requestOpenNoteInMain(id)}
        uiLang={uiLang}
        setDropPreview={setDropPreview}
        onRequestSpanDrop={confirmFlow.requestSpanDrop}
      />
      <TimeAxis
        handleRef={axisHandle}
        dropPreview={ghost}
        plan={plan}
        day={day}
        excerpts={NO_EXCERPTS}
        checklists={NO_CHECKLISTS}
        onToggleChecklistItem={noop}
        uiLang={uiLang}
        onCreateTimedNote={(d, startMin, endMin) => setDraft({ day: d, title: draft?.title ?? "", startMin, endMin })}
        onFocus={setFocusedNoteId}
        onOpen={(id) => void requestOpenNoteInMain(id)}
        focusedNoteId={focusedNoteId}
        searchHits={null}
        onRequestConfirm={confirmFlow.setConfirm}
        tailHours={tailHours}
        tailPlan={tailPlan}
        hourWeather={hourWeather}
        routines={data?.routines ?? []}
        toolbarHint={
          <span data-testid="brf-axis-hint">
            {timedCount > 0 ? t("briefing.axis_count", { n: timedCount }) : t("briefing.axis_empty_hint")}
          </span>
        }
      />
      <span className="brf-sr" aria-live="polite" data-testid="brf-live">
        {announce}
      </span>
      <AxisConfirmDialog
        confirm={confirmFlow.confirm}
        onResolveSpanDrop={confirmFlow.resolveSpanDrop}
        onResolveRepeatApply={confirmFlow.resolveRepeatApply}
        onResolveDeleteRepeat={confirmFlow.resolveDeleteRepeat}
        onResolveDeleteEvent={confirmFlow.resolveDeleteEvent}
        onCancel={confirmFlow.cancelConfirm}
      />
    </section>
  );
}
