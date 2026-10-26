import type { PetMessage, PetSearchHit } from "../../../lib/commands.gen";
import type { ChatAttachPreview } from "./petChatContext";
import type { PetChatItem } from "../PetChat";
import { PET_EVENT } from "./petEvents";

/** Broadcast after a successful pet_chat / clear / rewind / delete. Both webviews receive it. */
export const PET_CHAT_UPDATED_EVENT = PET_EVENT.chatUpdated;

export type PetChatUpdatedReason = "append" | "clear" | "rewind" | "delete" | "session";

export type PetChatUpdatedPayload = { reason?: PetChatUpdatedReason };

/** 라이브 세션 자체가 바뀌었다(새 세션·세션 열기·전체 지우기) — 대기 중인 턴을 이 화면에 붙이면 안 된다. */
export function isSessionSwitch(reason: PetChatUpdatedReason | undefined): boolean {
  return reason === "session" || reason === "clear";
}

export type ChatHistoryItem = PetChatItem & {
  persisted?: boolean;
  attaches?: ChatAttachPreview[];
  /** UI label when `text` is a long preset prompt the model still receives. */
  displayText?: string;
};

// Session cache still holds thumbs/attaches (not in meta). Chips/failed/display persist
// on pet_messages.meta; applyHistory lets server meta win. Key includes role — now_iso()
// is ms and a user+assistant pair can share a created_at.
const extrasCache = new Map<string, ChatHistoryItem>();

function cacheKey(createdAt: string, role: string): string {
  return `${createdAt}\t${role}`;
}

function extraFields(src: ChatHistoryItem | undefined): Partial<ChatHistoryItem> {
  if (!src) return {};
  const out: Partial<ChatHistoryItem> = {};
  if (src.action !== undefined) out.action = src.action;
  if (src.noteId !== undefined) out.noteId = src.noteId;
  if (src.noteTitle !== undefined) out.noteTitle = src.noteTitle;
  if (src.hits !== undefined) out.hits = src.hits;
  if (src.planKind !== undefined) out.planKind = src.planKind;
  if (src.planId !== undefined) out.planId = src.planId;
  if (src.visionStatus !== undefined) out.visionStatus = src.visionStatus;
  if (src.imagePreview !== undefined) out.imagePreview = src.imagePreview;
  if (src.attaches !== undefined) out.attaches = src.attaches;
  if (src.displayText !== undefined) out.displayText = src.displayText;
  if (src.failed !== undefined) out.failed = src.failed;
  if (src.sectionTitle !== undefined) out.sectionTitle = src.sectionTitle;
  if (src.sectionBody !== undefined) out.sectionBody = src.sectionBody;
  if (src.sectionInserted !== undefined) out.sectionInserted = src.sectionInserted;
  return out;
}

function hasRenderableExtras(item: ChatHistoryItem): boolean {
  return !!(
    item.action ||
    item.noteId ||
    item.noteTitle ||
    item.hits?.length ||
    item.planKind ||
    item.planId ||
    item.visionStatus ||
    item.imagePreview ||
    item.attaches?.length ||
    item.displayText ||
    item.failed ||
    item.sectionTitle ||
    item.sectionBody ||
    item.sectionInserted
  );
}

function asPlanKind(value: unknown): PetChatItem["planKind"] {
  if (value === "fill_note" || value === "rename_plan" || value === "prune_plan") return value;
  return undefined;
}

function asVisionStatus(value: unknown): PetChatItem["visionStatus"] {
  if (value === "used" || value === "fallback_text") return value;
  return undefined;
}

function parseHits(raw: unknown): PetSearchHit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const hits: PetSearchHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const noteId =
      typeof rec.note_id === "string"
        ? rec.note_id
        : typeof rec.id === "string"
          ? rec.id
          : "";
    if (!noteId) continue;
    hits.push({
      note_id: noteId,
      title: typeof rec.title === "string" ? rec.title : "",
      snippet: typeof rec.snippet === "string" ? rec.snippet : "",
    });
  }
  return hits;
}

function rawMetaJson(message: PetMessage): string | undefined {
  return typeof message.meta === "string" && message.meta.trim() ? message.meta : undefined;
}

/** Server `pet_messages.meta` JSON → display fields. Missing keys stay unset. */
export function parsePetMessageMeta(raw: string | undefined | null): Partial<ChatHistoryItem> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<ChatHistoryItem> = {};
    if (typeof parsed.display_text === "string" && parsed.display_text) {
      out.displayText = parsed.display_text;
    }
    if (typeof parsed.action === "string" && parsed.action) {
      out.action = parsed.action;
    }
    const planKind = asPlanKind(parsed.plan_kind);
    if (planKind) out.planKind = planKind;
    if (typeof parsed.plan_id === "string" && parsed.plan_id) out.planId = parsed.plan_id;
    if (typeof parsed.note_id === "string" && parsed.note_id) out.noteId = parsed.note_id;
    if (typeof parsed.note_title === "string") out.noteTitle = parsed.note_title;
    if (Object.prototype.hasOwnProperty.call(parsed, "hits")) {
      out.hits = parseHits(parsed.hits);
    }
    const vision = asVisionStatus(parsed.vision_status);
    if (vision) out.visionStatus = vision;
    if (parsed.failed === true) out.failed = true;
    if (typeof parsed.section_title === "string" && parsed.section_title) {
      out.sectionTitle = parsed.section_title;
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberChatExtras(item: ChatHistoryItem): void {
  if (!item.createdAt || !hasRenderableExtras(item)) return;
  extrasCache.set(cacheKey(item.createdAt, item.role), { ...item });
}

export function resetChatExtrasCache(): void {
  extrasCache.clear();
}

/**
 * Merge persisted history with in-memory extras (search cards, plan chips, thumbs).
 * 1. createdAt + role
 * 2. unused extra with the same role+text
 * 3. from the end: last unused extra of that role
 * Then overlay the session cache keyed by created_at+role.
 * Server `meta` JSON wins over cache/extras for display/plan/hits/failed.
 */
export function applyHistory(messages: PetMessage[], extras?: ChatHistoryItem[]): ChatHistoryItem[] {
  const list = extras ?? [];
  const used = new Set<number>();
  const picked: Array<ChatHistoryItem | undefined> = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const idx = list.findIndex(
      (p, j) => !used.has(j) && p.createdAt === m.created_at && p.role === m.role,
    );
    if (idx >= 0) {
      used.add(idx);
      picked[i] = list[idx];
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (picked[i]) continue;
    const m = messages[i];
    const idx = list.findIndex(
      (p, j) => !used.has(j) && p.role === m.role && p.text === m.text,
    );
    if (idx >= 0) {
      used.add(idx);
      picked[i] = list[idx];
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (picked[i]) continue;
    const role = messages[i].role;
    for (let j = list.length - 1; j >= 0; j--) {
      if (used.has(j) || list[j].role !== role) continue;
      used.add(j);
      picked[i] = list[j];
      break;
    }
  }

  return messages.map((m, i) => {
    const extra = picked[i];
    const cached = extrasCache.get(cacheKey(m.created_at, m.role));
    const item: ChatHistoryItem = {
      role: m.role === "assistant" ? "assistant" : "user",
      text: m.text,
      createdAt: m.created_at,
      persisted: true,
      ...extraFields(cached),
      ...extraFields(extra),
      // Server meta is the remount source of truth; session cache is thumbs/display fallback.
      ...parsePetMessageMeta(rawMetaJson(m)),
    };
    rememberChatExtras(item);
    return item;
  });
}

export function visibleChatText(
  item: ChatHistoryItem,
  presets: Array<{ name: string; prompt: string }>,
): string {
  if (item.displayText) return item.displayText;
  if (item.role === "user" && item.text) {
    const hit = presets.find((p) => p.prompt && p.prompt === item.text);
    if (hit) return hit.name;
  }
  return item.text;
}
