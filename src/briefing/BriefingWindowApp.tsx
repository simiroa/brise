/**
 * 브리핑 창(#/briefing) 루트 — PLAN-2026-10-19 재작성. **오늘을 조각한다.** 내일 확인은 따로 칸을 두지 않고
 * 왼쪽 축의 날짜 이동(›·`]`·작은 달력)으로 한다 — 내일 칸은 걷어냈다(오너 결정).
 *
 *   머리줄 A  날짜 · 시각 · 지금 날씨 · 인사           (HeaderRow)
 *   머리줄 B  문구 한두 줄 + 복사·새로고침               (QuoteLine)
 *   왼쪽 ≈58% 오늘의 쓰는 세로 축(DayAxis 마운트)        (TodayAxisPane)
 *   오른쪽 ≈42% [저녁: 오늘 정리] · 작은 월 달력 · 오늘의 습관 · 최근 작업 노트 · 지난 알림(0건이면 없음)
 *   바닥 한 줄  새로 수집 N건 →
 *
 * 블록 격자·스타일·프리셋·템플릿 편집기는 걷어냈다(§9). 저녁 모드(`?mode=recap`)도 축은 **오늘**이다
 * (§12.1 Q2 — "저녁엔 내일로 열기" 기각). 대신 날짜 바꾸기가 쉽다: ‹ › · 오늘 · 가로 쓸어넘기기 · `[`/`]`.
 *
 * 표면(R1-B·C): 본문 = 메인 창과 같은 틴트 `.content-canvas` 래퍼(바깥) + 스크롤러 `.brf-root`(안) —
 * `.content-canvas` 는 overflow:hidden 이라 한 요소에 같이 달지 않는다. 카드는 공용 `.card`.
 *
 * 쓰기 반영(§2.4 ④): 이 창의 달력 쓰기(bumpNoteQueryVersion)와 백엔드의 `remote-note-write`(출처 무관)를
 * 한 신호(scheduleVersion)로 모아 일정·알림을 다시 읽는다. 노트 스토어는 부팅하지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AuxWindowChrome } from "../components/AuxWindowChrome";
import { t } from "../i18n/t";
import { listenMany } from "../lib/tauriListen";
import { listenDataReplaced } from "../lib/remoteNoteWrite";
import { useNoteQueryVersion } from "../lib/noteQuery";
import { isOverlayOpen } from "../lib/overlayStack";
import { useMediaQuery } from "../lib/ui";
import { requestOpenNoteInMain } from "../lib/openNoteInMain";
import { toIsoDateLocal } from "../components/home/dateFmt";
import { useSettingsStore } from "../stores/settings";
import { dayAfter, useHabitHistory, useHabitWeek, useNow, useRecentCollect, useRecentNotes, useDaySchedule } from "./hooks/useBriefingData";
import { useOverdue } from "./hooks/useOverdue";
import { bumpScheduleVersion } from "./scheduleVersion";
import { isTypingTarget } from "./dayNav";
import { HeaderRow } from "./HeaderRow";
import { QuoteLine } from "./QuoteLine";
import { TodayAxisPane } from "./TodayAxisPane";
import { MiniCalendar } from "./cards/MiniCalendar";
import { HabitsCard, RemainingHabits } from "./cards/HabitsCard";
import { OverdueCard, OverdueList, type OverdueData } from "./cards/OverdueCard";
import { RecentNotesCard } from "./cards/RecentNotesCard";
import { CardShell } from "./cards/CardShell";
import type { HabitWeek } from "../lib/commands.gen";
import "./briefing.css";

export type BriefingMode = "morning" | "recap";

/** 새 창은 Rust 가 `?mode=recap` 으로 연다(briefing_window.rs). 그 밖은 아침 브리핑. */
function initialMode(): BriefingMode {
  return new URLSearchParams(window.location.search).get("mode") === "recap" ? "recap" : "morning";
}

/** 좁은 창(§3.2) — 한 열, 습관 접힘. */
export const NARROW_QUERY = "(max-width: 639px)";

/** 저녁 "오늘 정리" — 남은 습관(그 자리에서 체크) · 오늘 일정 수 · 지난 알림. 저녁 모드에서만 붙는다. */
function RecapCard({
  todayIso,
  week,
  toggle,
  overdue,
}: {
  todayIso: string;
  week: HabitWeek | null;
  toggle: (habitId: string, day: string, done: boolean) => Promise<void>;
  overdue: OverdueData;
}) {
  const { status, entries } = useDaySchedule(todayIso);
  const events = entries.filter((e) => e.kind === "event").length;
  return (
    <CardShell testId="brf-recap" className="brf-recap" title={t("briefing.recap_title")}>
      {status === "ready" && <div className="brf-recap-line">{t("briefing.recap_events", { n: events })}</div>}
      {week && <RemainingHabits week={week} toggle={toggle} />}
      {overdue.items.length > 0 && (
        <>
          <div className="brf-recap-sub">{t("briefing.overdue_title")}</div>
          <OverdueList items={overdue.items} dismiss={overdue.dismiss} />
        </>
      )}
    </CardShell>
  );
}

/** 바닥 한 줄 "새로 수집 N건 →" — 누르면 가장 최근 것을 본 창에서 연다. 0건이면 줄이 없다(§12.1 Q3). */
function CollectFooter() {
  const { data } = useRecentCollect();
  if (!data || data.newCount <= 0 || data.items.length === 0) return null;
  return (
    <footer className="brf-foot">
      <button type="button" className="brf-link-btn" data-testid="brf-collect-line" onClick={() => void requestOpenNoteInMain(data.items[0].note_id)}>
        {t("briefing.collect_line", { n: data.newCount })}
      </button>
    </footer>
  );
}

export function BriefingWindowApp() {
  const [mode, setMode] = useState<BriefingMode>(initialMode);
  // 데이터가 통째로 바뀌면(초기화·복원·대체 가져오기) 노트북·설정까지 무효 — 창을 다시 불러온다.
  useEffect(() => listenDataReplaced(), []);
  // 이미 열린 창으로 온 모드 전환(briefing_window_open 의 mode 인자 → briefing-mode 이벤트).
  useEffect(() => {
    // 보조 창은 닫히지 않고 숨는다 — 숨어 있는 동안 본 창의 자동 저장마다 다시 읽지 않게 표시만 해 두고,
    // 다시 보일 때 한 번 읽는다.
    let dirty = false;
    const onVisible = () => {
      if (document.hidden || !dirty) return;
      dirty = false;
      bumpScheduleVersion();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const unlisten = listenMany([
      ["briefing-mode", (e: { payload: unknown }) => setMode(e.payload === "recap" ? "recap" : "morning")],
      // 본 창·폰·이 창 자신의 노트 쓰기(출처 무관) — 일정·알림을 다시 읽는다.
      [
        "remote-note-write",
        () => {
          if (document.hidden) dirty = true;
          else bumpScheduleVersion();
        },
      ],
    ]);
    return () => {
      unlisten();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  // 이 창의 달력 쓰기 경로(commitDateRow·removeDateRow·종일 드롭)는 bumpNoteQueryVersion 으로 끝난다.
  const noteQueryVersion = useNoteQueryVersion();
  const firstNqv = useRef(noteQueryVersion);
  useEffect(() => {
    if (noteQueryVersion !== firstNqv.current) bumpScheduleVersion();
  }, [noteQueryVersion]);

  const now = useNow(60_000);
  const todayIso = toIsoDateLocal(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // null = 오늘을 따라간다(자정을 넘기면 새 오늘로). 날짜를 고르면 그 날에 머문다.
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? todayIso;
  const goto = (d: string) => setPicked(d === todayIso ? null : d);
  const step = (dir: 1 | -1) => goto(dayAfter(day, dir));
  const stepRef = useRef(step);
  stepRef.current = step;

  // `[` / `]` — 창 어디서든 하루 이동. 글자 입력·조합 중·수식키·떠 있는 대화상자에서는 쓰지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target) || isOverlayOpen()) return;
      e.preventDefault();
      stepRef.current(e.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const narrow = useMediaQuery(NARROW_QUERY);
  const weekStart = useSettingsStore((s) => s.weekStart);
  // 습관·지난 알림은 창 루트에 하나씩 — 저녁 "오늘 정리"와 오른쪽 카드가 같은 상태를 본다(체크가 양쪽에 바로 반영).
  const habits = useHabitWeek(todayIso, weekStart);
  // 12주 히트맵 — 체크·추가 뒤 서버 값으로 다시 읽는다(toggle 은 실패를 스스로 되돌리므로 성공 여부와 무관하게 재조회해도 맞다).
  const habitHistory = useHabitHistory(todayIso, weekStart);
  const { toggle: toggleWeek, create: createWeek } = habits;
  const reloadHistory = habitHistory.reload;
  const toggleHabit = useCallback(
    async (habitId: string, checkDay: string, done: boolean) => {
      await toggleWeek(habitId, checkDay, done);
      reloadHistory();
    },
    [toggleWeek, reloadHistory],
  );
  const createHabit = useCallback(
    async (title: string) => {
      const ok = await createWeek(title);
      if (ok) reloadHistory();
      return ok;
    },
    [createWeek, reloadHistory],
  );
  const overdue = useOverdue();
  const recentNotes = useRecentNotes();
  const recap = mode === "recap";

  return (
    <AuxWindowChrome title={t("home.briefing_title")} closeTestId="briefing-window-close">
      <div className="content-canvas brf-canvas">
        <div className="brf-root" data-mode={mode} data-narrow={narrow ? "1" : undefined} data-testid={recap ? "briefing-recap" : "briefing-root"}>
          <HeaderRow />
          <QuoteLine />
          <div className="brf-cols">
            <TodayAxisPane day={day} todayIso={todayIso} nowMin={nowMin} onStep={step} onToday={() => setPicked(null)} />
            <div className="brf-side">
              {recap && <RecapCard todayIso={todayIso} week={habits.week} toggle={toggleHabit} overdue={overdue} />}
              {/* 작은 달력은 오른쪽 맨 위, 좁은 창에서도 남긴다 — 오너 "달력은 작게라도 있는 게 좋다"(GRILL R13). */}
              <MiniCalendar day={day} todayIso={todayIso} onPick={goto} />
              <HabitsCard
                week={habits.week}
                status={habits.status}
                reload={habits.reload}
                toggle={toggleHabit}
                collapsible={narrow}
                history={habitHistory.history}
                create={createHabit}
              />
              <RecentNotesCard {...recentNotes} />
              {!recap && <OverdueCard {...overdue} />}
            </div>
          </div>
          <CollectFooter />
        </div>
      </div>
    </AuxWindowChrome>
  );
}
