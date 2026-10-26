import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SectionPreview } from "./SectionPreview";
import { diagramTemplateSource } from "../diagram/diagramStarter";
import { parseDiagramJson } from "../diagram/diagramSchema";
import { t } from "../../i18n/t";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));

// 프리뷰가 부르는 건 note_get 하나 — 섹션 본문은 DB 에서 다시 읽는다(CLAUDE.md 함정 4).
function noteWith(section: { id: string; name: string; kind: string; body_md: string }) {
  callMock.mockImplementation(async (cmd: string) => {
    if (cmd === "note_get") return { note: { id: "n1", title: "t" }, sections: [section] };
    return {};
  });
}

describe("SectionPreview — 관계도 분기", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("관계도 섹션은 라벨 칩이 아니라 정적 SVG 로 그린다 — 노드 수 = <g data-node> 수, 개수 줄은 유지", async () => {
    const source = diagramTemplateSource("people");
    noteWith({ id: "s1", name: "관계도", kind: "diagram", body_md: source });
    const { container } = render(<SectionPreview noteId="n1" sectionId="s1" />);
    await waitFor(() => expect(screen.getByTestId("section-preview-diagram")).toBeTruthy());

    const model = parseDiagramJson(source);
    expect(container.querySelectorAll('svg[data-testid="diagram-static-svg"]').length).toBe(1);
    expect(container.querySelectorAll("g[data-node]").length).toBe(model.nodes.length);
    expect(container.querySelectorAll("g[data-edge]").length).toBe(model.edges.length);
    expect(screen.getByText(t("editor.diagram_count_nodes", { n: model.nodes.length }))).toBeTruthy();
    expect(screen.getByText(t("editor.diagram_count_edges", { n: model.edges.length }))).toBeTruthy();
  });

  it("파싱 안 되는 관계도 본문은 SVG 없이 개수 0 줄만 — 프리뷰가 죽지 않는다", async () => {
    noteWith({ id: "s2", name: "깨진 관계도", kind: "diagram", body_md: "graph TD\nA-->B" });
    const { container } = render(<SectionPreview noteId="n1" sectionId="s2" />);
    await waitFor(() => expect(screen.getByTestId("section-preview-diagram")).toBeTruthy());
    expect(container.querySelector('svg[data-testid="diagram-static-svg"]')).toBeNull();
    expect(screen.getByText(t("editor.diagram_count_nodes", { n: 0 }))).toBeTruthy();
  });
});
