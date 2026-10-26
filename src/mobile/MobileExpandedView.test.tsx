import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./MobileCalendarView", () => ({
  MobileCalendarView: () => <div data-testid="stub-calendar" />,
}));
vi.mock("./MobileTimelineView", () => ({
  MobileTimelineView: () => <div data-testid="stub-timeline" />,
}));
vi.mock("./MobileGalleryView", () => ({
  MobileGalleryView: () => <div data-testid="stub-gallery" />,
}));
vi.mock("./MobileChatView", () => ({
  MobileChatView: () => <div data-testid="stub-chat" />,
}));
vi.mock("./MobileRegionView", () => ({
  MobileRegionView: () => <div data-testid="stub-region" />,
}));

import { useSearchStore } from "../stores/search";
import { MobileExpandedView } from "./MobileExpandedView";

beforeEach(() => {
  useSearchStore.setState({ filterMode: "tree" } as any);
});

/**
 * Mapping must match desktop's leftpanel/expanded/index.tsx switch exactly (workorder W3 §4/§5):
 * timeline/gallery/calendar route to their view, region has no mobile view (D6) and falls to the
 * unavailable notice, and anything unmapped (chat is unreachable via the UI, D7, but the dispatcher
 * must not crash if it ever sees it) falls to the same notice rather than the desktop default of
 * <RegionExpanded/>.
 */
describe("MobileExpandedView", () => {
  it("dispatches timeline mode to MobileTimelineView", () => {
    useSearchStore.setState({ filterMode: "timeline" } as any);
    render(<MobileExpandedView onOpenNote={() => {}} />);
    expect(screen.getByTestId("stub-timeline")).toBeTruthy();
  });

  it("dispatches gallery mode to MobileGalleryView", () => {
    useSearchStore.setState({ filterMode: "gallery" } as any);
    render(<MobileExpandedView onOpenNote={() => {}} />);
    expect(screen.getByTestId("stub-gallery")).toBeTruthy();
  });

  it("dispatches calendar mode to MobileCalendarView", () => {
    useSearchStore.setState({ filterMode: "calendar" } as any);
    render(<MobileExpandedView onOpenNote={() => {}} />);
    expect(screen.getByTestId("stub-calendar")).toBeTruthy();
  });

  it("dispatches region mode to MobileRegionView (view-only map, owner 2026-10-06)", () => {
    useSearchStore.setState({ filterMode: "region" } as any);
    render(<MobileExpandedView onOpenNote={() => {}} />);
    expect(screen.getByTestId("stub-region")).toBeTruthy();
    expect(screen.queryByTestId("stub-calendar")).toBeNull();
    expect(screen.queryByTestId("stub-timeline")).toBeNull();
    expect(screen.queryByTestId("stub-gallery")).toBeNull();
  });

  it("dispatches chat mode to MobileChatView (opened over HTTP, owner 2026-10-06)", () => {
    useSearchStore.setState({ filterMode: "chat" } as any);
    render(<MobileExpandedView onOpenNote={() => {}} />);
    expect(screen.getByTestId("stub-chat")).toBeTruthy();
  });

  it("falls back to the unavailable notice instead of crashing on an unmapped mode", () => {
    useSearchStore.setState({ filterMode: "bogus" } as any);
    render(<MobileExpandedView onOpenNote={() => {}} />);
    expect(screen.getByText("This view isn't available on mobile.")).toBeTruthy();
  });
});
