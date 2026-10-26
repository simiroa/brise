#!/usr/bin/env node
// i18n gate over the per-namespace layout src/i18n/<locale>/<namespace>.json.
//
// Checks, in order:
//   1. Namespace parity — every locale directory must contain exactly the same
//      set of <namespace>.json files (a namespace file present in one locale
//      but missing in another = fail).
//   2. Key parity — inside every namespace, all locales must expose the same
//      set of flattened dotted keys.
//   3. Deletion detection — current keys are compared against
//      scripts/i18n-keys-snapshot.json. Parity alone cannot catch a key deleted
//      from ALL three locales at once; the snapshot can. Intentional deletions
//      pass by refreshing the snapshot:
//        node scripts/check-i18n.mjs --update-snapshot
//   4. Unused keys — defined but never referenced from src/.
//   5. Undefined calls — literal t("key") calls referencing nonexistent keys.
// Fails the build so drift is caught by CI instead of discovered by a user
// seeing a raw key on screen.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const i18nDir = path.join(__dirname, "..", "src", "i18n");
const snapshotFile = path.join(__dirname, "i18n-keys-snapshot.json");

const LOCALES = ["en", "fr", "ko"];
const updateSnapshot = process.argv.includes("--update-snapshot");

/** Flatten a nested object into a Set of dotted key paths. */
function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function loadLocale(locale) {
  const dir = path.join(i18nDir, locale);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    console.error(`check-i18n: could not read locale dir ${dir}: ${err.message}`);
    process.exit(1);
  }
  if (!files.length) {
    console.error(`check-i18n: ${dir} contains no .json namespace files.`);
    process.exit(1);
  }
  const byNamespace = new Map(); // ns -> Set of flat keys within that ns
  const allKeys = new Set();
  for (const file of files) {
    const ns = file.replace(/\.json$/, "");
    let raw;
    try {
      raw = readFileSync(path.join(dir, file), "utf8");
    } catch (err) {
      console.error(`check-i18n: could not read ${path.join(dir, file)}: ${err.message}`);
      process.exit(1);
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      console.error(`check-i18n: ${path.join(dir, file)} is not valid JSON: ${err.message}`);
      process.exit(1);
    }
    const keys = new Set(flattenKeys(json));
    byNamespace.set(ns, keys);
    for (const key of keys) allKeys.add(`${ns}.${key}`);
  }
  return { files, byNamespace, allKeys };
}

const locales = new Map(LOCALES.map((locale) => [locale, loadLocale(locale)]));

// ---- 1. namespace file-list parity ----------------------------------------
let failed = false;

const referenceFiles = locales.get("en").files;
for (const locale of LOCALES.slice(1)) {
  const files = locales.get(locale).files;
  const missing = referenceFiles.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !referenceFiles.includes(f));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`check-i18n: namespace file lists do NOT match between en and ${locale}.`);
    for (const f of missing) console.error(`  - ${locale}/${f} is missing (exists as en/${f})`);
    for (const f of extra) console.error(`  - ${locale}/${f} has no counterpart in en/`);
  }
}
if (failed) {
  console.error("\nEvery locale must contain the same set of <namespace>.json files.");
  process.exit(1);
}

// ---- 2. per-namespace key parity -------------------------------------------
const mismatches = []; // [locale, ns, missingKey]
for (const [ns] of locales.get("en").byNamespace) {
  const reference = locales.get("en").byNamespace.get(ns);
  for (const locale of LOCALES.slice(1)) {
    const keys = locales.get(locale).byNamespace.get(ns);
    for (const key of reference) {
      if (!keys.has(key)) mismatches.push([locale, `${ns}.${key}`, `missing vs ${reference.size}-key en/${ns}.json`]);
    }
    for (const key of keys) {
      if (!reference.has(key)) mismatches.push(["en", `${ns}.${key}`, `missing vs ${keys.size}-key ${locale}/${ns}.json`]);
    }
  }
}
if (mismatches.length) {
  console.error(`check-i18n: ${mismatches.length} key-parity mismatch(es) across locales:\n`);
  for (const [locale, key, why] of mismatches) {
    console.error(`  - ${locale}: "${key}" (${why})`);
  }
  console.error("\nAll locales must expose an identical key set inside every namespace.");
  process.exit(1);
}

const allKeys = locales.get("en").allKeys;

// ---- 3. deletion detection via snapshot ------------------------------------
let snapshot = new Set();
try {
  snapshot = new Set(JSON.parse(readFileSync(snapshotFile, "utf8")).keys);
} catch (err) {
  // A missing snapshot only blocks normal runs; --update-snapshot creates it.
  if (!updateSnapshot) {
    console.error(
      `check-i18n: could not read snapshot ${snapshotFile}: ${err.message}\n` +
        "Regenerate it with: node scripts/check-i18n.mjs --update-snapshot"
    );
    process.exit(1);
  }
}

const removed = [...snapshot].filter((k) => !allKeys.has(k)).sort();
if (removed.length && !updateSnapshot) {
  console.error(`check-i18n: ${removed.length} key(s) present in the snapshot are GONE from all locales:\n`);
  for (const key of removed) console.error(`  - deleted "${key}"`);
  console.error(
    "\nIf this deletion is intentional, bless it by refreshing the snapshot:\n" +
      "  node scripts/check-i18n.mjs --update-snapshot\n" +
      "(Commit the refreshed scripts/i18n-keys-snapshot.json together with your change.)"
  );
  process.exit(1);
}

if (updateSnapshot) {
  writeFileSync(snapshotFile, JSON.stringify({ keys: [...allKeys].sort() }, null, 2) + "\n", "utf8");
  console.log(
    `check-i18n: snapshot refreshed — ${allKeys.size} keys ` +
      (removed.length ? `(${removed.length} blessed deletion(s))` : "(no changes needed)")
  );
} else if (removed.length === 0) {
  const added = [...allKeys].filter((k) => !snapshot.has(k)).length;
  if (added) {
    console.log(
      `check-i18n: ${added} new key(s) not yet in the snapshot — they become deletion-protected after the next --update-snapshot.`
    );
  }
}

// ---- 4. unused keys ---------------------------------------------------------
function walkSource(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "i18n") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSource(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

const prefixFile = path.join(__dirname, "i18n-dynamic-prefixes.json");
const dynamicPrefixes = JSON.parse(readFileSync(prefixFile, "utf8")).prefixes;
const srcRoot = path.join(__dirname, "..", "src");
const corpus = walkSource(srcRoot)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

const unused = [...allKeys]
  .filter((key) => {
    if (dynamicPrefixes.some((p) => key.startsWith(p))) return false;
    if (corpus.includes(`"${key}"`) || corpus.includes(`'${key}'`)) return false;
    if (corpus.includes("`" + key)) return false;
    return true;
  })
  .sort();

if (unused.length) {
  console.error(`check-i18n: ${unused.length} unused key(s) (not in src/, not a dynamic prefix):\n`);
  for (const key of unused) console.error(`  - ${key}`);
  console.error("\nDelete them from src/i18n/<locale>/, or add a prefix to scripts/i18n-dynamic-prefixes.json.");
  process.exit(1);
}

// ---- 5. undefined t() calls -------------------------------------------------
const sourceFiles = walkSource(srcRoot);
const undefinedCalls = [];
const callRegex = /\bt\(\s*["']([^"'`]+)["']/g;

for (const file of sourceFiles) {
  const content = readFileSync(file, "utf8");
  let match;
  while ((match = callRegex.exec(content)) !== null) {
    const key = match[1];
    // Ignore dynamic prefixes or obvious non-key parameters
    if (dynamicPrefixes.some((p) => key.startsWith(p))) continue;
    if (!allKeys.has(key)) {
      undefinedCalls.push({ file: path.relative(srcRoot, file), key });
    }
  }
}

if (undefinedCalls.length) {
  console.error(`check-i18n: ${undefinedCalls.length} call(s) to undefined translation key(s):\n`);
  for (const { file, key } of undefinedCalls) {
    console.error(`  - "${key}" in src/${file}`);
  }
  console.error("\nAdd missing key(s) to src/i18n/<locale>/<namespace>.json or fix the typo in source.");
  process.exit(1);
}

const namespaces = locales.get("en").byNamespace.size;
console.log(
  `check-i18n: OK — ${LOCALES.join(", ")} share ${namespaces} namespaces / ${allKeys.size} identical keys, ` +
    `0 deletions vs snapshot, 0 unused, 0 undefined calls.`
);
process.exit(0);
