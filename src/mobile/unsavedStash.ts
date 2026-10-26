import { reportFallback } from "../lib/diag";

/**
 * 폰의 "저장 못 한 글" 보관함 — [그래도 나가기] 가 본문을 화면과 함께 버리기 전에 이 기기에 한 번 적어 둔다.
 *
 * 왜 클립보드가 아닌가: 폰은 http://100.x 비보안 컨텍스트라 navigator.clipboard 가 없다. 예전 [그래도 나가기]는
 * 복사에 실패하면 나가지 못하게 막았으므로 서버가 안 되는 날엔 글을 지키면서 나갈 길이 아예 없었다.
 *
 * 왜 localStorage 인가(IndexedDB 아님): setItem 이 동기라 `proceed()` 보다 먼저 쓰기가 끝나 있다는 것이 호출 순서만으로
 * 보장되고, 테스트가 jsdom 에서 그대로 돈다(이 저장소엔 fake-indexeddb 가 없다 — voiceChunkStore 주석 참조).
 * 셸은 domStorageEnabled 이고 ProxyServer 가 포트를 고정해 origin(= 이 저장소)이 재시작을 넘어 같다.
 *
 * 한 키에 JSON 배열 한 덩이. 모든 쓰기는 배열을 통째로 setItem 한 번 — 던지면(용량·차단) 아무것도 안 바뀐 것이고,
 * 쓴 뒤 다시 읽어 같은지 본다(setItem 이 조용히 무시되는 webview 가 있다). 쓰기 실패는 false 로 알린다.
 * 진단 로그에는 코드·개수만 — 본문·섹션 이름은 절대 넣지 않는다.
 *
 * ponytail: 이 노트북(DB)의 노트가 지워졌거나 다른 노트북으로 바뀐 뒤의 보관본은 그 노트를 다시 열 일이 없어 안 보인다.
 * 상한(MAX_STASHES)이 쌓임을 막을 뿐이다. 부팅 시 고아 보관본을 띄우려면 MobileApp 에서 listStashes() 를 쓰는
 * 배너를 달아야 한다.
 */
export type StashKind = "text" | "diagram" | "sheet";

export interface UnsavedStash {
  /** 항목 고유 id — 지우는 키는 항상 이것이다(노트 id 로 지우면 같은 노트의 다른 보관본까지 사라진다). */
  id: string;
  /** = 노트(기존 내부 식별자는 note). 캡처 초안이면 "__draft__". */
  noteId: string;
  sectionId: string;
  sectionName: string;
  kind: StashKind;
  bodyMd: string;
  /** ISO-8601. */
  savedAt: string;
}

export type NewUnsavedStash = Omit<UnsavedStash, "id" | "savedAt">;

/** Storage 의 일부만 — 테스트가 던지는 저장소를 넣을 수 있게. */
export type StashStorage = Pick<Storage, "getItem" | "setItem">;

const KEY = "brise.unsavedStash.v1";
/** 보관본 상한. 넘으면 가장 오래된 것부터 버린다(reportFallback 으로 개수만 남긴다). */
export const MAX_STASHES = 20;

function defaultStorage(): StashStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // silent-ok: 저장소 접근 자체가 막힘 — 호출자가 false/[] 로 받아 나가기 차단·복구 없음으로 처리한다
  }
}

function isStash(v: unknown): v is UnsavedStash {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.noteId === "string" &&
    typeof s.sectionId === "string" &&
    typeof s.sectionName === "string" &&
    (s.kind === "text" || s.kind === "diagram" || s.kind === "sheet") &&
    typeof s.bodyMd === "string" &&
    typeof s.savedAt === "string"
  );
}

/** 오래된 것 → 새 것 순(쓰는 쪽이 항상 끝에 붙인다). 읽기 실패·깨진 JSON 은 [] — 기록만 남긴다. */
export function listStashes(storage: StashStorage | null = defaultStorage()): UnsavedStash[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    reportFallback("mobile-save", "stash_read_failed");
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.filter(isStash);
  } catch {
    reportFallback("mobile-save", "stash_corrupt");
    return [];
  }
}

/** 이 노트의 보관본, 최신이 앞. */
export function stashesForNote(noteId: string, storage: StashStorage | null = defaultStorage()): UnsavedStash[] {
  return listStashes(storage)
    .filter((s) => s.noteId === noteId)
    .reverse();
}

// crypto.randomUUID 는 비보안 컨텍스트(http://100.x)에 없다 — 시각 + 난수면 충분하다(같은 기기 한 저장소 안의 키).
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function write(storage: StashStorage, next: UnsavedStash[]): boolean {
  try {
    const raw = JSON.stringify(next);
    storage.setItem(KEY, raw);
    return storage.getItem(KEY) === raw;
  } catch {
    return false;
  }
}

/**
 * 여러 항목을 한 번에(전부 아니면 전무) 보관한다. 같은 (노트·섹션·종류·본문)이 이미 있으면 그 옛 항목을 새 항목으로
 * 바꾼다(같은 글을 두 번 보관해 복구 배너가 같은 것을 두 번 묻지 않게). 상한을 넘으면 가장 오래된 것을 버린다.
 * 성공하면 true — 호출자는 이 값이 true 일 때만 화면을 버려도 된다.
 */
export function putStashes(entries: NewUnsavedStash[], storage: StashStorage | null = defaultStorage()): boolean {
  if (!storage) {
    reportFallback("mobile-save", "stash_unavailable");
    return false;
  }
  if (entries.length === 0) return true;
  const now = new Date().toISOString();
  const incoming: UnsavedStash[] = entries.map((e) => ({ ...e, id: newId(), savedAt: now }));
  const same = (a: UnsavedStash, b: UnsavedStash) =>
    a.noteId === b.noteId && a.sectionId === b.sectionId && a.kind === b.kind && a.bodyMd === b.bodyMd;
  let next = [...listStashes(storage).filter((old) => !incoming.some((n) => same(old, n))), ...incoming];
  const over = next.length - MAX_STASHES;
  if (over > 0) {
    next = next.slice(over);
    reportFallback("mobile-save", "stash_dropped", String(over));
  }
  if (!write(storage, next)) {
    reportFallback("mobile-save", "stash_write_failed");
    return false;
  }
  return true;
}

export function putStash(entry: NewUnsavedStash, storage: StashStorage | null = defaultStorage()): boolean {
  return putStashes([entry], storage);
}

/** id 로 하나 지운다. 이미 없으면 true(멱등). 쓰기가 실패하면 false — 항목은 남아 있다. */
export function removeStash(id: string, storage: StashStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  const all = listStashes(storage);
  if (!all.some((s) => s.id === id)) return true;
  if (!write(storage, all.filter((s) => s.id !== id))) {
    reportFallback("mobile-save", "stash_remove_failed");
    return false;
  }
  return true;
}
