import { useEffect, useState } from "react";
import { useWorkspacesStore } from "../stores/workspaces";
import { IconCaret, IconWorkspace as WsDefaultIcon } from "../components/icons";
import { noteIconComp } from "../lib/noteIcons";
import { t } from "../i18n/t";
import { useBackClosable } from "./useBackClosable";

/**
 * 노트 tab top bar — right side (owner feedback item 6). Notebook switcher (= workspace store).
 * Reuses stores/workspaces.ts's own switchTo()/load() (the exact same actions desktop's
 * WorkspaceSwitcher.tsx drives) rather than re-deriving the active-workspace-switch side effects
 * (settings_set + tree/taxonomy/trash refresh) here. Deliberately a plain list (no
 * create/rename/delete/background-image — those stay desktop-only per the brief: "simple opaque
 * sheet/menu, same badge/pill design language"). User title: i18n `mobile.workspace_switch_title`
 * → 노트북 전환 / Switch notebook / Changer de carnet.
 *
 * No "switched" callback: everything on the 필터 tab (MobileNoteTree's folder load, the query
 * hooks) re-keys itself off the store's `activeId`, so a switch here needs no parent poke.
 */
export function MobileWorkspaceSwitcher() {
  // = 노트북 (internal: useWorkspacesStore / active_workspace_id)
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const loaded = useWorkspacesStore((s) => s.loaded);
  const load = useWorkspacesStore((s) => s.load);
  const switchTo = useWorkspacesStore((s) => s.switchTo);

  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  // Same close rule as the backdrop/cancel: not while a switch is in flight.
  useBackClosable(open, () => {
    if (!switching) setOpen(false);
  });

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;
  const ActiveIcon = noteIconComp(active?.icon, WsDefaultIcon);

  const pick = async (id: string) => {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      await switchTo(id);
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  };

  return (
    <>
      <button type="button" className="mobile-ws-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <ActiveIcon size={22} strokeWidth={2} style={{ flex: "none" }} />
        <span className="mobile-ws-trigger-name">{active?.name ?? "…"}</span>
        <IconCaret dir="down" size={16} style={{ flex: "none", marginLeft: "auto", color: "var(--muted)" }} />
      </button>

      {open && (
        <>
          <div className="mobile-sheet-backdrop" onClick={() => !switching && setOpen(false)} />
          <div className="mobile-sheet overlay" role="dialog" aria-modal="true" aria-label={t("mobile.workspace_switch_title")}>
            <div className="mobile-sheet-title label-caps">{t("mobile.workspace_switch_title")}</div>
            <div className="mobile-ai-actions">
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="menu-row mobile-ai-action"
                  data-selected={w.id === activeId}
                  disabled={switching}
                  onClick={() => void pick(w.id)}
                >
                  {w.name}
                </button>
              ))}
            </div>
            <button type="button" className="mobile-text-btn mobile-sheet-close" disabled={switching} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </>
      )}
    </>
  );
}
