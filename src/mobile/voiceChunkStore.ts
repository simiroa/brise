import { reportFallback } from "../lib/diag";

/**
 * Crash-protection store for in-progress recordings (plan §5.2): MediaRecorder timeslice chunks are
 * appended here so an app kill loses at most one slice. IndexedDB in production, an in-memory twin
 * for tests and for webviews without IndexedDB (`getDefaultChunkStore` records that via reportFallback).
 *
 * ponytail: the IDB adapter has no automated test (fake-indexeddb is not a dependency; adding one
 * for ~40 lines was not worth it) — it is covered by the S22 hands-on QA. The memory adapter
 * carries the contract tests.
 */
export interface SessionMeta {
  id: string;
  /** Base mime type (no codecs), used when re-assembling the file. */
  mimeType: string;
  /** ISO-8601 wall-clock start of the segment. */
  startedAt: string;
}
export type StoredSession = SessionMeta & { chunkCount: number };

export interface ChunkStore {
  putSession(meta: SessionMeta): Promise<void>;
  putChunk(sessionId: string, seq: number, blob: Blob): Promise<void>;
  listSessions(): Promise<StoredSession[]>;
  /** Chunks in recording order. */
  getChunks(sessionId: string): Promise<Blob[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export function createMemoryChunkStore(): ChunkStore {
  const sessions = new Map<string, SessionMeta>();
  const chunks = new Map<string, Map<number, Blob>>();
  return {
    async putSession(meta) { sessions.set(meta.id, meta); },
    async putChunk(id, seq, blob) {
      if (!chunks.has(id)) chunks.set(id, new Map());
      chunks.get(id)!.set(seq, blob);
    },
    async listSessions() {
      return [...sessions.values()].map((s) => ({ ...s, chunkCount: chunks.get(s.id)?.size ?? 0 }));
    },
    async getChunks(id) {
      const c = chunks.get(id);
      return c ? [...c.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b) : [];
    },
    async deleteSession(id) { sessions.delete(id); chunks.delete(id); },
  };
}

const DB_NAME = "brise-voice";

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export function createIdbChunkStore(factory: IDBFactory = indexedDB): ChunkStore {
  let dbP: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbP ??= new Promise<IDBDatabase>((res, rej) => {
      const open = factory.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("sessions", { keyPath: "id" });
        open.result.createObjectStore("chunks", { keyPath: ["sessionId", "seq"] });
      };
      open.onsuccess = () => res(open.result);
      open.onerror = () => { dbP = null; rej(open.error); };
    }));
  const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  return {
    async putSession(meta) {
      const tx = (await db()).transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(meta);
      await txDone(tx);
    },
    async putChunk(sessionId, seq, blob) {
      const tx = (await db()).transaction("chunks", "readwrite");
      tx.objectStore("chunks").put({ sessionId, seq, blob });
      await txDone(tx);
    },
    async listSessions() {
      const d = await db();
      const metas = await reqP(d.transaction("sessions").objectStore("sessions").getAll() as IDBRequest<SessionMeta[]>);
      const out: StoredSession[] = [];
      for (const s of metas) {
        const n = await reqP(d.transaction("chunks").objectStore("chunks").count(range(s.id)));
        out.push({ ...s, chunkCount: n });
      }
      return out;
    },
    async getChunks(sessionId) {
      const rows = await reqP(
        (await db()).transaction("chunks").objectStore("chunks").getAll(range(sessionId)) as IDBRequest<{ blob: Blob }[]>,
      );
      return rows.map((r) => r.blob); // key order = [sessionId, seq] ascending
    },
    async deleteSession(sessionId) {
      const tx = (await db()).transaction(["sessions", "chunks"], "readwrite");
      tx.objectStore("sessions").delete(sessionId);
      tx.objectStore("chunks").delete(range(sessionId));
      await txDone(tx);
    },
  };
}

let defaultStore: ChunkStore | null = null;
/**
 * The one process-wide store the recorder and the recovery list share by default (a test or a caller
 * can pass its own instead). Memory fallback when the webview has no IndexedDB — nothing then survives
 * a kill, so crash protection is silently gone, which is why the fallback is recorded.
 */
export function getDefaultChunkStore(): ChunkStore {
  if (!defaultStore) {
    if (typeof indexedDB === "undefined") {
      reportFallback("voice", "no_indexeddb", "memory chunk store");
      defaultStore = createMemoryChunkStore();
    } else {
      defaultStore = createIdbChunkStore();
    }
  }
  return defaultStore;
}
