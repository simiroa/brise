/**
 * Calendar right-hand day detail panel — extracted from CalendarTab (pure move, same behavior).
 *
 * Schedule W5-5 (docs/PLAN-schedule-system.md §6.2): when a single day is selected this splits into
 * an all-day strip + a 24h time axis. The aside stays **280px** (owner decision 2026-08-09 — the
 * month grid must not get narrower), so the axis is laid out backwards from that budget: a 24px
 * hour-label column leaves ~230px for events. Overlaps never split that width into columns — they
 * keep full width and stack vertically instead (owner revision 2026-08-09, QA: a staircase offset
 * let a near-time chip fully cover the next one's title — see planTimedDay in calendarLayout.ts).
 *
 * The 672px axis (24 × 28px) scrolls in its OWN container, not the aside — hanging it off the
 * aside's overflow would push the whole dashboard page into a scrollbar.
 *
 * PLAN-2026-09-10 달력 W4 — 패널 위쪽이 그 날의 **브리핑 리포트**가 된다(오너 실기 지시):
 *  ① 날짜가 선택돼 있으면 시간축은 **항상** 있다. 0건이어도 24시간 눈금이 뜬다 — 그 자체가
 *     "이 날 시각 잡힌 일정이 없다"는 답이고, 칩을 끌어다 넣을 바탕이기도 하다. 월 모드
 *     (selectedDay === null)에는 그릴 날이 없으니 축도 없다 — 예전의 평평한 목록 그대로.
 *  ② 한 줄짜리 <h3> 였던 헤더가 연월 · 일 · 요일 · 공휴일 · 날씨 · 요약의 블록이 된다. 위계는
 *     **크기**로만 준다 — 굵기 사다리는 400/600 두 단뿐이라 3단이 안 나온다(docs/DESIGN.md).
 *  ③ 종일/시각없는 항목이 3개 이상이면 접힘이 기본이고, 펼치면 그 목록이 **축의 자리**를
 *     차지한다. 둘을 세로로 쌓아 서로 밀지 않는다 — 280px 안에서 둘 다 쓸모없어진다.
 *
 * PLAN-2026-09-10 달력 W7 — 위쪽 종일 카드를 아래 축으로 끌어다 놓으면 그 시각으로 등록된다.
 * 드롭이 무엇을 쓰는지는 화면 항목이 아니라 **DB 행의 모양**이 정하고(calendarLayout::
 * planAllDayDrop 의 세 갈래), 저장은 칩 드래그와 같은 commitDateRow 를 지난다.
 *
 * PLAN-2026-09-10 달력 W9 — 드래그의 **안전망과 손맛**:
 *  ① 시각을 바꾸는 다섯 경로 전부에 되돌리기 토스트. commitDateRow 한 지점에 있다(그 주석 참고).
 *  ② 종일 카드는 왼쪽 **그립**에서만 끌린다 — 본체는 클릭/더블클릭만 맡는다.
 *  ③ 터치는 길게 눌러야 드래그가 열린다(useAxisDragSession 이 세 사용처에 같은 규칙을 준다).
 *
 * PLAN-2026-09-10 달력 W10 — 오너 실기 셋:
 *  ① 현재 시각 눈금이 더 또렷해진다 — 2px + 맥동 발광(.cal-now-line) + 선 오른쪽 끝의 시각 라벨.
 *     라벨의 분은 이미 있던 1분 틱(nowTick)에서 온다(새 타이머 없음).
 *  ② 축의 칩에 포커스가 있으면 Delete/Backspace 로 그 **행**을 없앤다(removeDateRow — 두 갈래와
 *     되돌리기는 그 주석 참고). 종일 카드는 펼치면 이미 제거 버튼이 있어 키를 걸지 않는다.
 *  ③ 시각 있는 항목의 상세(FocusedDetails)를 축 아래에서 **브리핑 아래·목록 위**로 올렸다 —
 *     축이 남은 높이를 다 먹어 예전 자리는 화면 밖이었다. → **W12 ④ 에서 통째로 지워졌다**
 *     (아래 참고). FocusedDetails 자체는 종일 카드가 펼쳐질 때 여전히 쓴다.
 *
 * PLAN-2026-09-10 달력 W11 — 오너 실기 넷:
 *  ① 브리핑 바로 아래 가로 구분선 하나(월 모드엔 브리핑이 없으니 선도 없다). DatesPanel 의
 *     초안 정밀도 블록과 **같은 토큰·같은 형태**(--divider 1px)다.
 *  ② 시각 라벨 둘(24시간 눈금 · 현재 시각)이 `.cal-tick-label` 한 클래스를 쓴다 — 배경으로
 *     가로선을 끊어 `──09──` 로 읽히고, 그 불투명 배경이 현재 시각 선의 발광 위에서 대비를
 *     지킨다. 이유와 진단은 tokens.css 의 그 클래스 주석에 있다.
 *  ③ 축 칩이 한 줄에서 **3줄**이 된다 — (시각·반복) / (노트 제목) / (본문 첫 줄). 발췌는 이미
 *     캐싱해 둔 `excerpts` 를 그대로 쓴다(새 IPC 0). (2026-10-27 기하 통일로 바닥 높이 CHIP_MIN_H 는
 *     없어졌다 — 칩 높이 = 실제 길이, 짧은 칩은 줄 수를 줄인다. TimeChip 의 chipTier 참고.)
 *  ④ 칩의 설정 아이콘(또는 롱프레스)은 일정 수정 모달(ChipEventModal)을 연다 — 저장은 기존
 *     commitDateRow 한 길을 그대로 지난다. (W12 ③ 에서 인라인 → 플로팅 메뉴(ChipSchedule)였다가 2026-10-27 모달로 바뀌었다.)
 *
 * PLAN-2026-09-10 달력 W12 — 오너 실기 넷:
 *  ① 축 칩의 호버가 거꾸로였다 — 평소 불투명 `--bg` 에 호버 시 낮은 알파의 `--hover` 를 덮어써
 *     "투명해지는" 인상이었다. 이제 평소 transparent · 호버 시 `--hover` 로, 이 저장소의 표준
 *     (DetailNoteCard 와 종일 카드의 모든 버튼)과 같은 방향이다.
 *  ② 종일 카드의 그립이 `.icon-btn` 을 입는다 — 호버 시 배경·색이 바뀌는 그 클래스가 이
 *     저장소의 "조작 가능함" 신호다(전에는 항상 --faint 로 아무 반응이 없었다).
 *  ③ 설정을 열면 칩이 늘어나던 것(height:auto)을 없앴다. 칩의 height 는 **그 일정의 길이**라
 *     늘리면 "일정이 길어졌다"는 거짓 정보가 된다 — 당시엔 칩 아래 작은 플로팅 메뉴가 떴고, 지금은 모달이다.
 *  ④ "축에만 있는 항목"의 상단 상세 블록(FocusedDetails 사용처 하나)을 지웠다 — 그 일을 ③ 의
 *     설정 UI 와 칩 3행이 이미 한다.
 *
 * PLAN-2026-09-10 달력 W14 — 종일 목록이 **가로 스트립**이 된다(오너 실기 2026-09-11):
 *  ① W4 ③ 의 접힘(3개 이상이면 접히고, 펼치면 목록이 축의 자리를 먹는다)을 통째로 지웠다.
 *     어느 상태로도 3개 이상일 때 카드→축 드래그가 막혔다 — 접히면 3번째 이후 카드가 없어서
 *     못 끌고, 펼치면 놓을 축이 사라졌다. 세로 스크롤 목록으로 고치려던 안도 기각됐다: 세로는
 *     24시간 축과 다투는 자원이라 목록을 세로로 두는 한 늘려도 줄여도 축을 압박한다.
 *     **가로 스트립은 고정 한 줄 높이로 끝난다** — 몇 개든 가로 스크롤로 다 닿고 다 끌린다.
 *  ② 그래서 한 칸이 카드가 아니라 압축 필(AllDayPill)이다. 세로로 자라는 것은 하나도 없다:
 *     둘째 줄(일정 메타)은 `title` 툴팁으로 갔고(날씨 라벨을 툴팁으로 옮긴 W11 ② 과 같은
 *     처방 — 같은 값은 같은 대접), 펼침(FocusedDetails)은 아래로 **떠 있는** 패널이 됐다.
 *  ③ 펼침은 이제 **포커스가 아니라 명시적 설정 아이콘**이 연다(동작 변화). 축 칩의 설정도
 *     아이콘 클릭으로 여는데 카드만 "포커스=자동 펼침"이면 같은 종류의 조작이 다른 경험이
 *     되고, 가로 스트립에서 초점이 옮겨질 때마다 패널이 열렸다 닫히면 산만하다.
 *  ④ 월 모드(selectedDay === null)는 **그대로 세로 카드 목록**이다. 스트립의 근거가 "축과
 *     세로를 다툰다"인데 월 모드엔 축이 없고, 한 달치 노트를 가로로 늘어놓으면 더 나쁘다.
 *     그 화면에서는 항목별 날짜가 유일한 단서라 둘째 줄도 그대로 남는다(DetailNoteCard).
 *
 * PLAN-2026-09-10 달력 W15 — 축 드래그의 **손맛**과 붙어 있는 항목의 연동:
 *  ① 드래그 도중 Escape = 취소(useAxisDragSession — pointercancel 과 같은 한 자리).
 *  ② 드래그 중엔 시각과 함께 **지속시간**을 보여준다(1행 · 툴팁).
 *  ③ 되돌리기 토스트에 실제 이전→이후 시각이 들어간다 — 연속 드래그로 토스트가 쌓일 때 서로
 *     구분되지 않던 것(그릴 D4)의 짝이다.
 *  ④ (폐기 2026-10-27) 드래그 이징은 칸마다 재시작돼 떨림을 만들었다 — 이제 칩이 스냅 자리에 바로 선다.
 *  ⑤ 칩 3줄이 좌상단 정렬 + 두 단 큰 글꼴(`--text-md`). 줄 높이 계산(chipLinePx)도 같은 토큰이다.
 *  ⑥ **연동 이동**: 시작~끝이 맞닿은(gap 0) 이웃은 가운데를 잡은 이동(드래그·키보드 ↑/↓)에서
 *     같은 델타만큼 따라 움직이고, 저장은 각자 자기 DB 행을 지나며(함정 ⓑ) 되돌리기는 **하나의
 *     토스트**로 묶인다. 판정·경계는 calendarLayout::planLinkedMove 한 곳이다(2026-10-27: 맞닿은 이웃 연동 → 겹친 만큼 밀어내기로 일반화, 겹침을 만들지 않는다).
 *
 * PLAN-2026-09-11 사이드바 W1 D4 — 껍데기 분리. `DayDetailPanel`(aside, 훅 0) ⊃ `DayDetailBody`
 * (본문 전부). 대시보드는 전자 그대로, 사이드바(W2)는 후자를 직접 그린다. 동작·testid 변화 0.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CalendarItem,
} from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { useNotesStore } from "../../../stores/notes";
import { useUiStore } from "../../../stores/ui";
import { monthLongLabel } from "../dateFmt";
import {
  type DailyForecast,
  weatherCodeToVisual,
  weatherLabelKey,
  weatherTempColorVar,
} from "../../../lib/weather";
import { toneColor } from "../../../lib/calendarDay";
import { useSettingsStore } from "../../../stores/settings";
import { type InlineTaskItem } from "../../../lib/inlineSchedule";
import {
  planTimedDay,
  collapseOccurrencesForDay,
  itemKey,
  formatHhmm,
} from "../calendarLayout";
import { DayBriefing } from "./DayBriefing";
import {
  useAxisConfirmFlow,
} from "./useAxisConfirmFlow";
import { AxisConfirmDialog } from "./AxisConfirmDialog";
import {
  AllDayStrip,
  SectionLabel,
  type AxisHandle,
} from "./AllDayStrip";
import { CHIP_LINE } from "./TimeChip";
import { useDayRoutines, useDayNoteBodies, useNextDayPlan, type ParentMonthItems } from "./useDayDetailData";
// PLAN-2026-10-19 W1 — 축(TimeAxis·HourRuler·AxisResizeHandle)은 DayAxis.tsx 로 순수 이동했다.
import { TimeAxis, readNowTick } from "./DayAxis";

export type { AxisHandle } from "./AllDayStrip";
export { CHIP_LINE };


export type DayDetailBodyProps = {
  selectedDay: string | null;
  monthLabel?: string;
  /** 그 날의 공휴일 이름 — CalendarTab 이 이미 갖고 있는 useHolidayMap 에서 골라 내려준다. */
  holidayName?: string | null;
  /** 그 날의 기념일 이름표(빨간 날 아님) — useDayMarkMaps().labels 에서 골라 내려준다. */
  markLabel?: string | null;
  /** MonthGrid 가 쓰는 것과 **같은** 일별 예보. null 이면 브리핑의 날씨 자리만 조용히 빈다. */
  forecast?: DailyForecast | null;
  detailNotes: CalendarItem[];
  /** 부모가 이미 읽어 둔 그 달 일정(대시보드 달력 탭) — 익일 구간이 같은 달이면 `dashboard_calendar` 를 또 부르지 않고 이것을 쓴다. 사이드바는 안 넘긴다. */
  monthItems?: ParentMonthItems | null;
  /** Double-click — opens the note tab. */
  onOpen: (noteId: string) => void;
  /** Single-click focus (map view pattern) — optional so tests that only exercise open don't need
   *  to wire it up. */
  onFocus?: (noteId: string) => void;
  focusedNoteId?: string | null;
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  inlineTasks?: InlineTaskItem[];
  onToggleInlineTask?: (task: InlineTaskItem) => void;
  /** ② 축의 빈 곳을 끌어 놓으면 **그 자리에서** 노트를 만든다 — 만드는 일은 CalendarTab 이
   *  소유한다(기존 createNoteForRange 재사용). 없으면 빈 곳 드래그 자체가 없다. */
  onCreateTimedNote?: (day: string, startMin: number, endMin: number) => void;
  /** PLAN-2026-10-10 W-E (D5) — 사이드바 "오늘 할 일" 전용 압축 변형. 큰 브리핑 블록 대신
   *  날짜·날씨·현재 시각을 **한 줄**(CompactDayHeader)로, 구분선과 안내 줄을 걷어 세로 시간축이
   *  남은 높이를 거의 다 갖는다. 대시보드 우측 패널은 이 prop 을 안 넘기므로 화면이 그대로다. */
  compact?: boolean;
};

/**
 * PLAN-2026-09-11 사이드바 W1 D4 — 껍데기. 대시보드가 쓰던 `<aside data-testid="cal-detail">`
 * (폭·왼쪽 선·왼쪽 여백)만 남기고 안은 전부 DayDetailBody 다. **훅 0** — 이 파일의 고질적 함정
 * (훅이 조기 반환 아래로 내려가 앱 백지)은 본체가 훅을 전부 갖고 껍데기가 하나도 안 가지면
 * 구조적으로 안 생긴다. `overflowY` 는 옛 aside 의 규칙(축이 있으면 hidden, 월 모드면 auto)을
 * 그대로 — 본체의 `hasAxis` 는 `!!selectedDay` 와 같은 값이라(plan 은 selectedDay 가 있을 때만
 * 계산된다) 훅 없이 prop 에서 바로 읽는다. 본체도 같은 규칙을 갖는다(사이드바엔 이 aside 가
 * 없으니 본체가 스스로 굴려야 한다); 대시보드에선 둘이 겹치지만 본체가 aside 를 가득 채우므로
 * 실제로 구르는 것은 본체 하나다.
 */
export function DayDetailPanel(props: DayDetailBodyProps) {
  const hasAxis = !!props.selectedDay;
  return (
    <aside
      data-testid="cal-detail"
      style={{
        // Shared with the graph/map right panels (src/styles/dashboardList.css
        // --dashboard-side-panel-w) so all three "selected note" side panels
        // occupy the same width — was a locally hardcoded 280 that happened to
        // match, not derived from one source.
        width: "var(--dashboard-side-panel-w)",
        flex: "none",
        borderLeft: "1px solid var(--line)",
        paddingLeft: "var(--space-7)",
        display: "flex",
        flexDirection: "column",
        overflowY: hasAxis ? "hidden" : "auto",
        minHeight: 0,
      }}
    >
      <DayDetailBody {...props} />
    </aside>
  );
}

/**
 * D4 — 본체. 자기 폭을 정하지 않는다(`width` 없음, `minWidth: 0`) — 대시보드는 위 aside 가,
 * 사이드바(W2)는 자기 칼럼이 폭을 준다. 내용의 것인 `gap`·`overflowY` 규칙은 여기 있다.
 */
export function DayDetailBody({
  selectedDay,
  monthLabel,
  holidayName = null,
  markLabel = null,
  forecast = null,
  detailNotes,
  monthItems = null,
  onOpen,
  onFocus = () => {},
  focusedNoteId = null,
  searchHits = null,
  folderFilter = null,
  inlineTasks: propInlineTasks,
  onToggleInlineTask,
  onCreateTimedNote,
  compact = false,
}: DayDetailBodyProps) {
  const folders = useNotesStore((s) => s.folders);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  const uiLang = useSettingsStore((s) => s.uiLang);
  /** 시간축 익일 구간(설정 calendar_axis_tail_hours) — 대시보드·사이드바가 이 본체를 같이 쓰므로 한 곳에서 채운다. */
  const tailHours = useSettingsStore((s) => s.calendarAxisTailHours);
  const tailPlan = useNextDayPlan(selectedDay, tailHours, monthItems);

  // ── 데이터 조회 계층은 useDayDetailData.ts 에 있다 ────────────────────────────────────────
  // 시간축 배경 루틴(설정에서 오는 요일 반복)과, 그 날 노트들의 본문 한 번 읽기(발췌 · 칩
  // 체크리스트 · 인라인 할 일 + 두 토글의 낙관적 갱신/롤백)가 각각 한 훅이다.
  const dayRoutines = useDayRoutines(selectedDay, holidayName);
  const collapsedDetailNotes = useMemo(
    () => (selectedDay ? collapseOccurrencesForDay(detailNotes, selectedDay) : detailNotes),
    [detailNotes, selectedDay],
  );

  const {
    excerpts,
    checklists,
    activeInlineTasks,
    handleToggleTask,
    handleToggleChecklistItem,
  } = useDayNoteBodies({
    selectedDay,
    detailNotes: collapsedDetailNotes,
    propInlineTasks,
    onToggleInlineTask,
  });
  // Hooks before any early return — EditorPanel's blank-screen crash was exactly this (CLAUDE.md).
  const plan = useMemo(
    () => (selectedDay ? planTimedDay(collapsedDetailNotes, selectedDay) : null),
    [collapsedDetailNotes, selectedDay],
  );
  /** W8: 축이 자기 좌표계를 **직접** 답한다 — 부모가 자식의 스크롤러·캔버스 DOM 을 더듬어
   *  픽셀을 분으로 바꾸던 자리(axisRef + axisCanvasRef 두 개)를 이 손잡이 하나가 대신한다.
   *  스크롤 위치를 첫 일정에 맞추는 일도 축 자신이 갖게 됐다(TimeAxis 안의 effect). */
  const axisHandle = useRef<AxisHandle>(null);


  // ── W7: 종일 카드를 축으로 끌어다 놓아 그 시각으로 등록 ─────────────────────────────────
  // **접근성**: 드래그는 지름길일 뿐이고, 키보드 경로는 카드를 펼치면 나오는 시각 입력
  // (NoteDatesList 의 텍스트 입력)이 이미 갖고 있다 — 새 단축키를 발명하지 않는다(칩의 ↑/↓ 에
  // 끝 시각을 넣지 않은 것과 같은 2026-09-10 오너 결정).
  // 세션 뼈대는 useAxisDragSession 이 갖는다(W8) — 여기 남는 것은 "무엇을 그리고 무엇을
  // 저장하나"뿐이다.
  /** 드래그 중 미리보기이자 드롭 직후의 낙관적 자리. `saving` 이면 카드가 목록에서 빠진다 —
   *  이미 축으로 옮겨간 것으로 그린다. 실패하면 null 로 되돌아가 카드가 돌아온다(§9). */
  const [dropPreview, setDropPreview] = useState<{
    key: string;
    title: string;
    startMin: number;
    saving: boolean;
  } | null>(null);
  // 새 데이터가 오면(저장 → bump → 재조회) 낙관적 자리를 버린다 — 그때부터 plan 이 진실이다.
  useEffect(() => {
    setDropPreview(null);
  }, [plan]);

  // ── D2·D4·D5 확인 다이얼로그 — DayDetailPanel 수준 하나. 축(TimeAxis) 안의 반복 적용·Delete
  // 도 이 state 를 통해 여기로 요청한다(같은 파일이라 prop 으로 콜백을 내려 보낸다).
  const {
    confirm,
    setConfirm,
    requestSpanDrop,
    resolveSpanDrop,
    resolveRepeatApply,
    resolveDeleteRepeat,
    resolveDeleteEvent,
    cancelConfirm,
  } = useAxisConfirmFlow({
    selectedDay,
    plan,
    tailHours,
    tailPlan,
    setDropPreview,
  });



  // ② 브리핑의 날짜 조각. CalendarTab 이 selectedDayLabel 을 조립하던 **같은 규칙**이다 —
  // `${iso}T00:00:00Z` + timeZone UTC. 로컬로 파싱하면 시간대에 따라 하루가 밀린다.
  // 일 숫자만은 Date 를 거칠 이유가 없어 ISO 문자열에서 그대로 잘라 쓴다(같은 값, 흔들림 0).
  const briefing = useMemo(() => {
    if (!selectedDay) return null;
    const [y, m, d] = selectedDay.split("-");
    return {
      month: monthLongLabel(uiLang, Number(y), Number(m) - 1),
      day: String(Number(d)),
      weekday: new Intl.DateTimeFormat(uiLang || "en", {
        weekday: "long",
        timeZone: "UTC",
      }).format(new Date(`${selectedDay}T00:00:00Z`)),
    };
  }, [selectedDay, uiLang]);

  // forecast.time 항목은 기기 로컬 벽시계 "YYYY-MM-DD" 문자열이다 — Date 로 다시 유도하지 말고
  // 문자열로 맞춘다(lib/weather.ts 의 타입 주석). MonthGrid 의 forecastByDay 와 같은 규칙.
  const dayWeather = useMemo(() => {
    if (!selectedDay || !forecast) return null;
    const i = forecast.time.indexOf(selectedDay);
    return i < 0
      ? null
      : { code: forecast.weatherCode[i], max: forecast.tempMaxC[i], min: forecast.tempMinC[i] };
  }, [forecast, selectedDay]);

  // ① 날짜가 선택돼 있으면 축은 항상 있다(0건이어도). 월 모드엔 없다.
  const hasAxis = !!plan;
  // 드롭을 저장하는 중인 항목은 목록에서 빠진다 — 낙관적으로 이미 축의 미리보기가 그 자리를 잡고
  // 있고, 실패하면 dropPreview 가 null 로 돌아가며 카드도 함께 돌아온다(§9).
  const listItems = plan
    ? plan.allDay.filter((it) => !(dropPreview?.saving && dropPreview.key === itemKey(it)))
    : collapsedDetailNotes;
  const hasNotes = collapsedDetailNotes.length > 0;
  const hasInlineTasks = activeInlineTasks.length > 0;
  // 0건 안내는 눈금을 숨기지 않는다. 노트가 아예 없는 날은 아래 emptyText 가 이미 그 자리에
  // 있어 두 줄이 겹치므로 그때는 띄우지 않는다.
  const axisEmptyHint = hasAxis && (plan?.timed.length ?? 0) === 0 && (hasNotes || hasInlineTasks);
  // W12 ④ — "축에만 있는 항목"의 상세 블록(focusedTimed)은 **없앴다**. 그 블록이 하던 일이
  // 전부 칩으로 옮겨졌다: 시각·반복 편집은 칩의 설정 메뉴(W12 ③), 발췌는 칩 3행(W11 ③)이다.
  // ponytail: 다른 날짜를 추가하는 UI(피커)는 이번에 없다 — 필요해지면 그때. 지워진 블록의
  // "이 날짜 추가"는 축에 이미 뜬 항목에게는 거짓말이었고(그 날짜가 있어서 거기 뜬 것이다),
  // 종일 카드가 펼쳐질 때의 같은 버튼은 그대로 남는다(월 모드는 그 노트의 날짜 ≠ 선택된 날).
  const emptyText = selectedDay ? t("home.cal_empty_day") : t("home.cal_empty_month");
  // W-E compact — 축이 있으면 "노트 없음"·"시각 일정 없음" 안내가 따로 한 줄씩 먹지 않고 축 위
  // 도구 줄("하루 전체 보기"가 이미 있는 그 줄)의 왼쪽에 앉는다. 축이 없으면(월 모드) 옛 자리 그대로.
  const compactAxis = compact && hasAxis;
  const daySummary = `${t("home.cal_day_events", { count: plan?.timed.length ?? 0 })} · ${t("home.cal_day_notes", { count: collapsedDetailNotes.length })}`;
  const axisToolbarHint: ReactNode = !compactAxis
    ? null
    : !hasNotes && !hasInlineTasks
      ? <span>{emptyText}</span>
      : axisEmptyHint
        ? <span data-testid="cal-time-axis-empty">{t("home.cal_axis_empty")}</span>
        : <span data-testid="cal-axis-summary">{daySummary}</span>;

  return (
    <>
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: compact ? "var(--space-3)" : "var(--space-5)",
        // With an axis the inner scroller owns the overflow; without one the body scrolls as before.
        overflowY: hasAxis ? "hidden" : "auto",
      }}
    >
      {compact && selectedDay ? (
        <CompactDayHeader
          selectedDay={selectedDay}
          uiLang={uiLang}
          holidayName={holidayName}
          markLabel={markLabel}
          weather={dayWeather}
          summary={daySummary}
        />
      ) : briefing ? (
        <DayBriefing
          parts={briefing}
          holidayName={holidayName}
          markLabel={markLabel}
          weather={dayWeather}
          summary={
            <>
              {/* 오너 결정 2026-09-10: 날짜가 선택되면 그날의 **일정 수**(시각 있는 항목 = 축에
                  그려지는 것)를 노트 수와 같이 적는다. 구분자는 문구에 박지 않는다 —
                  로케일마다 어순이 달라진다. */}
              {t("home.cal_day_events", { count: plan?.timed.length ?? 0 })}
              {" · "}
              {t("home.cal_day_notes", { count: collapsedDetailNotes.length })}
            </>
          }
        />
      ) : (
        // 월 모드 — 그릴 날이 없으니 브리핑도 없다. 월 라벨 + 노트 수의 기존 헤더 그대로.
        <h3
          style={{
            margin: 0,
            fontSize: "var(--text-md)",
            fontWeight: 600,
            fontFamily: "var(--font-heading)",
            flex: "none",
          }}
        >
          {monthLabel ?? t("home.cal_pick_day")}
          <span
            style={{
              color: "var(--faint)",
              fontWeight: 400,
              fontSize: "var(--text-xs)",
              marginLeft: "var(--space-3)",
            }}
          >
            {t("home.cal_day_notes", { count: collapsedDetailNotes.length })}
          </span>
        </h3>
      )}

      {/* W11 ① — 브리핑(오늘 요약)과 그 아래 전부(포커스 상세 · 종일 목록 · 시간축)를 가르는 선
          하나. 월 모드에는 요약 자체가 없으니 선도 없다. 토큰과 형태는 DatesPanel.tsx 의 초안
          정밀도 블록이 쓰는 것과 같다(--divider 1px). paddingTop 은 두지 않았다 — 그쪽은 선
          아래에 내용이 바로 붙는 블록의 여백이고, 여기 aside 는 이미 gap(--space-5)으로 양쪽
          간격을 갖는다. 장식이라 aria-hidden. */}
      {briefing && !compact && (
        <div
          aria-hidden
          data-testid="cal-briefing-divider"
          style={{ flex: "none", borderTop: "1px solid var(--divider)" }}
        />
      )}

      {!hasNotes && !hasInlineTasks && !compactAxis && (
        <div style={{ color: "var(--faint)", fontSize: "var(--text-sm)", flex: "none" }}>
          {emptyText}
        </div>
      )}
      {(hasNotes || hasInlineTasks || hasAxis) && (
        <>
          {/* 종일 항목. 날짜가 선택돼 있으면(= 축이 있으면) **가로 스트립**이고, 월 모드는
              예전의 세로 카드 목록 그대로다 — 파일 상단 W14 ①④ 참고. "종일" 라벨은 축이 있을
              때만 붙는다: 시각 있는 항목이 없는 월 모드에서 홀로 뜨면 소음이다. */}
          <AllDayStrip
            items={listItems}
            hasAxis={hasAxis}
            selectedDay={selectedDay}
            axisHandle={axisHandle}
            focusedNoteId={focusedNoteId}
            onFocus={onFocus}
            onOpen={onOpen}
            excerpts={excerpts}
            uiLang={uiLang}
            searchHits={searchHits}
            folderFilter={folderFilter}
            folderById={folderById}
            setDropPreview={setDropPreview}
            onRequestSpanDrop={requestSpanDrop}
          />

          {axisEmptyHint && !compactAxis && (
            <div
              data-testid="cal-time-axis-empty"
              style={{ flex: "none", color: "var(--faint)", fontSize: "var(--text-xs)" }}
            >
              {t("home.cal_axis_empty")}
            </div>
          )}

          {/* W14 ① — 축은 목록 상태와 무관하게 **항상** 있다(옛 `showAxis` 조건이 없어졌다). */}
          {plan && (
            <TimeAxis
              handleRef={axisHandle}
              dropPreview={dropPreview}
              plan={plan}
              day={selectedDay}
              // W11 ③: 칩의 3행 중 마지막 줄(본문 첫 줄)은 **이미 읽어 둔** 발췌를 쓴다 —
              // 종일 카드가 쓰는 그 값이고, 새 IPC 는 없다.
              excerpts={excerpts}
              checklists={checklists}
              onToggleChecklistItem={handleToggleChecklistItem}
              uiLang={uiLang}
              onCreateTimedNote={onCreateTimedNote}
              onFocus={onFocus}
              onOpen={onOpen}
              focusedNoteId={focusedNoteId}
              searchHits={searchHits}
              folderFilter={folderFilter}
              folderById={folderById}
              onRequestConfirm={setConfirm}
              routines={dayRoutines}
              toolbarHint={axisToolbarHint}
              compact={compact}
              tailHours={tailHours}
              tailPlan={tailPlan}
            />
          )}

          {/* Inline Tasks (체크리스트 할 일) Section */}
          {hasInlineTasks && (
            <div
              data-testid="cal-inline-tasks"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
                flex: "none",
                marginTop: "var(--space-2)",
                paddingTop: "var(--space-4)",
                borderTop: "1px solid var(--line)",
              }}
            >
              <SectionLabel text={t("home.cal_inline_tasks")} />
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                {activeInlineTasks.map((task) => (
                  <div
                    key={task.id}
                    data-testid={`cal-inline-task-${task.id}`}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "var(--space-2)",
                      padding: "var(--space-2) var(--space-3)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--line)",
                      background: "transparent",
                    }}
                  >
                    <input
                      type="checkbox"
                      data-testid={`cal-inline-task-checkbox-${task.id}`}
                      checked={task.completed}
                      onChange={() => handleToggleTask(task)}
                      style={{
                        marginTop: "var(--space-2xs)",
                        width: 14,
                        height: 14,
                        flex: "none",
                        accentColor: "var(--accent)",
                        cursor: "pointer",
                      }}
                    />
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: "var(--space-2xs)",
                        cursor: "pointer",
                      }}
                      onClick={() => onFocus(task.noteId)}
                      onDoubleClick={() => onOpen(task.noteId)}
                    >
                      <span
                        style={{
                          fontSize: "var(--text-sm)",
                          color: task.completed ? "var(--faint)" : "var(--text)",
                          textDecoration: task.completed ? "line-through" : "none",
                          wordBreak: "break-word",
                          lineHeight: 1.4,
                        }}
                      >
                        {task.text}
                      </span>
                      <span
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--faint)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={task.noteTitle}
                      >
                        {task.noteTitle}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>

    <AxisConfirmDialog
      confirm={confirm}
      onResolveSpanDrop={resolveSpanDrop}
      onResolveRepeatApply={resolveRepeatApply}
      onResolveDeleteRepeat={resolveDeleteRepeat}
      onResolveDeleteEvent={resolveDeleteEvent}
      onCancel={cancelConfirm}
    />
    </>
  );
}

/**
 * PLAN-2026-10-10 W-E (D5) — 사이드바 "오늘 할 일"의 한 줄 헤더. 오너 요청: 큰 브리핑(연월 /
 * 큰 일·요일 / 날씨 / 요약 / 구분선)이 ≈400px 칼럼의 위쪽을 먹어 세로 시간축이 바닥에 눌려
 * 있었다. 한 줄 = [날짜] [날씨] [공휴일·기념일·요약 (말줄임)] ……… [현재 시각].
 *
 * · 날짜는 Intl 이 로케일 어순으로 만든다(formatToParts) — 문구 키를 새로 만들지 않고, 일 숫자
 *   조각만 `cal-briefing-day` 로 감싸 큰 브리핑과 같은 testid 를 지킨다. UTC 규칙은 브리핑과 같다.
 * · 날씨 라벨은 큰 브리핑·월 그리드처럼 title 툴팁(같은 값은 같은 대접).
 * · 현재 시각은 TimeAxis 의 현재 시각 눈금과 **같은 틱 방식**(readNowTick + 1분 setInterval)이다.
 *   둘은 같은 커밋에서 마운트되므로 함께 넘어간다 — 벽시계 정렬 훅(src/briefing/hooks/useNow)을
 *   여기만 쓰면 축 라벨과 최대 59초 엇갈린다. ponytail: 둘 다 정각 분보다 최대 59초 늦을 수 있다.
 *   고치려면 TimeAxis·여기를 함께 useNow(60_000) 로 옮기고, 그 모듈 스토어가 테스트 사이
 *   setSystemTime 으로 시간이 뒤로 갈 때 낡은 값을 쥐는 문제(resetNowStores)까지 같이 정리한다.
 * · 이 컴포넌트가 따로 있는 이유: 1분 틱의 재렌더를 이 한 줄에 가둔다(본체 전체가 매분 다시
 *   그려지지 않게), 그리고 훅이 조건부로 불리지 않게(compact 일 때만 **마운트**된다).
 */
function CompactDayHeader({
  selectedDay,
  uiLang,
  holidayName,
  markLabel,
  weather,
  summary,
}: {
  selectedDay: string;
  uiLang: string;
  holidayName: string | null;
  markLabel: string | null;
  weather: { code: number; max: number; min: number } | null;
  summary: string;
}) {
  const [nowTick, setNowTick] = useState(readNowTick);
  useEffect(() => {
    const id = setInterval(() => {
      const tick = readNowTick();
      setNowTick(tick);
      // U-8: 대시보드(HomeHeader)가 안 떠 있으면 todayIso 를 갱신하는 곳이 없다 — 자정을 넘기면 여기서 올린다.
      if (useUiStore.getState().todayIso !== tick.todayIso) useUiStore.getState().setTodayIso(tick.todayIso);
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const dateParts = useMemo(
    () =>
      new Intl.DateTimeFormat(uiLang || "en", {
        month: "short",
        day: "numeric",
        weekday: "short",
        timeZone: "UTC",
      }).formatToParts(new Date(`${selectedDay}T00:00:00Z`)),
    [selectedDay, uiLang],
  );
  const visual = weather ? weatherCodeToVisual(weather.code, weather.max) : null;
  const nowText = formatHhmm(nowTick.minutes);
  const nowLabel = t("home.cal_now_time");
  return (
    <div
      data-testid="cal-day-briefing"
      data-variant="compact"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
        fontFamily: "var(--font-heading)",
        fontSize: "var(--text-sm)",
        lineHeight: "var(--lh-tight)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        data-testid="cal-briefing-date"
        style={{ flex: "none", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
      >
        {dateParts.map((p, i) =>
          p.type === "day" ? (
            <span key={i} data-testid="cal-briefing-day">
              {p.value}
            </span>
          ) : (
            p.value
          ),
        )}
      </span>
      {visual && weather && (
        <span
          data-testid="cal-briefing-weather"
          title={`${t(weatherLabelKey(weather.code))} ${Math.round(weather.max)}°/${Math.round(weather.min)}°`}
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            fontSize: "var(--text-xs)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <visual.Icon size={14} strokeWidth={1.8} style={{ color: visual.colorVar, flex: "none" }} />
          <span style={{ color: weatherTempColorVar(weather.max, weather.min) }}>
            {Math.round(weather.max)}°
          </span>
          <span style={{ color: "var(--faint)" }}>{Math.round(weather.min)}°</span>
        </span>
      )}
      {/* 공휴일·기념일·요약 — 좁으면 이 조각만 말줄임으로 줄어든다(날짜·날씨·시각은 안 줄어든다). */}
      <span
        title={[holidayName, markLabel, summary].filter(Boolean).join(" · ")}
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontSize: "var(--text-xs)",
          color: "var(--faint)",
        }}
      >
        {holidayName && (
          <span data-testid="cal-briefing-holiday" style={{ color: toneColor("sun") }}>
            {holidayName}
            {" · "}
          </span>
        )}
        {markLabel && (
          <span data-testid="cal-briefing-mark" style={{ color: "var(--accent)" }}>
            {markLabel}
            {" · "}
          </span>
        )}
        {/* 요약("일정 N개 · 노트 N개")은 여기서 빠졌다 — 날짜·날씨·시각과 한 줄이라 "일정 1개 · 노…"
            로 잘렸다. 축 도구 줄(TimeAxis toolbarHint)이 전문을 말하고, 여기는 툴팁만 남긴다. */}
      </span>
      {selectedDay === nowTick.todayIso && (
      <span
        data-testid="cal-briefing-now"
        title={nowLabel}
        style={{
          flex: "none",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: "var(--text)",
        }}
      >
        {nowText}
      </span>
      )}
    </div>
  );
}
