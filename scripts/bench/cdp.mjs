/**
 * 최소 CDP 클라이언트 — 3단계 실앱 측정(scripts/bench/suites/app.mjs, docs/PLAN-2026-10-23-perf-baselines.md §5).
 *
 * WebView2 를 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` 로 띄우면 브라우저 프로세스가
 * `http://127.0.0.1:<port>/json/*` 를 연다. 여기서는 그 HTTP 목록과 페이지 타깃 웹소켓 세션만 쓴다(Node 의 전역
 * fetch·WebSocket, 의존성 없음).
 *
 * scripts/smoke.mjs 에도 비슷한 연결 코드가 있지만 그쪽은 모듈 전역 상태(소켓 하나·대기열 하나)로 짜여 있어 창
 * 여러 개(본 창 + 설정 창)를 동시에 붙잡는 측정에 맞지 않는다 — 그래서 세션을 객체로 다시 썼다. smoke.mjs 는
 * 건드리지 않는다(계획 §5.5 의 "공용 모듈로 빼기"는 smoke 를 소유한 쪽이 이 모듈로 갈아타면 된다).
 */
import net from "node:net";

export const DEFAULT_CDP_PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `/json/<path>` 를 읽는다. 연결이 안 되거나 응답이 이상하면 null(포트가 아직 안 열렸거나 이미 닫혔다). */
export async function cdpHttpJson(port, path, timeoutMs = 1000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // silent-ok: 포트가 아직(또는 더는) 안 열려 있다는 뜻 — 호출자가 null 로 판단한다
    return null;
  }
}

/** 페이지 타깃 목록(없으면 빈 배열). */
export async function listPages(port) {
  const list = await cdpHttpJson(port, "list");
  return Array.isArray(list) ? list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl) : [];
}

/** TCP 포트에 누가 듣고 있나(127.0.0.1). */
export function portInUse(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** 포트가 닫힐 때까지(이전 WebView2 브라우저 프로세스가 완전히 빠질 때까지). 닫히면 true. */
export async function waitPortClosed(port, timeoutMs = 15_000, pollMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await portInUse(port))) return true;
    await sleep(pollMs);
  }
  return false;
}

/** 페이지 세션 하나. send() 는 id 로 응답을 짝짓고, 이벤트는 on() 으로 받는다. */
export class CdpSession {
  /** @param {WebSocket} ws */
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any, method: string}>} */
    this.waiting = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  /** @param {string} wsUrl */
  static open(wsUrl, { label = wsUrl, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP 웹소켓을 ${timeoutMs}ms 안에 못 열었다: ${label}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws, label));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP 웹소켓 연결 실패: ${label}`));
      });
    });
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      // silent-ok: CDP 는 JSON 만 보낸다 — 깨진 프레임은 버린다(대기 중인 요청은 시간 초과로 드러난다)
      return;
    }
    if (typeof msg.id === "number") {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
      else w.resolve(msg.result ?? {});
      return;
    }
    const set = this.handlers.get(msg.method);
    if (set) for (const fn of [...set]) fn(msg.params ?? {});
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(`${w.method}: CDP 연결이 닫혔다(${this.label})`));
    }
    this.waiting.clear();
  }

  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP 연결이 이미 닫혔다(${this.label})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: ${timeoutMs}ms 시간 초과(${this.label})`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 응답을 기다리지 않고 보낸다(프로세스를 끝내는 명령처럼 답이 안 올 수 있는 것). */
  fire(method, params = {}) {
    if (this.closed) return;
    this.ws.send(JSON.stringify({ id: this.nextId++, method, params }));
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  /**
   * 페이지에서 식을 평가해 값을 돌려준다. 예외가 나면 throw(조용히 undefined 로 넘기지 않는다).
   * @param {string} expression
   */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, { timeoutMs });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`평가 실패(${this.label}): ${d.exception?.description ?? d.text ?? "알 수 없는 예외"}`);
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // silent-ok: 이미 닫힌 소켓
    }
    this.#onClose();
  }
}

/** Tauri 창 라벨(`__TAURI_INTERNALS__.metadata.currentWindow.label`). 못 읽으면 null. */
export async function windowLabelOf(target) {
  let s;
  try {
    s = await CdpSession.open(target.webSocketDebuggerUrl, { label: target.url, timeoutMs: 2000 });
    return await s.evaluate("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null", {
      awaitPromise: false,
      timeoutMs: 2000,
    });
  } catch {
    // silent-ok: 막 생기는(또는 사라지는) 타깃 — 다음 폴링에서 다시 본다
    return null;
  } finally {
    s?.close();
  }
}

/**
 * 라벨이 `label` 인 Tauri 창의 페이지 타깃이 나타날 때까지 기다린다. 펫·설정 창도 같은 URL 의 페이지
 * 타깃이라 URL 만으로는 본 창을 고를 수 없다.
 * @returns {Promise<object>} /json/list 의 타깃
 */
export async function waitForWindowTarget(port, label, { timeoutMs = 30_000, pollMs = 25, urlRe = /^https?:\/\/tauri\.localhost\//, isAlive = () => true } = {}) {
  const end = Date.now() + timeoutMs;
  const known = new Map(); // targetId → label(재질의 줄이기)
  while (Date.now() < end) {
    if (!isAlive()) throw new Error(`'${label}' 창을 기다리는 중 앱 프로세스가 끝났다`);
    const pages = (await listPages(port)).filter((t) => urlRe.test(t.url ?? ""));
    for (const t of pages) {
      let l = known.get(t.id);
      if (l === undefined || l === null) {
        l = await windowLabelOf(t);
        known.set(t.id, l);
      }
      if (l === label) return t;
    }
    await sleep(pollMs);
  }
  throw new Error(`'${label}' 창의 CDP 타깃이 ${timeoutMs}ms 안에 안 나타났다(포트 ${port})`);
}
