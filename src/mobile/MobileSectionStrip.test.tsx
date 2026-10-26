import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MobileSectionStrip } from "./MobileSectionStrip";
import { useUiStore } from "../stores/ui";

const sec = (id: string, name: string) => ({ id, name }) as never;

describe("MobileSectionStrip renameSectionId", () => {
  it("새 섹션이 sections 에 붙으면 이름 입력 다이얼로그를 열고 신호를 비운다", () => {
    const noop = vi.fn().mockResolvedValue(undefined);
    const props = { currentSectionId: "s1", onSelect: vi.fn(), onRename: noop, onMove: noop, onDelete: noop, onAddText: vi.fn(), onAddDiagram: vi.fn(), onAddSheet: vi.fn() };
    const { rerender } = render(<MobileSectionStrip {...props} sections={[sec("s1", "A")]} />);
    act(() => useUiStore.setState({ renameSectionId: "s2" }));
    expect(screen.queryByDisplayValue("B")).toBeNull();
    rerender(<MobileSectionStrip {...props} sections={[sec("s1", "A"), sec("s2", "B")]} />);
    expect(screen.getByDisplayValue("B")).toBeTruthy();
    expect(useUiStore.getState().renameSectionId).toBeNull();
  });
});
