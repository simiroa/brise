import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

  it("(c2) anchor 는 그 page 가 실제로 그리는 컴포넌트 안에 있다 — 다른 페이지로 옮겨 간 항목이 남지 않는다", () => {
    // (c) 는 anchor 문자열이 settings/ 어딘가에만 있으면 통과한다 — 브리핑의 `routines` 가 4d7e87e5 로 달력 및 일정
    // 페이지로 옮겨 간 뒤에도 색인에 남아 있던 이유다. 페이지 id → 그 페이지가 렌더하는 컴포넌트(SettingsPanel 의
    // allPages 의 render 에 나온 태그)에서 상대 import 를 따라 닿는 settings/ 파일들의 집합을 만들어 그 안에서 찾는다.
    const panelSrc = readFileSync(join("src", "components", "SettingsPanel.tsx"), "utf8");
    const settingsDir = resolve("src", "components", "settings");

    // 컴포넌트 이름 → 파일: SettingsPanel 의 정적 import 와 lazySurfaces.ts 의 lazyPreload(import(...)).
    const fileOf = new Map<string, string>();
    for (const m of panelSrc.matchAll(/import \{ (\w+) \} from "(\.\/settings\/[^"]+)"/g)) {
      fileOf.set(m[1], resolve("src", "components", m[2]));
    }
    const lazySrc = readFileSync(join("src", "lazySurfaces.ts"), "utf8");
    for (const m of lazySrc.matchAll(/export const (\w+) = lazyPreload\(\(\) => import\("(\.\/[^"]+)"\)/g)) {
      fileOf.set(m[1], resolve("src", m[2]));
    }
    const resolveFile = (base: string): string | null => {
      for (const c of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) if (existsSync(c)) return c;
      return null;
    };

    // 페이지 id → render 에 나온 컴포넌트 태그들(allPages 배열 구간만, 항목은 `id: "…", scope:` 로 갈린다).
    const arr = panelSrc.slice(panelSrc.indexOf("const allPages"));
    const heads = [...arr.matchAll(/id: "([a-z_]+)",\s*\n\s*scope:/g)];
    const rootsOf = new Map<string, string[]>();
    heads.forEach((h, i) => {
      const seg = arr.slice(h.index!, heads[i + 1]?.index ?? arr.length);
      const render = seg.slice(seg.indexOf("render:"));
      rootsOf.set(h[1], [...new Set([...render.matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]))]);
    });
    expect(rootsOf.size).toBeGreaterThanOrEqual(17);

    const textOfPage = (page: string): string => {
      const seen = new Set<string>();
      const queue: string[] = [];
      for (const name of rootsOf.get(page) ?? []) {
        const f = fileOf.get(name);
        if (f) queue.push(f);
      }
      let text = "";
      while (queue.length) {
        const f = queue.pop()!;
        const file = existsSync(f) ? f : resolveFile(f.replace(/\.tsx?$/, ""));
        // 색인 자신(과 그걸 읽는 검색)은 모든 anchor 를 문자열로 품고 있다 — 거기에 닿으면 가드가 아무것도 못 잡는다.
        if (!file || seen.has(file) || !file.startsWith(settingsDir) || /[\\/](settingsSearchIndex|searchSettings)\./.test(file)) continue;
        seen.add(file);
        const src = readFileSync(file, "utf8");
        text += `\n${src}`;
        for (const m of src.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
          const next = resolveFile(resolve(dirname(file), m[1]));
          if (next) queue.push(next);
        }
      }
      return text;
    };

    // 매핑이 비면(SettingsPanel 이 바뀌어 정규식이 못 읽으면) 모든 anchor 가 "없다"로 실패하므로 조용히 통과하지 않는다.
    for (const page of rootsOf.keys()) expect(textOfPage(page).length, `page ${page} 의 컴포넌트를 못 찾았다`).toBeGreaterThan(0);

    const pageText = new Map<string, string>();
    const missing = SETTINGS_SEARCH_INDEX.filter((e) => e.anchor).filter((e) => {
      const a = e.anchor as string;
      if (!pageText.has(e.page)) pageText.set(e.page, textOfPage(e.page));
      const text = pageText.get(e.page)!;
      return !(text.includes(`anchor="${a}"`) || text.includes(`anchorId("${a}")`) || text.includes(`anchor: "${a}"`));
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
