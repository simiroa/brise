import { describe, it, expect, vi, beforeEach } from "vitest";

// Scope: 오너 결함 — "시트/관계도 섹션일 땐 파일을 못 받는다". handleFileDrop이 활성 섹션
// 종류(sectionRef.current.kind)로 캐럿/노드삽입 갈래를 스스로 건너뛰는지가 이 수정의 핵심
// 로직이므로(다른 순수 분기와 달리 IPC 호출 여부 자체가 갈린다), useAttachmentActions.test.tsx와
// 같은 형태로 store/IPC를 목 처리해 직접 구동한다.

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({ id: "att-1" }));
const reloadActive = vi.fn(async () => {});
const ensureMaterialized = vi.fn(async () => "note-1");
const emitNotice = vi.fn();
const importFilesAsSections = vi.fn(async (_noteId: string, _paths: string[]) => [] as any[]);
const insertImageAtPos = vi.fn();
const previewNewAttachment = vi.fn();
const isStillOnTarget = vi.fn((_a?: unknown, _b?: unknown) => true);

vi.mock("../../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: (...a: unknown[]) => emitNotice(...a),
}));
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      ensureMaterialized,
      reloadActive,
      activeNote: { note: { id: "note-1" } },
    }),
  },
}));
vi.mock("../../lib/noteActions", () => ({
  importFilesAsSections: (noteId: string, paths: string[]) => importFilesAsSections(noteId, paths),
  previewNewAttachment: (...a: unknown[]) => previewNewAttachment(...a),
}));
vi.mock("./insertImageAtPos", () => ({
  insertImageAtPos: (...a: unknown[]) => insertImageAtPos(...a),
}));
vi.mock("../../lib/onTargetGuard", () => ({
  isStillOnTarget: (...a: unknown[]) => isStillOnTarget(...(a as [unknown, unknown])),
}));

import { handleFileDrop } from "./useEditorFileDrop";

function fakeEditor() {
  return {
    isDestroyed: false,
    view: { posAtCoords: () => ({ pos: 3 }) },
    state: { selection: { to: 3 } },
  } as any;
}

describe("handleFileDrop — 섹션 종류와 무관한 드롭 라우팅 (오너 결함 수정)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockImplementation(async () => ({ id: "att-1" }));
    ensureMaterialized.mockImplementation(async () => "note-1");
    isStillOnTarget.mockReturnValue(true);
    importFilesAsSections.mockImplementation(async () => []);
  });

  it("텍스트 섹션 + png 드롭: attachment_add_file 후 캐럿 위치에 노드 삽입 (기존 동작 회귀 없음)", async () => {
    const sectionRef = { current: { id: "s1", kind: "text" } };
    await handleFileDrop(fakeEditor(), sectionRef, ["C:/x/photo.png"], 10, 20);

    expect(call).toHaveBeenCalledWith("attachment_add_file", { note_id: "note-1", file_path: "C:/x/photo.png" });
    expect(insertImageAtPos).toHaveBeenCalledTimes(1);
    expect(previewNewAttachment).toHaveBeenCalledWith("att-1"); // 이미지도 어시스트 미리보기로
    expect(importFilesAsSections).not.toHaveBeenCalled();
  });

  it("시트 섹션 + png 드롭: attachment_add_file만 부르고 노드 삽입은 시도하지 않는다", async () => {
    const sectionRef = { current: { id: "s1", kind: "sheet" } };
    await handleFileDrop(fakeEditor(), sectionRef, ["C:/x/photo.png"], 10, 20);

    expect(call).toHaveBeenCalledWith("attachment_add_file", { note_id: "note-1", file_path: "C:/x/photo.png" });
    expect(insertImageAtPos).not.toHaveBeenCalled();
  });

  it("시트 섹션 + md 드롭: section_import_file 경로(importFilesAsSections)를 타고 새 섹션이 생긴다", async () => {
    const sectionRef = { current: { id: "s1", kind: "sheet" } };
    const newSection = { id: "s2", kind: "text" };
    importFilesAsSections.mockResolvedValueOnce([newSection]);
    const onImported = vi.fn();

    await handleFileDrop(fakeEditor(), sectionRef, ["C:/x/notes.md"], 10, 20, onImported);

    expect(importFilesAsSections).toHaveBeenCalledWith("note-1", ["C:/x/notes.md"]);
    expect(call).not.toHaveBeenCalledWith("attachment_add_file", expect.anything());
    expect(onImported).toHaveBeenCalledWith(newSection);
  });

  it("관계도 섹션 + csv 드롭: 새 시트 섹션이 생긴다", async () => {
    const sectionRef = { current: { id: "s1", kind: "diagram" } };
    const newSheetSection = { id: "s3", kind: "sheet" };
    importFilesAsSections.mockResolvedValueOnce([newSheetSection]);
    const onImported = vi.fn();

    await handleFileDrop(fakeEditor(), sectionRef, ["C:/x/table.csv"], 10, 20, onImported);

    expect(importFilesAsSections).toHaveBeenCalledWith("note-1", ["C:/x/table.csv"]);
    expect(onImported).toHaveBeenCalledWith(newSheetSection);
  });
});
