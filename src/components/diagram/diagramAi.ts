import { callSilent } from "../../lib/invoke";
import { emitNotice } from "../../lib/invoke";
import { t } from "../../i18n/t";
import type { DiagramModel, DiagramNode } from "./diagramModel";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore, aiCreds, selectAiAvailability } from "../../stores/ai";

export interface AiGenerateFromPromptOutput {
  generated?: string;
  error?: string;
}

/**
 * 선택된 노드에 대해 AI를 호출하거나 스마트 규칙 기반으로 3~4개의 자식 서브스텝을 생성합니다.
 */
export async function expandSubstepsWithAi(
  nodeLabel: string,
  nodeDesc?: string,
): Promise<string[]> {
  const fallbackSteps = [
    `${nodeLabel} 준비 및 계획`,
    `${nodeLabel} 핵심 구현 및 실행`,
    `${nodeLabel} 검토 및 피드백`,
  ];

  const availability = selectAiAvailability(useSettingsStore.getState(), useAiStore.getState());

  if (availability !== "ready") {
    return fallbackSteps;
  }

  try {
    const prompt = `당신은 업무 및 지식 다이어그램 전문가입니다.
주어진 항목 "${nodeLabel}"${nodeDesc ? ` (설명: ${nodeDesc})` : ""}의 구체적인 하위 실행 단계 3~4개를 JSON 문자열 배열로만 응답하세요.
형식 예시: ["단계 1", "단계 2", "단계 3", "단계 4"]
추가 설명이나 마크다운 백틱 없이 유효한 JSON 배열만 출력하세요.`;

    // D1(AUDIT-2026-09-26): 이 호출은 provider/api_key/model 을 아예 안 보냈다 — Rust 쪽
    // provider: String 이 필수 인자라(commands/ai.rs) 인자 역직렬화에서 조용히 거부됐고, 기존
    // 테스트는 callSilent 를 성공으로만 목킹해 이 버그를 못 잡았다(AUDIT-2026-09-26 §4 D1).
    // stores/ai.ts::aiCreds() 로 실제 크리덴셜을 채운다(정상 호출자 stores/ai.ts:839 와 동일 패턴).
    const res = await callSilent<AiGenerateFromPromptOutput>("ai_generate_from_prompt", {
      prompt,
      context_text: nodeLabel,
      ...(await aiCreds()),
    });

    if (res?.generated) {
      const cleaned = res.generated.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(0, 4).map((s) => String(s).trim()).filter(Boolean);
      }
    }
  } catch {
    // AI 호출 실패 시 fallback 단계 반환
  }

  return fallbackSteps;
}

/**
 * 관계도 노드들의 흐름(위상 정렬 및 연결성)을 읽어
 * `- [ ] {노드명}: {설명}` 또는 `- [ ] {노드명}` 형태의 체크리스트 텍스트를 추출합니다.
 */
export function extractTodosFromDiagram(
  model: DiagramModel,
  selectedNodeIds?: string[],
): string {
  const allNodes = model.nodes;
  if (!allNodes || allNodes.length === 0) return "";

  // 대상 노드 집합
  const targetIds =
    selectedNodeIds && selectedNodeIds.length > 0
      ? new Set(selectedNodeIds)
      : new Set(allNodes.map((n) => n.id));

  const targetNodes = allNodes.filter((n) => targetIds.has(n.id));
  if (targetNodes.length === 0) return "";

  // 대상 노드 간의 엣지 추출
  const relevantEdges = model.edges.filter(
    (e) => targetIds.has(e.from) && targetIds.has(e.to),
  );

  // Topological sort 계산
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};

  targetNodes.forEach((n) => {
    inDegree[n.id] = 0;
    adj[n.id] = [];
  });

  relevantEdges.forEach((e) => {
    if (!adj[e.from]) adj[e.from] = [];
    adj[e.from].push(e.to);
    inDegree[e.to] = (inDegree[e.to] || 0) + 1;
  });

  // 진입차수가 0인 노드부터 큐에 삽입
  const queue: string[] = targetNodes
    .filter((n) => (inDegree[n.id] || 0) === 0)
    .map((n) => n.id);

  const orderedIds: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currId = queue.shift()!;
    if (visited.has(currId)) continue;
    visited.add(currId);
    orderedIds.push(currId);

    const neighbors = adj[currId] || [];
    for (const nextId of neighbors) {
      inDegree[nextId] -= 1;
      if (inDegree[nextId] === 0 && !visited.has(nextId)) {
        queue.push(nextId);
      }
    }
  }

  // 사이클이나 독립 컴포넌트로 인해 방문되지 않은 노드가 있으면 추가
  targetNodes.forEach((n) => {
    if (!visited.has(n.id)) {
      orderedIds.push(n.id);
      visited.add(n.id);
    }
  });

  // 노드 매핑 및 체크리스트 문자열 생성
  const nodeMap = new Map<string, DiagramNode>(allNodes.map((n) => [n.id, n]));

  const lines = orderedIds.map((id) => {
    const node = nodeMap.get(id);
    if (!node) return "";
    const label = node.label.trim();
    const desc = (node.desc || "").trim();

    if (desc) {
      return `- [ ] ${label}: ${desc}`;
    }
    return `- [ ] ${label}`;
  }).filter(Boolean);

  return lines.join("\n");
}

/**
 * 생성된 할일 체크리스트를 클립보드에 복사하고 사용자 안내 토스트를 띄웁니다.
 */
export async function copyTodosToClipboard(todosText: string): Promise<boolean> {
  if (!todosText) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(todosText);
      emitNotice(t("editor.diagram_todos_copied") || "체크리스트가 클립보드에 복사되었습니다.");
      return true;
    }
  } catch {
    // clipboard 실패 시 fallback
  }
  return false;
}
