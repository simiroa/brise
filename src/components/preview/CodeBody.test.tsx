import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CodeBody, codeLanguage } from "./CodeBody";

describe("codeLanguage", () => {
  it("확장자를 하이라이트 언어로 옮긴다", () => {
    expect(codeLanguage("py")).toBe("py");
    expect(codeLanguage("ts")).toBe("ts");
    expect(codeLanguage("tsx")).toBe("typescript");
    expect(codeLanguage("rs")).toBe("rs");
  });
  it("모르는 확장자는 null(평문)", () => {
    expect(codeLanguage("zzz")).toBeNull();
  });
});

describe("CodeBody", () => {
  it("토큰을 하이라이트하고 줄 번호를 그린다", () => {
    const { container } = render(<CodeBody text={"def f():\n    return 1\n"} ext="py" />);
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    expect(screen.getByTestId("code-gutter").textContent).toBe("1\n2\n3");
    expect(screen.getByTestId("code-body").getAttribute("data-lang")).toBe("py");
  });

  it("모르는 확장자는 원문 그대로 평문으로 보인다", () => {
    const { container } = render(<CodeBody text={"a <b> & c"} ext="log" />);
    expect(screen.getByTestId("code-body").getAttribute("data-lang")).toBe("plain");
    expect(container.querySelector("code")?.textContent).toBe("a <b> & c");
  });

  it("하단 줄에 파일명·언어·줄 수를 보이고 복사 버튼이 본문을 클립보드로 보낸다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CodeBody text={"a = 1\nb = 2"} ext="py" name="x.py" />);
    const header = screen.getByTestId("code-footer");
    expect(header.textContent).toContain("x.py");
    expect(header.textContent).toContain("py");
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("data-copied")).toBe("true"));
    expect(writeText).toHaveBeenCalledWith("a = 1\nb = 2");
  });
});
