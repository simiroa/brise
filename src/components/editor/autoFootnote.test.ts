/**
 * 자동 각주 — 파싱 관용도 + 실행 루프. 새 백엔드 커맨드가 없으므로 검증 대상은 전부 프론트다:
 * 모델 출력 파싱, "이미 각주가 달린 단어는 건너뛴다", 0건 경로, 결과 알림.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  callSilent: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  emitNotice: (message: string) => emitNoticeMock(message),
  registerFlush: () => () => {},
  flushAll: () => Promise.resolve(),
}));

const ensureMaterializedMock = vi.fn();
const reloadActiveMock = vi.fn();
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      ensureMaterialized: () => ensureMaterializedMock(),
      reloadActive: () => reloadActiveMock(),
      activeNote: { note: { id: "note-1" }, sections: [] },
    }),
  },
}));

const generateFromPromptMock = vi.fn();
vi.mock("../../stores/ai", () => ({
  useAiStore: {
    getState: () => ({
      generateFromPrompt: (...args: unknown[]) => generateFromPromptMock(...args),
    }),
  },
}));

vi.mock("../../lib/presetBridge", () => ({ navigateToSection: vi.fn() }));
vi.mock("../../stores/ui", () => ({ useUiStore: { getState: () => ({ setPreviewItem: vi.fn() }) } }));
vi.mock("../../i18n/t", () => ({
  t: (k: string, p?: Record<string, string | number>) => (p ? `${k}:${JSON.stringify(p)}` : k),
}));

let activeEditor: Editor | null = null;
vi.mock("../../lib/aiSectionBridge", () => ({
  getActiveEditor: () => (activeEditor && !activeEditor.isDestroyed ? activeEditor : null),
}));

import { FootnoteMark, findUnmarkedTermRange } from "./footnoteMark";
import {
  parseAutoFootnoteTerms,
  runAutoFootnoteAction,
  generateAutoFootnotes,
  formatAutoFootnotesAsMarkdown,
  applyAutoFootnotes,
  AUTO_FOOTNOTE_MAX,
} from "./autoFootnote";

function makeEditor(content: string) {
  return new Editor({ extensions: [StarterKit.configure({ link: false }), Markdown, FootnoteMark], content });
}

function footnoteIds(ed: Editor): string[] {
  const ids: string[] = [];
  ed.state.doc.descendants((node) => {
    const m = node.marks.find((mk) => mk.type.name === "footnote");
    if (m) ids.push(m.attrs.id as string);
    return true;
  });
  return ids;
}

beforeEach(() => {
  callMock.mockReset();
  emitNoticeMock.mockClear();
  ensureMaterializedMock.mockReset().mockResolvedValue("note-1");
  reloadActiveMock.mockReset().mockResolvedValue(undefined);
  generateFromPromptMock.mockReset();
  activeEditor = null;
  let n = 0;
  callMock.mockImplementation(async () => ({
    id: `att-${++n}`,
    name: "fn.md",
    kind: "footnote",
    rel_path: "x.md",
    url: "",
    size_bytes: null,
    position: 0,
  }));
});

describe("parseAutoFootnoteTerms", () => {
  it("parses a plain JSON array", () => {
    expect(parseAutoFootnoteTerms('[{"term":"RAG","definition":"검색 증강 생성"}]')).toEqual([
      { term: "RAG", definition: "검색 증강 생성" },
    ]);
  });

  it("tolerates ```json fences and surrounding prose", () => {
    const raw = '다음과 같습니다:\n```json\n[{"term":"RAG","definition":"설명"}]\n```\n이상입니다.';
    expect(parseAutoFootnoteTerms(raw)).toEqual([{ term: "RAG", definition: "설명" }]);
  });

  it("returns [] for garbage, non-arrays and empty input", () => {
    expect(parseAutoFootnoteTerms("죄송하지만 찾지 못했습니다")).toEqual([]);
    expect(parseAutoFootnoteTerms("[{term: RAG")).toEqual([]);
    expect(parseAutoFootnoteTerms('{"term":"RAG","definition":"x"}')).toEqual([]);
    expect(parseAutoFootnoteTerms("")).toEqual([]);
    expect(parseAutoFootnoteTerms("[]")).toEqual([]);
  });

  it("drops entries missing a field and de-dupes repeated terms", () => {
    const raw = JSON.stringify([
      { term: "RAG", definition: "a" },
      { term: "  ", definition: "b" },
      { term: "MCP" },
      { term: "RAG", definition: "중복" },
      "nope",
      null,
    ]);
    expect(parseAutoFootnoteTerms(raw)).toEqual([{ term: "RAG", definition: "a" }]);
  });

  it("caps the list at AUTO_FOOTNOTE_MAX (one backend round trip per term)", () => {
    const raw = JSON.stringify(
      Array.from({ length: AUTO_FOOTNOTE_MAX + 5 }, (_, i) => ({ term: `t${i}`, definition: "d" })),
    );
    expect(parseAutoFootnoteTerms(raw)).toHaveLength(AUTO_FOOTNOTE_MAX);
  });
});

describe("findUnmarkedTermRange", () => {
  it("locates a verbatim substring", () => {
    const ed = makeEditor("<p>오늘 RAG 파이프라인을 만들었다</p>");
    const range = findUnmarkedTermRange(ed.state.doc, "RAG");
    expect(range).not.toBeNull();
    expect(ed.state.doc.textBetween(range!.from, range!.to)).toBe("RAG");
    ed.destroy();
  });

  it("returns null for a term that is not in the doc verbatim", () => {
    const ed = makeEditor("<p>오늘 RAG 파이프라인</p>");
    expect(findUnmarkedTermRange(ed.state.doc, "rag")).toBeNull();
    expect(findUnmarkedTermRange(ed.state.doc, "RAG 시스템")).toBeNull();
    expect(findUnmarkedTermRange(ed.state.doc, "  ")).toBeNull();
    ed.destroy();
  });

  it("skips text already carrying a footnote mark and finds the next occurrence", () => {
    const ed = makeEditor('<p><span data-footnote="old">RAG</span> 그리고 RAG</p>');
    const range = findUnmarkedTermRange(ed.state.doc, "RAG");
    expect(range).not.toBeNull();
    // 첫 번째(이미 각주가 달린) 것이 아니라 두 번째를 잡아야 한다.
    expect(range!.from).toBeGreaterThan(4);
    ed.destroy();
  });
});

describe("runAutoFootnoteAction", () => {
  it("creates one footnote attachment per found term and marks it, then reloads once", async () => {
    const ed = makeEditor("<p>RAG 와 MCP 를 함께 썼다</p>");
    activeEditor = ed;
    generateFromPromptMock.mockResolvedValue(
      '[{"term":"RAG","definition":"검색 증강 생성"},{"term":"MCP","definition":"모델 컨텍스트 프로토콜"}]',
    );

    await runAutoFootnoteAction();

    expect(callMock).toHaveBeenCalledTimes(2);
    expect(callMock.mock.calls[0][0]).toBe("attachment_add_footnote");
    expect(callMock.mock.calls[0][1]).toMatchObject({ note_id: "note-1", anchor_text: "RAG", text: "검색 증강 생성" });
    expect(footnoteIds(ed).sort()).toEqual(["att-1", "att-2"]);
    // 루프마다가 아니라 끝에서 한 번.
    expect(reloadActiveMock).toHaveBeenCalledTimes(1);
    expect(emitNoticeMock).toHaveBeenCalledWith('ai.auto_footnote_done:{"count":2}');
    ed.destroy();
  });

  it("skips terms that are absent or already footnoted — no attachment for them", async () => {
    const ed = makeEditor('<p><span data-footnote="old">RAG</span> 이야기</p>');
    activeEditor = ed;
    generateFromPromptMock.mockResolvedValue(
      '[{"term":"RAG","definition":"중복"},{"term":"없는말","definition":"허구"}]',
    );

    await runAutoFootnoteAction();

    expect(callMock).not.toHaveBeenCalled();
    expect(reloadActiveMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith("ai.auto_footnote_none");
    ed.destroy();
  });

  it("reports the empty result when the model output is unparseable", async () => {
    const ed = makeEditor("<p>RAG 이야기</p>");
    activeEditor = ed;
    generateFromPromptMock.mockResolvedValue("죄송합니다, 찾지 못했습니다.");

    await runAutoFootnoteAction();

    expect(callMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith("ai.auto_footnote_none");
    ed.destroy();
  });

  it("stays silent when the AI call itself failed (already toasted) and never touches the doc", async () => {
    const ed = makeEditor("<p>RAG 이야기</p>");
    activeEditor = ed;
    generateFromPromptMock.mockResolvedValue(null);

    await runAutoFootnoteAction();

    expect(callMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).not.toHaveBeenCalled();
    expect(footnoteIds(ed)).toEqual([]);
    ed.destroy();
  });

  it("does nothing but notice when no live editor is registered", async () => {
    activeEditor = null;
    await runAutoFootnoteAction();
    expect(generateFromPromptMock).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith("ai.auto_footnote_no_section");
  });

  it("never rewrites the user's text — only wraps it", async () => {
    const ed = makeEditor("<p>RAG 이야기</p>");
    activeEditor = ed;
    const before = ed.state.doc.textContent;
    generateFromPromptMock.mockResolvedValue('[{"term":"RAG","definition":"설명"}]');

    await runAutoFootnoteAction();

    expect(ed.state.doc.textContent).toBe(before);
    ed.destroy();
  });

  describe("3-stage autoFootnote pipeline", () => {
    it("generates terms and formats as markdown without applying to editor", async () => {
      generateFromPromptMock.mockResolvedValue('[{"term":"LLM","definition":"대규모 언어 모델"}]');
      const terms = await generateAutoFootnotes("LLM에 대한 설명입니다.");
      expect(terms).toEqual([{ term: "LLM", definition: "대규모 언어 모델" }]);
      const md = formatAutoFootnotesAsMarkdown(terms!);
      expect(md).toBe("- **LLM**: 대규모 언어 모델");
      expect(callMock).not.toHaveBeenCalled();
    });

    it("applies generated terms on demand", async () => {
      const ed = makeEditor("<p>이것은 LLM 연구 문서입니다.</p>");
      activeEditor = ed;
      const terms = [{ term: "LLM", definition: "대규모 언어 모델" }];
      const count = await applyAutoFootnotes(terms, ed);
      expect(count).toBe(1);
      expect(callMock).toHaveBeenCalledWith("attachment_add_footnote", {
        note_id: "note-1",
        text: "대규모 언어 모델",
        anchor_text: "LLM",
      });
      expect(footnoteIds(ed)).toEqual(["att-1"]);
      ed.destroy();
    });
  });
});
