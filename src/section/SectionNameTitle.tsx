import { useRef, useState } from "react";

/**
 * 섹션 분리 창의 제목 자리 — 섹션 이름을 그 자리에서 고친다(Enter/블러 = 저장, Esc = 취소).
 * 뒤의 " — 노트 제목"은 읽기 전용 맥락이고 드래그 영역이다(창 이동). 저장 규칙(빈 이름 거부 등)은
 * onCommit 쪽 몫이고, 여기는 draft 만 든다 — 커밋이 거부/실패하면 prop 이름으로 되돌아간다.
 */
export function SectionNameTitle(props: {
  name: string;
  noteTitle: string;
  onCommit: (name: string) => Promise<void>;
}) {
  const { name, noteTitle, onCommit } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? name;
  // 탭 개명(SectionTabBar)과 같은 가드: Enter 가 직접 커밋하고 뒤따르는 blur 는 건너뛴다(이중 커밋 방지),
  // Esc 는 커밋 없이 취소하고 뒤따르는 blur 도 건너뛴다(예전엔 blur 가 옛 draft 클로저로 커밋했다).
  const skipNextBlurRef = useRef(false);
  const inFlightRef = useRef(false);

  const commit = async (d: string | null) => {
    if (d === null || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await onCommit(d);
    } finally {
      inFlightRef.current = false;
      setDraft(null); // 성공이면 prop 이 새 이름, 거부/실패면 원래 이름
    }
  };

  return (
    <>
      <input
        data-testid="section-window-name"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (skipNextBlurRef.current) {
            skipNextBlurRef.current = false;
            return;
          }
          void commit(draft);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            skipNextBlurRef.current = true;
            void commit(draft);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            skipNextBlurRef.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        style={{
          minWidth: 80,
          width: `${Math.max(6, value.length + 1)}ch`,
          maxWidth: "70%",
          margin: 0,
          padding: 0,
          border: 0,
          outline: "none",
          background: "transparent",
          color: "var(--text)",
          font: "inherit",
          // 보조 창 머리줄 제목 크기 하나(--text-lg/600, GRILL-2026-10-19 R1-E) — AuxWindowChrome 의 h1 과 같다.
          fontSize: "var(--text-lg)",
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
        }}
      />
      {noteTitle && (
        <span
          data-tauri-drag-region
          style={{ color: "var(--muted)", fontSize: "var(--text-md)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          — {noteTitle}
        </span>
      )}
    </>
  );
}
