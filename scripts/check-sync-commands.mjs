// 동기 `#[tauri::command] pub fn` 래칫 (AUDIT-2026-10-10 §6-1, Wave CMD).
//
// Tauri 2 는 동기 커맨드를 **메인 스레드**에서 돌린다 — 무거운 일이 거기서 돌면 창이 멈추고 다른 모든 IPC 가 줄을 선다
// (실측 2ms → 1,837ms). 무거운 커맨드는 `async fn` + `spawn_blocking`(commands/dashboard.rs `spawn_db`, transfer.rs `export_doc`).
//
// 이 검사는 `src-tauri/src/commands/` 의 `pub fn` 커맨드(= async 가 아닌 것) **개수**만 센다. 본문의 IO 를 감지하려 하지 않는다 —
// 무거운 일은 repo 함수 안에 있어서(L-1 `workspace_delete`, L-2 `export_note`) 본문 검사는 그것들을 통과시킨다.
// 개수가 기준선(scripts/check-sync-commands.baseline.json)을 넘으면 실패한다: 새 커맨드는 async 로 만들거나,
// 정말 가벼우면(필드 하나 읽기·쓰기) 바로 위 줄에 `// sync-ok: <이유>` 를 달아 센 수에서 뺀다.
// 개수가 기준선보다 **줄었으면** 실패하지 않고 기준선을 낮추라고 알린다(래칫은 한 방향으로만 조여진다).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandsDir = path.join(root, "src-tauri", "src", "commands");
const baselinePath = path.join(root, "scripts", "check-sync-commands.baseline.json");

function listRs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listRs(p));
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** 파일 하나의 동기 커맨드: [{ name, line, exempt }] — `#[cfg(test)]` 이하는 세지 않는다. */
export function scanSyncCommands(source) {
  const lines = source.split(/\r?\n/);
  const testStart = lines.findIndex((l) => /^\s*#\[cfg\(test\)\]/.test(l));
  const end = testStart === -1 ? lines.length : testStart;
  const found = [];
  for (let i = 0; i < end; i++) {
    if (!/^\s*#\[tauri::command/.test(lines[i])) continue;
    // 속성·주석 줄을 건너뛰어 fn 선언을 찾는다.
    let j = i + 1;
    while (j < end && /^\s*(#\[|\/\/)/.test(lines[j])) j++;
    const decl = lines[j] ?? "";
    const m = /^\s*pub\s+fn\s+(\w+)/.exec(decl);
    if (!m) continue; // async fn (또는 비공개) — 해당 없음
    // `// sync-ok:` — 속성 바로 위 줄이거나, 속성과 fn 사이 주석 줄.
    const above = i > 0 ? lines[i - 1] : "";
    const between = lines.slice(i + 1, j).join("\n");
    const exempt = /\/\/\s*sync-ok:\s*\S/.test(above) || /\/\/\s*sync-ok:\s*\S/.test(between);
    found.push({ name: m[1], line: i + 1, exempt });
  }
  return found;
}

function main() {
  const counted = [];
  for (const f of listRs(commandsDir)) {
    for (const c of scanSyncCommands(fs.readFileSync(f, "utf8"))) {
      if (!c.exempt) counted.push({ ...c, file: path.relative(root, f).replace(/\\/g, "/") });
    }
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).max;
  const n = counted.length;
  if (n > baseline) {
    console.error(`check:sync-commands — 동기 커맨드 ${n}개 > 기준선 ${baseline}.`);
    console.error("새 `#[tauri::command] pub fn` 은 메인 스레드에서 돈다. 무거우면 `async fn` + `spawn_blocking`(commands/dashboard.rs spawn_db 참고),");
    console.error("정말 가벼우면 속성 바로 위에 `// sync-ok: <이유>` 를 달아라. 후보(목록 끝쪽):");
    for (const c of counted.slice(-8)) console.error(`  ${c.file}:${c.line}  ${c.name}`);
    process.exit(1);
  }
  if (n < baseline) {
    console.log(`check:sync-commands — 동기 커맨드 ${n}개 (기준선 ${baseline}). 줄었다: scripts/check-sync-commands.baseline.json 의 max 를 ${n} 으로 낮춰라.`);
  } else {
    console.log(`check:sync-commands — 동기 커맨드 ${n}개 (기준선과 같음)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
