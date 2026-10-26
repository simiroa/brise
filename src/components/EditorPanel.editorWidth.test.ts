import { describe, it, expect } from "vitest";
import { editorWidthClassName } from "./EditorPanel";

// 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWidth 프리퍼런스가 어떤 클래스를 만드는지의
// 순수 매핑(editorWidthClassName) 단위 테스트. "normal" 은 클래스 없이 기존 800px 규칙을 그대로
// 쓰므로 빈 문자열이어야 한다 — narrow/wide 만 새 클래스를 만든다.

describe("editorWidthClassName", () => {
  it("normal — 클래스 없음(기존 800px 규칙 그대로)", () => {
    expect(editorWidthClassName(false, "normal")).toBe("");
  });

  it("narrow — .editor-width-narrow (공백 접두)", () => {
    expect(editorWidthClassName(false, "narrow")).toBe(" editor-width-narrow");
  });

  it("wide — .editor-width-wide (공백 접두)", () => {
    expect(editorWidthClassName(false, "wide")).toBe(" editor-width-wide");
  });

  it("editorFullWidth 가 켜져 있으면 editorWidth 값과 무관하게 항상 빈 문자열 — 전체 너비가 이긴다", () => {
    expect(editorWidthClassName(true, "narrow")).toBe("");
    expect(editorWidthClassName(true, "wide")).toBe("");
    expect(editorWidthClassName(true, "normal")).toBe("");
  });
});
