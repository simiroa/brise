import { describe, it, expect } from "vitest";
import { shouldOpenLinkOnPlainClick } from "./EditorPanel";

// 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). linkOpenOnClick 프리퍼런스의 실효 게이트
// (shouldOpenLinkOnPlainClick) 단위 테스트 — 조합키 있는 클릭(Ctrl/Cmd)은 이 함수와 무관하게
// 항상 열리므로(오너 2026-09-10 규칙, EditorPanel.tsx 의 별도 분기) 여기서는 다루지 않는다
// (그 경로는 linkOpen.contract.test.ts 가 소스 계약으로 고정한다).

const base = {
  pref: true,
  button: 0,
  editable: true,
  endsTextSelection: false,
  onLinkEditUi: false,
};

describe("shouldOpenLinkOnPlainClick", () => {
  it("모든 조건이 맞으면 연다", () => {
    expect(shouldOpenLinkOnPlainClick(base)).toBe(true);
  });

  it("프리퍼런스가 꺼져 있으면(기본값) 절대 안 연다", () => {
    expect(shouldOpenLinkOnPlainClick({ ...base, pref: false })).toBe(false);
  });

  it("주 버튼(0)이 아니면(보조/우클릭) 안 연다", () => {
    expect(shouldOpenLinkOnPlainClick({ ...base, button: 1 })).toBe(false);
    expect(shouldOpenLinkOnPlainClick({ ...base, button: 2 })).toBe(false);
  });

  it("잠긴(content_locked) 노트 — editor.isEditable 이 false 면 오늘까지의 동작(안 열림) 유지", () => {
    expect(shouldOpenLinkOnPlainClick({ ...base, editable: false })).toBe(false);
  });

  it("텍스트 드래그 선택을 막 끝낸 클릭(mouseup 시점 선택이 비어있지 않음)이면 안 연다", () => {
    expect(shouldOpenLinkOnPlainClick({ ...base, endsTextSelection: true })).toBe(false);
  });

  it("클릭 대상이 링크 편집 팝오버(data-editor-pop) 내부면 안 연다", () => {
    expect(shouldOpenLinkOnPlainClick({ ...base, onLinkEditUi: true })).toBe(false);
  });

  it("여러 조건이 동시에 나빠도(단락 참·거짓 조합) 하나라도 막히면 안 연다", () => {
    expect(
      shouldOpenLinkOnPlainClick({
        pref: true,
        button: 0,
        editable: true,
        endsTextSelection: true,
        onLinkEditUi: true,
      })
    ).toBe(false);
  });
});
