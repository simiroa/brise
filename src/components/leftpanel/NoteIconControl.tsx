// 이 파일이 쓰는 .picker-tab* / .em-img 와, 아래에서 여는 EmojiGrid 의 .emoji-* 는 전부
// emoji.css 소유다. 예전에는 EditorPanel 만 그 시트를 import 했는데, EditorPanel 은
// React.lazy 라 노트를 한 번도 열지 않은 세션(대시보드만 쓰는 흐름)에서는 시트가 문서에
// 없었다 — 사이드바 트리에서 롱프레스로 아이콘 피커를 열면 탭 버튼이 브라우저 기본
// 버튼으로, 이모지 격자가 레이아웃 없이 세로로 쌓여 나왔다(dashboardList.css 와 같은 사고).
// 클래스를 쓰는 쪽이 자기 시트를 직접 import 한다 — 남의 import 에 얹히지 않는다.
import "../../styles/emoji.css";
import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { call } from "../../lib/invoke";
import type { NoteSummary } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";
import { noteIconComp } from "../../lib/noteIcons";
import { bundledKeyFor, emojiAvailable, emojiSrc, subscribeEmojiRender } from "../../lib/emoji/emojiCore";
import { IconGrid, IconPickerPopover } from "../IconPicker";
import { IconNote } from "../icons";
import { beginLongPress, cancelLongPress, consumeLongPress } from "../../lib/longPress";
import { EmojiGrid } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";



export function NoteIcon({ icon, size }: { icon: string | null; size: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribeEmojiRender(() => setTick((t) => t + 1));
  }, []);

  if (icon && icon.startsWith("emoji:")) {
    const glyph = icon.slice(6);
    const key = bundledKeyFor(glyph);
    if (key && (emojiAvailable(key) || emojiSrc(key) !== "")) {
      return (
        <img
          className="em-img em-img--tree"
          src={emojiSrc(key)}
          alt={glyph}
          style={{ width: size, height: size, flex: "none" }}
        />
      );
    }
    return (
      <span
        style={{
          fontSize: size,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          flex: "none",
        }}
      >
        {glyph}
      </span>
    );
  }
  const Comp = noteIconComp(icon, IconNote);
  return <Comp size={size} strokeWidth={1.7} style={{ color: "var(--muted)", flex: "none" }} />;
}

function NoteIconInteractive({
  icon,
  size,
  onLongPress,
}: {
  icon: string | null;
  size: number;
  onLongPress: (anchorRect: DOMRect) => void;
}) {
  const elRef = useRef<HTMLSpanElement>(null);

  // W7-g: 타이머/발동 플래그는 lib/longPress.ts 로 옮겼다 — 모바일 노트 카드의 다중선택
  // 진입이 같은 제스처를 쓰기 때문(두 벌 두지 않는다). 동작은 그대로: 400ms 홀드, 움직이면
  // 취소, 발동했으면 뒤따르는 click 을 삼킨다.
  return (
    <span
      ref={elRef}
      onPointerDown={() => {
        // 이모지 아이콘이면 픽커가 이모지 탭으로 바로 열린다 — 길게 누르는 400ms 동안 그리드를 받아 둔다.
        if (icon?.startsWith("emoji:")) void EmojiGrid.preload();
        beginLongPress(() => {
          if (elRef.current) onLongPress(elRef.current.getBoundingClientRect());
        });
      }}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerMove={cancelLongPress}
      onClick={(e: React.MouseEvent) => {
        if (consumeLongPress()) e.stopPropagation();
      }}
      style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}
    >
      <NoteIcon icon={icon} size={size} />
    </span>
  );
}

/**
 * 노트 한 줄의 아이콘 컨트롤 — 아이콘 표시 + 400ms long-press 감지 + lucide/emoji 탭이 있는
 * 인라인 픽커(popover) + 선택 적용 흐름(note_set_icon → loadTree → 활성 노트면 reselect)을
 * 한 컴포넌트에 모아 둔다. 픽커는 portal 로 document.body 에 떴고 한 번에 하나만 보이도록
 * 자기 자신의 상태만 들고 있다 — 트리 전체에서 여러 줄이 동시에 자신을 마운트해도 visibility
 * 는 사용자가 누른 줄의 인스턴스 안에서만 관리되므로 다른 줄과 충돌하지 않는다.
 *
 * NoteTree 가 매 렌더마다 loadTree/selectNote/activeNoteId 를 prop 으로 다시 내려보내므로
 * 픽커 안의 apply 흐름은 "현재 활성 노트" 를 closure 가 아닌 props 로 읽는다 — 픽커를 열기
 * 시작한 그 행의 적용 콜백이, 그 시점의 NoteTree 렌더 클로저에 잡힌 activeNote 와 일치하도록
 * 유지한다(원래 NoteTree 에서도 같은 방식으로 동작).
 */
export function NoteIconControl({
  noteId,
  icon,
  size,
  loadTree,
  selectNote,
  activeNoteId,
}: {
  noteId: string;
  icon: string | null;
  size: number;
  loadTree: () => Promise<void>;
  selectNote: (id: string) => Promise<void>;
  activeNoteId: string | null;
}) {
  // 위치 계산·바깥 클릭 닫기·표면은 IconPickerPopover 가 가진다 — 폴더 설정의 아이콘 버튼이
  // 같은 껍데기를 쓰므로 두 메뉴가 저절로 같은 모양으로 뜬다.
  const [inlinePicker, setInlinePicker] = useState<{ icon: string | null; rect: DOMRect } | null>(null);

  const [sourceTab, setSourceTab] = useState<"lucide" | "emoji">("lucide");

  const onOpenInlinePicker = useCallback((rect: DOMRect) => {
    setSourceTab(icon && icon.startsWith("emoji:") ? "emoji" : "lucide");
    setInlinePicker({ icon, rect });
  }, [icon]);

  const runNoteIcon = useCallback(
    async (id: string, newIcon: string | null) => {
      // TitleBar mounts this control for the active note too, draft or not (single icon-edit
      // code path — see file header comment). A still-draft note's id is the "__draft__"
      // placeholder, so note_set_icon would 404 against it — route through the draft-aware
      // store setter instead, same as setRegion/setStatus do for their own titlebar badges.
      const s = useNotesStore.getState();
      if (s.activeDraft && s.activeNote?.note.id === id) {
        await s.setIcon(newIcon);
        return;
      }
      const updated = await call<NoteSummary>("note_set_icon", { id, icon: newIcon });
      useNotesStore.getState().patchNoteSummary(id, { icon: updated.icon });
      await loadTree();
      if (activeNoteId === id) await selectNote(id);
    },
    [loadTree, selectNote, activeNoteId]
  );

  return (
    <>
      <NoteIconInteractive icon={icon} size={size} onLongPress={onOpenInlinePicker} />
      {inlinePicker && (
        <IconPickerPopover anchorRect={inlinePicker.rect} onClose={() => setInlinePicker(null)}>
          <div className="picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sourceTab === "lucide"}
              className="picker-tab"
              data-active={sourceTab === "lucide"}
              onClick={() => setSourceTab("lucide")}
            >
              Lucide
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceTab === "emoji"}
              className="picker-tab"
              data-active={sourceTab === "emoji"}
              onClick={() => setSourceTab("emoji")}
              {...preloadIntentProps(EmojiGrid)}
            >
              Emoji
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {sourceTab === "lucide" ? (
              <IconGrid
                value={inlinePicker.icon}
                defaultComp={IconNote}
                onPick={(key) => {
                  setInlinePicker(null);
                  void runNoteIcon(noteId, key);
                }}
              />
            ) : (
              <Suspense fallback={<div className="emoji-grid-root" style={{ minHeight: 180 }} />}>
                <EmojiGrid
                  onPick={(glyph) => {
                    setInlinePicker(null);
                    void runNoteIcon(noteId, `emoji:${glyph}`);
                  }}
                />
              </Suspense>
            )}
          </div>
        </IconPickerPopover>
      )}
    </>
  );
}
