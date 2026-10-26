import { describe, it, expect } from "vitest";
import { isSafeRelPath } from "./imageExtension";

// Item 1 (image display root-cause fix): ImageNodeView joins `${attachmentsBaseDir}/${relPath}`
// at render time to build the displayable asset:// URL. relPath comes straight from parsed
// markdown/HTML with no validation of its own (a note body is user-controlled content, including
// via import) — isSafeRelPath is the one guard standing between a malicious/malformed relPath and
// that filesystem join. Mirrors isSafeImgSrc's posture for the `src` attribute in the same file.
describe("isSafeRelPath", () => {
  it("accepts a normal note-relative attachment path", () => {
    expect(isSafeRelPath("attachments/ab/cd.png")).toBe(true);
    expect(isSafeRelPath("photo.png")).toBe(true);
  });

  it("rejects null/undefined/empty", () => {
    expect(isSafeRelPath(null)).toBe(false);
    expect(isSafeRelPath(undefined)).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
  });

  it("rejects a scheme prefix — remote/local images use `src`, not this join", () => {
    expect(isSafeRelPath("https://example.com/x.png")).toBe(false);
    expect(isSafeRelPath("http://example.com/x.png")).toBe(false);
    expect(isSafeRelPath("file:///etc/passwd")).toBe(false);
    expect(isSafeRelPath("data:image/png;base64,AAAA")).toBe(false);
  });

  it("rejects an absolute path (POSIX or Windows drive)", () => {
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("C:\\Windows\\System32")).toBe(false);
    expect(isSafeRelPath("C:/Windows/System32")).toBe(false);
  });

  it("rejects a `..` traversal segment anywhere in the path", () => {
    expect(isSafeRelPath("../../../secrets")).toBe(false);
    expect(isSafeRelPath("attachments/../../../secrets")).toBe(false);
    expect(isSafeRelPath("attachments\\..\\..\\secrets")).toBe(false);
  });

  it("does not false-positive on '..' as a substring of a legitimate filename", () => {
    expect(isSafeRelPath("attachments/my..cool.file.png")).toBe(true);
  });
});
