// 자동화 평가 — LLM 전송층(재생 / 기록 / 라이브).
//
// - replay: <dir>/<promptName>.jsonl 에서 응답을 읽는다. 키 = sha256(promptName + "\n" + 사용자 메시지).
//           사용자 메시지 = 가림(R12)까지 끝난 <untrusted_data> 블록 — 즉 "보낸 입력" 그대로.
//           지시문(시스템 프롬프트)은 키에 넣지 않고 prompt_sha 로 따로 적어, 프롬프트를 고친 뒤의
//           옛 녹음은 "stale" 로 보고만 한다(골드 픽스처가 프롬프트 문구 수정에 깨지지 않게).
// - record: 라이브로 부르고 <dir>/<promptName>.jsonl 에 한 줄씩 덧붙인다.
// - live:   라이브만.
// - fn:     함수가 답한다(골드 오라클·테스트용).
//
// 키는 환경 변수 BRISE_EVAL_API_KEY 에서만 읽는다. 키는 헤더로만 보내고(URL·본문·로그·보고서·에러에 없음),
// 에러 문자열에서도 지운다.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.mjs";

export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function replayKey(promptName, input) {
  return sha256(promptName + "\n" + input);
}

export class ReplayMissError extends Error {
  constructor(promptName, key) {
    super(`재생 응답 없음(${promptName} ${key.slice(0, 12)}) — 픽스처가 낡았다: 다시 생성할 것`);
    this.name = "ReplayMissError";
    this.promptName = promptName;
    this.key = key;
  }
}

/** <dir>/*.jsonl → Map(key → entry). 같은 키가 여럿이면 마지막 줄이 이긴다. CRLF 허용. */
export function loadReplayDir(dir) {
  const map = new Map();
  if (!dir || !existsSync(dir)) return map;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const e = JSON.parse(t);
      if (e && typeof e.key === "string") map.set(e.key, e);
    }
  }
  return map;
}

/** 환경 변수에서 라이브 설정. 키 값은 반환값의 apiKey 에만 있고 describe() 에는 없다. */
export function liveConfigFromEnv(env = process.env) {
  const baseUrl = env.BRISE_EVAL_BASE_URL || "";
  const provider = env.BRISE_EVAL_PROVIDER || (baseUrl ? "openai" : "gemini");
  const model = env.BRISE_EVAL_MODEL || (provider === "gemini" ? "gemini-2.5-flash" : "");
  return { provider, model, baseUrl, apiKey: env.BRISE_EVAL_API_KEY || "" };
}

export function scrubSecret(text, apiKey) {
  let s = String(text ?? "");
  if (apiKey) s = s.split(apiKey).join("[key]");
  return redact(s).text;
}

async function postJson(url, headers, body, { apiKey, timeoutMs = 90000, fetchImpl = globalThis.fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body, signal: ctl.signal });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      lastErr = new Error(`HTTP ${res.status}: ${scrubSecret(text.slice(0, 300), apiKey)}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = new Error(scrubSecret(e?.message ?? String(e), apiKey));
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw lastErr;
}

/** 공급자별 요청 본문(헤더 제외 — 키 없음). 안전 채점이 이 문자열을 검사한다. */
export function buildProviderBody(cfg, system, user) {
  if (cfg.provider === "gemini") {
    return JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    });
  }
  return JSON.stringify({
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
}

async function callLive(cfg, body, fetchImpl) {
  if (cfg.provider === "gemini") {
    if (!cfg.apiKey) throw new Error("BRISE_EVAL_API_KEY 가 없다(gemini)");
    if (!cfg.model) throw new Error("BRISE_EVAL_MODEL 이 없다");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    const json = await postJson(url, { "content-type": "application/json", "x-goog-api-key": cfg.apiKey }, body, {
      apiKey: cfg.apiKey,
      fetchImpl,
    });
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("");
  }
  if (cfg.provider === "openai") {
    if (!cfg.baseUrl) throw new Error("BRISE_EVAL_BASE_URL 이 없다(openai 호환)");
    if (!cfg.model) throw new Error("BRISE_EVAL_MODEL 이 없다");
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const headers = { "content-type": "application/json" };
    if (cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey;
    const json = await postJson(url, headers, body, { apiKey: cfg.apiKey, fetchImpl });
    return json?.choices?.[0]?.message?.content ?? "";
  }
  throw new Error(`알 수 없는 공급자: ${cfg.provider}`);
}

/**
 * 전송기를 만든다.
 * @param {{mode:'replay'|'record'|'live'|'fn', replayDir?:string, recordDir?:string, fn?:Function,
 *          live?:{provider,model,baseUrl,apiKey}, fetchImpl?:Function}} opts
 */
export function createTransport(opts) {
  const mode = opts.mode;
  const live = opts.live ?? (mode === "record" || mode === "live" ? liveConfigFromEnv() : null);
  const replay = mode === "replay" ? loadReplayDir(opts.replayDir) : null;
  const stats = { calls: 0, misses: 0, stale: 0, live: 0 };

  return {
    mode,
    stats,
    /** 보고서용 설명 — 키 없음. */
    describe() {
      if (mode === "replay") return { mode, replayDir: opts.replayDir, entries: replay.size };
      if (mode === "fn") return { mode, name: opts.name ?? "fn" };
      let host = "";
      try {
        host = live.baseUrl ? new URL(live.baseUrl).host : "";
      } catch {
        host = "(잘못된 URL)";
      }
      return { mode, provider: live.provider, model: live.model, baseUrlHost: host, recordDir: opts.recordDir };
    },
    /** 공급자 본문(로그용). 라이브가 아니면 공급자 중립 형태. */
    providerBody(system, user) {
      if (live) return buildProviderBody(live, system, user);
      return JSON.stringify({ system, user });
    },
    /** → { text, key, stale } */
    async complete({ promptName, system, user, promptSha, noteIds }) {
      stats.calls += 1;
      const key = replayKey(promptName, user);
      if (mode === "replay") {
        const e = replay.get(key);
        if (!e) {
          stats.misses += 1;
          throw new ReplayMissError(promptName, key);
        }
        const stale = !!(promptSha && e.prompt_sha && e.prompt_sha !== promptSha);
        if (stale) stats.stale += 1;
        return { text: typeof e.response === "string" ? e.response : JSON.stringify(e.response), key, stale };
      }
      if (mode === "fn") {
        const text = await opts.fn({ promptName, system, user, noteIds, key });
        return { text: typeof text === "string" ? text : JSON.stringify(text), key, stale: false };
      }
      const body = buildProviderBody(live, system, user);
      stats.live += 1;
      const text = await callLive(live, body, opts.fetchImpl);
      if (mode === "record") {
        const dir = opts.recordDir;
        mkdirSync(dir, { recursive: true });
        const line = {
          key,
          prompt: promptName,
          prompt_sha: promptSha ?? null,
          note_ids: noteIds ?? [],
          model: live.model,
          recorded_at: new Date().toISOString(),
          response: text,
        };
        appendFileSync(join(dir, `${promptName}.jsonl`), JSON.stringify(line) + "\n", "utf8");
      }
      return { text, key, stale: false };
    },
  };
}
