import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { countDocText, type CountResult } from "./wordCount";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";

// 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWordCount 프리퍼런스가 켜졌을 때 EditorPanel.tsx
// 이 `{editorWordCount && <WordCountBar editor={editor} />}` 형태로만 마운트한다 — 꺼지면 그대로
// 언마운트되어 아래 update/selectionUpdate 리스너도 함께 사라진다("꺼지면 아무 것도 돌지 않는다"는
// 요구를 별도 내부 on/off 분기 없이 마운트 자체로 만족). 삭제하려면: 이 파일 + wordCount.ts +
// EditorPanel.tsx 의 이 한 줄 + i18n 키 4개(editor.json)만 지우면 된다.

const DEBOUNCE_MS = 250;

interface Counts {
  full: CountResult;
  selection: CountResult | null;
}

/** doc.textBetween(..., "\n", "\n") — "\n"을 블록 구분자로 써서 문단 사이가 붙지 않게 한다
 *  (wordCount.ts 헤더 주석 참고). 선택 영역이 비어있으면(캐럿만 있으면) selection 은 null. */
function readCounts(editor: Editor, locale: string): Counts {
  const doc = editor.state.doc;
  const fullText = doc.textBetween(0, doc.content.size, "\n", "\n");
  const full = countDocText(fullText, locale);
  const { from, to } = editor.state.selection;
  if (from === to) return { full, selection: null };
  const selectionText = doc.textBetween(from, to, "\n", "\n");
  return { full, selection: countDocText(selectionText, locale) };
}

/** 본문(또는 선택) 글자·단어 수 — 에디터 컬럼 맨 아래(`.section-statusbar` 바로 아래, 별도 행).
 *  큰 문서에서 매 트랜잭션 동기 재계산을 피하려고 update/selectionUpdate 를 250ms 디바운스로만
 *  구독한다(마운트 직후 한 번은 즉시 계산 — 섹션을 이미 연 상태에서 켰을 때 빈 칸으로 안 보이게). */
export function WordCountBar({ editor }: { editor: Editor }) {
  const uiLang = useSettingsStore((s) => s.uiLang) || "en";
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    if (editor.isDestroyed) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const recompute = () => {
      if (editor.isDestroyed) return; // await 없는 동기 콜백이지만, destroy 와 이벤트 발화가
      // 겹치는 언마운트 경합을 그냥 무시하지 않고 명시적으로 막는다(CLAUDE.md 함정 2).
      setCounts(readCounts(editor, uiLang));
    };
    const scheduleRecompute = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recompute, DEBOUNCE_MS);
    };

    recompute();
    editor.on("update", scheduleRecompute);
    editor.on("selectionUpdate", scheduleRecompute);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", scheduleRecompute);
      editor.off("selectionUpdate", scheduleRecompute);
    };
  }, [editor, uiLang]);

  if (!counts) return null;

  const label = counts.selection
    ? t("editor.word_count_selection", {
        chars: counts.selection.chars.toLocaleString(uiLang),
        words: counts.selection.words.toLocaleString(uiLang),
      })
    : t("editor.word_count_normal", {
        chars: counts.full.chars.toLocaleString(uiLang),
        words: counts.full.words.toLocaleString(uiLang),
      });

  // 상태줄(.section-statusbar) **안**의 한 칸으로 그린다 — 글꼴·색·간격은 상태줄이 자기 span 들에
  // 주는 것을 그대로 받는다(따로 행을 만들지 않는다: 같은 정보가 두 줄에 걸쳐 보이지 않게).
  return (
    <span data-testid="editor-word-count" aria-live="off" style={{ fontVariantNumeric: "tabular-nums" }}>
      {label}
    </span>
  );
}
