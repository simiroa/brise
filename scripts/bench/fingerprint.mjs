/**
 * 지문(fingerprint) — docs/PLAN-2026-10-23-perf-baselines.md §2.4. 무엇이 같아야 시간 지표를 비교하나.
 *
 *   machine   CPU 모델·논리 코어·RAM GB 로 만든 id (`ryzen9-5900x-24t-128g`) — 기준선 파일 이름이기도 하다
 *   os        os.release() (`10.0.26300`)
 *   node      process.version (기록용)
 *   rust      `rustc -V` (2단계 — collectFingerprint({rust:true}))
 *   webview2  WebView2 런타임 버전(3단계 — 측정 중에 알게 되므로 suite 가 ctx.setToolchain 으로 넘긴다)
 *
 * cpuSlug·machineSlug 는 순수 함수(테스트 고정). 나머지는 os·자식 프로세스를 읽는다.
 */
import os from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

/**
 * CPU 모델 문자열 → 짧은 슬러그.
 *   "AMD Ryzen 9 5900X 12-Core Processor            " → "ryzen9-5900x"
 *   "12th Gen Intel(R) Core(TM) i7-12700K"             → "i7-12700k"
 * 상표 기호·제조사·"N-Core"·"Processor"·클럭(@ …GHz)·"with … Graphics" 를 떼고, 한 자리 숫자 토큰은
 * 앞 토큰에 붙인다("Ryzen 9" → "ryzen9", "Ultra 7" → "ultra7").
 * @param {string} model
 */
export function cpuSlug(model) {
  const cleaned = String(model ?? "")
    .replace(/\((?:R|TM)\)|®|™/gi, " ")
    .replace(/@.*$/, " ")
    .replace(/\bwith\b.*$/i, " ")
    .replace(/\b\d+-Core\b/gi, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\s+Gen\b/gi, " ")
    .replace(/\b(?:AMD|Intel|Processor|CPU|Core)\b/gi, " ")
    .toLowerCase();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const merged = [];
  for (const t of tokens) {
    if (/^\d$/.test(t) && merged.length > 0) merged[merged.length - 1] += t;
    else merged.push(t);
  }
  const slug = merged
    .join("-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-cpu";
}

/**
 * @param {string} model CPU 모델 문자열
 * @param {number} logicalCores 논리 코어 수
 * @param {number} totalBytes 전체 RAM 바이트
 * @returns {string} `ryzen9-5900x-24t-128g`
 */
export function machineSlug(model, logicalCores, totalBytes) {
  const gb = Math.round(Number(totalBytes) / 2 ** 30);
  return `${cpuSlug(model)}-${logicalCores}t-${gb}g`;
}

/** 이 기계의 id. 시간 지표 기준선 파일 이름(`scripts/bench/baselines/<machineId>.json`). */
export function machineId() {
  const cpus = os.cpus();
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : cpus.length;
  return machineSlug(cpus[0]?.model ?? "unknown-cpu", cores, os.totalmem());
}

/** `~/.cargo/bin` — 이 PC 에선 PATH 에 없다(MEMORY: cargo-not-on-path). */
export function cargoBinDir() {
  return join(os.homedir(), ".cargo", "bin");
}

/**
 * PATH 앞에 `~/.cargo/bin` 을 붙인 환경 사본. Windows 의 env 는 키가 `Path` 일 수 있어 같은 키를 고친다
 * (`PATH` 를 새로 만들면 자식 프로세스에 두 키가 함께 가서 어느 쪽이 이길지 모른다).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function envWithCargo(env = process.env) {
  const out = { ...env };
  const bin = cargoBinDir();
  if (!existsSync(bin)) return out;
  const key = Object.keys(out).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const parts = String(out[key] ?? "").split(delimiter).filter(Boolean);
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase().replace(/[\\/]+$/, "") : p.replace(/\/+$/, ""));
  if (!parts.some((p) => norm(p) === norm(bin))) out[key] = [bin, ...parts].join(delimiter);
  return out;
}

/** `rustc -V` 한 줄. 못 찾으면 null. */
export function rustVersion(env = process.env) {
  const exe = process.platform === "win32" ? "rustc.exe" : "rustc";
  for (const cmd of ["rustc", join(cargoBinDir(), exe)]) {
    try {
      const out = execFileSync(cmd, ["-V"], { env: envWithCargo(env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
      const line = out.trim().split(/\r?\n/)[0];
      if (line) return line;
    } catch {
      // silent-ok: 다음 후보(~/.cargo/bin 절대 경로)로 넘어가고, 둘 다 없으면 null → 러너가 경고
    }
  }
  return null;
}

/**
 * @param {{rust?: boolean, webview2?: string}} [opts]
 * @returns {{machine:string, os:string, node:string, rust?:string, webview2?:string}}
 */
export function collectFingerprint({ rust = false, webview2 } = {}) {
  const fp = { machine: machineId(), os: os.release(), node: process.version };
  if (rust) {
    const v = rustVersion();
    if (v) fp.rust = v;
  }
  if (webview2) fp.webview2 = String(webview2);
  return fp;
}
