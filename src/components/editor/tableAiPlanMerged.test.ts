import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { createMarkdownEditor, createMarkdownSchemaExtensions, mdSerializeEditor } from "../../lib/mdSerialize";
import {
  TableAiPlanError,
  applyTableAiPlan,
  extractTableAiSnapshot,
  normalizeTableAiPlan,
  previewTableAiPlan,
  type TableAiSnapshot,
} from "./tableAiPlan";

// W2-P (PLAN-2026-10-07-doc-import-export §3) — AI 표 편집이 병합·양식 표도 채운다.
// 기본 호출(allowMerged 없음)이 예전과 같다는 것도 여기서 못 박는다: TextAssist(표 → 시트로) ·
// applyTableMatrixPaste · textDerive 는 TextAssist.test 가 모듈을 통째로 목킹해서 이 파일 밖에는 보호막이 없다.

/** 이력서식 양식: 첫 열 th 라벨, 가로(colspan)·세로(rowspan)·2×2 병합, 셀 배경, 가운데 정렬 셀, 열 너비.
 *  격자(6 × 4):
 *    r0  성명 | []   | 생년월일 | [배경]
 *    r1  주소 | ←──── 병합(1×3) ────→
 *    r2  경력 | 담당 업무 ──(2×2)── | []
 *    r3   ↑   |   ↑      ↑          | []
 *    r4  학력 | []   | []      | []
 *    r5   ↑   | []   | []      | []        */
// 열 너비는 칸마다 일관되게(80·100·100·120) 준다 — 표 확장의 fixTables 플러그인이 문서가 바뀔 때마다 어긋난 colwidth 를
// 이웃 칸에 맞춰 고쳐 쓰므로, 어긋난 채로 두면 "손대지 않은 칸이 그대로" 검증이 그 플러그인과 싸운다.
const FORM_HTML =
  "<p>머리</p><table>" +
  '<tr><th colwidth="80">성명</th><td colwidth="100"></td><th colwidth="100">생년월일</th><td colwidth="120" style="background-color: rgb(204, 229, 255)"></td></tr>' +
  '<tr><th colwidth="80">주소</th><td colspan="3" colwidth="100,100,120"></td></tr>' +
  '<tr><th rowspan="2" colwidth="80">경력</th><td colspan="2" rowspan="2" colwidth="100,100" style="background-color: rgb(255, 255, 0)">' +
  '<p style="text-align:center" data-brise-align="center">담당 업무</p></td><td colwidth="120"></td></tr>' +
  '<tr><td colwidth="120"></td></tr>' +
  '<tr><th rowspan="2" colwidth="80">학력</th><td colwidth="100"></td><td colwidth="100"></td><td colwidth="120"></td></tr>' +
  '<tr><td colwidth="100"></td><td colwidth="100"></td><td colwidth="120"></td></tr>' +
  "</table><p>꼬리</p>";

const FORM_GRID = [
  ["성명", "", "생년월일", ""],
  ["주소", "", "", ""],
  ["경력", "담당 업무", "", ""],
  ["", "", "", ""],
  ["학력", "", "", ""],
  ["", "", "", ""],
];

const FORM_MERGES = [
  { row: 1, col: 1, rowspan: 1, colspan: 3 },
  { row: 2, col: 0, rowspan: 2, colspan: 1 },
  { row: 2, col: 1, rowspan: 2, colspan: 2 },
  { row: 4, col: 0, rowspan: 2, colspan: 1 },
];

function makeEditor(html: string): Editor {
  return new Editor({ extensions: createMarkdownSchemaExtensions(), content: html });
}

function cellPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") positions.push(pos);
  });
  return positions;
}

/** 캐럿을 i 번째 셀(문서 순서) 안에 둔다. */
function caretInCell(editor: Editor, index = 0) {
  editor.commands.setTextSelection(cellPositions(editor)[index] + 2);
}

function selectCell(editor: Editor, anchorIndex: number, headIndex = anchorIndex) {
  const positions = cellPositions(editor);
  editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
    editor.state.doc.resolve(positions[anchorIndex]),
    editor.state.doc.resolve(positions[headIndex]),
  )));
}

function snapshotOf(editor: Editor): TableAiSnapshot {
  const snapshot = extractTableAiSnapshot(editor, { allowMerged: true });
  if (!snapshot) throw new Error("no snapshot");
  return snapshot;
}

function planOf(snapshot: TableAiSnapshot, operations: unknown[]) {
  return normalizeTableAiPlan({ version: 1, baseTableFingerprint: snapshot.tableFingerprint, operations }, snapshot);
}

/** 문서 순서의 모든 셀(td·th) JSON. */
function cellsOf(json: JSONContent): JSONContent[] {
  const out: JSONContent[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "tableCell" || node.type === "tableHeader") out.push(node);
    node.content?.forEach(walk);
  };
  walk(json);
  return out;
}

// 문서 순서 셀 번호: 0 성명 · 1 [] · 2 생년월일 · 3 [배경] · 4 주소 · 5 [병합 1×3] · 6 경력 · 7 담당 업무(2×2) · 8 [] · 9 [] · 10 학력 · 11~13 [] · 14~16 []
const CELL = { name: 1, merged3: 5, big: 7, lastOfRow3: 9, row5Last: 16 } as const;

describe("allowMerged 스냅샷", () => {
  it("병합 표를 격자 + merges 로 준다(가려진 칸은 \"\")", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);

    expect(snapshot.rows).toEqual(FORM_GRID);
    expect(snapshot.merges).toEqual(FORM_MERGES);
    expect(snapshot.headerRow).toBe(false); // 첫 행이 th·td 섞임 — 완전한 머리글 행이 아니다
    expect(snapshot.structureLocked).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    editor.destroy();
  });

  it("기본 호출은 병합 표를 여전히 null 로 본다(던지지 않는다)", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    expect(() => extractTableAiSnapshot(editor)).not.toThrow();
    expect(extractTableAiSnapshot(editor)).toBeNull();
    expect(extractTableAiSnapshot(editor, {})).toBeNull();
    expect(extractTableAiSnapshot(editor, { allowMerged: false })).toBeNull();
    editor.destroy();
  });

  it("셀 선택은 격자 좌표이고 병합 셀을 통째로 감싼다", () => {
    const editor = makeEditor(FORM_HTML);
    selectCell(editor, CELL.name); // 병합이 아닌 한 칸
    expect(snapshotOf(editor).selection).toEqual({ fromRow: 0, toRow: 0, fromCol: 1, toCol: 1 });
    selectCell(editor, CELL.big); // 2×2 병합 셀
    expect(snapshotOf(editor).selection).toEqual({ fromRow: 2, toRow: 3, fromCol: 1, toCol: 2 });
    editor.destroy();
  });

  it("첫 행이 전부 th 일 때만 headerRow 이고, 병합된 머리글 칸 아래 열의 이름이 라벨이 된다", () => {
    const editor = makeEditor(
      `<table><tr><th colspan="2">${"제목".repeat(15)}</th><th>비고</th></tr><tr><td></td><td></td><td></td></tr></table>`,
    );
    caretInCell(editor, 0);
    const snapshot = snapshotOf(editor);
    expect(snapshot.headerRow).toBe(true);
    expect(snapshot.merges).toEqual([{ row: 0, col: 0, rowspan: 1, colspan: 2 }]);

    const labels = previewTableAiPlan(snapshot, planOf(snapshot, [
      { type: "cell-set", row: 1, col: 0, value: "a" },
      { type: "cell-set", row: 1, col: 1, value: "b" },
      { type: "cell-set", row: 1, col: 2, value: "c" },
    ])).map((entry) => entry.label);
    // 왼쪽에 라벨이 없으니 머리글 — 병합 머리글은 20자로 잘리고, 가려진 칸 아래도 그 병합 셀 글자다.
    expect(labels).toEqual(["제목".repeat(15).slice(0, 20), "제목".repeat(15).slice(0, 20), "비고"]);
    editor.destroy();
  });

  it("못 읽는 표(rowspan=0 — 격자에 자리를 못 얻는 셀)는 던지지 않고 null", () => {
    // TableMap 은 이 셀의 칸을 0 으로 비워 두는데 0 은 첫 행 노드의 오프셋이기도 하다 — problems 에도 안 잡혀서
    // 행을 셀로 읽으면 한 칸에 두 글자가 줄바꿈으로 붙어 들어간다(실측).
    const editor = makeEditor('<table><tr><td rowspan="0">x</td><td>y</td></tr><tr><td colspan="2">z</td></tr></table>');
    caretInCell(editor, 1);
    expect(() => extractTableAiSnapshot(editor, { allowMerged: true })).not.toThrow();
    expect(extractTableAiSnapshot(editor, { allowMerged: true })).toBeNull();
    editor.destroy();
  });

  it("열 너비 어긋남(colwidth mismatch)은 불규칙 표로 치지 않는다 — 가져온 양식에 흔하다", () => {
    const editor = makeEditor(
      '<table><tr><th>A</th><td colspan="2" colwidth="100,100">B</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
    );
    caretInCell(editor, 1);
    expect(snapshotOf(editor).rows).toEqual([["A", "B", ""], ["1", "2", "3"]]);
    editor.destroy();
  });

  it("병합이 없는 단순 표는 allowMerged 여도 기본 호출과 JSON 까지 같다(키 순서 포함)", () => {
    const editor = makeEditor(
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>",
    );
    caretInCell(editor, 3);
    const plain = extractTableAiSnapshot(editor)!;
    expect(JSON.stringify(extractTableAiSnapshot(editor, { allowMerged: true }))).toBe(JSON.stringify(plain));
    expect(Object.keys(plain)).toEqual([
      "version", "tablePos", "tableNodeSize", "docFingerprint", "tableFingerprint", "rows", "headerRow",
    ]);
    expect(plain.rows).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);

    selectCell(editor, 2, 5);
    const selected = extractTableAiSnapshot(editor)!;
    expect(JSON.stringify(extractTableAiSnapshot(editor, { allowMerged: true }))).toBe(JSON.stringify(selected));
    expect(Object.keys(selected).slice(-1)).toEqual(["selection"]);
    expect("merges" in selected || "structureLocked" in selected).toBe(false);
    editor.destroy();
  });

  it("단순 표의 구조 변경은 allowMerged 로 뽑아도 그대로 된다", () => {
    const editor = makeEditor("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    caretInCell(editor, 0);
    const snapshot = snapshotOf(editor);
    const plan = planOf(snapshot, [{ type: "row-insert", index: 2, values: ["3", "4"] }, { type: "header-set", enabled: false }]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    expect(extractTableAiSnapshot(editor)?.rows).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
    expect(extractTableAiSnapshot(editor)?.headerRow).toBe(false);
    editor.destroy();
  });
});

describe("병합 표 계획 — 검증", () => {
  function formSnapshot() {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    return { editor, snapshot: snapshotOf(editor) };
  }

  it("가려진 칸을 겨냥한 셀 연산을 거부한다(병합 셀 본체가 덮이는 사고)", () => {
    const { editor, snapshot } = formSnapshot();
    for (const [row, col] of [[1, 2], [1, 3], [2, 2], [3, 1], [3, 2], [3, 0], [5, 0]]) {
      expect(() => planOf(snapshot, [{ type: "cell-set", row, col, value: "x" }])).toThrow(TableAiPlanError);
      expect(() => planOf(snapshot, [{ type: "cell-clear", row, col }])).toThrow(TableAiPlanError);
    }
    // 병합 셀의 왼쪽 위와 병합되지 않은 칸은 된다.
    expect(planOf(snapshot, [
      { type: "cell-set", row: 1, col: 1, value: "a" },
      { type: "cell-set", row: 2, col: 1, value: "b" },
      { type: "cell-set", row: 2, col: 3, value: "c" },
    ]).operations).toHaveLength(3);
    editor.destroy();
  });

  it("행/열 구조 변경과 머리글 전환을 거부한다", () => {
    const { editor, snapshot } = formSnapshot();
    for (const operation of [
      { type: "row-insert", index: 1 },
      { type: "row-delete", index: 1 },
      { type: "row-move", from: 0, to: 1 },
      { type: "column-insert", index: 1 },
      { type: "column-delete", index: 1 },
      { type: "column-move", from: 0, to: 1 },
      { type: "header-set", enabled: true },
    ]) {
      expect(() => planOf(snapshot, [operation])).toThrow(TableAiPlanError);
    }
    editor.destroy();
  });

  it("같은 병합 셀을 두 번 바꾸는 계획과 낡은 지문의 계획을 거부한다", () => {
    const { editor, snapshot } = formSnapshot();
    expect(() => planOf(snapshot, [
      { type: "cell-set", row: 2, col: 1, value: "a" },
      { type: "cell-clear", row: 2, col: 1 },
    ])).toThrow(TableAiPlanError);
    expect(() => normalizeTableAiPlan({ version: 1, baseTableFingerprint: "x", operations: [] }, snapshot)).toThrow(/stale/i);
    editor.destroy();
  });

  it("선택 범위 밖의 셀은 병합 표에서도 거부한다", () => {
    const editor = makeEditor(FORM_HTML);
    selectCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    expect(planOf(snapshot, [{ type: "cell-set", row: 0, col: 1, value: "ok" }]).operations).toHaveLength(1);
    expect(() => planOf(snapshot, [{ type: "cell-set", row: 0, col: 3, value: "out" }])).toThrow(TableAiPlanError);
    editor.destroy();
  });

  it("첫 열 th 라벨만 있는 병합 없는 양식도 셀 연산만 허용한다", () => {
    const editor = makeEditor("<table><tr><th>성명</th><td></td></tr><tr><th>연락처</th><td></td></tr></table>");
    caretInCell(editor, 1);
    expect(extractTableAiSnapshot(editor)).toBeNull(); // 기본 호출은 th 가 첫 행 밖에 있어 단순 표가 아니다
    const snapshot = snapshotOf(editor);
    expect(snapshot.merges).toEqual([]);
    expect(snapshot.structureLocked).toBe(true);
    expect(snapshot.rows).toEqual([["성명", ""], ["연락처", ""]]);
    // rebuildTable 이 th 를 td 로 바꾸는 구조 변경은 거부, 셀 연산은 통과.
    expect(() => planOf(snapshot, [{ type: "row-insert", index: 2 }])).toThrow(TableAiPlanError);
    expect(() => planOf(snapshot, [{ type: "header-set", enabled: true }])).toThrow(TableAiPlanError);

    const plan = planOf(snapshot, [{ type: "cell-set", row: 1, col: 1, value: "010-0000-0000" }]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    expect(cellsOf(editor.getJSON()).map((c) => c.type)).toEqual(["tableHeader", "tableCell", "tableHeader", "tableCell"]);
    expect(snapshotOf(editor).rows).toEqual([["성명", ""], ["연락처", "010-0000-0000"]]);
    editor.destroy();
  });
});

describe("병합 표 계획 — 미리보기와 칸 이름(label)", () => {
  it("라벨 칸 · 가려진 칸의 병합 라벨 · 머리글 순으로 이름을 찾고 before 는 격자에서 읽는다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const preview = previewTableAiPlan(snapshot, planOf(snapshot, [
      { type: "cell-set", row: 0, col: 1, value: "홍길동" }, // 왼쪽 성명
      { type: "cell-set", row: 0, col: 3, value: "1990-01-01" }, // 왼쪽 생년월일
      { type: "cell-set", row: 1, col: 1, value: "서울" }, // 병합 칸 자신 — 왼쪽 주소
      { type: "cell-set", row: 2, col: 1, value: "총괄" }, // 2×2 — 왼쪽 경력
      { type: "cell-set", row: 3, col: 3, value: "x" }, // 왼쪽 두 칸이 2×2 에 가려졌다 → 그 병합 셀 글자
      { type: "cell-set", row: 5, col: 3, value: "대졸" }, // 왼쪽 빈 칸들 너머 세로 병합 라벨(학력, rowspan 2)
    ]));
    expect(preview.map((e) => e.label)).toEqual(["성명", "생년월일", "주소", "경력", "담당 업무", "학력"]);
    expect(preview[3]).toMatchObject({ before: "담당 업무", after: "총괄", kind: "cell-set", checked: true });
    expect(preview[4]).toMatchObject({ before: "", after: "x", kind: "cell-set" });
    editor.destroy();
  });

  it("긴 글은 라벨이 아니라 값으로 보고 건너뛰며, 어디서도 이름이 없으면 label 키가 없다", () => {
    const longValue = "가".repeat(21);
    const editor = makeEditor(
      `<table><tr><td>${longValue}</td><td></td></tr><tr><td colspan="2"></td></tr></table>`,
    );
    caretInCell(editor, 0);
    const snapshot = snapshotOf(editor);
    const [entry] = previewTableAiPlan(snapshot, planOf(snapshot, [{ type: "cell-set", row: 0, col: 1, value: "x" }]));
    expect("label" in entry).toBe(false);
    editor.destroy();
  });

  it("단순 표의 셀 연산에도 label 이 붙는다(왼쪽 칸, 없으면 머리글)", () => {
    const editor = makeEditor("<table><tr><th>이름</th><th>나이</th></tr><tr><td>홍</td><td>30</td></tr></table>");
    caretInCell(editor, 0);
    const snapshot = extractTableAiSnapshot(editor)!;
    expect(snapshot.merges).toBeUndefined();
    const preview = previewTableAiPlan(snapshot, planOf(snapshot, [
      { type: "cell-set", row: 1, col: 0, value: "김" }, // 왼쪽 없음 → 머리글
      { type: "cell-set", row: 1, col: 1, value: "31" }, // 왼쪽 칸(홍)
      { type: "row-insert", index: 2 },
    ]));
    expect(preview.map((e) => e.label)).toEqual(["이름", "홍", undefined]);
    editor.destroy();
  });
});

describe("병합 표 계획 — 적용", () => {
  it("값을 채워도 다른 칸 · 병합 · 배경 · 정렬 · 열 너비 · th 가 그대로이고, 한 번의 undo 로 되돌아온다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const before = editor.getJSON();
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 0, col: 1, value: "홍길동" },
      { type: "cell-set", row: 2, col: 1, value: "프로젝트 총괄" },
      { type: "cell-set", row: 5, col: 3, value: "대졸" },
    ]);

    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);

    const after = editor.getJSON();
    const cellsBefore = cellsOf(before);
    const cellsAfter = cellsOf(after);
    expect(cellsAfter).toHaveLength(cellsBefore.length);
    const changed = new Set<number>([CELL.name, CELL.big, CELL.row5Last]);
    cellsBefore.forEach((cell, index) => {
      // 셀 노드 자체(종류 · colspan · rowspan · colwidth · 배경)는 바뀐 칸도 그대로.
      expect(cellsAfter[index].type).toBe(cell.type);
      expect(cellsAfter[index].attrs).toEqual(cell.attrs);
      if (!changed.has(index)) expect(JSON.stringify(cellsAfter[index])).toBe(JSON.stringify(cell));
    });

    const big = cellsAfter[CELL.big];
    expect(big.attrs).toMatchObject({ colspan: 2, rowspan: 2, colwidth: [100, 100], backgroundColor: "rgb(255, 255, 0)" });
    expect(big.content).toHaveLength(1);
    expect(big.content?.[0].attrs?.textAlign).toBe("center"); // 가운데 정렬이 새 문단에 물려졌다
    expect(big.content?.[0].content?.[0].text).toBe("프로젝트 총괄");
    expect(cellsAfter[CELL.name].content?.[0].content?.[0].text).toBe("홍길동");
    expect(cellsAfter[CELL.name].content?.[0].attrs?.textAlign).toBe("left");

    expect(snapshotOf(editor).rows).toEqual([
      ["성명", "홍길동", "생년월일", ""],
      ["주소", "", "", ""],
      ["경력", "프로젝트 총괄", "", ""],
      ["", "", "", ""],
      ["학력", "", "", ""],
      ["", "", "", "대졸"],
    ]);
    expect(snapshotOf(editor).merges).toEqual(FORM_MERGES);

    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("cell-clear 는 문단과 정렬을 남기고 글자만 비운다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const plan = planOf(snapshot, [{ type: "cell-clear", row: 2, col: 1 }]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    const big = cellsOf(editor.getJSON())[CELL.big];
    expect(big.content).toEqual([{ type: "paragraph", attrs: { textAlign: "center", indent: 0 } }]);
    expect(snapshotOf(editor).rows[2][1]).toBe("");
    editor.destroy();
  });

  it("체크한 연산만 적용하고, 모르는 id 는 거부한다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 0, col: 1, value: "홍길동" },
      { type: "cell-set", row: 0, col: 3, value: "1990" },
    ]);
    expect(() => applyTableAiPlan(editor, snapshot, plan, new Set(["nope"]))).toThrow(TableAiPlanError);
    expect(applyTableAiPlan(editor, snapshot, plan, new Set([plan.operations[1].id]))).toBe(true);
    expect(snapshotOf(editor).rows[0]).toEqual(["성명", "", "생년월일", "1990"]);
    expect(applyTableAiPlan(editor, snapshotOf(editor), planOf(snapshotOf(editor), []), new Set())).toBe(false);
    editor.destroy();
  });

  it("문서가 바뀌었으면 stale 로 거부한다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const plan = planOf(snapshot, [{ type: "cell-set", row: 0, col: 1, value: "새" }]);
    editor.commands.insertContentAt(1, "다른 곳을 고쳤다");
    expect(() => applyTableAiPlan(editor, snapshot, plan)).toThrow(/stale/i);
    editor.destroy();
  });

  it("표 안 글자가 바뀌어도 stale 이다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const plan = planOf(snapshot, [{ type: "cell-set", row: 0, col: 1, value: "새" }]);
    editor.commands.insertContentAt(cellPositions(editor)[CELL.name] + 2, "손으로 쓴 글");
    expect(() => applyTableAiPlan(editor, snapshot, plan)).toThrow(/stale/i);
    editor.destroy();
  });

  it("손으로 만든 계획도 가려진 칸으로는 적용되지 않는다(정규화 우회 방지)", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const forged = {
      version: 1 as const,
      baseTableFingerprint: snapshot.tableFingerprint,
      operations: [{ type: "cell-set" as const, row: 3, col: 1, value: "덮어쓰기", id: "op-001-cell-set" }],
    };
    expect(() => applyTableAiPlan(editor, snapshot, forged)).toThrow(TableAiPlanError);
    editor.destroy();
  });
});

describe("병합 표 계획 — 저장·재로드", () => {
  it("적용 뒤 저장한 마크다운이 서식을 담고, 재로드해도 같은 격자이며, 다시 저장해도 바이트가 같다", () => {
    const editor = makeEditor(FORM_HTML);
    caretInCell(editor, CELL.name);
    const snapshot = snapshotOf(editor);
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 0, col: 1, value: "홍길동" },
      { type: "cell-set", row: 2, col: 1, value: "프로젝트 총괄" },
    ]);
    applyTableAiPlan(editor, snapshot, plan);
    const afterGrid = snapshotOf(editor).rows;

    const md = mdSerializeEditor(editor);
    expect(md).toContain("<table");
    expect(md).toContain("background-color: rgb(255, 255, 0)");
    expect(md).toContain('data-brise-align="center"');

    const reloaded = createMarkdownEditor(md, true);
    caretInCell(reloaded, CELL.name);
    const again = snapshotOf(reloaded);
    expect(again.rows).toEqual(afterGrid);
    expect(again.merges).toEqual(FORM_MERGES);
    expect(mdSerializeEditor(reloaded)).toBe(md);

    // 재로드한 표에도 다시 채울 수 있다.
    const second = planOf(again, [{ type: "cell-set", row: 5, col: 3, value: "대졸" }]);
    expect(applyTableAiPlan(reloaded, again, second)).toBe(true);
    expect(snapshotOf(reloaded).rows[5][3]).toBe("대졸");
    reloaded.destroy();
    editor.destroy();
  });
});

describe("여러 줄 값", () => {
  const value = "첫째 줄\n둘째 줄";

  function fill(html: string, locked: boolean) {
    const editor = makeEditor(html);
    caretInCell(editor, 0);
    const snapshot = locked ? snapshotOf(editor) : extractTableAiSnapshot(editor)!;
    applyTableAiPlan(editor, snapshot, planOf(snapshot, [{ type: "cell-set", row: 1, col: 1, value }]));
    return editor;
  }

  it("문단을 쪼개지 않고 한 문단 안의 줄바꿈으로 들어간다(단순 표 경로와 같은 \"한 칸\" 규칙)", () => {
    const simple = fill("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>", false);
    const locked = fill("<table><tr><th>A</th><td>B</td></tr><tr><th>1</th><td>2</td></tr></table>", true);
    const simpleCell = cellsOf(simple.getJSON())[3];
    const lockedCell = cellsOf(locked.getJSON())[3];
    expect(simpleCell.content).toHaveLength(1);
    expect(lockedCell.content).toHaveLength(1);
    expect(lockedCell.content?.[0].content).toEqual([
      { type: "text", text: "첫째 줄" }, { type: "hardBreak" }, { type: "text", text: "둘째 줄" },
    ]);
    simple.destroy();
    locked.destroy();
  });

  it("병합 표의 여러 줄 값은 저장·재로드를 거쳐도 줄이 남고 둘째 저장부터가 아니라 첫 저장부터 바이트가 안정이다", () => {
    // 글자 속 개행으로 두면 `<p>a&#10;b</p>` → 재로드 "a b" → 둘째 저장이 달라졌다(실측). hardBreak 면 `<br>` 로 고정점.
    // 병합 하나로 HTML 조각 표가 되게 한다 — 병합·배경 없는 표는 GFM 으로 저장돼 첫 열 th 가 td 로 접힌다(W0 한계, 이 테스트 밖).
    const editor = fill('<table><tr><th colspan="2">A</th></tr><tr><th>1</th><td>2</td></tr></table>', true);
    const md = mdSerializeEditor(editor);
    expect(md).toMatch(/^<table/);
    const reloaded = createMarkdownEditor(md, true);
    caretInCell(reloaded, 0);
    expect(snapshotOf(reloaded).rows[1][1]).toBe(value);
    expect(mdSerializeEditor(reloaded)).toBe(md);
    reloaded.destroy();
    editor.destroy();
  });
});

// ---- 글자 아닌 내용이 든 칸 · 표를 바꾸지 않는 연산 ----

/** 서명·사진 칸: 이미지 하나만 든 세로 병합 칸(W1 hwpx 가져오기가 병합 표 셀 안에 그림을 이렇게 넣는다).
 *  격자(2 × 4):
 *    r0  성명 | []   | 사진 | [이미지 — 2×1]
 *    r1  주소 | []   |  ↑   |  ↑                          */
const IMAGE_FORM_HTML =
  "<table>" +
  '<tr><th colwidth="80">성명</th><td colwidth="100"></td><th rowspan="2" colwidth="80">사진</th>' +
  '<td rowspan="2" colwidth="120"><p><img src="attachments/n1/pic.png" data-rel-path="attachments/n1/pic.png"></p></td></tr>' +
  '<tr><th colwidth="80">주소</th><td colwidth="100"></td></tr>' +
  "</table>";

function countNodes(editor: Editor, type: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => { if (node.type.name === type) count++; });
  return count;
}

describe("글자 아닌 내용(그림)이 든 칸", () => {
  function imageForm() {
    const editor = makeEditor(IMAGE_FORM_HTML);
    // 테스트가 헛돌지 않게 — 스키마가 <img> 를 실제로 받아들였는지부터 확인한다.
    expect(countNodes(editor, "image")).toBe(1);
    caretInCell(editor, 0);
    return { editor, snapshot: snapshotOf(editor) };
  }

  it("rows 에서는 글자가 없어 \"\" 지만 opaque 로 알린다(없을 때는 키 자체가 없다)", () => {
    const { editor, snapshot } = imageForm();
    expect(snapshot.rows).toEqual([["성명", "", "사진", ""], ["주소", "", "", ""]]);
    expect(snapshot.opaque).toEqual([{ row: 0, col: 3 }]);
    editor.destroy();

    const plain = makeEditor(FORM_HTML);
    caretInCell(plain, CELL.name);
    expect("opaque" in snapshotOf(plain)).toBe(false);
    plain.destroy();
  });

  it("그 칸의 cell-set / cell-clear 는 계획에서 빠지고(거부가 아니라), 나머지 연산은 그대로 남는다", () => {
    const { editor, snapshot } = imageForm();
    expect(planOf(snapshot, [{ type: "cell-set", row: 0, col: 3, value: "홍길동" }]).operations).toEqual([]);
    expect(planOf(snapshot, [{ type: "cell-clear", row: 0, col: 3 }]).operations).toEqual([]);
    // id 는 남은 연산을 세어 붙인다 — 빠진 연산이 앞에 있어도 op-001 부터.
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 0, col: 3, value: "홍길동" },
      { type: "cell-set", row: 0, col: 1, value: "김하늘" },
      { type: "cell-set", row: 1, col: 1, value: "서울" },
    ]);
    expect(plan.operations.map((op) => op.id)).toEqual(["op-001-cell-set", "op-002-cell-set"]);
    // 가려진 칸은 여전히 거부다(계획이 잘못된 것 — 빼는 게 아니다).
    expect(() => planOf(snapshot, [{ type: "cell-set", row: 1, col: 3, value: "x" }])).toThrow(TableAiPlanError);
    editor.destroy();
  });

  it("빠진 연산이 섞인 계획도 적용되고(정규화 재검사 통과), 그림은 그대로 남는다", () => {
    const { editor, snapshot } = imageForm();
    const before = cellsOf(editor.getJSON())[3];
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 0, col: 3, value: "홍길동" },
      { type: "cell-set", row: 0, col: 1, value: "김하늘" },
      { type: "cell-clear", row: 0, col: 3 },
    ]);
    expect(plan.operations).toHaveLength(1);
    expect(previewTableAiPlan(snapshot, plan).map((e) => e.id)).toEqual(["op-001-cell-set"]);

    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    expect(countNodes(editor, "image")).toBe(1);
    expect(JSON.stringify(cellsOf(editor.getJSON())[3])).toBe(JSON.stringify(before));
    expect(snapshotOf(editor).rows[0][1]).toBe("김하늘");
    editor.destroy();
  });

  it("그림 칸만 겨냥한 계획은 비어서 적용할 것이 없다", () => {
    const { editor, snapshot } = imageForm();
    const before = editor.getJSON();
    const plan = planOf(snapshot, [{ type: "cell-set", row: 0, col: 3, value: "(사진 첨부)" }]);
    expect(previewTableAiPlan(snapshot, plan)).toEqual([]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("손으로 만든 계획 · opaque 를 지운 스냅샷으로는 그림 칸을 못 덮는다(정규화 우회 방지)", () => {
    const { editor, snapshot } = imageForm();
    const forged = {
      version: 1 as const,
      baseTableFingerprint: snapshot.tableFingerprint,
      operations: [{ type: "cell-set" as const, row: 0, col: 3, value: "덮어쓰기", id: "op-001-cell-set" }],
    };
    expect(() => applyTableAiPlan(editor, snapshot, forged)).toThrow(TableAiPlanError);

    // opaque 목록을 떼어 낸 위조 스냅샷 — 실제 표와 대조해 stale 로 거부한다.
    const { opaque: _opaque, ...stripped } = snapshot;
    const plan = planOf(stripped, [{ type: "cell-set", row: 0, col: 3, value: "덮어쓰기" }]);
    expect(plan.operations).toHaveLength(1); // 위조 스냅샷 기준으로는 정상 연산
    expect(() => applyTableAiPlan(editor, stripped, plan)).toThrow(/stale/i);
    expect(countNodes(editor, "image")).toBe(1);
    editor.destroy();
  });

  it("병합이 없는 단순 표도 allowMerged 에서는 그림 칸이 있으면 구조를 잠그고 opaque 로 알린다(기본 호출은 그대로)", () => {
    const html =
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><p><img src="attachments/n1/pic.png" data-rel-path="attachments/n1/pic.png"></p></td></tr></table>';
    const editor = makeEditor(html);
    expect(countNodes(editor, "image")).toBe(1);
    caretInCell(editor, 0);

    const plain = extractTableAiSnapshot(editor)!;
    expect(plain.rows).toEqual([["A", "B"], ["1", ""]]);
    expect("opaque" in plain || "merges" in plain || "structureLocked" in plain).toBe(false);

    const snapshot = snapshotOf(editor);
    expect(snapshot.rows).toEqual(plain.rows);
    expect(snapshot.merges).toEqual([]);
    expect(snapshot.structureLocked).toBe(true);
    expect(snapshot.opaque).toEqual([{ row: 1, col: 1 }]);
    expect(() => planOf(snapshot, [{ type: "row-insert", index: 2 }])).toThrow(TableAiPlanError);
    expect(planOf(snapshot, [{ type: "cell-set", row: 1, col: 1, value: "x" }]).operations).toEqual([]);

    const plan = planOf(snapshot, [{ type: "cell-set", row: 1, col: 0, value: "하나" }]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    expect(countNodes(editor, "image")).toBe(1);
    editor.destroy();
  });

  it("칸 안에 표가 든 칸도 글자 아닌 내용으로 본다", () => {
    const editor = makeEditor(
      '<table><tr><th>A</th><td colspan="1"><table><tr><td>안쪽</td></tr></table></td></tr><tr><th>B</th><td></td></tr></table>',
    );
    caretInCell(editor, 0);
    expect(snapshotOf(editor).opaque).toEqual([{ row: 0, col: 1 }]);
    editor.destroy();
  });

  it("라벨은 그림 칸을 건너뛴다(빈 글자는 라벨이 아니다)", () => {
    const { editor, snapshot } = imageForm();
    const [entry] = previewTableAiPlan(snapshot, planOf(snapshot, [{ type: "cell-set", row: 1, col: 1, value: "서울" }]));
    expect(entry.label).toBe("주소");
    editor.destroy();
  });
});

describe("표를 바꾸지 않는 연산 — 값이 같은 cell-set · 이미 빈 칸의 cell-clear", () => {
  /** 목록이 든 칸과 굵은 글씨가 든 칸이 있는 병합 표(첫 행 colspan 으로 잠금). */
  const RICH_HTML =
    '<table><tr><th colspan="2">제목</th></tr>' +
    "<tr><th>목록</th><td><ul><li><p>a</p></li><li><p>b</p></li></ul></td></tr>" +
    "<tr><th>서식</th><td><p><strong>굵게</strong> 보통</p></td></tr>" +
    "<tr><th>빈칸</th><td></td></tr></table>";

  function rich() {
    const editor = makeEditor(RICH_HTML);
    caretInCell(editor, 0);
    const snapshot = snapshotOf(editor);
    expect(snapshot.rows).toEqual([["제목", ""], ["목록", "a\nb"], ["서식", "굵게 보통"], ["빈칸", ""]]);
    return { editor, snapshot };
  }

  it("값이 지금과 같은 cell-set 과 빈 칸의 cell-clear 는 계획에서 빠진다", () => {
    const { editor, snapshot } = rich();
    expect(planOf(snapshot, [
      { type: "cell-set", row: 1, col: 1, value: "a\nb" },
      { type: "cell-set", row: 2, col: 1, value: "굵게 보통" },
      { type: "cell-clear", row: 3, col: 1 },
      { type: "cell-set", row: 3, col: 1, value: "" },
    ]).operations).toEqual([]);
    editor.destroy();
  });

  it("그런 계획을 적용해도 문서를 건드리지 않는다 — 목록 · 굵게가 평문으로 납작해지지 않는다", () => {
    const { editor, snapshot } = rich();
    const before = editor.getJSON();
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 1, col: 1, value: "a\nb" },
      { type: "cell-set", row: 2, col: 1, value: "굵게 보통" },
    ]);
    expect(previewTableAiPlan(snapshot, plan)).toEqual([]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("진짜 변경과 섞이면 빠진 연산만 빠지고, 손대지 않은 칸의 서식은 그대로다", () => {
    const { editor, snapshot } = rich();
    const before = cellsOf(editor.getJSON());
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 2, col: 1, value: "굵게 보통" }, // 같은 값 — 빠진다
      { type: "cell-set", row: 3, col: 1, value: "채움" },
    ]);
    expect(plan.operations.map((op) => op.id)).toEqual(["op-001-cell-set"]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    const after = cellsOf(editor.getJSON());
    // 문서 순서 셀 번호: 0 제목 · 1 목록 · 2 목록값 · 3 서식 · 4 서식값 · 5 빈칸 · 6 빈칸값
    expect(JSON.stringify(after[4])).toBe(JSON.stringify(before[4])); // 굵은 글씨 칸
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(before[2])); // 목록 칸
    expect(snapshotOf(editor).rows[3][1]).toBe("채움");
    editor.destroy();
  });

  it("값이 다르면 여전히 연산이다(목록 칸을 실제로 고치는 경우)", () => {
    const { editor, snapshot } = rich();
    expect(planOf(snapshot, [{ type: "cell-set", row: 1, col: 1, value: "a\nc" }]).operations).toHaveLength(1);
    expect(planOf(snapshot, [{ type: "cell-clear", row: 1, col: 1 }]).operations).toHaveLength(1);
    editor.destroy();
  });

  it("값이 같은 연산 뒤에 같은 칸의 진짜 변경이 와도 충돌이 아니다 — 진짜 변경 둘은 충돌이다", () => {
    const { editor, snapshot } = rich();
    expect(planOf(snapshot, [
      { type: "cell-set", row: 3, col: 1, value: "" },
      { type: "cell-set", row: 3, col: 1, value: "채움" },
    ]).operations).toHaveLength(1);
    expect(() => planOf(snapshot, [
      { type: "cell-set", row: 3, col: 1, value: "하나" },
      { type: "cell-set", row: 3, col: 1, value: "둘" },
    ])).toThrow(TableAiPlanError);
    editor.destroy();
  });

  it("범위 밖 · 가려진 칸 같은 잘못된 연산은 값이 같아도 여전히 거부다", () => {
    const scoped = makeEditor(FORM_HTML);
    selectCell(scoped, CELL.name);
    // 선택 범위 밖(0,3) 의 빈 칸에 cell-clear — 값은 같지만 범위 위반이다.
    expect(() => planOf(snapshotOf(scoped), [{ type: "cell-clear", row: 0, col: 3 }])).toThrow(TableAiPlanError);
    scoped.destroy();

    const whole = makeEditor(FORM_HTML);
    caretInCell(whole, CELL.name);
    expect(() => planOf(snapshotOf(whole), [{ type: "cell-clear", row: 1, col: 2 }])).toThrow(TableAiPlanError); // 가려진 빈 칸
    whole.destroy();
  });

  it("단순 표에서도 같다: 값이 같은 cell-set 은 빠지고 id 는 남은 연산 순서로 붙어 적용된다", () => {
    const editor = makeEditor("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    caretInCell(editor, 0);
    const snapshot = extractTableAiSnapshot(editor)!;
    const plan = planOf(snapshot, [
      { type: "cell-set", row: 1, col: 0, value: "1" },
      { type: "cell-set", row: 1, col: 1, value: "9" },
    ]);
    expect(plan.operations.map((op) => op.id)).toEqual(["op-001-cell-set"]);
    expect(applyTableAiPlan(editor, snapshot, plan)).toBe(true);
    expect(extractTableAiSnapshot(editor)?.rows).toEqual([["A", "B"], ["1", "9"]]);
    editor.destroy();
  });

  it("단순 표의 구조 변경 뒤 좌표 기준으로 판정한다(옮긴 행의 현재 값과 같으면 빠진다)", () => {
    const editor = makeEditor("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>");
    caretInCell(editor, 0);
    const snapshot = extractTableAiSnapshot(editor)!;
    // row-move 뒤 row 1 은 "3 | 4" 다 — 그 칸에 "3" 을 쓰는 건 변화가 없다.
    const plan = planOf(snapshot, [{ type: "row-move", from: 2, to: 1 }, { type: "cell-set", row: 1, col: 0, value: "3" }]);
    expect(plan.operations.map((op) => op.type)).toEqual(["row-move"]);
    editor.destroy();
  });
});
