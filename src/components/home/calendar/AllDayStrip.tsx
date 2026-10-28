import {
  useState,
  useEffect,
  useRef,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CalendarItem } from "../../../lib/commands.gen";
import type { DropPreviewState } from "./useAxisConfirmFlow";
import { IconGrip, IconSettings } from "../../icons";
import { t } from "../../../i18n/t";
import { call } from "../../../lib/invoke";
import { bumpNoteQueryVersion } from "../../../lib/noteQuery";
import { useEscapeConsumer } from "../../../lib/overlayStack";
import { folderColorCss } from "../../../lib/ui";
import { displayTitle } from "../../../stores/notes";
import { toDateInputValue, formatEventBadge } from "../../titlebar/eventDate";
import { formatScheduleSummary } from "../../titlebar/scheduleRrule";
import {
  itemKey,
  planAllDayDrop,
  rowIsSameDay,
  formatHhmm,
} from "../calendarLayout";
import { RemindBadge } from "./RemindBadge";
import { NoteDatesList } from "../../attachments/NoteDatesList";
import { fetchDateRow, commitDateRow, timeChangeLabel } from "./dateWrite";
import { useAxisDragSession, type DragHandlers } from "./useAxisDragSession";

/** 시간축이 부모에게 올려 주는 손잡이 — **축의 좌표계를 아는 것은 축뿐**이다(W8 ②).
 *  부모가 스크롤러·캔버스 두 ref 로 자식 내부 DOM 을 더듬던 자리를 이것이 대신한다. */
export type AxisHandle = {
  /** 이 클라이언트 좌표가 축의 **보이는 영역** 안이면 그 자리의 시작 분, 밖이면 null. */
  startMinAt: (clientX: number, clientY: number) => number | null;
  /** W17 — 드래그가 지금 이 높이에 있다. 가장자리에 머무는 동안 축이 스스로 스크롤한다.
   *  부모(종일 카드 드롭)는 축의 스크롤러를 모르므로 이 손잡이로만 부탁한다(W8 ②).
   *  `resync` 는 축이 한 번 밀릴 때마다 불린다 — 포인터가 가만히 있어도 미리보기가 따라오도록
   *  호출자의 "이 좌표의 미리보기를 다시 그려라"를 넘긴다. */
  trackDragAt: (clientY: number, resync: () => void) => void;
  /** 드롭·취소·Escape — 자동 스크롤 루프를 끊는다. 안 부르면 손을 떼도 계속 흐른다. */
  stopAutoScroll: () => void;
};

/**
 * 플로팅 메뉴·패널 닫기 — 바깥 클릭과 Escape(W14 ③ / W12 ③ 공용).
 *
 * 공용 `useDismiss`(lib/ui)를 쓰지 **않은** 이유가 하나 있다: 두 패널 안의 Select 는 목록을
 * **포털**로 띄우므로(Select.tsx) 그 목록 클릭이 useDismiss 에게는 "바깥"이고, 값을 고르는
 * mousedown 이 패널을 먼저 닫아 버려 그 click 이 아무 데도 닿지 않는다(= 반복을 고를 수 없다).
 * 그래서 포털된 목록만 예외로 두는 이 한 지점을 직접 짰다 — 나머지(window mousedown, ref 로
 * 영역 판정)는 그 훅과 같은 모양이다. 예외는 옵션이 아니라 기본이다: 두 사용처 모두 안에
 * Select 가 있다(칩은 반복 주기, 필의 패널은 NoteDatesList 의 것).
 *
 * Escape 는 Select 와 같은 분담이다: 포커스가 패널 안이면 이 window 리스너까지 오지 않으므로
 * (React 루트에서 stopPropagation) 패널 자신의 onKeyDown 이 맡고, 여기선 그 밖을 맡는다.
 */
export function useDismissOnOutside(
  active: boolean,
  /** 여기 안에서 시작한 mousedown 은 "바깥"이 아니다 — 패널 자신과 그것을 여는 토글 버튼. */
  insideRefs: readonly RefObject<Element | null>[],
  onClose: () => void,
) {
  // 매 렌더 새로 만들어지는 콜백·배열을 deps 에 넣으면 리스너가 매 렌더 재등록된다. 최신 값만
  // ref 로 들고 이펙트는 `active` 에만 반응한다 — lib/ui 의 useDismiss 와 같은 처방.
  const latest = useRef({ insideRefs, onClose });
  latest.current = { insideRefs, onClose };
  // Escape 는 공용 체인(lib/overlayStack)의 한 단계로 받는다 — 보조 창(브리핑)의 AuxWindowChrome 은
  // 체인이 비었을 때만 Escape 로 창을 닫으므로, 손으로 단 window 리스너였을 때는 메뉴를 닫는 Escape 가
  // 창까지 닫았다(GRILL-2026-10-19 W4 검증). 메인 창은 Escape 로 닫히지 않아 드러나지 않았다.
  useEscapeConsumer(active, () => latest.current.onClose());
  useEffect(() => {
    if (!active) return;
    const onDown = (ev: MouseEvent) => {
      const tgt = ev.target as Node | null;
      if (latest.current.insideRefs.some((r) => r.current?.contains(tgt))) return;
      if (tgt instanceof Element && tgt.closest('[role="listbox"]')) return;
      latest.current.onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
    };
  }, [active]);
}

export function SectionLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        color: "var(--faint)",
        fontSize: "var(--text-label)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      {text}
    </div>
  );
}

/**
 * 항목의 메타 한 줄 — 일정이 있으면 일정 요약이고(D5), 아무 일정도 없는 항목(기간 노트 등)은
 * 날짜 표기로 되돌아간다(그 값이 통째로 비면 항목이 날짜를 잃는다). 월 모드 카드는 이것을
 * **둘째 줄**로 그리고, 가로 스트립의 필은 폭이 없어 `title` 툴팁으로 옮겼다(W14 ②) — 같은 값이
 * 두 그릇에서 다른 문자열이 되지 않게 한 곳에서 만든다.
 */
function itemMeta(item: CalendarItem, uiLang: string): string {
  return (
    formatScheduleSummary(item, uiLang) ||
    formatEventBadge(item.year, item.month, item.day, {
      end_year: item.end_year,
      end_month: item.end_month,
      end_day: item.end_day,
    })
  );
}

/** 카드와 필이 **같은 규칙**으로 흐려지고 같은 점을 그린다(검색·폴더 필터, 폴더색, 관련 여부).
 *  2026-09-10 (§D4): 관련 날짜인지는 kind 가 아니라 position 이 말한다("extra" 은퇴). */
function itemVisuals(
  item: CalendarItem,
  searchHits: Set<string> | null,
  folderFilter: string | null,
  folderById?: Map<string, { color_hue: number | null }>,
) {
  const folder = folderById?.get(item.folder_id);
  return {
    dim:
      (searchHits !== null && !searchHits.has(item.note_id)) ||
      (folderFilter !== null && item.folder_id !== folderFilter),
    color: folder?.color_hue != null ? folderColorCss(folder.color_hue) : "var(--muted)",
    isRelated: item.position !== 0,
  };
}

/** 폴더색 점 — 대표 날짜는 원, 관련 날짜는 테두리만 있는 사각(§D4). 카드·필 공용. */
export function FolderDot({ color, isRelated }: { color: string; isRelated: boolean }) {
  return (
    <i
      style={{
        width: 8,
        height: 8,
        borderRadius: isRelated ? 1 : "50%",
        background: isRelated ? "transparent" : color,
        border: isRelated ? `1.5px solid ${color}` : undefined,
        flex: "none",
      }}
    />
  );
}

/**
 * W14 — 가로 스트립의 한 칸. `.chip-btn` 크기 관례를 입은 압축 필이고, **세로로 자라는 것이
 * 하나도 없다**: 둘째 줄은 `title` 툴팁(W14 ②), 펼침은 스트립 아래로 뜨는 패널(W14 ③, 그릇은
 * 부모가 그린다 — 가로 스크롤러가 절대 배치 자식을 잘라내므로).
 *
 * wrapper 가 `<div>` 인 이유는 카드와 같다 — 버튼 안에 버튼은 무효 DOM 이다. 그립·본체·설정
 * 셋이 각자 버튼이고, 시각적 박스와 호버는 `.chip-btn` 클래스가 갖는다(인라인 배경 금지).
 */
export function AllDayPill({
  item,
  uiLang,
  onFocus,
  onOpen,
  focused,
  open,
  onToggleOpen,
  settingsRef,
  dragHandlers,
  searchHits,
  folderFilter,
  folderById,
}: {
  item: CalendarItem;
  uiLang: string;
  onFocus: () => void;
  onOpen: () => void;
  focused: boolean;
  /** 이 필의 펼침 패널이 열려 있나 — 스트립 전체에 하나뿐이다(부모가 행 키로 판정). */
  open: boolean;
  onToggleOpen: () => void;
  /** 열려 있는 필의 설정 버튼만 받는다 — 바깥 클릭 판정이 이 버튼을 "바깥"으로 보면 mousedown
   *  이 닫고 click 이 다시 열어 아무리 눌러도 안 닫힌다(축 칩의 chipSettingsRef 와 같은 이유). */
  settingsRef: RefObject<HTMLButtonElement | null> | null;
  /** W7/W9 ②: 축으로 끌어 시각을 얹는 제스처 — **왼쪽 그립에만** 걸린다. 본체는 클릭=포커스 /
   *  더블클릭=열기 두 가지만 맡는다(한 요소가 셋을 겸하면 어느 손짓이 무엇인지 알 수 없다). */
  dragHandlers: DragHandlers & { onPointerDown: (ev: ReactPointerEvent<Element>) => void };
  searchHits: Set<string> | null;
  folderFilter: string | null;
  folderById?: Map<string, { color_hue: number | null }>;
}) {
  const { dim, color, isRelated } = itemVisuals(item, searchHits, folderFilter, folderById);
  return (
    <div
      className="chip-btn"
      data-testid={`cal-detail-card-${item.note_id}`}
      style={{
        flex: "none",
        maxWidth: "100%",
        opacity: dim ? 0.35 : 1,
        outline: focused ? "2px solid var(--accent)" : "none",
        // 오너 결정 2026-09-10: 링은 박스 안쪽 — 밖으로 나간 링이 스크롤 경계에서 잘렸다.
        // 스트립은 가로 스크롤러라 첫 칸/마지막 칸에서 정확히 같은 일이 일어난다.
        outlineOffset: -2,
        // 그립의 `.icon-btn` 이 자기 여백을 갖는다 — 클래스의 왼쪽 패딩까지 더하면 제목이
        // 280px 패널에서 그만큼 더 잘린다.
        paddingLeft: 0,
      }}
    >
      {/* W9 ②/W12 ②: 끄는 것은 이 그립뿐이고, `.icon-btn` 의 호버·`:active` 축소가 이 저장소의
          "끌 수 있다" 신호다. 조작부라서 aria-label 은 갖지만 탭 순서에는 넣지 않는다
          (tabIndex -1) — Enter 로 할 일이 없는 정지 지점을 만들지 않고, 새 단축키도 발명하지
          않는다. 키보드로 시각을 바꾸는 길은 축 칩의 ↑/↓ 와 펼침 패널의 시각 입력 둘이다. */}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        tabIndex={-1}
        data-testid={`cal-detail-grip-${item.note_id}`}
        aria-label={t("home.cal_drag_grip")}
        title={t("home.cal_drag_grip")}
        onPointerDown={(ev) => {
          ev.currentTarget.style.cursor = "grabbing";
          dragHandlers.onPointerDown(ev);
        }}
        onPointerMove={dragHandlers.onPointerMove}
        onPointerUp={(ev) => {
          ev.currentTarget.style.cursor = "grab";
          dragHandlers.onPointerUp(ev);
        }}
        onPointerCancel={(ev) => {
          ev.currentTarget.style.cursor = "grab";
          dragHandlers.onPointerCancel();
        }}
        // flex/display/정렬/테두리/배경/색은 전부 `.icon-btn` 이 갖는다 — 인라인으로 겹쳐 쓰면
        // 그 클래스의 호버 규칙이 죽는다. cursor 만 남는다(클래스는 pointer 인데 이 버튼은
        // grab/grabbing 을 포인터 이벤트에서 직접 바꾼다).
        style={{ cursor: "grab" }}
      >
        <IconGrip size={14} />
      </button>
      <FolderDot color={color} isRelated={isRelated} />
      <button
        type="button"
        data-testid={`cal-detail-note-${item.note_id}`}
        data-search-dim={dim ? "true" : undefined}
        data-focused={focused ? "true" : undefined}
        // W14 ② — 옛 둘째 줄이 여기로 왔다. 가로 필에 두 줄이 들어갈 폭이 없고, 그 값은 축과
        // 헤더가 이미 더 정확하게 말하고 있다(날씨 라벨을 툴팁으로 옮긴 W11 ② 과 같은 처방).
        title={`${displayTitle(item.title)} · ${itemMeta(item, uiLang)}`}
        onClick={onFocus}
        onDoubleClick={onOpen}
        onKeyDown={(ev) => {
          // 카드와 같다 — 네이티브 <button> 은 Enter/Space 에서 click(=포커스)만 던지고
          // dblclick 은 절대 안 던진다. 이게 없으면 키보드가 노트를 열 길을 잃는다.
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onOpen();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          minWidth: 0,
          border: 0,
          padding: 0,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            // 필의 폭 상한은 제목이 정한다. 생 px 이 아니라 `ch` 인 이유: 사용자가 글꼴 배율
            // (`--fs`)을 키우면 상한도 같이 커져야 잘리는 글자 수가 그대로 남는다. 12ch 는
            // 280px 패널에서 두 칸 남짓이 나란히 서는 폭이다 — 더 좁으면 제목을 못 읽고, 더
            // 넓으면 한 칸이 스트립을 독차지해 "가로로 여러 개"라는 의미가 사라진다.
            maxWidth: "12ch",
          }}
        >
          {displayTitle(item.title)}
        </span>
        {/* 오너 결정 2026-09-10: 일정 행 목록이 보일 때는 배지를 생략한다 — 그 목록에 행마다
            벨 버튼이 있어 벨이 둘이면 어느 쪽이 조작 가능한지 흐려진다. */}
        {!open && item.remind && <RemindBadge size={11} noteId={item.note_id} />}
      </button>
      {/* W14 ③ — 펼침은 이 아이콘이 연다(포커스가 아니라). 축 칩의 설정도 같은 아이콘 클릭으로
          열리므로 같은 종류의 조작이 같은 경험이 된다. 호버에 숨기지 않는 이유도 칩과 같다:
          터치엔 호버가 없어 숨기면 경로가 통째로 사라진다 — 평소 옅게(--faint), 열리면 accent. */}
      <button
        type="button"
        ref={settingsRef}
        data-testid={`cal-detail-settings-${item.note_id}`}
        aria-label={t("home.cal_chip_settings")}
        title={t("home.cal_chip_settings")}
        aria-expanded={open}
        // 이 버튼에서 시작한 포인터는 드래그를 열지 않는다 — 누르려던 손이 필을 옮기면 안 된다.
        onPointerDown={(ev) => ev.stopPropagation()}
        onClick={(ev) => {
          ev.stopPropagation(); // 포커스(본체 클릭)로 새지 않는다.
          onToggleOpen();
        }}
        onDoubleClick={(ev) => ev.stopPropagation()} // 두 번 눌러 노트가 열리지 않는다.
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          border: 0,
          padding: 0,
          background: "transparent",
          color: open ? "var(--accent)" : "var(--faint)",
          cursor: "pointer",
        }}
      >
        <IconSettings size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

export function DetailNoteCard({
  item,
  onFocus,
  onOpen,
  focused = false,
  showDates = false,
  expanded = false,
  selectedDay = null,
  excerpt,
  uiLang = "en",
  searchHits = null,
  folderFilter = null,
  folderById,
  onAddDate,
}: {
  item: CalendarItem;
  /** Single-click focus (map view pattern) — outlined in place, never opens. */
  onFocus: () => void;
  /** Double-click — opens the note tab. */
  onOpen: () => void;
  focused?: boolean;
  /** 일정 관리 줄(NoteDatesList)을 박스 **안**에 그린다 — 포커스된 노트의 첫 카드만(2026-09-10). */
  showDates?: boolean;
  /** 거기에 더해 "+ 이 날짜 추가"와 본문 발췌까지 — 포커스된 노트의 **첫** 카드만(D5). */
  expanded?: boolean;
  selectedDay?: string | null;
  excerpt?: string;
  uiLang?: string;
  searchHits?: Set<string> | null;
  folderFilter?: string | null;
  folderById?: Map<string, { color_hue: number | null }>;
  onAddDate?: (noteId: string, day: string) => Promise<void> | void;
}) {
  const meta = itemMeta(item, uiLang);
  const { dim, color, isRelated } = itemVisuals(item, searchHits, folderFilter, folderById);
  const titleText = displayTitle(item.title);

  return (
    // 카드 본체는 여전히 <button> 이고 펼침 영역은 그 **바깥**의 형제다 — 버튼 안에 버튼/입력을
    // 넣으면 DOM 이 무효고 그 안의 클릭이 카드 포커스로 새어나간다. 2026-09-10 오너 결정으로
    // **시각적 박스만 이 wrapper 로 올렸다** — 그래야 알림 편집 줄이 박스 밖에 뜨지 않는다.
    <div
      data-testid={`cal-detail-card-${item.note_id}`}
      className="cal-month-card"
      style={{
        display: "flex",
        // W14 ④ 이후 이 카드는 **월 모드에만** 쓰인다(날짜가 선택되면 가로 스트립의 필이다).
        // 그래서 그립이 없어졌다 — 놓을 축이 있는 화면이 곧 필을 쓰는 화면이고, 축 없는 월
        // 모드에서는 예전에도 그립을 그리지 않았다(핸들러가 아예 안 내려왔다).
        flexDirection: "row",
        alignItems: "stretch",
        borderRadius: "var(--radius-md)",
        opacity: dim ? 0.35 : 1,
        outline: focused ? "2px solid var(--accent)" : "none",
        // 오너 결정 2026-09-10: 링을 박스 **안쪽**으로. 밖으로 나간 링(offset 2 + 2px = 4px)이
        // 우측 스크롤 경계에서 잘려서 — 담는 스크롤러에 우측 패딩이 없다.
        outlineOffset: -2,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <button
          type="button"
          data-testid={`cal-detail-note-${item.note_id}`}
          data-search-dim={dim ? "true" : undefined}
          data-focused={focused ? "true" : undefined}
          onClick={onFocus}
          onDoubleClick={onOpen}
          onKeyDown={(e) => {
            // Native <button> auto-fires "click" (→ focus) on Enter/Space, never "dblclick" — without
            // this, keyboard would lose the only way to open the note (mouse still has double-click).
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen();
            }
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            border: 0,
            padding: "var(--space-4) var(--space-5)",
            background: "transparent",
            cursor: "pointer",
            color: "inherit",
            font: "inherit",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <FolderDot color={color} isRelated={isRelated} />
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--text-md)", fontWeight: 400, minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{titleText}</span>
              {/* 오너 결정 2026-09-10: 아래 행의 벨 버튼(note-date-remind-*)과 겹치므로 목록이
                  보이는 카드에서는 배지를 생략한다 — 벨이 둘이면 어느 쪽이 조작 가능한지 흐려진다. */}
              {!showDates && item.remind && <RemindBadge size={11} noteId={item.note_id} />}
            </div>
          </div>
          {/* CalendarItem has no excerpt/body_md — show the event/period meta as a secondary line.
              This is a formatted date/status string, not note content, so it inherits --font-body
              (see HomeTab.tsx header comment) rather than the --font-editor content excerpts get.
              오너 결정 2026-09-10: 목록이 보이면 이 줄을 아예 그리지 않는다 — 행 요약(날짜)과
              칩(시각·반복·시점)이 같은 것을 더 정확한 정밀도로 이미 말해 둘이 모순돼 보였다.
              같은 날 추가: **날짜가 선택돼 있으면** 헤더가 이미 그 날을 말하므로 항목마다 날짜를
              되뇌는 건 중복이다 → 한 줄 카드. 월 모드에서는 헤더가 "2026년 9월"까지만 말해
              항목별 날짜가 유일한 단서라 이 줄이 남는다. */}
          {!showDates && !selectedDay && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--faint)",
                marginTop: "var(--space-2)",
                lineHeight: 1.6,
              }}
            >
              {meta}
            </div>
          )}
        </button>
        {showDates && (
          <div style={{ paddingBottom: "var(--space-4)" }}>
            <FocusedDetails
              noteId={item.note_id}
              selectedDay={selectedDay ?? null}
              excerpt={excerpt}
              extras={expanded}
              onAddDate={onAddDate}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 항목의 상세 — 일정 행 목록 · "이 날짜 추가" · 본문 발췌(뒤 둘은 `extras`, 포커스일 때만).
 * 2026-09-10 아침엔 알림이 켜진 카드도 포커스 없이 목록을 달았으나 같은 날 번복됐다 —
 * 시각은 시간축이 이미 말한다. 카드에서는 포커스된 첫 카드만 이걸 단다.
 *
 * 카드와 **시간축이 같은 것을 쓴다**. 시각이 있는 항목은 plan.timed 로 갈라져 카드가 아예
 * 없는데(§1 listItems = plan.allDay), 알림이 걸린 노트일수록 시각이 있다 — 카드에만 달면
 * 이 계획의 목표 ⓒ("노트로 안 가고 알림 해제·변경이 끝난다")가 정작 주 대상에서 빠진다.
 */
export function FocusedDetails({
  noteId,
  selectedDay,
  excerpt,
  extras = true,
  onAddDate,
}: {
  noteId: string;
  selectedDay: string | null;
  excerpt?: string;
  /** false 면 행 목록만 — 시간축 아래의 상세처럼 "+ 이 날짜 추가"·발췌 없이 목록만 보여줄 때
   *  쓴다. listRefresh 는 그대로 여기 살아 있어 추가가 목록을 갱신한다. */
  extras?: boolean;
  onAddDate?: (noteId: string, day: string) => Promise<void> | void;
}) {
  const [listRefresh, setListRefresh] = useState(0);

  /** "+ 이 날짜 추가" — 패널이 보고 있는 그 날을 이 노트의 관련 날짜로 얹는다. NoteDatesList 가
   *  안 지나는 경로라 bump 도 여기서 한다(D5). 실패 토스트는 call() 이 이미 띄웠다. */
  const addThisDate = async () => {
    if (!selectedDay) return;
    if (onAddDate) {
      await onAddDate(noteId, selectedDay);
      setListRefresh((n) => n + 1);
      return;
    }
    const [year, month, day] = selectedDay.split("-").map(Number);
    try {
      await call("note_date_add", { note_id: noteId, year, month, day });
      setListRefresh((n) => n + 1);
      bumpNoteQueryVersion();
    } catch {
      // call() already toasted; nothing optimistic was drawn.
    }
  };

  return (
    <div
      data-testid={`cal-detail-expand-${noteId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "0 var(--space-5)",
      }}
    >
      <NoteDatesList noteId={noteId} refreshKey={listRefresh} />
      {extras && selectedDay && (
        <button
          type="button"
          className="chip-btn"
          data-testid={`cal-detail-add-date-${noteId}`}
          onClick={() => void addThisDate()}
          style={{ alignSelf: "flex-start", fontSize: "var(--text-xs)" }}
        >
          {t("note.add_this_date")}
        </button>
      )}
      {extras && excerpt && (
        <div
          data-testid={`cal-detail-excerpt-${noteId}`}
          style={{
            fontFamily: "var(--font-editor)",
            fontSize: "var(--text-xs)",
            color: "var(--faint)",
            whiteSpace: "pre-line",
            lineHeight: 1.5,
          }}
        >
          {excerpt}
        </div>
      )}
    </div>
  );
}

export interface AllDayStripProps {
  /** 렌더링할 일정/노트 항목 목록 */
  items: CalendarItem[];
  /** 시간축 존재 여부 (selectedDay != null 이면 true, 월 모드면 false) */
  hasAxis: boolean;
  /** 현재 선택된 날짜 (YYYY-MM-DD) 또는 월 모드 시 null */
  selectedDay: string | null;
  /** TimeAxis와 통신하기 위한 AxisHandle ref */
  axisHandle?: RefObject<AxisHandle | null>;
  /** 포커스된 노트 ID */
  focusedNoteId?: string | null;
  /** 노트 포커스 핸들러 (단일 클릭) */
  onFocus?: (noteId: string) => void;
  /** 노트 열기 핸들러 (더블클릭 / Enter / Space) */
  onOpen?: (noteId: string) => void;
  /** onOpen의 대체 별칭 */
  onOpenNote?: (noteId: string) => void;
  /** 이 날짜 추가 콜백 (선택) */
  onAddDate?: (noteId: string, day: string) => Promise<void> | void;
  /** 노트 ID별 본문 발췌 매핑 */
  excerpts?: Record<string, string>;
  /** UI 언어 코드 */
  uiLang?: string;
  /** 검색 일치 노트 ID 세트 */
  searchHits?: Set<string> | null;
  /** 폴더 필터 */
  folderFilter?: string | null;
  /** 폴더 메타데이터 매핑 */
  folderById?: Map<string, { color_hue: number | null }>;
  /** 축에 고스트 칩을 표시하고 낙관적 숨김을 반영하기 위한 드롭 미리보기 상태 변경자 */
  setDropPreview?: Dispatch<SetStateAction<DropPreviewState | null>>;
  /** 다일 span 드롭 시 확인 다이얼로그 요청 콜백 */
  onRequestSpanDrop?: (req: {
    key: string;
    noteId: string;
    dateId: string;
    day: string;
    firstDay: string;
    startMin: number;
    title: string;
  }) => void;
  /** onRequestSpanDrop의 대체 별칭 */
  onRequestConfirm?: (req: {
    key: string;
    noteId: string;
    dateId: string;
    day: string;
    firstDay: string;
    startMin: number;
    title: string;
  }) => void;
}

export function AllDayStrip({
  items,
  hasAxis,
  selectedDay,
  axisHandle,
  focusedNoteId,
  onFocus,
  onOpen,
  onOpenNote,
  onAddDate,
  excerpts = {},
  uiLang = "en",
  searchHits = null,
  folderFilter = null,
  folderById,
  setDropPreview,
  onRequestSpanDrop,
  onRequestConfirm,
}: AllDayStripProps) {
  // [1] All React hooks placed unconditionally at the very top before any early return!
  const [openCardKey, setOpenCardKey] = useState<string | null>(null);

  useEffect(() => {
    setOpenCardKey(null);
  }, [selectedDay]);

  const cardMenuRef = useRef<HTMLDivElement>(null);
  const cardSettingsRef = useRef<HTMLButtonElement>(null);

  useDismissOnOutside(openCardKey !== null, [cardMenuRef, cardSettingsRef], () =>
    setOpenCardKey(null),
  );

  const handleOpen = onOpenNote ?? onOpen;
  const triggerConfirm = onRequestSpanDrop ?? onRequestConfirm;

  const commitDrop = async (it: CalendarItem, startMin: number) => {
    if (!selectedDay) return;
    const key = itemKey(it);
    const title = displayTitle(it.title);
    setDropPreview?.({ key, title, startMin, saving: true });
    const row = await fetchDateRow(it.note_id, it.date_id);
    if (!row) {
      setDropPreview?.(null);
      return;
    }
    const firstDay =
      row.month !== null && row.day !== null ? toDateInputValue(row.year, row.month, row.day) : null;
    if (firstDay && !rowIsSameDay(row) && firstDay !== selectedDay) {
      setDropPreview?.({ key, title, startMin, saving: false });
      triggerConfirm?.({
        key,
        noteId: it.note_id,
        dateId: it.date_id,
        day: selectedDay,
        firstDay,
        startMin,
        title,
      });
      return;
    }
    const ok = await commitDateRow(
      it.note_id,
      it.date_id,
      (r) => planAllDayDrop(r, selectedDay, startMin),
      timeChangeLabel(row.start_time, formatHhmm(startMin)),
    );
    if (!ok) setDropPreview?.(null);
  };

  const cardDrag = useAxisDragSession<CalendarItem>({
    onMove: (s) => {
      const apply = () => {
        const startMin = axisHandle?.current?.startMinAt(s.clientX, s.clientY) ?? null;
        const key = itemKey(s.data);
        setDropPreview?.((cur) => {
          if (startMin === null) return null;
          if (cur && cur.key === key && cur.startMin === startMin && !cur.saving) return cur;
          return { key, title: displayTitle(s.data.title), startMin, saving: false };
        });
      };
      axisHandle?.current?.trackDragAt(s.clientY, apply);
      apply();
    },
    onDrop: (s) => {
      axisHandle?.current?.stopAutoScroll();
      const startMin = axisHandle?.current?.startMinAt(s.clientX, s.clientY) ?? null;
      if (startMin === null) {
        setDropPreview?.(null);
        return;
      }
      void commitDrop(s.data, startMin);
    },
    onCancel: () => {
      axisHandle?.current?.stopAutoScroll();
      setDropPreview?.(null);
    },
  });

  // [2] Early return AFTER all hooks have executed
  if (!items || items.length === 0) {
    return null;
  }

  const openCardItem = openCardKey
    ? (items.find((it) => itemKey(it) === openCardKey) ?? null)
    : null;

  return (
    <div
      style={{
        flex: "none",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        minWidth: 0,
      }}
    >
      <style>{`
        .cal-month-card {
          border: 1px solid var(--line);
          background: transparent;
          transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
        }
        .cal-month-card:hover {
          border-color: var(--divider);
          background: var(--hover);
        }
      `}</style>
      {hasAxis && <SectionLabel text={t("home.cal_all_day")} />}
      <div
        data-testid="cal-detail-allday"
        style={
          hasAxis
            ? {
                display: "flex",
                flexDirection: "row",
                flexWrap: "nowrap",
                alignItems: "center",
                gap: "var(--space-2)",
                overflowX: "auto",
                minWidth: 0,
              }
            : { display: "flex", flexDirection: "column", gap: "var(--space-5)" }
        }
      >
        {items.map((it, idx) =>
          hasAxis ? (
            <AllDayPill
              key={itemKey(it)}
              item={it}
              uiLang={uiLang}
              onFocus={() => {
                if (cardDrag.swallowClick()) return;
                onFocus?.(it.note_id);
              }}
              onOpen={() => handleOpen?.(it.note_id)}
              focused={it.note_id === focusedNoteId}
              open={openCardKey === itemKey(it)}
              settingsRef={openCardKey === itemKey(it) ? cardSettingsRef : null}
              onToggleOpen={() =>
                setOpenCardKey((cur) => (cur === itemKey(it) ? null : itemKey(it)))
              }
              dragHandlers={{
                onPointerDown: (ev) => {
                  if (openCardKey === itemKey(it)) return;
                  cardDrag.begin(it, ev);
                },
                ...cardDrag.handlers,
              }}
              searchHits={searchHits}
              folderFilter={folderFilter}
              folderById={folderById}
            />
          ) : (
            <DetailNoteCard
              key={itemKey(it)}
              item={it}
              onFocus={() => onFocus?.(it.note_id)}
              onOpen={() => handleOpen?.(it.note_id)}
              focused={it.note_id === focusedNoteId}
              showDates={
                items.findIndex((x) => x.note_id === it.note_id) === idx &&
                it.note_id === focusedNoteId
              }
              expanded={
                items.findIndex((x) => x.note_id === it.note_id) === idx &&
                it.note_id === focusedNoteId
              }
              selectedDay={selectedDay}
              excerpt={excerpts[it.note_id]}
              uiLang={uiLang}
              searchHits={searchHits}
              folderFilter={folderFilter}
              folderById={folderById}
              onAddDate={onAddDate}
            />
          ),
        )}
      </div>

      {openCardItem && (
        <div
          ref={cardMenuRef}
          className="overlay"
          data-testid={`cal-detail-menu-${openCardItem.note_id}`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => ev.stopPropagation()}
          onKeyDown={(ev) => {
            if (ev.key === "Escape") {
              setOpenCardKey(null);
              return;
            }
            ev.stopPropagation();
          }}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 3,
            marginTop: "var(--space-1)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            boxShadow: "var(--shadow-md)",
            padding: "var(--space-2)",
          }}
        >
          <FocusedDetails
            noteId={openCardItem.note_id}
            selectedDay={selectedDay}
            excerpt={excerpts[openCardItem.note_id]}
            onAddDate={onAddDate}
          />
        </div>
      )}
    </div>
  );
}
