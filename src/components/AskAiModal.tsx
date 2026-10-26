import { useState, useMemo, useRef, useCallback, useEffect, Suspense, type DragEvent, type ChangeEvent } from "react";
import type { Editor } from "@tiptap/react";
import { ModalShell } from "./ModalShell";
import { IconBookmark, IconBulletList, IconCaret, IconFolder, IconHighlight, IconNote, IconPaperclip, IconWeatherSun } from "./icons";
import { t } from "../i18n/t";
import { call, callSilent, emitNotice } from "../lib/invoke";
import type { PetChatReadAttachOutput } from "../lib/commands.gen";
import { formatFileSize } from "../lib/ui";
import { savedWeatherLocation } from "../lib/weather";
import { useFileDropZone } from "../lib/useFileDropZone";
import { useAiStore } from "../stores/ai";
import { useAiPresetsStore } from "../stores/aiPresets";
import type { AiActionPreset, AskAiKind, AskAiWhere } from "../stores/aiPrompts";
import { useNotesStore, isNoteContentLocked } from "../stores/notes";
import type { AiPlan } from "../lib/aiAgentBridge";
import * as askAiHistory from "../lib/askAiHistory";
import type { AskAiHistoryEntry } from "../lib/askAiHistory";

import { useSettingsStore } from "../stores/settings";
import { AskAiWelcomeCard } from "./ai/AskAiWelcomeCard";

// Sub-modules
import { type AskAiTarget, type ExtendedTranslateLang, type AttachedFileItem, type AiDataDest, TRANSLATE_LANGUAGES } from "./ai/askAiTypes";
import { PROVIDERS } from "./settings/shared";
import { isLoopbackEndpoint } from "../lib/aiLoopback";
import { noteBodyForAi, findPreset, runMetadataProposal, runTagsProposal, runNoteSummary } from "./ai/askAiHelpers";
import { AskAiHeader } from "./ai/AskAiHeader";
import { AskAiTileGrid, type AskAiHoverStamp } from "./ai/AskAiTileGrid";
import { AskAiActionBar } from "./ai/AskAiActionBar";
import { AskAiAttachmentDropzone } from "./ai/AskAiAttachmentDropzone";
import { AskAiContextStrip, type CtxListItem, type DescribeRef } from "./ai/AskAiContextStrip";
import { AskAiComposer, type CtxItem } from "./ai/composer/AskAiComposer";
import { docToTemplate, parseTemplate, serialize } from "./ai/composer/serialize";
import { SLOT_NODE } from "./ai/composer/slotNode";
import { docText, sameRef, type ComposerDoc, type CtxKind, type CtxRef } from "./ai/composer/types";
import { tilesForTarget, resolveTemplateForPreset } from "./ai/askAiPresets";
import { dispatchAskAi, whereOptions, liveState, defaultWhere, metadataFollows, type DispatchInput } from "./ai/askAiDispatch";
import { InternalNotePicker } from "./attachments/InternalNotePicker";
import { Toggle } from "./settings/Toggle";
import type { AiActionAutoAdd } from "./presets/AiActionEditor";
import { useAiResultGateStore, registerEmbeddedGateHost } from "../stores/aiResultGate";
import { AiResultPanel, ResultPreview, finalizeGateDecision, formatElapsed, formatResultTitle } from "./ai/AiResultPanel";
import { useGenerationBeam } from "../lib/useGenerationBeam";
import { getSectionToken } from "../lib/sectionTokens";
import { AskAiMetaPanel } from "./ai/AskAiMetaPanel";
import { useProposalHostStore } from "../stores/proposalHost";
import { reportFallback } from "../lib/diag";
import { getDiagramTarget, getSheetTarget } from "../lib/aiSectionBridge";
import type { OutputFormat } from "./ai/AskAiActionBar";
import { AiAgentReviewModal, PresetManageModal } from "../lazySurfaces";

// Re-export types and helpers for external callers & tests
export type { AskAiTarget, ExtendedTranslateLang, AttachedFileItem };
export { TRANSLATE_LANGUAGES, noteBodyForAi, findPreset, runMetadataProposal, runTagsProposal, runNoteSummary };




/** 버전 비교(‹ 2/3 ›, PLAN-2026-09-27 W3) — 이 모달에서 나온 결과(텍스트·시트·관계도). */
/** 이어서 다듬기 칩 — 라벨과 보낼 지시문(i18n 키). 기존 "표로"는 "시트로" 형식 칩으로 대체(W3). */
const REFINES = [
  { label: "ai.refine_shorter", prompt: "ai.refine_shorter_prompt" },
  { label: "ai.refine_longer", prompt: "ai.refine_longer_prompt" },
  { label: "ai.refine_simpler", prompt: "ai.refine_simpler_prompt" },
] as const;

const FORMAT_REFINES = [
  { format: "sheet", label: "ai.refine_to_sheet", prompt: "ai.refine_to_sheet_prompt" },
  { format: "diagram", label: "ai.refine_to_diagram", prompt: "ai.refine_to_diagram_prompt" },
  { format: "text", label: "ai.refine_to_text", prompt: "ai.refine_to_text_prompt" },
] as const;

interface AskAiVersion {
  key: string;
  input: DispatchInput;
  text: string;
  target: string;
  format: OutputFormat;
  model?: string;
  provider?: string;
  durationMs?: number;
  /** 교체 결과(시트·관계도)를 만들 때의 대상 원본 — insertVersion 이 신선도 확인에 쓴다. */
  replaceBase?: { sectionId?: string; source: string; token?: string };
}

/** "+추가"가 만드는 새 AI 프리셋 — 지금 모달의 대상에 타일로 뜨게 종류·대상을 맞춘다. 노트·텍스트 섹션은
 *  커스텀 프리셋의 옛 기본 자리(targets 없음)라 그대로 두고, 관계도·시트·선택 영역은 그 대상을 적는다
 *  (askAiPresets.tilesForTarget — targets 가 없으면 노트·섹션에만 뜬다). */
function autoAddFor(kind: AskAiKind): AiActionAutoAdd {
  const presetKind = kind === "diagram" ? "diagram" : kind === "sheet" ? "sheet" : "text";
  return { kind: presetKind, targets: kind === "note" || kind === "section" ? undefined : [kind] };
}

const ACCEPT_EXT = [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".log"];
const MAX_ATTACH_BYTES = 2 * 1024 * 1024;

/** 빈 text 슬롯 안으로 캐럿 — 보내기 전 채워야 하는 자리(D-A3). */
function focusSlot(editor: Editor | null, key: string): void {
  if (!editor || editor.isDestroyed) return;
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.type.name === SLOT_NODE && node.attrs.key === key) pos = p;
    return pos < 0;
  });
  if (pos >= 0) editor.chain().focus().setTextSelection(pos + 1).run();
}

/**
 * AI에게 묻기 — 조립(PLAN-2026-09-15-askai-composer §4, 6안 §7). 좌측 타일을 누르면 우측 요청문에
 * 지시문이 스탬프되고, 컨텍스트는 문장이 아니라 **상자 위의 줄**(`ctxList`)이 소유한다(D14·D15).
 * 보내는 것은 화면에 보이는 그 문장 + 그 줄에서 **활성**인 참조들이다. 라우팅은 askAiDispatch.
 */
/** 첨부 이름 충돌 → `stem (2).ext` (내보내기의 unique_basename 과 같은 규칙). */
export function uniqueAttachedName(prev: readonly { name: string }[], name: string): string {
  if (!prev.some((f) => f.name === name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const cand = `${stem} (${n})${ext}`;
    if (!prev.some((f) => f.name === cand)) return cand;
  }
}

export function AskAiModal({
  target,
  onClose,
  presetId: propPresetId,
  autoSend: propAutoSend,
}: {
  target: AskAiTarget;
  onClose: () => void;
  presetId?: string;
  autoSend?: boolean;
}) {
  const activeNote = useNotesStore((s) => s.activeNote);
  const folders = useNotesStore((s) => s.folders);
  const notesByFolder = useNotesStore((s) => s.notesByFolder);
  const presetList = useAiPresetsStore((s) => s.list);
  const translateLang = useAiStore((s) => s.translateTargetLang);

  const isNew = target.kind === "new";
  const isDiagram = (target.kind === "section" && target.isDiagram) || target.kind === "diagram";
  const isSheet = target.kind === "section" && !!target.isSheet;
  // 내용잠금: "note" 대상은 지금 열려 있지 않은 노트(트리/탭 행의 Ask-AI)일 수 있어 activeNote만
  // 보면 안 된다 — id-keyed 헬퍼를 쓴다. "new"는 아직 노트가 없으니 잠글 대상이 없다. 나머지
  // (section/selection/diagram)는 열린 노트를 전제하므로 activeNote로 충분하다. 대화(요청문 작성)
  // 자체는 막지 않고, 결과를 그 노트에 써넣는 전송 버튼만 아래에서 비활성화한다.
  const targetNoteId = target.kind === "note" ? target.noteId : target.kind === "new" ? null : (activeNote?.note.id ?? null);
  const targetLocked = useNotesStore(() => (targetNoteId ? isNoteContentLocked(targetNoteId) : false));
  // `new` 는 프리셋이 없는 순수 생성이라 노트 종류로 취급한다(D7 — 본문 없는 요청 = new 흡수).
  const kind: AskAiKind =
    target.kind === "new" || target.kind === "note" ? "note"
      : target.kind === "diagram" || isDiagram ? "diagram"
        : isSheet ? "sheet"
          : target.kind;
  // 이 대상의 "본문" 참조 — 선택 영역은 선택, 섹션 대상은 그 섹션, 나머지는 노트 본문.
  const targetRef: CtxRef = useMemo(
    () => (target.kind === "selection" ? { k: "selection" } : target.kind === "section" ? { k: "section", id: target.sectionId } : { k: "body" }),
    [target],
  );

  const initialPresetId = target.presetId ?? propPresetId ?? null;
  const initialAutoSend = target.autoSend ?? propAutoSend ?? false;

  const stampFor = useCallback(
    (p: AiActionPreset): ComposerDoc => parseTemplate(resolveTemplateForPreset(p, kind), { lang: translateLang }),
    [kind, translateLang],
  );

  // 어시스트가 넘긴 프리셋 — 타일 모양(DEFS 의 대상·아이콘·문장을 채운 것)으로 찾는다. 저장 목록의 항목은 문장이 비어
  // 있을 수 있다("기본 문장을 쓴다") — 그대로 찍으면 빈 요청이 된다.
  const lookupPreset = (id: string): AiActionPreset | null =>
    tilesForTarget(kind, presetList, false).find((p) => p.id === id) ??
    tilesForTarget(kind, presetList, true).find((p) => p.id === id) ??
    presetList.find((p) => p.id === id) ??
    findPreset(id);
  const initialPreset = useMemo(
    () => (initialPresetId ? lookupPreset(initialPresetId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lookupPreset 은 kind·presetList 만 본다
    [initialPresetId, presetList, kind],
  );

  const initialDoc: ComposerDoc = useMemo(() => {
    if (initialPreset) return stampFor(initialPreset);
    return target.initialPrompt ? [{ t: "text" as const, v: target.initialPrompt }] : [];
  }, [initialPreset, stampFor, target.initialPrompt]);

  const [doc, setDoc] = useState<ComposerDoc>(initialDoc);
  const [stampedDoc, setStampedDoc] = useState<ComposerDoc | null>(initialPreset ? initialDoc : null);
  // 컨텍스트 줄(D14) — 대상이 심은 첫 항목 + `/`·첨부가 더한 것들. 활성인 것만 보낸다.
  const [ctxList, setCtxList] = useState<CtxListItem[]>(() => {
    const list: CtxListItem[] = isNew ? [] : [{ ref: targetRef, active: true }];
    if (initialPreset?.needs) {
      for (const need of initialPreset.needs) {
        const ref: CtxRef | null =
          need === "body" ? targetRef
            : need === "selection" ? { k: "selection" }
              : need === "weather" ? { k: "weather" }
                : null;
        if (ref && !list.some((i) => sameRef(i.ref, ref))) {
          list.push({ ref, active: true, removable: true });
        }
      }
    }
    return list;
  });
  // 마지막으로 스탬프한 프리셋 — 문장을 고쳐 `custom` 이 되어도 라우팅(proposal·kind)은 이걸 따른다(D10).
  const [presetId, setPresetId] = useState<string | null>(initialPresetId);
  const [where, setWhere] = useState<AskAiWhere>(() => (isNew ? "note" : defaultWhere(target, initialPreset?.where)));
  const defaultFormat: OutputFormat = isDiagram ? "diagram" : isSheet ? "sheet" : "text";
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(() => {
    if (initialPreset?.where === "replace") return defaultFormat;
    if (initialPreset?.kind === "sheet") return "sheet";
    if (initialPreset?.kind === "diagram") return "diagram";
    return defaultFormat;
  });
  const isFormatFixed = where === "replace";
  const [folderId, setFolderId] = useState<string | null>(() => activeNote?.note.folder_id ?? folders[0]?.id ?? null);
  const [attached, setAttached] = useState<AttachedFileItem[]>([]);
  // 이름 충돌 판정은 렌더를 기다리지 않는다 — 파일 여럿이 같은 틱에 읽혀도 서로의 이름을 봐야 한다.
  const attachedRef = useRef<AttachedFileItem[]>([]);
  /** 첨부 하나 추가(+ 참조 칩). 같은 이름·같은 크기 = 같은 파일이라 건너뛰고, 이름만 같은 다른 파일(다른 폴더의
   *  main.py)은 이름을 구분해 둘 다 붙인다 — 참조(ref)와 본문 조회가 전부 이름으로 잇기 때문에 이름이 곧 키다. */
  const addAttached = (name: string, size: number, content: string) => {
    const cur = attachedRef.current;
    if (cur.some((f) => f.name === name && f.size === size)) return;
    const unique = uniqueAttachedName(cur, name);
    attachedRef.current = [...cur, { name: unique, size, content }];
    setAttached(attachedRef.current);
    addRef({ k: "file", name: unique });
  };
  const [ghost, setGhost] = useState<ComposerDoc | null>(null);
  const [reviewPlan, setReviewPlan] = useState<AiPlan | null>(null);
  const [notePicker, setNotePicker] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [viewingShowRaw, setViewingShowRaw] = useState(false);
  // 메타데이터 스위치(오너 2026-09-26) — 기본 꺼짐, 열 때마다 꺼진 채 시작한다. 켜면 내용이 반영된 뒤
  // 같은 요청으로 대상 노트의 제목·태그·연도·지역을 고칠 제안이 이어진다(askAiDispatch `includeMetadata`).
  const [includeMeta, setIncludeMeta] = useState(false);
  // 삽입 시점에 읽는 스위치 값(Q9-b) — 보낼 때 굳힌 입력(버전 포함)도 이 ref 를 통해 지금 값을 본다.
  const includeMetaRef = useRef(includeMeta);
  includeMetaRef.current = includeMeta;
  // AI 프리셋 편집기(오너 2026-09-27) — 연필·"+추가"가 설정 창 대신 이 모달 위에 바로 연다. 편집은 같은
  // 스토어(useAiPresetsStore)라 닫는 즉시 타일에 반영된다. `add` = 열자마자 새 프리셋 하나, `selectId` = 처음 고를
  const [presetEditor, setPresetEditor] = useState<{ add: boolean; selectId?: string } | null>(null);

  // 3.6 첫 실행 환영/활용/데이터 안내 카드 및 제공자 표시
  const seenBriefs = useSettingsStore((s) => s.seenFeatureBriefs);
  const setSeenFeatureBriefs = useSettingsStore((s) => s.setSeenFeatureBriefs);
  const [showWelcome, setShowWelcome] = useState(() => !useSettingsStore.getState().seenFeatureBriefs.includes("askai_welcome"));
  // 데이터 목적지 — 설정을 읽기 전(null)에는 헤더·카드가 외부로 보인다(askAiTypes AiDataDest).
  const [dataDest, setDataDest] = useState<AiDataDest | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all");
        const id = String(res?.settings?.ai_provider || "ollama").toLowerCase();
        const endpoint = String(res?.settings?.ai_endpoint || (id === "ollama" ? "http://localhost:11434" : ""));
        const name = PROVIDERS.find((p) => p.toLowerCase() === id) ?? id;
        if (alive) setDataDest({ name, external: !(id === "ollama" && isLoopbackEndpoint(endpoint)) });
      } catch {
        // callSilent 이 진단에 남겼다 — 목적지를 모르면 외부로 보인 채 둔다.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dismissWelcome = () => {
    if (!seenBriefs.includes("askai_welcome")) {
      void setSeenFeatureBriefs([...seenBriefs, "askai_welcome"]);
    }
    setShowWelcome(false);
  };

  // ── 한 모달에서 작성 → 생성 → 검토(오너 2026-09-27) ──────────────────────────────────────────────
  // 이 모달이 결과 게이트의 두 번째 호스트다: 여기서 보낸 요청의 결과는 AiResultModal 이 아니라 이 안의
  // AiResultPanel 에 그려진다(aiResultGate `embedded`). 결과를 보는 중 요청문을 고쳐 Enter 하면 새로
  // 만들고, 그대로 Enter 하면 다시 생성한다. [삽입]이 실제로 반영돼야 닫힌다.
  useEffect(() => registerEmbeddedGateHost(), []);
  const gateSession = useAiResultGateStore((s) => (s.session?.embedded ? s.session : null));
  // 확인 없이 곧장 적용하는 설정(ai_confirm_before_apply 끔)에서는 세션이 없다 — 도는 동안을 여기서 센다.
  const [inFlight, setInFlight] = useState(false);
  const [inFlightAt, setInFlightAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  // 마지막으로 보낸 요청의 지문(requestSignature) — 결과를 보는 중 Enter 가 "그대로 다시"인지 "고쳐서
  // 다시"인지 가른다.
  const lastSentRef = useRef<string | null>(null);
  // 보낼 때마다 +1 — 늦게 돌아온 옛 요청이 모달을 닫거나 상태를 뒤집지 못하게.
  const sendSeqRef = useRef(0);
  // 지금 도는 dispatch — "고쳐서 다시"는 옛것을 버리고 끝나기를 기다린 **뒤에** 새로 보낸다.
  const inflightRef = useRef<Promise<unknown> | null>(null);
  // 마지막으로 보낸 입력 — 결과가 오면 그 입력과 함께 버전으로 남긴다.
  const lastInputRef = useRef<DispatchInput | null>(null);
  // 마지막으로 보낸 교체 요청의 대상 원본(시트·관계도) — 버전에 함께 남겨, 이전 버전을 교체로 넣을 때 그 사이 대상이
  // 바뀌었는지 본다(askAiDispatch `cachedBase`).
  const lastBaseRef = useRef<{ sectionId?: string; source: string; token?: string } | undefined>(undefined);
  const [versions, setVersions] = useState<AskAiVersion[]>([]);
  // 보고 있는 이전 버전(null = 지금 살아 있는 결과).
  const [viewKey, setViewKey] = useState<string | null>(null);
  // ── 메타데이터 제안(2단계, 오너 2026-09-27 "따로 분리된 게 싫다") ── 그 노트의 제안을 독립 확인 창이 아니라
  // 이 안(AskAiMetaPanel — 결과 패널과 같은 틀)에서 받는다. 두 경우다:
  //   proposal = 메타·태그 프리셋으로 보낸 제안. 버리면 작성으로 돌아오고, 요청문을 고쳐 Enter 하면 다시 받는다.
  //   followUp = "메타데이터 포함"으로 내용을 삽입한 뒤 이어지는 제안. 내용은 이미 들어갔으니 건너뛰면 닫는다.
  // pending = 제안을 만드는 중(빛줄기). 적용하면 닫는다. 그 사이 그 노트의 제안은 독립 확인 창이 그리지 않는다
  // (stores/proposalHost).
  const [meta, setMeta] = useState<{ noteId: string; pending: boolean; source: "proposal" | "followUp" } | null>(null);
  const [metaApplying, setMetaApplying] = useState(false);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const closedRef = useRef(false);
  const metaProposal = useAiStore((s) => (meta && !meta.pending && s.lastProposalNoteId === meta.noteId ? s.lastProposal : null));
  useEffect(() => {
    if (!meta) return;
    useProposalHostStore.setState({ noteId: meta.noteId });
    return () => {
      // 제안을 만드는 중에 닫혔으면 아직 내려놓지 않는다 — 지금 풀면 곧 도착할 제안을 독립 확인 창이 한 번
      // 그렸다가 지워진다(깜빡임). 도착을 기다리는 후속(runDispatch)이 치우고 나서 내려놓는다. 후속은
      // catch 가 붙어 있어 반드시 끝나므로 새지 않는다.
      if (metaRef.current?.pending) return;
      useProposalHostStore.setState({ noteId: null });
    };
  }, [meta?.noteId]);
  // 그 노트의 제안이 사라졌다(버리기·건너뛰기, 또는 밖에서 치워짐) → 삽입 뒤라면 닫고, 제안 요청이었다면 작성으로
  // 돌아온다. 적용은 여기가 아니라 AskAiMetaPanel 의 onApplied 가 닫는다 — 적용 중에는 보지 않는다.
  useEffect(() => {
    if (!meta || meta.pending || metaProposal || metaApplying) return;
    if (meta.source === "followUp") onClose();
    else setMeta(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 단계·제안 변화에만
  }, [meta, metaProposal, metaApplying]);
  // 메타데이터 단계에서 닫으면(X·Esc) = 메타데이터는 건너뛴다 — 그 노트의 제안을 치운다. 아직 만드는 중이었다면
  // 도착할 때 치운다(hostProposal, closedRef). 적용 뒤 닫힐 때는 그 제안이 이미 없어 아무 일도 없다.
  useEffect(() => {
    // 세울 때 되돌린다 — StrictMode(개발 빌드)는 마운트 직후 정리를 한 번 돌렸다 다시 세운다. 예전엔 정리만
    // 있어서 이 표시가 처음부터 켜진 채 남았고, 도착한 제안을 "닫힌 뒤 늦게 온 것"으로 치워 "만드는 중"에 멈췄다.
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      const m = metaRef.current;
      const ai = useAiStore.getState();
      if (m && !m.pending && ai.lastProposal && ai.lastProposalNoteId === m.noteId) ai.clearProposal();
    };
  }, []);

  const phase: "compose" | "running" | "review" = gateSession
    ? gateSession.status === "pending" ? "running" : "review"
    : inFlight ? "running" : "compose";
  // 빛줄기는 AI 가 일하는 동안에만(상시 금지, 오너 2026-09-27).
  const beam = useGenerationBeam(phase === "running" || !!meta?.pending);
  // 결과·메타 단계(그릴링 세션 2026-09-28) — 위 2단(프리셋·요청문)이 타이트해지고 아래 전체 폭으로
  // 결과/메타 패널이 선다. `meta` 는 `phase` 가 아직 "compose"로 보일 때도 뜰 수 있다(따로 분리된 상태값)
  // — 그래서 phase 하나만으로는 못 잡는다.
  const stageActive = phase !== "compose" || !!meta;
  // 텍스트·시트·관계도 결과가 오면 버전으로 남기고, 보던 이전 버전에서 최신으로 돌아온다.
  useEffect(() => {
    if (!gateSession || gateSession.status !== "result") return;
    const text = typeof gateSession.resultRaw === "string" ? gateSession.resultRaw : (gateSession.resultText ?? "");
    const input = lastInputRef.current;
    if (!text.trim() || !input) return;
    const key = gateSession.requestId;
    const format: OutputFormat = gateSession.kind ?? "text";
    setVersions((prev) =>
      prev.some((v) => v.key === key)
        ? prev
        : [
            ...prev,
            {
              key,
              input,
              text,
              target: gateSession.target,
              format,
              model: gateSession.model,
              provider: gateSession.provider,
              durationMs: gateSession.durationMs,
              replaceBase: input.where === "replace" ? lastBaseRef.current : undefined,
            },
          ],
    );
    setViewKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 새 결과(요청 id·상태)에만 반응
  }, [gateSession?.requestId, gateSession?.status]);
  useEffect(() => {
    if (!inFlight || gateSession) return;
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [inFlight, gateSession]);
  // 닫기(X·Esc·스크림) = 버리기. 아직 결정되지 않은 이 모달의 세션이 남아 있으면 풀어 준다 — 안 풀면
  // 실행기가 결정을 영영 기다린다. [삽입] 뒤에 닫힐 때는 세션이 이미 치워져 있어 아무 일도 없다.
  useEffect(
    () => () => {
      if (useAiResultGateStore.getState().session?.embedded) finalizeGateDecision("discard");
    },
    [],
  );
  // 열 때 한 번 읽는다 — 이 모달이 살아 있는 동안 기록이 늘어나는 유일한 순간은 보내기 = 닫기다.
  const [history] = useState<AskAiHistoryEntry[]>(() => askAiHistory.list());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  /** 참조를 줄에 더한다(중복이면 무시) — `/`·첨부·프리셋 `needs` 가 모두 여기를 지난다. */
  const addRef = useCallback((ref: CtxRef) => {
    setCtxList((prev) => (prev.some((i) => sameRef(i.ref, ref)) ? prev : [...prev, { ref, active: true, removable: true }]));
  }, []);

  // 빈 노트(대상 노트가 지금 열린 노트이고 글자가 0)면 요약·태그·분리가 전부 헛일이다 — 경고 한 줄과 함께
  // 시작 프리셋(`blank`, 글 시작하기 등)만 보인다(`new` 대상·빈 시트도 같다, PLAN-2026-09-27 §7-5).
  const emptyNote =
    target.kind === "note" && activeNote?.note.id === target.noteId && activeNote.sections.every((s) => !(s.body_md ?? "").trim());
  const emptySheet = isSheet && target.kind === "section" && !(target.sectionBody ?? "").trim();
  const blankTarget = isNew || emptyNote || emptySheet;
  const tiles = useMemo(() => tilesForTarget(kind, presetList, blankTarget), [blankTarget, kind, presetList]);
  const recentId = useMemo(() => askAiHistory.readRecentPreset(kind), [kind]);
  const activePreset: AiActionPreset | null = presetId ? tiles.find((p) => p.id === presetId) ?? findPreset(presetId) : null;

  const custom = docText(doc) !== docText(stampedDoc ?? []);
  const activeRefs = ctxList.filter((i) => i.active).map((i) => i.ref);
  // 보내는 첨부 = 컨텍스트 줄에 **보이고 켜진** file 칩이 있는 것뿐. 칩을 끄는 것은 "지금은 안 보낸다"는
  // 약속이고(AskAiContextStrip), 칩이 없는 첨부는 사용자가 볼 수 없다. 예전엔 buildPrompt 가 둘 다
  // "참조 안 된 첨부"로 보고 그대로 끝에 붙였다.
  const sendAttached = attached.filter((f) => ctxList.some((i) => i.active && i.ref.k === "file" && i.ref.name === f.name));
  const hasContent = doc.some((p) => p.t !== "text" || p.v.trim());
  // 스위치는 대상 노트가 있을 때만 보이고, 결과가 그 노트 안에 쓰이는 위치에서만 켤 수 있다.
  const metaApplies = metadataFollows(where);
  const metaHint = metaApplies ? t("ai.meta_toggle_hint") : where === "proposal" ? t("ai.meta_toggle_hint_proposal") : t("ai.meta_toggle_hint_note");

  // 매 렌더 계산 — 선택 풀림·관계도 마운트는 스토어 밖 상태라 deps 로 잡을 수 없고, 값도 싸다.
  const allOptions = whereOptions(target, liveState(target));
  const options = isNew ? allOptions.filter((o) => o.value === "note") : allOptions;

  const pickPreset = (p: AiActionPreset) => {
    const d = stampFor(p);
    setDoc(d);
    setStampedDoc(d);
    setPresetId(p.id);
    const nextWhere = defaultWhere(target, p.where);
    setWhere(nextWhere);
    if (nextWhere === "replace") {
      setOutputFormat(defaultFormat);
    } else {
      if (p.kind === "sheet") setOutputFormat("sheet");
      else if (p.kind === "diagram") setOutputFormat("diagram");
      else setOutputFormat("text");
    }
    setGhost(null);
    // D17 — 프리셋이 필요로 하는 참조가 줄에 없으면 활성으로 더한다. "body" 는 **대상의 본문**이라
    // 선택 영역·섹션 대상에서는 그 대상의 참조로 바뀐다.
    for (const need of p.needs ?? []) {
      const ref: CtxRef | null =
        need === "body" ? targetRef
          : need === "selection" ? { k: "selection" }
            : need === "weather" ? { k: "weather" }
              : null;
      if (ref) addRef(ref);
    }
    askAiHistory.writeRecentPreset(kind, p.id);
  };

  const initialStampedRef = useRef(!!initialPreset);
  useEffect(() => {
    if (initialStampedRef.current || !initialPresetId) return;
    const p = lookupPreset(initialPresetId);
    if (p) {
      initialStampedRef.current = true;
      pickPreset(p);
    }
  }, [initialPresetId, presetList]);

  const pickHistory = (h: AskAiHistoryEntry) => {
    setDoc(h.doc);
    setStampedDoc(h.doc);
    setPresetId(h.presetId ?? null);
    // 상대 참조는 저장 시 body/selection 으로 벗겨져 있다 — 지금 대상에 다시 묶는다(D12·D18).
    const restored: CtxListItem[] = [];
    for (const ref of h.refs) {
      const bound: CtxRef = ref.k === "body" || ref.k === "selection" ? targetRef : ref;
      if (!restored.some((i) => sameRef(i.ref, bound))) restored.push({ ref: bound, active: true, removable: true });
    }
    // 그대로 따른다 — 그때 컨텍스트 없이 보낸 요청이면 지금도 없이 시작한다. 프리셋을 누르면
    // 그 프리셋의 `needs` 가 필요한 참조를 다시 심는다(D17).
    // 단, 지금 붙어 있는 첨부는 기록이 아니라 이 모달의 것이라 칩으로 남긴다 — 칩이 첨부의 유일한
    // 표면이어서, 여기서 칩을 잃으면 보이지도 지울 수도 없는 파일이 된다.
    for (const f of attached) {
      const ref: CtxRef = { k: "file", name: f.name };
      if (!restored.some((i) => sameRef(i.ref, ref))) restored.push({ ref, active: true, removable: true });
    }
    setCtxList(restored);
    const preset = h.presetId ? tiles.find((p) => p.id === h.presetId) ?? findPreset(h.presetId) : null;
    const allowed = h.where === "proposal" ? !!preset?.proposal : options.some((o) => o.value === h.where && !o.disabled);
    const nextWhere = allowed ? h.where : defaultWhere(target, preset?.where);
    setWhere(nextWhere);
    if (nextWhere === "replace") {
      setOutputFormat(defaultFormat);
    } else if (preset) {
      if (preset.kind === "sheet") setOutputFormat("sheet");
      else if (preset.kind === "diagram") setOutputFormat("diagram");
      else setOutputFormat("text");
    }
    if (h.folderId && folders.some((f) => f.id === h.folderId)) setFolderId(h.folderId);
    setGhost(null);
  };

  // D11 — 상자가 비었거나 마지막 스탬프 그대로일 때만 미리보기.
  const hover = (stamp: AskAiHoverStamp | null) => {
    if (!stamp) setGhost(null);
    else if (doc.length === 0 || !custom) setGhost(stamp.doc);
  };

  const readFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      if (!ACCEPT_EXT.includes(ext) && file.type && !file.type.startsWith("text/")) {
        emitNotice(t("ai.attach_rejected_type", { name: file.name }));
        continue;
      }
      if (file.size > MAX_ATTACH_BYTES) {
        emitNotice(t("ai.attach_rejected_size", { name: file.name }));
        continue;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = (e.target?.result as string) || "";
        addAttached(file.name, file.size, content);
      };
      reader.readAsText(file);
    }
  };
  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) readFiles(e.target.files);
    e.target.value = "";
  };
  const onDrag = (over: boolean) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(over);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) readFiles(e.dataTransfer.files);
  };
  // 컨텍스트 줄의 ✕ — file 칩이면 첨부 자체도 뺀다. 첨부 목록은 이 줄의 file 칩이 유일한 표면이라(드롭
  // 영역의 칩 줄은 중복이라 뺐다), 칩만 지우고 첨부를 남기면 buildPrompt 가 "참조 안 된 첨부"로 여전히 보낸다.
  const removeCtx = (idx: number) => {
    const ref = ctxList[idx]?.ref;
    setCtxList((prev) => prev.filter((_, i) => i !== idx));
    if (ref?.k === "file") {
      attachedRef.current = attachedRef.current.filter((f) => f.name !== ref.name);
      setAttached(attachedRef.current);
    }
  };

  // 네이티브 OS 경로(Tauri 드래그&드롭) 둘째 경로 — readFiles(브라우저 File)와 나란히,
  // SidebarChat.tsx::addDroppedPaths와 같은 모양. pet_chat_read_attach는 부작용 없는 미리보기용
  // 커맨드라 여기서도 그대로 재사용한다(첨부 테이블에 쓰지 않음). 이미지는 이번 범위가 아니다 —
  // vision 은 별도 백엔드 경로(VisionTransport)가 필요한 결정이라 미지원 안내만 띄운다.
  const addDroppedPaths = (paths: string[]) => {
    for (const path of paths) {
      void call<PetChatReadAttachOutput>("pet_chat_read_attach", { path })
        .then((res) => {
          if (res.kind === "doc" || res.excerpt) {
            const name = res.name;
            const content = res.excerpt ?? "";
            addAttached(name, content.length, content);
          } else {
            emitNotice(t("ai.attach_unsupported_format", { name: res.name }));
          }
        })
        .catch(() => {
          /* call() 이 AppError 토스트를 이미 표출함 */
        });
    }
  };
  // lib/useFileDropZone.ts 공용 훅 — HTML5 onDrop(readFiles)과 나란한 둘째 드롭 경로. 같은
  // 드롭존 컨테이너(AskAiAttachmentDropzone의 dropRef)를 잰다.
  useFileDropZone(
    () => dropZoneRef.current,
    {
      onDrop: (paths, _pos, inside) => {
        if (!inside) return;
        addDroppedPaths(paths);
      },
    },
  );

  const sections = activeNote?.sections ?? [];
  const bodyChars = sections.reduce((n, s) => n + (s.body_md?.length ?? 0), 0);
  const chars = (n: number) => t("ai.ctx_chars", { count: n.toLocaleString() });
  const noteTitle = (id: string) => Object.values(notesByFolder).flat().find((n) => n.id === id)?.title;
  const folderNotes = (id: string) => notesByFolder[id]?.length ?? 0;
  const currentFolderId = activeNote?.note.folder_id ?? folders[0]?.id ?? null;

  const describeRef: DescribeRef = (ref) => {
    switch (ref.k) {
      case "body":
        // D19 — 옛 헤더의 `📄 노트 · 4 섹션 · 1,846자` 가 여기로 왔다.
        return {
          // 대상 노트의 제목이 먼저 — 다른 노트가 열린 채로 이 모달이 뜰 수 있다(탭·컨텍스트 메뉴).
          label: (target.kind === "note" ? target.noteTitle : activeNote?.note.title) || t("ai.ctx_token_body"),
          size: activeNote ? `${t("ai.ctx_sections", { count: sections.length })} · ${chars(bodyChars)}` : undefined,
        };
      case "section": {
        const s = sections.find((x) => x.id === ref.id);
        return { label: s?.name || t("ai.ctx_section_fallback"), size: s ? chars(s.body_md.length) : undefined };
      }
      case "selection":
        return { label: t("ai.ctx_selection_label"), size: target.kind === "selection" ? chars(target.selectedText.length) : undefined };
      case "note":
        return { label: noteTitle(ref.id) || t("ai.ctx_token_note") };
      case "file": {
        const f = attached.find((x) => x.name === ref.name);
        return { label: ref.name, size: f ? formatFileSize(f.size) : undefined };
      }
      case "folder": {
        const f = folders.find((x) => x.id === ref.id);
        return { label: f?.name || t("ai.ctx_item_folder"), size: t("ai.ctx_folder_notes", { count: folderNotes(ref.id) }) };
      }
      case "weather":
        return { label: t("ai.ctx_item_weather") };
      case "result": {
        const i = versions.findIndex((v) => v.key === ref.key);
        return { label: t("ai.ctx_result_label", { n: i + 1 }), size: i >= 0 ? chars(versions[i].text.length) : undefined };
      }
    }
  };

  const already = (ref: CtxRef) => ctxList.some((i) => sameRef(i.ref, ref));
  const ctxEntry = (ref: CtxRef, rest: Omit<CtxItem, "action" | "id">, id: string): CtxItem => ({
    id,
    ...rest,
    meta: already(ref) ? t("ai.ctx_meta_added") : rest.meta,
    disabled: rest.disabled || already(ref),
    action: () => addRef(ref),
  });

  const groupCurrent = t("ai.ctx_group_current");
  const groupBook = t("ai.ctx_group_notebook");
  const groupOutside = t("ai.ctx_group_outside");
  const hasWeatherLocation = !!savedWeatherLocation();
  // `/` = 지금 붙일 수 있는 컨텍스트 목록(D16). 고르면 문장이 아니라 위 줄에 더해진다.
  const ctxItems: CtxItem[] = [
    ctxEntry({ k: "body" }, { icon: IconNote, label: t("ai.ctx_item_body"), meta: activeNote ? chars(bodyChars) : undefined, group: groupCurrent, disabled: !activeNote }, "body"),
    ...sections.map((s) =>
      ctxEntry({ k: "section", id: s.id }, { icon: IconBulletList, label: s.name || t("ai.ctx_section_fallback"), meta: chars(s.body_md.length), group: groupCurrent }, `section-${s.id}`),
    ),
    ctxEntry(
      { k: "selection" },
      {
        icon: IconHighlight,
        label: t("ai.ctx_selection_label"),
        meta: target.kind === "selection" ? chars(target.selectedText.length) : t("ai.ctx_meta_no_selection"),
        group: groupCurrent,
        disabled: target.kind !== "selection",
      },
      "selection",
    ),
    ctxEntry(
      { k: "folder", id: currentFolderId ?? "" },
      {
        icon: IconFolder,
        label: t("ai.ctx_item_folder"),
        meta: currentFolderId ? t("ai.ctx_folder_notes", { count: folderNotes(currentFolderId) }) : undefined,
        group: groupBook,
        disabled: !currentFolderId,
      },
      "folder",
    ),
    { id: "note", icon: IconNote, label: t("ai.ctx_item_note_other"), group: groupBook, action: () => setNotePicker(true) },
    { id: "file", icon: IconPaperclip, label: t("ai.ctx_item_file"), group: groupOutside, action: () => fileInputRef.current?.click() },
    ctxEntry(
      { k: "weather" },
      {
        icon: IconWeatherSun,
        label: t("ai.ctx_item_weather"),
        meta: hasWeatherLocation ? undefined : t("ai.ctx_meta_no_location"),
        group: groupOutside,
        disabled: !hasWeatherLocation,
      },
      "weather",
    ),
  ];

  // 도구 항목(자동 각주·관계도 진행도, §7-5) — 요청 문장이 아니라 전용 실행기다. 설명은 읽기 전용, 주 버튼은 [실행],
  // 위치 대신 「검토 후 적용」(둘 다 결과 게이트를 거친다).
  const toolActive = activePreset?.kind === "tool" && !custom;
  const fixedLabel = activePreset?.where === "proposal" || toolActive ? activePreset?.name : undefined;
  const placeholder = isNew ? t("presets.ai_topic_placeholder") : isDiagram ? t("mobile.diagram_edit_placeholder") : isSheet ? t("ai.sheet_prompt_placeholder") : t("ai.prompt_placeholder");
  const describeWhere = (w: AskAiWhere) =>
    w === "section" ? t("ai.where_section") : w === "note" ? t("ai.where_note") : w === "replace" ? t("ai.where_replace") : t("ai.review_before_apply");

  // 프리셋으로 저장(오너 2026-09-27) — 지금 요청문을 AI 프리셋으로 곧장 남긴다(이름은 첫 줄, 연필로 고친다).
  // 숨기는 때: 스탬프한 프리셋 그대로(저장할 새것이 없다 — 슬롯 값만 바꾼 것도 같은 템플릿이다), 제안형(메타·태그 —
  // 출력 형식이 앱 고정이라 커스텀 종류가 없다), 「결과 n」을 붙인 다듬기 지시(그 결과 없이는 뜻이 없다), 삽입 뒤.
  const presetTemplate = activePreset ? docToTemplate(stampFor(activePreset)).trim() : null;
  const canSavePreset =
    !isNew && hasContent && where !== "proposal" && meta?.source !== "followUp" &&
    !activeRefs.some((r) => r.k === "result") && docToTemplate(doc).trim() !== presetTemplate &&
    activePreset?.kind !== "tool";

  const savePreset = async () => {
    // 로드 전에 저장하면 addCustom 이 기본값 목록 위에 써서 사용자 목록을 덮는다(AiActionAutoAdd 와 같은 이유).
    if (!useAiPresetsStore.getState().loaded) await useAiPresetsStore.getState().load();
    const firstLine = serialize(doc).instruction.split("\n")[0].trim();
    const name = (firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine) || t("ai.action_new_name");
    // "+추가"와 같은 종류·대상 — 그래야 이 대상의 타일로 뜬다(tilesForTarget).
    const { kind: presetKind, targets } = autoAddFor(kind);
    // 켜 둔 참조 중 프리셋이 선언할 수 있는 것만(pickPreset 이 되살리는 셋) — 대상 본문은 "body" 다.
    const needs: CtxKind[] = [];
    for (const r of activeRefs) {
      const k: CtxKind | null = sameRef(r, targetRef) ? "body" : r.k === "selection" || r.k === "weather" ? r.k : null;
      if (k && !needs.includes(k)) needs.push(k);
    }
    const prevIds = new Set(useAiPresetsStore.getState().list.map((p) => p.id));
    await useAiPresetsStore.getState().addCustom(name, docToTemplate(doc), presetKind, targets, { where: where === "section" ? undefined : where, needs });
    const created = useAiPresetsStore.getState().list.find((p) => !prevIds.has(p.id));
    if (!created) return; // 저장 실패 — withPersist 가 목록을 되돌리고 알렸다
    setPresetId(created.id);
    setStampedDoc(doc);
    emitNotice(t("ai.preset_saved", { name: created.name }));
  };

  const send = () => {
    if (targetLocked) return;
    if (!hasContent && sendAttached.length === 0) return;
    for (const p of doc) {
      if (p.t === "slot" && p.kind === "text" && !p.v.trim()) {
        focusSlot(editorRef.current, p.key);
        return;
      }
    }
    const { input, signature } = buildContentRequest({ doc, list: ctxList, presetId, where, folderId });
    const proposal = input.proposal;
    // 히스토리는 **보내기를 누른 순간** 기록한다 — 게이트에서 취소해도 문장은 다시 꺼낼 가치가 있고,
    // 닫힌 뒤엔 이 컴포넌트가 없어 기록할 자리가 없다.
    askAiHistory.push({
      doc,
      refs: activeRefs,
      where,
      folderId: where === "note" ? folderId : undefined,
      targetKind: kind,
      noteTitle: target.kind === "note" ? target.noteTitle : activeNote?.note.title ?? "",
      presetId: presetId ?? undefined,
    });
    // 분리 제안만 모달을 열어 둔다 — 계획을 이 안의 AiAgentReviewModal 이 받는다.
    if (proposal === "split" && where === "proposal") {
      void AiAgentReviewModal.preload(); // 계획이 오면 바로 띄우게 — AI 응답을 기다리는 동안 받는다.
      void (async () => {
        try {
          const res = await dispatchAskAi(input);
          if (res?.plan) setReviewPlan(res.plan);
          else onClose();
        } catch {
          onClose();
        }
      })();
      return;
    }
    // 메타·태그 제안도 이 안에서 받는다(AskAiMetaPanel) — 예전엔 모달이 닫히고 독립 확인 창이 따로 떴다.
    if (where === "proposal") {
      if (!targetNoteId) return;
      const seq = ++sendSeqRef.current;
      const work = dispatchAskAi(input).catch((e: unknown) => reportFallback("askai", "proposal_failed", String(e)));
      void hostProposal(targetNoteId, "proposal", work, seq);
      return;
    }
    runDispatch(input, signature);
  };

  // 어시스트 "바로 실행"(§7-4) — 스탬프가 들어간 **직후 한 번만** 판단한다. 채워야 할 칸이 비어 있으면 보내지 않고
  // 그 칸으로 커서를 옮긴다. 예전엔 doc 변화마다 다시 판단해, 칸에 첫 글자를 치는 순간 요청이 나갔다(2026-09-28 검토 S6).
  const autoSendFiredRef = useRef(false);
  useEffect(() => {
    if (!initialAutoSend || autoSendFiredRef.current) return;
    // 프리셋을 찍지 못했으면(목록에 없다) 자동으로 보내지 않는다 — 안 그러면 사용자가 글자를 치는 순간 나간다.
    if (!initialPreset) {
      autoSendFiredRef.current = true;
      return;
    }
    if (!hasContent) return;
    autoSendFiredRef.current = true;
    if (targetLocked) return;
    if (target.kind === "section") {
      if (target.isDiagram && !target.diagramMounted) return;
      if (target.isSheet && !target.sheetMounted) return;
    }
    const empty = doc.find((p) => p.t === "slot" && p.kind === "text" && !p.v.trim());
    if (empty && empty.t === "slot") {
      focusSlot(editorRef.current, empty.key);
      return;
    }
    send();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 스탬프 직후 한 번(hasContent 가 처음 참이 될 때)
  }, [initialAutoSend, hasContent]);

  /** 보낼 요청과 그 지문을 **넘겨받은 값으로** 만든다 — 상태를 바꾼 직후 같은 틱에 보내는 경로("이어서
   *  다듬기")가 옛 렌더의 값을 쓰지 않게. 지문은 문장만이 아니라 무엇을 붙여(켜진 참조·보낼 첨부) 어디로
   *  (위치·폴더) 무엇과 함께(메타데이터 스위치·프리셋) 보냈는가 — 결과를 보는 중 이 중 하나라도 바뀌면
   *  Enter 는 "다시 생성"이 아니라 "고쳐서 다시"다(칩만 끄고 Enter 했는데 끈 본문이 또 가면 안 된다). */
  const buildContentRequest = (o: {
    doc: ComposerDoc;
    list: CtxListItem[];
    presetId: string | null;
    where: AskAiWhere;
    folderId: string | null;
    format?: OutputFormat;
  }) => {
    const refs = o.list.filter((i) => i.active).map((i) => i.ref);
    const files = attached.filter((f) => o.list.some((i) => i.active && i.ref.k === "file" && i.ref.name === f.name));
    const preset = o.presetId ? tiles.find((p) => p.id === o.presetId) ?? findPreset(o.presetId) : null;
    const req = serialize(o.doc);
    const title = req.instruction.replace(/\s+/g, " ").slice(0, 30) || preset?.name || files[0]?.name || t("ai.ask_ai");
    const includeMetadata = () => !isNew && includeMetaRef.current && metadataFollows(o.where);
    const chosenFormat = o.format ?? outputFormat;
    const effectivePresetKind =
      o.where === "replace"
        ? (isDiagram ? "diagram" : isSheet ? "sheet" : preset?.kind)
        : (chosenFormat !== "text" ? chosenFormat : preset?.kind);
    const input: DispatchInput = {
      req, refs, where: o.where, proposal: preset?.proposal, folderId: o.folderId, target, attached: files, title,
      presetId: o.presetId ?? undefined, presetKind: effectivePresetKind, includeMetadata,
      results: Object.fromEntries(versions.map((v) => [v.key, v.text])),
    };
    // Q9-b: m: includeMetadata를 지문에서 제외! 스위치 토글이 Enter 뜻(다시 생성 vs 새 요청)을 바꾸지 않게.
    const signature = JSON.stringify({
      i: req.instruction, r: refs, w: o.where, f: o.where === "note" ? o.folderId : null,
      a: files.map((f) => f.name), p: o.presetId, fmt: chosenFormat,
    });
    return { input, signature };
  };

  /** 내용 경로 — 닫지 않고 결과를 이 안에서 받는다. 반영(true)되면 닫고, 버렸거나 실패하면 요청문을
   *  그대로 둔 채 작성 단계로 돌아온다. `signature` 가 null 이면(이전 버전 삽입) "마지막으로 보낸 요청"을
   *  바꾸지 않는다. 값은 전부 인자로 받는다 — 상태를 바꾼 직후 같은 틱에 불러도 옛 렌더 값을 쓰지 않게. */
  const runDispatch = (input: DispatchInput, signature: string | null) => {
    const seq = ++sendSeqRef.current;
    if (signature != null) lastSentRef.current = signature;
    lastInputRef.current = input;
    if (!input.cachedResult) {
      const live = input.where !== "replace" ? null : isSheet ? getSheetTarget() : isDiagram ? getDiagramTarget() : null;
      lastBaseRef.current = live ? { sectionId: live.sectionId, source: live.source } : undefined;
      // D2② W4 — 텍스트 섹션 교체: 이 결과가 읽은 섹션 버전 토큰을 버전에 함께 남긴다. 이전 버전 삽입이 그 사이의
      // 편집을 덮지 않게(askAiDispatch `cachedBase.token`). dispatch 의 flush 전에 잡으므로 대기 중이던 편집이 있었다면
      // 한 박자 낡을 수 있다 — 그 경우는 CONFLICT → 새 섹션 삽입이라 덮는 쪽으로는 틀리지 않는다.
      if (input.where === "replace" && target.kind === "section" && !isSheet && !isDiagram) {
        lastBaseRef.current = { sectionId: target.sectionId, source: target.sectionBody, token: getSectionToken(target.sectionId) };
      }
    }
    setInFlight(true);
    setInFlightAt(Date.now());
    // 안쪽 경로들은 제 실패를 토스트로 알린다 — 여기 오는 건 그 밖의 예외라 진단에만 남기고 작성 단계로 돌아온다.
    const run = dispatchAskAi(input).catch((e: unknown) => {
      reportFallback("askai", "dispatch_failed", String(e));
      return undefined;
    });
    inflightRef.current = run;
    void run.then(async (res) => {
      if (seq !== sendSeqRef.current) return; // 그 사이 "고쳐서 다시"가 새로 보냈다
      inflightRef.current = null;
      setInFlight(false);
      if (!res?.applied) return;
      const noteId = targetNoteId;
      // 후속 여부는 dispatch 가 반영 순간의 스위치 값으로 이미 정했다(Q9-b) — 여기서 다시 판단하면 옛 렌더의 값을 본다.
      if (!res.followUp || !noteId) return onClose();
      // 메타데이터 포함 — 닫지 않고 제안을 이 안에서 기다린다.
      await hostProposal(noteId, "followUp", res.followUp, seq);
    });
  };

  /** 그 노트의 메타데이터 제안을 이 안에서 기다린다. 도착하면 검토, 없으면(실패 — 토스트는 organize 쪽이 띄웠다,
   *  또는 제안할 것 없음) 삽입 뒤라면 닫고 제안 요청이었다면 작성으로 돌아온다. 호스트 표시는 기다리기 **전에**
   *  세운다 — 제안이 먼저 도착하면 독립 확인 창이 한 번 그린다. */
  const hostProposal = async (noteId: string, source: "proposal" | "followUp", work: Promise<unknown>, seq: number) => {
    useProposalHostStore.setState({ noteId });
    setMeta({ noteId, pending: true, source });
    await work;
    const ai = useAiStore.getState();
    const arrived = !!ai.lastProposal && ai.lastProposalNoteId === noteId;
    if (closedRef.current) {
      // 그 사이 모달이 닫혔다 = 건너뛰었다 — 늦게 온 제안을 치우고(독립 창으로 튀지 않게), 붙들어 두었던 호스트
      // 표시를 이제 내려놓는다(아직 이 노트를 가리킬 때만).
      if (arrived) ai.clearProposal();
      if (useProposalHostStore.getState().noteId === noteId) useProposalHostStore.setState({ noteId: null });
      return;
    }
    if (seq !== sendSeqRef.current) return; // 그 사이 새로 보냈다
    if (arrived) setMeta({ noteId, pending: false, source });
    else if (source === "followUp") onClose();
    else setMeta(null);
  };

  /** 지금 화면 상태로 보낼 요청의 지문(buildContentRequest). */
  const requestSignature = () => buildContentRequest({ doc, list: ctxList, presetId, where, folderId, format: outputFormat }).signature;

  /** 요청문 상자의 Enter. 작성 단계면 보내기. 결과를 보는 중이면 요청문이 그대로일 때 다시 생성, 고쳤으면
   *  지금 결과(또는 생성 중인 것)를 버리고 새로 보낸다. 확인 없이 도는 중(세션 없음)에는 무시한다 —
   *  취소할 손잡이가 없다. */
  /** 지금 결과(또는 생성 중인 것)를 버리고, 옛 실행이 끝나기를 기다린 뒤 `next` 를 부른다. */
  const replaceCurrent = (next: () => void) => {
    const previous = inflightRef.current;
    if (useAiResultGateStore.getState().session?.embedded) useAiResultGateStore.getState().decide("discard");
    void (async () => {
      await previous;
      next();
    })();
  };

  /** 이어서 다듬기 — 그 버전의 결과를 컨텍스트로 붙이고(`result` 참조, 이전 것은 갈아 끼운다) 칩의 지시문으로
   *  곧장 다시 보낸다. 사용자가 켜 둔 다른 컨텍스트는 그대로 둔다(예측 가능하게 — 대가는 토큰). 위치는 그
   *  버전의 것을 따른다. 요청문에 지시문이 보이고, 히스토리에는 남기지 않는다(그 결과 없이는 뜻이 없다). */
  const refine = (promptKey: string, base: AskAiVersion) => {
    const nextList: CtxListItem[] = [...ctxList.filter((i) => i.ref.k !== "result"), { ref: { k: "result", key: base.key }, active: true, removable: true }];
    const nextDoc: ComposerDoc = [{ t: "text", v: t(promptKey) }];
    const nextWhere = base.input.where;
    const nextFolder = base.input.folderId ?? folderId;
    setCtxList(nextList);
    setDoc(nextDoc);
    setStampedDoc(nextDoc);
    setPresetId(null);
    setWhere(nextWhere);
    setFolderId(nextFolder);
    // 다듬기는 그 버전의 형식을 잇는다 — 안 맞추면 화면의 형식(다른 버전에서 바꾼 것)과 보낸 요청이 어긋나 힌트가
    // 곧바로 "새 요청"이 되고, Enter 가 엉뚱한 형식으로 다시 보낸다.
    setOutputFormat(base.format);
    setGhost(null);
    const { input, signature } = buildContentRequest({ doc: nextDoc, list: nextList, presetId: null, where: nextWhere, folderId: nextFolder, format: base.format });
    replaceCurrent(() => runDispatch(input, signature));
  };

  /** 형식 변환 다듬기(W3 §3.7) — 그 버전의 결과를 컨텍스트로 붙이고(「결과 n」) 지정된 형식으로 변경하여 다시 요청. */
  const refineFormat = (targetFormat: OutputFormat, promptKey: string, base: AskAiVersion) => {
    const nextList: CtxListItem[] = [...ctxList.filter((i) => i.ref.k !== "result"), { ref: { k: "result", key: base.key }, active: true, removable: true }];
    const nextDoc: ComposerDoc = [{ t: "text", v: t(promptKey) }];
    const nextWhere = base.input.where;
    const nextFolder = base.input.folderId ?? folderId;
    setCtxList(nextList);
    setDoc(nextDoc);
    setStampedDoc(nextDoc);
    setPresetId(null);
    setWhere(nextWhere);
    setFolderId(nextFolder);
    setOutputFormat(targetFormat);
    setGhost(null);
    const { input, signature } = buildContentRequest({
      doc: nextDoc,
      list: nextList,
      presetId: null,
      where: nextWhere,
      folderId: nextFolder,
      format: targetFormat,
    });
    replaceCurrent(() => runDispatch(input, signature));
  };

  /** 이전 버전을 그대로 삽입 — 생성하지 않는다. 히스토리에 새로 남기지 않는다(그때 이미 남았다). */
  const insertVersion = (v: AskAiVersion) =>
    replaceCurrent(() => runDispatch({ ...v.input, cachedResult: v.text, presetKind: v.format, cachedBase: v.replaceBase }, null));

  const submit = () => {
    if (meta) {
      // 삽입 뒤 제안·만드는 중에는 요청문이 쉰다. 제안 요청을 보는 중이면 고친 요청문으로 다시 보낸다 — 위치가
      // 내용 쪽으로 바뀌었으면(다른 타일을 골랐다) 제안을 버리고 그 요청을 보낸다.
      if (meta.source !== "proposal" || meta.pending) return;
      if (where !== "proposal") {
        setMeta(null);
        useAiStore.getState().clearProposal();
      }
      return send();
    }
    if (phase === "compose") return send();
    if (!gateSession) return;
    const changed = requestSignature() !== lastSentRef.current;
    if (!changed) {
      if (gateSession.status !== "pending") {
        // 다시 생성하는 동안 이전 버전 화면을 걷는다 — 남아 있으면 생성 중 표시와 [중단]이 가려지고 옛 버전 [삽입]이 눌린다.
        setViewKey(null);
        useAiResultGateStore.getState().decide("retry");
      }
      return;
    }
    replaceCurrent(send);
  };

  // 버전 넘기개 — 결과를 보는 중이고 버전이 둘 이상일 때만.
  const liveIndex = gateSession ? versions.findIndex((v) => v.key === gateSession.requestId) : -1;
  // 지금 것이 버전이 아니면(다시 생성이 오류로 끝남 등) 넘기개 끝에 한 칸으로 센다 — 안 그러면 좋은 결과가
  // 하나뿐일 때 넘기개가 사라져, 다시 해 본 대가로 그 결과를 영영 못 꺼낸다.
  const liveExtra = phase === "review" && !!gateSession && liveIndex < 0;
  const liveSlot = liveExtra ? versions.length : liveIndex;
  const slotCount = versions.length + (liveExtra ? 1 : 0);
  const viewing = viewKey ? versions.find((v) => v.key === viewKey) ?? null : null;
  const viewIndex = viewing ? versions.indexOf(viewing) : liveSlot >= 0 ? liveSlot : versions.length - 1;
  const goVersion = (i: number) => {
    if (i === liveSlot) return setViewKey(null);
    const v = versions[i];
    if (v) setViewKey(v.key);
  };
  // 이어서 다듬기 — 보고 있는 결과(이전 버전이든 지금 것이든)
  const refineBase = viewing ?? (liveIndex >= 0 ? versions[liveIndex] : null);
  const currentFormat = viewing ? viewing.format : (gateSession?.kind ?? "text");
  const refineChips =
    phase === "review" && refineBase ? (
      <div className="askai-refine" role="group" aria-label={t("ai.refine_group")} data-testid="askai-refine">
        {REFINES.map((r) => (
          <button key={r.label} type="button" className="askai-refine__chip" title={t(r.prompt)} onClick={() => refine(r.prompt, refineBase)}>
            {t(r.label)}
          </button>
        ))}
        {/* 형식 바꾸기는 새 섹션·새 노트로 들어갈 결과에만 — 교체는 대상의 종류가 형식을 정한다(텍스트 섹션에 시트를 쓸 수 없다). */}
        {refineBase.input.where !== "replace" && <span className="askai-refine__sep" aria-hidden="true" />}
        {refineBase.input.where !== "replace" && FORMAT_REFINES.filter((f) => f.format !== currentFormat).map((f) => (
          <button
            key={f.format}
            type="button"
            className="askai-refine__chip"
            data-testid={`askai-refine-${f.format}`}
            title={t(f.prompt)}
            onClick={() => refineFormat(f.format, f.prompt, refineBase)}
          >
            {t(f.label)}
          </button>
        ))}
      </div>
    ) : null;

  const pager =
    phase === "review" && slotCount > 1 ? (
      <span className="askai-pager" data-testid="askai-version-pager">
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t("ai.version_prev")} title={t("ai.version_prev")} disabled={viewIndex <= 0} onClick={() => goVersion(viewIndex - 1)}>
          <IconCaret dir="left" size={14} />
        </button>
        <span className="askai-pager__pos">{t("ai.version_pos", { i: viewIndex + 1, n: slotCount })}</span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label={t("ai.version_next")} title={t("ai.version_next")} disabled={viewIndex >= slotCount - 1} onClick={() => goVersion(viewIndex + 1)}>
          <IconCaret dir="right" size={14} />
        </button>
      </span>
    ) : null;

  return (
    // 빛줄기는 상시로 두르지 않는다(오너 2026-09-27 — "모달에 항상 나오면 안 된다") — 생성 중에만.
    <ModalShell title={<AskAiHeader dest={dataDest} onHelp={() => setShowWelcome(true)} />} ariaLabel={t("ai.ask_ai")} onClose={metaApplying ? () => {} : onClose} width={720} aiGlow={beam}>
      {/* 결과·메타 단계(그릴링 세션 2026-09-28, Q1·Q4·Q6) — data-stage 가 있으면 위 2단은 타이트해지고
          .askai-modal-stage 가 그 아래 전체 폭(2단 너비 다 씀)으로 선다. 총 높이는 그대로(안 흔들리게),
          행만 둘로 나뉜다(tokens.css). */}
      <div className="askai-modal-body" data-meta={meta?.source === "followUp" ? "" : undefined} data-stage={stageActive ? "" : undefined}>
        <div className="askai-modal-top">
          <AskAiTileGrid
            tiles={tiles}
            history={history}
            selectedId={custom ? null : presetId}
            recentId={recentId}
            custom={custom && hasContent}
            onPick={pickPreset}
            onPickHistory={pickHistory}
            onHover={hover}
            onEdit={() => setPresetEditor({ add: false, selectId: presetId ?? undefined })}
            onAdd={() => setPresetEditor({ add: true })}
            stampFor={stampFor}
            describeHistoryWhere={describeWhere}
          />
          <div className="askai-modal-right" data-phase={meta ? "meta" : phase}>
            {targetLocked && (
              <p
                className="askai-modal-hint askai-modal-hint--warn"
                data-testid="askai-locked-banner"
              >
                {t("editor.ask_ai_note_locked_banner")}
              </p>
            )}
            {emptyNote && <p className="askai-modal-hint askai-modal-hint--warn">{t("ai.empty_note_warning")}</p>}
            {/* 상자 위 한 줄 — 무엇을 보내나(컨텍스트 칩) + 메타데이터도 고치나(스위치). 높이는 좌 탭 줄과
                같아서(--askai-head-h) 타일 그리드와 요청문 상자의 윗변이 맞는다. */}
            <div className="askai-modal-ctxrow">
              <AskAiContextStrip
                items={ctxList}
                describeRef={describeRef}
                onToggle={(i) => setCtxList((prev) => prev.map((item, idx) => (idx === i ? { ...item, active: !item.active } : item)))}
                onRemove={removeCtx}
              />
              {!isNew && (
                <div className="askai-meta" data-on={includeMeta && metaApplies} data-disabled={!metaApplies} title={metaHint}>
                  <span className="askai-meta__label" onClick={() => metaApplies && setIncludeMeta((v) => !v)}>
                    {t("ai.meta_toggle")}
                  </span>
                  <Toggle
                    checked={includeMeta && metaApplies}
                    disabled={!metaApplies}
                    onChange={setIncludeMeta}
                    aria-label={t("ai.meta_toggle")}
                    data-testid="askai-meta-toggle"
                  />
                </div>
              )}
            </div>
            {showWelcome ? (
              <AskAiWelcomeCard dest={dataDest} onStart={dismissWelcome} />
            ) : (
              <AskAiAttachmentDropzone dropRef={dropZoneRef} isDragging={isDragging} onDragOver={onDrag(true)} onDragLeave={onDrag(false)} onDrop={onDrop}>
                <AskAiComposer
                  value={doc}
                  onChange={setDoc}
                  placeholder={placeholder}
                  ctxItems={ctxItems}
                  onSubmit={submit}
                  ghost={ghost}
                  autoFocus
                  editorRef={editorRef}
                  disabled={meta?.source === "followUp" || toolActive}
                />
                <div className="askai-composer-footer-hints">
                  {phase === "review" && gateSession && (
                    <span className="askai-composer-enter-hint" data-testid="askai-enter-hint">
                      {requestSignature() !== lastSentRef.current
                        ? t("ai.hint_enter_new_request")
                        : t("ai.hint_enter_regenerate")}
                    </span>
                  )}
                  {canSavePreset && (
                    <button
                      type="button"
                      className="askai-savepreset"
                      data-testid="askai-save-preset"
                      title={t("ai.save_preset_hint")}
                      aria-label={t("ai.save_preset")}
                      onClick={() => void savePreset()}
                    >
                      <IconBookmark size={13} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              </AskAiAttachmentDropzone>
            )}
            {!meta && phase === "compose" && hasContent && activeRefs.length === 0 && !isNew && <p className="askai-modal-hint" data-testid="askai-no-ctx-hint">{t("ai.composer_no_ctx_hint")}</p>}
            {!meta && phase === "compose" && <AskAiActionBar
              where={where}
              options={options}
              onWhere={(w) => {
                setWhere(w);
                if (w === "replace") {
                  setOutputFormat(defaultFormat);
                }
              }}
              fixedLabel={fixedLabel}
              format={outputFormat}
              onFormat={setOutputFormat}
              formatFixed={isFormatFixed}
              folderId={folderId}
              folders={folders}
              onFolder={setFolderId}
              attachedCount={attached.length}
              onAttach={() => fileInputRef.current?.click()}
              onHistory={() => {
                void (async () => {
                  try {
                    await call("ai_history_window_open", {});
                  } catch {
                    // call() 이 이미 토스트를 띄웠다.
                  }
                })();
              }}
              canSend={(hasContent || sendAttached.length > 0) && !targetLocked}
              sendLabel={toolActive ? t("ai.tool_run") : t("ai.send")}
              onSend={send}
            />}
            <input ref={fileInputRef} type="file" multiple accept={ACCEPT_EXT.join(",")} onChange={onFileInput} hidden data-testid="askai-file-input" />
          </div>
        </div>
        {/* 결과 단(전체 폭, Q6) — 메타데이터 승인이 있으면 위, 결과는 아래(AiResultPanel 이 그 순서를 이미 그린다). */}
        {stageActive && (
          <div className="askai-modal-stage" data-phase={meta ? "meta" : phase}>
            {meta ? (
              <AskAiMetaPanel
                pending={meta.pending}
                inserted={meta.source === "followUp"}
                applying={metaApplying}
                setApplying={setMetaApplying}
                cancelLabel={meta.source === "followUp" ? t("ai.meta_skip") : t("aiResult.discard_button")}
                onCancel={!meta.pending ? () => useAiStore.getState().clearProposal() : meta.source === "followUp" ? onClose : null}
                onApplied={onClose}
              />
            ) : (
              <>
                {/* 생성·검토 단계 — 요청문 상자 아래를 결과 패널이 채우고, 행동 줄도 패널의 것이다. */}
                {gateSession && !viewing && <AiResultPanel session={gateSession} inline pager={pager} refine={refineChips} />}
                {/* 이전 버전 보기 — 머리/몸/발과 행동 줄 통일 (§3.2, §3.3). 버튼은 [버리기] [다시 생성] [삽입]. */}
                {gateSession && viewing && (
                  <div className="ai-result-panel ai-result-panel--inline" data-testid="askai-version-view">
                    <div className="ai-result-box" data-status="result" data-testid="ai-result-box">
                      <div className="ai-result-box__head">
                        <span className="ai-result-box__title">{formatResultTitle(viewing.format)}</span>
                        <span className="ai-result-box__head-extra">
                          <button
                            type="button"
                            className="ai-result-box__raw-toggle"
                            data-testid="ai-result-raw-toggle"
                            title={viewingShowRaw ? t("aiResult.view_rendered") : t("aiResult.view_raw")}
                            onClick={() => setViewingShowRaw((v) => !v)}
                          >
                            {viewingShowRaw ? t("aiResult.view_rendered") : t("aiResult.view_raw")}
                          </button>
                          {pager}
                        </span>
                      </div>
                      <div className="ai-result-box__body">
                        <ResultPreview text={viewing.text} kind={viewing.format} showRaw={viewingShowRaw} inline />
                      </div>
                      {(viewing.model || viewing.durationMs !== undefined) && (
                        <div className="ai-result-box__foot">
                          <span className="ai-result-panel__meta-caption">
                            {viewing.model
                              ? t("aiResult.result_meta", {
                                  provider: viewing.provider ?? "",
                                  model: viewing.model,
                                  seconds: Math.round((viewing.durationMs ?? 0) / 1000),
                                })
                              : t("aiResult.result_meta_no_model", {
                                  seconds: Math.round((viewing.durationMs ?? 0) / 1000),
                                })}
                          </span>
                        </div>
                      )}
                    </div>
                    {refineChips}
                    <div className="ai-result-panel__actions">
                      <span className="ai-result-panel__target" data-testid="ai-result-target">{viewing.target}</span>
                      <button
                        type="button"
                        className="btn"
                        data-testid="askai-version-discard"
                        onClick={() => finalizeGateDecision("discard")}
                      >
                        {t("aiResult.discard_button")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        data-testid="askai-version-retry"
                        onClick={() => {
                          // 지금 요청을 그대로 다시(살아 있는 결과의 [다시 생성]과 같다) — 이전 버전 화면을 걷고 생성 중으로.
                          setViewKey(null);
                          useAiResultGateStore.getState().decide("retry");
                        }}
                      >
                        {t("aiResult.retry_button")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="askai-version-insert"
                        title={t("ai.version_insert_hint")}
                        onClick={() => insertVersion(viewing)}
                      >
                        {t("aiResult.insert_button")}
                      </button>
                    </div>
                  </div>
                )}
                {phase === "running" && !gateSession && (
                  <div className="askai-running" role="status" data-testid="askai-running">
                    {t("aiResult.status_generating", { elapsed: formatElapsed(clock - inFlightAt) })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {notePicker && (
        <InternalNotePicker
          excludeNoteId={activeNote?.note.id}
          onPick={(id) => {
            setNotePicker(false);
            addRef({ k: "note", id });
          }}
          onCancel={() => setNotePicker(false)}
        />
      )}
      {presetEditor && (
        <Suspense fallback={null}>
          <PresetManageModal
            aiOnly
            autoAdd={presetEditor.add ? autoAddFor(kind) : undefined}
            initialId={presetEditor.selectId}
            onClose={() => setPresetEditor(null)}
          />
        </Suspense>
      )}
      {reviewPlan && (
        <Suspense fallback={null}>
          <AiAgentReviewModal
            plan={reviewPlan}
            onClose={() => {
              setReviewPlan(null);
              onClose();
            }}
          />
        </Suspense>
      )}
    </ModalShell>
  );
}
