#!/usr/bin/env node
/**
 * SURFACE PRESET CONTRACT 가드 — 단일-시트(single-sheet) 계약 드리프트 검사.
 *
 * 현재 모델(SINGLE-SHEET ACRYLIC CONTRACT, src/styles/tokens.css 하단 참고): 반투명은 오직
 * `.app` 한 곳에서만 일어난다 — `:root[data-surface='acrylic']`가 `--bg`를 `--sheet-alpha`로
 * 조절되는 단일 틴트로 덮어쓰고 `.app` 자신에 `--surface-blur`만큼 backdrop-filter를 건다.
 * in-flow 표면(`.card` 포함: 에디터/미리보기/사이드바/탭바/윈도우 스트립 등)은 배경을 칠하지
 * 않고 헤어라인만 소유한다. 콘텐츠 위에 뜨는 표면(모달/메뉴/드롭다운/토스트)은 `.overlay`를 쓴다
 * (flat에서는 불투명 `var(--surface)`; acrylic에서는 시트 틴트+블러+채도+그레인+림을 `.overlay`
 * 자신이 소유한다 — 전부 일반 레이어라 backdrop-filter 가 페이지를 그대로 샘플링한다).
 * 읽기 카드(에디터 본문/미리보기)는 `.card-reading`으로 2px
 * 외곽선만 더한다. 삭제되어 다시 등장하면 안 되는 구모델 잔재: 클래스 `glass`/`card-glass`/
 * `card-opaque`/`surface-flush`, 토큰 `--surface2`/`--panel`/`--card-scene`/`--surface-alpha`/
 * `--mica-alpha`, 셀렉터 값 `data-surface='mica'`.
 *
 * 2026-08-14 추가된 금지어 3종(body 쌍둥이 프로스트 레이어) — 모달이 `<dialog>.showModal()` 로
 * top layer 에 있던 시절, top layer 안에서 backdrop-filter 가 페이지를 샘플링하지 못하는 한계를
 * body 에 카드와 같은 사각형을 JS 로 복제해 우회했다. 그 레이어는 카드 배경을 **JS 성공 여부에
 * 의존**하게 만들고 폴백이 없어서, 한 번 안 그려지면 모달이 배경 없이 남는 사고가 실제로 났다.
 * ModalShell 이 top layer 를 포기하면서(포커스 격리는 `inert`) 우회 자체가 불필요해졌다.
 * 되살리려면 이 가드부터 지우면서 그 사고를 어떻게 막을지 적을 것.
 *
 * 이 스크립트는 두 가지를 검사한다:
 *
 * (a) 인라인 표면 배경(신규 금지, 기존 것은 베이스라인까지 허용) — .tsx 의 인라인 style 에서
 *     배경을 표면 계열 토큰(--surface-base/--surface/--overlay/--bg)으로 지정하면 그 인라인이
 *     클래스 규칙을 가려(shadow) 프리셋(.card/.overlay)이 절대 닿지 못하고 그 패널만 어느
 *     프리셋에서도 "고정된 상자"로 남는다. 베이스라인(check-surface-contract.allow.json)보다
 *     늘어난(=새로 박은) 인라인만 실패시킨다.
 *
 * (b) 삭제된 구모델 식별자의 재등장(신규 금지, 베이스라인 없음 — 단 1건도 실패) — src/**\/*.{tsx,css}
 *     에서 위에 나열한 클래스/토큰/셀렉터 값이 코드로 다시 등장하면 즉시 실패한다. 단순 문자열
 *     스캔이라 주석에서의 언급도 걸린다 — ponytail: 주석 스트리퍼 없이 원문을 그대로 스캔하는
 *     의도된 트레이드오프. 걸리면 주석을 지우거나 표현을 바꿔라.
 *
 * (h) 설정 창의 `--line` 구분선 금지(래칫) — 아래 (h) 섹션 주석 참고.
 *
 * 베이스라인 갱신((a)·(h), 의도적으로 인라인 표면 배경을 추가/정리했거나 (h) 위반을 걷어냈을 때):
 *   node scripts/check-surface-contract.mjs --update
 * (h) 의 래칫은 **내리는 방향으로만** 움직인다 — --update 로 늘릴 수는 없다.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const BASELINE = "scripts/check-surface-contract.allow.json";
const SETTINGS_LINE_BASELINE = "scripts/check-surface-contract.settings-line.allow.json";

// (a) 인라인 표면 배경 토큰 — --surface2 는 여기서 제외됐다: 이제 (b)의 "재등장 금지" 식별자다.
const INLINE_BG_RE = /background\s*:\s*["'`]var\(--(surface-base|surface|overlay|bg)\)/g;

// (b) 삭제된 구모델 식별자 — 단 1건이라도 코드에 남아 있으면 실패(베이스라인 없음).
// 끝 경계는 \b 가 아니라 (?![\w-]) 를 쓴다: "-" 는 정규식 \w 기준 비단어 문자라 \b 는
// "--panel" 이 "--panel-gap" 안에서도 (l → - 전환에) 경계로 보고 매치해버린다(오탐). 뒤에
// 단어 문자도 "-"도 오지 않을 때만 진짜 그 토큰의 끝이다.
const BANNED_RE = new RegExp(
  [
    /\bglass(?![\w-])/,
    /\bcard-glass(?![\w-])/,
    /\bcard-opaque(?![\w-])/,
    /\bsurface-flush(?![\w-])/,
    /--surface2(?![\w-])/,
    /--panel(?![\w-])/,
    /--card-scene(?![\w-])/,
    /--surface-alpha(?![\w-])/,
    /--mica-alpha(?![\w-])/,
    /data-surface\s*=\s*['"]mica['"]/,
    /\boverlay-frost(?![\w-])/,
    /\boverlay--sheet(?![\w-])/,
    /\bOverlayFrostHost(?![\w-])/,
  ]
    .map((r) => r.source)
    .join("|"),
  "g"
);

// (b) 두 번째 구모델 — 달력 CalendarItem.kind 의 "extra". 2026-09-10
// (PLAN-2026-09-10-calendar-reminders §D4)에 은퇴했다: 관련 날짜(note_dates position≠0)도 노트
// 자신의 사건 축과 **같은 경로**를 지나 같은 event/span 규칙을 받으므로, 관련 날짜인지는
// `position !== 0` 이 말한다. 다시 kind 로 가르기 시작하면 관련 날짜의 시각·기간·부분 정밀도·
// 반복이 또 통째로 빠지는 옛 경로가 되살아난다(§1.1) — 화면에는 "속 빈 점이 채워진 점이 됐다"
// 정도로만 보여 조용히 지나간다(§6-5).
//
// 낱말 "extra" 하나를 금지하면 오탐이 쏟아지므로(주석·collect 픽스처·"extracted from ...")
// **달력 kind 문맥**에만 맞춘다 — 비교(`kind === "extra"`)와 객체 리터럴(`kind: "extra"`) 둘 다.
// 판정 로직이 .ts(calendarLayout.ts)에도 살기 때문에 위 목록과 달리 .ts 까지 훑는다. 위 목록을
// 그냥 .ts 로 넓히지 않는 이유는 `glass`(appearance/settings 의 표면 프리셋 값) 같은 정당한
// 기존 등장이 .ts 에 여럿 있어서다.
const BANNED_CAL_KIND_RE = /kind\s*(?::|===?)\s*["']extra["']/g;

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((ext) => name.endsWith(ext)) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

// ── (a) 인라인 표면 배경 집계 ──────────────────────────────────────────────
function collectInlineBackgrounds() {
  const found = {};
  for (const file of walk(SRC, [".tsx"])) {
    const text = readFileSync(file, "utf8");
    let m;
    INLINE_BG_RE.lastIndex = 0;
    while ((m = INLINE_BG_RE.exec(text))) {
      const token = `var(--${m[1]})`;
      (found[file] ??= {})[token] = (found[file][token] ?? 0) + 1;
    }
  }
  return found;
}

// ── (b) 삭제된 구모델 식별자 재등장 검사 — 주석 포함 단순 텍스트 스캔 ──────
function collectBannedIdentifiers(re, exts) {
  const violations = [];
  for (const file of walk(SRC, exts)) {
    const text = readFileSync(file, "utf8");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      violations.push({ file, snippet: m[0], line: lineNumber(text, m.index) });
    }
  }
  return violations;
}

// ── (h) 설정 창에서 --line 구분선 금지 (PLAN-2026-09-12 §2 / docs/DESIGN.md §설정 레이아웃 ②) ──
// 설정 창의 선은 **영역 경계**에만 긋는다 — ⓐ 카드와 카드 사이, ⓑ 카드 안 하위 그룹 사이. 둘 다
// 같은 `--divider` 하나를 쓰고, **옵션 행 아래에는 긋지 않는다.** 오너 QA 에서 "펫 표시" 아래의
// 행 선과 "트레이 기능" 위의 영역 선이 같은 굵기·같은 색으로 나란히 보여 위계가 전혀 읽히지
// 않았다. 목적은 선의 개수를 줄이는 게 아니라 **선이 한 가지 뜻만 갖게** 하는 것이므로, 설정
// 창 안에서는 두 번째 선 색(`--line`)을 아예 쓰지 않는다.
//
// 컨트롤 외곽선(SegGroup 테두리, .field, .overlay, Toggle 트랙)은 구분선이 아니다 — 그것들은
// 클래스가 소유하고 인라인 `border*: ... var(--line)` 로 나타나지 않으므로 이 검사에 걸리지 않는다.
//
// 속성은 border / borderTop / borderBottom 셋만 본다(그리고 `<style>` 문자열용 CSS 철자
// border-top / border-bottom). borderLeft/borderRight 는 뺐다 — 계획서가 세 속성을 지정했고,
// 세로선(CollectSection 의 컬럼 구분)은 "영역 경계" 규칙이 말하는 그 선이 아니다.
//
// 래칫: 지금 남은 위반은 W1~W2 가 걷어내는 중이라 0 으로 끊으면 게이트가 그 사이 내내 빨갛다.
// (a) 와 같은 방식으로 파일별 현재 개수를 베이스라인에 박고 **늘어나는 것만** 실패시킨다.
// 위반이 정리되면 `--update` 로 베이스라인을 내린다(단방향 — 올릴 수는 없다. 그게 없으면 누구든
// --update 한 번으로 새 위반을 베이스라인에 세탁해 넣는다).
const SETTINGS_LINE_PROP_RE =
  /(?<![\w-])(borderBottom|borderTop|border-bottom|border-top|border)\s*:/g;

// 선언 값 하나를 읽는다 — 깊이 0 의 `,` `;` 또는 닫는 괄호에서 끝난다. 문자열 리터럴 안의 문자는
// **값에 포함하되** 구두점으로는 세지 않는다: 값이 삼항이거나 템플릿 리터럴이라 `var(--line)` 이
// 따옴표 안에 들어 있는 형태가 실제로 있다(PetAssetGrid 의 dragOver/isCurrentMood 분기).
function readDeclarationValue(text, from) {
  let depth = 0;
  let out = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      for (i++; i < text.length; i++) {
        const c = text[i];
        out += c;
        if (c === "\\") {
          i++;
          if (i < text.length) out += text[i];
          continue;
        }
        if (c === ch) break;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) {
      break;
    }
    out += ch;
  }
  return out;
}

// 이 추출기의 위험한 실패는 오탐이 아니라 **미탐**이다 — 삼항/템플릿 리터럴 형태의 선언을 놓치면
// 새 --line 이 조용히 통과한다. scripts/ 에 테스트 파일을 두는 관례가 없으므로(check-settings-keys.mjs
// 의 selfTest 와 같은 이유) 검사를 여기 둔다 — 통과하면 아무 것도 출력하지 않고, 깨지면 스캐너가
// 먼저 죽는다.
function settingsLineSelfTest() {
  const hit = (src) => {
    SETTINGS_LINE_PROP_RE.lastIndex = 0;
    let m;
    let n = 0;
    while ((m = SETTINGS_LINE_PROP_RE.exec(src))) {
      if (/var\(\s*--line\s*\)/.test(readDeclarationValue(src, m.index + m[0].length))) n++;
    }
    return n;
  };
  const cases = [
    [`  borderBottom: "1px solid var(--line)",`, 1],
    [`  borderTop: "1px solid var(--line)",`, 1],
    [`  border: "2px dashed var(--line)",`, 1],
    // 삼항 — 값이 여러 문자열에 나뉘어 있어도 잡아야 한다.
    [`  borderBottom: last ? "none" : "1px solid var(--line)",`, 1],
    // 템플릿 리터럴 안의 분기.
    ["  border: `1px ${on ? \"dashed var(--accent)\" : \"solid var(--line)\"}`,", 1],
    // color-mix 안에 섞여 들어간 --line 도 결국 그 선의 색이다.
    [`  border: on ? "1px solid color-mix(in srgb, var(--accent) 30%, var(--line))" : "none",`, 1],
    // `<style>` 문자열의 CSS 철자.
    ["<style>{`.x+.x{border-top:1px solid var(--line)}`}</style>", 1],
    // 영역 경계선(--divider)은 규칙대로이므로 걸리지 않는다.
    [`  borderBottom: "1px solid var(--divider)",`, 0],
    // 대상 밖 속성 — 계획서가 지정한 세 속성만 본다.
    [`  borderRight: "1px solid var(--line)",`, 0],
    [`  borderLeft: "1px solid var(--line)",`, 0],
    [`  borderColor: "var(--line)",`, 0],
    // 접두사가 같은 다른 속성에 걸려들지 않아야 한다.
    [`  borderTopColor: "var(--line)",`, 0],
    [`  borderBottomWidth: 1, color: "var(--line)",`, 0],
    // 다음 선언으로 값이 새지 않아야 한다(미탐 아닌 오탐 쪽 확인).
    [`  border: "none", background: "var(--line)",`, 0],
  ];
  for (const [src, want] of cases) {
    const got = hit(src);
    if (got !== want) {
      throw new Error(
        `check-surface-contract (h) selftest: 기대 ${want} != 실제 ${got} — ${src}`
      );
    }
  }
}
settingsLineSelfTest();

function settingsSurfaceFiles() {
  const files = walk("src/components/settings", [".ts", ".tsx"]).filter(
    (f) => !/\.test\.tsx?$/.test(f)
  );
  files.push("src/components/SettingsPanel.tsx");
  return files.sort();
}

function collectSettingsLineViolations() {
  const counts = {};
  const details = [];
  for (const file of settingsSurfaceFiles()) {
    const text = readFileSync(file, "utf8");
    SETTINGS_LINE_PROP_RE.lastIndex = 0;
    let m;
    while ((m = SETTINGS_LINE_PROP_RE.exec(text))) {
      const value = readDeclarationValue(text, m.index + m[0].length);
      if (!/var\(\s*--line\s*\)/.test(value)) continue;
      counts[file] = (counts[file] ?? 0) + 1;
      details.push({
        file,
        line: lineNumber(text, m.index),
        snippet: `${m[1]}:${value}`.replace(/\s+/g, " ").trim().slice(0, 110),
      });
    }
  }
  return { counts, details };
}

const currentInline = collectInlineBackgrounds();
const currentSettingsLine = collectSettingsLineViolations();

if (process.argv.includes("--update")) {
  const prevSettingsLine = existsSync(SETTINGS_LINE_BASELINE)
    ? JSON.parse(readFileSync(SETTINGS_LINE_BASELINE, "utf8"))
    : null;
  // (h) 래칫은 단방향 — 늘어난 파일이 하나라도 있으면 갱신을 거부한다.
  if (prevSettingsLine) {
    const raised = Object.entries(currentSettingsLine.counts)
      .map(([file, count]) => ({ file, count, prev: prevSettingsLine[file] ?? 0 }))
      .filter((r) => r.count > r.prev);
    if (raised.length) {
      console.error(
        "check-surface-contract: --update 는 (h) 베이스라인을 올릴 수 없습니다 (래칫은 단방향)."
      );
      for (const r of raised) console.error(`  - ${r.file}: ${r.prev} -> ${r.count}`);
      console.error("설정 창의 구분선은 --divider 하나뿐입니다 — 새 --line 을 먼저 걷어내세요.");
      process.exit(1);
    }
  }

  writeFileSync(BASELINE, JSON.stringify(currentInline, null, 2) + "\n");
  writeFileSync(
    SETTINGS_LINE_BASELINE,
    JSON.stringify(currentSettingsLine.counts, null, 2) + "\n"
  );
  const total = Object.values(currentInline).reduce(
    (n, m) => n + Object.values(m).reduce((a, b) => a + b, 0),
    0
  );
  const settingsTotal = Object.values(currentSettingsLine.counts).reduce((a, b) => a + b, 0);
  console.log(
    `check-surface-contract: 베이스라인 갱신 — 인라인 표면 배경 ${total}개, ` +
      `설정 창 --line 구분선 ${settingsTotal}개 기록.`
  );
  process.exit(0);
}

for (const path of [BASELINE, SETTINGS_LINE_BASELINE]) {
  if (existsSync(path)) continue;
  console.error(`check-surface-contract: 베이스라인이 없습니다(${path}).`);
  console.error("먼저 `node scripts/check-surface-contract.mjs --update` 로 생성하세요.");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

let failed = false;

// (a) 베이스라인보다 늘어난(=새로 박은) 인라인 표면 배경만 위반으로 본다.
const inlineViolations = [];
for (const [file, tokens] of Object.entries(currentInline)) {
  for (const [token, count] of Object.entries(tokens)) {
    const allowed = baseline[file]?.[token] ?? 0;
    if (count > allowed) inlineViolations.push({ file, token, count, allowed });
  }
}

if (inlineViolations.length) {
  failed = true;
  console.error("check-surface-contract: 새 인라인 표면 배경이 감지됐습니다.");
  console.error(
    "인라인 background 는 .card/.overlay 등 클래스 규칙을 가려(shadow) 그 요소만 어느 프리셋에서도\n" +
      "닿지 못하는 고정된 박스로 남깁니다. 배경은 클래스가 소유하게 하세요(.card / .overlay / .field)."
  );
  for (const v of inlineViolations) {
    console.error(`  - ${v.file}: ${v.token} (${v.allowed} → ${v.count})`);
  }
  console.error(
    "\n폼 컨트롤(input/select)의 불투명 --surface 처럼 의도된 경우에만 " +
      "`node scripts/check-surface-contract.mjs --update` 로 베이스라인에 추가하세요."
  );
}

// (b) 삭제된 구모델 식별자 — 단 1건도 허용하지 않는다.
const bannedViolations = collectBannedIdentifiers(BANNED_RE, [".tsx", ".css"]);
if (bannedViolations.length) {
  failed = true;
  console.error(
    "\ncheck-surface-contract: 삭제된 구(舊) 표면 모델의 식별자가 코드에서 재등장했습니다."
  );
  console.error(
    "glass/card-glass/card-opaque/surface-flush, --surface2/--panel/--card-scene/--surface-alpha/\n" +
      "--mica-alpha, data-surface='mica' 는 2026-07-21/24 에 걷어낸 구모델이며 되살리지 않습니다.\n" +
      "떠 있는 표면은 `.overlay`, in-flow 표면은 배경 없이 `.card`(+ 읽기 카드는 `.card-reading`)를 쓰세요."
  );
  for (const v of bannedViolations) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet.trim()}\``);
  }
}

// (b-2) 달력 kind "extra" 재등장 — 같은 규율, 다른 확장자 집합.
const calKindViolations = collectBannedIdentifiers(BANNED_CAL_KIND_RE, [".ts", ".tsx"]);
if (calKindViolations.length) {
  failed = true;
  console.error("\ncheck-surface-contract: 은퇴한 달력 kind \"extra\" 가 재등장했습니다.");
  console.error(
    "CalendarItem.kind 는 event/span 둘뿐입니다(2026-09-10 §D4). 관련 날짜는 노트 자신의 사건 축과\n" +
      "같은 경로를 지나 같은 규칙을 받으므로, 관련 날짜인지는 `item.position !== 0` 으로 판정하세요."
  );
  for (const v of calKindViolations) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet.trim()}\``);
  }
}

// ── (c) call().catch 금지 (2026-08-24 지시서 §D) ────────────────────────────
// call() 은 실패 시 자체 에러 토스트를 띄우므로, 무음/백그라운드 처리는 callSilent() 를 써야 합니다.
// call(...).catch(...) 는 토스트를 막지 못하면서 reject 만 삼키는 안티패턴입니다.
function collectCallCatchViolations() {
  const violations = [];
  for (const file of walk(SRC, [".ts", ".tsx"])) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(Math.max(0, i - 6), i + 1).join(" ");
      if (
        lines[i].includes(".catch(") &&
        /\bcall\s*(?:<[^>]*>)?\s*\(/.test(window) &&
        !/\bcallSilent\s*(?:<[^>]*>)?\s*\(/.test(window)
      ) {
        violations.push({ file, line: i + 1, snippet: lines[i].trim() });
      }
    }
  }
  return violations;
}

const callCatchViolations = collectCallCatchViolations();
if (callCatchViolations.length) {
  failed = true;
  console.error(
    "\ncheck-surface-contract: call(...).catch(...) 안티패턴이 감지됐습니다."
  );
  console.error(
    "call() 은 내부에서 에러 토스트를 띄우므로 .catch() 로 토스트가 억제되지 않습니다.\n" +
      "에러 토스트 없이 실패를 무시/폴백 처리하려면 `callSilent()` 를 사용하세요."
  );
  for (const v of callCatchViolations) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet}\``);
  }
}

// ── (d) lib/invoke mock 시 callSilent 누락 금지 (2026-08-24 지시서) ──────────────
// lib/invoke 를 vi.mock 하면서 call: 만 주고 callSilent: 를 빠뜨리면,
// 프로덕션 코드의 callSilent(...) 호출 시 런타임 TypeError 가 발생합니다.
function collectMockInvokeViolations() {
  const violations = [];
  function walkTestFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name).replace(/\\/g, "/");
      if (statSync(p).isDirectory()) walkTestFiles(p, out);
      else if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) out.push(p);
    }
    return out;
  }

  function findMockInvokeBlocks(content) {
    const re = /vi\.mock\(\s*["'][^"']*\/invoke["']/g;
    let m;
    const blocks = [];
    while ((m = re.exec(content)) !== null) {
      const start = m.index;
      let depth = 0;
      let end = -1;
      for (let i = start; i < content.length; i++) {
        if (content[i] === "(") depth++;
        else if (content[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end !== -1) {
        blocks.push(content.slice(start, end));
      }
    }
    return blocks;
  }

  for (const file of walkTestFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const blocks = findMockInvokeBlocks(text);
    for (const block of blocks) {
      if (/importOriginal/.test(block)) continue;
      if (/\bcall\s*:/.test(block) && !/\bcallSilent\s*:/.test(block)) {
        violations.push(file);
      }
    }
  }
  return violations;
}

const mockInvokeViolations = collectMockInvokeViolations();
if (mockInvokeViolations.length) {
  failed = true;
  console.error(
    "\ncheck-surface-contract: lib/invoke mock 에 `callSilent` 가 누락되었습니다."
  );
  console.error(
    "lib/invoke 를 mock 할 때 `call:` 만 제공하면 `callSilent(...)` 호출 시 TypeError 가 발생합니다.\n" +
      "  - 이름 있는 mock 함수로 위임 시: `callSilent: (...args: unknown[]) => callMock(...args),` (동일 mock 함수 가리킬 것)\n" +
      "  - 인라인 vi.fn() 사용 시: `callSilent: vi.fn().mockResolvedValue(...)` (call 과 동일한 값/구조 복사)\n" +
      "  - 또는 `importOriginal` 로 모듈을 펼친 뒤 필요한 것만 오버라이드하세요."
  );
  for (const file of mockInvokeViolations) {
    console.error(`  - ${file}`);
  }
}

// ── (e) void call(...)/callSilent(...).then(...) 미처리 rejection 금지 (2026-09-01 사고) ─────
// call()/callSilent() 는 실패 시 토스트/로그를 남긴 뒤 다시 throw 한다(lib/invoke.ts 183·201줄).
// `void call(...).then(setX)` 처럼 .catch 없이 두면 진짜 unhandled rejection 이 샌다. 2026-09-01
// 에 이 형태가 6곳 쌓여 있었고, 그중 `folder_rename` 은 `.finally(...)` 가 붙어 있어 처리된 것처럼
// 보였다 — 하지만 `.finally` 는 rejection 을 붙잡지 않는다. 문장 끝을 정규식으로 세미콜론까지 잡으면
// `.then` 콜백 **안에 있는** 세미콜론에서 잘려, 그 뒤에 진짜로 붙은 `.catch` 를 못 본다(이 방식으로
// 스캔했을 때 23건 중 21건이 오탐이었다) — 그래서 괄호/중괄호/대괄호 깊이로 문장 끝을 찾는다.
// 문장 끝을 괄호/중괄호/대괄호 깊이로 찾는다 — 세미콜론을 그대로 정규식으로 잡으면 `.then` 콜백
// **안에 있는** 세미콜론에서 잘려 그 뒤에 진짜로 붙은 `.catch` 를 못 본다(주석 참고). ⓕ도 그대로
// 재사용한다(중복 구현 금지).
function findStatementEnd(text, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth <= 0) return i;
  }
  // ponytail: 세미콜론 없는 문장(파일 끝 ASI 등)은 못 잡는다 — 이 저장소는 세미콜론을 쓴다.
  return -1;
}

function collectUnhandledVoidCallViolations() {
  const violations = [];
  const START_RE = /\bvoid\s+call(?:Silent)?\s*(?:<[^>]*>)?\s*\(/g;
  for (const file of walk(SRC, [".ts", ".tsx"]).filter((f) => !/\.test\.tsx?$/.test(f))) {
    const text = readFileSync(file, "utf8");
    START_RE.lastIndex = 0;
    let m;
    while ((m = START_RE.exec(text))) {
      const end = findStatementEnd(text, m.index);
      if (end === -1) break;
      const stmt = text.slice(m.index, end);
      if (/\.then\s*\(/.test(stmt) && !/\.catch\s*\(/.test(stmt)) {
        violations.push({
          file,
          line: lineNumber(text, m.index),
          snippet: stmt.split("\n")[0].trim(),
        });
      }
      START_RE.lastIndex = end; // 같은 문장 안의 중첩 call 재매치 방지
    }
  }
  return violations;
}

const unhandledVoidCallViolations = collectUnhandledVoidCallViolations();
if (unhandledVoidCallViolations.length) {
  failed = true;
  console.error(
    "\ncheck-surface-contract: void call(...)/callSilent(...).then(...) 에 .catch 가 없습니다."
  );
  console.error(
    "call()/callSilent() 는 실패 시 다시 throw 하므로 .catch 없이 두면 unhandled rejection 이 샙니다.\n" +
      "`.finally(...)` 는 rejection 을 붙잡지 않으므로 .catch 대용이 될 수 없습니다. 의도에 맞게 고치세요:\n" +
      "  - 토스트가 필요 없으면(값 없으면 조용히 숨는 선택적 조회) → callSilent(...).catch(...)\n" +
      "  - 토스트가 필요하면(사용자 행동이 실패) → try { await call(...) } catch { /* 롤백 */ }"
  );
  for (const v of unhandledVoidCallViolations) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet}\``);
  }
}

// ── (f) 재전파 래퍼 경유 미처리 rejection 금지 (2026-09-01, ⓔ의 사각지대) ──────────────────
// ⓔ는 `void call(...)/void callSilent(...)` **리터럴 형태만** 본다. 실제로는 그 사이에 래퍼
// 함수가 끼는 경우가 훨씬 흔하다 — 예: `generateFolderOrganizePlan`(src/stores/aiAgentActions.ts)
// 은 자기 본문에 call()이 없지만 `noteQueryCollect`(src/lib/noteQuery.ts)를 catch 없이 부르고,
// noteQueryCollect 는 다시 `noteQuery`를 catch 없이 부르며, noteQuery 가 `call()`을 직접 쓰고
// catch가 없다 — 3홉짜리 재전파 사슬이다. `FolderOrganizeModal.tsx`가 이 함수를
// `void generateFolderOrganizePlan(...).then(...).finally(...)`로 불러 2026-09-01에 실제
// unhandled rejection 이 샜다. 래퍼 이름을 하드코딩하면 새 래퍼가 생길 때마다 목록이 썩으므로,
// 소스에서 직접 재전파 함수 집합을 계산한다(고정점 — 함수 개수만큼만 반복하므로 발산하지 않는다):
//   1단계: 본문에 call(/callSilent( 이 있고 catch 가 없으면 "재전파".
//   n+1단계: 이미 "재전파"로 판정된 이름을 본문에서 (멤버 호출 아닌 순수 식별자로) 부르고
//            catch 가 없으면 그 함수도 "재전파" — 이걸 더 늘지 않을 때까지 반복.
// "catch 있음"은 함수 본문 어디든 `catch` 키워드가 있으면 안전 취급하는 거친 휴리스틱이다 —
// 그 catch 가 진짜 문제의 호출을 감싸는지는 안 본다. 그래서 이 검사는 놓치는 쪽으로 치우친다
// (안전으로 오판할 순 있어도 위험한 걸 안전하다고 잘못 부풀리진 않는다) — 오탐보다 누락이 낫다는
// 지시서 원칙과 일치.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 함수/화살표 정의를 찾아 이름→본문(중괄호 균형) 맵으로 모은다. 매치 못 하는 스타일(스토어
// 객체 리터럴의 메서드 `foo: async (...) => {...}`, 클래스 메서드 등)은 그냥 못 찾을 뿐이고,
// 그 이름은 아래에서 "정의 못 찾음 → 판정 불가"로 조용히 빠진다.
function matchBalanced(text, openIndex, openCh, closeCh) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractFunctionDefs(text, defs) {
  // export? async? function NAME(
  const FN_RE = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = FN_RE.exec(text))) {
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchBalanced(text, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    const braceStart = text.indexOf("{", parenEnd);
    if (braceStart === -1) continue;
    // 파라미터 닫는 괄호와 여는 중괄호 사이엔 반환 타입 정도만 있어야 한다(오버로드 시그니처나
    // interface 메서드 선언처럼 몸통이 없는 것은 세미콜론/중괄호가 끼어 있어 걸러진다).
    if (/[;{}]/.test(text.slice(parenEnd + 1, braceStart))) continue;
    const braceEnd = matchBalanced(text, braceStart, "{", "}");
    if (braceEnd === -1) continue;
    if (!defs.has(m[1])) defs.set(m[1], text.slice(braceStart, braceEnd + 1));
  }

  // export? const NAME = (async)? (
  const ARROW_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = ARROW_RE.exec(text))) {
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchBalanced(text, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    // 파라미터 뒤 반환 타입 주석을 건너뛰고 `=> {` 인지 확인 — 표현식 본문 화살표(중괄호 없음)는
    // 대상에서 제외한다.
    const afterParens = text.slice(parenEnd + 1, parenEnd + 300);
    const arrowMatch = afterParens.match(/^\s*(?::[^=]*)?=>\s*\{/);
    if (!arrowMatch) continue;
    const braceStart = parenEnd + 1 + arrowMatch[0].length - 1;
    const braceEnd = matchBalanced(text, braceStart, "{", "}");
    if (braceEnd === -1) continue;
    if (!defs.has(m[1])) defs.set(m[1], text.slice(braceStart, braceEnd + 1));
  }
}

function computeUnsafeWrappers(defs) {
  const DIRECT_CALL_RE = /\bcall\s*(?:<[^>]*>)?\s*\(|\bcallSilent\s*(?:<[^>]*>)?\s*\(/;
  const CATCH_RE = /\bcatch\b/;
  const unsafe = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of defs) {
      if (unsafe.has(name)) continue;
      if (CATCH_RE.test(body)) continue; // 본문 어딘가 catch 가 있으면 안전 취급(놓치는 쪽으로 치우침)
      let unsafeCallee = DIRECT_CALL_RE.test(body);
      if (!unsafeCallee) {
        for (const u of unsafe) {
          if (u === name) continue;
          // 멤버 호출(`.foo(`)은 다른 정의(스토어 메서드 등)일 수 있어 제외 — 순수 식별자 호출만.
          if (new RegExp(`(?<![.\\w$])${escapeRegExp(u)}\\s*\\(`).test(body)) {
            unsafeCallee = true;
            break;
          }
        }
      }
      if (unsafeCallee) {
        unsafe.add(name);
        changed = true;
      }
    }
  }
  return unsafe;
}

function collectRewrappedUnhandledViolations() {
  const files = walk(SRC, [".ts", ".tsx"]).filter((f) => !/\.test\.tsx?$/.test(f));
  const defs = new Map();
  const texts = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    texts.set(file, text);
    extractFunctionDefs(text, defs);
  }
  const unsafe = computeUnsafeWrappers(defs);
  const violations = [];
  if (unsafe.size === 0) return violations;
  const START_RE = new RegExp(
    `\\bvoid\\s+(${[...unsafe].map(escapeRegExp).join("|")})\\s*\\(`,
    "g"
  );
  for (const [file, text] of texts) {
    START_RE.lastIndex = 0;
    let m;
    while ((m = START_RE.exec(text))) {
      const end = findStatementEnd(text, m.index);
      if (end === -1) break;
      const stmt = text.slice(m.index, end);
      if (/\.then\s*\(/.test(stmt) && !/\.catch\s*\(/.test(stmt)) {
        violations.push({
          file,
          line: lineNumber(text, m.index),
          snippet: stmt.split("\n")[0].trim(),
          wrapper: m[1],
        });
      }
      START_RE.lastIndex = end;
    }
  }
  return violations;
}

const rewrappedViolations = collectRewrappedUnhandledViolations();
if (rewrappedViolations.length) {
  failed = true;
  console.error(
    "\ncheck-surface-contract: 재전파 래퍼를 경유한 void ...().then() 에 .catch 가 없습니다."
  );
  console.error(
    "이 래퍼들은 call()/callSilent() 를 내부에서 쓰면서(직접 또는 다른 재전파 래퍼를 통해) 자기 본문에\n" +
      "catch 가 없어 rejection 을 그대로 다시 던집니다. `.finally` 는 rejection 을 붙잡지 않으므로\n" +
      "호출부에서 .catch 로 붙잡거나, 래퍼 안에 try/catch 를 추가하세요."
  );
  for (const v of rewrappedViolations) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet}\` (재전파 래퍼: ${v.wrapper})`);
  }
}

// ── (g) 인라인 메뉴 구분선 금지 (2026-09-10) ────────────────────────────────
// `.menu-sep` (tokens.css) 가 있는데도 `<div style={{height:1, background:"var(--line)",
// margin:"4px 0"}}/>` 를 복붙한 사본이 8곳 있었고, 색이 --line/--divider 로 갈려 메뉴마다
// 구분선 진하기가 달랐다. 더 중요한 건 유동 hover(FluidHover.tsx)가 구분선을 **묶음 경계**로
// 읽는다는 점이다 — 인라인 div 는 클래스가 없어 경계로 인식되지 않고, 하이라이트가 구분선을
// 조용히 넘어 "삭제" 같은 파괴적 항목까지 미끄러진다. 화면에 에러가 안 나므로 리뷰에서도 안 보인다.
// 마진이 **세로 전용**(`4px 0` = `var(--space-1) 0`)인 것만 본다 — 그게 메뉴 구분선의 모양이다.
// 이 좁히기는 실제 오탐 둘이 시켰다: CalendarExpanded 의 `{flex:1, height:1}` 은 마진 없는 헤더
// 가로줄이고, TreeListRow 의 섹션 구분선은 사이드바 패딩에 맞춘 4방향 마진을 갖는다 — 둘 다
// `.menu-sep` 으로 바꾸면 모양이 달라진다.
const INLINE_SEP_RE =
  /style=\{\{[^}]*height:\s*1\s*,[^}]*background:\s*["'`]var\(--(?:line|divider)\)["'`][^}]*margin:\s*["'`](?:var\(--space-1\)|4px) 0["'`][^}]*\}\}/g;
function collectInlineSeparatorViolations() {
  const violations = [];
  for (const file of walk(SRC, [".tsx"])) {
    const text = readFileSync(file, "utf8");
    INLINE_SEP_RE.lastIndex = 0;
    let m;
    while ((m = INLINE_SEP_RE.exec(text))) {
      violations.push({ file, line: lineNumber(text, m.index), snippet: m[0].slice(0, 90) });
    }
  }
  return violations;
}

const inlineSepViolations = collectInlineSeparatorViolations();
if (inlineSepViolations.length) {
  failed = true;
  console.error("\ncheck-surface-contract: 인라인 메뉴 구분선이 감지됐습니다.");
  console.error(
    "메뉴 구분선은 `<div className=\"menu-sep\" />` 하나뿐입니다(tokens.css). " +
      "인라인 사본은 색이 갈릴 뿐 아니라, 유동 hover 가 묶음 경계로 인식하지 못해 " +
      "하이라이트가 구분선을 넘어 파괴적 항목까지 미끄러집니다."
  );
  for (const v of inlineSepViolations) {
    console.error(`  - ${v.file}:${v.line}: \`${v.snippet}\``);
  }
}

// ── (h) 설정 창 --line 구분선 래칫 — 수집·근거는 위 (h) 섹션 주석 참고. ────────────────────
const settingsLineBaseline = JSON.parse(readFileSync(SETTINGS_LINE_BASELINE, "utf8"));
const settingsLineIncreases = [];
for (const [file, count] of Object.entries(currentSettingsLine.counts)) {
  const allowed = settingsLineBaseline[file] ?? 0;
  if (count > allowed) settingsLineIncreases.push({ file, count, allowed });
}

if (settingsLineIncreases.length) {
  failed = true;
  console.error("\ncheck-surface-contract: 설정 창에 새 `--line` 구분선이 생겼습니다.");
  console.error(
    "설정 창의 선은 **영역 경계**에만 긋고(카드↔카드, 카드 안 하위 그룹↔하위 그룹) 둘 다 `--divider`\n" +
      "하나를 씁니다. 옵션 행 아래에는 긋지 않습니다(docs/DESIGN.md §설정 레이아웃 ②).\n" +
      "선이 필요하면 --divider 를, 그냥 간격이 필요한 것이면 --space-* 를 쓰세요."
  );
  for (const v of settingsLineIncreases) {
    console.error(`  - ${v.file}: 허용 ${v.allowed}건 -> 실제 ${v.count}건`);
    for (const d of currentSettingsLine.details.filter((x) => x.file === v.file)) {
      console.error(`      ${d.line}: \`${d.snippet}\``);
    }
  }
}

// ── (e) 맨 React.lazy 금지 — 지연 로드는 lib/lazyPreload.ts 한 곳 (2026-10-22) ─────────────
// React 19 는 Suspense 가 대기 화면을 보인 뒤 내용으로 바꾸는 커밋을 최소 300ms 미룬다. 맨 lazy() 는
// 모듈을 이미 받아 뒀어도 한 번은 대기 화면을 거쳐 첫 열기마다 ~300ms 빈칸이 생겼다(대시보드 탭 실측).
// lazyPreload() 는 미리 받기(의도·유휴) + 받은 뒤 동기 해결로 그 빈칸을 없앤다.
function collectRawLazyViolations() {
  const violations = [];
  const RAW_LAZY_RE = /(?:\bReact\.lazy\s*\(|(?<![\w.])lazy\s*\(\s*\(\s*\)\s*=>)/;
  const IMPORT_LAZY_RE = /import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*["']react["']/;
  for (const file of walk(SRC, [".ts", ".tsx"])) {
    const norm = file; // walk() 가 이미 / 로 맞춘다
    if (norm.endsWith("src/lib/lazyPreload.ts") || /\.test\.tsx?$/.test(norm)) continue;
    const text = readFileSync(file, "utf8");
    if (!IMPORT_LAZY_RE.test(text) && !/\bReact\.lazy\s*\(/.test(text)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith("*") || t.startsWith("//")) continue;
      if (RAW_LAZY_RE.test(lines[i])) violations.push({ file: norm, line: i + 1, snippet: lines[i].trim() });
    }
    if (IMPORT_LAZY_RE.test(text) && !violations.some((v) => v.file === norm)) {
      violations.push({ file: norm, line: 0, snippet: 'import { lazy } from "react"' });
    }
  }
  return violations;
}
const rawLazyViolations = collectRawLazyViolations();
if (rawLazyViolations.length) {
  failed = true;
  console.error("\ncheck-surface-contract: 맨 React.lazy 를 쓰고 있습니다.");
  console.error(
    "지연 로드 컴포넌트는 src/lib/lazyPreload.ts 의 lazyPreload(loader, { name, idle? }) 로 만들고,\n" +
      "여는 버튼에 preloadIntentProps(X) 를 펼치세요(React 19 의 Suspense 300ms 지연을 피한다)."
  );
  for (const v of rawLazyViolations) console.error("  - " + v.file + ":" + v.line + ": " + v.snippet);
}

if (failed) {
  process.exit(1);
}

const totalInline = Object.values(currentInline).reduce(
  (n, m) => n + Object.values(m).reduce((a, b) => a + b, 0),
  0
);
const totalSettingsLine = Object.values(currentSettingsLine.counts).reduce((a, b) => a + b, 0);
const baselineSettingsLine = Object.values(settingsLineBaseline).reduce((a, b) => a + b, 0);
console.log(
  `check-surface-contract: OK — 인라인 표면 배경 ${totalInline}개(베이스라인 이내), ` +
    "삭제된 구모델 식별자 재등장 없음(달력 kind \"extra\" 포함), call().catch 안티패턴 없음, " +
    "lib/invoke mock callSilent 계약 준수, " +
    "void call().then() 미처리 rejection 없음, 재전파 래퍼 경유 미처리 rejection 없음, " +
    "인라인 메뉴 구분선 없음, 맨 React.lazy 없음, " +
    `설정 창 --line 구분선 ${totalSettingsLine}개(래칫 ${baselineSettingsLine}개 이내).`
);
if (totalSettingsLine < baselineSettingsLine) {
  console.log(
    "  ↳ 설정 창 --line 위반이 래칫보다 줄었습니다 — " +
      "`node scripts/check-surface-contract.mjs --update` 로 베이스라인을 내려 주세요."
  );
}
