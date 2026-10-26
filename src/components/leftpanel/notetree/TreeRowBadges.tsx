import React from "react";
import { IconShare, IconStar } from "../../icons";
import { t } from "../../../i18n/t";
import { statusColorVar } from "../../../lib/status";

export interface TreeRowBadgesProps {
  exportedAt?: string | null;
  isFavorite?: boolean;
  status?: string | null;
  hasImage?: boolean;
  tagNames?: readonly string[];
}

// hasImage / tagNames 는 호출부가 넘겨는 주지만 여기서 그리는 것이 없다(예전부터 그랬다).
// 그래서 "그릴 게 있나" 판단도 **실제로 렌더되는 세 가지**로만 한다 — 예전엔 빈 프래그먼트라
// 아무 자리도 안 먹었지만 지금은 폭 고정 슬롯이라, 태그만 달린 노트가 영영 빈 여백을 차지한다.
function TreeRowBadgesImpl({
  exportedAt,
  isFavorite,
  status,
}: TreeRowBadgesProps): React.ReactElement | null {
  const hasBadges = Boolean(exportedAt || isFavorite || status);

  if (!hasBadges) return null;

  // 상태 점은 항상 보이고, 내보내기/즐겨찾기는 좁은 사이드바에서 제목을 갉아먹지 않도록 행
  // hover 시에만 나타난다("treeact" — 기본 은닉은 treeRow.css 가, hover 시 노출은 tokens.css
  // 의 `.treerow:hover .treeact{opacity:1}` 가 맡는다. 그 규칙은 지금까지 짝이 되는 기본
  // 은닉이 없어 죽어 있었다 — treeRow.css 참고).
  // 바깥 슬롯은 폭을 고정한다(상태 점 6 + gap 4 + 내보내기 아이콘 12 + gap 4 + 즐겨찾기 별
  // 12 = 38, 여유 포함 40px) — hover 로 항목이 나타나거나 사라져도 슬롯 폭이 바뀌지 않아야
  // 제목이 리플로우하지 않는다(opacity 로 토글하는 이유이기도 하다 — display:none 은 레이아웃
  // 을 제거해 이 폭 고정이 무의미해진다).
  return (
    <span
      className="tree-badges"
      data-testid="tree-badges-slot"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "var(--space-1)",
        width: 40,
        flex: "none",
      }}
    >
      {status && (
        <span
          data-testid="treerow-status-indicator"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: statusColorVar(status),
            flex: "none",
          }}
        />
      )}
      <span
        className="treeact"
        style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}
      >
        {exportedAt && (
          <span title={t("ctx.exported")} style={{ display: "grid", placeItems: "center" }}>
            <IconShare size={12} strokeWidth={1.8} style={{ color: "var(--muted)", opacity: 0.7 }} />
          </span>
        )}
        {isFavorite && (
          <IconStar
            size={12}
            strokeWidth={1.6}
            style={{ fill: "var(--accent)", color: "var(--accent)" }}
          />
        )}
      </span>
    </span>
  );
}

export const TreeRowBadges = React.memo(TreeRowBadgesImpl);
