import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const callSilent = vi.fn();
const setEmojiRenderState = vi.fn();
vi.mock("./invoke", () => ({ call: vi.fn(), callSilent: (...a: unknown[]) => callSilent(...a) }));
vi.mock("./emoji/emojiCore", () => ({ setEmojiRenderState: (...a: unknown[]) => setEmojiRenderState(...a) }));
vi.mock("./baseDirCache", () => ({ createBaseDirCache: () => () => ({ baseDir: "/b", convert: null }) }));

import { useEmojiRenderSync } from "./emojiBase";

describe("useEmojiRenderSync", () => {
  beforeEach(() => {
    callSilent.mockReset().mockResolvedValue({ color: { present: true } });
    setEmojiRenderState.mockReset();
  });
  it("sets base and colorPresent", async () => {
    renderHook(() => useEmojiRenderSync());
    await vi.waitFor(() => expect(setEmojiRenderState).toHaveBeenCalledWith({ colorPresent: true }));
    expect(setEmojiRenderState).toHaveBeenCalledWith({ base: "/b", convert: null });
  });
  it("skips status query when skipStatus", () => {
    renderHook(() => useEmojiRenderSync(true));
    expect(callSilent).not.toHaveBeenCalled();
  });
});
