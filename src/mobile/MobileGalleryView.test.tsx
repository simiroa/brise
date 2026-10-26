import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AttachmentQueryItem } from "../lib/commands.gen";

const useGalleryQueryMock = vi.fn();
vi.mock("../components/leftpanel/expanded/useGalleryQuery", () => ({
  GALLERY_KIND_TABS: ["all", "image", "doc", "audio", "link", "note"],
  useGalleryQuery: (...args: unknown[]) => useGalleryQueryMock(...args),
}));

vi.mock("../lib/attachmentsBase", () => ({
  useAttachmentsBase: () => ({ baseDir: "/base", convert: (p: string) => p }),
}));

import { MobileGalleryView } from "./MobileGalleryView";
import { __resetTileAudioForTests } from "../components/attachments/tileAudio";

const playSpy = vi.fn(() => Promise.resolve());
const pauseSpy = vi.fn();

function item(patch: Partial<AttachmentQueryItem> & { id: string }): AttachmentQueryItem {
  return {
    note_id: "n1",
    name: patch.id,
    kind: "doc",
    rel_path: null,
    size_bytes: null,
    created_at: "2026-01-01T00:00:00Z",
    title: "Some note",
    year: 2026,
    thumb_rel_path: null,
    ...patch,
  };
}

const loadMore = vi.fn();

beforeEach(() => {
  __resetTileAudioForTests();
  playSpy.mockClear();
  pauseSpy.mockClear();
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: playSpy });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: pauseSpy });
  useGalleryQueryMock.mockReset().mockReturnValue({ items: [], loading: false, hasMore: false, loadMore });
  loadMore.mockClear();
});

/**
 * useGalleryQuery itself (attachment_query paging + attachmentRevision invalidation) is reused
 * verbatim and already has its own test file — these tests only cover what this mobile view adds:
 * kind-tab wiring, tap routing by media kind (viewer / in-place audio / open note), and scroll-triggered loadMore (no name
 * filter, no drag, no context menu — see file header).
 */
describe("MobileGalleryView", () => {
  it("renders one icon filter per GALLERY_KIND_TABS entry (labelled), defaulting to 'all'", () => {
    render(<MobileGalleryView onOpenNote={() => {}} />);
    const all = screen.getByTestId("mobile-gallery-kind-all");
    expect(all.getAttribute("data-active")).toBe("true");
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(all.getAttribute("aria-label")).toBe("All");
    expect(all.querySelector("svg")).toBeTruthy();
    expect(screen.getByTestId("mobile-gallery-kind-image").getAttribute("data-active")).toBe("false");
    expect(screen.getByRole("button", { name: "Images" })).toBeTruthy();
  });

  it("switching a kind tab re-queries useGalleryQuery with the new tab and no name filter", () => {
    render(<MobileGalleryView onOpenNote={() => {}} />);
    fireEvent.click(screen.getByTestId("mobile-gallery-kind-image"));
    expect(useGalleryQueryMock).toHaveBeenLastCalledWith("image", "");
  });

  it("renders every returned item as a tile", () => {
    useGalleryQueryMock.mockReturnValue({
      items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })],
      loading: false,
      hasMore: false,
      loadMore,
    });
    render(<MobileGalleryView onOpenNote={() => {}} />);
    expect(screen.getByTestId("mobile-gallery-tile-a")).toBeTruthy();
    expect(screen.getByTestId("mobile-gallery-tile-b")).toBeTruthy();
    expect(screen.getByTestId("mobile-gallery-tile-c")).toBeTruthy();
  });

  it("a tile without a file body (link/note/reference) opens its source note directly", () => {
    useGalleryQueryMock.mockReturnValue({
      items: [item({ id: "a", note_id: "note-a", kind: "link", rel_path: null })],
      loading: false,
      hasMore: false,
      loadMore,
    });
    const onOpenNote = vi.fn();
    render(<MobileGalleryView onOpenNote={onOpenNote} />);
    fireEvent.click(screen.getByTestId("mobile-gallery-tile-a"));
    expect(onOpenNote).toHaveBeenCalledWith("note-a");
    expect(screen.queryByTestId("mobile-media-viewer")).toBeNull();
  });

  it("a document opens the in-app viewer with a download link and an open-note button", () => {
    useGalleryQueryMock.mockReturnValue({
      items: [item({ id: "d", note_id: "note-d", name: "report.pdf", rel_path: "note-d/report.pdf" })],
      loading: false,
      hasMore: false,
      loadMore,
    });
    const onOpenNote = vi.fn();
    render(<MobileGalleryView onOpenNote={onOpenNote} />);
    fireEvent.click(screen.getByTestId("mobile-gallery-tile-d"));
    expect(onOpenNote).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-media-viewer")).toBeTruthy();
    const dl = screen.getByTestId("mobile-media-viewer-download");
    expect(dl.getAttribute("href")).toBe("/base/note-d/report.pdf");
    expect(dl.getAttribute("download")).toBe("report.pdf");
    fireEvent.click(screen.getByTestId("mobile-media-viewer-open-note"));
    expect(onOpenNote).toHaveBeenCalledWith("note-d");
    expect(screen.queryByTestId("mobile-media-viewer")).toBeNull();
  });

  it("an image opens fullscreen on its original file (not the thumbnail); the close button dismisses it", () => {
    useGalleryQueryMock.mockReturnValue({
      items: [item({ id: "i", kind: "image", name: "a.jpg", rel_path: "n1/a.jpg", thumb_rel_path: "n1/a.jpg.thumb.jpg" })],
      loading: false,
      hasMore: false,
      loadMore,
    });
    render(<MobileGalleryView onOpenNote={() => {}} />);
    const tile = screen.getByTestId("mobile-gallery-tile-i");
    expect(tile.querySelector("img")!.getAttribute("src")).toBe("/base/n1/a.jpg.thumb.jpg");
    fireEvent.click(tile);
    const viewer = screen.getByTestId("mobile-media-viewer");
    // M-7: 썸네일이 먼저 깔리고 원본이 같은 자리에서 로드된다.
    const srcs = Array.from(viewer.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(srcs).toContain("/base/n1/a.jpg");
    expect(screen.getByTestId("mobile-media-viewer-thumb")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("mobile-media-viewer")).toBeNull();
  });

  it("a video plays in an in-app <video>; tapping the video does not close the viewer", () => {
    useGalleryQueryMock.mockReturnValue({
      items: [item({ id: "v", name: "clip.mp4", rel_path: "n1/clip.mp4" })],
      loading: false,
      hasMore: false,
      loadMore,
    });
    render(<MobileGalleryView onOpenNote={() => {}} />);
    fireEvent.click(screen.getByTestId("mobile-gallery-tile-v"));
    const video = screen.getByTestId("mobile-media-viewer-video");
    expect(video.getAttribute("src")).toBe("/base/n1/clip.mp4");
    fireEvent.click(video);
    expect(screen.getByTestId("mobile-media-viewer")).toBeTruthy();
  });

  it("an audio tile plays/pauses on its play button only; the rest of the tile opens the viewer (X-7)", () => {
    useGalleryQueryMock.mockReturnValue({
      items: [item({ id: "s", kind: "audio", name: "memo.m4a", rel_path: "n1/memo.m4a" })],
      loading: false,
      hasMore: false,
      loadMore,
    });
    const onOpenNote = vi.fn();
    render(<MobileGalleryView onOpenNote={onOpenNote} />);
    const btn = screen.getByTestId("mobile-gallery-play-s");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(pauseSpy).toHaveBeenCalled();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(onOpenNote).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mobile-media-viewer")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-gallery-tile-s"));
    expect(screen.getByTestId("mobile-media-viewer")).toBeTruthy();
  });

  it("shows the shared gallery-empty text when nothing matches and not loading", () => {
    render(<MobileGalleryView onOpenNote={() => {}} />);
    expect(screen.getByText("No attachments match.")).toBeTruthy();
  });

  it("scrolling near the bottom triggers loadMore when more pages exist", () => {
    useGalleryQueryMock.mockReturnValue({ items: [item({ id: "a" })], loading: false, hasMore: true, loadMore });
    render(<MobileGalleryView onOpenNote={() => {}} />);
    const scroller = screen.getByTestId("mobile-gallery-view");
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 900, configurable: true });
    fireEvent.scroll(scroller);
    expect(loadMore).toHaveBeenCalled();
  });

  it("does not trigger loadMore while already loading or with no more pages", () => {
    useGalleryQueryMock.mockReturnValue({ items: [item({ id: "a" })], loading: true, hasMore: true, loadMore });
    render(<MobileGalleryView onOpenNote={() => {}} />);
    const scroller = screen.getByTestId("mobile-gallery-view");
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 900, configurable: true });
    fireEvent.scroll(scroller);
    expect(loadMore).not.toHaveBeenCalled();
  });
});
