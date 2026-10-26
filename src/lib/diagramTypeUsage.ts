/**
 * 관계도 타입별 사용 카운트 — 오너 제안 #7("써보고 지운다"의 데이터). 기기 로컬(localStorage),
 * 노트북 전역 설정이 아니다(settings 스토어에 넣지 않는 이유는 placeSearchHistory.ts 와 같다:
 * 사용 이력이지 설정이 아니다).
 */
const KEY = "brise.diagramTypeUsage";

export interface DiagramTypeUsage {
  seed: number;
  ai: number;
  /** ISO. 마지막으로 bump 된 시각. */
  last: string;
}

type Store = Record<string, DiagramTypeUsage>;

function isUsage(v: unknown): v is DiagramTypeUsage {
  if (!v || typeof v !== "object") return false;
  const u = v as Record<string, unknown>;
  return typeof u.seed === "number" && typeof u.ai === "number" && typeof u.last === "string";
}

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Store = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isUsage(v)) out[id] = v;
    }
    return out;
  } catch {
    // ponytail: corrupt JSON just means "no usage" — not worth a repair path.
    return {};
  }
}

/** typeId 하나를 seed/ai 클릭으로 1 증가시키고 last 를 지금으로 찍는다. 저장 실패는 조용히 무시. */
export function bump(typeId: string, kind: "seed" | "ai"): void {
  const all = readAll();
  const cur = all[typeId] ?? { seed: 0, ai: 0, last: "" };
  all[typeId] = { ...cur, [kind]: cur[kind] + 1, last: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // ponytail: quota/private-mode write failure — usage count is a nice-to-have, drop silently.
  }
}

export function usageOf(typeId: string): DiagramTypeUsage {
  return readAll()[typeId] ?? { seed: 0, ai: 0, last: "" };
}

export function allUsage(): Store {
  return readAll();
}
