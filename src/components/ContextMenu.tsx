import React, { useEffect, useMemo, useState, type CSSProperties, Suspense } from "react";
import { useUiStore } from "../stores/ui";
import { useNotesStore, displayTitle } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useTaxonomyStore } from "../stores/taxonomy";
import { call, callSilent, emitNotice } from "../lib/invoke";
import { showUndoToast } from "../lib/undo";
import { useTrashStore } from "../stores/trash";
import { useArchiveStore } from "../stores/archive";
import { openExportModal } from "../stores/exportModal";
import {
  deleteNote,
  setNoteStatus,
  duplicateNote,
  exportFolder,
  exportFolderBundle,
  moveNote,
} from "../lib/noteActions";
import { ContextMenuShell } from "./common/ContextMenuShell";
import type { NoteQueryOutput, NoteSummary } from "../lib/commands.gen";
import {
  IconStar,
  IconShare,
  IconNote,
  IconTrash,
  IconFolder,
  IconAi,
  IconSettings,
  IconSparkles,
  // W7-f: no dedicated "archive" glyph among current lucide re-exports (icons.tsx shared file,
  // out of scope this wave) — IconBook stands in, same choice as the tree row (TreeListRow.tsx).
  IconBook,
} from "./icons";
import { statusColorVar, statusOptions, statusOptionLabel } from "../lib/status";
import { t } from "../i18n/t";
import { PromptDialog } from "./PromptDialog";
import { StatusDot } from "./titlebar/StatusControl";
import { generateFolderOrganizePlan } from "../stores/aiAgentActions";
import type { AiPlan } from "../lib/aiAgentBridge";
import { ensureAiAskGate } from "../stores/ai";
import type { AskAiTarget } from "./AskAiModal";
import { AiAgentReviewModal, AiBatchOrganizeModal, AskAiModal } from "../lazySurfaces";
import { preloadIntentProps } from "../lib/lazyPreload";





type CtxDialog =
  | { kind: "exportFolder"; id: string }
  | { kind: "moveFolder"; id: string; currentFolderId: string }
  | { kind: "changeStatus"; id: string; currentStatus: string | null };

// 컨텍스트 메뉴 항목의 공통 인라인 — 풀폭/좌측정렬/font/border 는 이제 `.menu-item` 클래스가
// 담당하고(tokens.css), 여기엔 컨텍스트 메뉴 고유의 색 상속·항목 간격만 남긴다. 버튼 className 은
// "menu-row menu-item".
const menuItem: CSSProperties = {
  color: "inherit",
};

/** 상태 선택지에서 null 을 나르는 sentinel — PromptDialog 의 choice value 는 string 이다. */
const NO_STATUS = "__null__";

function statusDescription(value: string, current: string | null): string | undefined {
  return value === (current ?? NO_STATUS) ? t("ctx.status_current") : undefined;
}

// 폴더 색은 여기 모달이 아니라 폴더 설정(FolderOrganizeModal)이 갖는다 — 한때 트리 글리프의 색
// 전용 팝오버가 두 번째 관문이었지만, 아이콘·규칙·제외와 함께 설정 한 곳으로 합치며 지웠다.

export function ContextMenu() {
  const ctxOpen = useUiStore((s) => s.ctxOpen);
  const closeCtx = useUiStore((s) => s.closeCtx);
  const folders = useNotesStore((s) => s.folders);
  const inboxId = useNotesStore((s) => s.inboxId);
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const activeNoteSummary = useNotesStore((s) => s.activeNote?.note ?? null);
  const loadTree = useNotesStore((s) => s.loadTree);
  const selectNote = useNotesStore((s) => s.selectNote);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const customStatuses = useTaxonomyStore((s) => s.statuses);
  const [dialog, setDialog] = useState<CtxDialog | null>(null);
  const [folderReviewPlan, setFolderReviewPlan] = useState<AiPlan | null>(null);
  const [batchOrganizeIds, setBatchOrganizeIds] = useState<string[] | null>(null);
  const [askAiTarget, setAskAiTarget] = useState<AskAiTarget | null>(null);

  // Wave 2: 사용자 spec — inbox(미분류) 폴더는 트리 폴더 리스트에서 빼고 폴더 피커/이동 대상
  // 에서도 숨긴다. 컨텍스트 메뉴(title, isFolder 판정, move-to-folder 후보, rename/delete
  // 분기) 모든 경로에서 동일하게 inboxFolder 만 빼놓은 리스트로 정규화한다.
  const pickableFolders = useMemo(
    () => (inboxId ? folders.filter((f) => f.id !== inboxId) : folders),
    [folders, inboxId]
  );

  const isFolder = useMemo(
    () => (ctxOpen ? pickableFolders.some((f) => f.id === ctxOpen.noteId) : false),
    [ctxOpen, pickableFolders]
  );

  // W7-d: 미분류(inbox)는 실제로는 일반 폴더(백엔드 folder row)지만 pickableFolders가 의도적으로
  // 빼놓은 목록이라(위 주석) isFolder는 인박스에 대해 항상 false다. "폴더냐 노트냐" 와는 별개로
  // "인박스냐" 를 따로 판정해야 그 전용 메뉴 분기를 걸 수 있다.
  const isInbox = ctxOpen != null && inboxId != null && ctxOpen.noteId === inboxId;

  // Wave A-4: resolve via resident noteIndex / activeNote, then by-id note_summaries_map
  // so a right-click on a search hit that is not in the partial tree cache still gets a menu.
  const [resolvedSummary, setResolvedSummary] = useState<NoteSummary | null>(null);
  useEffect(() => {
    if (!ctxOpen || isFolder || isInbox) {
      setResolvedSummary(null);
      return;
    }
    const id = ctxOpen.noteId;
    if (activeNoteSummary?.id === id) {
      setResolvedSummary(activeNoteSummary);
      return;
    }
    const hit = noteIndex.get(id);
    if (hit) {
      setResolvedSummary(hit);
      return;
    }
    let cancelled = false;
    void useNotesStore
      .getState()
      .ensureNoteSummaries([id])
      .then((map) => {
        if (!cancelled) setResolvedSummary(map.get(id) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [ctxOpen, isFolder, isInbox, noteIndex, activeNoteSummary]);

  const noteSummary: NoteSummary | null = resolvedSummary;

  // "Move to folder" 후보 = 노트의 현재 폴더를 뺀 나머지 (inbox 제외) 워크스페이스 폴더들.
  const otherFolders = useMemo(
    () => (noteSummary ? pickableFolders.filter((f) => f.id !== noteSummary.folder_id) : []),
    [noteSummary, pickableFolders]
  );

  if (!ctxOpen && !dialog && !askAiTarget && !folderReviewPlan) return null;

  const title = ctxOpen
    ? isFolder
      ? pickableFolders.find((f) => f.id === ctxOpen.noteId)?.name ?? t("ctx.folder_fallback_title")
      : isInbox
        ? t("tree.inbox")
        : noteSummary ? displayTitle(noteSummary.title) : ""
    : "";



  const toggleFav = async () => {
    if (!noteSummary) return;
    await call("note_toggle_favorite", { id: noteSummary.id });
    await loadTree();
    if (activeNoteSummary?.id === noteSummary.id) {
      await selectNote(noteSummary.id);
    }
    closeCtx();
  };

  // 노트 우클릭 "내보내기" — 내보내기 모달(components/export/ExportModal)을 "노트 전체" 범위로 연다.
  // 섹션 탭 우클릭 "내보내기…"와 같은 모달이다. 노트 전체 Markdown 저장은 모달이 lib/noteActions.ts 의 exportNote 를 부른다.
  const openExportNote = () => {
    if (!noteSummary) return;
    openExportModal({ noteId: noteSummary.id, noteTitle: noteSummary.title, sectionId: null });
    closeCtx();
  };

  // "AI에게 묻기" (owner philosophy: one entry point per AI-capable context, see AskAiModal.tsx
  // header). Gate check happens HERE, before the modal opens — not inside the modal's chips/free
  // prompt — so the user never types into a box that will silently no-op on submit (same reasoning
  // as EditorPanel.tsx's openSelectionAiAsk).
  const openAskAi = () => {
    if (!noteSummary) return;
    const target: AskAiTarget = {
      kind: "note",
      noteId: noteSummary.id,
      noteTitle: displayTitle(noteSummary.title),
    };
    closeCtx();
    void (async () => {
      if (!(await ensureAiAskGate())) return;
      setAskAiTarget(target);
    })();
  };

  const openExportFolder = () => {
    if (!ctxOpen) return;
    setDialog({ kind: "exportFolder", id: ctxOpen.noteId });
    closeCtx();
  };

  // exportFolder/exportFolderBundle: lib/noteActions.ts (moved from here, §R2 layer rule).
  const runExportFolder = exportFolder;
  const runExportFolderBundle = exportFolderBundle;

  /**
   * Duplicate: lib/noteActions.ts::duplicateNote (moved from here, §R2 layer rule) does the
   * note_get → note_create → copy sections/sources/tags → loadTree → selectNote sequence. This
   * component only owns closeCtx() timing — the menu stays open until duplication resolves, same
   * as before.
   */
  const runDuplicate = async () => {
    if (!noteSummary) return;
    await duplicateNote(noteSummary.id);
    closeCtx();
  };

  /**
   * Move to folder: note_update({ id, folder_id }) — backend already moves the note (see
   * specs/commands/notes.yaml), just no frontend caller existed. Mirrors rename's shape:
   * call → loadTree (tree membership derives from notesByFolder) → resync activeNote if it's
   * the note being moved (its folder_id lives on activeNote.note, same as rename's title).
   * runMoveFolder itself is lib/noteActions.ts::moveNote — this component's inline copy was an
   * exact duplicate (§R2 layer rule), so it now just reuses the shared one directly.
   */
  const openMoveFolder = () => {
    if (!noteSummary || otherFolders.length === 0) return;
    setDialog({ kind: "moveFolder", id: noteSummary.id, currentFolderId: noteSummary.folder_id });
    closeCtx();
  };

  const runMoveFolder = moveNote;

  // 임의 노트의 진행 상태 변경. useNotesStore.setStatus 는 쓸 수 없다 — active-note-only 라
  // (notes.ts:665) 다른 행에 대해서는 조용히 아무것도 안 한다. Shared path: setNoteStatus.
  const openChangeStatus = () => {
    if (!noteSummary) return;
    setDialog({ kind: "changeStatus", id: noteSummary.id, currentStatus: noteSummary.status });
    closeCtx();
  };

  // Trash: note_delete now SOFT-deletes (moves to trash) instead of destroying the note, so the
  // old danger-confirm dialog is gone — deleting runs immediately and an undo toast offers the
  // way back (note_restore via the trash store + reselecting the note). deleteNote() itself still
  // runs flushAll→note_delete→closeTab→loadTree→selectNote(next) — see lib/noteActions.ts for the
  // full flush-before-delete rationale. Unlike TitleBar.tsx, this call site does not wrap it in
  // try/catch (pre-existing behavior, kept as-is by the refactor) — a failed delete surfaces as
  // an unhandled rejection, same as before, and simply skips the undo toast.
  const openDelete = () => {
    if (isFolder || !noteSummary) return;
    const id = noteSummary.id;
    closeCtx();
    void runDelete(id);
  };

  const runDelete = async (id: string) => {
    await deleteNote(id);
    void useTrashStore.getState().loadTrash();
    showUndoToast(t("trash.moved"), () => {
      void (async () => {
        await useTrashStore.getState().restoreNote(id);
        await selectNote(id);
      })();
    });
  };

  // W7-f 아카이브: 트리/대시보드에서 숨기되 FTS는 유지(repo::notes::archive) — 삭제와 달리 탭은
  // 닫지 않는다(아카이브된 노트도 여전히 완전히 편집 가능한 정상 노트이므로). undo 토스트는
  // delete의 것과 같은 패턴(unarchive가 archive의 역연산).
  const openArchiveNote = () => {
    if (isFolder || !noteSummary) return;
    const id = noteSummary.id;
    closeCtx();
    void runArchive(id);
  };

  const runArchive = async (id: string) => {
    await useArchiveStore.getState().archiveNote(id);
    showUndoToast(t("archive.moved"), () => {
      void useArchiveStore.getState().unarchiveNote(id);
    });
  };

  return (
    <>
      {ctxOpen && (
      <ContextMenuShell
        anchor={ctxOpen}
        onClose={closeCtx}
        minWidth={196}
      >
        <div
          style={{
                padding: "var(--space-2) var(--space-4) var(--space-2)",
                fontSize: "var(--text-label)",
                textTransform: "uppercase",
                color: "var(--faint)",
                fontWeight: 600,
                borderBottom: "1px solid var(--line)",
                marginBottom: "var(--space-1)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 220,
              }}
            >
              {title}
            </div>

            {!isFolder && !isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => void toggleFav()}
                style={menuItem}
              >
                <IconStar size={15} strokeWidth={1.8} />
                <span>
                  {noteSummary?.is_favorite
                    ? t("ctx.remove_favorite")
                    : t("ctx.add_favorite")}
                </span>
              </button>
            )}

            {!isFolder && !isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={openExportNote}
                style={menuItem}
              >
                <IconShare size={15} strokeWidth={1.8} />
                <span>{t("ctx.export_note")}</span>
              </button>
            )}

            {isFolder && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={openExportFolder}
                style={menuItem}
              >
                <IconShare size={15} strokeWidth={1.8} />
                <span>{t("ctx.export_folder")}</span>
              </button>
            )}

            {!isFolder && !isInbox && aiEnabled && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={openAskAi}
                style={menuItem}
              >
                <IconAi size={15} strokeWidth={1.8} />
                <span>{t("ai.ask_ai")}</span>
              </button>
            )}

            {isFolder && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => {
                  // 폴더 설정(FolderOrganizeModal) — 이름·아이콘·색상·규칙·제외 토글을 언제든 고칠 수
                  // 있는 자리. 바로 아래 "AI 제안" 항목과 나란히 서므로 글리프도 갈라 놓는다(둘 다
                  // IconNote 였을 때는 어느 쪽이 설정인지 메뉴만 보고는 알 수 없었다).
                  useUiStore.getState().openFolderFiles(ctxOpen.noteId);
                  closeCtx();
                }}
                style={menuItem}
              >
                <IconSettings size={15} strokeWidth={1.8} />
                <span>{t("ctx.folder_organize")}</span>
              </button>
            )}

            {isFolder && aiEnabled && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => {
                  const folderId = ctxOpen.noteId;
                  const folder = folders.find((f) => f.id === folderId);
                  closeCtx();
                  if (!folder) return;
                  void (async () => {
                    // N2-1: bounded note_query(folder_ids) inside generateFolderOrganizePlan —
                    // NOT notesByFolder[folderId] (the tree's windowed cache, only whatever had
                    // scrolled into view). See FOLDER_AI_SCAN_CAP for why.
                    const plan = await generateFolderOrganizePlan(folderId, folder.name);
                    if (plan) setFolderReviewPlan(plan);
                    else emitNotice(t("ctx.folder_empty"));
                  })();
                }}
                style={menuItem}
                {...preloadIntentProps(AiAgentReviewModal)}
              >
                <IconNote size={15} strokeWidth={1.8} />
                <span>{t("ai.folder_organize_proposal")}</span>
              </button>
            )}

            {/* W7-d 미분류 관리 / AI 진입점 — 폴더 정리 모달(FolderOrganizeModal), 일괄 AI 정리(AiBatchOrganizeModal), AI 정리 제안(AiAgentReviewModal) */}
            {isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => {
                  useUiStore.getState().openFolderFiles(ctxOpen.noteId);
                  closeCtx();
                }}
                style={menuItem}
              >
                <IconSettings size={15} strokeWidth={1.8} />
                <span>{t("ctx.folder_organize")}</span>
              </button>
            )}

            {isInbox && aiEnabled && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => {
                  const folderId = ctxOpen.noteId;
                  closeCtx();
                  void (async () => {
                    try {
                      const res = await callSilent<NoteQueryOutput>("note_query", { folder_ids: [folderId], limit: 200 });
                      if (res.notes && res.notes.length > 0) {
                        setBatchOrganizeIds(res.notes.map((n) => n.id));
                      } else {
                        emitNotice(t("ctx.folder_empty"));
                      }
                    } catch (e: unknown) {
                      emitNotice(String((e as { message?: string })?.message ?? e));
                    }
                  })();
                }}
                style={menuItem}
                {...preloadIntentProps(AiBatchOrganizeModal)}
              >
                <IconSparkles size={15} strokeWidth={1.8} />
                <span>{t("folderOrganize.batch_organize")}</span>
              </button>
            )}

            {isInbox && aiEnabled && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => {
                  const folderId = ctxOpen.noteId;
                  closeCtx();
                  void (async () => {
                    const plan = await generateFolderOrganizePlan(folderId, t("tree.inbox"));
                    if (plan) setFolderReviewPlan(plan);
                    else emitNotice(t("ctx.folder_empty"));
                  })();
                }}
                style={menuItem}
                {...preloadIntentProps(AiAgentReviewModal)}
              >
                <IconNote size={15} strokeWidth={1.8} />
                <span>{t("ai.folder_organize_proposal")}</span>
              </button>
            )}

            {!isFolder && !isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={() => void runDuplicate()}
                style={menuItem}
              >
                <IconNote size={15} strokeWidth={1.8} />
                <span>{t("ctx.duplicate")}</span>
              </button>
            )}

            {!isFolder && !isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={openMoveFolder}
                disabled={otherFolders.length === 0}
                title={otherFolders.length === 0 ? t("ctx.move_no_folders") : undefined}
                style={{
                  ...menuItem,
                  opacity: otherFolders.length === 0 ? 0.4 : 1,
                  cursor: otherFolders.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                <IconFolder size={15} strokeWidth={1.8} />
                <span>{t("ctx.move_to_folder")}</span>
              </button>
            )}

            {!isFolder && !isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={openChangeStatus}
                style={menuItem}
              >
                {noteSummary?.status ? (
                  <StatusDot color={statusColorVar(noteSummary.status)} size={15} />
                ) : (
                  <span
                    aria-hidden
                    style={{
                      width: 15,
                      height: 15,
                      borderRadius: "50%",
                      border: "1.5px solid var(--faint)",
                      flex: "none",
                    }}
                  />
                )}
                <span>{t("ctx.change_status")}</span>
              </button>
            )}

            {!isFolder && !isInbox && (
              <button
                type="button"
                className="menu-row menu-item"
                onClick={openArchiveNote}
                style={menuItem}
              >
                <IconBook size={15} strokeWidth={1.8} />
                <span>{t("ctx.archive")}</span>
              </button>
            )}

            {/* 미분류는 이름변경/이동/삭제/색상이 모두 불가능한 자리라(폴더도 아니고 노트도
                아니다) 삭제 구분선+버튼 자체를 숨긴다 — 비활성 상태로 보여주는 것도 "여기서
                지울 수 있을 것 같다"는 오해를 준다. */}
            {!isInbox && (
              <>
                <div className="menu-sep" />

                <button
                  type="button"
                  className="menu-row menu-item"
                  onClick={() => {
                    if (!isFolder) openDelete();
                  }}
                  title={isFolder ? t("ctx.folder_delete_disabled") : undefined}
                  style={{
                    ...menuItem,
                    marginBottom: 0,
                    color: "var(--danger)",
                    opacity: isFolder ? 0.4 : 1,
                    cursor: isFolder ? "not-allowed" : "pointer",
                  }}
                >
                  <IconTrash size={15} strokeWidth={1.8} />
                  <span>{t("ctx.remove")}</span>
                </button>
              </>
            )}
      </ContextMenuShell>
      )}

      {dialog?.kind === "exportFolder" && (
        <PromptDialog
          title={t("ctx.export_folder")}
          mode="choice"
          // 폴더 단위 HTML 은 W6 에서 뺐다(오너 결정 2026-10-08) — 남은 건 노트마다 .md 와, 다른 Brise 로 가져갈 번들.
          // 대화상자는 번들 때문에 남는다(폴더 번들 내보내기의 유일한 진입점).
          choices={[
            { value: "md", label: t("ctx.export_choice_md") },
            {
              value: "bundle",
              label: t("ctx.export_choice_bundle"),
              description: t("ctx.export_choice_bundle_hint"),
            },
          ]}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const d = dialog;
            setDialog(null);
            if (value === "bundle") {
              void runExportFolderBundle(d.id);
            } else {
              void runExportFolder(d.id);
            }
          }}
        />
      )}

      {dialog?.kind === "moveFolder" && (
        <PromptDialog
          title={t("ctx.move_to_folder")}
          mode="choice"
          // Wave 2: pickableFolders 는 inbox 가 이미 제외된 리스트 — 사용자가 inbox 로 노트를
          // 옮기는 진입 경로(기준 행동을 트리 pinned 섹션 자체의 컨텍스트 메뉴 외에 "move to
          // folder" 에서도 차단) 를 끊는다. 일반 폴더로의 이동만 선택지로 노출.
          choices={pickableFolders
            .filter((f) => f.id !== dialog.currentFolderId)
            .map((f) => ({
              value: f.id,
              label: f.name,
              icon: <IconFolder size={15} strokeWidth={1.8} />,
            }))}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const d = dialog;
            setDialog(null);
            void runMoveFolder(d.id, value as string);
          }}
        />
      )}

      {dialog?.kind === "changeStatus" && (
        <PromptDialog
          title={t("ctx.change_status_prompt")}
          mode="choice"
          // PromptDialog 의 choice value 는 string 이므로 "상태 없음"(= null)은 sentinel 로
          // 감쌌다가 onSubmit 에서 푼다. 현재 상태는 description 으로 표시한다 — 이 메뉴는
          // 바꾸는 곳이면서 "지금 뭐지"를 확인하는 곳이기도 하다.
          choices={statusOptions(customStatuses).map((opt) => {
            const value = opt.key === null ? NO_STATUS : opt.key;
            return {
              value,
              label: statusOptionLabel(opt, t),
              description: statusDescription(value, dialog.currentStatus),
              icon: opt.colorVar ? (
                <StatusDot color={opt.colorVar} size={15} />
              ) : (
                <span
                  aria-hidden
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: "50%",
                    border: "1.5px solid var(--faint)",
                    boxSizing: "border-box",
                  }}
                />
              ),
            };
          })}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const d = dialog;
            setDialog(null);
            const target: string | null = value === NO_STATUS ? null : (value as string);
            void setNoteStatus(d.id, target);
          }}
        />
      )}

      {folderReviewPlan && (
        <React.Suspense fallback={null}>
          <AiAgentReviewModal plan={folderReviewPlan} onClose={() => setFolderReviewPlan(null)} />
        </React.Suspense>
      )}
      {batchOrganizeIds && (
        <React.Suspense fallback={null}>
          <AiBatchOrganizeModal noteIds={batchOrganizeIds} onClose={() => setBatchOrganizeIds(null)} />
        </React.Suspense>
      )}
      {askAiTarget && (
        <Suspense fallback={null}>
          <AskAiModal target={askAiTarget} onClose={() => setAskAiTarget(null)} />
        </Suspense>
      )}
    </>
  );
}
