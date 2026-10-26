import type { PreviewItem } from "../stores/ui";
import type { NoteDetail } from "../lib/commands.gen";
import { isFootnoteKind } from "../components/attachments/tileIcon";

export type ResolvedPreview =
  | { kind: "source" | "attachment" | "note" | "region"; id: string }
  | { kind: "section"; noteId: string; sectionId: string }
  | { kind: "footnotes"; focusId?: string };

/**
 * Pure resolver helper: checks if the current `previewItem` in UI state can be
 * resolved against the currently loaded `activeNote`.
 * Returns the resolved item descriptor or null if unresolvable / empty hint state.
 */
export function resolvePreviewItem(
  previewItem: PreviewItem | null,
  activeNote: NoteDetail | null
): ResolvedPreview | null {
  if (!previewItem || !activeNote) return null;

  if (previewItem.kind === "section") {
    // Section preview is scoped to the active note for v1
    if (previewItem.noteId !== activeNote.note.id) return null;
    const sec = activeNote.sections.find((s) => s.id === previewItem.sectionId);
    return sec ? { kind: "section", noteId: previewItem.noteId, sectionId: sec.id } : null;
  }

  if (previewItem.kind === "source") {
    const src = activeNote.sources.find((s) => s.id === previewItem.id);
    return src ? { kind: "source", id: src.id } : null;
  }

  if (previewItem.kind === "footnotes") {
    // 노트 스코프 — 이 노트에 각주가 하나라도 있으면 목록을 연다. 없으면 null 이라 패널은
    // 기존과 똑같이(AI 힌트/선택 안내) 폴백한다.
    return activeNote.attachments.some((a) => isFootnoteKind(a.kind))
      ? { kind: "footnotes", focusId: previewItem.focusId }
      : null;
  }

  if (previewItem.kind === "attachment") {
    const att = activeNote.attachments.find((a) => a.id === previewItem.id);
    if (!att) return null;
    // 각주는 더 이상 첨부 단위 프리뷰를 갖지 않는다(단일 목록 뷰). 세션에 남아 있던 옛
    // {kind:"attachment"} 항목(히스토리 스택, 마커 클릭 이전 상태)이 각주 id 를 가리키면
    // **여기 한 곳에서** 목록 뷰로 승격시킨다 — 호출자마다 분기를 심지 않는다.
    if (isFootnoteKind(att.kind)) return { kind: "footnotes", focusId: att.id };
    return { kind: "attachment", id: att.id };
  }

  if (previewItem.kind === "note") {
    // Note previews reference another note ID explicitly
    return previewItem.id ? { kind: "note", id: previewItem.id } : null;
  }

  if (previewItem.kind === "region") {
    // "Has a primary place" — same formula NoteRegionsList uses for its own hasPrimary branch
    // (region name OR coords, not coords alone: on the desktop path NoteRegionsList owns
    // add/remove/reorder/"make primary" — mounted both in RegionMetaBadge's title-bar popover
    // and in PreviewAttachment; mobile's MobileNoteBadges writes the primary independently via
    // its own sheet, this module isn't part of that path — and it's the sole gate the
    // AttachmentsBar region tile uses to even become visible/clickable — see AttachmentsBar's
    // regionHasPrimary). Kept sync/pure
    // (no waypoint fetch here) so switching to a location-less note still falls through to
    // presets, matching every other previewItem kind's "does this note actually have it" check.
    const { region, lat, lng } = activeNote.note;
    if (region || lat != null || lng != null) return { kind: "region", id: activeNote.note.id };
    // 대표가 없어도, 이 노트를 콕 집어 연 지역 미리보기(첨부 바의 지역 카드가 note.id 를 실어
    // 보낸다)라면 해석한다 — 대표를 지우고 경유지만 남은 노트가 그렇다. 다른 노트에서 넘어온
    // stale previewItem 은 id 가 달라 여기 걸리지 않으므로, 프리셋을 가리지 않는다.
    return previewItem.id === activeNote.note.id ? { kind: "region", id: activeNote.note.id } : null;
  }

  return null;
}
