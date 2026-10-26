import type { DiagramEdge } from "./diagramModel";
import type { LayoutBox, XY } from "./flowLayout";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/**
 * 캔버스가 툴바에 넘기는 명령 핸들. 없는 멤버 = 그 경로에 없는 동사 → 툴바가 버튼을 아예 안 그린다
 * (verbs.tsx 의 "주어 없는 동사는 존재하지 않는다" 규칙의 표면 버전 — disabled 로 남기지 않는다).
 */
export interface DiagramCanvasApi {
  addNode: () => void;
  openRename: (id: string) => void;
  openRelabel: (edge: DiagramEdge) => void;
  openGroupRename: (id: string) => void;
  createGroup: (memberIds: string[]) => void;
  addFrame?: () => void;
  /** §4.4.3-③ 이동거리 완화: 주어 칩을 누르면 그 대상으로 화면이 돌아간다. */
  focusNode?: (id: string) => void;
  arrange?: (plan: (boxes: LayoutBox[]) => Record<string, XY>, ids?: string[]) => void;
  autoLayout?: () => void;
  exportPng?: () => void;
  exportPngAttach?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  fitView?: () => void;
  reach?: (nodeId: string, direction: "upstream" | "downstream" | "both" | "off") => void;
  getReach?: () => { nodeId: string; direction: "upstream" | "downstream" | "both" } | null;
  openFinder?: () => void;
  clearDimming?: () => void;
  toggleLegend?: () => void;
  isLegendOpen?: () => boolean;
  toggleLock?: () => void;
  isLocked?: () => boolean;
}
