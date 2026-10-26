import { describe, it, expect } from "vitest";
import { renderPresetGhostHtml, resolveGhostBody } from "./EditorPanel";
import { TODO_PRESET_BODY_MD } from "../stores/presets";

// Scope: the preset hover-preview ghost. These test the two pure pieces the JSX render block wires
// together, not the full EditorPanel mount: that needs a live note/IPC/tiptap harness with no
// bearing on this feature's actual logic (parse-and-serialize, and the one visibility gate).

describe("renderPresetGhostHtml — real body markup, not plain text", () => {
  it("todo builtin: real checkbox <input>, not the old '☐' glyph", () => {
    const html = renderPresetGhostHtml(TODO_PRESET_BODY_MD);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("☐");
  });

  it("empty body renders nothing (blank preset's bodyMd is '')", () => {
    expect(renderPresetGhostHtml("")).toBe("");
    expect(renderPresetGhostHtml("   \n  ")).toBe("");
  });

  it("never throws on malformed input — display-only, must not take the editor down", () => {
    expect(() => renderPresetGhostHtml("<ul data-type=\"taskList\"><li>")).not.toThrow();
  });
});

// THE invariant this redesign exists for: the ghost and PresetList's rows read the SAME
// targetState, so "the list is up but hovering does nothing" can no longer be a reachable state —
// whenever a row is enabled (targetState "ready"), a hovered row with a body ghosts it.
describe("resolveGhostBody — one gate, shared with PresetList's enabled/disabled rows", () => {
  const todo = { id: "todo", bodyMd: TODO_PRESET_BODY_MD };

  it("ready + a hovered row with a body -> that body", () => {
    expect(resolveGhostBody("ready", todo)).toBe(TODO_PRESET_BODY_MD);
  });

  it("has_content -> null: never paint a ghost over real editor content (owner bug report)", () => {
    expect(resolveGhostBody("has_content", todo)).toBeNull();
  });

  it("diagram section active -> null: there is no EditorContent to ghost onto", () => {
    expect(resolveGhostBody("diagram", todo)).toBeNull();
  });

  it("nothing hovered -> null", () => {
    expect(resolveGhostBody("ready", null)).toBeNull();
  });

  it("a row with no static body (blank / 관계도 / AI) -> null, no fake ghost", () => {
    expect(resolveGhostBody("ready", { id: "blank", bodyMd: "" })).toBeNull();
    expect(resolveGhostBody("ready", { id: "diagram", bodyMd: "   \n " })).toBeNull();
  });

  it("takes the body the LIST handed over — including a kind:'template' preset from the third store, whose hover used to be silently dead", () => {
    expect(resolveGhostBody("ready", { id: "tpl-1", bodyMd: "## 잘한 것\n\n" })).toBe("## 잘한 것\n\n");
  });
});
