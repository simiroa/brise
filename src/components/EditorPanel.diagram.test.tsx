import { describe, it, expect } from "vitest";
import { resolveActiveSection, buildDiagramSectionArgs, buildAiInsertSectionArgs } from "./EditorPanel";
import { DIAGRAM_STARTER, DIAGRAM_TEMPLATE_IDS, diagramTemplateSource } from "./diagram/diagramStarter";
import { parseDiagram } from "./diagram/diagramModel";
import type { Section } from "../lib/commands.gen";

// Scope: the two pure pieces that decide (a) which section is "active" for render purposes
// (Tiptap vs DiagramSection branch, tab highlight) and (b) the exact IPC payload the "+" picker's
// "관계도" option sends — not the full EditorPanel mount (that needs a live note/IPC/tiptap
// harness with no bearing on this feature's actual logic), same scoping as
// EditorPanel.presetGhost.test.tsx.

const text = (id: string): Section => ({ id, name: "Text", body_md: "hello", position: 0, kind: "text" });
const diagram = (id: string): Section => ({ id, name: "Relations", body_md: "flowchart TD", position: 1, kind: "diagram" });

describe("resolveActiveSection — which section EditorPanel renders", () => {
  it("prefers the section matching activeId", () => {
    const sections = [text("s1"), diagram("s2")];
    expect(resolveActiveSection(sections, "s2")).toBe(sections[1]);
    expect(resolveActiveSection(sections, "s2").kind).toBe("diagram");
  });

  it("falls back to the last section when activeId doesn't match (first paint of a note)", () => {
    const sections = [text("s1"), diagram("s2")];
    expect(resolveActiveSection(sections, undefined)).toBe(sections[1]);
    expect(resolveActiveSection(sections, "not-in-this-note")).toBe(sections[1]);
  });

  it("a text-only note never resolves to a diagram", () => {
    const sections = [text("s1"), text("s2")];
    expect(resolveActiveSection(sections, undefined).kind).toBe("text");
  });
});

describe("buildDiagramSectionArgs — the '+' picker's 관계도 option contract", () => {
  it("sends kind:'diagram' and the starter body (JSON IR now, mermaid text before the 2026-09-04 rebuild), never empty", () => {
    const args = buildDiagramSectionArgs("note-1");
    expect(args).toEqual({ note_id: "note-1", body_md: DIAGRAM_STARTER, kind: "diagram" });
    expect(args.body_md.trim().length).toBeGreaterThan(0);
  });
});

// registerSectionInserter's callback (wired to lib/aiSectionBridge.ts, called by aiPresets.ts's
// runAiAction for both ai_cleanup_text/ai_generate_from_prompt AND 관계도 만들기) forwards this
// payload to section_create_with_body. Desktop's AiActionsMenu calls runAiAction(preset) with no
// ctx, which routes through this exact bridge — without forwarding kind here, running 관계도
// 만들기 on desktop would silently create a kind:'text' section holding raw diagram source (JSON
// IR now, mermaid text before the 2026-09-04 rebuild) instead of a real diagram section.
describe("buildAiInsertSectionArgs — the AI-insert bridge's section_create_with_body contract", () => {
  it("forwards kind:'diagram' for the 관계도 만들기 AI path", () => {
    const args = buildAiInsertSectionArgs("note-1", "관계도 만들기", "flowchart TD\n  A --> B", "diagram");
    expect(args).toEqual({
      note_id: "note-1",
      name: "관계도 만들기",
      body_md: "flowchart TD\n  A --> B",
      kind: "diagram",
    });
  });

  it("omits kind for the existing text-only AI paths (ai_cleanup_text/ai_generate_from_prompt) — unchanged pre-diagram behavior", () => {
    const args = buildAiInsertSectionArgs("note-1", "Tidied (AI)", "cleaned up text");
    expect(args.kind).toBeUndefined();
    expect(args).toMatchObject({ note_id: "note-1", name: "Tidied (AI)", body_md: "cleaned up text" });
  });
});

// A diagram section is never born empty (live defect 2026-07-30: a blank kind:'diagram' section
// rendered as a blank canvas + "구조 편집을 지원하지 않습니다"). runAiAction checks the model's raw
// answer for emptiness BEFORE stripping the ```mermaid/```json fence (stripMermaidFence in
// aiPrompts.ts handles both, post JSON IR rebuild), so an answer that is nothing but an empty fence
// reaches the inserter as "" — guarded here, at the create boundary every path shares.
describe("diagram creation paths — non-empty, parseable body per path", () => {
  const parseable = (body: string) => {
    const model = parseDiagram(body);
    expect(model.empty).toBe(false);
    expect(model.structured).toBe(true);
    expect(model.nodes.length).toBeGreaterThan(0);
  };

  it("path: '+ 관계도' with no template (default starter)", () => {
    parseable(buildDiagramSectionArgs("note-1").body_md);
    expect(buildDiagramSectionArgs("note-1").body_md).toBe(DIAGRAM_STARTER);
  });

  it("path: '+ 관계도' → template gallery (desktop modal AND the mobile sheet share these sources)", () => {
    for (const id of DIAGRAM_TEMPLATE_IDS) {
      parseable(buildDiagramSectionArgs("note-1", diagramTemplateSource(id)).body_md);
    }
  });

  it("path: AI 관계도 만들기 — a normal answer passes through byte-for-byte", () => {
    const body = "flowchart TD\n  n1[\"이순신\"] --> n2[\"원균\"]";
    expect(buildAiInsertSectionArgs("n", "관계도", body, "diagram").body_md).toBe(body);
  });

  it("path: AI 관계도 만들기 — an empty/whitespace answer falls back to the starter, never creates a blank section", () => {
    for (const empty of ["", "   ", "\n\t\n"]) {
      parseable(buildAiInsertSectionArgs("n", "관계도", empty, "diagram").body_md);
    }
    // Text sections are untouched by the guard — an empty AI text body is the store's business.
    expect(buildAiInsertSectionArgs("n", "정리", "", undefined).body_md).toBe("");
  });
});
