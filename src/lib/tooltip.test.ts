import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTooltips } from "./tooltip";

function hover(el: Element) {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}
function leave(el: Element, to: Element | null = null) {
  el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
}

describe("전역 툴팁", () => {
  let doc: Document;
  let btn: HTMLButtonElement;
  beforeEach(() => {
    vi.useFakeTimers();
    // 테스트마다 새 문서 — 리스너가 문서에 붙으므로 겹치지 않게.
    doc = document.implementation.createHTMLDocument("t");
    installTooltips(doc);
    doc.body.innerHTML = `<button title="저장">s</button><button title="삭제">d</button>`;
    btn = doc.querySelector("button")!;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("호버하면 OS 툴팁을 막으려 title 을 떼고, 지연 뒤 말풍선을 띄운다", () => {
    hover(btn);
    expect(btn.hasAttribute("title")).toBe(false);
    expect(doc.querySelector(".tip")).toBeNull();
    vi.advanceTimersByTime(400);
    expect(doc.querySelector(".tip")?.textContent).toBe("저장");
  });

  it("벗어나면 말풍선이 사라지고 title 이 돌아온다", () => {
    hover(btn);
    vi.advanceTimersByTime(400);
    leave(btn);
    expect(doc.querySelector(".tip")).toBeNull();
    expect(btn.getAttribute("title")).toBe("저장");
  });

  it("바로 이웃으로 옮기면 지연 없이 뜬다", () => {
    const [a, b] = Array.from(doc.querySelectorAll("button"));
    hover(a);
    vi.advanceTimersByTime(400);
    leave(a, b);
    hover(b);
    expect(doc.querySelector(".tip")?.textContent).toBe("삭제");
  });

  it("아이콘 버튼 안쪽 자식으로 포인터가 옮겨 가도 말풍선이 유지되고 title 은 여전히 떨어져 있다", () => {
    doc.body.innerHTML = `<button title="저장"><svg><path/></svg></button>`;
    const b = doc.querySelector("button")!;
    const icon = doc.querySelector("svg")!;
    const child = doc.querySelector("path")!;
    hover(b);
    vi.advanceTimersByTime(400);
    expect(doc.querySelector(".tip")?.textContent).toBe("저장");
    // 버튼 → svg → path 로 이동: mouseout(relatedTarget=자식) 뒤 mouseover(자식)
    leave(b, icon);
    hover(icon);
    leave(icon, child);
    hover(child);
    expect(doc.querySelector(".tip")?.textContent).toBe("저장");
    expect(b.hasAttribute("title")).toBe(false);
  });

  it("버튼 안쪽 자식에서 시작된 호버도 지연 뒤 말풍선을 띄운다", () => {
    doc.body.innerHTML = `<button title="저장"><svg><path/></svg></button>`;
    const child = doc.querySelector("path")!;
    hover(child);
    expect(doc.querySelector(".tip")).toBeNull();
    vi.advanceTimersByTime(400);
    expect(doc.querySelector(".tip")?.textContent).toBe("저장");
    expect(doc.querySelector("button")!.hasAttribute("title")).toBe(false);
  });

  it("호버 중 title 이 새로 쓰이면 떠날 때 덮어쓰지 않는다", () => {
    hover(btn);
    btn.setAttribute("title", "새 값");
    leave(btn);
    expect(btn.getAttribute("title")).toBe("새 값");
  });
});
