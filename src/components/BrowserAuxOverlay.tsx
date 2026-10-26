import { ModalShell } from "./ModalShell";
import { SettingsPanel } from "./SettingsPanel";
import { t } from "../i18n/t";

interface BrowserAuxOverlayProps {
  onClose: () => void;
}

/**
 * 동기화(beta) 브라우저 탭(태블릿) 전용 인앱 설정 오버레이 — App.tsx:20 의 ponytail 주석이 지목한
 * 경로. 데스크톱(!browser)은 별도 OS 창(settings_window_open)을 그대로 쓴다 — 이 컴포넌트는 그쪽
 * 경로에서는 아예 렌더되지 않는다(App.tsx 의 `browser &&` 가드).
 *
 * 활동 이력은 여기 없다(W2b, WORKORDER-2026-09-02-mobile-rework.md 작업 B — W5 의 D4 설계를
 * 정정). `activity_list`·`note_snapshot_*` 전부가 `http:false`다(specs/commands/activity.yaml·
 * snapshots.yaml, docs/CLIENT-RULES.md §2-5 "원격 영구 도달 불가") — 실수가 아니라 명시된 제품
 * 결정이고, `src-tauri/src/sync_server/dispatch.gen.rs` 에 이 커맨드들이 0건인 것이 그 증거다.
 * 태블릿에서 열어봐야 활동 목록은 영원히 빈 화면이고 스냅샷 복원은 항상 404 다. 버튼 자체를
 * App.tsx 가 `!browser` 로 가려 데스크톱 OS 창 전용으로 되돌렸다 — 여기서 "activity" 분기를
 * 다시 만들지 마라. 되돌리려면 먼저 CLIENT-RULES.md §8 갱신 + 백엔드가 그 커맨드들을
 * http:true 로 열어야 한다(이 웨이브 권한 밖).
 *
 * ModalShell 을 감쌀 뿐 재구현하지 않는다 — inert 처리·Esc·overlayStack 배선은 그 컴포넌트 소유.
 * AuxWindowChrome 은 쓰지 않는다(Tauri 창 API 의존이라 브라우저 탭에서 성립하지 않는다).
 */
export function BrowserAuxOverlay({ onClose }: BrowserAuxOverlayProps) {
  return (
    <ModalShell title={t("settings.title")} onClose={onClose} width={960}>
      {/* SettingsPanel 은 별도 OS 창(AuxWindowChrome) 안에서 flex:1 로 자기 높이를 채우도록
          만들어졌다 — ModalShell 의 본문(.scroll)은 flex 컨테이너가 아니라 그 계약이 성립하지
          않는다. 여기서 높이를 가진 flex 컨텍스트를 하나 주는 것은 레이아웃 재설계가 아니라
          기존 컴포넌트가 이미 요구하는 조건을 만들어줄 뿐이다 — 없으면 좌측 레일이 본문과
          함께 스크롤돼 버린다(태블릿은 "데스크톱 웹페이지 그대로" 여야 한다, D2). */}
      <div style={{ display: "flex", flexDirection: "column", height: "70vh" }}>
        <SettingsPanel onClose={onClose} />
      </div>
    </ModalShell>
  );
}
