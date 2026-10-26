/**
 * 2026-10-07 S2 QA — 전사문 "내일 아침 8시" 가 날짜 후보를 못 냈던 결함(ko 파서가 오전/오후만 알고
 * 아침·저녁 같은 구어 시간대 낱말을 몰라 confidence:low 로 떨어졌다)의 회귀 테스트.
 * 폰 전사 경로(dateCandidateFromText)까지 같이 확인한다.
 */
import { describe, it, expect } from "vitest";
import { parseNlDate } from "./index";
import { dateCandidateFromText } from "../../mobile/mobileInputFlows";

const REF = new Date(2026, 9, 7, 10, 0, 0); // 2026-10-07 10:00

describe("ko 시간대 낱말", () => {
  const cases: Array<[string, string | null, "high" | "low"]> = [
    ["내일 아침 8시", "08:00", "high"],
    ["내일 아침 8시에 회의가 있어요", "08:00", "high"],
    ["내일 저녁 7시에 만나요", "19:00", "high"],
    ["내일 새벽 6시", "06:00", "high"],
    ["내일 점심 12시", "12:00", "high"],
    ["오늘 밤 11시", "23:00", "high"],
    ["내일 밤 12시", "00:00", "high"],
    ["내일 밤 2시", "02:00", "high"],
    ["내일 아침 12시", null, "low"], // 말이 안 되는 조합은 추측하지 않는다
    ["내일 8시", null, "low"], // 낱말도 오전/오후도 없으면 여전히 모호
    ["내일 오전 8시", "08:00", "high"],
  ];
  it.each(cases)("%s", (text, time, conf) => {
    const r = parseNlDate(text, "ko", REF);
    expect(r?.startTime ?? null).toBe(time);
    expect(r?.confidence).toBe(conf);
  });

  it("matchRange 가 시간대 낱말까지 덮고 제목에서 빠진다", () => {
    const r = parseNlDate("내일 아침 8시에 회의가 있어요", "ko", REF)!;
    expect(r.matchRange).toEqual([0, 8]);
    expect(r.title).toBe("회의가 있어요");
  });

  it("전사 경로 dateCandidateFromText 가 후보를 낸다", () => {
    const c = dateCandidateFromText("내일 아침 8시에 회의가 있어요", "ko");
    expect(c?.payload.start_time).toBe("08:00");
    expect(c?.label).toMatch(/08:00$/);
  });

  // 지속 시간("N시간")의 '시' 를 시각으로 읽으면 안 된다 — 시간대 낱말·오전/오후와 붙어도 마찬가지.
  it.each(["저녁 3시간 공부했다", "오늘 밤 2시간 잤다", "점심 1시간 걸림", "오후 3시간 회의"])("지속 시간은 시각이 아니다: %s", (text) => {
    const r = parseNlDate(text, "ko", REF);
    expect(r?.startTime ?? null).toBeNull();
  });
});
