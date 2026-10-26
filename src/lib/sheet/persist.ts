// 시트 셀 패치 저장 — AI·모바일·데스크톱이 같은 `sheet_set_cells` 경로를 탄다.
// 행/열/차트 성장은 이 커맨드가 못 하므로 호출부가 `updateSectionBody` 로 통째 JSON 을 보낸다.

import { callSilent } from '../invoke';
import type { SheetSetCellsOutput } from '../commands.gen';
import { setSectionToken } from '../sectionTokens';
import { markSnapshotDirty } from '../noteSnapshots';
import { patchSectionBodyCache } from '../sectionBodyCache';
import type { CellPatch } from './types';

export async function persistSheetCells(sectionId: string, patch: CellPatch): Promise<void> {
  markSnapshotDirty();
  const w = await callSilent<SheetSetCellsOutput>('sheet_set_cells', { section_id: sectionId, cells: patch });
  // D2②: 셀 패치도 섹션 토큰을 올린다 — 받아 두지 않으면 같은 기기의 다음 본문 저장이 자기 자신과 충돌한다.
  setSectionToken(sectionId, w?.section_updated_at);
}

/**
 * CLAUDE.md 함정 4: `updateSectionBody` 는 `activeNote.sections` 를 안 고친다.
 * 셀 패치 저장이 그 경로를 비껴가면 여기서 같은 캐시를 맞춰야 탭 왕복 시 본문이 되돌아가지 않는다.
 *
 * 구현은 종류 무관한 `lib/sectionBodyCache.ts` 한 지점으로 옮겼다(관계도·모바일도 같은 일을 한다).
 */
export const patchSheetSectionCache = patchSectionBodyCache;
