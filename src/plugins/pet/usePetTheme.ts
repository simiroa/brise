import { useEffect, useState } from "react";
import { listenMany } from "../../lib/tauriListen";
import { call } from "../../lib/invoke";
import type { PetThemeOutput } from "../../lib/commands.gen";

export type PetDblclickAction = "chat" | "new_note" | "off";

export interface PetThemeState {
  aiEnabled: boolean;
  chatWriteEnabled: boolean;
  petDblclickAction: PetDblclickAction;
}

/** W18: search/open_note 구값 → new_note 흡수 (마이그레이션 없음). */
function parseDblclickAction(raw: string | undefined): PetDblclickAction {
  if (raw === "search" || raw === "open_note") return "new_note";
  if (raw === "chat" || raw === "new_note" || raw === "off") return raw;
  return "new_note";
}

/**
 * 펫 창(캐릭터 #/pet · 말풍선/채팅 #/pet-bubble) 공용 테마 상속 훅 (W8-h).
 *
 * 펫 창은 풀 앱 부팅을 건너뛰어 stores/settings.ts 의 applyCssVars 를 타지 않는다 —
 * 그래서 이 훅이 그 역할의 좁은 버전이다. docs/PET.md.
 * 같은 pet_theme 페이로드에서 AI/쓰기 게이트·더블클릭 동작도 꺼낸다 (F-P01).
 */
export function usePetTheme(): PetThemeState {
  const [aiEnabled, setAiEnabled] = useState(false);
  const [chatWriteEnabled, setChatWriteEnabled] = useState(true);
  const [petDblclickAction, setPetDblclickAction] = useState<PetDblclickAction>("new_note");

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void call<PetThemeOutput>("pet_theme", {})
        .then((t) => {
          if (cancelled) return;
          const root = document.documentElement;
          root.setAttribute("data-theme", t.theme === "light" ? "light" : "dark");
          const surface = t.surface_style === "acrylic" ? "acrylic" : "flat";
          root.setAttribute("data-surface", surface);
          root.style.setProperty("--accent", t.accent);
          root.style.setProperty("--fs", String(t.font_scale));
          root.style.setProperty("--sheet-alpha", String(t.sheet_alpha ?? 0.85));
          setAiEnabled(Boolean(t.ai_enabled));
          setChatWriteEnabled(t.chat_write_enabled !== false);
          setPetDblclickAction(parseDblclickAction(t.pet_dblclick_action));
        })
        .catch(() => {
          // call() 이 이미 처리 — 실패는 tokens.css 기본(다크/flat)으로 둔다.
        });
    };
    refresh();
    // listenMany 가 listen() reject 를 삼킨다(.catch) — 테스트 환경(jsdom, Tauri IPC 없음)에서는
    // listen() 이 reject 한다(PetSprite.tsx usePetPackage/usePetAsset 과 같은 패턴). 안 삼키면
    // 미처리 rejection 이 샌다.
    const unlisten = listenMany([["pet-theme-changed", refresh]]);
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);

  return { aiEnabled, chatWriteEnabled, petDblclickAction };
}
