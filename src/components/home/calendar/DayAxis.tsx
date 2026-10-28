/**
 * 하루 세로 시간축 — `TimeAxis`(축 본체) · `HourRuler`(눈금) · `AxisResizeHandle`(늘리기 손잡이).
 *
 * PLAN-2026-10-19 브리핑 재작성 W1(§4.3) — DayDetailPanel.tsx 에서 **순수 이동**했다(동작·props·
 * testid·클래스·i18n 키 변화 0). 브리핑 창이 달력과 같은 축을 마운트할 수 있게 export 한다.
 * 축이 쓰는 이력(W3~W17·축 확대·하루 전체 보기 등)은 각 자리의 주석과 DayDetailPanel.tsx 상단
 * 주석에 그대로 있다.
 */
import {
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TimelineRoutine } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { type RepeatDraft } from "../../titlebar/scheduleRrule";
import { showUndoToast } from "../../../lib/undo";
import { todayLocal } from "../dateFmt";
import {
  layoutTimedEvents,
  keepDurationMin,
  formatHhmm,
  planLinkedMove,
  planLinkedResize,
  dragTimes,
  planNewRange,
  rowIsSameDay,
  snapStartMin,
  nowLineTop,
  tickIntervalMinFor,
  MIN_SLOT_MIN,
  SNAP_MIN,
  DAY_MIN,
  axisEndMinFor,
  HOUR_ROW_H,
  axisContentPx,
  HANDLE_HIT_PAD,
  handlePadPx,
  mergeTailTimed,
  splitAxisMin,
  TIME_LABEL_W,
  type ChipDragMode,
  type LinkableEvent,
  type TimedDayPlan,
  type TimedEvent,
} from "../calendarLayout";
import {
  useAxisDragSession,
  type DragSession,
  type DragHandlers,
} from "./useAxisDragSession";
import { commitDateRow, planGestureWrites } from "./dateWrite";
import { confirmForDelete, type ConfirmState } from "./useAxisConfirmFlow";
import { type AxisHandle } from "./AllDayStrip";
import { TimeChip, chipLinePx, laneLeft, type ChipChecklist } from "./TimeChip";
import { useAxisAutoScroll } from "./useAxisAutoScroll";
import { useAxisZoom } from "./useAxisZoom";
import { AxisToolbar, NowLine, RoutineBands, TailZone } from "./AxisParts";
import { addDaysIso } from "../dateFmt";
import { ChipEventModal } from "./ChipEventModal";
import { weatherCodeToVisual } from "../../../lib/weather";
import { reconcilePreviews, samePreview, tagPreviews, type MovePreview } from "./pendingMove";

/** 24시간 눈금 — **props 도 상태도 없다.** 드래그 중에는 스냅 칸이 바뀔 때마다 TimeAxis 가
 *  다시 그려지는데, 그때마다 이 24행을 `Array.from` 으로 새로 만들고 있었다(한 번 끄는 동안
 *  수십 번). 눈금은 절대 안 변하므로 memo 로 한 번만 만든다.
 *
 *  W11 ② — 라벨이 행의 가로선 **위에 걸터앉아** 그 선을 자기 배경으로 끊는다(`.cal-tick-label`,
 *  tokens.css). 아래로 반 줄 내려와 있던 라벨을 반 줄 위로 당기면 선이 라벨 좌우에서만 보여
 *  `──09──` 로 읽힌다. 당기는 양은 생 px 이 아니라 글꼴·줄간격 토큰에서 유도한다(--fs 를 키워도
 *  따라온다). **0시만 예외로 당기지 않는다** — 그 선은 캔버스의 맨 위 모서리라 반 줄 위는
 *  스크롤러 밖이고, 라벨이 위쪽 절반만 잘려 보인다.
 *  크기는 --text-label(10.5px) → --text-xs(11px) 한 단 올렸다(오너: "지금보다 약간 더 커도 됨").
 *  pointerEvents: none 은 새로 명시한 것이다 — 라벨에 배경이 생겨 진짜 히트 대상이 됐고, 축의
 *  빈 곳 드래그(②)가 눈금 위에서 시작해도 그대로 열려야 한다. */
/**
 * PLAN-2026-09-13 축 확대 — 눈금이 더 이상 시(60분) 고정이 아니다. `hourRowH`(축의 로컬 확대
 * 배율)에 맞춰 `tickIntervalMinFor`(calendarLayout.ts, 순수 함수 — 유닛 테스트는 거기)가 정하는
 * 세분화 레벨(60→30→15→5분)로 그린다. 정시 눈금은 예전과 **같은 testid**(`cal-hour-label-${h}`)
 * ·같은 라벨("00".."23")을 유지해 기존 회귀가 안 깨지고(기본 배율에선 level 이 그대로 60이라
 * 화면도 100% 그대로다), 그 사이에 낀 눈금만 `cal-tick-label-${min}` 으로 새로 생긴다 — "HH:MM"
 * 라벨(formatHhmm)이라 30/15/5분 중 어느 것을 봐도 몇 시 몇 분인지 바로 읽힌다.
 */
export const HourRuler = memo(function HourRuler({
  hourRowH,
  endMin = DAY_MIN,
  hourWeather,
}: {
  hourRowH: number;
  /** 눈금이 끝나는 분 — 익일 구간이 있으면 24:00 보다 크다(24시 이후는 "00".."03" 로 이어진다). */
  endMin?: number;
  /** 시 눈금 라벨 **아래**에 얹는 시간별 날씨(키 = 축 위의 시, 24 이상은 익일 구간). 브리핑 창만 준다 — 대시보드·사이드바는
   *  시간별 날씨 출처가 없다. 부모가 useMemo 로 안정화해 넘겨야 드래그 중 이 memo 가 깨지지 않는다. */
  hourWeather?: ReadonlyMap<number, { code: number; tempC: number }>;
}) {
  const pxPerMin = hourRowH / 60;
  const level = tickIntervalMinFor(hourRowH);
  const minutes = useMemo(() => {
    const out: number[] = [];
    for (let m = 0; m < endMin; m += level) out.push(m);
    return out;
  }, [level, endMin]);
  // 날씨는 라벨 열(24px) 안, 라벨 **바로 아래** 칸에 앉는다 — 다음 시 라벨까지 한 줄 높이가 남아 아이콘은 들어가고, 온도 글자는
  // 한 시간 높이가 충분히 커진(확대) 뒤에만 아이콘 밑에 붙는다(안 그러면 다음 시 라벨과 겹친다). 온도는 항상 title 로도 닿는다.
  const showWeather = hourWeather !== undefined;
  const showTemp = hourRowH >= WEATHER_TEMP_MIN_ROW_H;
  return (
    <>
      {minutes.map((min) => {
        const hour = Math.floor(min / 60);
        const onHour = min % 60 === 0;
        const wx = showWeather && onHour ? hourWeather.get(hour) : undefined;
        const visual = wx ? weatherCodeToVisual(wx.code, wx.tempC) : null;
        return (
          <div
            key={min}
            style={{
              position: "absolute",
              top: min * pxPerMin,
              left: 0,
              right: 0,
              height: level * pxPerMin,
              borderTop: "1px solid var(--line)",
              display: "flex",
              pointerEvents: "none",
            }}
          >
            {/* 숫자는 **시(時)만** 쓴다(오너 2026-10-27) — 확대해서 30/15/5분 눈금이 생겨도 선만 그리고 라벨은 없다. */}
            {onHour && (
              <span
                className="cal-tick-label"
                data-testid={`cal-hour-label-${hour}`}
                style={{
                  width: TIME_LABEL_W,
                  flex: "none",
                  fontSize: "var(--text-xs)",
                  color: "var(--faint)",
                  ...(min === 0
                    ? {}
                    : { marginTop: "calc(var(--text-xs) * var(--lh-tight) * -0.5)" }),
                }}
              >
                {String(hour % 24).padStart(2, "0")}
              </span>
            )}
            {wx && visual && (
              <span
                className="cal-hour-wx"
                data-testid={`cal-hour-wx-${hour}`}
                title={`${wx.tempC}°`}
                style={{ top: `calc(var(--text-xs) * var(--lh-tight) * ${min === 0 ? 1 : 0.5} + 1px)` }}
              >
                <visual.Icon size={12} strokeWidth={1.8} style={{ color: visual.colorVar }} aria-hidden />
                {showTemp && <span>{wx.tempC}°</span>}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
});

/** 시간별 날씨의 온도 글자를 아이콘 밑에 붙이는 최소 한 시간 높이(px) — 라벨 한 줄 + 아이콘 + 온도가 다음 시 라벨 전에 들어가는 크기. */
const WEATHER_TEMP_MIN_ROW_H = 56;

/**
 * 리사이즈 손잡이 — 칩 몸통과 **떨어진 별도 요소**(오너 요청 2026-09-16, NSSplitView 처방: 보이는 선은 얇게,
 * 히트 영역만 그 선의 좌표에 맞춰 키운다). 칩 몸통은 어디를 잡아도 "이동"이고 리사이즈는 이 손잡이가 전담한다.
 *
 * 2026-10-27 기하 통일 이후 칩의 위·아래 가장자리가 곧 시작·끝 시각이라 손잡이도 칩 가장자리에 정확히 앉는다.
 * 높이가 실제 길이라 짧은 칩(30분 = 14px)이 흔해져서, 히트 폭을 칩 높이에 맞춰 줄인다(`handlePadPx`) — 고정
 * ±6px 이면 두 손잡이(24px)가 14px 칩을 통째로 덮어 짧은 칩을 옮길 수 없게 된다. 가로는 칩의 들여쓰기 칸을
 * 따른다 — 겹친 칩끼리 같은 높이의 손잡이를 서로 빼앗지 않게.
 */

/** 위 손잡이 하나 — 보이는 선은 없다(칩 테두리·시간 눈금이 이미 경계를 말한다, 새 시각 요소를
 *  더하지 않는다). 얇은 선 대신 **투명한 히트 스트립**만 그 자리에 겹쳐 커서와 클릭만 바꾼다. */
export function AxisResizeHandle({
  testId,
  boundaryPx,
  onPointerDown,
  dragHandlers,
  active = false,
  activeLabel,
  pad = HANDLE_HIT_PAD,
  lane = 0,
}: {
  /** 히트 반폭(px) — handlePadPx(칩 높이). */
  pad?: number;
  /** 칩의 겹침 칸 — 손잡이 가로 자리를 칩과 맞춘다. */
  lane?: number;
  /** 이 손잡이를 지금 끌고 있다 — 그립을 켜 둔다. */
  active?: boolean;
  /** 끄는 동안 스냅된 경계 시각("09:45") — 선 옆에 띄운다. */
  activeLabel?: string;
  testId: string;
  /** 캔버스 기준 절대 픽셀 — 이 일정의 시작 또는 끝 시각 자리(= 칩의 위·아래 가장자리). */
  boundaryPx: number;
  onPointerDown: (ev: ReactPointerEvent<HTMLDivElement>) => void;
  /** chipDrag.handlers — 포인터 캡처가 이 요소로 오므로 down 을 받은 바로 그 요소가 나머지도
   *  받아야 한다(useAxisDragSession 의 setPointerCapture, TimeChip 과 같은 이유). */
  dragHandlers: DragHandlers;
}) {
  const [hover, setHover] = useState(false);
  const show = hover || active;
  return (
    <div
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      {...dragHandlers}
      style={{
        position: "absolute",
        top: boundaryPx - pad,
        height: pad * 2,
        left: laneLeft(lane),
        right: 0,
        zIndex: 2,
        cursor: "ns-resize",
        background: "transparent",
      }}
    >
      {/* 보이는 그립 — hover·드래그 때만 경계(boundaryPx = 칩 가장자리)에 얇은 알약을 그린다. */}
      <div
        aria-hidden
        data-testid={`${testId}-grip`}
        style={{
          position: "absolute",
          top: pad - 2,
          left: "50%",
          width: 28,
          height: 4,
          marginLeft: -14,
          borderRadius: "var(--radius-pill)",
          background: "var(--accent)",
          opacity: show ? 1 : 0,
          pointerEvents: "none",
        }}
      />
      {active && activeLabel && (
        <span
          data-testid={`${testId}-label`}
          style={{
            position: "absolute",
            top: pad,
            right: 0,
            transform: "translateY(-50%)",
            padding: "0 var(--space-2)",
            borderRadius: "var(--radius-sm)",
            background: "var(--accent)",
            color: "var(--on-solid)",
            fontSize: "var(--text-xs)",
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
          }}
        >
          {activeLabel}
        </span>
      )}
    </div>
  );
}

export function TimeAxis({
  handleRef,
  dropPreview,
  plan,
  day,
  excerpts,
  checklists,
  onToggleChecklistItem,
  uiLang,
  onCreateTimedNote,
  onFocus,
  onOpen,
  focusedNoteId,
  searchHits,
  folderFilter = null,
  folderById,
  onRequestConfirm,
  routines,
  toolbarHint = null,
  compact = false,
  tailHours = 0,
  hourWeather,
  tailPlan = null,
}: {
  /** W8 ②: 부모의 카드 드롭이 "이 좌표는 몇 분인가"를 묻는 자리. 축이 자기 DOM 을 안 내보낸다. */
  handleRef?: RefObject<AxisHandle | null>;
  /** W7: 끌고 있는(또는 저장을 기다리는) 종일 카드가 놓일 자리. */
  dropPreview?: { title: string; startMin: number } | null;
  plan: TimedDayPlan;
  /** 보고 있는 날(ISO) — ② 의 생성 콜백과 ③ 의 "오늘인가" 판정에 쓴다. */
  day: string | null;
  /** W11 ③: note_id → 본문 발췌(부모가 이미 note_get 으로 읽어 둔 값). 칩의 3행째가 그 **첫
   *  줄만** 쓴다 — 없으면 그 줄을 아예 그리지 않는다(칩 높이는 실제 길이라 레이아웃은 안 흔들린다). */
  excerpts: Record<string, string>;
  /** note_id → 그 노트 첫 text 섹션의 체크리스트 줄들 — 발췌와 같은 note_get 왕복의 부산물
   *  (추가 IPC 0). 없으면 칩에 sub-list 를 아예 그리지 않는다(체크박스 없는 칩은 높이 그대로). */
  checklists: Record<string, ChipChecklist>;
  /** 체크박스 클릭 — 낙관적 토글 + 실패 시 되돌리기는 부모(handleToggleChecklistItem)가 갖는다. */
  onToggleChecklistItem: (
    noteId: string,
    sectionId: string,
    lineIndex: number,
    currentChecked: boolean,
  ) => void;
  /** 반복 요약·요일 라벨용. 부모가 이미 구독하고 있어 여기서 스토어를 또 읽지 않는다. */
  uiLang: string;
  onCreateTimedNote?: (day: string, startMin: number, endMin: number) => void;
  /** Single-click focus (map view pattern) — outlined in place, never opens. */
  onFocus: (noteId: string) => void;
  /** Double-click — opens the note tab. */
  onOpen: (noteId: string) => void;
  focusedNoteId: string | null;
  searchHits: Set<string> | null;
  folderFilter?: string | null;
  folderById?: Map<string, { color_hue: number | null }>;
  /** D4·D5 — 반복 적용/삭제는 축 자신이 결정하지 않는다. 확인이 필요하면 이 콜백으로 부모
   *  (DayDetailPanel)에 요청만 하고, 부모가 하나뿐인 모달 state 를 갖는다(GRILL §3). */
  onRequestConfirm: (state: ConfirmState) => void;
  /** 그릴 2026-09-13 W3 — 이 날 요일에 걸리는 시간축 배경 루틴(노트에 안 묶임, 이미 요일로
   *  걸러진 목록). v1: 클릭·드래그·리사이즈 전부 없음 — 순수 배경 장식이라 이 배열은 부모가
   *  IPC로 받아 넘겨줄 뿐, 이 축은 저장을 전혀 모른다. */
  routines: TimelineRoutine[];
  /** W-E compact — 도구 줄 왼쪽의 짧은 안내(없으면 줄은 예전처럼 오른쪽 버튼 하나). */
  toolbarHint?: ReactNode;
  /** 사이드바 변형 — 오늘이면 도구 줄에 "다음 HH:MM"을 더하고, 축 아래에 여백을 둬 지금 시각이
   *  바닥에 눌려 잘리지 않게 한다. */
  compact?: boolean;
  /** 익일 구간 — 24시 아래에 다음 날 00시부터 이 시각까지를 이어 붙인다(0 = 당일만). 설정 `calendar_axis_tail_hours`
   *  를 세 마운트(대시보드·사이드바·브리핑)가 같은 방식으로 넘긴다. 이 안에서 만들기·옮기기·늘리기가 된다. */
  tailHours?: number;
  /** 다음 날의 plan(`day` + 1 기준) — 구간 안에서 시작하는 일정만 쓴다. 없으면 구간은 비어 있다(만들기는 된다). */
  tailPlan?: TimedDayPlan | null;
  /** 시 눈금 라벨 아래에 얹는 시간별 날씨(키 = 0~23 시, 오늘만) — 브리핑 창이 준다. useMemo 로 안정화해 넘길 것(HourRuler memo). */
  hourWeather?: ReadonlyMap<number, { code: number; tempC: number }>;
}) {
  // 스크롤러(보이는 창)와 캔버스(672px 전체) — 둘 다 **축 안에서만** 산다(W8 ②).
  const axisRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // ── 축 확대 · 기본 스크롤 · 하루 전체 보기 ── useAxisZoom.ts (배율은 이 축 인스턴스만의 로컬 state 다)
  /** 축의 끝 분 — **하루 끝에 기대던 모든 clamp 의 단일 출처**. 당일만이면 24:00, 익일 구간이 있으면 그만큼 늘어난다. */
  const axisEndMin = day ? axisEndMinFor(tailHours) : DAY_MIN;
  const tailMinutes = axisEndMin - DAY_MIN;
  // 사이드바(compact) — 당일만 보일 때 캔버스 아래 3행 여백. 늦은 밤엔 스크롤 끝이 24:00 이라 지금 시각이 항상
  // 창 바닥에 붙었고(보이는 창이 실측보다 낮으면 화면 밖), 여백이 있으면 지금을 위쪽에 둘 수 있다. 익일 구간이
  // 있으면 그 구간이 여백을 대신한다(아래에 빈 공간이 남지 않는다).
  // ponytail: 여백은 배율을 따라간다. 창 높이를 ResizeObserver 로 따라 재정렬하지는 않는다.
  const tailRows = compact && tailMinutes === 0 ? 3 : 0;
  const firstMin = plan.timed[0]?.startMin ?? null; // 익일 구간이 아니라 당일 첫 일정
  // ③ 현재 시각 눈금 — 1분 틱. 공용 훅을 새로 만들지 않는다(HomeHeader.tsx 가 같은 일을 지역
  // setInterval 로 한다). uiStore.todayIso 는 **날짜**만 있어 분 위치를 못 주므로 여기서 읽는다.
  // 자정을 넘어가면 todayLocal().day 가 바뀌어 눈금이 알아서 사라진다 — 분기 코드가 따로 없다.
  const [nowTick, setNowTick] = useState(readNowTick);
  useEffect(() => {
    const id = setInterval(() => setNowTick(readNowTick()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { hourRowH, hourRowHRef, wholeDayView, toggleWholeDayView } = useAxisZoom({
    axisRef,
    day,
    axisEndMin,
    tailRows,
    compact,
    firstMin,
    nowTick,
  });
  const dayAxisH = (hourRowH * axisEndMin) / 60;
  const pxPerMin = hourRowH / 60;
  /** 이 축에 그려지는 모든 일정 — 당일 + 익일 구간 안에서 시작하는 것(좌표는 당일 00:00 기준, 익일 것은 +24:00). 키는
   *  그대로다(date_id|시작 — 두 날에 같은 키가 나오지 않는다). 아래의 plan.timed 쓰임은 전부 이것으로 바뀌었다. */
  const timed = useMemo<TimedEvent[]>(
    () => mergeTailTimed(plan.timed, tailPlan, tailMinutes),
    [plan.timed, tailPlan, tailMinutes],
  );
  const tailDay = day && tailMinutes > 0 ? addDaysIso(day, 1) : null;

  /** 그릴 때만 쓰는 값 — 드래그 중 미리보기이자 드롭 직후의 낙관적 위치.
   *
   *  W15 — **칩 하나가 아니라 목록이다.** 맞닿은 이웃이 같이 움직이므로(연동 이동) 한 제스처가
   *  여러 칩의 자리를 바꾼다. 빈 배열 = 미리보기 없음(예전의 null). 보통의 경우는 길이 1 이다. */
  const [pendingMove, setPendingMove] = useState<MovePreview[]>([]);
  const [newRange, setNewRange] = useState<{ startMin: number; endMin: number } | null>(null);
  /** 칩 드래그가 열려 있는 동안만 — 어느 칩을 어느 모드로 끄는가(손잡이 라벨·15분 격자 표시용). 시작·끝에만
   *  바뀐다. 칩 자체는 pendingMove(스냅 값)로 그려진다 — 2026-10-27 기하 통일: 손 따라가는 칩 + 고스트 두 벌이
   *  서로 다른 자리에 서던 것을, **칩 하나가 곧 놓을 자리**로 합쳤다. */
  const [dragInfo, setDragInfo] = useState<{ key: string; mode: ChipDragMode } | null>(null);
  /** 직전에 보인 스냅 결과 — 칸 경계 히스테리시스(SNAP_HYSTERESIS)와, 놓을 때 화면과 같은 값을 저장하기 위한 기준. */
  const lastSnapRef = useRef<{ startMin: number; endMin: number } | null>(null);

  /** 일정 수정 모달이 열려 있는 칩(⚙ 버튼 또는 롱프레스). **축 전체에 하나뿐**이다. 새 데이터가 와도 닫지 않는다 —
   *  저장하면 모달이 스스로 닫는다. 칩 객체는 열 때의 스냅샷이다(모달이 떠 있는 동안 재조회가 와도 입력 초깃값은 안 바뀐다). */
  const [editing, setEditing] = useState<TimedEvent | null>(null);

  const nowTop = day === null ? null : nowLineTop(day, nowTick.todayIso, nowTick.minutes, hourRowH);
  // 사이드바: 오늘의 다음 시각 일정(지금 이후 시작) — "시간 표현" 한 조각. plan.timed 는 시작순이다.
  const nextEvent =
    compact && day === nowTick.todayIso ? (plan.timed.find((e) => e.startMin >= nowTick.minutes) ?? null) : null;

  // 새 데이터가 오면(저장 → bump → 재조회) 낙관적 위치를 **행 단위로** 판정한다 — 당일 plan 과 익일 plan 은 서로 다른 조회에서 따로 도착해,
  // 먼저 온 쪽의 옛 자리가 방금 끌어 놓은 칩을 튀게 했다(pendingMove.ts::reconcilePreviews 머리 주석).
  // timedRef/pendingRef 는 렌더마다 갱신하는 최신값 — 콜백(commitTimes·onMove)이 낡은 목록을 쥐지 않게 한다.
  const timedRef = useRef(timed);
  timedRef.current = timed;
  const pendingRef = useRef(pendingMove);
  pendingRef.current = pendingMove;
  useEffect(() => {
    setPendingMove((cur) => reconcilePreviews(cur, timed) as MovePreview[]);
  }, [timed]);
  // 다른 날로 가면 남은 미리보기는 그 날의 것이 아니다.
  useEffect(() => {
    setPendingMove([]);
  }, [day]);

  // ── W17: 가장자리 자동 스크롤 ── useAxisAutoScroll.ts (세 드래그가 같은 규칙을 쓴다)
  const { trackAutoScroll, stopAutoScroll, dragDeltaPx } = useAxisAutoScroll(
    axisRef,
    axisContentPx(hourRowH, axisEndMin, tailRows),
  );

  /** 포인터가 축의 **보이는 영역** 안이면 그 자리의 시작 분, 밖이면 null(= 아무 일도 없다).
   *  히트 판정은 스크롤러 rect(보이는 창), 분 계산은 캔버스 rect(672px 전체) 로 나뉜다 —
   *  스크롤된 만큼 캔버스가 위로 밀려 있어 두 값이 다르다. 함정 ⓐ 와 같은 이유로 시각은
   *  픽셀에서만 구한다(스냅·하루 clamp 는 snapStartMin 이 이미 한다). */
  useImperativeHandle(
    handleRef,
    () => ({
      startMinAt: (clientX, clientY) => {
        const box = axisRef.current?.getBoundingClientRect();
        const canvas = canvasRef.current?.getBoundingClientRect();
        if (!box || !canvas) return null;
        if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
          return null;
        }
        // hourRowH 는 state 라 이 얼린 클로저 안에서 직접 읽으면 낡는다 — ref 로 읽는다
        // (hourRowHRef, 위 축 확대 블록에서 매 렌더 갱신).
        return snapStartMin(0, clientY - canvas.top, MIN_SLOT_MIN, hourRowHRef.current);
      },
      // 나머지 둘이 건네는 자동 스크롤 함수는 첫 렌더의 것이지만, 렌더마다 바뀌는 값(스크롤 영역 높이)을 훅이 ref 로 읽으므로 낡지 않는다
      // (useAxisAutoScroll 머리 주석).
      trackDragAt: (clientY, resync) => trackAutoScroll(clientY, resync),
      stopAutoScroll: () => stopAutoScroll(),
    }),
    [],
  );

  /**
   * 시각을 옮기거나(mode "move") 시작·끝을 따로 늘려(mode "start"/"end") 저장한다. 드롭 즉시 새
   * 자리를 그려 뒀으므로 실패하면 되돌린다(CLAUDE.md §9). 함정 ⓑ(전량 교체 페이로드는 화면
   * 값이 아니라 DB 행 기준)는 commitDateRow 가 한 지점에서 지킨다.
   */
  const commitTimes = async (
    e: TimedEvent,
    mode: ChipDragMode,
    next: { startMin: number; endMin: number },
    /** W15 — 같이 움직이는 이웃들의 새 자리. move 는 맞닿은 체인 전부(연동 이동), 손잡이 리사이즈
     *  는 맞닿은 이음새 하나뿐(오너 요청 2026-09-16, planLinkedResize)이다. 무엇을 어디에 쓰는지는
     *  dateWrite::planGestureWrites(순수)가 계산하고, 이 함수는 그 목록대로 쓰고 화면·롤백·토스트만 맡는다. */
    linked: MovePreview[] = [],
  ) => {
    setPendingMove(tagPreviews([{ key: e.key, ...next }, ...linked], pendingRef.current, timedRef.current));
    // 이웃의 행 id·현재 자리 — 키로 찾는다.
    const neighbors = new Map(
      timed.map((x) => [x.key, { noteId: x.item.note_id, dateId: x.item.date_id, startMin: x.startMin }]),
    );
    const [primary, ...rest] = planGestureWrites({
      chip: { noteId: e.item.note_id, dateId: e.item.date_id, startMin: e.startMin },
      mode,
      next,
      linked,
      neighbors,
      day,
      hourRowH,
    });
    // 되돌리기는 **한 토스트로 묶는다** — 연동된 항목 전부가 한 사용자 동작이다(commitDateRow 의
    // collectUndo 주석). 단일 칩도 같은 길을 지난다: 갈래를 둘로 두면 하나가 조용히 썩는다.
    const reverts: (() => void)[] = [];
    const collect = (revert: () => void) => reverts.push(revert);
    let label = t("home.cal_time_changed");
    const ok = await commitDateRow(
      primary.noteId,
      primary.dateId,
      (row) => {
        const r = primary.patch(row);
        if (!r) return null;
        // move 가 행에서 얻은 길이로 다시 죈 시작이 미리보기와 다르면 미리보기를 그 값으로 고친다(비순수라 계획 밖).
        if (r.settledStartMin != null) {
          const settled = r.settledStartMin;
          setPendingMove((cur) =>
            cur.map((p) =>
              p.key === e.key
                ? { ...p, startMin: settled, endMin: settled + (next.endMin - next.startMin) } // row/from 꼬리표를 잃지 않는다
                : p,
            ),
          );
        }
        if (r.label) label = r.label;
        return r.fields;
      },
      undefined,
      collect,
    );
    if (!ok) {
      setPendingMove([]); // 롤백 — call() 이 이미 토스트했다. 이웃도 아직 쓰지 않았다.
      return;
    }
    // 이웃은 각자 자기 DB 행을 읽어 쓴다(함정 ⓑ 그대로).
    for (const w of rest) {
      await commitDateRow(w.noteId, w.dateId, (row) => w.patch(row)?.fields ?? null, undefined, collect);
    }
    if (reverts.length > 0) {
      showUndoToast(label, () => {
        for (const revert of reverts) revert();
      });
    }
  };

  /** 그 날 안에서 끝나는 행만 손잡이를 갖는다 — 이유는 calendarLayout::handlePadPx 참고.
   *  판정은 행 모양(rowIsSameDay)이다 — 월 경계로 잘린 span_start/span_end 는 여러 날 행을
   *  하루처럼 보이게 한다. TimeChip 의 `resizable` 과 같은 규칙이어야 한다. */
  const isResizable = (e: TimedEvent) => rowIsSameDay(e.item);

  /** D4(그릴 2026-09-11) — 반복 편집은 더 이상 여기서 즉시 커밋하지 않는다. 일정 수정 모달(ChipEventModal)이
   *  반복이 바뀐 채 저장되면 스스로 닫은 뒤(모달 위 모달 금지) 이 콜백으로 확인을 DayDetailPanel 에
   *  요청한다 — 실제 저장(commitDateRow)과 사후 판정은 그 확인이 끝난 뒤 부모의
   *  resolveRepeatApply 가 한다(같은 파일, 위 참고). */
  const onRepeatApply = (e: TimedEvent, draft: RepeatDraft) => {
    onRequestConfirm({
      kind: "repeatApply",
      key: e.key,
      noteId: e.item.note_id,
      dateId: e.item.date_id,
      // day prop 이 곧 이 축이 보여주는 selectedDay 다 — 익일 구간의 칩도 같은 값이다(사후 판정이 "아직 그 날을 보고 있나"를 이 값으로 가르고,
      // 칩 찾기는 합친 목록에서 한다 — useAxisConfirmFlow). e.item.span_start 는 매달 1일에 잘린 값일 수 있어 폴백으로만 남긴다.
      day: day ?? e.item.span_start,
      inTail: e.startMin >= DAY_MIN,
      draft,
    });
  };

  /** 점선 미리보기 블록 하나 — W7 의 드롭이 있으면 그것, 없으면 ② 의 새 범위. 둘이 동시에 뜨는
   *  일은 없다(하나는 카드에서, 하나는 축의 빈 곳에서 시작하는 제스처다). 칩 끌기에는 고스트가 없다 — 칩
   *  자신이 스냅된 자리에 선다. */
  const ghost = dropPreview
    ? {
        testid: "cal-time-drop",
        startMin: dropPreview.startMin,
        endMin: dropPreview.startMin + MIN_SLOT_MIN,
        label: `${formatHhmm(dropPreview.startMin)} ${dropPreview.title}`,
      }
    : newRange
      ? {
          testid: "cal-time-new-range",
          startMin: newRange.startMin,
          endMin: newRange.endMin,
          label: `${formatHhmm(newRange.startMin)}–${formatHhmm(newRange.endMin)}`,
        }
      : null;

  /**
   * W15 — 맞닿음 판정과 자정 경계가 보는 **지금 화면의 자리**. 미리보기가 있으면 그 값이 진실이다
   * (키보드를 연달아 누르면 그렇게 누적된다). 드래그는 이것을 **잡는 순간 한 번** 얼려 세션에
   * 담는다 — 끄는 동안 주 칩의 미리보기가 갱신되므로, 매 이동마다 다시 읽으면 이웃과의 맞닿음이
   * 첫 이동에서 곧바로 끊긴다.
   */
  const chipPositions = (): LinkableEvent[] =>
    timed.map((ev) => {
      const p = pendingMove.find((x) => x.key === ev.key);
      return {
        key: ev.key,
        startMin: p?.startMin ?? ev.startMin,
        endMin: p?.endMin ?? ev.endMin,
        linkable: isResizable(ev),
        // 날짜를 못 바꾸는 일정(여러 날 span · 반복 행)은 익일 구간이 있어도 자기 날 안에서만 움직인다.
        locked: !isResizable(ev) || !!ev.item.rrule,
        // planLinkedResize 만 본다(위 LinkableEvent 주석) — 이 칩의 end_time 이 실제로 있는지.
        hasEnd: ev.item.end_time != null,
      };
    });

  /**
   * 드래그(또는 키보드 한 번)의 결과 — 주 칩의 새 시각(dragTimes)과, 같이 따라오는 이웃들.
   * move 는 밀려난 이웃 전부(planLinkedMove — 겹친 만큼만 밀고 연쇄), 리사이즈 손잡이는 겹치거나 맞닿은 이웃 하나(줄어듦)
   * (planLinkedResize, 오너 요청 2026-09-16 — "이음새를 끌면 양쪽이 같이 반응해야 한다").
   * 리사이즈는 이웃이 있으면 `next` 도 그 이웃의 최소 길이만큼 다시 죈다(planLinkedResize 가
   * 함께 돌려준다) — 그래서 `next` 를 그 함수의 반환으로 덮어쓴다.
   */
  const plannedMove = (
    base: {
      key: string;
      startMin: number;
      endMin: number;
      durationMin: number;
      mode: ChipDragMode;
      positions: LinkableEvent[];
    },
    deltaPx: number,
    prev?: { startMin: number; endMin: number } | null,
  ) => {
    const locked = base.positions.find((p) => p.key === base.key)?.locked;
    const rawNext = dragTimes(base.mode, base, deltaPx, hourRowH, prev ?? undefined, { axisEndMin, locked });
    if (base.mode === "move") {
      // 이웃을 밀어내며 가므로 벽(밀 수 없는 이웃·축의 끝·자정 너머) 앞에서 델타가 줄 수 있다 — 칩의 자리도 그 델타로 다시 구한다.
      const { deltaMin, linked } = planLinkedMove(
        base.positions,
        base.key,
        rawNext.startMin - base.startMin,
        axisEndMin,
      );
      const startMin = base.startMin + deltaMin;
      return { next: { startMin, endMin: startMin + (base.endMin - base.startMin) }, linked };
    }
    const { next, linked } = planLinkedResize(base.positions, base.key, base.mode, rawNext);
    return { next, linked };
  };

  // ── ① 칩을 위아래로 끌어 시각 바꾸기 (W3, 손잡이는 W5 ①) ─────────────────────────────────
  // 세션에 담는 값이 곧 dragTimes 의 base 다 — 잡은 순간 정해지고 드래그 중에 안 바뀐다.
  /** 세로 이동만 뜻이 있어 임계도 세로만 본다(axis "y") — 가로로만 흔들면 클릭으로 남는다. */
  const chipDrag = useAxisDragSession<{
    event: TimedEvent;
    key: string;
    startMin: number;
    /** 화면에 그려진 끝(= MIN_SLOT_MIN 까지 늘려진 값). 미리보기 높이는 이걸로 센다. */
    endMin: number;
    durationMin: number;
    /** 잡은 자리가 정한다 — 위 가장자리 = 시작, 아래 = 끝, 가운데 = 이동. */
    mode: ChipDragMode;
    /** W15 — 잡는 순간 얼린 그 날의 칩 자리들(연동 판정용, chipPositions 주석 참고). */
    positions: LinkableEvent[];
    /** W17 — 잡은 순간의 스크롤. 자동 스크롤이 축을 민 양을 여기서 뺀다(dragDeltaPx). */
    scrollTop0: number;
  }>({
    axis: "y",
    onMove: (s) => {
      // 자동 스크롤의 틱도 **이 함수를 그대로** 다시 부른다 — 세션 값(clientY)은 그대로고
      // dragDeltaPx 가 새 scrollTop 을 읽으므로, 축이 흐른 만큼 미리보기가 따라온다.
      const apply = () => {
        const deltaPx = dragDeltaPx(s.dy, s.data.scrollTop0);
        // 칩 자체가 15분 스냅(+히스테리시스) 자리에 선다 — 이징 없이 칸을 넘을 때만 옮겨 간다. 화면 = 저장 값.
        const { next, linked } = plannedMove(s.data, deltaPx, lastSnapRef.current);
        lastSnapRef.current = next;
        setPendingMove((cur) => {
          const nextPreview = tagPreviews([{ key: s.data.key, ...next }, ...linked], pendingRef.current, timedRef.current);
          return samePreview(cur, nextPreview) ? cur : nextPreview;
        });
      };
      setDragInfo((cur) =>
        cur && cur.key === s.data.key && cur.mode === s.data.mode ? cur : { key: s.data.key, mode: s.data.mode },
      );
      trackAutoScroll(s.clientY, apply);
      apply();
    },
    onDrop: (s) => {
      stopAutoScroll();
      // 마지막으로 보인 칸을 기준으로 다시 계산한다 — 놓은 자리가 화면의 칩과 다르면 안 된다.
      const { next, linked } = plannedMove(
        s.data,
        dragDeltaPx(s.dy, s.data.scrollTop0),
        lastSnapRef.current,
      );
      endDrag();
      if (next.startMin === s.data.startMin && next.endMin === s.data.endMin) {
        setPendingMove([]);
        return;
      }
      void commitTimes(s.data.event, s.data.mode, next, linked);
    },
    onCancel: () => {
      stopAutoScroll();
      endDrag();
      setPendingMove([]);
    },
    // 칩 몸통을 움직이지 않고 길게 눌렀다 뗐다 = 일정 수정 모달(오너 2026-10-27). 리사이즈 손잡이의 긴 누름은 무시한다.
    onLongPress: (d) => {
      if (d.mode === "move") setEditing(d.event);
    },
  });

  /** 드래그가 끝났다(놓음·취소·Esc). */
  const endDrag = () => {
    lastSnapRef.current = null;
    setDragInfo(null);
  };

  const onChipPointerDown = (e: TimedEvent, ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    // 칩 위에서 시작한 드래그는 ①(시각 조정)이지 ②(빈 곳에 추가)가 아니다 — 축 컨테이너로
    // 새면 노트가 생긴다.
    ev.stopPropagation();
    // 오너 실기 2026-09-16 — 칩 몸통은 이제 어디를 잡아도 항상 "이동"이다(위 HANDLE_HIT_PAD
    // 주석). 리사이즈는 AxisResizeHandle(아래 onHandlePointerDown)이 전담한다.
    lastSnapRef.current = null;
    chipDrag.begin(
      {
        event: e,
        key: e.key,
        startMin: e.startMin,
        endMin: e.endMin,
        durationMin: keepDurationMin(e.item.start_time, e.item.end_time, isResizable(e)),
        mode: "move",
        positions: chipPositions(),
        scrollTop0: axisRef.current?.scrollTop ?? 0,
      },
      ev,
    );
  };

  /** 리사이즈 손잡이(AxisResizeHandle)의 pointerdown — 어느 손잡이인지가 곧 mode 라 칩 몸통처럼
   *  좌표로 되짚을 필요가 없다. 나머지(포지션 얼리기·스크롤 기준점)는 몸통과 같다. */
  const onHandlePointerDown = (
    e: TimedEvent,
    mode: "start" | "end",
    ev: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    lastSnapRef.current = null;
    chipDrag.begin(
      {
        event: e,
        key: e.key,
        startMin: e.startMin,
        endMin: e.endMin,
        durationMin: keepDurationMin(e.item.start_time, e.item.end_time, true),
        mode,
        positions: chipPositions(),
        scrollTop0: axisRef.current?.scrollTop ?? 0,
      },
      ev,
    );
  };

  // ── ② 축의 빈 곳을 끌어 그 자리에서 노트 만들기 ────────────────────────────────────────
  // 세션에 담는 것은 **캔버스의 top** 뿐 — planNewRange 는 컨테이너 기준 픽셀 둘만 본다.
  // W17 — 시작점(y0 - topPx)은 **잡은 순간의 캔버스 기준 픽셀**이라 축이 흘러도 그대로 두고,
  // 움직이는 끝만 스크롤을 더해 민다. 그래서 topPx 는 여기서 계속 캐시해도 맞다.
  /** 끌고 있는 끝의 캔버스 기준 픽셀 = 시작점 + (손짓 + 자동 스크롤이 민 양). */
  const createEndPx = (s: DragSession<{ topPx: number; scrollTop0: number }>) =>
    s.y0 - s.data.topPx + dragDeltaPx(s.dy, s.data.scrollTop0);
  const createDrag = useAxisDragSession<{ topPx: number; scrollTop0: number }>({
    onMove: (s) => {
      const apply = () => setNewRange(planNewRange(s.y0 - s.data.topPx, createEndPx(s), hourRowH, axisEndMin));
      trackAutoScroll(s.clientY, apply);
      apply();
    },
    onDrop: (s) => {
      stopAutoScroll();
      setNewRange(null);
      if (!day) return;
      const range = planNewRange(s.y0 - s.data.topPx, createEndPx(s), hourRowH, axisEndMin);
      if (!range) return; // 임계 미만 = 그냥 클릭. 아무것도 만들지 않는다.
      // 놓는 **그 순간** 만든다(PLAN-2026-09-10 D3) — 그리고 effect 가 아니라 이 핸들러에서:
      // effect 로 옮기면 StrictMode 이중 발화로 노트가 둘 생긴다(useCalendarDrag 의 같은 결정).
      // W9 ①: 이 경로에는 되돌리기 토스트를 달지 않았다. 나머지 다섯은 "시각을 바꾸는" 것이라
      // 되돌리기가 옛 시각으로 다시 쓰는 일이지만, 여기는 **노트를 만드는** 것이라 되돌리기가
      // "방금 만든 노트를 지우기"가 된다 — 성격이 다르고(삭제는 휴지통·복원 규율을 탄다) 만든
      // 노트는 CalendarTab 이 소유한다. 필요해지면 그 소유자 쪽에서 붙인다.
      // 익일 구간에서 만들면 날짜가 다음 날이고 시각은 그 날의 분이다 — 부모(세 마운트)는 이 변환을 모른다.
      const at = splitAxisMin(range.startMin, day, tailDay);
      const shift = range.startMin - at.min; // 익일 구간이면 DAY_MIN, 아니면 0
      onCreateTimedNote?.(at.day ?? day, at.min, range.endMin - shift);
    },
    onCancel: () => {
      stopAutoScroll();
      setNewRange(null);
    },
  });

  const onAxisPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!day || !onCreateTimedNote) return;
    createDrag.begin(
      {
        topPx: ev.currentTarget.getBoundingClientRect().top,
        scrollTop0: axisRef.current?.scrollTop ?? 0,
      },
      ev,
    );
  };

  /** 축 확대 — `plan.timed` 는 부모(DayDetailBody)가 **기본** 스케일(HOUR_ROW_H)로 계산해 내려준
   *  것이라, 그 안의 `top`/`height` 는 이 축이 지금 보여줄 배율과 다를 수 있다. 시작~끝 분은 스케일과
   *  무관하므로 픽셀만 지금 hourRowH 로 다시 구한다(인덱스로 plan.timed 와 짝지어 쓴다). 들여쓰기 칸은
   *  **확정된 시각**으로만 정한다 — 끄는 동안 미리보기로 다시 정하면 이웃들의 칸이 손짓마다 뒤바뀐다. */
  /** 칩마다 `pendingMove.find` 를 돌리던 O(칩×미리보기)를 렌더당 한 번 만드는 Map 으로. */
  const pendingByKey = new Map(pendingMove.map((p) => [p.key, p]));
  const timedLayout = useMemo(
    () => layoutTimedEvents(timed, hourRowH),
    [timed, hourRowH],
  );
  /** 칩 한 줄의 픽셀 높이 — 칩이 몇 줄을 보일지(TimeChip 의 표시 단계) 가르는 기준. 글꼴 배율(--fs)을 따른다. */
  const linePx = chipLinePx();
  /** 끄는 동안만 보이는 스냅 격자 간격(분) — 15분이 너무 촘촘하면(6px 미만) 30·60분으로 굵힌다. */
  const gridMin = [SNAP_MIN, 30, 60].find((m) => m * pxPerMin >= 6) ?? null;
  const showGrid = (dragInfo !== null || newRange !== null) && gridMin !== null;

  return (
    <div
      style={{
        flex: 1,
        // 축의 바닥 — 위 목록이 길어도 6시간치는 남는다. 종일 목록의 옛 40% 캡을 대신하는
        // 규칙이고(오너 실기 2026-09-10), 눈금 높이에서 유도하므로 생 px 이 아니다.
        minHeight: HOUR_ROW_H * 6,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      {/* 오너 요청(2026-09-16) — "하루 전체 보기": 사이드바 축은 보이는 창이 ~168px(≈6시간)뿐이라
          하루를 보려면 계속 스크롤해야 한다는 피드백. **실제 레이아웃 행**(flex:"none")으로 두어
          스크롤 영역 위에 떠서 칩(특히 스크롤 맨 위에 걸린 칩의 설정 아이콘)을 가리지 않는다 —
          absolute 오버레이는 스크롤 위치에 따라 매번 다른 칩과 겹치므로 쓰지 않았다. */}
      <AxisToolbar
        toolbarHint={toolbarHint}
        nextStartMin={nextEvent ? nextEvent.startMin : null}
        wholeDayView={wholeDayView}
        onToggleWholeDayView={toggleWholeDayView}
      />
      {/* The time section carries no label of its own — §7.8 defines no key for one, the hour
          column already says what this is. Vertical stacking means nothing is ever hidden here
          (unlike the month cell's "+n"), so there's no overflow count to show. */}
      <div
        ref={axisRef}
        data-testid="cal-time-axis"
        // 오너 요청(2026-09-16) — 마우스를 가만히 올리면(네이티브 title 툴팁) Ctrl+휠 확대/축소를
        // 알려준다. title 은 포인터 이벤트를 막지 않으니 드래그·클릭은 그대로 산다.
        title={t("home.cal_axis_zoom_hint")}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
      >
        <div
          ref={canvasRef}
          data-testid="cal-time-axis-canvas"
          onPointerDown={onAxisPointerDown}
          {...createDrag.handlers}
          // touchAction 은 여기서 걸지 않는다 — 평소엔 터치로 축을 스크롤할 수 있어야 한다.
          // W9 ③: 터치는 길게 눌러야 드래그가 열리고, **그 순간** 훅이 touch-action 을 막는다.
          style={{ position: "relative", height: dayAxisH }}
        >
          <HourRuler hourRowH={hourRowH} endMin={axisEndMin} hourWeather={hourWeather} />
          {/* 익일 구간 — 자정에 눈에 띄는 구분선(일반 눈금선보다 굵게) + 다음 날 날짜 라벨, 구간 전체는 옅은 면으로 구분한다.
              칩보다 뒤(DOM 순서)·포인터 없음이라 만들기 드래그가 이 위에서 그대로 시작된다. */}
          {tailMinutes > 0 && tailDay && <TailZone tailMinutes={tailMinutes} tailDay={tailDay} pxPerMin={pxPerMin} />}
          {/* 그릴 2026-09-13 W3 — 시간축 배경 루틴("출퇴근" 등, 노트에 안 묶임). 칩(테두리 있는
              카드)보다 뒤(zIndex 0, DOM 순서도 먼저라 칩이 자연히 위에 그려진다)에 테두리 없는
              옅은 배경 면으로 얹는다 — 노트 일정과 시각적으로 명확히 구분된다. v1 범위: 클릭해도
              아무 일도 안 하고(onClick 없음), 드래그·리사이즈도 없다 — pointerEvents:none 으로
              애초에 포인터 이벤트를 안 받아 축의 드래그(빈 곳 새 범위 만들기 등)를 가리지도
              않는다. 색은 C1(64c1b269) 이후의 color-mix 관례 — 인라인 var(--surface/--overlay/
              --bg) 는 쓰지 않는다.
              오너 실기 2026-09-16 — 제목을 띠 상단 중앙에 그린다(전에는 툴팁으로만 있어 호버
              전엔 어느 루틴인지 안 보였다). 배경 없는 텍스트라 표면 계약과 무관하다. */}
          <RoutineBands routines={routines} pxPerMin={pxPerMin} />
          {/* ③ 오늘의 현재 시각 — accent 선. 칩보다 **위**(zIndex 1)라 겹쳐도 가려지지
              않지만, 같은 zIndex 를 쓰는 드래그 중인 칩은 DOM 순서상 뒤라 그 아래에 남는다.
              W10 ①(오너 실기 2026-09-11): 1px 실선은 안 보였다 — 2px + 맥동 발광(.cal-now-line,
              tokens.css)에 현재 시각 라벨 하나. 라벨은 눈금 열(TIME_LABEL_W)이 아니라 **선의
              오른쪽 끝**에 붙는다: 그 열엔 이미 시(`02`)가 있어 같은 자리에서 두 숫자가 싸운다.
              pointerEvents 는 그대로 none — 라벨도 상속받아 드래그를 가로막지 않는다. */}
          {nowTop !== null && <NowLine nowTop={nowTop} minutes={nowTick.minutes} />}
          {/* 끄는 동안만 — 칩이 붙을 수 있는 스냅 칸을 옅은 가로줄로 보인다(평소 눈금은 1시간 단위라 15분 칸이
              안 보여, 어디에 붙을지 미리 알 수 없었다). 칩보다 뒤, 포인터 이벤트 없음. */}
          {showGrid && gridMin !== null && (
            <div
              aria-hidden
              data-testid="cal-time-snap-grid"
              style={{
                position: "absolute",
                top: 0,
                height: dayAxisH,
                left: TIME_LABEL_W,
                right: 0,
                zIndex: 0,
                pointerEvents: "none",
                backgroundImage: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${gridMin * pxPerMin}px)`,
              }}
            />
          )}
          {/* "놓으면 여기 생긴다"는 점선 블록 하나 — ② 의 새 범위와 W7 의 종일 카드 드롭은 같은
              것이라 요소를 둘로 만들지 않는다. 라벨만 다르다(새 범위는 시각 구간, 드롭은 제목). */}
          {ghost && (
            <div
              data-testid={ghost.testid}
              style={{
                position: "absolute",
                top: ghost.startMin * pxPerMin,
                height: (ghost.endMin - ghost.startMin) * pxPerMin,
                left: TIME_LABEL_W,
                right: 0,
                display: "flex",
                alignItems: "center",
                padding: "0 var(--space-3)",
                border: "1px dashed var(--accent)",
                borderRadius: "var(--radius-sm)",
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                color: "var(--faint)",
                fontSize: "var(--text-xs)",
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              {ghost.label}
            </div>
          )}
          {timed.map((e, i) => (
            <TimeChip
              key={e.key}
              e={e}
              layout={timedLayout[i]}
              pxPerMin={pxPerMin}
              pending={pendingByKey.get(e.key) ?? null}
              linePx={linePx}
              searchHits={searchHits}
              folderFilter={folderFilter}
              focusedNoteId={focusedNoteId}
              folderById={folderById}
              excerpts={excerpts}
              checklists={checklists}
              uiLang={uiLang}
              chipDrag={chipDrag}
              onChipPointerDown={onChipPointerDown}
              onFocus={onFocus}
              onOpen={onOpen}
              plannedMove={plannedMove}
              chipPositions={chipPositions}
              commitTimes={commitTimes}
              onRequestConfirm={onRequestConfirm}
              onEdit={setEditing}
              onToggleChecklistItem={onToggleChecklistItem}
            />
          ))}
          {/* 오너 요청(2026-09-16) — 리사이즈 손잡이. 칩보다 **뒤에** 그려 DOM/키보드 포커스
              순서에서 칩 본문이 먼저 오게 하고, zIndex 로만 위에 앉는다(AxisResizeHandle
              주석). 여러 날 span(끝 손잡이를 주지 않는 이유는 calendarLayout::handlePadPx
              참고)은 isResizable 이 걸러 아예 렌더하지 않는다 — 손잡이가 없으면 몸통의 "항상
              이동"이 유일한 조작이다(기존과 동일). */}
          {timed.map((e, i) => {
            if (!isResizable(e)) return null;
            const p = pendingByKey.get(e.key);
            const startMin = p?.startMin ?? e.startMin;
            const endMin = p?.endMin ?? e.endMin;
            const pad = handlePadPx((endMin - startMin) * pxPerMin);
            const lane = timedLayout[i]?.lane ?? 0;
            return [
                  <AxisResizeHandle
                    key={`${e.key}-start`}
                    testId={`cal-time-handle-start-${e.item.note_id}`}
                    boundaryPx={startMin * pxPerMin}
                    pad={pad}
                    lane={lane}
                    active={dragInfo?.key === e.key && dragInfo.mode === "start"}
                    activeLabel={formatHhmm(startMin)}
                    onPointerDown={(ev) => onHandlePointerDown(e, "start", ev)}
                    dragHandlers={chipDrag.handlers}
                  />,
                  <AxisResizeHandle
                    key={`${e.key}-end`}
                    testId={`cal-time-handle-end-${e.item.note_id}`}
                    boundaryPx={endMin * pxPerMin}
                    pad={pad}
                    lane={lane}
                    active={dragInfo?.key === e.key && dragInfo.mode === "end"}
                    activeLabel={formatHhmm(endMin)}
                    onPointerDown={(ev) => onHandlePointerDown(e, "end", ev)}
                    dragHandlers={chipDrag.handlers}
                  />,
            ];
          })}
        </div>
        {tailRows > 0 && <div aria-hidden style={{ height: tailRows * hourRowH }} />}
      </div>
      {editing && (
        <ChipEventModal
          item={editing.item}
          uiLang={uiLang}
          onClose={() => setEditing(null)}
          onRepeatApply={(draft) => onRepeatApply(editing, draft)}
          // 축의 Delete 키와 같은 확인 흐름 — 같은 요청 빌더(confirmForDelete)다.
          onDelete={() => onRequestConfirm(confirmForDelete(editing))}
        />
      )}
    </div>
  );
}

/** ③ 눈금의 입력. **분을 먼저 읽고 날짜를 나중에** 읽는다 — 자정을 사이에 두면 "새 날의 00:00
 *  을 옛 날에 그리는" 쪽 대신 "한 박자 일찍 사라지는" 쪽으로 틀린다. */
export function readNowTick(): { minutes: number; todayIso: string } {
  const d = new Date();
  return { minutes: d.getHours() * 60 + d.getMinutes(), todayIso: todayLocal().day };
}
