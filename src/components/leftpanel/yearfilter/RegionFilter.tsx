import { useCallback, useEffect, useState } from "react";
import { useNotesStore } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import { useSettingsStore } from "../../../stores/settings";
import { WorldMapAuto, type MapMarker, type MapViewportBbox } from "../../map/WorldMapAuto";
import { FilterHeaderRow } from "./shared";
import { t } from "../../../i18n/t";
import { IconClose } from "../../icons";
import { noteQuery } from "../../../lib/noteQuery";
import { noteHasCoords } from "../expanded/viewData";
import type { NoteSummary } from "../../../lib/commands.gen";

const MAP_MARKER_LIMIT = 500;

/* ── Year filter: Région ──
   Mini map — markers for the viewport only (Wave A-3 note_query bbox). */
export function RegionFilter() {
  const selectNote = useNotesStore((s) => s.selectNote);
  const activeId = useNotesStore((s) => s.activeNote?.note.id ?? null);

  const regionFilter = useSearchStore((s) => s.regionFilter);
  const setRegionFilter = useSearchStore((s) => s.setRegionFilter);
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);

  const [viewport, setViewport] = useState<MapViewportBbox | null>(null);
  const [located, setLocated] = useState<NoteSummary[]>([]);

  useEffect(() => {
    if (!viewport) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await noteQuery({
          coords: {
            kind: "bbox",
            min_lat: viewport.min_lat,
            max_lat: viewport.max_lat,
            min_lng: viewport.min_lng,
            max_lng: viewport.max_lng,
          },
          sort: "title_asc",
          offset: 0,
          limit: MAP_MARKER_LIMIT,
        });
        if (!cancelled) setLocated(r.notes.filter(noteHasCoords));
      } catch {
        if (!cancelled) setLocated([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewport]);

  const markers: MapMarker[] = located.slice(0, MAP_MARKER_LIMIT).map((n) => ({
    id: n.id,
    lat: n.lat!,
    lng: n.lng!,
    active: n.id === activeId,
    region: n.region,
  }));

  const onViewportChange = useCallback((bbox: MapViewportBbox) => {
    setViewport(bbox);
  }, []);

  return (
    <div style={{ marginTop: "var(--space-2)", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {regionFilter && (
        <FilterHeaderRow style={{ marginBottom: "var(--space-1)" }}>
          <span
            style={{
              fontSize: "var(--text-label)",
              color: "var(--accent)",
              fontWeight: 600,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {regionFilter.kind === "none" ? t("search.region_no_region") : regionFilter.name}
          </span>
          <button
            type="button"
            onClick={() => setRegionFilter(null)}
            className="icon-btn icon-btn--sm"
            title={t("search.region_clear")}
            aria-label={t("search.region_clear")}
          >
            <IconClose size={12} strokeWidth={2.2} />
          </button>
        </FilterHeaderRow>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          border: "1px solid var(--line)",
          position: "relative",
        }}
      >
        <WorldMapAuto
          // This wrapper already owns the radius, border and clip — WorldMap drawing its
          // own frame inside would nest a second rounded border against this one.
          frameless
          markers={markers}
          defaultLocation={defaultMapLocation}
          homeLocation={defaultMapLocation}
          onMarkerClick={(noteId) => void selectNote(noteId)}
          onViewportChange={onViewportChange}
        />
      </div>
    </div>
  );
}
