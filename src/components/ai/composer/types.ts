/**
 * AI에게 묻기 컴포저 문서 모델 — PLAN-2026-09-15-askai-composer §2.2 + §7(6안 D15).
 *
 * 요청문은 **텍스트 + 슬롯**뿐이다. 컨텍스트 참조는 문장에서 빠져나가 프롬프트 상자 **위의 줄**이
 * 소유한다(모달 상태 `ctxList`, components/ai/AskAiContextStrip.tsx) — 보낼 때 활성 항목만 블록으로
 * 붙는다. 히스토리는 문장(`doc`)과 참조(`refs`)를 따로 저장하고, 상대 참조(body/section/selection)는
 * 대상 id 를 지워 다음 대상에 재바인딩한다(D12·D18).
 */
import type { AskAiWhere } from "../../../stores/aiPrompts";

export type SlotKind = "lang" | "n" | "tone" | "text";

export type CtxRef =
  | { k: "body" }
  | { k: "section"; id: string }
  | { k: "selection" }
  | { k: "note"; id: string }
  | { k: "file"; name: string }
  /** 그 폴더(= 노트북 안의 폴더)의 노트 제목+본문을 모아 붙인다. 상한은 askAiDispatch.ts. */
  | { k: "folder"; id: string }
  /** 저장된 위치의 오늘·내일 예보 한 문단. 위치가 없으면 없는 참조로 취급한다. */
  | { k: "weather" }
  /** 이 모달에서 나온 이전 결과(버전) — "이어서 다듬기"가 붙인다(2026-09-27). `key` = 그 버전의 request_id.
   *  모달이 닫히면 뜻이 없는 일회성 참조라 히스토리에 남기지 않는다(askAiHistory.push 가 걸러낸다). */
  | { k: "result"; key: string };

export type CtxKind = CtxRef["k"];

export type Part =
  | { t: "text"; v: string }
  | { t: "slot"; key: string; kind: SlotKind; v: string; ph?: string };

export type ComposerDoc = Part[];

/** 직렬화 결과 — dispatch 가 받는 모양. 참조는 여기 없다(모달이 따로 넘긴다). */
export interface SerializedRequest {
  instruction: string;
  slots: Record<string, string>;
}

/** 스탬프 요청 — 타일·히스토리가 컴포저에 넘기는 것. */
export interface Stamp {
  doc: ComposerDoc;
  where: AskAiWhere;
  folderId?: string | null;
  /** 출처 표기용(프리셋 id 또는 히스토리 id). */
  source?: string;
}

/** 상대 참조인가 — 히스토리 저장 시 id 를 지우고, 재사용 시 지금 대상에 다시 묶는다.
 *  folder/weather 는 대상과 무관한 절대 참조다. */
export function isRelativeRef(ref: CtxRef): boolean {
  return ref.k === "body" || ref.k === "section" || ref.k === "selection";
}

/** 같은 참조를 가리키는가 — `/` 메뉴·프리셋 `needs` 의 중복 방지(D16·D17). */
export function sameRef(a: CtxRef, b: CtxRef): boolean {
  if (a.k !== b.k) return false;
  if (a.k === "section" || a.k === "note" || a.k === "folder") return a.id === (b as { id: string }).id;
  if (a.k === "file") return a.name === (b as { name: string }).name;
  // 버전마다 다른 참조다 — 여기서 true 로 떨어지면 v1 이 이미 있을 때 v2 를 더하지 못한다.
  if (a.k === "result") return a.key === (b as { key: string }).key;
  return true;
}

/** 두 문서가 같은 문장인가(슬롯 값 포함) — `custom` 판정(D6)에 쓴다. */
export function docText(doc: ComposerDoc): string {
  return doc.map((p) => p.v).join("");
}
