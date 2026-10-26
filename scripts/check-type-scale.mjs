#!/usr/bin/env node
/**
 * TYPE & SPACE SCALE GUARD — 타이포 및 간격 스케일 계약 드리프트 검사 (W2 래칫 게이트).
 *
 * 검사 대상 (src/**\/*.{tsx,ts,css}):
 *   ⓐ font-size: <n>px 생값 금지 (src/**\/*.css) — var(--text-*), var(--font-*) 사용 강제
 *   ⓑ fontSize: <숫자 또는 "npx"> 인라인 금지 (src/**\/*.{tsx,ts}) — var(--text-*) 사용 강제
 *   ⓒ font-weight/fontWeight 는 400·600·inherit 만 허용 (W1 굵기 2단 사다리 준수)
 *   ⓓ padding, margin, gap (및 paddingTop, marginLeft 등)의 px 리터럴은
 *      --space 사다리 값(0, 4px, 6px, 8px, 10px, 12px, 14px, 18px, 22px)만 허용
 *   ⓔ z-index/zIndex 는 var(--z-*) 만 허용 (지역 스태킹용 0~3 및 auto/inherit/initial/unset 예외)
 *   ⓕ transition/transitionDuration 의 duration 은 var(--dur-*) 만 허용 (0s/0ms/none/inherit 예외)
 *   ⓖ border-radius/borderRadius 는 라운드 사다리(0, 4, 6, 10, 16, 999px)만 허용 —
 *      docs/DESIGN.md "라운드(r) 사다리(W24)" 문서화 규칙에 게이트가 없던 것을 여기에 합류시킴.
 *      50%(원)와 1–3px(장식 요소 미세 라운드, 문서가 명시적으로 허용한 바닥)는 리터럴로 허용.
 *
 * 의도적 면제:
 *   해당 줄 또는 바로 윗줄에 `/* type-scale-exempt: <이유> *\/` (또는 `// type-scale-exempt: <이유>`)
 *   주석이 있으면 해당 줄의 위반을 건너뜁니다 (이유 없는 exempt 는 실패 처리).
 *
 * 래칫 메커니즘:
 *   - scripts/check-type-scale.allow.json 에 파일별 위반 개수를 베이스라인으로 저장합니다.
 *   - 실제 위반 수 > allowlist 값 → 실패 (신규 위반 유입 차단)
 *   - 실제 위반 수 < allowlist 값 → 실패 및 allowlist 축소 요구 (이행 웨이브의 allowlist 동기화 강제)
 *   - allowlist 에 없는 파일에서 위반 발생 → 실패
 *
 * 베이스라인 갱신:
 *   node scripts/check-type-scale.mjs --update
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const BASELINE = "scripts/check-type-scale.allow.json";

// ── 사다리 토큰 허용값 ────────────────────────────────────────────────────────
const SPACE_LADDER = new Set([0, 4, 6, 8, 10, 12, 14, 18, 22]);
const ALLOWED_WEIGHTS = new Set(["400", "600", "inherit"]);
const ALLOWED_Z_KEYWORDS = new Set(["0", "1", "2", "3", "auto", "inherit", "initial", "unset"]);
// docs/DESIGN.md "라운드(r) 사다리(W24)" — xs 4 / sm 6 / md 10 / lg 16 / pill 999.
// 1–3px 는 ~10px 이하 장식 요소용으로 문서가 명시적으로 허용한 리터럴 바닥이라 사다리에 함께 둔다.
const RADIUS_LADDER = new Set([0, 1, 2, 3, 4, 6, 10, 16, 999]);

// ── 파일 탐색 ────────────────────────────────────────────────────────────────
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(p);
  }
  return out;
}

// ── 주석 제거 (줄 번호 보존을 위해 개행은 유지하고 공백으로 치환) ───────────
const blank = (m) => m.replace(/[^\n]/g, " ");

function stripComments(text, isCss) {
  if (isCss) {
    return text.replace(/\/\*[\s\S]*?\*\//g, blank);
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// ── 면제 주석 검사 ───────────────────────────────────────────────────────────
// 반환값: { exemptLines: Set<number>, invalidExemptions: Array<{line: number, snippet: string}> }
function parseExemptions(rawLines) {
  const exemptLines = new Set();
  const invalidExemptions = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.includes("type-scale-exempt")) continue;

    // type-scale-exempt 뒤 이유 확인
    const idx = line.indexOf("type-scale-exempt");
    const after = line.slice(idx + "type-scale-exempt".length)
      .replace(/\*\/|\/\*|\{|\}|\/\//g, "")
      .trim();

    if (after.startsWith(":")) {
      const reason = after.slice(1).trim();
      if (reason.length > 0) {
        // 유효한 면제: 현재 줄(i+1) 및 바로 아랫줄(i+2) 면제 처리
        exemptLines.add(i + 1);
        exemptLines.add(i + 2);
        continue;
      }
    }

    invalidExemptions.push({
      line: i + 1,
      snippet: line.trim(),
    });
  }

  return { exemptLines, invalidExemptions };
}

// ── ⓓ 간격 값 검사 헬퍼 ──────────────────────────────────────────────────────
function checkSpacingValue(valStr, isTsx) {
  const violations = [];

  // 삼항 연산자 분기 처리: cond ? branch1 : branch2
  if (valStr.includes("?")) {
    const qIdx = valStr.indexOf("?");
    const branches = valStr.slice(qIdx + 1);
    const colonIdx = branches.indexOf(":");
    if (colonIdx !== -1) {
      const b1 = branches.slice(0, colonIdx).trim();
      const b2 = branches.slice(colonIdx + 1).trim();
      return [...checkSpacingValue(b1, isTsx), ...checkSpacingValue(b2, isTsx)];
    }
  }

  // 1. px 단위 리터럴 검사 (예: 13px, 5px, 26px, -5.5px)
  const pxRe = /(?<![\w-])(-?\d+(?:\.\d+)?)\s*px\b/gi;
  let m;
  while ((m = pxRe.exec(valStr)) !== null) {
    const num = Math.abs(parseFloat(m[1]));
    if (!SPACE_LADDER.has(num)) {
      violations.push(`px 리터럴 ${m[1]}px 는 --space 사다리 값 외 생값입니다`);
    }
  }

  // 2. TSX 인라인 스타일에서 따옴표 없는 숫자 리터럴 검사 (예: gap: 3, marginTop: 2, padding: 5)
  if (isTsx) {
    const trimmed = valStr.trim();
    if (!trimmed.startsWith('"') && !trimmed.startsWith("'") && !trimmed.startsWith("`")) {
      const numRe = /(?<![\w$])(-?\d+(?:\.\d+)?)(?![\w$])/g;
      let nm;
      while ((nm = numRe.exec(trimmed)) !== null) {
        const num = Math.abs(parseFloat(nm[1]));
        if (!SPACE_LADDER.has(num)) {
          violations.push(`숫자 ${nm[1]} 은 --space 사다리 값 외 생값입니다`);
        }
      }
    }
  }

  return violations;
}

// ── ⓖ border-radius 값 검사 헬퍼 ────────────────────────────────────────────
function checkRadiusValue(valStr, isTsx) {
  const violations = [];

  // 삼항 연산자 분기 처리 (checkSpacingValue 와 동일한 이유)
  if (valStr.includes("?")) {
    const qIdx = valStr.indexOf("?");
    const branches = valStr.slice(qIdx + 1);
    const colonIdx = branches.indexOf(":");
    if (colonIdx !== -1) {
      const b1 = branches.slice(0, colonIdx).trim();
      const b2 = branches.slice(colonIdx + 1).trim();
      return [...checkRadiusValue(b1, isTsx), ...checkRadiusValue(b2, isTsx)];
    }
  }

  // 50%(원)는 사다리 밖 문서 허용값 — 퍼센트 값은 통째로 면제
  if (valStr.includes("%")) return violations;

  // 1. px 단위 리터럴 검사 (border-radius 는 shorthand 로 코너별 값을 공백으로 늘어놓을 수 있어
  //    값 전체에서 px 붙은 숫자를 전부 훑는다 — 예: "var(--radius-md) 0 0 0")
  const pxRe = /(?<![\w-])(-?\d+(?:\.\d+)?)\s*px\b/gi;
  let m;
  while ((m = pxRe.exec(valStr)) !== null) {
    const num = Math.abs(parseFloat(m[1]));
    if (!RADIUS_LADDER.has(num)) {
      violations.push(`px 리터럴 ${m[1]}px 는 라운드 사다리(0/4/6/10/16/999) 밖의 생값입니다`);
    }
  }

  // 2. TSX 인라인 스타일에서 따옴표 없는 숫자 리터럴 검사 (예: borderRadius: 8)
  if (isTsx) {
    const trimmed = valStr.trim();
    if (!trimmed.startsWith('"') && !trimmed.startsWith("'") && !trimmed.startsWith("`")) {
      const numRe = /(?<![\w$])(-?\d+(?:\.\d+)?)(?![\w$])/g;
      let nm;
      while ((nm = numRe.exec(trimmed)) !== null) {
        const num = Math.abs(parseFloat(nm[1]));
        if (!RADIUS_LADDER.has(num)) {
          violations.push(`숫자 ${nm[1]} 은 라운드 사다리(0/4/6/10/16/999) 밖의 생값입니다`);
        }
      }
    }
  }

  return violations;
}

// ── ⓕ transition duration 검사 헬퍼 ─────────────────────────────────────────
function checkTransitionDuration(valStr) {
  const violations = [];
  const durRe = /(?<![\w-])(\d+(?:\.\d+)?|\.\d+)(s|ms)\b/gi;
  let m;
  while ((m = durRe.exec(valStr)) !== null) {
    const rawNum = m[1];
    const num = parseFloat(rawNum);
    if (num !== 0) {
      violations.push(`duration 생값 ${m[0]} 대신 var(--dur-*) 토큰을 사용해야 합니다`);
    }
  }
  return violations;
}

// ── 파일 단위 위반 수집 ───────────────────────────────────────────────────────
function scanFile(file) {
  const isCss = file.endsWith(".css");
  const isTsx = file.endsWith(".tsx") || file.endsWith(".ts");
  const rawText = readFileSync(file, "utf8");
  const rawLines = rawText.split("\n");
  const { exemptLines, invalidExemptions } = parseExemptions(rawLines);

  const strippedText = stripComments(rawText, isCss);
  const lines = strippedText.split("\n");
  const violations = [];

  // 잘못된 면제 주석(이유 없음) 등록
  for (const inv of invalidExemptions) {
    violations.push({
      file,
      line: inv.line,
      rule: "exempt-reason-required",
      snippet: inv.snippet,
      message: "type-scale-exempt 주석에는 반드시 구체적인 면제 이유가 명시되어야 합니다",
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    if (exemptLines.has(lineNum)) continue;

    const line = lines[i];
    const rawLine = rawLines[i];

    // ── ⓐ font-size: <n>px 생값 금지 (src/**/*.css) ──────────────────────────
    if (isCss) {
      const fsCssRe = /(?<![\w-])font-size\s*:\s*([^;}\n]+)/gi;
      let m;
      while ((m = fsCssRe.exec(line)) !== null) {
        const val = m[1].trim();
        // calc(...*var(--fs)) 또는 var(--...) 형태는 허용
        if (val.includes("var(--") || (val.includes("calc(") && val.includes("--fs"))) {
          continue;
        }
        if (/\b\d+(?:\.\d+)?px\b/i.test(val)) {
          violations.push({
            file,
            line: lineNum,
            rule: "a-font-size-css-px",
            snippet: rawLine.trim(),
            message: `font-size 생값 "${val}" 금지 — var(--text-*) 또는 var(--font-*) 사용 필요`,
          });
        }
      }
    }

    // ── ⓑ fontSize: <숫자 또는 "npx"> 인라인 금지 (src/**/*.tsx) ────────────
    if (isTsx) {
      const fsTsxRe = /(?<![\w$])fontSize\s*:\s*([^,}\n]+)/g;
      let m;
      while ((m = fsTsxRe.exec(line)) !== null) {
        const val = m[1].trim();
        // 허용: var(--text-*), inherit, 0.85em, 100%, calc(12px*var(--fs)), undefined, null 등
        if (
          val.includes("var(--") ||
          val.includes("inherit") ||
          /["']\s*\d+(?:\.\d+)?(?:em|rem|%)\s*["']/i.test(val) ||
          (val.includes("calc(") && val.includes("--fs")) ||
          val === "undefined" ||
          val === "null"
        ) {
          continue;
        }
        // 위반: 숫자 리터럴(12, 10.5, 9 / k 등) 또는 "npx" 문자열
        if (
          /^\d+(?:\.\d+)?/i.test(val) ||
          /^["'`]\s*\d+(?:\.\d+)?px/i.test(val)
        ) {
          violations.push({
            file,
            line: lineNum,
            rule: "b-font-size-tsx-inline",
            snippet: rawLine.trim(),
            message: `인라인 fontSize "${val}" 금지 — var(--text-*) 사용 필요`,
          });
        }
      }
    }

    // ── ⓒ font-weight / fontWeight: 400·600·inherit 만 허용 ───────────────────
    const fwRe = isCss
      ? /(?<![\w-])font-weight\s*:\s*([^;}\n]+)/gi
      : /(?<![\w$])fontWeight\s*:\s*([^,}\n]+)/g;
    let fwm;
    while ((fwm = fwRe.exec(line)) !== null) {
      const val = fwm[1]
        .trim()
        .replace(/!important/g, "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
      if (!ALLOWED_WEIGHTS.has(val) && !val.includes("var(--")) {
        violations.push({
          file,
          line: lineNum,
          rule: "c-font-weight-invalid",
          snippet: rawLine.trim(),
          message: `font-weight "${val}" 금지 — 400, 600, inherit 만 허용됩니다`,
        });
      }
    }

    // ── ⓓ padding, margin, gap px 리터럴은 --space 사다리 값만 허용 ───────────
    const spaceRe = isCss
      ? /(?<![\w-])(padding(?:-(?:top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-end))?|margin(?:-(?:top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-end))?|gap|row-gap|column-gap)\s*:\s*([^;}\n]+)/gi
      : /(?<![\w$])(padding(?:Top|Right|Bottom|Left|Inline|InlineStart|InlineEnd|Block|BlockStart|BlockEnd)?|margin(?:Top|Right|Bottom|Left|Inline|InlineStart|InlineEnd|Block|BlockStart|BlockEnd)?|gap|rowGap|columnGap)\s*:\s*([^,}\n]+)/g;
    let spm;
    while ((spm = spaceRe.exec(line)) !== null) {
      const prop = spm[1];
      const val = spm[2].trim();
      const spViolations = checkSpacingValue(val, isTsx);
      for (const msg of spViolations) {
        violations.push({
          file,
          line: lineNum,
          rule: "d-space-ladder-raw-px",
          snippet: rawLine.trim(),
          message: `${prop}: "${val}" — ${msg}`,
        });
      }
    }

    // ── ⓔ z-index / zIndex: var(--z-*) 만 허용 (0~3, auto/inherit 예외) ───────
    const zRe = isCss
      ? /(?<![\w-])z-index\s*:\s*([^;}\n]+)/gi
      : /(?<![\w$])zIndex\s*:\s*([^,}\n]+)/g;
    let zm;
    while ((zm = zRe.exec(line)) !== null) {
      const val = zm[1]
        .trim()
        .replace(/!important/g, "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
      const isAllowed =
        val.includes("var(--z-") ||
        ALLOWED_Z_KEYWORDS.has(val);
      if (!isAllowed) {
        violations.push({
          file,
          line: lineNum,
          rule: "e-zindex-token-required",
          snippet: rawLine.trim(),
          message: `z-index "${val}" 금지 — var(--z-*) 토큰 또는 지역 스태킹(0~3, auto/inherit)만 허용`,
        });
      }
    }

    // ── ⓕ transition / transitionDuration duration: var(--dur-*) 만 허용 ─────
    const trRe = isCss
      ? /(?<![\w-])(?:transition|transition-duration)\s*:\s*([^;}\n]+)/gi
      : /(?<![\w$])(?:transition|transitionDuration)\s*:\s*([^,}\n]+)/g;
    let trm;
    while ((trm = trRe.exec(line)) !== null) {
      const val = trm[1].trim();
      // transitionDuration: 150 (TSX ms 숫자) 검사
      if (isTsx && /(?<![\w$])transitionDuration\s*:/.test(line)) {
        const numVal = parseFloat(val);
        if (!isNaN(numVal) && numVal > 0) {
          violations.push({
            file,
            line: lineNum,
            rule: "f-transition-dur-token-required",
            snippet: rawLine.trim(),
            message: `transitionDuration "${val}" 금지 — var(--dur-*) 토큰을 사용해야 합니다`,
          });
          continue;
        }
      }
      const durViolations = checkTransitionDuration(val);
      for (const msg of durViolations) {
        violations.push({
          file,
          line: lineNum,
          rule: "f-transition-dur-token-required",
          snippet: rawLine.trim(),
          message: msg,
        });
      }
    }

    // ── ⓖ border-radius / borderRadius: 라운드 사다리(0/4/6/10/16/999, 50%)만 허용 ──
    const radiusRe = isCss
      ? /(?<![\w-])border-radius\s*:\s*([^;}\n]+)/gi
      : /(?<![\w$])borderRadius\s*:\s*([^,}\n]+)/g;
    let rm;
    while ((rm = radiusRe.exec(line)) !== null) {
      const val = rm[1].trim();
      const rViolations = checkRadiusValue(val, isTsx);
      for (const msg of rViolations) {
        violations.push({
          file,
          line: lineNum,
          rule: "g-radius-ladder-raw-px",
          snippet: rawLine.trim(),
          message: `border-radius: "${val}" — ${msg}`,
        });
      }
    }
  }

  return violations;
}

// ── 전체 검사 실행 ───────────────────────────────────────────────────────────
const allFiles = walk(SRC, [".tsx", ".ts", ".css"]);
const currentViolations = new Map(); // file -> Array<violation>
let totalViolationsCount = 0;

for (const file of allFiles) {
  const violations = scanFile(file);
  if (violations.length > 0) {
    currentViolations.set(file, violations);
    totalViolationsCount += violations.length;
  }
}

// ── 베이스라인 갱신 (--update) ───────────────────────────────────────────────
// 래칫은 **한 방향으로만** 움직인다. --update 는 줄어든 값만 반영하고, 늘어난 값이나 새 파일이
// 있으면 거부한다 — 그게 없으면 누구든 --update 한 번으로 새 위반을 베이스라인에 세탁해 넣을 수
// 있고, 게이트는 초록인 채 아무것도 지키지 않게 된다(이 저장소에 그 사고 전례가 있다).
// 정말로 상한을 올려야 하면 JSON 을 손으로 고쳐라 — 그건 diff 에 남아 리뷰가 본다.
if (process.argv.includes("--update")) {
  const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  const baselineObj = {};
  // 파일명을 알파벳 순으로 정렬하여 저장
  const sortedFiles = [...currentViolations.keys()].sort();
  for (const file of sortedFiles) {
    baselineObj[file] = currentViolations.get(file).length;
  }

  if (prev) {
    const raised = sortedFiles
      .map((file) => ({ file, next: baselineObj[file], prevCount: prev[file] ?? 0 }))
      .filter((r) => r.next > r.prevCount);
    if (raised.length > 0) {
      console.error("check-type-scale: --update 는 베이스라인을 올릴 수 없습니다 (래칫은 단방향).");
      for (const r of raised) {
        console.error(`  - ${r.file}: ${r.prevCount} -> ${r.next} (+${r.next - r.prevCount})`);
      }
      console.error("\n먼저 위반을 고치세요. `node scripts/check-type-scale.mjs` 가 위치와 이유를 알려줍니다.");
      console.error("정당한 예외라면 `/* type-scale-exempt: <이유> */` 주석을 쓰거나, 상한 인상이");
      console.error(`정말 필요하면 ${BASELINE} 을 손으로 고쳐 리뷰에 남기세요.`);
      process.exit(1);
    }
  }

  writeFileSync(BASELINE, JSON.stringify(baselineObj, null, 2) + "\n");
  console.log(
    `check-type-scale: 베이스라인 갱신 완료 — ${sortedFiles.length}개 파일에서 위반 ${totalViolationsCount}건 기록.`
  );
  process.exit(0);
}

// ── 베이스라인 존재 여부 검사 ─────────────────────────────────────────────────
if (!existsSync(BASELINE)) {
  console.error(`check-type-scale: 베이스라인이 없습니다 (${BASELINE}).`);
  console.error("먼저 `node scripts/check-type-scale.mjs --update` 로 베이스라인을 생성하세요.");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
let failed = false;

// ── 래칫 검사 ─────────────────────────────────────────────────────────────────
// 1. 신규 위반 또는 증가한 파일 검사
const increasedFiles = [];
for (const [file, violations] of currentViolations.entries()) {
  const count = violations.length;
  const allowed = baseline[file] ?? 0;
  if (count > allowed) {
    increasedFiles.push({ file, count, allowed, violations });
  }
}

if (increasedFiles.length > 0) {
  failed = true;
  console.error("check-type-scale: 새로운 타이포/간격 스케일 위반이 감지되었습니다 (래칫 위반).");
  for (const item of increasedFiles) {
    console.error(`\n  [${item.file}] 허용: ${item.allowed}건 -> 실제: ${item.count}건 (+${item.count - item.allowed})`);
    for (const v of item.violations) {
      console.error(`    - L${v.line} (${v.rule}): ${v.message}`);
      console.error(`      \`${v.snippet}\``);
    }
  }
  console.error(
    "\n스케일 규칙을 준수하도록 코드를 수정하거나, 정당한 예외인 경우 `/* type-scale-exempt: <이유> */` 주석을 추가하세요."
  );
}

// 2. 위반이 줄어든 파일 검사 (래칫: 베이스라인도 함께 줄이도록 강제)
const decreasedFiles = [];
for (const [file, allowed] of Object.entries(baseline)) {
  const actual = currentViolations.get(file)?.length ?? 0;
  if (actual < allowed) {
    decreasedFiles.push({ file, allowed, actual });
  }
}

if (decreasedFiles.length > 0) {
  failed = true;
  console.error("\ncheck-type-scale: 스케일 위반이 정리되어 허용치(allowlist)가 실제보다 큽니다.");
  console.error("래칫 규칙에 따라 베이스라인을 함께 줄여야 합니다.");
  for (const item of decreasedFiles) {
    console.error(`  - ${item.file}: 허용치 ${item.allowed} -> 실제 ${item.actual} (allowlist 를 ${item.actual} 로 줄이거나 --update 실행)`);
  }
  console.error("\n`node scripts/check-type-scale.mjs --update` 를 실행하여 베이스라인을 갱신하세요.");
}

// 3. 치명적 면제 주석 에러(이유 누락)가 있는지 확인
const allViolationsList = [...currentViolations.values()].flat();
const invalidExemptErrors = allViolationsList.filter((v) => v.rule === "exempt-reason-required");
if (invalidExemptErrors.length > 0) {
  failed = true;
  console.error("\ncheck-type-scale: 이유가 없는 type-scale-exempt 주석이 있습니다.");
  for (const v of invalidExemptErrors) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet}\``);
  }
}

if (failed) {
  process.exit(1);
}

console.log(
  `check-type-scale: OK — 스케일 위반 ${totalViolationsCount}건(베이스라인 이내), ` +
    "font-weight 400/600 규약 준수, 새 생값 유입 없음, 래칫 동기화 완료."
);
