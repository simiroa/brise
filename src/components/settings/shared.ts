import type { CSSProperties } from "react";

// Task 3 (regroup): every option used to be its own bordered `.menu-row` card, making the modal
// very tall. Now a whole group (Appearance / AI / Data) is a single `.card`.
// PLAN-2026-09-12 §2(D2): 행 사이 헤어라인도 사라졌다 — 설정 창 안에서 선은 **영역 경계**
// (카드↔카드, 하위 그룹↔하위 그룹)에만 긋고 그때 쓰는 선은 `--divider` 하나다. 행을 가르던
// 일은 여백이 대신하므로 세로 패딩이 --space-3 → --space-4 로 올라갔다(SettingsRow 와 같은 값).
export const groupCardStyle: CSSProperties = {
  // 제목이 박스 밖으로 나갔으므로(settingsLayout.css) 위쪽 패딩은 아래와 같은 한 단 줄인 값이다.
  padding: "var(--space-4) var(--space-6)",
  width: "100%",
  boxSizing: "border-box",
};
export const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-5)",
  minHeight: "calc(var(--ctrl-h-lg) + var(--space-2) * 2)",
  boxSizing: "border-box",
  // 항목 간 위아래 간격 — 2026-10-27 개편: --space-4 → --space-2. 제목이 박스 밖으로 나가 그룹이 박스로 구분되므로
  // 행 사이를 더 벌릴 이유가 없다. SettingsRow · SwitchGrid 가 이 값을 같이 쓴다.
  padding: "var(--space-2) 0",
};
// W1 이 호환용으로 남겼던 `rowNoBorder` 별칭은 W3 에서 지웠다(호출부는 전부 `row` 로 옮겼다).
// 되살리지 마라: `export const rowNoBorder = row` 는 **같은 객체 참조**라 누가 한쪽을
// `Object.assign` 하는 순간 다른 쪽까지 오염된다. 선이 없는 것이 이제 `row` 의 기본값이므로
// "선 없는 행"이라는 별도 이름은 가리킬 대상이 없다.

/**
 * 열거형 설정의 UI 옵션 목록 — **값 목록은 stores/prefs.ts 의 `as const` 배열**이고(타입·Rust 검증과 같은 집합), 라벨은 호출부의
 * `Record<값, () => string>` 다. 라벨 맵이 모든 값을 덮어야 컴파일되므로 값이 늘면 옵션·라벨 누락이 빌드에서 잡힌다(i18n 키는 호출부에
 * 리터럴로 남아 check:i18n 이 그대로 본다).
 */
export function optionsOf<T extends string>(
  list: readonly T[],
  labels: Record<T, () => string>,
): Array<{ value: T; label: string }> {
  return list.map((value) => ({ value, label: labels[value]() }));
}

/** 설정 화면 우측 파라미터 컨트롤 표준 너비 */
export const SETTINGS_CTRL_WIDTH = "var(--settings-ctrl-w, 220px)";

export const linkBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  color: "var(--accent)",
  fontSize: "var(--text-sm)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  cursor: "pointer",
};
// selectStyle removed 2026-07-24: all native <select>s now share tokens.css's `.field-select`
// class (transparent + hairline + custom chevron) instead of a per-instance inline style object.

/** 설정 화면의 AI 프로바이더 목록 — **하나뿐인 거처**. AiProviderSection 이 칩을 그리고
 *  SettingsPanel 이 저장된 소문자 값을 이 목록으로 표시 이름에 되돌린다. 두 벌로 두면 새
 *  프로바이더를 추가할 때 한쪽만 고쳐져 "저장은 되는데 다시 열면 Ollama 로 보이는" 상태가 된다.
 *  AiProviderSection 은 lazy 청크라 목록이 거기 있으면 SettingsPanel 이 그 청크를 통째로
 *  끌어오게 된다 — 그래서 둘 다 eager 로 읽는 이 파일에 둔다. */
export const PROVIDERS = ["Ollama", "OpenAI", "Claude", "Gemini", "MiniMax", "OpenRouter"] as const;

export type ImportDialog = { kind: "mode"; path: string } | { kind: "replaceConfirm"; path: string };

/** True when `provider` sends note content off-device — i.e. anything but local Ollama. Shared by
 *  AiPermissionsSection (외부 전송 요약) and AiCapabilityCatalog (PLAN-2026-08-30 §3 W2 — per-row
 *  "외부 전송" badge auto-off when the provider is local). One judgment, not two. */
export function isExternalProvider(provider: string): boolean {
  return provider.trim().toLowerCase() !== "ollama";
}
