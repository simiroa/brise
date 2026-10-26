import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttachmentQueryItem } from "../../../lib/commands.gen";
import { GalleryExpanded, GalleryTile } from "./GalleryExpanded";
import {
  GALLERY_COLS,
  GALLERY_GAP,
  GALLERY_MIN_COLS,
  GALLERY_SIDEBAR_PAD,
  galleryColumnCount,
  galleryRowHeight,
  galleryTileWidth,
} from "./galleryLayout";
import { assertRenderSettles } from "../../../test/renderLoop";

const callMock = vi.fn();
const callSilentMock = vi.fn();
const selectNoteMock = vi.fn();
const setPreviewItemMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

const startNoteDragMock = vi.fn();
vi.mock("../../../lib/noteDrag", () => ({
  startNoteDrag: (...args: unknown[]) => startNoteDragMock(...args),
}));

vi.mock("../../../lib/attachmentsBase", () => ({
  useAttachmentsBase: () => ({
    baseDir: "C:/attachments",
    convert: (p: string) => `asset://${p}`,
  }),
}));

const reloadActiveMock = vi.fn(async () => {});

vi.mock("../../../stores/notes", () => {
  const mockFn = (selector: (s: { selectNote: typeof selectNoteMock; attachmentRevision: number; reloadActive: typeof reloadActiveMock }) => unknown) =>
    selector({ selectNote: selectNoteMock, attachmentRevision: 0, reloadActive: reloadActiveMock });
  mockFn.getState = () => ({ selectNote: selectNoteMock, attachmentRevision: 0, reloadActive: reloadActiveMock });
  return {
    useNotesStore: mockFn,
    displayTitle: (t: string) => (t.trim() && t !== "Untitled Note" ? t : "Untitled Note"),
  };
});

vi.mock("../../../stores/ui", () => ({
  useUiStore: (selector: (s: { setPreviewItem: typeof setPreviewItemMock }) => unknown) =>
    selector({ setPreviewItem: setPreviewItemMock }),
}));

let stubBox = { width: 220, height: 480 };

global.ResizeObserver = class {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { ...stubBox, top: 0, left: 0, right: stubBox.width, bottom: stubBox.height, x: 0, y: 0 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

function makeItem(
  over: Partial<AttachmentQueryItem> & { id: string },
): AttachmentQueryItem {
  return {
    note_id: "n1",
    name: over.name ?? `${over.id}.png`,
    kind: over.kind ?? "image",
    rel_path: over.rel_path ?? `n1/${over.id}.png`,
    size_bytes: 100,
    created_at: "2020-01-01T00:00:00Z",
    title: over.title ?? "Source Note",
    year: over.year ?? 1420,
    thumb_rel_path: over.thumb_rel_path === undefined ? null : over.thumb_rel_path,
    ...over,
  };
}

describe("galleryLayout", () => {
  it("galleryColumnCount is width-based: 4 at the default sidebar, more when wider, never under the floor", () => {
    expect(galleryColumnCount(0)).toBe(GALLERY_COLS);
    expect(galleryColumnCount(308)).toBe(4);
    expect(galleryColumnCount(520)).toBeGreaterThan(4);
    expect(galleryColumnCount(100)).toBe(GALLERY_MIN_COLS);
  });

  it("row height follows the square tile width plus vertical gap", () => {
    // At listWidth = 308 (4 cols): tileWidth = (308 - 28 - 3*6) / 4 = 65.5. rowHeight = 65.5 + 6 = 71.5.
    expect(galleryTileWidth(308)).toBe(65.5);
    expect(galleryRowHeight(308)).toBe(71.5);
  });

  // Tiles must stay positive at the narrowest width the sidebar can reach — the column floor
  // plus gaps plus both pads is a real floor, and dropping under it yields 0-width tiles.
  it("keeps tiles positive at a narrow sidebar width", () => {
    const floor = 2 * GALLERY_SIDEBAR_PAD + (GALLERY_MIN_COLS - 1) * GALLERY_GAP;
    expect(galleryTileWidth(floor + 4 * GALLERY_MIN_COLS)).toBeGreaterThan(0);
    expect(galleryTileWidth(0)).toBe(0);
  });
});

describe("GalleryExpanded", () => {
  beforeEach(() => {
    callMock.mockReset();
    callSilentMock.mockReset();
    selectNoteMock.mockReset();
    setPreviewItemMock.mockReset();
    callSilentMock.mockResolvedValue({ thumbs: [] });
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        const kinds = (args?.kinds as string[]) ?? [];
        if (kinds[0] === "doc") {
          return {
            items: [
              makeItem({
                id: "d1",
                kind: "doc",
                name: "treaty.pdf",
                rel_path: "n1/treaty.pdf",
              }),
            ],
          };
        }
        return {
          items: [
            makeItem({
              id: "img-no-thumb",
              name: "huge.png",
              rel_path: "n1/huge.png",
              thumb_rel_path: null,
            }),
            makeItem({
              id: "img-with-thumb",
              name: "small.png",
              rel_path: "n1/small.png",
              thumb_rel_path: "n1/small.png.thumb.jpg",
            }),
          ],
        };
      }
      if (cmd === "attachment_open") return {};
      if (cmd === "attachment_remove") return { deleted: true };
      if (cmd === "attachment_reveal") return { ok: true };
      return {};
    });
  });

  it("renders type tabs and empty-safe grid shell", async () => {
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    expect(screen.getByTestId("view-gallery")).toBeTruthy();
    expect(screen.getByTestId("gallery-kind-all")).toBeTruthy();
    expect(screen.getByTestId("gallery-kind-image")).toBeTruthy();
    // 시트 차트 라이브 첨부(W4) — 탭은 GALLERY_KIND_TABS 하나에서 나온다(모바일 갤러리도 같은 배열).
    expect(screen.getByTestId("gallery-kind-chart")).toBeTruthy();
    expect(screen.getByTestId("gallery-name-filter")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });
  });

  it("single click sets previewItem to the attachment, calls selectNote with note_id, and does NOT call attachment_open; double click calls attachment_open", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });

    await user.click(screen.getByTestId("gallery-tile-img-with-thumb"));
    expect(setPreviewItemMock).toHaveBeenCalledWith({ kind: "attachment", id: "img-with-thumb" });
    expect(selectNoteMock).toHaveBeenCalledWith("n1");
    expect(callMock).not.toHaveBeenCalledWith("attachment_open", expect.anything());

    await user.dblClick(screen.getByTestId("gallery-tile-img-with-thumb"));
    expect(callMock).toHaveBeenCalledWith("attachment_open", { id: "img-with-thumb" });
  });

  it("tile with thumb_rel_path: null shows its name without hover; one with a thumbnail does not", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-no-thumb")).toBeTruthy();
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });

    // Tile without thumbnail shows name permanently without hover
    expect(screen.getByTestId("gallery-tile-meta-img-no-thumb")).toBeTruthy();

    // Tile with thumbnail does NOT show name overlay until hover/focus
    expect(screen.queryByTestId("gallery-tile-meta-img-with-thumb")).toBeNull();

    await user.hover(screen.getByTestId("gallery-tile-img-with-thumb"));
    expect(screen.getByTestId("gallery-tile-meta-img-with-thumb")).toBeTruthy();
  });

  it("opens context menu on right click with reveal and remove actions", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });

    await user.pointer({
      target: screen.getByTestId("gallery-tile-img-with-thumb"),
      keys: "[MouseRight]",
    });

    expect(screen.getByTestId("attachment-context-menu")).toBeTruthy();

    await user.click(screen.getByTestId("attachment-menu-reveal"));
    expect(callMock).toHaveBeenCalledWith("attachment_reveal", { id: "img-with-thumb" });
  });

  it("optimistically removes tile when remove context menu item is clicked", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });

    await user.pointer({
      target: screen.getByTestId("gallery-tile-img-with-thumb"),
      keys: "[MouseRight]",
    });

    await user.click(screen.getByTestId("attachment-menu-remove"));
    expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "img-with-thumb" });
    expect(screen.queryByTestId("gallery-tile-img-with-thumb")).toBeNull();
  });

  // 신뢰성 결함 회귀: attachment_remove 가 실패하면 낙관적으로 숨긴 타일이 되돌아와야 한다.
  // 되돌리지 않으면 파일은 DB·디스크에 그대로인데 화면에서만 영구히 사라져 사용자에게 거짓말한다.
  it("rolls back the optimistic removal when attachment_remove rejects", async () => {
    const user = userEvent.setup();
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        const kinds = (args?.kinds as string[]) ?? [];
        if (kinds[0] === "doc") return { items: [] };
        return {
          items: [
            makeItem({
              id: "img-with-thumb",
              name: "small.png",
              rel_path: "n1/small.png",
              thumb_rel_path: "n1/small.png.thumb.jpg",
            }),
          ],
        };
      }
      if (cmd === "attachment_remove") throw { code: "IO", message: "disk busy" };
      if (cmd === "attachment_reveal") return { ok: true };
      return {};
    });

    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });

    await user.pointer({
      target: screen.getByTestId("gallery-tile-img-with-thumb"),
      keys: "[MouseRight]",
    });
    await user.click(screen.getByTestId("attachment-menu-remove"));
    expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "img-with-thumb" });

    // attachment_remove rejects -> the optimistically-hidden tile must come back,
    // not stay hidden forever (userEvent already flushed the microtask that hid it).
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-img-with-thumb")).toBeTruthy();
    });
  });

  it("requests kinds for the active type tab", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(callMock.mock.calls.some((c) => c[0] === "attachment_query")).toBe(true);
    });
    await user.click(screen.getByTestId("gallery-kind-doc"));
    await waitFor(() => {
      const docCalls = callMock.mock.calls.filter(
        (c) => c[0] === "attachment_query" && (c[1] as { kinds?: string[] }).kinds?.[0] === "doc",
      );
      expect(docCalls.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByTestId("gallery-tile-d1")).toBeTruthy();
    });
  });

  it("toggles search input visibility on clicking search icon", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    const searchToggle = screen.getByTestId("gallery-search-toggle");
    const searchInput = screen.getByTestId("gallery-name-filter");
    expect(searchInput.parentElement?.style.display).toBe("none");

    await user.click(searchToggle);
    expect(searchInput.parentElement?.style.display).toBe("flex");

    await user.click(searchToggle);
    expect(searchInput.parentElement?.style.display).toBe("none");
  });

  it("supports multi-select with ctrl and shift click", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <GalleryExpanded />
      </div>,
    );
    const allBtn = screen.getByTestId("gallery-kind-all");
    const imgBtn = screen.getByTestId("gallery-kind-image");
    const docBtn = screen.getByTestId("gallery-kind-doc");

    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(imgBtn.getAttribute("aria-pressed")).toBe("false");

    // Single click selects only image
    await user.click(imgBtn);
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");
    expect(imgBtn.getAttribute("aria-pressed")).toBe("true");

    // Ctrl+click toggles doc into selection
    fireEvent.click(docBtn, { ctrlKey: true });
    expect(imgBtn.getAttribute("aria-pressed")).toBe("true");
    expect(docBtn.getAttribute("aria-pressed")).toBe("true");

    await waitFor(() => {
      const calls = callMock.mock.calls.filter((c) => c[0] === "attachment_query");
      const lastCall = calls[calls.length - 1];
      const kinds = (lastCall[1] as { kinds?: string[] }).kinds;
      expect(kinds).toContain("image");
      expect(kinds).toContain("doc");
    });
  });

  it("asks for the next page when rendered rows reach the end of what we have", async () => {
    const prev = stubBox;
    stubBox = { width: 220, height: 4000 };
    const offsets: number[] = [];
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "attachment_query") {
        const offset = (args?.offset as number) ?? 0;
        offsets.push(offset);
        return {
          items: Array.from({ length: offset === 0 ? 60 : 5 }, (_, i) =>
            makeItem({ id: `a${offset + i}`, kind: "doc", rel_path: `n1/a${offset + i}.pdf` }),
          ),
        };
      }
      return {};
    });

    try {
      render(
        <div style={{ height: 4000, width: 220, display: "flex" }}>
          <GalleryExpanded />
        </div>,
      );
      await waitFor(() => {
        expect(offsets).toContain(60);
      });
    } finally {
      stubBox = prev;
    }
  });

  it("settles under assertRenderSettles", () => {
    callMock.mockResolvedValue({ items: [] });
    const { renders } = assertRenderSettles(() => (
      <div style={{ height: 400, width: 200 }}>
        <GalleryExpanded />
      </div>
    ));
    expect(renders).toBeLessThanOrEqual(20);
  });
});

describe("GalleryTile image rule", () => {
  const convert = (p: string) => `asset://${p}`;
  const baseDir = "C:/attachments";

  it("never mounts an <img> on rel_path when thumb_rel_path is null", () => {
    const item = makeItem({
      id: "no-thumb",
      rel_path: "n1/4000x3000-scan.png",
      thumb_rel_path: null,
    });
    const { container } = render(
      <GalleryTile
        item={item}
        baseDir={baseDir}
        convert={convert}
        onSelectNote={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(0);
    expect(container.innerHTML).not.toContain("4000x3000-scan.png");
    expect(container.innerHTML).not.toContain("n1/4000x3000-scan.png");
  });

  it("uses thumb_rel_path (not rel_path) when a thumbnail exists", () => {
    const item = makeItem({
      id: "with-thumb",
      rel_path: "n1/4000x3000-scan.png",
      thumb_rel_path: "n1/4000x3000-scan.png.thumb.jpg",
    });
    const { container } = render(
      <GalleryTile
        item={item}
        baseDir={baseDir}
        convert={convert}
        onSelectNote={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toContain("4000x3000-scan.png.thumb.jpg");
    expect(img!.getAttribute("src")).not.toMatch(/4000x3000-scan\.png$/);
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(img!.getAttribute("decoding")).toBe("async");
  });

  // 이미지 요소는 자기 테두리·라운드를 갖지 않는다 — 모양은 컨테이너(타일)가 소유한다.
  it("draws the image without a frame of its own", () => {
    const { container } = render(
      <GalleryTile
        item={makeItem({ id: "framed", rel_path: "n1/a.png", thumb_rel_path: "n1/a.png.thumb.jpg" })}
        baseDir={baseDir}
        convert={convert}
        onSelectNote={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    const img = container.querySelector("img")!;
    expect(img.style.border).toBe("");
    expect(img.style.borderRadius).toBe("");
    expect(img.style.objectFit).toBe("cover");
  });

  it("allows svg originals when there is no thumb", () => {
    const item = makeItem({
      id: "svg1",
      rel_path: "n1/map.svg",
      thumb_rel_path: null,
    });
    const { container } = render(
      <GalleryTile
        item={item}
        baseDir={baseDir}
        convert={convert}
        onSelectNote={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toContain("map.svg");
  });
});

describe("GalleryTile drag identity", () => {
  const convert = (p: string) => `asset://${p}`;
  const baseDir = "C:/attachments";

  function dragTile(item: AttachmentQueryItem) {
    startNoteDragMock.mockReset();
    const { container } = render(
      <GalleryTile
        item={item}
        baseDir={baseDir}
        convert={convert}
        onSelectNote={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    fireEvent.pointerDown(container.querySelector("button")!, { button: 0 });
    return startNoteDragMock.mock.calls[0];
  }

  it("carries the image identity (original rel, not the thumb) for image tiles", () => {
    const call = dragTile(
      makeItem({ id: "i1", name: "small.png", rel_path: "n1/small.png", thumb_rel_path: "n1/small.png.thumb.jpg" }),
    );
    expect(call[1]).toBe("n1");
    expect(call[3]).toEqual({ image: { sourceId: "n1/small.png", title: "small.png" } });
  });

  it("leaves non-image attachments as plain note drags", () => {
    const call = dragTile(
      makeItem({ id: "d1", kind: "doc", name: "treaty.pdf", rel_path: "n1/treaty.pdf" }),
    );
    expect(call[3]).toEqual({ image: undefined });
  });

  // 썸네일이 아직 없으면 그릴 게 없다 — 이미지로 갈라지면 캔버스에 깨진 노드가 생긴다.
  it("falls back to a note drag when the image has no thumbnail yet", () => {
    const call = dragTile(
      makeItem({ id: "i2", name: "huge.png", rel_path: "n1/huge.png", thumb_rel_path: null }),
    );
    expect(call[3]).toEqual({ image: undefined });
  });
});

/* 썸네일이 없는 타일이 형식 자리표시로 떨어지는 배선. 문구가 아니라 DOM(data-file-group /
   data-file-ext)으로 단언한다 — 확장자 글자는 번역 대상이 아니다. */
describe("GalleryTile file-shape placeholder", () => {
  const convert = (p: string) => `asset://${p}`;

  function tile(item: AttachmentQueryItem) {
    const { container } = render(
      <GalleryTile
        item={item}
        baseDir="C:/attachments"
        convert={convert}
        onSelectNote={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    return container;
  }

  it("문서에는 doc 상자와 확장자 글자가 뜬다", () => {
    const el = tile(makeItem({ id: "d1", kind: "doc", name: "treaty.pdf", rel_path: "n1/treaty.pdf" }))
      .querySelector<HTMLElement>("[data-file-group]");
    expect(el?.dataset.fileGroup).toBe("doc");
    expect(el?.dataset.fileExt).toBe("PDF");
  });

  it("썸네일이 없는 이미지(참조 첨부)와 RAW 는 photo 상자로 떨어진다", () => {
    const ref = tile(makeItem({ id: "r1", kind: "image", name: "trip.jpg", rel_path: null, thumb_rel_path: null }))
      .querySelector<HTMLElement>("[data-file-group]");
    expect(ref?.dataset.fileGroup).toBe("photo");
    expect(ref?.dataset.fileExt).toBe("JPG");

    const raw = tile(makeItem({ id: "r2", kind: "doc", name: "DSC_0001.cr2", rel_path: "n1/DSC_0001.cr2" }))
      .querySelector<HTMLElement>("[data-file-group]");
    expect(raw?.dataset.fileGroup).toBe("photo");
    expect(raw?.dataset.fileExt).toBe("CR2");
  });

  it("썸네일이 있으면 자리표시가 아니라 그림이 뜬다", () => {
    const container = tile(
      makeItem({ id: "t1", name: "a.png", rel_path: "n1/a.png", thumb_rel_path: "n1/a.png.thumb.jpg" }),
    );
    expect(container.querySelector("[data-file-group]")).toBeNull();
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("파일이 아닌 링크 첨부에는 형식 상자를 씌우지 않는다", () => {
    const container = tile(makeItem({ id: "l1", kind: "link", name: "https://example.com", rel_path: null }));
    expect(container.querySelector("[data-file-group]")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

/* 오디오 타일은 호버하는 동안 바로 듣는다 — 떠나면 멈춘다(소리 엔진은 tileAudio 의 하나뿐인 <audio>). */
describe("GalleryTile audio hover preview", () => {
  it("plays on mouse enter and stops on mouse leave; non-audio tiles stay silent", async () => {
    const { __resetTileAudioForTests } = await import("../../attachments/tileAudio");
    __resetTileAudioForTests();
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: play });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: pause });
    const props = {
      baseDir: "C:/attachments",
      convert: (p: string) => `asset://${p}`,
      onSelectNote: () => {},
      onOpen: () => {},
      onContextMenu: () => {},
    };
    const { getByTestId } = render(
      <>
        <GalleryTile {...props} item={makeItem({ id: "au", kind: "audio", name: "memo.m4a", rel_path: "n1/memo.m4a" })} />
        <GalleryTile {...props} item={makeItem({ id: "dc", kind: "doc", name: "a.pdf", rel_path: "n1/a.pdf" })} />
      </>,
    );
    fireEvent.mouseEnter(getByTestId("gallery-tile-dc"));
    expect(play).not.toHaveBeenCalled();
    vi.useFakeTimers();
    fireEvent.mouseEnter(getByTestId("gallery-tile-au"));
    expect(play).not.toHaveBeenCalled(); // U-10: 300ms 머문 뒤에만
    act(() => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
    expect(play).toHaveBeenCalledTimes(1);
    expect(getByTestId("gallery-tile-au").querySelector("[data-playing]")).toBeTruthy();
    fireEvent.mouseLeave(getByTestId("gallery-tile-au"));
    expect(pause).toHaveBeenCalled();
    expect(getByTestId("gallery-tile-au").querySelector("[data-playing]")).toBeNull();
  });
});
