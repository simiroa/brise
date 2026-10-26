/**
 * 가져온 일반 텍스트 → 입력 화면 초안의 body_md.
 *
 * 왜 그냥 이어 붙이지 않나: 초안은 저장되기 전까지 에디터가 "그려 둔 본문"과 스토어의 body_md 가 같아야
 * "손대지 않은 초안"이다. 폰 에디터의 flush(useMobileNoteSave)는 `mdSerializeEditor(editor)` 가 칠할 때의
 * 문자열과 **한 글자라도 다르면** 쓰기를 내고, 초안의 쓰기는 노트를 만든다(updateSectionBody → ensureMaterialized).
 * 날것의 텍스트(`*foo*`, `snake_case`, `5 < 6`)를 칠하면 사용자가 아무것도 안 했는데 뒤로가기·탭 이동의 flush
 * 한 번에 노트가 생겨 "저장은 사용자가 한다"는 규칙이 깨진다. 그래서 에디터가 직렬화하는 모양 그대로를 body_md 로 쓴다.
 *
 * 텍스트는 마크다운이 아니라 **줄마다 한 문단**(빈 줄은 접는다)으로 문서를 직접 만든다 — `*foo*` 가 기울임이
 * 되지 않고 글자 그대로 남고, 직렬화기가 필요한 이스케이프를 알아서 한다. 줄 앞 공백은 버린다(4칸 들여쓰기가
 * 다시 읽힐 때 코드 블록이 되는 것을 막는다). 줄머리의 `#`·`1.`·`-` 는 직렬화기가 이스케이프하지 않아 제목·목록으로
 * 읽힌다(마크다운을 그대로 공유한 경우엔 오히려 자연스럽다) — 한계로 남긴다.
 *
 * URL 은 **명시적 링크 `[url](url)`** 로 쓴다. 에디터는 맨 URL 을 어차피 링크로 읽어(GFM 자동 링크) 첫 flush 에
 * `[url](url)` 로 다시 쓴다 — 단순한 URL 은 처음부터 그 모양이면 고정점이다.
 *
 * 그래도 칠한 문자열과 다시 직렬화한 문자열이 다른 글이 남는다 — 에디터가 **스스로 링크로 읽는 글**이 그렇다: 이메일 주소
 * (`foo@example.com` → `[foo@example.com](mailto:…)`)·`www.` 주소·`ftp://`·`mailto:`, 그리고 `_`·`&` 가 든 URL(유튜브 `&t=`,
 * `?utm_source=` — 직렬화기가 링크 글자의 `_`→`\_`·`&`→`&amp;` 를 이스케이프한다). 이런 글을 날것으로 두면 손대지 않은
 * 초안도 첫 flush 에 노트가 만들어진다. 어떤 글이 자동 링크가 되는지는 마크다운 토크나이저가 정하므로(`foo_bar@x.com` 은
 * `bar@x.com` 만 링크가 된다) 그 규칙을 따라 쓰지 않고 **고정점을 쫓는다**: 칠하고 직렬화한 결과(`re`)가 본문과 다르면,
 * `re` 를 칠해도 보이는 글자와 링크 목적지가 그대로일 때에 한해 `re` 를 본문으로 받아들이고 다시 시도한다(최대
 * {@link MAX_SETTLE_STEPS} 번). 그렇게 얻은 본문은 에디터가 스스로 쓰는 모양 그대로라 flush 가 같은 문자열을 돌려준다.
 * 보이는 글자나 링크가 달라지는 글(예: URL 안의 백틱)은 고정점을 못 찾아 `stable:false` 로 남는다 — 이때만 손대지 않은
 * 초안도 첫 flush 에 노트가 만들어질 수 있다(호출자가 기록한다).
 *
 * Tiptap(≈700KB)을 끌고 오는 모듈이라 호출자는 반드시 동적 import 한다(MobileApp 이 MobileNote 를 지연 로드하는
 * 이유와 같다 — 피드만 보는 부팅에 에디터가 딸려 오지 않게).
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { canEditBodyOnMobile } from "./mobileEditorSupport";
import { MARKDOWN_SET_CONTENT_OPTIONS, mdSerializeEditor } from "../lib/mdSerialize";

export interface CanonicalBody {
  bodyMd: string;
  /**
   * 이 body_md 를 칠한 에디터가 flush 에서 같은 문자열을 되돌려 주는가(= 손대지 않은 초안은 노트를 만들지 않는다).
   * false 면 고정점을 못 찾은 것이라 첫 flush 가 노트를 만들 수 있다 — 호출자가 기록한다(내용 없이 사실만).
   */
  stable: boolean;
  /**
   * 폰 에디터가 이 본문을 편집 가능으로 여는가(canEditBodyOnMobile). false 면 입력 화면이 읽기 전용 안내와 함께 본문을
   * 보여 준다(칠하기·저장은 되지만 고칠 수 없다). 평범한 글·URL 은 true — 마크다운 표(`|a|b|` 줄 두 개)·`==강조==`·
   * `:::details` 같은 글자가 든 공유만 false 다(호출자가 기록한다).
   */
  editable: boolean;
}

/** 줄 단위 문단 목록. 줄 앞뒤 공백과 빈 줄은 버린다. */
export function textToParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const URL_RE = /https?:\/\/[^\s<>"]+/g;
/** 링크 글자·목적지에 그대로 쓸 수 있는 URL — 괄호·대괄호·백슬래시·백틱이 든 것은 마크다운 문법을 깨므로 일반 글자로 둔다. */
const SIMPLE_URL = /^https?:\/\/[^\s()<>[\]\\`]+$/;
const TRAILING = /[.,;:!?'"]+$/;
// 사설 영역 문자 — 직렬화기가 이스케이프하지 않는다(자리표시자가 그대로 살아남는 것을 테스트가 확인한다).
const OPEN = "";
const CLOSE = "";

/** 문장 끝 구두점과 짝 없는 닫는 괄호는 URL 이 아니다("(see https://x.y)." 의 `).`). */
function splitUrl(raw: string): { url: string; tail: string } {
  let url = raw;
  let tail = "";
  for (;;) {
    const m = url.match(TRAILING);
    if (m) {
      tail = m[0] + tail;
      url = url.slice(0, -m[0].length);
      continue;
    }
    if (url.endsWith(")") && url.split("(").length < url.split(")").length) {
      tail = ")" + tail;
      url = url.slice(0, -1);
      continue;
    }
    return { url, tail };
  }
}

/** 줄 안의 단순 URL 을 자리표시자로 바꾼다. 바꾼 URL 은 urls 에 순서대로 쌓인다. */
function maskUrls(line: string, urls: string[]): string {
  return line.replace(URL_RE, (raw) => {
    const { url, tail } = splitUrl(raw);
    if (!SIMPLE_URL.test(url)) return raw;
    urls.push(url);
    return `${OPEN}${urls.length - 1}${CLOSE}${tail}`;
  });
}

/** 최대 몇 번까지 "에디터가 쓴 모양"을 본문으로 받아들이며 고정점을 쫓는가(실측: 이메일·www·`_`·`&` 는 1번이면 닿는다). */
const MAX_SETTLE_STEPS = 3;
/**
 * 이 길이를 넘는 본문은 쫓지 않고 한 번만 칠해 본다(폰 WebView 에서 칠하기는 글자 수에 비례하고 쫓기는 최대 4번 칠한다).
 * ponytail: 이 크기(수십 쪽)의 공유 글에 이메일·www 주소가 섞이면 stable=false 로 남아 첫 flush 가 노트를 만들 수 있다.
 */
const MAX_SETTLE_CHARS = 100_000;

interface Painted {
  /** 에디터가 이 본문을 칠하고 다시 직렬화한 결과 — flush 가 쓰려는 문자열이다. */
  reserialized: string;
  /** 화면에 보이는 글자. */
  text: string;
  /** 링크 목적지(문서 순서). */
  hrefs: string[];
}

/** 입력 화면이 하는 그대로: body_md 를 칠하고(setContent, update 없음) 다시 직렬화한다. */
function paint(bodyMd: string): Painted {
  const ed = new Editor({ extensions: createMobileSchemaExtensions() });
  try {
    ed.commands.setContent(bodyMd, MARKDOWN_SET_CONTENT_OPTIONS);
    const hrefs: string[] = [];
    ed.state.doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === "link") hrefs.push(String(m.attrs.href));
    });
    return { reserialized: mdSerializeEditor(ed), text: ed.getText(), hrefs };
  } finally {
    ed.destroy();
  }
}

/**
 * 본문의 고정점 찾기 — 위 머리말 참조. 받아들이는 조건은 "보이는 글자와 링크 목적지가 같다" 하나뿐이라 에디터의 이스케이프를
 * 따라 쓰지 않고도 안전하다(글자가 달라지면 거기서 멈춘다).
 */
function settle(bodyMd: string): { bodyMd: string; stable: boolean } {
  let cur = bodyMd;
  let p = paint(cur);
  const steps = bodyMd.length > MAX_SETTLE_CHARS ? 0 : MAX_SETTLE_STEPS;
  for (let i = 0; i < steps; i++) {
    if (p.reserialized === cur) return { bodyMd: cur, stable: true };
    const next = paint(p.reserialized);
    if (next.text !== p.text || next.hrefs.length !== p.hrefs.length || next.hrefs.some((h, k) => h !== p.hrefs[k])) break;
    cur = p.reserialized;
    p = next;
  }
  return { bodyMd: cur, stable: p.reserialized === cur };
}

export function canonicalImportBody(text: string): CanonicalBody {
  const paragraphs = textToParagraphs(text);
  if (!paragraphs.length) return { bodyMd: "", stable: true, editable: true };
  const urls: string[] = [];
  const doc: JSONContent = {
    type: "doc",
    content: paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: maskUrls(p, urls) }] })),
  };
  const ed = new Editor({ extensions: createMobileSchemaExtensions(), content: doc });
  let bodyMd: string;
  try {
    bodyMd = mdSerializeEditor(ed);
  } finally {
    ed.destroy();
  }
  const slot = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
  bodyMd = bodyMd.replace(slot, (_m, i: string) => {
    const u = urls[Number(i)];
    return `[${u}](${u})`;
  });
  const settled = settle(bodyMd);
  return { bodyMd: settled.bodyMd, stable: settled.stable, editable: canEditBodyOnMobile(settled.bodyMd) };
}
