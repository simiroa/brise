import type { ReactNode } from "react";

/**
 * 페이지 맨 위 "하나뿐인" 컨트롤(사용 토글 · 허용 범위 세그먼트) 한 줄 — 카드(.card) 없이 선다.
 * 항목이 하나인 박스는 제목 줄과 본문이 따로 놀아 어정쩡했다(오너 2026-10-28). 동기화·브리핑·펫·AI 기능이 같은 틀을 쓴다.
 * 안쪽 여백은 카드 안 행과 글자 줄이 맞도록 카드 좌우 패딩과 같게 둔다(settingsLayout.css `.settings-page-lead`).
 * 자식은 보통 `SettingsRow` 하나다. 이 부품은 꺼짐 잠금을 하지 않는다 — 켜기 스위치가 꺼졌을 때 페이지 나머지를 어떻게 막는지는 페이지마다 다르다:
 * 동기화는 아래 묶음을 `DisabledGroup`(흐림 + `inert`)으로, 브리핑은 해당 행에 `disabled` + 이유 툴팁으로, AI 기능은 행별 비활성 + `AiOffLink` 안내로,
 * 펫은 PetSection 에서 따로 잠그지 않는다. 한 방식으로 통일할지는 제품 결정이라 코드로 정하지 않았다.
 */
export function PageLead({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="settings-page-lead" data-testid={testId}>
      {children}
    </div>
  );
}
