/**
 * 펫 우클릭 "화면 저장"(docs/PLAN-2026-08-09-pet-capture.md Phase 1) — 메인 창 쪽 다리.
 *
 * petClipboardBridge.ts 와 **동형**이고 같은 이유로 존재한다: 펫 창은 캡처·검색·저장 커맨드를
 * 하나도 부를 수 없다(PET_ALLOWED_COMMANDS, src-tauri/src/pet_window.rs). 여기서도 펫
 * allowlist 를 넓히지 않고 메인 창이 전부 대행한다.
 *
 * 흐름:
 *   pet → main   "pet-screenshot-capture"  {}                   우클릭 메뉴 클릭
 *   main → main  커맨드 pet_screenshot_capture                  활성 창 캡처 + (게이트면) 비전 요약
 *   main → pet   커맨드 pet_bubble_clip { payload: JSON }        확인 카드(kind:"shot")
 *   pet → main   "pet-screenshot-accept"  { choice }            사용자가 고른 행선지
 *   main → pet   커맨드 pet_bubble_notice                        결과 알림
 *
 * 카드는 클립보드 저장과 **같은** 말풍선 카드를 재사용한다(pet_bubble_clip). 다만 수락 이벤트는
 * 갈라 둔다 — 두 다리가 같은 "pet-clipboard-accept" 를 들으면, 앞서 확인하지 않고 남겨 둔
 * 클립보드 계획이 화면 저장 수락 한 번에 함께 저장된다(이중 저장). payload 의 kind 가 그 분기를
 * 정하고, 판단은 PetBubbleApp.tsx 한 곳에서만 한다.
 *
 * 라우팅: 요약(없으면 창 제목)으로 search_notes 상위 1건을 병합 후보로 제안한다 —
 * petClipboardBridge 의 텍스트 경로와 같은 로컬 검색이라 게이트가 없다. **AI 게이트 OFF·비전
 * 실패는 캡처 에러가 아니라 `ai_summary_status` 로 온다. 그때도 이미지만 저장하고, **사유는
 * 본문 출처 줄에 한 줄로 남긴다**(AI_STATUS_NOTE) — 카드 미리보기가 본문을 자른 것이라 카드와
 * 노트 양쪽에 같은 설명이 따라간다.
 *
 * **확인 전에는 아무것도 저장하지 않는다** — 캡처한 PNG 는 아래 모듈 변수에만 산다(카드도
 * 하나다). ponytail: 다음 "화면 저장"이 덮어쓰고 앱을 다시 켜면 사라진다.
 */
import { call, callSilent } from "../../../lib/invoke";
import type { PetScreenshotCaptureOutput } from "../../../lib/commands.gen";
import { listenMany } from "../../../lib/tauriListen";
import { PET_EVENT } from "./petEvents";
import { petSignal, PREVIEW_CHARS, QUERY_CHARS, saveToTargetOrInbox, searchTopHit } from "./petBridgeShared";

/** petClipboardBridge 와 같은 이유로 한국어 상수 — 이 문구는 **펫 말풍선에** 뜬다(펫 창 계열은
 *  i18n 스택을 로드하지 않는다, petClipboardBridge.ts 의 같은 주석 참고). */
const T = {
  captureFailed: "화면을 저장하지 못했어요.",
  saveFailed: "저장하지 못했어요.",
  sourcePrefix: "화면 캡처",
};

/** 비전 요약이 없을 때 **왜** 없는지. 백엔드가 상태를 정확히 주는데도 아무 데도 안 뜨면
 *  사용자에게는 "요약이 그냥 안 나옴"으로 보인다 — 카드 미리보기와 저장되는 노트 본문 양쪽에
 *  같은 한 줄로 남긴다(본문에 넣으면 미리보기는 body 를 자르므로 저절로 따라온다).
 *  generated 는 사유가 없다(요약 자체가 결과다). */
const AI_STATUS_NOTE: Record<PetScreenshotCaptureOutput["ai_summary_status"], string> = {
  generated: "",
  disabled: "AI 요약 꺼짐",
  unsupported_or_failed: "AI 요약 실패",
  timeout: "AI 요약 시간 초과",
};

/** pet_bubble_clip 카드 payload. `kind:"shot"` 이 수락 이벤트를 가른다(PetBubbleApp.tsx 와 1:1). */
export interface ShotCardPayload {
  kind: "shot";
  preview: string;
  target_title: string | null;
  is_link: false;
}

/** 확인이 떨어지면 그대로 실행할 저장 계획. */
export interface PendingShot {
  body: string;
  title: string;
  name: string;
  dataBase64: string;
  /** 백엔드가 명시한 비전 요약 결과. 본문이 비어도 원인을 잃지 않는다. */
  aiSummaryStatus: PetScreenshotCaptureOutput["ai_summary_status"];
  targetNoteId: string | null;
  targetTitle: string | null;
}

let pending: PendingShot | null = null;
/** 진행 중인 캡처가 있는가. 캡처+비전 요약은 최대 75초라(transport.rs VISION_OPERATION_DEADLINE)
 *  그 사이 메뉴를 다시 누르기 쉽다. 두 번째 캡처가 pending 을 덮으면 화면에 뜬 카드와 저장될
 *  계획이 어긋난다(A 의 카드를 보고 수락했는데 B 가 저장됨) — 그래서 진행 중 재요청은 버린다.
 *  ponytail: 큐를 두지 않는다. 캡처는 "지금 이 화면"이라 나중에 처리하는 건 의미가 없다. */
let capturing = false;

/** 노트에 실제로 들어갈 본문. 요약이 없으면 출처 한 줄만 남는다(이미지가 본체다) — 그 줄에
 *  요약이 없는 사유를 덧붙여 노트에도 카드에도 원인이 남게 한다.
 *  쌍둥이: 펫 없는 트레이 경로(요약 없음)는 Rust `commands::pet::screenshot_note_body` — 문구를 바꾸면 둘 다. */
export function screenshotBody(
  windowTitle: string,
  summary: string,
  status: PetScreenshotCaptureOutput["ai_summary_status"] = "generated",
): string {
  const note = AI_STATUS_NOTE[status];
  const source = `${T.sourcePrefix}: ${windowTitle || "제목 없는 창"}${note ? ` · ${note}` : ""}`;
  return summary.trim() ? `${summary.trim()}\n\n${source}` : source;
}

/** 캡처 결과 하나에서 저장 계획을 만든다 — 대상 노트 후보는 로컬 검색 1건. */
export async function routeCapture(shot: PetScreenshotCaptureOutput): Promise<PendingShot> {
  const body = screenshotBody(shot.title, shot.summary, shot.ai_summary_status);
  // 요약이 없으면 창 제목이 유일한 단서다. 둘 다 없으면 검색을 아예 돌리지 않는다(빈 질의로
  // 뽑은 후보는 "관련 있어 보이는 아무 노트"라 오히려 해롭다).
  const query = (shot.summary.trim() || shot.title.trim()).slice(0, QUERY_CHARS);
  const hit = await searchTopHit(query);
  return {
    body,
    title: shot.title,
    name: shot.name,
    dataBase64: shot.data_base64,
    aiSummaryStatus: shot.ai_summary_status,
    targetNoteId: hit?.id ?? null,
    targetTitle: hit?.title ?? null,
  };
}

export function shotCardPayload(p: PendingShot): ShotCardPayload {
  return {
    kind: "shot",
    preview: p.body.slice(0, PREVIEW_CHARS),
    target_title: p.targetTitle,
    is_link: false,
  };
}

async function handleCapture(): Promise<void> {
  if (capturing) return; // 진행 중 재요청은 버린다(capturing 주석 참고).
  capturing = true;
  try {
    const shot = await call<PetScreenshotCaptureOutput>("pet_screenshot_capture", {});
    const plan = await routeCapture(shot);
    pending = plan;
    await call("pet_bubble_clip", { payload: JSON.stringify(shotCardPayload(plan)) });
    petSignal("task-done");
  } catch {
    // callSilent() 이 이미 토스트를 띄웠다(설정 OFF · 캡처할 창 없음 등). 펫에게도 한 줄 알려
    // 카드가 영영 안 뜨는 침묵을 막는다 — petClipboardBridge 와 같은 처리.
    pending = null;
    petSignal("failure");
    await callSilent("pet_bubble_notice", { text: T.captureFailed, note_id: null }).catch(() => {});
  } finally {
    capturing = false;
  }
}

/** choice: "append" = 제안된 노트에 섹션 추가, "new" = 인박스에 새 메모. 어느 쪽이든 이미지를
 *  같은 노트에 첨부한다 — 첨부는 기존 경로(attachment_add_bytes, 에디터 이미지 붙여넣기와
 *  동일)를 그대로 쓴다. ponytail: 첨부가 실패해도 본문 저장은 되돌리지 않는다(요약 텍스트라도
 *  남는 편이 낫다). 롤백이 필요해지면 여기 한 곳.
 *
 *  두 단계를 **따로** 잡는다: 예전엔 하나의 try 라서 첨부만 실패해도 "저장하지 못했어요"가 떴다 —
 *  노트는 멀쩡히 저장돼 있는데 사용자는 없는 줄 알고 다시 찍는다. */
async function handleAccept(choice: string): Promise<void> {
  const p = pending;
  pending = null;
  if (!p) return;
  petSignal("work-start");

  let noteId: string;
  let noteTitle: string;
  try {
    const saved = await saveToTargetOrInbox({
      choice,
      targetNoteId: p.targetNoteId,
      targetTitle: p.targetTitle,
      title: p.title || undefined,
      body: p.body,
    });
    noteId = saved.noteId;
    noteTitle = saved.noteTitle;
  } catch {
    // 여기서 실패했을 때만 "아무것도 안 남았다"가 참이다.
    petSignal("failure");
    await callSilent("pet_bubble_notice", { text: T.saveFailed, note_id: null }).catch(() => {});
    return;
  }

  try {
    await call("attachment_add_bytes", { note_id: noteId, name: p.name, data_base64: p.dataBase64 });
  } catch {
    petSignal("failure");
    // 노트는 있다 — note_id 를 실어 보내 말풍선을 누르면 그 노트로 갈 수 있게 한다.
    await callSilent("pet_bubble_notice", {
      text: `「${noteTitle}」에 저장했지만 이미지 첨부에 실패했어요.`,
      note_id: noteId,
    }).catch(() => {});
    return;
  }

  petSignal("success"); // remote-note-write 와 이중이지만 1.5초 burst 병합이 흡수한다.
  await call("pet_bubble_notice", { text: `「${noteTitle}」에 저장했어요.`, note_id: noteId });
}

/** App.tsx 마운트 시(펫 활성일 때만) 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenPetScreenshotBridge(): () => void {
  const unlisten = listenMany([
    [PET_EVENT.screenshotCapture, () => void handleCapture()],
    [PET_EVENT.screenshotAccept, (e: { payload: { choice: string } }) => void handleAccept(e.payload.choice)],
  ]);

  return () => {
    pending = null;
    capturing = false;
    unlisten();
  };
}
