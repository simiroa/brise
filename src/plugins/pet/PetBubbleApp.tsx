import { useCallback, useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { listenMany } from "../../lib/tauriListen";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { IconClose } from "../../components/icons";
import type {
  PetBubbleStateOutput,
  PetChatHistoryOutput,
  PetNoteCreateOutput,
  Suggestion,
} from "../../lib/commands.gen";
import { runChatPipeline } from "../../lib/chatPipeline";
import { PetChat, type PetChatItem } from "./PetChat";
import { ErrorBoundary } from "../../components/common/ErrorBoundary";
import { PET_REVIEW_CHAT_PLAN_EVENT } from "./bridge/petChatPlan";
import { PET_APPLY_CHAT_SECTION_EVENT } from "./bridge/petChatSection";
import {
  applyHistory,
  isSessionSwitch,
  PET_CHAT_UPDATED_EVENT,
  type PetChatUpdatedPayload,
} from "./bridge/petChatHistory";
import { pickRenderableSuggestion, type PendingSuggestion } from "./bridge/petSuggestionCards";
import { emitSuggestionAccept, emitSuggestionDismiss, emitSuggestionsRefresh } from "./petSuggestionActions";
import { usePetTheme } from "./usePetTheme";
import { applySavedAppearanceSeed } from "../../lib/appearance";
// W8-h: PetApp.tsx 와 같은 이유(주석 참고) — mobile/MobileApp.tsx 판례를 따라 엔트리에서 직접 로드.
import "../../styles/tokens.css";
import "./petwindow.css";
import "./pet.css";

// WAVE K — React 렌더 이전에 동기로 외형 시드 적용 (첫 페인트 스타일 지연 깜빡임 방지)
applySavedAppearanceSeed();

/**
 * 말풍선/채팅 창(#/pet-bubble). 캐릭터 창과 **별개 창**이라 여기서 무슨 일이 일어나든 펫은
 * 움직이지도 사라지지도 않는다 — 그것이 창을 나눈 목적이다(src-tauri/src/pet_window.rs 헤더).
 *
 * 두 모드가 한 창을 공유한다:
 *  - notice  짧은 알림 한 줄. 내용 높이를 재서 창을 그 높이로 맞춘다(예전 84px 잘림의 해소).
 *  - chat    최신 3말풍선 + 1줄 입력(docs/PET.md). 창 크기는 Rust 가 고정.
 * 두 모드가 시각적으로 같은 말풍선 하나이므로 창을 또 나누지 않는다.
 *
 * 창의 생성/파괴/크기/위치는 전부 Rust 소유다. 여기서는 내용만 그리고, 알림일 때 높이를 알린다.
 * 펫 창과 마찬가지로 풀 앱 부팅을 생략하므로 문구는 한국어 상수(i18n 스택 없음).
 */

const T = {
  failed: "잘 안 됐어요. 잠시 뒤 다시 시도해 주세요.",
  aiOff: "AI가 꺼져 있어요. 설정 > AI에서 켜면 대화할 수 있어요.",
  saved: "메모로 저장했어요.",
  close: "닫기",
  clipCancel: "안 할래요",
  clipNew: "새 메모",
  clipAppend: "이 노트에 추가",
  clipSave: "저장",
  // W13: ErrorBoundary.fallbackTitle for the chat surface below. Kept as a hardcoded Korean
  // string (not t()) to match this file's existing convention — see PetChat.tsx's own header
  // comment: the pet window intentionally never loads the i18n stack (tray.rs 관례) so its bundle
  // stays tiny.
  chatCrashed: "채팅을 표시할 수 없어요",
};

interface Payload {
  mode: string;
  text: string;
  note_id: string | null;
}

/** pet_conversation_save 의 프론트 경계. 백엔드는 원문과 요약을 각각 섹션으로 만들고,
 * 날짜·출처 같은 메타데이터를 자동으로 주입한다. 렌더링 데이터의 칩/검색 결과는 저장하지 않고
 * 실제 대화 턴만 보낸다. */
interface PetConversationMessageInput {
  role: "user" | "assistant";
  text: string;
  created_at?: string;
}

// pet-suggestions-pending 이벤트의 Suggestion[] → 렌더 가능한 첫 카드 파싱은
// bridge/petSuggestionCards.ts(PendingSuggestion/pickRenderableSuggestion, 위 import)로 옮겨져
// PetBubbleApp/SidebarChat 두 소비자가 재사용한다 — 예전엔 이 파일에 로컬 복제본이 있었다.

/** mode='clip' 말풍선의 payload.text — 메인 창 다리가 만든 JSON(src/plugins/pet/bridge/petClipboardBridge.ts
 *  ClipCardPayload 와 1:1). 저장은 아직 **아무것도** 일어나지 않았다: 이 카드의 버튼이 유일한
 *  방아쇠다(docs/PLAN-2026-08-08-presets-schedule.md Q9 "확인 후에만 저장").
 *
 *  kind: 어느 다리가 이 카드를 띄웠는지 — 없으면 클립보드 저장(기존), "shot" 이면 화면 저장
 *  (src/plugins/pet/bridge/petScreenshotBridge.ts). 카드 UI 는 완전히 같고 **수락 이벤트만 갈린다**: 두 다리가
 *  같은 이벤트를 들으면 아직 확인하지 않은 다른 쪽 계획까지 함께 저장된다(이중 저장). */
interface ClipCardPayload {
  preview: string;
  target_title: string | null;
  is_link: boolean;
  kind?: string;
}

function parseClipCard(text: string): ClipCardPayload | null {
  try {
    const p = JSON.parse(text) as ClipCardPayload;
    return typeof p?.preview === "string" ? p : null;
  } catch {
    return null;
  }
}

/** 카드 종류별 수락 이벤트 — 다리와 1:1(위 kind 주석 참고). */
export function clipAcceptEvent(kind: string | undefined): string {
  return kind === "shot" ? "pet-screenshot-accept" : "pet-clipboard-accept";
}

/** 카드 문구 — 행선지를 문장 안에 그대로 노출한다("행선지 표시", Q9). */
function clipCardText(p: ClipCardPayload): string {
  const what = p.kind === "shot" ? "이 화면" : p.is_link ? "이 링크" : "이 내용";
  return p.target_title
    ? `${what}, 「${p.target_title}」에 이어 붙일까요? 아니면 새 메모로 둘까요?`
    : `${what}, 인박스에 새 메모로 저장할까요?`;
}

export function PetBubbleApp() {
  const { aiEnabled, chatWriteEnabled } = usePetTheme();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [items, setItems] = useState<PetChatItem[]>([]);
  // Restored history is useful context but should not be duplicated when the user saves this session.
  const [sessionItems, setSessionItems] = useState<PetChatItem[]>([]);
  const [closeRequest, setCloseRequest] = useState(0);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const sendGenRef = useRef(0);
  const [gateOff, setGateOff] = useState(false);
  const aiOff = !aiEnabled || gateOff;
  useEffect(() => {
    if (aiEnabled) setGateOff(false);
  }, [aiEnabled]);
  // 겹침 제안(P2 2단계) — 카드에 필요한 표시 데이터 + "검토하기"에 넘길 두 노트 id.
  const [suggestion, setSuggestion] = useState<PendingSuggestion | null>(null);
  // 클립보드 확인 카드에서 행선지를 이미 골랐는가 — 중복 저장 방지(acceptClip 참고).
  const [clipSent, setClipSent] = useState(false);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  // 마운트 직후 내용을 가져온다(창을 만들 때 Rust 가 담아 둔다 — URL 로 텍스트를 실어 보내면
  // 이스케이프 문제가 생긴다). 창이 살아 있는 동안 내용이 갈리면 이벤트로 온다.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void callSilent<PetBubbleStateOutput>("pet_bubble_state", {})
      .then((p) => {
        if (!cancelled) setPayload({ mode: p.mode, text: p.text, note_id: p.note_id ?? null });
      })
      .catch(() => {});
    void listen<Payload>("pet-bubble-payload", (e) => setPayload(e.payload)).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 채팅 모드에 들어오면 이전 대화를 복원한다.
  useEffect(() => {
    if (payload?.mode !== "chat") return;
    let cancelled = false;
    setSessionItems([]);
    setCloseRequest(0);
    void callSilent<PetChatHistoryOutput>("pet_chat_history", {})
      .then((res) => {
        if (cancelled) return;
        setItems((prev) => applyHistory(res.messages, prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [payload?.mode]);

  useEffect(() => {
    if (payload?.mode !== "chat") return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<PetChatUpdatedPayload>(PET_CHAT_UPDATED_EVENT, (e) => {
      if (cancelled) return;
      // 응답 대기 중 세션이 바뀌면(트레이·펫 "새 세션 열기", 사이드바, 폰) 그 답은 시작 세션에
      // 저장된다(pet_chat_turn) — 여기 붙이지 않고 대기를 끊은 뒤 새 라이브를 다시 읽는다.
      if (pendingRef.current && isSessionSwitch(e.payload?.reason)) {
        sendGenRef.current += 1;
        pendingRef.current = false;
        setPending(false);
      }
      if (pendingRef.current) return;
      void callSilent<PetChatHistoryOutput>("pet_chat_history", {})
        .then((res) => {
          if (cancelled || pendingRef.current) return;
          setItems((prev) => applyHistory(res.messages, prev));
        })
        .catch(() => {});
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [payload?.mode]);

  // 캐릭터 창을 다시 클릭해 닫는 경로도 채팅 창의 저장 확인을 거친다. Rust는 창을 바로
  // 파괴하지 않고 이 이벤트만 보내며, 실제 닫기는 아래 PetChat의 선택 결과가 소유한다.
  useEffect(() => {
    if (payload?.mode !== "chat") return;
    // 핸들러가 cancelled 를 직접 보므로 플래그는 남기고, listen 보일러플레이트만 listenMany 에 맡긴다.
    let cancelled = false;
    const unlisten = listenMany([
      [
        "pet-bubble-close-request",
        () => {
          if (!cancelled) setCloseRequest((current) => current + 1);
        },
      ],
    ]);
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [payload?.mode]);

  // 후행 제안(P2 2/3단계) — 채팅 모드에 들어오면 메인 창에 즉시 새로고침을 요청하고(60초를 기다리지
  // 않는다), 이후 브로드캐스트를 구독한다. 이 창은 suggestions_list 를 직접 못 부른다
  // (PET_ALLOWED_COMMANDS 좁은 표면, pet_window.rs) — 메인 창(plugins/pet/bridge/petSuggestionsBridge.ts)이
  // 조회를 대신하고 "pet-suggestions-pending" 으로 알려준다. v1: 여러 개여도 한 번에 하나만 보여준다.
  useEffect(() => {
    if (payload?.mode !== "chat") return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{ suggestions: Suggestion[] }>("pet-suggestions-pending", (e) => {
      if (cancelled) return;
      setSuggestion(pickRenderableSuggestion(e.payload.suggestions));
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    void emitSuggestionsRefresh();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [payload?.mode]);

  // 알림/클립보드 카드 모드: 실제 내용 높이를 재서 창을 맞춘다. 예전에는
  // `max-height: 84px; overflow: hidden` 이라 긴 알림이 조용히 잘렸다 — 이제 창이 내용을
  // 따라가고, 상·하한은 Rust 가 건다(pet_window.rs, mode 가 chat 이 아니면 모두 이 경로).
  useEffect(() => {
    if (payload?.mode !== "notice" && payload?.mode !== "clip") return;
    const el = noticeRef.current;
    if (!el) return;
    // getBoundingClientRect = 테두리 포함 실측. +2 는 box-shadow 가 창 밖에서 잘리지 않도록.
    void callSilent("pet_bubble_resize", { height: Math.ceil(el.getBoundingClientRect().height) + 2 }).catch(() => {});
  }, [payload]);

  // 새 클립보드 카드가 오면 잠금을 푼다 — 앞서 한 번 저장했다고 다음 카드까지 눌리지 않으면
  // 두 번째 "클립보드 저장"이 죽은 카드로 보인다(같은 창을 재사용하므로 마운트가 안 새로 된다).
  useEffect(() => {
    if (payload?.mode === "clip") setClipSent(false);
  }, [payload]);

  const close = useCallback(() => {
    void callSilent("pet_bubble_close", {}).catch(() => {});
  }, []);

  /** 클립보드 저장 확인(Q9) — 이 창은 저장 커맨드를 못 부른다(좁은 allowlist). 고른 행선지만
   *  메인 창에 알리고, 결과는 메인 창이 pet_bubble_notice 로 이 자리에 덮어쓴다. 그 사이 카드가
   *  계속 눌리면 같은 내용이 두 번 저장되므로 버튼을 잠근다. */
  const acceptClip = useCallback(
    (choice: "append" | "new", kind: string | undefined) => {
      setClipSent(true);
      void emit(clipAcceptEvent(kind), { choice }).catch(() => setClipSent(false));
    },
    [],
  );

  const openNote = useCallback((noteId?: string) => {
    void callSilent("pet_open_main", noteId ? { note_id: noteId } : {}).catch(() => {});
  }, []);

  const openPlan = useCallback((item: PetChatItem) => {
    if (item.sectionBody && !item.sectionInserted) {
      void emit(PET_APPLY_CHAT_SECTION_EVENT, {
        title: item.sectionTitle,
        body: item.sectionBody,
        note_id: item.noteId,
      }).catch(() => {});
      void callSilent("pet_open_main", item.noteId ? { note_id: item.noteId } : {}).catch(() => {});
      setItems((prev) =>
        prev.map((row) => (row === item ? { ...row, sectionInserted: true } : row)),
      );
      return;
    }
    const index = items.findIndex((row) => row === item);
    const before = index >= 0 ? items.slice(0, index) : items;
    const prevUser = [...before].reverse().find((row) => row.role === "user");
    void emit(PET_REVIEW_CHAT_PLAN_EVENT, {
      plan_kind: item.planKind,
      note_id: item.noteId,
      instruction: prevUser?.text,
    }).catch(() => {});
    void callSilent("pet_open_main", item.noteId ? { note_id: item.noteId } : {}).catch(() => {});
  }, [items]);

  const dismissSuggestion = useCallback(() => {
    if (!suggestion) return;
    const id = suggestion.id;
    setSuggestion(null);
    void emitSuggestionDismiss(id);
  }, [suggestion]);

  /** 새 커맨드를 만들지 않는다 — pet_open_main(기존, 노트 클릭과 같은 경로)으로 메인 창을
   *  포커스·노트 선택까지 시키고, emit() 으로 병합 검토에 필요한 나머지(두 id)를 얹어 보낸다.
   *  메인 창은 App.tsx 의 PetSuggestionReviewBridge 가 "pet-review-suggestion" 을 받아 처리한다. */
  const reviewSuggestion = useCallback(() => {
    if (!suggestion || suggestion.kind !== "overlap") return;
    const { noteId } = suggestion;
    setSuggestion(null);
    void emitSuggestionAccept(suggestion);
    void callSilent("pet_open_main", { note_id: noteId }).catch(() => {});
    close();
  }, [suggestion, close]);

  /** kind='link' 카드의 "추가하기" — append는 자유(Q4), 확인 모달 없이 바로 실행한다. 메인 창의
   *  App.tsx PetSuggestionLinkBridge 가 "pet-accept-link-suggestion" 을 받아 대상 노트에 섹션을
   *  append(또는 대상이 없으면 인박스에 새 노트를)하고 suggestion을 accepted로 표시한다 —
   *  reviewSuggestion과 달리 메인 창을 포커스하지 않는다(모달을 여는 게 아니라 조용한 배경
   *  액션이라, 펫 창에 계속 머물러도 된다). */
  const acceptLinkSuggestion = useCallback(() => {
    if (!suggestion || suggestion.kind !== "link") return;
    const accepted = suggestion;
    setSuggestion(null);
    void emitSuggestionAccept(accepted);
  }, [suggestion]);

  /** kind='theme' 카드의 "모으기" — 여기서 처음이자 유일하게 LLM 1콜이 돈다(Q3: 무시된 제안에
   *  API 비용 0원). 메인 창의 petThemeBridge.ts 가 클러스터 노트 본문을 읽어 체크리스트
   *  노트 **하나를 새로 만든다** — 원본 노트는 건드리지 않으므로 Q4("append는 자유, mutate는
   *  승인")의 무확인 축이고, 칩 수락이 곧 승인이다. acceptLinkSuggestion 과 같은 조용한 배경
   *  액션이라 메인 창을 포커스하지 않는다. */
  const acceptThemeSuggestion = useCallback(() => {
    if (!suggestion || suggestion.kind !== "theme") return;
    const accepted = suggestion;
    setSuggestion(null);
    void emitSuggestionAccept(accepted);
  }, [suggestion]);

  /** kind='collect' 카드의 "정리하기" — reviewSuggestion과 같은 이유로 메인 창을 포커스한다:
   *  결과가 기존 organize propose/apply 계약(AiConfirmModal)으로 뜨므로 사용자가 봐야 하는 조작
   *  이지, acceptLinkSuggestion/acceptThemeSuggestion 같은 조용한 배경 액션이 아니다. 실제
   *  acceptSuggestion + organizeCurrentNote 호출은 메인 창의 petCollectBridge.ts가
   *  "pet-accept-collect-suggestion" 을 받아 대신 한다(pet-bubble은 둘 다 직접 못 부른다,
   *  PET_ALLOWED_COMMANDS 좁은 allowlist). */
  const acceptCollectSuggestion = useCallback(() => {
    if (!suggestion || suggestion.kind !== "collect") return;
    const { noteId } = suggestion;
    const prevSuggestion = suggestion;
    setSuggestion(null);
    // C(AUDIT-2026-09-26): SidebarChat.tsx의 같은 카드와 짝이 되는 수정 — emit() 자체가
    // 실패하면(드물지만 IPC 채널 문제 등) 카드는 사라졌는데 메인 창엔 아무 요청도 안 갔다.
    // 창을 곧장 닫긴 하지만(다음 줄 close()), 그 사이 실패가 잡히면 카드를 되돌려 둔다.
    void emitSuggestionAccept(prevSuggestion).then((ok) => {
      if (!ok) setSuggestion(prevSuggestion);
    });
    void callSilent("pet_open_main", { note_id: noteId }).catch(() => {});
    close();
  }, [suggestion, close]);

  const send = useCallback(async (text: string) => {
    const userCreatedAt = new Date().toISOString();
    const userItem: PetChatItem = { role: "user", text, createdAt: userCreatedAt };
    const gen = ++sendGenRef.current;
    pendingRef.current = true;
    setItems((prev) => [...prev, userItem]);
    setSessionItems((prev) => [...prev, userItem]);
    setPending(true);
    // U3(AUDIT-2026-09-26): 이 창은 emit() 이 메인 창에 실제로 닿았는지, 거기 활성 노트가
    // 있었는지, applyChatSection 이 실제로 성공했는지 전혀 알 방법이 없다(왕복 ack이 없다 —
    // 추가하려면 메인 창 쪽 PetChatPlanReviewBridge.tsx 를 고쳐야 하는데 이 웨이브 소유 범위
    // 밖이다). 예전엔 그런데도 onCreateSection 이 무조건 true 를 돌려줘 "삽입됨" 칩이 숨었고,
    // 실제 실패는 (흔히 숨은) 메인 창 알림에만 떴다. 이제는 절대 성공을 주장하지 않고(항상
    // false), 이 턴에서 실제로 요청을 보냈는지만 로컬로 기억해 뒀다가 결과 아이템에
    // sectionAutoSent 로 얹는다 — ChatBubble 이 "넣기" 버튼 대신 "보냈어요" 라는, 다시 누를
    // 수 없는 상태 문구로 렌더한다(라벨은 "성공"이 아니라 "전송" 만 주장한다).
    let sectionAutoSent = false;
    try {
      const result = await runChatPipeline({
        composed: text,
        allowWrite: chatWriteEnabled,
        userItem,
        failText: T.failed,
        savedText: T.saved,
        isAborted: () => gen !== sendGenRef.current,
        onNotice: emitNotice,
        // 근거 카드(showEvidence)는 기본값(켜짐) 그대로 — 예전 프런트 사전 검색(search_notes +
        // 유사어 확장)은 이 창에서 PET_ALLOWED_COMMANDS 밖이라 꺼 뒀었지만(D2, AUDIT-2026-09-26),
        // 이제 근거는 pet_chat 이 이미 찾은 것을 같이 돌려줄 뿐이라 추가 IPC 가 없다. ChatBubble 의
        // DefaultHits 가 item.hits 를 카드로 그린다(2026-10-09 Wave S).
        onCreateSection: async (req) => {
          sectionAutoSent = true;
          void emit(PET_APPLY_CHAT_SECTION_EVENT, {
            title: req.title,
            body: req.body,
          }).catch(() => {});
          return false;
        },
      });

      if (result.type === "aborted") return;

      const privacyOff =
        (result.type === "failed" || result.type === "recovered") &&
        (result.errorMessage ?? "").includes("ai_enabled");
      if (privacyOff) setGateOff(true);

      if (result.type === "success") {
        const assistantItem = sectionAutoSent
          ? { ...result.assistantItem, sectionAutoSent: true }
          : result.assistantItem;
        const stamp = (prev: PetChatItem[]) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "user" && next[i].createdAt === userCreatedAt && next[i].text === userItem.text) {
              next[i] = result.stampedUser;
              break;
            }
          }
          return [...next, assistantItem];
        };
        setItems(stamp);
        setSessionItems(stamp);
      } else if (result.type === "recovered") {
        setItems((prev) => applyHistory(result.messages, prev));
      } else if (result.type === "failed") {
        const failedItem = privacyOff ? { ...result.failedItem, text: T.aiOff } : result.failedItem;
        setItems((prev) => [...prev, failedItem]);
      }
    } catch (e) {
      // repo::ai::privacy_gate_ok 거부("cloud AI requires ai_enabled …")는 장애가 아니라 설정
      // 문제다 — 같은 "잘 안 됐어요"로 뭉뚱그리면 사용자가 계속 다시 보낸다.
      const off = String((e as { message?: string })?.message ?? "").includes("ai_enabled");
      if (off) setGateOff(true);
      setItems((prev) => [...prev, { role: "assistant", text: off ? T.aiOff : T.failed, failed: true }]);
    } finally {
      if (gen === sendGenRef.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [chatWriteEnabled]);

  /** AI 를 타지 않는 직접 저장 — 오프라인/키 없음에서도 동작한다. */
  const saveMemo = useCallback(async (text: string) => {
    const createdAt = new Date().toISOString();
    setItems((prev) => [...prev, { role: "user", text, createdAt }]);
    try {
      const res = await call<PetNoteCreateOutput>("pet_note_create", { text });
      setItems((prev) => [
        ...prev,
        {
          role: "assistant",
          text: T.saved,
          createdAt: new Date().toISOString(),
          noteId: res.note_id,
          noteTitle: res.title,
        },
      ]);
    } catch {
      setItems((prev) => [...prev, { role: "assistant", text: T.failed }]);
    }
  }, []);

  /** Explicit close/Esc path: save only the conversation turns, leaving note chips and search hits out.
   * The backend owns note creation, summary generation, two-section layout, and metadata injection. */
  const saveConversation = useCallback(async (conversation: PetChatItem[]) => {
    const messages: PetConversationMessageInput[] = conversation
      .filter((item) => item.text.trim().length > 0)
      .map(({ role, text, createdAt }) => ({
        role,
        text,
        ...(createdAt ? { created_at: createdAt } : {}),
      }));
    if (!messages.length) return;
    await call("pet_conversation_save", { messages });
  }, []);

  // mode 가 비어 있는 응답은 "말풍선 내용이 아직/이미 없다" 는 뜻이다 — 빈 말풍선을 그리지 않는다.
  if (!payload || (payload.mode !== "chat" && payload.mode !== "notice" && payload.mode !== "clip")) {
    return null;
  }

  if (payload.mode === "chat") {
    return (
      <div className="pet-bubble-win pet-bubble-win--chat">
        {/* W13: boundary sits outside PetChat — this window's only content is chat, so a render
            crash inside it used to leave a blank floating bubble with no way to close or diagnose
            it (no root boundary catches it either; this is its own tiny webview). */}
        <ErrorBoundary fallbackTitle={T.chatCrashed}>
          <PetChat
            items={items}
            pending={pending}
            onSend={(t) => void send(t)}
            onSaveMemo={(t) => void saveMemo(t)}
            onSaveConversation={saveConversation}
            conversationItems={sessionItems}
            closeRequest={closeRequest}
            onOpenNote={openNote}
            onOpenPlan={openPlan}
            onClose={close}
            aiOff={aiOff}
            suggestion={suggestion}
            onReviewSuggestion={reviewSuggestion}
            onAcceptLink={acceptLinkSuggestion}
            onAcceptTheme={acceptThemeSuggestion}
            onAcceptCollect={acceptCollectSuggestion}
            onDismissSuggestion={dismissSuggestion}
          />
        </ErrorBoundary>
      </div>
    );
  }

  // 파싱 실패하면 card 가 null 이고 아래 알림 렌더로 흘러간다 — 다리가 만든 JSON이라 실제로
  // 일어나면 버그지만, 그때도 사용자에게 닫을 수 있는 말풍선 하나는 남는 게 낫다.
  const card = payload.mode === "clip" ? parseClipCard(payload.text) : null;
  if (card) {
    return (
      <div className="pet-bubble-win pet-bubble-win--notice">
        <div className="pet-notice" ref={noticeRef}>
          <div className="pet-suggestion pet-suggestion--clip" data-testid="pet-clip-card">
            <p className="pet-suggestion__text">{clipCardText(card)}</p>
            <p className="pet-clip__preview">{card.preview}</p>
            <div className="pet-suggestion__actions">
              {/* 취소는 잠그지 않는다 — 저장 요청이 어딘가에서 막혀도 카드에 갇히지 않게. */}
              <button type="button" onClick={close}>
                {T.clipCancel}
              </button>
              <button type="button" disabled={clipSent} onClick={() => acceptClip("new", card.kind)}>
                {card.target_title ? T.clipNew : T.clipSave}
              </button>
              {card.target_title ? (
                <button
                  type="button"
                  className="pet-suggestion__review"
                  disabled={clipSent}
                  onClick={() => acceptClip("append", card.kind)}
                >
                  {T.clipAppend}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pet-bubble-win pet-bubble-win--notice">
      <div className="pet-notice" ref={noticeRef}>
        <button
          type="button"
          className="pet-notice__body"
          onClick={() => {
            if (payload.note_id) openNote(payload.note_id);
            close();
          }}
        >
          {payload.text}
        </button>
        <button type="button" className="pet-notice__close" aria-label={T.close} onClick={close}>
          <IconClose size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
