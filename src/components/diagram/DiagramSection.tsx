import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Section } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";
import { patchSectionBodyCache } from "../../lib/sectionBodyCache";
import { isSectionGated } from "../../lib/sectionTokens";
import { clearSaveFailed, markSaveFailed } from "../../lib/sectionSaveFailures";
import { BodyCollapseToggle } from "../BodyCollapseToggle";
import { registerFlush, emitNotice } from "../../lib/invoke";
import { registerDiagramTarget } from "../../lib/aiSectionBridge";
import { useDiagramFocus } from "../../stores/diagramFocus";
import { serializeDiagram } from "./diagramSchema";
import { useAiGlow, AI_GLOW_KEYS } from "../../stores/ai";
import { fetchNoteSummary } from "../../lib/noteSummaries";
import { t } from "../../i18n/t";
import {
  IconGrab,
  IconMouseDoubleClick,
  IconMousePointerClick,
} from "../icons";
import { parseDiagram, setNodeLink, type DiagramModel, type EdgeStyle, type NodeShape } from "./diagramModel";
import { makeDiagramActions, type Selection, type AddFromTextResult } from "./diagramActions";
import { DiagramInlineInput } from "./DiagramInlineInput";
import { DiagramControls } from "./DiagramControls";
import { canFlowRender } from "./flowLayout";

import { DiagramToolbar } from "./DiagramToolbar";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import { EditorGhostOverlay } from "../editor/EditorGhostOverlay";
import { InternalNotePicker } from "../attachments/InternalNotePicker";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { CheatsheetPopover, Gesture, Key, Sep, type CheatsheetItem } from "../common/CheatsheetPopover";
import { FlowCanvas } from "../../lazySurfaces";

const RENDER_DEBOUNCE_MS = 300;
const SAVE_DEBOUNCE_MS = 700;

const DIAGRAM_GESTURES = (): CheatsheetItem[] => [
  { heading: t("editor.diagram_heading_canvas") },
  { rule: [Gesture(IconGrab, t("common.gesture_drag"))], desc: t("editor.diagram_cheat1_desc") },
  { rule: [Gesture(IconGrab, t("editor.diagram_cheat2_key"))], desc: t("editor.diagram_cheat2_desc") },
  { rule: [Gesture(IconGrab, t("editor.diagram_cheat3_key"))], desc: t("editor.diagram_cheat3_desc") },
  {
    rule: [Key(t("common.key_shift")), Sep("+"), Gesture(IconGrab, t("common.gesture_drag"))],
    desc: t("editor.diagram_cheat5_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Gesture(IconMousePointerClick, t("common.gesture_click"))],
    desc: t("editor.diagram_cheat6_desc"),
  },
  { rule: [Gesture(IconMousePointerClick, t("editor.diagram_cheat7_key"))], desc: t("editor.diagram_cheat7_desc") },
  { rule: [Gesture(IconGrab, t("editor.diagram_cheat8_key"))], desc: t("editor.diagram_cheat8_desc") },

  { heading: t("editor.diagram_heading_edit") },
  { rule: [Gesture(IconMouseDoubleClick, t("common.gesture_dbl_click"))], desc: t("editor.diagram_cheat4_desc") },
  { rule: [Gesture(IconMouseDoubleClick, t("editor.diagram_cheat_edge_dbl_key"))], desc: t("editor.diagram_cheat_edge_dbl_desc") },
  { rule: [Key(t("common.key_delete"))], desc: t("editor.diagram_cheat9_desc") },

  { heading: t("editor.diagram_heading_history") },
  { rule: [Key(t("common.key_ctrl")), Sep("+"), Key("Z")], desc: t("editor.diagram_cheat10_desc") },
];

/**
 * DiagramTextForm — 텍스트 문법(D4) 입력 하나를 두 곳이 함께 쓴다: 빈 상태의 "텍스트로 시작"과
 * 캔버스 동사 "텍스트로 추가"(DiagramToolbar). 파싱은 호출자가 넘기는 `onSubmit`(보통
 * `actions.addFromText`)이 전부 맡는다 — 이 컴포넌트는 문법을 모른다, 텍스트를 받아 넘기고
 * {ok:false, error, line} 이 오면 그 줄만 보여줄 뿐이다.
 */
export function DiagramTextForm({
  onSubmit,
  onDone,
}: {
  onSubmit: (text: string) => AddFromTextResult;
  /** 성공적으로 반영된 뒤 호출자가 폼을 접고 싶을 때(캔버스 동사의 팝오버 닫기). 빈 상태는 안 넘긴다 —
   *  본문이 채워지면 showEmpty 자체가 꺼져 폼이 함께 사라진다. */
  onDone?: () => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<{ line: number; error: string } | null>(null);

  const submit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const res = onSubmit(trimmed);
    if (res.ok) {
      setErr(null);
      setText("");
      onDone?.();
    } else if (res.error) {
      setErr({ line: res.line ?? 0, error: res.error });
    }
  };

  return (
    <div className="diagram-text-form" data-testid="diagram-text-form">
      <DiagramInlineInput
        multiline
        className="field"
        testId="diagram-text-input"
        value={text}
        onChange={setText}
        placeholder={t("editor.diagram_text_placeholder")}
        onCommit={submit}
        style={{ width: "100%", minHeight: 72, padding: "var(--space-2)", fontFamily: "var(--font-mono)" }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
        <button type="button" className="btn btn--sm" data-testid="diagram-text-apply" onClick={() => submit(text)}>
          {t("editor.diagram_text_apply")}
        </button>
      </div>
      {err && (
        <div
          className="diagram-text-error"
          data-testid="diagram-text-error"
          role="alert"
          style={{ color: "var(--danger)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}
        >
          {t("editor.diagram_text_error", { line: err.line, error: t(`editor.diagram_text_err_${err.error}`) })}
        </div>
      )}
    </div>
  );
}

export function DiagramSection(props: { section: Section; touch?: boolean }) {
  return (
    <ErrorBoundary>
      <DiagramSectionInner {...props} />
    </ErrorBoundary>
  );
}

function DiagramSectionInner({ section, touch = false }: { section: Section; touch?: boolean }) {
  // 내용잠금 — 캔버스의 자체 pan/edit `locked` 토글(아래, 이름이 겹친다)과는 무관한 노트 단위
  // 잠금이다. 리액티브 구독은 JSX 표시(textarea readOnly)에만 쓴다 — 실제 쓰기 가드는
  // applyMutation/onTextChange/step/replaceSection에서 매번 getState()로 fresh하게 읽는다
  // (useSheetState의 isContentLocked와 같은 이유: 클로저에 갇힌 값이 아니라 항상 최신값).
  const contentLocked = useNotesStore((s) => s.activeNote?.note?.content_locked ?? false);
  const [draft, setDraft] = useState(section.body_md);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [shape, setShape] = useState<NodeShape>("rect");
  const [style, setStyle] = useState<EdgeStyle>("solid");
  const [locked, setLocked] = useState(false);
  const [pngBusy] = useState(false);
  const [selectedBoxIds, setSelectedBoxIds] = useState<string[]>([]);
  const [textFormOpen, setTextFormOpen] = useState(false);
  const apiRef = useRef<DiagramCanvasApi | null>(null);

  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const savedRef = useRef(section.body_md);
  draftRef.current = draft;

  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const undoDepth = undoStack.length;
  const redoDepth = redoStack.length;

  useEffect(() => {
    if (section.body_md !== draftRef.current) {
      setDraft(section.body_md);
      savedRef.current = section.body_md;
      setUndoStack([]);
      setRedoStack([]);
      setSelection(null);
      setPickingFor(null);
      doRender(section.body_md);
    }
  }, [section.body_md]);

  const modelRef = useRef<DiagramModel | null>(null);
  const model = useMemo(() => {
    if (editing && modelRef.current) return modelRef.current;
    const m = parseDiagram(draft);
    modelRef.current = m;
    return m;
  }, [draft, editing]);

  const showEmpty = model.empty && !editing;
  const useFlow = canFlowRender(model);

  const doRender = (text: string) => {
    const m = parseDiagram(text);
    setError(m.error ? m.error : null);
  };

  // 저장 프로미스를 돌려준다 — registerFlush 가 그걸 기다려야 창 닫기(섹션 분리 창의 destroy 포함)가
  // 저장 IPC 완료 뒤에 일어난다. updateSectionBody 는 reject 하지 않는다(실패는 savedState 로).
  const saveNow = async (text: string): Promise<void> => {
    const prevSaved = savedRef.current;
    savedRef.current = text;
    const saved = useNotesStore.getState().updateSectionBody(section.id, text);
    patchSectionBodyCache(section.id, text);
    let rejected = false;
    try {
      await saved;
    } catch {
      // 초안 노트의 ensureMaterialized 거절 — call() 이 토스트했다. 아래에서 일반 실패로 같이 처리한다.
      rejected = true;
    }
    // M-11: 일반 실패면 보낸 표시를 되돌려 다음 flush 가 다시 보내게 한다(충돌·사라진 섹션은 게이트가 본문을 쥔다 — 그대로).
    // 그 사이 더 새 본문을 보냈다면(savedRef 가 달라짐) 건드리지 않는다.
    if (isSectionGated(section.id)) return;
    if (rejected || useNotesStore.getState().savedState === "failed") {
      if (savedRef.current === text) savedRef.current = prevSaved;
      markSaveFailed(section.id);
    } else {
      clearSaveFailed(section.id);
    }
  };

  const flushSave = (): Promise<void> | undefined => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (draftRef.current !== savedRef.current) {
      return saveNow(draftRef.current);
    }
    return undefined;
  };

  useEffect(() => {
    doRender(draftRef.current);
    const unregister = registerFlush(async () => {
      await flushSave();
    });
    return () => {
      unregister();
      void flushSave();
    };
  }, []);

  const scheduleRender = (text: string) => {
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = setTimeout(() => {
      doRender(text);
      renderTimer.current = null;
    }, RENDER_DEBOUNCE_MS);
  };

  const scheduleSave = (text: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNow(text);
      saveTimer.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  // 내용잠금: makeDiagramActions의 모든 액션(add/delete node·edge, group, style, ...) +
  // InternalNotePicker onPick(노드 링크)이 전부 apply 하나로 모인다(diagramActions.ts 전수
  // 확인) — 여기 하나만 막으면 구조 편집 전부가 막힌다. 조용히 무시(useSheetState의 setCells와
  // 같은 원칙 — 툴바 클릭/드래그는 알림이 필요 없다).
  const applyMutation = (next: string) => {
    if (useNotesStore.getState().activeNote?.note?.content_locked) return;
    if (next === draftRef.current) return;
    const prev = draftRef.current;
    setUndoStack((s) => [...s, prev]);
    setRedoStack([]);
    draftRef.current = next;
    setDraft(next);
    scheduleRender(next);
    scheduleSave(next);
  };

  const step = (to: string, pushTo: (s: string[]) => void) => {
    // 잠금 전에 쌓인 undo/redo 스택이 남아 있을 수 있다 — sheet의 undo/redo와 같은 이유로 막는다.
    if (useNotesStore.getState().activeNote?.note?.content_locked) return;
    if (renderTimer.current) {
      clearTimeout(renderTimer.current);
      renderTimer.current = null;
    }
    pushTo(undoStack);
    draftRef.current = to;
    setDraft(to);
    doRender(to);
    scheduleSave(to);
  };

  const undo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    const current = draftRef.current;
    setUndoStack((s) => s.slice(0, -1));
    step(prev, () => {
      setRedoStack((r) => [...r, current]);
    });
  };

  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    const current = draftRef.current;
    setRedoStack((r) => r.slice(0, -1));
    step(next, () => {
      setUndoStack((u) => [...u, current]);
    });
  };

  const openLinkedNote = async (noteId: string) => {
    const summary = await fetchNoteSummary(noteId);
    if (!summary) {
      emitNotice(t("editor.diagram_link_target_missing"));
      return;
    }
    void useNotesStore.getState().selectNote(noteId);
  };

  const actions = useMemo(
    () =>
      makeDiagramActions({
        source: () => draftRef.current,
        apply: applyMutation,
        select: setSelection,
        shape,
        style,
        setShapeDefault: setShape,
        setStyleDefault: setStyle,
        pickNote: (id) => setPickingFor(id),
        openNote: (noteId) => void openLinkedNote(noteId),
      }),
    [shape, style],
  );

  const startEditing = () => setEditing(true);

  const stopEditing = () => {
    flushSave();
    setEditing(false);
    doRender(draftRef.current);
  };

  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // 원본 텍스트(JSON) 편집 모드는 applyMutation을 거치지 않고 draftRef/scheduleSave를 직접
    // 부른다 — 별도 가드가 필요한 두 번째 쓰기 경로. textarea에도 readOnly를 걸어 두지만(아래
    // JSX) 방어적으로 여기도 막는다.
    if (useNotesStore.getState().activeNote?.note?.content_locked) return;
    const next = e.target.value;
    draftRef.current = next;
    setDraft(next);
    // 손 타이핑은 구조 편집 이력을 양방향 모두 무효화한다. 되돌리기가 살아 있으면 사용자가 방금
    // 친 텍스트를 조용히 삼키고 편집 전 상태로 되돌아가고(실제로 났던 증상), 앞으로는 타이핑
    // 이후의 텍스트 위에 옛 변이를 다시 얹는다. 되돌리면 새는 것: 이 두 줄이 없으면 소스 편집이
    // 되돌리기 한 번에 사라진다 — JSON IR 전환(88195857) 때 옛 setHistory 헬퍼와 함께 유실됐다가
    // 복구된 계약이다.
    setUndoStack([]);
    setRedoStack([]);
    scheduleRender(next);
    scheduleSave(next);
  };

  useEffect(() => {
    return registerDiagramTarget(() => ({
      sectionId: section.id,
      source: draftRef.current,
      replaceSection: async (body_md: string) => {
        // 사용자가 명시적으로 "적용"을 눌러 도달하는 지점이라(sheet의 같은 경로와 동일 원칙)
        // applyMutation의 조용한 무시와 달리 여기서는 알림을 띄운다.
        if (useNotesStore.getState().activeNote?.note?.content_locked) {
          emitNotice(t("editor.content_locked_tooltip"));
          return;
        }
        applyMutation(body_md);
      },
    }));
  }, [section.id]);

  // 배치 바꾸기(베타, PLAN-2026-09-21 W4/D4) — 어시스트는 이 컴포넌트 밖이라 actions 를 못 잡는다.
  // sheetFocus 와 같은 원칙(위 registerDiagramTarget 선례): 열린 섹션이 자기 model.layout·
  // actions.setLayout 을 게시하고, 언마운트에 비운다.
  useEffect(() => {
    useDiagramFocus.getState().setFocus({
      sectionId: section.id,
      layout: model.layout,
      source: model.structured ? serializeDiagram(model) : "",
      setLayout: actions.setLayout,
    });
    return () => useDiagramFocus.getState().setFocus(null);
  }, [section.id, model, actions]);

  const glowClass = useAiGlow(AI_GLOW_KEYS.section(section.id));

  return (
    <div
      className={`diagram-section-container ${glowClass}`.trim()}
      data-testid="diagram-section"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        height: "100%",
        position: "relative",
      }}
    >
      {!editing && !showEmpty && !touch && (
        <DiagramToolbar
          model={model}
          useFlow={useFlow}
          selection={selection}
          selectedBoxIds={selectedBoxIds}
          actions={actions}
          apiRef={apiRef}
          canUndo={undoDepth > 0}
          onUndo={undo}
          canRedo={redoDepth > 0}
          onRedo={redo}
          onEditSource={startEditing}
          zoom={zoom}
          onZoom={setZoom}
          pngBusy={pngBusy}
          locked={locked}
          onToggleLock={() => setLocked((l) => !l)}
        />
      )}
      <div
        className="diagram-stage"
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {editing ? (
          <div
            className="diagram-source-panel"
            data-testid="diagram-source-panel"
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              padding: "var(--space-2) var(--space-4)",
              gap: "var(--space-2)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                {t("editor.diagram_source_hint")}
              </span>
              <button
                type="button"
                className="btn btn--sm"
                data-testid="diagram-source-done"
                onClick={stopEditing}
              >
                {t("editor.diagram_source_done")}
              </button>
            </div>
            <textarea
              className="diagram-source-textarea"
              data-testid="diagram-source-textarea"
              value={draft}
              onChange={onTextChange}
              readOnly={contentLocked}
              title={contentLocked ? t("editor.content_locked_tooltip") : undefined}
              spellCheck={false}
              style={{
                flex: 1,
                minHeight: 180,
                width: "100%",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm)",
                lineHeight: 1.5,
                padding: "var(--space-3)",
                background: "var(--app-canvas)",
                color: "var(--text)",
                border: "1px solid var(--divider)",
                borderRadius: "var(--radius-sm)",
                resize: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        ) : showEmpty ? (
          <div
            className="diagram-empty-state"
            data-testid="diagram-empty-state"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              minHeight: 240,
              gap: "var(--space-3)",
              padding: "var(--space-6)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "var(--text-md)" }}>
              {t("editor.diagram_empty_title")}
            </div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", maxWidth: 420, textAlign: "center" }}>
              {t("editor.diagram_empty_body")}
            </div>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textDecoration: "underline", padding: "4px 8px" }}
              data-testid="diagram-text-start-toggle"
              onClick={() => setTextFormOpen((v) => !v)}
            >
              {t("editor.diagram_text_start")}
            </button>
            {textFormOpen && (
              <div style={{ width: "100%", maxWidth: 460 }}>
                <DiagramTextForm onSubmit={actions.addFromText} />
              </div>
            )}
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              style={{ fontSize: "var(--text-xs)", color: "var(--muted)", textDecoration: "underline", padding: "4px 8px" }}
              data-testid="diagram-empty-edit-source"
              onClick={startEditing}
            >
              {t("editor.diagram_empty_or_source")}
            </button>
          </div>
        ) : (
          <Suspense fallback={null}>
            <FlowCanvas
              model={model}
              selection={selection}
              onSelect={setSelection}
              actions={actions}
              onEditSource={startEditing}
              canUndo={undoDepth > 0}
              onUndo={undo}
              canRedo={redoDepth > 0}
              onRedo={redo}
              error={error}
              bubbles={!touch}
              pngBusy={pngBusy}
              onSelectedBoxes={setSelectedBoxIds}
              apiRef={apiRef}
              locked={locked}
              onToggleLock={() => setLocked((l) => !l)}
            />
          </Suspense>
        )}
        {/* 어시스트 타입 행 호버 고스트 — EditorPanel 은 관계도 탭에서 이 오버레이를 안 그리므로 캔버스
            위(이 stage)에 둔다. 게이트·분기는 오버레이 자신의 것(resolveGhostBody). */}
        {!editing && <EditorGhostOverlay />}
      </div>
      {!editing && !showEmpty && (touch || !model.structured) && (
        <DiagramControls
          model={model}
          selection={selection}
          actions={actions}
          onEditSource={startEditing}
          canUndo={undoDepth > 0}
          onUndo={undo}
          canRedo={redoDepth > 0}
          onRedo={redo}
        />
      )}
      {!editing && !touch && !showEmpty && (
        <div data-testid="diagram-hint-bar" className="section-statusbar">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-7)" }}>
            {/* 개수는 캔버스 상단 중앙의 DiagramLegend 가 소유한다 — 같은 숫자를 한 화면에
                두 번 적던 자리였고, 심지어 legend 쪽은 "3개 노드" 라는 다른 말을 썼다. */}
            <BodyCollapseToggle />
          </div>
          <CheatsheetPopover title={t("editor.diagram_cheatsheet_title")} items={DIAGRAM_GESTURES()} />
        </div>
      )}
      {pickingFor && (
        <InternalNotePicker
          excludeNoteId={useNotesStore.getState().activeNote?.note.id ?? null}
          onPick={(noteId) => {
            applyMutation(setNodeLink(draftRef.current, pickingFor, noteId));
            setPickingFor(null);
          }}
          onCancel={() => setPickingFor(null)}
        />
      )}
    </div>
  );
}
