import React from "react";
import { useSearchStore } from "../../../stores/search";
import type { RosterMode } from "../../../stores/settings";
import {
  IconClose,
  IconTimeline,
  IconTag,
  IconMapPin,
  IconTree,
  IconImage,
  IconCalendar,
  IconChat,
} from "../../icons";

/** 연도 필터 전체 범위 — 등록된 문서에서 도출한 값(search 스토어, notes의 loadTree가 갱신 위임).
 * 문서가 추가/삭제되면 즉시 리렌더. */
export function useYearBounds() {
  return useSearchStore((s) => s.yearBounds);
}

/* ── Filter mode icons ──
   180px 최소 폭 + 큰 폰트 배율에서도 텍스트 라벨("Chronologie/Tags/Région")이 잘리거나
   줄바꿈되어 탭이 무너지는 문제를, 아이콘 한 개로 대체해 해결한다. 로컬라이즈된 텍스트는
   title(툴팁)과 aria-label(접근성)로 유지한다. 각 함수는 zero-arg 래퍼로 남겨(호출부는 그대로)
   내부만 icons.tsx 공유 파사드로 수렴했다 — 서로 실루엣이 뚜렷이 다른 lucide 아이콘을 골라
   15px에서도 tab끼리 구별되게 유지한다. */
const MODE_ICON_SIZE = { size: 15, strokeWidth: 1.8 } as const;

// Timeline
export function IconModeTimeline() {
  return <IconTimeline {...MODE_ICON_SIZE} aria-hidden />;
}

// Tags
export function IconModeTags() {
  return <IconTag {...MODE_ICON_SIZE} aria-hidden />;
}

// Région: 지도 핀 — IconPin(압정)과는 다른 개념이라 별도 export된 IconMapPin(눈물방울+원)을 쓴다.
export function IconModeRegion() {
  return <IconMapPin {...MODE_ICON_SIZE} aria-hidden />;
}

// Tree: note hierarchy — lucide의 전용 계층 아이콘.
// (IconModeStatus removed — status filter mode was collapsed into "advanced"; no remaining caller.)
export function IconModeTree() {
  return <IconTree {...MODE_ICON_SIZE} aria-hidden />;
}

// Gallery: image frame (attachment thumbs placeholder view) — icons.tsx의 IconImage 재사용.
export function IconModeGallery() {
  return <IconImage {...MODE_ICON_SIZE} aria-hidden />;
}

// Calendar: month grid.
export function IconModeCalendar() {
  return <IconCalendar {...MODE_ICON_SIZE} aria-hidden />;
}

// Chat: sidebar AI conversation (shared pet_chat thread).
export function IconModeChat() {
  return <IconChat {...MODE_ICON_SIZE} aria-hidden />;
}

/** 필터 로스터(사이드바 뷰 전환) 아이콘/라벨의 단일 소스 — 예전엔 YearFilter.tsx ·
 * FilterRosterSection.tsx · DashboardMiniPreview.tsx 3곳이 각자 같은 맵을 하드코딩해 중복됐다. */
export const ROSTER_ICON: Record<RosterMode, React.ReactNode> = {
  region: <IconModeRegion />,
  timeline: <IconModeTimeline />,
  chat: <IconModeChat />,
  gallery: <IconModeGallery />,
  calendar: <IconModeCalendar />,
};

export const ROSTER_LABEL_KEY: Record<RosterMode, string> = {
  region: "search.mode_region",
  timeline: "search.mode_timeline",
  chat: "search.mode_chat",
  gallery: "search.mode_gallery",
  calendar: "search.mode_calendar",
};

/* ── Shared chip style (Tags/Région) — same visual language as the old era buttons. ── */
export function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    fontSize: "var(--text-xs)",
    lineHeight: 1.3,
    padding: "var(--space-1) var(--space-2)",
    border: `1px solid ${active ? "var(--accent)" : "var(--divider)"}`,
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    color: active ? "var(--accent)" : "var(--muted)",
    background: active
      ? "color-mix(in srgb,var(--accent) 12%,transparent)"
      : "transparent",
    boxSizing: "border-box",
    transition: "background-color var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease",
  };
}

/* Wave 14: 사용자 추가 지역/시대 — "+" 칩(점선 테두리로 내장 칩과 구분)과 인라인 입력 공통 스타일. */
export const addChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "var(--text-xs)",
  lineHeight: 1.3,
  padding: "var(--space-1) var(--space-2)",
  border: "1px dashed var(--divider)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  color: "var(--muted)",
  background: "transparent",
  boxSizing: "border-box",
};

export const draftInputStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.3,
  padding: "var(--space-1) var(--space-2)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

/* 사용자 추가(제거 가능) 칩 — 내장 칩(chipStyle)과 같은 모양에 작은 x 버튼을 더한다. */
export function RemovableChip({
  label,
  hint,
  active,
  onSelect,
  onRemove,
  onRename,
  removeLabel,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
  /** 더블클릭 인라인 개명 진입점(StatusFilter 커스텀 상태) — 없으면 더블클릭은 그냥 무시된다. */
  onRename?: () => void;
  removeLabel: string;
}) {
  return (
    <span style={{ ...chipStyle(active), display: "inline-flex", alignItems: "center", gap: 3, paddingRight: 4 }}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onRename}
        title={hint}
        style={{ border: "none", background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer" }}
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        title={removeLabel}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          display: "grid",
          placeItems: "center",
          opacity: 0.6,
          cursor: "pointer",
          color: "inherit",
        }}
      >
        <IconClose size={9} strokeWidth={2.4} />
      </button>
    </span>
  );
}

/* 예약 박스 헤더 행(고정) + 칩 영역(스크롤) 공통 골격 — Tags/Région 모두 이 패턴을 따른다. */
export function FilterHeaderRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-2)",
        flex: "none",
        minHeight: 18,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
