import { useState } from "react";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { CurrentPositionError, type CurrentPositionErrorCode } from "../lib/currentPosition";
import { useCurrentLocationApply } from "./useCurrentLocationApply";
import { useGeocodeSearch, type GeocodeResultItem } from "../lib/useGeocodeSearch";

// 리터럴 키로 둔다(동적 조립은 check:i18n 이 미사용으로 본다).
function locErrorText(code: CurrentPositionErrorCode): string {
  switch (code) {
    case "no_permission": return t("mobileLoc.err_no_permission");
    case "no_provider": return t("mobileLoc.err_no_provider");
    case "timeout": return t("mobileLoc.err_timeout");
    case "security": return t("mobileLoc.err_security");
    default: return t("mobileLoc.err_unavailable");
  }
}

interface MobileRegionSheetProps {
  region: string | null;
  /** Geocode search language (desktop's RegionPickerFields uses the same settings-store uiLang). */
  uiLang: string;
  setRegion: (region: string | null) => void;
  setLocation: (lat: number | null, lng: number | null) => void;
  onClose: () => void;
}

/**
 * 지역 선택 시트 — A-3: MobileNoteBadges에서 분리(모바일 관례: 시트 1개 = 파일 1개, cf.
 * MobileAiSheet). 조건부로만 마운트되므로(부모의 {regionSheetOpen && <.../>}) 검색어/결과는 열 때
 * 마다 자동으로 빈 상태에서 시작한다 — 예전의 수동 closeRegionSheet() 리셋과 동치.
 *
 * 지오코딩 검색은 useGeocodeSearch 공유 훅(A-1) — stale 가드 포함, RegionPickerDialog/
 * MapPlaceSearch와 동일 동작.
 */
export function MobileRegionSheet({ region, uiLang, setRegion, setLocation, onClose }: MobileRegionSheetProps) {
  const [regionQuery, setRegionQuery] = useState("");
  const {
    results: regionResults,
    searching: regionSearching,
    unavailable: regionUnavailable,
  } = useGeocodeSearch(regionQuery, uiLang);

  const { locate, busy: locating } = useCurrentLocationApply(uiLang);
  const [locError, setLocError] = useState<string | null>(null);

  const useHere = async () => {
    setLocError(null);
    try {
      const r = await locate();
      void setRegion(r.region);
      void setLocation(r.lat, r.lng);
      onClose();
    } catch (e) {
      setLocError(locErrorText(e instanceof CurrentPositionError ? e.code : "unavailable"));
    }
  };

  const pickRegionResult = (item: GeocodeResultItem) => {
    void setRegion(item.label.split(",")[0].trim());
    void setLocation(item.lat, item.lng);
    onClose();
  };

  const clearRegion = () => {
    void setRegion(null);
    void setLocation(null, null);
    onClose();
  };

  return (
    <MobileModal
      title={t("note.region_select_title")}
      onClose={onClose}
      placement="bottom"
      footer={
        <>
          <button
            type="button"
            className="mobile-text-btn mobile-modal-footer-lead"
            onClick={clearRegion}
            disabled={!region}
          >
            {t("note.clear_location")}
          </button>
          <button type="button" className="mobile-text-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </>
      }
    >
      <button type="button" className="menu-row mobile-ai-action" onClick={() => void useHere()} disabled={locating}>
        {locating ? t("mobileLoc.locating") : t("mobileLoc.current_location")}
      </button>
      {locError && <div className="mobile-ai-disabled-hint">{locError}</div>}
      <input
        autoFocus
        className="mobile-preset-ai-input"
        value={regionQuery}
        onChange={(e) => setRegionQuery(e.target.value)}
        placeholder={t("note.address_search_placeholder")}
      />
      <div className="mobile-ai-actions mobile-modal-options">
        {regionSearching && <div className="mobile-ai-disabled-hint">{t("mobile.ai_pending")}</div>}
        {regionUnavailable && <div className="mobile-ai-disabled-hint">{t("note.search_unavailable")}</div>}
        {!regionSearching &&
          regionResults.map((item, idx) => (
            <button key={idx} type="button" className="menu-row mobile-ai-action" onClick={() => pickRegionResult(item)}>
              {item.label}
            </button>
          ))}
      </div>
    </MobileModal>
  );
}
