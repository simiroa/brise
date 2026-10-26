/**
 * Small, framework-free request registry for AI calls that update shared UI state.
 * A newer request for the same kind + target supersedes older results, while pending
 * state remains true until every request of that kind has settled.
 */
export type AiRequestKind = "organize" | "prompt" | "cleanup" | "translate";

type RequestKey = `${AiRequestKind}:${string}`;

let nextId = 0;
const latest = new Map<RequestKey, number>();
const pendingByKey = new Map<RequestKey, number>();
const pendingByKind = new Map<AiRequestKind, number>();

function keyFor(kind: AiRequestKind, target: string): RequestKey {
  return `${kind}:${target}`;
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

export interface AiRequestLease {
  isLatest(): boolean;
  finish(): { keyPending: boolean; kindPending: boolean };
}

export function beginAiRequest(kind: AiRequestKind, target: string): AiRequestLease {
  const key = keyFor(kind, target || "__global__");
  const id = ++nextId;
  latest.set(key, id);
  pendingByKey.set(key, (pendingByKey.get(key) ?? 0) + 1);
  pendingByKind.set(kind, (pendingByKind.get(kind) ?? 0) + 1);
  let finished = false;

  return {
    isLatest: () => latest.get(key) === id,
    finish: () => {
      if (!finished) {
        finished = true;
        decrement(pendingByKey, key);
        decrement(pendingByKind, kind);
      }
      return {
        keyPending: (pendingByKey.get(key) ?? 0) > 0,
        kindPending: (pendingByKind.get(kind) ?? 0) > 0,
      };
    },
  };
}

/** Vitest-only cleanup for module state that otherwise lives for the app session. */
export function _resetAiRequestStateForTests(): void {
  nextId = 0;
  latest.clear();
  pendingByKey.clear();
  pendingByKind.clear();
}
