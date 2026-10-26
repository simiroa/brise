/**
 * 3단계 suite — 실앱 부팅·상호작용 지표(docs/PLAN-2026-10-23-perf-baselines.md §5). 러너 계약은 run.mjs 머리말.
 *
 *   npm run bench:app [-- --boots 8 --samples 5 --no-build | --exe <path> | --real-data | --scale | --force]
 *
 * 흐름: preflight(실행 중인 brise·9333 포트 확인 → perf 빌드 → 합성 DB 준비) → run(부팅 루프 → 상호작용 루프).
 *
 * ── perf 빌드(§5.3 보완) ─────────────────────────────────────────────────────────────────────────
 *   `tauri build --no-bundle --config <JSON>` 을 CARGO_TARGET_DIR=~/.cache/brise-target-perf 로 돌린다. JSON 이
 *   identifier 를 `com.brise.app.perf` 로, 프런트 산출물을 `dist/` 가 아니라 `.eval/bench/perf-dist` 로 돌린다 —
 *   `dist/` 는 sync_server 의 include_dir! 가 컴파일 시점에 읽는 폴더라 다른 빌드가 같이 쓰고 있을 수 있다.
 *   frontendDist 는 src-tauri 기준 **상대 경로**여야 한다(절대 경로는 URL 로 해석돼 깨진다).
 *
 * ── 데이터(§5.2) ────────────────────────────────────────────────────────────────────────────────
 *   %APPDATA%\com.brise.app.perf 의 **데이터 묶음**(brise.db·-wal·-shm + attachments·backups·slide_previews·orphaned)
 *   을 한 단위로 다룬다. 실데이터 사본은 `brise.realdata.db`·`backups.realdata` … 로 **이름만 바꿔** 옮겨 둔다
 *   (삭제 없음, 이미 있으면 덮지 않는다). DB 만 옮기지 않는 이유: 합성 DB 로 부팅하면 매 부팅의 스냅샷 회전
 *   (KEEP_BACKUPS=3)이 backups/ 의 실데이터 스냅샷을 지우고, orphan_cleanup 이 attachments/<노트id> 를
 *   orphaned/ 로 옮긴다(30일 뒤 삭제). 묶음째 옮기면 합성 부팅이 실데이터 파일을 아예 못 본다.
 *   합성 묶음은 `brise.db-benchseed`(시드 매개변수 기록)로 식별한다 — 이 표식 없이 brise.db 가 있으면 남의 DB 다.
 *
 * ── 측정 방법 ───────────────────────────────────────────────────────────────────────────────────
 *   부팅: CDP 로 brise:* mark·performance.timeOrigin·Resource Timing 을 **사후에** 읽는다. 갓 띄운 프로세스는
 *   CDP 가 붙기 전에 첫 스크립트·IPC 가 이미 돈다 — Network 도메인은 그걸 놓치지만 Resource Timing 은 남아 있다.
 *   Rust 쪽은 diag.jsonl 의 boot/timing 줄(BRISE_BOOT_TIMING=1) — 이번 부팅의 epoch 로 고른다.
 *   상호작용: 페이지마다 새로 띄운 상태(reload)에서 한 번씩 — 지연 화면의 "첫 열기" 비용(React 19 Suspense 300ms,
 *   6ee85b61)이 같은 페이지의 두 번째 열기부터는 사라지기 때문이다. 시간은 페이지 안에서 잰다(CDP 왕복 제외).
 */
import { spawn, execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  CdpSession,
  DEFAULT_CDP_PORT,
  cdpHttpJson,
  listPages,
  portInUse,
  waitPortClosed,
  waitForWindowTarget,
} from "../cdp.mjs";

export const PERF_IDENTIFIER = "com.brise.app.perf";
const CDP_PORT = DEFAULT_CDP_PORT;
const SEED_NOTES = 10_000;
const SEED_RNG = 1;
const SCALE_NOTES = 100_000;
const DEFAULT_BOOTS = 8;
const DEFAULT_SAMPLES = 5;
/** 상호작용 측정 대상. 대시보드 기본 탭(board)에서 이 탭으로 바꾼다 — 지연 화면(lazySurfaces CalendarTab). */
const DASHBOARD_TARGET_TAB = "calendar";
/** 합성 코퍼스 제목 어휘(dev_seed TITLE_TOPICS) — 결과가 늘 있다. 같은 질의를 매 표본에 쓴다(표본마다 새 페이지). */
const SEARCH_QUERY = "ambassade";
/** Resource Timing 기본 버퍼(브라우저 기본값). 꽉 차면 그 뒤 항목은 버려진다. */
const RESOURCE_BUFFER = 250;

/** 측정 중에 앱이 켜 두면 안 되는 것 — 첫 부팅(버리는 회) 전에 넣는다. 전부 전역 키(NOTEBOOK_KEYS 아님). */
const BENCH_SETTINGS = Object.freeze({
  backup_auto_interval: "off", // §5.3 — 부팅마다 자동 백업 zip 이 겹치지 않게
  onboarding_completed: true, // 새 DB 의 온보딩 마법사가 화면을 덮지 않게
  briefing_enabled: false, // 하루 1회 자동으로 뜨는 브리핑 창이 첫 부팅을 흔들지 않게
  // 동기화 서버(고정 포트 7332)를 띄우지 않게 — 실데이터 사본은 켜져 있어, 평소 Brise 가 떠 있으면(--force) 포트가 겹친다.
  // 합성 DB 는 원래 꺼져 있다. --real-data 는 끝나면 원래 값으로 되돌린다.
  sync_enabled: false,
  open_tabs: [], // 지난 실행의 노트 탭이 남아 있으면 부팅이 노트를 열고(selectNote) booted 가 흔들린다
  active_tab_id: "home",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 경로 ──────────────────────────────────────────────────────────────────────────────────────────

export function benchPaths(repoRoot) {
  const appData = process.env.APPDATA ?? join(os.homedir(), "AppData", "Roaming");
  const perfTarget = join(os.homedir(), ".cache", "brise-target-perf");
  const seedTarget = join(os.homedir(), ".cache", "brise-target-seed");
  const evalBench = join(repoRoot, ".eval", "bench");
  return {
    dataDir: join(appData, PERF_IDENTIFIER),
    perfTarget,
    perfExe: join(perfTarget, "release", "brise.exe"),
    seedTarget,
    seedExe: join(seedTarget, "debug", process.platform === "win32" ? "seed_corpus.exe" : "seed_corpus"),
    evalBench,
    perfDist: join(evalBench, "perf-dist"),
    seedRecord: join(evalBench, "app-seed.json"),
    swapState: join(evalBench, "app-dataset-swap.json"),
    tauriCli: join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    srcTauri: join(repoRoot, "src-tauri"),
  };
}

/** `tauri build --config` 에 넘길 JSON(파일이 아니라 인라인 — 한 덩어리로 identifier·빌드 경로를 덮는다). */
export function perfBuildConfig() {
  return JSON.stringify({
    identifier: PERF_IDENTIFIER,
    build: {
      beforeBuildCommand: "npx vite build --outDir .eval/bench/perf-dist --emptyOutDir",
      frontendDist: "../.eval/bench/perf-dist",
    },
  });
}

// ── 자식 프로세스 ─────────────────────────────────────────────────────────────────────────────────

/** 출력은 로그 파일로. 끝나면 {code, ms}. */
function runLogged(cmd, args, { cwd, env, logPath }) {
  return new Promise((resolve) => {
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n$ ${cmd} ${args.join(" ")}\n`);
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (e) => {
      out.write(`\n[spawn error] ${e.message}\n`);
      out.end();
      resolve({ code: -1, ms: Date.now() - t0 });
    });
    child.on("close", (code) => {
      out.end();
      resolve({ code: code ?? -1, ms: Date.now() - t0 });
    });
  });
}

function tailOf(path, lines = 25) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    // silent-ok: 로그가 없으면 꼬리도 없다 — 호출자가 원래 오류를 낸다
    return "";
  }
}

/** 지금 떠 있는 brise.exe 들(이미지 이름 기준 — 어느 identifier 든). [{pid, image}] */
export function runningBriseProcesses() {
  if (process.platform !== "win32") return [];
  let out = "";
  try {
    out = execFileSync("tasklist", ["/FI", "IMAGENAME eq brise.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    // silent-ok: tasklist 가 없으면 확인을 못 한다 — 빈 목록(이후 CDP 포트 확인이 같은 사고를 잡는다)
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => l.split('","').map((c) => c.replace(/^"|"$/g, "")))
    .filter((c) => c[0]?.toLowerCase() === "brise.exe")
    .map((c) => ({ pid: Number(c[1]), image: c[0] }));
}

/** 이 suite 가 띄운 자식만 강제로 끝낸다(다른 brise 는 절대 건드리지 않는다). */
function killOwnTree(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } catch {
    // silent-ok: 이미 끝난 프로세스 — 목적(내 자식이 남지 않음)은 이뤘다
  }
}

// ── 빌드 ──────────────────────────────────────────────────────────────────────────────────────────

async function buildPerfExe(ctx, p) {
  if (!existsSync(p.tauriCli)) throw new Error(`tauri CLI 가 없다: ${p.tauriCli} — npm install 먼저`);
  const logPath = join(ctx.outDir, "perf-build.log");
  // BRISE_BUNDLE_GRAPH: 1단계 청크 그래프 플러그인(vite.config.ts)이 기본 경로 .eval/bundle/graph.json 을 덮지 않게 —
  // 그 파일은 `npm run build && npm run check:bundle` 이 dist/ 빌드와 짝지어 읽는다(동시에 돌면 perf 빌드의 그래프를 읽는다).
  const env = { ...ctx.env, CARGO_TARGET_DIR: p.perfTarget, BRISE_BUNDLE_GRAPH: ".eval/bench/perf-graph.json" };
  const args = [p.tauriCli, "build", "--no-bundle", "--config", perfBuildConfig()];
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.log(`perf 빌드 ${attempt}회차 — tauri build --no-bundle (CARGO_TARGET_DIR=${p.perfTarget}) · 로그 ${logPath}`);
    const r = await runLogged(process.execPath, args, { cwd: ctx.repoRoot, env, logPath });
    if (r.code === 0 && existsSync(p.perfExe)) {
      ctx.log(`perf 빌드 완료 ${(r.ms / 1000).toFixed(0)}s → ${p.perfExe}`);
      return r.ms;
    }
    const tail = tailOf(logPath, 40);
    // 프런트 빌드(beforeBuildCommand)만 실패했으면 다른 에이전트가 vite.config.ts 를 고치는 중일 수 있다 — 잠깐 뒤 다시.
    const frontendFailed = /beforeBuildCommand[^\n]*failed|error during build|\[vite\]/i.test(tail);
    if (!frontendFailed || attempt === 3) {
      throw new Error(`perf 빌드 실패(exit ${r.code}) — 로그 ${logPath}\n${tail}`);
    }
    ctx.log(`프런트 빌드 실패 — 150초 뒤 다시(vite.config.ts 가 바뀌는 중일 수 있다). 꼬리:\n${tail.split("\n").slice(-8).join("\n")}`);
    await sleep(150_000);
  }
  throw new Error("perf 빌드 실패");
}

async function ensureSeedExe(ctx, p) {
  if (existsSync(p.seedExe)) return 0;
  const logPath = join(ctx.outDir, "seed-build.log");
  ctx.log(`seed_corpus(디버그) 빌드 — CARGO_TARGET_DIR=${p.seedTarget} · 로그 ${logPath}`);
  // seed_corpus 는 dev-tools 기능 뒤에 있다(Cargo.toml — 기본 빌드·설치 파일에서 빠지게).
  const r = await runLogged("cargo", ["build", "--bin", "seed_corpus", "--features", "dev-tools"], {
    cwd: p.srcTauri,
    env: { ...ctx.env, CARGO_TARGET_DIR: p.seedTarget },
    logPath,
  });
  if (r.code !== 0 || !existsSync(p.seedExe)) throw new Error(`seed_corpus 빌드 실패(exit ${r.code}):\n${tailOf(logPath)}`);
  return r.ms;
}

// ── 데이터 묶음 ──────────────────────────────────────────────────────────────────────────────────

/** 표식은 brise.db 접두라 묶음과 같이 이름이 바뀐다(brise.realdata.db-benchseed …). */
const SEED_MARKER = "brise.db-benchseed";
const DATASET_FILES = ["brise.db", "brise.db-wal", "brise.db-shm", SEED_MARKER];
const DATASET_DIRS = ["attachments", "backups", "slide_previews", "orphaned"];

/** 묶음 항목의 꼬리표 이름. tag null = 앱이 쓰는 원래 이름. */
export function taggedName(entry, tag) {
  if (!tag) return entry;
  return entry.startsWith("brise.db") ? `brise.${tag}.db${entry.slice("brise.db".length)}` : `${entry}.${tag}`;
}

/**
 * 묶음을 fromTag 이름에서 toTag 이름으로 **이름만** 바꾼다. 대상 자리에 무엇이든 있으면 하나도 옮기지 않고 throw
 * (덮지 않는다). 중간에 실패하면 이미 옮긴 것을 되돌린다.
 * @returns {number} 옮긴 항목 수
 */
export function moveDataset(dataDir, fromTag, toTag) {
  const plan = [];
  for (const e of [...DATASET_FILES, ...DATASET_DIRS]) {
    const from = join(dataDir, taggedName(e, fromTag));
    const to = join(dataDir, taggedName(e, toTag));
    if (!existsSync(from)) continue;
    if (existsSync(to)) throw new Error(`이름을 바꿀 자리에 이미 있다(덮지 않는다): ${to}`);
    plan.push([from, to]);
  }
  const done = [];
  try {
    for (const [a, b] of plan) {
      renameSync(a, b);
      done.push([a, b]);
    }
  } catch (e) {
    for (const [a, b] of done.reverse()) {
      try {
        renameSync(b, a);
      } catch {
        // silent-ok: 되돌리기 실패는 아래 throw 메시지가 남은 상태를 알린다
      }
    }
    throw new Error(`데이터 묶음 이름 바꾸기 실패(${fromTag ?? "live"} → ${toTag ?? "live"}): ${/** @type {Error} */ (e).message}`);
  }
  return plan.length;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // silent-ok: 없거나 깨진 기록 = 기록 없음
    return null;
  }
}

/** 실데이터 사본을 brise.realdata.db … 로 비켜 둔다(처음 한 번). 합성 묶음이 이미 자리에 있으면 아무것도 안 한다. */
function stashRealData(ctx, p) {
  const live = join(p.dataDir, "brise.db");
  if (!existsSync(live)) {
    // DB 없이 실데이터 폴더(backups 등)만 남아 있으면 그것도 비켜 둔다 — 합성 부팅의 스냅샷 회전이 지우지 않게.
    const realSlot = existsSync(join(p.dataDir, taggedName("brise.db", "realdata")));
    const leftovers = DATASET_DIRS.filter((d) => existsSync(join(p.dataDir, d)) && readdirSync(join(p.dataDir, d)).length > 0);
    if (!realSlot && leftovers.length > 0) {
      const n = moveDataset(p.dataDir, null, "realdata");
      ctx.log(`DB 없이 남은 데이터 폴더를 비켜 뒀다(이름만 바꿈, ${n}개): ${leftovers.join(", ")} → *.realdata`);
    }
    return "no-db";
  }
  if (existsSync(join(p.dataDir, SEED_MARKER))) return "synthetic"; // 우리 합성 DB
  if (existsSync(join(p.dataDir, taggedName("brise.db", "realdata")))) {
    throw new Error(
      `${live} 에 합성 표식(${SEED_MARKER})이 없는데 brise.realdata.db 도 이미 있다 — 어느 쪽이 실데이터인지 모른다. 손으로 정리할 것(아무것도 옮기지 않았다).`,
    );
  }
  const n = moveDataset(p.dataDir, null, "realdata");
  ctx.log(`실데이터 사본을 비켜 뒀다(이름만 바꿈, ${n}개): brise.db → brise.realdata.db, backups → backups.realdata …`);
  return "stashed";
}

/**
 * 합성 코퍼스는 **시드한 날 기준**이다(계획 §5.2 는 "올해 기준"이라 적었지만): dev_seed 의 near-deadline 노트
 * (~10%)는 시드 날 ±30일에 걸치고, 대시보드 캘린더는 오늘을 고른 채 열려 그날 걸친 노트마다 note_get 을 부른다
 * (시드 당일 417회). 날이 바뀌면 같은 DB 라도 '오늘'에 걸친 노트 수가 달라져 코드 변경 없이 값이 움직인다.
 * 그래서 날마다 다시 시드한다(10k 는 ~9초). 같은 RNG 시드면 어느 날이든 '오늘 기준' 구조가 같으므로
 * workload 에는 정확한 날짜 대신 해(seed_year)만 남긴다.
 */
function seedIsCurrent(marker, today) {
  return !!marker && marker.notes === SEED_NOTES && marker.seed === SEED_RNG && marker.seed_date === today;
}

function localYmd(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** settings 테이블(전역 키)에 직접 쓴다 — 앱이 꺼져 있을 때만. 값은 앱과 같은 JSON 텍스트. */
async function writeSettingsDirect(dbPath, entries) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const stmt = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    db.exec("BEGIN");
    for (const [k, v] of Object.entries(entries)) stmt.run(k, JSON.stringify(v));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** 합성 DB 를 준비한다(필요하면 시드). @returns {{seed: object, seedMs: number|null, seedBuildMs: number}} */
async function prepareSynthetic(ctx, p) {
  mkdirSync(p.dataDir, { recursive: true });
  const state = stashRealData(ctx, p);
  const markerPath = join(p.dataDir, SEED_MARKER);
  const today = localYmd();
  let marker = state === "synthetic" ? readJson(markerPath) : null;
  let seedMs = null;
  let seedBuildMs = 0;
  if (!seedIsCurrent(marker, today) || !existsSync(join(p.dataDir, "brise.db"))) {
    if (existsSync(join(p.dataDir, "attachments")) && readdirSync(join(p.dataDir, "attachments")).length > 0 && state !== "synthetic") {
      throw new Error(`${join(p.dataDir, "attachments")} 가 비어 있지 않다 — 합성 DB 로 부팅하면 orphan_cleanup 이 옮긴다. 손으로 확인할 것.`);
    }
    seedBuildMs = await ensureSeedExe(ctx, p);
    const logPath = join(ctx.outDir, "seed.log");
    ctx.log(`합성 DB 시드 — notes ${SEED_NOTES} · seed ${SEED_RNG} → ${join(p.dataDir, "brise.db")} (로그 ${logPath})`);
    // --wipe 는 "비우기만 하고 끝" — 쓰지 않는다. 기본(먼저 비우고 시드)은 합성 DB 에서만 돈다(stashRealData 뒤).
    const r = await runLogged(
      p.seedExe,
      ["--db", join(p.dataDir, "brise.db"), "--notes", String(SEED_NOTES), "--seed", String(SEED_RNG)],
      { cwd: ctx.repoRoot, env: ctx.env, logPath },
    );
    if (r.code !== 0) throw new Error(`seed_corpus 실패(exit ${r.code}):\n${tailOf(logPath)}`);
    seedMs = r.ms;
    marker = { notes: SEED_NOTES, seed: SEED_RNG, seed_date: today, seeded_at: new Date().toISOString(), seed_ms: r.ms };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");
    ctx.log(`시드 완료 ${(r.ms / 1000).toFixed(1)}s`);
  } else {
    ctx.log(`합성 DB 재사용 — notes ${marker.notes} · seed ${marker.seed} · 시드 날짜 ${marker.seed_date}`);
  }
  mkdirSync(p.evalBench, { recursive: true });
  writeFileSync(p.seedRecord, JSON.stringify({ ...marker, data_dir: p.dataDir }, null, 2) + "\n", "utf8");
  await writeSettingsDirect(join(p.dataDir, "brise.db"), BENCH_SETTINGS);
  return { seed: marker, seedMs, seedBuildMs };
}

/** 지난 실행이 데이터 묶음을 바꿔 끼운 채 죽었으면 원래대로 돌린다. */
async function recoverSwap(ctx, p) {
  const st = readJson(p.swapState);
  if (!st?.active) return;
  ctx.log(`지난 실행이 '${st.active}' 묶음을 끼운 채 끝났다 — 원래대로 돌린다`);
  if (st.settings_original) await restoreSettingsRaw(join(p.dataDir, "brise.db"), st.settings_original);
  swapBack(p, st.active);
}

/** settings 테이블의 원래 값(JSON 텍스트, 행이 없으면 null) — 실데이터 사본에 측정용 설정을 넣기 전에 떠 둔다. */
async function readSettingsRaw(dbPath, keys) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    return Object.fromEntries(keys.map((k) => [k, stmt.get(k)?.value ?? null]));
  } finally {
    db.close();
  }
}

/** readSettingsRaw 로 떠 둔 값으로 되돌린다(원래 행이 없던 키는 지운다 — 앱 기본값으로 돌아간다). */
async function restoreSettingsRaw(dbPath, original) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const up = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const del = db.prepare("DELETE FROM settings WHERE key = ?");
    db.exec("BEGIN");
    for (const [k, v] of Object.entries(original)) {
      if (v === null) del.run(k);
      else up.run(k, v);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function writeSwapState(p, state) {
  writeFileSync(p.swapState, JSON.stringify({ ...state, at: new Date().toISOString() }) + "\n", "utf8");
}

function swapIn(p, tag) {
  writeSwapState(p, { active: tag });
  moveDataset(p.dataDir, null, "synthetic");
  try {
    moveDataset(p.dataDir, tag, null);
  } catch (e) {
    moveDataset(p.dataDir, "synthetic", null);
    writeFileSync(p.swapState, JSON.stringify({ active: null }) + "\n", "utf8");
    throw e;
  }
}

function swapBack(p, tag) {
  moveDataset(p.dataDir, null, tag);
  moveDataset(p.dataDir, "synthetic", null);
  writeFileSync(p.swapState, JSON.stringify({ active: null, restored_at: new Date().toISOString() }) + "\n", "utf8");
}

// ── 앱 띄우기·끄기 ────────────────────────────────────────────────────────────────────────────────

/** 페이지 안 IPC 추적기 — fetch 를 감싸 ipc.localhost 요청의 시작·끝(페이지 시계)을 센다. 호출 시점에 전역
 *  fetch 를 찾는 Tauri ipc-protocol.js 덕에 나중에 깔아도 이후 IPC 를 전부 본다. 몇 번 깔아도 한 번만 감싼다. */
const IPC_TRACKER_SRC = `(() => {
  if (window.__briseBenchIpc) return;
  const st = { inflight: 0, starts: [], ends: [], cmds: [] };
  window.__briseBenchIpc = st;
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.startsWith("http://ipc.localhost/")) return orig.apply(this, arguments);
    st.inflight++;
    st.starts.push(performance.now());
    st.cmds.push(url.slice(21).replace(/[?#].*$/, ""));
    let done = false;
    const fin = () => { if (done) return; done = true; st.inflight--; st.ends.push(performance.now()); };
    return orig.apply(this, arguments).then((r) => { fin(); return r; }, (e) => { fin(); throw e; });
  };
})()`;

/**
 * "IPC 정착"의 조용한 구간. 계획 §5.1 은 100ms 지만 300ms 로 둔다 — 대시보드 캘린더 첫 열기는 dashboard_calendar
 * 응답 → 달력 렌더 → 그날 노트마다 note_get(합성 코퍼스에서 417회)이 **100~300ms 틈**을 두고 이어져, 100ms 로는
 * 같은 빌드에서 ~80ms(틈 앞에서 정착) ↔ ~450ms(뒤까지 포함)로 표본이 갈렸다(2026-10-23 실측). 값은 "마지막 응답
 * 다음 프레임"이라 구간을 늘려도 부풀지 않는다 — 늦게 이어지는 IPC 를 놓치지 않을 뿐이다.
 */
export const IPC_QUIET_MS = 300;

/**
 * 페이지 안 측정기 — action() 직후 t0 부터 cond() 가 참이 된 프레임과 "IPC 정착"(마지막 IPC 응답 뒤 IPC_QUIET_MS
 * 동안 새 IPC 없음 → 그 마지막 응답 다음 rAF) 중 늦은 쪽까지. rAF 루프로 프레임 시각을 모은다.
 */
const MEASURE_SRC = `(() => {
  if (window.__briseBenchMeasure) return;
  window.__briseBenchMeasure = (action, cond, opts = {}) => new Promise((resolve, reject) => {
    const st = window.__briseBenchIpc;
    if (!st) { reject(new Error("IPC 추적기가 없다")); return; }
    const quiet = opts.quietMs ?? ${IPC_QUIET_MS}, timeout = opts.timeoutMs ?? 20000;
    const s0 = st.starts.length, e0 = st.ends.length;
    const t0 = performance.now();
    try { action(); } catch (e) { reject(e); return; }
    let condAt = null;
    const frames = [];
    const tick = (ts) => {
      frames.push(ts);
      const now = performance.now();
      if (condAt === null) { try { if (cond()) condAt = Math.max(ts, t0); } catch (e) { reject(e); return; } }
      const ends = st.ends.slice(e0);
      const lastEnd = ends.length ? Math.max(...ends) : null;
      if (condAt !== null && st.inflight === 0 && now - (lastEnd ?? t0) >= quiet) {
        const settle = lastEnd === null ? null : Math.max(lastEnd, frames.find((f) => f > lastEnd) ?? ts);
        const cmds = {};
        for (const c of st.cmds.slice(s0)) { const k = decodeURIComponent(c); cmds[k] = (cmds[k] || 0) + 1; }
        // 사람이 볼 IPC 시간선(앞 12개, t0 기준) — 정착 판정이 갈리는 표본을 볼 때 쓴다
        const timeline = st.starts.slice(s0, s0 + 12).map((t, k) => decodeURIComponent(st.cmds[s0 + k]) + "@" + Math.round(t - t0));
        resolve({ ms: Math.max(condAt, settle ?? condAt) - t0, condMs: condAt - t0, settleMs: settle === null ? null : settle - t0, ipc: st.starts.length - s0, cmds, timeline });
        return;
      }
      if (now - t0 > timeout) { reject(new Error("시간 초과 — 조건 " + (condAt === null ? "미충족" : "충족") + ", 진행 중 IPC " + st.inflight)); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
})()`;

function launchApp(exe, env) {
  const child = spawn(exe, [], {
    env: {
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      BRISE_BOOT_TIMING: "1",
    },
    stdio: "ignore",
    windowsHide: false,
  });
  const state = { child, exited: false, code: null, spawnedAt: Date.now() };
  child.on("exit", (code) => {
    state.exited = true;
    state.code = code;
  });
  child.on("error", () => {
    state.exited = true;
  });
  return state;
}

async function attachMain(app) {
  const target = await waitForWindowTarget(CDP_PORT, "main", { timeoutMs: 60_000, isAlive: () => !app.exited });
  const s = await CdpSession.open(target.webSocketDebuggerUrl, { label: "main" });
  return { target, s };
}

/** 부팅이 끝날 때까지(brise:booted mark). */
async function waitBooted(s, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await s
      .evaluate("performance.getEntriesByName('brise:booted').length > 0", { awaitPromise: false, timeoutMs: 10_000 })
      .catch(() => false);
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`brise:booted 가 ${timeoutMs}ms 안에 안 찍혔다`);
}

/** 페이지가 조용해질 때까지 — 진행 중 IPC 없고, 새 리소스·IPC 가 quietMs 동안 없음. 상한 maxMs. */
async function waitQuiet(s, { quietMs = 500, maxMs = 10_000 } = {}) {
  return s.evaluate(
    `new Promise((resolve) => {
      const t0 = performance.now();
      const st = window.__briseBenchIpc;
      let last = -1, lastChange = performance.now();
      const sig = () => performance.getEntriesByType("resource").length + (st ? st.starts.length * 100000 + st.ends.length * 7 : 0);
      const poll = () => {
        const v = sig(), now = performance.now();
        if (v !== last) { last = v; lastChange = now; }
        const idle = !st || st.inflight === 0;
        if ((idle && now - lastChange >= ${quietMs}) || now - t0 >= ${maxMs}) { resolve(now - t0 >= ${maxMs} ? "max" : "quiet"); return; }
        setTimeout(poll, 25);
      };
      poll();
    })`,
    { timeoutMs: maxMs + 10_000 },
  );
}

function invokeExpr(cmd, args) {
  return `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
}

/** 정상 종료(plugin:process|exit — clean-shutdown 마커가 남아 다음 부팅이 quick_check 를 안 돈다). */
async function exitApp(app, s, ctx) {
  try {
    s?.fire("Runtime.evaluate", { expression: invokeExpr("plugin:process|exit", { code: 0 }), awaitPromise: false });
  } catch {
    // silent-ok: 소켓이 이미 닫혔으면 아래 대기가 강제 종료로 넘어간다
  }
  const end = Date.now() + 20_000;
  while (!app.exited && Date.now() < end) await sleep(50);
  s?.close();
  if (!app.exited) {
    ctx.log(`경고: 앱(pid ${app.child.pid})이 20초 안에 안 끝나 강제 종료(자기 자식만)`);
    killOwnTree(app.child.pid);
    const end2 = Date.now() + 10_000;
    while (!app.exited && Date.now() < end2) await sleep(50);
  }
  // WebView2 브라우저 프로세스는 호스트보다 늦게 빠진다 — 포트가 닫히기 전에 다음 회를 띄우면 옛 프로세스를 읽는다.
  if (!(await waitPortClosed(CDP_PORT, 20_000))) {
    throw new Error(`앱이 끝난 뒤에도 CDP 포트 ${CDP_PORT} 가 20초 동안 열려 있다(WebView2 프로세스 잔존)`);
  }
}

// ── diag boot/timing ─────────────────────────────────────────────────────────────────────────────

/** "run=0 setup=12 … setup_end=48 epoch=1729…" → {run:0, setup:12, …, epoch:…} */
export function parseBootTiming(message) {
  const out = {};
  for (const m of String(message).matchAll(/([a-z_]+)=(\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

/** 이번 부팅(spawn 시각 근처 epoch)의 boot/timing 줄. diag.jsonl 이 회전했을 수 있어 두 세대를 다 본다. */
function readBootTiming(dataDir, spawnedAt) {
  const found = [];
  for (const f of ["diag.jsonl", "diag.1.jsonl"]) {
    let text = "";
    try {
      text = readFileSync(join(dataDir, f), "utf8");
    } catch {
      // silent-ok: 회전 전이면 diag.1.jsonl 이 없다
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"timing"')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        // silent-ok: 쓰는 도중 잘린 마지막 줄
        continue;
      }
      if (e.feature !== "boot" || e.code !== "timing") continue;
      const t = parseBootTiming(e.message);
      if (Number.isFinite(t.epoch) && t.epoch >= spawnedAt - 2000 && t.epoch <= spawnedAt + 30_000) found.push(t);
    }
  }
  // epoch(run() 진입, 같은 시스템 시계)는 spawn 직후다 — spawn 시각에 가장 가까운 줄을 고른다. 가장 이른 줄을 고르면
  // 부팅 주기가 2초보다 짧을 때 직전 부팅의 줄(창 안에 들어온다)을 집는다.
  return found.sort((a, b) => Math.abs(a.epoch - spawnedAt) - Math.abs(b.epoch - spawnedAt))[0] ?? null;
}

// ── 부팅 표본 ────────────────────────────────────────────────────────────────────────────────────

const BOOT_SNAPSHOT_SRC = `(() => {
  const marks = {};
  for (const m of performance.getEntriesByType("mark")) if (m.name.startsWith("brise:") && !(m.name.slice(6) in marks)) marks[m.name.slice(6)] = m.startTime;
  const res = performance.getEntriesByType("resource").map((e) => ({ n: e.name, s: e.startTime, e: e.responseEnd, d: e.decodedBodySize, t: e.initiatorType }));
  return { timeOrigin: performance.timeOrigin, marks, res, href: location.href };
})()`;

/** booted 시점·조용해진 뒤 두 스냅숏 → 하나(리소스는 이름+시작 시각으로 합집합). 표식은 같은 문서라 그대로. */
export function mergeSnapshots(atBooted, afterQuiet, atAttach = null) {
  const seen = new Map();
  for (const r of [...atBooted.res, ...afterQuiet.res]) seen.set(`${r.n}@${r.s.toFixed(1)}`, r);
  return {
    timeOrigin: atBooted.timeOrigin,
    marks: atBooted.marks,
    href: atBooted.href,
    res: [...seen.values()].sort((a, b) => a.s - b.s),
    // atAttach: 버퍼를 넓히던 순간의 항목 수(-1 = 넓히기 실패, null = 넓히지 않음)
    buffer: { atAttach, atBooted: atBooted.res.length, afterQuiet: afterQuiet.res.length },
  };
}

function stripQuery(url) {
  return String(url).replace(/[?#].*$/, "");
}

/** 한 부팅의 원자료 → §5.1 boot.* 값. 사람이 볼 세부도 같이. */
export function bootMetrics(snap, timing) {
  const show = snap.marks.show;
  const booted = snap.marks.booted;
  if (!Number.isFinite(show)) throw new Error("brise:show mark 가 없다");
  if (!Number.isFinite(booted)) throw new Error("brise:booted mark 가 없다");
  if (!timing || !Number.isFinite(timing.epoch)) throw new Error("diag boot/timing 줄(BRISE_BOOT_TIMING)을 못 찾았다");
  if (!Number.isFinite(timing.setup_end)) throw new Error("boot/timing 줄에 setup_end 가 없다");
  const res = snap.res;
  // 버퍼는 꽉 차면 새 항목을 버린다 — booted 시점에 이미 찼으면 부팅 중 요청이 빠졌을 수 있다.
  // 넓혔다면(atAttach ≥ 0) 넓히던 순간 이미 찼는지만, 아니면 booted 시점에 찼는지 본다.
  const widenedAt = snap.buffer?.atAttach;
  const filled = Number.isFinite(widenedAt) && widenedAt >= 0 ? widenedAt : (snap.buffer?.atBooted ?? res.length);
  if (filled >= RESOURCE_BUFFER) {
    throw new Error(`Resource Timing 버퍼(${RESOURCE_BUFFER})가 측정 전에 찼다 — 항목이 버려졌을 수 있어 js_before_show·ipc_before_show 를 셀 수 없다`);
  }
  const isJs = (r) => /\.js$/i.test(stripQuery(r.n));
  // js_before_show_kb = **booted 전에 요청한** JS(계획 §5.1 글자 그대로의 "show 전에 받은" 이 아니다 — 보고서 deviations).
  // show 전후 ±50ms 에 요청되는 부팅 동적 import(mdSerialize·chartTypes·engine·locale-en, 합 ~1.5MB)가 있어
  // "show 전에 받은 것"은 같은 빌드에서도 1,623 ↔ 3,199 KB 로 갈린다. booted 뒤에 시작하는 idle 프리로드는 빠진다.
  const js = res.filter((r) => isJs(r) && r.s < booted);
  const jsReceivedBeforeShow = res.filter((r) => isJs(r) && r.e > 0 && r.e <= show);
  const jsRequestedBeforeShow = res.filter((r) => isJs(r) && r.s < show);
  const ipc = res.filter((r) => r.n.startsWith("http://ipc.localhost/") && r.s < show);
  const kb = (arr) => Math.round((arr.reduce((a, r) => a + (r.d || 0), 0) / 1024) * 10) / 10;
  const short = (r) => decodeURIComponent(stripQuery(r.n).replace(/^.*\//, ""));
  return {
    "boot.process_to_show_ms": snap.timeOrigin + show - timing.epoch,
    "boot.nav_to_show_ms": show,
    "boot.rust_setup_ms": timing.setup_end,
    "boot.webview_ready_ms": snap.timeOrigin - timing.epoch,
    "boot.booted_ms": booted,
    "boot.js_before_show_kb": js.reduce((a, r) => a + (r.d || 0), 0) / 1024,
    "boot.ipc_before_show": ipc.length,
    _detail: {
      js_files_requested_before_booted: js.length,
      js_zero_size: js.filter((r) => !r.d).length,
      js_unique_urls: new Set(js.map((r) => stripQuery(r.n))).size,
      js_received_before_show_kb: kb(jsReceivedBeforeShow), // 계획 §5.1 글자 그대로(경합 — 참고용)
      js_requested_before_show_kb: kb(jsRequestedBeforeShow),
      js_requested_near_show: js
        .filter((r) => Math.abs(r.s - show) <= 80)
        .map((r) => ({ f: short(r), kb: Math.round((r.d / 1024) * 10) / 10, s: Math.round(r.s), e: Math.round(r.e) })),
      js_largest: [...js]
        .sort((a, b) => b.d - a.d)
        .slice(0, 12)
        .map((r) => ({ f: short(r), kb: Math.round((r.d / 1024) * 10) / 10, t: r.t })),
      // 부팅 사이 차이를 볼 때 쓴다(어느 청크가 어떤 회차에만 booted 전에 요청됐나)
      js_all: js.map((r) => `${short(r)}|${Math.round((r.d / 1024) * 10) / 10}|${Math.round(r.s)}`),
      ipc_cmds_before_show: ipc.map((r) => decodeURIComponent(stripQuery(r.n).slice("http://ipc.localhost/".length))),
      resources_total: res.length,
      buffer: snap.buffer ?? null,
      marks: snap.marks,
      rust: timing,
    },
  };
}

/** perf exe 에 박힌 프런트가 perf-dist 와 같은가 — 프런트만 바꾸면 exe 가 재링크되지 않는 함정(MEMORY). */
function checkFrontendFresh(snap, p) {
  const assetsDir = join(p.perfDist, "assets");
  if (!existsSync(assetsDir)) return { checked: false, reason: "perf-dist/assets 없음" };
  const have = new Set(readdirSync(assetsDir));
  const loaded = snap.res
    .map((r) => stripQuery(r.n))
    .filter((u) => /^https?:\/\/tauri\.localhost\/assets\//.test(u))
    .map((u) => decodeURIComponent(u.slice(u.lastIndexOf("/") + 1)));
  const missing = loaded.filter((f) => !have.has(f));
  return { checked: true, loaded: loaded.length, missing };
}

async function bootOnce(ctx, p, exe, { first }) {
  const app = launchApp(exe, ctx.env);
  let s = null;
  try {
    const att = await attachMain(app);
    s = att.s;
    // 붙자마자 Resource Timing 버퍼를 넓힌다 — 기본 250 은 booted 뒤 idle 프리로드가 채워, 그 뒤에 끝나는 부팅 청크
    // (CPU 가 바쁠 때 locale-en 256KB 가 그랬다)가 버려졌다. 넓히기 전에 이미 찼으면(atAttach ≥ 250) bootMetrics 가 거부한다.
    const atAttach = await s.evaluate(
      "(() => { const n = performance.getEntriesByType('resource').length; try { performance.setResourceTimingBufferSize(100000); } catch (e) { return -1; } return n; })()",
      { awaitPromise: false },
    );
    await waitBooted(s);
    const atBooted = await s.evaluate(BOOT_SNAPSHOT_SRC, { awaitPromise: false });
    let webview2 = null;
    if (first) {
      // 첫 부팅(버리는 회): 측정을 막는 설정을 앱의 정상 경로(settings_set)로도 넣는다 — 직접 쓴 값의 재확인 겸
      // 지난 실행이 남긴 노트 탭 정리.
      await s.evaluate(invokeExpr("settings_set", { entries: BENCH_SETTINGS }), { timeoutMs: 15_000 });
      const ver = await cdpHttpJson(CDP_PORT, "version");
      webview2 = String(ver?.Browser ?? "").replace(/^[^/]*\//, "") || null;
    }
    // 조용해지길 기다렸다가 한 번 더 읽는다 — booted 전에 요청했지만 그때 아직 안 끝난 청크(Resource Timing 은
    // 끝나야 항목이 생긴다)를 잡기 위해서다. 정상 종료도 부팅 직후보다 덜 늘어진다.
    await waitQuiet(s, { quietMs: 300, maxMs: 5000 }).catch(() => "skip");
    const afterQuiet = await s.evaluate(BOOT_SNAPSHOT_SRC, { awaitPromise: false });
    const snap = mergeSnapshots(atBooted, afterQuiet, atAttach);
    await exitApp(app, s, ctx);
    s = null;
    const timing = readBootTiming(p.dataDir, app.spawnedAt);
    return { snap, timing, webview2 };
  } catch (e) {
    s?.close();
    if (!app.exited) killOwnTree(app.child.pid);
    await waitPortClosed(CDP_PORT, 20_000);
    throw e;
  }
}

// ── 상호작용 표본 ────────────────────────────────────────────────────────────────────────────────

/** 대시보드 탭 바꾸기 — 기본(board)에서 `tab` 으로. 내용 = 그 탭의 루트(rootSelector)가 그려짐. */
function dashboardSampleSrc(tab, rootSelector, timeoutMs = 20_000) {
  return `window.__briseBenchMeasure(
  () => {
    const b = document.querySelector('[data-testid="home-inner-tabs-left"] [data-home-tab="${tab}"]');
    if (!b) throw new Error("대시보드 탭 버튼(${tab})이 없다");
    if (b.getAttribute("data-active") === "true") throw new Error("이미 ${tab} 탭이다");
    b.click();
  },
  () => !!document.querySelector(${JSON.stringify(rootSelector)}),
  { timeoutMs: ${timeoutMs} },
)`;
}
const DASHBOARD_SAMPLE_SRC = dashboardSampleSrc(DASHBOARD_TARGET_TAB, '[data-testid="home-calendar"]');

/** 트리의 첫 노트 행 클릭 → 에디터 본문이 그려짐. 같은 노트를 매 표본(새 페이지)에서 연다. */
const NOTE_SAMPLE_SRC = `(() => {
  const rows = [...document.querySelectorAll("button.treerow")].filter((b) => b.offsetParent !== null);
  if (rows.length === 0) throw new Error("트리에 보이는 노트 행(button.treerow)이 없다");
  const row = rows[0];
  const title = (row.textContent || "").trim().slice(0, 80);
  return window.__briseBenchMeasure(
    () => row.click(),
    () => {
      const pm = document.querySelector(".mdbody .ProseMirror");
      return !!pm && (pm.textContent || "").trim().length > 0;
    },
  ).then((r) => ({ ...r, title }));
})()`;

/** 검색창에 한 번에 입력(React 가 보는 네이티브 setter + input 이벤트) → 결과 행이 그려짐. 200ms 디바운스 포함. */
const SEARCH_SAMPLE_SRC = `window.__briseBenchMeasure(
  () => {
    const el = document.getElementById("brise-search-input");
    if (!el) throw new Error("검색창(#brise-search-input)이 없다");
    el.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(SEARCH_QUERY)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  () => !!document.querySelector('[id^="search-match-"]'),
)`;

/** 설정 버튼 클릭 시각(epoch ms). 창 표시는 설정 창 쪽에서 잰다. */
const SETTINGS_CLICK_SRC = `(() => {
  const b = document.querySelector('button[title$="(Ctrl+,)"]');
  if (!b) throw new Error("설정 버튼(title …(Ctrl+,))이 없다");
  const t = performance.now();
  b.click();
  return performance.timeOrigin + t;
})()`;

/** 설정 창이 표시된 시각(epoch ms) — visibility-state 항목, 없으면 plugin:window|show IPC 응답 끝. 아직이면 null. */
const SETTINGS_SHOWN_SRC = `(() => {
  const vis = performance.getEntriesByType("visibility-state").filter((e) => e.name === "visible" && e.startTime > 0);
  const show = performance.getEntriesByType("resource").filter((e) => e.name.startsWith("http://ipc.localhost/plugin%3Awindow%7Cshow") && e.responseEnd > 0);
  return {
    visible: vis.length ? performance.timeOrigin + vis[0].startTime : null,
    showIpcEnd: show.length ? performance.timeOrigin + show[0].responseEnd : null,
    state: document.visibilityState,
  };
})()`;

async function settingsSample(ctx, s) {
  const clickEpoch = await s.evaluate(SETTINGS_CLICK_SRC, { awaitPromise: false });
  const target = await waitForWindowTarget(CDP_PORT, "settings", { timeoutMs: 20_000, pollMs: 15 });
  const ss = await CdpSession.open(target.webSocketDebuggerUrl, { label: "settings" });
  try {
    const end = Date.now() + 20_000;
    let shown = null;
    while (Date.now() < end) {
      shown = await ss.evaluate(SETTINGS_SHOWN_SRC, { awaitPromise: false }).catch(() => null);
      if (shown && (shown.visible !== null || shown.showIpcEnd !== null)) break;
      await sleep(30);
    }
    if (!shown || (shown.visible === null && shown.showIpcEnd === null)) throw new Error("설정 창이 20초 안에 표시되지 않았다");
    const shownEpoch = shown.visible ?? shown.showIpcEnd;
    return { ms: shownEpoch - clickEpoch, via: shown.visible !== null ? "visibility-state" : "show-ipc", detail: shown };
  } finally {
    ss.close();
    // 표본마다 새로 만들게 부순다 — 닫기 버튼은 숨기기만 해서(closeCurrentAuxWindow) 다음 열기가 '다시 보이기'가 된다.
    await s.evaluate(invokeExpr("plugin:window|destroy", { label: "settings" }), { timeoutMs: 10_000 }).catch((e) => {
      ctx.log(`경고: 설정 창 destroy 실패 — ${e.message}`);
    });
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const pages = await listPages(CDP_PORT);
      if (!pages.some((t) => /#\/settings/.test(t.url ?? ""))) break;
      await sleep(50);
    }
  }
}

/** §5.4 — CDP Network 도메인에 ipc.localhost 요청이 보이나. 붙은 뒤 IPC 하나를 쏴서 본다. */
async function checkNetworkSeesIpc(s) {
  const seen = [];
  const off = s.on("Network.requestWillBeSent", (p) => {
    if (String(p.request?.url ?? "").startsWith("http://ipc.localhost/")) seen.push(p.request.url);
  });
  await s.send("Network.enable");
  await s.evaluate(invokeExpr("settings_get_all", {}), { timeoutMs: 10_000 });
  await sleep(300);
  off();
  await s.send("Network.disable").catch(() => null);
  return { visible: seen.length > 0, urls: seen.slice(0, 3) };
}

/**
 * §5.4 교차 확인 — 한 번의 reload 부팅에서 ipc.localhost 요청을 세 방법으로 센다: CDP Network(붙어 있을 때만 가능),
 * Resource Timing(부팅 표본이 쓰는 사후 방법), fetch 추적기(상호작용의 정착 판정). 셋이 같으면 부팅 표본의
 * boot.ipc_before_show(Resource Timing)가 Network 로 센 것과 같은 수를 낸다는 근거가 된다.
 */
async function ipcCrossCheck(s, prevOrigin) {
  const urls = [];
  const off = s.on("Network.requestWillBeSent", (p) => {
    const u = String(p.request?.url ?? "");
    if (u.startsWith("http://ipc.localhost/")) urls.push(u);
  });
  await s.send("Network.enable");
  let origin;
  try {
    origin = await reloadAndBoot(s, prevOrigin);
    await waitQuiet(s, { quietMs: 500, maxMs: 10_000 });
  } finally {
    off();
    await s.send("Network.disable").catch(() => null);
  }
  const inPage = await s.evaluate(
    `({ resource: performance.getEntriesByType("resource").filter((e) => e.name.startsWith("http://ipc.localhost/")).length,
        tracker: window.__briseBenchIpc ? window.__briseBenchIpc.starts.length : null,
        buffer: performance.getEntriesByType("resource").length })`,
    { awaitPromise: false },
  );
  return { origin, network: urls.length, ...inPage };
}

/** 새 문서(reload)가 뜨고 부팅을 마칠 때까지. 옛 문서의 timeOrigin 과 달라야 한다. */
async function reloadAndBoot(s, prevOrigin) {
  await s.send("Page.reload", { ignoreCache: false });
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const v = await s
      .evaluate("({ o: performance.timeOrigin, b: performance.getEntriesByName('brise:booted').length > 0 })", {
        awaitPromise: false,
        timeoutMs: 10_000,
      })
      .catch(() => null);
    if (v && v.o !== prevOrigin && v.b) return v.o;
    await sleep(50);
  }
  throw new Error("reload 뒤 brise:booted 가 90초 안에 안 찍혔다");
}

async function interactionLoop(ctx, p, exe, samples) {
  const app = launchApp(exe, ctx.env);
  let s = null;
  const out = {
    "interact.dashboard_tab_paint_ms": [],
    "interact.dashboard_tab_ms": [],
    "interact.note_open_ms": [],
    "interact.search_box_ms": [],
    "interact.settings_open_ms": [],
  };
  const detail = [];
  let network = null;
  try {
    ({ s } = await attachMain(app));
    await s.send("Page.enable");
    // 상호작용 페이지에만 — 리소스 버퍼를 넓혀(교차 확인이 잘리지 않게) IPC 추적기·측정기를 문서마다 먼저 깐다.
    const pageSetup = `try { performance.setResourceTimingBufferSize(10000); } catch (e) {} ${IPC_TRACKER_SRC};${MEASURE_SRC};`;
    await s.send("Page.addScriptToEvaluateOnNewDocument", { source: pageSetup });
    await waitBooted(s);
    await s.evaluate(`${IPC_TRACKER_SRC};${MEASURE_SRC};`, { awaitPromise: false });
    network = await checkNetworkSeesIpc(s);
    ctx.log(`§5.4 CDP Network 에 ipc.localhost 요청: ${network.visible ? "보인다" : "안 보인다"}${network.urls.length ? ` (예: ${network.urls[0]})` : ""}`);
    let origin = await s.evaluate("performance.timeOrigin", { awaitPromise: false });
    const total = 1 + samples;
    for (let i = 0; i < total; i++) {
      const warm = i === 0;
      // 표본마다 같은 출발점: 노트 탭 없음 → 대시보드(기본 탭) — 그리고 새 페이지.
      await s.evaluate(invokeExpr("settings_set", { entries: { open_tabs: [], active_tab_id: "home" } }), { timeoutMs: 15_000 });
      let q0;
      if (warm) {
        const cc = await ipcCrossCheck(s, origin);
        origin = cc.origin;
        network.crossCheck = { network: cc.network, resource: cc.resource, tracker: cc.tracker, buffer: cc.buffer };
        ctx.log(`§5.4 교차 확인(reload 부팅 한 번의 IPC 수): Network ${cc.network} · Resource Timing ${cc.resource} · fetch 추적기 ${cc.tracker}`);
        q0 = "quiet";
      } else {
        origin = await reloadAndBoot(s, origin);
        q0 = await waitQuiet(s, { quietMs: 500, maxMs: 10_000 });
      }
      const row = { sample: i, warmup: warm, quiet: q0 };
      const dash = await s.evaluate(DASHBOARD_SAMPLE_SRC, { timeoutMs: 30_000 });
      await waitQuiet(s, { quietMs: 300, maxMs: 5000 });
      const note = await s.evaluate(NOTE_SAMPLE_SRC, { timeoutMs: 30_000 });
      await waitQuiet(s, { quietMs: 300, maxMs: 5000 });
      const search = await s.evaluate(SEARCH_SAMPLE_SRC, { timeoutMs: 30_000 });
      await waitQuiet(s, { quietMs: 300, maxMs: 5000 });
      const settings = await settingsSample(ctx, s);
      Object.assign(row, { dashboard: dash, note, search, settings });
      detail.push(row);
      ctx.log(
        `상호작용 ${warm ? "워밍업" : `표본 ${i}/${samples}`}: 대시보드 ${dash.ms.toFixed(1)}ms · 노트 ${note.ms.toFixed(1)}ms · ` +
          `검색 ${search.ms.toFixed(1)}ms · 설정 ${settings.ms.toFixed(1)}ms(${settings.via})`,
      );
      if (warm) continue;
      // 탭 내용이 그려진 시각(condMs) — 지연 화면 첫 열기 비용. 아래 dashboard_tab_ms 는 IPC 정착까지(지금은 dashboard_calendar 명령이 지배).
      out["interact.dashboard_tab_paint_ms"].push(dash.condMs);
      out["interact.dashboard_tab_ms"].push(dash.ms);
      out["interact.note_open_ms"].push(note.ms);
      out["interact.search_box_ms"].push(search.ms);
      out["interact.settings_open_ms"].push(settings.ms);
    }
    // 다음 실행이 노트 탭 없이 시작하게.
    await s.evaluate(invokeExpr("settings_set", { entries: { open_tabs: [], active_tab_id: "home" } }), { timeoutMs: 15_000 });
    await exitApp(app, s, ctx);
    s = null;
    return { values: out, detail, network };
  } catch (e) {
    s?.close();
    if (!app.exited) killOwnTree(app.child.pid);
    await waitPortClosed(CDP_PORT, 20_000);
    throw e;
  }
}

// ── --scale(정보 지표, §5.1 scale.*) ─────────────────────────────────────────────────────────────

const SCALE_TAG = "scale100k";
const SCALE_BOOTS = 3; // 첫 회 버림 → 표본 2

/** 10만 노트 합성 묶음(brise.scale100k.db …)을 준비한다. 합성 묶음과 같은 규칙(표식으로 식별, 해가 바뀌면 재시드). */
async function ensureScaleDataset(ctx, p) {
  const dbPath = join(p.dataDir, taggedName("brise.db", SCALE_TAG));
  const markerPath = join(p.dataDir, taggedName(SEED_MARKER, SCALE_TAG));
  let marker = readJson(markerPath);
  const today = localYmd();
  if (existsSync(dbPath) && !marker) throw new Error(`${dbPath} 에 합성 표식이 없다 — 남의 DB 일 수 있어 건드리지 않는다`);
  let seedMs = null;
  const current = !!marker && marker.notes === SCALE_NOTES && marker.seed === SEED_RNG && String(marker.seed_date).slice(0, 4) === today.slice(0, 4);
  if (!existsSync(dbPath) || !current) {
    await ensureSeedExe(ctx, p);
    const logPath = join(ctx.outDir, "seed-scale.log");
    ctx.log(`--scale: 10만 노트 합성 DB 시드 → ${dbPath} (로그 ${logPath})`);
    const r = await runLogged(p.seedExe, ["--db", dbPath, "--notes", String(SCALE_NOTES), "--seed", String(SEED_RNG)], {
      cwd: ctx.repoRoot,
      env: ctx.env,
      logPath,
    });
    if (r.code !== 0) throw new Error(`seed_corpus(10만) 실패(exit ${r.code}):\n${tailOf(logPath)}`);
    seedMs = r.ms;
    marker = { notes: SCALE_NOTES, seed: SEED_RNG, seed_date: today, seeded_at: new Date().toISOString(), seed_ms: r.ms };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");
    ctx.log(`--scale: 시드 완료 ${(r.ms / 1000).toFixed(1)}s`);
  }
  await writeSettingsDirect(dbPath, BENCH_SETTINGS);
  return { marker, seedMs };
}

/**
 * 10만 노트에서 부팅 SCALE_BOOTS 회(첫 회 버림): 트리 로드(brise:tree − brise:show)·booted, 마지막 회에
 * 대시보드 관계(그래프) 탭 첫 열기. 전부 정보 지표 — 실패는 이 suite 를 죽이지 않고 기록만 한다.
 */
async function scaleLoop(ctx, p, exe) {
  const { marker, seedMs } = await ensureScaleDataset(ctx, p);
  const workload = { notes: marker.notes, seed: marker.seed, seed_date: marker.seed_date };
  const vals = { "scale.tree_load_100k_ms": [], "scale.booted_100k_ms": [], "scale.graph_tab_100k_ms": [] };
  const notes = [];
  swapIn(p, SCALE_TAG);
  try {
    for (let i = 0; i < SCALE_BOOTS; i++) {
      const app = launchApp(exe, ctx.env);
      let s = null;
      try {
        ({ s } = await attachMain(app));
        await waitBooted(s, 300_000);
        const snap = await s.evaluate(BOOT_SNAPSHOT_SRC, { awaitPromise: false });
        if (i === 0) {
          await s.evaluate(invokeExpr("settings_set", { entries: BENCH_SETTINGS }), { timeoutMs: 30_000 });
        } else {
          vals["scale.tree_load_100k_ms"].push(snap.marks.tree - snap.marks.show);
          vals["scale.booted_100k_ms"].push(snap.marks.booted);
        }
        if (i === SCALE_BOOTS - 1) {
          await s.evaluate(`${IPC_TRACKER_SRC};${MEASURE_SRC};`, { awaitPromise: false });
          await waitQuiet(s, { quietMs: 500, maxMs: 30_000 });
          try {
            const g = await s.evaluate(dashboardSampleSrc("graph", '[data-testid="graph-tab"]', 120_000), { timeoutMs: 150_000 });
            vals["scale.graph_tab_100k_ms"].push(g.ms);
          } catch (e) {
            notes.push(`graph 탭: ${/** @type {Error} */ (e).message}`);
          }
        }
        ctx.log(`--scale 부팅 ${i}${i === 0 ? "(버림)" : ""}: tree−show ${(snap.marks.tree - snap.marks.show).toFixed(0)}ms · booted ${snap.marks.booted.toFixed(0)}ms`);
        await exitApp(app, s, ctx);
        s = null;
      } catch (e) {
        s?.close();
        if (!app.exited) killOwnTree(app.child.pid);
        await waitPortClosed(CDP_PORT, 20_000);
        throw e;
      }
    }
  } finally {
    swapBack(p, SCALE_TAG);
  }
  const results = Object.entries(vals)
    .filter(([, arr]) => arr.length > 0)
    .map(([metric, arr]) => ({ metric, unit: "ms", samples: arr, workload }));
  return { results, notes, seedMs };
}

// ── suite ────────────────────────────────────────────────────────────────────────────────────────

function resolveExe(ctx, p) {
  if (ctx.args.exe) return ctx.args.exe;
  return p.perfExe;
}

export default {
  name: "app",
  fingerprint: { webview2: true },

  async preflight(ctx) {
    if (process.platform !== "win32") throw new Error("app suite 는 Windows(WebView2) 전용이다");
    const p = benchPaths(ctx.repoRoot);
    ctx.perf = { paths: p, timings: {} };

    const running = runningBriseProcesses();
    if (running.length > 0) {
      const msg = `brise.exe 가 이미 떠 있다(pid ${running.map((r) => r.pid).join(", ")}) — 부팅·상호작용 시간이 흔들린다`;
      if (!ctx.args.force) throw new Error(`${msg}. 끄고 다시 돌리거나 --force(그 프로세스는 건드리지 않는다).`);
      ctx.log(`경고: ${msg}. --force 로 계속 — perf identifier(${PERF_IDENTIFIER})라 단일 인스턴스 충돌은 없다. 그 프로세스는 건드리지 않는다.`);
    }
    ctx.perf.otherBriseAtStart = running;
    if (await portInUse(CDP_PORT)) throw new Error(`CDP 포트 ${CDP_PORT} 를 이미 누가 쓰고 있다 — 다른 측정·앱을 끝낼 것`);

    mkdirSync(p.evalBench, { recursive: true });
    await recoverSwap(ctx, p);

    if (ctx.args.exe) {
      if (!existsSync(ctx.args.exe)) throw new Error(`--exe 경로가 없다: ${ctx.args.exe}`);
      ctx.log(`--exe 로 받은 exe 를 쓴다(빌드 생략): ${ctx.args.exe}`);
    } else if (ctx.args.noBuild) {
      if (!existsSync(p.perfExe)) throw new Error(`--no-build 인데 perf exe 가 없다: ${p.perfExe}`);
      ctx.log(`--no-build — 기존 perf exe 재사용: ${p.perfExe} (${statSync(p.perfExe).mtime.toISOString()})`);
    } else {
      ctx.perf.timings.build_ms = await buildPerfExe(ctx, p);
    }

    if (ctx.args.realData) {
      if (!existsSync(join(p.dataDir, taggedName("brise.db", "realdata")))) {
        throw new Error(`--real-data 인데 ${join(p.dataDir, "brise.realdata.db")} 가 없다 — 실데이터 사본이 아직 비켜 둔 적이 없다`);
      }
      ctx.log("--real-data — 실데이터 사본으로 돈다(정보용: 판정은 기준선 workload 가 달라 UNCOMPARABLE/NEW)");
    } else {
      const r = await prepareSynthetic(ctx, p);
      ctx.perf.seed = r.seed;
      ctx.perf.timings.seed_ms = r.seedMs;
      ctx.perf.timings.seed_build_ms = r.seedBuildMs;
    }
  },

  async run(ctx) {
    const p = ctx.perf?.paths ?? benchPaths(ctx.repoRoot);
    const exe = resolveExe(ctx, p);
    const boots = ctx.args.boots ?? DEFAULT_BOOTS;
    const samples = ctx.args.samples ?? DEFAULT_SAMPLES;
    if (boots < 2) throw new Error("--boots 는 2 이상(첫 회는 버린다)");
    const only = ctx.args.only;
    const wants = (prefix) => !only || only.some((o) => prefix.startsWith(o) || o.startsWith(prefix));

    let swapped = null;
    let settingsOriginal = null;
    const details = { boots: [], interactions: null, network: null, frontend: null, seed: ctx.perf?.seed ?? null, timings: ctx.perf?.timings ?? {} };
    const results = [];
    try {
      if (ctx.args.realData) {
        swapIn(p, "realdata");
        swapped = "realdata";
        // 측정용 설정을 넣기 전에 원래 값을 떠 두고(상태 파일에도 — 죽어도 다음 실행이 되돌린다) 끝나면 되돌린다.
        const live = join(p.dataDir, "brise.db");
        settingsOriginal = await readSettingsRaw(live, Object.keys(BENCH_SETTINGS));
        writeSwapState(p, { active: "realdata", settings_original: settingsOriginal });
        await writeSettingsDirect(live, BENCH_SETTINGS);
      }
      const workload = ctx.args.realData
        ? { data: "realdata" }
        : { notes: ctx.perf.seed.notes, seed: ctx.perf.seed.seed, seed_year: Number(String(ctx.perf.seed.seed_date).slice(0, 4)) };

      // ── 부팅 루프 ── (--only 가 boot 를 빼면 첫 회(설정·WebView2 버전·프런트 신선도)만)
      const bootRuns = wants("boot") ? boots : 1;
      const bootVals = {};
      for (let i = 0; i < bootRuns; i++) {
        const t = Date.now();
        const b = await bootOnce(ctx, p, exe, { first: i === 0 });
        if (i === 0) {
          if (b.webview2) ctx.setToolchain("webview2", b.webview2);
          if (!ctx.args.exe) {
            details.frontend = checkFrontendFresh(b.snap, p);
            if (details.frontend.checked && details.frontend.missing.length > 0) {
              throw new Error(
                `perf exe 에 박힌 프런트가 ${p.perfDist} 와 다르다(없는 청크 ${details.frontend.missing.length}개, 예: ${details.frontend.missing[0]}) — --no-build 를 빼고 다시 빌드할 것`,
              );
            }
          }
          ctx.log(`부팅 0(버림) ${((Date.now() - t) / 1000).toFixed(1)}s · WebView2 ${b.webview2 ?? "?"}`);
          continue;
        }
        const m = bootMetrics(b.snap, b.timing);
        details.boots.push({ boot: i, ...m._detail, values: Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_"))) });
        for (const [k, v] of Object.entries(m)) if (!k.startsWith("_")) (bootVals[k] ??= []).push(v);
        ctx.log(
          `부팅 ${i}/${bootRuns - 1}:프로세스→표시 ${m["boot.process_to_show_ms"].toFixed(0)}ms · 내비→표시 ${m["boot.nav_to_show_ms"].toFixed(0)}ms · ` +
            `setup ${m["boot.rust_setup_ms"]}ms · booted ${m["boot.booted_ms"].toFixed(0)}ms · JS ${m["boot.js_before_show_kb"].toFixed(0)}KB · IPC ${m["boot.ipc_before_show"]}`,
        );
      }
      const units = { kb: "KB", ms: "ms" };
      for (const [metric, samplesArr] of Object.entries(bootVals)) {
        const suffix = metric.split("_").pop();
        results.push({ metric, unit: units[suffix] ?? "count", samples: samplesArr, workload });
      }

      // ── 상호작용 ──
      if (wants("interact")) {
        const r = await interactionLoop(ctx, p, exe, samples);
        details.interactions = r.detail;
        details.network = r.network;
        for (const [metric, arr] of Object.entries(r.values)) results.push({ metric, unit: "ms", samples: arr, workload });
      }

      // ── --scale(정보) ──
      if (ctx.args.scale && wants("scale")) {
        if (ctx.args.realData) {
          ctx.log("경고: --scale 은 --real-data 와 같이 못 돈다(데이터 묶음을 하나씩만 끼운다) — 건너뜀");
        } else {
          const sc = await scaleLoop(ctx, p, exe);
          details.scale = { notes: sc.notes, seed_ms: sc.seedMs };
          for (const n of sc.notes) ctx.log(`경고(--scale): ${n}`);
          results.push(...sc.results);
        }
      }
      return results;
    } finally {
      writeFileSync(join(ctx.outDir, "app-details.json"), JSON.stringify(details, null, 2) + "\n", "utf8");
      if (swapped) {
        if (settingsOriginal) {
          await restoreSettingsRaw(join(p.dataDir, "brise.db"), settingsOriginal);
          ctx.log(`실데이터 사본의 설정 ${Object.keys(settingsOriginal).length}개를 원래 값으로 되돌렸다`);
        }
        swapBack(p, swapped);
        ctx.log("실데이터 사본을 다시 비켜 뒀다(합성 묶음 원위치)");
      }
      const left = runningBriseProcesses().filter((r) => !(ctx.perf?.otherBriseAtStart ?? []).some((o) => o.pid === r.pid));
      if (left.length > 0) ctx.log(`경고: 끝났는데 새 brise.exe 가 남아 있다(pid ${left.map((r) => r.pid).join(", ")}) — 이 suite 가 띄운 것인지 확인`);
    }
  },
};
