import { describe, it, expect } from "vitest";
import { resolveImageDisplaySrc } from "./ImageNodeView";

const convert = (path: string) => `asset://localhost/${path}`;

// Item 1 (image display root-cause fix): resolveImageDisplaySrc is the exact decision the live
// NodeView makes on every render (via useMemo) — same code path for the immediate post-insert
// paint and every later reload, which is the point of moving resolution to render time.
describe("resolveImageDisplaySrc", () => {
  it("local attachment image: resolves relPath via convert() once the base dir is ready", () => {
    expect(resolveImageDisplaySrc("attachments/ab/cd.png", "", "/data/attachments", convert)).toBe(
      "asset://localhost//data/attachments/attachments/ab/cd.png"
    );
  });

  it("remote image (relPath null): falls back to the real src URL", () => {
    expect(
      resolveImageDisplaySrc(null, "https://example.com/photo.png", "/data/attachments", convert)
    ).toBe("https://example.com/photo.png");
  });

  it("cold cache (baseDir/convert not ready yet): falls back to src, self-corrects next render", () => {
    // Matches the real timeline: useAttachmentsBase starts at baseDir=null, convert=null and
    // re-renders once the async Tauri call resolves — this is the transient frame in between.
    expect(resolveImageDisplaySrc("attachments/ab/cd.png", "", null, null)).toBe("");
    expect(resolveImageDisplaySrc("attachments/ab/cd.png", "", "/data/attachments", null)).toBe("");
  });

  it("unsafe relPath (traversal/scheme/absolute): falls back to src rather than joining it", () => {
    expect(resolveImageDisplaySrc("../../../secrets", "fallback-src", "/data/attachments", convert)).toBe(
      "fallback-src"
    );
    expect(resolveImageDisplaySrc("/etc/passwd", "fallback-src", "/data/attachments", convert)).toBe(
      "fallback-src"
    );
  });

  it("the src fallback itself is gated by isSafeImgSrc — a file:/data: scheme never reaches <img src>", () => {
    // parseMarkdown sets `src` to the same unvalidated href relPath is built from, so
    // `![](file:///etc/passwd)` puts that string in BOTH attrs — relPath correctly gets
    // rejected by isSafeRelPath above, and the fallback must not let it through either.
    expect(resolveImageDisplaySrc("file:///etc/passwd", "file:///etc/passwd", "/data/attachments", convert)).toBe("");
    expect(resolveImageDisplaySrc(null, "data:image/png;base64,AAAA", "/data/attachments", convert)).toBe("");
    expect(resolveImageDisplaySrc(null, "javascript:alert(1)", "/data/attachments", convert)).toBe("");
    // Remote https still passes through the same fallback (already covered above, restated here
    // for contrast with the rejected schemes).
    expect(resolveImageDisplaySrc(null, "https://example.com/x.png", "/data/attachments", convert)).toBe(
      "https://example.com/x.png"
    );
  });
});
