import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AttachmentQueryItem } from "../../../lib/commands.gen";
import { assertHookSettles } from "../../../test/renderLoop";
import { useNotesStore } from "../../../stores/notes";
import {
  GALLERY_PAGE_SIZE,
  kindsForTab,
  useGalleryQuery,
  type GalleryKindTab,
} from "./useGalleryQuery";

const callMock = vi.fn();
const callSilentMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

function makeItem(
  over: Partial<AttachmentQueryItem> & { id: string },
): AttachmentQueryItem {
  return {
    note_id: "n1",
    name: `${over.id}.png`,
    kind: "image",
    rel_path: `n1/${over.id}.png`,
    size_bytes: 100,
    created_at: "2020-01-01T00:00:00Z",
    title: "Note A",
    year: 1500,
    thumb_rel_path: null,
    ...over,
  };
}

function pageItems(start: number, count: number, kind = "image"): AttachmentQueryItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeItem({ id: `${kind}-${start + i}`, kind, name: `${kind}-${start + i}.bin` }),
  );
}

describe("kindsForTab", () => {
  it("maps tabs to backend kinds (empty = all non-internal)", () => {
    expect(kindsForTab("all")).toEqual([]);
    expect(kindsForTab("image")).toEqual(["image"]);
    expect(kindsForTab("doc")).toEqual(["doc"]);
    expect(kindsForTab("audio")).toEqual(["audio"]);
    expect(kindsForTab("link")).toEqual(["link"]);
    expect(kindsForTab("note")).toEqual(["note"]);
    expect(kindsForTab("chart")).toEqual(["chart"]);
  });
});

describe("useGalleryQuery", () => {
  beforeEach(() => {
    callMock.mockReset();
    callSilentMock.mockReset();
    callSilentMock.mockResolvedValue({ thumbs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pages until a short page, never re-requests a claimed offset, no duplicate ids", async () => {
    const first = pageItems(0, GALLERY_PAGE_SIZE);
    const second = pageItems(GALLERY_PAGE_SIZE, 10);
    const queryCalls: Array<{ offset?: number; limit?: number }> = [];

    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        queryCalls.push({
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
        });
        const offset = (args.offset as number) ?? 0;
        if (offset === 0) return { items: first };
        if (offset === GALLERY_PAGE_SIZE) return { items: second };
        // Would be a bug if we ask past the short page.
        return { items: pageItems(offset, GALLERY_PAGE_SIZE) };
      }
      return {};
    });

    const { result } = renderHook(() => useGalleryQuery("all", ""));

    await waitFor(() => {
      expect(result.current.items).toHaveLength(GALLERY_PAGE_SIZE);
    });
    expect(result.current.hasMore).toBe(true);
    expect(queryCalls.filter((c) => c.offset === 0)).toHaveLength(1);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(GALLERY_PAGE_SIZE + 10);
    });
    expect(result.current.hasMore).toBe(false);

    // loadMore again must not fire another attachment_query.
    const before = queryCalls.length;
    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(queryCalls.length).toBe(before);
    expect(queryCalls.map((c) => c.offset)).toEqual([0, GALLERY_PAGE_SIZE]);

    const ids = result.current.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops a stale page when the kind tab changes mid-flight (cancellation)", async () => {
    let resolveImage!: (v: { items: AttachmentQueryItem[] }) => void;
    const imageGate = new Promise<{ items: AttachmentQueryItem[] }>((r) => {
      resolveImage = r;
    });

    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        const kinds = (args.kinds as string[]) ?? [];
        if (kinds[0] === "image") {
          return imageGate;
        }
        if (kinds[0] === "doc") {
          return { items: pageItems(0, 3, "doc") };
        }
        return { items: [] };
      }
      return {};
    });

    const { result, rerender } = renderHook(
      ({ tab }: { tab: GalleryKindTab }) => useGalleryQuery(tab, ""),
      { initialProps: { tab: "image" as GalleryKindTab } },
    );

    // Image page is still in flight.
    expect(result.current.items).toHaveLength(0);

    // User switches to Documents before image resolves.
    rerender({ tab: "doc" });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(3);
    });
    expect(result.current.items.every((i) => i.kind === "doc")).toBe(true);

    // Late image response must not append / replace.
    await act(async () => {
      resolveImage({ items: pageItems(0, 5, "image") });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.items).toHaveLength(3);
    expect(result.current.items.every((i) => i.kind === "doc")).toBe(true);
    expect(result.current.items.some((i) => i.kind === "image")).toBe(false);
  });

  /* 썸네일 생성이 페이지 로딩을 붙잡으면 안 된다. 신선한 코퍼스 한 페이지(60장)는
     장당 ~300ms 라 최대 ~18초인데, 그동안 loadMore 가 막히면 스크롤이 죽는다. */
  it("does not hold loading while thumbnails generate — the next page can still be asked for", async () => {
    const offsets: number[] = [];
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        const offset = (args.offset as number) ?? 0;
        offsets.push(offset);
        return { items: pageItems(offset, GALLERY_PAGE_SIZE) };
      }
      return {};
    });
    // Thumbs never resolve — simulates a page of fresh 12MP sources decoding.
    callSilentMock.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useGalleryQuery("all", ""));
    await waitFor(() => {
      expect(result.current.items).toHaveLength(GALLERY_PAGE_SIZE);
    });
    expect(result.current.loading).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(offsets).toContain(GALLERY_PAGE_SIZE);
    });
  });

  it("settles under assertHookSettles (no render storm)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attachment_query") return { items: pageItems(0, 2) };
      return {};
    });

    const { renders } = await assertHookSettles(() => {
      useGalleryQuery("all", "");
    });
    expect(renders).toBeLessThanOrEqual(12);
  });

  it("merges thumbs from attachment_thumbs_for_ids onto the page", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attachment_query") {
        return {
          items: [
            makeItem({ id: "img1", thumb_rel_path: null }),
            makeItem({ id: "img2", thumb_rel_path: null }),
          ],
        };
      }
      return {};
    });
    callSilentMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attachment_thumbs_for_ids") {
        return {
          thumbs: [{ id: "img1", rel_path: "thumbs/img1.jpg" }],
        };
      }
      return { thumbs: [] };
    });

    const { result } = renderHook(() => useGalleryQuery("image", ""));
    await waitFor(() => {
      expect(result.current.items.find((i) => i.id === "img1")?.thumb_rel_path).toBe(
        "thumbs/img1.jpg",
      );
    });
    expect(result.current.items.find((i) => i.id === "img2")?.thumb_rel_path).toBeNull();
  });

  it("refetches page 0 when attachmentRevision bumps while tab and filter are unchanged", async () => {
    const queryOffsets: number[] = [];
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        const offset = (args.offset as number) ?? 0;
        queryOffsets.push(offset);
        return { items: pageItems(offset, 2) };
      }
      return {};
    });

    const { result } = renderHook(() => useGalleryQuery("all", ""));
    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    expect(queryOffsets).toEqual([0]);

    act(() => {
      useNotesStore.getState().bumpAttachmentRevision();
    });

    await waitFor(() => {
      expect(queryOffsets).toEqual([0, 0]);
    });
  });
});
