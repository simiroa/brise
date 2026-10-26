import manifestRaw from "./manifest.json";

/** One browsable emoji from the Fluent manifest. u=unicode key, g=glyph, c=cldr name, gr=group. */
export interface EmojiEntry {
  u: string;
  g: string;
  c: string;
  gr: string;
}

export const EMOJI: EmojiEntry[] = manifestRaw as EmojiEntry[];

const EMOJI_BY_KEY = new Map(EMOJI.map((e) => [e.u, e]));

/** Look up a manifest entry by its unicode key — used to render recent/favorites rows (which
 *  persist only the key, not the whole entry). */
export function emojiByKey(key: string): EmojiEntry | undefined {
  return EMOJI_BY_KEY.get(key);
}

/** Manifest groups, in a sensible picker order. */
export const EMOJI_GROUPS: string[] = [
  "Smileys & Emotion",
  "People & Body",
  "Animals & Nature",
  "Food & Drink",
  "Activities",
  "Travel & Places",
  "Objects",
  "Symbols",
  "Flags",
].filter((g) => EMOJI.some((e) => e.gr === g));
