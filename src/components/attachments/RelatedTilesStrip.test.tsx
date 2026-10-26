import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RelatedTilesStrip } from "./RelatedTilesStrip";
import type { RelatedTile } from "./useRelatedTiles";
import type { NoteSummary, Suggestion } from "../../lib/commands.gen";

function makeSummary(id: string, title = id): NoteSummary {
  return {
    id,
    folder_id: "f1",
    title,
    year: 2026,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    month: null,
    day: null,
  };
}

describe("RelatedTilesStrip & RelatedTileItem", () => {
  const dummyHandlers = {
    attachDragCollapsing: false,
    panStrip: vi.fn(),
    onSchedulePreview: vi.fn(),
    onOpenNote: vi.fn(),
    onOpenInternalDialog: vi.fn(),
    onDeleteManual: vi.fn(),
    onExcludeAuto: vi.fn(),
    onAcceptSuggestion: vi.fn(),
  };

  it("renders manual and auto related notes", () => {
    const tiles: RelatedTile[] = [
      {
        kind: "manual",
        attachment: {
          id: "att-1",
          name: "Manual Note",
          kind: "internal",
          rel_path: null,
          url: "n1",
          size_bytes: null,
          position: 0,
        },
        note: makeSummary("n1", "Manual Note"),
      },
      {
        kind: "auto",
        note: makeSummary("n2", "Auto Note"),
      },
    ];

    render(<RelatedTilesStrip {...dummyHandlers} relatedTiles={tiles} />);

    expect(screen.getAllByText("Manual Note").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Auto Note").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("related-smart-link-badge")).toBeNull();
  });

  it("renders 💡 smart suggestion badge when auto note has pending overlap suggestion", async () => {
    const suggestion: Suggestion = {
      id: "sugg-1",
      kind: "overlap",
      note_id: "active-note",
      note_title: "Active Note",
      related_note_id: "n2",
      related_note_title: "Auto Note",
      payload: "",
      score: 0.9,
      created_at: "2026-08-24T00:00:00Z",
    };

    const tiles: RelatedTile[] = [
      {
        kind: "auto",
        note: makeSummary("n2", "Auto Note"),
        suggestion,
      },
    ];

    const onAcceptSuggestion = vi.fn();
    render(
      <RelatedTilesStrip
        {...dummyHandlers}
        relatedTiles={tiles}
        onAcceptSuggestion={onAcceptSuggestion}
      />
    );

    const badge = screen.getByTestId("related-smart-link-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("title")).toContain("AI");

    await userEvent.click(badge);
    expect(onAcceptSuggestion).toHaveBeenCalledTimes(1);
    expect(onAcceptSuggestion.mock.calls[0][1]).toEqual(tiles[0]);
  });
});
