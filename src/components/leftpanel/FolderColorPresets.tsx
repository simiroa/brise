import { folderColorCss, FOLDER_PRESET_HUES } from "../../lib/ui";
import { t } from "../../i18n/t";

/**
 * 폴더 색 프리셋 한 줄.
 *
 * 예전에는 이 파일이 `FolderColorControl` — 트리 폴더 글리프를 눌러 뜨는 색 전용 팝오버 — 도
 * 함께 들고 있었다. 색·아이콘·규칙·검색/AI 제외가 전부 폴더 설정 모달(폴더 우클릭)로 모인 뒤로
 * 글리프 팝오버는 "색만 바꿀 수 있는 두 번째 관문"이 되어 지웠다. 이제 트리 글리프는 순수
 * 표시이고(클릭은 폴더 열기/닫기), 이 프리셋 줄은 아직 모달이 없는 **폴더 생성 다이얼로그**만
 * 쓴다. value = 현재 hue(null = 커스텀 색 없음).
 */
export function FolderColorPresets({
  value,
  onPick,
}: {
  value: number | null;
  onPick: (hue: number | null) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t("ctx.color_presets")}
      style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}
    >
      <button
        type="button"
        className="icon-swatch"
        data-active={value == null}
        aria-pressed={value == null}
        title={t("ctx.folder_color_reset")}
        aria-label={t("ctx.folder_color_reset")}
        style={{ minHeight: 26, width: 26, flex: "none" }}
        onClick={() => onPick(null)}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: "1.5px solid var(--faint)",
            boxSizing: "border-box",
          }}
        />
      </button>
      {FOLDER_PRESET_HUES.map((hue) => (
        <button
          key={hue}
          type="button"
          className="icon-swatch"
          data-active={value === hue}
          aria-pressed={value === hue}
          title={`${hue}°`}
          aria-label={`${hue}°`}
          style={{ minHeight: 26, width: 26, flex: "none" }}
          onClick={() => onPick(hue)}
        >
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: folderColorCss(hue),
            }}
          />
        </button>
      ))}
    </div>
  );
}
