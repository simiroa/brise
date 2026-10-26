import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { SectionNameTitle } from "./SectionNameTitle";

/** 부모(SectionWindowApp)처럼 커밋 성공 시에만 prop 이름을 바꾼다. accept=false 면 거부(이름 불변). */
function Host({ onCommit, accept = true }: { onCommit: (n: string) => void; accept?: boolean }) {
  const [name, setName] = useState("Old");
  return (
    <SectionNameTitle
      name={name}
      noteTitle="Note"
      onCommit={async (n) => {
        onCommit(n);
        if (accept) setName(n.trim());
      }}
    />
  );
}

const input = (c: HTMLElement) => c.querySelector('[data-testid="section-window-name"]') as HTMLInputElement;

async function type(el: HTMLInputElement, v: string) {
  el.focus();
  fireEvent.change(el, { target: { value: v } });
}

describe("SectionNameTitle", () => {
  it("Enter commits once (the following blur does not commit again)", async () => {
    const onCommit = vi.fn();
    const { container } = render(<Host onCommit={onCommit} />);
    const el = input(container);
    await type(el, "New");
    await act(async () => {
      fireEvent.keyDown(el, { key: "Enter" });
      fireEvent.blur(el);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("New");
    expect(el.value).toBe("New");
  });

  it("Escape cancels without committing and restores the original name", async () => {
    const onCommit = vi.fn();
    const { container } = render(<Host onCommit={onCommit} />);
    const el = input(container);
    await type(el, "Typo");
    expect(document.activeElement).toBe(el);
    await act(async () => {
      fireEvent.keyDown(el, { key: "Escape" }); // 핸들러의 blur() 가 실제 blur 를 낸다
    });
    expect(document.activeElement).not.toBe(el);
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.value).toBe("Old");
  });

  it("blur with no edit does not commit", async () => {
    const onCommit = vi.fn();
    const { container } = render(<Host onCommit={onCommit} />);
    const el = input(container);
    el.focus();
    await act(async () => {
      fireEvent.blur(el);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("blur after an edit commits once", async () => {
    const onCommit = vi.fn();
    const { container } = render(<Host onCommit={onCommit} />);
    const el = input(container);
    await type(el, "Blurred");
    await act(async () => {
      fireEvent.blur(el);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Blurred");
  });

  it("a rejected commit falls back to the prop name", async () => {
    const onCommit = vi.fn();
    const { container } = render(<Host onCommit={onCommit} accept={false} />);
    const el = input(container);
    await type(el, "   ");
    await act(async () => {
      fireEvent.keyDown(el, { key: "Enter" });
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(el.value).toBe("Old");
  });
});
