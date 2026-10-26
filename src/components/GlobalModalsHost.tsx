import { Suspense } from "react";
import { ErrorBoundary } from "./common/ErrorBoundary";
import { LazyAiConfirmModal, LazyAiResultModal, LazyFolderOrganizeModal, LazyTrashModal, LazyFilterModal, LazyArchiveModal, LazyExportModal, LazyOnboardingWizard, LazyBrowserAuxOverlay, LazySettingsPanel } from "../lazySurfaces";
// 다른 파일이 이 이름들로 가져가던 것을 그대로 둔다 — 정의는 src/lazySurfaces.ts 한 곳.
export { LazyAiConfirmModal, LazyAiResultModal, LazyFolderOrganizeModal, LazyTrashModal, LazyFilterModal, LazyArchiveModal, LazyExportModal, LazyOnboardingWizard, LazyBrowserAuxOverlay, LazySettingsPanel };

// Lazy-loaded modal components
// 내보내기·인쇄 모달 — 섹션 탭·노트 우클릭·제목 줄 메뉴 세 진입점이 stores/exportModal 로 같은 모달을 연다.
// 온보딩은 모달이 아니라 창 전체 페이지라(안 C) 여기서 렌더하지 않고 App.tsx 본문 자리에 둔다 —
// 지연 로드 정의만 이 파일의 다른 지연 표면들과 한곳에 둔다.

// Optional in-app panels for non-desktop environments (Settings, Activity)

interface GlobalModalsHostProps {
  browser: boolean;
  browserSettingsOpen: boolean;
  onCloseBrowserSettings: () => void;
}

export function GlobalModalsHost({
  browser,
  browserSettingsOpen,
  onCloseBrowserSettings,
}: GlobalModalsHostProps) {
  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={null}>
          <LazyAiConfirmModal />
          <LazyAiResultModal />
          <LazyFolderOrganizeModal />
          <LazyTrashModal />
          <LazyFilterModal />
          <LazyArchiveModal />
          <LazyExportModal />
          {/* W5/W2b: 브라우저(태블릿) 전용 인앱 설정 오버레이 — !browser 경로는 절대 렌더하지
              않는다(별도 OS 창 커맨드가 지금과 100% 그대로 동작해야 한다). */}
          {browser && browserSettingsOpen && (
            <LazyBrowserAuxOverlay onClose={onCloseBrowserSettings} />
          )}
        </Suspense>
      </ErrorBoundary>
    </>
  );
}
