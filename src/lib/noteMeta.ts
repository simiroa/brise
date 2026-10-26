/**
 * 열린 노트의 메타 조회 — 지역·날짜·썸네일·관련 노트·숨김 수. 소비자마다 따로 IPC 를 쏘던 것을
 * lib/noteFetchCache.ts 위에서 (노트 id, 버전)으로 나눠 쓴다. **버전 문자열은 자원마다 여기 한 곳에서만
 * 만든다** — 소비자끼리 버전이 다르면 캐시가 노트당 최신 한 개라 서로를 밀어내며 다시 읽는다.
 *
 * 버전 축:
 * - 열기 세대(getNoteOpenGen) — selectNote 마다 +1. 다른 노트 본문에 달린 값도 열 때마다 새로 읽힌다.
 * - attachmentRevision — 첨부·지역 경유지 쓰기가 공유하는 카운터.
 * - noteQueryVersion — 필드 쓰기(대표 지역 포함)·지도 마커 이동·원격 쓰기(loadTree)의 공통 신호.
 * - 호출자 로컬 키 — 그 자원의 유일한 소비자가 들고 있는 refresh 카운터(관련 노트 제외/복원 등).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { call, callSilent } from "./invoke";
import { useNotesStore } from "../stores/notes";
import { useNoteQueryVersion } from "./noteQuery";
import {
  createNoteFetchCache,
  getNoteOpenGen,
  markNoteOpened,
  subscribeNoteOpenGen,
  type NoteFetchCache,
} from "./noteFetchCache";
import type { AttachmentThumbsOutput, NoteDate, NoteRegion, NoteSummary } from "./commands.gen";

const DRAFT_ID = "__draft__";

/* ── 열기 추적 ── selectNote 가 loadingNoteId 를 세우는 순간이 "열기"다(같은 노트 탭을 다시 눌러도 열기). */
let openTracking = false;
function ensureOpenTracking(): void {
  if (openTracking) return;
  openTracking = true;
  // 일부 테스트는 notes 스토어를 subscribe 없는 모양으로 목한다.
  if (typeof useNotesStore?.subscribe !== "function") return;
  useNotesStore.subscribe((s, prev) => {
    if (s.loadingNoteId && s.loadingNoteId !== prev.loadingNoteId) markNoteOpened(s.loadingNoteId);
  });
}

export function useNoteOpenGen(noteId: string | null | undefined): number {
  ensureOpenTracking();
  return useSyncExternalStore(
    subscribeNoteOpenGen,
    () => getNoteOpenGen(noteId),
    () => getNoteOpenGen(noteId),
  );
}

/**
 * 캐시에서 (noteId, version) 값을 읽는다. 끝난 값이 있으면 첫 렌더부터 그 값(IPC 없음), 없으면 한 번
 * 조회한다 — 같은 키를 동시에 묻는 다른 소비자와 promise 를 나눈다. 새 키를 기다리는 동안은 직전에
 * 보여주던 값을 유지한다(노트 전환 때 칩이 빈 값으로 깜빡이지 않게 — 예전 각 effect 의 동작).
 * 실패는 `empty` 로 떨어진다(실패 기록은 fetch 가 쓴 call()/callSilent() 가 남긴다).
 */
export function useNoteFetch<T>(
  cache: NoteFetchCache<T>,
  noteId: string | null | undefined,
  version: string,
  empty: T,
): { data: T; loaded: boolean } {
  const id = noteId && noteId !== DRAFT_ID ? noteId : null;
  const [settled, setSettled] = useState<{ id: string; version: string; data: T } | null>(null);
  const lastRef = useRef<T>(empty);

  useEffect(() => {
    if (!id || cache.peek(id, version) !== undefined) return;
    let cancelled = false;
    cache.get(id, version).then(
      (data) => {
        if (!cancelled) setSettled({ id, version, data });
      },
      () => {
        if (!cancelled) setSettled({ id, version, data: empty });
      },
    );
    return () => {
      cancelled = true;
    };
    // empty 는 호출자의 모듈 상수다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, id, version]);

  let out: { data: T; loaded: boolean };
  if (!id) {
    out = { data: empty, loaded: false };
  } else {
    const hit = cache.peek(id, version);
    if (hit !== undefined) out = { data: hit, loaded: true };
    else if (settled && settled.id === id && settled.version === version) out = { data: settled.data, loaded: true };
    else out = { data: lastRef.current, loaded: false };
  }
  lastRef.current = out.data;
  return out;
}

/* ── 지역(경유지 목록) ── 제목줄 칩·지역 감지·첨부 바·지역 팝오버·지도 패널이 같은 값을 쓴다. */
const EMPTY_REGIONS: NoteRegion[] = [];
export const noteRegionsCache = createNoteFetchCache<NoteRegion[]>(async (noteId) => {
  const res = await call<{ regions: NoteRegion[] }>("note_regions_list", { note_id: noteId });
  return res?.regions ?? EMPTY_REGIONS;
});

export function useNoteRegionsVersion(noteId: string | null | undefined): string {
  const gen = useNoteOpenGen(noteId);
  const attachmentRevision = useNotesStore((s) => s.attachmentRevision);
  const noteQueryVersion = useNoteQueryVersion();
  return `${gen}:${attachmentRevision}:${noteQueryVersion}`;
}

export function useNoteRegions(noteId: string | null | undefined): { regions: NoteRegion[]; loaded: boolean } {
  const version = useNoteRegionsVersion(noteId);
  const { data, loaded } = useNoteFetch(noteRegionsCache, noteId, version, EMPTY_REGIONS);
  return { regions: data, loaded };
}

/* ── 날짜(대표 포함 전체 행) ── 닫힌 날짜 칩의 +N. `localKey` = 팝오버 안 편집 뒤 올리는 카운터. */
const EMPTY_DATES: NoteDate[] = [];
export const noteDatesCache = createNoteFetchCache<NoteDate[]>(async (noteId) => {
  const res = await call<{ dates: NoteDate[] }>("note_dates_list", { note_id: noteId });
  return res?.dates ?? EMPTY_DATES;
});

export function useNoteDates(noteId: string | null | undefined, localKey: number): NoteDate[] {
  const gen = useNoteOpenGen(noteId);
  return useNoteFetch(noteDatesCache, noteId, `${gen}:${localKey}`, EMPTY_DATES).data;
}

/* ── 첨부 썸네일 ── attachment.id → 썸네일 rel_path. */
export type ThumbsMap = Map<string, string>;
const EMPTY_THUMBS: ThumbsMap = new Map();
export const attachmentThumbsCache = createNoteFetchCache<ThumbsMap>(async (noteId) => {
  const res = await callSilent<AttachmentThumbsOutput>("attachment_thumbs", { note_id: noteId });
  const map: ThumbsMap = new Map();
  if (res && Array.isArray(res.thumbs)) {
    for (const item of res.thumbs) {
      if (item.id && item.rel_path) map.set(item.id, item.rel_path);
    }
  }
  return map;
});

export function useNoteThumbs(noteId: string | null | undefined): ThumbsMap {
  const gen = useNoteOpenGen(noteId);
  const attachmentRevision = useNotesStore((s) => s.attachmentRevision);
  return useNoteFetch(attachmentThumbsCache, noteId, `${gen}:${attachmentRevision}`, EMPTY_THUMBS).data;
}

/* ── 관련 노트(자동) · 숨긴 관련 수 ── 첨부 바 하나만 쓴다. `refreshKey` = 제외/복원 뒤 올리는 카운터. */
const EMPTY_RELATED: NoteSummary[] = [];
export const noteRelatedCache = createNoteFetchCache<NoteSummary[]>(async (noteId) => {
  const r = await callSilent<{ notes: NoteSummary[] }>("note_related", { id: noteId });
  return r?.notes ?? EMPTY_RELATED;
});

export function useNoteRelated(noteId: string | null | undefined, refreshKey: number): NoteSummary[] {
  const gen = useNoteOpenGen(noteId);
  return useNoteFetch(noteRelatedCache, noteId, `${gen}:${refreshKey}`, EMPTY_RELATED).data;
}

export const noteRelatedHiddenCountCache = createNoteFetchCache<number>(async (noteId) => {
  const res = await callSilent<{ count: number }>("note_related_hidden_count", { id: noteId });
  return res?.count ?? 0;
});

export function useNoteRelatedHiddenCount(noteId: string | null | undefined, refreshKey: number): number {
  const gen = useNoteOpenGen(noteId);
  return useNoteFetch(noteRelatedHiddenCountCache, noteId, `${gen}:${refreshKey}`, 0).data;
}
