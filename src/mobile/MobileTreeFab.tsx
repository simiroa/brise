import { useEffect } from "react";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../stores/ai";
import { t } from "../i18n/t";
import { IconAi, IconFolderPlus, IconNote } from "../components/icons";
import { MobileSpeedDial, type SpeedDialItem } from "./MobileSpeedDial";

interface MobileTreeFabProps {
  /** AI 가 켜져 있고 닿는가(설정 aiEnabled && aiReachable === true) — 아니면 AI 항목을 흐리게. */
  aiReady: boolean;
  /** 새 폴더 이름 상자(MobileFolderNameModal) — 예전 트리 머리의 새 폴더 버튼과 같은 흐름. */
  onAddFolder: () => void;
  /** 입력 화면을 새 초안으로 연다 — 탭 바 가운데 ＋ 와 같은 경로(MobileApp::enterCapture). */
  onNewNote: () => void;
  /** 폴더 관리 AI 시트(MobileFolderAiSheet). */
  onOpenAi: () => void;
}

/**
 * 노트 탭(폴더 보기) 오른쪽 아래의 ＋ — 입력 화면과 같은 스피드 다이얼(MobileSpeedDial, 같은 스프링·글자 라벨)에
 * 폴더 추가 · 노트 추가 · AI 세 항목(＋ 에서 가까운 것부터)을 준다(오너 2026-10-10).
 * AI 는 노트 내용이 아니라 **폴더 관리**용이다. AI 가 꺼져 있거나 닿지 않으면 입력 화면 다이얼의 AI 처럼 흐리게만 그리고
 * 눌리기는 한다(시트가 이유를 보여 준다). 닿는지는 여기서 한 번 확인한다(MobileNote 와 같은 ensureAiReachable — 캐시된다).
 * 선택 모드(길게 눌러 여러 노트 고르기)에서는 부모가 이 버튼을 그리지 않는다 — 아래쪽은 선택 바의 자리다.
 */
export function MobileTreeFab({ aiReady, onAddFolder, onNewNote, onOpenAi }: MobileTreeFabProps) {
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  useEffect(() => {
    void ensureAiReachable();
  }, [ensureAiReachable]);

  const items: SpeedDialItem[] = [
    { id: "folder", testId: "mobile-tree-fab-folder", label: t("mobileFolderAi.dial_folder"), Icon: IconFolderPlus, onSelect: onAddFolder },
    { id: "note", testId: "mobile-tree-fab-note", label: t("mobileFolderAi.dial_note"), Icon: IconNote, onSelect: onNewNote },
    {
      id: "ai",
      testId: "mobile-tree-fab-ai",
      label: t("mobileFolderAi.dial_ai"),
      Icon: IconAi,
      onSelect: onOpenAi,
      muted: !aiReady,
      title: aiReady ? undefined : getAiDisabledHint(availability, "mobile"),
    },
  ];

  return (
    <div className="mobile-tree-fab" data-testid="mobile-tree-fab">
      <MobileSpeedDial placement="float" label={t("mobileFolderAi.fab_label")} items={items} />
    </div>
  );
}
