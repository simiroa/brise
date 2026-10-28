import { listen } from "@tauri-apps/api/event";
import { useNotesStore, displayTitle } from "../../stores/notes";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { pushNotice, removeNotice, useFrameNotices } from "../../lib/frameNotices";
import type { Suggestion } from "../../lib/commands.gen";
import { PET_EVENT } from "../../plugins/pet/bridge/petEvents";
import {
  formatSuggestionCardText,
  pickRenderableSuggestion,
  suggestionActionLabel,
  type PendingSuggestion,
} from "../../plugins/pet/bridge/petSuggestionCards";
import { emitSuggestionAccept, emitSuggestionDismiss, emitSuggestionsRefresh } from "../../plugins/pet/petSuggestionActions";
import type { PetSuggestionCard } from "../../plugins/pet/PetChat";

/**
 * 펫 제안 알림의 생산자(메인 창) — 펫 창과 같은 브로드캐스트(petSuggestionsBridge.ts)를 듣고 가장 오래된 렌더 가능한 제안 하나를 알림으로
 * 올린다. 브라우저에선 이 이벤트가 오지 않고(SSE 미중계) 펫 브리지도 없다 — 제안은 데스크톱 전용.
 * 알림 key = `suggestion-<제안 id>` — 수락·무시는 **그 key 만** 지운다(예전엔 조건 없이 비워 더 새 제안까지 지웠다).
 */
const KEY_PREFIX = "suggestion-";
const keyOf = (s: PendingSuggestion) => `${KEY_PREFIX}${s.id}`;

// 카드는 표시 전용 데이터라 노트 제목을 여기서 한 번 displayTitle 로 거른다 — 새 노트의 저장 제목
// 센티널 "Untitled Note" 가 '"Untitled Note" × "Untitled Note"' 로 새던 자리. 펫 창(PetChat)은 스토어를
// 싣지 않으므로 이 판정은 메인 창 전용인 이 어댑터에 둔다(petSuggestionCards.ts 는 펫 창도 쓰는 순수 헬퍼).
function toCard(s: PendingSuggestion): PetSuggestionCard {
  if (s.kind === "link") {
    return {
      kind: "link",
      id: s.id,
      title: s.title,
      summary: s.summary,
      url: s.url,
      // 비었으면(null·"") 포맷터의 "새 노트로" 분기라 그대로 둔다.
      targetNoteTitle: s.targetNoteTitle ? displayTitle(s.targetNoteTitle) : s.targetNoteTitle,
    };
  }
  if (s.kind === "theme") {
    return { kind: "theme", id: s.id, noteTitle: displayTitle(s.noteTitle), othersCount: s.othersCount };
  }
  if (s.kind === "collect") {
    return { kind: "collect", id: s.id, noteTitle: displayTitle(s.noteTitle), sourceName: s.sourceName };
  }
  return {
    kind: "overlap",
    id: s.id,
    noteTitle: displayTitle(s.noteTitle),
    relatedNoteTitle: displayTitle(s.relatedNoteTitle),
  };
}

/** 이 제안을 메인 창에서 수락한다. 알림은 **이 제안의 것만** 지운다. */
function acceptSuggestion(s: PendingSuggestion): void {
  removeNotice(keyOf(s));
  if (s.kind === "collect") {
    // C(AUDIT-2026-09-26): 알림을 먼저 지운 뒤 acceptCollectSuggestion 이 실패하면(내부 세 단계 중 acceptSuggestion 은 callSilent 라
    // 조용하다) 사용자는 실패 사실을 모른 채 알림만 사라진다 — 되돌려 재시도할 수 있게 한다. 메인 창이라 이벤트를 돌지 않고 직접 부른다(펫 창은
    // 이벤트로 메인에 부탁한다). 부팅 번들에 AI 경로를 싣지 않으려고 누를 때 불러온다.
    void import("../../plugins/pet/bridge/petCollectBridge")
      .then((m) => m.acceptCollectSuggestion({ id: s.id, noteId: s.noteId, model: s.postProcessModel }))
      .catch(() => restoreIfNoNewer(s));
    return;
  }
  void emitSuggestionAccept(s);
  if (s.kind === "overlap") void useNotesStore.getState().selectNote(s.noteId);
}

function dismissSuggestion(s: PendingSuggestion): void {
  void emitSuggestionDismiss(s.id);
}

function publish(s: PendingSuggestion): void {
  pushNotice({
    key: keyOf(s),
    text: formatSuggestionCardText(toCard(s)),
    actionLabel: suggestionActionLabel(s.kind),
    dismissLabel: t("search.chat_dismiss"),
    onAction: () => acceptSuggestion(s),
    // 닫기 = 펫 쪽에 무시를 알린다. 지우는 것은 dismissNotice 가 한다.
    onDismiss: () => dismissSuggestion(s),
  });
}

/** 수락이 실패했을 때 알림을 되살린다 — 그 사이 더 새 제안이 올라와 있으면 그대로 둔다. */
function restoreIfNoNewer(s: PendingSuggestion): void {
  const hasNewer = useFrameNotices.getState().notices.some((n) => n.key.startsWith(KEY_PREFIX));
  if (!hasNewer) publish(s);
}

/** 브로드캐스트가 고른 제안 하나로 알림을 맞춘다 — 다른 제안의 알림은 지운다. */
function sync(next: PendingSuggestion | null): void {
  const nextKey = next ? keyOf(next) : null;
  for (const n of useFrameNotices.getState().notices) {
    if (n.key.startsWith(KEY_PREFIX) && n.key !== nextKey) removeNotice(n.key);
  }
  if (next) publish(next);
}

export function installPetSuggestionNotices(): () => void {
  if (isBrowser()) return () => {};
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void listen<{ suggestions: Suggestion[] }>(PET_EVENT.suggestionsPending, (e) => {
    if (!cancelled) sync(pickRenderableSuggestion(e.payload.suggestions));
  })
    .then((un) => {
      if (cancelled) un();
      else unlisten = un;
    })
    .catch(() => {
      // silent-ok: Tauri IPC 없는 환경(vite/vitest) — 제안 알림 없음.
    });
  void emitSuggestionsRefresh();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
