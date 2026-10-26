import { describe, it, expect } from "vitest";
import { linkBodyMaybeReadable, linkSiteLabel } from "./urls";

describe("linkBodyMaybeReadable", () => {
  it("accepts plain http(s) URLs", () => {
    expect(linkBodyMaybeReadable("https://example.com/article")).toBe(true);
    expect(linkBodyMaybeReadable("http://example.com")).toBe(true);
  });

  it("rejects non-http(s) schemes and unparsable strings", () => {
    expect(linkBodyMaybeReadable("ftp://x/y")).toBe(false);
    expect(linkBodyMaybeReadable("note://abc")).toBe(false);
    expect(linkBodyMaybeReadable("not a url")).toBe(false);
  });

  it("rejects URLs whose extension is already non-HTML", () => {
    expect(linkBodyMaybeReadable("https://example.com/paper.pdf")).toBe(false);
    expect(linkBodyMaybeReadable("https://example.com/a.png")).toBe(false);
    expect(linkBodyMaybeReadable("https://example.com/b.xlsx")).toBe(false);
    expect(linkBodyMaybeReadable("https://example.com/c.mp4")).toBe(false);
  });

  it("accepts a normal URL with query/fragment", () => {
    expect(linkBodyMaybeReadable("https://example.com/article?x=1#top")).toBe(true);
  });
});

describe("linkSiteLabel", () => {
  it("strips www. from the hostname", () => {
    expect(linkSiteLabel("https://www.example.com/x")).toBe("example.com");
  });

  it("falls back to the raw string on parse failure", () => {
    expect(linkSiteLabel("not a url")).toBe("not a url");
  });
});
