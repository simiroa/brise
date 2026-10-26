import { describe, it, expect } from "vitest";
import {
  DIAGRAM_TILES,
  DIAGRAM_STARTER,
  DIAGRAM_PRESET_SEED,
  DIAGRAM_MINDMAP_SEED,
  DIAGRAM_SEQUENCE_SEED,
  diagramTemplateSource,
  DIAGRAM_TEMPLATE_IDS,
} from "./diagramStarter";
import { parseDiagramJson, validateDiagramModel } from "./diagramSchema";
import { DIAGRAM_TYPES, DIAGRAM_TYPE_GROUPS } from "./types/registry";

/**
 * 시드는 전부 JSON IR v1 이어야 한다 — 그게 이 파일의 유일한 주장이다.
 *
 * 이 검사가 없어서 어시스트의 "마인드맵"·"시퀀스" 프리셋이 **mermaid 텍스트**를 심는 채로
 * 오래 살아남았다(JSON IR 전환 때 두 상수만 PresetList 안에 인라인으로 남아 있었다). 적용하면
 * parseDiagramJson 이 못 읽어 structured:false 로 열렸고, 캔버스는 빈 화면이었다. 시드가 하나
 * 늘 때마다 여기 목록에 들어오면 같은 표류가 다시 조용히 지나가지 않는다.
 */
const SEEDS: [string, string][] = [
  ["DIAGRAM_STARTER", DIAGRAM_STARTER],
  ["DIAGRAM_PRESET_SEED", DIAGRAM_PRESET_SEED],
  ["DIAGRAM_MINDMAP_SEED", DIAGRAM_MINDMAP_SEED],
  ["DIAGRAM_SEQUENCE_SEED", DIAGRAM_SEQUENCE_SEED],
  ...DIAGRAM_TILES.map((t) => [`tile:${t.id}`, t.source] as [string, string]),
  ...DIAGRAM_TEMPLATE_IDS.map((id) => [`source:${id}`, diagramTemplateSource(id)] as [string, string]),
];

describe("diagramStarter seeds", () => {
  it.each(SEEDS)("%s 는 JSON IR v1 로 파싱되고 검증을 통과한다", (_name, source) => {
    const model = parseDiagramJson(source);
    expect(model.structured).toBe(true);
    expect(model.v).toBe(1);
    expect(model.nodes.length).toBeGreaterThan(0);
    expect(validateDiagramModel(model)).toEqual({ valid: true, errors: [] });
  });

  it("마인드맵 가지에는 화살촉이 없다 — 포함 관계지 흐름이 아니다", () => {
    const model = parseDiagramJson(DIAGRAM_MINDMAP_SEED);
    expect(model.nodes.map((n) => n.label)).toEqual([
      "중심 주제",
      "주요 아이디어 A",
      "세부 항목 1",
      "세부 항목 2",
      "주요 아이디어 B",
      "세부 항목 3",
    ]);
    expect(model.edges.every((e) => e.arrow === "none")).toBe(true);
  });

  it("시퀀스의 돌아오는 메시지는 dashed 다 — 옛 mermaid '-->>' 가 뜻하던 것", () => {
    const model = parseDiagramJson(DIAGRAM_SEQUENCE_SEED);
    expect(model.edges.map((e) => [e.from, e.to, e.label, e.line])).toEqual([
      ["n1", "n2", "요청 전송", "solid"],
      ["n2", "n3", "데이터 조회", "solid"],
      ["n3", "n2", "결과 반환", "dashed"],
      ["n2", "n1", "응답 완료", "dashed"],
    ]);
  });
});

/**
 * PLAN-2026-09-20 W1 — 타입 레지스트리가 시드의 유일한 출처다. diagramStarter 의 상수는 전부 파생이라
 * 여기서 "파생이 레지스트리와 같은가" 와 "레지스트리 자체가 규약을 지키는가" 만 본다.
 */
describe("types/registry — 타입 = 파일 1개 + 레지스트리 1줄", () => {
  it("id 는 유일하고 group 은 4개 중 하나, i18n 키는 editor.diagram_tpl_<id>* 규약(모바일 시트가 id 로 조립)", () => {
    const ids = DIAGRAM_TYPES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of DIAGRAM_TYPES) {
      expect(DIAGRAM_TYPE_GROUPS).toContain(def.group);
      expect(def.nameKey).toBe(`editor.diagram_tpl_${def.id}`);
      expect(def.hintKey).toBe(`editor.diagram_tpl_${def.id}_hint`);
      expect(def.aiHintKey).toBe(`editor.diagram_tpl_${def.id}_ai_hint`);
    }
  });

  it("시드는 노드 ≤9·엣지 ≤12(diagram-design 예산)이고 pos 를 쓰지 않는다", () => {
    for (const def of DIAGRAM_TYPES) {
      expect(def.seed.nodes.length).toBeLessThanOrEqual(9);
      expect(def.seed.edges.length).toBeLessThanOrEqual(12);
      expect(def.seed.nodes.every((n) => n.pos === undefined)).toBe(true);
    }
  });

  it("DIAGRAM_TILES / DIAGRAM_TEMPLATE_IDS 는 레지스트리와 같은 순서·같은 개수, 시드 상수 셋은 basic/mindmap/sequence 의 source", () => {
    expect(DIAGRAM_TEMPLATE_IDS).toEqual(DIAGRAM_TYPES.map((d) => d.id));
    expect(DIAGRAM_TILES.map((t) => t.id)).toEqual(DIAGRAM_TEMPLATE_IDS);
    expect(DIAGRAM_TILES.length).toBe(27); // W1 9장 + W2 18장
    expect(DIAGRAM_PRESET_SEED).toBe(diagramTemplateSource("basic"));
    expect(DIAGRAM_MINDMAP_SEED).toBe(diagramTemplateSource("mindmap"));
    expect(DIAGRAM_SEQUENCE_SEED).toBe(diagramTemplateSource("sequence"));
    // 모르는 id 는 no-picker 기본값으로 — 타입 파일을 지워도 호출자가 죽지 않는다.
    expect(diagramTemplateSource("nope")).toBe(DIAGRAM_STARTER);
  });
});
