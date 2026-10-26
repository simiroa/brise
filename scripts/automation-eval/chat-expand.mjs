#!/usr/bin/env node
// 채팅 질문 → AI 검색어 확장을 기록한다(PLAN-2026-10-08 F22 후속 실험).
//
// 코퍼스 qa 질문마다 specs/ai/prompts/automation/chat_expand.md 로 검색어 배열을 받아
// src-tauri/tests/fixtures/automation/llm/recorded/chat_expand.json 에 쓴다. Rust 테스트
// (automation_corpus.rs chat_retrieval_with_llm_expansion_report)가 이 파일을 **재생**해 네트워크 없이
// "확장하면 재현율이 얼마나 오르나"를 잰다. 프롬프트는 dev 만 보고 고치고 holdout 은 채점에만 쓴다.
//
// 사용: BRISE_EVAL_API_KEY=… [BRISE_EVAL_MODEL=…] node scripts/automation-eval/chat-expand.mjs
// 키는 환경 변수에서만 읽고 어디에도 쓰지 않는다(llm.mjs 규칙 그대로).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTransport, liveConfigFromEnv, sha256 } from "./llm.mjs";
import { FIXTURE_DIR, REPO_ROOT, loadCorpus } from "./corpus.mjs";

const PROMPT_PATH = resolve(REPO_ROOT, "specs", "ai", "prompts", "automation", "chat_expand.md");
const OUT_DIR = join(FIXTURE_DIR, "llm", "recorded");
const OUT = join(OUT_DIR, "chat_expand.json");

function parseTerms(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string" && t.trim().length >= 2).map((t) => t.trim()).slice(0, 6) : [];
  } catch {
    return [];
  }
}

const cfg = liveConfigFromEnv();
if (!cfg.apiKey) {
  console.error("BRISE_EVAL_API_KEY 가 없다 — 환경 변수로만 받는다.");
  process.exit(2);
}
const system = readFileSync(PROMPT_PATH, "utf8");
const transport = createTransport({ mode: "live" });
const corpus = loadCorpus();
const items = {};
for (const q of corpus.qa) {
  const { text } = await transport.complete({ promptName: "chat_expand", system, user: q.question, promptSha: sha256(system) });
  items[q.id] = parseTerms(text);
  console.log(`${q.id} ${q.split.padEnd(7)} ${q.question}  →  ${JSON.stringify(items[q.id])}`);
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ prompt_sha: sha256(system), provider: cfg.provider, model: cfg.model, recorded_at: new Date().toISOString(), items }, null, 2) + "\n",
  "utf8",
);
console.log(`\n기록: ${OUT} (호출 ${transport.stats.live}회)`);
