// 자동화 평가 — 코퍼스 로더.
//
// 정답지 = src-tauri/tests/fixtures/automation/corpus.json (의미는 같은 폴더 README.md).
// 이 모듈은 파일을 읽어 "실행 가능한 노트"로 펼친다:
//   - {{SECRET:openai|github|aws}} → 실행 중에 조립한 가짜 토큰(커밋에 토큰 모양 리터럴을 두지 않는다 — 푸시 보호)
//   - {{REPEAT:문장:n}} → n 번 반복(격리 입력 상한 R12 시험)
//   - created_offset_days / updated_offset_min → reference_now 기준 실제 시각(벽시계를 쓰지 않는다)
// [[nXX]] 내부 링크 표기는 그대로 둔다(평가에서는 지식 노트 기록의 출처 표기로 읽는다).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const FIXTURE_DIR = resolve(REPO_ROOT, "src-tauri", "tests", "fixtures", "automation");
export const CORPUS_PATH = resolve(FIXTURE_DIR, "corpus.json");

// ⚠️ 이 세 줄의 조립 방식은 Rust 테스트(automation_corpus.rs)와 **글자 그대로** 같아야 한다.
// 토큰 모양 리터럴이 파일에 남지 않도록 조각을 이어 붙인다.
export const SECRET_VALUES = Object.freeze({
  openai: ["sk", "proj", "EVALFAKE0123456789abcdefghijklmnopqrstuvwxyzAB"].join("-"),
  github: "gh" + "p_" + "EVALFAKE" + "0123456789abcdefghijklmnopqr",
  aws: "AK" + "IA" + "EVALFAKEABCDEFGH",
});

/** 모든 가짜 비밀값에 들어 있는 표식 — 잘린 조각이 새어도 이걸로 잡는다. */
export const SECRET_MARKER = "EVALFAKE";

export function secretList() {
  return Object.values(SECRET_VALUES);
}

/** `{{SECRET:kind}}` 를 가짜 토큰으로, `{{REPEAT:s:n}}` 를 반복으로 펼친다. */
export function expandSecrets(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\{\{SECRET:([a-z]+)\}\}/g, (m, kind) => {
      const v = SECRET_VALUES[kind];
      if (!v) throw new Error(`알 수 없는 비밀값 종류: ${kind}`);
      return v;
    })
    .replace(/\{\{REPEAT:([\s\S]*?):(\d+)\}\}/g, (m, s, n) => s.repeat(Number(n)));
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const KST_MS = 9 * 3600 * 1000;

/** reference_now(+09:00) 기준 offset → { iso, date:"YYYY-MM-DD", md:"MM-DD", weekday:"목", ms } (KST). */
export function kstParts(ms) {
  const d = new Date(ms + KST_MS);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return {
    ms,
    date: `${y}-${mo}-${da}`,
    md: `${mo}-${da}`,
    time: `${hh}:${mi}`,
    weekday: WEEKDAYS[d.getUTCDay()],
    iso: `${y}-${mo}-${da}T${hh}:${mi}+09:00`,
  };
}

export function readCorpusRaw(path = CORPUS_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * 코퍼스를 읽어 펼친다. 반환값의 notes[] 는 원본 필드 + `created`/`updated`(kstParts) + 펼친 sections.
 * gold 는 손대지 않는다(정답지를 고치지 않는다).
 */
export function loadCorpus(path = CORPUS_PATH) {
  const raw = readCorpusRaw(path);
  const refMs = Date.parse(raw.reference_now);
  if (Number.isNaN(refMs)) throw new Error("reference_now 를 해석할 수 없다");
  const notes = raw.notes.map((n) => ({
    ...n,
    sections: n.sections.map((s) => ({ ...s, body: expandSecrets(s.body) })),
    created: kstParts(refMs + n.created_offset_days * 86400000),
    updated: kstParts(refMs + n.updated_offset_min * 60000),
  }));
  const byId = new Map(notes.map((n) => [n.id, n]));
  const folders = raw.folders;
  const folderByKey = new Map(folders.map((f) => [f.key, f]));
  const topicLabel = new Map(raw.topics.map((t) => [t.id, t.label]));
  return {
    raw,
    version: raw.version,
    referenceNow: kstParts(refMs),
    refMs,
    folders,
    folderByKey,
    topics: raw.topics,
    topicLabel,
    contradictions: raw.contradictions,
    notes,
    byId,
    qa: raw.qa,
  };
}

/** 노트 본문 = 섹션 본문을 이어 붙인 것(섹션이 여럿이면 이름을 머리로). */
export function noteBody(note) {
  if (note.sections.length === 1) return note.sections[0].body;
  return note.sections.map((s) => `## ${s.name}\n${s.body}`).join("\n\n");
}
