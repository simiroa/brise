import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";

/**
 * 색인 표류 가드(PLAN-2026-10-24 W4) — 색인은 문자열로 키·페이지·앵커를 지목하므로 타입이 못 잡는다.
 * 키가 사라지거나, 앵커를 단 행이 지워지거나, 페이지 id 가 바뀌어도 게이트가 초록이면 검색 결과가
 * 조용히 죽는다(선택해도 안 움직이거나 raw 키가 화면에 뜬다).
 */

function loadLocale(locale: string): Set<string> {
  const dir = join("src", "i18n", locale);
  const keys = new Set<string>();
  const walk = (obj: unknown, prefix: string) => {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = `${prefix}.${k}`;
      if (v && typeof v === "object") walk(v, p);
      else keys.add(p);
    }
  };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    walk(JSON.parse(readFileSync(join(dir, f), "utf8")), f.replace(/\.json$/, ""));
  }
  return keys;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) && !e.startsWith("settingsSearchIndex")) out.push(p);
  }
  return out;
}

describe("settingsSearchIndex 표류 가드", () => {
  it("(a) labelKey·groupKey·keywordKeys 는 ko/en/fr 모두에 실재한다", () => {
    for (const locale of ["ko", "en", "fr"]) {
      const keys = loadLocale(locale);
      const missing: string[] = [];
      for (const e of SETTINGS_SEARCH_INDEX) {
        for (const k of [e.labelKey, e.groupKey, ...(e.keywordKeys ?? [])]) {
          if (k && !keys.has(k)) missing.push(`${locale}: ${k}`);
        }
      }
      expect(missing).toEqual([]);
    }
  });

  it("(b) page 는 SettingsPanel 의 페이지 id 이다", () => {
    const src = readFileSync(join("src", "components", "SettingsPanel.tsx"), "utf8");
    const ids = new Set([...src.matchAll(/id: "([a-z_]+)",\s*\n\s*scope:/g)].map((m) => m[1]));
    expect(ids.size).toBeGreaterThanOrEqual(17);
    const bad = SETTINGS_SEARCH_INDEX.filter((e) => !ids.has(e.page)).map((e) => e.page);
    expect(bad).toEqual([]);
    // 모든 페이지는 페이지 자체 항목을 하나씩 갖는다.
    const pageEntries = new Set(SETTINGS_SEARCH_INDEX.filter((e) => !e.anchor && !e.groupKey).map((e) => e.page));
    expect([...ids].filter((id) => !pageEntries.has(id))).toEqual([]);
  });

  it("(c) 모든 anchor 는 settings 소스에 단 앵커로 실재한다", () => {
    const text = sources(join("src", "components", "settings"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const missing = SETTINGS_SEARCH_INDEX.filter((e) => e.anchor).filter((e) => {
      const a = e.anchor as string;
      return !(
        text.includes(`anchor="${a}"`) ||
        text.includes(`anchorId("${a}")`) ||
        text.includes(`anchor: "${a}"`)
      );
    });
    expect(missing.map((e) => `${e.page}/${e.anchor}`)).toEqual([]);
  });

  it("(d) anchor 는 페이지 안에서 유일하다 (같은 DOM 에 같은 id 가 두 번 서지 않는다)", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const e of SETTINGS_SEARCH_INDEX) {
      if (!e.anchor) continue;
      const k = `${e.page}/${e.anchor}`;
      if (seen.has(k)) dup.push(k);
      seen.add(k);
    }
    expect(dup).toEqual([]);
  });

  it("(e) 같은 페이지 안에서 같은 라벨·앵커 쌍이 중복 등록되지 않는다", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const e of SETTINGS_SEARCH_INDEX) {
      const k = `${e.page}|${e.anchor ?? ""}|${e.labelKey}`;
      if (seen.has(k)) dup.push(k);
      seen.add(k);
    }
    expect(dup).toEqual([]);
  });
});
