/**
 * 기준선 파일 — docs/PLAN-2026-10-23-perf-baselines.md §2.5 (schema 1).
 *
 *   시간(2·3단계)  scripts/bench/baselines/<machine-id>.json   kind "wall"
 *   결정적(1단계)  scripts/bench/baselines/bundle.json          kind "bundle"
 *
 * **기준선은 `--update --reason "<이유>"` 로만 움직인다**(§2.2). 자동으로 오르내리지 않는다.
 *
 * 갱신 규칙(applyUpdate / planUpdate):
 *   - reason 필수(없으면 throw).
 *   - NOISY 행, 그리고 판정과 무관하게 표본이 흔들린 행(row.noisy — 기준선이 없어 NEW 인 첫 기록 포함)은 거부.
 *     흔들린 표본을 기준선으로 박으면 다음 정상 실행이 실패한다(§1.4).
 *   - UNCOMPARABLE 행은 기본 거부. 단 `--update=<id>`(only 목록)에 **이름이 직접 걸린** 지표는 받는다 —
 *     WebView2·rustc 가 바뀐 뒤의 의도한 재기준선 경로(§2.4 "바뀌면 재기준선"). 목록 없는 `--update` 로는
 *     지문이 다른 값이 기준선을 덮지 않는다.
 *   - only 가 있으면 그 목록(정확한 id 또는 영역 접두)에 걸린 지표만 고친다. 나머지 기준선 항목은 그대로.
 *
 * 형식 확장(계획 §2.5 의 상위 집합): 지표 항목마다 `fingerprint`(기록 당시 fingerprint_keys 의 값)를 적는다.
 * 파일 상단 `toolchains` 만 있으면 `--update=일부` 로 rustc 가 바뀐 값을 기록하는 순간 갱신하지 않은 지표까지
 * 새 툴체인과 "같아" 보인다. compare.mjs 는 항목의 fingerprint 를 먼저 보고, 없으면 상단 값을 본다.
 *
 * loadBaseline/writeBaseline 만 파일을 만진다. planUpdate/applyUpdate/historyEntry 는 순수 함수.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { matchesAny } from "./compare.mjs";

export const SCHEMA = 1;

/** @param {string} path @returns {object|null} 없으면 null. 형식이 틀리면 throw. */
export function loadBaseline(path) {
  if (!existsSync(path)) return null;
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`기준선 파일을 읽지 못했다 (${path}): ${/** @type {Error} */ (e).message}`);
  }
  if (!obj || typeof obj !== "object" || obj.schema !== SCHEMA) {
    throw new Error(`기준선 파일의 schema 가 ${SCHEMA} 가 아니다 (${path}): ${JSON.stringify(obj?.schema)}`);
  }
  if (!obj.metrics || typeof obj.metrics !== "object" || Array.isArray(obj.metrics)) {
    throw new Error(`기준선 파일에 metrics 객체가 없다 (${path})`);
  }
  return obj;
}

/** @param {string} path @param {object} obj */
export function writeBaseline(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/**
 * 어떤 행을 기준선에 반영할지 가른다(applyUpdate 와 같은 규칙 — 러너가 거부 사유를 찍는 데 쓴다).
 * @param {Array<object>} rows compareRun 의 행
 * @param {{only?: string[]|null}} [opts]
 * @returns {{accept: object[], refuse: Array<{metric:string, why:string}>, unknown: string[]}}
 *   unknown = only 목록 중 이번 행 어느 것에도 걸리지 않은 항목(오타 경고용)
 */
export function planUpdate(rows, { only = null } = {}) {
  const list = only && only.length > 0 ? only : null;
  const accept = [];
  const refuse = [];
  for (const row of rows ?? []) {
    if (list && !matchesAny(row.metric, list)) continue;
    if (row.verdict === "NOISY" || row.noisy) {
      refuse.push({ metric: row.metric, why: "표본이 흔들림(NOISY) — 조용한 상태에서 다시 돌린 뒤 갱신" });
      continue;
    }
    if (row.verdict === "UNCOMPARABLE") {
      if (list) {
        accept.push(row);
      } else {
        refuse.push({
          metric: row.metric,
          why: `지문·워크로드가 기준선과 다름 — 의도한 재기준선이면 --update=${row.metric} 로 이름을 직접 적는다`,
        });
      }
      continue;
    }
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
      refuse.push({ metric: row.metric, why: "값이 유한한 수가 아님" });
      continue;
    }
    accept.push(row);
  }
  const unknown = list ? list.filter((p) => !(rows ?? []).some((r) => matchesAny(r.metric, [p]))) : [];
  return { accept, refuse, unknown };
}

function round6(x) {
  return typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x;
}

function definedOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

/** 행 → 기준선 항목(§2.5 모양 + 항목별 fingerprint). */
function entryFromRow(row) {
  const e = { value: round6(row.value), unit: row.unit };
  if (row.stat && row.stat !== "value") {
    e.stat = row.stat;
    e.runs = row.n;
    e.spread = round6(row.iqr);
  }
  if (row.workload && Object.keys(row.workload).length > 0) e.workload = { ...row.workload };
  const keys = Array.isArray(row.fingerprint_keys) ? row.fingerprint_keys : [];
  if (keys.length > 0) {
    e.fingerprint_keys = [...keys];
    e.fingerprint = { ...(row.fingerprint ?? {}) };
  }
  e.direction = row.direction ?? "lower";
  e.tolerance = row.tolerance ?? null;
  e.gate = !!row.gate;
  return e;
}

function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

const TOP_ORDER = ["schema", "kind", "authority", "fingerprint", "toolchain", "toolchains", "roots", "updated"];

/**
 * 기준선에 행을 반영한 **새 객체**를 돌려준다(입력은 건드리지 않는다).
 * @param {object|null} baseline 기존 기준선(없으면 null — 첫 기준선)
 * @param {Array<object>} rows compareRun 의 행
 * @param {{only?: string[]|null, reason: string, commit?: string|null, date?: string|null,
 *          fingerprint?: object|null, toolchains?: object|null, kind?: 'wall'|'bundle'}} opts
 *   kind 'wall'   : 상단 fingerprint {machine, os} · toolchains {rust?, webview2?}
 *   kind 'bundle' : 상단 toolchain(단수, 계획 §2.5 의 bundle.json 모양). roots·authority 등 기존 상단 필드는 보존.
 */
export function applyUpdate(baseline, rows, opts) {
  const { only = null, reason, commit = null, date = null, fingerprint = null, toolchains = null, kind } = opts ?? {};
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error('기준선 갱신에는 --reason "<이유>" 가 필요하다');
  }
  const prev = baseline ?? null;
  const out = { ...(prev ?? {}) };
  out.schema = SCHEMA;
  out.kind = kind ?? prev?.kind ?? "wall";
  if (out.kind === "bundle") {
    if (toolchains) out.toolchain = { ...(prev?.toolchain ?? {}), ...definedOnly(toolchains) };
  } else {
    if (fingerprint) {
      out.fingerprint = { ...(prev?.fingerprint ?? {}), ...definedOnly({ machine: fingerprint.machine, os: fingerprint.os }) };
    }
    out.toolchains = { ...(prev?.toolchains ?? {}), ...definedOnly(toolchains ?? {}) };
  }
  out.updated = { date, commit, reason: reason.trim() };

  const metrics = { ...(prev?.metrics ?? {}) };
  for (const row of planUpdate(rows, { only }).accept) metrics[row.metric] = entryFromRow(row);

  const ordered = {};
  for (const k of TOP_ORDER) if (k in out) ordered[k] = out[k];
  for (const k of Object.keys(out)) if (!(k in ordered) && k !== "metrics") ordered[k] = out[k];
  ordered.metrics = sortKeys(metrics);
  return ordered;
}

/**
 * `--record` 한 줄(§2.5 실행 기록) — scripts/bench/history/<machine-id>.jsonl 에 붙인다.
 * @param {{date:string, commit:string|null, dirty:boolean|null, machine:string, toolchains:object, rows:object[]}} p
 */
export function historyEntry({ date, commit, dirty, machine, toolchains, rows }) {
  const metrics = {};
  for (const r of rows ?? []) {
    metrics[r.metric] = { median: round6(r.value), iqr: round6(r.iqr), n: r.n, verdict: String(r.verdict).toLowerCase() };
  }
  return { date, commit, dirty, machine, toolchains: definedOnly(toolchains ?? {}), metrics };
}
