/** §W1 (docs/PLAN-2026-09-18-nl-dates.md) — English wrapper: chrono-node's `en` locale through
 * chronoAdapter.ts. See chronoAdapter.ts for the shared logic and the empirical notes behind it.
 *
 * ponytail: imports the package root (`chrono-node`), which re-exports all fourteen bundled
 * locales, instead of the narrower `chrono-node/en` deep subpath. The deep import resolves fine
 * under plain Node (verified directly), but this project's Vite/vitest (vite@7, vitest@4) fails to
 * resolve chrono-node's wildcard package.json `exports` entry for per-locale subpaths — confirmed
 * empirically, not a config gap here. Upgrade path: retry the deep import next time either package
 * is bumped, or pin en/fr's own dist files directly if bundle weight becomes a measured problem
 * (this module isn't wired into the app bundle yet — W1 is a standalone library). */
import { en } from "chrono-node";
import type { NlDateParseResult } from "./types";
import { parseWithChrono } from "./chronoAdapter";

export function parseEnglish(text: string, referenceDate: Date = new Date()): NlDateParseResult | null {
  return parseWithChrono(en, text, referenceDate);
}
