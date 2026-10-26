import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { parseRustField, cliType, buildAgentTools } from './agent-tools.mjs';
export { parseRustField, cliType, buildAgentTools };

const SPECS_DIR = path.join(process.cwd(), 'specs', 'commands');
const OUT_FILE = path.join(process.cwd(), 'src', 'lib', 'commands.gen.ts');

const conventionsRaw = fs.readFileSync(path.join(SPECS_DIR, '_conventions.yaml'), 'utf8');
const conventionsDoc = yaml.parse(conventionsRaw);

const extraShapes = {};
const yamlFiles = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.yaml') && f !== '_conventions.yaml');
for (const file of yamlFiles) {
  const content = fs.readFileSync(path.join(SPECS_DIR, file), 'utf8');
  const doc = yaml.parse(content);
  if (doc.shared_types) {
    for (const [typeName, rawShape] of Object.entries(doc.shared_types)) {
      extraShapes[typeName] = rawShape;
    }
  }
}

// Split `str` on `sep` only at brace/bracket/angle depth 0 — a naive `.split(sep)` breaks on
// inline object-literal type strings like "{ id: string, items: { text: string } }" where the
// nested object's own comma/colon must not count as a top-level separator.
function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '{' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ']' || c === '>') depth--;
    else if (c === sep && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

// Parses an inline object-literal type string ("{ field: type, field2: type2 }", used for
// deeply nested/array-of-object shapes where native YAML mapping nesting would be awkward —
// e.g. phrase_packs_list's `packs` output field) field-by-field through the same parseProperty
// pipeline that already handles real YAML mapping objects correctly. Without this, such raw
// strings fell through mapBasic's catch-all and were emitted byte-for-byte, so a nested
// optional field written in the DSL's `field: type?` convention (see the `?`-stripping above)
// leaked straight into the generated TS as invalid `field: type?` instead of `field?: type`
// (root cause of the hand-patch in commit 9917f48 — this was previously only handled for the
// *input*-side Rust dispatch codegen's parseRustField, never for TS output types).
function parseInlineObjectLiteral(str) {
  const inner = str.slice(1, -1).trim();
  if (!inner) return '{}';
  // Single-line, comma-separated — matches the DSL authors' own compact convention for inline
  // (non-top-level) object types, unlike convertObject's multi-line `{\n  key: type;\n}` used
  // for actual `export interface` bodies.
  const props = splitTopLevel(inner, ',')
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      const [rawKey, ...rest] = splitTopLevel(field, ':');
      const { key, type } = parseProperty(rawKey.trim(), rest.join(':').trim());
      return `${key}: ${type}`;
    });
  return `{ ${props.join(', ')} }`;
}

function parseProperty(keyName, rawType) {
  if (rawType === null) return { key: keyName, type: 'null' };
  
  if (typeof rawType === 'object') {
    return { key: keyName, type: convertObject(rawType) };
  }

  let str = rawType.toString();
  let isOptional = false;

  // Order matters: strip the trailing `|omit` (or `|omit=<default>`) suffix first, then re-check
  // for a trailing `?` on what's left — a type like "integer(1..12)?|omit=..." has the `?`
  // *before* `|omit=`, so checking `?` only on the original string (old order) never stripped it,
  // leaking "integer(1..12)?" into the generated TS as an invalid type.
  //
  // The `|omit` suffix marks a field optional whether or not it names a default (`|omit=...`) —
  // a bare `|omit` (no `=`) means "omittable, no documented fallback" (e.g. `api_key: "string|omit"`,
  // host env var / settings takes over server-side). Before this fix, only the `=`-suffixed form
  // was recognized here (the *value* of `isOptional`), so a bare `|omit` fell all the way through
  // to the `str.includes('|')` union branch below and got emitted as a literal string union member
  // instead — `api_key: string | 'omit'` (required!) instead of `api_key?: string`. Every caller
  // that then wanted "no api_key" had to satisfy that bogus required type by passing the literal
  // string "omit" as the value, which is exactly the D1 bug (AUDIT-2026-09-26 §4): the literal
  // word "omit" was sent over IPC as if it were a real api_key. A trailing `?` *before* the bare
  // `|omit` (e.g. `since: "string?|omit"`) hit the same branch and came out even worse —
  // `'string?' | 'omit'` — because neither segment matched a recognized basic type, so both were
  // quoted as literal unions. This mirrors parseRustField's `str.indexOf('|omit')` below in this
  // same file, which never had this bug (it always treated bare `|omit` as optional).
  const omitMatch = str.match(/\|omit(?:=.*)?$/);
  if (omitMatch) {
    isOptional = true;
    str = str.slice(0, omitMatch.index);
  }

  if (str.endsWith('?')) {
    isOptional = true;
    str = str.slice(0, -1);
  }

  function mapBasic(t) {
    // Inline range annotations (e.g. "integer(1..12)") are documentation for the Rust-side
    // validator, not a TS-representable type — strip them before matching the basic type table.
    t = t.replace(/\([^)]*\)$/, '');
    if (t === 'uuid') return 'string';
    if (t === 'timestamp') return 'string';
    if (t === 'iso8601') return 'string';
    if (t === 'integer') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'string') return 'string';
    if (t === 'json') return 'unknown';
    return t;
  }

  let tsType;

  const mapMatch = str.match(/^map<([^,]+),\s*(.+)>$/);
  if (mapMatch) {
    const k = mapBasic(mapMatch[1]);
    const v = parseProperty('', mapMatch[2]).type;
    tsType = `Record<${k}, ${v}>`;
  } else if (str.endsWith('[]')) {
    const base = str.slice(0, -2);
    const parsedBase = parseProperty('', base).type;
    tsType = `${parsedBase}[]`;
  } else if (str.startsWith('{') && str.endsWith('}')) {
    tsType = parseInlineObjectLiteral(str);
  } else if (str.includes('|')) {
    const parts = str.split('|');
    const mappedParts = parts.map(p => {
      if (p === 'null') return 'null';
      if (['uuid', 'timestamp', 'iso8601', 'integer', 'boolean', 'string', 'json', 'number'].includes(p)) return mapBasic(p);
      if (['NoteSummary', 'NoteDetail', 'Section', 'Source', 'Attachment', 'Folder', 'Space', 'SpaceItem', 'SpaceItemsResult', 'SpaceItemSeed', 'SpaceItemMove'].includes(p) || p in conventionsDoc.shared_shapes || p in extraShapes) return p;
      if (p.startsWith("'") && p.endsWith("'")) return p;
      return `'${p}'`;
    });
    tsType = mappedParts.join(' | ');
  } else {
    tsType = mapBasic(str);
  }

  const finalKey = isOptional ? `${keyName}?` : keyName;
  return { key: finalKey, type: tsType };
}

// per-file `shared_types` blocks (e.g. workspaces.yaml) declare a shape as a single
// raw string ("{ id: uuid, name: string, ... }") rather than a nested YAML mapping
// like _conventions.yaml's shared_shapes. Parse that string into a plain object so
// it can be run through the normal convertObject/parseProperty pipeline.
function parseRawShape(raw) {
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  const obj = {};
  if (!inner) return obj;
  // depth-aware split — `field: { nested: type }[]` 같은 inline 객체 리터럴 안의 �마가
  // top-level 분리자를 깨뜨리지 않도록. parseInlineObjectLiteral 과 같은 splitTopLevel 사용.
  for (const field of splitTopLevel(inner, ',')) {
    const idx = field.indexOf(':');
    if (idx === -1) continue;
    const key = field.slice(0, idx).trim();
    const type = field.slice(idx + 1).trim();
    obj[key] = type;
  }
  return obj;
}

function convertObject(obj) {
  if (typeof obj !== 'object' || obj === null) return 'unknown';
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  const props = [];
  for (const [k, v] of entries) {
    const { key, type } = parseProperty(k, v);
    props.push(`  ${key}: ${type};`);
  }
  return `{\n${props.join('\n')}\n}`;
}

function processInput(inp) {
  if (typeof inp === 'string') {
    return parseProperty('', inp).type;
  } else if (typeof inp === 'object' && inp !== null) {
    if (Object.keys(inp).length === 0) return '{}';
    return convertObject(inp);
  } else {
    return '{}';
  }
}

function processOutput(out) {
  if (typeof out === 'string') {
    return parseProperty('', out).type;
  } else {
    return convertObject(out);
  }
}

let tsContent = `// AUTO-GENERATED — DO NOT EDIT

export type AppError = { code: "NOT_FOUND"|"VALIDATION"|"CONFLICT"|"IO"|"DB"; message: string };

`;

for (const [name, shape] of Object.entries(conventionsDoc.shared_shapes)) {
  tsContent += `export interface ${name} ${convertObject(shape)}\n\n`;
}

const allCommands = {};
const commandFile = {};   // cmdName -> originating specs/commands/*.yaml (for dispatch module inference)
const files = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.yaml') && f !== '_conventions.yaml');

for (const file of files) {
  const content = fs.readFileSync(path.join(SPECS_DIR, file), 'utf8');
  const doc = yaml.parse(content);
  if (doc.commands) {
    for (const [cmdName, cmdSpec] of Object.entries(doc.commands)) {
      if (doc.http === false && cmdSpec.http === undefined) {
        cmdSpec.http = false;
      }
      allCommands[cmdName] = cmdSpec;
      commandFile[cmdName] = file;
    }
  }
}

for (const [name, rawShape] of Object.entries(extraShapes)) {
  const shape = typeof rawShape === 'string' ? parseRawShape(rawShape) : rawShape;
  tsContent += `export interface ${name} ${convertObject(shape)}\n\n`;
}

const sortedCommandNames = Object.keys(allCommands).sort();

for (const cmdName of sortedCommandNames) {
  const spec = allCommands[cmdName];
  
  const inputName = cmdName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Input';
  const outputName = cmdName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Output';
  
  const inType = processInput(spec.input);
  const outType = processOutput(spec.output);

  tsContent += `export interface ${inputName} ${inType}\n`;
  if (outType.startsWith('{')) {
    tsContent += `export interface ${outputName} ${outType}\n\n`;
  } else {
    tsContent += `export type ${outputName} = ${outType};\n\n`;
  }
}

tsContent += `export type CommandName =\n  | ` + sortedCommandNames.map(c => `'${c}'`).join('\n  | ') + `;\n`;

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, tsContent);
console.log('Successfully generated src/lib/commands.gen.ts');

// ─────────────────────────────────────────────────────────────────────────
// dispatch.gen.rs — HTTP surface for the sync server (POST /api/v1/invoke).
// One match arm per command with `http: true` (the default — see _conventions.yaml
// "http flag"). Commands that need a Window/dialog, touch a local-FS path arg, are
// destructive+machine-local, or control server/OS lifecycle are `http: false` in
// their spec file and simply have no arm here (falls through to UnknownCommand).
// ─────────────────────────────────────────────────────────────────────────
const DISPATCH_OUT_FILE = path.join(process.cwd(), 'src-tauri', 'src', 'sync_server', 'dispatch.gen.rs');

// specs/commands/*.yaml file -> commands::<module> that implements it. A command whose
// module differs from its spec file's default (taxonomy.rs commands live in workspaces.yaml)
// is listed in MODULE_OVERRIDES.
const YAML_FILE_TO_MODULE = {
  'notes.yaml': 'notes',
  'sections.yaml': 'sections',
  'sources.yaml': 'sources',
  'attachments.yaml': 'attachments',
  'search.yaml': 'search',
  'settings.yaml': 'settings',
  'workspaces.yaml': 'workspaces',
  'export.yaml': 'transfer',
  'migrate.yaml': 'migrate',
  'ai.yaml': 'ai',
  'geocode.yaml': 'geocode',
  'weather.yaml': 'weather',
  'sync.yaml': 'sync',
  'dictation.yaml': 'dictation',
  // dashboard.yaml 은 Wave 3 내내 전 커맨드가 http:false 라 이 표에 오를 일이 없었다.
  // 2026-08-02 에 http 를 열면서 처음 필요해졌다 — 6개 전부 commands::dashboard 에 있다.
  'dashboard.yaml': 'dashboard',
  'suggestions.yaml': 'suggestions',
  'collect.yaml': 'collect',
  'space.yaml': 'spaces',
  'routine.yaml': 'routine',
  'timeline_routines.yaml': 'timeline_routine',
  'calendar_marks.yaml': 'calendar_marks',
  'diag.yaml': 'diag',
  'pet.yaml': 'pet',  // 채팅 코어만 http:true (2026-10-06)
  'transcribe.yaml': 'audio_transcribe',  // 오디오 전사 (S2-3b, 2026-10-06)
  'snapshots.yaml': 'snapshots',  // capture 만 http:true — 폰 편집에도 스냅샷 (2026-10-07)
};
const MODULE_OVERRIDES = {
  workspace_region_list: 'taxonomy', workspace_region_add: 'taxonomy', workspace_region_remove: 'taxonomy',
  workspace_era_list: 'taxonomy', workspace_era_add: 'taxonomy', workspace_era_remove: 'taxonomy',
  workspace_status_list: 'taxonomy', workspace_status_add: 'taxonomy', workspace_status_remove: 'taxonomy',
  workspace_status_rename: 'taxonomy',
};

// Commands whose Tauri fn takes no `State<AppState>` at all (pure network/no-DB commands).
// ai_test_connection used to be here too, until the P1 SSRF fix (2026-07-30) gave it a privacy
// gate that needs to read ai_enabled from settings — it now takes state like its ai_* siblings.
const NO_STATE_COMMANDS = new Set(['geocode_search', 'geocode_reverse', 'geo_timezone', 'ai_test_connection_before_enable', 'weather_forecast', 'diag_record', 'ai_cancel_call']);

// commands::ai's fns all take `state: tauri::State<'_, AppState>` as their LAST parameter
// (every other module puts it first) — the propose/apply pair especially reads more naturally
// with the note id leading, per that module's own convention.
const STATE_LAST_COMMANDS = new Set([
  'ai_organize_note', 'ai_apply_organize', 'ai_translate_text', 'ai_cleanup_text',
  'ai_generate_from_prompt', 'ai_get_history', 'ai_test_connection',
  // 채팅 코어(commands/pet.rs, 2026-10-06 원격 개방) — AppHandle 파라미터 없음, state 가 마지막.
  'pet_chat', 'pet_chat_history', 'pet_chat_clear', 'pet_session_list', 'pet_session_new',
  'pet_session_open', 'pet_chat_rewind', 'pet_chat_delete',
  'pet_note_create', 'pet_conversation_save',
]);

// Commands whose Tauri fn is `pub async fn` (needs `.await` at the call site).
const ASYNC_COMMANDS = new Set([
  'ai_organize_note', 'ai_test_connection', 'ai_translate_text', 'ai_cleanup_text',
  'ai_generate_from_prompt', 'attachment_fetch_reader', 'attachment_thumbs',
  'attachment_thumbs_for_ids', 'db_stats', 'geocode_search', 'geocode_reverse',
  'geo_timezone', 'ai_test_connection_before_enable',
  'weather_forecast',
  // 대시보드 무거운 읽기(commands/dashboard.rs) — SCALABILITY.md §3 규칙에 따라
  // spawn_blocking 으로 옮겼다. 인자/출력은 그대로이고 호출부에 .await 만 붙는다.
  'dashboard_board', 'dashboard_calendar', 'dashboard_timeline', 'dashboard_graph',
  // P2 3단계 링크 후행 제안(commands/suggestions.rs) — web_reader::fetch_reader +
  // TextTransport::send_text 둘 다 await. link_preview 는 같은 파이프라인을 저장 없이
  // 돌려주는 형제(펫 클립보드 저장, PLAN-2026-08-08 Q9)라 마찬가지로 async.
  'link_suggest', 'link_preview',
  // P3 수집 관문 자연어 소스 추가(commands/collect.rs) — TextTransport::send_text await.
  'collect_source_add_nl',
  // 채팅 코어 — 프로바이더 왕복(pet_chat) / 요약 AI 호출(pet_conversation_save).
  'pet_chat', 'pet_conversation_save',
  // 오디오 전사(commands/audio_transcribe.rs) — AudioTransport::send_audio await.
  'audio_transcribe',
  // 전역 검색(commands/search.rs) — L-5: sync 커맨드가 메인 스레드를 막던 것을 async 로. 호출부에 .await 만 붙는다.
  'search_notes',
  // 배치 note_get(commands/notes.rs) — 노트 수백 개의 본문을 읽으므로 동기(메인 스레드)로 두지 않는다.
  'note_get_many',
]);

// A handful of fields where the spec DSL's type string doesn't determine the exact Rust
// parameter type the command fn actually takes (custom tagged-union args, or a primitive
// width that differs from the DSL's usual integer->i64 mapping). Keyed "cmd.field".
// This is the generator's one deliberate escape hatch (see task notes) — everything else
// is derived mechanically from the spec so a signature drift trips the exhaustiveness
// throw below instead of silently generating a non-compiling arm.
// parseRustField and RUST_TYPE_OVERRIDES are imported from scripts/agent-tools.mjs


function pascalCase(cmdName) {
  return cmdName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

const httpCommandNames = sortedCommandNames.filter(name => allCommands[name].http !== false);

let dispatchArms = '';
for (const cmdName of httpCommandNames) {
  const spec = allCommands[cmdName];
  const file = commandFile[cmdName];
  const module = MODULE_OVERRIDES[cmdName] || YAML_FILE_TO_MODULE[file];
  if (!module) {
    throw new Error(`dispatch codegen: no module mapping for command "${cmdName}" (file ${file})`);
  }

  const inputObj = (spec.input && typeof spec.input === 'object') ? spec.input : {};
  const fieldNames = Object.keys(inputObj);
  const fields = fieldNames.map(f => ({ name: f, ...parseRustField(cmdName, f, inputObj[f]) }));

  const structName = `${pascalCase(cmdName)}Args`;
  const structFields = fields.map(f => {
    const ty = f.optional ? `Option<${f.rust}>` : f.rust;
    const attr = f.optional ? '                #[serde(default)]\n' : '';
    return `${attr}                pub ${f.name}: ${ty},`;
  }).join('\n');

  const callArgs = fields.map(f => `a.${f.name}`);
  let allCallArgsList;
  if (NO_STATE_COMMANDS.has(cmdName)) {
    allCallArgsList = callArgs;
  } else if (STATE_LAST_COMMANDS.has(cmdName)) {
    allCallArgsList = [...callArgs, 'state'];
  } else {
    allCallArgsList = ['state', ...callArgs];
  }
  const allCallArgs = allCallArgsList.join(', ');
  const awaitKw = ASYNC_COMMANDS.has(cmdName) ? '.await' : '';
  const stateLine = NO_STATE_COMMANDS.has(cmdName) ? '' : '            let state = app.state::<crate::commands::AppState>();\n';

  const argsVar = fields.length === 0 ? '_a' : 'a';
  dispatchArms += `        "${cmdName}" => {
            #[derive(serde::Deserialize)]
            struct ${structName} {
${structFields || '                #[allow(dead_code)] _unused: Option<()>,'}
            }
            let ${argsVar}: ${structName} = serde_json::from_value(args)
                .map_err(|e| DispatchError::BadArgs(e.to_string()))?;
${stateLine}            let out = crate::commands::${module}::${cmdName}(${allCallArgs})${awaitKw}?;
            serde_json::to_value(out).map_err(|e| DispatchError::BadArgs(e.to_string()))
        }
`;
}

const dispatchContent = `// AUTO-GENERATED by scripts/gen-commands.mjs from specs/commands/*.yaml — DO NOT EDIT.
// One match arm per command with \`http: true\` (default). See specs/commands/_conventions.yaml
// "http flag" and docs/CLIENT-RULES.md §2 for the http:false exclusion classes.
use tauri::Manager;

#[derive(Debug)]
pub enum DispatchError {
    UnknownCommand,
    BadArgs(String),
    Command(crate::error::AppError),
}

impl From<crate::error::AppError> for DispatchError {
    fn from(e: crate::error::AppError) -> Self {
        DispatchError::Command(e)
    }
}

/// Generic over \`R: tauri::Runtime\` so tests can drive it with \`tauri::test::mock_app()\`
/// (MockRuntime) while production code passes the real (Wry) AppHandle — State<AppState> itself
/// carries no runtime type parameter, only Manager::state() does.
pub async fn dispatch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cmd: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, DispatchError> {
    match cmd {
${dispatchArms}        _ => Err(DispatchError::UnknownCommand),
    }
}
`;

fs.mkdirSync(path.dirname(DISPATCH_OUT_FILE), { recursive: true });
fs.writeFileSync(DISPATCH_OUT_FILE, dispatchContent);
console.log(`Successfully generated src-tauri/src/sync_server/dispatch.gen.rs (${httpCommandNames.length} http:true commands)`);

// ─────────────────────────────────────────────────────────────────────────
// cli/commands.gen.json — 인자 매니페스트. cli/brise.mjs 가 이걸 읽어 플래그를 만든다.
// 대상 집합은 dispatch.gen.rs 와 **같다**(httpCommandNames) — CLI 는 POST /api/v1/invoke 로만
// 말하므로 디스패치 arm 이 없는 커맨드는 구조적으로 도달 불가다.
// 손으로 적지 않고 여기서 뽑는 이유가 이 파일 전체의 존재 이유와 같다: 플래그 이름이
// specs/commands/*.yaml 에서 갈라질 수 없게(docs/CLI.md 규칙 2).
// ─────────────────────────────────────────────────────────────────────────
const CLI_OUT_FILE = path.join(process.cwd(), 'cli', 'commands.gen.json');

const cliCommands = {};
for (const cmdName of httpCommandNames) {
  const spec = allCommands[cmdName];
  const inputObj = (spec.input && typeof spec.input === 'object') ? spec.input : {};
  cliCommands[cmdName] = {
    group: commandFile[cmdName].replace(/\.yaml$/, ''),
    doc: String(spec.notes ?? '').trim().split('\n')[0].slice(0, 160),
    args: Object.keys(inputObj).map((f) => {
      const { optional, rust } = parseRustField(cmdName, f, inputObj[f]);
      return { name: f, ...cliType(rust), required: !optional };
    }),
  };
}

fs.mkdirSync(path.dirname(CLI_OUT_FILE), { recursive: true });
fs.writeFileSync(
  CLI_OUT_FILE,
  JSON.stringify({ note: 'AUTO-GENERATED by scripts/gen-commands.mjs — DO NOT EDIT', commands: cliCommands }, null, 2) + '\n',
);
console.log(`Successfully generated cli/commands.gen.json (${httpCommandNames.length} commands)`);

// ─────────────────────────────────────────────────────────────────────────
// cli/agent-tools.gen.json — Agent tool registry (docs/PLAN-2026-09-27-agent-tools-mcp.md).
// ─────────────────────────────────────────────────────────────────────────
const AGENT_TOOLS_OUT_FILE = path.join(process.cwd(), 'cli', 'agent-tools.gen.json');
const agentToolsManifest = buildAgentTools(allCommands);
fs.writeFileSync(AGENT_TOOLS_OUT_FILE, JSON.stringify(agentToolsManifest, null, 2) + '\n');
console.log(`Successfully generated cli/agent-tools.gen.json (${agentToolsManifest.tools.length} tools)`);


