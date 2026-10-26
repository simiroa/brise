import { describe, it, expect } from "vitest";
import {
  normalizeIsoDate,
  extractDateFromTaskText,
  parseInlineTasksFromMarkdown,
  getTasksForDate,
  parseTasksFromSections,
  toggleInlineTaskInMarkdown,
  maskHtmlTables,
} from "./inlineSchedule";
import { mdSerializeHtml } from "./mdSerialize";

describe("inlineSchedule", () => {
  describe("normalizeIsoDate", () => {
    it("normalizes YYYY-MM-DD format", () => {
      expect(normalizeIsoDate("2026-08-30")).toBe("2026-08-30");
      expect(normalizeIsoDate("2026-8-5")).toBe("2026-08-05");
    });

    it("normalizes YYYY.MM.DD and YYYY/MM/DD formats", () => {
      expect(normalizeIsoDate("2026.08.30")).toBe("2026-08-30");
      expect(normalizeIsoDate("2026/8/9")).toBe("2026-08-09");
    });

    it("returns null for invalid date strings", () => {
      expect(normalizeIsoDate("invalid")).toBeNull();
      expect(normalizeIsoDate("2026-13-40")).toBeNull();
      expect(normalizeIsoDate("99-01-01")).toBeNull();
    });
  });

  describe("extractDateFromTaskText", () => {
    it("extracts due bracket format: [due:2026-08-30]", () => {
      const res = extractDateFromTaskText("프로젝트 계획서 제출 [due:2026-08-30]");
      expect(res.date).toBe("2026-08-30");
      expect(res.cleanText).toBe("프로젝트 계획서 제출");
    });

    it("extracts due colon format: due: 2026-08-30", () => {
      const res = extractDateFromTaskText("세금 계산서 발행 due: 2026-08-30");
      expect(res.date).toBe("2026-08-30");
      expect(res.cleanText).toBe("세금 계산서 발행");
    });

    it("extracts @date format: @2026-08-30", () => {
      const res = extractDateFromTaskText("@2026-08-30 팀 미팅 준비");
      expect(res.date).toBe("2026-08-30");
      expect(res.cleanText).toBe("팀 미팅 준비");
    });

    it("extracts emoji format: 📅 2026-08-30", () => {
      const res = extractDateFromTaskText("병원 예약 📅 2026-08-30");
      expect(res.date).toBe("2026-08-30");
      expect(res.cleanText).toBe("병원 예약");
    });

    it("extracts plain date at beginning or middle", () => {
      const res = extractDateFromTaskText("2026-08-30 중요한 일정");
      expect(res.date).toBe("2026-08-30");
      expect(res.cleanText).toBe("중요한 일정");
    });

    it("returns null date when no date is present", () => {
      const res = extractDateFromTaskText("날짜 없는 일반 할 일");
      expect(res.date).toBeNull();
      expect(res.cleanText).toBe("날짜 없는 일반 할 일");
    });
  });

  describe("parseInlineTasksFromMarkdown", () => {
    it("parses diverse checklist date patterns in markdown", () => {
      const md = `
# 프로젝트 노트

- [ ] 2026-08-30 시작 태스크
- [ ] @2026-08-30 멘션 태스크
- [x] 2026-08-30 완료된 일
- [X] 2026-08-30 대문자 완료 태스크
- [ ] 할 일 [due:2026-08-30]
- [ ] 할 일 (due: 2026-08-31)
* [ ] 2026-09-01 별표 리스트
1. [ ] 2026-09-02 숫자 리스트
- [ ] 날짜 없는 체크리스트
일반 텍스트 2026-08-30 (체크리스트 아님)
      `.trim();

      const tasks = parseInlineTasksFromMarkdown(md, "note-1", "프로젝트 노트", "sec-1");

      expect(tasks).toHaveLength(8);

      expect(tasks[0]).toEqual({
        id: "note-1:sec-1:0",
        noteId: "note-1",
        noteTitle: "프로젝트 노트",
        sectionId: "sec-1",
        lineIndex: 0,
        text: "시작 태스크",
        rawText: "2026-08-30 시작 태스크",
        completed: false,
        date: "2026-08-30",
      });

      expect(tasks[1]).toEqual({
        id: "note-1:sec-1:1",
        noteId: "note-1",
        noteTitle: "프로젝트 노트",
        sectionId: "sec-1",
        lineIndex: 1,
        text: "멘션 태스크",
        rawText: "@2026-08-30 멘션 태스크",
        completed: false,
        date: "2026-08-30",
      });

      expect(tasks[2]).toEqual({
        id: "note-1:sec-1:2",
        noteId: "note-1",
        noteTitle: "프로젝트 노트",
        sectionId: "sec-1",
        lineIndex: 2,
        text: "완료된 일",
        rawText: "2026-08-30 완료된 일",
        completed: true,
        date: "2026-08-30",
      });

      expect(tasks[3].completed).toBe(true);
      expect(tasks[3].text).toBe("대문자 완료 태스크");

      expect(tasks[4].completed).toBe(false);
      expect(tasks[4].text).toBe("할 일");
      expect(tasks[4].date).toBe("2026-08-30");

      expect(tasks[5].date).toBe("2026-08-31");
      expect(tasks[6].date).toBe("2026-09-01");
      expect(tasks[7].date).toBe("2026-09-02");
    });

    it("parses HTML TaskItem content", () => {
      const html = `
        <ul data-type="taskList">
          <li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>2026-08-30 HTML 태스크 1</p></div></li>
          <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>완료 태스크 [due: 2026-08-30]</p></div></li>
          <li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>날짜 없는 태스크</p></div></li>
        </ul>
      `;

      const tasks = parseInlineTasksFromMarkdown(html, "note-2", "HTML 노트");
      expect(tasks).toHaveLength(2);
      expect(tasks[0].completed).toBe(false);
      expect(tasks[0].text).toBe("HTML 태스크 1");
      expect(tasks[0].date).toBe("2026-08-30");
      expect(tasks[0].lineIndex).toBe(0);

      expect(tasks[1].completed).toBe(true);
      expect(tasks[1].text).toBe("완료 태스크");
      expect(tasks[1].date).toBe("2026-08-30");
      expect(tasks[1].lineIndex).toBe(1);
    });

    it("returns empty array for empty or whitespace content", () => {
      expect(parseInlineTasksFromMarkdown("", "n", "t")).toEqual([]);
      expect(parseInlineTasksFromMarkdown("   \n  \n", "n", "t")).toEqual([]);
    });
  });

  describe("getTasksForDate", () => {
    it("filters tasks matching target date", () => {
      const sampleTasks = [
        {
          id: "1",
          noteId: "n1",
          noteTitle: "A",
          lineIndex: 0,
          text: "Task 1",
          rawText: "Task 1",
          completed: false,
          date: "2026-08-30",
        },
        {
          id: "2",
          noteId: "n1",
          noteTitle: "A",
          lineIndex: 1,
          text: "Task 2",
          rawText: "Task 2",
          completed: true,
          date: "2026-08-31",
        },
        {
          id: "3",
          noteId: "n2",
          noteTitle: "B",
          lineIndex: 0,
          text: "Task 3",
          rawText: "Task 3",
          completed: false,
          date: "2026-08-30",
        },
      ];

      const forAug30 = getTasksForDate(sampleTasks, "2026-08-30");
      expect(forAug30).toHaveLength(2);
      expect(forAug30.map((t) => t.id)).toEqual(["1", "3"]);

      const forAug31 = getTasksForDate(sampleTasks, "2026-08-31");
      expect(forAug31).toHaveLength(1);
      expect(forAug31[0].id).toBe("2");

      const forSep01 = getTasksForDate(sampleTasks, "2026-09-01");
      expect(forSep01).toHaveLength(0);
    });
  });

  describe("parseTasksFromSections", () => {
    it("extracts tasks across multiple sections", () => {
      const sections = [
        { id: "s1", body_md: "- [ ] 2026-08-30 섹션1 태스크" },
        { id: "s2", body_md: "- [x] 2026-08-30 섹션2 태스크" },
      ];

      const tasks = parseTasksFromSections(sections, "note-multi", "멀티 섹션 노트");
      expect(tasks).toHaveLength(2);
      expect(tasks[0].sectionId).toBe("s1");
      expect(tasks[0].completed).toBe(false);
      expect(tasks[1].sectionId).toBe("s2");
      expect(tasks[1].completed).toBe(true);
    });
  });

  describe("toggleInlineTaskInMarkdown", () => {
    it("toggles GFM checklist item at lineIndex", () => {
      const original = [
        "- [ ] 첫 번째",
        "- [ ] 2026-08-30 두 번째",
        "- [x] 세 번째",
      ].join("\n");

      // Toggle index 1 (false -> true)
      const toggled1 = toggleInlineTaskInMarkdown(original, 1);
      expect(toggled1).toContain("- [x] 2026-08-30 두 번째");
      expect(toggled1).toContain("- [ ] 첫 번째");

      // Toggle index 2 (true -> false)
      const toggled2 = toggleInlineTaskInMarkdown(original, 2);
      expect(toggled2).toContain("- [ ] 세 번째");
    });

    it("toggles HTML TaskItem at lineIndex", () => {
      const originalHtml = `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>2026-08-30 태스크</p></div></li>`;
      const toggled = toggleInlineTaskInMarkdown(originalHtml, 0, true);
      expect(toggled).toContain('data-checked="true"');
      expect(toggled).toContain('checked="checked"');
    });
  });
});

// W0 검증 결함: 셀 안 체크리스트가 든 조각 표(generateHTML 의 속성 순서는 data-checked 가 먼저)가 같은 섹션의
// 정상 GFM 할 일을 통째로 지웠다 — 스캐너가 `data-type="taskItem"` 한 줄만 보고 HTML 전용 모드로 넘어갔다.
describe("inlineSchedule — 표 조각 안 체크리스트", () => {
  /** 병합 헤더(→ 조각 표) + 셀 안 체크리스트가 든 표를 실제 저장 경로로 직렬화한다. */
  const cellChecklistTable = mdSerializeHtml(
    `<table><tr><th colspan="2">제목</th></tr><tr><td><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>마감</p></div></li></ul></td><td>x</td></tr></table>`,
  );
  const body = `- [ ] 2026-10-08 보고서\n- [x] 2026-10-09 회의\n\n${cellChecklistTable}\n\n- [ ] 2026-10-10 마무리`;

  it("전제: 조각 표가 data-checked 먼저인 taskItem 을 담고 있다", () => {
    expect(cellChecklistTable).toMatch(/^<table/);
    expect(cellChecklistTable).toContain('data-type="taskItem"');
    expect(cellChecklistTable).toMatch(/<li data-checked="false" data-type="taskItem"/);
  });

  it("표 밖 GFM 할 일이 그대로 파싱된다(표 안 항목은 세지 않는다)", () => {
    const tasks = parseInlineTasksFromMarkdown(body, "n", "노트", "s");
    expect(tasks.map((t) => [t.text, t.date, t.completed, t.lineIndex])).toEqual([
      ["보고서", "2026-10-08", false, 0],
      ["회의", "2026-10-09", true, 1],
      ["마무리", "2026-10-10", false, 2],
    ]);
  });

  it("표 밖 GFM 할 일이 토글되고 표 조각은 한 글자도 안 바뀐다", () => {
    const toggled = toggleInlineTaskInMarkdown(body, 0);
    expect(toggled).toContain("- [x] 2026-10-08 보고서");
    expect(toggled.replace("- [x] 2026-10-08 보고서", "- [ ] 2026-10-08 보고서")).toBe(body);
    expect(toggleInlineTaskInMarkdown(body, 2)).toContain("- [x] 2026-10-10 마무리");
    expect(toggleInlineTaskInMarkdown(body, 3)).toBe(body); // 표 안 항목은 번호가 없다
  });

  it("옛 HTML 본문에서도 표 셀 안 항목은 세지 않고, 최상위 항목만 순서대로 센다", () => {
    const item = (checked: string, text: string) =>
      `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"></label><div><p>${text}</p></div></li>`;
    const html =
      `<ul data-type="taskList">${item("false", "2026-08-30 가")}</ul>` +
      `<table><tr><td><ul data-type="taskList">${item("false", "2026-08-31 셀")}</ul></td></tr></table>` +
      `<ul data-type="taskList">${item("false", "2026-09-01 나")}</ul>`;
    const tasks = parseInlineTasksFromMarkdown(html, "n", "t");
    expect(tasks.map((t) => [t.text, t.lineIndex])).toEqual([
      ["가", 0],
      ["나", 1],
    ]);
    const toggled = toggleInlineTaskInMarkdown(html, 1, true);
    expect(toggled.match(/data-checked="true"/g)).toHaveLength(1);
    // 켜진 것은 표 뒤 두 번째 최상위 항목이다(표 셀 안 항목이 아니다).
    expect(toggled.indexOf('data-checked="true"')).toBeGreaterThan(toggled.indexOf("</table>"));
    expect(toggled).toContain('checked="checked"');
  });

  describe("maskHtmlTables", () => {
    it("표를 같은 길이의 공백으로 가리고 줄바꿈은 남긴다", () => {
      const src = "a\n<table>\n<tr><td>한글</td></tr>\n</table>\nb";
      const out = maskHtmlTables(src);
      expect(out).toHaveLength(src.length);
      expect(out).toBe(
        "a\n" + " ".repeat("<table>".length) + "\n" + " ".repeat("<tr><td>한글</td></tr>".length) + "\n" + " ".repeat("</table>".length) + "\nb",
      );
    });

    it("중첩 표는 바깥 표가 닫힐 때까지 한 덩어리로 가린다", () => {
      const src = "x<table><tr><td><table><tr><td>in</td></tr></table>tail</td></tr></table>y";
      expect(maskHtmlTables(src)).toBe("x" + " ".repeat(src.length - 2) + "y");
    });

    it("안 닫힌 표·짝 없는 닫는 태그·<tablet 같은 다른 태그는 건드리지 않고, 대소문자는 가리지 않는다", () => {
      expect(maskHtmlTables("a <table><tr> b")).toBe("a <table><tr> b");
      expect(maskHtmlTables("a </table> b")).toBe("a </table> b");
      expect(maskHtmlTables("a <tablet>x</tablet> b")).toBe("a <tablet>x</tablet> b");
      expect(maskHtmlTables("대소문자 <TABLE class=a>x</TABLE>!")).toBe(
        "대소문자 " + " ".repeat("<TABLE class=a>x</TABLE>".length) + "!",
      );
    });

    it("표가 없으면 같은 문자열을 돌려준다", () => {
      const src = "- [ ] a\n- [x] b";
      expect(maskHtmlTables(src)).toBe(src);
    });
  });
});
