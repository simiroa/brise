// 자동화 평가 — 마크다운 보고서.
//
// 점수표(dev · holdout 나란히) · 실패 목록(노트 id) · 비용(요청 수·글자 수) · 건너뜀 · 해석.
// 키·비밀값은 여기 오지 않는다: run.meta.transport 는 describe()(키 없음), 요청 본문은 표에 싣지 않는다.

import { rowPerfect } from "./scorers.mjs";

const COLS = ["dev", "holdout"];

function cell(row, col, columns) {
  if (!columns.includes(col)) return "—";
  const v = row.byCol[col];
  if (!v) return "—";
  if (row.kind === "rate") {
    if (v.den === 0) return "해당 없음";
    const pct = Math.round((v.num / v.den) * 1000) / 10;
    return `${pct}% (${v.num}/${v.den})${v.num === v.den ? "" : " ✗"}`;
  }
  if (row.kind === "info") return `${v.num}`;
  return v.num === 0 ? `0 ✓${v.den ? ` (/${v.den})` : ""}` : `**${v.num}** ✗${v.den ? ` (/${v.den})` : ""}`;
}

/** 점수표만(마크다운). CLI 표준 출력에도 쓴다. */
export function renderScoreTable(run, scores) {
  const columns = run.meta.columns;
  const lines = ["| 채점기 | 지표 | dev | holdout |", "|---|---|---|---|"];
  for (const s of scores) for (const r of s.rows) lines.push(`| ${s.label} | ${r.label} | ${cell(r, "dev", columns)} | ${cell(r, "holdout", columns)} |`);
  return lines.join("\n");
}

/** 모든 판정 행이 완벽한가(칸별). */
export function perfectByCol(run, scores) {
  const out = {};
  for (const col of run.meta.columns) out[col] = scores.every((s) => s.rows.every((r) => rowPerfect(r, col) !== false));
  return out;
}

const INTERPRETATIONS = [
  "범위: `--split dev` 는 dev 노트만 처리, `holdout`·`all` 은 dev+holdout 을 처리하고 칸을 노트·질문의 split 으로 나눈다(holdout 노트가 dev 노트와 이어지므로).",
  "처리 대상: 마지막 수정 5분 안(R5, 시각으로 계산) · `handled_by: \"schedule\"`(예약 실행이 다룸 — 사용자 설정의 대역) · `ai_excluded_default` 폴더(`--include-ai-excluded` 면 처리) · 지식 노트 폴더(=기존 주제 노트) 는 분류하지 않는다. 도착 채점에서는 settle_skip · handled_by=schedule · (기본 실행의) requires_ai_unlock 노트·질문을 뺀다 — '채점 제외' 절에 이유와 함께.",
  "주제: 모델의 `topic_hint` 를 정규화해 묶는다(정답 주제로 묶지 않음). 기존 주제 노트(n35·n36)와 제목이 같으면 그 노트를 갱신. 한 노트짜리 묶음도 지식 노트로(\"씨앗\" 규칙은 이 평가에 없음).",
  "폴더: gold.folder 가 시작 폴더와 같으면 제자리 — 정답 출력은 지금 폴더 key 그대로(따로 \"stay\" 값 없음), 옮기면 오답. `folder_unscored` 만 채점 제외, 라벨 없는 노트는 실패로 센다.",
  "`topic:null` 은(조각 메모가 아니어도) \"주제 없음이 정답\" — 지식 노트에 들어가면 순도 감점. `new_topic_ok` 노트만 새 주제 허용.",
  "병합: 요청 스키마에 칸이 없어 지식 노트 출력에 `duplicates [[id,id]]` 를 더했다(merge_with 재현 · not_merge_with 위반).",
  "엇갈림: 요약의 `엇갈림:` 줄은 두 노트를 `[[id]]` 로 표기해야 기계가 확인한다. 사람이 고친 요약(n36, R2)은 덮지 않으므로 C_crdt 는 다이제스트로만 드러날 수 있다.",
  "다이제스트 `evidence_ids` = 근거 **노트** id(W12 본문은 주제 노트 id).",
  "QA 근거 충분성: 근거 노트 중 처리되었고 정답 주제가 있는 것만 본다 — 없으면 해당 없음(q06 일정은 날짜·달력이 답함, q07 은 requires_ai_unlock 이라 기본 실행에선 해당 없음).",
  "안전 \"처리하면 안 되는 노트\" 는 파이프라인 회귀 감시다 — 예약 대상 건너뛰기가 같은 gold 필드(handled_by)를 읽으므로 모델 품질의 증거가 아니다.",
  "아무것도 안 하는 모델(폴더 그대로·태그/날짜/주제 없음)도 만점이 나오는 행: 순도·지어냄·금지 태그·병합 위반·대부분의 안전 행, 그리고 q01(기존 지식 노트 n35 의 기록만으로 통과). 실측(dev): 폴더 1/21 · 주제 재현율 3/22 · 링크 1/6 · QA 1/7 — 이 행들은 재현율 행과 함께 읽는다.",
  "재생 키 = sha256(promptName + \"\\n\" + 보낸 사용자 메시지). 지시문을 고쳐도 키는 같고, 녹음의 prompt_sha 가 다르면 \"낡은 녹음\"으로만 보고한다.",
];

/**
 * @param run pipeline 결과 · @param scores scoreAll 결과 · @param o { generatedAt, title? }
 */
export function renderReport(run, scores, o = {}) {
  const m = run.meta;
  const t = m.transport ?? {};
  const out = [];
  out.push(`# ${o.title ?? "자동화 평가 보고서"}`);
  out.push("");
  out.push(`- 생성: ${o.generatedAt ?? "(시각 없음)"} · 코퍼스 v${m.corpusVersion} · 기준 시각 ${m.referenceNow}`);
  out.push(
    `- 전송: ${t.mode}${t.provider ? ` · ${t.provider}` : ""}${t.model ? ` · ${t.model}` : ""}${t.baseUrlHost ? ` · ${t.baseUrlHost}` : ""}${t.replayDir ? ` · 재생 ${t.replayDir}` : ""}`,
  );
  out.push(`- 범위: ${m.split} (칸: ${m.columns.join(", ")}) · AI 제외 폴더 ${m.includeAiExcluded ? "포함" : "건너뜀"}${m.forceProcess?.length ? ` · ⚠️ 강제 처리 ${m.forceProcess.join(",")}` : ""}`);
  out.push(`- 프롬프트 sha: ${Object.entries(m.promptSha ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (run.misses.length) out.push(`- ⚠️ **재생 누락 ${run.misses.length}건** — 녹음/픽스처가 지금 입력과 맞지 않는다(다시 기록하거나 gold-replay.mjs 재생성).`);
  if (run.stale) out.push(`- ⚠️ 낡은 녹음 ${run.stale}건 — 지시문이 녹음 뒤에 바뀌었다(재기록 권장).`);
  const perfect = perfectByCol(run, scores);
  out.push(`- 판정: ${Object.entries(perfect).map(([c, ok]) => `${c} ${ok ? "전부 통과" : "실패 있음"}`).join(" · ")}`);
  out.push("");
  out.push("## 점수");
  out.push("");
  out.push(renderScoreTable(run, scores));
  out.push("");
  out.push("## 실패 목록");
  out.push("");
  let any = false;
  for (const s of scores) {
    const fs = s.failures.filter((f) => m.columns.includes(f.col));
    if (!fs.length) continue;
    any = true;
    out.push(`### ${s.label} (${fs.length})`);
    for (const col of COLS)
      for (const f of fs.filter((x) => x.col === col)) out.push(`- [${col}] ${f.ids.join(", ")} — ${f.msg}`);
    out.push("");
  }
  if (!any) out.push("(없음)\n");
  out.push("## 채점 제외(해당 없음)");
  out.push("");
  let anyNa = false;
  for (const s of scores) {
    const list = (s.na ?? []).filter((x) => m.columns.includes(x.col));
    for (const x of list) {
      anyNa = true;
      out.push(`- [${x.col}] ${s.label}: ${x.ids.join(", ")} — ${x.msg}`);
    }
  }
  if (!anyNa) out.push("(없음)");
  out.push("");
  out.push("## 비용");
  out.push("");
  out.push("| 단계 | 요청 수 | 보낸 글자 | 가림 |");
  out.push("|---|---|---|---|");
  let reqs = 0;
  let chars = 0;
  for (const step of ["classify", "knowledge", "digest"]) {
    const rs = run.requests.filter((r) => r.step === step);
    const ch = rs.reduce((s, r) => s + r.chars, 0);
    const rd = rs.reduce((s, r) => s + r.redactions, 0);
    reqs += rs.length;
    chars += ch;
    out.push(`| ${step} | ${rs.length} | ${ch.toLocaleString("en-US")} | ${rd} |`);
  }
  out.push(`| 합계 | ${reqs} | ${chars.toLocaleString("en-US")} | |`);
  out.push("");
  const topics = run.state?.topics ?? [];
  out.push(
    `응답 글자 ${run.responseChars.toLocaleString("en-US")} · 처리 노트 ${run.eligible.length} · 지식 노트 ${topics.length}(새로 ${topics.filter((x) => x.is_new).length}) · 주제/노트 비율 ${run.eligible.length ? (topics.length / run.eligible.length).toFixed(2) : "—"} (WS 기준 ≤ 0.33)`,
  );
  out.push("");
  out.push("## 건너뜀");
  out.push("");
  out.push(`- 쓰는 중(R5): ${run.skipped.settle.join(", ") || "없음"}`);
  out.push(`- 예약 실행 대상(handled_by=schedule): ${run.skipped.schedule.join(", ") || "없음"}`);
  out.push(`- AI 제외 폴더: ${run.skipped.ai_excluded.join(", ") || "없음"}`);
  out.push(`- 기존 지식 노트(입력 아님): ${run.skipped.knowledge.join(", ") || "없음"}`);
  out.push("");
  out.push("## 해석(README 가 정하지 않은 부분)");
  out.push("");
  for (const s of INTERPRETATIONS) out.push(`- ${s}`);
  out.push("");
  return out.join("\n");
}
