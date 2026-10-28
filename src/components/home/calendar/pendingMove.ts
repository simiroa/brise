import { axisDayOffsetMin, type TimedEvent } from "../calendarLayout";

/**
 * 시간축의 **낙관적 자리**(드래그 중 미리보기이자 드롭 직후의 새 자리) 한 칩분 — W15. `row`·`from` 은 "이 미리보기를 언제 버려도 되나"를 가르는
 * 꼬리표다(아래 reconcilePreviews): 칩 키(`date_id|시작`)는 옮기면 바뀌어 새 데이터에서 같은 칩을 키로 못 찾으므로, 행(노트+날짜 행+어느 날)과
 * 옮기기 전 자리를 같이 들고 있는다.
 */
export type MovePreview = {
  key: string;
  startMin: number;
  endMin: number;
  row?: string;
  from?: { startMin: number; endMin: number };
};

/** 미리보기 목록이 실제로 달라졌나 — 같은 값이면 예전 배열을 그대로 돌려줘 재렌더를 막는다
 *  (단일 키 시절 `cur.key === … && cur.startMin === …` 로 하던 것과 같은 목적). */
export function samePreview(a: readonly MovePreview[], b: readonly MovePreview[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.key === b[i].key && p.startMin === b[i].startMin && p.endMin === b[i].endMin)
  );
}

/** 칩이 가리키는 **행** — 옮기면 바뀌는 `key` 대신 노트·날짜 행 id 와 어느 날 칩인지(당일/익일, 반복 행은 날마다 칩이 하나씩이다)를 쓴다. */
export function previewRowId(ev: TimedEvent): string {
  return `${ev.item.note_id}|${ev.item.date_id}|${axisDayOffsetMin(ev.startMin)}`;
}

/**
 * 새 미리보기 목록에 꼬리표를 단다. 이미 미리보기가 있던 칩은 **처음의** 꼬리표를 이어받고(키보드를 연달아 누르면 목표는 계속 움직이지만
 * 출발점은 그대로다), 처음 나온 칩은 지금 데이터(`timed`)의 자리를 출발점으로 기록한다. 데이터에 없는 칩은 꼬리표 없이 둔다(버려진다).
 */
export function tagPreviews(
  entries: readonly MovePreview[],
  prev: readonly MovePreview[],
  timed: readonly TimedEvent[],
): MovePreview[] {
  return entries.map((p) => {
    const before = prev.find((x) => x.key === p.key);
    if (before?.row && before.from) return { ...p, row: before.row, from: before.from };
    const ev = timed.find((x) => x.key === p.key);
    return ev ? { ...p, row: previewRowId(ev), from: { startMin: ev.startMin, endMin: ev.endMin } } : p;
  });
}

/**
 * 새 데이터(`timed` — 당일 + 익일 구간을 합친 목록)가 도착했을 때 어떤 미리보기를 버릴지.
 *
 * 예전엔 `plan` 이나 `tailPlan` 이 **한 번이라도 바뀌면** 전부 버렸다. 두 plan 은 서로 다른 조회(달력 탭의 월 조회 · 익일 구간의 자체 조회)에서
 * 따로 도착하므로, 먼저 온 쪽이 아직 **옛 자리**를 담고 있으면 방금 끌어 놓은 칩이 옛 자리로 튀었다가 나머지가 도착해야 제자리로 돌아왔다.
 * 지금은 그 칩의 행을 새 데이터에서 찾아 세 갈래로 가른다:
 *  - 옛 자리 그대로 → 아직 쓰기 반영 전의 낡은 데이터다 → 미리보기를 **남긴다**.
 *  - 목표 자리 → 반영됐다 → 버린다. 그 밖의 자리(이웃에 밀리거나 서버가 다듬은 값)·행이 사라짐/날이 바뀜 → 서버의 답이 이긴다 → 버린다.
 * 바뀐 게 없으면 같은 배열을 돌려준다(재렌더 없음).
 * ponytail: 쓰기가 실제로는 반영되지 않았는데 데이터가 옛 자리 그대로 다시 오면 미리보기가 남는다(날을 바꾸면 비운다) — 반영 실패는
 * commitDateRow 가 false 로 알려 호출자가 이미 비운다.
 */
export function reconcilePreviews(cur: readonly MovePreview[], timed: readonly TimedEvent[]): readonly MovePreview[] {
  if (cur.length === 0) return cur;
  const byRow = new Map(timed.map((ev) => [previewRowId(ev), ev]));
  const keep = cur.filter((p) => {
    if (!p.row || !p.from) return false;
    const ev = byRow.get(p.row);
    return !!ev && ev.startMin === p.from.startMin && ev.endMin === p.from.endMin;
  });
  return keep.length === cur.length ? cur : keep;
}
