import { emit } from "@tauri-apps/api/event";

/**
 * 보조 창(섹션·활동 이력)에서 "이 노트를 본 창에서 열어라" 요청. 채널 "pet-open-note" 는 본 창(App.tsx)이
 * 이미 듣고 Rust(commands/pet.rs pet_open_main)도 같은 채널을 쓰므로 이름을 바꾸지 않는다.
 * 이 창의 스토어로 노트를 열면 안 된다 — 창마다 zustand 스토어가 따로다. 가볍게 유지: 스토어 import 금지.
 */
export function requestOpenNoteInMain(noteId: string): Promise<void> {
  return emit("pet-open-note", { note_id: noteId });
}
