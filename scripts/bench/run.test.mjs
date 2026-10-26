// @vitest-environment node
// 러너(run.mjs) 끝까지 — 가짜 suite 를 .eval/ 아래 임시 폴더에 만들어 돌린다. 진짜 기준선·이력 파일은 건드리지 않는다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runBench, parseArgs } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const TMP = join(REPO, ".eval", `bench-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
const SUITES = join(TMP, "suites");
const BASELINES = join(TMP, "baselines");
const HISTORY = join(TMP, "history");
const OUT = join(TMP, "out");
const MACHINE = "test-machine-1t-1g";
const BASELINE_FILE = join(BASELINES, `${MACHINE}.json`);

const REG = {
  "fake.boot_ms": { group: "fake", unit: "ms", direction: "lower", stat: "median", runs: 5, tolerance: { rel: 0.1, abs: 5 }, gate: true, fingerprint_keys: ["machine", "os", "webview2"] },
  "fake.info_ms": { group: "fake", unit: "ms", direction: "lower", stat: "median", runs: 5, tolerance: { rel: 0.1, abs: 5 }, gate: false, fingerprint_keys: ["machine", "os", "webview2"] },
  "fake.size_kb": { group: "fake", unit: "KB", direction: "lower", stat: "value", tolerance: { rel: 0.02, abs: 10 }, gate: true, fingerprint_keys: ["machine", "os"] },
};

const FAKE_SUITE = `
export default {
  name: "fake",
  fingerprint: { webview2: true },
  async preflight(ctx) {
    const f = globalThis.__benchFake;
    if (f.preflightThrow) throw new Error("빌드 없음(가짜)");
    f.ctxSeen = { hasEnv: !!ctx.env, outDir: ctx.outDir, repoRoot: ctx.repoRoot, args: ctx.args };
  },
  async run(ctx) {
    const f = globalThis.__benchFake;
    ctx.setToolchain("webview2", f.webview2);
    ctx.log("measuring");
    if (f.runThrow) throw new Error("측정 실패(가짜)");
    return f.results;
  },
};
`;

function results({ boot = [100, 101, 99, 100, 102], info = [50, 50, 51, 49, 50], size = [1000] } = {}) {
  return [
    { metric: "fake.boot_ms", unit: "ms", samples: boot, workload: { boots: 5 } },
    { metric: "fake.info_ms", unit: "ms", samples: info, workload: { boots: 5 } },
    { metric: "fake.size_kb", unit: "KB", samples: size, workload: {} },
  ];
}

let logs = [];
let errs = [];

async function run(argv, over = {}) {
  logs = [];
  errs = [];
  return runBench({
    argv,
    repoRoot: REPO,
    suitesDir: SUITES,
    baselinesDir: BASELINES,
    historyDir: HISTORY,
    outRoot: OUT,
    registry: REG,
    cpuBusy: async () => 0,
    fingerprintFn: ({ webview2 } = {}) => ({ machine: MACHINE, os: "10.0.0", node: "v0", ...(webview2 ? { webview2 } : {}) }),
    machineIdFn: () => MACHINE,
    gitFn: () => ({ commit: "cafebabe", dirty: false }),
    log: (m) => logs.push(String(m)),
    error: (m) => errs.push(String(m)),
    ...over,
  });
}

const readBaseline = () => JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
beforeAll(() => {
  mkdirSync(SUITES, { recursive: true });
  writeFileSync(join(SUITES, "fake.mjs"), FAKE_SUITE, "utf8");
  writeFileSync(join(SUITES, "broken.mjs"), "export default { name: 'broken' };\n", "utf8");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete globalThis.__benchFake;
});

beforeEach(() => {
  globalThis.__benchFake = { results: results(), webview2: "130.0.1" };
});

describe("parseArgs", () => {
  it("값 플래그·불 플래그·--update=목록·숫자 검증", () => {
    const { args, errors, warnings } = parseArgs([
      "--suite", "app", "--only", "boot,interact", "--update=boot.nav_to_show_ms,boot.booted_ms",
      "--reason", "이유", "--record", "--force", "--baseline=x.json", "--real-data", "--scale",
      "--exe", "C:\\a.exe", "--boots", "8", "--samples=5", "--no-build",
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(args).toMatchObject({
      suite: "app", only: ["boot", "interact"], update: ["boot.nav_to_show_ms", "boot.booted_ms"], reason: "이유",
      record: true, force: true, baseline: "x.json", realData: true, scale: true, exe: "C:\\a.exe", boots: 8, samples: 5, noBuild: true,
    });
    expect(parseArgs(["--update"]).args.update).toBe(true);
    expect(parseArgs(["--boots", "0"]).errors.length).toBe(1);
    expect(parseArgs(["--suite"]).errors.length).toBe(1);
    expect(parseArgs(["--frobnicate"]).warnings.length).toBe(1);
  });
});

describe("runBench — 가짜 suite 로 끝까지", () => {
  it("첫 실행: 기준선 없음 → 전부 NEW, 종료 0, 보고서 두 파일, ctx 모양", async () => {
    expect(await run(["--suite", "fake"])).toBe(0);
    const f = globalThis.__benchFake;
    expect(f.ctxSeen).toMatchObject({ hasEnv: true, repoRoot: REPO });
    expect(f.ctxSeen.outDir.startsWith(OUT)).toBe(true);
    expect(f.ctxSeen.args).toMatchObject({ suite: "fake", only: null, update: false });
    const dir = f.ctxSeen.outDir;
    const runJson = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(runJson.rows.map((r) => r.verdict)).toEqual(["NEW", "NEW", "NEW"]);
    expect(runJson.fingerprint).toMatchObject({ machine: MACHINE, webview2: "130.0.1" });
    expect(runJson.exitCode).toBe(0);
    expect(runJson.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("| fake.boot_ms |");
    expect(logs.some((l) => l.includes("[fake] measuring"))).toBe(true);
    expect(existsSync(BASELINE_FILE)).toBe(false);
  });

  it("--update 에 --reason 이 없으면 suite 를 돌리기 전에 종료 2", async () => {
    globalThis.__benchFake.ctxSeen = undefined;
    expect(await run(["--suite", "fake", "--update"])).toBe(2);
    expect(globalThis.__benchFake.ctxSeen).toBeUndefined();
    expect(errs.join("\n")).toContain("--reason");
    expect(existsSync(BASELINE_FILE)).toBe(false);
  });

  it("--update --reason 으로 첫 기준선 → 같은 값 재실행은 PASS", async () => {
    expect(await run(["--suite", "fake", "--update", "--reason", "first baseline"])).toBe(0);
    const b = readBaseline();
    expect(b).toMatchObject({
      schema: 1,
      kind: "wall",
      fingerprint: { machine: MACHINE, os: "10.0.0" },
      toolchains: { webview2: "130.0.1" },
      updated: { commit: "cafebabe", reason: "first baseline" },
    });
    expect(Object.keys(b.metrics)).toEqual(["fake.boot_ms", "fake.info_ms", "fake.size_kb"]);
    expect(b.metrics["fake.boot_ms"]).toMatchObject({ value: 100, stat: "median", runs: 5, workload: { boots: 5 }, fingerprint: { webview2: "130.0.1" } });

    expect(await run(["--suite", "fake"])).toBe(0);
    const rows = JSON.parse(readFileSync(join(globalThis.__benchFake.ctxSeen.outDir, "run.json"), "utf8")).rows;
    expect(rows.map((r) => r.verdict)).toEqual(["PASS", "PASS", "PASS"]);
  });

  it("gate 지표 회귀 → 종료 1, 정보 지표만 회귀 → 종료 0", async () => {
    globalThis.__benchFake.results = results({ boot: [150, 150, 151, 149, 150] });
    expect(await run(["--suite", "fake"])).toBe(1);
    expect(logs.join("\n")).toMatch(/fake\.boot_ms.*REGRESSED/);

    globalThis.__benchFake.results = results({ info: [90, 90, 91, 89, 90] });
    expect(await run(["--suite", "fake"])).toBe(0);
    expect(logs.join("\n")).toMatch(/fake\.info_ms.*REGRESSED/);
  });

  it("NOISY 는 판정 없이 종료 0, --update 는 그 지표를 거부", async () => {
    globalThis.__benchFake.results = results({ boot: [50, 100, 200, 300, 400] });
    expect(await run(["--suite", "fake", "--update", "--reason", "noisy try"])).toBe(0);
    expect(logs.join("\n")).toMatch(/거부 fake\.boot_ms/);
    expect(readBaseline().metrics["fake.boot_ms"].value).toBe(100);
  });

  it("--update=<id> 로 의도한 회귀를 받아들이면 그 지표만 갱신되고, 받아들인 회귀는 종료 코드에서 빠진다", async () => {
    globalThis.__benchFake.results = results({ boot: [150, 150, 151, 149, 150] });
    expect(await run(["--suite", "fake", "--update=fake.boot_ms", "--reason", "에디터를 부팅으로 올림(의도)"])).toBe(0);
    let b = readBaseline();
    expect(b.metrics["fake.boot_ms"].value).toBe(150);
    expect(b.updated.reason).toBe("에디터를 부팅으로 올림(의도)");
    // 목록 밖의 gate 회귀(size)는 갱신되지 않고 여전히 실패
    globalThis.__benchFake.results = results({ boot: [150, 150, 151, 149, 150], size: [2000] });
    expect(await run(["--suite", "fake", "--update=fake.boot_ms", "--reason", "again"])).toBe(1);
    b = readBaseline();
    expect(b.metrics["fake.size_kb"].value).toBe(1000);
  });

  it("webview2 가 바뀌면 UNCOMPARABLE(종료 0), --update=<id> 로만 재기준선", async () => {
    globalThis.__benchFake.webview2 = "131.0.0";
    globalThis.__benchFake.results = results({ boot: [500, 500, 500, 500, 500] });
    expect(await run(["--suite", "fake"])).toBe(0);
    const rows = JSON.parse(readFileSync(join(globalThis.__benchFake.ctxSeen.outDir, "run.json"), "utf8")).rows;
    expect(rows.find((r) => r.metric === "fake.boot_ms").verdict).toBe("UNCOMPARABLE");
    expect(rows.find((r) => r.metric === "fake.size_kb").verdict).toBe("PASS"); // webview2 를 안 보는 지표

    expect(await run(["--suite", "fake", "--update", "--reason", "bulk"])).toBe(0);
    expect(readBaseline().metrics["fake.boot_ms"].value).toBe(150);
    expect(await run(["--suite", "fake", "--update=fake.boot_ms,fake.info_ms", "--reason", "WebView2 131 재기준선"])).toBe(0);
    expect(readBaseline().metrics["fake.boot_ms"]).toMatchObject({ value: 500, fingerprint: { webview2: "131.0.0" } });
  });

  it("--only 로 거르고, 걸리는 게 없으면 종료 2", async () => {
    globalThis.__benchFake.webview2 = "131.0.0";
    globalThis.__benchFake.results = results({ boot: [500, 500, 500, 500, 500] });
    expect(await run(["--suite", "fake", "--only", "fake.size_kb"])).toBe(0);
    const rows = JSON.parse(readFileSync(join(globalThis.__benchFake.ctxSeen.outDir, "run.json"), "utf8")).rows;
    expect(rows.map((r) => r.metric)).toEqual(["fake.size_kb"]);
    expect(await run(["--suite", "fake", "--only", "nothing"])).toBe(2);
  });

  it("--record 는 이력 파일에 한 줄씩 붙인다", async () => {
    globalThis.__benchFake.webview2 = "131.0.0";
    globalThis.__benchFake.results = results({ boot: [500, 500, 500, 500, 500] });
    expect(await run(["--suite", "fake", "--record"])).toBe(0);
    expect(await run(["--suite", "fake", "--record"])).toBe(0);
    const lines = readFileSync(join(HISTORY, `${MACHINE}.jsonl`), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const h = JSON.parse(lines[0]);
    expect(h).toMatchObject({ commit: "cafebabe", dirty: false, machine: MACHINE, toolchains: { webview2: "131.0.0" } });
    expect(h.metrics["fake.boot_ms"]).toMatchObject({ median: 500, n: 5, verdict: "pass" });
  });

  it("--baseline 으로 다른 파일을 쓴다", async () => {
    const alt = join(TMP, "alt", "base.json");
    expect(await run(["--suite", "fake", "--baseline", alt, "--update", "--reason", "alt"])).toBe(0);
    expect(existsSync(alt)).toBe(true);
    expect(JSON.parse(readFileSync(alt, "utf8")).updated.reason).toBe("alt");
  });

  it("CPU 가 바쁘면 종료 2, --force 면 경고만", async () => {
    expect(await run(["--suite", "fake"], { cpuBusy: async () => 0.5 })).toBe(2);
    expect(errs.join("\n")).toContain("CPU 50.0%");
    expect(await run(["--suite", "fake", "--force"], { cpuBusy: async () => 0.5 })).not.toBe(2);
    expect(logs.join("\n")).toContain("--force 로 계속");
  });

  it("기본 한도는 40% — 상주 프로세스 부하(35%)는 통과, --cpu-limit 로 바꾼다", async () => {
    expect(await run(["--suite", "fake"], { cpuBusy: async () => 0.35 })).not.toBe(2);
    expect(await run(["--suite", "fake", "--cpu-limit", "20"], { cpuBusy: async () => 0.25 })).toBe(2);
    expect(errs.join("\n")).toContain("한도 20%");
    expect(await run(["--suite", "fake", "--cpu-limit", "60"], { cpuBusy: async () => 0.5 })).not.toBe(2);
    expect(await run(["--suite", "fake", "--cpu-limit", "0"])).toBe(2);
  });

  it("설정 오류는 전부 종료 2 — preflight·run 실패, run() 없는 모듈, 같은 지표 두 번, 깨진 기준선", async () => {
    globalThis.__benchFake.preflightThrow = true;
    expect(await run(["--suite", "fake"])).toBe(2);
    expect(errs.join("\n")).toContain("빌드 없음");
    globalThis.__benchFake.preflightThrow = false;

    globalThis.__benchFake.runThrow = true;
    expect(await run(["--suite", "fake"])).toBe(2);
    expect(errs.join("\n")).toContain("측정 실패");
    globalThis.__benchFake.runThrow = false;

    expect(await run(["--suite", "broken"])).toBe(2);
    expect(errs.join("\n")).toContain("run(ctx)");

    globalThis.__benchFake.results = [...results(), results()[0]];
    expect(await run(["--suite", "fake"])).toBe(2);
    expect(errs.join("\n")).toContain("두 번");

    globalThis.__benchFake.results = [];
    expect(await run(["--suite", "fake"])).toBe(2);
    expect(errs.join("\n")).toContain("하나도");

    globalThis.__benchFake.results = results();
    const bad = join(TMP, "bad.json");
    writeFileSync(bad, "{ not json", "utf8");
    expect(await run(["--suite", "fake", "--baseline", bad])).toBe(2);
  });

  it("없는 suite·--help·--suite 없음 → 종료 2 + 안내", async () => {
    expect(await run(["--suite", "nope"])).toBe(2);
    expect(errs.join("\n")).toMatch(/'nope' 가 없다/);
    expect(errs.join("\n")).toMatch(/있는 suite: .*fake/);
    expect(await run(["--help"])).toBe(2);
    expect(logs.join("\n")).toContain("사용법");
    expect(await run([])).toBe(2);
    expect(errs.join("\n")).toContain("--suite 가 필요하다");
    expect(await run(["--suite", "nope"], { suitesDir: join(TMP, "no-such-dir") })).toBe(2);
    expect(errs.join("\n")).toContain("suite 가 아직 없다");
  });
});

describe("run.mjs 를 프로세스로", () => {
  const RUN = join(HERE, "run.mjs");
  it("없는 suite → 종료 2 + 친절한 메시지", () => {
    const r = spawnSync(process.execPath, [RUN, "--suite", "nope-xyz"], { cwd: REPO, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("nope-xyz");
  });
  it("--help → 종료 2 + 사용법", () => {
    const r = spawnSync(process.execPath, [RUN, "--help"], { cwd: REPO, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("사용법");
  });
});
