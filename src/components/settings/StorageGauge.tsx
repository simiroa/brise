import type { CSSProperties } from "react";
import { formatSize } from "../../lib/ui";

export interface StorageGaugeProps {
  usedBytes: number;
  totalBytes: number;
  breakdownText: string;
  ratioText?: string;
  testId?: string;
  /** 사용자가 정한 한도를 넘었다 — 막대를 경고색으로. */
  over?: boolean;
}

/**
 * Storage usage progress gauge for settings.
 * Displays storage breakdown text, usage ratio, and a 6px pill progress bar (caption only when totalBytes <= 0).
 */
export function StorageGauge({
  usedBytes,
  totalBytes,
  breakdownText,
  ratioText,
  testId,
  over,
}: StorageGaugeProps) {
  const ratio = totalBytes > 0 ? usedBytes / totalBytes : 0;
  const percentage = Math.min(100, Math.max(0, ratio * 100));

  // PLAN-2026-09-15 D7: 분모를 모르면(디스크 여유 조회 실패) 바 없이 숫자만.
  const resolvedRatioText =
    ratioText ?? (totalBytes > 0 ? `${formatSize(usedBytes)} / ${formatSize(totalBytes)}` : formatSize(usedBytes));

  const trackStyle: CSSProperties = {
    height: 6,
    width: "100%",
    borderRadius: "var(--radius-pill)",
    background: "var(--surface-sunken)",
    overflow: "hidden",
    boxSizing: "border-box",
  };

  const fillStyle: CSSProperties = {
    width: `${percentage}%`,
    height: "100%",
    background: over ? "var(--danger)" : "var(--accent)",
    borderRadius: "var(--radius-pill)",
    transition: "width var(--dur-slow) ease",
  };

  return (
    <div
      data-testid={testId ?? "storage-gauge"}
      style={{ width: "100%", boxSizing: "border-box" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: totalBytes > 0 ? "var(--space-2)" : 0,
          gap: "var(--space-4)",
        }}
      >
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--muted)",
            fontWeight: 400,
            lineHeight: "var(--lh-ui)",
          }}
          data-testid={testId ? `${testId}-breakdown` : "storage-gauge-breakdown"}
        >
          {breakdownText}
        </span>
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--muted)",
            fontWeight: 600,
            lineHeight: "var(--lh-ui)",
            flexShrink: 0,
          }}
          data-testid={testId ? `${testId}-ratio` : "storage-gauge-ratio"}
        >
          {resolvedRatioText}
        </span>
      </div>

      {totalBytes > 0 && (
        <div style={trackStyle}>
          <div
            role="progressbar"
            aria-valuenow={Math.round(percentage)}
            aria-valuemin={0}
            aria-valuemax={100}
            style={fillStyle}
            data-testid={testId ? `${testId}-bar` : "storage-gauge-bar"}
          />
        </div>
      )}
    </div>
  );
}
