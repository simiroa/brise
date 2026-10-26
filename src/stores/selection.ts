import { create } from "zustand";

/**
 * W7-g 다중선택 — 노트 트리와 첨부 바가 공유하는 선택 상태.
 *
 * **왜 전용 스토어인가**: 선택은 *데이터*지 뷰 상태가 아니다. 트리는 react-window 로 가상
 * 스크롤되므로 선택된 행이 화면 밖으로 나가면 DOM 은 언마운트되지만 선택은 남아야 한다 —
 * 컴포넌트 로컬 state 에 두면 그 순간 사라진다(TreeListRow 가 인스턴스를 재활용한다는 사실도
 * 같은 결론을 가리킨다). id 만 들고 있는 스토어라 마운트 여부와 완전히 무관하다.
 * `stores/ui.ts` 에 얹지 않은 이유는 하나: 아래 순수 리듀서들을 스토어 없이 그대로 테스트하고
 * 싶어서다(ui.ts 는 프리뷰 히스토리·모달 토글이 섞인 잡화점이다).
 *
 * **노트와 첨부는 독립**이다. 서로 다른 id 공간이고 서로 다른 화면(좌측 트리 / 에디터 하단
 * 카드)에 살아 있으며, 한쪽을 고르는 동안 다른 쪽 선택이 사라지면 사용자가 방금 만든 것을
 * 이유 없이 잃는다. 같은 로직을 두 벌 쓰지 않도록 순수 함수는 하나만 두고 데이터만 두 슬롯이다.
 */

/**
 * 순서 있는 id 목록 + Shift 범위의 기준점(anchor).
 *
 * `anchorIndex` — anchor 를 클릭한 **행의 위치**(react-window 의 `index`, rows.ts::rowNoteIds 와
 * 같은 좌표계). id 만으로는 즐겨찾기 노트처럼 같은 id 가 화면 두 곳(즐겨찾기 섹션 + 소속 폴더)에
 * 동시에 그려질 때 "어느 쪽 행을 클릭했는지"를 구분할 수 없다 — indexOf(id) 는 항상 첫 등장만
 * 찾는다. anchorIndex 를 같이 들고 있으면 rangeSelection 이 id 대신 실제 클릭 위치를 좌표로 써서
 * 두 문맥(즐겨찾기 안 / 폴더 안) 모두에서 올바른 범위를 잡는다. `null` = 위치 정보 없이 선택된
 * 경우(롱프레스·체크박스 토글, 또는 orderedIds 자체가 중복 없는 목록이라 애초에 필요 없는 경우) —
 * 이때 rangeSelection 은 indexOf(anchor) 로 조용히 폴백한다.
 */
export interface Selection {
  ids: string[];
  anchor: string | null;
  anchorIndex: number | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null, anchorIndex: null };

/** 클릭 한 번이 어떤 제스처였는지. Cmd 는 macOS 의 Ctrl 자리다. */
export interface ClickMods {
  /** Ctrl/Cmd — 개별 토글. */
  toggle: boolean;
  /** Shift — anchor 부터 범위. */
  range: boolean;
}

/**
 * 수식키 없는 단순 클릭 — 탐색기 표준: **이 행 하나만의 선택**으로 만든다(비우지 않는다).
 *
 * W8-c 이전엔 `ids: []` 를 돌려줬다("비우고 anchor 만 옮긴다") — Shift 범위는 anchor 만 보고
 * 계산하니 문제가 없었지만, `toggleSelection` 은 anchor 를 안 보고 `sel.ids` 에만 더하기 때문에
 * "A 클릭 → B 를 Ctrl+클릭"이 `ids=[B]` 하나로 끝나는 비대칭이 있었다(Shift 는 되는데 Ctrl 은
 * 안 되는 것처럼 보이는 버그). 이제 `ids: [id]` 로 A 자신을 포함시켜 두 제스처가 같은 출발점에서
 * 시작한다.
 *
 * **"1개 선택"의 시각적 의미**: 노트 트리에서 단순 클릭은 그 노트를 열기도 한다(호출자 몫) —
 * 그러면 activeId 와 이 1개짜리 선택이 항상 같은 행을 가리키게 되므로, 이미 있는 active 왼쪽
 * 바 표시와 다중선택 배경 틴트가 같은 행에 겹쳐 이중 신호가 된다. 그래서 배경 틴트는 호출자
 * (notetree/index.tsx) 가 **selection 이 2개 이상일 때만** 켠다 — `SelectionActionBar` 를
 * 2개부터 띄우는 것과 같은 판단("1개는 이미 다른 채널이 있다")을 시각 표시에도 그대로 적용한
 * 것뿐, 스토어 자체는 1개도 정직하게 선택으로 들고 있는다.
 */
export function selectSingle(id: string, atIndex: number | null = null): Selection {
  return { ids: [id], anchor: id, anchorIndex: atIndex };
}

/** Ctrl/Cmd+클릭 — 있으면 빼고 없으면 뒤에 붙인다. anchor 는 마지막으로 만진 행. */
export function toggleSelection(sel: Selection, id: string, atIndex: number | null = null): Selection {
  const ids = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id];
  return { ids, anchor: id, anchorIndex: atIndex };
}

/**
 * Shift+클릭 — anchor 부터 target 까지를 **화면 순서**로 선택하며 기존 선택을 대체한다
 * (탐색기·메일 클라이언트의 표준 동작). `orderedIds` 는 rows.ts::rowNoteIds 처럼 **행 배열과
 * 인덱스가 그대로 대응**하는 목록이다 — 노트가 아닌 행은 `null`. 슬라이스에 낀 `null` 은 결과에서
 * 걸러지므로 폴더 헤더·미분류 헤더·휴지통·아카이브·divider 같은 비-노트 행은 범위에서 자연스럽게
 * 빠진다.
 *
 * **좌표는 id 가 아니라 위치**로 계산한다: `atIndex` 가 target 이 실제로 클릭된 행의 인덱스,
 * `sel.anchorIndex` 가 anchor 가 클릭됐던 행의 인덱스다. id 만으로 indexOf 를 쓰면 즐겨찾기
 * 노트처럼 같은 id 가 화면 두 곳(즐겨찾기 섹션 + 소속 폴더)에 동시에 있을 때 항상 첫 등장(즐겨찾기
 * 쪽)으로 오인해, 폴더 안에서 조작했는데도 즐겨찾기 섹션까지 낀 범위가 잡히거나 그 반대가 된다 —
 * 압축 없는 배열 + 실제 클릭 위치가 있어야 두 문맥 모두 올바르게 풀린다.
 *
 * `atIndex` 생략 시 / `sel.anchorIndex` 가 더 이상 그 자리를 가리키지 않을 때(폴더 접기·필터
 * 변경으로 배열이 바뀐 뒤 — `orderedIds[sel.anchorIndex] !== sel.anchor` 로 검증)는 `indexOf` 로
 * 폴백한다 — 위치 정보가 없거나 stale 해도 조용히 아무 일도 안 하는 것보다 낫다. 범위가 같은 id 의
 * 두 행 모두를 가로지르면 선택 결과는 **한 번만** 나열한다(중복 낀 슬라이스를 runBatch 로 넘기면
 * 그 노트에 커맨드가 두 번 나간다).
 *
 * anchor 가 없거나(첫 클릭이 Shift) 더 이상 화면에 없으면 target 하나만 고르고 anchor 를
 * 거기로 옮긴다.
 */
export function rangeSelection(
  sel: Selection,
  orderedIds: readonly (string | null)[],
  id: string,
  atIndex?: number,
): Selection {
  const to = atIndex !== undefined && orderedIds[atIndex] === id ? atIndex : orderedIds.indexOf(id);
  if (to < 0) return sel;
  const from =
    sel.anchor === null
      ? -1
      : sel.anchorIndex !== null && orderedIds[sel.anchorIndex] === sel.anchor
        ? sel.anchorIndex
        : orderedIds.indexOf(sel.anchor);
  if (from < 0) return { ids: [id], anchor: id, anchorIndex: to };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const ids = [...new Set(orderedIds.slice(lo, hi + 1).filter((x): x is string => x !== null))];
  return { ids, anchor: sel.anchor, anchorIndex: sel.anchorIndex };
}

/**
 * 근거 데이터가 바뀌면(폴더 접기, 필터 변경, 노트북 전환, 다른 곳에서의 삭제/아카이브) 더 이상
 * 존재하지 않는 id 를 떨군다. 변한 게 없으면 **같은 객체를 그대로 돌려준다** — 호출자가 매
 * 렌더 effect 에서 불러도 상태 갱신이 일어나지 않아 루프가 생기지 않는다.
 *
 * anchor 가 통째로 사라졌을 때만 anchorIndex 도 같이 지운다. anchor 가 살아있지만 위치만
 * 바뀌었을(stale index) 경우는 여기서 복구하지 않는다 — rangeSelection 이 다음 Shift+클릭에서
 * `orderedIds[sel.anchorIndex] === sel.anchor` 검증으로 스스로 indexOf 폴백하므로 이중으로
 * 처리할 필요가 없다.
 */
export function pruneSelection(sel: Selection, availableIds: readonly (string | null)[]): Selection {
  const available = new Set(availableIds);
  const ids = sel.ids.filter((id) => available.has(id));
  const anchorDropped = sel.anchor !== null && !available.has(sel.anchor);
  const anchor = anchorDropped ? null : sel.anchor;
  const anchorIndex = anchorDropped ? null : sel.anchorIndex;
  if (ids.length === sel.ids.length && anchor === sel.anchor && anchorIndex === sel.anchorIndex) {
    return sel;
  }
  return { ids, anchor, anchorIndex };
}

/**
 * 클릭 제스처 하나를 선택 상태에 적용. `atIndex` 생략 시 `orderedIds.indexOf(id)` 로 기본값을
 * 계산한다 — 중복 없는 목록(첨부 바 등)을 넘기는 호출자는 위치를 몰라도 그대로 동작한다.
 */
export function applyClick(
  sel: Selection,
  id: string,
  mods: ClickMods,
  orderedIds: readonly (string | null)[],
  atIndex: number = orderedIds.indexOf(id),
): Selection {
  if (mods.range) return rangeSelection(sel, orderedIds, id, atIndex);
  if (mods.toggle) return toggleSelection(sel, id, atIndex);
  return selectSingle(id, atIndex);
}

interface SelectionStore {
  notes: Selection;
  attachments: Selection;
  /**
   * `atIndex` — 클릭된 행의 실제 위치(rows.ts::rowNoteIds 좌표계). 생략하면 applyClick 이
   * `orderedIds.indexOf(id)` 로 채운다 — 첨부 바처럼 중복 없는 목록을 넘기는 호출자는 그대로 둔다.
   */
  clickNote: (id: string, mods: ClickMods, orderedIds: readonly (string | null)[], atIndex?: number) => void;
  clickAttachment: (
    id: string,
    mods: ClickMods,
    orderedIds: readonly (string | null)[],
    atIndex?: number,
  ) => void;
  /** 롱프레스(모바일)·체크박스형 진입 — 수식키 없이 토글만. */
  toggleNote: (id: string) => void;
  toggleAttachment: (id: string) => void;
  pruneNotes: (availableIds: readonly (string | null)[]) => void;
  pruneAttachments: (availableIds: readonly (string | null)[]) => void;
  clearNotes: () => void;
  clearAttachments: () => void;
  /** 배치 실행 후 성공한 것만 빼고 실패한 것은 선택에 남긴다. */
  keepNotes: (ids: string[]) => void;
  keepAttachments: (ids: string[]) => void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  notes: EMPTY_SELECTION,
  attachments: EMPTY_SELECTION,
  clickNote: (id, mods, orderedIds, atIndex) =>
    set((s) => ({ notes: applyClick(s.notes, id, mods, orderedIds, atIndex) })),
  clickAttachment: (id, mods, orderedIds, atIndex) =>
    set((s) => ({ attachments: applyClick(s.attachments, id, mods, orderedIds, atIndex) })),
  toggleNote: (id) => set((s) => ({ notes: toggleSelection(s.notes, id) })),
  toggleAttachment: (id) => set((s) => ({ attachments: toggleSelection(s.attachments, id) })),
  pruneNotes: (availableIds) => set((s) => ({ notes: pruneSelection(s.notes, availableIds) })),
  pruneAttachments: (availableIds) =>
    set((s) => ({ attachments: pruneSelection(s.attachments, availableIds) })),
  clearNotes: () => set((s) => (s.notes.ids.length === 0 && s.notes.anchor === null ? s : { notes: EMPTY_SELECTION })),
  clearAttachments: () =>
    set((s) =>
      s.attachments.ids.length === 0 && s.attachments.anchor === null
        ? s
        : { attachments: EMPTY_SELECTION },
    ),
  keepNotes: (ids) => set((s) => ({ notes: pruneSelection(s.notes, ids) })),
  keepAttachments: (ids) => set((s) => ({ attachments: pruneSelection(s.attachments, ids) })),
}));
