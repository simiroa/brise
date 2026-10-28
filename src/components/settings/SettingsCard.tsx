import type { ReactNode } from "react";
import { SectionHeader } from "./SectionHeader";
import { anchorId } from "./settingsAnchor";
import { groupCardStyle } from "./shared";

interface SettingsCardProps {
  title: string;
  /** 카드 아이콘 배지 — `SectionHeader` 가 `IconChip 24` 로 감싼다(아이콘은 14 로 준다). */
  icon?: ReactNode;
  hint?: string;
  badge?: ReactNode;
  /** 제목 줄 오른쪽의 액션 묶음(마스터 토글·단추) — `SectionHeader` 와 같은 계약. */
  actions?: ReactNode;
  /** 설정 검색·딥링크 앵커 이름(settingsSearchIndex.ts 의 anchor) — 카드 루트 id 가 된다. */
  anchor?: string;
  testId?: string;
  children: ReactNode;
}

/**
 * 설정 카드 한 장 — `.card` + `groupCardStyle` + 첫 자식 `SectionHeader` + 앵커 id 를 한 곳이 갖는다.
 * 예전엔 카드마다 `<div className="card" style={groupCardStyle}>` 아래 `<SectionHeader/>` 를 손으로 맞췄고, 제목이 박스 밖으로 올라가는
 * 규칙(settingsLayout.css `.card > .settings-section-header:first-child`)은 **헤더가 카드의 첫 자식**이라는 암묵적 약속에 기댔다.
 * 여기서는 헤더가 항상 첫 자식이라 그 약속이 이 부품 안에서 지켜진다. DOM 은 손으로 쓰던 것과 똑같다(래퍼를 더하지 않는다).
 *
 * 헤더 없이 카드만 필요하거나(제목이 카드 안 다른 줄에 있는 곳), 카드 스타일을 확장해야 하는 곳(드래그 윤곽선·접힘 표시)은 이 부품을 쓰지 않는다.
 */
export function SettingsCard({ title, icon, hint, badge, actions, anchor, testId, children }: SettingsCardProps) {
  return (
    <div className="card" style={groupCardStyle} id={anchor ? anchorId(anchor) : undefined} data-testid={testId}>
      <SectionHeader title={title} icon={icon} hint={hint} badge={badge} actions={actions} />
      {children}
    </div>
  );
}
