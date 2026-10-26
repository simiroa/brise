// D2② W2: 섹션 버전 토큰(`sections.updated_at`) 보관소 — 폰·데스크톱이 같은 스토어
// (`stores/notesActive.ts::updateSectionBody`)로 저장하므로 토큰도 여기 한 곳.
//
// `activeNote` **밖에** 둔다: `activeNote` 참조가 바뀌면 에디터 note-load effect 가 setContent 로
// 캐럿을 튀긴다(notesActive.ts updateSectionBody 주석). 토큰은 저장마다 바뀌므로 거기 넣을 수 없다.
//
// 규칙: 노트를 읽어 들이는 곳(note_get)은 seed, 이 클라이언트의 섹션 쓰기 응답
// (`section_update`·`sheet_set_cells` 의 `section_updated_at`)은 set. 노트의 `updated_at` 은
// 토큰이 아니다(다른 쓰기에도 오른다). 모르는 섹션은 토큰 없이 보낸다 = 기존 LWW.
import { callSilent } from "./invoke";
import type { NoteDetail } from "./commands.gen";

const tokens = new Map<string, string>();

/** 노트를 읽은 결과로 토큰을 갈아 끼운다(남아 있던 낡은 값은 덮인다). 토큰이 없는 섹션(V24 이전
 *  행)은 지운다 — 낡은 값을 보내 거짓 충돌을 내느니 생략(LWW)이 낫다. */
export function seedSectionTokens(sections: ReadonlyArray<{ id: string; updated_at?: string | null }>): void {
  for (const s of sections) {
    if (s.updated_at) tokens.set(s.id, s.updated_at);
    else tokens.delete(s.id);
    goneSections.delete(s.id);
  }
}

export const getSectionToken = (id: string): string | undefined => tokens.get(id);

export function setSectionToken(id: string, token: string | null | undefined): void {
  if (token) tokens.set(id, token);
}

/** 이 섹션을 다음 seed 까지 토큰 없이 보낸다(휴지통 노트에 쓰기 — notesActive.ts sendSectionBody). */
export const forgetSectionToken = (id: string): void => {
  tokens.delete(id);
};

/**
 * 정렬(`section_reorder`)은 노트의 **모든** 섹션 `updated_at` 을 올리는데 응답은 `{ok}` 뿐이다.
 * 보내기 전에 토큰을 버리고(그 사이 자동 저장은 토큰 없이 = LWW, 자기 충돌 없음) 끝나면 note_get 으로
 * 토큰만 다시 읽는다(activeNote 는 건드리지 않는다).
 * ponytail: 다시 읽은 토큰은 그 사이 다른 기기가 쓴 본문까지 "본 것"으로 친다 — 정렬과 원격 편집이
 * 몇백 ms 안에 겹치면 그 원격 편집은 다음 자동 저장에 덮인다(지금의 LWW 와 같은 수준). 정렬 응답이
 * 섹션별 새 토큰을 돌려주게 되면 그걸로 set 하고 이 재조회를 지운다.
 */
export async function withSectionTokenRefresh<T>(
  noteId: string,
  sectionIds: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  for (const id of sectionIds) tokens.delete(id);
  try {
    return await run();
  } finally {
    try {
      const detail = await callSilent<NoteDetail>("note_get", { id: noteId });
      seedSectionTokens(detail.sections);
    } catch {
      // callSilent 가 진단에 남겼다. 토큰 없이 보내는 LWW 로 남을 뿐 쓰기는 막히지 않는다.
    }
  }
}

// ── 충돌 게이트 ──────────────────────────────────────────────────────────────
// CONFLICT 를 받은 섹션은 해결될 때까지 서버에 보내지 않는다(조용한 재시도 금지 + call() 이 700ms
// 마다 토스트하지 않게). 그 사이 들어온 최신 본문은 여기 쌓인다 — flushAll() 뒤에는 이 기기의
// 마지막 편집이 반드시 여기 있으므로, "내 글 복사"는 에디터 ref 를 거치지 않고 이 값을 쓴다.
// 폰은 섹션을 옮기면 에디터가 다른 섹션을 그리므로 이게 그 본문의 유일한 사본이다.
const conflictBodies = new Map<string, string>();
// 토큰을 보낸 쓰기가 NOT_FOUND(휴지통 노트·사라진 섹션) — 다시 보내도 같은 답이라 토스트만 반복된다.
// 다음 seed(노트 다시 읽기)까지 보내지 않는다.
const goneSections = new Set<string>();

export const isSectionGated = (id: string): boolean => conflictBodies.has(id) || goneSections.has(id);
export const hasConflictBody = (id: string): boolean => conflictBodies.has(id);
export const holdConflictBody = (id: string, body: string): void => {
  conflictBodies.set(id, body);
};
export const markSectionGone = (id: string): void => {
  goneSections.add(id);
};
export const heldConflictBodies = (): Array<[string, string]> => [...conflictBodies.entries()];
export const clearConflictBodies = (): void => conflictBodies.clear();

// 데스크톱 EditorPanel 의 bodyCacheRef 는 노트를 다시 읽어도 캐시를 먼저 칠한다 — 서버에서 바뀐
// 섹션(토큰이 움직였다)의 캐시를 비우지 않으면 낡은 본문이 서버본 위에 다시 그려지고, 새 토큰을 받은
// 다음 타이핑이 원격 편집을 그대로 덮는다(토큰이 있어도 못 막는다). reloadActive 와 "내 글 복사" 가
// 부른다. sectionWindows.ts::registerSectionReturnedHook 과 같은 모양. 시트 편집기는 마운트 때만 본문을
// 읽으므로 EditorPanel 이 이 신호로 다시 마운트한다.
const discardHooks = new Set<(sectionId: string) => void>();
export function registerBodyCacheDiscardHook(fn: (sectionId: string) => void): () => void {
  discardHooks.add(fn);
  return () => discardHooks.delete(fn);
}
export function runBodyCacheDiscardHooks(sectionIds: readonly string[]): void {
  for (const id of sectionIds) for (const fn of discardHooks) fn(id);
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function __resetSectionTokens(): void {
  tokens.clear();
  conflictBodies.clear();
  goneSections.clear();
}
