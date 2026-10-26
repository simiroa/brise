import { useEffect } from "react";
import type { Suggestion } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";
import { IconLink } from "../../icons";

/** AI 가 쓴 제안 행(payload.reason / rationale)만 근거 문장을 갖는다. 그래프가 쓰는 겹침 행의
 *  payload 는 `{"source":"dashboard_graph","score":N}` 뿐이라 점수 줄만 보인다. */
export function suggestionAiReason(suggestion: Suggestion): string | null {
  try {
    const payload = JSON.parse(suggestion.payload) as { reason?: unknown; rationale?: unknown };
    const reason = typeof payload.reason === "string" ? payload.reason : payload.rationale;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  } catch {
    // silent-ok: 옛 행은 payload 가 비었거나 JSON 이 아니다 — 근거 줄만 생략하면 된다.
  }
  return null;
}

/**
 * 관계 탭 우측 패널 — 아무것도 선택하지 않았을 때 보이는 연결 제안 목록(GRILL-2026-10-19 R9).
 * 예전에는 칩을 눌러 여는 모달이었다. 카드 = 두 노트 제목 + 링크 표식 + 근거/겹침 점수 + 수락·무시.
 * 카드에 올리면(호버·포커스) 그래프에서 두 노드만 밝게 남긴다(onHover → GraphCanvas highlightIds).
 */
export function GraphSuggestionsPanel({
  suggestions,
  ready,
  getFolderColor,
  onAccept,
  onDismiss,
  onHover,
}: {
  suggestions: Suggestion[];
  /** 그래프 로드 뒤의 첫 제안 조회가 끝났는가 — 그 전에는 "제안 없음"을 단정하지 않는다. */
  ready: boolean;
  getFolderColor: (noteId: string) => string;
  onAccept: (suggestion: Suggestion) => void;
  onDismiss: (suggestion: Suggestion) => void;
  onHover: (suggestionId: string | null) => void;
}) {
  // 노드를 선택하면 패널이 통째로 내려간다 — mouseleave 없이 사라지므로 강조를 여기서 걷는다.
  useEffect(() => () => onHover(null), [onHover]);

  const count = suggestions.length;
  return (
    <section
      className="graph-suggest"
      data-testid="graph-suggestions-panel"
      aria-label={t("home.graph_suggestions_title")}
    >
      <header className="graph-suggest__head">
        <h3>{t("home.graph_suggestions_title")}</h3>
        {count > 0 && <span className="graph-suggest__count">{count}</span>}
      </header>
      {count > 0 ? (
        <ul className="graph-suggest__list">
          {suggestions.map((suggestion) => {
            const reason = suggestionAiReason(suggestion);
            const score = Math.round(suggestion.score);
            return (
              <li
                key={suggestion.id}
                className="graph-suggest-card"
                data-testid={`graph-suggestion-${suggestion.id}`}
                onMouseEnter={() => onHover(suggestion.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(suggestion.id)}
                onBlur={() => onHover(null)}
              >
                <div className="graph-suggest-card__pair">
                  <span className="graph-suggest-card__note">
                    <i style={{ background: getFolderColor(suggestion.note_id) }} />
                    <span>{displayTitle(suggestion.note_title)}</span>
                  </span>
                  <span className="graph-suggest-card__link" aria-hidden="true">
                    <IconLink size={11} strokeWidth={2} />
                  </span>
                  <span className="graph-suggest-card__note">
                    <i style={{ background: getFolderColor(suggestion.related_note_id) }} />
                    <span>{displayTitle(suggestion.related_note_title)}</span>
                  </span>
                </div>
                {reason && <p className="graph-suggest-card__reason">{reason}</p>}
                <div className="graph-suggest-card__foot">
                  <small className="graph-suggest-card__score" title={t("home.graph_suggest_score_hint")}>
                    {t("home.graph_suggest_score", { score })}
                  </small>
                  <div className="graph-suggest-card__actions">
                    <button type="button" className="graph-suggest-btn" onClick={() => onDismiss(suggestion)}>
                      {t("home.graph_dismiss")}
                    </button>
                    <button
                      type="button"
                      className="graph-suggest-btn graph-suggest-btn--accept"
                      onClick={() => onAccept(suggestion)}
                    >
                      {t("home.graph_accept")}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          {ready && <p className="graph-suggest__empty">{t("home.graph_suggest_empty")}</p>}
          <p className="graph-suggest__hint">{t("home.graph_select_hint")}</p>
        </>
      )}
    </section>
  );
}
