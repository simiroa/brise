import type { DiagramTypeDef } from "./_def";

/** 엔티티 관계 — dagre LR + 노드 rows(컬럼). 엣지 라벨이 카디널리티. */
export const er: DiagramTypeDef = {
  id: "er",
  group: "structure",
  nameKey: "editor.diagram_tpl_er",
  hintKey: "editor.diagram_tpl_er_hint",
  aiHintKey: "editor.diagram_tpl_er_ai_hint",
  aiVocab: '엔티티 관계(ER) — direction:"LR", 노드 = 테이블, rows = ["id: uuid", "email: text"] 처럼 컬럼 목록, 엣지 라벨 = "1:N" 같은 카디널리티',
  seed: {
    v: 1,
    type: "er",
    direction: "LR",
    states: ["핵심", "참조", "로그"],
    nodes: [
      { id: "n1", label: "users", state: 0, rows: ["id: uuid", "email: text", "created_at: timestamp"] },
      { id: "n2", label: "orders", state: 0, rows: ["id: uuid", "user_id: uuid", "total: integer"] },
      { id: "n3", label: "order_items", state: 1, rows: ["id: uuid", "order_id: uuid", "product_id: uuid", "qty: integer"] },
      { id: "n4", label: "products", state: 1, rows: ["id: uuid", "name: text", "price: integer"] },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "1:N" },
      { id: "e2", from: "n2", to: "n3", label: "1:N" },
      { id: "e3", from: "n4", to: "n3", label: "1:N" },
    ],
  },
};
