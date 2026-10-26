import { Suspense, useEffect, useRef, useState } from "react";
import { useKeyboardOpen } from "./useKeyboardOpen";
import "../styles/tokens.css";
import "../styles/mobile.css";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useSearchStore } from "../stores/search";
import { reportFallback } from "../lib/diag";
import { flushAll } from "../lib/invoke";
import { MobileHome } from "./MobileHome";
import type { MobileNoteHandle } from "./MobileNote";
import { MobileSearch } from "./MobileSearch";
import { MobileSettings } from "./MobileSettings";
import { MobilePostSave } from "./MobilePostSave";
import { MobileAiResultSheet } from "./MobileAiResultSheet";
import { MobileAmbient } from "./MobileAmbient";
import { MobileOfflineBanner } from "./MobileOfflineBanner";
import { MobileTabBar } from "./MobileTabBar";
import { MobileImportPendingBar, MobileImportStrip } from "./MobileImportStrip";
import { cancelCaptureFocus, requestCaptureFocus } from "./mobileCaptureFocus";
import { useImportLedger } from "./mobileImportLedger";
import { useMobileBoot } from "./useMobileBoot";
import { discardImportUploads, retryImportUploads, useMobileImport } from "./useMobileImport";
import { TAB_ORDER, type HistState, type Screen, type TabScreen } from "./mobileScreens";
import { MobileNote } from "../lazySurfaces";

// 번들 W1-(b)-3: MobileNote 는 Tiptap(ProseMirror 코어, 실측 704KB)을 정적으로 물고 있다 — 피드만
// 보는 부팅에도 그게 딸려 오는 걸 막으려고 지연 로드한다(데스크톱 App.tsx 의 EditorPanel 과 같은
// 패턴, 같은 Suspense fallback={null} 관례). ref(MobileNoteHandle) 는 forwardRef 컴포넌트라 lazy()
// 경계 뒤에서도 정상 연결된다 — leaveCapture/saveAndLeaveNote 가 그 ref 를 동기적으로 쓰므로
// MobileApp.test.tsx 의 flushAndMeasure 관련 케이스가 그 연결의 회귀 테스트를 겸한다.
// ponytail: fallback={null} — 청크가 아직 캐시 안 된 첫 진입에 한 프레임 정도 빈 화면일 수 있다.
// 탭 전환 슬라이드(220ms)가 대개 그 틈을 가린다고 보고 스켈레톤을 새로 만들지 않았다. 실기에서
// 느린 회선 첫 진입이 눈에 띄면 그때 로딩 인디케이터를 얹는다(App.tsx 의 다른 lazy 경계 4곳도
// 전부 같은 fallback={null} 이라 새 관례를 만드는 게 아니라 기존 관례를 따른 것).


// History entry shape (HistState, mobileScreens.ts): `idx` = how many entries sit above the home root
// (home = 0).
// Stack invariant (V2, standard Android bottom-nav): home is the single root entry; a non-home tab
// sits at idx 1 and tab<->tab moves REPLACE that entry instead of stacking; tab->home pops back to
// the root (history.go(-idx)). note/search/postsave push on top of whatever opened them.
// Layer entries (`{mobileModal:true}`, useBackClosable.ts) are transparent: they carry no `screen`
// and onPopState ignores pops that land on them. Most layers cover the tab bar, so they are gone
// before any navigation — but selection mode on 노트 is a layer that leaves the tab bar usable.
// writeEntry therefore lets a push CONSUME a layer entry on top (replace it): the layer unmounts with
// the screen it belongs to, and leaving its marker under the new screen would make the next
// back/go(-idx) land on a dead marker instead of a screen.

// "Long" note threshold for the post-save AI interstitial (owner brief: >= ~200 plain-text chars
// skip straight back to the destination tab instead; MobilePostSave never mounts for a short note).
const CAPTURE_LONG_CHARS = 200;

/**
 * Screen state machine (3 tabs — home/capture/settings — plus 3 pushed screens — note/search/
 * postsave) + browser-history integration so the phone's back gesture works. tokens.css is
 * imported here rather than relying on App.tsx's import of it: there's no guarantee MobileApp
 * mounts underneath App.tsx, so this component must be able to paint on its own.
 *
 * The slide direction between tabs is derived from TAB_ORDER (mobileScreens.ts): higher index =
 * forward, lower = back.
 */
export function MobileApp() {
  // t()는 스토어를 구독하지 않는 일반 함수라, load()가 uiLang을 채우기 전(기본 en)에 그려진
  // 탭 라벨이 영어로 고정된다 — 반응형 구독으로 로드/변경 시 셸 전체가 다시 그려지게 한다.
  useSettingsStore((s) => s.uiLang);
  const [screen, setScreen] = useState<Screen>("home");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  // Outgoing-screen "ghost" for the two-layer slide (tab-to-tab only — see navigate()). Never set
  // to "capture"/"note": both host a live MobileNote/Tiptap instance, and mounting a second one
  // just to animate it out would run a second editor (and its note-load/flush effects) against the
  // same activeNote.
  const [prevScreen, setPrevScreen] = useState<Screen | null>(null);
  const prevScreenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef<MobileNoteHandle>(null);
  // The popstate listener is registered once, so it can't read `screen` — this ref is how it does.
  const screenRef = useRef<Screen>("home");
  screenRef.current = screen;

  // 입력 화면에 열려 있던 노트가 사라졌다(가져온 초안을 손대지 않고 버린 직후 등) — MobileNote 는 activeNote 가 없으면
  // 그리지 않으므로 그대로 두면 빈 화면이다. 2026-10-07 S22: 버린 뒤 뒤로 pop 이 같은 "capture" 항목에 떨어지면
  // onPopState 가 "이미 그 화면"이라 아무것도 안 해 빈 입력 화면이 남았다. 어느 경로로 비었든 여기 한 곳에서 새 초안을
  // 연다(탭으로 입력에 들어올 때와 같은 규칙). "열려 있던 것이 사라질 때"만 — 진입 직후 newNote 가 아직 안 끝난 상태는
  // 진입 경로 자신이 연다.
  const captureActiveNoteNull = useNotesStore((s) => s.activeNote === null);
  const captureHadNoteRef = useRef(false);
  useEffect(() => {
    if (screen !== "capture") {
      captureHadNoteRef.current = false;
      return;
    }
    if (!captureActiveNoteNull) {
      captureHadNoteRef.current = true;
      return;
    }
    if (!captureHadNoteRef.current) return;
    // 한 박자 기다린다 — 버리고 나가는 길(leaveCapture → goBack/navigate)이면 그 사이 화면이 바뀌어 이 타이머가
    // 정리되고 아무것도 안 연다. 화면이 입력에 그대로 남았을 때만(빈 화면이 될 경우만) 새 초안을 연다.
    const timer = setTimeout(() => {
      if (screenRef.current !== "capture" || useNotesStore.getState().activeNote) return;
      captureHadNoteRef.current = false;
      void useNotesStore
        .getState()
        .newNote()
        .catch((e) => reportFallback("mobile-capture", "reopen_draft_failed", e instanceof Error ? e.message.slice(0, 60) : "error"));
    }, 400);
    return () => clearTimeout(timer);
  }, [screen, captureActiveNoteNull]);
  // idx of the history entry we are on (see HistState). Ref: onPopState is registered once.
  const depthRef = useRef(0);
  // 하드웨어 뒤로가 저장 실패 관문(V5)에 막힌 뒤 사용자가 [그래도 나가기]를 골라 다시 쏜 history.back() 표시 — 그 pop 은 force 다.
  const leaveAnywayRef = useRef(false);
  const writeEntry = (mode: "push" | "replace", s: Screen, idx: number) => {
    const st: HistState = { screen: s, idx };
    const layerOnTop = !!(history.state as { mobileModal?: boolean } | null)?.mobileModal;
    if (mode === "push" && !layerOnTop) history.pushState(st, "");
    else history.replaceState(st, "");
    depthRef.current = idx;
  };
  // Two-layer slide ghost (tab<->tab only, never leaving "capture" — see prevScreen comment).
  const startGhost = (from: Screen, to: Screen) => {
    const reducedMotion =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!TAB_ORDER.includes(from as TabScreen) || !TAB_ORDER.includes(to as TabScreen)) return;
    if (from === "capture" || reducedMotion) return;
    setPrevScreen(from);
    if (prevScreenTimer.current) clearTimeout(prevScreenTimer.current);
    prevScreenTimer.current = setTimeout(() => setPrevScreen(null), 220);
  };

  // V1: the search query is a global store value that home reads as an active filter. Clear it when
  // the search flow (search + notes opened from its results) is left for anything else — one choke
  // point for hardware back, header back, tab taps. search -> note keeps it (back returns to the
  // results); 취소 clears it itself too (harmless duplicate).
  const inSearchFlow = useRef(false);
  useEffect(() => {
    if (screen === "search") inSearchFlow.current = true;
    else if (screen !== "note" && inSearchFlow.current) {
      inSearchFlow.current = false;
      useSearchStore.getState().setQuery("");
    }
  }, [screen]);

  useEffect(() => () => {
    if (prevScreenTimer.current) clearTimeout(prevScreenTimer.current);
  }, []);

  useMobileBoot(noteRef);

  // 다른 앱에서 "가져오기"로 온 내용 — 입력 화면 초안을 채운다. 입력 화면을 떠나면 노트가 된다(D1, useMobileImport.ts 머리말).
  // openCapture 는 아래 openImportCapture 를 늦게 부른다(effect 가 돈 뒤에야 쓰인다). popstate 리스너는 한 번만
  // 등록돼 이 렌더의 imp 를 못 보므로 impRef 로 읽는다.
  const imp = useMobileImport({ openCapture: (fill, proceed, force) => openImportCapture(fill, proceed, force) });
  const impRef = useRef(imp);
  impRef.current = imp;
  // 가져온 초안으로 입력 화면을 새로 마운트할 때 올리는 키. (자동 포커스는 어느 진입에도 없다 — D2, 오너 2026-10-10.)
  const [captureKey, setCaptureKey] = useState(0);
  // 못 올린 가져온 사진 표시줄(O-2) — 활성 노트에 걸린 장부 항목.
  const importLedger = useImportLedger();
  const activeNoteId = useNotesStore((s) => s.activeNote?.note.id ?? null);
  // [버리기](가져오기 띠)는 가져온 내용이 아직 초안일 때만 — 자동 저장이 노트를 만든 뒤 버리기는 노트 삭제라 이 띠의 일이 아니다.
  const activeDraft = useNotesStore((s) => s.activeDraft);

  useEffect(() => {
    writeEntry("replace", "home", 0);
    const onPopState = (e: PopStateEvent) => {
      const st = e.state as Partial<HistState> | null;
      // Landed on a layer (MobileModal/useBackClosable) marker — a pop between stacked layers, not a
      // screen navigation. Detect by `mobileModal` only (the entry carries extra fields); the layer
      // closes itself, we neither navigate nor call back()/go() here.
      if ((st as { mobileModal?: boolean } | null)?.mobileModal) return;
      const next = st?.screen ?? "home";
      // The popped entry describes the screen we are ALREADY on ⇒ this pop removed something
      // stacked on top of it, not a navigation. MobileModal pushes exactly such a throwaway entry
      // (so the Android back gesture closes the modal) and pops it again on EVERY close — Esc,
      // backdrop tap, Cancel — so this fires constantly. Without the guard: on 입력 the branch below
      // would call newNote() and destroy the draft being typed; on any screen it would flip
      // `direction` and replay the 200ms slide underneath the open modal.
      if (next === screenRef.current) return;
      const leaving = screenRef.current;
      const fromDepth = depthRef.current;
      const apply = () => {
        depthRef.current = st?.idx ?? (next === "home" ? 0 : 1);
        // Blanket safety net for the hardware-back path: MobileNote's own unmount cleanup does not
        // flush a pending debounced edit — a fire-and-forget flush here covers the "note"/"capture"
        // screens without per-screen special-casing.
        void flushAll();
        setDirection("back");
        startGhost(screenRef.current, next);
        if (next === "capture") {
          // Tab moves no longer stack, so a "capture" entry is only reachable UNDER a pushed screen
          // (입력 -> a linked note -> back). Landing on it must never resurrect the note the user
          // already left; start a fresh draft, same as a tab-bar tap into 입력.
          void useNotesStore.getState().newNote().then(() => setScreen("capture"));
          return;
        }
        setScreen(next);
      };
      if ((leaving === "note" || leaving === "capture") && noteRef.current) {
        // V5: 하드웨어 뒤로는 이미 pop 됐다. 저장 실패한 본문이 있으면 flush(재시도) 뒤 같은 항목을
        // 다시 쌓아 화면에 머문다. flush 가 없을 때도 이 await 한 번뿐이라 건강한 경로는 거의 즉시다.
        void (async () => {
          // [그래도 나가기]가 다시 쏜 뒤로인가 — 그러면 저장하겠다는 뜻이 아니다(leaveCapture 의 force 와 같다). 읽는 즉시 내린다.
          const forced = leaveAnywayRef.current;
          leaveAnywayRef.current = false;
          await flushAll();
          if (screenRef.current !== leaving) return; // 그 사이 다른 경로가 이미 화면을 옮겼다
          if (
            !forced &&
            (await blockIfUnsaved("hw_back", () => {
              leaveAnywayRef.current = true;
              history.back();
            }))
          ) {
            writeEntry("push", leaving, fromDepth);
            return;
          }
          // 가져온 초안(D1): 떠나면 노트로 만들고 이미지를 올린다. 못 만들었으면(오프라인 등) 이미 pop 된 항목을 다시 쌓아
          // 화면에 머문다 — 초안을 "서버에 못 보낸 글"로 표시해 다음 나가기가 V5 관문을 지나게 한다(leaveCapture 와 같은 규칙).
          // forced([그래도 나가기] 뒤)면 버린다 — 안 그러면 오프라인에서 하드웨어 뒤로가 영영 못 나간다.
          if (leaving === "capture" && (await impRef.current.settle(!forced)) === "stay") {
            if (useNotesStore.getState().activeDraft) noteRef.current?.markDraftUnsent?.();
            writeEntry("push", leaving, fromDepth);
            return;
          }
          apply();
        })();
        return;
      }
      // MobileNote 가 아직 마운트 전(지연 로드 중)이어도 가져온 초안은 정리한다(위와 같이 노트로 만든다).
      if (leaving === "capture" && impRef.current.hasSession()) {
        void impRef.current.settle(true).then((r) => {
          if (r === "stay") writeEntry("push", leaving, fromDepth);
          else apply();
        });
      } else apply();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (next: Screen) => {
    if (next === screen) return;
    // The "note" screen now sits under the tab bar (see showTabBar below), so a tab tap is a way to
    // leave a note editor WITHOUT going through handleBack/leaveCapture — and MobileNote's plain
    // unmount cleanup deliberately does not flush. Same fire-and-forget flush the popstate handler
    // already does. Callers that swap activeNote BEFORE navigating (enterCapture/openNote) must
    // await their own flush first — by the time this runs, sectionRef would already point at the
    // new note's section. See those two functions.
    void flushAll();
    // Tab<->tab moves (home/capture/settings) derive direction from left-to-right index order;
    // every other push (opening note/search/postsave) keeps the old "forward" default — those are
    // stack pushes, not lateral tab moves, and the owner brief keeps their semantics as-is.
    // Tab -> home = back to the root entry. The pop's own popstate does the screen swap (flush,
    // direction "back", ghost) — nothing else to do here.
    if (next === "home" && depthRef.current > 0) {
      history.go(-depthRef.current);
      return;
    }
    const curIdx = TAB_ORDER.indexOf(screen as TabScreen);
    const nextIdx = TAB_ORDER.indexOf(next as TabScreen);
    const isTabMove = curIdx !== -1 && nextIdx !== -1;
    const dir: "forward" | "back" = isTabMove ? (nextIdx > curIdx ? "forward" : "back") : "forward";
    setDirection(dir);
    startGhost(screen, next);

    if (nextIdx !== -1) {
      // Non-home tab: one entry above the root — push from home, otherwise replace in place.
      if (depthRef.current === 0) writeEntry("push", next, 1);
      else writeEntry("replace", next, depthRef.current);
    } else {
      writeEntry("push", next, depthRef.current + 1);
    }
    setScreen(next);
  };

  const goBack = () => {
    history.back();
  };

  /**
   * V5: 나가기 경로 공통 관문. 호출 전에 flush(재시도 1회)가 끝나 있어야 한다. 저장 못 한 본문이 남았으면
   * 막고(true) 화면에 실패 배너를 띄운다 — proceed 는 사용자가 [그래도 나가기]를 눌렀을 때만 실행된다.
   * 기록은 reportFallback(본문·경로 없이 어느 출구인지만).
   */
  const blockIfUnsaved = async (exit: string, proceed: () => void): Promise<boolean> => {
    const n = noteRef.current;
    if (!n?.hasUnsavedFailure?.()) return false;
    reportFallback("mobile-save", "leave_blocked", exit);
    n.showLeaveBlocked?.(proceed);
    return true;
  };

  // Both of these REPLACE activeNote before navigating, so the flush has to happen (and be awaited)
  // first: after selectNote/newNote lands, MobileNote's note-load effect has already re-pointed
  // sectionRef at the new note's section and a late flush would write the old edit to the wrong id.
  // 노트 화면으로 가는 모든 길(목록·검색·갤러리·위키 링크·입력 탭)이 지나는 곳 — 첫 await 전에 MobileNote 청크를
  // 받기 시작해 flushAll·selectNote 왕복과 겹치게 한다(폰은 유휴 미리 받기가 없다, lib/lazyPreload.ts).
  const openNote = async (id: string, force = false) => {
    void MobileNote.preload();
    await flushAll();
    if (!force && (await blockIfUnsaved("open_note", () => void openNote(id, true)))) return;
    // 입력 화면의 가져온 초안을 selectNote 가 조용히 버리기 전에 노트로 만든다(D1 — 떠나면 노트). 못 만들면 머문다.
    // force = [그래도 나가기] 뒤 — leaveCapture 와 같이 저장하겠다는 뜻이 아니므로 버린다(오프라인에서 영영 못 나가는 것 방지).
    if ((await impRef.current.settle(!force)) === "stay") return;
    cancelCaptureFocus();
    await useNotesStore.getState().selectNote(id);
    navigate("note");
  };

  const enterCapture = async (force = false) => {
    void MobileNote.preload();
    await flushAll();
    if (!force && (await blockIfUnsaved("enter_capture", () => void enterCapture(true)))) return;
    if ((await impRef.current.settle(!force)) === "stay") return; // force 의 뜻은 openNote 주석
    await useNotesStore.getState().newNote();
    requestCaptureFocus(); // O-1: ＋ 로 연 빈 초안만 키보드(useMobileBodyEditor 가 마운트 때 한 번 가져간다)
    navigate("capture");
  };

  /**
   * 가져온 내용으로 입력 화면 열기 — enterCapture 와 같은 절차(flush → 저장 실패 관문 → 새 초안 → 화면 전환)에
   * 초안 채우기(`fill`)가 끼어든다. 채우기는 **navigate 전에** 끝낸다: MobileNote 가 마운트하며 스토어의 초안을 칠한다.
   * 이미 입력 화면이면 navigate 가 no-op 라 키를 올려 새 초안으로 다시 마운트시킨다.
   * @returns false = 저장 실패 관문에 막혔다(사용자가 [그래도 나가기]를 고르면 `proceed` 가 다시 부른다)
   */
  const openImportCapture = async (fill: () => Promise<void>, proceed: () => void, force: boolean): Promise<boolean> => {
    void MobileNote.preload();
    await flushAll();
    if (!force && (await blockIfUnsaved("import", proceed))) return false;
    // 화면에 이전 가져오기가 남아 있으면 그것도 내용이다 — 노트로 만든 뒤 새 것을 채운다(D1). 못 만들면 새 가져오기를 미룬다
    // (ack 하지 않으므로 다음 트리거가 다시 시도한다).
    if ((await impRef.current.settle(!force)) === "stay") return false; // force 의 뜻은 openNote 주석
    await useNotesStore.getState().newNote();
    await fill();
    cancelCaptureFocus();
    if (screenRef.current === "capture") setCaptureKey((k) => k + 1);
    else navigate("capture");
    return true;
  };

  /**
   * Leaving an EXISTING note (header back). The rule, deliberately different from capture's: flush
   * the pending debounced edit, then go back where the user came from — never the post-save
   * interstitial. That screen is a "you just wrote something, want AI to do something with it?"
   * prompt for a fresh capture; firing it because someone opened a 3-year-old note and backed out
   * would be a bogus congratulation. Everything is already saved continuously (700ms debounce).
   * (There used to be a 저장하기 button doing the same; it was removed 2026-10-10.)
   */
  const saveAndLeaveNote = async (force = false) => {
    if (!force) {
      await noteRef.current?.flushAndMeasure();
      if (await blockIfUnsaved("note_back", () => void saveAndLeaveNote(true))) return;
    }
    goBack();
  };

  /**
   * Every exit from the 입력 tab (header back arrow OR a tab-bar tap) routes through here, so a
   * pending debounced edit always flushes first (MobileNote.flushAndMeasure — its plain unmount
   * cleanup does not) and so "long" notes get the post-save interstitial no matter which way the
   * user left. `viaBack`: true for the header back arrow (pop history — matches the "back gesture
   * returns to 노트 tab" contract), false for a tab-bar tap (push `dest`, a fresh tab entry).
   */
  const leaveCapture = async (viaBack: boolean, dest: "home" | "settings" = "home", force = false) => {
    // V5: 저장 실패면 입력 화면에 머문다(글은 에디터에 그대로). force = [그래도 나가기] 뒤 — 이미 본문을
    // 클립보드로 건졌고, 저장 안 된 글에 "AI 로 이어서" 안내를 띄우는 건 어색하니 인터스티셜도 건너뛴다.
    let plainLen = 0;
    if (!force) {
      plainLen = (await noteRef.current?.flushAndMeasure()) ?? 0;
      if (
        await blockIfUnsaved(viaBack ? "capture_back" : "capture_tab", () => void leaveCapture(viaBack, dest, true))
      ) {
        return;
      }
    }
    // 가져온 초안 정리(D1, 오너 2026-10-10 — 저장하기 버튼이 없어졌으므로 "가져온 내용도 내용"): 떠나면 노트를 만들고 이미지를
    // 올린다(실패하면 머문다). 버리려면 가져오기 띠의 [버리기]를 누른다.
    // 반드시 navigate 전에 끝낸다: navigate 의 flushAll 이 초안→노트 교체 도중의 낡은 섹션 id 로 쓰지 않게.
    // [그래도 나가기](force)는 저장하겠다는 뜻이 아니므로 버린다(네트워크가 막힌 채 영영 못 나가는 것 방지).
    const settled = await impRef.current.settle(!force);
    if (settled === "stay") {
      // 나가며 노트를 못 만들었다(초안이 그대로다). 가져온 내용은 쓰기를 시도한 적이 없어 에디터의 flush 가 "이미 같음" 으로
      // 건너뛰고 나가기를 통과시킨다 — 다시 "서버에 못 보낸 글"로 표시해 뒤로·탭이 V5 관문을 지나게 한다. 이미 노트가 된 뒤
      // 사진 업로드만 실패한 경우(초안 아님)는 해당 없다 — 그 사진은 나갈 때 백그라운드로 다시 올린다.
      if (useNotesStore.getState().activeDraft) noteRef.current?.markDraftUnsent?.();
      return;
    }
    if (settled === "discarded") plainLen = 0; // 아무것도 저장되지 않았다 — "메모가 저장되었습니다" 인터스티셜 금지
    if (plainLen >= CAPTURE_LONG_CHARS) {
      // Replace the capture entry with `dest` first (so back-from-postsave lands there directly
      // instead of re-showing the just-left editor), then push postsave on top.
      // To home the stack stays [home, postsave] (postsave takes the capture entry's place);
      // to settings it is [home, settings, postsave].
      setDirection("forward");
      if (dest === "home") {
        writeEntry("replace", "postsave", depthRef.current);
      } else {
        writeEntry("replace", dest, depthRef.current);
        writeEntry("push", "postsave", depthRef.current + 1);
      }
      setScreen("postsave");
      return;
    }
    if (viaBack) {
      goBack();
    } else {
      navigate(dest);
    }
  };

  const nextNoteFromPostsave = async () => {
    void MobileNote.preload();
    await useNotesStore.getState().newNote();
    cancelCaptureFocus();
    // Replaces (not pushes) postsave's entry — back-from-this-capture still lands on whatever was
    // before postsave, same "back gesture returns to 노트 tab" contract as any other capture entry.
    writeEntry("replace", "capture", depthRef.current);
    setDirection("forward");
    setScreen("capture");
  };

  const backToFeed = () => {
    // Pop to the root; onPopState swaps the screen (keeps exactly one home entry).
    if (depthRef.current > 0) history.go(-depthRef.current);
    else {
      setDirection("back");
      setScreen("home");
    }
  };

  const onTabClick = (tab: TabScreen) => {
    if (tab === screen) return;
    if (screen === "note") {
      // V5: 노트 화면에서의 탭 이동도 같은 관문을 지난다(flush → 저장 실패면 머문다).
      void (async () => {
        await flushAll();
        const go = () => (tab === "capture" ? void enterCapture(true) : navigate(tab));
        if (await blockIfUnsaved("note_tab", go)) return;
        go();
      })();
      return;
    }
    if (screen === "capture") {
      void leaveCapture(false, tab === "settings" ? "settings" : "home");
      return;
    }
    if (tab === "capture") {
      void enterCapture();
      return;
    }
    navigate(tab);
  };

  // Owner feedback (2026-07-30, item 1): 노트 보기 and 입력 must be the SAME screen with the SAME
  // chrome — so "note" keeps the tab bar too, even though it is a pushed screen rather than a tab.
  // Only the two screens that are genuinely modal to the flow hide it: "search" (its own full-screen
  // input) and "postsave" (an interstitial whose whole job is to be answered).
  const showTabBar = screen !== "search" && screen !== "postsave";

  const renderScreen = (s: Screen) => {
    switch (s) {
      case "home":
        return (
          <MobileHome
            onOpenNote={(id) => void openNote(id)}
            onOpenSearch={() => navigate("search")}
            // 노트 탭 ＋ → 노트 추가 = 탭 바 가운데 ＋ 와 같은 진입(flush → 저장 실패 관문 → 새 초안 → 입력 화면).
            onNewNote={() => void enterCapture()}
          />
        );
      case "capture":
        return (
          <>
            <MobileImportStrip
              count={imp.pending}
              onDrop={imp.dropFiles}
              canDiscard={imp.active && activeDraft}
              onDiscard={() => void imp.discard()}
            />
            <Suspense fallback={null}>
              <MobileNote
                key={captureKey}
                ref={noteRef}
                onBack={() => void leaveCapture(true)}
                capture
                onOpenNote={(id) => void openNote(id)}
              />
            </Suspense>
          </>
        );
      case "settings":
        return <MobileSettings />;
      case "note":
        // Same component, same props shape as "capture" above minus `capture` — the one note screen
        // the owner asked for. Only the leave RULE differs (see saveAndLeaveNote).
        return (
          <>
            {importLedger.entries
              .filter((e) => e.noteId === activeNoteId)
              .map((e) => (
                <MobileImportPendingBar
                  key={e.importId}
                  count={e.files.length}
                  busy={importLedger.busy.includes(e.importId)}
                  onRetry={() => retryImportUploads(e)}
                  onDiscard={() => void discardImportUploads(e.importId)}
                />
              ))}
            <Suspense fallback={null}>
              <MobileNote
                ref={noteRef}
                onBack={() => void saveAndLeaveNote()}
                onOpenNote={(id) => void openNote(id)}
              />
            </Suspense>
          </>
        );
      case "search":
        return <MobileSearch onOpenNote={(id) => void openNote(id)} onClose={goBack} />;
      case "postsave":
        return <MobilePostSave onNextNote={() => void nextNoteFromPostsave()} onBackToFeed={backToFeed} />;
    }
  };

  // 키보드가 열리면 하단 탭·프리셋 칩을 숨긴다(useKeyboardOpen.ts 헤더 참고).
  const keyboardOpen = useKeyboardOpen();

  return (
    <div className="mobile-app" data-kbd={keyboardOpen ? "open" : undefined}>
      <MobileOfflineBanner />
      <div className="mobile-screen-viewport">
        {prevScreen && (
          <div className={`mobile-screen mobile-screen--exit-${direction}`}>{renderScreen(prevScreen)}</div>
        )}
        <div key={screen} className={`mobile-screen mobile-screen--${direction}`}>
          {renderScreen(screen)}
        </div>
      </div>

      {showTabBar && <MobileTabBar screen={screen} onTabClick={onTabClick} />}

      {/* Mounted once, screen-independent — its mere presence is what un-bypasses the AI result
          gate for the whole mobile tree (see MobileAiResultSheet.tsx's header comment). Renders
          null while there is no gate session, same "store has state -> sheet shows" contract as
          every other mobile sheet in this file. */}
      <MobileAiResultSheet />

      {/* 배경 신호 — AI 가 일하는 동안 가장자리 빛줄기, 녹음하는 동안 화면 아래 은은한 이퀄라이저 띠. 스스로 스토어를
          구독해 켜고 끈다(이 컴포넌트는 다시 그려지지 않는다). 고정·터치 통과 레이어라 화면 흐름에 영향 없음. */}
      <MobileAmbient />
    </div>
  );
}
