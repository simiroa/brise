import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { attachmentIcon, isFootnoteKind } from "./tileIcon";

/* lucide-react renders `lucide-<iconName>` on the svg (createLucideIcon.mjs), so the
 * class assertion below is the cheapest way to discriminate which icon came back
 * without snapshotting the whole SVG. */
function hasIconClass(kind: string, name: string, cls: string, size = 16): boolean {
  const { container } = render(<>{attachmentIcon(kind, name, size)}</>);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("no svg rendered");
  return svg.classList.contains(cls);
}

describe("attachmentIcon", () => {
  it("treats extractable doc extensions as IconDoc", () => {
    expect(hasIconClass("doc", "treaty.pdf", "lucide-file-type")).toBe(true);
    expect(hasIconClass("doc", "contract.docx", "lucide-file-type")).toBe(true);
    expect(hasIconClass("doc", "notes.txt", "lucide-file-type")).toBe(true);
    expect(hasIconClass("doc", "README.md", "lucide-file-type")).toBe(true);
  });

  it("treats uppercase doc extensions as extractable", () => {
    expect(hasIconClass("doc", "TREATY.PDF", "lucide-file-type")).toBe(true);
  });

  // Anti-vacuity: if a refactor restores the kind-only mapping (returning IconDoc / lucide-file-type for all doc files),
  // this test fails because unknown extensions like .afdesign/.zip/.sketch render lucide-file-type instead of lucide-file.
  it("treats unknown doc extensions (e.g. .afdesign, .zip, .sketch) as IconFile", () => {
    expect(hasIconClass("doc", "design.afdesign", "lucide-file")).toBe(true);
    expect(hasIconClass("doc", "design.afdesign", "lucide-file-type")).toBe(false);
    expect(hasIconClass("doc", "bundle.zip", "lucide-file")).toBe(true);
    expect(hasIconClass("doc", "design.sketch", "lucide-file")).toBe(true);
  });

  it("treats a doc-kind file with no extension as IconFile", () => {
    expect(hasIconClass("doc", "README", "lucide-file")).toBe(true);
  });

  it("returns IconImage for image kind regardless of extension", () => {
    expect(hasIconClass("image", "scan.png", "lucide-image")).toBe(true);
    expect(hasIconClass("image", "scan.unknown", "lucide-image")).toBe(true);
  });

  it("returns IconMic for audio kind regardless of extension", () => {
    expect(hasIconClass("audio", "song.mp3", "lucide-mic")).toBe(true);
    expect(hasIconClass("audio", "song.mp4", "lucide-mic")).toBe(true);
  });

  it("returns IconChart for chart kind (sheet chart live reference, no thumbnail)", () => {
    expect(hasIconClass("chart", "매출", "lucide-chart-bar")).toBe(true);
  });

  it("returns IconLink for link kind", () => {
    expect(hasIconClass("link", "https://example.com", "lucide-link")).toBe(true);
  });

  it("returns IconNote for internal kind", () => {
    expect(hasIconClass("internal", "linked-note", "lucide-file-text")).toBe(true);
  });

  it("returns IconNote for note kind", () => {
    expect(hasIconClass("note", "scratch.txt", "lucide-file-text")).toBe(true);
  });

  // Wave 4: footnotes are attachment rows, not generic .md docs — IconQuote, never IconFile/IconDoc.
  it("returns IconQuote for footnote kind", () => {
    expect(isFootnoteKind("footnote")).toBe(true);
    expect(isFootnoteKind("note")).toBe(false);
    expect(hasIconClass("footnote", "fn.md", "lucide-quote")).toBe(true);
    expect(hasIconClass("footnote", "fn.md", "lucide-file")).toBe(false);
    expect(hasIconClass("footnote", "fn.md", "lucide-file-type")).toBe(false);
  });

  it("falls back to IconFile for unknown kinds", () => {
    expect(hasIconClass("unknown", "x.thing", "lucide-file")).toBe(true);
  });
});
