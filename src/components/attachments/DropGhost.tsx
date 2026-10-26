/**
 * 파일 드래그오버 공용 고스트 오버레이 — 프리뷰 패널(SourcePanel.tsx dropOverlay)에서 뽑아냈다.
 * 계약: 부모가 `position: relative`(또는 `absolute`/`fixed`)여야 한다 — 이 컴포넌트는 `inset:0`으로
 * 부모를 꽉 채우고 `pointer-events:none`이라 드롭 자체를 가로채지 않는다(호스트가 직접 히트테스트).
 */
export function DropGhost({ label, testid }: { label: string; testid?: string }) {
  return (
    <div
      data-testid={testid}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 2,
        display: "grid",
        placeItems: "center",
        pointerEvents: "none",
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        border: "2px dashed var(--accent)",
        borderRadius: "inherit",
        color: "var(--accent)",
        fontFamily: "var(--font-body)",
        fontSize: "var(--text-sm)",
        fontWeight: 600,
      }}
    >
      {label}
    </div>
  );
}
