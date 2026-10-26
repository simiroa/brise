import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * from..to 범위 안의 link 마크가 가리키는 http(s) 주소를 **문서 순서대로, 중복 없이** 모은다.
 * 선택 영역 우클릭에서 "선택 안의 링크 N개" 를 세는 유일한 판정 지점이다
 * (editor/SelectionContextMenu.tsx → common/LinkNudge.tsx).
 *
 * note:// 위키링크는 제외한다 — 앱 안에서 이동하는 링크이고 가져올 원격 본문이 없다. 판정 기준은
 * lib/urls.ts 의 스킴 규칙과 같아야 하므로 http(s) 로 자른다(그쪽은 확장자까지 더 본다).
 */
export function linkHrefsInRange(doc: PMNode, from: number, to: number): string[] {
  const out: string[] = [];
  doc.nodesBetween(from, to, (node) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "link") continue;
      const href = typeof mark.attrs.href === "string" ? mark.attrs.href : "";
      // N 은 사람이 한 선택 안의 링크 수라 작다 — Set 대신 includes 로 순서를 지킨다.
      if (/^https?:\/\//i.test(href) && !out.includes(href)) out.push(href);
    }
  });
  return out;
}
