/**
 * 측정기 출력 규약(docs/PLAN-2026-10-23-perf-baselines.md §2.3) — `BENCH-JSON {…}` 한 줄 = 한 지표.
 *
 *   BENCH-JSON {"metric":"search.question_avg_ms","unit":"ms","samples":[1.91,1.88],"workload":{"notes":10000}}
 *
 * - `samples` 는 워밍업을 뺀 표본(결정적 지표는 길이 1). 통계(중앙값·IQR)는 러너가 낸다.
 * - 측정기 쪽 언어(Rust `println!`, Node `console.log`)는 상관없다 — 이 모듈은 텍스트만 본다.
 *
 * 순수 모듈: Node 내장도 쓰지 않는다. 부작용 없음.
 */

export const BENCH_PREFIX = "BENCH-JSON ";

// 줄 맨 앞, 또는 공백 뒤의 마커. 마커 뒤 JSON 은 그 줄 끝까지 간다.
// "공백 뒤"를 받는 이유: `cargo test -- --nocapture --test-threads=1` 은 `test foo ... ` 를 줄바꿈 없이
// 찍은 뒤 테스트를 돌리므로, 테스트의 첫 `println!` 이 그 줄에 이어 붙는다
// (`test bench::x ... BENCH-JSON {…}`). 사람용 문장 속 언급("BENCH-JSON 줄을 낸다")은 `{` 로 시작하는
// JSON 이 줄 끝까지 이어지지 않으므로 걸리지 않는다.
const LINE_RE = /(?:^|\s)BENCH-JSON (\{.*\})\s*$/;

/**
 * 한 결과 객체를 검증하고 정규화한다. 잘못되면 throw.
 * @param {unknown} obj
 * @param {string} [where] 오류 메시지에 붙일 위치 설명
 * @returns {{metric:string, unit:string, samples:number[], workload:object}}
 */
export function normalizeBenchResult(obj, where = "") {
  const at = where ? ` (${where})` : "";
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`BENCH 결과가 객체가 아니다${at}`);
  }
  const { metric, unit, samples, workload } = /** @type {any} */ (obj);
  if (typeof metric !== "string" || !/^[a-z0-9_]+\.[a-z0-9_.]+$/.test(metric)) {
    throw new Error(`BENCH 결과의 metric 이 '<영역>.<이름>' 형식이 아니다: ${JSON.stringify(metric)}${at}`);
  }
  if (typeof unit !== "string" || unit.length === 0) {
    throw new Error(`BENCH 결과 ${metric} 에 unit 이 없다${at}`);
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`BENCH 결과 ${metric} 의 samples 가 비었다${at}`);
  }
  for (const s of samples) {
    if (typeof s !== "number" || !Number.isFinite(s)) {
      throw new Error(`BENCH 결과 ${metric} 의 samples 에 유한한 수가 아닌 값: ${JSON.stringify(s)}${at}`);
    }
  }
  if (workload !== undefined && (workload === null || typeof workload !== "object" || Array.isArray(workload))) {
    throw new Error(`BENCH 결과 ${metric} 의 workload 가 객체가 아니다${at}`);
  }
  return { metric, unit, samples: [...samples], workload: workload ? { ...workload } : {} };
}

/**
 * 측정기 출력(사람용 줄이 섞여 있어도 된다)에서 BENCH-JSON 줄만 뽑는다.
 * 마커가 있는데 JSON 이 깨졌으면 조용히 건너뛰지 않고 throw — 측정기 버그는 시끄러워야 한다.
 * @param {string} text
 * @returns {Array<{metric:string, unit:string, samples:number[], workload:object}>}
 */
export function parseBenchLines(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.includes("BENCH-JSON")) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      // 마커 뒤에 '{' 가 오는데 줄 끝까지 JSON 으로 맞지 않으면 측정기 버그(뒤에 잡음이 붙었거나 줄이
      // 잘렸다). 문장 속 언급(마커 뒤가 '{' 가 아님)은 넘긴다.
      if (/(?:^|\s)BENCH-JSON \{/.test(line)) {
        throw new Error(`BENCH-JSON 줄의 JSON 이 줄 끝까지 이어지지 않는다 (줄 ${i + 1}): ${line.slice(0, 200)}`);
      }
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (e) {
      throw new Error(`BENCH-JSON 줄의 JSON 을 읽지 못했다 (줄 ${i + 1}): ${/** @type {Error} */ (e).message} — ${line.slice(0, 200)}`);
    }
    out.push(normalizeBenchResult(parsed, `줄 ${i + 1}`));
  }
  return out;
}

/**
 * 측정기가 낼 한 줄을 만든다(노드 측정기용). 검증을 거친다.
 * @param {{metric:string, unit:string, samples:number[], workload?:object}} obj
 * @returns {string}
 */
export function formatBenchLine(obj) {
  const r = normalizeBenchResult(obj);
  return BENCH_PREFIX + JSON.stringify({ metric: r.metric, unit: r.unit, samples: r.samples, workload: r.workload });
}
