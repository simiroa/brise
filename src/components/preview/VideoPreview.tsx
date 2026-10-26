import { openAttachmentExternal } from "../../lib/attachmentOpen";
import type { Attachment } from "../../lib/commands.gen";
import { IconFile } from "../icons";
import { NoFormatFallback } from "./shared";

/**
 * 동영상 첨부 미리보기. 오디오와 달리 커스텀 플레이어를 만들지 않는다 — 웹뷰의 기본 컨트롤이
 * 탐색·볼륨·전체화면·재생속도를 이미 다 갖고 있고, 오디오 쪽 커스텀 플레이어는 파형 같은
 * 오디오 고유 표현이 필요해서 생긴 것이다.
 *
 * `baseDir`/`convert` 가 없으면(브라우저 모드 등) 파일 URL 을 만들 수 없으므로 "외부에서 열기"로
 * 물러난다 — 오디오 분기와 같은 규칙.
 */
export function VideoPreview({
  att,
  baseDir,
  convert,
}: {
  att: Attachment;
  baseDir: string | null;
  convert: ((path: string) => string) | null;
}) {
  const openExternal = () => openAttachmentExternal(att.id);

  if (!baseDir || !convert || !att.rel_path) {
    return <NoFormatFallback icon={<IconFile size={48} strokeWidth={1.5} style={{ color: "var(--faint)" }} />} onOpenExternal={openExternal} />;
  }

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-6)", minHeight: 0 }}>
      {/* key: 다른 첨부로 넘어갈 때 <video> 를 갈아 끼운다 — src 만 바꾸면 이전 영상의 재생 위치와
          버퍼가 남아 새 영상이 엉뚱한 지점에서 시작한다. */}
      <video
        key={att.id}
        src={convert(`${baseDir}/${att.rel_path}`)}
        controls
        preload="metadata"
        data-testid="attachment-video"
        style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: "var(--radius-sm)", background: "#000" }}
      />
    </div>
  );
}
