// R2-a 분리: stores/notes.ts 의 활성 노트 문서 + draft 상태기계 + 메타 setter 관심사를 이
// 슬라이스로 옮겼다. 디바운스 자동저장(제목/연도)은 lib/noteAutosave.ts로, 스냅샷 타이머는
// lib/noteSnapshots.ts로 각각 더 옮겨졌다 — 이 파일은 그 둘을 엮어 쓴다.
import type { StateCreator } from "zustand";
import { call, callSilent, emitNotice, flushAll } from "../lib/invoke";
import { clearSaveFailed, fieldFailureKey, markSaveFailed, noteHasSaveFailure } from "../lib/sectionSaveFailures";
import type { NoteDetail, NoteSummary, Section, SectionUpdateOutput } from "../lib/commands.gen";
import { replacePrimaryDate } from "../lib/primaryDate";
import { useTabsStore } from "./tabs";
import { useUiStore } from "./ui";
import { useSettingsStore } from "./settings";
// applyPreset's in-place-vs-new-section decision reads the same PresetTargetState PresetList
// labels its rows with — one judgement, no drift. presets.ts imports only lib/invoke + i18n, so
// this direction adds no cycle.
import { usePresetsStore } from "./presets";
import { t } from "../i18n/t";
import { makeFieldFlush } from "../lib/noteAutosave";
import { markSnapshotDirty } from "../lib/noteSnapshots";
import { reportFallback } from "../lib/diag";
import {
  clearConflictBodies,
  forgetSectionToken,
  getSectionToken,
  hasConflictBody,
  heldConflictBodies,
  holdConflictBody,
  isSectionGated,
  markSectionGone,
  runBodyCacheDiscardHooks,
  seedSectionTokens,
  setSectionToken,
} from "../lib/sectionTokens";
import { patchSectionBodyCache } from "../lib/sectionBodyCache";
import type { NotesState } from "./notes";

export type SavedState = "saved" | "saving" | "failed" | "ai_organized";

/** D2②: 본문 저장이 CONFLICT(다른 기기가 먼저 씀)로 거부된 섹션. savedState 는 "failed" 그대로 —
 *  MobileNote 는 `savedState !== "failed"` 를 성공으로 읽으므로 새 상태를 만들면 나가기 차단이 풀린다. */
export interface SaveConflict {
  noteId: string;
  sectionId: string;
}

/** Identity of an attachment set, by id and order — enough to tell an add/remove from a
 *  section-only reload. Renames don't matter here; only the thumbnail map keys do. */
function sameAttachmentIds(
  a: NoteDetail["attachments"] | undefined,
  b: NoteDetail["attachments"] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id);
}

/** Cheap emptiness check for the preset-visibility rule (SourcePanel/PresetList): whitespace-only
 *  counts as empty. body_md is markdown for most content but literal HTML passthrough for
 *  table/details/etc nodes (see EditorPanel's mdSerializeHtml comment) — stripping tags covers
 *  both without a real parse. Exported so EditorPanel's appendSectionLocally (adding a section
 *  outside the updateSectionBody path) can keep activeBodyEmpty in sync too. */
export function isNoteBodyEmpty(sections: { body_md: string }[]): boolean {
  return sections.every((s) => s.body_md.replace(/<[^>]*>/g, "").trim().length === 0);
}

export const displayTitle = (title: string) =>
  title.trim() && title !== "Untitled Note" ? title : t("note.untitled_note");

export interface NotesActiveSlice {
  activeNote: NoteDetail | null;
  activeDraft: boolean;
  /** Reactive "does the current note (draft or saved) have any real body text" signal — the
   *  preset-visibility rule (SourcePanel) also needs 0 attachments/0 related, checked there
   *  directly off activeNote/useAutoRelated. Kept separate from activeNote itself so a save
   *  mid-typing never replaces the activeNote reference (that would reset the editor's caret —
   *  see updateSectionBody's non-draft branch). */
  activeBodyEmpty: boolean;
  loadingNoteId: string | null;
  savedState: SavedState;
  setSavedState: (s: SavedState) => void;
  attachmentRevision: number;
  bumpAttachmentRevision: () => void;
  discardDraft: () => void;
  ensureMaterialized: () => Promise<string | null>;
  updateSectionBody: (id: string, body_md: string) => Promise<void>;
  /** D2②: 열린 충돌. 해결(resolveSaveConflict)·충돌 섹션의 성공 저장·노트 전환 때 null. */
  saveConflict: SaveConflict | null;
  /** D2② 충돌 해결 — "copy": 이 기기의 본문을 같은 노트의 새 섹션으로 남기고 노트를 다시 읽는다.
   *  "overwrite": 서버 토큰을 새로 읽어 이 기기의 본문으로 덮는다. 본문은 에디터가 아니라 충돌 게이트가
   *  쥔 값(lib/sectionTokens.ts)이다 — 먼저 flushAll() 로 마지막 편집을 거기 모은다. 성공하면 true. */
  resolveSaveConflict: (mode: "copy" | "overwrite") => Promise<boolean>;
  /** Applies a preset's title/body onto the CURRENT note when it's an existing (materialized)
   *  note — in place when that note is empty, as a NEW section when it isn't (see the
   *  implementation's targetState branch). Never spins up a competing draft in either case.
   *  Otherwise (no note open, or a draft already open) falls through to the draft-creation path.
   *  `landing` (manage 모달의 "만들기" 메뉴, lib/presetBridge.ts::PresetLanding) forces the
   *  landing and skips the auto judgment: "new-note" always goes to the draft path (in-place is
   *  unreachable), "new-section" always appends a section (no materialized note → draft path,
   *  a safe fallback the UI gates anyway). Returns the written section id only when it edited an
   *  existing note IN PLACE (see EditorPanel's registerApplyPreset caller) — every other path
   *  repaints itself. */
  applyPreset: (
    bodyMd: string,
    title: string | null,
    landing?: import("../lib/presetBridge").PresetLanding,
  ) => Promise<string | null>;
  selectNote: (id: string) => Promise<void>;
  newNote: (folderId?: string) => Promise<void>;
  toggleFavorite: () => Promise<void>;
  /** 더보기 메뉴 "내용잠금" — toggleFavorite와 정확히 같은 구조(같은 draft/materialized 두 갈래).
   *  ON이면 EditorPanel이 editor.setEditable(false)로, SectionTabBar가 섹션 추가/삭제 버튼을
   *  비활성화하는 식으로 반영한다 — 이 액션 자체는 플래그만 뒤집는다. */
  toggleContentLock: () => Promise<void>;
  setTags: (names: string[]) => Promise<void>;
  setTitle: (title: string) => void;
  setNoteYear: (year: number) => void;
  /** §2.3 HANDOFF-calendar-onboarding.md: event-axis precision below year. null/null = year only. */
  setEventPrecision: (month: number | null, day: number | null) => Promise<void>;
  /** Dashboard Wave 1: event-axis range end. All-null = clear range (single-point note). */
  setEventEnd: (
    end_year: number | null,
    end_month: number | null,
    end_day: number | null,
  ) => Promise<void>;
  /** Dashboard Wave 3 (docs/DASHBOARD.md §2, 2026-08-01): "알려줘" opt-in flag. */
  setRemind: (remind: boolean) => Promise<void>;
  /** docs/PLAN-schedule-system.md §1 W5-1/§7.3 — ReminderModal 이 저장 시 4필드를 한 번에 보낸다
   *  (note_set_schedule 은 생략 관례가 없다 — 매번 전부 전달, null=해제). */
  setSchedule: (patch: {
    start_time: string | null;
    end_time: string | null;
    remind_offset_min: number | null;
    rrule: string | null;
  }) => Promise<void>;
  setRegion: (region: string | null) => Promise<void>;
  setLocation: (lat: number | null, lng: number | null) => Promise<void>;
  setStatus: (status: string | null) => Promise<void>;
  /** Draft-safe path for the active note's icon — NoteIconControl uses this instead of calling
   *  note_set_icon directly when it's editing the currently-open note (see its own comment). */
  setIcon: (icon: string | null) => Promise<void>;
  /** `rewritten`: 이 클라이언트가 방금 에디터를 거치지 않고 본문을 통째로 바꾼 섹션(AI 교체). 토큰
   *  비교로는 못 잡으므로(토큰을 몰랐거나 이미 새 토큰을 알 수 있다) 안의 flushAll **뒤에** 캐시를 버린다 —
   *  앞에서 버리면 flush 가 낡은 본문으로 캐시를 다시 채운다. */
  reloadActive: (opts?: { rewritten?: readonly string[] }) => Promise<void>;
  /** D2② W4: 이 클라이언트가 만든 섹션(`section_create*` 응답)을 activeNote 끝에 붙이고 그 응답의
   *  토큰을 심는다 — 안 심으면 다음 노트 로드까지 토큰 없이(LWW) 저장된다. 섹션을 만들어 화면에 붙이는
   *  데스크톱(useSectionActions)·폰(MobileNote·MobilePostSave) 경로가 전부 여기를 지난다. 다른 노트면 무시. */
  appendActiveSection: (noteId: string, section: Section) => void;
}

export const createNotesActiveSlice: StateCreator<NotesState, [], [], NotesActiveSlice> = (
  set,
  get
) => {
  const scheduleTitleFlush = makeFieldFlush(set, get, "title", "note.save_title_failed");
  const scheduleYearFlush = makeFieldFlush(set, get, "year", "note.save_year_failed");

  let materializePromise: Promise<string | null> | null = null;
  let selectNoteSeq = 0;
  const saveChains = new Map<string, Promise<void>>();

  // D2② 본문 저장 한 번 — updateSectionBody 의 줄(saveChains) 안에서만 부른다. 절대 reject 하지 않는다
  // (DiagramSection·useSheetState 가 "updateSectionBody 는 reject 하지 않는다"에 기댄다).
  const sendSectionBody = async (id: string, body_md: string): Promise<void> => {
    if (isSectionGated(id)) {
      // 충돌(또는 사라진 섹션)이 열려 있다 — 보내지 않고 최신 본문만 쥔다. 실패 상태 유지.
      if (hasConflictBody(id)) holdConflictBody(id, body_md);
      set({ savedState: "failed" });
      return;
    }
    const expected = getSectionToken(id);
    try {
      const r = await call<SectionUpdateOutput>(
        "section_update",
        expected ? { id, body_md, expected_updated_at: expected } : { id, body_md },
      );
      setSectionToken(id, r.section_updated_at);
      set({ savedState: "saved" });
      useUiStore.getState().notifySectionSaved(id);
      // section_update bumps the note's updated_at server-side, and updated_at is a filter
      // axis (advanced-search dateRange chip, CalendarExpanded's record histogram + day list)
      // — route through the same chokepoint as every other mutation so those stay live.
      const noteId = get().activeNote?.note.id;
      if (noteId) get().patchNoteSummary(noteId, { updated_at: r.updated_at });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (expected && code === "CONFLICT") {
        holdConflictBody(id, body_md);
        if (!get().saveConflict) {
          const noteId = get().activeNote?.note.id ?? "";
          set({ saveConflict: { noteId, sectionId: id } });
        }
        reportFallback("section-save", "conflict");
      } else if (expected && code === "NOT_FOUND") {
        const msg = (e as { message?: string } | null)?.message ?? "";
        if (msg.includes("note is in trash")) {
          // 다른 기기가 이 노트를 휴지통으로 옮겼다. 토큰 없이 다시 보내면(단계 1 LWW) 본문이 휴지통 안
          // 노트에 남아 복구로 되살릴 수 있다 — 막다른 실패보다 낫다: 폰은 "그래도 나가기"가 클립보드를
          // 요구하는데 http://100.x 비보안 컨텍스트에선 클립보드가 없어 나갈 수조차 없게 된다.
          // 이 섹션은 이후에도 토큰 없이 보낸다(토큰을 다시 받지 않는다 — 다음 seed 까지).
          forgetSectionToken(id);
          try {
            // D2②: 토큰 면제 — 휴지통 노트에 저장하려고 일부러 토큰 없이 보낸다(서버 관찰 기록에 잡힌다).
            await call<SectionUpdateOutput>("section_update", { id, body_md });
            reportFallback("section-save", "saved_into_trash");
            emitNotice(t("editor.saved_into_trash"));
            set({ savedState: "saved" });
            return;
          } catch {
            // call() 이 토스트했다 — 아래 사라진 섹션 처리로.
          }
        }
        // 섹션 자체가 사라졌다(다른 기기가 지움) — 다시 보내 봐야 같은 답에 토스트만 쌓인다.
        markSectionGone(id);
        reportFallback("section-save", "gone");
      } else if (expected && code === "IO") {
        // M-8 후반: 토큰을 동반한 쓰기가 IO 에러로 실패한 경우(응답 유실 뒤 추가 입력된 글의 자기 충돌 방지).
        // 서버 본문이 마지막으로 보낸 본문과 같으면 서버 토큰 채택(쓰기 성공 반영). 다르면 이전 토큰 유지.
        // activeNote 섹션은 건드리지 않는다(CLAUDE.md 함정 4).
        const noteId = get().activeNote?.note.id;
        if (noteId) {
          try {
            const detail = await callSilent<NoteDetail>("note_get", { id: noteId });
            const serverSec = detail.sections.find((s) => s.id === id);
            if (serverSec && serverSec.body_md === body_md && serverSec.updated_at) {
              setSectionToken(id, serverSec.updated_at);
            }
          } catch {
            // callSilent 가 진단에 남겼다. 조회 실패 시 기존 토큰 유지.
          }
        }
      }
      set({ savedState: "failed" });
    }
  };

  // 노트를 떠날 때 열린 충돌을 버린다. 데스크톱엔 나가기 차단이 없어 이 기기의 미저장 본문이 여기서
  // 사라진다 — 진단에 남긴다(폰은 MobileNote 의 나가기 차단이 먼저 막는다).
  const dropConflictOnLeave = (nextNoteId: string | null) => {
    const c = get().saveConflict;
    if (!c || c.noteId === nextNoteId) return;
    reportFallback("section-save", "conflict_dropped_on_switch");
    clearConflictBodies();
    set({ saveConflict: null });
  };

  // Title guard (P1-3): presets used to always overwrite. Only fill when the note has no real
  // title yet — "Untitled Note" / blank counts as empty so AI/custom presets can name a fresh
  // note without clobbering a title the user already chose. Shared verbatim by all three
  // applyPreset branches (in place / new section / fresh draft).
  const fillPresetTitle = (currentTitle: string, title: string | null) => {
    if (title && (!currentTitle || currentTitle === "Untitled Note" || !currentTitle.trim())) {
      get().setTitle(title);
    }
  };

  // Shared template for the optimistic metadata setters below (setStatus/setRegion/setRemind/
  // setLocation/setEventPrecision/setEventEnd/setTags): draft-guard prologue -> optimistic set +
  // patchNoteSummary -> call(cmd, {id, ...patch}) -> re-set from the server echo -> on failure,
  // roll back both activeNote and the tree summary + savedState "failed". `fields` controls what
  // gets read off both the pre-edit note (for rollback) and the server response (for the echo) —
  // defaults to a plain read of each patched key; only setEventEnd needs an override (optional
  // end_year/end_month/end_day -> null). `notice`/`onSuccess` cover the two setters that diverge
  // on the edges (setEventPrecision/setEventEnd emitNotice on failure; setTags refreshes tag
  // counts on success) — every other setter passes neither. toggleFavorite does NOT use this: see
  // its own comment below for why it's structurally different.
  const patchActiveNote = async (
    patch: Partial<NoteSummary>,
    // PLAN-2026-09-08-dates-rebuild.md W4: setEventPrecision/setEventEnd/setSchedule no longer
    // have a single-field note-id-keyed command to call (note_set_event_precision/
    // note_set_event_end/note_set_schedule were deleted — see lib/primaryDate.ts's header for
    // why there's no direct replacement) — they pass a `run` function (replacePrimaryDate) instead
    // of a command name. Every other caller (setTags/setRegion/setStatus/...) still passes a
    // plain command name string.
    cmd: string | ((id: string, patch: Partial<NoteSummary>) => Promise<NoteSummary>),
    opts: {
      fields?: (src: NoteSummary) => Partial<NoteSummary>;
      notice?: string;
      onSuccess?: () => void;
    } = {}
  ): Promise<void> => {
    const n = get().activeNote;
    if (!n) return;
    // 내용잠금: setTags/setRegion/setStatus/setIcon/setEventPrecision/setEventEnd/setRemind/
    // setSchedule 8개 세터가 전부 이 한 지점을 지난다 — 여기 하나만 막으면 전부 막힌다.
    // toggleFavorite/toggleContentLock은 이 헬퍼를 안 쓰므로(각자 독립 함수) 예외가 자동 성립.
    if (n.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    if (get().activeDraft) {
      set({ activeNote: { ...n, note: { ...n.note, ...patch } } });
      await get().ensureMaterialized();
      return;
    }
    const readFields =
      opts.fields ??
      ((src: NoteSummary) => {
        const out: Partial<NoteSummary> = {};
        for (const k of Object.keys(patch)) (out as any)[k] = (src as any)[k];
        return out;
      });
    const id = n.note.id;
    const prev = readFields(n.note);
    set({
      activeNote: { ...n, note: { ...n.note, ...patch } },
      savedState: "saving",
    });
    get().patchNoteSummary(id, patch);
    try {
      const r = typeof cmd === "string" ? await call<NoteSummary>(cmd, { id, ...patch }) : await cmd(id, patch);
      const echoed = readFields(r);
      set({
        activeNote: { ...get().activeNote!, note: { ...get().activeNote!.note, ...echoed } },
        savedState: "saved",
      });
      get().patchNoteSummary(id, echoed);
      opts.onSuccess?.();
    } catch (e: any) {
      if (get().activeNote?.note.id === id) {
        set({ activeNote: { ...get().activeNote!, note: { ...get().activeNote!.note, ...prev } } });
      }
      get().patchNoteSummary(id, prev);
      set({ savedState: "failed" });
      if (opts.notice) emitNotice(e?.message || t(opts.notice));
    }
  };

  return {
    activeNote: null,
    activeDraft: false,
    activeBodyEmpty: true,
    loadingNoteId: null,
    savedState: "saved",
    setSavedState: (s) => {
      if (get().savedState !== s) set({ savedState: s });
    },
    attachmentRevision: 0,
    bumpAttachmentRevision: () => set((s) => ({ attachmentRevision: s.attachmentRevision + 1 })),

    discardDraft: () => {
      if (get().activeDraft) {
        set({ activeNote: null, activeDraft: false });
      }
    },

    ensureMaterialized: () => {
      const s = get();
      if (!s.activeDraft) return Promise.resolve(s.activeNote?.note.id || null);
      if (materializePromise) return materializePromise;

      materializePromise = (async () => {
        try {
          let fid = get().activeNote?.note.folder_id;
          if (!fid) {
            fid = await get().ensureInboxId();
          }
          const draftYear = get().activeNote?.note.year;
          const detail = await call<NoteDetail>("note_create", { folder_id: fid, year: draftYear });
          const draft = get().activeNote!;

          // note_create defaults an omitted month/day to today, same as newNote()'s draft
          // template (see that comment) — so in the common case (DateBadge untouched pre-save)
          // draft.note.month/day already equals detail.note.month/day and this stays false, no
          // extra round trip. Only diverges when setEventPrecision ran on the draft (DateBadge is
          // mounted for a draft note same as a saved one — no draft guard there), which is exactly
          // when the re-apply below is needed.
          const eventPrecisionChanged =
            draft.note.month !== detail.note.month || draft.note.day !== detail.note.day;

          detail.note.title = draft.note.title;
          detail.note.year = draft.note.year;
          detail.note.is_favorite = draft.note.is_favorite;
          detail.note.content_locked = draft.note.content_locked;
          detail.note.tag_names = draft.note.tag_names;
          detail.note.region = draft.note.region;
          detail.note.status = draft.note.status;
          detail.note.lat = draft.note.lat;
          detail.note.lng = draft.note.lng;
          detail.note.icon = draft.note.icon;
          detail.note.month = draft.note.month;
          detail.note.day = draft.note.day;
          detail.note.end_year = draft.note.end_year ?? null;
          detail.note.end_month = draft.note.end_month ?? null;
          detail.note.end_day = draft.note.end_day ?? null;
          detail.note.remind = draft.note.remind;
          detail.note.start_time = draft.note.start_time ?? null;
          detail.note.end_time = draft.note.end_time ?? null;
          detail.note.remind_offset_min = draft.note.remind_offset_min ?? null;
          detail.note.rrule = draft.note.rrule ?? null;
          let draftBody = draft.sections[0]?.body_md || "";
          // P0-2: 서버 노트가 생긴 뒤의 어떤 실패에서도 activeNote 를 서버본으로 갈아 끼우지 않는다 — selectNote 는
          // flushAll 을 불러 폰의 쓰기 줄(자기 자신을 기다림)을 교착시켰고, 빈 서버 본문으로 에디터를 다시 칠했다.
          // 대신 id 만 실노트로 바꾼 채(본문은 사용자가 친 글 그대로) 던지고, 다음 저장은 일반 경로(section_update)로 다시 보낸다.
          const commit = (state: "saving" | "failed") => {
            detail.sections[0].body_md = draftBody;
            set({
              activeNote: detail,
              activeDraft: false,
              savedState: state,
              activeBodyEmpty: isNoteBodyEmpty(detail.sections),
            });
            useTabsStore.getState().pushTab(detail.note.id);
          };
          seedSectionTokens(detail.sections);

          try {
            if (draftBody) {
              // D2②: 토큰 면제 — 방금 만든 섹션에 쓰기(계획서 V6). note_create 응답 토큰은 있지만 보내지 않는다:
              // 이 사이 같은 섹션의 자동 저장이 먼저 나가면 그게 토큰을 올려 여기가 CONFLICT 로 던진다.
              // 응답 토큰은 꼭 받아 둔다 — 안 그러면 다음 자동 저장이 note_create 시점 토큰으로 가서 자기 자신과 충돌한다.
              // 본문을 필드 호출보다 먼저 쓴다(글이 가장 중요) · 쓰는 동안 초안에 더 친 글이 있으면 따라잡는다.
              for (let i = 0; i < 3; i++) {
                const w = await call<SectionUpdateOutput>("section_update", { id: detail.sections[0].id, body_md: draftBody });
                setSectionToken(detail.sections[0].id, w?.section_updated_at);
                const latest = get().activeDraft ? (get().activeNote?.sections[0]?.body_md ?? draftBody) : draftBody;
                if (latest === draftBody) break;
                draftBody = latest;
              }
            }
            commit("saving"); // 본문이 서버에 닿은 뒤에야 실노트로 바꾼다 — "저장됨" 은 맨 끝에서
            const sendField = async (field: string, send: () => Promise<unknown>) => {
              const key = fieldFailureKey(detail.note.id, field);
              try {
                await send();
                clearSaveFailed(key);
              } catch {
                markSaveFailed(key, async () => {
                  await send();
                  clearSaveFailed(key);
                });
              }
            };
            if (draft.note.title !== "Untitled Note") {
              await sendField("title", () => call("note_update", { id: detail.note.id, title: draft.note.title }));
            }
            if (draft.note.tag_names.length > 0) {
              await sendField("tags", () => call("note_set_tags", { id: detail.note.id, tag_names: draft.note.tag_names }));
            }
            if (draft.note.region) {
              await sendField("region", () => call("note_set_region", { id: detail.note.id, region: draft.note.region }));
            }
            if (draft.note.lat != null || draft.note.lng != null) {
              await sendField("location", () =>
                call("note_set_location", {
                  id: detail.note.id,
                  lat: draft.note.lat,
                  lng: draft.note.lng,
                })
              );
            }
            if (draft.note.icon) {
              await sendField("icon", () => call("note_set_icon", { id: detail.note.id, icon: draft.note.icon }));
            }
            // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_precision/note_set_event_end/
            // note_set_schedule were deleted — one replacePrimaryDate call absorbs all three
            // (it always fetches+merges the note's current full row). `remind` keeps its own
            // separate note_update call (unaffected — that command still exists and already
            // bridges note_id -> position 0 for this one field, see repo/notes/mod.rs::update).
            const hasEnd =
              draft.note.end_year != null || draft.note.end_month != null || draft.note.end_day != null;
            const hasSchedule =
              draft.note.start_time != null ||
              draft.note.end_time != null ||
              draft.note.remind_offset_min != null ||
              draft.note.rrule != null;
            if (eventPrecisionChanged || hasEnd || hasSchedule) {
              await sendField("date", () =>
                replacePrimaryDate(detail.note.id, {
                  ...(eventPrecisionChanged ? { month: draft.note.month, day: draft.note.day } : {}),
                  ...(hasEnd
                    ? {
                        end_year: draft.note.end_year ?? null,
                        end_month: draft.note.end_month ?? null,
                        end_day: draft.note.end_day ?? null,
                      }
                    : {}),
                  ...(hasSchedule
                    ? {
                        start_time: draft.note.start_time ?? null,
                        end_time: draft.note.end_time ?? null,
                        remind_offset_min: draft.note.remind_offset_min ?? null,
                        rrule: draft.note.rrule ?? null,
                      }
                    : {}),
                })
              );
            }
            if (draft.note.remind) {
              await sendField("remind", () => call("note_update", { id: detail.note.id, remind: draft.note.remind }));
            }
            if (draft.note.status) {
              await sendField("status", () => call("note_set_status", { id: detail.note.id, status: draft.note.status }));
            }
            if (draft.note.is_favorite) {
              await sendField("favorite", () => call("note_toggle_favorite", { id: detail.note.id }));
            }
            if (draft.note.content_locked) {
              await sendField("content_locked", () => call("note_toggle_content_lock", { id: detail.note.id }));
            }
            if (noteHasSaveFailure(detail.note.id, detail.sections.map((s) => s.id))) {
              set({ savedState: "failed" });
            } else if (get().savedState === "saving") {
              set({ savedState: "saved" });
            }
            await get().loadTree();
            return detail.note.id;
          } catch (err) {
            if (get().activeDraft) {
              commit("failed");
              markSaveFailed(detail.sections[0].id);
            } else {
              set({ savedState: "failed" });
            }
            await get().loadTree();
            throw err;
          }
        } finally {
          materializePromise = null;
        }
      })();

      return materializePromise;
    },

    updateSectionBody: async (id, body_md) => {
      markSnapshotDirty();
      const s = get();
      if (s.activeDraft) {
        const n = s.activeNote!;
        const newSections = [...n.sections];
        newSections[0].body_md = body_md;
        set({ activeNote: { ...n, sections: newSections }, activeBodyEmpty: isNoteBodyEmpty(newSections) });
        if (body_md.trim().length > 0) {
          await get().ensureMaterialized();
        }
        return;
      }
      // activeBodyEmpty only — never patch activeNote.sections here. EditorPanel's note-load
      // effect calls editor.commands.setContent() on any new activeNote reference; doing that on
      // every 700ms autosave would reset the caret out from under whoever is still typing.
      const cur = get().activeNote;
      if (cur) {
        const nextSections = cur.sections.map((sec) => (sec.id === id ? { ...sec, body_md } : sec));
        // ponytail: cur.sections' OTHER (non-edited) entries are stale — this store never learns
        // a section's real body until this function is called for it, so a multi-section note
        // emptied one tab at a time won't flip activeBodyEmpty true until the section edited
        // *last* here happens to be the one that makes every entry read empty. Single-section
        // notes (the overwhelming case) are unaffected. Upgrade path if this bites: have
        // EditorPanel pass its bodyCacheRef (already holds every section's latest live body) in
        // here instead of reading only from the store's stale copy.
        set({ activeBodyEmpty: isNoteBodyEmpty(nextSections) });
      }
      // D2②: 같은 섹션의 저장은 줄을 세운다. 앞 저장이 진행 중일 때 뒤 저장이 같은 (낡은) 토큰을 들고
      // 나가면 앞 저장이 올린 토큰과 어긋나 자기 자신과 충돌한다 — 토큰은 보낼 차례가 왔을 때 읽는다.
      const run = (saveChains.get(id) ?? Promise.resolve()).then(() => sendSectionBody(id, body_md));
      saveChains.set(id, run);
      await run;
      if (saveChains.get(id) === run) saveChains.delete(id);
    },

    saveConflict: null,

    resolveSaveConflict: async (mode) => {
      const c = get().saveConflict;
      if (!c) return false;
      // 디바운스 대기분까지 게이트로 모은다 — 게이트가 열려 있으니 서버로는 안 나가고 본문만 쌓인다.
      await flushAll();
      const held = heldConflictBodies();
      if (mode === "copy") {
        const sections = get().activeNote?.sections ?? [];
        try {
          for (const [sectionId, body] of held) {
            const kind = sections.find((s) => s.id === sectionId)?.kind ?? "text";
            await call("section_create_with_body", {
              note_id: c.noteId,
              name: t("editor.conflict_copy_name"),
              body_md: body,
              kind,
            });
          }
        } catch {
          // call() 이 토스트했다. 사본이 없으면 다시 불러오지 않는다 — 내 본문의 유일한 사본이 게이트에 있다.
          // ponytail: 여러 섹션 중 일부만 복사된 뒤 실패하면 재시도가 앞 사본을 한 번 더 만든다(중복이지 유실 아님).
          return false;
        }
        const heldIds = held.map(([id]) => id);
        // 다시 읽기 전에 에디터 캐시를 비운다(게이트가 열려 있어 reloadActive 는 이 섹션들을 건너뛴다).
        runBodyCacheDiscardHooks(heldIds);
        // 게이트를 연 채로 다시 읽는다 — reloadActive 안의 flushAll 이 낡은 토큰으로 다시 보내지 않게
        // (폰 flush 는 실패 뒤 sec.body 를 되돌려 두므로 반드시 다시 보낸다). 다시 읽으면 토큰도 새로 seed.
        await get().reloadActive();
        // 한 번 더 — 마운트 때만 본문을 읽는 시트 편집기가 다시 읽은 서버본으로 다시 마운트되게.
        runBodyCacheDiscardHooks(heldIds);
        clearConflictBodies();
        set({ saveConflict: null, savedState: "saved" });
        // 내 글이 어디로 갔는지 알린다(감사 M-19) — 안 알리면 "내 글이 사라졌다"로 보인다.
        emitNotice(t("editor.conflict_copied", { name: t("editor.conflict_copy_name") }));
        return true;
      }
      let detail: NoteDetail;
      try {
        detail = await call<NoteDetail>("note_get", { id: c.noteId });
      } catch {
        return false; // call() 이 토스트했다. 충돌은 그대로.
      }
      // 토큰은 붙잡힌(충돌한) 섹션에만 새로 심는다(감사 M-10). 다른 섹션까지 심으면 본문 캐시는 옛것인 채
      // 토큰만 새것이 돼, 그 사이 상대가 고친 섹션을 나중에 치면 옛 본문이 새 토큰으로 통과해 상대 편집을 지운다.
      // 심지 않은 섹션은 낡은 토큰 그대로라 다음 저장이 정직하게 충돌한다.
      const heldIdSet = new Set(held.map(([id]) => id));
      seedSectionTokens(detail.sections.filter((s) => heldIdSet.has(s.id)));
      clearConflictBodies();
      set({ saveConflict: null });
      for (const [sectionId, body] of held) {
        await get().updateSectionBody(sectionId, body);
        // 저장이 통과했을 때만 본문 캐시를 맞춘다(탭 왕복 시 옛 본문으로 되돌아가지 않게).
        if (get().saveConflict === null && get().savedState !== "failed") patchSectionBodyCache(sectionId, body);
      }
      // 그 사이 또 다른 기기가 썼다면 다시 충돌 상태다(조용히 재시도하지 않는다).
      return get().saveConflict === null && get().savedState !== "failed";
    },

    applyPreset: async (bodyMd, title, landing = "auto") => {
      const s = get();
      if (s.activeNote && !s.activeDraft) {
        // Existing (materialized) note. Two shapes, decided by the SAME targetState PresetList
        // labels its rows with (stores/presets.ts) — so "what the list says will happen" and
        // "what happens" cannot drift. landing (manage 모달 "만들기") overrides the judgment:
        //   "new-section"          -> append a NEW section, targetState 무관.
        //   "new-note"             -> skip both branches below, fall through to the draft path —
        //                             제자리 적용은 manage 모달에 존재하지 않는다.
        //   "auto" (default)       -> ready (live editor empty) = in place onto sections[0],
        //                             otherwise = new section. The owner's rule: a preset click
        //                             must never be refused, and must never overwrite a body.
        // This is the store-level guard the old ponytail note asked for: sections[0] is now
        // unreachable for a non-empty note no matter which caller (PresetList row, AskAiModal
        // kind:"new", mobile capture) arrives here.
        // Calling newNote() in either branch would be wrong: activeDraft is false, so it
        // wouldn't no-op — it would deactivate this tab and open a brand new draft instead of
        // filling the note being shown. (The "new-note" landing is exactly the caller asking
        // FOR that deactivation — the fall-through below is the intended behavior there.)
        // ponytail: mobile never publishes targetState (only EditorPanel does), so it stays
        // "ready" there and mobile capture keeps its existing in-place behavior — correct today
        // (capture always starts from a fresh draft). If a mobile surface ever applies a preset
        // onto a note with content, give MobileNote the same publisher rather than a second gate.
        const wantSection =
          landing === "new-section" ||
          (landing === "auto" && usePresetsStore.getState().targetState !== "ready");
        if (wantSection) {
          if (bodyMd.trim()) {
            // Reuses the one pipeline that already creates a section and switches the editor to
            // it end-to-end (EditorPanel's registerSectionInserter) — same path applyDiagramPreset
            // (lib/presetBridge.ts) and every AI insert take. Dynamic import: aiSectionBridge
            // imports stores/notes, so a static one here would close an import cycle for a
            // branch that only runs on a click.
            const { insertAiSection } = await import("../lib/aiSectionBridge");
            // postProcess:false — a template skeleton has no AI-written content to infer
            // metadata from (same reasoning as applyDiagramPreset's own call).
            await insertAiSection(
              title?.trim() || t("presets.new_section_name"),
              bodyMd,
              s.activeNote.note.id,
              undefined,
              { postProcess: false },
            );
          }
          fillPresetTitle(s.activeNote.note.title, title);
          // null: the inserter already appended + switchSection'd (which repaints the editor) —
          // the caller must not double-sync, same contract as the fresh-draft path below.
          return null;
        }
        if (landing !== "new-note") {
          const secId = s.activeNote.sections[0]?.id ?? null;
          if (secId && bodyMd.trim()) {
            set({ savedState: "saving" });
            await get().updateSectionBody(secId, bodyMd);
          }
          fillPresetTitle(s.activeNote.note.title, title);
          return secId;
        }
        // landing "new-note" — 의도적 새 노트: 아래 fresh-draft 경로로 떨어진다(newNote() 가
        // 열린 노트의 탭을 닫고 새 드래프트를 연다 — 이 착지에서만 원하는 동작).
      }
      // No note open, or a draft already open — newNote() is a safe no-op in the latter case
      // (doesn't reset in-progress typing), and starts a fresh local-only draft in the former.
      await get().newNote();
      const an = get().activeNote;
      if (!an) return null;
      const secId = an.sections[0]?.id ?? null;
      if (secId && bodyMd.trim()) {
        set({ savedState: "saving" });
        await get().updateSectionBody(secId, bodyMd);
      }
      fillPresetTitle(an.note.title, title);
      // null — the fresh-draft path changes activeNote's identity (newNote()/updateSectionBody
      // both set() a new object), so EditorPanel's note-load effect already repaints the editor,
      // same as any other note switch. The caller must not double-sync.
      return null;
    },

    selectNote: async (id) => {
      get().discardDraft();
      if (get().loadingNoteId === id) return;
      // Set before the flushAll() await (not after) — closes the window where EditorPanel's
      // eager empty-state draft effect (fires when activeNote/loadingNoteId/activeTabId are all
      // null/false, e.g. right after discardDraft() above) could otherwise race this switch and
      // spin up a competing draft while this note is still loading.
      set({ loadingNoteId: id });
      await flushAll();
      const seq = ++selectNoteSeq;
      try {
        const detail = await call<NoteDetail>("note_get", { id });
        if (seq !== selectNoteSeq) return;
        dropConflictOnLeave(id);
        seedSectionTokens(detail.sections);
        set({
          activeNote: detail,
          activeDraft: false,
          loadingNoteId: null,
          savedState: "saved",
          activeBodyEmpty: isNoteBodyEmpty(detail.sections),
        });
        // Bug fix: id-only opens (dashboard board/calendar/timeline/map, search, note:// links)
        // never populate noteIndex — only loadTree()'s tree window does. Once this tab stops
        // being activeNote, TabBar's titleById falls back to noteIndex.get(id), misses, and
        // renders "Untitled note". detail.note IS a NoteSummary (see NoteDetail), so this is a
        // free, instant first-paint fix; TabBar's ensureNoteSummaries effect is the durable
        // backstop for when loadTree() later wholesale-replaces noteIndex.
        get().mergeNoteSummaries([detail.note]);
        useTabsStore.getState().pushTab(id);
      } catch {
        if (seq !== selectNoteSeq) return;
        set({ loadingNoteId: null });
      }
    },

    appendActiveSection: (noteId, section) => {
      const n = get().activeNote;
      if (!n || n.note.id !== noteId) return;
      const sections = [...n.sections, section];
      seedSectionTokens([section]);
      // 새 섹션이 실제 내용을 가질 수 있다(AI 삽입) — activeBodyEmpty 를 note_get 없이 맞춘다.
      set({ activeNote: { ...n, sections }, activeBodyEmpty: isNoteBodyEmpty(sections) });
    },

    reloadActive: async (opts) => {
      const id = get().activeNote?.note.id;
      if (!id) return;
      try {
        // Flush pending edits (the editor's 700ms autosave debounce, registerFlush) before
        // re-fetching. Every caller of reloadActive() inserts something (an attachment, an
        // editor node via editor.chain()...insert…) and then reloads to pick it up — without
        // this, note_get can race the still-pending debounce and return the PRE-insert body,
        // which the note-load effect (EditorPanel.tsx) then repaints over the live doc,
        // silently reverting whatever was just inserted into the editor. See EditorPanel.tsx's
        // clipboard-image-paste path for the concrete repro this closes.
        await flushAll();
        const before = get().activeNote?.attachments;
        const detail = await call<NoteDetail>("note_get", { id });
        // D2②: 서버에서 바뀐 섹션(토큰이 움직였다)은 에디터 캐시를 버린다 — 안 그러면 낡은 본문이 다시
        // 그려지고 방금 받은 새 토큰으로 다음 타이핑이 원격 편집을 덮는다. 위 flushAll 로 이 기기의 미저장
        // 편집은 이미 저장됐거나(토큰이 따라 움직였다 → 여기 안 걸린다) 충돌 게이트에 있다(제외) — 버려지는
        // 캐시는 서버가 이미 넘어선 옛 본문뿐이다. 토큰을 모르던 섹션은 건드리지 않는다(기존 동작).
        const rewritten = new Set(opts?.rewritten ?? []);
        const moved = detail.sections
          .filter((s) => {
            if (isSectionGated(s.id)) return false;
            if (rewritten.has(s.id)) return true;
            const known = getSectionToken(s.id);
            return !!s.updated_at && !!known && known !== s.updated_at;
          })
          .map((s) => s.id);
        if (moved.length) runBodyCacheDiscardHooks(moved);
        seedSectionTokens(detail.sections);
        set({ activeNote: detail, activeBodyEmpty: isNoteBodyEmpty(detail.sections) });
        // Callers that add an attachment reach for reloadActive rather than the heavier
        // selectNote refresh, and used to leave attachmentRevision untouched — so
        // useAttachmentThumbs never refetched and a freshly dropped image sat on a
        // placeholder until something else remounted it. Bump here, where the list is
        // actually replaced, so no call site has to remember. Section-only reloads
        // (toolbar, AI) leave the set unchanged and still cost nothing.
        if (!sameAttachmentIds(before, detail.attachments)) {
          get().bumpAttachmentRevision();
        }
      } catch {
        // ignore
      }
    },

    newNote: async (folderId?: string) => {
      // "+"/empty-state path (no explicit folderId) re-entering an already-open draft is a
      // no-op — clicking + twice (or the Ctrl+N shortcut while the draft page is already up)
      // must not blow away whatever the user already typed into the untitled draft.
      // Folder-targeted creation (explicit folderId, e.g. the tree row's hover "+") always
      // proceeds — see below, it materializes immediately and isn't "the draft page".
      if (!folderId && get().activeDraft) return;

      await flushAll();
      dropConflictOnLeave(null);
      get().discardDraft();

      // Ambiguous entry (no folderId) must not await ensureInboxId() here — this is also the
      // path the empty-state eager-draft effect (EditorPanel) takes on every "0 tabs" render,
      // and blocking on that IPC (first boot: settings_get_all, maybe folder_create) would leave
      // the editor rendering nothing for a beat. ensureMaterialized() already resolves a missing
      // folder_id lazily (see its own `if (!fid) fid = await ensureInboxId()`), so an empty
      // string here is fine — it's never sent to note_create as-is.
      const targetFolderId = folderId ?? get().inboxId ?? "";
      const now = new Date();
      const nowIso = now.toISOString();

      const draftDetail: NoteDetail = {
        note: {
          id: "__draft__",
          folder_id: targetFolderId,
          title: "Untitled Note",
          year: now.getFullYear(),
          is_favorite: false,
          content_locked: false,
          exported_at: null,
          has_image: false,
          tag_names: [],
          region: null,
          status: null,
          icon: null,
          lat: null,
          lng: null,
          created_at: nowIso,
          updated_at: nowIso,
          // Full today's date, not year-only — note_create defaults an omitted month/day to
          // today too (see YearBadge's comment), so the draft preview and the materialized
          // result read the same date before save. If DateBadge changes it while still a draft
          // (no draft guard there), ensureMaterialized's eventPrecisionChanged check re-applies
          // the picked value via note_set_event_precision — see that function's comment.
          month: now.getMonth() + 1,
          day: now.getDate(),
        },
        sections: [
          {
            id: "draft_sec",
            name: useSettingsStore.getState().newNoteSectionName?.trim() || t("note.default_section_name"),
            body_md: "",
            position: 0,
            kind: "text",
          },
        ],
        sources: [],
        attachments: [],
      };
      set({
        activeNote: draftDetail,
        activeDraft: true,
        savedState: "saved",
        activeBodyEmpty: isNoteBodyEmpty(draftDetail.sections),
      });

      if (folderId) {
        // Explicit folder target (tree row's hover "+") — not the ambiguous "+"/empty-state
        // entry point, so it keeps the old immediate-creation behavior instead of waiting for
        // a materialize trigger. fid is already set on the draft above, so this skips
        // ensureInboxId's IPC.
        await get().ensureMaterialized();
        return;
      }

      // Ambiguous entry ("+" tab button, sidebar button, Ctrl+N, or the auto-created draft from
      // typing into the empty state) — deactivate whatever tab was showing (if any) without
      // closing it, so the tab bar shows no active tab while the draft page is up. Guarded so
      // the (very common) case where there was no active tab to begin with skips the settings
      // IPC round-trip.
      if (useTabsStore.getState().activeTabId !== null) {
        void useTabsStore.getState().setActiveTab(null);
      }
    },

    // ponytail: NOT folded into patchActiveNote — this one awaits call() before touching state at
    // all (no optimistic set, so nothing to roll back), and a rejection propagates uncaught
    // instead of being swallowed into savedState:"failed". Genuinely different shape from
    // setStatus/setRegion/etc below; see notes.smoke.test.ts's "toggleFavorite (non-draft)"
    // describe for the asymmetry this preserves.
    toggleFavorite: async () => {
      const n = get().activeNote;
      if (!n) return;
      if (get().activeDraft) {
        set({ activeNote: { ...n, note: { ...n.note, is_favorite: !n.note.is_favorite } } });
        await get().ensureMaterialized();
        return;
      }
      const r = await call<{ is_favorite: boolean }>("note_toggle_favorite", { id: n.note.id });
      set({ activeNote: { ...n, note: { ...n.note, is_favorite: r.is_favorite } } });
      get().patchNoteSummary(n.note.id, { is_favorite: r.is_favorite });
    },

    // toggleFavorite와 동일한 draft/materialized 분기 이유 — 위 주석 참고.
    toggleContentLock: async () => {
      const n = get().activeNote;
      if (!n) return;
      if (get().activeDraft) {
        set({ activeNote: { ...n, note: { ...n.note, content_locked: !n.note.content_locked } } });
        await get().ensureMaterialized();
        return;
      }
      const r = await call<{ content_locked: boolean }>("note_toggle_content_lock", { id: n.note.id });
      set({ activeNote: { ...n, note: { ...n.note, content_locked: r.content_locked } } });
      get().patchNoteSummary(n.note.id, { content_locked: r.content_locked });
    },

    setTags: (names) =>
      patchActiveNote({ tag_names: names }, "note_set_tags", {
        onSuccess: () => void get().refreshTagCounts(),
      }),

    // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_precision/note_set_event_end/
    // note_set_schedule were deleted — replacePrimaryDate (lib/primaryDate.ts) is the only
    // remaining path to write these fields onto the primary (position 0) row without a backend
    // change (no command exposes that row's own note_dates.id — see that file's header).
    setEventPrecision: (month, day) =>
      patchActiveNote({ month, day }, (id, patch) => replacePrimaryDate(id, patch), {
        notice: "note.save_event_precision_failed",
      }),

    setEventEnd: (end_year, end_month, end_day) =>
      patchActiveNote(
        { end_year, end_month, end_day },
        (id, patch) => replacePrimaryDate(id, patch),
        {
          // end_year/end_month/end_day are optional on NoteSummary — normalize missing to null
          // both when reading the pre-edit values (rollback) and the server echo, same as before.
          fields: (src) => ({
            end_year: src.end_year ?? null,
            end_month: src.end_month ?? null,
            end_day: src.end_day ?? null,
          }),
          notice: "note.save_event_end_failed",
        }
      ),

    setRemind: (remind) => patchActiveNote({ remind }, "note_update"),

    setSchedule: (patch) =>
      patchActiveNote(patch, (id, p) => replacePrimaryDate(id, p), {
        notice: "note.save_schedule_failed",
      }),

    setRegion: (region) => patchActiveNote({ region }, "note_set_region"),

    setLocation: (lat, lng) => patchActiveNote({ lat, lng }, "note_set_location"),

    setStatus: (status) => patchActiveNote({ status }, "note_set_status"),

    setIcon: (icon) => patchActiveNote({ icon }, "note_set_icon"),

    setTitle: (title) => {
      const n = get().activeNote;
      if (!n) return;
      // 내용잠금: patchActiveNote의 8개 세터와 달리 디바운스/드래프트 분기 때문에 손코딩돼 있어
      // (파일 상단 주석) 같은 가드를 여기 따로 넣는다.
      if (n.note.content_locked) {
        emitNotice(t("editor.content_locked_tooltip"));
        return;
      }
      if (get().activeDraft) {
        set({ activeNote: { ...n, note: { ...n.note, title } } });
        // .trim() (not just !== "Untitled Note") — matches updateSectionBody's body_md.trim()
        // check below: typing only whitespace into the title must not materialize an
        // effectively-empty note (§ draft leaves no DB trace when nothing real was entered).
        if (title.trim() && title !== "Untitled Note") { get().ensureMaterialized(); }
        return;
      }
      set({
        activeNote: { ...n, note: { ...n.note, title } },
        savedState: "saving",
      });
      get().patchNoteSummary(n.note.id, { title });
      scheduleTitleFlush(title, n.note.id);
    },

    setNoteYear: (year) => {
      const n = get().activeNote;
      if (!n) return;
      // 내용잠금: setTitle과 같은 이유(디바운스 분기)로 손코딩된 별도 가드.
      if (n.note.content_locked) {
        emitNotice(t("editor.content_locked_tooltip"));
        return;
      }
      if (get().activeDraft) {
        set({ activeNote: { ...n, note: { ...n.note, year } } });
        get().ensureMaterialized();
        return;
      }
      set({
        activeNote: { ...n, note: { ...n.note, year } },
        savedState: "saving",
      });
      get().patchNoteSummary(n.note.id, { year });
      scheduleYearFlush(year, n.note.id);
    },
  };
};
