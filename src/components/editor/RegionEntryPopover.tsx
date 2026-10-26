/**
 * PLAN-2026-09-18-nl-dates.md §W6 — the "/지역" slash command's search-and-pick popover. Subscribes
 * to lib/regionEntryBridge.ts (siblings mounted separately in EditorPanel have no prop path — same
 * reasoning as DateEntryPopover's own header comment). Search input, keyboard navigation and result
 * rows come from attachments/PlaceSearch.tsx (shared with NoteRegionsList — W4), the label→name
 * split and duplicate check from lib/placeLabel.ts, and the primary-place write (with rollback)
 * from lib/placeCommit.ts. Lighter chrome than NoteRegionsList (no history panel, no map escape
 * hatch — this is a slash-triggered quick-pick).
 *
 * Two write paths, mirroring NoteRegionsList.tsx's addFirstPlace/addWaypoint split:
 *  - No representative region yet (`activeNote.note.region` empty) → the picked place becomes the
 *    primary, via writePrimaryPlace (the notes store's own setRegion/setLocation: draft-safe,
 *    content-lock-guarded, optimistic-with-rollback — reusing these keeps every other region-aware
 *    UI, e.g. the title bar region badge, in sync for free instead of hand-patching activeNote here).
 *    Only THIS branch gets those guarantees, from patchActiveNote.
 *  - Already has one → the picked place becomes an ordered waypoint via a raw note_region_add call
 *    (same as NoteRegionsList.addWaypoint — no content-lock/draft guard of its own), positioned
 *    after the current last waypoint (nextWaypointPosition — the same rule note_region_add's other
 *    two call sites already use, so ordering never disagrees across entry points).
 */
import { useEffect, useState } from "react";
import { subscribeRegionEntry, type RegionEntryPayload } from "../../lib/regionEntryBridge";
import { getActiveEditor } from "../../lib/aiSectionBridge";
import { useMenuPos } from "../../lib/ui";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import type { GeocodeResultItem } from "../../lib/useGeocodeSearch";
import { call, callSilent } from "../../lib/invoke";
import { splitPlaceLabel, findDuplicatePlace, DUPLICATE_PLACE_RADIUS_M } from "../../lib/placeLabel";
import { writePrimaryPlace } from "../../lib/placeCommit";
import { nextWaypointPosition } from "../attachments/regionDisplay";
import { usePlaceSearch, PlaceSearchResults } from "../attachments/PlaceSearch";
import { t } from "../../i18n/t";

export function RegionEntryPopover({ noteId }: { noteId: string }) {
  const [payload, setPayload] = useState<RegionEntryPayload | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [dupNotice, setDupNotice] = useState<string | null>(null);
  const uiLang = useSettingsStore((s) => s.uiLang);

  useEffect(
    () =>
      subscribeRegionEntry((p) => {
        setPayload(p);
        setQuery(p.query?.trim() || "");
        setBusy(false);
        setDupNotice(null);
      }),
    [],
  );

  const { ref, x, y } = useMenuPos(payload ? { x: payload.anchorX, y: payload.anchorY } : null);

  // 번역/링크/날짜 팝오버와 같은 관용구 — 메인 선택 메뉴처럼 overlayStack 체인에 올라가 있지
  // 않으니 직접 Escape 를 듣는다.
  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPayload(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload]);

  // "/지역" 트리거 텍스트 자리를 고른 지역의 라벨로 평문 치환(D6과 같은 정신, DateEntryPopover의
  // replaceRangeOnSave:true 경로와 동일한 tr.insertText 관용구 — 여기는 마크가 없으니 addMark 는
  // 없다).
  const replaceTriggerText = (label: string) => {
    if (!payload) return;
    const editor = getActiveEditor();
    if (!editor) return;
    const { from, to } = payload.range;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const start = Math.min(from, tr.doc.content.size);
        const end = Math.min(to, tr.doc.content.size);
        tr.insertText(label, start, end);
        return true;
      })
      .run();
  };

  const handlePick = async (item: GeocodeResultItem) => {
    if (busy || !payload) return;
    setBusy(true);
    setDupNotice(null);
    const targetNoteId = payload.noteId ?? noteId;
    const name = splitPlaceLabel(item.label).name || item.label;
    const activeNote = useNotesStore.getState().activeNote;
    const hasPrimary = !!activeNote?.note.region;
    try {
      if (!hasPrimary) {
        // writePrimaryPlace (lib/placeCommit.ts) awaits setRegion then setLocation in order and rolls
        // the name back if the coordinates don't land. The store setters swallow a call() failure
        // (patchActiveNote rolls back + sets savedState "failed"; call() already toasted), so a
        // false return means nothing was written — bail without touching the body or closing.
        if (!(await writePrimaryPlace({ region: name, lat: item.lat, lng: item.lng }))) return;
      } else {
        // Same ordering rule as NoteRegionsList's addWaypoint / the map-click-add path — a fresh
        // note_regions_list read right before add keeps position assignment consistent even if
        // this popover doesn't otherwise track a live waypoint list.
        const listRes = await call<{ regions: { name?: string; lat: number; lng: number; position: number }[] }>(
          "note_regions_list",
          { note_id: targetNoteId },
        );
        const regions = listRes?.regions ?? [];
        // 같은 장소 가드(약 50m) — 대표 + 기존 경유지와 겹치면 추가하지 않고 안내만 띄운다.
        const dup = findDuplicatePlace(item.lat, item.lng, [
          { name: activeNote?.note.region ?? "", lat: activeNote?.note.lat ?? null, lng: activeNote?.note.lng ?? null },
          ...regions.map((r) => ({ name: r.name ?? "", lat: r.lat, lng: r.lng })),
        ]);
        if (dup) {
          setDupNotice(t("region.duplicate_place", { name: dup.name || name, m: DUPLICATE_PLACE_RADIUS_M }));
          return;
        }
        await call("note_region_add", {
          note_id: targetNoteId,
          name,
          lat: item.lat,
          lng: item.lng,
          position: nextWaypointPosition(regions),
        });
        useNotesStore.getState().bumpAttachmentRevision();
      }
      replaceTriggerText(name);
      setPayload(null);
    } catch {
      // silent-ok: note_region_add's call() already toasted — keep the popover open so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  // 결과 행을 "등록됨"으로 막으려면 열려 있는 동안 기존 장소를 알아야 한다(대표는 스토어, 경유지는 한 번 읽기).
  const primaryNow = useNotesStore.getState().activeNote?.note; // 렌더마다 읽는다(구독 불필요 — 선택 시점 가드가 최종)
  const [knownRegions, setKnownRegions] = useState<{ name: string; lat: number; lng: number }[]>([]);
  // 대표가 없으면 경유지도 없다 — 읽을 필요 없다.
  const regionsNoteId = payload && primaryNow?.region ? (payload.noteId ?? noteId) : null;
  useEffect(() => {
    if (!regionsNoteId) {
      setKnownRegions([]);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const r = await callSilent<{ regions: { name?: string; lat: number; lng: number }[] }>("note_regions_list", {
          note_id: regionsNoteId,
        });
        if (live) setKnownRegions((r?.regions ?? []).map((x) => ({ name: x.name ?? "", lat: x.lat, lng: x.lng })));
      } catch {
        // silent-ok: callSilent 가 이미 로그 — 못 읽으면 선택 시점 가드(handlePick)가 막는다
        if (live) setKnownRegions([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [regionsNoteId]);

  // 훅은 아래 `if (!payload) return null` 보다 위에 — 검색은 팝오버가 열려 있을 때만 돈다(query "").
  const placeSearch = usePlaceSearch({
    query: payload ? query : "",
    uiLang,
    onPick: (item) => void handlePick(item),
    disabled: busy,
    isRegistered: (item) =>
      findDuplicatePlace(item.lat, item.lng, [
        { name: "", lat: primaryNow?.lat ?? null, lng: primaryNow?.lng ?? null },
        ...knownRegions,
      ]) != null,
  });

  if (!payload) return null;

  return (
    <>
      <div
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPayload(null)}
        style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
      />
      <div
        ref={ref}
        className="overlay"
        role="dialog"
        aria-label={t("region.entry_popover_label")}
        data-editor-pop=""
        data-testid="region-entry-popover"
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          zIndex: "var(--z-modal)",
          width: 296,
          maxWidth: "calc(100vw - 32px)",
          border: "1px solid var(--divider)",
          boxShadow: "var(--shadow-lg)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-3)",
          left: x,
          top: y,
        }}
      >
        {/* 입력은 NoteRegionsList 검색창과 같은 차분한 모양(바깥 상자가 테두리, 입력은 field--seamless). */}
        <div
          style={{
            border: "1px solid var(--divider)",
            borderRadius: "var(--radius-sm)",
            padding: "0 var(--space-2)",
          }}
        >
          <input
            type="text"
            autoFocus
            data-testid="region-entry-search-input"
            className="field field--seamless"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setDupNotice(null);
            }}
            placeholder={t("note.address_search_placeholder")}
            aria-label={t("note.address_search_placeholder")}
            {...placeSearch.inputProps}
            style={{
              width: "100%",
              boxSizing: "border-box",
              height: "var(--ctrl-h-sm)",
              minHeight: "var(--ctrl-h-sm)",
              padding: 0,
              fontSize: "var(--text-sm)",
            }}
          />
        </div>
        <div style={{ marginTop: "var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-2xs)" }}>
          <PlaceSearchResults binding={placeSearch} query={query} testIdPrefix="region-entry-result" maxHeight={220} />
          {dupNotice && (
            <div
              role="status"
              data-testid="region-entry-duplicate-notice"
              style={{ fontSize: "var(--text-xs)", color: "var(--muted)", padding: "var(--space-2) var(--space-3)" }}
            >
              {dupNotice}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
