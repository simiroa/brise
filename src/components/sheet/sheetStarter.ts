import { emptySheet, serializeSheet } from "../../lib/sheet/types";

/** "시트" 프리셋 / "+" 새 섹션 메뉴 — 아무것도 없는 격자. */
export function createEmptySheetJson(): string {
  return serializeSheet(emptySheet());
}

/**
 * 가계부 템플릿:
 * 열: 날짜(date), 항목(text), 카테고리(text), 금액(currency), 메모(text)
 * 행: 예시 데이터 2행 + 합계 행
 */
export function createBudgetSheetJson(): string {
  const doc = emptySheet();
  doc.cols = [
    { w: 110, fmt: "date" },
    { w: 140, fmt: "text" },
    { w: 100, fmt: "text" },
    { w: 110, fmt: "currency", dp: 0 },
    { w: 160, fmt: "text" },
  ];
  doc.cells = {
    A1: { raw: "날짜" },
    B1: { raw: "항목" },
    C1: { raw: "카테고리" },
    D1: { raw: "금액" },
    E1: { raw: "메모" },
    A2: { raw: "2026-08-19" },
    B2: { raw: "점심 식사" },
    C2: { raw: "식비" },
    D2: { raw: "12000" },
    E2: { raw: "" },
    A3: { raw: "2026-08-19" },
    B3: { raw: "커피" },
    C3: { raw: "카페" },
    D3: { raw: "4500" },
    E3: { raw: "" },
    C4: { raw: "합계" },
    D4: { raw: "=SUM(D2:D3)" },
  };
  return serializeSheet(doc);
}

export function createScheduleSheetJson(): string {
  const doc = emptySheet();
  doc.cols = [
    { w: 90, fmt: "text" },
    { w: 120, fmt: "text" },
    { w: 120, fmt: "text" },
    { w: 120, fmt: "text" },
    { w: 120, fmt: "text" },
    { w: 120, fmt: "text" },
  ];
  doc.cells = {
    A1: { raw: "시간" },
    B1: { raw: "월" },
    C1: { raw: "화" },
    D1: { raw: "수" },
    E1: { raw: "목" },
    F1: { raw: "금" },
    A2: { raw: "09:00" },
    B2: { raw: "주간 회의" },
    C2: { raw: "기획 검토" },
    D2: { raw: "디자인 리뷰" },
    E2: { raw: "개발 스프린트" },
    F2: { raw: "주간 회고" },
    A3: { raw: "14:00" },
    B3: { raw: "팀 미팅" },
    C3: { raw: "자료 작성" },
    D3: { raw: "QA 테스트" },
    E3: { raw: "배포 준비" },
    F3: { raw: "정리" },
  };
  return serializeSheet(doc);
}

export function createTrackerSheetJson(): string {
  const doc = emptySheet();
  doc.cols = [
    { w: 160, fmt: "text" },
    { w: 100, fmt: "text" },
    { w: 110, fmt: "date" },
    { w: 90, fmt: "text" },
    { w: 90, fmt: "text" },
  ];
  doc.cells = {
    A1: { raw: "작업명" },
    B1: { raw: "담당자" },
    C1: { raw: "마감일" },
    D1: { raw: "상태" },
    E1: { raw: "우선순위" },
    A2: { raw: "로그인 화면 개선" },
    B2: { raw: "홍길동" },
    C2: { raw: "2026-09-10" },
    D2: { raw: "진행중" },
    E2: { raw: "높음" },
    A3: { raw: "데이터 백업" },
    B3: { raw: "이순신" },
    C3: { raw: "2026-09-15" },
    D3: { raw: "대기" },
    E3: { raw: "보통" },
  };
  return serializeSheet(doc);
}
