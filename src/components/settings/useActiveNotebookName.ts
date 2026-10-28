import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { callSilent } from "../../lib/invoke";

/**
 * 현재 노트북 이름·아이콘(설정 창 헤더 범위 칩이 쓴다 — PLAN-2026-10-24 D5). 예전엔 레일 제목 아래
 * 한 줄(SettingsNav::ActiveNotebookName)이었고 같은 조회를 그대로 옮겨 왔다.
 *
 * 설정 창은 별도 웹뷰다 — 노트북 스토어(stores/workspaces, 트리·탭·노트 스토어를 끌고 온다)를
 * 들이지 않고 이름·아이콘만 조용히 읽는다(`workspace_list` 한 번 — 아이콘은 같은 응답에 있다). 활성 노트북이
 * 바뀌면(settings-changed → load → activeWorkspaceId) 다시 읽는다. 못 읽으면 name 이 null(선택적 표시라
 * 토스트가 필요 없다 — callSilent).
 */
export function useActiveNotebook(): { name: string | null; icon: string | null } {
  const activeId = useSettingsStore((s) => s.activeWorkspaceId); // = 노트북
  const [nb, setNb] = useState<{ name: string | null; icon: string | null }>({ name: null, icon: null });
  useEffect(() => {
    let alive = true;
    void callSilent<{ workspaces: { id: string; name: string; icon?: string | null }[]; active_id: string }>("workspace_list") // = 노트북
      .then((r) => {
        if (!alive || !r?.workspaces) return;
        const id = activeId ?? r.active_id;
        const w = r.workspaces.find((x) => x.id === id);
        setNb({ name: w?.name ?? null, icon: w?.icon ?? null });
      })
      .catch(() => {
        // silent-ok: 이름은 선택적 표시 — callSilent 가 이미 진단 로그에 남겼다.
      });
    return () => {
      alive = false;
    };
  }, [activeId]);
  return nb;
}

/** 이름만 필요한 호출부용. */
export function useActiveNotebookName(): string | null {
  return useActiveNotebook().name;
}
