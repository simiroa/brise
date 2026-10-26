/**
 * Right-click-on-map context menu — shared by HomeMapPane (dashboard) and RegionExpanded
 * (sidebar). One item: "새 노트" + a best-effort reverse-geocoded address underneath (loading
 * while in flight, coords if it fails). Clicking hands off to the same click-to-create popover
 * path both hosts already use (useMapNoteActions.dropCreatePin) — no separate create flow.
 *
 * 껍데기는 ContextMenuShell 이 갖는다(2026-09-10) — 전에는 백드롭·위치·팝오버 스타일을 손으로
 * 짰고, 그 사본에는 Escape 가 아예 없었다. 쉘로 옮기면서 Escape·유동 hover 가 딸려 온다.
 */
import { useEffect, useState } from "react";
import { call } from "../../lib/invoke";
import { t } from "../../i18n/t";
import { IconPlus } from "../icons";
import { ContextMenuShell } from "../common/ContextMenuShell";

export interface MapContextMenuState {
  lat: number;
  lng: number;
  x: number;
  y: number;
}

interface MapContextMenuProps {
  state: MapContextMenuState | null;
  uiLang: string;
  onClose: () => void;
  /** Hand off to the host's dropCreatePin(lat, lng, clientX, clientY, label). */
  onCreateHere: (lat: number, lng: number, clientX: number, clientY: number, label: string | null) => void;
}

export function MapContextMenu({ state, uiLang, onClose, onCreateHere }: MapContextMenuProps) {
  const [label, setLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = state ? `${state.lat},${state.lng}` : null;

  useEffect(() => {
    if (!state) return;
    setLabel(null);
    setLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const rev = await call<{ label: string | null }>("geocode_reverse", {
          lat: state.lat,
          lng: state.lng,
          lang: uiLang || "ko",
        });
        if (!cancelled) setLabel(rev.label);
      } catch {
        /* coords fallback below */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, uiLang]);

  if (!state) return null;

  const subtitle = loading
    ? t("common.loading")
    : label?.trim() || `${state.lat.toFixed(4)}, ${state.lng.toFixed(4)}`;

  return (
    <ContextMenuShell anchor={state} onClose={onClose} testId="map-context-menu" minWidth={180}>
      <button
        type="button"
        className="menu-row menu-item"
        data-testid="map-context-menu-create-here"
        onClick={() => {
          const { lat, lng, x, y } = state;
          onClose();
          onCreateHere(lat, lng, x, y, label);
        }}
        style={{
          color: "inherit",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <IconPlus size={15} strokeWidth={1.8} style={{ marginTop: "var(--space-2xs)", flex: "none" }} />
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
          <span>{t("search.add_note_at_place")}</span>
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--muted)",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </span>
        </span>
      </button>
    </ContextMenuShell>
  );
}
