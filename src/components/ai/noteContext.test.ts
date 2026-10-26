import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => ({ callSilent: vi.fn() }));
vi.mock("../../lib/invoke", () => ({ callSilent: invoke.callSilent }));

import { readNoteForContext } from "./noteContext";

const detail = {
  note: { id: "n1", title: "내 이력" },
  sections: [
    { id: "a", body_md: "첫째" },
    { id: "b", body_md: "둘째" },
  ],
};

beforeEach(() => {
  invoke.callSilent.mockReset();
});

describe("readNoteForContext", () => {
  it("joins the section bodies with a blank line, exactly as the AI-ask `note` reference did", async () => {
    invoke.callSilent.mockResolvedValue(detail);
    expect(await readNoteForContext("n1")).toEqual({ title: "내 이력", body: "첫째\n\n둘째" });
    expect(invoke.callSilent).toHaveBeenCalledWith("note_get", { id: "n1" });
  });

  it("leaves out the one section it is told to skip", async () => {
    invoke.callSilent.mockResolvedValue(detail);
    expect((await readNoteForContext("n1", { skipSectionId: "a" }))?.body).toBe("둘째");
    expect((await readNoteForContext("n1", { skipSectionId: null }))?.body).toBe("첫째\n\n둘째");
  });

  it("returns null when the note cannot be read", async () => {
    invoke.callSilent.mockRejectedValue(new Error("NOT_FOUND"));
    expect(await readNoteForContext("gone")).toBeNull();
  });
});
