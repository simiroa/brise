/**
 * 포인터 제스처 계약 상수 — 앱 전역에서 "누름이 드래그가 되는" 이동 임계값은 이 모듈의
 * 한 값만 쓴다. 계약 문서: docs/SPACE.md (클릭·드래그·더블클릭 계약).
 *
 * 값의 유래: lib/noteDrag.ts 가 처음 정의한 4px 가 ReorderList(settings)·useListReorder·
 * widgetDrag(패널→캔버스)·attachmentImageDrag 로 퍼지고, DiagramCanvas 와 PetApp 은 같은
 * 값을 복사해 들고 있었다. 2026-08-26(W7-2 통일 항목)부터 여기가 유일한 출처다 — 새 드래그
 * 게이트는 DRAG_THRESHOLD_PX 를 가져다 쓰고 자체 상수를 만들지 마라.
 */
export const DRAG_THRESHOLD_PX = 4;

/** 지도 스냅샷 핀만 역사적으로 3px 를 쓴다(MapSnapshotWidget.handlePinPointerDown) — 통합
 *  시점의 값 보존용. 새 코드의 대상이 아니다. 핀 판정을 건드릴 일이 생기면 DRAG_THRESHOLD_PX
 *  로 흡수해 이 상수를 지우는 방향으로 간다. */
export const MAP_PIN_DRAG_THRESHOLD_PX = 3;

/** 섹션 탭을 창 밖으로 끌어 새 창으로 분리(2단계, 2026-09-30, lib/noteDrag.ts) — 창 밖에서 이만큼
 *  머물러야 "놓으면 새 창"으로 무장된다. 창 밖을 스치기만 한 드래그(가장자리의 트리로 가는 길 등)가
 *  창을 만들지 않게 하는 지연이다. 쓰는 곳은 noteDrag 한 곳뿐. */
export const DETACH_DWELL_MS = 600;

/** 같은 기능의 "창 밖" 판정 여유 — 최대화된 단일 모니터처럼 커서가 창 밖으로 나갈 수 없는 경우
 *  뷰포트 가장자리 이 거리 이내도 밖으로 친다. */
export const DETACH_EDGE_PX = 4;
