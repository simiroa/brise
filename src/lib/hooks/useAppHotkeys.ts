import { useEffect } from "react";
import { useNotesStore } from "../../stores/notes";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { undoLast } from "../undo";

// 검색창은 사이드바 소속이라 집중 모드에선 언마운트돼 있다 — 단축키가 조용히 아무 일도
// 안 하는 대신 집중을 먼저 벗어난 뒤 다음 렌더에서 마운트된 입력을 찾는다.
function focusSearchInput() {
  const findInput = () =>
    (document.getElementById("brise-search-input") ??
      document.querySelector('[data-testid="home-search-input"]')) as HTMLInputElement | null;
  if (useUiStore.getState().focusMode) {
    useUiStore.setState({ focusMode: false });
    requestAnimationFrame(() => findInput()?.focus());
  } else {
    findInput()?.focus();
  }
}

interface UseAppHotkeysOptions {
  browser: boolean;
  onOpenSettings: () => void;
}

/**
 * 전역 단축키(앱 레벨). 모달이 열려 있으면 억제한다 — 열린 ModalShell 은 role="dialog" 를
 * 달고 있으므로 그 존재로 감지한다(모달은 자체 Escape/Tab 을 소유). Ctrl(Win/Linux)·⌘(mac)
 * 공통. Ctrl/⌘+W(탭 닫기)는 창 닫기 관례와 충돌 소지가 있어 넣지 않았다.
 */
export function useAppHotkeys({ browser, onOpenSettings }: UseAppHotkeysOptions) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const el = document.activeElement as HTMLElement | null;
      const editing =
        !!el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          !!el.closest(".ProseMirror"));

      if (!editing && e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        focusSearchInput();
        return;
      }

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        // Ctrl/⌘+Z = 토스트의 "되돌리기" 버튼과 같은 동작(2026-08-20 오너). 텍스트를 편집 중일
        // 때는 손대지 않는다 — TipTap/입력창 자신의 undo 가 먼저다. 되돌릴 게 없으면 false 를
        // 받아 기본 동작을 그대로 흘려보낸다(preventDefault 하지 않는다).
        if (editing) return;
        if (undoLast()) e.preventDefault();
        return;
      }
      if (key === "n") {
        e.preventDefault();
        void useNotesStore.getState().newNote();
      } else if (key === "f") {
        e.preventDefault();
        focusSearchInput();
      } else if (e.key === ",") {
        e.preventDefault();
        onOpenSettings();
      } else if (key === "t" && e.shiftKey) {
        // QA8 Wave 4A — reopen last closed tab (settings kv recent_closed_tabs; NOT activity_log).
        e.preventDefault();
        const id = useTabsStore.getState().reopenClosedTab();
        if (id) void useNotesStore.getState().selectNote(id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [browser, onOpenSettings]);
}
