import { useState } from "react";
import { t } from "../../i18n/t";
import type { AiActionPreset, AskAiWhere } from "../../stores/aiPrompts";
import type { AskAiHistoryEntry } from "../../lib/askAiHistory";
import type { ComposerDoc, CtxRef } from "./composer/types";
import { tileIcon } from "./askAiPresets";
import { IconEdit, IconNote, IconPlus } from "../icons";
import { PresetManageModal } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";

// 편집·추가 버튼은 AskAiModal 이 렌더하는 지연 PresetManageModal 을 연다 — 버튼에서 미리 받는다.
const presetManageIntent = preloadIntentProps(PresetManageModal);

/** 호버 미리보기(D11)가 받는 것 — 스탬프될 문서와 위치. */
export interface AskAiHoverStamp {
  doc: ComposerDoc;
  where: AskAiWhere;
}

interface AskAiTileGridProps {
  tiles: AiActionPreset[];
  history: AskAiHistoryEntry[];
  selectedId: string | null;
  recentId: string | null;
  /** 요청문이 마지막 스탬프에서 벗어났는가(D6) — 「● 커스텀」 배지. */
  custom: boolean;
  onPick: (p: AiActionPreset) => void;
  onPickHistory: (h: AskAiHistoryEntry) => void;
  onHover: (stamp: AskAiHoverStamp | null) => void;
  /** 연필 — AI 프리셋 편집기를 연다. */
  onEdit: () => void;
  /** 「추가」 타일 — 같은 편집기를 새 프리셋 하나를 만든 채로 연다. */
  onAdd: () => void;
  /** 프리셋 → 스탬프 문서. 템플릿 파싱은 composer 가 소유하므로 프롭으로 받는다. */
  stampFor: (p: AiActionPreset) => ComposerDoc;
  describeHistoryWhere: (where: AskAiWhere) => string;
}

type Tab = "presets" | "history";

function ctxLabel(ref: CtxRef): string {
  switch (ref.k) {
    case "body":
      return t("ai.ctx_token_body");
    case "section":
      return t("ai.ctx_section_fallback");
    case "selection":
      return t("ai.ctx_selection_label");
    case "note":
      return t("ai.ctx_token_note");
    case "file":
      return ref.name;
    case "folder":
      return t("ai.ctx_item_folder");
    case "weather":
      return t("ai.ctx_item_weather");
    case "result":
      return t("ai.ctx_label_result");
  }
}

function fmtDate(at: number): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/**
 * 좌측 패널 — 「프리셋 │ 히스토리」 탭, 4열 타일, 히스토리 목록(PLAN-2026-09-15 D3·D6·D11·D12, 6안 D20).
 * 타일은 실행하지 않는다: 누르면 `onPick`, 올리면 `onHover` 로 스탬프될 문장을 미리 알린다.
 *
 * 두 탭의 내용은 **같은 높이의 칸**(`.askai-tiles__pane`) 안에서 각자 스크롤한다 — 탭을 바꿔도
 * 모달 높이가 흔들리지 않게(D20). 히스토리 행의 참조는 문장이 아니라 `refs` 에서 그린다(D18).
 */
export function AskAiTileGrid({
  tiles,
  history,
  selectedId,
  recentId,
  custom,
  onPick,
  onPickHistory,
  onHover,
  onEdit,
  onAdd,
  stampFor,
  describeHistoryWhere,
}: AskAiTileGridProps) {
  const [tab, setTab] = useState<Tab>("presets");
  const leave = () => onHover(null);

  return (
    <div className="askai-tiles" onMouseLeave={leave}>
      <div className="askai-tiles__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="askai-tiles__tab"
          aria-selected={tab === "presets"}
          onClick={() => setTab("presets")}
        >
          {t("ai.tiles_tab_presets")}
        </button>
        <button
          type="button"
          role="tab"
          className="askai-tiles__tab"
          aria-selected={tab === "history"}
          onClick={() => setTab("history")}
        >
          {t("ai.tiles_tab_history")}
        </button>
        {custom && <span className="askai-tiles__custom">{t("ai.tiles_custom_badge")}</span>}
        <button
          type="button"
          className="icon-btn icon-btn--sm askai-tiles__edit"
          aria-label={t("ai.tiles_edit")}
          title={t("ai.tiles_edit")}
          onClick={onEdit}
          {...presetManageIntent}
        >
          <IconEdit size={14} strokeWidth={1.8} />
        </button>
      </div>

      {tab === "presets" ? (
        <div className="askai-tiles__pane scroll" role="tabpanel">
          <div className="askai-tiles__grid">
            {tiles.map((p) => {
              const Icon = tileIcon(p.icon, p.kind);
              // 라벨이 없으면 이름 전체 — 자르기는 CSS(.askai-tile__label, 두 줄 + 말줄임)가 맡는다.
              // 예전엔 여기서 앞 4자로 잘라 「새 프리셋」이 「새 프리」로 표시도 없이 끊겼다. 전체 이름은
              // 버튼의 title·aria-label.
              const label = p.label || p.name;
              const hover = () => onHover({ doc: stampFor(p), where: p.where ?? "section" });
              return (
                <button
                  key={p.id}
                  type="button"
                  className="askai-tile"
                  data-testid={`askai-tile-${p.id}`}
                  data-recent={p.id === recentId ? "true" : undefined}
                  aria-pressed={p.id === selectedId}
                  aria-label={p.name}
                  title={p.name}
                  onClick={() => onPick(p)}
                  onMouseEnter={hover}
                  onFocus={hover}
                  onBlur={leave}
                >
                  <span className="askai-tile__icon">
                    <Icon size={20} strokeWidth={1.6} />
                  </span>
                  <span className="askai-tile__label">{label}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="askai-tile askai-tile--add"
              aria-label={t("ai.tiles_add")}
              title={t("ai.tiles_add")}
              onClick={onAdd}
              {...presetManageIntent}
            >
              <span className="askai-tile__icon">
                <IconPlus size={20} strokeWidth={1.6} />
              </span>
              <span className="askai-tile__label">{t("ai.tiles_add")}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="askai-tiles__pane scroll" role="tabpanel">
          <div className="askai-history">
            {history.length === 0 && <div className="askai-history__empty">{t("ai.history_empty")}</div>}
            {history.map((h) => {
              const hover = () => onHover({ doc: h.doc, where: h.where });
              return (
                <button
                  key={h.id}
                  type="button"
                  className="askai-history__row"
                  data-testid={`askai-history-${h.id}`}
                  onClick={() => onPickHistory(h)}
                  onMouseEnter={hover}
                  onFocus={hover}
                  onBlur={leave}
                >
                  <span className="askai-history__text">
                    {h.doc.map((part, i) =>
                      part.t === "text" ? <span key={i}>{part.v}</span> : <b key={i}>{part.v || part.ph || part.key}</b>,
                    )}
                  </span>
                  {h.refs.length > 0 && (
                    <span className="askai-history__refs">
                      {h.refs.map((ref, i) => (
                        <span key={i} className="askai-history__ctx">
                          {ctxLabel(ref)}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="askai-history__meta">
                    <span>
                      <IconNote size={11} strokeWidth={1.8} />
                      {t("ai.history_meta", { note: h.noteTitle, where: describeHistoryWhere(h.where) })}
                    </span>
                    <span className="askai-history__date">{fmtDate(h.at)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
