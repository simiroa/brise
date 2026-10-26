import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { IconAi, IconImage, IconMic, IconPaperclip, IconPlus } from "../components/icons";
import { t } from "../i18n/t";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../stores/ai";
import { keepEditorFocus } from "./keepEditorFocus";
import { useBackClosable } from "./useBackClosable";

/** 다이얼이 부르는 동작 넷 — 부모(MobileNote)가 쥔 녹음기·첨부 시트·갤러리 입력·AI 시트에 그대로 이어진다. */
export interface SpeedDialHandlers {
  /** 녹음기 시트(예전 마이크 버튼과 같은 동작). */
  onOpenVoice: () => void;
  /** 갤러리 선택기를 바로 띄운다 — **호출 즉시 동기로** input.click() 까지 가야 한다(아래 `choose`). */
  onPickPhoto: () => void;
  /** 첨부 시트(촬영·갤러리·음성·파일 네 줄) — 시트의 줄이 하나도 고아가 되지 않게 "파일 첨부"가 이 시트를 연다. */
  onOpenAttach: () => void;
  /** AI 시트(MobileAiSheet) — 예전 독 오른쪽 ✨ 버튼과 같은 동작(오너 2026-10-10: ✨ 를 다이얼 항목으로 옮겼다). */
  onOpenAi: () => void;
  /** AI 가 켜져 있고 닿는가. 아니어도 항목은 남고(눌러서 시트의 안내를 볼 수 있다) 흐리게만 그린다 — 예전 ✨ 의 data-muted 와 같다. */
  aiReady: boolean;
}

export type SpeedDialPlacement = "float" | "dock";

/**
 * 다이얼 항목 하나 — 입력 화면 밖(노트 탭 ＋, MobileTreeFab)이 자기 항목을 줄 때 쓴다. 입력 화면의 네 항목(ACTIONS)도 같은 모양으로
 * 바뀌어 그려진다. `muted` = 눌리긴 하지만 흐리게(AI 꺼짐·닿지 않음 — 예전 ✨ 의 data-muted), `title` = 흐린 이유.
 */
export interface SpeedDialItem {
  /** 안정적인 이름 — data-action. */
  id: string;
  testId: string;
  label: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  onSelect: () => void;
  muted?: boolean;
  title?: string;
}

interface BaseProps {
  /**
   * float = 본문 오른쪽 아래에 떠 있는 56px ＋ (텍스트 섹션), dock = 하단 독 도구 슬롯 안의 48px ＋ (관계도·시트 — 거기선
   * 본문 아래쪽에 컨트롤이 있어 떠 있는 버튼이 가린다). 열리는 방향은 둘 다 위쪽이다. 모양·위치는 CSS(note-capture.css) 몫이다.
   */
  placement: SpeedDialPlacement;
  /** ＋ 와 항목 묶음의 접근 가능한 이름. 생략하면 입력 화면의 "빠른 입력"(mobile.fab_group). */
  label?: string;
}

/** 입력 화면(MobileNote): 네 동작을 핸들러로 받는다. 다른 화면: 자기 항목 목록(`items`)을 준다 — 둘 중 하나. */
type Props = BaseProps & ((SpeedDialHandlers & { items?: undefined }) | { items: readonly SpeedDialItem[] });

interface DialAction {
  /** 안정적인 이름 — 테스트 id 와 data-action. */
  id: "record" | "photo" | "attach" | "ai";
  testId: string;
  label: () => string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  run: (h: SpeedDialHandlers) => void;
}

/**
 * ＋ 에서 가까운 것부터(= 아래에서 위로) 녹음 · 사진 · 파일 첨부 · AI. 첫 줄이 엄지에 가장 가깝다 — 예전 FAB 에서 주인공이던 마이크.
 * AI 는 예전 독 오른쪽의 ✨ 버튼이 옮겨 온 것(오너 2026-10-10) — 기존 세 항목의 자리를 흔들지 않으려고 맨 위(가장 먼 자리)에 붙였다.
 * `testId` 는 예전 FAB 의 id 를 이어 쓴다(mic/attach) — 녹음기·첨부 시트가 같은 곳을 여는 것을 가리키는 계약이라서.
 * 접근 가능한 이름 = 보이는 글자(label-in-name). 녹음만 예전 마이크의 이름표(mobileInput.voice_mic)를 그대로 쓴다 — 낭독기 계약.
 */
const ACTIONS: readonly DialAction[] = [
  { id: "record", testId: "mobile-fab-mic", label: () => t("mobileInput.voice_mic"), Icon: IconMic, run: (h) => h.onOpenVoice() },
  { id: "photo", testId: "mobile-fab-photo", label: () => t("mobile.dial_photo"), Icon: IconImage, run: (h) => h.onPickPhoto() },
  { id: "attach", testId: "mobile-fab-attach", label: () => t("mobile.dial_file"), Icon: IconPaperclip, run: (h) => h.onOpenAttach() },
  { id: "ai", testId: "mobile-fab-ai", label: () => t("editor.ai_menu_title"), Icon: IconAi, run: (h) => h.onOpenAi() },
];

/**
 * 스피드 다이얼 — ＋ 한 개를 누르면 녹음 · 사진 · 파일 첨부 · AI 가 위로 스프링처럼 튀어나온다(오너 2026-10-07).
 * 예전의 마이크+＋ 두 버튼 스택을 대체한다. 동작은 그대로다: 녹음 = 앱 안 녹음기, 사진 = 갤러리 선택기, 파일 첨부 = 첨부 시트.
 *
 * 열림 상태·뒤로가기 레이어는 **이 컴포넌트 안에** 둔다 — MobileNote 에는 새 훅이 없다(EditorPanel 식 조기 반환 위 훅 순서 함정,
 * 그리고 섹션을 바꾸면 인스턴스가 사라지므로 다이얼이 저절로 닫힌다).
 *
 *  - 닫힌 상태의 항목은 CSS 가 `visibility:hidden` 으로 닫고(닫힘 전환 끝에 지연) 레이어에 `inert` 를 건다 — 보이지 않는 버튼이
 *    본문 아래쪽·관계도 컨트롤을 덮거나 탭 순서에 끼지 않는다. 열린 동안에만 탭 가로채기(.mobile-speed-dial-catcher)가 마운트된다.
 *  - 탭·낭독 순서는 ＋ → 녹음 → 사진 → 파일 첨부(DOM 순서 — JSX 의 주석). 시각 배치(아래에서 위로)와 같은 "가까운 것부터"다.
 *  - 항목은 늘 마운트돼 있다 — 닫힘 애니메이션(역방향 전환)이 끝까지 가야 하고, 연타로 열고 닫아도 전환이 중간에서 뒤집힌다.
 *  - 안드로이드 뒤로가기는 이 레이어를 먼저 닫는다(useBackClosable). 항목을 눌러 다음 레이어(녹음기·시트)를 여는 건 **같은 커밋의
 *    닫고-열기**라서 훅의 보류 항목 입양이 그 히스토리 항목을 이어받는다 — 그래서 `choose` 는 닫기와 동작 호출을 한 핸들러에서 한다.
 *  - 모든 버튼은 에디터 포커스를 뺏지 않는다(루트 위임 keepEditorFocus) — 타이핑 중에 열어도 키보드가 안 내려간다. 탭 가로채기도
 *    DOM 후손이라 같은 위임에 덮인다(포털로 빼면 `contains` 검사가 깨진다 — 빼지 말 것).
 */
export function MobileSpeedDial(props: Props) {
  const { placement } = props;
  const groupLabel = props.label ?? t("mobile.fab_group");
  const [open, setOpen] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerId = useId();
  const close = useCallback(() => setOpen(false), []);
  useBackClosable(open, close);

  // 하드웨어 키보드 Esc — 닫고, 포커스가 레이어 안에 있었다면 ＋ 로 돌려놓는다(에디터에 있던 포커스는 건드리지 않는다).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inLayer = layerRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inLayer) triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const items: readonly SpeedDialItem[] = props.items !== undefined ? props.items : actionItems(props);
  /**
   * 닫기와 동작 호출을 **한 핸들러에서 동기로** 한다. 사진은 여기서 곧바로 input.click() 까지 가야 한다 — 종료 애니메이션·타이머·
   * await 뒤로 미루면 WebView 가 사용자 제스처가 아니라며 선택기를 거절할 수 있다.
   */
  const choose = (item: SpeedDialItem) => () => {
    setOpen(false);
    item.onSelect();
  };

  return (
    <div
      className="mobile-speed-dial"
      data-testid="mobile-speed-dial"
      data-placement={placement}
      data-open={open}
      onMouseDown={keepEditorFocus}
    >
      {/* DOM 순서 = 탭·낭독 순서: 탭 가로채기(포커스 불가) → ＋ → 레이어(녹음 → 사진 → 파일 첨부 → AI). ＋ 가 레이어보다 먼저여야 열린 뒤
          Tab 이 곧장 가장 가까운 항목(녹음)으로 들어가고 Shift+Tab 이 ＋ 로 돌아온다 — 레이어가 앞이면 Tab 이 다이얼 밖으로 새고
          Shift+Tab 은 가장 먼 항목부터 닿는다(TalkBack 다음-항목 스와이프도 같은 순서). 겹침 순서는 CSS 가 쥔다(note-capture.css:
          가로채기·＋·레이어가 같은 z-index 라 뒤에 오는 것이 위 — 이 순서를 바꾸면 ＋ 위를 가로채기가 덮는다). */}
      {open && <div className="mobile-speed-dial-catcher" data-testid="mobile-speed-dial-catcher" onClick={close} />}
      <button
        ref={triggerRef}
        type="button"
        className="mobile-speed-dial-trigger overlay"
        data-testid="mobile-fab-toggle"
        aria-label={groupLabel}
        aria-expanded={open}
        aria-controls={layerId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mobile-speed-dial-icon" aria-hidden="true">
          <IconPlus size={placement === "float" ? 26 : 24} strokeWidth={2} />
        </span>
      </button>
      <div ref={layerRef} id={layerId} className="mobile-speed-dial-layer" inert={!open}>
        <div className="mobile-speed-dial-actions" role="group" aria-label={groupLabel}>
          {items.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className="mobile-speed-dial-item"
              data-testid={a.testId}
              data-action={a.id}
              aria-label={a.label}
              data-muted={a.muted}
              title={a.title}
              tabIndex={open ? 0 : -1}
              style={{ "--i": i } as CSSProperties}
              onClick={choose(a)}
            >
              <span className="mobile-speed-dial-label" aria-hidden="true">
                {a.label}
              </span>
              <span className="mobile-speed-dial-btn overlay" aria-hidden="true">
                <a.Icon size={22} strokeWidth={2} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 입력 화면의 네 동작(ACTIONS)을 항목 목록으로 — AI 만 aiReady 에 따라 흐려진다(예전 ✨ 의 data-muted). */
function actionItems(h: SpeedDialHandlers): SpeedDialItem[] {
  const avail = selectAiAvailability(useSettingsStore.getState(), useAiStore.getState());
  return ACTIONS.map((a) => ({
    id: a.id,
    testId: a.testId,
    label: a.label(),
    Icon: a.Icon,
    onSelect: () => a.run(h),
    muted: a.id === "ai" ? !h.aiReady : undefined,
    title: a.id === "ai" && !h.aiReady ? getAiDisabledHint(avail, "mobile") : undefined,
  }));
}
