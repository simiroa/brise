import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

import { patchSectionBodyCache } from "./sectionBodyCache";
import { useNotesStore } from "../stores/notes";
import type { NoteDetail, Section } from "./commands.gen";

function sec(id: string, body_md: string, kind: Section["kind"] = "text"): Section {
  return { id, name: id, body_md, position: 0, kind };
}

function setActive(sections: Section[]) {
  useNotesStore.setState({
    activeNote: {
      note: { id: "n1", title: "t" },
      sections,
      sources: [],
      attachments: [],
      tags: [],
    } as unknown as NoteDetail,
  });
}

describe("patchSectionBodyCache", () => {
  beforeEach(() => {
    useNotesStore.setState({ activeNote: null });
  });

  it("본문이 바뀌면 해당 섹션 body_md 를 갱신한다", () => {
    setActive([sec("s1", "old"), sec("s2", "keep", "diagram")]);
    const before = useNotesStore.getState().activeNote!;
    patchSectionBodyCache("s1", "new");
    const after = useNotesStore.getState().activeNote!;
    expect(after.sections[0].body_md).toBe("new");
    expect(after.sections[1].body_md).toBe("keep");
    expect(after).not.toBe(before);
    // 나머지 필드는 그대로 복제된다(섹션 배열만 새 참조)
    expect(after.note).toBe(before.note);
    expect(after.sections[1]).toBe(before.sections[1]);
  });

  it("같은 값이면 activeNote 를 교체하지 않는다", () => {
    setActive([sec("s1", "same")]);
    const before = useNotesStore.getState().activeNote!;
    patchSectionBodyCache("s1", "same");
    expect(useNotesStore.getState().activeNote).toBe(before);
  });

  it("없는 섹션 id 면 아무것도 하지 않는다", () => {
    setActive([sec("s1", "a")]);
    const before = useNotesStore.getState().activeNote!;
    patchSectionBodyCache("nope", "b");
    expect(useNotesStore.getState().activeNote).toBe(before);
  });

  it("활성 노트가 없으면 아무것도 하지 않는다", () => {
    patchSectionBodyCache("s1", "b");
    expect(useNotesStore.getState().activeNote).toBeNull();
  });
});
