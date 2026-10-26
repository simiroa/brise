import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteDate } from "../../lib/commands.gen";
import { call, emitNotice } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { IconBell, IconStar, IconCaret, IconTrash, IconClose } from "../icons";
import { Select, type SelectOption } from "../Select";
import { formatDateBadgeLabel, guardTimeTyping, parseTimeInput } from "../titlebar/eventDate";
import { bumpNoteQueryVersion } from "../../lib/noteQuery";
import { weekdayShortLabels } from "../home/dateFmt";
import {
  OFFSET_PRESETS,
  WEEKDAY_CODES,
  REPEAT_OPTIONS,
  parseRruleForUi,
  buildRrule,
  offsetKeyFromMinutes,
  offsetMinutesFromKey,
  type RepeatFreq,
  type RepeatDraft,
} from "../titlebar/scheduleRrule";
import type { RowSchedulePatch } from "../titlebar/useReminderDraft";

/** PLAN-2026-09-08-dates-rebuild.md W4 §1.1: every note_dates row (position 0 or not) carries the
 *  same columns — the primary/related capability split is gone. PLAN-2026-09-10 D2 finished the
 *  job: 이제 **모든 행이 진짜 `note_dates` 행**이고, 대표는 `position === 0` 이라는 사실일 뿐이다.
 *  옛 `id: "primary"` 센티널 + props 로 받던 `notes.*` 미러는 사라졌다 — 같은 값에 이르는 우회로가
 *  두 벌이었고, 마운트 지점이 셋이 되면서(노트 탭 칩 · 생성 팝오버 · 달력 카드) 유지될 수 없었다. */
export interface UnifiedRow {
  id: string;
  isPrimary: boolean;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  start_time: string | null;
  end_time: string | null;
  remind: boolean;
  remind_offset_min: number | null;
  rrule: string | null;
  /** PLAN-2026-09-18-nl-dates.md D1(V85) — 관련 날짜를 구분하는 이름. 대표(position 0)는 항상
   *  null(D2, 서버가 강제) — `date_update` 가 position=0 이면 무엇이 오든 NULL 로 덮어쓴다. */
  label: string | null;
}

/** `dates`(서버 응답) → `UnifiedRow`. `allRows` 계산과, 승격/삭제 뒤 `onSelect` 로 되돌려줄 행을
 *  다시 만드는 두 곳이 같은 모양을 쓴다(PLAN-2026-09-19-date-region-ui.md §P1 D1 후속 — 아래
 *  deleteRow/removeDate 의 "선택이 지워진 행을 잃지 않게" 재선택 참고). */
function toUnifiedRow(d: NoteDate): UnifiedRow {
  return {
    id: d.id,
    isPrimary: d.position === 0,
    year: d.year,
    month: d.month,
    day: d.day,
    end_year: d.end_year,
    end_month: d.end_month,
    end_day: d.end_day,
    start_time: d.start_time,
    end_time: d.end_time,
    remind: d.remind,
    remind_offset_min: d.remind_offset_min,
    rrule: d.rrule,
    label: d.label,
  };
}

/** 대표든 관련이든 한 함수 — eventDate.ts 가 이미 닫힌 칩/행 공용으로 정한 표기다(그 파일의
 *  formatDateBadgeLabel 주석). 대표만 DateBadge 가 미리 포맷해 내려주던 `primarySummary` 는
 *  사라졌다(D2).
 *
 *  D1(V85) 후속: 라벨이 있으면 날짜 대신 라벨을 보여준다("표시는 label ?? 노트 제목" — 이 목록
 *  자체는 노트 제목이 아니라 날짜 포맷이 옛 폴백이므로 그 자리를 그대로 잇는다). eventDate.ts 의
 *  `formatNoteDateRow` 는 손대지 않았다 — 그 함수는 "YYYY-MM-DD" 문자열 두 개를 받는 모양이라
 *  부분 정밀도(연도만/연·월) 행을 못 살리고, 실제 이 목록이 쓰는 것도 이미 `formatDateBadgeLabel`
 *  직접 호출이라(그쪽이 부분 정밀도까지 다룬다) 여기 호출부에서 조합하는 편이 더 간단하다 —
 *  PLAN §W0-Frontend 가 명시적으로 허용한 재량("시그니처를 넓히기보다 호출부에서 조합"). 대표는
 *  label 이 항상 null(D2)이라 이 분기를 안 타고 그대로 날짜로 떨어진다. */
function rowSummary(r: UnifiedRow): string {
  if (r.label) return r.label;
  return formatDateBadgeLabel(r.year, r.month, r.day, {
    end_year: r.end_year,
    end_month: r.end_month,
    end_day: r.end_day,
  });
}

/** 행 본문(펼쳤을 때)의 필드 줄과 그 위 칩 줄이 **같은 스케일**을 쓴다(2026-09-08 오너: "여백이랑
 *  크기 조절"). `.field` 는 `--ctrl-h-lg`(35px) + `--text-md` 라 이 목록의 다른 컨트롤(26px +
 *  --text-xs)보다 덩치가 커서, 그 토큰으로 맞춘다 — 생 px 없이. */
const chipScaleField: CSSProperties = {
  minHeight: "var(--ctrl-h-sm)",
  height: "var(--ctrl-h-sm)",
  padding: "0 var(--space-2)",
  fontSize: "var(--text-xs)",
};

/** 시각 입력 글자수 상한 — "오후 12시 30분"(10자)·"pm 오후 3시30분"(12자)이 들어갈 만큼. */
const TIME_INPUT_MAX_LEN = 14;
const TIME_ERR_ID = "reminder-time-error";

const timeFieldStyle: CSSProperties = {
  ...chipScaleField,
  // 텍스트 입력이라 네이티브 type=time 의 최소폭(로케일+시계 아이콘 때문에 ~110px)이 없다 —
  // "HH:MM" 5자면 충분하다. 단 `.field` 는 box-sizing: border-box 라 width 가 좌우 패딩을
  // **포함**한다 — 예전의 맨 `5ch` 는 내용 폭이 5ch 에서 패딩만큼 모자라 "00:0" 으로 잘렸다
  // (§P4 D13, 오너 실앱 스크린샷). 패딩 두 번 + 캐럿 여유를 더한다.
  flex: "none",
  // 14자까지 받는다("오후 3시30분" 등) — 7ch 로 "HH:MM" 이 넉넉히 보이고 긴 입력도 어느 정도 읽힌다.
  width: "calc(7ch + var(--space-2) * 2 + 4px)",
  textAlign: "center",
  color: "var(--accent)",
  fontVariantNumeric: "tabular-nums",
};

/** 헤더의 행 액션(대표로/삭제)과 본문의 초기화(×) — 벨·셰브런과 같은 22px 아이콘 버튼 한 벌.
 *  §P4 D13: 글자 버튼이 아니라 아이콘이다(오너: "텍스트없이 아이콘만"). */
const rowIconBtn: CSSProperties = { width: 22, height: 22, flex: "none" };

/** 이 목록의 `Select` 두 개(반복·알림 시점)가 쓰는 폭. `Select` 트리거의 기본 인라인 폭은 설정
 *  화면용 `var(--settings-ctrl-w, 220px)` 이라 296px 팝오버에서는 줄 밖으로 넘쳤다(§P4 D13).
 *  `style` prop 이 마지막에 펼쳐져 기본값을 이긴다 — 설정 화면이 기대는 기본값은 건드리지 않는다. */
const compactSelectStyle: CSSProperties = { width: "auto", minWidth: 0 };

/** 목록 스크롤 문턱(오너 2026-09-19: "대부분 날짜를 10개 미만으로 운영하니, 그 이상일 때만 …
 *  넉넉하게 여유를 주자"). 10행까지는 **전부 한 번에** 보인다 — 높이 제한도 스크롤도 없다. 넘을
 *  때만 목록이 자기 안에서 스크롤하고, 그 높이는 접힌 행 10개 + 펼친 본문 하나(알림 시점 줄까지)가
 *  들어가는 만큼이다. 팝오버 전체가 아니라 **목록만** 스크롤해야 위의 달력과 아래의 "+ 등록"이
 *  늘 제자리에 남는다. NoteRegionsList.tsx 가 같은 문턱을 쓴다(값은 행 높이가 달라 다르다). */
const SCROLL_AFTER_ROWS = 10;
const LIST_SCROLL_MAX_H = 420;

/** 펼친 행 본문의 좌측 들여쓰기 — 헤더의 별 아이콘(12px) + 그 gap(6px)과 시각적으로 한 기둥으로
 *  읽히게(PLAN-2026-09-19-date-region-ui.md §P1 목표 인터랙션 mockup의 들여쓰기 그대로). */
const rowBodyIndent = 18;

export type NoteDatesListProps = {
  noteId: string;
  /** Bump to force a re-fetch (e.g. after external mutation). */
  refreshKey?: number;
  onChanged?: () => void;
  /** Fires with the freshly (re)loaded rows every time this component fetches them — lets DateBadge
   * mirror the list (closed-chip count/bell, calendar dot marks) without a duplicate fetch of its
   * own. 대표(position 0)도 들어 있다 — 관련 날짜만 필요한 호출자가 걸러 쓴다. */
  onDatesChange?: (dates: NoteDate[]) => void;
  /** 대표 행을 지운 **직후**(관련 행이 하나도 없어 정밀도만 리셋하는 경우) 호출자가 자기 로컬
   * 초안(DateBadge 의 달력 draft)을 되돌리는 훅. 실제 지우기는 이 컴포넌트가 다른 행과 똑같이
   * note_date_update 로 한다 — 대표라고 별도 경로를 두지 않는다(D2). */
  onClearPrimary?: () => void;
  /** 달력이 어느 행을 보여주고 드래그가 어느 행을 고치는지 — 진짜 `note_dates.id`
   * (DateBadge owns the calendar, this list only owns selection *state's mirror*). */
  selectedId?: string | null;
  /** 고른 **행 자체**를 넘긴다. id 만 넘기면 호출자가 자기 사본에서 다시 찾아야 하는데, 그
   *  사본은 이 목록이 먼저 그려진 뒤에 채워져 그 사이 클릭이 조용히 무시된다(실제 결함이었다). */
  onSelect?: (row: UnifiedRow) => void;
  /** PLAN-2026-09-19-date-region-ui.md §P1 — "+" 가 방금 만든 행의 id. 바뀌면(= 새로 채워지면)
   *  그 행을 펼친 채로 시작한다(DatesPanel.tsx 의 handleAddRow 성공 직후). 같은 값이 다시 오면
   *  아무 일도 하지 않는다 — 사용자가 그 행을 직접 접었는데 부모가 재렌더될 때마다 도로 펼치면
   *  안 되므로, effect 의존성이 값 자체의 "변화"에만 반응한다. */
  justAddedId?: string | null;
};

/**
 * PLAN-2026-09-08-dates-rebuild.md §A/§F (2026-09-08 owner decision) — the unified date+reminder
 * list. Row = date (year..end triple) + reminder (remind/time/offset/rrule), same columns whether
 * it's the primary (★, always first) or a related date. Selecting a row is what tells DateBadge's
 * calendar which row a drag edits.
 *
 * PLAN-2026-09-19-date-region-ui.md §P1 — the chip-line-per-field drawer (§A's design) is gone.
 * Now it's a plain accordion: clicking a row selects it (unchanged `onSelect` contract) AND
 * expands it (list-wide single-open, `openRowId` — the field-level `open: {id, field}` state this
 * replaced). Expanding a row shows every editable field (name/time/repeat/notify-offset) at once,
 * not one at a time behind its own chip — only the notify-offset field stays gated on `remind`
 * (D2: time/repeat are the event's own properties, not reminder properties). A single [삭제]
 * action per row replaces the old header's hover-revealed icon cluster (star/edit/remove) — see
 * `deleteRow` for how its handler branches by row kind (D1).
 *
 * PLAN-2026-09-10-calendar-reminders.md D2 — **노트 id 하나로 자족한다.** 대표 행도 그냥 목록의
 * position 0 행이라 같은 `commitRelated` 를 지난다(옛 setRemind/setSchedule props + `canEditPrimary`
 * 게이트는 삭제 — 행 id 로 지목하므로 "다른 노트의 대표를 흘리는" 경로가 구조적으로 없다).
 */
export function NoteDatesList({
  noteId,
  refreshKey = 0,
  onChanged,
  onDatesChange,
  onClearPrimary,
  selectedId,
  onSelect,
  justAddedId,
}: NoteDatesListProps) {
  const [dates, setDates] = useState<NoteDate[]>([]);
  const datesRef = useRef<NoteDate[]>(dates);
  datesRef.current = dates;
  const [busy, setBusy] = useState(false);
  // 어느 행이 펼쳐져 있는지 — list-wide (필드 단위가 아니라 행 단위) 단일 오픈. 다른 행을 클릭하면
  // 이전 펼침은 접힌다(§P1 "다른 행을 클릭하면 이전 펼침은 접힌다").
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uiLang = useSettingsStore((s) => s.uiLang);

  /** 변경 뒤 두 축을 맞춘다(D2). 이 노트가 열려 있으면 `notes.*` 투영을 스토어에 다시 싣고
   *  (`makePrimary` 가 이미 하던 것 그대로), 달력·확장 뷰가 구독하는 note_query 축을 무효화한다
   *  (CalendarTab.tsx:108). 노트 탭에서 알림을 바꾸면 달력이 따라오는 것이 이 두 줄이다. */
  const syncStores = async () => {
    if (useNotesStore.getState().activeNote?.note.id === noteId) {
      await useNotesStore.getState().reloadActive();
    }
    bumpNoteQueryVersion();
  };

  const reload = useCallback(async () => {
    try {
      const res = await call<{ dates: NoteDate[] }>("note_dates_list", { note_id: noteId });
      setDates(res?.dates ?? []);
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    }
  }, [noteId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await call<{ dates: NoteDate[] }>("note_dates_list", { note_id: noteId });
        if (!cancelled) setDates(res?.dates ?? []);
      } catch {
        if (!cancelled) setDates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, refreshKey]);

  useEffect(() => {
    onDatesChange?.(dates);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDatesChange is usually a fresh
    // inline closure per render; keying off `dates` only avoids re-firing every render for no reason.
  }, [dates]);

  // 노트가 바뀌면 이전 노트의 펼침 상태를 들고 있을 이유가 없다(다른 노트에 같은 id 가 없으므로
  // 실질적 위험은 아니지만, 새 목록이 도착하기 전 잠깐 엉뚱한 행이 "펼쳐진 것처럼" 보이는 프레임을
  // 막는다).
  useEffect(() => {
    setOpenRowId(null);
  }, [noteId]);

  // §P1 — "+" 가 새 행을 만들면 그 행을 펼친 채로 시작한다. 같은 id 가 다시 와도(부모 재렌더)
  // 재실행하지 않는다 — 사용자가 그 사이 직접 접었을 수 있다.
  useEffect(() => {
    if (justAddedId) setOpenRowId(justAddedId);
  }, [justAddedId]);

  // 스크롤 모드(SCROLL_AFTER_ROWS 초과)에서 아래쪽 행을 펼치면 본문이 목록 창 밖에 생긴다 —
  // 펼친 행 전체가 보이도록 **이 컨테이너의 scrollTop 만** 민다. `scrollIntoView` 는 쓰지 않는다:
  // 조상까지 스크롤을 시도해, 이 팝오버처럼 position:fixed 로 창 밖에 걸친 요소에서는 앱 셸을
  // 통째로 밀어 올릴 수 있다. 스크롤 모드가 아니면 넘침이 없어 아래 계산이 0 이라 아무 일도 없다.
  useEffect(() => {
    const c = listRef.current;
    if (!c || !openRowId) return;
    const el = Array.from(c.children).find((n) => (n as HTMLElement).dataset.rowId === openRowId) as
      | HTMLElement
      | undefined;
    if (!el) return;
    const cr = c.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.bottom > cr.bottom) c.scrollTop += er.bottom - cr.bottom;
    else if (er.top < cr.top) c.scrollTop -= cr.top - er.top;
  }, [openRowId]);

  const afterMutation = async () => {
    await reload();
    onChanged?.();
    await syncStores();
  };

  /** 관련 행 제거(§P1 D1 — 대표 행은 이 길을 타지 않는다, `deleteRow` 참고). */
  const removeDate = async (id: string) => {
    const wasSelected = onSelect ? selectedId === id : false;
    setBusy(true);
    try {
      await call("note_date_remove", { id });
      if (openRowId === id) setOpenRowId(null);
      await afterMutation();
      // 선택돼 있던 관련 행이 지워지면 호출자(DatesPanel)의 selectedId 가 더 이상 존재하지 않는
      // 행을 가리키게 된다 — 그대로 두면 다음 달력 드래그가 유령 id 로 note_date_update 를 쏴
      // 조용히 실패한다. 대표로 되돌린다(초기 로드가 "아직 아무 것도 안 골랐으면 대표" 하는 것과
      // 같은 기본값 — onDatesChange 의 그 규칙을 여기서도 반복한다).
      if (wasSelected) {
        const primary = dates.find((d) => d.position === 0);
        if (primary) onSelect?.(toUnifiedRow(primary));
      }
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (d: NoteDate) => {
    setBusy(true);
    try {
      await call("note_date_make_primary", { id: d.id });
      // reloadActive()/bump 은 afterMutation 의 syncStores 가 한다 — 승격도 다른 변경과 같은 길.
      await afterMutation();
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  /** §F immediate-commit for **any** row, 대표 포함(D2) — optimistic update of local `dates`, then
   *  note_date_update's full-row-replace payload (notes.yaml: every field, every time, id
   *  excluded), rolled back to the pre-edit row on failure (docs/CLAUDE.md §9). 대표 행 편집도
   *  이 한 길이라 `project_primary` 를 반드시 지난다 — `notes.*` 를 직접 쓰는 곳은 없다.
   *
   *  patch 타입은 `RowScheduleTarget`(일정 필드만)이 아니라 `NoteDate`(label 포함) 전체다 —
   *  D1(V85) 이름 편집기도 이 한 길을 쓴다. 대표 행에 label 패치가 와도 서버가 무시하고 항상
   *  NULL 로 덮어쓰므로(D2, repo::notes::dates::date_update) 여기서 따로 막을 필요가 없다. */
  const commitRelated = async (id: string, patch: Partial<NoteDate>) => {
    // 빠른 연속 수정: 클로저의 `dates` 는 직전 낙관적 갱신 이전일 수 있어 ref 의 최신본에 합친다.
    const latest = datesRef.current;
    const idx = latest.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const prevDates = latest;
    const merged: NoteDate = { ...latest[idx], ...patch };
    const optimistic = latest.map((d) => (d.id === id ? merged : d));
    datesRef.current = optimistic;
    setDates(optimistic);
    setBusy(true);
    try {
      const res = await call<NoteDate>("note_date_update", {
        id: merged.id,
        year: merged.year,
        month: merged.month,
        day: merged.day,
        end_year: merged.end_year,
        end_month: merged.end_month,
        end_day: merged.end_day,
        remind: merged.remind,
        start_time: merged.start_time,
        end_time: merged.end_time,
        remind_offset_min: merged.remind_offset_min,
        rrule: merged.rrule,
        label: merged.label,
      });
      setDates((ds) => ds.map((d) => (d.id === id ? res : d)));
      onChanged?.();
      await syncStores();
    } catch (e) {
      setDates(prevDates);
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  /** §P1 D1 — 모든 행의 단일 [삭제] 액션. 핸들러는 행 종류/상태로 갈린다:
   *   - 관련 행: 기존 `removeDate` 그대로.
   *   - 대표 행 + 관련 행 있음: `date_make_primary(다음 관련 행)` → `date_remove(옛 대표)` 순서
   *     호출(서버가 position 0 삭제를 거부하므로 이 순서가 필수 — dates.rs:336). 실패하면(두
   *     번째 호출만 실패해도) 어중간한 로컬 상태를 남기지 않고 `afterMutation()`으로 실제 서버
   *     상태를 다시 읽는다.
   *   - 대표 행 + 관련 행 없음: 기존 지우개(정밀도+시각+반복 리셋, c1b9503c 에서 고정된 payload
   *     모양 그대로) — 그 행 자체는 지울 수 없다(서버가 마지막 position 0 삭제를 거부).
   */
  const deleteRow = async (r: UnifiedRow) => {
    if (!r.isPrimary) {
      await removeDate(r.id);
      return;
    }
    const others = dates.filter((d) => d.position !== 0).sort((a, b) => a.position - b.position);
    if (others.length === 0) {
      onClearPrimary?.();
      await commitRelated(r.id, {
        month: null,
        day: null,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: null,
        end_time: null,
        rrule: null,
      });
      return;
    }
    const next = others[0];
    const wasSelected = onSelect ? selectedId === r.id : false;
    setBusy(true);
    try {
      await call("note_date_make_primary", { id: next.id });
      await call("note_date_remove", { id: r.id });
      if (openRowId === r.id) setOpenRowId(null);
      await afterMutation();
      // 지워진 옛 대표가 선택돼 있었다면 승격된 행으로 선택을 옮긴다 — make_primary 는 순수
      // position 교환이라(두 행 모두 데이터 보존, dates.rs:641) `next` 의 연/월/일 등은 이미
      // 승격 후 최종값과 같다. 옮기지 않으면 호출자의 selectedId 가 방금 지운 id 를 계속 가리켜
      // removeDate 와 같은 유령-id 버그가 난다.
      //
      // label 은 예외 — `next`는 승격 *전* 로컬 스냅샷이라 원래 갖고 있던 label 을 그대로 들고
      // 있지만, 서버는 승격 시 그 label 을 NULL 로 비운다(D2, dates.rs::date_make_primary 2026-09-19
      // 수정). 지금은 onSelect 의 유일한 소비자(DatesPanel.seedFromRow)가 label 을 읽지 않아
      // 눈에 보이는 결함은 없지만, 서버 진실과 다른 값을 넘기는 것 자체가 다음 소비자를 위한
      // 함정이라 여기서 명시적으로 null 을 실어 보낸다.
      if (wasSelected) {
        onSelect?.(toUnifiedRow({ ...next, position: 0, label: null }));
      }
    } catch (e) {
      // "어중간한 로컬 상태를 만들지 않는다" — 두 호출 중 하나만 성공했어도 실제 서버 상태로
      // 되돌린다(낙관적 로컬 수정은 이 시퀀스에서 아예 하지 않았으므로 되돌릴 것은 목록 자체뿐).
      await afterMutation();
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const allRows: UnifiedRow[] = dates.map(toUnifiedRow);
  const scrolls = allRows.length > SCROLL_AFTER_ROWS;

  return (
    <div
      ref={listRef}
      data-testid="note-dates-list"
      data-scrolls={scrolls}
      className={scrolls ? "scroll" : undefined}
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2xs)",
        opacity: busy ? 0.7 : 1,
        fontSize: "var(--text-sm)",
        ...(scrolls ? { maxHeight: LIST_SCROLL_MAX_H, overflowY: "auto" as const } : null),
      }}
    >
      {allRows.map((r) => {
        const isSelected = onSelect ? selectedId === r.id : false;
        const isOpen = openRowId === r.id;
        const headerId = `note-date-header-${r.isPrimary ? "primary" : r.id}`;
        const bodyId = `note-date-body-${r.isPrimary ? "primary" : r.id}`;
        const toggle = () => {
          onSelect?.(r);
          setOpenRowId((cur) => (cur === r.id ? null : r.id));
        };
        return (
          <div key={r.id} data-row-id={r.id} style={{ display: "flex", flexDirection: "column", flex: "none" }}>
            <div
              id={headerId}
              data-testid={r.isPrimary ? "note-date-primary" : `note-date-row-${r.id}`}
              role={onSelect ? "option" : undefined}
              aria-selected={onSelect ? isSelected : undefined}
              data-selected={onSelect ? isSelected : undefined}
              aria-expanded={isOpen}
              data-expanded={isOpen}
              aria-controls={isOpen ? bodyId : undefined}
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                // 2026-09-08 오너: "날짜 칸에 텍스트 배경색이 안 들어가도 된다". 채운 박스는 바로
                // 위 달력의 날짜 하이라이트와 폭·여백이 어긋나 보였다 — 선택은 글자색으로만 말한다.
                color: isSelected ? "var(--accent)" : "var(--text)",
                padding: "var(--space-2xs) 0",
                cursor: "pointer",
              }}
            >
              {r.isPrimary ? (
                <IconStar
                  data-testid="note-date-primary-mark"
                  role="img"
                  aria-label={t("note.primary_date_label")}
                  size={12}
                  strokeWidth={2}
                  style={{ flex: "none", color: "var(--accent)", fill: "var(--accent)" }}
                />
              ) : (
                <span style={{ width: 12, flex: "none" }} />
              )}
              <span
                // check:type-scale only accepts a literal 400/600/inherit after `fontWeight:` —
                // conditionally omitting the property (falls back to inherit/400) instead of a
                // ternary matches NoteRegionsList's own primary-row idiom.
                style={
                  r.isPrimary
                    ? {
                        flex: 1,
                        minWidth: 0,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "var(--text-sm)",
                      }
                    : {
                        flex: 1,
                        minWidth: 0,
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "var(--text-xs)",
                      }
                }
              >
                {rowSummary(r)}
              </span>
              {/* §P4 D13 — 행 액션은 본문 하단의 글자 버튼 줄이 아니라 여기, 벨 옆의 아이콘이다.
                  **펼쳐진 행에서만** 그린다: 접힌 행마다 별·휴지통·벨·셰브런이 늘어서면 목록이 버튼
                  밭이 되고, 접힌 행의 휴지통은 오클릭 한 번이 곧 삭제다. 대표 행에는 "대표로"가 없다
                  (이미 대표 — 왼쪽의 채운 별이 그 표시다). */}
              {isOpen && !r.isPrimary && (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  data-testid={`note-date-make-primary-${r.id}`}
                  title={t("note.make_primary_date")}
                  aria-label={t("note.make_primary_date")}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void makePrimary(dates.find((d) => d.id === r.id)!);
                  }}
                  style={{ ...rowIconBtn, color: "var(--muted)" }}
                >
                  <IconStar size={11} strokeWidth={2} />
                </button>
              )}
              {isOpen && (
                // 대표 삭제는 클릭 시점의 상황(관련 행 유무)에 따라 지우개로도, 승격+삭제로도 갈린다
                // (deleteRow 가 갈라 처리) — 버튼 자체는 testid/aria-label 을 고정해 어느 쪽이든 같은
                // 자리에서 같은 뜻("이 행을 없앤다")으로 보이게 한다(DateBadge.test.tsx 의 회귀 고정).
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  data-testid={r.isPrimary ? "note-date-clear-primary" : `note-date-remove-${r.id}`}
                  title={r.isPrimary ? t("editor.year_clear_date") : t("note.remove_related_date")}
                  aria-label={r.isPrimary ? t("editor.year_clear_date") : t("note.remove_related_date")}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteRow(r);
                  }}
                  style={{ ...rowIconBtn, color: "var(--danger)" }}
                >
                  <IconTrash size={11} strokeWidth={2} />
                </button>
              )}
              {/* 벨은 상태라 호버해야 보이면 안 된다 — 언제나 보이고, 누르면 즉시 커밋된다(§F).
                  옛 드로어와 달리 더 이상 "옵션 줄을 드러내는 방아쇠"가 아니다(§P1 D2) — 시각/반복은
                  벨과 무관하게 행을 펼치면 보인다. */}
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                data-testid={`note-date-remind-${r.isPrimary ? "primary" : r.id}`}
                data-active={r.remind}
                aria-pressed={r.remind}
                aria-label={t("note.related_date_remind")}
                title={t("note.related_date_remind")}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void commitRelated(r.id, { remind: !r.remind });
                }}
                style={{
                  color: r.remind ? "var(--accent)" : "var(--muted)",
                  width: 22,
                  height: 22,
                  flex: "none",
                }}
              >
                <IconBell size={11} strokeWidth={2} style={{ fill: r.remind ? "var(--accent)" : "none" }} />
              </button>
              <IconCaret dir={isOpen ? "up" : "down"} size={12} style={{ flex: "none", color: "var(--muted)" }} />
            </div>
            {isOpen && (
              <RowBody
                id={bodyId}
                labelledBy={headerId}
                row={r}
                uiLang={uiLang}
                onNamePatch={(label) => void commitRelated(r.id, { label })}
                onSchedulePatch={(patch) => void commitRelated(r.id, patch)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 필드 한 줄 — 좌측에 짧은 라벨("시각"/"반복"/"알림 시점"/"이름"), 우측에 컨트롤. §P1 mockup의
 *  "시각  00:00 – 00:00" 줄 모양을 그대로 코드로 옮긴 것뿐이라 별도 스타일 문서화는 없다. */
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minHeight: "var(--ctrl-h-sm)" }}>
      <span
        style={{
          width: 52,
          flex: "none",
          color: "var(--muted)",
          fontSize: "var(--text-xs)",
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        {children}
      </div>
    </div>
  );
}

/** 펼친 행의 본문 — §P1의 핵심 재구성: 옛 `ReminderChips`(칩 3개 + 필드별 open) 대신 이름/시각/
 *  반복/알림 시점을 **한 번에** 보여준다. 알림 시점만 `row.remind` 에 종속되고(D2), 나머지는 행이
 *  열려 있기만 하면 항상 보인다. 로직(파싱/조립/커밋)은 옛 서브컴포넌트들에서 그대로 가져왔다 —
 *  바뀐 것은 "언제 마운트되는가"뿐이다.
 *
 *  §P4 D13 — 본문은 **필드만** 갖는다. 행 액션(대표로/삭제)은 헤더의 아이콘으로 올라갔다. */
function RowBody({
  id,
  labelledBy,
  row,
  uiLang,
  onNamePatch,
  onSchedulePatch,
}: {
  id: string;
  labelledBy: string;
  row: UnifiedRow;
  uiLang: string;
  onNamePatch: (label: string | null) => void;
  onSchedulePatch: (patch: Partial<RowSchedulePatch>) => void;
}) {
  const hasFullPrecision = row.month != null && row.day != null;

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      data-testid={`note-date-body-${row.isPrimary ? "primary" : row.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        padding: `0 0 var(--space-2) ${rowBodyIndent}px`,
      }}
    >
      <FieldRow label={t("note.name_field_label")}>
        {row.isPrimary ? (
          <span style={{ color: "var(--faint)", fontSize: "var(--text-xs)" }}>—</span>
        ) : (
          <NameField row={row} onPatch={onNamePatch} />
        )}
      </FieldRow>

      {hasFullPrecision && (
        <FieldRow label={t("editor.time_range_label")}>
          <TimeFields row={row} onPatch={onSchedulePatch} />
        </FieldRow>
      )}

      {/* 반복/알림시점은 정밀도와 무관하게 남는다(옛 §A 부터의 규칙 — 저장 시 서버 불변식 I4가
          최종 검증한다). */}
      <FieldRow label={t("editor.repeat")}>
        <RepeatFields row={row} uiLang={uiLang} onPatch={onSchedulePatch} />
      </FieldRow>

      {row.remind && (
        <FieldRow label={t("editor.remind_offset")}>
          <Select
            value={offsetKeyFromMinutes(row.remind_offset_min)}
            onChange={(v) =>
              onSchedulePatch({
                start_time: row.start_time,
                end_time: row.end_time,
                remind_offset_min: offsetMinutesFromKey(v),
                rrule: row.rrule,
              })
            }
            options={OFFSET_PRESETS.map((p) => ({ value: p.key, label: t(`editor.remind_offset_${p.key}`) }))}
            ariaLabel={t("editor.remind_offset")}
            testid="reminder-offset-select"
            className="chip-btn"
            style={compactSelectStyle}
          />
        </FieldRow>
      )}

    </div>
  );
}

/** 필드 옆 초기화(×) — §P4 D13(오너: "이름 시각 옆에는 초기화가 있어야 함"). 값이 없을 땐 자리를
 *  지키되 숨긴다(`visibility`) — 줄 폭이 값 유무로 흔들리지 않게.
 *
 *  `onMouseDown` 의 preventDefault 가 핵심이다: 없으면 × 를 누르는 순간 입력이 먼저 blur 돼
 *  **지금 글자로 커밋**이 한 번 나가고, 곧바로 클릭이 null 커밋을 또 쏜다 — 같은 행에
 *  note_date_update 가 두 번 겹친다. 포커스를 입력에 남겨 blur 커밋 자체가 안 일어나게 한다. */
function ClearButton({
  visible,
  label,
  testid,
  onClear,
}: {
  visible: boolean;
  label: string;
  testid: string;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      data-testid={testid}
      title={label}
      aria-label={label}
      aria-hidden={!visible || undefined}
      tabIndex={visible ? 0 : -1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClear}
      style={{ ...rowIconBtn, color: "var(--muted)", visibility: visible ? "visible" : "hidden" }}
    >
      <IconClose size={11} strokeWidth={2.4} />
    </button>
  );
}

/** D1(V85) 이름 인라인 편집기 — 한 줄 텍스트, blur/Enter 커밋. 빈 입력 = 이름 해제(null) — 오타
 *  걱정이 없는 자유 텍스트라 "파싱 실패" 갈래가 없다(시각 입력과 다른 점). `key={row.id}`(호출부
 *  없이 이 컴포넌트 자체가 `row.id` 로 리마운트되도록, 부모 map 의 `key`가 이미 그 역할을 한다)로
 *  행이 바뀌면 로컬 텍스트도 다시 씨앗을 받는다 — 이 함수는 항상 특정 행 하나만을 위해 마운트된다
 *  (한 번에 하나만 열리므로). */
function NameField({ row, onPatch }: { row: UnifiedRow; onPatch: (label: string | null) => void }) {
  const [text, setText] = useState(row.label ?? "");

  const commit = () => {
    const trimmed = text.trim();
    setText(trimmed);
    onPatch(trimmed === "" ? null : trimmed);
  };

  return (
    <>
      <input
        type="text"
        className="field field--seamless"
        placeholder={t("note.related_date_label_placeholder")}
        aria-label={t("note.related_date_label_placeholder")}
        data-testid={`note-date-label-input-${row.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        style={{ ...chipScaleField, flex: 1, minWidth: 0 }}
      />
      <ClearButton
        visible={text !== ""}
        label={t("note.clear_date_name")}
        testid={`note-date-label-clear-${row.id}`}
        onClear={() => {
          setText("");
          onPatch(null);
        }}
      />
    </>
  );
}

/** 텍스트 시각 입력 — 네이티브 `<input type="time">` 대신(2026-09-10 오너 승인 제안 2). 칩은
 *  24시제("00:03")인데 네이티브 피커는 로케일 표기(ko: "오전 12:03") + 시계 아이콘(OS 피커)이라
 *  같은 값이 두 표기로 보이고, 이 팝오버엔 이미 앱 달력이 떠 있어 OS 시계까지 뜨면 창이 두 개가
 *  된다 — RepeatFields 의 UNTIL 입력이 같은 이유로 없는 것과 같다.
 *
 *  판정은 blur/Enter 때만(입력 중엔 방해하지 않는다). 파싱 실패·종료<시작(같은 날)·"시작 없는 종료"
 *  는 **조용히 되돌리지 않고** aria-invalid + 안내를 띄운 채 입력을 남긴다(고칠 수 있게). 서버가
 *  거절하면 commitRelated 가 행을 롤백하고, 아래 effect 가 그 row 값으로 입력을 맞춘다.
 *  정규화한 값이 row 와 같으면 전송하지 않고, Escape 는 row 값으로 되돌린다.
 *  patch 는 바뀐 필드(start/end)만 보낸다 — commitRelated 가 최신 행에 합친다. */
type TimeErr = "invalid" | "order" | "needs_start";

function TimeFields({ row, onPatch }: { row: UnifiedRow; onPatch: (patch: Partial<RowSchedulePatch>) => void }) {
  const [startText, setStartText] = useState(row.start_time ?? "");
  const [endText, setEndText] = useState(row.end_time ?? "");
  const [startErr, setStartErr] = useState<TimeErr | null>(null);
  const [endErr, setEndErr] = useState<TimeErr | null>(null);
  // 사용자가 타이핑 중인(아직 판정 전이거나 거부된) 필드는 row 변경이 덮어쓰지 않는다.
  const dirty = useRef({ start: false, end: false });

  // row 값(달력 이동·대표 교체·서버 거절 롤백)이 바뀌면 입력을 맞춘다 — useState 초기값만으론 안 따라온다.
  useEffect(() => {
    if (!dirty.current.start) {
      setStartText(row.start_time ?? "");
      setStartErr(null);
    }
  }, [row.start_time, row.id]);
  useEffect(() => {
    if (!dirty.current.end) {
      setEndText(row.end_time ?? "");
      setEndErr(null);
    }
  }, [row.end_time, row.id]);

  const sameDay =
    row.end_year == null || (row.end_year === row.year && row.end_month === row.month && row.end_day === row.day);

  const commit = (which: "start" | "end") => {
    const isStart = which === "start";
    const text = isStart ? startText : endText;
    const setText = isStart ? setStartText : setEndText;
    const setErr = isStart ? setStartErr : setEndErr;
    const current = (isStart ? row.start_time : row.end_time) ?? null;
    const fail = (e: TimeErr) => {
      dirty.current[which] = true; // 거부된 글자를 남겨 고치게 한다 — row 변경이 지우지 못하게.
      setErr(e);
    };

    const trimmed = text.trim();
    let next: string | null = null;
    if (trimmed !== "") {
      next = parseTimeInput(trimmed);
      if (next === null) return fail("invalid");
    }
    const nextStart = isStart ? next : row.start_time;
    const nextEnd = isStart ? row.end_time : next;
    // I2: 종료는 시작이 있어야 한다. 시작을 비우려면 × 로 둘을 함께 비운다.
    if (nextEnd != null && nextStart == null) return fail("needs_start");
    // I3: 같은 날이면 시작 <= 종료("HH:MM" 사전식 비교 = 시각 비교).
    if (sameDay && nextStart != null && nextEnd != null && nextStart > nextEnd) return fail("order");

    dirty.current[which] = false;
    setErr(null);
    setText(next ?? "");
    if (next === current) return; // 바뀐 게 없으면 전송하지 않는다.
    onPatch(isStart ? { start_time: next } : { end_time: next });
  };

  const revert = (which: "start" | "end", el: HTMLInputElement) => {
    dirty.current[which] = false;
    if (which === "start") {
      setStartText(row.start_time ?? "");
      setStartErr(null);
    } else {
      setEndText(row.end_time ?? "");
      setEndErr(null);
    }
    el.blur();
  };

  // × = 시작·종료를 **한 번의** 패치로 둘 다 비운다 — 따로 두 번 쏘면 "종료만 남은" 중간 상태가
  // 서버 불변식 I2(end_time ⇒ start_time)에 걸린다.
  const clearBoth = () => {
    dirty.current = { start: false, end: false };
    setStartText("");
    setEndText("");
    setStartErr(null);
    setEndErr(null);
    onPatch({ start_time: null, end_time: null });
  };

  const err = startErr ?? endErr;
  const errMsg =
    err === "order"
      ? t("editor.time_error_order")
      : err === "needs_start"
        ? t("editor.time_error_needs_start")
        : err === "invalid"
          ? t("editor.time_error_invalid")
          : null;

  const field = (which: "start" | "end") => {
    const isStart = which === "start";
    const bad = (isStart ? startErr : endErr) != null;
    return (
      <input
        type="text"
        inputMode="text"
        maxLength={TIME_INPUT_MAX_LEN}
        placeholder="00:00"
        className="field field--seamless"
        aria-label={isStart ? t("editor.time_start") : t("editor.time_end")}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? TIME_ERR_ID : undefined}
        data-testid={isStart ? "reminder-start-time" : "reminder-end-time"}
        value={isStart ? startText : endText}
        onChange={(e) => {
          dirty.current[which] = true;
          // 알림보다 가드: 잘못된 키 입력은 입력 단계에서 막는다(guardTimeTyping).
          const prevText = isStart ? startText : endText;
          (isStart ? setStartText : setEndText)(guardTimeTyping(prevText, e.target.value));
          (isStart ? setStartErr : setEndErr)(null);
        }}
        onBlur={() => commit(which)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(which);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            revert(which, e.currentTarget);
          }
        }}
        style={bad ? { ...timeFieldStyle, borderColor: "var(--danger)" } : timeFieldStyle}
      />
    );
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        {field("start")}
        <span aria-hidden style={{ color: "var(--muted)", flex: "none" }}>{"–"}</span>
        {field("end")}
        {/* 이름 줄의 × 와 같은 x 좌표에 서도록 오른쪽 끝으로 민다. */}
        <span style={{ flex: 1 }} />
        <ClearButton
          visible={startText !== "" || endText !== ""}
          label={t("note.clear_date_time")}
          testid="reminder-time-clear"
          onClear={clearBoth}
        />
      </div>
      {errMsg && (
        <span
          id={TIME_ERR_ID}
          role="alert"
          data-testid="reminder-time-error"
          style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}
        >
          {errMsg}
        </span>
      )}
    </div>
  );
}

/** Repeat's inline editor needs its own local draft (docs/PLAN-schedule-system.md §3 RRULE
 *  fields — freq/interval/byday/until don't fit one native input). Every change still commits
 *  immediately (§F — no separate save step): each handler updates the local draft AND calls
 *  onPatch in the same breath. */
function RepeatFields({
  row,
  uiLang,
  onPatch,
}: {
  row: UnifiedRow;
  uiLang: string;
  onPatch: (patch: RowSchedulePatch) => void;
}) {
  const [repeat, setRepeat] = useState<RepeatDraft>(() => parseRruleForUi(row.rrule));
  const weekdayLabels = weekdayShortLabels(uiLang);
  const repeatOptions: SelectOption[] = REPEAT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }));

  const commit = (next: RepeatDraft) => {
    setRepeat(next);
    onPatch({
      start_time: row.start_time,
      end_time: row.end_time,
      remind_offset_min: row.remind_offset_min,
      rrule: buildRrule(next),
    });
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}>
      <Select
        value={repeat.freq}
        onChange={(v) => commit({ ...repeat, freq: v as RepeatFreq })}
        options={repeatOptions}
        ariaLabel={t("editor.repeat")}
        testid="reminder-repeat-select"
        className="chip-btn"
        style={compactSelectStyle}
      />
      {repeat.freq !== "none" && (
        <input
          type="number"
          min={1}
          max={999}
          className="field"
          style={{ ...chipScaleField, width: 44, flex: "none", textAlign: "center" }}
          data-testid="reminder-interval"
          value={repeat.interval}
          onChange={(e) => commit({ ...repeat, interval: e.target.value })}
        />
      )}
      {repeat.freq === "WEEKLY" && (
        <div style={{ display: "flex", gap: "var(--space-1)" }}>
          {WEEKDAY_CODES.map((code, i) => {
            const active = repeat.byday.includes(code);
            return (
              <button
                key={code}
                type="button"
                data-testid={`reminder-byday-${code}`}
                aria-pressed={active}
                onClick={() =>
                  commit({
                    ...repeat,
                    byday: active ? repeat.byday.filter((d) => d !== code) : [...repeat.byday, code],
                  })
                }
                style={{
                  // 생 26px 이 아니라 칩과 같은 토큰 — 사용자가 글꼴 배율을 올리면 칩만 커지고
                  // 요일 버튼은 그대로 남아 줄이 어긋났다.
                  width: "var(--ctrl-h-sm)",
                  height: "var(--ctrl-h-sm)",
                  padding: 0,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line)",
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "var(--on-solid)" : "var(--text)",
                  fontSize: "var(--text-xs)",
                  cursor: "pointer",
                }}
              >
                {weekdayLabels[i]}
              </button>
            );
          })}
        </div>
      )}
      {/* 반복 종료일(UNTIL) 입력은 없다(2026-09-08 오너 결정). 네이티브 `<input type="date">` 는
          OS 달력을 띄우는데 이 팝오버엔 이미 앱 달력이 떠 있어 **달력이 두 개**가 됐다 — 이
          저장소가 예전에 같은 이유로 금지한 그것이다. 반복을 끝내는 수단은 반복을 끄는 것이고,
          그건 이미 이 앱의 완료 모델("끄는 것이 곧 완료", GRILL-2026-09-07 D10)과 같다.
          **이미 저장된 UNTIL 은 그대로 산다** — parseRruleForUi 가 읽어 draft.until 에 담고
          buildRrule 이 다시 내보내므로, 여기서 다른 반복 필드를 고쳐도 유실되지 않는다
          (회귀 테스트: "편집해도 기존 UNTIL 이 남는다"). 다시 필요해지면 날짜가 아니라 횟수
          (RRULE COUNT)로 여는 것이 이 화면과 맞는다 — 다만 rrule 파서가 COUNT 를 의도적으로
          거부하므로(부분 지원은 조용한 오답을 낳는다) 그 결정을 함께 뒤집어야 한다. */}
    </div>
  );
}
