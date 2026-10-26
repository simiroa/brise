import { useEffect, useState } from "react";
import {
  usePresetsStore,
  DAILY_PRESET_BODY_MD,
  TRAVEL_PRESET_BODY_MD,
  RETRO_PRESET_BODY_MD,
  type CustomPreset,
} from "../stores/presets";
import { t } from "../i18n/t";
import { MobileCaptureMoreSheet } from "./MobileCaptureMoreSheet";

const PROSE_BUILTINS: { id: "daily" | "travel" | "retro"; nameKey: string; bodyMd: string }[] = [
  { id: "daily", nameKey: "presets.daily_name", bodyMd: DAILY_PRESET_BODY_MD },
  { id: "travel", nameKey: "presets.travel_name", bodyMd: TRAVEL_PRESET_BODY_MD },
  { id: "retro", nameKey: "presets.retro_name", bodyMd: RETRO_PRESET_BODY_MD },
];

export interface MobileCapturePresetsProps {
  customPresets?: CustomPreset[];
  todoBodyMd: string;
  aiReady: boolean;
  onApply: (req: { title: string | null; bodyMd: string }) => void;
  onGenerateAi: (topic: string) => Promise<string | null>;
}

/**
 * Builtin capture chips — ONE horizontal row, rendered inside the dock's tool slot (MobileDockSlot) while the
 * capture is empty (owner 2026-10-07; it used to be a wrapping 2-row block above the action bar). The slot
 * scrolls it sideways, so nothing here wraps or sizes itself. Taps never take the editor's focus: the dock root
 * (MobileNoteActionBar) prevents mousedown for everything inside it — except the More sheet below, which is a
 * portal and has real text fields (keepEditorFocus checks DOM containment for exactly that reason).
 * Overflow (custom presets, AI-start, rename/delete) is MobileCaptureMoreSheet.
 */
export function MobileCapturePresets({
  customPresets: propCustomPresets,
  todoBodyMd,
  aiReady,
  onApply,
  onGenerateAi,
}: MobileCapturePresetsProps) {
  const storeCustomPresets = usePresetsStore((s) => s.customPresets);
  const hiddenBuiltinIds = usePresetsStore((s) => s.hiddenBuiltinIds);
  const loaded = usePresetsStore((s) => s.loaded);
  const load = usePresetsStore((s) => s.load);
  const renamePreset = usePresetsStore((s) => s.rename);
  const removePreset = usePresetsStore((s) => s.remove);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const customPresets = propCustomPresets ?? storeCustomPresets;
  const hidden = new Set(hiddenBuiltinIds);
  const visibleProseBuiltins = PROSE_BUILTINS.filter((p) => !hidden.has(p.id));
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="mobile-preset-row" role="group" aria-label={t("presets.builtin_section")}>
      {!hidden.has("todo") && (
        <button
          type="button"
          className="mobile-filter-pill"
          onClick={() => onApply({ title: null, bodyMd: todoBodyMd })}
        >
          {t("presets.todo_name")}
        </button>
      )}
      {visibleProseBuiltins.map((p) => (
        <button
          key={p.id}
          type="button"
          className="mobile-filter-pill"
          onClick={() => onApply({ title: null, bodyMd: p.bodyMd })}
        >
          {t(p.nameKey)}
        </button>
      ))}
      <button
        type="button"
        className="mobile-filter-pill"
        data-testid="mobile-preset-more"
        onClick={() => setMoreOpen(true)}
      >
        {t("common.more")}
      </button>

      {moreOpen && (
        <MobileCaptureMoreSheet
          customPresets={customPresets}
          aiReady={aiReady}
          onApply={onApply}
          onGenerateAi={onGenerateAi}
          onRename={renamePreset}
          onRemove={removePreset}
          onClose={() => setMoreOpen(false)}
        />
      )}
    </div>
  );
}
