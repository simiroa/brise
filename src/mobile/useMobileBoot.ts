import { useEffect, type RefObject } from "react";
import { useSettingsStore } from "../stores/settings";
import { useSearchStore } from "../stores/search";
import { useWorkspacesStore } from "../stores/workspaces";
import { reportFallback } from "../lib/diag";
import { listenRemoteNoteWrite } from "../lib/remoteNoteWrite";
import { applyMobilePrefs } from "./mobilePrefs";
import type { MobileNoteHandle } from "./MobileNote";

/**
 * One-time wiring the phone shell does on mount (MobileApp): remote-write listener + the boot loads
 * the desktop App.tsx does for the same stores. Nothing here depends on which screen is showing.
 */
export function useMobileBoot(noteRef: RefObject<MobileNoteHandle | null>) {
  // K1: 데스크톱 편집이 폰의 열린 노트를 조용히 덮어쓰지 않게 한다 — App.tsx 의 같은 이름 등록과
  // 짝(둘 다 lib/remoteNoteWrite.ts 를 공유, 로직 복제 없음). loadTree() 자신이 isBrowser()&&
  // isMobileViewport() 를 판정해 folder_list 대신 bumpNoteQueryVersion() 만 도는 경로를 타므로
  // (stores/notesTree.ts), 여기서는 그 분기를 지정할 필요가 없다. onFocusSkipped 는 포커스 보호로
  // reloadActive() 를 건너뛴 경우에만 오고, noteRef 는 그 순간 화면에 떠 있는 MobileNote(있다면)를
  // 가리킨다 — 없으면(다른 탭을 보는 중) 옵셔널 체이닝으로 조용히 무시된다.
  useEffect(
    () => listenRemoteNoteWrite({ onFocusSkipped: (noteId) => noteRef.current?.notifyRemoteChange(noteId) }),
    [noteRef],
  );

  useEffect(() => {
    // Same theme mechanism desktop App.tsx boots (stores/settings.ts::load -> applyCssVars sets
    // data-theme/--accent/etc. on document.documentElement, which tokens.css's `:root[data-theme=]`
    // selectors key off). Also required for t(): every translation reads uiLang off this same
    // store, so without this call the Korean-primary mobile UI would render in English.
    // applyMobilePrefs() (per-device theme/font-size override, mobilePrefs.ts) runs AFTER load()
    // resolves so it wins over the shared setting load() just applied — see mobilePrefs.ts's
    // header comment for why theme/font-size are deliberately NOT part of that shared store.
    void useSettingsStore.getState().load().then(() => applyMobilePrefs());
    // The mobile path never calls loadTree(), which is what populates the search year histogram on
    // desktop. Without this, every mobile keyword search would silently apply
    // stores/search.ts::fallbackBounds' last-100-years window and drop older notes from results.
    void useSearchStore.getState().refreshYearHistogram();
    // Same reason, taxonomy: desktop fills stores/taxonomy.ts (regions · eras · custom statuses)
    // from workspaces.ts::load → applyWorkspaceContext at boot. Nothing on the mobile path did, so
    // the filter sheet's region chips, custom statuses and MobileYearChips' eras were empty on the
    // phone unless the notebook switcher happened to be opened first (M1 G1, 2026-10-05).
    useWorkspacesStore
      .getState()
      .load()
      .catch((e) => reportFallback("mobile-boot", "workspaces_load_failed", String(e)));
  }, []);
}
