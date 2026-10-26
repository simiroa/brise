import { useState } from "react";
import { ModalShell } from "../ModalShell";
import { t } from "../../i18n/t";
import type { DiagramModel, DiagramRoute } from "./diagramSchema";
import type { DiagramActions } from "./diagramActions";
import { STATE_SLOT_DEFS, stateSlotDef } from "./diagramStyles";

export interface DiagramStatesModalProps {
  open: boolean;
  onClose: () => void;
  model: DiagramModel;
  actions: DiagramActions;
}

export function DiagramStatesModal({ open, onClose, model, actions }: DiagramStatesModalProps) {
  const [slots, setSlots] = useState<string[]>(() => {
    const arr = Array(6).fill("");
    (model.states ?? []).forEach((s, idx) => {
      if (idx < 6) arr[idx] = s;
    });
    return arr;
  });

  const [flagLabel, setFlagLabel] = useState<string>(model.flagLabel ?? "");
  const [route, setRoute] = useState<DiagramRoute>(model.route ?? "curve");

  if (!open) return null;

  const handleSave = () => {
    const trimmed = [...slots.map((s) => s.trim())];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
      trimmed.pop();
    }
    actions.setStates(trimmed, flagLabel.trim() || undefined);
    if (route !== model.route) {
      actions.setRoute(route);
    }
    onClose();
  };

  return (
    <ModalShell
      title={t("editor.diagram_states_config_title")}
      onClose={onClose}
      width={460}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", width: "100%" }}>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            style={{ padding: "0 12px", width: "auto" }}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            data-testid="diagram-states-modal-save"
            style={{
              padding: "0 14px",
              width: "auto",
              background: "var(--accent)",
              color: "var(--on-accent)",
              fontWeight: 600,
            }}
            onClick={handleSave}
          >
            {t("common.apply")}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
          {t("editor.diagram_states_config_desc")}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
            {t("editor.diagram_state")} (0 ~ 5)
          </div>
          {STATE_SLOT_DEFS.map((_def, idx) => {
            const slot = stateSlotDef(idx);
            return (
              <div
                key={idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: `1.5px ${slot.borderStyle} ${slot.colorVar}`,
                    borderRadius: "var(--radius-sm)",
                    background: `color-mix(in srgb, ${slot.colorVar} 14%, transparent)`,
                    color: slot.colorVar,
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                  }}
                  title={t("editor.diagram_state_slot_label", { n: idx })}
                >
                  {idx}
                </div>
                <input
                  className="field"
                  data-testid={`diagram-state-slot-${idx}`}
                  value={slots[idx]}
                  placeholder={t("editor.diagram_state_slot_placeholder", { n: idx })}
                  onChange={(e) => {
                    const next = [...slots];
                    next[idx] = e.target.value;
                    setSlots(next);
                  }}
                  style={{ flex: 1, padding: "4px 8px", fontSize: "var(--text-sm)" }}
                />
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
          <label style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
            {t("editor.diagram_flag_label")}
          </label>
          <input
            className="field"
            data-testid="diagram-flag-label-input"
            value={flagLabel}
            placeholder={t("editor.diagram_flag_label_placeholder")}
            onChange={(e) => setFlagLabel(e.target.value)}
            style={{ width: "100%", padding: "4px 8px", fontSize: "var(--text-sm)", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
          <label style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>
            {t("editor.diagram_route")}
          </label>
          <div style={{ display: "flex", gap: "var(--space-3)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-sm)", cursor: "pointer" }}>
              <input
                type="radio"
                name="diagram-route-mode"
                value="curve"
                checked={route === "curve"}
                onChange={() => setRoute("curve")}
                data-testid="diagram-route-curve"
              />
              {t("editor.diagram_route_curve")}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--text-sm)", cursor: "pointer" }}>
              <input
                type="radio"
                name="diagram-route-mode"
                value="orthogonal"
                checked={route === "orthogonal"}
                onChange={() => setRoute("orthogonal")}
                data-testid="diagram-route-orthogonal"
              />
              {t("editor.diagram_route_orthogonal")}
            </label>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
