import { describe, expect, it } from "vitest";
import { createMemoryChunkStore } from "./voiceChunkStore";

const meta = (id: string) => ({ id, mimeType: "audio/webm", startedAt: "2026-10-06T00:00:00.000Z" });

describe("memory chunk store", () => {
  it("returns chunks in seq order regardless of write order, with counts", async () => {
    const s = createMemoryChunkStore();
    await s.putSession(meta("a"));
    await s.putChunk("a", 2, new Blob(["c"]));
    await s.putChunk("a", 0, new Blob(["a"]));
    await s.putChunk("a", 1, new Blob(["b"]));
    expect((await s.listSessions())[0]).toMatchObject({ id: "a", chunkCount: 3 });
    const text = await Promise.all((await s.getChunks("a")).map((b) => b.text()));
    expect(text.join("")).toBe("abc");
  });

  it("deleteSession removes only that session (negative: the other survives)", async () => {
    const s = createMemoryChunkStore();
    await s.putSession(meta("a"));
    await s.putSession(meta("b"));
    await s.putChunk("a", 0, new Blob(["x"]));
    await s.putChunk("b", 0, new Blob(["y"]));
    await s.deleteSession("a");
    expect(await s.getChunks("a")).toEqual([]);
    expect((await s.listSessions()).map((x) => x.id)).toEqual(["b"]);
    expect(await s.getChunks("b")).toHaveLength(1);
  });
});
