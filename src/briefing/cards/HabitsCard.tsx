import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../../i18n/t";
import { folderColorCss } from "../../lib/ui";
import { useSettingsStore } from "../../stores/settings";
import type { HabitHistory, HabitWeek } from "../../lib/commands.gen";
import { useEscapeConsumer } from "../../lib/overlayStack";
import { habitNudge, todayHabitStats, type LoadStatus } from "../hooks/useBriefingData";
import { IconCaret, IconCheck, IconFlame, IconPlus } from "../../components/icons";
import { CardShell, CardStatus } from "./CardShell";
import { HabitHeatmap } from "./HabitHeatmap";

type Row = HabitWeek["rows"][number];
export type HabitToggle = (habitId: string, day: string, done: boolean) => Promise<void>;
/** 습관 하나 만들기 — 성공이면 true(실패는 훅의 call() 이 토스트를 띄운다). */
export type HabitCreate = (title: string) => Promise<boolean>;

/**
 * 카드 안 인라인 추가 — "+ 습관 추가" → 한 줄 입력. Enter = 만들기(조합 중 Enter 는 글자 확정이라 무시, 빈 제목은 아무것도 안 함),
 * Esc = 취소. Esc 는 창 닫기(AuxWindowChrome, capture 단계)보다 먼저 이 칸이 먹어야 하므로 소비 체인(useEscapeConsumer)에 올린다 —
 * capture 리스너라 React stopPropagation 으로는 막히지 않는다. 실패하면 입력을 그대로 둔다.
 */
function HabitInlineAdd({ create }: { create: HabitCreate }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false); // Enter 연타가 두 번 만들지 않게
  const cancel = () => {
    if (busy.current) return;
    setAdding(false);
    setTitle("");
  };
  useEscapeConsumer(adding, cancel);
  // 열릴 때, 그리고 저장이 끝나 disabled 가 풀릴 때(포커스가 빠진다) 다시 칸으로 — 연달아 추가·실패 뒤 Enter 재시도가 산다.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding && !saving) inputRef.current?.focus();
  }, [adding, saving]);
  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const ok = await create(trimmed);
      if (ok) setTitle("");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };
  if (!adding)
    return (
      <button type="button" className="brf-link-btn brf-habit-add-btn" data-testid="brf-habit-add" onClick={() => setAdding(true)}>
        <IconPlus size={12} aria-hidden />
        {t("briefing.action_add_habit")}
      </button>
    );
  return (
    <input
      ref={inputRef}
      className="brf-habit-add-input"
      data-testid="brf-habit-add-input"
      value={title}
      disabled={saving}
      placeholder={t("briefing.habit_add_placeholder")}
      aria-label={t("briefing.habit_add_placeholder")}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/** 오늘 칸 체크 — 오늘 해당 요일이 아니면 비활성. 낙관적 체크·롤백은 useHabitWeek 가 갖는다. */
function TodayCheck({ row, today, toggle }: { row: Row; today: string; toggle: HabitToggle }) {
  const d = row.days.find((x) => x.day === today);
  return (
    <button
      type="button"
      className={`brf-habit-box${d?.done ? " is-done" : ""}`}
      data-testid="brf-habit-today"
      aria-pressed={!!d?.done}
      aria-label={t("briefing.habit_check_today_aria", { title: row.habit.title })}
      disabled={!d?.scheduled}
      onClick={() => d && void toggle(row.habit.id, d.day, !d.done)}
    >
      {d?.done && <IconCheck size={12} strokeWidth={2} aria-hidden />}
    </button>
  );
}

/** 7일 점 — 지난 날 체크도 같은 낙관적 경로. 해당 요일이 아닌 칸은 비활성. */
function WeekDots({ row, toggle, uiLang }: { row: Row; toggle: HabitToggle; uiLang: string }) {
  const color = row.habit.hue != null ? folderColorCss(row.habit.hue) : undefined;
  const wd = new Intl.DateTimeFormat(uiLang || "en", { weekday: "short", timeZone: "UTC" });
  return (
    <span className="brf-habit-dots">
      {row.days.map((d) => (
        <button
          key={d.day}
          type="button"
          className={`brf-dot${d.done ? " is-done" : ""}${d.scheduled ? "" : " is-off"}`}
          style={color ? ({ "--habit-color": color } as CSSProperties) : undefined}
          aria-pressed={d.done}
          aria-label={t("briefing.habit_check_aria", {
            title: row.habit.title,
            day: `${d.day.slice(5).replace("-", ".")} ${wd.format(new Date(`${d.day}T00:00:00Z`))}`,
          })}
          disabled={!d.scheduled}
          onClick={() => void toggle(row.habit.id, d.day, !d.done)}
        />
      ))}
    </span>
  );
}

/**
 * 습관 — 한 모양(PLAN-2026-10-19 §2.1): 오늘 체크 + 7일 점 + 연속 기록. 주 기준은 설정의 주 시작 요일
 * (useHabitWeek 를 부르는 BriefingWindowApp 이 week_start 를 넘긴다 — OS 알림 요약과 같은 캐시 키).
 * `collapsible` = 좁은 창(§3.2) — 머리 한 줄(n/m)만 보이고 눌러 펼친다.
 */
export function HabitsCard({
  week,
  status,
  reload,
  toggle,
  collapsible = false,
  history = null,
  create,
}: {
  week: HabitWeek | null;
  status: LoadStatus;
  reload: () => void;
  toggle: HabitToggle;
  collapsible?: boolean;
  /** 12주 히트맵 데이터 — 없으면(로딩·실패) 히트맵만 비운다. 좁은 창(collapsible)에서는 그리지 않는다. */
  history?: HabitHistory | null;
  /** 인라인 추가 — 없으면 추가 버튼을 그리지 않는다. */
  create?: HabitCreate;
}) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const [open, setOpen] = useState(false);
  const stats = week ? todayHabitStats(week) : null;
  const nudge = week ? habitNudge(week) : null;
  const summary = stats && stats.total > 0 ? t("briefing.habits_done", { done: stats.done, total: stats.total }) : undefined;
  const expanded = !collapsible || open;
  const head = collapsible ? (
    <button
      type="button"
      className="brf-card-head brf-collapse-head"
      aria-expanded={open}
      data-testid="brf-habits-toggle"
      onClick={() => setOpen((v) => !v)}
    >
      <h2 className="brf-card-title">{t("briefing.habits_title")}</h2>
      <span className="brf-card-aside">
        {summary}
        <IconCaret dir={open ? "up" : "down"} size={14} />
      </span>
    </button>
  ) : undefined;
  return (
    <CardShell
      testId="brf-habits"
      title={t("briefing.habits_title")}
      aside={summary}
      gear={{ target: "habits_list", labelKey: "briefing.gear_habits" }}
      head={head}
    >
      {expanded &&
        (!week ? (
          <CardStatus status={status} onRetry={reload} />
        ) : week.rows.length === 0 ? (
          <div className="brf-state" data-testid="brf-habits-empty">
            <span>{t("briefing.habits_empty")}</span>
            {create && <HabitInlineAdd create={create} />}
          </div>
        ) : (
          <>
            {nudge && (
              <div className={`brf-habit-nudge is-${nudge.kind}`} data-testid="brf-habit-nudge">
                {t(nudge.kind === "one_more" ? "briefing.habit_nudge_one_more" : "briefing.habit_nudge_all_done")}
              </div>
            )}
            <ul className="brf-habit-list">
              {week.rows.map((row) => (
                <li key={row.habit.id} className="brf-habit-row" data-testid="brf-habit-row">
                  <TodayCheck row={row} today={week.today} toggle={toggle} />
                  <span className="brf-habit-title">
                    {row.habit.icon && (
                      <span className="brf-habit-icon" aria-hidden>
                        {row.habit.icon}
                      </span>
                    )}
                    {row.habit.title}
                  </span>
                  <WeekDots row={row} toggle={toggle} uiLang={uiLang} />
                  <span className="brf-habit-streak" title={t("briefing.habit_streak", { n: row.streak })} data-testid="brf-habit-streak">
                    {row.streak >= 2 && (
                      <>
                        <IconFlame size={11} aria-hidden />
                        {row.streak}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {create && <HabitInlineAdd create={create} />}
            {!collapsible && history && <HabitHeatmap history={history} today={week.today} uiLang={uiLang} />}
          </>
        ))}
    </CardShell>
  );
}

/** 저녁 "오늘 정리"의 남은 습관 — 오늘 해당 요일인데 아직 안 한 것만, 그 자리에서 체크한다. */
export function RemainingHabits({ week, toggle }: { week: HabitWeek; toggle: HabitToggle }) {
  const rows = week.rows.filter((r) => {
    const d = r.days.find((x) => x.day === week.today);
    return d?.scheduled && !d.done;
  });
  if (rows.length === 0) {
    const { total } = todayHabitStats(week);
    return total > 0 ? <div className="brf-state">{t("briefing.habit_nudge_all_done")}</div> : null;
  }
  return (
    <ul className="brf-habit-list" data-testid="brf-recap-habits">
      {rows.map((row) => (
        <li key={row.habit.id} className="brf-habit-row is-compact">
          <TodayCheck row={row} today={week.today} toggle={toggle} />
          <span className="brf-habit-title">{row.habit.title}</span>
        </li>
      ))}
    </ul>
  );
}
