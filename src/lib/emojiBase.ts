import { useEffect } from "react";
import { createBaseDirCache } from "./baseDirCache";
import { setEmojiRenderState } from "./emoji/emojiCore";
import { callSilent } from "./invoke";

/**
 * Shared module-level cache for the emoji base directory + the Tauri
 * convertFileSrc helper.
 */
export const useEmojiBase = createBaseDirCache("emoji_base_dir");

/**
 * 창 하나의 컬러 이모지 렌더 상태 초기화(base/convert + 컬러 팩 유무). App 을 부팅하지 않는 보조 창도
 * 쓴다. `skipStatus`: emoji_style_status 는 로컬 디스크를 보는 커맨드라 HTTP 표면에서 제외돼 있어
 * 동기화 브라우저 탭에서 부르면 NOT_FOUND 만 난다(baseDirCache.ts) — 브라우저 모드는 true.
 * 훅이므로 호출자의 조기 return 위에서 부를 것.
 */
export function useEmojiRenderSync(skipStatus = false): void {
  const { baseDir, convert } = useEmojiBase();
  useEffect(() => {
    setEmojiRenderState({ base: baseDir, convert });
  }, [baseDir, convert]);
  useEffect(() => {
    if (skipStatus) return;
    callSilent<{ color: { present: boolean } }>("emoji_style_status")
      .then((r) => setEmojiRenderState({ colorPresent: r.color.present }))
      // silent-ok: 컬러 이모지 팩 유무는 선택적 표시 — 실패는 callSilent 가 진단에 남기고, 흑백 폴백이 기본값이다.
      .catch(() => {});
  }, [skipStatus]);
}
