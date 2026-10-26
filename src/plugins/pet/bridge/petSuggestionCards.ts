/**
 * "pet-suggestions-pending" 배열(오래된 것 먼저, petSuggestionsBridge.ts::refreshAndBroadcast)에서
 * 실제로 카드를 그릴 수 있는 첫 제안을 고르는 순수 헬퍼. PetBubbleApp.tsx(펫 창)와 SidebarChat.tsx
 * (메인 창)가 각자 `suggestions[0]`을 맹목적으로 쓰며 kind별 파싱을 그대로 복제하고 있었다 — 알 수
 * 없는 kind(예: 프로덕션 생산자가 없는 theme, 혹은 미래 kind)가 배열 맨 앞에 있으면 무조건 overlap
 * fallback 으로 렌더돼 "X와 X" 자기병합 카드가 뜨는 사고가 났다(2026-08-29, collect_post_process:
 * note_id=related_note_id 자기참조라 이 fallback을 그대로 맞았다).
 *
 * 지금은 kind를 명시적으로 검사해 렌더 가능(overlap · link[payload 유효] · theme[멤버≥2] ·
 * collect_post_process)한 것만 통과시키고, 그 외는 건너뛰어 다음 항목을 본다 — 미래에 새 kind가
 * 생겨도 큐를 막지 않는다(docs/SUGGESTIONS.md §2.4).
 *
 * IPC 호출이 전혀 없는 순수 함수만 있다(diag.ts::reportFallback 은 예외 — diag_record 는
 * PET_ALLOWED_COMMANDS 에 명시적으로 포함된 유일한 쓰기 커맨드고, diag.ts 자신이 절대 throw/reject
 * 하지 않는다고 계약돼 있어 이 파일의 "순수 함수" 성질을 깨지 않는다) — 펫 창(PET_ALLOWED_COMMANDS
 * 좁은 allowlist, pet_window.rs)에서도 안전하게 import 할 수 있다. bridge/petChatHistory.ts 와 같은
 * "두 창이 재사용하는 순수 헬퍼" 패턴.
 */
import type { Suggestion } from "../../../lib/commands.gen";
import { reportFallback } from "../../../lib/diag";
import { storedTitleOrEmpty } from "../../../lib/noteTitle";

export type PendingSuggestion =
  | {
      kind: "overlap";
      id: string;
      noteId: string;
      noteTitle: string;
      relatedNoteId: string;
      relatedNoteTitle: string;
    }
  | {
      kind: "link";
      id: string;
      title: string;
      summary: string;
      url: string;
      targetNoteId: string | null;
      targetNoteTitle: string | null;
    }
  | { kind: "theme"; id: string; noteTitle: string; othersCount: number; noteIds: string[] }
  /** collect_post_process(docs/SUGGESTIONS.md §3) — note_id 는 자기참조(수집된 노트 자신).
   *  postProcessModel 은 수락 시 organizeCurrentNote 의 model 오버라이드로 그대로 흘러간다. */
  | {
      kind: "collect";
      id: string;
      noteId: string;
      noteTitle: string;
      sourceName: string;
      postProcessModel: string | null;
    };

/** kind='link' suggestion 의 payload JSON 모양 — commands/suggestions.rs LinkSuggestionPayload와
 *  1:1 대응(specs/commands/suggestions.yaml 참고). */
interface LinkSuggestionPayload {
  url?: string;
  summary?: string;
  title?: string;
  target_note_id?: string | null;
  target_note_title?: string | null;
}

/** kind='theme' suggestion 의 payload JSON 모양 — repo::suggestions::ThemePayload 와 1:1. */
interface ThemeSuggestionPayload {
  note_ids?: string[];
}

/** kind='collect_post_process' suggestion 의 payload JSON 모양(docs/SUGGESTIONS.md §3). */
interface CollectSuggestionPayload {
  source_id?: string;
  source_name?: string;
  post_process_model?: string | null;
}

/** suggestion.payload(TEXT) 파싱 — 깨진 payload는 빈 객체로 접고 호출부가 필수 필드 부재로 건너뛴다. */
function parseSuggestionPayload<T extends object>(raw: string): T {
  try {
    return (JSON.parse(raw) as T) ?? ({} as T);
  } catch {
    return {} as T;
  }
}

/** 제안 하나를 렌더 가능한 카드 데이터로 바꾼다. 렌더 불가(payload 깨짐·멤버 부족·미지의 kind)면 null. */
function toPending(s: Suggestion): PendingSuggestion | null {
  if (s.kind === "overlap") {
    return {
      kind: "overlap",
      id: s.id,
      noteId: s.note_id,
      // 센티널 제목은 "" 로 — 두 창의 포맷터가 각자 '제목 없음' 으로 채운다(lib/noteTitle.ts).
      noteTitle: storedTitleOrEmpty(s.note_title),
      relatedNoteId: s.related_note_id,
      relatedNoteTitle: storedTitleOrEmpty(s.related_note_title),
    };
  }
  if (s.kind === "link") {
    const payload = parseSuggestionPayload<LinkSuggestionPayload>(s.payload);
    if (!payload.url || !payload.summary) return null;
    return {
      kind: "link",
      id: s.id,
      title: payload.title ?? "",
      summary: payload.summary,
      url: payload.url,
      targetNoteId: payload.target_note_id ?? null,
      targetNoteTitle: payload.target_note_title ?? null,
    };
  }
  if (s.kind === "theme") {
    const noteIds = parseSuggestionPayload<ThemeSuggestionPayload>(s.payload).note_ids ?? [];
    if (noteIds.length < 2) return null;
    return {
      kind: "theme",
      id: s.id,
      noteTitle: storedTitleOrEmpty(s.note_title),
      othersCount: noteIds.length - 1, // 앵커를 뺀 나머지 — "외 N개"
      noteIds,
    };
  }
  if (s.kind === "collect_post_process") {
    const payload = parseSuggestionPayload<CollectSuggestionPayload>(s.payload);
    if (!payload.source_name) return null;
    return {
      kind: "collect",
      id: s.id,
      noteId: s.note_id,
      noteTitle: storedTitleOrEmpty(s.note_title),
      sourceName: payload.source_name,
      postProcessModel: payload.post_process_model ?? null,
    };
  }
  // 미지의 kind(미래 확장분 포함) — overlap fallback으로 오렌더하지 않고 건너뛴다.
  reportFallback("pet", "suggestion_unknown_kind", `kind=${s.kind}`);
  return null;
}

/** suggestions 배열(오래된 것 먼저)에서 렌더 가능한 첫 카드를 고른다. 없으면 null. */
export function pickRenderableSuggestion(suggestions: Suggestion[]): PendingSuggestion | null {
  for (const s of suggestions) {
    const parsed = toPending(s);
    if (parsed) return parsed;
  }
  return null;
}
