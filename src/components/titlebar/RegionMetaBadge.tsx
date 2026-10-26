import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/t";
import { useDismiss, useMenuPos } from "../../lib/ui";
import { useNotesStore } from "../../stores/notes";
import { useNoteRegions } from "../../lib/noteMeta";
import { dedupeWaypoints, type PrimaryRegion } from "../attachments/regionDisplay";
import { IconMapPin } from "../icons";
import { FOLDER_BADGE_MAX_PX } from "./FolderBadge";
import { useRegionDetect } from "../editor/regionDetect";
import { useRegionNudgeStore } from "../../stores/regionNudge";
import { invalidateRegionRegistry } from "../../lib/regionRegistry";
import { RegionDetectedSection } from "./RegionDetectedSection";
import { NoteRegionsList } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";

/**
 * QA feedback (dashboard integrate, 항목 2): the meta row used to carry a single-primary
 * RegionEditor (add/replace/clear one place, no waypoints). This is its replacement — a compact
 * chip that opens a popover holding the real multi-region editor (NoteRegionsList, already used
 * by PreviewAttachment for the same note — this is the second mount, not a fork). Add, remove,
 * reorder, and "make primary" all live inside NoteRegionsList itself; this wrapper only owns the
 * closed-chip summary and the popover shell (same anchored-portal pattern as DateBadge/DueChip).
 */
export function RegionMetaBadge({
  noteId,
  primary,
  isGlow,
}: {
  noteId: string | null;
  primary: PrimaryRegion;
  /** When AI is writing note metadata, this chip glows individually (not the meta row). */
  isGlow?: "active" | "fading" | false;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const attachmentRevision = useNotesStore((s) => s.attachmentRevision);
  const btnRef = useRef<HTMLDivElement>(null);
  const { ref: popRef, x: menuX, y: menuY } = useMenuPos(anchor);

  // 경유지 수 — 지역 감지 훅·첨부 바와 같은 캐시(lib/noteMeta.ts)라 열 때 IPC 한 번. 대표가 바뀌면
  // (setRegion → patchNoteSummary → noteQueryVersion) 버전이 바뀌어 다시 읽고, 대표와 겹치는 행은
  // 렌더 시점의 primary 로 거른다.
  const { regions } = useNoteRegions(noteId);
  const waypointCount = noteId ? dedupeWaypoints(primary, regions).length : 0;

  // §P3 Phase B — 이 배지는 팝오버가 닫혀 있어도 항상 마운트돼 있으므로(팝오버 자체는 아니다)
  // 여기서 탐지 훅을 돌린다. 훅 순서 규칙(CLAUDE.md 함정 1): 이 컴포넌트엔 조기 반환이 없으니
  // 이 자리(다른 훅들 사이, return 문 훨씬 위)에 둬도 안전하다. activeSectionId는 넘기지 않는다
  // — src/stores/*.ts 전체를 훑어도 "지금 에디터에 열려 있는 섹션 id"를 반응형으로 들고 있는
  // 스토어가 없다(lib/aiSectionBridge.ts::getActiveSection()은 있지만 구독 불가능한 명령형
  // getter라 훅 인자로 못 쓴다 — 리포트 참고). 그 결과 같은 노트 안에서 섹션만 바꾸는 경우
  // 즉시 재스캔은 못 걸지만(regionDetect.ts의 activeSectionId 문서 주석이 이미 이 한계를
  // 명시한다), 문서 전체를 갈아치우는 노트 전환은 noteId 하나로도 정확히 잡힌다.
  useRegionDetect(noteId);
  const nudgeStoreNoteId = useRegionNudgeStore((s) => s.noteId);
  const nudgeCandidateCount = useRegionNudgeStore((s) => s.candidates.length);
  const detectedCount = noteId && nudgeStoreNoteId === noteId ? nudgeCandidateCount : 0;

  // §P3 Phase B 구현 범위 4 — 어느 경로로 지역명이 추가/삭제되든(대표 편집, NoteRegionsList의
  // 경유지 조작, RegionEntryPopover, 이 파일 아래 RegionDetectedSection의 accept) 다음 스캔이 그
  // 변화를 보게 한다. attachmentRevision은 그 모든 쓰기가 공유하는 카운터라 다섯 커맨드를 각각
  // 훅킹하는 대신 이거 하나로 덮는다. 첫 실행은 건너뛴다 — 마운트/노트 최초 오픈에서 primary가
  // null→값으로 채워지는 것까지 "쓰기"로 오인해 아직 따뜻한 캐시를 버리면 안 된다(§P3 Phase A
  // 헤더 주석 D8 근처의 캐시 설계 의도 — 앱 기동 직후 첫 스캔이 매번 강제 재조회를 겪지 않게).
  //
  // **노트 전환도 건너뛴다.** 다른 노트를 열면 primary 가 통째로 바뀌지만 그건 쓰기가 아니다 —
  // 레지스트리는 노트북 단위라 노트를 옮겨 다닌다고 달라지지 않는다. 이 가드가 없으면 노트를 열
  // 때마다 노트북 전체를 훑는 `region_registry` 를 다시 부르게 된다(노트북이 바뀌는 경우는
  // regionRegistry.ts 가 스스로 키로 가른다).
  const registrySeenNoteRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (registrySeenNoteRef.current !== noteId) {
      registrySeenNoteRef.current = noteId;
      return;
    }
    invalidateRegionRegistry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, attachmentRevision, primary.region, primary.lat, primary.lng]);

  const hasPrimary = Boolean(primary.region) || (primary.lat != null && primary.lng != null);

  const openPopover = () => {
    if (!noteId) return;
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom });
    setOpen(true);
  };

  const closePopover = () => {
    setOpen(false);
    setAnchor(null);
  };

  useDismiss(open, [btnRef, popRef], closePopover, {
    onEscape: () => {
      closePopover();
      btnRef.current?.focus();
    },
  });

  const label = hasPrimary
    ? (primary.region || t("region.unnamed")) + (waypointCount > 0 ? ` +${waypointCount}` : "")
    : waypointCount > 0
      ? t("region.places_n", { n: waypointCount })
      : t("note.add_region");

  // §P3 Phase B 항목 2 — 닫힌 칩 자체엔 목록을 늘어놓지 않고(팝오버를 열어야 아는 게 맞다), 툴팁
  // (title)에만 감지 개수를 덧붙인다. aria-label은 그대로 label만 — 스크린리더 사용자가 매
  // 스캔마다 바뀌는 문구를 듣게 하지 않는다(팝오버를 열면 RegionDetectedSection이 직접 알린다).
  const detectedTitle = detectedCount > 0 ? `${label} · ${t("region.detected_badge_hint", { n: detectedCount })}` : label;

  return (
    <>
      <div
        ref={btnRef}
        role="button"
        tabIndex={0}
        className="tag-btn tb-quiet-chip"
        data-testid="region-meta-badge"
        data-ai-glow={isGlow || undefined}
        data-ai-glow-inset="true"
        onClick={() => (open ? closePopover() : openPopover())}
        {...preloadIntentProps(NoteRegionsList)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open ? closePopover() : openPopover();
          }
        }}
        title={detectedTitle}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          flex: "none",
          maxWidth: FOLDER_BADGE_MAX_PX,
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "var(--tb-chip-pt) var(--space-4) 0",
          borderRadius: "var(--radius-sm)",
          color: hasPrimary || waypointCount > 0 ? "var(--text)" : "var(--muted)",
          fontFamily: "var(--font-body)",
          fontSize: "var(--text-xs)",
          fontWeight: 400,
          height: "var(--tb-chip-h)",
          cursor: "pointer",
          overflow: "hidden",
          // Meta-row position among fixed badges (folder=0, status=1, region=2, date=3).
          // String form — React would append "px" to a number custom property.
          ["--ai-glow-stagger" as string]: "2",
        }}
      >
        <IconMapPin size={12} strokeWidth={2} style={{ flex: "none" }} />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        {/* §P3 Phase B 항목 2 — 넛지 점. SectionTabBar.tsx의 section-preview-dot과 같은 6px 원
            관용구를 5px로(스펙 지정 크기), 칩 오른쪽 끝에. 후보가 0이면 아예 안 그린다. */}
        {detectedCount > 0 && (
          <span
            data-testid="region-meta-badge-detected-dot"
            aria-hidden
            style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--info)", flex: "none" }}
          />
        )}
      </div>
      {open &&
        anchor &&
        noteId &&
        createPortal(
          <div
            ref={popRef}
            className="overlay"
            role="dialog"
            data-testid="region-meta-popover"
            aria-label={t("region.places_n", { n: hasPrimary ? 1 + waypointCount : waypointCount })}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left: menuX,
              top: menuY,
              transform: "translateY(var(--space-2))",
              zIndex: "var(--z-dropdown)",
              padding: "var(--space-4)",
              boxShadow: "var(--shadow-lg)",
              // PLAN-2026-09-19-date-region-ui.md §P2 — DateBadge.tsx(296px, 2026-09-08 오너
              // 결정: "알림 옵션 셋이 한 줄을 나눠 가지므로 240으로는 값이 잘렸다")와 맞춘 고정폭.
              // §P4 D3′ 이후 이 폭 안에 지도(WorldMapAuto, 항상 렌더)까지 얹혀도 최소폭으로
              // 충분히 검증됐다 — 지도가 없던 시절의 "최소폭 필요" 이유는 지금도 유효하고,
              // 날짜 팝오버와 시각적으로 짝이 맞는 것도 그대로다.
              width: 296,
            }}
          >
            <Suspense fallback={<div style={{ minHeight: 80 }} />}>
              <NoteRegionsList
                noteId={noteId}
                primary={primary}
                refreshKey={attachmentRevision}
                onFilterApplied={closePopover}
                autoOpenSearch
              />
            </Suspense>
            {/* §P3 Phase B 구현 범위 — NoteRegionsList **아래**("이미 등록된 것 먼저 보여준 뒤
                제안"). Suspense 밖: 이 컴포넌트는 지연 로드 대상이 아니고, NoteRegionsList의 청크
                로딩을 기다릴 이유가 없다. */}
            <RegionDetectedSection noteId={noteId} primary={primary} />
          </div>,
          document.body,
        )}
    </>
  );
}
