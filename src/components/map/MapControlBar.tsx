import { t } from "../../i18n/t";
import { IconHome, IconLock, IconUnlock } from "../icons";

export interface MapControlBarProps {
  isLocked: boolean;
  onToggleLock: () => void;
  onGoHome: () => void;
}

export function MapControlBar({ isLocked, onToggleLock, onGoHome }: MapControlBarProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: "var(--space-3)",
        right: "var(--space-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        zIndex: "var(--z-overlay)",
      }}
    >
      <button
        type="button"
        onClick={onToggleLock}
        title={isLocked ? t("settings.map_unlock") : t("settings.map_lock")}
        aria-label={isLocked ? t("settings.map_unlock") : t("settings.map_lock")}
        className="icon-btn icon-btn--sm icon-btn--glow"
        data-active={isLocked ? "true" : undefined}
        aria-pressed={isLocked}
        style={{
          border: "none",
          background: "transparent",
          boxShadow: "none",
        }}
      >
        {isLocked ? (
          <IconLock size={13} strokeWidth={2} />
        ) : (
          <IconUnlock size={13} strokeWidth={2} />
        )}
      </button>

      <button
        type="button"
        onClick={onGoHome}
        title={t("settings.map_home")}
        aria-label={t("settings.map_home")}
        className="icon-btn icon-btn--sm icon-btn--glow"
        style={{
          border: "none",
          background: "transparent",
          boxShadow: "none",
        }}
      >
        <IconHome size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
