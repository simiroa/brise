/**
 * OWNER PHILOSOPHY (see task HANDOFF): every AI-capable context exposes ONE entry — "AI에게 묻기"
 * — opening this ONE modal, rather than an enumerated row per action. `target` picks what the modal
 * talks about; preset tiles are sentence stamps that end in the same dispatch a free-form prompt
 * does (components/ai/askAiDispatch.ts), never a separate implementation.
 */
export type AskAiTarget =
  | { kind: "new"; initialPrompt?: string; presetId?: string; autoSend?: boolean }
  | { kind: "note"; noteId: string; noteTitle: string; initialPrompt?: string; presetId?: string; autoSend?: boolean }
  | {
      kind: "section";
      sectionId: string;
      sectionName: string;
      sectionBody: string;
      isDiagram: boolean;
      diagramMounted: boolean;
      isSheet?: boolean;
      sheetMounted?: boolean;
      initialPrompt?: string;
      presetId?: string;
      autoSend?: boolean;
    }
  | {
      kind: "selection";
      selectedText: string;
      from?: number;
      to?: number;
      initialPrompt?: string;
      presetId?: string;
      autoSend?: boolean;
    }
  | {
      kind: "diagram";
      label: string;
      id: string;
      initialPrompt?: string;
      presetId?: string;
      autoSend?: boolean;
    };

export interface AskAiModalProps {
  target: AskAiTarget;
  onClose: () => void;
  presetId?: string;
  autoSend?: boolean;
}

export type ExtendedTranslateLang = "ko" | "en" | "ja" | "zh" | "fr" | "de" | "es";

export interface AttachedFileItem {
  name: string;
  size: number;
  content: string;
}

export const TRANSLATE_LANGUAGES: { id: ExtendedTranslateLang; label: string; name: string; nativeName: string }[] = [
  { id: "ko", label: "KO", name: "한국어", nativeName: "한국어" },
  { id: "en", label: "EN", name: "영어", nativeName: "English" },
  { id: "ja", label: "JA", name: "일본어", nativeName: "日本語" },
  { id: "zh", label: "ZH", name: "중국어", nativeName: "中文" },
  { id: "fr", label: "FR", name: "프랑스어", nativeName: "Français" },
  { id: "de", label: "DE", name: "독일어", nativeName: "Deutsch" },
  { id: "es", label: "ES", name: "스페인어", nativeName: "Español" },
];

/**
 * AI 모달의 데이터 목적지(PLAN-2026-09-27 §3.6) — 헤더 `✦ AI · Gemini`·외부 전송 배지와 첫 실행 카드의 데이터 문장이 쓴다.
 * `external` 은 설정의 제공자·주소로 판정한다: 루프백 주소의 Ollama 만 로컬이다(stores/ai.ts 번역 게이트와 같은 기준 —
 * 원격 주소의 Ollama 는 노트가 기기 밖으로 나간다). 모르면(설정을 아직 못 읽었다) 외부로 본다 — 안심시키는 쪽으로 틀리면 안 된다.
 */
export interface AiDataDest {
  /** 표시 이름(Gemini·OpenAI …). 모르면 undefined. */
  name?: string;
  external: boolean;
}

