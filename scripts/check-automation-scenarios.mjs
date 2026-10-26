#!/usr/bin/env node
// 자동화 규칙 시나리오(specs/automation/scenarios.yaml) 검사 — PLAN-2026-10-08 §13.
//
// 보고 모드다: 웨이브별로 시나리오가 planned / red / green 중 어디 있는지 표로 보여 준다.
// 실패(exit 1)는 두 가지뿐 — ① 구조 오류(id 중복, 모르는 rule/wave/status, 코퍼스에 없는 노트 id)
// ② status 가 red/green 인데 test 가 비었거나 그 이름의 테스트를 저장소에서 못 찾음.
// planned 는 아무리 많아도 실패가 아니다(아직 웨이브가 안 왔다). `npm run check` 에는 W1 착수 때 넣는다.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = join(ROOT, "specs", "automation", "scenarios.yaml");
const CORPUS = join(ROOT, "src-tauri", "tests", "fixtures", "automation", "corpus.json");
const SEARCH_DIRS = ["src-tauri/src", "src-tauri/tests", "src", "scripts", "cli"];

const RULES = new Set([...Array.from({ length: 17 }, (_, i) => `R${i + 1}`), "S"]);
const WAVES = new Set(["WS", ...Array.from({ length: 13 }, (_, i) => `W${i}`)]);
const STATUSES = new Set(["planned", "red", "green"]);
const NOTE_ID = /^[nh]\d{2}$/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(rs|ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function collectNoteRefs(value, out = []) {
  if (typeof value === "string") {
    if (NOTE_ID.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectNoteRefs(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectNoteRefs(v, out));
  }
  return out;
}

function testExists(texts, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rust = new RegExp(`fn\\s+${esc}\\s*\\(`);
  const vitest = new RegExp(`\\bit\\(\\s*(['"\`])${esc}\\1`);
  for (const [file, text] of texts) {
    if (rust.test(text) || vitest.test(text)) return file;
  }
  return null;
}

const doc = yaml.parse(readFileSync(SCENARIOS, "utf8"));
const corpus = JSON.parse(readFileSync(CORPUS, "utf8"));
const noteIds = new Set(corpus.notes.map((n) => n.id));
const scenarios = Array.isArray(doc?.scenarios) ? doc.scenarios : [];

const errors = [];
const seen = new Set();
let texts = null;
const byWave = new Map();

for (const [i, s] of scenarios.entries()) {
  const loc = `scenarios[${i}]${s?.id ? ` ${s.id}` : ""}`;
  if (!s || typeof s !== "object" || typeof s.id !== "string") {
    errors.push(`${loc}: id 없음`);
    continue;
  }
  if (seen.has(s.id)) errors.push(`${loc}: id 중복`);
  seen.add(s.id);
  if (!RULES.has(s.rule)) errors.push(`${loc}: 모르는 rule '${s.rule}'`);
  if (!WAVES.has(s.wave)) errors.push(`${loc}: 모르는 wave '${s.wave}'`);
  if (!STATUSES.has(s.status)) errors.push(`${loc}: status 는 planned|red|green`);
  if (!s.given || !s.expect) errors.push(`${loc}: given/expect 둘 다 필요`);
  for (const ref of collectNoteRefs([s.given, s.expect])) {
    if (!noteIds.has(ref)) errors.push(`${loc}: 코퍼스에 없는 노트 '${ref}'`);
  }
  let found = null;
  if (s.test) {
    texts ??= new Map(SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => [f, readFileSync(f, "utf8")]));
    found = testExists(texts, s.test);
  }
  if (s.status === "red" || s.status === "green") {
    if (!s.test) errors.push(`${loc}: status ${s.status} 인데 test 가 없다`);
    else if (!found) errors.push(`${loc}: test '${s.test}' 를 저장소에서 못 찾았다`);
  }
  const w = byWave.get(s.wave) ?? { planned: 0, red: 0, green: 0, linked: 0 };
  w[s.status] = (w[s.status] ?? 0) + 1;
  if (found) w.linked += 1;
  byWave.set(s.wave, w);
}

const order = ["WS", ...Array.from({ length: 13 }, (_, i) => `W${i}`)];
console.log(`check-automation-scenarios  ${scenarios.length} scenarios`);
console.log("  wave  planned  red  green  test 연결됨");
for (const wave of order) {
  const w = byWave.get(wave);
  if (!w) continue;
  console.log(`  ${wave.padEnd(4)}  ${String(w.planned).padStart(7)}  ${String(w.red).padStart(3)}  ${String(w.green).padStart(5)}  ${String(w.linked).padStart(10)}`);
}
if (errors.length) {
  console.error(`\ncheck-automation-scenarios: ${errors.length} error(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`  (${relative(ROOT, SCENARIOS)})`);
  process.exit(1);
}
console.log("check-automation-scenarios: OK");
