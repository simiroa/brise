import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { t } from "../i18n/t";
import { usePresetsStore } from "../stores/presets";
import { MobileDockSlot, dockSlotKind, type DockSlotKind } from "./MobileDockSlot";
import { MobileNoteActionBar } from "./MobileNoteActionBar";

/**
 * 독 슬롯의 상태표(프리셋 | 서식 | 이미지 크기 | 관계도·시트 = 스피드 다이얼 ＋ 하나)와, 독의 버튼들이 에디터 포커스를 뺏지 않는다는 것.
 * Tiptap 은 가짜다 — 이 파일이 보는 건 슬롯이 무엇을 고르고 언제 다시 그리는가다(진짜 에디터에서의 선택 전환은
 * MobileNote.realEditor.test.tsx).
 */
type Flags = { image: boolean; taskList: boolean; bold: boolean; italic: boolean };

function makeEditor(initial: Partial<Flags> = {}) {
  const flags: Flags = { image: false, taskList: false, bold: false, italic: false, ...initial };
  /** 살아 있는 문서 상태 — 진짜 Tiptap 의 `editor.isEmpty`·`view.composing`·`state.selection.empty` 를 흉내 낸다. */
  const doc = { empty: true, composing: false, selectionEmpty: true };
  const handlers = new Set<() => void>();
  const toggled: string[] = [];
  const widths: unknown[] = [];
  const editor = {
    isDestroyed: false,
    get isEmpty() {
      return doc.empty;
    },
    get view() {
      return { composing: doc.composing };
    },
    get state() {
      return { selection: { empty: doc.selectionEmpty } };
    },
    isActive: (name: string) => flags[name as keyof Flags] ?? false,
    getAttributes: () => ({ width: "40%" }),
    on: (ev: string, fn: () => void) => {
      if (ev === "transaction") handlers.add(fn);
    },
    off: (ev: string, fn: () => void) => {
      if (ev === "transaction") handlers.delete(fn);
    },
    chain: () => ({
      focus: () => ({
        toggleTaskList: () => ({ run: () => toggled.push("task") }),
        toggleBold: () => ({ run: () => toggled.push("bold") }),
        toggleItalic: () => ({ run: () => toggled.push("italic") }),
        updateAttributes: (_n: string, attrs: unknown) => ({ run: () => widths.push(attrs) }),
      }),
    }),
  };
  return {
    editor: editor as unknown as Editor,
    flags,
    doc,
    toggled,
    widths,
    handlerCount: () => handlers.size,
    /** 트랜잭션(캐럿 이동 포함)이 일어났다고 알린다. */
    fireTransaction: () => act(() => handlers.forEach((h) => h())),
    destroy: () => {
      editor.isDestroyed = true;
    },
  };
}

const CHECKLIST = () => screen.queryByLabelText(t("mobile.checklist"));
const BOLD = () => screen.queryByLabelText(t("editor.bold"));
const ITALIC = () => screen.queryByLabelText(t("editor.italic"));
const MORE = () => screen.queryByTestId("mobile-preset-more");
const SIZES = () => screen.queryByTestId("mobile-image-size-controls");
const slotKind = () => screen.getByTestId("mobile-dock-slot").getAttribute("data-slot");

function slotProps(over: Partial<React.ComponentProps<typeof MobileDockSlot>> = {}) {
  return {
    textSection: true,
    readOnly: false,
    showPresets: false,
    customPresets: [],
    todoBodyMd: "<ul data-type='taskList'></ul>",
    aiReady: true,
    onApplyPreset: vi.fn(),
    onGenerateAi: vi.fn(async () => null),
    ...over,
  };
}

beforeEach(() => {
  usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
});

describe("dockSlotKind — slot state table", () => {
  const base = { textSection: true, readOnly: false, imageSelected: false, showPresets: false, bodyEmpty: true };
  const cases: Array<[string, Parameters<typeof dockSlotKind>[0], DockSlotKind]> = [
    ["empty capture (presets on)", { ...base, showPresets: true }, "presets"],
    ["content / preset applied / note view", base, "format"],
    // 스토어 플래그(showPresets)는 700ms 디바운스 뒤에야 움직인다 — 살아 있는 문서에 글이 있으면 프리셋은 안 나온다.
    ["store flag still says empty but the live editor has text → formatting, never presets", { ...base, showPresets: true, bodyEmpty: false }, "format"],
    ["live editor empty but the store says no presets (applied / note view)", { ...base, showPresets: false, bodyEmpty: true }, "format"],
    ["image selected", { ...base, imageSelected: true, bodyEmpty: false }, "image"],
    ["image selected beats the presets", { ...base, imageSelected: true, showPresets: true }, "image"],
    ["diagram / sheet section", { ...base, textSection: false }, "none"],
    ["diagram / sheet never shows presets", { ...base, textSection: false, showPresets: true }, "none"],
    ["diagram / sheet never shows image sizes", { ...base, textSection: false, imageSelected: true }, "none"],
    ["read-only text keeps (disabled) formatting", { ...base, readOnly: true }, "format"],
    ["read-only text never offers presets", { ...base, readOnly: true, showPresets: true }, "format"],
    ["read-only text never offers image sizes", { ...base, readOnly: true, imageSelected: true }, "format"],
  ];
  it.each(cases)("%s → %s", (_name, input, expected) => {
    expect(dockSlotKind(input)).toBe(expected);
  });
});

describe("MobileDockSlot", () => {
  it("empty capture: the capture presets (one row) + 더보기, and no formatting", () => {
    const { editor } = makeEditor();
    render(<MobileDockSlot editor={editor} {...slotProps({ showPresets: true })} />);
    expect(slotKind()).toBe("presets");
    expect(screen.getByText(t("presets.todo_name"))).toBeTruthy();
    expect(MORE()).toBeTruthy();
    expect(CHECKLIST()).toBeNull();
    expect(SIZES()).toBeNull();
  });

  it("content: ☑ B I, no presets — and a preset tap is forwarded", () => {
    const { editor } = makeEditor();
    render(<MobileDockSlot editor={editor} {...slotProps()} />);
    expect(slotKind()).toBe("format");
    expect(CHECKLIST()).toBeTruthy();
    expect(BOLD()).toBeTruthy();
    expect(ITALIC()).toBeTruthy();
    expect(MORE()).toBeNull();
  });

  it("presets forward the tap to onApplyPreset", () => {
    const { editor } = makeEditor();
    const props = slotProps({ showPresets: true });
    render(<MobileDockSlot editor={editor} {...props} />);
    fireEvent.click(screen.getByText(t("presets.todo_name")));
    expect(props.onApplyPreset).toHaveBeenCalledWith({ title: null, bodyMd: "<ul data-type='taskList'></ul>" });
  });

  it("image selected: the 3 size steps replace the formatting buttons and write the width", () => {
    const { editor, widths } = makeEditor({ image: true });
    render(<MobileDockSlot editor={editor} {...slotProps()} />);
    expect(slotKind()).toBe("image");
    expect(SIZES()).toBeTruthy();
    expect(CHECKLIST()).toBeNull();
    fireEvent.click(screen.getByText(t("mobile.img_size_small")));
    expect(widths).toEqual([{ width: "25%" }]);
  });

  it("diagram / sheet section: nothing in the slot (no formatting, no presets)", () => {
    const { editor } = makeEditor();
    render(<MobileDockSlot editor={editor} {...slotProps({ textSection: false, showPresets: true })} />);
    expect(slotKind()).toBe("none");
    expect(screen.getByTestId("mobile-dock-slot").childElementCount).toBe(0);
  });

  describe("speed dial ＋ (diagram / sheet sections — where a floating FAB would cover the bottom controls)", () => {
    const dial = () => ({ onOpenVoice: vi.fn(), onPickPhoto: vi.fn(), onOpenAttach: vi.fn(), onOpenAi: vi.fn(), aiReady: true });
    const TOGGLE = () => screen.queryByTestId("mobile-fab-toggle");

    it("diagram / sheet: the slot holds exactly the ＋ (dock placement) — still no formatting, no presets", () => {
      const { editor } = makeEditor();
      render(<MobileDockSlot editor={editor} {...slotProps({ textSection: false, showPresets: true, speedDial: dial() })} />);
      expect(slotKind()).toBe("none");
      const slot = screen.getByTestId("mobile-dock-slot");
      expect(slot.childElementCount).toBe(1);
      expect(slot.contains(TOGGLE())).toBe(true);
      expect(screen.getByTestId("mobile-speed-dial").getAttribute("data-placement")).toBe("dock");
      expect(CHECKLIST()).toBeNull();
      expect(MORE()).toBeNull();
      expect(SIZES()).toBeNull();
      // 슬롯 안의 ＋ 는 떠 있는 FAB 가 아니다 — 같은 화면에 FAB 래퍼가 없다(MobileNote 가 텍스트 섹션에만 낸다).
      expect(document.querySelector(".mobile-note-fab")).toBeNull();
    });

    it("its four actions (녹음 · 사진 · 파일 첨부 · AI) open from the dock and reach the same handlers", () => {
      const { editor } = makeEditor();
      const h = dial();
      render(<MobileDockSlot editor={editor} {...slotProps({ textSection: false, speedDial: h })} />);
      fireEvent.click(TOGGLE()!);
      expect(TOGGLE()!.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getByTestId("mobile-fab-mic"));
      fireEvent.click(TOGGLE()!);
      fireEvent.click(screen.getByTestId("mobile-fab-photo"));
      fireEvent.click(TOGGLE()!);
      fireEvent.click(screen.getByTestId("mobile-fab-attach"));
      fireEvent.click(TOGGLE()!);
      fireEvent.click(screen.getByTestId("mobile-fab-ai"));
      expect([h.onOpenVoice, h.onPickPhoto, h.onOpenAttach, h.onOpenAi].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });

    it.each([
      ["format", { }],
      ["presets", { showPresets: true }],
      ["read-only text", { readOnly: true }],
    ] as const)("text section (%s): the slot never carries the ＋ — the floating FAB owns it", (_n, over) => {
      const { editor } = makeEditor();
      render(<MobileDockSlot editor={editor} {...slotProps({ ...over, speedDial: dial() })} />);
      expect(TOGGLE()).toBeNull();
    });

    it("text section with an image selected: no ＋ in the slot either", () => {
      const { editor } = makeEditor({ image: true });
      render(<MobileDockSlot editor={editor} {...slotProps({ speedDial: dial() })} />);
      expect(slotKind()).toBe("image");
      expect(TOGGLE()).toBeNull();
    });

    it("without handlers (nobody wired it) the diagram slot stays empty", () => {
      const { editor } = makeEditor();
      render(<MobileDockSlot editor={editor} {...slotProps({ textSection: false })} />);
      expect(TOGGLE()).toBeNull();
    });
  });

  it("read-only text: the formatting buttons are shown but disabled", () => {
    const { editor } = makeEditor();
    render(<MobileDockSlot editor={editor} {...slotProps({ readOnly: true })} />);
    expect(slotKind()).toBe("format");
    expect((CHECKLIST() as HTMLButtonElement).disabled).toBe(true);
    expect((BOLD() as HTMLButtonElement).disabled).toBe(true);
    expect((ITALIC() as HTMLButtonElement).disabled).toBe(true);
  });

  it("formatting buttons run their toggle on the editor", () => {
    const { editor, toggled } = makeEditor();
    render(<MobileDockSlot editor={editor} {...slotProps()} />);
    fireEvent.click(CHECKLIST()!);
    fireEvent.click(BOLD()!);
    fireEvent.click(ITALIC()!);
    expect(toggled).toEqual(["task", "bold", "italic"]);
  });

  describe("follows the editor without a parent re-render (Tiptap v3 does not re-render on transactions)", () => {
    it("a selection landing on an image flips the slot to the size steps, and back", () => {
      const m = makeEditor();
      render(<MobileDockSlot editor={m.editor} {...slotProps()} />);
      expect(slotKind()).toBe("format");

      m.flags.image = true;
      m.fireTransaction();
      expect(slotKind()).toBe("image");
      expect(SIZES()).toBeTruthy();

      m.flags.image = false;
      m.fireTransaction();
      expect(slotKind()).toBe("format");
      expect(CHECKLIST()).toBeTruthy();
    });

    it("the pressed state of bold follows a caret move", () => {
      const m = makeEditor();
      render(<MobileDockSlot editor={m.editor} {...slotProps()} />);
      expect(BOLD()!.getAttribute("data-active")).toBe("false");
      m.flags.bold = true;
      m.fireTransaction();
      expect(BOLD()!.getAttribute("data-active")).toBe("true");
    });

    it("typing the first character flips presets → formatting at once, though the store flag (showPresets) has not moved yet", () => {
      const m = makeEditor();
      // showPresets 는 스토어 activeBodyEmpty 에서 온다 — 700ms 자동저장 디바운스가 끝나야 움직이므로 여기선 그대로 true.
      render(<MobileDockSlot editor={m.editor} {...slotProps({ showPresets: true })} />);
      expect(slotKind()).toBe("presets");
      expect(MORE()).toBeTruthy();

      m.doc.empty = false;
      m.fireTransaction();
      expect(slotKind()).toBe("format");
      expect(MORE()).toBeNull();
      expect(screen.queryByText(t("presets.todo_name"))).toBeNull();
      expect(CHECKLIST()).toBeTruthy();
    });

    it("clearing the text brings the presets back (while the store flag still allows them)", () => {
      const m = makeEditor();
      m.doc.empty = false;
      render(<MobileDockSlot editor={m.editor} {...slotProps({ showPresets: true })} />);
      expect(slotKind()).toBe("format");
      m.doc.empty = true;
      m.fireTransaction();
      expect(slotKind()).toBe("presets");
    });

    it("a transaction that changes none of the flags does not re-render the slot", () => {
      const m = makeEditor();
      let renders = 0;
      const isActive = m.editor.isActive.bind(m.editor);
      (m.editor as any).isActive = (n: string) => {
        renders++;
        return isActive(n);
      };
      render(<MobileDockSlot editor={m.editor} {...slotProps()} />);
      const afterMount = renders;
      m.fireTransaction();
      // 한 번의 읽기(4개 플래그) — 값이 같으니 다시 그리지 않는다(그리면 한 번 더 읽는다).
      expect(renders - afterMount).toBe(4);
    });

    it("unsubscribes on unmount and ignores a destroyed editor", () => {
      const m = makeEditor();
      const { unmount } = render(<MobileDockSlot editor={m.editor} {...slotProps()} />);
      expect(m.handlerCount()).toBe(1);
      m.destroy();
      m.flags.image = true;
      expect(() => m.fireTransaction()).not.toThrow();
      expect(slotKind()).toBe("format"); // 파괴된 에디터의 변화는 무시
      unmount();
      expect(m.handlerCount()).toBe(0);
    });
  });
});

describe("dock buttons keep the editor focus (mousedown default prevented → the soft keyboard stays up)", () => {
  // fireEvent.mouseDown 은 기본 동작이 막혔으면 false 를 돌려준다.
  const stays = (el: Element) => fireEvent.mouseDown(el) === false;

  function dock(props: Partial<React.ComponentProps<typeof MobileDockSlot>> = {}) {
    const m = makeEditor({ image: false });
    const ui = (p: Partial<React.ComponentProps<typeof MobileDockSlot>>) => (
      <MobileNoteActionBar
        slot={<MobileDockSlot editor={m.editor} {...slotProps(p)} />}
      />
    );
    const r = render(ui(props));
    return { ...m, rerender: (p: Partial<React.ComponentProps<typeof MobileDockSlot>>) => r.rerender(ui(p)) };
  }

  it("the dock carries neither ✨ nor 저장하기 any more (✨ is a speed-dial item, typing autosaves — owner 2026-10-10)", () => {
    dock();
    expect(screen.queryByLabelText(t("editor.ai_menu_title"))).toBeNull();
    expect(screen.queryByText(t("mobile.save_button"))).toBeNull();
  });

  it("formatting buttons", () => {
    dock();
    expect(stays(CHECKLIST()!)).toBe(true);
    expect(stays(BOLD()!)).toBe(true);
    expect(stays(ITALIC()!)).toBe(true);
  });

  it("preset pills and 더보기", () => {
    dock({ showPresets: true });
    expect(stays(screen.getByText(t("presets.todo_name")))).toBe(true);
    expect(stays(MORE()!)).toBe(true);
  });

  it("the dock ＋ (diagram / sheet) and its opened actions", () => {
    const m = makeEditor();
    render(
      <MobileNoteActionBar
        slot={
          <MobileDockSlot
            editor={m.editor}
            {...slotProps({
              textSection: false,
              speedDial: { onOpenVoice: vi.fn(), onPickPhoto: vi.fn(), onOpenAttach: vi.fn(), onOpenAi: vi.fn(), aiReady: true },
            })}
          />
        }
      />
    );
    expect(stays(screen.getByTestId("mobile-fab-toggle"))).toBe(true);
    fireEvent.click(screen.getByTestId("mobile-fab-toggle"));
    for (const id of ["mobile-fab-mic", "mobile-fab-photo", "mobile-fab-attach", "mobile-fab-ai"]) expect(stays(screen.getByTestId(id)), id).toBe(true);
  });

  it("image size steps (MobileImageSizeControls has no handler of its own — the dock root covers it)", () => {
    const m = makeEditor({ image: true });
    render(
      <MobileNoteActionBar
        slot={<MobileDockSlot editor={m.editor} {...slotProps()} />}
      />
    );
    expect(stays(screen.getByText(t("mobile.img_size_medium")))).toBe(true);
  });

  // IME 조합(Gboard): 독 루트가 mousedown 을 막으면 조합이 살아 있는 채로 명령이 트랜잭션을 꽂는다. 예전 툴바 줄은 막지 않아서
  // 버튼으로 포커스가 넘어가 조합이 확정된 뒤 명령이 돌았다 — 그 보장을 조합 중인 서식 눌림(☑·B·I)에 한해 되살렸다.
  describe("while an IME composition is live", () => {
    it("☑: mousedown is left alone so the editor blurs and commits the composition — the click still runs", () => {
      const m = dock();
      m.doc.composing = true;
      expect(stays(CHECKLIST()!)).toBe(false);
      fireEvent.click(CHECKLIST()!);
      expect(m.toggled).toEqual(["task"]);
    });

    it("bold / italic let go of the focus too — with a bare caret as well as over a range (the stored-marks path was never exercised on a device)", () => {
      const m = dock();
      m.doc.composing = true;
      m.doc.selectionEmpty = true;
      expect(stays(BOLD()!)).toBe(false);
      expect(stays(ITALIC()!)).toBe(false);
      fireEvent.click(BOLD()!);
      expect(m.toggled).toEqual(["bold"]); // 포커스를 놓아도 명령은 클릭에서 그대로 돈다
      m.doc.selectionEmpty = false;
      expect(stays(BOLD()!)).toBe(false);
      expect(stays(ITALIC()!)).toBe(false);
    });

    it("once the composition ends everything keeps the focus again", () => {
      const m = dock();
      m.doc.composing = true;
      expect(stays(CHECKLIST()!)).toBe(false);
      m.doc.composing = false;
      expect(stays(CHECKLIST()!)).toBe(true);
    });
  });

  it("but NOT inside the 더보기 sheet: it is a portal, and its text field must still take focus", () => {
    dock({ showPresets: true });
    fireEvent.click(MORE()!);
    fireEvent.click(screen.getByText(t("presets.ai_name")));
    const topic = screen.getByPlaceholderText(t("presets.ai_topic_placeholder"));
    // 포털 안이라 DOM 후손이 아니다 — React 합성 이벤트는 독 루트까지 올라오지만 막지 않는다.
    expect(fireEvent.mouseDown(topic)).toBe(true);
  });
});
