#!/usr/bin/env node
/**
 * 창 라벨 ↔ capability 등록 검사.
 *
 * 배경: 프런트에서 부르는 Tauri core 창 커맨드(hide/close/show/minimize/setSize/...)는
 * src-tauri/capabilities/*.json 의 permissions 에 core:window:allow-<동작> 이 있어야 한다.
 * 없으면 Tauri 가 **조용히 거부**하고, 프런트의 void/catch{} 가 거절을 삼켜 아무 반응 없이
 * 죽는다. 같은 사고가 두 번 났다 — 2026-08-14 allow-close 누락(설정 창이 안 닫힘),
 * 2026-08-21 allow-hide 누락(같은 증상, 209185f). 사람 규율만으로는 안 된다는 게 증명됐다.
 *
 * 이 스크립트는 두 가지를 본다(완전성이 아니라 "명백한 누락" 차단이 목표 — 정적으로
 * 판단 못 하는 건 조용히 통과시킨다):
 *
 * (a) Rust 가 만드는 웹뷰 창 라벨이 어느 capability 의 windows 배열에도 없는 경우.
 *     WebviewWindowBuilder::new(app, <라벨>, ...) 의 라벨은 문자열 리터럴이거나 상수/구조체
 *     필드일 수 있어, 같은 파일 안의 `const X: &str = "..."` 와 `Spec { label: X, ... }`
 *     생성 지점을 얕게 따라가 리터럴로 환원한다. tauri.conf.json 의 본 창(windows[0].label,
 *     없으면 "main")도 포함한다.
 *
 * (b) 프런트가 쓰는 core 창 "동작"(mutating 커맨드 — hide/close/show/... )에 대응하는
 *     core:window:allow-<kebab> 이 **어느 capability 에도** 없는 경우. 어느 창에서 실행되는
 *     코드인지는 정적으로 알기 어려우므로 특정 capability 로 좁히지 않고 전체 capability
 *     파일의 permissions 합집합과만 대조한다 — "아무 데도 없다"는 두 사고 모두를 잡는
 *     가장 안전한 기준이다. core:window:default(core:default 에 포함)가 이미 커버하는
 *     읽기 전용 getter(outerPosition/isMaximized/...)는 애초에 검사 대상에서 뺀다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const RUST_SRC = "src-tauri/src";
const CAPS_DIR = "src-tauri/capabilities";
const CONF = "src-tauri/tauri.conf.json";

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(p);
  }
  return out;
}

// --- (a) Rust 창 라벨 수집 -------------------------------------------------------------
// `const X: &str = "value";` — 같은 파일 안에서 라벨을 가리키는 식별자를 환원하는 데 쓴다.
const constMap = new Map(); // "file::IDENT" -> literal
// 구조체 필드 값(`AuxWindowSpec { label: SOME_CONST, ... }`)도 같은 방식으로 환원한다.
const specLabelValues = new Set();

const rustFiles = walk(RUST_SRC, [".rs"]);
for (const file of rustFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/const\s+(\w+)\s*:\s*&str\s*=\s*"([^"]+)"/g)) {
    constMap.set(`${file}::${m[1]}`, m[2]);
  }
}

function resolveLabelExpr(file, expr) {
  const lit = expr.match(/^"([^"]+)"$/);
  if (lit) return lit[1];
  const ident = expr.match(/^(\w+)$/);
  if (ident) {
    const local = constMap.get(`${file}::${ident[1]}`);
    if (local) return local;
    // 파일 간 상수(예: aux_window.rs 의 MAIN_LABEL 은 이 파일에서 정의됨) — 전체에서 탐색.
    for (const [key, val] of constMap) if (key.endsWith(`::${ident[1]}`)) return val;
  }
  return null; // spec.label 같은 필드 접근 등 — 아래에서 별도 처리
}

const rustLabels = new Set();
const unresolvedBuilders = [];

for (const file of rustFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/WebviewWindowBuilder::new\(\s*\w+,\s*([^,]+),/g)) {
    const expr = m[1].trim();
    if (expr.includes(".")) continue; // spec.label 형태 — 구조체 생성 지점에서 별도로 수집
    const resolved = resolveLabelExpr(file, expr);
    if (resolved) rustLabels.add(resolved);
    else unresolvedBuilders.push(`${file}: WebviewWindowBuilder::new(app, ${expr}, ...)`);
  }
  // `AuxWindowSpec { label: IDENT, ... }` 형태의 구조체 리터럴에서 라벨 값을 수집.
  for (const m of text.matchAll(/label:\s*(\w+)\s*,/g)) {
    const resolved = resolveLabelExpr(file, m[1]) ?? (m[1].match(/^"([^"]+)"$/) ? m[1] : null);
    if (resolved) specLabelValues.add(resolved);
  }
}
for (const v of specLabelValues) rustLabels.add(v);
// 동적 라벨(섹션 분리 창 `section-<id>`, section_window.rs) — 라벨 자체는 런타임에 정해지므로
// `const X_LABEL_PREFIX: &str = "..."` 상수를 찾아 대표 라벨(`<prefix>x`)로 대조한다. capability
// 쪽은 글롭(`section-*`)으로 등록돼 있어야 통과한다.
for (const [key, val] of constMap) if (/_LABEL_PREFIX$/.test(key)) rustLabels.add(`${val}x`);

// tauri.conf.json 의 본 창.
const conf = JSON.parse(readFileSync(CONF, "utf8"));
const confWindows = conf.app?.windows ?? [];
for (const w of confWindows) rustLabels.add(w.label ?? "main");

// --- capability 파일의 windows 배열 + permissions 합집합 -------------------------------
const capFiles = walk(CAPS_DIR, [".json"]);
const capWindowLabels = new Set();
const capPermissions = new Set();
for (const file of capFiles) {
  const cap = JSON.parse(readFileSync(file, "utf8"));
  for (const w of cap.windows ?? []) capWindowLabels.add(w);
  for (const p of cap.permissions ?? []) capPermissions.add(p);
}

// Tauri capability 의 windows 는 글롭을 받는다(`*` 만 쓰므로 그것만 해석한다).
const capWindowMatchers = [...capWindowLabels].map(
  (w) => new RegExp(`^${w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
);
const missingLabels = [...rustLabels].filter((l) => !capWindowMatchers.some((re) => re.test(l))).sort();

// --- (b) 프런트 core 창 동작 커맨드 수집 ------------------------------------------------
// core:window:default(core:default 번들에 포함)가 이미 커버하는 읽기 전용 getter는 굳이
// 명시 permission 이 없어도 통과하므로 검사 대상에서 뺀다. 목록 출처: Tauri core window
// 플러그인 default permission set(src-tauri/gen/schemas/desktop-schema.json 의
// "core:window:default" 설명 — allow-get-all-windows 등).
const DEFAULT_COVERED = new Set([
  "get-all-windows", "scale-factor", "inner-position", "outer-position", "inner-size",
  "outer-size", "is-fullscreen", "is-minimized", "is-maximized", "is-focused",
  "is-decorated", "is-resizable", "is-maximizable", "is-minimizable", "is-closable",
  "is-visible", "is-enabled", "title", "current-monitor", "primary-monitor",
  "monitor-from-point", "available-monitors", "cursor-position", "theme",
  "is-always-on-top", "activity-name", "scene-identifier", "internal-toggle-maximize",
]);

function toKebab(camel) {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// getCurrentWindow() 로 얻은 인스턴스를 가리키는 식별자를 파일 단위로 얕게 추적한다
// (스코프를 안 가리므로 오탐 가능성은 "같은 이름을 다른 용도로 재사용" 뿐 — 이 코드베이스에는
// 없다). 이벤트 리스너 등록(onResized 등, `on` 접두사)은 core:event 쪽이라 제외.
const usedActions = new Map(); // kebab-action -> file[]
for (const file of walk(SRC, [".ts", ".tsx"])) {
  if (/\.test\.(ts|tsx)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  if (!text.includes("getCurrentWindow")) continue;

  const names = new Set();
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*getCurrentWindow\(\)/g)) names.add(m[1]);
  for (const m of text.matchAll(/(\w+)\s*:\s*ReturnType<typeof getCurrentWindow>/g)) names.add(m[1]);

  // 직접 체이닝: getCurrentWindow().method(
  for (const m of text.matchAll(/getCurrentWindow\(\)\s*\.\s*(\w+)\s*\(/g)) {
    if (m[1].startsWith("on")) continue;
    const kebab = toKebab(m[1]);
    if (DEFAULT_COVERED.has(kebab)) continue;
    if (!usedActions.has(kebab)) usedActions.set(kebab, []);
    usedActions.get(kebab).push(file);
  }
  // 추적된 변수명: name.method(
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\s*\\.\\s*(\\w+)\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      if (m[1].startsWith("on")) continue;
      const kebab = toKebab(m[1]);
      if (DEFAULT_COVERED.has(kebab)) continue;
      if (!usedActions.has(kebab)) usedActions.set(kebab, []);
      usedActions.get(kebab).push(file);
    }
  }
}

const missingActions = [...usedActions.keys()]
  .filter((kebab) => !capPermissions.has(`core:window:allow-${kebab}`))
  .sort();

// --- 결과 ---------------------------------------------------------------------------------
let failed = false;

if (unresolvedBuilders.length) {
  console.log(`check-window-capabilities: 정적 검증 불가(창 라벨 표현식) — ${unresolvedBuilders.length}건`);
  for (const u of unresolvedBuilders) console.log(`  - ${u}`);
}

if (missingLabels.length) {
  failed = true;
  console.error("check-window-capabilities: Rust 가 만드는 창 라벨이 어느 capability 의 windows 배열에도 없습니다.");
  console.error("이 창에서는 core 커맨드가 조용히 거부됩니다(예: 드래그·닫기·숨기기가 죽음).");
  for (const l of missingLabels) console.error(`  - "${l}"`);
  console.error(`\n고치는 법: ${CAPS_DIR} 의 해당 capability(또는 새 capability) windows 배열에 라벨을 추가하세요.`);
}

if (missingActions.length) {
  failed = true;
  console.error("\ncheck-window-capabilities: 프런트가 부르는 창 동작에 대응하는 permission 이 어느 capability 에도 없습니다.");
  for (const a of missingActions) {
    console.error(`  - core:window:allow-${a}  (사용처: ${[...new Set(usedActions.get(a))].join(", ")})`);
  }
  console.error(`\n고치는 법: 해당 창을 덮는 capability 의 permissions 에 "core:window:allow-<동작>" 을 추가하세요.`);
}

if (failed) process.exit(1);

console.log(
  `check-window-capabilities: OK — 창 라벨 ${rustLabels.size}개 전부 등록됨, 창 동작 ${usedActions.size}종 전부 permission 있음.`
);
