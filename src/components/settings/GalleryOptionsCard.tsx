import { useSettingsStore } from "../../stores/settings";
import { GALLERY_SORTS, GALLERY_TILE_SIZES, type GallerySort, type GalleryTileSize } from "../../stores/prefs";
import { t } from "../../i18n/t";
import { optionsOf } from "./shared";
import { SettingsRow } from "./SettingsRow";
import { SegGroup } from "./SegGroup";
import { Select } from "../Select";
import { Toggle } from "./Toggle";
import { IconImage } from "../icons";
import { SettingsCard } from "./SettingsCard";

const TILE_LABELS: Record<GalleryTileSize, () => string> = {
  small: () => t("settings.gallery_tile_small"),
  medium: () => t("settings.gallery_tile_medium"),
  large: () => t("settings.gallery_tile_large"),
};
const SORT_LABELS: Record<GallerySort, () => string> = {
  newest: () => t("settings.gallery_sort_newest"),
  oldest: () => t("settings.gallery_sort_oldest"),
  name: () => t("settings.gallery_sort_name"),
};

/**
 * 설정 > 첨부파일 > 갤러리 (2026-10-28). 사이드패널 갤러리(GalleryExpanded)가 읽는 세 가지:
 * 타일 크기(열 수 ±1) · 정렬(서버 ORDER BY — 페이지를 넘겨도 순서가 흔들리지 않는다) · 파일 이름 항상 표시.
 * 전부 앱 전역 키다.
 */
export function GalleryOptionsCard() {
  const size = useSettingsStore((s) => s.galleryTileSize);
  const setSize = useSettingsStore((s) => s.setGalleryTileSize);
  const sort = useSettingsStore((s) => s.gallerySort);
  const setSort = useSettingsStore((s) => s.setGallerySort);
  const showNames = useSettingsStore((s) => s.galleryShowNames);
  const setShowNames = useSettingsStore((s) => s.setGalleryShowNames);

  return (
    <SettingsCard title={t("settings.gallery_options")} icon={<IconImage size={14} strokeWidth={2} />} testId="settings-gallery-options">
      <SettingsRow
        anchor="gallery_tile_size"
        label={t("settings.gallery_tile_size")}
        control={
          <SegGroup<GalleryTileSize>
            value={size}
            onChange={(v) => void setSize(v)}
            ariaLabel={t("settings.gallery_tile_size")}
            options={optionsOf(GALLERY_TILE_SIZES, TILE_LABELS)}
          />
        }
      />
      <SettingsRow
        anchor="gallery_sort"
        label={t("settings.gallery_sort")}
        hint={t("settings.gallery_sort_hint")}
        control={
          <Select
            value={sort}
            onChange={(v) => void setSort(v as GallerySort)}
            ariaLabel={t("settings.gallery_sort")}
            options={optionsOf(GALLERY_SORTS, SORT_LABELS)}
          />
        }
      />
      <SettingsRow
        anchor="gallery_show_names"
        label={t("settings.gallery_show_names")}
        hint={t("settings.gallery_show_names_hint")}
        control={
          <Toggle
            checked={showNames}
            onChange={(next) => void setShowNames(next)}
            aria-label={t("settings.gallery_show_names")}
            data-testid="settings-gallery-show-names"
          />
        }
      />
    </SettingsCard>
  );
}
