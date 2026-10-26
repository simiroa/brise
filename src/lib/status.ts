// Wave 15: 노트 진행 상태 — 내장 3종(작성중/내보냄/완료)은 코드 상수(삭제 불가).
// 커스텀 상태는 워크스페이스별 workspace_statuses 행(src/stores/taxonomy.ts)으로 존재한다.
// 색상: --danger-soft(작성중) / --info(내보냄) / --ok(완료) — 셋 다 라이트/다크 양쪽에서 이미
// ≥4.5:1 대비로 검증된 기존 토큰(tokens.css)을 재사용한다(실측: 다크 8.14/6.33/8.71,
// 라이트 6.03/6.48/5.71 — 2026-07-21 재검증, 전부 4.5:1 이상). 새 색상을 tokens.css에
// 추가하지 않는다.
import type { StatusEntry } from "./commands.gen";

export type BuiltInStatusKey = "in_progress" | "exported" | "done";

export interface BuiltInStatusDef {
  key: BuiltInStatusKey;
  labelKey: string; // i18n key — t(labelKey)
  colorVar: string; // CSS var() reference
}

export const BUILT_IN_STATUSES: BuiltInStatusDef[] = [
  { key: "in_progress", labelKey: "status.in_progress", colorVar: "var(--danger-soft)" },
  { key: "exported", labelKey: "status.exported", colorVar: "var(--info)" },
  { key: "done", labelKey: "status.done", colorVar: "var(--ok)" },
];

export function isBuiltInStatus(key: string): key is BuiltInStatusKey {
  return BUILT_IN_STATUSES.some((s) => s.key === key);
}

/** 상태 키(내장 또는 커스텀 id)의 표시색 — 커스텀 상태는 accent를 공유한다(개별 색상 선택 UI 없음). */
export function statusColorVar(key: string | null | undefined): string {
  const builtIn = BUILT_IN_STATUSES.find((s) => s.key === key);
  return builtIn ? builtIn.colorVar : "var(--accent)";
}

/** 상태 키를 사람이 읽는 이름으로 — 내장은 호출부가 t(def.labelKey)로, 커스텀은 이 함수로. */
export function customStatusName(key: string, custom: StatusEntry[]): string | undefined {
  return custom.find((c) => c.id === key)?.name;
}

/**
 * Ordered status picker rows shared by StatusControl (titlebar popover) and ContextMenu
 * (change-status PromptDialog). Includes the leading "no status" entry.
 *
 * - `key: null` = clear status. Call sites that need a string choice value (PromptDialog)
 *   encode that themselves (ContextMenu's NO_STATUS sentinel) — do not bake the encoding in.
 * - Built-ins expose `labelKey` for t(); customs expose `name` (already localized by the user).
 * - `colorVar` is null for "no status" (call sites render an empty ring, not a filled StatusDot).
 */
export type StatusOption =
  | { key: null; labelKey: string; colorVar: null }
  | { key: BuiltInStatusKey; labelKey: string; colorVar: string }
  | { key: string; name: string; colorVar: string };

export function statusOptions(customStatuses: StatusEntry[]): StatusOption[] {
  return [
    { key: null, labelKey: "note.no_status", colorVar: null },
    ...BUILT_IN_STATUSES.map((def) => ({
      key: def.key,
      labelKey: def.labelKey,
      colorVar: def.colorVar,
    })),
    ...customStatuses.map((s) => ({
      key: s.id,
      name: s.name,
      colorVar: "var(--accent)",
    })),
  ];
}

/** Display label for a StatusOption — built-in / none via i18n, custom via stored name. */
export function statusOptionLabel(opt: StatusOption, translate: (key: string) => string): string {
  return "name" in opt ? opt.name : translate(opt.labelKey);
}
