import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagsExpandedCloud } from "./TagsExpandedCloud";
import { useSearchStore } from "../../../stores/search";
import { useNotesStore } from "../../../stores/notes";

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("TagsExpandedCloud features (inline add + drag-to-pan + 2-line cap)", () => {
  beforeEach(() => {
    useSearchStore.setState({
      selectedTags: [],
      tagMode: "and",
      statusFilter: [],
      dateRange: null,
      regionFilter: null,
    });
    useNotesStore.setState({
      notesByFolder: {},
      tagCounts: { art: 5, science: 2 },
      tagColors: {},
    });
  });

  it("renders existing tags and the '+' add button", () => {
    const tagCounts = new Map([
      ["art", 5],
      ["science", 2],
    ]);
    render(<TagsExpandedCloud tags={["art", "science"]} tagCounts={tagCounts} maxLines={2} />);

    expect(screen.getByText("art")).not.toBeNull();
    expect(screen.getByText("science")).not.toBeNull();
    expect(screen.getByTestId("tag-add-button")).not.toBeNull();
  });

  it("clicking '+' reveals inline input and pressing Enter commits tag to selectedTags", async () => {
    const user = userEvent.setup();
    const tagCounts = new Map([["art", 5]]);
    render(<TagsExpandedCloud tags={["art"]} tagCounts={tagCounts} maxLines={2} />);

    const addBtn = screen.getByTestId("tag-add-button");
    await user.click(addBtn);

    const input = screen.getByTestId("tag-add-input");
    expect(input).not.toBeNull();

    await user.type(input, "history{Enter}");

    expect(screen.queryByTestId("tag-add-input")).toBeNull();
    expect(useSearchStore.getState().selectedTags).toContain("history");
  });

  it("pressing Escape in the inline input cancels without selecting", async () => {
    const user = userEvent.setup();
    const tagCounts = new Map([["art", 5]]);
    render(<TagsExpandedCloud tags={["art"]} tagCounts={tagCounts} maxLines={2} />);

    await user.click(screen.getByTestId("tag-add-button"));
    const input = screen.getByTestId("tag-add-input");
    await user.type(input, "draft{Escape}");

    expect(screen.queryByTestId("tag-add-input")).toBeNull();
    expect(useSearchStore.getState().selectedTags).not.toContain("draft");
  });

  it("blurring the inline input commits the draft tag", async () => {
    const user = userEvent.setup();
    const tagCounts = new Map([["art", 5]]);
    render(<TagsExpandedCloud tags={["art"]} tagCounts={tagCounts} maxLines={2} />);

    await user.click(screen.getByTestId("tag-add-button"));
    const input = screen.getByTestId("tag-add-input");
    await user.type(input, "philosophy");
    fireEvent.blur(input);

    expect(screen.queryByTestId("tag-add-input")).toBeNull();
    expect(useSearchStore.getState().selectedTags).toContain("philosophy");
  });

  it("drag-to-pan gesture (>3px vertical move) suppresses tag chip click on release", () => {
    const tagCounts = new Map([["art", 5]]);
    render(<TagsExpandedCloud tags={["art"]} tagCounts={tagCounts} maxLines={2} />);

    const wrap = screen.getByTestId("tags-cloud-wrap");
    const chip = screen.getByText("art");

    // Mouse down on wrap
    fireEvent.mouseDown(wrap, { button: 0, clientY: 100 });

    // Drag move > 3px threshold
    fireEvent.mouseMove(document, { clientY: 120 });

    // Release mouse over tag chip
    fireEvent.mouseUp(document);
    fireEvent.click(chip);

    // Because user was panning, the click must not toggle the tag
    expect(useSearchStore.getState().selectedTags).not.toContain("art");
  });

  it("plain click (<3px move) toggles tag selection", async () => {
    const user = userEvent.setup();
    const tagCounts = new Map([["art", 5]]);
    render(<TagsExpandedCloud tags={["art"]} tagCounts={tagCounts} maxLines={2} />);

    const chip = screen.getByText("art");
    await user.click(chip);

    expect(useSearchStore.getState().selectedTags).toEqual(["art"]);
  });

  it("renders empty message and '+' button when tags are empty", () => {
    render(<TagsExpandedCloud tags={[]} tagCounts={new Map()} maxLines={2} />);

    expect(screen.getByText(/아직 태그가 없습니다|No tags yet|Pas encore de tags/i)).not.toBeNull();
    expect(screen.getByTestId("tag-add-button")).not.toBeNull();
  });
});
