/**
 * 컨텍스트 줄 — 프롬프트 상자 **위**의 한 줄(PLAN-2026-09-15 §7 D14·D19).
 *
 * 항목 텍스트를 누르면 활성/비활성이 **토글**된다. 지우지 않는다: 비활성은 흐리게 + 취소선으로
 * 남아 "지금은 안 보낸다"를 보여준다. 별도 버튼은 없고, `/` 로 사용자가 직접 더한 항목에만
 * 호버 시 작은 ✕(= `onRemove`)이 붙는다.
 *
 * 첫 항목의 라벨이 옛 헤더의 `📁 폴더 › 📄 노트 │ 4 섹션 │ 1,846자` 자리를 대신한다(D19) —
 * 라벨·크기 문구는 데이터를 아는 모달의 `describeRef` 가 준다.
 */
import { IconBulletList, IconClose, IconFolder, IconHighlight, IconNote, IconPaperclip, IconSparkles, IconWeatherSun, type IconProps } from "../icons";
import { t } from "../../i18n/t";
import type { CtxRef } from "./composer/types";
import type { ComponentType } from "react";

export interface CtxDescription {
  label: string;
  /** 굵게 그려지는 크기 문구("4 섹션 · 1,846자"). 없으면 생략. */
  size?: string;
}
export type DescribeRef = (ref: CtxRef) => CtxDescription;

export interface CtxListItem {
  ref: CtxRef;
  active: boolean;
  /** `/`·첨부로 사용자가 더한 항목 — ✕ 가 붙는다. 대상이 심은 첫 항목(D19 의 신원 줄)은 빠진다. */
  removable?: boolean;
}

export const CTX_ICONS: Record<CtxRef["k"], ComponentType<IconProps>> = {
  body: IconNote,
  note: IconNote,
  section: IconBulletList,
  selection: IconHighlight,
  file: IconPaperclip,
  folder: IconFolder,
  weather: IconWeatherSun,
  result: IconSparkles,
};

export interface AskAiContextStripProps {
  items: CtxListItem[];
  describeRef: DescribeRef;
  onToggle: (index: number) => void;
  /** 있으면 `removable` 항목에 ✕ 가 붙는다. */
  onRemove?: (index: number) => void;
}

export function AskAiContextStrip({ items, describeRef, onToggle, onRemove }: AskAiContextStripProps) {
  if (items.length === 0) return null;
  return (
    <div className="askai-ctxstrip" data-testid="askai-ctxstrip">
      {items.map((item, i) => {
        const { label, size } = describeRef(item.ref);
        const Icon = CTX_ICONS[item.ref.k];
        // file 칩의 ✕ 는 칩만이 아니라 첨부 자체를 뺀다(AskAiModal.removeCtx) — 라벨도 그렇게 말한다.
        const removeLabel = item.ref.k === "file" ? t("ai.attach_remove", { name: label }) : t("ai.ctx_remove", { name: label });
        return (
          <span key={`${item.ref.k}-${i}`} className="askai-ctxstrip__chip" data-k={item.ref.k}>
            <button
              type="button"
              className="askai-ctxstrip__item"
              data-active={item.active ? undefined : "false"}
              data-testid={`askai-ctx-${item.ref.k}-${i}`}
              aria-pressed={item.active}
              title={t(item.active ? "ai.ctx_toggle_off" : "ai.ctx_toggle_on")}
              onClick={() => onToggle(i)}
            >
              <Icon size={12} strokeWidth={1.8} aria-hidden />
              <span className="askai-ctxstrip__label">{label}</span>
              {size ? <b>· {size}</b> : null}
            </button>
            {onRemove && item.removable && (
              <button
                type="button"
                className="askai-ctxstrip__remove"
                aria-label={removeLabel}
                title={removeLabel}
                onClick={() => onRemove(i)}
              >
                <IconClose size={11} strokeWidth={2} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
