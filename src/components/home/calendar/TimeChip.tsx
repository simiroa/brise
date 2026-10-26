import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
  Dispatch,
  SetStateAction,
} from "react";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";
import { folderColorCss } from "../../../lib/ui";
import { IconSettings } from "../../icons";
import {
  scheduleLabels,
  type RepeatDraft,
} from "../../titlebar/scheduleRrule";
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
import { ChipSchedule } from "./ChipSchedule";
import { type ConfirmState } from "./useAxisConfirmFlow";

export type MovePreview = { key: string; startMin: number; endMin: number };

/**
 * W11 ③ — 축 칩의 **바닥 높이**. 30분짜리 칩은 14px 라 3줄이 물리적으로 안 들어간다.
 *
 * 유도: 세 줄(시각·반복 / 제목 / 발췌)이 전부 칩의 글꼴 크기 `--text-md`(13px)를 그대로 쓰고
 * 줄간격은 UI 기본 `--lh-ui`(1.45) 이므로 13 × 1.45 × 3 = 56.55px, 거기에 칩의 위아래 패딩
 * (`--space-1` × 2 = 8px)을 더해 ≈ 64.6px. 박스 모델이 border-box 라(tokens.css `*`) minHeight
 * 안에 패딩이 포함되므로 이 합이 그대로 바닥이다.
 *
 * 생 px 로 굳히지 않는 이유: 사용자가 글꼴 배율(`--fs`)을 키우면 세 줄은 커지는데 바닥은 그대로
 * 남아 3행이 다시 잘린다 — 토큰 곱으로 두면 배율을 따라온다.
 *
 * **W15 ⑤ — 이 식의 글꼴 토큰은 칩 본문의 것과 반드시 같아야 한다.** 칩 텍스트를 `--text-xs` →
 * `--text-md` 로 두 단 키우면서 여기를 안 맞추면 커진 글자가 좁아진 상자에서 잘린다(이 웨이브의
 * 지시서가 명시한 함정 그대로).
 */
export const CHIP_MIN_H = "calc(var(--text-md) * var(--lh-ui) * 3 + var(--space-1) * 2)";

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
  e?: TimedEvent;
  event?: TimedEvent;
  /** Layout top and height or individual numbers */
  top?: number;
  height?: number;
  layout?: { top: number; height: number };
  pxPerMin: number;
  pending?: MovePreview | null;
  dim?: boolean;
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  focused?: boolean;
  focusedNoteId?: string | null;
  color?: string;
  folderById?: Map<string, { color_hue: number | null }>;
  excerptLine?: string;
  excerpts?: Record<string, string>;
  checklist?: ChipChecklist | null;
  checklists?: Record<string, ChipChecklist | null>;
  open?: { key: string; field: "time" | "repeat" | null } | null;
  openChip?: { key: string; field: "time" | "repeat" | null } | null;
  uiLang: string;
  chipSettingsRef?: RefObject<HTMLButtonElement | null> | null;
  chipMenuRef: RefObject<HTMLDivElement | null>;
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
  ) => { next: { startMin: number; endMin: number }; linked: MovePreview[]; deltaMin: number };
  chipPositions: () => LinkableEvent[];
  commitTimes: (
    e: TimedEvent,
    mode: ChipDragMode,
    next: { startMin: number; endMin: number },
    linked: MovePreview[],
    deltaMin: number,
  ) => Promise<void>;
  onRequestConfirm: (req: ConfirmState) => void;
  setOpenChip: Dispatch<SetStateAction<{ key: string; field: "time" | "repeat" | null } | null>>;
  onToggleChecklistItem: (
    noteId: string,
    sectionId: string,
    lineIndex: number,
    currentChecked: boolean,
  ) => void;
  commitChipTime: (e: TimedEvent, part: "start" | "end", value: string | null) => void | Promise<unknown>;
  onRepeatApply: (e: TimedEvent, draft: RepeatDraft) => void;
}

export function TimeChip(props: TimeChipProps) {
  const targetEvent = props.e ?? props.event;
  if (!targetEvent) return null;

  const {
    layout,
    top: topProp,
    height: heightProp,
    pxPerMin,
    pending: pendingProp,
    dim: dimProp,
    searchHits,
    folderFilter,
    focused: focusedProp,
    focusedNoteId,
    color: colorProp,
    folderById,
    excerptLine: excerptLineProp,
    excerpts,
    checklist: checklistProp,
    checklists,
    open: openProp,
    openChip,
    uiLang,
    chipSettingsRef,
    chipMenuRef,
    chipDrag,
    onChipPointerDown,
    onFocus,
    onOpen,
    plannedMove,
    chipPositions,
    commitTimes,
    onRequestConfirm,
    setOpenChip,
    onToggleChecklistItem,
    commitChipTime,
    onRepeatApply,
  } = props;

  const e = targetEvent;

  const dim =
    dimProp !== undefined
      ? dimProp
      : (searchHits !== null && searchHits !== undefined && !searchHits.has(e.item.note_id)) ||
        (folderFilter !== null && folderFilter !== undefined && e.item.folder_id !== folderFilter);

  const focused =
    focusedProp !== undefined
      ? focusedProp
      : e.item.note_id === focusedNoteId;

  const folder = folderById?.get(e.item.folder_id);
  const color =
    colorProp !== undefined
      ? colorProp
      : folder?.color_hue != null
        ? folderColorCss(folder.color_hue)
        : "var(--accent)";

  const topPx = topProp !== undefined ? topProp : layout?.top ?? 0;
  const baseHeightPx = heightProp !== undefined ? heightProp : layout?.height ?? 0;

  // 드래그 중이거나 저장을 기다리는 칩은 시간델타만큼 **밀어서** 그린다 — top 을 다시
  // 계산하지 않는 이유는 함정 ⓐ 와 같다(top 은 스태킹 스윕을 거친 값이라 시간이 아니다).
  // 손잡이로 늘린 경우엔 높이도 미리보기 값을 쓴다(시작 손잡이는 밀림 + 높이 둘 다).
  // W15 — 미리보기는 목록이다(연동 이동). 이 칩의 것만 골라 쓰고, 아래 계산은 그대로다.
  const pending = pendingProp !== undefined ? pendingProp : null;
  const shiftPx = pending === null ? 0 : (pending.startMin - e.startMin) * pxPerMin;
  const heightPx =
    pending === null ? baseHeightPx : (pending.endMin - pending.startMin) * pxPerMin;
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
  const excerptLine =
    excerptLineProp !== undefined
      ? excerptLineProp
      : (excerpts?.[e.item.note_id] ?? "").split("\n")[0];
  // 3행 아래 체크박스 sub-list — 발췌에서 걸러낸 GFM 체크리스트 줄들(요구사항 ①).
  // 없으면 null 이라 아래서 아무것도 그리지 않고, 그러면 칩 높이는 그대로다(요구사항 ⑤).
  const checklist =
    checklistProp !== undefined
      ? checklistProp
      : checklists?.[e.item.note_id] ?? null;
  const open =
    openProp !== undefined
      ? openProp
      : openChip?.key === e.key
        ? openChip
        : null;

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
      data-search-dim={dim ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      data-moving={pending !== null ? "true" : undefined}
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
          const { next, linked, deltaMin } = plannedMove(
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
          if (next.startMin !== base) void commitTimes(e, "move", next, linked, deltaMin);
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
          setOpenChip(null); // 포포버 위 모달 금지(보통 이미 닫혀 있다).
          onRequestConfirm(
            e.item.rrule
              ? { kind: "deleteRepeat", key: e.key, noteId: e.item.note_id, dateId: e.item.date_id }
              : { kind: "deleteEvent", key: e.key, noteId: e.item.note_id, dateId: e.item.date_id },
          );
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
        // W11 ③ — 짧은 일정(30분 = 14px)에도 3줄이 다 보이는 바닥. `height` 는
        // 스태킹 계산(planTimedDay)이 쓰는 값이라 **그대로 두고** 바닥만 준다. 그래서
        // 아래 칩과 겹칠 수 있고, 그것은 오너가 승인한 것이다("위치 중복도 가능함").
        minHeight: CHIP_MIN_H,
        transform: shiftPx === 0 ? undefined : `translateY(${shiftPx}px)`,
        // W15 ④ — 15분 칸마다 순간이동하던 것을 짧게 이징해 "자석에 걸리는" 느낌을 준다.
        // 커브·지속시간은 이 저장소가 칩/버튼 눌림에 이미 쓰는 것과 **같은 값**이다
        // (tokens.css `.chip-btn`) — 새 토큰을 만들지 않는다. --dur-fast(.12s)보다 느리게
        // 걸면 빠른 마우스 이동을 못 따라가 고무줄처럼 끌려온다.
        // **드래그 중(pending)에만** 건다: 놓고 굳거나 재조회가 와서 최종 자리로 바뀌는
        // 순간엔 transition 이 없어야 한다(그때 걸려 있으면 스르륵 미끄러진다). 그 순간은
        // pending 이 사라지는 렌더와 같은 렌더라 새 스타일엔 이 속성이 아예 없다.
        ...(pending === null
          ? {}
          : { transition: "transform var(--dur-fast) cubic-bezier(0.2, 0, 0, 1)" }),
        // 옮기는 칩은 이웃 위로 — 이웃은 새 데이터가 와야 다시 쌓인다. 삼항으로 쓰면
        // check:type-scale ⓔ 가 값을 읽지 못해 거부한다(굵기 규칙과 같은 처방 —
        // 조건부면 속성 자체를 뺀다). 1 은 지역 스태킹 예외 범위(0~3)다.
        ...(pending === null ? {} : { zIndex: 1 }),
        // W12 ③ — 설정이 열려도 칩의 크기는 **절대 안 바뀐다**(오너 실기 2026-09-11).
        // 예전엔 height:"auto" 로 칩이 늘어났는데, 이 height 는 그 일정의 **길이**라
        // 늘어나면 "일정이 길어졌다"는 거짓 정보가 된다. 펼침은 아래의 플로팅 메뉴가
        // 맡고, 칩은 열려 있든 아니든 height + minHeight 그대로다.
        // W9 ③: 여기 박혀 있던 `touchAction: "none"` 은 뺐다. 칩 위에서 시작한 터치가
        // 축을 통째로 못 굴리게 만들었고(칩이 24시간 축의 대부분을 덮는 날엔 스크롤이
        // 죽는다), 이제는 롱프레스로 드래그가 열리는 **그 순간** 훅이 같은 것을 건다.
        // Full width always — see the file header for why overlaps stack, not split.
        left: TIME_LABEL_W,
        right: 0,
        // 3줄이므로 가로줄이 아니라 세로 칼럼이다(W11 ③). 각 줄이 자기 말줄임을 갖는다.
        display: "flex",
        flexDirection: "column",
        // W15 ⑤ — 좌상단 정렬(오너 실기 2026-09-11). 세로 중앙(center)이면 긴 일정의 칩에서
        // 글자가 상자 한가운데로 내려가 **시각 라벨이 그 일정의 시작 눈금과 어긋나 보인다**.
        justifyContent: "flex-start",
        // W12 ③ — `overflow: hidden` 은 여기 있으면 **아래 플로팅 메뉴를 통째로
        // 잘라낸다**(절대 배치된 자식도 잘린다). 안쪽 3줄 행으로 내렸다 — 말줄임은
        // 원래부터 줄마다 CHIP_LINE 이 갖고 있어 잘리는 모양은 그대로다.
        whiteSpace: "nowrap",
        textAlign: "left",
        border: "1px solid var(--line)",
        borderLeft: `2px solid ${color}`,
        borderRadius: "var(--radius-sm)",
        // D6(그릴 2026-09-11) — 축 칩만 이 저장소의 "평소 투명·호버 채움" 관례에서
        // 벗어난다(예외는 이 한 곳뿐, GRILL §1 D6). 뒤에 24시간 눈금선이 지나가서
        // 평소에도 반투명(`--hover`)으로 칩의 존재를 알리고, 호버 또는 **포커스**
        // (키보드로 옮긴 뒤에도)일 때 불투명해진다 — W12 ①의 "평소
        // transparent · 호버 --hover" 는 축이 아닌 표면(DetailNoteCard 등)에 남는다.
        // 정정(그릴 2026-09-13): 여기 있던 `var(--bg)` 는 색 구조 C1(64c1b269)이
        // `--bg` 를 종이질감+글로우 레이어가 낀 캔버스 합성값으로 바꾼 뒤로 작은 칩에
        // 얹으면 배경과 섞여 "더 투명해진 것처럼" 보였다(D6 의도와 정반대 결과) — 알파가
        // 없는 단일 톤인 `--surface-base` 로 바꿔 실제로 불투명해지게 한다.
        background: focused ? "var(--surface-base)" : "var(--hover)",
        padding: "var(--space-1) var(--space-3)",
        font: "inherit",
        // W15 ⑤ — 타입 스케일 사다리에서 **두 칸 위**(xs → sm → md). 3줄이 전부 이 크기를
        // 상속하므로 CHIP_MIN_H 의 유도식도 같은 토큰이어야 한다(그 주석 참고).
        fontSize: "var(--text-md)",
        color: "inherit",
        cursor: pending === null ? "grab" : "grabbing",
        opacity: dim ? 0.35 : 1,
        outline: focused || pending !== null ? "2px solid var(--accent)" : "none",
        // 오너 결정 2026-09-10: 링은 안쪽으로. 밖으로 나간 링(offset 2 + 2px = 4px)이
        // 우측 스크롤 경계에서 잘려서 — 담는 스크롤러에 우측 패딩이 없다.
        outlineOffset: -2,
      }}
      onMouseEnter={(ev) => {
        ev.currentTarget.style.background = "var(--surface-base)";
      }}
      onMouseLeave={(ev) => {
        // D6 — 포커스가 남아 있으면 호버가 끝나도 불투명을 유지한다(3단계: 평소 --hover
        // · 호버 또는 포커스 --surface-base). focused 는 이 렌더의 클로저 값 — 매 렌더 이
        // 핸들러가 새로 만들어지므로 최신 값을 그대로 읽는다.
        ev.currentTarget.style.background = focused ? "var(--surface-base)" : "var(--hover)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--space-2)",
          minWidth: 0,
          // 칩 wrapper 에서 내려온 것 — 이유는 위 style 의 W12 ③ 주석.
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
          {excerptLine && (
            <div
              data-testid={`cal-chip-excerpt-${e.item.note_id}`}
              // 발췌는 본문이라 에디터 글꼴이다 — 카드의 발췌(FocusedDetails)와 같은 규칙.
              style={{ ...CHIP_LINE, color: "var(--faint)", fontFamily: "var(--font-editor)" }}
            >
              {excerptLine}
            </div>
          )}
        </button>
        {e.item.remind && <RemindBadge size={10} noteId={e.item.note_id} />}
        {/* ④ 설정 — **호버에 숨기지 않는다.** 시각 있는 항목은 종일 카드가 아예 없어
            (listItems = plan.allDay) 이 칩이 시각·반복에 이르는 유일한 자리이고, 터치엔
            호버가 없어 숨기면 그 경로가 통째로 사라진다. 대신 평소엔 옅게(--faint) 두고
            호버/펼침에서 또렷해진다 — 1행이 아니라 아이콘 자신이 반응한다(1행 전체를
            강조하면 그 줄이 눌리는 것처럼 보이는데, 실제 조작부는 이 아이콘이다). */}
        <button
          type="button"
          // 열려 있는 칩의 토글 버튼만 ref 를 갖는다(축 전체에 하나뿐) — 바깥 클릭
          // 판정이 이 버튼을 "바깥"으로 보면 mousedown 이 닫고 click 이 다시 열어
          // 아무리 눌러도 안 닫힌다(Select.tsx 가 btnRef 를 같이 넘기는 이유).
          ref={open === null ? null : chipSettingsRef}
          data-testid={`cal-chip-settings-${e.item.note_id}`}
          aria-label={t("home.cal_chip_settings")}
          title={t("home.cal_chip_settings")}
          aria-expanded={open !== null}
          // 이 버튼에서 시작한 포인터는 칩 드래그를 열지 않는다 — 누르려던 손이 칩을
          // 옮기면 안 된다(카드의 그립과 정확히 반대 방향의 같은 규율).
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.stopPropagation(); // 포커스(칩 클릭)로 새지 않는다.
            setOpenChip((cur) => (cur?.key === e.key ? null : { key: e.key, field: null }));
          }}
          onDoubleClick={(ev) => ev.stopPropagation()} // 두 번 눌러 노트가 열리지 않는다.
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            border: 0,
            padding: 0,
            background: "transparent",
            color: open === null ? "var(--faint)" : "var(--accent)",
            cursor: "pointer",
          }}
          onMouseEnter={(ev) => {
            ev.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(ev) => {
            ev.currentTarget.style.color = open === null ? "var(--faint)" : "var(--accent)";
          }}
        >
          <IconSettings size={12} strokeWidth={2} />
        </button>
      </div>
      {/* 요구사항 ① — 발췌(3행) 아래, 체크리스트 줄이 있을 때만 별도 sub-list. 칩의
          height 는 그 일정의 길이라(위 W12 ③ 주석) 이 sub-list 로 칩이 `height` 보다
          커지는 것은 W11 ③/W12 ③ 이 이미 허용한 겹침이다(요구사항 ⑤) — 체크박스가
          없는 칩은 이 블록 자체가 없어 높이가 그대로다. */}
      {checklist && checklist.items.length > 0 && (
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
      {open && (
        <ChipSchedule
          menuRef={chipMenuRef}
          onClose={() => setOpenChip(null)}
          item={e.item}
          resizable={resizable}
          uiLang={uiLang}
          field={open.field}
          onToggleField={(field) =>
            setOpenChip((cur) =>
              cur === null
                ? cur
                : { key: cur.key, field: cur.field === field ? null : field },
            )
          }
          onTime={(part, value) => void commitChipTime(e, part, value)}
          onRepeatApply={(draft) => onRepeatApply(e, draft)}
        />
      )}
    </div>
  );
}
