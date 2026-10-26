// 접근성 자동 점검 — axe-core 를 jsdom 컨테이너에 돌려 violation 이 있으면 읽기 좋은 메시지로 실패시킨다.
import axe from "axe-core";

// jsdom 은 레이아웃·페인트가 없어 아래 규칙은 결과를 신뢰할 수 없다(항상 불가/오탐):
//  - color-contrast: 계산된 색·배경 합성이 jsdom 에서 불완전
//  - region / landmark-*: 컴포넌트 단위 조각 렌더라 페이지 랜드마크가 없는 게 정상
//  - scrollable-region-focusable: 스크롤 크기를 jsdom 이 계산하지 못한다
const DISABLED = ["color-contrast", "region", "scrollable-region-focusable", "landmark-one-main", "page-has-heading-one"];

export async function expectNoA11yViolations(container: Element, opts: { disable?: string[] } = {}): Promise<void> {
  const rules = Object.fromEntries([...DISABLED, ...(opts.disable ?? [])].map((id) => [id, { enabled: false }]));
  const { violations } = await axe.run(container as axe.ElementContext, { rules });
  if (violations.length === 0) return;
  const msg = violations
    .map((v) => `[${v.id}] ${v.help} (${v.impact})\n` + v.nodes.map((n) => `    ${n.html.slice(0, 140)}\n    -> ${n.failureSummary?.replace(/\n/g, " ")}`).join("\n"))
    .join("\n");
  throw new Error(`접근성 위반 ${violations.length}건\n${msg}`);
}
