import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AskAiHeader } from "./AskAiHeader";

describe("AskAiHeader", () => {
  it("is the brand only — folder/note/stats moved to the context strip (6안 D19)", () => {
    render(<AskAiHeader />);
    const head = screen.getByTestId("askai-header");
    expect(head.textContent).toBe("AI");
    expect(head.querySelector("svg")).toBeTruthy();
  });
});
