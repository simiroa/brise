// Build the Fluent emoji manifest (unicode -> repo paths) and vendor a light Color preset.
// One-time / regenerable build step. Sources: GitHub git tree + per-emoji metadata.json,
// assets fetched from jsDelivr CDN. Outputs:
//   src-tauri/resources/emoji/fluent-manifest.json   (full index; backend embeds it to build download URLs)
//   src/lib/emoji/manifest.json                      (slim {u,g,c,gr} index for the picker — derived
//                                                      1:1 from the full manifest, same unicode set)
//   public/emoji/color/{unicode}.svg                 (bundled light preset, rendered same-origin)
//   public/emoji/preset.json                         (list of bundled unicodes)
//
// Run: node scripts/emoji/build-fluent-manifest.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const CDN = "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main";
const TREE = "https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/main?recursive=1";
// Groups included in the bundled light preset (the rest are download-more). Smileys covers the
// overwhelming majority of note decoration; keep it small so the installer stays light.
const PRESET_GROUPS = new Set(["Smileys & Emotion"]);
const PRESET_CAP = 200;

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

console.log("fetching git tree…");
const tree = (await j(TREE)).tree;
// Every emoji asset folder has a metadata.json (assets/{Name}/metadata.json) — enumerate at that
// depth rather than templating from a Color/*.svg glob. ~20% of emoji (anything with skin-tone
// variants: gestures, people, hand signs…) don't have a top-level Color/ dir at all; their default
// render lives one level deeper at Default/Color/{snake}_color_default.svg (siblings: Light/,
// Medium/, Dark/…). Templating only the depth-4 path silently dropped that whole slice — this finds
// whichever of the two layouts the asset actually uses.
const metaFiles = tree.filter((t) => t.path.endsWith("metadata.json") && t.path.split("/").length === 3);
console.log(`${metaFiles.length} emoji assets found; fetching metadata…`);

const entries = (await mapLimit(metaFiles, 24, async (t) => {
  const parts = t.path.split("/"); // assets, {Name}, metadata.json
  const name = parts[1];
  let meta;
  try {
    meta = await j(`${CDN}/assets/${encodeURIComponent(name)}/metadata.json`);
  } catch {
    return null;
  }
  if (!meta.unicode || !meta.glyph) return null;
  // metadata.unicode can be space-separated for ZWJ sequences; normalize to lowercased hyphen key.
  const unicode = String(meta.unicode).trim().toLowerCase().replace(/\s+/g, "-");
  const colorBlob =
    tree.find((tr) => tr.path.startsWith(`assets/${name}/Color/`) && tr.path.endsWith("_color.svg")) ||
    tree.find((tr) => tr.path.startsWith(`assets/${name}/Default/Color/`) && tr.path.endsWith("_color_default.svg"));
  const png3dBlob =
    tree.find((tr) => tr.path.startsWith(`assets/${name}/3D/`) && tr.path.endsWith("_3d.png")) ||
    tree.find((tr) => tr.path.startsWith(`assets/${name}/Default/3D/`) && tr.path.endsWith("_3d_default.png"));
  if (!colorBlob || !png3dBlob) return null; // no renderable default variant — skip
  return {
    unicode,
    glyph: meta.glyph,
    cldr: meta.cldr || name,
    group: meta.group || "",
    name,
    color: colorBlob.path,
    png3d: png3dBlob.path,
  };
})).filter(Boolean);

// De-dup by unicode (skin-tone base wins — we keep the first seen).
const byUnicode = new Map();
for (const e of entries) if (!byUnicode.has(e.unicode)) byUnicode.set(e.unicode, e);
const manifest = [...byUnicode.values()].sort((a, b) => a.unicode.localeCompare(b.unicode));
console.log(`manifest: ${manifest.length} unique emoji`);

const manifestPath = resolve(ROOT, "src-tauri/resources/emoji/fluent-manifest.json");
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log("wrote", manifestPath);

// Slim frontend copy — same unicode set, browsing-only fields (see emoji.ts::EmojiEntry).
const slimPath = resolve(ROOT, "src/lib/emoji/manifest.json");
mkdirSync(dirname(slimPath), { recursive: true });
writeFileSync(
  slimPath,
  JSON.stringify(manifest.map((e) => ({ u: e.unicode, g: e.glyph, c: e.cldr, gr: e.group })))
);
console.log("wrote", slimPath);

// Vendor the light Color preset.
const preset = manifest.filter((e) => PRESET_GROUPS.has(e.group)).slice(0, PRESET_CAP);
const colorDir = resolve(ROOT, "public/emoji/color");
mkdirSync(colorDir, { recursive: true });
let ok = 0;
await mapLimit(preset, 24, async (e) => {
  const dest = resolve(colorDir, `${e.unicode}.svg`);
  if (existsSync(dest)) { ok++; return; }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${CDN}/${e.color}`);
      if (r.ok) { writeFileSync(dest, Buffer.from(await r.arrayBuffer())); ok++; return; }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  console.warn("preset svg failed:", e.unicode, e.cldr);
});
writeFileSync(resolve(ROOT, "public/emoji/preset.json"), JSON.stringify(preset.map((e) => e.unicode)));
console.log(`vendored ${ok}/${preset.length} preset color SVGs → public/emoji/color/`);
console.log("DONE");
