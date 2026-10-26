// 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWordCount 프리퍼런스(stores/settings.ts)의
// 실효 게이트: 본문(또는 선택 영역) 텍스트에서 글자 수·단어 수를 센다. 순수 함수만 — 에디터/DOM
// 의존성이 전혀 없다(문자열을 받아 숫자만 돌려준다), 그래서 mount 없이 단위 테스트가 가능하고,
// 삭제도 이 파일 + WordCountBar.tsx 만 지우면 끝난다.
//
// 호출부(WordCountBar.tsx)는 ProseMirror 문서를
// `doc.textBetween(0, doc.content.size, "\n", "\n")` 형태로 "\n"을 블록 구분자로 써서 문자열화한
// 뒤 이 모듈에 넘긴다 — `doc.textContent`(블록 사이 구분자 없이 그냥 이어붙임)를 쓰면 서로 다른
// 두 블록의 마지막/첫 단어가 붙어버린다(예: "Hello"+"World" → "HelloWorld"). 그 "\n"들은
// 스펙대로("글자 수는 블록 사이 개행을 제외한다") 단어 경계로는 쓰이되 글자 수에는 잡히지 않는다.

export interface CountResult {
  chars: number;
  words: number;
}

// Grapheme/word 세그먼터 — WebView2(Chromium)엔 Intl.Segmenter가 있지만, 이 프로젝트의 TS lib
// 타깃(tsconfig.json: ES2020)은 아직 그 선언을 포함하지 않는다. lib/emoji/emojiExtension.ts가
// 이미 쓰는 것과 같은 로컬 타이핑 + `unknown` 캐스트 패턴을 그대로 따른다(중복 정의지만, 그
// 파일은 grapheme 전용이라 이쪽의 word 세그먼트(isWordLike)까지 공유할 인터페이스가 없다 —
// 새 공유 모듈을 만드는 건 두 번째 사용처가 이미 있는 지금도 이 실험 기능 하나를 위해 남의
// 파일을 건드리는 비용이 더 크다고 판단).
interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
}
const IntlSeg = Intl as unknown as {
  Segmenter?: new (locale?: string, opts?: { granularity: "grapheme" | "word" }) => SegmenterLike;
};

/** 그레이프임 클러스터 단위로 센다(가능하면) — 이모지(ZWJ 시퀀스·국기 등)·한글 조합 등 화면에
 *  "한 글자"로 보이는 단위가 여러 코드포인트로 이뤄진 경우를 하나로 센다. Intl.Segmenter 가 없는
 *  환경(구형 러너 등)에서는 Array.from 의 코드포인트 순회로 폴백(서로게이트 쌍은 하나로 세지만,
 *  결합된 그레이프임 클러스터 — 예: 국기 — 는 여러 개로 샌다, 스펙이 명시한 차이). */
function graphemeCount(text: string): number {
  if (!text) return 0;
  if (IntlSeg.Segmenter) {
    let n = 0;
    for (const _ of new IntlSeg.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n++;
    return n;
  }
  return Array.from(text).length;
}

/** Intl.Segmenter(locale, {granularity:"word"}) 의 isWordLike 세그먼트만 센다 — 한글은 공백
 *  없이도(형태소 사전 기반으로) 단어를 구분하므로 별도 규칙이 필요 없다. 폴백: 공백 분리. */
function wordCount(text: string, locale?: string): number {
  if (!text.trim()) return 0;
  if (IntlSeg.Segmenter) {
    let n = 0;
    for (const seg of new IntlSeg.Segmenter(locale, { granularity: "word" }).segment(text)) {
      if (seg.isWordLike) n++;
    }
    return n;
  }
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** 문서(또는 선택 영역) 텍스트 하나를 받아 {chars, words} 를 돌려준다. `rawText` 는 블록 구분자로
 *  "\n" 을 쓴 형태(위 파일 헤더 주석)여야 한다 — 그 "\n" 들은 단어 경계로는 쓰이지만(공백과 마찬가지로
 *  word-like 가 아니다) 글자 수 계산 전에 제거된다. */
export function countDocText(rawText: string, locale?: string): CountResult {
  const words = wordCount(rawText, locale);
  const charsOnly = rawText.split("\n").join("");
  const chars = graphemeCount(charsOnly);
  return { chars, words };
}
