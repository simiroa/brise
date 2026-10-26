#!/usr/bin/env node
/**
 * 무음 삼킴(silent swallow) 래칫 — audit §5 (docs/AUDIT-2026-09-26-fallback-observability.md).
 *
 * 배경: 감사에서 무작위 표본만 봐도(전수는 안 셈) 프런트 빈 `catch`/`.catch(() => {})` 12건 중
 * 5건이 **사용자 행동의 무음 실패**였다(수집 제안 수락, AI 설정/히스토리 열기, 제외 도메인 저장).
 * 전수(빈 catch 165 · `callSilent` 320)는 분류할 수 없으니, 늘어나는 것만이라도 기계가 잡는다.
 *
 * 잡는 패턴 둘:
 *   (1) 빈 catch 블록 — `catch {}` / `catch (e) {}` / `catch (e: unknown) {}`. 공백만 있거나
 *       **주석만** 있는 본문도 "비었다"로 센다(그 주석이 `silent-ok:` 가 아닌 한 — 아래 참고).
 *   (2) `.catch(() => {})` 류 — 화살표 본문이 빈 블록이거나, `undefined`/`null`/`false`/`[]`
 *       리터럴 하나만 반환. 파라미터는 `()`/`(e)`/`(_)`/`(_e: unknown)` 등 아무 형태나 허용.
 *
 * **세지 않는 것**(실패가 이미 어딘가에 남는 자리 — "어디에도 안 남는 삼킴"만 센다):
 *   - `call()`/`callSilent()` 에 바로 붙은 `.catch(...)`, 그리고 try 본문에 둘 중 하나가 있는 빈
 *     catch. 두 함수의 실패는 lib/invoke.ts 의 logError 가 진단 싱크(diag)에 이미 기록한다
 *     (call() 은 토스트까지). CLAUDE.md 함정 8 의 정식 형태 `try { await call() } catch {}` 가 여기.
 *     사이에 `.then(...)` 이 끼면 그 핸들러의 예외까지 삼키므로 센다.
 *   - 주석 안의 언급(`// 예전엔 .catch(() => {}) 였다`).
 * 그 외(이벤트 emit, JSON.parse, 파일/브라우저 API 등)는 정당해도 센다 — 늘어나면 이유를
 * `silent-ok:` 로 남기거나 reportFallback 으로 기록하라는 압력을 준다(면제 규약 아래 참고).
 *
 * ── `silent-ok:` 면제 규약 ───────────────────────────────────────────────────
 * 그 자리(빈 catch 블록의 catch 줄~닫는 중괄호 줄, 또는 `.catch(...)` 호출이 걸치는 줄들) **또는
 * 그 바로 위 줄**에 `silent-ok:` 뒤에 사유가 있으면 면제된다(사유 없이 `silent-ok:` 만 있으면
 * 면제 아님 — 콜론 뒤에 최소 한 글자는 있어야 한다). 빈 catch 블록은 **본문 안**의 주석도 같은
 * 방식으로 본다(줄 범위에 이미 포함되므로 별도 처리 불필요) — `catch {\n  // silent-ok: 이유\n}`
 * 형태가 성립하려면 이게 꼭 필요하다. 주의: **본문이 주석만 있어도 그 주석에 `silent-ok:` 가
 * 없으면 여전히 위반으로 센다** — "무슨 말이든 주석을 달면 면제"가 아니다.
 *   예: `} catch { // silent-ok: 오프라인 배지 폴백, 별도 신호 불필요\n }`
 *
 * 베이스라인은 **파일별 개수**(check-surface-contract.allow.json 의 파일-키 스타일을 그대로 따름).
 * 개수가 스냅샷보다 **늘어난** 파일, 또는 스냅샷에 없던 새 파일에 위반이 있으면 실패한다.
 * `--update` 는 그냥 다시 씀(단방향 거부 없음 — 오케스트레이터가 웨이브 종료 후 다시 갱신한다).
 * 개수가 줄면(정리됨) `--update` 를 권하는 안내만 찍는다(래칫이 방향 없이도 계속 통과는 하되,
 * 낮출 기회를 알려준다).
 *
 * 고치는 법: 진짜 처리기를 붙이거나, `reportFallback(feature, code, detail?)`(src/lib/diag.ts,
 * Wave 1 diag 싱크)로 기록하거나, 의도적으로 무음이면 `silent-ok: <이유>` 를 남긴다.
 * **`callSilent` 는 여전히 정식 무음-무토스트 형태다** — 이 스크립트가 세는 것은 "toast 를
 * callSilent 로 껐다"가 아니라 "그 실패가 어디에도 기록되지 않는다"는 사실 자체이므로, 고치라고
 * `call()` 로 되돌리라는 뜻이 아니다.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const BASELINE = "scripts/check-silent-catch.allow.json";
const SILENT_OK_RE = /silent-ok:\s*\S/;

function posix(p) {
  return p.replace(/\\/g, "/");
}

function isTestFile(p) {
  return /\.test\.tsx?$/.test(p) || /(^|\/)__tests__\//.test(p);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = posix(join(dir, name));
    const stat = statSync(p);
    if (stat.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !isTestFile(p)) out.push(p);
  }
  return out;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

// 매치가 걸친 줄들( + 바로 위 한 줄)에 `silent-ok: <이유>` 가 있으면 면제. 빈 catch 블록의 "본문
// 안 주석"도 spanEnd 가 닫는 중괄호까지 포함하므로 이 한 함수로 같이 처리된다.
function isExempt(lines, spanStartIdx, spanEndIdx) {
  for (let ln = Math.max(1, spanStartIdx - 1); ln <= spanEndIdx; ln++) {
    if (SILENT_OK_RE.test(lines[ln - 1] ?? "")) return true;
  }
  return false;
}

// ── (1) 빈 catch 블록 ────────────────────────────────────────────────────────
// 문자열/템플릿 리터럴 안의 `{`/`}` 로 인한 오탐지 균형 잡기 문제를 피하려고, 정확한 닫는
// 중괄호를 균형으로 찾지 않는다 — 여는 중괄호 바로 다음부터 공백/주석만 건너뛰어 **첫 실코드
// 토큰**이 곧장 `}` 인지만 본다. 아니면(진짜 코드가 있으면) 그 자리에서 바로 "비지 않음"으로
// 판정하고 멈춘다 — 본문이 얼마나 긴지, 그 안에 무슨 문자열이 있는지는 아예 안 본다.
const CATCH_HEADER_RE =
  /\bcatch\s*(?:\(\s*[A-Za-z_$][\w$]*(?:\s*:\s*[^)]*)?\s*\))?\s*\{/g;

function skipWsAndComments(text, i) {
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function findEmptyCatchBlocks(text) {
  const hits = []; // { headerStart, closeBraceIdx }
  CATCH_HEADER_RE.lastIndex = 0;
  let m;
  while ((m = CATCH_HEADER_RE.exec(text))) {
    const bodyStart = m.index + m[0].length; // 바로 다음 = 여는 '{' 다음 문자
    const j = skipWsAndComments(text, bodyStart);
    if (text[j] === "}") {
      hits.push({ headerStart: m.index, closeBraceIdx: j });
    }
  }
  return hits;
}

// ── (2) `.catch(() => {})` / `.catch(() => undefined|null|false|[])` ───────
// 파라미터는 괄호형(`(e)`/`(_e: unknown)`/`()`) 또는 맨 식별자(`e =>`) 둘 다 허용. `\s*` 가
// 개행도 먹으므로 `.catch(() => {\n})` 같은 여러 줄 형태도 잡는다(전체 텍스트에 대해 한 번에
// 매치 — 줄 단위로 스캔하면 이런 여러 줄 형태를 놓친다).
const CATCH_ARROW_RE =
  /\.catch\s*\(\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*\}|undefined|null|false|\[\])\s*\)/g;

function findEmptyCatchArrows(text) {
  const hits = []; // { start, end }
  CATCH_ARROW_RE.lastIndex = 0;
  let m;
  while ((m = CATCH_ARROW_RE.exec(text))) {
    hits.push({ start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

// 매치 시작점이 주석 안인가 — 주석에서 패턴을 "언급"만 한 경우(이 감사를 인용한 주석들이 실제로
// 오탐을 냈다). 줄 앞머리 `//`·`*`·`/*`, 줄 중간 `//`(URL 의 `://` 제외), 닫히지 않은 블록 주석.
function isInComment(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  if (/^\s*(?:\/\/|\/\*|\*)/.test(prefix)) return true;
  if (/(?:^|[^:])\/\//.test(prefix)) return true;
  return text.lastIndexOf("/*", index) > text.lastIndexOf("*/", index);
}

// call()/callSilent() 의 실패는 lib/invoke.ts 의 logError 가 이미 진단 싱크(diag)에 기록한다
// (AUDIT-2026-09-26 frontend-sink 이후) — 그 바로 뒤의 삼킴은 "어디에도 안 남는" 무음이 아니다.
const IPC_CALL_RE = /\bcall(?:Silent)?\s*(?:<[^()]*?>)?\s*\(/;

// `.catch` 가 걸린 문장(마지막 `;` 이후, 최대 600자)이 call()/callSilent() 에 바로 붙은 것인가.
// 사이에 `.then(...)` 이 끼면 그 핸들러의 예외(IPC 아님)까지 삼키므로 IPC 로 보지 않는다.
function catchChainIsIpc(text, index) {
  const chunk = text.slice(Math.max(0, index - 600), index);
  const stmt = chunk.slice(chunk.lastIndexOf(";") + 1);
  return IPC_CALL_RE.test(stmt) && !/\.then\s*\(/.test(stmt);
}

// 빈 catch 블록의 try 본문(헤더 앞 가장 가까운 `try {` 부터)에 call()/callSilent() 가 있는가 —
// CLAUDE.md 함정 8 의 정식 형태 `try { await call(...) } catch { … }` 는 call() 이 토스트를,
// logError 가 진단 기록을 이미 남긴다.
// ponytail: try 본문에 IPC 말고 다른 던지는 코드(JSON.parse 등)가 섞여 있어도 면제된다(느슨한 쪽),
// 중첩 try 는 가장 가까운 try 를 본다. 오탐보다 누락을 택했다 — 래칫이 소음으로 무시되지 않게.
function tryBodyIsIpc(text, headerStart) {
  const chunk = text.slice(Math.max(0, headerStart - 1500), headerStart);
  let last = -1;
  for (const m of chunk.matchAll(/\btry\s*\{/g)) last = m.index;
  return last >= 0 && IPC_CALL_RE.test(chunk.slice(last));
}

// 탐지 본체 — 파일(collectViolations)과 자가 검증(selfTest)이 같은 함수를 탄다(드리프트 방지).
function violationsIn(text) {
  const lines = text.split("\n");
  const found = [];

  for (const hit of findEmptyCatchBlocks(text)) {
    if (isInComment(text, hit.headerStart) || tryBodyIsIpc(text, hit.headerStart)) continue;
    const startLn = lineNumber(text, hit.headerStart);
    const endLn = lineNumber(text, hit.closeBraceIdx);
    if (isExempt(lines, startLn, endLn)) continue;
    found.push({ line: startLn, snippet: lines[startLn - 1].trim().slice(0, 100), kind: "catch{}" });
  }

  for (const hit of findEmptyCatchArrows(text)) {
    if (isInComment(text, hit.start) || catchChainIsIpc(text, hit.start)) continue;
    const startLn = lineNumber(text, hit.start);
    const endLn = lineNumber(text, hit.end);
    if (isExempt(lines, startLn, endLn)) continue;
    found.push({
      line: startLn,
      snippet: lines[startLn - 1].trim().slice(0, 100),
      kind: ".catch()",
    });
  }

  found.sort((a, b) => a.line - b.line);
  return found;
}

function collectViolations(file) {
  return violationsIn(readFileSync(file, "utf8"));
}

// ── 자가 검증 — scripts/ 에 테스트 파일을 두는 관례가 없어(check-surface-contract.mjs 의
// settingsLineSelfTest 와 같은 이유) 이 파일 안에서 fixture 로 검증한다.
function selfTest() {
  const cases = [
    // [source, expectedViolationCount, label]
    ["try { f(); } catch {}", 1, "완전히 빈 catch"],
    ["try { f(); } catch (e) {}", 1, "파라미터 있는 빈 catch"],
    ["try { f(); } catch (e: unknown) {}", 1, "타입 주석 있는 빈 catch"],
    ["try { f(); } catch {\n  // 그냥 주석\n}", 1, "주석만 있는 본문(면제 아님)도 위반"],
    [
      "try { f(); } catch {\n  // silent-ok: 오프라인 배지, 신호 불필요\n}",
      0,
      "본문 안 silent-ok 는 면제",
    ],
    ["// silent-ok: 의도적 무음\ntry { f(); } catch {}", 0, "바로 위 줄 silent-ok 는 면제"],
    ["try { f(); } catch {} // silent-ok: 의도적 무음", 0, "같은 줄 silent-ok 는 면제"],
    ["try { f(); } catch { g(); }", 0, "실코드가 있는 catch 는 위반 아님"],
    ["try { f(); } catch { reportFallback('map', 'offline'); }", 0, "reportFallback 호출은 위반 아님"],
    ["x.catch(() => {})", 1, "빈 화살표 블록"],
    ["x.catch((e) => {})", 1, "파라미터 있는 빈 화살표 블록"],
    ["x.catch((_e: unknown) => {})", 1, "타입 주석 파라미터"],
    ["x.catch(() => {\n})", 1, "여러 줄 빈 화살표 블록"],
    ["x.catch(() => null)", 1, "null 리터럴"],
    ["x.catch(() => undefined)", 1, "undefined 리터럴"],
    ["x.catch(() => false)", 1, "false 리터럴"],
    ["x.catch(() => [])", 1, "빈 배열 리터럴"],
    ["x.catch(() => [1, 2])", 0, "비어있지 않은 배열은 위반 아님"],
    ["x.catch(() => reportFallback('ai', 'timeout'))", 0, "실제 처리기 호출은 위반 아님"],
    ["callSilent('x', {}).catch(() => {})", 0, "callSilent 실패는 logError 가 diag 에 기록 — 무음 아님"],
    ["void callSilent<{ a: 1 }>('x', {\n  b: 2,\n}).catch(() => {})", 0, "여러 줄 제네릭 callSilent 도 IPC"],
    ["callSilent('x').then((r) => { use(r); }).catch(() => {})", 1, ".then 핸들러 예외까지 삼키면 센다"],
    ["emit('ev', {}).catch(() => {})", 1, "IPC 아닌 promise 는 센다"],
    ["try { await call('x', {}); } catch {}", 0, "try { await call() } catch {} — 정식 형태(토스트+diag)"],
    ["try { JSON.parse(s); } catch {}", 1, "IPC 없는 try 는 센다"],
    ["// 예전엔 x.catch(() => {}) 였다", 0, "주석 속 언급은 세지 않는다"],
    [" * JSDoc: .catch(() => {}) 금지", 0, "JSDoc 줄 속 언급은 세지 않는다"],
    ["const u = 'https://x'; p.catch(() => {})", 1, "URL 의 :// 는 주석이 아니다"],
    ["// silent-ok: 이유\nx.catch(() => {})", 0, "화살표 폼도 바로 위 줄 면제 적용"],
  ];
  // collectViolations 와 같은 violationsIn 을 문자열 fixture 에 직접 돌린다(로직 중복 = 드리프트).
  for (const [src, want, label] of cases) {
    const got = violationsIn(src);
    if (got.length !== want) {
      throw new Error(
        `check-silent-catch selftest 실패 (${label}): 기대 ${want}건 != 실제 ${got.length}건 — "${src}"`
      );
    }
  }
}
selfTest();

// ── 본체 ────────────────────────────────────────────────────────────────────
const files = walk(SRC);
const currentCounts = {};
const currentDetails = {};
for (const file of files) {
  const violations = collectViolations(file);
  if (violations.length) {
    currentCounts[file] = violations.length;
    currentDetails[file] = violations;
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify(currentCounts, null, 2) + "\n");
  const total = Object.values(currentCounts).reduce((a, b) => a + b, 0);
  console.log(`check-silent-catch: 베이스라인 갱신 — 무음 삼킴 ${total}건(${Object.keys(currentCounts).length}개 파일) 기록.`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`check-silent-catch: 베이스라인이 없습니다(${BASELINE}).`);
  console.error("먼저 `node scripts/check-silent-catch.mjs --update` 로 생성하세요.");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

let failed = false;
const increased = [];
for (const [file, count] of Object.entries(currentCounts)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) increased.push({ file, count, allowed });
}

const currentTotal = Object.values(currentCounts).reduce((a, b) => a + b, 0);
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

console.log(`check-silent-catch: audit §5 — 무음 삼킴(빈 catch / .catch(()=>{})) 래칫 검사.`);
console.log(`현재 총 ${currentTotal}건(${Object.keys(currentCounts).length}개 파일), 베이스라인 총 ${baselineTotal}건.`);

if (increased.length) {
  failed = true;
  console.error(`\ncheck-silent-catch: 베이스라인보다 늘어난 파일 ${increased.length}개.`);
  for (const r of increased) {
    console.error(`  - ${r.file}: 허용 ${r.allowed}건 -> 실제 ${r.count}건`);
    for (const d of currentDetails[r.file]) {
      console.error(`      ${d.line}: [${d.kind}] \`${d.snippet}\``);
    }
  }
  console.error(
    "\n고치는 법: 실제 처리기를 붙이거나, reportFallback(feature, code, detail?)(src/lib/diag.ts) 로\n" +
      "기록하거나, 의도적으로 무음이면 그 줄/바로 위 줄에 `// silent-ok: <이유>` 를 남기세요.\n" +
      "callSilent(...) 자체는 여전히 정식 무토스트 형태입니다 — call() 로 되돌리라는 뜻이 아닙니다.\n" +
      "의도된 기존 증가라면 `node scripts/check-silent-catch.mjs --update` 로 베이스라인에 반영하세요."
  );
}

if (failed) process.exit(1);

console.log(`check-silent-catch: OK — 모든 파일이 베이스라인 이내.`);
if (currentTotal < baselineTotal) {
  console.log(
    "  ↳ 무음 삼킴이 베이스라인보다 줄었습니다 — " +
      "`node scripts/check-silent-catch.mjs --update` 로 베이스라인을 내려 주세요."
  );
}
