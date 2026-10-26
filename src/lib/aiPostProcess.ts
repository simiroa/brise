import { emitNotice } from "./invoke";
import { showToastOnly } from "./undo";
import { t } from "../i18n/t";
import { useAiStore } from "../stores/ai";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { AI_METADATA_FIELDS } from "../stores/aiPrompts";

/**
 * 후처리(post-process): AI가 노트에 새 본문을 넣은 직후, 같은 노트의 메타데이터(제목·태그·연도·
 * 지역+좌표·폴더·출처 URL)를 백그라운드로 "제안"한다. 쓰기는 절대 하지 않는다 — 기존 확인 모달
 * (AiConfirmModal, lastProposal 이 곧 열림 조건)을 그대로 거치고, 적용은 ai_apply_organize 한 번으로
 * 끝난다(stores/ai.ts::applyProposal).
 *
 * 새 파이프라인을 만들지 않는 이유: propose/apply 계약(ai_organize_note → lastProposal →
 * ai_apply_organize)이 이미 있고 필드 집합(AI_METADATA_FIELDS)도 고정이다. 여기서 하는 일은
 * "언제 그 계약을 자동으로 한 번 돌릴지"뿐이다.
 *
 * ponytail: 잡 큐 없음. 노트당 1건 in-flight(Set) + 진행 중이면 그냥 건너뛴다(재시도/대기열 없음).
 * 건너뛴 쪽은 같은 노트·같은 내용에 대한 중복 제안이라 잃는 게 없다. 큐가 필요해지는 건
 * "여러 노트에 동시에 AI를 돌리는" 흐름이 실제로 생겼을 때다.
 */

/** noteId → 진행 중. 노트당 한 번에 하나. */
const inFlight = new Set<string>();
/** noteId → "그 노트로 돌아오면 모달을 띄운다" 구독 해제. */
const deferred = new Map<string, () => void>();

/** vitest 전용 — 모듈 스코프 상태 초기화. */
export function _resetAiPostProcessForTests(): void {
  inFlight.clear();
  for (const cancel of deferred.values()) cancel();
  deferred.clear();
}

function activeNoteId(): string | undefined {
  return useNotesStore.getState().activeNote?.note.id;
}

/**
 * 사용자가 그 노트를 다시 열 때까지 제안을 들고 기다린다. 모달은 오직 lastProposal 로만 열리므로
 * (AiConfirmModal), 대기 중에는 스토어에서 비워 두고 복귀 시점에 다시 넣는다 — 다른 노트를 보고
 * 있는데 남의 노트 제안 모달이 튀어나오지 않게.
 *
 * ponytail: 대기 중 표시는 알림(emitNotice) 하나뿐, 지속 글로우는 없다. AI_GLOW_KEYS.tags 는 열려
 * 있는 노트의 타이틀바 태그 칩만 칠하므로(TitleBar.tsx) 안 보고 있는 노트에 켜 봐야 보이지 않는다.
 * 트리 행에 표시가 필요해지면 트리 행이 읽는 글로우 키를 새로 만드는 게 맞다.
 *
 * ponytail: 끝내 그 노트를 다시 열지 않으면(삭제 포함) 구독 하나가 세션 끝까지 남는다. 상한은
 * "제안이 걸린 노트 수"이고 리스너는 얕은 비교 하나뿐이라 방치한다 — 만료(TTL)가 필요해지는 건
 * 이게 실제로 쌓이는 사용 패턴이 관찰될 때다.
 */
function deferProposal(noteId: string, quiet = false): void {
  // 같은 노트에 새 제안이 오면 먼저 것을 버린다(최신 본문 기준 제안이 항상 옳다).
  deferred.get(noteId)?.();

  const unsub = useNotesStore.subscribe((s) => {
    if (s.activeNote?.note.id !== noteId) return;
    // A manual review is always more important than background metadata. Keep listening when it
    // is open; clearProposal() promotes the waiting proposal if this note remains active.
    if (!useAiStore.getState().restoreBackgroundProposal(noteId)) return;
    unsub();
    deferred.delete(noteId);
  });

  deferred.set(noteId, () => {
    unsub();
    deferred.delete(noteId);
  });

  if (!quiet) emitNotice(t("ai.postprocess_ready"));
}

/**
 * Fire-and-forget. 호출부(lib/aiSectionBridge.ts::insertAiSection)는 await 하지 않는다.
 * 실패는 조용히 삼킨다 — 사용자가 요청한 적 없는 백그라운드 작업이 에러 토스트를 띄우면 안 된다
 * (organizeCurrentNote 의 silent 인자 → callSilent).
 */
export async function schedulePostProcess(targetNoteId: string): Promise<void> {
  // 드래프트는 삽입 도중 실체화된다(aiSectionBridge::prepareAiInsertNoteId → ensureMaterialized)
  // 므로 호출부가 잡아 둔 id 는 자리표시자다. 실제로 섹션이 들어간 노트 = 지금 열려 있는 노트.
  const noteId = targetNoteId === "__draft__" ? activeNoteId() : targetNoteId;
  if (!noteId || noteId === "__draft__") return;
  if (!useSettingsStore.getState().aiPostProcess) return;
  if (inFlight.has(noteId)) return;

  const notes = useNotesStore.getState();
  // 노트가 아직 있나 — 열려 있거나 트리 인덱스에 있으면 있는 것.
  if (notes.activeNote?.note.id !== noteId && !notes.noteIndex.has(noteId)) return;

  const ai = useAiStore.getState();
  // 프론트 게이트 선확인(최종 판정은 항상 백엔드 privacy_gate_ok) — cleanupText 와 같은 관례.
  const gateOk = ai.translateGateOk ?? (await ai.refreshTranslateGate());
  if (!gateOk) return;

  inFlight.add(noteId);
  try {
    // 동적 import: aiPresets → aiSectionBridge → aiPostProcess 정적 순환을 만들지 않기 위해서다
    // (aiPresets.ts 가 이미 쓰는 관례 — `(await import("./notes"))`). AI_METADATA_FIELDS는
    // aiPrompts.ts(순수 상수, aiSectionBridge 의존 없음)로 옮겨져 위에서 정적으로 가져온다 —
    // 순환은 useAiPresetsStore(aiPresets.ts) 쪽에만 남는다.
    const { ensureEngineInstructions, getEngineInstruction } = await import("../stores/aiInstructions");
    await ensureEngineInstructions();
    // 사용자가 설정에서 편집한 metadata 액션의 guidance 를 그대로 쓴다 — 수동 실행과 같은 결과.
    const guidance = getEngineInstruction("metadata");
    await useAiStore
      .getState()
      .organizeCurrentNote(noteId, [...AI_METADATA_FIELDS], guidance, true);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[brise] ai post-process failed", e);
    return;
  } finally {
    inFlight.delete(noteId);
  }

  const proposal = useAiStore.getState().backgroundProposals.get(noteId);
  // 실패했으면 backgroundProposals에 제안이 없다(organizeCurrentNote가 조용히 삼켰다).
  if (!proposal) return;
  // AUDIT-2026-09-05-ai-guard-friction §2-1: 아직 그 노트를 보고 있어도 모달을 **자동으로 띄우지 않는다** —
  // 사용자가 방금 결과 프리뷰 게이트에서 [삽입]을 누른 직후라 모달이 연달아 두 개 뜨는 꼴이었다.
  // 대신 "보기" 버튼이 있는 토스트(10초)로 알리고, 누르면 그 자리에서 제안 모달을 연다. 놓치면
  // 아래 deferProposal 의 대기 구독이 노트를 다시 열 때 보여준다(제안은 버려지지 않는다).
  if (activeNoteId() === noteId) {
    showToastOnly(
      t("ai.postprocess_ready_view"),
      () => {
        // 토스트를 누른 시점에 다른 노트로 옮겼으면 남의 노트 제안을 띄우지 않는다 — 대기 구독이 처리.
        if (activeNoteId() !== noteId || !useAiStore.getState().restoreBackgroundProposal(noteId)) {
          emitNotice(t("ai.postprocess_ready"));
        }
      },
      { ttlMs: 10_000, actionLabel: t("ai.postprocess_view") },
    );
    deferProposal(noteId, true);
    return;
  }

  deferProposal(noteId);
}
