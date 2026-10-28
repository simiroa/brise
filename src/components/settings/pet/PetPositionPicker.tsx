import { useCallback, useEffect, useState } from "react";
import { call } from "../../../lib/invoke";
import { reportFallback } from "../../../lib/diag";
import { t } from "../../../i18n/t";
import { IconMapPin } from "../../icons";
import type { PetPositionResetOutput } from "../../../lib/commands.gen";
import { SettingsCard } from "../SettingsCard";

/**
 * 설정 > 펫 — 화면 위치 선택기 (PLAN-2026-09-15 P7).
 *
 * 붙어 있는 모니터들을 실제 배치대로 축소한 미니맵 + 모니터마다 3×3 앵커 점. 점을 누르면 그
 * 자리로 펫이 간다(기존 `pet_set_position` — 저장과 이동이 한 커맨드다). "기본 위치로"는 새
 * 커맨드 `pet_position_reset` 이며, 기본 위치 규칙은 Rust(pet_window::default_position) 한
 * 곳에만 있다.
 *
 * 2026-10-16(PET.md §0.6-3): 현재 위치는 앵커에 스냅됐을 때만이 아니라 **드래그로 둔 자유 위치도**
 * 펫 창 크기의 사각형으로 그린다. 값(`current`)은 PetSection 이 settings_get_all 한 번으로 읽어
 * 내려주고, 창 포커스가 돌아올 때 다시 읽는다(펫 이동 이벤트가 따로 없다).
 *
 * **좌표계가 둘이다.** 저장·이동 좌표(`pet_set_position`)는 Rust 규약 그대로 "모니터마다 자기 배율로
 * 나눈 논리 px"(pet_window::default_position·is_on_screen 과 같다) — 배율이 다른 모니터를 섞으면 이
 * 공간에서는 모니터끼리 겹치거나 틈이 생긴다. 그래서 **미니맵 그림만** 모든 모니터를 한 물리 px 공간에
 * 놓고(`toMapMonitor`) 펫 좌표를 그 모니터의 배율로 옮겨 그린다(`toMapPoint`). 크기는 퍼센트 +
 * aspect-ratio 라 좁은 창에서도 안쪽이 넘치지 않는다.
 */

/** src-tauri/src/pet_window.rs 의 창 크기·여백. ponytail: 값이 바뀔 일이 없는 고정 창이라
 *  복제해 둔다 — 두 번째 소비처가 생기면 pet_theme 류 좁은 읽기로 내려받는 쪽이 맞다. */
const PET_W = 160;
const PET_H = 180;
const EDGE_MARGIN = 16;
/** 앵커 적중 판정 — 저장된 좌표가 정확히 앵커일 필요는 없다(드래그 직후에도 가까우면 채운다). */
const ANCHOR_SNAP = 24;
const MAP_HEIGHT = 132;

function anchorAria(col: number, row: number): string {
  if (row === 0 && col === 0) return t("settings.pet_position_nw");
  if (row === 0 && col === 1) return t("settings.pet_position_n");
  if (row === 0 && col === 2) return t("settings.pet_position_ne");
  if (row === 1 && col === 0) return t("settings.pet_position_w");
  if (row === 1 && col === 1) return t("settings.pet_position_c");
  if (row === 1 && col === 2) return t("settings.pet_position_e");
  if (row === 2 && col === 0) return t("settings.pet_position_sw");
  if (row === 2 && col === 1) return t("settings.pet_position_s");
  return t("settings.pet_position_se");
}

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 논리 px 사각형으로 정규화(모니터 API 는 물리 px + scaleFactor 를 준다). 작업영역(workArea)이
 *  있으면 그쪽을 쓴다 — Rust 의 default_position 도 work_area 기준이라, 그래야 "기본 위치로"가
 *  우하단 앵커와 같은 좌표가 되고 앵커 클릭이 펫을 작업표시줄 밑으로 밀어 넣지 않는다. */
export function toLogicalRect(m: {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
  scaleFactor?: number;
}): MonitorRect {
  const s = m.scaleFactor || 1;
  const position = m.workArea?.position ?? m.position;
  const size = m.workArea?.size ?? m.size;
  return {
    x: position.x / s,
    y: position.y / s,
    width: size.width / s,
    height: size.height / s,
  };
}

/** 미니맵용 모니터 — 저장 규약의 논리 사각형과 그림용 물리 사각형을 함께 든다. */
export interface MapMonitor {
  logical: MonitorRect;
  physical: MonitorRect;
  scale: number;
}

type MonitorInfo = Parameters<typeof toLogicalRect>[0];

export function toMapMonitor(m: MonitorInfo): MapMonitor {
  const position = m.workArea?.position ?? m.position;
  const size = m.workArea?.size ?? m.size;
  return {
    logical: toLogicalRect(m),
    physical: { x: position.x, y: position.y, width: size.width, height: size.height },
    scale: m.scaleFactor || 1,
  };
}

/** 저장 규약의 펫 좌표 → 미니맵의 물리 좌표. 그 점을 품은 모니터의 배율로 옮긴다(없으면 첫 모니터). */
export function toMapPoint(pos: PetPos, monitors: MapMonitor[]): { x: number; y: number; scale: number } | null {
  const m =
    monitors.find(
      (mm) =>
        pos.x >= mm.logical.x &&
        pos.x < mm.logical.x + mm.logical.width &&
        pos.y >= mm.logical.y &&
        pos.y < mm.logical.y + mm.logical.height,
    ) ?? monitors[0];
  if (!m) return null;
  return {
    x: m.physical.x + (pos.x - m.logical.x) * m.scale,
    y: m.physical.y + (pos.y - m.logical.y) * m.scale,
    scale: m.scale,
  };
}

/** 한 모니터의 3×3 앵커 = 펫 창 좌상단 좌표 9개(논리 px). rect 는 작업영역이라 우하단 앵커가
 *  Rust 의 default_position 과 같은 좌표가 된다(같은 여백 16). */
export function anchorPositions(rect: MonitorRect): { col: number; row: number; x: number; y: number }[] {
  const xs = [
    rect.x + EDGE_MARGIN,
    rect.x + rect.width / 2 - PET_W / 2,
    rect.x + rect.width - PET_W - EDGE_MARGIN,
  ];
  const ys = [
    rect.y + EDGE_MARGIN,
    rect.y + rect.height / 2 - PET_H / 2,
    rect.y + rect.height - PET_H - EDGE_MARGIN,
  ];
  const out: { col: number; row: number; x: number; y: number }[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out.push({ col, row, x: Math.round(xs[col]), y: Math.round(ys[row]) });
    }
  }
  return out;
}

/** 모니터 전체를 감싸는 사각형 — 미니맵 축척의 기준. */
export function boundsOf(rects: MonitorRect[]): MonitorRect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function isCurrentAnchor(
  anchor: { x: number; y: number },
  current: { x: number; y: number } | null,
): boolean {
  if (!current) return false;
  return Math.abs(anchor.x - current.x) <= ANCHOR_SNAP && Math.abs(anchor.y - current.y) <= ANCHOR_SNAP;
}

export type PetPos = { x: number; y: number };

export function PetPositionPicker({
  current,
  onCurrentChange,
}: {
  current: PetPos | null;
  onCurrentChange: (pos: PetPos | null) => void;
}) {
  const [monitors, setMonitors] = useState<MapMonitor[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { availableMonitors } = await import("@tauri-apps/api/window");
        const monitors = await availableMonitors();
        if (!cancelled) setMonitors(monitors.map(toMapMonitor));
      } catch (e) {
        reportFallback("pet", "monitors_unavailable", e instanceof Error ? e.message : String(e));
        if (!cancelled) setMonitors([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 사용자가 누른 이동이 실패하면 토스트가 필요하다 — call() + 롤백(CLAUDE.md 함정 8·9).
  const moveTo = useCallback(
    async (x: number, y: number) => {
      const previous = current;
      onCurrentChange({ x, y });
      try {
        await call("pet_set_position", { x, y });
      } catch {
        onCurrentChange(previous);
      }
    },
    [current, onCurrentChange],
  );

  const reset = useCallback(async () => {
    try {
      const r = await call<PetPositionResetOutput>("pet_position_reset", {});
      onCurrentChange({ x: r.x, y: r.y });
    } catch {
      /* call() 이 토스트 — 저장된 값이 바뀌지 않았으니 표시도 그대로 둔다 */
    }
  }, [onCurrentChange]);

  // 미니맵 축척의 기준은 물리 px 로 감싼 사각형 — 배율이 다른 모니터도 실제 배치대로 붙어 보인다.
  const bounds = monitors && monitors.length > 0 ? boundsOf(monitors.map((m) => m.physical)) : null;
  // 저장값이 없으면(한 번도 옮긴 적 없음) 펫은 기본 위치 = 주 모니터 작업영역 우하단(Rust
  // default_position)에 떠 있다 — 미니맵이 비어 보이지 않게 그 자리를 그린다(표시 전용, 저장 안 함).
  // ponytail: 주 모니터 = 원점을 품은 모니터(Windows 규칙). 다른 OS 를 붙이면 primaryMonitor() 로.
  const primary =
    monitors?.find((m) => {
      const r = m.logical;
      return r.x <= 0 && r.y <= 0 && r.x + r.width > 0 && r.y + r.height > 0;
    }) ?? monitors?.[0];
  const shown: PetPos | null = current ?? (primary ? anchorPositions(primary.logical)[8] : null);
  const shownOnMap = shown && monitors ? toMapPoint(shown, monitors) : null;
  // 물리 좌표 → 미니맵 안의 퍼센트.
  const pctX = (v: number) => (bounds ? `${(v / bounds.width) * 100}%` : "0");
  const pctY = (v: number) => (bounds ? `${(v / bounds.height) * 100}%` : "0");

  return (
    <SettingsCard
      title={t("settings.pet_position_section")}
      icon={<IconMapPin size={14} strokeWidth={2} />}
      actions={
        <button
          type="button"
          className="btn btn--sm"
          data-testid="settings-pet-position-reset"
          onClick={() => void reset()}
        >
            {t("settings.pet_position_reset")}
          </button>
        }
        testId="settings-pet-position"
      >
      {!bounds ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
          {t("settings.pet_position_unavailable")}
        </div>
      ) : (
        <div
          data-testid="settings-pet-minimap"
          style={{
            position: "relative",
            // 높이 MAP_HEIGHT 를 넘지 않는 선에서 카드 폭에 맞춘다 — 안쪽은 전부 퍼센트라 함께 줄어든다.
            width: `min(100%, ${(MAP_HEIGHT * bounds.width) / bounds.height}px)`,
            aspectRatio: `${bounds.width} / ${bounds.height}`,
          }}
        >
          {monitors!.map((mon, i) => (
            <div
              key={`${mon.physical.x},${mon.physical.y},${i}`}
              data-testid={`settings-pet-monitor-${i}`}
              role="group"
              aria-label={t("settings.pet_position_anchor")}
              style={{
                position: "absolute",
                left: pctX(mon.physical.x - bounds.x),
                top: pctY(mon.physical.y - bounds.y),
                width: pctX(mon.physical.width),
                height: pctY(mon.physical.height),
                border: "1px solid var(--divider)",
                borderRadius: "var(--radius-sm)",
                boxSizing: "border-box",
                background: "color-mix(in srgb, var(--theme) 12%, transparent)",
              }}
            >
              {anchorPositions(mon.logical).map((a) => {
                const isCurrent = isCurrentAnchor(a, shown);
                return (
                  <button
                    key={`${a.col}-${a.row}`}
                    type="button"
                    data-testid={`settings-pet-anchor-${i}-${a.col}-${a.row}`}
                    aria-label={anchorAria(a.col, a.row)}
                    aria-pressed={isCurrent}
                    onClick={() => void moveTo(a.x, a.y)}
                    style={{
                      position: "absolute",
                      // 점은 그 앵커에 놓인 펫 창의 실제 중심 — 모니터 안의 퍼센트(배율로 물리 px 로 옮긴 값).
                      left: `${(((a.x + PET_W / 2 - mon.logical.x) * mon.scale) / mon.physical.width) * 100}%`,
                      top: `${(((a.y + PET_H / 2 - mon.logical.y) * mon.scale) / mon.physical.height) * 100}%`,
                      transform: "translate(-50%, -50%)",
                      width: 10,
                      height: 10,
                      padding: 0,
                      borderRadius: "50%",
                      border: `1px solid ${isCurrent ? "var(--accent)" : "var(--muted)"}`,
                      background: isCurrent ? "var(--accent)" : "transparent",
                      cursor: "pointer",
                      zIndex: 1,
                    }}
                  />
                );
              })}
            </div>
          ))}
          {shownOnMap && (
            <div
              aria-hidden
              data-testid="settings-pet-position-current"
              style={{
                position: "absolute",
                left: pctX(shownOnMap.x - bounds.x),
                top: pctY(shownOnMap.y - bounds.y),
                width: pctX(PET_W * shownOnMap.scale),
                height: pctY(PET_H * shownOnMap.scale),
                border: "1px solid var(--accent)",
                borderRadius: "var(--radius-sm)",
                background: "color-mix(in srgb, var(--accent) 25%, transparent)",
                boxSizing: "border-box",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      )}
    </SettingsCard>
  );
}
