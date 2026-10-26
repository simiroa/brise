import { describe, it, expect, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { insertImageAtPos, insertImagesAtRange } from "./insertImageAtPos";

// 실제 Editor 없이도 검증되는 두 분기만: docSize 클램프, isDestroyed 가드. 노드 삽입의 실제
// 렌더/저장 왕복은 imageExtension.test.ts / EditorPanel 통합 경로가 이미 덮는다.
function makeFakeEditor(docSize: number, isDestroyed = false) {
  const insertContentAt = vi.fn();
  const run = vi.fn();
  const chainObj = {
    focus: () => chainObj,
    insertContentAt: (pos: number, content: unknown) => {
      insertContentAt(pos, content);
      return chainObj;
    },
    run,
  };
  const editor = {
    isDestroyed,
    state: { doc: { content: { size: docSize } } },
    chain: () => chainObj,
  } as unknown as Editor;
  return { editor, insertContentAt };
}

describe("insertImageAtPos", () => {
  it("inserts an image node with alt/relPath/default width at the given pos", () => {
    const { editor, insertContentAt } = makeFakeEditor(100);
    insertImageAtPos(editor, { name: "photo.png", rel_path: "attachments/ab/photo.png" }, 10);
    expect(insertContentAt).toHaveBeenCalledWith(10, {
      type: "image",
      attrs: { alt: "photo.png", relPath: "attachments/ab/photo.png", width: "40%" },
    });
  });

  it("clamps a pos past the document end to docSize", () => {
    const { editor, insertContentAt } = makeFakeEditor(5);
    insertImageAtPos(editor, { name: "x.png", rel_path: null }, 999);
    expect(insertContentAt).toHaveBeenCalledWith(5, expect.anything());
  });

  it("does nothing on a destroyed editor", () => {
    const { editor, insertContentAt } = makeFakeEditor(100, true);
    insertImageAtPos(editor, { name: "x.png" }, 3);
    expect(insertContentAt).not.toHaveBeenCalled();
  });
});

describe("insertImagesAtRange", () => {
  it("replaces the paste-time range once and preserves clipboard order", () => {
    const insertContentAt = vi.fn();
    const run = vi.fn();
    const chainObj = {
      focus: () => chainObj,
      insertContentAt: (range: unknown, content: unknown) => {
        insertContentAt(range, content);
        return chainObj;
      },
      run,
    };
    const editor = {
      isDestroyed: false,
      state: { doc: { content: { size: 100 } } },
      chain: () => chainObj,
    } as unknown as Editor;

    insertImagesAtRange(
      editor,
      [
        { name: "first.png", rel_path: "attachments/first.png" },
        { name: "second.png", rel_path: "attachments/second.png" },
      ],
      { from: 7, to: 12 },
    );

    expect(insertContentAt).toHaveBeenCalledTimes(1);
    expect(insertContentAt).toHaveBeenCalledWith(
      { from: 7, to: 12 },
      [
        { type: "image", attrs: { alt: "first.png", relPath: "attachments/first.png", width: "40%" } },
        { type: "image", attrs: { alt: "second.png", relPath: "attachments/second.png", width: "40%" } },
      ],
    );
  });
});
