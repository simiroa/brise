import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import type { Extensions } from "@tiptap/core";
import { BriseImage } from "../components/editor/imageExtension";
import { BriseHeading, BriseParagraph, ParagraphFormatCommands } from "../components/editor/paragraphFormat";
import { FootnoteMark } from "../components/editor/footnoteMark";
import { BriseDateMark } from "../lib/mdSerialize";

/**
 * 폰 에디터의 **스키마(body_md 직렬화에 영향 주는) 확장 목록** — MobileNote.tsx 의 useEditor 와
 * 테스트가 같은 목록을 쓰도록 분리했다(화면을 마운트하지 않고 왕복을 검증하기 위해).
 * 입력 규칙·플레이스홀더 같은 비스키마 확장은 MobileNote.tsx 에 남는다.
 *
 * 데스크톱(EditorPanel.tsx = PREVIEW_EXTENSIONS + 인터랙티브 전용)과의 대조(2026-10-07, W0):
 *
 * | 데스크톱                          | 폰                         | 처리 |
 * |-----------------------------------|----------------------------|------|
 * | StarterKit(codeBlock:false)       | StarterKit(codeBlock 기본) | 같은 노드 이름·같은 ``` 직렬화 — OK |
 * | Markdown/TaskList/TaskItem/Link   | 동일                       | OK |
 * | BriseImage inline:true            | inline:false               | 한 문단 안 이미지 여러 장은 문단이 갈린다(유실 아님) — 한계로 남김 |
 * | FootnoteMark                      | 동일                       | OK |
 * | DateMark                          | **없었음 → BriseDateMark** | 이번에 추가(스키마만, 클릭 동작 없음) |
 * | Table/Row/Header/Cell             | 없음                       | canEditBodyOnMobile 이 읽기 전용으로 막음 |
 * | Highlight                         | 없음                       | 〃 (`<mark>`, `==…==`) |
 * | BriseTextStyle/Color              | 없음                       | 〃 (`span[style]`) |
 * | Details/Summary/Content           | 없음                       | 〃 |
 * | Typography                        | 없음                       | 입력 규칙뿐 — 직렬화 무관 |
 * | EmojiRender/SlashCommand/WikiLink/HashTag/DateNudge | 없음 | Decoration·입력 보조뿐 — 직렬화 무관 |
 */
export function createMobileSchemaExtensions(): Extensions {
  return [
    // link:false — StarterKit 3.x 가 기본으로 Link(openOnClick:true)를 끼워 오는데, 아래에서 명시
    // 등록한 Link 로 대체한다(붙여넣은 URL 이 window.open 으로 열리는 회귀 방지, 815b5c5).
    StarterKit.configure({ link: false, heading: false, paragraph: false }),
    BriseParagraph,
    BriseHeading,
    ParagraphFormatCommands,
    // P0-1: 데스크톱과 같은 마크다운 파서/직렬화기 — 이미지·굵게·목록이 다시 열어도 살아남는다.
    Markdown,
    TaskList,
    TaskItem.configure({ nested: true }),
    // note:// + 외부 링크 — 마크다운 [text](href) 왕복에 필요(P0-2).
    Link.configure({ openOnClick: false, protocols: ["note"] }),
    BriseImage.configure({ inline: false, allowBase64: false }),
    // Wave 4: 데스크톱과 같은 각주 마크 — body_md 섬이 폰에서도 왕복된다.
    FootnoteMark,
    // W0: `<span data-date="id">` 앵커. 스키마 전용 BriseDateMark — 데스크톱 DateMark 의 클릭은
    // 데스크톱 팝오버(openDateEntry)라 폰에서 쓸 수 없다. 없으면 파서가 span 을 버려 저장 때 앵커가 끊긴다.
    BriseDateMark,
  ];
}
