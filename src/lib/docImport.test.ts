import { beforeEach, describe, expect, it, vi } from "vitest";

// importOneFile(파일 하나 -> 섹션들) · addDropped/droppedNotice(옮기지 못한 요소 알림) 단위 테스트.
// 배치(스캔 · 진행 토스트 · 되돌리기)는 noteActions.test.ts 의 importFilesAsSections 가 지킨다 - 여기는 갈래만.
// 직렬화 규칙 자체는 docImportHtmlContract.test.ts 가 진짜 함수로 지키므로 여기서는 결정적인 가짜로 바꾼다.

const callMock = vi.fn();
const callSilentMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("./invoke", () => ({
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

const reportFallbackMock = vi.fn();
vi.mock("./diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

const mdSerializeHtmlMock = vi.fn((html: string) => `md:${html}`);
vi.mock("./mdSerialize", () => ({
  mdSerializeHtml: (html: string) => mdSerializeHtmlMock(html),
}));

import { addDropped, droppedNotice, importOneFile } from "./docImport";
import { t } from "../i18n/t";

const richOut = (over: Record<string, unknown> = {}) => ({
  name: "문서",
  html: "<p>본문</p>",
  image_count: 0,
  dropped: [],
  ...over,
});

const created = { id: "s-rich", name: "문서" };

/** call() 쪽: 섹션 생성과 텍스트 추출 가져오기. callSilent() 쪽 doc_import_html 은 테스트가 정한다. */
function setupCall() {
  callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "section_create_with_body") return { ...created, name: args?.name, body_md: args?.body_md };
    if (cmd === "section_import_file") {
      return { sections: [{ id: `text-${args?.file_path}` }], truncated: false };
    }
    return undefined;
  });
}

const callCmds = () => callMock.mock.calls.map((c) => c[0]);

describe("importOneFile", () => {
  beforeEach(() => {
    callMock.mockReset();
    callSilentMock.mockReset();
    reportFallbackMock.mockReset();
    mdSerializeHtmlMock.mockReset();
    mdSerializeHtmlMock.mockImplementation((html: string) => `md:${html}`);
    setupCall();
  });

  describe.each(["hwpx", "docx"])("%s - 서식형", (ext) => {
    it("doc_import_html(callSilent) -> mdSerializeHtml -> section_create_with_body, 텍스트 추출은 부르지 않는다", async () => {
      callSilentMock.mockResolvedValue(
        richOut({ name: "회의록", html: "<p>안녕</p>", dropped: [{ kind: "equation", count: 2 }] }),
      );

      const out = await importOneFile("n1", `C:/docs/회의록.${ext}`);

      expect(callSilentMock).toHaveBeenCalledWith("doc_import_html", {
        note_id: "n1",
        file_path: `C:/docs/회의록.${ext}`,
      });
      expect(mdSerializeHtmlMock).toHaveBeenCalledWith("<p>안녕</p>");
      expect(callMock).toHaveBeenCalledWith("section_create_with_body", {
        note_id: "n1",
        name: "회의록",
        body_md: "md:<p>안녕</p>",
      });
      expect(callCmds()).toEqual(["section_create_with_body"]);
      expect(out.sections.map((s) => s.name)).toEqual(["회의록"]);
      expect(out.truncated).toBe(false);
      expect(out.dropped).toEqual([{ kind: "equation", count: 2 }]);
      expect(reportFallbackMock).not.toHaveBeenCalled();
    });

    it("확장자는 대소문자를 가리지 않는다", async () => {
      callSilentMock.mockResolvedValue(richOut());
      await importOneFile("n1", `C:\\docs\\REPORT.${ext.toUpperCase()}`);
      expect(callSilentMock).toHaveBeenCalledTimes(1);
      expect(callCmds()).toEqual(["section_create_with_body"]);
    });

    it("dropped 가 응답에 없어도 만든 섹션을 실패로 세지 않는다 (빈 배열)", async () => {
      callSilentMock.mockResolvedValue({ name: "문서", html: "<p>x</p>", image_count: 0 });
      const out = await importOneFile("n1", `a.${ext}`);
      expect(out.dropped).toEqual([]);
      expect(out.sections).toHaveLength(1);
    });

    it("doc_import_html 이 거절하면 형식별 코드 <ext>_rich_failed + 확장자·에러 코드만 남기고 텍스트 추출로 후퇴한다", async () => {
      // 메시지에 경로가 들어 있어도 진단 기록에는 확장자와 코드만 가야 한다.
      callSilentMock.mockRejectedValue({ code: "VALIDATION", message: `C:/secret/암호.${ext}: 암호화된 문서` });

      const out = await importOneFile("n1", `C:/secret/암호.${ext}`);

      expect(reportFallbackMock).toHaveBeenCalledTimes(1);
      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", `${ext}_rich_failed`, `ext=${ext} code=VALIDATION`);
      expect(JSON.stringify(reportFallbackMock.mock.calls)).not.toContain("secret");
      expect(callMock).toHaveBeenCalledWith("section_import_file", { note_id: "n1", file_path: `C:/secret/암호.${ext}` });
      expect(callCmds()).not.toContain("section_create_with_body");
      expect(out.sections.map((s) => s.id)).toEqual([`text-C:/secret/암호.${ext}`]);
      expect(out.dropped).toEqual([]); // 텍스트 추출로 만든 섹션에는 보고할 누락 정보가 없다
      expect(out.fellBackToText).toBe(true); // U-1: 배치가 끝에 알린다
    });

    it("암호화된 문서는 후퇴하지 않고 사유를 알리고 던진다 (U-1)", async () => {
      emitNoticeMock.mockReset();
      callSilentMock.mockRejectedValue({ code: "VALIDATION", message: "encrypted hwpx is not supported" });

      await expect(importOneFile("n1", `a.${ext}`)).rejects.toBeTruthy();

      expect(emitNoticeMock).toHaveBeenCalledWith(t("export.import_encrypted"));
      expect(callCmds()).toEqual([]);
      expect(reportFallbackMock).not.toHaveBeenCalled();
    });

    it("AppError 모양이 아닌 거절(맨 문자열)은 'unknown' 코드로 남기고 후퇴한다", async () => {
      callSilentMock.mockRejectedValue("invalid args `file_path` for command doc_import_html");
      await importOneFile("n1", `a.${ext}`);
      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", `${ext}_rich_failed`, `ext=${ext} code=unknown`);
      expect(callCmds()).toEqual(["section_import_file"]);
    });

    it("직렬화가 던지면 <ext>_rich_serialize_failed(확장자·에러 이름만) 뒤 후퇴한다", async () => {
      callSilentMock.mockResolvedValue(richOut());
      mdSerializeHtmlMock.mockImplementation(() => {
        throw new TypeError("Unexpected <p>본문 조각이 들어 있는 메시지");
      });

      await importOneFile("n1", `a.${ext}`);

      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", `${ext}_rich_serialize_failed`, `ext=${ext} error=TypeError`);
      expect(JSON.stringify(reportFallbackMock.mock.calls)).not.toContain("본문");
      expect(callCmds()).toEqual(["section_import_file"]);
    });

    it("직렬화 결과가 비면 빈 섹션을 만들지 않고 <ext>_rich_empty 뒤 후퇴한다", async () => {
      callSilentMock.mockResolvedValue(richOut());
      mdSerializeHtmlMock.mockImplementation(() => "  \n");

      await importOneFile("n1", `a.${ext}`);

      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", `${ext}_rich_empty`, expect.stringContaining(`ext=${ext}`));
      expect(callCmds()).toEqual(["section_import_file"]);
    });

    it("section_create_with_body 가 실패하면 후퇴하지 않고 그대로 던진다 (call() 이 이미 토스트를 띄웠다)", async () => {
      callSilentMock.mockResolvedValue(richOut());
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "section_create_with_body") throw new Error("create failed");
        return { sections: [], truncated: false };
      });

      await expect(importOneFile("n1", `a.${ext}`)).rejects.toThrow("create failed");

      expect(callCmds()).toEqual(["section_create_with_body"]);
      expect(reportFallbackMock).not.toHaveBeenCalled();
    });

    it("직렬화 실패 시 생성된 첨부들을 attachment_remove 로 정리한다 (R-4)", async () => {
      callSilentMock.mockImplementation(async (cmd: string) => {
        if (cmd === "doc_import_html") return richOut({ attachment_ids: ["att1", "att2"] });
        return { removed: true };
      });
      mdSerializeHtmlMock.mockImplementation(() => {
        throw new TypeError("serialize error");
      });

      await importOneFile("n1", `a.${ext}`);

      expect(callSilentMock).toHaveBeenCalledWith("attachment_remove", { id: "att1" });
      expect(callSilentMock).toHaveBeenCalledWith("attachment_remove", { id: "att2" });
    });

    it("직렬화 결과가 비었을 때 생성된 첨부들을 정리한다 (R-4)", async () => {
      callSilentMock.mockImplementation(async (cmd: string) => {
        if (cmd === "doc_import_html") return richOut({ attachment_ids: ["att1"] });
        return { removed: true };
      });
      mdSerializeHtmlMock.mockImplementation(() => "   ");

      await importOneFile("n1", `a.${ext}`);

      expect(callSilentMock).toHaveBeenCalledWith("attachment_remove", { id: "att1" });
    });

    it("section_create_with_body 실패 시에도 생성된 첨부들을 정리하고 던진다 (R-4)", async () => {
      callSilentMock.mockImplementation(async (cmd: string) => {
        if (cmd === "doc_import_html") return richOut({ attachment_ids: ["att1"] });
        return { removed: true };
      });
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "section_create_with_body") throw new Error("create failed");
        return { sections: [], truncated: false };
      });

      await expect(importOneFile("n1", `a.${ext}`)).rejects.toThrow("create failed");

      expect(callSilentMock).toHaveBeenCalledWith("attachment_remove", { id: "att1" });
    });
  });

  describe("그 밖의 확장자", () => {
    it.each(["a.md", "a.txt", "a.pdf", "a.pptx", "a.csv", "noext", "a.hwp", "a.docx.bak"])(
      "%s - section_import_file 그대로, doc_import_html 도 직렬화도 진단도 건드리지 않는다",
      async (path) => {
        const out = await importOneFile("n1", path);

        expect(callMock).toHaveBeenCalledWith("section_import_file", { note_id: "n1", file_path: path });
        expect(callCmds()).toEqual(["section_import_file"]);
        expect(callSilentMock).not.toHaveBeenCalled();
        expect(mdSerializeHtmlMock).not.toHaveBeenCalled();
        expect(reportFallbackMock).not.toHaveBeenCalled();
        expect(out.dropped).toEqual([]);
      },
    );

    it("텍스트 추출 결과(여러 섹션 · truncated)를 그대로 돌려준다", async () => {
      callMock.mockResolvedValue({ sections: [{ id: "w1" }, { id: "w2" }], truncated: true });
      const out = await importOneFile("n1", "book.xlsx");
      expect(out.sections.map((s) => s.id)).toEqual(["w1", "w2"]);
      expect(out.truncated).toBe(true);
    });
  });
});

describe("addDropped / droppedNotice", () => {
  const notice = (parts: string[], n: number) => t("editor.doc_import_dropped", { n, detail: parts.join(", ") });

  it("아무것도 못 옮기지 않았으면 알림이 없다 (0개 항목은 무시)", () => {
    const acc = new Map<string, number>();
    addDropped(acc, []);
    addDropped(acc, [{ kind: "equation", count: 0 }]);
    expect(acc.size).toBe(0);
    expect(droppedNotice(acc)).toBeNull();
  });

  it("파일들을 합산한다 - 같은 종류는 더하고 라벨은 종류별 문구", () => {
    const acc = new Map<string, number>();
    addDropped(acc, [
      { kind: "header_footer", count: 1 },
      { kind: "equation", count: 2 },
    ]);
    addDropped(acc, [{ kind: "equation", count: 1 }]);

    expect(droppedNotice(acc)).toBe(
      notice([`${t("editor.doc_import_kind_header_footer")} 1`, `${t("editor.doc_import_kind_equation")} 3`], 4),
    );
  });

  it("docx 메모(comment)는 전용 라벨로 모인다 - 기타가 아니다", () => {
    const acc = new Map<string, number>();
    addDropped(acc, [{ kind: "comment", count: 3 }]);
    addDropped(acc, [{ kind: "comment", count: 1 }]);
    expect(t("editor.doc_import_kind_comment")).not.toBe("editor.doc_import_kind_comment"); // 키가 실제로 번역된다
    expect(t("editor.doc_import_kind_comment")).not.toBe(t("editor.doc_import_kind_other"));
    expect(droppedNotice(acc)).toBe(notice([`${t("editor.doc_import_kind_comment")} 4`], 4));
    expect(acc.has("editor.doc_import_kind_other")).toBe(false);
  });

  it("라벨이 있는 모든 종류(hwpx·docx 공통)가 기타로 새지 않는다", () => {
    const kinds = [
      "header_footer", "equation", "shape", "ole", "chart", "image_format", "field", "image_missing", "image_limit", "comment",
    ];
    const acc = new Map<string, number>();
    addDropped(acc, kinds.map((kind) => ({ kind, count: 1 })));
    expect(acc.size).toBe(kinds.length);
    expect(acc.has("editor.doc_import_kind_other")).toBe(false);
  });

  it("모르는 종류는 '기타' 하나로 모아 맨 뒤에 둔다 (객체 프로토타입 이름도 안전하게)", () => {
    const acc = new Map<string, number>();
    addDropped(acc, [
      { kind: "weird_kind", count: 1 },
      { kind: "equation", count: 1 },
      { kind: "constructor", count: 2 },
      { kind: "shape", count: 1 },
    ]);

    expect(droppedNotice(acc)).toBe(
      notice(
        [
          `${t("editor.doc_import_kind_equation")} 1`,
          `${t("editor.doc_import_kind_shape")} 1`,
          `${t("editor.doc_import_kind_other")} 3`,
        ],
        5,
      ),
    );
  });
});
