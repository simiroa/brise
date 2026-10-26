import { describe, it, expect, vi } from "vitest";

const { emit } = vi.hoisted(() => ({ emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit }));

import { requestOpenNoteInMain } from "./openNoteInMain";

describe("requestOpenNoteInMain", () => {
  it("emits pet-open-note with note_id", async () => {
    await requestOpenNoteInMain("n1");
    expect(emit).toHaveBeenCalledWith("pet-open-note", { note_id: "n1" });
  });
});
