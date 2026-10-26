/**
 * Header phrase packs (Wave 8).
 *
 * Schema (one JSON file per pack):
 *   { name: string, items: [{ text: string, source?: string }] }
 *
 * - Bundled: imported from src/assets/phrase-packs/*.json
 * - User: app data dir phrase_packs/*.json via phrase_packs_list command
 * - Parse failures: soft skip + console.warn (never block boot)
 */

import knowledgeRaw from "../assets/phrase-packs/knowledge.json";
import koHistoryRaw from "../assets/phrase-packs/ko-history.json";
import { callSilent } from "./invoke";

export interface PhraseItem {
  text: string;
  source?: string;
}

export interface PhrasePack {
  /** Stable id: "bundled:knowledge" | "bundled:ko-history" | "user:<filename>" */
  id: string;
  name: string;
  items: PhraseItem[];
  origin: "bundled" | "user";
}

/** Off sentinel stored in settings.phrase_pack_id */
export const PHRASE_PACK_OFF = "off";

export function parsePhrasePack(raw: unknown, id: string, origin: "bundled" | "user"): PhrasePack | null {
  if (!raw || typeof raw !== "object") {
    console.warn(`[brise] phrase pack ${id}: not an object — skipped`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
  if (!name) {
    console.warn(`[brise] phrase pack ${id}: missing name — skipped`);
    return null;
  }
  if (!Array.isArray(obj.items)) {
    console.warn(`[brise] phrase pack ${id}: items is not an array — skipped`);
    return null;
  }
  const items: PhraseItem[] = [];
  for (const entry of obj.items) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.text !== "string" || !e.text.trim()) continue;
    const item: PhraseItem = { text: e.text.trim() };
    if (typeof e.source === "string" && e.source.trim()) {
      item.source = e.source.trim();
    }
    items.push(item);
  }
  if (items.length === 0) {
    console.warn(`[brise] phrase pack ${id}: no valid items — skipped`);
    return null;
  }
  return { id, name, items, origin };
}

/** Hard cap mirrored from the backend (commands/settings.rs MAX_PACK_ITEMS). */
export const PHRASE_PACK_MAX_ITEMS = 200;

/**
 * Parse an LLM answer into phrase items. Models wrap JSON in ```fences```, prepend "Here you go:"
 * and append a closing remark, so we slice the outermost [...] (or a {items:[...]} wrapper) out of
 * whatever came back instead of trusting the whole string to be JSON. Returns [] on failure — the
 * caller shows the raw text so the user can see what the model actually said.
 */
export function parseAiPhraseItems(raw: string): PhraseItem[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  // Prefer a fenced block's contents when present, else the raw text.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fence?.[1] ?? raw).trim();

  const candidates: string[] = [body];
  const arrStart = body.indexOf("[");
  const arrEnd = body.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) candidates.push(body.slice(arrStart, arrEnd + 1));
  const objStart = body.indexOf("{");
  const objEnd = body.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) candidates.push(body.slice(objStart, objEnd + 1));

  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown } | null)?.items)
        ? (parsed as { items: unknown[] }).items
        : null;
    if (!arr) continue;
    const items: PhraseItem[] = [];
    for (const entry of arr) {
      // Models drift between ["text", ...] and [{text, source}, ...] — accept both.
      if (typeof entry === "string") {
        if (entry.trim()) items.push({ text: entry.trim() });
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.text !== "string" || !e.text.trim()) continue;
      const item: PhraseItem = { text: e.text.trim() };
      if (typeof e.source === "string" && e.source.trim()) item.source = e.source.trim();
      items.push(item);
      if (items.length >= PHRASE_PACK_MAX_ITEMS) break;
    }
    if (items.length > 0) return items;
  }
  return [];
}

const BUNDLED: PhrasePack[] = [
  parsePhrasePack(knowledgeRaw, "bundled:knowledge", "bundled"),
  parsePhrasePack(koHistoryRaw, "bundled:ko-history", "bundled"),
].filter((p): p is PhrasePack => p !== null);

export function bundledPhrasePacks(): PhrasePack[] {
  return BUNDLED.slice();
}

/** Default pack id when setting is unset. */
export function defaultPhrasePackId(): string {
  return BUNDLED[0]?.id ?? PHRASE_PACK_OFF;
}

interface UserPackWire {
  id: string;
  name: string;
  items: { text: string; source?: string | null }[];
}

/**
 * Load user packs from app data dir (phrase_packs/*.json).
 * Soft-fails offline / non-Tauri / empty folder.
 */
export async function loadUserPhrasePacks(): Promise<PhrasePack[]> {
  try {
    const r = await callSilent<{ packs: UserPackWire[] }>("phrase_packs_list");
    const out: PhrasePack[] = [];
    for (const p of r?.packs ?? []) {
      if (!p || typeof p.id !== "string") continue;
      const parsed = parsePhrasePack(
        { name: p.name, items: p.items },
        p.id.startsWith("user:") ? p.id : `user:${p.id}`,
        "user",
      );
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadAllPhrasePacks(): Promise<PhrasePack[]> {
  const user = await loadUserPhrasePacks();
  return [...bundledPhrasePacks(), ...user];
}

export function findPack(packs: PhrasePack[], id: string | null | undefined): PhrasePack | null {
  if (!id || id === PHRASE_PACK_OFF) return null;
  return packs.find((p) => p.id === id) ?? null;
}

/** Pick a random item; avoids immediate repeat of `prevText` when possible. */
export function pickPhrase(
  pack: PhrasePack,
  prevText?: string | null,
): PhraseItem {
  const items = pack.items;
  if (items.length === 1) return items[0];
  if (items.length === 0) return { text: "" };
  let next = items[Math.floor(Math.random() * items.length)];
  if (prevText && items.length > 1) {
    let guard = 0;
    while (next.text === prevText && guard < 8) {
      next = items[Math.floor(Math.random() * items.length)];
      guard++;
    }
  }
  return next;
}
