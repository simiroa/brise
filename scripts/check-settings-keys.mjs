#!/usr/bin/env node
/**
 * settings_set 키 드리프트 검사.
 *
 * 배경: 백엔드 validate_setting 은 허용 목록(allowlist)이다. 프론트가 목록에 없는 키를
 * settings_set 으로 저장하면 "unknown setting key" 로 거부되는데, 호출부가 .catch(()=>{}) 로
 * 삼키면 에러조차 안 보이고 값만 조용히 사라진다. 이 실수가 실제로 두 번 났다
 * (sidebar_collapsed → 에러 토스트, favorites_open → 무음 실패). 사람이 못 잡으니 기계가 잡는다.
 *
 * 하는 일: src/ 의 settings_set 호출에서 키를 뽑아 settings_schema.rs 의 validate_setting
 * match 팔에 모두 존재하는지 대조한다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
// R4 분리: validate_setting 은 migrations.rs 에서 repo/settings_schema.rs 로 이동했다.
const MIGRATIONS = "src-tauri/src/repo/settings_schema.rs";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// --- 프론트: settings_set 에 넘기는 키 수집 -------------------------------------------------
// `entries: { a: x, b: y }` 형태(개행 포함)를 잡아 최상위 키만 추출한다.
//
// 중첩 값 주의: `entries: { default_map_location: { lat, lng, zoom } }` 처럼 값이 객체면,
// 안쪽 필드명(lat/lng/zoom)은 설정 키가 아니다. 중괄호 깊이를 세서 depth 1 의 문자만 남긴
// 문자열로 키를 뽑는다. 예전 `\{([\s\S]{0,400}?)\}` 정규식은 첫 `}` 에서 끊겨 안쪽 필드를
// 최상위 키로 오인했다(=오탐). 문자열 리터럴 안의 중괄호는 건너뛴다.
function entriesBody(text, from) {
  let depth = 1;
  let top = ""; // depth 1 의 문자만
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      // 문자열은 통째로 건너뛴다 — 안의 중괄호/콜론은 코드가 아니다. 자리표시자 `~` 를 남겨
      // 계산된 키(`[`inbox_${id}`]:`)가 빈 `[]:` 로 뭉개져 dynamic 보고에서 빠지지 않게 한다.
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      if (depth === 1) top += "~";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
    if (depth === 1 && c !== "{" && c !== "}") top += c;
  }
  return top;
}

// entriesBody 자체 검사. 이 추출기의 위험한 실패는 오탐이 아니라 **미탐**이다 — 중첩 객체
// 뒤에 오는 진짜 키를 놓치면 스캐너가 통과시키고, 그 키는 런타임에 조용히 저장 안 된다(이
// 파일이 존재하는 이유 그 자체). scripts/ 에 테스트 파일을 두는 관례가 없으므로 검사를 여기
// 둔다 — 통과하면 아무 것도 출력하지 않고, 깨지면 스캐너가 먼저 죽는다.
function selfTest() {
  const probe = (src) => entriesBody(src, src.indexOf("{") + 1);
  const cases = [
    // 중첩 값의 안쪽 필드는 키가 아니고, 그 뒤의 진짜 키는 반드시 잡혀야 한다.
    ["{ default_map_location: { lat: 1, lng: 2 }, real_key: 3 }", ["real_key"], ["lat", "lng"]],
    // 객체 배열도 마찬가지.
    ["{ roster: [{ mode: 'a' }], after: 1 }", ["after", "roster"], ["mode"]],
    // 문자열 안의 중괄호가 깊이를 어긋내면 안 된다.
    ["{ a: '}{', b: 2 }", ["a", "b"], []],
  ];
  for (const [src, must, mustNot] of cases) {
    const body = probe(src);
    for (const k of must) if (!body.includes(k)) throw new Error(`entriesBody selftest: "${k}" 누락 — ${src}`);
    for (const k of mustNot) if (body.includes(k)) throw new Error(`entriesBody selftest: "${k}" 오탐 — ${src}`);
  }
}
selfTest();

const frontendKeys = new Map(); // key -> [file...]
const dynamic = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("settings_set")) continue;

  // D2 (AUDIT-2026-08-22-debris.md §2.1): setSimplePref(camel, v) 가 `[PREF_SNAKE[camel]]: v` 로
  // 계산해 쓰는 실제 키는 이 pref(camel, snake, ...) 튜플들이다 — entries:{} 리터럴 파싱으로는
  // 계산된 키라 dynamic 으로만 빠지고 검증되지 않았다(PREFS 경유 20+ 키가 이 스캐너의 사각지대
  // 였다). 튜플의 snake 값을 프론트 키에 직접 합류시킨다.
  for (const pm of text.matchAll(/\bpref\(\s*"[A-Za-z0-9]+"\s*,\s*"([a-z0-9_]+)"/g)) {
    const key = pm[1];
    if (!frontendKeys.has(key)) frontendKeys.set(key, []);
    frontendKeys.get(key).push(`${file} (pref())`);
  }

  // D2: 같은 파일의 단순 문자열 상수(`const FOO = "bar";`) — `[FOO]:` 계산된 키를 풀어보는 데
  // 쓴다(예: stores/presets.ts 의 SETTINGS_KEY/HIDDEN_BUILTINS_KEY).
  const localConsts = new Map();
  for (const cm of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+)"\s*;/g)) {
    localConsts.set(cm[1], cm[2]);
  }

  const re = /entries:\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const body = entriesBody(text, m.index + m[0].length);
    // 계산된 키(`[foo]:`)나 스프레드는 기본적으로 정적 검증 불가 — 위 상수 매핑으로 풀리는
    // 것만 예외로 검증 목록에 편입하고, 나머지(템플릿 리터럴 등 진짜 동적인 것)만 보고한다.
    if (/\[[^\]]+\]\s*:/.test(body) || /\.\.\./.test(body)) {
      let anyBracket = false;
      let allResolved = true;
      for (const bk of body.matchAll(/\[([A-Za-z0-9_]+)\]\s*:/g)) {
        anyBracket = true;
        const resolved = localConsts.get(bk[1]);
        if (resolved) {
          if (!frontendKeys.has(resolved)) frontendKeys.set(resolved, []);
          frontendKeys.get(resolved).push(file);
        } else {
          allResolved = false;
        }
      }
      if (!anyBracket || !allResolved || /\.\.\./.test(body)) {
        dynamic.push(`${file}: ${body.trim().slice(0, 60).replace(/\s+/g, " ")}`);
      }
      continue;
    }
    for (const km of body.matchAll(/(^|[{,\s])([a-z_][a-z0-9_]*)\s*:/gi)) {
      const key = km[2];
      if (!frontendKeys.has(key)) frontendKeys.set(key, []);
      frontendKeys.get(key).push(file);
    }
  }
}

// --- 백엔드: validate_setting 허용 키 수집 --------------------------------------------------
const rust = readFileSync(MIGRATIONS, "utf8");
const start = rust.indexOf("fn validate_setting");
if (start === -1) {
  console.error(`check-settings-keys: validate_setting not found in ${MIGRATIONS}`);
  process.exit(2);
}
const region = rust.slice(start, rust.indexOf("\n}", start));
const allowed = new Set();
// `"a" => ...` 와 `"a" | "b" => ...` 양쪽을 처리
for (const arm of region.matchAll(/((?:"[a-z0-9_]+"\s*\|\s*)*"[a-z0-9_]+")\s*=>/gi)) {
  for (const q of arm[1].matchAll(/"([a-z0-9_]+)"/gi)) allowed.add(q[1]);
}

// --- 대조 ----------------------------------------------------------------------------------
const missing = [...frontendKeys.keys()].filter((k) => !allowed.has(k)).sort();

if (dynamic.length) {
  console.log("check-settings-keys: 정적 검증 불가(계산된 키) —");
  for (const d of dynamic) console.log(`  - ${d}`);
}

if (missing.length) {
  console.error("check-settings-keys: 백엔드 validate_setting 허용 목록에 없는 키가 있습니다.");
  console.error("이 키들은 settings_set 이 거부하므로 값이 저장되지 않습니다.");
  for (const k of missing) {
    console.error(`  - "${k}"  (사용처: ${[...new Set(frontendKeys.get(k))].join(", ")})`);
  }
  console.error(`\n고치는 법: ${MIGRATIONS} 의 validate_setting 에 match 팔을 추가하고,`);
  console.error("필요하면 default_settings 에도 기본값을 넣으세요.");
  process.exit(1);
}

console.log(
  `check-settings-keys: OK — 프론트 키 ${frontendKeys.size}개가 모두 허용 목록(${allowed.size}개)에 있습니다.`
);
