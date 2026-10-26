import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { blobToPng, copyImageToClipboard } from "./imageClipboard";

// Owner QA 6, item 2 ("이미지 복사"): jsdom has no real canvas/ImageBitmap/Clipboard-image
// implementation, so these tests stub the browser primitives the module calls (createImageBitmap,
// HTMLCanvasElement.getContext/toBlob, navigator.clipboard.write, ClipboardItem, fetch) rather
// than exercising real pixel encoding — the thing worth proving here is the CONTROL FLOW (fetch →
// decode → re-encode to PNG → clipboard write, and that any failure propagates instead of being
// swallowed as a fake success), not the browser's own canvas implementation.

const fakeBitmap = { width: 4, height: 4, close: vi.fn() };
const fakeCtx = { drawImage: vi.fn() };
let fakePngBlob: Blob;

beforeEach(() => {
  fakePngBlob = new Blob(["png-bytes"], { type: "image/png" });
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(fakeBitmap));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback
  ) {
    cb(fakePngBlob);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("blobToPng", () => {
  it("decodes the source blob and re-encodes it via canvas to image/png", async () => {
    const source = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    const out = await blobToPng(source);
    expect(out.type).toBe("image/png");
    expect(fakeCtx.drawImage).toHaveBeenCalledWith(fakeBitmap, 0, 0);
    expect(fakeBitmap.close).toHaveBeenCalled();
  });

  it("rejects when the canvas has no 2d context", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(blobToPng(new Blob(["x"]))).rejects.toThrow(/2d canvas context/);
  });

  it("rejects when toBlob can't produce output", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback
    ) {
      cb(null);
    });
    await expect(blobToPng(new Blob(["x"]))).rejects.toThrow(/PNG encode failed/);
  });
});

describe("copyImageToClipboard", () => {
  it("fetches the resolved src, re-encodes to PNG, and writes a ClipboardItem", async () => {
    const sourceBlob = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => sourceBlob });
    vi.stubGlobal("fetch", fetchMock);
    const writeMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class {
      items: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    });
    vi.stubGlobal("navigator", { clipboard: { write: writeMock } });

    await copyImageToClipboard("http://asset.localhost/attachments/ab/photo.jpg");

    expect(fetchMock).toHaveBeenCalledWith("http://asset.localhost/attachments/ab/photo.jpg");
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [items] = writeMock.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].items["image/png"].type).toBe("image/png");
  });

  it("propagates a fetch failure instead of silently succeeding (honest degradation)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(copyImageToClipboard("http://asset.localhost/missing.png")).rejects.toThrow(/fetch failed/);
  });

  it("propagates a rejected clipboard write (e.g. WebView2 not supporting image writes)", async () => {
    const sourceBlob = new Blob(["png-bytes"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => sourceBlob }));
    vi.stubGlobal("ClipboardItem", class {
      constructor(public items: Record<string, Blob>) {}
    });
    vi.stubGlobal("navigator", {
      clipboard: { write: vi.fn().mockRejectedValue(new Error("not supported")) },
    });
    await expect(copyImageToClipboard("http://asset.localhost/x.png")).rejects.toThrow(/not supported/);
  });
});
