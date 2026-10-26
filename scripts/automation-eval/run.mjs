#!/usr/bin/env node
// 자동화 평가 CLI.
//
//   node scripts/automation-eval/run.mjs --split dev|holdout|all --mode replay|record|live
//        [--replay-dir <dir>] [--record-dir <dir>] [--out <dir>] [--include-ai-excluded]
//
// 기본값: --split dev · --mode replay · --replay-dir .eval/recorded/ · --record-dir .eval/recorded/
//         --out .eval/reports/<시각>/ (report.md + run.json)
// 라이브(record·live): 키는 환경 변수 BRISE_EVAL_API_KEY 에서만. 모델 BRISE_EVAL_MODEL.
//   OpenAI 호환은 BRISE_EVAL_BASE_URL(…/v1), 공급자를 강제하려면 BRISE_EVAL_PROVIDER=gemini|openai.
// 규칙: 프롬프트는 dev 로만 다듬는다 — holdout 결과를 보고 프롬프트를 고치지 않는다(README).

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, SECRET_MARKER, loadCorpus, secretList } from "./corpus.mjs";
import { createTransport, scrubSecret } from "./llm.mjs";
import { runPipeline } from "./pipeline.mjs";
import { scoreAll } from "./scorers.mjs";
import { renderReport, renderScoreTable, perfectByCol } from "./report.mjs";

function parseArgs(argv) {
  const a = { split: "dev", mode: "replay", replayDir: null, recordDir: null, out: null, includeAiExcluded: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} 에 값이 없다`);
      return x;
    };
    if (k === "--split") a.split = v();
    else if (k === "--mode") a.mode = v();
    else if (k === "--replay-dir") a.replayDir = v();
    else if (k === "--record-dir") a.recordDir = v();
    else if (k === "--out") a.out = v();
    else if (k === "--include-ai-excluded") a.includeAiExcluded = true;
    else if (k === "-h" || k === "--help") a.help = true;
    else throw new Error(`알 수 없는 인자: ${k}`);
  }
  if (!["dev", "holdout", "all"].includes(a.split)) throw new Error(`--split 은 dev|holdout|all`);
  if (!["replay", "record", "live"].includes(a.mode)) throw new Error(`--mode 는 replay|record|live`);
  return a;
}

// 밀리초까지 — 같은 초에 두 번 돌려도(기본·--include-ai-excluded) 보고서가 덮이지 않게.
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log("node scripts/automation-eval/run.mjs --split dev|holdout|all --mode replay|record|live [--replay-dir d] [--record-dir d] [--out d] [--include-ai-excluded]");
    return 0;
  }
  const defRec = resolve(REPO_ROOT, ".eval", "recorded");
  const transport = createTransport({
    mode: a.mode,
    replayDir: resolve(a.replayDir ?? defRec),
    recordDir: resolve(a.recordDir ?? defRec),
  });
  const corpus = loadCorpus();
  const run = await runPipeline({ corpus, transport, split: a.split, includeAiExcluded: a.includeAiExcluded });
  const scores = scoreAll(run, { corpus, secrets: secretList(), marker: SECRET_MARKER });
  const generatedAt = new Date().toISOString();
  const outDir = resolve(a.out ?? resolve(REPO_ROOT, ".eval", "reports", stamp()));
  mkdirSync(outDir, { recursive: true });
  const md = renderReport(run, scores, { generatedAt });
  writeFileSync(resolve(outDir, "report.md"), md, "utf8");
  // run.json: 모델 원문·가린 요청 본문 포함(키 없음). .eval/ 은 커밋하지 않는다.
  writeFileSync(resolve(outDir, "run.json"), JSON.stringify({ run, scores }, null, 1), "utf8");
  console.log(renderScoreTable(run, scores));
  console.log("");
  if (run.misses.length) console.log(`⚠️ 재생 누락 ${run.misses.length}건`);
  const p = perfectByCol(run, scores);
  console.log(`판정: ${Object.entries(p).map(([c, ok]) => `${c} ${ok ? "전부 통과" : "실패 있음"}`).join(" · ")}`);
  console.log(`보고서: ${resolve(outDir, "report.md")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // 스택은 내보내지 않고, 메시지에서도 키·비밀값 모양을 한 번 더 지운다.
    console.error(`자동화 평가 실패: ${scrubSecret(e?.message ?? e, process.env.BRISE_EVAL_API_KEY)}`);
    process.exit(1);
  },
);
