import { spawn, spawnSync } from "node:child_process";

const PORT = 9222;
const HOST = `http://127.0.0.1:${PORT}`;
// Cold `tauri dev` startup plus a 100k-note boot does not fit in a minute.
const TOTAL_TIMEOUT_MS = 180_000;
const POLL_MS = 250;
const SETTLE_MS = 2_000;
const APP_URL = /localhost:5183|127\.0\.0\.1:5183/;
const REACT_WARNING = /maximum update depth|rules? of hooks|invalid hook call|change in the order of hooks/i;
const IPC_FAILURE = /^\[brise\]\s/i;
const UNHANDLED_REJECTION = /^\[brise-smoke\] unhandled promise rejection/i;
const SCENARIO_TITLE_PREFIX = "[brise-smoke] ";
const SCENARIO_BODY = "brise smoke scenario body — safe to delete";

// Reset once the app is attached: a cold `tauri dev` (cargo + vite) must not eat the
// observation budget, which is what we actually want to bound.
let startedAt = Date.now();
const messages = [];
let child;
let nextId = 1;
let socket;
let loadResolve;
const pending = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const remaining = () => TOTAL_TIMEOUT_MS - (Date.now() - startedAt);

function collect(kind, text, failure = false) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return;
  messages.push({ kind, text: normalized, failure });
}

async function targets() {
  try {
    const response = await fetch(`${HOST}/json/list`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

function candidatePages(list) {
  return list.filter(
    (target) => target.type === "page" && APP_URL.test(target.url || "") && target.webSocketDebuggerUrl,
  );
}

function evalOnTarget(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("probe timed out"));
    }, 3_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    ws.addEventListener("message", ({ data }) => {
      clearTimeout(timer);
      ws.close();
      const message = JSON.parse(data);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result?.result?.value);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("probe connection failed"));
    });
  });
}

// Every Brise webview (main, pet, pet-bubble, settings...) is served from the same dev
// URL, so more than one can show up as a page target once aux windows have been opened. Most
// mutating IPC (note_create included) is denied outside the main window's command allowlist
// (pet_window.rs) — the scenario needs *main* specifically, not just the first
// page target `find()` would have picked.
async function appTarget(list) {
  const candidates = candidatePages(list);
  if (candidates.length <= 1) return candidates[0];
  for (const candidate of candidates) {
    const label = await evalOnTarget(
      candidate.webSocketDebuggerUrl,
      "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null",
    ).catch(() => null);
    if (label === "main") return candidate;
  }
  return candidates[0];
}

function launchApp() {
  // `tauri:dev` (not the bare `tauri dev` script) so this boots the isolated com.brise.app.dev
  // identifier (src-tauri/tauri.dev.conf.json) — the scenario below mutates real notes, and this
  // must never land in the production data directory. Node >=18.20 refuses to spawn .cmd shims
  // without a shell (EINVAL), so npm.cmd needs shell:true.
  child = spawn("npm", ["run", "tauri:dev"], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const capture = (kind) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (/\b(error|panic|failed)\b/i.test(line)) collect(kind, line, true);
    }
  };
  child.stdout.on("data", capture("app stdout"));
  child.stderr.on("data", capture("app stderr"));
  child.on("error", (error) => collect("launcher", error.message, true));
}

async function waitForTarget() {
  let list = await targets();
  let target = await appTarget(list);
  if (target) {
    collect("smoke", "reusing app already attached to CDP port 9222");
    return target;
  }

  if (list.length > 0) {
    throw new Error("CDP port 9222 is occupied, but no Brise app target is available");
  }

  launchApp();
  while (remaining() > 0) {
    list = await targets();
    target = await appTarget(list);
    if (target) return target;
    if (child?.exitCode != null) throw new Error(`app exited before CDP attach (${child.exitCode})`);
    await sleep(POLL_MS);
  }
  throw new Error("timed out waiting for the Brise CDP target");
}

function remoteText(value) {
  if (Object.hasOwn(value, "value")) {
    return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  }
  return value.description || value.unserializableValue || value.type || "";
}

function handleEvent(event) {
  if (event.method === "Page.loadEventFired") {
    loadResolve?.();
    loadResolve = undefined;
  } else if (event.method === "Runtime.consoleAPICalled") {
    const level = event.params.type;
    const text = event.params.args.map(remoteText).join(" ");
    const failure = level === "error" || REACT_WARNING.test(text) || IPC_FAILURE.test(text);
    if (failure) {
      const kind = UNHANDLED_REJECTION.test(text)
        ? "unhandled rejection"
        : IPC_FAILURE.test(text)
          ? "failed IPC"
          : `console ${level}`;
      collect(kind, text, true);
    }
  } else if (event.method === "Runtime.exceptionThrown") {
    const details = event.params.exceptionDetails;
    const text = details.exception?.description || details.text || "uncaught runtime exception";
    collect(/promise|rejection/i.test(text) ? "unhandled rejection" : "runtime exception", text, true);
  } else if (event.method === "Log.entryAdded") {
    const entry = event.params.entry;
    const text = entry.url ? `${entry.text} (${entry.url}:${entry.lineNumber ?? 0})` : entry.text;
    const failure = entry.level === "error" || REACT_WARNING.test(text) || IPC_FAILURE.test(text);
    if (failure) collect(IPC_FAILURE.test(text) ? "failed IPC" : `log ${entry.level}`, text, true);
  }
}

async function connect(url) {
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out opening CDP WebSocket")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("failed to open CDP WebSocket"));
    });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    handleEvent(message);
  });
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    // Boot blocks the renderer for seconds on a large corpus, so evaluate can stall well past 5s.
    const timeoutMs = Math.max(1, Math.min(30_000, remaining()));
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function reloadApp() {
  const loaded = new Promise((resolve) => {
    loadResolve = resolve;
  });
  messages.length = 0;
  await cdp("Page.reload", { ignoreCache: true });
  // WebView2 does not always emit Page.loadEventFired; the real readiness signal is
  // waitForBoot()'s __briseSmokeBooted flag, so a missing load event is not fatal here.
  await Promise.race([loaded, sleep(15_000)]);
}

async function waitForBoot() {
  while (remaining() > SETTLE_MS) {
    const result = await cdp("Runtime.evaluate", {
      expression: "globalThis.__briseSmokeBooted === true",
      returnByValue: true,
    });
    if (result.result.value === true) {
      collect("boot", "__briseSmokeBooted recorded");
      await sleep(SETTLE_MS);
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error("boot did not settle through globalThis.__briseSmokeBooted");
}

// Calls a real Tauri command through the same bridge the frontend uses (`@tauri-apps/api/core`'s
// invoke resolves to this global) — unlike vitest's mocked `call()` and Rust's direct repo-function
// tests, this is the one path that exercises IPC arg (de)serialization end to end.
async function invokeCmd(cmd, args = {}) {
  const expression = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
  const evaluated = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (evaluated.exceptionDetails) {
    const detail = evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text;
    throw new Error(`${cmd} failed: ${detail}`);
  }
  return evaluated.result.value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`scenario assertion failed: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Boot-health checks above never call an IPC command — a handler that's wired wrong (e.g. a
// missing rename_all arm) or a repo function that regressed only shows up here. Cleanup runs in
// `finally` so a failed assertion still purges the smoke note instead of leaving trash behind.
async function runScenario() {
  const title = `${SCENARIO_TITLE_PREFIX}${new Date().toISOString()}`;
  let noteId;
  try {
    const folderList = await invokeCmd("folder_list", {});
    const folder = folderList.folders[0];
    if (!folder) throw new Error("no folder available to create a smoke note in");

    const created = await invokeCmd("note_create", { folder_id: folder.id, title });
    noteId = created.note.id;
    assertEqual(created.note.title, title, "note_create title round-trip");

    const section = await invokeCmd("section_create_with_body", {
      note_id: noteId,
      name: null,
      body_md: SCENARIO_BODY,
      kind: null,
      ai_origin: null,
    });

    const detail = await invokeCmd("note_get", { id: noteId });
    assertEqual(detail.note.title, title, "note_get title after create");
    const savedSection = detail.sections.find((s) => s.id === section.id);
    if (!savedSection) throw new Error("scenario assertion failed: created section missing from note_get");
    assertEqual(savedSection.body_md, SCENARIO_BODY, "section body round-trip");

    collect("scenario", `note+section IPC round-trip ok (${noteId})`);
  } catch (error) {
    collect("scenario", error.stack || error.message, true);
  } finally {
    if (noteId) {
      try {
        await invokeCmd("note_purge", { id: noteId });
      } catch (error) {
        collect("scenario cleanup", `failed to purge smoke note ${noteId}: ${error.message}`, true);
      }
    }
  }
}

function cleanup() {
  socket?.close();
  if (!child || child.exitCode != null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

try {
  const target = await waitForTarget();
  startedAt = Date.now();
  await connect(target.webSocketDebuggerUrl);
  await Promise.all([cdp("Runtime.enable"), cdp("Log.enable"), cdp("Page.enable")]);
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "addEventListener('unhandledrejection', event => console.error('[brise-smoke] unhandled promise rejection', event.reason));" +
      // `SMOKE_SELFTEST=1 npm run smoke` must fail — a gate nobody has seen fail is not a gate.
      (process.env.SMOKE_SELFTEST ? "console.error('[brise-smoke] selftest failure');" : ""),
  });
  // A freshly launched app is already a clean boot, and we attach before its first script
  // runs — reloading it here aborts the in-flight navigation and the page never loads.
  // Only a reused instance needs the reload to get a boot we can observe.
  if (!child) await reloadApp();
  await waitForBoot();
  await runScenario();
} catch (error) {
  collect("smoke", error.stack || error.message, true);
} finally {
  cleanup();
}

const failures = messages.filter((message) => message.failure);
for (const message of messages) console.log(`[${message.kind}] ${message.text}`);
if (failures.length > 0) {
  console.error(`smoke failed with ${failures.length} runtime issue(s)`);
  process.exitCode = 1;
} else {
  console.log("smoke passed");
}
