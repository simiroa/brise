/**
 * AI에게 묻기 히스토리 — 기기 로컬(localStorage), PLAN-2026-09-15-askai-composer §2.3.
 *
 * 저장하는 건 **지시문 문서**(`doc`)와 그때 활성이었던 **참조 목록**(`refs`) 두 벌이다(6안 D18).
 * 참조 중 상대 참조(body/section/selection)는 저장 시 대상 id 를 지워 다음에 열린 대상에
 * 재바인딩되게 한다(D12) — 옛 `ai_history` 가 200자 캡으로 옛 본문을 끌고 오던 사고를 구조적으로
 * 막는다. note/file/folder/weather 는 절대 참조라 그대로 둔다.
 *
 * 상대 참조 정규화 규칙: 대상 종류가 selection 이면 `{k:"selection"}`, 그 외(note/section/diagram/
 * sheet)는 `{k:"body"}`. 섹션 id 는 남기지 않는다 — 다른 노트에서 재사용하면 없는 id 가 되고,
 * dispatch 는 `body` 를 "지금 대상의 본문"으로 풀기 때문이다.
 *
 * 동기화되는 설정 kv 가 아닌 이유는 placeSearchHistory.ts 와 같다: 사용 이력이지 노트북 설정이 아니다.
 */
import type { AskAiKind, AskAiWhere } from "../stores/aiPrompts";
import { docText, isRelativeRef, sameRef, type ComposerDoc, type CtxRef, type Part } from "../components/ai/composer/types";

export interface AskAiHistoryEntry {
  id: string;
  at: number;
  doc: ComposerDoc;
  /** 보낼 때 활성이었던 컨텍스트 참조들. 상대 참조는 정규화된 상태로 저장된다. */
  refs: CtxRef[];
  where: AskAiWhere;
  folderId?: string | null;
  targetKind: AskAiKind;
  noteTitle: string;
  presetId?: string;
}

const KEY = "brise.askAiHistory.v1";
const MAX_ENTRIES = 30;

const WHERES: readonly AskAiWhere[] = ["section", "note", "replace", "proposal"];
const KINDS: readonly AskAiKind[] = ["note", "section", "selection", "diagram", "sheet"];

function isRef(v: unknown): v is CtxRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  switch (r.k) {
    case "body":
    case "selection":
      return true;
    case "weather":
      return true;
    case "section":
    case "note":
    case "folder":
      return typeof r.id === "string";
    case "file":
      return typeof r.name === "string";
    default:
      return false;
  }
}

function isPart(v: unknown): v is Part {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (p.t === "text") return typeof p.v === "string";
  if (p.t === "slot") return typeof p.key === "string" && typeof p.kind === "string" && typeof p.v === "string";
  return false;
}

function isEntry(v: unknown): v is AskAiHistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    Array.isArray(e.doc) &&
    e.doc.every(isPart) &&
    // refs 는 2026-09-15 저녁(6안)에 생겼다 — 없던 기록은 빈 배열로 읽는다(아래 list()).
    (e.refs === undefined || (Array.isArray(e.refs) && e.refs.every(isRef))) &&
    (WHERES as readonly unknown[]).includes(e.where) &&
    (KINDS as readonly unknown[]).includes(e.targetKind) &&
    typeof e.noteTitle === "string"
  );
}

export function list(): AskAiHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map((e) => ({ ...e, refs: e.refs ?? [] }));
  } catch {
    // ponytail: corrupt JSON just means "no history" — not worth a repair path.
    return [];
  }
}

function save(entries: AskAiHistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // ponytail: quota/private-mode write failure — history is a nice-to-have, drop silently.
  }
}

/** 상대 참조를 대상 종류에 맞는 무-id 형태로 바꾼다(파일 상단 규칙). */
export function stripRelativeRefs(refs: CtxRef[], targetKind: AskAiKind): CtxRef[] {
  const generic: CtxRef = targetKind === "selection" ? { k: "selection" } : { k: "body" };
  const out: CtxRef[] = [];
  for (const ref of refs) {
    const next = isRelativeRef(ref) ? generic : ref;
    // 섹션 두 개가 같은 `body` 로 접히면 한 줄로 합친다 — 다음 대상에 두 번 붙을 이유가 없다.
    if (!out.some((r) => sameRef(r, next))) out.push(next);
  }
  return out;
}

/** 보낸 요청을 기록한다. 같은 문장(docText)이 이미 있으면 그 항목의 `at` 만 갱신해 맨 앞으로. */
export function push(entry: Omit<AskAiHistoryEntry, "id" | "at">): AskAiHistoryEntry {
  // 이전 결과 참조(`result`)는 그 모달 안에서만 뜻이 있다 — 남기면 다시 꺼낼 때 가리킬 것이 없고, 읽는 쪽
  // isRef 가 모르는 종류라 그 기록 한 줄이 통째로 버려진다. 저장하는 유일한 자리인 여기서 거른다.
  const refs = stripRelativeRefs(entry.refs.filter((r) => r.k !== "result"), entry.targetKind);
  const key = docText(entry.doc);
  const now = Date.now();
  const rest = list().filter((e) => docText(e.doc) !== key);
  const next: AskAiHistoryEntry = {
    ...entry,
    refs,
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
  };
  save([next, ...rest].slice(0, MAX_ENTRIES));
  return next;
}

export function remove(id: string): void {
  save(list().filter((e) => e.id !== id));
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

// ── 대상 종류별 "마지막으로 쓴 프리셋" ─────────────────────────────────────────────────────
// AskAiModal.tsx 에서 이관(2026-09-15). 키·JSON 모양 그대로라 기존 데이터가 그대로 읽힌다.
// ponytail: 스코프당 1개만 기억한다. 빈도 정렬이 필요해지면 그때 count 를 붙여라.
const RECENT_KEY = "brise.askAiRecentChip.v1";

export function readRecentPreset(scope: string): string | null {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const v = map[scope];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function writeRecentPreset(scope: string, presetId: string): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    map[scope] = presetId;
    localStorage.setItem(RECENT_KEY, JSON.stringify(map));
  } catch {
    // 저장 실패는 "다음에 최근 점이 안 붙는다" 이상의 결과가 없다.
  }
}
