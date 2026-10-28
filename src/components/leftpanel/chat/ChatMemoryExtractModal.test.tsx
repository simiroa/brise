import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatMemoryExtractModal } from "./ChatMemoryExtractModal";

describe("ChatMemoryExtractModal", () => {
  it("후보는 처음엔 전부 체크돼 있고, 체크를 풀면 남은 것만 저장한다", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ChatMemoryExtractModal candidates={["가", "나", "다"]} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("chat-memory-extract-item-1"));
    fireEvent.click(screen.getByTestId("chat-memory-extract-save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(["가", "다"]));
  });

  it("후보가 없으면 안내 한 줄만 보이고 저장 단추는 없다", () => {
    render(<ChatMemoryExtractModal candidates={[]} onSave={vi.fn()} onClose={() => {}} />);
    expect(screen.getByTestId("chat-memory-extract-empty")).toBeTruthy();
    expect(screen.queryByTestId("chat-memory-extract-save")).toBeNull();
  });

  it("onOpenMemory 가 없으면(브라우저) 저장된 기억 보기 단추를 숨긴다", () => {
    const { rerender } = render(<ChatMemoryExtractModal candidates={["가"]} onSave={vi.fn()} onClose={() => {}} />);
    expect(screen.queryByTestId("chat-memory-extract-open")).toBeNull();
    const open = vi.fn();
    rerender(<ChatMemoryExtractModal candidates={["가"]} onSave={vi.fn()} onOpenMemory={open} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("chat-memory-extract-open"));
    expect(open).toHaveBeenCalled();
  });
});
