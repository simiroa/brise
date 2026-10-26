import React from "react";

export type PillTone = "muted" | "accent" | "soft";

// 색·테두리·패딩은 앱 전체 배지 한 벌 `.badge`(styles/tokens.css, GRILL-2026-10-19 R8)가 정한다.
// 예전엔 muted 가 --surface-raised-strong, soft 가 불투명 --surface-soft(acrylic 에서 바탕을 가리는 패치)를
// 칠했다 — 이제 둘 다 반투명 muted 틴트다. soft 는 호출부(TreeHeaderRow)를 그대로 두려고 이름만 남는다.
const BADGE_TONE: Record<PillTone, string> = {
  // RegionExpanded.tsx / TagsExpanded.tsx 의 결과 개수 칩.
  muted: "muted",
  // notetree/index.tsx 의 검색 결과 개수 칩.
  accent: "accent",
  // notetree/TreeHeaderRow.tsx 의 트리 헤더(미분류·즐겨찾기·휴지통·아카이브) 개수 칩.
  soft: "muted",
};

export interface PillProps {
  tone: PillTone;
  children: React.ReactNode;
  /** 자리별로 갈리는 폰트 크기·패딩·레이아웃(marginLeft 등)을 얹을 때만 쓴다. */
  style?: React.CSSProperties;
}

/**
 * 둥근 뱃지(카운트·짧은 상태 문구) 공용 셸.
 * 4곳(RegionExpanded/TagsExpanded/notetree index/TreeHeaderRow)이 각자 손으로 복제해 오던
 * span 스타일을 한 벌로 묶는다. 모양은 `.badge` 가 갖고, 여기는 개수 칩다운 것만 얹는다 —
 * 한 단 작은 글자(--text-2xs)와 숫자 폭 정렬.
 */
export function Pill({ tone, children, style }: PillProps): React.ReactElement {
  return (
    <span
      className="badge"
      data-tone={BADGE_TONE[tone]}
      style={{
        fontSize: "var(--text-2xs)",
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
