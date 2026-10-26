import { describe, expect, it } from "vitest";
import type { AiActionPreset } from "../../stores/aiPrompts";
import { ASKAI_TILE_ORDER, askAiBuiltinTiles, defaultTileOrder, resolveTemplateForPreset, tileIcon, tilesForTarget } from "./askAiPresets";

/** 옛 AskAiModal.tsx 칩이 보내던 프롬프트(리터럴이었던 것만) → 지금 템플릿. 하나도 잃지 않고, 하나도 겹치지 않는다.
 *  6안 D17 로 ` : {{ctx}}` 접미사가 전부 빠졌다 — 컨텍스트는 문장이 아니라 `needs` 가 말한다. */
const FORMER_CHIP_TEMPLATES = [
  "다음 텍스트의 맞춤법, 띄어쓰기, 문법 오류를 교정하고 자연스럽게 다듬어줘",
  "다음 텍스트를 핵심만 남겨 더 간결하고 명확하게 다듬어줘",
  "다음 텍스트를 {{tone}} 톤으로 다듬어줘",
  "다음 텍스트의 핵심 내용을 간결하게 요약해줘",
  "다음 텍스트에서 가장 중요한 핵심 키워드와 개념들을 추출해줘",
  "다음 텍스트를 구조화된 불릿 목록(- 항목)으로 정리해줘",
  "다음 텍스트의 항목과 데이터를 깔끔한 Markdown 표로 정리해줘",
  "현재 노트 전체의 흐름을 분석하고 목차와 구조를 체계적으로 재정리해줘",
  "다이어그램 노드와 배치를 읽기 쉽게 자동 정렬해줘",
  "다이어그램의 복잡한 연결을 단순화하고 핵심만 남겨줘",
  "새로운 흐름 노드를 추가해줘: {{text:노드 설명}}",
  "다이어그램 내의 모든 노드 라벨과 텍스트를 {{lang}}로 번역해줘",
  "하단에 숫자 열들의 합계(SUM) 및 평균 행을 추가해줘",
  "수식 계산 열을 추가해줘: {{text:수식 설명}}",
  "금액 및 숫자 데이터 열의 서식과 단위를 일관되게 정리해줘",
  "시트 내 빈 셀, 중복 데이터 및 이상치(Outlier)를 검증하고 정리해줘",
  "시트의 헤더(열 이름)를 표준 명명 규칙에 맞게 명확히 다듬어줘",
  "시트 데이터를 주요 범주별로 그룹화하여 요약 통계 테이블을 작성해줘",
  "현재 시트의 데이터를 깔끔한 Markdown 표 형식으로 변환해줘",
  "시트의 텍스트와 열 헤더를 {{lang}}로 번역하고 표 구조를 유지해줘",
  "시트의 열 이름(헤더)을 {{lang}} 및 글로벌 비즈니스 표준 용어로 번역해줘",
  "문장의 맞춤법을 교정하고 자연스럽게 다듬어줘",
  "섹션의 내용을 적절한 소제목과 단락으로 재구성해줘",
];

const ORDER: Record<string, string[]> = {
  selection: ["proofread", "sel_concise", "sel_tone", "translate", "summarize", "keywords", "list", "table"],
  note: ["start_text", "metadata", "tags", "summarize", "translate", "agent_split", "diagram", "restructure", "polish", "proofread", "keywords", "table", "list", "todo", "auto_footnote", "ask"],
  diagram: ["diagram_expand_branch", "diagram_to_tasks", "diagram_to_article", "diagram_align", "diagram_simplify", "diagram_add_node", "diagram_translate", "diagram_progress"],
  sheet: ["start_sheet", "sheet_sum", "sheet_formula", "sheet_format", "sheet_outliers", "sheet_headers", "sheet_pivot", "sheet_table", "sheet_translate", "sheet_translate_headers"],
  section: ["summarize", "translate", "diagram", "polish", "proofread", "list", "section_restructure", "auto_footnote"],
};

function custom(over: Partial<AiActionPreset>): AiActionPreset {
  return { id: "c1", name: "커스텀", prompt: "커스텀 프롬프트", kind: "text", isBuiltin: false, hidden: false, ...over };
}

describe("askAiBuiltinTiles", () => {
  it("keeps every former chip prompt exactly once as a template", () => {
    const tilesWithPrompt = askAiBuiltinTiles().filter((p) => p.kind !== "tool");
    const templates = tilesWithPrompt.map((p) => p.prompt);
    for (const tpl of FORMER_CHIP_TEMPLATES) {
      expect(templates.filter((x) => x === tpl), tpl).toHaveLength(1);
    }
    expect(new Set(templates).size).toBe(templates.length);
    expect(new Set(askAiBuiltinTiles().map((p) => p.id)).size).toBe(askAiBuiltinTiles().length);
  });

  it("lists every (tile, target) pair in ASKAI_TILE_ORDER and nothing else", () => {
    for (const p of askAiBuiltinTiles()) {
      for (const k of p.targets!) expect(ASKAI_TILE_ORDER[k], `${p.id} in ${k}`).toContain(p.id);
    }
    for (const [k, ids] of Object.entries(ASKAI_TILE_ORDER)) {
      for (const id of ids) {
        expect(askAiBuiltinTiles().find((p) => p.id === id)?.targets, `${id} targets ${k}`).toContain(k);
      }
    }
  });

  it("marks every tile builtin with a label, icon, targets and a where", () => {
    for (const p of askAiBuiltinTiles()) {
      expect(p.isBuiltin).toBe(true);
      expect(p.hidden).toBe(false);
      expect(p.label && p.label.length).toBeGreaterThan(0);
      expect(p.icon).toBeTruthy();
      expect(p.targets && p.targets.length).toBeGreaterThan(0);
      expect(p.where).toBeTruthy();
    }
  });

  it("translate templates carry a {{lang}} slot; proposals carry their routing key", () => {
    const tiles = askAiBuiltinTiles();
    for (const id of ["translate", "diagram_translate", "sheet_translate", "sheet_translate_headers"]) {
      expect(tiles.find((p) => p.id === id)?.prompt).toContain("{{lang}}");
    }
    expect(tiles.find((p) => p.id === "metadata")).toMatchObject({ where: "proposal", proposal: "metadata" });
    expect(tiles.find((p) => p.id === "tags")).toMatchObject({ where: "proposal", proposal: "tags" });
    expect(tiles.find((p) => p.id === "agent_split")).toMatchObject({ where: "proposal", proposal: "split" });
    expect(tiles.find((p) => p.id === "restructure")?.where).toBe("note");
    expect(tiles.find((p) => p.id === "ask")?.prompt).toBe("{{text:질문}}");
  });

  it("no template carries a {{ctx}} placeholder any more (6안 D17)", () => {
    for (const p of askAiBuiltinTiles()) expect(p.prompt, p.id).not.toContain("{{ctx}}");
  });

  it("declares needs where the tile actually eats the target's body, and nowhere else", () => {
    const by = (id: string) => askAiBuiltinTiles().find((p) => p.id === id)!;
    for (const id of ["translate", "summarize", "keywords", "table", "todo", "polish", "restructure", "diagram", "section_restructure"]) {
      expect(by(id).needs, id).toEqual(["body"]);
    }
    // 질문·제안형·제자리 교체(살아있는 소스를 직접 먹는다)는 아무것도 요구하지 않는다.
    for (const id of ["ask", "metadata", "tags", "agent_split", "diagram_align", "sheet_sum"]) {
      expect(by(id).needs, id).toBeUndefined();
    }
  });
});
describe("tilesForTarget", () => {
  // 단일 순서(PLAN-2026-09-27 §7-1·Q7) — 대상별 순서표가 아니라 하나의 기본 순서를 대상으로 거른다.
  it.each(Object.keys(ORDER))("%s tiles follow the single default order, blank start presets left out", (kind) => {
    const expected = defaultTileOrder()
      .filter((p) => !p.blank && p.targets?.includes(kind as never))
      .map((p) => p.id);
    expect(tilesForTarget(kind as never, []).map((p) => p.id)).toEqual(expected);
  });

  it("the note list in the default order is exactly the plan's note order", () => {
    const blank = new Set(askAiBuiltinTiles().filter((p) => p.blank).map((p) => p.id));
    expect(tilesForTarget("note", []).map((p) => p.id)).toEqual(ORDER.note.filter((id) => !blank.has(id)));
  });

  it("follows the stored order — moving a builtin up in settings moves its tile", () => {
    const stored: AiActionPreset[] = [
      { id: "ask", name: "질문", prompt: "", kind: "text", isBuiltin: true, hidden: false },
      { id: "summarize", name: "요약", prompt: "", kind: "text", isBuiltin: true, hidden: false },
    ];
    expect(tilesForTarget("note", stored).map((p) => p.id).slice(0, 2)).toEqual(["ask", "summarize"]);
  });

  it("an empty note or new draft shows only the blank start presets", () => {
    const ids = tilesForTarget("note", [], true).map((p) => p.id);
    expect(ids).toContain("start_text");
    expect(ids.every((id) => askAiBuiltinTiles().find((p) => p.id === id)?.blank)).toBe(true);
  });

  it("builtin ids without a tile (action slots) never show as tiles", () => {
    const slot: AiActionPreset = { id: "organize", name: "정리", prompt: "", kind: "text", isBuiltin: true, hidden: false };
    expect(tilesForTarget("note", [slot]).map((p) => p.id)).not.toContain("organize");
  });

  it("filters out blank start presets when isBlank is false", () => {
    expect(tilesForTarget("note", [], false).map((p) => p.id)).not.toContain("start_text");
    expect(tilesForTarget("sheet", [], false).map((p) => p.id)).not.toContain("start_sheet");
  });

  it("appends a legacy custom preset (no targets) to note and section only", () => {
    const p = custom({});
    expect(tilesForTarget("note", [p]).map((x) => x.id)).toContain("c1");
    expect(tilesForTarget("section", [p]).map((x) => x.id)).toContain("c1");
    for (const k of ["selection", "diagram", "sheet"] as const) {
      expect(tilesForTarget(k, [p]).map((x) => x.id)).not.toContain("c1");
    }
    // 저장된 자리 그대로 — 목록에 없는 내장 타일은 그 뒤에 붙는다
    expect(tilesForTarget("note", [p])[0].id).toBe("c1");
  });

  it("honours explicit targets on custom presets and skips templates", () => {
    expect(tilesForTarget("sheet", [custom({ targets: ["sheet"] })]).map((x) => x.id)).toContain("c1");
    expect(tilesForTarget("note", [custom({ targets: ["sheet"] })]).map((x) => x.id)).not.toContain("c1");
    expect(tilesForTarget("note", [custom({ kind: "template" })]).map((x) => x.id)).not.toContain("c1");
  });

  it("drops hidden presets — builtin via stored override, custom via its own flag", () => {
    const stored: AiActionPreset[] = [
      { id: "summarize", name: "요약하기", prompt: "long", kind: "text", isBuiltin: true, hidden: true },
      custom({ hidden: true }),
    ];
    const ids = tilesForTarget("note", stored).map((x) => x.id);
    expect(ids).not.toContain("summarize");
    expect(ids).not.toContain("c1");
  });

  // 옛 장문은 저장소가 로드 때 타일 문장으로 이관한다(stores/aiPresets parseStored) — 여기 오는 문장은 사용자가
  // 설정에서 고친 요청 문장이고, 그것이 이긴다(§7-1).
  it("takes the stored name and the user's edited sentence for a builtin tile; an empty sentence falls back to DEFS", () => {
    const stored: AiActionPreset[] = [
      { id: "summarize", name: "내 요약", prompt: "세 줄로 요약해줘", kind: "text", isBuiltin: true, hidden: false },
      { id: "translate", name: "번역", prompt: "", kind: "text", isBuiltin: true, hidden: false },
    ];
    const tiles = tilesForTarget("note", stored);
    const s = tiles.find((x) => x.id === "summarize")!;
    expect(s.name).toBe("내 요약");
    expect(s.prompt).toBe("세 줄로 요약해줘");
    expect(resolveTemplateForPreset(s, "note")).toBe(s.prompt);
    expect(tiles.find((x) => x.id === "translate")!.prompt).toBe(askAiBuiltinTiles().find((x) => x.id === "translate")!.prompt);
  });
});

describe("tileIcon", () => {
  it("resolves ui names, note-icon keys, and falls back by kind", () => {
    expect(tileIcon("languages", "text")).toBeTypeOf("object");
    expect(tileIcon("book", "text")).toBeTruthy();
    expect(tileIcon(undefined, "sheet")).toBe(tileIcon("nope", "sheet"));
    expect(tileIcon(undefined, "sheet")).not.toBe(tileIcon(undefined, "diagram"));
  });
});
