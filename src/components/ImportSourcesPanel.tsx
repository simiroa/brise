import React, { useEffect, useState, type JSX } from "react";
import { useSettingsStore } from "../stores/settings";
import { useNotesStore } from "../stores/notes";
import { useAiStore, selectAiAvailability } from "../stores/ai";
import { call, emitNotice } from "../lib/invoke";
import type {
  MigrationImportEnexOutput,
  MigrationImportMarkdownOutput,
  MigrationImportNotionOutput,
} from "../lib/commands.gen";
import { PromptDialog } from "./PromptDialog";
import { useMenuPos } from "../lib/ui";
import { IconCaret } from "./icons";
import { t } from "../i18n/t";
import { isBrowser } from "../lib/env";
import { Select } from "./Select";
import { FluidHoverHighlight, useFluidHover } from "./common/FluidHover";
import { AiBatchOrganizeModal } from "../lazySurfaces";
import { preloadIntentProps } from "../lib/lazyPreload";



export type ImportSource = "markdown" | "notion" | "enex";

/**
 * "Pick a path" (dialog) 이후의 공통 부분 — ensureInboxId, migration_import_* 커맨드, loadTree,
 * 완료 notice. OnboardingImportStep(PLAN-2026-09-28)의 드롭존이 파일 피커 없이 같은 IPC 경로를
 * 타도록 뽑아냈다("유사 기능은 같은 관문" — CLAUDE.md). AI-organize 제안·onImported/onCancel은
 * 호출자(이 파일의 세 picker 래퍼, 또는 드롭존)가 결과로 판단해 각자 처리한다. call() 실패는
 * call() 이 이미 AppError 토스트를 띄웠으므로 여기서는 null만 돌려준다.
 */
// 완료 문구 키는 리터럴로 둔다 — 템플릿 문자열이면 check-i18n 이 사용처를 못 봐 "미사용"으로 지운다.
const IMPORT_DONE_KEY: Record<ImportSource, string> = {
  markdown: "settings.import_markdown_done",
  notion: "settings.import_notion_done",
  enex: "settings.import_enex_done",
};

export async function importFromPath(
  kind: ImportSource,
  path: string,
): Promise<{ imported: number; skipped: number; noteIds: string[] } | null> {
  try {
    const folderId = await useNotesStore.getState().ensureInboxId();
    const result =
      kind === "markdown"
        ? await call<MigrationImportMarkdownOutput>("migration_import_markdown", { folder_id: folderId, source_dir: path })
        : kind === "notion"
          ? await call<MigrationImportNotionOutput>("migration_import_notion", { folder_id: folderId, zip_path: path })
          : await call<MigrationImportEnexOutput>("migration_import_enex", { folder_id: folderId, enex_path: path });
    await useNotesStore.getState().loadTree();
    emitNotice(t(IMPORT_DONE_KEY[kind], { imported: result.imported, skipped: result.skipped }));
    return { imported: result.imported, skipped: result.skipped, noteIds: result.note_ids };
  } catch {
    return null; // call() 이 AppError 토스트를 이미 표출함
  }
}

// Extracted from DataManagementSection so the onboarding wizard (§2.6 HANDOFF-calendar-onboarding.md)
// can reuse the same three import sources + AI-organize offer flow outside of Settings. Pure move —
// `onImported` replaces DataManagementSection's direct stats refresh so this component doesn't need
// to know about Settings' `stats`/`setStats` state.
//
// `variant` (onboarding redesign 2026-07-29): "dropdown" — one <select> of the same three sources
// + a single go button, for the onboarding wizard's compact "import" card. Same underlying
// import*() calls either way; only the entry-point chrome differs.
//
// `variant="menu"` (Data Management tile redesign, 2026-07-29): one dropdown-trigger button that
// opens a small popup menu of the three sources — same useMenuPos + `.overlay`/`menu-row menu-item`
// pattern DataManagementSection's own "Advanced" button already uses, so this reuses an existing
// visual idiom instead of inventing a new one.
// (A third "buttons" variant — Settings' plain three-button row — existed here until Wave R1-b;
// both call sites always passed "dropdown"/"menu", so that branch was dead code. Restore from
// history if a bare three-button layout is ever needed again.)
export function ImportSourcesPanel({
  onImported,
  onCancel,
  variant,
  primary,
}: {
  onImported?: () => void;
  /** PLAN-2026-09-28-onboarding-rebuild.md §1 — 온보딩의 "기록 가져오기" 경로는 파일 피커
   *  취소·오류를 완료로 보지 않고 첫 화면으로 돌아간다. 세 import*() 함수 모두의 취소/오류
   *  분기에서 부른다(가져온 개수 > 0일 때만 부르는 onImported와 달리, 무조건 호출). */
  onCancel?: () => void;
  variant: "dropdown" | "menu";
  /** dropdown 변형의 실행 버튼을 주 버튼(.btn-primary)으로 — 온보딩 가져오기 카드의 유일한 주 행동. */
  primary?: boolean;
}): JSX.Element {
  // §2.5 "임포트한 N개를 AI로 정리": offered as inline state after a successful import, not
  // auto-launched. Gated on the same aiEnabled && aiReachable === true pair TitleBar uses to
  // show/hide the single-note AI menu (AiActionsMenu) — if AI is off or unreachable, this
  // whole feature stays inert (no banner, no dialog, no modal).
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);
  useEffect(() => {
    void ensureAiReachable();
  }, [aiEnabled, ensureAiReachable]);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const aiOfferGateOk = availability === "ready";
  // 셋 다 plugin-dialog 파일/폴더 피커에 의존한다 — 로컬 파일시스템 접근이라 브라우저 탭엔 대응
  // 개념이 없다(excluded-over-HTTP).
  const browser = isBrowser();

  const [importOffer, setImportOffer] = useState<{ noteIds: string[]; count: number } | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchModalIds, setBatchModalIds] = useState<string[] | null>(null);

  // §2.5 HANDOFF-calendar-onboarding.md slice 1: Markdown+frontmatter folder import. Placeholder
  // entry point — the onboarding wizard (§2.6) will replace this with a proper step; this just
  // gives the feature a way in before that wizard exists. Destination is the inbox folder
  // (ensureInboxId, same target new-note creation uses) rather than a folder picker of its own —
  // keeps this to one button, not a wizard.
  const importMarkdownFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) {
        onCancel?.();
        return;
      }
      const result = await importFromPath("markdown", dir);
      if (!result) {
        onCancel?.();
        return;
      }
      if (result.imported > 0) {
        onImported?.();
        if (aiOfferGateOk) setImportOffer({ noteIds: result.noteIds, count: result.imported });
      }
    } catch {
      /* dialog unavailable outside Tauri, or call() already toasted the AppError */
      onCancel?.();
    }
  };

  // §2.5 slice 2: Notion "Export as Markdown & CSV" zip import. Same placeholder-entry-point
  // pattern as importMarkdownFolder (inbox folder, no wizard) — this is a file picker (single
  // .zip), not the directory picker slice 1 used, since a Notion export is one archive.
  const importNotionZip = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: t("settings.notion_zip_filter"), extensions: ["zip"] }],
      });
      if (!path || Array.isArray(path)) {
        onCancel?.();
        return;
      }
      const result = await importFromPath("notion", path);
      if (!result) {
        onCancel?.();
        return;
      }
      if (result.imported > 0) {
        onImported?.();
        if (aiOfferGateOk) setImportOffer({ noteIds: result.noteIds, count: result.imported });
      }
    } catch {
      /* dialog unavailable outside Tauri, or call() already toasted the AppError */
      onCancel?.();
    }
  };

  // §2.5 slice 3 (last): Evernote ENEX export import. Same placeholder-entry-point pattern as the
  // other two (inbox folder, no wizard) — file picker (single .enex), same shape as importNotionZip.
  const importEnexFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: t("settings.enex_filter"), extensions: ["enex"] }],
      });
      if (!path || Array.isArray(path)) {
        onCancel?.();
        return;
      }
      const result = await importFromPath("enex", path);
      if (!result) {
        onCancel?.();
        return;
      }
      if (result.imported > 0) {
        onImported?.();
        if (aiOfferGateOk) setImportOffer({ noteIds: result.noteIds, count: result.imported });
      }
    } catch {
      /* dialog unavailable outside Tauri, or call() already toasted the AppError */
      onCancel?.();
    }
  };

  const runSource = (source: ImportSource) => {
    if (browser) return;
    if (source === "markdown") void importMarkdownFolder();
    else if (source === "notion") void importNotionZip();
    else void importEnexFile();
  };

  const [dropdownSource, setDropdownSource] = useState<ImportSource>("markdown");

  const [menuOpen, setMenuOpen] = useState<{ x: number; y: number } | null>(null);
  const { ref: menuRef, x: menuX, y: menuY } = useMenuPos(menuOpen);
  const hover = useFluidHover(menuRef, { axis: "y" });

  return (
    <>
      {variant === "dropdown" ? (
        // Column stack (not select+button in one row): Settings-length option labels
        // ("Import from another app (Markdown folder)" / FR/KO equivalents) force a native
        // <select> min-content wider than the onboarding finish card (~290px at modal 640).
        // A horizontal row overflowed the import card and painted over the sibling "blank start"
        // card — measured repro before this change. Stacked full-width controls + minWidth:0 keep
        // the panel inside the card; behaviour (pick source → go → import*()) is unchanged.
        <div
          data-testid="import-sources-dropdown"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", width: "100%", minWidth: 0 }}
        >
          <Select
            style={{ width: "100%", minWidth: 0 }}
            value={dropdownSource}
            onChange={(v) => setDropdownSource(v as ImportSource)}
            ariaLabel={t("settings.import_other_apps")}
            options={[
              { value: "markdown", label: t("settings.import_markdown") },
              { value: "notion", label: t("settings.import_notion") },
              { value: "enex", label: t("settings.import_enex") },
            ]}
          />
          <button
            type="button"
            onClick={() => runSource(dropdownSource)}
            disabled={browser}
            title={browser ? t("common.desktop_only") : undefined}
            className={primary ? "btn btn-primary" : "btn"}
            style={{ width: "100%", opacity: browser ? 0.5 : 1 }}
          >
            {t("onboarding.cards_import_go")}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={(e) => setMenuOpen({ x: e.clientX, y: e.clientY })}
            disabled={browser}
            title={browser ? t("common.desktop_only") : undefined}
            className="btn"
            style={{ width: "100%", opacity: browser ? 0.5 : 1 }}
          >
            {t("settings.import_other_apps")}
            <IconCaret dir="down" size={14} />
          </button>
          {menuOpen && (
            <>
              <div
                onClick={() => setMenuOpen(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuOpen(null);
                }}
                style={{ position: "fixed", inset: 0, zIndex: "var(--z-backdrop)" }}
              />
              <div
                ref={menuRef}
                className="overlay fh-host"
                {...hover.handlers}
                style={{
                  position: "fixed",
                  zIndex: "var(--z-modal)",
                  minWidth: 220,
                  border: "1px solid var(--divider)",
                  boxShadow: "var(--shadow-lg)",
                  padding: "var(--space-1)",
                  animation: "pop .12s",
                  left: menuX,
                  top: menuY,
                }}
              >
                <FluidHoverHighlight hover={hover} />
                {(["markdown", "notion", "enex"] as const).map((source) => (
                  <button
                    key={source}
                    type="button"
                    className="menu-row menu-item"
                    onClick={() => {
                      setMenuOpen(null);
                      runSource(source);
                    }}
                    style={{ color: "inherit" }}
                  >
                    {t(`settings.import_${source}`)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {importOffer && aiOfferGateOk && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            width: "100%",
          }}
        >
          <span style={{ fontSize: "var(--text-md)", color: "var(--text)" }}>
            {t("settings.migration_ai_offer", { count: importOffer.count })}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setImportOffer(null)}
              className="btn"
              style={{ padding: "5px 10px", fontSize: "var(--text-sm)" }}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => setBatchConfirmOpen(true)}
              // 확인 대화상자를 거쳐 일괄 정리 모달이 열린다 — 이 버튼에서 미리 받아 둔다.
              {...preloadIntentProps(AiBatchOrganizeModal)}
              className="btn"
              style={{ color: "var(--accent)", borderColor: "var(--accent)", padding: "5px 10px", fontSize: "var(--text-sm)" }}
            >
              {t("settings.migration_ai_offer_btn", { count: importOffer.count })}
            </button>
          </div>
        </div>
      )}

      {batchConfirmOpen && importOffer && (
        <PromptDialog
          title={t("settings.migration_ai_confirm_title")}
          description={t("settings.migration_ai_confirm_desc", { count: importOffer.count })}
          mode="confirm"
          confirmLabel={t("settings.migration_ai_offer_btn", { count: importOffer.count })}
          onCancel={() => setBatchConfirmOpen(false)}
          onSubmit={() => {
            setBatchConfirmOpen(false);
            setBatchModalIds(importOffer.noteIds);
            setImportOffer(null);
          }}
        />
      )}

      {batchModalIds && (
        <React.Suspense fallback={null}>
          <AiBatchOrganizeModal noteIds={batchModalIds} onClose={() => setBatchModalIds(null)} />
        </React.Suspense>
      )}
    </>
  );
}
