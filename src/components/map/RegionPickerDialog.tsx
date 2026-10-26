import { useState, useEffect, useRef } from 'react';
import { ModalShell } from '../ModalShell';
import { IconAction } from '../settings/IconAction';
import { IconEraser, IconHome } from '../icons';
import { WorldMapAuto, MapMarker, type MapLocation } from './WorldMapAuto';
import { call } from '../../lib/invoke';
import { t } from '../../i18n/t';
import { useSettingsStore } from '../../stores/settings';
import { useGeocodeSearch, type GeocodeResultItem } from '../../lib/useGeocodeSearch';
import { PICK_FLYTO_ZOOM } from './mapZoomScale';

export interface RegionPickerFieldsProps {
  initialRegion: string | null;
  initialLat: number | null;
  initialLng: number | null;
  onCancel: () => void;
  onSubmit: (region: string | null, lat: number | null, lng: number | null) => void;
  /** Onboarding wizard (2026-07-29 redesign): the wizard's own shared nav row owns Back/Next for
   * every step, so this component's built-in Cancel/Apply footer would be a redundant second
   * "advance" action there (and was the actual cause of the wizard's lone "Back" button floating
   * misaligned — this component's footer + the wizard's own made two footers). Default false keeps
   * RegionPickerDialog's standalone modal usage exactly as before. */
  hideFooter?: boolean;
  /** Fires on every draft change (search pick / map click / clear) so a caller that hides the
   * footer (no Apply button to read final values from) can still track the live draft and commit
   * it itself via its own Next button. */
  onLocationChange?: (region: string | null, lat: number | null, lng: number | null) => void;
  /** Settings-only: when set, a Reset button appears next to Clear at the bottom of the right
   * column (hideFooter mode only — MapSection wires this to restore the default location).
   * Other hideFooter callers (onboarding) omit it and only get the Clear button. */
  onReset?: () => void;
  /** Live camera reports from the preview map (WorldMap.onViewChange passthrough) — MapSection
   * uses this to capture the zoom the user actually sees, so "저장된 홈 = 미리보기에 보이던 뷰"
   * (owner QA 2026-08-10; previously zoom was never exposed and stayed pinned at the stored
   * value). */
  onViewChange?: (v: MapLocation) => void;
  /** Settings 640px column: map on top, fields below. Default is the 6:4 row. */
  stacked?: boolean;
}

// Extracted from RegionPickerDialog so the onboarding wizard can embed the same fields inside its
// own modal chrome without a nested ModalShell. Holds all state/logic/JSX; RegionPickerDialog is
// now a thin ModalShell wrapper around this.
export function RegionPickerFields({
  initialRegion,
  initialLat,
  initialLng,
  onCancel,
  onSubmit,
  hideFooter = false,
  onLocationChange,
  onReset,
  onViewChange,
  stacked = false,
}: RegionPickerFieldsProps) {
  const [regionText, setRegionText] = useState(initialRegion ?? '');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLocation, setSelectedLocation] = useState<{ lat: number; lng: number } | null>(
    initialLat !== null && initialLng !== null ? { lat: initialLat, lng: initialLng } : null
  );
  const uiLang = useSettingsStore((s) => s.uiLang);
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  // 미리보기 카메라는 저장 홈이 아니라 "지금 보고 있는 핀"을 따라간다. 초기엔 핀을 도시 스케일
  // 이상으로 확대해 열고(저장 줌이 이미 더 가까우면 그걸 존중), 검색 픽마다 새 객체를 시드해
  // WorldMap 이 그 지점으로 fly-to 한다 (defaultLocation 레퍼런스 변경 = fly-to 의도, WorldMap
  // seed 주석 참고). 지도 클릭은 이미 보이는 지점이므로 카메라를 움직이지 않는다.
  const [cameraSeed, setCameraSeed] = useState<MapLocation>(() =>
    selectedLocation
      ? { ...selectedLocation, zoom: Math.max(defaultMapLocation.zoom, PICK_FLYTO_ZOOM) }
      : defaultMapLocation
  );

  // Debounced geocode search (~1.1s debounce for ~1 req/sec policy) — A-1: shared with
  // MapPlaceSearch/MobileNoteBadges via useGeocodeSearch (now also stale-guarded here).
  const { results: searchResults, searching, unavailable: searchUnavailable } = useGeocodeSearch(searchQuery, uiLang);

  // Reverse-geocode label when the pin moves. Failures must not leave a stale place name from a
  // previous pin (silent catch used to keep the old label while coords already changed).
  const [reverseUnavailable, setReverseUnavailable] = useState(false);

  useEffect(() => {
    if (!selectedLocation) {
      setReverseUnavailable(false);
      return;
    }
    let isCancelled = false;
    setReverseUnavailable(false);
    void (async () => {
      try {
        const rev = await call<{ label: string | null }>('geocode_reverse', {
          lat: selectedLocation.lat,
          lng: selectedLocation.lng,
          lang: uiLang || 'ko',
        });
        if (isCancelled) return;
        if (rev.label) {
          setRegionText(rev.label);
          setReverseUnavailable(false);
        }
        // null label: keep any label already set by a search pick; do not invent one.
      } catch {
        if (isCancelled) return;
        // Explicit clear — do not keep a previous pin's name for these coordinates.
        setRegionText('');
        setReverseUnavailable(true);
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, [selectedLocation, uiLang]);

  // Onboarding's hideFooter path has no Apply button to read final values from — push every
  // draft change up so the wizard's own shared Next button can commit the latest state. The
  // callback is read through a ref (not a dep) — the wizard passes an inline arrow that gets a
  // new identity every render, and putting it in the dep array would fire this effect ->
  // setState upstream -> new arrow -> fire again, an infinite loop. A ref keeps this effect keyed
  // only on the actual draft values (regionText/selectedLocation), safe for any caller regardless
  // of whether it memoizes.
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  useEffect(() => {
    onLocationChangeRef.current?.(
      regionText.trim() ? regionText.trim() : null,
      selectedLocation ? selectedLocation.lat : null,
      selectedLocation ? selectedLocation.lng : null
    );
  }, [regionText, selectedLocation]);

  const handlePickResult = (item: GeocodeResultItem) => {
    setSelectedLocation({ lat: item.lat, lng: item.lng });
    setRegionText(item.label.split(',')[0].trim());
    // Fly the preview to the picked place — without this the camera stayed on the old view and a
    // far-away pick landed the pin off-screen with zero feedback.
    setCameraSeed({ lat: item.lat, lng: item.lng, zoom: PICK_FLYTO_ZOOM });
  };

  const handleMapClick = (lat: number, lng: number) => {
    setSelectedLocation({ lat, lng });
  };

  const handleClearLocation = () => {
    setSelectedLocation(null);
    setRegionText('');
  };

  const handleSave = () => {
    const finalRegion = regionText.trim() ? regionText.trim() : null;
    const finalLat = selectedLocation ? selectedLocation.lat : null;
    const finalLng = selectedLocation ? selectedLocation.lng : null;
    onSubmit(finalRegion, finalLat, finalLng);
  };

  const markers: MapMarker[] = selectedLocation
    ? [{ id: 'selected', lat: selectedLocation.lat, lng: selectedLocation.lng, active: true }]
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 6:4 two-column layout — map (left, ~60%) + region/search/actions stack (right, ~40%).
          Percentage flex-basis (not fixed px) so this fills whatever card width it's given;
          WorldMap self-sizes to its container via ResizeObserver, so it doesn't need an explicit
          width/height prop here. */}
      <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', gap: 12, alignItems: 'stretch' }}>
        {/* Map */}
        <div style={{ position: 'relative', flex: stacked ? 'none' : '6 6 0%', minWidth: 0, height: 240 }}>
          <WorldMapAuto
            markers={markers}
            onMapClick={handleMapClick}
            defaultLocation={cameraSeed}
            onViewChange={onViewChange}
            uiLang={uiLang}
          />
          {/* 지도 위에 뜨는 라벨 = floating 표면 → 배경은 .overlay 클래스가 소유한다 */}
          {selectedLocation && (
            <div
              className="overlay"
              style={{
                position: 'absolute',
                bottom: 8,
                left: 8,
                padding: '4px 8px',
                fontSize: 'var(--text-xs)',
                color: 'var(--text)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              {selectedLocation.lat.toFixed(4)}, {selectedLocation.lng.toFixed(4)}
            </div>
          )}
        </div>

        {/* Right column: region readout, search, results, then (hideFooter only) reset/clear */}
        <div style={{ flex: stacked ? 'none' : '4 4 0%', height: stacked ? 'auto' : 240, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)', fontWeight: 600 }}>
              {t('note.region_label')}
            </label>
            <input
              type="text"
              className="field"
              value={regionText}
              readOnly
              placeholder={t('note.region_placeholder')}
              style={{ opacity: 0.85, cursor: 'default' }}
            />
            {reverseUnavailable && (
              <div
                data-testid="region-reverse-unavailable"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--danger-soft)', padding: 'var(--space-2xs) 0 0' }}
              >
                {t('note.search_unavailable')}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)', fontWeight: 600 }}>
              {t('note.address_search_label')}
            </label>
            <input
              type="text"
              className="field"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('note.address_search_placeholder')}
            />
          </div>

          {/* Geocode search results — fills the rest of the column, scrolls internally */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} className="scroll">
            {searching && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)', padding: '4px 0' }}>
                {t('common.loading')}
              </div>
            )}
            {searchUnavailable && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger-soft)', padding: '4px 0' }}>
                {t('note.search_unavailable')}
              </div>
            )}
            {!searching && searchResults.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  border: '1px solid var(--divider)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 4,
                }}
              >
                {searchResults.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="menu-row menu-item"
                    onClick={() => handlePickResult(item)}
                    style={{
                      padding: '6px 8px',
                      fontSize: 'var(--text-xs)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Reset/Clear group — settings mode (onReset passed) shows both; onboarding
              (hideFooter without onReset) shows Clear only. Apply/Cancel stay in the footer
              below (or the caller's own nav row) — never duplicated here. */}
          {hideFooter && (
            // flexWrap: the ~40% column is ~190px in the settings card (560px modal) — "Reset" +
            // "Clear coordinates" fits in en but not fr ("Réinitialiser" + "Effacer les
            // coordonnées"); wrap to a second row rather than overflow the card.
            // 설정·온보딩에서 보이는 이 묶음은 아이콘 버튼(PLAN-2026-09-19-settings-icon-actions §2) —
            // 이름은 aria-label=title 로만 있다. 아래 비-hideFooter 바닥(RegionEditor)은 글자 그대로.
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {onReset && (
                <IconAction
                  icon={<IconHome size={16} />}
                  label={t('settings.reset_default_location')}
                  data-testid="region-picker-reset"
                  onClick={onReset}
                />
              )}
              <IconAction
                icon={<IconEraser size={16} />}
                label={t('note.clear_location')}
                data-testid="region-picker-clear"
                onClick={handleClearLocation}
                disabled={!selectedLocation}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer actions — onboarding (hideFooter) drives Apply/Cancel via the wizard's own shared
          nav row instead (see RegionPickerFieldsProps.hideFooter); reset/clear live in the right
          column above for that mode. Non-hideFooter callers (RegionEditor) keep this footer. */}
      {!hideFooter && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
          <button
            type="button"
            onClick={handleClearLocation}
            className="btn"
            disabled={!selectedLocation}
          >
            {t('note.clear_location')}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onCancel} className="btn">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={handleSave} className="btn btn-primary">
              {t('common.apply')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RegionPickerDialog(props: RegionPickerFieldsProps) {
  return (
    <ModalShell title={t('note.region_select_title')} onClose={props.onCancel} width={640}>
      <RegionPickerFields {...props} />
    </ModalShell>
  );
}
