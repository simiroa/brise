// One file per top-level namespace (src/i18n/<locale>/<namespace>.json). The
// filename IS the namespace: merging wraps each module back under its file
// name, so dot-path lookups are unchanged from the single-file era.
export function buildDict(glob: Record<string, unknown>): Record<string, unknown> {
  const dict: Record<string, unknown> = {};
  for (const [file, mod] of Object.entries(glob)) {
    const ns = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/, "");
    dict[ns] = (mod as { default: unknown }).default;
  }
  return dict;
}
