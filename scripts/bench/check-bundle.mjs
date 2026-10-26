#!/usr/bin/env node
/**
 * 부팅 번들 크기 래칫 — docs/PLAN-2026-10-23-perf-baselines.md §3 (1단계, 결정적, CI).
 *
 *   npm run build && npm run check:bundle
 *   npm run check:bundle -- --explain
 *   npm run check:bundle -- --update --reason "에디터 툴바를 부팅으로 올림(의도)"
 *
 * 빌드 때 scripts/bench/bundleGraph.vite.mjs 가 남긴 청크 그래프(.eval/bundle/graph.json, BRISE_BUNDLE_GRAPH 로 덮음)를
 * 읽어, scripts/bench/baselines/bundle.json 의 `roots`(소스 모듈 경로 — 청크 이름·해시는 빌드마다 바뀐다)마다
 * **루트 모듈이 든 청크 → 정적 `imports` 만** 따라간 닫힘의 크기를 잰다. `dynamicImports` 는 따라가지 않되
 * `--explain` 이 루트에서 닿는 동적 import 목록을 찍어 부팅 경로가 바뀐 걸 사람이 보게 한다.
 * 개별 청크가 아니라 **집합**을 래칫한다 — 청크 분할은 정상적으로 바뀐다.
 *
 * 크기는 원본 바이트(KB = 1024 B). gzip 은 파일마다 따로 압축한 크기의 합(폰 전송 참고용, 정보 지표).
 * 지표 정의·허용 오차는 metrics.mjs(SSOT), 판정은 compare.mjs(§2.2), 기준선 갱신은 baseline.mjs 그대로 쓴다.
 *
 * 종료 코드(§2.2):
 *   0  통과(REGRESSED 없음 — IMPROVED·NEW·INFO 포함, gate:false 지표의 REGRESSED 도 0)
 *   1  gate 지표 REGRESSED(--update 로 방금 받아들인 지표는 제외)
 *   2  설정 오류 — 그래프 없음·형식 오류 · 그래프와 outDir 의 파일 크기가 어긋남(오래된 그래프) · 기준선 없음/손상 ·
 *      roots 의 모듈이 그래프에 없음(조용히 0 KB 를 내지 않는다) · 잘못된 인자 · --update 에 --reason 없음 · --help
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRun, exitCode } from "./compare.mjs";
import { applyUpdate, loadBaseline, planUpdate, writeBaseline } from "./baseline.mjs";
import { METRICS } from "./metrics.mjs";
import { GRAPH_ENV, GRAPH_SCHEMA, graphPath } from "./bundleGraph.vite.mjs";
import { gitInfo } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_BASELINE = join(HERE, "baselines", "bundle.json");

/** roots 집합 이름 → 그 집합이 내는 지표 id(metrics.mjs §3.1). 새 집합은 계획 표·metrics.mjs·여기 셋을 같이 고친다. */
export const SET_METRICS = Object.freeze({
  boot_main: { js: "bundle.boot_main_js_kb", css: "bundle.boot_main_css_kb" },
  boot_mobile: { js: "bundle.boot_mobile_js_kb", gzip: "bundle.boot_mobile_js_gzip_kb" },
  boot_settings_window: { js: "bundle.boot_settings_window_js_kb" },
});
export const LOCALE_KO_MODULE = "src/i18n/locale-ko.ts";

export const USAGE = `사용법: node scripts/bench/check-bundle.mjs [옵션]     (npm run check:bundle -- <옵션>)
  먼저 빌드: npm run build  (또는 npx vite build --outDir <폴더> — 그래프는 ${GRAPH_ENV} 또는 .eval/bundle/graph.json)

  --explain             집합별 청크 목록·크기, CSS, 루트에서 닿는 동적 import 목록을 찍는다
  --graph <path>        청크 그래프 경로(기본 ${GRAPH_ENV} 또는 .eval/bundle/graph.json)
  --baseline <path>     기준선 경로(기본 scripts/bench/baselines/bundle.json — roots 도 여기서 읽는다)
  --update[=m1,m2]      이번 값으로 기준선을 고친다(목록이 있으면 그 지표·영역 접두만). --reason 필수
  --reason "<이유>"     --update 의 이유(updated.reason · 커밋 메시지)
  --help                이 도움말

종료 코드: 0 통과 · 1 gate 지표 REGRESSED · 2 설정 오류(이 도움말 포함)`;

/** 설정 오류 — 종료 코드 2. */
export class SetupError extends Error {}

/**
 * @param {string[]} argv
 * @returns {{args: {graph:string|null, baseline:string|null, update:false|true|string[], reason:string|null, explain:boolean, help:boolean}, errors:string[]}}
 */
export function parseArgs(argv) {
  const args = { graph: null, baseline: null, update: false, reason: null, explain: false, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "-h" || tok === "--help") {
      args.help = true;
      continue;
    }
    if (!tok.startsWith("--")) {
      errors.push(`알 수 없는 인자: ${tok}`);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
    let value = eq >= 0 ? tok.slice(eq + 1) : null;
    if (name === "update") {
      if (value === null) args.update = true;
      else {
        const list = value.split(",").map((x) => x.trim()).filter(Boolean);
        if (list.length === 0) errors.push("--update= 뒤에 지표 목록이 비었다");
        else args.update = list;
      }
    } else if (name === "explain") {
      if (value !== null) errors.push("--explain 은 값을 받지 않는다");
      args.explain = true;
    } else if (name === "graph" || name === "baseline" || name === "reason") {
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          errors.push(`--${name} 에 값이 필요하다`);
          continue;
        }
        value = next;
        i++;
      }
      args[name] = value;
    } else {
      errors.push(`알 수 없는 플래그 --${name}`);
    }
  }
  return { args, errors };
}

/** 그래프 형식 확인. 틀리면 SetupError. */
export function validateGraph(graph, where = "graph") {
  if (!graph || typeof graph !== "object" || graph.schema !== GRAPH_SCHEMA) {
    throw new SetupError(`${where}: schema 가 ${GRAPH_SCHEMA} 가 아니다 (${JSON.stringify(graph?.schema)}) — 다시 빌드`);
  }
  if (!Array.isArray(graph.chunks) || graph.chunks.length === 0) {
    throw new SetupError(`${where}: chunks 가 비었다 — 빌드가 끝까지 갔는지 확인`);
  }
  if (!Array.isArray(graph.assets)) throw new SetupError(`${where}: assets 배열이 없다`);
  for (const c of graph.chunks) {
    if (
      typeof c?.fileName !== "string" ||
      !Array.isArray(c.moduleIds) ||
      !Array.isArray(c.imports) ||
      !Array.isArray(c.dynamicImports) ||
      !Array.isArray(c.css) ||
      !Number.isInteger(c.bytes)
    ) {
      throw new SetupError(`${where}: 청크 항목 형식이 틀렸다 — ${JSON.stringify(c)?.slice(0, 200)}`);
    }
  }
  return graph;
}

function moduleIndex(graph) {
  /** @type {Map<string, string[]>} */
  const idx = new Map();
  for (const c of graph.chunks) {
    for (const m of c.moduleIds) {
      const list = idx.get(m);
      if (list) list.push(c.fileName);
      else idx.set(m, [c.fileName]);
    }
  }
  return idx;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const byBytesDesc = (a, b) => b.bytes - a.bytes || (a.fileName < b.fileName ? -1 : 1);

/**
 * 한 루트 집합의 정적 닫힘.
 * @param {object} graph validateGraph 를 통과한 그래프
 * @param {string[]} roots 저장소 상대 소스 모듈 경로
 * @returns {{roots:string[], missing:string[], broken:string[], rootChunks:Array<{root:string, files:string[]}>,
 *   chunks:object[], jsBytes:number, jsGzipBytes:number, css:Array<{fileName:string, bytes:number}>, cssBytes:number,
 *   dynamicImports:Array<{fileName:string, facadeModuleId:string|null, bytes:number}>}}
 *   missing = 그래프 어느 청크에도 없는 루트, broken = 그래프에 없는 청크·CSS 를 가리키는 참조(그래프 손상)
 */
export function measureSet(graph, roots, idx = moduleIndex(graph)) {
  const byFile = new Map(graph.chunks.map((c) => [c.fileName, c]));
  const assets = new Map(graph.assets.map((a) => [a.fileName, a]));
  const missing = [];
  const broken = [];
  const rootChunks = [];
  for (const r of roots) {
    const files = idx.get(r);
    if (!files || files.length === 0) missing.push(r);
    else rootChunks.push({ root: r, files: [...files] });
  }
  const seen = new Set();
  const queue = rootChunks.flatMap((x) => x.files);
  while (queue.length > 0) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    const c = byFile.get(f);
    if (!c) {
      if (!broken.includes(f)) broken.push(f);
      continue;
    }
    seen.add(f);
    for (const i of c.imports) if (!seen.has(i)) queue.push(i);
  }
  const chunks = [...seen].map((f) => byFile.get(f)).sort(byBytesDesc);
  const cssNames = [...new Set(chunks.flatMap((c) => c.css))].sort();
  const css = [];
  for (const n of cssNames) {
    const a = assets.get(n);
    if (!a) broken.push(n);
    else css.push({ fileName: n, bytes: a.bytes });
  }
  const dyn = new Set();
  for (const c of chunks) for (const d of c.dynamicImports) if (!seen.has(d)) dyn.add(d);
  const dynamicImports = [...dyn]
    .map((f) => {
      const c = byFile.get(f);
      return { fileName: f, facadeModuleId: c?.facadeModuleId ?? null, bytes: c?.bytes ?? 0 };
    })
    .sort(byBytesDesc);
  return {
    roots: [...roots],
    missing,
    broken,
    rootChunks,
    chunks,
    jsBytes: sum(chunks.map((c) => c.bytes)),
    jsGzipBytes: sum(chunks.map((c) => c.gzipBytes ?? 0)),
    css,
    cssBytes: sum(css.map((x) => x.bytes)),
    dynamicImports,
  };
}

const kb = (bytes) => bytes / 1024;

/**
 * 그래프 + roots → §3.1 지표 전부(BENCH 결과 모양) + 설명용 집합 측정.
 * @param {object} graph
 * @param {Record<string, string[]>} roots
 * @param {object} [registry]
 * @returns {{results: Array<{metric:string, unit:string, samples:number[], workload:object}>, sets: Record<string, ReturnType<typeof measureSet>>,
 *   locale: {files:string[], bytes:number}, problems: string[], notes: string[]}}
 *   problems 가 비지 않으면 설정 오류(종료 코드 2).
 */
export function measureGraph(graph, roots, registry = METRICS) {
  const idx = moduleIndex(graph);
  const results = [];
  const problems = [];
  const notes = [];
  const sets = {};
  const unitOf = (id) => registry[id]?.unit ?? "KB";
  const push = (id, value) => results.push({ metric: id, unit: unitOf(id), samples: [value], workload: {} });

  for (const [set, ids] of Object.entries(SET_METRICS)) {
    const list = roots?.[set];
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`기준선 roots.${set} 가 없다 — ${Object.values(ids).join(", ")} 를 잴 수 없다`);
      continue;
    }
    const m = measureSet(graph, list, idx);
    sets[set] = m;
    for (const r of m.missing) problems.push(`roots.${set}: '${r}' 가 그래프의 어느 청크에도 없다${suggest(r, idx)}`);
    for (const b of m.broken) problems.push(`roots.${set}: 그래프에 없는 파일을 가리킨다 — ${b} (그래프 손상, 다시 빌드)`);
    if (m.missing.length > 0 || m.broken.length > 0) continue;
    if (ids.js) push(ids.js, kb(m.jsBytes));
    if (ids.css) push(ids.css, kb(m.cssBytes));
    if (ids.gzip) push(ids.gzip, kb(m.jsGzipBytes));
  }
  for (const [set, list] of Object.entries(roots ?? {})) {
    if (SET_METRICS[set]) continue;
    if (!Array.isArray(list)) continue;
    sets[set] = measureSet(graph, list, idx);
    notes.push(`roots.${set} 는 지표가 없는 집합 — --explain 에만 나온다(지표로 만들려면 계획 §3.1 표·metrics.mjs·SET_METRICS)`);
  }

  const localeFiles = idx.get(LOCALE_KO_MODULE) ?? [];
  const byFile = new Map(graph.chunks.map((c) => [c.fileName, c]));
  const locale = { files: [...localeFiles], bytes: sum(localeFiles.map((f) => byFile.get(f)?.bytes ?? 0)) };
  if (localeFiles.length === 0) problems.push(`'${LOCALE_KO_MODULE}' 가 그래프에 없다 — bundle.locale_ko_kb 를 잴 수 없다${suggest(LOCALE_KO_MODULE, idx)}`);
  else push("bundle.locale_ko_kb", kb(locale.bytes));

  push("bundle.total_js_kb", kb(sum(graph.chunks.map((c) => c.bytes))));
  push("bundle.chunk_count", graph.chunks.length);
  return { results, sets, locale, problems, notes };
}

/** 없는 루트와 파일 이름이 같은 모듈을 찾아 안내(이름을 옮겼을 때). */
function suggest(root, idx) {
  const base = root.split("/").pop()?.replace(/\.[^.]+$/, "");
  if (!base) return "";
  const hits = [...idx.keys()].filter((m) => !m.startsWith("\0") && m.split("/").pop()?.replace(/\.[^.]+$/, "") === base);
  return hits.length > 0 ? ` (같은 이름의 모듈: ${hits.slice(0, 3).join(", ")})` : " — src/main.tsx 의 부팅 분기를 바꿨다면 roots 를 같은 커밋에서 고친다";
}

/**
 * 그래프의 바이트가 outDir 의 실제 파일과 같은지(오래된 그래프·플러그인 버그 방지). outDir 이 없으면 생략.
 * @returns {{checked:boolean, outDir:string|null, mismatches:string[]}}
 */
export function verifyAgainstOutDir(graph, repoRoot) {
  if (!graph.outDir) return { checked: false, outDir: null, mismatches: [] };
  const dir = resolve(repoRoot, graph.outDir);
  if (!existsSync(dir)) return { checked: false, outDir: dir, mismatches: [] };
  const mismatches = [];
  for (const item of [...graph.chunks, ...graph.assets]) {
    const p = join(dir, item.fileName);
    if (!existsSync(p)) mismatches.push(`${item.fileName}: 파일 없음`);
    else {
      const size = statSync(p).size;
      if (size !== item.bytes) mismatches.push(`${item.fileName}: 그래프 ${item.bytes} B ≠ 파일 ${size} B`);
    }
  }
  return { checked: true, outDir: dir, mismatches };
}

// ── 출력 ─────────────────────────────────────────────────────────────────────────────────────────

function fmtNum(v, unit) {
  if (v === null || v === undefined) return "—";
  if (!Number.isFinite(v)) return String(v);
  return unit === "count" ? String(Math.round(v * 1000) / 1000) : v.toFixed(2);
}

function fmtDelta(v, unit) {
  if (v === null || v === undefined) return "—";
  return (v > 0 ? "+" : "") + fmtNum(v, unit);
}

const HEAD = ["지표", "값", "바이트", "기준", "Δ", "허용폭", "판정", "gate"];

export function formatTable(rows) {
  const body = rows.map((r) => [
    r.metric,
    `${fmtNum(r.value, r.unit)} ${r.unit}`,
    r.unit === "KB" ? String(Math.round(r.value * 1024)) : "—",
    fmtNum(r.base, r.unit),
    fmtDelta(r.delta, r.unit),
    fmtNum(r.allowance, r.unit),
    r.verdict,
    r.gate ? "gate" : "info",
  ]);
  const widths = HEAD.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(HEAD), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

const kbStr = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
const label = (c) => c.facadeModuleId ?? `(${c.name ?? "공유 청크"})`;

/** --explain 본문. */
export function formatExplain(measured, graph) {
  const out = [];
  for (const [set, m] of Object.entries(measured.sets)) {
    out.push(`── ${set} — 루트 ${m.roots.length}개 → 정적 닫힘 청크 ${m.chunks.length}개`);
    out.push("  루트 → 청크");
    for (const r of m.roots) {
      const rc = m.rootChunks.find((x) => x.root === r);
      out.push(`    ${r} → ${rc ? rc.files.join(", ") : "(그래프에 없음)"}`);
    }
    out.push(`  JS ${kbStr(m.jsBytes)} (${m.jsBytes} B) · gzip ${kbStr(m.jsGzipBytes)}`);
    for (const c of m.chunks) out.push(`    ${kbStr(c.bytes).padStart(12)}  ${c.fileName}  ${label(c)}`);
    out.push(`  CSS ${kbStr(m.cssBytes)} (${m.cssBytes} B)`);
    for (const c of m.css) out.push(`    ${kbStr(c.bytes).padStart(12)}  ${c.fileName}`);
    out.push(`  루트에서 닿는 동적 import(따라가지 않음) ${m.dynamicImports.length}개`);
    for (const d of m.dynamicImports) out.push(`    ${kbStr(d.bytes).padStart(12)}  ${d.fileName}  ${d.facadeModuleId ?? ""}`);
    out.push("");
  }
  out.push(`── ${LOCALE_KO_MODULE}: ${measured.locale.files.join(", ") || "(없음)"} — ${kbStr(measured.locale.bytes)}`);
  const total = sum(graph.chunks.map((c) => c.bytes));
  out.push(`── 전체 JS 청크 ${graph.chunks.length}개 — ${kbStr(total)} (${total} B)`);
  const jsAssets = graph.assets.filter((a) => a.fileName.endsWith(".js"));
  if (jsAssets.length > 0) {
    out.push(`   (청크가 아닌 JS 자산 — total_js_kb 에 안 든다: ${jsAssets.map((a) => `${a.fileName} ${kbStr(a.bytes)}`).join(", ")})`);
  }
  return out.join("\n");
}

function toolchainLine(tc) {
  return Object.entries(tc ?? {})
    .map(([k, v]) => `${k} ${v ?? "?"}`)
    .join(" · ");
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function runEnvLabel(env) {
  return env.CI && process.platform === "linux" ? "ci-linux" : `local-${process.platform}`;
}

/**
 * 본체. 테스트가 경로·출력을 바꿔 끼운다.
 * @returns {Promise<number>} 종료 코드 0/1/2
 */
export async function main({
  argv = [],
  repoRoot = REPO_ROOT,
  cwd = process.cwd(),
  env = process.env,
  registry = METRICS,
  gitFn = gitInfo,
  now = () => new Date(),
  log = (m) => console.log(m),
  error = (m) => console.error(m),
} = {}) {
  const { args, errors } = parseArgs(argv);
  if (errors.length > 0) {
    for (const e of errors) error(`오류: ${e}`);
    error(USAGE);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 2;
  }
  if (args.update && !(args.reason && args.reason.trim())) {
    error('오류: --update 에는 --reason "<이유>" 가 필요하다 — 기준선은 이유와 함께만 움직인다(계획 §2.2).');
    return 2;
  }

  const gPath = args.graph ? resolve(cwd, args.graph) : graphPath(repoRoot, env);
  const bPath = args.baseline ? resolve(cwd, args.baseline) : DEFAULT_BASELINE;
  let graph;
  let baseline;
  let measured;
  let verify;
  try {
    if (!existsSync(gPath)) {
      throw new SetupError(
        args.graph
          ? `청크 그래프가 없다 (${gPath}) — --graph 경로를 확인하거나 ${GRAPH_ENV}=<경로> 로 빌드`
          : `청크 그래프가 없다 (${gPath}) — 먼저 npm run build (빌드가 ${relative(repoRoot, gPath).split("\\").join("/") || gPath} 를 남긴다)`,
      );
    }
    try {
      graph = JSON.parse(readFileSync(gPath, "utf8"));
    } catch (e) {
      throw new SetupError(`청크 그래프를 읽지 못했다 (${gPath}): ${/** @type {Error} */ (e).message}`);
    }
    validateGraph(graph, gPath);
    try {
      baseline = loadBaseline(bPath);
    } catch (e) {
      throw new SetupError(/** @type {Error} */ (e).message);
    }
    if (!baseline) throw new SetupError(`기준선 파일이 없다 (${bPath}) — roots 를 거기서 읽는다(계획 §2.5)`);
    if (baseline.kind !== "bundle") throw new SetupError(`${bPath} 는 kind '${baseline.kind}' — check-bundle 은 kind 'bundle' 기준선만 쓴다`);
    if (!baseline.roots || typeof baseline.roots !== "object") throw new SetupError(`${bPath} 에 roots 가 없다(계획 §2.5)`);
    verify = verifyAgainstOutDir(graph, repoRoot);
    if (verify.mismatches.length > 0) {
      throw new SetupError(
        `그래프와 빌드 출력(${verify.outDir})이 다르다 — 오래된 그래프이거나 플러그인이 최종 바이트를 못 봤다. 다시 빌드.\n  ` +
          verify.mismatches.slice(0, 10).join("\n  ") +
          (verify.mismatches.length > 10 ? `\n  … 외 ${verify.mismatches.length - 10}건` : ""),
      );
    }
    measured = measureGraph(graph, baseline.roots, registry);
    if (args.explain) {
      log(formatExplain(measured, graph));
      log("");
    }
    if (measured.problems.length > 0) {
      throw new SetupError(`부팅 집합을 잴 수 없다:\n  ${measured.problems.join("\n  ")}`);
    }
  } catch (e) {
    if (e instanceof SetupError) {
      error(`오류: ${e.message}`);
      return 2;
    }
    throw e;
  }

  let rows;
  try {
    rows = compareRun({ baseline, results: measured.results, fingerprint: {}, registry });
  } catch (e) {
    error(`오류: ${/** @type {Error} */ (e).message}`);
    return 2;
  }

  let updated = [];
  let refused = [];
  let unknownUpdate = [];
  if (args.update) {
    const only = Array.isArray(args.update) ? args.update : null;
    const plan = planUpdate(rows, { only });
    updated = plan.accept.map((r) => r.metric);
    refused = plan.refuse;
    unknownUpdate = plan.unknown;
    if (updated.length > 0) {
      const next = applyUpdate(baseline, rows, {
        only,
        reason: args.reason,
        commit: gitFn(repoRoot).commit,
        date: localDate(now()),
        toolchains: graph.toolchain ?? {},
        kind: "bundle",
      });
      writeBaseline(bPath, next);
    }
  }
  const updatedSet = new Set(updated);
  const code = exitCode(rows.filter((r) => !updatedSet.has(r.metric)));

  // 콘솔
  const runEnv = runEnvLabel(env);
  log(`청크 그래프: ${gPath} — 청크 ${graph.chunks.length}개${verify.checked ? ` · 출력 대조 OK(${verify.outDir})` : " · 출력 폴더 없음(대조 생략)"}`);
  log(`툴체인(이번 빌드): ${toolchainLine(graph.toolchain)}`);
  log(
    `기준선: ${bPath} — ${baseline.updated?.date ?? "?"} @ ${baseline.updated?.commit ?? "?"}: ${baseline.updated?.reason ?? ""}` +
      (baseline.toolchain ? `\n  기준선 툴체인: ${toolchainLine(baseline.toolchain)}` : ""),
  );
  if (baseline.authority && baseline.authority !== runEnv) {
    log(`  정본(authority) ${baseline.authority} · 이번 실행 ${runEnv} — 로컬·CI 바이트가 같은지는 계획 §3.4 대조 결과를 따른다`);
  }
  const tcDiff = Object.keys({ ...(graph.toolchain ?? {}), ...(baseline.toolchain ?? {}) }).filter(
    (k) => baseline.toolchain && k in baseline.toolchain && (graph.toolchain?.[k] ?? null) !== (baseline.toolchain[k] ?? null),
  );
  if (tcDiff.length > 0) {
    log(`  툴체인이 기준선과 다르다(기록만, 비교 키 아님 — §2.4): ${tcDiff.map((k) => `${k} ${baseline.toolchain[k]} → ${graph.toolchain?.[k] ?? "?"}`).join(", ")}`);
  }
  log("");
  log(formatTable(rows));
  const notes = [
    ...rows.filter((r) => r.reason).map((r) => `- ${r.metric}: ${r.verdict} — ${r.reason}`),
    ...measured.notes.map((n) => `- ${n}`),
  ];
  if (notes.length > 0) {
    log("");
    for (const n of notes) log(n);
  }
  const produced = new Set(rows.map((r) => r.metric));
  const missing = Object.keys(baseline.metrics ?? {}).filter((id) => !produced.has(id));
  if (missing.length > 0) log(`\n경고: 기준선에 있는데 이번에 안 나온 지표 — ${missing.join(", ")}`);
  if (args.update) {
    log("");
    if (updated.length > 0) log(`기준선 갱신(${updated.length}): ${updated.join(", ")} → ${bPath}`);
    else log("기준선 갱신: 받아들인 지표 없음 — 파일을 바꾸지 않았다.");
    for (const r of refused) log(`  거부 ${r.metric}: ${r.why}`);
    for (const u of unknownUpdate) log(`  경고: --update 목록의 '${u}' 에 걸린 지표가 없다(오타?)`);
  }
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  log("");
  log(`판정: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")} — 종료 코드 ${code}`);
  if (code === 1) {
    log(
      "REGRESSED: --explain 으로 어느 청크가 부팅 집합에 들어왔는지 본다. 의도한 비용이면 " +
        'npm run check:bundle -- --update --reason "…" 로 기준선을 옮기고 그 이유를 커밋 메시지에 적는다(계획 §6).',
    );
  }
  return code;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (invokedDirectly()) {
  main({ argv: process.argv.slice(2) }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e);
      process.exitCode = 2;
    },
  );
}
