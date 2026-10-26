import { describe, it, expect, vi, beforeEach } from "vitest";

const order: string[] = [];
const callMock = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  order.push(cmd);
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: unknown) => callMock(cmd, args),
  callSilent: (cmd: string, args?: unknown) => callMock(cmd, args),
  flushAll: async () => {
    order.push("flush");
  },
  registerFlush: () => () => {},
  emitNotice: () => {},
}));

import {
  applySectionWindowChange,
  handleSectionWindowChanged,
  isSectionDetached,
  openSectionWindow,
  registerSectionReturnedHook,
  returnSectionWindow,
  useSectionWindowsStore,
} from "./sectionWindows";
import { useNotesStore } from "./notes";
import { registerActiveEditor, registerActiveSectionGetter } from "../lib/aiSectionBridge";
import type { NoteDetail, Section } from "../lib/commands.gen";
import type { Editor } from "@tiptap/core";

const note = (sectionIds: string[]) =>
  ({ note: { id: "n1", title: "t" }, sections: sectionIds.map((id) => ({ id, name: id, body_md: "", kind: "text" })) }) as unknown as NoteDetail;

beforeEach(() => {
  useSectionWindowsStore.setState({ ids: [] });
  order.length = 0;
  callMock.mockClear();
});

describe("openSectionWindow", () => {
  const sec = { id: "s1", name: "Sec" } as Section;

  it("flushes BEFORE opening, forwards the drop point, composes the title, then marks detached", async () => {
    await openSectionWindow("n1", sec, "Note", { x: 10, y: 20 });
    expect(order).toEqual(["flush", "section_window_open"]);
    expect(callMock).toHaveBeenCalledWith("section_window_open", { note_id: "n1", section_id: "s1", title: "Sec — Note", x: 10, y: 20 });
    expect(isSectionDetached("s1")).toBe(true);
  });

  it("title is the section name alone without a note title; failure leaves it attached", async () => {
    callMock.mockRejectedValueOnce(new Error("boom"));
    await openSectionWindow("n1", sec, "");
    expect(callMock).toHaveBeenCalledWith("section_window_open", { note_id: "n1", section_id: "s1", title: "Sec" });
    expect(isSectionDetached("s1")).toBe(false);
  });

  // E — flush 가 끝난 뒤~분리 반영 전에 친 글자는 버려진다. 여는 동안 그 섹션의 에디터를 잠그고 되돌린다.
  it("locks the live editor of that section while opening and restores it afterwards", async () => {
    const editable: boolean[] = [];
    const fake = {
      isEditable: true,
      isDestroyed: false,
      setEditable(v: boolean) {
        this.isEditable = v;
        editable.push(v);
      },
    };
    const un1 = registerActiveSectionGetter(() => ({ id: "s1", body_md: "" }));
    const un2 = registerActiveEditor(() => fake as unknown as Editor);
    callMock.mockImplementationOnce(async (cmd: string) => {
      order.push(`${cmd}:editable=${fake.isEditable}`);
      return {};
    });
    await openSectionWindow("n1", sec, "Note");
    expect(order).toEqual(["flush", "section_window_open:editable=false"]);
    expect(editable).toEqual([false, true]);
    un1();
    un2();
  });
});

describe("returnSectionWindow", () => {
  it("closed:false (window already gone) → un-detaches right away", async () => {
    useSectionWindowsStore.setState({ ids: ["s1"] });
    useNotesStore.setState({ activeNote: note(["other"]) });
    callMock.mockResolvedValueOnce({ closed: false });
    await returnSectionWindow("s1");
    expect(isSectionDetached("s1")).toBe(false);
  });

  it("closed:true → waits for the close event (id stays until then)", async () => {
    useSectionWindowsStore.setState({ ids: ["s1"] });
    callMock.mockResolvedValueOnce({ closed: true });
    await returnSectionWindow("s1");
    expect(isSectionDetached("s1")).toBe(true);
  });
});

describe("handleSectionWindowChanged — reopen while a close is still reloading (D)", () => {
  it("a re-open during the close's reloadActive keeps the id", async () => {
    let release!: () => void;
    const reloadActive = vi.fn(() => new Promise<void>((r) => (release = r)));
    useNotesStore.setState({ activeNote: note(["s1"]), reloadActive });
    await handleSectionWindowChanged({ section_id: "s1", open: true });

    const closing = handleSectionWindowChanged({ section_id: "s1", open: false });
    await handleSectionWindowChanged({ section_id: "s1", open: true }); // 다시 열림 — ids 무변화
    release();
    await closing;
    expect(isSectionDetached("s1")).toBe(true);
  });
});

describe("applySectionWindowChange", () => {
  it("adds once on open, removes on close, ignores unknown close", () => {
    expect(applySectionWindowChange([], { section_id: "a", open: true })).toEqual(["a"]);
    expect(applySectionWindowChange(["a"], { section_id: "a", open: true })).toEqual(["a"]);
    expect(applySectionWindowChange(["a", "b"], { section_id: "a", open: false })).toEqual(["b"]);
    const same = ["b"];
    expect(applySectionWindowChange(same, { section_id: "x", open: false })).toBe(same);
  });
});

describe("handleSectionWindowChanged — return order (cache clear → DB reload → un-detach)", () => {
  it("clears the editor cache, reloads the active note from DB while still detached, THEN removes the id", async () => {
    const order: string[] = [];
    const unhook = registerSectionReturnedHook((id) => order.push(`hook:${id}`));
    const reloadActive = vi.fn(async () => {
      // 되돌아오는 동안 섹션은 아직 "분리됨"이어야 한다 — 먼저 풀리면 관계도/시트가 stale 본문으로
      // 마운트되고 자기 저장으로 새 창의 편집을 덮는다.
      order.push(`reload:detached=${isSectionDetached("s1")}`);
    });
    useNotesStore.setState({ activeNote: note(["s0", "s1"]), reloadActive });
    await handleSectionWindowChanged({ section_id: "s1", open: true });
    expect(isSectionDetached("s1")).toBe(true);

    await handleSectionWindowChanged({ section_id: "s1", open: false });
    expect(order).toEqual(["hook:s1", "reload:detached=true"]);
    expect(isSectionDetached("s1")).toBe(false);
    unhook();
  });

  it("does not reload when the returned section is not in the open note (other note / dashboard)", async () => {
    const reloadActive = vi.fn(async () => {});
    useNotesStore.setState({ activeNote: note(["other"]), reloadActive });
    await handleSectionWindowChanged({ section_id: "s1", open: true });
    await handleSectionWindowChanged({ section_id: "s1", open: false });
    expect(reloadActive).not.toHaveBeenCalled();
    expect(isSectionDetached("s1")).toBe(false);
  });

  it("ignores a close for a section it never saw open (no reload, no hook)", async () => {
    const hook = vi.fn();
    const unhook = registerSectionReturnedHook(hook);
    const reloadActive = vi.fn(async () => {});
    useNotesStore.setState({ activeNote: note(["s1"]), reloadActive });
    await handleSectionWindowChanged({ section_id: "s1", open: false });
    expect(hook).not.toHaveBeenCalled();
    expect(reloadActive).not.toHaveBeenCalled();
    unhook();
  });
});
