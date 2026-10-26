/**
 * 컴포저 문서 ↔ ProseMirror JSON ↔ 보낼 요청(PLAN-2026-09-15 §2.1·§2.2, 6안 D15·D17).
 * 순수 함수만 — 에디터 인스턴스를 모른다. 문장에는 컨텍스트가 없다(참조는 모달의 `ctxList` 소유).
 */
import type { JSONContent } from "@tiptap/core";
import { t } from "../../../i18n/t";
import { TRANSLATE_LANGUAGES } from "../askAiTypes";
import { SLOT_NODE } from "./slotNode";
import type { ComposerDoc, CtxRef, Part, SerializedRequest, SlotKind } from "./types";

/** 톤 슬롯 선택지(i18n 키). 첫 항목이 `{{tone}}` 의 기본값. */
export const TONE_KEYS = [
  "ai.composer_tone_concise",
  "ai.composer_tone_professional",
  "ai.composer_tone_friendly",
  "ai.composer_tone_plain",
] as const;

/** 언어 id("en") → 문장에 들어가는 이름("영어"). 모르는 값은 그대로. */
export function langName(id: string): string {
  return TRANSLATE_LANGUAGES.find((l) => l.id === id)?.name ?? id;
}

const MARKER_KEY: Record<CtxRef["k"], string> = {
  body: "ai.composer_marker_body",
  section: "ai.composer_marker_section",
  selection: "ai.composer_marker_selection",
  note: "ai.composer_marker_note",
  file: "ai.composer_marker_file",
  folder: "ai.composer_marker_folder",
  weather: "ai.composer_marker_weather",
  result: "ai.ctx_label_result",
};

/** 프롬프트 블록의 머리말(`[본문]`). 문장에는 더 이상 없지만 dispatch 가 블록을 이 이름으로 붙인다. */
export function ctxMarker(ref: CtxRef): string {
  return t(MARKER_KEY[ref.k]);
}

// ── doc ↔ PM JSON ─────────────────────────────────────────────────────────────

export function docToPM(doc: ComposerDoc): JSONContent {
  const content: JSONContent[] = [];
  for (const p of doc) {
    if (p.t === "text") {
      if (p.v) content.push({ type: "text", text: p.v });
    } else {
      content.push({
        type: SLOT_NODE,
        attrs: { key: p.key, kind: p.kind, ph: p.ph ?? null },
        content: p.v ? [{ type: "text", text: p.v }] : [],
      });
    }
  }
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

function textOf(node: JSONContent | undefined): string {
  return (node?.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : textOf(c))).join("");
}

export function pmToDoc(json: JSONContent): ComposerDoc {
  const doc: ComposerDoc = [];
  const push = (part: Part) => {
    const last = doc[doc.length - 1];
    if (part.t === "text" && last?.t === "text") last.v += part.v;
    else doc.push(part);
  };
  const walk = (node: JSONContent) => {
    if (node.type === "text") push({ t: "text", v: node.text ?? "" });
    else if (node.type === SLOT_NODE) {
      const a = node.attrs ?? {};
      push({
        t: "slot",
        key: String(a.key ?? ""),
        kind: (a.kind as SlotKind) ?? "text",
        v: textOf(node),
        ...(a.ph ? { ph: String(a.ph) } : {}),
      });
    } else if (node.type === "hardBreak") push({ t: "text", v: "\n" });
    else node.content?.forEach(walk);
  };
  walk(json);
  return doc;
}

// ── 보내기 ────────────────────────────────────────────────────────────────────

export function serialize(doc: ComposerDoc): SerializedRequest {
  const slots: Record<string, string> = {};
  const instruction = doc
    .map((p) => {
      if (p.t === "slot") slots[p.key] = p.v;
      return p.v;
    })
    .join("")
    .trim();
  return { instruction, slots };
}

// ── 템플릿 → 문서 ─────────────────────────────────────────────────────────────

export interface TemplateDefaults {
  /** 언어 id — `{{lang}}` 의 초깃값. */
  lang: string;
}

const TOKEN = /\{\{(.*?)\}\}/g;

/**
 * `{{lang}}` · `{{n=5}}` · `{{tone}}` · `{{text:질문}}` 을 조각으로 바꾼다. 모르는 토큰은 글자 그대로.
 * 같은 종류 슬롯이 둘 이상이면 키에 번호가 붙는다(`text`, `text2` …).
 *
 * `{{ctx}}` 는 **지워진다**(D17) — 옛 커스텀 프리셋이 문장 안에 들고 있을 수 있는데, 컨텍스트는 이제
 * 문장이 아니라 위 줄이 소유한다. 뒤에 ` : {{ctx}}` 를 붙이던 하위호환도 사라졌다.
 */
export function parseTemplate(prompt: string, defaults: TemplateDefaults): ComposerDoc {
  const doc: ComposerDoc = [];
  const seen: Record<string, number> = {};
  const keyFor = (kind: SlotKind) => {
    seen[kind] = (seen[kind] ?? 0) + 1;
    return seen[kind] === 1 ? kind : `${kind}${seen[kind]}`;
  };
  const text = (v: string) => {
    if (!v) return;
    const last = doc[doc.length - 1];
    if (last?.t === "text") last.v += v;
    else doc.push({ t: "text", v });
  };
  let cursor = 0;
  for (const m of prompt.matchAll(TOKEN)) {
    text(prompt.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const body = m[1].trim();
    if (body === "ctx") {
      // 옛 템플릿의 자리표시자 — 조각을 만들지 않는다.
    } else if (body === "lang") {
      doc.push({ t: "slot", key: keyFor("lang"), kind: "lang", v: langName(defaults.lang) });
    } else if (body === "tone") {
      doc.push({ t: "slot", key: keyFor("tone"), kind: "tone", v: t(TONE_KEYS[0]) });
    } else if (/^n(=\d+)?$/.test(body)) {
      doc.push({ t: "slot", key: keyFor("n"), kind: "n", v: body.includes("=") ? body.slice(2) : "" });
    } else if (body === "text" || body.startsWith("text:")) {
      const ph = body.slice(5).trim();
      doc.push({ t: "slot", key: keyFor("text"), kind: "text", v: "", ...(ph ? { ph } : {}) });
    } else {
      text(m[0]);
    }
  }
  text(prompt.slice(cursor));
  // 옛 템플릿의 ` : {{ctx}}` 접미사가 남긴 꼬리 공백·콜론을 턴다.
  const last = doc[doc.length - 1];
  if (last?.t === "text") {
    last.v = last.v.replace(/[\s:：]+$/, "");
    if (!last.v) doc.pop();
  }
  return doc;
}

// ── 문서 → 템플릿 ─────────────────────────────────────────────────────────────

/**
 * parseTemplate 의 역 — 요청문을 AI 프리셋 템플릿으로 되돌린다("프리셋으로 저장", 2026-09-27). 슬롯은
 * **자리로** 되돌린다: 지금 고른 언어·어조·채운 글은 이번 요청의 값이지 프리셋의 것이 아니라서, 다음에
 * 스탬프할 때 다시 고르게 둔다(언어는 설정의 번역 언어, 어조는 첫 항목으로 시작). 숫자는 문법이 기본값을
 * 담을 수 있어(`{{n=5}}`) 지금 값을 기본값으로 남긴다.
 */
export function docToTemplate(doc: ComposerDoc): string {
  return doc
    .map((p) => {
      if (p.t === "text") return p.v;
      switch (p.kind) {
        case "lang":
          return "{{lang}}";
        case "tone":
          return "{{tone}}";
        case "n":
          return p.v.trim() ? `{{n=${p.v.trim()}}}` : "{{n}}";
        case "text":
          return p.ph ? `{{text:${p.ph}}}` : "{{text}}";
      }
    })
    .join("");
}
