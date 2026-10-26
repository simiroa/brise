/**
 * 상태줄 글자 수(WordCountBar) — 순수 카운팅은 wordCount.test.ts 가 맡고, 여기서는 컴포넌트가
 * 실제 Editor 에 붙어 (1) 마운트 즉시 값을 그리고 (2) 선택이 생기면 선택 영역의 수로 바뀌고
 * (3) 언마운트하면 리스너를 떼는지를 본다. 문단 경계 회귀도 여기서 고정한다: 예전 상태줄은
 * `doc.textContent` 로 세서 앞 문단의 끝 단어와 뒤 문단의 첫 단어가 한 단어로 붙었다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { WordCountBar } from "./WordCountBar";

vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: { uiLang: string }) => unknown) => sel({ uiLang: "en" }),
}));

// 실제 문구 대신 키+값을 그대로 돌려줘 숫자만 본다.
vi.mock("../../i18n/t", () => ({
  t: (key: string, vars?: Record<string, string>) => `${key}|${vars?.chars}|${vars?.words}`,
}));

let editor: Editor;

beforeEach(() => {
  vi.useFakeTimers();
  editor = new Editor({ extensions: [StarterKit], content: "<p>one two</p><p>three</p>" });
});

afterEach(() => {
  editor.destroy();
  vi.useRealTimers();
});

describe("WordCountBar", () => {
  it("renders the document's counts immediately on mount, counting across paragraph boundaries", () => {
    render(<WordCountBar editor={editor as never} />);
    // "one two"(7, 공백 포함) + "three"(5) = 12 글자 — 문단 사이 줄바꿈은 세지 않는다. 3 단어. textContent 기준이었다면 "one twothree" → 2 단어로 세어졌다.
    expect(screen.getByTestId("editor-word-count").textContent).toBe("editor.word_count_normal|12|3");
  });

  it("switches to the selection's counts when text is selected, after the debounce", () => {
    render(<WordCountBar editor={editor as never} />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 4 }); // "one"
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId("editor-word-count").textContent).toBe("editor.word_count_selection|3|1");
  });

  it("detaches its editor listeners on unmount", () => {
    const off = vi.spyOn(editor, "off");
    const { unmount } = render(<WordCountBar editor={editor as never} />);
    unmount();
    expect(off).toHaveBeenCalledWith("update", expect.any(Function));
    expect(off).toHaveBeenCalledWith("selectionUpdate", expect.any(Function));
  });
});
