import { describe, expect, it } from "vitest";
import { t } from "../../../i18n/t";
import { ctxMarker, docToPM, docToTemplate, langName, parseTemplate, pmToDoc, serialize, TONE_KEYS } from "./serialize";
import type { ComposerDoc } from "./types";

const D = { lang: "en" };

describe("parseTemplate", () => {
  it("no slots → plain text, no context appended (6안 D17)", () => {
    expect(parseTemplate("요약해", D)).toEqual([{ t: "text", v: "요약해" }]);
  });

  it("legacy ` : {{ctx}}` suffix is stripped, trailing colon and all", () => {
    expect(parseTemplate("요약해 : {{ctx}}", D)).toEqual([{ t: "text", v: "요약해" }]);
    expect(parseTemplate("{{ctx}} 를 요약해", D)).toEqual([{ t: "text", v: " 를 요약해" }]);
    expect(parseTemplate("{{ctx}}", D)).toEqual([]);
  });

  it("{{lang}} → lang slot with the language name for defaults.lang", () => {
    const doc = parseTemplate("{{lang}}로 번역", D);
    expect(doc[0]).toEqual({ t: "slot", key: "lang", kind: "lang", v: langName("en") });
    expect(langName("en")).toBe("영어");
    expect(langName("xx")).toBe("xx");
  });

  it("{{n=5}} → n slot with default; bare {{n}} → empty", () => {
    expect(parseTemplate("{{n=5}}개", D)[0]).toEqual({ t: "slot", key: "n", kind: "n", v: "5" });
    expect(parseTemplate("{{n}}개", D)[0]).toEqual({ t: "slot", key: "n", kind: "n", v: "" });
  });

  it("{{tone}} → tone slot defaulting to the first tone", () => {
    expect(parseTemplate("{{tone}} 다듬어", D)[0]).toEqual({ t: "slot", key: "tone", kind: "tone", v: t(TONE_KEYS[0]) });
  });

  it("{{text:질문}} → empty text slot with placeholder; repeats get numbered keys", () => {
    const doc = parseTemplate("{{text:질문}} / {{text}}", D);
    expect(doc[0]).toEqual({ t: "slot", key: "text", kind: "text", v: "", ph: "질문" });
    expect(doc[2]).toEqual({ t: "slot", key: "text2", kind: "text", v: "" });
  });

  it("unknown {{...}} stays literal text", () => {
    expect(parseTemplate("{{foo}} bar {{textual}}", D)).toEqual([{ t: "text", v: "{{foo}} bar {{textual}}" }]);
  });
});

describe("serialize", () => {
  const doc: ComposerDoc = [
    { t: "slot", key: "lang", kind: "lang", v: "영어" },
    { t: "text", v: "로 번역해" },
  ];

  it("joins text and slot values, collecting slot values by key", () => {
    expect(serialize(doc)).toEqual({ instruction: "영어로 번역해", slots: { lang: "영어" } });
  });

  it("round-trips through ProseMirror JSON (docToPM → pmToDoc)", () => {
    const withPh: ComposerDoc = [...doc, { t: "slot", key: "text", kind: "text", v: "", ph: "질문" }];
    expect(pmToDoc(docToPM(withPh))).toEqual(withPh);
  });

  it("pmToDoc merges adjacent text nodes and drops empty text", () => {
    expect(docToPM([{ t: "text", v: "" }]).content?.[0].content).toEqual([]);
    expect(
      pmToDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }),
    ).toEqual([{ t: "text", v: "ab" }]);
  });
});

describe("ctxMarker", () => {
  it("names every ref kind, including the two new absolute ones", () => {
    expect(ctxMarker({ k: "body" })).toBe(t("ai.composer_marker_body"));
    expect(ctxMarker({ k: "folder", id: "f1" })).toBe(t("ai.composer_marker_folder"));
    expect(ctxMarker({ k: "weather" })).toBe(t("ai.composer_marker_weather"));
  });
});

describe("docToTemplate — 프리셋으로 저장", () => {
  it("round-trips every slot kind back through parseTemplate", () => {
    const tpl = "{{lang}}로 {{tone}} 번역하고 {{n=3}}줄로, {{text:질문}}에도 답해 {{text}}";
    expect(docToTemplate(parseTemplate(tpl, D))).toBe(tpl);
  });

  it("slot values chosen for this request revert to the slot — only the number keeps its value as the default", () => {
    const doc: ComposerDoc = [
      { t: "slot", key: "lang", kind: "lang", v: "일본어" },
      { t: "text", v: "로 " },
      { t: "slot", key: "n", kind: "n", v: "7" },
      { t: "text", v: "줄 " },
      { t: "slot", key: "text", kind: "text", v: "제주 맛집", ph: "주제" },
    ];
    expect(docToTemplate(doc)).toBe("{{lang}}로 {{n=7}}줄 {{text:주제}}");
  });

  it("plain text passes through untouched", () => {
    expect(docToTemplate([{ t: "text", v: "세 줄로 요약해줘" }])).toBe("세 줄로 요약해줘");
  });
});
