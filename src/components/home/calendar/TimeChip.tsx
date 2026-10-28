import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";
import { folderColorCss } from "../../../lib/ui";
import { IconSettings } from "../../icons";
import { scheduleLabels } from "../../titlebar/scheduleRrule";
import { GFM_CHECKBOX_REGEX } from "../../../lib/inlineSchedule";
import {
  formatHhmm,
  parseHhmm,
  keepDurationMin,
  rowIsSameDay,
  TIME_LABEL_W,
  SNAP_MIN,
  type ChipDragMode,
  type LinkableEvent,
  type TimedEvent,
} from "../calendarLayout";
import { type DragHandlers } from "./useAxisDragSession";
import { RemindBadge } from "./RemindBadge";
import { durationLabel } from "./DayBriefing";
import { confirmForDelete, type ConfirmState } from "./useAxisConfirmFlow";
import type { MovePreview } from "./pendingMove";
import "./timeChip.css";


/**
 * 2026-10-27 기하 통일 — 칩의 높이는 **그 일정의 실제 길이**다(예전의 바닥 높이 CHIP_MIN_H ≈ 64.6px 는 기본 배율에서
 * 2시간 18분어치라, 짧은 일정은 칩의 아래 가장자리가 끝 시각과 무관했고 끝 손잡이를 끌어도 칩이 안 변했다).
 * 대신 **높이에 따라 보이는 줄 수가 줄어든다**(`chipTier`): 3줄(시각·제목·발췌) → 2줄 → 한 줄 → 작은 한 줄 → 막대.
 * 잘린 내용은 툴팁(title)과 더블클릭(노트 열기)으로 닿는다.
 */
export type ChipTier = "full" | "two" | "one" | "compact" | "bar";

/** 칩 한 줄의 픽셀 높이 = `--text-md`(13px × --fs) × `--lh-ui`(1.45). 글꼴 배율을 읽어 따라간다 — 토큰 값이 바뀌면
 *  여기 두 숫자도 같이 바꾼다(tokens.css 의 --text-md · --lh-ui). jsdom 처럼 --fs 를 못 읽으면 1. */
export function chipLinePx(): number {
  let fs = 1;
  if (typeof document !== "undefined") {
    const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs"));
    if (Number.isFinite(v) && v > 0) fs = v;
  }
  return 13 * fs * 1.45;
}

/** 높이(px)로 표시 단계를 고른다. 위아래 패딩(--space-1 × 2 = 8px)은 여러 줄 단계에만 든다. 작은 한 줄은
 *  `--text-xs`(11px) · 줄간격 1 이라 한 줄 높이의 약 0.7배면 들어간다. */
export function chipTier(heightPx: number, linePx: number): ChipTier {
  if (heightPx >= linePx * 3 + 8) return "full";
  if (heightPx >= linePx * 2 + 8) return "two";
  if (heightPx >= linePx) return "one";
  if (heightPx >= linePx * 0.7) return "compact";
  return "bar";
}

/** 겹침 칸 하나당 들여쓰기 — 칩·손잡이가 같은 값을 써야 서로 어긋나지 않는다(DayAxis 의 손잡이도 이걸 쓴다). */
export function laneLeft(lane: number): string {
  return lane === 0 ? `${TIME_LABEL_W}px` : `calc(${TIME_LABEL_W}px + var(--space-5) * ${lane})`;
}

/** 칩의 한 줄 — 각 줄이 **독립적으로** 말줄임한다. 1행은 정보 밀도가 높아 줄바꿈(flexWrap)이
 *  아니라 말줄임이 맞다: 280px 패널에서 감기 시작하면 3줄 구조 자체가 무너진다. */
export const CHIP_LINE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  lineHeight: "var(--lh-ui)",
};

/** 축 칩의 체크리스트 sub-list 한 줄 — `note_get` 왕복의 부산물인 첫 text 섹션 body_md 에서
 *  뽑는다(발췌와 같은 소스, 새 IPC 0). `lineIndex` 는 이 **섹션의 body_md 전체**를 `\n` 으로
 *  split 한 실제 줄 번호다 — 발췌용으로 걸러낸 로컬 배열의 인덱스가 아니다(그러면 todo_toggle
 *  이 엉뚱한 줄을 토글한다). */
export type ChipChecklistItem = { lineIndex: number; text: string; checked: boolean };
export type ChipChecklist = { sectionId: string; items: ChipChecklistItem[] };

/** `firstLines` 가 걷어내지 않는 GFM 체크리스트 줄(`- [ ] …`)을 발췌에서 떼어 칩 하단의 별도
 *  sub-list 로 보여주기 위한 추출. 정규식은 `lib/inlineSchedule` 의 `GFM_CHECKBOX_REGEX` 를
 *  그대로 재사용한다(중복 정의 금지 — 전역 "오늘의 할 일" 집계와 같은 판정 기준을 쓴다). */
export function extractChipChecklist(body: string): ChipChecklistItem[] {
  const items: ChipChecklistItem[] = [];
  body.split("\n").forEach((line, lineIndex) => {
    const match = line.match(GFM_CHECKBOX_REGEX);
    if (match) {
      items.push({ lineIndex, text: match[2].trim(), checked: match[1].toLowerCase() === "x" });
    }
  });
  return items;
}

export interface TimeChipProps {
  /** The timed event to render */
  e: TimedEvent;
  /** 이 칩의 픽셀 자리(layoutTimedEvents 의 결과 — top/height 는 시각·길이에서만 나오고 lane 은 겹침 들여쓰기 칸). */
  layout?: { top: number; height: number; lane?: number };
  pxPerMin: number;
  pending?: MovePreview | null;
  /** 칩 한 줄의 픽셀 높이(chipLinePx) — 축이 렌더마다 한 번 재서 내려준다. 없으면 여기서 잰다. */
  linePx?: number;
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  focusedNoteId?: string | null;
  folderById?: Map<string, { color_hue: number | null }>;
  excerpts?: Record<string, string>;
  checklists?: Record<string, ChipChecklist | null>;
  uiLang: string;
  chipDrag: {
    handlers: DragHandlers;
    swallowClick: () => boolean;
    isActive: () => boolean;
  };
  onChipPointerDown: (e: TimedEvent, ev: ReactPointerEvent<HTMLDivElement>) => void;
  onFocus: (noteId: string) => void;
  onOpen: (noteId: string) => void;
  plannedMove: (
    base: {
      key: string;
      startMin: number;
      endMin: number;
      durationMin: number;
      mode: ChipDragMode;
      positions: LinkableEvent[];
    },
    deltaPx: number,
  ) => { next: { startMin: number; endMin: number }; linked: MovePreview[] };
  chipPositions: () => LinkableEvent[];
  commitTimes: (
    e: TimedEvent,
    mode: ChipDragMode,
    next: { startMin: number; endMin: number },
    linked: MovePreview[],
  ) => Promise<void>;
  onRequestConfirm: (req: ConfirmState) => void;
  /** ⚙ 버튼 — 일정 수정 모달을 연다(롱프레스는 축의 드래그 세션이 같은 모달을 연다). */
  onEdit: (e: TimedEvent) => void;
  onToggleChecklistItem: (
    noteId: string,
    sectionId: string,
    lineIndex: number,
    currentChecked: boolean,
  ) => void;
}

export function TimeChip(props: TimeChipProps) {
  const {
    e,
    layout,
    pxPerMin,
    pending: pendingProp,
    linePx: linePxProp,
    searchHits,
    folderFilter,
    focusedNoteId,
    folderById,
    excerpts,
    checklists,
    uiLang,
    chipDrag,
    onChipPointerDown,
    onFocus,
    onOpen,
    plannedMove,
    chipPositions,
    commitTimes,
    onRequestConfirm,
    onEdit,
    onToggleChecklistItem,
  } = props;

  const dim =
    (searchHits !== null && searchHits !== undefined && !searchHits.has(e.item.note_id)) ||
    (folderFilter !== null && folderFilter !== undefined && e.item.folder_id !== folderFilter);

  const focused = e.item.note_id === focusedNoteId;

  const folder = folderById?.get(e.item.folder_id);
  const color = folder?.color_hue != null ? folderColorCss(folder.color_hue) : "var(--accent)";

  // 기하 통일(2026-10-27): top 은 언제나 시각이다(겹쳐도 밀지 않는다). 드래그 중이거나 저장을 기다리는 칩은
  // 미리보기(스냅 값) 시각으로 **그 자리에** 그린다 — 손잡이·라벨·저장 값이 전부 같은 수에서 나온다.
  // W15 — 미리보기는 목록이다(연동 이동). 이 칩의 것만 골라 쓴다.
  const pending = pendingProp ?? null;
  const topPx = pending !== null ? pending.startMin * pxPerMin : layout?.top ?? 0;
  const heightPx = pending !== null ? (pending.endMin - pending.startMin) * pxPerMin : layout?.height ?? 0;
  const tier = chipTier(heightPx, linePxProp ?? chipLinePx());
  const lane = layout?.lane ?? 0;
  const multiLine = tier === "full" || tier === "two";
  const timeLabel = pending === null ? e.item.start_time : formatHhmm(pending.startMin);
  // 행 모양으로 판정한다 — 잘린 span_start === span_end 는 10/31→11/2 를 10월에 하루로 본다.
  // DayDetailPanel 의 isResizable 과 같은 규칙.
  const resizable = rowIsSameDay(e.item);
  // W11 ③ 1행 — 시각 구간 + 반복 요약. **없는 끝을 지어내지 않는다**: 화면의 endMin 은
  // MIN_SLOT_MIN 까지 늘려진 값이고(planTimedDay), 여러 날 span 의 end_time 은 마지막
  // 날의 시각이라(§1.3 I3) 이 날의 끝이 아니다 — 둘 다 라벨에 쓰면 사용자가 만든 적
  // 없는 종료 시각을 읽게 된다. 그래서 하루짜리이고 end_time 이 실제로 있을 때만 구간.
  const endLabel = !resizable || !e.item.end_time
    ? null
    : pending === null
      ? e.item.end_time
      : formatHhmm(pending.endMin);
  // W15 ② — 지속시간. **끝이 있는 항목만** 갖는다(없는 끝을 지어내지 않는다 — 위 endLabel
  // 과 같은 조건). 값은 라벨과 **같은 두 시각의 차이**여야 한다: 화면 endMin 은
  // MIN_SLOT_MIN 까지 늘려진 값이라 15분짜리 일정에서 "30분"이라고 거짓말한다. 그래서
  // 평소엔 행의 시각 두 개로 재고, 드래그 중엔 미리보기 두 값으로 잰다(그 둘이 곧 라벨).
  const durMin =
    endLabel === null
      ? null
      : pending !== null
        ? pending.endMin - pending.startMin
        : (parseHhmm(e.item.end_time) ?? 0) - (parseHhmm(e.item.start_time) ?? 0);
  const durText = durMin !== null && durMin > 0 ? durationLabel(durMin) : null;
  // 반복 요약은 scheduleRrule 한 곳에서 나온다 — 종일 카드의 요약 줄과 같은 문자열이다.
  const repeatLabel = scheduleLabels(e.item, uiLang).repeat;
  // 3행 — 발췌의 **첫 줄만**. 캐시는 두 줄까지 갖고 있지만(firstLines) 칩은 한 줄이다.
  const excerptLine = (excerpts?.[e.item.note_id] ?? "").split("\n")[0];
  // 3행 아래 체크박스 sub-list — 발췌에서 걸러낸 GFM 체크리스트 줄들(요구사항 ①).
  // 없으면 null 이라 아래서 아무것도 그리지 않고, 그러면 칩 높이는 그대로다(요구사항 ⑤).
  const checklist = checklists?.[e.item.note_id] ?? null;
  return (
    // W11 ④ — 칩이 `<button>` 하나였는데, 펼친 설정에 텍스트 입력과 버튼들이 들어가야
    // 해서 wrapper `<div>` 가 됐다(버튼 안에 버튼/입력은 무효 DOM — DetailNoteCard 가
    // W1 에서 겪은 것과 같다). **핸들러는 옮기지 않았다**: 드래그·클릭·더블클릭·키보드는
    // 전부 이 wrapper 에 그대로 있고(리사이즈 손잡이도 그대로), 키보드 포커스를 받는
    // 유효한 요소만 안쪽 `<button>`(본문 3줄)으로 새로 생겼다 — 그 버튼의 키/클릭은
    // 버블링으로 여기 핸들러에 닿는다. 그래서 기존 동작과 테스트가 그대로 산다.
    <div
      key={e.key}
      data-testid={`cal-time-event-${e.item.note_id}`}
      data-chip-key={e.key}
      data-search-dim={dim ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      data-moving={pending !== null ? "true" : undefined}
      // 배경·선택 링·겹침 순서는 클래스가 갖는다(timeChip.css) — 상태 사이를 이징으로 잇는다.
      className="cal-chip"
      onPointerDown={(ev) => onChipPointerDown(e, ev)}
      {...chipDrag.handlers}
      onClick={() => {
        // 드래그 뒤에 따라오는 click 한 번은 삼킨다 — 옮기는 손짓이 포커스까지 바꾸면
        // 아래 상세 블록이 같이 튄다.
        if (chipDrag.swallowClick()) return;
        onFocus(e.item.note_id);
      }}
      onDoubleClick={() => onOpen(e.item.note_id)}
      onKeyDown={(ev) => {
        // 키보드도 옮길 수 있어야 한다 — 드래그만 만들면 이 기능에서 통째로 배제된다.
        // ↑/↓ = 15분, Shift 를 얹으면 1시간. Enter/Space(열기)는 아래 그대로.
        // 끝 시각 조정은 **여기에 넣지 않는다**(2026-09-10 오너 결정): 조합이 늘면
        // 외울 수 없고, 카드의 시각 입력(NoteDatesList)이 이미 키보드 경로다.
        if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
          ev.preventDefault();
          const step = (ev.key === "ArrowUp" ? -1 : 1) * (ev.shiftKey ? 60 : SNAP_MIN);
          const base = pending?.startMin ?? e.startMin;
          // W15 — 키보드도 연동된다(드래그와 같은 기능이 같은 경험이어야 한다). 이웃의
          // 자리는 **누를 때마다 새로** 읽는다(chipPositions) — 연달아 누르면 미리보기가
          // 누적돼 있고, 델타는 이번 한 번의 step 이다(DB 행은 앞선 누름까지 이미 밀렸다).
          const { next, linked } = plannedMove(
            {
              key: e.key,
              startMin: base,
              endMin: base + (e.endMin - e.startMin),
              durationMin: keepDurationMin(e.item.start_time, e.item.end_time, resizable),
              mode: "move",
              positions: chipPositions(),
            },
            step * pxPerMin,
          );
          if (next.startMin !== base) void commitTimes(e, "move", next, linked);
          return;
        }
        // W10 ②(오너 실기 2026-09-11): "중첩은 이대로 괜찮지만 **선택 후 제거**는
        // 가능해야 한다." 종일 카드는 펼치면 이미 제거 버튼이 있으므로(NoteDatesList)
        // 이 키는 축의 칩에만 걸린다 — 같은 일을 두 번 만들지 않는다.
        if (ev.key === "Delete" || ev.key === "Backspace") {
          ev.preventDefault();
          // 오너 실기 2026-09-16: "삭제할거야?" 한 번은 반복 없는 행도 예외가 아니다 —
          // D5(그릴 2026-09-11)가 반복 행에만 걸었던 확인을 모든 삭제로 넓힌다. 갈래
          // (관련 행 지우기 vs 대표 행 정밀도 비우기)는 그대로 removeDateRow 가 DB 행
          // 으로 판정한다(함정 ⓑ) — 여기서 결정하지 않는다. item.rrule 은
          // span_start/span_end 와 달리 화면에서 클리핑되지 않는 값(그 행의 rrule
          // 컬럼을 그대로 옮긴 것, specs/commands/dashboard.yaml::CalendarItem) —
          // note_dates_list 왕복을 한 번 더 태우지 않고 이 값으로 문구만 가른다.
          onRequestConfirm(confirmForDelete(e));
          return;
        }
        // See DetailNoteCard's comment — native button Enter/Space never fires dblclick.
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen(e.item.note_id);
        }
      }}
      // W15 ② — 툴팁엔 시각과 **지속시간**이 같이 있다. 화면 3줄은 280px 안에서 이미
      // 빠듯해 새 줄을 만들지 않는다(같은 값은 같은 대접 — W11 ②/W14 ② 의 툴팁 처방).
      title={
        durText === null
          ? `${timeLabel} ${displayTitle(e.item.title)}`
          : `${timeLabel} · ${durText} ${displayTitle(e.item.title)}`
      }
      style={{
        position: "absolute",
        top: topPx,
        height: heightPx,
        // 드래그 중에도 transition 은 없다 — 15분 칸(7px)마다 이징이 재시작되면 손을 놓칠 듯 달달 떨렸다.
        // W12 ③ — 칩의 크기는 **절대 안 바뀐다**(오너 실기 2026-09-11). 이 height 는 그 일정의 **길이**라
        // 설정 때문에 늘어나면 "일정이 길어졌다"는 거짓 정보가 된다. 설정은 이제 칩 안이 아니라 모달
        // (ChipEventModal — 설정 아이콘·롱프레스)에서 연다.
        // W9 ③: 여기 박혀 있던 `touchAction: "none"` 은 뺐다. 칩 위에서 시작한 터치가
        // 축을 통째로 못 굴리게 만들었고(칩이 24시간 축의 대부분을 덮는 날엔 스크롤이
        // 죽는다), 이제는 롱프레스로 드래그가 열리는 **그 순간** 훅이 같은 것을 건다.
        // 겹친 칩은 칸(lane)만큼 오른쪽으로 들어간다(아래로 밀지 않는다) — 뒤 칸이 DOM 순서상 나중이라 위에 그려진다.
        left: laneLeft(lane),
        right: 0,
        // 세로 칼럼(W11 ③). 각 줄이 자기 말줄임을 갖는다.
        display: "flex",
        flexDirection: "column",
        // W15 ⑤ — 여러 줄 단계는 좌상단 정렬(오너 실기 2026-09-11 — 세로 중앙이면 시각 라벨이 시작 눈금과
        // 어긋나 보인다). 한 줄 이하 단계는 칩이 그 줄 높이 언저리라 가운데에 둔다.
        justifyContent: multiLine ? "flex-start" : "center",
        // `overflow: hidden` 은 바깥이 아니라 안쪽 3줄 행(cal-chip-clip)에 둔다 — 말줄임은 줄마다
        // CHIP_LINE 이 갖고 있어 잘리는 모양은 같다(예전 플로팅 메뉴가 잘리지 않게 내려놓았던 자리).
        whiteSpace: "nowrap",
        textAlign: "left",
        border: "1px solid var(--line)",
        borderLeft: `2px solid ${color}`,
        borderRadius: "var(--radius-sm)",
        // D6(그릴 2026-09-11) — 축 칩만 "평소 반투명(--hover) · 호버·포커스 불투명(--surface-base)" 이다. 그 배경은
        // 이제 .cal-chip 클래스가 갖는다(timeChip.css — 겹친 칩 정책과 이징도 거기).
        padding: multiLine ? "var(--space-1) var(--space-3)" : "0 var(--space-3)",
        font: "inherit",
        // W15 ⑤ — 타입 스케일 사다리에서 **두 칸 위**(xs → sm → md). chipLinePx 가 이 토큰으로 줄 높이를 잰다.
        // 작은 한 줄 단계만 한 단 작게 줄여 30분(기본 배율 14px) 칩에도 제목이 보이게 한다.
        fontSize: tier === "compact" ? "var(--text-xs)" : "var(--text-md)",
        color: "inherit",
        cursor: pending === null ? "grab" : "grabbing",
        opacity: dim ? 0.35 : 1,
        // 선택 링 색은 .cal-chip[data-focused|data-moving] 이 갖는다(이징). 오너 결정 2026-09-10: 링은 안쪽으로. 밖으로 나간 링(offset 2 + 2px = 4px)이
        // 우측 스크롤 경계에서 잘려서 — 담는 스크롤러에 우측 패딩이 없다.
        outlineOffset: -2,
      }}
    >
      {/* 칩 높이(= 실제 길이) 안으로만 내용을 자른다. */}
      <div
        data-testid={`cal-chip-clip-${e.item.note_id}`}
        data-tier={tier}
        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}
      >
      <div
        style={{
          display: "flex",
          alignItems: multiLine ? "flex-start" : "center",
          gap: "var(--space-2)",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {/* 본문 3줄 — 키보드 포커스를 받는 유효한 요소. 핸들러를 갖지 않는다(위 wrapper
            가 전부 갖고 버블링으로 받는다) — 여기 또 달면 같은 일이 두 번 일어난다.
            Enter/Space 로 이 버튼이 던지는 click 은 wrapper 의 onKeyDown 이
            preventDefault 로 막고 직접 onOpen 을 부른다(예전 그대로). */}
        <button
          type="button"
          data-testid={`cal-chip-body-${e.item.note_id}`}
          tabIndex={0}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            border: 0,
            padding: 0,
            background: "transparent",
            font: "inherit",
            color: "inherit",
            textAlign: "left",
            cursor: "inherit",
          }}
        >
          {multiLine ? (
            <>
              <div
                data-testid={`cal-chip-meta-${e.item.note_id}`}
                style={{ ...CHIP_LINE, color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}
              >
                {endLabel ? `${timeLabel}–${endLabel}` : timeLabel}
                {/* W15 ② — 지속시간은 **끄는 동안에만** 이 줄에 붙는다. title 툴팁은 포인터를
                    누른 채로는 뜨지 않아 정작 필요한 순간에 안 보이고, 평소에도 붙여 두면
                    1행이 네 조각(시각·구간·길이·반복)이 되어 280px 에서 반복이 밀려난다. */}
                {pending !== null && durText ? ` · ${durText}` : ""}
                {repeatLabel ? ` · ${repeatLabel}` : ""}
              </div>
              <div data-testid={`cal-chip-title-${e.item.note_id}`} style={CHIP_LINE}>
                {displayTitle(e.item.title)}
              </div>
            </>
          ) : tier !== "bar" ? (
            // 한 줄 단계 — 시각(여러 줄 단계의 1행과 같은 내용)과 제목을 한 줄에. 끄는 동안엔 시각이 미리보기 값이다.
            <div style={{ ...CHIP_LINE, lineHeight: tier === "compact" ? 1 : "var(--lh-ui)" }}>
              <span
                data-testid={`cal-chip-meta-${e.item.note_id}`}
                style={{ color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}
              >
                {endLabel ? `${timeLabel}–${endLabel}` : timeLabel}
                {pending !== null && durText ? ` · ${durText}` : ""}
                {repeatLabel ? ` · ${repeatLabel}` : ""}
              </span>{" "}
              <span data-testid={`cal-chip-title-${e.item.note_id}`}>{displayTitle(e.item.title)}</span>
            </div>
          ) : null}
          {tier === "full" && excerptLine && (
            <div
              data-testid={`cal-chip-excerpt-${e.item.note_id}`}
              // 발췌는 본문이라 에디터 글꼴이다 — 카드의 발췌(FocusedDetails)와 같은 규칙.
              style={{ ...CHIP_LINE, color: "var(--faint)", fontFamily: "var(--font-editor)" }}
            >
              {excerptLine}
            </div>
          )}
        </button>
        {e.item.remind && tier !== "bar" && <RemindBadge size={10} noteId={e.item.note_id} />}
        {/* ④ 설정 — 마우스를 올렸을 때만 보인다(오너 2026-10-27, `.cal-chip-gear`: 호버·포커스에서 불투명). */}
        <button
          type="button"
          className="cal-chip-gear"
          data-testid={`cal-chip-settings-${e.item.note_id}`}
          aria-label={t("home.cal_chip_settings")}
          title={t("home.cal_chip_settings")}
          // 이 버튼에서 시작한 포인터는 칩 드래그를 열지 않는다 — 누르려던 손이 칩을
          // 옮기면 안 된다(카드의 그립과 정확히 반대 방향의 같은 규율).
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.stopPropagation(); // 포커스(칩 클릭)로 새지 않는다.
            onEdit(e);
          }}
          onDoubleClick={(ev) => ev.stopPropagation()} // 두 번 눌러 노트가 열리지 않는다.
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            border: 0,
            padding: 0,
            background: "transparent",
            cursor: "pointer",
            // 막대 단계는 칩이 아이콘보다 낮다 — 잘리지 않게 칩 오른쪽 가운데에 걸쳐 띄운다(설정은 시각 있는 항목이
            // 시각·반복에 이르는 유일한 자리라 숨기지 않는다, 아래 ④ 주석).
            ...(tier === "bar"
              ? { position: "absolute", right: "var(--space-2)", top: "50%", transform: "translateY(-50%)" }
              : {}),
          }}
        >
          <IconSettings size={12} strokeWidth={2} />
        </button>
      </div>
      {/* 요구사항 ① — 발췌(3행) 아래, 체크리스트 줄이 있을 때만 별도 sub-list. 3줄 단계에서만 그리고, 칩 높이
          (= 실제 길이) 안에 들어가는 만큼만 보인다(위 clip). */}
      {tier === "full" && checklist && checklist.items.length > 0 && (
        <div
          data-testid={`cal-chip-checklist-${e.item.note_id}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2xs)",
            marginTop: "var(--space-1)",
          }}
        >
          {checklist.items.map((ci) => (
            <label
              key={ci.lineIndex}
              data-testid={`cal-chip-checklist-item-${e.item.note_id}-${ci.lineIndex}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-2)",
                minWidth: 0,
                cursor: "pointer",
              }}
              // 체크박스를 누른 손짓은 칩 드래그·포커스·열기로 새면 안 된다 — 설정
              // 버튼과 같은 처방(위 onPointerDown/onClick/onDoubleClick stopPropagation).
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => ev.stopPropagation()}
              onDoubleClick={(ev) => ev.stopPropagation()}
            >
              <input
                type="checkbox"
                data-testid={`cal-chip-checklist-checkbox-${e.item.note_id}-${ci.lineIndex}`}
                checked={ci.checked}
                onChange={() =>
                  onToggleChecklistItem(
                    e.item.note_id,
                    checklist.sectionId,
                    ci.lineIndex,
                    ci.checked,
                  )
                }
                style={{
                  marginTop: "var(--space-2xs)",
                  width: 12,
                  height: 12,
                  flex: "none",
                  accentColor: "var(--accent)",
                  cursor: "pointer",
                }}
              />
              <span
                style={{
                  ...CHIP_LINE,
                  fontFamily: "var(--font-editor)",
                  color: ci.checked ? "var(--faint)" : "inherit",
                  textDecoration: ci.checked ? "line-through" : "none",
                }}
              >
                {ci.text}
              </span>
            </label>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
