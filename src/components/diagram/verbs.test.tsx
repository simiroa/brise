import { describe, it, expect, vi } from "vitest";
import { canvasVerbs, nodeVerbs } from "./verbs";
import { parseDiagram } from "./diagramModel";
import { onAppNotice } from "../../lib/invoke";
import type { DiagramActions } from "./diagramActions";

const model = parseDiagram(JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "users", rows: ["id: uuid", "email: text"] }], edges: [] }));
const actions = () => ({ setNodeRows: vi.fn() }) as unknown as DiagramActions;

describe("nodeVerbs — 구획 편집은 빠졌다 (GRILL-2026-10-19 R6)", () => {
  it("rows 가 있는 노드에도 구획·배지·아이콘·설명·여기서 연결 동사가 없다 — 데이터는 그대로, 편집은 소스 보기", () => {
    const prompt = vi.spyOn(window, "prompt");
    const ids = nodeVerbs({ node: model.nodes[0], model, actions: actions() }).map((v) => v.id);
    for (const gone of ["diagram-node-rows", "diagram-tag", "diagram-node-icon", "diagram-node-desc", "diagram-connect"]) {
      expect(ids).not.toContain(gone);
    }
    expect(model.nodes[0].rows).toEqual(["id: uuid", "email: text"]);
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});

describe("canvasVerbs — 텍스트로 추가 (D4)", () => {
  it("onAddText 가 있으면 인라인을 열 뿐, addFromText 는 호출하지 않는다", () => {
    const onAddText = vi.fn();
    const addFromText = vi.fn(() => ({ ok: true }));
    const actions = { addFromText } as unknown as DiagramActions;
    const verb = canvasVerbs({ actions, onAddText }).find((v) => v.id === "diagram-add-text")!;
    verb.run!();
    expect(onAddText).toHaveBeenCalledTimes(1);
    expect(addFromText).not.toHaveBeenCalled();
  });

  it("onAddText 없으면 prompt 폴백 — 입력을 addFromText 로 넘긴다", () => {
    const addFromText = vi.fn(() => ({ ok: true }));
    const actions = { addFromText } as unknown as DiagramActions;
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("A -> B");
    canvasVerbs({ actions }).find((v) => v.id === "diagram-add-text")!.run!();
    expect(addFromText).toHaveBeenCalledWith("A -> B");
    prompt.mockRestore();
  });

  it("prompt 취소(null)면 addFromText 를 부르지 않는다", () => {
    const addFromText = vi.fn(() => ({ ok: true }));
    const actions = { addFromText } as unknown as DiagramActions;
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    canvasVerbs({ actions }).find((v) => v.id === "diagram-add-text")!.run!();
    expect(addFromText).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it("파싱 실패면 줄 번호와 번역된 사유를 담은 알림을 띄운다", () => {
    const addFromText = vi.fn(() => ({ ok: false, error: "indent_jump", line: 2 }));
    const actions = { addFromText } as unknown as DiagramActions;
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("A\n    B");
    const notices: string[] = [];
    onAppNotice((m) => notices.push(m));
    canvasVerbs({ actions }).find((v) => v.id === "diagram-add-text")!.run!();
    expect(notices).toHaveLength(1);
    prompt.mockRestore();
  });
});
