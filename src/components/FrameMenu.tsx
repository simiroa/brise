/**
 * 프레임 아이콘 줄의 드롭다운 메뉴 한 벌 — 알림(ReminderBell)·활동 기록(HistoryMenu)이 같은 껍데기·같은
 * 크기를 쓴다(오너 2026-10-27: 히스토리만 새 창으로 떠서 거슬렸다). 크기·모양은 frameMenu.css 한 곳.
 */
import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useFloatingPopover } from "../lib/ui";
import "./frameMenu.css";

export function useFrameMenu() {
  const [open, setOpen] = useState(false);
  // 메뉴 안에서 연 확인 대화상자(ModalShell, body 포털)를 누르면 메뉴 밖 클릭이라 메뉴가 닫히며 대화상자째
  // 사라진다 — 대화상자가 떠 있는 동안은 바깥 클릭으로 닫지 않는다. Escape 는 대화상자가 위 오버레이라 먼저 닫힌다.
  const close = useCallback(() => {
    if (document.querySelector(".modal-scrim")) return;
    setOpen(false);
  }, []);
  const pop = useFloatingPopover(open, close);
  return { open, setOpen, ...pop };
}

export type FrameMenuState = ReturnType<typeof useFrameMenu>;

export function FrameMenuPop({
  menu,
  label,
  testId,
  children,
}: {
  menu: FrameMenuState;
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  if (!menu.open) return null;
  return createPortal(
    <div
      ref={menu.popRef}
      className="overlay frame-menu"
      role="dialog"
      aria-label={label}
      data-testid={testId}
      style={{ left: menu.x, top: menu.y }}
    >
      {children}
    </div>,
    document.body,
  );
}
