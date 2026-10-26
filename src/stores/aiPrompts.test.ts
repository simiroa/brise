import { describe, it, expect } from "vitest";
import {
  BUILTIN_DEFS,
  DIAGRAM_EDIT_ID,
  DIAGRAM_PROGRESS_ID,
  DIAGRAM_EXPAND_BRANCH_ID,
  DIAGRAM_PROMPT,
  DIAGRAM_EDIT_PROMPT,
  DIAGRAM_PROGRESS_PROMPT,
  DIAGRAM_EDIT_PRESERVE_BULLET_V1,
  DIAGRAM_NO_ADVANCED_V1,
  DIAGRAM_CREATE_VOCAB,
  DIAGRAM_CREATE_VOCAB_JSON_V1,
  DIAGRAM_TYPE_HINTS,
  DIAGRAM_LAYOUT_VOCAB,
  buildDiagramEditPrompt,
  buildDiagramProgressPrompt,
  healDiagramEditPrompt,
  healDiagramPrompt,
  stripTextFence,
} from "./aiPrompts";
import { CHART_TYPES } from "../lib/sheet/chartTypes";

const promptOf = (id: string) => BUILTIN_DEFS.find((d) => d.id === id)!.prompt;

const JSON_IR_SOURCE = JSON.stringify(
  {
    v: 1,
    route: "curve",
    states: ["개념", "근거", "반론"],
    nodes: [
      { id: "n1", label: "세종", state: 0, tag: "왕" },
      { id: "n2", label: "장영실", state: 1 },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", label: "등용", line: "solid", arrow: "end" }],
  },
  null,
  2,
);

describe("aiPrompts — buildDiagramEditPrompt & buildDiagramProgressPrompt", () => {
  it("buildDiagramEditPrompt keeps the source verbatim", () => {
    const built = buildDiagramEditPrompt("RULES", JSON_IR_SOURCE, "장영실을 집현전 그룹에 넣어줘");
    expect(built.startsWith("RULES")).toBe(true);
    expect(built).toContain(JSON_IR_SOURCE);
    expect(built.indexOf(JSON_IR_SOURCE)).toBeLessThan(built.lastIndexOf("장영실을 집현전 그룹에 넣어줘"));
  });

  it("buildDiagramProgressPrompt attaches source and note log body", () => {
    const built = buildDiagramProgressPrompt("RULES", JSON_IR_SOURCE, "오늘 장영실 개발 완료");
    expect(built.startsWith("RULES")).toBe(true);
    expect(built).toContain(JSON_IR_SOURCE);
    expect(built).toContain("오늘 장영실 개발 완료");
  });
});

describe("관계도 AI 프롬프트 (JSON IR v1 어휘 및 규칙)", () => {
  it("DIAGRAM_PROMPT teaches JSON IR v1 schema, states vocabulary, and strictly forbids coordinates (pos)", () => {
    const create = promptOf("diagram");
    expect(create).toContain("JSON IR v1");
    expect(create).toContain('"v": 1');
    expect(create).toContain('"states"');
    expect(create).toContain('"route"');
    expect(create).toContain('"nodes"');
    expect(create).toContain('"edges"');
    expect(create).toContain('"groups"');
    expect(create).toContain("좌표(pos)는 절대 작성하지 마세요");
    expect(create).toContain("주 경로(main path)");
    expect(create).not.toContain("mermaid");
    expect(create).not.toContain("flowchart");
  });

  it("DIAGRAM_EDIT_PROMPT teaches structure preservation and forbids invented coordinates", () => {
    const edit = promptOf(DIAGRAM_EDIT_ID);
    expect(edit).toContain("JSON IR v1");
    expect(edit).toContain("요청한 변경만 정확히 적용");
    expect(edit).toContain("노드에 pos(좌표) 속성을 작성하지 마세요");
    expect(edit).toContain(DIAGRAM_LAYOUT_VOCAB);
    expect(edit).not.toContain("mermaid");
  });

  it("DIAGRAM_PROGRESS_PROMPT instructs updating only state while enforcing structure invariance and includes layout vocab", () => {
    const progress = promptOf(DIAGRAM_PROGRESS_ID);
    expect(progress).toBe(DIAGRAM_PROGRESS_PROMPT);
    expect(progress).toContain("상태(state)를 갱신");
    expect(progress).toContain("구조 불변성 엄수");
    expect(progress).toContain("노드를 추가하거나 삭제하지 마세요");
    expect(progress).toContain(DIAGRAM_LAYOUT_VOCAB);
    expect(progress).toContain("`state`");
  });
});

describe("healDiagramPrompt / healDiagramEditPrompt — legacy self-heal", () => {
  it("heals a legacy mermaid prompt to the new JSON IR v1 prompt", () => {
    const legacy = `머리말\n${DIAGRAM_NO_ADVANCED_V1}- 내 규칙\n`;
    const healed = healDiagramPrompt(legacy);
    expect(healed).toBe(DIAGRAM_PROMPT);
  });

  it("heals legacy edit prompt with old bullets into current JSON IR edit prompt", () => {
    const legacy = `머리말\n${DIAGRAM_EDIT_PRESERVE_BULLET_V1}${DIAGRAM_NO_ADVANCED_V1}`;
    const healed = healDiagramEditPrompt(legacy);
    expect(healed).toBe(DIAGRAM_EDIT_PROMPT);
  });

  it("leaves already-current prompt intact", () => {
    expect(healDiagramPrompt(DIAGRAM_PROMPT)).toBe(DIAGRAM_PROMPT);
    expect(healDiagramEditPrompt(DIAGRAM_EDIT_PROMPT)).toBe(DIAGRAM_EDIT_PROMPT);
  });

  // 2026-09-20 needle — 타입 힌트 블록(레지스트리 순회)이 어휘 뒤에 붙었다. 저장된 프롬프트가
  // ① 힌트 없이 JSON 어휘만 있거나 ② 낡은 힌트 블록을 갖고 있으면 현재 블록으로 오고,
  // ③ 어휘를 손본 커스텀 프롬프트는 건드리지 않는다.
  it("2026-09-20: JSON 어휘만 있는 저장분에 타입 힌트 블록을 붙인다 (커스텀 꼬리 보존)", () => {
    const saved = `머리말\n${DIAGRAM_CREATE_VOCAB_JSON_V1}\n- 내 규칙\n`;
    const healed = healDiagramPrompt(saved);
    expect(healed).toBe(`머리말\n${DIAGRAM_CREATE_VOCAB}\n- 내 규칙\n`);
    expect(healed).toContain(DIAGRAM_TYPE_HINTS);
  });

  it("2026-09-20: 낡은 타입 힌트 블록은 현재 블록으로 통째 교체된다", () => {
    const stale = DIAGRAM_TYPE_HINTS.split("\n")[0] + "\n- 사라진 타입: 옛 규약\n";
    const saved = `${DIAGRAM_CREATE_VOCAB_JSON_V1}\n${stale}`;
    const healed = healDiagramPrompt(saved);
    expect(healed).not.toContain("사라진 타입");
    expect(healed).toContain(DIAGRAM_TYPE_HINTS);
    expect(healDiagramPrompt(healed)).toBe(healed); // 멱등
  });

  it("2026-09-20: 어휘 자체를 손본 커스텀 프롬프트는 그대로다", () => {
    const custom = "나만의 관계도 규칙\n- JSON 으로";
    expect(healDiagramPrompt(custom)).toBe(custom);
  });
});

describe("시트 AI 프롬프트 — sheet / sheet_edit", () => {
  it("defines sheet create and edit prompts with JSON schemas", () => {
    const create = promptOf("sheet");
    expect(create).toContain("스프레드시트 JSON");
    expect(create).toContain('"v": 1');
    expect(create).toContain('"cells"');

    const edit = promptOf("sheet_edit");
    expect(edit).toContain("기존 스프레드시트의 내용을 사용자의 요청에 맞게 수정");
  });

  it("W5: enforces formulajs dialect, forbids thousand separators, and establishes row 1 header convention", () => {
    const create = promptOf("sheet");
    expect(create).toContain("1행은");
    expect(create).toContain("헤더");
    expect(create).toContain("천 단위 쉼표");
    expect(create).toContain("@formulajs/formulajs");

    const edit = promptOf("sheet_edit");
    expect(edit).toContain("1행은");
    expect(edit).toContain("헤더");
    expect(edit).toContain("천 단위 쉼표");
    expect(edit).toContain("@formulajs/formulajs");
  });

  it("W6: lists all 9 registry chart type ids in both the create and edit prompts", () => {
    for (const id of CHART_TYPES.map((c) => c.id)) {
      expect(promptOf("sheet")).toContain(id);
      expect(promptOf("sheet_edit")).toContain(id);
    }
  });
});


describe("W2 (2026-09-20) — 배치·구획 어휘 블록 self-heal", () => {
  it("DIAGRAM_CREATE_VOCAB = JSON_V1 + 배치 블록 + 타입 힌트; JSON_V1 needle 은 그대로(배치 어휘가 새지 않았다)", () => {
    expect(DIAGRAM_CREATE_VOCAB).toBe(`${DIAGRAM_CREATE_VOCAB_JSON_V1}\n${DIAGRAM_LAYOUT_VOCAB}\n${DIAGRAM_TYPE_HINTS}`);
    expect(DIAGRAM_CREATE_VOCAB_JSON_V1).not.toContain('"layout"');
    expect(DIAGRAM_CREATE_VOCAB_JSON_V1).not.toContain('"rows"');
    for (const name of ["dagre", "radial", "lanes", "grid", "quadrant", "stack", "circle", "fishbone", "sequence"]) {
      expect(DIAGRAM_LAYOUT_VOCAB).toContain(`"${name}"`);
    }
    expect(DIAGRAM_PROMPT).toContain(DIAGRAM_LAYOUT_VOCAB);
  });

  it("W1 시절 저장분(JSON 어휘 + 타입 힌트, 배치 블록 없음)은 현재 어휘로 온다 — 멱등", () => {
    const saved = `머리말\n${DIAGRAM_CREATE_VOCAB_JSON_V1}\n${DIAGRAM_TYPE_HINTS}\n꼬리`;
    const healed = healDiagramPrompt(saved);
    expect(healed).toBe(`머리말\n${DIAGRAM_CREATE_VOCAB}\n꼬리`);
    expect(healDiagramPrompt(healed)).toBe(healed);
  });

  it("낡은 배치 블록은 통째 교체되고 커스텀 꼬리는 남는다", () => {
    const stale = DIAGRAM_LAYOUT_VOCAB.split("\n")[0] + '\n- 최상위 "layout": "banana"\n';
    const saved = `${DIAGRAM_CREATE_VOCAB_JSON_V1}\n${stale}\n${DIAGRAM_TYPE_HINTS}\n- 내 규칙\n`;
    const healed = healDiagramPrompt(saved);
    expect(healed).not.toContain("banana");
    expect(healed).toBe(`${DIAGRAM_CREATE_VOCAB}\n- 내 규칙\n`);
    expect(healDiagramPrompt(healed)).toBe(healed);
  });
});

describe("stripTextFence", () => {
  it("removes ```html ... ``` fences", () => {
    const raw = "```html\n<p>Hello world</p>\n```";
    expect(stripTextFence(raw)).toBe("<p>Hello world</p>");
  });

  it("removes ```markdown ... ``` and ```md ... ``` fences", () => {
    const rawMd = "```markdown\n# Header\n- item\n```";
    expect(stripTextFence(rawMd)).toBe("# Header\n- item");

    const rawShort = "```md\n# Header\n- item\n```";
    expect(stripTextFence(rawShort)).toBe("# Header\n- item");
  });

  it("removes bare ``` ... ``` fences", () => {
    const raw = "```\nJust text\n```";
    expect(stripTextFence(raw)).toBe("Just text");
  });

  it("preserves text that has no surrounding fence", () => {
    const raw = "<p>Plain paragraph</p>\n- item";
    expect(stripTextFence(raw)).toBe(raw);
  });
});

describe("BUILTIN_DEFS includes diagram_expand_branch", () => {
  it("has diagram_expand_branch with correct kind and prompt", () => {
    const def = BUILTIN_DEFS.find((d) => d.id === DIAGRAM_EXPAND_BRANCH_ID);
    expect(def).toBeDefined();
    expect(def?.kind).toBe("diagram");
    expect(def?.nameKey).toBe("ai.action_default_name_diagram_expand_branch");
  });
});

