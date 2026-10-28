import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberTicker } from "./NumberTicker";
import { SegmentedControl } from "./SegmentedControl";
import { ThinkingLoader } from "./ThinkingLoader";

afterEach(() => vi.useRealTimers());

describe("SegmentedControl", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B", disabled: true },
    { value: "c", label: "C", count: 3 },
  ];

  it("활성 칸만 탭 정지점이고 방향키는 비활성 칸을 건너뛴다", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="a" onChange={onChange} options={options} ariaLabel="seg" />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("c");
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(radios[2], { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("비활성 칸 클릭은 선택하지 않는다", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="a" onChange={onChange} options={options} ariaLabel="seg" />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("값이 목록 밖이어도 첫 칸이 탭으로 닿는다", () => {
    render(<SegmentedControl value={"zzz" as "a"} onChange={() => {}} options={options} ariaLabel="seg" />);
    expect(screen.getAllByRole("radio")[0].tabIndex).toBe(0);
  });

  it("scrollIntoView 를 부르지 않는다 — 조상 스크롤 컨테이너(설정 본문)를 끌어내리지 않게", () => {
    const spy = vi.fn();
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, "scrollIntoView");
    const prev = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      const { rerender } = render(<SegmentedControl value="a" onChange={() => {}} options={options} ariaLabel="seg" />);
      rerender(<SegmentedControl value="c" onChange={() => {}} options={options} ariaLabel="seg" />);
      rerender(<SegmentedControl value="a" onChange={() => {}} options={options} variant="underline" ariaLabel="seg" />);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (had) Element.prototype.scrollIntoView = prev;
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("좁아서 가로로 구를 때만 띠 자신의 scrollLeft 로 활성 칸을 보이게 한다", () => {
    // jsdom 은 레이아웃이 없다 — 칸 셋(폭 100, 왼쪽 0/100/200)과 보이는 폭 100 인 띠(내용 300)를 흉내 낸다.
    const LEFT: Record<string, number> = { A: 0, B: 100, C: 200 };
    const proto = HTMLElement.prototype;
    const defs = {
      offsetLeft: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "radio" ? LEFT[this.textContent!.replace(/\d+$/, "")] ?? 0 : 0; } },
      offsetWidth: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "radio" ? 100 : 0; } },
      scrollWidth: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "radiogroup" ? 300 : 0; } },
      clientWidth: { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "radiogroup" ? 100 : 0; } },
    } as const;
    const saved = Object.fromEntries(
      (Object.keys(defs) as Array<keyof typeof defs>).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]),
    );
    for (const k of Object.keys(defs) as Array<keyof typeof defs>) Object.defineProperty(proto, k, defs[k]);
    try {
      const opts = [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ];
      const { rerender } = render(<SegmentedControl value="c" onChange={() => {}} options={opts} ariaLabel="seg" />);
      const root = screen.getByRole("radiogroup");
      expect(root.scrollLeft).toBe(200); // 오른쪽으로 잘리던 칸 → 오른쪽 끝에 맞춘다
      rerender(<SegmentedControl value="b" onChange={() => {}} options={opts} ariaLabel="seg" />);
      expect(root.scrollLeft).toBe(100); // 왼쪽으로 잘리던 칸 → 왼쪽 끝에 맞춘다
      rerender(<SegmentedControl value="a" onChange={() => {}} options={opts} ariaLabel="seg" />);
      expect(root.scrollLeft).toBe(0);
    } finally {
      for (const k of Object.keys(defs) as Array<keyof typeof defs>) {
        if (saved[k]) Object.defineProperty(proto, k, saved[k]!);
        else delete (proto as unknown as Record<string, unknown>)[k];
      }
    }
  });
});

describe("ThinkingLoader", () => {
  it("타이머로 단계가 넘어가고 마지막에서 멈추며 done 이면 완료 라벨", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ThinkingLoader phases={["첫째", "둘째"]} interval={1000} doneLabel={(s) => `${s}초`} />);
    expect(screen.getByRole("status").textContent).toBe("첫째");
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status").textContent).toBe("둘째");
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByRole("status").textContent).toBe("둘째");
    rerender(<ThinkingLoader phases={["첫째", "둘째"]} interval={1000} done doneLabel={(s) => `${s}초`} />);
    expect(screen.getByRole("status").textContent).toMatch(/^\d+초$/);
  });

  it("phase 를 직접 주면 타이머보다 우선하고 범위를 벗어나도 clamp 된다", () => {
    render(<ThinkingLoader phases={["a", "b"]} phase={9} />);
    expect(screen.getByRole("status").textContent).toBe("b");
  });
});

describe("NumberTicker", () => {
  it("스크린리더에는 완성된 숫자 하나만 읽히고 자릿수만큼 기둥이 있다", () => {
    const { container } = render(<NumberTicker value={1234} locale="en-US" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("1,234");
    expect(container.querySelectorAll(".ticker__digit")).toHaveLength(4);
  });

  it("값이 바뀌면 기둥이 해당 숫자 위치로 굴러간다", () => {
    const { container, rerender } = render(<NumberTicker value={10} locale="en-US" />);
    const cols = () => Array.from(container.querySelectorAll<HTMLElement>(".ticker__col")).map((c) => c.style.transform);
    expect(cols()).toEqual(["translateY(-1em)", "translateY(0em)"]);
    rerender(<NumberTicker value={27} locale="en-US" />);
    expect(cols()).toEqual(["translateY(-2em)", "translateY(-7em)"]);
  });
});
