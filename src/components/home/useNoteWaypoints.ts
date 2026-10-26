import type { NoteRegion } from "../../lib/commands.gen";
import { useNoteRegions } from "../../lib/noteMeta";

/** 노트의 경유지(`note_regions_list`) — 제목줄 칩·첨부 바·지역 팝오버와 같은 캐시(lib/noteMeta.ts)를
 * 나눠 써서, 열린 노트 하나에 여러 소비자가 붙어도 IPC 는 한 번이다. */
export function useNoteWaypoints(noteId: string | null | undefined): NoteRegion[] {
  return useNoteRegions(noteId).regions;
}
