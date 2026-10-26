/**
 * URL의 세부 종류(유튜브 영상/채널 등)를 판별하는 순수 함수 모음 — 여러 곳이 각자 유튜브 URL
 * 정규식을 복제하던 것(canvas/widgets/LinkCardWidget.tsx의 임베드 판정, settings/CollectSection.tsx의
 * 채널 배지, src-tauri의 URL 판정 3곳)을 프런트 쪽만이라도 한 곳으로 모은다. Rust 쪽
 * (collect/mod.rs::is_youtube_url, commands/collect.rs::is_channel_id)은 언어가 달라 공유 불가 —
 * 동일 판정 로직을 유지해야 한다는 점만 주석으로 남긴다.
 */

/** youtube.com/watch?v=… 또는 youtu.be/… 에서 영상 id를 뽑는다. 아니면 null. */
export function extractYouTubeVideoId(url?: string): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (parsed.hostname.includes("youtube.com")) {
      return parsed.searchParams.get("v");
    }
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace(/^\//, "");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `collect_resolve_youtube_channel`이 만든 채널 구독 피드 URL인지 — 저장된 유튜브 채널 소스는
 * kind='rss'로 보이므로(docs/COLLECT.md §1), 목록·통계에서 "이게 사실 유튜브 채널이다"를
 * 알아내는 유일한 신호는 이 URL 형태뿐이다.
 */
export function isYoutubeChannelFeedUrl(url?: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return (
      parsed.hostname.replace(/^www\./, "").replace(/^m\./, "") === "youtube.com" &&
      parsed.pathname === "/feeds/videos.xml" &&
      /^UC[0-9A-Za-z_-]{22}$/.test(parsed.searchParams.get("channel_id") ?? "")
    );
  } catch {
    return false;
  }
}
