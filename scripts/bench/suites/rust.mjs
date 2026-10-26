/**
 * 2단계 — Rust 벤치 suite. docs/PLAN-2026-10-23-perf-baselines.md §4.
 *
 *   npm run bench                         (= node scripts/bench/run.mjs --suite rust)
 *   npm run bench -- --only search,export
 *   npm run bench -- --update --reason "질문 검색 색인 구조 변경(V96)"
 *
 * 측정기는 `src-tauri/tests/bench_question_search.rs` · `bench_doc_export.rs` 의 `#[ignore]` 테스트다. 테스트 함수
 * 하나를 프로세스 하나로 돌린다 — 함수마다 워크로드 환경 변수(노트 수·본문 배율)가 다르고, 각 함수가 자기 DB 를
 * 한 번 시드한 뒤 워밍업 1회 + 표본 N회를 스스로 돈다(계획 §4.2). 이 모듈은 `BENCH-JSON` 줄만 모은다.
 *
 *   cargo test --release --test <벤치> -- --ignored --nocapture --test-threads=1 --exact <함수>
 *
 * - `CARGO_TARGET_DIR` 는 ctx.env 에 없으면 `~/.cache/brise-target-bench` — 일반 `target/` 의 brise.exe 잠금·덮어쓰기를
 *   피한다(§4.3). 그래서 preflight 의 `--no-run` 빌드도 앱이 떠 있는 것과 무관하다(전용 폴더라 exe 잠금이 없다).
 * - preflight 에서 미리 빌드한다 — 러너가 30초 넘는 preflight 뒤 CPU 를 한 번 더 재므로 컴파일 부하가 측정에 안 섞인다.
 * - 작업마다 stdout·stderr 를 `<outDir>/rust-<작업>.log` 에 남긴다. 기대한 지표가 하나라도 안 나오면 실패(종료 코드 2) —
 *   테스트 이름 필터가 어긋나 "running 0 tests" 로 끝나는 경우를 조용히 넘기지 않는다.
 * - 플래그: `--only`(필요한 작업만 돈다) · `--samples N`(→ BRISE_BENCH_SAMPLES) · `--no-build`(preflight 빌드 생략).
 */
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { parseBenchLines } from "../benchJson.mjs";
import { matchesAny } from "../compare.mjs";
import { cargoBinDir } from "../fingerprint.mjs";
import { METRICS } from "../metrics.mjs";

export const DEFAULT_TARGET_DIR = join(os.homedir(), ".cache", "brise-target-bench");
/** 작업 하나(시드 + 표본)의 상한. 바쁜 기계에서 1만 노트 × 본문 4배 시드가 몇 분 걸린다. */
const JOB_TIMEOUT_MS = 30 * 60_000;
const BUILD_TIMEOUT_MS = 60 * 60_000;

/**
 * 측정 작업 = 테스트 함수 하나. env 는 워크로드 정의(계획 §4.1 표의 "워크로드" 열) — 측정기의 기본값에 기대지 않고
 * 여기서 전부 명시한다(search_box_timing 의 기본 본문 배율은 1 이라 4 를 빠뜨리면 다른 지표가 된다).
 * metrics 는 그 함수가 내야 하는 지표 id — scripts/bench/metrics.mjs 의 rust 그룹과 한 글자도 다르면 안 된다.
 */
export const JOBS = Object.freeze([
  {
    id: "question",
    target: "bench_question_search",
    test: "question_search_vs_sentence_search_timing",
    env: { BRISE_BENCH_NOTES: "10000", BRISE_BENCH_BODY_SCALE: "1" },
    metrics: ["search.question_avg_ms", "search.question_worst_ms", "index.bigram_mb_10k", "index.db_mb_10k"],
  },
  {
    id: "search-box",
    target: "bench_question_search",
    test: "search_box_timing",
    env: { BRISE_BENCH_NOTES: "10000", BRISE_BENCH_BODY_SCALE: "4" },
    metrics: ["search.box_worst_ms"],
  },
  {
    id: "fts-upsert",
    target: "bench_question_search",
    test: "fts_upsert_timing",
    env: { BRISE_BENCH_BODY_SCALE: "4" }, // 노트 수는 측정기 안에 1,000 · 10,000 으로 고정
    metrics: ["write.fts_upsert_10k_ms", "write.fts_upsert_1k_ms"],
  },
  {
    id: "export",
    target: "bench_doc_export",
    test: "bench_export_300_images",
    env: {}, // 그림 300장(jpg 200 + webp 100) — BENCH_JPG_ONLY 는 childEnv 가 지운다
    metrics: ["export.hwpx_ms_300img", "export.docx_ms_300img", "export.hwpx_peak_heap_mb", "export.docx_peak_heap_mb"],
  },
]);

// 자가 검증(모듈 로드 시) — 작업 표와 레지스트리가 어긋나면 러너가 "suite 모듈을 불러오지 못했다"(종료 코드 2)로 낸다.
{
  const rustIds = Object.keys(METRICS).filter((id) => METRICS[id].group === "rust");
  const jobIds = JOBS.flatMap((j) => j.metrics);
  const unknown = jobIds.filter((id) => METRICS[id]?.group !== "rust");
  const uncovered = rustIds.filter((id) => !jobIds.includes(id));
  if (unknown.length > 0 || uncovered.length > 0) {
    throw new Error(
      `suites/rust.mjs 작업 표가 metrics.mjs 의 rust 그룹과 다르다 — 레지스트리에 없음: [${unknown.join(", ")}] · 작업 없음: [${uncovered.join(", ")}]`,
    );
  }
}

/** `--only` 에 걸린 지표를 하나라도 내는 작업만. `--only index` 도 question 작업을 돈다. */
export function selectJobs(only) {
  return JOBS.filter((j) => j.metrics.some((m) => matchesAny(m, only)));
}

/** Windows 의 env 키는 대소문자를 가리지 않는다(`Path`) — 같은 키를 찾는다. */
function envKey(env, name) {
  return Object.keys(env).find((k) => k.toUpperCase() === name) ?? name;
}

export function targetDir(env) {
  const v = env[envKey(env, "CARGO_TARGET_DIR")];
  return v && String(v).trim() ? String(v) : DEFAULT_TARGET_DIR;
}

/**
 * 자식 환경 — 물려받은 BRISE_BENCH_* · BENCH_JPG_ONLY 를 지우고(워크로드는 작업 표가 정한다) 작업 env 를 얹는다.
 * @param {object} baseEnv ctx.env @param {{env:object}|null} job @param {number|null} samples
 */
export function childEnv(baseEnv, job, samples) {
  const env = { ...baseEnv };
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (u.startsWith("BRISE_BENCH_") || u === "BENCH_JPG_ONLY") delete env[k];
  }
  env[envKey(env, "CARGO_TARGET_DIR")] = targetDir(baseEnv);
  if (job) Object.assign(env, job.env);
  if (samples) env.BRISE_BENCH_SAMPLES = String(samples);
  return env;
}

/** @param {{target:string, test:string}} job */
export function cargoTestArgs(job) {
  return ["test", "--release", "--test", job.target, "--", "--ignored", "--nocapture", "--test-threads=1", "--exact", job.test];
}

/** `~/.cargo/bin` 의 실행 파일이 있으면 그 절대 경로, 없으면 PATH 에 맡긴다(이 PC 는 PATH 에 없다). */
function toolExe(name) {
  const local = join(cargoBinDir(), process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(local) ? local : name;
}

function cargoExe() {
  return toolExe("cargo");
}

function tail(text, lines = 40) {
  return String(text).split(/\r?\n/).slice(-lines).join("\n");
}

/**
 * 자식 프로세스를 띄워 stdout·stderr 를 로그 파일에 그대로 남기고, stdout 전체와 stderr 끝부분을 돌려준다.
 * maxBuffer 가 있는 execFile 대신 spawn — 측정기 출력이 길고 진행을 줄 단위로 보여 준다.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, ms:number}>}
 */
function runLogged(cmd, args, { cwd, env, logPath, timeoutMs, onStdoutLine }) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`$ ${cmd} ${args.join(" ")}\n# cwd ${cwd}\n`);
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let partial = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 우리가 띄운 cargo 와 그 아래 테스트 exe 만 죽인다(/T = 이 pid 의 자식 트리).
      if (process.platform === "win32" && child.pid) {
        try {
          execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch (e) {
          log.write(`# taskkill 실패: ${/** @type {Error} */ (e).message}\n`);
        }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log.write(chunk);
      if (!onStdoutLine) return;
      partial += chunk;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const l of lines) onStdoutLine(l);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024); // 끝부분만 쥔다(전체는 로그 파일에)
      log.write(chunk);
    });
    // 띄우기 실패면 'error' 뒤에 'close' 도 올 수 있다 — 로그 스트림을 두 번 닫지 않게 한 번만 마무리한다.
    let settled = false;
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end(`\n# 띄우기 실패: ${e.message}\n`);
      reject(new Error(`${cmd} 를 띄우지 못했다: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onStdoutLine && partial) onStdoutLine(partial);
      const ms = Date.now() - started;
      log.end(`\n# 종료 코드 ${code} · ${(ms / 1000).toFixed(1)}s${timedOut ? " · 시간 초과로 종료" : ""}\n`);
      if (timedOut) reject(new Error(`${cmd} ${args.join(" ")} 가 ${Math.round(timeoutMs / 60_000)}분 안에 끝나지 않았다 — 로그: ${logPath}`));
      else resolvePromise({ code, stdout, stderr, ms });
    });
  });
}

function srcTauri(ctx) {
  return join(ctx.repoRoot, "src-tauri");
}

/** 전원 계획(계획 §4.4 — 보고서에 기록). Windows 가 아니거나 못 읽으면 null. */
function powerScheme(env) {
  if (process.platform !== "win32") return null;
  try {
    return execFileSync("powercfg", ["/getactivescheme"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    // silent-ok: 보고용 부가 정보 — 못 읽으면 rust-env.json 에 null 로 남는다
    return null;
  }
}

/** 이번 실행에 쓸 작업. 빈 목록이면 throw(→ 종료 코드 2). */
function jobsFor(ctx) {
  const jobs = selectJobs(ctx.args.only);
  if (jobs.length === 0) {
    const ids = JOBS.flatMap((j) => j.metrics).join(", ");
    throw new Error(`--only ${ctx.args.only?.join(",")} 에 걸린 rust 지표가 없다(있는 지표: ${ids})`);
  }
  return jobs;
}

export default {
  name: "rust",
  fingerprint: { rust: true },

  async preflight(ctx) {
    const jobs = jobsFor(ctx);
    const cwd = srcTauri(ctx);
    const env = childEnv(ctx.env, null, ctx.args.samples);
    const cargo = cargoExe();
    let cargoVersion;
    try {
      cargoVersion = execFileSync(cargo, ["-V"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
    } catch (e) {
      throw new Error(`cargo 를 실행하지 못했다(${cargo}) — Rust 툴체인(~/.cargo/bin)을 확인: ${/** @type {Error} */ (e).message}`);
    }
    // 러너도 `rustc -V` 를 재지만(fingerprint.mjs), cargo 가 실제로 쓰는 툴체인은 src-tauri 에서 본 값이다
    // (rust-toolchain 파일이 생기면 갈린다) — 그 값으로 지문을 덮는다.
    let rustc = null;
    try {
      rustc = execFileSync(toolExe("rustc"), ["-V"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim().split(/\r?\n/)[0] || null;
    } catch (e) {
      ctx.log(`경고: src-tauri 에서 rustc -V 를 못 읽었다 — 러너가 저장소 루트에서 읽은 값을 쓴다 (${/** @type {Error} */ (e).message})`);
    }
    if (rustc) ctx.setToolchain("rust", rustc);
    const power = powerScheme(env);
    const info = {
      cargo: cargoVersion,
      rustc,
      cargoTargetDir: targetDir(ctx.env),
      samples: ctx.args.samples ?? 5,
      jobs: jobs.map((j) => ({ id: j.id, target: j.target, test: j.test, env: j.env, metrics: j.metrics })),
      power,
    };
    writeFileSync(join(ctx.outDir, "rust-env.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
    ctx.log(`${cargoVersion} · ${rustc ?? "rustc ?"} · CARGO_TARGET_DIR=${info.cargoTargetDir}`);
    if (power) ctx.log(`전원: ${power.replace(/\s+/g, " ")}`);
    ctx.log(`작업: ${jobs.map((j) => j.id).join(", ")}`);

    if (ctx.args.noBuild) {
      ctx.log("--no-build — 미리 빌드하지 않는다(측정 중 컴파일이 섞일 수 있다)");
      return;
    }
    const targets = [...new Set(jobs.map((j) => j.target))];
    const args = ["test", "--release", ...targets.flatMap((t) => ["--test", t]), "--no-run"];
    const logPath = join(ctx.outDir, "rust-build.log");
    ctx.log(`빌드: cargo ${args.join(" ")} (release, 처음이면 몇 분) — 로그 ${logPath}`);
    const r = await runLogged(cargo, args, { cwd, env, logPath, timeoutMs: BUILD_TIMEOUT_MS });
    if (r.code !== 0) {
      throw new Error(`빌드 실패(종료 코드 ${r.code}) — 로그 ${logPath}\n${tail(r.stderr)}`);
    }
    ctx.log(`빌드 끝 ${(r.ms / 1000).toFixed(1)}s`);
  },

  async run(ctx) {
    const jobs = jobsFor(ctx);
    const cwd = srcTauri(ctx);
    const cargo = cargoExe();
    const results = [];
    const timings = [];
    for (const job of jobs) {
      const env = childEnv(ctx.env, job, ctx.args.samples);
      const args = cargoTestArgs(job);
      const logPath = join(ctx.outDir, `rust-${job.id}.log`);
      const envDesc = Object.entries(job.env).map(([k, v]) => `${k}=${v}`).join(" ");
      ctx.log(`▶ ${job.id}: ${envDesc ? envDesc + " " : ""}cargo ${args.join(" ")}`);
      const r = await runLogged(cargo, args, {
        cwd,
        env,
        logPath,
        timeoutMs: JOB_TIMEOUT_MS,
        onStdoutLine: (l) => {
          if (l.trim() && !l.includes("BENCH-JSON")) ctx.log(`  ${l}`);
        },
      });
      if (r.code !== 0) {
        throw new Error(`${job.id} 실패(종료 코드 ${r.code}) — 로그 ${logPath}\n${tail(r.stdout, 20)}\n${tail(r.stderr, 20)}`);
      }
      const got = parseBenchLines(r.stdout);
      const ids = new Set(got.map((x) => x.metric));
      const missing = job.metrics.filter((m) => !ids.has(m));
      if (missing.length > 0) {
        throw new Error(
          `${job.id}: 측정기가 ${missing.join(", ")} 를 내지 않았다 — 테스트 이름(--exact ${job.test})·BENCH-JSON 출력 확인. 로그 ${logPath}`,
        );
      }
      results.push(...got);
      timings.push({ job: job.id, seconds: Math.round(r.ms / 100) / 10 });
      ctx.log(`■ ${job.id}: ${(r.ms / 1000).toFixed(1)}s · 지표 ${got.length}개`);
    }
    writeFileSync(join(ctx.outDir, "rust-timings.json"), JSON.stringify(timings, null, 2) + "\n", "utf8");
    return results;
  },
};
