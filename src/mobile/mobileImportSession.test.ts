import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Attachment } from "../lib/commands.gen";

const callMock = vi.fn(async () => ({}));
vi.mock("../lib/invoke", () => ({
  call: (...a: unknown[]) => callMock(...(a as [])),
  callSilent: (...a: unknown[]) => callMock(...(a as [])),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));

import { useNotesStore } from "../stores/notes";
import { AttachmentTooLargeError } from "./mobileApi";
import { fillCaptureDraft, ImportSession, type ImportSessionDeps } from "./mobileImportSession";
import type { ImportFile } from "./mobileImport";

const f = (idx: number): ImportFile => ({ idx, name: `p${idx}.jpg`, mime: "image/jpeg", size: 3, url: `/__shell/import/i1/${idx}` });
const att = (n: string) => ({ id: `att-${n}`, name: n, kind: "image" }) as unknown as Attachment;

function deps(over: Partial<ImportSessionDeps> = {}): ImportSessionDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchFile: vi.fn(async (file: ImportFile) => new File([new Uint8Array(3)], file.name, { type: file.mime })),
    upload: vi.fn(async (noteId: string, file: File) => {
      calls.push(`${noteId}:${file.name}`);
      return att(file.name);
    }),
    ack: vi.fn(async () => {}),
    attached: vi.fn(),
    ...over,
  };
}

describe("ImportSession", () => {
  it("이미지를 순서대로 한 줄로 올리고 올라간 첨부를 화면에 반영한다", async () => {
    const d = deps();
    const s = new ImportSession("i1", [f(0), f(1), f(2)], d);
    expect(s.pending).toBe(3);
    const r = await s.uploadAll("note1");
    expect(r).toEqual({ uploaded: 3, failed: 0, dropped: 0 });
    expect(d.calls).toEqual(["note1:p0.jpg", "note1:p1.jpg", "note1:p2.jpg"]);
    expect(d.attached).toHaveBeenCalledTimes(3);
    expect(s.pending).toBe(0);
  });

  it("네트워크 실패는 목록에 남아 다음 uploadAll 이 실패분만 다시 올린다", async () => {
    let fail = true;
    const d = deps({
      upload: vi.fn(async (_noteId: string, file: File) => {
        if (file.name === "p1.jpg" && fail) throw new Error("HTTP 500");
        return att(file.name);
      }),
    });
    const s = new ImportSession("i1", [f(0), f(1), f(2)], d);
    expect(await s.uploadAll("n")).toEqual({ uploaded: 2, failed: 1, dropped: 0 });
    expect(s.pending).toBe(1);
    fail = false;
    expect(await s.uploadAll("n")).toEqual({ uploaded: 1, failed: 0, dropped: 0 });
    expect(s.pending).toBe(0);
    expect(d.upload).toHaveBeenCalledTimes(4); // 3 + 재시도 1(성공한 둘은 다시 올리지 않았다)
  });

  it("25MB 초과·셸에서 사라진 파일은 다시 해도 같으니 목록에서 뺀다(dropped)", async () => {
    const d = deps({
      upload: vi.fn(async (_n: string, file: File) => {
        if (file.name === "p0.jpg") throw new AttachmentTooLargeError("file too large");
        return att(file.name);
      }),
      fetchFile: vi.fn(async (file: ImportFile) => {
        if (file.idx === 1) throw new Error("HTTP 404");
        return new File([new Uint8Array(3)], file.name, { type: file.mime });
      }),
    });
    const s = new ImportSession("i1", [f(0), f(1), f(2)], d);
    expect(await s.uploadAll("n")).toEqual({ uploaded: 1, failed: 0, dropped: 2 });
    expect(s.pending).toBe(0);
  });

  it("동시에 두 번 불러도 같은 호출을 공유한다(저장하기 연타가 같은 사진을 두 번 올리지 않는다)", async () => {
    const d = deps();
    const s = new ImportSession("i1", [f(0), f(1)], d);
    const [a, b] = await Promise.all([s.uploadAll("n"), s.uploadAll("n")]);
    expect(a).toBe(b);
    expect(d.upload).toHaveBeenCalledTimes(2);
  });

  it("올리는 도중 '사진 빼기'를 누르면 남은 목록(실패분 포함)이 되살아나지 않는다", async () => {
    let s!: ImportSession;
    const d = deps({
      upload: vi.fn(async (_n: string, file: File) => {
        if (file.name === "p0.jpg") {
          s.dropFiles();
          throw new Error("HTTP 500");
        }
        return att(file.name);
      }),
    });
    s = new ImportSession("i1", [f(0), f(1)], d);
    await s.uploadAll("n");
    expect(s.pending).toBe(0);
  });

  it("dropFiles 는 올리지 않고 목록만 비운다", async () => {
    const d = deps();
    const s = new ImportSession("i1", [f(0)], d);
    s.dropFiles();
    expect(s.pending).toBe(0);
    expect(await s.uploadAll("n")).toEqual({ uploaded: 0, failed: 0, dropped: 0 });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("finish 는 한 번만 ack 한다", async () => {
    const d = deps();
    const s = new ImportSession("i1", [], d);
    await s.finish();
    await s.finish();
    expect(d.ack).toHaveBeenCalledTimes(1);
    expect(d.ack).toHaveBeenCalledWith("i1");
  });

  it("실패 기록에는 코드·짧은 메시지만 남긴다(파일명·내용 없음)", async () => {
    reportFallbackMock.mockClear();
    const d = deps({ upload: vi.fn(async () => { throw new Error("HTTP 500"); }) });
    await new ImportSession("i1", [f(0)], d).uploadAll("n");
    expect(reportFallbackMock).toHaveBeenCalledWith("mobile-import", "upload_failed", "HTTP 500");
  });
});

describe("fillCaptureDraft — 초안만 고치고 서버에는 아무것도 쓰지 않는다", () => {
  const draft = () =>
    ({
      note: { id: "__draft__", title: "Untitled Note", folder_id: "" },
      sections: [{ id: "draft_sec", name: "Overview", body_md: "", position: 0, kind: "text" }],
      sources: [],
      attachments: [],
    }) as never;

  beforeEach(() => {
    callMock.mockClear();
    useNotesStore.setState({ activeNote: null, activeDraft: false, activeBodyEmpty: true } as never);
  });

  it("초안이면 제목·본문을 채우고 activeBodyEmpty 를 맞춘다. IPC 는 0회(노트가 만들어지지 않는다)", () => {
    useNotesStore.setState({ activeNote: draft(), activeDraft: true, activeBodyEmpty: true } as never);
    expect(fillCaptureDraft("본문 글", "제목")).toBe(true);
    const s = useNotesStore.getState();
    expect(s.activeNote?.note.title).toBe("제목");
    expect(s.activeNote?.sections[0].body_md).toBe("본문 글");
    expect(s.activeBodyEmpty).toBe(false);
    expect(s.activeDraft).toBe(true);
    expect(callMock).not.toHaveBeenCalled();
  });

  it("제목이 없으면 기존 제목을 건드리지 않고, 새 객체로 바꾼다(불변 갱신 — 노트 로드 효과가 참조 변화로 칠한다)", () => {
    const before = draft();
    useNotesStore.setState({ activeNote: before, activeDraft: true } as never);
    fillCaptureDraft("x", null);
    const after = useNotesStore.getState().activeNote!;
    expect(after.note.title).toBe("Untitled Note");
    expect(after).not.toBe(before);
    expect((before as any).sections[0].body_md).toBe(""); // 원본은 그대로
  });

  it("초안이 아니면(열린 노트이거나 없다) 아무것도 바꾸지 않고 false", () => {
    useNotesStore.setState({ activeNote: draft(), activeDraft: false } as never);
    expect(fillCaptureDraft("x", "y")).toBe(false);
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe("");
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
    expect(fillCaptureDraft("x", "y")).toBe(false);
  });
});

describe("ImportSession — 진행 알림(O-2 장부)", () => {
  it("파일 하나를 마칠 때마다 남은 목록을 알린다(실패분은 남고 올린 것은 빠진다)", async () => {
    const seen: number[][] = [];
    const d = deps({
      upload: vi.fn(async (_n: string, file: File) => {
        if (file.name === "p1.jpg") throw new Error("HTTP 500");
        return att(file.name);
      }),
    });
    const s = new ImportSession("i1", [f(0), f(1), f(2)], d, (rest) => seen.push(rest.map((x) => x.idx)));
    await s.uploadAll("n1");
    expect(seen).toEqual([[1, 2], [1, 2], [1]]);
    expect(s.files.map((x) => x.idx)).toEqual([1]);
  });
});
