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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TimelineRoutine } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { folderColorCss } from "../../../lib/ui";
import { type RepeatDraft } from "../../titlebar/scheduleRrule";
import { showUndoToast } from "../../../lib/undo";
import { todayLocal } from "../dateFmt";
import {
  layoutTimedEvents,
  keepDurationMin,
  formatHhmm,
  parseHhmm,
  planLinkedMove,
  planLinkedResize,
  dragTimes,
  planNewRange,
  rowIsSameDay,
  snapStartMin,
  nowLineTop,
  tickIntervalMinFor,
  MIN_SLOT_MIN,
  HOUR_ROW_H,
  MIN_HOUR_ROW_H,
  MAX_HOUR_ROW_H,
  TIME_LABEL_W,
  DEFAULT_SCROLL_HOUR,
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
import {
  commitDateRow,
  planRowTimes,
  shiftRowTimes,
  resizeRowBoundary,
} from "./dateWrite";
import { type ConfirmState } from "./useAxisConfirmFlow";
import { useDismissOnOutside, type AxisHandle } from "./AllDayStrip";
import { TimeChip, type ChipChecklist } from "./TimeChip";
import { useAxisAutoScroll } from "./useAxisAutoScroll";

/**
 * W15 ③ — 되돌리기 토스트 문구. 연속 드래그는 토스트가 **쌓이도록** 이미 정책이 돼 있는데
 * (그릴 D4) 문구가 고정 한 줄이라 서로 구분되지 않았다 — 어느 토스트가 어느 변경인지 알 수 없으면
 * 쌓아 둔 의미가 없다. 이제 실제 이전 → 이후 시각이 들어간다.
 * 한쪽이라도 없으면(시각을 처음 얹거나 해제하는 경우) 예전 고정 문구로 폴백한다 — "→ 10:00" 처럼
 * 반쪽만 든 문구는 무엇에서 바뀐 것인지 더 헷갈린다.
 */
function timeChangeLabel(from: string | null, to: string | null): string {
  return from && to ? t("home.cal_time_changed_at", { from, to }) : t("home.cal_time_changed");
}

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
export const HourRuler = memo(function HourRuler({ hourRowH }: { hourRowH: number }) {
  const pxPerMin = hourRowH / 60;
  const level = tickIntervalMinFor(hourRowH);
  const minutes = useMemo(() => {
    const out: number[] = [];
    for (let m = 0; m < 24 * 60; m += level) out.push(m);
    return out;
  }, [level]);
  return (
    <>
      {minutes.map((min) => {
        const hour = Math.floor(min / 60);
        const onHour = min % 60 === 0;
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
            <span
              className="cal-tick-label"
              data-testid={onHour ? `cal-hour-label-${hour}` : `cal-tick-label-${min}`}
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
              {onHour ? String(hour).padStart(2, "0") : formatHhmm(min)}
            </span>
          </div>
        );
      })}
    </>
  );
});

/** 미리보기 한 칩의 새 자리(W15) — 드래그 중이든 드롭 직후의 낙관적 자리든 같은 모양이다. */
type MovePreview = { key: string; startMin: number; endMin: number };

/** 미리보기 목록이 실제로 달라졌나 — 같은 값이면 예전 배열을 그대로 돌려줘 재렌더를 막는다
 *  (단일 키 시절 `cur.key === … && cur.startMin === …` 로 하던 것과 같은 목적). */
function samePreview(a: readonly MovePreview[], b: readonly MovePreview[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.key === b[i].key && p.startMin === b[i].startMin && p.endMin === b[i].endMin)
  );
}



/** "하루 전체 보기"(오너 요청 2026-09-16)의 하한 — MIN_HOUR_ROW_H(휠 확대의 하한, 28)보다
 *  훨씬 낮다. 그 값은 탐색적 축소로 읽기 힘들어지는 지점이고, 이 버튼은 "좁은 창에 24시간을
 *  다 넣어라"는 명시적 요청이라 다른 목적이다. 0 은 막는다(컨테이너 높이를 아직 못 잰 경우의
 *  방어) — 그 외엔 tickIntervalMinFor 가 알아서 시간 단위 눈금으로 굵어질 뿐 깨지지 않는다. */
const FIT_DAY_MIN_HOUR_ROW_H = 8;

/**
 * 오너 요청(2026-09-16) — 리사이즈 손잡이 히트 타겟을 칩 자신의 (부풀려질 수 있는) DOM 박스에서
 * 뗀 **별도 요소**로 둔다.
 *
 * 문제: 옛 판정(`chipDragMode`, `ev.currentTarget.getBoundingClientRect()`)은 칩의 실제 렌더
 * 박스를 봤는데, 그 박스는 두 가지 이유로 "보이는 눈금선"과 어긋날 수 있다 —
 *  ⓐ 짧은 일정은 3줄이 다 보이도록 `CHIP_MIN_H`(TimeChip.tsx)로 바닥 높이가 부풀려진다.
 *    바닥 손잡이가 이 부풀린 박스의 **아래쪽**을 보므로, 진짜 끝 시각보다 한참 아래에서만
 *    반응했다(30분짜리 일정이면 실제 14px, 부풀린 뒤 65px — 51px 차이).
 *  ⓑ 겹치는 일정은 `layoutTimedEvents` 가 아래로 밀어 쌓는다(스태킹). 밀린 칩은 `top` 자체가
 *    진짜 시작 시각의 픽셀 위치가 아니다 — 그러면 **위쪽** 손잡이도 어긋난다.
 *
 * 해법(리서치 2026-09-17: macOS `NSSplitView`·Zed/Bezel 에디터의 분할창 처방과 같은 방향 —
 * "보이는 선은 얇게 두고 히트 영역만 그 선의 진짜 좌표에 맞춰 키운다") — 손잡이를 칩의 DOM
 * 박스가 아니라 **`e.startMin`/`e.endMin` 의 캔버스 절대좌표**에 직접 앉힌다. 칩 몸통은 이제
 * 어디를 잡아도 항상 "이동"이고(onChipPointerDown), 리사이즈는 이 손잡이가 전담한다
 * (onHandlePointerDown). zIndex 를 칩보다 높여 두므로, 스태킹으로 다른 칩이 이 좌표를 시각적
 * 으로 덮어도 포인터는 항상 이 손잡이가 먼저 받는다 — 어느 칩의 손잡이를 "본다고 느꼈는지"와
 * 무관하게 실제로 잡히는 지점은 항상 정확한 시각이다.
 */
const HANDLE_HIT_PAD = 6;

/** 위 손잡이 하나 — 보이는 선은 없다(칩 테두리·시간 눈금이 이미 경계를 말한다, 새 시각 요소를
 *  더하지 않는다). 얇은 선 대신 **투명한 히트 스트립**만 그 자리에 겹쳐 커서와 클릭만 바꾼다. */
export function AxisResizeHandle({
  testId,
  boundaryPx,
  onPointerDown,
  dragHandlers,
}: {
  testId: string;
  /** 캔버스 기준 절대 픽셀 — 이 일정의 진짜 시작 또는 끝 시각 자리(e.startMin/endMin * pxPerMin). */
  boundaryPx: number;
  onPointerDown: (ev: ReactPointerEvent<HTMLDivElement>) => void;
  /** chipDrag.handlers — 포인터 캡처가 이 요소로 오므로 down 을 받은 바로 그 요소가 나머지도
   *  받아야 한다(useAxisDragSession 의 setPointerCapture, TimeChip 과 같은 이유). */
  dragHandlers: DragHandlers;
}) {
  return (
    <div
      data-testid={testId}
      onPointerDown={onPointerDown}
      {...dragHandlers}
      style={{
        position: "absolute",
        top: boundaryPx - HANDLE_HIT_PAD,
        height: HANDLE_HIT_PAD * 2,
        left: TIME_LABEL_W,
        right: 0,
        zIndex: 2,
        cursor: "ns-resize",
        background: "transparent",
      }}
    />
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
}: {
  /** W8 ②: 부모의 카드 드롭이 "이 좌표는 몇 분인가"를 묻는 자리. 축이 자기 DOM 을 안 내보낸다. */
  handleRef?: RefObject<AxisHandle | null>;
  /** W7: 끌고 있는(또는 저장을 기다리는) 종일 카드가 놓일 자리. */
  dropPreview?: { title: string; startMin: number } | null;
  plan: TimedDayPlan;
  /** 보고 있는 날(ISO) — ② 의 생성 콜백과 ③ 의 "오늘인가" 판정에 쓴다. */
  day: string | null;
  /** W11 ③: note_id → 본문 발췌(부모가 이미 note_get 으로 읽어 둔 값). 칩의 3행째가 그 **첫
   *  줄만** 쓴다 — 없으면 그 줄을 아예 그리지 않는다(바닥 높이는 그대로라 레이아웃은 안 흔들린다). */
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
}) {
  // 스크롤러(보이는 창)와 캔버스(672px 전체) — 둘 다 **축 안에서만** 산다(W8 ②).
  const axisRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // ── 축 확대 (PLAN-2026-09-13 달력 확대) ────────────────────────────────────────────────────
  // **로컬 state, 전역 싱글턴 아니다** — 이 축 인스턴스(대시보드 하나, 사이드바 하나)만의 배율.
  // 같은 세션에서 날짜를 옮겨도 이 컴포넌트가 안 사라지는 한(D4 껍데기 분리 참고 — 대시보드는
  // TimeAxis 를 다시 마운트하지 않는다) 유지되고, 언마운트/새로고침이면 기본값(HOUR_ROW_H)으로
  // 돌아간다 — 설정 키도 localStorage 도 만들지 않는다(요구사항 ③).
  const [hourRowH, setHourRowH] = useState(HOUR_ROW_H);
  /** wheel 핸들러는 아래에서 `useEffect(…, [])`로 한 번만 등록한다 — 그 클로저가 매 렌더 새로
   *  만들어지지 않으므로 최신 배율은 ref 로 읽는다(이 파일의 다른 "얼린 손잡이"와 같은 처방,
   *  useImperativeHandle 의 startMinAt 주석 참고). */
  const hourRowHRef = useRef(hourRowH);
  hourRowHRef.current = hourRowH;
  const dayAxisH = hourRowH * 24;
  const pxPerMin = hourRowH / 60;
  // 사이드바(compact) — 캔버스 아래 3행 여백. 늦은 밤엔 스크롤 끝이 24:00 이라 지금 시각이 항상
  // 창 바닥에 붙었고(보이는 창이 실측보다 낮으면 화면 밖), 여백이 있으면 지금을 위쪽에 둘 수 있다.
  // ponytail: 여백은 배율을 따라간다. 창 높이를 ResizeObserver 로 따라 재정렬하지는 않는다.
  const tailRows = compact ? 3 : 0;

  /** 휠 확대 직후, 커서가 가리키던 **그 시각**을 같은 화면 자리에 다시 놓기 위한 값 — 캔버스
   *  높이(dayAxisH)가 새 배율로 실제로 커진 "뒤"에 scrollTop 을 세팅해야 한다(먼저 세팅하면
   *  아직 옛 scrollHeight 라 브라우저가 그 자리에서 clamp 해 버린다). 그래서 wheel 핸들러는
   *  이 ref 에 "고정할 시각(분) · 그때의 커서 Y"만 적어 두고, 실제 scrollTop 은 hourRowH 가
   *  반영된 다음 렌더의 useLayoutEffect 가 계산한다 — 지도의 `nextX = cursorX - ((cursorX-x)/prevK)*nextK`
   *  재조정과 같은 사상이고, 여기는 x/pan 대신 scrollTop 하나뿐이다. */
  const pendingZoomFix = useRef<{ pinnedMin: number; cursorY: number } | null>(null);
  useLayoutEffect(() => {
    const fix = pendingZoomFix.current;
    const el = axisRef.current;
    if (!fix || !el) return;
    pendingZoomFix.current = null;
    const viewH = el.getBoundingClientRect().height;
    const raw = fix.pinnedMin * pxPerMin - fix.cursorY;
    el.scrollTop = Math.max(0, Math.min(dayAxisH + tailRows * hourRowH - viewH, raw));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pxPerMin/dayAxisH 는 hourRowH 의
    // 파생값이라 hourRowH 하나만으로 이 값들이 바뀐 렌더를 잡는다(둘 다 deps 에 넣으면 같은
    // 렌더에 두 번 잡히는 게 아니라 그냥 중복 표기다 — 굳이 늘리지 않는다).
  }, [hourRowH]);

  // 축의 스크롤 컨테이너에 **네이티브** addEventListener 로 건다(useMapPanZoom·useTimelineDrag 와
  // 같은 이유 — React 의 합성 onWheel 은 델리게이션 루트에 passive 로 등록돼 preventDefault 가
  // 안 먹는다). 평소 휠은 이 리스너가 손대지 않는다(막지 않으면 컨테이너의 기존 세로 스크롤이
  // 그대로 산다) — Ctrl/Cmd+wheel 만 확대/축소로 가로챈다(지도·연도 타임라인과 통일된 관용구,
  // 2026-09-08). deps 는 []: 클로저는 ref(hourRowHRef · axisRef)만 만지므로 재등록이 필요 없다.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 평소 휠 = 그대로 세로 스크롤(막지 않는다).
      e.preventDefault();
      const cur = hourRowHRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 0.85;
      const next = Math.min(MAX_HOUR_ROW_H, Math.max(MIN_HOUR_ROW_H, cur * factor));
      if (next === cur) return; // 이미 하한/상한 — 아무것도 안 바뀐다.
      const rect = el.getBoundingClientRect();
      const cursorY = e.clientY - rect.top;
      // 확대 중심 = 커서가 가리키는 "그 시각"(지금 스케일 기준으로 역산). 위 useLayoutEffect 가
      // 새 스케일 반영 뒤 이 시각을 같은 커서 자리로 되돌린다.
      const pinnedMin = (el.scrollTop + cursorY) / (cur / 60);
      pendingZoomFix.current = { pinnedMin, cursorY };
      setHourRowH(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** 그릴 때만 쓰는 값 — 드래그 중 미리보기이자 드롭 직후의 낙관적 위치.
   *
   *  W15 — **칩 하나가 아니라 목록이다.** 맞닿은 이웃이 같이 움직이므로(연동 이동) 한 제스처가
   *  여러 칩의 자리를 바꾼다. 빈 배열 = 미리보기 없음(예전의 null). 보통의 경우는 길이 1 이다. */
  const [pendingMove, setPendingMove] = useState<MovePreview[]>([]);
  const [newRange, setNewRange] = useState<{ startMin: number; endMin: number } | null>(null);

  /** W11 ④ — 설정이 펼쳐진 칩과 그 안에서 열린 줄. **축 전체에 하나뿐**이다(NoteDatesList §A 의
   *  "모달/팝오버 중첩 금지"와 같은 규율: 칩 하나를 펼치면 다른 칩은 접힌다). 새 데이터가 와도
   *  닫지 않는다 — 시각을 고치면 재조회가 도니, 닫아 버리면 연달아 고칠 수가 없다. */
  const [openChip, setOpenChip] = useState<{ key: string; field: "time" | "repeat" | null } | null>(
    null,
  );
  /** 열려 있는 칩 하나의 메뉴와 그 토글 버튼 — 바깥 클릭 판정에만 쓴다(축 전체에 하나뿐이므로
   *  칩마다 만들지 않는다). */
  const chipMenuRef = useRef<HTMLDivElement>(null);
  const chipSettingsRef = useRef<HTMLButtonElement>(null);

  // W12 ③ — 플로팅 메뉴는 바깥 클릭·Escape 로 닫힌다. W14 에서 종일 필의 펼침 패널이 **두 번째
  // 사용처**가 되면서 이 스무 줄이 useDismissOnOutside 로 나갔다(그 함수의 주석에 왜 공용
  // useDismiss 가 아닌지까지 있다) — 두 패널이 한 가지를 쓴다.
  useDismissOnOutside(openChip !== null, [chipMenuRef, chipSettingsRef], () => setOpenChip(null));

  // ③ 현재 시각 눈금 — 1분 틱. 공용 훅을 새로 만들지 않는다(HomeHeader.tsx 가 같은 일을 지역
  // setInterval 로 한다). uiStore.todayIso 는 **날짜**만 있어 분 위치를 못 주므로 여기서 읽는다.
  // 자정을 넘어가면 todayLocal().day 가 바뀌어 눈금이 알아서 사라진다 — 분기 코드가 따로 없다.
  const [nowTick, setNowTick] = useState(readNowTick);
  useEffect(() => {
    const id = setInterval(() => setNowTick(readNowTick()), 60_000);
    return () => clearInterval(id);
  }, []);
  const nowTop = day === null ? null : nowLineTop(day, nowTick.todayIso, nowTick.minutes, hourRowH);
  // 사이드바: 오늘의 다음 시각 일정(지금 이후 시작) — "시간 표현" 한 조각. plan.timed 는 시작순이다.
  const nextEvent =
    compact && day === nowTick.todayIso ? (plan.timed.find((e) => e.startMin >= nowTick.minutes) ?? null) : null;

  // 새 데이터가 오면(저장 → bump → 재조회) 낙관적 위치를 버린다 — 그때부터 plan 이 진실이다.
  useEffect(() => {
    setPendingMove([]);
  }, [plan]);

  // 오늘은 **항상** 지금 시각(뷰포트 가운데)에 맞춘다(오너 실기 2026-09-16) — 일정이 있어도
  // 없어도. 옛 규칙은 첫 일정이 있으면 무조건 그리로 맞췄는데, 새벽(수면 등) 일정이 있는 날은
  // 지금이 오후여도 축이 00시부터 열려 "맨날 하루의 처음"으로 보이는 사고였다. 다른 날은 그대로
  // 첫 일정, 없으면 08:00(§6.2). **부모가 아니라 여기** — 자기 스크롤러를 아는 것은 축뿐이고
  // (W8 ②), 목록 펼침으로 축이 다시 마운트될 때도 맞는다(부모의 effect 는 deps 가 그대로여서
  // 재마운트된 축을 0 으로 남겨 뒀다).
  //
  // **한 번만 맞춘다** — `pinnedTodayRef` 가 이 날짜로 이미 맞췄는지를 기억한다. 없으면 이
  // effect 는 `firstMin`(재조회로 첫 일정이 바뀔 때마다) 에도 다시 돈다 — 시간축 빈 곳에
  // 새 일정을 만들면(바로 위 onCreateTimedNote 리프레시로 재조회가 오고 firstMin 이 바뀐다)
  // 방금 만든 그 일정 쪽으로 축이 다시 튀어, 사용자가 방금 본 자리에서 자기가 만든 일정이
  // 화면 밖으로 사라지는 사고가 났다. 오늘이 아닌 날은 그대로 매 firstMin 변화에 다시 맞춘다
  // (detailNotes 가 비동기로 나중에 도착해 null → 값으로 바뀌는 정상 경로 — 그 갈래는 손대지
  // 않았다). 날짜를 바꾸면 ref 를 지워 다음에 그 날로(또는 다시 오늘로) 돌아오면 재적용된다.
  // `nowTick.minutes` 는 deps 에 안 둔다 — 매 분 재렌더된다고 스크롤을 다시 뺏으면 사용자가
  // 손으로 옮긴 위치가 흐른다.
  const firstMin = plan.timed[0]?.startMin ?? null;
  const pinnedTodayRef = useRef<string | null>(null);
  /** 위 세 갈래(오늘=지금 시각·다른 날=첫 일정·둘 다 없으면 08:00)를 **한 곳에** 둔다 — 아래
   *  effect 와, "하루 전체 보기"를 끌 때(되돌리기)가 같은 규칙을 쓴다(오너 요청 2026-09-16).
   *  `forHourRowH` 를 받는 이유: 되돌리기는 `setHourRowH` 로 배율을 바꾼 **바로 그 틱**에 새
   *  배율 기준으로 다시 맞춰야 하는데, state 는 다음 렌더에야 반영되니 방금 정한 값을 직접
   *  넘긴다(effect 쪽은 그냥 지금 hourRowH 를 넘긴다). */
  const applyDefaultScroll = (el: HTMLDivElement, forHourRowH: number) => {
    const axisH = forHourRowH * 24;
    if (day === nowTick.todayIso) {
      const nowPx = (nowTick.minutes / (24 * 60)) * axisH;
      // compact: 지금을 창 위쪽 40% 에(아래 여백 덕에 밤에도 가능), 아니면 가운데.
      const anchor = el.clientHeight * (compact ? 0.4 : 0.5);
      const maxTop = axisH + tailRows * forHourRowH - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(maxTop, nowPx - anchor));
      return;
    }
    if (firstMin !== null) {
      el.scrollTop = (firstMin / (24 * 60)) * axisH;
      return;
    }
    el.scrollTop = ((DEFAULT_SCROLL_HOUR * 60) / (24 * 60)) * axisH;
  };
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    if (day === nowTick.todayIso) {
      if (pinnedTodayRef.current === day) return;
      pinnedTodayRef.current = day;
      applyDefaultScroll(el, hourRowH);
      return;
    }
    pinnedTodayRef.current = null;
    applyDefaultScroll(el, hourRowH);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hourRowH 는 일부러 뺐다: 축소/확대
    // 만으로 이 "첫 일정에 맞추기"를 다시 돌리면 안 된다 — 그건 아래 wheel 핸들러의
    // useLayoutEffect 가 이미 자기 몫(커서 중심 재조정)으로 처리한다. 이 effect 는 날짜가
    // 바뀌거나 축이 다시 마운트될 때만 돈다. "하루 전체 보기" 버튼이 배율을 바꾸는 경우도
    // 마찬가지로 이 effect 가 아니라 그 버튼의 핸들러가 직접 applyDefaultScroll 을 부른다.
  }, [firstMin, day, nowTick.todayIso]);

  // ── 하루 전체 보기 (오너 요청 2026-09-16) ──────────────────────────────────────────────────
  // 사이드바 축은 보이는 창이 ~168px(≈6시간)뿐이라 하루를 보려면 계속 스크롤해야 한다는 피드백
  // — 한 번에 24시간을 다 넣는 배율로 맞추는 토글. 휠 확대(Ctrl+wheel)와 **같은 변수**
  // (hourRowH) 를 쓰므로 두 조작이 서로 다투지 않는다 — 이 버튼도 그 배율을 한 번 바꿀 뿐이고,
  // 다시 눌러 원래 배율로 돌아가면 지금 시각(또는 첫 일정)으로 다시 맞춘다.
  const [wholeDayView, setWholeDayView] = useState(false);
  const toggleWholeDayView = () => {
    const el = axisRef.current;
    if (!el) return;
    if (wholeDayView) {
      setWholeDayView(false);
      setHourRowH(HOUR_ROW_H);
      applyDefaultScroll(el, HOUR_ROW_H);
      return;
    }
    const viewH = el.getBoundingClientRect().height;
    // MIN_HOUR_ROW_H(28, 24h=672px) 가 아니라 훨씬 낮은 바닥을 쓴다 — 그건 "탐색적 축소로는
    // 이 밑으로 못 읽는다"는 휠 확대의 하한이고, 이 버튼은 "좁은 창에 24시간을 다 욱여넣어라"는
    // 명시적 요청이라 다른 목적이다. 사이드바 실측 높이(~168px)로 그 바닥을 지키면 버튼이
    // 사실상 아무 것도 안 하는 것과 같다(672px 이상 있어야 28 을 지킬 수 있다). 더 내려가도
    // tickIntervalMinFor 가 알아서 시간 단위 눈금으로 굵어질 뿐 깨지지 않는다.
    const fit = Math.min(MAX_HOUR_ROW_H, Math.max(FIT_DAY_MIN_HOUR_ROW_H, viewH / 24));
    setWholeDayView(true);
    setHourRowH(fit);
    el.scrollTop = 0;
  };

  // ── W17: 가장자리 자동 스크롤 ── useAxisAutoScroll.ts (세 드래그가 같은 규칙을 쓴다)
  const { trackAutoScroll, stopAutoScroll, dragDeltaPx } = useAxisAutoScroll(axisRef, dayAxisH);

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
      // 나머지 둘은 ref 만 만지므로 deps [] 로 얼려도 낡지 않는다(위 startMinAt 과 같은 이유).
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
     *  는 맞닿은 이음새 하나뿐(오너 요청 2026-09-16, planLinkedResize)이다. `deltaMin` 은
     *  move 에서만 뜻이 있다 — **이 동작이 실제로 민 양**, 이웃의 DB 행에 그대로 얹는다.
     *  리사이즈 이웃은 `linked[].startMin/endMin` 이 이미 그 이웃의 새 절대 시각이라 델타가
     *  필요 없다(아래 분기 참고). */
    linked: MovePreview[] = [],
    deltaMin = 0,
  ) => {
    setPendingMove([{ key: e.key, ...next }, ...linked]);
    // 되돌리기는 **한 토스트로 묶는다** — 연동된 항목 전부가 한 사용자 동작이다(commitDateRow 의
    // collectUndo 주석). 단일 칩도 같은 길을 지난다: 갈래를 둘로 두면 하나가 조용히 썩는다.
    const reverts: (() => void)[] = [];
    const collect = (revert: () => void) => reverts.push(revert);
    let label = t("home.cal_time_changed");
    const ok = await commitDateRow(
      e.item.note_id,
      e.item.date_id,
      (row) => {
        // 무엇이 고정인지는 mode 가 정한다(순수 계산은 dateWrite::planRowTimes — 이웃 둘과 같은
        // 자리다). 여기 남는 것은 그 결과를 화면·토스트에 잇는 비순수 두 줄뿐이다.
        const { start_time, end_time, startMin } = planRowTimes(row, mode, next, hourRowH);
        // move 가 행에서 얻은 길이로 다시 죈 시작이 미리보기와 다르면 미리보기를 그 값으로 고친다.
        if (startMin !== null && startMin !== next.startMin) {
          setPendingMove((cur) =>
            cur.map((p) =>
              p.key === e.key
                ? {
                    key: e.key,
                    startMin,
                    endMin: startMin + (next.endMin - next.startMin),
                  }
                : p,
            ),
          );
        }
        // W15 ③ — 토스트 문구의 이전→이후는 **이 행이 실제로 바꾼 쪽**이다: 끝 손잡이는 끝 시각,
        // 나머지(이동·시작 손잡이)는 시작 시각. 행을 읽은 이 자리에서만 "이전"을 알 수 있다.
        label =
          mode === "end"
            ? timeChangeLabel(row.end_time, end_time)
            : timeChangeLabel(row.start_time, start_time);
        return { start_time, end_time };
      },
      undefined,
      collect,
    );
    if (!ok) {
      setPendingMove([]); // 롤백 — call() 이 이미 토스트했다. 이웃도 아직 쓰지 않았다.
      return;
    }
    // 이웃은 각자 자기 DB 행을 읽어 쓴다(함정 ⓑ 그대로) — move 는 델타만큼 통째로 밀고
    // (shiftRowTimes), 리사이즈는 이음새로 맞닿은 한쪽 경계만 옮긴다(resizeRowBoundary). 이음새
    // 쪽은 `mode` 가 가리키는 손잡이의 **반대편**이 이웃의 닿은 면이다 — 내가 끝(end)을 늘리면
    // 이웃의 시작(start)이 그 자리로, 내가 시작을 당기면 이웃의 끝이 그 자리로.
    const byKey = new Map(plan.timed.map((x) => [x.key, x]));
    for (const l of linked) {
      const target = byKey.get(l.key);
      if (!target) continue;
      if (mode === "move") {
        await commitDateRow(
          target.item.note_id,
          target.item.date_id,
          (row) => shiftRowTimes(row, deltaMin),
          undefined,
          collect,
        );
        continue;
      }
      const side = mode === "end" ? "start" : "end";
      const boundaryMin = side === "start" ? l.startMin : l.endMin;
      await commitDateRow(
        target.item.note_id,
        target.item.date_id,
        (row) => resizeRowBoundary(row, side, boundaryMin),
        undefined,
        collect,
      );
    }
    if (reverts.length > 0) {
      showUndoToast(label, () => {
        for (const revert of reverts) revert();
      });
    }
  };

  /** 그 날 안에서 끝나는 행만 손잡이를 갖는다 — 이유는 calendarLayout::chipDragMode 참고.
   *  판정은 행 모양(rowIsSameDay)이다 — 월 경계로 잘린 span_start/span_end 는 여러 날 행을
   *  하루처럼 보이게 한다. TimeChip 의 `resizable` 과 같은 규칙이어야 한다. */
  const isResizable = (e: TimedEvent) => rowIsSameDay(e.item);

  /**
   * W11 ④ — 펼친 설정에서 시각 한쪽을 고친다. **새 쓰기 경로를 만들지 않는다**: 드래그·키보드와
   * 같은 commitDateRow 를 지나므로 함정 ⓑ(전량 교체 페이로드는 DB 행 기준)와 되돌리기가 그대로
   * 붙는다. `null` 은 해제다 — 빈 입력과 파싱 실패를 가르는 일은 ChipTimeEditor 가 한다.
   *
   * 끝 시각은 **하루짜리 행에만** 쓴다. 여러 날 span 의 `end_time` 은 마지막 날의 시각이라
   * (§1.3 I3) 여기서 쓰면 남의 날짜를 조용히 바꾼다 — 끝 손잡이를 안 주는 것과 같은 이유이고,
   * 판정은 화면 항목이 아니라 DB 행(rowIsSameDay)이 한다. 입력 자체도 안 보이지만, 화면 값으로
   * 판정하면 월 경계로 클리핑된 span 이 하루처럼 보이는 경우를 놓친다.
   */
  const commitChipTime = (e: TimedEvent, part: "start" | "end", value: string | null) => {
    // W15 ③ — 이전 시각은 이 칩이 이미 알고 있다(화면 항목의 값). 해제(value === null)나 원래
    // 비어 있던 경우는 채울 짝이 없어 고정 문구로 폴백한다 — timeChangeLabel 한 지점의 규칙.
    const label = timeChangeLabel(
      part === "start" ? e.item.start_time : e.item.end_time,
      value,
    );
    return commitDateRow(
      e.item.note_id,
      e.item.date_id,
      (row) => {
        if (part === "start") return { start_time: value };
        if (!rowIsSameDay(row)) return null; // 아무것도 쓰지 않는다.
        return { end_time: value };
      },
      label,
    );
  };

  /** D4(그릴 2026-09-11) — 반복 편집은 더 이상 여기서 즉시 커밋하지 않는다. ChipRepeatEditor 의
   *  "적용"이 이 콜백을 부르면 메뉴부터 닫고(포포버 위 모달 금지) 확인을 DayDetailPanel 에
   *  요청한다 — 실제 저장(commitDateRow)과 사후 판정은 그 확인이 끝난 뒤 부모의
   *  resolveRepeatApply 가 한다(같은 파일, 위 참고). */
  const onRepeatApply = (e: TimedEvent, draft: RepeatDraft) => {
    setOpenChip(null);
    onRequestConfirm({
      kind: "repeatApply",
      key: e.key,
      noteId: e.item.note_id,
      dateId: e.item.date_id,
      // day prop 이 곧 이 축이 보여주는 selectedDay 다(축에 있는 timed 항목은 전부
      // 그 날 시작하는 것만 — planTimedDay 의 startsOnDay). e.item.span_start 는 매달 1일에
      // 잘린 값일 수 있어 폴백으로만 남긴다.
      day: day ?? e.item.span_start,
      draft,
    });
  };

  /** 점선 미리보기 블록 하나 — W7 의 드롭이 있으면 그것, 없으면 ② 의 새 범위. 둘이 동시에 뜨는
   *  일은 없다(하나는 카드에서, 하나는 축의 빈 곳에서 시작하는 제스처다). */
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
    plan.timed.map((ev) => {
      const p = pendingMove.find((x) => x.key === ev.key);
      return {
        key: ev.key,
        startMin: p?.startMin ?? ev.startMin,
        endMin: p?.endMin ?? ev.endMin,
        linkable: isResizable(ev),
        // planLinkedResize 만 본다(위 LinkableEvent 주석) — 이 칩의 end_time 이 실제로 있는지.
        hasEnd: ev.item.end_time != null,
      };
    });

  /**
   * 드래그(또는 키보드 한 번)의 결과 — 주 칩의 새 시각(dragTimes)과, 같이 따라오는 이웃들.
   * move 는 맞닿은 체인 전부(planLinkedMove), 리사이즈 손잡이는 맞닿은 이음새 하나뿐
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
  ) => {
    const rawNext = dragTimes(base.mode, base, deltaPx, hourRowH);
    if (base.mode === "move") {
      const deltaMin = rawNext.startMin - base.startMin;
      const linked = planLinkedMove(base.positions, base.key, deltaMin);
      return { next: rawNext, linked, deltaMin };
    }
    const { next, linked } = planLinkedResize(base.positions, base.key, base.mode, rawNext);
    return { next, linked, deltaMin: 0 };
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
        const { next, linked } = plannedMove(s.data, dragDeltaPx(s.dy, s.data.scrollTop0));
        setPendingMove((cur) => {
          const nextPreview = [{ key: s.data.key, ...next }, ...linked];
          return samePreview(cur, nextPreview) ? cur : nextPreview;
        });
      };
      trackAutoScroll(s.clientY, apply);
      apply();
    },
    onDrop: (s) => {
      stopAutoScroll();
      const { next, linked, deltaMin } = plannedMove(s.data, dragDeltaPx(s.dy, s.data.scrollTop0));
      if (next.startMin === s.data.startMin && next.endMin === s.data.endMin) {
        setPendingMove([]);
        return;
      }
      void commitTimes(s.data.event, s.data.mode, next, linked, deltaMin);
    },
    onCancel: () => {
      stopAutoScroll();
      setPendingMove([]);
    },
  });

  const onChipPointerDown = (e: TimedEvent, ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    // 칩 위에서 시작한 드래그는 ①(시각 조정)이지 ②(빈 곳에 추가)가 아니다 — 축 컨테이너로
    // 새면 노트가 생긴다.
    ev.stopPropagation();
    // W11 ④ — **설정이 펼쳐진 칩은 끌리지 않는다**(이동도 리사이즈도). 그 안에는 캐럿을 놓을
    // 텍스트 입력과 누를 버튼들이 있어서, 같은 상하 손짓이 "값을 고치는 중"과 "칩을 옮기는 중"
    // 둘로 갈린다 — 게다가 드래그는 포인터를 캡처해 입력이 포커스를 못 받는다. 접으면 손잡이도
    // 그대로 돌아온다(요소는 없어지지 않는다). 메뉴 안에서 시작한 포인터는 ChipSchedule 이
    // 한 번 더 막아 준다(그쪽 stopPropagation — 설정 토글 버튼도 같다).
    if (openChip?.key === e.key) return;
    // 오너 실기 2026-09-16 — 칩 몸통은 이제 어디를 잡아도 항상 "이동"이다(위 HANDLE_HIT_PAD
    // 주석). 리사이즈는 AxisResizeHandle(아래 onHandlePointerDown)이 전담한다.
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
   *  `chipDragMode` 로 되짚을 필요가 없다. 나머지(포지션 얼리기·스크롤 기준점)는 몸통과 같다. */
  const onHandlePointerDown = (
    e: TimedEvent,
    mode: "start" | "end",
    ev: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    if (openChip?.key === e.key) return;
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
      const apply = () => setNewRange(planNewRange(s.y0 - s.data.topPx, createEndPx(s), hourRowH));
      trackAutoScroll(s.clientY, apply);
      apply();
    },
    onDrop: (s) => {
      stopAutoScroll();
      setNewRange(null);
      if (!day) return;
      const range = planNewRange(s.y0 - s.data.topPx, createEndPx(s), hourRowH);
      if (!range) return; // 임계 미만 = 그냥 클릭. 아무것도 만들지 않는다.
      // 놓는 **그 순간** 만든다(PLAN-2026-09-10 D3) — 그리고 effect 가 아니라 이 핸들러에서:
      // effect 로 옮기면 StrictMode 이중 발화로 노트가 둘 생긴다(useCalendarDrag 의 같은 결정).
      // W9 ①: 이 경로에는 되돌리기 토스트를 달지 않았다. 나머지 다섯은 "시각을 바꾸는" 것이라
      // 되돌리기가 옛 시각으로 다시 쓰는 일이지만, 여기는 **노트를 만드는** 것이라 되돌리기가
      // "방금 만든 노트를 지우기"가 된다 — 성격이 다르고(삭제는 휴지통·복원 규율을 탄다) 만든
      // 노트는 CalendarTab 이 소유한다. 필요해지면 그 소유자 쪽에서 붙인다.
      onCreateTimedNote?.(day, range.startMin, range.endMin);
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
   *  것이라, 그 안의 `top`/`height` 는 이 축이 지금 보여줄 배율과 다를 수 있다. 시작~끝 분·정렬
   *  순서는 스케일과 무관한 사실이므로 다시 구하지 않고, 픽셀 배치(스태킹 스윕)만 지금 hourRowH
   *  로 다시 돌린다 — layoutTimedEvents 는 그 스윕만 뽑아낸 순수 함수라 정렬을 다시 하지 않는다
   *  (plan.timed 는 이미 planTimedDay 가 정렬해 뒀다). 인덱스로 plan.timed 와 짝지어 쓴다. */
  const timedLayout = useMemo(
    () => layoutTimedEvents(plan.timed, hourRowH),
    [plan.timed, hourRowH],
  );

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
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "flex-end",
          gap: "var(--space-2)",
          minWidth: 0,
        }}
      >
        {(toolbarHint || nextEvent) && (
          <div
            title={nextEvent ? t("home.cal_next_event", { time: formatHhmm(nextEvent.startMin) }) : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              color: "var(--faint)",
              fontSize: "var(--text-2xs)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {toolbarHint}
            {nextEvent && (
              <span data-testid="cal-axis-next">
                {toolbarHint ? " · " : ""}
                {t("home.cal_next_event", { time: formatHhmm(nextEvent.startMin) })}
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          data-testid="cal-axis-fit-day"
          aria-pressed={wholeDayView}
          title={t("home.cal_axis_fit_day")}
          onClick={toggleWholeDayView}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            font: "inherit",
            fontSize: "var(--text-2xs)",
            fontWeight: 600,
            color: wholeDayView ? "var(--accent)" : "var(--faint)",
            cursor: "pointer",
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          {t("home.cal_axis_fit_day")}
        </button>
      </div>
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
          <HourRuler hourRowH={hourRowH} />
          {/* 그릴 2026-09-13 W3 — 시간축 배경 루틴("출퇴근" 등, 노트에 안 묶임). 칩(테두리 있는
              카드)보다 뒤(zIndex 0, DOM 순서도 먼저라 칩이 자연히 위에 그려진다)에 테두리 없는
              옅은 배경 면으로 얹는다 — 노트 일정과 시각적으로 명확히 구분된다. v1 범위: 클릭해도
              아무 일도 안 하고(onClick 없음), 드래그·리사이즈도 없다 — pointerEvents:none 으로
              애초에 포인터 이벤트를 안 받아 축의 드래그(빈 곳 새 범위 만들기 등)를 가리지도
              않는다. 색은 C1(64c1b269) 이후의 color-mix 관례 — 인라인 var(--surface/--overlay/
              --bg) 는 쓰지 않는다.
              오너 실기 2026-09-16 — 제목을 띠 상단 중앙에 그린다(전에는 툴팁으로만 있어 호버
              전엔 어느 루틴인지 안 보였다). 배경 없는 텍스트라 표면 계약과 무관하다. */}
          {routines.map((r) => {
            const startMin = parseHhmm(r.start_time);
            const endMin = parseHhmm(r.end_time);
            if (startMin === null || endMin === null || endMin <= startMin) return null;
            const bandColor =
              r.color_hue != null ? folderColorCss(r.color_hue) : "var(--accent)";
            return (
              <div
                key={r.id}
                data-testid={`cal-timeline-routine-${r.id}`}
                title={`${r.title} ${r.start_time}–${r.end_time}`}
                style={{
                  position: "absolute",
                  top: startMin * pxPerMin,
                  height: (endMin - startMin) * pxPerMin,
                  left: TIME_LABEL_W,
                  right: 0,
                  zIndex: 0,
                  background: `color-mix(in srgb, ${bandColor} 12%, transparent)`,
                  pointerEvents: "none",
                }}
              >
                <div
                  data-testid={`cal-timeline-routine-title-${r.id}`}
                  style={{
                    position: "absolute",
                    top: 1,
                    left: "50%",
                    transform: "translateX(-50%)",
                    maxWidth: "calc(100% - var(--space-2))",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "var(--text-2xs)",
                    fontWeight: 600,
                    color: bandColor,
                  }}
                >
                  {r.title}
                </div>
              </div>
            );
          })}
          {/* ③ 오늘의 현재 시각 — accent 선. 칩보다 **위**(zIndex 1)라 겹쳐도 가려지지
              않지만, 같은 zIndex 를 쓰는 드래그 중인 칩은 DOM 순서상 뒤라 그 아래에 남는다.
              W10 ①(오너 실기 2026-09-11): 1px 실선은 안 보였다 — 2px + 맥동 발광(.cal-now-line,
              tokens.css)에 현재 시각 라벨 하나. 라벨은 눈금 열(TIME_LABEL_W)이 아니라 **선의
              오른쪽 끝**에 붙는다: 그 열엔 이미 시(`02`)가 있어 같은 자리에서 두 숫자가 싸운다.
              pointerEvents 는 그대로 none — 라벨도 상속받아 드래그를 가로막지 않는다. */}
          {nowTop !== null && (
            <div
              data-testid="cal-time-now"
              className="cal-now-line"
              style={{
                position: "absolute",
                top: nowTop,
                left: TIME_LABEL_W,
                right: 0,
                height: 0,
                zIndex: 1,
                borderTop: "2px solid var(--accent)",
                pointerEvents: "none",
              }}
            >
              {/* W11 ②: accent 알약 + 흰 글자(--on-solid)를 버렸다 — 밝은 세이지 위의 흰 글자는
                  대비가 2:1 남짓이고, 바로 이 선의 발광이 같은 색으로 번져 글자가 묻혔다(오너
                  실기의 "흰색 폰트 + 밝은 배경"이 정확히 이것이다). 이제 눈금 라벨과 **같은**
                  `.cal-tick-label` 로 선을 끊고, 글자는 그 배경 위에서 가장 또렷한 --text 다.
                  --accent 는 고르지 않았다: 라이트 테마에서 accent(#7da98c) 대 한지 배경
                  (#f4efe3)이 2.4:1 로 11px 글자에는 모자라고, "지금"이라는 신호는 2px accent 선과
                  맥동 발광이 이미 충분히 말한다. 대신 굵기 한 단(600)으로 --faint 400 인 눈금
                  라벨과 구분된다.
                  선 중앙에 걸터앉는다(눈금 라벨과 같은 처방) — 이 컨테이너가 height 0 + 2px
                  테두리라 translateY(-50%) 가 곧 선 중앙이다. */}
              <span
                data-testid="cal-time-now-label"
                className="cal-tick-label cal-tick-label--solid"
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  transform: "translateY(-50%)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text)",
                  fontWeight: 600,
                  fontSize: "var(--text-xs)",
                }}
              >
                {formatHhmm(nowTick.minutes)}
              </span>
            </div>
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
              }}
            >
              {ghost.label}
            </div>
          )}
          {plan.timed.map((e, i) => (
            <TimeChip
              key={e.key}
              e={e}
              layout={timedLayout[i]}
              pxPerMin={pxPerMin}
              pending={pendingMove.find((p) => p.key === e.key) ?? null}
              searchHits={searchHits}
              folderFilter={folderFilter}
              focusedNoteId={focusedNoteId}
              folderById={folderById}
              excerpts={excerpts}
              checklists={checklists}
              openChip={openChip}
              uiLang={uiLang}
              chipSettingsRef={chipSettingsRef}
              chipMenuRef={chipMenuRef}
              chipDrag={chipDrag}
              onChipPointerDown={onChipPointerDown}
              onFocus={onFocus}
              onOpen={onOpen}
              plannedMove={plannedMove}
              chipPositions={chipPositions}
              commitTimes={commitTimes}
              onRequestConfirm={onRequestConfirm}
              setOpenChip={setOpenChip}
              onToggleChecklistItem={onToggleChecklistItem}
              commitChipTime={commitChipTime}
              onRepeatApply={onRepeatApply}
            />
          ))}
          {/* 오너 요청(2026-09-16) — 리사이즈 손잡이. 칩보다 **뒤에** 그려 DOM/키보드 포커스
              순서에서 칩 본문이 먼저 오게 하고, zIndex 로만 위에 앉는다(위 HANDLE_HIT_PAD
              주석). 여러 날 span(끝 손잡이를 주지 않는 이유는 calendarLayout::chipDragMode
              참고)은 isResizable 이 걸러 아예 렌더하지 않는다 — 손잡이가 없으면 몸통의 "항상
              이동"이 유일한 조작이다(기존과 동일). */}
          {plan.timed.map((e) =>
            isResizable(e)
              ? [
                  <AxisResizeHandle
                    key={`${e.key}-start`}
                    testId={`cal-time-handle-start-${e.item.note_id}`}
                    boundaryPx={e.startMin * pxPerMin}
                    onPointerDown={(ev) => onHandlePointerDown(e, "start", ev)}
                    dragHandlers={chipDrag.handlers}
                  />,
                  <AxisResizeHandle
                    key={`${e.key}-end`}
                    testId={`cal-time-handle-end-${e.item.note_id}`}
                    boundaryPx={e.endMin * pxPerMin}
                    onPointerDown={(ev) => onHandlePointerDown(e, "end", ev)}
                    dragHandlers={chipDrag.handlers}
                  />,
                ]
              : null,
          )}
        </div>
        {tailRows > 0 && <div aria-hidden style={{ height: tailRows * hourRowH }} />}
      </div>
    </div>
  );
}

/** ③ 눈금의 입력. **분을 먼저 읽고 날짜를 나중에** 읽는다 — 자정을 사이에 두면 "새 날의 00:00
 *  을 옛 날에 그리는" 쪽 대신 "한 박자 일찍 사라지는" 쪽으로 틀린다. */
export function readNowTick(): { minutes: number; todayIso: string } {
  const d = new Date();
  return { minutes: d.getHours() * 60 + d.getMinutes(), todayIso: todayLocal().day };
}
