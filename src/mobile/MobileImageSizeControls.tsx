import { t } from "../i18n/t";
import {
  MOBILE_IMAGE_WIDTH_STEPS,
  formatImageWidth,
  isMobileWidthStepActive,
  type MobileImageWidthStep,
} from "../components/editor/imageResize";

/** Minimal editor surface — matches useEditor return without pulling full TipTap types into mobile. */
export type ImageSizeEditor = {
  getAttributes: (name: string) => Record<string, unknown>;
  chain: () => {
    focus: () => {
      updateAttributes: (name: string, attrs: Record<string, unknown>) => { run: () => boolean };
    };
  };
};

/**
 * D5 mobile image size — single 3-step control used in both the top toolbar strip and the
 * image BubbleMenu. Why one component: the same button block was copy-pasted twice in
 * MobileNote.tsx (~lines 640 and 739); a shared helper keeps steps/labels/active logic in sync.
 *
 * Steps are mobile-only presets (25 / 40 / 100). Desktop free-drags via ImageNodeView.
 */
const STEP_LABEL_KEYS: Record<MobileImageWidthStep, string> = {
  25: "mobile.img_size_small",
  40: "mobile.img_size_medium",
  100: "mobile.img_size_large",
};

export function MobileImageSizeControls({
  editor,
  className,
  testId,
}: {
  editor: ImageSizeEditor;
  /** Extra class on the outer flex row (toolbar vs bubble styling). */
  className?: string;
  testId?: string;
}) {
  // Diagram-authoring tests (and any headless host) may pass a partial editor mock without
  // getAttributes — don't throw; size controls only make sense on a real TipTap image node.
  if (typeof editor?.getAttributes !== "function") return null;

  const width = (editor.getAttributes("image")?.width as string | undefined) ?? undefined;

  return (
    <div
      className={className}
      data-testid={testId}
      role="group"
      aria-label={t("mobile.img_size_group")}
    >
      {MOBILE_IMAGE_WIDTH_STEPS.map((step) => (
        <button
          key={step}
          type="button"
          className="mobile-image-size-btn"
          data-active={isMobileWidthStepActive(width, step)}
          aria-pressed={isMobileWidthStepActive(width, step)}
          onClick={() =>
            editor.chain().focus().updateAttributes("image", { width: formatImageWidth(step) }).run()
          }
        >
          {t(STEP_LABEL_KEYS[step])}
        </button>
      ))}
    </div>
  );
}
