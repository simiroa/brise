/**
 * 내보내기의 각주 — 본문 `[n]` + 문서 끝 "각주" 목록. (PLAN-2026-10-07-doc-import-export §3.1 W6 — 유즈케이스 7)
 *
 * 에디터의 각주는 글자에 걸린 마크(`<span data-footnote="<첨부 id>">`, lib/mdSerialize.ts BriseFootnote)이고 내용은
 * kind='footnote' 첨부 파일에 있다. 그대로 내보내면 표시만 글자로 남고 **내용이 빠진다** — 그래서 내보낼 때는
 * 가져오기(doc_import — docx.rs·hwpx.rs 의 note_ref/footnote)가 만드는 모양과 같게 바꾼다:
 *   - 각주가 걸린 글자 바로 뒤에 `[n]` 글자(고른 섹션들에 걸쳐 처음 나오는 순서대로 번호, 같은 각주가 다시 나오면 같은 번호),
 *   - 마지막 고른 섹션 끝에 제목(제목 3) + 각주마다 `[n] 본문` 문단.
 * 마크 자체는 남긴다(HTML 에선 아무 일도 안 하는 span, 작성기는 글자만 쓴다) — "달라지는 점"이 바꾼 문서에서도 같은 수를 센다.
 *
 * 이 파일은 문서 JSON 만 바꾼다(순수 — 원본은 건드리지 않고 바뀐 길만 새로 만든다). HTML 은 부르는 쪽(exportDoc.ts
 * prepareExport)이 바꾼 JSON 에서 다시 뽑는다 — 미리보기와 파일이 같은 문서에서 나오게.
 */
import type { JSONContent } from "@tiptap/core";
import { callSilent } from "../../lib/invoke";
import { reportFallback, safeErrorDetail } from "../../lib/diag";
import { createMarkdownEditor } from "../../lib/mdSerialize";

interface PmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
}

/**
 * 인라인 노드에 걸린 각주 마크의 첨부 id. 없으면 null. 글자만이 아니다 — `<span data-footnote>서울<br>본사</span>` 를
 * 열면 줄바꿈(hardBreak)·인라인 그림에도 같은 마크가 붙는다(ProseMirror 는 열린 마크를 인라인 노드마다 건다).
 */
function footnoteIdOf(node: PmNode | null | undefined): string | null {
  if (!node) return null;
  for (const m of node.marks ?? []) {
    if (m.type !== "footnote") continue;
    const id = m.attrs?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/** 문서에 걸린 각주 id — 문서 순서대로, 중복 없이. `out`/`seen` 을 넘기면 여러 문서에 걸쳐 이어 모은다. */
export function collectFootnoteIds(root: unknown, out: string[] = [], seen: Set<string> = new Set()): string[] {
  const node = root as PmNode | null;
  if (!node || typeof node !== "object") return out;
  const id = footnoteIdOf(node);
  if (id && !seen.has(id)) {
    seen.add(id);
    out.push(id);
  }
  for (const child of node.content ?? []) collectFootnoteIds(child, out, seen);
  return out;
}

/**
 * 각주 본문(마크다운) → 평문. 같은 마크다운 스키마로 열어 글자만 — 블록마다 한 줄, 빈 줄은 버린다.
 * 정규식으로 기호를 벗기지 않는다(표·목록·링크 문법을 다 따라가야 하고, 어긋나면 `**` 같은 찌꺼기가 남는다).
 */
export function footnotePlainText(md: string): string {
  if (!md.trim()) return "";
  const ed = createMarkdownEditor(md);
  try {
    return ed
      .getText({ blockSeparator: "\n" })
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .join("\n");
  } finally {
    ed.destroy();
  }
}

/**
 * 각주 본문을 읽어 평문으로 — FootnotePreview 와 같은 경로(attachment_read_text IPC). 조용한 조회: 하나가 실패해도
 * 내보내기는 계속되고 그 각주는 본문 없이 번호만 나간다(실패는 진단 기록에 남긴다 — CLAUDE.md 함정 11).
 * ponytail: 각주 수만큼 IPC 를 한꺼번에 쏜다 — 노트 하나의 각주는 수십 개 규모라 묶음 커맨드가 필요 없다.
 * 수백 개가 흔해지면 note 단위로 본문을 한 번에 돌려주는 커맨드를 만든다.
 */
export async function loadFootnoteBodies(ids: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await callSilent<{ text: string; truncated: boolean }>("attachment_read_text", { id });
        const text = footnotePlainText(res.text ?? "");
        // 1MB 를 넘어 잘렸으면 잘렸다는 표시를 남긴다(다 들어간 줄 알지 않게 — attachment_read_text 의 계약).
        out[id] = res.truncated ? `${text}…` : text;
      } catch (e) {
        reportFallback("export", "footnote_read_failed", safeErrorDetail(e));
      }
    }),
  );
  return out;
}

/** 번호 매김 상태 — 고른 섹션들에 걸쳐 하나. */
interface Numbering {
  byId: Map<string, number>;
  order: string[];
}

function numberOf(id: string, nb: Numbering): number {
  let n = nb.byId.get(id);
  if (n === undefined) {
    nb.order.push(id);
    n = nb.order.length;
    nb.byId.set(id, n);
  }
  return n;
}

/**
 * 노드 하나에 `[n]` 을 끼운 새 노드(바뀐 게 없으면 같은 객체). 한 각주 마크가 여러 인라인 노드에 걸칠 수 있으므로
 * (일부만 굵게, 중간 줄바꿈 등) 같은 id 가 **연달아 이어지는 마지막** 노드 뒤에만 넣는다 — 노드마다 넣으면 `[1][1]` 이 된다.
 */
function withMarkers(node: PmNode, nb: Numbering): PmNode {
  const kids = node.content;
  if (!kids || kids.length === 0) return node;
  let changed = false;
  const next: PmNode[] = [];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    const id = footnoteIdOf(child);
    if (id) {
      const n = numberOf(id, nb); // 이어지는 조각의 첫 노드에서 번호가 정해진다(문서 순서)
      next.push(child);
      if (footnoteIdOf(kids[i + 1]) !== id) {
        next.push({ type: "text", text: `[${n}]` });
        changed = true;
      }
      continue;
    }
    const mapped = withMarkers(child, nb);
    if (mapped !== child) changed = true;
    next.push(mapped);
  }
  return changed ? { ...node, content: next } : node;
}

/** 끝 목록 — 제목 3 + 각주마다 `[n] 본문` 문단(본문의 줄은 줄바꿈으로). 빈 글자 노드는 만들지 않는다. */
function footnoteList(nb: Numbering, bodies: Readonly<Record<string, string>>, heading: string): JSONContent[] {
  const blocks: JSONContent[] = [];
  if (heading) blocks.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: heading }] });
  nb.order.forEach((id, i) => {
    const lines = (bodies[id] ?? "").split("\n").filter((l) => l !== "");
    const content: JSONContent[] = [{ type: "text", text: lines.length ? `[${i + 1}] ${lines[0]}` : `[${i + 1}]` }];
    for (const line of lines.slice(1)) content.push({ type: "hardBreak" }, { type: "text", text: line });
    blocks.push({ type: "paragraph", content });
  });
  return blocks;
}

/**
 * 고른 섹션들의 문서에 각주를 적용한다. 각주 마크가 하나도 없으면 null(부르는 쪽이 입력을 그대로 쓴다).
 * `changed[i]` = i 번째 문서가 바뀌었는가(그 섹션만 HTML 을 다시 뽑으면 된다). 원본은 건드리지 않는다.
 */
export function applyFootnotes(
  docs: readonly unknown[],
  bodies: Readonly<Record<string, string>>,
  heading: string,
): { docs: unknown[]; changed: boolean[] } | null {
  const nb: Numbering = { byId: new Map(), order: [] };
  const out = docs.map((d) => (d && typeof d === "object" ? withMarkers(d as PmNode, nb) : d));
  if (nb.order.length === 0) return null;
  const changed = out.map((d, i) => d !== docs[i]);
  const last = out.length - 1;
  const tail = (out[last] ?? { type: "doc" }) as PmNode;
  const list = footnoteList(nb, bodies, heading) as PmNode[];
  out[last] = { ...tail, type: tail.type ?? "doc", content: [...(tail.content ?? []), ...list] };
  changed[last] = true;
  return { docs: out, changed };
}
