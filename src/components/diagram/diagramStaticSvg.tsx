/**
 * diagramStaticSvg — JSON IR v1 → `<svg>` 하나. 고스트(프리셋 호버)·프리뷰 패널·썸네일이 공용으로 쓴다.
 *
 * 캔버스(FlowCanvas)와 **같은 산수**를 쓴다 — `nodeSizes`·`layoutPositions`(`layoutFor`: `model.layout` 의 배치, 없으면 dagre)·`groupBoxes` 로 상자를
 * 놓고, `flowEdgePath` 의 경로 함수로 선을 긋고, 상태 슬롯 색은 `stateSlotDef` 에서 읽는다. 그래서 정적
 * 그림이 클릭 뒤 열리는 캔버스와 같은 자리에 같은 색으로 선다. React Flow 패키지는 import 하지 않는다
 * (테스트가 소스 문자열로 고정) — 이 파일은 React 순수 렌더(훅 없음)라 어디서든 마운트 비용 없이 그릴 수 있다.
 *
 * 노드마다 `<g data-node={id}>`, 엣지마다 `<g data-edge={id}>`, 그룹마다 `<g data-group={id}>`.
 *
 * ponytail: 라벨 폭은 `labelWidth` 추정치(실측 아님 — flowLayout.ts 의 같은 주석). 글자가 상자를 몇 px
 * 넘칠 수 있고 넘치면 그냥 잘린다(`clip-path` 없음). 도형은 캔버스 CSS 를 SVG 로 옮긴 것: rect/round 는
 * rx, stadium 은 rx=h/2, circle 은 ellipse(캔버스도 border-radius:50% 라 정원이 아니다), diamond 는 캔버스와
 * 같은 좌우 뾰족 육각형(14px). 마커 id 는 고정 — 한 문서에 SVG 가 여럿이면 첫 번째 것을 공유하는데
 * 모양이 같아 무해하다. 업그레이드 경로: 인스턴스별 id 가 필요해지면 props 로 접두사를 받는다.
 */
import type { DiagramModel, DiagramNode } from "./diagramSchema";
import { NODE_DESC_H, NODE_LINE_H, GROUP_TITLE_H, groupBoxes, layoutFor, layoutPositions, nodeSizes, quadrantAxes } from "./flowLayout";
import { edgeOffsets, floatingEdgePath, orthogonalEdgePath, selfLoopPath, sequenceEdgePath, type Rect } from "./flowEdgePath";
import { stateSlotDef } from "./diagramStyles";

export interface DiagramStaticSvgProps {
  model: DiagramModel;
  width?: number | string;
  height?: number | string;
  className?: string;
  /** 부모 상자에 맞춘다 — 모든 노드가 보이도록 줄이되(meet), 자연 크기(viewBox 1:1) 이상으로는 키우지 않는다.
   *  width/height 는 무시. 고스트·프리뷰처럼 상자 크기를 컴포넌트가 모르는 자리용. */
  fit?: boolean;
}

/** 내용 bbox 바깥 여백(px, viewBox 단위). */
const PAD = 16;
/** 캔버스 노드 라벨과 같은 12px(`--text-sm`) — `labelWidth` 가 이 크기로 보정돼 있다. */
const FONT = 12;
const DESC_FONT = 10;
const LABEL_FONT = 10;
/** 캔버스 CSS `clip-path: polygon(14px 0, …)` 의 그 14px. */
const DIAMOND_TIP = 14;

/** 좌우 뾰족 육각형의 꼭짓점 — 여기(정적 SVG)와 FlowNode 의 테두리 polygon 이 같은 점을 쓴다. */
export function hexagonPoints(x: number, y: number, width: number, height: number): string {
  return [
    [x + DIAMOND_TIP, y],
    [x + width - DIAMOND_TIP, y],
    [x + width, y + height / 2],
    [x + width - DIAMOND_TIP, y + height],
    [x + DIAMOND_TIP, y + height],
    [x, y + height / 2],
  ]
    .map((p) => p.join(","))
    .join(" ");
}
const ARROW = "diagram-static-arrow";

const EDGE_STROKE = "color-mix(in srgb, var(--text) 32%, transparent)";
const TONE_STROKE: Record<string, string> = {
  accent: "var(--accent)",
  warn: "var(--danger-soft)",
  done: "var(--ok)",
  muted: "var(--muted)",
};

/** 캔버스 CSS(`.diagram-flow-node[data-state]`/`[data-flag]`)를 SVG 프레젠테이션 속성으로. */
function nodePaint(node: DiagramNode): { stroke: string; fill: string; dash?: string; text: string } {
  if (node.flag) {
    return { stroke: "var(--accent)", fill: "color-mix(in srgb, var(--accent) 8%, var(--surface))", text: "var(--text)" };
  }
  if (node.state !== undefined) {
    const slot = stateSlotDef(node.state);
    return {
      stroke: slot.colorVar,
      fill: `color-mix(in srgb, ${slot.colorVar} 18%, var(--surface))`,
      dash: slot.borderStyle === "dashed" ? "4 3" : undefined,
      text: slot.colorVar === "var(--muted)" ? "var(--muted)" : "var(--text)",
    };
  }
  return { stroke: "color-mix(in srgb, var(--text) 22%, transparent)", fill: "var(--surface-base)", text: "var(--text)" };
}

function shapeEl(node: DiagramNode, r: Rect, paint: ReturnType<typeof nodePaint>) {
  const common = { fill: paint.fill, stroke: paint.stroke, strokeWidth: 1, strokeDasharray: paint.dash };
  switch (node.shape) {
    case "circle":
      return <ellipse cx={r.x + r.width / 2} cy={r.y + r.height / 2} rx={r.width / 2} ry={r.height / 2} {...common} />;
    case "diamond":
      return <polygon points={hexagonPoints(r.x, r.y, r.width, r.height)} {...common} />;
    case "stadium":
      return <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={r.height / 2} {...common} />;
    case "round":
      return <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={10} {...common} />;
    default:
      return <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={4} {...common} />;
  }
}

function edgeDash(line?: string): string | undefined {
  if (line === "dotted") return "2 3";
  if (line === "dashed") return "6 4";
  return undefined;
}

export function DiagramStaticSvg({ model, width, height, className, fit }: DiagramStaticSvgProps) {
  if (!model.structured || model.empty) return null;

  const sizes = nodeSizes(model);
  const positions = layoutPositions(model);
  const rects: Record<string, Rect> = {};
  for (const node of model.nodes) {
    const at = positions[node.id];
    const size = sizes[node.id];
    if (at && size) rects[node.id] = { ...at, ...size };
  }
  const groups = groupBoxes(model, positions, sizes);
  const axes = quadrantAxes(model, groups);
  /** sequence 의 메시지 선 y·라이프라인 아래 끝 — 캔버스(`FlowCanvas`)와 같은 `layoutFor` 결과. */
  const seq = model.layout === "sequence" ? layoutFor(model, sizes) : null;
  const offsets = edgeOffsets(model.edges.map((e) => ({ id: e.id, source: e.from, target: e.to })));
  const obstacles = Object.values(rects);

  const boxes = [...Object.values(rects), ...Object.values(groups)];
  if (!boxes.length) return null;
  const minX = Math.min(...boxes.map((b) => b.x)) - PAD;
  const minY = Math.min(...boxes.map((b) => b.y)) - PAD;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + PAD;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height), seq?.lifelineH ?? -Infinity) + PAD;

  const marker = (id: string, stroke: string) => (
    <marker
      key={id}
      id={id}
      markerWidth="14"
      markerHeight="14"
      markerUnits="userSpaceOnUse"
      viewBox="-10 -10 20 20"
      orient="auto-start-reverse"
      refX="0"
      refY="0"
    >
      <polyline points="-5,-4 0,0 -5,4" fill="none" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </marker>
  );

  return (
    <svg
      className={className}
      data-testid="diagram-static-svg"
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      width={fit ? "100%" : width}
      height={fit ? "100%" : height}
      role="img"
      style={
        fit
          ? { fontFamily: "var(--font-body)", display: "block", maxWidth: maxX - minX, maxHeight: maxY - minY }
          : { fontFamily: "var(--font-body)", display: "block", maxWidth: "100%" }
      }
    >
      <defs>
        {marker(ARROW, EDGE_STROKE)}
        {Object.entries(TONE_STROKE).map(([tone, stroke]) => marker(`${ARROW}-${tone}`, stroke))}
      </defs>

      {/* quadrant 축 십자 + axes 라벨 — 캔버스의 배경 레이어(`FlowCanvas` ViewportPortal)와 같은 `quadrantAxes` 산수. */}
      {axes && (
        <g data-axes="" stroke={EDGE_STROKE} strokeWidth={1} fontSize={LABEL_FONT} fill="var(--muted)">
          <line x1={axes.left} y1={axes.y} x2={axes.right} y2={axes.y} />
          <line x1={axes.x} y1={axes.top} x2={axes.x} y2={axes.bottom} />
          <text x={axes.left} y={axes.y - 6} stroke="none" textAnchor="start">{model.axes?.x[0]}</text>
          <text x={axes.right} y={axes.y - 6} stroke="none" textAnchor="end">{model.axes?.x[1]}</text>
          <text x={axes.x + 6} y={axes.bottom} stroke="none">{model.axes?.y[0]}</text>
          <text x={axes.x + 6} y={axes.top + LABEL_FONT} stroke="none">{model.axes?.y[1]}</text>
        </g>
      )}

      {/* sequence 라이프라인 — 캔버스 배경 레이어(`FlowCanvas` ViewportPortal)와 같은 자리의 점선. */}
      {seq?.lifelineH !== undefined && (
        <g data-lifelines="" stroke={EDGE_STROKE} strokeWidth={1} strokeDasharray="4 3">
          {Object.values(rects).map((r, i) => (
            <line key={i} x1={r.x + r.width / 2} y1={r.y + r.height} x2={r.x + r.width / 2} y2={seq.lifelineH} />
          ))}
        </g>
      )}

      {model.groups.map((group) => {
        const box = groups[group.id];
        if (!box) return null;
        const stroke = (group.tone && TONE_STROKE[group.tone]) || "color-mix(in srgb, var(--divider) 80%, transparent)";
        return (
          <g key={group.id} data-group={group.id}>
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={16}
              fill="color-mix(in srgb, var(--surface-base) 40%, transparent)"
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            <text x={box.x + 12} y={box.y + GROUP_TITLE_H * 0.7} fontSize={LABEL_FONT} fontWeight={600} fill="var(--muted)">
              {group.title}
            </text>
          </g>
        );
      })}

      {model.edges.map((edge) => {
        const from = rects[edge.from];
        const to = rects[edge.to];
        if (!from || !to) return null;
        const offset = offsets[edge.id] ?? 0;
        const anchorY = seq?.edgeAnchors?.[edge.id]?.y;
        const geo =
          anchorY !== undefined
            ? sequenceEdgePath(from, to, anchorY)
            : edge.from === edge.to
            ? selfLoopPath(from, offset)
            : model.route === "orthogonal"
              ? orthogonalEdgePath(from, to, offset, obstacles, edge.sourceHandle, edge.targetHandle)
              : floatingEdgePath(from, to, offset, obstacles, edge.sourceHandle, edge.targetHandle);
        const stroke = (edge.tone && TONE_STROKE[edge.tone]) || EDGE_STROKE;
        const markerId = edge.tone && TONE_STROKE[edge.tone] ? `${ARROW}-${edge.tone}` : ARROW;
        const arrow = edge.arrow ?? "end";
        const line = edge.line ?? "solid";
        const strokeWidth = line === "thick" ? 3 : line === "double" ? 4 : 1.5;
        return (
          <g key={edge.id} data-edge={edge.id}>
            <path
              d={geo.path}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray={edgeDash(line)}
              markerEnd={arrow === "none" ? undefined : `url(#${markerId})`}
              markerStart={arrow === "both" ? `url(#${markerId})` : undefined}
            />
            {line === "double" && <path d={geo.path} fill="none" stroke="var(--surface-base)" strokeWidth={1.5} />}
            {edge.label && (
              <text
                x={geo.labelX}
                y={geo.labelY}
                fontSize={LABEL_FONT}
                fill="var(--muted)"
                textAnchor="middle"
                dominantBaseline="middle"
                paintOrder="stroke"
                stroke="var(--surface)"
                strokeWidth={3}
                strokeLinejoin="round"
              >
                {edge.label}
              </text>
            )}
          </g>
        );
      })}

      {model.nodes.map((node) => {
        const r = rects[node.id];
        if (!r) return null;
        const paint = nodePaint(node);
        const cx = r.x + r.width / 2;
        // 설명이 있으면 라벨이 위로 올라가고 설명이 그 아래 한 줄(캔버스의 data-desc 배치). 구획(rows)은
        // 그 아래 구획선 밑에 NODE_LINE_H 씩 — 라벨·설명은 구획을 뺀 윗부분의 가운데.
        const rows = node.rows ?? [];
        const rowsH = rows.length * NODE_LINE_H;
        const labelY = node.desc ? r.y + (r.height - rowsH - NODE_DESC_H) / 2 : r.y + (r.height - rowsH) / 2;
        const rowsTop = r.y + r.height - rowsH;
        return (
          <g key={node.id} data-node={node.id}>
            {shapeEl(node, r, paint)}
            <text
              x={cx}
              y={labelY}
              fontSize={FONT}
              fontWeight={600}
              fill={paint.text}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {node.icon ? `${node.icon} ${node.label}` : node.label}
            </text>
            {node.desc && (
              <text x={cx} y={labelY + NODE_DESC_H} fontSize={DESC_FONT} fill="var(--muted)" textAnchor="middle" dominantBaseline="middle">
                {node.desc}
              </text>
            )}
            {node.tag && (
              <text x={r.x + r.width - 6} y={r.y + 8} fontSize={LABEL_FONT} fill="var(--accent)" textAnchor="end" dominantBaseline="middle">
                {node.tag}
              </text>
            )}
            {rows.length > 0 && (
              <g data-rows="">
                <line x1={r.x} y1={rowsTop} x2={r.x + r.width} y2={rowsTop} stroke={paint.stroke} strokeWidth={1} />
                {rows.map((row, i) => (
                  <text key={i} x={r.x + 8} y={rowsTop + i * NODE_LINE_H + NODE_LINE_H / 2} fontSize={DESC_FONT} fill="var(--muted)" dominantBaseline="middle">
                    {row}
                  </text>
                ))}
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
