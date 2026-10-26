import { describe, it, expect, vi } from "vitest";

vi.mock("./invoke", () => ({ emitNotice: vi.fn() }));
// 문구가 아니라 "어느 키를 어떤 숫자로 불렀는가"를 검증한다 — 번역문을 테스트에 박지 않는다.
vi.mock("../i18n/t", () => ({
  t: (path: string, params?: Record<string, unknown>) => `${path}:${JSON.stringify(params ?? {})}`,
}));

import { runBatch, reportBatch } from "./batchActions";
import { emitNotice } from "./invoke";

describe("runBatch", () => {
  it("runs once per id, sequentially, and reports every id as ok", async () => {
    const seen: string[] = [];
    const res = await runBatch(["a", "b", "c"], async (id) => {
      seen.push(id);
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(res).toEqual({ ok: ["a", "b", "c"], failed: [] });
  });

  it("keeps going after a mid-batch failure and reports which ids failed", async () => {
    const run = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("boom");
    });
    const res = await runBatch(["a", "b", "c"], run);
    // 실패해도 배치를 멈추지 않는다 — 남은 항목까지 시도한다.
    expect(run).toHaveBeenCalledTimes(3);
    expect(res.ok).toEqual(["a", "c"]);
    expect(res.failed).toEqual(["b"]);
  });

  it("reports progress after each item", async () => {
    const progress: Array<[number, number]> = [];
    await runBatch(["a", "b"], async () => {}, (done, total) => progress.push([done, total]));
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("reportBatch", () => {
  it("does not pretend a partial failure was a success", () => {
    vi.mocked(emitNotice).mockClear();
    reportBatch({ ok: ["a"], failed: ["b"] });
    expect(vi.mocked(emitNotice).mock.calls[0][0]).toBe(
      'selection.batch_partial:{"ok":1,"failed":1}',
    );
  });

  it("uses the plain done message when nothing failed", () => {
    vi.mocked(emitNotice).mockClear();
    reportBatch({ ok: ["a", "b"], failed: [] });
    expect(vi.mocked(emitNotice).mock.calls[0][0]).toBe('selection.batch_done:{"n":2}');
  });
});
