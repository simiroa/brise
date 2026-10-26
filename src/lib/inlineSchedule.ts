/**
 * Inline checklist tasks parsing and calendar synchronization.
 *
 * Extracts checklist items containing dates (e.g. "- [ ] 2026-08-30 Task",
 * "- [ ] @2026-08-30 Task", "- [ ] Task [due:2026-08-30]") from note markdown bodies
 * to integrate with calendar day views.
 */

export interface InlineTaskItem {
  id: string;
  noteId: string;
  noteTitle: string;
  sectionId?: string;
  lineIndex: number;
  text: string;
  rawText: string;
  completed: boolean;
  date: string; // ISO format: YYYY-MM-DD
}

// Regex patterns for date markers in task text
const DUE_BRACKET_REGEX = /[\[\(](?:due|마감):\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})[\]\)]/i;
const DUE_COLON_REGEX = /\b(?:due|마감):\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\b/i;
const AT_DATE_REGEX = /@\(?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\)?/;
const EMOJI_DATE_REGEX = /(?:📅|🗓️)\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/;
const PLAIN_DATE_REGEX = /(?:^|[\s,;])(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:[\s,;]|$)/;

export const GFM_CHECKBOX_REGEX = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+\[([ xX])\][ \t]*(.*)$/;

/**
 * Normalizes a date string with -, /, or . separators into ISO YYYY-MM-DD format.
 */
export function normalizeIsoDate(dateStr: string): string | null {
  const parts = dateStr.trim().split(/[-/.]/);
  if (parts.length !== 3) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Extracts a date from task text if present, and returns the cleaned text without date markers.
 */
export function extractDateFromTaskText(text: string): { date: string | null; cleanText: string } {
  let date: string | null = null;
  let cleanText = text;

  // 1. [due: 2026-08-30] or (due: 2026-08-30)
  const dueBracketMatch = cleanText.match(DUE_BRACKET_REGEX);
  if (dueBracketMatch) {
    const norm = normalizeIsoDate(dueBracketMatch[1]);
    if (norm) {
      date = norm;
      cleanText = cleanText.replace(dueBracketMatch[0], "").trim();
    }
  }

  // 2. due: 2026-08-30
  if (!date) {
    const dueColonMatch = cleanText.match(DUE_COLON_REGEX);
    if (dueColonMatch) {
      const norm = normalizeIsoDate(dueColonMatch[1]);
      if (norm) {
        date = norm;
        cleanText = cleanText.replace(dueColonMatch[0], "").trim();
      }
    }
  }

  // 3. @2026-08-30 or @(2026-08-30)
  if (!date) {
    const atMatch = cleanText.match(AT_DATE_REGEX);
    if (atMatch) {
      const norm = normalizeIsoDate(atMatch[1]);
      if (norm) {
        date = norm;
        cleanText = cleanText.replace(atMatch[0], "").trim();
      }
    }
  }

  // 4. 📅 2026-08-30 or 🗓️ 2026-08-30
  if (!date) {
    const emojiMatch = cleanText.match(EMOJI_DATE_REGEX);
    if (emojiMatch) {
      const norm = normalizeIsoDate(emojiMatch[1]);
      if (norm) {
        date = norm;
        cleanText = cleanText.replace(emojiMatch[0], "").trim();
      }
    }
  }

  // 5. Plain date: 2026-08-30
  if (!date) {
    const plainMatch = cleanText.match(PLAIN_DATE_REGEX);
    if (plainMatch) {
      const norm = normalizeIsoDate(plainMatch[1]);
      if (norm) {
        date = norm;
        cleanText = cleanText.replace(plainMatch[1], "").trim();
      }
    }
  }

  // If text became empty because the task was solely a date, keep the original text
  if (!cleanText) {
    cleanText = text.trim();
  } else {
    // Strip leftover leading or trailing dashes, colons, or whitespace
    cleanText = cleanText.replace(/^[-:,\s]+|[-:,\s]+$/g, "").trim();
  }

  return { date, cleanText };
}

/**
 * Strips HTML tags and collapses whitespace.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .split(/\s+/)
    .join(" ")
    .trim();
}

/**
 * `<table …>…</table>` HTML 조각(병합·셀 배경·셀 안 여러 블록이 있는 표 — tableColwidth.ts)을 **같은 길이의
 * 공백**으로 가린다(줄바꿈은 그대로). 표 셀 안 체크리스트는 최상위 체크리스트가 아니다 — 가리지 않으면 셀 안
 * `<li data-checked=… data-type="taskItem">` 한 개 때문에 아래 스캐너가 "HTML 전용 모드"로 넘어가 같은 섹션의
 * 정상 GFM 할 일(`- [ ] …`)까지 통째로 못 찾았다(일정·달력·보드에서 조용히 사라진다). 길이가 같으므로 가린
 * 문자열에서 찾은 위치를 원본에 그대로 쓸 수 있다(토글).
 *
 * 규칙은 Rust 쪽과 한 벌이다(repo/checklist.rs::mask_html_tables): `<table`·`</table` 바로 뒤가 공백·`/`·`>` 일 때만
 * 태그로 보고, 깊이를 세어 **바깥 표가 닫힐 때만** 가린다(안 닫힌 표는 그대로 둔다).
 */
export function maskHtmlTables(content: string): string {
  if (!/<table/i.test(content)) return content;
  const tagRe = /<(\/?)table(?=[ \t\r\n\f/>])/gi;
  let out = "";
  let last = 0;
  let depth = 0;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content)) !== null) {
    if (m[1] === "") {
      if (depth === 0) start = m.index;
      depth++;
      continue;
    }
    if (depth === 0) continue; // 짝 없는 닫는 태그
    depth--;
    if (depth > 0) continue;
    const gt = content.indexOf(">", m.index);
    if (gt < 0) break;
    out += content.slice(last, start) + content.slice(start, gt + 1).replace(/[^\r\n]/g, " ");
    last = gt + 1;
    tagRe.lastIndex = last;
  }
  return out + content.slice(last);
}

const hasTaskItemMarkup = (content: string) =>
  content.includes('data-type="taskItem"') || content.includes("data-type='taskItem'");

/**
 * Parses checklist tasks containing dates from markdown or HTML content.
 */
export function parseInlineTasksFromMarkdown(
  content: string,
  noteId: string,
  noteTitle: string,
  sectionId: string = "default",
): InlineTaskItem[] {
  if (!content || !content.trim()) return [];

  const items: InlineTaskItem[] = [];
  // 표 조각 안 항목은 보지 않는다 — maskHtmlTables 설명.
  const masked = maskHtmlTables(content);

  // Tiptap TaskItem HTML format check
  if (hasTaskItemMarkup(masked)) {
    const liRegex = /<li[^>]*data-type=["']taskItem["'][^>]*data-checked=["'](true|false)["'][^>]*>([\s\S]*?)<\/li>/gi;
    let match: RegExpExecArray | null;
    let ordinal = 0;

    while ((match = liRegex.exec(masked)) !== null) {
      const completed = match[1].toLowerCase() === "true";
      const innerHtml = match[2];
      const pMatch = innerHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const rawText = stripHtmlTags(pMatch ? pMatch[1] : innerHtml);

      const { date, cleanText } = extractDateFromTaskText(rawText);
      if (date) {
        items.push({
          id: `${noteId}:${sectionId}:${ordinal}`,
          noteId,
          noteTitle,
          sectionId,
          lineIndex: ordinal,
          text: cleanText,
          rawText,
          completed,
          date,
        });
      }
      ordinal++;
    }

    return items;
  }

  // GFM Markdown checklist format
  const lines = masked.split(/\r?\n/);
  let ordinal = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(GFM_CHECKBOX_REGEX);
    if (match) {
      const mark = match[1];
      const completed = mark.toLowerCase() === "x";
      const rawText = match[2].trim();

      const { date, cleanText } = extractDateFromTaskText(rawText);
      if (date) {
        items.push({
          id: `${noteId}:${sectionId}:${ordinal}`,
          noteId,
          noteTitle,
          sectionId,
          lineIndex: ordinal,
          text: cleanText,
          rawText,
          completed,
          date,
        });
      }
      ordinal++;
    }
  }

  return items;
}

/**
 * Filters a list of inline tasks for a specific date (ISO format YYYY-MM-DD).
 */
export function getTasksForDate(tasks: InlineTaskItem[], dateIso: string): InlineTaskItem[] {
  if (!dateIso) return [];
  const targetDate = normalizeIsoDate(dateIso) ?? dateIso;
  return tasks.filter((t) => t.date === targetDate);
}

/**
 * Parses inline tasks across multiple note sections.
 */
export function parseTasksFromSections(
  sections: Array<{ id: string; body_md: string }>,
  noteId: string,
  noteTitle: string,
): InlineTaskItem[] {
  const result: InlineTaskItem[] = [];
  for (const sec of sections) {
    const tasks = parseInlineTasksFromMarkdown(sec.body_md, noteId, noteTitle, sec.id);
    result.push(...tasks);
  }
  return result;
}

/**
 * Flips the checked state of the n-th checkbox (0-based) in a markdown or HTML content string.
 */
export function toggleInlineTaskInMarkdown(
  content: string,
  lineIndex: number,
  newChecked?: boolean,
): string {
  if (!content) return content;
  // 찾기는 표 조각을 가린 사본에서, 고치기는 원본에서 — 길이가 같아 위치가 그대로 맞는다(maskHtmlTables).
  const masked = maskHtmlTables(content);

  // HTML format
  if (hasTaskItemMarkup(masked)) {
    const liRegex = /(<li[^>]*data-type=["']taskItem["'][^>]*data-checked=["'])(true|false)(["'][^>]*>[\s\S]*?<input[^>]*type=["']checkbox["'])([^>]*>)/gi;
    let ordinal = 0;
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = liRegex.exec(masked)) !== null) {
      if (ordinal++ !== lineIndex) continue;
      // 여는 태그~체크박스 사이에 표가 끼어 가려졌다면 원본과 달라진다 — 그땐 건드리지 않는다(깨진 본문을 만들지 않는다).
      if (content.slice(m.index, m.index + m[0].length) !== m[0]) break;
      const [, prefix, checkedStr, mid, inputRest] = m;
      const currentlyChecked = checkedStr.toLowerCase() === "true";
      const nextChecked = newChecked !== undefined ? newChecked : !currentlyChecked;
      const nextVal = nextChecked ? "true" : "false";

      // Handle checked attribute in input tag
      let cleanInputRest = inputRest.replace(/\s*checked(?:=["'][^"']*["'])?/gi, "");
      if (nextChecked) {
        cleanInputRest = ' checked="checked"' + cleanInputRest;
      }

      out = content.slice(0, m.index) + `${prefix}${nextVal}${mid}${cleanInputRest}`;
      last = m.index + m[0].length;
      break;
    }
    return last > 0 ? out + content.slice(last) : content;
  }

  // GFM format
  const lines = content.split(/\r?\n/);
  const maskedLines = masked.split(/\r?\n/);
  let ordinal = 0;
  const newLines = lines.map((line, i) => {
    const match = maskedLines[i].match(GFM_CHECKBOX_REGEX);
    if (match) {
      if (ordinal === lineIndex) {
        const currentlyChecked = match[1].toLowerCase() === "x";
        const nextChecked = newChecked !== undefined ? newChecked : !currentlyChecked;
        const nextMark = nextChecked ? "x" : " ";
        ordinal++;
        return line.replace(/\[([ xX])\]/, `[${nextMark}]`);
      }
      ordinal++;
    }
    return line;
  });

  return newLines.join("\n");
}