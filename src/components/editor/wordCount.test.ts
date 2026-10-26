import { describe, it, expect, afterEach } from "vitest";
import { countDocText } from "./wordCount";

// 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWordCount 프리퍼런스의 실효 게이트
// (wordCount.ts) 단위 테스트. 값은 Node 22(Intl.Segmenter 전체 ICU 지원)로 직접 확인한 실제
// 세그먼터 출력을 그대로 기대값으로 썼다 — 손으로 예측하기 위험한 한글/이모지 경계를 짐작하지
// 않는다.

describe("countDocText", () => {
  it("빈 문서: 0/0", () => {
    expect(countDocText("")).toEqual({ chars: 0, words: 0 });
  });

  it("한글: 공백으로 나뉜 두 단어", () => {
    // "안녕 세계" — 그레이프임 5개(안,녕,공백,세,계), 단어 2개(안녕/세계).
    expect(countDocText("안녕 세계")).toEqual({ chars: 5, words: 2 });
  });

  it("한글 자모 조합(NFD) — 결합된 음절 하나를 그레이프임 하나로 센다", () => {
    // U+1100(ᄀ) U+1161(ᅡ) U+11A8(ᆨ) → 정규화하면 "각" 한 글자. Array.from 코드포인트 기준이면
    // 3으로 새므로, 그레이프임 세그멘터를 실제로 타는지 이 케이스가 갈라 보여준다.
    const decomposed = "각";
    expect(countDocText(decomposed)).toEqual({ chars: 1, words: 1 });
  });

  it("이모지 — 국기(지역 지시자 쌍)는 코드포인트 2개지만 그레이프임 1개", () => {
    // Array.from("🇰🇷").length === 2 (서로게이트 쌍 두 개) 지만, 사람 눈엔 한 글자 — 이 차이가
    // 왜 Intl.Segmenter 를 우선하는지의 근거(파일 헤더 주석).
    expect(countDocText("🇰🇷")).toEqual({ chars: 1, words: 0 });
  });

  it("결합 이모지(ZWJ 가족 시퀀스)도 그레이프임 1개", () => {
    expect(countDocText("👨‍👩‍👧‍👦")).toEqual({ chars: 1, words: 0 });
  });

  it("혼합(영문+한글+이모지+숫자)", () => {
    expect(countDocText("Hello 안녕 🇰🇷 123")).toEqual({ chars: 14, words: 3 });
  });

  it("여러 문단 — \\n 블록 구분자는 단어 경계로만 쓰이고 글자 수엔 안 잡힌다", () => {
    // doc.textBetween(..., "\n", "\n") 이 넘기는 형태를 흉내 — "\n" 이 없으면 "HelloWorld" 로
    // 붙어버려 단어가 1개로 잘못 세진다(파일 헤더 주석의 버그 시나리오).
    expect(countDocText("Hello\nWorld")).toEqual({ chars: 10, words: 2 });
  });

  it("선택 영역도 같은 함수 — 문서 전체가 아니라 부분 문자열만 넘기면 그만큼만 센다", () => {
    // WordCountBar 는 selection 이 비어있지 않을 때 doc.textBetween(from, to, ...) 로 뽑은
    // 부분 문자열을 같은 countDocText 에 넘긴다 — 별도 API 가 없다는 뜻.
    expect(countDocText("World")).toEqual({ chars: 5, words: 1 });
  });

  it("locale 인자는 Intl.Segmenter 에 그대로 전달된다(단어 경계 판정에 영향)", () => {
    const ko = countDocText("안녕하세요", "ko");
    const en = countDocText("안녕하세요", "en");
    expect(ko.words).toBeGreaterThan(0);
    expect(en.words).toBeGreaterThan(0);
  });

  describe("Intl.Segmenter 없는 환경(폴백)", () => {
    const original = (Intl as unknown as { Segmenter?: unknown }).Segmenter;

    afterEach(() => {
      (Intl as unknown as { Segmenter?: unknown }).Segmenter = original;
    });

    it("코드포인트 순회(chars) + 공백 분리(words) 로 폴백한다", () => {
      delete (Intl as unknown as { Segmenter?: unknown }).Segmenter;
      expect(countDocText("Hello World")).toEqual({ chars: 11, words: 2 });
      expect(countDocText("")).toEqual({ chars: 0, words: 0 });
      // 폴백 경로에서도 "\n" 블록 구분자는 글자 수에서 빠진다.
      expect(countDocText("Hello\nWorld")).toEqual({ chars: 10, words: 2 });
    });
  });
});
