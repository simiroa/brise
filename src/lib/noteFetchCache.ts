/**
 * 노트 단위 조회(지역·날짜·관련 노트·썸네일…)를 **여러 소비자가 한 번의 IPC 로 나눠 쓰게** 하는 캐시.
 *
 * 노트 하나를 열면 제목줄 지역 칩·지역 감지 훅·첨부 바가 같은 `note_regions_list` 를 각자 불러
 * 열 때마다 3번 나갔다(StrictMode 개발 빌드에선 6번). 각 소비자는 이제 (노트 id, 버전 문자열)로
 * 이 캐시에 묻고, 같은 키면 진행 중 promise 든 끝난 값이든 그대로 받는다.
 *
 * - 노트마다 **최신 버전 한 개**만 둔다. 버전이 바뀌면(쓰기·노트 다시 열기) 그 노트의 이전 값은 버린다
 *   — 같은 자원의 소비자들은 반드시 같은 버전 문자열을 써야 한다(lib/noteMeta.ts 가 한 곳에서 만든다).
 * - 실패는 캐시하지 않는다 — 다음 소비자가 다시 시도한다.
 * - 이 모듈은 스토어·invoke 를 import 하지 않는다(테스트 setup 이 리셋만 하려고 부른다).
 */

export interface NoteFetchCache<T> {
  /** (id, version) 이 같으면 진행 중이든 끝났든 같은 promise. */
  get(noteId: string, version: string): Promise<T>;
  /** 끝난 값이 있으면 동기로 돌려준다(첫 렌더를 빈 값으로 깜빡이지 않게). */
  peek(noteId: string, version: string): T | undefined;
  clear(): void;
}

const registry = new Set<{ clear(): void }>();

export function createNoteFetchCache<T>(fetch: (noteId: string) => Promise<T>, max = 20): NoteFetchCache<T> {
  type Entry = { version: string; promise: Promise<T>; settled?: { value: T } };
  const entries = new Map<string, Entry>();
  const cache: NoteFetchCache<T> = {
    get(noteId, version) {
      const hit = entries.get(noteId);
      if (hit && hit.version === version) {
        entries.delete(noteId);
        entries.set(noteId, hit); // LRU: 최근 사용을 맨 뒤로
        return hit.promise;
      }
      const promise = fetch(noteId);
      const entry: Entry = { version, promise };
      entries.delete(noteId);
      entries.set(noteId, entry);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      promise.then(
        (value) => {
          if (entries.get(noteId) === entry) entry.settled = { value };
        },
        () => {
          // 실패 기록은 fetch 가 쓴 call()/callSilent() 가 이미 남겼다 — 여기선 재시도할 수 있게 비우기만.
          if (entries.get(noteId) === entry) entries.delete(noteId);
        },
      );
      return promise;
    },
    peek(noteId, version) {
      const hit = entries.get(noteId);
      return hit && hit.version === version ? hit.settled?.value : undefined;
    },
    clear() {
      entries.clear();
    },
  };
  registry.add(cache);
  return cache;
}

/* ── 노트 "열기" 세대 ──
 * 관련 노트·숨김 수처럼 **다른 노트의 본문**에 따라 바뀌는 값은 이 노트 쪽 변경 신호가 없다. 그래서
 * 노트를 열 때마다(selectNote) 세대를 올려 "열 때마다 한 번은 새로 읽는다"를 지킨다. 같은 열기 안의
 * 여러 소비자·재마운트(집중 모드 토글, 대시보드를 거쳐 오는 동안 잠깐 보이는 이전 노트)는 캐시를 나눈다. */
const openGen = new Map<string, number>();
const genListeners = new Set<() => void>();

export function markNoteOpened(noteId: string): void {
  openGen.set(noteId, (openGen.get(noteId) ?? 0) + 1);
  for (const l of genListeners) l();
}

export function getNoteOpenGen(noteId: string | null | undefined): number {
  return noteId ? (openGen.get(noteId) ?? 0) : 0;
}

export function subscribeNoteOpenGen(onChange: () => void): () => void {
  genListeners.add(onChange);
  return () => genListeners.delete(onChange);
}

/** 테스트 전용 — 모듈 스코프 캐시가 테스트 사이로 새지 않게(src/test/setup.ts). */
export function resetNoteFetchCaches(): void {
  for (const c of registry) c.clear();
  openGen.clear();
}
