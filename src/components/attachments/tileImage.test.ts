import { describe, expect, it } from "vitest";
import { tileImageRel } from "./tileImage";
import type { Attachment } from "../../lib/commands.gen";

const att = (over: Partial<Attachment>): Attachment => ({
  id: "a1", name: "scan.png", kind: "image", rel_path: "n1/aaaa-scan.png",
  url: null, size_bytes: 1, position: 0, ...over,
});

describe("tileImageRel", () => {
  it("uses the thumbnail when one is known", () => {
    const thumbs = new Map([["a1", "n1/aaaa-scan.png.thumb.jpg"]]);
    expect(tileImageRel(att({}), thumbs)).toBe("n1/aaaa-scan.png.thumb.jpg");
  });

  it("never falls back to the original raster while the thumbnail is unknown", () => {
    // 한 프레임이라도 원본을 가리키면 12메가픽셀이 디코드되고, src 를 바꿔도 그 비트맵은
    // Chromium 캐시에 남는다(실측: 545MB → 726MB). 모르면 그리지 않는다.
    expect(tileImageRel(att({}), new Map())).toBeNull();
  });

  it("keeps using the original for svg, which has no thumbnail and no raster decode", () => {
    expect(tileImageRel(att({ rel_path: "n1/aaaa-map.SVG" }), new Map())).toBe("n1/aaaa-map.SVG");
  });

  it("draws nothing for non-images or attachments with no file", () => {
    expect(tileImageRel(att({ kind: "doc" }), new Map())).toBeNull();
    expect(tileImageRel(att({ kind: "link", rel_path: null, url: "https://x" }), new Map())).toBeNull();
  });
});
