/**
 * 펫 우클릭 "클립보드 저장"(docs/PLAN-2026-08-08-presets-schedule.md Q9) — 메인 창 쪽 다리.
 *
 * 펫 창은 클립보드를 읽고(navigator.clipboard, 사용자 제스처) 텍스트만 방송한다. 라우팅에 필요한
 * 커맨드(link_preview·search_notes)와 실제 저장 경로(section_create_with_body·pet_note_create)는
 * 전부 PET_ALLOWED_COMMANDS 밖이라(src-tauri/src/pet_window.rs) 메인 창이 대행한다 —
 * petSuggestionsBridge.ts / petLinkBridge.ts 와 같은 다리 패턴이고, 같은 이유로 펫
 * allowlist 를 넓히지 않는다.
 *
 * 흐름:
 *   pet → main   "pet-clipboard-save"   { text }            우클릭 직후 읽은 클립보드 원문
 *   main → pet   커맨드 pet_bubble_clip { payload: JSON }   확인 카드(미리보기 + 행선지)
 *   pet → main   "pet-clipboard-accept" { choice }          사용자가 고른 행선지
 *   main → pet   커맨드 pet_bubble_notice                   결과 알림
 *
 * 라우팅(Q9):
 *  - 단독 URL → link_preview(기존 link_suggest 파이프라인의 무저장 형제: fetch + 요약 + 대상 노트
 *    제안). 게이트(ai_enabled && link_suggestions)는 그 커맨드 안 한 지점에서만 본다 — 여기서
 *    설정을 다시 읽어 판단하지 않는다. 게이트 OFF/실패면 ok:false 로 오고, 그때는 라우팅 없이
 *    "인박스에 그대로 저장" 확인만 띄운다.
 *  - 그 외 텍스트 → search_notes(FTS 검색, 시맨틱 제거 후 단독 경로) 상위 1건을 병합 후보로 제안.
 * LLM 호출은 URL 요약 한 번뿐이다 — URL/텍스트 판별은 기계식(soleUrlFromPasteText)이라 분류용
 * 모델 호출이 필요 없다.
 *
 * **확인 전에는 아무것도 저장하지 않는다**(Q9) — 제안은 suggestions 테이블이 아니라 아래 모듈
 * 변수에만 산다. ponytail: 한 번에 하나(카드도 하나다). 다음 "클립보드 저장"이 덮어쓰고, 앱을
 * 다시 켜면 사라진다 — 확정 전 상태를 영속할 이유가 없다.
 */
import { callSilent } from "../../../lib/invoke";
import type { LinkPreviewOutput } from "../../../lib/commands.gen";
import { listenMany } from "../../../lib/tauriListen";
import { soleUrlFromPasteText } from "../../../lib/urls";
import { PET_EVENT } from "./petEvents";
import { petSignal, PREVIEW_CHARS, saveToTargetOrInbox, searchTopHit } from "./petBridgeShared";

/** 이 파일은 메인 창에서 돌지만 아래 문구는 **펫 말풍선에** 뜬다 — 펫 창 계열은 i18n 스택을
 *  로드하지 않고 한국어 상수로만 말한다(src/plugins/pet/**, tray.rs 와 같은 관례). 여기만 번역하면
 *  펫이 말풍선마다 언어를 바꿔 말하게 되므로 그 관례를 따른다. */
const T = {
  routeFailed: "클립보드를 저장하지 못했어요.",
  saveFailed: "저장하지 못했어요.",
};

/** 확인 카드가 그대로 렌더하는 모양(src/plugins/pet/PetBubbleApp.tsx 와 1:1). */
export interface ClipCardPayload {
  preview: string;
  /** 병합 후보 노트 제목. null 이면 "인박스에 새 메모"만 제안한다. */
  target_title: string | null;
  /** 링크 경로였는지 — 카드 문구가 갈린다. */
  is_link: boolean;
}

/** 확인이 떨어지면 그대로 실행할 저장 계획. */
export interface PendingClip {
  body: string;
  title?: string;
  targetNoteId: string | null;
  targetTitle: string | null;
  isLink: boolean;
  /** 카드 미리보기 override. 없으면 본문 앞부분을 그대로 쓴다 — 익스텐션 클리핑
   *  (extClipBridge.ts)만 채운다: 본문 맨 앞이 선택 텍스트라 그대로 자르면 출처(페이지 제목/URL)가
   *  카드에서 사라진다. */
  preview?: string;
}

let pending: PendingClip | null = null;

/** 라우팅 — 클립보드 원문 하나에서 저장 계획을 만든다. 빈 문자열이면 null. */
export async function routeClipboardText(raw: string): Promise<PendingClip | null> {
  const text = raw.trim();
  if (!text) return null;

  const url = soleUrlFromPasteText(text);
  if (url) {
    // callSilent: 게이트 OFF·네트워크 실패에 토스트를 띄우지 않는다 — 실패는 에러가 아니라
    // "라우팅 없이 그대로 저장"으로의 강등이고, 그 사실은 카드 문구가 이미 말해 준다.
    const res = await callSilent<LinkPreviewOutput>("link_preview", { url }).catch(() => null);
    if (res?.ok) {
      return {
        body: `${res.summary}\n\n${url}`,
        title: res.title || undefined,
        targetNoteId: res.target_note_id ?? null,
        targetTitle: res.target_note_title ?? null,
        isLink: true,
      };
    }
    return { body: url, targetNoteId: null, targetTitle: null, isLink: true };
  }

  // 텍스트: 로컬 검색만 탄다(외부 전송 없음) — 그래서 링크와 달리 게이트가 없다.
  // ponytail: 점수 문턱을 두지 않는다. hybrid_search 의 RRF 점수는 질의마다 스케일이 달라
  // 절대 임계값이 의미가 없고, 최종 결정은 어차피 사용자가 카드에서 한다("새 메모"가 항상
  // 나란히 있다). 후보가 자꾸 엉뚱하면 그때 점수/랭크 조건을 여기 한 곳에 넣는 게 업그레이드 경로.
  const hit = await searchTopHit(text);
  return {
    body: text,
    targetNoteId: hit?.id ?? null,
    targetTitle: hit?.title ?? null,
    isLink: false,
  };
}

/** 저장 계획 → 카드 payload. 미리보기는 링크면 요약, 텍스트면 원문 앞부분. */
export function clipCardPayload(p: PendingClip): ClipCardPayload {
  return {
    preview: (p.preview ?? p.body).slice(0, PREVIEW_CHARS),
    target_title: p.targetTitle,
    is_link: p.isLink,
  };
}

/**
 * 텍스트 하나를 라우팅해 확인 카드까지 띄운다 — 펫 우클릭 "클립보드 저장"과 크롬 익스텐션
 * 클리핑(extClipBridge.ts)의 **공통 입구**다. 수락 처리(pending → 저장)는 두 경로가 같은
 * "pet-clipboard-accept" 를 쓰므로 여기 아래 handleAccept 한 곳에만 있으면 된다(화면 저장과
 * 달리 카드 kind 를 가르지 않는 이유: 저장 계획의 모양이 완전히 같다).
 */
export async function saveClipText(raw: string, preview?: string, title?: string): Promise<void> {
  try {
    const plan = await routeClipboardText(raw);
    if (!plan) return;
    // title: 텍스트 경로는 제목을 만들지 않는다 — 익스텐션 "페이지 저장"(body_text)이 페이지 제목을
    // 넘겨 새 메모 제목으로 쓴다. 링크 경로가 이미 제목을 얻었으면 그쪽이 우선.
    pending = { ...plan, ...(preview ? { preview } : {}), ...(title && !plan.title ? { title } : {}) };
    await callSilent("pet_bubble_clip", { payload: JSON.stringify(clipCardPayload(pending)) });
    petSignal("task-done");
  } catch {
    // callSilent() 이 이미 토스트를 띄웠다. 펫에게도 한 줄 알려 카드가 영영 안 뜨는 침묵을 막는다.
    petSignal("failure");
    await callSilent("pet_bubble_notice", { text: T.routeFailed, note_id: null }).catch(() => {});
  }
}

/** choice: "append" = 제안된 노트에 섹션 추가, "new" = 인박스에 새 메모. */
async function handleAccept(choice: string): Promise<void> {
  const p = pending;
  pending = null;
  if (!p) return;
  petSignal("work-start");
  try {
    const saved = await saveToTargetOrInbox({
      choice,
      targetNoteId: p.targetNoteId,
      targetTitle: p.targetTitle,
      title: p.title,
      body: p.body,
    });
    petSignal("success");
    const text =
      choice === "append" && p.targetNoteId
        ? `「${p.targetTitle}」에 추가했어요.`
        : `「${saved.noteTitle}」로 저장했어요.`;
    await callSilent("pet_bubble_notice", { text, note_id: saved.noteId });
  } catch {
    // callSilent() 이 이미 토스트를 띄웠다(대상 노트 삭제됨 등) — 펫 쪽도 침묵하지 않게.
    petSignal("failure");
    await callSilent("pet_bubble_notice", { text: T.saveFailed, note_id: null }).catch(() => {});
  }
}

/** App.tsx 마운트 시(펫 활성일 때만) 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenPetClipboardBridge(): () => void {
  const unlisten = listenMany([
    [PET_EVENT.clipboardSave, (e: { payload: { text: string } }) => void saveClipText(e.payload.text)],
    [PET_EVENT.clipboardAccept, (e: { payload: { choice: string } }) => void handleAccept(e.payload.choice)],
  ]);

  return () => {
    pending = null;
    unlisten();
  };
}
