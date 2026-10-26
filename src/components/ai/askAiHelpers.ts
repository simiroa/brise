import { t } from "../../i18n/t";
import { emitNotice, flushAll } from "../../lib/invoke";
import { useAiStore, ensureAiAskGate } from "../../stores/ai";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { runAiAction } from "../../stores/runAiAction";
import { AI_METADATA_FIELDS, BUILTIN_DEFS, ENGINE_INSTRUCTION_DEFS, type AiActionPreset } from "../../stores/aiPrompts";
import { useNotesStore } from "../../stores/notes";
import { ensureEngineInstructions, getEngineInstruction } from "../../stores/aiInstructions";
import { getActiveSection, insertAiSection } from "../../lib/aiSectionBridge";

export async function noteBodyForAi(noteId: string): Promise<string | null> {
  const notes = useNotesStore.getState();
  if (notes.activeNote?.note.id !== noteId) {
    await notes.selectNote(noteId);
  } else {
    await flushAll();
  }
  const active = useNotesStore.getState().activeNote;
  if (active?.note.id !== noteId) return null;
  const live = getActiveSection();
  return active.sections.map((s) => (live && s.id === live.id ? live.body_md : s.body_md)).join("\n\n");
}

export function findPreset(id: string) {
  return useAiPresetsStore.getState().list.find((p) => p.id === id) ?? null;
}

/**
 * 바로 실행하는 빌트인 액션의 프리셋 — **AI 프리셋 목록(타일 문장)이 아니라** `BUILTIN_DEFS` 에서 만든다.
 * 관계도·시트 생성·수정·진행도·가지 펼치기처럼 형식 계약(JSON 규칙)이 있는 경로와, 텍스트 변환 장문(정리 등)을
 * 쓰는 경로가 이것을 탄다. 엔진 지침이면 문장은 사용자 재정의를 반영한 `getEngineInstruction` 이다.
 * (2026-09-28 검토: 목록 통합 뒤 이 경로들이 `findPreset` 으로 타일 문장을 받거나 null 을 받아 관계도·시트가 깨졌다.)
 */
export async function enginePreset(id: string): Promise<AiActionPreset | null> {
  const def = BUILTIN_DEFS.find((d) => d.id === id);
  if (!def) return null;
  const isEngine = ENGINE_INSTRUCTION_DEFS.some((d) => d.id === id);
  if (isEngine) await ensureEngineInstructions();
  return {
    id: def.id,
    // 이름은 목록의 것(사용자가 고친 타일 이름) — 만들어지는 섹션의 이름이 된다. 없으면 기본 이름.
    name: findPreset(id)?.name || t(def.nameKey),
    prompt: isEngine ? getEngineInstruction(id) : def.prompt,
    kind: def.kind,
    isBuiltin: true,
    hidden: false,
  };
}

export function metadataGuidance(): string | undefined {
  return getEngineInstruction("metadata") || undefined;
}

/**
 * 메타데이터 제안. 사용자가 고친 메타데이터 기준(엔진 지침)은 **늘 실리고**, `guidance`(AI 모달의 요청문)는 그
 * 뒤에 [요청] 으로 붙는다 — runMetadataFollowUp 과 같은 모양. 예전엔 요청문이 기준을 통째로 대신해, 어시스트가
 * AI 모달을 거치게 된 뒤 고친 기준이 어디서도 안 먹었다(2026-09-28 검토 S4).
 */
export async function runMetadataProposal(noteId: string, guidance?: string): Promise<void> {
  if (!(await ensureAiAskGate())) return;
  await ensureEngineInstructions();
  const request = guidance?.trim();
  const merged = [metadataGuidance(), request ? `[${t("ai.ctx_label_request")}]\n${request}` : ""].filter(Boolean).join("\n\n");
  await useAiStore.getState().organizeCurrentNote(noteId, [...AI_METADATA_FIELDS], merged || undefined);
}

/**
 * 메타데이터 스위치(AskAiModal, 2026-09-26)가 켜진 채 보낸 요청의 **후속** — 내용이 노트에 실제로 반영된
 * 뒤, 같은 요청에 맞춰 제목·태그·연도·지역을 고칠 제안을 띄운다(AiConfirmModal 이 필드별로 검토받는다).
 *
 * guidance 는 사용자가 고친 메타데이터 프리셋 지침을 **버리지 않고** 그 뒤에 요청을 붙인다 —
 * runMetadataProposal 의 guidance 는 프리셋 prompt 를 통째로 대신하므로 여기서 직접 합친다.
 * 폴더는 뺀다: "다듬기 + 메타데이터"가 노트를 다른 폴더로 옮기자고 하는 건 요청의 범위 밖이다.
 * organize 는 본문을 DB 에서 읽으므로(ai_organize_note) 먼저 flushAll — 선택 교체는 에디터로만 썼다.
 */
export const METADATA_FOLLOW_FIELDS = ["title", "tags", "year", "region"] as const;

export async function runMetadataFollowUp(noteId: string, instruction: string): Promise<void> {
  if (!(await ensureAiAskGate())) return;
  await ensureEngineInstructions();
  await flushAll();
  const request = instruction.trim();
  const guidance = [metadataGuidance(), t("ai.meta_follow_guidance"), request ? `[${t("ai.ctx_label_request")}]\n${request}` : ""]
    .filter(Boolean)
    .join("\n\n");
  await useAiStore.getState().organizeCurrentNote(noteId, [...METADATA_FOLLOW_FIELDS], guidance);
}

export async function runTagsProposal(noteId: string, guidance?: string): Promise<void> {
  if (!(await ensureAiAskGate())) return;
  await ensureEngineInstructions();
  await useAiStore.getState().organizeCurrentNote(noteId, ["tags"], guidance ?? metadataGuidance());
}

export async function runNoteSummary(noteId: string): Promise<void> {
  if (!(await ensureAiAskGate())) return;
  const contextText = await noteBodyForAi(noteId);
  if (contextText == null) return;
  if (!contextText.trim()) {
    emitNotice(t("editor.ai_empty_result"));
    return;
  }
  const preset = await enginePreset("summarize");
  if (!preset) return;
  await runAiAction(preset, { contextText, insertSection: insertAiSection, targetNoteId: noteId });
}
