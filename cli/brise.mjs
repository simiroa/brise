#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function loadManifest() {
  try {
    const manifestPath = fileURLToPath(new URL('./commands.gen.json', import.meta.url));
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    const fallbackPath = path.join(process.cwd(), 'cli', 'commands.gen.json');
    return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
  }
}
const manifestData = loadManifest();
export const commandsManifest = manifestData.commands;

export function readStdinSync() {
  return fs.readFileSync(0, 'utf8');
}

export function parseArgs(cmdName, rawArgv, manifest = commandsManifest, readStdinFn = readStdinSync) {
  const spec = manifest[cmdName];
  if (!spec) {
    throw new Error(`"${cmdName}" 는 HTTP 표면 밖이다 (docs/WORKORDER-2026-08-26-cli.md §2)`);
  }

  const argMap = new Map((spec.args ?? []).map((a) => [a.name, a]));
  const result = {};

  let i = 0;
  while (i < rawArgv.length) {
    const raw = rawArgv[i];
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected positional argument: "${raw}". All arguments must be named flags starting with "--".`);
    }

    // Escape hatch: --args '{"key": "val"}' or --args='{"key": "val"}'
    if (raw === '--args' || raw.startsWith('--args=')) {
      let val;
      if (raw.startsWith('--args=')) {
        val = raw.slice(7);
      } else {
        i++;
        if (i >= rawArgv.length) throw new Error('Missing value for --args flag');
        val = rawArgv[i];
      }
      if (val === '-') {
        val = readStdinFn();
      }
      let parsed;
      try {
        parsed = typeof val === 'string' ? JSON.parse(val) : val;
      } catch (e) {
        throw new Error(`Invalid JSON for --args: "${val}" (${e.message})`);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`--args must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
      }
      Object.assign(result, parsed);
      i++;
      continue;
    }

    // --no-<flag> for booleans
    if (raw.startsWith('--no-')) {
      const flagName = raw.slice(5);
      const argSpec = argMap.get(flagName);
      if (!argSpec || argSpec.type !== 'boolean') {
        const allowed = (spec.args ?? []).map((a) => `--${a.name} (${a.type}${a.required ? ', required' : ''})`).join(', ');
        throw new Error(`Unknown flag: "${raw}". Allowed flags for "${cmdName}": ${allowed || '(none)'}`);
      }
      result[flagName] = false;
      i++;
      continue;
    }

    let flagName;
    let inlineVal = null;
    const eqIdx = raw.indexOf('=');
    if (eqIdx !== -1) {
      flagName = raw.slice(2, eqIdx);
      inlineVal = raw.slice(eqIdx + 1);
    } else {
      flagName = raw.slice(2);
    }

    const argSpec = argMap.get(flagName);
    if (!argSpec) {
      const allowed = (spec.args ?? []).map((a) => `--${a.name} (${a.type}${a.required ? ', required' : ''})`).join(', ');
      throw new Error(`Unknown flag: "--${flagName}". Allowed flags for "${cmdName}": ${allowed || '(none)'}`);
    }

    let rawVal;
    if (inlineVal !== null) {
      rawVal = inlineVal;
    } else if (argSpec.type === 'boolean') {
      const next = rawArgv[i + 1];
      if (next === 'true' || next === 'false') {
        rawVal = next;
        i++;
      } else {
        rawVal = true;
      }
    } else {
      i++;
      if (i >= rawArgv.length) {
        throw new Error(`Missing value for flag "--${flagName}"`);
      }
      rawVal = rawArgv[i];
    }

    // Convert value according to argSpec.type
    switch (argSpec.type) {
      case 'string': {
        if (rawVal === '-') {
          rawVal = readStdinFn();
        }
        result[flagName] = String(rawVal);
        break;
      }
      case 'integer': {
        const n = Number(rawVal);
        if (!Number.isInteger(n) || isNaN(n) || String(rawVal).trim() === '') {
          throw new Error(`Invalid integer value for --${flagName}: "${rawVal}"`);
        }
        result[flagName] = n;
        break;
      }
      case 'number': {
        const n = Number(rawVal);
        if (isNaN(n) || String(rawVal).trim() === '') {
          throw new Error(`Invalid number value for --${flagName}: "${rawVal}"`);
        }
        result[flagName] = n;
        break;
      }
      case 'boolean': {
        if (typeof rawVal === 'boolean') {
          result[flagName] = rawVal;
        } else if (rawVal === 'true' || rawVal === '1') {
          result[flagName] = true;
        } else if (rawVal === 'false' || rawVal === '0') {
          result[flagName] = false;
        } else {
          throw new Error(`Invalid boolean value for --${flagName}: "${rawVal}"`);
        }
        break;
      }
      case 'array': {
        result[flagName] = result[flagName] || [];
        if (typeof rawVal === 'string' && rawVal.trim().startsWith('[')) {
          try {
            const arr = JSON.parse(rawVal);
            if (!Array.isArray(arr)) throw new Error('not an array');
            result[flagName].push(...arr);
          } catch (e) {
            throw new Error(`Invalid JSON array for --${flagName}: "${rawVal}"`);
          }
        } else {
          let converted = rawVal;
          if (argSpec.item === 'integer') {
            const n = Number(rawVal);
            if (!Number.isInteger(n) || isNaN(n) || String(rawVal).trim() === '') {
              throw new Error(`Invalid integer array item for --${flagName}: "${rawVal}"`);
            }
            converted = n;
          } else if (argSpec.item === 'number') {
            const n = Number(rawVal);
            if (isNaN(n) || String(rawVal).trim() === '') {
              throw new Error(`Invalid number array item for --${flagName}: "${rawVal}"`);
            }
            converted = n;
          } else if (argSpec.item === 'boolean') {
            if (rawVal === 'true' || rawVal === '1' || rawVal === true) converted = true;
            else if (rawVal === 'false' || rawVal === '0' || rawVal === false) converted = false;
            else throw new Error(`Invalid boolean array item for --${flagName}: "${rawVal}"`);
          } else if (argSpec.item === 'string') {
            converted = String(rawVal);
          }
          result[flagName].push(converted);
        }
        break;
      }
      case 'json': {
        try {
          result[flagName] = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
        } catch (e) {
          throw new Error(`Invalid JSON for --${flagName}: "${rawVal}" (${e.message})`);
        }
        break;
      }
      default: {
        result[flagName] = rawVal;
      }
    }

    i++;
  }

  // Validate required args
  for (const arg of spec.args ?? []) {
    if (arg.required && (result[arg.name] === undefined || result[arg.name] === null)) {
      throw new Error(`Missing required argument: --${arg.name} (${arg.type}) for command "${cmdName}"`);
    }
  }

  return result;
}

export function getDefaultDataDir() {
  if (process.env.BRISE_DATA_DIR) {
    return process.env.BRISE_DATA_DIR;
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.brise.app');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'com.brise.app');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'com.brise.app');
}

export async function readSettingsFromDb(dataDir = getDefaultDataDir()) {
  const dbPath = path.join(dataDir, 'brise.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `DB 파일을 찾을 수 없습니다: ${dbPath}\n` +
      `앱이 켜져 있거나 BRISE_DATA_DIR 또는 BRISE_URL/BRISE_TOKEN 환경변수를 설정해주세요.`
    );
  }

  const sqliteModule = 'node:sqlite';
  const { DatabaseSync } = await import(sqliteModule);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare("SELECT key, value FROM settings WHERE key IN ('sync_port', 'sync_token', 'sync_enabled')");
    const rows = stmt.all();
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }
    return settings;
  } finally {
    db.close();
  }
}

export function getNetworkCandidates() {
  const candidates = ['127.0.0.1'];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!candidates.includes(iface.address)) {
          candidates.push(iface.address);
        }
      }
    }
  }
  return candidates;
}

export async function findLiveServer(candidates, port, token) {
  const urls = candidates.map((ip) => `http://${ip}:${port}`);
  const pingPromises = urls.map(async (url) => {
    try {
      const res = await fetch(`${url}/api/v1/ping?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(700),
      });
      if (res.ok) return url;
    } catch {
      // ignore
    }
    return null;
  });

  const results = await Promise.all(pingPromises);
  const liveUrl = results.find((u) => u !== null);
  if (!liveUrl) {
    throw new Error(
      `앱이 켜져 있고 설정 > 동기화가 켜져 있어야 한다\n시도한 주소:\n  - ${urls.join('\n  - ')}`
    );
  }
  return liveUrl;
}

export async function resolveConnection() {
  if (process.env.BRISE_URL && process.env.BRISE_TOKEN) {
    return {
      url: process.env.BRISE_URL.replace(/\/+$/, ''),
      token: process.env.BRISE_TOKEN,
    };
  }

  const settings = await readSettingsFromDb();
  const port = settings.sync_port;
  const token = settings.sync_token;

  if (!port || !token) {
    throw new Error('동기화 설정(sync_port, sync_token)이 DB에 존재하지 않습니다. 앱 설정에서 동기화를 켜주세요.');
  }

  const candidates = getNetworkCandidates();
  const liveUrl = await findLiveServer(candidates, port, token);
  return { url: liveUrl, token };
}

export async function invokeCommand(url, token, cmd, args) {
  let res;
  try {
    res = await fetch(`${url}/api/v1/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
  } catch (err) {
    const error = new Error(`서버 연결 실패 (${url}): ${err.message}`);
    error.code = 'network';
    throw error;
  }

  if (!res.ok) {
    if (res.status === 401) {
      const error = new Error('unauthorized — 토큰이 앱의 sync_token 과 다르다');
      error.code = 'unauthorized';
      throw error;
    }
    if (res.status === 404) {
      throw new Error(`"${cmd}" 는 HTTP 표면 밖이다 (docs/WORKORDER-2026-08-26-cli.md §2)`);
    }
    let errMsg = '';
    let errCode;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') {
        errMsg = body.error;
      } else {
        errMsg = JSON.stringify(body);
      }
      // 커맨드 자체의 AppError 코드(CONFLICT·NOT_FOUND 등, 서버 sync_server/handlers/responses.rs::command_error_response).
      if (body && typeof body.code === 'string') errCode = body.code;
    } catch {
      errMsg = await res.text().catch(() => `HTTP ${res.status}`);
    }
    const error = new Error(errMsg || `HTTP ${res.status}`);
    if (errCode) error.code = errCode;
    throw error;
  }

  return await res.json();
}

export function listCommands(pattern = '') {
  const query = String(pattern).trim().toLowerCase();
  const groups = {};

  for (const [name, spec] of Object.entries(commandsManifest)) {
    if (
      query &&
      !name.toLowerCase().includes(query) &&
      !spec.group.toLowerCase().includes(query) &&
      !spec.doc.toLowerCase().includes(query)
    ) {
      continue;
    }
    if (!groups[spec.group]) groups[spec.group] = [];
    groups[spec.group].push({ name, doc: spec.doc });
  }

  const groupNames = Object.keys(groups).sort();
  if (groupNames.length === 0) {
    console.log(query ? `No commands matching "${pattern}".` : 'No commands available.');
    return;
  }

  for (const group of groupNames) {
    const cmds = groups[group].sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[${group}] (${cmds.length} commands)`);
    for (const c of cmds) {
      const padded = c.name.padEnd(30);
      console.log(`  ${padded} ${c.doc}`);
    }
    console.log('');
  }
}

export function showHelp(cmdName) {
  if (!cmdName) {
    console.log(`Brise CLI — 외부 접근 인터페이스

사용법:
  brise <command> [--field value ...]     # 커맨드 실행 → 결과 JSON을 stdout에 출력
  brise ls [pattern]                      # 커맨드 목록(그룹별). pattern은 부분일치 필터
  brise help <command>                    # 인자·타입·필수 여부 + 스펙 파일 위치
  brise mcp                               # MCP(Model Context Protocol) stdio 서버 모드

환경 변수:
  BRISE_URL          서버 URL (예: http://127.0.0.1:7332)
  BRISE_TOKEN        인증 토큰
  BRISE_DATA_DIR     Brise 데이터 디렉터리 경로 (brise.db 위치)

예시:
  brise search_notes --query "회의록"
  brise note_create --folder_id root --title "새 노트"
  brise section_update --id <sec_id> --body_md - < memo.md
`);
    return;
  }

  const spec = commandsManifest[cmdName];
  if (!spec) {
    console.error(`"${cmdName}" 는 HTTP 표면 밖이다 (docs/WORKORDER-2026-08-26-cli.md §2)`);
    process.exit(1);
  }

  console.log(`Command: ${cmdName}`);
  console.log(`Group:   ${spec.group} (specs/commands/${spec.group}.yaml)`);
  console.log(`Doc:     ${spec.doc || '(none)'} (스펙 주석 첫 줄)`);
  console.log('\nArguments:');

  if (!spec.args || spec.args.length === 0) {
    console.log('  (no arguments)');
  } else {
    for (const arg of spec.args) {
      const typeStr = arg.type === 'array' ? `${arg.item || 'string'}[]` : arg.type;
      const reqStr = arg.required ? ' (required)' : '';
      console.log(`  --${arg.name.padEnd(20)} <${typeStr}>${reqStr}`);
    }
  }
  console.log('  --args                 <json> (escape hatch: raw JSON arguments object)');
}

export async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    showHelp();
    return;
  }

  const sub = argv[0];
  if (sub === 'mcp') {
    const { runStdioServer } = await import('./mcp.mjs');
    await runStdioServer();
    return;
  }
  if (sub === 'ls') {
    listCommands(argv[1]);
    return;
  }
  if (sub === 'help') {
    showHelp(argv[1]);
    return;
  }

  const cmdName = sub;
  const rawArgs = argv.slice(1);

  try {
    const parsedArgs = parseArgs(cmdName, rawArgs);
    const conn = await resolveConnection();
    const result = await invokeCommand(conn.url, conn.token, cmdName, parsedArgs);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
