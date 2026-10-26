import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMenuPos } from "../../lib/ui";
import { useEscapeConsumer } from "../../lib/overlayStack";
import { FluidHoverHighlight, useFluidHover } from "./FluidHover";

export interface ContextMenuShellProps {
  anchor: { x: number; y: number } | null | undefined;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  minWidth?: number | string;
  ariaLabel?: string;
  style?: CSSProperties;
  className?: string;
  container?: HTMLElement | null;
  /**
   * 에디터 선택 위에 뜨는 메뉴. mousedown 을 먹어 선택이 풀리지 않게 하고(메뉴를 누르는 순간
   * 캐럿이 날아가면 "선택에 대한 명령"이 대상을 잃는다), `[data-editor-pop]` 마커를 단다 —
   * TextBubbleMenu 의 포커스 판정이 이 마커로 "메뉴 안에 있음"을 인정한다.
   */
  editorSafe?: boolean;
  /**
   * 열리면 첫 `.menu-row` 에 포커스(=하이라이트)를 준다 — 마우스를 움직이지 않고도 Enter 로 고르고,
   * ↑/↓ 로 옮길 수 있다. "+" 새 섹션 메뉴처럼 "열자마자 바로 고르는" 메뉴용(기본 꺼짐).
   */
  autoFocusFirst?: boolean;
}

/**
 * ContextMenuShell: 공용 포털 컨텍스트 메뉴 쉘.
 * 투명 백드롭 div + useMenuPos 훅 + .overlay.context-menu-popover 컨테이너 렌더링.
 *
 * 유동 hover 도 **여기가 소유한다**(2026-09-10) — 여덟 호출처가 전부 `.menu-row` 를 쓰므로
 * 쉘에 한 번 달면 메뉴 계열 전체가 같은 하이라이트를 갖는다. 호출처는 손댈 것이 없다.
 *
 * Escape 닫기는 **여기가 소유한다**(2026-09-09). 전에는 여덟 호출처 중 TableMenu 하나만
 * 자기 keydown 효과를 손으로 달고 있었고 — 노트 트리 우클릭 메뉴·탭 메뉴·섹션 추가 메뉴·
 * 프리셋 관리 메뉴는 Escape 로 안 닫혔다. 바깥 클릭(백드롭)은 이미 쉘이 갖고 있었으니
 * 짝이 되는 나머지 절반만 여기로 올린 것이다.
 *
 * 그 Escape 는 2026-09-10 에 `useEscapeConsumer` 로 옮겼다. 직접 단 window 리스너는 Escape
 * 소비 체인(overlayStack) 밖에 있었고 `preventDefault()` 도 하지 않아, 체인에 올라와 있던
 * 다른 임시 상태가 **같은 Escape 한 번에 함께 닫혔다** — 캔버스에서 텍스트를 편집하다 우클릭
 * 메뉴를 열고 Escape 를 누르면 메뉴와 편집이 같이 사라졌다. 체인은 LIFO 라, 나중에 열린
 * 메뉴가 먼저 닫히는 게 옳다.
 */
export function ContextMenuShell({
  anchor,
  onClose,
  children,
  testId,
  minWidth = 160,
  ariaLabel,
  style,
  className = "",
  container,
  editorSafe = false,
  autoFocusFirst = false,
}: ContextMenuShellProps) {
  const { ref, x, y } = useMenuPos(anchor);
  // 같은 ref 를 그대로 넘긴다 — 팝오버가 position:fixed 라 하이라이트의 위치 기준이 된다.
  const hover = useFluidHover(ref, { axis: "y" });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const typeahead = useRef({ buf: "", at: 0 });

  useEscapeConsumer(Boolean(anchor), () => onCloseRef.current());

  const rows = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu-row:not(:disabled)") ?? []);
  const isOpen = Boolean(anchor);
  useEffect(() => {
    if (!autoFocusFirst || !isOpen) return;
    // 위치 계산(useMenuPos)이 끝난 다음 프레임에 — 아직 화면 밖이면 포커스가 스크롤을 끌고 간다.
    const raf = requestAnimationFrame(() => {
      // focusVisible: 마우스 클릭 뒤의 스크립트 포커스도 :focus-visible 하이라이트를 받게 한다.
      rows()[0]?.focus({ focusVisible: true } as FocusOptions);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusFirst, isOpen]);

  if (!anchor) return null;

  const popoverStyle: CSSProperties = {
    position: "fixed",
    zIndex: "var(--z-modal)",
    minWidth,
    border: "1px solid var(--divider)",
    boxShadow: "var(--shadow-lg)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-1)",
    animation: "pop var(--dur-fast)",
    left: x,
    top: y,
    ...style,
  };

  const content = (
    <>
      <div
        onMouseDown={editorSafe ? (e) => e.preventDefault() : undefined}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
      />
      <div
        ref={ref}
        className={`overlay context-menu-popover fh-host ${className}`.trim()}
        role="menu"
        aria-label={ariaLabel}
        data-testid={testId}
        data-editor-pop={editorSafe ? "" : undefined}
        onMouseDown={editorSafe ? (e) => e.preventDefault() : undefined}
        onKeyDown={
          autoFocusFirst
            ? (e) => {
                if (e.nativeEvent.isComposing) return; // 한글 IME 조합 중엔 무시
                const focusRow = (el: HTMLElement) => el.focus({ focusVisible: true } as FocusOptions);
                const list = rows();
                if (!list.length) return;
                const i = list.indexOf(document.activeElement as HTMLElement);
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  focusRow(list[e.key === "ArrowDown" ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1)]);
                } else if (e.key === "Home" || e.key === "End") {
                  e.preventDefault();
                  focusRow(list[e.key === "Home" ? 0 : list.length - 1]);
                } else if (
                  e.key.length === 1 &&
                  !e.ctrlKey && !e.metaKey && !e.altKey &&
                  (e.key !== " " || typeahead.current.buf) // 빈 버퍼의 Space 는 버튼 활성화에 양보
                ) {
                  const t = typeahead.current;
                  const now = Date.now();
                  if (now - t.at > 500) t.buf = "";
                  t.at = now;
                  t.buf += e.key.toLowerCase();
                  // 한 글자면 현재 다음 행부터(같은 글자 반복 = 순환), 누적 접두사면 현재 행부터.
                  const from = t.buf.length === 1 ? i + 1 : Math.max(i, 0);
                  for (let k = 0; k < list.length; k++) {
                    const el = list[(from + k) % list.length];
                    if ((el.textContent ?? "").trim().toLowerCase().startsWith(t.buf)) {
                      e.preventDefault();
                      focusRow(el);
                      break;
                    }
                  }
                }
              }
            : undefined
        }
        style={popoverStyle}
        {...hover.handlers}
      >
        <FluidHoverHighlight hover={hover} />
        {children}
      </div>
    </>
  );

  return createPortal(content, container ?? document.body);
}
