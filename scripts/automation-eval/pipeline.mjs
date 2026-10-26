// 자동화 평가 — 파이프라인(분류 → 지식 노트 → 주간 다이제스트).
//
// 엔진(Rust) 없이 PLAN-2026-10-08 의 AI 단계만 재현한다. 코드가 할 일(R5 도착 판정·R12 가림·
// R9 접두/인용 검증·A12 없는 링크 제거·R2 사람이 고친 요약 보호)은 여기서 코드로 한다 —
// 채점 대상은 모델 출력이지 이 판정이 아니다.
//
// 바깥으로 나가는 모든 요청은 send() 한 곳을 지난다: 노트 본문 가림 → 8천 자 자르기(R12, 가림 뒤에
// 잘라야 토큰 조각이 정규식을 빠져나가지 않는다) → 메시지 전체 한 번 더 가림 → 본문 그대로 로그.
//
// 범위(split): dev = dev 노트만. holdout·all = dev+holdout 전부(holdout 노트는 dev 노트와 이어지므로
// 이미 dev 노트가 있는 노트북에 도착한 것으로 본다). 채점 칸은 노트/질문의 split 으로 나눈다.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, noteBody, kstParts } from "./corpus.mjs";
import { redact } from "./redact.mjs";
import { sha256, ReplayMissError } from "./llm.mjs";

export const PROMPT_DIR = resolve(REPO_ROOT, "specs", "ai", "prompts", "automation");
export const PROMPT_NAMES = ["classify", "knowledge", "digest"];
export const INPUT_CAP = 8000; // R12 격리 입력 상한(노트당 앞 8천 자)
export const SETTLE_MIN = 5; // R5 쓰는 중 판정

/** 프롬프트 파일 → 모델에 보낼 텍스트. CRLF 정규화, 맨 앞 HTML 주석 제거. */
export function loadPrompt(name, dir = PROMPT_DIR) {
  let t = readFileSync(resolve(dir, `${name}.md`), "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  t = t.replace(/^\s*<!--[\s\S]*?-->\s*\n/, "");
  return t.trim() + "\n";
}

export function loadPrompts(dir = PROMPT_DIR) {
  const out = {};
  for (const name of PROMPT_NAMES) {
    const text = loadPrompt(name, dir);
    out[name] = { name, text, sha: sha256(text) };
  }
  return out;
}

/** 노트 내용을 신뢰할 수 없는 데이터로 감싼다. 안의 닫는 태그는 JSON 이스케이프로 무력화. */
export function wrapUntrusted(obj) {
  const json = JSON.stringify(obj).replace(/<(\/?untrusted_data)/gi, "\\u003c$1");
  return `<untrusted_data>\n${json}\n</untrusted_data>`;
}

/** wrapUntrusted 의 역 — 보낸 사용자 메시지에서 입력 JSON 을 꺼낸다(오라클·테스트용). */
export function parseUntrusted(user) {
  const m = String(user ?? "").match(/<untrusted_data>\n([\s\S]*)\n<\/untrusted_data>/);
  return m ? JSON.parse(m[1]) : null;
}

/** 이전 지식 노트 제목 맞추기용 정규화. */
export function normTitle(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\s·・\-—–_.,:;!?()[\]{}'"`~]/g, "");
}

/** 본문을 보낼 모양으로: 가림 → 8천 자. */
export function prepareBody(text) {
  const r = redact(text);
  return { text: r.text.length > INPUT_CAP ? r.text.slice(0, INPUT_CAP) : r.text, count: r.count };
}

export function parseModelJson(raw) {
  if (raw == null) return { parsed: null, error: "no_response" };
  const t = String(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return { parsed: JSON.parse(t), error: null };
  } catch {
    return { parsed: null, error: "malformed_json" };
  }
}

// ── 스키마 검사 ─────────────────────────────────────────────────────────────

const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isIntOrNull = (v, lo, hi) => v === null || v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);

function extraKeys(obj, allowed, where, issues) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.push(`${where}extra_key:${k}`);
}

export function validateClassify(p, closedSet) {
  const issues = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["not_object"];
  const keys = ["folder", "tags", "date", "region", "todos", "topic_hint", "suspicious_instructions"];
  extraKeys(p, keys, "", issues);
  if (typeof p.folder !== "string") issues.push("folder_missing");
  else if (p.folder !== "unsure" && !closedSet.includes(p.folder)) issues.push(`folder_out_of_set:${p.folder}`);
  if (!isStrArr(p.tags)) issues.push("tags_not_string_array");
  if (p.date !== null && p.date !== undefined) {
    const d = p.date;
    if (typeof d !== "object" || Array.isArray(d)) issues.push("date_not_object");
    else {
      extraKeys(d, ["year", "month", "day", "time", "end"], "date.", issues);
      if (!isIntOrNull(d.year, 1900, 2200)) issues.push("date_year");
      if (!isIntOrNull(d.month, 1, 12)) issues.push("date_month");
      if (!isIntOrNull(d.day, 1, 31)) issues.push("date_day");
      if (d.time != null && !(typeof d.time === "string" && /^\d{1,2}:\d{2}$/.test(d.time))) issues.push("date_time");
      if (d.end != null && (typeof d.end !== "object" || Array.isArray(d.end))) issues.push("date_end");
    }
  }
  if (p.region !== null && p.region !== undefined && typeof p.region !== "string") issues.push("region_type");
  if (!isStrArr(p.todos)) issues.push("todos_not_string_array");
  if (p.topic_hint !== null && p.topic_hint !== undefined && typeof p.topic_hint !== "string") issues.push("topic_hint_type");
  if (typeof p.suspicious_instructions !== "boolean") issues.push("suspicious_not_boolean");
  return issues;
}

export function validateKnowledge(p) {
  const issues = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["not_object"];
  extraKeys(p, ["topic_notes", "duplicates"], "", issues);
  if (!Array.isArray(p.topic_notes)) issues.push("topic_notes_not_array");
  else
    p.topic_notes.forEach((t, i) => {
      const w = `topic_notes[${i}].`;
      if (!t || typeof t !== "object") return issues.push(`${w}not_object`);
      extraKeys(t, ["topic", "title", "summary", "log_append", "related_topics", "links"], w, issues);
      if (typeof t.title !== "string" || !t.title.trim()) issues.push(`${w}title`);
      if (t.summary !== null && typeof t.summary !== "string") issues.push(`${w}summary`);
      if (!Array.isArray(t.log_append)) issues.push(`${w}log_append`);
      else
        t.log_append.forEach((e, j) => {
          if (!e || typeof e !== "object") return issues.push(`${w}log_append[${j}]`);
          extraKeys(e, ["date", "quote", "source_id"], `${w}log_append[${j}].`, issues);
          if (typeof e.source_id !== "string") issues.push(`${w}log_append[${j}].source_id`);
          if (e.quote !== null && typeof e.quote !== "string") issues.push(`${w}log_append[${j}].quote`);
        });
      if (t.related_topics !== undefined && !isStrArr(t.related_topics)) issues.push(`${w}related_topics`);
      if (t.links !== undefined && !isStrArr(t.links)) issues.push(`${w}links`);
    });
  if (p.duplicates !== undefined && !(Array.isArray(p.duplicates) && p.duplicates.every((d) => isStrArr(d) && d.length === 2)))
    issues.push("duplicates");
  return issues;
}

export const DIGEST_KINDS = ["new_topic", "new_link", "contradiction", "open_question"];

export function validateDigest(p) {
  const issues = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["not_object"];
  extraKeys(p, ["items"], "", issues);
  if (!Array.isArray(p.items)) issues.push("items_not_array");
  else
    p.items.forEach((it, i) => {
      if (!it || typeof it !== "object") return issues.push(`items[${i}]`);
      extraKeys(it, ["kind", "text", "evidence_ids"], `items[${i}].`, issues);
      if (!DIGEST_KINDS.includes(it.kind)) issues.push(`items[${i}].kind:${it.kind}`);
      if (typeof it.text !== "string") issues.push(`items[${i}].text`);
      if (!isStrArr(it.evidence_ids)) issues.push(`items[${i}].evidence_ids`);
    });
  return issues;
}

// ── 범위·도착 판정 ──────────────────────────────────────────────────────────

const byCreated = (a, b) => a.created.ms - b.created.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 어떤 노트를 처리할지(코드 판정). 모델을 채점하려는 게 아니라 엔진이 할 일을 흉내 낸다.
 * - settle: 마지막 수정이 5분 안(R5, 시각으로 계산).
 * - schedule: gold.handled_by === "schedule" — 계속 자라는 노트는 도착이 아니라 예약 실행이 다룬다(R5).
 *   사용자가 폼에서 "예약"으로 돌린 설정의 대역(감지 신호가 코퍼스에 없음).
 * - ai_excluded: 폴더의 ai_excluded_default(includeAiExcluded 면 처리 — "기존 폴더는 그대로" R12 상황).
 * - knowledge: 지식 노트 폴더의 노트 = 이미 있는 주제 노트(입력이 아니다).
 * forceProcess = 파이프라인 결함 흉내(안전 채점기 회귀 시험용).
 */
export function selectNotes(corpus, { split = "dev", includeAiExcluded = false, forceProcess = [] } = {}) {
  const scope = corpus.notes.filter((n) => (split === "dev" ? n.split === "dev" : true)).sort(byCreated);
  const skipped = { settle: [], schedule: [], ai_excluded: [], knowledge: [] };
  const eligible = [];
  const existingTopics = [];
  const settleMs = corpus.refMs - SETTLE_MIN * 60000;
  for (const n of scope) {
    const f = corpus.folderByKey.get(n.folder) ?? {};
    if (f.role === "knowledge") {
      existingTopics.push(n);
      skipped.knowledge.push(n.id);
      continue;
    }
    const forced = forceProcess.includes(n.id);
    let why = null;
    if (f.ai_excluded_default && !includeAiExcluded) why = "ai_excluded";
    else if (n.updated.ms > settleMs) why = "settle";
    else if (n.gold?.handled_by === "schedule") why = "schedule";
    if (why && !forced) skipped[why].push(n.id);
    else eligible.push(n);
  }
  return { scope, eligible, skipped, existingTopics };
}

export function closedFolderSet(corpus, includeAiExcluded) {
  return corpus.folders
    .filter((f) => f.role !== "knowledge" && (includeAiExcluded || !f.ai_excluded_default))
    .map((f) => f.key);
}

function foldersText(corpus, closed) {
  return corpus.folders
    .filter((f) => closed.includes(f.key))
    .map((f) => `- ${f.key}: ${f.name}${f.rules ? ` — ${f.rules}` : ""}`)
    .join("\n");
}

/** 지식 노트 폴더의 노트 → 주제 노트 상태. */
export function existingTopicState(note) {
  const summarySecs = note.sections.filter((s) => s.role === "summary");
  const logSecs = note.sections.filter((s) => s.role === "log");
  const log = [];
  for (const s of logSecs)
    for (const line of s.body.split(/\r?\n/)) {
      const m = line.match(/^-\s*(\d{2}-\d{2})\s*"([^"]*)"\s*→\s*\[\[([a-z]\d+)\]\]/);
      if (m) log.push({ date: m[1], quote: m[2], source_id: m[3], is_new: false });
    }
  return {
    id: note.id,
    title: note.title,
    key: normTitle(note.title),
    is_new: false,
    touched: false,
    summary: summarySecs.map((s) => s.body).join("\n"),
    summary_editable: summarySecs.length > 0 && summarySecs.every((s) => !!s.ai_origin),
    log,
    members: log.map((l) => l.source_id),
    links: [],
    related_topics: [],
  };
}

// ── 실행 ────────────────────────────────────────────────────────────────────

/**
 * @param {{corpus, transport, split?, includeAiExcluded?, forceProcess?, prompts?}} o
 * @returns run — 채점기가 읽는 결과(모델 원문·파싱·검사·요청 로그·최종 지식 노트 상태)
 */
export async function runPipeline(o) {
  const { corpus, transport } = o;
  const split = o.split ?? "dev";
  const includeAiExcluded = !!o.includeAiExcluded;
  const forceProcess = o.forceProcess ?? [];
  const prompts = o.prompts ?? loadPrompts();
  const sel = selectNotes(corpus, { split, includeAiExcluded, forceProcess });
  const closed = closedFolderSet(corpus, includeAiExcluded);

  const run = {
    meta: {
      split,
      columns: split === "all" ? ["dev", "holdout"] : [split],
      includeAiExcluded,
      forceProcess,
      corpusVersion: corpus.version,
      referenceNow: corpus.referenceNow.iso,
      transport: transport.describe(),
      promptSha: Object.fromEntries(PROMPT_NAMES.map((n) => [n, prompts[n].sha.slice(0, 12)])),
    },
    scopeIds: sel.scope.map((n) => n.id),
    eligible: sel.eligible.map((n) => n.id),
    skipped: sel.skipped,
    closedFolders: closed,
    classify: {},
    clusters: [],
    knowledge: [],
    digest: null,
    state: null,
    requests: [],
    redactionsByNote: {},
    sentBodies: {},
    misses: [],
    stale: 0,
    responseChars: 0,
  };

  async function send({ step, prompt, system, user, noteIds, preRedactions }) {
    const sys = redact(system);
    const usr = redact(user);
    const body = transport.providerBody(sys.text, usr.text);
    run.requests.push({
      step,
      prompt: prompt.name,
      note_ids: noteIds,
      body,
      chars: sys.text.length + usr.text.length,
      redactions: preRedactions + sys.count + usr.count,
    });
    try {
      const r = await transport.complete({ promptName: prompt.name, system: sys.text, user: usr.text, promptSha: prompt.sha, noteIds });
      run.responseChars += r.text.length;
      if (r.stale) run.stale += 1;
      return { raw: r.text, error: null };
    } catch (e) {
      if (e instanceof ReplayMissError) {
        run.misses.push({ prompt: prompt.name, key: e.key, note_ids: noteIds });
        return { raw: null, error: "replay_miss" };
      }
      return { raw: null, error: `transport: ${String(e?.message ?? e).slice(0, 300)}` };
    }
  }

  const sendBody = (n) => {
    if (!run.sentBodies[n.id]) {
      const p = prepareBody(noteBody(n));
      run.sentBodies[n.id] = p.text;
      run.redactionsByNote[n.id] = p.count;
    }
    return run.sentBodies[n.id];
  };

  // 1) 분류 — 노트마다 한 번.
  const existing = sel.existingTopics.map(existingTopicState);
  const existingTitles = existing.map((t) => t.title);
  const classifySystem = prompts.classify.text
    .replace("{{FOLDERS}}", foldersText(corpus, closed))
    .replace("{{EXISTING_TOPICS}}", existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "(없음)");
  for (const n of sel.eligible) {
    const body = sendBody(n);
    const input = {
      note: {
        id: n.id,
        title: n.title,
        created: `${n.created.date} (${n.created.weekday}) ${n.created.time}`,
        current_folder: n.folder,
        origin: n.origin,
        body,
      },
    };
    const r = await send({
      step: "classify",
      prompt: prompts.classify,
      system: classifySystem,
      user: wrapUntrusted(input),
      noteIds: [n.id],
      preRedactions: run.redactionsByNote[n.id],
    });
    const p = r.raw == null ? { parsed: null, error: r.error } : parseModelJson(r.raw);
    run.classify[n.id] = {
      raw: r.raw,
      parsed: p.parsed,
      error: p.error,
      issues: p.parsed ? validateClassify(p.parsed, closed) : [],
    };
  }

  // 2) 주제 묶기 — 모델의 topic_hint 를 정규화해 묶는다(정답 주제로 묶지 않는다).
  const existingByKey = new Map(existing.map((t) => [t.key, t]));
  const clusters = new Map();
  const suspiciousFlag = new Set();
  for (const n of sel.eligible) {
    const c = run.classify[n.id]?.parsed;
    if (c?.suspicious_instructions === true) suspiciousFlag.add(n.id);
    const hint = typeof c?.topic_hint === "string" ? c.topic_hint.trim() : "";
    if (!hint) continue;
    const key = normTitle(hint);
    if (!key) continue;
    if (!clusters.has(key)) {
      const ex = existingByKey.get(key);
      clusters.set(key, { label: ex ? ex.title : hint, key, noteIds: [], existingId: ex ? ex.id : null });
    }
    clusters.get(key).noteIds.push(n.id);
  }
  run.clusters = [...clusters.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  run.suspiciousFlagged = [...suspiciousFlag].sort();

  // 3) 지식 노트 — 묶음마다 한 번.
  const knownTopics = [...new Set([...run.clusters.map((c) => c.label), ...existingTitles])].sort();
  for (const cl of run.clusters) {
    const ex = cl.existingId ? existing.find((t) => t.id === cl.existingId) : null;
    const notes = cl.noteIds.map((id) => corpus.byId.get(id));
    const input = {
      topic_label: cl.label,
      existing: ex
        ? {
            title: ex.title,
            summary: ex.summary,
            summary_editable: ex.summary_editable,
            logged_ids: ex.members,
            log: ex.log.map((l) => ({ date: l.date, quote: l.quote, source_id: l.source_id })),
          }
        : null,
      known_topics: knownTopics,
      notes: notes.map((n) => {
        const sus = suspiciousFlag.has(n.id);
        return { id: n.id, title: n.title, created: n.created.date, suspicious: sus, body: sus ? null : sendBody(n) };
      }),
    };
    const pre = notes.reduce((s, n) => s + (suspiciousFlag.has(n.id) ? 0 : run.redactionsByNote[n.id] ?? 0), 0);
    const r = await send({
      step: "knowledge",
      prompt: prompts.knowledge,
      system: prompts.knowledge.text,
      user: wrapUntrusted(input),
      noteIds: cl.noteIds,
      preRedactions: pre,
    });
    const p = r.raw == null ? { parsed: null, error: r.error } : parseModelJson(r.raw);
    run.knowledge.push({
      label: cl.label,
      existingId: cl.existingId,
      inputNoteIds: cl.noteIds,
      knownTopics,
      raw: r.raw,
      parsed: p.parsed,
      error: p.error,
      issues: p.parsed ? validateKnowledge(p.parsed) : [],
    });
  }

  run.state = buildKnowledgeState(run, existing, suspiciousFlag, corpus);

  // 4) 주간 다이제스트 — 이번 실행에서 바뀐 주제 노트만.
  const touched = run.state.topics.filter((t) => t.touched);
  if (touched.length) {
    const from = kstParts(corpus.refMs - 6 * 86400000).md;
    const input = {
      week: `${from} ~ ${corpus.referenceNow.md}`,
      topic_notes: touched.map((t) => ({
        title: t.title,
        is_new: t.is_new,
        summary: t.summary,
        log: t.log.map((l) => ({ date: l.date, quote: l.quote, source_id: l.source_id, is_new: l.is_new })),
        links: t.links,
      })),
    };
    const ids = new Set();
    for (const t of touched) {
      t.log.forEach((l) => ids.add(l.source_id));
      t.links.forEach((l) => ids.add(l));
    }
    const r = await send({
      step: "digest",
      prompt: prompts.digest,
      system: prompts.digest.text,
      user: wrapUntrusted(input),
      noteIds: [...ids].sort(),
      preRedactions: 0,
    });
    const p = r.raw == null ? { parsed: null, error: r.error } : parseModelJson(r.raw);
    run.digest = {
      inputNoteIds: [...ids].sort(),
      raw: r.raw,
      parsed: p.parsed,
      error: p.error,
      issues: p.parsed ? validateDigest(p.parsed) : [],
    };
  }
  return run;
}

/**
 * 지식 노트 최종 상태(코드 쪽 규칙 적용 뒤). 채점기는 이 상태를 본다.
 * - 없는 id(입력 밖)는 버린다(A12). 이미 기록된 노트는 다시 덧붙이지 않는다(R9 덧붙이기만).
 * - 의심 노트(분류가 표시)는 인용 없이 링크만(R9). 인용이 보낸 원문의 부분 문자열이 아니면 인용을 버린다(R9).
 * - 사람이 고친 요약(summary_editable=false)은 덮지 않는다(R2).
 */
export function buildKnowledgeState(run, existing, suspiciousFlag, corpus) {
  const topics = existing.map((t) => ({ ...t, log: [...t.log], members: [...t.members] }));
  const byKey = new Map(topics.map((t) => [t.key, t]));
  const notes = {
    dropped_ids: [],
    dup_appends: [],
    quote_on_suspicious: [],
    non_verbatim: [],
    r2_violations: [],
    duplicates: [],
    dropped_related: [],
  };
  let seq = 0;
  for (const call of run.knowledge) {
    const p = call.parsed;
    if (!p || !Array.isArray(p.topic_notes)) continue;
    const allowed = new Set(call.inputNoteIds);
    const known = new Set(call.knownTopics.map(normTitle));
    const tns = p.topic_notes.filter((t) => t && typeof t === "object");
    for (const tn of tns) {
      const title = typeof tn.title === "string" && tn.title.trim() ? tn.title.trim() : String(tn.topic ?? "").trim();
      if (!title) continue;
      let target = byKey.get(normTitle(title)) ?? byKey.get(normTitle(tn.topic));
      if (!target && call.existingId && tns.length === 1) target = topics.find((t) => t.id === call.existingId);
      if (!target) {
        seq += 1;
        target = {
          id: `K${String(seq).padStart(2, "0")}`,
          title,
          key: normTitle(title),
          is_new: true,
          touched: false,
          summary: "",
          summary_editable: true,
          log: [],
          members: [],
          links: [],
          related_topics: [],
        };
        topics.push(target);
        byKey.set(target.key, target);
      }
      target.touched = true;
      if (typeof tn.summary === "string" && tn.summary.trim()) {
        if (target.summary_editable) target.summary = tn.summary;
        else notes.r2_violations.push({ topic: target.title, label: call.label });
      }
      for (const e of Array.isArray(tn.log_append) ? tn.log_append : []) {
        const sid = e?.source_id;
        if (typeof sid !== "string" || !allowed.has(sid)) {
          notes.dropped_ids.push({ label: call.label, id: sid, field: "log_append" });
          continue;
        }
        if (target.members.includes(sid)) {
          notes.dup_appends.push({ topic: target.title, id: sid });
          continue;
        }
        let quote = typeof e.quote === "string" && e.quote.trim() ? e.quote : null;
        if (quote && suspiciousFlag.has(sid)) {
          notes.quote_on_suspicious.push({ id: sid });
          quote = null;
        }
        if (quote) {
          const sent = run.sentBodies[sid] ?? "";
          const orig = noteBody(corpus.byId.get(sid));
          if (!sent.includes(quote) && !orig.includes(quote)) {
            notes.non_verbatim.push({ id: sid, quote: quote.slice(0, 80) });
            quote = null;
          }
        }
        target.log.push({ date: typeof e.date === "string" ? e.date : "", quote, source_id: sid, is_new: true });
        target.members.push(sid);
      }
      for (const l of Array.isArray(tn.links) ? tn.links : []) {
        if (typeof l === "string" && allowed.has(l)) {
          if (!target.links.includes(l)) target.links.push(l);
        } else notes.dropped_ids.push({ label: call.label, id: l, field: "links" });
      }
      for (const r of Array.isArray(tn.related_topics) ? tn.related_topics : []) {
        if (typeof r === "string" && known.has(normTitle(r))) {
          if (!target.related_topics.includes(r)) target.related_topics.push(r);
        } else notes.dropped_related.push({ label: call.label, topic: r });
      }
    }
    for (const d of Array.isArray(p.duplicates) ? p.duplicates : []) {
      if (Array.isArray(d) && d.length === 2 && d.every((x) => typeof x === "string" && allowed.has(x)) && d[0] !== d[1]) {
        notes.duplicates.push([...d].sort());
      } else notes.dropped_ids.push({ label: call.label, id: JSON.stringify(d), field: "duplicates" });
    }
  }
  return { topics, ...notes };
}
