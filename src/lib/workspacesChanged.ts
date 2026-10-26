/**
 * settingsChanged.ts 의 워크스페이스판 — 설정 창(#/settings, 별도 웹뷰)이 노트북을 만들거나
 * 지우면(현재 유일한 발신처: TestDataSection 의 테스트 DB 토글) "workspaces-changed" 를 emit 하고,
 * 본 창이 여기서 받아 목록을 DB 기준으로 재조회한다. payload.activate 가 있으면 그 노트북으로
 * 전환까지 한다(테스트 DB 생성 직후 바로 그 안을 보여주기 위해). activate 없이 활성 노트북이
 * 바뀌어 돌아오면(활성 노트북이 삭제돼 백엔드가 남은 첫 노트북으로 옮긴 경우) 트리/탭 리셋 등
 * 전환 부수효과가 필요하므로 switchTo 를 마저 태운다.
 */
import { listen } from "@tauri-apps/api/event";
import { isBrowser } from "./env";
import { useWorkspacesStore } from "../stores/workspaces";

export function listenWorkspacesChanged(): () => void {
  // 브라우저(동기화 탭)에는 Tauri 이벤트 버스도, 설정 창도 없다.
  if (isBrowser()) return () => {};

  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void listen<{ activate?: string }>("workspaces-changed", (e) => {
    void (async () => {
      const store = useWorkspacesStore.getState();
      const prevActive = store.activeId;
      await store.load();
      const activate = e.payload?.activate;
      if (activate) {
        await store.switchTo(activate);
        return;
      }
      const nextActive = useWorkspacesStore.getState().activeId;
      if (nextActive && nextActive !== prevActive) await store.switchTo(nextActive);
    })();
  }).then((un) => {
    if (cancelled) un();
    else unlisten = un;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
