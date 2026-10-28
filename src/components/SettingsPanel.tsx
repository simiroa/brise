import { Suspense, useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { t } from "../i18n/t";
import { isBrowser } from "../lib/env";
import { BROWSER_SETTINGS_PAGES } from "../lib/remoteSettingsPolicy";
import { reportFallback } from "../lib/diag";
import { startIdlePreload, type PreloadableComponent } from "../lib/lazyPreload";
import "../styles/settingsAnchor.css";
import "../styles/settingsLayout.css";
import { anchorId, SettingsAnchorContext, type SettingsAnchor } from "./settings/settingsAnchor";
import { listenMany } from "../lib/tauriListen";
import { useSettingsStore } from "../stores/settings";
import { useSeedFeatureBriefsOnce } from "../lib/useFeatureBrief";
import { GeneralSection } from "./settings/GeneralSection";
import { EditorSection } from "./settings/EditorSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { SettingsNav, type SettingsNavItem } from "./settings/SettingsNav";
import { SettingsHeader, type SettingsScope } from "./settings/SettingsHeader";
import { useUpdateStatus } from "./settings/updateStatus";
import { FeatureBriefModal } from "./onboarding/FeatureBriefModal";
import { useSettingsBusy } from "./settings/settingsBusy";
import {
  IconSettings,
  IconBell,
  IconPaperclip,
  IconPalette,
  IconMapPin,
  IconLayoutGrid,
  IconFileImport,
  IconLink,
  IconSparkles,
  IconShield,
  IconWrench,
  IconChat,
  IconArchive,
  IconScale,
  IconSmile,
  IconEdit,
  IconNewspaper,
} from "./icons";
import { DashboardTabsSection, ViewSection, NotificationsSection, AiChatSection, LicenseSection, CollectSection, AiPermissionsSection, AiCapabilityCatalog, AiProviderSection, AiPresetsSection, AiActionsCard, DataManagementSection, AttachmentsSection, SyncSection, PetSection, BriefingSection } from "../lazySurfaces";

// 라이선스 페이지는 고지 요약(noticesSummary.json)만 싣고 전문은 OS 브라우저로 연다 — 그 요약도
// 페이지를 열기 전엔 필요 없으니 다른 페이지처럼 lazy 로 둔다.
// AI 프리셋 편집기(AiActionEditor)는 자기 페이지에 산다 — 기능 페이지 카드의 버튼은 그 페이지로 옮겨 갈 뿐이다.


interface SettingsPanelProps {
  /** 설정 창을 닫는다(창 자체를 닫는 것 — settings/SettingsWindowApp.tsx). 일부 섹션이 작업을
   *  마치고 화면을 닫아야 해서 아래로 내려간다(예: 데이터 관리의 가져오기 완료). */
  onClose: () => void;
}

/**
 * 설정 화면의 본문.
 *
 * PLAN-2026-09-01 W0 로 레일이 9개 기능 페이지 + 플러그인 그룹이 됐고, PLAN-2026-09-12 §1(D1)
 * 로 **고아 항목 없는 5그룹**이 됐다 — 일반(일반·에디터·알림 및 일정·모양·지역·대시보드) ·
 * 기능(수집·연결) · AI(연결·권한·기능·AI 프리셋·채팅) · 시스템(데이터·라이선스) · 플러그인(펫·브리핑).
 * 페이지 id 는 딥링크·AiCapabilityCatalog 의 link 대상이라 한 번 정하면 바꾸지 않는다(ai / collect /
 * pet / view / …) — 바뀌는 것은 라벨과 그룹뿐이다.
 *
 * 이 컴포넌트는 창 셸이다 — 레일·페이지 전환·딥링크 앵커·닫기만 갖는다. 페이지 상태(AI 연결 값,
 * 가져오기 대화상자, 재편 계획 등)는 각 섹션이 스스로 갖는다.
 */
/** 없어진 페이지 id → 지금 사는 페이지(와 그 안의 기본 앵커). 딥링크·`settings-navigate`·AI 기능 카드가 옛 id 를 아직 쓸 수 있다.
 *  ai_presets: 2026-10-28 에 AI 기능 페이지 맨 아래로 합쳐졌다(별도 페이지 폐지) — 프리셋 카드는 그 페이지의 맨 아래라
 *  앵커 없이 열면 맨 위에 떨어진다. 호출자가 앵커를 따로 주지 않았을 때만 이 기본 앵커를 쓴다. */
const LEGACY_PAGES: Record<string, { page: string; anchor?: string }> = {
  ai_presets: { page: "ai_features", anchor: "ai_presets" },
};
const resolveLegacyPage = (id: string): { page: string; anchor?: string } => LEGACY_PAGES[id] ?? { page: id };

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const updateCheckAuto = useSettingsStore((s) => s.updateCheckAuto);
  const updatePhase = useUpdateStatus((s) => s.phase);
  // PLAN-2026-09-04-local-import §3b — 첫 부팅 자동 감지가 찾은, 아직 소스로 등록되지 않은 로컬
  // 후보 개수. 수집 레일 항목에 뱃지로 얹는다(0이면 평범한 라벨).
  const collectDetectPending = useSettingsStore((s) => s.collectDetectPending);
  // PLAN-2026-08-30 §4 W7 — 소급 금지 시딩(정확히 한 번, 첫 loaded 전환에만). 트리거 자체는
  // 각 섹션(AiPermissionsSection/AiCapabilityCatalog/SyncSection)이 각자의 토글
  // 핸들러에서 useFeatureBriefTrigger()를 부른다 — 여기서는 시딩만.
  useSeedFeatureBriefsOnce();
  // 설정 창이 떴다 — 나머지 설정 페이지(src/lazySurfaces.ts 의 idle:"settings")를 한가할 때 미리 받아 레일을 눌렀을 때
  // 대기 화면(React 19 의 300ms)이 끼지 않게 한다. 태블릿(브라우저 모드)은 받지 않는다.
  useEffect(() => startIdlePreload("settings", isBrowser()), []);
  // W5: 태블릿(브라우저)은 이 패널을 그대로 띄우되(D9), 원격에서 성립하지 않는 페이지는 렌더도
  // 하지 않는다 — remoteSettingsPolicy.BROWSER_SETTINGS_PAGES 가 단일 관문(SSOT).
  const browser = isBrowser();
  // 설정 창이 열릴 때 무음 확인 1회(PLAN-2026-10-24 §3) — 결과는 일반 페이지 카드와 레일 점이 쓴다. 이미 확인한
  // 적이 있으면(idle 이 아니면) 다시 묻지 않는다. 수동 재확인은 카드 버튼이 한다.
  useEffect(() => {
    if (browser || !updateCheckAuto) return;
    if (useUpdateStatus.getState().phase === "idle") void useUpdateStatus.getState().probe();
  }, [browser, updateCheckAuto]);
  // 데이터 페이지의 되돌릴 수 없는 작업(복원·초기화·가져오기 …)이 도는 동안엔 창을 닫지 못한다.
  const busy = useSettingsBusy((s) => s.busy);
  // 딥링크(2026-09-27): 설정 창이 새로 만들어질 때 Rust 가 `index.html?page=<id>#/settings` 로 연다
  // (settings_window_open 의 page 인자). 해시 라우트(main.tsx)는 `#/settings` 정확 일치라 쿼리는 해시
  // 앞에 온다. 모르는 id 는 아래 `activePage` 의 폴백이 첫 페이지로 떨어뜨린다.
  const [page, setPage] = useState(() => resolveLegacyPage(new URLSearchParams(window.location.search).get("page") || "general").page);
  // 딥링크 앵커(?anchor= / settings-navigate {page,anchor}) — 아래 effect 가 스크롤·강조 뒤 지운다.
  const [anchor, setAnchor] = useState<SettingsAnchor | null>(() => {
    const q = new URLSearchParams(window.location.search);
    const a = q.get("anchor");
    if (a && q.get("page")) return { name: a };
    const legacyAnchor = resolveLegacyPage(q.get("page") || "").anchor;
    return legacyAnchor ? { name: legacyAnchor } : null;
  });
  const contentRef = useRef<HTMLDivElement | null>(null);
  // 본문 스크롤바가 차지하는 폭 — 위 검색 줄이 같은 만큼 오른쪽을 비워 두 줄의 열이 한 줄로 정렬된다(scrollbarGutter: stable 이라
  // 늘 같은 값이지만 OS·확대 배율마다 다르다). jsdom 에는 레이아웃이 없어 0 이다.
  const [sbW, setSbW] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setSbW(Math.max(0, el.offsetWidth - el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 마지막 이동 요청 번호 — 아직 받는 중인 페이지의 늦은 완료가 그 뒤에 고른 페이지를 덮지 않게.
  const navSeq = useRef(0);

  const handleSelectPage = (rawId: string, anchorName?: string) => {
    const { page: id, anchor: legacyAnchor } = resolveLegacyPage(rawId);
    const seq = ++navSeq.current;
    const go = () => {
      if (seq !== navSeq.current) return;
      setPage(id);
      const target = anchorName ?? legacyAnchor;
      setAnchor(target ? { name: target } : null);
      if (contentRef.current) {
        contentRef.current.scrollTop = 0;
      }
    };
    // 대상 페이지의 지연 화면을 먼저 받고 옮긴다 — 받기 전에 옮기면 빈칸이 React 19 의 300ms 동안 보인다.
    // 레일 항목은 마우스 올림·포커스에서 이미 받아 두므로 보통 바로 옮긴다; 딥링크·섹션 안 이동 버튼은 여기서 받는다.
    // allPages 는 아래에서 정의되지만 이 함수는 렌더가 끝난 뒤에만 불린다(첫 렌더의 것을 잡은 딥링크 리스너도
    // 같은 모듈 상수를 본다).
    const surfaces = allPages.find((p) => p.id === id)?.surfaces ?? [];
    if (surfaces.every((c) => c.loaded)) go();
    else void Promise.all(surfaces.map((c) => c.preload())).then(go);
  };

  // 이미 열린 설정 창으로 온 딥링크 — Rust(settings_window_open 의 page 인자)가 창을 앞으로 가져오며
  // 이 이벤트로 페이지를 알린다. 처음 여는 창은 위 useState 가 URL 쿼리에서 읽는다. handleSelectPage 는
  // 안정적인 것(setPage·contentRef)만 쓰므로 첫 렌더의 것을 잡아 둬도 된다.
  useEffect(
    () =>
      listenMany([
        [
          "settings-navigate",
          (e: { payload: unknown }) => {
            const p = e.payload;
            if (typeof p === "string" && p) handleSelectPage(p);
            else if (p && typeof p === "object" && typeof (p as { page?: unknown }).page === "string") {
              const { page: pg, anchor: an } = p as { page: string; anchor?: unknown };
              if (pg) handleSelectPage(pg, typeof an === "string" && an ? an : undefined);
            }
          },
        ],
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 앵커 소비 — 페이지가 렌더된 뒤에야 요소가 생기므로(lazy 섹션) 프레임마다 찾아 최대 ~1초 기다린다.
  // 새 객체가 세워질 때마다 돌므로 같은 앵커를 다시 보내도 다시 스크롤된다.
  useEffect(() => {
    if (!anchor) return;
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const el = document.getElementById(anchorId(anchor.name));
      if (el) {
        // scrollIntoView 는 모든 조상 컨테이너를 스크롤해 설정 창 전체(제목줄 포함)가 위로 밀려 올라간다 —
        // 본문 스크롤 컨테이너(contentRef)만 직접 움직인다.
        const box = contentRef.current;
        if (box) {
          const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
          box.scrollTop = Math.max(0, box.scrollTop + delta - 16);
        }
        el.classList.remove("settings-anchor-flash");
        void el.offsetWidth; // 같은 요소 재강조 — 애니메이션 재시작
        el.classList.add("settings-anchor-flash");
        window.setTimeout(() => el.classList.remove("settings-anchor-flash"), 1300);
        setAnchor(null);
      } else if (performance.now() - start > 1000) {
        reportFallback("settings", "anchor_not_found", anchor.name);
        setAnchor(null);
      } else {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchor]);

  // PLAN-2026-09-12 §1(D1): 레일은 5그룹이고 **고아 항목이 없다**. 배열 순서가 곧 레일 순서이고,
  // 그룹 헤더는 SettingsNav 가 "앞 항목과 group 이 다른 첫 항목" 앞에만 세운다 — 여기서 같은
  // 그룹끼리 붙여 두는 것이 유일한 계약이다.
  // **페이지 id 는 바꾸지 않는다** — 딥링크와 AiCapabilityCatalog 의 link 대상이다. 라벨만 바뀐다.
  // surfaces = 그 페이지가 그리는 지연 화면(src/lazySurfaces.ts) — 레일 항목의 의도·handleSelectPage 가 미리 받는다.
  // 일반·에디터·모양은 즉시 import 라 없다.
  // scope = 이 페이지의 설정이 노트북별인가 앱 전체인가(PLAN-2026-10-24 D5) — 헤더 범위 칩이 읽는 **유일한 곳**.
  // 노트북별 키를 하나라도 품은 섞인 페이지는 "notebook" 이다(칩은 페이지 단위 주장이라 "앱 전체"가 거짓이 된다).
  const allPages: Array<
    Omit<SettingsNavItem, "surfaces"> & {
      scope: SettingsScope;
      render: () => ReactNode;
      surfaces?: ReadonlyArray<Pick<PreloadableComponent<ComponentType>, "preload" | "loaded">>;
    }
  > = [
    // ── 일반 ────────────────────────────────────────────────────────────────
    {
      id: "general",
      scope: "notebook",
      label: t("settings.page_general"),
      group: "general",
      icon: <IconSettings size={12} strokeWidth={2} />,
      // 업데이트가 있으면 레일에 점 — 카드(ProductUpdateCard)가 같은 상태를 읽는다(D2).
      dot: updatePhase === "available" ? { label: t("settings.nav_update_available") } : undefined,
      render: () => <GeneralSection onClose={onClose} />,
    },

    // 에디터 (2026-09-20 신설 — 오너: "일반-에디터 페이지 신설해서, 날짜 자동등록, 지역 제한,
    // 드롭 정책 등 관련 내용을 모으는 게 좋아 보임"). 일반 바로 뒤 — 흩어져 있던 에디터 동작
    // 설정 다섯 개(날짜 자동등록·지역 제안 엄격도·원본 처리·전체 너비·맞춤법 검사)를 모은
    // 이사 웨이브다. id 는 "editor" — 신설이라 딥링크 호환 제약이 없다.
    {
      id: "editor",
      scope: "notebook",
      label: t("settings.page_editor"),
      group: "general",
      icon: <IconEdit size={12} strokeWidth={2} />,
      render: () => <EditorSection />,
    },

    // 첨부파일 (PLAN-2026-10-27 신설) — 붙여넣기·드롭 정책(에디터에서) + 첨부 저장 방식(데이터 관리에서).
    {
      id: "attachments",
      scope: "notebook",
      label: t("settings.page_attachments"),
      group: "general",
      icon: <IconPaperclip size={12} strokeWidth={2} />,
      surfaces: [AttachmentsSection],
      render: () => <AttachmentsSection />,
    },

    // 달력 및 일정 (id 는 `notifications` 그대로 — 딥링크 호환; 이력은 NotificationsSection 머리 주석).
    // 달력 카드(주 시작일·기본 공휴일) + 공휴일·기념일 표 + 반복 일정 표. 알림 카드는 일반 페이지로 이사했다.
    // 반복 일정 표의 브라우저 분기는 섹션 안에서 한다.
    {
      id: "notifications",
      scope: "notebook",
      label: t("settings.page_notifications"),
      group: "general",
      icon: <IconBell size={12} strokeWidth={2} />,
      surfaces: [NotificationsSection],
      render: () => <NotificationsSection />,
    },

    {
      id: "appearance",
      scope: "notebook",
      label: t("settings.appearance"),
      group: "general",
      icon: <IconPalette size={12} strokeWidth={2} />,
      render: () => <AppearanceSection />,
    },

    // id 는 "view" 그대로(딥링크) — 라벨만 "개인설정" → "지역"(D10) → "지역 및 날씨"(2026-09-15
    // 2차 R1). UI 언어는 일반에 남는다.
    {
      id: "view",
      scope: "notebook",
      label: t("settings.page_view"),
      group: "general",
      icon: <IconMapPin size={12} strokeWidth={2} />,
      // 시간축 배경 루틴 표는 R5 로 "알림" 페이지로 갔다 — 여기는 지역·날씨·달력이다.
      surfaces: [ViewSection],
      render: () => <ViewSection />,
    },

    // 태그 관리는 제거, 사이드바 구성은 "지역"으로 이사 간 상태 그대로다.
    {
      id: "dashboard",
      scope: "notebook",
      label: t("settings.page_dashboard"),
      group: "general",
      icon: <IconLayoutGrid size={12} strokeWidth={2} />,
      // 탭 순서·활성 칩 줄, 켜진 탭별 하위 설정 카드, 미리보기는 DashboardTabsSection 이 소유한다.
      // 문구 팩 카드(PhrasePacksSection)는 문구와 함께 브리핑 페이지로 이사했다(GRILL-2026-10-19 R4 ·
      // PLAN-2026-10-19-briefing-rewrite §8) — BriefingSection 이 마운트한다.
      surfaces: [DashboardTabsSection],
      render: () => <DashboardTabsSection />,
    },

    // ── 기능 ────────────────────────────────────────────────────────────────
    // 수집 — 크론잡(정기 수집 소스) 전용 페이지.
    // PLAN-2026-09-04-local-import §3b: 첫 부팅 자동 감지 뱃지. CollectSection을 한 번 열면
    // 0으로 돌아가 사라진다.
    {
      id: "collect",
      scope: "app",
      label: t("settings.page_collect"),
      group: "feature",
      badge: collectDetectPending,
      icon: <IconFileImport size={12} strokeWidth={2} />,
      surfaces: [CollectSection],
      render: () => <CollectSection />,
    },

    // 연결 — 동기화 서버·모바일 연결. 수집 제외 도메인은 수집 페이지(CollectSection)가 싣는다.
    {
      id: "connect",
      scope: "app",
      label: t("settings.page_connect"),
      group: "feature",
      icon: <IconLink size={12} strokeWidth={2} />,
      surfaces: [SyncSection],
      render: () => <SyncSection />,
    },

    // ── AI ──────────────────────────────────────────────────────────────────
    // 연결 (docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W1 — "연결"과 "사용" 분리.
    // id 는 딥링크 호환을 위해 기존 "ai" 를 유지하고 라벨만 "AI 연결" → "연결"로 줄인다:
    // 그룹 헤더가 이미 "AI" 라고 말하고 있다.)
    {
      id: "ai",
      scope: "notebook",
      label: t("settings.page_ai"),
      group: "ai",
      icon: <IconSparkles size={12} strokeWidth={2} />,
      // 프로바이더·키·모델 상태와 저장은 AiProviderSection 이 스스로 갖는다(useAiConnectionSettings).
      surfaces: [AiProviderSection],
      render: () => <AiProviderSection />,
    },

    // 권한 (PLAN-2026-09-12 §1, D8). 권한 6종이 "기능" 페이지 맨 위에서 카탈로그와 경쟁하던 것을
    // 자기 페이지로 뗐다. 행 내용은 AiPermissionsSection 소유.
    {
      id: "ai_permissions",
      scope: "notebook",
      label: t("settings.page_ai_permissions"),
      group: "ai",
      icon: <IconShield size={12} strokeWidth={2} />,
      surfaces: [AiPermissionsSection],
      render: () => <AiPermissionsSection onNavigate={handleSelectPage} />,
    },

    // 기능. AiCapabilityCatalog(W2) 는 ai_enabled 와 무관하게 항상 렌더된다 — 꺼져 있어도
    // "이런 게 있구나"를 알아야 한다(PLAN-2026-08-30 §2-4). 켜져 있으면 아래에 "노트북 재편 (AI)" 카드(AiActionsCard)가 붙고,
    // 맨 아래에 AI 프리셋(커스텀 프롬프트) 편집면이 온다 — AI 프리셋은 별도 페이지가 아니다.
    {
      id: "ai_features",
      scope: "notebook",
      label: t("settings.page_ai_features"),
      group: "ai",
      icon: <IconWrench size={12} strokeWidth={2} />,
      surfaces: [AiCapabilityCatalog, AiActionsCard, AiPresetsSection],
      render: () => (
        <>
          <AiCapabilityCatalog onNavigate={handleSelectPage} />
          {aiEnabled && <AiActionsCard />}
          {/* AI 프리셋(커스텀 프롬프트)은 별도 페이지가 아니라 기능 페이지 맨 아래(2026-10-28, 오너). */}
          <AiPresetsSection />
        </>
      ),
    },

    // 채팅 (PLAN-2026-09-01 §1 신설 — 사용자 이름 · 기억 · 자동 추출 스위치)
    {
      id: "ai_chat",
      scope: "notebook",
      label: t("settings.page_ai_chat"),
      group: "ai",
      icon: <IconChat size={12} strokeWidth={2} />,
      surfaces: [AiChatSection],
      render: () => <AiChatSection onNavigate={handleSelectPage} />,
    },

    // ── 시스템 ──────────────────────────────────────────────────────────────
    {
      id: "data",
      scope: "notebook",
      label: t("settings.data_management"),
      group: "system",
      icon: <IconArchive size={12} strokeWidth={2} />,
      // 저장 공간 게이지·저장 및 백업·데이터 이동·위험 작업(개발 빌드면 테스트 DB)까지 DataManagementSection 이 페이지째 그린다.
      // 첨부 저장 방식은 "첨부파일" 페이지(AttachmentsSection)로 이사했다.
      surfaces: [DataManagementSection],
      render: () => <DataManagementSection onClose={onClose} />,
    },

    {
      id: "license",
      scope: "app",
      label: t("settings.page_license"),
      group: "system",
      icon: <IconScale size={12} strokeWidth={2} />,
      surfaces: [LicenseSection],
      render: () => <LicenseSection />,
    },

    // ── 플러그인 (PLAN-2026-08-27-space-plugin-rebuild §2) ───────────────────
    // 동봉 플러그인은 기능 페이지 뒤 그룹으로 산다. id 는 "pet" 그대로 — 설정 키와
    // 딥링크 호환. 섹션 컴포넌트는 설정 창 소유라 components/settings/ 에 남는다.
    {
      id: "pet",
      scope: "app",
      label: t("settings.pet"),
      group: "plugins",
      icon: <IconSmile size={12} strokeWidth={2} />,
      surfaces: [PetSection],
      render: () => <PetSection />,
    },

    // 브리핑(PLAN-2026-09-30-briefing W4) — 펫 바로 아래. 브라우저 모드 목록엔 넣지 않는다(창·습관 커맨드가 데스크톱 전용).
    {
      id: "briefing",
      scope: "notebook",
      label: t("settings.page_briefing"),
      group: "plugins",
      icon: <IconNewspaper size={12} strokeWidth={2} />,
      surfaces: [BriefingSection],
      render: () => <BriefingSection />,
    },
  ];

  // 목록 자체를 거르므로, "page" state 가 걸러진 id 를 가리키는 경우(기본값이든 딥링크든) 아래
  // find/fallback 이 자동으로 첫 남은 페이지로 떨어진다 — 별도 리다이렉트 로직이 필요 없다.
  const pages = browser ? allPages.filter((p) => BROWSER_SETTINGS_PAGES.includes(p.id)) : allPages;

  const activePage = pages.find((p) => p.id === page) ?? pages[0];
  // 검색이 도는 페이지 — 위 pages(브라우저 모드 필터 적용)의 id·라벨.
  const searchPages = pages.map((p) => ({ id: p.id, label: p.label }));

  return (
    <div
      data-testid="settings-panel"
      // 창 전체가 **하나의 그리드**다(2026-10-27): 열 = [레일 | 본문], 행 = [맨 위 한 줄 | 나머지]. 노트북 칸·검색 줄·내비·본문이
      // 같은 트랙을 공유해, 창 폭이 바뀌어도 검색 카드·본문 열·사이드바가 함께 움직인다(settingsLayout.css 의 .settings-column).
      style={{
        display: "grid",
        gridTemplateColumns: "var(--settings-rail-w) minmax(0, 1fr)",
        gridTemplateRows: "var(--row-chrome) minmax(0, 1fr)",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        ...({ "--settings-sb-w": `${sbW}px` } as CSSProperties),
      }}
    >
      {/* 맨 위 한 줄이 레일·본문 위를 가로지른다(PLAN-2026-10-24 D1) — 창 타이틀 스트립이 없는 이 창(D10 ①)의
          드래그 손잡이·닫기 X 가 여기 산다. 스크롤 컨테이너 밖이라 본문을 내려도 따라 올라가지 않는다. */}
      <SettingsHeader
        scope={activePage?.scope ?? "notebook"}
        busy={!!busy}
        onClose={onClose}
        pages={searchPages}
        aiEnabled={aiEnabled}
        browser={browser}
        onPick={handleSelectPage}
      />
      <SettingsNav items={pages} activeId={activePage?.id ?? "appearance"} onSelect={handleSelectPage} />
      {/* 레일 오른쪽 칸은 메인 창의 본문 칸과 같은 관계다(GRILL-2026-10-19 R1-D): 헤더 아래에서 틴트·프레임을
          다 가진 .content-canvas(상·좌 외곽선, 좌상단 라운드, 8px 인셋 — tokens.css 클래스 그대로).
          PLAN-2026-09-15 D10 ③ "프레임을 지워 2단 분리" 는 이 결정으로 대체됐다 — 경계는 레일의
          칠·선이 아니라 본문 캔버스의 외곽선이 만든다(메인 사이드바와 같다). 되돌리지 말 것. */}
      <div style={{ gridColumn: 2, gridRow: 2, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* 본문은 메인 창 본문과 같은 틴트·표면 파생(.content-canvas, tokens.css)을 쓴다 — 오너 2차 QA
            "설정 본문 틴트는 본문과 동기화". overflow 만 인라인으로 덮는다(클래스는 hidden — 여기는
            스크롤 컨테이너다). 스크롤바 자리는 늘 비워 둔다 — 길고 짧은 페이지를 오갈 때 본문 폭이
            스크롤바만큼 튀지 않게. */}
        <div
          ref={contentRef}
          data-testid="settings-content"
          className="scroll content-canvas"
          style={{ flex: 1, minHeight: 0, overflow: "auto", scrollbarGutter: "stable" }}
        >
          {/* 오너 QA 2026-09-15 R3: 페이지 블록(히어로·카드·통계 띠·표) 사이 간격은 **여기 한 곳**의
              flex gap 이 맡는다 — 카드는 자기 margin 을 갖지 않는다. 그래서 각 섹션은 블록을
              프래그먼트의 직계 자식으로 내놓아야 한다(바깥 div 로 감싸면 gap 이 안 먹는다). */}
          <div
            data-testid="settings-page-body"
            className="settings-column"
            style={{
              // 위쪽도 좌우와 같은 인셋. 열의 폭·좌우 안쪽 여백은 .settings-column 이 쥔다(위 검색 줄과 공유).
              paddingTop: "var(--space-8)",
              paddingBottom: "var(--space-8)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-7)",
            }}
          >
            <SettingsAnchorContext.Provider value={anchor}>
              <Suspense fallback={null}>
                {activePage?.render()}
              </Suspense>
            </SettingsAnchorContext.Provider>
          </div>
        </div>
      </div>
      {/* PLAN-2026-08-30 §4 W7 — 단일 마운트 지점. 트리거 지점(위 페이지들)이 여럿이어도 모달은
          여기 하나뿐이다(useFeatureBriefStore 로 연결) — activeId 가 없으면 스스로 null을 그린다. */}
      <FeatureBriefModal />
    </div>
  );
}
