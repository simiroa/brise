import type { Editor } from "@tiptap/core";
import type { Section } from "./commands.gen";
import { emitNotice } from "./invoke";
import { t } from "../i18n/t";
import { useNotesStore, isNoteContentLocked } from "../stores/notes";
import { useUiStore } from "../stores/ui";

/**
 * Bridge between TitleBar's AI dropdown ("에디터 내용 정리" / "프롬프트 박스") and EditorPanel's
 * section state — the two components are siblings, not parent/child, so there's no prop path
 * between them. EditorPanel owns the fragile flush/section-switch core (switchSection, flushRef,
 * bodyCacheRef, prevNoteIdRef, timeoutRef, the onUpdate debounce, the two note-switch/registerFlush
 * effects) and that core must not be touched — so instead of reaching into it, EditorPanel
 * registers two small, additive callbacks here (mirrors the existing registerFlush pattern in
 * lib/invoke.ts) and TitleBar calls them through this module only.
 *
 * getActiveSection(): read-only snapshot of the section currently open in the editor. Callers
 * should `await flushAll()` first (see lib/invoke.ts) so pending debounced edits are already
 * reflected here — this module never triggers a flush itself.
 *
 * insertAiSection(): creates a brand-new section pre-filled with AI output and switches the
 * editor to it, mirroring EditorPanel's own handleAddSection. This is how ai_cleanup_text /
 * ai_generate_from_prompt results reach the UI — they are NEVER written into the current
 * section's body (that would violate the project's "AI output never overwrites" rule).
 *
 * targetNoteId: every insert path must name the note the AI request was launched against.
 * Without it, a mid-flight note switch would materialize/switch into whatever is active when
 * the response arrives (A's result silently lands on B). Callers capture the id before their
 * first await; the registered inserter re-checks via prepareAiInsertNoteId.
 */

type ActiveSectionSnapshot = { id: string; body_md: string } | null;
type ActiveSectionGetter = () => ActiveSectionSnapshot;
// kind is optional/additive; targetNoteId is required so a mid-flight note switch cannot land
// the result on a different note (see prepareAiInsertNoteId).
// aiOrigin (W5 section provenance): the calling action's id, forwarded to
// section_create_with_body's ai_origin. undefined for inserts that are not actual AI output.
type SectionInserter = (
  name: string,
  body_md: string,
  targetNoteId: string,
  kind?: "text" | "diagram" | "sheet",
  aiOrigin?: string,
) => Promise<Section | null>;

let activeSectionGetter: ActiveSectionGetter = () => null;
let sectionInserter: SectionInserter = async () => null;

export function registerActiveSectionGetter(fn: ActiveSectionGetter): () => void {
  activeSectionGetter = fn;
  return () => {
    if (activeSectionGetter === fn) activeSectionGetter = () => null;
  };
}

export function getActiveSection(): ActiveSectionSnapshot {
  return activeSectionGetter();
}

export function registerSectionInserter(fn: SectionInserter): () => void {
  sectionInserter = fn;
  return () => {
    if (sectionInserter === fn) sectionInserter = async () => null;
  };
}

/**
 * 활성 섹션의 **라이브 Tiptap 인스턴스** — getActiveSection() 의 body_md 스냅샷으로는 못 하는 일,
 * 즉 "문서 안 특정 범위에 마크를 붙이기"만을 위한 채널이다(자동 각주: editor/autoFootnote.ts).
 * getActiveSection 을 넓히지 않고 따로 두는 이유는 registerDiagramTarget 과 같다 — 저쪽 스냅샷
 * 계약(다이어그램 섹션은 null, 본문은 문자열)을 건드리지 않고 필요한 것 하나만 더 낸다.
 *
 * getActiveEditor 는 파괴된 인스턴스를 절대 넘기지 않는다(CLAUDE.md 함정 2). 등록자 쪽도
 * 다이어그램 섹션에서는 null 을 돌려준다 — 다이어그램 소스(JSON IR, 예전엔 mermaid 텍스트)는
 * 각주를 달 산문이 아니다.
 */
type ActiveEditorGetter = () => Editor | null;
let activeEditorGetter: ActiveEditorGetter = () => null;

export function registerActiveEditor(fn: ActiveEditorGetter): () => void {
  activeEditorGetter = fn;
  return () => {
    if (activeEditorGetter === fn) activeEditorGetter = () => null;
  };
}

export function getActiveEditor(): Editor | null {
  const ed = activeEditorGetter();
  return ed && !ed.isDestroyed ? ed : null;
}

let pendingAiInsertId: string | null = null;

export function setPendingAiInsertId(id: string | null): void {
  pendingAiInsertId = id;
}

export function getPendingAiInsertId(): string | null {
  return pendingAiInsertId;
}

/**
 * opts.postProcess: false = this insert is not newly generated note content, so the background
 * metadata proposal (lib/aiPostProcess.ts) must not run for it. Two kinds of callers pass it:
 * translation (a language transform of text that was already organized) and the diagram TEMPLATE
 * gallery (lib/presetBridge.ts — a starter skeleton with nothing to infer metadata from). Every
 * other caller here creates content the model actually wrote, which is exactly the trigger.
 *
 * opts.aiOrigin (W5 section provenance, docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W5):
 * the calling action's id — BUILTIN_DEFS' id (src/stores/aiPrompts.ts) for preset-driven callers,
 * or the literal "translate"/"prompt" for the two flows that generate content without going
 * through a preset row (translation, and the free-form prompt box / selection-AI-ask family).
 * Omitted entirely for inserts that are NOT actual AI output — a blank section, a template
 * skeleton (lib/presetBridge.ts), or raw scraped/reader text with no model in the loop
 * (AttachmentDialogs.tsx's link import) — those must not show the AI-authored dot. This is the
 * ONE place that forwards to section_create_with_body's ai_origin; every caller below funnels
 * through here rather than tagging the DB write itself (.claude/CLAUDE.md code policy — fix at
 * the one point all callers pass through, not per call site).
 *
 * ponytail: section-level only. No sentence/block-level provenance, no "% AI" indicator, no
 * history backtracking. If finer granularity is ever needed, the upgrade path is a TipTap mark
 * (same precedent as the footnote-anchor mark), not widening this string tag.
 */
export function insertAiSection(
  name: string,
  body_md: string,
  targetNoteId: string,
  kind?: "text" | "diagram" | "sheet",
  opts?: { postProcess?: boolean; aiOrigin?: string; renameOnInsert?: boolean },
): Promise<Section | null> {
  // 내용잠금: 이 함수가 AI 텍스트/다이어그램 결과가 노트에 들어가는 유일한 지점이므로(docs/AI.md
  // "L1은 원본을 덮어쓰지 않는다") 번역/프롬프트/프리셋/각주 등 모든 호출자가 여기 하나로 막힌다.
  // targetNoteId는 지금 열려 있는 노트와 다를 수 있다(mid-flight 노트 전환, 백그라운드 대상) —
  // activeNote만 보지 않고 id-keyed 헬퍼를 쓴다.
  if (isNoteContentLocked(targetNoteId)) {
    emitNotice(t("editor.content_locked_tooltip"));
    return Promise.resolve(null);
  }
  const p = kind
    ? sectionInserter(name, body_md, targetNoteId, kind, opts?.aiOrigin)
    : sectionInserter(name, body_md, targetNoteId, undefined, opts?.aiOrigin);
  return p.then((sec) => {
    if (sec?.id) {
      pendingAiInsertId = sec.id;
      // "+" 새 섹션 메뉴: 탭이 곧바로 이름 입력 상태가 된다(SectionTabBar 가 소비).
      if (opts?.renameOnInsert) useUiStore.setState({ renameSectionId: sec.id });
    }
    // Every AI text/diagram result lands here, so this is the one place post-processing has to be
    // wired. Dynamic import keeps this module's static graph (and every test that mocks it)
    // untouched; the call is deliberately not awaited — insertion must not wait on it.
    if (sec && opts?.postProcess !== false) {
      // .catch: fire-and-forget must never turn into an unhandled rejection (or a toast) —
      // background work the user never asked for fails quietly.
      void import("./aiPostProcess")
        .then((m) => m.schedulePostProcess(targetNoteId))
        .catch(() => {});
    }
    return sec;
  });
}

/**
 * Policy (a) for AI section insert when the active note may have changed mid-request:
 * if still on targetNoteId → ensureMaterialized and return its id;
 * if switched away → selectNote(target) then insert (never silently write into the new active note);
 * if the target cannot be restored (draft abandoned, selectNote bailed) → emitNotice and return null.
 *
 * Mirrors stores/ai.ts lastProposalNoteId: remember the request target, act on that note only.
 * Exported for unit tests.
 */
export async function prepareAiInsertNoteId(targetNoteId: string): Promise<string | null> {
  const notes = useNotesStore.getState();
  if (notes.activeNote?.note.id !== targetNoteId) {
    // Draft ids are local placeholders — selectNote cannot reopen a discarded draft.
    if (targetNoteId === "__draft__") {
      emitNotice(t("editor.ai_insert_note_changed"));
      return null;
    }
    await notes.selectNote(targetNoteId);
    if (useNotesStore.getState().activeNote?.note.id !== targetNoteId) {
      emitNotice(t("editor.ai_insert_note_changed"));
      return null;
    }
  }
  return useNotesStore.getState().ensureMaterialized();
}

/**
 * 관계도 수정하기 (aiPrompts.ts's DIAGRAM_EDIT_ID) target — a SEPARATE channel from
 * getActiveSection() above, deliberately. That getter returns null for kind:'diagram' on purpose
 * (EditorPanel.tsx: "다이어그램 섹션은 정리할 산문이 아니다") so diagram source (JSON IR, formerly
 * mermaid text) never leaks into translate/cleanup/prompt context; widening it would undo that.
 * This slot instead carries the one thing a diagram edit needs — the live source and a way to write the result back over the SAME
 * section — and is registered by DiagramSection itself, which owns `draft` and the save path.
 *
 * Registered per mounted diagram section (DiagramSection is keyed by section.id, so switching tabs
 * or notes remounts it) and unregistered on unmount: no diagram open ⇒ getDiagramTarget() is null,
 * which is exactly what AiActionsMenu renders the disabled row from.
 */
export type DiagramTarget = {
  sectionId?: string;
  source: string;
  instruction?: string;
  selectedNodeId?: string;
  selectedNodeLabel?: string;
  replaceSection: (body_md: string) => Promise<void>;
};
type DiagramTargetGetter = () => DiagramTarget | null;

let diagramTargetGetter: DiagramTargetGetter = () => null;

export function registerDiagramTarget(fn: DiagramTargetGetter): () => void {
  diagramTargetGetter = fn;
  return () => {
    if (diagramTargetGetter === fn) diagramTargetGetter = () => null;
  };
}

export function getDiagramTarget(): DiagramTarget | null {
  return diagramTargetGetter();
}

/**
 * 관계도 JSON IR v1 소스를 LLM이 이해하기 쉬운 시맨틱 텍스트 요약본으로 변환합니다.
 * 할 일 추출, 관계도 기반 글 작성, 일반 질의 컨텍스트에 주입할 때 사용됩니다.
 */
export function formatDiagramAsContext(source: string): string {
  try {
    const json = JSON.parse(source);
    if (!json || typeof json !== "object") return source;
    const states = Array.isArray(json.states) ? json.states : [];
    const lines: string[] = ["[관계도 구조 요약]"];
    if (states.length > 0) {
      lines.push(`- 정의된 상태 목록: ${states.join(", ")}`);
    }
    if (Array.isArray(json.nodes) && json.nodes.length > 0) {
      lines.push("- 주요 노드(개체) 목록:");
      for (const n of json.nodes) {
        const stateName = n.state !== undefined && states[n.state] ? ` (상태: ${states[n.state]})` : "";
        const tag = n.tag ? ` [태그: ${n.tag}]` : "";
        const desc = n.desc ? ` - ${n.desc}` : "";
        const flag = n.flag ? " ★강조" : "";
        lines.push(`  • ${n.label || n.id}${stateName}${tag}${flag}${desc}`);
      }
    }
    if (Array.isArray(json.edges) && json.edges.length > 0) {
      const nodeMap = new Map<string, string>();
      for (const n of json.nodes || []) nodeMap.set(n.id, n.label || n.id);
      lines.push("- 노드 간 연결(관계) 흐름:");
      for (const e of json.edges) {
        const fromLabel = nodeMap.get(e.from) || e.from;
        const toLabel = nodeMap.get(e.to) || e.to;
        const rel = e.label ? ` --(${e.label})--> ` : " --> ";
        lines.push(`  • ${fromLabel}${rel}${toLabel}`);
      }
    }
    if (Array.isArray(json.groups) && json.groups.length > 0) {
      lines.push("- 그룹(범주):");
      for (const g of json.groups) {
        lines.push(`  • ${g.title}`);
      }
    }
    return lines.join("\n");
  } catch {
    return source;
  }
}

export type SheetTarget = { sectionId?: string; source: string; instruction?: string; replaceSection: (body_md: string) => Promise<void> };
type SheetTargetGetter = () => SheetTarget | null;

let sheetTargetGetter: SheetTargetGetter = () => null;

export function registerSheetTarget(fn: SheetTargetGetter): () => void {
  sheetTargetGetter = fn;
  return () => {
    if (sheetTargetGetter === fn) sheetTargetGetter = () => null;
  };
}

export function getSheetTarget(): SheetTarget | null {
  return sheetTargetGetter();
}

/**
 * 섹션 본문 끝에 붙는 **출처 한 줄**. `insertAiSection` 이 "AI 가 만든 것"을 DB 컬럼(ai_origin)에
 * 표시하는 것과 짝이다 — 그쪽은 "누가 썼나", 이쪽은 "무엇으로부터 썼나"이고, 후자는 본문 안에
 * 있어야 내보내기(.md)·동기화·검색에 함께 실린다.
 *
 * 왜 프롬프트로 부탁하지 않는가: 모델에게 "출처를 적어라"고 하면 지킬 때도 있고 안 지킬 때도 있어
 * 출처가 있는 섹션과 없는 섹션이 섞인다. 그래서 삽입 직전에 코드가 붙인다.
 *
 * 왜 각주(footnoteMark)가 아닌가(2026-09-10 확인): 각주 마크는 attrs.id 로 **첨부 행**을 가리키고
 * 각주 목록/프리뷰는 `isFootnoteKind` 로 필터한 뒤 `attachment_read_text`(텍스트 kind 전용)로
 * 읽는다. 링크 첨부를 가리키면 본문에는 마커가 생기는데 목록에는 그 항목이 없고 본문 조회도
 * VALIDATION 으로 거부된다 — 눌러도 아무것도 안 나오는 마커가 남는다. AskAi 의 첨부 파일은 더
 * 나아가 노트 첨부로 **등록되지도 않는다**(메모리 안 {name,size,content}). 각주로 가려면 별도
 * footnote 첨부를 하나 더 만들어야 하고(같은 사실이 두 행), 그건 이 한 줄이 이미 하는 일이다.
 *
 * url 이 없는 출처(노트에 남지 않는 재료 — AskAi 첨부 파일)는 이름만 남는다. 여럿이면 " · " 로
 * 잇는다.
 */
export interface SectionSource {
  /** 사람이 읽는 이름 — 페이지 제목, 파일명 등. */
  label: string;
  /** 있으면 마크다운 링크가 된다. */
  url?: string;
}

export function withSourceLine(body: string, sources: SectionSource[]): string {
  const parts = sources
    // 라벨은 남의 페이지 제목이나 파일명이다 — 대괄호가 들어오면 마크다운 링크가 깨지고,
    // 줄바꿈이 들어오면 한 줄이어야 할 것이 여러 줄이 된다. 공백 런도 함께 접는다.
    .map((s) => ({ url: s.url, label: s.label.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim() }))
    .filter((s) => s.label)
    .map((s) => (s.url ? `[${s.label}](${s.url})` : s.label));
  if (parts.length === 0) return body;
  return `${body.trimEnd()}

> ${t("editor.link_source_label")}: ${parts.join(" · ")}
`;
}
