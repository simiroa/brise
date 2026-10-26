/**
 * PLAN-2026-09-19-date-region-ui.md §P3 Phase A — region pre-match nudge, data layer only (no UI
 * anywhere yet; the popover that will render `useRegionNudgeStore`'s candidates is Phase B).
 *
 * Two independent pieces live in this file:
 *
 * 1. `matchRegionCandidates`/`hasBoundaryMatch` (D12) — a pure, dependency-free text matcher.
 *    Unit-testable without React/store/editor machinery, per the plan's own instruction.
 * 2. `useRegionDetect` (D5/D6/D9/D10) — a plain debounced React hook, deliberately NOT a
 *    ProseMirror plugin. dateNudge.ts is a plugin because it draws Decorations *inside* the
 *    document; this feature's output is a list that lives in a popover, so that machinery is
 *    unneeded complexity (D5). It reads the live editor via `getActiveEditor()` (CLAUDE.md 함정 2:
 *    never trust a captured `view`/`editor` across an await — every doc access here happens
 *    either synchronously off a fresh `getActiveEditor()` call or is guarded by `isDestroyed`).
 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { getActiveEditor } from "../../lib/aiSectionBridge";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useRegionNudgeStore } from "../../stores/regionNudge";
import { loadRegionRegistry } from "../../lib/regionRegistry";
import { sameRegionName } from "../attachments/regionDisplay";
import { useNoteWaypoints } from "../home/useNoteWaypoints";

import { matchRegionCandidates, type BoundaryMode } from "../../lib/regionMatch";

// 순수 매처는 lib/regionMatch.ts 로 옮겼다(폰 감지가 React·스토어 없이 쓴다). 기존 import 호환용 re-export.
export { matchRegionCandidates, type BoundaryMode };

const DEBOUNCE_MS = 700;

/**
 * D5/D6/D9/D10 — debounced scan of the CURRENTLY OPEN section's full document (not the whole
 * note's other sections — that would need a flushAll()+note_get round trip, CLAUDE.md 함정 4,
 * explicitly out of scope) against the workspace's region_registry, writing survivors into
 * useRegionNudgeStore.
 *
 * `activeSectionId` is an optional second key (in ADDITION to `noteId`) so a future caller can
 * force an immediate re-scan on a same-note section switch — the single shared Tiptap `Editor`
 * instance (EditorPanel.tsx's `useEditor` has no deps array, CLAUDE.md 함정 2: it persists across
 * both note AND section switches) has its content swapped via `setContent(..., { emitUpdate:
 * false })` on every section load, which — by design, same as dateNudge.ts's own suppression —
 * does NOT fire Tiptap's "update" event. Without a way to force a re-scan, switching from a
 * diagram section (where `getActiveEditor()` returns null, so no "update" subscription exists at
 * all) back to a text section in the same note would leave stale or empty candidates until the
 * user's next keystroke. Passing the active section's id closes that gap; omitting it (e.g. in a
 * unit test that only cares about doc-level matching) just means section switches within the same
 * note aren't separately tracked, which is a documented limitation the report calls out — no
 * consumer wires this yet in Phase A, so exercising that exact path has no current UI to verify
 * against.
 *
 * D10's reset is deliberately a SEPARATE effect keyed on `noteId` alone (not `activeSectionId`) —
 * the dismiss set must survive a same-note section switch and only clear on an actual note
 * change, per D10's own wording ("노트 전환/새로고침 시 초기화").
 */
export function useRegionDetect(
  noteId: string | null | undefined,
  activeSectionId?: string | null,
): void {
  const strict = useSettingsStore((s) => s.regionNudgeStrict);
  // 오너 결정(2026-09-20) — region_nudge_enabled 킬 스위치. dateNudgeAuto/strict 와 달리 이 값은
  // ref 가 아니라 **진짜 훅 구독 + effect dep** 이다: 꺼지면 스캔(과 그 fetch)을 아예 멈추고 이미
  // 보이던 후보를 즉시 비워야 하는데(배지 점·"감지됨" 섹션이 다음 타이핑을 기다리지 않고 사라짐),
  // 그러려면 아래 effect 자체가 이 값이 바뀔 때 다시 돌아야 한다 — 켜졌을 때 "마운트 시 즉시
  // 스캔"과 같은 코드 경로(이 effect 본문의 scan() 첫 호출)가 그대로 재사용돼 "다시 켜면 즉시
  // 재스캔"도 함께 만족한다.
  const enabled = useSettingsStore((s) => s.regionNudgeEnabled);
  // D9 (waypoint half): reuse the existing cached hook (components/home/useNoteWaypoints.ts)
  // rather than a fourth hand-rolled note_regions_list fetch — same "relocate, don't reinvent"
  // principle §P2 already applied to this codebase's region UI.
  const waypoints = useNoteWaypoints(noteId);
  // D9 (primary half)의 **재스캔 트리거**. scan() 은 대표 이름을 호출 시점에 스토어에서 읽지만,
  // 대표가 바뀌는 것 자체는 에디터 "update" 도 waypoints 변화도 아니다(setRegion 은
  // attachmentRevision 을 올리지 않는다) — 이 값이 effect 의존성에 없으면 팝오버에서 "서울"을
  // 대표로 등록한 뒤에도 바로 아래 "감지됨"에 "서울"이 다음 타이핑까지 남는다(§P3 Phase B 검증 중
  // 발견).
  const ownRegion = useNotesStore((s) => (s.activeNote?.note.id === noteId ? s.activeNote?.note.region ?? null : null));
  const setCandidates = useRegionNudgeStore((s) => s.setCandidates);
  const resetForNote = useRegionNudgeStore((s) => s.resetForNote);

  // scan() runs from a timer/event callback outside React's render cycle — mirrors dateNudge.ts's
  // runParse()/acceptCandidate() idiom of reading fresh state via refs/getState() at call time
  // instead of closing over a render's stale props/state. `strict` stays ref-only (a settings
  // toggle mid-typing must not tear down/rebuild the "update" subscription below) — `waypoints`
  // is ALSO a real effect dep (see that effect's own comment): it still needs a ref too, because
  // `scan()`'s callback closes over whatever render created it, and the effect can re-run (new
  // waypoints) while an in-flight `loadRegionRegistry().then()` from the PREVIOUS render is still
  // pending — the ref ensures that in-flight callback checks the latest waypoints, not the ones
  // captured when it started.
  const strictRef = useRef(strict);
  strictRef.current = strict;
  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;

  useEffect(() => {
    resetForNote(noteId ?? null);
  }, [noteId, resetForNote]);

  useEffect(() => {
    if (!noteId) return;
    if (!enabled) {
      // 스캔도 region_registry fetch 도 하지 않는다 — 이미 보이던 후보가 있으면 즉시 비워
      // 배지 점/"감지됨" 섹션이 다음 스캔을 기다리지 않고 바로 사라지게 한다. dismissedNames는
      // 건드리지 않는다(resetForNote 가 아니라 setCandidates만 — D10 dismiss 세션은 노트 전환
      // 때만 초기화되는 별도 규약, 이 effect 상단 주석 참고).
      setCandidates(noteId, []);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scan = () => {
      const editor: Editor | null = getActiveEditor();
      if (!editor) return; // diagram/sheet section, or no editor mounted — nothing to scan
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n");
      void loadRegionRegistry().then((registry) => {
        if (cancelled) return;
        const mode: BoundaryMode = strictRef.current ? "strict" : "loose";
        const matched = matchRegionCandidates(text, registry, mode);
        // D9: exclude names already attached to THIS note (primary region + waypoints).
        const own = useNotesStore.getState().activeNote;
        const ownRegion = own?.note.id === noteId ? own.note.region : null;
        const filtered = matched.filter((entry) => {
          if (sameRegionName(entry.name, ownRegion)) return false;
          if (waypointsRef.current.some((w) => sameRegionName(w.name, entry.name))) return false;
          return true;
        });
        setCandidates(noteId, filtered);
      });
    };

    const editor = getActiveEditor();
    // Immediate scan on mount/note-or-section change — see this function's own doc comment on why
    // the "update" event alone would leave the popover empty until the user types.
    scan();

    const onUpdate = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        scan();
      }, DEBOUNCE_MS);
    };
    editor?.on("update", onUpdate);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (editor && !editor.isDestroyed) editor.off("update", onUpdate);
    };
    // `waypoints` IS a dep (unlike `strict`, which stays ref-only): useNoteWaypoints starts at []
    // on first render and resolves asynchronously (its own useState+call()), so the immediate scan
    // that runs synchronously in this same effect would otherwise always see an empty waypoint
    // list — D9's waypoint half would silently do nothing until the *next* doc edit, not just on
    // this note's first open. useNoteWaypoints returns the same cached array reference on a cache
    // hit, so this does not re-subscribe on every render — only when the waypoint list actually
    // changes (fetch resolved, or a write invalidated the cache). `strict` stays ref-read on
    // purpose: a settings toggle mid-typing shouldn't tear down/rebuild the "update" subscription.
    // `enabled` IS a dep (unlike `strict`) — flipping it must tear down/rebuild this effect so the
    // off-branch above runs (clearing candidates) and, symmetrically, flipping back on re-enters
    // this same effect body and hits the mount-time immediate `scan()` call again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setCandidates is a stable zustand action reference.
  }, [noteId, activeSectionId, waypoints, ownRegion, setCandidates, enabled]);
}

// ponytail: the ACCEPT path (D11 — clone RegionEntryPopover.tsx's setRegion/setLocation write,
// including its silent-failure re-check guard) is explicitly Phase B's job, not this file's. See
// PLAN-2026-09-19-date-region-ui.md §P3 "Phase A / Phase B" for the split and D11 for why the
// guard (re-reading activeNote.note.region after the write) is load-bearing, not optional.
