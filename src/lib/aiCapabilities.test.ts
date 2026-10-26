import { describe, it, expect, vi } from "vitest";
import { AI_CAPABILITIES, AI_POLICY_LEVELS, isTierAllowed, type AiCapabilityTier } from "./aiCapabilities";
import { BUILTIN_DEFS } from "../stores/aiPrompts";
import { useSettingsStore } from "../stores/settings";
import ko from "../i18n/ko/aiCapabilities.json";
import en from "../i18n/en/aiCapabilities.json";
import fr from "../i18n/fr/aiCapabilities.json";

vi.mock("../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

/**
 * 드리프트 방지 테스트 (docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W2).
 *
 * (d) 가 이 웨이브의 핵심 산출물이다 — BUILTIN_DEFS 에 새 액션이 추가됐는데 이 카탈로그가 모르면
 * 즉시 빨갛게 되고, 실패 메시지에 어느 id 가 빠졌는지 그대로 찍힌다.
 */

const LOCALE_DICTS: Record<string, Record<string, string>> = { ko, en, fr };

function resolveDotted(key: string, dict: Record<string, string>): string | undefined {
  // aiCapabilities 네임스페이스 파일은 평면 구조(namespace.flatKey)이므로 첫 dot 뒤 나머지를
  // 그대로 한 키로 본다 — src/i18n/t.ts 의 실제 조회 규칙과 같다(파일명=네임스페이스).
  const dot = key.indexOf(".");
  if (dot === -1) return undefined;
  const ns = key.slice(0, dot);
  const flatKey = key.slice(dot + 1);
  if (ns !== "aiCapabilities") return undefined;
  return dict[flatKey];
}

describe("aiCapabilities — 카탈로그 드리프트 방지", () => {
  it("(a) 모든 nameKey/readsKey/detailKey 가 ko/en/fr 3로케일에 존재한다", () => {
    const missing: string[] = [];
    for (const cap of AI_CAPABILITIES) {
      for (const key of [cap.nameKey, cap.readsKey, cap.detailKey]) {
        for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
          const value = resolveDotted(key, dict);
          if (typeof value !== "string" || value.length === 0) {
            missing.push(`${cap.id}: "${key}" missing in ${locale}/aiCapabilities.json`);
          }
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("(b) control.kind===\"setting\" 의 키가 전부 settings.ts 의 실제 설정 상태 필드에 있다", () => {
    // SimplePrefKey 는 타입이라 런타임에 직접 반영할 수 없다 — 대신 store 의 실제 초기 상태
    // 필드 이름(=camelCase pref 이름과 1:1)을 대조한다. settings.ts::PREFS 에 없는 이름을 쓰면
    // 이 필드 자체가 존재하지 않으므로 여기서 잡힌다.
    const stateKeys = new Set(Object.keys(useSettingsStore.getState()));
    const badKeys: string[] = [];
    for (const cap of AI_CAPABILITIES) {
      if (cap.control.kind !== "setting") continue;
      if (!stateKeys.has(cap.control.key)) {
        badKeys.push(`${cap.id}: setting key "${cap.control.key}" not found on SettingsState`);
      }
    }
    expect(badKeys, badKeys.join("\n")).toEqual([]);
  });

  it("(c) control.kind===\"preset\" 의 presetId 가 전부 aiPresets.ts BUILTIN_DEFS 에 있다", () => {
    const builtinIds = new Set(BUILTIN_DEFS.map((d) => d.id));
    const badIds: string[] = [];
    for (const cap of AI_CAPABILITIES) {
      if (cap.control.kind !== "preset") continue;
      if (!builtinIds.has(cap.control.presetId)) {
        badIds.push(`${cap.id}: presetId "${cap.control.presetId}" not found in BUILTIN_DEFS`);
      }
    }
    expect(badIds, badIds.join("\n")).toEqual([]);
  });

  it("(d) 역방향 — BUILTIN_DEFS 의 모든 항목이 카탈로그에 preset 컨트롤로 등장한다", () => {
    const catalogPresetIds = new Set(
      AI_CAPABILITIES.filter((c) => c.control.kind === "preset").map((c) =>
        c.control.kind === "preset" ? c.control.presetId : "",
      ),
    );
    const missing = BUILTIN_DEFS.map((d) => d.id).filter((id) => !catalogPresetIds.has(id));
    expect(
      missing,
      missing.length
        ? `BUILTIN_DEFS id(s) missing from aiCapabilities.ts catalog: ${missing.join(", ")}`
        : undefined,
    ).toEqual([]);
  });

  it("카탈로그 항목 id 는 서로 겹치지 않는다", () => {
    const ids = AI_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 2026-08-30 코디네이터 리뷰: external:true 를 24항목 전부에 붙인 최초 버전이 반려됐다 — 모든
  // 행에 뜨는 배지는 정보가 아니라 벽지다. external 은 이제 "사용자가 쓴 콘텐츠(본문·챗·붙여넣은
  // 문서)가 나가는가"를 뜻하므로 항목마다 갈려야 정상이다(agent_folder/agent_workspace 는 제목·
  // 태그만 보내는 스캔이라 false). 이 값이 전부 true 이거나 전부 false 로 되돌아가면 판정 로직이
  // 다시 무너진 것이므로 여기서 잡는다.
  it("external 값이 항목마다 갈린다 — 전부 true/전부 false 로의 회귀를 잡는다", () => {
    const externalValues = AI_CAPABILITIES.map((c) => c.external);
    expect(externalValues.some((v) => v === true)).toBe(true);
    expect(externalValues.some((v) => v === false)).toBe(true);
  });

  // W10(오너 요구 2026-08-30): "시트, 에디터, 폴더 … AI가 건드는 유형" 태그 축. tier(어떻게
  // 돕는가)와 직교하는 target(무엇을 건드리는가) — AiCapability.target 은 TS 상 필수 필드라 컴파일
  // 시점에도 빠짐을 막지만, 런타임에서도 값이 실제 유니온 안에 있는지·문구가 3로케일에 있는지·
  // 죽은 태그가 없는지까지 잡는다.
  const KNOWN_TARGETS = [
    "editor",
    "note",
    "folder",
    "notebook",
    "sheet",
    "diagram",
    "chat",
    "link",
    "collect",
  ] as const;

  it("(e) 모든 항목이 target 을 갖고, 값이 AiCapabilityTarget 유니온 안에 있다", () => {
    const bad: string[] = [];
    for (const cap of AI_CAPABILITIES) {
      if (!cap.target || !(KNOWN_TARGETS as readonly string[]).includes(cap.target)) {
        bad.push(`${cap.id}: target "${String(cap.target)}" is missing or not a known AiCapabilityTarget`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("(f) 쓰인 모든 target 의 aiCapabilities.target_<id> 키가 ko/en/fr 에 존재한다", () => {
    const usedTargets = new Set(AI_CAPABILITIES.map((c) => c.target));
    const missing: string[] = [];
    for (const target of usedTargets) {
      const key = `aiCapabilities.target_${target}`;
      for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
        const value = resolveDotted(key, dict);
        if (typeof value !== "string" || value.length === 0) {
          missing.push(`target "${target}": "${key}" missing in ${locale}/aiCapabilities.json`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("(g) 역방향 — 정의된 9개 target 중 아무 항목도 쓰지 않는 값이 없다 (죽은 태그 금지)", () => {
    const usedTargets = new Set(AI_CAPABILITIES.map((c) => c.target));
    const unused = KNOWN_TARGETS.filter((target) => !usedTargets.has(target));
    expect(
      unused,
      unused.length ? `Defined AiCapabilityTarget value(s) used by no capability: ${unused.join(", ")}` : undefined,
    ).toEqual([]);
  });
});

/**
 * W11(§6-A, docs/PLAN-2026-08-30-ai-surface-and-clients.md): 전역 AI 정책 사다리. AI_POLICY_LEVELS
 * 가 랭크의 유일한 SSOT(오너 요구) — isTierAllowed 와 AiCapabilityCatalog 의 세그먼트 컨트롤이
 * 전부 이 한 배열만 읽는다.
 */
describe("aiCapabilities — 전역 AI 정책 사다리 (isTierAllowed)", () => {
  it("사다리 순서는 gather < refine < organize 이고 세 값을 정확히 담는다", () => {
    expect(AI_POLICY_LEVELS).toEqual(["gather", "refine", "organize"]);
  });

  it("정책 레벨은 자기 자신과 같은/더 낮은 tier 를 전부 허용한다", () => {
    // organize 정책 — 사다리 전부 허용(오너 확정 기본값과 같은 레벨).
    expect(isTierAllowed("gather", "organize")).toBe(true);
    expect(isTierAllowed("refine", "organize")).toBe(true);
    expect(isTierAllowed("organize", "organize")).toBe(true);
    // refine 정책 — gather/refine 만.
    expect(isTierAllowed("gather", "refine")).toBe(true);
    expect(isTierAllowed("refine", "refine")).toBe(true);
    expect(isTierAllowed("organize", "refine")).toBe(false);
    // gather 정책 — gather 뿐.
    expect(isTierAllowed("gather", "gather")).toBe(true);
    expect(isTierAllowed("refine", "gather")).toBe(false);
    expect(isTierAllowed("organize", "gather")).toBe(false);
  });

  it("gather tier 항목(수집)은 어느 정책에서도 막히지 않는다 — 항상 허용", () => {
    const levels: AiCapabilityTier[] = ["gather", "refine", "organize"];
    for (const level of levels) {
      expect(isTierAllowed("gather", level)).toBe(true);
    }
  });

  it("기본 정책(\"organize\")에서는 카탈로그의 모든 항목이 허용된다 — 회귀 없음", () => {
    const blocked = AI_CAPABILITIES.filter((c) => !isTierAllowed(c.tier, "organize"));
    expect(blocked.map((c) => c.id), "organize 는 사다리 최상단이라 아무 항목도 막지 않아야 한다").toEqual([]);
  });

  it("disabled_reason_policy 문구가 ko/en/fr 3로케일에 존재한다", () => {
    for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
      expect(typeof dict.disabled_reason_policy, `missing in ${locale}/aiCapabilities.json`).toBe("string");
      expect(dict.disabled_reason_policy.length, `empty in ${locale}/aiCapabilities.json`).toBeGreaterThan(0);
    }
  });
});
