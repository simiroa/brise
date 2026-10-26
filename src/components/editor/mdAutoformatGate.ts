/**
 * 오너 결정(2026-09-20) — 마크다운 자동 서식(`editor_md_autoformat`/`editorMdAutoformat`) 킬
 * 스위치, **라이브 토글**(에디터를 다시 만들지 않고 즉시 반영).
 *
 * 범위 = 타이핑 INPUT RULE 만이다: `# `(heading), `> `(blockquote), `- `(bulletList),
 * `1. `(orderedList), 백틱 세 개(codeBlock), `---`(horizontalRule), `**bold**`/`__bold__`,
 * `*italic*`/`_italic_`, `` `code` ``, `~~strike~~`(모두 StarterKit 의 마크 입력 규칙),
 * `[ ] `/`[x] `(TaskItem, nested:true), 이 레포 자체 규칙인 `- [ ] ` → taskList
 * (`taskListDashInputRule.ts`), 그리고 `Typography`(스마트 따옴표·줄임표·화살표 등)가 등록하는
 * 나머지 전부 — `EditorPanel.tsx`/`mobile/MobileNote.tsx`가 실제로 쓰는 확장 목록
 * (`lib/mdSerialize.ts::markdownSchemaExtensions`)을 읽고 `addInputRules()`를 가진 것들을
 * 모아 확인했다. **범위 밖**(이 확장이 손대지 않는다): 붙여넣기 규칙(paste rules — 마크다운
 * 텍스트를 붙여넣는 것), 슬래시 커맨드/`[[`/`#`/`/날짜`/`/지역` Suggestion 팝업, 키보드 단축키
 * (Ctrl+B 등), 툴바 버튼, 키맵으로 구현된 "스마트" 동작(Enter 로 목록 이어쓰기 등).
 *
 * ## 메커니즘 선택 근거 (후보 순서대로 기각/채택)
 *
 * (a) `editor.setOptions({ enableInputRules })` — 기각. TipTap 코어를 실측했다:
 *     `ExtensionManager.plugins` getter(`node_modules/@tiptap/core/dist/index.js` ~L4629,
 *     `isExtensionRulesEnabled(extension, editor.options.enableInputRules)`)가 **에디터 생성
 *     시 딱 한 번** 이 값을 읽어 각 extension 의 `inputRulesPlugin`을 만들지 말지 결정한다.
 *     `Editor.setOptions()`(같은 파일 ~L5844)는 `this.options` 를 갱신하고
 *     `view.updateState(this.state)`만 부를 뿐, `ExtensionManager`/plugins 목록을 다시 만들지
 *     않는다 — 즉 `enableInputRules` 는 "부팅 시 고정값"이지 라이브 토글이 아니다. 이 앱은
 *     `EditorPanel.tsx`의 `useEditor`에 deps 배열이 없어(CLAUDE.md 함정 2) 에디터를 설정이 바뀔
 *     때마다 다시 만들 수도 없다 — 후보 (a)는 이 아키텍처에서 원천적으로 라이브가 안 된다.
 * (b) (채택) 최우선순위(priority) 확장 하나가 ProseMirror 의 `handleTextInput` 을 다른 모든
 *     입력 규칙 플러그인보다 먼저 가로챈다. 꺼져 있으면 기본 삽입(`deflt()`)을 대신 dispatch
 *     하고 `true`를 반환해 아래 플러그인들의 `handleTextInput` 이 아예 안 불리게 한다
 *     (`EditorView.someProp`, `node_modules/prosemirror-view/dist/index.js` ~L5671 —
 *     `state.plugins` 배열을 순서대로 훑다 첫 truthy 리턴에서 멈춘다). 플러그인 배열 순서는
 *     TipTap 의 `sortExtensions`(`node_modules/@tiptap/core/dist/index.js` ~L1886, priority
 *     내림차순 정렬)가 정하므로 이 확장에 아주 높은 `priority`를 주면 된다 — `priority`는
 *     TipTap 의 공식 문서화된 설정 필드다(`@tiptap/core/dist/index.d.ts` 의
 *     `ExtensionConfig.priority` 독스트링: "The higher, the earlier it will be called"). 이
 *     레포의 기존 확장 중 가장 높은 값은 `@tiptap/extension-link`/`@tiptap/extension-paragraph`의
 *     1000(`node_modules/@tiptap/*\/dist/index.js` 확인) — 아래 100000 은 그보다 두 자리 위라
 *     여유 있게 가장 먼저 온다. `compositionend` 는 **의도적으로 안 건드린다** — 아래 IME 항목.
 * (c) 에디터 재생성 후에만 반영(부팅 시 값 고정) — 불필요: (b)가 안전하게 라이브로 됐다.
 *
 * ## 왜 이 모양이 안전한가
 *
 * - `handleTextInput(view, from, to, text, deflt)` — ProseMirror 는 커스텀 핸들러에 항상
 *   `deflt`(기본 삽입 트랜잭션을 만드는 클로저)를 같이 넘긴다(두 입력 경로 모두 — 구형 keypress
 *   폴백 `prosemirror-view/dist/index.js` ~L3227, 주 경로인 DOM 변이 관찰 ~L5280). 꺼져 있을 때
 *   `deflt()`를 그대로 dispatch — "handleTextInput 을 아무도 안 가로챈 것"과 바이트 단위 동일한
 *   트랜잭션이라 실행취소 이력에 유령 스텝이 안 남는다(추가 트랜잭션을 만들지 않는다). 켜져 있을
 *   때는 `false`를 반환해 다음 플러그인(진짜 입력 규칙들)이 그대로 이어받는다 — 즉시 정상
 *   복구된다.
 * - Suggestion(`/`, `[[`, `#`) — `@tiptap/suggestion`(`node_modules/@tiptap/suggestion/dist/
 *   index.js`)은 `handleTextInput`을 아예 안 쓴다(`handleKeyDown`+트랜잭션 `apply` 상태 기반으로
 *   문자가 이미 들어간 뒤 매치 여부를 검사). 문자 삽입 자체는 (우리가 대신 dispatch 하든, 켜져
 *   있어 원래 규칙 플러그인이 하든) 항상 정상적으로 일어나므로 이 게이트는 슬래시/위키링크/해시태그
 *   트리거에 전혀 영향을 주지 않는다.
 * - **IME(한글) 조합 — `compositionend` 는 절대로 건드리지 않는다(당초 초안엔 여기도 게이트가
 *   있었으나, 실측 후 제거했다).** `node_modules/prosemirror-view/dist/index.js` 를 끝까지
 *   추적한 결과: 실제 등록되는 DOM 리스너는 `initInput`(~L3118)이 만들고, 이 리스너 본문이
 *   `!runCustomHandler(view, event)`(우리 같은 plugin 의 `handleDOMEvents`) 를 먼저 확인한 뒤에만
 *   `handler(view, event)`(= `editHandlers.compositionend`, ~L3603)를 부른다. 그런데 파일 맨
 *   끝(~L3940) `for (let prop in editHandlers) handlers[prop] = editHandlers[prop]` 로
 *   `editHandlers.compositionend` 가 **바로 그 native 핸들러**임이 확정된다 — 이 핸들러가
 *   `view.input.composing = false` 를 셋하고 `scheduleComposeEnd` 로 실제 조합 텍스트를 DOM에서
 *   읽어 문서에 커밋하는 `endComposition` 을 예약한다(~L3603-3616). 즉 우리 plugin 이
 *   `handleDOMEvents.compositionend` 에서 `true`를 반환해 `someProp` 을 단락시키면 —
 *   ProseMirror 자신의 조합 종료 처리 자체가 통째로 안 불려서 **조합 중이던 한글 텍스트가 아예
 *   문서에 커밋되지 않는다**(끄면 한글 입력이 먹통이 되는 회귀). 이건 "input rule 을 막는다"가
 *   아니라 "조합 완료 자체를 막는다"라 목표와 정반대다 — 그래서 이 확장은 `handleDOMEvents`를
 *   아예 등록하지 않는다. 남는 대가: `# `/`**bold**` 같은 트리거는 거의 항상 ASCII 키를 그대로
 *   때리는(조합을 안 타는) `handleTextInput` 경로로 오므로 위 게이트로 이미 다 잡히고, 극히 드문
 *   "조합으로 트리거 문자를 한꺼번에 커밋하는" 케이스(일부 모바일 예측 키보드)만 이 스위치가
 *   꺼져 있어도 규칙이 그대로 발동할 수 있다 — 실측으로 확인한 트레이드오프이자 의도적 한계.
 * - Enter 는 아예 건드리지 않는다 — `prosemirror-inputrules`의 `inputRulesPlugin`은
 *   `handleKeyDown`으로 Enter 트리거 규칙(정규식이 `\n$`로 끝나는 것)도 지원하지만, 이 레포에
 *   실제 등록된 규칙 중에는 하나도 없다(`inputRules.test.ts`가 증명하는 전부 공백/문자/백틱
 *   트리거). list 이어쓰기 등 Enter 로 동작하는 "스마트" 동작은 키맵(`addKeyboardShortcuts`)
 *   구현이라 애초에 input rule 이 아니고 범위 밖 — `handleKeyDown`을 안 건드리는 것 자체가 그
 *   경계를 지킨다(잘못 가로채면 리스트 Enter 이어쓰기를 깰 수 있어 일부러 손대지 않았다).
 *
 * ## 어느 에디터 인스턴스가 이 확장을 쓰는가
 *
 * `EditorPanel.tsx`(데스크톱 본문)와 `mobile/MobileNote.tsx`(모바일 본문) — 둘 다 사용자가 노트
 * 본문을 직접 타이핑하는 자리라 이 킬 스위치를 따른다. **안 쓰는 곳**: `preview/SectionPreview.tsx`/
 * `preview/MarkdownBody.tsx`(둘 다 `editable:false` 읽기 전용 — 타이핑 자체가 없으니 게이트도
 * 무의미), `ai/composer/AskAiComposer.tsx`(전용 프롬프트 입력 — StarterKit 서식 대부분을 이미
 * 꺼둔 채 구성돼 있어 애초에 적용될 입력 규칙이 없다), 펫 챗 입력(`plugins/pet/ChatComposer.tsx`)은
 * TipTap 이 아니라 순수 `<textarea>` 라 이 메커니즘과 무관.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { useSettingsStore } from "../../stores/settings";

export const MdAutoformatGate = Extension.create({
  name: "briseMdAutoformatGate",
  // 기본 100(다른 모든 extension)보다 훨씬 높게 — sortExtensions 가 내림차순 정렬하므로 이
  // 확장의 플러그인이 (키맵 포함) 다른 모든 extension 의 addInputRules 파생 플러그인보다 앞선다.
  priority: 100000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text, deflt) {
            if (useSettingsStore.getState().editorMdAutoformat) return false;
            // 이 플러그인은 priority 100000 이라 **다른 모든** handleTextInput 보다 먼저 돈다 — 여기서
            // true 를 돌려주면 입력 규칙만이 아니라 뒤에 선 가드까지 건너뛴다. 이 레포엔 그런 가드가
            // 하나 있다: TableCellSelectionGuard 는 여러 셀을 선택한 채 타이핑하면 입력을 막는다
            // (다중 셀 선택은 비파괴여야 한다). 그 상황에선 물러나 원래 체인에 맡긴다 — CellSelection
            // 에서는 어차피 글자가 안 들어가니 입력 규칙이 발동할 일도 없다(2026-09-20 검토 중 발견:
            // 자동 서식을 끄면 그 가드가 무력화돼 선택한 셀들이 덮어써졌다).
            // **새 handleTextInput 가드를 추가하는 사람에게**: 이 게이트가 그것도 삼킨다. 여기 같은
            // 예외를 하나 더 적거나, 그 가드의 조건을 이 함수가 먼저 확인하게 하라.
            if (view.state.selection instanceof CellSelection) return false;
            view.dispatch(deflt ? deflt() : view.state.tr.insertText(text, from, to));
            return true;
          },
          // handleDOMEvents.compositionend 는 일부러 등록하지 않는다 — 위 헤더 주석의 IME 항목
          // 참고(등록하면 ProseMirror 자신의 조합 종료 처리를 막아 한글 입력이 먹통이 된다).
        },
      }),
    ];
  },
});
