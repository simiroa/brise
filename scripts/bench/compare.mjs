/**
 * 판정 규칙 — docs/PLAN-2026-10-23-perf-baselines.md §2.2. 순수 함수만(부작용·입출력 없음).
 * 경계값은 compare.test.mjs 가 고정한다.
 *
 *   허용폭 = max(rel × base, abs)
 *   REGRESSED    : m − base >  허용폭                    → gate 지표면 종료 코드 1
 *   IMPROVED     : base − m >  허용폭                    → 통과 + "--update 로 고정하세요"
 *   NOISY        : (시간 지표만) IQR / 중앙값 > 0.25      → 판정 없음(REGRESSED 보다 우선)
 *   PASS         : 그 밖(허용폭과 **정확히 같으면 PASS**)
 *   direction 'higher' 면 부호만 뒤집는다.
 *
 * compareRun 이 덧붙이는 판정:
 *   NEW          : 기준선에 그 지표가 없다 → --update 로 첫 기준선
 *   UNCOMPARABLE : 지문 키(fingerprint_keys)·workload·단위가 기준선과 다르다 → 숫자만, 판정 없음
 *   INFO         : 허용 오차가 없는 정보 지표(tolerance:null) → 값만, 판정 없음
 * exitCode 는 gate 지표의 REGRESSED 만 본다. 나머지 판정은 전부 종료 코드 0.
 */
import { METRICS } from "./metrics.mjs";

export const NOISY_RATIO = 0.25;

/** 허용폭 경계의 부동소수 오차 흡수(0.4 − 0.1 = 0.30000000000000004 가 abs 0.3 을 "넘는" 것). */
const REL_EPS = 1e-9;

/**
 * @param {number[]} samples
 * @returns {{median:number, iqr:number, n:number, min:number, max:number}}
 * 사분위는 선형 보간(numpy 기본, type 7). 표본 1개면 iqr 0.
 */
export function stats(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("stats: 표본이 비었다");
  }
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => {
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return { median: q(0.5), iqr: q(0.75) - q(0.25), n: s.length, min: s[0], max: s[s.length - 1] };
}

/**
 * §2.2 판정 한 건.
 * @param {{base:number, m:number, rel:number, abs:number, direction?:'lower'|'higher', iqrRatio?:number|null, iqr?:number|null, noisyRatio?:number}} p
 *   iqrRatio: 시간 지표면 IQR/중앙값, 아니면 null(NOISY 판정 안 함).
 *   iqr: 표본 IQR — 주면 isNoisy 의 절대 하한 조건을 함께 본다.
 * @returns {{verdict:'PASS'|'REGRESSED'|'IMPROVED'|'NOISY', delta:number, allowance:number}}
 *   delta = m − base(부호 그대로, direction 과 무관), allowance = 허용폭(양수).
 */
export function verdict({ base, m, rel, abs, direction = "lower", iqrRatio = null, iqr = null, noisyRatio = NOISY_RATIO }) {
  for (const [k, v] of Object.entries({ base, m, rel, abs })) {
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`verdict: ${k} 가 수가 아니다 (${v})`);
  }
  if (direction !== "lower" && direction !== "higher") {
    throw new Error(`verdict: direction 은 lower|higher (${direction})`);
  }
  const allowance = Math.max(rel * Math.abs(base), abs);
  const delta = m - base;
  if (isNoisy(iqrRatio, iqr, abs, noisyRatio)) return { verdict: "NOISY", delta, allowance };
  const worse = direction === "higher" ? -delta : delta;
  const eps = REL_EPS * Math.max(1, Math.abs(base), Math.abs(m));
  if (worse > allowance + eps) return { verdict: "REGRESSED", delta, allowance };
  if (-worse > allowance + eps) return { verdict: "IMPROVED", delta, allowance };
  return { verdict: "PASS", delta, allowance };
}

/**
 * 표본이 판정을 믿을 수 없을 만큼 흔들렸나 — IQR/중앙값 > noisyRatio **이고** IQR 이 허용 오차의 절대 하한(abs)보다 크다.
 * 절대 하한 조건이 없으면 값이 아주 작은 지표(대시보드 그리기 6~14 ms, IQR 5~7 ms)가 상대 비율만으로 매번 NOISY 가 돼
 * 판정을 한 번도 못 냈다(2026-10-23 첫 기준선 기록). IQR 이 abs 이하면 중앙값의 흔들림이 허용폭 안이라 판정을 믿어도 된다.
 * iqr·abs 를 모르면(null) 비율만 본다.
 */
export function isNoisy(iqrRatio, iqr, abs, noisyRatio = NOISY_RATIO) {
  if (iqrRatio == null || !(iqrRatio > noisyRatio)) return false;
  if (iqr != null && abs != null && iqr <= abs) return false;
  return true;
}

/** 시간 지표인가 — NOISY 판정 대상. 단위가 'ms' 인 지표만(크기·개수는 잡음 판정 없음). */
export function isTimeMetric(def) {
  return def?.unit === "ms";
}

/** 레지스트리에도 기준선에도 없는 지표의 정의 — 정보 지표로 받는다. */
export function defaultDef(unit) {
  return {
    group: "unknown",
    unit,
    direction: "lower",
    stat: "median",
    tolerance: null,
    gate: false,
    fingerprint_keys: ["machine", "os"],
  };
}

/**
 * 지표 id 가 목록(정확한 id 또는 영역 접두)에 걸리나. `search` 는 `search.question_avg_ms` 에 걸리고
 * `searchx.a` 에는 안 걸린다. 목록이 비었거나 없으면 전부 통과.
 * @param {string} id @param {string[]|null|undefined} list
 */
export function matchesAny(id, list) {
  if (!list || list.length === 0) return true;
  return list.some((p) => {
    const q = String(p).trim();
    if (!q) return false;
    return id === q || id.startsWith(q.endsWith(".") ? q : q + ".");
  });
}

/** 키 순서와 무관한 깊은 비교(JSON 값 범위). */
export function sameJson(a, b) {
  return canonical(a) === canonical(b);
}

function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}

/**
 * 레지스트리 정의 → (없으면) 기준선 항목에 적힌 정의 → (그것도 없으면) 정보 지표 기본값.
 * 허용 오차·gate 는 **레지스트리가 이긴다**(metrics.mjs 가 SSOT — 허용 오차를 고치면 재기준선 없이 바로 적용).
 */
function resolveDef(id, unit, registry, entry) {
  if (registry && Object.prototype.hasOwnProperty.call(registry, id)) return registry[id];
  if (entry) {
    return {
      ...defaultDef(entry.unit ?? unit),
      ...(entry.direction ? { direction: entry.direction } : {}),
      ...(entry.stat ? { stat: entry.stat } : {}),
      ...("tolerance" in entry ? { tolerance: entry.tolerance } : {}),
      ...("gate" in entry ? { gate: !!entry.gate } : {}),
      ...(Array.isArray(entry.fingerprint_keys) ? { fingerprint_keys: entry.fingerprint_keys } : {}),
    };
  }
  return defaultDef(unit);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

function fmtRatio(x) {
  return Number.isFinite(x) ? x.toFixed(3) : String(x);
}

/**
 * 한 실행의 결과를 기준선과 비교한다.
 * @param {{baseline: object|null, results: Array<{metric:string, unit:string, samples:number[], workload?:object}>,
 *          fingerprint: object, registry?: object}} p
 * @returns {Array<object>} 행. 계약 필드 {metric, unit, gate, value, iqr, n, base, verdict, delta, allowance, reason}
 *   에 더해 갱신·보고용 {group, min, max, samples, workload, noisy, iqrRatio, stat, direction, tolerance,
 *   fingerprint_keys, fingerprint}. `noisy` 는 판정과 무관하게 계산한다(NEW 행도) — 흔들린 표본을 첫 기준선으로
 *   박지 않도록 applyUpdate 가 이걸 본다(§1.4).
 *   측정기 버그(같은 지표 두 번 · 레지스트리와 다른 단위)는 throw — 러너가 종료 코드 2 로 낸다.
 */
export function compareRun({ baseline, results, fingerprint, registry = METRICS }) {
  const seen = new Set();
  const rows = [];
  for (const r of results ?? []) {
    if (seen.has(r.metric)) throw new Error(`compareRun: 같은 지표가 두 번 나왔다 — ${r.metric} (측정기 버그)`);
    seen.add(r.metric);
    const entry = baseline?.metrics?.[r.metric] ?? null;
    const def = resolveDef(r.metric, r.unit, registry, entry);
    if (def.unit !== r.unit) {
      throw new Error(`compareRun: ${r.metric} 의 단위가 정의와 다르다 — 측정기 '${r.unit}', 정의 '${def.unit}'`);
    }
    const st = stats(r.samples);
    const timing = isTimeMetric(def);
    const iqrRatio = timing ? (st.median === 0 ? (st.iqr > 0 ? Infinity : 0) : st.iqr / Math.abs(st.median)) : null;
    const noisy = isNoisy(iqrRatio, st.iqr, def.tolerance?.abs ?? null);
    const keys = Array.isArray(def.fingerprint_keys) ? def.fingerprint_keys : [];
    const row = {
      metric: r.metric,
      unit: r.unit,
      group: def.group,
      gate: !!def.gate,
      value: st.median,
      iqr: st.iqr,
      n: st.n,
      min: st.min,
      max: st.max,
      samples: [...r.samples],
      workload: r.workload ?? {},
      base: null,
      verdict: "NEW",
      delta: null,
      allowance: null,
      reason: "",
      noisy,
      iqrRatio,
      stat: def.stat ?? "median",
      direction: def.direction ?? "lower",
      tolerance: def.tolerance ?? null,
      fingerprint_keys: [...keys],
      fingerprint: pick(fingerprint, keys),
    };
    rows.push(row);

    if (!entry) {
      row.reason = noisy
        ? `기준선 없음 · 표본이 흔들림(IQR/중앙값 ${fmtRatio(iqrRatio)}) — 조용한 상태에서 다시 돌린 뒤 기록`
        : '기준선 없음 — --update --reason "…" 로 첫 기준선 기록';
      continue;
    }
    row.base = typeof entry.value === "number" ? entry.value : null;

    // 지문: 항목에 기록 당시 값이 있으면 그것(--update=일부 로 갱신해도 다른 지표의 비교 근거가 안 섞이게),
    // 없으면 파일 상단 fingerprint/toolchains.
    const mismatches = [];
    for (const k of keys) {
      const bv =
        entry.fingerprint && typeof entry.fingerprint === "object"
          ? entry.fingerprint[k]
          : (baseline?.fingerprint?.[k] ?? baseline?.toolchains?.[k]);
      const cv = fingerprint?.[k];
      if ((bv ?? null) !== (cv ?? null)) mismatches.push(`${k}: ${bv ?? "(없음)"} → ${cv ?? "(없음)"}`);
    }
    if (entry.unit && entry.unit !== r.unit) mismatches.push(`unit: ${entry.unit} → ${r.unit}`);
    if (!sameJson(entry.workload ?? {}, r.workload ?? {})) {
      mismatches.push(`workload: ${canonical(entry.workload ?? {})} → ${canonical(r.workload ?? {})}`);
    }
    if (row.base === null) mismatches.push("기준값이 수가 아님");
    if (mismatches.length > 0) {
      row.verdict = "UNCOMPARABLE";
      row.reason = `${mismatches.join("; ")} — 의도한 변화면 --update=${r.metric} --reason "…" 로 재기준선`;
      if (row.base !== null) row.delta = row.value - row.base;
      continue;
    }

    if (!row.tolerance) {
      row.verdict = "INFO";
      row.delta = row.value - row.base;
      row.reason = "정보 지표(허용 오차 없음) — 판정 없이 값만";
      continue;
    }

    const v = verdict({
      base: row.base,
      m: row.value,
      rel: row.tolerance.rel,
      abs: row.tolerance.abs,
      direction: row.direction,
      iqrRatio,
      iqr: row.iqr,
    });
    row.verdict = v.verdict;
    row.delta = v.delta;
    row.allowance = v.allowance;
    if (v.verdict === "NOISY") {
      row.reason = `표본이 흔들림(IQR/중앙값 ${fmtRatio(iqrRatio)} > ${NOISY_RATIO}, IQR > 허용 오차 하한) — 다시 돌리세요`;
    } else if (v.verdict === "IMPROVED") {
      row.reason = "개선 — 연속 실행으로 확인한 뒤 --update 로 고정하세요";
    } else if (v.verdict === "REGRESSED" && !row.gate) {
      row.reason = "정보 지표 — 종료 코드에 반영하지 않음";
    }
  }
  return rows;
}

/** gate 지표 중 REGRESSED 가 하나라도 있으면 1, 아니면 0. */
export function exitCode(rows) {
  return (rows ?? []).some((r) => r.gate && r.verdict === "REGRESSED") ? 1 : 0;
}
