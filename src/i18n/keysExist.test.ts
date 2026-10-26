import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `npm run check:i18n` 은 **언어 간 키 대칭**만 검사한다 — ko/en/fr 이 같은 키 집합을 갖는지.
 * 코드가 부르는 키가 실제로 존재하는지는 아무도 보지 않았고, t() 는 없는 키를 만나면 점 표기
 * 경로를 그대로 반환한다. 그래서 화면에 "filter.show_all" 같은 날 문자열이 뜬 채로 게이트가
 * 전부 초록이었다(2026-07-31 발견: editor.color / editor.table / editor.heading_step /
 * ctx.folder_empty / filter.show_all / note.cancel_button / note.status_options /
 * presets.ai_prompt_desc / presets.ai_prompt_placeholder).
 *
 * src/lib/commandNames.test.ts 와 같은 계열의 가드다: 문자열로 지목하는 대상이 실재하는지를
 * 타입이 아니라 테스트가 본다.
 *
 * 한계: 리터럴만 잡는다. t(variable) 이나 템플릿으로 조립한 키는 검사할 수 없다.
 */

// 로케일 디렉터리(src/i18n/<locale>/<namespace>.json)를 읽어 단일 dict 로 합친다 —
// 파일명이 곧 최상위 네임스페이스(t.ts 로더와 같은 규칙).
function loadLocaleDict(locale: string): Record<string, unknown> {
  const dir = join("src", "i18n", locale);
  const dict: Record<string, unknown> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    dict[entry.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, entry), "utf8"));
  }
  return dict;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function flatten(obj: unknown, prefix = "", out: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
      else out.add(path);
    }
  }
  return out;
}

describe("t() 가 부르는 키는 전부 실재해야 한다", () => {
  it("소스의 모든 리터럴 t(\"…\") 키가 ko 로케일에 있다", () => {
    // ko 를 기준으로 본다 — check:i18n 이 세 로케일의 키 집합이 같음을 이미 보장하므로,
    // 하나에 있으면 셋 다 있다.
    const keys = flatten(loadLocaleDict("ko"));
    expect(keys.size).toBeGreaterThan(100); // 파싱이 통째로 실패하면 이 테스트가 무의미해진다

    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.endsWith("keysExist.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        const key = m[1];
        // 점이 없는 값은 키가 아니라 t 라는 이름의 다른 함수일 가능성이 높다(테스트 헬퍼 등).
        if (!key.includes(".")) continue;
        if (keys.has(key)) continue;
        offenders.push(`${file}: t("${key}")`);
      }
    }

    expect(offenders, `존재하지 않는 i18n 키(화면에 키 경로가 그대로 노출된다):\n${offenders.join("\n")}`).toEqual([]);
  });
});

// t() 는 `{{key}}` 만 치환한다(t.ts). `{key}` 로 쓴 문구는 화면에 "{min}" 이 그대로 뜬다 —
// 2026-10-07 S22 실기 QA 에서 녹음기 "남은 시간 약 {min}분" 으로 발견, 같은 실수가 5개 키에 더 있었다.
describe("i18n placeholders use the {{key}} syntax t() understands", () => {
  it("no single-brace {key} placeholders in any locale", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string, file: string) => {
      if (typeof node === "string") {
        if (/(^|[^{])\{[a-zA-Z_]+\}([^}]|$)/.test(node)) offenders.push(`${file}: ${path} = ${node}`);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, file);
      }
    };
    for (const locale of ["ko", "en", "fr"]) {
      const dir = join("src", "i18n", locale);
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".json")) continue;
        walk(JSON.parse(readFileSync(join(dir, entry), "utf8")), "", `${locale}/${entry}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
