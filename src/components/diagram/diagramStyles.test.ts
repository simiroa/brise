import { describe, it, expect } from "vitest";
import { DIAGRAM_TONES, flagLabelOf, nodeMarkOptions, nodeTone, restyleTones, setNodeMark, setNodesMark, setNodeTone, toneLabelKey } from "./diagramStyles";
import { t } from "../../i18n/t";
import { parseDiagram } from "./diagramModel";

const BASE = JSON.stringify(
  {
    v: 1,
    nodes: [
      { id: "n1", label: "김철수", link: "note-abc-123" },
      { id: "n2", label: "김영수" },
      { id: "n3", label: "장영실" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "아들", line: "solid", arrow: "end" },
    ],
  },
  null,
  2,
);

describe("diagramStyles — applying a tone in JSON IR v1", () => {
  it("sets node flag for accent and updates node properties cleanly", () => {
    const out = setNodeTone(BASE, "n1", "accent");
    expect(nodeTone(out, "n1")).toBe("accent");
    expect(nodeTone(out, "n2")).toBe("default");
    const m = parseDiagram(out);
    const n1 = m.nodes.find((n) => n.id === "n1");
    expect(n1?.flag).toBe(true);
    expect(n1?.state).toBeUndefined();
  });

  it("sets node state for warn (state: 0), done (state: 1), muted (state: 2)", () => {
    const warn = setNodeTone(BASE, "n1", "warn");
    expect(nodeTone(warn, "n1")).toBe("warn");
    expect(parseDiagram(warn).nodes.find((n) => n.id === "n1")?.state).toBe(0);

    const done = setNodeTone(BASE, "n1", "done");
    expect(nodeTone(done, "n1")).toBe("done");
    expect(parseDiagram(done).nodes.find((n) => n.id === "n1")?.state).toBe(1);

    const muted = setNodeTone(BASE, "n1", "muted");
    expect(nodeTone(muted, "n1")).toBe("muted");
    expect(parseDiagram(muted).nodes.find((n) => n.id === "n1")?.state).toBe(2);
  });

  it("refuses ids that aren't nodes, byte-for-byte", () => {
    expect(setNodeTone(BASE, "nope", "accent")).toBe(BASE);
  });

  it("is idempotent — re-applying the same tone returns the same model", () => {
    const once = setNodeTone(BASE, "n1", "accent");
    expect(setNodeTone(once, "n1", "accent")).toBe(once);
  });

  it("leaves the structure model untouched", () => {
    const before = parseDiagram(BASE);
    const after = parseDiagram(setNodeTone(BASE, "n1", "warn"));
    expect(after.nodes.map((n) => `${n.id}:${n.label}:${n.shape}`)).toEqual(
      before.nodes.map((n) => `${n.id}:${n.label}:${n.shape}`),
    );
    expect(after.edges.map((e) => `${e.from}->${e.to}|${e.label}`)).toEqual(
      before.edges.map((e) => `${e.from}->${e.to}|${e.label}`),
    );
    expect(after.nodes.find((n) => n.id === "n1")?.link).toBe("note-abc-123");
  });
});

describe("diagramStyles — changing and clearing", () => {
  it("clearing removes the flag/state properties", () => {
    const accent = setNodeTone(BASE, "n1", "accent");
    const cleared = setNodeTone(accent, "n1", "default");
    expect(nodeTone(cleared, "n1")).toBe("default");
    const n1 = parseDiagram(cleared).nodes.find((n) => n.id === "n1");
    expect(n1?.flag).toBeUndefined();
    expect(n1?.state).toBeUndefined();
  });

  it("every tone has a name key", () => {
    expect(DIAGRAM_TONES).toEqual(["default", "accent", "warn", "done", "muted"]);
    expect(toneLabelKey("accent")).toBe("editor.diagram_tone_accent");
    expect(toneLabelKey("warn")).toBe("editor.diagram_tone_warn");
  });

  it("restyleTones is a pass-through no-op", () => {
    expect(restyleTones(BASE)).toBe(BASE);
  });
});


describe("diagramStyles — 색 칩 한 줄의 표시(NodeMark, GRILL-2026-10-19 R6)", () => {
  const node = (src: string, id = "n1") => parseDiagram(src).nodes.find((n) => n.id === id);

  it("setNodeMark: 강조와 상태는 서로를 지운다 — 한 번의 쓰기로", () => {
    const flagged = setNodeMark(BASE, "n1", "flag");
    expect(node(flagged)).toMatchObject({ flag: true });
    expect(node(flagged)?.state).toBeUndefined();

    // 상태 3 이상(옛 톤 피커가 닿지 못하던 슬롯)도 한 번에 — 강조는 지워진다
    const slot4 = setNodeMark(flagged, "n1", 4);
    expect(node(slot4)?.state).toBe(4);
    expect(node(slot4)?.flag).toBeUndefined();

    const cleared = setNodeMark(slot4, "n1", null);
    expect(node(cleared)?.state).toBeUndefined();
    expect(node(cleared)?.flag).toBeUndefined();
    expect(node(cleared, "n2")).toEqual(node(BASE, "n2"));
  });

  it("setNodeMark: 없는 id 는 바이트 그대로", () => {
    expect(setNodeMark(BASE, "nope", "flag")).toBe(BASE);
  });

  it("nodeMarkOptions: 기본 · 강조(flagLabel 또는 기본 이름) · 상태 이름들, 색은 상태 슬롯 변수", () => {
    const opts = nodeMarkOptions({ flagLabel: "중요", states: ["대기", "진행중"] });
    expect(opts.map((o) => o.mark)).toEqual([null, "flag", 0, 1]);
    expect(opts.map((o) => o.label)).toEqual([t("editor.diagram_tone_default"), "중요", "대기", "진행중"]);
    expect(opts.map((o) => o.colorVar)).toEqual([null, "var(--accent)", "var(--danger-soft)", "var(--ok)"]);
    // 상태 어휘가 없으면 상태 칩도 없다 — 강조 이름은 범례와 같은 기본값
    const bare = nodeMarkOptions({});
    expect(bare.map((o) => o.label)).toEqual([t("editor.diagram_tone_default"), t("editor.diagram_flag")]);
    expect(flagLabelOf({})).toBe(t("editor.diagram_flag"));
  });

  it("setNodesMark: 여러 노드에 같은 표시를 한 번에, 없는 id 는 건너뛰고 전부 없으면 바이트 그대로", () => {
    const src = JSON.stringify({ v: 1, states: ["a", "b"], nodes: [{ id: "x", label: "X", flag: true }, { id: "y", label: "Y" }, { id: "z", label: "Z", state: 0 }], edges: [] });
    const out = parseDiagram(setNodesMark(src, ["x", "y", "nope"], 1));
    expect(out.nodes.find((n) => n.id === "x")).toMatchObject({ state: 1 });
    expect(out.nodes.find((n) => n.id === "x")?.flag).toBeUndefined();
    expect(out.nodes.find((n) => n.id === "y")).toMatchObject({ state: 1 });
    expect(out.nodes.find((n) => n.id === "z")).toMatchObject({ state: 0 });
    expect(setNodesMark(src, ["nope"], "flag")).toBe(src);
  });

  it("nodeMarkOptions: 상태에 강조와 같은 이름이 있으면 강조 칩은 강조가 걸린 노드에서만", () => {
    const model = { states: [t("editor.diagram_flag"), "주의", "완료"] };
    const labels = (cur?: { flag?: boolean }) => nodeMarkOptions(model, cur).map((o) => o.mark);
    expect(labels()).toEqual([null, 0, 1, 2]);
    expect(labels({ flag: false })).toEqual([null, 0, 1, 2]);
    expect(labels({ flag: true })).toEqual([null, "flag", 0, 1, 2]);
  });
});
