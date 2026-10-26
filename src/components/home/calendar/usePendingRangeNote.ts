/**
 * 드래그-생성 세션의 "선생성 → 확정/취소" 규율 — 대시보드 달력 탭(CalendarTab)과 사이드바
 * 미니 달력(CalendarExpanded)이 두 벌 들고 있던 것을 합쳤다
 * (PLAN-2026-09-13-separation-of-concerns 트랙 D1 ①, 동작 변경 0).
 *
 * 드래그 세션 자체(useCalendarDrag)를 이 훅이 품는 이유: 팝오버가 닫혔는지를 보는 purge effect
 * 와, 그 팝오버를 여는 onRangeDropped 가 서로를 필요로 해 호출자에서는 순환이 된다.
 *
 * 두 표면이 다른 것은 "만드는 중" 플래그뿐이라 그것만 밖에서 받는다 — 달력 탭의 `creating` 은
 * 생성 경로 네 곳(그리드 드래그·"+"·AI 확정·시간축)이 공유해 확정 중에는 세우지 **않고**,
 * 미니 달력의 `creatingRange` 는 확정 중에 세운다. 그래서 `busy` 는 읽기만, `setBusy` 는 선택.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../../../lib/invoke";
import { moveNote } from "../../../lib/noteActions";
import { useNotesStore } from "../../../stores/notes";
import { useCalendarDrag } from "./useCalendarDrag";

export function usePendingRangeNote(opts: {
  /** 순수 클릭(드래그가 아닌)일 때 useCalendarDrag 가 부르는 날짜 선택. */
  onPick: (day: string) => void;
  /** 드래그를 놓는 순간 만드는 노트. 실패면 null(호출자가 이미 토스트를 띄웠다). */
  createNote: (lo: string, hi: string) => Promise<string | null>;
  /** 확정을 막는 "만드는 중" 플래그 — 표면마다 범위가 달라 밖에서 준다. */
  busy: boolean;
  /** 확정 동안 위 플래그를 세우는 표면만 준다(미니 달력). */
  setBusy?: (v: boolean) => void;
  /** loadTree 뒤에 한 번 — 달력 탭의 reloadToken bump 자리. 안정된 콜백이어야 한다. */
  onSettled?: () => void;
}) {
  const { onPick, createNote, busy, setBusy, onSettled } = opts;
  const loadTree = useNotesStore((s) => s.loadTree);
  const inboxId = useNotesStore((s) => s.inboxId);

  // PLAN-2026-09-10 D3 — create-first: 드래그를 놓는 순간 노트가 생긴다(제목 없음, 받은편지함,
  // 기간이면 종료 트리플). 팝오버는 그 노트를 고치는 자리다 — 그래야 날짜 칩(DatesPanel)이
  // 노트 id 하나로 그대로 들어온다. 확정되지 않은 채 팝오버가 닫히면 아래 effect 가 purge 한다.
  const pendingNoteIdRef = useRef<string | null>(null);
  const [pendingNoteId, setPendingNoteId] = useState<string | null>(null);

  const onRangeDropped = useCallback(
    (lo: string, hi: string) => {
      void (async () => {
        // 실패면 null — 팝오버는 노트 없이 남는다(만들기 비활성). 토스트는 call 이 띄웠다.
        const id = await createNote(lo, hi);
        pendingNoteIdRef.current = id;
        setPendingNoteId(id);
      })();
    },
    [createNote],
  );

  const { popover, closePopover, isDragHighlighted, onCellPointerDown, onCellPointerEnter } =
    useCalendarDrag(onPick, onRangeDropped);

  // 취소·Escape·바깥 클릭(그리드 pointerdown → closePopover, useCalendarDrag)이 전부 지나는
  // **한 지점**: 팝오버가 닫혔는데 확정되지 않은 노트가 남아 있으면 하드 삭제한다 — 사용자에게
  // 존재한 적 없는 노트라 휴지통에 남기지 않는다. ref 를 먼저 비우므로 StrictMode 이중 발화에도
  // purge 는 한 번이다.
  useEffect(() => {
    if (popover) return;
    const id = pendingNoteIdRef.current;
    if (!id) return;
    pendingNoteIdRef.current = null;
    setPendingNoteId(null);
    void (async () => {
      try {
        await call("note_purge", { id });
      } catch {
        // call() 이 토스트를 띄웠다. 노트는 남는다 — 데이터 손실 방향이 아니다.
      }
      await loadTree();
      onSettled?.();
    })();
  }, [popover, loadTree, onSettled]);

  // "만들기" = 이미 있는 노트에 제목/폴더만 얹는다(D3-3). 노트 탭은 열지 않는다.
  const confirm = useCallback(
    async (title: string, folderId: string) => {
      const id = pendingNoteIdRef.current;
      if (busy || !id) return;
      setBusy?.(true);
      try {
        const trimmed = title.trim();
        if (trimmed) await call("note_update", { id, title: trimmed });
        if (folderId && folderId !== inboxId) await moveNote(id, folderId);
        // 확정 — 먼저 ref 를 비워야 닫힘이 purge 로 읽히지 않는다.
        pendingNoteIdRef.current = null;
        setPendingNoteId(null);
        closePopover();
        await loadTree();
        onSettled?.();
      } catch {
        // invoke already surfaces notices; leave popover open for retry/cancel.
      } finally {
        setBusy?.(false);
      }
    },
    [busy, setBusy, onSettled, inboxId, closePopover, loadTree],
  );

  return {
    popover,
    closePopover,
    isDragHighlighted,
    onCellPointerDown,
    onCellPointerEnter,
    pendingNoteId,
    confirm,
  };
}
