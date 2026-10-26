import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { IconNote } from "../../icons";
import { AskAiComposer, type AskAiComposerProps, type CtxItem } from "./AskAiComposer";
import type { ComposerDoc } from "./types";

const addBody = vi.fn();
const ctxItems: CtxItem[] = [
  { id: "body", icon: IconNote, label: "본문 전체", meta: "1,846자", group: "지금 노트", action: addBody },
  { id: "sel", icon: IconNote, label: "선택 영역", group: "지금 노트", disabled: true, action: () => {} },
];
const stampDoc: ComposerDoc = [
  { t: "slot", key: "lang", kind: "lang", v: "영어" },
  { t: "text", v: "로 번역해" },
];

function setup(over: Partial<AskAiComposerProps> = {}) {
  const editorRef: { current: Editor | null } = { current: null };
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <AskAiComposer value={[]} onChange={onChange} onSubmit={onSubmit} ctxItems={ctxItems} editorRef={editorRef} {...over} />,
  );
  const editor = () => editorRef.current!;
  return { ...utils, editor, onChange, onSubmit, pm: () => utils.container.querySelector(".ProseMirror")! };
}

/** 부모가 스탬프를 넘기고 onChange 를 되돌려 주는 실제 제어형 사용 모양. */
function Controlled({ onChange }: { onChange: (d: ComposerDoc) => void }) {
  const [doc, setDoc] = useState<ComposerDoc>([]);
  const editorRef: { current: Editor | null } = { current: null };
  (globalThis as { __ed?: typeof editorRef }).__ed = editorRef;
  return (
    <>
      <button onClick={() => setDoc(stampDoc)}>stamp</button>
      <AskAiComposer
        value={doc}
        onChange={(d) => { setDoc(d); onChange(d); }}
        onSubmit={() => {}}
        ctxItems={ctxItems}
        editorRef={editorRef}
      />
    </>
  );
}

describe("AskAiComposer", () => {
  it("stamping a new value replaces content and selects the first slot's whole value", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const ed = () => (globalThis as { __ed?: { current: Editor | null } }).__ed!.current!;
    await act(async () => { fireEvent.click(screen.getByText("stamp")); });
    await waitFor(() => expect(ed().getText()).toContain("로 번역해"));
    const { from, to } = ed().state.selection;
    expect(ed().state.doc.textBetween(from, to)).toBe("영어");
    // 슬롯 값이 선택된 채로 타이핑 → 값이 바뀌고 onChange 가 새 문서를 내보낸다(제어형 왕복이 내용을 되감지 않는다).
    await act(async () => { ed().commands.insertContent("일본어"); });
    expect(onChange).toHaveBeenLastCalledWith([
      { t: "slot", key: "lang", kind: "lang", v: "일본어" },
      { t: "text", v: "로 번역해" },
    ]);
    expect(ed().getText()).toContain("일본어로 번역해");
  });

  it("typing reports the changed doc via onChange", async () => {
    const { editor, onChange } = setup();
    await act(async () => { editor().commands.insertContent("요약해"); });
    expect(onChange).toHaveBeenLastCalledWith([{ t: "text", v: "요약해" }]);
  });

  it("Enter submits; Shift+Enter does not", async () => {
    const { pm, onSubmit, editor } = setup({ value: [{ t: "text", v: "요약" }] });
    await act(async () => { editor().commands.focus("end"); });
    fireEvent.keyDown(pm(), { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(pm(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 단일 문단 — Enter 가 문단을 쪼개지 않았다.
    expect(editor().state.doc.childCount).toBe(1);
  });

  it("'/' opens the ctx menu grouped, disabled items are inert, choosing runs the item's action and removes the '/' (D16)", async () => {
    addBody.mockClear();
    const { editor, onChange } = setup();
    await act(async () => { editor().commands.insertContent("/"); });
    const menu = await waitFor(() => {
      const el = document.querySelector(".askai-slash-menu");
      expect(el).toBeTruthy();
      return el!;
    });
    await waitFor(() => expect(menu.textContent).toContain("지금 노트"));
    const disabled = screen.getByRole("option", { name: /선택 영역/ });
    expect(disabled).toHaveProperty("disabled", true);
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: /본문 전체/ })); });
    expect(addBody).toHaveBeenCalledTimes(1);
    // 문장에는 아무것도 끼어들지 않는다 — 참조는 상자 밖이 소유한다(D15).
    expect(onChange).toHaveBeenLastCalledWith([]);
    await waitFor(() => expect(document.querySelector(".askai-slash-menu")).toBeNull());
  });

  it("Escape closes the '/' menu", async () => {
    const { editor, pm } = setup();
    await act(async () => { editor().commands.insertContent("/"); });
    await waitFor(() => expect(document.querySelector(".askai-slash-menu")).toBeTruthy());
    await act(async () => { fireEvent.keyDown(pm(), { key: "Escape" }); });
    await waitFor(() => expect(document.querySelector(".askai-slash-menu")).toBeNull());
  });

  it("clicking a lang slot opens the picker; picking replaces the slot value", async () => {
    const { editor, pm, onChange } = setup({ value: stampDoc });
    await waitFor(() => expect(pm().querySelector(".askai-slot")).toBeTruthy());
    const slot = pm().querySelector(".askai-slot")!;
    await act(async () => { fireEvent.click(slot); });
    const picker = await screen.findByTestId("askai-slot-picker");
    expect(picker.textContent).toContain("일본어");
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: "일본어" })); });
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining([{ t: "slot", key: "lang", kind: "lang", v: "일본어" }]));
    expect(editor().getText()).toContain("일본어로 번역해");
  });

  it("renders the ghost overlay when provided", () => {
    const { container, rerender, onChange, onSubmit } = setup({ ghost: stampDoc });
    const ghost = screen.getByTestId("askai-ghost");
    expect(ghost.textContent).toContain("영어로 번역해");
    rerender(<AskAiComposer value={[]} onChange={onChange} onSubmit={onSubmit} ctxItems={ctxItems} ghost={null} />);
    expect(container.querySelector(".askai-ghost")).toBeNull();
  });
});
