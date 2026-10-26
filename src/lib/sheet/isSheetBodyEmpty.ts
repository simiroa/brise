/**
 * 시트 본문(body_md JSON)의 공백 여부를 판정한다.
 * EditorPanel.tsx의 publish effect와 switchSection에서 중복 사용되던 로직을 추출한 순수 헬퍼.
 * - body가 없거나 빈 문자열/공백이면 true
 * - JSON 파싱 후 raw 내용이 있는 셀이 0개면 true
 * - JSON 파싱 실패 시(비정형 본문 등) 본문 문자열 자체가 비어있지 않으면 false
 */
export function isSheetBodyEmpty(body: string | undefined | null): boolean {
  if (!body || !body.trim()) return true;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return true;
    const cells = parsed.cells || {};
    return (
      Object.values(cells).filter(
        (c: any) => c && typeof c === "object" && typeof c.raw === "string" && c.raw.trim().length > 0
      ).length === 0
    );
  } catch {
    return !body || !body.trim();
  }
}
