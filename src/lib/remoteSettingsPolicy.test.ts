import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isRemoteBlockedSettingKey,
  BROWSER_SETTINGS_PAGES,
  PHONE_SETTINGS_KEYS,
} from "./remoteSettingsPolicy";

/**
 * remoteSettingsPolicy.ts 는 Rust 서버의 거부 목록을 TS 로 미러한 것이다(그 파일 헤더 참고).
 * 서버 쪽이 바뀌었는데 미러가 안 따라가면 UI 가 "저장되는 척"하는 컨트롤을 다시 그린다 —
 * 정확히 2026-08/09 설정 개편에서 폰의 AI 토글이 죽어 있던 그 결함이다.
 * 그래서 index.html 을 읽어 대조하는 appearanceSeedDrift.test.ts 와 같은 방식으로,
 * remote_policy.rs 원문을 읽어 키 리터럴을 뽑아 비교한다.
 */
const RUST_POLICY = "src-tauri/src/sync_server/handlers/remote_policy.rs";
const rust = readFileSync(RUST_POLICY, "utf8");

/**
 * `fn is_remote_blocked_settings_key` 본문에서 `"..."` 리터럴을 전부 뽑는다.
 * 본문은 `k.starts_with("sync_") || matches!(k, "a" | "b" | ...)` 형태라, 리터럴 집합이 곧
 * 차단 목록이다(접두 "sync_" 포함).
 */
function rustBlockedLiterals(): string[] {
  const start = rust.indexOf("fn is_remote_blocked_settings_key");
  if (start === -1) {
    throw new Error(
      `${RUST_POLICY}: is_remote_blocked_settings_key 를 찾지 못했다 — 함수 이름이 바뀌었나? ` +
        "이 테스트가 대조 대상을 잃으면 미러가 조용히 낡는다.",
    );
  }
  // 함수 본문은 첫 `{` 부터 중괄호 균형이 0 이 되는 지점까지.
  const open = rust.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < rust.length; i++) {
    if (rust[i] === "{") depth++;
    else if (rust[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = rust.slice(open, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("remoteSettingsPolicy — Rust 차단 목록과의 드리프트 가드", () => {
  it("remote_policy.rs 가 막는 키를 TS 미러도 전부 막는다", () => {
    const literals = rustBlockedLiterals();
    expect(literals.length).toBeGreaterThan(0);
    for (const lit of literals) {
      // "sync_" 는 접두 리터럴이라 그 자체로는 완전한 키가 아니다 — 대표 키로 확인한다.
      const probe = lit === "sync_" ? "sync_enabled" : lit;
      expect(isRemoteBlockedSettingKey(probe), `${probe} 는 원격에서 막혀야 한다`).toBe(true);
    }
  });

  it("TS 미러가 막는 키는 remote_policy.rs 에도 근거가 있다 (과잉 차단 금지)", () => {
    const literals = new Set(rustBlockedLiterals());
    const mirrored = [
      "ai_provider",
      "ai_endpoint",
      "ai_api_key",
      "ai_provider_creds",
      "ai_enabled",
      "capture_clip_enabled",
      "capture_ingest_port",
      "capture_ingest_token",
    ];
    for (const key of mirrored) {
      expect(literals.has(key), `${key} 가 remote_policy.rs 에 없다 — 미러가 앞서 나갔다`).toBe(true);
    }
    expect(literals.has("sync_")).toBe(true);
  });

  it("서버 lifecycle 이 아닌 키는 원격에서 바꿀 수 있어야 한다", () => {
    // Rust 쪽 remote_blocked_settings_keys_cover_sync_prefix_and_ai_provider_keys(handlers.rs tests)가
    // 지키는 반대 방향 — 여기서도 한 번 더 못박는다.
    for (const key of ["ui_lang", "theme", "filter_roster", "capture_screenshot_enabled"]) {
      expect(isRemoteBlockedSettingKey(key), `${key} 는 원격에서 바꿀 수 있어야 한다`).toBe(false);
    }
  });
});

describe("remoteSettingsPolicy — 노출 목록 자기정합성", () => {
  it("폰이 노출하는 키는 하나도 원격 차단이 아니다", () => {
    for (const key of PHONE_SETTINGS_KEYS) {
      expect(isRemoteBlockedSettingKey(key), `${key} 는 폰에서 저장할 수 없다`).toBe(false);
    }
  });

  it("태블릿 페이지 허용 목록에 원격에서 성립하지 않는 페이지가 없다", () => {
    // 근거는 remoteSettingsPolicy.ts 의 BROWSER_SETTINGS_PAGES 주석. 목록이 늘어나면
    // 그 주석의 제외 사유부터 갱신하라는 신호로 이 단언을 남긴다.
    const forbidden = ["ai", "ai_features", "ai_chat", "connect", "collect", "data", "pet"];
    for (const page of forbidden) {
      expect(BROWSER_SETTINGS_PAGES).not.toContain(page);
    }
  });
});
