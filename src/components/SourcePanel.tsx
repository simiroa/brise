import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useUiStore } from "../stores/ui";
import { previewNewAttachment } from "../lib/noteActions";
import { useNotesStore } from "../stores/notes";
import {
  IconNote,
  IconFocus,
  IconExitFocus,
  IconCaret,
  IconArrowLeft,
  IconHome,
  IconArrowRight,
} from "./icons";
import { t } from "../i18n/t";
import { call, emitNotice } from "../lib/invoke";
import type { Attachment } from "../lib/commands.gen";
import { PreviewAttachment } from "./PreviewAttachment";
import { resolvePreviewItem } from "../lib/previewResolver";
import { DropGhost } from "./attachments/DropGhost";
import { AssistPanel } from "./assist/AssistPanel";
import { useFileDropZone } from "../lib/useFileDropZone";
import { noteDropTargetProps } from "../lib/noteDrag";
import { useElementSize } from "../lib/useElementSize";

// 헤더 제목("미리보기"/"어시스트")이 들어갈 최소 폭 — 아이콘+버튼들(접기 셰브런, 프리뷰 상태면
// 확대·히스토리 2개까지)만으로도 최악의 경우(App.tsx SPLIT_MIN_W=140px 드래그 플로어 근처)
// 줄바꿈 없이 못 들어간다(오너 신고: 좁을 때 제목이 두 줄로 쪼개져 고정 높이 헤더가 깨짐).
// 줄임표 대신 통째로 숨긴다(오너 선호) — 아이콘만으로도 이 패널이 뭔지는 이미 분명하다.
const HEADER_TITLE_MIN_W = 220;

/**
 * Wave 3 L1 Part A: drop a file onto the preview card → same attachment_add_file path the
 * attachments bar / ImageButton use, then immediately select it for preview. Tauri-level
 * drag & drop (HTML5 DnD never exposes filesystem paths in the webview) via the shared
 * useFileDropZone (lib/useFileDropZone.ts) — scoped to this panel's rect so the bar and the
 * preview never double-attach the same drop.
 */
function usePreviewFileDrop(panelRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  return useFileDropZone(
    () => panelRef.current,
    {
      onDrop: (paths, _pos, inside) => {
        if (!inside) return;
        void (async () => {
          try {
            const id = await useNotesStore.getState().ensureMaterialized();
            if (!id) {
              emitNotice(t("attachments.drop_requires_note"));
              return;
            }
            let lastAtt: Attachment | null = null;
            for (const path of paths) {
              // attachment_add_file is the sole upload route (same command ImageButton /
              // useAttachmentActions use for non-extractable files). Returns the row so we
              // can preview without inventing a second path.
              lastAtt = await call<Attachment>("attachment_add_file", {
                note_id: id,
                file_path: path,
              });
            }
            await useNotesStore.getState().reloadActive();
            if (lastAtt) {
              previewNewAttachment(lastAtt.id);
            }
          } catch {
            /* call() already toasts AppError */
          }
        })();
      },
    },
    enabled
  );
}

/** Wave 8 & Wave 2: Sources and Pièces jointes are unified into one list.
 * PresetList shows whenever nothing is actually being previewed — see the rule below. */
export function SourcePanel() {
  // 파생 불리언/원시값만 구독한다 — activeNote 객체 자체를 구독하면 제목을 한 글자 칠 때마다
  // 이 카드가 통째로 리렌더된다(EditorPanel 의 좁은 선택자 주석과 같은 이유). 아래 미리보기
  // 해석도 store 안에서 불리언으로 접어서 꺼낸다.
  const hasActiveNote = useNotesStore((s) => !!s.activeNote);
  const previewItem = useUiStore((s) => s.previewItem);
  const hasResolvedPreview = useNotesStore((s) => !!resolvePreviewItem(previewItem, s.activeNote));

  // PRESET VISIBILITY RULE — 조건은 정확히 하나다: **지금 미리보기가 실제로 무언가를 그리고 있나.**
  //
  // 2026-08-02: 예전에는 여기에 `activeBodyEmpty &&` 가 하나 더 붙어 있었고, 그래서 세 상태가
  // 갈라졌다(오너 신고) — (a) 새 노트 직후, (b) 본문이 빈 노트, (c) 본문은 있는데 첨부에서 아무것도
  // 고르지 않은 상태. 셋 다 "미리보기 칸에 보여줄 게 없다"는 같은 상황인데 (c)만 프리셋 대신 빈
  // 미리보기가 떴다. 본문 유무는 미리보기 칸이 무엇을 그릴지와 아무 상관이 없으므로 조건에서 뺀다.
  //
  // 첨부/소스/좌표의 "존재"도 조건이 아니다: 첨부가 있어도 아무것도 선택하지 않았다면 미리보기
  // 칸은 "선택하세요" 힌트만 띄우고 있고, 그 자리는 프리셋이 있어야 할 자리다. previewItem 은
  // useUiStore 에 있어 노트를 바꿔도 살아남으므로 non-null 검사로는 안 되고, PreviewAttachment 와
  // 같은 해석(resolvePreviewItem)을 공유해 "지금 이 노트에서 실제로 그려지는가"를 물어야 한다.
  //
  // 그래서 여기 뜨는 리스트가 항상 "적용 가능"한 건 아니다(본문이 있는 노트/관계도 탭). 그 판정은
  // 이 컴포넌트가 아니라 PresetList 안에서 딱 한 기준으로 한다 — stores/presets.ts 의
  // PresetTargetState: 행 활성화와 호버 고스트가 같은 값을 읽으므로, "리스트는 떠 있는데 눌러도
  // 호버해도 아무 반응이 없는" 반쪽 상태 대신 이유가 적힌 비활성 상태가 보인다.
  const hasNote = hasActiveNote && hasResolvedPreview;

  // Card collapse (separate axis from previewExpanded's enlarge-overlay — see stores/ui.ts).
  const previewExpanded = useUiStore((s) => s.previewExpanded);
  const togglePreviewExpanded = useUiStore((s) => s.togglePreviewExpanded);
  const exitPreviewExpanded = useUiStore((s) => s.exitPreviewExpanded);
  const previewCollapsed = useUiStore((s) => s.previewCollapsed);
  const togglePreviewCollapsed = useUiStore((s) => s.togglePreviewCollapsed);

  // Wave 3 L1 Part B: quiet rescue affordance — only surface when there is somewhere to go.
  const canPreviewBack = useUiStore((s) => s.previewPast.length > 0);
  const canPreviewForward = useUiStore((s) => s.previewFuture.length > 0);
  const previewHistoryBack = useUiStore((s) => s.previewHistoryBack);
  const previewHistoryForward = useUiStore((s) => s.previewHistoryForward);
  const showHistory = canPreviewBack || canPreviewForward;

  const panelRef = useRef<HTMLDivElement | null>(null);
  // Drop target is the expanded card (incl. enlarge overlay surface), not the collapsed rail.
  const dropEnabled = !previewCollapsed;
  const { dragOver } = usePreviewFileDrop(panelRef, dropEnabled);
  // Fallback 999 = 실측 전/전개(overlay) 상태 모두 "충분히 넓다"로 가정 — 좁은 순간에만 실측치가
  // 이 값을 밀어낸다. panelRef 는 아래 두 return 분기(overlay/기본) 중 실제로 그려지는 쪽에
  // 붙으므로 어느 쪽이든 이 패널 자신의 폭을 잰다.
  const { width: panelWidth } = useElementSize(panelRef, { width: 999, height: 0 });
  const showHeaderTitle = panelWidth >= HEADER_TITLE_MIN_W;

  // Clear way back: Escape collapses the enlarged preview, same convention as ModalShell/FocusExit.
  useEffect(() => {
    if (!previewExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitPreviewExpanded();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewExpanded, exitPreviewExpanded]);

  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        height: "var(--row-tabs)",
        boxSizing: "border-box",
        padding: "0 var(--space-6)",
        borderBottom: "1px solid var(--divider)",
        flex: "none",
      }}
    >
      {/* 어시스트가 우측에 있으므로 접기 캐럿은 제목 앞(안쪽 가장자리 반대편)이 아니라 맨 앞에 둔다. */}
      {!previewExpanded && (
        <button
          type="button"
          className="icon-btn icon-btn--glow"
          onClick={togglePreviewCollapsed}
          title={t("sources.collapse_card")}
          aria-label={t("sources.collapse_card")}
        >
          <IconCaret dir="right" size={11} />
        </button>
      )}
      <IconNote size={15} strokeWidth={1.9} style={{ color: "var(--accent)", flex: "none" }} />
      {showHeaderTitle && (
        <div
          style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "var(--text-md)",
            color: "var(--text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {hasNote ? t("attachments.preview_title") : t("presets.pane_assist")}
        </div>
      )}
      <div style={{ marginLeft: "auto", display: "flex", gap: "var(--space-2xs)", alignItems: "center" }}>
        {hasNote && (
          <button
            type="button"
            className="icon-btn icon-btn--glow"
            data-testid="preview-home"
            onClick={() => useUiStore.getState().setPreviewItem(null)}
            title={t("sources.preview_home")}
            aria-label={t("sources.preview_home")}
          >
            <IconHome size={14} strokeWidth={1.9} />
          </button>
        )}
        {showHistory && (
          <>
            <button
              type="button"
              className="icon-btn icon-btn--glow"
              data-testid="preview-history-back"
              disabled={!canPreviewBack}
              onClick={previewHistoryBack}
              title={t("sources.preview_back")}
              aria-label={t("sources.preview_back")}
            >
              <IconArrowLeft size={14} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--glow"
              data-testid="preview-history-forward"
              disabled={!canPreviewForward}
              onClick={previewHistoryForward}
              title={t("sources.preview_forward")}
              aria-label={t("sources.preview_forward")}
            >
              <IconArrowRight size={14} strokeWidth={1.9} />
            </button>
          </>
        )}
        {hasNote && (
          <button
            type="button"
            className="icon-btn icon-btn--glow"
            onClick={togglePreviewExpanded}
            title={t(previewExpanded ? "sources.collapse" : "sources.enlarge")}
          >
            {previewExpanded ? (
              <IconExitFocus size={14} strokeWidth={1.9} />
            ) : (
              <IconFocus size={14} strokeWidth={1.9} />
            )}
          </button>
        )}
      </div>
    </div>
  );

  const dropOverlay = dragOver ? (
    <DropGhost testid="preview-drop-overlay" label={t("attachments.drop_hint")} />
  ) : null;

  if (previewExpanded) {
    return createPortal(
      <div
        onClick={exitPreviewExpanded}
        data-testid="preview-expanded-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: "var(--z-modal)",
          background: "var(--overlay)",
          display: "grid",
          placeItems: "center",
          padding: "4vh 5vw",
          animation: "fade .15s",
        }}
      >
        <div
          ref={panelRef}
          onClick={(e) => e.stopPropagation()}
          className="overlay card-reading"
          data-testid="preview-expanded-surface"
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            boxShadow: "var(--shadow-lg)",
            animation: "pop .16s",
            position: "relative",
            outline: dragOver ? "2px solid var(--accent)" : undefined,
          }}
        >
          {header}
          <PreviewAttachment />
          {dropOverlay}
        </div>
      </div>,
      document.body
    );
  }

  // 접힘 = 세로 28px 레일. 이 컴포넌트 단독 결정이 아니라 App.tsx 와 맺은 계약이다: App.tsx 는
  // previewCollapsed 일 때 소스 컬럼 폭을 "auto" 로 바꾸고 리사이즈 그립을 숨긴다(레일은 폭을
  // 리사이즈할 대상이 없다). 그래서 접힘을 "높이만 헤더 줄로 줄이기"로 바꾸면 폭이 auto 인
  // 채로 남아 카드가 제목 너비만큼 쪼그라들고, 그립이 사라져 크기 조절도 불가능해진다 —
  // 실제로 그렇게 회귀했었다(owner 신고, 2026-07-31). 둘 중 하나만 고치면 안 된다.
  if (previewCollapsed) {
    // 카드 자체는 배경 없음(SINGLE-SHEET ACRYLIC CONTRACT). 레일 전체가 클릭 대상인 단일
    // <button> 이라(중첩 버튼 아님) 클릭이 두 핸들러를 타고 이중 토글되는 일이 없다. 평상시
    // 투명, hover 에서만 --hover 틴트.
    return (
      <div
        // W22 ②: 워크스페이스 내부 평탄화 — .card/.card-reading 제거(외곽선은 content-canvas 하나로
        // 통일). overflow:hidden 은 라운드가 없어졌으니 더 필요 없지만 남겨도 무해해 유지.
        data-testid="source-panel-collapsed-rail"
        style={{
          display: "flex",
          flexDirection: "column",
          flex: "none",
          height: "100%",
          width: 28,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={togglePreviewCollapsed}
          title={t("sources.expand_card")}
          aria-label={t("sources.expand_card")}
          className="icon-glow"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: "100%",
            height: "100%",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {/* 2026-08-02: 세로쓰기(writingMode: vertical-rl) "미리보기" 라벨을 제거했다 —
              28px 레일에서 글자가 돌아간 채 잘려 읽히지 않았다(오너 신고). 셰브런만 남긴다.
              레일 전체가 여전히 클릭 대상이고 title/aria-label 이 이름을 대신하므로
              스크린리더 접근성은 그대로다. */}
          <IconCaret
            dir="left"
            size={11}
            style={{ marginTop: "var(--space-3)" }}
          />
        </button>
      </div>
    );
  }

  // 펼친 상태의 폭은 App.tsx 의 컬럼(sourcePct)이 정한다 — 카드는 그 폭을 꽉 채워야 한다.
  // flex:"none" + width:"100%" 가 빠지면 카드가 내용 너비로 쪼그라들어 컬럼 안에서 떠 보인다.
  return (
    <div
      ref={panelRef}
      // W22 ②: 워크스페이스 내부 평탄화 — .card/.card-reading 제거, 외곽선은 content-canvas 하나로.
      data-testid="source-panel-drop-target"
      // 섹션 탭을 이 카드에 드롭하면 그 섹션이 미리보기에 고정된다 — 처리는 한 곳
      // (editor/useSectionActions.ts 의 registerNoteDropHandler), 여기는 대상 표시만 한다.
      // 접힌 레일은 위에서 먼저 return 하므로 이 속성이 붙지 않는다(= 파일 드롭존과 같은 범위).
      {...noteDropTargetProps("preview:card")}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "none",
        height: "100%",
        width: "100%",
        minWidth: 0,
        position: "relative",
        outline: dragOver ? "2px solid var(--accent)" : undefined,
      }}
    >
      {header}
      {hasNote ? (
        <PreviewAttachment />
      ) : (
        <AssistPanel />
      )}
      {dropOverlay}
    </div>
  );
}
