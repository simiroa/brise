import { useCallback, useEffect, useRef, useState } from "react";
import { addInternalAttachment } from "../../../lib/attachmentService";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";
import { pairKey, type DashboardGraphEdge, type DashboardGraphNode } from "./graphSimulation";

/** 내부 링크(첨부) 이름 — 연결 대상 노트의 제목, 비었으면 "제목 없음". 연결 경로 네 곳이 각자
 *  복붙하던 식이다(GraphTab 세 핸들러 + 새 노트 만들기). */
export function linkName(node: { title?: string | null } | null | undefined): string {
  const title = node?.title ? displayTitle(node.title) : "";
  return title.trim() || t("note.untitled_note") || "Note";
}

/** 같은 쌍의 연결이 동시에 두 번 나가지 않게 하는 in-flight 잠금 — 방향 무관(pairKey).
 *  이미 잡혀 있으면 false, 아니면 잡고 true. */
export function tryLockPair(inFlight: Set<string>, a: string, b: string): boolean {
  const key = pairKey(a, b);
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function unlockPair(inFlight: Set<string>, a: string, b: string): void {
  inFlight.delete(pairKey(a, b));
}

/** ids 안의 모든 쌍(i<j) 중 아직 backlink 엣지가 없는 쌍. 방향은 무관하다. */
export function missingBacklinkPairs(
  ids: string[],
  edges: DashboardGraphEdge[] | undefined,
): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const exists = edges?.some(
        (e) =>
          e.kind === "backlink" &&
          ((e.source === a && e.target === b) || (e.source === b && e.target === a)),
      );
      if (!exists) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * 그래프 탭의 "노트끼리 연결" 한 벌 — 내부 링크 첨부 추가 + in-flight 잠금 + 방금 만든 엣지 표식
 * (justCreatedKeys, 800ms 뒤 소멸) + refetch 예약. 연결 경로(단건·다대일·선택 전부·
 * 절단 되돌리기)가 전부 이 하나를 지난다.
 */
export function useGraphConnect({
  nodes,
  edges,
  loading,
  scheduleGraphReload,
}: {
  nodes: DashboardGraphNode[] | undefined;
  edges: DashboardGraphEdge[] | undefined;
  loading: boolean;
  scheduleGraphReload: () => void;
}) {
  const [justCreatedKeys, setJustCreatedKeys] = useState<Set<string>>(new Set());
  const justCreatedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlightConnectsRef = useRef<Set<string>>(new Set());

  const markJustCreated = useCallback((source: string, target: string) => {
    const key = `${source}:${target}`;
    const reverseKey = `${target}:${source}`;

    const existing = justCreatedTimersRef.current.get(key) || justCreatedTimersRef.current.get(reverseKey);
    if (existing) {
      clearTimeout(existing);
      justCreatedTimersRef.current.delete(key);
      justCreatedTimersRef.current.delete(reverseKey);
    }

    setJustCreatedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  /** 걸려 있는 표식 타이머와 in-flight 잠금을 전부 비운다(상태는 건드리지 않는다). */
  const clearPending = useCallback(() => {
    for (const timer of justCreatedTimersRef.current.values()) {
      clearTimeout(timer);
    }
    justCreatedTimersRef.current.clear();
    inFlightConnectsRef.current.clear();
  }, []);

  /** 워크스페이스(= 노트북) 전환 시 호출 — 표식·타이머·잠금을 초기화한다. */
  const resetConnect = useCallback(() => {
    setJustCreatedKeys(new Set());
    clearPending();
  }, [clearPending]);

  /**
   * 새 엣지는 loadGraph 왕복이 끝나야 DOM 에 생긴다. 지우기 타이머를 연결 시점에 걸면
   * 왕복이 800ms 를 넘는 순간 엣지가 클래스 없이 마운트돼 애니메이션이 아예 안 돈다.
   * 그래서 로딩이 끝난 뒤에 건다.
   */
  useEffect(() => {
    if (loading) return;
    for (const key of justCreatedKeys) {
      if (justCreatedTimersRef.current.has(key)) continue;
      const [source, target] = key.split(":");
      const reverseKey = `${target}:${source}`;
      const timer = setTimeout(() => {
        justCreatedTimersRef.current.delete(key);
        setJustCreatedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          next.delete(reverseKey);
          return next;
        });
      }, 800);
      justCreatedTimersRef.current.set(key, timer);
    }
  }, [loading, justCreatedKeys]);

  // 언마운트 — 타이머와 잠금만 치운다(상태는 어차피 버려진다).
  useEffect(() => clearPending, [clearPending]);

  /** a → b 링크 한 건 + 표식. 이름은 대상(b) 노트 제목에서 나온다. */
  const link = useCallback(
    async (a: string, b: string) => {
      await addInternalAttachment(a, b, linkName(nodes?.find((n) => n.id === b)));
      markJustCreated(a, b);
    },
    [markJustCreated, nodes],
  );

  /** 단건 연결. 실패하면 refetch 도 표식도 없다(call() 이 이미 토스트로 알렸다). */
  const connectNote = useCallback(
    async (sourceId: string, targetId: string) => {
      if (!sourceId || !targetId || sourceId === targetId) return;
      if (!tryLockPair(inFlightConnectsRef.current, sourceId, targetId)) return;

      try {
        await link(sourceId, targetId);
        scheduleGraphReload();
      } catch {
        // Handled/reported by invoke call
      } finally {
        unlockPair(inFlightConnectsRef.current, sourceId, targetId);
      }
    },
    [link, scheduleGraphReload],
  );

  /** 여러 쌍을 동시에 연결하고 refetch 는 한 번만 예약한다. 잠긴 쌍은 조용히 건너뛴다.
   *  건별 실패는 삼키고(이미 토스트) 성공분만 표식이 붙는다 — refetch 는 전부 실패해도 나간다. */
  const connectPairs = useCallback(
    async (pairs: [string, string][]) => {
      const toConnect = pairs.filter(([a, b]) => tryLockPair(inFlightConnectsRef.current, a, b));
      if (toConnect.length === 0) return;

      try {
        await Promise.all(
          toConnect.map(async ([a, b]) => {
            try {
              await link(a, b);
            } catch {
              // Handled
            }
          }),
        );
        scheduleGraphReload();
      } finally {
        for (const [a, b] of toConnect) {
          unlockPair(inFlightConnectsRef.current, a, b);
        }
      }
    },
    [link, scheduleGraphReload],
  );

  /** 여러 출발 노트 → 한 대상(다대일 드래그). */
  const connectMany = useCallback(
    async (sourceIds: string[], targetId: string) => {
      if (!sourceIds || sourceIds.length === 0 || !targetId) return;
      await connectPairs(
        sourceIds.filter((src) => src && src !== targetId).map((src): [string, string] => [src, targetId]),
      );
    },
    [connectPairs],
  );

  /** 선택한 노트들 사이에 아직 backlink 가 없는 모든 쌍을 잇는다. */
  const connectAmong = useCallback(
    (ids: string[]) => connectPairs(missingBacklinkPairs(ids, edges)),
    [connectPairs, edges],
  );

  return { justCreatedKeys, markJustCreated, resetConnect, connectNote, connectMany, connectAmong };
}
