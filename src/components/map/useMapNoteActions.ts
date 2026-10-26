/**
 * Map → note write actions, shared by the dashboard map (HomeMapPane) and the sidebar map
 * (RegionExpanded). Both hosts render the same `WorldMap`; before this hook each owned a
 * different subset of "what a map may do to a note" and the two panes silently diverged
 * (drag-drop + pin-move only in the sidebar, click-to-create only in the dashboard).
 *
 * Everything here is a **lift** of the implementations that already existed in
 * RegionExpanded/HomeMapPane — same IPC order, same optimistic patch + rollback, same
 * `overwrite` semantics for the region string. No behavior was redesigned on the way over.
 *
 * `refreshRegionFromCoords` is the single place that writes `notes.region` from coordinates:
 * planting coords alone leaves `notes.region` null and the note falls out of the region filter
 * and the region views entirely (they match on the region string, not on lat/lng).
 */
import { useCallback, useState, type RefObject } from "react";
import { call } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { bumpNoteQueryVersion } from "../../lib/noteQuery";
import type { NoteSummary } from "../../lib/commands.gen";
import type { CreatePin } from "../home/MapCreatePopover";

export type { CreatePin };

export interface UseMapNoteActionsOptions {
  /**
   * Element the map fills. `WorldMap.onMapClick` carries no screen coordinates, so the create
   * popover is anchored at this element's center (same approximation HomeMapPane always used).
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Fires with the new note id right after a successful `note_create` + `note_set_location`,
   * **before** the tree reload. HomeMapPane uses it to arm its one-shot fit-to-notes suppression
   * so the viewport does not jump when the new note lands in the marker set.
   */
  onCreated?: (noteId: string) => void;
}

export interface MapNoteActions {
  /**
   * Reverse-geocode lat/lng into `notes.region`. `overwrite: false` leaves an existing region
   * alone (drop / create); `true` replaces it (the pin was deliberately moved elsewhere).
   * `knownLabel` skips the round trip when the caller already has the place name (place search).
   */
  refreshRegionFromCoords: (
    noteId: string,
    lat: number,
    lng: number,
    overwrite: boolean,
    knownLabel?: string | null
  ) => Promise<void>;
  /** Note dragged from the tree onto the map — `WorldMap.onDropNote`. */
  onDropNote: (noteId: string, lat: number, lng: number) => void;
  /** Existing pin dragged to a new spot — `WorldMap.onMarkerMove`. */
  onMarkerMove: (noteId: string, lat: number, lng: number) => void;
  /** Create a note at a point. Never navigates (see the note on app convention below). */
  createNoteAt: (lat: number, lng: number, label?: string | null) => Promise<void>;

  /* ── click-to-create popover (drives MapCreatePopover in both hosts) ── */
  createPin: CreatePin | null;
  creating: boolean;
  /** `WorldMap.onMapClick` handler: temp pin + best-effort reverse-geocoded label. */
  onMapClick: (lat: number, lng: number) => void;
  /** Temp pin at an explicit screen anchor (place-search pick). */
  dropCreatePin: (
    lat: number,
    lng: number,
    clientX: number,
    clientY: number,
    label?: string | null
  ) => void;
  cancelCreate: () => void;
  confirmCreate: () => Promise<void>;
}

export function useMapNoteActions(opts: UseMapNoteActionsOptions = {}): MapNoteActions {
  const { anchorRef, onCreated } = opts;
  const uiLang = useSettingsStore((s) => s.uiLang);
  const patchNoteSummary = useNotesStore((s) => s.patchNoteSummary);
  const selectNote = useNotesStore((s) => s.selectNote);
  const loadTree = useNotesStore((s) => s.loadTree);
  const inboxId = useNotesStore((s) => s.inboxId);
  const ensureInboxId = useNotesStore((s) => s.ensureInboxId);

  const [createPin, setCreatePin] = useState<CreatePin | null>(null);
  const [creating, setCreating] = useState(false);

  const refreshRegionFromCoords = useCallback(
    async (
      noteId: string,
      lat: number,
      lng: number,
      overwrite: boolean,
      knownLabel?: string | null
    ) => {
      const current = useNotesStore.getState().noteIndex.get(noteId);
      if (!overwrite && current?.region) return;
      try {
        const label =
          knownLabel?.trim() ||
          (
            await call<{ label: string | null }>("geocode_reverse", {
              lat,
              lng,
              lang: uiLang || "ko",
            })
          ).label;
        if (label && label !== current?.region) {
          const withRegion = await call<NoteSummary>("note_set_region", {
            id: noteId,
            region: label,
          });
          patchNoteSummary(noteId, withRegion);
        }
      } catch {
        // 좌표만 남는다
      }
    },
    [patchNoteSummary, uiLang]
  );

  const onDropNote = useCallback(
    (noteId: string, lat: number, lng: number) => {
      patchNoteSummary(noteId, { lat, lng });

      void (async () => {
        try {
          const updated = await call<NoteSummary>("note_set_location", {
            id: noteId,
            lat,
            lng,
          });
          patchNoteSummary(noteId, updated);

          await refreshRegionFromCoords(noteId, lat, lng, false);

          const state = useNotesStore.getState();
          if (state.activeNote?.note.id === noteId) {
            void selectNote(noteId);
          }
        } catch {
          // Failure handled by call/toast
        }
      })();
    },
    [patchNoteSummary, selectNote, refreshRegionFromCoords]
  );

  const onMarkerMove = useCallback(
    (noteId: string, lat: number, lng: number) => {
      const prev = useNotesStore.getState().noteIndex.get(noteId);
      const prevLat = prev?.lat ?? null;
      const prevLng = prev?.lng ?? null;
      patchNoteSummary(noteId, { lat, lng });
      void (async () => {
        try {
          const updated = await call<NoteSummary>("note_set_location", { id: noteId, lat, lng });
          patchNoteSummary(noteId, updated);
          await refreshRegionFromCoords(noteId, lat, lng, true);
          const state = useNotesStore.getState();
          if (state.activeNote?.note.id === noteId) void selectNote(noteId);
        } catch {
          patchNoteSummary(noteId, { lat: prevLat, lng: prevLng });
        }
      })();
    },
    [patchNoteSummary, refreshRegionFromCoords, selectNote]
  );

  const createNoteAt = useCallback(
    async (lat: number, lng: number, label?: string | null) => {
      const folderId = inboxId ?? (await ensureInboxId());
      // Title omitted on purpose → backend default, same as CalendarTab/TimelineTab's create.
      // Also deliberately does NOT open the note: pinning several places in a row should not
      // bounce the user into the editor after each one (same call TimelineTab made).
      const created = await call<{ note: NoteSummary }>("note_create", { folder_id: folderId });
      await call("note_set_location", { id: created.note.id, lat, lng });
      onCreated?.(created.note.id);
      // loadTree() first so the note is in noteIndex before refreshRegionFromCoords reads it
      // (and it is what bumps the note-query version for every mounted view).
      await loadTree();
      await refreshRegionFromCoords(created.note.id, lat, lng, false, label);
      // Explicit, not relying on loadTree's own bump: the map's marker query is bbox-scoped and
      // must repaint with the new pin even if nothing else about the tree changed.
      bumpNoteQueryVersion();
    },
    [inboxId, ensureInboxId, loadTree, refreshRegionFromCoords, onCreated]
  );

  // Drops the temp pin in place without touching the viewport — the point just clicked (or
  // picked from search) is already what the user is looking at; re-centering/re-zooming here
  // was the cause of the map "jumping" the instant a create interaction started.
  const dropCreatePin = useCallback(
    (lat: number, lng: number, clientX: number, clientY: number, label?: string | null) => {
      setCreatePin({ lat, lng, clientX, clientY, label: label ?? null });
    },
    []
  );

  // Empty map click → temp pin + create popover.
  // WorldMap already suppresses clicks after drag (hasMoved) and when locked.
  // MarkerLayer stopPropagates marker clicks so they never reach this handler.
  const onMapClick = useCallback(
    (lat: number, lng: number) => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      const clientX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const clientY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      dropCreatePin(lat, lng, clientX, clientY, null);
      // Best-effort reverse geocode for the popover label (non-blocking).
      void (async () => {
        try {
          const rev = await call<{ label: string | null }>("geocode_reverse", {
            lat,
            lng,
            lang: uiLang || "ko",
          });
          setCreatePin((cur) =>
            cur && cur.lat === lat && cur.lng === lng ? { ...cur, label: rev.label } : cur
          );
        } catch {
          /* label stays coords */
        }
      })();
    },
    [anchorRef, dropCreatePin, uiLang]
  );

  const cancelCreate = useCallback(() => {
    setCreatePin(null);
    setCreating(false);
  }, []);

  const confirmCreate = useCallback(async () => {
    if (!createPin || creating) return;
    setCreating(true);
    try {
      await createNoteAt(createPin.lat, createPin.lng, createPin.label);
      setCreatePin(null);
    } catch {
      /* call() already surfaced the failure — leave the pin so the user can retry */
    } finally {
      setCreating(false);
    }
  }, [createPin, creating, createNoteAt]);

  return {
    refreshRegionFromCoords,
    onDropNote,
    onMarkerMove,
    createNoteAt,
    createPin,
    creating,
    onMapClick,
    dropCreatePin,
    cancelCreate,
    confirmCreate,
  };
}
