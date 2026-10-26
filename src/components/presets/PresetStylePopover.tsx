import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/t";
import { PRESET_COLORS, presetColorVar, type CustomPreset, type PresetColor } from "../../stores/presets";
import { IconGrid } from "../IconPicker";
import { IconNote } from "../icons";
import { popoverRoot } from "../../lib/ui";

export interface PresetStylePopoverProps {
  styleTarget: CustomPreset;
  styleCtx: { id: string; x: number; y: number } | null;
  styleRef: RefObject<HTMLDivElement | null>;
  styleX: number;
  styleY: number;
  rootEl: HTMLDivElement | null;
  onClose: () => void;
  onSetStyle: (id: string, patch: { icon?: string | null; color?: PresetColor | null }) => void;
}

export function PresetStylePopover({
  styleTarget,
  styleCtx,
  styleRef,
  styleX,
  styleY,
  rootEl,
  onClose,
  onSetStyle,
}: PresetStylePopoverProps) {
  if (!styleTarget || !styleCtx) return null;

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: "var(--z-modal)" }}
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={styleRef}
        className="overlay"
        role="dialog"
        data-testid="preset-style-popover"
        aria-label={t("presets.style_title")}
        style={{
          position: "fixed",
          left: styleX,
          top: styleY,
          width: 300,
          zIndex: "var(--z-modal)",
          padding: "var(--space-4)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--divider)",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="label-caps">{styleTarget.name}</div>
        <IconGrid
          value={styleTarget.icon ?? null}
          defaultComp={IconNote}
          onPick={(key) => onSetStyle(styleTarget.id, { icon: key })}
        />
        <div
          role="radiogroup"
          aria-label={t("presets.style_title")}
          style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}
        >
          {[null, ...PRESET_COLORS].map((c) => (
            <button
              key={c ?? "default"}
              type="button"
              className="icon-swatch"
              data-active={(styleTarget.color ?? null) === c}
              aria-pressed={(styleTarget.color ?? null) === c}
              title={c ?? t("presets.color_default")}
              aria-label={c ?? t("presets.color_default")}
              style={{ minHeight: 26, width: 26, flex: "none" }}
              onClick={() => onSetStyle(styleTarget.id, { color: c as PresetColor | null })}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: presetColorVar(c),
                }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>,
    popoverRoot(rootEl)
  );
}
