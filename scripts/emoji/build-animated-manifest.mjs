import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const CDN = "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji-animated@main";
const TREE = "https://api.github.com/repos/microsoft/fluentui-emoji-animated/git/trees/main?recursive=1";

const j = async (url) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw new Error("fetch failed: " + url);
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

console.log("fetching git tree from fluentui-emoji-animated…");
const tree = (await j(TREE)).tree;

const metaFiles = tree.filter((t) => t.path.endsWith("metadata.json") && t.path.split("/").length === 3);
console.log(`${metaFiles.length} emoji metadata entries found; fetching metadata…`);

const entries = (await mapLimit(metaFiles, 24, async (t) => {
  const parts = t.path.split("/"); // assets, {Name}, metadata.json
  const name = parts[1];
  let meta;
  try {
    meta = await j(`${CDN}/assets/${encodeURIComponent(name)}/metadata.json`);
  } catch {
    return null;
  }
  if (!meta.unicode) return null;

  const unicode = String(meta.unicode).trim().toLowerCase().replace(/\s+/g, "-");
  
  // Find animated asset for this emoji
  // Check if level 4 asset exists: assets/{Name}/animated/{snake}_animated.png
  // Or level 5 Default: assets/{Name}/Default/animated/{snake}_animated.png
  const animBlob = tree.find((tr) => {
    const p = tr.path;
    return p.startsWith(`assets/${name}/`) && p.includes("/animated/") && p.endsWith(".png");
  });

  if (!animBlob) return null;

  return {
    unicode,
    animated: animBlob.path,
  };
})).filter(Boolean);

// De-dup by unicode
const byUnicode = new Map();
for (const e of entries) {
  if (!byUnicode.has(e.unicode)) {
    byUnicode.set(e.unicode, e);
  }
}

const manifest = [...byUnicode.values()].sort((a, b) => a.unicode.localeCompare(b.unicode));
console.log(`animated manifest: ${manifest.length} unique emoji`);

const manifestPath = resolve(ROOT, "src-tauri/resources/emoji/animated-manifest.json");
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log("wrote", manifestPath);

const keysPath = resolve(ROOT, "src/lib/emoji/animatedKeys.json");
mkdirSync(dirname(keysPath), { recursive: true });
const unicodes = manifest.map((e) => e.unicode);
writeFileSync(keysPath, JSON.stringify(unicodes));
console.log("wrote", keysPath);
console.log("DONE");
