import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { emit, listen } from "@tauri-apps/api/event";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { isBrowser, isMobileViewport } from "../../lib/env";
import { browserListen } from "../../lib/httpBridge";
import { reportFallback } from "../../lib/diag";
import { classifyChatFailure, chatFailureDetail, type ChatFailureKind } from "../../lib/chatFailure";
import type {
  PetChatHistoryOutput,
  PetChatRewindOutput,
  PetChatDeleteOutput,
  PetChatReadAttachOutput,
  PetNoteCreateOutput,
  PetMessage,
  PetSessionListOutput,
  PetSessionNewOutput,
  PetSessionOpenOutput,
  PetSessionSummary,
  Suggestion,
} from "../../lib/commands.gen";
import { useNotesStore, displayTitle } from "../../stores/notes";
import {
  useAiPresetsStore,
  sidebarChatPresets,
  isSidebarSaveMemoPreset,
} from "../../stores/aiPresets";
import { t } from "../../i18n/t";
import type { PetChatItem, PetSuggestionCard } from "../../plugins/pet/PetChat";
import { ChatBubble, CHAT_BUBBLE_LABELS } from "../../plugins/pet/ChatBubble";
import { ChatComposer } from "../../plugins/pet/ChatComposer";
import {
  excerptFromActiveNote,
  fileToChatAttach,
  imageFileFromClipboard,
  composeChatAttachMessage,
  firstChatImage,
  attachFromReadResult,
  transferHasFiles,
  filesFromDataTransfer,
  previewOfAttach,
  revokeAttachPreview,
  type ChatAttach,
} from "../../plugins/pet/bridge/petChatContext";
import { PET_REVIEW_CHAT_PLAN_EVENT } from "../../plugins/pet/bridge/petChatPlan";
import { applyChatSection } from "../../plugins/pet/bridge/petChatSection";
import { pickRenderableSuggestion, type PendingSuggestion } from "../../plugins/pet/bridge/petSuggestionCards";
import { acceptCollectSuggestion } from "../../plugins/pet/bridge/petCollectBridge";
import { useSettingsStore } from "../../stores/settings";
import {
  DEFAULT_PET_PERSONA,
  loadPetPersona,
  savePetPersona,
  type PetPersona,
  type PetPersonaPreset,
} from "../../plugins/pet/bridge/petPersona";
import {
  applyHistory,
  isSessionSwitch,
  visibleChatText,
  PET_CHAT_UPDATED_EVENT,
  type ChatHistoryItem,
  type PetChatUpdatedPayload,
} from "../../plugins/pet/bridge/petChatHistory";
import { DropGhost } from "../attachments/DropGhost";
import { useFileDropZone } from "../../lib/useFileDropZone";
import { IconBulletList, IconClose, IconCopy, IconFile, IconHistory, IconNote, IconTrash } from "../icons";
import { ChatSearchToolCard } from "./chat/ChatSearchToolCard";
import { ChatSuggestionCard } from "./chat/ChatSuggestionCard";
import { ChatToolMenu, type ChatToolId } from "./chat/ChatToolMenu";
import { runChatPipeline } from "../../lib/chatPipeline";
import "../../plugins/pet/pet.css";

/**
 * Sidebar chat body (plan S4) — main surface for the shared pet_chat thread.
 * Send goes through runChatPipeline (pet bubble too); the write gate is shared via chat_write_enabled.
 * Hybrid UI: bubbles + search tool cards inside assistant bubbles + note chips + suggestion above composer.
 */

// Suggestion[] → PendingSuggestion 파싱(kind별 payload 검증 포함)은
// plugins/pet/bridge/petSuggestionCards.ts 로 옮겨져 PetBubbleApp.tsx 와 재사용한다 — 예전엔 이
// 파일에 로컬 복제본이 있었다.

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
    return {
      kind: "theme",
      id: s.id,
      noteTitle: displayTitle(s.noteTitle),
      othersCount: s.othersCount,
    };
  }
  if (s.kind === "collect") {
    return {
      kind: "collect",
      id: s.id,
      noteTitle: displayTitle(s.noteTitle),
      sourceName: s.sourceName,
    };
  }
  return {
    kind: "overlap",
    id: s.id,
    noteTitle: displayTitle(s.noteTitle),
    relatedNoteTitle: displayTitle(s.relatedNoteTitle),
  };
}

type ChatItem = ChatHistoryItem;

/** Tauri 웹뷰는 `listen`, 브라우저(/app, 폰·태블릿)는 SSE 브리지. 브라우저에서 `listen` 을 그대로 부르면
 *  `__TAURI_INTERNALS__` 가 없어 reject 한다(2026-10-06 채팅 원격 개방). */
function listenEvent<T>(name: string, handler: (e: { payload: T }) => void): Promise<() => void> {
  return isBrowser() ? browserListen<T>(name, handler) : listen<T>(name, handler);
}

/** 마지막 전송 실패 — 입력창 위 한 줄 + 다시 시도. 다음 전송이 시작되면 사라진다. */
interface SendFailure {
  kind: ChatFailureKind;
  detail: string;
  /** 다시 시도용 — 히스토리에서 마지막 사용자 턴을 못 찾을 때(복구 실패) 이 문구를 그대로 재전송한다. */
  text: string;
  displayText?: string;
}

function turnRange(items: ChatItem[], index: number): { start: number; end: number } {
  const item = items[index];
  if (!item) return { start: index, end: index };
  if (item.role === "user") {
    const next = items[index + 1];
    if (next?.role === "assistant") return { start: index, end: index + 1 };
    return { start: index, end: index };
  }
  const prev = items[index - 1];
  if (prev?.role === "user") return { start: index - 1, end: index };
  return { start: index, end: index };
}

function conversationPayload(items: ChatItem[]): PetMessage[] {
  return items
    .filter((item) => item.text.trim().length > 0)
    .map(({ role, text, createdAt }) => ({
      role,
      text,
      created_at: createdAt ?? "",
    }));
}



function lastUserIndexOf(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "user" && items[i].text.trim()) return i;
  }
  return -1;
}

export interface SidebarChatProps {
  /** 폰(MobileChatView): 노트 칩/검색 카드를 눌렀을 때의 이동을 호스트가 정한다. 없으면 데스크톱처럼 스토어 selectNote. */
  onOpenNote?: (noteId: string) => void;
}

export function SidebarChat({ onOpenNote }: SidebarChatProps = {}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [attaches, setAttaches] = useState<ChatAttach[]>([]);
  const [htmlDragOver, setHtmlDragOver] = useState(false);
  const [suggestion, setSuggestion] = useState<PendingSuggestion | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [sessions, setSessions] = useState<PetSessionSummary[]>([]);
  const [savingConversation, setSavingConversation] = useState(false);
  const [selected, setSelected] = useState<{ index: number; rect: DOMRect } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tauriInsideRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const attachesRef = useRef<ChatAttach[]>([]);
  attachesRef.current = attaches;
  const pendingRef = useRef(false);
  const sendGenRef = useRef(0);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  // 설정 > AI > 채팅 의 페르소나와 같은 키(pet_persona_preset/prompt) — 어댑터 그대로 재사용.
  const [persona, setPersona] = useState<PetPersona>(DEFAULT_PET_PERSONA);
  const selectNote = useNotesStore((s) => s.selectNote);
  const writeEnabled = useSettingsStore((s) => s.chatWriteEnabled);
  const setWriteEnabled = useSettingsStore((s) => s.setChatWriteEnabled);
  const presetList = useAiPresetsStore((s) => s.list);
  const presetsLoaded = useAiPresetsStore((s) => s.loaded);
  const loadPresets = useAiPresetsStore((s) => s.load);
  const chatPresets = sidebarChatPresets(presetList);

  const refreshPersona = useCallback(() => {
    void loadPetPersona().then(setPersona);
  }, []);
  useEffect(() => {
    refreshPersona();
  }, [refreshPersona]);

  const pickPersona = (preset: PetPersonaPreset) => {
    // 직접 입력은 본문 편집이 필요하다 — 설정 페이지로 보낸다(프리셋은 거기서 바꾼다).
    if (preset === "custom") {
      void openChatSettings();
      return;
    }
    const prev = persona;
    setPersona({ ...prev, preset });
    // 저장 실패는 savePetPersona 가 토스트로 알리고 false 를 돌려준다 — 낙관적으로 바꾼 칩을 되돌린다.
    void savePetPersona(preset, prev.prompt).then((ok) => {
      if (!ok) setPersona(prev);
    });
  };

  const refreshSessions = useCallback(async () => {
    try {
      const res = await call<PetSessionListOutput>("pet_session_list", {});
      setSessions(res.sessions ?? []);
    } catch {
      /* call() already toasted */
    }
  }, []);

  const removeAttach = useCallback((id: string) => {
    setAttaches((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found) revokeAttachPreview(found);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const addAttaches = useCallback((next: ChatAttach[]) => {
    if (!next.length) return;
    setAttaches((prev) => [...prev, ...next]);
  }, []);

  const addDroppedFiles = useCallback(async (files: File[]) => {
    const next: ChatAttach[] = [];
    for (const file of files) {
      const att = await fileToChatAttach(file);
      if (att) next.push(att);
    }
    addAttaches(next);
  }, [addAttaches]);

  const addDroppedPaths = useCallback(async (paths: string[]) => {
    const next: ChatAttach[] = [];
    for (const path of paths) {
      try {
        const res = await call<PetChatReadAttachOutput>("pet_chat_read_attach", { path });
        next.push(attachFromReadResult(res));
      } catch {
        /* call() 이 AppError 토스트를 이미 표출함 */
      }
    }
    addAttaches(next);
  }, [addAttaches]);

  useEffect(() => {
    if (!presetsLoaded) void loadPresets();
  }, [presetsLoaded, loadPresets]);

  useEffect(() => {
    return () => {
      for (const a of attachesRef.current) revokeAttachPreview(a);
    };
  }, []);

  // lib/useFileDropZone.ts 공용 훅 — rect/dpr/구독은 훅이 소유, WebView2 (0,0) 드롭 좌표 보정
  // (직전 "over"가 안이었으면 그대로 받아들인다)만 이 존의 부가 판정으로 남긴다.
  const { dragOver: tauriDragOver } = useFileDropZone(() => rootRef.current, {
    onLeave: () => {
      tauriInsideRef.current = false;
    },
    onOver: (_pos, inside) => {
      tauriInsideRef.current = inside;
    },
    onDrop: (paths, pos, inside) => {
      // WebView2 sometimes reports (0,0) on drop after a valid over. Trust the last over.
      const bogus = pos.x <= 1 && pos.y <= 1;
      const accept = inside || (bogus && tauriInsideRef.current);
      tauriInsideRef.current = false;
      if (!accept) return;
      void addDroppedPaths(paths);
    },
  });

  // Load shared history on mount (and when remounted after leaving the tab).
  useEffect(() => {
    let cancelled = false;
    void callSilent<PetChatHistoryOutput>("pet_chat_history", {})
      .then((res) => {
        if (cancelled) return;
        setItems((prev) => applyHistory(res.messages, prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Pet window / settings mutated the shared thread. Skip while this view is sending
  // so the in-flight stamp is not replaced by a raw history refetch.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    // ponytail: 브라우저(폰)에선 SSE 프레임 "pet-chat-updated" 로 데스크톱/다른 기기의 변경을 받는다.
    // SSE 가 끊겨 있으면 마운트 시·자기 전송 뒤 재조회만 동작한다 — 천장. 필요하면 가시성 복귀 시 재조회.
    void listenEvent<PetChatUpdatedPayload>(PET_CHAT_UPDATED_EVENT, (e) => {
      if (cancelled) return;
      // 응답 대기 중 다른 곳(트레이·펫 "새 세션 열기", 폰)이 세션을 바꿨다 — 그 답은 Rust 가 시작
      // 세션에 저장하므로(pet_chat_turn) 이 화면에 붙이지 않는다: 대기를 끊고 새 라이브를 다시 읽는다.
      if (pendingRef.current && isSessionSwitch(e.payload?.reason)) stopWait();
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
    }).catch(() => {
      // silent-ok: Tauri IPC 없는 환경(vite/vitest) — 실시간 미러 없이도 마운트 시 재조회가 있다.
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Suggestions: same broadcast the pet window listens to (main-window bridge).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    // 브라우저에선 이 이벤트가 오지 않고(SSE 미중계) 펫 브리지도 없다 — 제안 카드는 데스크톱 전용.
    void listenEvent<{ suggestions: Suggestion[] }>("pet-suggestions-pending", (e) => {
      if (cancelled) return;
      setSuggestion(pickRenderableSuggestion(e.payload.suggestions));
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    }).catch(() => {
      // silent-ok: Tauri IPC 없는 환경 — 제안 카드 없음.
    });
    if (!isBrowser()) void emit("pet-suggestions-refresh").catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items.length, pending]);

  useEffect(() => {
    if (!selected) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (toolbarRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-chat-bubble]")) return;
      setSelected(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    const onScroll = () => setSelected(null);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    listRef.current?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      listRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [selected]);

  const openNote = useCallback(
    (noteId: string) => {
      if (onOpenNote) onOpenNote(noteId);
      else void selectNote(noteId);
    },
    [selectNote, onOpenNote],
  );

  const insertSectionAt = useCallback(async (index: number) => {
    const item = items[index];
    if (!item?.sectionBody || item.sectionInserted) return;
    const ok = await applyChatSection({
      title: item.sectionTitle,
      body: item.sectionBody,
      note_id: item.noteId || useNotesStore.getState().activeNote?.note.id,
    });
    if (!ok) return;
    setItems((prev) =>
      prev.map((row, i) => (i === index ? { ...row, sectionInserted: true } : row)),
    );
  }, [items]);

  const openPlan = useCallback((item: PetChatItem, index: number) => {
    if (item.sectionBody && !item.sectionInserted) {
      void insertSectionAt(index);
      return;
    }
    if (isBrowser()) {
      // PetChatPlanReviewBridge(검토 모달)는 데스크톱 전용이라 브라우저엔 받는 쪽이 없다.
      reportFallback("chat", "plan_review_unavailable_browser", item.planKind ?? "");
      emitNotice(t("search.chat_plan_desktop_only"));
      return;
    }
    const prevUser = [...items.slice(0, index)].reverse().find((row) => row.role === "user");
    const activeId = useNotesStore.getState().activeNote?.note.id;
    void emit(PET_REVIEW_CHAT_PLAN_EVENT, {
      plan_kind: item.planKind,
      note_id: activeId,
      instruction: prevUser?.text,
    }).catch(() => {});
  }, [items, insertSectionAt]);

  const stopWait = useCallback(() => {
    sendGenRef.current += 1;
    pendingRef.current = false;
    setPending(false);
  }, []);

  const send = useCallback(async (text: string, opts?: { skipAttaches?: boolean; displayText?: string }) => {
    const pendingAttaches = opts?.skipAttaches ? [] : attaches;
    const firstImage = firstChatImage(pendingAttaches);
    const composed = composeChatAttachMessage(text, pendingAttaches);
    if (!composed) return;
    const shown =
      opts?.displayText ||
      chatPresets.find((p) => p.prompt && p.prompt === composed)?.name;
    const userItem: ChatItem = {
      role: "user",
      text: composed,
      createdAt: new Date().toISOString(),
      imagePreview: firstImage?.previewUrl,
      attaches: pendingAttaches.map(previewOfAttach),
      displayText: shown,
    };
    const gen = ++sendGenRef.current;
    pendingRef.current = true;
    setFailure(null);
    setItems((prev) => [...prev, userItem]);
    setPending(true);
    setSelected(null);
    if (!opts?.skipAttaches) setAttaches([]);
    const failText = t("search.chat_failed");
    try {
      const active = useNotesStore.getState().activeNote;
      const result = await runChatPipeline({
        composed,
        allowWrite: useSettingsStore.getState().chatWriteEnabled,
        shown,
        ctx: excerptFromActiveNote(active),
        firstImage: firstImage?.base64 ? { base64: firstImage.base64, mime: firstImage.mime || "" } : undefined,
        userItem,
        activeNoteId: active?.note.id,
        activeNoteTitle: active?.note.title,
        failText,
        savedText: t("search.chat_saved"),
        isAborted: () => gen !== sendGenRef.current,
        onNotice: emitNotice,
      });

      if (result.type === "aborted") return;

      if (result.type === "success") {
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "user" && !next[i].persisted && next[i].text === userItem.text) {
              next[i] = result.stampedUser;
              break;
            }
          }
          return [...next, result.assistantItem];
        });
      } else if (result.type === "recovered") {
        setItems((prev) => applyHistory(result.messages, prev));
      } else if (result.type === "failed") {
        setItems((prev) => [...prev, result.failedItem]);
      }
      if (result.type === "recovered" || result.type === "failed") {
        // call() 이 실패 자체(logError)는 이미 남겼다 — 여기선 사유 범주를 검색 가능한 한 줄로 더 남기고
        // 화면에 보인다. 메시지에는 프로바이더 상태 문구만 있고 노트 본문은 없다(서버 쪽 마스킹·캡).
        const detail = chatFailureDetail(result.errorMessage ?? "");
        const kind = classifyChatFailure(detail);
        reportFallback("chat", `send_failed_${kind}`, detail);
        setFailure({ kind, detail, text: composed, displayText: shown });
      }
    } finally {
      if (gen === sendGenRef.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [attaches, chatPresets]);

  const saveMemo = useCallback(async (text: string) => {
    const body = text.trim();
    if (!body) return;
    try {
      await call<PetNoteCreateOutput>("pet_note_create", { text: body });
      emitNotice(t("search.chat_saved"));
    } catch {
      emitNotice(t("search.chat_failed"));
    }
  }, []);

  const submit = (fn: (text: string) => void) => {
    const text = draft.trim();
    if (!text && attaches.length === 0) return;
    setDraft("");
    setPresetsOpen(false);
    fn(text);
  };

  const fillComposer = (text: string) => {
    setDraft(text);
    setPresetsOpen(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, text.length);
    });
  };

  const rewindAt = async (index: number) => {
    const { start } = turnRange(items, index);
    const anchor = items[start];
    if (!anchor || pending) return;
    const userText = items[start]?.role === "user" ? items[start].text : anchor.text;
    if (anchor.persisted && anchor.createdAt) {
      try {
        const res = await call<PetChatRewindOutput>("pet_chat_rewind", {
          created_at: anchor.createdAt,
        });
        setItems(applyHistory(res.messages, items));
      } catch {
        emitNotice(t("search.chat_failed"));
        return;
      }
    } else {
      setItems((prev) => prev.slice(0, start));
    }
    setSelected(null);
    fillComposer(userText);
  };

  const deleteAt = async (index: number) => {
    const item = items[index];
    if (!item || pending) return;
    const { start, end } = turnRange(items, index);
    if (item.persisted && item.createdAt) {
      try {
        const res = await call<PetChatDeleteOutput>("pet_chat_delete", {
          created_at: item.createdAt,
          role: item.role,
        });
        setItems(applyHistory(res.messages, items));
      } catch {
        emitNotice(t("search.chat_failed"));
        return;
      }
    } else {
      setItems((prev) => prev.filter((_, i) => i < start || i > end));
    }
    setSelected(null);
  };

  const copyAt = async (index: number) => {
    const item = items[index];
    const text = item ? visibleChatText(item, chatPresets) : "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      emitNotice(t("search.chat_copied"));
    } catch {
      emitNotice(t("search.chat_failed"));
    }
  };

  const saveBubbleMemo = async (index: number) => {
    const text = items[index]?.text.trim() ?? "";
    if (!text) return;
    try {
      await call<PetNoteCreateOutput>("pet_note_create", { text });
      emitNotice(t("search.chat_saved"));
    } catch {
      emitNotice(t("search.chat_failed"));
    }
  };

  const saveConversation = async () => {
    if (savingConversation || pending) return;
    const messages = conversationPayload(items);
    if (!messages.length) return;
    setSavingConversation(true);
    try {
      await call("pet_conversation_save", { messages });
      emitNotice(t("search.chat_conversation_saved"));
    } catch {
      emitNotice(t("search.chat_conversation_save_failed"));
    } finally {
      setSavingConversation(false);
    }
  };

  const startNewSession = async () => {
    if (pending || !hasConversation) return;
    if (!window.confirm(t("search.chat_new_session_confirm"))) return;
    try {
      const res = await call<PetSessionNewOutput>("pet_session_new", {});
      setItems(applyHistory(res.messages ?? []));
      setSelected(null);
      await refreshSessions();
    } catch {
      emitNotice(t("search.chat_failed"));
    }
  };

  const openSession = async (session: PetSessionSummary) => {
    if (session.live || pending) return;
    try {
      const res = await call<PetSessionOpenOutput>("pet_session_open", {
        session_id: session.id,
      });
      setItems(applyHistory(res.messages ?? []));
      setSelected(null);
      await refreshSessions();
    } catch {
      emitNotice(t("search.chat_failed"));
    }
  };

  const copySession = async () => {
    const lines = items
      .filter((item) => item.text.trim().length > 0)
      .map((item) => {
        const role =
          item.role === "user" ? t("search.chat_role_user") : t("search.chat_role_assistant");
        return `${role}: ${item.text}`;
      });
    if (!lines.length) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      emitNotice(t("search.chat_copied"));
    } catch {
      emitNotice(t("search.chat_failed"));
    }
  };

  const regenLast = async () => {
    const idx = lastUserIndexOf(items);
    if (idx < 0 || pending) return;
    const userText = items[idx].text;
    const anchor = items[idx];
    setSelected(null);
    if (anchor.persisted && anchor.createdAt) {
      try {
        const res = await call<PetChatRewindOutput>("pet_chat_rewind", {
          created_at: anchor.createdAt,
        });
        setItems(applyHistory(res.messages, items));
      } catch {
        emitNotice(t("search.chat_failed"));
        return;
      }
    } else {
      setItems((prev) => prev.slice(0, idx));
    }
    await send(userText, { skipAttaches: true, displayText: items[idx].displayText });
  };

  const retryFailed = (f: SendFailure) => {
    if (pending) return;
    if (lastUserIndexOf(items) >= 0) {
      void regenLast();
      return;
    }
    setFailure(null);
    void send(f.text, { skipAttaches: true, displayText: f.displayText });
  };

  const runTool = (id: ChatToolId) => {
    if (id === "save_session") {
      void saveConversation();
      return;
    }
    if (id === "copy_session") {
      void copySession();
      return;
    }
    if (id === "regen_last") {
      void regenLast();
      return;
    }
    void emit("pet-suggestions-refresh").catch(() => {});
  };

  const toolDisabled = (id: ChatToolId): boolean => {
    if (id === "save_session") return !hasConversation || pending || savingConversation;
    if (id === "copy_session") return !hasConversation;
    if (id === "regen_last") return lastUserIndexOf(items) < 0 || pending;
    return false;
  };

  // 페르소나 편집 = 설정 > AI > 채팅 페이지 맨 위 카드(AiChatSection). 페이지 id 는 SettingsPanel 의 "ai_chat".
  const openChatSettings = async () => {
    try {
      await call("settings_window_open", { page: "ai_chat" });
    } catch {
      /* call() 이 이미 토스트를 띄웠다 */
    }
  };

  const runPreset = (p:{ id: string; name: string; prompt: string }) => {
    if (pending) return;
    if (isSidebarSaveMemoPreset(p)) {
      const text = draft.trim();
      if (!text) return;
      setDraft("");
      setPresetsOpen(false);
      void saveMemo(text);
      return;
    }
    const text = p.prompt.trim();
    if (!text) return;
    // 즉시 전송하면 프리셋 본문을 수정할 방법이 없다 — rewindAt과 같은 fillComposer 경로로
    // 넣고 전체 선택해 둔다: 그대로 보내면 send()가 프롬프트와 정확히 일치하는 프리셋을 찾아
    // displayText를 자동으로 붙이고(아래), 고쳐 쓰면 고친 그대로 보통 메시지로 나간다.
    fillComposer(text);
  };

  const card = suggestion ? toCard(suggestion) : null;
  const hasConversation = items.some((item) => item.text.trim().length > 0);
  const selectedItem = selected ? items[selected.index] : null;
  const canSend = (!!draft.trim() || attaches.length > 0) && !pending;
  const showDropGhost = htmlDragOver || tauriDragOver;

  return (
    <div
      ref={rootRef}
      className="pet-chat pet-chat--sidebar"
      data-testid="view-chat"
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        // Sidebar sits on the acrylic sheet — drop floating surface chrome from pet-window.
        background: "transparent",
        border: "none",
        borderRadius: 0,
        boxShadow: "none",
      }}
      onDragEnter={(e) => {
        // Must preventDefault even before types populate, or WebView2 cancels the drop.
        e.preventDefault();
        if (transferHasFiles(e.dataTransfer)) setHtmlDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (transferHasFiles(e.dataTransfer)) setHtmlDragOver(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        setHtmlDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setHtmlDragOver(false);
        const files = filesFromDataTransfer(e.dataTransfer);
        if (files.length) void addDroppedFiles(files);
      }}
    >
      {showDropGhost ? (
        <DropGhost testid="chat-drop-overlay" label={t("search.chat_drop_hint")} />
      ) : null}
      <ChatToolMenu
        writeEnabled={writeEnabled}
        sessions={sessions}
        pending={pending}
        newSessionDisabled={pending || !hasConversation}
        onMenuOpen={() => setPresetsOpen(false)}
        onToggleWrite={() => setWriteEnabled(!writeEnabled)}
        onRunTool={(toolId) => runTool(toolId)}
        onNewSession={() => void startNewSession()}
        onLoadSessions={() => void refreshSessions()}
        onOpenSession={(session) => void openSession(session)}
        onOpenSettings={isBrowser() ? undefined : () => void openChatSettings()}
        isToolDisabled={(toolId) => toolDisabled(toolId)}
        persona={persona.preset}
        onPickPersona={pickPersona}
        onLoadPersona={refreshPersona}
      />
      <div className="pet-chat__list" ref={listRef}>
        {items.length === 0 && !pending ? (
          <p className="pet-chat__hint">{t("search.chat_empty_hint")}</p>
        ) : null}
        {items.map((m, i) => (
          <ChatBubble
            key={`${m.createdAt ?? "local"}-${i}`}
            item={m}
            text={visibleChatText(m, chatPresets)}
            labels={{
              ...CHAT_BUBBLE_LABELS,
              failed: t("search.chat_failed_label"),
              visionFallback: t("search.chat_vision_fallback"),
              openNote: t("search.chat_open_note"),
              insertSection: t("search.chat_insert_section"),
              planFill: t("search.chat_insert_section"),
              planDetails: t("search.chat_plan_details"),
              planChip: t("search.chat_plan_chip"),
            }}
            onOpenNote={openNote}
            onOpenPlan={(row) => {
              const idx = items.indexOf(row);
              if (row.sectionBody && !row.sectionInserted) void insertSectionAt(idx >= 0 ? idx : i);
              else openPlan(row, idx >= 0 ? idx : i);
            }}
            lead={
              m.attaches?.length ? (
                <div className="pet-chat__thumbs">
                  {m.attaches.map((a, idx) =>
                    a.kind === "image" && a.previewUrl ? (
                      <img
                        key={`${a.name}-${idx}`}
                        className="pet-chat__thumb"
                        src={a.previewUrl}
                        alt={a.name}
                      />
                    ) : (
                      <span key={`${a.name}-${idx}`} className="pet-chat__file-chip">
                        <IconFile size={12} strokeWidth={1.8} />
                        {a.name}
                      </span>
                    ),
                  )}
                </div>
              ) : undefined
            }
            hits={m.hits?.length ? <ChatSearchToolCard hits={m.hits} onOpen={openNote} variant={m.action === "search" ? "search" : "evidence"} /> : undefined}
            selected={selected?.index === i}
            onSelect={(el) => {
              const rect = el.getBoundingClientRect();
              setSelected((prev) => (prev?.index === i ? null : { index: i, rect }));
            }}
          />
        ))}
        {pending ? (
          <div className="pet-chat__pending-row">
            <div className="pet-bubble pet-bubble--assistant pet-chat__thinking">
              <span className="pet-chat__thinking-label">{t("search.chat_waiting")}</span>
              <span className="pet-chat__dots" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <button
              type="button"
              className="pet-chat__stop-wait"
              data-testid="chat-stop-wait"
              onClick={stopWait}
            >
              {t("search.chat_stop_wait")}
            </button>
          </div>
        ) : null}
      </div>

      {card && suggestion ? (
        <ChatSuggestionCard
          card={card}
          suggestion={suggestion}
          onDismiss={() => {
            const id = suggestion.id;
            setSuggestion(null);
            void emit("pet-suggestion-dismiss", { id }).catch(() => {});
          }}
          onAcceptOrReview={() => {
            if (suggestion.kind === "overlap") {
              const { id, noteId, relatedNoteId } = suggestion;
              setSuggestion(null);
              void emit("pet-review-suggestion", {
                id,
                note_id: noteId,
                related_note_id: relatedNoteId,
              }).catch(() => {});
              void selectNote(noteId);
            } else if (suggestion.kind === "link") {
              const { id, title, summary, url, targetNoteId } = suggestion;
              setSuggestion(null);
              void emit("pet-accept-link-suggestion", {
                id,
                target_note_id: targetNoteId,
                title,
                summary,
                url,
              }).catch(() => {});
            } else if (suggestion.kind === "theme") {
              const { id, noteIds } = suggestion;
              setSuggestion(null);
              void emit("pet-accept-theme-suggestion", { id, note_ids: noteIds }).catch(() => {});
            } else if (suggestion.kind === "collect") {
              const { id, noteId, postProcessModel } = suggestion;
              const prevSuggestion = suggestion;
              setSuggestion(null);
              // C(AUDIT-2026-09-26): 카드를 먼저 지운 뒤 acceptCollectSuggestion 이 실패하면(내부
              // 세 단계 중 acceptSuggestion 은 callSilent 라 조용하다) 사용자는 실패 사실을 전혀
              // 모른 채 카드만 사라졌다. 카드를 되돌려 재시도할 수 있게 한다 — 이 함수는 invoke.ts
              // 의 두 래퍼(호출부에 붙잡으라고 다시 throw 하는 그것) 자체가 아니라 합성 함수라,
              // 여기서 직접 롤백한다.
              void acceptCollectSuggestion({ id, noteId, model: postProcessModel }).catch(() => {
                setSuggestion(prevSuggestion);
              });
            }
          }}
        />
      ) : null}

      {failure ? (
        <div
          className="pet-chat__failure"
          data-testid="chat-failure"
          data-kind={failure.kind}
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-2) var(--space-3)",
            color: "var(--text)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {t(`search.chat_failure_${failure.kind}`)}
            {failure.detail ? (
              <span style={{ display: "block", color: "var(--faint)", overflowWrap: "anywhere" }}>
                {failure.detail}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="pet-chat__icon-btn"
            data-testid="chat-failure-retry"
            disabled={pending}
            onClick={() => retryFailed(failure)}
            style={{ minHeight: isMobileViewport() ? 48 : undefined, minWidth: isMobileViewport() ? 48 : undefined }}
          >
            {t("search.chat_retry")}
          </button>
          <button
            type="button"
            className="pet-chat__icon-btn"
            aria-label={t("search.chat_dismiss")}
            title={t("search.chat_dismiss")}
            onClick={() => setFailure(null)}
            style={{ minHeight: isMobileViewport() ? 48 : undefined, minWidth: isMobileViewport() ? 48 : undefined }}
          >
            <IconClose size={14} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      <div className="pet-chat__composer">
        {attaches.length > 0 ? (
          <div className="pet-chat__pending" data-testid="chat-pending-attaches">
            {attaches.map((a) => (
              <span
                key={a.id}
                className={a.kind === "image" ? "pet-chat__image-pending" : "pet-chat__file-pending"}
              >
                {a.kind === "image" && a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.name} />
                ) : (
                  <>
                    <IconFile size={14} strokeWidth={1.8} />
                    <span className="pet-chat__file-pending-name">{a.name}</span>
                  </>
                )}
                <button
                  type="button"
                  className="pet-chat__pending-x"
                  title={t("search.chat_remove_attach")}
                  aria-label={t("search.chat_remove_attach")}
                  onClick={() => removeAttach(a.id)}
                >
                  <IconClose size={12} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => submit((text) => void send(text))}
          pending={pending}
          disabled={pending}
          canSubmit={canSend}
          rows={2}
          placeholder={t("search.chat_placeholder")}
          sendLabel={t("search.chat_send")}
          stopLabel={t("search.chat_stop_wait")}
          onStop={stopWait}
          inputRef={textareaRef}
          onPaste={(e) => {
            const file = imageFileFromClipboard(e.nativeEvent);
            if (!file) return;
            e.preventDefault();
            void addDroppedFiles([file]);
          }}
          topAction={
            <>
              {presetsOpen ? (
                <div className="overlay pet-chat__presets pet-chat__presets--overlay" data-testid="chat-preset-list">
                  {chatPresets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="pet-chat__preset"
                      data-testid={`chat-preset-${p.id}`}
                      disabled={pending || (isSidebarSaveMemoPreset(p) && !draft.trim())}
                      onClick={() => runPreset(p)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="pet-chat__icon-btn pet-chat__icon-btn--glow"
                data-testid="chat-presets-btn"
                aria-label={t("search.chat_presets")}
                aria-pressed={presetsOpen}
                onClick={() => {
                  setPresetsOpen((open) => !open);
                }}
              >
                <IconBulletList size={14} strokeWidth={2} />
              </button>
            </>
          }
        />
      </div>

      {selected && selectedItem
        ? createPortal(
            <div
              ref={toolbarRef}
              className="overlay pet-chat__bubble-toolbar"
              data-testid="chat-bubble-toolbar"
              style={{
                position: "fixed",
                left: Math.min(Math.max(selected.rect.left + selected.rect.width / 2, 88), window.innerWidth - 88),
                top: Math.max(8, selected.rect.top - 42),
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2xs)",
                padding: 4,
                border: "2px solid var(--divider)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-lg)",
                zIndex: "var(--z-dropdown)",
              }}
            >
              <button
                type="button"
                className="toolbar-btn"
                title={t("search.chat_rewind")}
                aria-label={t("search.chat_rewind")}
                disabled={pending}
                onClick={() => void rewindAt(selected.index)}
              >
                <IconHistory size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="toolbar-btn"
                title={t("search.chat_save_memo")}
                aria-label={t("search.chat_save_memo")}
                onClick={() => void saveBubbleMemo(selected.index)}
              >
                <IconNote size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="toolbar-btn"
                title={t("search.chat_delete_bubble")}
                aria-label={t("search.chat_delete_bubble")}
                disabled={pending}
                onClick={() => void deleteAt(selected.index)}
              >
                <IconTrash size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="toolbar-btn"
                title={t("search.chat_copy")}
                aria-label={t("search.chat_copy")}
                onClick={() => void copyAt(selected.index)}
              >
                <IconCopy size={14} strokeWidth={2} />
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}


