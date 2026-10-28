import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskAiTileGrid } from "./AskAiTileGrid";
import type { AiActionPreset } from "../../stores/aiPrompts";
import type { AskAiHistoryEntry } from "../../lib/askAiHistory";
import type { ComposerDoc } from "./composer/types";

const tile = (id: string, over: Partial<AiActionPreset> = {}): AiActionPreset => ({
  id,
  name: `이름 ${id}`,
  prompt: `${id} 프롬프트`,
  kind: "text",
  isBuiltin: true,
  hidden: false,
  label: id.slice(0, 2),
  icon: "sparkles",
  targets: ["note"],
  where: "section",
  ...over,
});

const tiles = [tile("aa"), tile("bb", { where: "note" }), tile("cc")];

const history: AskAiHistoryEntry[] = [
  {
    id: "h1",
    at: new Date(2026, 8, 3).getTime(),
    doc: [
      { t: "text", v: "다음 내용을 " },
      { t: "slot", key: "lang", kind: "lang", v: "영어" },
      { t: "text", v: "로 번역해줘" },
    ],
    refs: [{ k: "body" }, { k: "weather" }],
    where: "section",
    targetKind: "note",
    noteTitle: "여행 기록",
  },
];

function setup(over: Partial<React.ComponentProps<typeof AskAiTileGrid>> = {}) {
  const props = {
    tiles,
    history,
    selectedId: "bb",
    recentId: "cc",
    custom: false,
    onPick: vi.fn(),
    onPickHistory: vi.fn(),
    onHover: vi.fn(),
    onEdit: vi.fn(),
    onAdd: vi.fn(),
    stampFor: vi.fn((p: AiActionPreset): ComposerDoc => [{ t: "text", v: p.prompt }]),
    describeHistoryWhere: vi.fn(() => "새 섹션"),
    ...over,
  };
  const utils = render(<AskAiTileGrid {...props} />);
  return { ...utils, props };
}

describe("AskAiTileGrid", () => {
  it("renders tiles in order with recent dot, selected state, names as aria-label, and a trailing add tile", () => {
    setup();
    const buttons = screen.getAllByRole("button").filter((b) => b.classList.contains("askai-tile"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["이름 aa", "이름 bb", "이름 cc", "Add"]);
    expect(screen.getByTestId("askai-tile-cc").dataset.recent).toBe("true");
    expect(screen.getByTestId("askai-tile-aa").dataset.recent).toBeUndefined();
    expect(screen.getByTestId("askai-tile-bb").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("askai-tile-aa").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("askai-tile-aa").title).toBe("이름 aa");
    expect(screen.getByTestId("askai-tile-aa").textContent).toBe("aa");
  });

  // 회귀(2026-10-18): 라벨 없는 사용자 프리셋은 이름 앞 4자로 잘려 「새 프리셋」이 「새 프리」로 끊겼다.
  // 이제 이름 전체를 넘기고 자르기는 CSS(두 줄 + 말줄임)가 맡는다. 전체 이름은 title 로도 남는다.
  it("a tile without a label shows the full name (CSS clamps it), with the full name as title", () => {
    setup({ tiles: [tile("nw", { label: undefined, name: "새 프리셋", isBuiltin: false })] });
    const btn = screen.getByTestId("askai-tile-nw");
    expect(btn.querySelector(".askai-tile__label")?.textContent).toBe("새 프리셋");
    expect(btn.title).toBe("새 프리셋");
  });

  it("shows the custom badge only when custom", () => {
    const { rerender, props } = setup();
    expect(screen.queryByText("Custom")).toBeNull();
    rerender(<AskAiTileGrid {...props} custom />);
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("click → onPick; hover → onHover with stampFor doc and the tile's where; leave → null", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("askai-tile-aa"));
    expect(props.onPick).toHaveBeenCalledWith(tiles[0]);

    fireEvent.mouseEnter(screen.getByTestId("askai-tile-bb"));
    expect(props.stampFor).toHaveBeenCalledWith(tiles[1]);
    expect(props.onHover).toHaveBeenLastCalledWith({ doc: [{ t: "text", v: "bb 프롬프트" }], where: "note" });

    fireEvent.mouseLeave(screen.getByTestId("askai-tile-bb").closest(".askai-tiles")!);
    expect(props.onHover).toHaveBeenLastCalledWith(null);
  });

  it("the pencil opens the editor (onEdit); the add tile opens it with a new preset (onAdd)", () => {
    const { props } = setup();
    fireEvent.click(screen.getByLabelText("Edit custom prompts"));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Add"));
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onEdit).toHaveBeenCalledTimes(1);
  });

  it("history tab lists rows with bold slots, ref chips from entry.refs, meta line and date; click → onPickHistory", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    const row = screen.getByTestId("askai-history-h1");
    expect(row.querySelector("b")?.textContent).toBe("영어");
    // 참조 칩은 문장이 아니라 entry.refs 에서 그린다(6안 D18).
    expect(Array.from(row.querySelectorAll(".askai-history__ctx")).map((e) => e.textContent)).toEqual(["Body", "Weather"]);
    expect(row.querySelector(".askai-history__text")?.textContent).toBe("다음 내용을 영어로 번역해줘");
    expect(row.textContent).toContain("여행 기록");
    expect(row.textContent).toContain("새 섹션");
    expect(row.querySelector(".askai-history__date")?.textContent).toBe("09/03");
    expect(props.describeHistoryWhere).toHaveBeenCalledWith("section");

    fireEvent.mouseEnter(row);
    expect(props.onHover).toHaveBeenLastCalledWith({ doc: history[0].doc, where: "section" });
    fireEvent.click(row);
    expect(props.onPickHistory).toHaveBeenCalledWith(history[0]);
  });

  it("history tab empty state", () => {
    setup({ history: [] });
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("No AI requests recorded yet.")).toBeTruthy();
  });

  it("both tabs render into the same fixed-height pane — switching cannot resize the modal (D20)", () => {
    const { container } = setup();
    const pane = () => container.querySelector(".askai-tiles__pane")!;
    expect(pane().querySelector(".askai-tiles__grid")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(container.querySelectorAll(".askai-tiles__pane")).toHaveLength(1);
    expect(pane().querySelector(".askai-history")).toBeTruthy();
  });
});
