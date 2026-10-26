import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clamp, popoverRoot } from "../../lib/ui";

/**
 * 설정 화면의 ⓘ 힌트 뱃지 — **한 벌만 둔다**.
 *
 * 이 마크업은 `SettingsRow` 와 `SectionHeader` 에 글자 하나까지 같은 모양으로 두 벌 복제돼
 * 있었다. PLAN-2026-09-12 §3 이 `SwitchGrid` 라는 세 번째 사용처를 만들면서 복제가 셋이 될
 * 참이라, 그 전에 여기로 뽑는다(`check:clones` 가 코드 클론을 본다).
 *
 * 접근성: 시각적으로는 ⓘ 글리프 하나지만, `title`(마우스 툴팁) · `aria-label`(보조기술) ·
 * 화면 밖 텍스트 세 경로로 같은 문구를 준다. `role="img"` 라 안쪽 글리프·텍스트는 보조기술에
 * 한 번만(이름으로) 읽힌다. `tabIndex={0}` 으로 키보드로도 닿는다 — 마우스가 없으면 힌트를 읽을
 * 길이 없었다. DESIGN.md 규칙 ③ — 행 힌트는 한 줄이 상한이고, 두 줄이 필요하면 이 뱃지가
 * 아니라 FeatureBriefModal 로 내린다.
 *
 * 키보드 포커스: `title` 툴팁은 마우스 hover 에서만 뜬다 — Tab 으로 닿아도 눈에는 아무것도
 * 안 보였다. 그래서 포커스 동안만 같은 문구의 말풍선을 따로 그린다(마우스 hover 는 지금처럼
 * `title` 이 맡아 툴팁이 두 개 겹치지 않는다). 설정 본문은 스크롤 컨테이너라 자식으로 두면
 * 잘리므로 FolderDotFilter 툴팁처럼 popoverRoot 에 fixed 로 띄운다. Escape 로 걷을 수 있다.
 */
export function HintBadge({ hint }: { hint: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [focusRect, setFocusRect] = useState<DOMRect | null>(null);
  return (
    <span
      ref={ref}
      role="img"
      tabIndex={0}
      title={hint}
      aria-label={hint}
      onFocus={(e) => setFocusRect(e.currentTarget.getBoundingClientRect())}
      onBlur={() => setFocusRect(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && focusRect) {
          e.stopPropagation();
          setFocusRect(null);
        }
      }}
      style={{
        cursor: "help",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 15,
        height: 15,
        borderRadius: "50%",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        color: "var(--muted)",
        // E8: "떠 있는 작은 면"은 --surface-raised 한 어휘로 모은다(폴더 개수 배지와 같은 토큰).
        // --surface-sunken 은 기준면에서 파생돼 설정 본문 위에서 CR 1.020 — 원이 사실상 안
        // 보이고 ⓘ 글리프만 떠 있었다. --surface-raised 는 중성 반투명(회색 6%)이라 본문·
        // 사이드바 어느 바탕 위에서도 한 단 위로 뜬다.
        background: "var(--surface-raised)",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      ⓘ
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: 0,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {hint}
      </span>
      {focusRect && createPortal(<HintTip hint={hint} rect={focusRect} />, popoverRoot(ref.current))}
    </span>
  );
}

/** 포커스 말풍선 — 뱃지 아래(자리가 없으면 위)에 화면 안으로 맞춰 띄운다. 이름은 이미 aria-label 이
 *  주므로 보조기술에는 숨긴다(두 번 읽히지 않게). */
function HintTip({ hint, rect }: { hint: string; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: rect.left, top: rect.bottom + 4 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const tip = ref.current.getBoundingClientRect();
    const margin = 8;
    const left = clamp(rect.left + rect.width / 2 - tip.width / 2, margin, Math.max(margin, window.innerWidth - tip.width - margin));
    let top = rect.bottom + 4;
    if (top + tip.height > window.innerHeight - margin) top = Math.max(margin, rect.top - tip.height - 4);
    setPos({ left, top });
  }, [rect]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="hint-badge-tip"
      // 표면은 .overlay 가 소유한다(불투명 판). 모양은 FolderDotFilter 툴팁(.folder-dot-tooltip)과 같지만
      // 그 CSS 는 대시보드에서만 로드돼 설정 창에 없다 — 그래서 여기 인라인으로.
      className="overlay"
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: "var(--z-tooltip)",
        maxWidth: 320,
        padding: "var(--space-1) var(--space-2)",
        fontSize: "var(--text-xs)",
        fontWeight: 400,
        color: "var(--text)",
        borderRadius: "var(--radius-sm)",
        boxShadow: "var(--shadow-md)",
        pointerEvents: "none",
      }}
    >
      {hint}
    </div>
  );
}
