import React, { useMemo, useState } from "react";
import { useNotesStore } from "../../../stores/notes";
import { useSettingsStore } from "../../../stores/settings";
import { useSelectionStore } from "../../../stores/selection";
import { useArchiveStore } from "../../../stores/archive";
import { useTrashStore } from "../../../stores/trash";
import { runBatch, reportBatch, type BatchResult } from "../../../lib/batchActions";
import { addNoteTags, deleteNote, moveNote } from "../../../lib/noteActions";
import { showUndoToast } from "../../../lib/undo";
import { t } from "../../../i18n/t";
import { IconBook, IconFolder, IconSparkles, IconTag, IconTrash } from "../../icons";
import { PromptDialog } from "../../PromptDialog";
import { SelectionActionBar, SelectionActionButton } from "../../SelectionActionBar";
import { AiBatchOrganizeModal } from "../../../lazySurfaces";
import { preloadIntentProps } from "../../../lib/lazyPreload";



type Dialog = { kind: "move" } | { kind: "tag" } | { kind: "confirmDelete" } | { kind: "ai" };

/** 진행 표시를 켜는 문턱 — 이 아래는 눈 깜빡할 새라 표시가 오히려 깜빡임이 된다. */
const PROGRESS_MIN = 5;

/**
 * W7-g 노트 다중선택 액션 바. 2개 이상 선택했을 때만 뜬다(1개는 우클릭 메뉴가 이미 전부 한다).
 *
 * 실행은 전부 `runBatch` — 기존 단일 id 경로(`lib/noteActions.ts`, `stores/archive.ts`)를 순차로
 * 반복한다. 천장과 업그레이드 경로는 `lib/batchActions.ts` 헤더 주석 참고. 실패는 삼키지 않고
 * 개수를 알리며, 실패한 id 는 선택에 그대로 남겨 재시도할 대상이 화면에서 사라지지 않게 한다.
 */
export function NoteSelectionBar() {
  const selected = useSelectionStore((s) => s.notes.ids);
  const clearNotes = useSelectionStore((s) => s.clearNotes);
  const keepNotes = useSelectionStore((s) => s.keepNotes);
  const folders = useNotesStore((s) => s.folders);
  const inboxId = useNotesStore((s) => s.inboxId);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // ContextMenu 의 move-to-folder 와 같은 규칙 — 미분류(inbox)로 옮기는 경로는 노출하지 않는다.
  const pickableFolders = useMemo(
    () => (inboxId ? folders.filter((f) => f.id !== inboxId) : folders),
    [folders, inboxId],
  );

  if (selected.length < 2) return null;

  const run = async (fn: (id: string) => Promise<void>): Promise<BatchResult> => {
    const ids = [...selected];
    setBusy(true);
    setProgress(ids.length >= PROGRESS_MIN ? { done: 0, total: ids.length } : null);
    const res = await runBatch(ids, fn, (done, total) => {
      if (total >= PROGRESS_MIN) setProgress({ done, total });
    });
    setBusy(false);
    setProgress(null);
    reportBatch(res);
    // 성공한 것만 선택에서 뺀다 — 실패한 것은 남겨 재시도 대상이 그대로 보이게.
    keepNotes(res.failed);
    return res;
  };

  const runMove = (folderId: string) => void run((id) => moveNote(id, folderId));

  const runTag = (raw: string) => {
    // 쉼표 구분 — PromptDialog 의 단일 입력 하나로 여러 태그를 받는다.
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    void run((id) => addNoteTags(id, names));
  };

  const runArchive = () =>
    void (async () => {
      const res = await run((id) => useArchiveStore.getState().archiveNote(id));
      if (res.ok.length === 0) return;
      showUndoToast(t("archive.moved"), () => {
        void runBatch(res.ok, (id) => useArchiveStore.getState().unarchiveNote(id));
      });
    })();

  const runDelete = () =>
    void (async () => {
      const res = await run((id) => deleteNote(id));
      if (res.ok.length === 0) return;
      void useTrashStore.getState().loadTrash();
      showUndoToast(t("trash.moved"), () => {
        void runBatch(res.ok, (id) => useTrashStore.getState().restoreNote(id));
      });
    })();

  return (
    <>
      {/* W8-c: placement="panel" — notetree/index.tsx 가 이 컴포넌트를 트리 영역(position:relative)
          안에 렌더링한다. 화면 중앙 고정이던 것을 그 영역 하단으로 옮겨 선택 중인 목록과 가깝게
          붙인다(오너 피드백). */}
      <SelectionActionBar
        count={selected.length}
        onClear={clearNotes}
        busy={busy}
        progress={progress}
        placement="panel"
      >
        <SelectionActionButton
          label={t("ctx.move_to_folder")}
          icon={<IconFolder size={14} strokeWidth={1.8} />}
          onClick={() => setDialog({ kind: "move" })}
          disabled={busy || pickableFolders.length === 0}
          testid="selection-move"
        />
        <SelectionActionButton
          label={t("selection.add_tags")}
          icon={<IconTag size={14} strokeWidth={1.8} />}
          onClick={() => setDialog({ kind: "tag" })}
          disabled={busy}
          testid="selection-tag"
        />
        <SelectionActionButton
          label={t("archive.title")}
          icon={<IconBook size={14} strokeWidth={1.8} />}
          onClick={runArchive}
          disabled={busy}
          testid="selection-archive"
        />
        <SelectionActionButton
          label={t("selection.delete")}
          icon={<IconTrash size={14} strokeWidth={1.8} />}
          onClick={() => setDialog({ kind: "confirmDelete" })}
          disabled={busy}
          danger
          testid="selection-delete"
        />
        {aiEnabled && (
          <SelectionActionButton
            label={t("selection.ai_organize")}
            icon={<IconSparkles size={14} strokeWidth={1.8} />}
            onClick={() => setDialog({ kind: "ai" })}
            disabled={busy}
            testid="selection-ai"
            intentProps={preloadIntentProps(AiBatchOrganizeModal)}
          />
        )}
      </SelectionActionBar>

      {dialog?.kind === "move" && (
        <PromptDialog
          title={t("ctx.move_to_folder")}
          description={t("selection.n_selected", { n: selected.length })}
          mode="choice"
          choices={pickableFolders.map((f) => ({
            value: f.id,
            label: f.name,
            icon: <IconFolder size={15} strokeWidth={1.8} />,
          }))}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            setDialog(null);
            runMove(value as string);
          }}
        />
      )}

      {dialog?.kind === "tag" && (
        <PromptDialog
          title={t("selection.add_tags")}
          description={t("selection.add_tags_hint")}
          mode="input"
          placeholder={t("selection.add_tags_placeholder")}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            setDialog(null);
            runTag(value as string);
          }}
        />
      )}

      {/* 파괴적 액션은 배치 전체에 대해 **한 번만** 확인한다(항목마다 묻지 않는다). */}
      {dialog?.kind === "confirmDelete" && (
        <PromptDialog
          title={t("selection.delete_confirm_title", { n: selected.length })}
          description={t("selection.delete_confirm_body")}
          mode="confirm"
          danger
          confirmLabel={t("selection.delete")}
          onCancel={() => setDialog(null)}
          onSubmit={() => {
            setDialog(null);
            runDelete();
          }}
        />
      )}

      {/* AiBatchOrganizeModal 은 임의의 noteIds 목록을 받는다 — 문구도 "임포트"에 묶여 있지
          않아(§settings.migration_ai_* 는 "AI 정리 결과 검토") 그대로 재사용한다. */}
      {dialog?.kind === "ai" && (
        <React.Suspense fallback={null}>
          <AiBatchOrganizeModal noteIds={[...selected]} onClose={() => setDialog(null)} />
        </React.Suspense>
      )}
    </>
  );
}
