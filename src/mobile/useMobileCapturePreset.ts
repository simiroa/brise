/**
 * 입력(capture) 화면의 시작 프리셋 줄 — 적용(본문 칠하기)·AI 시작 생성·"이미 적용됨" 래치.
 * 어떤 모양으로 칠하는지는 useMobileSectionView 가 쥐고, 여기는 프리셋 본문을 그리로 넘긴다.
 */
import { useState } from "react";
import { useNotesStore } from "../stores/notes";
import { useAiStore } from "../stores/ai";
import { emitNotice } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { t } from "../i18n/t";
import type { MobileBodyEditor } from "./useMobileBodyEditor";

export function useMobileCapturePreset(ed: MobileBodyEditor) {
  const { editor, sectionRef } = ed;
  const generateFromPrompt = useAiStore((s) => s.generateFromPrompt);
  // shouldShowCapturePresets 의 래치 — 할 일 목록 프리셋은 텍스트 노드 없는 HTML 이라 activeBodyEmpty 가 계속 true 다.
  const [presetApplied, setPresetApplied] = useState(false);

  // Capture-screen preset stack (owner feedback item 1) — calls the notes-store action directly,
  // NOT lib/presetBridge.ts: that bridge's applyPresetFn is only ever registered by desktop's
  // EditorPanel (registerApplyPreset), which never mounts here, so calling it on mobile would
  // silently no-op. useNotesStore.getState().applyPreset() is the same underlying action
  // EditorPanel's registered callback itself calls.
  //
  // Patches the editor directly instead of relying on the note-load effect (useMobileBodyEditor) to
  // repaint — that effect's "same section, same body" early-return races ensureMaterialized()
  // swapping activeNote (draft -> real note) out from under sectionRef mid-flow, and for the AI
  // preset specifically, relying on it would leave canEditBodyOnMobile() as the ONLY thing deciding
  // whether the just-generated body ever becomes visible: free-form LLM prose containing so much
  // as a markdown link serializes to `<a `, which flips the note read-only ("edit this on
  // desktop") on the very screen that just wrote it, even though the body did save server-side.
  // Always resolving `targetId` (not just when applyPreset's rare in-place-edit branch returns a
  // secId — capture is always a fresh draft, so that branch is normally unreachable) and always
  // syncing sectionRef + editor here makes the repaint deterministic regardless of which branch
  // ran or how ensureMaterialized's own set() interleaved with it.
  //
  // 맨 앞의 빈 본문 확인이 이 화면의 **유일한 길목 방어선**이다 — 프리셋 줄·더보기 시트·사용자 프리셋·AI 시작이 전부 여기를
  // 지난다. 줄 자체는 살아 있는 에디터가 비었을 때만 그려지지만(MobileDockSlot::dockSlotKind), AI 시작은 생성에 몇
  // 초가 걸려서 그 사이 사용자가 글을 칠 수 있고, 시트가 낡은 채 눌릴 수도 있다. 칠한 글 위에 프리셋을 덮으면
  // 되돌릴 길이 없다(초안은 서버 사본이 없고 폰엔 실행 취소가 없다) — notesActive.applyPreset 의 "프리셋은 본문을 덮지
  // 않는다" 규칙을 모바일은 안 지키고 있었다(모바일은 targetState 를 발행하지 않아 늘 ready 로 읽혀 제자리에 쓴다).
  // 건너뛴 사실은 진단에 남긴다(조용히 삼키지 않는다 — CLAUDE.md 함정 11).
  const applyCapturePreset = async (req: { title: string | null; bodyMd: string }) => {
    if (editor && !editor.isDestroyed && !editor.isEmpty) {
      reportFallback("mobile-capture-preset", "skipped_body_not_empty");
      return;
    }
    const secId = await useNotesStore.getState().applyPreset(req.bodyMd, req.title);
    setPresetApplied(true);
    if (!editor) return;
    const activeSections = useNotesStore.getState().activeNote?.sections;
    const targetId = secId ?? activeSections?.[activeSections.length - 1]?.id ?? sectionRef.current?.id;
    if (!targetId) return;
    ed.showPresetBody(targetId, req.bodyMd); // capture presets are always prose
  };

  // AI-start preset (owner feedback item 1) — same ai store call desktop's PresetList AI row makes
  // (generateFromPrompt with no existing context text); MobileCapturePresets owns the topic input
  // + pending UI and only calls this to get generated text back.
  const generateAiPreset = async (topic: string): Promise<string | null> => {
    const generated = await generateFromPrompt(topic, null);
    if (!generated || !generated.trim()) {
      emitNotice(t("editor.ai_empty_result"));
      return null;
    }
    return generated;
  };

  return { presetApplied, applyCapturePreset, generateAiPreset };
}
