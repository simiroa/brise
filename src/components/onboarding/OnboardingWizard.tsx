import { useState } from "react";
import { ModalShell } from "../ModalShell";
import { useSettingsStore } from "../../stores/settings";
import { useWorkspacesStore } from "../../stores/workspaces";
import { useOnboardingSession } from "../../stores/onboardingSession";
import { OnboardingImportStep } from "./OnboardingImportStep";
import { OnboardingDataStep, useDataLocation } from "./OnboardingDataStep";
import { OnboardingRegionStep, type RegionSelection } from "./OnboardingRegionStep";
import { OnboardingAiStep } from "./OnboardingAiStep";
import { OnboardingConnectStep, ConnectQr } from "./OnboardingConnectStep";
import { DataArt, RegionArt, AiArt, ConnectArt, ImportArt } from "./OnboardingArt";
import { OnboardingFirstScreen } from "./OnboardingFirstScreen";
import { OnboardingThemePage } from "./OnboardingThemePage";
import { OnboardingDoneScreen } from "./OnboardingDoneScreen";
import { OnboardingFooter } from "./OnboardingFooter";
import { commitNotebookName, completeAfterImport, finishOnboarding, resolveNotebookName } from "./onboardingFlow";
import "./onboarding.css";
import { t } from "../../i18n/t";

// 테마 → 데이터 관리 → 지역 → AI → 기기 연결 (PLAN-2026-09-28-onboarding-rebuild.md §6).
const SETUP_PAGE_COUNT = 5;
// 오너 2026-09-29: 창 전체 페이지(안 C)는 빈 공간이 너무 많았다 — 큰 모달로 되돌린다.
const WIZARD_WIDTH = 960;
// 높이 고정(오너 2026-09-29) — 쪽마다 창이 출렁이지 않게. 각 쪽 내용은 이 안에서 스크롤 없이 들어가게 짠다.
// 560 = 목업 정렬(2026-09-29) 뒤 실측: 가장 큰 쪽은 기기 연결(QR 카드) 본문 약 380, 요약 약 337, AI 약 300
// (1.25배 캡처 기준 CSS px). 본문 = 560 − 머리 65 − 꼬리 64 − 패딩 36 − 테두리 ≈ 424 라 스크롤 없이 든다.
// 첫 구현 추정치 600 은 위아래가 과하게 남았다. 더 작은 쪽은 본문 안에서 세로 가운데
// (onboarding.css .ob-setup-row / .ob-first / .ob-done) — 위쪽만 무거워 보이지 않게.
const WIZARD_HEIGHT = 560;

/**
 * 첫 실행 온보딩 — 큰 모달(PLAN-2026-09-28). App.tsx 가 표시 여부를 정한다
 * (useOnboardingSession.dismissed + onboardingCompleted). 이동 상태는 스토어에 있다 — 언어를 바꾸면
 * `.app`(key={uiLang}) 이 리마운트되어 컴포넌트 state 가 날아가기 때문(stores/onboardingSession.ts).
 *
 * 여기는 셸/조율만 맡는다: 화면 전환 · 머리 진행 표시 · 쪽 사이에 걸친 상태(지역·AI·기기 연결).
 * 각 화면은 Onboarding*Screen/Page, 꼬리는 OnboardingFooter, 저장 순서는 onboardingFlow.ts.
 */
export function OnboardingWizard() {
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  // 값은 안 쓰지만 구독은 유지한다 — 언어가 바뀌면 이 컴포넌트가 다시 그려져야 아래 t() 호출들(쪽 이름·이름 제안)이 갱신된다.
  useSettingsStore((s) => s.uiLang);
  const notebookNameLive = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? ""); // = 노트북

  const {
    dismissed,
    screen,
    setupPage,
    notebookDraft,
    nameIdeaIdx,
    nameShuffled,
    pendingDataPath,
    dismiss,
    setScreen,
    setSetupPage,
    setNotebookDraft,
    shuffleNameIdea,
    setPendingDataPath,
  } = useOnboardingSession();
  const { current: currentDataLocation } = useDataLocation();

  const [regionSelection, setRegionSelection] = useState<RegionSelection | null>(null);
  // 요약에 보이는 지역은 "확정해서 저장한" 것뿐 — 고르기만 하고 건너뛰면 저장되지 않았으므로 "설정 안 함".
  const [confirmedRegion, setConfirmedRegion] = useState<RegionSelection | null>(null);
  const [aiAdopted, setAiAdopted] = useState<{ provider: string; model: string | null } | null>(null);
  // AI 쪽(4/5) 연결 테스트가 성공한 동안만 채워진다 — 비어 있지 않으면 셸의 주 버튼이
  // "이 연결로 켜고 다음"으로 바뀌어 이 함수를 부른다(오너 2026-09-29, OnboardingAiStep.tsx 참고).
  const [aiAdopt, setAiAdopt] = useState<(() => Promise<boolean>) | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [connectStatus, setConnectStatus] = useState<{ enabled: boolean; qrSvg: string | null }>({
    enabled: false,
    qrSvg: null,
  });
  const [starting, setStarting] = useState(false);

  if (onboardingCompleted || dismissed) return null;

  const { notebookName, hasOwnName } = resolveNotebookName({
    ideas: t("onboarding.notebook_name_ideas").split("|").filter(Boolean),
    ideaIdx: nameIdeaIdx,
    live: notebookNameLive,
    draft: notebookDraft,
    shuffled: nameShuffled,
  });

  const goFrom = async (next: () => void) => {
    if (await commitNotebookName(notebookName)) next();
  };

  // 바로 시작하기 / 요약 화면의 마지막 — 저장 순서(새 노트 초안 · 저장 위치 이동 D4)는 onboardingFlow.finishOnboarding.
  // 여기는 중복 클릭 방지(starting)만 맡는다.
  const finishWithNewNote = async () => {
    if (starting) return;
    setStarting(true);
    const result = await finishOnboarding({ pendingDataPath, clearPendingDataPath: () => setPendingDataPath(null) });
    if (result === "restarting") return; // 재시작이 이 창을 대신할 것 — 더 이상 로컬 state 를 바꾸지 않는다.
    setStarting(false);
  };

  // AI 쪽(4/5) 셸 주 버튼 — 채택 함수가 준비돼 있으면 그걸 먼저 부르고, 켜졌을 때만 다음 쪽으로.
  const handleAiFooterNext = async () => {
    if (!aiAdopt) {
      setSetupPage(5);
      return;
    }
    setAdopting(true);
    try {
      if (await aiAdopt()) setSetupPage(5);
    } finally {
      setAdopting(false);
    }
  };

  // 지역은 이제 3/5(테마 → 데이터 → 지역 → AI → 기기 연결) — 확정하면 4/5(AI)로 간다.
  // 위치 저장이 실패하면(스토어가 되돌리고 call() 이 토스트를 띄웠다) 이 쪽에 머문다.
  const commitRegionAndNext = async () => {
    if (!regionSelection) return;
    const s = useSettingsStore.getState();
    const saved = await s.setDefaultMapLocation({ ...s.defaultMapLocation, lat: regionSelection.lat, lng: regionSelection.lng });
    if (!saved) return;
    if (!s.regionEnabled) await s.setRegionEnabled(true);
    setConfirmedRegion(regionSelection);
    setSetupPage(4);
  };

  // 4쪽부터는 "다음"/"건너뛰기" 모두 요약 화면으로 간다 — 마무리(newNote)는 요약 화면의 주 행동뿐.
  const skipPage = () => {
    if (setupPage < SETUP_PAGE_COUNT) setSetupPage(setupPage + 1);
    else setScreen("done");
  };

  const pageNames = [
    t("onboarding.setup_page_space"),
    t("onboarding.setup_page_data"),
    t("onboarding.setup_page_region"),
    t("onboarding.setup_page_ai"),
    t("onboarding.setup_page_connect"),
  ];

  const titleText = screen === "setup" || screen === "done" ? t("onboarding.setup_title") : t("onboarding.title");
  const progress =
    screen === "setup" ? (
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flex: "none" }}>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 400, color: "var(--muted)", whiteSpace: "nowrap" }}>
          {t("onboarding.setup_step_label", { n: setupPage, name: pageNames[setupPage - 1] })}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {Array.from({ length: SETUP_PAGE_COUNT }).map((_, i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: i + 1 === setupPage ? "var(--accent)" : "var(--divider)",
              }}
            />
          ))}
        </div>
      </div>
    ) : null;
  const title = progress ? (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: "var(--space-4)" }}>
      <span>{titleText}</span>
      {progress}
    </div>
  ) : (
    titleText
  );

  const footer =
    screen === "first" ? undefined : (
      <OnboardingFooter
        screen={screen}
        setupPage={setupPage}
        starting={starting}
        adopting={adopting}
        regionSelected={!!regionSelection}
        aiAdoptReady={!!aiAdopt}
        onScreen={setScreen}
        onSetupPage={setSetupPage}
        onSkip={skipPage}
        onRegionConfirm={() => void commitRegionAndNext()}
        onAiNext={() => void handleAiFooterNext()}
        onFinish={() => void finishWithNewNote()}
      />
    );

  return (
    <ModalShell
      title={title}
      ariaLabel={titleText}
      onClose={dismiss}
      width={WIZARD_WIDTH}
      height={WIZARD_HEIGHT}
      footer={footer}
      dismissible={false}
    >
      <>
          {screen === "first" && (
            <OnboardingFirstScreen
              notebookName={notebookName}
              notebookNameLive={notebookNameLive}
              hasOwnName={hasOwnName}
              starting={starting}
              onNameChange={setNotebookDraft}
              onShuffleName={shuffleNameIdea}
              onKeepName={() => setNotebookDraft(notebookNameLive)}
              onStartBlank={() => void goFrom(() => void finishWithNewNote())}
              onImport={() => void goFrom(() => setScreen("import"))}
              onSetup={() =>
                void goFrom(() => {
                  setSetupPage(1);
                  setScreen("setup");
                })
              }
            />
          )}

          {screen === "import" && (
            // 가져오기도 설정 쪽과 같은 2단(왼쪽 그림 / 오른쪽 끌어다 놓기·파일 선택) — 모달 크기가 고정된다.
            // 파일 선택을 취소해도 이 화면에 남는다(끌어다 놓기로 다시 시도할 수 있게). 첫 화면은 하단 "처음으로".
            <div className="ob-setup-row">
              <div className="ob-setup-art ob-import-left">
                <div>
                  <h2 className="ob-title ob-title--hero">{t("onboarding.import_heading")}</h2>
                  <p className="ob-sub">{t("onboarding.import_desc")}</p>
                </div>
                <ImportArt />
              </div>
              <div className="ob-setup-fields">
                <OnboardingImportStep onImported={() => void completeAfterImport()} onCancel={() => {}} />
              </div>
            </div>
          )}

          {screen === "setup" && (
            <>
              {/* 입력 쪽은 전부 마운트된 채 hidden 으로 가려 초안을 지킨다. 그림은 보이는 쪽만 마운트 —
                  숨은 채 재생이 끝나버리지 않고, 쪽에 들어올 때마다 장면이 처음부터 돈다. */}
              <OnboardingThemePage active={setupPage === 1} />

              <div className="ob-setup-row" hidden={setupPage !== 2}>
                <div className="ob-setup-art">{setupPage === 2 && <DataArt />}</div>
                <div className="ob-setup-fields">
                  <OnboardingDataStep />
                </div>
              </div>

              <div className="ob-setup-row" hidden={setupPage !== 3}>
                <div className="ob-setup-art">{setupPage === 3 && <RegionArt />}</div>
                <div className="ob-setup-fields">
                  <OnboardingRegionStep onSelectionChange={setRegionSelection} />
                </div>
              </div>

              <div className="ob-setup-row" hidden={setupPage !== 4}>
                {/* AI 그림은 자체 카드(테두리·빔)가 이미 둥근 패널이다 — 한 겹 더 두르지 않는다. */}
                <div className="ob-setup-art">{setupPage === 4 && <AiArt />}</div>
                <div className="ob-setup-fields">
                  {/* setAiAdopt(fn) 로 바로 넘기면 안 된다 — useState 세터에 함수를 넘기면 React 가
                      "updater 함수"로 해석해 fn(prevState) 를 불러 그 반환값을 저장한다(값이 아니라
                      함수를 들고 있어야 하는 경우의 고전적 함정). () => fn 으로 감싸 fn 자체를 저장한다. */}
                  <OnboardingAiStep onAdopted={setAiAdopted} onAdoptReady={(fn) => setAiAdopt(() => fn)} />
                </div>
              </div>

              <div className="ob-setup-row" hidden={setupPage !== 5}>
                <div className="ob-setup-art">
                  <div className="ob-panel">
                    {setupPage === 5 && (connectStatus.qrSvg ? <ConnectQr svg={connectStatus.qrSvg} /> : <ConnectArt />)}
                  </div>
                </div>
                <div className="ob-setup-fields">
                  <OnboardingConnectStep onStatusChange={setConnectStatus} />
                </div>
              </div>
            </>
          )}

          {screen === "done" && (
            <OnboardingDoneScreen
              confirmedRegion={confirmedRegion}
              aiAdopted={aiAdopted}
              connectEnabled={connectStatus.enabled}
              pendingDataPath={pendingDataPath}
              currentDataRoot={currentDataLocation?.root}
            />
          )}
      </>
    </ModalShell>
  );
}
