import React, { useEffect, useState } from "react";
import { callSilent, emitNotice } from "../lib/invoke";
import type { Folder, NoteQueryOutput } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { IconFolder } from "../components/icons";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../stores/ai";
import { AiBatchOrganizeModal } from "../lazySurfaces";



/**
 * 한 번에 AI 정리에 넘기는 노트 수 상한 — 데스크톱 FolderOrganizeModal 의 노트 목록과 같은 200(note_query limit).
 * ponytail: AiBatchOrganizeModal 은 노트마다 ai_organize_note 를 한 번씩 부른다. 기본은 최근 30개, "더 보기"로 200개까지. 200 을 넘는 폴더는 최근 수정 순 앞 200개만
 * 정리된다(나머지는 한 번 더 돌리면 된다 — 정리된 미분류 노트는 폴더를 옮겨 빠지므로). 더 필요해지면 noteQueryCollect 로 페이지를 넘긴다.
 */
export const FOLDER_AI_NOTE_CAP = 200;
/**
 * 기본으로 가져오는 노트 수 — 폰에서 200개를 한 번에 돌리면 노트마다 AI 호출이라 수 분이 걸린다(AUDIT-2026-10-10 X-6/O-3).
 * 꽉 차게 왔으면 시작 전에 "더 보기"(FOLDER_AI_NOTE_CAP 으로 다시 조회)를 고를 수 있다.
 */
export const FOLDER_AI_DEFAULT_LIMIT = 30;

interface MobileFolderAiSheetProps {
  /** 현재 노트북의 미분류 폴더 id(없으면 null — ①이 꺼진다). */
  inboxId: string | null;
  /** 이 노트북의 모든 폴더(미분류 포함 — 미분류의 AI 읽기 금지 여부를 본다). */
  folders: Folder[];
  /** AI 가 켜져 있고 닿는가 — 아니면 두 항목 모두 끄고 이유를 보여 준다(MobileAiSheet 와 같은 안내). */
  aiReady: boolean;
  onClose: () => void;
}

type Step =
  | { kind: "menu" }
  | { kind: "pick" }
  | { kind: "more"; folderId: string; noteIds: string[] }
  | { kind: "batch"; noteIds: string[] };

/**
 * 노트 탭 ＋ → AI — **노트 내용이 아니라 폴더 관리용** 시트(오너 2026-10-10). 새 AI 로직은 없고 진입점만 있다:
 *  ① 미분류 노트 정리 — 미분류 폴더의 노트를 모아 AiBatchOrganizeModal(MobileBulkSelection 의 "AI 정리"와 같은 모달,
 *     ai_organize_note → 사용자가 고른 것만 ai_apply_organize)에 넘긴다.
 *  ② 폴더 골라 정리 — 폴더를 고르면 그 폴더의 노트로 같은 모달을 연다. 데스크톱 FolderOrganizeModal 의 "선택 AI 정리"
 *     (모든 노트를 고른 상태)와 같은 흐름이다.
 *  같은 모달의 "정리·병합 제안"(generateFolderOrganizePlan → AiAgentReviewModal)은 적용 단계가 `ai_apply_plan`(http:false —
 *  원격 호출 금지 커맨드)이라 폰에서 닿지 않는다. 그래서 그 줄은 꺼진 채 이유만 보여 준다.
 * 자동화 W1(폴더 규칙)이 오면 이 시트에 항목이 붙는다.
 */
export function MobileFolderAiSheet({ inboxId, folders, aiReady, onClose }: MobileFolderAiSheetProps) {
  const [step, setStep] = useState<Step>({ kind: "menu" });
  const [loading, setLoading] = useState(false);
  // 이 시트의 두 항목은 모두 같은 일괄 정리 모달로 끝난다 — 시트가 열릴 때(= 그 메뉴가 열릴 때) 미리 받는다.
  useEffect(() => {
    void AiBatchOrganizeModal.preload();
  }, []);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });

  const inbox = inboxId ? folders.find((f) => f.id === inboxId) ?? null : null;
  const inboxCount = inbox?.note_count ?? 0;
  const inboxReason = !inbox
    ? t("mobileFolderAi.inbox_missing")
    : inbox.ai_excluded
      ? t("folderOrganize.ai_excluded_disabled_tooltip")
      : inboxCount === 0
        ? t("mobileFolderAi.inbox_empty")
        : null;
  const pickable = folders.filter((f) => f.id !== inboxId);

  /** 폴더의 노트 id 를 모아 배치 모달로 넘긴다. 실패·빈 폴더면 시트에 머문다. */
  const startBatch = async (folderId: string, limit = FOLDER_AI_DEFAULT_LIMIT) => {
    setLoading(true);
    try {
      const res = await callSilent<NoteQueryOutput>("note_query", {
        folder_ids: [folderId],
        sort: "updated_desc",
        limit,
      });
      const ids = res.notes.map((n) => n.id);
      if (ids.length === 0) {
        emitNotice(t("mobileFolderAi.folder_no_notes"));
        return;
      }
      // 기본 한도가 꽉 찼으면 더 있을 수 있다 — 바로 시작할지 더 불러올지 고르게 한다.
      if (limit < FOLDER_AI_NOTE_CAP && ids.length >= limit) {
        setStep({ kind: "more", folderId, noteIds: ids });
        return;
      }
      setStep({ kind: "batch", noteIds: ids });
    } catch (e) {
      // callSilent 는 진단 로그만 남긴다 — 사용자에게는 데스크톱 폴더 정리와 같은 문구로 알린다.
      emitNotice(t("folderOrganize.load_failed", { msg: String((e as { message?: string })?.message ?? e) }));
    } finally {
      setLoading(false);
    }
  };

  if (step.kind === "batch") {
    return (
      <React.Suspense fallback={null}>
        <AiBatchOrganizeModal noteIds={step.noteIds} onClose={onClose} />
      </React.Suspense>
    );
  }

  if (step.kind === "more") {
    const { folderId, noteIds } = step;
    return (
      <MobileModal
        title={t("mobileFolderAi.more_title")}
        onClose={onClose}
        placement="bottom"
        footer={
          <button type="button" className="mobile-text-btn" onClick={() => setStep({ kind: "menu" })}>
            {t("common.cancel")}
          </button>
        }
      >
        <div className="mobile-ai-actions mobile-modal-options" data-testid="mobile-folder-ai-more">
          <div className="mobile-ai-disabled-hint">{t("mobileFolderAi.more_hint", { n: noteIds.length })}</div>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-folder-ai-start"
            onClick={() => setStep({ kind: "batch", noteIds })}
          >
            {t("mobileFolderAi.more_start", { n: noteIds.length })}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-folder-ai-load-more"
            disabled={loading}
            onClick={() => void startBatch(folderId, FOLDER_AI_NOTE_CAP)}
          >
            {t("mobileFolderAi.more_load", { n: FOLDER_AI_NOTE_CAP })}
          </button>
        </div>
      </MobileModal>
    );
  }

  if (step.kind === "pick") {
    return (
      <MobileModal
        title={t("mobileFolderAi.folder_pick_title")}
        onClose={onClose}
        placement="bottom"
        footer={
          <button type="button" className="mobile-text-btn" onClick={() => setStep({ kind: "menu" })}>
            {t("common.cancel")}
          </button>
        }
      >
        <div className="mobile-ai-actions mobile-modal-options" data-testid="mobile-folder-ai-picker">
          {loading && <div className="mobile-ai-disabled-hint">{t("mobileFolderAi.loading")}</div>}
          {pickable.length === 0 && <div className="mobile-empty">{t("ctx.move_no_folders")}</div>}
          {pickable.map((f) => (
            <button
              key={f.id}
              type="button"
              className="menu-row mobile-ai-action mobile-folder-ai-pick"
              disabled={loading || f.ai_excluded}
              title={f.ai_excluded ? t("folderOrganize.ai_excluded_disabled_tooltip") : undefined}
              data-testid={`mobile-folder-ai-pick-${f.id}`}
              onClick={() => void startBatch(f.id)}
            >
              <IconFolder size={15} strokeWidth={1.8} aria-hidden />
              <span className="mobile-folder-ai-pick-name">{f.name}</span>
              <span className="mobile-tree-row-count">{f.note_count}</span>
            </button>
          ))}
        </div>
      </MobileModal>
    );
  }

  return (
    <MobileModal
      title={t("mobileFolderAi.sheet_title")}
      onClose={onClose}
      placement="bottom"
      footer={
        <button type="button" className="mobile-text-btn" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      {!aiReady && <div className="mobile-ai-disabled-hint">{getAiDisabledHint(availability, "mobile")}</div>}
      <div className="mobile-ai-actions mobile-modal-options">
        <SheetRow
          testId="mobile-folder-ai-inbox"
          label={t("mobileFolderAi.inbox_organize")}
          hint={inboxReason ?? t("mobileFolderAi.inbox_hint")}
          disabled={!aiReady || loading || inboxReason !== null}
          onClick={() => inboxId && void startBatch(inboxId)}
        />
        <SheetRow
          testId="mobile-folder-ai-folder"
          label={t("mobileFolderAi.folder_organize")}
          hint={t("mobileFolderAi.folder_hint")}
          disabled={!aiReady || loading || pickable.length === 0}
          onClick={() => setStep({ kind: "pick" })}
        />
        {/* 데스크톱의 "정리·병합 제안" — 적용 커맨드(ai_apply_plan)가 원격 호출 금지라 폰에서는 늘 꺼져 있다. */}
        <SheetRow
          testId="mobile-folder-ai-plan"
          label={t("folderOrganize.batch_plan")}
          hint={t("mobileFolderAi.plan_desktop_only")}
          disabled
        />
      </div>
    </MobileModal>
  );
}

function SheetRow({
  testId,
  label,
  hint,
  disabled,
  onClick,
}: {
  testId: string;
  label: string;
  hint: string;
  disabled: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="menu-row mobile-ai-action mobile-folder-ai-row"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="mobile-folder-ai-row-label">{label}</span>
      <span className="mobile-folder-ai-row-hint">{hint}</span>
    </button>
  );
}
