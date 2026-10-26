/**
 * "가져온 초안이 노트 N 이 됐고 사진 몇 장이 아직 안 올라갔다" 의 내구 기록 (O-2, X-3/M-2).
 *
 * 왜 필요한가: ack 는 가져오기 배치(importId) 단위이고, ack 전 배치는 페이지가 부팅·앞으로 돌아옴·셸 알림 때마다 **다시 당겨 온다**.
 * 사진이 덜 올라간 채 ack 를 미루면 다시 당겨 온 배치가 입력 화면을 새로 열어 같은 내용의 노트를 또 만든다. 그래서 "importId X 는
 * 이미 노트 N" 을 페이지 새로고침을 넘어 남기고, 다시 온 X 는 새 입력 화면이 아니라 "N 에 못 올린 사진 다시 올리기" 로 보낸다.
 *
 * localStorage 한 키(unsavedStash.ts 와 같은 이유 — 셸 origin 이 재시작을 넘어 같다). 사진이 전부 올라가거나 버려지면 항목을 지운다.
 * 진단 로그에는 개수만 — 파일명·본문 금지.
 *
 * ponytail: 셸은 **프로세스가 새로 시작될 때** `cache/import` 를 지운다. 앱 프로세스가 죽었다 다시 뜨면 항목은 남아 있어도 파일이 없어
 * 다시 올리기는 404 로 "올릴 수 없어 건너뜀" 처리돼 항목이 정리된다(노트와 글은 그대로, 사진만 사라진다). 프로세스 재시작을 넘겨
 * 지키려면 셸이 파일을 filesDir 로 옮기고 ack 가 지우게 바꾼다(M-17 의 singleton 으로 액티비티 재생성은 이미 넘긴다).
 */
import { useSyncExternalStore } from "react";
import { reportFallback } from "../lib/diag";
import type { ImportFile } from "./mobileImport";

export interface LedgerEntry {
  importId: string;
  /** = 노트(기존 내부 식별자는 note). */
  noteId: string;
  /** 아직 안 올라간 사진. */
  files: ImportFile[];
  savedAt: string;
}

const KEY = "brise.importLedger.v1";
const MAX_ENTRIES = 10;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // silent-ok: 저장소 접근 자체가 막힘 — 기록 없이 이 페이지 수명 동안만 메모리 사본으로 돈다
  }
}

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.importId === "string" && typeof e.noteId === "string" && Array.isArray(e.files) && typeof e.savedAt === "string";
}

let mem: LedgerEntry[] | null = null;
const busy = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: { entries: LedgerEntry[]; busy: string[] } = { entries: [], busy: [] };

function read(): LedgerEntry[] {
  if (mem) return mem;
  let list: LedgerEntry[] = [];
  try {
    const raw = storage()?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter(isEntry);
  } catch {
    reportFallback("mobile-import", "ledger_read_failed", "parse");
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  mem = list.filter((e) => Date.parse(e.savedAt) > cutoff).slice(-MAX_ENTRIES);
  return mem;
}

function commit(next: LedgerEntry[]): void {
  mem = next;
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    reportFallback("mobile-import", "ledger_write_failed", `n=${next.length}`);
  }
  emit();
}

function emit(): void {
  inited = true;
  snapshot = { entries: [...read()], busy: [...busy] };
  listeners.forEach((l) => l());
}

export function getLedgerEntry(importId: string): LedgerEntry | undefined {
  return read().find((e) => e.importId === importId);
}

/** 가져온 초안이 노트가 됐다 — 올릴 사진을 적는다(같은 importId 면 덮어쓴다). */
export function recordLedger(importId: string, noteId: string, files: ImportFile[]): void {
  commit([...read().filter((e) => e.importId !== importId), { importId, noteId, files, savedAt: new Date().toISOString() }].slice(-MAX_ENTRIES));
}

/** 올리고 남은 사진으로 줄인다. 항목이 없으면(초안 단계) 아무것도 안 한다. */
export function updateLedgerFiles(importId: string, files: ImportFile[]): void {
  const cur = getLedgerEntry(importId);
  if (!cur) return;
  commit(read().map((e) => (e.importId === importId ? { ...cur, files } : e)));
}

export function removeLedger(importId: string): void {
  if (!getLedgerEntry(importId)) return;
  commit(read().filter((e) => e.importId !== importId));
}

/** 이 가져오기의 사진을 지금 올리는 중인가 — 표시(버튼 잠금)용. */
export function setLedgerBusy(importId: string, on: boolean): void {
  if (on === busy.has(importId)) return;
  if (on) busy.add(importId);
  else busy.delete(importId);
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let inited = false;
function getSnapshot() {
  if (!inited) {
    inited = true;
    snapshot = { entries: [...read()], busy: [...busy] };
  }
  return snapshot;
}

/** 못 올린 사진 표시용 구독. */
export function useImportLedger(): { entries: LedgerEntry[]; busy: string[] } {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 테스트용 — 메모리·저장소를 비운다. */
export function resetLedgerForTest(): void {
  mem = null;
  busy.clear();
  try {
    storage()?.removeItem(KEY);
  } catch {
    // silent-ok: 테스트 정리
  }
  snapshot = { entries: [], busy: [] };
  inited = true;
  listeners.forEach((l) => l());
}
