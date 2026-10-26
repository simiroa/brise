/**
 * 부팅 구간 표식 — performance.mark 만 찍는다(비용 ~0, 릴리스에도 남는다). 콜드 스타트 측정은 CDP 로
 * `performance.getEntriesByType("mark")` 를 읽는다 — 이름은 `brise:` 접두. 의존이 없어 main.tsx 가
 * 정적으로 불러도 펫 창 번들에 아무것도 끌고 오지 않는다.
 */
export function bootMark(name: string): void {
  try {
    performance.mark(`brise:${name}`);
  } catch {
    // silent-ok: 표식은 측정 보조일 뿐 — 실패가 부팅을 막으면 안 된다.
  }
}
