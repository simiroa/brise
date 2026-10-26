#!/usr/bin/env node
// 자동화 평가 — 골드 재생 세트 생성기.
//
// 정답지(corpus.json 의 gold)만 보고 "완벽한 모델"의 응답을 만든다(오라클). 파이프라인을 오라클로
// 돌려 나온 응답을 src-tauri/tests/fixtures/automation/llm/gold/<prompt>.jsonl 로 쓴다.
// 이 세트를 재생하면 모든 채점기가 100% 여야 한다 — 채점기와 정답지가 서로 맞는다는 증거.
//
// ⚠️ 채점기(scorers.mjs)의 도우미를 쓰지 않는다. 정답 필드를 날것으로 읽는다(같은 도우미의 결함이
// 양쪽에서 상쇄되지 않게).
//
// 실행: node scripts/automation-eval/gold-replay.mjs [--out <dir>]
// 코퍼스·파이프라인 입력 모양을 바꾸면 다시 돌린다(테스트가 "재생 누락"으로 알려 준다).

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_DIR, loadCorpus } from "./corpus.mjs";
import { createTransport } from "./llm.mjs";
import { PROMPT_NAMES, loadPrompts, parseUntrusted, runPipeline } from "./pipeline.mjs";

export const GOLD_DIR = resolve(FIXTURE_DIR, "llm", "gold");

/** 골드 세트가 덮는 실행 구성(테스트가 같은 목록으로 재생한다). */
export const GOLD_CONFIGS = [
  { split: "dev", includeAiExcluded: false },
  { split: "all", includeAiExcluded: false },
  { split: "dev", includeAiExcluded: true },
  { split: "all", includeAiExcluded: true },
];

/** 짧은 원문 인용: 첫 문단 앞 120자(원문의 부분 문자열). */
function oracleQuote(body) {
  const para = String(body).split("\n\n")[0];
  return para.length > 120 ? para.slice(0, 120) : para;
}

/** 정답지로 답하는 함수 — createTransport({mode:'fn'}) 에 넣는다. */
export function createOracle(corpus) {
  const raw = corpus.raw;
  const notesById = new Map(raw.notes.map((n) => [n.id, n]));
  const labelOf = new Map(raw.topics.map((t) => [t.id, t.label]));

  function classify(input) {
    const n = notesById.get(input.note.id);
    const g = n.gold ?? {};
    const date = g.date
      ? {
          year: g.date.year,
          month: g.date.month,
          day: g.date.day,
          time: g.date.time,
          end: g.date.end ? { year: g.date.end.year, month: g.date.end.month, day: g.date.end.day } : null,
        }
      : null;
    let hint = null;
    if (g.topic) hint = labelOf.get(g.topic);
    else if (Array.isArray(g.topic_any) && g.topic_any.length) hint = labelOf.get(g.topic_any[0]);
    return {
      // 제자리 = 지금 폴더 key 그대로(classify.md). folder_unscored 노트는 채점하지 않으니 제자리로 둔다.
      // 라벨이 없으면 null 을 그대로 낸다 — 스키마·폴더 채점기가 잡게(조용히 통과시키지 않는다).
      folder: g.folder_unscored ? input.note.current_folder : g.folder ?? null,
      tags: Array.isArray(g.tags_any) ? g.tags_any.map((fam) => fam[0]) : [],
      date,
      region: g.region ?? null,
      todos: Array.isArray(g.todos) ? g.todos : [],
      topic_hint: hint,
      suspicious_instructions: !!g.suspicious,
    };
  }

  function knowledge(input) {
    const logged = new Set(input.existing?.logged_ids ?? []);
    const ids = input.notes.map((n) => n.id);
    const dateOf = new Map(input.notes.map((n) => [n.id, n.created.slice(5)]));
    for (const l of input.existing?.log ?? []) if (!dateOf.has(l.source_id)) dateOf.set(l.source_id, l.date);
    const title = input.existing?.title ?? input.topic_label;
    const log_append = input.notes
      .filter((n) => !logged.has(n.id))
      .map((n) => ({ date: n.created.slice(5), quote: n.suspicious || n.body == null ? null : oracleQuote(n.body), source_id: n.id }));
    let summary = null;
    if (!input.existing || input.existing.summary_editable) {
      const all = new Set([...ids, ...logged]);
      const lines = [`${title}: 기록 ${all.size}건.`];
      for (const c of raw.contradictions) {
        const [a, b] = c.notes;
        if (all.has(a) && all.has(b)) lines.push(`엇갈림: ${dateOf.get(a)} ${c.gist.split("→")[0].trim()} [[${a}]] / ${dateOf.get(b)} ${(c.gist.split("→")[1] ?? "").trim()} [[${b}]]`);
      }
      lines.push("열린 질문: 이 흐름이 다음 달에도 이어질까?");
      summary = lines.join("\n");
    }
    const duplicates = [];
    for (const n of input.notes) {
      const mw = notesById.get(n.id)?.gold?.merge_with;
      for (const o of mw ? [mw].flat() : []) if (ids.includes(o)) duplicates.push([n.id, o]);
    }
    return {
      topic_notes: [{ topic: input.topic_label, title, summary, log_append, related_topics: [], links: ids }],
      duplicates,
    };
  }

  function digest(input) {
    const items = [];
    const all = new Set();
    for (const t of input.topic_notes) {
      t.log.forEach((l) => all.add(l.source_id));
      t.links.forEach((l) => all.add(l));
    }
    for (const t of input.topic_notes)
      if (t.is_new) items.push({ kind: "new_topic", text: `새 주제: ${t.title}`, evidence_ids: t.log.map((l) => l.source_id).slice(0, 3) });
    for (const c of raw.contradictions)
      if (c.notes.every((id) => all.has(id))) items.push({ kind: "contradiction", text: c.gist, evidence_ids: [...c.notes] });
    const q = input.topic_notes.find((t) => String(t.summary ?? "").includes("열린 질문") && t.log.length);
    if (q) items.push({ kind: "open_question", text: `${q.title}: 이 흐름이 다음 달에도 이어질까?`, evidence_ids: [q.log[0].source_id] });
    return { items };
  }

  return ({ promptName, user }) => {
    const input = parseUntrusted(user);
    if (!input) throw new Error(`오라클: 입력을 읽을 수 없다(${promptName})`);
    if (promptName === "classify") return classify(input);
    if (promptName === "knowledge") return knowledge(input);
    if (promptName === "digest") return digest(input);
    throw new Error(`오라클: 알 수 없는 프롬프트 ${promptName}`);
  };
}

/** 골드 세트를 만든다 → Map(prompt → entries[]). outDir 를 주면 파일로 쓴다. */
export async function generateGold({ outDir = null, corpus = loadCorpus() } = {}) {
  const oracle = createOracle(corpus);
  const entries = new Map();
  const prompts = loadPrompts();
  const fn = (req) => {
    const response = oracle(req);
    entries.set(req.key, { key: req.key, prompt: req.promptName, prompt_sha: null, note_ids: req.noteIds ?? [], response });
    return response;
  };
  for (const cfg of GOLD_CONFIGS) {
    await runPipeline({ corpus, transport: createTransport({ mode: "fn", fn, name: "gold-oracle" }), prompts, ...cfg });
  }
  const byPrompt = new Map(PROMPT_NAMES.map((p) => [p, []]));
  for (const e of [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) byPrompt.get(e.prompt).push(e);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const p of PROMPT_NAMES) {
      const file = resolve(outDir, `${p}.jsonl`);
      if (existsSync(file)) rmSync(file);
      writeFileSync(file, byPrompt.get(p).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }
  }
  return byPrompt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? resolve(process.argv[i + 1]) : GOLD_DIR;
  const res = await generateGold({ outDir: out });
  for (const [p, list] of res) console.log(`${p}: ${list.length}개 → ${resolve(out, p + ".jsonl")}`);
}
