import React, { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./icons";
import { t } from "../i18n/t";

interface ModalShellProps {
  /** 헤더 내용. 노드를 넘기면 `ariaLabel` 로 대화상자 이름을 따로 줘야 한다. */
  title: React.ReactNode;
  /** `title` 이 문자열이 아닐 때의 접근성 이름. */
  ariaLabel?: string;
  onClose: () => void;
  width?: number | string;
  /** 고정 높이(px) — 단계마다 내용 높이가 달라도 창이 출렁이지 않게(온보딩). 화면이 작으면 88vh 로 줄고
   *  본문이 스크롤한다. 생략하면 지금처럼 내용 높이를 따른다. */
  height?: number;
  /** false 면 바깥 클릭·Escape 로 닫히지 않는다 — X 만 닫는다(Escape 는 삼켜서 뒤 앱으로 새지 않게).
   *  길게 입력하는 흐름에서 실수로 전체가 닫히는 걸 막는다(온보딩, 오너 2026-09-29). 기본 true. */
  dismissible?: boolean;
  /** 저장·가져오기처럼 되돌릴 수 없는 일이 진행 중 — X 까지 꺼서 **어떤 길로도** 닫히지 않는다
   *  (`dismissible={false}` 를 겸한다). 닫혀 버리면 결과(성공 토스트·오류 문구)를 받을 화면이
   *  사라지고, 폼 입력도 같이 날아간다. 끝나면 호출자가 false 로 돌린다. */
  busy?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** AI 빛줄기(tokens.css AI-GLOW › BEAM)를 카드 테두리에 두른다 — "active" 동안 돌고 "fading" 에서
   *  사라진다. AI 경험이 모달 중심이 되면서(2026-09-27 오너) 에디터에 걸리던 빛줄기가 스크림 뒤로
   *  가려졌다 — 그래서 사람이 보고 있는 모달이 대신 든다. AI 가 일하는 동안에만 켠다(상시 금지, 오너
   *  2026-09-27). 호출: AiResultModal(생성 중). */
  aiGlow?: "active" | "fading";
}

// 열려 있는 모달 스택 — Escape 는 **맨 위 한 장**만 닫는다. 네이티브 <dialog> 의 top layer 스택을
// 대신하는 최소 구조물이다. 중첩 모달의 시각적 순서는 나중에 열린 것이 나중에 body 에 붙으므로
// DOM 순서로 이미 위에 온다(같은 --z-modal).
import { pushOverlay, dismissTopOverlay } from "../lib/overlayStack";

/**
 * 포커스 격리(`inert`)의 소유자. 규칙은 한 줄이다 — **맨 위 스크림을 뺀 body 자식은 전부 inert**.
 * 그 규칙을 셸이 뜨고 질 때마다 **처음부터 다시 계산**한다.
 *
 * 왜 다시 계산하나 (2026-09-09, 화면 전체 먹통 사고): 예전엔 각 셸이 마운트 순간의 body 자식을
 * 스냅샷으로 찍어 "나 빼고 전부 inert" 를 걸고 언마운트 때 자기가 건 것만 풀었다. 이 방식은 셸이
 * 하나씩 순서대로 뜰 때만 맞는다. 두 셸의 effect 가 **같은 커밋**에서 돌면(폴더 설정 모달이 뜨는
 * 순간 AI 정리 제안 검토 모달이 함께 마운트) DOM 삽입은 effect 보다 먼저 끝나 있으므로, 먼저 도는
 * 바깥 셸이 **아직 남의 것인 안쪽 스크림에 inert 를 걸고**, 이어 안쪽 셸이 바깥 스크림에 건다 —
 * 두 장 다 죽어서 모달은 보이는데 체크박스도 취소도 X 도 안 눌린다(Escape 만 살아 있었다).
 * 스택을 보고 매번 다시 계산하면 effect 순서가 어떻든 결과가 같고, 바깥 셸이 먼저 닫히는
 * 역순 언마운트에서 바깥 트리의 inert 가 남거나 풀려버리던 것도 같이 사라진다.
 */
const scrimStack: HTMLElement[] = [];
const inertedByUs = new Set<HTMLElement>();

function syncInert() {
  // 우리가 건 것부터 전부 푼다 — 남은 inert 는 남의 것이므로 아래 루프가 건드리지 않는다.
  for (const el of inertedByUs) el.removeAttribute("inert");
  inertedByUs.clear();
  const top = scrimStack[scrimStack.length - 1];
  if (!top) return;
  for (const el of Array.from(document.body.children)) {
    if (el === top || !(el instanceof HTMLElement)) continue;
    if (el.hasAttribute("inert")) continue;
    el.setAttribute("inert", "");
    inertedByUs.add(el);
  }
}

/**
 * 떠 있는 모달 셸.
 *
 * **왜 네이티브 `<dialog>.showModal()` 이 아닌가** (2026-08-14): showModal 은 카드를 top layer 로
 * 올린다. top layer 안에서는 `backdrop-filter` 가 그 아래 페이지를 샘플링하지 못해서, 아크릴
 * 프리셋의 모달이 유리가 될 수 없다. 예전엔 body 에 카드와 같은 사각형을 JS 로 복제한 쌍둥이
 * 레이어로 우회했는데 — rAF·MutationObserver·ResizeObserver 로 매 프레임 기하를 베끼고, z-index 를
 * computed 값에서 추측하고, 실패해도 폴백이 없어서 한 번 안 그려지면 카드가 배경 없이 알몸으로
 * 남았다(실제로 그렇게 났다). 그래서 top layer 를 포기하고 일반 레이어로 내려왔다: 스크림도
 * 카드도 평범한 div 라 `backdrop-filter` 가 그냥 먹고, 복제 레이어가 통째로 사라진다.
 * 그 쌍둥이의 식별자 재등장은 scripts/check-surface-contract.mjs 가 막는다.
 *
 * 그 대신 <dialog> 가 공짜로 주던 것을 여기서 소유한다 — 포커스 격리(`inert`), 포커스 복원,
 * Escape, 중첩 스택. 옛날 수동 Tab 트랩(FOCUSABLE 스캔 + keydown 리스너)은 돌아오지 않는다:
 * `inert` 는 하위 트리를 포커스·접근성 트리에서 통째로 빼주므로 브라우저가 트랩을 대신한다.
 */
export function ModalShell({ title, ariaLabel, onClose, width = 560, height, dismissible = true, busy = false, children, footer, aiGlow }: ModalShellProps) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // onClose 는 부모가 매 렌더 새로 만드는 경우가 많다 — 스택/리스너는 마운트 1회만 잡고
  // 최신 콜백은 ref 로 읽는다(리스너 재등록으로 스택 순서가 흔들리지 않게).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // busy 는 X·Escape·바깥 클릭 **세 길 모두**가 지나는 requestClose 한 곳에서 막는다.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    if (closingRef.current) return;
    closingRef.current = true;
    if (process.env.NODE_ENV === "test") {
      closeRef.current();
      return;
    }
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      closeRef.current();
    }, 120);
  }, []);

  // 효과를 다시 돌리지 않고(포커스 재이동 방지) 최신 값을 읽도록 ref 로.
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;

    // 바깥을 inert 로 — 스택에 우리를 올리고 규칙을 다시 계산한다(위 syncInert 주석 참고).
    const scrim = scrimRef.current;
    if (scrim) scrimStack.push(scrim);
    syncInert();

    // inert 인 요소는 포커스를 받지 못한다 — 반드시 syncInert 뒤에 부른다.
    cardRef.current?.focus();

    // dismissTopOverlay 는 콜백을 부르기 **전에** 스택에서 뺀다. 닫지 않고 삼킨 경우엔 다시 올려야
    // 한다 — 안 그러면 두 번째 Escape 가 이 모달을 건너뛰어 아래 모달이나 창(AuxWindowChrome)을 닫는다.
    const close = () => {
      if (dismissibleRef.current && !busyRef.current) requestClose();
      else pushOverlay(close);
    };
    const removeOverlay = pushOverlay(close);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      if (dismissTopOverlay()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      window.removeEventListener("keydown", onKeyDown);
      removeOverlay();
      if (scrim) {
        const i = scrimStack.indexOf(scrim);
        if (i >= 0) scrimStack.splice(i, 1);
      }
      syncInert();
      restore?.focus?.();
    };
  }, [requestClose]);

  // 스크림(카드 바깥) 클릭으로 닫기 — 카드가 stopPropagation 하므로 스크림 자신이 타깃인
  // 경우만 "바깥 클릭"이다.
  const handleScrimClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dismissible && !busy && e.target === scrimRef.current) requestClose();
  };

  return createPortal(
    <div
      ref={scrimRef}
      // 스크림 배경은 클래스가 소유한다(.modal-scrim, tokens.css SINGLE-SHEET ACRYLIC CONTRACT).
      className={`modal-scrim${closing ? " closing" : ""}`}
      data-testid="modal-backdrop"
      onClick={handleScrimClick}
    >
      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        // 표면은 .overlay 가 전부 소유한다 — flat 은 불투명, acrylic 은 틴트+블러+채도+그레인+림.
        // 배경을 벗기고 쌍둥이 레이어에 위임하던 옛 변형 클래스는 사라졌다.
        className="overlay"
        data-testid="modal-shell"
        data-ai-glow={aiGlow}
        data-ai-glow-beam={aiGlow ? "true" : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        // 프로그램 포커스 진입점 — 열릴 때 여기로 포커스를 옮겨야 스크린리더가 대화상자를 읽고,
        // Tab 이 카드 안에서 시작한다(바깥은 inert 라 나갈 곳이 없다).
        tabIndex={-1}
        style={{
          // `min(${width}px,100%)` 이었다가 고정 px + maxWidth 로 바꿈: %는 부모 기준이라
          // 순환 참조가 되고 폭 계산이 max-content 로 튄다("모달이 중앙에 안 온다" 버그).
          width,
          maxWidth: "100%",
          height: height ? `min(${height}px, 88vh)` : undefined,
          maxHeight: "88vh",
          // 스크롤은 카드가 아니라 안쪽 본문이 소유한다 — 그래야 헤더/푸터 아래로 본문이
          // 지나가지 않고, 따라서 헤더/푸터가 자기 배경(불투명 판)을 가질 이유가 없어진다.
          // 유리 한 장이 카드 전체에 이음매 없이 깔린다.
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "var(--shadow-lg)",
          borderRadius: "var(--radius-lg)",
          animation: "pop .16s",
          outline: "none",
        }}
      >
        {/* 헤더/본문/푸터 레이아웃과 색은 클래스가 소유한다(tokens.css .modal-head/.modal-body/
            .modal-foot) — 오버레이가 항상 불투명이 된 뒤로 "유리 한 장" 제약이 사라져 헤더에
            한 단 올린 톤을 깔 수 있다. */}
        <div className="modal-head">
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-2xl)",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              minWidth: 0,
              flex: "1 1 auto",
              display: "flex",
              alignItems: "center",
            }}
          >
            {title}
          </h3>
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            data-testid="modal-close-btn"
            aria-label={t("common.close")}
            style={{
              marginLeft: "auto",
              width: 34,
              height: 34,
              display: "grid",
              placeItems: "center",
              cursor: busy ? "not-allowed" : "pointer",
              color: "var(--muted)",
              opacity: busy ? "var(--dim-disabled)" : undefined,
              background: "transparent",
              border: "none",
              padding: 0,
            }}
          >
            <IconClose size={17} strokeWidth={2} />
          </button>
        </div>

        <div className="scroll modal-body">
          {children}
        </div>
        {footer && (
          <div data-testid="modal-footer" className="modal-foot">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
