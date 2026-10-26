import { useState, type CSSProperties } from "react";
import { t } from "../../i18n/t";
import { call, callSilent } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";
import { useRegionNudgeStore } from "../../stores/regionNudge";
import { invalidateRegionRegistry, type RegionRegistryEntry } from "../../lib/regionRegistry";
import { nextWaypointPosition, sameRegionName, type PrimaryRegion } from "../attachments/regionDisplay";
import { IconPlus, IconClose } from "../icons";

/**
 * PLAN-2026-09-19-date-region-ui.md §P3 Phase B — "감지됨" 섹션. `RegionMetaBadge`의 팝오버 안,
 * `<NoteRegionsList>` **아래**에서만 마운트된다(D5/D6/D9/D10 매칭 엔진은 Phase A의
 * `components/editor/regionDetect.ts`가 이미 다 했다 — 이 파일은 그 결과를 그리고 두 버튼을 붙이는
 * 얇은 층). 후보가 없으면 헤더도 구분선도 없이 완전히 비워 그린다 — D12 기본값(엄격 매칭)에서는
 * 후보가 0인 경우가 흔하다는 전제.
 *
 * 캡: 최대 5행만 보이고(레지스트리 순서 그대로), 나머지는 "+N" 한 줄로 뭉친다 — 팝오버 폭
 * 296px 안에서 감지 섹션 하나가 대표+경유지 목록을 밀어내지 않게.
 */
const rowIconBtnStyle: CSSProperties = { width: 22, height: 22, flex: "none", color: "var(--muted)" };
const MAX_VISIBLE = 5;

export function RegionDetectedSection({
  noteId,
  primary,
}: {
  noteId: string;
  primary: PrimaryRegion;
}) {
  const storeNoteId = useRegionNudgeStore((s) => s.noteId);
  const storeCandidates = useRegionNudgeStore((s) => s.candidates);
  // regionNudge.ts::setCandidates가 이미 forNoteId 가드를 걸지만(stale 스캔 방어), 이 컴포넌트도
  // 같은 노트인지 한 번 더 확인한다 — 팝오버가 노트 전환 도중 잠깐 옛 noteId로 남아 있는 렌더
  // 프레임에서 다른 노트의 후보를 보여주지 않기 위해서다.
  const candidates: RegionRegistryEntry[] = storeNoteId === noteId ? storeCandidates : [];
  const [busyName, setBusyName] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  const visible = candidates.slice(0, MAX_VISIBLE);
  const overflow = candidates.length - visible.length;

  const handleDismiss = (entry: RegionRegistryEntry) => {
    // D10 — 세션 스코프 dismiss 집합에 추가. 스토어가 forNoteId 가드와 정규화를 이미 갖고 있다
    // (stores/regionNudge.ts::dismiss).
    useRegionNudgeStore.getState().dismiss(noteId, entry.name);
  };

  // §P3 D11 — 쓰기 로직 세 번째 복제. 원본 둘:
  //   1) src/components/attachments/NoteRegionsList.tsx의 addFirstPlace/addWaypoint
  //   2) src/components/editor/RegionEntryPopover.tsx의 handlePick
  // 둘 다 "대표가 없으면 setRegion+setLocation, 있으면 note_region_add" 판단을 손으로 들고
  // 있다(코드 공유 없음 — §P2가 이미 쓴 "복제하되 강제 공유하지 않는다" 관용구). D11이 반드시
  // 베끼라고 명시한 가드: setRegion/setLocation(stores/notesActive.ts::patchActiveNote)은 실패를
  // 삼키고 롤백만 한다(다시 throw하지 않는다) — 그 직후 activeNote.note.region이 정말 name으로
  // 바뀌었는지 재확인하는 것만이 "성공"과 "조용한 실패"를 가르는 유일한 신호다. 이 재확인 없이
  // 분기만 베끼면 실패한 쓰기를 성공으로 오인해 후보를 지워버리는 사고가 난다(D11 회귀 테스트).
  const acceptCandidate = async (entry: RegionRegistryEntry) => {
    if (busyName) return;
    setBusyName(entry.name);
    try {
      const hasNoPrimary = !primary.region && primary.lat == null && primary.lng == null;
      const isActiveNote = useNotesStore.getState().activeNote?.note.id === noteId;
      let succeeded: boolean;
      if (hasNoPrimary && isActiveNote) {
        await useNotesStore.getState().setRegion(entry.name);
        await useNotesStore.getState().setLocation(entry.lat, entry.lng);
        succeeded = sameRegionName(useNotesStore.getState().activeNote?.note.region ?? null, entry.name);
      } else {
        succeeded = true;
        try {
          // position 계산에 쓸 현재 note_regions_list — 배경/선택형 조회라 callSilent(함정 8:
          // 토스트가 필요 없는 조용한 조회는 callSilent().catch()). 실패해도 추가 자체를 막지
          // 않는다(NoteRegionsList/RegionEntryPopover의 같은 조회가 실패 시 값을 못 쓰는 게
          // 아니라 이 값은 순서 계산용 보조 정보일 뿐이라 — 빈 배열로 폴백하면 position 0이 되고,
          // 최악의 경우 순서가 약간 어긋날 뿐 추가 자체는 성공한다).
          let regions: { position: number }[] = [];
          try {
            const res = await callSilent<{ regions: { position: number }[] }>("note_regions_list", {
              note_id: noteId,
            });
            regions = res?.regions ?? [];
          } catch {
            regions = [];
          }
          await call("note_region_add", {
            note_id: noteId,
            name: entry.name,
            lat: entry.lat,
            lng: entry.lng,
            position: nextWaypointPosition(regions),
          });
        } catch {
          // call()이 이미 토스트를 띄웠다 — 여기서는 실패로만 기록하고 조용히 처리한다.
          succeeded = false;
        }
      }
      if (!succeeded) return;
      // D9 — 다음 스캔부터 이 이름이 자기 노트에 붙은 걸로 잡혀 후보에서 빠진다. 여기서 직접
      // candidates를 지우지 않는다: bumpAttachmentRevision이 regionDetect.ts의 useNoteWaypoints
      // 의존성을 건드려 재스캔을 유발하고, 그 재스캔이 D9 자기제외로 자연스럽게 걸러낸다.
      invalidateRegionRegistry();
      useNotesStore.getState().bumpAttachmentRevision();
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div
      data-testid="region-detected-section"
      style={{
        marginTop: "var(--space-3)",
        paddingTop: "var(--space-3)",
        borderTop: "1px solid var(--divider)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>
        {t("region.detected_header")}
      </div>
      {visible.map((entry) => {
        const busy = busyName === entry.name;
        return (
          <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "var(--text-xs)",
                color: "var(--text)",
              }}
            >
              {entry.name}
            </span>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              data-testid={`region-detected-accept-${entry.name}`}
              title={t("region.detected_accept")}
              aria-label={t("region.detected_accept")}
              disabled={busy}
              onClick={() => void acceptCandidate(entry)}
              style={rowIconBtnStyle}
            >
              <IconPlus size={12} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              data-testid={`region-detected-dismiss-${entry.name}`}
              title={t("region.detected_dismiss")}
              aria-label={t("region.detected_dismiss")}
              disabled={busy}
              onClick={() => handleDismiss(entry)}
              style={rowIconBtnStyle}
            >
              <IconClose size={11} strokeWidth={2.4} />
            </button>
          </div>
        );
      })}
      {overflow > 0 && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{`+${overflow}`}</div>
      )}
    </div>
  );
}
