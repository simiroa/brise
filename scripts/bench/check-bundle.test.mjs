// @vitest-environment node
// 부팅 번들 크기 래칫(docs/PLAN-2026-10-23-perf-baselines.md §3) — 닫힘 계산·CSS 합·루트 누락=2·30 KB 증가=REGRESSED.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  main,
  measureSet,
  measureGraph,
  validateGraph,
  verifyAgainstOutDir,
  SET_METRICS,
  LOCALE_KO_MODULE,
  DEFAULT_BASELINE,
} from "./check-bundle.mjs";
import bundleGraph, { buildGraph, relModuleId, graphPath, DEFAULT_GRAPH_PATH } from "./bundleGraph.vite.mjs";
import { loadBaseline } from "./baseline.mjs";
import { METRICS } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE = join(HERE, "fixtures", "bundle-graph.small.json");
const KB = 1024;

const ROOTS = {
  boot_main: ["src/main.tsx", "src/App.tsx", "src/i18n/locale-ko.ts", "src/stores/settings.ts", "src/components/Toast.tsx"],
  boot_mobile: ["src/main.tsx", "src/mobile/MobileApp.tsx", "src/i18n/locale-ko.ts", "src/components/Toast.tsx"],
  boot_settings_window: ["src/main.tsx", "src/settings/SettingsWindowApp.tsx", "src/components/Toast.tsx"],
};

const readFixture = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

function baselineFile(dir, roots = ROOTS, metrics = {}) {
  const p = join(dir, "bundle.json");
  writeFileSync(p, JSON.stringify({ schema: 1, kind: "bundle", authority: "ci-linux", roots, metrics }, null, 2) + "\n");
  return p;
}

function run(argv, extra = {}) {
  const out = [];
  const err = [];
  const promise = main({
    argv,
    repoRoot: REPO_ROOT,
    env: {},
    gitFn: () => ({ commit: "testsha1", dirty: false }),
    now: () => new Date(2026, 9, 23, 12, 0, 0),
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
    ...extra,
  });
  return promise.then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "check-bundle-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("measureSet — 정적 닫힘", () => {
  const g = validateGraph(readFixture());

  it("루트가 든 청크에서 imports(정적)만 따라간다 — 동적 import·다른 창 청크는 안 든다, 순환은 한 번만", () => {
    const m = measureSet(g, ROOTS.boot_main);
    expect(m.missing).toEqual([]);
    expect(m.broken).toEqual([]);
    expect(m.chunks.map((c) => c.fileName).sort()).toEqual([
      "assets/App-CCC.js",
      "assets/Toast-GGG.js",
      "assets/cycle-JJJ.js",
      "assets/index-AAA.js",
      "assets/locale-ko-EEE.js",
      "assets/react-BBB.js",
      "assets/shared-HHH.js",
    ]);
    // 10240 + 20480 + 51200 + 4096 + 1024 + 8192 + 2048
    expect(m.jsBytes).toBe(97280);
    // 동적 import 목록: App → Editor, index → Mobile·Settings (닫힘에 든 App·Toast·locale·shared 는 빠진다)
    expect(m.dynamicImports.map((d) => d.fileName).sort()).toEqual([
      "assets/Editor-III.js",
      "assets/Mobile-DDD.js",
      "assets/Settings-FFF.js",
    ]);
    expect(m.dynamicImports.find((d) => d.fileName === "assets/Editor-III.js").facadeModuleId).toBe(
      "src/components/EditorPanel.tsx",
    );
  });

  it("CSS 는 닫힘 청크들의 importedCss 합집합 — 두 청크가 같은 CSS 를 끌어도 한 번만 센다", () => {
    const m = measureSet(g, ROOTS.boot_main);
    expect(m.css.map((c) => c.fileName)).toEqual(["assets/App-y.css", "assets/index-x.css", "assets/shared-z.css"]);
    expect(m.cssBytes).toBe(2048 + 3072 + 1024);
  });

  it("공유 청크 안의 모듈(src/stores/settings.ts)도 그 청크로 찾는다", () => {
    const m = measureSet(g, ["src/stores/settings.ts"]);
    expect(m.rootChunks).toEqual([{ root: "src/stores/settings.ts", files: ["assets/shared-HHH.js"] }]);
    expect(m.chunks.map((c) => c.fileName).sort()).toEqual(["assets/cycle-JJJ.js", "assets/shared-HHH.js"]);
  });

  it("그래프에 없는 루트는 missing 으로 — 0 바이트로 넘어가지 않는다", () => {
    const m = measureSet(g, ["src/main.tsx", "src/Nope.tsx"]);
    expect(m.missing).toEqual(["src/Nope.tsx"]);
  });

  it("그래프에 없는 청크를 가리키는 import 는 broken", () => {
    const bad = readFixture();
    bad.chunks.find((c) => c.fileName === "assets/Toast-GGG.js").imports.push("assets/ghost.js");
    const m = measureSet(validateGraph(bad), ROOTS.boot_main);
    expect(m.broken).toEqual(["assets/ghost.js"]);
  });
});

describe("measureGraph — §3.1 지표", () => {
  it("모든 지표 값", () => {
    const { results, problems } = measureGraph(validateGraph(readFixture()), ROOTS);
    expect(problems).toEqual([]);
    const v = Object.fromEntries(results.map((r) => [r.metric, r.samples[0]]));
    expect(v).toEqual({
      "bundle.boot_main_js_kb": 97280 / KB,
      "bundle.boot_main_css_kb": 6144 / KB,
      "bundle.boot_mobile_js_kb": (10240 + 20480 + 30720 + 4096 + 1024 + 8192 + 2048) / KB,
      "bundle.boot_mobile_js_gzip_kb": (3000 + 6000 + 9000 + 1200 + 300 + 2500 + 700) / KB,
      "bundle.boot_settings_window_js_kb": (10240 + 20480 + 6144 + 4096 + 1024 + 2048) / KB,
      "bundle.locale_ko_kb": 8192 / KB,
      "bundle.total_js_kb": (10240 + 20480 + 51200 + 30720 + 4096 + 1024 + 8192 + 6144 + 2048 + 102400) / KB,
      "bundle.chunk_count": 10,
    });
    for (const r of results) {
      expect(r.unit).toBe(METRICS[r.metric].unit);
      expect(r.samples).toHaveLength(1);
      expect(r.workload).toEqual({});
    }
  });

  it("레지스트리의 bundle 지표를 전부 낸다(빠뜨린 지표가 없다)", () => {
    const { results } = measureGraph(validateGraph(readFixture()), ROOTS);
    const bundleIds = Object.keys(METRICS).filter((id) => METRICS[id].group === "bundle");
    expect(results.map((r) => r.metric).sort()).toEqual(bundleIds.sort());
    for (const ids of Object.values(SET_METRICS)) for (const id of Object.values(ids)) expect(METRICS[id]?.group).toBe("bundle");
  });

  it("roots 집합이 빠지면 problem", () => {
    const { problems } = measureGraph(validateGraph(readFixture()), { boot_main: ROOTS.boot_main, boot_mobile: ROOTS.boot_mobile });
    expect(problems.join("\n")).toMatch(/roots\.boot_settings_window/);
  });
});

describe("main — 종료 코드(§2.2)", () => {
  it("기준선이 비면 NEW·종료 0, --update 로 기록한 뒤 같은 그래프는 PASS·종료 0 (roots·authority 는 보존)", async () => {
    const b = baselineFile(tmp);
    let r = await run(["--graph", FIXTURE, "--baseline", b]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/NEW/);

    r = await run(["--graph", FIXTURE, "--baseline", b, "--update", "--reason", "test baseline"]);
    expect(r.code).toBe(0);
    const saved = loadBaseline(b);
    expect(saved.kind).toBe("bundle");
    expect(saved.authority).toBe("ci-linux");
    expect(saved.roots).toEqual(ROOTS);
    expect(saved.updated).toEqual({ date: "2026-10-23", commit: "testsha1", reason: "test baseline" });
    expect(saved.toolchain).toEqual({ node: "v20.0.0", rollup: "4.0.0", vite: "7.0.0", esbuild: "0.25.0" });
    expect(saved.metrics["bundle.boot_main_js_kb"]).toMatchObject({ value: 95, unit: "KB", gate: true, tolerance: { rel: 0.01, abs: 10 } });
    expect(Object.keys(saved.metrics)).toHaveLength(8);

    r = await run(["--graph", FIXTURE, "--baseline", b]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PASS 8/);
  });

  // 작은 그래프(기준 95 KB → 허용폭 = abs 10 KB)라 30 KB 가 넘친다. 실제 기준선(~1616 KB)에선 허용폭이 rel 2% = 32.3 KB 다.
  it("부팅 청크를 30 KB 키우면 REGRESSED·종료 1, --update --reason 뒤엔 통과", async () => {
    const b = baselineFile(tmp);
    expect((await run(["--graph", FIXTURE, "--baseline", b, "--update", "--reason", "seed"])).code).toBe(0);

    const inflated = readFixture();
    inflated.chunks.find((c) => c.fileName === "assets/App-CCC.js").bytes += 30 * KB;
    const gPath = join(tmp, "graph-inflated.json");
    writeFileSync(gPath, JSON.stringify(inflated));

    let r = await run(["--graph", gPath, "--baseline", b]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bundle\.boot_main_js_kb\s+125\.00 KB.*REGRESSED\s+gate/);
    // 모바일·설정 창 집합은 App 청크를 안 끌어서 그대로
    expect(r.out).toMatch(/bundle\.boot_mobile_js_kb\s.*PASS/);

    r = await run(["--graph", gPath, "--baseline", b, "--update", "--reason", "의도한 증가"]);
    expect(r.code).toBe(0);
    expect(loadBaseline(b).metrics["bundle.boot_main_js_kb"].value).toBe(125);
    r = await run(["--graph", gPath, "--baseline", b]);
    expect(r.code).toBe(0);
  });

  it("허용폭 안의 증가(9 KB < abs 10 KB)는 PASS", async () => {
    const b = baselineFile(tmp);
    await run(["--graph", FIXTURE, "--baseline", b, "--update", "--reason", "seed"]);
    const g = readFixture();
    g.chunks.find((c) => c.fileName === "assets/App-CCC.js").bytes += 9 * KB;
    const gPath = join(tmp, "graph-9k.json");
    writeFileSync(gPath, JSON.stringify(g));
    const r = await run(["--graph", gPath, "--baseline", b]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/bundle\.boot_main_js_kb\s.*PASS/);
  });

  it("roots 의 모듈이 그래프에 없으면 종료 2 — 값을 내지 않는다", async () => {
    const b = baselineFile(tmp, { ...ROOTS, boot_main: [...ROOTS.boot_main, "src/Renamed.tsx"] });
    const r = await run(["--graph", FIXTURE, "--baseline", b]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/src\/Renamed\.tsx/);
    expect(r.out).not.toMatch(/bundle\.boot_main_js_kb/);
  });

  it("그래프 없음·기준선 없음·--update 에 --reason 없음·모르는 플래그 → 종료 2", async () => {
    const b = baselineFile(tmp);
    expect((await run(["--graph", join(tmp, "nope.json"), "--baseline", b])).code).toBe(2);
    expect((await run(["--graph", FIXTURE, "--baseline", join(tmp, "nope.json")])).code).toBe(2);
    expect((await run(["--graph", FIXTURE, "--baseline", b, "--update"])).code).toBe(2);
    expect((await run(["--graph", FIXTURE, "--baseline", b, "--bogus"])).code).toBe(2);
    expect(existsSync(b) && loadBaseline(b).metrics).toEqual({});
  });

  it("그래프 바이트가 outDir 의 실제 파일과 다르면 종료 2(오래된 그래프)", async () => {
    const out = join(tmp, "dist");
    const g = readFixture();
    g.outDir = out;
    for (const item of [...g.chunks, ...g.assets]) {
      mkdirSync(dirname(join(out, item.fileName)), { recursive: true });
      writeFileSync(join(out, item.fileName), Buffer.alloc(item.bytes));
    }
    const gPath = join(tmp, "graph-out.json");
    writeFileSync(gPath, JSON.stringify(g));
    expect(verifyAgainstOutDir(g, REPO_ROOT)).toMatchObject({ checked: true, mismatches: [] });
    const b = baselineFile(tmp);
    expect((await run(["--graph", gPath, "--baseline", b])).code).toBe(0);

    writeFileSync(join(out, "assets/App-CCC.js"), Buffer.alloc(10));
    const r = await run(["--graph", gPath, "--baseline", b]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/App-CCC\.js: 그래프 51200 B ≠ 파일 10 B/);
  });

  it("--explain 은 집합별 청크·CSS·동적 import 목록을 찍는다", async () => {
    const r = await run(["--graph", FIXTURE, "--baseline", baselineFile(tmp), "--explain"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/── boot_main — 루트 5개 → 정적 닫힘 청크 7개/);
    expect(r.out).toMatch(/src\/stores\/settings\.ts → assets\/shared-HHH\.js/);
    expect(r.out).toMatch(/동적 import\(따라가지 않음\) 3개/);
    expect(r.out).toMatch(/assets\/Editor-III\.js {2}src\/components\/EditorPanel\.tsx/);
    expect(r.out).toMatch(new RegExp(`${LOCALE_KO_MODULE.replace(/[./]/g, "\\$&")}: assets/locale-ko-EEE\\.js`));
  });
});

describe("bundleGraph 플러그인", () => {
  const root = process.platform === "win32" ? "C:\\work\\brise" : "/work/brise";
  const abs = (p) => (process.platform === "win32" ? `C:/work/brise/${p}` : `/work/brise/${p}`);

  it("모듈 id 를 저장소 상대 `/` 경로로 — 가상 표시·query 는 남긴다", () => {
    expect(relModuleId(abs("src/main.tsx"), root)).toBe("src/main.tsx");
    expect(relModuleId(`\0${abs("node_modules/react/index.js")}?commonjs-module`, root)).toBe(
      "\0node_modules/react/index.js?commonjs-module",
    );
    expect(relModuleId("\0vite/preload-helper.js", root)).toBe("\0vite/preload-helper.js");
    expect(relModuleId(`${abs("specs/a.md")}?raw`, root)).toBe("specs/a.md?raw");
    expect(relModuleId(null, root)).toBe(null);
    if (process.platform === "win32") expect(relModuleId("c:\\work\\brise\\src\\App.tsx", root)).toBe("src/App.tsx");
  });

  it("buildGraph — 바이트는 UTF-8 길이, 정렬, .map 제외, CSS 는 viteMetadata.importedCss", () => {
    const bundle = {
      "assets/b.js": {
        type: "chunk",
        fileName: "assets/b.js",
        name: "b",
        isEntry: false,
        isDynamicEntry: true,
        facadeModuleId: abs("src/b.ts"),
        moduleIds: [abs("src/b.ts")],
        imports: [],
        dynamicImports: [],
        viteMetadata: { importedCss: new Set(["assets/z.css", "assets/a.css"]) },
        code: "가나", // 6 B
      },
      "assets/a.js": {
        type: "chunk",
        fileName: "assets/a.js",
        name: "a",
        isEntry: true,
        isDynamicEntry: false,
        facadeModuleId: abs("index.html"),
        moduleIds: [abs("src/main.tsx"), abs("index.html")],
        imports: [],
        dynamicImports: ["assets/b.js"],
        code: "x",
      },
      "assets/a.css": { type: "asset", fileName: "assets/a.css", source: "body{}" },
      "assets/a.js.map": { type: "asset", fileName: "assets/a.js.map", source: "{}" },
      "assets/f.woff2": { type: "asset", fileName: "assets/f.woff2", source: new Uint8Array([1, 2, 3]) },
    };
    const before = JSON.stringify(bundle, (_, v) => (v instanceof Set ? [...v] : v));
    const g = buildGraph(bundle, { root, outDir: abs("dist"), toolchain: { node: "v0" } });
    expect(JSON.stringify(bundle, (_, v) => (v instanceof Set ? [...v] : v))).toBe(before); // 번들을 고치지 않는다
    expect(g.outDir).toBe("dist");
    expect(g.chunks.map((c) => c.fileName)).toEqual(["assets/a.js", "assets/b.js"]);
    expect(g.chunks[0]).toMatchObject({ facadeModuleId: "index.html", moduleIds: ["index.html", "src/main.tsx"], css: [], bytes: 1 });
    expect(g.chunks[1]).toMatchObject({ bytes: 6, css: ["assets/a.css", "assets/z.css"] });
    expect(g.assets.map((a) => [a.fileName, a.bytes])).toEqual([
      ["assets/a.css", 6],
      ["assets/f.woff2", 3],
    ]);
    expect(typeof g.assets[0].gzipBytes).toBe("number");
    expect(g.assets[1].gzipBytes).toBeUndefined();
    // 같은 입력 → 같은 바이트
    expect(JSON.stringify(buildGraph(bundle, { root, outDir: abs("dist"), toolchain: { node: "v0" } }))).toBe(JSON.stringify(g));
  });

  it("플러그인 훅 — build 에만, dist 밖 경로에 쓰고 번들은 그대로 둔다", () => {
    const p = bundleGraph({ path: join(tmp, "g.json") });
    expect(p.apply).toBe("build");
    const logs = [];
    p.configResolved({ root, build: { outDir: "dist", ssr: false, lib: false }, logger: { info: (m) => logs.push(m) } });
    const bundle = {
      "assets/a.js": { type: "chunk", fileName: "assets/a.js", name: "a", facadeModuleId: null, moduleIds: [], imports: [], dynamicImports: [], code: "abc" },
    };
    p.generateBundle.handler.call({ meta: { rollupVersion: "4.0.0" } }, {}, bundle);
    expect(Object.keys(bundle)).toEqual(["assets/a.js"]);
    const g = JSON.parse(readFileSync(join(tmp, "g.json"), "utf8"));
    expect(g.chunks).toHaveLength(1);
    expect(g.toolchain.rollup).toBe("4.0.0");
    expect(logs.join("")).toMatch(/1 chunks/);
  });

  it("그래프 경로 — BRISE_BUNDLE_GRAPH(상대면 root 기준) 또는 .eval/bundle/graph.json", () => {
    expect(graphPath(REPO_ROOT, {})).toBe(resolve(REPO_ROOT, DEFAULT_GRAPH_PATH));
    expect(graphPath(REPO_ROOT, { BRISE_BUNDLE_GRAPH: ".eval/x.json" })).toBe(resolve(REPO_ROOT, ".eval/x.json"));
  });
});

describe("저장소 기준선(baselines/bundle.json)", () => {
  // 빌드 없이도 잡는 것: 부팅 루트 파일 이름을 바꾸고 roots 를 안 고친 경우(check-bundle 이면 종료 2 로 드러날 일).
  const b = loadBaseline(DEFAULT_BASELINE);

  it("kind bundle · SET_METRICS 의 집합이 roots 에 다 있고, 모든 루트 파일이 실제로 있다", () => {
    expect(b.kind).toBe("bundle");
    for (const set of Object.keys(SET_METRICS)) {
      expect(Array.isArray(b.roots[set]) && b.roots[set].length > 0).toBe(true);
      for (const r of b.roots[set]) expect(existsSync(join(REPO_ROOT, r)), `${set}: ${r}`).toBe(true);
    }
    expect(existsSync(join(REPO_ROOT, LOCALE_KO_MODULE))).toBe(true);
  });

  it("레지스트리의 bundle 지표가 전부 기록돼 있다", () => {
    const bundleIds = Object.keys(METRICS).filter((id) => METRICS[id].group === "bundle");
    expect(Object.keys(b.metrics).sort()).toEqual(bundleIds.sort());
  });
});
