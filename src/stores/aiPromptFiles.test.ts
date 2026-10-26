/**
 * 프롬프트 SSOT 파일(`specs/ai/prompts/agent/`) ↔ TS 상수 바이트 동일성 (PLAN-2026-10-08 §7 W0).
 *
 * 두 겹으로 고정한다:
 *  1. TS 상수 == 디스크 파일(바이트 그대로) — `?raw` 가 무엇을 읽든 파일과 같아야 한다.
 *  2. 상수의 sha256 == W0 이전(d8b10e60) TS 리터럴의 sha256 — 파일로 옮기면서 모델에 가는 문장이
 *     한 바이트도 안 바뀌었다는 증거. 1 만으로는 순환이다(상수가 곧 파일이므로).
 *     이 값은 저장된 사용자 재정의와의 정확 일치 비교(aiInstructions / 치유)의 기준이기도 하다 —
 *     문구를 일부러 바꿀 때만 해시를 함께 갱신한다.
 *
 * CRLF·끝 개행 검사: core.autocrlf=true 인 체크아웃은 .gitattributes(`eol=lf`) 없이는 CRLF 로 풀리고,
 * 편집기는 끝 개행을 붙인다 — 둘 다 프롬프트를 조용히 바꾼다.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_INSTRUCTION_DEFS } from "./aiPrompts";
import {
  AGENT_PLAN_OUTPUT_CONTRACT,
  AGENT_PLAN_SCHEMA_SKELETON,
  UNTRUSTED_DATA_CONTRACT,
  buildAgentPlanPrompt,
} from "./aiAgentActions";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const file = (name: string) => readFileSync(`specs/ai/prompts/agent/${name}`, "utf8");
const engine = (id: string) => {
  const def = ENGINE_INSTRUCTION_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`missing engine instruction ${id}`);
  return def.prompt;
};

const CASES: { name: string; file: string; value: () => string; preW0Sha256: string }[] = [
  { name: "agent_split", file: "split.md", value: () => engine("agent_split"), preW0Sha256: "62dc005c5557aef3334cec18d0caf33eff4b37c42a9e09c61066e71b40d3b51a" },
  { name: "agent_folder", file: "folder.md", value: () => engine("agent_folder"), preW0Sha256: "9a092f0ad3b090a267d2b9cf047c52d7ef1b9a7c9da5942f31b7c47f520eb8e4" },
  { name: "agent_workspace", file: "workspace.md", value: () => engine("agent_workspace"), preW0Sha256: "32540ebe551818e1db8e61516243cecc50fa7606af13d815d7bd685839c919b7" },
  { name: "agent_merge", file: "merge.md", value: () => engine("agent_merge"), preW0Sha256: "b8de5af5d39fea8b4d5ac8d513f620dc0ca79b216dd9804c4159ccd1b52b92c6" },
  { name: "AGENT_PLAN_SCHEMA_SKELETON", file: "plan-schema.json", value: () => AGENT_PLAN_SCHEMA_SKELETON, preW0Sha256: "3901fbeec2184f051015a3bde11857d6496e9ece0a15e3b7da208a3afa2f577c" },
  { name: "UNTRUSTED_DATA_CONTRACT", file: "data-boundary.md", value: () => UNTRUSTED_DATA_CONTRACT, preW0Sha256: "07ccc41c86023063347d1424697f418e4d008ad2e0526862c40a5f56eebf594d" },
  { name: "AGENT_PLAN_OUTPUT_CONTRACT", file: "output-contract.md", value: () => AGENT_PLAN_OUTPUT_CONTRACT, preW0Sha256: "070be4a4044a2564b74daa0ae797d09743273f5aa884e9bf57d8385926d5c492" },
];

describe("prompt SSOT files (specs/ai/prompts/agent)", () => {
  it.each(CASES)("$name equals its shared file byte for byte", ({ file: name, value }) => {
    expect(value()).toBe(file(name));
  });

  it.each(CASES)("$name is unchanged from the pre-W0 TS literal", ({ value, preW0Sha256 }) => {
    expect(sha(value())).toBe(preW0Sha256);
  });

  it.each(CASES)("$name file is LF-only with no trailing newline", ({ file: name }) => {
    const text = file(name);
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(false);
  });

  it("the assembled plan prompt is unchanged from pre-W0", () => {
    const prompt = buildAgentPlanPrompt(engine("agent_folder"), "노트 id: n1\n제목: 가");
    expect(sha(prompt)).toBe("b27fc2fcaefe8bf31b3a3879074b5030305c03d5d42839ca0b78f4d5af8fa200");
  });

  it("the schema skeleton file is valid JSON", () => {
    expect(() => JSON.parse(file("plan-schema.json"))).not.toThrow();
  });
});
