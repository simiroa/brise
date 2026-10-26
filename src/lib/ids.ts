/**
 * Standard ID generation utilities for Brise.
 * Standardizes prefixed and unprefixed unique IDs with safe fallback
 * when `crypto.randomUUID` is missing (older WebViews / tests / legacy environments).
 */

/**
 * Generate a unique random ID, optionally with a prefix (e.g. `randomId("exp")` -> `"exp-xxxx"`).
 * If prefix is omitted, returns the unique ID directly.
 * Falls back when `crypto.randomUUID` is missing.
 */
export function randomId(prefix?: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const raw = uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${raw}` : raw;
}

/**
 * Standard alias for generating unique IDs (prefixed or unprefixed).
 */
export function uniqueId(prefix?: string): string {
  return randomId(prefix);
}
