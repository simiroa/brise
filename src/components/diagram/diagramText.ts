/**
 * diagramText — 텍스트 문법 → IR (PLAN-2026-09-20 §2.2, D4). 한 방향(텍스트 → JSON)이고 역변환은
 * 없다(`ponytail:` 원본 편집은 여전히 JSON, 텍스트는 입력 편의일 뿐). 순수 함수, React/xyflow import
 * 없음 — `flowEdgePath.ts`와 같은 규율.
 *
 * 문법:
 *   A -> B: 라벨      엣지(arrow end, 라벨 선택). "--"=arrow none, "=>"=line thick, "<->"=arrow both.
 *   A -> B -> C       한 줄 체인 = 엣지 여러 개(마지막 hop 만 라벨을 받는다).
 *   [그룹명]          다음 들여쓰기 줄들이 멤버(노드 이름 한 줄 = 노드, 또는 엣지 줄).
 *   회사 / 개발팀 …   그룹 밖 들여쓰기 트리 — 부모→자식 엣지 자동(라벨 없음).
 * 들여쓰기는 공백 2 또는 탭 1 = 한 단계. 라벨 꼬리 `(설명)`→desc, `#태그`→tag(둘 다 라벨에서 제거).
 * 빈 줄과 `#`로 시작하는 줄은 주석.
 *
 * 노드는 라벨로 식별(같은 라벨 = 같은 노드), id는 등장 순 n1../e1../g1..
 */
import type { DiagramEdge, DiagramGroup, DiagramJson, DiagramNode, EdgeArrow, EdgeLine } from "./diagramSchema";

/** UI가 문구로 바꾼다(`editor.diagram_text_err_<code>`) — 파서는 코드만 돌려준다. */
export type DiagramTextErrorCode = "indent_jump" | "nested_group" | "unknown_connector";

export type DiagramTextParseResult =
  | { ok: true; json: DiagramJson }
  | { ok: false; error: DiagramTextErrorCode; line: number };

const CONNECTOR_TOKENS = ["<->", "=>", "--", "->"] as const;
type ConnectorToken = (typeof CONNECTOR_TOKENS)[number];
const CONNECTOR_RE = /(<->|=>|--|->)/;
// ponytail: 연결자 후보를 "-=<> 2글자 이상 연속"으로만 잡는다 — 라벨 안에 우연히 낀 "--" 같은 텍스트도
// 걸릴 수 있지만(예: "em--dash"), 이 문법의 용도(관계도 스케치)에서는 드물고 감지 실패보다 낫다.
const CONNECTOR_SCAN_RE = /[-=<>]{2,}/g;

function findInvalidConnector(content: string): string | null {
  const matches = content.match(CONNECTOR_SCAN_RE);
  if (!matches) return null;
  for (const m of matches) {
    if (!(CONNECTOR_TOKENS as readonly string[]).includes(m)) return m;
  }
  return null;
}

function splitEdgeLine(content: string): string[] | null {
  if (!CONNECTOR_RE.test(content)) return null;
  return content.split(CONNECTOR_RE).map((s) => s.trim());
}

function connectorStyle(token: ConnectorToken): { line: EdgeLine; arrow: EdgeArrow } {
  switch (token) {
    case "--":
      return { line: "solid", arrow: "none" };
    case "=>":
      return { line: "thick", arrow: "end" };
    case "<->":
      return { line: "solid", arrow: "both" };
    case "->":
    default:
      return { line: "solid", arrow: "end" };
  }
}

/** 라벨 꼬리 `(설명)`과 `#태그`를 떼어낸다. 순서 무관 — 둘 다 있으면 둘 다 제거. */
function splitLabelTail(raw: string): { label: string; desc?: string; tag?: string } {
  let s = raw.trim();
  let desc: string | undefined;
  let tag: string | undefined;

  const tagMatch = /^(.*?)\s*#(\S+)$/.exec(s);
  if (tagMatch) {
    s = tagMatch[1].trim();
    tag = tagMatch[2];
  }
  const descMatch = /^(.*?)\s*\(([^()]*)\)$/.exec(s);
  if (descMatch) {
    s = descMatch[1].trim();
    desc = descMatch[2];
  }

  return { label: s, ...(desc ? { desc } : {}), ...(tag ? { tag } : {}) };
}

export function parseDiagramText(text: string): DiagramTextParseResult {
  const rawLines = text.split(/\r\n|\r|\n/);
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const nodeIdByLabel = new Map<string, string>();
  let nodeSeq = 0;
  let edgeSeq = 0;
  let groupSeq = 0;

  interface Frame {
    level: number;
    kind: "node" | "group";
    id: string;
  }
  const stack: Frame[] = [];

  function ensureNode(rawLabel: string, groupId?: string): string {
    const { label, desc, tag } = splitLabelTail(rawLabel);
    let id = nodeIdByLabel.get(label);
    if (!id) {
      id = `n${++nodeSeq}`;
      nodeIdByLabel.set(label, id);
      const node: DiagramNode = { id, label };
      if (desc) node.desc = desc;
      if (tag) node.tag = tag;
      if (groupId) node.group = groupId;
      nodes.push(node);
    } else if (groupId) {
      const existing = nodes.find((n) => n.id === id);
      if (existing && !existing.group) existing.group = groupId;
    }
    return id;
  }

  function pushEdge(from: string, to: string, label: string | undefined, line: EdgeLine, arrow: EdgeArrow) {
    const edge: DiagramEdge = { id: `e${++edgeSeq}`, from, to, line, arrow };
    if (label) edge.label = label;
    edges.push(edge);
  }

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNo = i + 1;
    if (!raw.trim()) continue;

    let spaces = 0;
    let tabs = 0;
    let idx = 0;
    while (idx < raw.length && (raw[idx] === " " || raw[idx] === "\t")) {
      if (raw[idx] === "\t") tabs++;
      else spaces++;
      idx++;
    }
    const content = raw.slice(idx);
    if (content.startsWith("#")) continue; // 주석 줄

    const level = tabs > 0 ? tabs : Math.floor(spaces / 2);

    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : null;
    const parentLevel = parent ? parent.level : -1;
    if (level > parentLevel + 1) {
      return { ok: false, error: "indent_jump", line: lineNo };
    }
    const enclosingGroup = parent?.kind === "group" ? parent.id : undefined;
    const treeParent = parent?.kind === "node" ? parent.id : undefined;

    const groupMatch = /^\[(.+)\]$/.exec(content);
    if (groupMatch) {
      if (parent?.kind === "group") {
        return { ok: false, error: "nested_group", line: lineNo };
      }
      const title = groupMatch[1].trim();
      const id = `g${++groupSeq}`;
      groups.push({ id, title, parent: null });
      stack.push({ level, kind: "group", id });
      continue;
    }

    const badConnector = findInvalidConnector(content);
    if (badConnector) {
      return { ok: false, error: "unknown_connector", line: lineNo };
    }

    const parts = splitEdgeLine(content);
    if (parts) {
      const lastIdx = parts.length - 1;
      let finalRaw = parts[lastIdx];
      let edgeLabel: string | undefined;
      const colonIdx = finalRaw.indexOf(":");
      if (colonIdx >= 0) {
        edgeLabel = finalRaw.slice(colonIdx + 1).trim() || undefined;
        finalRaw = finalRaw.slice(0, colonIdx).trim();
      }
      parts[lastIdx] = finalRaw;

      let lastNodeId = "";
      for (let p = 0; p < parts.length - 1; p += 2) {
        const fromId = ensureNode(parts[p], enclosingGroup);
        const toId = ensureNode(parts[p + 2], enclosingGroup);
        const isLastHop = p + 2 === lastIdx;
        const { line, arrow } = connectorStyle(parts[p + 1] as ConnectorToken);
        pushEdge(fromId, toId, isLastHop ? edgeLabel : undefined, line, arrow);
        lastNodeId = toId;
      }
      stack.push({ level, kind: "node", id: lastNodeId });
      continue;
    }

    // 평범한 노드 이름 한 줄
    const nodeId = ensureNode(content, enclosingGroup);
    if (treeParent) {
      pushEdge(treeParent, nodeId, undefined, "solid", "end");
    }
    stack.push({ level, kind: "node", id: nodeId });
  }

  return {
    ok: true,
    json: {
      v: 1,
      nodes,
      edges,
      ...(groups.length ? { groups } : {}),
    },
  };
}
