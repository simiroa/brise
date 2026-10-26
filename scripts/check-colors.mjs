#!/usr/bin/env node
/**
 * COLOR LITERAL GUARD — 토큰을 거치지 않은 하드코딩 색 리터럴 래칫
 * (docs/PLAN-2026-09-12-settings-overhaul-waves.md §7).
 *
 * 왜 지금인가: 강조색이 녹색 원툴이 아니게 되고(§4 hue 개방) 구분선이 중성화되면(§6), 코드에
 * 박아 둔 생파랑(`#3b82f6`)·생흰색(`#fff`) 같은 리터럴이 테마를 따라오지 못해 눈에 띄게 튄다.
 * 색은 토큰(`src/styles/tokens.css`)이 소유하고, 코드는 `var(--...)` 로만 가리킨다.
 *
 * 검사 대상: src 아래 .tsx/.ts/.css — 테스트 파일(`*.test.ts(x)`)과 테스트 하네스(`src/test/`) 제외.
 * 탐지: hex 리터럴(`#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`) · `rgb(`/`rgba(`/`hsl(`/`hsla(`.
 * (`index.html` 은 src 밖이라 스캔하지 않는다 — 첫 페인트 부트 상수는
 *  `appearanceSeedDrift.test.ts` 가 이미 드리프트를 지킨다.)
 *
 * ── 면제는 파일 통째가 아니라 **사유와 함께** (아래 EXEMPT) ─────────────────────────────
 * 색 리터럴이 *테마가 아니라 데이터*인 곳이 있다: 토큰 정의처, 팔레트 생성기, 천문 색표,
 * 대비비를 검증해 둔 그래프 팔레트, 스프라이트 픽셀. "이 파일은 시끄러우니까"가 아니라
 * "이 파일에서 색은 테마가 아니다"만 면제 사유가 된다.
 *
 * ── 래칫 ───────────────────────────────────────────────────────────────────────────
 * scripts/check-colors.allow.json 에 **파일별** 현재 위반 수를 박고 **늘어나면 실패**한다.
 * 정리했으면 `node scripts/check-colors.mjs --update` 로 내린다. 래칫은 **단방향** —
 * --update 로 올릴 수 없다(그게 없으면 누구든 --update 한 번으로 새 위반을 세탁해 넣는다).
 * ⚠️ 파일 단위 래칫의 함정: 위반을 **다른 파일로 옮기면** 총계가 줄어도 목적지 파일이
 *    "허용 0건 → 실제 n건" 으로 실패한다. 옮긴 게 맞으면 --update 로 양쪽을 함께 갱신한다.
 *
 * ── 주석 스트리퍼의 한계 (정직하게) ───────────────────────────────────────────────────
 * `check:surface` 의 (b) 는 주석까지 스캔하는 쪽을 의도적으로 골랐지만, 그건 금지어가 10여
 * 개뿐이라 가능했던 트레이드오프다. 색은 주석에 정당하게 등장한다 — `diagramStyles.ts` 는
 * 대비비 검증 결과를 `#ffffff 8.14:1 PASS` 처럼 주석에 적어 둔다. 그래서 여기선 스트립한다.
 *
 * 스트리퍼는 **문자열을 인식하는 문자 스캐너**다(정규식 한 방이 아니다). 색은 대부분 문자열
 * 안에 있으므로(`style={{ color: "#fff" }}`) 문자열은 **지우지 않고 건너뛰기만** 한다 —
 * `"https://x"` 의 `//` 가 줄 나머지를 주석으로 먹어 **조용히 미탐**이 되는 것이 이 검사에서
 * 가장 위험한 실패다(오탐은 눈에 띄지만 미탐은 안 띈다). 남은 한계:
 *   1. **정규식 리터럴을 모른다.** `/\/\//` 처럼 소스에 `//` 가 붙어 있는 정규식이 있으면 그
 *      줄의 나머지가 주석으로 취급돼 미탐이 날 수 있다. 위반은 보통 다른 줄에 있으니 감수한다.
 *   2. **JSX 본문의 어퍼스트로피**(`don't`)는 문자열 시작으로 오인된다 — 줄 끝에서 끊으므로
 *      피해는 그 줄에 한정되고, 방향은 안전한 쪽(주석 속 hex 를 못 지워 **오탐**)이다.
 *   3. 템플릿 리터럴 안 `${}` 에 중첩된 백틱은 모른다.
 *   4. `url(#id)` 는 `(?<!url\(\s*)` 로만 걸러낸다 — CSS 의 그 형태가 전부라 충분하다.
 * 스트리퍼가 실코드를 먹는 회귀는 아래 selfTest() 가 잡는다(이 레포 관례 —
 * check-settings-keys.mjs, check-surface-contract.mjs (h)).
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const BASELINE = "scripts/check-colors.allow.json";

// 색이 **테마가 아니라 데이터**인 파일. 값은 사유다 — 사유 없는 면제는 추가하지 마라.
const EXEMPT = {
  "src/styles/tokens.css": "토큰 정의처. 색 리터럴이 여기 말고 어디에 있나",
  "src/lib/appearance.ts": "CANVAS_BASE 등 토큰의 출처 — 여기서 tokens.css 로 흘러 나간다",
  "src/lib/accentPalette.ts": "§4 강조색 팔레트 생성 + DEFAULT_ACCENT — 색이 곧 이 모듈의 입출력",
  "src/lib/skyGradient.ts": "태양 고도별 하늘 색표 — 테마가 아니라 천문 데이터",
  "src/components/diagram/diagramStyles.ts": "대비비를 검증해 둔 그래프 팔레트",
  "src/plugins/pet/PetSprite.tsx": "스프라이트 색 — 도트 그림의 픽셀 값",
  "src/components/map/WorldMapGL.tsx": "MapLibre GL WebGL 캔버스 페인트 속성 — CSS var()를 읽지 못하는 WebGL 렌더러에 주입",
  // PLAN-2026-10-07-doc-import-export §4 — 내보내기 모달의 종이 미리보기는 srcdoc 로 따로 선 문서다. 앱의 :root 토큰을
  // 상속하지 않고, 어느 테마에서도 흰 종이·검은 글자여야 한다(한글/인쇄에서 열었을 때의 모습을 근사하는 것이 목적).
  "src/components/export/exportPaper.ts": "인쇄 종이 미리보기(srcdoc) — 흰 종이·검은 글자는 테마가 아니라 문서 쪽 데이터. 앱 테마를 따라가면 오히려 틀린다",
  // PLAN-2026-09-28-onboarding-rebuild.md §2 4/4 — QR 여백(quiet zone)은 스펙상 밝은 배경 위
  // 어두운 모듈이어야 스캐너가 읽는다. 테마가 아니라 QR 자체의 데이터 요구사항 — 같은 이유로
  // 이미 이 파일이 그대로 베낀 src/components/settings/SyncSection.tsx 의 brise-sync-qr 도
  // 동일한 흰 배경(다만 거기는 신규 파일이 아니라 베이스라인으로 잡혀 있다, allow.json 참고).
  "src/components/onboarding/OnboardingConnectStep.tsx": "QR 여백(quiet zone) 흰 배경 — 다크 테마에서도 스캔 가능해야 하는 QR 스펙 요구사항, 테마 색이 아니다(SyncSection.tsx의 brise-sync-qr과 동일 사유)",
};

// hex: 3/4/6/8 자리만. 뒤에 [\w-] 가 오면 hex 가 아니다(`#abcdefg`, `#fff-x`).
// 앞의 `&`/`#`/단어문자 배제는 HTML 엔티티(`&#123;`)와 `##` 를, `(?<!url\(\s*)` 는
// SVG 의 `url(#gradient-id)` 를 걸러낸다.
const HEX_RE =
  /(?<![\w&#-])(?<!url\(\s*)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;

// 함수형 표기. 앞 경계가 없으면 `toRgba(` `parseHsl(` 같은 식별자 꼬리에 걸린다.
const FUNC_RE = /(?<![\w-])(?:rgba?|hsla?)\s*\(/g;

// readdir 과 stat 사이에 사라지는 엔트리가 있다 — 에디터/포매터의 원자적 쓰기 임시 파일
// (`Foo.tsx.tmp.28536.f7367fb2`)이 그렇다. 실제로 이 게이트를 세우는 중에 옆 레인의 임시 파일을
// stat 하다 ENOENT 로 죽었다. 사라진 엔트리는 그냥 건너뛴다(확장자가 안 맞아 어차피 안 읽힌다).
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(p);
  }
  return out;
}

// 테스트 파일과 테스트 하네스는 제외 — 픽스처의 색은 화면에 칠해지지 않는다.
function isTestPath(p) {
  return /\.test\.tsx?$/.test(p) || p.startsWith("src/test/");
}

// 주석만 공백으로 덮는다(개행 보존 → 줄 번호가 원문과 같다). 문자열은 **건너뛰기만** 한다.
function stripComments(text, isCss) {
  const out = text.split("");
  const n = text.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || (!isCss && ch === "`")) {
      const quote = ch;
      i++;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        // 줄을 넘기는 홑/겹따옴표는 문자열이 아니라 오인이다(JSX 본문의 어퍼스트로피) — 끊는다.
        if (quote !== "`" && c === "\n") break;
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (!isCss && ch === "/" && text[i + 1] === "/") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

function scanText(text, isCss) {
  const code = stripComments(text, isCss);
  const rawLines = text.split("\n");
  const hits = [];
  for (const re of [HEX_RE, FUNC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      const line = code.slice(0, m.index).split("\n").length;
      hits.push({
        line,
        match: m[0],
        snippet: (rawLines[line - 1] ?? "").trim().replace(/\s+/g, " ").slice(0, 110),
      });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.match.localeCompare(b.match));
  return hits;
}

// ── 자기검사 ────────────────────────────────────────────────────────────────
// 이 탐지기의 위험한 실패는 오탐이 아니라 **미탐**이다 — 주석 스트리퍼가 실코드를 한 줄
// 먹어버리면 게이트는 조용히 아무것도 안 잡는다. scripts/ 에 테스트 파일을 두는 관례가 없으므로
// 검사를 여기 둔다: 통과하면 아무 것도 출력하지 않고, 깨지면 스캐너가 먼저 죽는다.
function selfTest() {
  const cases = [
    // ── 기본 탐지 ──
    ['const c = { color: "#ff0000" };', false, 1, "6자리 hex"],
    ['const c = "#abc";', false, 1, "3자리 hex"],
    ['const c = "#abcd";', false, 1, "4자리 hex(알파)"],
    ['const c = { background: "#11223344" };', false, 1, "8자리 hex"],
    ['boxShadow: "0 1px 2px rgba(0, 0, 0, .2)",', false, 1, "rgba()"],
    ['const c = "hsl(210 12% 40%)";', false, 1, "hsl()"],
    ['const c = "#fff", d = "#000";', false, 2, "한 줄에 둘"],
    ["const t = `linear-gradient(#fff, #000)`;", false, 2, "템플릿 리터럴 안의 hex"],

    // ── 주석은 스트립된다 ──
    ["// 대비 #ffffff 8.14:1 PASS", false, 0, "JS 줄 주석 속 hex"],
    ["/* 대비 #ffffff 8.14:1 PASS */", false, 0, "JS 블록 주석 속 hex"],
    ['/* #ffffff */\nconst c = "#fff";', false, 1, "주석 다음 줄의 실코드는 살아있다"],
    ["/* 8.14:1 PASS */\n.x { color: var(--fg); }", true, 0, "CSS 주석 속 대비비"],
    ["/* #ffffff PASS */\n.x { color: #fff; }", true, 1, "CSS 주석 뒤 실코드"],

    // ── 스트리퍼가 실코드를 먹으면 안 된다(미탐 방지) ──
    ['const u = "https://x/y"; const c = "#fff";', false, 1, "문자열 안의 // 는 주석이 아니다"],
    ['const s = "/*"; const c = "#fff";', false, 1, "문자열 안의 /* 는 주석이 아니다"],
    [".x { background: url(https://a/b.png); color: #fff; }", true, 1, "CSS url 의 //"],
    ['const c = "#fff"; // 여기부터 #000 은 주석', false, 1, "줄 뒤쪽만 주석"],

    // ── hex 가 아닌 # ──
    ['<circle fill="url(#gradient-id)" />', false, 0, "url(#id) — hex 아님"],
    ['<circle fill="url(#fade)" />', false, 0, "url(#fade) — hex 처럼 생긴 id"],
    [".x { fill: url(#grad); }", true, 0, "CSS url(#id)"],
    ['navigate("#/notes");', false, 0, "해시 라우트"],
    ['const e = "&#123;";', false, 0, "HTML 엔티티"],
    ['const c = "#abcdefg";', false, 0, "7자리는 hex 가 아니다"],
    ['const c = "#ff";', false, 0, "2자리는 hex 가 아니다"],

    // ── 함수 이름 꼬리 ──
    ["const toRgba = (v) => v;\ntoRgba(1);", false, 0, "rgba( 가 식별자 일부"],
    ['import { parseHsl } from "./x";\nparseHsl(1);', false, 0, "hsl( 가 식별자 일부"],
    ["const v = colorRgb(1);", false, 0, "rgb( 가 식별자 일부"],
  ];
  for (const [src, isCss, want, label] of cases) {
    const got = scanText(src, isCss).length;
    if (got !== want) {
      throw new Error(
        `check-colors selftest [${label}]: 기대 ${want} != 실제 ${got} — ${JSON.stringify(src)}`
      );
    }
  }
  // 줄 번호가 원문과 같아야 한다(주석을 지우되 개행은 보존).
  const lined = scanText('const a = 1;\n/* #000 */\nconst c = "#fff";', false);
  if (lined.length !== 1 || lined[0].line !== 3) {
    throw new Error(
      `check-colors selftest [줄 번호]: 기대 L3 1건 != 실제 ${JSON.stringify(lined)}`
    );
  }
}
selfTest();

// ── 수집 ────────────────────────────────────────────────────────────────────
function collect() {
  const counts = {};
  const details = {};
  for (const file of walk(SRC, [".tsx", ".ts", ".css"])) {
    if (isTestPath(file) || EXEMPT[file]) continue;
    const hits = scanText(readFileSync(file, "utf8"), file.endsWith(".css"));
    if (!hits.length) continue;
    counts[file] = hits.length;
    details[file] = hits;
  }
  return { counts, details };
}

const staleExemptions = Object.keys(EXEMPT).filter((f) => !existsSync(f));
if (staleExemptions.length) {
  console.log(
    "check-colors: 사라진 파일이 면제 목록에 남아 있습니다 — EXEMPT 에서 지워 주세요: " +
      staleExemptions.join(", ")
  );
}

const current = collect();
const sortedCounts = Object.fromEntries(
  Object.entries(current.counts).sort(([a], [b]) => a.localeCompare(b))
);
const total = Object.values(current.counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update")) {
  const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  if (prev) {
    const raised = Object.entries(current.counts)
      .map(([file, count]) => ({ file, count, allowed: prev[file] ?? 0 }))
      .filter((r) => r.count > r.allowed);
    if (raised.length) {
      console.error("check-colors: --update 는 래칫을 올릴 수 없습니다 (단방향).");
      for (const r of raised) console.error(`  - ${r.file}: ${r.allowed} -> ${r.count}`);
      console.error(
        "새 색은 tokens.css 의 토큰으로 올리고 코드에서는 var(--...) 를 쓰세요.\n" +
          "색이 테마가 아니라 **데이터**인 파일이라면 scripts/check-colors.mjs 의 EXEMPT 에 " +
          "사유와 함께 추가하세요."
      );
      process.exit(1);
    }
  }
  writeFileSync(BASELINE, JSON.stringify(sortedCounts, null, 2) + "\n");
  console.log(
    `check-colors: 베이스라인 갱신 — 파일 ${Object.keys(sortedCounts).length}개, ` +
      `색 리터럴 ${total}건 기록.`
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`check-colors: 베이스라인이 없습니다(${BASELINE}).`);
  console.error("먼저 `node scripts/check-colors.mjs --update` 로 생성하세요.");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

const increased = [];
for (const [file, count] of Object.entries(current.counts)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) increased.push({ file, count, allowed });
}

if (increased.length) {
  console.error("check-colors: 토큰을 거치지 않은 새 색 리터럴이 감지됐습니다.");
  console.error(
    "색은 tokens.css 가 소유하고 코드는 var(--...) 로만 가리킵니다. 박아 둔 색은 테마·강조색 hue 를\n" +
      "따라오지 못해 배경에 먹히거나 눈을 찌릅니다(PLAN-2026-09-12 §7)."
  );
  for (const v of increased) {
    console.error(
      `\n  [${v.file}] 허용 ${v.allowed}건 -> 실제 ${v.count}건 (+${v.count - v.allowed})`
    );
    for (const d of current.details[v.file]) {
      console.error(`    - L${d.line}: \`${d.snippet}\``);
    }
  }
  console.error(
    "\n고르는 길은 셋입니다:\n" +
      "  1. tokens.css 의 토큰을 쓴다 — `var(--fg)` `var(--divider)` 등 (대부분 이것).\n" +
      "  2. 색이 **테마가 아니라 데이터**인 파일이면 scripts/check-colors.mjs 의 EXEMPT 에\n" +
      "     사유와 함께 올린다 (팔레트 생성기·천문 색표·스프라이트 같은 것만).\n" +
      "  3. 정말 남겨야 하면 `node scripts/check-colors.mjs --update` 로 래칫을 갱신한다.\n" +
      '⚠️ 위반을 **다른 파일로 옮겼을 때도** 여기에 걸립니다 — 총계는 줄었는데 목적지 파일이\n' +
      '   "허용 0건 -> 실제 n건" 이 되기 때문입니다. 옮긴 게 맞다면 --update 로 양쪽을 함께 내리세요.'
  );
  process.exit(1);
}

console.log(
  `check-colors: OK — 색 리터럴 ${total}건(래칫 ${baselineTotal}건 이내), ` +
    `면제 ${Object.keys(EXEMPT).length}개 파일(사유 명시).`
);
if (total < baselineTotal) {
  console.log(
    "  ↳ 색 리터럴이 래칫보다 줄었습니다 — `node scripts/check-colors.mjs --update` 로 내려 주세요."
  );
}
