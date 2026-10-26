/**
 * flowEdgePath — the arithmetic behind every line the React Flow canvas draws.
 *
 * React Flow's stock edges start and end at a HANDLE, so with one source and one target handle per
 * node every relation left the bottom and arrived at the top no matter where the two boxes actually
 * sat. Four things are solved here:
 *
 *   • floating endpoints — a line leaves the SOURCE BOX'S BORDER on the side facing its target.
 *   • self-loops (`A --> A`) — an arc parked beside the node, never crossing it.
 *   • parallel / round-trip relations — `edgeOffsets` fans them apart symmetrically.
 *   • route modes ("curve" | "orthogonal") and obstacle avoidance.
 *
 * No React, no @xyflow import: this file is arithmetic and pure geometry, so it can be tested without
 * mounting a canvas — the same reason flowLayout.ts is a separate module.
 */

export interface Rect {
  /** Top-left corner, canvas coordinates — React Flow's own convention for a node position. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XY {
  x: number;
  y: number;
}

/** A drawable edge: the SVG path plus where its label chip belongs (the curve or polyline midpoint). */
export interface EdgeGeometry {
  path: string;
  labelX: number;
  labelY: number;
}

/** How far apart two parallel relations are pushed, in canvas px. Wide enough that two labelled
 *  arrows between the same pair never touch, narrow enough that the pair still reads as a pair. */
export const PARALLEL_SPREAD = 34;

export const round = (v: number): number => Math.round(v * 100) / 100;

export const centre = (r: Rect): XY => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * 사방 포트 ID에 따른 노드 경계의 물리적 좌표를 반환합니다.
 * ID가 없거나 알 수 없는 경우 null을 반환합니다.
 */
export function portPosition(rect: Rect, handleId?: string | null): XY | null {
  if (!handleId) return null;
  switch (handleId) {
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    default:
      return null;
  }
}

/**
 * 사방 포트 ID에 따른 바깥 방향 단위 법선 벡터(Normal vector)를 반환합니다.
 */
export function portNormal(handleId?: string | null): XY | null {
  if (!handleId) return null;
  switch (handleId) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    default:
      return null;
  }
}

/**
 * Where the ray from a box's centre toward `toward` crosses the box's border.
 *
 * ponytail: RECTANGLE approximation for every shape. A circle node's line therefore stops a few px
 * outside its curve at the diagonals, and a diamond's a few px outside its point. Upgrade path if
 * anyone ever notices: switch on the shape here (the caller already knows it) — the signature does
 * not have to change.
 */
export function borderPoint(rect: Rect, toward: XY): XY {
  const c = centre(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const scale = Math.min(
    dx ? rect.width / 2 / Math.abs(dx) : Infinity,
    dy ? rect.height / 2 / Math.abs(dy) : Infinity,
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** Determines if point `p` sits inside rectangle `r` with an inward inset `margin`. */
export function pointInRect(p: XY, r: Rect, margin = 2): boolean {
  return (
    p.x >= r.x + margin &&
    p.x <= r.x + r.width - margin &&
    p.y >= r.y + margin &&
    p.y <= r.y + r.height - margin
  );
}

/** Determines if two line segments (p1-p2 and p3-p4) intersect. */
export function lineSegmentsIntersect(p1: XY, p2: XY, p3: XY, p4: XY): boolean {
  const ccw = (a: XY, b: XY, c: XY) => (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  return (
    ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
    ccw(p1, p2, p3) !== ccw(p1, p2, p4)
  );
}

/** Determines if the line segment from p1 to p2 intersects rectangle `r` or enters its interior. */
export function segmentHitsRect(p1: XY, p2: XY, r: Rect, margin = 2): boolean {
  if (pointInRect(p1, r, margin) || pointInRect(p2, r, margin)) return true;
  const tl = { x: r.x + margin, y: r.y + margin };
  const tr = { x: r.x + r.width - margin, y: r.y + margin };
  const bl = { x: r.x + margin, y: r.y + r.height - margin };
  const br = { x: r.x + r.width - margin, y: r.y + r.height - margin };

  return (
    lineSegmentsIntersect(p1, p2, tl, tr) ||
    lineSegmentsIntersect(p1, p2, tr, br) ||
    lineSegmentsIntersect(p1, p2, br, bl) ||
    lineSegmentsIntersect(p1, p2, bl, tl)
  );
}

/** Tests if a polyline crosses any obstacle rectangle. */
export function polylineHitsObstacles(points: XY[], obstacles: readonly Rect[]): boolean {
  for (const obs of obstacles) {
    for (let i = 0; i < points.length - 1; i++) {
      if (segmentHitsRect(points[i], points[i + 1], obs)) {
        return true;
      }
    }
  }
  return false;
}

/** Tests if a quadratic Bezier curve crosses any obstacle rectangle by sampling. */
export function bezierHitsObstacles(p0: XY, p1: XY, p2: XY, obstacles: readonly Rect[], samples = 14): boolean {
  const pts: XY[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const inv = 1 - t;
    pts.push({
      x: inv * inv * p0.x + 2 * inv * t * p1.x + t * t * p2.x,
      y: inv * inv * p0.y + 2 * inv * t * p1.y + t * t * p2.y,
    });
  }
  return polylineHitsObstacles(pts, obstacles);
}

/** Tests if a cubic Bezier curve crosses any obstacle rectangle by sampling. */
export function cubicBezierHitsObstacles(
  p0: XY,
  p1: XY,
  p2: XY,
  p3: XY,
  obstacles: readonly Rect[],
  samples = 14,
): boolean {
  const pts: XY[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const inv = 1 - t;
    pts.push({
      x: inv * inv * inv * p0.x + 3 * inv * inv * t * p1.x + 3 * inv * t * t * p2.x + t * t * t * p3.x,
      y: inv * inv * inv * p0.y + 3 * inv * inv * t * p1.y + 3 * inv * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return polylineHitsObstacles(pts, obstacles);
}

/** Filter out source and target nodes from obstacle candidates. */
function filterObstacles(source: Rect, target: Rect, obstacles: readonly Rect[]): Rect[] {
  return obstacles.filter(
    (o) =>
      !(Math.abs(o.x - source.x) < 1 && Math.abs(o.y - source.y) < 1) &&
      !(Math.abs(o.x - target.x) < 1 && Math.abs(o.y - target.y) < 1),
  );
}

/**
 * A relation between two different boxes: a quadratic curve between their borders.
 *
 * `offset` (from `edgeOffsets`) displaces the control point PERPENDICULAR to the centre-to-centre
 * axis. At 0 the control point IS the midpoint and the curve is a straight line — which is what a
 * lone relation should look like. The endpoints are aimed at the control point rather than at the
 * other centre, so a fanned-out edge also LEAVES the box at a different spot, not just bulges.
 *
 * ponytail: 회피 알고리즘이 아니라 2후보 중 택1이다. 노드가 밀집하면 진다. 업그레이드 경로: 그리드 기반 A*
 */
export function floatingEdgePath(
  source: Rect,
  target: Rect,
  offset = 0,
  obstacles: readonly Rect[] = [],
  sourceHandleId?: string | null,
  targetHandleId?: string | null,
): EdgeGeometry {
  const sPort = portPosition(source, sourceHandleId);
  const tPort = portPosition(target, targetHandleId);
  const sNorm = portNormal(sourceHandleId);
  const tNorm = portNormal(targetHandleId);

  const validObstacles = filterObstacles(source, target, obstacles);

  // 포트 ID가 없는 경우 기존 2차 Bézier(Q) 중심축 기반 플로팅 라우팅 유지
  if (!sPort && !tPort) {
    const s = centre(source);
    const t = centre(target);
    const len = Math.hypot(t.x - s.x, t.y - s.y) || 1;
    const nx = -(t.y - s.y) / len;
    const ny = (t.x - s.x) / len;

    const makeCandidate = (candOffset: number): { geo: EdgeGeometry; hits: boolean } => {
      const ctrl = {
        x: (s.x + t.x) / 2 + nx * candOffset * 2,
        y: (s.y + t.y) / 2 + ny * candOffset * 2,
      };
      const from = borderPoint(source, ctrl);
      const to = borderPoint(target, ctrl);
      const hits = validObstacles.length > 0 && bezierHitsObstacles(from, ctrl, to, validObstacles);
      return {
        geo: {
          path: `M ${round(from.x)},${round(from.y)} Q ${round(ctrl.x)},${round(ctrl.y)} ${round(to.x)},${round(to.y)}`,
          labelX: round((from.x + to.x) / 4 + ctrl.x / 2),
          labelY: round((from.y + to.y) / 4 + ctrl.y / 2),
        },
        hits,
      };
    };

    // Candidate 1: standard offset
    const cand1 = makeCandidate(offset);
    if (!cand1.hits || validObstacles.length === 0) {
      return cand1.geo;
    }

    // Candidate 2: opposite side offset
    const altOffset = offset === 0 ? -48 : -offset;
    const cand2 = makeCandidate(altOffset);
    if (!cand2.hits) {
      return cand2.geo;
    }

    if (offset === 0) {
      const candPlus = makeCandidate(48);
      if (!candPlus.hits) {
        return candPlus.geo;
      }
    }

    return cand1.geo;
  }

  // 포트가 지정된 경우: 포트 경계 좌표에서 출발/도착 및 노멀 벡터 방향으로 먼저 확장
  const from = sPort ?? borderPoint(source, tPort ?? centre(target));
  const to = tPort ?? borderPoint(target, sPort ?? centre(source));
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const nx = -(to.y - from.y) / len;
  const ny = (to.x - from.x) / len;
  const ext = Math.max(24, Math.min(len * 0.35, 90));

  const makePortCandidate = (candOffset: number): { geo: EdgeGeometry; hits: boolean } => {
    const cp1 = {
      x: (sNorm ? from.x + sNorm.x * ext : from.x + (to.x - from.x) * 0.25) + nx * candOffset,
      y: (sNorm ? from.y + sNorm.y * ext : from.y + (to.y - from.y) * 0.25) + ny * candOffset,
    };
    const cp2 = {
      x: (tNorm ? to.x + tNorm.x * ext : to.x - (to.x - from.x) * 0.25) + nx * candOffset,
      y: (tNorm ? to.y + tNorm.y * ext : to.y - (to.y - from.y) * 0.25) + ny * candOffset,
    };
    const hits = validObstacles.length > 0 && cubicBezierHitsObstacles(from, cp1, cp2, to, validObstacles);
    return {
      geo: {
        path: `M ${round(from.x)},${round(from.y)} C ${round(cp1.x)},${round(cp1.y)} ${round(cp2.x)},${round(cp2.y)} ${round(to.x)},${round(to.y)}`,
        labelX: round(0.125 * from.x + 0.375 * cp1.x + 0.375 * cp2.x + 0.125 * to.x),
        labelY: round(0.125 * from.y + 0.375 * cp1.y + 0.375 * cp2.y + 0.125 * to.y),
      },
      hits,
    };
  };

  const cand1 = makePortCandidate(offset);
  if (!cand1.hits || validObstacles.length === 0) {
    return cand1.geo;
  }
  const altOffset = offset === 0 ? -48 : -offset;
  const cand2 = makePortCandidate(altOffset);
  if (!cand2.hits) {
    return cand2.geo;
  }
  if (offset === 0) {
    const candPlus = makePortCandidate(48);
    if (!candPlus.hits) {
      return candPlus.geo;
    }
  }
  return cand1.geo;
}

/**
 * An orthogonal (manhattan) edge between two boxes: composed entirely of horizontal and vertical segments.
 *
 * ponytail: 회피 알고리즘이 아니라 2후보 중 택1이다. 노드가 밀집하면 진다. 업그레이드 경로: 그리드 기반 A*
 */
export function orthogonalEdgePath(
  source: Rect,
  target: Rect,
  offset = 0,
  obstacles: readonly Rect[] = [],
  sourceHandleId?: string | null,
  targetHandleId?: string | null,
): EdgeGeometry {
  const sPort = portPosition(source, sourceHandleId);
  const tPort = portPosition(target, targetHandleId);
  const sNorm = portNormal(sourceHandleId);
  const tNorm = portNormal(targetHandleId);

  const s = centre(source);
  const t = centre(target);
  const dx = t.x - s.x;
  const dy = t.y - s.y;

  const validObstacles = filterObstacles(source, target, obstacles);

  const buildGeometry = (pts: XY[]): { geo: EdgeGeometry; hits: boolean } => {
    // Simplify collinear consecutive points
    const simplified: XY[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = simplified[simplified.length - 1];
      const curr = pts[i];
      const next = pts[i + 1];
      const colX = Math.abs(prev.x - curr.x) < 1e-4 && Math.abs(curr.x - next.x) < 1e-4;
      const colY = Math.abs(prev.y - curr.y) < 1e-4 && Math.abs(curr.y - next.y) < 1e-4;
      if (!colX && !colY) {
        simplified.push(curr);
      }
    }
    simplified.push(pts[pts.length - 1]);

    const hits = validObstacles.length > 0 && polylineHitsObstacles(simplified, validObstacles);
    const pathStr = simplified.map((p, idx) => `${idx === 0 ? "M" : "L"} ${round(p.x)},${round(p.y)}`).join(" ");

    // Midpoint for label placement along total path length
    let totalLen = 0;
    const lens: number[] = [];
    for (let i = 0; i < simplified.length - 1; i++) {
      const segLen = Math.hypot(simplified[i + 1].x - simplified[i].x, simplified[i + 1].y - simplified[i].y);
      lens.push(segLen);
      totalLen += segLen;
    }
    let half = totalLen / 2;
    let lx = simplified[0].x;
    let ly = simplified[0].y;
    for (let i = 0; i < lens.length; i++) {
      if (half <= lens[i] || i === lens.length - 1) {
        const ratio = lens[i] > 0 ? half / lens[i] : 0;
        lx = simplified[i].x + (simplified[i + 1].x - simplified[i].x) * ratio;
        ly = simplified[i].y + (simplified[i + 1].y - simplified[i].y) * ratio;
        break;
      }
      half -= lens[i];
    }

    return {
      geo: {
        path: pathStr,
        labelX: round(lx),
        labelY: round(ly),
      },
      hits,
    };
  };

  // 포트 ID가 없는 경우 기존 직교 라우팅 로직 수행
  if (!sPort && !tPort) {
    const makePoints = (mode: "H-first" | "V-first" | "around-1" | "around-2"): XY[] => {
      if (mode === "around-1" || mode === "around-2") {
        if (Math.abs(dx) >= Math.abs(dy)) {
          const fromSide = dx >= 0 ? { x: source.x + source.width, y: s.y } : { x: source.x, y: s.y };
          const toSide = dx >= 0 ? { x: target.x, y: t.y } : { x: target.x + target.width, y: t.y };
          const detourY = mode === "around-1"
            ? Math.min(source.y, target.y) - 36 - Math.abs(offset)
            : Math.max(source.y + source.height, target.y + target.height) + 36 + Math.abs(offset);
          const midX1 = dx >= 0 ? fromSide.x + 12 : fromSide.x - 12;
          const midX2 = dx >= 0 ? toSide.x - 12 : toSide.x + 12;
          return [
            fromSide,
            { x: midX1, y: fromSide.y },
            { x: midX1, y: detourY },
            { x: midX2, y: detourY },
            { x: midX2, y: toSide.y },
            toSide,
          ];
        } else {
          const fromSide = dy >= 0 ? { x: s.x, y: source.y + source.height } : { x: s.x, y: source.y };
          const toSide = dy >= 0 ? { x: t.x, y: target.y } : { x: t.x, y: target.y + target.height };
          const detourX = mode === "around-1"
            ? Math.min(source.x, target.x) - 36 - Math.abs(offset)
            : Math.max(source.x + source.width, target.x + target.width) + 36 + Math.abs(offset);
          const midY1 = dy >= 0 ? fromSide.y + 12 : fromSide.y - 12;
          const midY2 = dy >= 0 ? toSide.y - 12 : toSide.y + 12;
          return [
            fromSide,
            { x: fromSide.x, y: midY1 },
            { x: detourX, y: midY1 },
            { x: detourX, y: midY2 },
            { x: toSide.x, y: midY2 },
            toSide,
          ];
        }
      }

      if (mode === "H-first") {
        const from = borderPoint(source, { x: t.x, y: s.y });
        const to = borderPoint(target, { x: s.x, y: t.y });
        const midX = (from.x + to.x) / 2 + offset;
        return [
          from,
          { x: midX, y: from.y },
          { x: midX, y: to.y },
          to,
        ];
      } else {
        const from = borderPoint(source, { x: s.x, y: t.y });
        const to = borderPoint(target, { x: t.x, y: s.y });
        const midY = (from.y + to.y) / 2 + offset;
        return [
          from,
          { x: from.x, y: midY },
          { x: to.x, y: midY },
          to,
        ];
      }
    };

    const cand1Mode = Math.abs(dx) >= Math.abs(dy) ? "H-first" : "V-first";
    const cand2Mode = cand1Mode === "H-first" ? "V-first" : "H-first";

    const c1 = buildGeometry(makePoints(cand1Mode));
    if (!c1.hits || validObstacles.length === 0) {
      return c1.geo;
    }

    const c2 = buildGeometry(makePoints(cand2Mode));
    if (!c2.hits) {
      return c2.geo;
    }

    const cAround1 = buildGeometry(makePoints("around-1"));
    if (!cAround1.hits) {
      return cAround1.geo;
    }

    const cAround2 = buildGeometry(makePoints("around-2"));
    if (!cAround2.hits) {
      return cAround2.geo;
    }

    return c1.geo;
  }

  // 포트가 지정된 경우: 포트 경계 좌표에서 출발/도착 및 노멀 벡터 방향으로 먼저 뻗어나감
  const from = sPort ?? borderPoint(source, tPort ?? t);
  const to = tPort ?? borderPoint(target, sPort ?? s);
  const lead = 24;
  const p1 = sNorm ? { x: from.x + sNorm.x * lead, y: from.y + sNorm.y * lead } : from;
  const p2 = tNorm ? { x: to.x + tNorm.x * lead, y: to.y + tNorm.y * lead } : to;

  const makePortPoints = (candOffset: number): XY[] => {
    // 1. 양쪽 모두 수직 (상/하)
    if (sNorm && tNorm && sNorm.x === 0 && tNorm.x === 0) {
      const midY = (p1.y + p2.y) / 2 + candOffset;
      return [from, p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2, to];
    }
    // 2. 양쪽 모두 수평 (좌/우)
    if (sNorm && tNorm && sNorm.y === 0 && tNorm.y === 0) {
      const midX = (p1.x + p2.x) / 2 + candOffset;
      return [from, p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2, to];
    }
    // 3. 출발 수직, 도착 수평
    if (sNorm && sNorm.x === 0 && (!tNorm || tNorm.y === 0)) {
      return [from, p1, { x: p1.x, y: p2.y }, p2, to];
    }
    // 4. 출발 수평, 도착 수직
    if (sNorm && sNorm.y === 0 && (!tNorm || tNorm.x === 0)) {
      return [from, p1, { x: p2.x, y: p1.y }, p2, to];
    }
    // 5. 한쪽만 포트인 경우
    if (!sNorm && tNorm) {
      if (tNorm.x === 0) {
        return [from, { x: from.x, y: p2.y }, p2, to];
      } else {
        return [from, { x: p2.x, y: from.y }, p2, to];
      }
    }
    return [from, p1, { x: (p1.x + p2.x) / 2 + candOffset, y: p1.y }, { x: (p1.x + p2.x) / 2 + candOffset, y: p2.y }, p2, to];
  };

  const c1 = buildGeometry(makePortPoints(offset));
  if (!c1.hits || validObstacles.length === 0) {
    return c1.geo;
  }
  const altOffset = offset === 0 ? -48 : -offset;
  const c2 = buildGeometry(makePortPoints(altOffset));
  if (!c2.hits) {
    return c2.geo;
  }
  return c1.geo;
}

/**
 * `A --> A`: a loop parked to the RIGHT of the box, never crossing it. `index` is the loop's rank
 * among the node's own self-loops, so a second one sits outside the first.
 */
export function selfLoopPath(rect: Rect, index = 0): EdgeGeometry {
  const reach = 44 + index * 20;
  const x = rect.x + rect.width;
  const top = rect.y + rect.height * 0.28;
  const bottom = rect.y + rect.height * 0.72;
  return {
    path: `M ${round(x)},${round(top)} C ${round(x + reach)},${round(top - reach)} ${round(x + reach)},${round(bottom + reach)} ${round(x)},${round(bottom)}`,
    // Cubic at t=0.5 — with these control points it lands at (x + 0.75·reach, vertical centre).
    labelX: round(x + reach * 0.75),
    labelY: round((top + bottom) / 2),
  };
}

/** sequence 자기루프 ㄷ자의 폭과 높이. */
const SEQUENCE_LOOP_W = 40;
const SEQUENCE_LOOP_H = 16;

/**
 * sequence 배치의 메시지 선 — 두 라이프라인(상자 x 중심) 사이의 **수평선**, y 는 배치(`edgeAnchors`)가
 * 정한 값. 같은 라이프라인(from·to 의 x 중심이 같다)이면 오른쪽으로 나갔다 돌아오는 작은 ㄷ자(4점).
 * 라벨은 선 바로 위 가운데. 평행 엣지 오프셋은 쓰지 않는다 — y 가 이미 다르다.
 */
export function sequenceEdgePath(from: Rect, to: Rect, y: number): EdgeGeometry {
  const x1 = round(centre(from).x);
  const x2 = round(centre(to).x);
  const ly = round(y);
  if (x1 === x2) {
    const xr = round(x1 + SEQUENCE_LOOP_W);
    const yb = round(ly + SEQUENCE_LOOP_H);
    return { path: `M ${x1},${ly} L ${xr},${ly} L ${xr},${yb} L ${x1},${yb}`, labelX: round(x1 + SEQUENCE_LOOP_W / 2), labelY: round(ly - 10) };
  }
  return { path: `M ${x1},${ly} L ${x2},${ly}`, labelX: round((x1 + x2) / 2), labelY: round(ly - 10) };
}

/**
 * Fans out every group of edges that share a node pair, keyed by edge id.
 *
 * TWO meanings, because the two path functions want two different things (and the caller already
 * branches on `source === target` to pick one):
 *   • ordinary edge → px offset for `floatingEdgePath`, symmetric around 0.
 *   • self-loop     → 0, 1, 2 … the loop's rank for `selfLoopPath`.
 *
 * The group is direction-INSENSITIVE (A→B and B→A are the same pair) and the sign is flipped for
 * the reversed member. Without that flip both edges of a round trip bulge to the same physical side
 * — each one's "perpendicular" is the other's negated — which is the overlap this exists to fix.
 */
export function edgeOffsets<T extends { id: string; source: string; target: string }>(
  edges: readonly T[],
): Record<string, number> {
  const groups = new Map<string, T[]>();
  for (const e of edges) {
    const key = e.source <= e.target ? `${e.source} ${e.target}` : `${e.target} ${e.source}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  const out: Record<string, number> = {};
  for (const group of groups.values()) {
    group.forEach((e, i) => {
      out[e.id] =
        e.source === e.target ? i : PARALLEL_SPREAD * (i - (group.length - 1) / 2) * (e.source < e.target ? 1 : -1);
    });
  }
  return out;
}
