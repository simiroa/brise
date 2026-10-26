import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * call()/callSilent() 은 커맨드 이름을 **문자열**로 받는다(invoke.ts). 즉 오타나 지어낸 이름은
 * tsc 를 그대로 통과하고, 런타임에서야 실패한다 — 그리고 호출부가 try/catch 로 감싸고 있으면
 * 아무 일도 일어나지 않은 채 성공처럼 보인다. 실제로 AI 에이전트 실행 경로가 존재하지 않는
 * `note_set_title` / `section_update_body` 를 부르면서 전 항목 성공을 보고하고 있었다.
 *
 * 이 테스트는 소스 전체에서 리터럴로 쓰인 커맨드 이름을 긁어, 생성된 CommandName 유니온
 * (specs/commands/*.yaml → commands.gen.ts) 에 실재하는지 확인한다. 동적 이름(변수)은 잡을 수
 * 없지만, 이 저장소의 호출은 대부분 리터럴이라 이 한 겹으로 해당 사고 유형은 막힌다.
 *
 * 대안으로 call(cmd: CommandName) 으로 타입을 조이는 방법이 있으나, 아래 UNSPECCED 세 개처럼
 * Rust 에는 등록돼 있지만 스펙 파일이 아직 없는 커맨드가 있어 지금은 컴파일이 깨진다. 스펙이
 * 채워지면 그때 타입으로 승격하고 이 테스트는 지워도 된다.
 */

// Rust(lib.rs)에는 등록돼 있으나 specs/commands/ 에 대응 yaml 이 없는 커맨드들 — 실재하므로
// 통과시키되, 스펙 부재 자체가 별도 부채라는 사실을 여기 남긴다.
const UNSPECCED = new Set([
  "emoji_style_status",
  "emoji_download",
  "window_set_effect",
  "window_surface_support", // window_set_effect 의 짝(아크릴 지원 여부) — 같은 이유로 스펙 파일이 없다
  "window_close_confirmed",
  // 창 자체를 만드는 커맨드 — 동기화 서버(HTTP)로는 라우팅되지 않고 인자도 없다(AppHandle 뿐).
  "settings_window_open",
  "activity_window_open",
  "ai_history_window_open",
  "briefing_window_open",
]);

// 테스트가 스텁 invoke 에 넘기는 가짜 이름들(실 커맨드가 아니어도 되는 자리).
const TEST_FIXTURE_NAMES = new Set(["notes_tree", "cmd"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

function knownCommandNames(): Set<string> {
  const gen = readFileSync("src/lib/commands.gen.ts", "utf8");
  const union = gen.slice(gen.indexOf("export type CommandName ="));
  return new Set(Array.from(union.matchAll(/'([a-z0-9_]+)'/g), (m) => m[1]));
}

describe("call() 커맨드 이름은 전부 실재해야 한다", () => {
  it("소스의 모든 리터럴 커맨드 이름이 CommandName 에 있다", () => {
    const known = knownCommandNames();
    expect(known.size).toBeGreaterThan(50); // 파싱이 통째로 실패하면 이 테스트가 무의미해진다

    const offenders: string[] = [];
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bcall(?:Silent)?\s*(?:<[^>]*>)?\s*\(\s*"([a-z0-9_]+)"/g)) {
        const name = m[1];
        if (known.has(name) || UNSPECCED.has(name) || TEST_FIXTURE_NAMES.has(name)) continue;
        offenders.push(`${file}: "${name}"`);
      }
    }

    expect(offenders, `실재하지 않는 커맨드 이름:\n${offenders.join("\n")}`).toEqual([]);
  });
});
