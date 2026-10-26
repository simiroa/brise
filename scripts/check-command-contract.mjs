#!/usr/bin/env node
/**
 * 커맨드 계약 표류(drift) 가드 — audit §3 G6 (docs/AUDIT-2026-09-26-fallback-observability.md).
 *
 * 배경: `specs/commands/*.yaml` 이 필드를 "생략 가능"으로 적어도(`|omit`/`|omit=...`/트레일링
 * `?`), 실제 `#[tauri::command] fn` 파라미터가 `Option<T>` 가 아니면 그 필드는 사실 생략할 수
 * 없다 — 네이티브 Tauri IPC(`invoke()`)는 `dispatch.gen.rs` 를 거치지 않고 그 fn 시그니처로
 * 직접 역직렬화하므로, 생략하면 그 자리에서 즉시 거부된다. tsc/vitest(둘 다 목 기반)는 이 표류를
 * 못 잡는다 — 실제 IPC 왕복만 걸린다. `ai_generate_from_prompt.provider`(스펙
 * `…|omit=settings.ai_provider`, Rust `provider: String`)가 실제로 이 표류였고, D1(챗 유사어
 * 확장·챗 메모리 추출이 **매번** 실패)의 원인 중 하나였다.
 *
 * "TS-optional" 판정은 `scripts/gen-commands.mjs`(생성기, 이 파일이 실제로 만드는
 * `src/lib/commands.gen.ts`)의 `parseProperty` 를 **정확히 그대로** 미러링한다 — import 하지
 * 않는다: 그 파일은 아무 것도 export 하지 않고, 최상위에서 곧장 세 산출물(commands.gen.ts,
 * dispatch.gen.rs, cli/commands.gen.json)을 **덮어쓴다** — 다른 에이전트가 지금 그 파일들을
 * 동시에 고치고 있으므로 import 자체가 사고다.
 *
 * ⚠️ 의도된 미러링 — "직관"이 아니라 **실제 파서**를 따른다: `|omit`(등호 있든 없든)과 트레일링
 * `?` 가 optional 을 표시한다. **2026-09-26 정정**: 맨 `|omit`(등호 없음, 예: `api_key:
 * "string|omit"`)을 optional 로 안 치던 것 자체가 parseProperty 의 버그였다 — 유니온 분기로
 * 떨어져 생성된 TS 에서 값이 `'omit'` 이라는 문자열 리터럴 타입으로 둔갑했다(`api_key: string |
 * 'omit'`). 이 D1 근본 원인을 gen-commands.mjs 에서 고쳤고(맨 `|omit` 도 이제 optional), 이
 * 미러도 그 수정된 동작을 따른다 — 더 이상 "버그를 그대로 미러링"이 아니라 "고쳐진 파서를
 * 미러링"이다.
 *
 * 두 카테고리:
 *   (A) required_drift (= "위반", 래칫 대상) — TS 가 optional(`?`)로 생성했는데 Rust 파라미터가
 *       `Option<T>` 가 아님. 네이티브 invoke 가 그 필드 생략 시 즉시 깨진다.
 *   (B) reverse_informational (정보용, 절대 게이트를 막지 않음) — TS 가 required 로 생성했는데
 *       Rust 파라미터는 `Option<T>`. 게이트를 막을 이유는 없다(호출자가 값을 안 보내는 실패
 *       모드가 아니라 "안 보내도 되는데 강제로 보내야 하는" 반대쪽 불편이라서) — 그래도 맨
 *       `|omit` 버그가 여기 몰려 나오므로 followups 로 다음 웨이브에 넘긴다.
 *
 * Rust 쪽 진실 원천은 **실제 `#[tauri::command] fn` 시그니처**다(`dispatch.gen.rs` 가 아니라) —
 * 데스크톱 네이티브 invoke() 는 그 fn 을 직접 타입 검사 없이 역직렬화하며 dispatch.gen.rs 를
 * 거치지 않는다. dispatch.gen.rs 는 코드가 컴파일된다는 사실 자체로 그 fn 과 위치 인자로 이미
 * 일치가 강제되므로(스펙 필드 → parseRustField → 구조체 → 위치 인자 호출) 별도로 대조할 필요가
 * 없다 — 다만 `#[serde(default)]` 는 구조체 필드 속성이라 fn 파라미터에는 애초에 못 붙는다는
 * 점만 유의(그래서 fn 파라미터 쪽 판정은 "Option<T> 인가"만 본다).
 *
 * 미해결(unresolved) 케이스는 조용히 건너뛰지 않고 **개수로 보고**한다(§ 지시서: "찾지 못하면
 * 조용히 건너뛰는 검사기 자체가 또 하나의 무음 폴백이다"):
 *   - 스펙 커맨드에 대응하는 `#[tauri::command] fn` 을 못 찾음
 *   - 스펙 필드와 이름이 같은 Rust 파라미터가 없음(dispatch 는 위치 인자라 이름 불일치가 실제
 *     장애로 이어진다 — 자리 어긋남)
 *   - `input:` 필드 값이 문자열이 아니라 중첩 매핑(원시 타입 문자열 파서가 못 다룸)
 *
 * 베이스라인 갱신(의도적으로 새 드리프트를 허용/기존을 정리했을 때만):
 *   node scripts/check-command-contract.mjs --update
 * `--update` 는 (A) 만 스냅샷한다 — (B) 는 "위반"이 아니라 정보이므로 래칫하지 않는다(매 실행
 * 전량 출력).
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";

const SPECS_DIR = "specs/commands";
const RUST_ROOT = "src-tauri/src";
const BASELINE = "scripts/check-command-contract.allow.json";

function posix(p) {
  return p.replace(/\\/g, "/");
}

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const stat = statSync(p);
    if (stat.isDirectory()) walk(p, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(posix(p));
  }
  return out;
}

// ── 스펙 파싱 ────────────────────────────────────────────────────────────────
function loadSpecCommands() {
  const commands = {}; // cmdName -> { file, fields: { fieldName: rawType(string) }, complexFields: string[] }
  const files = readdirSync(SPECS_DIR).filter(
    (f) => f.endsWith(".yaml") && f !== "_conventions.yaml"
  );
  for (const file of files) {
    const doc = yaml.parse(readFileSync(join(SPECS_DIR, file), "utf8"));
    if (!doc.commands) continue;
    for (const [cmdName, spec] of Object.entries(doc.commands)) {
      const fields = {};
      const complexFields = [];
      const inputObj = spec.input && typeof spec.input === "object" ? spec.input : null;
      if (spec.input && typeof spec.input === "string") {
        // 커맨드 전체 input 이 매핑이 아니라 원시 타입 문자열인 경우 — 이 저장소엔 현재 0건이지만
        // (2026-09-26 확인) 생기면 필드 단위 비교가 불가능하므로 "미해결"로만 집계한다.
        complexFields.push("<input 전체가 문자열 타입>");
      } else if (inputObj) {
        for (const [fieldName, rawType] of Object.entries(inputObj)) {
          if (typeof rawType === "string") fields[fieldName] = rawType;
          else complexFields.push(fieldName); // 중첩 매핑 — omit 개념이 적용 안 됨, 건너뜀
        }
      }
      commands[cmdName] = { file, fields, complexFields };
    }
  }
  return commands;
}

// ── TS-optional 판정 — scripts/gen-commands.mjs 의 parseProperty 를 그대로 미러링.
// 순서가 중요하다(그 파일의 주석과 동일한 이유): 트레일링 `|omit`(등호 있든 없든) 접미사를 먼저
// 떼어내고, 남은 문자열의 트레일링 `?` 를 그 다음에 본다 — "integer(1..12)?|omit=..." 처럼 `?` 가
// `|omit=` **앞**에 오는 표기가 실제로 있어서, 원래 문자열 그대로에서 `?` 만 먼저 봤다면 절대 못
// 벗겨진다. 맨 `|omit`(등호 없음, 예: `api_key: "string|omit"`)도 **optional 로 친다** —
// parseProperty 의 2026-09-26 수정과 동일(D1 근본 원인: 예전엔 맨 `|omit` 이 유니온 분기로 떨어져
// `string | 'omit'` 처럼 required 유니온-리터럴로 새어나갔다).
function tsOptional(rawType) {
  const str = String(rawType);
  if (/\|omit(?:=.*)?$/.test(str)) return true;
  if (str.endsWith("?")) return true;
  return false;
}

// ── Rust 커맨드 함수 인덱스 ──────────────────────────────────────────────────
// `#[tauri::command(...)]`(괄호 있음/없음 둘 다) 바로 다음에 오는 `fn NAME(...)` 를 찾는다.
// 사이에 다른 속성 줄(`#[allow(...)]` 등)이나 라인 주석이 끼는 건 허용한다(실제로 그렇다 —
// ai_generate_from_prompt 는 #[tauri::command] 다음 줄에 #[allow(clippy::too_many_arguments)]).
// _inner 변형은 이 앞에 자기 attribute 가 없으므로(관찰: ai_generate_from_prompt_inner 는 attribute
// 없이 바로 위에 있다) 애초에 이 스캔에 걸리지 않는다 — cmdName 으로 따로 찾는 게 아니라 attribute
// 를 앵커로 그 다음 fn 하나만 보기 때문에 접두어 충돌(예: X vs X_ext) 도 생기지 않는다.
const CMD_ATTR_RE = /#\[\s*tauri::command(?:\([^)]*\))?\s*\]/g;
const AFTER_ATTR_RE =
  /^(?:\s*#\[[^\]]*\]|\s*\/\/\/?[^\n]*)*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;

// 깊이 인식 콤마 분리 — Rust 파라미터 목록의 콤마가 `Option<Vec<String>>` 나
// `tauri::State<'_, AppState>` 의 제네릭 콤마와 섞이지 않게 `(){}[]<>` 전부의 깊이를 센다.
function splitTopLevelRust(str) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

// `fn NAME` 의 이름 끝 위치에서 시작해 파라미터 목록을 여는 `(` 의 인덱스를 찾는다 — 제네릭
// `<...>` 절(예: `fn foo<T: Trait>(`)이 있으면 그 균형 잡힌 `>` 까지 건너뛴다.
function findParamsOpenParen(text, fromIdx) {
  let i = fromIdx;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === "<") {
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === "<") depth++;
      else if (text[i] === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  return text[i] === "(" ? i : -1;
}

function findMatchingParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Tauri/프레임워크가 주입하는 파라미터 — 스펙 필드가 이 이름과 겹칠 일이 없으므로 그냥 걸러낸다.
function isFrameworkParam(type) {
  return /\b(State|AppHandle|Window|WebviewWindow|Webview|Runtime)\b/.test(type);
}

function parseRustParams(paramsText) {
  const params = {};
  for (const raw of splitTopLevelRust(paramsText)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    if (chunk === "&self" || chunk === "self" || chunk === "&mut self") continue;
    const colonIdx = chunk.indexOf(":");
    if (colonIdx === -1) continue; // self 등 콜론 없는 파라미터
    let name = chunk.slice(0, colonIdx).trim();
    name = name.replace(/^mut\s+/, "").replace(/^r#/, "");
    const type = chunk.slice(colonIdx + 1).trim();
    if (isFrameworkParam(type)) continue;
    params[name] = { rustType: type, isOption: /^Option\s*<[\s\S]*>$/.test(type) };
  }
  return params;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

// 파일 전체에서 주석을 제거한 사본을 만든다 — 원문과 길이·줄바꿈 위치를 그대로 유지해(문자를
// 공백으로 치환, 개행은 개행으로 보존) `lineNumber()` 계산이 원문 인덱스와 어긋나지 않게 한다.
// 실제로 걸린 사고: `note_region_add`/`note_date_add`/`note_date_update`/`note_query` 의 파라미터
// 앞에 붙은 한국어 설명 주석이 콤마·콜론을 포함한다("스펙(notes.yaml)도 number 로 맞춰 두었고,
// 생성기는 …" 의 콤마, "…nl-dates.md): 관련 날짜 라벨" 의 콜론) — 주석을 제거하지 않고 파싱하면
// 그 콤마가 파라미터 경계로, 그 콜론이 "이름:타입" 경계로 오인되어 `lat`/`label`/`coords` 가
// 전혀 다른 이름(주석 텍스트 자체)으로 잘못 추출됐다(처음 구현에서 실제로 이렇게 나서 잡았다).
function stripComments(text) {
  const out = new Array(text.length);
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out[i] = text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    out[i] = text[i];
    i++;
  }
  return out.join("");
}

function buildRustCommandIndex() {
  const index = {}; // cmdName -> { file, line, params }
  const conflicts = [];
  for (const file of walk(RUST_ROOT, [".rs"])) {
    const text = stripComments(readFileSync(file, "utf8"));
    CMD_ATTR_RE.lastIndex = 0;
    let m;
    while ((m = CMD_ATTR_RE.exec(text))) {
      const after = text.slice(m.index + m[0].length);
      const nameMatch = after.match(AFTER_ATTR_RE);
      if (!nameMatch) continue; // attribute 다음에 fn 을 못 찾음 — 형식이 예상과 다름, 건너뜀
      const name = nameMatch[1];
      const nameEndInAfter = nameMatch.index + nameMatch[0].length;
      const openParen = findParamsOpenParen(after, nameEndInAfter);
      if (openParen === -1) continue;
      const closeParen = findMatchingParen(after, openParen);
      if (closeParen === -1) continue;
      const params = parseRustParams(after.slice(openParen + 1, closeParen));
      const line = lineNumber(text, m.index);
      if (index[name]) {
        conflicts.push({ name, files: [index[name].file, file] });
        continue; // 먼저 찾은 것을 신뢰(선착순) — 중복은 conflicts 로 보고
      }
      index[name] = { file, line, params };
    }
  }
  return { index, conflicts };
}

// ── 파서 자가 검증 — scripts/ 에 테스트 파일을 두는 관례가 없으므로(check-surface-contract.mjs
// 의 settingsLineSelfTest 와 같은 이유) 손으로 만든 fixture 로 이 파일 안에서 검증한다. 특히
// "주석 안의 콤마/콜론이 파라미터 경계를 깨뜨린다" 회귀(위 stripComments 주석 참고, 처음 구현에서
// note_region_add.lat 등 4개가 실제로 이렇게 깨졌었다)를 다시 잡아낸다.
function parserSelfTest() {
  // stripComments: 길이 불변(공백 치환이라 인덱스가 안 밀림), 개행 보존, 주석 내용물(콤마·콜론
  // 포함)이 사라지고 코드 토큰은 그대로 남는다. 정확한 공백 개수가 아니라 "이 토큰이 남았는가/
  // 사라졌는가"만 본다 — 손으로 공백 수를 세는 건 그 자체로 깨지기 쉽다.
  const commentCases = [
    { src: "let x = 1; // 콤마, 콜론: 포함", mustKeep: ["let x = 1;"], mustDrop: ["콤마", "콜론"] },
    { src: "/* 블록 주석 */ y", mustKeep: ["y"], mustDrop: ["블록 주석"] },
    { src: "a /* 여러\n줄 */ b", mustKeep: ["a", "b"], mustDrop: ["여러", "줄"], keepLines: 2 },
  ];
  for (const { src, mustKeep, mustDrop, keepLines } of commentCases) {
    const got = stripComments(src);
    if (got.length !== src.length) {
      throw new Error(
        `check-command-contract selftest(stripComments): 길이가 원문과 달라졌습니다 — "${src}"`
      );
    }
    for (const tok of mustKeep) {
      if (!got.includes(tok)) {
        throw new Error(
          `check-command-contract selftest(stripComments): "${tok}" 이 사라졌습니다 — "${src}" -> "${got}"`
        );
      }
    }
    for (const tok of mustDrop) {
      if (got.includes(tok)) {
        throw new Error(
          `check-command-contract selftest(stripComments): 주석 내용 "${tok}" 이 안 지워졌습니다 — "${src}" -> "${got}"`
        );
      }
    }
    if (keepLines && got.split("\n").length !== keepLines) {
      throw new Error(
        `check-command-contract selftest(stripComments): 개행 수가 보존되지 않았습니다 — "${src}" -> "${got}"`
      );
    }
  }

  // parseRustParams: 실제로 걸렸던 형태 그대로 — 파라미터 앞 한국어 주석에 콤마/콜론이 섞여도
  // 그 다음 파라미터의 이름·타입이 정확히 뽑혀야 한다.
  const paramsSrc = stripComments(
    [
      "state: State<AppState>,",
      "note_id: String,",
      "name: String,",
      "// 설명(참고.txt)도 맞춰 두었고, 생성기는 lat/lng 필드를",
      "// 항상 f64 로 내보내므로(gen-commands.mjs) 이렇게 둔다: 이유는 위 참고.",
      "lat: f64,",
      "lng: f64,",
      "coords: Option<NoteQueryCoordsArg>,",
      "position: i64,",
    ].join("\n")
  );
  const parsed = parseRustParams(paramsSrc);
  for (const [name, expectType, expectOption] of [
    ["note_id", "String", false],
    ["lat", "f64", false],
    ["coords", "Option<NoteQueryCoordsArg>", true],
    ["position", "i64", false],
  ]) {
    if (!parsed[name]) {
      throw new Error(
        `check-command-contract selftest(parseRustParams): "${name}" 파라미터를 못 찾았습니다 — ` +
          "주석 안 콤마/콜론이 다시 경계를 깨뜨렸는지 확인하세요."
      );
    }
    if (parsed[name].rustType !== expectType || parsed[name].isOption !== expectOption) {
      throw new Error(
        `check-command-contract selftest(parseRustParams): "${name}" 기대 ${expectType}` +
          `(option=${expectOption}) != 실제 ${parsed[name].rustType}(option=${parsed[name].isOption})`
      );
    }
  }
  if (parsed.state) {
    throw new Error(
      "check-command-contract selftest(parseRustParams): 프레임워크 주입 파라미터(state)가 " +
        "걸러지지 않았습니다."
    );
  }

  // tsOptional: |omit= 도, 맨 |omit(등호 없음)도, 트레일링 ? 도 전부 optional(2026-09-26 수정
  // 이후 gen-commands.mjs 의 실제 동작 — 헤더 주석 참고). 순서 케이스: "?" 가 "|omit=" 보다
  // 먼저 오는 표기, 유니온 뒤에 맨 |omit 이 붙는 표기 모두 정상 인식돼야 한다.
  const tsCases = [
    ["string", false],
    ["string?", true],
    ["string|omit", true], // 2026-09-26 정정 — 예전엔 여기가 false 였다(버그를 그대로 미러링).
    ["string?|omit", true], // ai_get_usage.since 실측 표기 — bare omit 앞에 ?가 와도 optional.
    ["'a'|'b'|omit", true], // ai_generate_from_prompt.purpose 형태 — 유니온 뒤 맨 omit.
    ["string|omit=settings.ai_provider", true],
    ["integer(1..12)?|omit=settings.x", true],
    ["string|null", false],
  ];
  for (const [raw, want] of tsCases) {
    const got = tsOptional(raw);
    if (got !== want) {
      throw new Error(
        `check-command-contract selftest(tsOptional): "${raw}" 기대 ${want} != 실제 ${got}`
      );
    }
  }
}
parserSelfTest();

// ── 자가 검증 — 2026-09-26까지는 gen-commands.mjs 의 FORCE_REQUIRED_FIELDS(ai_translate_text/
// ai_cleanup_text/ai_generate_from_prompt 의 `provider`)를 실측 소스에서 뽑아 대조했다. 그 세
// 필드는 스펙의 `|omit=settings.ai_provider`(거짓 폴백)를 이 상수로 눌러 두던 것이었는데, 이제
// 스펙 자체에서 그 omit 표기를 지웠으므로(specs/commands/ai.yaml) TS-optional 판정만으로 이미
// required 로 나온다 — FORCE_REQUIRED_FIELDS 도 이 함수도 더 이상 필요 없다. 대신 그 세 필드 +
// ai_organize_note.provider(스펙에 애초에 `|omit` 표기가 없고 주석에만 있었음, 대조군) 를 직접
// 하드코딩해 대조한다 — 이 넷의 관계(셋은 이제 정상적으로 required, 하나는 원래도 required)가
// TS-optional 판정 로직이 맞다는 회귀 신호다. 이 자가 검증이 깨지면 스캐너 자체의 논리가
// 잘못된 것이니 결과를 신뢰하지 말라는 신호다.
const SPEC_FIXED_REQUIRED_PROVIDER_FIELDS = [
  "ai_translate_text.provider",
  "ai_cleanup_text.provider",
  "ai_generate_from_prompt.provider",
];

function selfTest(violations) {
  const violationKeys = new Set(violations.map((v) => `${v.command}.${v.field}`));
  for (const key of [...SPEC_FIXED_REQUIRED_PROVIDER_FIELDS, "ai_organize_note.provider"]) {
    if (violationKeys.has(key)) {
      throw new Error(
        `check-command-contract selftest 실패: ${key} 는 위반이 아니어야 합니다 ` +
          "(스펙이 이제 |omit 없이 정직하게 required 를 적고 있고, Rust 도 required 입니다) " +
          "— TS-optional 판정 로직을 의심하세요."
      );
    }
  }
}

// ── 본체 ────────────────────────────────────────────────────────────────────
const specCommands = loadSpecCommands();
const { index: rustIndex, conflicts } = buildRustCommandIndex();

const violations = []; // (A) required_drift — 래칫 대상
const informational = []; // (B) reverse — 절대 게이트 안 막음
const unresolvedCommands = []; // 스펙엔 있는데 Rust fn 을 못 찾음
const unmatchedFields = []; // fn 은 찾았는데 그 이름의 파라미터가 없음
const complexFieldNotes = []; // input 필드가 문자열이 아닌 중첩 매핑이라 판정 불가

for (const [cmdName, spec] of Object.entries(specCommands)) {
  if (spec.complexFields.length) {
    for (const f of spec.complexFields) complexFieldNotes.push({ command: cmdName, field: f });
  }
  const fieldNames = Object.keys(spec.fields);
  if (fieldNames.length === 0) continue;
  const rustCmd = rustIndex[cmdName];
  if (!rustCmd) {
    unresolvedCommands.push(cmdName);
    continue;
  }
  for (const fieldName of fieldNames) {
    const rawType = spec.fields[fieldName];
    const optional = tsOptional(rawType);
    const rustParam = rustCmd.params[fieldName];
    if (!rustParam) {
      unmatchedFields.push({ command: cmdName, field: fieldName, file: rustCmd.file });
      continue;
    }
    if (optional && !rustParam.isOption) {
      violations.push({
        command: cmdName,
        field: fieldName,
        specType: rawType,
        rustType: rustParam.rustType,
        file: rustCmd.file,
        line: rustCmd.line,
      });
    } else if (!optional && rustParam.isOption) {
      informational.push({
        command: cmdName,
        field: fieldName,
        specType: rawType,
        rustType: rustParam.rustType,
        file: rustCmd.file,
        line: rustCmd.line,
      });
    }
  }
}

selfTest(violations);

violations.sort((a, b) => `${a.command}.${a.field}`.localeCompare(`${b.command}.${b.field}`));
informational.sort((a, b) => `${a.command}.${a.field}`.localeCompare(`${b.command}.${b.field}`));

// ── --update: (A) 만 스냅샷한다. (B) 는 "위반"이 아니라 정보이므로 래칫하지 않는다.
if (process.argv.includes("--update")) {
  const snapshot = {
    _comment:
      "check-command-contract.mjs 스냅샷 — (A) required_drift 만 담는다(TS-optional인데 Rust가 " +
      "Option이 아닌 필드). --update 로 재생성. 정보용 (B) reverse 카테고리는 여기 없다(항상 " +
      "전량 출력, 게이트를 막지 않음).",
    violations: violations.map((v) => `${v.command}.${v.field}`).sort(),
  };
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `check-command-contract: 베이스라인 갱신 — required_drift ${snapshot.violations.length}건 기록.`
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`check-command-contract: 베이스라인이 없습니다(${BASELINE}).`);
  console.error("먼저 `node scripts/check-command-contract.mjs --update` 로 생성하세요.");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const baselineSet = new Set(baseline.violations ?? []);

function printTable(title, rows) {
  console.log(`\n${title} (${rows.length}건)`);
  for (const v of rows) {
    console.log(
      `  - ${v.command}.${v.field}: spec="${v.specType}" rust="${v.rustType}" (${v.file}:${v.line})`
    );
  }
}

let failed = false;
const newViolations = violations.filter((v) => !baselineSet.has(`${v.command}.${v.field}`));

console.log("check-command-contract: audit §3 G6 — 커맨드 계약 표류(TS-optional vs Rust 필수) 검사.");
printTable("(A) required_drift — TS-optional 인데 Rust 가 Option 이 아님(위반, 래칫 대상)", violations);
if (newViolations.length) {
  failed = true;
  console.error(
    `\ncheck-command-contract: 베이스라인에 없는 새 required_drift ${newViolations.length}건.`
  );
  for (const v of newViolations) {
    console.error(`  - ${v.command}.${v.field}: spec="${v.specType}" rust="${v.rustType}"`);
  }
  console.error(
    "\n네이티브 invoke() 는 dispatch.gen.rs 를 거치지 않고 이 fn 시그니처로 바로 역직렬화합니다 —\n" +
      "그 필드를 생략하면 그 자리에서 거부됩니다. Rust 파라미터를 Option<T> 로 바꾸거나(그리고 fn\n" +
      "본문에서 기본값 처리), 스펙에서 optional 표기를 지워 필수로 되돌리세요.\n" +
      "의도된 기존 표류라면 `node scripts/check-command-contract.mjs --update` 로 베이스라인에 넣으세요."
  );
}

printTable(
  "(B) reverse — TS-required 인데 Rust 는 Option (정보용, 게이트를 막지 않음)",
  informational
);

if (unresolvedCommands.length) {
  console.log(
    `\n(미해결) 스펙 커맨드인데 대응하는 #[tauri::command] fn 을 못 찾음 (${unresolvedCommands.length}건):`
  );
  for (const c of unresolvedCommands) console.log(`  - ${c}`);
  // 리뷰(2026-09-26): 헤더의 "조용히 건너뛰지 않는다"와 달리 예전엔 출력만 하고 통과했다. 지금 0건이라
  // 베이스라인 없이 바로 실패로 둔다(새로 생기면 곧장 막힌다).
  failed = true;
}
if (unmatchedFields.length) {
  console.log(
    `\n(미해결) Rust fn 은 찾았는데 같은 이름의 파라미터가 없는 스펙 필드 (${unmatchedFields.length}건) — ` +
      "dispatch 는 위치 인자로 호출하므로 이름 불일치는 인자 자리가 밀리는 실제 장애입니다:"
  );
  for (const f of unmatchedFields) console.log(`  - ${f.command}.${f.field} (${f.file})`);
  failed = true;
}
if (complexFieldNotes.length) {
  console.log(
    `\n(판정 불가) input 필드가 문자열이 아닌 중첩 매핑이라 omit 여부를 못 봄 (${complexFieldNotes.length}건):`
  );
  for (const f of complexFieldNotes) console.log(`  - ${f.command}.${f.field}`);
}
if (conflicts.length) {
  console.log(`\n(참고) 같은 이름의 #[tauri::command] fn 이 여러 파일에 있음 (${conflicts.length}건):`);
  for (const c of conflicts) console.log(`  - ${c.name}: ${c.files.join(", ")}`);
}

if (failed) process.exit(1);

console.log(
  `\ncheck-command-contract: OK — required_drift ${violations.length}건 모두 베이스라인 이내.`
);
if (violations.length < baselineSet.size) {
  console.log(
    "  ↳ required_drift 가 베이스라인보다 줄었습니다 — " +
      "`node scripts/check-command-contract.mjs --update` 로 베이스라인을 내려 주세요."
  );
}
