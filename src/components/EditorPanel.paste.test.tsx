import { describe, it, expect } from "vitest";
import {
  derivePasteImageName,
  isPasteStillOnTarget,
  shouldPasteClipboardImages,
  shouldSuggestSheetFromPaste,
  soleFilePathFromPasteText,
} from "./EditorPanel";
// soleUrlFromPasteText 는 lib/urls.ts 로 이사했다(펫 클립보드 저장이 같은 판별을 재사용) —
// 테스트는 여기 남긴다: 이 파일이 "붙여넣기 경로의 순수 분기" 모음이고, 그 소비자가 여기다.
import { soleUrlFromPasteText } from "../lib/urls";

// Scope: the one real branch in the clipboard-image-paste feature that's worth a standalone
// check without a live editor/IPC harness — see EditorPanel.tsx's handleImagePaste/pasteImageFile
// for the full flow (paste -> attachment_add_bytes -> setImage), which needs a mounted note.

describe("derivePasteImageName", () => {
  it("keeps a real filename when the clipboard file has one", () => {
    expect(derivePasteImageName({ name: "vacation.jpg", type: "image/jpeg" })).toBe("vacation.jpg");
  });

  it("falls back to a MIME-derived name for a nameless clipboard bitmap (e.g. a screenshot)", () => {
    expect(derivePasteImageName({ name: "", type: "image/png" })).toBe("pasted-image.png");
  });

  it("strips the '+xml' suffix from image/svg+xml", () => {
    expect(derivePasteImageName({ name: "", type: "image/svg+xml" })).toBe("pasted-image.svg");
  });

  it("falls back to png when the MIME type itself is unusable", () => {
    expect(derivePasteImageName({ name: "", type: "" })).toBe("pasted-image.png");
  });
});

describe("shouldPasteClipboardImages", () => {
  it("lets editable text win when an app also supplies a bitmap fallback", () => {
    expect(shouldPasteClipboardImages({ imageCount: 1, plainText: "copied cells", parsedText: "copied cells" })).toBe(false);
    expect(shouldPasteClipboardImages({ imageCount: 1, plainText: "", parsedText: "rich text" })).toBe(false);
  });

  it("handles a genuinely image-only clipboard payload", () => {
    expect(shouldPasteClipboardImages({ imageCount: 1, plainText: "", parsedText: "" })).toBe(true);
    expect(shouldPasteClipboardImages({ imageCount: 0, plainText: "", parsedText: "" })).toBe(false);
  });
});

// Item 2 (paste race fix): pasteImageFile captures {noteId, sectionId} right after
// ensureMaterialized() resolves, then re-reads current state after the FileReader +
// attachment_add_bytes awaits. isPasteStillOnTarget is the pure comparison in between —
// exercising it directly avoids needing a live editor/IPC harness for the actual race.
describe("isPasteStillOnTarget", () => {
  it("true when neither note nor section changed during the awaits", () => {
    expect(
      isPasteStillOnTarget({ noteId: "n1", sectionId: "s1" }, { noteId: "n1", sectionId: "s1" })
    ).toBe(true);
  });

  it("false when the active note changed (e.g. user switched tabs mid-paste)", () => {
    expect(
      isPasteStillOnTarget({ noteId: "n1", sectionId: "s1" }, { noteId: "n2", sectionId: "s1" })
    ).toBe(false);
  });

  it("false when the active note closed entirely (activeNote undefined)", () => {
    expect(
      isPasteStillOnTarget({ noteId: "n1", sectionId: "s1" }, { noteId: undefined, sectionId: "s1" })
    ).toBe(false);
  });

  it("false when the section changed within the same note", () => {
    expect(
      isPasteStillOnTarget({ noteId: "n1", sectionId: "s1" }, { noteId: "n1", sectionId: "s2" })
    ).toBe(false);
  });

  it("true for a materialized draft with no section yet (both null)", () => {
    // Practically unreachable in the real flow (sectionRef is always set by the time
    // ensureMaterialized resolves for a draft), but the comparison itself must not
    // false-positive/negative on two nulls.
    expect(
      isPasteStillOnTarget({ noteId: "n1", sectionId: null }, { noteId: "n1", sectionId: null })
    ).toBe(true);
  });
});

// 클립보드 표 붙여넣기 → "시트로 만들기" 제안 게이트(shouldPasteClipboardImages와 같은 순수
// 술어 형태). 실제 IPC/섹션 생성 흐름(마운트된 노트가 필요)은 이 파일 상단 노트와 같은 이유로
// 여기서 다루지 않는다.
describe("shouldSuggestSheetFromPaste", () => {
  it("suggests for a 2x2+ matrix outside a table", () => {
    expect(shouldSuggestSheetFromPaste([["a", "b"], ["c", "d"]], false)).toBe(true);
  });

  it("does not suggest when the caret is already inside a table (tableMatrixPaste fills cells instead)", () => {
    expect(shouldSuggestSheetFromPaste([["a", "b"], ["c", "d"]], true)).toBe(false);
  });

  it("does not suggest for a single row or single column (not shaped like a table)", () => {
    expect(shouldSuggestSheetFromPaste([["a", "b", "c"]], false)).toBe(false);
    expect(shouldSuggestSheetFromPaste([["a"], ["b"], ["c"]], false)).toBe(false);
  });

  it("does not suggest when there is no matrix at all (plain non-tabular paste)", () => {
    expect(shouldSuggestSheetFromPaste(null, false)).toBe(false);
  });

  // 오너 결정(2026-09-20) — paste_table_sheet_suggest 킬 스위치. 세 번째 인자 생략 시 기본
  // true(구현 전 동작 유지)라 위 케이스들은 안 건드려도 그대로 통과한다.
  it("does not suggest when explicitly disabled, even for an otherwise-matching matrix", () => {
    expect(shouldSuggestSheetFromPaste([["a", "b"], ["c", "d"]], false, false)).toBe(false);
  });
});

// P2 3단계 링크 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — soleUrlFromPasteText is the
// pure "is this paste a bare link" check that gates pasteUrlSuggest's IPC call in
// handleImagePaste; the IPC/settings-gated call itself needs a mounted editor + IPC harness (out
// of scope for this file, same reasoning as pasteImageFile/attachment_add_bytes above).
describe("soleUrlFromPasteText", () => {
  it("accepts a bare http(s) URL", () => {
    expect(soleUrlFromPasteText("https://example.com/article")).toBe("https://example.com/article");
    expect(soleUrlFromPasteText("http://example.com")).toBe("http://example.com");
  });

  it("trims surrounding whitespace/newlines from an otherwise-bare URL paste", () => {
    expect(soleUrlFromPasteText("  https://example.com/article  \n")).toBe("https://example.com/article");
  });

  it("rejects a URL embedded in a sentence (not a sole paste)", () => {
    expect(soleUrlFromPasteText("see https://example.com for more")).toBeNull();
  });

  it("rejects non-http(s) schemes (mailto, note://, javascript:)", () => {
    expect(soleUrlFromPasteText("mailto:a@b.com")).toBeNull();
    expect(soleUrlFromPasteText("note://some-id")).toBeNull();
    expect(soleUrlFromPasteText("javascript:alert(1)")).toBeNull();
  });

  it("rejects plain text and empty input", () => {
    expect(soleUrlFromPasteText("just some notes")).toBeNull();
    expect(soleUrlFromPasteText("")).toBeNull();
    expect(soleUrlFromPasteText("   ")).toBeNull();
  });
});

// 붙여넣은 파일 경로 자동 스타일링(오너 2026-09-10) — handleImagePaste 의 code-mark 삽입을 가르는
// 순수 판별만 여기서 검증한다; 실제 삽입(에디터 트랜잭션)은 마운트된 에디터가 필요해 범위 밖.
describe("soleFilePathFromPasteText", () => {
  it("accepts a Windows drive path, spaces and all", () => {
    expect(soleFilePathFromPasteText("C:\\Users\\dev\\a.txt")).toBe("C:\\Users\\dev\\a.txt");
    expect(soleFilePathFromPasteText("C:\\Program Files\\App\\app.exe")).toBe(
      "C:\\Program Files\\App\\app.exe"
    );
    expect(soleFilePathFromPasteText("D:/projects/brise")).toBe("D:/projects/brise");
  });

  it("accepts a UNC path", () => {
    expect(soleFilePathFromPasteText("\\\\server\\share\\f.txt")).toBe("\\\\server\\share\\f.txt");
  });

  it("accepts a POSIX absolute path with no spaces", () => {
    expect(soleFilePathFromPasteText("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("rejects a POSIX-looking path that has spaces (an ordinary sentence)", () => {
    expect(soleFilePathFromPasteText("/ 로 시작하는 평범한 문장")).toBeNull();
  });

  it("rejects plain sentences", () => {
    expect(soleFilePathFromPasteText("오늘 회의 정리")).toBeNull();
  });

  it("rejects http(s) URLs", () => {
    expect(soleFilePathFromPasteText("https://example.com/article")).toBeNull();
    expect(soleFilePathFromPasteText("http://example.com")).toBeNull();
  });

  it("rejects a bare drive letter", () => {
    expect(soleFilePathFromPasteText("C:")).toBeNull();
  });

  it("rejects multi-line input", () => {
    expect(soleFilePathFromPasteText("C:\\Users\\dev\\a.txt\nC:\\Users\\dev\\b.txt")).toBeNull();
  });

  it("rejects a Korean sentence with a colon (not a drive letter)", () => {
    expect(soleFilePathFromPasteText("제목: 값")).toBeNull();
  });

  it("rejects a POSIX path with spaces", () => {
    expect(soleFilePathFromPasteText("/usr/local/my app")).toBeNull();
  });

  it("rejects a lone slash word — 붙여넣은 슬래시 명령이 코드가 되면 안 된다", () => {
    expect(soleFilePathFromPasteText("/summarize")).toBeNull();
    expect(soleFilePathFromPasteText("/")).toBeNull();
  });
});
