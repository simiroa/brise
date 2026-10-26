import { createContext, useContext, useEffect } from "react";

/** 설정 딥링크 앵커(`settings_window_open({page, anchor})`). SettingsPanel 이 도착 시 세우고 스크롤이 끝나면 지운다. */
export interface SettingsAnchor {
  name: string;
}

export const SettingsAnchorContext = createContext<SettingsAnchor | null>(null);

/** 블록 id — 스크롤 대상. 앵커 이름과 이 규칙이 같은 한 곳. */
export const anchorId = (name: string) => `settings-anchor-${name}`;

/** 앵커가 `name` 일 때 1회 `fn` 을 부른다(예: 추가 폼 열기). 패널이 스크롤 뒤 앵커를 지우므로 닫은 폼은 다시 안 열린다. */
export function useSettingsAnchorOnce(name: string, fn: () => void): void {
  const a = useContext(SettingsAnchorContext);
  useEffect(() => {
    if (a?.name === name) fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, name]);
}
