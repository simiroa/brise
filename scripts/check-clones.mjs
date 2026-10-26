#!/usr/bin/env node
/**
 * 복제 클러스터 가드 — scripts/clone-clusters.json 이 SSOT.
 *
 * (a) 클러스터 dead 식별자의 src/ 재등장. 주석도 걸린다(surface contract 과 같은 트레이드오프).
 * (b) src/ 아래 *WindowApp.tsx 는 AuxWindowChrome 을 써야 한다(allowlist 는 JSON).
 * (c) function daysInMonth 정의는 days-in-month 의 owner+variants 안에서만.
 * (d) function formatSize 정의는 format-size 의 owner+variants 안에서만
 *     (formatFileSize 는 다른 이름 — 걸리지 않는다).
 *
 * docs/ 와 scripts/ 는 스캔하지 않는다. 테스트 파일(*.test.ts / *.test.tsx)은 제외.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const LEDGER = "scripts/clone-clusters.json";

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((ext) => name.endsWith(ext)) && !/\.test\.(tsx|ts)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function normPath(p) {
  return p.replace(/\\/g, "/");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clusterById(clusters, id) {
  const c = clusters.find((x) => x.id === id);
  if (!c) {
    console.error(`check-clones: cluster "${id}" missing from ${LEDGER}`);
    process.exit(2);
  }
  return c;
}

function allowedDefPaths(cluster) {
  return new Set(
    [...(cluster.owner ?? []), ...(cluster.variants ?? [])].map(normPath),
  );
}

if (!existsSync(LEDGER)) {
  console.error(`check-clones: ledger missing (${LEDGER}).`);
  process.exit(2);
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const clusters = ledger.clusters;
if (!Array.isArray(clusters)) {
  console.error(`check-clones: ${LEDGER} "clusters" must be an array.`);
  process.exit(2);
}

const errors = [];

// ── (a) dead identifiers ────────────────────────────────────────────────────
const dead = [...new Set(clusters.flatMap((c) => c.dead ?? []))];
if (dead.length) {
  const deadRe = new RegExp(
    dead.map((name) => `(?<![\\w])${escapeRe(name)}(?![\\w])`).join("|"),
    "g",
  );
  for (const file of walk(SRC, [".ts", ".tsx", ".css"])) {
    const text = readFileSync(file, "utf8");
    deadRe.lastIndex = 0;
    let m;
    while ((m = deadRe.exec(text))) {
      errors.push({
        file,
        line: lineNumber(text, m.index),
        msg: `dead identifier \`${m[0]}\` must not reappear in src/`,
      });
    }
  }
}

// ── (b) *WindowApp.tsx must use AuxWindowChrome ─────────────────────────────
const windowAllow = new Set((ledger.windowAppAllowlist ?? []).map(normPath));
for (const file of walk(SRC, [".tsx"])) {
  const base = file.split("/").pop() ?? file;
  if (!base.endsWith("WindowApp.tsx")) continue;
  if (windowAllow.has(file)) continue;
  const text = readFileSync(file, "utf8");
  if (!text.includes("AuxWindowChrome")) {
    errors.push({
      file,
      line: 1,
      msg: `*WindowApp.tsx must use AuxWindowChrome`,
    });
  }
}

// ── (c)(d) function defs only in owner+variants ─────────────────────────────
const DEF_CHECKS = [
  {
    id: "days-in-month",
    name: "daysInMonth",
    re: /export\s+function\s+daysInMonth\b|function\s+daysInMonth\b/g,
  },
  {
    id: "format-size",
    name: "formatSize",
    re: /export\s+function\s+formatSize\b|function\s+formatSize\b/g,
  },
  {
    id: "format-relative-time",
    name: "formatRelativeTime",
    re: /export\s+function\s+formatRelative(?:Time)?\b|function\s+formatRelative(?:Time)?\b/g,
  },
];

for (const check of DEF_CHECKS) {
  const allowed = allowedDefPaths(clusterById(clusters, check.id));
  for (const file of walk(SRC, [".ts", ".tsx"])) {
    const text = readFileSync(file, "utf8");
    check.re.lastIndex = 0;
    let m;
    while ((m = check.re.exec(text))) {
      if (!allowed.has(file)) {
        errors.push({
          file,
          line: lineNumber(text, m.index),
          msg: `function ${check.name} defined outside cluster "${check.id}" owner+variants`,
        });
      }
    }
  }
}

if (errors.length) {
  console.error(`check-clones: FAILED — ${errors.length} violation(s)`);
  for (const e of errors) {
    console.error(`  ${e.file}:${e.line}: ${e.msg}`);
  }
  process.exit(1);
}

console.log("check-clones: ok");
