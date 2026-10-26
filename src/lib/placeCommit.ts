/**
 * 노트 대표 장소(notes.region + lat/lng) 쓰기의 단일 지점.
 *
 * 대표 장소는 두 필드가 **서로 다른 IPC 두 번**(note_set_region, note_set_location)으로 쓰인다.
 * 예전엔 호출부마다 `void setRegion(...)` / `void setLocation(...)` 를 분리 발사해서, 하나만
 * 실패하면(내용 잠금·네트워크·디스크) 이름은 새것인데 좌표는 옛것인 노트가 남았다 — UI 가 데이터에
 * 대해 거짓말한다(CLAUDE.md 함정 9: 낙관적 갱신엔 롤백이 짝).
 *
 * 스토어 setter(stores/notesActive.ts::patchActiveNote)는 실패해도 **던지지 않는다** — 자기 필드는
 * 롤백하고 savedState "failed" 만 세운다. 그래서 성공 여부는 호출 뒤 activeNote 를 다시 읽어
 * 판정한다(RegionEntryPopover 가 원래 하던 방식).
 *
 * ponytail: 두 IPC 사이에 프로세스가 죽으면 이름만 바뀐 상태가 남을 수 있다(여기 롤백은 같은 세션
 * 안의 실패만 막는다). 완전 원자성은 `note_set_place`(region+lat+lng 한 트랜잭션) 커맨드를 specs/
 * commands 에 추가하고 patchActiveNote 로 한 번에 쓰는 것 — 두 번째 호출 경로가 생기면 그때.
 */
import { useNotesStore } from "../stores/notes";
import { reportFallback } from "./diag";

export interface PrimaryPlace {
  region: string | null;
  lat: number | null;
  lng: number | null;
}

const COORD_EPS = 1e-6;

const sameCoord = (a: number | null | undefined, b: number | null) =>
  a == null || b == null ? (a ?? null) === b : Math.abs(a - b) <= COORD_EPS;

/** activeNote 에서 지금 대표 장소를 읽는다. */
export function readPrimaryPlace(): PrimaryPlace {
  const n = useNotesStore.getState().activeNote?.note;
  return { region: n?.region ?? null, lat: n?.lat ?? null, lng: n?.lng ?? null };
}

/**
 * 대표 장소를 `next` 로 쓴다. 바뀐 필드만 쓰고, 순서대로 await 하며, 하나라도 안 들어가면 직전
 * 상태로 되돌린다. 전부 반영됐으면 true. 내용 잠금 등으로 첫 쓰기부터 막히면 false(스토어가 이미
 * 알림을 띄웠다).
 */
export async function writePrimaryPlace(next: PrimaryPlace): Promise<boolean> {
  const prev = readPrimaryPlace();
  const regionChanged = next.region !== prev.region;
  const coordChanged = !(sameCoord(prev.lat, next.lat) && sameCoord(prev.lng, next.lng));
  if (!regionChanged && !coordChanged) return true;

  const store = () => useNotesStore.getState();
  if (regionChanged) {
    await store().setRegion(next.region);
    if (readPrimaryPlace().region !== next.region) return false; // setRegion 이 롤백했다 — 아직 아무 것도 안 바뀜.
  }
  if (coordChanged) {
    await store().setLocation(next.lat, next.lng);
    const now = readPrimaryPlace();
    if (!(sameCoord(now.lat, next.lat) && sameCoord(now.lng, next.lng))) {
      // 좌표가 안 들어갔다 — 이미 바뀐 이름을 되돌린다.
      if (regionChanged) {
        await store().setRegion(prev.region);
        if (readPrimaryPlace().region !== prev.region) {
          reportFallback("region", "primary_rollback_failed", "region rollback did not land");
        }
      }
      return false;
    }
  }
  return true;
}
