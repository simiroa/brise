import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExcludedDomainsSection } from "./ExcludedDomainsSection";
import { useSettingsStore } from "../../stores/settings";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  emitNotice: vi.fn(),
}));

describe("ExcludedDomainsSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({ collectExcludedDomains: ["a.com"] } as any);
  });

  it("스토어의 도메인 목록을 한 줄에 하나로 보여준다", () => {
    render(<ExcludedDomainsSection />);
    const ta = screen.getByLabelText(/도메인|domain/i) as HTMLTextAreaElement;
    expect(ta.value).toBe("a.com");
    expect(screen.getByTestId("settings-collect-excluded")).toBeTruthy();
  });

  it("blur 시 정규화(공백·앞 점·대문자 제거)해서 저장한다", async () => {
    const setSpy = vi.fn(async () => {});
    useSettingsStore.setState({ setCollectExcludedDomains: setSpy } as any);
    render(<ExcludedDomainsSection />);
    const ta = screen.getByLabelText(/도메인|domain/i);
    fireEvent.change(ta, { target: { value: " .Foo.com \n\nbar.io" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith(["foo.com", "bar.io"]));
  });

  // 저장이 실패하면 스토어가 이전 값으로 되돌아간다 — 그 되돌림이 사용자가 친 초안을 지우면 안 된다.
  it("저장 실패로 스토어가 롤백돼도 입력한 초안은 그대로 남는다", async () => {
    const setSpy = vi.fn(async (v: string[]) => {
      useSettingsStore.setState({ collectExcludedDomains: v } as any); // 낙관적 반영
      useSettingsStore.setState({ collectExcludedDomains: ["a.com"] } as any); // 실패 → 롤백
    });
    useSettingsStore.setState({ setCollectExcludedDomains: setSpy } as any);
    render(<ExcludedDomainsSection />);
    const ta = screen.getByLabelText(/도메인|domain/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "a.com\nnew.io" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    await waitFor(() => expect(ta.value).toBe("a.com\nnew.io"));
  });

  it("200개를 넘으면 앞 200개만 저장하고 잘린 개수를 알린다", async () => {
    const setSpy = vi.fn(async (v: string[]) => {
      useSettingsStore.setState({ collectExcludedDomains: v } as any);
    });
    useSettingsStore.setState({ setCollectExcludedDomains: setSpy } as any);
    render(<ExcludedDomainsSection />);
    const ta = screen.getByLabelText(/도메인|domain/i);
    const many = Array.from({ length: 203 }, (_, i) => `d${i}.com`).join("\n");
    fireEvent.change(ta, { target: { value: many } });
    fireEvent.blur(ta);
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    expect((setSpy.mock.calls[0][0] as string[]).length).toBe(200);
    expect((await screen.findByTestId("settings-collect-excluded-dropped")).textContent).toContain("3");
  });

  it("빈 칸에 예시 placeholder 를 보여준다", () => {
    useSettingsStore.setState({ collectExcludedDomains: [] } as any);
    render(<ExcludedDomainsSection />);
    const ta = screen.getByLabelText(/도메인|domain/i) as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("example.com");
  });
});
