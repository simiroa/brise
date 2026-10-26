#!/usr/bin/env node
/**
 * CSS VARIABLE USAGE GUARD
 *
 * 2026-08-14 사고: HomeTab.tsx의 상태 필터 팝오버가 정의되지 않은 --bg-surface, --shadow-dropdown을
 * 사용하여 완전 투명하게 뜨는 버그가 발생함. 이를 방지하기 위해 src 내 CSS/TSX에서 정의된 CSS 변수와
 * 사용처(var(--...))를 스캔하여 미정의 변수 사용을 사전에 차단한다.
 *
 * 2026-08-17 재발: 위 검사에 "폴백이 있으면(var(--foo, #hex)) 선택적 토큰으로 허용"이라는 면제
 * 조항이 있었다. 그래서 --bg-surface-elevated(14곳) · --surface-bg · --warning · --radius-pill 같은
 * 팬텀 토큰이 게이트를 그대로 통과했고, 실제로 그려진 건 폴백 리터럴(테마를 모르는 회색·하드코딩
 * 노랑)이었다. 즉 면제 조항이 2026-08-14와 정확히 같은 부류의 버그를 다시 숨겼다.
 * → 폴백 면제를 제거했다. 폴백이 있어도 토큰이 정의돼 있지 않으면 실패한다.
 *   되살리지 마라. 폴백은 "토큰이 없어도 된다"는 뜻이 아니라 "이 값이 실제로 그려진다"는 뜻이다.
 *   런타임에 주입되는 변수는 아래 JS_DEF_RE가 이미 수집하므로 면제 없이도 통과한다.
 *
 * 2026-08-30 W16 — 역방향 검사 추가: "var()로 쓰인 변수가 정의됐는가"만 보고 반대 방향(정의됐는데
 * 아무도 안 쓰는가)은 안 봐서 죽은 토큰이 쌓여도 아무도 몰랐다. 실제로 그 공백 때문에 사고가 났다 —
 * --shadow-md · --surface-sunken · --z-sidebar 가 지금은 실재하는데, CLAUDE.md 의 과거 사고 기록만
 * 읽은 세션이 "존재하지 않는 토큰"으로 오독해 워커들에게 멀쩡한 토큰을 쓰지 말라고 지시한 일이 있었다.
 * 사람이 추측하지 않고 게이트가 판정하게 만드는 것이 아래 4번 섹션의 목적이다.
 *
 * 오탐 조사 중 이 파일 자체의 버그도 하나 발견했다: 원래 CSS_DEF_RE는 원문(주석 포함) 그대로,
 * 단어 경계 없이 스캔해서 `.icon-btn--static:hover{` 같은 BEM 수식자+가상클래스 셀렉터를
 * "--static:" 커스텀 프로퍼티 선언으로 오인식했다(실존하지 않는 유령 토큰 — --sm/--hint/--primary
 * 도 같은 부류로 canvas-*.css/GraphTab.css 에서 발견됨). 정방향 검사에는 무해했지만(정의 집합이
 * 부풀 뿐, var(--static) 같은 실사용이 없으니 아무것도 못 잡던 건 아니었음) 역방향 검사에는 그대로
 * "유령이 안 쓰이니 죽었다"는 헛소리를 냈을 것이다. 부정 후방탐색으로 고쳤다 — 아래 1번 섹션 참고.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";

function walk(dir, exts, { includeTests = false } = {}, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) walk(p, exts, { includeTests }, out);
    else if (exts.some((ext) => name.endsWith(ext)) && (includeTests || !/\.test\.(tsx|ts)$/.test(name)))
      out.push(p);
  }
  return out;
}

// 주석을 공백으로 지우되 개행은 보존한다. (개행까지 공백으로 바꾸면 줄 번호가 밀려
// 리포트가 엉뚱한 줄을 가리킨다 — 실제로 그랬다.)
const blank = (m) => m.replace(/[^\n]/g, " ");

function stripComments(text, isCss) {
  if (isCss) {
    return text.replace(/\/\*[\s\S]*?\*\//g, blank);
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// 1. CSS 파일에서 정의된 커스텀 프로퍼티 수집 (--name: ...)
// 부정 후방탐색 (?<![\w-]): "--" 바로 앞이 식별자 문자(글자/숫자/하이픈)면 매치하지 않는다 —
// `.icon-btn--static:hover{` 처럼 BEM 수식자 클래스명 뒤에 가상클래스 콜론이 붙은 경우, 클래스명의
// "--static" 부분이 "--static:" 패턴에 우연히 일치해 존재하지 않는 커스텀 프로퍼티로 오인식되던
// 버그를 막는다(파일 상단 2026-08-30 노트 참고). 주석도 strip 후 스캔한다 — 안 그러면 토큰을
// *설명하는* 주석 문장이 실제 선언으로 잡혀, 리포트가 코드가 아니라 주석 줄을 가리키게 된다.
const CSS_DEF_RE = /(?<![\w-])(--[a-zA-Z0-9_-]+)\s*:/g;
const defined = new Set();
// varName -> [{file, line, snippet}, ...] 실제 선언 위치 전부(:root 와 라이트 테마 오버라이드처럼
// 같은 이름이 두 곳에 재정의되는 경우가 있어 첫 위치만 남기면 나머지가 청소 대상에서 빠진다).
const cssDefLocations = new Map();

for (const file of walk(SRC, [".css"])) {
  const rawText = readFileSync(file, "utf8");
  const strippedText = stripComments(rawText, true);
  const lines = strippedText.split("\n");
  const rawLines = rawText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    let m;
    CSS_DEF_RE.lastIndex = 0;
    while ((m = CSS_DEF_RE.exec(lines[i]))) {
      const varName = m[1];
      defined.add(varName);
      if (!cssDefLocations.has(varName)) cssDefLocations.set(varName, []);
      cssDefLocations.get(varName).push({ file, line: i + 1, snippet: rawLines[i].trim() });
    }
  }
}

// 2. TSX/TS 파일에서 인라인 style 또는 setProperty 로 주입되는 커스텀 프로퍼티 수집
// e.g. setProperty("--foo", ...) / "--foo": ... / style={{ ["--foo" as string]: ... }}
// 계산된 키 형태(["--foo" as string]:)를 빠뜨리면 정당한 런타임 변수가 미정의로 잡힌다 —
// --ai-glow-stagger · --pet-sheet-end 가 실제로 그랬다.
const JS_DEF_RE =
  /(?:setProperty\(\s*["'](--[a-zA-Z0-9_-]+)["']|["'](--[a-zA-Z0-9_-]+)["']\s*(?:as\s+\w+\s*)?\]?\s*:)/g;

for (const file of walk(SRC, [".tsx", ".ts"])) {
  const text = readFileSync(file, "utf8");
  let m;
  while ((m = JS_DEF_RE.exec(text))) {
    defined.add(m[1] || m[2]);
  }
}

// 런타임 동적 prefix 허용 목록 (예: --on-sky-*, --sky-*)
const ALLOWED_PREFIXES = ["--on-sky", "--sky-"];

function isDefined(varName) {
  if (defined.has(varName)) return true;
  if (ALLOWED_PREFIXES.some((p) => varName.startsWith(p))) return true;
  return false;
}

// 3. 사용처(var(--name)) 스캔
// var(--foo) / var(--foo, fallback) / var(--foo, var(--bar)) 를 모두 잡는다.
// 닫는 괄호를 매칭하지 않으므로 중첩된 폴백 안의 토큰도 빠짐없이 검사된다.
const VAR_USAGE_RE = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

const errors = [];
// 역방향 검사(4번)용: var()로 실제 읽힌 이름 전부(미정의 오사용 포함 — 오사용도 "그 이름을 쓰려는
// 시도"이므로 죽었다고 보면 안 된다. 어차피 미정의는 위 errors 가 별도로 잡는다).
const usedViaVar = new Set();

for (const file of walk(SRC, [".tsx", ".ts", ".css"])) {
  const rawText = readFileSync(file, "utf8");
  const strippedText = stripComments(rawText, file.endsWith(".css"));
  const lines = strippedText.split("\n");
  const rawLines = rawText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    VAR_USAGE_RE.lastIndex = 0;
    while ((m = VAR_USAGE_RE.exec(line))) {
      const varName = m[1];
      usedViaVar.add(varName);

      if (!isDefined(varName)) {
        errors.push({
          file,
          line: i + 1,
          varName,
          snippet: rawLines[i].trim(),
        });
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 4. 역방향 검사 — 정의됐지만 아무도 var() 로 읽지 않는 변수 (2026-08-30 W16)
//
// 스캔 범위: CSS 파일에서 `--name: value;` 형태로 정의된 커스텀 프로퍼티만 대상으로 한다
// (JS_DEF_RE 가 수집하는 런타임 주입 변수는 대상 밖 — 그 정규식은 TS 타입 표기 등과 겹쳐 잡음이
// 많고, 애초에 "값을 매 순간 새로 주입한다"는 것 자체가 어딘가에서 읽는다는 전제라 죽었는지
// 판단하기 애매하다. 죽었다면 그건 별도 조사거리다).
//
// "읽었다"로 인정하는 경로 둘:
//   (a) var(--name, ...) — CSS/TSX/TS(테스트 제외) 전체, 위 3번 스캔이 이미 수집(usedViaVar).
//   (b) getPropertyValue("--name") — TSX/TS, **테스트 파일 포함**. 값을 var() 없이 JS 에서 직접
//       읽는 경우가 실제로 있다(WorldMapGL.tsx, diagram/*.ts). 테스트를 포함하는 이유는 안전망 —
//       놓치면 "죽었다"고 오판해 실제로 쓰이는 토큰을 지우게 된다. 반대로 포함해서 놓치는 진짜
//       죽은 토큰은 없다(과잉 허용이지 과소 검출이 아니다).
// setProperty(JS_DEF_RE) 는 "쓰기"이지 "읽기"가 아니므로 이 인정 목록에 넣지 않는다 — 아무도
// 읽지 않는 값을 아무리 정성껏 써봐야 죽은 코드다.
//
// 예외(allowlist) — 항목마다 검증 가능한 이유를 한 줄로 남긴다. "귀찮아서"는 이유가 아니다.
const REVERSE_CHECK_ALLOWED_PREFIXES = [
  {
    prefix: "--xy-",
    // React Flow(@xyflow/react)가 자기 stylesheet(node_modules/@xyflow/react/dist/*.css)에서
    // 내부적으로 읽는 테마 변수 — 우리 CSS/TS 에는 절대 var(--xy-...) 형태로 나타나지 않는다.
    // 우리는 --xy-* 를 재정의해서 라이브러리 기본 테마 값을 우리 토큰(--divider/--accent 등)으로
    // 덮어쓸 뿐, 소비는 라이브러리 쪽 스타일시트가 한다. 실측(2026-08-30): tokens.css 14개 +
    // src/plugins/canvas/canvas-toolbar.css 5개 = 19개 전부 이 패턴 — canvas 쪽도 같은 라이브러리
    // 인스턴스라 같은 이유로 예외.
    reason: "React Flow(@xyflow/react)가 자기 CSS에서 내부적으로 읽는 테마 변수 — 우리 코드는 재정의만 한다",
  },
];

const JS_READ_RE = /getPropertyValue\(\s*["'](--[a-zA-Z0-9_-]+)["']/g;
const usedViaJsRead = new Set();
for (const file of walk(SRC, [".tsx", ".ts"], { includeTests: true })) {
  const text = readFileSync(file, "utf8");
  let m;
  while ((m = JS_READ_RE.exec(text))) usedViaJsRead.add(m[1]);
}

function isReverseCheckAllowed(varName) {
  return REVERSE_CHECK_ALLOWED_PREFIXES.some((entry) => varName.startsWith(entry.prefix));
}

const deadVars = [];
for (const [varName, locations] of cssDefLocations) {
  if (usedViaVar.has(varName)) continue;
  if (usedViaJsRead.has(varName)) continue;
  if (isReverseCheckAllowed(varName)) continue;
  for (const loc of locations) deadVars.push({ varName, ...loc });
}
deadVars.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// ════════════════════════════════════════════════════════════════════════════

let failed = false;

if (errors.length > 0) {
  failed = true;
  console.error(`\ncheck-css-vars: FAILED — ${errors.length} undefined CSS variable usages found:\n`);
  for (const err of errors) {
    console.error(`  ${err.file}:${err.line} -> ${err.varName}`);
    console.error(`    ${err.snippet}`);
  }
  console.error(
    "\n토큰을 tokens.css 에 정의하거나 오타를 고쳐라. **폴백을 다는 것은 해결이 아니다** —\n" +
      "폴백이 있으면 그 리터럴이 실제로 그려지고, 두 테마 중 한쪽에서 반드시 어긋난다.\n" +
      "런타임에 주입하는 변수라면 style={{ \"--foo\": … }} / setProperty(\"--foo\", …) 형태여야 수집된다.\n",
  );
}

if (deadVars.length > 0) {
  failed = true;
  console.error(`\ncheck-css-vars: FAILED — ${deadVars.length} defined-but-unused CSS variable declarations found:\n`);
  for (const dv of deadVars) {
    console.error(`  ${dv.file}:${dv.line} -> ${dv.varName}`);
    console.error(`    ${dv.snippet}`);
  }
  console.error(
    "\n아무도 var() 나 getPropertyValue() 로 읽지 않는 선언이다. 지우거나, 실제로 라이브러리가\n" +
      "읽는 값이라면(React Flow 의 --xy-* 처럼) 이 파일의 REVERSE_CHECK_ALLOWED_PREFIXES 에\n" +
      "검증 가능한 이유와 함께 추가해라 — \"나중에 쓸 것 같아서\"는 이유가 아니다.\n",
  );
}

if (failed) {
  process.exit(1);
} else {
  console.log(
    `check-css-vars: OK — all CSS variables are defined (scanned ${defined.size} defined tokens) ` +
      `and all ${cssDefLocations.size} CSS-declared custom properties are read somewhere.`,
  );
}
