import { useEffect } from "react";
import { useEditor } from "@tiptap/react";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { IconSpellCheck } from "../icons";
import { ToolbarButton } from "../common/toolbar";

// 맞춤법 밑줄 토글 — 마이크 아이콘 옆. Wave 6-b: nspell/워커/데코레이션 확장 제거, OS/WebView2
// 네이티브 맞춤법 검사(editorProps.attributes.spellcheck, EditorPanel.tsx 기본값 "true")를
// 이 버튼이 DOM 속성으로 직접 켜고 끈다 — 사전 로딩/실패 상태가 없어 스피너·에러 문구도 함께 제거.
//
// 2026-09-20 — 예전엔 이 컴포넌트가 `settings_get_all`/`settings_set` 을 직접 불러 자기만의
// 로컬 state 로 값을 들고 있었다. 설정 > 에디터 페이지(EditorSection.tsx)에 같은 토글을 하나
// 더 두면서(별도 웹뷰) 값을 어느 한쪽이 조용히 놓치지 않게 스토어 simplePref
// (`spellcheckEnabled`)로 승격했다 — 이 창 안에서는 같은 zustand 스토어라 즉시 동기화되고,
// 설정 창과는 여느 simplePref 와 같은 경로(settings_set → "settings-changed" 이벤트 → load()
// 재조회, lib/settingsChanged.ts)로 맞춰진다.
export function SpellcheckToggle({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const enabled = useSettingsStore((s) => s.spellcheckEnabled);
  const setSpellcheckEnabled = useSettingsStore((s) => s.setSpellcheckEnabled);

  // 함정 2: TipTap 인스턴스 수명 — deps 에 editor 가 있으니 에디터가 재생성되면 이 이펙트도
  // 다시 돌지만, 그 사이 destroy 된 옛 인스턴스에 attribute 를 쓰지 않도록 매번 확인한다.
  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.view.dom.setAttribute("spellcheck", String(enabled));
  }, [enabled, editor]);

  const toggle = () => {
    void setSpellcheckEnabled(!enabled);
  };

  const title = t("editor.spellcheck_toggle") || "Spell-check";

  return (
    <ToolbarButton
      onClick={toggle}
      title={title}
      active={enabled ? true : undefined}
      aria-pressed={enabled}
    >
      <IconSpellCheck size={15} strokeWidth={1.9} />
    </ToolbarButton>
  );
}
