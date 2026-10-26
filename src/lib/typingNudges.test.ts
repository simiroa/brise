/** lib/typingNudges.ts 표 기반 단위 테스트 — 유형별 입력→출력 (PLAN-2026-10-07 W1). */
import { describe, it, expect } from "vitest";
import { detectTypingNudges, type TypingNudgeContext } from "./typingNudges";

const REF = new Date(2026, 9, 7, 10, 0, 0);
const REGISTRY = [
  { name: "경주", lat: 35.8, lng: 129.2 },
  { name: "서울", lat: 37.5, lng: 127 },
  { name: "Paris", lat: 48.8, lng: 2.3 },
];
function ctx(over: Partial<TypingNudgeContext> = {}): TypingNudgeContext {
  return {
    uiLang: "ko",
    strict: true,
    registry: REGISTRY,
    ownRegion: null,
    waypointNames: [],
    existingDateRanges: [],
    referenceDate: REF,
    ...over,
  };
}

describe("date", () => {
  it("ko: 커서가 매치 끝 이후면 후보(페이로드·라벨·범위)", () => {
    const text = "내일 오후 3시 치과";
    const r = detectTypingNudges(text, text.length, ctx()).date!;
    expect(r.payload).toMatchObject({ year: 2026, month: 10, day: 8, start_time: "15:00", remind: true, label: "치과" });
    expect(r.label).toMatch(/15:00$/);
    expect([r.matchFrom, r.matchTo]).toEqual([0, 8]);
  });
  it("en 로케일", () => {
    const text = "dentist tomorrow at 3pm";
    const r = detectTypingNudges(text, text.length, ctx({ uiLang: "en" })).date;
    expect(r?.payload.start_time).toBe("15:00");
  });
  it("커서가 매치 끝 앞이면 아직 없음, 끝 정확히면 있음", () => {
    const text = "내일 오후 3시 치과";
    expect(detectTypingNudges(text, 5, ctx()).date).toBeUndefined();
    expect(detectTypingNudges(text, 8, ctx()).date).toBeDefined();
  });
  it("기존 date 마크와 겹치면 제외, 안 겹치면 유지", () => {
    const text = "내일 오후 3시 치과";
    expect(detectTypingNudges(text, text.length, ctx({ existingDateRanges: [[3, 6]] })).date).toBeUndefined();
    expect(detectTypingNudges(text, text.length, ctx({ existingDateRanges: [[9, 12]] })).date).toBeDefined();
  });
  it("확신 낮음(오전/오후 없는 시각)이면 없음", () => {
    const text = "내일 3시 치과";
    expect(detectTypingNudges(text, text.length, ctx()).date).toBeUndefined();
  });
  it("전사문 '내일 아침 8시'", () => {
    const text = "내일 아침 8시";
    expect(detectTypingNudges(text, text.length, ctx()).date?.payload.start_time).toBe("08:00");
  });
  it("빈 문단", () => {
    expect(detectTypingNudges("", 0, ctx())).toEqual({});
  });
});

describe("region", () => {
  it("strict: 경계가 맞으면 첫 매치", () => {
    expect(detectTypingNudges("주말에 경주 여행", 5, ctx()).region?.name).toBe("경주");
  });
  it("strict 는 '경주마' 를 거르고 loose 는 받는다", () => {
    expect(detectTypingNudges("경주마를 봤다", 3, ctx({ strict: true })).region).toBeUndefined();
    expect(detectTypingNudges("경주마를 봤다", 3, ctx({ strict: false })).region?.name).toBe("경주");
  });
  it("대표 지역·경유지는 제외(대소문자·공백 무시)", () => {
    expect(detectTypingNudges("경주 갔다", 2, ctx({ ownRegion: "경주" })).region).toBeUndefined();
    expect(detectTypingNudges("paris trip", 5, ctx({ waypointNames: [" Paris "] })).region).toBeUndefined();
  });
  it("제외된 것 다음 매치로 넘어간다", () => {
    expect(detectTypingNudges("경주 다음 서울", 8, ctx({ ownRegion: "경주" })).region?.name).toBe("서울");
  });
  it("레지스트리가 비면 없음", () => {
    expect(detectTypingNudges("경주", 2, ctx({ registry: [] })).region).toBeUndefined();
  });
});

describe("url", () => {
  const cases: Array<[string, string | undefined]> = [
    ["https://example.com/a", "https://example.com/a"],
    ["이거 봐 https://example.com/a 재밌음", "https://example.com/a"],
    ["끝에 마침표 https://example.com/a.", "https://example.com/a"],
    ["http://example.com", "http://example.com"],
    ["https://example.com/doc.pdf", undefined],
    ["https://example.com/pic.png", undefined],
    ["ftp://example.com/a", undefined],
    ["abchttps://example.com", undefined],
    ["링크 없음", undefined],
    ["https://x.com/doc.pdf 그리고 https://y.com/page", "https://y.com/page"],
  ];
  it.each(cases)("%s", (text, want) => {
    expect(detectTypingNudges(text, text.length, ctx()).url).toBe(want);
  });
});

describe("tagQuery", () => {
  const cases: Array<[string, number | null, { query: string; from: number; to: number } | undefined]> = [
    ["#회", null, { query: "회", from: 0, to: 2 }],
    ["오늘 #회의", null, { query: "회의", from: 3, to: 6 }],
    ["#", null, { query: "", from: 0, to: 1 }],
    ["오늘 #", null, { query: "", from: 3, to: 4 }],
    ["#회의 ", null, undefined], // 공백으로 토큰이 끝났다
    ["abc#회의", null, undefined], // 공백·문단 시작 뒤가 아니다
    ["회의", null, undefined],
    ["#회의 내용", 2, { query: "회", from: 0, to: 2 }], // 커서가 토큰 안 — 커서 앞까지만
    ["##", null, undefined],
  ];
  it.each(cases)("%s", (text, caret, want) => {
    expect(detectTypingNudges(text, caret ?? text.length, ctx()).tagQuery).toEqual(want);
  });
});
