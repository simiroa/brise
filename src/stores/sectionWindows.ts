/**
 * 섹션 분리 창(1단계, 2026-09-30) — **본 창** 쪽 상태. 창 자체는 src-tauri/src/section_window.rs.
 *
 * 배타 소유: 한 섹션은 항상 한 곳에서만 열린다. 분리 여부의 단일 진실은 Rust 의 창 존재
 * (`section-<id>`)이고, 이 스토어는 그 거울일 뿐이다 — 저장하지 않는다. 채우는 경로는 둘:
 * 시작 시 `section_window_list` 한 번 + `section-window-changed { section_id, open }` 이벤트.
 *
 * 되돌아올 때(open:false) 순서가 중요하다:
 *   1) 되돌아옴 훅(EditorPanel 의 섹션 본문 캐시 비우기) — 캐시가 분리 전 본문을 들고 있다.
 *   2) 그 섹션이 열린 노트에 있으면 reloadActive() 로 DB 에서 다시 읽는다 — 본 창 스토어는
 *      분리 동안 그 섹션의 편집을 전혀 모른다(stale). flushAll 이 아니라 note_get 이 진실이다.
 *   3) **그 다음에** ids 에서 뺀다. 먼저 빼면 플레이스홀더가 사라지며 관계도/시트 컴포넌트가
 *      stale 본문으로 마운트되고, 그 본문을 자기 저장 경로로 다시 써서 새 창의 편집을 덮는다.
 *
 * 이 스토어를 구독(startSectionWindowsSync)하는 것은 본 창뿐이다 — 분리 창 자신은 부르지 않는다
 * (부르면 자기 섹션을 "분리됨"으로 보고 자기 저장을 막는다). 시작점은 SectionTabBar 마운트다:
 * 분리는 그 탭 메뉴로만 시작되므로 그보다 먼저 분리 창이 존재할 수 없다(앱 재시작 시 창은 함께 죽는다).
 */
import { create } from "zustand";
import type { Section } from "../lib/commands.gen";
import { call, callSilent, flushAll } from "../lib/invoke";
import { listenMany } from "../lib/tauriListen";
import { isBrowser } from "../lib/env";
import { useNotesStore } from "./notes";
import { getActiveEditor, getActiveSection } from "../lib/aiSectionBridge";

export interface SectionWindowChanged {
  section_id: string;
  open: boolean;
}

interface SectionWindowsState {
  /** 지금 별도 창에 열려 있는 섹션 id 들. */
  ids: string[];
}

export const useSectionWindowsStore = create<SectionWindowsState>(() => ({ ids: [] }));

export function isSectionDetached(sectionId: string | null | undefined): boolean {
  return !!sectionId && useSectionWindowsStore.getState().ids.includes(sectionId);
}

/** 순수 — 이벤트 하나를 id 집합에 반영. */
export function applySectionWindowChange(ids: string[], ev: SectionWindowChanged): string[] {
  if (ev.open) return ids.includes(ev.section_id) ? ids : [...ids, ev.section_id];
  return ids.includes(ev.section_id) ? ids.filter((id) => id !== ev.section_id) : ids;
}

let returnedHook: ((sectionId: string) => void) | null = null;

/** 되돌아옴 1단계 훅 — EditorPanel 이 자기 섹션 본문 캐시를 비우려고 건다. */
export function registerSectionReturnedHook(fn: (sectionId: string) => void): () => void {
  returnedHook = fn;
  return () => {
    if (returnedHook === fn) returnedHook = null;
  };
}

/** 섹션별 이벤트 세대 — 닫힘 처리가 reloadActive 를 기다리는 사이 같은 섹션이 다시 열리면(이벤트가
 *  하나 더 오면) 앞선 닫힘 처리는 id 를 빼지 않는다. 안 그러면 떠 있는 창의 섹션이 본 창에서
 *  "분리 안 됨"으로 풀려 두 곳에서 편집된다(배타 소유 깨짐). */
const generation = new Map<string, number>();

export async function handleSectionWindowChanged(ev: SectionWindowChanged): Promise<void> {
  const gen = (generation.get(ev.section_id) ?? 0) + 1;
  generation.set(ev.section_id, gen);
  if (ev.open) {
    useSectionWindowsStore.setState((s) => ({ ids: applySectionWindowChange(s.ids, ev) }));
    return;
  }
  if (!isSectionDetached(ev.section_id)) return;
  returnedHook?.(ev.section_id);
  const note = useNotesStore.getState().activeNote;
  if (note?.sections.some((s) => s.id === ev.section_id)) {
    // reloadActive 는 실패를 스스로 삼킨다 — 그래도 플레이스홀더는 풀어야 한다(아래 finally 없이도
    // 다음 줄이 항상 돈다). 실패하면 stale 본문이 보일 수 있으나 note_get 실패는 call() 이 토스트한다.
    await useNotesStore.getState().reloadActive();
  }
  if (generation.get(ev.section_id) !== gen) return; // 그 사이 새 이벤트가 이 섹션을 맡았다
  useSectionWindowsStore.setState((s) => ({ ids: applySectionWindowChange(s.ids, ev) }));
}

let started = false;

/** 본 창 전용, 멱등. 리스너는 해제하지 않는다 — 대시보드로 가 있는 동안의 닫힘도 놓치면 안 된다. */
export function startSectionWindowsSync(): void {
  if (started || isBrowser()) return;
  started = true;
  listenMany([
    ["section-window-changed", (e) => void handleSectionWindowChanged(e.payload as SectionWindowChanged)],
  ]);
  // 본 창 새로고침(Ctrl+R) 뒤에도 이미 떠 있는 분리 창을 다시 안다.
  callSilent<{ section_ids: string[] }>("section_window_list")
    .then((r) => useSectionWindowsStore.setState({ ids: Array.isArray(r?.section_ids) ? r.section_ids : [] }))
    // silent-ok: 실패는 callSilent 가 진단에 남긴다. 목록이 비어도 이후 열림/닫힘 이벤트가 채운다.
    .catch(() => {});
}

/** "새 창에서 열기" / "창으로 이동" — 같은 커맨드(이미 있으면 앞으로 가져오기만). 낙관적 갱신 없음:
 *  ids 는 창이 **실제로 생긴 뒤**(커맨드 성공 또는 Rust 의 열림 이벤트)에만 바뀐다 — 실패하면 아무것도
 *  안 바뀌어 롤백할 것도 없다.
 *  `at` = 탭을 창 밖으로 끌어 놓은 화면 좌표(PointerEvent.screenX/Y, 논리 px, 2단계) — 새 창을 그
 *  근처에 띄운다. 이미 분리된 섹션이면 Rust 가 위치를 무시하고 앞으로 가져오기만 한다.
 *
 *  여는 동안 본 창의 그 섹션 에디터를 잠근다: flushAll 이 끝난 뒤~ids 에 들어가기 전에 친 글자는
 *  새 창이 DB 에서 이미 읽은 뒤라 어디에도 저장되지 않는다(에디터 가드가 버린다).
 *  ponytail: 잠그는 건 텍스트 섹션뿐 — 시트/관계도는 각자 저장 경로라 그 사이 편집은 여전히 샐 수 있다. */
export async function openSectionWindow(
  noteId: string,
  section: Section,
  noteTitle: string,
  at?: { x: number; y: number },
): Promise<void> {
  const editor = getActiveSection()?.id === section.id ? getActiveEditor() : null;
  const wasEditable = editor?.isEditable ?? false;
  // emitUpdate:false — 잠금/해제는 편집이 아니다(onUpdate 가 자동저장 디바운스를 걸지 않게).
  editor?.setEditable(false, false);
  try {
    // 새 창은 DB 에서 읽는다 — 이 섹션의 미저장 편집(700ms 디바운스)을 먼저 내보낸다.
    await flushAll();
    const title = noteTitle ? `${section.name} — ${noteTitle}` : section.name;
    await call("section_window_open", { note_id: noteId, section_id: section.id, title, ...at });
    // 창이 있다(이미 있었든 방금 생겼든) — 열림 이벤트를 기다리지 않고 지금 반영해야 잠금을 풀 때
    // 플레이스홀더가 이미 자리를 잡고 있다. 이벤트가 뒤따라와도 같은 결과다(멱등).
    await handleSectionWindowChanged({ section_id: section.id, open: true });
  } catch {
    // call() 이 이미 토스트 + 진단 기록했다. 상태는 안 바뀌었다.
  } finally {
    if (editor && !editor.isDestroyed) editor.setEditable(wasEditable, false);
  }
}

/** 지금 떠 있는 분리 창의 섹션 id — 창 존재(Rust)가 진실이다. 이 스토어의 ids 는 이벤트 거울이라 늦을 수 있다. */
export async function listSectionWindows(): Promise<string[]> {
  const r = await call<{ section_ids: string[] }>("section_window_list");
  return Array.isArray(r?.section_ids) ? r.section_ids : [];
}

/** "여기로 되돌리기" = 새 창 닫기. 창이 저장을 끝내고 사라질 때까지 기다렸다 돌아온다(멈춘 창은 Rust 가
 *  시간 초과 뒤 강제 파괴). 닫힘 이벤트가 위 handleSectionWindowChanged 경로로 온다. */
export async function returnSectionWindow(sectionId: string): Promise<void> {
  try {
    const r = await call<{ closed: boolean }>("section_window_close", { section_id: sectionId });
    // 창이 이미 없다(닫힘 이벤트를 놓친 경우) — 창 존재가 진실이므로 여기서 바로 되돌린다.
    if (!r.closed) await handleSectionWindowChanged({ section_id: sectionId, open: false });
  } catch {
    // call() 이 이미 토스트 + 진단 기록했다.
  }
}
