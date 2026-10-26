import {
  useContext,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from "@xyflow/react";
import { t } from "../../i18n/t";
import type { EdgeLine, EdgeStyle } from "./diagramSchema";
import type { DiagramTone } from "./diagramStyles";
import { InlineEditCtx } from "./useFlowInlineEdit";
import {
  floatingEdgePath,
  orthogonalEdgePath,
  selfLoopPath,
  sequenceEdgePath,
  type Rect,
} from "./flowEdgePath";
import { NODE_H, NODE_W } from "./flowLayout";
import { DiagramInlineInput } from "./DiagramInlineInput";

/** Stroke only — every colour is a CSS variable so a theme flip needs no re-render and no re-save. */
export function strokeOf(line?: EdgeLine, style?: EdgeStyle): CSSProperties {
  const effectiveLine = line ?? (style === "dotted" ? "dotted" : style === "thick" ? "thick" : "solid");
  if (effectiveLine === "dotted") return { strokeDasharray: "2 3" };
  if (effectiveLine === "dashed") return { strokeDasharray: "6 4" };
  if (effectiveLine === "thick") return { strokeWidth: 3 };
  if (effectiveLine === "double") return { strokeWidth: 4 };
  return {};
}

/** React Flow's live box for a node — position while it is being DRAGGED. */
function rectOf(node: InternalNode): Rect {
  return {
    x: node.internals?.positionAbsolute?.x ?? node.position?.x ?? 0,
    y: node.internals?.positionAbsolute?.y ?? node.position?.y ?? 0,
    width: node.measured?.width || node.width || NODE_W,
    height: node.measured?.height || node.height || NODE_H,
  };
}

/**
 * BriseFlowEdge
 *
 * 연결선 렌더링 컴포넌트:
 * - 자기루프(selfLoopPath), 직교(orthogonalEdgePath), 곡선(floatingEdgePath) 라우팅
 * - sequence 배치(`data.anchorY` 가 있으면)는 그 y 의 수평선(sequenceEdgePath) — 오프셋·장애물 무시
 * - 더블 클릭 시 인라인 라벨 편집 열기
 * - DiagramInlineInput을 활용한 엣지 라벨 인라인 편집
 */
export function BriseFlowEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
  data,
  label,
  markerStart,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  const inlineCtx = useContext(InlineEditCtx);
  if (!from || !to) return null;
  const offset = typeof data?.offset === "number" ? data.offset : 0;
  const route = data?.route === "orthogonal" ? "orthogonal" : "curve";
  const obstacles = Array.isArray(data?.obstacles) ? (data.obstacles as Rect[]) : [];
  const line = data?.line;
  const effectiveSourceHandle = sourceHandleId ?? (data?.sourceHandle as string | undefined);
  const effectiveTargetHandle = targetHandleId ?? (data?.targetHandle as string | undefined);

  const fromRect = rectOf(from);
  const toRect = rectOf(to);
  const anchorY = typeof data?.anchorY === "number" ? data.anchorY : undefined;
  const geo =
    anchorY !== undefined
      ? sequenceEdgePath(fromRect, toRect, anchorY)
      : source === target
      ? selfLoopPath(fromRect, offset)
      : route === "orthogonal"
      ? orthogonalEdgePath(fromRect, toRect, offset, obstacles, effectiveSourceHandle, effectiveTargetHandle)
      : floatingEdgePath(fromRect, toRect, offset, obstacles, effectiveSourceHandle, effectiveTargetHandle);

  const edit = inlineCtx?.edit;
  const commit = inlineCtx?.commit;
  const cancel = inlineCtx?.cancel;
  const isEditing = !!(
    edit?.kind === "label" &&
    edit.edgeId === id
  );

  const [val, setVal] = useState(edit?.kind === "label" && isEditing ? edit.value : "");
  useEffect(() => {
    if (edit?.kind === "label" && isEditing) {
      setVal(edit.value);
    }
  }, [edit, isEditing]);

  const currentLabelText = isEditing ? val : (typeof label === "string" ? label : "");
  const dynamicCharWidth = `${Math.max(4, currentLabelText.length + 2)}ch`;
  const isDimmed = Boolean(data?.dimmed);
  const isDouble = line === "double";

  const tone = data?.tone as DiagramTone | undefined;
  const toneColor =
    tone === "accent"
      ? "var(--accent)"
      : tone === "warn"
      ? "var(--danger-soft)"
      : tone === "done"
      ? "var(--ok)"
      : tone === "muted"
      ? "var(--muted)"
      : undefined;

  const edgeStyle: CSSProperties = {
    ...style,
    ...(toneColor ? { stroke: toneColor } : {}),
    ...(isDimmed ? { opacity: 0.15 } : {}),
    transition: "opacity var(--dur-fast)",
  };

  return (
    <>
      <g
        data-tone={tone && tone !== "default" ? tone : undefined}
        data-dimmed={isDimmed ? "true" : undefined}
        style={isDimmed ? { opacity: 0.15, transition: "opacity var(--dur-fast)" } : undefined}
        onDoubleClick={(e) => {
          e.stopPropagation();
          inlineCtx?.openRelabel?.(id);
        }}
      >
        {isDouble ? (
          <>
            <BaseEdge id={`${id}-outer`} path={geo.path} style={{ ...edgeStyle, strokeWidth: 4 }} />
            <BaseEdge
              id={id}
              path={geo.path}
              markerStart={markerStart}
              markerEnd={markerEnd}
              style={{ ...edgeStyle, strokeWidth: 1.5, stroke: "var(--surface-base)" }}
            />
          </>
        ) : (
          <BaseEdge id={id} path={geo.path} markerStart={markerStart} markerEnd={markerEnd} style={edgeStyle} />
        )}
      </g>
      <EdgeLabelRenderer>
        {isEditing ? (
          <DiagramInlineInput
            className="diagram-flow-edge-label diagram-flow-edge-label-input"
            data-edge-id={id}
            testId="diagram-inline-edge-label"
            value={val}
            onChange={(newVal) => setVal(newVal)}
            selectOnFocus
            ariaLabel={t("editor.diagram_edge_label_placeholder")}
            placeholder={t("editor.diagram_edge_label_placeholder")}
            style={{
              transform: `translate(-50%,-50%) translate(${geo.labelX}px,${geo.labelY}px)`,
              width: dynamicCharWidth,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onCommit={() => commit?.(val)}
            onCancel={() => cancel?.()}
          />
        ) : (
          <div
            className="diagram-flow-edge-label nodrag nopan nowheel"
            data-edge-id={id}
            data-empty={!label ? "true" : undefined}
            data-selected={selected || undefined}
            data-dimmed={isDimmed ? "true" : undefined}
            style={{
              transform: `translate(-50%,-50%) translate(${geo.labelX}px,${geo.labelY}px)`,
              opacity: isDimmed ? 0.15 : undefined,
              transition: "opacity var(--dur-fast)",
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              inlineCtx?.openRelabel?.(id);
            }}
          >
            {label}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
