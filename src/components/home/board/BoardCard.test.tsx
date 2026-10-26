import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { BoardCard } from "./BoardCard";
import { useSettingsStore } from "../../../stores/settings";
import type { BoardNote } from "../../../lib/commands.gen";

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn(async () => null),
  callSilent: vi.fn(async () => null),
  emitNotice: vi.fn(),
  registerFlush: () => () => {},
  flushAll: async () => {},
}));

vi.mock("../../../lib/attachmentsBase", () => ({
  useAttachmentsBase: () => ({ baseDir: null, convert: null }),
}));

const startNoteDragMock = vi.fn();
vi.mock("../../../lib/noteDrag", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/noteDrag")>("../../../lib/noteDrag");
  return { ...actual, startNoteDrag: (...args: unknown[]) => startNoteDragMock(...args) };
});

function note(title: string): BoardNote {
  return {
    id: "n1",
    title,
    year: 2026,
    month: null,
    day: null,
    end_year: null,
    end_month: null,
    end_day: null,
    remind: false,
    updated_at: "2026-10-18T00:00:00Z",
    unchecked_count: 0,
    items: [],
  };
}

function renderCard(title: string) {
  return render(
    <BoardCard
      note={note(title)}
      columnStatus={null}
      expanded={false}
      onToggleExpand={() => {}}
      onFocus={() => {}}
      onOpen={() => {}}
      onToggleTodo={() => {}}
      onContextMenu={() => {}}
      onDragStartCollapse={() => {}}
    />,
  );
}

describe("BoardCard — 제목 표시는 displayTitle 판정을 거친다", () => {
  let prevLang: ReturnType<typeof useSettingsStore.getState>["uiLang"];
  beforeEach(() => {
    prevLang = useSettingsStore.getState().uiLang;
    // en 의 note.untitled_note 는 센티널과 같은 "Untitled Note" 라 en 으로는 회귀를 못 잡는다.
    useSettingsStore.setState({ uiLang: "ko" });
    startNoteDragMock.mockReset();
  });
  afterEach(() => {
    useSettingsStore.setState({ uiLang: prevLang });
  });

  it('새 노트의 저장 센티널 "Untitled Note" 를 "제목 없음"으로 그린다(칸반 카드·드래그 라벨)', () => {
    const { getByTestId } = renderCard("Untitled Note");
    const card = getByTestId("board-card");
    expect(card.textContent).toContain("제목 없음");
    expect(card.textContent).not.toContain("Untitled Note");

    fireEvent.pointerDown(card, { button: 0 });
    expect(startNoteDragMock).toHaveBeenCalledWith(expect.anything(), "n1", "제목 없음");
  });

  it("실제 제목은 그대로 그린다", () => {
    const { getByTestId } = renderCard("장보기 목록");
    expect(getByTestId("board-card").textContent).toContain("장보기 목록");
  });
});
