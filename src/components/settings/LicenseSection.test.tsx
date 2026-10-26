import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LicenseSection } from "./LicenseSection";
import koSettings from "../../i18n/ko/settings.json";

// 2026-09-02 개정: 창 안 iframe(2.8MB 전문, 자기 흰 배경을 칠해 다크 위에서 혼자 밝게 떴다)을
// 걷어내고 요약 카드 + OS 로 전문 열기로 바꿨다. 그래서 iframe 관련 케이스는 전부 사라지고,
// "전문을 웹뷰에 물리지 않는다"는 것 자체가 검사 대상이 된다.

const { mockResolveResource, mockOpenPath, summaryMock } = vi.hoisted(() => ({
  mockResolveResource: vi.fn().mockResolvedValue("C:\\fake\\resources\\THIRD-PARTY-NOTICES.html"),
  mockOpenPath: vi.fn().mockResolvedValue(undefined),
  summaryMock: {
    generatedAt: "2026-10-18",
    npmTotal: 181,
    rustTotal: 726,
    noTextTotal: 0,
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: (path: string) => mockResolveResource(path),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (path: string) => mockOpenPath(path),
}));

vi.mock("../../lib/noticesSummary.json", () => ({
  default: summaryMock,
}));

const { browserFlag } = vi.hoisted(() => ({ browserFlag: { value: false } }));
vi.mock("../../lib/env", () => ({ isBrowser: () => browserFlag.value }));

describe("LicenseSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserFlag.value = false;
    summaryMock.noTextTotal = 0;
    mockResolveResource.mockResolvedValue("C:\\fake\\resources\\THIRD-PARTY-NOTICES.html");
    mockOpenPath.mockResolvedValue(undefined);
  });

  it("전문을 웹뷰에 물리지 않는다 — iframe 없이 요약만 그린다", () => {
    render(<LicenseSection />);
    expect(document.querySelector("iframe")).toBeNull();
    // 요약 수치는 noticesSummary.json 이 SSOT — 전문과 같은 실행에서 생성된다.
    expect(screen.getByTestId("settings-license-tiles")).toBeTruthy();
    expect(screen.getByTestId("metric-tile-npm").textContent).toMatch(/\d/);
    // 페이지를 여는 것만으로 리소스를 읽지 않는다(예전 iframe 은 마운트 즉시 2.8MB 를 로드했다).
    expect(mockResolveResource).not.toHaveBeenCalled();
  });

  // Q8(HANDOFF-2026-10-18 § Wave NOTICES): noTextTotal 이 0 이면 전문 없음 타일 숨김, >0 이면 표시
  it("noTextTotal 이 0이면 전문 없음 타일을 숨기고 npm/rust 타일만 보여준다", () => {
    summaryMock.noTextTotal = 0;
    render(<LicenseSection />);
    expect(screen.getByTestId("metric-tile-npm").textContent).toContain(String(summaryMock.npmTotal));
    expect(screen.getByTestId("metric-tile-rust").textContent).toContain(String(summaryMock.rustTotal));
    expect(screen.queryByTestId("metric-tile-notext")).toBeNull();
    expect(screen.getByTestId("settings-license-generated").textContent).toContain(summaryMock.generatedAt);
  });

  it("noTextTotal 이 3(>0)이면 전문 없음 타일을 보여준다", () => {
    summaryMock.noTextTotal = 3;
    render(<LicenseSection />);
    expect(screen.getByTestId("metric-tile-notext").textContent).toContain("3");
  });

  // 한컴 공개 문서 고지(조사 §6.7) — HWPX 가져오기·내보내기가 그 문서를 참고해 만들어졌다는 고지 조건.
  it("한컴 .hwp 공개 문서 참고 고지를 보인다", () => {
    render(<LicenseSection />);
    const notice = screen.getByTestId("settings-license-hancom").textContent ?? "";
    expect(notice).toMatch(/Hancom/);
    expect(notice).toMatch(/\.hwp/);
  });

  // 스펙 PDF 의 저작권 안내가 요구한 문장이다 — 의역하면 고지 조건을 못 채운다(한컴→한글과컴퓨터, 글 문서 파일→HWP 문서 파일로 바뀐 적이 있다).
  it("ko 고지 문구는 스펙이 요구한 문장 그대로다", () => {
    expect(koSettings.license_hancom_notice).toBe("본 제품은 한글과컴퓨터의 글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.");
  });

  it("버튼을 눌러야 고지문 전문을 OS 로 연다", async () => {
    render(<LicenseSection />);
    fireEvent.click(screen.getByTestId("settings-open-licenses-btn"));
    await waitFor(() => {
      expect(mockResolveResource).toHaveBeenCalledWith("THIRD-PARTY-NOTICES.html");
      expect(mockOpenPath).toHaveBeenCalledWith("C:\\fake\\resources\\THIRD-PARTY-NOTICES.html");
    });
  });

  it("열기에 실패하면 조용히 삼키지 않고 안내를 띄운다", async () => {
    mockResolveResource.mockRejectedValueOnce(new Error("Resource not found"));
    render(<LicenseSection />);
    expect(screen.queryByTestId("settings-license-open-failed")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-open-licenses-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("settings-license-open-failed")).toBeTruthy();
    });
  });

  // F7(PLAN-2026-09-15): 브라우저 탭에서는 조용히 아무 일도 안 하던 버튼 — 이제 꺼져 있고 이유를 말한다.
  it("브라우저 모드에서는 전문 열기가 비활성이고 데스크톱 전용임을 말한다", () => {
    browserFlag.value = true;
    render(<LicenseSection />);
    const btn = screen.getByTestId("settings-open-licenses-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("Desktop app only");
    fireEvent.click(btn);
    expect(mockResolveResource).not.toHaveBeenCalled();
  });
});
