/** §W1 (docs/PLAN-2026-09-18-nl-dates.md) — French wrapper: chrono-node's `fr` locale through
 * chronoAdapter.ts. See chronoAdapter.ts for the shared logic and the empirical notes behind it.
 * Imports the package root, not the `chrono-node/fr` deep subpath — see en.ts's leading comment
 * for why (Vite/vitest fails to resolve that subpath in this project, confirmed empirically). */
import { fr } from "chrono-node";
import type { NlDateParseResult } from "./types";
import { parseWithChrono } from "./chronoAdapter";

export function parseFrench(text: string, referenceDate: Date = new Date()): NlDateParseResult | null {
  return parseWithChrono(fr, text, referenceDate);
}
