import { useEffect, useRef, useState } from "react";
import { useWorkspacesStore } from "../stores/workspaces";
import { IconCaret, IconCopy, IconEdit, IconTrash, IconPlus, IconImage, IconWorkspace as WsDefaultIcon } from "./icons";
import { IconGrid } from "./IconPicker";
import { noteIconComp } from "../lib/noteIcons";
import { t } from "../i18n/t";
import { useDismiss } from "../lib/ui";
import { call, emitNotice } from "../lib/invoke";
import { useWorkspaceBgBase } from "../lib/workspaceBgBase";
import { FluidHoverHighlight, useFluidHover } from "./common/FluidHover";
import { NewNotebookModal } from "./NewNotebookModal";
import "../styles/workspace-switcher.css";

/* ── Left panel: notebook switcher (= workspace internal ids / store) ── */
export function WorkspaceSwitcher() {
  // workspaces store / workspace_id 는 내부 식별자 — 사용자 문구는 i18n `workspace.*` → 노트북
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeId = useWorkspacesStore((s) => s.activeId);
  const loaded = useWorkspacesStore((s) => s.loaded);
  const load = useWorkspacesStore((s) => s.load);
  const create = useWorkspacesStore((s) => s.create);
  const remove = useWorkspacesStore((s) => s.remove);
  const duplicate = useWorkspacesStore((s) => s.duplicate);
  const switchTo = useWorkspacesStore((s) => s.switchTo);
  const setBgImage = useWorkspacesStore((s) => s.setBgImage);
  const clearBgImage = useWorkspacesStore((s) => s.clearBgImage);

  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // 새 노트북은 모달로 만든다 — 설정 출발점(기본값/현재 노트북 복사)과 무엇이 노트북을 따라가는지를
  // 보여 줘야 해서 인라인 입력 한 줄로는 모자라다(PLAN-2026-09-19-notebook-settings §7 Q4).
  const [creating, setCreating] = useState(false);
  // Wave 13: 노트북(= workspace) 배경 이미지 — "편집모드"로 진입해 파일 선택/제거를 하는 인라인 패널.
  const [bgEditId, setBgEditId] = useState<string | null>(null);
  const [bgBusyId, setBgBusyId] = useState<string | null>(null);
  // 복제는 IPC 왕복 동안 노트·첨부를 통째로 복사한다 — pickBgImage/removeBgImage(bgBusyId)와
  // NewNotebookModal 의 busy 가드와 같은 이유로, 왕복 중 두 번째 클릭이 두 번째 사본을 만들지
  // 않게 막는다(리그레션 테스트: WorkspaceSwitcher.test.tsx).
  const [dupBusyId, setDupBusyId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(menuRef, { axis: "y" });
  const { baseDir: bgBaseDir, convert: bgConvert } = useWorkspaceBgBase();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useDismiss(
    open,
    [rootRef],
    () => {
      setOpen(false);
      setRenamingId(null);
      setBgEditId(null);
    },
    { escape: false },
  );

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setRenameValue(name);
  };

  const commitRename = async (id: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    // 연대 프리셋(korea/france)은 제거됨 — 이름만 변경한다.
    await call("workspace_rename", { id, name });
    await load();
  };

  // 노트북 아이콘 즉시 적용 — 편집 패널의 팔레트에서 스와치를 누르면 바로 저장/리로드한다
  // (이름 커밋과 독립. null = 기본 그리드 아이콘으로 되돌림).
  const setWorkspaceIcon = async (id: string, icon: string | null) => {
    await call("workspace_set_icon", { id, icon });
    await load();
  };

  const commitCreate = async (name: string, copyCurrentSettings: boolean) => {
    const ws = await create(name, copyCurrentSettings && activeId ? activeId : undefined);
    await switchTo(ws.id);
  };

  /** Add background image via plugin-dialog open() → workspace_set_bg_image (same streaming
   *  copy pattern as attachment_add_file — see src-tauri/src/repo/workspaces.rs::set_bg_image). */
  const pickBgImage = async (id: string) => {
    setBgBusyId(id);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      await setBgImage(id, path);
    } catch (e) {
      // call() 의 AppError 는 이미 토스트됨 — 파일피커 자체 실패만 여기서 알린다 (AttachmentsBar 와 동일 패턴).
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBgBusyId(null);
    }
  };

  const removeBgImage = async (id: string) => {
    setBgBusyId(id);
    try {
      await clearBgImage(id);
    } finally {
      setBgBusyId(null);
    }
  };

  const activeBgUrl =
    active?.bg_image_path && bgBaseDir && bgConvert
      ? bgConvert(`${bgBaseDir}/${active.bg_image_path}`)
      : null;

  return (
    // W24: 좌우 인셋 제거 — 부모 스트립(leftpanel/index.tsx)이 --sidebar-pad 를 소유한다.
    // 여기까지 갖고 있으면 이중 인셋(28px)이 되어 칩이 검색박스보다 좁아진다(오너 신고).
    <div ref={rootRef} style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <button
        type="button"
        className="ws-trigger"
        style={
          activeBgUrl
            ? {
                // 폰트 뒤 필을 없앤 대신, 이미지 틴트를 82%로 올려 어떤 이미지 위에서도 --text 가
                // 읽히도록 대비 바닥을 확보한다(이전엔 별도 --plated 플레이트가 그 역할을 했다).
                backgroundImage: `linear-gradient(color-mix(in srgb, var(--surface-base) 82%, transparent), color-mix(in srgb, var(--surface-base) 82%, transparent)), url("${activeBgUrl}")`,
              }
            : undefined
        }
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {(() => {
          // 사용자가 팔레트에서 고른 아이콘(active.icon) 또는 기본 그리드. 색은 버튼의 color(--text) 상속.
          const WsIcon = noteIconComp(active?.icon, WsDefaultIcon);
          return <WsIcon size={20} strokeWidth={2} style={{ flex: "none" }} />;
        })()}
        {/* 노트 모음의 이름(정체성). 폰트 뒤 플레이트는 제거하고, 이미지 배경일 땐 위 인라인
            틴트(82%)가 대비를 책임진다. */}
        <span className="ws-trigger-name">
          {active?.name ?? "…"}
        </span>
        <IconCaret
          dir={open ? "up" : "down"}
          size={15}
          style={{
            marginLeft: "auto",
            flex: "none",
            color: "var(--muted)",
            transition: "transform var(--dur-fast)",
          }}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="overlay fh-host"
          {...hover.handlers}
          style={{
            position: "absolute",
            // W24: 루트가 --sidebar-pad 를 잃으면서(부모 스트립이 인셋 소유) 이 인셋은 이중이
            // 됐다 — 드롭다운이 칩보다 28px 좁아 이름이 잘리던 원인. 칩과 같은 폭(0~0).
            left: 0,
            right: 0,
            top: "100%",
            marginTop: 4,
            zIndex: "var(--z-dropdown)",
            // 배경은 .overlay 소유 — flat=불투명, acrylic=시트 톤(최소 알파 0.92)+블러
            // (SINGLE-SHEET ACRYLIC CONTRACT).
            border: "1px solid var(--divider)",
            boxShadow: "var(--shadow-lg)",
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          <FluidHoverHighlight hover={hover} />
          {workspaces.map((w) => {
            const isActive = w.id === activeId;
            const isRenaming = renamingId === w.id;
            const disableDelete = workspaces.length <= 1;
            const isBgEditing = bgEditId === w.id;
            const rowPreviewUrl =
              w.bg_image_path && bgBaseDir && bgConvert
                ? bgConvert(`${bgBaseDir}/${w.bg_image_path}`)
                : null;
            return (
              <div key={w.id}>
                <button
                  type="button"
                  className="wsitem menu-row menu-item"
                  data-selected={isActive}
                  onClick={() => {
                    if (isRenaming) return;
                    setOpen(false);
                    if (!isActive) void switchTo(w.id);
                  }}
                  style={{
                    // width/textAlign/font/border 는 .menu-item 클래스가 담당.
                    gap: "var(--space-3)",
                    padding: "var(--space-2) var(--space-4)",
                    cursor: isRenaming ? "default" : "pointer",
                    // W24(오너): 배경 이미지가 있는 노트북은 행에도 이미지를 깐다 — 트리거 칩과
                    // 같은 틴트 레시피(82%)로 텍스트 대비 확보. hover 배경색은 이미지 아래층이라
                    // 안 보이지만, 선택 표시·커서로 충분(ponytail: 체감되면 틴트를 hover 에서
                    // 낮추는 CSS 로 승격).
                    ...(rowPreviewUrl && !isRenaming
                      ? {
                          backgroundImage: `linear-gradient(color-mix(in srgb, var(--surface) 82%, transparent), color-mix(in srgb, var(--surface) 82%, transparent)), url("${rowPreviewUrl}")`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : {}),
                  }}
                >
                  {isRenaming ? (
                    <div
                      style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}
                      onClick={(e) => e.stopPropagation()}
                      // 이름 입력 ↔ 프리셋 select 간 포커스 이동 시에는 커밋하지 않고, 그룹 밖으로
                      // 포커스가 나갈 때만 커밋한다 (창조 모달의 동일 패턴 재사용).
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          void commitRename(w.id);
                        }
                      }}
                    >
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(w.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="field"
                        style={{
                          border: "1px solid var(--accent)",
                          padding: "4px var(--space-2)",
                        }}
                      />
                      <div style={{ marginTop: "var(--space-1)" }}>
                        <div
                          style={{
                            fontSize: "var(--text-label)",
                            color: "var(--muted)",
                            marginBottom: "var(--space-2)",
                          }}
                        >
                          {t("workspace.icon")}
                        </div>
                        <IconGrid
                          value={w.icon}
                          defaultComp={WsDefaultIcon}
                          onPick={(icon) => void setWorkspaceIcon(w.id, icon)}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      {(() => {
                        const RowIcon = noteIconComp(w.icon, WsDefaultIcon);
                        return (
                          <RowIcon
                            size={16}
                            strokeWidth={1.9}
                            style={{ flex: "none", color: isActive ? "var(--accent)" : "var(--muted)" }}
                          />
                        );
                      })()}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontSize: "var(--text-md)",
                          fontWeight: isActive ? 600 : 400,
                          color: isActive ? "var(--accent)" : "var(--text)",
                        }}
                      >
                        {w.name}
                      </span>
                      <span style={{ fontSize: "var(--text-label)", color: "var(--faint)", flex: "none" }}>
                        {t("tree.n_notes", { n: w.note_count })}
                      </span>
                      <button
                        type="button"
                        className="wsact icon-btn icon-btn--sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(w.id, w.name);
                        }}
                        title={t("workspace.rename")}
                      >
                        <IconEdit size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="wsact icon-btn icon-btn--sm"
                        data-active={isBgEditing}
                        onClick={(e) => {
                          e.stopPropagation();
                          setBgEditId(isBgEditing ? null : w.id);
                        }}
                        title={t("workspace.edit_background")}
                      >
                        <IconImage size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="wsact icon-btn icon-btn--sm"
                        data-testid={`workspace-duplicate-${w.id}`}
                        // 네이티브 disabled 는 안 쓴다 — 이 버튼은 행 전체를 감싸는 바깥 <button>
                        // 안에 중첩돼 있어서(위 wsitem), disabled 인 동안의 클릭은 이 onClick 이
                        // 아예 안 불려(stopPropagation 도 못 돎) 바깥 행의 onClick(setOpen(false))
                        // 으로 그대로 버블돼 드롭다운이 닫힌다 — 아래 delete 버튼처럼 opacity 로만
                        // 표시하고, 재진입 차단은 상태 체크로 한다(리그레션 테스트로 확인).
                        aria-disabled={dupBusyId === w.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (dupBusyId === w.id) return;
                          // 노트·설정까지 통째로 — 새 노트북 창의 "설정만 복사"와 짝(PLAN-2026-09-19-notebook-settings).
                          setDupBusyId(w.id);
                          void (async () => {
                            try {
                              await duplicate(w.id, t("workspace.copy_name", { name: w.name }));
                              emitNotice(t("workspace.duplicated", { name: w.name }));
                            } catch {
                              /* call() 이 토스트를 띄웠다 */
                            } finally {
                              setDupBusyId(null);
                            }
                          })();
                        }}
                        title={t("workspace.duplicate")}
                        aria-label={t("workspace.duplicate")}
                        style={{ opacity: dupBusyId === w.id ? 0.4 : 1 }}
                      >
                        <IconCopy size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className={`wsact icon-btn icon-btn--sm ${disableDelete ? "icon-btn--static" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (disableDelete) return;
                          // One-click delete-to-undo (Tier 1, src/lib/undo.ts): remove() removes
                          // it from the list right away and delays the real cascade ~5s — the
                          // undo toast (see Toast.tsx) is the recovery path, not a confirm modal.
                          void remove(w.id);
                        }}
                        title={disableDelete ? t("workspace.delete_last_disabled") : t("workspace.delete")}
                        style={{
                          opacity: disableDelete ? 0.4 : 1,
                        }}
                      >
                        <IconTrash size={13} strokeWidth={1.8} />
                      </button>
                    </>
                  )}
                </button>
                {isBgEditing && (
                  <div className="ws-bg-panel">
                    {rowPreviewUrl && (
                      <div
                        className="ws-bg-preview"
                        style={{ backgroundImage: `url("${rowPreviewUrl}")` }}
                      />
                    )}
                    <div className="ws-bg-actions">
                      <button
                        type="button"
                        onClick={() => void pickBgImage(w.id)}
                        disabled={bgBusyId === w.id}
                        className="btn"
                        style={{ fontSize: "var(--text-sm)", padding: "var(--space-2) var(--space-3)" }}
                      >
                        <IconImage size={13} strokeWidth={1.8} />
                        {t(w.bg_image_path ? "workspace.change_bg_image" : "workspace.set_bg_image")}
                      </button>
                      {w.bg_image_path && (
                        <button
                          type="button"
                          onClick={() => void removeBgImage(w.id)}
                          disabled={bgBusyId === w.id}
                          className="btn"
                          style={{ fontSize: "var(--text-sm)", padding: "var(--space-2) var(--space-3)" }}
                        >
                          <IconTrash size={13} strokeWidth={1.8} />
                          {t("workspace.remove_bg_image")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ borderTop: "1px solid var(--line)" }}>
            <button
              type="button"
              className="menu-row menu-item"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              data-testid="workspace-new"
              style={{
                // width/textAlign/font/border 는 .menu-item 클래스가 담당.
                gap: "var(--space-2)",
                padding: "9px 10px", // 9px 10px kept
                color: "var(--accent)",
                fontSize: "var(--text-md)",
                fontWeight: 600,
              }}
            >
              <IconPlus size={13} strokeWidth={2.2} />
              {t("workspace.new_workspace")}
            </button>
          </div>
        </div>
      )}
      {creating && (
        <NewNotebookModal
          currentName={active?.name ?? null}
          onCreate={commitCreate}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
