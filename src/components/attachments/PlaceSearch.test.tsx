import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { usePlaceSearch, PlaceSearchResults } from "./PlaceSearch";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

const RESULTS = [
  { label: "12, Main Street, Seoul, 04340, Korea", lat: 37.5, lng: 127.0 },
  { label: "경복궁, 사직로, 종로구", lat: 37.58, lng: 126.97 },
  { label: "부산", lat: 35.18, lng: 129.08 },
];

function Harness({ onPick, onEscape }: { onPick: (i: unknown) => void; onEscape?: () => void }) {
  const [q, setQ] = useState("");
  const binding = usePlaceSearch({ query: q, uiLang: "ko", onPick, onEscape });
  return (
    <div>
      <input data-testid="in" value={q} onChange={(e) => setQ(e.target.value)} {...binding.inputProps} />
      <PlaceSearchResults binding={binding} query={q} testIdPrefix="res" />
    </div>
  );
}

describe("PlaceSearch — 키보드 탐색 / 접근성", () => {
  beforeEach(() => {
    callMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const typeAndLoad = async (value = "서울") => {
    fireEvent.change(screen.getByTestId("in"), { target: { value } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
  };

  it("결과가 이름 + 부가 주소 두 줄로 나오고 title 에 원본 라벨이 남는다 (번지수 시작 라벨 포함)", async () => {
    callMock.mockResolvedValue({ results: RESULTS });
    render(<Harness onPick={vi.fn()} />);
    await typeAndLoad();
    const row0 = screen.getByTestId("res-0");
    expect(row0.getAttribute("title")).toBe(RESULTS[0].label);
    expect(row0.children[0].textContent).toBe("Main Street");
    expect(row0.children[1].textContent).toBe("Seoul, 04340, Korea");
    expect(screen.getByTestId("res-2").children).toHaveLength(1); // 부가 주소 없음
  });

  it("listbox/option 역할 + aria-activedescendant 가 ↑↓ 로 따라 움직인다", async () => {
    callMock.mockResolvedValue({ results: RESULTS });
    render(<Harness onPick={vi.fn()} />);
    await typeAndLoad();
    const input = screen.getByTestId("in");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("res-0").getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByTestId("res-0").id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("res-1").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("res-0").getAttribute("aria-selected")).toBe("false");

    // 위로 두 번 → 처음에서 마지막으로 순환
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("res-2").getAttribute("aria-selected")).toBe("true");
  });

  it("선택 후 Enter 는 그 항목을 확정한다", async () => {
    callMock.mockResolvedValue({ results: RESULTS });
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await typeAndLoad();
    const input = screen.getByTestId("in");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(RESULTS[1]);
  });

  it("선택이 없을 때 Enter 는 디바운스를 건너뛰는 즉시 검색이다", async () => {
    callMock.mockResolvedValue({ results: RESULTS });
    render(<Harness onPick={vi.fn()} />);
    fireEvent.change(screen.getByTestId("in"), { target: { value: "서울" } });
    expect(callMock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("in"), { key: "Enter" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "서울", lang: "ko" });
  });

  it("IME 조합 중 Enter/방향키는 무시한다", async () => {
    callMock.mockResolvedValue({ results: RESULTS });
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await typeAndLoad();
    const input = screen.getByTestId("in");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("res-0").getAttribute("aria-selected")).toBe("true");
  });

  it("onEscape 가 있으면 Esc 를 가로채 부르고, 없으면 흘려보낸다", async () => {
    const onEscape = vi.fn();
    const { unmount } = render(<Harness onPick={vi.fn()} onEscape={onEscape} />);
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(screen.getByTestId("in"), { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    unmount();

    render(<Harness onPick={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId("in"), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", outer);
  });

  it("검색 실패 시 '다시 시도' 버튼이 나오고 누르면 재검색한다", async () => {
    callMock.mockRejectedValueOnce(new Error("down"));
    render(<Harness onPick={vi.fn()} />);
    await typeAndLoad("Paris");
    const retry = screen.getByTestId("res-retry");
    callMock.mockResolvedValue({ results: RESULTS });
    fireEvent.click(retry);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
