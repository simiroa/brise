import type { ReactNode } from "react";
import { SectionHeader } from "./SectionHeader";
import { anchorId } from "./settingsAnchor";

/**
 * 설정 페이지의 "표 블록" 한 벌 — 제목 행(SectionHeader) + 표(SettingsTable) 를 **카드 밖** 페이지 최상위에
 * 세운다(오너 R1: 표는 카드에 넣지 않는다). 달력 및 일정의 공휴일·기념일·반복 일정, 브리핑의 습관·반복 일정이
 * 이걸 쓴다 — 제목은 카드와 같은 SectionHeader(아이콘 칩 + 크기), 간격은 제목 아래 `--space-4` +
 * 표 위 `--space-4` 로 블록마다 같다. 제목과 표 사이에 도구 줄을 끼우는 블록은 그 줄에 위쪽
 * `--space-4` 만 준다(DayMarksSection).
 *
 * `anchor` 는 딥링크 이름 — id 는 settingsAnchor.anchorId 규칙으로 만든다(손으로 적지 않는다).
 */
export function TableSection({
  anchor,
  title,
  hint,
  icon,
  actions,
  children,
  "data-testid": testId,
}: {
  anchor?: string;
  title: string;
  hint?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div id={anchor ? anchorId(anchor) : undefined} data-testid={testId}>
      <SectionHeader title={title} hint={hint} icon={icon} actions={actions} />
      {children}
    </div>
  );
}
