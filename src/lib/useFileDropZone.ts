import { useEffect, useRef, useState } from "react";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { createSharedSubscription } from "./tauriListen";

/**
 * Tauri 레벨 OS 파일 드래그&드롭 공용 훅 — HTML5 DnD는 웹뷰 안에서 실제 파일 경로를 절대 주지
 * 않으므로(`getCurrentWebview().onDragDropEvent`만 준다), 다섯 존
 * (attachments/useAttachmentsDragDrop · editor/useEditorFileDrop · SourcePanel의
 * usePreviewFileDrop · leftpanel/SidebarChat · settings/PetSection)이 각자 구독하며 매번
 * `window.devicePixelRatio` 보정과 사각형 적중 판정을 복제하고 있었다. 이 훅이 구독/해제 ·
 * dpr 보정 · 적중 판정 · dragOver 표시를 소유하고, 각 존은 자기 rect(getZoneEl)와 자기
 * 행동(callbacks)만 넘긴다.
 *
 * accept 여부(= 실제로 IPC를 쏠지)는 각 존이 `inside`를 받아 스스로 정한다 — 대부분은
 * `if (!inside) return`이면 끝이지만, SidebarChat처럼 WebView2가 drop 시점에 좌표를 (0,0)으로
 * 잘못 주는 경우를 직전 "over" 상태로 보정하는 존도 있어(자기만의 ref 상태 필요), 그 판정을
 * 훅 안으로 끌어오지 않는다.
 */

export interface DropPos {
  x: number;
  y: number;
}

export interface FileDropZoneCallbacks {
  /** enter/over 매 이벤트 — dragOver 페인트 자체는 훅이 이미 반영했다. 캐럿 추종(에디터)이나
   *  "직전에 안에 있었는가" 추적(SidebarChat) 같은 부가 동작에만 쓴다. */
  onOver?: (pos: DropPos, inside: boolean) => void;
  /** leave — dragOver는 훅이 이미 false로 내렸다. 존별 부가 ref 리셋용. */
  onLeave?: () => void;
  /** drop — inside가 false여도 항상 호출된다(리셋이 필요한 존이 있어서). accept 여부는
   *  호출자가 inside(및 자기만의 부가 판정)로 직접 정한다. */
  onDrop: (paths: string[], pos: DropPos, inside: boolean) => void;
}

/** Exported for testing — dpr 보정. Tauri가 주는 좌표는 물리 픽셀, DOM rect는 논리 픽셀. */
export function dprCorrectedPos(raw: DropPos, dpr: number): DropPos {
  return { x: raw.x / dpr, y: raw.y / dpr };
}

/** Exported for testing — 순수 사각형 적중 판정. */
export function isInsideRect(pos: DropPos, rect: { left: number; right: number; top: number; bottom: number } | null | undefined): boolean {
  return !!rect && pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom;
}

/** Exported for testing — dragOver 표시 여부를 결정하는 순수 전이. "leave"/"drop"은 항상
 *  끝(false), "enter"/"over"는 호출자가 이미 계산한 적중 결과를 그대로 반영한다. */
export function nextDragOverState(
  eventType: "enter" | "over" | "drop" | "leave",
  insideRect: boolean
): boolean {
  if (eventType === "leave" || eventType === "drop") return false;
  return insideRect;
}

/** 창 하나에 OS 드래그&드롭 실제 구독 하나 — 존마다 onDragDropEvent 를 부르면 존 하나당
 *  listen 4개(enter/over/drop/leave)가 IPC 로 오가고, 노트를 열고 닫을 때마다 존 서넛이 붙었다
 *  떨어져 왕복이 12~24번 생겼다. 존들은 이 버스에 JS 안에서만 붙는다(lib/tauriListen.ts). */
const subscribeDragDrop = createSharedSubscription<DragDropEvent>(async (dispatch) => {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => dispatch(event.payload));
});

export function useFileDropZone(
  getZoneEl: () => HTMLElement | null,
  callbacks: FileDropZoneCallbacks,
  enabled = true
): { dragOver: boolean } {
  const [dragOver, setDragOver] = useState(false);
  // 매 렌더 최신값을 반영하되 effect는 enabled에만 의존 — getZoneEl/callbacks가 새 클로저로
  // 와도 재구독하지 않는다.
  const getZoneElRef = useRef(getZoneEl);
  getZoneElRef.current = getZoneEl;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!enabled) {
      setDragOver(false);
      return;
    }
    // 해제는 동기 — cleanup 뒤엔 이 존의 핸들러가 불리지 않는다(언마운트 뒤 setState 없음).
    return subscribeDragDrop((payload) => {
      if (payload.type === "leave") {
        setDragOver(nextDragOverState("leave", false));
        callbacksRef.current.onLeave?.();
        return;
      }
      const rect = getZoneElRef.current()?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pos = dprCorrectedPos(payload.position, dpr);
      const inside = isInsideRect(pos, rect);

      if (payload.type === "drop") {
        setDragOver(nextDragOverState("drop", inside));
        callbacksRef.current.onDrop(payload.paths, pos, inside);
        return;
      }
      // "enter" | "over"
      setDragOver(nextDragOverState(payload.type, inside));
      callbacksRef.current.onOver?.(pos, inside);
    });
  }, [enabled]);

  return { dragOver };
}
