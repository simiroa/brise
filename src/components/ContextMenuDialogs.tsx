import { useState } from "react";
import { useSettingsStore } from "../stores/settings";
import { folderColorCss, FOLDER_PRESET_HUES } from "../lib/ui";
import { t } from "../i18n/t";
import { ModalShell } from "./ModalShell";

// Wave R3: lifted out of ContextMenu.tsx — TagColorDialog still uses this modal.
// 폴더 색은 여기가 아니라 폴더 설정(FolderOrganizeModal) 소관이다.

/** Wave 11: folder icon color picker — free hue slider + reset, keyboard-operable
 * (<input type="range"> is natively focusable/arrow-key adjustable). Kept as a small
 * standalone ModalShell dialog rather than extending PromptDialog's fixed modes, since none
 * of "input"/"choice"/"confirm" fit a live-preview slider. */
export function TagColorDialog({
  initialHue,
  onCancel,
  onSubmit,
}: {
  initialHue: number | null;
  onCancel: () => void;
  onSubmit: (hue: number | null) => void;
}) {
  return (
    <FolderColorDialog
      title={t("ctx.tag_color_title")}
      initialHue={initialHue}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

export function FolderColorDialog({
  title = t("ctx.folder_color_title"),
  initialHue,
  onCancel,
  onSubmit,
}: {
  title?: string;
  initialHue: number | null;
  onCancel: () => void;
  onSubmit: (hue: number | null) => void;
}) {
  const [hue, setHue] = useState<number>(initialHue ?? 0);
  const [hasColor, setHasColor] = useState<boolean>(initialHue !== null);
  const recentColorHues = useSettingsStore((s) => s.recentColorHues);
  const addRecentColorHue = useSettingsStore((s) => s.addRecentColorHue);

  const preview = hasColor ? folderColorCss(hue) : "var(--faint)";

  const handleApply = () => {
    if (hasColor) {
      void addRecentColorHue(hue);
      onSubmit(hue);
    } else {
      onSubmit(null);
    }
  };

  return (
    <ModalShell title={title} onClose={onCancel} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Live preview + Hue slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden="true"
            style={{
              flex: "none",
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: "1px solid var(--divider)",
              background: preview,
              boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
            }}
          />
          <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 600 }}>
              {t("ctx.folder_color_hue")} ({hasColor ? `${hue}°` : "—"})
            </span>
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={hue}
              onChange={(e) => {
                setHasColor(true);
                setHue(parseInt(e.target.value, 10));
              }}
              style={{
                width: "100%",
                height: 6,
                borderRadius: 3,
                cursor: "pointer",
                accentColor: hasColor ? folderColorCss(hue) : "var(--accent)",
                background: "var(--line)",
              }}
            />
          </label>
        </div>

        {/* Preset Swatches */}
        <div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: 6, fontWeight: 600 }}>
            {t("ctx.color_presets")}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {FOLDER_PRESET_HUES.map((pHue) => {
              const isSelected = hasColor && hue === pHue;
              return (
                <button
                  key={pHue}
                  type="button"
                  title={`Hue ${pHue}°`}
                  onClick={() => {
                    setHasColor(true);
                    setHue(pHue);
                  }}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "var(--radius-sm)",
                    border: isSelected ? "2px solid var(--accent)" : "1px solid var(--divider)",
                    background: folderColorCss(pHue),
                    cursor: "pointer",
                    outline: isSelected ? "1px solid var(--accent)" : "none",
                    outlineOffset: 1,
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* Recently Used Swatches */}
        {recentColorHues.length > 0 && (
          <div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: 6, fontWeight: 600 }}>
              {t("ctx.color_recents")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {recentColorHues.slice(0, 6).map((rHue) => {
                const isSelected = hasColor && hue === rHue;
                return (
                  <button
                    key={rHue}
                    type="button"
                    title={`Hue ${rHue}°`}
                    onClick={() => {
                      setHasColor(true);
                      setHue(rHue);
                    }}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "var(--radius-sm)",
                      border: isSelected ? "2px solid var(--accent)" : "1px solid var(--divider)",
                      background: folderColorCss(rHue),
                      cursor: "pointer",
                      outline: isSelected ? "1px solid var(--accent)" : "none",
                      outlineOffset: 1,
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Buttons footer */}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", marginTop: 6 }}>
          <button
            type="button"
            onClick={() => setHasColor(false)}
            className="btn"
            disabled={!hasColor}
          >
            {t("ctx.folder_color_reset")}
          </button>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onCancel} className="btn">
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="btn btn-primary"
            >
              {t("common.apply")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
