/**
 * diagramStyles — 6-slot state palette, tone, and visual token mappings for JSON IR v1 nodes.
 *
 * [6-SLOT CONTRAST RATIO MEASUREMENTS (WCAG relative luminance)]
 * Canvas backgrounds: Dark #171b1a (--app-canvas), Light #f4efe3 (--app-canvas)
 *
 * Slot 0: var(--danger-soft) — solid border + 14% tint
 *   Dark  (#e0a83c): 8.14:1 (>= 4.5:1 PASS)
 *   Light (#7a5200): 6.03:1 (>= 4.5:1 PASS)
 *
 * Slot 1: var(--ok) — solid border + 14% tint
 *   Dark  (#3ecf8e): 8.71:1 (>= 4.5:1 PASS)
 *   Light (#116b41): 5.71:1 (>= 4.5:1 PASS)
 *
 * Slot 2: var(--muted) — dashed border + faint tone
 *   Dark  (#e0deda, rgba 0.80): 9.38:1 (>= 4.5:1 PASS)
 *   Light (#3b3833, rgba 0.78): 6.89:1 (>= 4.5:1 PASS)
 *
 * Slot 3: var(--info) — solid border + 14% tint
 *   Dark  (#4fa3e0): 6.33:1 (>= 4.5:1 PASS)
 *   Light (#12559f): 6.48:1 (>= 4.5:1 PASS)
 *
 * Slot 4: var(--danger) — solid border + 14% tint
 *   Dark  (#ef5350): 4.99:1 (>= 4.5:1 PASS)
 *   Light (#b32020): 5.82:1 (>= 4.5:1 PASS)
 *
 * Slot 5: var(--ok) — dashed border + 8% tint
 *   Dark  (#3ecf8e): 8.71:1 (>= 4.5:1 PASS)
 *   Light (#116b41): 5.71:1 (>= 4.5:1 PASS)
 *
 * Reference Accent (for Flag ring / Tag chip):
 *   Dark  (#9cc5a4): 9.05:1 (>= 4.5:1 PASS)
 *   Light (#06211f / on-accent & border): >= 5.0:1 PASS
 */

import { t } from "../../i18n/t";
import { parseDiagramJson, serializeDiagram, DIAGRAM_TONES, type DiagramTone } from "./diagramSchema";
export { DIAGRAM_TONES, type DiagramTone };

export interface StateSlotDef {
  slot: number;
  colorVar: string;
  borderStyle: "solid" | "dashed";
  backgroundVar?: string;
}

export const STATE_SLOT_DEFS: readonly StateSlotDef[] = [
  { slot: 0, colorVar: "var(--danger-soft)", borderStyle: "solid" },
  { slot: 1, colorVar: "var(--ok)", borderStyle: "solid" },
  { slot: 2, colorVar: "var(--muted)", borderStyle: "dashed" },
  { slot: 3, colorVar: "var(--info)", borderStyle: "solid" },
  { slot: 4, colorVar: "var(--danger)", borderStyle: "solid" },
  { slot: 5, colorVar: "var(--ok)", borderStyle: "dashed" },
] as const;

export function stateSlotDef(slot: number): StateSlotDef {
  const clamped = Math.max(0, Math.min(5, Math.floor(slot)));
  return STATE_SLOT_DEFS[clamped] ?? STATE_SLOT_DEFS[0];
}

/** i18n key for a tone's name (`editor.diagram_tone_accent`, …). */
export function toneLabelKey(tone: DiagramTone): string {
  return `editor.diagram_tone_${tone}`;
}

export function nodeTone(source: string, nodeId: string): DiagramTone {
  const model = parseDiagramJson(source);
  if (!model.structured) return "default";
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return "default";

  if (node.flag) return "accent";
  if (node.state === 0) return "warn";
  if (node.state === 1) return "done";
  if (node.state === 2) return "muted";
  return "default";
}

/**
 * 노드의 색 표시 하나 — 강조(`"flag"`) 또는 상태 슬롯 번호. `null` = 기본(둘 다 없음).
 * 톤(tone)·상태(state)·플래그(flag)는 같은 두 필드(`flag`·`state`)를 쓴다 — 버블의 색 칩 한 줄
 * (GRILL-2026-10-19 R6)이 그 사실을 그대로 보여 준다: 칩 하나 = 표시 하나, 고르면 다른 표시는 지워진다.
 */
export type NodeMark = "flag" | number | null;

/** 표시 하나로 바꾼다 — ONE 쓰기(= 되돌리기 한 단계). 강조와 상태는 서로를 지운다(옛 톤 피커와 같은 규칙). */
export function setNodeMark(source: string, nodeId: string, mark: NodeMark): string {
  return setNodesMark(source, [nodeId], mark);
}

/** 여러 노드에 같은 표시 — 다중 선택 버블. 노드 수와 상관없이 ONE 쓰기(되돌리기 한 단계). */
export function setNodesMark(source: string, nodeIds: readonly string[], mark: NodeMark): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  const ids = new Set(nodeIds);
  const nodes = model.nodes.filter((n) => ids.has(n.id));
  if (nodes.length === 0) return source;

  for (const node of nodes) {
    if (mark === "flag") {
      node.flag = true;
      delete node.state;
    } else if (typeof mark === "number" && mark >= 0) {
      delete node.flag;
      node.state = mark;
    } else {
      delete node.flag;
      delete node.state;
    }
  }

  return serializeDiagram(model);
}

const TONE_MARK: Record<DiagramTone, NodeMark> = { default: null, accent: "flag", warn: 0, done: 1, muted: 2 };

export function setNodeTone(source: string, nodeId: string, tone: DiagramTone): string {
  return setNodeMark(source, nodeId, TONE_MARK[tone] ?? null);
}

/** 강조(flag)의 이름 — 범례·색 칩·폰 동사가 같은 이름을 쓰도록 한 곳에서. */
export function flagLabelOf(model: { flagLabel?: string }): string {
  return model.flagLabel || t("editor.diagram_flag");
}

export interface NodeMarkOption {
  mark: NodeMark;
  label: string;
  /** 칩 점의 색(CSS 변수). 기본은 null — 빈 점선 점. */
  colorVar: string | null;
}

/**
 * 노드 색 칩 목록: 기본 · 강조(flagLabel) · model.states 이름들. 이름은 범례(DiagramLegend)와 같은 식이고
 * 색은 범례 표식과 같은 `stateSlotDef(i).colorVar` 다. 상태 어휘가 없는 관계도에는 상태 칩이 없다 —
 * 옛 톤 피커의 주의/완료/흐리게는 어휘 없는 관계도에 state 0~2 를 써서 validateDiagramModel 이
 * 거부하는 모델을 만들었고, 범례는 그 이름을 보여 줄 수 없었다.
 * 상태 어휘에 강조와 같은 이름이 있으면(예: [강조, 주의, 완료, 흐리게]) 같은 이름 칩이 둘 생긴다 — 그때 강조
 * 칩은 이미 강조가 걸린 노드(`current.flag`)에서만 보인다(켜진 표시는 끌 수 있어야 하므로).
 */
export function nodeMarkOptions(
  model: { flagLabel?: string; states?: string[] },
  current?: { flag?: boolean },
): NodeMarkOption[] {
  const flagLabel = flagLabelOf(model);
  const states = model.states ?? [];
  const hideFlag = states.includes(flagLabel) && !current?.flag;
  return [
    { mark: null, label: t(toneLabelKey("default")), colorVar: null },
    ...(hideFlag ? [] : [{ mark: "flag" as const, label: flagLabel, colorVar: "var(--accent)" }]),
    ...states.map((name, idx) => ({ mark: idx, label: name, colorVar: stateSlotDef(idx).colorVar })),
  ];
}

/** No-op in JSON IR (classDef healing is retired). Kept for call-site compatibility. */
export function restyleTones(source: string): string {
  return source;
}
