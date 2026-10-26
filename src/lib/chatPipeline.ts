import { call, callSilent } from "./invoke";
import { extractAndSaveChatMemory } from "./chatMemoryExtractor";
import type {
  PetChatOutput,
  PetNoteCreateOutput,
  PetChatHistoryOutput,
  CollectSourceAddNlOutput,
  CollectSourceRunNowOutput,
} from "./commands.gen";
import { applyChatSection } from "../plugins/pet/bridge/petChatSection";
import { isPetChatPlanKind } from "../plugins/pet/bridge/petChatPlan";
import { rememberChatExtras, type ChatHistoryItem as ChatItem } from "../plugins/pet/bridge/petChatHistory";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";

// (사용자가 쓴 글 — shown — 에만 건다: composed 에는 첨부 발췌가 섞여 "뭐"·"왜" 한 글자에도 켜진다.)
// 근거 카드를 보일 질문인지 — 예전 프런트 사전 검색을 켜던 그 트리거를 그대로 쓴다(카드가 뜨던
// 턴이 바뀌지 않게). 검색 자체는 이제 Rust 가 매 턴 한 번 한다(질문 검색 RAG, chat_read_files 를
// 따른다). 이 패턴은 그 근거를 카드로 **보여 줄지**만 정한다 — 2026-10-09 Wave S.
const SEARCH_KEYWORD_PATTERN =
  /(?:찾아|검색|찾아줘|찾아줄|있는지|있나|뭐|무엇|언제|어디|누구|얼마|왜|어떻게|\bfind\b|\bsearch\b|\blook(?:ing)? for\b)/i;

// Local-import kinds (PLAN-2026-09-04-local-import) register with interval_minutes=0 and no
// network — run them immediately after chat registration instead of waiting for next app open.
const LOCAL_RUN_NOW_KINDS = new Set(["claude_prompts", "codex_prompts", "browser_history"]);

export interface ChatPipelineParams {
  composed: string;
  allowWrite: boolean;
  shown?: string;
  ctx?: any;
  firstImage?: { base64: string; mime: string; previewUrl?: string };
  userItem: ChatItem;
  activeNoteId?: string;
  activeNoteTitle?: string;
  failText: string;
  savedText: string;
  isAborted: () => boolean;
  onNotice: (msg: string) => void;
  /**
   * 근거 카드 허용(기본 true). 실제 `show_evidence` 는 이 값 AND 질문 패턴. 추가 IPC 는 없다 —
   * pet_chat 이 이미 찾은 근거를 같이 돌려줄 뿐이라 펫 말풍선(search_notes 금지 창)에서도 켜 둔다.
   */
  showEvidence?: boolean;
  /** Pet bubble: emit PET_APPLY_CHAT_SECTION_EVENT without requiring an active note in that webview. */
  onCreateSection?: (req: { title?: string; body: string }) => Promise<boolean>;
}

export type ChatPipelineResult =
  | { type: "aborted" }
  | { type: "success"; stampedUser: ChatItem; assistantItem: ChatItem }
  | { type: "recovered"; messages: any[]; errorMessage?: string }
  | { type: "failed"; failedItem: ChatItem; errorMessage?: string };

export async function runChatPipeline(params: ChatPipelineParams): Promise<ChatPipelineResult> {
  const {
    composed,
    allowWrite,
    shown,
    ctx,
    firstImage,
    userItem,
    activeNoteId,
    activeNoteTitle,
    failText,
    savedText,
    isAborted,
    onNotice,
    showEvidence = true,
    onCreateSection,
  } = params;

  try {
    // 한 턴 = pet_chat IPC 한 번. 노트 검색은 Rust 가 한 번(질문 검색 RAG) — 근거 카드는 그 결과가
    // res.hits 로 돌아온 것이라 "모델이 실제로 본 근거"이고, 어시스턴트 행 meta 로 저장돼 다시 열어도 남는다.
    const res = await call<PetChatOutput>("pet_chat", {
      message: composed,
      allow_write: allowWrite,
      show_evidence: showEvidence && SEARCH_KEYWORD_PATTERN.test(shown ?? composed),
      // 실패하면 Rust 가 이 문구로 실패 행을 턴의 시작 세션에 남긴다(사용자 행은 턴 시작 때 이미 저장).
      fail_text: failText,
      ...(shown ? { display_text: shown } : {}),
      ...(ctx ?? {}),
      ...(firstImage?.base64
        ? { image_base64: firstImage.base64, image_mime: firstImage.mime }
        : {}),
    });

    if (isAborted()) return { type: "aborted" };

    const stampedUser: ChatItem = {
      ...userItem,
      createdAt: res.user_created_at || userItem.createdAt,
      persisted: true,
    };

    const assistantItem: ChatItem = {
      role: "assistant",
      text: res.reply,
      action: res.action,
      createdAt: res.assistant_created_at || new Date().toISOString(),
      persisted: true,
      noteId: res.note_id,
      noteTitle: res.note_title,
      hits: res.hits?.length ? res.hits : undefined,
      planKind: isPetChatPlanKind(res.plan_kind) ? res.plan_kind : undefined,
      planId: res.plan_id,
      visionStatus: res.vision_status,
      sectionTitle: res.section_title,
      sectionBody: res.section_body,
    };

    if (res.action === "create_section" && res.section_body && allowWrite) {
      if (onCreateSection) {
        assistantItem.sectionInserted = await onCreateSection({
          title: res.section_title,
          body: res.section_body,
        });
      } else if (activeNoteId) {
        const ok = await applyChatSection({
          title: res.section_title,
          body: res.section_body,
          note_id: activeNoteId,
        });
        assistantItem.sectionInserted = ok;
        if (ok) {
          assistantItem.noteId = activeNoteId;
          assistantItem.noteTitle = res.section_title || activeNoteTitle;
        }
      } else {
        try {
          const created = await call<PetNoteCreateOutput>("pet_note_create", {
            text: res.section_body,
            title: res.section_title,
          });
          assistantItem.noteId = created.note_id;
          assistantItem.noteTitle = created.title;
          assistantItem.sectionInserted = true;
          onNotice(savedText);
        } catch {
          /* call() already toasted */
        }
      }
    }

    // add_collect_source: repo/pet/mod.rs only labels the action (same "frontend fires the
    // follow-up IPC" shape as create_section above) — it never calls collect_source_add_nl
    // itself. Both gates are read right here, at the one spot that actually sends the IPC.
    // ponytail: `res.action` is typed from specs/commands/pet.yaml's narrower enum (owned by a
    // different wave this round); cast instead of widening that spec+regen out of scope here.
    if ((res.action as string) === "add_collect_source") {
      if (!allowWrite || !useSettingsStore.getState().collectChatRegister) {
        assistantItem.text = t("search.chat_collect_register_disabled");
      } else {
        let registerError = "";
        const source = await callSilent<CollectSourceAddNlOutput>("collect_source_add_nl", {
          input: composed,
        }).catch((e) => {
          registerError = String((e as { message?: string })?.message ?? e ?? "");
          return null;
        });

        // Local kinds (no network) register with interval_minutes=0 ("on open") — running them
        // immediately is what the user actually asked for in this turn, so don't make them wait
        // for the next window open. PLAN-2026-09-04-local-import §2.5. A run-now failure is not
        // fatal to the registration itself, so it falls back to the plain "registered" text.
        let ranNow: number | null = null;
        if (source && LOCAL_RUN_NOW_KINDS.has(source.kind)) {
          const runResult = await callSilent<CollectSourceRunNowOutput>("collect_source_run_now", {
            id: source.id,
          }).catch(() => null);
          if (runResult?.ok) ranNow = runResult.added;
        }

        // ponytail: overwriting text here is display-only for this render — applyHistory()
        // rebuilds text from the persisted pet_messages row (res.reply) on reload/mirror sync,
        // so a reloaded transcript shows the model's original confirmation line instead.
        // Upgrade path: thread the outcome into the assistant row's meta if that drift matters.
        assistantItem.text = source
          ? ranNow !== null
            ? t("search.chat_collect_registered_and_ran", { name: source.name, n: ranNow })
            : t("search.chat_collect_registered", { name: source.name })
          : t("search.chat_collect_register_failed", { error: registerError });
      }
    }

    rememberChatExtras(stampedUser);
    rememberChatExtras(assistantItem);
    void extractAndSaveChatMemory({ userText: composed, assistantText: res.reply });

    return { type: "success", stampedUser, assistantItem };
  } catch (e) {
    const errorMessage = String((e as { message?: string })?.message ?? e ?? "");
    // 실패 행은 pet_chat 이 이미 남겼다(fail_text) — 여기선 서버 기록을 다시 읽기만 한다.
    if (isAborted()) return { type: "aborted" };

    try {
      const hist = await call<PetChatHistoryOutput>("pet_chat_history", {});
      if (isAborted()) return { type: "aborted" };
      return { type: "recovered", messages: hist.messages, errorMessage };
    } catch {
      if (isAborted()) return { type: "aborted" };
      return { type: "failed", failedItem: { role: "assistant", text: failText, failed: true }, errorMessage };
    }
  }
}
