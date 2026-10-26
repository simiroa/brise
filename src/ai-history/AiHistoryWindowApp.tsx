import { useEffect } from "react";
import { AiHistoryPanel } from "../components/AiHistoryPanel";
import { AuxWindowChrome } from "../components/AuxWindowChrome";
import { useAiStore } from "../stores/ai";
import { t } from "../i18n/t";
import { listenDataReplaced } from "../lib/remoteNoteWrite";

/**
 * AI 히스토리 창(#/ai-history)의 루트. 별도 OS 창인 이유는 src-tauri/src/aux_window.rs 참고.
 *
 * 노트 트리·에디터는 부팅하지 않는다. 히스토리는 DB 에서 loadHistory() 로 읽는다.
 */
export function AiHistoryWindowApp() {
  // 데이터가 통째로 바뀌면(초기화·복원·대체 가져오기) 지워진 히스토리를 계속 보여 주지 않게 다시 불러온다.
  useEffect(() => listenDataReplaced(), []);
  return (
    <AuxWindowChrome
      title={t("ai.history_title") || "AI History"}
      closeTestId="ai-history-window-close"
      onReady={() => {
        void useAiStore.getState().loadHistory();
      }}
    >
      <AiHistoryPanel />
    </AuxWindowChrome>
  );
}
