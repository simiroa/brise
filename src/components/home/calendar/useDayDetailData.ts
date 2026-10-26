/**
 * 날짜 상세 패널(DayDetailBody)의 **데이터 조회 계층** — 화면이 아니라 "이 날에 무엇이 있나"를
 * 답하는 두 조회가 여기 산다. 순수 이동(동작 변경 0): 아래 두 훅의 본문은 DayDetailPanel.tsx 에
 * 있던 블록 그대로이고, 주석도 그 자리의 것을 옮겨 왔다.
 *
 * 둘을 한 훅으로 합치지 않았다 — 입력도 출처도 다르다. 루틴은 **설정**에서 오는 요일 반복이고
 * (노트에 안 묶인 배경 장식), 아래쪽은 그 날 **노트들의 본문**에서 오는 발췌·체크리스트다.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  NoteDetail,
  NoteGetManyOutput,
  TimelineRoutine,
  TimelineRoutineListOutput,
  TodoToggleResult,
  CalendarItem,
} from "../../../lib/commands.gen";
import { call, callSilent } from "../../../lib/invoke";
import { useNotesStore, displayTitle } from "../../../stores/notes";
import { isoWeekdayBit } from "../dateFmt";
import { useTimelineRoutineVersion } from "../../../lib/timelineRoutines";
import { useSettingsStore } from "../../../stores/settings";
import {
  type InlineTaskItem,
  getTasksForDate,
  parseTasksFromSections,
} from "../../../lib/inlineSchedule";
import { extractChipChecklist, type ChipChecklist } from "./TimeChip";

/**
 * 시간축 배경 루틴(그릴 2026-09-13 W3) — 노트에 안 묶이는 "출퇴근"류 반복 일정 중 **그 날**에
 * 걸리는 것만.
 *
 * 마운트/workspace 전환 시, 그리고 Settings에서 루틴을 추가/수정/삭제할 때마다
 * (routineVersion) 다시 불러온다 — 화면을 벗어났다 돌아올 필요 없이 곧바로 반영된다
 * (그릴 2026-09-13 후속, lib/timelineRoutines.ts — noteQuery.ts의 bump 관례와 같은 모양).
 * 실패는 조용히 빈 목록으로 — 배경 장식이라 토스트로 사용자를 방해할 값이 없다(callSilent +
 * catch, CLAUDE.md 함정 8 ⓐ).
 */
export function useDayRoutines(
  selectedDay: string | null,
  holidayName: string | null,
): TimelineRoutine[] {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const [timelineRoutines, setTimelineRoutines] = useState<TimelineRoutine[]>([]);
  const routineVersion = useTimelineRoutineVersion();
  useEffect(() => {
    let cancelled = false;
    void callSilent<TimelineRoutineListOutput>("timeline_routine_list", {})
      .then((res) => {
        if (!cancelled) setTimelineRoutines(res?.routines ?? []);
      })
      .catch(() => {
        if (!cancelled) setTimelineRoutines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, routineVersion]);

  /** 그 날의 요일 비트에 걸리는 루틴만 — position asc(서버가 이미 그 순서로 준다). 그 날이
   *  공휴일이면(부모가 이미 계산해 내려주는 holidayName, useHolidayMap 기준) skip_holidays 를
   *  켠 루틴은 뺀다 — v83 후속, 서버는 공휴일 날짜를 모르니 이 판정은 항상 프론트 몫이다. */
  return useMemo(() => {
    if (!selectedDay) return [];
    const bit = isoWeekdayBit(selectedDay);
    if (bit === 0) return [];
    const isHoliday = !!holidayName;
    return timelineRoutines.filter(
      (r) => (r.weekday_mask & bit) !== 0 && !(isHoliday && r.skip_holidays),
    );
  }, [timelineRoutines, selectedDay, holidayName]);
}

export type DayNoteBodies = {
  /** note_id → 본문 발췌(두 줄). 종일 카드와 축 칩의 3행째가 같이 쓴다. */
  excerpts: Record<string, string>;
  /** note_id → 그 노트 첫 text 섹션의 체크리스트 줄들. */
  checklists: Record<string, ChipChecklist>;
  /** 그 날짜 마커가 달린 체크리스트 줄들(전역 집계) — 패널 아래 "할 일" 목록이 쓴다. */
  activeInlineTasks: InlineTaskItem[];
  handleToggleTask: (task: InlineTaskItem) => Promise<void>;
  handleToggleChecklistItem: (
    noteId: string,
    sectionId: string,
    lineIndex: number,
    currentChecked: boolean,
  ) => Promise<void>;
};

/** `note_get_many` 한 번에 보내는 id 상한 — Rust `repo::notes::NOTE_GET_MANY_MAX` 와 같은 값이어야
 *  한다(넘으면 서버가 VALIDATION). 그보다 많은 날은 청크로 나눠 보내 예전처럼 전부 보인다 —
 *  보통의 날은 IPC 1회다. */
export const NOTE_GET_MANY_MAX = 500;

/**
 * 그 날 노트들의 **본문 한 번 읽기**와 그 부산물 전부 — 발췌·칩 체크리스트·인라인 할 일이
 * 한 번의 `note_get_many` 왕복에서 같이 나온다(PLAN-2026-09-10 D5: 추가 IPC 0). 예전엔 노트마다
 * `note_get` 을 불러 합성 1만 노트에서 첫 열기마다 IPC ~420회였다(PLAN-2026-10-23 perf-baselines).
 *
 * 두 토글(전역 할 일 · 칩 체크리스트)도 여기 있다 — 각자 이 훅의 state 를 낙관적으로 고치고
 * 실패 시 되돌리므로(CLAUDE.md 함정 9), 그 state 와 떨어질 수 없다.
 */
export function useDayNoteBodies({
  selectedDay,
  detailNotes,
  propInlineTasks,
  onToggleInlineTask,
}: {
  selectedDay: string | null;
  detailNotes: CalendarItem[];
  /** 부모가 이미 집계해 내려주면 조회 자체를 하지 않는다(그때는 토글도 부모의 것). */
  propInlineTasks?: InlineTaskItem[];
  onToggleInlineTask?: (task: InlineTaskItem) => void;
}): DayNoteBodies {
  // Local state for fetched inline tasks when not passed as props
  const [fetchedTasks, setFetchedTasks] = useState<InlineTaskItem[]>([]);
  /** 펼친 카드의 본문 발췌 — 아래 note_get_many 왕복의 **부산물**이다(PLAN-2026-09-10 D5: 추가 IPC 0). */
  const [excerpts, setExcerpts] = useState<Record<string, string>>({});
  /** 축 칩 하단 체크박스 sub-list — 발췌와 **같은** note_get_many 왕복의 부산물이다(추가 IPC 0).
   *  note_id → 그 노트의 첫 text 섹션 안 체크리스트 줄들. */
  const [checklists, setChecklists] = useState<Record<string, ChipChecklist>>({});

  /** 이 날 화면에 있는 노트 id 들 — **문자열**이라 내용이 같으면 identity 도 같다.
   *  아래 본문 조회를 `detailNotes`(배열) 대신 이것에 건다: 축에서 칩을 한 칸 옮길 때마다
   *  쓰기 → bump → 달력 재조회 → **새 배열**이 오는데, 그때 그날 노트 **전부**의 본문을 다시
   *  읽고 있었다(노트 10개면 드래그 한 번에 note_get 10회 — 지금은 note_get_many 1회). 어느 노트가 이 날에 있는지가
   *  안 바뀌면 본문도 다시 읽을 이유가 없다.
   *  ponytail: 다른 화면에서 본문을 고쳐도 이 발췌는 날짜를 다시 고를 때까지 옛 값이다 —
   *  발췌는 두 줄짜리 곁다리라 그 값에 IPC 를 N 배 쓰지 않는다. */
  const noteIdsKey = useMemo(
    () => Array.from(new Set(detailNotes.map((n) => n.note_id))).sort().join(","),
    [detailNotes],
  );

  // Fetch inline tasks from note bodies when the day (or which notes are on it) changes.
  useEffect(() => {
    const clear = () => {
      setFetchedTasks((prev) => (prev.length > 0 ? [] : prev));
      setExcerpts((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      setChecklists((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    };
    if (propInlineTasks !== undefined || !selectedDay) {
      clear();
      return;
    }

    let cancelled = false;
    const noteIds = noteIdsKey ? noteIdsKey.split(",") : [];
    if (noteIds.length === 0) {
      clear();
      return;
    }

    void (async () => {
      try {
        // 노트 N 개 → IPC 1회(상한을 넘는 날만 청크 수만큼). 없는·휴지통 노트는 서버가 빼고
        // 돌려준다(예전 note_get 은 없는 id 마다 NOT_FOUND 토스트). 실패하면 call() 이 한 번
        // 토스트하고 아래 catch 가 비운다 — 예전처럼 노트별로 일부만 살리지는 않는다.
        const chunks: string[][] = [];
        for (let i = 0; i < noteIds.length; i += NOTE_GET_MANY_MAX) {
          chunks.push(noteIds.slice(i, i + NOTE_GET_MANY_MAX));
        }
        const pages = await Promise.all(
          chunks.map((ids) => call<NoteGetManyOutput>("note_get_many", { ids })),
        );
        if (cancelled) return;
        const loaded: NoteDetail[] = pages.flatMap((p) => p.notes);

        const allTasks: InlineTaskItem[] = [];
        const nextExcerpts: Record<string, string> = {};
        const nextChecklists: Record<string, ChipChecklist> = {};
        for (const detail of loaded) {
          const tasks = parseTasksFromSections(
            detail.sections,
            detail.note.id,
            displayTitle(detail.note.title),
          );
          allTasks.push(...tasks);
          const textSection = detail.sections.find((s) => s.kind === "text");
          if (textSection?.body_md) {
            // 체크리스트 줄은 그 섹션 body_md 전체 기준 실제 줄 번호로 뽑는다(요구사항 ③) —
            // todo_toggle 이 이 lineIndex 를 그대로 쓰므로 로컬로 걸러낸 배열의 인덱스면 안 된다.
            const checklistItems = extractChipChecklist(textSection.body_md);
            if (checklistItems.length > 0) {
              nextChecklists[detail.note.id] = { sectionId: textSection.id, items: checklistItems };
            }
            // 발췌 2줄은 체크리스트 줄을 뺀 나머지에서 채운다(요구사항 ①) — firstLines 자체는
            // 안 건드리고, 넘기기 전에 체크리스트 줄만 골라 지운다(중복 정의 없음).
            const checklistLines = new Set(checklistItems.map((c) => c.lineIndex));
            const bodyWithoutChecklist = textSection.body_md
              .split("\n")
              .filter((_, idx) => !checklistLines.has(idx))
              .join("\n");
            const excerpt = firstLines(bodyWithoutChecklist);
            if (excerpt) nextExcerpts[detail.note.id] = excerpt;
          }
        }
        setExcerpts(nextExcerpts);
        setChecklists(nextChecklists);
        if (allTasks.length > 0) {
          setFetchedTasks(allTasks);
        } else {
          setFetchedTasks((prev) => (prev.length > 0 ? [] : prev));
        }
      } catch {
        if (!cancelled) clear();
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detailNotes 는 일부러 뺐다.
    // 위 noteIdsKey 주석 참고 — 배열 identity 에 걸면 달력 재조회마다 N 번 다시 읽는다.
  }, [selectedDay, noteIdsKey, propInlineTasks]);

  const activeInlineTasks = useMemo(() => {
    const source = propInlineTasks !== undefined ? propInlineTasks : fetchedTasks;
    return selectedDay ? getTasksForDate(source, selectedDay) : [];
  }, [propInlineTasks, fetchedTasks, selectedDay]);

  const handleToggleTask = async (task: InlineTaskItem) => {
    if (onToggleInlineTask) {
      onToggleInlineTask(task);
      return;
    }

    // Optimistic toggle in local state
    setFetchedTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, completed: !t.completed } : t)),
    );

    try {
      await call<TodoToggleResult>("todo_toggle", {
        note_id: task.noteId,
        section_id: task.sectionId,
        line_index: task.lineIndex,
        expected_checked: task.completed,
      });
      if (useNotesStore.getState().activeNote?.note.id === task.noteId) {
        void useNotesStore.getState().selectNote(task.noteId);
      }
    } catch {
      // Revert on error
      setFetchedTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, completed: task.completed } : t)),
      );
    }
  };

  /** 축 칩 하단 체크박스 sub-list의 토글 — handleToggleTask 와 같은 모양(낙관적 갱신 + 실패 시
   *  되돌리기, CLAUDE.md 함정 9)이지만 입력이 다르다: 전역 집계는 InlineTaskItem 전체를 들고
   *  있고, 이쪽은 이 칩의 note_id/section_id/line_index 뿐이라 공유를 강제하지 않는다. */
  const handleToggleChecklistItem = async (
    noteId: string,
    sectionId: string,
    lineIndex: number,
    currentChecked: boolean,
  ) => {
    const applyChecked = (checked: boolean) => {
      setChecklists((prev) => {
        const entry = prev[noteId];
        if (!entry) return prev;
        return {
          ...prev,
          [noteId]: {
            ...entry,
            items: entry.items.map((it) => (it.lineIndex === lineIndex ? { ...it, checked } : it)),
          },
        };
      });
    };

    applyChecked(!currentChecked);

    try {
      await call<TodoToggleResult>("todo_toggle", {
        note_id: noteId,
        section_id: sectionId,
        line_index: lineIndex,
        expected_checked: currentChecked,
      });
      if (useNotesStore.getState().activeNote?.note.id === noteId) {
        void useNotesStore.getState().selectNote(noteId);
      }
    } catch {
      applyChecked(currentChecked);
    }
  };

  return {
    excerpts,
    checklists,
    activeInlineTasks,
    handleToggleTask,
    handleToggleChecklistItem,
  };
}

/** 발췌 = 첫 text 섹션 본문의 **앞 두 줄**(빈 줄 제외). 마크다운은 걷어내지 않는다 — 두 줄짜리
 *  미리보기에 파서를 들이는 값이 없다.
 *  ponytail: 제목(`#`)·목록 표식이 그대로 보인다. 거슬리면 그때 lib 에 있는 렌더러를 쓴다. */
function firstLines(body: string | undefined): string {
  if (!body) return "";
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
}
