import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MobileDiagramSheet } from "./MobileDiagramSheet";
import { DIAGRAM_TEMPLATE_IDS, diagramTemplateSource } from "../components/diagram/diagramStarter";
import { parseDiagram } from "../components/diagram/diagramModel";

describe("MobileDiagramSheet — the mobile face of the shared template gallery", () => {
  it("renders one row per template from diagramStarter (never its own list) and nothing when closed", () => {
    const { unmount } = render(<MobileDiagramSheet open={false} onClose={() => {}} onPick={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    render(<MobileDiagramSheet open onClose={() => {}} onPick={() => {}} />);
    for (const id of DIAGRAM_TEMPLATE_IDS) expect(screen.getByTestId(`mobile-diagram-tpl-${id}`)).toBeTruthy();
    expect(screen.getByTestId("mobile-diagram-text-start")).toBeTruthy();
    // 템플릿 N개 + 텍스트로 시작 1 + 닫기 1
    expect(screen.getAllByRole("button").length).toBe(DIAGRAM_TEMPLATE_IDS.length + 2);
  });

  it("텍스트로 시작 → 파싱 성공하면 onPick(name, JSON) 을 부르고 닫는다", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<MobileDiagramSheet open onClose={onClose} onPick={onPick} />);

    fireEvent.click(screen.getByTestId("mobile-diagram-text-start"));
    fireEvent.change(screen.getByTestId("diagram-text-input"), { target: { value: "A -> B" } });
    fireEvent.click(screen.getByTestId("diagram-text-apply"));

    expect(onPick).toHaveBeenCalledTimes(1);
    const [, source] = onPick.mock.calls[0] as [string, string];
    const model = parseDiagram(source);
    expect(model.nodes.map((n) => n.label)).toEqual(["A", "B"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("텍스트로 시작 → 파싱 실패하면 onPick 을 부르지 않고 오류를 보여준다", () => {
    const onPick = vi.fn();
    render(<MobileDiagramSheet open onClose={() => {}} onPick={onPick} />);

    fireEvent.click(screen.getByTestId("mobile-diagram-text-start"));
    fireEvent.change(screen.getByTestId("diagram-text-input"), { target: { value: "A\n    B" } });
    fireEvent.click(screen.getByTestId("diagram-text-apply"));

    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("diagram-text-error")).toBeTruthy();
  });

  it("picking a template hands the SHARED source (byte-identical to desktop's) to onPick, then closes", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<MobileDiagramSheet open onClose={onClose} onPick={onPick} />);

    fireEvent.click(screen.getByTestId("mobile-diagram-tpl-people"));

    expect(onPick).toHaveBeenCalledTimes(1);
    const [name, source] = onPick.mock.calls[0] as [string, string];
    expect(source).toBe(diagramTemplateSource("people"));
    // Same editor.diagram_tpl_* string the desktop picker shows (i18n en: "People & Team Network").
    expect(name).toBe("People & Team Network");
    expect(onClose).toHaveBeenCalled();
  });

  it("every offered template is structured-editable, so the mobile forms are never dead on a fresh section", () => {
    for (const id of DIAGRAM_TEMPLATE_IDS) {
      const model = parseDiagram(diagramTemplateSource(id));
      expect(model.structured, id).toBe(true);
      expect(model.nodes.length, id).toBeGreaterThan(0);
    }
  });
});
