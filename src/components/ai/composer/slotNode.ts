/**
 * 슬롯 인라인 노드 — `[영어]`·`[5]` 처럼 프리셋이 비워 둔 값(PLAN-2026-09-15 D5).
 *
 * 편집 방식(결정): 슬롯은 **본문을 가진 인라인 노드**(`content: "text*"`)다. 값 = 노드의 텍스트.
 * - `n`·`text` 는 칩 안에 캐럿을 두고 그냥 타이핑한다. "첫 키에서 슬롯을 일반 텍스트로 풀기"
 *   대안은 키 가로채기 코드가 필요하고, 풀리는 순간 `serialize().slots` 와 D6 `custom` 판정에서
 *   슬롯이 사라져 dispatch 가 값을 잃는다. 노드 본문을 편집하면 키 처리 0줄이고 슬롯 정체가 남는다.
 * - `lang`·`tone` 은 클릭 → 픽커(AskAiComposer.tsx `handleClickOn`)가 본문을 통째로 바꾼다.
 *   타이핑도 막지 않는다 — 직렬화는 어차피 텍스트를 보낸다.
 * 값이 비면 CSS `:empty::before{content:attr(data-ph)}` 가 placeholder 를 그린다.
 */
import { Node, mergeAttributes } from "@tiptap/core";

export const SLOT_NODE = "slot";

export const SlotNode = Node.create({
  name: SLOT_NODE,
  group: "inline",
  inline: true,
  content: "text*",
  // 캐럿이 칩 경계에서 밖으로 새지 않게 — Backspace 로 값을 다 지워도 빈 칩이 남는다.
  isolating: true,
  selectable: true,

  addAttributes() {
    return {
      key: { default: "" },
      kind: { default: "text" },
      ph: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span.askai-slot" }];
  },

  renderHTML({ HTMLAttributes }) {
    const { key, kind, ph, ...rest } = HTMLAttributes as Record<string, string | null>;
    return [
      "span",
      mergeAttributes(rest, {
        class: "askai-slot",
        "data-key": key,
        "data-kind": kind,
        "data-ph": ph ?? undefined,
      }),
      0,
    ];
  },
});
