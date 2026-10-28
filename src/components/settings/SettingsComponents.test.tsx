import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSettingsStore } from "../../stores/settings";
import { SwitchGrid, type SwitchGridItem } from "./SwitchGrid";
import { MetricTileGroup, MetricTile, type MetricTileItem } from "./MetricTileGroup";
import { StorageGauge } from "./StorageGauge";

describe("Settings Common Components", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko" });
  });

  describe("SwitchGrid 한 열 (2026-10-27 설정 디자인 개편)", () => {
    it("항상 한 열 flex — 열 규칙이 없고 힌트는 그대로 라벨에 붙는다", () => {
      const items: SwitchGridItem[] = [
        { id: "autostart", label: "시작 시 자동 실행", hint: "시스템 부팅 시 자동으로 앱을 실행합니다.", checked: true, onChange: vi.fn() },
        { id: "notifications", label: "알림 사용", checked: false, onChange: vi.fn() },
      ];
      render(<SwitchGrid items={items} aria-label="앱 동작" />);
      const grid = screen.getByTestId("switch-grid");
      expect(grid.style.flexDirection).toBe("column");
      expect(grid.style.gridTemplateColumns).toBe("");
      expect(screen.getByLabelText("시스템 부팅 시 자동으로 앱을 실행합니다.")).toBeTruthy();
    });
  });

  describe("MetricTileGroup & MetricTile", () => {
    it("renders 3-column metric tiles with icons, values, labels, and subtexts", () => {
      const tiles: MetricTileItem[] = [
        {
          id: "days",
          icon: <span data-testid="tile-icon-days">📅</span>,
          value: 9,
          label: "사용일",
          subtext: "기록 시작 후 경과 일수",
        },
        {
          id: "notes",
          icon: <span data-testid="tile-icon-notes">📝</span>,
          value: "30",
          label: "노트",
        },
        {
          id: "attachments",
          icon: <span data-testid="tile-icon-att">📎</span>,
          value: 19,
          label: "첨부파일",
          testId: "custom-att-tile",
        },
      ];

      render(<MetricTileGroup tiles={tiles} />);

      const group = screen.getByTestId("metric-tile-group");
      expect(group.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");

      expect(screen.getByTestId("metric-tile-days")).toBeTruthy();
      expect(screen.getByTestId("tile-icon-days")).toBeTruthy();
      expect(screen.getByText("9")).toBeTruthy();
      expect(screen.getByText("사용일")).toBeTruthy();
      expect(screen.getByText("기록 시작 후 경과 일수")).toBeTruthy();

      expect(screen.getByTestId("metric-tile-notes")).toBeTruthy();
      expect(screen.getByText("30")).toBeTruthy();
      expect(screen.getByText("노트")).toBeTruthy();

      // Custom test ID preserved
      expect(screen.getByTestId("custom-att-tile")).toBeTruthy();
      expect(screen.getByText("19")).toBeTruthy();
      expect(screen.getByText("첨부파일")).toBeTruthy();
    });

    it("renders standalone MetricTile component", () => {
      const tile: MetricTileItem = {
        id: "total_cap",
        icon: <span>⚡</span>,
        value: 24,
        label: "전체 기능",
        subtext: "모든 AI 기능의 합계입니다.",
      };

      render(<MetricTile tile={tile} />);

      expect(screen.getByTestId("metric-tile-total_cap")).toBeTruthy();
      expect(screen.getByText("24")).toBeTruthy();
      expect(screen.getByText("전체 기능")).toBeTruthy();
      expect(screen.getByText("모든 AI 기능의 합계입니다.")).toBeTruthy();
    });
  });

  describe("StorageGauge", () => {
    it("renders breakdown text and ratio text", () => {
      render(
        <StorageGauge
          usedBytes={3 * 1024 * 1024}
          totalBytes={10 * 1024 * 1024 * 1024}
          breakdownText="DB 3 MB · 첨부파일 0 KB (이미지 0 KB)"
          ratioText="3 MB / 10 GB"
        />
      );

      expect(screen.getByText("DB 3 MB · 첨부파일 0 KB (이미지 0 KB)")).toBeTruthy();
      expect(screen.getByText("3 MB / 10 GB")).toBeTruthy();

      const progressBar = screen.getByRole("progressbar");
      expect(progressBar).toBeTruthy();
      expect(progressBar.style.background).toBe("var(--accent)");
    });

    it("calculates default ratioText using formatSize when ratioText is omitted", () => {
      render(
        <StorageGauge
          usedBytes={500 * 1024 * 1024}
          totalBytes={1024 * 1024 * 1024}
          breakdownText="저장 용량"
          testId="storage-test"
        />
      );

      expect(screen.getByTestId("storage-test-breakdown").textContent).toBe("저장 용량");
      // 500 MB / 1.0 GB
      const ratioEl = screen.getByTestId("storage-test-ratio");
      expect(ratioEl.textContent).toContain("500 MB");
      expect(ratioEl.textContent).toContain("1.0 GB");

      const bar = screen.getByTestId("storage-test-bar");
      // 500MB / 1024MB ≈ 48.8%
      const widthVal = parseFloat(bar.style.width);
      expect(widthVal).toBeGreaterThan(48);
      expect(widthVal).toBeLessThan(50);
    });

    it("clamps progress bar width between 0% and 100%", () => {
      const { rerender } = render(
        <StorageGauge
          usedBytes={-100}
          totalBytes={1000}
          breakdownText="음수 테스트"
        />
      );

      const barNegative = screen.getByRole("progressbar");
      expect(barNegative.style.width).toBe("0%");
      expect(barNegative.getAttribute("aria-valuenow")).toBe("0");

      rerender(
        <StorageGauge
          usedBytes={5000}
          totalBytes={1000}
          breakdownText="초과 테스트"
        />
      );

      const barOverflow = screen.getByRole("progressbar");
      expect(barOverflow.style.width).toBe("100%");
      expect(barOverflow.getAttribute("aria-valuenow")).toBe("100");

      rerender(
        <StorageGauge
          usedBytes={100}
          totalBytes={0}
          breakdownText="0으로 나누기 테스트"
        />
      );

      // PLAN-2026-09-15 D7: 분모 0 이면 바 자체를 그리지 않는다.
      expect(screen.queryByRole("progressbar")).toBeNull();
    });
  });
});
