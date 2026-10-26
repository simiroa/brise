import type { DiagramTypeDef } from "./_def";

/** 배포 구성도 — dagre, route:"orthogonal"(기술 구조도의 직각 선). 클라우드 안 요소는 group. */
export const deploy: DiagramTypeDef = {
  id: "deploy",
  group: "structure",
  nameKey: "editor.diagram_tpl_deploy",
  hintKey: "editor.diagram_tpl_deploy_hint",
  aiHintKey: "editor.diagram_tpl_deploy_ai_hint",
  aiVocab: '배포 구성 — route:"orthogonal", 사용자→CDN→로드밸런서→서버→DB 순으로 from→to, 같은 인프라 경계는 group, 정상/경고/장애는 states',
  seed: {
    v: 1,
    type: "deploy",
    route: "orthogonal",
    states: ["정상", "경고", "장애"],
    nodes: [
      { id: "n1", label: "사용자", shape: "circle" },
      { id: "n2", label: "CDN", shape: "stadium", state: 0 },
      { id: "n3", label: "로드밸런서", state: 0, group: "g1" },
      { id: "n4", label: "웹 서버 A", state: 0, group: "g1" },
      { id: "n5", label: "웹 서버 B", state: 1, group: "g1" },
      { id: "n6", label: "앱 서버", state: 0, group: "g1" },
      { id: "n7", label: "DB 프라이머리", shape: "round", state: 0, group: "g1" },
      { id: "n8", label: "DB 레플리카", shape: "round", state: 2, group: "g1" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "HTTPS" },
      { id: "e2", from: "n2", to: "n3" },
      { id: "e3", from: "n3", to: "n4" },
      { id: "e4", from: "n3", to: "n5" },
      { id: "e5", from: "n4", to: "n6" },
      { id: "e6", from: "n5", to: "n6" },
      { id: "e7", from: "n6", to: "n7", label: "쓰기" },
      { id: "e8", from: "n7", to: "n8", label: "복제", line: "dashed" },
    ],
    groups: [
      { id: "g1", title: "클라우드 VPC" },
    ],
  },
};
