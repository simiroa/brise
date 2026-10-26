#!/usr/bin/env node
/**
 * 성능 벤치 러너 — docs/PLAN-2026-10-23-perf-baselines.md §4.3(2단계 rust) · §5(3단계 app).
 *
 *   node scripts/bench/run.mjs --suite rust|app [--only <접두>,…] [--update[=m1,m2]] [--reason "…"] [--record]
 *        [--force] [--baseline <path>] [--real-data] [--scale] [--exe <path>] [--boots N] [--samples N] [--no-build]
 *   npm run bench -- --force          (= --suite rust)
 *   npm run bench:app -- --boots 8    (= --suite app)
 *
 * ── suite 모듈 계약(scripts/bench/suites/<suite>.mjs) ──────────────────────────────────────────────
 *   export default {
 *     name: "rust",                                  // 보고서 표기. 레지스트리 group 과 같게 두면 '빠진 지표' 경고가 켜진다
 *     fingerprint: { rust: true } | { webview2: true }, // 이 suite 의 지표가 비교에 쓰는 툴체인 지문
 *     async preflight(ctx) { … },                   // 환경 확인·빌드. throw → 종료 코드 2(설정 오류)
 *     async run(ctx) { return [ {metric, unit, samples:number[], workload:{…}}, … ] },  // throw → 종료 코드 2
 *   }
 *   run() 은 BENCH 결과 배열을 돌려준다. 측정기 stdout 에서 뽑을 때는 benchJson.mjs 의 parseBenchLines 를 쓴다.
 *   러너가 --only 로 걸러 내므로 suite 가 건너뛰는 건 선택(비싼 측정을 피하고 싶을 때 ctx.args.only 를 본다).
 *
 * ctx = {
 *   args: {                         // 파싱된 플래그(아래 외 플래그는 args.extra 에 경고와 함께 들어간다)
 *     suite: string, only: string[]|null, update: false|true|string[], reason: string|null,
 *     record: boolean, force: boolean, baseline: string|null, realData: boolean, scale: boolean,
 *     exe: string|null, boots: number|null, samples: number|null, noBuild: boolean, extra: object,
 *   },
 *   repoRoot: string,               // 저장소 루트(절대 경로)
 *   outDir: string,                 // 이번 실행의 보고서 폴더(.eval/bench/<시각>-<suite>/) — 측정 로그를 남겨도 된다
 *   log(msg): void,                 // 러너 콘솔로
 *   env: object,                    // process.env 사본, PATH 앞에 ~/.cargo/bin (자식 프로세스에 그대로 넘기면 된다)
 *   setToolchain(key, value): void, // 실행 중에 알게 된 지문(예: setToolchain("webview2", "130.0.2849.80"))
 * }
 *
 * ── 판정(compare.mjs) ───────────────────────────────────────────────────────────────────────────
 *   PASS · REGRESSED · IMPROVED · NOISY(시간 지표의 IQR/중앙값 > 0.25, REGRESSED 보다 우선)
 *   NEW(기준선에 없음) · UNCOMPARABLE(지문·workload·단위 불일치) · INFO(허용 오차 없는 정보 지표)
 *
 * ── 종료 코드(§2.2) ─────────────────────────────────────────────────────────────────────────────
 *   0  통과(REGRESSED 없음, 또는 gate:false 지표만 REGRESSED)
 *   1  gate 지표가 REGRESSED (--update 로 방금 받아들인 지표는 제외)
 *   2  설정 오류 — --help/잘못된 인자/없는 suite/CPU 바쁨(기본 40% 초과, --force 면 경고만)/preflight·run 실패/
 *      측정기 버그(같은 지표 두 번·단위 불일치)/기준선 파일 손상
 *
 * ── 파일 ───────────────────────────────────────────────────────────────────────────────────────
 *   기준선  scripts/bench/baselines/<machineId>.json (--baseline 으로 덮음). --update 는 --reason 필수.
 *   보고서  .eval/bench/<시각>-<suite>/report.md + run.json (gitignore)
 *   이력    --record → scripts/bench/history/<machineId>.jsonl 에 한 줄(릴리스 때 커밋)
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { normalizeBenchResult } from "./benchJson.mjs";
import { compareRun, exitCode, matchesAny } from "./compare.mjs";
import { collectFingerprint, machineId, envWithCargo } from "./fingerprint.mjs";
import { loadBaseline, planUpdate, applyUpdate, writeBaseline, historyEntry } from "./baseline.mjs";
import { METRICS } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// 40% — 이 PC 는 측정과 무관한 상주 프로세스(IDE·다른 세션·MCP 서버)만으로 22~34% 를 오르내린다. 15% 로는 조용한 기준선을
// 한 번도 잴 수 없었고(2026-10-23 2단계 검증), 30% 로는 6회 중 4회가 거부됐다(첫 기준선 기록). cargo·vitest 빌드가 겹치면
// 50% 를 넘으므로 40% 로도 그건 막는다. 기계마다 다르면 --cpu-limit <퍼센트> 로 바꾼다.
export const CPU_BUSY_LIMIT = 0.4;
export const CPU_SAMPLE_MS = 2000;
/** preflight(빌드 등)가 이보다 오래 걸리면 측정 직전에 CPU 를 한 번 더 본다. */
const RECHECK_AFTER_MS = 30_000;

export const USAGE = `사용법: node scripts/bench/run.mjs --suite <rust|app> [옵션]
  (npm run bench -- <옵션>  =  --suite rust,   npm run bench:app -- <옵션>  =  --suite app)

  --suite <이름>        scripts/bench/suites/<이름>.mjs 를 돌린다
  --only a,b            지표 id 또는 영역 접두로 거른다(예: --only search,export)
  --update[=m1,m2]      이번 결과로 기준선을 고친다(목록이 있으면 그 지표만). --reason 필수
                        NOISY 는 거부. 지문이 바뀐 지표(UNCOMPARABLE)는 --update=<id> 로 이름을 적어야 받는다
  --reason "<이유>"     --update 의 이유(기준선 파일 updated.reason 과 커밋 메시지에 쓴다)
  --record              scripts/bench/history/<machine-id>.jsonl 에 이번 실행을 한 줄 남긴다(릴리스 전)
  --force               CPU 바쁨(2초 표본이 한도 초과) 거부를 경고로 낮춘다 — 수치는 참고만
  --cpu-limit <퍼센트>  CPU 바쁨 한도(기본 40)
  --baseline <path>     기준선 파일 경로를 덮는다(기본 scripts/bench/baselines/<machine-id>.json)
  --real-data --scale --exe <path> --boots N --samples N --no-build
                        suite 가 해석하는 옵션(app: 실데이터 사본·10만 노트·exe 경로·부팅 횟수·표본 수·빌드 생략)
  --help                이 도움말

종료 코드: 0 통과 · 1 gate 지표 REGRESSED · 2 설정 오류(이 도움말 포함)`;

const VALUE_FLAGS = new Set(["suite", "only", "reason", "baseline", "exe", "boots", "samples", "cpu-limit"]);
const BOOL_FLAGS = new Set(["record", "force", "real-data", "scale", "no-build", "help"]);

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function splitList(v) {
  const items = String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/**
 * @param {string[]} argv
 * @returns {{args: object, errors: string[], warnings: string[]}}
 */
export function parseArgs(argv) {
  const args = {
    suite: null,
    only: null,
    update: false,
    reason: null,
    record: false,
    force: false,
    baseline: null,
    realData: false,
    scale: false,
    exe: null,
    boots: null,
    samples: null,
    noBuild: false,
    cpuLimit: null,
    help: false,
    extra: {},
  };
  const errors = [];
  const warnings = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "-h") {
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
        const list = splitList(value);
        if (!list) errors.push("--update= 뒤에 지표 목록이 비었다");
        else args.update = list;
      }
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          errors.push(`--${name} 에 값이 필요하다`);
          continue;
        }
        value = next;
        i++;
      }
      if (name === "only") {
        args.only = splitList(value);
        if (!args.only) errors.push("--only 목록이 비었다");
      } else if (name === "cpu-limit") {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0 || n > 100) errors.push(`--cpu-limit 는 0 초과 100 이하의 퍼센트: ${value}`);
        else args.cpuLimit = n / 100;
      } else if (name === "boots" || name === "samples") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) errors.push(`--${name} 는 1 이상의 정수: ${value}`);
        else args[name] = n;
      } else {
        args[name] = value;
      }
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      if (value !== null) errors.push(`--${name} 는 값을 받지 않는다`);
      else args[camel(name)] = true;
      continue;
    }
    warnings.push(`알 수 없는 플래그 --${name} — suite 에 args.extra 로만 넘긴다(오타가 아닌지 확인)`);
    args.extra[camel(name)] = value === null ? true : value;
  }
  return { args, errors, warnings };
}

/** 2초 동안 전체 CPU 사용률(0~1). */
export async function sampleCpuBusy(ms = CPU_SAMPLE_MS) {
  const total = (cpus) => cpus.map((c) => Object.values(c.times).reduce((a, b) => a + b, 0));
  const a = os.cpus();
  await new Promise((r) => setTimeout(r, ms));
  const b = os.cpus();
  const ta = total(a);
  const tb = total(b);
  let busy = 0;
  let all = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const dt = tb[i] - ta[i];
    all += dt;
    busy += dt - (b[i].times.idle - a[i].times.idle);
  }
  return all > 0 ? busy / all : 0;
}

/** 읽기 전용 git 조회. 실패하면 null. */
export function gitInfo(repoRoot) {
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let commit = null;
  let dirty = null;
  try {
    commit = git(["rev-parse", "--short=8", "HEAD"]);
  } catch {
    // silent-ok: git 이 없거나 저장소 밖 — 보고서에 commit null 로 남는다
  }
  try {
    // 이 체크아웃엔 추적 안 하는 산출물(output/ 등)이 늘 있어 --untracked-files=no 로 본다
    dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
  } catch {
    // silent-ok: 위와 같음 — dirty null
  }
  return { commit, dirty };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** `2026-10-23T01:23:45+09:00` (로컬 시각 + 오프셋) */
export function isoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
  );
}

function localDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function stamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function fmt(v) {
  if (v === null || v === undefined) return "—";
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function fmtDelta(v) {
  if (v === null || v === undefined) return "—";
  return (v > 0 ? "+" : "") + fmt(v);
}

function tableRows(rows) {
  return rows.map((r) => [
    r.metric,
    `${fmt(r.value)} ${r.unit}`,
    fmt(r.iqr),
    String(r.n),
    fmt(r.base),
    fmtDelta(r.delta),
    fmt(r.allowance),
    r.verdict,
    r.gate ? "gate" : "info",
  ]);
}

const HEAD = ["지표", "값", "IQR", "n", "기준", "Δ", "허용폭", "판정", "gate"];

function consoleTable(rows) {
  const body = tableRows(rows);
  const widths = HEAD.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(HEAD), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

function markdownTable(rows) {
  const body = tableRows(rows);
  return [
    `| ${HEAD.join(" | ")} |`,
    `|${HEAD.map(() => "---").join("|")}|`,
    ...body.map((b) => `| ${b.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`),
  ].join("\n");
}

function uniqueDir(root, name) {
  let p = join(root, name);
  for (let i = 2; existsSync(p); i++) p = join(root, `${name}-${i}`);
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 러너 본체. 테스트가 경로·CPU 표본·레지스트리를 바꿔 끼울 수 있다.
 * @returns {Promise<number>} 종료 코드 0/1/2
 */
export async function runBench({
  argv = [],
  repoRoot = REPO_ROOT,
  suitesDir = join(HERE, "suites"),
  baselinesDir = join(HERE, "baselines"),
  historyDir = join(HERE, "history"),
  outRoot = join(repoRoot, ".eval", "bench"),
  registry = METRICS,
  cpuBusy = sampleCpuBusy,
  fingerprintFn = collectFingerprint,
  machineIdFn = machineId,
  gitFn = gitInfo,
  now = () => new Date(),
  log = (m) => console.log(m),
  error = (m) => console.error(m),
} = {}) {
  const { args, errors, warnings } = parseArgs(argv);
  for (const w of warnings) log(`경고: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) error(`오류: ${e}`);
    error(USAGE);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 2;
  }
  if (!args.suite) {
    error("오류: --suite 가 필요하다(rust 또는 app).");
    error(USAGE);
    return 2;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(args.suite)) {
    error(`오류: suite 이름은 소문자·숫자·하이픈만: ${args.suite}`);
    return 2;
  }
  if (args.update && !(args.reason && args.reason.trim())) {
    error('오류: --update 에는 --reason "<이유>" 가 필요하다 — 기준선은 이유와 함께만 움직인다(계획 §2.2).');
    return 2;
  }

  const suitePath = join(suitesDir, `${args.suite}.mjs`);
  if (!existsSync(suitePath)) {
    const available = existsSync(suitesDir)
      ? readdirSync(suitesDir)
          .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
          .map((f) => f.slice(0, -4))
      : [];
    error(`오류: suite '${args.suite}' 가 없다 — ${suitePath}`);
    error(
      available.length > 0
        ? `  있는 suite: ${available.join(", ")}`
        : `  ${suitesDir} 에 suite 가 아직 없다(2단계 rust · 3단계 app 은 계획 §4·§5 에서 만든다).`,
    );
    return 2;
  }
  let suite;
  try {
    suite = (await import(pathToFileURL(suitePath).href)).default;
  } catch (e) {
    error(`오류: suite 모듈을 불러오지 못했다 (${suitePath}): ${/** @type {Error} */ (e).stack ?? e}`);
    return 2;
  }
  if (!suite || typeof suite.run !== "function") {
    error(`오류: ${suitePath} 의 default export 에 run(ctx) 가 없다(run.mjs 머리말의 suite 계약 참고).`);
    return 2;
  }
  const suiteName = suite.name ?? args.suite;

  const toolchainsSeen = {};
  /** @type {any} */
  const ctx = {
    args,
    repoRoot,
    outDir: null, // CPU 확인을 통과한 뒤 채운다(거부된 실행은 빈 보고서 폴더를 남기지 않게)
    log: (m) => log(`[${suiteName}] ${m}`),
    env: envWithCargo(process.env),
    setToolchain(key, value) {
      if (typeof key !== "string" || !key) throw new Error("setToolchain: key 가 필요하다");
      toolchainsSeen[key] = value == null ? undefined : String(value);
    },
  };

  const checkCpu = async (when) => {
    const busy = await cpuBusy(CPU_SAMPLE_MS);
    const pct = (busy * 100).toFixed(1);
    const limit = args.cpuLimit ?? CPU_BUSY_LIMIT;
    if (busy > limit) {
      if (args.force) {
        log(`경고: CPU ${pct}% 바쁨(${when}, 한도 ${Math.round(limit * 100)}%) — --force 로 계속. 시간 수치는 참고만.`);
        return { busy, ok: true };
      }
      error(`오류: CPU ${pct}% 바쁨(${when}, 한도 ${Math.round(limit * 100)}%) — 다른 빌드·테스트를 끝내고 다시 돌리거나 --force · --cpu-limit.`);
      return { busy, ok: false };
    }
    log(`CPU ${pct}% (${when}) — 측정 가능`);
    return { busy, ok: true };
  };

  const cpu = [];
  let c = await checkCpu("시작 전");
  cpu.push({ when: "시작 전", busy: c.busy });
  if (!c.ok) return 2;

  const startedAt = now();
  const outDir = uniqueDir(outRoot, `${stamp(startedAt)}-${args.suite}`);
  ctx.outDir = outDir;

  const preStart = Date.now();
  if (typeof suite.preflight === "function") {
    try {
      await suite.preflight(ctx);
    } catch (e) {
      error(`오류(preflight): ${/** @type {Error} */ (e).message ?? e}`);
      return 2;
    }
  }
  if (Date.now() - preStart > RECHECK_AFTER_MS) {
    c = await checkCpu("측정 직전");
    cpu.push({ when: "측정 직전", busy: c.busy });
    if (!c.ok) return 2;
  }

  let results;
  try {
    const raw = await suite.run(ctx);
    if (!Array.isArray(raw)) throw new Error("run(ctx) 가 배열을 돌려주지 않았다");
    results = raw.map((r, i) => normalizeBenchResult(r, `결과 ${i}`));
  } catch (e) {
    error(`오류(run): ${/** @type {Error} */ (e).message ?? e}`);
    return 2;
  }
  const beforeFilter = results.length;
  if (beforeFilter === 0) {
    // 측정기가 아무 줄도 안 냈다(테스트 필터 불일치·BENCH-JSON 누락) — 빈 표를 "통과"로 넘기지 않는다
    error("오류: suite 가 측정 결과를 하나도 내지 않았다 — 측정기 출력에 BENCH-JSON 줄이 있는지 확인.");
    return 2;
  }
  results = results.filter((r) => matchesAny(r.metric, args.only));
  if (args.only && results.length === 0) {
    error(`오류: --only ${args.only.join(",")} 에 걸린 지표가 없다(측정 결과 ${beforeFilter}개).`);
    return 2;
  }

  const fingerprint = {
    ...fingerprintFn({ rust: !!suite.fingerprint?.rust, webview2: toolchainsSeen.webview2 }),
  };
  for (const [k, v] of Object.entries(toolchainsSeen)) if (v !== undefined) fingerprint[k] = v;
  if (suite.fingerprint?.rust && !fingerprint.rust) log("경고: rustc 버전을 읽지 못했다 — rust 지표는 UNCOMPARABLE 로 나온다.");
  if (suite.fingerprint?.webview2 && !fingerprint.webview2) {
    log("경고: suite 가 webview2 버전을 넘기지 않았다(ctx.setToolchain) — app 지표는 UNCOMPARABLE 로 나온다.");
  }
  const toolchains = {};
  for (const k of Object.keys(fingerprint)) if (!["machine", "os", "node"].includes(k)) toolchains[k] = fingerprint[k];

  const machine = fingerprint.machine ?? machineIdFn();
  const baselinePath = args.baseline ? resolve(process.cwd(), args.baseline) : join(baselinesDir, `${machine}.json`);
  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (e) {
    error(`오류: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
  if (baseline && baseline.kind && baseline.kind !== "wall") {
    error(`오류: ${baselinePath} 는 kind '${baseline.kind}' 기준선이다 — 러너는 시간 지표(kind 'wall') 기준선만 쓴다.`);
    return 2;
  }

  let rows;
  try {
    rows = compareRun({ baseline, results, fingerprint, registry });
  } catch (e) {
    error(`오류: ${/** @type {Error} */ (e).message}`);
    return 2;
  }

  const seenIds = new Set(rows.map((r) => r.metric));
  const missing = Object.keys(baseline?.metrics ?? {}).filter(
    (id) => registry[id]?.group === suiteName && matchesAny(id, args.only) && !seenIds.has(id),
  );

  const git = gitFn(repoRoot);
  const finishedAt = now();

  // 갱신(--update)
  let updated = [];
  let refused = [];
  let unknownUpdate = [];
  if (args.update) {
    const only = Array.isArray(args.update) ? args.update : null;
    const plan = planUpdate(rows, { only });
    refused = plan.refuse;
    unknownUpdate = plan.unknown;
    updated = plan.accept.map((r) => r.metric);
    if (updated.length > 0) {
      const next = applyUpdate(baseline, rows, {
        only,
        reason: args.reason,
        commit: git.commit,
        date: localDate(finishedAt),
        fingerprint,
        toolchains,
        kind: "wall",
      });
      writeBaseline(baselinePath, next);
    }
  }
  const updatedSet = new Set(updated);
  const code = exitCode(rows.filter((r) => !updatedSet.has(r.metric)));

  // 콘솔
  log("");
  log(`suite ${suiteName} · ${machine} · os ${fingerprint.os ?? "?"} · ${Object.entries(toolchains).map(([k, v]) => `${k} ${v}`).join(" · ") || "툴체인 지문 없음"}`);
  log(`기준선: ${baselinePath}${baseline ? ` (갱신 ${baseline.updated?.date ?? "?"} @ ${baseline.updated?.commit ?? "?"} — ${baseline.updated?.reason ?? ""})` : " (없음 — 전부 NEW)"}`);
  log("");
  log(consoleTable(rows));
  const notes = rows.filter((r) => r.reason).map((r) => `- ${r.metric}: ${r.verdict} — ${r.reason}`);
  if (notes.length > 0) {
    log("");
    for (const n of notes) log(n);
  }
  if (missing.length > 0) log(`\n경고: 기준선에 있는데 이번에 안 나온 지표 — ${missing.join(", ")}`);
  if (args.update) {
    log("");
    if (updated.length > 0) log(`기준선 갱신(${updated.length}): ${updated.join(", ")} → ${baselinePath}`);
    else log("기준선 갱신: 받아들인 지표 없음 — 파일을 바꾸지 않았다.");
    for (const r of refused) log(`  거부 ${r.metric}: ${r.why}`);
    for (const u of unknownUpdate) log(`  경고: --update 목록의 '${u}' 에 걸린 지표가 이번 실행에 없다(오타?)`);
  }

  // 보고서
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const runJson = {
    date: isoWithOffset(finishedAt),
    started: isoWithOffset(startedAt),
    commit: git.commit,
    dirty: git.dirty,
    suite: suiteName,
    argv,
    fingerprint,
    toolchains,
    cpu,
    forced: !!args.force,
    baseline: baselinePath,
    baselineUpdated: baseline?.updated ?? null,
    rows,
    missing,
    update: args.update ? { reason: args.reason, accepted: updated, refused, unknown: unknownUpdate } : null,
    exitCode: code,
  };
  const md = [
    `# 벤치 보고서 — ${suiteName}`,
    "",
    `- 시각: ${runJson.date}`,
    `- 커밋: ${git.commit ?? "?"}${git.dirty ? " (dirty)" : ""}`,
    `- 기계: ${machine} · os ${fingerprint.os ?? "?"} · node ${fingerprint.node ?? "?"}`,
    `- 툴체인: ${Object.entries(toolchains).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`,
    `- CPU: ${cpu.map((x) => `${x.when} ${(x.busy * 100).toFixed(1)}%`).join(" · ")}${args.force ? " (--force)" : ""}`,
    `- 기준선: \`${baselinePath}\`${baseline ? ` — ${baseline.updated?.date ?? "?"} @ ${baseline.updated?.commit ?? "?"}: ${baseline.updated?.reason ?? ""}` : " — 없음"}`,
    `- 판정: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    "",
    markdownTable(rows),
    "",
    ...(notes.length > 0 ? ["## 안내", "", ...notes, ""] : []),
    ...(missing.length > 0 ? ["## 빠진 지표", "", `기준선에 있는데 이번에 안 나왔다: ${missing.join(", ")}`, ""] : []),
    ...(args.update
      ? [
          "## 기준선 갱신",
          "",
          `- 이유: ${args.reason}`,
          `- 받아들임: ${updated.join(", ") || "없음"}`,
          ...refused.map((r) => `- 거부 ${r.metric}: ${r.why}`),
          "",
        ]
      : []),
    `종료 코드: ${code}`,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "run.json"), JSON.stringify(runJson, null, 2) + "\n", "utf8");
  writeFileSync(join(outDir, "report.md"), md, "utf8");

  // 이력(--record)
  if (args.record) {
    const histPath = join(historyDir, `${machine}.jsonl`);
    mkdirSync(historyDir, { recursive: true });
    const line = historyEntry({ date: runJson.date, commit: git.commit, dirty: git.dirty, machine, toolchains, rows });
    appendFileSync(histPath, JSON.stringify(line) + "\n", "utf8");
    log(`이력 기록: ${histPath}`);
  }

  log("");
  log(`판정: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")} — 종료 코드 ${code}`);
  log(`보고서: ${join(outDir, "report.md")}`);
  if (code === 1) {
    log("REGRESSED: ① 같은 명령을 한 번 더(NOISY 확인) ② 원인 커밋을 워크트리 비교로 좁힌다 ③ 고치거나, 의도한 비용이면 --update --reason (계획 §6)");
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
  runBench({ argv: process.argv.slice(2) }).then(
    (code) => {
      process.exitCode = code;
      // suite 가 핸들(자식 프로세스·소켓)을 남겨도 끝나게 — stdout 이 비워질 틈은 준다.
      setTimeout(() => process.exit(code), 500).unref();
    },
    (e) => {
      console.error(e);
      process.exitCode = 2;
      setTimeout(() => process.exit(2), 500).unref();
    },
  );
}
