/**
 * `/` 컨텍스트 드롭 메뉴 — 고른 것은 문장이 아니라 **프롬프트 상자 위의 줄**에 더해진다
 * (PLAN-2026-09-15 §7 D16). 그룹: 이 노트 · 노트북 · 바깥.
 *
 * editor/suggestionPopup.tsx 의 `createSuggestionRender` 를 그대로 쓰지 않는 이유 셋: 항목이
 * 그룹으로 묶여야 하고, 바깥 클릭에 닫혀야 하며(그쪽은 Escape 만), 닫을 때 플러그인에 exit 메타를
 * 보내 상태까지 꺼야 한다(pluginKey 가 필요). 위치 계산·body 포탈 방식은 그 파일과 같다 —
 * backdrop-filter 조상이 fixed 의 containing block 이 되는 문제(그 파일 헤더 참조).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { flipMenuPos } from "../../../lib/ui";
import { t } from "../../../i18n/t";

export interface CtxItem {
  id: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  /** 회색 보조 문구("1,846자", "선택 없음", "추가됨"). */
  meta?: string;
  /** 그룹 제목 — 같은 문자열끼리 묶여 그려진다. */
  group: string;
  disabled?: boolean;
  /** 고르면 부를 것. `/` 는 그 전에 지워진다. 컨텍스트 줄에 더하거나 픽커를 연다. */
  action: () => void;
}

export const SLASH_PLUGIN_KEY = new PluginKey("askAiSlash");

export function filterCtxItems(items: CtxItem[], query: string): CtxItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
}

interface ListRef {
  onKeyDown: (p: SuggestionKeyDownProps) => boolean;
}

const CtxMenuList = forwardRef<ListRef, { items: CtxItem[]; command: (item: CtxItem) => void }>(
  ({ items, command }, ref) => {
    const enabled = useMemo(() => items.filter((i) => !i.disabled), [items]);
    const [selected, setSelected] = useState(0);
    useEffect(() => setSelected((s) => Math.min(s, Math.max(0, enabled.length - 1))), [enabled]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.isComposing || !enabled.length) return false;
        if (event.key === "ArrowDown") { setSelected((s) => (s + 1) % enabled.length); return true; }
        if (event.key === "ArrowUp") { setSelected((s) => (s - 1 + enabled.length) % enabled.length); return true; }
        if (event.key === "Enter") { command(enabled[selected]); return true; }
        return false;
      },
    }));

    if (!items.length) {
      return <div className="askai-slash-menu__empty">{t("ai.composer_slash_empty")}</div>;
    }
    const groups = [...new Set(items.map((i) => i.group))];
    return (
      <div role="listbox" className="askai-slash-menu__list">
        {groups.map((g) => (
          <React.Fragment key={g}>
            <div className="askai-slash-menu__group">{g}</div>
            {items.filter((i) => i.group === g).map((item) => {
              const idx = enabled.indexOf(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={idx === selected}
                  aria-disabled={item.disabled || undefined}
                  data-selected={idx === selected}
                  disabled={item.disabled}
                  className="menu-row menu-item askai-slash-menu__item"
                  onMouseEnter={() => idx >= 0 && setSelected(idx)}
                  onClick={() => !item.disabled && command(item)}
                >
                  <item.icon size={14} strokeWidth={1.8} />
                  <span>{item.label}</span>
                  {item.meta ? <span className="askai-slash-menu__meta">{item.meta}</span> : null}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    );
  },
);
CtxMenuList.displayName = "CtxMenuList";

function render() {
  let component: ReactRenderer<ListRef> | null = null;
  let popup: HTMLDivElement | null = null;
  let editor: Editor | null = null;

  const onPointerDown = (e: PointerEvent) => {
    const el = e.target as Node | null;
    if (!popup || !editor || popup.contains(el) || editor.view.dom.contains(el)) return;
    editor.view.dispatch(editor.state.tr.setMeta(SLASH_PLUGIN_KEY, { exit: true }));
  };

  const reposition = (clientRect: SuggestionProps<CtxItem>["clientRect"]) => {
    const rect = clientRect?.();
    if (!popup || !rect) return;
    const { width, height } = popup.getBoundingClientRect();
    const { x, y } = flipMenuPos(rect.left, rect.bottom + 6, width, height, 8, rect.top - 6);
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
  };

  return {
    onStart: (props: SuggestionProps<CtxItem>) => {
      editor = props.editor;
      component = new ReactRenderer(CtxMenuList, { props, editor: props.editor });
      popup = document.createElement("div");
      popup.className = "overlay askai-slash-menu";
      popup.appendChild(component.element);
      document.body.appendChild(popup);
      document.addEventListener("pointerdown", onPointerDown, true);
      reposition(props.clientRect);
    },
    onUpdate: (props: SuggestionProps<CtxItem>) => {
      component?.updateProps(props);
      reposition(props.clientRect);
    },
    onKeyDown: (props: SuggestionKeyDownProps) => component?.ref?.onKeyDown(props) ?? false,
    onExit: () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      popup?.remove();
      component?.destroy();
      popup = null;
      component = null;
      editor = null;
    },
  };
}

export interface SlashOptions {
  /** 매번 호출 — 컴포저가 ref 로 최신 항목을 준다. */
  getItems: () => CtxItem[];
}

export const SlashCtx = Extension.create<SlashOptions>({
  name: "askAiSlash",
  // 제출 키맵(Enter)보다 먼저 키를 받아야 메뉴가 열린 상태의 Enter 가 항목 선택이 된다.
  priority: 1000,

  addOptions() {
    return { getItems: () => [] };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<CtxItem>({
        editor: this.editor,
        char: "/",
        pluginKey: SLASH_PLUGIN_KEY,
        items: ({ query }) => filterCtxItems(this.options.getItems(), query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: CtxItem }) => {
          editor.chain().focus().deleteRange(range).run();
          props.action();
        },
        render,
      }),
    ];
  },
});
