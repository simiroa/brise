#!/usr/bin/env node
/**
 * 기능 카탈로그 건강도 검사.
 *
 * specs/features/*.yaml 의 shipped 항목이 (a) 존재하는 테스트에 연결돼 있고
 * (b) cases.expect 문자열이 그 테스트 파일에 그대로 단언돼 있는지 본다.
 * 배경: 기능이 늘수록 "테스트 파일은 있는데 이 유형의 기대 출력이 깨졌는지"를
 * 사람이 못 본다. Playwright로 우회하지 않고, 이미 있는 rust/vitest가 기대값을
 * 들고 있게 강제한다. 규약: specs/features/_conventions.yaml
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURES_DIR = join(ROOT, "specs", "features");
const SPECS_DIR = join(ROOT, "specs");
const STATUSES = new Set(["shipped", "in_progress", "removed"]);
const SMOKE = new Set(["boot"]);
const EXPECT_MIN = 4;

function posix(p) {
  return p.replace(/\\/g, "/");
}

function relToRoot(abs) {
  const prefix = posix(ROOT) + "/";
  const n = posix(abs);
  return n.startsWith(prefix) ? n.slice(prefix.length) : n;
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(posix(p));
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rustTestFnExists(text, name) {
  return new RegExp(
    `#\\[(?:test|tokio::test)\\]\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escapeRe(name)}\\s*\\(`,
  ).test(text);
}

function vitestItExists(text, name) {
  return new RegExp(`\\b(?:it|test)\\(\\s*(['\`"])${escapeRe(name)}\\1`).test(text);
}

function flattenExpectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    if (value.length >= EXPECT_MIN) out.push(value);
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    for (const v of value) flattenExpectStrings(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) flattenExpectStrings(v, out);
  }
  return out;
}

function specRefPath(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.replace(/#.*$/, "").trim();
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveVerify(rel, kind) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { error: `경로 없음: ${rel}` };
  const files = statSync(abs).isDirectory() ? walkFiles(abs) : [posix(abs)];
  const filtered =
    kind === "vitest"
      ? files.filter((f) => /\.test\.tsx?$/.test(f))
      : kind === "rust"
        ? files.filter((f) => f.endsWith(".rs"))
        : files;
  if (filtered.length === 0) return { error: `${kind} 파일이 없음: ${rel}` };
  return { files: filtered };
}

function selfTest() {
  const rust = `#[cfg(test)]
mod tests {
    #[test]
    fn parses_rss2_items_including_guid_link_cdata_html_and_plain_description() {}
    fn helper() {}
}
`;
  if (!rustTestFnExists(rust, "parses_rss2_items_including_guid_link_cdata_html_and_plain_description")) {
    throw new Error("selftest: rust test fn 미탐");
  }
  if (rustTestFnExists(rust, "helper")) {
    throw new Error("selftest: helper 를 테스트로 오탐");
  }
  const tokio = "#[tokio::test]\nasync fn test_invariant_ai_organize() {}";
  if (!rustTestFnExists(tokio, "test_invariant_ai_organize")) {
    throw new Error("selftest: #[tokio::test] 미탐");
  }
  if (!/#\[(?:test|tokio::test)\]/.test(tokio)) {
    throw new Error("selftest: 파일 레벨 tokio::test 미탐");
  }
  const vitest = `it("run now calls collect_source_run_now and toasts the added count", async () => {});`;
  if (!vitestItExists(vitest, "run now calls collect_source_run_now and toasts the added count")) {
    throw new Error("selftest: vitest it() 미탐");
  }
  const strings = flattenExpectStrings({
    guid: "urn:uuid:first-1",
    n: 2,
    ok: true,
    nested: { body_md: "Hello world" },
    skip: "ab",
  });
  if (!strings.includes("urn:uuid:first-1") || !strings.includes("Hello world")) {
    throw new Error("selftest: expect 문자열 flatten 실패");
  }
  if (strings.some((s) => s === "ab" || s === "2")) {
    throw new Error("selftest: 짧은 문자열/숫자를 expect 리터럴로 잡음");
  }
}
selfTest();

const errors = [];
const notes = [];
const features = [];
const seenIds = new Map();

const yamlFiles = readdirSync(FEATURES_DIR)
  .filter((name) => name.endsWith(".yaml") && name !== "_conventions.yaml")
  .sort();

if (yamlFiles.length === 0) {
  console.error("check-features: specs/features/*.yaml 이 없다");
  process.exit(1);
}

for (const file of yamlFiles) {
  const rel = `specs/features/${file}`;
  let doc;
  try {
    doc = yaml.parse(readFileSync(join(FEATURES_DIR, file), "utf8"));
  } catch (err) {
    errors.push(`${rel}: YAML 파싱 실패 — ${err.message}`);
    continue;
  }
  if (!doc || !Array.isArray(doc.features)) {
    errors.push(`${rel}: 최상위 features: 배열이 없다`);
    continue;
  }
  doc.features.forEach((feat, i) => {
    const loc = `${rel} features[${i}]`;
    if (!feat || typeof feat !== "object") {
      errors.push(`${loc}: 객체가 아니다`);
      return;
    }
    const id = feat.id;
    const name = feat.name;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${loc}: id 없음`);
      return;
    }
    if (typeof name !== "string" || !name.trim()) {
      errors.push(`${loc} ${id}: name 없음`);
    }
    if (seenIds.has(id)) {
      errors.push(`${loc} ${id}: id 중복 (이미 ${seenIds.get(id)})`);
    } else {
      seenIds.set(id, loc);
    }
    const status = feat.status ?? "shipped";
    if (!STATUSES.has(status)) {
      errors.push(`${loc} ${id}: status '${status}' 는 shipped|in_progress|removed 가 아님`);
    }
    features.push({ ...feat, status, loc, file: rel });
  });
}

function checkSpecRefs(feat) {
  const refs = [
    ...asList(feat.commands),
    ...asList(feat.db),
    ...asList(feat.service),
    ...asList(feat.states),
  ];
  for (const raw of refs) {
    const path = specRefPath(raw);
    if (!path) continue;
    const abs = join(SPECS_DIR, path);
    if (!existsSync(abs)) {
      errors.push(`${feat.loc} ${feat.id}: 스펙 참조 없음 specs/${path}`);
    }
  }
}

function loadTexts(files) {
  const map = new Map();
  for (const f of files) {
    map.set(f, readFileSync(f, "utf8"));
  }
  return map;
}

for (const feat of features) {
  checkSpecRefs(feat);
  const verify = feat.verify ?? {};
  const rustRels = asList(verify.rust);
  const vitestRels = asList(verify.vitest);
  const smoke = verify.smoke;
  const cases = Array.isArray(feat.cases) ? feat.cases : [];
  const rustFiles = [];
  const vitestFiles = [];

  if (smoke != null && !SMOKE.has(smoke)) {
    errors.push(`${feat.loc} ${feat.id}: verify.smoke '${smoke}' 는 허용 목록이 아님 (${[...SMOKE].join("|")})`);
  }

  for (const rel of rustRels) {
    if (typeof rel !== "string") {
      errors.push(`${feat.loc} ${feat.id}: verify.rust 항목이 문자열이 아님`);
      continue;
    }
    const resolved = resolveVerify(rel, "rust");
    if (resolved.error) {
      errors.push(`${feat.loc} ${feat.id}: verify.rust ${resolved.error}`);
      continue;
    }
    const abs = join(ROOT, rel);
    const hasTest = (text) => /#\[(?:test|tokio::test)\]/.test(text);
    if (!statSync(abs).isDirectory()) {
      const text = readFileSync(resolved.files[0], "utf8");
      if (!hasTest(text)) {
        errors.push(`${feat.loc} ${feat.id}: verify.rust ${rel} 에 #[test] 가 없다`);
      }
    } else if (!resolved.files.some((f) => hasTest(readFileSync(f, "utf8")))) {
      errors.push(`${feat.loc} ${feat.id}: verify.rust ${rel} 아래에 #[test] 가 없다`);
    }
    rustFiles.push(...resolved.files);
  }

  for (const rel of vitestRels) {
    if (typeof rel !== "string") {
      errors.push(`${feat.loc} ${feat.id}: verify.vitest 항목이 문자열이 아님`);
      continue;
    }
    const resolved = resolveVerify(rel, "vitest");
    if (resolved.error) {
      errors.push(`${feat.loc} ${feat.id}: verify.vitest ${resolved.error}`);
      continue;
    }
    vitestFiles.push(...resolved.files);
  }

  feat._rustFiles = rustFiles;
  feat._vitestFiles = vitestFiles;
  feat._caseCount = cases.length;
  feat._linkedCases = 0;

  const hasVerify = rustFiles.length > 0 || vitestFiles.length > 0 || smoke === "boot";
  if (feat.status === "shipped" && !hasVerify) {
    errors.push(`${feat.loc} ${feat.id}: shipped 인데 verify 가 없다`);
  } else if (feat.status === "in_progress" && !hasVerify) {
    notes.push(`${feat.id} in_progress — verify 없음`);
  }

  if (feat.status === "removed") continue;

  const searchFiles = [...rustFiles, ...vitestFiles];
  const texts = searchFiles.length ? loadTexts(searchFiles) : new Map();

  cases.forEach((c, ci) => {
    const cloc = `${feat.loc} cases[${ci}]`;
    if (!c || typeof c !== "object") {
      errors.push(`${cloc}: 객체가 아니다`);
      return;
    }
    if (typeof c.id !== "string" || !c.id.trim()) {
      errors.push(`${cloc}: id 없음`);
      return;
    }
    if (typeof c.covered_by !== "string" || !c.covered_by.trim()) {
      errors.push(`${cloc} ${c.id}: covered_by 없음 — 기대값은 테스트 함수/it()에 연결돼야 한다`);
      return;
    }
    let hitFile = null;
    for (const [file, text] of texts) {
      if (rustTestFnExists(text, c.covered_by) || vitestItExists(text, c.covered_by)) {
        hitFile = file;
        break;
      }
    }
    if (!hitFile) {
      errors.push(
        `${cloc} ${c.id}: covered_by '${c.covered_by}' 를 verify 파일에서 찾지 못했다`,
      );
      return;
    }
    feat._linkedCases += 1;
    const literals = flattenExpectStrings(c.expect);
    const haystack = texts.get(hitFile);
    for (const lit of literals) {
      if (!haystack.includes(lit)) {
        errors.push(
          `${cloc} ${c.id}: expect 리터럴이 ${relToRoot(hitFile)} 에 없다: ${JSON.stringify(lit)}`,
        );
      }
    }
  });
}

const shipped = features.filter((f) => f.status === "shipped").length;
const wip = features.filter((f) => f.status === "in_progress").length;
const removed = features.filter((f) => f.status === "removed").length;
const withCases = features.filter((f) => f._caseCount > 0).length;
const caseTotal = features.reduce((n, f) => n + (f._caseCount || 0), 0);

function layer(feat) {
  const bits = [];
  if (feat._rustFiles?.length) bits.push("rust");
  if (feat._vitestFiles?.length) bits.push("vitest");
  if (feat.verify?.smoke) bits.push(`smoke:${feat.verify.smoke}`);
  if (feat._caseCount) bits.push(`cases ${feat._linkedCases}/${feat._caseCount}`);
  return bits.join("  ") || "—";
}

console.log(
  `check-features  ${features.length} features  (${shipped} shipped, ${wip} in_progress, ${removed} removed, ${withCases} with cases / ${caseTotal} cases)`,
);
const nameWidth = Math.min(42, Math.max(18, ...features.map((f) => String(f.name || "").length)));
for (const feat of features) {
  const name = String(feat.name || "").padEnd(nameWidth);
  const st = feat.status.padEnd(12);
  console.log(`  ${feat.id.padEnd(7)} ${name} ${st} ${layer(feat)}`);
}
for (const n of notes) console.log(`  note  ${n}`);

if (errors.length > 0) {
  console.error(`check-features failed with ${errors.length} issue(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("check-features passed");
