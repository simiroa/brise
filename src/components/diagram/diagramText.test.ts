import { describe, it, expect } from "vitest";
import { parseDiagramText } from "./diagramText";
import { parseDiagramJson, validateDiagramModel } from "./diagramSchema";

// PLAN-2026-09-20 §2.2 예시 문법 그대로(설명용 인라인 "# ..." 주석은 파싱 대상이 아니므로 뺐다 —
// 그 코멘트는 사람에게 문법을 설명하려고 plan 문서에 붙은 것이지 DSL 자체가 아니다).
const EXAMPLE = ["A -> B: 라벨", "A -> C", "[1일차]", "  D", "  E", "회사", "  개발팀", "    백엔드"].join("\n");

describe("parseDiagramText — §2.2 문법 예시", () => {
  // 위임 지시서는 "노드 7 · 엣지 6"을 후보로 던지며 "정확히 세어 리터럴로"라고 요구했다. §2.2에
  // 적힌 대로(부모→자식은 "즉시 부모"만, 그룹 멤버는 서로 안 잇는다) 한 줄씩 손으로 추적하면
  // 노드 8(A,B,C,D,E,회사,개발팀,백엔드) · 엣지 4(A->B,A->C,회사->개발팀,개발팀->백엔드)가 나온다 —
  // 6을 만들려면 문서에 없는 규칙(전이적 조상 엣지, 형제 체이닝 등)을 지어내야 해서 넣지 않았다.
  it("노드 8·엣지 4·그룹 1(1일차, 멤버 D·E)을 만든다", () => {
    const res = parseDiagramText(EXAMPLE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { json } = res;

    expect(json.nodes.map((n) => n.label)).toEqual(["A", "B", "C", "D", "E", "회사", "개발팀", "백엔드"]);
    expect(json.edges.map((e) => [e.from, e.to, e.label ?? null, e.line, e.arrow])).toEqual([
      ["n1", "n2", "라벨", "solid", "end"], // A -> B
      ["n1", "n3", null, "solid", "end"], // A -> C
      ["n6", "n7", null, "solid", "end"], // 회사 -> 개발팀
      ["n7", "n8", null, "solid", "end"], // 개발팀 -> 백엔드
    ]);

    expect(json.groups).toEqual([{ id: "g1", title: "1일차", parent: null }]);
    const byLabel = Object.fromEntries(json.nodes.map((n) => [n.label, n]));
    expect(byLabel["D"].group).toBe("g1");
    expect(byLabel["E"].group).toBe("g1");
    expect(byLabel["A"].group).toBeUndefined();
    expect(byLabel["회사"].group).toBeUndefined();
  });

  it("결과가 parseDiagramJson → validateDiagramModel 을 통과한다", () => {
    const res = parseDiagramText(EXAMPLE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const model = parseDiagramJson(JSON.stringify(res.json));
    expect(model.structured).toBe(true);
    expect(validateDiagramModel(model)).toEqual({ valid: true, errors: [] });
  });
});

describe("parseDiagramText — 연결자 3종", () => {
  it("-- 는 arrow none, => 는 line thick, <-> 는 arrow both", () => {
    const res = parseDiagramText("A -- B\nC => D\nE <-> F");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.json.edges.map((e) => [e.line, e.arrow])).toEqual([
      ["solid", "none"],
      ["thick", "end"],
      ["solid", "both"],
    ]);
  });

  it("한 줄 체인 A -> B -> C 는 엣지 2개, 라벨은 마지막 hop 에만", () => {
    const res = parseDiagramText("A -> B -> C: 끝");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.json.nodes.map((n) => n.label)).toEqual(["A", "B", "C"]);
    expect(res.json.edges.map((e) => [e.from, e.to, e.label ?? null])).toEqual([
      ["n1", "n2", null],
      ["n2", "n3", "끝"],
    ]);
  });
});

describe("parseDiagramText — 라벨 꼬리", () => {
  it("(설명) 은 desc, #태그 는 tag 로 떼어지고 라벨에서 사라진다", () => {
    const res = parseDiagramText("서버 (배포 대상) #urgent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.json.nodes[0]).toMatchObject({ label: "서버", desc: "배포 대상", tag: "urgent" });
  });

  it("같은 라벨은 같은 노드 — 재등장해도 새로 만들지 않는다", () => {
    const res = parseDiagramText("A -> B\nB -> A");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.json.nodes).toHaveLength(2);
    expect(res.json.edges).toHaveLength(2);
  });
});

describe("parseDiagramText — 주석·빈 줄", () => {
  it("빈 줄과 # 로 시작하는 줄은 무시된다", () => {
    const res = parseDiagramText("# 이건 주석\n\nA -> B\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.json.nodes.map((n) => n.label)).toEqual(["A", "B"]);
  });
});

describe("parseDiagramText — 오류 3종, 정확한 줄 번호", () => {
  it("들여쓰기가 두 단 이상 점프하면 indent_jump", () => {
    const res = parseDiagramText("A\n    B");
    expect(res).toEqual({ ok: false, error: "indent_jump", line: 2 });
  });

  it("그룹 안에서 또 [그룹]을 열면 nested_group", () => {
    const res = parseDiagramText("[바깥]\n  안\n  [안쪽]");
    expect(res).toEqual({ ok: false, error: "nested_group", line: 3 });
  });

  it("알 수 없는 연결자는 unknown_connector", () => {
    const res = parseDiagramText("A <- B");
    expect(res).toEqual({ ok: false, error: "unknown_connector", line: 1 });
  });
});
