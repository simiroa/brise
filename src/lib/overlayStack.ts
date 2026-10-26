import { useEffect, useRef } from "react";

/**
 * Escape 소비 체인 (W1 은 오버레이 전용으로 만들었으나, 이 파일은 이제 그 이름을 남긴 채 더
 * 일반적인 역할을 한다 — HANDOFF 캔버스 UX 2차, "Escape 소비 체인 재설계").
 *
 * Escape 로 "한 단계만 빠져나가고 싶은" 모든 임시 상태가 등록 대상이다: 팝오버·모달(원래 용도),
 * 그리고 이제는 캔버스의 텍스트/스케치 편집·드로우 모드·연결·프레임 배치·잉크 제안·선택 등도
 * 같은 스택에 올라간다. 등록 순서가 곧 우선순위다(LIFO) — Escape 는 **맨 위 한 장만** 닫는다.
 * 실제로 어떤 것이 "맨 위"인지는 코드 순서가 아니라 **그 상태가 실제로 활성화된 시각**이 정한다:
 * 나중에 켜진 것(더 안쪽에 중첩된 임시 상태)이 먼저 꺼진다. 예) 아이템을 선택한 채 텍스트 편집에
 * 들어가면 [선택, 텍스트편집] 순으로 쌓이고, Escape 는 텍스트편집부터 뺀다 — 이게 바로 오너가
 * 원하는 "편집 취소 → 위젯 이동/선택 상태" 순서다.
 *
 * `AuxWindowChrome`(설정/활동/AI 히스토리/캔버스 창 공용 크롬)의 Escape-닫기는 이 스택이 완전히
 * 빈 상태에서만 마지막 수단으로 동작한다 — 즉 창 닫기는 "아무도 소비하지 않았을 때"의 체인 맨
 * 끝 단계다. 새로 등록하는 쪽이 언마운트/상태 종료 시 반드시 해제해야 한다 — 죽은 항목이 스택에
 * 남으면 그 뒤로 Escape 가 그 항목에서 영원히 막힌다(멀쩡한 dismiss 가 아니라 stale closure 를
 * 계속 호출하게 됨).
 *
 * 직접 push/pop 하는 대신 아래 `useEscapeConsumer` 훅을 쓰는 것을 권장한다 — ModalShell.tsx 가
 * 손으로 짜던 "활성 동안 등록 + 자기 keydown 리스너로 소비 + 언마운트 해제" 패턴을 하나로 모은
 * 것이다.
 */
const openStack: Array<() => void> = [];

export function pushOverlay(dismiss: () => void): () => void {
  openStack.push(dismiss);
  return () => {
    const i = openStack.indexOf(dismiss);
    if (i >= 0) openStack.splice(i, 1);
  };
}

export function isOverlayOpen(): boolean {
  return openStack.length > 0;
}

export function dismissTopOverlay(): boolean {
  if (openStack.length === 0) return false;
  const dismiss = openStack.pop();
  if (dismiss) dismiss();
  return true;
}

/**
 * `active` 인 동안 `onEscape` 를 이 체인의 한 단계로 등록한다. 스택 맨 위일 때 Escape 한 번에
 * 정확히 이 콜백만 불린다(IME 조합 중인 Escape 는 조합 취소이지 모드 이탈이 아니므로 무시 —
 * `e.isComposing`; 이미 다른 소비자가 처리한 Escape 도 무시 — `e.defaultPrevented`).
 * `active` 가 false 가 되거나 컴포넌트가 언마운트되면 자동으로 등록 해제된다.
 *
 * 캔버스의 텍스트/스케치 노드 편집, 드로우 모드, 연결, 프레임 배치, 잉크 제안, 선택 등 —
 * "Escape 로 나가고 싶은 임시 상태"를 가진 쪽이 각자 이 훅 하나로 스스로 등록한다. 새 게이트를
 * 소비 지점(AuxWindowChrome 등)에 덧대는 대신, 원인 쪽이 체인에 참여하는 방식이다.
 */
export function useEscapeConsumer(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const removeOverlay = pushOverlay(() => onEscapeRef.current());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.isComposing) return;
      if (dismissTopOverlay()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      removeOverlay();
    };
    // onEscape 는 ref 로 읽는다 — active 가 안 바뀌는 한 리스너/스택 등록을 재생성하지 않는다
    // (ModalShell 의 onClose ref 관례와 동일).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
