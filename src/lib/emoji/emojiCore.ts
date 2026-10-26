import bundledRaw from "./bundled.json";

/** Codepoints of a single emoji grapheme → the manifest key (lowercased hex, hyphen-joined).
 *  Mirrors how build-fluent-manifest.mjs normalized Fluent's metadata.unicode. */
export function emojiKey(grapheme: string): string {
  const cps: string[] = [];
  for (const ch of grapheme) cps.push(ch.codePointAt(0)!.toString(16));
  return cps.join("-");
}

export const EMOJI_RECENT_MAX = 24;

/** LRU-insert `key` at the front of a "recently used" list, deduped, capped at max. Pure — the
 *  settings store owns persistence (settings.ts::addEmojiRecent). Mirrors addRecentColorHue's
 *  same unshift+dedupe+slice shape. */
export function addRecentEmoji(list: string[], key: string, max = EMOJI_RECENT_MAX): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}

/** Unicode keys whose Color SVG is bundled in the app (renders styled offline). Phase 1 = a light
 *  preset; Phase 2 widens this via download-more into appdata. */
const BUNDLED: Set<string> = new Set(bundledRaw as string[]);

/** Is this grapheme a bundled (styled-renderable) emoji? Tolerates a bare vs FE0F-qualified
 *  mismatch (text may carry U+2764 where Fluent keys it as 2764-fe0f, or vice-versa). Returns the
 *  matched bundled key, or null. */
export function bundledKeyFor(grapheme: string): string | null {
  const key = emojiKey(grapheme);
  if (BUNDLED.has(key)) return key;
  const noVs = key.replace(/-fe0f/g, "");
  if (BUNDLED.has(noVs)) return noVs;
  // text was bare; try adding fe0f after a lone base codepoint
  const withVs = key.includes("-") ? key : `${key}-fe0f`;
  if (BUNDLED.has(withVs)) return withVs;
  return null;
}

let currentEmojiBase: string | null = null;
let currentConvert: ((path: string) => string) | null = null;
// 다운로드된(bundled 이외) Color 팩이 로컬에 있는지 — 스타일은 이제 color 하나뿐이라 style 분기 없이
// 이 불리언 하나로 emojiAvailable/emojiSrc 를 결정한다. (ponytail: 2026-08 3d/animated 스타일 제거)
let currentColorPresent = false;

const renderListeners = new Set<() => void>();

export function setEmojiRenderState(state: {
  base?: string | null;
  convert?: ((path: string) => string) | null;
  colorPresent?: boolean;
}) {
  if (state.base !== undefined) currentEmojiBase = state.base;
  if (state.convert !== undefined) currentConvert = state.convert;
  if (state.colorPresent !== undefined) currentColorPresent = state.colorPresent;
  renderListeners.forEach((fn) => fn());
}

export function subscribeEmojiRender(listener: () => void): () => void {
  renderListeners.add(listener);
  return () => {
    renderListeners.delete(listener);
  };
}

/** Same-origin URL for a bundled Color SVG. */
export function colorSrc(key: string): string {
  return `/emoji/color/${key}.svg`;
}

/** Is this emoji key renderable as an image? (bundled offline, or the downloaded Color pack) */
export function emojiAvailable(key: string): boolean {
  return BUNDLED.has(key) || currentColorPresent;
}

export function emojiSrc(key: string): string {
  if (BUNDLED.has(key)) return colorSrc(key);
  if (currentColorPresent && currentEmojiBase && currentConvert) {
    return currentConvert(`${currentEmojiBase}/color/${key}.svg`);
  }
  return "";
}
