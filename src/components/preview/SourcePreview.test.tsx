import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Source } from "../../lib/commands.gen";
import { SourcePreview } from "./SourcePreview";
import { t } from "../../i18n/t";

// 본문 렌더(TipTap)는 이 파일의 관심사가 아니다 — 여기서 고정하는 건 "잘렸다는 사실을 말하는가".
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ text }: { text: string }) => <div data-testid="body">{text}</div>,
}));

function source(truncated: boolean): Source {
  return { id: "s1", name: "deck.pptx", ext: "PPTX", body: "본문", position: 0, truncated };
}

describe("SourcePreview — 추출 절단 고지", () => {
  it("잘린 사료는 본문 위에 한 줄로 알린다", () => {
    render(<SourcePreview src={source(true)} />);
    expect(screen.getByTestId("source-truncated").textContent).toBe(t("sources.body_truncated"));
    expect(screen.getByTestId("body").textContent).toBe("본문");
  });

  it("안 잘린 사료엔 아무 말도 하지 않는다", () => {
    render(<SourcePreview src={source(false)} />);
    expect(screen.queryByTestId("source-truncated")).toBeNull();
  });
});
