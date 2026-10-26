// PLAN-2026-09-08-dates-rebuild.md §1.1 — the note's event axis is the `position 0` row of
// `note_dates`; `notes.year/month/day/...` are its projection (§1.2). Editing it is the same
// `note_date_update` every other row gets — there is no separate primary-only command.
//
// W4b: `note_dates_list` returns that row as its first item (position ASC), so **the primary has a
// real id** — any surface that can list a note's dates can call note_date_update on it directly.
// (The earlier "add a new row → promote it to 0 → diff the list → delete the demoted old primary"
// composite existed only because the list excluded position 0; it changed the primary's id on every
// edit, could leave a stray row behind on a crash mid-sequence, and failed outright when the new
// date already existed as a related row.) `patchDateRow` below is that direct path; the two
// `replacePrimaryDate`-shaped helpers stay for the callers that only know a note id and a patch
// (stores/notesActive.ts's setters, DateBadge's calendar drag).
import { call } from "./invoke";
import type { NoteDate, NoteDetail, NoteSummary } from "./commands.gen";
import { orderIsoRange, parseIsoDay } from "../components/home/calendarLayout";
import { useNotesStore } from "../stores/notes";
import { bumpNoteQueryVersion } from "./noteQuery";

export interface PrimaryDatePatch {
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
}

export function primaryPatchFromSummary(n: NoteSummary): PrimaryDatePatch {
  return {
    year: n.year,
    month: n.month,
    day: n.day,
    end_year: n.end_year ?? null,
    end_month: n.end_month ?? null,
    end_day: n.end_day ?? null,
    start_time: n.start_time ?? null,
    end_time: n.end_time ?? null,
    remind: n.remind ?? false,
    remind_offset_min: n.remind_offset_min ?? null,
    rrule: n.rrule ?? null,
  };
}

/**
 * PLAN-2026-09-10-calendar-reminders.md D6 — "목록 조회 → 행 찾기 → 전량 교체" 한 함수.
 * `dateId` 가 null 이면 대표(position 0) 행을 고른다. `note_date_update` 는 전량 교체 계약
 * (specs/commands/notes.yaml)이라 현재 행 위에 `patch` 를 얹어 보낸다 — 한 필드만 바꾸려는
 * 호출자가 나머지를 몰라도 뭉개지 않는다. 행이 없으면 조용히 아무것도 하지 않는다.
 * 행을 이미 손에 든 호출자(NoteDatesList.commitRelated — 낙관적 갱신 때문에 로컬 사본이 있다)는
 * 이 조회를 건너뛰고 직접 note_date_update 를 부른다.
 *
 * 그릴 2026-09-16: 여기서 한 번 bump 한다 — 사이드바(CalendarExpanded.onCreateTimedNote)가 이
 * 호출 뒤 아무것도 안 불러 방금 만든 시간축 일정이 재조회 전까지 안 보이던 사고 때문이다. 이미
 * 자기 경로로 동기화하는 호출자(DatesPanel.syncStores, CalendarTab.setReloadToken)에게는 250ms
 * 로 합쳐지는 중복 bump 라 해롭지 않다 — 매 호출자에 각자 고치는 대신 모든 호출자가 지나는 이
 * 한 지점에서 고친다(CLAUDE.md 코드 방침).
 */
export async function patchDateRow(
  noteId: string,
  dateId: string | null,
  patch: Partial<PrimaryDatePatch>,
): Promise<void> {
  const res = await call<{ dates: NoteDate[] }>("note_dates_list", { note_id: noteId });
  const row = dateId
    ? res?.dates.find((d) => d.id === dateId)
    : res?.dates.find((d) => d.position === 0);
  if (!row) return;
  await call("note_date_update", {
    id: row.id,
    year: row.year,
    month: row.month,
    day: row.day,
    end_year: row.end_year,
    end_month: row.end_month,
    end_day: row.end_day,
    remind: row.remind,
    start_time: row.start_time,
    end_time: row.end_time,
    remind_offset_min: row.remind_offset_min,
    rrule: row.rrule,
    // PLAN-2026-09-18-nl-dates.md D1(V85) — note_date_update 는 전량 교체 계약이라, `patch` 에
    // 없는 필드도 이 행의 현재 값을 그대로 실어야 한다(위 11개 필드와 같은 이유). label 을 빼면
    // 이 행에 달린 라벨이 달력 드래그 한 번에 조용히 NULL 로 지워진다 — `patch`(PrimaryDatePatch)
    // 는 label 을 다루지 않으므로 여기서 덮어쓰일 일도 없다.
    label: row.label,
    ...patch,
  });
  bumpNoteQueryVersion();
}

/** The note's `position 0` row. Null only if the invariant is broken (every note gets one at
 *  creation — repo::notes::dates::insert_primary_row), which the caller surfaces as an error
 *  rather than silently writing somewhere else. */
export async function fetchPrimaryDateRow(noteId: string): Promise<NoteDate | null> {
  const res = await call<{ dates: NoteDate[] }>("note_dates_list", { note_id: noteId });
  return res?.dates.find((d) => d.position === 0) ?? null;
}

/** Full replace of the note's primary (event-axis) row. `note_date_update` is a whole-row replace
 *  by contract (specs/commands/notes.yaml), so the current state is read first and `patch` merged
 *  on top — a caller that only wants to change the end date never has to know the note's current
 *  start_time/remind/rrule to avoid clobbering them. */
export async function replacePrimaryDate(
  noteId: string,
  patch: Partial<PrimaryDatePatch>,
): Promise<NoteSummary> {
  const current = await call<NoteDetail>("note_get", { id: noteId });
  const full: PrimaryDatePatch = { ...primaryPatchFromSummary(current.note), ...patch };

  const row = await fetchPrimaryDateRow(noteId);
  if (!row) {
    throw new Error(`note ${noteId} has no position 0 date row`);
  }
  // D2: 이 행은 항상 position 0(대표)이라 label 은 항상 null — 서버도 그렇게 강제하지만
  // (repo::notes::dates::date_update), 이 full-replace 페이로드에서도 명시해 둔다(patchDateRow
  // 와 같은 규율: 이 계약의 필드는 빠뜨리지 않는다).
  await call("note_date_update", { id: row.id, ...full, label: null });

  const detail = await call<NoteDetail>("note_get", { id: noteId });
  return detail.note;
}

/**
 * PLAN-2026-09-11 사이드바 W1 D5 — 달력의 "날짜 범위로 노트 하나" 생성 경로. CalendarTab 의
 * 드래그·"+"·AI 확정·시간축 빈 곳이 다 여기를 지나고, 사이드바(W2)가 두 번째 사용처다 —
 * 생성 경로는 하나여야 한다. `note_create` 는 시작 트리플만 받으므로 기간이면 종료 트리플을
 * replacePrimaryDate 로 얹는다. 끝에 loadTree(트리 갱신)와 bumpNoteQueryVersion(달력·보드
 * 재조회)을 부른다 — loadTree 도 안에서 bump 하지만 모바일 분기처럼 조용히 갈리는 경로가 있어
 * 여기서 한 번 더 명시한다(250ms 로 합쳐지니 값은 하나다).
 *
 * 실패 처리 **결정**: call() 이 이미 토스트를 띄웠으므로 여기서 붙잡고 null 을 준다. 잘못된
 * ISO 도 null 이라 호출자 계약은 "null = 노트 없음" 하나다 — 호출자는 throw 를 기다리지 않는다.
 * 호출자의 UI 상태(creating 토글 등)는 여기 없다; 감싸서 쓴다.
 */
export async function createNoteForRange(
  startIso: string,
  endIso: string,
  opts?: { title?: string },
): Promise<string | null> {
  const [lo, hi] = orderIsoRange(startIso, endIso);
  const start = parseIsoDay(lo);
  const end = parseIsoDay(hi);
  if (!start || !end) return null;
  const store = useNotesStore.getState();
  try {
    const folderId = store.inboxId ?? (await store.ensureInboxId());
    const created = await call<NoteDetail>("note_create", {
      folder_id: folderId,
      title: opts?.title?.trim() || undefined,
      year: start.year,
      month: start.month,
      day: start.day,
    });
    if (lo !== hi) {
      await replacePrimaryDate(created.note.id, {
        end_year: end.year,
        end_month: end.month,
        end_day: end.day,
      });
    }
    await useNotesStore.getState().loadTree();
    bumpNoteQueryVersion();
    return created.note.id;
  } catch {
    // call() 이 토스트를 띄웠다. 기간 붙이기에서 실패했으면 하루짜리 노트가 남는다 — 데이터
    // 손실 방향이 아니고, 다음 loadTree 가 진실을 그린다.
    return null;
  }
}
