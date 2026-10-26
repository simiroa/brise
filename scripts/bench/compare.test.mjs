// @vitest-environment node
// 성능 기준선 루프의 판정·형식 고정(docs/PLAN-2026-10-23-perf-baselines.md §2.2·§2.3·§2.5).
import { describe, it, expect } from "vitest";
import { stats, verdict, compareRun, exitCode, matchesAny, NOISY_RATIO } from "./compare.mjs";
import { parseBenchLines, formatBenchLine } from "./benchJson.mjs";
import { applyUpdate, planUpdate, historyEntry } from "./baseline.mjs";
import { cpuSlug, machineSlug } from "./fingerprint.mjs";
import { METRICS } from "./metrics.mjs";

// ── 테스트용 레지스트리 ────────────────────────────────────────────────────────────────
const REG = {
  "t.time_ms": { group: "t", unit: "ms", direction: "lower", stat: "median", runs: 5, tolerance: { rel: 0.2, abs: 1 }, gate: true, fingerprint_keys: ["machine", "os", "rust"] },
  "t.info_time_ms": { group: "t", unit: "ms", direction: "lower", stat: "median", runs: 5, tolerance: { rel: 0.2, abs: 1 }, gate: false, fingerprint_keys: ["machine", "os"] },
  "t.notol_ms": { group: "t", unit: "ms", direction: "lower", stat: "median", runs: 5, tolerance: null, gate: false, fingerprint_keys: ["machine", "os"] },
  "t.size_mb": { group: "t", unit: "MB", direction: "lower", stat: "median", runs: 5, tolerance: { rel: 0.05, abs: 8 }, gate: true, fingerprint_keys: ["machine", "os"] },
  "t.score": { group: "t", unit: "count", direction: "higher", stat: "value", tolerance: { rel: 0, abs: 1 }, gate: true, fingerprint_keys: [] },
};
const FP = { machine: "ryzen9-5900x-24t-128g", os: "10.0.26300", node: "v24.20.0", rust: "rustc 1.96.0" };

function wall(metrics, extra = {}) {
  return {
    schema: 1,
    kind: "wall",
    fingerprint: { machine: FP.machine, os: FP.os },
    toolchains: { rust: FP.rust },
    updated: { date: "2026-10-23", commit: "abcd1234", reason: "test" },
    metrics,
    ...extra,
  };
}
const entry = (value, more = {}) => ({ value, unit: "ms", workload: { notes: 10 }, ...more });
const res = (metric, samples, workload = { notes: 10 }, unit = "ms") => ({ metric, unit, samples, workload });
const one = (rows, id) => rows.find((r) => r.metric === id);

describe("stats", () => {
  it("중앙값·IQR(선형 보간)·n·min·max", () => {
    const s = stats([1.91, 1.88, 1.95, 1.9, 1.89]);
    expect(s.median).toBeCloseTo(1.9, 12);
    expect(s.iqr).toBeCloseTo(0.02, 12);
    expect(s).toMatchObject({ n: 5, min: 1.88, max: 1.95 });
  });
  it("표본 1개면 iqr 0, 짝수 개면 가운데 둘의 평균", () => {
    expect(stats([7])).toEqual({ median: 7, iqr: 0, n: 1, min: 7, max: 7 });
    expect(stats([4, 1, 3, 2]).median).toBe(2.5);
  });
  it("빈 표본은 throw", () => {
    expect(() => stats([])).toThrow();
  });
});

describe("verdict — §2.2 허용폭 경계", () => {
  it("abs 가 rel×base 보다 클 때: 허용폭 = abs, 정확히 같음은 PASS", () => {
    // rel×base = 0.2×10 = 2 < abs 5
    expect(verdict({ base: 10, m: 15, rel: 0.2, abs: 5 })).toEqual({ verdict: "PASS", delta: 5, allowance: 5 });
    expect(verdict({ base: 10, m: 15.01, rel: 0.2, abs: 5 }).verdict).toBe("REGRESSED");
    expect(verdict({ base: 10, m: 5, rel: 0.2, abs: 5 }).verdict).toBe("PASS");
    expect(verdict({ base: 10, m: 4.99, rel: 0.2, abs: 5 }).verdict).toBe("IMPROVED");
  });
  it("rel×base 가 abs 보다 클 때: 허용폭 = rel×base, 정확히 같음은 PASS", () => {
    // rel×base = 0.2×100 = 20 > abs 1
    const v = verdict({ base: 100, m: 120, rel: 0.2, abs: 1 });
    expect(v.verdict).toBe("PASS");
    expect(v.allowance).toBeCloseTo(20, 12);
    expect(verdict({ base: 100, m: 120.5, rel: 0.2, abs: 1 }).verdict).toBe("REGRESSED");
    expect(verdict({ base: 100, m: 80, rel: 0.2, abs: 1 }).verdict).toBe("PASS");
    expect(verdict({ base: 100, m: 79.5, rel: 0.2, abs: 1 }).verdict).toBe("IMPROVED");
  });
  it("부동소수 뺄셈이 허용폭을 미세하게 넘어도 '정확히 같음'은 PASS", () => {
    expect(0.4 - 0.1).toBeGreaterThan(0.3); // 0.30000000000000004 — 이 오차를 흡수해야 한다
    expect(verdict({ base: 0.1, m: 0.4, rel: 0, abs: 0.3 }).verdict).toBe("PASS");
    expect(verdict({ base: 1.9, m: 2.9, rel: 0.2, abs: 1 }).verdict).toBe("PASS");
    expect(verdict({ base: 0.4, m: 0.1, rel: 0, abs: 0.3 }).verdict).toBe("PASS");
  });
  it("IMPROVED 는 base − m 이 허용폭을 넘을 때", () => {
    const v = verdict({ base: 50, m: 30, rel: 0.2, abs: 1 });
    expect(v).toEqual({ verdict: "IMPROVED", delta: -20, allowance: 10 });
  });
  it("IQR 이 허용 오차 절대 하한 이하면 비율이 커도 NOISY 아님 — 작은 값 지표가 늘 판정을 못 내던 것", () => {
    // 대시보드 그리기: 중앙값 6.5 ms, IQR 7.2 ms(비율 1.1) — abs 15 ms 보다 작으니 판정한다.
    expect(verdict({ base: 10.8, m: 6.5, rel: 0.25, abs: 15, iqrRatio: 1.1, iqr: 7.2 }).verdict).toBe("PASS");
    expect(verdict({ base: 13.1, m: 334.9, rel: 0.25, abs: 15, iqrRatio: 0.03, iqr: 8.7 }).verdict).toBe("REGRESSED");
    // IQR 이 하한보다 크면 그대로 NOISY.
    expect(verdict({ base: 10, m: 40, rel: 0.25, abs: 15, iqrRatio: 0.5, iqr: 20 }).verdict).toBe("NOISY");
    // iqr 를 안 주면 예전처럼 비율만.
    expect(verdict({ base: 10.8, m: 6.5, rel: 0.25, abs: 15, iqrRatio: 1.1 }).verdict).toBe("NOISY");
  });

  it("NOISY 가 REGRESSED 보다 우선, 경계(=0.25)는 NOISY 아님", () => {
    expect(verdict({ base: 10, m: 100, rel: 0.2, abs: 1, iqrRatio: 0.3 }).verdict).toBe("NOISY");
    expect(verdict({ base: 10, m: 100, rel: 0.2, abs: 1, iqrRatio: NOISY_RATIO }).verdict).toBe("REGRESSED");
    expect(verdict({ base: 10, m: 10, rel: 0.2, abs: 1, iqrRatio: 0.26 }).verdict).toBe("NOISY");
    expect(verdict({ base: 10, m: 100, rel: 0.2, abs: 1, iqrRatio: null }).verdict).toBe("REGRESSED");
  });
  it("direction 'higher' 면 부호가 뒤집힌다", () => {
    expect(verdict({ base: 10, m: 5, rel: 0, abs: 1, direction: "higher" }).verdict).toBe("REGRESSED");
    expect(verdict({ base: 10, m: 15, rel: 0, abs: 1, direction: "higher" }).verdict).toBe("IMPROVED");
    expect(verdict({ base: 10, m: 9, rel: 0, abs: 1, direction: "higher" }).verdict).toBe("PASS");
  });
  it("허용 오차 0/0 이면 1 만 늘어도 REGRESSED", () => {
    expect(verdict({ base: 3, m: 3, rel: 0, abs: 0 }).verdict).toBe("PASS");
    expect(verdict({ base: 3, m: 4, rel: 0, abs: 0 }).verdict).toBe("REGRESSED");
  });
});

describe("compareRun", () => {
  it("기준선이 없으면 NEW, 흔들린 표본은 NEW 여도 noisy 표시", () => {
    const rows = compareRun({
      baseline: null,
      results: [res("t.time_ms", [10, 10, 10, 10, 10]), res("t.info_time_ms", [5, 10, 20, 30, 40])],
      fingerprint: FP,
      registry: REG,
    });
    expect(one(rows, "t.time_ms")).toMatchObject({ verdict: "NEW", noisy: false, base: null, value: 10, n: 5 });
    expect(one(rows, "t.info_time_ms")).toMatchObject({ verdict: "NEW", noisy: true });
  });

  it("기준선에 없는 지표만 NEW, 있는 지표는 판정", () => {
    const rows = compareRun({
      baseline: wall({ "t.time_ms": entry(10) }),
      results: [res("t.time_ms", [10.5]), res("t.info_time_ms", [3])],
      fingerprint: FP,
      registry: REG,
    });
    expect(one(rows, "t.time_ms")).toMatchObject({ verdict: "PASS", base: 10, delta: 0.5, allowance: 2 });
    expect(one(rows, "t.info_time_ms").verdict).toBe("NEW");
  });

  it("NOISY 는 시간 지표만 — 크기 지표는 IQR 이 커도 판정한다", () => {
    const rows = compareRun({
      baseline: wall({ "t.time_ms": entry(10), "t.size_mb": entry(100, { unit: "MB" }) }),
      results: [res("t.time_ms", [5, 10, 20, 30, 50]), res("t.size_mb", [50, 100, 200, 300, 400], { notes: 10 }, "MB")],
      fingerprint: FP,
      registry: REG,
    });
    expect(one(rows, "t.time_ms").verdict).toBe("NOISY");
    expect(one(rows, "t.size_mb")).toMatchObject({ verdict: "REGRESSED", noisy: false, iqrRatio: null });
  });

  it("UNCOMPARABLE — 지문 키(rust) 가 상단 toolchains 와 다르다", () => {
    const rows = compareRun({
      baseline: wall({ "t.time_ms": entry(10), "t.info_time_ms": entry(10) }),
      results: [res("t.time_ms", [100]), res("t.info_time_ms", [10])],
      fingerprint: { ...FP, rust: "rustc 1.97.0" },
      registry: REG,
    });
    const r = one(rows, "t.time_ms");
    expect(r.verdict).toBe("UNCOMPARABLE");
    expect(r.reason).toContain("rust");
    expect(r.delta).toBe(90);
    // fingerprint_keys 에 rust 가 없는 지표는 영향 없음
    expect(one(rows, "t.info_time_ms").verdict).toBe("PASS");
    expect(exitCode(rows)).toBe(0);
  });

  it("UNCOMPARABLE — 항목별 fingerprint 가 상단 값보다 우선", () => {
    // 상단은 새 rust 로 바뀌었지만(다른 지표만 --update) 이 항목은 옛 rust 에서 기록됐다
    const baseline = wall(
      { "t.time_ms": entry(10, { fingerprint: { machine: FP.machine, os: FP.os, rust: "rustc 1.95.0" } }) },
      { toolchains: { rust: FP.rust } },
    );
    const rows = compareRun({ baseline, results: [res("t.time_ms", [10])], fingerprint: FP, registry: REG });
    expect(one(rows, "t.time_ms").verdict).toBe("UNCOMPARABLE");
  });

  it("UNCOMPARABLE — workload 가 다르다(키 순서는 무관)", () => {
    const baseline = wall({ "t.time_ms": entry(10, { workload: { notes: 10, body_scale: 1 } }) });
    const same = compareRun({ baseline, results: [res("t.time_ms", [10], { body_scale: 1, notes: 10 })], fingerprint: FP, registry: REG });
    expect(one(same, "t.time_ms").verdict).toBe("PASS");
    const diff = compareRun({ baseline, results: [res("t.time_ms", [10], { notes: 100, body_scale: 1 })], fingerprint: FP, registry: REG });
    expect(one(diff, "t.time_ms")).toMatchObject({ verdict: "UNCOMPARABLE" });
    expect(one(diff, "t.time_ms").reason).toContain("workload");
  });

  it("tolerance:null 지표는 판정 없이 값만(INFO), 종료 코드 0", () => {
    const rows = compareRun({
      baseline: wall({ "t.notol_ms": entry(1) }),
      results: [res("t.notol_ms", [1000])],
      fingerprint: FP,
      registry: REG,
    });
    expect(one(rows, "t.notol_ms")).toMatchObject({ verdict: "INFO", allowance: null, delta: 999 });
    expect(exitCode(rows)).toBe(0);
  });

  it("exitCode — gate 지표의 REGRESSED 만 1, gate:false 의 REGRESSED 는 0", () => {
    const baseline = wall({ "t.time_ms": entry(10), "t.info_time_ms": entry(10) });
    const infoOnly = compareRun({ baseline, results: [res("t.time_ms", [10]), res("t.info_time_ms", [100])], fingerprint: FP, registry: REG });
    expect(one(infoOnly, "t.info_time_ms").verdict).toBe("REGRESSED");
    expect(exitCode(infoOnly)).toBe(0);
    const gated = compareRun({ baseline, results: [res("t.time_ms", [100])], fingerprint: FP, registry: REG });
    expect(one(gated, "t.time_ms").verdict).toBe("REGRESSED");
    expect(exitCode(gated)).toBe(1);
    expect(exitCode([])).toBe(0);
  });

  it("direction 'higher' 지표(지문 키 없음)", () => {
    const baseline = wall({ "t.score": { value: 10, unit: "count" } });
    const rows = compareRun({ baseline, results: [res("t.score", [8], {}, "count")], fingerprint: {}, registry: REG });
    expect(one(rows, "t.score").verdict).toBe("REGRESSED");
  });

  it("레지스트리에 없는 지표는 정보 지표(gate:false, INFO)", () => {
    const baseline = wall({ "scale.relations_tab_100k_ms": entry(10) });
    const rows = compareRun({ baseline, results: [res("scale.relations_tab_100k_ms", [500])], fingerprint: FP, registry: REG });
    expect(one(rows, "scale.relations_tab_100k_ms")).toMatchObject({ verdict: "INFO", gate: false });
  });

  it("같은 지표 두 번 · 레지스트리와 다른 단위는 throw(측정기 버그)", () => {
    expect(() =>
      compareRun({ baseline: null, results: [res("t.time_ms", [1]), res("t.time_ms", [2])], fingerprint: FP, registry: REG }),
    ).toThrow(/두 번/);
    expect(() => compareRun({ baseline: null, results: [res("t.time_ms", [1], {}, "s")], fingerprint: FP, registry: REG })).toThrow(/단위/);
  });
});

describe("matchesAny — --only/--update 목록", () => {
  it("정확한 id 또는 '.' 경계의 영역 접두", () => {
    expect(matchesAny("search.question_avg_ms", ["search"])).toBe(true);
    expect(matchesAny("search.question_avg_ms", ["search."])).toBe(true);
    expect(matchesAny("search.question_avg_ms", ["search.question_avg_ms"])).toBe(true);
    expect(matchesAny("searchx.a_ms", ["search"])).toBe(false);
    expect(matchesAny("export.hwpx_ms_300img", ["search", "export"])).toBe(true);
    expect(matchesAny("a.b", null)).toBe(true);
  });
});

describe("parseBenchLines / formatBenchLine — §2.3", () => {
  const cargoOut = [
    "   Compiling brise v0.5.3 (C:\\x\\src-tauri)",
    "    Finished `release` profile [optimized] target(s) in 1m 02s",
    "     Running tests\\bench_question_search.rs (target\\release\\deps\\bench_question_search-abc.exe)",
    "",
    "running 2 tests",
    // --nocapture --test-threads=1: 테스트 이름 줄에 첫 println! 이 이어 붙는다
    'test question_search_vs_sentence_search_timing ... BENCH-JSON {"metric":"search.question_avg_ms","unit":"ms","samples":[1.91,1.88,1.95,1.9,1.89],"workload":{"notes":10000,"body_scale":1}}',
    "| 질문검색 평균 | 1.90ms |   ← 사람용 표",
    "이 줄은 BENCH-JSON 줄을 낸다는 설명일 뿐이다",
    'BENCH-JSON {"metric":"index.bigram_mb_10k","unit":"MB","samples":[12.5],"workload":{"notes":10000,"body_scale":1}}\r',
    "ok",
    "",
    "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 41.20s",
  ].join("\r\n");

  it("사람용 줄이 섞인 cargo 출력에서 BENCH-JSON 만 뽑는다(줄 중간 마커·CRLF 포함)", () => {
    const got = parseBenchLines(cargoOut);
    expect(got).toEqual([
      { metric: "search.question_avg_ms", unit: "ms", samples: [1.91, 1.88, 1.95, 1.9, 1.89], workload: { notes: 10000, body_scale: 1 } },
      { metric: "index.bigram_mb_10k", unit: "MB", samples: [12.5], workload: { notes: 10000, body_scale: 1 } },
    ]);
  });

  it("BENCH-JSON 이 없으면 빈 배열", () => {
    expect(parseBenchLines("running 0 tests\ntest result: ok.")).toEqual([]);
    expect(parseBenchLines("")).toEqual([]);
  });

  it("마커 뒤 JSON 이 깨졌으면 조용히 넘기지 않고 throw", () => {
    expect(() => parseBenchLines('BENCH-JSON {"metric":"a.b_ms","unit":"ms","samples":[1]')).toThrow(/BENCH-JSON/);
    expect(() => parseBenchLines('test x ... BENCH-JSON {"metric":"a.b_ms","unit":"ms","samples":[1]} ok')).toThrow(/BENCH-JSON/);
    expect(() => parseBenchLines('BENCH-JSON {"metric":"a.b_ms","unit":"ms","samples":[]}')).toThrow(/samples/);
    expect(() => parseBenchLines('BENCH-JSON {"metric":"a.b_ms","unit":"ms","samples":["1"]}')).toThrow(/samples/);
    expect(() => parseBenchLines('BENCH-JSON {"metric":"nodot","unit":"ms","samples":[1]}')).toThrow(/metric/);
  });

  it("formatBenchLine 은 parseBenchLines 로 되읽힌다(workload 기본 {})", () => {
    const line = formatBenchLine({ metric: "boot.nav_to_show_ms", unit: "ms", samples: [500, 510] });
    expect(line.startsWith("BENCH-JSON {")).toBe(true);
    expect(parseBenchLines(`noise\n${line}\n`)).toEqual([{ metric: "boot.nav_to_show_ms", unit: "ms", samples: [500, 510], workload: {} }]);
    expect(() => formatBenchLine({ metric: "boot.x_ms", unit: "ms", samples: [] })).toThrow();
  });
});

describe("applyUpdate / planUpdate — §2.5 기준선 갱신", () => {
  const baseline = wall({ "t.time_ms": entry(10), "t.info_time_ms": entry(10) });
  const rowsFor = (results, fp = FP, b = baseline) => compareRun({ baseline: b, results, fingerprint: fp, registry: REG });
  const opts = { reason: "test update", commit: "deadbeef", date: "2026-10-24", fingerprint: FP, toolchains: { rust: FP.rust }, kind: "wall" };

  it("reason 이 없으면 throw", () => {
    const rows = rowsFor([res("t.time_ms", [12])]);
    expect(() => applyUpdate(baseline, rows, { ...opts, reason: "" })).toThrow(/reason/);
    expect(() => applyUpdate(baseline, rows, { ...opts, reason: undefined })).toThrow(/reason/);
    expect(() => applyUpdate(baseline, rows, { ...opts, reason: "   " })).toThrow(/reason/);
  });

  it("NOISY 행은 거부 — 기준선 값이 그대로", () => {
    const rows = rowsFor([res("t.time_ms", [5, 10, 20, 30, 50]), res("t.info_time_ms", [11, 11, 11, 11, 11])]);
    expect(one(rows, "t.time_ms").verdict).toBe("NOISY");
    const plan = planUpdate(rows);
    expect(plan.refuse.map((r) => r.metric)).toEqual(["t.time_ms"]);
    const next = applyUpdate(baseline, rows, opts);
    expect(next.metrics["t.time_ms"].value).toBe(10);
    expect(next.metrics["t.info_time_ms"].value).toBe(11);
  });

  it("기준선이 없는 첫 기록(NEW)도 표본이 흔들리면 거부(§1.4)", () => {
    const rows = rowsFor([res("t.time_ms", [5, 10, 20, 30, 50]), res("t.info_time_ms", [3, 3, 3, 3, 3])], FP, null);
    expect(rows.every((r) => r.verdict === "NEW")).toBe(true);
    const next = applyUpdate(null, rows, opts);
    expect(Object.keys(next.metrics)).toEqual(["t.info_time_ms"]);
  });

  it("--update=목록 이면 그 지표만 고치고 나머지 기준선은 보존", () => {
    const rows = rowsFor([res("t.time_ms", [20, 20, 20, 20, 20]), res("t.info_time_ms", [30, 30, 30, 30, 30])]);
    const next = applyUpdate(baseline, rows, { ...opts, only: ["t.info_time_ms"] });
    expect(next.metrics["t.time_ms"]).toEqual(baseline.metrics["t.time_ms"]);
    expect(next.metrics["t.info_time_ms"].value).toBe(30);
    expect(planUpdate(rows, { only: ["t.info_time_ms", "t.typo_ms"] }).unknown).toEqual(["t.typo_ms"]);
    // 입력은 건드리지 않는다
    expect(baseline.metrics["t.info_time_ms"].value).toBe(10);
  });

  it("UNCOMPARABLE 은 목록 없는 --update 로는 거부, --update=<id> 로 이름을 적으면 재기준선", () => {
    const newFp = { ...FP, rust: "rustc 1.97.0" };
    const rows = rowsFor([res("t.time_ms", [20, 20, 20, 20, 20])], newFp);
    expect(one(rows, "t.time_ms").verdict).toBe("UNCOMPARABLE");
    const bulk = applyUpdate(baseline, rows, { ...opts, fingerprint: newFp, toolchains: { rust: newFp.rust } });
    expect(bulk.metrics["t.time_ms"].value).toBe(10);
    const named = applyUpdate(baseline, rows, { ...opts, only: ["t.time_ms"], fingerprint: newFp, toolchains: { rust: newFp.rust } });
    expect(named.metrics["t.time_ms"]).toMatchObject({ value: 20, fingerprint: { rust: "rustc 1.97.0" } });
    // 갱신하지 않은 지표는 옛 rust 로 비교된다(항목별 fingerprint 가 없으면 상단 값 — 여기선 상단이 새 값으로 바뀌었으므로
    // 항목별 기록이 있어야 섞이지 않는다: 새로 쓴 항목엔 fingerprint 가 있다)
    expect(named.toolchains.rust).toBe("rustc 1.97.0");
  });

  it("§2.5 항목 모양 — value·unit·stat·runs·spread·workload·fingerprint_keys·fingerprint·direction·tolerance·gate", () => {
    const rows = rowsFor([res("t.time_ms", [10, 11, 12, 13, 14], { notes: 10 })]);
    const next = applyUpdate(baseline, rows, opts);
    expect(next.metrics["t.time_ms"]).toEqual({
      value: 12,
      unit: "ms",
      stat: "median",
      runs: 5,
      spread: 2,
      workload: { notes: 10 },
      fingerprint_keys: ["machine", "os", "rust"],
      fingerprint: { machine: FP.machine, os: FP.os, rust: FP.rust },
      direction: "lower",
      tolerance: { rel: 0.2, abs: 1 },
      gate: true,
    });
    expect(next).toMatchObject({
      schema: 1,
      kind: "wall",
      fingerprint: { machine: FP.machine, os: FP.os },
      updated: { date: "2026-10-24", commit: "deadbeef", reason: "test update" },
    });
    expect(Object.keys(next)).toEqual(["schema", "kind", "fingerprint", "toolchains", "updated", "metrics"]);
  });

  it("지표 키는 정렬돼서 diff 가 안정적", () => {
    const rows = rowsFor([res("t.time_ms", [10]), res("t.info_time_ms", [10])], FP, null);
    const next = applyUpdate(null, rows, opts);
    expect(Object.keys(next.metrics)).toEqual(["t.info_time_ms", "t.time_ms"]);
  });

  it("kind 'bundle' — 상단 roots·authority 보존, toolchain(단수), 결정적 항목엔 stat/runs 없음", () => {
    const bundleBase = { schema: 1, kind: "bundle", authority: "ci-linux", roots: { boot_main: ["src/main.tsx"] }, metrics: {} };
    const rows = compareRun({
      baseline: bundleBase,
      results: [{ metric: "bundle.boot_main_js_kb", unit: "KB", samples: [1234.5], workload: {} }],
      fingerprint: {},
      registry: METRICS,
    });
    expect(one(rows, "bundle.boot_main_js_kb").verdict).toBe("NEW");
    const next = applyUpdate(bundleBase, rows, { reason: "first baseline", commit: "c", date: "d", toolchains: { node: "v24", vite: "7" }, kind: "bundle" });
    expect(next.roots).toEqual(bundleBase.roots);
    expect(next.authority).toBe("ci-linux");
    expect(next.toolchain).toEqual({ node: "v24", vite: "7" });
    expect(next.metrics["bundle.boot_main_js_kb"]).toEqual({
      value: 1234.5,
      unit: "KB",
      direction: "lower",
      tolerance: { rel: 0.01, abs: 10 },
      gate: true,
    });
  });

  it("historyEntry — §2.5 이력 한 줄 모양", () => {
    const rows = rowsFor([res("t.time_ms", [1.91, 1.88, 1.95, 1.9, 1.89])]);
    const h = historyEntry({ date: "2026-10-23T01:23:45+09:00", commit: "a97c72a1", dirty: false, machine: FP.machine, toolchains: { rust: FP.rust }, rows });
    expect(h).toEqual({
      date: "2026-10-23T01:23:45+09:00",
      commit: "a97c72a1",
      dirty: false,
      machine: FP.machine,
      toolchains: { rust: FP.rust },
      // 기준 10 대비 1.9 — 판정은 소문자로 남는다
      metrics: { "t.time_ms": { median: 1.9, iqr: 0.02, n: 5, verdict: "improved" } },
    });
  });
});

describe("fingerprint — machine id 슬러그", () => {
  it("이 PC 의 CPU 문자열(끝 공백·N-Core Processor 포함) → ryzen9-5900x-24t-128g", () => {
    expect(machineSlug("AMD Ryzen 9 5900X 12-Core Processor            ", 24, 127.888 * 2 ** 30)).toBe("ryzen9-5900x-24t-128g");
  });
  it("Intel·기타 모델 문자열", () => {
    expect(cpuSlug("12th Gen Intel(R) Core(TM) i7-12700K")).toBe("i7-12700k");
    expect(cpuSlug("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")).toBe("xeon-e5-2680-v4");
    expect(cpuSlug("AMD Ryzen 7 5800H with Radeon Graphics")).toBe("ryzen7-5800h");
    expect(cpuSlug("Intel(R) Core(TM) Ultra 7 155H")).toBe("ultra7-155h");
    expect(cpuSlug("")).toBe("unknown-cpu");
    expect(machineSlug("12th Gen Intel(R) Core(TM) i7-12700K", 20, 32 * 2 ** 30)).toBe("i7-12700k-20t-32g");
  });
});

describe("METRICS 레지스트리 — 계획 표 그대로", () => {
  it("그룹별 개수와 대표 id", () => {
    const count = (g) => Object.values(METRICS).filter((m) => m.group === g).length;
    expect(count("bundle")).toBe(8);
    expect(count("rust")).toBe(11);
    expect(count("app")).toBe(13); // interact.dashboard_tab_paint_ms 추가(2026-10-23 3단계 검증)
    for (const id of ["bundle.boot_main_js_kb", "search.question_avg_ms", "boot.nav_to_show_ms", "write.fts_upsert_1k_ms", "boot.ipc_before_show"]) {
      expect(METRICS[id]).toBeTruthy();
    }
  });
  it("모든 항목이 같은 모양", () => {
    for (const [id, m] of Object.entries(METRICS)) {
      expect(id).toMatch(/^(bundle|search|write|index|export|boot|interact|scale)\.[a-z0-9_]+$/);
      expect(["bundle", "rust", "app"]).toContain(m.group);
      expect(["KB", "MB", "ms", "count"]).toContain(m.unit);
      expect(m.direction).toBe("lower");
      expect(["value", "median"]).toContain(m.stat);
      expect(typeof m.gate).toBe("boolean");
      expect(Array.isArray(m.fingerprint_keys)).toBe(true);
      if (m.tolerance !== null) {
        expect(m.tolerance.rel).toBeGreaterThanOrEqual(0);
        expect(m.tolerance.abs).toBeGreaterThanOrEqual(0);
      } else {
        expect(m.gate).toBe(false); // 허용 오차 '—' 는 정보 지표뿐
      }
    }
  });
  it("지문 키 — bundle 은 없음, rust 는 rust, app 은 webview2", () => {
    expect(METRICS["bundle.total_js_kb"].fingerprint_keys).toEqual([]);
    expect(METRICS["export.docx_peak_heap_mb"].fingerprint_keys).toEqual(["machine", "os", "rust"]);
    expect(METRICS["interact.search_box_ms"].fingerprint_keys).toEqual(["machine", "os", "webview2"]);
  });
});
