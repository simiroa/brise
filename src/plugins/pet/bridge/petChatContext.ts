/** Shared pet_chat extras for T4 — active-note excerpt + turn-local attaches, not history. */
import { randomId } from "../../../lib/ids";
import { EXTRACTABLE_EXTS, fileExt } from "../../../lib/fileKinds";


export const ACTIVE_NOTE_EXCERPT_CAP = 4000;
export const PET_CHAT_IMAGE_BYTES_CAP = 8 * 1024 * 1024;
export const CHAT_ATTACH_EXCERPT_CAP = 4000;
// pdf/docx/txt/md/pptx — identical to lib/fileKinds.ts::EXTRACTABLE_EXTS (attachment extraction
// policy), re-exported under this module's existing name (unused within this file today, kept
// for callers outside it that may already import it by this name).
export const CHAT_EXTRACTABLE_EXTS = EXTRACTABLE_EXTS;
export const CHAT_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export type ActiveNoteExcerptInput = {
  active_note_id: string;
  active_note_title: string;
  active_note_excerpt: string;
};

/** Strip passthrough HTML the same way notes.ts::isNoteBodyEmpty does, then cap. */
export function excerptFromActiveNote(
  note: { note: { id: string; title: string }; sections: { body_md: string }[] } | null | undefined,
): ActiveNoteExcerptInput | null {
  if (!note?.note.id) return null;
  const raw = note.sections.map((section) => section.body_md).join("\n\n");
  const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return {
    active_note_id: note.note.id,
    active_note_title: note.note.title ?? "",
    active_note_excerpt: [...text].slice(0, ACTIVE_NOTE_EXCERPT_CAP).join(""),
  };
}

export type ChatAttach = {
  id: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
  base64?: string;
  mime?: string;
  excerpt?: string;
};

export type ChatAttachPreview = {
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
};

export function newChatAttachId(): string {
  return randomId("att");
}

export { fileExt };

export function isChatImageFile(file: File | null | undefined): boolean {
  if (!file || file.size <= 0 || file.size > PET_CHAT_IMAGE_BYTES_CAP) return false;
  if (file.type.startsWith("image/")) return true;
  // Explorer/WebView2 often hands over image Files with an empty MIME.
  return CHAT_IMAGE_EXTS.has(fileExt(file.name));
}

export function previewOfAttach(a: ChatAttach): ChatAttachPreview {
  return { name: a.name, kind: a.kind, previewUrl: a.previewUrl };
}

export function attachFromReadResult(res: {
  kind: string;
  name: string;
  mime?: string;
  base64?: string;
  excerpt?: string;
}): ChatAttach {
  if (res.kind === "image" && res.base64) {
    const mime = res.mime || "image/jpeg";
    return {
      id: newChatAttachId(),
      name: res.name,
      kind: "image",
      mime,
      base64: res.base64,
      previewUrl: `data:${mime};base64,${res.base64}`,
    };
  }
  return {
    id: newChatAttachId(),
    name: res.name,
    kind: "file",
    excerpt: res.excerpt,
  };
}

function capExcerpt(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return [...text].slice(0, CHAT_ATTACH_EXCERPT_CAP).join("");
}

export function fileToChatImage(file: File): Promise<ChatAttach | null> {
  if (!isChatImageFile(file)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      if (!base64) {
        resolve(null);
        return;
      }
      resolve({
        id: newChatAttachId(),
        name: file.name || "image",
        kind: "image",
        base64,
        mime: file.type || mimeFromImageName(file.name),
        previewUrl: URL.createObjectURL(file),
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** HTML5 File → pending attach. text/* and .txt/.md get FileReader excerpt; pdf/docx/pptx name only. */
function mimeFromImageName(name: string): string {
  const ext = fileExt(name);
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

export function fileToChatAttach(file: File): Promise<ChatAttach | null> {
  if (!file || file.size <= 0) return Promise.resolve(null);
  if (isChatImageFile(file)) return fileToChatImage(file);
  const name = file.name || "file";
  const ext = fileExt(name);
  if (file.type.startsWith("text/") || ext === "txt" || ext === "md") {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = typeof reader.result === "string" ? reader.result : "";
        resolve({
          id: newChatAttachId(),
          name,
          kind: "file",
          excerpt: capExcerpt(raw),
        });
      };
      reader.onerror = () => resolve({ id: newChatAttachId(), name, kind: "file" });
      reader.readAsText(file);
    });
  }
  return Promise.resolve({ id: newChatAttachId(), name, kind: "file" });
}

/** Compose the user turn sent to pet_chat. ponytail: backend PET_MESSAGE_CHAR_CAP is 2000
 *  chars — long excerpts are cut there. Raise the cap when multi-file attaches are first-class.
 *  The `[첨부: …]` marker is also parsed by Rust `repo::pet::rag_query` (it cuts attach blocks out of the
 *  chat search query) — change both together. */
export function composeChatAttachMessage(draft: string, attaches: ChatAttach[]): string {
  const parts: string[] = [];
  const trimmed = draft.trim();
  if (trimmed) parts.push(trimmed);
  for (const a of attaches) {
    const head = `[첨부: ${a.name}]`;
    const excerpt = a.excerpt?.trim();
    parts.push(excerpt ? `${head}\n${excerpt}` : head);
  }
  return parts.join("\n\n");
}

export function firstChatImage(attaches: ChatAttach[]): ChatAttach | undefined {
  return attaches.find((a) => a.kind === "image" && !!a.base64);
}

export function imageFileFromClipboard(e: { clipboardData: DataTransfer | null }): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

export function transferHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  const types = dt.types;
  if (types && Array.from(types as ArrayLike<string>).includes("Files")) return true;
  const items = dt.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind === "file") return true;
    }
  }
  return false;
}

export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt?.files?.length) return [];
  return Array.from(dt.files);
}

export function revokeAttachPreview(a: ChatAttach | ChatAttachPreview): void {
  if (a.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
}
