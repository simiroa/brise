import { call, emitNotice, flushAll } from "../../../lib/invoke";
import { insertAiSection } from "../../../lib/aiSectionBridge";
import { t } from "../../../i18n/t";
import { useNotesStore } from "../../../stores/notes";
import { useAiStore, AI_GLOW_KEYS } from "../../../stores/ai";
import type { NoteDetail } from "../../../lib/commands.gen";

import { PET_EVENT } from "./petEvents";

export const PET_APPLY_CHAT_SECTION_EVENT = PET_EVENT.applyChatSection;

export interface PetChatSectionRequest {
  title?: string;
  body: string;
  note_id?: string;
  /** W5 section provenance — forwarded to insertAiSection's opts.aiOrigin. Omitted for the raw
   *  secretary chat write (no BUILTIN_DEFS id fits "펫/사이드바 비서" as its own action); set to
   *  "fill_note" by generateAndInsertFillSection below, which IS a BUILTIN_DEFS id. */
  aiOrigin?: string;
}

function sectionTitleFrom(body: string, fallback?: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 40);
  if (fallback?.trim()) return fallback.trim().slice(0, 40);
  return t("search.chat_section_default_title");
}

/** Immediate secretary write: new section on the open note. Never overwrites a body. */
export async function applyChatSection(req: PetChatSectionRequest): Promise<boolean> {
  const body = req.body.trim();
  if (!body) return false;
  const noteId = req.note_id || useNotesStore.getState().activeNote?.note.id;
  if (!noteId) {
    emitNotice(t("search.chat_no_active_note"));
    return false;
  }
  const title = sectionTitleFrom(body, req.title);
  const section = await insertAiSection(title, body, noteId, undefined, { aiOrigin: req.aiOrigin });
  if (!section) return false;
  emitNotice(t("search.chat_section_inserted"));
  return true;
}

/** Legacy fill_note chip: generate a draft and insert it as a new section. */
export async function generateAndInsertFillSection(
  noteId: string | undefined,
  instruction?: string,
): Promise<boolean> {
  const id = noteId || useNotesStore.getState().activeNote?.note.id;
  if (!id) {
    emitNotice(t("search.chat_no_active_note"));
    return false;
  }
  await flushAll();
  let note: NoteDetail;
  try {
    note = await call<NoteDetail>("note_get", { id });
  } catch {
    emitNotice(t("search.chat_no_active_note"));
    return false;
  }
  const fullBody = note.sections.map((s) => s.body_md).join("\n\n");
  const glowKey = AI_GLOW_KEYS.editor(note.note.id);
  const aiStore = useAiStore.getState();
  aiStore.addGlow(glowKey);
  try {
    const prompt = [
      "다음 요청에 맞는 새 섹션 본문만 마크다운으로 작성하세요.",
      "기존 노트를 덮어쓰지 않습니다. JSON·설명·인사말 금지.",
      "첫 줄은 '# 섹션 제목' 형식입니다.",
      instruction?.trim()
        ? `요청:\n${instruction.trim()}`
        : "요청: 현재 노트를 바탕으로 보강 초안을 작성하세요.",
      `현재 노트 제목: ${note.note.title || "(제목 없음)"}`,
      `현재 본문:\n${fullBody || "(비어 있음)"}`,
    ].join("\n\n");
    const raw = await aiStore.generateFromPrompt(prompt, null);
    const body = raw?.trim() ?? "";
    if (!body) {
      emitNotice(t("search.chat_plan_empty"));
      return false;
    }
    return applyChatSection({ title: sectionTitleFrom(body), body, note_id: note.note.id, aiOrigin: "fill_note" });
  } finally {
    aiStore.removeGlow(glowKey);
  }
}
