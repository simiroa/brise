/**
 * 웨이브 ③ 테마 후행 제안(docs/PLAN-2026-08-08-presets-schedule.md Q1~Q3) — 펫 채팅의 테마 카드
 * "모으기" → 메인 창에서 LLM 1콜 + 체크리스트 노트 1개 생성.
 *
 * pet-bubble 은 note_get/모델 호출/pet_note_create 를 직접 못 부른다(PET_ALLOWED_COMMANDS 좁은
 * 표면, pet_window.rs) — petLinkBridge.ts/PetSuggestionReviewBridge.tsx 와 같은 이유로
 * pet-bubble 이 emit() 한 "pet-accept-theme-suggestion" 을 이 창이 받아 대신 처리한다.
 * 펫 allowlist 는 열지 않는다.
 *
 * Q3: **수락한 순간이 유일한 LLM 호출 시점**이다. 카드 문구는 노트 제목만으로 만들어져(0원)
 * 무시된 제안에는 API 비용이 들지 않는다. 만드는 것은 새 노트 하나뿐이고 원본 클러스터 노트는
 * 읽기만 한다 — Q4("append 는 자유, mutate 는 승인")의 무확인 축이라 칩 수락이 곧 승인이고
 * 별도 검토 모달이 없다(PetSuggestionReviewBridge 의 병합과 갈리는 지점).
 *
 * 본문은 flushAll() 후 note_get 으로 새로 읽는다(CLAUDE.md 함정 4 — activeNote.sections 는 캐럿
 * 보호로 갱신을 미룬다. 클러스터 노트 중 하나가 지금 열려 편집 중이었을 수 있다).
 *
 * App.tsx 는 마운트 시(펫이 켜져 있을 때만) listenPetThemeBridge() 를 한 번 등록한다 — UI가 없어
 * 컴포넌트일 이유가 없다. plugins/pet/bridge/petSuggestionsBridge.ts 와 같은 패턴.
 */
import { emit } from "@tauri-apps/api/event";
import { call, emitNotice, flushAll } from "../../../lib/invoke";
import { createInboxMemo } from "../../../lib/noteActions";
import { acceptSuggestion } from "./petSuggestionsBridge";
import { listenMany } from "../../../lib/tauriListen";
import { PET_EVENT } from "./petEvents";
import { useAiStore } from "../../../stores/ai";
import { UNTRUSTED_DATA_CLOSE, UNTRUSTED_DATA_OPEN } from "../../../stores/aiAgentActions";
import { t } from "../../../i18n/t";
import type { NoteDetail } from "../../../lib/commands.gen";

interface AcceptRequest {
  id: string;
  note_ids: string[];
}

/** 체크리스트 생성 지침. 노트 본문은 UNTRUSTED_DATA 로 감싸 "데이터지 지시가 아님"을 못박는다
 *  (aiAgentActions 의 계획 프롬프트와 같은 규칙). */
const CHECKLIST_GUIDANCE = [
  "아래는 사용자의 노트 여러 개다. 서로 비슷한 주제라 하나의 목록으로 모으려 한다.",
  "공통 주제를 파악해 **체크리스트 노트 하나**를 마크다운으로 작성하라.",
  "",
  "규칙:",
  "- 첫 줄은 제목만 쓴다(마크다운 기호 없이, 20자 이내).",
  "- 둘째 줄부터는 `- [ ] 항목` 형식의 체크리스트 줄만 쓴다.",
  "- 노트에 실제로 적힌 것만 옮긴다. 없는 항목을 지어내지 않는다.",
  "- 같은 뜻의 항목은 하나로 합친다.",
  "- 머리말·맺음말·설명을 붙이지 않는다.",
].join("\n");

const UNTITLED_LABEL = "(제목 없음)";

function buildPrompt(notes: NoteDetail[]): string {
  const context = notes
    .map((n) => {
      const body = n.sections.map((s) => s.body_md).join("\n\n");
      return `제목: ${n.note.title || UNTITLED_LABEL}\n${body}`;
    })
    .join("\n\n---\n\n");
  return `${CHECKLIST_GUIDANCE}\n\n${UNTRUSTED_DATA_OPEN}\n${context}\n${UNTRUSTED_DATA_CLOSE}`;
}

/**
 * 모델 응답을 (제목, 본문)으로 가른다. 지침대로면 첫 줄이 제목이지만, 작은 로컬 모델은 제목 줄을
 * 빼먹고 바로 체크리스트를 뱉는 일이 흔하다 — 그때는 전부 본문으로 넘기고 제목은 백엔드 기본값
 * (pet_note_create 의 자동 제목)에 맡긴다.
 */
export function splitChecklist(raw: string): { title?: string; body: string } {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const first = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n").trim();
  if (!rest || /^[-*+]\s*\[|^#{1,6}\s*$/.test(first)) return { body: trimmed };
  return { title: first.replace(/^#+\s*/, "").trim() || undefined, body: rest };
}

async function handleAccept(req: AcceptRequest): Promise<void> {
  try {
    await flushAll();
    // 삭제된 멤버는 조용히 빠진다 — 남은 노트만으로도 목록은 만들 수 있다.
    const settled = await Promise.allSettled(
      req.note_ids.map((id) => call<NoteDetail>("note_get", { id })),
    );
    const notes = settled
      .filter((r): r is PromiseFulfilledResult<NoteDetail> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((n) => n.sections.some((s) => s.body_md.trim()));
    if (notes.length < 2) {
      emitNotice(t("ai.theme_suggestion_empty"));
      return;
    }

    const raw = await useAiStore.getState().generateFromPrompt(buildPrompt(notes), null);
    if (!raw?.trim()) {
      emitNotice(t("ai.theme_suggestion_empty"));
      return;
    }
    const { title, body } = splitChecklist(raw);
    const created = await createInboxMemo(body, title);
    await acceptSuggestion(req.id);
    emitNotice(t("ai.theme_note_created", { title: created.title }));
  } catch {
    // callSilent() 이 이미 토스트를 띄웠다(노트 삭제됨, AI 미설정 등).
  } finally {
    // ponytail: acceptSuggestion 이 이미 새로고침한 성공 경로에서도 한 번 더 요청한다 — 조기
    // 반환(노트 부족·빈 응답)·실패 경로까지 한 곳에서 보장하는 게 매 분기마다 새로고침을 흩는
    // 것보다 간단하고, 중복 새로고침 자체는 무해하다(다음 폴링을 당겨올 뿐).
    void emit(PET_EVENT.suggestionsRefresh).catch(() => {});
  }
}

/** App.tsx 마운트 시(펫 활성일 때만) 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenPetThemeBridge(): () => void {
  return listenMany([
    [
      PET_EVENT.acceptThemeSuggestion,
      (e: { payload: AcceptRequest }) => void handleAccept(e.payload),
    ],
  ]);
}
